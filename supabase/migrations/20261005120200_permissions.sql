-- =====================================================================
-- 003 · Permissões granulares (RBAC + concessões individuais)
-- role (MASTER/ADMIN/USER) dá o padrão; user_permissions concede extras.
-- MASTER tem todas as permissões implicitamente.
-- Os códigos espelham src/auth/permissions.js (fonte única no app).
-- =====================================================================

create table public.permissions (
  code               text primary key check (code ~ '^[a-z]+(\.[a-z_]+)+$'),
  description        text not null,
  master_only_grant  boolean not null default false  -- só o MASTER concede (evita ADMIN criar outro “quase admin”)
);

insert into public.permissions (code, description, master_only_grant) values
  ('projects.view_all',        'Ver todos os projetos',                                         false),
  ('projects.edit_all',        'Editar todos os projetos',                                      false),
  ('projects.create',          'Criar projetos',                                                false),
  ('config.cycles.manage',     'Administrar ciclos e estágios',                                 false),
  ('config.checklists.manage', 'Administrar checklists (modelos)',                              false),
  ('config.catalogs.manage',   'Administrar tipos de projeto, sistemas de origem e parâmetros', false),
  ('config.comms.manage',      'Administrar modelos de comunicação',                            false),
  ('config.documents.manage',  'Administrar documentos e modelos',                              false),
  ('config.scripts.manage',    'Administrar scripts SQL',                                       false),
  ('config.people.manage',     'Administrar pessoas (coordenadores/analistas)',                 false),
  ('connections.manage',       'Administrar conexões de banco (metadados)',                     false),
  ('users.manage',             'Administrar usuários e permissões',                             true),
  ('audit.view',               'Ver a auditoria compartilhada',                                 false),
  ('releases.publish',         'Publicar versões do aplicativo',                                true)
on conflict (code) do update set description = excluded.description, master_only_grant = excluded.master_only_grant;

create table public.role_permissions (
  role  public.app_role not null,
  code  text not null references public.permissions (code) on delete cascade,
  primary key (role, code)
);

-- Padrões. USER começa sem permissão nenhuma: o MASTER/ADMIN concede no provisionamento (ex.: projects.create).
insert into public.role_permissions (role, code) values
  ('ADMIN', 'users.manage'),
  ('ADMIN', 'audit.view'),
  ('ADMIN', 'projects.create'),
  ('ADMIN', 'projects.view_all')
on conflict do nothing;

create table public.user_permissions (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  code        text not null references public.permissions (code) on delete cascade,
  granted_by  uuid references public.profiles (id),
  granted_at  timestamptz not null default now(),
  primary key (user_id, code)
);

-- Permissão efetiva de quem chama. Falha fechada: usuário inexistente/inativo → false.
create or replace function gp.has_perm(p_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
       and (p.role = 'MASTER'
            or exists (select 1 from public.role_permissions rp where rp.role = p.role and rp.code = p_code)
            or exists (select 1 from public.user_permissions up where up.user_id = p.id and up.code = p_code))
  )
$$;

-- Permissões efetivas de um usuário (para a tela de administração e para o próprio usuário).
create or replace function gp.effective_permissions(p_user uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct c order by c), '{}')
    from (
      select pm.code as c from public.permissions pm
        join public.profiles p on p.id = p_user and p.role = 'MASTER'
      union all
      select rp.code from public.role_permissions rp join public.profiles p on p.id = p_user and rp.role = p.role
      union all
      select up.code from public.user_permissions up where up.user_id = p_user
    ) x
$$;
