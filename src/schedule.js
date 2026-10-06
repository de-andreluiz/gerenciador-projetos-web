// Cronograma simples: marcos (prazo/entrega) opcionais por projeto.
// Projeto sem marcos = "sem cronograma" (nunca é tratado como problema).
const DEFAULT_WARN_DAYS = 7;

const pad = (n) => String(n).padStart(2, '0');

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function milestoneState(m, today, warnDays = DEFAULT_WARN_DAYS) {
  if (m.done) return { state: 'done', days: null };
  const days = daysBetween(today, m.dueDate);
  const limit = Number.isInteger(m.alertDays) && m.alertDays >= 0 ? m.alertDays : warnDays;
  if (days < 0) return { state: 'overdue', days };
  if (days <= limit) return { state: 'soon', days };
  return { state: 'ok', days };
}

const RANK = { overdue: 0, soon: 1, ok: 2 };

function projectSchedule(project, today = todayStr(), warnDays = DEFAULT_WARN_DAYS) {
  const ms = project.milestones || [];
  if (!ms.length) return { state: 'none', next: null, counts: { overdue: 0, soon: 0, pending: 0, done: 0 } };
  const counts = { overdue: 0, soon: 0, pending: 0, done: 0 };
  let next = null;
  let worst = null;
  for (const m of ms) {
    const s = milestoneState(m, today, warnDays);
    if (s.state === 'done') { counts.done++; continue; }
    counts.pending++;
    if (s.state === 'overdue') counts.overdue++;
    if (s.state === 'soon') counts.soon++;
    if (!next || m.dueDate < next.dueDate) next = { id: m.id, title: m.title, dueDate: m.dueDate, ...s };
    if (worst === null || RANK[s.state] < RANK[worst]) worst = s.state;
  }
  if (!counts.pending) return { state: 'done', next: null, counts };
  return { state: worst, next, counts };
}

module.exports = { todayStr, daysBetween, milestoneState, projectSchedule, DEFAULT_WARN_DAYS };
