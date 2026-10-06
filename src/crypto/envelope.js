// Criptografia de campos em nível de aplicação — envelope v1 (AES-256-GCM).
// Formato gravado na coluna `enc` (o banco recusa qualquer outra coisa: gp.is_envelope):
//   { v: 1, alg: 'A256GCM', kid: <uuid da DEK>, iv: <12 bytes b64>, ct: <b64>, tag: <16 bytes b64> }
// - IV aleatório de 96 bits a cada cifragem (nunca reutilizado com a mesma chave).
// - AAD = "gp:v1:<tabela>:<id da linha>:<campo>": ciphertext copiado para outra linha/tabela não abre.
// - O conteúdo é o JSON dos campos sensíveis daquela linha.
// - DEKs chegam da Edge Function gp-keys e ficam só em memória (Keyring); nunca em disco, log ou tela.
'use strict';
const crypto = require('crypto');

const VERSION = 1;
const ALG = 'A256GCM';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fail = (msg, code) => Object.assign(new Error(msg), { code });

function aad(table, id, field = 'enc') {
  if (!table || id === undefined || id === null || id === '') throw fail('Contexto da cifra incompleto (tabela/id).', 'CRYPTO_CONTEXT');
  return Buffer.from(`gp:v${VERSION}:${table}:${id}:${field}`, 'utf8');
}

function isEnvelope(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length === 6
    && e.v === VERSION && e.alg === ALG && UUID_RE.test(e.kid || '')
    && /^[A-Za-z0-9+/]{16}$/.test(e.iv || '') && /^[A-Za-z0-9+/]{22}==$/.test(e.tag || '') && /^[A-Za-z0-9+/]*={0,2}$/.test(e.ct ?? '!');
}

// Cifra um objeto JSON com a DEK { kid, key (Buffer 32) }.
function seal(value, dek, { table, id, field }) {
  if (!dek || !Buffer.isBuffer(dek.key) || dek.key.length !== 32 || !UUID_RE.test(dek.kid || '')) throw fail('Chave de dados inválida.', 'CRYPTO_KEY');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek.key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(table, id, field));
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return { v: VERSION, alg: ALG, kid: dek.kid, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

// Decifra. `keyFor(kid)` devolve o Buffer da DEK (ou null). Qualquer adulteração (ct, iv, tag, contexto) → erro CRYPTO_AUTH.
function open(env, keyFor, { table, id, field }) {
  if (!isEnvelope(env)) throw fail('Conteúdo cifrado em formato inválido.', 'CRYPTO_FORMAT');
  const key = keyFor(env.kid);
  if (!key) throw fail('Chave de dados indisponível para este conteúdo.', 'CRYPTO_NO_KEY');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad(table, id, field));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw fail('Falha de autenticação ao decifrar (conteúdo alterado ou chave incorreta).', 'CRYPTO_AUTH');
  }
}

// Chaveiro em memória da sessão: DEKs por escopo ('global', 'project:<id>'). clear() zera os buffers (logout/expiração).
class Keyring {
  constructor() { this.byKid = new Map(); this.current = new Map(); }
  add({ scope, kid, key, current }) {
    const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
    if (buf.length !== 32 || !UUID_RE.test(kid)) throw fail('Chave de dados inválida.', 'CRYPTO_KEY');
    this.byKid.set(kid, buf);
    if (current) this.current.set(scope, { kid, key: buf });
  }
  keyFor = (kid) => this.byKid.get(kid) || null;
  currentFor(scope) { return this.current.get(scope) || null; }
  has(scope) { return this.current.has(scope); }
  clear() { for (const b of this.byKid.values()) b.fill(0); this.byKid.clear(); this.current.clear(); }
}

module.exports = { seal, open, isEnvelope, aad, Keyring, VERSION, ALG };
