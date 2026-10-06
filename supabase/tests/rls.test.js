// Testes das migrations do Supabase num Postgres embutido (PGlite): schema, RLS, RPCs administrativas, proteção do MASTER,
// concorrência otimista, atomicidade, envelope de cifra, auditoria e Storage.
// Matriz: MASTER · ADMIN · USER A · USER B · pendente (PENDING_SETUP) · convidado · anônimo.
// Segurança não é validada "porque o botão sumiu": cada caso consulta o banco com o papel e o JWT do usuário.
// Rodar: npm run test:rls   (os mesmos cenários devem ser repetidos no projeto Supabase de dev — ver docs/SETUP-SUPABASE.md)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
let db;
const U = {}; // nome → uuid

const rows = async (q, params) => (await db.query(q, params)).rows;
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const envelope = () => ({ v: 1, alg: 'A256GCM', kid: crypto.randomUUID(), iv: b64(12), ct: b64(40), tag: b64(16) });

// Executa fn como o usuário (papel authenticated + JWT com sub/amr), como o PostgREST faria.
async function as(name, fn, { recentAuth = false } = {}) {
  const anon = name === 'anon';
  const sub = anon ? '' : U[name];
  const now = Math.floor(Date.now() / 1000);
  const claims = JSON.stringify({ sub, role: anon ? 'anon' : 'authenticated', amr: [{ method: 'password', timestamp: recentAuth ? now : now - 7200 }] });
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [sub, claims]);
  await db.exec(`set role ${anon ? 'anon' : 'authenticated'}`);
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)");
  }
}
const apply = async (changes) => (await rows('select public.apply_changes($1::jsonb) as r', [JSON.stringify(changes)]))[0].r;
const rejects = (p, code, msg) => assert.rejects(p, (e) => { assert.equal(e.code, code, `${msg || ''} → ${e.code} ${e.message}`); return true; });
const projectIds = async () => (await rows('select id from public.projects order by id')).map((r) => r.id);
const newProject = (id, owner) => ({ table: 'projects', op: 'insert', key: { id },
  values: { owner_id: U[owner], created_by: U[owner], cycle_id: 'cyc-padrao', doc: { steps: [], milestones: [] }, enc: envelope() } });

test.before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'supabase-stub.sql'), 'utf8'));
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  const mk = async (name, { invited = false, confirmed = true, meta = {} } = {}) => {
    U[name] = (await rows(`insert into auth.users (email, raw_user_meta_data, invited_at, email_confirmed_at)
      values ($1, $2::jsonb, $3, $4) returning id`, [`${name}@exemplo.test`, JSON.stringify(meta), invited ? new Date() : null, confirmed ? new Date() : null]))[0].id;
  };
  await mk('master', { meta: { display_name: 'Usuário Master', username: 'Master.User' } });
  for (const n of ['admin', 'userA', 'userB', 'pending']) await mk(n);
  await mk('invited', { invited: true, confirmed: false, meta: { username: 'Master.User' } }); // username repetido → ignorado
});

test('perfil nasce sem acesso: USER + pending (ou invited); username repetido é ignorado', async () => {
  const p = await rows('select username, role, status from public.profiles where id = $1', [U.master]);
  assert.deepEqual(p[0], { username: 'Master.User', role: 'USER', status: 'pending' });
  const inv = await rows('select username, status from public.profiles where id = $1', [U.invited]);
  assert.deepEqual(inv[0], { username: null, status: 'invited' });
  // convite aceito (e-mail confirmado pelo código) → pending
  await rows('update auth.users set email_confirmed_at = now() where id = $1', [U.invited]);
  assert.equal((await rows('select status from public.profiles where id = $1', [U.invited]))[0].status, 'pending');
});

