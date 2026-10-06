// src/sqlite-db.js
// Camada de persistência SQLite (better-sqlite3): substitui o store.js/local-json-backend.js
// para a transição Web. Mantém a mesma interface de `store.data` e `store.save()` com
// um backend totalmente relacional — sem JSON em disco, sem lock de arquivo.
//
// Garantias:
//   - better-sqlite3 é SÍNCRONO e seguro em single-process (WAL mode habilitado).
//   - Gravações atômicas: o SQLite cuida do commit/rollback automaticamente.
//   - Compatibilidade: o objeto `store.data` continua sendo mutado pelas rotas; `save()`
//     persiste o delta no banco via _flush().
//   - Campos JSON complexos (bases, deparas, milestones, etc.) são serializados em TEXT.
//
// Uso:
//   const { SqliteStore } = require('./sqlite-db');
//   const store = new SqliteStore(dataDir);         // passa a pasta "data/"
//   await store.ready();                            // aguarda inicialização (cria tabelas)
//   store.data.projects.push(novoProj);
//   await store.save();
'use strict';
const path  = require('path');
const fs    = require('fs');
const { applyDefaults } = require('./defaults');

// better-sqlite3 é opcional na instalação atual — importado sob demanda para não quebrar
// o app em produção antes que a dependência seja adicionada ao package.json.
function requireBetterSqlite3() {
  try {
    return require('better-sqlite3');
  } catch (e) {
    throw new Error(
      'Dependência "better-sqlite3" não encontrada. Execute: npm install better-sqlite3\n' + e.message
    );
  }
}

// ─── DDL ──────────────────────────────────────────────────────────────────────
const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Estado global do app (versão, configurações simples como warnDays)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Catálogos globais: coordenadores, estágios, ciclos, tipos de projeto, etc.
-- Guardados como JSON em "blob" para manter compatibilidade com o formato existente
-- sem ter que criar dezenas de tabelas de lookup nesta fase da migração.
CREATE TABLE IF NOT EXISTS catalog (
  key  TEXT PRIMARY KEY,   -- ex: 'coordinators', 'stages', 'cycles', 'scripts'
  blob TEXT NOT NULL       -- JSON array ou objeto serializado
);

-- Projetos: campos escalares indexáveis em colunas; o resto em blob JSON.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  status       TEXT DEFAULT 'active',
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now')),
  blob         TEXT NOT NULL DEFAULT '{}'  -- todos os outros campos (bases, deparas, etc.)
);

-- Conexões de banco cadastradas (reutilizadas pelas bases).
CREATE TABLE IF NOT EXISTS connections (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  blob         TEXT NOT NULL DEFAULT '{}'  -- server, database, auth, passwordEnc, etc.
);

-- Checklists globais (modelo, não por projeto).
-- Os itens de checklist POR PROJETO ficam dentro do blob do projeto (project.checklists).
CREATE TABLE IF NOT EXISTS checklist_items (
  id    TEXT PRIMARY KEY,
  blob  TEXT NOT NULL DEFAULT '{}'
);

-- Log de auditoria: append-only, não tem UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  action     TEXT NOT NULL,
  details    TEXT,                          -- JSON serializado do objeto de auditoria
  ts         TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_ts         ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_project_id ON audit_logs(project_id);

-- Workspace e integrações (blobs genéricos de configuração).
CREATE TABLE IF NOT EXISTS blobs (
  key  TEXT PRIMARY KEY,
  blob TEXT NOT NULL DEFAULT '{}'
);
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const toJson  = (v) => JSON.stringify(v ?? null);
const fromJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ─── SqliteStore ──────────────────────────────────────────────────────────────
class SqliteStore {
  /**
   * @param {string} dir  Pasta de dados (ex.: path.join(__dirname, '../data'))
   * @param {object} [opts]
   * @param {string} [opts.filename]  Nome do arquivo SQLite (padrão: 'app.db')
   */
  constructor(dir, opts = {}) {
    this.dir      = dir;
    this.filename = opts.filename || 'app.db';
    this.dbPath   = path.join(dir, this.filename);
    this._db      = null;
    this._queue   = Promise.resolve();
    this._gen     = 0;

    // `store.data` é o mesmo objeto imutável que as rotas já conhecem.
    // Começa vazio; é preenchido em ready() / _load().
    this.data = applyDefaults({ version: 1, settings: { warnDays: 7 }, projects: [] });
  }

