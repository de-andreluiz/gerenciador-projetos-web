// Gera uma planilha com todos os tipos de célula com fórmula que aparecem em exportações do Excel/Google Sheets.
const ExcelJS = require('exceljs');
module.exports = async function makeFormulaWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('DEPARA');
  ws.addRow(['CODIGO_DE', 'CASO', 'NOME_RM']);
  const cases = [
    ['texto direto', 'valor normal'],
    ['fórmula com texto', { formula: '"abc"', result: 'ABC-FORMULA' }],
    ['fórmula vazia ("")', { formula: 'IF(1=1,"","x")', result: '' }],
    ['fórmula sem valor salvo', { formula: 'A1&"x"' }],
    ['fórmula resultado 0', { formula: '1-1', result: 0 }],
    ['fórmula resultado FALSE', { formula: '1=2', result: false }],
    ['fórmula resultado TRUE', { formula: '1=1', result: true }],
    ['fórmula resultado número', { formula: '2+3', result: 5 }],
    ['fórmula com data', { formula: 'DATE(2026,1,15)', result: new Date(Date.UTC(2026, 0, 15)) }],
    ['fórmula com erro #N/A', { formula: 'NA()', result: { error: '#N/A' } }],
    ['hyperlink', { text: 'clique aqui', hyperlink: 'https://exemplo.com' }],
    ['rich text', { richText: [{ text: 'parte1 ' }, { text: 'parte2' }] }],
    ['célula em branco', null],
  ];
  cases.forEach(([caso, v], i) => { const r = ws.addRow([String(i + 1).padStart(3, '0'), caso, null]); if (v !== null) r.getCell(3).value = v; });
  // fórmula compartilhada (shared formula) com resultado vazio na 2ª linha
  const r = ws.addRow(['099', 'fórmula compartilhada', null]);
  r.getCell(3).value = { formula: 'B2', result: 'compartilhada' };
  await wb.xlsx.writeFile(file);
};
