// Controle de horas: regras puras (sem HTTP nem disco), para poderem ser testadas.
//
// CONCEITOS (não se misturam)
//  - Jornada (data.hours): a carga ESPERADA de cada dia. Configuração semanal padrão + exceções por data (feriado, expediente reduzido).
//    O intervalo da jornada só entra no cálculo da meta; nada tem a ver com as pausas do cronômetro.
//  - Apontamentos (data.timeEntries): como o tempo foi distribuído. Só os CONFIRMADOS contam para a meta.
//  - Cronômetros (data.timers): atividades em andamento ou pausadas. No máximo um "rodando". Guardam apenas timestamps
//    (início, pausas), então o tempo é sempre recalculado a partir deles — nunca depende de um contador em memória.
//
// TEMPO
//  - Data e horário são LOCAIS (o app roda na máquina da pessoa; mesmo padrão de todayStr()). Um apontamento é: data (AAAA-MM-DD) +
//    minutos desde a meia-noite (início/fim) + minutos de pausa. Duração = fim − início − pausas, em minutos inteiros: nunca texto,
//    nunca reinicia a cada 24 h (o total mensal passa de 168:30 sem problema). Totais derivados NUNCA são gravados.
//  - Um apontamento fica dentro de um único dia (o fim pode ser no máximo 24:00).
const { httpError, uid, str } = require('./util');
const { todayStr } = require('./schedule');

const INTERNAL = { id: 'internal', name: 'Interno / Administrativo' }; // atividades sem projeto: um "projeto" especial, nunca project_id vazio
const DAY_MIN = 1440;
const MAX_TIMERS = 10;
const NOTE_MAX_EVIDENCES = 10; // evidências por observação (o tamanho e os tipos vêm da configuração central de evidências)
const pad2 = (n) => String(n).padStart(2, '0');

