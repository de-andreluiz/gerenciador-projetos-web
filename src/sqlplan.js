// Geração do PLANO de importação: lista fixa de comandos SQL que serão (ou não) executados.
// O plano é gerado aqui, mostrado ao usuário, e só o que está nele pode ser executado.
const crypto = require('crypto');
const { httpError } = require('./util');
const { checkBatch, hasVariables } = require('./sqlscan');

const MODES = ['fail', 'replace', 'backup'];
const TYPES = ['text', 'bigint', 'decimal', 'datetime', 'bit'];
const SQL_TYPE = { bigint: 'BIGINT', decimal: 'DECIMAL(38,10)', datetime: 'DATETIME2(3)', bit: 'BIT' };
const INSERT_MAX_ROWS = 1000; // limite do SQL Server para VALUES
const INSERT_MAX_CHARS = 4_000_000;
const MAX_ERRORS = 50;

// ---------- Identificadores ----------
const IDENT_RE = /^[\p{L}\p{N}_$][\p{L}\p{N}_$ \-]*$/u;

function validateIdent(name, what) {
  if (typeof name !== 'string' || !name.length) throw httpError(400, `${what}: nome vazio.`);
  if (name.length > 128) throw httpError(400, `${what} "${name.slice(0, 30)}…": máximo de 128 caracteres.`);
  if (name !== name.trim() || !IDENT_RE.test(name)) {
    throw httpError(400, `${what} "${name}": use apenas letras, números, espaço, "_", "-" ou "$" (sem começar/terminar com espaço).`);
  }
  return name;
}

function sanitizeIdent(raw, fallback) {
  let n = String(raw ?? '').normalize('NFC').replace(/[^\p{L}\p{N}_$ \-]/gu, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
  n = n.replace(/^[\s\-_]+|[\s\-_]+$/g, '').slice(0, 128);
  return n || fallback;
}

const q = (name) => `[${name.replace(/]/g, ']]')}]`;
const qualified = (schema, table) => `${q(schema)}.${q(table)}`;
const sqlString = (s) => `N'${String(s).replace(/\u0000/g, '').replace(/'/g, "''")}'`;

// ---------- Conversão de valores ----------
const p2 = (n) => String(n).padStart(2, '0');
function isoDate(d, withTime) {
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  return withTime ? `${date}T${time}.${String(d.getUTCMilliseconds()).padStart(3, '0')}` : date;
}

function numToText(n) {
  if (Number.isInteger(n)) return String(n);
  const s = String(Number(n.toPrecision(15)));
  return s.includes('e') ? n.toFixed(10).replace(/0+$/, '') : s;
}

function toText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numToText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) {
    const hasTime = v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() || v.getUTCMilliseconds();
    return hasTime ? isoDate(v, true).replace('T', ' ').replace(/\.\d+$/, '') : isoDate(v, false);
  }
  return String(v);
}

function parseDateString(s) {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  let y, mo, d, h = 0, mi = 0, se = 0;
  if (m) { [, y, mo, d] = m; h = m[4] || 0; mi = m[5] || 0; se = m[6] || 0; }
  else {
    m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/); // dd/mm/aaaa
    if (!m) return null;
    d = m[1]; mo = m[2]; y = m[3]; h = m[4] || 0; mi = m[5] || 0; se = m[6] || 0;
  }
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  const ok = dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d && +h < 24 && +mi < 60 && +se < 60;
  return ok ? dt : null;
}

const BOOL_TRUE = new Set(['true', 'sim', 's', 'yes', 'y', '1', 'verdadeiro']);
const BOOL_FALSE = new Set(['false', 'nao', 'não', 'n', 'no', '0', 'falso']);

