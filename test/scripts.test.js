const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/sqlplan');
const { prepareScript } = require('../src/sqlscan');

// ---------- Plano + trava de segurança (sem servidor) ----------
const wb = (rows) => ({ sheets: [{ name: 'S', state: 'visible', columns: [{ index: 0, header: 'a' }, { index: 1, header: 'b' }], rows, rowNumbers: rows.map((_, i) => i + 2) }] });
const sel = () => [{ sheetName: 'S', schema: 'dbo', tableName: 'T', mode: 'fail', columns: [{ index: 0, name: 'a', type: 'text' }, { index: 1, name: 'b', type: 'text' }] }];
const script = (id, name, sql) => ({ id, name, file: `${id}.sql`, sha256: 'x', batches: prepareScript(sql).batches, analysis: {} });
const plan = (scripts) => P.buildPlan(wb([['1', 'a']]), sel(), { env: 'local', userScripts: scripts });
const us = (p) => p.statements.filter((s) => s.kind === 'userscript');

test('scripts entram DEPOIS das tabelas e da verificação, um comando por lote, na ordem escolhida', () => {
  const p = plan([script('s1', 'Trata A', 'UPDATE dbo.T SET b = 1\nGO\nUPDATE dbo.T SET b = 2'), script('s2', 'Trata B', 'SELECT 1')]);
  const kinds = p.statements.map((s) => s.kind);
  assert.equal(kinds.at(-1), 'userscript');
  assert.ok(kinds.lastIndexOf('verify') < kinds.indexOf('userscript'), 'scripts só depois do verify');
  assert.deepEqual(us(p).map((s) => `${s.script}:${s.batch}/${s.of}`), ['Trata A:1/2', 'Trata A:2/2', 'Trata B:1/1']);
});

test('o hash muda com o conteúdo do script e com a ORDEM dos scripts', () => {
  const a = script('s1', 'A', 'UPDATE dbo.T SET b = 1');
  const b = script('s2', 'B', 'UPDATE dbo.T SET b = 2');
  const base = plan([]).hash;
  const h1 = plan([a, b]).hash, h2 = plan([b, a]).hash, h3 = plan([script('s1', 'A', 'UPDATE dbo.T SET b = 9'), b]).hash;
  assert.notEqual(h1, base);
  assert.notEqual(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(plan([a, b]).hash, h1); // determinístico
});

test('trava de execução: script benigno passa; bloqueado ou apagando dados sem autorização é recusado', () => {
  const ok = us(plan([script('s1', 'A', 'UPDATE dbo.T SET b = 1')]))[0];
  assert.doesNotThrow(() => P.assertStatementSafe(ok, { allowDestructive: false }));

  const bad = { ...ok, sql: "EXEC xp_cmdshell 'dir'" };
  assert.throws(() => P.assertStatementSafe(bad, { allowDestructive: true, allowDestructiveScripts: true }), /bloqueado pela trava/);
  for (const sql of ['USE master', 'COMMIT', 'ROLLBACK TRAN', 'DROP DATABASE X']) {
    assert.throws(() => P.assertStatementSafe({ ...ok, sql }, { allowDestructive: true, allowDestructiveScripts: true }), /bloqueado pela trava/, sql);
  }

  const del = { ...ok, sql: 'DELETE FROM dbo.T WHERE b IS NULL' };
  assert.throws(() => P.assertStatementSafe(del, { allowDestructive: false }), /apaga dados/);
  assert.throws(() => P.assertStatementSafe(del, { allowDestructive: true }), /apaga dados/); // "tabelas" liberadas não liberam scripts
  assert.doesNotThrow(() => P.assertStatementSafe(del, { allowDestructive: false, allowDestructiveScripts: true }));
  assert.throws(() => P.assertStatementSafe({ ...ok, sql: '   ' }, { allowDestructive: false }), /vazio/);
});

test('prévia/exportação mostram o script por inteiro; a proteção NOEXEC fica em lote próprio (CREATE PROCEDURE precisa ser o 1º do lote)', () => {
  const sql = 'CREATE PROCEDURE dbo.Trata AS\nBEGIN\n  UPDATE dbo.T SET b = 1\nEND';
  const p = plan([script('s1', 'Cria proc', sql)]);
  const text = P.renderScript(p, { server: 's', database: 'd' }, { preview: true });
  assert.ok(text.includes(sql), 'texto completo do script na prévia');
  assert.ok(text.includes('Script do usuário (roda DEPOIS da importação, na mesma transação): Cria proc'));
  const lotes = text.split(/^GO\s*$/m).map((s) => s.trim());
  const proc = lotes.find((l) => l.startsWith('CREATE PROCEDURE'));
  assert.ok(proc, 'o lote do CREATE PROCEDURE começa com CREATE (sem a proteção grudada antes)');
  assert.ok(lotes.some((l) => l.startsWith('IF @@TRANCOUNT = 0 SET NOEXEC ON;') && !l.includes('CREATE')), 'proteção em lote próprio');
  assert.ok(text.trimEnd().endsWith('SET NOEXEC OFF;\nGO'));
});

test('lote gigante é truncado só na PRÉVIA; o exportado (.sql) vem completo', () => {
  const big = `SELECT '${'x'.repeat(30000)}'`;
  const p = plan([script('s1', 'Gigante', big)]);
  assert.ok(P.renderScript(p, { server: 's', database: 'd' }, { preview: true }).includes('lote truncado na prévia'));
  assert.ok(P.renderScript(p, { server: 's', database: 'd' }).includes(big));
});

// ---------- API (dados isolados em pasta temporária) ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-scr-'));
const PORT = 4397;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const dir = path.join(tmp, 'data', 'scripts');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('API: cria script como arquivo .sql (UTF-8 com BOM), lista com análise, lê de volta', async () => {
  const sql = "-- Tratamento de férias\nUPDATE dbo.T SET nome = 'Férias' WHERE nome IS NULL";
  const r = await api('POST', '/api/scripts', { name: 'Tratamento de Férias', description: 'ajusta nomes', content: sql });
  assert.equal(r.status, 200);
  assert.equal(r.json.file, 'tratamento-de-ferias.sql');
  const bytes = fs.readFileSync(path.join(dir, r.json.file));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.match(bytes.toString('utf8'), /Férias/);
  assert.equal(r.json.analysis.batches, 1);
  assert.deepEqual(r.json.analysis.blocked, []);

  const list = (await api('GET', '/api/scripts')).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].exists, true);
  const one = (await api('GET', `/api/scripts/${r.json.id}`)).json;
  assert.equal(one.content.replace(/\r\n/g, '\n'), sql);
});

