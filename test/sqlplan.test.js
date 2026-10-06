const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/sqlplan');

const wb = (rows, headers = ['id', 'nome']) => ({
  sheets: [{
    name: 'Clientes', state: 'visible',
    columns: headers.map((h, i) => ({ index: i, header: h })),
    rows, rowNumbers: rows.map((_, i) => i + 2),
  }],
});
const sel = (extra = {}) => [{ sheetName: 'Clientes', schema: 'dbo', tableName: 'DEPARA_Clientes', mode: 'fail',
  columns: [{ index: 0, name: 'id', type: 'text' }, { index: 1, name: 'nome', type: 'text' }], ...extra }];

test('escapa aspas e neutraliza tentativa de injeção nos valores', () => {
  const evil = "x'); DROP TABLE dbo.Clientes; --";
  const plan = P.buildPlan(wb([['1', evil]]), sel(), { env: 'local' });
  const ins = plan.statements.find((s) => s.kind === 'insert');
  assert.ok(ins.sql.includes("N'x''); DROP TABLE dbo.Clientes; --'"));
  for (const s of plan.statements) P.assertStatementSafe(s, { allowDestructive: false });
});

test('trava recusa comandos fora do formato gerado', () => {
  const bad = [
    { kind: 'insert', sql: "INSERT INTO [dbo].[T] ([a]) VALUES\n(N'x'); DELETE FROM [dbo].[T];" },
    { kind: 'insert', sql: "INSERT INTO [dbo].[T] ([a]) VALUES\n(N'x'),\n(1); TRUNCATE TABLE [dbo].[T];" },
    { kind: 'create', sql: 'DROP TABLE [dbo].[T];' },
    { kind: 'guard', sql: "DELETE FROM [dbo].[T]" },
    { kind: 'qualquer', sql: 'SELECT 1' },
  ];
  for (const s of bad) assert.throws(() => P.assertStatementSafe(s, { allowDestructive: true }), /bloqueado/);
});

test('DROP/RENAME exigem autorização destrutiva explícita', () => {
  for (const mode of ['replace', 'backup']) {
    const plan = P.buildPlan(wb([['1', 'a']]), sel({ mode }), { env: 'local' });
    assert.equal(plan.destructive.length, 1);
    const st = plan.statements.find((s) => s.kind === (mode === 'replace' ? 'drop' : 'rename'));
    assert.throws(() => P.assertStatementSafe(st, { allowDestructive: false }), /destrutivo/);
    assert.doesNotThrow(() => P.assertStatementSafe(st, { allowDestructive: true }));
  }
});