// Retorna { lit } (literal SQL) ou { err } (mensagem).
function convertValue(v, type) {
  if (v === null || v === undefined) return { lit: 'NULL' };
  // Nunca grava objeto como texto ("[object Object]"): o leitor de XLSX já normaliza, isto é a última barreira.
  if (typeof v === 'object' && !(v instanceof Date)) return { lit: 'NULL' };
  switch (type) {
    case 'text':
      return { lit: sqlString(toText(v)) };
    case 'bigint': {
      if (typeof v === 'number' && Number.isSafeInteger(v)) return { lit: String(v) };
      if (typeof v === 'string' && /^\s*-?\d{1,19}\s*$/.test(v)) {
        const b = BigInt(v.trim());
        if (b >= -(2n ** 63n) && b < 2n ** 63n) return { lit: b.toString() };
      }
      return { err: 'não é um número inteiro válido (BIGINT)' };
    }
    case 'decimal': {
      let s = null;
      if (typeof v === 'number' && Number.isFinite(v)) s = numToText(v);
      else if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) s = v.trim();
      if (s === null) return { err: 'não é um número decimal válido (use ponto como separador)' };
      const [ip, fp = ''] = s.replace('-', '').split('.');
      if (ip.replace(/^0+/, '').length > 28 || fp.length > 10) return { err: 'excede DECIMAL(38,10)' };
      return { lit: s };
    }
    case 'datetime': {
      const d = v instanceof Date ? v : typeof v === 'string' ? parseDateString(v) : null;
      if (!d) return { err: 'não é uma data válida (aaaa-mm-dd ou dd/mm/aaaa)' };
      return { lit: `'${isoDate(d, true)}'` };
    }
    case 'bit': {
      if (typeof v === 'boolean') return { lit: v ? '1' : '0' };
      const k = String(v).trim().toLowerCase();
      if (BOOL_TRUE.has(k)) return { lit: '1' };
      if (BOOL_FALSE.has(k)) return { lit: '0' };
      return { err: 'não é um valor Sim/Não válido (BIT)' };
    }
    default:
      return { err: `tipo desconhecido: ${type}` };
  }
}

