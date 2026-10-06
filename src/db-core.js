// Acesso ao SQL Server: teste de conexão, pré-verificação (somente leitura) e execução do plano.
// ATENÇÃO: estas funções rodam dentro do processo-filho (dbworker.js) — a biblioteca nativa do SQL Server pode ficar
// pendurada indefinidamente quando o servidor não responde, e um processo separado é o único jeito de "matá-la".
// O servidor web usa src/db.js, que orquestra o processo-filho com timeouts.
const { httpError } = require('./util');
const { assertStatementSafe } = require('./sqlplan');

const SERVER_RE = /^[\p{L}\p{N}_.\-\\() ]+$/u; // sem ';' '{' '}' '=' para não injetar na connection string
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '.', '(local)', '(localdb)']);

const hostOf = (server) => String(server || '').split('\\')[0].trim().toLowerCase();
const isLoopback = (server) => LOOPBACK.has(hostOf(server));

function validateConnection(c) {
  if (!c || !c.server || !c.database) throw httpError(400, 'Conexão incompleta: informe servidor e banco.');
  if (!SERVER_RE.test(c.server)) throw httpError(400, 'Servidor contém caracteres inválidos.');
  if (!SERVER_RE.test(c.database)) throw httpError(400, 'Nome do banco contém caracteres inválidos.');
  if (c.port && !(Number.isInteger(+c.port) && +c.port > 0 && +c.port < 65536)) throw httpError(400, 'Porta inválida.');
  if (c.auth === 'sql' && !c.user) throw httpError(400, 'Informe o usuário do SQL Server.');
}

const label = (c) => `${c.server}${c.port ? ',' + c.port : ''}`;

let ctx = null;
function nativeSql() { return (ctx ||= require('mssql/msnodesqlv8')); }
let tedious = null;
function tediousSql() { return (tedious ||= require('mssql')); }

// Avisa o processo pai assim que a conexão é estabelecida (o pai só aplica timeout até este ponto).
let onConnected = () => {};
const setOnConnected = (fn) => { onConnected = fn; };

async function open(conn, password) {
  validateConnection(conn);
  // Uma única conexão por operação (cada operação roda num processo-filho próprio).
  const common = { connectionTimeout: 15000, requestTimeout: 600000, pool: { max: 1, min: 0 } };
  const trust = conn.trustServerCertificate !== false;
  const encrypt = conn.encrypt !== false;

  if (conn.auth === 'sql') {
    const sql = tediousSql();
    const [host, instance] = conn.server.split('\\');
    const pool = new sql.ConnectionPool({
      ...common, server: host, port: conn.port ? +conn.port : undefined, database: conn.database,
      user: conn.user, password: password || '',
      options: { encrypt, trustServerCertificate: trust, instanceName: instance || undefined },
    });
    await pool.connect();
    onConnected();
    return { sql, pool };
  }

  const sql = nativeSql();
  let lastErr;
  for (const driver of ['ODBC Driver 18 for SQL Server', 'ODBC Driver 17 for SQL Server']) {
    const server = conn.port ? `${conn.server},${conn.port}` : conn.server;
    const connectionString = `Driver={${driver}};Server=${server};Database=${conn.database};Trusted_Connection=Yes;Encrypt=${encrypt ? 'Yes' : 'No'};TrustServerCertificate=${trust ? 'Yes' : 'No'};`;
    const pool = new sql.ConnectionPool({ ...common, connectionString });
    try { await pool.connect(); onConnected(); return { sql, pool }; } catch (e) { lastErr = e; try { await pool.close(); } catch { /* ignora */ } if (!/data source name not found/i.test(e.message)) break; }
  }
  throw lastErr;
}

async function withPool(conn, password, fn) {
  const h = await open(conn, password);
  // O fechamento tem limite de tempo: uma conexão presa não pode travar a operação (o processo-filho termina logo depois
  // e a conexão cai; o SQL Server desfaz qualquer transação que tenha ficado aberta).
  try { return await fn(h); } finally { await Promise.race([h.pool.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]); }
}

// Tira os prefixos do driver ([Microsoft][ODBC Driver 18 for SQL Server][SQL Server]) onde quer que apareçam.
const friendly = (e) => (e && e.message ? e.message.replace(/\[(?:Microsoft|SQL Server|ODBC[^\]]*|tedious[^\]]*)\]\s*/gi, '').replace(/^\[.*?\]\s*/g, '').slice(0, 800) : String(e));

async function identity(h) {
  const r = await h.pool.request().query('SELECT @@SERVERNAME AS server, DB_NAME() AS db, SUSER_SNAME() AS login_name, @@VERSION AS version');
  const row = r.recordset[0];
  return { server: row.server, database: row.db, login: row.login_name, version: String(row.version).split('\n')[0] };
}