test('antes do provisionamento ninguém vê nada; pendente não grava', async () => {
  await rows("insert into public.stages (id, doc) values ('st-1', '{\"name\":\"Homologação\"}')"); // seed como dono
  for (const n of ['master', 'pending', 'userA']) {
    await as(n, async () => {
      assert.deepEqual(await rows('select id from public.stages'), [], `${n} sem acesso a configurações`);
      await rejects(apply([newProject('pX', n)]), '42501', `${n} não grava`);
      const me = (await rows('select public.my_profile() as p'))[0].p;
      assert.equal(me.status, 'pending'); assert.deepEqual(me.permissions, []);
    });
  }
});

test('bootstrap do MASTER: só pelo dono do banco, uma única vez', async () => {
  await as('master', () => rejects(rows('select gp.bootstrap_master($1)', [U.master]), '42501', 'cliente não executa bootstrap'));
  await rows('select gp.bootstrap_master($1)', [U.master]);
  assert.deepEqual((await rows('select role, status from public.profiles where id = $1', [U.master]))[0], { role: 'MASTER', status: 'active' });
  await assert.rejects(rows('select gp.bootstrap_master($1)', [U.admin]), /Já existe um MASTER/);
});

test('MASTER provisiona: ADMIN, USER A e USER B (PENDING_SETUP → ACTIVE)', async () => {
  await as('master', async () => {
    await rows("select public.admin_provision_user($1, 'Admin.Um', 'Admin Um', 'ADMIN', '{}')", [U.admin]);
    await rows("select public.admin_provision_user($1, 'User.A', 'Usuário A', 'USER', '{projects.create}')", [U.userA]);
    await rows("select public.admin_provision_user($1, 'User.B', 'Usuário B', 'USER', '{projects.create}')", [U.userB]);
    const list = await rows('select username, role, status, permissions from public.admin_list_users() order by username');
    assert.deepEqual(list.find((x) => x.username === 'User.A'), { username: 'User.A', role: 'USER', status: 'active', permissions: ['projects.create'] });
  });
  await as('userA', async () => {
    const me = (await rows('select public.my_profile() as p'))[0].p;
    assert.equal(me.status, 'active'); assert.deepEqual(me.permissions, ['projects.create']);
    assert.deepEqual((await rows('select id from public.stages')).map((r) => r.id), ['st-1'], 'USO da configuração global');
  });
});

test('isolamento de projetos: A vê o seu, B o seu, MASTER e ADMIN (view_all) veem todos; pendente e anônimo nada', async () => {
  await as('userA', () => apply([newProject('pA', 'userA')]));
  await as('userB', () => apply([newProject('pB', 'userB')]));
  await as('userA', async () => assert.deepEqual(await projectIds(), ['pA']));
  await as('userB', async () => assert.deepEqual(await projectIds(), ['pB']));
  await as('master', async () => assert.deepEqual(await projectIds(), ['pA', 'pB']));
  await as('admin', async () => assert.deepEqual(await projectIds(), ['pA', 'pB']));
  await as('pending', async () => assert.deepEqual(await projectIds(), []));
  await as('anon', () => rejects(rows('select id from public.projects'), '42501', 'anon sem grant'));
  // dono entra como manager
  await as('userA', async () => assert.deepEqual(await rows('select user_id, access from public.project_members'), [{ user_id: U.userA, access: 'manager' }]));
});

test('projeto é criado em nome de quem está conectado; B não altera projeto de A', async () => {
  await as('userB', () => rejects(apply([newProject('pFake', 'userA')]), '42501', 'owner diferente do usuário'));
  await as('userB', () => rejects(apply([{ table: 'projects', op: 'update', key: { id: 'pA' }, expected_revision: 1, values: { step_id: 'x' } }]), 'GP409', 'invisível = não encontrado'));
  await as('userB', async () => assert.deepEqual(await rows("update public.projects set step_id = 'x' where id = 'pA' returning id"), []));
});

