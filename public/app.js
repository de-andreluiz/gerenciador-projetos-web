'use strict';
// ---------- Utilidades ----------
const state = { projects: [], settings: { warnDays: 7 }, today: '', coordinators: [], stages: [], cycles: [], defaultCycleId: null, checklists: [], connections: [], documents: [], projectTypes: [], originSystems: [], checklistItems: [], evidence: null };

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

// Ícones de linha (SVG, cor = currentColor), desenhados aqui para não depender de biblioteca externa. Cada um: lista de traços
// (`d` de <path>) e círculos [cx, cy, r]. Uso: icon('clock'), icon('play', 14).
const ICONS = {
  home: ['M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
  clock: ['M12 7v5l3 2', [12, 12, 9]],
  workspace: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M8 13h8'],
  docs: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  scripts: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  settings: ['M4 6h9', 'M17 6h3', 'M4 12h3', 'M11 12h9', 'M4 18h11', 'M19 18h1', [15, 6, 2], [9, 12, 2], [17, 18, 2]],
  audit: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'm3.5 6 1.5 1.5L7.5 5', 'm3.5 12 1.5 1.5 2.5-2.5', 'm3.5 18 1.5 1.5 2.5-2.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  chevronDown: ['m6 9 6 6 6-6'], chevronUp: ['m6 15 6-6 6 6'], chevronLeft: ['m15 18-6-6 6-6'], chevronRight: ['m9 18 6-6-6-6'],
  sun: ['M12 2v2', 'M12 20v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm4.9 19.1 1.4-1.4', 'm17.7 6.3 1.4-1.4', [12, 12, 4]],
  moon: ['M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z'],
  monitor: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'],
  play: ['M7 4.5v15l12.5-7.5z'], pause: ['M8 5v14', 'M16 5v14'],
  panelClose: ['M4 4h16v16H4z', 'M9 4v16', 'm16 9-3 3 3 3'], panelOpen: ['M4 4h16v16H4z', 'M9 4v16', 'm13 9 3 3-3 3'],
  // Workspace (arquivos e Git)
  sidebar: ['M4 4h16v16H4z', 'M9 4v16'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  folderPlus: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 10v6', 'M9 13h6'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  filePlus: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M12 11v6', 'M9 14h6'],
  search: ['m20 20-4.2-4.2', [11, 11, 7]],
  refresh: ['M20 11a8 8 0 0 0-14.9-3.5', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.9 3.5', 'M20 20v-4h-4'],
  branch: ['M6 3v12', 'M18 9a9 9 0 0 1-9 9', [18, 6, 3], [6, 18, 3]],
  pane: ['M4 4h16v16H4z'], columns: ['M4 4h16v16H4z', 'M12 4v16'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  arrowRight: ['M5 12h14', 'm13 6 6 6-6 6'], arrowLeft: ['M19 12H5', 'm11 6-6 6 6 6'],
  swap: ['m7 4-4 4 4 4', 'M3 8h14', 'm17 20 4-4-4-4', 'M21 16H7'],
  layers: ['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  external: ['M14 4h6v6', 'M20 4 10 14', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  code: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4', 'm13.5 5-3 14'],
  download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'], upload: ['M12 20V9', 'm7 14 5-5 5 5', 'M5 4h14'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  more: [[5, 12, 1], [12, 12, 1], [19, 12, 1]],
};
function icon(name, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'ico', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const part of ICONS[name] || []) {
    const el = document.createElementNS(NS, Array.isArray(part) ? 'circle' : 'path');
    if (Array.isArray(part)) { el.setAttribute('cx', part[0]); el.setAttribute('cy', part[1]); el.setAttribute('r', part[2]); } else el.setAttribute('d', part);
    svg.append(el);
  }
  return svg;
}
// Preferências de interface (recolher blocos da barra lateral etc.): só conveniência, guardadas no navegador.
const UI_PREFS_KEY = 'gp-ui';
const uiPref = (k, dflt = false) => { try { const v = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}')[k]; return v === undefined ? dflt : v; } catch { return dflt; } };
function setUiPref(k, v) {
  try { const o = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}'); o[k] = v; localStorage.setItem(UI_PREFS_KEY, JSON.stringify(o)); } catch { /* sem armazenamento: vale só nesta sessão */ }
}

// opts.timeoutMs: rede de segurança para chamadas que dependem de servidores externos (nunca "carregar para sempre").
async function api(method, url, body, opts = {}) {
  let r;
  try {
    r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('O aplicativo não recebeu resposta a tempo. Confira a conexão (VPN) e tente de novo.');
    throw e;
  }
  const json = await r.json().catch(() => ({}));
  // Sessão perdida/inexistente (modo nuvem): a tela de acesso assume (auth.js); o erro não vira aviso em cada tela.
  if ((r.status === 401 && (json.code === 'AUTH_REQUIRED' || json.code === 'LAUNCH_REQUIRED')) || (r.status === 403 && json.code === 'ACCOUNT_PENDING')) {
    if (typeof authLost === 'function') authLost(json);
    throw Object.assign(new Error(json.error || 'Sessão encerrada.'), { code: json.code, status: r.status, silent: true });
  }
  // Modo offline das horas: as outras telas avisam uma vez e não viram erro em cascata.
  if (r.status === 503 && json.code === 'OFFLINE_MODE') {
    if (!api.offlineWarned) { api.offlineWarned = true; toast(json.error, 'info'); }
    throw Object.assign(new Error(json.error), { code: json.code, status: r.status, silent: true });
  }
  if (!r.ok) throw Object.assign(new Error(json.error || `Erro ${r.status}`), { code: json.code, status: r.status, path: json.path, details: json });
  return json;
}

function toast(msg, kind = 'info') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 3500);
}
const fail = (e) => { if (e && e.silent) return; toast(e.message || String(e), 'error'); };

async function busy(btn, fn, working = 'Aguarde…') {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = working;
  try { return await fn(); } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = label; }
}

