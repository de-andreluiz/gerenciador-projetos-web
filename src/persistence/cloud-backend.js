// Backend da nuvem (Supabase) — Unit of Work sobre linhas (ADR-013/014/015).
//
//   load():   lê as linhas visíveis (RLS) → pede as DEKs dos escopos → decifra → compõe com as seções locais → applyDefaults
//             → guarda o SNAPSHOT (conteúdo lógico + revision de cada linha).
//   commit(): decompõe o estado atual → compara com o snapshot → cifra só as linhas alteradas → envia UM lote atômico
//             (public.apply_changes, com expected_revision) → arquiva projetos removidos → grava seções locais alteradas.
// Projetos nunca são apagados: removidos no app = arquivados (RPC). Execuções de checklist nunca são apagadas.
// Falhas: o chamador (Store) recarrega o estado. Nada aqui registra conteúdo, chave ou token.
'use strict';
const { applyDefaults } = require('../defaults');
const { seal, open } = require('../crypto/envelope');
const M = require('./mapping');
const { DataError } = require('./errors');
const { clone } = require('./split');
const { CloudFileArea } = require('../files/cloud-area');
const { LocalFileArea } = require('../files/local-area');
const { CloudScriptContent } = require('../files/script-content');

// Ordem/filtros de leitura por tabela. Projetos arquivados não são carregados (nem as suas execuções/contatos).
const READ = M.TABLE_ORDER.map((table) => ({ table, order: M.pkOf(table).join(','), filter: table === 'projects' ? 'archived_at=is.null' : '' }));
const CHILD_OF_PROJECT = new Set(['project_checklists', 'project_contacts']);

class CloudBackend {
  constructor({ transport, keys, local, userId }) {
    this.kind = 'cloud';
    this.transport = transport;
    this.keys = keys;
    this.local = local;
    this.userId = userId;
    this.snap = new Map(); // keyOf → { row (lógica, congelada), content, rev }
    this.localSnap = {};    // seção → JSON canônico
    this.areas = {};
    this._scripts = null;
  }

  // Arquivos (Fase 3b): evidências e imagens de e-mail no Storage (cifradas); evidências das observações de horas ficam locais (ADR-014).
  files(area) {
    if (!this.areas[area]) {
      if (area === 'evidence' || area === 'email-images') this.areas[area] = new CloudFileArea({ bucket: area, transport: this.transport, keys: this.keys, userDir: this.local.dir });
      else if (area === 'hours-evidence') this.areas[area] = new LocalFileArea(this.local.dir);
      else throw new Error(`área de arquivos desconhecida: ${area}`);
    }
    return this.areas[area];
  }
  scripts() { return (this._scripts ||= new CloudScriptContent({ transport: this.transport, userDir: this.local.dir })); }
  // Cópias decifradas temporárias ("Abrir no Windows") nunca sobrevivem à sessão.
  purgeTemp() { new CloudFileArea({ bucket: 'evidence', transport: null, keys: null, userDir: this.local.dir }).purgeTemp(); }

  async load() {
    this.purgeTemp();
    const db = {};
    for (const { table, order, filter } of READ) db[table] = await this.transport.selectAll(table, { order, filter });
    const live = new Set(db.projects.map((p) => p.id));
    for (const t of CHILD_OF_PROJECT) db[t] = db[t].filter((r) => live.has(r.project_id));

    const logical = [];
    const revs = new Map();
    const scopes = new Set();
    for (const { table } of READ) for (const r of db[table]) if (M.ENCRYPTED_TABLES.has(table)) scopes.add(M.fromDb(table, r).scope);
    if (scopes.size) await this.keys.ensure([...scopes]);
    for (const { table } of READ) {
      for (const r of db[table]) {
        const row = M.fromDb(table, r);
        if (M.ENCRYPTED_TABLES.has(table)) row.sensitive = this._open(row, r.enc);
        logical.push(row);
        revs.set(M.keyOf(table, row.key), r.revision ?? null);
      }
    }
    const localState = this.local.readAll();
    const data = applyDefaults(M.compose(logical, localState));
    this._snapshot(data, revs);
    return data;
  }

  _open(row, enc) {
    if (!enc) return {};
    try {
      return open(enc, this.keys.keyFor, { table: row.table, id: row.rowId });
    } catch (e) {
      // Fail closed: conteúdo cifrado que não abre (chave ausente/adulteração) bloqueia a carga — nunca vira dado vazio em silêncio.
      throw new DataError('CRYPTO', `${row.table}/${row.rowId}: ${e.code || 'erro'}`);
    }
  }

  _snapshot(data, revs) {
    const { rows, local } = M.decompose(data);
    const prev = this.snap;
    this.snap = new Map();
    for (const r of rows) {
      const k = M.keyOf(r.table, r.key);
      const rev = revs ? (revs.has(k) ? revs.get(k) : null) : prev.get(k)?.rev ?? null;
      this.snap.set(k, { row: Object.freeze(clone(r)), content: M.rowContent(r), rev });
    }
    this.localSnap = Object.fromEntries(Object.entries(local).map(([s, v]) => [s, M.canonical(v)]));
  }

  // Há alterações em memória ainda não gravadas? (a recarga periódica não pode atropelá-las)
  hasPendingChanges(data) {
    const { rows, local } = M.decompose(data);
    if (rows.length !== this.snap.size) return true;
    for (const r of rows) { const s = this.snap.get(M.keyOf(r.table, r.key)); if (!s || s.content !== M.rowContent(r)) return true; }
    return Object.entries(local).some(([s, v]) => this.localSnap[s] !== M.canonical(v));
  }

