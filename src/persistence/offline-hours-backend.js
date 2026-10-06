// Modo offline das horas (Fase 5, plano §6.4): sem conexão com o Supabase, o último usuário que entrou NESTE usuário do Windows
// pode usar só o controle de horas — que já é local por decisão (ADR-014). Nenhum dado da nuvem é carregado nem gravado.
//   - Estado: horas da pasta do usuário (users\<uuid>\hours.json) + projetos "de referência" montados do PRÓPRIO histórico de horas
//     (id e nome já gravados nos apontamentos), só para escolher o projeto ao apontar. Nada além disso.
//   - Gravação: só a seção de horas. Qualquer outra alteração é recusada (OFFLINE) — não existe fila de sincronização silenciosa.
//   - Arquivos: só as evidências das observações de horas (locais).
'use strict';
const { applyDefaults } = require('../defaults');
const { EMPTY } = require('./local-json-backend');
const { LocalFileArea } = require('../files/local-area');
const { DataError } = require('./errors');
const { canonical, LOCAL_SECTIONS } = require('./mapping');

const HOURS_KEYS = LOCAL_SECTIONS.hours;
const INTERNAL_ID = 'internal';

class OfflineHoursBackend {
  constructor(local) {
    this.kind = 'offline';
    this.local = local;
    this._files = null;
    this.snapshot = null; // tudo que NÃO é horas, para garantir que nada fora delas é alterado
  }

  loadSync() {
    const hoursSection = this.local.read('hours', {});
    const data = applyDefaults({ ...EMPTY(), ...hoursSection });
    const known = new Map();
    for (const r of [...(data.timeEntries || []), ...(data.timers || []), ...(data.timeNotes || [])]) {
      if (r.projectId && r.projectId !== INTERNAL_ID && !known.has(r.projectId)) known.set(r.projectId, r.projectName || 'Projeto');
    }
    data.projects = [...known].map(([id, name]) => ({ id, name, offlineStub: true, coordinatorId: null, analystId: null }));
    applyDefaults(data);
    this.snapshot = canonical(this._rest(data));
    this.hoursSnap = canonical(this._hours(data));
    return data;
  }
  async load() { return this.loadSync(); }

  _hours(data) { return Object.fromEntries(HOURS_KEYS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])); }
  _rest(data) { const o = { ...data }; for (const k of HOURS_KEYS) delete o[k]; return o; }

  async commit(data) {
    if (canonical(this._rest(data)) !== this.snapshot) throw new DataError('OFFLINE', 'modo offline: só horas');
    const h = this._hours(data);
    const c = canonical(h);
    if (c === this.hoursSnap) return;
    this.local.write('hours', h);
    this.hoursSnap = c;
  }

  files(area) {
    if (area !== 'hours-evidence') throw new DataError('OFFLINE', 'modo offline: só horas');
    return (this._files ||= new LocalFileArea(this.local.dir));
  }
  scripts() { throw new DataError('OFFLINE', 'modo offline: só horas'); }
  hasPendingChanges() { return false; }
  restoreSnapshot() { return this.loadSync(); }
  dispose() {}
}

module.exports = { OfflineHoursBackend };
