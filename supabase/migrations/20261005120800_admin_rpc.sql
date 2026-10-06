-- =====================================================================
-- 009 · Administração: provisionamento, papéis, permissões, acesso a projetos, MASTER
-- Todas SECURITY DEFINER (precisam escrever em tabelas fechadas para o cliente) e por isso
-- cada uma confere a autorização NO INÍCIO e falha fechada. Toda ação grava audit_events.
-- Hierarquia: MASTER > ADMIN > USER. Ninguém administra alguém do mesmo nível ou acima.
-- =====================================================================

create or replace function gp.rank(r public.app_role) returns integer
language sql immutable set search_path = '' as $$
  select case r when 'MASTER' then 3 when 'ADMIN' then 2 else 1 end
$$;

-- Autenticação recente (senha digitada há pouco): exigida para ações críticas sobre o papel MASTER/ADMIN.
-- Usa o `amr` do JWT do Supabase (momento real do login; não muda com refresh do token).
create or replace function gp.recent_auth(p_seconds integer default 600) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((
    select max((a ->> 'timestamp')::bigint) from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
  ) >= extract(epoch from now())::bigint - p_seconds, false)
$$;

create or replace function gp.require(p_ok boolean, p_msg text default 'Sem permissão.') returns void
language plpgsql set search_path = '' as $$
begin
  if p_ok is not true then
    raise exception '%', p_msg using errcode = '42501';
  end if;
end
$$;

-- Quem chama pode administrar o alvo? (ativo, users.manage, nível acima, não é ele mesmo)
create or replace function gp.can_admin_user(p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select gp.has_perm('users.manage')
     and p_target <> auth.uid()
     and exists (select 1 from public.profiles t where t.id = p_target and gp.rank(t.role) < gp.rank(gp.my_role()))
$$;

-- ---------- bootstrap do primeiro MASTER (SQL Editor apenas; não exposto pela API) ----------
create or replace function gp.bootstrap_master(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles where role = 'MASTER') then
    raise exception 'Já existe um MASTER. Use a transferência (public.grant_master) a partir do MASTER atual.';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and status in ('pending', 'active')) then
    raise exception 'Usuário não encontrado ou ainda não aceitou o convite (defina a senha pelo código do convite primeiro).';
  end if;
  perform set_config('gp.allow_master_change', 'on', true);
  update public.profiles
     set role = 'MASTER', status = 'active', activated_at = now(), status_changed_at = now()
   where id = p_user;
  perform set_config('gp.allow_master_change', 'off', true);
  perform gp.audit('admin.master_bootstrap', 'profile', p_user::text, null, '{}'::jsonb);
end
$$;
revoke execute on function gp.bootstrap_master(uuid) from public, anon, authenticated, service_role;

-- ---------- leitura ----------
-- Perfil e permissões efetivas de quem chama (também para PENDING/SUSPENDED: a tela mostra o estado).
create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'username', p.username, 'displayName', p.display_name, 'role', p.role, 'status', p.status,
                            'permissions', case when p.status = 'active' then to_jsonb(gp.effective_permissions(p.id)) else '[]'::jsonb end)
    from public.profiles p where p.id = auth.uid()
$$;

-- Diretório mínimo (nomes de colegas para "feito por", membros etc.). Só para usuários ativos.
create or replace function public.user_directory() returns table (id uuid, username text, display_name text, status public.account_status)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform gp.require(gp.is_active());
  return query select p.id, p.username, p.display_name, p.status from public.profiles p where p.status in ('active', 'suspended');
end
$$;

