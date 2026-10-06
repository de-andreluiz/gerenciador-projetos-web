// CloudBackend + Store de ponta a ponta contra Postgres real (PGlite) com as migrations e o RLS de produção.
// Cobre: carga inicial (como a migração fará), cifra em repouso, vínculos/segredos/horas só locais, segunda máquina, concorrência,
// permissão (viewer / sem acesso / config), atomicidade, offline sem perda, arquivamento, recarga, fail-closed da cifra.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCloud } = require('./helpers/pglite-cloud');
const { Store } = require('../src/store');
const { CloudBackend } = require('../src/persistence/cloud-backend');
const { KeyService } = require('../src/persistence/keys');
const { LocalUserData } = require('../src/persistence/local-user-data');
const M = require('../src/persistence/mapping');
const { fixture, CANARY, PATHS, DPAPI } = require('./fixtures/cloud-fixture');
const { applyDefaults } = require('../src/defaults');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cloud-'));
let cloud;
const U = {};
const empty = () => ({ settings: {}, projects: [] });

// Uma "máquina" = pasta local própria + Store ligado à nuvem como `uid`.
async function machine(name, uid, state) {
  const transport = cloud.transport(uid, state);
  const backend = new CloudBackend({ transport, keys: new KeyService((s, c) => transport.fetchKeys(s, c)), local: new LocalUserData(uid, path.join(tmp, name)), userId: uid });
  const store = new Store(path.join(tmp, name, 'data-local')); // começa no backend local vazio (como o app antes do login)
  await store.attach(backend);
  return { store, backend, transport };
}
const expectHttp = async (p, status, code) => assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); assert.equal(e.code, code); return true; });
const withoutDropped = (d) => { const x = JSON.parse(JSON.stringify(d)); for (const k of M.DROPPED) delete x[k]; return x; };

