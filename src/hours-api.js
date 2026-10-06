// Rotas do controle de horas (regras em src/hours.js; planilha em src/hours-export.js).
// O servidor é a fonte do tempo: cada ação grava timestamps reais e a tela apenas exibe (e refaz a conta a cada recarga).
const { httpError, uid, str } = require('./util');
const E = require('./evidence');
const EH = require('./evidence-http');
const H = require('./hours');
const { buildWorkbook } = require('./hours-export');
const HB = require('./hours-backup');
const crypto = require('crypto');
const APP_VERSION = require('../package.json').version;

const BOOT_AT = Date.now(); // cronômetro "rodando" cuja última ação é anterior a esta hora sobreviveu a um reinício do app
const clock = { now: () => Date.now() }; // trocável nos testes

const { who } = require('./auth/identity');
const NOW_TOLERANCE_MS = 2000;

function mount(app, { store, audit, dataDir }) {
  const data = () => store.data;
  const files = () => store.files('hours-evidence');
  const log = (action, extra = {}) => audit.log({ action, by: who(), ...extra });
  const nowMs = () => clock.now();

  // ---------- Visões ----------
  const projectExists = (id) => id === H.INTERNAL.id || data().projects.some((p) => p.id === id);
  const projectNameOf = (id, fallback) => (id === H.INTERNAL.id ? H.INTERNAL.name : data().projects.find((p) => p.id === id)?.name || fallback);

  const entryView = (e) => ({ ...e, netMin: H.netMin(e), projectName: projectNameOf(e.projectId, e.projectName), projectExists: projectExists(e.projectId) });
  const timerView = (t, now) => ({
    id: t.id, projectId: t.projectId, projectName: projectNameOf(t.projectId, t.projectName), projectExists: projectExists(t.projectId), coordinatorName: t.coordinatorName, analystName: t.analystName || '',
    activity: t.activity, note: t.note, date: t.date, startedAt: t.startedAt, status: t.status, pauses: t.pauses, lastActionAt: t.lastActionAt, netSec: H.timerNetSec(t, now),
  });
  // Rodando, mas ninguém mexeu nele desde antes do app subir (reinício) ou desde um dia anterior (passou a noite rodando): a pessoa decide.
  const needsRecovery = (t, now) => t.status === 'running' && (t.lastActionAt < BOOT_AT || H.dateOfMs(t.lastActionAt) !== H.localParts(now).date);
  // Observação do dia: o nome do projeto é o atual (se o projeto ainda existe) ou a fotografia gravada; a tela nunca recebe caminhos do disco.
  const noteView = (n) => {
    const c = H.noteCategory(data().hours, n.category);
    return {
      id: n.id, date: n.date, dates: H.datesOfNote(n), title: n.title, description: n.description, category: n.category, categoryLabel: c.label, tone: c.tone, severity: n.severity, entryId: n.entryId,
      projectId: n.projectId, projectName: n.projectId ? projectNameOf(n.projectId, n.projectName) : '', projectExists: n.projectId ? projectExists(n.projectId) : true,
      createdAt: n.createdAt, updatedAt: n.updatedAt, createdBy: n.createdBy, updatedBy: n.updatedBy, evidences: n.evidences.map((v) => EH.evidencePublic(files(), v)),
    };
  };
  const lastDateOf = (n) => { const d = H.datesOfNote(n); return d[d.length - 1]; }; // o dia mais recente da observação (Home)
  const notesOf = (date) => data().timeNotes.filter((n) => H.datesOfNote(n).includes(date)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Resumo curto de um dia (para as listas): quantas observações e as primeiras, sem os textos longos.
  const noteBrief = (date) => {
    const l = notesOf(date);
    return { noteCount: l.length, notes: l.slice(0, 3).map((n) => ({ id: n.id, title: n.title, category: n.category, tone: H.noteCategory(data().hours, n.category).tone, categoryLabel: H.noteCategory(data().hours, n.category).label, evidenceCount: n.evidences.length })) };
  };
  const dayView = (date) => {
    const list = data().timeEntries.filter((e) => e.date === date).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    const notes = notesOf(date);
    return { ...H.daySummary(data().hours, date, data().timeEntries), entries: list.map(entryView), notes: notes.map(noteView), noteCount: notes.length };
  };

  app.get('/api/hours/state', (req, res) => {
    const now = nowMs();
    const today = H.localParts(now).date;
    const [y, m] = today.split('-').map(Number);
    const ms = H.monthSummary(data(), y, m, today);
    res.json({
      nowMs: now, today, nowMin: H.localParts(now).min, config: data().hours, day: dayView(today), timers: data().timers.map((t) => timerView(t, now)),
      recovery: data().timers.filter((t) => needsRecovery(t, now)).map((t) => t.id), pending: H.pendingDays(data(), today).map((d) => ({ ...d, ...noteBrief(d.date) })),
      notesToday: notesOf(today).length,
      recentNotes: [...data().timeNotes].filter((n) => lastDateOf(n) >= H.addDays(today, -14)).sort((a, b) => lastDateOf(b).localeCompare(lastDateOf(a)) || b.createdAt.localeCompare(a.createdAt)).slice(0, 4)
        .map((n) => ({ id: n.id, date: lastDateOf(n), dayCount: H.datesOfNote(n).length, title: n.title, category: n.category, tone: H.noteCategory(data().hours, n.category).tone, categoryLabel: H.noteCategory(data().hours, n.category).label, projectName: n.projectId ? projectNameOf(n.projectId, n.projectName) : '', evidenceCount: n.evidences.length })),
      month: { year: y, month: m, targetMonth: ms.targetMonth, targetAccum: ms.targetAccum, confirmed: ms.confirmed, diff: ms.diff, counts: ms.counts },
      alert: H.alertFor(data(), now), trackingFrom: H.trackingFrom(data(), today),
    });
  });

  app.get('/api/hours/day', (req, res) => {
    if (!H.isDate(req.query.date)) throw httpError(400, 'Data inválida.');
    res.json(dayView(req.query.date));
  });

  app.get('/api/hours/month', (req, res) => {
    const y = Number(req.query.year); const m = Number(req.query.month);
    if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) throw httpError(400, 'Mês ou ano inválido.');
    const today = H.localParts(nowMs()).date;
    const ms = H.monthSummary(data(), y, m, today);
    const ym = `${y}-${String(m).padStart(2, '0')}`; // observações do mês (cada uma pode valer para vários dias do mês)
    const notes = data().timeNotes.filter((n) => n.date.slice(0, 7) === ym).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    res.json({ ...ms, days: ms.days.map((d) => ({ date: d.date, target: d.target, confirmed: d.confirmed, status: d.status })), notes: notes.map(noteView) });
  });

  // Histórico por dia (mais recente primeiro). Filtros: período, projeto (só os apontamentos dele) e status do DIA.
  app.get('/api/hours/entries', (req, res) => {
    const now = nowMs();
    const today = H.localParts(now).date;
    const to = H.isDate(req.query.to) ? req.query.to : today;
    const from = H.isDate(req.query.from) ? req.query.from : H.addDays(to, -30);
    if (from > to) throw httpError(400, 'A data inicial é depois da final.');
    const projectId = str(req.query.projectId, 40);
    const status = str(req.query.status, 20);
    const withNotes = ['with', 'without'].includes(req.query.notes) ? req.query.notes : ''; // Todos / Com observações / Sem observações
    const by = H.groupByDate(data().timeEntries);
    const nby = H.notesByDate(data());
    const tracking = H.trackingFrom(data(), today);
    const days = [];
    for (const d of H.eachDate(from, to).reverse()) {
      const s = H.daySummary(data().hours, d, by.get(d) || []);
      let list = by.get(d) || [];
      let notes = nby.get(d) || [];
      if (projectId) { list = list.filter((e) => e.projectId === projectId); notes = notes.filter((n) => n.projectId === projectId); }
      const visible = projectId ? (list.length || notes.length) : (list.length || notes.length || (s.target > 0 && d >= tracking && d <= today));
      if (!visible || (status && s.status !== status)) continue;
      if ((withNotes === 'with' && !(nby.get(d) || []).length) || (withNotes === 'without' && (nby.get(d) || []).length)) continue;
      days.push({ ...s, entries: list.map(entryView), notes: notes.map(noteView), noteCount: (nby.get(d) || []).length });
    }
    res.json({ from, to, days });
  });

  // Números do projeto (card dentro da página do projeto).
  app.get('/api/hours/project/:id', (req, res) => {
    const id = req.params.id;
    const now = nowMs();
    const today = H.localParts(now).date;
    const monthFrom = `${today.slice(0, 7)}-01`;
    const mine = data().timeEntries.filter((e) => e.projectId === id);
    const sum = (l) => l.reduce((n, e) => n + H.netMin(e), 0);
    res.json({
      todayMin: sum(mine.filter((e) => e.date === today)), monthMin: sum(mine.filter((e) => e.date >= monthFrom && e.date <= today)),
      last: [...mine].sort((a, b) => b.date.localeCompare(a.date) || b.startMin - a.startMin).slice(0, 5).map(entryView),
    });
  });

  // ---------- Configuração da jornada ----------
  app.put('/api/hours/config', async (req, res) => {
    const today = H.localParts(nowMs()).date;
    const next = H.cleanConfig(req.body || {}, data().hours);
    data().hours = next;
    if (!next.trackingFrom) next.trackingFrom = H.trackingFrom(data(), today);
    await store.save();
    log('horas-config', { detalhe: `Jornada ${next.schedule.start}–${next.schedule.end}, intervalo ${H.fmtHM(next.schedule.breakMin)}` });
    res.json({ config: data().hours });
  });
  app.post('/api/hours/overrides', async (req, res) => {
    const o = H.cleanOverride(req.body || {});
    const list = data().hours.overrides.filter((x) => x.date !== o.date);
    data().hours.overrides = [...list, o].sort((a, b) => a.date.localeCompare(b.date));
    await store.save();
    log('horas-config', { detalhe: `Exceção de meta em ${o.date}: ${H.fmtHM(o.targetMin)}${o.reason ? ` (${o.reason})` : ''}` });
    res.json({ config: data().hours });
  });
  app.delete('/api/hours/overrides/:date', async (req, res) => {
    data().hours.overrides = data().hours.overrides.filter((x) => x.date !== req.params.date);
    await store.save();
    res.json({ config: data().hours });
  });

  // ---------- Cronômetros ----------
  const timerOrThrow = (id) => data().timers.find((t) => t.id === id) || (() => { throw httpError(404, 'Atividade não encontrada.'); })();
  const running = () => data().timers.find((t) => t.status === 'running');
  const auditTimer = (action, t, extra = {}) => log(action, { project: projectNameOf(t.projectId, t.projectName), detalhe: t.activity, ...extra });

  function pauseNow(t, now) {
    t.pauses.push({ from: now, to: null });
    t.status = 'paused';
    t.lastActionAt = now;
  }
  // Só uma atividade rodando por vez: sem "replace" avisa (409); com "replace" pausa a atual (não a encerra) e segue.
  function makeRoom(now, replace) {
    const cur = running();
    if (!cur) return;
    if (!replace) throw httpError(409, 'Já existe uma atividade em andamento.', { code: 'TIMER_ACTIVE', timer: timerView(cur, now) });
    pauseNow(cur, now);
    auditTimer('horas-pausada', cur, { resultado: 'pausada para iniciar outra' });
  }

  app.post('/api/hours/timers/start', async (req, res) => {
    const now = nowMs();
    const b = req.body || {};
    const projectId = str(b.projectId, 40);
    if (!projectExists(projectId)) throw httpError(400, 'Escolha um projeto (ou “Interno / Administrativo”).');
    const activity = str(b.activity, 300);
    if (!activity) throw httpError(400, 'Informe a atividade que será realizada.');
    if (data().timers.length >= H.MAX_TIMERS) throw httpError(400, 'Há atividades pausadas demais. Encerre ou descarte algumas antes de iniciar outra.');
    makeRoom(now, !!b.replace);
    const proj = data().projects.find((p) => p.id === projectId);
    const coord = proj?.coordinatorId ? data().coordinators.find((c) => c.id === proj.coordinatorId) : null;
    const t = {
      id: uid(), projectId, projectName: projectNameOf(projectId), coordinatorId: coord?.id || null, coordinatorName: coord?.name || '', activity, note: str(b.note, 300),
      date: H.localParts(now).date, startedAt: now, status: 'running', pauses: [], lastActionAt: now, createdAt: new Date(now).toISOString(),
    };
    data().timers.push(t);
    await store.save();
    auditTimer('horas-iniciada', t);
    res.json({ timer: timerView(t, now) });
  });

  app.post('/api/hours/timers/:id/pause', async (req, res) => {
    const now = nowMs();
    const t = timerOrThrow(req.params.id);
    if (t.status !== 'running') throw httpError(400, 'Esta atividade já está pausada.');
    pauseNow(t, now);
    await store.save();
    auditTimer('horas-pausada', t);
    res.json({ timer: timerView(t, now) });
  });

  app.post('/api/hours/timers/:id/resume', async (req, res) => {
    const now = nowMs();
    const t = timerOrThrow(req.params.id);
    if (t.status !== 'paused') throw httpError(400, 'Esta atividade não está pausada.');
    makeRoom(now, !!(req.body || {}).replace);
    const open = t.pauses.find((p) => p.to === null);
    if (open) open.to = now;
    t.status = 'running';
    t.lastActionAt = now;
    await store.save();
    auditTimer('horas-retomada', t);
    res.json({ timer: timerView(t, now) });
  });

  // "Continuar" depois de reabrir o app: reconhece o cronômetro (segue contando de verdade desde o início).
  app.post('/api/hours/timers/:id/ack', async (req, res) => {
    const now = nowMs();
    const t = timerOrThrow(req.params.id);
    t.lastActionAt = now;
    await store.save();
    res.json({ timer: timerView(t, now) });
  });

  // Resumo do que seria registrado agora (não altera nada): a tela mostra e a pessoa confirma, edita ou cancela.
  app.post('/api/hours/timers/:id/preview', (req, res) => {
    const now = nowMs();
    const t = timerOrThrow(req.params.id);
    const d = H.draftFromTimer(t, now);
    res.json({ timer: timerView(t, now), draft: d, target: H.daySummary(data().hours, d.date, data().timeEntries) });
  });

  // Transforma o cronômetro em apontamento CONFIRMADO. endMs é o instante mostrado no resumo (não o do clique). edits = correções manuais.
  app.post('/api/hours/timers/:id/confirm', async (req, res) => {
    const now = nowMs();
    const t = timerOrThrow(req.params.id);
    const b = req.body || {};
    const endMs = t.status === 'running' && Number.isFinite(b.endMs) ? Math.min(Math.max(b.endMs, t.startedAt), now + NOW_TOLERANCE_MS) : null;
    const draft = H.draftFromTimer(t, now, endMs);
    const ed = b.edits || {};
    const edited = ['date', 'start', 'end', 'pausedMin'].some((k) => ed[k] !== undefined);
    const fields = H.cleanEntry({
      date: ed.date ?? draft.date, projectId: ed.projectId ?? t.projectId, activity: ed.activity ?? t.activity, note: ed.note ?? t.note,
      startMin: ed.start !== undefined ? H.parseHM(ed.start) : draft.startMin, endMin: ed.end !== undefined ? H.parseHM(ed.end) : draft.endMin,
      pausedMin: ed.pausedMin ?? draft.pausedMin, coordinatorId: ed.coordinatorId !== undefined ? ed.coordinatorId : (t.coordinatorId || null), ...(edited ? {} : { pauses: draft.pauses }),
    }, { data: data(), nowMs: now });
    H.assertNoOverlap(data(), fields, null);
    const iso = new Date(now).toISOString();
    const entry = { id: uid(), ...fields, source: 'timer', createdAt: iso, updatedAt: iso };
    data().timeEntries.push(entry);
    data().timers = data().timers.filter((x) => x.id !== t.id);
    if (!data().hours.trackingFrom || data().hours.trackingFrom > entry.date) data().hours.trackingFrom = entry.date;
    await store.save();
    log('horas-confirmada', { project: entry.projectName, detalhe: entry.activity, etapa: entry.date, resultado: `${H.fmtHM(entry.startMin)}–${H.fmtHM(entry.endMin)} · ${H.fmtHM(H.netMin(entry))}` });
    res.json({ entry: entryView(entry), day: dayView(entry.date) });
  });

  app.post('/api/hours/timers/:id/discard', async (req, res) => {
    const t = timerOrThrow(req.params.id);
    data().timers = data().timers.filter((x) => x.id !== t.id);
    await store.save();
    auditTimer('horas-descartada', t);
    res.json({ ok: true });
  });

  // ---------- Apontamentos (criação manual, correção e dias anteriores) ----------
  const pickBody = (b) => ({ date: b.date, projectId: b.projectId, activity: b.activity, note: b.note, start: b.start, end: b.end, pausedMin: b.pausedMin, coordinatorId: b.coordinatorId }); // nunca "pauses"/ids da tela
  const entryOrThrow = (id) => data().timeEntries.find((e) => e.id === id) || (() => { throw httpError(404, 'Apontamento não encontrado.'); })();
  const trackFrom = (date) => { if (!data().hours.trackingFrom || data().hours.trackingFrom > date) data().hours.trackingFrom = date; };

  app.post('/api/hours/entries', async (req, res) => {
    const now = nowMs();
    const fields = H.cleanEntry(pickBody(req.body || {}), { data: data(), nowMs: now });
    H.assertNoOverlap(data(), fields, null);
    const iso = new Date(now).toISOString();
    const entry = { id: uid(), ...fields, source: 'manual', createdAt: iso, updatedAt: iso };
    data().timeEntries.push(entry);
    trackFrom(entry.date);
    await store.save();
    log('horas-criada', { project: entry.projectName, detalhe: entry.activity, etapa: entry.date, resultado: `${H.fmtHM(entry.startMin)}–${H.fmtHM(entry.endMin)} · ${H.fmtHM(H.netMin(entry))}` });
    res.json({ entry: entryView(entry), day: dayView(entry.date) });
  });

  app.put('/api/hours/entries/:id', async (req, res) => {
    const now = nowMs();
    const e = entryOrThrow(req.params.id);
    const fields = H.cleanEntry(pickBody(req.body || {}), { data: data(), nowMs: now, existing: e });
    H.assertNoOverlap(data(), fields, e.id);
    const oldDate = e.date;
    for (const k of ['pauses']) delete e[k];
    Object.assign(e, fields, { updatedAt: new Date(now).toISOString() });
    trackFrom(e.date);
    await store.save();
    log('horas-editada', { project: e.projectName, detalhe: e.activity, etapa: e.date, resultado: `${H.fmtHM(e.startMin)}–${H.fmtHM(e.endMin)} · ${H.fmtHM(H.netMin(e))}` });
    res.json({ entry: entryView(e), day: dayView(e.date), previousDay: oldDate !== e.date ? dayView(oldDate) : null });
  });

  app.delete('/api/hours/entries/:id', async (req, res) => {
    const e = entryOrThrow(req.params.id);
    data().timeEntries = data().timeEntries.filter((x) => x.id !== e.id);
    await store.save();
    log('horas-excluida', { project: e.projectName, detalhe: e.activity, etapa: e.date, resultado: `${H.fmtHM(e.startMin)}–${H.fmtHM(e.endMin)} · ${H.fmtHM(H.netMin(e))}` });
    res.json({ ok: true, day: dayView(e.date) });
  });

  // ---------- Observações do dia ----------
  const noteOrThrow = (id) => data().timeNotes.find((n) => n.id === id) || (() => { throw httpError(404, 'Observação não encontrada.'); })();
  const noteBody = (b) => ({ date: b.date, dates: b.dates, title: b.title, description: b.description, category: b.category, projectId: b.projectId, severity: b.severity, entryId: b.entryId }); // nunca "evidences"/ids/autoria da tela
  const evOfNote = (n, eid) => n.evidences.find((x) => x.id === eid) || (() => { throw httpError(404, 'Evidência não encontrada.'); })();
  const auditNote = (action, n, extra = {}) => log(action, { project: n.projectName || undefined, etapa: H.datesOfNote(n).join(', ').slice(0, 300), detalhe: n.title, ...extra });

  app.post('/api/hours/notes', async (req, res) => {
    const now = nowMs();
    const iso = new Date(now).toISOString();
    const fields = H.cleanNote(noteBody(req.body || {}), { data: data(), nowMs: now });
    const n = { id: uid(), ...fields, evidences: [], createdAt: iso, updatedAt: iso, createdBy: who(), updatedBy: who() };
    data().timeNotes.push(n);
    await store.save();
    auditNote('observacao-criada', n, { resultado: H.noteCategory(data().hours, n.category).label });
    res.json({ note: noteView(n), day: dayView(n.date) });
  });

  // Editar: título, texto, projeto, categoria (e data). As evidências já anexadas NUNCA são mexidas por aqui.
  app.put('/api/hours/notes/:id', async (req, res) => {
    const now = nowMs();
    const n = noteOrThrow(req.params.id);
    const fields = H.cleanNote({ ...noteBody(req.body || {}), category: req.body.category || n.category }, { data: data(), nowMs: now, existing: n });
    const oldDate = n.date;
    Object.assign(n, fields, { updatedAt: new Date(now).toISOString(), updatedBy: who() });
    await store.save();
    auditNote('observacao-editada', n);
    res.json({ note: noteView(n), day: dayView(n.date), previousDay: oldDate !== n.date ? dayView(oldDate) : null });
  });

  // Excluir: os arquivos das evidências vão para evidencias\.removidas (mesma estratégia do checklist; nada fica órfão nem é apagado).
  app.delete('/api/hours/notes/:id', async (req, res) => {
    const n = noteOrThrow(req.params.id);
    for (const ev of n.evidences) await files().remove(ev.file);
    data().timeNotes = data().timeNotes.filter((x) => x.id !== n.id);
    await store.save();
    auditNote('observacao-excluida', n, { resultado: n.evidences.length ? `${n.evidences.length} evidência(s) movida(s) para .removidas` : undefined });
    res.json({ ok: true, day: dayView(n.date) });
  });

  // Evidências da observação: mesmo upload/validação/entrega de src/evidence-http.js; os tipos e o tamanho vêm da configuração central.
  app.post('/api/hours/notes/:id/evidence', async (req, res) => {
    const n = noteOrThrow(req.params.id);
    if (n.evidences.length >= H.NOTE_MAX_EVIDENCES) throw httpError(400, `Esta observação já tem o máximo de ${H.NOTE_MAX_EVIDENCES} evidências. Remova uma para anexar outra.`);
    const rec = await EH.receiveUpload(req, { files: files(), cfg: E.getConfig(data().settings), type: 'imageOrDocument', folder: files().folderForNote(n.date) });
    n.evidences.push(rec);
    n.updatedAt = rec.at; n.updatedBy = who();
    await store.save();
    auditNote('observacao-evidencia-adicionada', n, { arquivo: rec.name, bytes: rec.size });
    res.json({ note: noteView(n), day: dayView(n.date) });
  });
  app.get('/api/hours/notes/:id/evidences/:eid/file', async (req, res) => {
    const n = noteOrThrow(req.params.id);
    await EH.sendEvidence(res, files(), evOfNote(n, req.params.eid), { inline: req.query.inline === '1' });
  });
  app.delete('/api/hours/notes/:id/evidences/:eid', async (req, res) => {
    const n = noteOrThrow(req.params.id);
    const ev = evOfNote(n, req.params.eid);
    await files().remove(ev.file);
    n.evidences = n.evidences.filter((x) => x.id !== ev.id);
    n.updatedAt = new Date(nowMs()).toISOString(); n.updatedBy = who();
    await store.save();
    auditNote('observacao-evidencia-removida', n, { arquivo: ev.name });
    res.json({ note: noteView(n), day: dayView(n.date) });
  });

  // ---------- Exportação (só leitura: nada é alterado) ----------
  app.get('/api/hours/export', async (req, res) => {
    const y = Number(req.query.year); const m = Number(req.query.month);
    if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) throw httpError(400, 'Informe o mês e o ano.');
    const today = H.localParts(nowMs()).date;
    const out = await buildWorkbook(data(), y, m, today);
    log('horas-exportada', { detalhe: `${out.label}: ${out.count} apontamento(s), ${out.notes} observação(ões)`, arquivo: out.name });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}"; filename*=UTF-8''${encodeURIComponent(out.name)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.buffer);
  });

  // ---------- Levar as horas para outra máquina (.gphours, sempre cifrado com senha) — Fase 5 ----------
  // Exportar só lê. Importar = prévia (nada muda) → aplicar com o token da prévia (válido 10 min, só nesta sessão/usuário).
  const pendingImports = new Map(); // token → { at, backend, payload }
  const IMPORT_TTL_MS = 10 * 60 * 1000;
  const cleanPending = () => { const now = Date.now(); for (const [k, v] of pendingImports) if (now - v.at > IMPORT_TTL_MS || v.backend !== store.backend) pendingImports.delete(k); };
  const summarize = (plan) => ({
    entries: { new: plan.entries.add.length, same: plan.entries.same, conflict: plan.entries.conflict, overlap: plan.entries.overlap, invalid: plan.entries.invalid },
    notes: { new: plan.notes.add.length, same: plan.notes.same, conflict: plan.notes.conflict, invalid: plan.notes.invalid },
    files: { new: plan.files.add.length, present: plan.files.present.length, invalid: plan.files.invalid },
    settingsDiffer: plan.settingsDiffer,
  });

  app.post('/api/hours/backup/export', async (req, res) => {
    const passphrase = HB.checkPassphrase(req.body?.passphrase);
    const included = new Map();
    if (req.body?.includeFiles !== false) {
      for (const n of data().timeNotes) for (const ev of n.evidences || []) {
        if (!included.has(ev.file) && files().has(ev.file)) included.set(ev.file, await files().read(ev.file));
      }
    }
    const out = await HB.buildBackup(data(), included, { passphrase, appVersion: APP_VERSION });
    const name = `Horas_${H.localParts(nowMs()).date}.gphours`;
    log('horas-backup-exportado', { resultado: `${out.counts.entries} apontamento(s), ${out.counts.notes} observação(ões), ${out.counts.files} anexo(s)` });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.buffer);
  });

  // Prévia: o arquivo vem cru no corpo; a senha no cabeçalho X-Passphrase (nunca em URL nem em log).
  app.post('/api/hours/backup/preview', async (req, res) => {
    const passphrase = EH.header(req, 'x-passphrase', 300);
    const buf = await EH.readBody(req, HB.MAX_BYTES, 'O arquivo de horas pode ter no máximo 200 MB.');
    const { header, payload } = await HB.openBackup(buf, passphrase);
    const plan = HB.planImport(data(), payload, { hasFile: (r) => files().has(r) });
    cleanPending();
    if (pendingImports.size >= 3) pendingImports.delete(pendingImports.keys().next().value);
    const token = crypto.randomBytes(16).toString('hex');
    pendingImports.set(token, { at: Date.now(), backend: store.backend, payload });
    res.json({ token, exportedAt: header.exportedAt, app: header.app, summary: summarize(plan) });
  });

  app.post('/api/hours/backup/apply', async (req, res) => {
    cleanPending();
    const token = String(req.body?.token || '');
    const p = pendingImports.get(token);
    if (!p) throw httpError(409, 'A prévia expirou ou é de outra sessão. Selecione o arquivo de novo.', { code: 'BACKUP_EXPIRED' });
    pendingImports.delete(token);
    const plan = HB.planImport(data(), p.payload, { hasFile: (r) => files().has(r) }); // refeito agora: o estado pode ter mudado
    // Anexos ANTES dos registros: uma observação nunca aponta para arquivo que não existe.
    for (const ref of plan.files.add) {
      const base = ref.slice(ref.lastIndexOf('/') + 1);
      const cut = base.indexOf('_');
      await files().put({ folder: ref.slice(0, ref.lastIndexOf('/')), id: base.slice(0, cut), name: base.slice(cut + 1) }, Buffer.from(String(p.payload.files[ref]), 'base64'));
    }
    HB.applyImport(data(), p.payload, plan, { includeSettings: req.body?.includeSettings === true });
    await store.save();
    const summary = summarize(plan);
    log('horas-backup-importado', { resultado: `${summary.entries.new} apontamento(s), ${summary.notes.new} observação(ões), ${summary.files.new} anexo(s) novo(s)${req.body?.includeSettings === true ? '; jornada substituída' : ''}` });
    res.json({ summary, day: dayView(H.localParts(nowMs()).date) });
  });

  return { timerView, dayView };
}

module.exports = { mount, clock };
