-- =====================================================================
-- ROLLBACK COMPLETO — SOMENTE NO PROJETO DEV
-- Remove tudo o que as migrations criaram (tabelas, dados, funções, políticas, triggers no auth.users).
-- NÃO apaga usuários do Supabase Auth. Buckets precisam estar vazios (Storage → esvaziar antes).
-- Em PRODUÇÃO não use isto: restaure o backup do Supabase (ver docs/BACKUP-RESTORE.md).
-- =====================================================================
begin;

drop trigger if exists gp_on_auth_user_created on auth.users;
drop trigger if exists gp_on_auth_user_confirmed on auth.users;

drop policy if exists evidence_read on storage.objects;
drop policy if exists evidence_write on storage.objects;
drop policy if exists email_images_read on storage.objects;
drop policy if exists email_images_write on storage.objects;
drop policy if exists releases_read on storage.objects;
drop policy if exists releases_write on storage.objects;
delete from storage.buckets where id in ('evidence', 'email-images', 'releases');

drop function if exists public.apply_changes(jsonb);
drop function if exists public.log_event(text, text, text, text, jsonb, text);
drop function if exists public.my_profile();
drop function if exists public.user_directory();
drop function if exists public.admin_list_users();
drop function if exists public.admin_provision_user(uuid, text, text, public.app_role, text[]);
drop function if exists public.admin_set_status(uuid, public.account_status);
drop function if exists public.admin_set_role(uuid, public.app_role);
drop function if exists public.admin_set_names(uuid, text, text);
drop function if exists public.admin_grant_permission(uuid, text);
drop function if exists public.admin_revoke_permission(uuid, text);
drop function if exists public.project_set_access(text, uuid, public.project_access);
drop function if exists public.project_revoke_access(text, uuid);
drop function if exists public.project_transfer_owner(text, uuid);
drop function if exists public.project_set_archived(text, boolean);
drop function if exists public.grant_master(uuid);
drop function if exists public.relinquish_master();
drop function if exists public.key_access(text[]);

drop table if exists public.client_versions, public.app_releases, public.migration_runs, public.audit_events, public.data_keys,
  public.email_generations, public.email_templates, public.project_contacts, public.project_checklists, public.project_members,
  public.projects, public.app_settings, public.connections, public.people, public.script_versions, public.scripts,
  public.email_images, public.documents, public.checklist_items, public.checklists, public.origin_systems, public.project_types,
  public.cycles, public.stages, public.user_permissions, public.role_permissions, public.permissions, public.profiles cascade;

drop schema if exists gp cascade;
drop type if exists public.project_access, public.account_status, public.app_role;

commit;
-- Com a CLI, depois disto: apague o histórico de migrations aplicadas (supabase_migrations.schema_migrations) se for reaplicar.
