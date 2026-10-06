// Configuração do app (Fase 4). Nada aqui é segredo de servidor: URL do projeto e publishable key são feitas para clientes.
//   GP_MODE=cloud  → login obrigatório e dados no Supabase (precisa de GP_SUPABASE_URL e GP_SUPABASE_PUBLISHABLE_KEY)
//   (ausente)      → modo local de sempre (data\projects.json, sem login) — padrão até a migração (Fase 6)
// Desenvolvimento: `.env` na raiz (lido só pelos pontos de entrada — node server.js / Electron —, nunca pelos testes).
'use strict';
const fs = require('fs');
const path = require('path');

// HTTPS obrigatório; HTTP só para o Supabase LOCAL de testes (loopback, Docker).
const SUPABASE_URL_RE = /^(https:\/\/[^/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;

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
  const mode = String(env.GP_MODE || '').toLowerCase() === 'cloud' ? 'cloud' : 'local';
  const cfg = {
    mode,
    supabaseUrl: String(env.GP_SUPABASE_URL || '').replace(/\/$/, ''),
    publishableKey: String(env.GP_SUPABASE_PUBLISHABLE_KEY || ''),
    env: env.GP_ENV || 'dev',
    appVersion: require('../package.json').version,
  };
  if (mode === 'cloud') {
    if (!SUPABASE_URL_RE.test(cfg.supabaseUrl)) throw new Error('GP_MODE=cloud exige GP_SUPABASE_URL (https://<ref>.supabase.co). Veja docs/SETUP-SUPABASE.md §3.');
    if (!cfg.publishableKey) throw new Error('GP_MODE=cloud exige GP_SUPABASE_PUBLISHABLE_KEY. Veja docs/SETUP-SUPABASE.md §3.');
    if (/^sb_secret_|service_role/i.test(cfg.publishableKey)) throw new Error('A chave configurada é uma SECRET/service role — nunca use isso no app. Use a publishable key.');
  }
  return cfg;
}

module.exports = { loadDotEnv, appConfig, SUPABASE_URL_RE };