// ---------- Inferência de tipos (apenas sugestão; o padrão continua sendo texto) ----------
function suggestType(values) {
  const vals = values.filter((v) => v !== null);
  if (!vals.length) return 'text';
  if (vals.every((v) => typeof v === 'boolean')) return 'bit';
  if (vals.every((v) => v instanceof Date)) return 'datetime';
  if (vals.every((v) => (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^-?[1-9]\d{0,17}$|^0$/.test(v)))) return 'bigint';
  if (vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'decimal';
  return 'text';
}

function textSize(maxLen) {
  for (const n of [50, 100, 255, 500, 1000, 2000, 4000]) if (maxLen <= n) return String(n);
  return 'MAX';
}

// ---------- Construção do plano ----------
function stamp(now) {
  const d = new Date(now);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * @param workbook  resultado de readWorkbook()
 * @param selections [{ sheetName, schema, tableName, mode, columns:[{index,name,type}] }]
 * @param opts { env: 'local'|'prod', allowOverwrite: boolean, now }
 */
function buildPlan(workbook, selections, opts) {
  const { env, allowOverwrite = false, now = Date.now(), userScripts = [] } = opts;
  if (!Array.isArray(selections) || !selections.length) throw httpError(400, 'Selecione ao menos uma aba para importar.');

  const seen = new Set();
  const tables = [];
  const errors = [];
  const statements = [{ kind: 'set', sql: 'SET XACT_ABORT ON;' }];
  const ts = stamp(now);

  for (const sel of selections) {
    const sheet = workbook.sheets.find((s) => s.name === sel.sheetName);
    if (!sheet) throw httpError(400, `Aba não encontrada na planilha: ${sel.sheetName}`);
    const schema = validateIdent(sel.schema || 'dbo', 'Schema');
    const table = validateIdent(sel.tableName, `Tabela da aba "${sheet.name}"`);
    const mode = sel.mode || 'fail';
    if (!MODES.includes(mode)) throw httpError(400, `Modo inválido para a tabela ${table}.`);
    if (mode !== 'fail' && env === 'prod' && !allowOverwrite) {
      throw httpError(403, `Sobrescrever tabelas em PRODUÇÃO está bloqueado nesta base (tabela ${table}). Habilite explicitamente nas configurações da base ou use o modo "não sobrescrever".`);
    }
    const key = `${schema}.${table}`.toLowerCase();
    if (seen.has(key)) throw httpError(400, `Tabela duplicada no plano: ${schema}.${table}`);
    seen.add(key);

    const cols = sel.columns || [];
    if (!cols.length) throw httpError(400, `A tabela ${table} precisa de ao menos uma coluna.`);
    if (cols.length > 1024) throw httpError(400, `A tabela ${table} excede 1024 colunas.`);
    const names = new Set();
    for (const c of cols) {
      validateIdent(c.name, `Coluna da tabela ${table}`);
      if (!TYPES.includes(c.type)) throw httpError(400, `Tipo inválido na coluna ${c.name}.`);
      if (!sheet.columns.some((sc) => sc.index === c.index)) throw httpError(400, `Coluna inexistente na aba ${sheet.name}: ${c.index}`);
      const k = c.name.toLowerCase();
      if (names.has(k)) throw httpError(400, `Coluna duplicada em ${table}: ${c.name}`);
      names.add(k);
    }

    // Converte todas as linhas (valida tudo ANTES de qualquer execução).
    const literals = new Array(sheet.rows.length);
    const maxLen = cols.map(() => 0);
    for (let r = 0; r < sheet.rows.length; r++) {
      const row = new Array(cols.length);
      for (let i = 0; i < cols.length; i++) {
        const v = sheet.rows[r][cols[i].index];
        const res = convertValue(v, cols[i].type);
        if (res.err) {
          if (errors.length < MAX_ERRORS) {
            errors.push({ sheet: sheet.name, row: sheet.rowNumbers[r], column: cols[i].name, message: res.err, value: String(toText(v)).slice(0, 40) });
          }
          row[i] = 'NULL';
        } else {
          row[i] = res.lit;
          if (cols[i].type === 'text' && v !== null) maxLen[i] = Math.max(maxLen[i], toText(v).length);
        }
      }
      literals[r] = row;
    }

    const full = qualified(schema, table);
    const objectId = `N'${full.replace(/'/g, "''")}'`;
    const info = { sheet: sheet.name, schema, table, mode, rows: literals.length, columns: cols.map((c) => ({ name: c.name, type: c.type })) };
    tables.push(info);

    // 1) Tratamento de tabela existente
    if (mode === 'fail') {
      statements.push({
        kind: 'guard', table: full,
        sql: `IF OBJECT_ID(${objectId}, N'U') IS NOT NULL\n    THROW 50001, N'A tabela ${full.replace(/'/g, "''")} já existe. Nada foi alterado.', 1;`,
      });
    } else if (mode === 'replace') {
      statements.push({ kind: 'drop', table: full, sql: `IF OBJECT_ID(${objectId}, N'U') IS NOT NULL\n    DROP TABLE ${full};` });
    } else {
      const backup = `${table.slice(0, 128 - ts.length - 5)}_bkp_${ts}`;
      const bFull = qualified(schema, backup);
      info.backupName = backup;
      statements.push({
        kind: 'rename', table: full,
        sql: `IF OBJECT_ID(${objectId}, N'U') IS NOT NULL\nBEGIN\n    IF OBJECT_ID(N'${bFull}', N'U') IS NOT NULL THROW 50003, N'A tabela de backup ${backup} já existe.', 1;\n    EXEC sp_rename ${objectId}, N'${backup}', N'OBJECT';\nEND`,
      });
    }

    // 2) CREATE TABLE
    const colDefs = cols.map((c, i) => {
      const t = c.type === 'text' ? `NVARCHAR(${textSize(maxLen[i])})` : SQL_TYPE[c.type];
      return `    ${q(c.name)} ${t} NULL`;
    });
    statements.push({ kind: 'create', table: full, sql: `CREATE TABLE ${full} (\n${colDefs.join(',\n')}\n);` });

    // 3) INSERTs em lotes
    const head = `INSERT INTO ${full} (${cols.map((c) => q(c.name)).join(', ')}) VALUES\n`;
    let batch = [];
    let chars = 0;
    const flush = () => {
      if (!batch.length) return;
      statements.push({ kind: 'insert', table: full, rows: batch.length, sql: `${head}${batch.join(',\n')};` });
      batch = []; chars = 0;
    };
    for (const row of literals) {
      const line = `(${row.join(', ')})`;
      if (batch.length >= INSERT_MAX_ROWS || chars + line.length > INSERT_MAX_CHARS) flush();
      batch.push(line);
      chars += line.length;
    }
    flush();

    // 4) Verificação: se a contagem divergir, THROW → ROLLBACK de tudo.
    statements.push({
      kind: 'verify', table: full, expected: literals.length,
      sql: `IF (SELECT COUNT_BIG(*) FROM ${full}) <> ${literals.length}\n    THROW 50002, N'Contagem divergente em ${full.replace(/'/g, "''")}: esperado ${literals.length} linhas.', 1;`,
    });
  }

  // 5) Scripts do usuário: DEPOIS de todas as tabelas (e da verificação de contagem), ainda dentro da mesma transação.
  //    Cada lote do script (separado por GO) vira um comando do plano — entra no hash e é o que aparece na revisão.
  for (const sc of userScripts) {
    sc.batches.forEach((b, i) => statements.push({ kind: 'userscript', scriptId: sc.id, script: sc.name, file: sc.file, batch: i + 1, of: sc.batches.length, vars: sc.variables || {}, sql: b.sql }));
  }

  const destructive = tables
    .filter((t) => t.mode !== 'fail')
    .map((t) => ({ table: qualified(t.schema, t.table), action: t.mode === 'replace' ? 'DROP TABLE (apaga a tabela existente e os dados)' : `RENAME para ${t.backupName} (mantém os dados antigos)`, mode: t.mode }));

  const hash = crypto.createHash('sha256');
  for (const s of statements) hash.update(s.kind).update('\u0001').update(s.sql).update('\u0002');

  return { tables, statements, errors, destructive, hash: hash.digest('hex'), env };
}

// Descrição das abas de uma planilha para a tela (nomes sugeridos de tabela/colunas, tipo sugerido, amostras) — usada pela
// importação de arquivo único (/api/import/inspect) e pela importação por diretório. Nomes de tabela sugeridos são únicos
// DENTRO da planilha (2ª aba de mesmo nome sanitizado → _2).
function describeSheets(workbook) {
  const used = new Set();
  return workbook.sheets.map((s) => {
    let suggested = sanitizeIdent(s.name, 'Tabela');
    for (let i = 2; used.has(suggested.toLowerCase()); i++) suggested = `${sanitizeIdent(s.name, 'Tabela')}_${i}`;
    used.add(suggested.toLowerCase());
    const colNames = new Set();
    return {
      name: s.name, hidden: s.state !== 'visible', rowCount: s.rows.length, notes: s.notes, suggestedTable: suggested.replace(/ /g, '_'),
      columns: s.columns.map((c) => {
        let n = sanitizeIdent(c.header, `Coluna_${c.index + 1}`).replace(/ /g, '_');
        for (let i = 2; colNames.has(n.toLowerCase()); i++) n = `${n.replace(/_\d+$/, '')}_${i}`;
        colNames.add(n.toLowerCase());
        const values = s.rows.map((r) => r[c.index]);
        return {
          index: c.index, header: c.header, suggestedName: n, suggestedType: suggestType(values),
          sample: values.filter((v) => v !== null).slice(0, 3).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 40))),
        };
      }),
    };
  });
}