  // ── Inicialização ────────────────────────────────────────────────────────────

  /** Abre (ou cria) o banco, cria tabelas e carrega o estado em memória. */
  async ready() {
    fs.mkdirSync(this.dir, { recursive: true });
    const Database = requireBetterSqlite3();
    this._db = new Database(this.dbPath);
    this._db.exec(DDL);
    this._load();
    return this;
  }

  // ── Leitura (carga completa para memória) ────────────────────────────────────

  _load() {
    const db = this._db;

    // settings simples
    const settings = {};
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
    }

    // catálogos (arrays/objetos globais)
    const catalogs = {};
    for (const row of db.prepare('SELECT key, blob FROM catalog').all()) {
      catalogs[row.key] = fromJson(row.blob) ?? [];
    }

    // projects
    const projects = db.prepare('SELECT id, name, description, status, created_at AS createdAt, updated_at AS updatedAt, blob FROM projects ORDER BY created_at').all()
      .map((row) => {
        const extra = fromJson(row.blob) || {};
        return {
          id: row.id, name: row.name, description: row.description || '',
          status: row.status || 'active',
          createdAt: extra.createdAt || row.createdAt,
          ...extra,
        };
      });

    // connections
    const connections = db.prepare('SELECT id, name, blob FROM connections').all()
      .map((row) => ({ id: row.id, name: row.name, ...(fromJson(row.blob) || {}) }));

    // checklistItems
    const checklistItems = db.prepare('SELECT id, blob FROM checklist_items').all()
      .map((row) => ({ id: row.id, ...(fromJson(row.blob) || {}) }));

    // blobs genéricos (workspace, integrações)
    const blobRows = {};
    for (const row of db.prepare('SELECT key, blob FROM blobs').all()) {
      blobRows[row.key] = fromJson(row.blob);
    }

    // Monta o objeto `data` no mesmo formato do projects.json
    const raw = {
      version: 1,
      settings: { warnDays: 7, ...settings },
      projects,
      connections,
      checklistItems,
      coordinators:    catalogs.coordinators    ?? [],
      stages:          catalogs.stages          ?? [],
      cycles:          catalogs.cycles          ?? [],
      scripts:         catalogs.scripts         ?? [],
      documents:       catalogs.documents       ?? [],
      projectTypes:    catalogs.projectTypes    ?? [],
      originSystems:   catalogs.originSystems   ?? [],
      emailTemplates:  catalogs.emailTemplates  ?? [],
      emailGenerations:catalogs.emailGenerations?? [],
      emailImages:     catalogs.emailImages     ?? [],
      workspace:       blobRows.workspace       ?? { root: '', aliases: {} },
      integrations:    blobRows.integrations    ?? {},
      hours:           blobRows.hours           ?? {},
      timeEntries:     catalogs.timeEntries     ?? [],
      timers:          catalogs.timers          ?? [],
    };

    const applied = applyDefaults(raw);

