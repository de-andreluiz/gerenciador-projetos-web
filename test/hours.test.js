const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-hrs-'));
const PORT = 4400;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { app } = require('../server');
const H = require('../src/hours');
const { clock } = require('../src/hours-api');
const ExcelJS = require('exceljs');

// Uma terça-feira de um mês futuro (depois da hora em que o servidor subiu), entre os dias 12 e 28.
function pickTuesday() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  while (d.getDay() !== 2 || d.getDate() < 12 || d.getDate() > 28) d.setDate(d.getDate() + 1);
  return d;
}
const TUE = pickTuesday();
const ds = (offset = 0) => { const d = new Date(TUE); d.setDate(d.getDate() + offset); return H.localParts(d.getTime()).date; };
const at = (hh, mm = 0, offset = 0, ss = 0) => { const d = new Date(TUE); d.setDate(d.getDate() + offset); d.setHours(hh, mm, ss, 0); return d.getTime(); };
const D0 = ds(0); // "hoje" nos testes (terça)

const cfgDefault = () => H.defaultHours();

// ---------- Regras puras ----------
test('meta: cálculo automático, semana padrão e exceções por data', () => {
  assert.equal(H.calcTarget('08:00', '18:00', 90), 510);
  assert.equal(H.fmtHM(510), '08:30');
  assert.equal(H.fmtHM(-60), '-01:00');
  assert.equal(H.fmtHM(10110), '168:30', 'passa de 24 h sem reiniciar');
  const cfg = cfgDefault();
  assert.equal(H.targetFor(cfg, D0).targetMin, 510);
  assert.equal(H.targetFor(cfg, ds(4)).targetMin, 0, 'sábado sem meta');
  cfg.overrides.push({ id: 'x', date: D0, targetMin: 0, reason: 'Feriado' });
  assert.deepEqual([H.targetFor(cfg, D0).targetMin, H.targetFor(cfg, D0).reason], [0, 'Feriado']);
  assert.equal(H.targetFor(cfg, ds(1)).targetMin, 510, 'a exceção vale só naquela data');
});

test('status do dia', () => {
  assert.equal(H.dayStatus(510, 510), 'completo');
  assert.equal(H.dayStatus(510, 450), 'pendente');
  assert.equal(H.dayStatus(510, 540), 'excedente');
  assert.equal(H.dayStatus(510, 0), 'sem_apontamento');
  assert.equal(H.dayStatus(0, 0), 'sem_meta', 'sábado sem horas não é pendência');
  assert.equal(H.dayStatus(0, 60), 'excedente');
});

test('cronômetro: pausas não contam e encerrar pausado termina onde pausou', () => {
  const t = { id: 't', startedAt: at(9), date: D0, status: 'running', pauses: [{ from: at(10), to: at(10, 30) }] };
  const d = H.draftFromTimer(t, at(12), at(12));
  assert.deepEqual([d.startMin, d.endMin, d.pausedMin, d.netMin], [540, 720, 30, 150]);
  assert.equal(H.timerNetSec(t, at(12)), 150 * 60);
  // pausada às 11:00 e só "encerrada" às 11:40 → o fim é 11:00
  const p = { id: 'p', startedAt: at(9), date: D0, status: 'paused', pauses: [{ from: at(11), to: null }] };
  const d2 = H.draftFromTimer(p, at(11, 40));
  assert.deepEqual([d2.endMin, d2.pausedMin, d2.netMin], [660, 0, 120]);
  assert.equal(H.timerNetSec(p, at(11, 40)), 120 * 60, 'pausada: o tempo para de correr');
  // o que passa da meia-noite é cortado no fim do dia de início
  const n = { id: 'n', startedAt: at(23, 30), date: D0, status: 'running', pauses: [] };
  const d3 = H.draftFromTimer(n, at(0, 20, 1));
  assert.equal(d3.crossedMidnight, true); assert.equal(d3.endMin, 1439);
});

