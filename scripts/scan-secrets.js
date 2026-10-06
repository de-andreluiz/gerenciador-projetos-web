#!/usr/bin/env node
// Varredura preventiva de segredos e dados reais antes de commitar (sem dependências).
//   node scripts/scan-secrets.js            → arquivos que entrariam no Git (rastreados + novos não ignorados)
//   node scripts/scan-secrets.js --staged   → só o que está no stage (usado pelo hook .githooks/pre-commit)
// Saída: "arquivo:linha  tipo" — NUNCA imprime o valor encontrado. Código de saída 1 se houver achado.
// Canários: se existir data/projects.json (ou GP_CANARY_FILE), valores reais (nomes de projeto, pessoas, contatos, e-mails,
// telefones, servidores) também são procurados — assim um nome de cliente copiado para um teste ou doc é barrado.
// Falso positivo numa linha específica: acrescente o comentário "scan-secrets: allow" na própria linha.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 5 * 1024 * 1024;

// Caminhos que nunca podem ir para o Git, mesmo que alguém tire do .gitignore.
const FORBIDDEN_PATHS = [
  [/^(data|backups|local-data|exports|signing|secrets)\//i, 'pasta de dados/segredos'],
  [/(^|\/)\.env(\..+)?$/i, 'arquivo .env'],
  [/(^|\/)projects\.json(\..*)?$/i, 'arquivo de dados (projects.json)'],
  [/(^|\/)audit\.log/i, 'auditoria'],
  [/\.(gphours|gpexport|pem|key|pfx|p12|dpapi)$/i, 'arquivo de exportação/chave'],
  [/\.dpapi\.json$/i, 'segredos DPAPI'],
];
const ALLOWED_PATHS = [/(^|\/)\.env\.example$/i];

// Padrões de conteúdo. Mantidos específicos para evitar ruído.
const PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/sb_publishable_[A-Za-z0-9_-]{10,}/, 'Supabase publishable key (fica no .env, não no Git)'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT (anon/service_role/sessão)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'chave privada'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'token do GitHub'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'token do GitHub (fine-grained)'],
  [/AQAAANCMnd8BFdERjHoAwE\/Cl\+sBAAAA/, 'blob DPAPI (senha protegida)'],
  [/\b(GP_KEK_V\d+|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY)\s*[=:]\s*['"]?[A-Za-z0-9+/_=.-]{20,}/, 'chave de servidor atribuída'],
  [/https:\/\/[a-z0-9]{20}\.supabase\.co/, 'URL real de projeto Supabase'],
  [/(?:^|[;"'`])\s*(password|pwd)\s*=\s*[^;'"\s<>{}]{4,}\s*;/i, 'senha em connection string'], // "…;Password=x;" (não casa com obj.password = x;)
];

const isBinary = (buf) => buf.subarray(0, 8192).includes(0);
const norm = (p) => p.replace(/\\/g, '/');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function inGitRepo() {
  try { return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; }
}

// Fora de um repositório: percorre a árvore respeitando o mínimo do .gitignore (pastas que nunca entram).
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'app', 'data', 'dist', 'backups', 'local-data'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else out.push(norm(path.relative(ROOT, full)));
  }
  return out;
}

function listFiles(staged) {
  if (staged) {
    return { files: git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean),
      read: (f) => execFileSync('git', ['show', `:${f}`], { cwd: ROOT, maxBuffer: MAX_BYTES * 2 }) };
  }
  const files = inGitRepo()
    ? git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    : walk(ROOT);
  return { files, read: (f) => fs.readFileSync(path.join(ROOT, f)) };
}

// Valores reais usados como canário (só em memória; nunca impressos).
function loadCanaries() {
  const file = process.env.GP_CANARY_FILE || path.join(ROOT, 'data', 'projects.json');
  if (!fs.existsSync(file)) return [];
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const out = new Map();
  const add = (v, kind) => { if (typeof v === 'string' && v.trim().length >= 5) out.set(v.trim().toLowerCase(), kind); };
  for (const p of d.projects || []) {
    add(p.name, 'nome de projeto real');
    for (const c of p.contacts || []) { add(c.name, 'nome de contato real'); add(c.email, 'e-mail real'); add(c.phone, 'telefone real'); }
    add(p.whatsappGroupUrl, 'link real de grupo'); add(p.rootDriveUrl, 'link real do Drive');
  }
  for (const c of d.coordinators || []) { add(c.name, 'nome de pessoa real'); add(c.email, 'e-mail real'); add(c.phone, 'telefone real'); }
  for (const c of d.connections || []) { add(c.name, 'nome de conexão real'); add(c.server, 'servidor real'); add(c.user, 'login real'); }
  for (const t of d.emailTemplates || []) for (const a of [...(t.to || []), ...(t.cc || []), ...(t.bcc || [])]) if (!String(a).startsWith('role:')) add(a, 'e-mail real');
  return [...out.entries()];
}

function scanText(text, canaries) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('scan-secrets: allow')) return;
    for (const [re, kind] of PATTERNS) if (re.test(line)) found.push([i + 1, kind]);
    if (canaries.length) {
      const low = line.toLowerCase();
      for (const [v, kind] of canaries) if (low.includes(v)) found.push([i + 1, kind]);
    }
  });
  return found;
}

function main() {
  const staged = process.argv.includes('--staged');
  const { files, read } = listFiles(staged);
  const canaries = loadCanaries();
  const self = 'scripts/scan-secrets.js';
  const findings = [];
  for (const raw of files) {
    const f = norm(raw);
    if (!ALLOWED_PATHS.some((re) => re.test(f))) {
      const bad = FORBIDDEN_PATHS.find(([re]) => re.test(f));
      if (bad) { findings.push(`${f}  ${bad[1]} (arquivo não pode ir para o Git)`); continue; }
    }
    if (f === self) continue; // os próprios padrões
    let buf;
    try { buf = read(raw); } catch { continue; } // removido no meio da varredura
    if (buf.length > MAX_BYTES) { findings.push(`${f}  arquivo grande demais para conferir (${buf.length} bytes) — confira manualmente`); continue; }
    if (isBinary(buf)) continue;
    for (const [line, kind] of scanText(buf.toString('utf8'), canaries)) findings.push(`${f}:${line}  ${kind}`);
  }
  if (findings.length) {
    console.error(`scan-secrets: ${findings.length} problema(s) — nada foi commitado.\n`);
    for (const x of findings) console.error(`  ${x}`);
    console.error('\nRemova o valor (use placeholder ou .env), ou marque a linha com "scan-secrets: allow" se for falso positivo.');
    process.exit(1);
  }
  console.log(`scan-secrets: ${files.length} arquivo(s) conferido(s)${canaries.length ? `, ${canaries.length} canário(s) de dados reais` : ''} — nenhum segredo encontrado.`);
}

if (require.main === module) main();
module.exports = { scanText, PATTERNS, FORBIDDEN_PATHS };
