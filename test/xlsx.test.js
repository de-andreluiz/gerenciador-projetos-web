const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readWorkbook } = require('../src/xlsx');
const P = require('../src/sqlplan');
const makeFormulaWorkbook = require('./fixtures/make-formulas');

test('células com fórmula: valor quando existe, NULL quando vazio/sem valor/erro, nunca [object Object]', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-x-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'formulas.xlsx');
  await makeFormulaWorkbook(f);
  const wb = await readWorkbook(f);
  const by = Object.fromEntries(wb.sheets[0].rows.map((r) => [r[1], r[2]]));

  assert.equal(by['texto direto'], 'valor normal');
  assert.equal(by['fórmula com texto'], 'ABC-FORMULA');
  assert.equal(by['fórmula resultado número'], 5);
  assert.equal(by['fórmula resultado 0'], 0, '0 é um valor real e deve ser preservado');
  assert.equal(by['fórmula resultado FALSE'], false, 'FALSE é um valor real e deve ser preservado');
  assert.equal(by['fórmula resultado TRUE'], true);
  assert.ok(by['fórmula com data'] instanceof Date);
  assert.equal(by['fórmula compartilhada'], 'compartilhada');
  assert.equal(by['hyperlink'], 'clique aqui');
  assert.equal(by['rich text'], 'parte1 parte2');
  assert.equal(by['fórmula vazia ("")'], null);
  assert.equal(by['fórmula sem valor salvo'], null);
  assert.equal(by['fórmula com erro #N/A'], null);
  assert.equal(by['célula em branco'], null);

  for (const row of wb.sheets[0].rows) for (const v of row) assert.notEqual(v, '[object Object]');
  assert.equal(wb.sheets[0].notes.formulaErrors, 1);
  assert.equal(wb.sheets[0].notes.noValue, 2); // "" e sem valor salvo são indistinguíveis no arquivo
});

test('barreira final: objeto nunca é gravado como texto no SQL', () => {
  for (const type of ['text', 'bigint', 'decimal', 'datetime', 'bit']) {
    assert.equal(P.convertValue({ formula: 'A1' }, type).lit, 'NULL');
    assert.equal(P.convertValue({ error: '#N/A' }, type).lit, 'NULL');
  }
  assert.equal(P.convertValue(0, 'text').lit, "N'0'");
  assert.equal(P.convertValue(false, 'text').lit, "N'FALSE'");
});
