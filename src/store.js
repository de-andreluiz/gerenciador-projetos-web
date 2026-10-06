// Store: fachada estável do estado do app (`store.data`, mesmo formato do projects.json) com backend trocável.
//   - LocalJsonBackend (padrão): data/projects.json, como sempre.
//   - CloudBackend: Supabase (Unit of Work, cifra, vínculos e segredos locais) — ligado após o login (Fase 4) via attach().
// As rotas continuam mutando `store.data` e chamando `await store.save()`; nenhuma rota conhece o backend.
//
// Garantias:
//   - Gravações em FILA (uma por vez): duas requisições nunca gravam por cima uma da outra.
//   - Falha ao gravar na nuvem → o estado em memória volta ao que está confirmado (recarrega; sem rede, volta ao snapshot)
//     e o erro chega à tela com `code` (STALE_DATA, FORBIDDEN, OFFLINE, AUTH_REQUIRED). Nada é "dado como salvo" sem estar.
//   - Contador de geração: gravação pedida antes de uma recarga é recusada (409) em vez de reportar sucesso falso.
//   - O objeto `store.data` nunca é trocado (só o conteúdo): as rotas sempre enxergam o estado atual.
'use strict';
const { LocalJsonBackend } = require('./persistence/local-json-backend');
const { DataError, toHttp } = require('./persistence/errors');
const { SignedOutBackend } = require('./persistence/signed-out-backend');

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

  // Põe uma operação na fila (gravações, recargas e trocas de backend nunca se sobrepõem).
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
        if (this.backend.kind !== 'cloud' && this.backend.kind !== 'offline') throw e instanceof DataError ? toHttp(e) : e; // local: falha de disco como sempre; sem sessão: 401
        await this._recover();
        throw e instanceof DataError ? toHttp(e) : e;
      }
    });
  }

  // Volta ao estado confirmado: recarrega da nuvem; sem rede, usa o snapshot em memória. Invalida gravações já enfileiradas.
  async _recover() {
    let next;
    try { next = await this.backend.load(); } catch { next = this.backend.restoreSnapshot(); }
    this._replace(next);
    this._gen++;
  }

  _replace(next) {
    for (const k of Object.keys(this.data)) if (!(k in next)) delete this.data[k];
    Object.assign(this.data, next);
  }

  // Troca o backend (ex.: login → nuvem do usuário). Carrega antes de trocar: se falhar, nada muda.
  attach(backend) {
    return this._enqueue(async () => {
      let next;
      try { next = await backend.load(); } catch (e) { throw e instanceof DataError ? toHttp(e) : e; }
      const old = this.backend;
      this.backend = backend;
      this._replace(next);
      this._gen++;
      if (old !== backend) old.dispose?.();
    });
  }

  // Desliga o backend atual (ex.: logout): descarta chaves/cópias temporárias, troca pelo backend "sem sessão" e esvazia a memória.
  detach(next = new SignedOutBackend()) {
    return this._enqueue(async () => {
      const old = this.backend;
      this.backend = next;
      this._replace(next.loadSync());
      this._gen++;
      old.dispose?.();
    });
  }

  // Recarga (dados alterados por outras pessoas). Não atropela alteração local ainda não gravada.
  refresh() {
    return this._enqueue(async () => {
      if (this.backend.kind !== 'cloud' || this.backend.hasPendingChanges(this.data)) return false;
      let next;
      try { next = await this.backend.load(); } catch (e) { throw e instanceof DataError ? toHttp(e) : e; }
      this._replace(next);
      this._gen++;
      return true;
    });
  }

  // Áreas de arquivos e conteúdo dos scripts do backend atual (local ou nuvem). Sempre pedir na hora: o backend muda no login/logout.
  files(area) { return this.backend.files(area); }
  scripts() { return this.backend.scripts(); }

  project(id) {
    return this.data.projects.find((p) => p.id === id) || null;
  }
}

module.exports = { Store };
