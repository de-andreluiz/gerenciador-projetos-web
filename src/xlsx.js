// Leitura de .xlsx: cada aba vira { name, columns[{index, header}], rows[[...]], rowNumbers[] }.
// Valores normalizados para null | string | number | boolean | Date.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { httpError } = require('./util');

// Converte o valor de uma célula. Regras:
//  - vazio, "" e fórmula sem valor → null
//  - fórmula com valor → o valor calculado (inclusive 0 e FALSE)
//  - erro de fórmula (#N/A, #REF!, #DIV/0!…) → null (contado em stats.formulaErrors)
//  - nunca devolve objeto: o que não for reconhecido vira null (jamais "[object Object]")
function normalize(v, stats = {}) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if ('error' in v) { stats.formulaErrors = (stats.formulaErrors || 0) + 1; return null; }
    if ('result' in v) return normalize(v.result, stats); // fórmula: valor calculado
    if (Array.isArray(v.richText)) return normalize(v.richText.map((t) => t.text).join(''), stats);
    if ('text' in v) return normalize(v.text, stats); // hyperlink (text pode ser rich text)
    if ('formula' in v || 'sharedFormula' in v) { stats.noValue = (stats.noValue || 0) + 1; return null; }
  }
  return null;
}

// O ExcelJS descarta resultados "falsy" de fórmula (0, FALSE, "") em cell.value; cell.result preserva o valor real.
function cellValue(cell, stats) {
  if (cell.type === ExcelJS.ValueType.Merge) {
    const master = cell.master;
    if (master && master !== cell) return cellValue(master, stats);
  }
  if (cell.type === ExcelJS.ValueType.Formula) {
    if (cell.result === undefined) { stats.noValue = (stats.noValue || 0) + 1; return null; }
    return normalize(cell.result, stats);
  }
  return normalize(cell.value, stats);
}

const isEmptyRow = (arr) => arr.every((x) => x === null);

async function readWorkbook(filePath) {
  if (!filePath || !/\.xlsx$/i.test(filePath)) throw httpError(400, 'Selecione um arquivo .xlsx.');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw httpError(400, `Arquivo não encontrado: ${filePath}`);
  const stat = fs.statSync(filePath);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(filePath);
  } catch (e) {
    throw httpError(400, `Não foi possível ler a planilha (arquivo aberto no Excel, corrompido ou protegido?): ${e.message}`);
  }

  const sheets = [];
  wb.eachSheet((ws) => {
    const width = ws.columnCount;
    const all = [];
    const numbers = [];
    const stats = { formulaErrors: 0, noValue: 0 };
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const vals = new Array(width).fill(null);
      for (let c = 1; c <= width; c++) vals[c - 1] = cellValue(row.getCell(c), stats);
      if (!isEmptyRow(vals)) { all.push(vals); numbers.push(rowNumber); }
    });
    if (!all.length) { sheets.push({ name: ws.name, state: ws.state, columns: [], rows: [], rowNumbers: [], notes: stats }); return; }

    const header = all[0];
    const body = all.slice(1);
    let last = -1;
    for (let c = 0; c < width; c++) {
      if (header[c] !== null || body.some((r) => r[c] !== null)) last = c;
    }
    const columns = [];
    for (let c = 0; c <= last; c++) columns.push({ index: c, header: header[c] === null ? '' : String(header[c]).trim() });
    sheets.push({
      name: ws.name,
      state: ws.state,
      columns,
      rows: body.map((r) => r.slice(0, last + 1)),
      rowNumbers: numbers.slice(1),
      notes: stats,
    });
  });

  return { file: path.resolve(filePath), size: stat.size, mtimeMs: stat.mtimeMs, sheets };
}

module.exports = { readWorkbook, normalize };
