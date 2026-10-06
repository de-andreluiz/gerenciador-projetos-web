// Conteúdo dos scripts SQL (D5). Metadados (nome, descrição, arquivo) continuam no estado do app (tabela scripts).
//   LocalScriptContent — data\scripts\*.sql + .versoes + .removidos (comportamento de sempre).
//   CloudScriptContent — conteúdo em public.script_versions (uma linha por versão, só inclusão; a atual = maior versão).
//     Gravar a versão N+1 é o controle de concorrência: duas pessoas salvando ao mesmo tempo → chave duplicada → 409 STALE_DATA.
//     Cópia de trabalho local (users\<uuid>\scripts\<arquivo>.sql) para abrir no SSMS/VS Code; “Enviar alterações” cria a versão nova
//     se ninguém alterou o script desde que a cópia foi aberta. Script removido: cópia recuperável em users\<uuid>\scripts\.removidos.
// Interface (assíncrona): kind · dir · newFileName · exists · stat · read · write · trash · openPath · workingCopy · pushWorkingCopy
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ScriptFiles, slugify } = require('../scriptstore');
const { decodeSqlBuffer } = require('../sqlscan');
const { httpError } = require('../util');
const { DataError } = require('../persistence/errors');

const crlf = (t) => String(t).replace(/\r\n|\n|\r/g, '\r\n');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const withBom = (text) => Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(crlf(text), 'utf8')]);

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

class CloudScriptContent {
  constructor({ transport, userDir }) {
    this.kind = 'cloud';
    this.transport = transport;
    this.dir = path.join(userDir, 'scripts');
    this.removedDir = path.join(this.dir, '.removidos');
    this.baseFile = path.join(this.dir, '.base.json');
    this.index = null;      // script_id → { version, created_at }
    this.indexAt = 0;
    this.contents = new Map(); // "id:versão" → texto
  }

  newFileName(name, taken = []) {
    const used = new Set(taken.map((f) => f.toLowerCase()));
    const base = slugify(name);
    for (let i = 1; i < 1000; i++) { const f = `${i === 1 ? base : `${base}-${i}`}.sql`; if (!used.has(f)) return f; }
    throw new Error('Não foi possível gerar um nome de arquivo único.');
  }

  async _latest(id, { fresh = false } = {}) {
    if (fresh || !this.index || Date.now() - this.indexAt > 5000) {
      const rows = await this.transport.selectAll('script_versions', { order: 'script_id,version', columns: 'script_id,version,created_at' });
      this.index = new Map();
      for (const r of rows) this.index.set(r.script_id, { version: r.version, created_at: r.created_at });
      this.indexAt = Date.now();
    }
    return this.index.get(id) || null;
  }

  async _content(id, version) {
    const k = `${id}:${version}`;
    if (!this.contents.has(k)) {
      const rows = await this.transport.selectAll('script_versions', { order: 'version', columns: 'content', filter: `script_id=eq.${encodeURIComponent(id)}&version=eq.${version}` });
      if (!rows.length) throw new DataError('NOT_FOUND', 'versão do script não encontrada');
      this.contents.set(k, rows[0].content);
    }
    return this.contents.get(k);
  }

  async exists(s) { return !!(await this._latest(s.id)); }
  // Só para exibição (telas síncronas): último índice conhecido; sem índice ainda, presume que existe (executar confere de verdade).
  existsSync(s) { return this.index ? this.index.has(s.id) : true; }

  async stat(s) {
    const v = await this._latest(s.id);
    if (!v) return null;
    const text = await this._content(s.id, v.version);
    return { size: Buffer.byteLength(withBom(text)), mtimeMs: Date.parse(v.created_at) || null, version: v.version };
  }

  async read(s) {
    const v = await this._latest(s.id);
    if (!v) throw httpError(404, `O conteúdo do script “${s.name}” não foi encontrado.`);
    return this._content(s.id, v.version);
  }

