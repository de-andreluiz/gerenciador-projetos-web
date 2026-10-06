-- =====================================================================
-- 004 · Configurações globais (compartilhadas)
-- Forma uniforme: id (preservado do app), position, doc (estrutura NÃO sensível),
-- enc (envelope cifrado na aplicação, só onde há dado pessoal/confidencial),
-- revision (concorrência otimista) e carimbos.
-- Integridade entre agregados (ex.: projeto → ciclo) continua garantida pela aplicação,
-- como hoje (ex.: tipo excluído → projeto fica sem tipo); aqui só FK dentro do mesmo agregado.
-- USO (leitura) é de qualquer usuário ativo; GESTÃO exige config.<área>.manage (RLS na migration 008).
-- =====================================================================

-- Estágios (nome, cor)
create table public.stages (
  id          text primary key check (gp.is_entity_id(id)),
  position    integer not null default 0,
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0)
);

-- Ciclos (passos com estágio + checklists por passo). `version` sobe quando os passos mudam (projetos aplicam/sincronizam).
create table public.cycles (
  id          text primary key check (gp.is_entity_id(id)),
  position    integer not null default 0,
  version     integer not null default 1 check (version > 0),
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0)
);

-- Tipos de projeto (nome, cor, ciclo padrão) e sistemas de origem (nome, cor)
create table public.project_types (
  id          text primary key check (gp.is_entity_id(id)),
  position    integer not null default 0,
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0)
);

create table public.origin_systems (
  id          text primary key check (gp.is_entity_id(id)),
  position    integer not null default 0,
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0)
);

-- Checklists (modelo) e seus itens. `version` prepara a Central de Atualizações (modelo × projeto).
create table public.checklists (
  id          text primary key check (gp.is_entity_id(id)),
  position    integer not null default 0,
  version     integer not null default 1 check (version > 0),
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0)
);

create table public.checklist_items (
  id            text primary key check (gp.is_entity_id(id)),
  checklist_id  text not null references public.checklists (id) on delete cascade,
  position      integer not null default 0,  -- ordem dos itens (hoje: ordem no array global)
  doc           jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id) default auth.uid(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles (id),
  revision      integer not null default 1 check (revision > 0)
);
create index checklist_items_checklist on public.checklist_items (checklist_id, position);

-- Documentos e Modelos (link). Documento do tipo "arquivo local": o caminho fica no vínculo local da máquina, nunca aqui.
create table public.documents (
  id          text primary key check (gp.is_entity_id(id)),
  position    integer not null default 0,
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0),
  constraint documents_no_local_path check (coalesce(doc #>> '{source,type}', 'link') <> 'file' or doc #>> '{source,path}' is null)
);

-- Imagens do corpo dos modelos de e-mail (arquivo no Storage, bucket email-images)
create table public.email_images (
  id            text primary key check (gp.is_entity_id(id)),
  storage_path  text not null,
  doc           jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id) default auth.uid(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles (id),
  revision      integer not null default 1 check (revision > 0)
);

-- Scripts SQL: conteúdo + histórico de versões (antes: data/scripts/*.sql e .versoes). Cópia de trabalho local para SSMS/VS Code.
create table public.scripts (
  id               text primary key check (gp.is_entity_id(id)),
  doc              jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  content          text not null default '',
  current_version  integer not null default 1 check (current_version > 0),
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id) default auth.uid(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles (id),
  revision         integer not null default 1 check (revision > 0)
);

create table public.script_versions (
  script_id   text not null references public.scripts (id) on delete cascade,
  version     integer not null check (version > 0),
  content     text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  primary key (script_id, version)
);

-- Pessoas (coordenadores/analistas) — DADO PESSOAL: nome, cargo, e-mail, telefone, observações só no envelope cifrado.
-- profile_id opcional: a pessoa pode ser também usuária do app.
create table public.people (
  id           text primary key check (gp.is_entity_id(id)),
  position     integer not null default 0,
  profile_id   uuid references public.profiles (id),
  active       boolean not null default true,
  enc          jsonb not null check (gp.is_envelope(enc)),
  anonymized_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id) default auth.uid(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles (id),
  revision     integer not null default 1 check (revision > 0)
);

-- Conexões de banco: metadados compartilháveis. Identificadores (nome, servidor, porta, banco, login, observações) cifrados.
-- A SENHA NUNCA vem para cá: fica na máquina de cada usuário (DPAPI).
create table public.connections (
  id          text primary key check (gp.is_entity_id(id)),
  env         text not null check (env in ('prod', 'hml', 'dev', 'local')),
  auth_kind   text not null check (auth_kind in ('windows', 'sql')),
  doc         jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object'),
  enc         jsonb not null check (gp.is_envelope(enc)),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0),
  constraint connections_no_plaintext check (not (doc ?| array['name', 'server', 'port', 'database', 'user', 'notes', 'password', 'passwordEnc'])),
  constraint connections_local_never_destructive check (env <> 'local' or coalesce((doc ->> 'allowDestructive')::boolean, false) = false)
);

-- Parâmetros globais (ex.: warnDays). Chave/valor, sem dado pessoal.
create table public.app_settings (
  key         text primary key check (key ~ '^[a-z][a-zA-Z0-9_.]{1,63}$'),
  value       jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),
  revision    integer not null default 1 check (revision > 0)
);

-- Carimbos (revision/updated_*) em todas as tabelas versionadas
create trigger gp_touch before insert or update on public.stages          for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.cycles          for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.project_types   for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.origin_systems  for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.checklists      for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.checklist_items for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.documents       for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.email_images    for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.scripts         for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.people          for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.connections     for each row execute function gp.touch_row();
create trigger gp_touch before insert or update on public.app_settings    for each row execute function gp.touch_row();