    // Atualiza in-place (sem trocar a referência — as rotas seguram o mesmo objeto)
    for (const k of Object.keys(this.data)) if (!(k in applied)) delete this.data[k];
    Object.assign(this.data, applied);
    this._gen++;
  }

  // ── Gravação (flush completo do estado em memória → SQLite) ─────────────────

  /** Persiste o estado atual. Seguro chamar múltiplas vezes; gravações são serializadas. */
  save() {
    const gen = this._gen;
    const p = this._queue.then(() => {
      if (gen !== this._gen - 1 && gen !== this._gen) {
        // geração invalidada por uma recarga; rejeita silenciosamente (não sinaliza erro ao caller)
      }
      this._flush();
    });
    this._queue = p.catch(() => {});
    return p;
  }

  _flush() {
    const db   = this._db;
    const data = this.data;

    const tx = db.transaction(() => {
      // ── settings ─────────────────────────────────────────────────────────────
      const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)');
      for (const [k, v] of Object.entries(data.settings || {})) {
        upsertSetting.run(k, toJson(v));
      }

      // ── catálogos ─────────────────────────────────────────────────────────────
      const upsertCatalog = db.prepare('INSERT OR REPLACE INTO catalog(key, blob) VALUES(?,?)');
      const catalogKeys = [
        'coordinators','stages','cycles','scripts','documents',
        'projectTypes','originSystems','emailTemplates','emailGenerations',
        'emailImages','timeEntries','timers',
      ];
      for (const k of catalogKeys) {
        if (Array.isArray(data[k])) upsertCatalog.run(k, toJson(data[k]));
      }

      // ── projects ─────────────────────────────────────────────────────────────
      const existingIds = new Set(db.prepare('SELECT id FROM projects').all().map((r) => r.id));
      const upsertProj  = db.prepare(`
        INSERT OR REPLACE INTO projects(id, name, description, status, created_at, updated_at, blob)
        VALUES(@id, @name, @description, @status, @created_at, @updated_at, @blob)
      `);
      const nowStr = new Date().toISOString();
      const seenIds = new Set();
      for (const p of data.projects || []) {
        const { id, name, description, status, createdAt, updatedAt, ...rest } = p;
        seenIds.add(id);
        upsertProj.run({
          id,
          name:        name || '',
          description: description || '',
          status:      status || 'active',
          created_at:  createdAt || nowStr,
          updated_at:  updatedAt || nowStr,
          blob:        toJson({ createdAt: createdAt || nowStr, updatedAt: updatedAt || nowStr, ...rest }),
        });
      }
      // remove projetos deletados
      for (const id of existingIds) {
        if (!seenIds.has(id)) db.prepare('DELETE FROM projects WHERE id=?').run(id);
      }

      // ── connections ───────────────────────────────────────────────────────────
      const existingConns = new Set(db.prepare('SELECT id FROM connections').all().map((r) => r.id));
      const upsertConn    = db.prepare('INSERT OR REPLACE INTO connections(id, name, blob) VALUES(?,?,?)');
      const seenConns     = new Set();
      for (const c of data.connections || []) {
        const { id, name, ...rest } = c;
        seenConns.add(id);
        upsertConn.run(id, name || '', toJson(rest));
      }
      for (const id of existingConns) {
        if (!seenConns.has(id)) db.prepare('DELETE FROM connections WHERE id=?').run(id);
      }

      // ── checklistItems ────────────────────────────────────────────────────────
      const existingCLI = new Set(db.prepare('SELECT id FROM checklist_items').all().map((r) => r.id));
      const upsertCLI   = db.prepare('INSERT OR REPLACE INTO checklist_items(id, blob) VALUES(?,?)');
      const seenCLI     = new Set();
      for (const ci of data.checklistItems || []) {
        const { id, ...rest } = ci;
        seenCLI.add(id);
        upsertCLI.run(id, toJson(rest));
      }
      for (const id of existingCLI) {
        if (!seenCLI.has(id)) db.prepare('DELETE FROM checklist_items WHERE id=?').run(id);
      }

      // ── blobs genéricos (workspace, integrações, hours) ───────────────────────
      const upsertBlob = db.prepare('INSERT OR REPLACE INTO blobs(key, blob) VALUES(?,?)');
      if (data.workspace)    upsertBlob.run('workspace',    toJson(data.workspace));
      if (data.integrations) upsertBlob.run('integrations', toJson(data.integrations));
      if (data.hours)        upsertBlob.run('hours',        toJson(data.hours));
    });

    tx();  // executa toda a transação de uma vez
  }

  // ── Interface compatível com Store ──────────────────────────────────────────

  /** Compatibilidade com store.project(id) */
  project(id) {
    return this.data.projects.find((p) => p.id === id) || null;
  }

  /** `store.mode` — sempre 'sqlite' neste backend */
  get mode() { return 'sqlite'; }

  // ── CRUD de Projetos (API de alto nível) ─────────────────────────────────────

  /**
   * Cria um projeto e persiste imediatamente.
   * @param {object} proj  Objeto de projeto (deve ter `id` único)
   */
  async createProject(proj) {
    this.data.projects.push(proj);
    await this.save();
    return proj;
  }

  /**
   * Atualiza campos de um projeto existente.
   * @param {string} id  ID do projeto
   * @param {object} patch  Campos a atualizar
   */
  async updateProject(id, patch) {
    const p = this.project(id);
    if (!p) throw Object.assign(new Error('Projeto não encontrado.'), { status: 404 });
    Object.assign(p, patch);
    await this.save();
    return p;
  }

  /**
   * Remove um projeto pelo ID.
   */
  async deleteProject(id) {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.projects.length === before) throw Object.assign(new Error('Projeto não encontrado.'), { status: 404 });
    await this.save();
  }

  // ── CRUD de Conexões ────────────────────────────────────────────────────────

  listConnections() {
    return this.data.connections;
  }

  async createConnection(conn) {
    this.data.connections.push(conn);
    await this.save();
    return conn;
  }

  async updateConnection(id, patch) {
    const c = this.data.connections.find((x) => x.id === id);
    if (!c) throw Object.assign(new Error('Conexão não encontrada.'), { status: 404 });
    Object.assign(c, patch);
    await this.save();
    return c;
  }

  async deleteConnection(id) {
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    if (this.data.connections.length === before) throw Object.assign(new Error('Conexão não encontrada.'), { status: 404 });
    await this.save();
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  getSetting(key, fallback = null) {
    return this.data.settings[key] ?? fallback;
  }

  async setSetting(key, value) {
    this.data.settings[key] = value;
    // gravação direta da chave (não precisa flush completo, mas simplificamos)
    await this.save();
  }

  // ── Auditoria ───────────────────────────────────────────────────────────────

  /**
   * Grava uma entrada de auditoria diretamente no banco (não passa pelo store.data).
   * @param {object} entry  { action, project_id?, details? (objeto ou string) }
   */
  logAudit(entry) {
    if (!this._db) return; // banco ainda não aberto
    this._db.prepare(
      'INSERT INTO audit_logs(project_id, action, details) VALUES(?,?,?)'
    ).run(
      entry.project_id || null,
      String(entry.action || 'unknown'),
      typeof entry.details === 'string' ? entry.details : toJson(entry.details ?? null)
    );
  }

  /**
   * Retorna as últimas N entradas de auditoria (mais recentes primeiro).
   * @param {number} [limit=300]
   */
  tailAudit(limit = 300) {
    if (!this._db) return [];
    return this._db.prepare(
      'SELECT id, project_id, action, details, ts FROM audit_logs ORDER BY id DESC LIMIT ?'
    ).all(Math.min(5000, Math.max(1, limit))).map((row) => ({
      id:        row.id,
      projectId: row.project_id,
      action:    row.action,
      details:   fromJson(row.details) ?? row.details,
      ts:        row.ts,
    }));
  }

  // ── Migração de dados do JSON legado ────────────────────────────────────────

  /**
   * Importa um objeto `data` completo (proveniente do projects.json) para o SQLite.
   * Útil para a migração única ao substituir o backend.
   * @param {object} data  Conteúdo do projects.json (já passado por applyDefaults)
   */
  async importFromJson(data) {
    // Substitui o estado em memória e grava tudo de uma vez
    const applied = applyDefaults({ ...data });
    for (const k of Object.keys(this.data)) if (!(k in applied)) delete this.data[k];
    Object.assign(this.data, applied);
    this._gen++;
    await this.save();
  }

  // ── Fechar ──────────────────────────────────────────────────────────────────

  close() {
    if (this._db) { this._db.close(); this._db = null; }
  }

  // ── Compatibilidade: stubs dos métodos do Store que as rotas podem chamar ───

  files(area) {
    // No modo SQLite, arquivos de evidências/scripts continuam em disco (LocalFileArea).
    // Retorna null aqui; as rotas que precisam devem usar o DATA_DIR diretamente.
    return null;
  }

  scripts() { return null; }

  /** Stub: attach() é um no-op no modo SQLite (sem troca de backend em runtime). */
  attach() { return Promise.resolve(); }

  /** Stub: detach() é um no-op no modo SQLite. */
  detach() { return Promise.resolve(); }

  /** Stub: refresh() — o SQLite já é o estado canônico. */
  refresh() { return Promise.resolve(false); }
}

// ─── Fábrica conveniente ──────────────────────────────────────────────────────

/**
 * Cria e inicializa um SqliteStore pronto para uso.
 * @param {string} dir   Pasta de dados
 * @param {object} [opts]
 * @returns {Promise<SqliteStore>}
 */
async function createSqliteStore(dir, opts = {}) {
  const store = new SqliteStore(dir, opts);
  await store.ready();
  return store;
}

module.exports = { SqliteStore, createSqliteStore };