test('modo fail não gera nenhum comando destrutivo', () => {
  const plan = P.buildPlan(wb([['1', 'a']]), sel(), { env: 'local' });
  assert.equal(plan.destructive.length, 0);
  assert.ok(!plan.statements.some((s) => /DROP|rename/i.test(s.sql.replace(/N'[^']*'/g, ''))));
});

test('produção bloqueia sobrescrita a menos que a base permita', () => {
  assert.throws(() => P.buildPlan(wb([['1', 'a']]), sel({ mode: 'replace' }), { env: 'prod' }), /bloqueado/);
  assert.doesNotThrow(() => P.buildPlan(wb([['1', 'a']]), sel({ mode: 'replace' }), { env: 'prod', allowOverwrite: true }));
});

test('valida identificadores', () => {
  for (const bad of ['a]; DROP', "x'y", 'a.b', '', ' x', '#tmp', 'a;b', 'x'.repeat(129)]) {
    assert.throws(() => P.validateIdent(bad, 'T'), /./, bad);
  }
  assert.doesNotThrow(() => P.validateIdent('DEPARA_Clientes 2024', 'T'));
  assert.doesNotThrow(() => P.validateIdent('Situação', 'T'));
  assert.equal(P.sanitizeIdent('Aba 1 / (novo)!', 'x'), 'Aba_1_novo');
});

test('lotes de INSERT respeitam 1000 linhas e a contagem é verificada', () => {
  const rows = Array.from({ length: 2500 }, (_, i) => [String(i), 'n' + i]);
  const plan = P.buildPlan(wb(rows), sel(), { env: 'local' });
  const inserts = plan.statements.filter((s) => s.kind === 'insert');
  assert.deepEqual(inserts.map((s) => s.rows), [1000, 1000, 500]);
  assert.match(plan.statements.at(-1).sql, /<> 2500/);
});

test('conversão de tipos e erros por linha/coluna', () => {
  assert.equal(P.convertValue(42, 'bigint').lit, '42');
  assert.ok(P.convertValue('4.2', 'bigint').err);
  assert.equal(P.convertValue('1.5', 'decimal').lit, '1.5');
  assert.ok(P.convertValue('1,5', 'decimal').err);
  assert.equal(P.convertValue('25/09/2026', 'datetime').lit, "'2026-09-25T00:00:00.000'");
  assert.ok(P.convertValue('31/02/2026', 'datetime').err);
  assert.equal(P.convertValue('Sim', 'bit').lit, '1');
  assert.equal(P.convertValue(null, 'bigint').lit, 'NULL');
  assert.equal(P.convertValue(0.1 + 0.2, 'text').lit, "N'0.3'");
  const plan = P.buildPlan(wb([['1', 'a'], ['x', 'b']]), sel({ columns: [{ index: 0, name: 'id', type: 'bigint' }, { index: 1, name: 'nome', type: 'text' }] }), { env: 'local' });
  assert.equal(plan.errors.length, 1);
  assert.deepEqual([plan.errors[0].row, plan.errors[0].column], [3, 'id']);
});

test('preserva zeros à esquerda quando a coluna é texto e sugere tipos', () => {
  assert.equal(P.convertValue('00123', 'text').lit, "N'00123'");
  assert.equal(P.suggestType(['00123', '5']), 'text');
  assert.equal(P.suggestType([1, 2, null]), 'bigint');
  assert.equal(P.suggestType([1.5, 2]), 'decimal');
});

test('tabelas e colunas duplicadas são recusadas', () => {
  const two = [...sel(), ...sel({ tableName: 'depara_clientes' })];
  assert.throws(() => P.buildPlan(wb([['1', 'a']]), two, { env: 'local' }), /duplicada/);
  assert.throws(() => P.buildPlan(wb([['1', 'a']]), sel({ columns: [{ index: 0, name: 'x', type: 'text' }, { index: 1, name: 'X', type: 'text' }] }), { env: 'local' }), /duplicada/);
});

test('hash muda quando qualquer comando muda', () => {
  const a = P.buildPlan(wb([['1', 'a']]), sel(), { env: 'local' }).hash;
  const b = P.buildPlan(wb([['1', 'b']]), sel(), { env: 'local' }).hash;
  assert.notEqual(a, b);
});

test('script exportado: cada lote (após o SET XACT_ABORT) tem a proteção contra execução em cascata no SSMS', () => {
  const plan = P.buildPlan(wb([['1', 'a']]), sel({ mode: 'replace' }), { env: 'prod', allowOverwrite: true });
  const script = P.renderScript(plan, { server: 's', database: 'd' });
  const lotes = script.split(/^GO\s*$/m).map((s) => s.trim()).filter(Boolean);
  const comGuard = lotes.filter((l) => l.includes('IF @@TRANCOUNT = 0 SET NOEXEC ON;'));
  // BEGIN TRANSACTION, SET XACT_ABORT e o SET NOEXEC OFF final ficam sem proteção; todo o resto (DROP, CREATE, INSERT, verificação, COMMIT) tem
  assert.equal(comGuard.length, lotes.length - 3);
  assert.ok(script.trimEnd().endsWith('SET NOEXEC OFF;\nGO'));
  for (const l of lotes.filter((x) => /DROP TABLE|CREATE TABLE|INSERT INTO|COMMIT/.test(x))) assert.ok(l.startsWith('IF @@TRANCOUNT = 0 SET NOEXEC ON;'), l.slice(0, 40));
  // a proteção é só texto: os comandos executados pelo app continuam exatamente os do plano (o hash não muda)
  assert.ok(!plan.statements.some((s) => s.sql.includes('NOEXEC')));
});
