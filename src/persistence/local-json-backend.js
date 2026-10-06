// Backend local: o data/projects.json de sempre (ADR-001). Mesmo comportamento de antes da Fase 3 — escrita atômica
// (.tmp → .bak → rename), cópia única antes da migração de checklists, arquivo ilegível → cópia + falha na inicialização.
// Continua sendo usado pela suíte de testes, pelo modo local e como ORIGEM da migração para a nuvem.
'use strict';
const fs = require('fs');
const path = require('path');
const { applyDefaults } = require('../defaults');
const { needsChecklistMigration } = require('../cycles');
const { LocalFileArea } = require('../files/local-area');
const { LocalScriptContent } = require('../files/script-content');

const EMPTY = () => ({ version: 1, settings: { warnDays: 7 }, projects: [] });

class LocalJsonBackend {
  constructor(dir) {
    this.kind = 'local';
    this.dir = dir;
    this.file = path.join(dir, 'projects.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  loadSync() {
    if (!fs.existsSync(this.file)) return applyDefaults(EMPTY());
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._backupBeforeMigration(parsed);
      return applyDefaults({ ...EMPTY(), ...parsed, settings: { ...EMPTY().settings, ...(parsed.settings || {}) } });
    } catch (e) {
      const broken = `${this.file}.corrompido-${Date.now()}`;
      fs.copyFileSync(this.file, broken);
      throw new Error(`data/projects.json ilegível (cópia salva em ${broken}): ${e.message}`);
    }
  }

  async load() { return this.loadSync(); }

  // Migração "checklists por passo do ciclo": antes de o arquivo ser reescrito no modelo novo, guarda uma cópia do original (uma vez só;
  // nunca sobrescreve uma cópia que já existe). Com ela dá para voltar ao arquivo anterior à mudança.
  _backupBeforeMigration(parsed) {
    if (!needsChecklistMigration(parsed)) return;
    const bak = `${this.file}.antes-checklists-por-ciclo.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(this.file, bak);
  }

  commit(data) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  // Arquivos: tudo na pasta de dados (evidencias\, scripts\), como sempre.
  files() { return (this._files ||= new LocalFileArea(this.dir)); }
  scripts() { return (this._scripts ||= new LocalScriptContent(this.dir)); }

  hasPendingChanges() { return false; }
  dispose() {}
}

module.exports = { LocalJsonBackend, EMPTY };
