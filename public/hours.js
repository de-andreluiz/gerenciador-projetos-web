'use strict';
// Controle de Horas: cronômetro por atividade (com pausas), apontamentos confirmados, meta diária, dias pendentes e exportação.
// O servidor é a fonte do tempo (guarda início/pausas); aqui o cronômetro só é EXIBIDO e recalculado a cada segundo a partir
// dos timestamps + a diferença de relógio com o servidor. Recarregar a página ou trocar de módulo nunca perde a atividade.

const HR = { st: null, offset: 0, viewDate: null, sig: '', pageBusy: false, day: null, hist: null, month: null, monthSel: null, proj: new Map(), recoveryShown: new Set(),
  filters: { from: '', to: '', projectId: '', status: '', notes: '' } };
const INTERNAL_ID = 'internal';
const INTERNAL_NAME = 'Interno / Administrativo';
const WEEKDAY = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTH_NAME = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const STATUS_TXT = { completo: 'Completo', pendente: 'Pendente', excedente: 'Excedente', sem_apontamento: 'Sem apontamento', sem_meta: 'Sem meta' };
const z2 = (n) => String(n).padStart(2, '0');

// ---------- Formatação (horas acima de 24 continuam somando: 168:30) ----------
const hm = (min) => `${min < 0 ? '-' : ''}${z2(Math.floor(Math.abs(min) / 60))}:${z2(Math.abs(min) % 60)}`;
const hms = (sec) => `${z2(Math.floor(sec / 3600))}:${z2(Math.floor((sec % 3600) / 60))}:${z2(sec % 60)}`;
const hmSigned = (min) => (min === 0 ? '00:00' : `${min > 0 ? '+' : '-'}${hm(Math.abs(min))}`);
const parseHMText = (s) => { const m = /^(\d{1,3}):([0-5]\d)$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const dateFromStr = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const weekdayOf = (s) => WEEKDAY[dateFromStr(s).getDay()];
const addDaysStr = (s, n) => { const d = dateFromStr(s); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`; };
const dayShort = (s) => `${z2(dateFromStr(s).getDate())}/${z2(dateFromStr(s).getMonth() + 1)}`;
const serverNow = () => Date.now() + HR.offset;
const todayStr_ = () => HR.st?.today || (() => { const d = new Date(); return `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`; })();

function timerSec(t) {
  const now = serverNow();
  const paused = t.pauses.reduce((n, p) => n + Math.max(0, (p.to ?? now) - Math.max(p.from, t.startedAt)), 0); // pausa aberta conta até agora
  return Math.max(0, Math.floor((now - t.startedAt - paused) / 1000));
}
const timerById = (id) => (HR.st?.timers || []).find((t) => t.id === id) || null;
const runningTimer = () => (HR.st?.timers || []).find((t) => t.status === 'running') || null;
const clockOf = (ms) => { const d = new Date(ms); return `${z2(d.getHours())}:${z2(d.getMinutes())}`; };
// minutos ainda não confirmados de hoje (cronômetros rodando ou pausados)
const inProgressMin = (date) => Math.floor((HR.st?.timers || []).filter((t) => t.date === date).reduce((n, t) => n + timerSec(t), 0) / 60);

// ---------- Projetos ----------
const isClosedProject = (p) => { const s = projectSteps(p); return s.length > 0 && p.stepId === s[s.length - 1].id; }; // no último passo do ciclo = concluído
const projectChoices = (showClosed, keepId) => [
  { id: INTERNAL_ID, name: INTERNAL_NAME },
  ...[...state.projects].filter((p) => showClosed || !isClosedProject(p) || p.id === keepId).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((p) => ({ id: p.id, name: p.name + (isClosedProject(p) ? ' (concluído)' : '') })),
];
const projectCoordinator = (id) => { const p = state.projects.find((x) => x.id === id); return p?.coordinatorId ? coordinatorById(p.coordinatorId) : null; };

// ---------- Carga e atualização ----------
async function hoursRefresh({ skipPage = false } = {}) {
  try {
    const st = await api('GET', '/api/hours/state');
    HR.st = st; HR.offset = st.nowMs - Date.now(); HR.proj.clear();
    if (!HR.viewDate) HR.viewDate = st.today;
    hoursRedraw();
    hoursCheckRecovery();
    hoursCheckAlert();
    const sig = JSON.stringify([st.day, st.timers.map((t) => [t.id, t.status, t.pauses.length]), st.pending, st.month]);
    if (sig !== HR.sig) { HR.sig = sig; if (!skipPage && route().name === 'hours' && !HR.pageBusy) hoursPageLoad(); }
  } catch (e) { /* servidor indisponível: mantém o que está na tela */ }
}
// Redesenha só os pedaços vivos (dock, Home, projeto); a página de horas só recarrega quando algo mudou de verdade.
// Barra recolhida: o ícone de horas do trilho ganha um ponto verde (e a dica) enquanto houver atividade em andamento.
function hoursRailMark() {
  const b = document.querySelector('#railNav [data-rail="hours"]');
  if (!b || !HR.st) return;
  const t = runningTimer();
  b.classList.toggle('live', !!t);
  b.title = t ? `Controle de Horas — em andamento: ${t.projectName}` : `Controle de Horas — hoje ${hm(HR.st.day.confirmed)} / ${hm(HR.st.day.target)}`;
}
function hoursRedraw() {
  const dock = document.getElementById('timerDock');
  if (dock) dock.replaceChildren(hoursDock());
  hoursRailMark();
  const home = document.querySelector('[data-slot="hours-home"]');
  if (home) home.replaceChildren(hoursHomeCard());
  const kpis = document.querySelector('[data-slot="home-kpis"]');
  if (kpis && typeof homeKpis === 'function') kpis.replaceChildren(...homeKpis());
  const proj = document.querySelector('[data-slot="hours-project"]');
  const r = route();
  if (proj && r.name === 'project') { const p = state.projects.find((x) => x.id === r.id); if (p) proj.replaceChildren(hoursProjectCard(p)); }
  const set = document.querySelector('[data-slot="hours-settings"]');
  if (set && !set.dataset.built) { set.dataset.built = '1'; set.replaceChildren(hoursSettingsCard()); }
}
function hoursTick() {
  if (!HR.st) return;
  for (const el of document.querySelectorAll('[data-tick]')) { const t = timerById(el.dataset.tick); if (t) el.textContent = hms(timerSec(t)); }
  const today = HR.st.today; const inprog = inProgressMin(today);
  for (const el of document.querySelectorAll('[data-live="inprog"]')) el.textContent = hm(inprog);
  for (const el of document.querySelectorAll('[data-live="proj"]')) el.textContent = hm(HR.st.day.confirmed + inprog);
}
setInterval(hoursTick, 1000);
setInterval(() => { if (!document.hidden) hoursRefresh(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) hoursRefresh(); });
window.addEventListener('DOMContentLoaded', () => { setTimeout(hoursRefresh, 50); });
const hoursChanged = async () => { HR.proj.clear(); await hoursRefresh({ skipPage: true }); if (route().name === 'hours') await hoursPageLoad(); };

// ---------- Blocos visuais ----------
function progressBar(confirmed, target) {
  const pct = target > 0 ? Math.min(100, Math.round((confirmed / target) * 100)) : 0;
  const cls = target === 0 ? 'none' : confirmed >= target ? 'ok' : confirmed / target >= 0.7 ? 'warn' : 'bad';
  return h('div', { class: `hr-bar ${cls}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('div', { class: 'hr-bar-fill', style: `width:${pct}%` }));
}
// 08:30 / 08:30 ✓   |   07:30 / 08:30 ⚠ Falta 01:00   |   09:15 / 08:30 ↑ +00:45
function statusChip(d) {
  const base = `${hm(d.confirmed)} / ${hm(d.target)}`;
  if (d.target === 0) return h('span', { class: 'hr-chip none' }, d.confirmed ? `${hm(d.confirmed)} (sem meta neste dia)` : 'Sem meta');
  if (d.confirmed > d.target) return h('span', { class: 'hr-chip ok' }, `${base}  ↑ +${hm(d.confirmed - d.target)}`);
  if (d.confirmed === d.target) return h('span', { class: 'hr-chip ok' }, `${base}  ✓`);
  return h('span', { class: 'hr-chip warn' }, `${base}  ⚠ Falta ${hm(d.target - d.confirmed)}`);
}
const stat = (label, value, extra) => h('div', { class: 'hr-stat' }, h('span', { class: 'lbl muted' }, label), h('strong', { class: 'hr-num' }, value), extra || null);