async function testConnection(conn, password) {
  try {
    return await withPool(conn, password, async (h) => ({ ok: true, ...(await identity(h)) }));
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
}

// Pré-verificação SOMENTE LEITURA (SELECTs em catálogo). Informa o que existe hoje no alvo.
async function precheck(conn, password, tables) {
  return withPool(conn, password, async (h) => {
    const who = await identity(h);
    if (who.database.toLowerCase() !== conn.database.toLowerCase()) {
      throw httpError(400, `A conexão abriu o banco "${who.database}", diferente do configurado ("${conn.database}"). Operação cancelada.`);
    }
    const perm = await h.pool.request().query("SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create");
    const items = [];
    for (const t of tables) {
      const r = await h.pool.request()
        .input('s', h.sql.NVarChar(128), t.schema)
        .input('t', h.sql.NVarChar(128), t.table)
        .query(`SELECT SCHEMA_ID(@s) AS schema_id,
                       (SELECT SUM(p.rows) FROM sys.tables x JOIN sys.partitions p ON p.object_id = x.object_id AND p.index_id IN (0,1)
                         WHERE x.schema_id = SCHEMA_ID(@s) AND x.name = @t) AS row_count,
                       (SELECT COUNT(*) FROM sys.tables x WHERE x.schema_id = SCHEMA_ID(@s) AND x.name = @t) AS exists_flag`);
      const row = r.recordset[0];
      items.push({ schema: t.schema, table: t.table, schemaExists: row.schema_id !== null, exists: row.exists_flag > 0, rowCount: row.row_count === null ? null : Number(row.row_count) });
    }
    return { identity: who, canCreateTable: perm.recordset[0].can_create === 1, tables: items };
  });
}

// Saída dos scripts do usuário (mensagens de PRINT e pequenos resultados de SELECT), com limites para não inflar a memória.
// Fica só na tela da execução — nunca vai para a auditoria (pode conter dados).
const OUT_LIMITS = { messages: 500, messageChars: 2000, sets: 20, rows: 50, cols: 30, cell: 300 };
const ODBC_PREFIX = /^(?:\[[^\]]*\])+\s*/;
function newOutput(s) { return { id: s.scriptId, name: s.script, file: s.file, batches: 0, rowsAffected: 0, messages: [], results: [], truncated: false }; }
function addMessage(out, text) {
  if (out.messages.length >= OUT_LIMITS.messages) { out.truncated = true; return; }
  out.messages.push(String(text || '').replace(ODBC_PREFIX, '').slice(0, OUT_LIMITS.messageChars));
}
function addRecordsets(out, sets) {
  for (const rs of sets || []) {
    if (out.results.length >= OUT_LIMITS.sets) { out.truncated = true; return; }
    const columns = Object.keys(rs.columns || (rs[0] || {})).slice(0, OUT_LIMITS.cols);
    const cell = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v).slice(0, OUT_LIMITS.cell));
    out.results.push({ columns, rows: rs.slice(0, OUT_LIMITS.rows).map((r) => columns.map((c) => cell(r[c]))), total: rs.length });
  }
}

// Executa exatamente os comandos do plano aprovado, numa única transação.
async function executePlan(conn, password, plan, { dryRun = false, allowDestructive = false, allowDestructiveScripts = false, onProgress = () => {} } = {}) {
  for (const s of plan.statements) assertStatementSafe(s, { allowDestructive, allowDestructiveScripts }); // valida TUDO antes de abrir transação
  return withPool(conn, password, async (h) => {
    const who = await identity(h);
    if (who.database.toLowerCase() !== conn.database.toLowerCase()) throw new Error(`Banco conectado (${who.database}) difere do configurado (${conn.database}).`);
    const tx = new h.sql.Transaction(h.pool);
    await tx.begin();
    let done = 0;
    const scripts = new Map(); // resumo por script (lotes executados e linhas afetadas)
    try {
      for (const s of plan.statements) {
        const req = new h.sql.Request(tx);
        let cur = null;
        if (s.kind === 'userscript') {
          cur = scripts.get(s.scriptId) || newOutput(s);
          scripts.set(s.scriptId, cur);
          req.on('info', (m) => addMessage(cur, m && m.message));
        }
        try {
          const r = await req.batch(s.sql);
          if (cur) {
            cur.batches++;
            cur.rowsAffected += (r.rowsAffected || []).reduce((n, x) => n + (Number(x) || 0), 0);
            addRecordsets(cur, r.recordsets);
          }
        } catch (e) {
          // Diz QUAL script e QUAL lote falhou (o SQL Server só informa a linha dentro do lote).
          if (cur) {
            e.message = `Script “${s.script}”, lote ${s.batch} de ${s.of}: ${e.message}`;
            // 3998 = o script usou TRY/CATCH e "engoliu" o erro: a transação ficou condenada e o erro real só está nos PRINTs.
            if (e.number === 3998 || /n[ãa]o confirm[áa]vel|uncommittable/i.test(e.message)) {
              e.message += ' — O script capturou um erro com TRY/CATCH e a transação não pôde continuar; o erro original está nas mensagens do script (PRINT) abaixo.';
            }
            e.scriptOutput = [...scripts.values()];
          }
          throw e;
        }
        done++;
        onProgress(done, plan.statements.length, s);
      }
      if (dryRun) await tx.rollback(); else await tx.commit();
      return { committed: !dryRun, rolledBack: dryRun, statements: done, identity: who, scripts: [...scripts.values()] };
    } catch (e) {
      try { await tx.rollback(); } catch { /* transação já encerrada */ }
      e.executed = done;
      throw e;
    }
  });
}