test('sobreposição considera as pausas (dá para apontar algo dentro da pausa)', () => {
  const a = { id: 'a', date: D0, startMin: 540, endMin: 720, pausedMin: 30, pauses: [{ startMin: 600, endMin: 630 }] };
  const mk = (s, e) => ({ id: 'n', date: D0, startMin: s, endMin: e, pausedMin: 0 });
  assert.equal(H.overlaps(a, mk(600, 630)), false, 'cabe exatamente na pausa');
  assert.equal(H.overlaps(a, mk(690, 780)), true);
  assert.equal(H.overlaps(a, mk(720, 780)), false, 'encostar não é sobrepor');
  assert.equal(H.findOverlaps([a], { ...mk(0, 1), date: ds(1) }, null).length, 0, 'outro dia');
});

function fixtureData() {
  const data = require('../src/defaults').applyDefaults({ projects: [{ id: 'pA', name: 'Cliente A', coordinatorId: 'c1' }, { id: 'pB', name: 'Cliente B', coordinatorId: null }], coordinators: [{ id: 'c1', name: 'João Silva' }] });
  return data;
}

test('validação do apontamento: atividade obrigatória, futuro, horários, interno e coordenador', () => {
  const data = fixtureData();
  const now = at(15);
  const base = { date: D0, projectId: 'pA', activity: 'Validação PFUNC', start: '09:00', end: '11:30' };
  const ok = H.cleanEntry(base, { data, nowMs: now });
  assert.deepEqual([ok.startMin, ok.endMin, ok.coordinatorName, ok.projectName], [540, 690, 'João Silva', 'Cliente A']);
  assert.throws(() => H.cleanEntry({ ...base, activity: '  ' }, { data, nowMs: now }), /o que foi feito/);
  assert.throws(() => H.cleanEntry({ ...base, date: ds(1) }, { data, nowMs: now }), /futura/);
  assert.throws(() => H.cleanEntry({ ...base, end: '09:00' }, { data, nowMs: now }), /depois do inicial/);
  assert.throws(() => H.cleanEntry({ ...base, start: '14:00', end: '16:00' }, { data, nowMs: now }), /futuro/);
  assert.throws(() => H.cleanEntry({ ...base, pausedMin: 150 }, { data, nowMs: now }), /1 minuto/);
  assert.throws(() => H.cleanEntry({ ...base, projectId: 'nada' }, { data, nowMs: now }), /projeto/);
  const internal = H.cleanEntry({ ...base, projectId: 'internal' }, { data, nowMs: now });
  assert.deepEqual([internal.projectName, internal.coordinatorId], ['Interno / Administrativo', null]);
  // fotografia do coordenador: mudar no cadastro não altera o histórico
  const entry = { ...ok, id: 'e1' };
  data.projects[0].coordinatorId = null;
  data.coordinators = [];
  const edited = H.cleanEntry({ ...base, activity: 'Outra descrição' }, { data, nowMs: now, existing: entry });
  assert.equal(edited.coordinatorName, 'João Silva');
  assert.equal(H.cleanEntry({ ...base, projectId: 'pB' }, { data, nowMs: now, existing: entry }).coordinatorName, '', 'trocar o projeto refaz a leitura do cadastro');
});