function openModal({ title, body, footer, wide = false, size = null, steps = null, onClose }) {
  const overlay = h('div', { class: 'overlay' });
  const close = () => { overlay.remove(); onClose && onClose(); };
  const modal = h('div', { class: `modal${wide ? ' wide' : ''}${size ? ` size-${size}` : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn ghost', 'aria-label': 'Fechar', onclick: close }, '✕')),
    steps, h('div', { class: 'modal-body' }, body), footer ? h('div', { class: 'modal-foot' }, footer) : null);
  overlay.append(modal);
  document.body.append(overlay);
  return { close, el: modal, overlay };
}

function confirmDialog({ title, message, okText = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    // openModal's close() sempre dispara onClose (é o mesmo close usado pelo botão "✕"), então resolve ANTES de
    // fechar e ignora qualquer resolução seguinte — senão o "cancelado" do onClose vence mesmo quando confirmado.
    const finish = (v) => { if (settled) return; settled = true; resolve(v); m.close(); };
    const m = openModal({
      title, size: 'sm', body: [h('p', { style: 'margin:0;white-space:pre-line' }, message)],
      footer: [h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancelar'), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, okText)],
      onClose: () => finish(false),
    });
  });
}

const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);

function pathField({ value = '', kind = 'folder', title, placeholder, filter }) {
  const input = h('input', { type: 'text', value, placeholder: placeholder || (kind === 'folder' ? 'C:\\Projetos\\Cliente' : 'C:\\...\\arquivo.xlsx') });
  const btn = h('button', { type: 'button', class: 'btn', onclick: async () => {
    btn.disabled = true;
    try { const r = await api('POST', `/api/dialog/${kind}`, { title, start: input.value, filter }); if (r.path) input.value = r.path; } catch (e) { fail(e); } finally { btn.disabled = false; }
  } }, 'Escolher…');
  return { el: h('div', { class: 'inline' }, input, btn), input, get: () => input.value.trim() };
}

// Pasta inicial por tipo de arquivo, com "último diretório válido" lembrado neste computador (o servidor pula o que não existir).
const LASTDIR_KEY = 'gp-lastdir';
const dirOf = (p) => (p ? String(p).replace(/[\\/][^\\/]*$/, '') : '');
function lastDir(kind, value) {
  try {
    const all = JSON.parse(localStorage.getItem(LASTDIR_KEY) || '{}');
    if (value === undefined) return all[kind] || '';
    all[kind] = value; localStorage.setItem(LASTDIR_KEY, JSON.stringify(all));
  } catch { /* sem armazenamento: só não lembra */ }
  return '';
}
async function pickFileIn(kind, { title, filter, starts = [] }) {
  const r = await api('POST', '/api/dialog/file', { title, filter, starts: [...starts, lastDir(kind)].filter(Boolean) });
  if (r.path) lastDir(kind, dirOf(r.path));
  return r.path;
}

// Data LOCAL (AAAA-MM-DD) de um instante ISO: cortar o texto ISO daria a data em UTC (depois das 21h, o dia seguinte).
const localDateOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '');
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

const STATE_LABEL = { none: 'Sem cronograma', ok: 'Em dia', soon: 'Próximo do prazo', overdue: 'Atrasado', done: 'Concluído' };
const pill = (st, text) => h('span', { class: `pill ${st}` }, text || STATE_LABEL[st]);

// ---------- Estágios, ciclo e contatos ----------
const stageById = (id) => state.stages.find((s) => s.id === id) || null;
const coordinatorById = (id) => state.coordinators.find((c) => c.id === id) || null;
const projectTypeById = (id) => state.projectTypes.find((t) => t.id === id) || null;
const originSystemById = (id) => state.originSystems.find((t) => t.id === id) || null;
// Cada projeto tem a sua cópia dos passos do ciclo que usa (os ciclos são por tipo de projeto).
const projectSteps = (p) => (p && Array.isArray(p.steps) ? p.steps : []);
const cycleById = (id) => state.cycles.find((c) => c.id === id) || null;
const stepIndex = (p) => projectSteps(p).findIndex((c) => c.id === p.stepId);
// Estágio atual do projeto (a partir do passo do ciclo em que ele está), ou null se ainda não definido.
function stageOf(p) {
  const i = stepIndex(p);
  const stage = i < 0 ? null : stageById(projectSteps(p)[i].stageId);
  return stage ? { ...stage, index: i, total: projectSteps(p).length } : null;
}
// Cor do texto sobre uma cor de estágio (azul escuro ou branco, o que tiver mais contraste).
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#002233' : '#ffffff';
}
const tagStyle = (color) => `--c:${color};--ink:${inkFor(color)}`; // a cor vem validada (#RRGGBB) pelo servidor
const stageTag = (stage, text) => h('span', { class: 'tag', style: tagStyle(stage.color), title: text || stage.name }, text || stage.name); // title: nome inteiro quando a etiqueta é cortada
const noStageTag = (text = 'Sem etapa') => h('span', { class: 'tag none' }, text);

// Links de contato (abrem no WhatsApp / cliente de e-mail; no app desktop, no programa padrão do Windows).
function contactLinks(c, { size = 'sm' } = {}) {
  return h('span', { class: 'contact-links' },
    c.waUrl ? h('a', { class: `btn ${size} wa`, href: c.waUrl, target: '_blank', rel: 'noopener noreferrer', title: `Abrir conversa no WhatsApp com ${c.name}` }, 'WhatsApp') : null,
    c.email ? h('a', { class: `btn ${size}`, href: `mailto:${c.email}`, target: '_blank', rel: 'noopener noreferrer', title: c.email }, 'E-mail') : null);
}

function daysText(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return `atrasado há ${plural(-days, 'dia', 'dias')}`;
  if (days === 0) return 'vence hoje';
  if (days === 1) return 'vence amanhã';
  return `em ${plural(days, 'dia', 'dias')}`;
}

// ---------- Tema (claro / escuro / sistema) ----------
// "Sistema" não define o atributo: as regras de @media (prefers-color-scheme) do CSS reagem sozinhas,
// inclusive se o tema do Windows mudar com o app aberto. "Claro"/"Escuro" fixam a escolha (data-theme).
const THEME_KEY = 'gp-theme';
const getThemePref = () => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; } };
function applyTheme(pref) {
  if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
  else document.documentElement.removeAttribute('data-theme');
}
function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* modo privado ou bloqueado: só não persiste entre sessões */ }
  applyTheme(pref);
  renderThemeToggle();
}
function renderThemeToggle() {
  const el = document.getElementById('themeToggle');
  if (!el) return;
  const pref = getThemePref();
  const opt = (v, ico, label) => h('button', { class: pref === v ? 'active' : '', title: `Tema: ${label}`, 'aria-label': `Tema ${label}`, 'aria-pressed': pref === v ? 'true' : 'false', onclick: () => setTheme(v) }, icon(ico, 15));
  el.replaceChildren(h('div', { class: 'theme-toggle', role: 'group', 'aria-label': 'Tema' }, opt('light', 'sun', 'Claro'), opt('dark', 'moon', 'Escuro'), opt('system', 'monitor', 'Sistema')));
}
applyTheme(getThemePref()); // aplicado assim que o script carrega, antes da primeira renderização (sem piscar)

// ---------- Estado e roteamento ----------
async function refresh() {
  const s = await api('GET', '/api/state');
  Object.assign(state, s);
  ckReset(); // o modelo do checklist pode ter mudado: os checklists abertos são relidos
  render();
}
// Atualiza o projeto no estado sem redesenhar a tela (ex.: com uma janela aberta por cima).
function replaceProjectQuiet(p) {
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) state.projects[i] = p;
}
function replaceProject(p) {
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) state.projects[i] = p;
  render();
}
const route = () => {
  const m = location.hash.match(/^#\/(project|audit|settings|docs|scripts|workspace|hours)(?:\/(\w+))?/);
  return m ? { name: m[1], id: m[2] } : { name: 'home' };
};
window.addEventListener('hashchange', render);

const ORDER = { overdue: 0, soon: 1, ok: 2, none: 3, done: 4 };
const sortedProjects = () => [...state.projects].sort((a, b) => ORDER[a.schedule.state] - ORDER[b.schedule.state] || a.name.localeCompare(b.name, 'pt-BR'));

function render() {
  const r = route();
  renderNav(r);
  const main = document.getElementById('main');
  main.replaceChildren();
  main.classList.toggle('ws-mode', r.name === 'workspace'); // o Workspace ocupa a área inteira
  main.classList.toggle('settings-mode', r.name === 'settings'); // sem respiro no topo: a barra de abas fixa encosta na borda, sem conteúdo aparecendo por cima
  applyNavPref(); // barra lateral recolhida (preferência; no Workspace também recolhe sozinha em janela estreita)
  if (r.name === 'audit') return renderAudit(main);
  if (r.name === 'settings') return renderSettings(main);
  if (r.name === 'docs') return renderDocs(main);
  if (r.name === 'scripts') return renderScripts(main);
  if (r.name === 'workspace') return renderWorkspace(main);
  if (r.name === 'hours') return renderHours(main);
  if (r.name === 'project') {
    const p = state.projects.find((x) => x.id === r.id);
    if (p) return renderProject(main, p);
    location.hash = '#/';
    return;
  }
  renderHome(main);
}

function renderNav(r) {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...[
    h('button', { class: `nav-item nav-home${r.name === 'home' ? ' active' : ''}`, onclick: () => (location.hash = '#/') }, icon('home'), h('span', { class: 'grow name' }, 'Visão geral')),
    state.projects.length ? h('div', { class: 'nav-sep' }, 'Projetos') : null,
    ...sortedProjects().map((p) => h('button', { class: `nav-item${r.id === p.id ? ' active' : ''}`, onclick: () => (location.hash = `#/project/${p.id}`) },
      h('span', { class: `dot ${p.schedule.state}`, title: STATE_LABEL[p.schedule.state] }),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, p.name),
        stageOf(p) ? h('div', null, stageTag(stageOf(p))) : null,
        projectProgressBar(p),
        p.schedule.next ? h('div', { class: 'hint' }, `${fmtDate(p.schedule.next.dueDate)} · ${daysText(p.schedule.next.days)}`) : null))),
  ].filter(Boolean));

  // Menu do rodapé: aberto (ícone + nome) ou recolhido (só ícones, numa fileira) — a lista de projetos ganha espaço.
  const menuMin = uiPref('menuMin');
  const link = (m) => h('button', { class: `nav-item nav-link${r.name === m.name ? ' active' : ''}`, title: m.label, 'aria-label': m.label, 'aria-current': r.name === m.name ? 'page' : null, onclick: () => (location.hash = m.hash) },
    icon(m.icon), menuMin ? null : h('span', { class: 'grow' }, m.label));
  const toggleMenu = h('button', { class: 'side-toggle', 'aria-expanded': menuMin ? 'false' : 'true', title: menuMin ? 'Mostrar os nomes do menu' : 'Recolher o menu (só ícones)', onclick: () => { setUiPref('menuMin', !menuMin); renderNav(route()); } },
    h('span', null, 'Menu'), icon(menuMin ? 'chevronUp' : 'chevronDown', 14));
  document.getElementById('navfoot').replaceChildren(toggleMenu, h('div', { class: `navfoot-list${menuMin ? ' icons' : ''}` }, NAV_MENU.map(link)));
  // Trilho da barra recolhida: logo, reabrir, Visão geral, o menu e novo projeto — tudo a um clique, com dica.
  const rail = document.getElementById('railNav');
  if (rail) {
    const rb = (ico, label, onclick, active, key) => h('button', { type: 'button', class: active ? 'active' : '', title: label, 'aria-label': label, 'data-rail': key || null, onclick }, icon(ico, 17));
    rail.replaceChildren(rb('home', 'Visão geral', () => (location.hash = '#/'), r.name === 'home' || r.name === 'project'),
      h('span', { class: 'rail-sep' }), ...NAV_MENU.map((m) => rb(m.icon, m.label, () => (location.hash = m.hash), r.name === m.name, m.name)),
      h('span', { class: 'rail-sep' }), rb('plus', 'Novo projeto', () => projectForm(), false));
    if (typeof hoursRailMark === 'function') hoursRailMark();
  }
}
const NAV_MENU = [
  { hash: '#/hours', name: 'hours', icon: 'clock', label: 'Controle de Horas' },
  { hash: '#/workspace', name: 'workspace', icon: 'workspace', label: 'Workspace (arquivos e Git)' },
  { hash: '#/docs', name: 'docs', icon: 'docs', label: 'Documentos e Modelos' },
  { hash: '#/scripts', name: 'scripts', icon: 'scripts', label: 'Scripts SQL' },
  { hash: '#/settings', name: 'settings', icon: 'settings', label: 'Configurações' },
  { hash: '#/audit', name: 'audit', icon: 'audit', label: 'Auditoria de execuções' },
];

// ---------- Início ----------
// Visão geral operacional: primeiro o dia (horas), depois o que exige atenção (prazos, checklists que travam etapas, ciclos com
// versão nova), o Git com pendências e, por fim, o panorama dos projetos. Cada bloco só aparece com conteúdo útil.
const HOME_GIT = { at: 0, data: null, loading: false };
async function homeGitLoad(force = false) {
  if (HOME_GIT.loading || (!force && HOME_GIT.data && Date.now() - HOME_GIT.at < 60000)) return;
  HOME_GIT.loading = true;
  try {
    const info = await api('GET', '/api/wsm');
    HOME_GIT.data = info.rootExists ? { root: info.root, projects: (await api('GET', '/api/wsm/projects?git=1')).projects } : { root: info.root, projects: null };
    HOME_GIT.at = Date.now();
  } catch (e) { HOME_GIT.data = { error: e.message }; } finally { HOME_GIT.loading = false; }
  const slot = document.querySelector('[data-slot="home-git"]');
  if (slot) slot.replaceChildren(homeGitCard());
}
function homeGitCard() {
  const d = HOME_GIT.data;
  const head = h('a', { class: 'link-quiet', href: '#/workspace' }, 'Abrir Workspace');
  if (!d) { homeGitLoad(); return card('Git com pendências', head, h('div', { class: 'empty' }, 'Consultando os repositórios…')); }
  if (d.error) return card('Git com pendências', head, h('div', { class: 'empty' }, `Não foi possível consultar o Workspace: ${d.error}`));
  if (!d.projects) return card('Git com pendências', head, h('div', { class: 'empty' }, 'Workspace ainda não configurado. ', h('a', { href: '#/workspace' }, 'Escolher a pasta raiz dos projetos')));
  const pend = d.projects.filter((x) => x.git && x.summary && !x.summary.error && (x.summary.changes || x.summary.ahead || x.summary.behind || x.summary.conflicts));
  return card('Git com pendências', h('div', { class: 'inline' }, h('button', { class: 'btn xs ghost', title: 'Consultar de novo', onclick: () => homeGitLoad(true) }, '⟳'), head),
    pend.length ? h('div', { class: 'att-list' }, pend.slice(0, 8).map((x) => h('div', { class: 'att-row' },
      h('div', { class: 'grow' }, h('strong', null, x.alias || x.name), h('span', { class: 'muted small mono' }, `  ${x.summary.branch || ''}`)),
      x.summary.conflicts ? h('span', { class: 'pill overdue' }, `${x.summary.conflicts} conflito(s)`) : null,
      x.summary.changes ? h('span', { class: 'pill soon', title: 'Arquivos alterados sem commit' }, `● ${x.summary.changes} alteração(ões)`) : null,
      x.summary.ahead ? h('span', { class: 'pill', title: 'Commits aguardando Push' }, `↑ ${x.summary.ahead} push`) : null,
      x.summary.behind ? h('span', { class: 'pill', title: 'Commits no remoto aguardando Pull (desde o último Fetch)' }, `↓ ${x.summary.behind} pull`) : null)),
      pend.length > 8 ? h('div', { class: 'small muted' }, `… e mais ${pend.length - 8} em Workspace → Repositórios.`) : null)
      : h('div', { class: 'empty' }, `Nenhum repositório com alterações ou commits pendentes (${plural(d.projects.filter((x) => x.git).length, 'repositório', 'repositórios')}).`));
}

