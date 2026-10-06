'use strict';
// Observações do dia (dentro do Controle de Horas): ocorrências do dia — problema, atraso, indisponibilidade… — com evidências.
// Uma observação é do DIA (não de um apontamento), pode ter projeto (ou ser "Geral") e várias evidências. As evidências usam a mesma
// interface e a mesma validação do checklist (evidence-ui.js no navegador, evidence-http.js no servidor).

const HN = { open: new Set() }; // observações com os detalhes abertos (sobrevive ao redesenho da página)
const NOTE_MAX_EV = 10;
const noteCats = () => HR.st?.config?.noteCategories || [];
const noteEvBase = (n) => `/api/hours/notes/${n.id}/evidences`;
const plNotes = (n) => `${n} ${n === 1 ? 'observação' : 'observações'}`;

const noteCatPill = (n) => h('span', { class: `pill note-${n.tone || 'none'}` }, n.categoryLabel);
const noteProjectText = (n) => (n.projectId ? n.projectName : 'Geral');
// “05, 12 e 19/03” — todos os dias de uma observação são do mesmo mês.
const daysLabel = (dates) => `${dates.map((d) => d.slice(8)).join(', ')}/${dates[0].slice(5, 7)}`;

// Cartão de uma observação. compact = sem data (dentro do painel do dia); showDate = no histórico.
function noteCard(n, { showDate = false } = {}) {
  const ev = n.evidences;
  const det = h('details', { class: 'note-det', ontoggle: (e) => { if (e.target.open) HN.open.add(n.id); else HN.open.delete(n.id); } },
    h('summary', null,
      showDate ? h('strong', null, dayShort(n.date)) : null, noteCatPill(n), h('strong', { class: 'note-title' }, n.title),
      h('span', { class: 'muted small' }, noteProjectText(n)), n.projectId && !n.projectExists ? h('span', { class: 'pill overdue' }, 'projeto removido') : null,
      n.dates.length > 1 ? h('span', { class: 'pill note-none', title: `Dias: ${daysLabel(n.dates)}` }, n.dates.length <= 5 ? `📅 ${daysLabel(n.dates)}` : `📅 ${n.dates.length} dias`) : null,
      ev.length ? h('span', { class: 'small muted', title: `${ev.length} evidência(s)` }, `📎 ${ev.length}`) : null),
    h('div', { class: 'note-body stack' },
      n.dates.length > 1 ? h('div', { class: 'small' }, h('strong', null, `Vale para ${n.dates.length} dias: `), daysLabel(n.dates)) : null,
      n.description ? h('div', { class: 'note-desc' }, n.description) : h('div', { class: 'small muted' }, 'Sem descrição.'),
      ev.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Evidências'), ev.map((v) => evRow(noteEvBase(n), v, { thumb: true, onRemoved: () => hoursChanged() }))) : h('div', { class: 'small muted' }, 'Nenhuma evidência.'),
      h('div', { class: 'small muted' }, `Registrada em ${fmtDateTime(n.createdAt)}${n.createdBy ? ` por ${n.createdBy}` : ''}${n.updatedAt !== n.createdAt ? ` · atualizada em ${fmtDateTime(n.updatedAt)}${n.updatedBy ? ` por ${n.updatedBy}` : ''}` : ''}`),
      h('div', { class: 'actions inline' },
        h('button', { class: 'btn sm', onclick: () => noteDialog(n) }, 'Editar'),
        h('button', { class: 'btn sm', disabled: ev.length >= NOTE_MAX_EV, title: ev.length >= NOTE_MAX_EV ? `Máximo de ${NOTE_MAX_EV} evidências` : '', onclick: () => noteAddEvidence(n) }, '+ Evidência'),
        h('button', { class: 'btn sm ghost', onclick: () => noteDelete(n) }, 'Excluir'))));
  if (HN.open.has(n.id)) det.setAttribute('open', '');
  return h('div', { class: `note-card note-${n.tone || 'none'}` }, det);
}

// Seção "Observações do dia" (abaixo dos apontamentos do dia).
function notesSection(day) {
  const list = day.notes || [];
  return h('div', { class: 'note-section stack' },
    h('div', { class: 'inline' }, h('strong', null, `Observações do dia${list.length ? ` (${list.length})` : ''}`), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => noteDialog(null, { date: day.date }) }, '+ Adicionar observação')),
    list.length ? list.map((n) => noteCard(n)) : h('div', { class: 'small muted' }, 'Nenhuma observação neste dia. Registre aqui problemas, atrasos ou indisponibilidades que expliquem o dia.'));
}

