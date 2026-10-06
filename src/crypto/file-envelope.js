// Cifra de ARQUIVOS (evidências, imagens de e-mail) antes do upload para o Storage — AES-256-GCM, mesma DEK do escopo.
// Formato binário v1:  "GPF1" (4) | kid (16 bytes do UUID da DEK) | iv (12) | tag (16) | ciphertext
// AAD = "gp:file:v1:<bucket>:<caminho do objeto>": um objeto copiado para outro caminho/bucket não abre.
// O Storage guarda só isto; nome do arquivo, tipo e descrição ficam nos metadados (cifrados no banco).
'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('GPF1', 'ascii');
const HEADER = 4 + 16 + 12 + 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (msg, code) => Object.assign(new Error(msg), { code });

const aad = (bucket, objectPath) => {
  if (!bucket || !objectPath) throw fail('Contexto da cifra do arquivo incompleto.', 'CRYPTO_CONTEXT');
  return Buffer.from(`gp:file:v1:${bucket}:${objectPath}`, 'utf8');
};
const kidToBytes = (kid) => Buffer.from(kid.replace(/-/g, ''), 'hex');
const bytesToKid = (b) => { const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

function sealFile(buffer, dek, { bucket, path }) {
  if (!dek || !Buffer.isBuffer(dek.key) || dek.key.length !== 32 || !UUID_RE.test(dek.kid || '')) throw fail('Chave de dados inválida.', 'CRYPTO_KEY');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek.key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(bucket, path));
  const ct = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, kidToBytes(dek.kid), iv, cipher.getAuthTag(), ct]);
}

function openFile(blob, keyFor, { bucket, path }) {
  if (!Buffer.isBuffer(blob) || blob.length < HEADER || !blob.subarray(0, 4).equals(MAGIC)) throw fail('Arquivo cifrado em formato inválido.', 'CRYPTO_FORMAT');
  const kid = bytesToKid(blob.subarray(4, 20));
  const key = keyFor(kid);
  if (!key) throw fail('Chave de dados indisponível para este arquivo.', 'CRYPTO_NO_KEY');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(20, 32), { authTagLength: 16 });
    decipher.setAAD(aad(bucket, path));
    decipher.setAuthTag(blob.subarray(32, 48));
    return Buffer.concat([decipher.update(blob.subarray(HEADER)), decipher.final()]);
  } catch {
    throw fail('Falha de autenticação ao decifrar o arquivo (conteúdo alterado ou chave incorreta).', 'CRYPTO_AUTH');
  }
}

const OVERHEAD = HEADER;
module.exports = { sealFile, openFile, OVERHEAD, MAGIC };
