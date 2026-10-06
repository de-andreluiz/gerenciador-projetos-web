// Conteúdo dos scripts SQL (D5). Metadados (nome, descrição, arquivo) continuam no estado do app (tabela scripts).
//   LocalScriptContent — data\scripts\*.sql + .versoes + .removidos (comportamento de sempre).
// Interface (assíncrona): kind · dir · newFileName · exists · stat · read · write · trash · openPath · workingCopy · pushWorkingCopy
'use strict';
const { ScriptFiles } = require('../scriptstore');
const { httpError } = require('../util');

class LocalScriptContent {
  constructor(dataDir) {
    this.kind = 'local';
    this.files = new ScriptFiles(dataDir);
    this.dir = this.files.dir;
  }
  newFileName(name, taken) { return this.files.newFileName(name, taken); }
  async exists(s) { return this.files.exists(s.file); }
  existsSync(s) { return this.files.exists(s.file); } // só para exibição
  async stat(s) { return this.files.stat(s.file); }
  async read(s) { return this.files.read(s.file); }
  async write(s, text) { return this.files.write(s.file, text); }
  async trash(s) { return this.files.trash(s.file); }
  async openPath(s) { return this.files.resolve(s.file); }
  async workingCopy() { return null; } // no modo local o próprio arquivo é a versão oficial
  async pushWorkingCopy() { throw httpError(400, 'No modo local o arquivo aberto já é o script oficial: basta salvar no editor.'); }
}

module.exports = { LocalScriptContent };
