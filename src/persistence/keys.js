// Chaves de dados da sessão: pede à Edge Function gp-keys (via transporte) só os escopos que faltam e guarda tudo em memória
// (Keyring). Nunca em disco, log ou tela. clear() no logout/expiração zera os bytes.
'use strict';
const { Keyring } = require('../crypto/envelope');
const { DataError } = require('./errors');

class KeyService {
  constructor(fetchKeys) {
    this.fetchKeys = fetchKeys; // (scopes, create) → { keys, denied }
    this.ring = new Keyring();
    this.keyFor = this.ring.keyFor;
  }

  async ensure(scopes, { create = false } = {}) {
    const missing = [...new Set(scopes)].filter((s) => !this.ring.has(s));
    for (let i = 0; i < missing.length; i += 200) {
      const res = await this.fetchKeys(missing.slice(i, i + 200), create);
      for (const k of res?.keys || []) this.ring.add(k);
    }
  }

  // DEK corrente do escopo para cifrar; sem ela, nada é gravado (fail closed).
  current(scope) {
    const k = this.ring.currentFor(scope);
    if (!k) throw new DataError('FORBIDDEN', `sem chave para ${scope.split(':')[0]}`);
    return k;
  }

  clear() { this.ring.clear(); }
}

module.exports = { KeyService };