test('dias pendentes, mês e alerta', () => {
  const data = fixtureData();
  const mk = (date, s, e, p = 0) => ({ id: `${date}${s}`, projectId: 'pA', projectName: 'Cliente A', date, startMin: s, endMin: e, pausedMin: p, activity: 'x', coordinatorName: '' });
  // seg 08:30 completo, ter 06:30 pendente, sáb/dom sem meta; hoje = quarta
  const wed = ds(1); const tue = D0; const mon = ds(-1); const sun = ds(-2); const sat = ds(-3); const fri = ds(-4);
  data.timeEntries = [mk(mon, 480, 990), mk(tue, 540, 930), mk(fri, 480, 900)];
  data.hours.trackingFrom = fri;
  const pending = H.pendingDays(data, wed).map((d) => [d.date, d.remaining]);
  assert.deepEqual(pending, [[tue, 120], [fri, 90]], 'sábado e domingo não entram; segunda está completa');
  data.hours.overrides.push({ id: 'o', date: tue, targetMin: 0, reason: 'Feriado' });
  assert.deepEqual(H.pendingDays(data, wed).map((d) => d.date), [fri], 'feriado (meta 0) não é pendência');
  assert.deepEqual(H.pendingDays(data, wed, { lookback: 0 }), [], 'janela mínima');
  data.hours.trackingFrom = tue;
  assert.deepEqual(H.pendingDays(data, wed).map((d) => d.date), [], 'nada antes de "pendências a partir de"');
  assert.ok(sat && sun);

  // alerta: só perto do fim, só com pendência
  const d = fixtureData();
  d.timeEntries = [mk(D0, 480, 930)]; // 07:30
  assert.equal(H.alertFor(d, at(16, 0)), null, 'ainda longe do fim');
  const a = H.alertFor(d, at(17, 35));
  assert.deepEqual([a.missing, a.target, a.confirmed, a.minutesLeft], [60, 510, 450, 25]);
  assert.equal(H.alertFor(d, at(18, 40)).afterEnd, true);
  d.timeEntries = [mk(D0, 480, 990)];
  assert.equal(H.alertFor(d, at(17, 45)), null, 'meta atingida: sem aviso');
  d.timeEntries = [mk(D0, 480, 1020)];
  assert.equal(H.alertFor(d, at(17, 45)), null, 'meta excedida: sem aviso');
  d.timeEntries = [];
  d.hours.alert.enabled = false;
  assert.equal(H.alertFor(d, at(17, 45)), null, 'aviso desligado');
  d.hours.alert.enabled = true;
  assert.equal(H.alertFor(d, at(17, 45, 4)), null, 'sábado: sem meta, sem aviso');
});

// ---------- API ----------
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setNow = (ms) => { clock.now = () => ms; };