test('compartilhar: B ganha leitura de pA → vê, não edita; vira editor → edita; revogado → deixa de ver', async () => {
  await as('userB', () => rejects(rows("select public.project_set_access('pA', $1, 'viewer')", [U.userB]), '42501', 'B não gerencia pA'));
  await as('userA', () => rows("select public.project_set_access('pA', $1, 'viewer')", [U.userB]));
  await as('userB', async () => {
    assert.deepEqual(await projectIds(), ['pA', 'pB']);
    await rejects(apply([{ table: 'projects', op: 'update', key: { id: 'pA' }, expected_revision: 1, values: { step_id: 'cy-2' } }]), 'GP409', 'viewer não edita');
  });
  await as('userA', () => rows("select public.project_set_access('pA', $1, 'editor')", [U.userB]));
  await as('userB', async () => {
    const r = await apply([{ table: 'projects', op: 'update', key: { id: 'pA' }, expected_revision: 1, values: { step_id: 'cy-2' } }]);
    assert.equal(r[0].revision, 2);
  });
  await as('userA', () => rejects(rows('select public.project_revoke_access($1, $2)', ['pA', U.userA]), '42501', 'dono não sai'));
  await as('userA', () => rows('select public.project_revoke_access($1, $2)', ['pA', U.userB]));
  await as('userB', async () => assert.deepEqual(await projectIds(), ['pB']));
});

test('concorrência otimista e atomicidade do lote', async () => {
  await as('userA', async () => {
    await rejects(apply([{ table: 'projects', op: 'update', key: { id: 'pA' }, expected_revision: 1, values: { step_id: 'cy-3' } }]), 'GP409', 'revisão velha');
    await rejects(apply([{ table: 'projects', op: 'update', key: { id: 'pA' }, values: { step_id: 'cy-3' } }]), '22023', 'expected_revision obrigatório');
    // lote: 1ª alteração válida + 2ª inválida → nada é gravado
    await assert.rejects(apply([
      { table: 'projects', op: 'update', key: { id: 'pA' }, expected_revision: 2, values: { step_id: 'cy-3' } },
      { table: 'project_contacts', op: 'insert', key: { id: 'c1' }, values: { project_id: 'pA', enc: { name: 'texto em claro' } } },
    ]));
    assert.equal((await rows("select revision, step_id from public.projects where id = 'pA'"))[0].revision, 2);
    const ok = await apply([
      { table: 'projects', op: 'update', key: { id: 'pA' }, expected_revision: 2, values: { step_id: 'cy-3' } },
      { table: 'project_contacts', op: 'insert', key: { id: 'c1' }, values: { project_id: 'pA', kind: 'client', enc: envelope() } },
      { table: 'project_checklists', op: 'insert', key: { project_id: 'pA', step_id: 'cy-1' }, values: { doc: { items: [] } } },
    ]);
    assert.deepEqual(ok.map((x) => x.status), ['updated', 'inserted', 'inserted']);
    // migração idempotente: inserir de novo o mesmo id não duplica
    assert.equal((await apply([{ ...newProject('pA', 'userA'), op: 'insert_if_absent' }]))[0].status, 'exists');
    await rejects(apply([{ table: 'data_keys', op: 'insert', key: { id: crypto.randomUUID() }, values: {} }]), '22023', 'tabela fora da lista');
    await rejects(apply([{ table: 'projects', op: 'update', key: { id: 'pA' }, expected_revision: 3, values: { owner_id: U.userB } }]), '42501', 'dono imutável');
  });
});

test('cifra: colunas sensíveis só aceitam envelope; campos sensíveis em claro no doc são recusados', async () => {
  const { seal } = require('../../src/crypto/envelope'); // o envelope gerado pelo app passa na validação do banco
  const real = seal({ name: 'Cliente Exemplo' }, { kid: crypto.randomUUID(), key: crypto.randomBytes(32) }, { table: 'projects', id: 'pA' });
  assert.equal((await rows('select gp.is_envelope($1::jsonb) as ok', [JSON.stringify(real)]))[0].ok, true);
  await as('userA', async () => {
    await rejects(apply([{ table: 'projects', op: 'insert', key: { id: 'pC' }, values: { owner_id: U.userA, created_by: U.userA, enc: { name: 'Cliente' } } }]), '23514', 'enc em claro');
    await rejects(apply([{ table: 'projects', op: 'insert', key: { id: 'pC' }, values: { owner_id: U.userA, created_by: U.userA, doc: { name: 'Cliente' } } }]), '23514', 'nome no doc');
    const bad = { ...envelope(), iv: b64(16) }; // IV de tamanho errado
    await rejects(apply([{ table: 'project_contacts', op: 'insert', key: { id: 'c2' }, values: { project_id: 'pA', enc: bad } }]), '23514', 'envelope inválido');
  });
});