// ---------- Datas e horas ----------
const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
};
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return todayStr(d); };
const dowOf = (s) => parseDate(s).getDay(); // 0 = domingo
const parseHM = (s) => { const m = /^(\d{1,3}):([0-5]\d)$/.exec(String(s ?? '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmtHM = (min) => `${min < 0 ? '-' : ''}${pad2(Math.floor(Math.abs(min) / 60))}:${pad2(Math.abs(min) % 60)}`;
function localParts(ms) {
  const d = new Date(ms);
  return { date: todayStr(d), sec: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(), min: d.getHours() * 60 + d.getMinutes() };
}
const monthRange = (y, m) => ({ from: `${y}-${pad2(m)}-01`, to: todayStr(new Date(y, m, 0)) });
const eachDate = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d); return out; };

// ---------- Jornada ----------
// Categorias das observações do dia. Vivem nos dados (não no código) para poderem ser editadas depois; "tone" é só a cor (info|warn|bad|none).
function defaultNoteCategories() {
  return [
    { id: 'info', label: 'Informação', tone: 'info' }, { id: 'problem', label: 'Problema', tone: 'warn' }, { id: 'error', label: 'Erro', tone: 'bad' },
    { id: 'delay', label: 'Atraso', tone: 'warn' }, { id: 'unavailable', label: 'Indisponibilidade', tone: 'bad' }, { id: 'adjust', label: 'Ajuste', tone: 'info' }, { id: 'other', label: 'Outro', tone: 'none' },
  ];
}
function defaultHours() {
  const week = {};
  for (let d = 0; d < 7; d++) week[d] = { targetMin: d >= 1 && d <= 5 ? 510 : 0, end: '' }; // seg–sex 08:30; fim de semana sem meta
  return { schedule: { start: '08:00', end: '18:00', breakMin: 90, week }, overrides: [], alert: { enabled: true, minutesBefore: 30, desktop: false }, trackingFrom: null, noteCategories: defaultNoteCategories() };
}

// Completa dados antigos sem mexer no que já existe (idempotente).
function ensureHours(data) {
  const def = defaultHours();
  if (!data.hours || typeof data.hours !== 'object') data.hours = def;
  const h = data.hours;
  h.schedule = { ...def.schedule, ...(h.schedule || {}) };
  h.schedule.week = { ...def.schedule.week, ...(h.schedule.week || {}) };
  for (let d = 0; d < 7; d++) h.schedule.week[d] = { ...def.schedule.week[d], ...h.schedule.week[d] };
  if (!Array.isArray(h.overrides)) h.overrides = [];
  h.alert = { ...def.alert, ...(h.alert || {}) };
  if (h.trackingFrom === undefined) h.trackingFrom = null;
  if (!Array.isArray(h.noteCategories) || !h.noteCategories.length) h.noteCategories = def.noteCategories;
  if (!Array.isArray(data.timeNotes)) data.timeNotes = []; // observações do dia/mês (evidências dentro de cada uma)
  for (const n of data.timeNotes) if (!Array.isArray(n.dates) || !n.dates.length) n.dates = [n.date]; // observações antigas (um dia só) passam a ter a lista de dias
  if (!Array.isArray(data.timeEntries)) data.timeEntries = [];
  if (!Array.isArray(data.timers)) data.timers = [];
  return data;
}

const calcTarget = (start, end, breakMin) => Math.max(0, (parseHM(end) ?? 0) - (parseHM(start) ?? 0) - (breakMin || 0));

// Valida a configuração enviada pela tela (metas em minutos).
function cleanConfig(body, prev) {
  const s = body.schedule || {};
  const start = str(s.start, 5);
  const end = str(s.end, 5);
  if (parseHM(start) === null || parseHM(end) === null || parseHM(start) >= DAY_MIN || parseHM(end) > DAY_MIN) throw httpError(400, 'Informe o início e o fim da jornada no formato HH:MM.');
  if (parseHM(end) <= parseHM(start)) throw httpError(400, 'O fim da jornada precisa ser depois do início.');
  const breakMin = Number(s.breakMin);
  if (!Number.isInteger(breakMin) || breakMin < 0 || breakMin > 600) throw httpError(400, 'O intervalo da jornada deve ter de 0 a 10 horas.');
  const week = {};
  for (let d = 0; d < 7; d++) {
    const w = (s.week || {})[d] || {};
    const t = Number(w.targetMin);
    if (!Number.isInteger(t) || t < 0 || t > DAY_MIN) throw httpError(400, 'A meta de cada dia deve ficar entre 00:00 e 24:00.');
    const e = str(w.end, 5);
    if (e && (parseHM(e) === null || parseHM(e) > DAY_MIN)) throw httpError(400, 'O fim previsto de cada dia precisa estar no formato HH:MM (ou vazio para usar o padrão).');
    week[d] = { targetMin: t, end: e };
  }
  const a = body.alert || {};
  const minutesBefore = Number(a.minutesBefore);
  if (!Number.isInteger(minutesBefore) || minutesBefore < 0 || minutesBefore > 480) throw httpError(400, 'O aviso antes do fim do expediente deve ser de 0 a 480 minutos.');
  let trackingFrom = prev.trackingFrom;
  if (body.trackingFrom !== undefined) {
    if (body.trackingFrom !== null && body.trackingFrom !== '' && !isDate(body.trackingFrom)) throw httpError(400, 'Data inválida em “Considerar pendências a partir de”.');
    trackingFrom = body.trackingFrom || null;
  }
  return { schedule: { start, end, breakMin, week }, overrides: prev.overrides, alert: { enabled: !!a.enabled, minutesBefore, desktop: !!a.desktop }, trackingFrom };
}

function cleanOverride(b) {
  if (!isDate(b.date)) throw httpError(400, 'Data inválida.');
  const t = Number(b.targetMin);
  if (!Number.isInteger(t) || t < 0 || t > DAY_MIN) throw httpError(400, 'A meta da exceção deve ficar entre 00:00 e 24:00.');
  return { date: b.date, targetMin: t, reason: str(b.reason, 120) };
}

function targetFor(cfg, date) {
  const ov = cfg.overrides.find((o) => o.date === date);
  if (ov) return { targetMin: ov.targetMin, reason: ov.reason, override: true };
  return { targetMin: cfg.schedule.week[dowOf(date)].targetMin, reason: '', override: false };
}
const endMinFor = (cfg, date) => parseHM(cfg.schedule.week[dowOf(date)].end) ?? parseHM(cfg.schedule.end);

// ---------- Apontamentos ----------
const netMin = (e) => e.endMin - e.startMin - (e.pausedMin || 0);

// Trechos realmente trabalhados (o período menos as pausas). Uma pausa "vaga" (só o total) ocupa o período inteiro.
function segments(e) {
  if (!e.pausedMin || !(e.pauses || []).length) return [[e.startMin, e.endMin]];
  const out = [];
  let cur = e.startMin;
  for (const p of [...e.pauses].sort((a, b) => a.startMin - b.startMin)) {
    if (p.startMin > cur) out.push([cur, p.startMin]);
    cur = Math.max(cur, p.endMin);
  }
  if (cur < e.endMin) out.push([cur, e.endMin]);
  return out;
}
const overlaps = (a, b) => segments(a).some(([s1, e1]) => segments(b).some(([s2, e2]) => s1 < e2 && s2 < e1));
const findOverlaps = (entries, cand, ignoreId) => entries.filter((e) => e.id !== ignoreId && e.date === cand.date && overlaps(e, cand));

function dayStatus(target, confirmed) {
  if (target === 0) return confirmed > 0 ? 'excedente' : 'sem_meta';
  if (confirmed === 0) return 'sem_apontamento';
  if (confirmed < target) return 'pendente';
  return confirmed === target ? 'completo' : 'excedente';
}
const STATUS_LABEL = { completo: 'Completo', pendente: 'Pendente', excedente: 'Excedente', sem_apontamento: 'Sem apontamento', sem_meta: 'Sem meta' };

function daySummary(cfg, date, entries) {
  const { targetMin, reason, override } = targetFor(cfg, date);
  const confirmed = entries.filter((e) => e.date === date).reduce((n, e) => n + netMin(e), 0);
  return {
    date, dow: dowOf(date), target: targetMin, reason, override, confirmed,
    remaining: Math.max(0, targetMin - confirmed), over: Math.max(0, confirmed - targetMin),
    pct: targetMin > 0 ? Math.round((confirmed / targetMin) * 10000) / 100 : null, status: dayStatus(targetMin, confirmed),
  };
}

function groupByDate(entries) {
  const m = new Map();
  for (const e of entries) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
  for (const l of m.values()) l.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  return m;
}

// Dias anteriores com horas faltando (meta > 0 e não atingida). Só a partir de "pendências a partir de" (senão o histórico anterior ao uso viraria pendência).
function trackingFrom(data, today) {
  const first = data.timeEntries.reduce((min, e) => (min === null || e.date < min ? e.date : min), null);
  return data.hours.trackingFrom || first || today;
}
function pendingDays(data, today, { lookback = 30 } = {}) {
  const from = [trackingFrom(data, today), addDays(today, -lookback)].sort().pop();
  const to = addDays(today, -1);
  if (from > to) return [];
  const by = groupByDate(data.timeEntries);
  return eachDate(from, to).map((d) => daySummary(data.hours, d, by.get(d) || [])).filter((s) => s.target > 0 && s.confirmed < s.target).reverse();
}

function monthSummary(data, y, m, today) {
  const { from, to } = monthRange(y, m);
  const by = groupByDate(data.timeEntries);
  const days = eachDate(from, to).map((d) => daySummary(data.hours, d, by.get(d) || []));
  const start = [from, trackingFrom(data, today)].sort().pop();
  const through = to < today ? to : today;
  const counted = days.filter((d) => d.date >= start && d.date <= through);
  const sum = (l, k) => l.reduce((n, d) => n + d[k], 0);
  const confirmed = sum(days, 'confirmed');
  const targetAccum = sum(counted, 'target');
  return {
    year: y, month: m, days, targetMonth: sum(days, 'target'), targetAccum, confirmed, diff: confirmed - targetAccum,
    // Hoje ainda está em andamento: só entra na contagem se já estiver completo ou excedente (não vira "pendente" antes de o dia acabar).
    counts: (() => {
      const closed = counted.filter((d) => d.date < today || d.status === 'completo' || d.status === 'excedente');
      return {
        completo: closed.filter((d) => d.status === 'completo').length, pendente: closed.filter((d) => d.status === 'pendente' || d.status === 'sem_apontamento').length,
        excedente: closed.filter((d) => d.status === 'excedente').length,
      };
    })(),
  };
}

// Aviso de horas faltando perto do fim do expediente. Só informa: nunca cria nada (jamais inventa horas).
function alertFor(data, nowMs) {
  const cfg = data.hours;
  if (!cfg.alert.enabled) return null;
  const { date, min } = localParts(nowMs);
  const day = daySummary(cfg, date, data.timeEntries);
  if (day.target === 0 || day.confirmed >= day.target) return null; // sem meta hoje, atingida ou excedida: sem aviso
  const endMin = endMinFor(cfg, date);
  if (min < endMin - cfg.alert.minutesBefore) return null;
  return { date, target: day.target, confirmed: day.confirmed, missing: day.remaining, endsAtMin: endMin, minutesLeft: Math.max(0, endMin - min), afterEnd: min >= endMin };
}

// ---------- Cronômetros ----------
// Timer: { id, projectId, projectName, coordinatorId, coordinatorName, activity, note, date, startedAt(ms), status:'running'|'paused',
//          pauses:[{from(ms), to(ms|null)}], lastActionAt(ms), createdAt }
function timerNetSec(t, nowMs, endMs = null) {
  const end = endMs ?? nowMs;
  let paused = 0;
  for (const p of t.pauses) {
    const from = Math.max(p.from, t.startedAt);
    const to = Math.min(p.to ?? end, end);
    if (to > from) paused += to - from;
  }
  return Math.max(0, Math.floor((end - t.startedAt - paused) / 1000));
}

// O que seria registrado se a atividade fosse encerrada agora: início/fim arredondados ao minuto, pausas dentro do período.
// Pausada: o fim é o momento em que pausou (o trabalho terminou ali, não no clique de "Encerrar").
function draftFromTimer(t, nowMs, endMs = null) {
  const open = t.status === 'paused' ? t.pauses.find((p) => p.to === null) : null;
  let end = open ? open.from : Math.min(nowMs, endMs ?? nowMs);
  end = Math.max(end, t.startedAt);
  const s = localParts(t.startedAt);
  const e = localParts(end);
  const crossed = e.date !== s.date;
  const startMin = Math.min(Math.round(s.sec / 60), DAY_MIN - 1);
  const endMin = crossed ? DAY_MIN - 1 : Math.min(Math.round(e.sec / 60), DAY_MIN);
  const pauses = [];
  for (const p of t.pauses) {
    const a = localParts(Math.max(p.from, t.startedAt));
    const b = localParts(Math.min(p.to ?? end, end));
    if (a.date !== s.date || b.date !== s.date) continue;
    const ps = Math.max(startMin, Math.round(a.sec / 60));
    const pe = Math.min(endMin, Math.round(b.sec / 60));
    if (pe > ps) pauses.push({ startMin: ps, endMin: pe });
  }
  const pausedMin = pauses.reduce((n, p) => n + (p.endMin - p.startMin), 0);
  return { date: t.date, startMin, endMin, pausedMin, pauses, netMin: endMin - startMin - pausedMin, endMs: end, crossedMidnight: crossed, netSec: timerNetSec(t, nowMs, end) };
}

// ---------- Validação de um apontamento ----------
// b: { date, projectId, activity, note, start:'HH:MM', end:'HH:MM', pausedMin, coordinatorId? }. Devolve os campos normalizados.
function cleanEntry(b, { data, nowMs, existing = null }) {
  const today = localParts(nowMs);
  if (!isDate(b.date)) throw httpError(400, 'Informe a data do apontamento.');
  if (b.date > today.date) throw httpError(400, 'Não é possível apontar horas em uma data futura.');
  const activity = str(b.activity, 300);
  if (!activity) throw httpError(400, 'Descreva a atividade realizada: todo apontamento precisa dizer o que foi feito.');
  const startMin = typeof b.startMin === 'number' ? b.startMin : parseHM(b.start);
  const endMin = typeof b.endMin === 'number' ? b.endMin : parseHM(b.end);
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin) || startMin < 0 || endMin > DAY_MIN) throw httpError(400, 'Informe o horário inicial e o final no formato HH:MM (dentro do mesmo dia).');
  if (endMin <= startMin) throw httpError(400, 'O horário final precisa ser depois do inicial.');
  if (b.date === today.date && endMin > today.min + 1) throw httpError(400, 'O horário final está no futuro.');
  const pausedMin = b.pausedMin === undefined || b.pausedMin === '' || b.pausedMin === null ? 0 : Number(b.pausedMin);
  if (!Number.isInteger(pausedMin) || pausedMin < 0) throw httpError(400, 'As pausas devem ser um número de minutos (0 ou mais).');
  if (endMin - startMin - pausedMin < 1) throw httpError(400, 'O tempo líquido precisa ser de pelo menos 1 minuto (as pausas não podem ocupar todo o período).');

  const projectId = str(b.projectId, 40);
  let projectName;
  if (projectId === INTERNAL.id) projectName = INTERNAL.name;
  else {
    const p = data.projects.find((x) => x.id === projectId);
    if (p) projectName = p.name;
    else if (existing && existing.projectId === projectId) projectName = existing.projectName; // projeto removido: mantém o histórico
    else throw httpError(400, 'Escolha um projeto (ou “Interno / Administrativo”).');
  }
  // Coordenador: fotografia no momento do apontamento (mudar o coordenador do projeto depois não altera o histórico).
  let coordinatorId = null;
  let coordinatorName = '';
  const proj = data.projects.find((x) => x.id === projectId);
  const sameProject = existing && existing.projectId === projectId;
  const wanted = b.coordinatorId === undefined ? (sameProject ? existing.coordinatorId : proj?.coordinatorId || null) : (b.coordinatorId || null);
  if (wanted) {
    const c = data.coordinators.find((x) => x.id === wanted);
    if (c) { coordinatorId = c.id; coordinatorName = c.name; }
    else if (sameProject && existing.coordinatorId === wanted) { coordinatorId = wanted; coordinatorName = existing.coordinatorName; } // coordenador removido do cadastro
    else if (b.coordinatorId) throw httpError(400, 'Coordenador inexistente.');
  }
  // Analista: fotografia do analista do projeto no momento do apontamento (não é escolhido no formulário). Editar sem trocar de projeto
  // mantém o que foi gravado; trocar de projeto pega o analista do projeto novo.
  let analystId = null;
  let analystName = '';
  if (sameProject && existing.analystId !== undefined) { analystId = existing.analystId || null; analystName = existing.analystName || ''; }
  else if (proj?.analystId) { const a = data.coordinators.find((x) => x.id === proj.analystId); if (a) { analystId = a.id; analystName = a.name; } }
  const same = existing && existing.date === b.date && existing.startMin === startMin && existing.endMin === endMin && existing.pausedMin === pausedMin;
  const out = { projectId, projectName, date: b.date, startMin, endMin, pausedMin, activity, note: str(b.note, 300), coordinatorId, coordinatorName, analystId, analystName };
  const pauses = Array.isArray(b.pauses) ? b.pauses : same ? existing.pauses : null; // posições das pausas só sobrevivem se o período não foi editado
  if (pausedMin > 0 && pauses && pauses.length) out.pauses = pauses;
  return out;
}

