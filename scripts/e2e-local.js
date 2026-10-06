// Teste ponta a ponta contra o SQL Server LOCAL (nunca produção).
// Cria a base descartável GP_APP_TESTE, importa uma planilha de exemplo pelo fluxo real da API
// (plano → autorização → execução) e apaga a base ao final. Uso: node scripts/e2e-local.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const TEST_DB = 'GP_APP_TESTE';
const SRC_DBS = ['GP_APP_TESTE_O1', 'GP_APP_TESTE_O2', 'GP_APP_TESTE_O3']; // origens descartáveis do teste de variáveis
let createdSrc = false;
const PORT = 4390;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-e2e-'));
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

const sql = require('mssql/msnodesqlv8');
const { app } = require('../server');

const conn = (database) => new sql.ConnectionPool({
  connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=${database};Trusted_Connection=Yes;TrustServerCertificate=Yes;`,
});
async function scalar(database, query) {
  const p = conn(database); await p.connect();
  try { return (await p.request().query(query)).recordset; } finally { await p.close(); }
}

const base = `http://localhost:${PORT}`;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
async function runJob(planId, plan, extra = {}) {
  const ex = await api('POST', `/api/import/plans/${planId}/execute`, { hash: plan.hash, authorized: true, ...extra });
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  for (;;) {
    const j = (await api('GET', `/api/jobs/${ex.json.jobId}`)).json;
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function makeXlsx(file) {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('DEPARA Clientes');
  a.addRow(['Código Antigo', 'Código Novo', 'Nome', 'Ativo', 'Criado em']);
  a.addRow(['00123', 1001, "O'Brien; DROP TABLE x --", true, new Date(Date.UTC(2026, 0, 15))]);
  a.addRow(['00124', 1002, 'Açaí & Café "Ltda"', false, new Date(Date.UTC(2026, 1, 20, 10, 30))]);
  a.addRow(['00125', null, null, null, null]);
  const b = wb.addWorksheet('Produtos');
  b.addRow(['de', 'para']);
  for (let i = 1; i <= 2500; i++) b.addRow([`P${i}`, i]);
  wb.addWorksheet('Rascunho').addRow(['x']);
  await wb.xlsx.writeFile(file);
}

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  try {
    // As bases de origem são criadas E apagadas por este teste: se já existirem, não são nossas → aborta sem tocar nelas.
    const clash = await scalar('master', `SELECT name FROM sys.databases WHERE name IN (${SRC_DBS.map((d) => `'${d}'`).join(', ')})`);
    if (clash.length) throw new Error(`Bases ${clash.map((r) => r.name).join(', ')} já existem neste servidor; o teste não vai usá-las nem apagá-las.`);
    await scalar('master', `IF DB_ID('${TEST_DB}') IS NULL CREATE DATABASE ${TEST_DB}`);
    const file = path.join(tmp, 'depara.xlsx');
    await makeXlsx(file);

    // segurança do servidor
    const bad = await fetch(base + '/api/state', { headers: { Host: 'evil.com' } }).catch(() => null);
    const noOrigin = await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(noOrigin.status, 403, 'POST sem Origin deve ser recusado');
    console.log('ok  servidor recusa origem inválida');

    const proj = (await api('POST', '/api/projects', { name: 'Projeto E2E', rootDir: tmp })).json;
    const withBase = (await api('POST', `/api/projects/${proj.id}/bases`, {
      name: 'Base teste', directory: tmp,
      local: { server: 'localhost', database: TEST_DB, auth: 'windows' },
    })).json;
    const baseId = withBase.bases[0].id;

    const remoteLocal = await api('POST', `/api/projects/${proj.id}/bases`, { name: 'x', local: { server: '10.1.1.1', database: 'X', auth: 'windows' } });
    assert.equal(remoteLocal.status, 400);
    console.log('ok  "localhost" com servidor remoto é recusado');

    const t = (await api('POST', `/api/projects/${proj.id}/bases/${baseId}/test`, { env: 'local' })).json;
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.database.toUpperCase(), TEST_DB);
    console.log(`ok  conexão local: ${t.server} / ${t.database} / ${t.login}`);

    const insp = (await api('POST', '/api/import/inspect', { filePath: file })).json;
    assert.deepEqual(insp.sheets.map((s) => s.name), ['DEPARA Clientes', 'Produtos', 'Rascunho']);
    assert.equal(insp.sheets[0].rowCount, 3);
    console.log('ok  inspeção da planilha:', insp.sheets.map((s) => `${s.name}(${s.rowCount})`).join(', '));

    const cols = (i, types) => insp.sheets[i].columns.map((c, k) => ({ index: c.index, name: c.suggestedName, type: types?.[k] || 'text' }));
    const payload = (mode, extra = {}) => ({
      projectId: proj.id, baseId, env: 'local', filePath: file,
      sheets: [
        { sheetName: 'DEPARA Clientes', schema: 'dbo', tableName: 'DEPARA_Clientes', mode, columns: cols(0, ['text', 'bigint', 'text', 'bit', 'datetime']) },
        { sheetName: 'Produtos', schema: 'dbo', tableName: 'DEPARA_Produtos', mode, columns: cols(1, ['text', 'bigint']) },
      ], ...extra,
    });

    // 1) importação nova
    let plan = (await api('POST', '/api/import/plan', payload('fail'))).json;
    assert.equal(plan.blocked, false, JSON.stringify(plan.issues));
    assert.equal(plan.totalRows, 2503);
    assert.ok(plan.scriptPreview.includes('BEGIN TRANSACTION'));
    console.log(`ok  plano gerado: ${plan.statementCount} comandos, hash ${plan.hash.slice(0, 12)}…`);

    const noAuth = await api('POST', `/api/import/plans/${plan.planId}/execute`, { hash: plan.hash });
    assert.equal(noAuth.status, 403);
    const wrongHash = await api('POST', `/api/import/plans/${plan.planId}/execute`, { hash: 'abc', authorized: true });
    assert.equal(wrongHash.status, 409);
    assert.equal((await scalar(TEST_DB, "SELECT OBJECT_ID('dbo.DEPARA_Clientes') AS o"))[0].o, null);
    console.log('ok  sem autorização / hash divergente: nada executado');

    let job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'done', JSON.stringify(job));
    const rows = await scalar(TEST_DB, 'SELECT * FROM dbo.DEPARA_Clientes ORDER BY 1');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].Codigo_Antigo ?? rows[0]['Código_Antigo'] ?? Object.values(rows[0])[0], '00123');
    assert.equal(Object.values(rows[0])[2], "O'Brien; DROP TABLE x --");
    assert.equal(Object.values(rows[1])[2], 'Açaí & Café "Ltda"');
    assert.equal((await scalar(TEST_DB, 'SELECT COUNT(*) c FROM dbo.DEPARA_Produtos'))[0].c, 2500);
    console.log('ok  importação concluída; zeros à esquerda, aspas, acentos e injeção preservados como dado');

    const reuse = await api('POST', `/api/import/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true });
    assert.equal(reuse.status, 409);
    console.log('ok  plano só executa uma vez');

    // 2) tabela existe + modo fail → bloqueado
    plan = (await api('POST', '/api/import/plan', payload('fail'))).json;
    assert.equal(plan.blocked, true);
    console.log('ok  tabela existente + "não sobrescrever" → plano bloqueado');

    // 3) simulação (rollback) com replace
    await scalar(TEST_DB, "UPDATE dbo.DEPARA_Produtos SET de = 'MARCADO' WHERE de = 'P1'");
    plan = (await api('POST', '/api/import/plan', payload('replace'))).json;
    assert.equal(plan.blocked, false);
    assert.equal(plan.destructive.length, 2);
    job = await runJob(plan.planId, plan, { dryRun: true });
    assert.equal(job.status, 'done');
    assert.equal(job.result.rolledBack, true);
    assert.equal((await scalar(TEST_DB, "SELECT COUNT(*) c FROM dbo.DEPARA_Produtos WHERE de = 'MARCADO'"))[0].c, 1);
    console.log('ok  simulação: executa e desfaz, dados originais intactos');

    // 4) replace de verdade
    plan = (await api('POST', '/api/import/plan', payload('replace'))).json;
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal((await scalar(TEST_DB, "SELECT COUNT(*) c FROM dbo.DEPARA_Produtos WHERE de = 'MARCADO'"))[0].c, 0);
    console.log('ok  substituição (DROP + CREATE + INSERT) concluída');

    // 5) backup (renomeia a antiga)
    plan = (await api('POST', '/api/import/plan', payload('backup'))).json;
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'done', JSON.stringify(job));
    const bk = await scalar(TEST_DB, "SELECT name FROM sys.tables WHERE name LIKE 'DEPARA_%_bkp_%' ORDER BY name");
    assert.equal(bk.length, 2);
    console.log('ok  backup: tabelas antigas preservadas como', bk.map((r) => r.name).join(', '));

    // 6) falha no meio → rollback total
    const cur = await scalar(TEST_DB, 'SELECT COUNT(*) c FROM dbo.DEPARA_Clientes');
    await scalar(TEST_DB, 'CREATE TABLE dbo.SO_PARA_FALHAR (a INT)');
    plan = (await api('POST', '/api/import/plan', {
      ...payload('fail'),
      sheets: [
        { sheetName: 'Produtos', schema: 'dbo', tableName: 'NOVA_OK', mode: 'fail', columns: cols(1) },
        { sheetName: 'DEPARA Clientes', schema: 'dbo', tableName: 'SO_PARA_FALHAR2', mode: 'fail', columns: cols(0) },
      ],
    })).json;
    await scalar(TEST_DB, 'CREATE TABLE dbo.SO_PARA_FALHAR2 (a INT)'); // aparece DEPOIS do plano → guard estoura na execução
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'error');
    assert.equal((await scalar(TEST_DB, "SELECT OBJECT_ID('dbo.NOVA_OK') AS o"))[0].o, null);
    console.log('ok  falha no meio do plano → ROLLBACK total (NOVA_OK não existe):', job.error.slice(0, 60));
    assert.ok(cur[0].c === 3);

    // 7) valor inválido para o tipo → bloqueio antes de executar
    const badType = (await api('POST', '/api/import/plan', {
      ...payload('replace'),
      sheets: [{ sheetName: 'DEPARA Clientes', schema: 'dbo', tableName: 'X_TIPO', mode: 'fail', columns: cols(0, ['text', 'text', 'bigint', 'text', 'text']) }],
    })).json;
    assert.equal(badType.blocked, true);
    assert.ok(badType.errors.length >= 2);
    console.log('ok  valores inválidos para o tipo bloqueiam o plano:', badType.errors[0].message);

    // 8) produção sem conexão configurada / sem permissão de sobrescrita
    const prod = await api('POST', '/api/import/plan', payload('fail', { env: 'prod' }));
    assert.equal(prod.status, 400);
    console.log('ok  produção sem conexão configurada é recusada');

    // 9) fórmulas: valor quando existe (inclusive 0/FALSE), NULL quando vazio/erro, nunca "[object Object]"
    const fxFile = path.join(tmp, 'formulas.xlsx');
    await require('../test/fixtures/make-formulas')(fxFile);
    const fx = (await api('POST', '/api/import/inspect', { filePath: fxFile })).json;
    assert.equal(fx.sheets[0].notes.formulaErrors, 1);
    const fxCols = fx.sheets[0].columns.map((c) => ({ index: c.index, name: c.suggestedName, type: 'text' }));
    const fxPlan = (await api('POST', '/api/import/plan', { projectId: proj.id, baseId, env: 'local', filePath: fxFile,
      sheets: [{ sheetName: 'DEPARA', schema: 'dbo', tableName: 'FORMULAS', mode: 'fail', columns: fxCols }] })).json;
    assert.equal(fxPlan.blocked, false, JSON.stringify(fxPlan.issues));
    assert.equal((await runJob(fxPlan.planId, fxPlan)).status, 'done');
    const got = Object.fromEntries((await scalar(TEST_DB, 'SELECT CASO, NOME_RM FROM dbo.FORMULAS')).map((r) => [r.CASO, r.NOME_RM]));
    assert.equal(got['fórmula com texto'], 'ABC-FORMULA');
    assert.equal(got['fórmula resultado 0'], '0');
    assert.equal(got['fórmula resultado FALSE'], 'FALSE');
    assert.equal(got['fórmula resultado número'], '5');
    for (const caso of ['fórmula vazia ("")', 'fórmula sem valor salvo', 'fórmula com erro #N/A', 'célula em branco']) assert.equal(got[caso], null, caso);
    assert.equal((await scalar(TEST_DB, "SELECT COUNT(*) c FROM dbo.FORMULAS WHERE NOME_RM LIKE '%object%'"))[0].c, 0);
    console.log('ok  fórmulas: valores preservados, vazios/erros viram NULL, nenhum "[object Object]" no banco');

    // 10) a última configuração (nomes/tipos) é lembrada por DE-PARA; o modo de sobrescrita nunca
    const withDep = (await api('POST', `/api/projects/${proj.id}/deparas`, { label: 'DEPARA E2E', url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit', targetDir: tmp })).json;
    const depId = withDep.deparas[0].id;
    const saveConfig = { deparaId: depId, schema: 'dbo', sheets: [{ sheetName: 'DEPARA', include: true, tableName: 'FORMULAS_2', columns: fx.sheets[0].columns.map((c) => ({ index: c.index, header: c.header, include: true, name: c.suggestedName, type: 'text' })) }] };
    await api('POST', '/api/import/plan', { projectId: proj.id, baseId, env: 'local', filePath: fxFile, saveConfig,
      sheets: [{ sheetName: 'DEPARA', schema: 'dbo', tableName: 'FORMULAS_2', mode: 'replace', columns: fxCols }] });
    const st = (await api('GET', '/api/state')).json.projects.find((x) => x.id === proj.id);
    const saved = st.deparas[0].importConfig;
    assert.equal(saved.sheets[0].tableName, 'FORMULAS_2');
    assert.ok(!JSON.stringify(saved).includes('replace') && !JSON.stringify(saved).includes('"mode"'), 'o modo destrutivo não pode ser lembrado');
    console.log('ok  configuração lembrada por DE-PARA (sem o modo de sobrescrita)');

    // 11) scripts SQL do usuário: rodam DEPOIS da importação, na mesma transação (tudo em GP_APP_TESTE)
    const [cDe, cPara] = cols(1).map((c) => c.name);
    const mkScript = async (name, content) => { const r = await api('POST', '/api/scripts', { name, content }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
    const sA = await mkScript('E2E Trata e cria log', `-- MARCADOR_SECRETO_XYZ\nUPDATE dbo.SCR_T SET [${cDe}] = 'X_' + [${cDe}]\nGO\nCREATE TABLE dbo.SCR_LOG (msg NVARCHAR(100))\nGO\nCREATE VIEW dbo.VW_SCR AS SELECT [${cDe}] AS de FROM dbo.SCR_T`);
    const sB = await mkScript('E2E Grava log', `INSERT INTO dbo.SCR_LOG (msg) SELECT CONCAT('linhas=', COUNT(*)) FROM dbo.SCR_T`);
    const one = (table, scriptIds, mode = 'fail', env = 'local') => ({
      projectId: proj.id, baseId, env, filePath: file, scriptIds,
      sheets: [{ sheetName: 'Produtos', schema: 'dbo', tableName: table, mode, columns: cols(1) }],
    });

    // 11a) simulação: scripts rodam e TUDO é desfeito (importação + scripts)
    plan = (await api('POST', '/api/import/plan', one('SCR_T', [sA.id, sB.id]))).json;
    assert.equal(plan.blocked, false, JSON.stringify(plan));
    assert.deepEqual(plan.userScripts.map((s) => s.name), ['E2E Trata e cria log', 'E2E Grava log']);
    assert.ok(plan.scriptPreview.includes("UPDATE dbo.SCR_T SET") && plan.scriptPreview.includes('CREATE VIEW dbo.VW_SCR'), 'o texto dos scripts aparece na prévia');
    job = await runJob(plan.planId, plan, { dryRun: true });
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.result.scripts.length, 2);
    assert.equal((await scalar(TEST_DB, "SELECT OBJECT_ID('dbo.SCR_T') a, OBJECT_ID('dbo.SCR_LOG') b, OBJECT_ID('dbo.VW_SCR') c"))[0].a, null);
    assert.equal((await scalar(TEST_DB, "SELECT OBJECT_ID('dbo.SCR_LOG') b"))[0].b, null);
    console.log('ok  scripts: simulação executa importação + scripts e desfaz tudo');

    // 11b) execução real: dados tratados, objetos criados, na ordem escolhida
    plan = (await api('POST', '/api/import/plan', one('SCR_T', [sA.id, sB.id]))).json;
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.deepEqual(job.result.scripts.map((s) => [s.name, s.batches]), [['E2E Trata e cria log', 3], ['E2E Grava log', 1]]);
    assert.equal(job.result.scripts[0].rowsAffected, 2500);
    assert.equal((await scalar(TEST_DB, `SELECT COUNT(*) c FROM dbo.SCR_T WHERE [${cDe}] LIKE 'X\\_P%' ESCAPE '\\'`))[0].c, 2500);
    assert.equal((await scalar(TEST_DB, 'SELECT msg FROM dbo.SCR_LOG'))[0].msg, 'linhas=2500');
    assert.equal((await scalar(TEST_DB, 'SELECT COUNT(*) c FROM dbo.VW_SCR'))[0].c, 2500);
    console.log('ok  scripts: dados tratados após a importação, tabela de log e view criadas, na ordem escolhida');

    // 11c) script que falha → ROLLBACK de tudo (importação e o que o script já tinha feito)
    const sFail = await mkScript('E2E Falha', `UPDATE dbo.SCR_T SET [${cPara}] = 987654\nGO\nSELECT 1/0`);
    plan = (await api('POST', '/api/import/plan', one('SCR_T3', [sFail.id]))).json;
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'error');
    assert.match(job.error, /Script “E2E Falha”, lote 2 de 2/);
    assert.equal((await scalar(TEST_DB, "SELECT OBJECT_ID('dbo.SCR_T3') o"))[0].o, null);
    assert.equal((await scalar(TEST_DB, `SELECT COUNT(*) c FROM dbo.SCR_T WHERE [${cPara}] = 987654`))[0].c, 0);
    console.log('ok  scripts: falha no 2º lote → ROLLBACK total, mensagem diz script e lote:', job.error.slice(0, 60));

    // 11d) o que roda é o que foi aprovado: editar o arquivo depois de gerar o plano não muda a execução
    const sE = await mkScript('E2E Aprovado', `UPDATE dbo.SCR_T SET [${cPara}] = 111`);
    plan = (await api('POST', '/api/import/plan', one('SCR_T4', [sE.id]))).json;
    assert.equal((await api('PUT', `/api/scripts/${sE.id}`, { name: sE.name, content: `UPDATE dbo.SCR_T SET [${cPara}] = 222` })).status, 200);
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal((await scalar(TEST_DB, `SELECT COUNT(*) c FROM dbo.SCR_T WHERE [${cPara}] = 111`))[0].c, 2500);
    console.log('ok  scripts: editar o arquivo depois do plano não altera o que foi aprovado (executou a versão aprovada)');

    // 11e) DELETE: liberado no localhost (aparece sinalizado); em PRODUÇÃO sem permissão o plano é BLOQUEADO (só gera plano, nada executa)
    const sDel = await mkScript('E2E Apaga', `DELETE FROM dbo.SCR_T WHERE [${cDe}] = 'nao-existe'`);
    plan = (await api('POST', '/api/import/plan', one('SCR_T5', [sDel.id]))).json;
    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.userScripts[0].analysis.destructive.map((d) => d.kw), ['DELETE']);
    assert.ok((await runJob(plan.planId, plan, { dryRun: true })).status === 'done');
    const withProd = (await api('POST', `/api/projects/${proj.id}/bases`, { name: 'Base com prod', directory: tmp,
      local: { server: 'localhost', database: TEST_DB, auth: 'windows' }, prod: { server: 'localhost', database: TEST_DB, auth: 'windows' } })).json;
    const prodBase = withProd.bases.find((b) => b.name === 'Base com prod').id;
    const prodPlan = (await api('POST', '/api/import/plan', { ...one('SCR_T6', [sDel.id], 'fail', 'prod'), baseId: prodBase })).json;
    assert.equal(prodPlan.blocked, true);
    assert.ok(prodPlan.issues.some((i) => /E2E Apaga/.test(i)), JSON.stringify(prodPlan.issues));
    const prodExec = await api('POST', `/api/import/plans/${prodPlan.planId}/execute`, { hash: prodPlan.hash, authorized: true });
    assert.equal(prodExec.status, 409);
    const prodOk = (await api('POST', '/api/import/plan', { ...one('SCR_T6', [sB.id], 'fail', 'prod'), baseId: prodBase })).json;
    assert.equal(prodOk.blocked, false); // script sem DELETE/DROP/TRUNCATE não é barrado (aqui apenas gerado, não executado)
    console.log('ok  scripts: DELETE liberado no localhost; em produção sem permissão o plano é bloqueado e a execução recusada');

    // 11f) auditoria guarda só metadados dos scripts, nunca o texto
    const audit2 = JSON.stringify((await api('GET', '/api/audit')).json);
    assert.ok(audit2.includes('E2E Trata e cria log') && audit2.includes('sha256'));
    assert.ok(!audit2.includes('MARCADOR_SECRETO_XYZ') && !audit2.includes('CREATE VIEW'), 'texto do script não pode ir para a auditoria');
    console.log('ok  scripts: auditoria com nome/arquivo/lotes/hash, sem o texto');

    // 12) VARIÁVEIS: o script "CONCATENA DE-PARA ENTRE BASES" do usuário (cópia de teste), com '{{BANCO}}' no destino e
    //     {{ORIGEM_1}}/{{ORIGEM_2}} nas origens. Origens = bases descartáveis GP_APP_TESTE_O1..O3 (criadas e apagadas aqui).
    for (const o of SRC_DBS) await scalar('master', `CREATE DATABASE ${o}`);
    createdSrc = true;
    await scalar('GP_APP_TESTE_O1', "CREATE TABLE dbo.ZDEPARA_BANCOS (COD NVARCHAR(10), NOME NVARCHAR(50)); INSERT dbo.ZDEPARA_BANCOS VALUES ('001','BANCO DO BRASIL'),('237','BRADESCO')");
    await scalar('GP_APP_TESTE_O2', "CREATE TABLE dbo.ZDEPARA_BANCOS (COD NVARCHAR(10), NOME NVARCHAR(50)); INSERT dbo.ZDEPARA_BANCOS VALUES ('237','BRADESCO'),('341','ITAU')");
    await scalar('GP_APP_TESTE_O2', "CREATE TABLE dbo.ZDEPARA_SITUACAO (DE NVARCHAR(5), PARA NVARCHAR(5)); INSERT dbo.ZDEPARA_SITUACAO VALUES ('A','1'),('F','2')");
    await scalar('GP_APP_TESTE_O3', 'CREATE TABLE dbo.ZDEPARA_BANCOS (COD NVARCHAR(10))'); // estrutura diferente → para forçar erro

    const conc = await mkScript('E2E Concatena DE-PARA', fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'concatena-depara.sql'), 'utf8'));
    assert.deepEqual(conc.analysis.variables, ['BANCO', 'ORIGEM_1', 'ORIGEM_2']);
    assert.ok(conc.analysis.destructive.some((d) => d.kw === 'DROP' && d.dynamic), 'o DROP TABLE montado em SQL dinâmico é sinalizado');
    const vars = { ORIGEM_1: 'GP_APP_TESTE_O1', ORIGEM_2: 'GP_APP_TESTE_O2' };

    // sem valor para as origens → recusado
    const noVars = await api('POST', '/api/import/plan', one('SCR_V0', [conc.id]));
    assert.equal(noVars.status, 400);
    assert.match(noVars.json.error, /\{\{ORIGEM_1\}\}, \{\{ORIGEM_2\}\} sem valor/);

    plan = (await api('POST', '/api/import/plan', { ...one('SCR_V1', [conc.id]), scriptVars: vars })).json;
    assert.equal(plan.blocked, false, JSON.stringify(plan.issues));
    assert.deepEqual(plan.userScripts[0].variables, { BANCO: TEST_DB, ORIGEM_1: 'GP_APP_TESTE_O1', ORIGEM_2: 'GP_APP_TESTE_O2' });
    assert.ok(plan.scriptPreview.includes(`DECLARE @BancoDestino SYSNAME = '${TEST_DB}';`), 'a revisão mostra o texto já substituído');
    assert.ok(plan.scriptPreview.includes("('GP_APP_TESTE_O1'),") && !plan.scriptPreview.includes("= '{{BANCO}}'"));
    assert.ok(plan.scriptPreview.includes(`-- Variável {{BANCO}} = ${TEST_DB}`));
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.deepEqual((await scalar(TEST_DB, 'SELECT COD FROM dbo.ZDEPARA_BANCOS ORDER BY COD')).map((r) => r.COD), ['001', '237', '341']); // DISTINCT de O1 + O2
    assert.equal((await scalar(TEST_DB, 'SELECT COUNT(*) c FROM dbo.ZDEPARA_SITUACAO'))[0].c, 2); // só O2 tinha
    assert.equal((await scalar(TEST_DB, "SELECT OBJECT_ID('dbo.SCR_V1') o"))[0].o !== null, true); // a importação também foi gravada
    const out = job.result.scripts[0];
    assert.ok(out.messages.includes('PROCESSANDO: ZDEPARA_BANCOS') && out.messages.includes('IGNORADA: ZDEPARA_INEXISTENTE'), JSON.stringify(out.messages.slice(0, 8)));
    assert.ok(out.messages.some((m) => m.startsWith('FINALIZADO COM SUCESSO: ZDEPARA_SITUACAO')));
    assert.deepEqual(out.results.map((r) => r.rows[0]), [['ZDEPARA_BANCOS', '3'], ['ZDEPARA_SITUACAO', '2']]); // a "VALIDAÇÃO FINAL" do script
    console.log(`ok  variáveis: mesmo script, {{BANCO}} = ${TEST_DB}; DE-PARAs concatenados (DISTINCT), PRINTs e contagens exibidos`);

    // valores lembrados por planilha (a próxima importação já vem preenchida)
    await api('POST', '/api/import/plan', { ...one('SCR_V9', [conc.id]), scriptVars: vars, saveConfig: { deparaId: depId, schema: 'dbo', sheets: [], scripts: { enabled: true, ids: [conc.id], vars } } });
    const remembered = (await api('GET', '/api/state')).json.projects.find((x) => x.id === proj.id).deparas[0].importConfig.scripts;
    assert.deepEqual(remembered, { enabled: true, ids: [conc.id], vars });
    console.log('ok  variáveis: valores lembrados por planilha junto com os scripts marcados');

    // erro dentro do TRY/CATCH do script (origem com estrutura diferente) → tudo desfeito e o erro REAL aparece nos PRINTs
    plan = (await api('POST', '/api/import/plan', { ...one('SCR_V2', [conc.id]), scriptVars: { ORIGEM_1: 'GP_APP_TESTE_O1', ORIGEM_2: 'GP_APP_TESTE_O3' } })).json;
    job = await runJob(plan.planId, plan);
    assert.equal(job.status, 'error');
    assert.match(job.error, /TRY\/CATCH/);
    assert.ok(job.scripts[0].messages.some((m) => m.startsWith('ERRO AO PROCESSAR: ZDEPARA_BANCOS')), JSON.stringify(job.scripts[0].messages));
    assert.ok(job.scripts[0].messages.some((m) => /Mensagem: .*NOME/i.test(m)), 'a mensagem original do SQL Server aparece');
    assert.equal((await scalar(TEST_DB, "SELECT OBJECT_ID('dbo.SCR_V2') o"))[0].o, null); // importação desfeita
    assert.equal((await scalar(TEST_DB, 'SELECT COUNT(*) c FROM dbo.ZDEPARA_BANCOS'))[0].c, 3); // tabela anterior intacta
    console.log('ok  variáveis: erro engolido por TRY/CATCH → ROLLBACK total e o erro original aparece nas mensagens:', job.scripts[0].messages.find((m) => m.startsWith('Mensagem:')).slice(0, 70));

    // em PRODUÇÃO sem permissão, o DROP escondido no SQL dinâmico bloqueia o plano (só gera o plano; nada executa)
    const prodConc = (await api('POST', '/api/import/plan', { ...one('SCR_V3', [conc.id], 'fail', 'prod'), baseId: prodBase, scriptVars: vars })).json;
    assert.equal(prodConc.blocked, true);
    assert.ok(prodConc.issues.some((i) => /E2E Concatena DE-PARA.*DROP/.test(i)), JSON.stringify(prodConc.issues));
    console.log('ok  variáveis: DROP dentro de SQL dinâmico bloqueia o plano em produção sem permissão');

    // 13) executar script pelo checklist, numa conexão CADASTRADA apontando para o localhost (tudo em GP_APP_TESTE)
    {
      await scalar(TEST_DB, "IF OBJECT_ID('dbo.CK_RUN') IS NOT NULL DROP TABLE dbo.CK_RUN; CREATE TABLE dbo.CK_RUN (ID INT, NOME NVARCHAR(40)); INSERT dbo.CK_RUN VALUES (1,'João'),(2,'Maria'),(3,'Ana')");
      const conn = (await api('POST', '/api/connections', { name: 'Localhost E2E', env: 'local', server: 'localhost', database: TEST_DB, auth: 'windows' })).json;
      const tested = (await api('POST', `/api/connections/${conn.id}/test`, {})).json;
      assert.equal(tested.ok, true, JSON.stringify(tested));
      const mk = async (name, content) => (await api('POST', '/api/scripts', { name, content })).json;
      const sSel = await mk('E2E Validação', "PRINT 'validando {{BANCO}}';\nSELECT ID, NOME FROM dbo.CK_RUN ORDER BY ID;\nGO\nSELECT COUNT(*) AS total FROM dbo.CK_RUN;");
      const sUpd = await mk('E2E Ajuste', "UPDATE dbo.CK_RUN SET NOME = NOME + '*' WHERE ID <= 2;");
      const sDel = await mk('E2E Limpa', 'DELETE FROM dbo.CK_RUN WHERE ID = 3;');
      const sErr = await mk('E2E Erro', "UPDATE dbo.CK_RUN SET NOME = 'X' WHERE ID = 1;\nGO\nSELECT 1;\nSELECT * FROM dbo.TABELA_QUE_NAO_EXISTE;");
      // checklist reutilizável associado ao 1º passo do ciclo padrão (antes do projeto, que recebe a cópia dos passos)
      const st0 = (await api('GET', '/api/state')).json;
      const dc = st0.cycles.find((c) => c.id === st0.defaultCycleId);
      const ck = (await api('POST', '/api/checklists', { name: 'Checklist CK_RUN' })).json;
      await api('PUT', `/api/cycles/${dc.id}/steps/${dc.steps[0].id}/checklists`, { checklistIds: [ck.id] });
      await api('POST', `/api/checklists/${ck.id}/items`, { title: 'Validar CK_RUN', required: true, scriptIds: [sSel.id, sUpd.id, sDel.id, sErr.id] });
      const pr = (await api('POST', '/api/projects', { name: 'Projeto Checklist E2E' })).json;
      await api('PUT', `/api/projects/${pr.id}/step`, { stepId: pr.steps[0].id });
      const inst = (await api('POST', `/api/projects/${pr.id}/checklists/${pr.steps[0].id}/open`, {})).json.instance;
      const item = inst.items.find((i) => i.title === 'Validar CK_RUN');
      const run = (o) => api('POST', `/api/projects/${pr.id}/checklists/${pr.steps[0].id}/items/${item.id}/run`, { target: `conn:${conn.id}`, ...o });

      const r1 = (await run({ scriptId: sSel.id })).json;
      assert.equal(r1.ok, true, JSON.stringify(r1));
      assert.equal(r1.results.length, 2);
      assert.deepEqual(r1.results[0].columns, ['ID', 'NOME']);
      assert.deepEqual(r1.results[0].rows[0], ['1', 'João']);
      assert.equal(r1.results[1].rows[0][0], '3');
      assert.ok(r1.messages.some((m) => m.includes(`validando ${TEST_DB}`)), 'PRINT com a variável {{BANCO}} preenchida');
      assert.equal(r1.affected, 0);
      console.log(`ok  checklist: SELECT pela conexão cadastrada (${r1.returned} linhas, ${r1.ms} ms, PRINT e {{BANCO}})`);

      const r2 = (await run({ scriptId: sUpd.id })).json;
      assert.equal(r2.ok, true, JSON.stringify(r2));
      assert.equal(r2.affected, 2);
      assert.equal((await scalar(TEST_DB, "SELECT COUNT(*) c FROM dbo.CK_RUN WHERE NOME LIKE '%*'"))[0].c, 2);
      console.log('ok  checklist: UPDATE no localhost executa e informa 2 registros afetados');

      const d1 = await run({ scriptId: sDel.id });
      assert.equal(d1.status, 409); assert.equal(d1.json.code, 'SCRIPT_CONFIRM');
      assert.equal((await scalar(TEST_DB, 'SELECT COUNT(*) c FROM dbo.CK_RUN'))[0].c, 3, 'nada roda antes de confirmar');
      const d2 = (await run({ scriptId: sDel.id, confirmToken: d1.json.confirm.token })).json;
      assert.equal(d2.ok, true); assert.equal(d2.affected, 1);
      console.log('ok  checklist: DELETE pede confirmação e só roda com o token');

      const e = (await run({ scriptId: sErr.id })).json;
      assert.equal(e.ok, false);
      assert.match(e.error, /Lote 2 de 2, linha 4 do arquivo/);
      assert.match(e.error, /TABELA_QUE_NAO_EXISTE/);
      assert.equal((await scalar(TEST_DB, "SELECT NOME FROM dbo.CK_RUN WHERE ID = 1"))[0].NOME, 'João*', 'erro → rollback de tudo que o script fez');
      console.log('ok  checklist: erro mostra lote e linha do arquivo e desfaz o script inteiro');

      const itemAfter = (await api('POST', `/api/projects/${pr.id}/checklists/${pr.steps[0].id}/open`, {})).json.instance.items.find((i) => i.id === item.id);
      assert.equal(itemAfter.done, false, 'executar não conclui o item');
      assert.equal(itemAfter.runs.length, 4);
      console.log('ok  checklist: histórico de execuções no item, sem concluir o item');
    }

    const audit = (await api('GET', '/api/audit')).json;
    assert.ok(audit.some((a) => a.action === 'importacao-concluida'));
    assert.ok(!JSON.stringify(audit).includes("O'Brien"), 'auditoria não deve conter dados das células');
    console.log(`ok  auditoria registrou ${audit.length} eventos, sem dados de células`);

    console.log('\nTODOS OS TESTES E2E PASSARAM');
  } catch (e) {
    console.error('\nFALHA E2E:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    try {
      await scalar('master', `IF DB_ID('${TEST_DB}') IS NOT NULL BEGIN ALTER DATABASE ${TEST_DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${TEST_DB}; END`);
      console.log(`(base de teste ${TEST_DB} removida)`);
      if (createdSrc) {
        for (const o of SRC_DBS) await scalar('master', `IF DB_ID('${o}') IS NOT NULL BEGIN ALTER DATABASE ${o} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${o}; END`);
        console.log(`(bases de origem ${SRC_DBS.join(', ')} removidas)`);
      }
    } catch (e) { console.error('Não consegui remover a base de teste:', e.message); }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
