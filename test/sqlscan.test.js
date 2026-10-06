const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/sqlscan');

const rules = (sql) => S.analyzeScript(sql).blocked.map((b) => b.rule);
const destr = (sql) => S.analyzeScript(sql).destructive.map((d) => `${d.kw}x${d.count}`);

test('GO separa lotes; GO dentro de texto, comentário ou com contagem é tratado corretamente', () => {
  const sql = "SELECT 1\nGO\nSELECT 2\n  go  \nSELECT 'a\nGO\nb'\nGO 3\nSELECT 4 -- GO\n/*\nGO\n*/\nSELECT 5";
  const { batches } = S.prepareScript(sql);
  assert.equal(batches.length, 4 + 2); // 1, 2, 'a GO b', 4 e 5 (o "GO 3" expande a repetição do lote ANTERIOR: ver abaixo)
});

test('GO n repete o lote anterior n vezes (limitado)', () => {
  const { batches } = S.prepareScript('SELECT 1\nGO 3\nSELECT 2');
  assert.deepEqual(batches.map((b) => b.sql), ['SELECT 1', 'SELECT 1', 'SELECT 1', 'SELECT 2']);
  assert.equal(S.prepareScript('SELECT 1\nGO 9999').batches.length, 100);
});

test('palavras dentro de comentários, textos e [identificadores] não disparam regras', () => {
  const sql = [
    "-- DELETE FROM x; USE master; COMMIT",
    "/* DROP TABLE y /* aninhado */ ROLLBACK */",
    "SELECT 'DELETE FROM x; xp_cmdshell ''dir''' AS t, [Delete] AS c, [Drop Table] AS d, \"Commit\" AS e",
    "FROM Tabela",
  ].join('\n');
  const a = S.analyzeScript(sql);
  assert.deepEqual(a.blocked, []);
  assert.deepEqual(a.destructive, []);
});

test('bloqueia troca de banco, comandos de servidor/segurança e execução externa', () => {
  const cases = {
    'USE master': 'use', 'CREATE DATABASE X': 'database-ddl', 'drop database X': 'database-ddl',
    "EXEC xp_cmdshell 'dir'": 'xp', 'EXEC sp_configure "x", 1': 'sp-server', 'RECONFIGURE': 'reconfigure',
    "SELECT * FROM OPENROWSET(BULK 'c:\\x', SINGLE_CLOB) t": 'remote', 'BULK INSERT t FROM "c:\\x"': 'bulk',
    'BACKUP DATABASE X TO DISK = "y"': 'backup-restore', 'SHUTDOWN': 'shutdown', 'KILL 55': 'kill',
    'CREATE LOGIN a WITH PASSWORD = "x"': 'server-objects', "EXECUTE AS LOGIN = 'sa'": 'impersonate',
  };
  for (const [sql, rule] of Object.entries(cases)) assert.ok(rules(sql).includes(rule), `${sql} → ${rule}`);
});

test('bloqueia controle de transação (a transação é do app) e SET XACT_ABORT OFF', () => {
  for (const [sql, rule] of Object.entries({
    'BEGIN TRAN': 'tran-begin', 'begin transaction': 'tran-begin', 'COMMIT TRAN': 'tran-commit', 'ROLLBACK': 'tran-rollback',
    'SAVE TRANSACTION a': 'tran-save', 'SET XACT_ABORT OFF': 'xact-off', 'SET NOEXEC ON': 'noexec',
  })) assert.ok(rules(sql).includes(rule), `${sql} → ${rule}`);
  // BEGIN TRY / BEGIN CATCH não são transação
  assert.deepEqual(rules('BEGIN TRY SELECT 1 END TRY BEGIN CATCH SELECT 2 END CATCH'), []);
});

test('USE HINT (dica de consulta) não é troca de banco; diretivas SQLCMD são bloqueadas', () => {
  assert.deepEqual(rules("SELECT 1 OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))"), []);
  assert.ok(rules(':r c:\\outro.sql').includes('sqlcmd'));
  assert.ok(rules(':setvar A 1\nSELECT 1').includes('sqlcmd'));
});

test('avisos de comandos destrutivos, sem contar ON DELETE CASCADE', () => {
  assert.deepEqual(destr('DELETE FROM a WHERE x = 1\nDELETE b\nTRUNCATE TABLE c\nDROP TABLE d'), ['DELETEx2', 'TRUNCATEx1', 'DROPx1']);
  assert.deepEqual(destr('CREATE TABLE t (a int, b int REFERENCES p(id) ON DELETE CASCADE)'), []);
  assert.deepEqual(destr('CREATE INDEX i ON t(a) WITH (DROP_EXISTING = ON)'), []);
  assert.deepEqual(destr('UPDATE t SET a = 1'), []); // UPDATE não é "destrutivo" para o portão de produção
});