function assertNoOverlap(data, cand, ignoreId) {
  const hit = findOverlaps(data.timeEntries, cand, ignoreId);
  if (hit.length) {
    throw httpError(409, `Este período se sobrepõe a outro apontamento existente: ${hit.map((e) => `${fmtHM(e.startMin)}–${fmtHM(e.endMin)} (${e.activity})`).join('; ')}.`,
      { code: 'HOURS_OVERLAP', conflicts: hit.map((e) => ({ id: e.id, startMin: e.startMin, endMin: e.endMin, projectName: e.projectName, activity: e.activity })) });
  }
}

// ---------- Observações do dia ----------
// Uma observação vale para UM OU MAIS DIAS do mesmo mês (não de um apontamento): dias + título + texto + categoria, com projeto opcional
// (sem projeto = geral). Ex.: “dias 05, 12 e 19 não foram lançados porque…”, com a evidência anexada uma vez só. `date` = primeiro dia (compatibilidade).
// Já tem lugar para o que vem depois: severity (baixa/média/alta) e entryId (ligar a um apontamento específico do mesmo dia).
const SEVERITIES = ['low', 'medium', 'high'];
const MAX_NOTE_DATES = 31;
const datesOfNote = (n) => (Array.isArray(n.dates) && n.dates.length ? n.dates : [n.date]);
const noteCategory = (cfg, id) => cfg.noteCategories.find((c) => c.id === id) || { id, label: 'Outro', tone: 'none' };

