// Exportação mensal dos apontamentos para .xlsx (ExcelJS, já usado na leitura das planilhas). É só LEITURA: nada é alterado.
// Durações vão como fração de dia com formato [h]:mm (passa de 24 h sem reiniciar), datas como datas e percentuais como percentuais.
const ExcelJS = require('exceljs');
const H = require('./hours');

const WEEKDAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const pad2 = (n) => String(n).padStart(2, '0');
const frac = (min) => min / 1440;
const excelDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }; // UTC: o Excel não desloca o dia
const signed = (min) => (min === 0 ? '00:00' : `${min > 0 ? '+' : '-'}${H.fmtHM(Math.abs(min))}`);
const DUR = '[h]:mm';

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002233' } };
function styleHeader(ws, widths) {
  const row = ws.getRow(1);
  row.height = 30;
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEAD_FILL;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF00DBFF' } } };
  });
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
const boldRow = (row) => row.eachCell((c) => { c.font = { bold: true }; c.border = { top: { style: 'thin' } }; });

async function buildWorkbook(data, year, month, today) {
  const cfg = data.hours;
  const { from, to } = H.monthRange(year, month);
  const entries = data.timeEntries.filter((e) => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  const by = H.groupByDate(data.timeEntries);
  const summary = (d) => H.daySummary(cfg, d, by.get(d) || []);
  const period = `${pad2(month)}/${year}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gerenciador de Projetos';
  wb.created = new Date();

  // ---- Apontamentos ----
  const ws = wb.addWorksheet('Apontamentos');
  ws.columns = [
    { header: 'Período' }, { header: 'Data' }, { header: 'Dia da semana' }, { header: 'Projeto' }, { header: 'Coordenador' }, { header: 'Analista' }, { header: 'Atividade realizada' },
    { header: 'Horário inicial' }, { header: 'Horário final' }, { header: 'Intervalos/Pausas' }, { header: 'Horas trabalhadas' }, { header: 'Meta diária' },
    { header: '% da Meta - Atividade' }, { header: 'Total do dia' }, { header: '% da Meta - Dia' }, { header: 'Horas restantes (dia)' }, { header: 'Horas excedentes (dia)' }, { header: 'Observação' },
  ];
  for (const e of entries) {
    const d = summary(e.date);
    const proj = data.projects.find((p) => p.id === e.projectId);
    const row = ws.addRow([
      period, excelDate(e.date), WEEKDAYS[d.dow], proj ? proj.name : e.projectName, e.coordinatorName || '-', e.analystName || '-', e.activity,
      frac(e.startMin), frac(e.endMin), frac(e.pausedMin || 0), frac(H.netMin(e)), frac(d.target),
      d.target ? H.netMin(e) / d.target : null, frac(d.confirmed), d.target ? d.confirmed / d.target : null, frac(d.remaining), frac(d.over), e.note || '-',
    ]);
    row.getCell(2).numFmt = 'dd/mm/yyyy';
    [8, 9].forEach((c) => { row.getCell(c).numFmt = 'hh:mm'; });
    [10, 11, 12, 14, 16, 17].forEach((c) => { row.getCell(c).numFmt = DUR; });
    [13, 15].forEach((c) => { row.getCell(c).numFmt = '0.00%'; });
    row.getCell(7).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(18).alignment = { wrapText: true, vertical: 'top' };
    [1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].forEach((c) => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'top' }; });
  }
  styleHeader(ws, [10, 12, 15, 26, 22, 22, 48, 11, 11, 12, 12, 11, 13, 11, 13, 13, 13, 30]);
  if (entries.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: entries.length + 1, column: 18 } };
    ws.addRow([]); // linha em branco: o filtro não inclui o total
    const total = ws.addRow(['Total', null, null, null, null, null, `${entries.length} apontamento(s)`, null, null, entries.reduce((n, e) => n + (e.pausedMin || 0), 0) / 1440,
      entries.reduce((n, e) => n + H.netMin(e), 0) / 1440]);
    total.getCell(10).numFmt = DUR; total.getCell(11).numFmt = DUR;
    total.getCell(10).alignment = { horizontal: 'center' }; total.getCell(11).alignment = { horizontal: 'center' };
    boldRow(total);
  }

  // ---- Resumo Mensal ----
  const sm = H.monthSummary(data, year, month, today);
  const tracking = H.trackingFrom(data, today);
  const rs = wb.addWorksheet('Resumo Mensal');
  rs.columns = [{ header: 'Data' }, { header: 'Dia da semana' }, { header: 'Meta' }, { header: 'Apontado' }, { header: 'Diferença' }, { header: 'Status' }, { header: 'Observações' }];
  const noteCount = new Map();
  for (const n of data.timeNotes || []) for (const d of H.datesOfNote(n)) noteCount.set(d, (noteCount.get(d) || 0) + 1);
  for (const d of sm.days) {
    if (d.target === 0 && d.confirmed === 0 && !noteCount.get(d.date)) continue; // dia sem meta, sem horas e sem observação não polui o resumo // fins de semana e dias sem meta e sem horas não poluem o resumo
    const future = d.date > today && d.confirmed === 0;
    const before = d.date < tracking && d.confirmed === 0; // antes de o controle começar: não conta como pendência (mesma regra da meta acumulada)
    const row = rs.addRow([excelDate(d.date), WEEKDAYS[d.dow], frac(d.target), frac(d.confirmed), future || before ? '-' : signed(d.confirmed - d.target),
      future ? 'A vencer' : before ? 'Antes do controle' : H.STATUS_LABEL[d.status] + (d.reason ? ` (${d.reason})` : ''), noteCount.get(d.date) || 0]);
    row.getCell(7).alignment = { horizontal: 'center' };
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(3).numFmt = DUR; row.getCell(4).numFmt = DUR;
    [1, 3, 4, 5, 6].forEach((c) => { row.getCell(c).alignment = { horizontal: 'center' }; });
    if (d.status === 'pendente' || d.status === 'sem_apontamento') { if (!future && !before) row.getCell(6).font = { color: { argb: 'FFB45309' }, bold: true }; }
    if (d.status === 'excedente') row.getCell(6).font = { color: { argb: 'FF0E7D66' }, bold: true };
  }
  styleHeader(rs, [13, 16, 11, 11, 12, 30, 13]);
  rs.addRow([]);
  const lines = [['Meta do mês', frac(sm.targetMonth), null], ['Meta acumulada (até hoje)', frac(sm.targetAccum), null], ['Apontado', frac(sm.confirmed), null], ['Diferença (apontado − acumulada)', null, signed(sm.confirmed - sm.targetAccum)]];
  for (const [label, v, text] of lines) {
    const r = rs.addRow([label, null, v, null, text]);
    r.getCell(3).numFmt = DUR; r.getCell(3).alignment = { horizontal: 'center' }; r.getCell(5).alignment = { horizontal: 'center' };
    r.getCell(1).font = { bold: true };
  }
  rs.addRow([]);
  rs.addRow([`Dias completos: ${sm.counts.completo}  ·  Dias pendentes: ${sm.counts.pendente}  ·  Dias excedentes: ${sm.counts.excedente}`]).getCell(1).font = { italic: true };

  // ---- Resumo por Projeto ----
  const rp = wb.addWorksheet('Resumo por Projeto');
  rp.columns = [{ header: 'Projeto' }, { header: 'Coordenador(es)' }, { header: 'Analista(s)' }, { header: 'Horas' }, { header: '% do total' }, { header: 'Apontamentos' }];
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.projectId) || { name: e.projectName, coords: new Set(), analysts: new Set(), min: 0, n: 0 };
    const proj = data.projects.find((p) => p.id === e.projectId);
    g.name = proj ? proj.name : e.projectName;
    if (e.coordinatorName) g.coords.add(e.coordinatorName);
    if (e.analystName) g.analysts.add(e.analystName);
    g.min += H.netMin(e); g.n++;
    groups.set(e.projectId, g);
  }
  const all = [...groups.values()].sort((a, b) => b.min - a.min);
  const totalMin = all.reduce((n, g) => n + g.min, 0);
  for (const g of all) {
    const r = rp.addRow([g.name, [...g.coords].join(', ') || '-', [...g.analysts].join(', ') || '-', frac(g.min), totalMin ? g.min / totalMin : 0, g.n]);
    r.getCell(4).numFmt = DUR; r.getCell(5).numFmt = '0.00%';
    [4, 5, 6].forEach((c) => { r.getCell(c).alignment = { horizontal: 'center' }; });
  }
  styleHeader(rp, [34, 30, 26, 12, 12, 14]);
  if (all.length) {
    rp.addRow([]);
    const t = rp.addRow(['Total', null, null, frac(totalMin), 1, all.reduce((n, g) => n + g.n, 0)]);
    t.getCell(4).numFmt = DUR; t.getCell(5).numFmt = '0.00%';
    [4, 5, 6].forEach((c) => { t.getCell(c).alignment = { horizontal: 'center' }; });
    boldRow(t);
  }
  // ---- Observações (uma linha por observação; as evidências ficam no app — aqui só a contagem e os nomes dos arquivos) ----
  const notes = (data.timeNotes || []).filter((n) => H.datesOfNote(n).some((d) => d >= from && d <= to)).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const ro = wb.addWorksheet('Observações');
  ro.columns = [{ header: 'Data' }, { header: 'Dia da semana' }, { header: 'Projeto' }, { header: 'Categoria' }, { header: 'Título' }, { header: 'Observação' }, { header: 'Qtd. evidências' }, { header: 'Evidências (arquivos)' }, { header: 'Registrada em' }, { header: 'Dias da observação' }];
  // Uma linha por observação E por dia (dá para filtrar por data); “Dias da observação” mostra todos os dias que ela cobre.
  for (const n of notes) for (const day of H.datesOfNote(n).filter((d) => d >= from && d <= to)) {
    const proj = n.projectId ? data.projects.find((p) => p.id === n.projectId) : null;
    const cat = H.noteCategory(data.hours, n.category);
    const row = ro.addRow([excelDate(day), WEEKDAYS[H.dowOf(day)], n.projectId ? (proj ? proj.name : n.projectName) : 'Geral', cat.label, n.title, n.description || '-', n.evidences.length, n.evidences.map((e) => e.name).join('; ') || '-', new Date(n.createdAt), H.datesOfNote(n).map((d) => `${d.slice(8)}/${d.slice(5, 7)}`).join(', ')]);
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(9).numFmt = 'dd/mm/yyyy hh:mm';
    [1, 2, 4, 7, 9].forEach((c) => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'top' }; });
    [3, 5, 6, 8, 10].forEach((c) => { row.getCell(c).alignment = { wrapText: true, vertical: 'top' }; });
  }
  styleHeader(ro, [12, 15, 24, 17, 32, 70, 11, 34, 17, 26]);
  if (ro.rowCount > 1) ro.autoFilter = { from: { row: 1, column: 1 }, to: { row: ro.rowCount, column: 10 } };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), name: `Apontamentos_${year}_${pad2(month)}.xlsx`, label: `${MONTHS[month - 1]}/${year}`, count: entries.length, notes: notes.length };
}

module.exports = { buildWorkbook, WEEKDAYS };