test('configuração global: USO para todos os ativos, GESTÃO só com permissão', async () => {
  const ck = [{ table: 'checklists', op: 'insert', key: { id: 'ck-1' }, values: { doc: { name: 'Infra', stageId: 'st-1' } } }];
  await as('userA', () => rejects(apply(ck), '42501', 'A sem config.checklists.manage'));
  await as('master', () => rows("select public.admin_grant_permission($1, 'config.checklists.manage')", [U.userB]));
  await as('userB', () => apply(ck));
  await as('userA', async () => {
    assert.deepEqual((await rows('select id from public.checklists')).map((r) => r.id), ['ck-1'], 'A usa o checklist');
    await rejects(apply([{ table: 'checklists', op: 'update', key: { id: 'ck-1' }, expected_revision: 1, values: { doc: { name: 'X' } } }]), 'GP409', 'A não edita (linha fora do USING)');
  });
  await as('master', () => rows("select public.admin_revoke_permission($1, 'config.checklists.manage')", [U.userB]));
  await as('userB', () => rejects(apply([{ table: 'checklists', op: 'update', key: { id: 'ck-1' }, expected_revision: 1, values: { doc: { name: 'X' } } }]), 'GP409', 'revogado'));
});

test('anti-escalonamento: ADMIN não toca MASTER, não cria ADMIN, não concede permissão só-do-MASTER; ninguém muda o próprio papel', async () => {
  await as('admin', async () => {
    await rejects(rows("select public.admin_set_role($1, 'ADMIN')", [U.userA]), '42501', 'só MASTER altera papel');
    await rejects(rows("select public.admin_grant_permission($1, 'users.manage')", [U.userA]), '42501', 'master_only_grant');
    await rejects(rows("select public.admin_grant_permission($1, 'config.cycles.manage')", [U.userA]), '42501', 'ADMIN não concede o que não tem');
    await rejects(rows("select public.admin_set_status($1, 'suspended')", [U.master]), '42501', 'ADMIN não suspende MASTER');
    await rejects(rows("update public.profiles set role = 'MASTER' where id = $1", [U.admin]), '42501', 'sem grant na coluna role');
    await rows("select public.admin_grant_permission($1, 'projects.view_all')", [U.userA]); // ADMIN tem e concede
  });
  await as('userA', async () => {
    await rejects(rows("update public.profiles set status = 'active', role = 'ADMIN' where id = $1", [U.userA]), '42501');
    assert.equal((await rows("update public.profiles set display_name = 'A novo' where id = $1 returning display_name", [U.userA]))[0].display_name, 'A novo');
    assert.deepEqual(await rows('select id from public.profiles where id <> $1', [U.userA]), [], 'não lista outros usuários');
    assert.deepEqual(await projectIds(), ['pA', 'pB'], 'view_all concedido pelo ADMIN');
  });
  await as('admin', () => rows("select public.admin_revoke_permission($1, 'projects.view_all')", [U.userA]));
  await as('master', () => rejects(rows("select public.admin_set_role($1, 'ADMIN')", [U.userB]), '42501', 'exige senha recente'));
});