function dayFigures(d, { live = false } = {}) {
  const pctTxt = d.pct === null ? '—' : `${Math.round(d.pct)}%`;
  const inprog = live ? inProgressMin(d.date) : 0;
  return h('div', { class: 'stack' },
    h('div', { class: 'hr-stats' }, stat('Meta', hm(d.target)), stat('Apontado', hm(d.confirmed)), stat(d.over ? 'Excedente' : 'Restante', d.over ? `+${hm(d.over)}` : hm(d.remaining)), stat('Atingimento', pctTxt)),
    progressBar(d.confirmed, d.target),
    d.target > 0 && d.confirmed >= d.target ? h('div', { class: 'hr-ok' }, 'Meta atingida', d.over ? ` · Excedente: ${hm(d.over)}` : '') : null,
    live && (HR.st.timers.some((t) => t.date === d.date)) ? h('div', { class: 'hr-inprog small' }, h('span', null, 'Confirmado: ', h('strong', null, hm(d.confirmed))), h('span', null, 'Em andamento: ', h('strong', { 'data-live': 'inprog' }, hm(inprog))),
      h('span', null, 'Projeção: ', h('strong', { 'data-live': 'proj' }, hm(d.confirmed + inprog))), h('span', { class: 'muted' }, '(o que está em andamento ainda não conta na meta)')) : null);
}

function timerBlock(t, { compact = false } = {}) {
  const running = t.status === 'running';
  return h('div', { class: `hr-timer ${running ? 'running' : 'paused'}` },
    h('div', { class: 'hr-timer-main' },
      h('div', { class: 'grow stack' },
        h('div', { class: 'inline' }, h('span', { class: `hr-dot ${running ? 'on' : ''}` }), h('strong', null, t.projectName), h('span', { class: 'pill', style: 'background:var(--s2)' }, running ? 'Em andamento' : 'Pausada'),
          !t.projectExists && t.projectId !== INTERNAL_ID ? h('span', { class: 'pill overdue' }, 'projeto removido') : null),
        h('span', null, t.activity), t.note && !compact ? h('span', { class: 'small muted' }, t.note) : null,
        h('span', { class: 'small muted' }, `Iniciado: ${clockOf(t.startedAt)}${t.date !== todayStr_() ? ` de ${fmtDate(t.date)}` : ''}${t.pauses.length ? ` · ${plural(t.pauses.length, 'pausa', 'pausas')}` : ''}`)),
      h('div', { class: 'hr-elapsed', 'data-tick': t.id }, hms(timerSec(t)))),
    h('div', { class: 'actions' },
      running ? h('button', { class: 'btn sm', onclick: () => hrPause(t) }, 'Pausar') : h('button', { class: 'btn sm primary', onclick: () => hrResume(t) }, 'Retomar'),
      h('button', { class: 'btn sm primary', onclick: () => hrStop(t) }, 'Encerrar'),
      h('button', { class: 'btn sm ghost', title: 'Descartar sem apontar', onclick: () => hrDiscard(t) }, 'Descartar')));
}

async function hrPause(t) { try { await api('POST', `/api/hours/timers/${t.id}/pause`); await hoursChanged(); } catch (e) { fail(e); } }
async function hrResume(t, replace = false) {
  try { await api('POST', `/api/hours/timers/${t.id}/resume`, { replace }); await hoursChanged(); } catch (e) {
    if (e.code === 'TIMER_ACTIVE') {
      const cur = e.details.timer;
      if (await confirmDialog({ title: 'Já existe uma atividade em andamento', message: `${cur.projectName}\n${cur.activity}\n${hms(timerSec(cur))}\n\nPausar a atividade atual e retomar “${t.activity}”?`, okText: 'Pausar atividade atual e retomar' })) return hrResume(t, true);
    } else fail(e);
  }
}
async function hrDiscard(t) {
  if (!(await confirmDialog({ title: 'Descartar atividade', message: `Descartar “${t.activity}” (${hms(timerSec(t))}) sem apontar as horas? Nada será registrado.`, okText: 'Descartar', danger: true }))) return;
  try { await api('POST', `/api/hours/timers/${t.id}/discard`); await hoursChanged(); } catch (e) { fail(e); }
}

// ---------- Iniciar trabalho ----------
function startWorkDialog({ projectId = null } = {}) {
  let showClosed = false;
  const sel = h('select', { onchange: () => coordHint() });
  const fill = () => { const keep = sel.value || projectId; sel.replaceChildren(...projectChoices(showClosed, keep).map((c) => h('option', { value: c.id, selected: c.id === keep }, c.name))); };
  const closedBox = h('input', { type: 'checkbox', onchange: (e) => { showClosed = e.target.checked; fill(); coordHint(); } });
  const activity = h('input', { type: 'text', maxlength: 300, placeholder: 'Ex.: Validação das informações migradas de PFUNC' });
  const note = h('input', { type: 'text', maxlength: 300, placeholder: 'Opcional' });
  const hint = h('div', { class: 'hint' });
  const coordHint = () => {
    const c = projectCoordinator(sel.value);
    hint.textContent = sel.value === INTERNAL_ID ? 'Atividade interna: sem coordenador.' : c ? `Coordenador do projeto: ${c.name} (será associado ao apontamento).` : 'Este projeto não tem coordenador cadastrado (edite o projeto para definir).';
  };
  fill(); coordHint();
  if (projectId && !sel.value) { showClosed = true; closedBox.checked = true; fill(); sel.value = projectId; coordHint(); }
  const go = (replace) => async (e) => {
    await busy(e.target, async () => {
      try {
        await api('POST', '/api/hours/timers/start', { projectId: sel.value, activity: activity.value, note: note.value, replace });
        m.close(); toast('Cronômetro iniciado.'); await hoursChanged();
      } catch (err) {
        if (err.code === 'TIMER_ACTIVE') {
          const cur = err.details.timer;
          if (await confirmDialog({ title: 'Já existe uma atividade em andamento', message: `${cur.projectName}\n${cur.activity}\n${hms(timerSec(cur))}\n\nDeseja pausar a atividade atual e iniciar a nova?\n(a atual fica pausada e pode ser retomada depois)`, okText: 'Pausar atividade atual e iniciar nova' })) {
            await api('POST', '/api/hours/timers/start', { projectId: sel.value, activity: activity.value, note: note.value, replace: true });
            m.close(); toast('Cronômetro iniciado.'); await hoursChanged();
          }
        } else throw err;
      }
    });
  };
  const m = openModal({ title: 'Iniciar trabalho',
    body: [field('Projeto', sel), h('label', { class: 'ck-check small' }, closedBox, ' Mostrar projetos concluídos'), hint, field('Atividade *', activity, 'Obrigatória: descreva o que será feito.'), field('Observação', note)],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: go(false) }, 'Iniciar')] });
  activity.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(false)({ target: m.el.querySelector('.btn.primary') }); });
  (projectId ? activity : sel).focus();
}

