// API do app com o Store ligado à NUVEM (PGlite + migrations reais): as rotas de sempre, gravando por apply_changes com RLS.
// Confere que o contrato da tela continua: dados decifrados no /api/state, erros com `code` (FORBIDDEN 403, OFFLINE 503),
// caminho de disco só no vínculo local, horas funcionando mesmo sem rede.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cloudapi-'));
const PORT = 4457;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app, store } = require('../server');
const { createCloud } = require('./helpers/pglite-cloud');
const { CloudBackend } = require('../src/persistence/cloud-backend');
const { KeyService } = require('../src/persistence/keys');
const { LocalUserData } = require('../src/persistence/local-user-data');
const { fixture, CANARY } = require('./fixtures/cloud-fixture');

let server;
let cloud;
const U = {};
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const backendFor = (uid, state) => {
  const transport = cloud.transport(uid, state);
  return new CloudBackend({ transport, keys: new KeyService((s, c) => transport.fetchKeys(s, c)), local: new LocalUserData(uid, path.join(tmp, 'local')), userId: uid });
};

test.before(async () => {
  cloud = await createCloud();
  U.master = await cloud.user('master', { master: true });
  U.viewer = await cloud.user('viewer');
  await cloud.provision(U.master, U.viewer, { permissions: [] });
  server = app.listen(PORT, '127.0.0.1');
  // carga inicial pelo MASTER (como a migração fará) e "login" do MASTER
  await store.attach(backendFor(U.master));
  store._replace(fixture());
  await store.save();
  await cloud.sqlAs(U.master, "select public.project_set_access('p1', $1, 'viewer')", [U.viewer]);
});
test.after(async () => { server.close(); await cloud.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('MASTER: /api/state traz os projetos decifrados; editar pelo app grava cifrado e o caminho fica só local', async () => {
  const st = (await api('GET', '/api/state')).json;
  assert.equal(st.projects[0].name, CANARY.projectName);
  const r = await api('PUT', '/api/projects/p1', { name: 'Nome Editado Pela Tela', description: 'x', rootDirKind: 'local', rootDir: 'C:\\NovaPasta' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = (await cloud.sql("select doc::text d, enc::text e from public.projects where id = 'p1'"))[0];
  assert.ok(!row.d.includes('Nome Editado') && !row.e.includes('Nome Editado'), 'nome só cifrado');
  assert.ok(!row.d.includes('NovaPasta') && !row.e.includes('NovaPasta'), 'caminho nunca vai à nuvem');
  assert.equal(new LocalUserData(U.master, path.join(tmp, 'local')).read('bindings').projects.p1.rootDir.$v, 'C:\\NovaPasta');
});

test('MASTER: configuração global e checklist pelas rotas de sempre', async () => {
  assert.equal((await api('POST', '/api/stages', { name: 'Estágio novo', color: '#123456' })).status, 200);
  assert.equal((await cloud.sql("select count(*)::int n from public.stages where doc->>'name' = 'Estágio novo'"))[0].n, 1);
  const r = await api('PUT', '/api/projects/p1/checklists/cy-1/items/ii-1', { done: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const doc = (await cloud.sql("select doc from public.project_checklists where project_id = 'p1' and step_id = 'cy-1'"))[0].doc;
  assert.equal(doc.items[0].done, false);
  assert.ok(!JSON.stringify(doc).includes(CANARY.note), 'observação do item continua só cifrada');
});

test('viewer logado no mesmo app: lê, mas alterar devolve 403 FORBIDDEN com mensagem clara; nada muda', async () => {
  await store.attach(backendFor(U.viewer));
  const st = (await api('GET', '/api/state')).json;
  assert.deepEqual(st.projects.map((p) => p.id), ['p1']);
  const r = await api('PUT', '/api/projects/p1', { name: 'Hack', description: '', rootDirKind: 'local', rootDir: '' });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'FORBIDDEN'); assert.match(r.json.error, /permissão/);
  assert.equal((await api('GET', '/api/state')).json.projects[0].name, 'Nome Editado Pela Tela');
  const s = await api('POST', '/api/stages', { name: 'Proibido', color: '#000000' });
  assert.equal(s.status, 403); assert.equal(s.json.code, 'FORBIDDEN');
});

test('sem rede: alteração na nuvem devolve 503 OFFLINE; controle de horas continua funcionando (é local)', async () => {
  const state = { offline: false };
  await store.attach(backendFor(U.master, state));
  state.offline = true;
  const r = await api('PUT', '/api/projects/p1', { name: 'Offline', description: '', rootDirKind: 'local', rootDir: '' });
  assert.equal(r.status, 503); assert.equal(r.json.code, 'OFFLINE');
  const h = await api('POST', '/api/hours/entries', { projectId: 'internal', date: '2026-09-01', start: '08:00', end: '09:00', activity: 'Reunião interna' });
  assert.equal(h.status, 200, JSON.stringify(h.json));
  assert.ok(new LocalUserData(U.master, path.join(tmp, 'local')).read('hours').timeEntries.some((e) => e.activity === 'Reunião interna'));
  state.offline = false;
  assert.equal((await api('GET', '/api/state')).json.projects[0].name, 'Nome Editado Pela Tela');
});