test('MASTER protegido: não é excluído, suspenso nem rebaixado; transferência exige outro MASTER e senha recente', async () => {
  await assert.rejects(rows('delete from public.profiles where id = $1', [U.master]), /não pode ser excluído/);
  await assert.rejects(rows("update public.profiles set role = 'ADMIN' where id = $1", [U.master]), /MASTER não pode perder/);
  await assert.rejects(rows('delete from auth.users where id = $1', [U.master]), /foreign key/);
  await as('master', async () => {
    await rejects(rows("select public.admin_set_status($1, 'suspended')", [U.master]), '42501', 'nem o próprio MASTER se suspende');
    await rejects(rows('select public.relinquish_master()'), '42501', 'sem senha recente');
  });
  await as('master', () => rejects(rows('select public.relinquish_master()'), '42501', 'sem outro MASTER'), { recentAuth: true });
  await as('master', () => rows('select public.grant_master($1)', [U.admin]), { recentAuth: true });
  await as('master', () => rows('select public.relinquish_master()'), { recentAuth: true });
  assert.equal((await rows('select role from public.profiles where id = $1', [U.master]))[0].role, 'ADMIN');
  // devolve (o novo MASTER concede e abre mão) — sempre ≥ 1 MASTER
  await as('admin', () => rows('select public.grant_master($1)', [U.master]), { recentAuth: true });
  await as('admin', () => rows('select public.relinquish_master()'), { recentAuth: true });
  assert.deepEqual((await rows("select id from public.profiles where role = 'MASTER'")).map((r) => r.id), [U.master]);
});

test('suspensão vale na hora (RLS confere status a cada consulta); reativação devolve o acesso', async () => {
  await as('master', () => rows("select public.admin_set_status($1, 'suspended')", [U.userA]));
  await as('userA', async () => {
    assert.deepEqual(await projectIds(), []);
    assert.deepEqual(await rows('select id from public.stages'), []);
    assert.equal((await rows('select public.my_profile() as p'))[0].p.status, 'suspended');
  });
  await as('master', () => rows("select public.admin_set_status($1, 'active')", [U.userA]));
  await as('userA', async () => assert.deepEqual(await projectIds(), ['pA']));
});

test('chaves de dados: nenhum cliente lê ou grava data_keys (nem o MASTER)', async () => {
  await rows("insert into public.data_keys (scope, kek_version, wrapped_key) values ('project:pA', 1, 'x')");
  for (const n of ['master', 'userA']) await as(n, () => rejects(rows('select * from public.data_keys'), '42501', n));
});

test('key_access: DEK de projeto só para quem lê o projeto; global só o MASTER cria; pendente/suspenso nada', async () => {
  const access = (scopes) => rows('select scope, can_read, can_create from public.key_access($1) order by scope', [scopes]);
  await as('userB', async () => assert.deepEqual(await access(['global', 'project:pA', 'project:pB', 'project:novo', 'outro']), [
    { scope: 'global', can_read: true, can_create: false },
    { scope: 'outro', can_read: false, can_create: false },
    { scope: 'project:novo', can_read: false, can_create: true },  // projeto ainda não existe e B tem projects.create
    { scope: 'project:pA', can_read: false, can_create: false },
    { scope: 'project:pB', can_read: true, can_create: true },
  ]));
  await as('master', async () => assert.deepEqual((await access(['global']))[0], { scope: 'global', can_read: true, can_create: true }));
  await as('pending', () => rejects(access(['global']), '42501', 'pendente'));
});

test('auditoria: append-only, sem valores sensíveis, visível só com audit.view', async () => {
  await as('userA', async () => {
    assert.deepEqual(await rows('select id from public.audit_events'), []);
    await rows("select public.log_event('email-copiado', 'project', 'pA', 'pA', '{\"campo\":\"to\"}'::jsonb)");
    await rejects(rows("select public.log_event('x', '', '', null, '{\"a\":{\"b\":1}}'::jsonb)"), '22023', 'só escalares');
    await rejects(rows("select public.log_event('x', '', '', 'pB', '{}'::jsonb)"), '42501', 'projeto sem acesso');
  });
  await as('master', async () => {
    const ev = await rows('select actor, action, details from public.audit_events order by id');
    const actions = ev.map((e) => e.action);
    for (const a of ['admin.master_bootstrap', 'admin.user_activated', 'projects.insert', 'project_members.insert', 'project_members.delete',
      'user_permissions.insert', 'user_permissions.delete', 'admin.user_suspended', 'admin.master_granted', 'app.email-copiado']) assert.ok(actions.includes(a), `${a} ausente; há: ${[...new Set(actions)].join(' ')}`);
    const upd = ev.find((e) => e.action === 'projects.update');
    assert.deepEqual(upd.details.fields, ['step_id']);
    const copied = ev.find((e) => e.action === 'app.email-copiado');
    assert.equal(copied.actor, U.userA, 'ator forçado = quem chamou');
    const text = JSON.stringify(ev);
    assert.ok(!/"ct"|"iv"|"tag"/.test(text), 'nada do envelope cifrado vai para a auditoria');
    await rejects(rows('delete from public.audit_events'), '42501');
  });
  await assert.rejects(rows('update public.audit_events set action = $1', ['x']), /somente inclusão/);
});