// ---------- Formulário de apontamento (criar manual, editar e corrigir ao encerrar) ----------
function entryForm(init, { showDate = true } = {}) {
  const today = todayStr_();
  const date = h('input', { type: 'date', value: init.date, max: today });
  let showClosed = false;
  const project = h('select');
  const fillProjects = () => { const keep = project.value || init.projectId; project.replaceChildren(...projectChoices(showClosed, keep).map((c) => h('option', { value: c.id, selected: c.id === keep }, c.name))); };
  const removed = init.projectId && init.projectId !== INTERNAL_ID && !state.projects.some((p) => p.id === init.projectId);
  fillProjects();
  if (removed) project.append(h('option', { value: init.projectId, selected: true }, `${init.projectName || 'Projeto'} (removido)`));
  if (init.projectId && !project.value) project.value = init.projectId;
  const activity = h('input', { type: 'text', value: init.activity || '', maxlength: 300, placeholder: 'Ex.: Validação das informações migradas de PFUNC' });
  const note = h('input', { type: 'text', value: init.note || '', maxlength: 300, placeholder: 'Opcional' });
  const start = h('input', { type: 'time', value: init.start || '', step: 60 });
  const end = h('input', { type: 'time', value: init.end || '', step: 60 });
  const paused = h('input', { type: 'number', min: 0, value: init.pausedMin || 0, style: 'width:100px' });
  const coord = h('select');
  let coordTouched = !!init.coordinatorId && !!init.keepCoordinator;
  const fillCoord = (selected) => {
    const opts = [h('option', { value: '' }, '— Nenhum —'), ...state.coordinators.map((c) => h('option', { value: c.id, selected: c.id === selected }, c.name))];
    if (selected && !state.coordinators.some((c) => c.id === selected)) opts.push(h('option', { value: selected, selected: true }, `${init.coordinatorName || 'Coordenador'} (removido do cadastro)`));
    coord.replaceChildren(...opts);
  };
  fillCoord(init.keepCoordinator ? init.coordinatorId : projectCoordinator(project.value)?.id || null);
  coord.addEventListener('change', () => { coordTouched = true; });
  project.addEventListener('change', () => { if (!coordTouched) fillCoord(project.value === INTERNAL_ID ? null : projectCoordinator(project.value)?.id || null); });
  const net = h('strong', { class: 'hr-num' });
  const syncNet = () => {
    const s = parseHMText(start.value); const e = parseHMText(end.value);
    if (s === null || e === null || e <= s) { net.textContent = '—'; return; }
    const v = e - s - (Number(paused.value) || 0);
    net.textContent = v >= 1 ? hm(v) : 'inválido';
  };
  [start, end, paused].forEach((el) => el.addEventListener('input', syncNet));
  syncNet();
  const closedBox = h('input', { type: 'checkbox', onchange: (e) => { showClosed = e.target.checked; fillProjects(); } });
  const el = h('div', { class: 'stack', style: 'gap:12px' },
    showDate ? field('Data', date) : null,
    field('Projeto', project), h('label', { class: 'ck-check small' }, closedBox, ' Mostrar projetos concluídos'),
    field('Atividade realizada *', activity, 'Obrigatória: registre o que foi feito.'),
    h('div', { class: 'cols3' }, field('Início', start), field('Fim', end), field('Pausas (min)', paused, 'Tempo parado dentro do período.')),
    h('div', null, h('span', { class: 'muted' }, 'Tempo líquido: '), net),
    field('Coordenador', coord, 'Fica guardado no apontamento, mesmo que o projeto mude de coordenador depois.'),
    field('Observação', note));
  return { el, focus: () => activity.focus(),
    values: () => ({ date: date.value || init.date, projectId: project.value, activity: activity.value, note: note.value, start: start.value, end: end.value, pausedMin: Number(paused.value) || 0, coordinatorId: coord.value || null }) };
}

const minToTime = (min) => `${z2(Math.floor(min / 60) % 24)}:${z2(min % 60)}`;
function hoursEntryDialog(entry, { date } = {}) {
  const form = entryForm(entry ? { date: entry.date, projectId: entry.projectId, projectName: entry.projectName, activity: entry.activity, note: entry.note, start: minToTime(entry.startMin), end: entry.endMin >= 1440 ? '23:59' : minToTime(entry.endMin),
    pausedMin: entry.pausedMin, coordinatorId: entry.coordinatorId, coordinatorName: entry.coordinatorName, keepCoordinator: true } : { date: date || todayStr_(), projectId: INTERNAL_ID, pausedMin: 0 });
  const err = h('div', { class: 'box bad', style: 'display:none' }); // o motivo (ex.: sobreposição) aparece aqui e a janela continua aberta para corrigir
  const save = h('button', { class: 'btn primary' }, 'Salvar');
  save.addEventListener('click', async () => {
    err.style.display = 'none'; save.disabled = true;
    try {
      const body = form.values();
      await (entry ? api('PUT', `/api/hours/entries/${entry.id}`, body) : api('POST', '/api/hours/entries', body));
      m.close(); toast(entry ? 'Apontamento atualizado.' : 'Apontamento registrado.');
      HR.viewDate = body.date;
      await hoursChanged();
    } catch (e) { err.style.display = ''; err.textContent = e.message; } finally { save.disabled = false; }
  });
  const m = openModal({ title: entry ? 'Editar apontamento' : 'Apontamento manual', body: [form.el, err], footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), save] });
  form.focus();
}

async function hrDeleteEntry(en) {
  if (!(await confirmDialog({ title: 'Excluir apontamento', message: `Excluir o apontamento de ${fmtDate(en.date)}?\n${en.projectName} — ${en.activity}\n${hm(en.startMin)} → ${hm(en.endMin)} (${hm(en.netMin)})`, okText: 'Excluir', danger: true }))) return;
  try { await api('DELETE', `/api/hours/entries/${en.id}`); toast('Apontamento excluído.'); await hoursChanged(); } catch (e) { fail(e); }
}