// Plano só com os scripts do usuário (importação por diretório: os scripts rodam no fim, numa transação própria).
// Mesmo formato de comando e mesmo hash de buildPlan; passa pela mesma trava (assertStatementSafe) na execução.
function buildScriptPlan(userScripts, { env }) {
  const statements = [{ kind: 'set', sql: 'SET XACT_ABORT ON;' }];
  for (const sc of userScripts) {
    sc.batches.forEach((b, i) => statements.push({ kind: 'userscript', scriptId: sc.id, script: sc.name, file: sc.file, batch: i + 1, of: sc.batches.length, vars: sc.variables || {}, sql: b.sql }));
  }
  const hash = crypto.createHash('sha256');
  for (const s of statements) hash.update(s.kind).update('\u0001').update(s.sql).update('\u0002');
  return { tables: [], statements, errors: [], destructive: [], hash: hash.digest('hex'), env };
}

// ---------- Script legível / exportável ----------
function scriptHeader(plan, target) {
  return [
    '-- =====================================================================',
    '-- Plano de importação de planilha (gerado pelo Gerenciador de Projetos)',
    `-- Ambiente : ${plan.env === 'prod' ? 'PRODUÇÃO' : 'LOCALHOST (teste)'}`,
    `-- Servidor : ${target.server}   Banco: ${target.database}`,
    `-- Hash     : ${plan.hash}`,
    '-- Tudo roda em UMA transação: qualquer erro desfaz todas as alterações.',
    '-- Se um lote falhar, os seguintes NÃO são executados (proteção "SET NOEXEC" abaixo): o SSMS, ao contrário do',
    '-- aplicativo, continuaria executando os lotes após um erro, e o INSERT poderia cair na tabela antiga.',
    '-- =====================================================================',
    '',
  ].join('\n');
}

