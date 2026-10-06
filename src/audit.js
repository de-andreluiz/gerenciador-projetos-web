// Trilha de auditoria (JSON Lines). Nunca grava senhas nem valores de células, só metadados.
const fs = require('fs');
const path = require('path');

class Audit {
  constructor(dir) {
    this.file = path.join(dir, 'audit.log');
    fs.mkdirSync(dir, { recursive: true });
  }

  // Modo nuvem: a auditoria local acompanha o usuário logado (users\<uuid>\audit.log); sem sessão, a pasta de logs da máquina.
  setDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'audit.log');
  }

  log(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(this.file, line + '\n', 'utf8');
  }

  tail(limit = 200) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { at: '', action: 'linha-invalida' }; }
    });
  }
}

module.exports = { Audit };
