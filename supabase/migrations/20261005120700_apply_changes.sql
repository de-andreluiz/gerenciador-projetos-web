-- =====================================================================
-- 008 · apply_changes — gravação atômica do Unit of Work do app
-- Um "salvar" do app pode tocar vários agregados (ex.: excluir estágio limpa checklists e documentos).
-- Esta RPC aplica o lote inteiro numa transação: ou tudo, ou nada.
-- SECURITY INVOKER: cada comando roda com o papel de quem chama → RLS, grants e triggers de proteção valem normalmente.
-- Concorrência otimista: update/delete de tabela versionada exige `expected_revision`; divergência → SQLSTATE GP409 (STALE_DATA).
-- Só tabelas e colunas da lista abaixo; nomes vêm da lista (nunca do cliente) e passam por format(%I).
-- =====================================================================

create or replace function public.apply_changes(p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_specs constant jsonb := '{
    "projects":           {"key": ["id"], "rev": true,  "cols": ["id", "owner_id", "created_by", "cycle_id", "project_type_id", "origin_system_id", "step_id", "doc", "enc"]},
    "project_checklists": {"key": ["project_id", "step_id"], "rev": true, "cols": ["project_id", "step_id", "doc", "enc"]},
    "project_contacts":   {"key": ["id"], "rev": true,  "cols": ["id", "project_id", "kind", "position", "enc"]},
    "email_templates":    {"key": ["id"], "rev": true,  "cols": ["id", "scope", "project_id", "position", "version", "doc", "enc"]},
    "email_generations":  {"key": ["id"], "rev": true,  "cols": ["id", "project_id", "template_id", "created_at", "doc", "enc"]},
    "stages":             {"key": ["id"], "rev": true,  "cols": ["id", "position", "doc"]},
    "cycles":             {"key": ["id"], "rev": true,  "cols": ["id", "position", "version", "doc"]},
    "project_types":      {"key": ["id"], "rev": true,  "cols": ["id", "position", "doc"]},
    "origin_systems":     {"key": ["id"], "rev": true,  "cols": ["id", "position", "doc"]},
    "checklists":         {"key": ["id"], "rev": true,  "cols": ["id", "position", "version", "doc"]},
    "checklist_items":    {"key": ["id"], "rev": true,  "cols": ["id", "checklist_id", "position", "doc"]},
    "documents":          {"key": ["id"], "rev": true,  "cols": ["id", "position", "doc"]},
    "email_images":       {"key": ["id"], "rev": true,  "cols": ["id", "storage_path", "doc"]},
    "scripts":            {"key": ["id"], "rev": true,  "cols": ["id", "doc", "content", "current_version"]},
    "script_versions":    {"key": ["script_id", "version"], "rev": false, "cols": ["script_id", "version", "content"]},
    "people":             {"key": ["id"], "rev": true,  "cols": ["id", "position", "profile_id", "active", "enc"]},
    "connections":        {"key": ["id"], "rev": true,  "cols": ["id", "env", "auth_kind", "doc", "enc"]},
    "app_settings":       {"key": ["key"], "rev": true, "cols": ["key", "value"]}
  }';
  c         jsonb;
  v_i       integer := 0;
  v_table   text;
  v_op      text;
  v_spec    jsonb;
  v_keys    text[];
  v_cols    text[];
  v_key     jsonb;
  v_vals    jsonb;
  v_use     text[];
  v_exp     integer;
  v_rev     integer;
  v_n       integer;
  v_sql     text;
  v_match   text;
  v_out     jsonb := '[]'::jsonb;
