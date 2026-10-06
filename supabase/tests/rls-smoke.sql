-- =====================================================================
-- Smoke test de RLS no Supabase REAL (projeto DEV). Rodar no SQL Editor.
-- Não deixa rastro: tudo acontece dentro de uma transação desfeita no final (ROLLBACK).
-- Pré-requisito: 3 usuários no Auth do DEV — você (já MASTER) e dois de teste ainda NÃO provisionados (status pending).
-- Substitua os três <UUID_...> abaixo (Authentication → Users → copiar o "UID").
-- Resultado esperado: só linhas "OK" nas mensagens (aba Messages/Notices) e nenhuma "FALHOU".
-- =====================================================================
begin;

create function pg_temp.act_as(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', case when u is null then 'anon' else 'authenticated' end)::text, true);
  perform set_config('role', case when u is null then 'anon' else 'authenticated' end, true);
end $$;
create function pg_temp.act_as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.env() returns jsonb language sql as $$
  select jsonb_build_object('v', 1, 'alg', 'A256GCM', 'kid', gen_random_uuid(),
    'iv', encode(substring(uuid_send(gen_random_uuid()) from 1 for 12), 'base64'),
    'ct', encode(uuid_send(gen_random_uuid()), 'base64'), 'tag', encode(uuid_send(gen_random_uuid()), 'base64'))
$$;

do $$
declare
  m uuid := '<UUID_MASTER>';
  a uuid := '<UUID_TESTE_A>';
  b uuid := '<UUID_TESTE_B>';
  n integer;
begin
  -- 1. provisionamento pelo MASTER
  perform pg_temp.act_as(m);
  perform public.admin_provision_user(a, 'Teste.A', 'Teste A', 'USER', '{projects.create}');
  perform public.admin_provision_user(b, 'Teste.B', 'Teste B', 'USER', '{projects.create}');
  raise notice 'OK 1: MASTER provisionou A e B';

  -- 2. A cria projeto (cifrado); B não vê
  perform pg_temp.act_as(a);
  perform public.apply_changes(jsonb_build_array(jsonb_build_object('table', 'projects', 'op', 'insert', 'key', jsonb_build_object('id', 'smoke-pA'),
    'values', jsonb_build_object('owner_id', a, 'created_by', a, 'doc', '{}'::jsonb, 'enc', pg_temp.env()))));
  select count(*) into n from public.projects where id = 'smoke-pA';
  if n <> 1 then raise exception 'FALHOU 2a: A não vê o próprio projeto'; end if;
  perform pg_temp.act_as(b);
  select count(*) into n from public.projects where id = 'smoke-pA';
  if n <> 0 then raise exception 'FALHOU 2b: B vê projeto de A'; end if;
  raise notice 'OK 2: isolamento entre A e B';

  -- 3. B não altera projeto de A
  begin
    perform public.apply_changes(jsonb_build_array(jsonb_build_object('table', 'projects', 'op', 'update', 'key', jsonb_build_object('id', 'smoke-pA'),
      'expected_revision', 1, 'values', jsonb_build_object('step_id', 'x'))));
    raise exception 'FALHOU 3: B alterou projeto de A';
  exception when sqlstate 'GP409' then raise notice 'OK 3: B não altera projeto de A';
  end;

  -- 4. compartilhar e revogar
  perform pg_temp.act_as(a);
  perform public.project_set_access('smoke-pA', b, 'viewer');
  perform pg_temp.act_as(b);
  select count(*) into n from public.projects where id = 'smoke-pA';
  if n <> 1 then raise exception 'FALHOU 4a: compartilhado e B não vê'; end if;
  perform pg_temp.act_as(a);
  perform public.project_revoke_access('smoke-pA', b);
  perform pg_temp.act_as(b);
  select count(*) into n from public.projects where id = 'smoke-pA';
  if n <> 0 then raise exception 'FALHOU 4b: revogado e B ainda vê'; end if;
  raise notice 'OK 4: compartilhar e revogar';

  -- 5. MASTER vê tudo
  perform pg_temp.act_as(m);
  select count(*) into n from public.projects where id = 'smoke-pA';
  if n <> 1 then raise exception 'FALHOU 5: MASTER não vê'; end if;
  raise notice 'OK 5: MASTER vê todos';

  -- 6. configuração global: A usa, não administra
  perform pg_temp.act_as(a);
  begin
    perform public.apply_changes('[{"table":"stages","op":"insert","key":{"id":"smoke-st"},"values":{"doc":{"name":"x"}}}]'::jsonb);
    raise exception 'FALHOU 6: A criou estágio sem permissão';
  exception when insufficient_privilege then raise notice 'OK 6: GESTÃO de configuração bloqueada para A';
  end;

  -- 7. chaves e escalonamento
  begin
    perform 1 from public.data_keys limit 1;
    raise exception 'FALHOU 7a: cliente leu data_keys';
  exception when insufficient_privilege then raise notice 'OK 7a: data_keys inacessível';
  end;
  begin
    update public.profiles set role = 'ADMIN' where id = a;
    raise exception 'FALHOU 7b: A mudou o próprio papel';
  exception when insufficient_privilege then raise notice 'OK 7b: A não muda o próprio papel';
  end;

  -- 8. suspensão imediata
  perform pg_temp.act_as(m);
  perform public.admin_set_status(a, 'suspended');
  perform pg_temp.act_as(a);
  select count(*) into n from public.projects;
  if n <> 0 then raise exception 'FALHOU 8: suspenso ainda vê projetos'; end if;
  raise notice 'OK 8: suspensão imediata';

  -- 9. anônimo
  perform pg_temp.act_as(null);
  begin
    perform 1 from public.projects limit 1;
    raise exception 'FALHOU 9: anônimo leu projects';
  exception when insufficient_privilege then raise notice 'OK 9: anônimo sem acesso';
  end;

  perform pg_temp.act_as_owner();
  raise notice 'TODOS OS CASOS OK — a transação será desfeita (ROLLBACK).';
end $$;

rollback;
