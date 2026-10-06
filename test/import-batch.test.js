// Importação de planilhas por DIRETÓRIO (lote) + regressão da importação de arquivo único.
// O SQL Server é simulado (db.precheck / db.executePlan): o que se testa é o pipeline do app (descoberta, seleção, nomes,
// plano/hash, transação por aba, scripts no fim). A execução real em banco é coberta por scripts/e2e-local.js (localhost).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ib-'));
const PORT = 4454;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const db = require('../src/db');
const B = require('../src/import-batch');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- banco simulado ----------
const existing = new Set(); // tabelas que "já existem" no destino
const executed = []; // um registro por plano executado: { tables, kinds, dryRun }
let failTable = null; // simula erro de execução numa tabela
db.precheck = async (conn, pw, tables) => ({
  identity: { server: 'LOCALHOST', database: conn.database, login: 'teste', version: 'x' }, canCreateTable: true,
  tables: tables.map((t) => ({ exists: existing.has(`${t.schema}.${t.table}`.toLowerCase()), rowCount: 3, schemaExists: true })),
});
db.executePlan = async (conn, pw, plan, opts) => {
  const tables = [...new Set(plan.statements.filter((s) => s.table).map((s) => s.table))];
  if (failTable && tables.some((t) => t.includes(failTable))) { const e = new Error(`Falha simulada em ${failTable}`); e.executed = 1; throw e; }
  executed.push({ tables, kinds: plan.statements.map((s) => s.kind), dryRun: !!opts.dryRun, scripts: plan.statements.filter((s) => s.kind === 'userscript').map((s) => s.script) });
  opts.onProgress && opts.onProgress(plan.statements.length);
  return { committed: !opts.dryRun, scripts: plan.statements.some((s) => s.kind === 'userscript') ? [{ name: 'X', batches: 1, rowsAffected: 0, messages: [], results: [] }] : [] };
};

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };
async function xlsx(file, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows, state] of sheets) { const ws = wb.addWorksheet(name); if (state) ws.state = state; rows.forEach((r) => ws.addRow(r)); }
  await wb.xlsx.writeFile(file);
}
const waitJob = async (id) => { for (let i = 0; i < 200; i++) { const j = ok(await api('GET', `/api/jobs/${id}`)); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 25)); } throw new Error('job não terminou'); };

const S = {};
test('preparação: diretório com várias planilhas, projeto, base local e planilha em modo diretório', async () => {
  S.dir = path.join(tmp, 'DadosOrigem'); fs.mkdirSync(S.dir);
  await xlsx(path.join(S.dir, 'PFUNC.xlsx'), [['PFUNC', [['CHAPA', 'NOME'], ['001', 'Ana'], ['002', 'Bia']]], ['PFDEPEND', [['CHAPA', 'DEP'], ['001', 'Filho']]], ['CONFIG', [['k', 'v'], ['a', 'b']]]]);
  await xlsx(path.join(S.dir, 'PPESSOA.xlsx'), [['Planilha1', [['CODIGO', 'NOME'], ['10', 'Ana'], ['11', 'Bia']]]]); // uma aba relevante → nome do arquivo
  await xlsx(path.join(S.dir, 'A.xlsx'), [['FUNCIONARIOS', [['ID'], ['1']]], ['Oculta', [['x'], ['1']], 'hidden']]);
  await xlsx(path.join(S.dir, 'B.xlsx'), [['FUNCIONARIOS', [['ID'], ['2']]], ['OUTRA', [['y'], ['2']]]]);
  fs.writeFileSync(path.join(S.dir, 'Corrompida.xlsx'), Buffer.from('PK isto não é um xlsx'));
  fs.writeFileSync(path.join(S.dir, '~$PFUNC.xlsx'), Buffer.from('lock do Excel'));
  fs.writeFileSync(path.join(S.dir, 'leia-me.txt'), 'texto');
  S.p = ok(await api('POST', '/api/projects', { name: 'Cliente A' }));
  S.p = ok(await api('POST', `/api/projects/${S.p.id}/bases`, { name: 'Base A', local: { server: 'localhost', database: 'GP_TESTE', auth: 'windows' } }));
  S.base = S.p.bases[0];
  assert.equal((await api('POST', `/api/projects/${S.p.id}/deparas`, { label: 'Lote', importMode: 'dir' })).status, 400); // diretório obrigatório
  S.p = ok(await api('POST', `/api/projects/${S.p.id}/deparas`, { label: 'Lote origem', importMode: 'dir', sourceDir: S.dir }));
  S.d = S.p.deparas[0];
  assert.equal(S.d.importMode, 'dir'); assert.equal(S.d.sourceDirExists, true);
});

