const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-hn-'));
const PORT = 4402;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const H = require('../src/hours');
const { clock } = require('../src/hours-api');
const ExcelJS = require('exceljs');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { clock.now = () => Date.now(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function pickTuesday() { const d = new Date(); d.setDate(d.getDate() + 14); while (d.getDay() !== 2 || d.getDate() < 12 || d.getDate() > 28) d.setDate(d.getDate() + 1); return d; }
const TUE = pickTuesday();
const ds = (offset = 0) => { const d = new Date(TUE); d.setDate(d.getDate() + offset); return H.localParts(d.getTime()).date; };
const at = (hh, mm = 0, offset = 0) => { const d = new Date(TUE); d.setDate(d.getDate() + offset); d.setHours(hh, mm, 0, 0); return d.getTime(); };
const D0 = ds(0); const SAT = ds(4 - 7); // sábado anterior à terça

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 2)]);
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const upload = async (url, name, buf, { fileType = '' } = {}) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-File-Name': encodeURIComponent(name), 'X-File-Type': fileType, 'X-Description': encodeURIComponent('print ç') }, body: buf });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

test('validação da observação: título, data, categoria, projeto, severidade e vínculo com apontamento', () => {
  const data = require('../src/defaults').applyDefaults({ projects: [{ id: 'pA', name: 'Cliente A' }] });
  data.timeEntries = [{ id: 'e1', date: D0, projectId: 'pA' }];
  const now = at(15);
  const ok = H.cleanNote({ date: D0, title: '  Erro na carga PFUNC  ', description: 'dup', category: 'error', projectId: 'pA' }, { data, nowMs: now });
  assert.deepEqual([ok.title, ok.category, ok.projectName, ok.severity, ok.entryId], ['Erro na carga PFUNC', 'error', 'Cliente A', null, null]);
  assert.equal(H.cleanNote({ date: D0, title: 'Geral' }, { data, nowMs: now }).projectId, null, 'projeto é opcional');
  assert.equal(H.cleanNote({ date: D0, title: 'Geral' }, { data, nowMs: now }).category, 'info');
  assert.throws(() => H.cleanNote({ date: D0, title: '' }, { data, nowMs: now }), /título/);
  assert.throws(() => H.cleanNote({ date: ds(1), title: 'x' }, { data, nowMs: now }), /futura/);
  assert.throws(() => H.cleanNote({ date: D0, title: 'x', category: 'nada' }, { data, nowMs: now }), /Categoria/);
  assert.throws(() => H.cleanNote({ date: D0, title: 'x', projectId: 'zz' }, { data, nowMs: now }), /Projeto/);
  assert.throws(() => H.cleanNote({ date: D0, title: 'x', severity: 'extrema' }, { data, nowMs: now }), /Severidade/);
  assert.equal(H.cleanNote({ date: D0, title: 'x', severity: 'high', entryId: 'e1' }, { data, nowMs: now }).entryId, 'e1', 'já dá para ligar a um apontamento');
  assert.throws(() => H.cleanNote({ date: D0, title: 'x', entryId: 'e1', projectId: null, ...{ date: ds(-1) } }, { data, nowMs: now }), /não existe nesse dia/);
});

