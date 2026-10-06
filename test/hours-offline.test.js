// Fase 5 — horas por usuário e modo offline das horas, de ponta a ponta (servidor em modo nuvem + PGlite/RLS + Auth simulado).
// Cobre: marcador do último usuário protegido (DPAPI simulado); offline só sem conexão real; só rotas de horas; projetos de referência
// vindos do próprio histórico; nada chega à nuvem; outras alterações recusadas; horas isoladas por UUID; tudo continua ao reconectar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-hoff-'));
const PORT = 4463;
const TOKEN = 'b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6';
Object.assign(process.env, {
  PORT: String(PORT), GP_DATA_DIR: path.join(tmp, 'data'), GP_MODE: 'cloud', GP_LOCAL_DIR: path.join(tmp, 'local'), GP_LAUNCH_TOKEN: TOKEN,
  GP_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', GP_SUPABASE_PUBLISHABLE_KEY: 'pk_teste', GP_ENV: 'dev', // scan-secrets: allow
});
const { app, store, session } = require('../server');
const { createCloud } = require('./helpers/pglite-cloud');
const { FakeAuth } = require('./helpers/fake-auth');
const { Store } = require('../src/store');
const { CloudBackend } = require('../src/persistence/cloud-backend');
const { KeyService } = require('../src/persistence/keys');
const { LocalUserData } = require('../src/persistence/local-user-data');
const { fixture, CANARY } = require('./fixtures/cloud-fixture');

const base = `http://localhost:${PORT}`;
const PASS = 'Senha-Forte-2026';
let server; let cloud; let cookie = '';
const fake = new FakeAuth();
const U = {};
const dpapi = { protect: async (s) => `DPAPI:${Buffer.from(String(s)).toString('base64').split('').reverse().join('')}`, unprotect: async (b) => Buffer.from(String(b).slice(6).split('').reverse().join(''), 'base64').toString() };
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};
const login = (n, remember = false) => call('POST', '/api/auth/login', { email: `${n}@exemplo.test`, password: PASS, remember });
const hoursFile = (uid) => new LocalUserData(uid, path.join(tmp, 'local')).read('hours');
const auditCount = async () => (await cloud.sql('select count(*)::int n from public.audit_events'))[0].n;