test('descoberta: só .xlsx do diretório (sem temporário ~$ nem outros tipos), em ordem; diretório inexistente/vazio tratados', async () => {
  const r = ok(await api('POST', '/api/import/batch/scan', { projectId: S.p.id, deparaId: S.d.id }));
  assert.deepEqual(r.files.map((f) => f.name), ['A.xlsx', 'B.xlsx', 'Corrompida.xlsx', 'PFUNC.xlsx', 'PPESSOA.xlsx']);
  // vazio
  const empty = path.join(tmp, 'Vazio'); fs.mkdirSync(empty);
  const p2 = ok(await api('POST', `/api/projects/${S.p.id}/deparas`, { label: 'Vazio', importMode: 'dir', sourceDir: empty }));
  const dv = p2.deparas.find((x) => x.label === 'Vazio');
  assert.deepEqual(ok(await api('POST', '/api/import/batch/scan', { projectId: S.p.id, deparaId: dv.id })).files, []);
  // inexistente (apagado depois de configurado)
  fs.rmdirSync(empty);
  const gone = await api('POST', '/api/import/batch/scan', { projectId: S.p.id, deparaId: dv.id });
  assert.equal(gone.status, 400); assert.equal(gone.json.code, 'BATCH_DIR_MISSING'); assert.match(gone.json.error, /não existe/);
  // nome de arquivo vindo da tela nunca vira caminho
  for (const bad of ['..\\segredo.xlsx', 'C:\\x.xlsx', 'sub/x.xlsx', 'x.txt', '~$PFUNC.xlsx']) {
    assert.equal((await api('POST', '/api/import/batch/sheets', { projectId: S.p.id, deparaId: S.d.id, file: bad })).status, 400, bad);
  }
});

test('abas por arquivo e nome sugerido (aba; arquivo quando há uma única aba relevante); arquivo inválido = erro isolado', async () => {
  const pf = ok(await api('POST', '/api/import/batch/sheets', { projectId: S.p.id, deparaId: S.d.id, file: 'PFUNC.xlsx' }));
  assert.deepEqual(pf.sheets.map((s) => [s.name, s.base, s.rowCount]), [['PFUNC', 'PFUNC', 2], ['PFDEPEND', 'PFDEPEND', 1], ['CONFIG', 'CONFIG', 1]]);
  const pp = ok(await api('POST', '/api/import/batch/sheets', { projectId: S.p.id, deparaId: S.d.id, file: 'PPESSOA.xlsx' }));
  assert.equal(pp.sheets[0].base, 'PPESSOA'); // aba "Planilha1", mas o arquivo só tem ela → nome do arquivo
  const a = ok(await api('POST', '/api/import/batch/sheets', { projectId: S.p.id, deparaId: S.d.id, file: 'A.xlsx' }));
  assert.equal(a.sheets[0].base, 'A'); // só uma aba visível com dados → nome do arquivo
  const bad = await api('POST', '/api/import/batch/sheets', { projectId: S.p.id, deparaId: S.d.id, file: 'Corrompida.xlsx' });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /Não foi possível ler a planilha/);
});

