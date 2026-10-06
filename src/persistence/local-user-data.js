// Dados locais por usuário (ADR-014): %LOCALAPPDATA%\GerenciadorProjetos\users\<uuid>\
//   hours.json            controle de horas (nunca vai à nuvem)
//   prefs.json            Workspace e preferências locais
//   bindings.json         vínculos de pastas/arquivos desta máquina (caminhos de disco)
//   secrets.dpapi.json    senhas de conexão (blobs DPAPI, como já eram no projects.json)
// Segregação por UUID do Supabase Auth (nunca por nome). Gravação atômica (.tmp → .bak → rename), como o Store local.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILES = { hours: 'hours.json', prefs: 'prefs.json', bindings: 'bindings.json', secrets: 'secrets.dpapi.json' };
const FORMAT = 1;

// Raiz dos dados locais: GP_LOCAL_DIR (testes/preview) → %LOCALAPPDATA%\GerenciadorProjetos.
function localRoot() {
  if (process.env.GP_LOCAL_DIR) return path.resolve(process.env.GP_LOCAL_DIR);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'GerenciadorProjetos');
}

class LocalUserData {
  constructor(userId, root = localRoot()) {
    if (!UUID_RE.test(String(userId || ''))) throw Object.assign(new Error('Identificador de usuário inválido para os dados locais.'), { code: 'LOCAL_USER' });
    this.userId = userId;
    this.dir = path.join(root, 'users', userId);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(section) {
    const f = FILES[section];
    if (!f) throw new Error(`Seção local desconhecida: ${section}`);
    return path.join(this.dir, f);
  }

  read(section, fallback = {}) {
    const file = this.file(section);
    if (!fs.existsSync(file)) return fallback;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      const broken = `${file}.corrompido-${Date.now()}`;
      fs.copyFileSync(file, broken);
      throw Object.assign(new Error(`Arquivo local ilegível (${path.basename(file)}); cópia guardada em ${path.basename(broken)}.`), { code: 'LOCAL_CORRUPT' });
    }
    if (parsed.userId !== this.userId) throw Object.assign(new Error(`Arquivo local de outro usuário (${path.basename(file)}).`), { code: 'LOCAL_USER' });
    return parsed.data ?? fallback;
  }

  write(section, data) {
    const file = this.file(section);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, userId: this.userId, savedAt: new Date().toISOString(), data }, null, 2), 'utf8');
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(tmp, file);
  }

  readAll() {
    const out = {};
    for (const s of Object.keys(FILES)) out[s] = this.read(s, s === 'bindings' || s === 'secrets' ? { projects: {}, lists: {} } : {});
    return out;
  }
}

module.exports = { LocalUserData, localRoot, UUID_RE, FILES };
