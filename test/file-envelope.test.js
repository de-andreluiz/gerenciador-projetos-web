// Cifra de arquivos para o Storage (src/crypto/file-envelope.js): formato GPF1, sem texto em claro, adulteração e troca de caminho detectadas.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { sealFile, openFile, MAGIC } = require('../src/crypto/file-envelope');

const dek = () => ({ kid: crypto.randomUUID(), key: crypto.randomBytes(32) });
const ctx = { bucket: 'evidence', path: 'p1/ev1' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('CONTEUDO_CONFIDENCIAL_DO_PRINT')]);

test('cifra e decifra um arquivo; o blob não contém assinatura nem texto do original', () => {
  const k = dek();
  const blob = sealFile(PNG, k, ctx);
  assert.ok(blob.subarray(0, 4).equals(MAGIC));
  assert.ok(!blob.includes(Buffer.from('CONTEUDO_CONFIDENCIAL')));
  assert.ok(!blob.includes(PNG.subarray(0, 8)));
  assert.deepEqual(openFile(blob, (kid) => (kid === k.kid ? k.key : null), ctx), PNG);
});

test('adulteração (conteúdo, tag, iv) e objeto copiado para outro caminho/bucket falham na autenticação', () => {
  const k = dek();
  const blob = sealFile(PNG, k, ctx);
  for (const at of [blob.length - 1, 33, 21]) { const b = Buffer.from(blob); b[at] ^= 1; assert.throws(() => openFile(b, () => k.key, ctx), { code: 'CRYPTO_AUTH' }, `byte ${at}`); }
  assert.throws(() => openFile(blob, () => k.key, { bucket: 'evidence', path: 'p2/ev1' }), { code: 'CRYPTO_AUTH' });
  assert.throws(() => openFile(blob, () => k.key, { bucket: 'email-images', path: 'p1/ev1' }), { code: 'CRYPTO_AUTH' });
});

test('chave ausente/errada e formato inválido são recusados; mesmo arquivo cifrado duas vezes gera blobs diferentes', () => {
  const k = dek();
  const blob = sealFile(PNG, k, ctx);
  assert.throws(() => openFile(blob, () => null, ctx), { code: 'CRYPTO_NO_KEY' });
  assert.throws(() => openFile(blob, () => crypto.randomBytes(32), ctx), { code: 'CRYPTO_AUTH' });
  assert.throws(() => openFile(PNG, () => k.key, ctx), { code: 'CRYPTO_FORMAT' });
  assert.notDeepEqual(sealFile(PNG, k, ctx), sealFile(PNG, k, ctx));
});