begin
  if not gp.is_active() then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 1000 then
    raise exception 'Lote inválido (lista de até 1000 alterações).' using errcode = '22023';
  end if;

  for c in select value from jsonb_array_elements(p_changes) loop
    v_i := v_i + 1;
    v_table := c ->> 'table';
    v_op := c ->> 'op';
    v_spec := v_specs -> v_table;
    if v_spec is null then
      raise exception 'Alteração %: tabela não permitida.', v_i using errcode = '22023';
    end if;
    if v_op not in ('insert', 'insert_if_absent', 'update', 'delete') then
      raise exception 'Alteração %: operação inválida.', v_i using errcode = '22023';
    end if;
    v_keys := array(select jsonb_array_elements_text(v_spec -> 'key'));
    v_cols := array(select jsonb_array_elements_text(v_spec -> 'cols'));
    v_key := coalesce(c -> 'key', '{}'::jsonb);
    v_vals := coalesce(c -> 'values', '{}'::jsonb);
    if jsonb_typeof(v_key) <> 'object' or jsonb_typeof(v_vals) <> 'object' then
      raise exception 'Alteração %: key/values devem ser objetos.', v_i using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_keys) k where v_key -> k is null or jsonb_typeof(v_key -> k) = 'null') then
      raise exception 'Alteração %: chave incompleta.', v_i using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_object_keys(v_vals) k where not (k = any (v_cols))) then
      raise exception 'Alteração %: coluna não permitida em %.', v_i, v_table using errcode = '22023';
    end if;
    v_exp := (c ->> 'expected_revision')::integer;
    v_match := (select string_agg(format('t.%I = k.%I', k, k), ' and ') from unnest(v_keys) k);

    if v_op in ('insert', 'insert_if_absent') then
      v_vals := v_vals || v_key;
      v_use := array(select k from jsonb_object_keys(v_vals) k);
      -- Sem RETURNING: ele exigiria que a linha nova já passasse na política de SELECT (ex.: o vínculo do dono do projeto
      -- só é criado pelo trigger AFTER). Linha nova sempre nasce com revision = 1.
      v_sql := format('insert into public.%I as t (%s) select %s from jsonb_populate_record(null::public.%I, $1) r %s',
                      v_table,
                      (select string_agg(format('%I', k), ', ') from unnest(v_use) k),
                      (select string_agg(format('r.%I', k), ', ') from unnest(v_use) k),
                      v_table,
                      case when v_op = 'insert_if_absent' then 'on conflict do nothing' else '' end);
      execute v_sql using v_vals;
      get diagnostics v_n = row_count;
      v_out := v_out || jsonb_build_object('i', v_i, 'table', v_table, 'key', v_key,
                                           'status', case when v_n = 0 then 'exists' else 'inserted' end,
                                           'revision', case when v_n = 0 or not (v_spec ->> 'rev')::boolean then null else 1 end);

    elsif v_op = 'update' then
      if (v_spec ->> 'rev')::boolean and v_exp is null then
        raise exception 'Alteração %: expected_revision é obrigatório em %.', v_i, v_table using errcode = '22023';
      end if;
      v_use := array(select k from jsonb_object_keys(v_vals) k where not (k = any (v_keys)));
      if cardinality(v_use) = 0 then
        raise exception 'Alteração %: nada para atualizar.', v_i using errcode = '22023';
      end if;
      v_sql := format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r, jsonb_populate_record(null::public.%I, $2) k where %s %s returning %s',
                      v_table,
                      (select string_agg(format('%I = r.%I', k, k), ', ') from unnest(v_use) k),
                      v_table, v_table, v_match,
                      case when (v_spec ->> 'rev')::boolean then 'and t.revision = $3' else '' end,
                      case when (v_spec ->> 'rev')::boolean then 't.revision' else '1' end);
      execute v_sql into v_rev using v_vals, v_key, v_exp;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'STALE_DATA' using errcode = 'GP409',
          detail = jsonb_build_object('i', v_i, 'table', v_table, 'key', v_key)::text,
          hint = 'O registro foi alterado por outra pessoa, não existe ou não está acessível. Recarregue.';
      end if;
      v_out := v_out || jsonb_build_object('i', v_i, 'table', v_table, 'key', v_key, 'status', 'updated', 'revision', v_rev);

    else -- delete
      v_sql := format('delete from public.%I t using jsonb_populate_record(null::public.%I, $1) k where %s %s',
                      v_table, v_table, v_match,
                      case when (v_spec ->> 'rev')::boolean and v_exp is not null then 'and t.revision = $2' else '' end);
      execute v_sql using v_key, v_exp;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'STALE_DATA' using errcode = 'GP409',
          detail = jsonb_build_object('i', v_i, 'table', v_table, 'key', v_key)::text,
          hint = 'O registro foi alterado/removido por outra pessoa ou não está acessível. Recarregue.';
      end if;
      v_out := v_out || jsonb_build_object('i', v_i, 'table', v_table, 'key', v_key, 'status', 'deleted');
    end if;
  end loop;
  return v_out;
end
$$;

revoke execute on function public.apply_changes(jsonb) from public, anon;
grant execute on function public.apply_changes(jsonb) to authenticated;