// Barra de progresso do projeto: o valor vem PRONTO do servidor (p.progress = checklist.projectProgress), igual na lateral e na
// Visão Geral. A tela não calcula porcentagem. Sem itens de checklist no ciclo → nada é mostrado.
function projectProgressBar(p, { wide = false } = {}) {
  const pr = p.progress;
  if (!pr || pr.percent === null) return null;
  const tip = `Etapa ${pr.current} de ${pr.steps} do ciclo · ${pr.done} de ${plural(pr.total, 'item', 'itens')} de checklist concluídos${pr.awaitingEvidence ? ` · ${pr.awaitingEvidence} aguardando evidência` : ''}${pr.concluded ? ' · ciclo concluído' : ''}`;
  return h('div', { class: `pp${wide ? ' wide' : ''}${pr.percent === 100 ? ' full' : ''}`, title: tip, role: 'progressbar', 'aria-label': `Progresso de ${p.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pr.percent) },
    h('span', { class: 'pp-bar' }, h('span', { class: 'pp-fill', style: `width:${pr.percent}%` })), h('span', { class: 'pp-n' }, `${pr.percent}%`));
}
// Projeto concluído = está no último passo do ciclo (mesma regra das horas).
const projectConcluded = (p) => !!(p.steps?.length && p.stepId === p.steps[p.steps.length - 1].id);

// Indicadores do topo da Visão Geral. Os de horas usam o estado do Controle de Horas (carregado à parte; hoursRedraw atualiza).
function homeKpis() {
  const active = state.projects.filter((p) => !projectConcluded(p));
  const pend = state.projects.reduce((n, p) => n + (p.pendencies?.requiredPending || 0), 0);
  const pendProj = state.projects.filter((p) => p.pendencies?.requiredPending).length;
  const overdue = state.projects.filter((p) => p.schedule.state === 'overdue').length;
  const soon = state.projects.filter((p) => p.schedule.state === 'soon').length;
  const st = typeof HR !== 'undefined' ? HR.st : null;
  const t = st && typeof runningTimer === 'function' ? runningTimer() : null;
  const goAttention = () => document.querySelector('[data-sec="home-attention"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const kpi = (label, value, sub, tone, onclick, title) => h(onclick ? 'button' : 'div', { class: `kpi${tone ? ` ${tone}` : ''}`, type: onclick ? 'button' : null, title: title || null, onclick: onclick || null },
    h('span', { class: 'kpi-l' }, label), h('span', { class: 'kpi-v' }, value), sub ? h('span', { class: 'kpi-s' }, sub) : null);
  return [
    kpi('Projetos ativos', String(active.length), `${plural(state.projects.length - active.length, 'concluído', 'concluídos')}`),
    kpi('Pendências obrigatórias', String(pend), pend ? `em ${plural(pendProj, 'projeto', 'projetos')}` : 'nenhuma até a etapa atual', pend ? 'warn' : 'ok', pend ? goAttention : null, 'Itens obrigatórios ainda não concluídos (inclui pendências herdadas)'),
    kpi('Prazos', overdue ? `${overdue} atrasado${overdue > 1 ? 's' : ''}` : soon ? `${soon} perto` : 'em dia', overdue && soon ? `${soon} perto do prazo` : 'marcos do cronograma', overdue ? 'bad' : soon ? 'warn' : '', overdue || soon ? goAttention : null),
    st ? kpi('Horas hoje', `${hm(st.day.confirmed)} / ${hm(st.day.target)}`, t ? `em andamento: ${t.projectName || t.activity || 'atividade'}` : st.pending.length ? `${plural(st.pending.length, 'dia pendente', 'dias pendentes')}` : 'nenhum dia pendente',
      st.pending.length ? 'warn' : '', () => (location.hash = '#/hours'), 'Abrir Controle de Horas')
      : kpi('Horas hoje', '…', 'carregando'),
    st ? kpi('Ocorrências hoje', String(st.notesToday || 0), 'observações do dia', st.notesToday ? 'info' : '', () => (location.hash = '#/hours'), 'Observações registradas hoje no Controle de Horas') : null,
  ].filter(Boolean);
}

function renderHome(main) {
  const attention = [];
  const open = (p) => () => (location.hash = `#/project/${p.id}`);
  for (const p of state.projects) {
    for (const m of p.milestones) {
      if (m.done) continue;
      const days = Math.round((Date.parse(m.dueDate) - Date.parse(state.today)) / 86400000);
      const limit = Number.isInteger(m.alertDays) ? m.alertDays : state.settings.warnDays;
      if (days <= limit) attention.push({ order: days, kind: 'Prazo', tone: days < 0 ? 'bad' : 'warn', p, title: m.title, sub: `${p.name} · ${fmtDate(m.dueDate)}`, badge: pill(days < 0 ? 'overdue' : 'soon', daysText(days)), action: ['Abrir', open(p)] });
    }
    const ck = p.stepId ? p.checklist?.[p.stepId] : null;
    const st = stageOf(p);
    const missing = ck && ck.requiredTotal ? ck.requiredTotal - ck.requiredDone : 0;
    const inh = p.pendencies?.inherited || 0; // pendências carregadas de etapas anteriores (dívida operacional)
    if (missing || inh) {
      const parts = [missing ? `faltam ${missing} obrigatório(s) para avançar${ck.awaitingEvidence ? ` · ${ck.awaitingEvidence} aguardando evidência` : ''}` : null, inh ? `⚠ ${plural(inh, 'pendência herdada', 'pendências herdadas')}` : null].filter(Boolean);
      attention.push({ order: 1000, kind: 'Checklist', tone: 'warn', p, title: p.name, sub: `Etapa ${st ? st.name : '?'} · ${parts.join(' · ')}`,
        badge: h('span', { class: 'pill soon' }, missing ? `${ck.requiredDone}/${ck.requiredTotal}` : `⚠ ${inh}`), action: ['Ver checklist', () => { location.hash = `#/project/${p.id}`; setTimeout(() => document.querySelector('[data-slot="checklist"]')?.scrollIntoView({ block: 'start' }), 50); }] });
    }
  }
  // Versão nova de ciclo: uma linha por ciclo (não uma por projeto), com revisão em lote.
  for (const c of state.cycles) {
    const outdated = state.projects.filter((p) => p.cycleId === c.id && p.cycleUpdate?.available);
    if (!outdated.length) continue;
    attention.push({ order: 2000, kind: 'Ciclo', tone: 'info', title: c.name, sub: `Nova versão (v${c.version}) disponível para ${plural(outdated.length, 'projeto', 'projetos')}: ${outdated.slice(0, 3).map((p) => p.name).join(', ')}${outdated.length > 3 ? '…' : ''}`,
      badge: null, action: ['Revisar', () => (outdated.length === 1 ? cycleUpdateDialog(outdated[0]) : cycleBulkDialog(c))] });
  }
  // Horas: dias anteriores com horas faltando (estado do Controle de Horas, se já carregado).
  const hst = typeof HR !== 'undefined' ? HR.st : null;
  if (hst?.pending?.length) attention.push({ order: 1500, kind: 'Horas', tone: 'warn', title: plural(hst.pending.length, 'dia com horas incompletas', 'dias com horas incompletas'), sub: 'Dias anteriores abaixo da meta ou sem apontamento.', badge: null, action: ['Abrir horas', () => (location.hash = '#/hours')] });
  attention.sort((a, b) => a.order - b.order);

  // Projetos por etapa (na ordem dos ciclos; estágios repetidos contam uma vez só).
  const byStage = new Map();
  for (const p of state.projects) { const st = stageOf(p); const k = st ? st.id : null; byStage.set(k, (byStage.get(k) || 0) + 1); }
  const stageOrder = [...new Set(state.cycles.flatMap((c) => c.steps.map((s) => s.stageId)))].filter((id) => byStage.has(id));

  const projectRow = (p) => {
    const st = stageOf(p);
    const pend = p.pendencies?.requiredPending || 0;
    return h('button', { class: 'home-proj', type: 'button', onclick: open(p), title: `Abrir ${p.name}` },
      h('span', { class: `dot ${p.schedule.state}`, title: STATE_LABEL[p.schedule.state] }),
      h('span', { class: 'home-proj-main' }, h('strong', { class: 'home-proj-name' }, p.name),
        h('span', { class: 'home-proj-sub' }, st ? stageTag(st) : noStageTag(), projectConcluded(p) ? h('span', { class: 'pill done' }, 'concluído') : null,
          p.schedule.next ? h('span', { class: 'small muted' }, `${fmtDate(p.schedule.next.dueDate)} · ${daysText(p.schedule.next.days)}`) : null)),
      h('span', { class: 'home-proj-prog' }, projectProgressBar(p, { wide: true }) || h('span', { class: 'small muted' }, 'sem checklist no ciclo')),
      h('span', { class: 'home-proj-flags' }, pend ? h('span', { class: 'pill soon', title: 'Obrigatórios pendentes até a etapa atual (inclui herdados)' }, `${pend} pend.`) : null,
        p.pendencies?.inherited ? h('span', { class: 'pill', title: 'Pendências herdadas de etapas anteriores' }, `⚠ ${p.pendencies.inherited} herdada${p.pendencies.inherited > 1 ? 's' : ''}`) : null));
  };

  const attentionCard = card(['Precisam de atenção', attention.length ? h('span', { class: 'muted small', style: 'font-weight:400' }, `  ${attention.length}`) : null], null,
    attention.length ? h('div', { class: 'att-list' }, attention.slice(0, 12).map((a) => h('div', { class: `att-row tone-${a.tone || 'info'}` },
      h('span', { class: 'att-kind' }, a.kind), h('div', { class: 'grow stack', style: 'gap:2px' }, h('strong', null, a.title), h('span', { class: 'muted small' }, a.sub)),
      a.badge, h('button', { class: 'btn sm', onclick: a.action[1] }, a.action[0]))),
    attention.length > 12 ? h('div', { class: 'small muted' }, `… e mais ${attention.length - 12}.`) : null)
      : h('div', { class: 'empty' }, '✓ Nada pedindo atenção: nenhum prazo perto de estourar, nenhuma etapa travada por checklist e nenhum ciclo com versão nova.'));
  const projectsCard = card(['Projetos', h('span', { class: 'muted small', style: 'font-weight:400' }, `  ${state.projects.length}`)], h('button', { class: 'btn sm', onclick: () => projectForm() }, '+ Novo projeto'),
    stageOrder.length || byStage.has(null) ? h('div', { class: 'chips home-stages' },
      stageOrder.map((id) => h('span', { class: 'chip', title: 'Projetos nesta etapa' }, stageTag(stageById(id)), h('strong', null, byStage.get(id)))),
      byStage.has(null) ? h('span', { class: 'chip' }, noStageTag(), h('strong', null, byStage.get(null))) : null) : null,
    h('div', { class: 'home-projs' }, sortedProjects().map(projectRow)),
    h('div', { class: 'hint' }, 'Progresso = etapas do ciclo (peso igual) × itens de checklist concluídos em cada uma (obrigatórios e opcionais; evidência exigida só conta com a evidência). Etapa sem checklist só conta depois de ultrapassada; 100% só ao concluir o ciclo.'));

  main.append(h('div', { class: 'page home-page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Visão geral'), h('div', { class: 'muted' }, `Hoje: ${fmtDate(state.today)}`)),
      h('div', { class: 'actions inline' }, h('button', { class: 'btn', onclick: () => (location.hash = '#/hours') }, 'Registrar horas'), h('button', { class: 'btn primary', onclick: () => projectForm() }, '+ Novo projeto'))),
    !state.projects.length ? h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('h2', null, 'Nenhum projeto cadastrado'),
      h('div', { class: 'muted' }, 'Cadastre um projeto para associar a pasta raiz, as bases de dados, as planilhas e (opcionalmente) prazos.'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => projectForm() }, '+ Novo projeto')))) : null,
    state.projects.length ? h('div', { class: 'home-kpis', 'data-slot': 'home-kpis' }, homeKpis()) : null,
    h('div', { class: 'home-grid' },
      h('div', { class: 'home-col' }, state.projects.length ? h('div', { 'data-sec': 'home-attention' }, attentionCard) : null, state.projects.length ? projectsCard : null),
      h('div', { class: 'home-col' }, h('div', { 'data-slot': 'hours-home' }, hoursHomeCard()), state.projects.length ? h('div', { 'data-slot': 'home-git' }, homeGitCard()) : null)),
  ));
}

