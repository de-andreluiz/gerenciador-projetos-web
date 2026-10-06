// Varredura de segredos (scripts/scan-secrets.js): os padrões pegam os segredos que importam e não acusam código comum.
// Os valores falsos são montados em tempo de execução para que este arquivo não dispare a própria varredura.
const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../scripts/scan-secrets');

const j = (...p) => p.join('');
const kinds = (text, canaries = []) => scanText(text, canaries).map(([, k]) => k);

test('scan-secrets: acusa chaves do Supabase, JWT, chave privada, tokens do GitHub, DPAPI e connection string', () => {
  assert.deepEqual(kinds(j('KEY=', 'sb_', 'secret_', 'abcdefghijklmnop')), ['Supabase secret key']);
  assert.deepEqual(kinds(j('x = "', 'sb_', 'publishable_', 'abcdefghijklmnop', '"')), ['Supabase publishable key (fica no .env, não no Git)']);
  assert.deepEqual(kinds(j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcdefghijklmnopqrstu')), ['JWT (anon/service_role/sessão)']);
  assert.deepEqual(kinds(j('-----BEGIN ', 'PRIVATE KEY-----')), ['chave privada']);
  assert.deepEqual(kinds(j('gh', 'p_', 'a'.repeat(36))), ['token do GitHub']);
  assert.deepEqual(kinds(j('"passwordEnc": "', 'AQAAANCMnd8BFdERjHoA', 'wE/Cl+sBAAAA', 'xyz"')), ['blob DPAPI (senha protegida)']);
  assert.deepEqual(kinds(j('GP_KEK', '_V1=', 'q'.repeat(44))), ['chave de servidor atribuída']);
  assert.deepEqual(kinds(j('https://', 'abcdefghijklmnopqrst', '.supabase.co')), ['URL real de projeto Supabase']);
  assert.deepEqual(kinds(j('Server=x;User Id=sa;', 'Password', '=Segredo123;')), ['senha em connection string']);
});

test('scan-secrets: não acusa placeholders nem código comum; respeita "scan-secrets: allow"', () => {
  for (const ok of ['GP_SUPABASE_URL=https://<project-ref>.supabase.co', 'GP_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_...>',
    "prod: { server: '192.0.2.10', auth: 'sql', user: 'u', password: 'nova' }", 'const conn = { passwordEnc: null };',
    'if (auth === "sql" && input.password) conn.passwordEnc = await protect(input.password);', '    u.password = password;', 'this.pwd = novaSenha;']) assert.deepEqual(kinds(ok), [], ok);
  assert.deepEqual(kinds(j('sb_', 'secret_', 'abcdefghijklmnop // scan-secrets: allow')), []);
});

test('scan-secrets: canários de dados reais são achados sem diferenciar maiúsculas e sem expor o valor', () => {
  const found = scanText('linha 1\nconst p = { name: "CLIENTE REAL LTDA" };', [['cliente real ltda', 'nome de projeto real']]);
  assert.deepEqual(found, [[2, 'nome de projeto real']]);
});