test('regras puras: colisão de nomes gera _2 previsível; nome personalizado nunca muda; duplicadas detectadas', () => {
  assert.deepEqual(B.assignNames([{ base: 'FUNCIONARIOS' }, { base: 'FUNCIONARIOS' }, { base: 'X', custom: 'FUNCIONARIOS_2' }, { base: 'FUNCIONARIOS' }]), ['FUNCIONARIOS', 'FUNCIONARIOS_3', 'FUNCIONARIOS_2', 'FUNCIONARIOS_4']);
  assert.deepEqual(B.baseNames('Folha de Pagto.xlsx', [{ name: 'Dados', hidden: false, rowCount: 3 }, { name: 'Vazia', hidden: false, rowCount: 0 }]), ['Folha_de_Pagto', 'Vazia']);
  assert.equal(B.duplicateTables([{ schema: 'dbo', table: 'X', file: 'a', sheet: '1' }, { schema: 'dbo', table: 'x', file: 'b', sheet: '1' }]).length, 1);
});

const planBody = (items, extra = {}) => ({ projectId: S.p.id, baseId: S.base.id, deparaId: S.d.id, env: 'local', schema: 'dbo', items, ...extra });

test('mesma aba em dois arquivos NUNCA vai para a mesma tabela: o plano é bloqueado com mensagem clara', async () => {
  const r = ok(await api('POST', '/api/import/batch/plan', planBody([{ file: 'A.xlsx', sheet: 'FUNCIONARIOS', table: 'FUNCIONARIOS' }, { file: 'B.xlsx', sheet: 'FUNCIONARIOS', table: 'funcionarios' }])));
  assert.equal(r.blocked, true); assert.match(r.issues[0], /escolhida para duas abas/);
  assert.equal((await api('POST', `/api/import/batch/plans/${r.planId}/execute`, { hash: r.hash, authorized: true })).status, 409);
});

test('lote: só arquivos/abas selecionados; nome personalizado respeitado; arquivo inválido e aba removida isolados; transação por aba', async () => {
  executed.length = 0;
  const items = [
    { file: 'PFUNC.xlsx', sheet: 'PFUNC', table: 'ZORI_PFUNC' }, // nome personalizado
    { file: 'PFUNC.xlsx', sheet: 'PFDEPEND', table: 'PFDEPEND' }, // CONFIG não selecionada
    { file: 'PPESSOA.xlsx', sheet: 'Planilha1', table: 'PPESSOA' },
    { file: 'Corrompida.xlsx', sheet: 'X', table: 'CORROMPIDA' },
    { file: 'B.xlsx', sheet: 'NAO_EXISTE', table: 'SUMIU' },
  ];
  const r = ok(await api('POST', '/api/import/batch/plan', planBody(items)));
  assert.equal(r.blocked, false); assert.equal(r.runnable, 3);
  const st = Object.fromEntries(r.items.map((x) => [`${x.file}/${x.sheet}`, x]));
  assert.equal(st['PFUNC.xlsx/PFUNC'].table, 'ZORI_PFUNC'); assert.equal(st['PFUNC.xlsx/PFUNC'].rows, 2);
  assert.equal(st['Corrompida.xlsx/X'].status, 'blocked'); assert.match(st['Corrompida.xlsx/X'].reason, /Não foi possível ler a planilha/);
  assert.equal(st['B.xlsx/NAO_EXISTE'].status, 'blocked'); assert.match(st['B.xlsx/NAO_EXISTE'].reason, /não existe mais/);
  const run = ok(await api('POST', `/api/import/batch/plans/${r.planId}/execute`, { hash: r.hash, authorized: true }));
  const j = await waitJob(run.jobId);
  assert.equal(j.status, 'done'); assert.deepEqual(j.result, { ok: 3, failed: 0, skipped: 2 });
  assert.deepEqual(executed.map((e) => e.tables[0]), ['[dbo].[ZORI_PFUNC]', '[dbo].[PFDEPEND]', '[dbo].[PPESSOA]']); // uma transação (plano) por aba
  assert.ok(executed.every((e) => e.tables.length === 1 && e.kinds[0] === 'set' && e.kinds.includes('create') && e.kinds.includes('verify')));
  assert.equal(executed.some((e) => e.tables.join().includes('CONFIG')), false);
  assert.equal((await api('POST', `/api/import/batch/plans/${r.planId}/execute`, { hash: r.hash, authorized: true })).status, 409); // uso único
});

