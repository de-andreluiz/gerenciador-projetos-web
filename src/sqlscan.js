// Análise léxica de scripts SQL escritos pelo usuário (tratamento de dados após a importação).
//
// O que faz:
//  - separa o script em lotes pelas linhas "GO" (respeitando comentários, textos e nomes entre colchetes);
//  - gera, para cada lote, uma versão "só código" (comentários, textos e identificadores entre colchetes/aspas viram
//    espaços, preservando a posição), onde as regras procuram palavras-chave sem falsos positivos;
//  - BLOQUEIA o que não cabe num script executado pelo app (troca de banco, comandos de servidor/segurança,
//    controle de transação — a transação é do app —, diretivas SQLCMD…);
//  - AVISA sobre comandos que apagam dados (DELETE/TRUNCATE/DROP) e sobre SQL dinâmico.
//
//  - VARIÁVEIS: {{NOME}} no texto é trocado pelo valor antes de analisar/executar (ex.: {{BANCO}} = banco de destino).
//    A análise e a execução usam SEMPRE o texto já substituído, e a revisão mostra esse texto.
//
// LIMITE (importante): é uma análise estática. Ela NÃO enxerga o que um EXEC('...') ou sp_executesql monta em tempo de
// execução (por isso o SQL dinâmico gera um aviso), e não substitui a leitura do script na tela de revisão.
const GO_RE = /^\s*GO(?:\s+(\d{1,4}))?\s*(?:--.*)?$/i;
const SQLCMD_RE = /^\s*:[A-Za-z]/;
const MAX_BATCHES = 500;
const MAX_REPEAT = 100;
const MAX_SCRIPT_CHARS = 1_500_000;

// Atualiza o estado léxico ao percorrer uma linha e devolve a linha "só código" (mesmo comprimento).
// Em st.lastLit fica, em paralelo, só o CONTEÚDO dos textos '...' (o resto vira espaço): é onde mora o SQL dinâmico.
function scanLine(line, st) {
  let out = '';
  let lit = '';
  const put = (c, l = ' '.repeat(c.length)) => { out += c; lit += l; };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const nx = line[i + 1];
    if (st.block > 0) {
      if (ch === '/' && nx === '*') { st.block++; put('  '); i++; } else if (ch === '*' && nx === '/') { st.block--; put('  '); i++; } else put(' ');
      continue;
    }
    if (st.str) {
      if (ch === "'") { if (nx === "'") { put('  ', "''"); i++; } else { st.str = false; put(' '); } } else put(' ', ch);
      continue;
    }
    if (st.br) {
      if (ch === ']') { if (nx === ']') { put('  '); i++; } else { st.br = false; put(' '); } } else put(' ');
      continue;
    }
    if (st.dq) {
      if (ch === '"') { if (nx === '"') { put('  '); i++; } else { st.dq = false; put(' '); } } else put(' ');
      continue;
    }
    if (ch === '-' && nx === '-') { put(' '.repeat(line.length - i)); break; }
    if (ch === '/' && nx === '*') { st.block = 1; put('  '); i++; continue; }
    if (ch === "'") { st.str = true; put(' '); continue; }
    if (ch === '[') { st.br = true; put(' '); continue; }
    if (ch === '"') { st.dq = true; put(' '); continue; }
    put(ch);
  }
  st.lastLit = lit;
  return out;
}

// Separa em lotes. Retorna { batches:[{ sql, code, startLine, repeat }], sqlcmdLines:[n], tooMany }.
function splitBatches(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const st = { block: 0, str: false, br: false, dq: false };
  const batches = [];
  const sqlcmdLines = [];
  let cur = { orig: [], code: [], lit: [], startLine: 1 };
  const flush = (repeat, nextLine) => {
    const sql = cur.orig.join('\n');
    if (sql.trim()) batches.push({ sql, code: cur.code.join('\n'), lit: cur.lit.join('\n'), startLine: cur.startLine, repeat });
    cur = { orig: [], code: [], lit: [], startLine: nextLine };
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const clear = !st.block && !st.str && !st.br && !st.dq;
    if (clear) {
      const g = GO_RE.exec(line);
      if (g) { flush(Math.min(MAX_REPEAT, Number(g[1] || 1) || 1), i + 2); continue; }
      if (SQLCMD_RE.test(line)) sqlcmdLines.push(i + 1);
    }
    cur.orig.push(line);
    cur.code.push(scanLine(line, st));
    cur.lit.push(st.lastLit);
  }
  flush(1, lines.length + 1);
  return { batches, sqlcmdLines, tooMany: batches.length > MAX_BATCHES };
}

