-- =====================================================================
-- 002 · Identidade
-- auth.users (Supabase Auth: senha, convite, recuperação) + profiles (papel e estado no app).
-- O app nunca guarda senha nem hash. Papel e estado só mudam por RPC administrativa (migration 009).
-- =====================================================================

create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete restrict, -- desativar ≠ apagar
  username           text check (username ~ '^[A-Za-z0-9._-]{3,40}$'),               -- só exibição; nunca regra nem FK
  display_name       text not null default '' check (length(display_name) <= 120),
  role               public.app_role not null default 'USER',
  status             public.account_status not null default 'pending',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  activated_at       timestamptz,
  activated_by       uuid references public.profiles (id),
  status_changed_at  timestamptz,
  status_changed_by  uuid references public.profiles (id)
);
create unique index profiles_username_ci on public.profiles (lower(username));

comment on table public.profiles is 'Papel e estado do usuário no app. Senha/e-mail ficam no Supabase Auth.';

-- ---------- helpers de identidade (SECURITY DEFINER: leem profiles sem depender do RLS da própria tabela) ----------
create or replace function gp.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active')
$$;

create or replace function gp.is_master() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role = 'MASTER')
$$;

-- Papel efetivo de quem chama (null se não estiver ativo).
create or replace function gp.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.status = 'active'
$$;

-- ---------- criação automática do profile ----------
-- Todo usuário novo do Auth nasce SEM acesso: role USER, estado invited (convite ainda não aceito) ou pending.
-- raw_user_meta_data só fornece nome de exibição/username sugerido (nunca papel ou permissão).
create or replace function gp.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_username text := nullif(new.raw_user_meta_data ->> 'username', '');
begin
  if v_username is not null and (v_username !~ '^[A-Za-z0-9._-]{3,40}$'
      or exists (select 1 from public.profiles p where lower(p.username) = lower(v_username))) then
    v_username := null; -- inválido ou já usado: o administrador define depois
  end if;
  insert into public.profiles (id, username, display_name, status)
  values (
    new.id,
    v_username,
    left(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(new.email, ''), '@', 1)), 120),
    case when new.invited_at is not null and new.email_confirmed_at is null
         then 'invited'::public.account_status else 'pending'::public.account_status end
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger gp_on_auth_user_created
  after insert on auth.users
  for each row execute function gp.on_auth_user_created();

-- Convite aceito (e-mail confirmado pelo código do convite): invited → pending (aguarda provisionamento).
create or replace function gp.on_auth_user_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    update public.profiles set status = 'pending', status_changed_at = now()
     where id = new.id and status = 'invited';
  end if;
  return new;
end
$$;

create trigger gp_on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function gp.on_auth_user_confirmed();

-- ---------- proteção do profile ----------
-- 1) Pela API o usuário só altera o próprio display_name.
-- 2) MASTER: não pode ser excluído, suspenso nem rebaixado; ninguém vira MASTER fora do procedimento próprio
--    (gp.grant_master / public.relinquish_master ligam gp.allow_master_change só dentro da transação).
--    Break-glass documentado: dono do projeto Supabase no SQL Editor (SECURITY.md).
create or replace function gp.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_master_ok boolean := coalesce(current_setting('gp.allow_master_change', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.role = 'MASTER' then
      raise exception 'O usuário MASTER não pode ser excluído.' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'MASTER' and not v_master_ok then
      raise exception 'Papel MASTER só é atribuído pelo procedimento de bootstrap/transferência.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id then
    raise exception 'id do profile é imutável.' using errcode = '42501';
  end if;
  if gp.is_api_call() then
    if new.id is distinct from auth.uid()
       or (new.username, new.role, new.status, new.created_at, new.activated_at, new.activated_by, new.status_changed_at, new.status_changed_by)
          is distinct from
          (old.username, old.role, old.status, old.created_at, old.activated_at, old.activated_by, old.status_changed_at, old.status_changed_by) then
      raise exception 'Pela API só é possível alterar o próprio nome de exibição.' using errcode = '42501';
    end if;
  end if;
  if old.role = 'MASTER' and (new.role <> 'MASTER' or new.status <> 'active') and not v_master_ok then
    raise exception 'O MASTER não pode perder o papel nem ser suspenso/desativado por esta via.' using errcode = '42501';
  end if;
  if new.role = 'MASTER' and old.role <> 'MASTER' and not v_master_ok then
    raise exception 'Papel MASTER só é atribuído pelo procedimento de transferência.' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end
$$;

create trigger gp_profiles_guard
  before insert or update or delete on public.profiles
  for each row execute function gp.profiles_guard();
