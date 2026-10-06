// Fase 4 — login e sessão de ponta a ponta: servidor real em MODO NUVEM + banco real (PGlite, migrations e RLS) + Auth simulado.
// Cobre: cookie de inicialização, nada carregado antes do login, login/erro genérico, MASTER/pendente/suspenso/banido,
// primeiro acesso por código, recuperação de senha, "manter conectado" (DPAPI simulado), expiração/revogação, logout limpo,
// troca de usuário sem sobra de dados, tokens nunca na resposta, identidade nos registros, auditoria local por usuário.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-auth-'));
const PORT = 4459;
const TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
Object.assign(process.env, {
  PORT: String(PORT), GP_DATA_DIR: path.join(tmp, 'data'), GP_MODE: 'cloud', GP_LOCAL_DIR: path.join(tmp, 'local'), GP_LAUNCH_TOKEN: TOKEN,
  GP_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', GP_SUPABASE_PUBLISHABLE_KEY: 'pk_teste', GP_ENV: 'dev', // scan-secrets: allow
});
// dado LOCAL plantado na pasta de dados: no modo nuvem ele NUNCA pode aparecer (nem antes nem depois do login)
fs.mkdirSync(process.env.GP_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects: [{ id: 'local1', name: 'DADO_LOCAL_NAO_PODE_APARECER' }] }));

const { app, store, session } = require('../server');
const { createCloud } = require('./helpers/pglite-cloud');
const { FakeAuth } = require('./helpers/fake-auth');
const { Store } = require('../src/store');
const { CloudBackend } = require('../src/persistence/cloud-backend');
const { KeyService } = require('../src/persistence/keys');
const { LocalUserData } = require('../src/persistence/local-user-data');
const { CloudSession } = require('../src/auth/session');
const { fixture, CANARY } = require('./fixtures/cloud-fixture');

const base = `http://localhost:${PORT}`;
const PASS = 'Senha-Forte-2026';
let server;
let cloud;
let cookie = '';
const fake = new FakeAuth();
const U = {};
const dpapi = { protect: async (s) => `DPAPI:${Buffer.from(String(s)).toString('base64').split('').reverse().join('')}`, unprotect: async (b) => Buffer.from(String(b).slice(6).split('').reverse().join(''), 'base64').toString() };

const call = async (method, url, body, { withCookie = true } = {}) => {
  const r = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: base, ...(withCookie && cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text, headers: r.headers };
};
const login = (email, remember = false, password = PASS) => call('POST', '/api/auth/login', { email, password, remember });

test.before(async () => {
  cloud = await createCloud();
  U.master = await cloud.user('master', { master: true });
  for (const n of ['viewer', 'pendente', 'suspenso', 'banido']) U[n] = await cloud.user(n);
  await cloud.provision(U.master, U.viewer, { permissions: [] });
  await cloud.provision(U.master, U.suspenso, { permissions: [] });
  await cloud.sqlAs(U.master, "select public.admin_set_status($1, 'suspended')", [U.suspenso]);
  U.convidado = (await cloud.sql("insert into auth.users (email, invited_at) values ('convidado@exemplo.test', now()) returning id"))[0].id;
  for (const n of ['master', 'viewer', 'pendente', 'suspenso', 'banido']) fake.add(`${n}@exemplo.test`, U[n], { password: PASS, banned: n === 'banido' });
  fake.add('convidado@exemplo.test', U.convidado, { confirmed: false });
  fake.invite('convidado@exemplo.test', '135790');
  // dados na nuvem carregados pelo MASTER (como a migração fará) — fora do servidor
  const t = cloud.transport(U.master);
  const seed = new Store(path.join(tmp, 'seed'));
  await seed.attach(new CloudBackend({ transport: t, keys: new KeyService((s, c) => t.fetchKeys(s, c)), local: new LocalUserData(U.master, path.join(tmp, 'seed-local')), userId: U.master }));
  seed._replace(fixture()); await seed.save();
  await cloud.sqlAs(U.master, "select public.project_set_access('p1', $1, 'viewer')", [U.viewer]);
  Object.assign(session, { gotrue: fake, transportFactory: ({ userId }) => cloud.transport(userId), ...dpapi });
  server = app.listen(PORT, '127.0.0.1');
});
test.after(async () => { server.close(); await cloud.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('cookie de inicialização: sem ele a API não atende; token errado é recusado; token certo entrega cookie HttpOnly/SameSite=Strict', async () => {
  assert.equal((await call('GET', '/api/session', undefined, { withCookie: false })).json.code, 'LAUNCH_REQUIRED');
  assert.equal((await call('GET', '/?k=errado', undefined, { withCookie: false })).status, 403);
  const r = await call('GET', `/?k=${TOKEN}`, undefined, { withCookie: false });
  assert.equal(r.status, 302);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  assert.equal((await call('GET', '/index.html')).status, 200, 'tela (estáticos) carrega para mostrar o login');
});

test('antes do login: nenhum dado (nem o local plantado); toda rota de dados responde 401 AUTH_REQUIRED', async () => {
  const s = await call('GET', '/api/session');
  assert.deepEqual([s.json.mode, s.json.status, s.json.user], ['cloud', 'signed_out', null]);
  for (const url of ['/api/state', '/api/hours/state', '/api/scripts', '/api/audit']) {
    const r = await call('GET', url);
    assert.equal(r.status, 401, url); assert.equal(r.json.code, 'AUTH_REQUIRED');
  }
  assert.deepEqual(store.data.projects, []);
  assert.ok(!JSON.stringify(store.data).includes('DADO_LOCAL'));
});

test('login errado: mensagem genérica igual para senha errada e e-mail inexistente; nada registrado com a senha', async () => {
  const a = await login('master@exemplo.test', false, 'Errada-123456!');
  const b = await login('ninguem@exemplo.test');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.json.error, b.json.error); assert.equal(a.json.code, 'INVALID_CREDENTIALS');
  const logs = fs.readFileSync(path.join(tmp, 'local', 'logs', 'audit.log'), 'utf8');
  assert.ok(!logs.includes('Errada-123456') && !logs.includes('@exemplo.test'), 'auditoria sem senha nem e-mail');
});

test('MASTER entra: dados da nuvem decifrados; a resposta nunca traz tokens; dado local plantado continua fora', async () => {
  const r = await login('master@exemplo.test');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'active'); assert.equal(r.json.user.role, 'MASTER');
  assert.ok(!/acc_|ref_|accessToken|refreshToken/.test(r.text), 'tokens nunca saem do processo local');
  const st = (await call('GET', '/api/state')).json;
  assert.deepEqual(st.projects.map((p) => p.name), [CANARY.projectName]);
  assert.ok(!JSON.stringify(st).includes('DADO_LOCAL'));
});