// ---------- Encerrar: resumo → confirmar / editar / cancelar ----------
async function hrStop(t, { edit = false } = {}) {
  let pv;
  try { pv = await api('POST', `/api/hours/timers/${t.id}/preview`, {}); } catch (e) { return fail(e); }
  const d = pv.draft;
  const row = (k, v) => h('div', { class: 'hr-sum-row' }, h('span', { class: 'muted' }, k), h('strong', null, v));
  const day = pv.target;
  const after = day.confirmed + d.netMin;
  const err = h('div', { class: 'box bad', style: 'display:none' });
  let editing = edit; let form = null;
  const body = h('div', { class: 'stack', style: 'gap:12px' });
  const footer = h('div', { class: 'hr-foot' });
  const confirmBtn = h('button', { class: 'btn primary' }, 'Confirmar apontamento');
  const draw = () => {
    if (editing) {
      form = entryForm({ date: d.date, projectId: t.projectId, projectName: t.projectName, activity: t.activity, note: t.note, start: minToTime(d.startMin), end: d.endMin >= 1440 ? '23:59' : minToTime(d.endMin), pausedMin: d.pausedMin,
        coordinatorId: null, keepCoordinator: false }, { showDate: false });
      body.replaceChildren(form.el, err);
    } else {
      body.replaceChildren(...[
        h('div', { class: 'hr-summary' }, row('Projeto', t.projectName), row('Atividade', t.activity), row('Data', `${fmtDate(d.date)} (${weekdayOf(d.date)})`), row('Início', hm(d.startMin)), row('Fim', hm(d.endMin)),
          row('Pausas', hm(d.pausedMin)), row('Tempo líquido', hm(d.netMin))),
        h('div', { class: 'small muted' }, `Total do dia ficará em ${hm(after)} de ${hm(day.target)}${day.target ? ` (${Math.round((after / day.target) * 100)}%)` : ''}.`),
        d.crossedMidnight ? h('div', { class: 'box warn small' }, 'A atividade passou da meia-noite. O apontamento foi limitado ao fim do dia de início; use “Editar” e crie outro apontamento para o dia seguinte se precisar.') : null,
        d.netMin < 1 ? h('div', { class: 'box bad small' }, 'O tempo líquido é menor que 1 minuto. Use “Editar” ou cancele e descarte a atividade.') : null, err].filter(Boolean));
    }
    footer.replaceChildren(...[h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), editing ? null : h('button', { class: 'btn', onclick: () => { editing = true; draw(); } }, 'Editar'), confirmBtn].filter(Boolean));
  };
  confirmBtn.addEventListener('click', async () => {
    err.style.display = 'none'; confirmBtn.disabled = true;
    try {
      const payload = { endMs: d.endMs };
      if (editing) { const v = form.values(); payload.edits = { projectId: v.projectId, activity: v.activity, note: v.note, start: v.start, end: v.end, pausedMin: v.pausedMin, coordinatorId: v.coordinatorId }; }
      const r = await api('POST', `/api/hours/timers/${t.id}/confirm`, payload);
      m.close(); toast(`Apontamento confirmado: ${hm(r.entry.netMin)}.`); HR.viewDate = r.entry.date; await hoursChanged();
    } catch (e) { err.style.display = ''; err.textContent = `${e.message}${editing ? '' : ' Use “Editar” para ajustar os horários.'}`; } finally { confirmBtn.disabled = false; }
  });
  const m = openModal({ title: editing ? 'Corrigir e confirmar apontamento' : 'Encerrar atividade', body: [body], footer: [footer] });
  draw();
}

// ---------- Reinício do app / atividade esquecida ----------
function hoursCheckRecovery() {
  for (const id of HR.st?.recovery || []) {
    if (HR.recoveryShown.has(id)) continue;
    const t = timerById(id);
    if (!t) continue;
    HR.recoveryShown.add(id);
    const m = openModal({ title: 'Atividade não encerrada',
      body: [h('p', { style: 'margin:0' }, `Existe uma atividade que foi iniciada às ${clockOf(t.startedAt)}${t.date !== todayStr_() ? ` de ${fmtDate(t.date)}` : ''} e não foi encerrada.`),
        h('div', { class: 'box' }, h('strong', null, t.projectName), h('div', null, t.activity), h('div', { class: 'small muted' }, `Tempo contado até agora: `, h('span', { 'data-tick': t.id }, hms(timerSec(t))))),
        h('p', { class: 'muted small', style: 'margin:0' }, '“Continuar” mantém o cronômetro rodando. “Encerrar agora” mostra o resumo para confirmar. “Corrigir” abre o apontamento para você ajustar os horários (por exemplo, o horário em que realmente parou).')],
      footer: [h('button', { class: 'btn', onclick: async () => { m.close(); try { await api('POST', `/api/hours/timers/${t.id}/ack`); await hoursRefresh(); } catch (e) { fail(e); } } }, 'Continuar'),
        h('button', { class: 'btn', onclick: () => { m.close(); hrStop(t, { edit: true }); } }, 'Corrigir'),
        h('button', { class: 'btn primary', onclick: () => { m.close(); hrStop(t); } }, 'Encerrar agora')] });
    break; // uma por vez
  }
}