test('API: nome único, conteúdo obrigatório e nomes maliciosos não escapam da pasta', async () => {
  assert.equal((await api('POST', '/api/scripts', { name: 'tratamento de FÉRIAS', content: 'SELECT 1' })).status, 409);
  assert.equal((await api('POST', '/api/scripts', { name: 'Vazio', content: '  ' })).status, 400);
  assert.equal((await api('POST', '/api/scripts', { name: '', content: 'SELECT 1' })).status, 400);
  const r = await api('POST', '/api/scripts', { name: '../../../Windows/evil', content: 'SELECT 1' });
  assert.equal(r.status, 200);
  assert.ok(!r.json.file.includes('/') && !r.json.file.includes('\\') && !r.json.file.includes('..'), r.json.file);
  assert.ok(fs.existsSync(path.join(dir, r.json.file)));
  await api('DELETE', `/api/scripts/${r.json.id}`);
});

test('API: editar guarda a versão anterior em .versoes; remover MOVE o arquivo para .removidos', async () => {
  const s = (await api('GET', '/api/scripts')).json[0];
  const upd = await api('PUT', `/api/scripts/${s.id}`, { name: s.name, description: s.description, content: 'UPDATE dbo.T SET nome = NULL' });
  assert.equal(upd.status, 200);
  const versions = fs.readdirSync(path.join(dir, '.versoes'));
  assert.equal(versions.length, 1, versions.join(', '));
  assert.match(fs.readFileSync(path.join(dir, '.versoes', versions[0]), 'utf8'), /Férias/); // a versão antiga

  assert.equal((await api('DELETE', `/api/scripts/${s.id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, s.file)));
  const removed = fs.readdirSync(path.join(dir, '.removidos')).filter((f) => f.endsWith('__tratamento-de-ferias.sql'));
  assert.equal(removed.length, 1);
  assert.equal((await api('GET', '/api/scripts')).json.length, 0);
});

test('API: importar .sql existente (ANSI/Windows-1252) converte a codificação e recusa outros tipos', async () => {
  const ansi = path.join(tmp, 'meu script.sql');
  fs.writeFileSync(ansi, Buffer.from("-- Fé\nSELECT 'Férias'", 'latin1')); // 0xE9 = "é" em ANSI
  const r = await api('POST', '/api/scripts/import-file', { filePath: ansi });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'meu script');
  assert.match(fs.readFileSync(path.join(dir, r.json.file), 'utf8'), /Férias/);
  const again = await api('POST', '/api/scripts/import-file', { filePath: ansi }); // mesmo nome: ganha sufixo em vez de falhar
  assert.equal(again.status, 200);
  assert.equal(again.json.name, 'meu script (2)');

  fs.writeFileSync(path.join(tmp, 'x.txt'), 'SELECT 1');
  assert.equal((await api('POST', '/api/scripts/import-file', { filePath: path.join(tmp, 'x.txt') })).status, 400);
  assert.equal((await api('POST', '/api/scripts/import-file', { filePath: path.join(tmp, 'nao-existe.sql') })).status, 400);
});

test('API: análise ao vivo, e o plano recusa script inexistente/bloqueado ANTES de qualquer conexão com o banco', async () => {
  const a = (await api('POST', '/api/scripts/analyze', { content: "DELETE FROM t\nGO\nEXEC xp_cmdshell 'x'" })).json;
  assert.equal(a.batches, 2);
  assert.equal(a.destructive[0].kw, 'DELETE');
  assert.equal(a.blocked[0].rule, 'xp');

  const proj = (await api('POST', '/api/projects', { name: 'P' })).json;
  const withBase = (await api('POST', `/api/projects/${proj.id}/bases`, { name: 'B', local: { server: 'localhost', database: 'X', auth: 'windows' } })).json;
  const baseId = withBase.bases[0].id;
  const body = (scriptIds) => ({ projectId: proj.id, baseId, env: 'local', filePath: 'C:/nao-existe.xlsx', sheets: [], scriptIds });

  assert.equal((await api('POST', '/api/import/plan', body(['nao-existe']))).status, 404);
  const bad = (await api('POST', '/api/scripts', { name: 'Perigoso', content: "SELECT 1\nGO\nEXEC xp_cmdshell 'dir'" })).json;
  const r = await api('POST', '/api/import/plan', body([bad.id]));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Perigoso.*não pode ser executado.*xp_/s);
  const tran = (await api('POST', '/api/scripts', { name: 'Com transacao', content: 'BEGIN TRAN\nUPDATE t SET a = 1\nCOMMIT' })).json;
  assert.match((await api('POST', '/api/import/plan', body([tran.id]))).json.error, /BEGIN TRAN|COMMIT/);
  assert.equal((await api('POST', '/api/import/plan', body([bad.id, bad.id]))).status, 400); // repetido

  fs.rmSync(path.join(dir, bad.file)); // arquivo sumiu do disco
  assert.match((await api('POST', '/api/import/plan', body([bad.id]))).json.error, /não foi encontrado/);
});

test('variáveis: a trava de execução recusa lote com {{…}} não substituído; a prévia mostra os valores usados', () => {
  const sc = { ...script('s1', 'Com variável', "UPDATE dbo.T SET b = 'ZMIGRA_X_PRD3'"), variables: { BANCO: 'ZMIGRA_X_PRD3' } };
  const p = plan([sc]);
  assert.ok(P.renderScript(p, { server: 's', database: 'd' }, { preview: true }).includes('-- Variável {{BANCO}} = ZMIGRA_X_PRD3'));
  const st = us(p)[0];
  assert.doesNotThrow(() => P.assertStatementSafe(st, { allowDestructive: false }));
  assert.throws(() => P.assertStatementSafe({ ...st, sql: "UPDATE dbo.T SET b = '{{BANCO}}'" }, { allowDestructive: false }), /variável/);
});

test('variáveis: nomes automáticos não podem ser redefinidos pela tela; valores perigosos são recusados', () => {
  const { cleanUserVars, checkVarValue, BUILTIN_VARS } = require('../src/scripts-api');
  assert.deepEqual(cleanUserVars({ banco: 'OUTRO', origem_1: ' ZMIGRA_A_PRD ', 'nome-ruim': 'x', VAZIA: '' }), { ORIGEM_1: 'ZMIGRA_A_PRD' });
  assert.ok(BUILTIN_VARS.BANCO && BUILTIN_VARS.SCHEMA);
  for (const ok of ['ZMIGRA_CLIENTEGAMA_CONSULT_PRD3', 'dbo', 'Base 1.2-x', 'Ação']) assert.equal(checkVarValue('X', ok), ok);
  for (const bad of ["a'b", 'a]b', 'a;b', 'a--b', 'a/*b', 'a\nb', '', 'x'.repeat(129)]) assert.throws(() => checkVarValue('X', bad), /não permitidos/, JSON.stringify(bad));
});

test('API: variáveis no plano — sem valor ou com valor perigoso é recusado antes de qualquer conexão', async () => {
  assert.ok((await api('GET', '/api/scripts-variables')).json.some((v) => v.name === 'BANCO'));
  const s = (await api('POST', '/api/scripts', { name: 'Concatena', content: "DECLARE @Destino SYSNAME = '{{BANCO}}';\nSELECT * FROM [{{ORIGEM}}].dbo.T" })).json;
  assert.deepEqual(s.analysis.variables, ['BANCO', 'ORIGEM']);
  const proj = (await api('POST', '/api/projects', { name: 'PV' })).json;
  const baseId = (await api('POST', `/api/projects/${proj.id}/bases`, { name: 'B', local: { server: 'localhost', database: 'ZMIGRA_X_PRD3', auth: 'windows' } })).json.bases[0].id;
  const body = (scriptVars) => ({ projectId: proj.id, baseId, env: 'local', filePath: 'C:/nao-existe.xlsx', sheets: [], scriptIds: [s.id], scriptVars });

  let r = await api('POST', '/api/import/plan', body({}));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Concatena.*\{\{ORIGEM\}\} sem valor/);
  r = await api('POST', '/api/import/plan', body({ ORIGEM: "X'; DROP TABLE y --" }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /\{\{ORIGEM\}\}.*não permitidos/);
  r = await api('POST', '/api/import/plan', body({ ORIGEM: 'ZMIGRA_A_PRD', BANCO: 'master' })); // BANCO da tela é ignorado
  assert.doesNotMatch(r.json.error || '', /variável|\{\{/); // passou das variáveis (falha depois, na planilha inexistente)
});