test('falha numa aba não esconde as demais; scripts pós-importação não rodam se houve falha e rodam no fim quando tudo deu certo', async () => {
  const scr = ok(await api('POST', '/api/scripts', { name: 'POS_LOTE', content: 'SELECT 1;' }));
  executed.length = 0; failTable = '[T2]';
  let r = ok(await api('POST', '/api/import/batch/plan', planBody([{ file: 'PFUNC.xlsx', sheet: 'PFUNC', table: 'T1' }, { file: 'PFUNC.xlsx', sheet: 'PFDEPEND', table: 'T2' }, { file: 'PPESSOA.xlsx', sheet: 'Planilha1', table: 'T3' }], { scriptIds: [scr.id] })));
  assert.equal(r.userScripts.length, 1); assert.match(r.scriptPreview, /SELECT 1/);
  let j = await waitJob(ok(await api('POST', `/api/import/batch/plans/${r.planId}/execute`, { hash: r.hash, authorized: true })).jobId);
  failTable = null;
  assert.deepEqual(j.items.map((x) => x.status), ['done', 'error', 'done']);
  assert.match(j.items[1].error, /Falha simulada/);
  assert.equal(j.scripts.status, 'skipped'); assert.match(j.scripts.reason, /1 aba\(s\) falharam/);
  assert.equal(executed.some((e) => e.scripts.length), false);
  // tudo certo → scripts no fim, numa transação própria
  executed.length = 0;
  r = ok(await api('POST', '/api/import/batch/plan', planBody([{ file: 'PFUNC.xlsx', sheet: 'PFUNC', table: 'T4' }], { scriptIds: [scr.id] })));
  j = await waitJob(ok(await api('POST', `/api/import/batch/plans/${r.planId}/execute`, { hash: r.hash, authorized: true })).jobId);
  assert.equal(j.scripts.status, 'done');
  assert.deepEqual(executed.map((e) => e.scripts), [[], ['POS_LOTE']]);
  assert.deepEqual(executed[1].kinds, ['set', 'userscript']);
});

test('tabela existente em "não sobrescrever" bloqueia só a aba; planilha alterada depois da revisão é recusada na execução', async () => {
  existing.add('dbo.t5');
  let r = ok(await api('POST', '/api/import/batch/plan', planBody([{ file: 'PFUNC.xlsx', sheet: 'PFUNC', table: 'T5' }, { file: 'PFUNC.xlsx', sheet: 'PFDEPEND', table: 'T6' }])));
  assert.deepEqual(r.items.map((x) => x.status), ['blocked', 'ok']); assert.match(r.items[0].reason, /já existe/);
  r = ok(await api('POST', '/api/import/batch/plan', planBody([{ file: 'PFUNC.xlsx', sheet: 'PFUNC', table: 'T5', mode: 'replace' }])));
  assert.equal(r.items[0].status, 'ok');
  existing.clear();
  // muda o arquivo entre a revisão e a execução
  r = ok(await api('POST', '/api/import/batch/plan', planBody([{ file: 'PPESSOA.xlsx', sheet: 'Planilha1', table: 'T7' }])));
  await xlsx(path.join(S.dir, 'PPESSOA.xlsx'), [['Planilha1', [['CODIGO', 'NOME'], ['10', 'Ana'], ['11', 'Bia'], ['12', 'Caio']]]]);
  const j = await waitJob(ok(await api('POST', `/api/import/batch/plans/${r.planId}/execute`, { hash: r.hash, authorized: true })).jobId);
  assert.equal(j.items[0].status, 'error'); assert.match(j.items[0].error, /mudou depois da revisão/);
});

