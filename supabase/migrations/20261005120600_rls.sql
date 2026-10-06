-- =====================================================================
-- 007 · Row Level Security, grants e gatilhos de auditoria
-- Default: NEGADO. Toda tabela do schema public tem RLS; sem política = sem acesso.
-- `anon` (sem login) não recebe nada. Toda política exige usuário ATIVO (PENDING/SUSPENDED não veem dado algum).
-- Exclusão de linhas só onde o app realmente remove (config, contatos); projetos são arquivados, nunca apagados.
-- =====================================================================

-- ---------- grants de base ----------
revoke all on all tables in schema public from anon, public;
revoke all on all sequences in schema public from anon, public;
revoke execute on all functions in schema public from anon, public;
revoke execute on all functions in schema gp from anon, public;
grant execute on all functions in schema gp to authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to authenticated;
-- tabelas sem acesso direto algum para clientes
revoke all on public.data_keys from authenticated;
revoke insert, update, delete on public.audit_events from authenticated;
revoke insert, update, delete on public.profiles, public.permissions, public.role_permissions, public.user_permissions,
       public.project_members, public.migration_runs from authenticated;
grant insert, update on public.migration_runs to authenticated;          -- RLS restringe ao MASTER
grant update (display_name) on public.profiles to authenticated;          -- o trigger também confere

-- Tabelas criadas no futuro não ficam abertas para anon por padrão (Supabase concede por default privileges).
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from anon, public;
alter default privileges in schema gp revoke execute on functions from anon, public;

-- ---------- RLS ligado em tudo ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------- identidade e permissões ----------
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or gp.has_perm('users.manage'));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy permissions_select on public.permissions for select to authenticated using (gp.is_active());
create policy role_permissions_select on public.role_permissions for select to authenticated using (gp.is_active());
create policy user_permissions_select on public.user_permissions for select to authenticated
  using (user_id = auth.uid() or gp.has_perm('users.manage'));
-- user_permissions / project_members / profiles(role, status): escrita só pelas RPCs gp_admin (migration 009).

-- ---------- projetos ----------
create policy projects_select on public.projects for select to authenticated using (gp.can_read_project(id));
create policy projects_insert on public.projects for insert to authenticated with check (gp.has_perm('projects.create'));
create policy projects_update on public.projects for update to authenticated
  using (gp.can_edit_project(id)) with check (gp.can_edit_project(id));

create policy project_members_select on public.project_members for select to authenticated
  using (gp.can_read_project(project_id));

create policy project_checklists_select on public.project_checklists for select to authenticated using (gp.can_read_project(project_id));
create policy project_checklists_insert on public.project_checklists for insert to authenticated with check (gp.can_edit_project(project_id));
create policy project_checklists_update on public.project_checklists for update to authenticated
  using (gp.can_edit_project(project_id)) with check (gp.can_edit_project(project_id));

create policy project_contacts_select on public.project_contacts for select to authenticated using (gp.can_read_project(project_id));
create policy project_contacts_insert on public.project_contacts for insert to authenticated with check (gp.can_edit_project(project_id));
create policy project_contacts_update on public.project_contacts for update to authenticated
  using (gp.can_edit_project(project_id)) with check (gp.can_edit_project(project_id));
create policy project_contacts_delete on public.project_contacts for delete to authenticated using (gp.can_edit_project(project_id));

create policy email_generations_select on public.email_generations for select to authenticated using (gp.can_read_project(project_id));
create policy email_generations_insert on public.email_generations for insert to authenticated with check (gp.can_edit_project(project_id));
create policy email_generations_update on public.email_generations for update to authenticated
  using (gp.can_edit_project(project_id)) with check (gp.can_edit_project(project_id));
create policy email_generations_delete on public.email_generations for delete to authenticated using (gp.can_edit_project(project_id));

-- Modelos de e-mail: globais (USO por todos os ativos, GESTÃO com config.comms.manage) ou do projeto (editor do projeto).
create policy email_templates_select on public.email_templates for select to authenticated
  using (gp.is_active() and (scope = 'global' or gp.can_read_project(project_id)));