// ---------- Execução de um script de apoio (checklist) ----------
// Mesma trava dos scripts pós-importação (assertStatementSafe, revalidada aqui dentro do processo-filho) e uma única transação:
// qualquer erro desfaz tudo o que o script fez. Devolve os resultados com limites (a tela mostra; nada vai para a auditoria).
const RUN_LIMITS = { sets: 20, rows: 1000, cols: 100, cell: 2000, messages: 500 };
async function runScript(conn, password, { name, batches, allowDestructiveScripts = false }) {
  batches.forEach((b, i) => assertStatementSafe({ kind: 'userscript', sql: b.sql, script: name, batch: i + 1, of: batches.length }, { allowDestructiveScripts }));
  return withPool(conn, password, async (h) => {
    const who = await identity(h);
    if (conn.database && who.database.toLowerCase() !== conn.database.toLowerCase()) throw httpError(400, `A conexão abriu o banco "${who.database}", diferente do escolhido ("${conn.database}"). Nada foi executado.`);
    const out = { identity: who, results: [], messages: [], affected: 0, returned: 0, batches: 0, truncated: false };
    const cell = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `0x${v.toString('hex').slice(0, 64)}${v.length > 32 ? '…' : ''}` : String(v).slice(0, RUN_LIMITS.cell));
    const tx = new h.sql.Transaction(h.pool);
    await tx.begin();
    let cur = 0;
    try {
      for (let i = 0; i < batches.length; i++) {
        cur = i;
        const req = new h.sql.Request(tx);
        req.on('info', (m) => { if (out.messages.length < RUN_LIMITS.messages) out.messages.push(String(m?.message || '').replace(ODBC_PREFIX, '').slice(0, 2000)); else out.truncated = true; });
        const r = await req.batch(batches[i].sql);
        out.batches++;
        let returned = 0;
        for (const rs of r.recordsets || []) {
          returned += rs.length;
          if (out.results.length >= RUN_LIMITS.sets) { out.truncated = true; continue; }
          const allCols = Object.keys(rs.columns || (rs[0] || {}));
          const columns = allCols.slice(0, RUN_LIMITS.cols);
          out.results.push({ columns, rows: rs.slice(0, RUN_LIMITS.rows).map((row) => columns.map((c) => cell(row[c]))), total: rs.length, hiddenColumns: allCols.length - columns.length });
        }
        out.returned += returned;
        // rowsAffected também conta as linhas devolvidas por SELECT: o que sobra são as afetadas por INSERT/UPDATE/DELETE/MERGE.
        out.affected += Math.max(0, (r.rowsAffected || []).reduce((n, x) => n + (Number(x) || 0), 0) - returned);
      }
      await tx.commit();
      return out;
    } catch (e) {
      try { await tx.rollback(); } catch { /* já encerrada */ }
      const b = batches[cur];
      const line = Number(e.lineNumber) > 0 ? b.line + Number(e.lineNumber) - 1 : null;
      e.message = `${batches.length > 1 ? `Lote ${cur + 1} de ${batches.length}${line ? `, linha ${line} do arquivo` : ''}: ` : line ? `Linha ${line}: ` : ''}${friendly(e)}`;
      e.scriptOutput = { ...out, error: { batch: cur + 1, line, number: e.number ?? null, state: e.state ?? null, severity: e.class ?? null } };
      throw e;
    }
  });
}

module.exports = { isLoopback, validateConnection, testConnection, precheck, executePlan, runScript, friendly, label, setOnConnected };