test('Storage: evidência só no projeto acessível; ninguém apaga', async () => {
  await as('userA', () => rows("insert into storage.objects (bucket_id, name) values ('evidence', 'pA/cy-1/ev1.bin')"));
  await as('userB', async () => {
    await rejects(rows("insert into storage.objects (bucket_id, name) values ('evidence', 'pA/cy-1/ev2.bin')"), '42501', 'B sem edição em pA');
    assert.deepEqual(await rows("select name from storage.objects where bucket_id = 'evidence'"), []);
  });
  await as('userA', async () => assert.deepEqual(await rows('delete from storage.objects returning name'), []));
  await as('master', async () => assert.equal((await rows("select name from storage.objects where bucket_id = 'evidence'")).length, 1));
});

test('rls-smoke.sql (roteiro para o Supabase real) roda limpo e não deixa rastro', async () => {
  for (const n of ['smokeA', 'smokeB']) {
    U[n] = (await rows("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`${n}@exemplo.test`]))[0].id;
  }
  const notices = [];
  const sql = fs.readFileSync(path.join(__dirname, 'rls-smoke.sql'), 'utf8')
    // troca as 3 atribuições (com marcador ou já preenchidas na cópia local de quem rodou no Supabase real)
    .replace(/(\bm uuid := )'[^']*'/, `$1'${U.master}'`).replace(/(\ba uuid := )'[^']*'/, `$1'${U.smokeA}'`)
    .replace(/(\bb uuid := )'[^']*'/, `$1'${U.smokeB}'`);
  await db.exec(sql, { onNotice: (n) => notices.push(n.message) });
  await db.exec('reset role');
  assert.ok(notices.includes('TODOS OS CASOS OK — a transação será desfeita (ROLLBACK).'), notices.join('\n'));
  assert.ok(!notices.some((m) => m.startsWith('FALHOU')));
  assert.deepEqual(await rows("select id from public.projects where id = 'smoke-pA'"), [], 'rollback');
  assert.equal((await rows('select status from public.profiles where id = $1', [U.smokeA]))[0].status, 'pending', 'rollback');
});

test('rollback DEV (down_all_DEV_ONLY.sql) remove tudo o que as migrations criaram', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const fresh = new PGlite();
  await fresh.exec(fs.readFileSync(path.join(__dirname, 'supabase-stub.sql'), 'utf8'));
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) await fresh.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  await fresh.exec(fs.readFileSync(path.join(__dirname, '..', 'rollback', 'down_all_DEV_ONLY.sql'), 'utf8'));
  const left = (await fresh.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`)).rows;
  assert.deepEqual(left, []);
  assert.deepEqual((await fresh.query("select 1 from pg_namespace where nspname = 'gp'")).rows, []);
  assert.deepEqual((await fresh.query("select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal")).rows, []);
  // e as migrations podem ser reaplicadas do zero depois
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) await fresh.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  await fresh.close();
});

test('toda tabela do schema public tem RLS ligado e anon não tem grant algum', async () => {
  const noRls = await rows("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
  assert.deepEqual(noRls, []);
  const anonGrants = await rows("select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'");
  assert.deepEqual(anonGrants, []);
  const anonExec = await rows(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'gp') and has_function_privilege('anon', p.oid, 'execute')`);
  assert.deepEqual(anonExec, []);
});
