// Configuração do app: sempre modo local (data\projects.json ou SQLite, sem login).
// Desenvolvimento: `.env` na raiz (lido só pelos pontos de entrada — node server.js —, nunca pelos testes).
'use strict';
const fs = require('fs');
const path = require('path');

// Lê só chaves GP_* e PORT do .env, sem sobrescrever o que já está no ambiente. Valores nunca são registrados.
function loadDotEnv(dir) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (!/^(GP_|PORT$)/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return true;
}

function appConfig(env = process.env) {
  return {
    mode: 'local',
    env: env.GP_ENV || 'dev',
    appVersion: require('../package.json').version,
  };
}

module.exports = { loadDotEnv, appConfig };