// ---------- Aviso de horas faltando (só informa; nunca cria horas) ----------
const SNOOZE_KEY = 'gp-hr-alert';
function hoursCheckAlert() {
  const box = document.getElementById('hoursAlert');
  const a = HR.st?.alert;
  if (!a) { box?.remove(); return; }
  let snooze = 0; let notified = 0;
  try { const s = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'); if (s.date === a.date) { snooze = s.until || 0; notified = s.notified || 0; } } catch { /* sem armazenamento */ }
  const remember = (patch) => { try { const cur = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'); localStorage.setItem(SNOOZE_KEY, JSON.stringify({ date: a.date, until: snooze, notified, min: cur.date === a.date ? !!cur.min : false, ...patch })); } catch { /* ignora */ } };
  if (Date.now() < snooze) { box?.remove(); return; }
  const text = a.afterEnd ? 'Seu expediente já passou do horário previsto.' : 'Seu expediente está próximo do fim.';
  // Recolhido (vale para o dia): vira uma pílula no canto, que não cobre o conteúdo; um clique expande de novo.
  let min = false;
  try { min = !!JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}').min && JSON.parse(localStorage.getItem(SNOOZE_KEY)).date === a.date; } catch { /* sem armazenamento */ }
  if (min) {
    const pill_ = h('button', { id: 'hoursAlert', class: 'hr-alert-min', title: `${text} Meta ${hm(a.target)} · apontado ${hm(a.confirmed)} — clique para expandir`, 'aria-label': 'Expandir o aviso do expediente',
      onclick: () => { remember({ min: false }); hoursCheckAlert(); } }, `⚠ Falta ${hm(a.missing)}`, icon('chevronUp', 13));
    if (box) box.replaceWith(pill_); else document.body.append(pill_);
    return;
  }
  const el = h('div', { id: 'hoursAlert', class: 'hr-alert', role: 'alert' },
    h('button', { class: 'side-toggle icon-only hr-alert-close', title: 'Recolher o aviso', 'aria-label': 'Recolher o aviso', onclick: () => { remember({ min: true }); hoursCheckAlert(); } }, icon('chevronDown', 14)),
    h('div', { class: 'grow stack' }, h('strong', null, `⚠ ${text}`),
      h('span', { class: 'small' }, `Meta: ${hm(a.target)} · Apontado: ${hm(a.confirmed)} · Falta: ${hm(a.missing)}`),
      h('span', { class: 'small muted' }, 'Existem horas ainda não registradas no PSA. Nada é lançado automaticamente: informe projeto, atividade e horários.')),
    h('div', { class: 'hr-alert-actions' }, h('button', { class: 'btn sm primary', onclick: () => { HR.viewDate = a.date; location.hash = '#/hours'; } }, 'Apontar horas'),
      h('button', { class: 'btn sm ghost', onclick: () => { snooze = Date.now() + 30 * 60000; remember({ until: snooze }); el.remove(); } }, 'Lembrar em 30 min')));
  if (box) box.replaceWith(el); else document.body.append(el);
  if (HR.st.config.alert.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted' && Date.now() - notified > 30 * 60000) {
    try { new Notification('Controle de Horas', { body: `Falta ${hm(a.missing)} para a meta de hoje (${hm(a.confirmed)} de ${hm(a.target)}).` }); remember({ notified: Date.now() }); } catch { /* sem suporte */ }
  }
}

// ---------- Dock (barra lateral, sempre visível) ----------
// Dock da barra lateral. Recolhível (preferência 'dockMin'): recolhido vira UMA linha — tempo do dia, barrinha de progresso e, se
// houver atividade rodando, o cronômetro com pausar — e a lista de projetos ganha o espaço.
function hoursDock() {
  const st = HR.st;
  if (!st) return h('div');
  const t = runningTimer();
  const paused = st.timers.filter((x) => x.status === 'paused');
  const d = st.day;
  const min = uiPref('dockMin');
  const toggle = h('button', { class: 'side-toggle icon-only', 'aria-expanded': min ? 'false' : 'true', title: min ? 'Expandir o controle de horas' : 'Recolher o controle de horas', 'aria-label': min ? 'Expandir o controle de horas' : 'Recolher o controle de horas',
    onclick: () => { setUiPref('dockMin', !min); hoursRedraw(); } }, icon(min ? 'chevronDown' : 'chevronUp', 14));
  const status = d.target > 0 && d.confirmed < d.target ? h('span', { class: 'small hr-warn' }, `⚠ falta ${hm(d.remaining)}`) : d.target > 0 ? h('span', { class: 'small hr-okc' }, '✓ meta atingida') : null;
  if (min) {
    return h('div', { class: `hr-dock min${t ? ' running' : ''}` },
      h('div', { class: 'hr-dock-head' },
        h('a', { class: 'hr-dock-day', href: '#/hours', title: `Hoje: ${hm(d.confirmed)} de ${hm(d.target)} — abrir o Controle de Horas` }, icon('clock', 14),
          t ? h('span', { class: 'hr-elapsed xs', 'data-tick': t.id }, hms(timerSec(t))) : h('strong', { class: 'small' }, `${hm(d.confirmed)} / ${hm(d.target)}`)),
        t ? h('button', { class: 'btn xs ghost', title: `Pausar: ${t.projectName}`, 'aria-label': 'Pausar a atividade', onclick: () => hrPause(t) }, icon('pause', 13))
          : h('button', { class: 'btn xs ghost', title: 'Iniciar trabalho', 'aria-label': 'Iniciar trabalho', onclick: () => startWorkDialog() }, icon('play', 13)),
        toggle),
      progressBar(d.confirmed, d.target));
  }
  return h('div', { class: `hr-dock${t ? ' running' : ''}` },
    h('div', { class: 'hr-dock-head' },
      h('a', { class: 'hr-dock-day', href: '#/hours', title: 'Abrir o Controle de Horas' }, icon('clock', 14), h('strong', { class: 'small' }, 'Hoje'), h('span', { class: 'small muted' }, `${hm(d.confirmed)} / ${hm(d.target)}`)),
      toggle),
    h('div', { class: 'hr-dock-meta' }, status, progressBar(d.confirmed, d.target)),
    t ? h('div', { class: 'hr-dock-timer' }, h('div', { class: 'small' }, h('strong', null, t.projectName), h('div', { class: 'muted' }, t.activity)),
      h('div', { class: 'hr-dock-row' }, h('span', { class: 'hr-elapsed sm', 'data-tick': t.id }, hms(timerSec(t))),
        h('button', { class: 'btn xs', onclick: () => hrPause(t) }, 'Pausar'), h('button', { class: 'btn xs primary', onclick: () => hrStop(t) }, 'Encerrar')))
      : h('div', { class: 'hr-dock-row' }, h('button', { class: 'btn xs primary', onclick: () => startWorkDialog() }, icon('play', 12), ' Iniciar trabalho')),
    paused.length ? h('a', { class: 'small hr-dock-paused', href: '#/hours' }, `${plural(paused.length, 'atividade pausada', 'atividades pausadas')}`) : null);
}

// ---------- Home ----------
function pendingList(list, { limit = 5, onOpen } = {}) {
  return list.length ? h('div', { class: 'stack' }, list.slice(0, limit).map((d) => h('div', { class: 'hr-pend' }, h('div', { class: 'row', style: 'padding:6px 10px' },
    h('strong', null, dayShort(d.date)), h('span', { class: 'muted small' }, weekdayOf(d.date)),
    h('span', { class: 'grow' }, d.confirmed ? h('span', { class: 'hr-warn' }, `⚠ Falta ${hm(d.remaining)}`) : h('span', { class: 'hr-warn' }, 'Sem apontamento'), h('span', { class: 'muted small' }, `  ${hm(d.confirmed)} / ${hm(d.target)}`)),
    h('button', { class: 'btn sm', onclick: () => (onOpen ? onOpen(d) : (HR.viewDate = d.date, location.hash = '#/hours')) }, 'Abrir')), noteBriefLine(d))),
  list.length > limit ? h('span', { class: 'small muted' }, `… e mais ${list.length - limit}. Veja todos em Controle de Horas.`) : null) : null;
}
function hoursHomeCard() {
  const st = HR.st;
  if (!st) return card('Controle de Horas', null, h('div', { class: 'empty' }, 'Carregando…'));
  const d = st.day; const t = runningTimer();
  const mo = st.month;
  return card(['HOJE — ', fmtDate(st.today), h('span', { class: 'muted small' }, `  ${weekdayOf(st.today)}`)], h('a', { class: 'link-quiet', href: '#/hours' }, 'Abrir Controle de Horas'),
    dayFigures(d, { live: true }), statusChip(d),
    t ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Atividade atual'), timerBlock(t, { compact: true }))
      : h('div', null, h('button', { class: 'btn primary', onclick: () => startWorkDialog() }, 'Iniciar trabalho')),
    st.timers.filter((x) => x.status === 'paused').length ? h('div', { class: 'small muted' }, `${plural(st.timers.filter((x) => x.status === 'paused').length, 'atividade pausada', 'atividades pausadas')} — retome em Controle de Horas.`) : null,
    st.pending.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Dias pendentes'), pendingList(st.pending)) : h('div', { class: 'small muted' }, 'Nenhum dia anterior com horas faltando.'),
    notesHomeBlock(),
    h('div', { class: 'hr-month-line small' }, h('strong', null, `${MONTH_NAME[mo.month - 1].toUpperCase()}/${mo.year}`), h('span', null, `Meta acumulada: ${hm(mo.targetAccum)}`), h('span', null, `Apontado: ${hm(mo.confirmed)}`),
      h('span', { class: mo.diff < 0 ? 'hr-warn' : 'hr-okc' }, `Diferença: ${hmSigned(mo.diff)}`), h('span', { class: 'muted' }, `Completos ${mo.counts.completo} · Pendentes ${mo.counts.pendente} · Excedentes ${mo.counts.excedente}`)));
}

// ---------- Card do projeto ----------
async function hoursProjectLoad(p) {
  if (HR.proj.has(p.id)) return;
  HR.proj.set(p.id, null);
  try { HR.proj.set(p.id, await api('GET', `/api/hours/project/${p.id}`)); } catch { HR.proj.delete(p.id); return; }
  const slot = document.querySelector('[data-slot="hours-project"]');
  if (slot && route().id === p.id) slot.replaceChildren(hoursProjectCard(p));
}
function hoursProjectCard(p) {
  const info = HR.proj.get(p.id);
  if (info === undefined) hoursProjectLoad(p);
  const t = (HR.st?.timers || []).find((x) => x.projectId === p.id && x.status === 'running');
  const c = coordinatorById(p.coordinatorId);
  return card('Horas do projeto', h('button', { class: 'btn sm primary', disabled: !!t, title: t ? 'Já existe uma atividade em andamento neste projeto' : '', onclick: () => startWorkDialog({ projectId: p.id }) }, t ? 'Em andamento' : 'Iniciar trabalho'),
    t ? timerBlock(t, { compact: true }) : null,
    h('div', { class: 'hr-stats' }, stat('Horas hoje', info ? hm(info.todayMin) : '…'), stat('Horas no mês', info ? hm(info.monthMin) : '…'), stat('Coordenador', c ? c.name : '—')),
    info && info.last.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Últimos apontamentos'),
      info.last.map((e) => h('div', { class: 'small' }, `${dayShort(e.date)} - ${e.activity} - `, h('strong', null, hm(e.netMin))))) : h('div', { class: 'small muted' }, info ? 'Nenhuma hora apontada neste projeto ainda.' : ''),
    !c ? h('div', { class: 'small muted' }, 'Sem coordenador cadastrado: as horas serão apontadas sem coordenador. Defina em “Editar”.') : null);
}

// ---------- Página Controle de Horas ----------
function renderHours(main) {
  const page = h('div', { class: 'page' }, h('div', { 'data-slot': 'hours-page' }, h('div', { class: 'empty' }, 'Carregando…')));
  main.append(page);
  hoursPageLoad();
}

async function hoursPageLoad() {
  const slot = document.querySelector('[data-slot="hours-page"]');
  if (!slot) return;
  HR.pageBusy = true;
  try {
    if (!HR.st) await hoursRefresh();
    const today = HR.st.today;
    if (!HR.viewDate || HR.viewDate > today) HR.viewDate = today;
    if (!HR.monthSel) HR.monthSel = today.slice(0, 7);
    if (!HR.filters.to) HR.filters.to = today;
    if (!HR.filters.from) HR.filters.from = addDaysStr(today, -30);
    const [y, m] = HR.monthSel.split('-').map(Number);
    const q = new URLSearchParams({ from: HR.filters.from, to: HR.filters.to, projectId: HR.filters.projectId, status: HR.filters.status, notes: HR.filters.notes });
    const [day, hist, month] = await Promise.all([api('GET', `/api/hours/day?date=${HR.viewDate}`), api('GET', `/api/hours/entries?${q}`), api('GET', `/api/hours/month?year=${y}&month=${m}`)]);
    HR.day = day; HR.hist = hist; HR.month = month;
    if (document.querySelector('[data-slot="hours-page"]') === slot) slot.replaceChildren(hoursPageBody());
  } catch (e) { fail(e); } finally { HR.pageBusy = false; }
}

function entryRow(en, { showDate = false } = {}) {
  return h('div', { class: 'hr-entry' },
    h('div', { class: 'grow stack' }, h('div', { class: 'inline' }, showDate ? h('strong', null, dayShort(en.date)) : null, h('strong', null, en.projectName), en.projectExists ? null : h('span', { class: 'pill overdue' }, 'projeto removido')),
      h('span', null, en.activity), en.note ? h('span', { class: 'small muted' }, en.note) : null,
      h('span', { class: 'small muted' }, `${en.coordinatorName ? `Coordenador: ${en.coordinatorName}` : 'Sem coordenador'}${en.analystName ? ` · Analista: ${en.analystName}` : ''}${en.source === 'timer' ? ' · cronômetro' : ' · manual'}`)),
    h('div', { class: 'hr-entry-time' }, h('span', { class: 'small muted' }, `${hm(en.startMin)} → ${hm(en.endMin)}${en.pausedMin ? ` · pausas ${hm(en.pausedMin)}` : ''}`), h('strong', { class: 'hr-num' }, hm(en.netMin))),
    h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => hoursEntryDialog(en) }, 'Editar'), h('button', { class: 'btn sm ghost', onclick: () => hrDeleteEntry(en) }, 'Excluir')));
}