create or replace function public.admin_list_users()
returns table (id uuid, email text, username text, display_name text, role public.app_role, status public.account_status,
               created_at timestamptz, invited_at timestamptz, last_sign_in_at timestamptz, permissions text[], projects integer, app_version text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform gp.require(gp.has_perm('users.manage'));
  return query
    select p.id, u.email::text, p.username, p.display_name, p.role, p.status, p.created_at, u.invited_at, u.last_sign_in_at,
           gp.effective_permissions(p.id),
           (select count(*)::integer from public.project_members m where m.user_id = p.id),
           (select cv.app_version from public.client_versions cv where cv.user_id = p.id)
      from public.profiles p join auth.users u on u.id = p.id
     order by p.display_name;
end
$$;

-- ---------- provisionamento (PENDING_SETUP → ACTIVE) ----------
create or replace function public.admin_provision_user(p_user uuid, p_username text, p_display_name text,
                                                       p_role public.app_role default 'USER', p_permissions text[] default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_target public.profiles;
  v_code text;
begin
  select * into v_target from public.profiles where id = p_user;
  perform gp.require(v_target.id is not null and gp.can_admin_user(p_user));
  perform gp.require(v_target.status in ('invited', 'pending'), 'Usuário já provisionado; use as ações de papel/permissão/estado.');
  perform gp.require(p_role in ('USER', 'ADMIN'), 'Papel inválido.');
  perform gp.require(p_role = 'USER' or gp.is_master(), 'Só o MASTER cria administradores.');
  foreach v_code in array coalesce(p_permissions, '{}') loop
    perform gp.require(exists (select 1 from public.permissions where code = v_code), 'Permissão inexistente.');
    perform gp.require(gp.is_master() or (gp.has_perm(v_code)
                       and not (select master_only_grant from public.permissions where code = v_code)),
                       'Você não pode conceder essa permissão.');
  end loop;
  update public.profiles
     set username = coalesce(nullif(p_username, ''), username),
         display_name = coalesce(nullif(p_display_name, ''), display_name),
         role = p_role, status = 'active', activated_at = now(), activated_by = auth.uid(),
         status_changed_at = now(), status_changed_by = auth.uid()
   where id = p_user;
  delete from public.user_permissions where user_id = p_user;
  insert into public.user_permissions (user_id, code, granted_by)
  select p_user, x, auth.uid() from unnest(coalesce(p_permissions, '{}')) x on conflict do nothing;
  perform gp.audit('admin.user_activated', 'profile', p_user::text, null, jsonb_build_object('role', p_role));
end
$$;

-- ---------- estado (ACTIVE ↔ SUSPENDED). Suspensão vale na hora: todo RLS confere status a cada consulta. ----------
-- A Edge Function gp-admin chama esta RPC (com o JWT de quem pede) e, se ela passar, aplica o ban no Auth (revoga sessões).
create or replace function public.admin_set_status(p_user uuid, p_status public.account_status) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old public.account_status;
begin
  perform gp.require(gp.can_admin_user(p_user));
  perform gp.require(p_status in ('active', 'suspended'), 'Estado inválido.');
  select status into v_old from public.profiles where id = p_user;
  perform gp.require(v_old in ('active', 'suspended'), 'Usuário ainda não provisionado.');
  update public.profiles set status = p_status, status_changed_at = now(), status_changed_by = auth.uid() where id = p_user;
  perform gp.audit(case when p_status = 'suspended' then 'admin.user_suspended' else 'admin.user_reactivated' end,
                   'profile', p_user::text, null, jsonb_build_object('from', v_old, 'to', p_status));
end
$$;

create or replace function public.admin_set_role(p_user uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old public.app_role;
begin
  perform gp.require(gp.is_master(), 'Só o MASTER altera papéis.');
  perform gp.require(gp.recent_auth(), 'Confirme sua senha (entre novamente) para alterar papéis.');
  perform gp.require(p_role in ('USER', 'ADMIN'), 'Papel inválido (MASTER só por transferência).');
  select role into v_old from public.profiles where id = p_user;
  perform gp.require(v_old is not null and v_old <> 'MASTER' and p_user <> auth.uid(), 'Alvo inválido.');
  update public.profiles set role = p_role where id = p_user;
  perform gp.audit('admin.role_changed', 'profile', p_user::text, null, jsonb_build_object('from', v_old, 'to', p_role));
end
$$;

create or replace function public.admin_set_names(p_user uuid, p_username text, p_display_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.can_admin_user(p_user) or (p_user = auth.uid() and gp.is_master()));
  update public.profiles
     set username = coalesce(nullif(p_username, ''), username), display_name = coalesce(nullif(p_display_name, ''), display_name)
   where id = p_user;
  perform gp.audit('admin.user_renamed', 'profile', p_user::text, null, '{}'::jsonb);
end
$$;

-- ---------- permissões individuais ----------
create or replace function public.admin_grant_permission(p_user uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_master_only boolean;
begin
  perform gp.require(gp.can_admin_user(p_user));
  select master_only_grant into v_master_only from public.permissions where code = p_code;
  perform gp.require(v_master_only is not null, 'Permissão inexistente.');
  perform gp.require(gp.is_master() or (not v_master_only and gp.has_perm(p_code)), 'Você não pode conceder essa permissão.');
  insert into public.user_permissions (user_id, code, granted_by) values (p_user, p_code, auth.uid()) on conflict do nothing;
end
$$;

create or replace function public.admin_revoke_permission(p_user uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.can_admin_user(p_user));
  perform gp.require(gp.is_master() or gp.has_perm(p_code), 'Você não pode revogar essa permissão.');
  delete from public.user_permissions where user_id = p_user and code = p_code;
end
$$;

-- ---------- acesso a projetos ----------
create or replace function public.project_set_access(p_project text, p_user uuid, p_access public.project_access) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.can_manage_project(p_project));
  perform gp.require(exists (select 1 from public.profiles where id = p_user and status in ('invited', 'pending', 'active')), 'Usuário inválido.');
  perform gp.require(not exists (select 1 from public.projects where id = p_project and owner_id = p_user) or p_access = 'manager',
                     'O dono do projeto é sempre gestor.');
  insert into public.project_members (project_id, user_id, access, granted_by)
  values (p_project, p_user, p_access, auth.uid())
  on conflict (project_id, user_id) do update set access = excluded.access, granted_by = excluded.granted_by, granted_at = now();
end
$$;

create or replace function public.project_revoke_access(p_project text, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.can_manage_project(p_project));
  perform gp.require(not exists (select 1 from public.projects where id = p_project and owner_id = p_user),
                     'Não é possível remover o dono do projeto (transfira a propriedade antes).');
  delete from public.project_members where project_id = p_project and user_id = p_user;
end
$$;

create or replace function public.project_transfer_owner(p_project text, p_new_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.is_master() or exists (select 1 from public.projects where id = p_project and owner_id = auth.uid()));
  perform gp.require(exists (select 1 from public.profiles where id = p_new_owner and status = 'active'), 'Novo dono precisa estar ativo.');
  update public.projects set owner_id = p_new_owner where id = p_project;
  insert into public.project_members (project_id, user_id, access, granted_by) values (p_project, p_new_owner, 'manager', auth.uid())
  on conflict (project_id, user_id) do update set access = 'manager';
  perform gp.audit('project.owner_transferred', 'project', p_project, p_project, jsonb_build_object('to', p_new_owner));
end
$$;

-- Arquivar/desarquivar (nunca apagar).
create or replace function public.project_set_archived(p_project text, p_archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.can_manage_project(p_project));
  update public.projects
     set archived_at = case when p_archived then now() end, archived_by = case when p_archived then auth.uid() end
   where id = p_project;
end
$$;

-- ---------- MASTER: conceder / abrir mão (sempre resta pelo menos um MASTER ativo) ----------
create or replace function public.grant_master(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.is_master(), 'Só o MASTER pode conceder o papel MASTER.');
  perform gp.require(gp.recent_auth(), 'Confirme sua senha (entre novamente) para esta ação.');
  perform gp.require(exists (select 1 from public.profiles where id = p_user and status = 'active' and role <> 'MASTER'), 'Alvo inválido.');
  perform set_config('gp.allow_master_change', 'on', true);
  update public.profiles set role = 'MASTER' where id = p_user;
  perform set_config('gp.allow_master_change', 'off', true);
  perform gp.audit('admin.master_granted', 'profile', p_user::text, null, '{}'::jsonb);
end
$$;

create or replace function public.relinquish_master() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform gp.require(gp.is_master(), 'Somente um MASTER pode abrir mão do papel.');
  perform gp.require(gp.recent_auth(), 'Confirme sua senha (entre novamente) para esta ação.');
  perform gp.require(exists (select 1 from public.profiles where role = 'MASTER' and status = 'active' and id <> auth.uid()),
                     'É preciso existir outro MASTER ativo antes de abrir mão do papel.');
  perform set_config('gp.allow_master_change', 'on', true);
  update public.profiles set role = 'ADMIN' where id = auth.uid();
  perform set_config('gp.allow_master_change', 'off', true);
  perform gp.audit('admin.master_relinquished', 'profile', auth.uid()::text, null, '{}'::jsonb);
end
$$;

-- ---------- chaves de dados: quem pode receber/criar a DEK de cada escopo ----------
-- Usada pela Edge Function gp-keys COM O JWT DE QUEM PEDE: a decisão de entregar uma DEK é do banco (mesmas regras do RLS).
--   global          → ler: qualquer usuário ativo (pessoas, destinatários de modelos, conexões) · criar: MASTER
--   project:<id>    → ler: can_read_project · criar: can_edit_project, ou projeto ainda inexistente e projects.create
create or replace function public.key_access(p_scopes text[])
returns table (scope text, can_read boolean, can_create boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform gp.require(gp.is_active());
  perform gp.require(cardinality(coalesce(p_scopes, '{}')) between 1 and 200, 'Informe de 1 a 200 escopos.');
  return query
    select s,
           case when s = 'global' then true
                when s ~ '^project:[A-Za-z0-9_-]{1,64}$' then gp.can_read_project(substr(s, 9))
                else false end,
           case when s = 'global' then gp.is_master()
                when s ~ '^project:[A-Za-z0-9_-]{1,64}$' then
                  gp.can_edit_project(substr(s, 9))
                  or (not exists (select 1 from public.projects x where x.id = substr(s, 9)) and gp.has_perm('projects.create'))
                else false end
      from unnest(p_scopes) s;
end
$$;

-- ---------- grants das RPCs públicas: só usuários autenticados (cada uma confere o resto) ----------
do $$
declare f text;
begin
  foreach f in array array[
    'public.my_profile()', 'public.user_directory()', 'public.admin_list_users()',
    'public.admin_provision_user(uuid, text, text, public.app_role, text[])', 'public.admin_set_status(uuid, public.account_status)',
    'public.admin_set_role(uuid, public.app_role)', 'public.admin_set_names(uuid, text, text)',
    'public.admin_grant_permission(uuid, text)', 'public.admin_revoke_permission(uuid, text)',
    'public.project_set_access(text, uuid, public.project_access)', 'public.project_revoke_access(text, uuid)',
    'public.project_transfer_owner(text, uuid)', 'public.project_set_archived(text, boolean)',
    'public.grant_master(uuid)', 'public.relinquish_master()', 'public.key_access(text[])',
    'public.log_event(text, text, text, text, jsonb, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
-- Helpers só rodam dentro das RPCs (como dono): nenhum grant para clientes. O Postgres dá EXECUTE a PUBLIC em toda função
-- nova, e "alter default privileges in schema" não remove esse padrão global — por isso a revogação explícita.
revoke execute on function gp.rank(public.app_role), gp.recent_auth(integer), gp.require(boolean, text), gp.can_admin_user(uuid)
  from public, anon, authenticated;
