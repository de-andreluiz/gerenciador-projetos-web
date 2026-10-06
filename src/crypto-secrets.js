// src/crypto-secrets.js
// Substituto cross-platform para src/secrets.js (que usa DPAPI do Windows via PowerShell).
// Implementa criptografia AES-256-GCM usando apenas o módulo `crypto` nativo do Node.js.
//
// Formato do blob armazenado (base64 de um buffer binário):
//   [4 bytes: magic 0x47504153 "GPAS"] [1 byte: versão=1]
//   [12 bytes: IV/nonce] [16 bytes: auth tag] [N bytes: ciphertext]
//
// Chave derivada de:
//   1. GP_SECRET_KEY (variável de ambiente, hex de 64 chars = 32 bytes) — produção.
//   2. Fallback: PBKDF2 de (hostname + username) com um salt fixo — dev local sem config.
//      AVISO: o fallback é determinístico mas NÃO é seguro para produção. Configure GP_SECRET_KEY.
//
// Interface pública idêntica à do secrets.js original:
//   protect(plain)   → Promise<string>  blob base64 criptografado
//   unprotect(blob)  → Promise<string>  texto original
//   DPAPI_EXIT       = 0 (mantido por compatibilidade; nunca usado aqui)
'use strict';
const crypto = require('crypto');
const os     = require('os');

const MAGIC   = Buffer.from([0x47, 0x50, 0x41, 0x53]); // "GPAS"
const VERSION = 0x01;
const IV_LEN  = 12;  // GCM nonce
const TAG_LEN = 16;  // GCM auth tag
const ALGO    = 'aes-256-gcm';

// ── Chave de criptografia ──────────────────────────────────────────────────────

let _cachedKey = null;

function _deriveKey() {
  if (_cachedKey) return _cachedKey;

  const envKey = process.env.GP_SECRET_KEY;
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error('GP_SECRET_KEY inválida: deve ser uma string hexadecimal de 64 caracteres (32 bytes).');
    }
    _cachedKey = Buffer.from(envKey, 'hex');
    return _cachedKey;
  }

  // Fallback de desenvolvimento: derivação determinística via PBKDF2.
  // NÃO USE EM PRODUÇÃO — configure GP_SECRET_KEY!
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'GP_SECRET_KEY não definida em modo de produção. ' +
      'Gere uma chave com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'e defina GP_SECRET_KEY no arquivo .env.'
    );
  }

  const material = `${os.hostname()}::${os.userInfo().username}::gerenciador-projetos`;
  const salt     = Buffer.from('gp-crypto-salt-v1-2024', 'utf8');
  _cachedKey     = crypto.pbkdf2Sync(material, salt, 100_000, 32, 'sha256');

  console.warn(
    '[crypto-secrets] AVISO: usando chave derivada do hostname (modo dev). ' +
    'Em produção, configure GP_SECRET_KEY no .env.'
  );
  return _cachedKey;
}

// Permite resetar o cache em testes que precisam testar diferentes chaves.
function _resetKeyCache() { _cachedKey = null; }

// ── Cifragem / decifragem ──────────────────────────────────────────────────────

/**
 * Cifra um texto plano com AES-256-GCM.
 * @param {string} plain  Texto a cifrar (senha, token, etc.)
 * @returns {Promise<string>} Blob base64 (portável, armazenável em JSON/SQLite)
 */
async function protect(plain) {
  const key = _deriveKey();
  const iv  = crypto.randomBytes(IV_LEN);

  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct1 = cipher.update(Buffer.from(String(plain), 'utf8'));
  const ct2 = cipher.final();
  const tag  = cipher.getAuthTag();

  const blob = Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, ct1, ct2]);
  return blob.toString('base64');
}

/**
 * Decifra um blob produzido por protect().
 * @param {string} blobB64  Blob base64 retornado por protect()
 * @returns {Promise<string>} Texto original
 * @throws {Error} com code 'PASSWORD_UNREADABLE' se o blob for inválido ou a chave errada
 */
async function unprotect(blobB64) {
  let buf;
  try { buf = Buffer.from(String(blobB64).trim(), 'base64'); } catch {
    throw Object.assign(new Error('Blob de senha inválido (não é base64).'), { code: 'PASSWORD_UNREADABLE' });
  }

  // Verificação do magic + versão
  if (buf.length < MAGIC.length + 1 + IV_LEN + TAG_LEN) {
    throw Object.assign(new Error('Blob de senha corrompido ou em formato desconhecido.'), { code: 'PASSWORD_UNREADABLE' });
  }
  if (!buf.slice(0, 4).equals(MAGIC)) {
    // Blob pode ser de outro sistema (ex.: DPAPI legado): não tenta decifrar.
    throw Object.assign(
      new Error('Senha salva em formato incompatível (possivelmente criptografada pelo Windows/DPAPI). Informe a senha novamente.'),
      { code: 'PASSWORD_UNREADABLE', dpapi: 'blob-nao-reconhecido' }
    );
  }
  const version = buf[4];
  if (version !== VERSION) {
    throw Object.assign(new Error(`Versão de blob desconhecida: ${version}`), { code: 'PASSWORD_UNREADABLE' });
  }

  const offset = 5; // após magic+version
  const iv  = buf.slice(offset, offset + IV_LEN);
  const tag = buf.slice(offset + IV_LEN, offset + IV_LEN + TAG_LEN);
  const ct  = buf.slice(offset + IV_LEN + TAG_LEN);

  const key = _deriveKey();
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    throw Object.assign(
      new Error(`Não foi possível decifrar a senha: chave inválida ou blob corrompido. (${e.message})`),
      { code: 'PASSWORD_UNREADABLE', dpapi: e.message }
    );
  }
}

// Mantido por compatibilidade de interface com o secrets.js original.
const DPAPI_EXIT = 0;

module.exports = { protect, unprotect, DPAPI_EXIT, _resetKeyCache };