// Indicador do histórico: "⚠ 2 observações" (só quando existe alguma).
const noteBadgeForDay = (d) => (d.noteCount ? h('span', { class: 'pill note-warn', title: 'Este dia tem observações' }, `⚠ ${plNotes(d.noteCount)}`) : null);

// Resumo curto dentro das listas de dias pendentes: as primeiras observações do dia, para dar contexto ao que faltou.
function noteBriefLine(d) {
  if (!d.noteCount) return null;
  return h('div', { class: 'note-brief small' }, h('span', { class: 'hr-warn' }, `⚠ ${plNotes(d.noteCount)}`),
    (d.notes || []).map((n) => h('span', { class: `pill note-${n.tone || 'none'}`, title: n.categoryLabel }, n.title, n.evidenceCount ? ` 📎${n.evidenceCount}` : '')),
    d.noteCount > (d.notes || []).length ? h('span', { class: 'muted' }, `+${d.noteCount - d.notes.length}`) : null);
}

// Home: quantas observações hoje + as ocorrências mais recentes (compacto; nada de textos longos).
function notesHomeBlock() {
  const st = HR.st;
  const recent = st.recentNotes || [];
  if (!st.notesToday && !recent.length) return null;
  return h('div', { class: 'stack' },
    h('span', { class: 'lbl' }, 'Observações'),
    h('div', { class: 'small' }, st.notesToday ? h('strong', null, `Hoje: ${plNotes(st.notesToday)}`) : h('span', { class: 'muted' }, 'Nenhuma observação hoje.')),
    recent.length ? h('div', { class: 'stack' }, h('span', { class: 'small muted' }, 'Ocorrências recentes'),
      recent.map((n) => h('button', { class: 'note-recent', type: 'button', title: 'Abrir o dia', onclick: () => { HR.viewDate = n.date; HN.open.add(n.id); location.hash = '#/hours'; if (route().name === 'hours') hoursPageLoad(); } },
        h('span', { class: 'muted small' }, dayShort(n.date)), h('span', { class: `pill note-${n.tone || 'none'}` }, n.categoryLabel), h('span', { class: 'grow note-title' }, n.title),
        n.projectName ? h('span', { class: 'muted small' }, n.projectName) : null, n.evidenceCount ? h('span', { class: 'small muted' }, `📎 ${n.evidenceCount}`) : null))) : null);
}