// ---- Regras ----
// BLOQUEIO: o script não pode ser usado enquanto tiver isto.
const BLOCK_RULES = [
  { id: 'use', re: /\bUSE\b(?!\s+HINT\b)/gi, msg: 'USE (troca de banco de dados): o script deve rodar apenas na base da importação' },
  { id: 'database-ddl', re: /\b(?:CREATE|ALTER|DROP)\s+DATABASE\b/gi, msg: 'CREATE/ALTER/DROP DATABASE' },
  { id: 'backup-restore', re: /\b(?:BACKUP|RESTORE)\s+(?:DATABASE|LOG|CERTIFICATE|MASTER\s+KEY|SERVICE\s+MASTER\s+KEY|FILELISTONLY|HEADERONLY|VERIFYONLY|LABELONLY)\b/gi, msg: 'BACKUP/RESTORE' },
  { id: 'shutdown', re: /\bSHUTDOWN\b/gi, msg: 'SHUTDOWN' },
  { id: 'kill', re: /\bKILL\s+\d/gi, msg: 'KILL (encerrar sessões)' },
  { id: 'reconfigure', re: /\bRECONFIGURE\b/gi, msg: 'RECONFIGURE' },
  { id: 'xp', re: /\bxp_\w+/gi, msg: 'procedimentos estendidos (xp_*), como xp_cmdshell' },
  { id: 'sp-server', re: /\bsp_(?:configure|addlinkedserver|addlinkedsrvlogin|droplinkedsrvlogin|dropserver|addserver|addsrvrolemember|dropsrvrolemember|addrolemember|droprolemember|addlogin|droplogin|adduser|dropuser|grantdbaccess|revokedbaccess|password|makewebtask|OA\w+)\b/gi, msg: 'procedimentos de configuração de servidor/segurança (sp_configure, sp_addlinkedserver, sp_addrolemember…)' },
  { id: 'remote', re: /\b(?:OPENROWSET|OPENDATASOURCE|OPENQUERY)\b/gi, msg: 'acesso a fontes externas (OPENROWSET/OPENDATASOURCE/OPENQUERY)' },
  { id: 'bulk', re: /\bBULK\s+INSERT\b/gi, msg: 'BULK INSERT (lê arquivos do servidor)' },
  { id: 'impersonate', re: /\bEXEC(?:UTE)?\s+AS\s+(?:LOGIN|USER)\s*=/gi, msg: 'EXECUTE AS LOGIN/USER (troca de identidade)' },
  { id: 'server-objects', re: /\b(?:CREATE|ALTER|DROP)\s+(?:LOGIN|CREDENTIAL|ENDPOINT|SERVER)\b/gi, msg: 'objetos de servidor (LOGIN, CREDENTIAL, ENDPOINT, SERVER…)' },
  { id: 'tran-begin', re: /\bBEGIN\s+TRAN(?:SACTION)?\b/gi, msg: 'BEGIN TRAN: o app já executa tudo numa única transação; remova o controle de transação do script' },
  { id: 'tran-commit', re: /\bCOMMIT\b/gi, msg: 'COMMIT: o app controla a transação; remova do script' },
  { id: 'tran-rollback', re: /\bROLLBACK\b/gi, msg: 'ROLLBACK: o app controla a transação (se o script falhar, tudo é desfeito automaticamente); remova do script' },
  { id: 'tran-save', re: /\bSAVE\s+TRAN(?:SACTION)?\b/gi, msg: 'SAVE TRAN' },
  { id: 'xact-off', re: /\bSET\s+XACT_ABORT\s+OFF\b/gi, msg: 'SET XACT_ABORT OFF (o app depende de XACT_ABORT ON para desfazer tudo em caso de erro)' },
  { id: 'noexec', re: /\bSET\s+(?:NOEXEC|PARSEONLY)\s+ON\b/gi, msg: 'SET NOEXEC/PARSEONLY ON' },
];

// Dentro dos TEXTOS de um lote que usa SQL dinâmico (EXEC(...)/sp_executesql) o texto pode virar comando. Ali só valem
// as regras inequívocas (palavras como USE/COMMIT aparecem demais em mensagens de PRINT para bloquear por elas).
const DYNAMIC_BLOCK_IDS = new Set(['database-ddl', 'backup-restore', 'shutdown', 'reconfigure', 'xp', 'sp-server', 'remote', 'bulk', 'impersonate', 'server-objects']);

// AVISO/PORTÃO DE PRODUÇÃO: comandos que apagam dados ou objetos.
const DESTRUCTIVE_RULES = [
  { kw: 'DELETE', re: /\bDELETE\b/gi, skipAfter: /\bON\s+$/i }, // "ON DELETE CASCADE" (chave estrangeira) não conta
  { kw: 'TRUNCATE', re: /\bTRUNCATE\b/gi },
  { kw: 'DROP', re: /\bDROP\b/gi },
];
const COUNT_RULES = ['UPDATE', 'INSERT', 'MERGE', 'ALTER', 'CREATE'].map((kw) => ({ kw, re: new RegExp(`\\b${kw}\\b`, 'gi') }));
const DYNAMIC_RE = /\bsp_executesql\b|\bEXEC(?:UTE)?\s*\(/i;

const lineOf = (batch, index) => batch.startLine + (batch.code.slice(0, index).match(/\n/g) || []).length;

// ---- Variáveis {{NOME}} ----
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,40})\s*\}\}/g;
// Nomes das variáveis usadas no texto (maiúsculas, sem repetição, na ordem em que aparecem).
function findVariables(text) {
  const out = [];
  for (const m of String(text || '').matchAll(VAR_RE)) { const n = m[1].toUpperCase(); if (!out.includes(n)) out.push(n); }
  return out;
}
// Troca cada {{NOME}} pelo valor (values: { NOME: 'valor' }). Devolve o texto, os valores usados e os nomes sem valor.
function applyVariables(text, values = {}) {
  const used = {};
  const missing = [];
  const out = String(text || '').replace(VAR_RE, (all, name) => {
    const n = name.toUpperCase();
    const v = values[n];
    if (v === undefined || v === null || v === '') { if (!missing.includes(n)) missing.push(n); return all; }
    used[n] = String(v);
    return String(v);
  });
  return { text: out, used, missing };
}
const hasVariables = (text) => findVariables(text).length > 0;

