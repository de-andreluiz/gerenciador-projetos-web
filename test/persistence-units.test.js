// Peças da camada de persistência sem rede: transporte HTTP do Supabase (fetch simulado), dados locais por usuário,
// fonte única de permissões (bate com a migration) e fachada Store no modo local.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SupabaseRest } = require('../src/persistence/supabase-rest');
const { LocalUserData } = require('../src/persistence/local-user-data');
const { PERMISSIONS, can, ROLES } = require('../src/auth/permissions');
const { Store } = require('../src/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-punits-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const URL_ = 'https://abcdefghijklmnopqrst.supabase.co'; // scan-secrets: allow (URL fictícia de teste)

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  f.calls = calls;
  return f;
}
const resp = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

test('SupabaseRest: publishable key + JWT do usuário em toda chamada; pagina selectAll; rpc e gp-keys por POST', async () => {
  const f = fakeFetch((url, init, n) => (url.includes('/rest/v1/stages') ? resp(200, n === 1 ? Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}` })) : [{ id: 'last' }]) : resp(200, { ok: true })));
  const t = new SupabaseRest({ url: URL_, publishableKey: 'pk_teste', getAccessToken: async () => 'jwt_teste', fetchImpl: f });
  const rows = await t.selectAll('stages', { order: 'id' });
  assert.equal(rows.length, 1001);
  assert.match(f.calls[1].url, /offset=1000/);
  assert.equal(f.calls[0].init.headers.apikey, 'pk_teste');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer jwt_teste');
  await t.rpc('apply_changes', { p_changes: [] });
  assert.equal(f.calls[2].init.method, 'POST'); assert.match(f.calls[2].url, /\/rest\/v1\/rpc\/apply_changes$/);
  await t.fetchKeys(['global'], false);
  assert.match(f.calls[3].url, /\/functions\/v1\/gp-keys$/);
  await assert.rejects(t.selectAll('stages; drop'), /inválida/);
  assert.throws(() => new SupabaseRest({ url: 'http://inseguro.test', publishableKey: 'x', getAccessToken: () => 'y' }), /URL/);
});

test('SupabaseRest: erros viram códigos do app (STALE, FORBIDDEN, AUTH, OFFLINE) sem expor detalhe', async () => {
  const cases = [
    [resp(400, { code: 'GP409', details: '{"i":2,"table":"projects"}' }), 'STALE'],
    [resp(403, { code: '42501' }), 'FORBIDDEN'],
    [resp(401, { code: 'PGRST301' }), 'AUTH'],
    [resp(503, {}), 'OFFLINE'],
    [resp(400, { code: '23514' }), 'INVALID'],
  ];
  for (const [r, code] of cases) {
    const t = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: async () => r });
    await assert.rejects(t.rpc('apply_changes', {}), (e) => { assert.equal(e.code, code); return true; });
  }
  const conflict = await new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: async () => cases[0][0] }).rpc('x', {}).catch((e) => e);
  assert.deepEqual(conflict.conflict, { i: 2, table: 'projects' });
  const net = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(net.rpc('x', {}), { code: 'OFFLINE' });
  const noSession = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => null, fetchImpl: async () => resp(200, {}) });
  await assert.rejects(noSession.rpc('x', {}), { code: 'AUTH' });
});

test('SupabaseRest Storage: upload sem sobrescrever (x-upsert false) e download autenticado; erros do Storage viram códigos do app', async () => {
  const f = fakeFetch((url, init) => (init.method === 'GET' ? { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer } : resp(200, {})));
  const t = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: f });
  await t.storageUpload('evidence', 'p1/ev1', Buffer.from('x'));
  assert.equal(f.calls[0].url, `${URL_}/storage/v1/object/evidence/p1/ev1`);
  assert.equal(f.calls[0].init.headers['x-upsert'], 'false');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer jwt');
  assert.deepEqual(await t.storageDownload('evidence', 'p1/ev1'), Buffer.from([1, 2, 3]));
  assert.equal(f.calls[1].url, `${URL_}/storage/v1/object/authenticated/evidence/p1/ev1`);
  assert.throws(() => t._objectUrl('', 'evidence', '../x'), /objeto inválido/);
  for (const [r, code] of [[resp(400, { statusCode: '404', error: 'not_found' }), 'NOT_FOUND'], [resp(400, { statusCode: '403', message: 'new row violates row-level security policy' }), 'FORBIDDEN'],
    [resp(400, { statusCode: '409', error: 'Duplicate' }), 'STALE'], [resp(413, { statusCode: '413', message: 'Payload too large' }), 'TOO_LARGE']]) {
    const tt = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: async () => r });
    await assert.rejects(tt.storageUpload('evidence', 'p1/ev2', Buffer.from('x')), { code });
  }
});

test('gp-keys: 500 da função (ex.: KEK ausente/trocada) vira CRYPTO, não "sem conexão"; rede caída continua OFFLINE', async () => {
  const t = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: async () => resp(500, { error: 'Não foi possível obter as chaves.' }) });
  await assert.rejects(t.fetchKeys(['global']), { code: 'CRYPTO' });
  const down = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.fetchKeys(['global']), { code: 'OFFLINE' });
  const gw = new SupabaseRest({ url: URL_, publishableKey: 'pk', getAccessToken: async () => 'jwt', fetchImpl: async () => resp(503, {}) });
  await assert.rejects(gw.fetchKeys(['global']), { code: 'OFFLINE' });
});

test('LocalUserData: pasta por UUID, gravação atômica com .bak, arquivo de outro usuário recusado', () => {
  const uid = '11111111-2222-3333-4444-555555555555';
  assert.throws(() => new LocalUserData('Elton', tmp), { code: 'LOCAL_USER' }); // nome legível nunca segrega dados
  const ld = new LocalUserData(uid, tmp);
  assert.ok(ld.dir.endsWith(path.join('users', uid)));
  ld.write('hours', { timeEntries: [1] });
  ld.write('hours', { timeEntries: [1, 2] });
  assert.deepEqual(ld.read('hours').timeEntries, [1, 2]);
  assert.ok(fs.existsSync(`${ld.file('hours')}.bak`));
  const other = new LocalUserData('99999999-2222-3333-4444-555555555555', tmp);
  fs.copyFileSync(ld.file('hours'), other.file('hours'));
  assert.throws(() => other.read('hours'), { code: 'LOCAL_USER' });
});

test('permissões: códigos do app = catálogo da migration; inativo nunca pode; MASTER pode tudo', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', fs.readdirSync(path.join(__dirname, '..', 'supabase', 'migrations')).find((f) => f.includes('permissions'))), 'utf8');
  const inSql = [...sql.matchAll(/\('([a-z]+(?:\.[a-z_]+)+)',\s+'/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.values(PERMISSIONS).sort(), inSql);
  assert.equal(can({ role: ROLES.MASTER, status: 'active', permissions: [] }, PERMISSIONS.USERS_MANAGE), true);
  assert.equal(can({ role: ROLES.MASTER, status: 'suspended', permissions: [] }, PERMISSIONS.USERS_MANAGE), false);
  assert.equal(can({ role: ROLES.USER, status: 'active', permissions: ['projects.create'] }, PERMISSIONS.PROJECTS_CREATE), true);
  assert.equal(can({ role: ROLES.USER, status: 'pending', permissions: ['projects.create'] }, PERMISSIONS.PROJECTS_CREATE), false);
  assert.equal(can(null, PERMISSIONS.PROJECTS_CREATE), false);
});

test('Store local: gravações em fila e mesmo arquivo de sempre (projects.json + .bak)', async () => {
  const dir = path.join(tmp, 'store');
  const s = new Store(dir);
  assert.equal(s.mode, 'local');
  s.data.settings.warnDays = 3; const a = s.save();
  s.data.settings.warnDays = 4; const b = s.save();
  await Promise.all([a, b]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')).settings.warnDays, 4);
  assert.ok(fs.existsSync(path.join(dir, 'projects.json.bak')));
});
