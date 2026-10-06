// Área de arquivos LOCAL: o mesmo armazenamento de sempre (<pasta>\evidencias, src/evidence.js → EvidenceFiles).
// Usada no modo local para tudo e, no modo nuvem, para o que é local por decisão (evidências das observações de horas).
// Interface comum das áreas (assíncrona): put · has · read · openPath · remove · folderFor/folderForNote · maxBytes · kind
'use strict';
const fs = require('fs');
const { EvidenceFiles } = require('../evidence');

class LocalFileArea {
  constructor(dir) {
    this.kind = 'local';
    this.files = new EvidenceFiles(dir);
    this.maxBytes = Infinity; // o limite vem só da configuração de evidências
  }

  folderFor(project, stepNo, stageName) { return this.files.folderFor(project, stepNo, stageName); }
  folderForNote(date) { return this.files.folderForNote(date); }

  // ctx: { folder, id, name } — grava sem sobrescrever (nome no disco = "<id>_<nome>").
  async put(ctx, buffer) { return this.files.save(ctx.folder, ctx.id, ctx.name, buffer); }
  has(ref) { return !!this.files.stat(ref); }
  async read(ref) { return fs.readFileSync(this.files.resolve(ref)); }
  // Caminho no disco para abrir no programa padrão: o próprio arquivo.
  async openPath(ref) { return this.files.resolve(ref); }
  // "Remover" = mover para .removidas (nunca apaga).
  async remove(ref) { this.files.trash(ref); }
  purgeTemp() {}
}

module.exports = { LocalFileArea };
