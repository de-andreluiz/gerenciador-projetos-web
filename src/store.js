// Store: fachada estável do estado do app (`store.data`, mesmo formato do projects.json) sobre o LocalJsonBackend.
// As rotas continuam mutando `store.data` e chamando `await store.save()`; nenhuma rota conhece o backend.
//
// Garantias:
//   - Gravações em FILA (uma por vez): duas requisições nunca gravam por cima uma da outra.
//   - Contador de geração: gravação pedida antes de uma recarga é recusada (409) em vez de reportar sucesso falso.
//   - O objeto `store.data` nunca é trocado (só o conteúdo): as rotas sempre enxergam o estado atual.
'use strict';
const { LocalJsonBackend } = require('./persistence/local-json-backend');
const { DataError, toHttp } = require('./persistence/errors');

class Store {
  constructor(dir, { backend } = {}) {
    this.dir = dir;
    this.backend = backend || new LocalJsonBackend(dir);
    this.data = this.backend.loadSync();
    this._queue = Promise.resolve();
    this._gen = 0;
  }

  get file() { return this.backend.file; }
  get mode() { return this.backend.kind; }

  // Põe uma operação na fila (gravações e recargas nunca se sobrepõem).
  _enqueue(fn) {
    const p = this._queue.then(fn, fn);
    this._queue = p.catch(() => {});
    return p;
  }

  save() {
    const gen = this._gen;
    return this._enqueue(async () => {
      if (gen !== this._gen) throw toHttp(new DataError('RELOADED'));
      try {
        await this.backend.commit(this.data);
      } catch (e) {
        throw e instanceof DataError ? toHttp(e) : e;
      }
    });
  }

  files(area) { return this.backend.files(area); }
  scripts() { return this.backend.scripts(); }

  project(id) {
    return this.data.projects.find((p) => p.id === id) || null;
  }
}

module.exports = { Store };