test('identidade: "feito por" = nome de exibição do usuário logado; auditoria local vai para a pasta do usuário (sem e-mail)', async () => {
  await cloud.sql("update public.profiles set display_name = 'Usuário Master' where id = $1", [U.master]);
  await login('master@exemplo.test'); // relê o perfil
  const r = await call('PUT', '/api/projects/p1/checklists/cy-1/items/ii-1', { done: false });
  assert.equal(r.status, 200, r.text);
  const r2 = await call('PUT', '/api/projects/p1/checklists/cy-1/items/ii-1/note', { text: 'nota do master' });
  assert.equal(r2.status, 200, r2.text);
  const item = store.project('p1').checklists.find((c) => c.stepId === 'cy-1').items.find((i) => i.id === 'ii-1');
  assert.equal(item.note.updatedBy, 'Usuário Master');
  const userLog = path.join(tmp, 'local', 'users', U.master, 'audit.log');
  assert.ok(fs.existsSync(userLog));
  assert.ok(!fs.readFileSync(userLog, 'utf8').includes('@exemplo.test'));
});

test('logout: revoga no Auth, esvazia memória e chaves; rotas voltam a 401', async () => {
  const keysBefore = store.backend.keys.ring.byKid.size;
  assert.ok(keysBefore > 0);
  const ring = store.backend.keys.ring;
  const r = await call('POST', '/api/auth/logout');
  assert.equal(r.json.status, 'signed_out');
  assert.ok(fake.revoked.length >= 1);
  assert.equal(ring.byKid.size, 0, 'DEKs zeradas');
  assert.deepEqual(store.data.projects, []);
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('PUT', '/api/projects/p1/checklists/cy-1/items/ii-1', { done: true })).status, 401);
});

test('pendente (autenticado, não provisionado): só a tela de espera (403 ACCOUNT_PENDING); liberado pelo MASTER → "Verificar novamente" entra', async () => {
  const r = await login('pendente@exemplo.test');
  assert.equal(r.json.status, 'pending'); assert.match(r.json.message, /aguardando configuração/);
  const st = await call('GET', '/api/state');
  assert.equal(st.status, 403); assert.equal(st.json.code, 'ACCOUNT_PENDING');
  assert.deepEqual(store.data.projects, []);
  await cloud.provision(U.master, U.pendente, { permissions: [] });
  const c = await call('POST', '/api/auth/check');
  assert.equal(c.json.status, 'active');
  assert.deepEqual((await call('GET', '/api/state')).json.projects, [], 'ativo, mas sem projeto compartilhado');
});

test('troca de usuário sem sair: nada do anterior fica (viewer vê só o compartilhado e não grava)', async () => {
  const r = await login('viewer@exemplo.test');
  assert.equal(r.json.status, 'active');
  const st = (await call('GET', '/api/state')).json;
  assert.deepEqual(st.projects.map((p) => p.id), ['p1']);
  const w = await call('PUT', '/api/projects/p1/checklists/cy-1/items/ii-1', { done: true });
  assert.equal(w.status, 403); assert.equal(w.json.code, 'FORBIDDEN');
});

test('suspenso (no app) e banido (no Auth) não entram', async () => {
  const s = await login('suspenso@exemplo.test');
  assert.equal(s.status, 403); assert.equal(s.json.code, 'SUSPENDED');
  assert.equal((await call('GET', '/api/session')).json.status, 'signed_out');
  const b = await login('banido@exemplo.test');
  assert.equal(b.status, 403); assert.equal(b.json.code, 'SUSPENDED');
});

