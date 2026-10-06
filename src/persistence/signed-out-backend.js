// Backend "sem sessão" (modo nuvem antes do login / depois do logout): estado vazio em memória, nenhum dado local carregado,
// toda gravação e todo arquivo recusados com AUTH (401). Garante que nada de um usuário anterior fique acessível.
'use strict';
const { applyDefaults } = require('../defaults');
const { EMPTY } = require('./local-json-backend');
const { DataError } = require('./errors');

const denied = () => { throw new DataError('AUTH', 'sem sessão'); };

class SignedOutBackend {
  constructor() { this.kind = 'none'; }
  loadSync() { return applyDefaults(EMPTY()); }
  async load() { return this.loadSync(); }
  async commit() { denied(); }
  files() { denied(); }
  scripts() { denied(); }
  hasPendingChanges() { return false; }
  dispose() {}
}

module.exports = { SignedOutBackend };