// Só o texto exibido/exportado usa isto; a execução pelo aplicativo envia os comandos do plano dentro de uma
// transação do driver e para no primeiro erro. Após um erro com XACT_ABORT ON a transação é desfeita
// (@@TRANCOUNT = 0): a partir daí SET NOEXEC ON faz o restante ser apenas compilado, nunca executado.
const GUARD = 'IF @@TRANCOUNT = 0 SET NOEXEC ON; -- proteção: um lote anterior falhou\n';

function renderScript(plan, target, { preview = false } = {}) {
  const out = [scriptHeader(plan, target), 'BEGIN TRANSACTION;\nGO\n'];
  const insertsByTable = new Map();
  for (const s of plan.statements) if (s.kind === 'insert') insertsByTable.set(s.table, (insertsByTable.get(s.table) || 0) + 1);
  const shown = new Map();
  const oneLine = (t) => String(t).replace(/[\r\n]+/g, ' ');
  for (const s of plan.statements) {
    if (s.kind === 'userscript') {
      if (s.batch === 1) {
        out.push(`-- ==========================================================================\n-- Script do usuário (roda DEPOIS da importação, na mesma transação): ${oneLine(s.script)}\n-- Arquivo: ${oneLine(s.file)} — ${s.of} lote(s)\n${Object.entries(s.vars || {}).map(([k, v]) => `-- Variável {{${k}}} = ${oneLine(v)}\n`).join('')}-- ==========================================================================\n`);
      }
      // O texto do script é mostrado por inteiro (é a parte sensível); a prévia só corta lotes gigantes.
      const body = preview && s.sql.length > 20000 ? `${s.sql.slice(0, 20000)}\n-- ... (lote truncado na prévia; o script completo está no .sql exportado e na página Scripts SQL)` : s.sql;
      // A proteção fica num lote próprio: comandos como CREATE PROCEDURE/VIEW precisam ser o primeiro do lote.
      out.push(`${GUARD}GO\n${body}\nGO\n`);
      continue;
    }
    if (preview && s.kind === 'insert') {
      const n = shown.get(s.table) || 0;
      shown.set(s.table, n + 1);
      if (n === 0) {
        const cut = s.sql.length > 1500 ? `${s.sql.slice(0, 1500)}\n... (trecho; o script completo está no .sql)` : s.sql;
        out.push(`-- ${insertsByTable.get(s.table)} comando(s) INSERT em lotes de até ${INSERT_MAX_ROWS} linhas; exibindo o primeiro:\n${GUARD}${cut}\nGO\n`);
      }
      continue;
    }
    out.push(`${s.kind === 'set' ? '' : GUARD}${s.sql}\nGO\n`);
  }
  out.push(`${GUARD}COMMIT TRANSACTION;\nGO\n`);
  out.push('SET NOEXEC OFF;\nGO\n');
  return out.join('\n');
}

