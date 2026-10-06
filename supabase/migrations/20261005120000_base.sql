-- =====================================================================
-- 001 · Base
-- Schema privado `gp` (helpers usados pelo RLS; NÃO exposto pela API REST),
-- tipos compartilhados e funções utilitárias.
-- Ver docs/architecture/ARCHITECTURE-MIGRATION-PLAN.md §5–§9.
-- =====================================================================

create schema if not exists gp;
revoke all on schema gp from public;
-- O RLS chama gp.* com o papel de quem consulta: precisa de USAGE (mas o schema não é exposto pelo PostgREST).
grant usage on schema gp to authenticated, service_role;

create type public.app_role as enum ('MASTER', 'ADMIN', 'USER');
create type public.account_status as enum ('invited', 'pending', 'active', 'suspended');
create type public.project_access as enum ('viewer', 'editor', 'manager');

-- Envelope de cifra v1 (AES-256-GCM, cifrado na aplicação). A coluna `enc` só aceita esse formato:
-- texto em claro gravado por engano numa coluna cifrada é recusado pelo banco.
--   { "v": 1, "alg": "A256GCM", "kid": "<uuid da DEK>", "iv": "<12 bytes b64>", "ct": "<b64>", "tag": "<16 bytes b64>" }
create or replace function gp.is_envelope(e jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select e is not null
     and jsonb_typeof(e) = 'object'
     and e ->> 'v' = '1'
     and e ->> 'alg' = 'A256GCM'
     and coalesce(e ->> 'kid', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and coalesce(e ->> 'iv', '') ~ '^[A-Za-z0-9+/]{16}$'
     and coalesce(e ->> 'tag', '') ~ '^[A-Za-z0-9+/]{22}==$'
     and coalesce(e ->> 'ct', '') ~ '^[A-Za-z0-9+/]*={0,2}$'
     and (select count(*) from jsonb_object_keys(e)) = 6
$$;

-- Ids de entidades de domínio: os ids atuais (12 hex) e os padrões fixos (ex.: st-homologacao, cyc-padrao) são preservados.
create or replace function gp.is_entity_id(v text) returns boolean
language sql immutable set search_path = '' as $$
  select v ~ '^[A-Za-z0-9_-]{1,64}$'
$$;

-- Chamada vinda da API (cliente) e não de função SECURITY DEFINER / SQL Editor.
create or replace function gp.is_api_call() returns boolean
language sql stable set search_path = '' as $$
  select current_user in ('authenticated', 'anon')
$$;

-- Carimbo padrão das linhas versionadas: revision (concorrência otimista), updated_at, updated_by.
-- O cliente atualiza com filtro `revision = <lida>`; 0 linhas afetadas = alterado por outra pessoa (409 STALE_DATA no app).
create or replace function gp.touch_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end
$$;
