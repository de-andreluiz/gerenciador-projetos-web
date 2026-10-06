// Importação por DIRETÓRIO (lote) — regras puras (sem HTTP/disco): quais arquivos entram, nome padrão da tabela de cada aba,
// colisões de nome e limpeza do que a tela envia. A leitura, o plano e a execução reutilizam o pipeline da importação de
// arquivo único (src/xlsx.js → sqlplan.buildPlan → db.precheck/executePlan); este módulo só decide o "o quê".
//
// Regras:
//  - Uma aba selecionada = uma tabela própria. Nunca duas abas na mesma tabela: nome repetido no lote bloqueia o plano.
//  - Nome padrão: o nome da aba; se o arquivo tem UMA aba relevante (visível e com dados), o nome do arquivo sem extensão.
//    Sanitização = a mesma da importação de arquivo único (sqlplan.sanitizeIdent, espaço → _).
//  - Colisão entre sugestões (A.xlsx/PFUNC e B.xlsx/PFUNC): a primeira, na ordem arquivo → aba, fica com o nome; as seguintes
//    recebem _2, _3… (mesmo padrão já usado para abas repetidas numa planilha). Nome digitado pelo usuário nunca é alterado.
const path = require('path');
const { httpError, str } = require('./util');
const plans = require('./sqlplan');

const MAX_FILES = 300;
const MAX_ITEMS = 200; // abas por lote
const XLSX_RE = /\.xlsx$/i; // mesmo formato aceito pela importação atual (src/xlsx.js); nada de biblioteca nova

// Nome de arquivo vindo da tela: só o nome (sem pasta), .xlsx, sem arquivo temporário do Excel (~$). O caminho é sempre
// montado no servidor a partir do diretório configurado na planilha.
function cleanFileName(name) {
  const n = str(name, 260);
  if (!n || n !== path.basename(n) || /[\\/:*?"<>|\u0000]/.test(n) || n === '.' || n === '..') throw httpError(400, `Nome de arquivo inválido: ${n || '(vazio)'}`);
  if (!XLSX_RE.test(n)) throw httpError(400, `O arquivo ${n} não é uma planilha .xlsx.`);
  if (n.startsWith('~$')) throw httpError(400, `${n} é um arquivo temporário do Excel (planilha aberta).`);
  return n;
}
// Entradas de fs.readdirSync({withFileTypes}) → planilhas candidatas, em ordem alfabética (estável para os nomes padrão).
function spreadsheetEntries(entries) {
  return entries.filter((e) => e.isFile() && XLSX_RE.test(e.name) && !e.name.startsWith('~$')).map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })).slice(0, MAX_FILES);
}

const tableBase = (raw) => plans.sanitizeIdent(raw, 'Tabela').replace(/ /g, '_');
const relevant = (sheets) => sheets.filter((s) => !s.hidden && s.rowCount > 0);
// Base do nome (antes de resolver colisões) para cada aba de um arquivo.
function baseNames(fileName, sheets) {
  const rel = relevant(sheets);
  const fromFile = rel.length === 1 ? rel[0].name : null;
  return sheets.map((s) => (s.name === fromFile ? tableBase(fileName.replace(XLSX_RE, '')) : tableBase(s.name)));
}
// items em ordem (arquivo → aba): { base, custom? } → nome final de cada um. Nomes personalizados entram primeiro como
// "ocupados" e nunca mudam; sugestões que colidiriam ganham _2, _3…
function assignNames(items) {
  const taken = new Set(items.filter((x) => x.custom).map((x) => x.custom.trim().toLowerCase()));
  return items.map((x) => {
    if (x.custom) return x.custom.trim();
    let n = x.base;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${x.base.slice(0, 120)}_${i}`;
    taken.add(n.toLowerCase());
    return n;
  });
}
// Tabelas repetidas no lote (mesmo schema, sem diferenciar maiúsculas): bloqueio claro, nunca consolidar.
function duplicateTables(items) {
  const seen = new Map(); const dups = [];
  for (const it of items) {
    const k = `${it.schema}.${it.table}`.toLowerCase();
    if (seen.has(k)) dups.push({ table: `${it.schema}.${it.table}`, a: seen.get(k), b: `${it.file} / ${it.sheet}` });
    else seen.set(k, `${it.file} / ${it.sheet}`);
  }
  return dups;
}

// O que a tela envia para gerar o plano do lote.
function cleanItems(raw, schemaRaw) {
  const schema = plans.validateIdent(str(schemaRaw, 128) || 'dbo', 'Schema');
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw httpError(400, 'Selecione ao menos uma aba para importar.');
  if (list.length > MAX_ITEMS) throw httpError(400, `No máximo ${MAX_ITEMS} abas por lote.`);
  const seen = new Set();
  return list.map((x) => {
    const file = cleanFileName(x.file);
    const sheet = str(x.sheet, 200);
    if (!sheet) throw httpError(400, `Aba sem nome em ${file}.`);
    const key = `${file}\u0001${sheet}`;
    if (seen.has(key)) throw httpError(400, `A aba ${sheet} de ${file} foi enviada duas vezes.`);
    seen.add(key);
    const table = plans.validateIdent(str(x.table, 128), `Tabela da aba "${sheet}" (${file})`);
    const mode = plans.MODES.includes(x.mode) ? x.mode : 'fail';
    return { file, sheet, schema, table, mode };
  });
}

// Colunas de uma aba para o plano: todas as colunas, com os nomes sugeridos; tipo = texto (mesmo padrão da importação de
// arquivo único, que preserva zeros à esquerda), ou o tipo sugerido se o usuário pediu.
function columnsFor(sheetDesc, useSuggestedTypes) {
  return sheetDesc.columns.map((c) => ({ index: c.index, name: c.suggestedName, type: useSuggestedTypes ? c.suggestedType : 'text' }));
}

// Configuração lembrada por planilha (seleção e nomes; NUNCA o modo de sobrescrita, como na importação de arquivo único).
function cleanBatchConfig(cfg, cleanUserVars) {
  const files = (Array.isArray(cfg?.files) ? cfg.files : []).slice(0, MAX_FILES).map((f) => ({
    name: str(f.name, 260), include: !!f.include,
    sheets: (Array.isArray(f.sheets) ? f.sheets : []).slice(0, 100).map((s) => ({ sheetName: str(s.sheetName, 200), include: !!s.include, tableName: str(s.tableName, 128) })),
  })).filter((f) => f.name);
  return {
    savedAt: new Date().toISOString(), schema: str(cfg?.schema, 128) || 'dbo', suggestedTypes: !!cfg?.suggestedTypes, files,
    scripts: { enabled: !!cfg?.scripts?.enabled, ids: (Array.isArray(cfg?.scripts?.ids) ? cfg.scripts.ids : []).map((i) => str(i, 40)).filter(Boolean).slice(0, 30), vars: cleanUserVars(cfg?.scripts?.vars) },
  };
}

module.exports = { MAX_FILES, MAX_ITEMS, cleanFileName, spreadsheetEntries, baseNames, assignNames, duplicateTables, cleanItems, columnsFor, cleanBatchConfig, tableBase };
