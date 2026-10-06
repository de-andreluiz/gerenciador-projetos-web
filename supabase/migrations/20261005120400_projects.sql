-- =====================================================================
-- 005 · Projetos, participação e dados por projeto
-- Dono (owner_id) + membros (project_members) + visão global por permissão.
-- Campos sensíveis do projeto (nome = cliente, descrição, links, observações, contatos…) só no envelope `enc`.
-- Caminhos de disco NUNCA ficam aqui (vínculo local por usuário/máquina).
-- Nada é apagado: arquivamento lógico (archived_at), coerente com ADR-009.
-- =====================================================================

create table public.projects (
  id                text primary key check (gp.is_entity_id(id)),
  owner_id          uuid not null references public.profiles (id),
  created_by        uuid not null references public.profiles (id) default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles (id),
  revision          integer not null default 1 check (revision > 0),
  archived_at       timestamptz,
  archived_by       uuid references public.profiles (id),
  cycle_id          text,
  project_type_id   text,
  origin_system_id  text,
  step_id           text,
  doc               jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  enc               jsonb check (enc is null or gp.is_envelope(enc)),
  -- defesa contra bug de mapeamento: estes campos só podem existir cifrados
  constraint projects_doc_no_plaintext check (not (doc ?| array[
    'name', 'description', 'contacts', 'notes', 'whatsappGroupUrl', 'rootDriveUrl', 'rootDir', 'corrections', 'environments'])),
  constraint projects_archive_consistent check ((archived_at is null) = (archived_by is null))
);
create index projects_owner on public.projects (owner_id);
create index projects_updated on public.projects (updated_at);

create table public.project_members (
  project_id  text not null references public.projects (id) on delete cascade,
  user_id     uuid not null references public.profiles (id),
  access      public.project_access not null default 'viewer',
  granted_by  uuid references public.profiles (id),
  granted_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user on public.project_members (user_id);

-- ---------- regras de acesso a projeto (usadas pelo RLS, pela Edge Function de chaves e pelas RPCs) ----------
create or replace function gp.can_read_project(p_project text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
       and (p.role = 'MASTER'
            or gp.has_perm('projects.view_all')
            or exists (select 1 from public.projects x where x.id = p_project and x.owner_id = p.id)
            or exists (select 1 from public.project_members m where m.project_id = p_project and m.user_id = p.id))
  )
$$;

create or replace function gp.can_edit_project(p_project text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
       and (p.role = 'MASTER'
            or gp.has_perm('projects.edit_all')
            or exists (select 1 from public.projects x where x.id = p_project and x.owner_id = p.id)
            or exists (select 1 from public.project_members m
                        where m.project_id = p_project and m.user_id = p.id and m.access in ('editor', 'manager')))
  )
$$;

-- Gerenciar membros / arquivar: MASTER, dono ou membro manager.
create or replace function gp.can_manage_project(p_project text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
       and (p.role = 'MASTER'
            or exists (select 1 from public.projects x where x.id = p_project and x.owner_id = p.id)
            or exists (select 1 from public.project_members m
                        where m.project_id = p_project and m.user_id = p.id and m.access = 'manager'))
  )
$$;

-- Pela API: id, dono, criador e arquivamento são imutáveis (dono/arquivamento só por RPC).
create or replace function gp.projects_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if gp.is_api_call() then
    if tg_op = 'INSERT' then
      if new.owner_id is distinct from auth.uid() or new.created_by is distinct from auth.uid() then
        raise exception 'O projeto é criado em nome de quem está conectado.' using errcode = '42501';
      end if;
      if new.archived_at is not null then
        raise exception 'Projeto não pode nascer arquivado.' using errcode = '42501';
      end if;
    else
      if (new.id, new.owner_id, new.created_by, new.created_at, new.archived_at, new.archived_by)
         is distinct from (old.id, old.owner_id, old.created_by, old.created_at, old.archived_at, old.archived_by) then
        raise exception 'Dono, criador e arquivamento do projeto só mudam pelos procedimentos próprios.' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end
$$;

create trigger gp_projects_guard before insert or update on public.projects
  for each row execute function gp.projects_guard();
create trigger gp_touch before insert or update on public.projects
  for each row execute function gp.touch_row();

-- O dono entra como manager em project_members (lista de acesso explícita e auditável).
create or replace function gp.projects_owner_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_members (project_id, user_id, access, granted_by)
  values (new.id, new.owner_id, 'manager', new.created_by)
  on conflict (project_id, user_id) do update set access = 'manager';
  return new;
end
$$;

create trigger gp_projects_owner_member after insert on public.projects
  for each row execute function gp.projects_owner_member();

-- ---------- execução dos checklists (1 linha por passo do ciclo) ----------
-- doc: estado dos itens (feito, datas, carry, execuções, ids de evidência…). enc: observações e metadados de evidências.
create table public.project_checklists (
  project_id  text not null references public.projects (id) on delete cascade,
  step_id     text not null check (gp.is_entity_id(step_id)),
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  enc         jsonb check (enc is null or gp.is_envelope(enc)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0),
  primary key (project_id, step_id)
);
create trigger gp_touch before insert or update on public.project_checklists
  for each row execute function gp.touch_row();

-- ---------- contatos do projeto (DADO PESSOAL de terceiros) ----------
-- Tabela própria: localizar/corrigir/anonimizar dados de um titular sem vasculhar blobs.
create table public.project_contacts (
  id             text primary key check (gp.is_entity_id(id)),
  project_id     text not null references public.projects (id) on delete cascade,
  kind           text not null default 'other' check (kind in ('stakeholder', 'client', 'other')),
  position       integer not null default 0,
  enc            jsonb not null check (gp.is_envelope(enc)),
  anonymized_at  timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.profiles (id) default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles (id),
  revision       integer not null default 1 check (revision > 0)
);
create index project_contacts_project on public.project_contacts (project_id, position);
create trigger gp_touch before insert or update on public.project_contacts
  for each row execute function gp.touch_row();

-- ---------- modelos de e-mail (globais ou de um projeto) ----------
create table public.email_templates (
  id          text primary key check (gp.is_entity_id(id)),
  scope       text not null default 'global' check (scope in ('global', 'project')),
  project_id  text references public.projects (id) on delete cascade,
  position    integer not null default 0,
  version     integer not null default 1 check (version > 0),
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  enc         jsonb check (enc is null or gp.is_envelope(enc)),  -- destinatários com e-mail literal
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0),
  constraint email_templates_scope check ((scope = 'global') = (project_id is null)),
  constraint email_templates_no_plain_recipients check (not (doc ?| array['to', 'cc', 'bcc']))
);
create trigger gp_touch before insert or update on public.email_templates
  for each row execute function gp.touch_row();

-- ---------- e-mails GERADOS (o app não envia) — histórico por projeto, conteúdo cifrado ----------
create table public.email_generations (
  id           text primary key check (gp.is_entity_id(id)),
  project_id   text not null references public.projects (id) on delete cascade,
  template_id  text,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id) default auth.uid(),
  doc          jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),  -- edited, copied, copiedAt, ref. do item
  enc          jsonb not null check (gp.is_envelope(enc)),                                -- to/cc/bcc, assunto, corpo, nomes
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles (id),
  revision     integer not null default 1 check (revision > 0),
  constraint email_generations_no_plaintext check (not (doc ?| array['to', 'cc', 'bcc', 'subject', 'body', 'bodyHtml', 'projectName']))
);
create index email_generations_project on public.email_generations (project_id, created_at desc);
create trigger gp_touch before insert or update on public.email_generations
  for each row execute function gp.touch_row();
