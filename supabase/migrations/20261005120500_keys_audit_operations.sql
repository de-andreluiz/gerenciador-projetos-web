-- =====================================================================
-- 006 · Chaves de dados, auditoria compartilhada e tabelas operacionais
-- =====================================================================

-- ---------- DEKs embrulhadas (envelope encryption) ----------
-- wrapped_key = DEK cifrada pela KEK (AES-256-GCM, AAD = escopo + versão). A KEK existe só no secret da Edge Function gp-keys.
-- NENHUM acesso para clientes (nem leitura): só a Edge Function, com service role, lê/grava aqui.
create table public.data_keys (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null check (scope = 'global' or scope ~ '^project:[A-Za-z0-9_-]{1,64}$'),
  version      integer not null default 1 check (version > 0),
  kek_version  integer not null check (kek_version > 0),
  wrapped_key  text not null,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id),
  retired_at   timestamptz,
  unique (scope, version)
);

-- ---------- auditoria compartilhada (append-only, sem dado pessoal/sensível) ----------
create table public.audit_events (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor        uuid default auth.uid(),            -- null = operação de manutenção (SQL Editor)
  action       text not null check (action ~ '^[a-z0-9_.-]{1,64}$'),
  entity_type  text not null default '' check (length(entity_type) <= 64),
  entity_id    text not null default '' check (length(entity_id) <= 160),
  project_id   text,
  details      jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and length(details::text) <= 4000),
  app_version  text check (app_version is null or app_version ~ '^[0-9A-Za-z.+-]{1,32}$')
);
create index audit_events_at on public.audit_events (at desc);
create index audit_events_project on public.audit_events (project_id, at desc);

-- Linhas da auditoria nunca mudam nem somem (nem pelo dono via app; manutenção só por migration explícita).
create or replace function gp.audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'A auditoria é somente inclusão.' using errcode = '42501';
end
$$;
create trigger gp_audit_append_only before update or delete on public.audit_events
  for each row execute function gp.audit_append_only();

-- Gravação interna (triggers e RPCs).
create or replace function gp.audit(p_action text, p_entity_type text, p_entity_id text, p_project text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (actor, action, entity_type, entity_id, project_id, details)
  values (auth.uid(), p_action, coalesce(p_entity_type, ''), coalesce(p_entity_id, ''), p_project, coalesce(p_details, '{}'::jsonb));
$$;

-- Auditoria automática de alterações de dados: registra QUEM, O QUÊ e QUAIS CAMPOS mudaram — nunca os valores.
-- Mudança em `enc` aparece só como "sensitive": true (o conteúdo cifrado não é copiado para a auditoria).
create or replace function gp.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_id text;
  v_project text;
  v_changed text[];
  v_doc_keys text[];
  v_details jsonb := '{}'::jsonb;
begin
  v_id := coalesce(v_row ->> 'id',
                   concat_ws(':', v_row ->> 'project_id', v_row ->> 'step_id', v_row ->> 'user_id', v_row ->> 'code', v_row ->> 'key'));
  v_project := case when tg_table_name = 'projects' then v_row ->> 'id' else v_row ->> 'project_id' end;
  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into v_changed
      from jsonb_object_keys(v_new) k
     where k not in ('updated_at', 'updated_by', 'revision') and v_new -> k is distinct from v_old -> k;
    if v_changed is null then return null; end if; -- nada relevante mudou
    if v_new ? 'doc' and (v_new -> 'doc') is distinct from (v_old -> 'doc') then
      select array_agg(k order by k) into v_doc_keys
        from (select jsonb_object_keys(v_new -> 'doc') k union select jsonb_object_keys(v_old -> 'doc')) s
       where (v_new -> 'doc' -> k) is distinct from (v_old -> 'doc' -> k);
    end if;
    v_details := jsonb_build_object('fields', to_jsonb(array_remove(array_remove(v_changed, 'doc'), 'enc')));
    if v_doc_keys is not null then v_details := v_details || jsonb_build_object('docKeys', to_jsonb(v_doc_keys)); end if;
    if 'enc' = any (v_changed) then v_details := v_details || jsonb_build_object('sensitive', true); end if;
  end if;
  -- membros e permissões: o nível de acesso/código não é dado pessoal e ajuda a rastrear concessões
  if tg_table_name = 'project_members' then
    v_details := v_details || jsonb_build_object('user', v_row ->> 'user_id', 'access', v_row ->> 'access');
  elsif tg_table_name = 'user_permissions' then
    v_details := v_details || jsonb_build_object('user', v_row ->> 'user_id', 'code', v_row ->> 'code');
  end if;
  insert into public.audit_events (actor, action, entity_type, entity_id, project_id, details)
  values (auth.uid(), tg_table_name || '.' || lower(tg_op), tg_table_name, left(v_id, 160), v_project, v_details);
  return null;
end
$$;

-- Eventos semânticos do app (ex.: email-copiado, avanco-bloqueado). Ator forçado = quem chama; detalhes só escalares, limitados.
create or replace function public.log_event(p_action text, p_entity_type text default '', p_entity_id text default '',
                                            p_project text default null, p_details jsonb default '{}'::jsonb, p_app_version text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not gp.is_active() then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_project is not null and not gp.can_read_project(p_project) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object'
     or exists (select 1 from jsonb_each(p_details) e where jsonb_typeof(e.value) in ('object', 'array')) then
    raise exception 'Detalhes da auditoria: só valores simples.' using errcode = '22023';
  end if;
  insert into public.audit_events (actor, action, entity_type, entity_id, project_id, details, app_version)
  values (auth.uid(), 'app.' || p_action, coalesce(p_entity_type, ''), coalesce(p_entity_id, ''), p_project, p_details, p_app_version);
end
$$;

-- ---------- operação ----------
-- Execuções da migração dos dados locais (idempotência e evidência de validação).
create table public.migration_runs (
  id                  uuid primary key default gen_random_uuid(),
  source_fingerprint  text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),  -- SHA-256 do projects.json de origem
  status              text not null check (status in ('started', 'validated', 'completed', 'failed')),
  counts              jsonb not null default '{}'::jsonb,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  run_by              uuid not null references public.profiles (id) default auth.uid()
);

-- Versões publicadas do aplicativo (pacote assinado no bucket `releases`).
create table public.app_releases (
  version           text primary key check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'),
  channel           text not null default 'stable' check (channel in ('stable', 'beta')),
  published_at      timestamptz not null default now(),
  published_by      uuid references public.profiles (id) default auth.uid(),
  notes             text not null default '' check (length(notes) <= 20000),
  storage_path      text not null,
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  signature         text not null,                     -- Ed25519 sobre o manifesto; chave pública embutida no app
  min_supported     text,
  requires_restart  boolean not null default true,
  withdrawn_at      timestamptz
);

-- Versão do app em uso por usuário (mínimo necessário para o MASTER acompanhar atualizações; sem máquina, IP ou hostname).
create table public.client_versions (
  user_id      uuid primary key references public.profiles (id) on delete cascade default auth.uid(),
  app_version  text not null check (app_version ~ '^[0-9A-Za-z.+-]{1,32}$'),
  reported_at  timestamptz not null default now()
);