// Criar / editar. Uma observação vale para UM OU MAIS DIAS do mesmo mês: escolhe-se o mês, marcam-se os dias no calendário e explica-se
// o motivo uma vez só (com a evidência, se precisar). “Salvar e adicionar outra” mantém o mês para lançar outro tipo de observação.
// Editar nunca mexe nas evidências já anexadas (elas têm os próprios botões).
const DOW_MIN = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function noteDialog(note, { date, month } = {}) {
  const today = todayStr_();
  const maxMonth = today.slice(0, 7);
  let ym = note ? note.dates[0].slice(0, 7) : (month || (date || today).slice(0, 7));
  if (ym > maxMonth) ym = maxMonth;
  const sel = new Set(note ? note.dates : (date && date.slice(0, 7) === ym ? [date] : []));
  let info = new Map(); // dia → situação (meta/apontado/status), só para marcar no calendário quais dias ficaram sem lançamento
  const monthEl = h('input', { type: 'month', value: ym, max: maxMonth });
  const grid = h('div', { class: 'note-cal', role: 'group', 'aria-label': 'Dias do mês' });
  const count = h('span', { class: 'small muted' });
  const isPend = (d) => { const i = info.get(d); return !!i && i.target > 0 && (i.status === 'pendente' || i.status === 'sem_apontamento') && !!HR.st.trackingFrom && d >= HR.st.trackingFrom; };
  const drawGrid = () => {
    const [y, mo] = ym.split('-').map(Number);
    const last = new Date(y, mo, 0).getDate();
    const first = new Date(y, mo - 1, 1).getDay();
    const cells = DOW_MIN.map((w) => h('span', { class: 'note-cal-h' }, w[0].toUpperCase()));
    for (let i = 0; i < first; i++) cells.push(h('span'));
    for (let dnum = 1; dnum <= last; dnum++) {
      const d = `${ym}-${z2(dnum)}`;
      const i = info.get(d);
      const future = d > today;
      const cls = ['note-day', sel.has(d) ? 'on' : '', isPend(d) ? 'pend' : '', i && i.target === 0 ? 'off' : ''].filter(Boolean).join(' ');
      cells.push(h('button', { type: 'button', class: cls, disabled: future, 'aria-pressed': sel.has(d) ? 'true' : 'false',
        title: `${fmtDate(d)} · ${weekdayOf(d)}${future ? ' · ainda não chegou' : i ? ` · ${i.target === 0 ? 'sem meta' : STATUS_TXT[i.status] || ''}${i.confirmed ? ` · ${hm(i.confirmed)} apontado` : ''}` : ''}`,
        onclick: () => { if (sel.has(d)) sel.delete(d); else sel.add(d); drawGrid(); } },
      h('span', { class: 'n' }, z2(dnum)), h('span', { class: 'w' }, DOW_MIN[(first + dnum - 1) % 7])));
    }
    grid.replaceChildren(...cells);
    count.textContent = sel.size ? `${sel.size} ${sel.size === 1 ? 'dia marcado' : 'dias marcados'}: ${daysLabel([...sel].sort())}` : 'Nenhum dia marcado.';
  };
  const loadMonth = async () => {
    const [y, mo] = ym.split('-').map(Number);
    try { info = new Map((await api('GET', `/api/hours/month?year=${y}&month=${mo}`)).days.map((d) => [d.date, d])); } catch { info = new Map(); }
    drawGrid();
  };
  monthEl.addEventListener('change', () => { if (!monthEl.value) return; ym = monthEl.value > maxMonth ? maxMonth : monthEl.value; sel.clear(); drawGrid(); loadMonth(); });
  const bPend = h('button', { type: 'button', class: 'btn sm', title: 'Marca os dias anteriores a hoje, com meta, que ficaram sem lançamento ou incompletos', onclick: () => { for (const d of info.keys()) if (isPend(d) && d < today) sel.add(d); drawGrid(); } }, 'Marcar dias pendentes');
  const bClear = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { sel.clear(); drawGrid(); } }, 'Limpar');

  const title = h('input', { type: 'text', value: note?.title || '', maxlength: 120, placeholder: 'Ex.: Dias sem lançamento — sistema do cliente fora do ar' });
  const desc = h('textarea', { rows: 4, maxlength: 4000, placeholder: 'Opcional: o motivo, o impacto, quem foi avisado…' });
  desc.value = note?.description || '';
  const cat = h('select', null, noteCats().map((c) => h('option', { value: c.id, selected: c.id === (note?.category || 'info') }, c.label)));
  const proj = h('select');
  const removed = note?.projectId && note.projectId !== INTERNAL_ID && !state.projects.some((p) => p.id === note.projectId);
  proj.replaceChildren(h('option', { value: '' }, 'Nenhum / Geral'),
    ...projectChoices(true).map((c) => h('option', { value: c.id, selected: c.id === note?.projectId }, c.name)),
    removed ? h('option', { value: note.projectId, selected: true }, `${note.projectName || 'Projeto'} (removido)`) : null);
  if (note?.projectId) proj.value = note.projectId;
  const err = h('div', { class: 'box bad', style: 'display:none' });
  const showErr = (t) => { err.style.display = ''; err.textContent = t; };
  const body = () => ({ dates: [...sel].sort(), title: title.value, description: desc.value, category: cat.value, projectId: proj.value || null });
  const save = async (then) => {
    err.style.display = 'none';
    if (!sel.size) return showErr('Marque ao menos um dia no calendário.');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const r = await (note ? api('PUT', `/api/hours/notes/${note.id}`, body()) : api('POST', '/api/hours/notes', body()));
      m.close(); toast(note ? 'Observação atualizada.' : 'Observação registrada.');
      HR.monthSel = r.note.dates[0].slice(0, 7); HN.open.add(r.note.id);
      if (r.note.dates.length === 1) HR.viewDate = r.note.dates[0];
      await hoursChanged();
      if (then === 'evidence') noteAddEvidence(r.note);
      else if (then === 'another') noteDialog(null, { month: HR.monthSel });
    } catch (e) { showErr(e.message); buttons.forEach((b) => { b.disabled = false; }); }
  };
  const bSave = h('button', { class: 'btn primary', onclick: () => save('none') }, 'Salvar');
  const bEv = h('button', { class: 'btn', onclick: () => save('evidence') }, 'Salvar e adicionar evidência');
  const bMore = note ? null : h('button', { class: 'btn', title: 'Salva e abre um formulário novo no mesmo mês (para outro tipo de observação)', onclick: () => save('another') }, 'Salvar e adicionar outra');
  const buttons = [bSave, bEv, bMore].filter(Boolean);
  const m = openModal({ title: note ? 'Editar observação' : 'Nova observação', size: 'lg',
    body: [h('div', { class: 'stack', style: 'gap:12px' },
      field('Mês', monthEl, 'Uma observação vale para dias de um mesmo mês. Para outro mês, crie outra.'),
      h('div', { class: 'field' }, h('label', null, 'Dias *'), grid, h('div', { class: 'inline' }, count, h('span', { class: 'grow' }), bPend, bClear),
        h('div', { class: 'hint' }, 'Toque nos dias a que esta observação se refere. Dias com borda laranja ficaram sem lançamento ou incompletos.')),
      field('Título *', title, 'Curto: aparece nas listas e na planilha.'),
      h('div', { class: 'cols2' }, field('Categoria', cat), field('Projeto', proj, 'Opcional. “Geral” vale para o dia todo.')),
      field('Descrição / motivo', desc)), err],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), bMore, bEv, bSave] });
  drawGrid(); loadMonth();
  title.focus();
}