  // Nova versão (só se o texto mudou). Concorrência: a versão N+1 já existir = outra pessoa salvou antes → 409.
  async write(s, text) {
    const body = crlf(text);
    const cur = await this._latest(s.id, { fresh: true });
    if (cur && crlf(await this._content(s.id, cur.version)) === body) return false;
    const version = (cur?.version || 0) + 1;
    await this.transport.rpc('apply_changes', { p_changes: [{ table: 'script_versions', op: 'insert', key: { script_id: s.id, version }, values: { content: body } }] });
    this.contents.set(`${s.id}:${version}`, body);
    this.index.set(s.id, { version, created_at: new Date().toISOString() });
    // cópia de trabalho sem edição pendente acompanha a versão nova
    const wc = await this.workingCopy(s);
    if (wc && !wc.changed) this._materialize(s, body, version);
    return true;
  }

  // Remover o script: a nuvem apaga as versões junto com o cadastro; fica uma cópia recuperável nesta máquina.
  async trash(s) {
    const v = await this._latest(s.id, { fresh: true });
    if (!v) return null;
    fs.mkdirSync(this.removedDir, { recursive: true });
    const dest = path.join(this.removedDir, `${stamp()}__${path.basename(s.file)}`);
    fs.writeFileSync(dest, withBom(await this._content(s.id, v.version)));
    return dest;
  }

  _bases() { try { return JSON.parse(fs.readFileSync(this.baseFile, 'utf8')); } catch { return {}; } }
  _wcPath(s) {
    const file = path.basename(String(s.file || ''));
    if (!/\.sql$/i.test(file)) throw httpError(400, 'Arquivo de script inválido.');
    return path.join(this.dir, file);
  }
  _materialize(s, text, version) {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = this._wcPath(s);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, withBom(text));
    fs.renameSync(tmp, p);
    const bases = this._bases();
    bases[s.id] = { file: path.basename(p), version, sha: sha(crlf(text)) };
    fs.writeFileSync(this.baseFile, JSON.stringify(bases, null, 2));
    return p;
  }

  // Abrir no SSMS/VS Code: cria/atualiza a cópia de trabalho; edição local ainda não enviada NUNCA é sobrescrita.
  async openPath(s) {
    const text = await this.read(s);
    const v = await this._latest(s.id);
    const wc = await this.workingCopy(s);
    if (wc && wc.changed) return wc.path;
    return this._materialize(s, text, v.version);
  }

  // Estado da cópia de trabalho: { path, changed (editada e não enviada), stale (há versão mais nova na nuvem) } ou null.
  async workingCopy(s) {
    const p = this._wcPath(s);
    const base = this._bases()[s.id];
    if (!base || !fs.existsSync(p)) return null;
    const local = crlf(decodeSqlBuffer(fs.readFileSync(p)));
    const v = await this._latest(s.id);
    return { path: p, changed: sha(local) !== base.sha, stale: !!v && v.version !== base.version, baseVersion: base.version, text: local };
  }

  // “Enviar alterações”: a cópia de trabalho vira a versão nova — só se ninguém mudou o script desde que ela foi aberta.
  async pushWorkingCopy(s, validate = (t) => t) {
    const wc = await this.workingCopy(s);
    if (!wc) throw httpError(400, 'Este script ainda não foi aberto nesta máquina (nenhuma cópia de trabalho).');
    if (!wc.changed) return { pushed: false };
    const cur = await this._latest(s.id, { fresh: true });
    if (cur && cur.version !== wc.baseVersion) {
      throw httpError(409, `O script “${s.name}” foi alterado por outra pessoa depois que você abriu a cópia. Copie suas alterações, abra de novo e reaplique.`, { code: 'SCRIPT_WC_CONFLICT' });
    }
    const text = validate(wc.text);
    await this.write(s, text);
    this._materialize(s, text, (await this._latest(s.id)).version);
    return { pushed: true };
  }
}

module.exports = { LocalScriptContent, CloudScriptContent };