test('configuração lembrada por planilha (seleção e nomes, nunca o modo)', async () => {
  ok(await api('PUT', `/api/projects/${S.p.id}/deparas/${S.d.id}/batch-config`, { schema: 'dbo', files: [{ name: 'PFUNC.xlsx', include: true, sheets: [{ sheetName: 'PFUNC', include: true, tableName: 'ZORI_PFUNC', mode: 'replace' }] }] }));
  const d = ok(await api('GET', '/api/state')).projects.find((p) => p.id === S.p.id).deparas.find((x) => x.id === S.d.id);
  assert.equal(d.batchConfig.files[0].sheets[0].tableName, 'ZORI_PFUNC'); assert.equal(d.batchConfig.files[0].sheets[0].mode, undefined);
});

test('REGRESSÃO: importação de arquivo único continua funcionando (inspect → plano → execução numa transação)', async () => {
  const dest = path.join(tmp, 'unico'); fs.mkdirSync(dest);
  const src = path.join(tmp, 'Unico.xlsx');
  await xlsx(src, [['Clientes', [['COD', 'NOME'], ['007', 'Zé'], ['008', 'Lu']]], ['Itens', [['SKU'], ['A1']]]]);
  let p = ok(await api('POST', `/api/projects/${S.p.id}/deparas`, { label: 'Arquivo único', targetDir: dest }));
  const d = p.deparas.find((x) => x.label === 'Arquivo único');
  assert.equal(d.importMode, 'file');
  p = ok(await api('POST', `/api/projects/${S.p.id}/deparas/${d.id}/attach`, { filePath: src })).project;
  const filePath = p.deparas.find((x) => x.id === d.id).lastDownload.path;
  const ins = ok(await api('POST', '/api/import/inspect', { filePath }));
  assert.deepEqual(ins.sheets.map((s) => [s.name, s.suggestedTable, s.rowCount, s.columns.map((c) => c.suggestedName)]), [['Clientes', 'Clientes', 2, ['COD', 'NOME']], ['Itens', 'Itens', 1, ['SKU']]]);
  assert.equal(ins.sheets[0].columns[0].sample[0], '007');
  // modo de arquivo único não aceita as rotas do lote
  assert.equal((await api('POST', '/api/import/batch/scan', { projectId: S.p.id, deparaId: d.id })).status, 400);
  executed.length = 0;
  const sheets = ins.sheets.map((s) => ({ sheetName: s.name, schema: 'dbo', tableName: s.suggestedTable, mode: 'fail', columns: s.columns.map((c) => ({ index: c.index, name: c.suggestedName, type: 'text' })) }));
  const pl = ok(await api('POST', '/api/import/plan', { projectId: S.p.id, baseId: S.base.id, env: 'local', filePath, deparaId: d.id, sheets, scriptIds: [], scriptVars: {} }));
  assert.equal(pl.blocked, false); assert.equal(pl.tables.length, 2);
  const run = ok(await api('POST', `/api/import/plans/${pl.planId}/execute`, { hash: pl.hash, authorized: true }));
  const j = await waitJob(run.jobId);
  assert.equal(j.status, 'done');
  assert.equal(executed.length, 1); // arquivo único: as duas abas numa transação só (comportamento de sempre)
  assert.deepEqual(executed[0].tables, ['[dbo].[Clientes]', '[dbo].[Itens]']);
});

test('auditoria do lote registra plano, itens e resultado (sem dados das células)', () => {
  const audit = fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  for (const a of ['lote-plano-gerado', 'lote-iniciado', 'lote-item-importado', 'lote-item-falhou', 'lote-concluido', 'lote-concluido-com-falhas', 'lote-scripts-executados']) assert.match(audit, new RegExp(`"action":"${a}"`), a);
  assert.doesNotMatch(audit, /"Ana"|Filho/); // valores das células nunca vão para a auditoria
});
