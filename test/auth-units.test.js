// Fase 4 — peças sem rede: cliente do Supabase Auth (fetch simulado), configuração (.env / modo nuvem), política de senha.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoTrueClient } = require('../src/auth/gotrue');
const { loadDotEnv, appConfig } = require('../src/config');
const { checkPassword } = require('../src/auth/session');

const URL_ = 'https://abcdefghijklmnopqrst.supabase.co'; // scan-secrets: allow (URL fictícia de teste)
const resp = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const okSession = { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, user: { id: '11111111-2222-3333-4444-555555555555', email: 'x@exemplo.test' } };

test('GoTrue: endpoints e cabeçalhos (publishable key; Bearer só onde precisa); sessão normalizada', async () => {
  const calls = [];
  const c = new GoTrueClient({ url: URL_, publishableKey: 'pk', fetchImpl: async (url, init) => { calls.push({ url, init }); return resp(200, url.includes('/user') || url.includes('/recover') || url.includes('/logout') ? {} : okSession); } });
  const s = await c.signIn('x@exemplo.test', 'Senha-Forte-123');
  assert.equal(s.accessToken, 'a1'); assert.equal(s.refreshToken, 'r1'); assert.equal(s.userId, okSession.user.id); assert.ok(s.expiresAt > Date.now());
  await c.refresh('r1'); await c.verifyOtp('invite', 'x@exemplo.test', '123456'); await c.setPassword('a1', 'Nova-Senha-123!'); await c.recover('x@exemplo.test'); await c.signOut('a1');
  assert.deepEqual(calls.map((x) => `${x.init.method} ${x.url.replace(URL_, '')}`), [
    'POST /auth/v1/token?grant_type=password', 'POST /auth/v1/token?grant_type=refresh_token', 'POST /auth/v1/verify', 'PUT /auth/v1/user', 'POST /auth/v1/recover', 'POST /auth/v1/logout?scope=local']);
  assert.ok(calls.every((x) => x.init.headers.apikey === 'pk'));
  assert.equal(calls[0].init.headers.Authorization, undefined, 'login não manda token');
  assert.equal(calls[3].init.headers.Authorization, 'Bearer a1');
  assert.deepEqual(JSON.parse(calls[2].init.body), { type: 'invite', email: 'x@exemplo.test', token: '123456' });
});

test('GoTrue: erros viram códigos com mensagens que não revelam se a conta existe', async () => {
  const cases = [
    [resp(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }), 'INVALID_CREDENTIALS', /E-mail ou senha incorretos/],
    [resp(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }), 'INVALID_CREDENTIALS', /incorretos/],
    [resp(400, { error_code: 'email_not_confirmed' }), 'NOT_CONFIRMED', /Primeiro acesso/],
    [resp(400, { error_code: 'user_banned', msg: 'User is banned' }), 'SUSPENDED', /suspenso/],
    [resp(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' }), 'INVALID_CODE', /Código inválido/],
    [resp(422, { error_code: 'weak_password' }), 'WEAK_PASSWORD', /12 caracteres/],
    [resp(429, { error_code: 'over_request_rate_limit' }), 'RATE_LIMIT', /tentativas/],
    [resp(400, { error_code: 'refresh_token_not_found' }), 'SESSION_EXPIRED', /expirou/],
    [resp(502, {}), 'OFFLINE', /conexão/],
  ];
  for (const [r, code, msg] of cases) {
    const c = new GoTrueClient({ url: URL_, publishableKey: 'pk', fetchImpl: async () => r });
    await assert.rejects(c.signIn('x@exemplo.test', 'y'), (e) => { assert.equal(e.code, code); assert.match(e.message, msg); return true; });
  }
  const offline = new GoTrueClient({ url: URL_, publishableKey: 'pk', fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(offline.signIn('x@exemplo.test', 'y'), { code: 'OFFLINE' });
});

test('config: modo local é o padrão; modo nuvem exige URL https e publishable key; secret/service role é recusada', () => {
  assert.equal(appConfig({}).mode, 'local');
  assert.throws(() => appConfig({ GP_MODE: 'cloud' }), /GP_SUPABASE_URL/);
  assert.throws(() => appConfig({ GP_MODE: 'cloud', GP_SUPABASE_URL: 'http://inseguro.test', GP_SUPABASE_PUBLISHABLE_KEY: 'x' }), /GP_SUPABASE_URL/);
  assert.throws(() => appConfig({ GP_MODE: 'cloud', GP_SUPABASE_URL: URL_ }), /PUBLISHABLE_KEY/);
  assert.throws(() => appConfig({ GP_MODE: 'cloud', GP_SUPABASE_URL: URL_, GP_SUPABASE_PUBLISHABLE_KEY: ['sb', 'secret', 'abc'].join('_') }), /SECRET/);
  assert.equal(appConfig({ GP_MODE: 'cloud', GP_SUPABASE_URL: URL_, GP_SUPABASE_PUBLISHABLE_KEY: 'pk' }).mode, 'cloud');
  assert.equal(appConfig({ GP_MODE: 'cloud', GP_SUPABASE_URL: 'http://127.0.0.1:54321', GP_SUPABASE_PUBLISHABLE_KEY: 'pk' }).mode, 'cloud', 'HTTP só no Supabase local (loopback)');
  assert.throws(() => appConfig({ GP_MODE: 'cloud', GP_SUPABASE_URL: 'http://10.0.0.5:54321', GP_SUPABASE_PUBLISHABLE_KEY: 'pk' }), /GP_SUPABASE_URL/);
});

test('.env: só chaves GP_* e PORT, sem sobrescrever o ambiente; comentários ignorados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '# comentário\nGP_TESTE_X=valor # nota\nGP_TESTE_Y="aspas"\nPATH=hackeado\nGP_TESTE_JA=novo\n');
  process.env.GP_TESTE_JA = 'antigo';
  const before = process.env.PATH;
  loadDotEnv(dir);
  assert.equal(process.env.GP_TESTE_X, 'valor'); assert.equal(process.env.GP_TESTE_Y, 'aspas');
  assert.equal(process.env.GP_TESTE_JA, 'antigo'); assert.equal(process.env.PATH, before);
  for (const k of ['GP_TESTE_X', 'GP_TESTE_Y', 'GP_TESTE_JA']) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

test('senha: mínimo 12 com maiúscula, minúscula, número e símbolo', () => {
  for (const bad of ['123', 'curta1!A', 'semnumero!!AAaa', 'SEMMINUSCULA1!!', 'semmaiuscula1!!', 'SemSimbolo1234', undefined]) assert.throws(() => checkPassword(bad), { code: 'WEAK_PASSWORD' }, String(bad));
  assert.equal(checkPassword('Senha-Forte-2026'), 'Senha-Forte-2026');
});