function dayPanel(day) {
  const today = HR.st.today; const isToday = day.date === today;
  const go = (date) => { HR.viewDate = date; hoursPageLoad(); };
  const dateInput = h('input', { type: 'date', value: day.date, max: today, onchange: (e) => { if (e.target.value) go(e.target.value); } });
  return card([isToday ? 'HOJE — ' : '', fmtDate(day.date), h('span', { class: 'muted small' }, `  ${weekdayOf(day.date)}`, day.override || day.reason ? ` · ${day.reason || 'meta excepcional'}` : '')],
    h('div', { class: 'inline' }, h('button', { class: 'btn sm', title: 'Dia anterior', onclick: () => go(addDaysStr(day.date, -1)) }, '◀'), dateInput,
      h('button', { class: 'btn sm', disabled: isToday, title: 'Dia seguinte', onclick: () => go(addDaysStr(day.date, 1)) }, '▶'), h('button', { class: 'btn sm', disabled: isToday, onclick: () => go(today) }, 'Hoje'),
      h('button', { class: 'btn sm primary', onclick: () => hoursEntryDialog(null, { date: day.date }) }, '+ Apontamento manual')),
    dayFigures(day, { live: isToday }), statusChip(day),
    day.entries.length ? h('div', { class: 'hr-list' }, day.entries.map((en) => entryRow(en)))
      : h('div', { class: 'empty' }, day.target > 0 ? 'Nenhum apontamento neste dia.' : 'Sem meta e sem apontamentos neste dia.'),
    day.entries.length ? h('div', { class: 'hr-total' }, h('span', null, 'Total: ', h('strong', null, hm(day.confirmed))), day.target > 0 ? h('span', null, day.confirmed >= day.target ? (day.over ? `Meta atingida · Excedente: ${hm(day.over)}` : 'Meta atingida') : h('span', { class: 'hr-warn' }, `Faltam: ${hm(day.remaining)}`)) : null) : null,
    notesSection(day));
}

function monthCard(mo) {
  const [y, m] = HR.monthSel.split('-').map(Number);
  const input = h('input', { type: 'month', value: HR.monthSel, onchange: (e) => { if (e.target.value) { HR.monthSel = e.target.value; hoursPageLoad(); } } });
  return card(`${MONTH_NAME[m - 1].toUpperCase()}/${y}`, input,
    h('div', { class: 'hr-stats' }, stat('Meta acumulada', hm(mo.targetAccum)), stat('Apontado', hm(mo.confirmed)), stat('Diferença', hmSigned(mo.diff)), stat('Meta do mês', hm(mo.targetMonth))),
    h('div', { class: 'hr-stats' }, stat('Dias completos', mo.counts.completo), stat('Dias pendentes', mo.counts.pendente), stat('Dias excedentes', mo.counts.excedente), h('div')),
    h('div', { class: 'hint' }, 'A meta acumulada conta os dias úteis até hoje (ou o mês inteiro, se já passou), a partir da data configurada em “Considerar pendências a partir de”.'),
    monthNotesSection(mo));
}