create policy email_templates_write on public.email_templates for insert to authenticated
  with check (case when scope = 'global' then gp.has_perm('config.comms.manage') else gp.can_edit_project(project_id) end);
create policy email_templates_update on public.email_templates for update to authenticated
  using (case when scope = 'global' then gp.has_perm('config.comms.manage') else gp.can_edit_project(project_id) end)
  with check (case when scope = 'global' then gp.has_perm('config.comms.manage') else gp.can_edit_project(project_id) end);
create policy email_templates_delete on public.email_templates for delete to authenticated
  using (case when scope = 'global' then gp.has_perm('config.comms.manage') else gp.can_edit_project(project_id) end);

-- ---------- configurações globais: USO (select) × GESTÃO (insert/update/delete) ----------
do $$
declare
  r record;
begin
  for r in select * from (values
      ('stages',          'config.cycles.manage'),
      ('cycles',          'config.cycles.manage'),
      ('project_types',   'config.catalogs.manage'),
      ('origin_systems',  'config.catalogs.manage'),
      ('app_settings',    'config.catalogs.manage'),
      ('checklists',      'config.checklists.manage'),
      ('checklist_items', 'config.checklists.manage'),
      ('documents',       'config.documents.manage'),
      ('email_images',    'config.comms.manage'),
      ('scripts',         'config.scripts.manage'),
      ('script_versions', 'config.scripts.manage'),
      ('people',          'config.people.manage'),
      ('connections',     'connections.manage')
    ) as v(tbl, perm)
  loop
    execute format('create policy %I on public.%I for select to authenticated using (gp.is_active())', r.tbl || '_select', r.tbl);
    execute format('create policy %I on public.%I for insert to authenticated with check (gp.has_perm(%L))', r.tbl || '_insert', r.tbl, r.perm);
    execute format('create policy %I on public.%I for update to authenticated using (gp.has_perm(%L)) with check (gp.has_perm(%L))',
                   r.tbl || '_update', r.tbl, r.perm, r.perm);
    execute format('create policy %I on public.%I for delete to authenticated using (gp.has_perm(%L))', r.tbl || '_delete', r.tbl, r.perm);
  end loop;
end $$;

-- ---------- segurança e operação ----------
-- data_keys: RLS ligado e NENHUMA política → nenhum cliente lê ou grava (só service role na Edge Function).
create policy audit_events_select on public.audit_events for select to authenticated using (gp.has_perm('audit.view'));

create policy migration_runs_select on public.migration_runs for select to authenticated using (gp.is_master());
create policy migration_runs_insert on public.migration_runs for insert to authenticated with check (gp.is_master() and run_by = auth.uid());
create policy migration_runs_update on public.migration_runs for update to authenticated using (gp.is_master()) with check (gp.is_master());

create policy app_releases_select on public.app_releases for select to authenticated using (gp.is_active());
create policy app_releases_insert on public.app_releases for insert to authenticated with check (gp.has_perm('releases.publish'));
create policy app_releases_update on public.app_releases for update to authenticated
  using (gp.has_perm('releases.publish')) with check (gp.has_perm('releases.publish'));

create policy client_versions_select on public.client_versions for select to authenticated
  using (user_id = auth.uid() or gp.has_perm('users.manage'));
create policy client_versions_upsert on public.client_versions for insert to authenticated with check (user_id = auth.uid() and gp.is_active());
create policy client_versions_update on public.client_versions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and gp.is_active());

-- ---------- auditoria automática ----------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'user_permissions', 'project_members', 'projects', 'project_checklists', 'project_contacts',
                           'email_templates', 'email_generations', 'stages', 'cycles', 'project_types', 'origin_systems',
                           'checklists', 'checklist_items', 'documents', 'email_images', 'scripts', 'people', 'connections',
                           'app_settings', 'app_releases', 'migration_runs']
  loop
    execute format('create trigger gp_audit after insert or update or delete on public.%I for each row execute function gp.audit_row()', t);
  end loop;
end $$;
