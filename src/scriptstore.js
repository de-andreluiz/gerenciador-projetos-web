// Arquivos .sql dos scripts do usuário: ficam em <data>\scripts\ (junto do que já vai no backup).
//  - .versoes\   cópia da versão anterior a cada alteração (guarda as últimas 20 de cada script)
//  - .removidos\ scripts removidos são MOVIDOS para cá, nunca apagados
// Gravação em UTF-8 com BOM (o SSMS e o Bloco de Notas reconhecem os acentos); a leitura aceita UTF-8, UTF-16 e ANSI.
const fs = require('fs');
const path = require('path');
const { decodeSqlBuffer } = require('./sqlscan');

const KEEP_VERSIONS = 20;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function slugify(name) {
  const s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'script';
}

class ScriptFiles {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'scripts');
    this.versions = path.join(this.dir, '.versoes');
    this.removed = path.join(this.dir, '.removidos');
    for (const d of [this.dir, this.versions, this.removed]) fs.mkdirSync(d, { recursive: true });
  }

  // Sempre dentro da pasta de scripts, mesmo que o nome venha adulterado (só o nome do arquivo é usado).
  resolve(file) {
    const full = path.join(this.dir, path.basename(String(file || '')));
    if (path.dirname(full) !== this.dir || !/\.sql$/i.test(full)) throw Object.assign(new Error('Arquivo de script inválido.'), { status: 400 });
    return full;
  }

  // Nome de arquivo único a partir do nome do script (foo.sql, foo-2.sql…), considerando também os já cadastrados.
  newFileName(name, taken = []) {
    const used = new Set(taken.map((f) => f.toLowerCase()));
    const base = slugify(name);
    for (let i = 1; i < 1000; i++) {
      const f = `${i === 1 ? base : `${base}-${i}`}.sql`;
      if (!used.has(f.toLowerCase()) && !fs.existsSync(path.join(this.dir, f))) return f;
    }
    throw new Error('Não foi possível gerar um nome de arquivo único.');
  }

  exists(file) { try { return fs.statSync(this.resolve(file)).isFile(); } catch { return false; } }

  stat(file) {
    try { const s = fs.statSync(this.resolve(file)); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null; } catch { return null; }
  }

  read(file) { return decodeSqlBuffer(fs.readFileSync(this.resolve(file))); }

  // Grava (UTF-8 com BOM, quebras de linha do Windows). Guarda a versão anterior se o conteúdo mudou.
  write(file, text) {
    const full = this.resolve(file);
    const body = String(text).replace(/\r\n|\n|\r/g, '\r\n');
    if (fs.existsSync(full)) {
      const prev = decodeSqlBuffer(fs.readFileSync(full)).replace(/\r\n|\n|\r/g, '\r\n');
      if (prev === body) return false;
      this._saveVersion(full);
    }
    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]));
    fs.renameSync(tmp, full);
    return true;
  }

  _saveVersion(full) {
    const base = path.basename(full, '.sql');
    fs.copyFileSync(full, path.join(this.versions, `${base}__${stamp()}.sql`));
    const mine = fs.readdirSync(this.versions).filter((f) => f.startsWith(`${base}__`)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_VERSIONS))) fs.rmSync(path.join(this.versions, old), { force: true });
  }

  // "Remover" = mover para .removidos (com data), para poder recuperar.
  trash(file) {
    const full = this.resolve(file);
    if (!fs.existsSync(full)) return null;
    const dest = path.join(this.removed, `${stamp()}__${path.basename(full)}`);
    fs.renameSync(full, dest);
    return dest;
  }
}

module.exports = { ScriptFiles, slugify };