  // Estado do último ponto confirmado (sem rede): usado quando a gravação falha e a recarga também.
  restoreSnapshot() {
    const rows = [...this.snap.values()].map((s) => clone(s.row));
    const local = {};
    for (const [s, v] of Object.entries(this.localSnap)) local[s] = JSON.parse(v);
    return applyDefaults(M.compose(rows, local));
  }

  async commit(data) {
    const { rows, local } = M.decompose(data);
    const current = new Map(rows.map((r) => [M.keyOf(r.table, r.key), r]));
    const changes = [];
    for (const [k, r] of current) {
      const s = this.snap.get(k);
      const content = M.rowContent(r);
      if (!s || s.rev === null) { if (!s || s.content !== content) changes.push({ op: 'insert', k, r, content }); }
      else if (s.content !== content) changes.push({ op: 'update', k, r, content, rev: s.rev });
    }
    const archived = [];
    for (const [k, s] of this.snap) if (!current.has(k) && s.rev !== null && s.row.table === 'projects') archived.push(s.row.key.id);
    for (const [k, s] of this.snap) {
      if (current.has(k) || s.rev === null || s.row.table === 'projects') continue;
      const parent = s.row.cols.project_id ?? s.row.key.project_id;
      if (CHILD_OF_PROJECT.has(s.row.table) && archived.includes(parent)) continue; // vão junto com o projeto arquivado
      if (s.row.table === 'project_checklists') continue; // execução de checklist nunca é apagada
      changes.push({ op: 'delete', k, s });
    }

    const localChanged = Object.entries(local).filter(([s, v]) => this.localSnap[s] !== M.canonical(v)).map(([s]) => s);
    if (!changes.length && !archived.length && !localChanged.length) return;

    const rank = (t) => M.TABLE_ORDER.indexOf(t);
    const upserts = changes.filter((c) => c.op !== 'delete').sort((a, b) => rank(a.r.table) - rank(b.r.table));
    const deletes = changes.filter((c) => c.op === 'delete').sort((a, b) => rank(b.s.row.table) - rank(a.s.row.table));

    const scopes = upserts.filter((c) => M.ENCRYPTED_TABLES.has(c.r.table)).map((c) => c.r.scope);
    if (scopes.length) await this.keys.ensure(scopes, { create: true });

    const payload = [];
    for (const c of upserts) {
      const { r } = c;
      const values = { ...r.cols };
      if (r.doc !== undefined) values.doc = r.doc;
      if (M.ENCRYPTED_TABLES.has(r.table)) values.enc = seal(r.sensitive || {}, this.keys.current(r.scope), { table: r.table, id: r.rowId });
      if (c.op === 'insert') {
        Object.assign(values, r.insertCols || {});
        if (r.table === 'projects') Object.assign(values, { owner_id: this.userId, created_by: this.userId });
        for (const k of M.pkOf(r.table)) delete values[k];
        payload.push({ table: r.table, op: 'insert', key: r.key, values });
      } else {
        for (const k of M.pkOf(r.table)) delete values[k];
        payload.push({ table: r.table, op: 'update', key: r.key, expected_revision: c.rev, values });
      }
    }
    for (const c of deletes) payload.push({ table: c.s.row.table, op: 'delete', key: c.s.row.key, expected_revision: c.s.rev });

    let result = [];
    if (payload.length) {
      try {
        result = await this.transport.rpc('apply_changes', { p_changes: payload });
      } catch (e) {
        if (e.code === 'STALE') throw await this._classifyConflict(e, payload);
        throw e;
      }
    }
    for (const id of archived) await this.transport.rpc('project_set_archived', { p_project: id, p_archived: true });

    // Grava as seções locais só depois que a nuvem aceitou (horas/vínculos sozinhos não dependem da rede).
    for (const s of localChanged) this.local.write(s, local[s]);

    // Snapshot avança para o que foi confirmado.
    const ordered = [...upserts, ...deletes];
    (result || []).forEach((res) => {
      const c = ordered[res.i - 1];
      if (!c) return;
      if (c.op === 'delete') { this.snap.delete(c.k); return; }
      this.snap.set(c.k, { row: Object.freeze(clone(c.r)), content: c.content, rev: res.revision ?? 1 });
    });
    for (const id of archived) {
      for (const [k, s] of this.snap) {
        if ((s.row.table === 'projects' && s.row.key.id === id) || (CHILD_OF_PROJECT.has(s.row.table) && (s.row.cols.project_id ?? s.row.key.project_id) === id)) this.snap.delete(k);
      }
    }
    for (const s of localChanged) this.localSnap[s] = M.canonical(local[s]);
  }

  // GP409 = 0 linhas afetadas: alguém alterou/removeu (STALE) ou o usuário vê mas não pode editar (FORBIDDEN).
  async _classifyConflict(err, payload) {
    const i = err.conflict?.i;
    const change = payload[(i || 0) - 1];
    if (!change || change.op === 'insert') return err;
    try {
      const pk = M.pkOf(change.table);
      const filter = pk.map((k) => `${k}=eq.${encodeURIComponent(change.key[k])}`).join('&');
      const rows = await this.transport.selectAll(change.table, { order: pk.join(','), filter });
      if (rows.length && rows[0].revision === change.expected_revision) return new DataError('FORBIDDEN', 'sem permissão de edição');
    } catch { /* classificação é melhor esforço: na dúvida, trata como conflito */ }
    return err;
  }

  dispose() {
    this.purgeTemp();
    this.keys.clear();
    this.snap.clear();
    this.localSnap = {};
  }
}

module.exports = { CloudBackend };