test('SQL dinâmico é sinalizado, e DELETE/DROP/TRUNCATE escondidos em TEXTO de SQL dinâmico também contam', () => {
  assert.equal(S.analyzeScript("EXEC('DELETE FROM x')").dynamic, true);
  assert.equal(S.analyzeScript("EXEC sp_executesql N'SELECT 1'").dynamic, true);
  assert.equal(S.analyzeScript('EXEC dbo.MinhaProc @a = 1').dynamic, false);
  assert.deepEqual(S.analyzeScript("EXEC('DELETE FROM x')").destructive.map((d) => [d.kw, !!d.dynamic]), [['DELETE', true]]);
  const drop = S.analyzeScript("DECLARE @s NVARCHAR(MAX) = N'IF 1=1 DROP TABLE ' + QUOTENAME(@t);\nEXEC sys.sp_executesql @s;");
  assert.deepEqual(drop.destructive.map((d) => [d.kw, d.dynamic, d.line]), [['DROP', true, 1]]);
  assert.equal(drop.counts.DROP, undefined); // contagem é só do código "visível"
  // sem SQL dinâmico no lote, texto é só texto (mensagens de PRINT não disparam nada)
  assert.deepEqual(S.analyzeScript("PRINT 'DROP e DELETE só na mensagem'").destructive, []);
  // bloqueios inequívocos também valem dentro do texto dinâmico
  assert.equal(S.analyzeScript("DECLARE @s NVARCHAR(100) = N'EXEC xp_cmdshell ''dir'''; EXEC(@s)").blocked[0].rule, 'xp');
  // palavras comuns em mensagens (USE, COMMIT) NÃO bloqueiam dentro de texto
  assert.deepEqual(S.analyzeScript("DECLARE @s NVARCHAR(100) = N'PRINT ''use o COMMIT'''; EXEC(@s)").blocked, []);
});

test('variáveis {{NOME}}: encontradas sem repetição, substituídas (maiúsc./minúsc. e espaços) e as sem valor informadas', () => {
  const t = "DECLARE @Destino SYSNAME = '{{BANCO}}';\n-- origem {{ origem_1 }}\nSELECT * FROM [{{Origem_1}}].dbo.T WHERE x = '{{banco}}' AND y = '{{FALTA}}'";
  assert.deepEqual(S.findVariables(t), ['BANCO', 'ORIGEM_1', 'FALTA']);
  assert.deepEqual(S.analyzeScript(t).variables, ['BANCO', 'ORIGEM_1', 'FALTA']);
  const r = S.applyVariables(t, { BANCO: 'ZMIGRA_X_PRD3', ORIGEM_1: 'ZMIGRA_A_PRD' });
  assert.deepEqual(r.missing, ['FALTA']);
  assert.deepEqual(r.used, { BANCO: 'ZMIGRA_X_PRD3', ORIGEM_1: 'ZMIGRA_A_PRD' });
  assert.ok(r.text.startsWith("DECLARE @Destino SYSNAME = 'ZMIGRA_X_PRD3';"));
  assert.ok(r.text.includes('[ZMIGRA_A_PRD].dbo.T') && r.text.includes("'{{FALTA}}'"));
  assert.equal(S.hasVariables(r.text), true);
  assert.equal(S.hasVariables(S.applyVariables(t, { BANCO: 'a', ORIGEM_1: 'b', FALTA: 'c' }).text), false);
  assert.deepEqual(S.findVariables('{{1X}} {{}} { {A} } {{A-B}}'), []); // não são variáveis
});

test('linhas dos achados apontam para a linha certa do script original', () => {
  const sql = 'SELECT 1\nGO\nSELECT 2\n/* comentario\nmultilinha */\nDELETE FROM t\nGO\nUSE master';
  const a = S.analyzeScript(sql);
  assert.equal(a.destructive[0].line, 6);
  assert.equal(a.blocked[0].line, 8);
  assert.equal(a.counts.DELETE, 1);
});

test('checkBatch revalida um lote isolado', () => {
  assert.deepEqual(S.checkBatch('UPDATE t SET a = 1').blocked, []);
  assert.ok(S.checkBatch("EXEC xp_cmdshell 'x'").blocked.length);
});

test('decodificação: UTF-8 com/sem BOM, UTF-16 e ANSI (Windows-1252)', () => {
  const texto = 'SELECT N\'Férias\' -- ação';
  assert.equal(S.decodeSqlBuffer(Buffer.from(texto, 'utf8')), texto);
  assert.equal(S.decodeSqlBuffer(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(texto, 'utf8')])), texto);
  assert.equal(S.decodeSqlBuffer(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(texto, 'utf16le')])), texto);
  const ansi = Buffer.from([0x46, 0xE9, 0x72, 0x69, 0x61, 0x73]); // "Férias" em ANSI: 0xE9 não é UTF-8 válido
  assert.equal(S.decodeSqlBuffer(ansi), 'Férias');
});

test('limites: script gigante é recusado; muitos lotes são sinalizados', () => {
  assert.throws(() => S.prepareScript('x'.repeat(S.MAX_SCRIPT_CHARS + 1)), /grande demais/);
  assert.equal(S.analyzeScript(Array.from({ length: S.MAX_BATCHES + 5 }, () => 'SELECT 1').join('\nGO\n')).tooManyBatches, true);
});