test('API: observações do dia — várias por dia, evidências reaproveitando o upload do checklist, edição, exclusão, filtros e exportação', async () => {
  clock.now = () => at(15, 0);
  const p = (await api('POST', '/api/projects', { name: 'Cliente A' })).json;
  const dataDir = process.env.GP_DATA_DIR;

  // um apontamento e duas observações no mesmo dia (uma geral, uma com projeto)
  assert.equal((await api('POST', '/api/hours/entries', { date: D0, projectId: p.id, activity: 'Validação PFUNC', start: '09:00', end: '12:00' })).status, 200);
  const n1 = await api('POST', '/api/hours/notes', { date: D0, title: 'Ambiente indisponível', description: 'Servidor caiu das 16:00 às 16:30.', category: 'unavailable' });
  const n2 = await api('POST', '/api/hours/notes', { date: D0, title: 'Erro na carga PFUNC', description: 'Registros duplicados na origem.', category: 'error', projectId: p.id });
  assert.equal(n1.status, 200); assert.equal(n2.status, 200);
  assert.equal(n1.json.note.projectName, '', 'observação geral');
  assert.equal(n2.json.note.projectName, 'Cliente A');
  assert.equal(n2.json.note.categoryLabel, 'Erro'); assert.equal(n2.json.note.tone, 'bad');
  assert.equal((await api('POST', '/api/hours/notes', { date: D0, title: '' })).status, 400);
  assert.equal((await api('POST', '/api/hours/notes', { date: ds(1), title: 'futuro' })).status, 400);
  assert.equal((await api('POST', '/api/hours/notes', { date: D0, title: 'x', category: 'inexistente' })).status, 400);
  assert.equal((await api('POST', '/api/hours/notes', { date: D0, title: 'x', projectId: 'nada' })).status, 400);
  // o que a tela manda de "evidences"/autoria é ignorado
  const forged = (await api('POST', '/api/hours/notes', { date: D0, title: 'Forjada', evidences: [{ id: 'x', file: '../../x' }], createdBy: 'outro' })).json.note;
  assert.deepEqual(forged.evidences, []);
  assert.notEqual(forged.createdBy, 'outro');
  await api('DELETE', `/api/hours/notes/${forged.id}`);

  let day = (await api('GET', `/api/hours/day?date=${D0}`)).json;
  assert.equal(day.noteCount, 2);
  assert.deepEqual(day.notes.map((n) => n.title), ['Ambiente indisponível', 'Erro na carga PFUNC']);
  assert.equal(day.confirmed, 180, 'as observações não alteram as horas, a meta nem o status do dia');
  assert.equal(day.status, 'pendente');

  // evidências: imagem + documento; recusa executável, conteúdo falso e tipo perigoso
  const evUrl = `/api/hours/notes/${n2.json.note.id}/evidence`;
  assert.equal((await upload(evUrl, 'virus.exe', Buffer.from('MZ....'))).status, 400);
  assert.equal((await upload(evUrl, 'falso.png', Buffer.from('<html>oi</html>'))).status, 400);
  assert.equal((await upload(evUrl, 'a.png', PNG, { fileType: 'text/html' })).status, 400);
  assert.equal((await upload(evUrl, 'planilha.svg', Buffer.from('<svg/>'))).status, 400);
  const e1 = await upload(evUrl, '..\\..\\Windows\\erro_pfunc.png', PNG, { fileType: 'image/png' });
  assert.equal(e1.status, 200, JSON.stringify(e1.json));
  assert.equal(e1.json.note.evidences[0].name, 'erro_pfunc.png', 'o nome enviado nunca vira caminho');
  assert.equal(e1.json.note.evidences[0].description, 'print ç');
  assert.equal((await upload(evUrl, 'relatorio_validacao.pdf', PDF)).status, 200);
  assert.equal((await upload(evUrl, 'erro_pfunc.png', PNG)).json.note.evidences.length, 3, 'mesmo nome não sobrescreve');
  const folder = path.join(dataDir, 'evidencias', 'horas', D0.slice(0, 7), D0);
  assert.equal(fs.readdirSync(folder).length, 3);
  assert.ok(!JSON.stringify((await api('GET', `/api/hours/day?date=${D0}`)).json).includes('horas/'), 'nenhum caminho de disco vai para a tela');
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).timeNotes.find((n) => n.id === n2.json.note.id);
  assert.ok(stored.evidences.every((e) => e.file.startsWith(`horas/${D0.slice(0, 7)}/${D0}/`) && !e.file.includes('..')));

  // visualizar / baixar com os mesmos cabeçalhos seguros do checklist
  const evId = e1.json.note.evidences[0].id;
  const view = await fetch(`${base}/api/hours/notes/${n2.json.note.id}/evidences/${evId}/file?inline=1`);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('content-type'), 'image/png'); assert.equal(view.headers.get('x-content-type-options'), 'nosniff'); assert.match(view.headers.get('content-disposition'), /^inline/);
  assert.match((await fetch(`${base}/api/hours/notes/${n2.json.note.id}/evidences/${evId}/file`)).headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(`${base}/api/hours/notes/${n2.json.note.id}/evidences/inexistente/file`)).status, 404);
  assert.equal((await fetch(`${base}/api/hours/notes/${n1.json.note.id}/evidences/${evId}/file`)).status, 404, 'evidência de outra observação não abre por aqui');

  // editar: título/texto/projeto/categoria; evidências continuam
  const ed = await api('PUT', `/api/hours/notes/${n2.json.note.id}`, { date: D0, title: 'Erro na carga PFUNC (reprocessada)', description: 'Carga refeita.', category: 'problem', projectId: null });
  assert.equal(ed.status, 200);
  assert.deepEqual([ed.json.note.title, ed.json.note.category, ed.json.note.projectName, ed.json.note.evidences.length], ['Erro na carga PFUNC (reprocessada)', 'problem', '', 3]);
  assert.ok(ed.json.note.updatedAt >= ed.json.note.createdAt);

  // remover UMA evidência move o arquivo (não apaga)
  const rm = await api('DELETE', `/api/hours/notes/${n2.json.note.id}/evidences/${evId}`);
  assert.equal(rm.json.note.evidences.length, 2);
  assert.equal(fs.readdirSync(path.join(dataDir, 'evidencias', '.removidas')).length, 1);

  // filtros do histórico e indicador; dia sem apontamento (sábado) mas com observação aparece
  await api('POST', '/api/hours/notes', { date: SAT, title: 'Plantão no sábado', category: 'info' });
  const all = (await api('GET', `/api/hours/entries?from=${SAT}&to=${D0}`)).json.days;
  assert.deepEqual(all.map((d) => [d.date, d.noteCount]), [[D0, 2], [SAT, 1]]);
  assert.deepEqual((await api('GET', `/api/hours/entries?from=${SAT}&to=${D0}&notes=with`)).json.days.map((d) => d.date), [D0, SAT]);
  assert.deepEqual((await api('GET', `/api/hours/entries?from=${SAT}&to=${D0}&notes=without`)).json.days.map((d) => d.date), []);
  const st = (await api('GET', '/api/hours/state')).json;
  assert.equal(st.notesToday, 2);
  assert.equal(st.recentNotes.length, 3);
  assert.equal(st.recentNotes[0].date, D0);
  const dayPending = st.pending.find((d) => d.date === D0);
  assert.equal(dayPending, undefined, 'hoje não entra em dias pendentes; o resumo curto vale para dias anteriores');

  // exportação: aba Observações (sem imagens, só nomes e contagem) e coluna no Resumo Mensal
  const [y, m] = D0.split('-').map(Number);
  const res = await fetch(`${base}/api/hours/export?year=${y}&month=${m}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Apontamentos', 'Resumo Mensal', 'Resumo por Projeto', 'Observações']);
  const ws = wb.getWorksheet('Observações');
  assert.deepEqual(ws.getRow(1).values.slice(1), ['Data', 'Dia da semana', 'Projeto', 'Categoria', 'Título', 'Observação', 'Qtd. evidências', 'Evidências (arquivos)', 'Registrada em', 'Dias da observação']);
  const rows = []; ws.eachRow((r, n) => { if (n > 1) rows.push(r.values.slice(1)); });
  const erro = rows.find((r) => String(r[4]).startsWith('Erro na carga'));
  assert.deepEqual([erro[2], erro[3], erro[6], erro[7]], ['Geral', 'Problema', 2, 'relatorio_validacao.pdf; erro_pfunc.png']);
  assert.ok(ws.getRow(2).getCell(1).value instanceof Date);
  assert.equal(ws.views[0].state, 'frozen');
  const sm = wb.getWorksheet('Resumo Mensal');
  assert.equal(sm.getRow(1).getCell(7).value, 'Observações');
  let tuesdayNotes = null; sm.eachRow((r, n) => { if (n > 1 && r.getCell(2).value === 'Terça-feira' && r.getCell(7).value === 2) tuesdayNotes = 2; });
  assert.equal(tuesdayNotes, 2);

  // renomear o projeto acompanha; remover o projeto mantém o nome gravado
  await api('PUT', `/api/hours/notes/${n2.json.note.id}`, { date: D0, title: 'Erro na carga PFUNC (reprocessada)', category: 'problem', projectId: p.id });
  await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente A Renomeado' });
  assert.equal((await api('GET', `/api/hours/day?date=${D0}`)).json.notes.find((n) => n.id === n2.json.note.id).projectName, 'Cliente A Renomeado');
  await api('DELETE', `/api/projects/${p.id}`);
  const gone = (await api('GET', `/api/hours/day?date=${D0}`)).json.notes.find((n) => n.id === n2.json.note.id);
  assert.deepEqual([gone.projectName, gone.projectExists], ['Cliente A', false], 'sem o projeto, vale o nome gravado quando a observação foi salva');
  assert.equal((await api('PUT', `/api/hours/notes/${n2.json.note.id}`, { date: D0, title: 'ainda edita', projectId: p.id })).status, 200, 'projeto removido continua válido para a observação que já o tinha');

  // excluir a observação com evidências: arquivos vão para .removidas, nada órfão
  const removedBefore = fs.readdirSync(path.join(dataDir, 'evidencias', '.removidas')).length;
  assert.equal((await api('DELETE', `/api/hours/notes/${n2.json.note.id}`)).status, 200);
  assert.equal(fs.readdirSync(path.join(dataDir, 'evidencias', '.removidas')).length, removedBefore + 2);
  assert.equal(fs.readdirSync(folder).length, 0, 'nenhum arquivo órfão na pasta do dia');
  assert.equal((await api('DELETE', `/api/hours/notes/${n2.json.note.id}`)).status, 404);
  assert.equal((await api('GET', `/api/hours/day?date=${D0}`)).json.noteCount, 1);

  const acts = (await api('GET', '/api/audit')).json.map((x) => x.action);
  for (const a of ['observacao-criada', 'observacao-editada', 'observacao-excluida', 'observacao-evidencia-adicionada', 'observacao-evidencia-removida']) assert.ok(acts.includes(a), `auditoria sem ${a}`);
});

test('observação do mês: vários dias do mesmo mês com um motivo e uma evidência; vários tipos no mês; aparece em cada dia, no mês e na planilha', async () => {
  clock.now = () => at(15, 0);
  const d1 = ds(-7); const d2 = ds(-1); const d3 = ds(0);
  const [y, m] = d3.split('-').map(Number);

  // legado: observação antiga (um dia só, sem `dates`) passa a ter a lista de dias
  const legacy = require('../src/defaults').applyDefaults({ projects: [], timeNotes: [{ id: 'old', date: '2026-03-05', title: 't', evidences: [] }] });
  assert.deepEqual(legacy.timeNotes[0].dates, ['2026-03-05']);

  // validações
  const bad = (b) => api('POST', '/api/hours/notes', { title: 'x', ...b });
  assert.equal((await bad({ dates: [] })).status, 400, 'sem dia');
  assert.equal((await bad({ dates: [d3, ds(-31)] })).status, 400, 'meses diferentes');
  assert.equal((await bad({ dates: [d3, ds(1)] })).status, 400, 'dia futuro');
  assert.equal((await bad({ dates: [d3, 'ontem'] })).status, 400, 'data inválida');
  assert.equal((await bad({ dates: [d3, d2], entryId: 'e1' })).status, 400, 'vínculo com apontamento só em observação de um dia');
  assert.equal((await bad({ dates: Array.from({ length: 32 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`) })).status, 400, 'no máximo 31 dias');

  // uma observação, três dias (repetido e fora de ordem é normalizado), com evidência anexada uma vez
  const a = await api('POST', '/api/hours/notes', { dates: [d3, d1, d1, d2], title: 'Dias sem lançamento', description: 'Sistema de apontamento do cliente fora do ar.', category: 'unavailable' });
  assert.equal(a.status, 200);
  const na = a.json.note;
  assert.deepEqual(na.dates, [d1, d2, d3]);
  assert.equal(na.date, d1);
  assert.equal((await upload(`/api/hours/notes/${na.id}/evidence`, 'comunicado.pdf', PDF, { fileType: 'application/pdf' })).status, 200);

  // um segundo tipo de observação, no mesmo mês, para outros dias
  const b = await api('POST', '/api/hours/notes', { dates: [d1, d3], title: 'Atraso do cliente', category: 'delay' });
  assert.equal(b.status, 200);

  // aparece em CADA dia (com a mesma evidência) e no histórico
  for (const d of [d1, d2, d3]) {
    const day = (await api('GET', `/api/hours/day?date=${d}`)).json;
    const found = day.notes.find((n) => n.id === na.id);
    assert.ok(found, `observação aparece em ${d}`);
    assert.equal(found.evidences.length, 1);
    assert.equal(found.dates.length, 3);
  }
  const hist = (await api('GET', `/api/hours/entries?from=${d1}&to=${d3}&notes=with`)).json.days;
  assert.deepEqual(hist.map((d) => d.date).sort(), [d1, d2, d3, SAT].sort(), 'os três dias da observação + o sábado que já tinha outra');
  assert.equal(hist.find((d) => d.date === d2).noteCount, 1);
  assert.equal(hist.find((d) => d.date === d1).noteCount, 2, 'a outra observação do mês também conta nesse dia');

  // mês: lista as observações do mês (cada uma uma vez)
  const month = (await api('GET', `/api/hours/month?year=${y}&month=${m}`)).json;
  const ids = month.notes.map((n) => n.id);
  assert.equal(ids.filter((id) => id === na.id).length, 1);
  assert.ok(ids.includes(b.json.note.id));
  assert.deepEqual(month.notes.find((n) => n.id === na.id).dates, [d1, d2, d3]);

  // Home: o dia mais recente da observação, sem duplicar
  const st = (await api('GET', '/api/hours/state')).json;
  assert.equal(st.recentNotes.filter((n) => n.id === na.id).length, 1);
  assert.equal(st.recentNotes.find((n) => n.id === na.id).dayCount, 3);

  // exportação: uma linha por dia + os dias da observação
  const res = await fetch(`${base}/api/hours/export?year=${y}&month=${m}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const rows = []; wb.getWorksheet('Observações').eachRow((r, n) => { if (n > 1) rows.push(r.values.slice(1)); });
  const mine = rows.filter((r) => r[4] === 'Dias sem lançamento');
  assert.equal(mine.length, 3);
  assert.deepEqual([...new Set(mine.map((r) => r[9]))], [[d1, d2, d3].map((d) => `${d.slice(8)}/${d.slice(5, 7)}`).join(', ')]);
  assert.ok(mine.every((r) => r[6] === 1 && r[7] === 'comunicado.pdf'));

  // editar os dias: sai de alguns dias, evidência intacta; não deixa cruzar o mês
  const ed = await api('PUT', `/api/hours/notes/${na.id}`, { dates: [d1, d2], title: 'Dias sem lançamento', category: 'unavailable' });
  assert.equal(ed.status, 200);
  assert.equal(ed.json.note.evidences.length, 1);
  assert.equal((await api('GET', `/api/hours/day?date=${d3}`)).json.notes.some((n) => n.id === na.id), false);
  assert.equal((await api('PUT', `/api/hours/notes/${na.id}`, { dates: [d1, ds(-31)], title: 'x' })).status, 400);

  // excluir a observação de vários dias: a evidência vai para .removidas uma vez e some de todos os dias
  const removedBefore = fs.readdirSync(path.join(process.env.GP_DATA_DIR, 'evidencias', '.removidas')).length;
  assert.equal((await api('DELETE', `/api/hours/notes/${na.id}`)).status, 200);
  assert.equal(fs.readdirSync(path.join(process.env.GP_DATA_DIR, 'evidencias', '.removidas')).length, removedBefore + 1);
  for (const d of [d1, d2]) assert.equal((await api('GET', `/api/hours/day?date=${d}`)).json.notes.some((n) => n.id === na.id), false);
});