function noteAddEvidence(n) {
  const maxMB = state.evidence?.maxMB || 10;
  const exts = state.evidence?.types?.imageOrDocument?.extensions || [];
  let count = n.evidences.length;
  evUploadDialog({
    title: `Evidência — ${n.title}`,
    hint: `Aceita imagens e documentos${exts.length ? ` (${exts.join(' ')})` : ''} · até ${maxMB} MB por arquivo · ${count} de no máximo ${NOTE_MAX_EV} anexadas.`,
    footNote: 'O arquivo é guardado na pasta de evidências do app (horas / mês / dia). Nada é executado.',
    accept: exts,
    canAdd: () => (count >= NOTE_MAX_EV ? `Limite de ${NOTE_MAX_EV} evidências atingido` : null),
    upload: async (f, description) => { await evUploadTo(`/api/hours/notes/${n.id}/evidence`, f, description); count++; },
    onDone: () => { HN.open.add(n.id); hoursChanged(); },
  });
}

async function noteDelete(n) {
  const ev = n.evidences.length;
  const msg = `Excluir a observação “${n.title}” (${n.dates.length > 1 ? `${n.dates.length} dias: ${daysLabel(n.dates)}` : fmtDate(n.date)})?${n.dates.length > 1 ? '\nEla some de todos esses dias.' : ''}\n${ev ? `${ev === 1 ? 'A evidência anexada' : `As ${ev} evidências anexadas`} ${ev === 1 ? 'será movida' : 'serão movidas'} para a pasta “.removidas” (${ev === 1 ? 'não é apagada' : 'não são apagadas'}).` : 'Ela não tem evidências.'}`;
  if (!(await confirmDialog({ title: 'Excluir observação', message: msg, okText: 'Excluir', danger: true }))) return;
  try { await api('DELETE', `/api/hours/notes/${n.id}`); HN.open.delete(n.id); toast('Observação excluída.'); await hoursChanged(); } catch (e) { fail(e); }
}

// Card do mês: observações que valem para dias do mês (ex.: “dias 05, 12 e 19 não foram lançados porque…”), várias e de tipos diferentes.
function monthNotesSection(mo) {
  const list = mo.notes || [];
  return h('div', { class: 'note-section stack' },
    h('div', { class: 'inline' }, h('strong', null, `Observações do mês${list.length ? ` (${list.length})` : ''}`), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm primary', onclick: () => noteDialog(null, { month: HR.monthSel }) }, '+ Adicionar observação do mês')),
    list.length ? list.map((n) => noteCard(n)) : h('div', { class: 'small muted' }, 'Nenhuma observação neste mês. Use para explicar dias sem lançamento (ex.: dias 05, 12 e 19) e anexar a evidência uma vez só.'));
}