test('API: jornada → cronômetro → pausas → confirmação → correção → dias anteriores → exportação', async () => {
  const server = app.listen(PORT, '127.0.0.1');
  try {
    setNow(at(8, 0));
    const coord = (await api('POST', '/api/coordinators', { name: 'João Silva' })).json;
    const pA = (await api('POST', '/api/projects', { name: 'Cliente A', coordinatorId: coord.id })).json;
    const pB = (await api('POST', '/api/projects', { name: 'Cliente B' })).json;

    // configuração
    const cfg = (await api('GET', '/api/hours/state')).json.config;
    assert.equal(cfg.schedule.week[2].targetMin, 510);
    const bad = await api('PUT', '/api/hours/config', { schedule: { start: '18:00', end: '08:00', breakMin: 90, week: cfg.schedule.week }, alert: { enabled: true, minutesBefore: 30 } });
    assert.equal(bad.status, 400);
    const good = JSON.parse(JSON.stringify(cfg)); good.schedule.week[5].targetMin = 480; // sexta 08:00
    assert.equal((await api('PUT', '/api/hours/config', { schedule: good.schedule, alert: good.alert })).status, 200);
    assert.equal((await api('POST', '/api/hours/overrides', { date: 'xx', targetMin: 0 })).status, 400);

    // iniciar: atividade obrigatória e projeto existente
    assert.equal((await api('POST', '/api/hours/timers/start', { projectId: pA.id, activity: '  ' })).status, 400);
    assert.equal((await api('POST', '/api/hours/timers/start', { projectId: 'nada', activity: 'x' })).status, 400);
    setNow(at(9, 0));
    const t1 = (await api('POST', '/api/hours/timers/start', { projectId: pA.id, activity: 'Validação PFUNC', note: 'obs' })).json.timer;
    assert.equal(t1.status, 'running');
    assert.equal(t1.coordinatorName, 'João Silva');
    setNow(at(9, 0, 0, 30));
    assert.equal((await api('GET', '/api/hours/state')).json.timers[0].netSec, 30, 'o tempo vem do servidor');

    // só uma ativa
    setNow(at(9, 30));
    const dup = await api('POST', '/api/hours/timers/start', { projectId: pB.id, activity: 'Ajuste financeiro' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, 'TIMER_ACTIVE');
    assert.equal(dup.json.timer.activity, 'Validação PFUNC');

    // pausa 10:00–10:30 (com a atividade seguinte no meio: pausar a atual e iniciar outra)
    setNow(at(10, 0));
    assert.equal((await api('POST', `/api/hours/timers/${t1.id}/pause`)).json.timer.status, 'paused');
    assert.equal((await api('POST', `/api/hours/timers/${t1.id}/pause`)).status, 400);
    setNow(at(10, 15));
    assert.equal((await api('GET', '/api/hours/state')).json.timers[0].netSec, 60 * 60, 'pausada: não corre');
    setNow(at(10, 30));
    assert.equal((await api('POST', `/api/hours/timers/${t1.id}/resume`, {})).json.timer.status, 'running');

    // resumo e confirmação às 12:00: 09:00→12:00 com 30 min de pausa = 02:30
    setNow(at(12, 0));
    const prev = (await api('POST', `/api/hours/timers/${t1.id}/preview`, {})).json;
    assert.deepEqual([prev.draft.startMin, prev.draft.endMin, prev.draft.pausedMin, prev.draft.netMin], [540, 720, 30, 150]);
    setNow(at(12, 5)); // demorou para clicar: vale o fim mostrado no resumo
    const conf = await api('POST', `/api/hours/timers/${t1.id}/confirm`, { endMs: prev.draft.endMs });
    assert.equal(conf.status, 200);
    assert.deepEqual([conf.json.entry.netMin, conf.json.entry.coordinatorName, conf.json.entry.source], [150, 'João Silva', 'timer']);
    assert.equal(conf.json.day.confirmed, 150);
    assert.equal(conf.json.day.remaining, 360);
    assert.equal((await api('GET', '/api/hours/state')).json.timers.length, 0);

    // manual: sobreposição bloqueada, mas dá para apontar dentro da pausa
    const man = (o) => api('POST', '/api/hours/entries', { date: D0, projectId: pB.id, activity: 'Reunião', start: '11:30', end: '13:00', ...o });
    setNow(at(15, 0));
    const ov = await man({});
    assert.equal(ov.status, 409); assert.equal(ov.json.code, 'HOURS_OVERLAP');
    assert.equal(ov.json.conflicts.length, 1);
    const inPause = await man({ start: '10:00', end: '10:30' });
    assert.equal(inPause.status, 200, 'cabe na pausa da outra atividade');
    assert.equal((await man({ start: '12:00', end: '13:00' })).status, 200);
    assert.equal((await man({ start: '14:00', end: '17:00', activity: '' })).status, 400);
    assert.equal((await man({ start: '14:00', end: '16:00', projectId: 'internal', activity: 'Treinamento' })).status, 400, 'fim no futuro (agora são 15:00)');
    assert.equal((await man({ start: '13:00', end: '14:30', projectId: 'internal', activity: 'Treinamento' })).json.entry.projectName, 'Interno / Administrativo');
    let day = (await api('GET', `/api/hours/day?date=${D0}`)).json;
    assert.deepEqual([day.confirmed, day.remaining, day.status, day.pct], [150 + 30 + 60 + 90, 510 - 330, 'pendente', 64.71]);

    // corrigir: sai a reunião da pausa, e o 1º apontamento vira 09:00–11:30 (recalcula sozinho)
    const first = day.entries[0];
    assert.equal((await api('DELETE', `/api/hours/entries/${inPause.json.entry.id}`)).json.day.confirmed, 300);
    const edit = await api('PUT', `/api/hours/entries/${first.id}`, { date: D0, projectId: pA.id, activity: 'Validação PFUNC (revisada)', start: '09:00', end: '11:30', pausedMin: 0 });
    assert.equal(edit.status, 200);
    assert.equal(edit.json.entry.netMin, 150);
    assert.equal(edit.json.entry.coordinatorName, 'João Silva');
    // mudar o coordenador do projeto NÃO altera o histórico
    await api('PUT', `/api/projects/${pA.id}`, { name: 'Cliente A', coordinatorId: null });
    day = (await api('GET', `/api/hours/day?date=${D0}`)).json;
    assert.equal(day.entries.find((e) => e.id === first.id).coordinatorName, 'João Silva');
    // e editar recalcula tudo
    const shorter = await api('PUT', `/api/hours/entries/${first.id}`, { date: D0, projectId: pA.id, activity: 'Validação PFUNC (revisada)', start: '09:00', end: '11:00' });
    assert.equal(shorter.json.day.confirmed, 120 + 60 + 90);
    assert.equal(shorter.json.day.remaining, 240);

    // dia anterior esquecido (segunda) e status
    const mon = ds(-1);
    assert.equal((await api('POST', '/api/hours/entries', { date: mon, projectId: pB.id, activity: 'Validação financeira', start: '14:00', end: '15:00' })).status, 200);
    const st = (await api('GET', '/api/hours/state')).json;
    assert.equal(st.trackingFrom, mon, 'o uso começa na data mais antiga apontada');
    assert.deepEqual(st.pending.map((d) => [d.date, d.remaining]), [[mon, 450]]);
    assert.equal((await api('POST', '/api/hours/entries', { date: ds(1), projectId: pB.id, activity: 'x', start: '08:00', end: '09:00' })).status, 400, 'data futura');

    // aviso perto do fim: 16:00 ainda longe; 17:40 avisa; nada é criado
    setNow(at(16, 0));
    assert.equal((await api('GET', '/api/hours/state')).json.alert, null);
    setNow(at(17, 40));
    const alert = (await api('GET', '/api/hours/state')).json.alert;
    assert.equal(alert.missing, 510 - 270);
    assert.equal((await api('GET', '/api/hours/state')).json.day.entries.length, 3, 'o aviso nunca cria apontamentos');

    // filtros do histórico
    const list = (await api('GET', `/api/hours/entries?from=${mon}&to=${D0}`)).json.days;
    assert.deepEqual(list.map((d) => d.date), [D0, mon]);
    assert.equal((await api('GET', `/api/hours/entries?from=${mon}&to=${D0}&status=pendente`)).json.days.length, 2);
    assert.equal((await api('GET', `/api/hours/entries?from=${mon}&to=${D0}&status=completo`)).json.days.length, 0);
    const onlyB = (await api('GET', `/api/hours/entries?from=${mon}&to=${D0}&projectId=${pB.id}`)).json.days;
    assert.ok(onlyB.every((d) => d.entries.every((e) => e.projectId === pB.id)));
    const proj = (await api('GET', `/api/hours/project/${pB.id}`)).json;
    assert.equal(proj.todayMin, 60);
    assert.equal(proj.last.length, 2);

    // reinício do app: cronômetro "rodando" tocado antes do servidor subir pede confirmação
    setNow(Date.now() - 86400000);
    const old = (await api('POST', '/api/hours/timers/start', { projectId: pB.id, activity: 'Ajuste antigo' })).json.timer;
    setNow(at(17, 45));
    const rec = (await api('GET', '/api/hours/state')).json;
    assert.deepEqual(rec.recovery, [old.id]);
    assert.equal((await api('POST', `/api/hours/timers/${old.id}/ack`)).status, 200);
    assert.deepEqual((await api('GET', '/api/hours/state')).json.recovery, []);
    assert.equal((await api('POST', `/api/hours/timers/${old.id}/discard`)).status, 200);

    // exportação: só leitura, colunas, formatos e totais acima de 24 h
    for (let i = 1; i <= 4; i++) await api('POST', '/api/hours/entries', { date: ds(-i - 1 - (i > 0 ? 0 : 0)), projectId: pA.id, activity: `Carga ${i}`, start: '08:00', end: '18:00' });
    const before = JSON.stringify((await api('GET', `/api/hours/entries?from=${ds(-30)}&to=${D0}`)).json);
    const [y, m] = D0.split('-').map(Number);
    const res = await fetch(`${base}/api/hours/export?year=${y}&month=${m}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), new RegExp(`Apontamentos_${y}_${String(m).padStart(2, '0')}\\.xlsx`));
    assert.equal(JSON.stringify((await api('GET', `/api/hours/entries?from=${ds(-30)}&to=${D0}`)).json), before, 'exportar não altera nada');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Apontamentos', 'Resumo Mensal', 'Resumo por Projeto', 'Observações']);
    const ws = wb.getWorksheet('Apontamentos');
    const head = ws.getRow(1).values.slice(1);
    for (const c of ['Período', 'Data', 'Dia da semana', 'Projeto', 'Coordenador', 'Analista', 'Atividade realizada', 'Horário inicial', 'Horário final', 'Intervalos/Pausas', 'Horas trabalhadas', 'Meta diária', '% da Meta - Atividade', '% da Meta - Dia', 'Horas restantes (dia)', 'Horas excedentes (dia)', 'Observação']) assert.ok(head.includes(c), c);
    assert.equal(ws.views[0].state, 'frozen');
    assert.ok(ws.autoFilter);
    const frac = (v) => (v instanceof Date ? (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : v); // o ExcelJS devolve como Date o que tem formato de hora
    const rows = []; ws.eachRow((r, n) => { if (n > 1) rows.push(r); });
    const r = rows.find((x) => x.getCell(7).value === 'Validação PFUNC (revisada)');
    assert.equal(r.getCell(1).value, `${String(m).padStart(2, '0')}/${y}`);
    assert.ok(r.getCell(2).value instanceof Date);
    assert.equal(r.getCell(2).numFmt, 'dd/mm/yyyy');
    assert.equal(r.getCell(3).value, 'Terça-feira');
    assert.equal(r.getCell(5).value, 'João Silva');
    assert.equal(r.getCell(6).value, '-', 'sem analista no projeto');
    assert.equal(r.getCell(11).numFmt, '[h]:mm');
    assert.equal(r.getCell(8).numFmt, 'hh:mm');
    assert.equal(r.getCell(13).numFmt, '0.00%');
    assert.ok(Math.abs(frac(r.getCell(11).value) - 120 / 1440) < 1e-9);
    assert.ok(Math.abs(r.getCell(13).value - 120 / 510) < 1e-9);
    assert.ok(Math.abs(r.getCell(15).value - 270 / 510) < 1e-9, '% do dia = total do dia / meta');
    const total = rows.find((x) => x.getCell(1).value === 'Total');
    assert.ok(frac(total.getCell(11).value) > 1, 'total acima de 24 h não reinicia');
    const sm = wb.getWorksheet('Resumo Mensal');
    let sawStatus = false; sm.eachRow((row) => { if (['Pendente', 'Completo', 'Excedente'].includes(row.getCell(6).value)) sawStatus = true; });
    assert.ok(sawStatus);
    const rp = wb.getWorksheet('Resumo por Projeto');
    assert.equal(rp.getRow(2).getCell(1).value, 'Cliente A', 'o projeto com mais horas vem primeiro');
    assert.equal((await fetch(`${base}/api/hours/export?year=2026&month=13`)).status, 400);

    // excluir e auditoria
    assert.equal((await api('DELETE', `/api/hours/entries/${first.id}`)).status, 200);
    assert.equal((await api('DELETE', `/api/hours/entries/${first.id}`)).status, 404);
    const acts = (await api('GET', '/api/audit')).json.map((x) => x.action);
    for (const a of ['horas-iniciada', 'horas-pausada', 'horas-retomada', 'horas-confirmada', 'horas-criada', 'horas-editada', 'horas-excluida', 'horas-descartada', 'horas-exportada', 'horas-config']) assert.ok(acts.includes(a), `auditoria sem ${a}`);
  } finally { clock.now = () => Date.now(); server.close(); }
});