// ---------- Projeto ----------
function projectForm(p) {
  const name = h('input', { type: 'text', value: p?.name || '', maxlength: 120 });
  const desc = h('textarea', { maxlength: 1000 }, p?.description || '');
  const rootKind = h('select', { onchange: () => syncRoot() },
    h('option', { value: 'local', selected: (p?.rootDirKind || 'local') === 'local' }, 'Pasta local'),
    h('option', { value: 'drive', selected: p?.rootDirKind === 'drive' }, 'Link de uma pasta no Google Drive'));
  const root = pathField({ value: p?.rootDirKind !== 'drive' ? p?.rootDir || '' : '', title: 'Pasta raiz do projeto' });
  const driveUrl = h('input', { type: 'text', value: p?.rootDriveUrl || '', placeholder: 'https://drive.google.com/drive/folders/…' });
  const rootLocalField = field('Pasta', root.el, 'Diretório principal do projeto neste computador.');
  const rootDriveField = field('Link da pasta no Google Drive', driveUrl, 'Abre no navegador; o app só guarda o link, não acessa o conteúdo da pasta.');
  const syncRoot = () => { rootLocalField.style.display = rootKind.value === 'local' ? '' : 'none'; rootDriveField.style.display = rootKind.value === 'drive' ? '' : 'none'; };
  syncRoot();
  const waGroup = h('input', { type: 'text', value: p?.whatsappGroupUrl || '', placeholder: 'https://chat.whatsapp.com/…', maxlength: 300 });
  const personSelect = (current, none) => h('select', null, h('option', { value: '' }, none),
    state.coordinators.map((c) => h('option', { value: c.id, selected: current === c.id }, c.role ? `${c.name} — ${c.role}` : c.name)));
  const coord = personSelect(p?.coordinatorId, '— Sem coordenador —');
  const analyst = personSelect(p?.analystId, '— Sem analista —');
  const tagSelect = (items, current, none) => h('select', null, h('option', { value: '' }, none), items.map((t) => h('option', { value: t.id, selected: current === t.id }, t.name)));
  const ptype = tagSelect(state.projectTypes, p?.projectTypeId, '— Sem tipo —');
  // Ciclo: segue o tipo escolhido (ciclo padrão do tipo) até a pessoa escolher outro à mão.
  const cycleOfType = (typeId) => cycleById(state.projectTypes.find((t) => t.id === typeId)?.cycleId)?.id || state.defaultCycleId;
  const defConn = h('select', null, h('option', { value: '' }, `— Usar a padrão geral${state.settings.defaultConnectionId ? ` (${connById(state.settings.defaultConnectionId)?.name || '—'})` : ''} —`),
    state.connections.map((c) => h('option', { value: c.id, selected: p?.defaultConnectionId === c.id }, c.name)));
  const cycleSel = h('select', null, state.cycles.map((c) => h('option', { value: c.id, selected: (p ? p.cycleId : cycleOfType(p?.projectTypeId)) === c.id }, `${c.name}${c.id === state.defaultCycleId ? ' (padrão)' : ''} — ${plural(c.steps.length, 'etapa', 'etapas')}`)));
  let cycleTouched = !!p;
  cycleSel.addEventListener('change', () => { cycleTouched = true; });
  ptype.addEventListener('change', () => { if (!cycleTouched) cycleSel.value = cycleOfType(ptype.value); });
  const origin = tagSelect(state.originSystems, p?.originSystemId, '— Sem sistema de origem —');
  const m = openModal({
    title: p ? 'Editar projeto' : 'Novo projeto',
    body: [field('Nome do projeto', name),
      h('div', { class: 'cols2' },
        field('Tipo de projeto', ptype, !state.projectTypes.length ? 'Cadastre os tipos em Configurações.' : null),
        field('Sistema de origem', origin, !state.originSystems.length ? 'Cadastre os sistemas em Configurações.' : null)),
      field('Ciclo de migração', cycleSel, p ? 'Trocar o ciclo de um projeto em andamento pede confirmação; o histórico e os checklists já feitos ficam guardados.' : 'Vem do tipo do projeto (Configurações → Ciclos). O projeto recebe uma cópia das etapas e dos checklists.'),
      state.connections.length ? field('Conexão padrão do projeto', defConn, 'Pré-selecionada ao executar scripts pelo checklist deste projeto.') : null,
      h('div', { class: 'cols2' }, field('Coordenador', coord), field('Analista', analyst)),
      h('div', { class: 'hint', style: 'margin-top:-8px' }, state.coordinators.length ? 'Coordenador e analista vêm do mesmo cadastro de responsáveis (Configurações → Geral).' : 'Nenhum responsável cadastrado ainda. Cadastre em Configurações → Geral.'),
      field('Pasta raiz — onde fica', rootKind, 'O diretório oficial do projeto. Pode ser local (ex.: o repositório) ou uma pasta compartilhada no Drive.'),
      rootLocalField, rootDriveField,
      field('Grupo do WhatsApp do projeto', waGroup, 'Opcional. Cole o link de convite do grupo (chat.whatsapp.com/…); aparece como botão no topo do projeto.'),
      field('Descrição', desc)],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { name: name.value, description: desc.value, rootDirKind: rootKind.value, rootDir: root.get(), rootDriveUrl: driveUrl.value, whatsappGroupUrl: waGroup.value,
          coordinatorId: coord.value || null, analystId: analyst.value || null, projectTypeId: ptype.value || null, originSystemId: origin.value || null, cycleId: cycleSel.value || null, defaultConnectionId: defConn.value || null };
        let saved;
        try { saved = p ? await api('PUT', `/api/projects/${p.id}`, body) : await api('POST', '/api/projects', body); } catch (err) {
          if (err.code !== 'CYCLE_CHANGE') throw err;
          if (!(await confirmDialog({ title: 'Trocar o ciclo do projeto', message: err.message, okText: 'Trocar ciclo' }))) return;
          saved = await api('PUT', `/api/projects/${p.id}`, { ...body, confirmCycleChange: true });
        }
        await refresh(); m.close(); location.hash = `#/project/${saved.id}`;
      }) }, 'Salvar')],
  });
  name.focus();
}
document.getElementById('newProject').addEventListener('click', () => projectForm());
// Botão “Atualizar a página”: relê o estado do servidor e redesenha a tela atual (o mesmo efeito de F5, sem sair do lugar). Útil para a saudação {{greeting}} e dados novos.
{
  const btn = document.getElementById('reloadPage');
  if (btn) {
    btn.append(icon('refresh', 15));
    btn.addEventListener('click', async () => { btn.disabled = true; try { await refresh(); toast('Página atualizada.', 'ok'); } catch (e) { fail(e); } finally { btn.disabled = false; } });
  }
}

