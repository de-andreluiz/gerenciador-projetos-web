// Envelope de cifra (src/crypto/envelope.js): AES-256-GCM, IV único, AAD por linha, adulteração detectada, chaveiro zerável.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { seal, open, isEnvelope, Keyring } = require('../src/crypto/envelope');

const dek = () => ({ kid: crypto.randomUUID(), key: crypto.randomBytes(32) });
const ctx = { table: 'projects', id: 'p1' };

test('cifra e decifra; o envelope não contém o texto em claro e passa no formato exigido pelo banco', () => {
  const k = dek();
  const env = seal({ name: 'Cliente Exemplo Ltda', contacts: [{ email: 'pessoa@exemplo.test' }] }, k, ctx);
  assert.ok(isEnvelope(env));
  const raw = JSON.stringify(env);
  assert.ok(!raw.includes('Exemplo Ltda') && !raw.includes('pessoa@exemplo.test'));
  assert.deepEqual(open(env, (kid) => (kid === k.kid ? k.key : null), ctx), { name: 'Cliente Exemplo Ltda', contacts: [{ email: 'pessoa@exemplo.test' }] });
});

test('IV nunca se repete (mesmo conteúdo → envelopes diferentes)', () => {
  const k = dek();
  const ivs = new Set(Array.from({ length: 500 }, () => seal({ a: 1 }, k, ctx).iv));
  assert.equal(ivs.size, 500);
});

test('adulteração de ct, tag ou iv falha na autenticação GCM', () => {
  const k = dek();
  const keyFor = () => k.key;
  const env = seal({ name: 'X' }, k, ctx);
  const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  for (const f of ['ct', 'tag', 'iv']) assert.throws(() => open({ ...env, [f]: flip(env[f]) }, keyFor, ctx), { code: 'CRYPTO_AUTH' }, f);
});

test('AAD amarra o ciphertext à tabela e à linha: copiar para outra linha não abre', () => {
  const k = dek();
  const env = seal({ name: 'X' }, k, ctx);
  assert.throws(() => open(env, () => k.key, { table: 'projects', id: 'p2' }), { code: 'CRYPTO_AUTH' });
  assert.throws(() => open(env, () => k.key, { table: 'people', id: 'p1' }), { code: 'CRYPTO_AUTH' });
});

test('chave errada/ausente e formato inválido são recusados', () => {
  const k = dek();
  const env = seal({ name: 'X' }, k, ctx);
  assert.throws(() => open(env, () => crypto.randomBytes(32), ctx), { code: 'CRYPTO_AUTH' });
  assert.throws(() => open(env, () => null, ctx), { code: 'CRYPTO_NO_KEY' });
  assert.throws(() => open({ name: 'X' }, () => k.key, ctx), { code: 'CRYPTO_FORMAT' });
  assert.throws(() => seal({}, { kid: 'x', key: Buffer.alloc(16) }, ctx), { code: 'CRYPTO_KEY' });
  assert.throws(() => seal({}, k, { table: 'projects' }), { code: 'CRYPTO_CONTEXT' });
});

test('Keyring: chave corrente por escopo; clear() zera os bytes', () => {
  const ring = new Keyring();
  const k = dek();
  ring.add({ scope: 'project:p1', kid: k.kid, key: k.key.toString('base64'), current: true });
  const env = seal({ a: 1 }, ring.currentFor('project:p1'), ctx);
  assert.deepEqual(open(env, ring.keyFor, ctx), { a: 1 });
  const buf = ring.keyFor(k.kid);
  ring.clear();
  assert.ok(buf.every((b) => b === 0));
  assert.equal(ring.has('project:p1'), false);
  assert.throws(() => open(env, ring.keyFor, ctx), { code: 'CRYPTO_NO_KEY' });
});