test.before(async () => {
  cloud = await createCloud();
  U.master = await cloud.user('master', { master: true });
  U.b = await cloud.user('userb');
  await cloud.provision(U.master, U.b, { permissions: [] });
  fake.add('master@exemplo.test', U.master, { password: PASS });
  fake.add('userb@exemplo.test', U.b, { password: PASS });
  const t = cloud.transport(U.master);
  const seed = new Store(path.join(tmp, 'seed'));
  await seed.attach(new CloudBackend({ transport: t, keys: new KeyService((s, c) => t.fetchKeys(s, c)), local: new LocalUserData(U.master, path.join(tmp, 'seed-local')), userId: U.master }));
  seed._replace(fixture()); await seed.save();
  Object.assign(session, { gotrue: fake, transportFactory: ({ userId }) => cloud.transport(userId), ...dpapi });
  server = app.listen(PORT, '127.0.0.1');
  const r = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { server.close(); await cloud.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('sem ninguém ter entrado antes: não há modo offline', async () => {
  assert.equal((await call('GET', '/api/session')).json.offlineHours, null);
  const r = await call('POST', '/api/auth/offline-hours');
  assert.equal(r.status, 400); assert.equal(r.json.code, 'OFFLINE_UNAVAILABLE');
});

test('login registra o último usuário protegido (DPAPI); horas do MASTER ficam na pasta dele', async () => {
  assert.equal((await login('master')).json.status, 'active');
  const marker = fs.readFileSync(path.join(tmp, 'local', 'last-user.dpapi.json'), 'utf8');
  assert.ok(!marker.includes(U.master), 'UUID não fica em claro no marcador');
  const e = await call('POST', '/api/hours/entries', { projectId: 'p1', date: '2026-09-01', start: '08:00', end: '09:00', activity: 'Online no projeto' });
  assert.equal(e.status, 200, e.text);
  assert.deepEqual(hoursFile(U.master).timeEntries.map((x) => x.activity), ['Online no projeto'], 'na pasta do MASTER (por UUID) desta máquina');
  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/session')).json.offlineHours.available, true);
});

test('com conexão o modo offline é recusado (precisa entrar normalmente)', async () => {
  const r = await call('POST', '/api/auth/offline-hours');
  assert.equal(r.status, 409); assert.equal(r.json.code, 'ONLINE');
});

test('sem conexão: entra só nas horas; projetos de referência vêm do próprio histórico; nada chega à nuvem', async () => {
  fake.offline = true;
  assert.equal((await login('master')).json.code, 'OFFLINE');
  const r = await call('POST', '/api/auth/offline-hours');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'offline_hours'); assert.equal(r.json.user.offline, true);
  const before = await auditCount();
  const st = await call('GET', '/api/hours/state');
  assert.equal(st.status, 200);
  assert.deepEqual(store.data.projects.map((p) => [p.id, p.name]), [['p1', CANARY.projectName]], 'só id+nome já presentes no histórico de horas');
  const e = await call('POST', '/api/hours/entries', { projectId: 'p1', date: '2026-09-02', start: '08:00', end: '10:00', activity: 'Feito offline' });
  assert.equal(e.status, 200, e.text);
  assert.ok(hoursFile(U.master).timeEntries.some((x) => x.activity === 'Feito offline'));
  for (const [m, u] of [['GET', '/api/state'], ['GET', '/api/scripts'], ['POST', '/api/projects'], ['GET', '/api/audit']]) {
    const x = await call(m, u, m === 'POST' ? { name: 'x' } : undefined);
    assert.equal(x.status, 503, u); assert.equal(x.json.code, 'OFFLINE_MODE');
  }
  assert.equal(await auditCount(), before, 'nenhuma escrita na nuvem');
});

test('modo offline: alteração fora das horas é recusada e desfeita na memória (sem fila silenciosa)', async () => {
  store.data.stages.push({ id: 'st-x', name: 'Indevido', color: '#000000' });
  await assert.rejects(store.save(), (e) => { assert.equal(e.code, 'OFFLINE'); return true; });
  assert.ok(!store.data.stages.some((s) => s.id === 'st-x'));
});

test('reconectar: login normal traz projetos da nuvem e as horas feitas offline continuam lá', async () => {
  await call('POST', '/api/auth/logout');
  fake.offline = false;
  assert.equal((await login('master')).json.status, 'active');
  assert.equal((await call('GET', '/api/state')).json.projects[0].name, CANARY.projectName);
  const day = await call('GET', '/api/hours/day?date=2026-09-02');
  assert.ok(JSON.stringify(day.json).includes('Feito offline'));
});

test('horas isoladas por usuário: B não vê as do MASTER e grava na própria pasta (por UUID)', async () => {
  await call('POST', '/api/auth/logout');
  assert.equal((await login('userb')).json.status, 'active');
  const day = await call('GET', '/api/hours/day?date=2026-09-02');
  assert.ok(!JSON.stringify(day.json).includes('Feito offline'));
  assert.equal((await call('POST', '/api/hours/entries', { projectId: 'internal', date: '2026-09-02', start: '08:00', end: '09:00', activity: 'Do usuário B' })).status, 200);
  assert.ok(hoursFile(U.b).timeEntries.some((x) => x.activity === 'Do usuário B'));
  assert.ok(!hoursFile(U.master).timeEntries.some((x) => x.activity === 'Do usuário B'));
});

test('sair do modo offline não apaga o "manter conectado" guardado', async () => {
  await call('POST', '/api/auth/logout');
  assert.equal((await login('master', true)).json.status, 'active');
  const file = path.join(tmp, 'local', 'session.dpapi.json');
  assert.ok(fs.existsSync(file));
  await session._end(null); // como se o app tivesse fechado e reaberto sem rede
  fake.offline = true;
  assert.equal((await call('POST', '/api/auth/offline-hours')).json.status, 'offline_hours');
  await call('POST', '/api/auth/logout');
  assert.ok(fs.existsSync(file), 'sessão guardada continua para quando a conexão voltar');
  fake.offline = false;
});