function historyCard() {
  const f = HR.filters;
  const projSel = h('select', { onchange: (e) => { f.projectId = e.target.value; hoursPageLoad(); } }, h('option', { value: '' }, 'Todos'),
    projectChoices(true).map((c) => h('option', { value: c.id, selected: f.projectId === c.id }, c.name)));
  const statusSel = h('select', { onchange: (e) => { f.status = e.target.value; hoursPageLoad(); } }, h('option', { value: '' }, 'Todos'),
    Object.entries(STATUS_TXT).map(([k, v]) => h('option', { value: k, selected: f.status === k }, v)));
  const notesSel = h('select', { onchange: (e) => { f.notes = e.target.value; hoursPageLoad(); } },
    [['', 'Todos'], ['with', 'Com observações'], ['without', 'Sem observações']].map(([k, v]) => h('option', { value: k, selected: f.notes === k }, v)));
  const from = h('input', { type: 'date', value: f.from, onchange: (e) => { f.from = e.target.value; hoursPageLoad(); } });
  const to = h('input', { type: 'date', value: f.to, max: HR.st.today, onchange: (e) => { f.to = e.target.value; hoursPageLoad(); } });
  const days = HR.hist.days;
  return card('Histórico de apontamentos', null,
    h('div', { class: 'filters' }, field('De', from), field('Até', to), field('Projeto', projSel), field('Status do dia', statusSel), field('Observações', notesSel)),
    days.length ? days.map((d) => h('div', { class: 'hr-day' },
      h('div', { class: 'hr-day-head' }, h('strong', null, fmtDate(d.date)), h('span', { class: 'muted small' }, weekdayOf(d.date)), h('span', { class: `pill hr-st-${d.status}` }, STATUS_TXT[d.status]),
        statusChip(d), noteBadgeForDay(d), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => { HR.viewDate = d.date; hoursPageLoad().then(() => document.querySelector('[data-slot="hours-page"]')?.scrollIntoView({ behavior: 'smooth' })); } }, 'Abrir dia'),
        h('button', { class: 'btn sm', onclick: () => hoursEntryDialog(null, { date: d.date }) }, '+ Adicionar')),
      d.entries.length ? h('div', { class: 'hr-list' }, d.entries.map((en) => entryRow(en))) : h('div', { class: 'small muted', style: 'padding:4px 12px 8px' }, 'Nenhum apontamento.'),
      d.notes && d.notes.length ? h('div', { class: 'note-list stack' }, d.notes.map((n) => noteCard(n))) : null))
      : h('div', { class: 'empty' }, 'Nenhum dia encontrado com esses filtros.'),
    f.projectId ? h('div', { class: 'hint' }, 'Com um projeto escolhido, o total e o status de cada dia continuam sendo os do dia inteiro (todos os projetos).') : null);
}

function exportCard() {
  const today = HR.st.today;
  const [cy, cm] = (HR.monthSel || today.slice(0, 7)).split('-').map(Number);
  const year = h('input', { type: 'number', min: 2000, max: 2100, value: cy, style: 'width:100px' });
  const month = h('select', null, MONTH_NAME.map((n, i) => h('option', { value: i + 1, selected: i + 1 === cm }, n)));
  return card('Exportar apontamentos', null,
    h('div', { class: 'inline' }, field('Mês', month), field('Ano', year),
      h('div', { class: 'field' }, h('label', null, '\u00a0'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        // Baixa pelo fetch para mostrar "Gerando planilha…" enquanto o servidor monta o arquivo.
        const name = `Apontamentos_${Number(year.value)}_${z2(month.value)}.xlsx`;
        const r = await fetch(`/api/hours/export?year=${Number(year.value)}&month=${month.value}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erro ${r.status}`);
        const url = URL.createObjectURL(await r.blob());
        const a = h('a', { href: url, download: name });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast(`Planilha gerada: ${name}`);
      }, 'Gerando planilha…') }, 'Exportar Excel'))),
    h('div', { class: 'hint' }, 'Gera Apontamentos_AAAA_MM.xlsx com as abas Apontamentos, Resumo Mensal, Resumo por Projeto e Observações (sem imagens: só a contagem e os nomes dos arquivos). A exportação só lê os dados (você pode repetir quantas vezes quiser) e a planilha nunca é a fonte dos apontamentos.'));
}

// Levar as horas para outra máquina (.gphours): sempre cifrado com uma senha escolhida aqui (pedida de novo para importar).
// As horas nunca vão para a nuvem — este arquivo é o único caminho entre máquinas, e só quando você quiser.
function backupCard() {
  const pass1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'mínimo 12 caracteres' });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const withFiles = h('input', { type: 'checkbox', checked: true });
  const file = h('input', { type: 'file', accept: '.gphours' });
  const ipass = h('input', { type: 'password', autocomplete: 'off' });
  const doExport = (e) => busy(e.target, async () => {
    if (pass1.value !== pass2.value) throw new Error('As duas senhas não conferem.');
    const r = await fetch('/api/hours/backup/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pass1.value, includeFiles: withFiles.checked }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erro ${r.status}`);
    const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || 'Horas.gphours';
    const url = URL.createObjectURL(await r.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    pass1.value = ''; pass2.value = '';
    toast(`Arquivo gerado: ${name}. Guarde a senha: sem ela o arquivo não abre.`);
  }, 'Gerando…');
  const doPreview = (e) => busy(e.target, async () => {
    const f = file.files[0];
    if (!f) throw new Error('Escolha o arquivo .gphours.');
    const r = await fetch('/api/hours/backup/preview', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Passphrase': encodeURIComponent(ipass.value) }, body: f });
    const pv = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(pv.error || `Erro ${r.status}`);
    ipass.value = '';
    importPreviewDialog(pv);
  }, 'Lendo…');
  return card('Levar as horas para outra máquina', null,
    h('div', { class: 'grid2' },
      h('div', { class: 'stack' }, h('b', null, 'Exportar'), field('Senha do arquivo', pass1, 'Será pedida para importar. Não fica guardada em lugar nenhum.'), field('Confirmar a senha', pass2),
        h('label', { class: 'inline small' }, withFiles, h('span', null, 'Incluir os anexos das observações')), h('div', null, h('button', { class: 'btn primary', onclick: doExport }, 'Exportar horas'))),
      h('div', { class: 'stack' }, h('b', null, 'Importar'), field('Arquivo .gphours', file), field('Senha do arquivo', ipass), h('div', null, h('button', { class: 'btn', onclick: doPreview }, 'Ver o que será importado')))),
    h('div', { class: 'hint' }, 'Nada é sobrescrito: apontamentos e observações já existentes ficam como estão; apontamento que se sobreporia a outro não entra. Importar de novo o mesmo arquivo não duplica.'));
}

function importPreviewDialog(pv) {
  const s = pv.summary;
  const settings = h('input', { type: 'checkbox' });
  const line = (label, n, tone) => (n ? h('li', { class: tone || '' }, `${label}: ${n}`) : null);
  const m = openModal({
    title: 'Importar horas',
    body: h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, `Arquivo exportado em ${fmtDateTime(pv.exportedAt)}${pv.app ? ` (versão ${pv.app})` : ''}.`),
      h('ul', null, line('Apontamentos novos', s.entries.new), line('Apontamentos já existentes (iguais)', s.entries.same), line('Apontamentos com o mesmo id e conteúdo diferente (mantém o atual)', s.entries.conflict, 'soon'),
        line('Apontamentos que se sobreporiam a outros (não entram)', s.entries.overlap, 'soon'), line('Registros inválidos (ignorados)', s.entries.invalid + s.notes.invalid + s.files.invalid, 'soon'),
        line('Observações novas', s.notes.new), line('Observações já existentes', s.notes.same + s.notes.conflict), line('Anexos novos', s.files.new)),
      !s.entries.new && !s.notes.new ? h('p', null, 'Nada novo para importar.') : null,
      s.settingsDiffer ? h('label', { class: 'inline small' }, settings, h('span', null, 'Substituir a jornada e as metas atuais pelas do arquivo')) : null),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const r = await api('POST', '/api/hours/backup/apply', { token: pv.token, includeSettings: settings.checked });
        m.close();
        toast(`Importado: ${r.summary.entries.new} apontamento(s), ${r.summary.notes.new} observação(ões).`);
        await hoursChanged();
      }, 'Importando…') }, 'Importar')],
  });
}

