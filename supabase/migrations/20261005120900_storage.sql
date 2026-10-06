-- =====================================================================
-- 010 · Storage (arquivos)
--   evidence      evidências do checklist — caminho <project_id>/<step_id>/<evidence_id>; conteúdo JÁ CIFRADO pelo app (DEK do projeto)
--   email-images  imagens do corpo dos modelos de e-mail (configuração global)
--   releases      pacotes assinados do aplicativo (Central de Atualizações)
-- Todos privados. Nada de exclusão pelo cliente: evidência removida é marcada no checklist (arquivo preservado).
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 26214400),          -- 25 MB (limite atual do app é menor; folga para o envelope)
       ('email-images', 'email-images', false, 5242880),   -- 5 MB
       ('releases', 'releases', false, 524288000)           -- 500 MB
on conflict (id) do nothing;

create policy evidence_read on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and gp.can_read_project((storage.foldername(name))[1]));
create policy evidence_write on storage.objects for insert to authenticated
  with check (bucket_id = 'evidence' and gp.can_edit_project((storage.foldername(name))[1]));

create policy email_images_read on storage.objects for select to authenticated
  using (bucket_id = 'email-images' and gp.is_active());
create policy email_images_write on storage.objects for insert to authenticated
  with check (bucket_id = 'email-images' and gp.has_perm('config.comms.manage'));

create policy releases_read on storage.objects for select to authenticated
  using (bucket_id = 'releases' and gp.is_active());
create policy releases_write on storage.objects for insert to authenticated
  with check (bucket_id = 'releases' and gp.has_perm('releases.publish'));