test('primeiro acesso: código do convite + senha forte definida pelo próprio usuário (senha fraca recusada)', async () => {
  const weak = await call('POST', '/api/auth/first-access', { email: 'convidado@exemplo.test', code: '135790', password: '123' });
  assert.equal(weak.status, 400); assert.equal(weak.json.code, 'WEAK_PASSWORD');
  const bad = await call('POST', '/api/auth/first-access', { email: 'convidado@exemplo.test', code: '000000', password: 'Minha-Senha-2026' });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'INVALID_CODE');
  const ok = await call('POST', '/api/auth/first-access', { email: 'convidado@exemplo.test', code: '135790', password: 'Minha-Senha-2026' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'pending', 'convite aceito, aguardando provisionamento');
  assert.equal(fake.users.get('convidado@exemplo.test').password, 'Minha-Senha-2026');
  await call('POST', '/api/auth/logout');
});

test('esqueci a senha: resposta igual para e-mail existente ou não; código + nova senha entra', async () => {
  const a = await call('POST', '/api/auth/recover-request', { email: 'viewer@exemplo.test' });
  const b = await call('POST', '/api/auth/recover-request', { email: 'ninguem@exemplo.test' });
  assert.deepEqual(a.json, b.json);
  const r = await call('POST', '/api/auth/recover', { email: 'viewer@exemplo.test', code: '246810', password: 'Outra-Senha-2026' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'active');
  assert.equal((await login('viewer@exemplo.test', false, PASS)).status, 401, 'senha antiga não vale mais');
});

test('"manter conectado": refresh token só protegido (DPAPI) em disco; nova inicialização entra sozinha; sem a opção, nada é gravado', async () => {
  const file = path.join(tmp, 'local', 'session.dpapi.json');
  await login('master@exemplo.test', false);
  assert.ok(!fs.existsSync(file), 'sem "manter conectado" nada fica em disco');
  await login('master@exemplo.test', true);
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /"refreshEnc":"DPAPI:/);
  assert.ok(!/ref_[0-9a-f-]+_\d+/.test(saved), 'refresh token nunca em claro');
  // "reinicia" o app: nova sessão, novo Store, mesmo arquivo
  const store2 = new Store(path.join(tmp, 'data2'), { backend: new (require('../src/persistence/signed-out-backend').SignedOutBackend)() });
  const audit2 = new (require('../src/audit').Audit)(path.join(tmp, 'logs2'));
  const s2 = new CloudSession({ cfg: { env: 'dev', appVersion: 'x' }, store: store2, audit: audit2, gotrue: fake, transportFactory: ({ userId }) => cloud.transport(userId), ...dpapi, root: path.join(tmp, 'local') });
  assert.equal(await s2.restore(), true);
  assert.equal(s2.status, 'active');
  assert.equal(store2.project('p1').name, CANARY.projectName);
  await s2.logout();
  assert.ok(!fs.existsSync(file), 'sair apaga a sessão guardada');
});

test('sessão expira: renova sozinha antes de vencer; refresh revogado → sessão encerrada e dados fora da memória', async () => {
  await login('master@exemplo.test');
  const first = session.tokens.accessToken;
  session.tokens.expiresAt = Date.now() + 1000; // dentro da margem: o próximo pedido de token renova (o SupabaseRest pede a cada chamada)
  await session.getAccessToken();
  assert.equal((await call('GET', '/api/state')).status, 200);
  assert.notEqual(session.tokens.accessToken, first, 'renovou');
  fake.refreshTokens.clear(); // revogado no servidor (ex.: senha trocada em outro lugar)
  session.tokens.expiresAt = Date.now() + 1000;
  await session.getAccessToken();
  assert.equal(session.status, 'signed_out');
  const r = await call('GET', '/api/state');
  assert.equal(r.status, 401); assert.match(r.json.error, /expirou/);
  assert.deepEqual(store.data.projects, []);
});

test('falha ao carregar os dados depois do login encerra a sessão (nada de sessão "meio aberta")', async () => {
  const real = session.transportFactory;
  const { DataError } = require('../src/persistence/errors');
  session.transportFactory = (o) => { const t = real(o); return { ...t, rpc: t.rpc, fetchKeys: t.fetchKeys, selectAll: async () => { throw new DataError('OFFLINE', 'sem conexão'); } }; };
  const r = await login('master@exemplo.test');
  session.transportFactory = real;
  assert.equal(r.status, 503);
  assert.equal(session.tokens, null);
  assert.equal((await call('GET', '/api/session')).json.status, 'signed_out');
  assert.equal((await call('GET', '/api/state')).json.code, 'AUTH_REQUIRED', 'pede login de novo (não "aguardando liberação")');
});

test('sem rede no login: 503 claro e nada muda', async () => {
  fake.offline = true;
  const r = await login('master@exemplo.test');
  fake.offline = false;
  assert.equal(r.status, 503); assert.equal(r.json.code, 'OFFLINE');
  assert.equal((await call('GET', '/api/session')).json.status, 'signed_out');
});
