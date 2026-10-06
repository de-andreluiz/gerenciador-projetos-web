// Área de arquivos na NUVEM (Supabase Storage, D1): o arquivo é cifrado no app (file-envelope, DEK do escopo) ANTES do upload.
//   evidence      → objeto "<projectId>/<evidenceId>"   (DEK do projeto; RLS do Storage: can_read/can_edit_project pela 1ª pasta)
//   email-images  → objeto "<imageId>"                  (DEK global; leitura: usuário ativo; envio: config.comms.manage)
// O caminho do objeto não leva nome de arquivo nem do projeto. Referência guardada nos metadados: "sb:<bucket>/<caminho>".
// Cache local: só CIPHERTEXT (users\<uuid>\cache\files). Texto em claro em disco só para "Abrir no Windows" (o programa precisa
// do arquivo): pasta users\<uuid>\tmp-open, apagada no logout, na próxima carga e após 12 h.
// Remover = tirar dos metadados; o objeto fica no Storage sob o prefixo do projeto (nunca apagar — ADR-009; expurgo é decisão de retenção).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sealFile, openFile, OVERHEAD } = require('../crypto/file-envelope');
const { DataError } = require('../persistence/errors');
const { sanitizeFileName } = require('../util');

const REF_RE = /^sb:([a-z-]{1,40})\/([A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64})?)$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEMP_TTL_MS = 12 * 60 * 60 * 1000;
const BUCKET_LIMIT = { evidence: 25 * 1024 * 1024, 'email-images': 5 * 1024 * 1024 }; // = file_size_limit da migration de Storage

const parseRef = (ref) => { const m = REF_RE.exec(String(ref || '')); return m ? { bucket: m[1], path: m[2] } : null; };

class CloudFileArea {
  constructor({ bucket, transport, keys, userDir }) {
    if (!BUCKET_LIMIT[bucket]) throw new Error(`bucket desconhecido: ${bucket}`);
    this.kind = 'cloud';
    this.bucket = bucket;
    this.transport = transport;
    this.keys = keys;
    this.cacheDir = path.join(userDir, 'cache', 'files', bucket);
    this.tempDir = path.join(userDir, 'tmp-open');
    this.maxBytes = BUCKET_LIMIT[bucket] - OVERHEAD;
  }

  // Pastas locais não existem na nuvem (mantido para a mesma interface).
  folderFor() { return ''; }
  folderForNote() { return ''; }

  _scope(objectPath) { return this.bucket === 'evidence' ? `project:${objectPath.split('/')[0]}` : 'global'; }
  _cacheFile(objectPath) { return path.join(this.cacheDir, crypto.createHash('sha256').update(objectPath).digest('hex')); }

  // ctx: { projectId (evidence), id, name }. Devolve a referência "sb:…".
  async put(ctx, buffer) {
    if (!ID_RE.test(ctx.id || '') || (this.bucket === 'evidence' && !ID_RE.test(ctx.projectId || ''))) throw new DataError('INVALID', 'identificador de arquivo inválido');
    if (buffer.length > this.maxBytes) throw Object.assign(new Error(`Arquivo grande demais para o armazenamento (máximo de ${Math.floor(this.maxBytes / 1048576)} MB).`), { status: 413 });
    const objectPath = this.bucket === 'evidence' ? `${ctx.projectId}/${ctx.id}` : ctx.id;
    const scope = this._scope(objectPath);
    await this.keys.ensure([scope], { create: true });
    const blob = sealFile(buffer, this.keys.current(scope), { bucket: this.bucket, path: objectPath });
    await this.transport.storageUpload(this.bucket, objectPath, blob);
    this._writeCache(objectPath, blob);
    return `sb:${this.bucket}/${objectPath}`;
  }

  // Metadado com referência da nuvem = existe (o download confirma). Referência local antiga (não migrada) = indisponível aqui.
  has(ref) { const r = parseRef(ref); return !!r && r.bucket === this.bucket; }

  async read(ref) {
    const r = parseRef(ref);
    if (!r || r.bucket !== this.bucket) throw new DataError('NOT_FOUND', 'arquivo ainda não migrado para a nuvem');
    let blob = this._readCache(r.path);
    if (!blob) {
      blob = await this.transport.storageDownload(this.bucket, r.path);
      this._writeCache(r.path, blob);
    }
    await this.keys.ensure([this._scope(r.path)]);
    try {
      return openFile(blob, this.keys.keyFor, { bucket: this.bucket, path: r.path });
    } catch (e) {
      this._dropCache(r.path); // cache adulterado/obsoleto não é reaproveitado
      throw new DataError('CRYPTO', e.code || 'erro');
    }
  }

  // "Abrir no Windows": cópia decifrada temporária com o nome original (o programa padrão escolhe pela extensão).
  async openPath(ref, name) {
    const buf = await this.read(ref);
    this.purgeTemp({ olderThanMs: TEMP_TTL_MS });
    const dir = path.join(this.tempDir, crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sanitizeFileName(path.basename(String(name || 'arquivo')), 'arquivo'));
    fs.writeFileSync(file, buf, { flag: 'wx' });
    return file;
  }

  async remove(ref) { const r = parseRef(ref); if (r) this._dropCache(r.path); }

  // Apaga cópias temporárias decifradas (todas, ou só as antigas). Arquivo aberto/travado pelo Windows fica para a próxima limpeza.
  purgeTemp({ olderThanMs = 0 } = {}) {
    let entries = [];
    try { entries = fs.readdirSync(this.tempDir, { withFileTypes: true }); } catch { return; }
    const now = Date.now();
    for (const e of entries) {
      const p = path.join(this.tempDir, e.name);
      try { if (!olderThanMs || now - fs.statSync(p).mtimeMs > olderThanMs) fs.rmSync(p, { recursive: true, force: true }); } catch { /* em uso */ }
    }
  }

  _readCache(objectPath) { try { return fs.readFileSync(this._cacheFile(objectPath)); } catch { return null; } }
  _writeCache(objectPath, blob) { try { fs.mkdirSync(this.cacheDir, { recursive: true }); fs.writeFileSync(this._cacheFile(objectPath), blob); } catch { /* cache é opcional */ } }
  _dropCache(objectPath) { try { fs.rmSync(this._cacheFile(objectPath), { force: true }); } catch { /* */ } }
}

module.exports = { CloudFileArea, parseRef, BUCKET_LIMIT };