// ---------- Trava de segurança (defesa em profundidade) ----------
const LITERAL_RE = /N?'[^']*(?:''[^']*)*'/g;
const FORBIDDEN = /\b(DELETE|TRUNCATE|ALTER|UPDATE|MERGE|GRANT|REVOKE|DENY|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|SHUTDOWN|KILL|RECONFIGURE|USE|BACKUP|RESTORE|xp_\w+|sp_(?!rename\b)\w+)\b/i;

const RE = {
  set: /^SET XACT_ABORT ON;$/,
  guard: /^IF OBJECT_ID\(N'\[[^\]]+\]\.\[[^\]]+\]', N'U'\) IS NOT NULL\n {4}THROW 50001, N'[^']*', 1;$/,
  verify: /^IF \(SELECT COUNT_BIG\(\*\) FROM \[[^\]]+\]\.\[[^\]]+\]\) <> \d+\n {4}THROW 50002, N'[^']*', 1;$/,
  drop: /^IF OBJECT_ID\(N'\[[^\]]+\]\.\[[^\]]+\]', N'U'\) IS NOT NULL\n {4}DROP TABLE \[[^\]]+\]\.\[[^\]]+\];$/,
  rename: /^IF OBJECT_ID\(N'\[[^\]]+\]\.\[[^\]]+\]', N'U'\) IS NOT NULL\nBEGIN\n {4}IF OBJECT_ID\(N'\[[^\]]+\]\.\[[^\]]+\]', N'U'\) IS NOT NULL THROW 50003, N'[^']*', 1;\n {4}EXEC sp_rename N'\[[^\]]+\]\.\[[^\]]+\]', N'[^']+', N'OBJECT';\nEND$/,
  create: /^CREATE TABLE \[[^\]]+\]\.\[[^\]]+\] \(\n(?: {4}\[[^\]]+\] (?:NVARCHAR\((?:\d+|MAX)\)|BIGINT|DECIMAL\(38,10\)|DATETIME2\(3\)|BIT) NULL,?\n)+\);$/,
};

// Recusa qualquer comando que não seja exatamente um dos formatos gerados por buildPlan.
function assertStatementSafe(s, { allowDestructive, allowDestructiveScripts = false }) {
  const fail = (why) => { throw new Error(`Comando bloqueado pela trava de segurança (${s.kind}): ${why}`); };
  // Lote de um script do usuário: é SQL livre, então NÃO segue os formatos fixos abaixo; em vez disso é revalidado
  // aqui (mesmo analisador da criação do plano): sem bloqueios e, se apagar dados, só com autorização explícita.
  if (s.kind === 'userscript') {
    if (typeof s.sql !== 'string' || !s.sql.trim()) fail('lote de script vazio');
    if (hasVariables(s.sql)) fail(`script “${s.script}” ainda tem variável {{…}} sem substituir`);
    const a = checkBatch(s.sql);
    if (a.blocked.length) fail(`script “${s.script}”: ${a.blocked[0].message} (linha ${a.blocked[0].line} do lote ${s.batch})`);
    if (a.destructive.length && !allowDestructiveScripts) fail(`script “${s.script}” apaga dados (${a.destructive.map((d) => d.kw).join(', ')}) sem autorização para esta base/ambiente`);
    return;
  }
  if (['drop', 'rename'].includes(s.kind) && !allowDestructive) fail('comando destrutivo sem autorização explícita');
  if (s.kind === 'insert') {
    const m = s.sql.match(/^INSERT INTO \[[^\]]+\]\.\[[^\]]+\] \((?:\[[^\]]+\](?:, )?)+\) VALUES\n/);
    if (!m) fail('formato de INSERT inesperado');
    const rest = s.sql.slice(m[0].length).replace(LITERAL_RE, '').replace(/\bNULL\b/g, '');
    if (!/^[\s,();\-+.\dEe]*$/.test(rest)) fail('conteúdo inesperado fora dos valores literais');
    return;
  }
  const re = RE[s.kind];
  if (!re) fail('tipo de comando desconhecido');
  if (!re.test(s.sql)) fail('formato inesperado');
  const stripped = s.sql.replace(LITERAL_RE, "''");
  if (FORBIDDEN.test(stripped)) fail('palavra-chave proibida');
  if (s.kind !== 'drop' && /\bDROP\b/i.test(stripped)) fail('DROP fora do comando permitido');
}

module.exports = {
  MODES, TYPES, buildPlan, buildScriptPlan, describeSheets, renderScript, assertStatementSafe, convertValue, suggestType,
  validateIdent, sanitizeIdent, qualified, sqlString, textSize,
};