// Analisa lotes já separados.
function analyzeBatches(split) {
  const blocked = [];
  const destructiveMap = new Map();
  const counts = {};
  let dynamic = false;
  for (const line of split.sqlcmdLines) blocked.push({ rule: 'sqlcmd', message: 'diretivas SQLCMD (:r, :setvar, :on error…) não são suportadas', line });
  for (const b of split.batches) {
    for (const rule of BLOCK_RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(b.code)) !== null) {
        blocked.push({ rule: rule.id, message: rule.msg, line: lineOf(b, m.index) });
        if (m[0].length === 0) rule.re.lastIndex++;
      }
    }
    const isDynamic = DYNAMIC_RE.test(b.code);
    // No código e, se o lote monta SQL dinâmico, também dentro dos textos (ex.: SET @SQL = N'DROP TABLE ' + ...).
    const sources = [{ text: b.code, dyn: false }, ...(isDynamic ? [{ text: b.lit, dyn: true }] : [])];
    for (const { text, dyn } of sources) {
      for (const rule of DESTRUCTIVE_RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(text)) !== null) {
          if (rule.skipAfter && rule.skipAfter.test(text.slice(0, m.index))) continue;
          const key = dyn ? `${rule.kw}*` : rule.kw;
          const cur = destructiveMap.get(key) || { kw: rule.kw, count: 0, line: lineOf(b, m.index), ...(dyn ? { dynamic: true } : {}) };
          cur.count += 1;
          destructiveMap.set(key, cur);
        }
      }
    }
    if (isDynamic) {
      for (const rule of BLOCK_RULES) {
        if (!DYNAMIC_BLOCK_IDS.has(rule.id)) continue;
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(b.lit)) !== null) {
          blocked.push({ rule: rule.id, message: `${rule.msg} — dentro de SQL dinâmico`, line: lineOf(b, m.index) });
          if (m[0].length === 0) rule.re.lastIndex++;
        }
      }
    }
    for (const rule of COUNT_RULES) {
      rule.re.lastIndex = 0;
      const n = (b.code.match(rule.re) || []).length;
      if (n) counts[rule.kw] = (counts[rule.kw] || 0) + n;
    }
    if (isDynamic) dynamic = true;
  }
  const destructive = [...destructiveMap.values()];
  for (const d of destructive) if (!d.dynamic) counts[d.kw] = d.count;
  // dedup dos bloqueios (mesma regra na mesma linha)
  const seen = new Set();
  const uniqueBlocked = blocked.filter((x) => { const k = `${x.rule}:${x.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { batches: split.batches.length, blocked: uniqueBlocked, destructive, counts, dynamic, tooManyBatches: split.tooMany };
}

// Prepara um script para execução: lotes (com GO n expandido) + análise.
function prepareScript(text) {
  const src = String(text || '');
  if (src.length > MAX_SCRIPT_CHARS) throw Object.assign(new Error('Script grande demais (máximo de ~1,5 milhão de caracteres).'), { status: 400 });
  const split = splitBatches(src);
  const analysis = { ...analyzeBatches(split), variables: findVariables(src) };
  const batches = [];
  for (const b of split.batches) for (let i = 0; i < b.repeat; i++) batches.push({ sql: b.sql, line: b.startLine });
  return { batches, analysis };
}

const analyzeScript = (text) => {
  const src = String(text || '').slice(0, MAX_SCRIPT_CHARS);
  return { ...analyzeBatches(splitBatches(src)), variables: findVariables(src) };
};

// Checagem de UM lote na hora de executar (defesa em profundidade: revalida o que vai ao servidor).
const checkBatch = (sql) => analyzeBatches(splitBatches(sql));

// Lê o conteúdo de um arquivo .sql em qualquer uma das codificações comuns (UTF-8 com/sem BOM, UTF-16, ANSI/Windows-1252).
function decodeSqlBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { const sw = Buffer.from(buf.subarray(2)); sw.swap16(); return sw.toString('utf16le'); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

module.exports = { splitBatches, analyzeScript, prepareScript, checkBatch, decodeSqlBuffer, findVariables, applyVariables, hasVariables, MAX_BATCHES, MAX_SCRIPT_CHARS };