function hoursPageBody() {
  const st = HR.st;
  return h('div', { class: 'page', style: 'max-width:none;padding:0' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Controle de Horas'),
      h('div', { class: 'muted' }, 'Apontamentos por projeto, meta diária e exportação mensal. Só os apontamentos confirmados contam para a meta.')),
      h('div', { class: 'actions inline' }, h('button', { class: 'btn primary', onclick: () => startWorkDialog() }, 'Iniciar trabalho'), h('a', { class: 'btn', href: '#/settings/horas' }, 'Jornada e metas'))),
    st.timers.length ? card(`Atividades (${st.timers.length})`, null, st.timers.map((t) => timerBlock(t))) : null,
    dayPanel(HR.day),
    st.pending.length ? card('Dias pendentes', null, pendingList(st.pending, { limit: 10, onOpen: (d) => { HR.viewDate = d.date; hoursPageLoad().then(() => document.querySelector('[data-slot="hours-page"]')?.scrollIntoView({ behavior: 'smooth' })); } })) : null,
    monthCard(HR.month), historyCard(), exportCard(), backupCard());
}

// ---------- Configurações: jornada, metas por dia da semana, exceções e aviso ----------
function hoursSettingsCard() {
  const cfg = HR.st?.config;
  if (!cfg) { hoursRefresh().then(() => { const s = document.querySelector('[data-slot="hours-settings"]'); if (s) { s.dataset.built = ''; hoursRedraw(); } }); return card('Jornada e controle de horas', null, h('div', { class: 'empty' }, 'Carregando…')); }
  const sc = cfg.schedule;
  const start = h('input', { type: 'time', value: sc.start });
  const end = h('input', { type: 'time', value: sc.end });
  const brk = h('input', { type: 'text', value: hm(sc.breakMin), placeholder: '01:30', style: 'width:90px' });
  const calc = h('strong', { class: 'hr-num' });
  const autoTarget = () => Math.max(0, (parseHMText(end.value) ?? 0) - (parseHMText(start.value) ?? 0) - (parseHMText(brk.value) ?? 0));
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, target: h('input', { type: 'text', value: hm(sc.week[d].targetMin), style: 'width:90px', 'aria-label': `Meta de ${WEEKDAY[d]}` }), dayEnd: h('input', { type: 'time', value: sc.week[d].end || '' }) }));
  const sync = () => { calc.textContent = hm(autoTarget()); };
  [start, end, brk].forEach((el) => el.addEventListener('input', sync)); sync();
  const alertOn = h('input', { type: 'checkbox', checked: cfg.alert.enabled });
  const before = h('input', { type: 'number', min: 0, max: 480, value: cfg.alert.minutesBefore, style: 'width:90px' });
  const desktop = h('input', { type: 'checkbox', checked: cfg.alert.desktop, onchange: async (e) => {
    if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') { const r = await Notification.requestPermission(); if (r !== 'granted') { e.target.checked = false; toast('O Windows/navegador não liberou notificações; o aviso continua aparecendo dentro do app.'); } }
  } });
  const from = h('input', { type: 'date', value: cfg.trackingFrom || '' });
  const ovDate = h('input', { type: 'date' }); const ovTarget = h('input', { type: 'text', placeholder: '00:00', value: '00:00', style: 'width:90px' }); const ovReason = h('input', { type: 'text', placeholder: 'Ex.: Feriado', maxlength: 120 });
  const parseOrFail = (txt, what) => { const v = parseHMText(txt); if (v === null) throw new Error(`${what}: use o formato HH:MM (ex.: 08:30).`); return v; };
  const save = (e) => busy(e.target, async () => {
    const week = {};
    for (const r of rows) week[r.d] = { targetMin: parseOrFail(r.target.value, `Meta de ${WEEKDAY[r.d]}`), end: r.dayEnd.value };
    await api('PUT', '/api/hours/config', { schedule: { start: start.value, end: end.value, breakMin: parseOrFail(brk.value, 'Intervalo'), week }, alert: { enabled: alertOn.checked, minutesBefore: Number(before.value), desktop: desktop.checked }, trackingFrom: from.value || null });
    toast('Jornada salva.'); await hoursRefresh(); const s = document.querySelector('[data-slot="hours-settings"]'); if (s) { s.dataset.built = ''; hoursRedraw(); }
  });
  const rebuild = async () => { await hoursRefresh(); const s = document.querySelector('[data-slot="hours-settings"]'); if (s) { s.dataset.built = ''; hoursRedraw(); } };
  return card('Jornada e controle de horas', null,
    h('div', { class: 'small muted' }, 'A jornada define a carga esperada de cada dia. O intervalo da jornada só entra no cálculo da meta — as pausas do cronômetro são outra coisa e ficam em cada apontamento.'),
    h('div', { class: 'filters' }, field('Início padrão', start), field('Término padrão', end), field('Intervalo padrão (HH:MM)', brk), h('div', { class: 'field' }, h('label', null, 'Meta calculada'), calc)),
    h('div', null, h('button', { class: 'btn sm', onclick: () => { const v = hm(autoTarget()); rows.filter((r) => r.d >= 1 && r.d <= 5).forEach((r) => { r.target.value = v; }); toast(`Meta ${v} aplicada de segunda a sexta (ainda não salva).`); } }, 'Aplicar meta calculada de segunda a sexta')),
    h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Meta por dia da semana'), h('div', { class: 'hint' }, 'Meta 00:00 = dia sem meta (não aparece como pendente). “Fim previsto” em branco usa o término padrão; serve ao aviso de fim de expediente.'),
      rows.map((r) => h('div', { class: 'row', style: 'padding:6px 10px' }, h('span', { style: 'width:120px;text-transform:capitalize' }, WEEKDAY[r.d]), h('span', { class: 'muted small' }, 'Meta'), r.target, h('span', { class: 'muted small' }, 'Fim previsto'), r.dayEnd))),
    h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Aviso de horas faltando'),
      h('label', { class: 'ck-check' }, alertOn, ' Avisar quando restarem horas não apontadas perto do fim do expediente'),
      h('div', { class: 'inline' }, h('span', null, 'Avisar'), before, h('span', null, 'minutos antes do fim previsto')),
      h('label', { class: 'ck-check' }, desktop, ' Também mostrar como notificação do Windows (com o app aberto)'),
      h('div', { class: 'hint' }, 'O aviso só aparece se houver pendência: meta atingida ou excedida não avisa. Ele apenas informa — nunca cria horas.')),
    field('Considerar pendências a partir de', from, 'Dias anteriores a esta data nunca aparecem como pendentes. Vazio = a data do primeiro apontamento.'),
    h('div', null, h('button', { class: 'btn primary', onclick: save }, 'Salvar jornada')),
    h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Exceções por data (feriado, expediente reduzido)'),
      cfg.overrides.length ? cfg.overrides.map((o) => h('div', { class: 'row', style: 'padding:6px 10px' }, h('strong', null, fmtDate(o.date)), h('span', { class: 'muted small' }, weekdayOf(o.date)), h('span', null, `meta ${hm(o.targetMin)}`),
        h('span', { class: 'grow muted small' }, o.reason || ''), h('button', { class: 'btn sm ghost', onclick: async () => { try { await api('DELETE', `/api/hours/overrides/${o.date}`); await rebuild(); } catch (e2) { fail(e2); } } }, 'Remover'))) : h('div', { class: 'small muted' }, 'Nenhuma exceção.'),
      h('div', { class: 'inline' }, ovDate, h('span', { class: 'small muted' }, 'meta'), ovTarget, ovReason,
        h('button', { class: 'btn sm', onclick: (e) => busy(e.target, async () => { await api('POST', '/api/hours/overrides', { date: ovDate.value, targetMin: parseOrFail(ovTarget.value, 'Meta da exceção'), reason: ovReason.value }); await rebuild(); }) }, '+ Exceção'))));
}