function card(title, actions, ...body) {
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'grow' }, title), actions), h('div', { class: 'card-body' }, body));
}
const openFolder = (path) => api('POST', '/api/open-folder', { path }).catch(fail);
const dirLine = (path, exists) => h('div', { class: 'stack' }, h('span', { class: 'mono' }, path || '—'), path && !exists ? h('span', { class: 'pill overdue', style: 'width:fit-content' }, 'pasta não encontrada') : null);

const PROJECT_SECTIONS = [['observacoes', 'Observações'], ['ciclo', 'Ciclo'], ['checklist', 'Checklist'], ['horas', 'Horas'], ['ambientes', 'Ambientes RM'], ['comunicacoes', 'Comunicações'], ['bases', 'Bases'], ['planilhas', 'Planilhas'], ['arquivos', 'Pastas e Git'], ['cronograma', 'Cronograma'], ['correcoes', 'Correções'], ['documentos', 'Documentos']];
function renderProject(main, p) {
  const s = p.schedule;
  main.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', null, p.name), p.description ? h('div', { class: 'muted', style: 'margin-top:4px' }, p.description) : null,
        h('div', { class: 'inline', style: 'margin-top:10px' }, pill(s.state, s.next ? `${STATE_LABEL[s.state]} · ${daysText(s.next.days)}` : undefined),
          stageOf(p) ? stageTag(stageOf(p)) : noStageTag(), projectTypeById(p.projectTypeId) ? stageTag(projectTypeById(p.projectTypeId)) : null,
          originSystemById(p.originSystemId) ? stageTag(originSystemById(p.originSystemId)) : null,
          p.pendencies?.requiredPending ? h('span', { class: 'pill soon', title: 'Itens obrigatórios não concluídos em qualquer etapa até a atual (a conclusão do projeto exige todos)' }, `${plural(p.pendencies.requiredPending, 'obrigatório pendente', 'obrigatórios pendentes')}`) : null,
          p.pendencies?.inherited ? h('span', { class: 'pill soon', title: 'Pendências transferidas de etapas anteriores para a etapa atual' }, `⚠ ${plural(p.pendencies.inherited, 'herdada', 'herdadas')}`) : null),
        h('div', { style: 'margin-top:8px' }, coordinatorChip(p)),
        // Ações rápidas: abrir o ambiente (RM.exe) e entrar no grupo do WhatsApp — numa linha própria, abaixo das pessoas.
        h('div', { class: 'proj-quick' }, rmQuickLaunch(p),
          p.whatsappGroupUrl ? h('a', { class: 'btn sm wa', href: p.whatsappGroupUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Entrar no grupo do WhatsApp deste projeto' }, 'Grupo do WhatsApp') : null)),
      h('div', { class: 'actions inline' }, h('button', { class: 'btn', onclick: () => projectForm(p) }, 'Editar'),
        h('button', { class: 'btn', onclick: async () => {
          if (await confirmDialog({ title: 'Remover projeto', message: `Remover “${p.name}” do app? Isso apaga apenas o cadastro (pastas, arquivos e bases de dados não são tocados).`, okText: 'Remover cadastro', danger: true })) {
            try { await api('DELETE', `/api/projects/${p.id}`); location.hash = '#/'; await refresh(); } catch (e) { fail(e); }
          }
        } }, 'Remover'))),
    h('nav', { class: 'section-nav', 'aria-label': 'Seções do projeto' }, PROJECT_SECTIONS.map(([id, label]) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); document.querySelector(`[data-sec="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, label))),
    h('div', { 'data-sec': 'observacoes' }, projectNotesCard(p)),
    h('div', { 'data-slot': 'cycle', 'data-sec': 'ciclo' }, cycleCard(p)), h('div', { 'data-slot': 'checklist', 'data-sec': 'checklist' }, checklistCard(p)),
    h('div', { 'data-slot': 'hours-project', 'data-sec': 'horas' }, hoursProjectCard(p)),
    h('div', { 'data-sec': 'ambientes' }, rmEnvCard(p)),
    h('div', { 'data-slot': 'comms', 'data-project': p.id, 'data-sec': 'comunicacoes' }, projectCommsCard(p)),
    h('div', { 'data-sec': 'bases' }, basesCard(p)), h('div', { 'data-sec': 'planilhas' }, deparasCard(p)), h('div', { class: 'sec-group', 'data-sec': 'arquivos' }, rootCard(p), workspaceCard(p)),
    h('div', { 'data-sec': 'cronograma' }, scheduleCard(p)), h('div', { 'data-sec': 'correcoes' }, correctionsCard(p)), h('div', { 'data-sec': 'documentos' }, stageDocsCard(p))));
}

// Pasta raiz: uma pasta local (padrão) OU o link de uma pasta do Google Drive — nunca as duas ao mesmo tempo.
// Pensada para o diretório "oficial" do projeto (a base de dados de cada Base já tem seu próprio diretório local, ex.: o repositório do Git).
function rootCard(p) {
  if (p.rootDirKind === 'drive') {
    return card('Pasta raiz (Google Drive)', p.rootDriveUrl ? h('a', { class: 'btn sm primary', href: p.rootDriveUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir no Google Drive') : null,
      p.rootDriveUrl ? h('div', { class: 'stack' }, h('span', { class: 'mono' }, p.rootDriveUrl), h('span', { class: 'small muted' }, 'O app só guarda o link; ele não acessa o conteúdo da pasta.')) : h('div', { class: 'empty' }, 'Nenhum link definido. Use “Editar” para colar o link da pasta no Drive.'));
  }
  return card('Pasta raiz', p.rootDir ? h('button', { class: 'btn sm', disabled: !p.rootDirExists, onclick: () => openFolder(p.rootDir) }, 'Abrir no Explorer') : null,
    p.rootDir ? dirLine(p.rootDir, p.rootDirExists) : h('div', { class: 'empty' }, 'Nenhuma pasta definida. Use “Editar” para escolher.'));
}

// SQL Workspace do projeto: scripts .sql reais (pasta configurável), editor, execução e Git.
// Workspace (global): arquivos e Git dos projetos da pasta raiz. Daqui, abre direto na pasta ligada a este projeto
// (a pasta raiz, o diretório de uma base ou o repositório usado antes estão dentro dela).
function workspaceCard(p) {
  const dirs = [p.workspace?.gitRoot, p.rootDirKind === 'drive' ? null : p.rootDir, ...p.bases.map((b) => b.directory)].filter(Boolean);
  return card('Workspace (arquivos e Git)', h('button', { class: 'btn sm primary', onclick: () => focusProjectFromApp(p) }, 'Abrir no Workspace'),
    h('div', { class: 'stack' },
      dirs.length ? h('span', { class: 'mono' }, dirs[0]) : null,
      h('span', { class: 'small muted' }, 'Pastas e scripts dos projetos, cópia entre projetos (Origem ⇄ Destino) e Git de cada repositório (status, commit, pull, push, histórico). A edição dos scripts fica com o VS Code/SSMS.')));
}

// ---------- Cronograma ----------
function milestoneForm(p, m) {
  const title = h('input', { type: 'text', value: m?.title || '', maxlength: 160, placeholder: 'Ex.: Entrega da homologação' });
  const due = h('input', { type: 'date', value: m?.dueDate || '' });
  const alert = h('input', { type: 'number', min: 0, max: 365, value: m?.alertDays ?? '', placeholder: `padrão (${state.settings.warnDays})` });
  const note = h('input', { type: 'text', value: m?.note || '', maxlength: 500 });
  const md = openModal({
    title: m ? 'Editar prazo' : 'Novo prazo / entrega',
    body: [field('O que precisa ser entregue', title), h('div', { class: 'cols2' }, field('Data', due), field('Avisar com quantos dias?', alert, 'Vazio = usa o padrão.')), field('Observação', note)],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { title: title.value, dueDate: due.value, alertDays: alert.value, note: note.value, done: m?.done || false };
        replaceProject(m ? await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, body) : await api('POST', `/api/projects/${p.id}/milestones`, body));
        md.close();
      }) }, 'Salvar')],
  });
  title.focus();
}

function scheduleCard(p) {
  const list = [...p.milestones].sort((a, b) => Number(a.done) - Number(b.done) || a.dueDate.localeCompare(b.dueDate));
  const toState = (m) => {
    if (m.done) return { st: 'done', text: 'Concluído' };
    const days = Math.round((Date.parse(m.dueDate) - Date.parse(state.today)) / 86400000);
    const limit = Number.isInteger(m.alertDays) ? m.alertDays : state.settings.warnDays;
    return { st: days < 0 ? 'overdue' : days <= limit ? 'soon' : 'ok', text: days < 0 || days <= limit ? daysText(days) : `${daysText(days)}` };
  };
  return card('Cronograma', h('button', { class: 'btn sm', onclick: () => milestoneForm(p) }, '+ Prazo'),
    list.length ? list.map((m) => { const t = toState(m); return h('div', { class: 'row' },
      h('input', { type: 'checkbox', checked: m.done, title: 'Marcar como concluído', onchange: async (e) => { try { replaceProject(await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { ...m, done: e.target.checked })); } catch (er) { fail(er); } } }),
      h('div', { class: 'grow' }, h('strong', { style: m.done ? 'text-decoration:line-through;opacity:.6' : '' }, m.title), h('div', { class: 'muted small' }, `${fmtDate(m.dueDate)}${m.note ? ' · ' + m.note : ''}`)),
      pill(t.st, t.text), h('div', { class: 'actions' }, h('button', { class: 'btn sm ghost', onclick: () => milestoneForm(p, m) }, 'Editar'),
        h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog({ title: 'Remover prazo', message: `Remover “${m.title}”?`, okText: 'Remover', danger: true })) { try { replaceProject(await api('DELETE', `/api/projects/${p.id}/milestones/${m.id}`)); } catch (e) { fail(e); } } } }, 'Remover'))); })
      : h('div', { class: 'empty' }, 'Este projeto não tem cronograma — e tudo bem. Adicione prazos apenas se precisar; sem eles, nenhum alerta é gerado.'));
}

// ---------- Bases ----------
function connFields(c, { local }) {
  const server = h('input', { type: 'text', value: c?.server || (local ? 'localhost' : ''), placeholder: local ? 'localhost' : 'servidor ou servidor\\instância' });
  const port = h('input', { type: 'number', value: c?.port || '', placeholder: '1433' });
  const database = h('input', { type: 'text', value: c?.database || '', placeholder: 'Nome do banco' });
  const auth = h('select', null, h('option', { value: 'windows', selected: (c?.auth || 'windows') === 'windows' }, 'Autenticação do Windows'), h('option', { value: 'sql', selected: c?.auth === 'sql' }, 'Login e senha do SQL Server'));
  const user = h('input', { type: 'text', value: c?.user || '', autocomplete: 'off' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: c?.hasPassword ? '•••••• (mantida — digite para trocar)' : '' });
  const encrypt = h('input', { type: 'checkbox', checked: c ? c.encrypt !== false : true });
  const trust = h('input', { type: 'checkbox', checked: c ? c.trustServerCertificate !== false : true });
  const sqlBox = h('div', { class: 'cols2' }, field('Usuário', user), field('Senha', pass, 'Guardada criptografada (DPAPI do Windows, só neste usuário/computador).'));
  const sync = () => { sqlBox.style.display = auth.value === 'sql' ? '' : 'none'; };
  auth.addEventListener('change', sync); sync();
  return {
    els: [h('div', { class: 'cols3' }, field('Servidor', server), field('Porta', port), field('Banco', database)), field('Autenticação', auth), sqlBox,
      h('div', { class: 'cols2' }, h('label', { class: 'check' }, encrypt, 'Criptografar conexão'), h('label', { class: 'check' }, trust, 'Confiar no certificado do servidor'))],
    database,
    get: () => (server.value.trim() ? { server: server.value, port: port.value, database: database.value, auth: auth.value, user: user.value, password: pass.value, encrypt: encrypt.checked, trustServerCertificate: trust.checked } : null),
  };
}

function baseForm(p, b) {
  const name = h('input', { type: 'text', value: b?.name || '', maxlength: 120, placeholder: 'Ex.: Base principal, Base financeiro…' });
  const dir = pathField({ value: b?.directory || '', title: 'Diretório associado a esta base' });
  const prod = connPicker(b?.prod, { local: false });
  const local = connPicker(b?.local || { server: 'localhost', auth: 'windows' }, { local: true });
  const overwrite = h('input', { type: 'checkbox', checked: b?.allowProdOverwrite });
  prod.onDbInput(() => { if (!b?.local && !local.touched()) local.setDb(prod.getDb()); }); // o banco local costuma ter o mesmo nome
  const md = openModal({
    title: b ? 'Editar base de dados' : 'Associar base de dados', wide: true,
    body: [h('div', { class: 'cols2' }, field('Nome', name), field('Diretório da base', dir.el, 'Pasta associada a esta base dentro do projeto.')),
      h('fieldset', null, h('legend', null, 'Produção'), h('div', { class: 'hint' }, 'Base real de clientes. Opcional se você só for usar o Localhost.'), prod.els,
        h('label', { class: 'check' }, overwrite, h('span', null, h('strong', null, 'Permitir sobrescrever tabelas em produção '), h('span', { class: 'hint' }, '(DROP ou renomear). Desligado por padrão: o app só cria tabelas novas em produção.')))),
      h('fieldset', null, h('legend', null, 'Localhost (teste e validação)'), h('div', { class: 'hint' }, 'Sempre valide aqui primeiro. Precisa apontar para este computador.'), local.els)],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { name: name.value, directory: dir.get(), prod: prod.get(), local: local.get(), allowProdOverwrite: overwrite.checked };
        replaceProject(b ? await api('PUT', `/api/projects/${p.id}/bases/${b.id}`, body) : await api('POST', `/api/projects/${p.id}/bases`, body));
        md.close(); toast('Base salva.');
      }) }, 'Salvar')],
  });
  name.focus();
}

const connLine = (c) => (c.missing ? 'conexão cadastrada removida — edite a base' : `${c.connectionName ? `${c.connectionName} · ` : ''}${c.server}${c.port ? ',' + c.port : ''} / ${c.database} · ${c.auth === 'sql' ? `login ${c.user}` : 'Windows'}`);

function basesCard(p) {
  return card('Bases de dados', h('button', { class: 'btn sm', onclick: () => baseForm(p) }, '+ Base'),
  p.bases.length ? p.bases.map((b) => h('div', { class: 'row', style: 'align-items:flex-start' },
    h('div', { class: 'grow stack' }, h('strong', null, b.name),
      dirLine(b.directory, b.directoryExists),
      b.prod ? h('div', { class: 'small' }, pill('prod', 'PRODUÇÃO'), ' ', h('span', { class: 'mono' }, connLine(b.prod))) : null,
      b.local ? h('div', { class: 'small' }, pill('local', 'LOCALHOST'), ' ', h('span', { class: 'mono' }, connLine(b.local))) : null),
    h('div', { class: 'actions' },
      b.local ? h('button', { class: 'btn sm', onclick: (e) => testConn(e.target, p, b, 'local') }, 'Testar local') : null,
      b.prod ? h('button', { class: 'btn sm', onclick: (e) => testConn(e.target, p, b, 'prod') }, 'Testar produção') : null,
      b.directory && b.directoryExists ? h('button', { class: 'btn sm', onclick: () => openFolder(b.directory) }, 'Abrir pasta') : null,
      h('button', { class: 'btn sm ghost', onclick: () => baseForm(p, b) }, 'Editar'),
      h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog({ title: 'Remover base', message: `Remover a associação com “${b.name}”? O banco de dados não é alterado.`, okText: 'Remover', danger: true })) { try { replaceProject(await api('DELETE', `/api/projects/${p.id}/bases/${b.id}`)); } catch (e) { fail(e); } } } }, 'Remover'))))
    : h('div', { class: 'empty' }, 'Nenhuma base associada. Um projeto pode ter quantas bases precisar, cada uma com seu diretório.'));
}

function testConn(btn, p, b, env) {
  return busy(btn, async () => {
    const r = await api('POST', `/api/projects/${p.id}/bases/${b.id}/test`, { env }, { timeoutMs: 45000 });
    if (r.ok) toast(`Conectado: ${r.server} / ${r.database} como ${r.login}`); else toast(`Falha na conexão: ${r.error}`, 'error');
  }, 'Testando…');
}

// ---------- Planilhas do projeto (anexo do .xlsx baixado pelo Google Sheets; nem toda planilha precisa ir para o banco) ----------
function deparaForm(p, d) {
  const label = h('input', { type: 'text', value: d?.label || '', maxlength: 120, placeholder: 'Ex.: DEPARA Clientes, Relatório de acompanhamento…' });
  const url = h('input', { type: 'text', value: d?.url || '', placeholder: 'https://docs.google.com/spreadsheets/d/…' });
  const dir = pathField({ value: d?.targetDir || p.rootDir || '', title: 'Pasta onde o arquivo da planilha fica guardado' });
  const fname = h('input', { type: 'text', value: d?.fileName || '', maxlength: 150, placeholder: 'Vazio = usa o nome acima' });
  const importable = h('input', { type: 'checkbox', checked: d ? d.importable !== false : true });
  // Origem da importação: arquivo único (anexado; comportamento de sempre) ou diretório (lote). Cada modo mostra só os seus campos.
  let mode = d?.importMode === 'dir' ? 'dir' : 'file';
  const srcDir = pathField({ value: d?.sourceDir || '', title: 'Diretório com as planilhas (.xlsx) a importar' });
  const fileFields = h('div', { class: 'stack', style: 'gap:12px' }, field('Link do Google Sheets (opcional)', url, 'Só serve para o atalho “Abrir no Google Sheets”.'),
    field('Pasta onde o arquivo fica guardado', dir.el, 'O .xlsx que você anexar é copiado para esta pasta.'), field('Nome do arquivo (.xlsx)', fname));
  const dirFields = h('div', { class: 'stack', style: 'gap:12px' }, field('Diretório das planilhas', srcDir.el, 'Todas as planilhas .xlsx deste diretório (sem subpastas) aparecem na importação; você escolhe arquivos e abas. Cada aba vira uma tabela própria.'));
  const sync = () => { fileFields.hidden = mode !== 'file'; dirFields.hidden = mode !== 'dir'; };
  const radio = (v, title, sub) => h('label', { class: 'check row', style: 'flex:1;align-items:flex-start' },
    h('input', { type: 'radio', name: 'depara-mode', checked: mode === v, onchange: () => { mode = v; sync(); } }), h('span', null, h('strong', null, title), h('div', { class: 'small muted' }, sub)));
  sync();
  const md = openModal({
    title: d ? 'Editar planilha' : 'Nova planilha',
    body: [field('Nome', label),
      h('div', null, h('div', { class: 'lbl' }, 'Origem da importação'), h('div', { class: 'inline', style: 'align-items:stretch;margin-top:4px' },
        radio('file', 'Arquivo', 'Um .xlsx anexado (baixado do Google Sheets).'), radio('dir', 'Diretório', 'Várias planilhas de uma pasta, em lote.'))),
      fileFields, dirFields,
      h('label', { class: 'check' }, importable, h('span', null, h('strong', null, 'Permitir importar esta planilha para o banco'),
        h('div', { class: 'hint' }, 'Desmarque para planilhas guardadas só como referência (relatórios, controles…), sem o botão “Importar no banco”.')))],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { label: label.value, url: url.value, targetDir: dir.get(), fileName: fname.value, importable: importable.checked, importMode: mode, sourceDir: srcDir.get() };
        replaceProject(d ? await api('PUT', `/api/projects/${p.id}/deparas/${d.id}`, body) : await api('POST', `/api/projects/${p.id}/deparas`, body));
        md.close();
      }) }, 'Salvar')],
  });
  label.focus();
}

// Anexa o .xlsx que o usuário baixou pelo navegador (Sheets → Arquivo → Fazer download → Microsoft Excel).
// Copia o arquivo para a pasta do DE-PARA. Resolve com o resultado, ou null se o usuário cancelar.
async function attachDepara(p, d) {
  const recent = await api('GET', '/api/downloads/recent').catch(() => ({ dir: '', files: [] }));
  const current = () => state.projects.find((x) => x.id === p.id)?.deparas.find((x) => x.id === d.id) || d;
  return new Promise((resolve) => {
    let finished = false; let m;
    const finish = (v) => { if (finished) return; finished = true; m.close(); resolve(v); };
    const attach = async (filePath, overwrite = false) => {
      try {
        const r = await api('POST', `/api/projects/${p.id}/deparas/${d.id}/attach`, { filePath, overwrite });
        replaceProject(r.project);
        toast(`Planilha anexada: ${r.path} (${fmtSize(r.size)})`);
        finish(r);
      } catch (e) {
        if (e.code === 'EXISTS') {
          // Substituir a versão anterior DESTE DE-PARA é o esperado; qualquer outro arquivo de mesmo nome pede confirmação.
          const prev = current().lastDownload?.path;
          const sameFile = prev && e.path && prev.toLowerCase() === e.path.toLowerCase();
          if (sameFile || await confirmDialog({ title: 'Substituir arquivo?', message: `${e.message} Deseja substituí-lo pelo arquivo selecionado?`, okText: 'Substituir arquivo' })) return attach(filePath, true);
          return;
        }
        fail(e);
      }
    };
    const ago = (ms) => { const min = Math.max(0, Math.round((Date.now() - ms) / 60000)); return min < 1 ? 'agora' : min < 60 ? `há ${min} min` : `há ${Math.round(min / 60)} h`; };
    const body = [
      h('ol', { style: 'margin:0;padding-left:20px;display:grid;gap:8px' },
        d.url ? h('li', null, h('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, 'Abra a planilha no Google Sheets'), ' (nova aba)') : null,
        h('li', null, 'No Sheets: ', h('strong', null, 'Arquivo → Fazer download → Microsoft Excel (.xlsx)')),
        h('li', null, 'Volte aqui e selecione o arquivo baixado:')),
      recent.files.length ? h('div', { class: 'stack' }, h('div', { class: 'lbl' }, 'Baixados recentemente (pasta Downloads)'),
        recent.files.map((f) => h('button', { class: 'btn', style: 'text-align:left', onclick: (e) => busy(e.target, () => attach(f.path)) }, `${f.name} — ${ago(f.mtimeMs)} · ${fmtSize(f.size)}`))) : null,
      h('div', null, h('button', { class: `btn${recent.files.length ? '' : ' primary'}`, onclick: async (e) => {
        const btn = e.target; btn.disabled = true;
        // Abre na pasta do DE-PARA configurada; se ela não existir, tenta a do último anexo, a raiz do projeto, o último diretório usado e Downloads.
        try {
          const file = await pickFileIn('depara', { title: 'Selecione a planilha (.xlsx)', filter: 'xlsx', starts: [d.targetDir, dirOf(d.lastDownload?.path), p.rootDirKind === 'drive' ? '' : p.rootDir, recent.dir] });
          if (file) await attach(file);
        } catch (er) { fail(er); } finally { btn.disabled = false; }
      } }, recent.files.length ? 'Escolher outro arquivo…' : 'Escolher arquivo…')),
      h('div', { class: 'hint' }, `O arquivo é copiado para ${d.targetDir || 'a pasta de destino'} como “${d.fileName || d.label}.xlsx”; o original não é alterado.`),
    ];
    m = openModal({ title: 'Anexar planilha', body, footer: [h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar')], onClose: () => { if (!finished) { finished = true; resolve(null); } } });
  });
}

function deparasCard(p) {
  return card('Planilhas do projeto', h('button', { class: 'btn sm', onclick: () => deparaForm(p) }, '+ Planilha'),
    p.deparas.length ? p.deparas.map((d) => {
      const canImport = p.bases.length && d.importable !== false;
      const importTitle = d.importable === false ? 'Esta planilha não está marcada para importação. Habilite em “Editar”.' : !p.bases.length ? 'Associe uma base de dados ao projeto primeiro' : '';
      return h('div', { class: 'row', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack' }, h('div', { class: 'inline' }, h('strong', null, d.label), d.importable === false ? h('span', { class: 'pill', title: 'Guardada só como referência' }, 'não importável') : null,
          d.importMode === 'dir' ? h('span', { class: 'pill', title: 'Várias planilhas de um diretório, em lote' }, 'por diretório') : null),
        d.url && d.importMode !== 'dir' ? h('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Abrir no Google Sheets') : null,
        d.importMode === 'dir'
          ? h('div', { class: 'small' }, 'Diretório: ', h('span', { class: 'mono' }, d.sourceDir || '—'), d.sourceDirExists === false ? h('span', { class: 'pill overdue', style: 'margin-left:6px' }, 'não encontrado') : null)
          : h('div', { class: 'small muted' }, 'Pasta: ', h('span', { class: 'mono' }, d.targetDir || '—')),
        d.importMode === 'dir' ? null : d.lastDownload ? h('div', { class: 'small' }, `Anexada em ${fmtDateTime(d.lastDownload.at)} · ${fmtSize(d.lastDownload.size)} · `, d.fileExists ? h('span', { class: 'mono' }, d.lastDownload.path) : h('span', { class: 'pill overdue' }, 'arquivo não encontrado'))
          : h('div', { class: 'small muted' }, 'Nenhum arquivo anexado ainda.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn sm primary', disabled: !canImport, title: importTitle, onclick: () => openImportWizard(p, { deparaId: d.id }) }, d.importMode === 'dir' ? 'Importar lote no banco…' : 'Importar no banco…'),
        d.importMode === 'dir' ? (d.sourceDirExists ? h('button', { class: 'btn sm', onclick: () => openFolder(d.sourceDir) }, 'Abrir pasta') : null)
          : [h('button', { class: 'btn sm', title: 'Selecione o .xlsx baixado pelo Google Sheets', onclick: () => attachDepara(p, d) }, d.fileExists ? 'Anexar nova versão…' : 'Anexar arquivo…'),
            d.fileExists ? h('button', { class: 'btn sm', onclick: () => openFolder(d.lastDownload.path.replace(/[\\/][^\\/]*$/, '')) }, 'Abrir pasta') : null],
        h('button', { class: 'btn sm ghost', onclick: () => deparaForm(p, d) }, 'Editar'),
        h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog({ title: 'Remover planilha', message: `Remover “${d.label}” do projeto? O arquivo anexado não é apagado.`, okText: 'Remover', danger: true })) { try { replaceProject(await api('DELETE', `/api/projects/${p.id}/deparas/${d.id}`)); } catch (e) { fail(e); } } } }, 'Remover')));
    })
      : h('div', { class: 'empty' }, 'Nenhuma planilha cadastrada. Anexe planilhas do projeto aqui — só as marcadas como importáveis mostram o botão “Importar no banco”.'));
}

// ---------- Auditoria ----------
const ACTION_LABEL = { 'email-modelo-criado': 'E-mail: modelo criado', 'email-modelo-editado': 'E-mail: modelo alterado', 'email-modelo-desativado': 'E-mail: modelo desativado', 'email-modelo-reativado': 'E-mail: modelo reativado', 'email-modelo-excluido': 'E-mail: modelo excluído', 'email-modelos-do-projeto': 'E-mail: modelos do projeto alterados', 'email-gerado': 'E-mail gerado (prévia; nada enviado)', 'email-copiado': 'E-mail: conteúdo copiado', 'email-preparado': 'E-mail: preparado (versão anterior)', 'email-enviado': 'E-mail enviado (versão anterior)', 'email-falhou': 'E-mail: falha no envio (versão anterior)', 'gmail-credenciais-removidas': 'Credenciais do Gmail removidas', 'contato-criado': 'Contato do projeto criado', 'contato-editado': 'Contato do projeto alterado', 'contato-removido': 'Contato do projeto removido', 'gmail-configurado': 'Gmail: credenciais salvas', 'gmail-conectado': 'Gmail: conta conectada', 'gmail-desconectado': 'Gmail: conta desconectada', 'gmail-diagnostico': 'Gmail: diagnóstico de envio (nada enviado)', 'gmail-falha': 'Gmail: falha ao conectar', 'checklist-observacao': 'Checklist: observação do item', 'checklist-pendencia-restaurada': 'Checklist: pendência restaurada', 'checklist-bloqueado-dependencia': 'Checklist: conclusão bloqueada por dependência', 'checklist-pendencia-transferida': 'Checklist: pendência transferida', 'observacao-criada': 'Observação do dia criada', 'observacao-editada': 'Observação do dia editada', 'observacao-excluida': 'Observação do dia excluída', 'observacao-evidencia-adicionada': 'Observação: evidência adicionada', 'observacao-evidencia-removida': 'Observação: evidência removida',
  'lote-plano-gerado': 'Importação em lote: plano gerado', 'lote-iniciado': 'Importação em lote iniciada', 'lote-item-importado': 'Lote: aba importada', 'lote-item-simulado': 'Lote: aba simulada (desfeita)', 'lote-item-falhou': 'Lote: aba falhou (desfeita)',
  'lote-concluido': 'Importação em lote concluída', 'lote-concluido-com-falhas': 'Importação em lote concluída com falhas', 'lote-scripts-executados': 'Lote: scripts pós-importação executados', 'lote-scripts-falharam': 'Lote: scripts pós-importação falharam',
  'plano-gerado': 'Plano gerado', 'execucao-iniciada': 'Execução iniciada', 'importacao-concluida': 'Importação concluída', 'simulacao-concluida': 'Simulação (desfeita)', 'importacao-falhou': 'Falhou (rollback)', 'depara-anexado': 'Planilha anexada', 'download-depara': 'Download DE-PARA (antigo)', 'conexao-testada': 'Conexão testada',
  'checklist-iniciado': 'Checklist iniciado', 'checklist-marcado': 'Checklist: item marcado', 'checklist-desmarcado': 'Checklist: item desmarcado', 'checklist-sincronizado': 'Checklist sincronizado com o modelo',
  'checklist-modelo-alterado': 'Modelo de checklist alterado', 'evidencia-adicionada': 'Evidência adicionada', 'evidencia-removida': 'Evidência removida', 'evidencia-config': 'Configuração de evidências',
  'etapa-concluida': 'Etapa concluída', 'avanco-bloqueado': 'Avanço bloqueado pelo checklist',
  'horas-iniciada': 'Horas: atividade iniciada', 'horas-pausada': 'Horas: atividade pausada', 'horas-retomada': 'Horas: atividade retomada', 'horas-confirmada': 'Horas: apontamento confirmado',
  'horas-criada': 'Horas: apontamento manual', 'horas-editada': 'Horas: apontamento editado', 'horas-excluida': 'Horas: apontamento excluído', 'horas-descartada': 'Horas: atividade descartada',
  'horas-exportada': 'Horas: planilha exportada', 'horas-config': 'Horas: jornada alterada',
  'ciclo-alterado': 'Ciclo alterado', 'ciclo-aplicado': 'Ciclo aplicado ao projeto', 'conexao-cadastrada': 'Conexão cadastrada', 'conexao-alterada': 'Conexão alterada', 'conexao-excluida': 'Conexão excluída',
  'script-executado': 'Script executado (checklist)', 'script-falhou': 'Script com erro (checklist)', 'gitignore-salvo': '.gitignore salvo' };
// Tipo e situação de cada ação (só para agrupar, filtrar e colorir; o registro em si não muda).
const AUDIT_TYPES = [
  ['import', 'Importação', /^(plano-gerado|execucao-iniciada|importacao-|simulacao-|lote-|depara-|download-depara)/],
  ['script', 'Scripts SQL', /^script-/],
  ['checklist', 'Checklist e etapas', /^(checklist-|evidencia-|etapa-|avanco-)/],
  ['hours', 'Horas', /^(horas-|observacao-)/],
  ['comms', 'Comunicações', /^(email-|contato-|gmail-)/],
  ['config', 'Configuração e conexões', /^(ciclo-|conexao-|gitignore-)/],
];
const auditType = (a) => AUDIT_TYPES.find(([, , re]) => re.test(a.action || ''))?.[0] || 'other';
function auditStatus(a) {
  const act = a.action || '';
  if (a.erro || /falhou|falharam|falha$|com-falhas/.test(act) || a.ok === false) return /com-falhas/.test(act) ? 'warn' : 'error';
  if (/bloqueado|bloqueio/.test(act) || (a.bloqueios || 0) > 0) return 'warn';
  if (/iniciad[ao]$|-iniciado$/.test(act)) return 'running';
  if (/concluid|executad|importad|simulad|ok$|anexado|confirmada/.test(act) || a.ok === true) return 'ok';
  return 'info';
}
const AUDIT_STATUS = { ok: ['✓', 'Sucesso'], error: ['✕', 'Erro'], warn: ['!', 'Aviso'], running: ['◐', 'Iniciado'], info: ['•', 'Registro'] };
// Uma linha de resumo (o detalhe completo fica no "Ver detalhes").
function auditSummary(a) {
  if (a.erro) return String(a.erro).split('\n')[0].slice(0, 220);
  if (a.detalhe) return `${a.etapa ? `${a.etapa}: ` : ''}${a.detalhe}${a.resultado ? ` — ${a.resultado}` : ''}`;
  if (a.tabelas?.length) return `${plural(a.tabelas.length, 'tabela', 'tabelas')}: ${a.tabelas.slice(0, 4).map((t) => `${t.tabela}${t.linhas != null ? ` (${Number(t.linhas).toLocaleString('pt-BR')})` : ''}`).join(', ')}${a.tabelas.length > 4 ? '…' : ''}`;
  return [a.resultado, a.arquivo, a.item].filter(Boolean).join(' · ');
}
const AUDIT_FIELD = { project: 'Projeto', base: 'Base', env: 'Ambiente', server: 'Servidor', database: 'Banco', login: 'Login', by: 'Usuário', etapa: 'Etapa', item: 'Item', detalhe: 'Detalhe', arquivo: 'Arquivo', resultado: 'Resultado', hash: 'Hash do plano', dryRun: 'Simulação', bloqueios: 'Bloqueios', erro: 'Erro' };
function auditDetails(a) {
  const skip = new Set(['at', 'action', 'tabelas', 'scripts', 'erro']);
  const kv = Object.entries(a).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object');
  return h('div', { class: 'au-details' },
    a.erro ? h('pre', { class: 'code au-err' }, String(a.erro)) : null,
    kv.length ? h('dl', { class: 'au-kv' }, kv.map(([k, v]) => [h('dt', null, AUDIT_FIELD[k] || k), h('dd', { class: /hash|server|database/.test(k) ? 'mono' : '' }, v === true ? 'sim' : v === false ? 'não' : String(v))])) : null,
    a.tabelas?.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Tabelas'), a.tabelas.map((t) => h('div', { class: 'small mono' }, `${t.tabela}${t.modo ? ` · ${t.modo}` : ''}${t.linhas != null ? ` · ${Number(t.linhas).toLocaleString('pt-BR')} linhas` : ''}${t.arquivo ? ` · ${t.arquivo}${t.aba ? ` / ${t.aba}` : ''}` : ''}`))) : null,
    a.scripts?.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Scripts'), a.scripts.map((x) => h('div', { class: 'small' }, `${x.nome}${x.arquivo ? ` (${x.arquivo})` : ''}${x.lotes ? ` · ${plural(x.lotes, 'lote', 'lotes')}` : ''}`))) : null);
}

async function renderAudit(main) {
  const page = h('div', { class: 'page audit-page' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Auditoria de execuções'),
    h('div', { class: 'muted' }, 'Tudo o que o app fez com bancos, planilhas, scripts, checklists e horas, do mais recente para o mais antigo. Não guarda senhas, SQL nem dados das células.'))));
  main.append(page);
  let list;
  try { list = await api('GET', '/api/audit?limit=2000'); } catch (e) { return fail(e); }
  const f = { period: '30', project: '', type: '', status: '' }; let shown = 120;
  const projects = [...new Set(list.map((a) => a.project).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  const sel = (key, opts, label) => h('label', { class: 'au-filter' }, h('span', { class: 'lbl' }, label),
    h('select', { onchange: (e) => { f[key] = e.target.value; shown = 120; draw(); } }, opts.map(([v, t]) => h('option', { value: v, selected: f[key] === v }, t))));
  const filters = h('div', { class: 'au-filters' },
    sel('period', [['1', 'Hoje'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['', 'Tudo (até 2000 registros)']], 'Período'),
    sel('project', [['', 'Todos'], ...projects.map((p) => [p, p])], 'Projeto'),
    sel('type', [['', 'Todos'], ...AUDIT_TYPES.map(([k, t]) => [k, t]), ['other', 'Outros']], 'Tipo'),
    sel('status', [['', 'Todas'], ['ok', 'Sucesso'], ['error', 'Erro'], ['warn', 'Aviso'], ['running', 'Iniciado'], ['info', 'Registro']], 'Situação'));
  const count = h('div', { class: 'small muted' });
  const timeline = h('div', { class: 'au-timeline' });
  page.append(h('div', { class: 'card' }, h('div', { class: 'card-body' }, filters, count, timeline)));
  const dayKey = (iso) => String(iso || '').slice(0, 10);
  const today = new Date(); const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayLabel = (k) => { const y = new Date(today); y.setDate(y.getDate() - 1); return k === iso(today) ? 'Hoje' : k === iso(y) ? 'Ontem' : fmtDate(k); };
  function draw() {
    const since = f.period ? Date.now() - Number(f.period) * 86400000 : 0;
    const rows = list.filter((a) => (!since || Date.parse(a.at) >= (f.period === '1' ? new Date(iso(today)).getTime() : since))
      && (!f.project || a.project === f.project) && (!f.type || auditType(a) === f.type) && (!f.status || auditStatus(a) === f.status));
    count.textContent = `${plural(rows.length, 'registro', 'registros')}${rows.length > shown ? ` · mostrando ${shown}` : ''}`;
    const out = []; let lastDay = null;
    for (const a of rows.slice(0, shown)) {
      const k = dayKey(a.at);
      if (k !== lastDay) { out.push(h('div', { class: 'au-day' }, dayLabel(k))); lastDay = k; }
      const s = auditStatus(a); const [ic, sl] = AUDIT_STATUS[s];
      const det = h('div', { class: 'au-detwrap', hidden: true });
      const more = h('button', { class: 'btn xs ghost', 'aria-expanded': 'false', onclick: () => { const o = det.hidden; det.hidden = !o; if (o && !det.firstChild) det.append(auditDetails(a)); more.setAttribute('aria-expanded', String(o)); more.textContent = o ? 'Ocultar detalhes' : 'Ver detalhes'; } }, 'Ver detalhes');
      const sum = auditSummary(a);
      out.push(h('div', { class: `au-entry au-${s}` },
        h('span', { class: 'au-ic', title: sl, 'aria-label': sl }, ic),
        h('div', { class: 'au-main' },
          h('div', { class: 'au-line1' }, h('span', { class: 'au-time' }, new Date(a.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })),
            h('strong', { class: 'au-act' }, ACTION_LABEL[a.action] || a.action),
            a.env ? pill(a.env === 'prod' ? 'prod' : 'local', a.env === 'prod' ? 'PRODUÇÃO' : 'LOCAL') : null,
            a.dryRun ? h('span', { class: 'pill' }, 'simulação') : null),
          h('div', { class: 'au-line2' }, [a.project, a.base].filter(Boolean).length ? h('span', null, [a.project, a.base].filter(Boolean).join(' / ')) : null,
            a.database ? h('span', { class: 'mono' }, `${a.server || ''} / ${a.database}`) : null, a.by ? h('span', null, a.by) : null),
          sum ? h('div', { class: `au-sum${s === 'error' ? ' err' : ''}`, title: sum }, sum) : null,
          det),
        h('div', { class: 'au-actions' }, more)));
    }
    if (rows.length > shown) out.push(h('div', { class: 'au-more' }, h('button', { class: 'btn sm', onclick: () => { shown += 200; draw(); } }, `Mostrar mais (${rows.length - shown})`)));
    timeline.replaceChildren(...(out.length ? out : [h('div', { class: 'empty' }, list.length ? 'Nenhum registro com esses filtros.' : 'Nada registrado ainda.')]));
  }
  draw();
}

// Só depois de TODOS os scripts (cycle.js, config.js, docs.js, import.js) terem carregado.
// Modo nuvem: primeiro a sessão (auth.js decide entre a tela de acesso e o app); modo local: direto para o app.
window.addEventListener('DOMContentLoaded', () => { renderThemeToggle(); authBoot().catch(fail); });