function cleanNote(b, { data, nowMs, existing = null }) {
  const today = localParts(nowMs).date;
  const raw = Array.isArray(b.dates) ? b.dates : (b.date ? [b.date] : []);
  if (!raw.length) throw httpError(400, 'Informe a data (ou os dias) da observação.');
  if (raw.length > MAX_NOTE_DATES) throw httpError(400, `Uma observação aceita no máximo ${MAX_NOTE_DATES} dias.`);
  if (!raw.every((d) => typeof d === 'string' && isDate(d))) throw httpError(400, 'Há uma data inválida na observação.');
  const dates = [...new Set(raw)].sort();
  if (dates.some((d) => d > today)) throw httpError(400, 'Não é possível registrar observação em uma data futura.');
  if (new Set(dates.map((d) => d.slice(0, 7))).size > 1) throw httpError(400, 'Os dias de uma observação devem ser do mesmo mês. Crie uma observação para cada mês.');
  const title = str(b.title, 120);
  if (!title) throw httpError(400, 'Dê um título curto à observação (ex.: “Ambiente indisponível”).');
  const category = b.category ? str(b.category, 30) : (existing?.category || 'info');
  if (!data.hours.noteCategories.some((c) => c.id === category)) throw httpError(400, 'Categoria inválida.');
  const projectId = b.projectId ? str(b.projectId, 40) : null;
  let projectName = '';
  if (projectId) {
    if (projectId === INTERNAL.id) projectName = INTERNAL.name;
    else {
      const p = data.projects.find((x) => x.id === projectId);
      if (p) projectName = p.name;
      else if (existing && existing.projectId === projectId) projectName = existing.projectName; // projeto removido: mantém o histórico
      else throw httpError(400, 'Projeto inexistente.');
    }
  }
  const severity = b.severity ? str(b.severity, 10) : null;
  if (severity && !SEVERITIES.includes(severity)) throw httpError(400, 'Severidade inválida.');
  const entryId = b.entryId ? str(b.entryId, 40) : null;
  if (entryId && dates.length > 1) throw httpError(400, 'O vínculo com um apontamento só vale para observação de um único dia.');
  if (entryId && !data.timeEntries.some((e) => e.id === entryId && e.date === dates[0])) throw httpError(400, 'O apontamento escolhido não existe nesse dia.');
  return { date: dates[0], dates, title, description: str(b.description, 4000), category, projectId, projectName, severity, entryId };
}
// Uma observação de vários dias aparece em cada um deles.
const notesByDate = (data) => { const m = new Map(); for (const n of data.timeNotes) for (const d of datesOfNote(n)) { if (!m.has(d)) m.set(d, []); m.get(d).push(n); } for (const l of m.values()) l.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); return m; };

const dateOfMs = (ms) => localParts(ms).date;

module.exports = {
  NOTE_MAX_EVIDENCES, MAX_NOTE_DATES, datesOfNote, SEVERITIES, noteCategory, cleanNote, notesByDate, defaultNoteCategories,
  INTERNAL, DAY_MIN, MAX_TIMERS, STATUS_LABEL, isDate, parseDate, addDays, dowOf, parseHM, fmtHM, localParts, monthRange, eachDate, defaultHours, ensureHours, calcTarget,
  cleanConfig, cleanOverride, targetFor, endMinFor, netMin, segments, overlaps, findOverlaps, dayStatus, daySummary, groupByDate, trackingFrom, pendingDays, monthSummary,
  alertFor, timerNetSec, draftFromTimer, cleanEntry, assertNoOverlap, dateOfMs, uid,
};