test.before(async () => {
  cloud = await createCloud();
  U.master = await cloud.user('master', { master: true });
  for (const n of ['userA', 'userB', 'pending']) U[n] = await cloud.user(n);
  await cloud.provision(U.master, U.userA);
  await cloud.provision(U.master, U.userB);
});
test.after(async () => { await cloud.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const S = {};

test('MASTER envia o estado completo (como a migração fará): tudo inserido num lote; reler devolve o mesmo estado', async () => {
  S.m1 = await machine('m1', U.master);
  S.m1.store._replace(fixture());
  await S.m1.store.save();
  assert.equal(S.m1.backend.hasPendingChanges(S.m1.store.data), false);
  const again = await machine('m1', U.master); // mesma máquina (mesma pasta local)
  // compara com o mesmo estado depois dos defaults de carga (applyDefaults roda em toda carga, local ou nuvem)
  assert.equal(M.canonical(again.store.data), M.canonical(applyDefaults(withoutDropped(fixture()))));
});

test('no banco só há ciphertext nos campos sensíveis; nenhum caminho, senha DPAPI ou hora vai para a nuvem', async () => {
  const dump = JSON.stringify(await cloud.sql(`select json_agg(t) from (
    select 'projects' t, doc, enc from public.projects union all select 'pc', doc, enc from public.project_checklists
    union all select 'ct', null, enc from public.project_contacts union all select 'pe', null, enc from public.people
    union all select 'cx', doc, enc from public.connections union all select 'et', doc, enc from public.email_templates
    union all select 'eg', doc, enc from public.email_generations union all select 'doc', doc, null from public.documents) t`));
  for (const [k, v] of Object.entries(CANARY)) assert.ok(!dump.includes(v), `canário ${k} em claro no banco`);
  assert.ok(!dump.includes('SENSIVEL'));
  for (const p of Object.values(PATHS)) assert.ok(!dump.includes(p.replace(/\\/g, '\\\\')), `caminho ${p} no banco`);
  assert.ok(!dump.includes(DPAPI));
  const counts = (await cloud.sql(`select (select count(*) from public.projects)::int p, (select count(*) from public.project_checklists)::int c,
    (select count(*) from public.project_contacts)::int ct, (select count(*) from public.checklist_items)::int it, (select count(*) from public.app_settings)::int s`))[0];
  assert.deepEqual(counts, { p: 1, c: 2, ct: 2, it: 2, s: 3 }); // settings: warnDays, defaultConnectionId + defaultCycleId
  const owner = (await cloud.sql('select owner_id from public.projects'))[0].owner_id;
  assert.equal(owner, U.master, 'projetos existentes ficam com o UUID do MASTER (nunca username)');
  // local: horas, vínculos e senhas só na pasta do usuário
  const ld = new LocalUserData(U.master, path.join(tmp, 'm1'));
  assert.equal(ld.read('hours').timeEntries.length, 1);
  assert.equal(ld.read('secrets').lists.connections.cx1.passwordEnc.$v, DPAPI);
  assert.equal(ld.read('bindings').projects.p1.rootDir.$v, PATHS.root);
});

test('segunda máquina do mesmo usuário: mesmos projetos decifrados; sem caminhos, senhas e horas da outra máquina', async () => {
  S.m2 = await machine('m2', U.master);
  const p = S.m2.store.data.projects[0];
  assert.equal(p.name, CANARY.projectName);
  assert.equal(p.contacts[0].email, CANARY.contactEmail);
  assert.equal(p.checklists.find((c) => c.stepId === 'cy-1').items[0].note.text, CANARY.note);
  assert.equal(p.rootDir, undefined, 'pasta raiz é configurada por máquina');
  assert.equal(p.bases[1].prod.passwordEnc, undefined, 'senha não viaja entre máquinas');
  assert.equal(S.m2.store.data.connections[0].passwordEnc, undefined);
  assert.deepEqual(S.m2.store.data.timeEntries, [], 'horas da máquina A não aparecem na máquina B');
});

test('concorrência: duas máquinas editam o mesmo projeto → a segunda recebe 409 STALE_DATA e vê o valor gravado', async () => {
  S.m1.store.project('p1').description = 'Versão da máquina 1';
  await S.m1.store.save();
  S.m2.store.project('p1').description = 'Versão da máquina 2';
  await expectHttp(S.m2.store.save(), 409, 'STALE_DATA');
  assert.equal(S.m2.store.project('p1').description, 'Versão da máquina 1', 'memória recarregada do que está confirmado');
  S.m2.store.project('p1').description = 'Agora sim';
  await S.m2.store.save();
});

test('sem acesso: usuário A não vê o projeto, mas usa a configuração global (pessoas decifradas)', async () => {
  S.a = await machine('a', U.userA);
  assert.deepEqual(S.a.store.data.projects, []);
  assert.equal(S.a.store.data.coordinators[0].email, CANARY.personEmail);
  assert.equal(S.a.store.data.stages.length, 2);
});

test('viewer lê mas não grava: 403 FORBIDDEN e nada muda; configuração global sem permissão também é recusada', async () => {
  await cloud.sqlAs(U.master, "select public.project_set_access('p1', $1, 'viewer')", [U.userB]);
  S.b = await machine('b', U.userB);
  assert.equal(S.b.store.project('p1').name, CANARY.projectName);
  S.b.store.project('p1').name = 'tentativa';
  await expectHttp(S.b.store.save(), 403, 'FORBIDDEN');
  assert.equal(S.b.store.project('p1').name, CANARY.projectName, 'alteração recusada não fica na memória');
  S.b.store.data.stages[0].name = 'Estágio alterado';
  await expectHttp(S.b.store.save(), 403, 'FORBIDDEN');
  assert.equal(S.b.store.data.stages[0].name, 'Homologação');
});

test('atomicidade: lote com uma alteração proibida não grava nem as permitidas', async () => {
  S.a.store.data.projects.push({ id: 'pa1', name: 'SENSIVEL_Projeto A', description: '', createdAt: '2026-10-05T00:00:00.000Z', rootDirKind: 'local', rootDir: 'C:\\A',
    coordinatorId: null, analystId: null, projectTypeId: null, originSystemId: null, defaultConnectionId: null, cycleId: 'cyc-1', cycleVersion: 2, steps: [], stepId: null,
    stageHistory: [], bases: [], deparas: [], milestones: [], corrections: [], checklists: [], contacts: [], emailTemplateIds: null });
  S.a.store.data.stages[0].name = 'Proibido para A';
  await expectHttp(S.a.store.save(), 403, 'FORBIDDEN');
  assert.deepEqual(await cloud.sql("select id from public.projects where id = 'pa1'"), [], 'projeto novo não foi gravado');
  assert.deepEqual(S.a.store.data.projects, [], 'memória voltou ao confirmado');
});

test('usuário A cria o próprio projeto (dono = A, DEK do projeto criada) e o MASTER enxerga', async () => {
  S.a.store.data.projects.push({ id: 'pa1', name: 'SENSIVEL_Projeto A', description: '', createdAt: '2026-10-05T00:00:00.000Z', rootDirKind: 'local', rootDir: 'C:\\A',
    coordinatorId: null, analystId: null, projectTypeId: null, originSystemId: null, defaultConnectionId: null, cycleId: 'cyc-1', cycleVersion: 2, steps: [], stepId: null,
    stageHistory: [], bases: [], deparas: [], milestones: [], corrections: [], checklists: [], contacts: [], emailTemplateIds: null });
  await S.a.store.save();
  assert.equal((await cloud.sql("select owner_id from public.projects where id = 'pa1'"))[0].owner_id, U.userA);
  assert.ok(cloud.keys.has('project:pa1'));
  assert.equal(await S.m1.store.refresh(), true);
  assert.ok(S.m1.store.project('pa1'));
  assert.equal(S.m1.store.project('pa1').rootDir, undefined, 'caminho da máquina de A não aparece para o MASTER');
});

test('excluir projeto no app = arquivar na nuvem (nunca apagar)', async () => {
  S.a.store.data.projects = S.a.store.data.projects.filter((p) => p.id !== 'pa1');
  await S.a.store.save();
  const row = (await cloud.sql("select archived_at, archived_by from public.projects where id = 'pa1'"))[0];
  assert.ok(row.archived_at); assert.equal(row.archived_by, U.userA);
  const fresh = await machine('a2', U.userA);
  assert.deepEqual(fresh.store.data.projects, []);
});

test('offline: nada é perdido em silêncio — 503 OFFLINE, memória volta ao confirmado; reconectado, grava normal', async () => {
  const before = S.m1.store.project('p1').description;
  S.m1.transport.state.offline = true;
  S.m1.store.project('p1').description = 'feito sem rede';
  await expectHttp(S.m1.store.save(), 503, 'OFFLINE');
  assert.equal(S.m1.store.project('p1').description, before);
  S.m1.transport.state.offline = false;
  S.m1.store.project('p1').description = 'feito com rede';
  await S.m1.store.save();
  assert.equal((await machine('m3', U.master)).store.project('p1').description, 'feito com rede');
});

test('horas e Workspace: gravados só localmente (nenhuma escrita na nuvem)', async () => {
  const auditBefore = (await cloud.sql('select count(*)::int n from public.audit_events'))[0].n;
  S.m1.store.data.timeEntries.push({ id: 'te2', projectId: 'p1', projectName: 'x', date: '2026-10-05', startMin: 600, endMin: 660, pausedMin: 0, activity: 'y', note: '' });
  S.m1.store.data.workspace.root = 'C:\\OutroWorkspace';
  await S.m1.store.save();
  assert.equal((await cloud.sql('select count(*)::int n from public.audit_events'))[0].n, auditBefore, 'nenhuma alteração chegou à nuvem');
  const ld = new LocalUserData(U.master, path.join(tmp, 'm1'));
  assert.equal(ld.read('hours').timeEntries.length, 2);
  assert.equal(ld.read('prefs').workspace.root, 'C:\\OutroWorkspace');
});

test('recarga não atropela alteração ainda não gravada; gravação pedida antes de uma recarga é recusada (sem sucesso falso)', async () => {
  assert.equal(await S.m2.store.refresh(), true); // atualiza (a máquina 1 alterou o projeto)
  S.m2.store.project('p1').milestones[0].done = true; // pendente (não salvo)
  assert.equal(await S.m2.store.refresh(), false);
  assert.equal(S.m2.store.project('p1').milestones[0].done, true);
  await S.m2.store.save();
  // save enfileirado antes de uma recuperação (falha de outra gravação) → 409 em vez de "salvo"
  S.m2.transport.state.offline = true;
  S.m2.store.project('p1').description = 'x1';
  const p1 = S.m2.store.save();
  S.m2.store.project('p1').description = 'x2';
  const p2 = S.m2.store.save();
  await expectHttp(p1, 503, 'OFFLINE');
  await expectHttp(p2, 409, 'STALE_DATA');
  S.m2.transport.state.offline = false;
});

test('pendente (sem provisionamento) não carrega nada', async () => {
  const p = await machine('pend', U.pending);
  assert.deepEqual(p.store.data.projects, []);
  assert.deepEqual(p.store.data.stages, []);
  assert.deepEqual(p.store.data.coordinators, []);
});

test('fail closed: ciphertext adulterado no banco bloqueia a carga (nunca vira dado vazio em silêncio)', async () => {
  await cloud.sql("update public.people set enc = jsonb_set(enc, '{ct}', to_jsonb('AAAA'::text))");
  await assert.rejects(machine('tamper', U.master), (e) => { assert.equal(e.code, 'CRYPTO'); return true; });
});

test('logout: detach zera chaves e estado em memória', async () => {
  const ring = S.m1.backend.keys.ring;
  const someKey = [...ring.byKid.values()][0];
  await S.m1.store.detach();
  assert.deepEqual(S.m1.store.data.projects, []);
  assert.ok(someKey.every((b) => b === 0), 'DEK zerada');
  assert.equal(ring.byKid.size, 0);
});
