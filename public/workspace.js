'use strict';
// Workspace: central de gerenciamento dos projetos de uma pasta raiz (ex.: C:\Projetos). Não edita código — a edição
// fica com VS Code/SSMS. Aqui: ver projetos e pastas, copiar/mover/clonar scripts ENTRE projetos (painéis Origem ⇄
// Destino), buscar arquivos e trabalhar com o Git de cada projeto (workspace-git.js, workspace-history.js).
// Rota: #/workspace. Tudo atua nos arquivos reais; o servidor valida cada caminho dentro da pasta raiz.
// Layout (preferência `layout`): "Um painel" (padrão: explorador de um projeto + barra de seleção com Copiar/Mover/
// Clonar para…) ou "Lado a lado" (painéis Origem ⇄ Destino com as ações no meio). O painel Git embaixo é recolhível.

let WM = null; // estado da tela
const other = (side) => (side === 'L' ? 'R' : 'L');
const SIDE_LABEL = { L: 'Origem', R: 'Destino' };
const baseName = (p) => String(p || '').split('/').pop();
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
// replaceChildren() transforma null em texto "null"; aqui null/false/listas são tratados como no h().
const setKids = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const wmApi = (method, sub, body) => api(method, `/api/wsm${sub}`, body);
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ---------- Preferências de tela (neste computador, como o tema) ----------
const WM_PREFS_KEY = 'gp-wm-prefs';
const WM_DEFAULTS = { navCollapsed: false, all: false, panelH: 300, listW: 260, layout: 'single', gitOpen: true };
const WM_PREFS = (() => { try { return { ...WM_DEFAULTS, ...JSON.parse(localStorage.getItem(WM_PREFS_KEY) || '{}') }; } catch { return { ...WM_DEFAULTS }; } })();
function setWmPref(k, v) {
  WM_PREFS[k] = v;
  try { localStorage.setItem(WM_PREFS_KEY, JSON.stringify(WM_PREFS)); } catch { /* sem armazenamento: vale só nesta sessão */ }
}
const isDual = () => WM_PREFS.layout === 'dual';
// Barra lateral recolhida: vale em TODAS as telas. Quem já escolheu (« / » / ☰ / Ctrl+Alt+B) mantém a escolha; sem escolha, ela só
// começa recolhida no Workspace em janelas estreitas (< 1400 px), para dar espaço aos painéis.
const navIsCollapsed = () => (WM_PREFS.navUser ? WM_PREFS.navUser === 'closed' : route().name === 'workspace' && (WM_PREFS.navCollapsed || window.innerWidth < 1400));
function applyNavPref() { document.body.classList.toggle('nav-collapsed', navIsCollapsed()); }
// Tamanho no Workspace: bytes para arquivos pequenos (scripts costumam ter poucos KB; ajuda a comparar conflitos).
const wmSize = (n) => (n < 1024 ? `${n} B` : fmtSize(n));
const toggleNav = () => { const now = navIsCollapsed(); setWmPref('navCollapsed', !now); setWmPref('navUser', now ? 'open' : 'closed'); applyNavPref(); };
// Barra de projetos do app no Workspace: trilho para reabrir, divisória de largura (lembrada) e Ctrl+Alt+B.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('navRailOpen')?.addEventListener('click', toggleNav);
  document.getElementById('navCollapse')?.addEventListener('click', toggleNav);
  applyNavPref();
  const split = document.getElementById('navSplit');
  const root = document.documentElement;
  try { const w = Number(localStorage.getItem('gp-nav-w')); if (w) root.style.setProperty('--nav-w', `${w}px`); } catch { /* padrão */ }
  split?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX; const startW = split.parentElement.offsetWidth;
    let last = startW;
    const move = (ev) => { last = Math.round(Math.min(480, Math.max(180, startW + ev.clientX - startX))); root.style.setProperty('--nav-w', `${last}px`); };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('ws-colresizing');
      try { localStorage.setItem('gp-nav-w', String(last)); } catch { /* ignora */ }
    };
    document.body.classList.add('ws-colresizing');
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleNav(); }
});

// ---------- Utilidades de interface ----------
function promptDialog({ title, label, value = '', okText = 'OK', hint }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value });
    const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const m = openModal({ title, body: [field(label, input, hint)], onClose: () => finish(null),
      footer: [h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => finish(input.value.trim()) }, okText)] });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}
// Várias opções (ex.: Substituir / Manter ambos / Cancelar). Resolve com a chave escolhida (ou 'cancel').
function choiceDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const m = openModal({ title, body: [h('p', { style: 'margin:0;white-space:pre-line' }, message)], onClose: () => finish('cancel'),
      footer: choices.map((c) => h('button', { class: `btn ${c.kind || ''}`, onclick: () => finish(c.key) }, c.label)) });
  });
}
// Menu de contexto simples (clique direito).
function contextMenu(x, y, items) {
  document.querySelector('.ws-menu')?.remove();
  const menu = h('div', { class: 'ws-menu', role: 'menu', style: `left:${x}px;top:${y}px` },
    items.filter(Boolean).map((it) => (it === '-' ? h('div', { class: 'sep' }) : h('button', { class: it.danger ? 'danger' : '', disabled: it.disabled, title: it.title || null, onclick: () => { menu.remove(); it.run(); } }, it.label))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(4, y - r.height)}px`;
  if (r.right > window.innerWidth) menu.style.left = `${Math.max(4, x - r.width)}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', off); } }), 0);
}
const fmtWhenShort = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
// Estado vazio padrão do Workspace: ícone, título, explicação e (opcional) uma ação.
const wmEmpty = (ic, title, text, action) => h('div', { class: 'wm-empty' }, h('span', { class: 'wm-empty-ic' }, icon(ic, 22)), h('strong', null, title), text ? h('div', { class: 'muted small' }, text) : null, action || null);
// Botão só com ícone (sempre com title + aria-label).
const wmIconBtn = (ic, title, onclick, { disabled = false, cls = '' } = {}) => h('button', { class: `ws-ibtn ${cls}`, title, 'aria-label': title, disabled, onclick }, icon(ic, 15));

// Atalhos na árvore (fora de campos de texto e de janelas): Del = Lixeira, F2 = renomear, Esc = limpar seleção.
document.addEventListener('keydown', (e) => {
  if (!WM?.refs || route().name !== 'workspace' || WM.view !== 'panes' || document.querySelector('.overlay')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const side = WM.lastSide && (WM.lastSide === 'L' || isDual()) ? WM.lastSide : 'L';
  const pane = WM.panes[side];
  if (!pane?.project || !pane.sel.size) return;
  const items = topLevel([...pane.sel]);
  if (e.key === 'Delete') { e.preventDefault(); deleteEntries(items, side); }
  else if (e.key === 'Escape') { pane.sel.clear(); renderPane(side); renderMid(); }
  else if (e.key === 'F2' && items.length === 1) {
    e.preventDefault();
    const l = pane.listings.get(parentOf(items[0]));
    const d = l?.dirs.find((x) => x.path === items[0]);
    const f = l?.files.find((x) => x.path === items[0]);
    if (d || f) renameEntry({ ...(d || f), type: d ? 'dir' : 'file' }, side);
  }
});

// ---------- Estado / carregamento ----------
function newPane(project = null) { return { project, expanded: new Set(), listings: new Map(), sel: new Set(), focus: project, anchor: null, loading: false }; }

async function renderWorkspace(main) {
  if (WM?.el) { // volta para a tela: reaproveita (árvores abertas, seleção)
    main.append(WM.el);
    // Veio de "Abrir no Workspace": relê a lista (a ligação com o projeto do app pode ser nova) e foca a pasta dele.
    if (WM_FOCUS_APP_PROJECT && WM.info?.rootExists) await loadProjects({ withGit: false });
    return;
  }
  WM = { el: h('div', { class: 'wm' }, h('div', { class: 'ws-note' }, 'Carregando o Workspace…')), info: null, projects: [], view: 'panes', gitSide: 'L', gitTab: 'changes',
    panes: { L: newPane(), R: newPane() }, git: new Map(), search: { q: '', results: null, loading: false }, summariesAt: 0 };
  main.append(WM.el);
  try { WM.info = await wmApi('GET', ''); } catch (e) { setKids(WM.el, h('div', { class: 'box bad' }, e.message)); return; }
  buildLayout();
  if (!WM.info.root || !WM.info.rootExists) { renderAll(); workspaceSettings(true); return; }
  await loadProjects();
}
function focusProjectFromApp(p) { // botão "Abrir no Workspace" da página do projeto
  WM_FOCUS_APP_PROJECT = p.id;
  location.hash = '#/workspace';
}
let WM_FOCUS_APP_PROJECT = null;

async function loadProjects({ withGit = true } = {}) {
  try {
    const r = await wmApi('GET', '/projects');
    mergeProjects(r.projects);
  } catch (e) { WM.projectsError = e.message; WM.projects = []; }
  const L = WM.panes.L; const R = WM.panes.R;
  if (WM_FOCUS_APP_PROJECT) { // veio da página de um projeto do app: abre a pasta ligada a ele na Origem
    const hit = WM.projects.find((p) => p.appProjects?.some((a) => a.id === WM_FOCUS_APP_PROJECT));
    WM_FOCUS_APP_PROJECT = null;
    if (hit) {
      const prevL = L.project;
      setPaneProject('L', hit.path); WM.view = 'panes';
      if (R.project === hit.path && prevL && prevL !== hit.path) setPaneProject('R', prevL); // não deixa os dois lados iguais
    } else toast('Nenhuma pasta do Workspace está ligada a este projeto (pasta raiz, diretório de base ou repositório).', 'warn');
  }
  if (!WM.panes.L.project && WM.projects[0]) setPaneProject('L', WM.projects[0].path);
  const otherProj = WM.projects.find((p) => p.path !== WM.panes.L.project);
  if (!WM.panes.R.project && otherProj) setPaneProject('R', otherProj.path);
  renderAll();
  if (withGit) refreshSummaries();
}
function mergeProjects(list) {
  const old = new Map(WM.projects.map((p) => [p.path, p]));
  WM.projects = list.map((p) => ({ ...p, summary: p.summary !== undefined ? p.summary : old.get(p.path)?.summary }));
}
async function refreshSummaries() {
  WM.summariesLoading = true; renderProjectsList(); if (WM.view === 'dashboard') renderCenter();
  try { const r = await wmApi('GET', '/projects?git=1'); mergeProjects(r.projects); WM.summariesAt = Date.now(); } catch (e) { toast(e.message, 'error'); }
  WM.summariesLoading = false;
  renderProjectsList(); renderPaneHeaders(); if (WM.view === 'dashboard') renderCenter();
}
async function refreshSummary(projectPath) {
  const p = WM.projects.find((x) => x.path === projectPath);
  if (!p || !p.git) return;
  try { p.summary = await wmApi('GET', `/git/summary?${qs({ project: projectPath })}`); } catch { /* fica o anterior */ }
  renderProjectsList(); renderPaneHeaders(); if (WM.view === 'dashboard') renderCenter();
}
const projectByPath = (path) => WM.projects.find((p) => p.path === path) || null;
const projectOfPath = (rel) => WM.projects.filter((p) => rel === p.path || rel.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0] || null;
const displayName = (p) => (p ? p.alias || p.name : '');

// Situação Git curta de um projeto (lista e painel): ✓ / ↑2 / ↓1 / ●4 / local / sem Git
function syncBadge(p, { long = false } = {}) {
  if (!p?.git) return h('span', { class: 'wm-badge none', title: 'Pasta sem repositório Git' }, long ? 'sem Git' : '—');
  const s = p.summary;
  if (s === undefined) return h('span', { class: 'wm-badge none' }, '…');
  if (!s || s.error) return h('span', { class: 'wm-badge bad', title: s?.error || '' }, 'erro');
  const parts = [];
  if (s.conflicts) parts.push(h('span', { class: 'wm-badge bad', title: 'Arquivos em conflito' }, `! ${s.conflicts}`));
  if (s.changes) parts.push(h('span', { class: 'wm-badge warn', title: `${plural(s.changes, 'arquivo alterado', 'arquivos alterados')} sem commit` }, `● ${s.changes}`));
  if (s.ahead) parts.push(h('span', { class: 'wm-badge warn', title: `${plural(s.ahead, 'commit', 'commits')} aguardando Push` }, `↑ ${s.ahead}`));
  if (s.behind) parts.push(h('span', { class: 'wm-badge pull', title: `${plural(s.behind, 'commit', 'commits')} aguardando Pull` }, `↓ ${s.behind}`));
  if (!s.remote) parts.push(h('span', { class: 'wm-badge none', title: 'Repositório só local (sem remote)' }, 'local'));
  else if (!s.upstream && s.branch) parts.push(h('span', { class: 'wm-badge none', title: 'Branch ainda não publicada no remoto' }, 'não publicada'));
  if (!parts.length) parts.push(h('span', { class: 'wm-badge ok', title: `Sincronizado com ${s.upstream}` }, long ? '✓ sincronizado' : '✓'));
  return h('span', { class: 'wm-badges' }, parts);
}

// ---------- Layout ----------
function buildLayout() {
  WM.refs = {};
  const R = WM.refs;
  R.rootText = h('span', { class: 'mono' });
  R.rootLabel = h('button', { class: 'wm-rootchip', title: 'Pasta raiz do Workspace — clique para abrir no Explorer', onclick: () => openExternal('', 'explorer') }, icon('folder', 14), R.rootText);
  R.search = h('input', { type: 'search', placeholder: 'Buscar arquivos (nome ou caminho)…', 'aria-label': 'Buscar arquivos no Workspace', value: WM.search.q,
    onkeydown: (e) => { if (e.key === 'Enter') runSearch(R.search.value); if (e.key === 'Escape') { R.search.value = ''; setView('panes'); } } });
  R.viewBtns = h('div', { class: 'wm-seg', role: 'group', 'aria-label': 'Visão' });
  R.layoutBtns = h('div', { class: 'wm-seg wm-layout', role: 'group', 'aria-label': 'Layout dos arquivos' });
  R.fileBtns = h('div', { class: 'wm-seg sm', role: 'group', 'aria-label': 'Tipos de arquivo mostrados' });
  R.toolbar = h('div', { class: 'wm-toolbar' },
    wmIconBtn('sidebar', 'Mostrar/ocultar a barra lateral do app (Ctrl+Alt+B)', toggleNav),
    h('div', { class: 'wm-title' }, h('strong', null, icon('workspace', 17), 'Workspace'), R.rootLabel,
      wmIconBtn('settings', 'Trocar a pasta raiz do Workspace', () => workspaceSettings())),
    h('span', { class: 'wm-tsep' }), R.viewBtns, R.layoutBtns,
    h('span', { class: 'spacer' }),
    h('div', { class: 'wm-searchbox' }, icon('search', 15), R.search), R.fileBtns,
    h('button', { class: 'btn sm', title: 'Atualizar projetos, pastas e Git', onclick: () => refreshEverything() }, icon('refresh', 14), 'Atualizar'));
  R.projHead = h('div', { class: 'wm-projhead' });
  R.projFilter = h('input', { type: 'search', placeholder: 'Filtrar projetos…', 'aria-label': 'Filtrar a lista de projetos', value: WM.projFilter || '',
    oninput: (e) => { WM.projFilter = e.target.value; renderProjectsList(); }, onkeydown: (e) => { if (e.key === 'Escape') { e.target.value = ''; WM.projFilter = ''; renderProjectsList(); } } });
  R.projFilterWrap = h('div', { class: 'wm-projfilter' }, icon('search', 14), R.projFilter);
  R.projList = h('div', { class: 'wm-projlist' });
  R.projects = h('aside', { class: 'wm-projects', 'aria-label': 'Projetos do Workspace' }, R.projHead, R.projFilterWrap, R.projList);
  R.listSplit = h('div', { class: 'wm-vsplit', title: 'Arraste para mudar a largura da lista de projetos (duplo clique: padrão)', role: 'separator', 'aria-orientation': 'vertical' });
  R.center = h('section', { class: 'wm-center' });
  R.gitPanel = h('section', { class: 'wm-git', 'aria-label': 'Git do projeto' });
  R.splitter = h('div', { class: 'wm-splitter', title: 'Arraste para redimensionar o painel Git', role: 'separator', 'aria-orientation': 'horizontal' });
  R.mainArea = h('div', { class: 'wm-main' }, R.center, R.splitter, R.gitPanel);
  R.body = h('div', { class: 'wm-body' }, R.projects, R.listSplit, R.mainArea);
  setKids(WM.el, R.toolbar, R.body);
  R.body.style.setProperty('--wm-list-w', `${WM_PREFS.listW}px`);
  applyGitOpen();
  setupSplitter();
  setupListSplitter();
}
// Painel Git aberto (altura lembrada) ou recolhido (só o cabeçalho).
function applyGitOpen() {
  const R = WM.refs;
  const open = WM_PREFS.gitOpen !== false;
  R.mainArea.classList.toggle('git-closed', !open);
  R.gitPanel.style.height = open ? `${WM_PREFS.panelH}px` : '';
}
function setGitOpen(open) { setWmPref('gitOpen', open); applyGitOpen(); renderGitPanel(); }
// "Um painel" × "Lado a lado". Ao voltar para um painel, o Git passa a ser o do projeto aberto.
function setLayout(layout) {
  setWmPref('layout', layout);
  if (layout === 'single') { WM.gitSide = 'L'; WM.gitProject = null; WM.lastSide = 'L'; }
  else if (!WM.panes.R.project) { const o = WM.projects.find((p) => p.path !== WM.panes.L.project); if (o) setPaneProject('R', o.path); }
  WM.view = 'panes';
  renderAll();
}
// Abre um projeto num lado; abrir no Destino liga o modo "Lado a lado".
function openProject(path, side = 'L') {
  if (side === 'R' && !isDual()) setWmPref('layout', 'dual');
  setPaneProject(side, path);
  WM.view = 'panes';
  renderAll();
}
function setupListSplitter() {
  const R = WM.refs;
  R.listSplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX; const startW = R.projects.offsetWidth;
    const max = () => Math.min(520, Math.max(240, R.body.clientWidth - 560)); // deixa sempre espaço para os dois painéis
    let w = startW;
    const move = (ev) => { w = Math.round(Math.min(max(), Math.max(190, startW + ev.clientX - startX))); R.body.style.setProperty('--wm-list-w', `${w}px`); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('ws-colresizing'); setWmPref('listW', w); };
    document.body.classList.add('ws-colresizing');
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  R.listSplit.addEventListener('dblclick', () => { setWmPref('listW', 260); R.body.style.setProperty('--wm-list-w', '260px'); }); // duplo clique: largura padrão
}
function setupSplitter() {
  const R = WM.refs;
  R.splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY; const startH = R.gitPanel.offsetHeight;
    const max = () => Math.max(160, R.gitPanel.parentElement.clientHeight - 140);
    const move = (ev) => { R.gitPanel.style.height = `${Math.min(max(), Math.max(90, startH - (ev.clientY - startY)))}px`; };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('ws-resizing'); setWmPref('panelH', R.gitPanel.offsetHeight); };
    document.body.classList.add('ws-resizing');
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
}
function renderAll() {
  if (!WM?.refs) return;
  const R = WM.refs;
  // Chip mostra só o nome da pasta raiz (o caminho inteiro fica na dica): ocupa pouco e é o que identifica o Workspace.
  R.rootText.textContent = WM.info.root ? String(WM.info.root).split(/[\\/]/).filter(Boolean).pop() : '(pasta raiz não configurada)';
  R.rootLabel.title = WM.info.root ? `${WM.info.root}\nClique para abrir no Explorer` : 'Pasta raiz não configurada';
  const seg = (active, ic, label, title, onclick, extra) => h('button', { class: active ? 'active' : '', 'aria-pressed': String(active), 'aria-label': label, title, onclick }, icon(ic, 14), h('span', { class: 'wm-lbl' }, label), extra || null);
  setKids(R.viewBtns, seg(WM.view === 'panes', 'folder', 'Arquivos', 'Navegar pelos arquivos dos projetos', () => setView('panes')),
    seg(WM.view === 'dashboard', 'grid', 'Repositórios', 'Visão geral de todos os projetos e do Git', () => setView('dashboard')),
    WM.search.results ? seg(WM.view === 'search', 'search', 'Busca', 'Resultados da última busca', () => setView('search'), h('span', { class: 'wm-n' }, String(WM.search.results.length))) : null);
  R.layoutBtns.hidden = WM.view !== 'panes';
  setKids(R.layoutBtns, seg(!isDual(), 'pane', 'Um painel', 'Explorar um projeto por vez (copiar/mover pela barra de seleção ou pelo menu)', () => setLayout('single')),
    seg(isDual(), 'columns', 'Lado a lado', 'Dois projetos lado a lado (Origem ⇄ Destino) para copiar, mover e clonar entre eles', () => setLayout('dual')));
  const ft = (all, label, title) => h('button', { class: WM_PREFS.all === all ? 'active' : '', 'aria-pressed': String(WM_PREFS.all === all), title,
    onclick: () => { if (WM_PREFS.all === all) return; setWmPref('all', all); renderAll(); reloadPanes(); if (WM.search.q) runSearch(WM.search.q); } }, label);
  setKids(R.fileBtns, ft(false, '.sql', 'Mostrar só pastas e scripts .sql'), ft(true, 'Todos', 'Mostrar todos os tipos de arquivo'));
  renderProjectsList();
  renderCenter();
  renderGitPanel();
}
function setView(v) { WM.view = v; renderAll(); }

// ---------- Lista de projetos (esquerda) ----------
// Nomes como ZMIGRA_CLIENTEGAMA_PRD2 / _PRD3 só diferem no final: em vez de cortar com "…", deixa quebrar depois dos underscores.
const softWrap = (s) => String(s).replace(/([_\-.])/g, '$1\u200b');
function renderProjectsList() {
  const R = WM?.refs;
  if (!R) return;
  const rootOk = WM.info.root && WM.info.rootExists;
  R.projFilterWrap.hidden = !rootOk || WM.projects.length < 6; // filtro só quando a lista é longa
  if (!rootOk) {
    setKids(R.projHead);
    setKids(R.projList, wmEmpty('folder', 'Workspace sem pasta raiz', 'Configure a pasta onde ficam os seus projetos (ex.: C:\\Projetos).', h('button', { class: 'btn sm primary', onclick: () => workspaceSettings(true) }, 'Configurar')));
    return;
  }
  const dual = isDual();
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const q = R.projFilterWrap.hidden ? '' : norm(WM.projFilter).trim();
  const shown = q ? WM.projects.filter((p) => norm(`${p.path} ${p.alias || ''} ${(p.appProjects || []).map((a) => a.name).join(' ')}`).includes(q)) : WM.projects;
  const groups = new Map();
  for (const p of shown) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
  const item = (p) => {
    const inL = WM.panes.L.project === p.path; const inR = dual && WM.panes.R.project === p.path;
    const s = p.summary;
    const open = () => openProject(p.path, 'L');
    const el = h('div', { class: `wm-proj${inL ? ' in-l' : ''}${inR ? ' in-r' : ''}`, role: 'button', tabindex: '0', 'aria-current': inL ? 'true' : null,
      title: `${p.path}${p.appProjects?.length ? `\nProjeto no app: ${p.appProjects.map((a) => a.name).join(', ')}` : ''}\nClique: abrir${dual ? ' na Origem' : ''} · clique direito: mais opções`,
      onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
    h('span', { class: `wm-proj-ic ${p.git ? 'repo' : 'dir'}`, title: p.git ? 'Repositório Git' : 'Pasta sem Git' }, icon(p.git ? 'branch' : 'folder', 14)),
    h('div', { class: 'wm-proj-main' },
      h('div', { class: 'wm-proj-top' }, h('span', { class: 'wm-proj-name', title: displayName(p) }, softWrap(displayName(p))),
        dual && inL ? h('span', { class: 'wm-side l', title: 'Aberto na Origem' }, 'O') : null, inR ? h('span', { class: 'wm-side r', title: 'Aberto no Destino' }, 'D') : null),
      h('div', { class: 'wm-proj-sub' }, p.git ? h('span', { class: 'mono wm-branch' }, s?.branch || (s?.detached ? '(destacado)' : '')) : null, syncBadge(p)),
      p.appProjects?.length ? h('div', { class: 'wm-app', title: `Projeto no app: ${p.appProjects.map((a) => a.name).join(', ')}` }, `▸ ${p.appProjects[0].name}`) : null),
    dual ? h('button', { class: 'wm-mini', title: 'Abrir no Destino (painel da direita)', 'aria-label': `Abrir ${displayName(p)} no Destino`, onclick: (e) => { e.stopPropagation(); openProject(p.path, 'R'); } }, icon('arrowRight', 14)) : null);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); projectMenu(e, p); });
    return el;
  };
  setKids(R.projHead, h('span', { class: 'wm-projtitle' }, 'Projetos', h('span', { class: 'wm-count' }, q ? `${shown.length}/${WM.projects.length}` : String(WM.projects.length))),
    wmIconBtn('download', 'Clonar um repositório do GitHub como novo projeto', () => cloneProjectDialog()),
    wmIconBtn('folderPlus', 'Nova pasta de projeto (na pasta raiz)', () => newFolder('')));
  setKids(R.projList,
    WM.projectsError ? h('div', { class: 'ws-note bad' }, WM.projectsError) : null,
    !WM.projects.length && !WM.projectsError ? wmEmpty('folder', 'Nenhum projeto', 'Crie uma pasta de projeto ou clone um repositório do GitHub (botões acima).') : null,
    WM.projects.length && !shown.length ? h('div', { class: 'ws-note small' }, `Nenhum projeto com “${WM.projFilter.trim()}”.`) : null,
    [...groups.entries()].map(([g, list]) => [g ? h('div', { class: 'wm-group', title: g }, icon('folder', 12), h('span', null, g)) : null, list.map(item)]),
    WM.summariesLoading ? h('div', { class: 'ws-note small' }, 'Lendo o Git dos projetos…') : null);
}
function projectMenu(e, p) {
  contextMenu(e.clientX, e.clientY, [
    { label: isDual() ? 'Abrir na Origem (esquerda)' : 'Abrir', run: () => openProject(p.path, 'L') },
    { label: isDual() ? 'Abrir no Destino (direita)' : 'Abrir lado a lado (como Destino)', run: () => openProject(p.path, 'R') },
    { label: 'Mostrar o Git deste projeto', run: () => showGitOf(p.path) },
    '-',
    { label: 'Abrir no VS Code', disabled: !WM.info.vscode, run: () => openExternal(p.path, 'vscode') },
    { label: 'Abrir no Explorer', run: () => openExternal(p.path, 'explorer') },
    { label: 'Nome de exibição…', run: () => aliasDialog(p) },
  ]);
}
async function aliasDialog(p) {
  const name = await promptDialog({ title: 'Nome de exibição', label: `Nome mostrado para ${p.path} (vazio = nome da pasta)`, value: p.alias || '', okText: 'Salvar' });
  if (name === null) return;
  try { await wmApi('PUT', '', { alias: { path: p.path, name } }); p.alias = name || null; renderAll(); } catch (e) { fail(e); }
}

// ---------- Centro ----------
function renderCenter() {
  const R = WM?.refs;
  if (!R) return;
  if (!WM.info.root || !WM.info.rootExists) { setKids(R.center, wmEmpty('workspace', 'Escolha a pasta raiz', 'Indique a pasta onde ficam os seus projetos (cada projeto pode ter o seu repositório Git).', h('button', { class: 'btn primary', onclick: () => workspaceSettings(true) }, 'Configurar o Workspace'))); return; }
  if (WM.view === 'dashboard') return setKids(R.center, renderDashboard());
  if (WM.view === 'search') return setKids(R.center, renderSearch());
  WM.paneEls ||= { L: h('div', { class: 'wm-pane' }), R: h('div', { class: 'wm-pane' }) };
  WM.midEl ||= h('div', { class: 'wm-mid', role: 'group', 'aria-label': 'Ações entre Origem e Destino' });
  if (!isDual()) { renderPane('L'); return setKids(R.center, h('div', { class: 'wm-panes single' }, WM.paneEls.L)); }
  renderPane('L'); renderPane('R'); renderMid();
  setKids(R.center, h('div', { class: 'wm-panes dual' }, WM.paneEls.L, WM.midEl, WM.paneEls.R));
}
function renderPaneHeaders() { if (WM?.view === 'panes' && WM.paneEls) { renderPane('L'); if (isDual()) { renderPane('R'); renderMid(); } } }

// ---------- Painéis Origem / Destino ----------
function setPaneProject(side, path) {
  const pane = WM.panes[side];
  if (pane.project === path) return;
  WM.panes[side] = newPane(path);
  loadDir(side, path);
  if (!isDual() && side === 'L') { WM.gitSide = 'L'; WM.gitProject = null; WM.lastSide = 'L'; } // um painel: o Git é sempre o do projeto aberto
  if (WM.gitSide === side || !WM.panes[other(side)].project) { WM.gitSide = side; loadGit(path); }
}
async function loadDir(side, dir) {
  const pane = WM.panes[side];
  try {
    const l = await wmApi('GET', `/list?${qs({ path: dir, all: WM_PREFS.all ? 1 : 0 })}`);
    if (WM.panes[side] !== pane) return;
    pane.listings.set(dir, l);
  } catch (e) { pane.listings.set(dir, { error: e.message, dirs: [], files: [] }); }
  if (WM.view === 'panes') renderPane(side);
}
// Recarrega o que está aberto num painel (depois de copiar/mover/renomear…), mantendo pastas abertas e seleção válida.
async function reloadPane(side) {
  const pane = WM.panes[side];
  if (!pane.project) return;
  const dirs = [pane.project, ...[...pane.expanded].filter((d) => d !== pane.project)];
  const results = await Promise.all(dirs.map((d) => wmApi('GET', `/list?${qs({ path: d, all: WM_PREFS.all ? 1 : 0 })}`).catch(() => null)));
  if (WM.panes[side] !== pane) return;
  pane.listings = new Map();
  dirs.forEach((d, i) => { if (results[i]) pane.listings.set(d, results[i]); else pane.expanded.delete(d); });
  const alive = new Set();
  for (const l of pane.listings.values()) for (const x of [...l.dirs, ...l.files]) alive.add(x.path);
  for (const s of [...pane.sel]) if (!alive.has(s)) pane.sel.delete(s);
  if (pane.focus !== pane.project && !pane.listings.has(pane.focus) && !alive.has(pane.focus)) pane.focus = pane.project;
  if (WM.view === 'panes') renderPane(side);
}
const reloadPanes = () => Promise.all(['L', 'R'].map(reloadPane)).then(renderMid);

// Git: letra (M/U/A/D/!) de cada arquivo alterado, e as pastas que têm algo alterado dentro.
function gitMarks(project) {
  const g = WM.git.get(project);
  const files = new Map(); const dirs = new Set();
  if (g?.repo) for (const f of g.status.files) {
    files.set(f.wsPath, f.code);
    let d = parentOf(f.wsPath);
    while (d && d.length >= project.length) { dirs.add(d); d = parentOf(d); }
  }
  return { files, dirs };
}

function renderPane(side) {
  const pane = WM.panes[side];
  const el = WM.paneEls[side];
  const p = projectByPath(pane.project);
  const dual = isDual();
  const sel = h('select', { class: 'wm-psel', title: pane.project || '', 'aria-label': `Projeto da ${SIDE_LABEL[side]}`, onchange: (e) => { setPaneProject(side, e.target.value); renderAll(); } },
    h('option', { value: '', disabled: true, selected: !pane.project }, '— escolha um projeto —'),
    WM.projects.map((x) => h('option', { value: x.path, selected: x.path === pane.project }, `${x.group ? `${x.group} / ` : ''}${displayName(x)}`)));
  const gitChip = p?.git ? h('button', { class: `wm-gitchip${dual && WM.gitSide === side ? ' on' : ''}`, title: 'Mostrar o Git deste projeto no painel de baixo', onclick: () => { showGitOf(pane.project, side); if (WM_PREFS.gitOpen === false) setGitOpen(true); } },
    icon('branch', 13), h('span', { class: 'mono' }, p.summary?.branch || '…'), syncBadge(p))
    : p ? h('span', { class: 'wm-nogit', title: 'Esta pasta não é um repositório Git' }, 'sem Git') : null;
  const title = dual
    ? [h('span', { class: `wm-side ${side === 'L' ? 'l' : 'r'}` }, SIDE_LABEL[side]), sel]
    : p ? h('div', { class: 'wm-pname' }, h('h3', { title: p.path }, displayName(p)), p.group ? h('span', { class: 'wm-pgroup' }, p.group) : null)
      : h('div', { class: 'wm-pname' }, h('h3', { class: 'muted' }, 'Nenhum projeto aberto'));
  const tools = h('div', { class: 'wm-ptools' },
    wmIconBtn('filePlus', 'Novo arquivo na pasta atual', () => newFile(side), { disabled: !pane.project }),
    wmIconBtn('folderPlus', 'Nova pasta na pasta atual', () => newFolder(pane.focus || pane.project, side), { disabled: !pane.project }),
    wmIconBtn('refresh', 'Atualizar a lista', () => reloadPane(side), { disabled: !pane.project }),
    h('span', { class: 'wm-tdiv' }),
    wmIconBtn('code', WM.info.vscode ? 'Abrir a pasta do projeto no VS Code' : 'VS Code não encontrado', () => openExternal(pane.project, 'vscode'), { disabled: !pane.project || !WM.info.vscode }),
    wmIconBtn('external', 'Abrir a pasta atual no Explorer', () => openExternal(pane.focus || pane.project, 'explorer'), { disabled: !pane.project }));
  const head = h('div', { class: `wm-phead ${side === 'L' ? 'l' : 'r'}${dual ? ' dual' : ''}` },
    h('div', { class: 'wm-ptitle' }, title, gitChip, dual ? null : [h('span', { class: 'spacer' }), tools]),
    pane.project ? h('div', { class: 'wm-pbar' }, crumbs(side), dual ? tools : null) : null);
  if (!pane.project) { setKids(el, head, wmEmpty('folder', 'Nenhum projeto aberto', dual ? 'Escolha um projeto acima ou na lista da esquerda.' : 'Escolha um projeto na lista da esquerda.')); return; }
  const marks = gitMarks(pane.project);
  const nSel = pane.sel.size;
  const tree = h('div', { class: `wm-tree${nSel ? ' has-sel' : ''}`, role: 'tree', 'aria-multiselectable': 'true', 'aria-label': `Arquivos de ${displayName(p)}` });
  const rootRow = nodeRow(side, { type: 'dir', path: pane.project, name: displayName(p) || baseName(pane.project) }, 0, marks, true);
  tree.append(rootRow, ...renderChildren(side, pane.project, 1, marks));
  dropTarget(tree, side, () => pane.focus || pane.project);
  setKids(el, head, tree, nSel ? selectionBar(side) : h('div', { class: 'wm-pfoot' },
    h('kbd', null, 'Ctrl'), '/', h('kbd', null, 'Shift'), '+clique: vários · duplo clique: abrir · ', h('kbd', null, 'F2'), ' renomear · ', h('kbd', null, 'Del'), ' Lixeira · botão direito: mais'));
}
// Caminho da pasta atual do painel (onde "Novo arquivo/pasta" cria e para onde o que for copiado PARA este painel vai).
function crumbs(side) {
  const pane = WM.panes[side];
  const p = projectByPath(pane.project);
  const cur = pane.focus || pane.project;
  const segs = cur.slice(pane.project.length).replace(/^\//, '').split('/').filter(Boolean);
  const go = (path) => {
    pane.focus = path;
    for (let d = path; d && d.length > pane.project.length; d = parentOf(d)) { pane.expanded.add(d); if (!pane.listings.has(d)) loadDir(side, d); }
    renderPane(side); renderMid();
  };
  const crumb = (label, path, ic) => h('button', { class: 'wm-crumb', title: path, 'aria-current': path === cur ? 'location' : null, onclick: () => go(path) }, ic ? icon(ic, 13) : null, h('span', null, label));
  return h('nav', { class: 'wm-crumbs', 'aria-label': 'Pasta atual', title: 'Pasta atual: novos arquivos e o que for copiado para este painel vão para cá (clique numa pasta da árvore para mudar)' },
    crumb(displayName(p) || baseName(pane.project), pane.project, 'folder'),
    segs.map((s, i) => [h('span', { class: 'wm-crumb-sep', 'aria-hidden': 'true' }, icon('chevronRight', 12)), crumb(s, `${pane.project}/${segs.slice(0, i + 1).join('/')}`)]));
}
// Barra que aparece quando há itens marcados: ações sobre a seleção (vale nos dois layouts).
function selectionBar(side) {
  const pane = WM.panes[side];
  const items = topLevel([...pane.sel]);
  const b = (ic, label, title, run, cls = '') => h('button', { class: `btn sm ${cls}`, title, onclick: run }, icon(ic, 14), label);
  return h('div', { class: 'wm-selbar', role: 'toolbar', 'aria-label': 'Ações nos itens selecionados' },
    h('span', { class: 'wm-selcount' }, plural(pane.sel.size, 'selecionado', 'selecionados')),
    b('copy', 'Copiar para…', 'Copiar para outra pasta ou projeto', () => pickDestination(items, 'copy', pane.project)),
    b('arrowRight', 'Mover para…', 'Mover para outra pasta ou projeto', () => pickDestination(items, 'move', pane.project)),
    b('layers', 'Clonar…', 'Copiar para outro projeto mantendo o mesmo caminho (cria as pastas que faltarem)', () => cloneToProject(items, pane.project)),
    h('span', { class: 'spacer' }),
    b('trash', 'Excluir', 'Enviar para a Lixeira do Windows (Del)', () => deleteEntries(items, side), 'ghost wm-danger'),
    wmIconBtn('close', 'Limpar a seleção (Esc)', () => { pane.sel.clear(); renderPane(side); renderMid(); }));
}
function renderChildren(side, dir, depth, marks) {
  const pane = WM.panes[side];
  const l = pane.listings.get(dir);
  const note = (cls, text) => h('div', { class: `wm-node note ${cls}`, style: `padding-left:${28 + depth * 16}px` }, text);
  if (!l) return [note('muted', 'carregando…')];
  if (l.error) return [note('bad', l.error)];
  const out = [];
  for (const d of l.dirs) {
    out.push(nodeRow(side, { type: 'dir', ...d }, depth, marks));
    if (pane.expanded.has(d.path)) out.push(...renderChildren(side, d.path, depth + 1, marks));
  }
  for (const f of l.files) out.push(nodeRow(side, { type: 'file', ...f }, depth, marks));
  if (!l.dirs.length && !l.files.length) out.push(note('muted small', WM_PREFS.all ? '(vazia)' : '(nenhum .sql)'));
  if (l.truncated) out.push(note('muted small', 'Lista limitada: pasta com muitos itens.'));
  return out;
}
function nodeRow(side, n, depth, marks, isRoot = false) {
  const pane = WM.panes[side];
  const isDir = n.type === 'dir';
  const open = isRoot || pane.expanded.has(n.path);
  const code = isDir ? (marks.dirs.has(n.path) ? '•' : null) : marks.files.get(n.path);
  const selected = pane.sel.has(n.path);
  const box = isRoot ? null : h('input', { type: 'checkbox', checked: selected, title: 'Selecionar', onclick: (e) => e.stopPropagation(), onchange: () => { toggleSel(side, n.path); } });
  const isSql = !isDir && /\.sql$/i.test(n.name);
  const row = h('div', { class: `wm-node ${isDir ? 'dir' : 'file'}${selected ? ' sel' : ''}${pane.focus === n.path ? ' focus' : ''}${isRoot ? ' root' : ''}${code ? ` g-${code === '!' ? 'C' : code === '•' ? 'M' : code}` : ''}`,
    style: `padding-left:${6 + depth * 16}px`, draggable: isRoot ? null : 'true', role: 'treeitem', title: n.path, 'data-path': n.path, 'aria-selected': String(selected), 'aria-expanded': isDir ? String(open) : null,
    onclick: (e) => nodeClick(side, n, e, isRoot), ondblclick: () => { if (!isDir) openExternal(n.path, WM.info.vscode ? 'vscode' : 'default'); } },
  h('span', { class: 'wm-chev' }, isDir && !isRoot ? icon(open ? 'chevronDown' : 'chevronRight', 13) : null), box,
  h('span', { class: `wm-ic ${isDir ? (n.git || isRoot ? 'repo' : 'dir') : isSql ? 'sql' : 'file'}` }, isDir ? icon(n.git || (isRoot && projectByPath(pane.project)?.git) ? 'branch' : 'folder', 15) : isSql ? 'SQL' : icon('file', 14)),
  h('span', { class: 'grow' }, n.name),
  !isDir && n.size !== undefined ? h('span', { class: 'wm-size' }, wmSize(n.size)) : null,
  code ? h('span', { class: 'ws-gcode', title: code === '•' ? 'Há alterações (Git) dentro desta pasta' : 'Situação no Git' }, code) : null);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!pane.sel.has(n.path) && !isRoot) { pane.sel = new Set([n.path]); renderPane(side); renderMid(); } nodeMenu(e, side, n, isRoot); });
  if (!isRoot) row.addEventListener('dragstart', (e) => {
    if (!pane.sel.has(n.path)) { pane.sel = new Set([n.path]); }
    e.dataTransfer.setData('text/gp-wm', JSON.stringify({ side, items: [...pane.sel] }));
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  if (isDir) dropTarget(row, side, () => n.path);
  return row;
}
function nodeClick(side, n, e, isRoot) {
  const pane = WM.panes[side];
  if (n.type === 'dir') {
    pane.focus = n.path; // pasta de destino deste painel
    if (!isRoot) { if (pane.expanded.has(n.path)) pane.expanded.delete(n.path); else { pane.expanded.add(n.path); if (!pane.listings.has(n.path)) loadDir(side, n.path); } }
  }
  if (!isRoot) {
    if (e.ctrlKey || e.metaKey) toggleSel(side, n.path, false);
    else if (e.shiftKey && pane.anchor) selectRange(side, pane.anchor, n.path);
    else if (n.type === 'file' || e.target.type !== 'checkbox') pane.sel = n.type === 'file' ? new Set([n.path]) : pane.sel;
    pane.anchor = n.path;
  }
  WM.gitSide = side; // o painel usado por último é o que aparece no Git
  WM.lastSide = side; // atalhos de teclado (Del/F2/Esc) agem neste painel
  if (WM.git.get(pane.project) === undefined) loadGit(pane.project); else renderGitPanel();
  renderPane(side); renderMid();
}
function toggleSel(side, path, rerender = true) {
  const pane = WM.panes[side];
  if (pane.sel.has(path)) pane.sel.delete(path); else pane.sel.add(path);
  pane.anchor = path;
  if (rerender) { renderPane(side); renderMid(); }
}
// Shift+clique: seleciona o intervalo visível entre o último clicado e este.
function selectRange(side, from, to) {
  const pane = WM.panes[side];
  const visible = [...WM.paneEls[side].querySelectorAll('.wm-node[data-path]')].map((r) => r.dataset.path).filter((t) => t !== pane.project);
  const i = visible.indexOf(from); const j = visible.indexOf(to);
  if (i < 0 || j < 0) { pane.sel.add(to); return; }
  for (let k = Math.min(i, j); k <= Math.max(i, j); k++) pane.sel.add(visible[k]);
}
// Arrastar e soltar: de um painel para o outro = COPIAR (Shift = mover); dentro do mesmo painel = MOVER.
function dropTarget(el, side, dirOf) {
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/gp-wm')) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('drop');
    let data; try { data = JSON.parse(e.dataTransfer.getData('text/gp-wm')); } catch { return; }
    const destDir = dirOf();
    const op = data.side === side || e.shiftKey ? 'move' : 'copy';
    const items = topLevel(data.items).filter((s) => s !== destDir && parentOf(s) !== destDir || op === 'copy');
    if (!items.length) return;
    await runTransfer(items.map((src) => ({ src, destDir })), op, [data.side, side]);
  });
}
// Não manda uma pasta E algo de dentro dela (o de dentro já vai junto).
const topLevel = (list) => list.filter((a) => !list.some((b) => b !== a && a.startsWith(`${b}/`)));

// ---------- Ações entre os painéis ----------
function renderMid() {
  if (!WM.midEl) return;
  const L = WM.panes.L; const R = WM.panes.R;
  const can = (from) => WM.panes[from].sel.size > 0 && !!WM.panes[other(from)].project;
  const target = (side) => { const p = WM.panes[side]; return p.focus ? `${displayName(projectByPath(p.project))}${p.focus.slice(p.project.length) || ''}` : '—'; };
  // Seta do lado certo: Origem → Destino (ícone depois do texto) e Destino → Origem (ícone antes).
  const btn = (from, label, title, fn, cls = '') => h('button', { class: `btn sm ${cls}`, title, disabled: !can(from), onclick: fn },
    from === 'R' ? icon('arrowLeft', 13) : null, label, from === 'L' ? icon('arrowRight', 13) : null);
  const group = (from) => {
    const to = other(from);
    const n = WM.panes[from].sel.size;
    return h('div', { class: 'wm-midgroup' },
      h('div', { class: 'wm-midlbl', title: `${plural(n, 'item selecionado', 'itens selecionados')} na ${SIDE_LABEL[from]}` }, from === 'L' ? 'Origem → Destino' : 'Destino → Origem', h('span', { class: `wm-midn${n ? ' on' : ''}` }, String(n))),
      btn(from, 'Copiar', `Copiar os itens selecionados da ${SIDE_LABEL[from]} para: ${target(to)}`, () => transferBetween(from, 'copy'), 'primary'),
      btn(from, 'Mover', `Mover os itens selecionados da ${SIDE_LABEL[from]} para: ${target(to)}`, () => transferBetween(from, 'move')),
      btn(from, 'Clonar', `Copiar para o projeto da ${to === 'R' ? 'direita' : 'esquerda'} mantendo o MESMO caminho (ex.: scripts/PFUNC.sql → scripts/PFUNC.sql), criando as pastas que faltarem`, () => transferBetween(from, 'copy', { clone: true })));
  };
  setKids(WM.midEl, group('L'), group('R'),
    h('button', { class: 'btn sm ghost wm-midswap', title: 'Trocar os projetos de lado', 'aria-label': 'Trocar os projetos de lado', disabled: !L.project && !R.project, onclick: () => { [WM.panes.L, WM.panes.R] = [WM.panes.R, WM.panes.L]; WM.gitSide = other(WM.gitSide); renderAll(); } }, icon('swap', 15), 'Inverter'));
}
async function transferBetween(fromSide, op, { clone = false } = {}) {
  const src = WM.panes[fromSide]; const dst = WM.panes[other(fromSide)];
  const items = topLevel([...src.sel]);
  if (!items.length || !dst.project) return;
  const mapped = items.map((s) => {
    if (!clone) return { src: s, destDir: dst.focus || dst.project };
    const within = parentOf(s).slice(src.project.length).replace(/^\//, ''); // caminho dentro do projeto de origem
    return { src: s, destDir: within ? `${dst.project}/${within}` : dst.project, createDest: true };
  });
  await runTransfer(mapped, op, [fromSide, other(fromSide)]);
}

// Copiar/mover com plano: primeiro o servidor lista os conflitos; se houver, o usuário decide cada um.
async function runTransfer(items, op, sides = ['L', 'R']) {
  let plan;
  try { plan = await wmApi('POST', '/transfer', { op, items, dryRun: true }); } catch (e) { return fail(e); }
  let resolutions = {};
  if (plan.conflicts.length) {
    resolutions = await conflictsDialog(plan.conflicts, op);
    if (!resolutions) return;
  }
  let r;
  try { r = await wmApi('POST', '/transfer', { op, items, resolutions }); } catch (e) { return fail(e); }
  const verb = op === 'move' ? 'movido' : 'copiado';
  toast(`${plural(r.done.length, `arquivo ${verb}`, `arquivos ${op === 'move' ? 'movidos' : 'copiados'}`)}${r.replaced.length ? ` · ${r.replaced.length} substituído(s) (antigos na Lixeira)` : ''}${r.renamed.length ? ` · ${r.renamed.length} com novo nome` : ''}${r.skipped.length ? ` · ${r.skipped.length} pulado(s)` : ''}.`);
  // Pastas de destino abertas para mostrar o resultado; Git dos projetos envolvidos atualizado (ex.: "U PFUNC.sql").
  for (const it of items) {
    const destPane = ['L', 'R'].map((s) => WM.panes[s]).find((p) => p.project && (it.destDir === p.project || it.destDir.startsWith(`${p.project}/`)));
    if (destPane) { let d = it.destDir; while (d && d.length > destPane.project.length) { destPane.expanded.add(d); d = parentOf(d); } }
  }
  for (const s of sides) WM.panes[s].sel.clear();
  await reloadPanes();
  const touched = new Set([...items.map((i) => projectOfPath(i.src)?.path), ...items.map((i) => projectOfPath(i.destDir)?.path)].filter(Boolean));
  for (const p of touched) { refreshSummary(p); if (WM.git.has(p)) loadGit(p); }
}

// Conflitos: para cada arquivo que já existe no destino — Substituir / Manter ambos / Pular (+ Comparar).
function conflictsDialog(conflicts, op) {
  return new Promise((resolve) => {
    let done = false;
    const choice = {};
    for (const c of conflicts) choice[c.to] = c.identical ? 'skip' : c.self ? 'keepBoth' : 'keepBoth';
    const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const selects = [];
    const opt = (c) => {
      const s = h('select', { 'aria-label': `O que fazer com ${c.to}`, onchange: (e) => { choice[c.to] = e.target.value; } },
        h('option', { value: 'replace', disabled: c.self, selected: choice[c.to] === 'replace' }, 'Substituir'),
        h('option', { value: 'keepBoth', selected: choice[c.to] === 'keepBoth' }, 'Manter ambos (renomeia a cópia)'),
        h('option', { value: 'skip', selected: choice[c.to] === 'skip' }, 'Pular (não copiar)'));
      selects.push({ s, c });
      return s;
    };
    const all = (v) => { for (const { s, c } of selects) { if (v === 'replace' && c.self) continue; s.value = v; choice[c.to] = v; } };
    const info = (x) => `${wmSize(x.size)} · ${fmtWhenShort(x.mtimeMs)}`;
    const m = openModal({ title: `${plural(conflicts.length, 'arquivo já existe', 'arquivos já existem')} no destino`, wide: true,
      body: [h('div', { class: 'muted small' }, `Nada é sobrescrito sem a sua escolha. “Substituir” manda o arquivo que está no destino para a Lixeira do Windows antes de ${op === 'move' ? 'mover' : 'copiar'}.`),
        h('div', { class: 'inline small' }, 'Aplicar a todos:', h('button', { class: 'btn sm', onclick: () => all('replace') }, 'Substituir'), h('button', { class: 'btn sm', onclick: () => all('keepBoth') }, 'Manter ambos'), h('button', { class: 'btn sm', onclick: () => all('skip') }, 'Pular')),
        h('div', { class: 'tablewrap', style: 'max-height:55vh' }, h('table', null,
          h('thead', null, h('tr', null, ['Arquivo no destino', 'Origem', 'Destino', 'O que fazer', ''].map((t) => h('th', null, t)))),
          h('tbody', null, conflicts.map((c) => h('tr', null,
            h('td', { class: 'mono small', title: c.to }, c.to, c.identical ? h('span', { class: 'pill ok', style: 'margin-left:6px' }, 'idêntico') : null, c.self ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'mesmo arquivo') : null),
            h('td', { class: 'small' }, info(c.src)), h('td', { class: 'small' }, info(c.dest)), h('td', null, opt(c)),
            h('td', null, c.identical || c.self ? null : h('button', { class: 'btn sm ghost', title: 'Ver as diferenças entre o arquivo de origem e o do destino', onclick: () => compareFiles(c.from, c.to) }, 'Comparar')))))))],
      onClose: () => finish(null),
      footer: [h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => finish({ ...choice }) }, op === 'move' ? 'Mover' : 'Copiar')] });
  });
}
async function compareFiles(a, b) {
  let r;
  try { r = await wmApi('GET', `/compare?${qs({ a, b })}`); } catch (e) { return fail(e); }
  const notes = [r.a, r.b].filter((x) => x.binary || x.tooBig).map((x) => `${x.path}: ${x.binary ? 'arquivo binário' : 'grande demais para comparar'}.`);
  showDiffModal({ title: 'Comparar arquivos', subtitle: `${a}  ↔  ${b}`, original: r.a.text, modified: r.b.text, labels: [a, b], notes });
}

// ---------- Menu de contexto dos itens ----------
function nodeMenu(e, side, n, isRoot) {
  const pane = WM.panes[side];
  const isDir = n.type === 'dir';
  const items = isRoot ? [] : topLevel([...pane.sel]);
  const n2 = items.length;
  const dst = WM.panes[other(side)];
  contextMenu(e.clientX, e.clientY, [
    !isDir ? { label: 'Abrir no VS Code', disabled: !WM.info.vscode, title: WM.info.vscode ? null : 'VS Code não encontrado', run: () => openExternal(n.path, 'vscode') } : { label: 'Abrir pasta no VS Code', disabled: !WM.info.vscode, run: () => openExternal(n.path, 'vscode') },
    !isDir ? { label: 'Abrir com aplicativo padrão', run: () => openExternal(n.path, 'default') } : null,
    { label: isDir ? 'Abrir no Explorer' : 'Mostrar no Explorer', run: () => openExternal(n.path, 'explorer') },
    '-',
    !isRoot && isDual() && dst.project ? { label: `Copiar ${n2 > 1 ? `${n2} itens ` : ''}para ${other(side) === 'L' ? 'a Origem' : 'o Destino'} (${displayName(projectByPath(dst.project))})`, run: () => transferBetween(side, 'copy') } : null,
    !isRoot ? { label: `Copiar ${n2 > 1 ? `${n2} itens ` : ''}para…`, run: () => pickDestination(items, 'copy', pane.project) } : null,
    !isRoot ? { label: `Mover ${n2 > 1 ? `${n2} itens ` : ''}para…`, run: () => pickDestination(items, 'move', pane.project) } : null,
    !isRoot ? { label: 'Clonar para projeto… (mesmo caminho)', run: () => cloneToProject(items, pane.project) } : null,
    '-',
    isDir ? { label: 'Nova pasta aqui…', run: () => newFolder(n.path, side) } : null,
    isDir ? { label: 'Novo arquivo aqui…', run: () => { pane.focus = n.path; newFile(side); } } : null,
    !isRoot && n2 <= 1 ? { label: 'Renomear…', run: () => renameEntry(n, side) } : null,
    { label: 'Copiar caminho completo', run: () => navigator.clipboard.writeText(`${WM.info.root}\\${n.path.replace(/\//g, '\\')}`).then(() => toast('Caminho copiado.'), fail) },
    { label: 'Mostrar no Git', disabled: !projectByPath(pane.project)?.git, run: () => showGitOf(pane.project, side) },
    !isRoot ? '-' : null,
    !isRoot ? { label: `Excluir ${n2 > 1 ? `${n2} itens ` : ''}(Lixeira)…`, danger: true, run: () => deleteEntries(items, side) } : null,
  ]);
}

// Escolher destino (projeto + pasta) para "Copiar para…" / "Mover para…".
async function pickDestination(items, op, fromProject) {
  const projSel = h('select', null, WM.projects.map((p) => h('option', { value: p.path }, `${p.group ? `${p.group} / ` : ''}${displayName(p)}`)));
  const folderList = h('div', { class: 'wm-picker' });
  let chosen = null;
  const load = async (dir) => {
    chosen = dir;
    setKids(folderList, h('div', { class: 'ws-note' }, 'carregando…'));
    let l;
    try { l = await wmApi('GET', `/list?${qs({ path: dir })}`); } catch (e) { setKids(folderList, h('div', { class: 'ws-note bad' }, e.message)); return; }
    const proj = projSel.value;
    setKids(folderList,
      h('div', { class: 'wm-pickpath mono' }, dir),
      dir !== proj ? h('div', { class: 'wm-node dir', onclick: () => load(parentOf(dir)) }, h('span', { class: 'wm-ic' }, icon('chevronLeft', 14)), '..') : null,
      l.dirs.map((d) => h('div', { class: 'wm-node dir', onclick: () => load(d.path) }, h('span', { class: 'wm-ic dir' }, icon('folder', 15)), d.name)),
      !l.dirs.length ? h('div', { class: 'ws-note small' }, 'Sem subpastas.') : null);
  };
  projSel.addEventListener('change', () => load(projSel.value));
  // Lado a lado: sugere o projeto do outro painel; um painel: o próprio projeto (mover entre pastas é o caso comum).
  const cur = (isDual() ? WM.panes[other(WM.lastSide || WM.gitSide)].project : null) || fromProject || WM.panes.L.project || WM.projects[0]?.path;
  if (cur) projSel.value = cur;
  const ok = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const m = openModal({ title: `${op === 'move' ? 'Mover' : 'Copiar'} ${plural(items.length, 'item', 'itens')} para…`, body: [field('Projeto', projSel), h('div', { class: 'lbl' }, 'Pasta de destino (clique para entrar)'), folderList],
      onClose: () => finish(false), footer: [h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => finish(true) }, `${op === 'move' ? 'Mover' : 'Copiar'} para esta pasta`)] });
    load(projSel.value);
  });
  if (!ok || !chosen) return;
  await runTransfer(items.map((src) => ({ src, destDir: chosen })), op);
}
// "Clonar para projeto…": mesmo caminho relativo no outro projeto (cria as pastas que faltarem).
async function cloneToProject(items, fromProject) {
  const sel = h('select', null, WM.projects.filter((p) => p.path !== fromProject).map((p) => h('option', { value: p.path }, `${p.group ? `${p.group} / ` : ''}${displayName(p)}`)));
  const preview = h('div', { class: 'mono small muted' });
  const upd = () => setKids(preview, items.slice(0, 6).map((s) => h('div', null, `${sel.value}/${s.slice(fromProject.length + 1)}`)), items.length > 6 ? h('div', null, `… e mais ${items.length - 6}`) : null);
  sel.addEventListener('change', upd);
  const ok = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const m = openModal({ title: 'Clonar para outro projeto', body: [h('div', { class: 'muted small' }, 'Copia mantendo o mesmo caminho dentro do projeto (as pastas que faltarem são criadas).'), field('Projeto de destino', sel), h('div', { class: 'lbl' }, 'Vai ficar assim:'), preview],
      onClose: () => finish(false), footer: [h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => finish(true) }, 'Clonar')] });
    upd();
  });
  if (!ok || !sel.value) return;
  await runTransfer(items.map((s) => { const within = parentOf(s).slice(fromProject.length).replace(/^\//, ''); return { src: s, destDir: within ? `${sel.value}/${within}` : sel.value, createDest: true }; }), 'copy');
}

async function newFile(side) {
  const pane = WM.panes[side];
  const dir = pane.focus || pane.project;
  const name = await promptDialog({ title: 'Novo arquivo', label: `Nome (em ${dir})`, value: 'novo_script.sql', okText: 'Criar', hint: 'Sem extensão vira .sql. O arquivo é criado vazio; edite no VS Code ou no SSMS.' });
  if (!name) return;
  try {
    const r = await wmApi('POST', '/file', { dir, name });
    pane.expanded.add(dir); await reloadPane(side); refreshSummary(pane.project); if (WM.git.has(pane.project)) loadGit(pane.project);
    if (WM.info.vscode && await confirmDialog({ title: 'Arquivo criado', message: `${r.path}\n\nAbrir no VS Code para editar?`, okText: 'Abrir no VS Code' })) openExternal(r.path, 'vscode');
  } catch (e) { fail(e); }
}
async function newFolder(dir, side) {
  const name = await promptDialog({ title: dir ? 'Nova pasta' : 'Nova pasta de projeto', label: `Nome${dir ? ` (em ${dir})` : ' (na pasta raiz do Workspace)'}`, okText: 'Criar' });
  if (!name) return;
  try {
    const r = await wmApi('POST', '/folder', { dir, name });
    if (!dir) { await loadProjects(); return; }
    if (side) { WM.panes[side].expanded.add(dir); WM.panes[side].focus = r.path; await reloadPane(side); }
  } catch (e) { fail(e); }
}
async function renameEntry(n, side) {
  const name = await promptDialog({ title: n.type === 'dir' ? 'Renomear pasta' : 'Renomear arquivo', label: 'Novo nome', value: n.name, okText: 'Renomear' });
  if (!name || name === n.name) return;
  try {
    await wmApi('POST', '/rename', { path: n.path, newName: name });
    WM.panes[side].sel.clear();
    await reloadPanes(); refreshSummary(WM.panes[side].project); if (WM.git.has(WM.panes[side].project)) loadGit(WM.panes[side].project);
  } catch (e) { fail(e); }
}
async function deleteEntries(items, side) {
  if (!items.length) return;
  const ok = await confirmDialog({ title: 'Excluir', danger: true, okText: 'Enviar para a Lixeira',
    message: `${items.length === 1 ? `“${items[0]}”` : `${items.length} itens`} ${items.length === 1 ? 'será enviado' : 'serão enviados'} para a Lixeira do Windows (dá para restaurar de lá).${items.length > 1 ? `\n\n${items.slice(0, 8).join('\n')}${items.length > 8 ? '\n…' : ''}` : ''}` });
  if (!ok) return;
  try {
    await wmApi('POST', '/delete', { paths: items });
    WM.panes[side].sel.clear();
    await reloadPanes(); refreshSummary(WM.panes[side].project); if (WM.git.has(WM.panes[side].project)) loadGit(WM.panes[side].project);
    toast('Enviado para a Lixeira.');
  } catch (e) { fail(e); }
}
async function openExternal(path, app) {
  try { await wmApi('POST', '/open', { path, app }); } catch (e) { fail(e); }
}

// ---------- Painel de repositórios (visão geral) ----------
function renderDashboard() {
  const rows = WM.projects.map((p) => {
    const s = p.summary;
    return h('tr', { class: 'wm-dashrow', onclick: () => { openProject(p.path, 'L'); showGitOf(p.path, 'L'); } },
      h('td', null, h('strong', null, displayName(p)), p.alias ? h('div', { class: 'small muted' }, p.name) : null, p.appProjects?.length ? h('div', { class: 'small muted' }, `app: ${p.appProjects.map((a) => a.name).join(', ')}`) : null),
      h('td', { class: 'small muted mono' }, p.group || ''),
      h('td', { class: 'mono' }, p.git ? (s?.branch || (s?.detached ? '(destacado)' : '…')) : '—'),
      h('td', { class: 'num' }, p.git && s && !s.error ? (s.changes || '0') : '—'),
      h('td', null, syncBadge(p, { long: true })),
      h('td', { class: 'small mono', title: s?.remote?.url || '' }, s?.remote ? (s.remote.webUrl ? h('a', { href: s.remote.webUrl, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, s.remote.webUrl.replace('https://github.com/', '')) : s.remote.url.replace(/^https?:\/\//, '')) : '—'),
      h('td', { class: 'small muted' }, s?.fetchedAt ? ago(s.fetchedAt) : p.git && s?.remote ? 'nunca' : ''),
      h('td', { class: 'actions' }, h('button', { class: 'btn sm ghost', title: 'Abrir os arquivos deste projeto', onclick: (e) => { e.stopPropagation(); openProject(p.path, 'L'); } }, 'Abrir'),
        h('button', { class: 'btn sm ghost', title: 'Abrir lado a lado, como Destino', onclick: (e) => { e.stopPropagation(); openProject(p.path, 'R'); } }, 'Como destino')));
  });
  const withRemote = WM.projects.filter((p) => p.git && p.summary?.remote);
  const totals = WM.projects.reduce((a, p) => { const s = p.summary; if (!s || s.error) return a; a.changes += s.changes ? 1 : 0; a.ahead += s.ahead ? 1 : 0; a.behind += s.behind ? 1 : 0; return a; }, { changes: 0, ahead: 0, behind: 0 });
  const stat = (n, label, cls) => h('div', { class: `wm-stat${n && cls ? ` ${cls}` : ''}` }, h('span', { class: 'n' }, String(n)), h('span', { class: 'l' }, label));
  return h('div', { class: 'wm-dash' },
    h('div', { class: 'wm-dash-head' }, h('div', { class: 'grow' }, h('h2', null, 'Repositórios'), h('div', { class: 'muted small' }, 'Situação do Git de cada projeto. Clique numa linha para abrir os arquivos e o Git dele.')),
      h('button', { class: 'btn sm', disabled: !withRemote.length, title: 'git fetch em todos os projetos com remote (não altera arquivos)', onclick: (e) => fetchAll(e.currentTarget, withRemote) }, icon('refresh', 14), `Fetch em todos (${withRemote.length})`),
      h('button', { class: 'btn sm ghost', title: 'Reler a situação do Git de todos os projetos', onclick: () => refreshSummaries() }, 'Atualizar')),
    h('div', { class: 'wm-stats' }, stat(WM.projects.filter((p) => p.git).length, 'repositórios'), stat(totals.changes, 'com alterações sem commit', 'warn'),
      stat(totals.ahead, 'aguardando Push', 'warn'), stat(totals.behind, 'aguardando Pull', 'pull')),
    h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Projeto', 'Grupo', 'Branch', 'Alterações', 'Sincronização', 'Remote', 'Remoto consultado', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 8, class: 'empty' }, 'Nenhum projeto.'))))),
    WM.summariesLoading ? h('div', { class: 'ws-note small' }, 'Lendo o Git dos projetos…') : null);
}
async function fetchAll(btn, list) {
  btn.disabled = true;
  let ok = 0; const errs = [];
  for (const [i, p] of list.entries()) {
    btn.textContent = `Fetch ${i + 1}/${list.length}…`;
    try { await api('POST', '/api/wsm/git/fetch', { project: p.path }); ok++; } catch (e) { errs.push(`${displayName(p)}: ${e.message}`); }
  }
  toast(`Fetch concluído em ${ok} de ${list.length} projeto(s).${errs.length ? ` Erros: ${errs.join(' | ')}` : ''}`, errs.length ? 'error' : 'info');
  await refreshSummaries();
}

// ---------- Busca ----------
async function runSearch(q) {
  WM.search.q = String(q || '').trim();
  if (!WM.search.q) { WM.search.results = null; setView('panes'); return; }
  WM.search.loading = true; WM.view = 'search'; renderAll();
  try { const r = await wmApi('GET', `/search?${qs({ q: WM.search.q, all: WM_PREFS.all ? 1 : 0 })}`); WM.search.results = r.results; WM.search.truncated = r.truncated; } catch (e) { fail(e); WM.search.results = []; }
  WM.search.loading = false; WM.search.sel = new Set(); renderAll();
}
function renderSearch() {
  const S = WM.search;
  if (S.loading) return h('div', { class: 'ws-note' }, `Buscando “${S.q}”…`);
  const res = S.results || [];
  S.sel ||= new Set();
  const reveal = async (side, path) => {
    const p = projectOfPath(path);
    if (!p) return;
    if (side === 'R' && !isDual()) setWmPref('layout', 'dual');
    setPaneProject(side, p.path);
    const pane = WM.panes[side];
    let d = parentOf(path);
    const dirs = [];
    while (d && d.length > p.path.length) { dirs.unshift(d); d = parentOf(d); }
    for (const x of dirs) pane.expanded.add(x);
    pane.focus = parentOf(path); pane.sel = new Set([path]);
    setView('panes');
    await reloadPane(side);
  };
  const copyToDest = async () => {
    const dst = WM.panes.R;
    if (!dst.project) return toast('Escolha um projeto no Destino primeiro.', 'error');
    await runTransfer([...S.sel].map((src) => ({ src, destDir: dst.focus || dst.project })), 'copy', ['R']);
  };
  return h('div', { class: 'wm-dash' },
    h('div', { class: 'wm-dash-head' }, h('div', { class: 'grow' }, h('h2', null, `Busca: “${S.q}”`), h('div', { class: 'muted small' }, `${plural(res.length, 'arquivo encontrado', 'arquivos encontrados')}${S.truncated ? ' (busca limitada — refine o termo)' : ''} · marque para copiar`)),
      isDual() ? h('button', { class: 'btn sm', disabled: !S.sel.size || !WM.panes.R.project, title: 'Copiar os marcados para a pasta atual do Destino', onclick: copyToDest }, `Copiar ${S.sel.size || ''} para o Destino${WM.panes.R.project ? ` (${displayName(projectByPath(WM.panes.R.project))})` : ''}`) : null,
      h('button', { class: 'btn sm', disabled: !S.sel.size, title: 'Escolher o projeto e a pasta para onde copiar os marcados', onclick: () => pickDestination([...S.sel], 'copy') }, icon('copy', 14), `Copiar ${S.sel.size || ''} para…`),
      h('button', { class: 'btn sm ghost', onclick: () => { WM.search = { q: '', results: null }; WM.refs.search.value = ''; setView('panes'); } }, icon('close', 14), 'Fechar busca')),
    h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['', 'Arquivo', 'Projeto', 'Caminho', ''].map((t) => h('th', null, t)))),
      h('tbody', null, res.length ? res.map((r) => {
        const p = projectOfPath(r.path);
        return h('tr', null,
          h('td', null, h('input', { type: 'checkbox', checked: S.sel.has(r.path), onchange: (e) => { if (e.target.checked) S.sel.add(r.path); else S.sel.delete(r.path); renderCenter(); } })),
          h('td', null, h('strong', null, r.name)), h('td', null, p ? displayName(p) : h('span', { class: 'muted' }, '(fora de projeto)')),
          h('td', { class: 'mono small', title: r.path }, parentOf(r.path)),
          h('td', { class: 'actions' }, h('button', { class: 'btn sm ghost', title: 'Mostrar o arquivo na árvore do projeto', onclick: () => reveal('L', r.path) }, 'Mostrar'), h('button', { class: 'btn sm ghost', title: 'Mostrar lado a lado, no Destino', onclick: () => reveal('R', r.path) }, 'No Destino'),
            wmIconBtn('code', WM.info.vscode ? 'Abrir no VS Code' : 'VS Code não encontrado', () => openExternal(r.path, 'vscode'), { disabled: !WM.info.vscode }), wmIconBtn('external', 'Mostrar no Explorer', () => openExternal(r.path, 'explorer'))));
      }) : h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'Nada encontrado.'))))));
}

// ---------- Configuração da pasta raiz ----------
function workspaceSettings(first = false) {
  const pf = pathField({ value: WM.info.root, kind: 'folder', title: 'Pasta raiz do Workspace (onde ficam os projetos)', placeholder: 'C:\\Projetos' });
  const sugg = WM.info.suggestions?.length ? h('div', { class: 'inline', style: 'flex-wrap:wrap;gap:6px' }, h('span', { class: 'small muted' }, 'Sugestões:'),
    WM.info.suggestions.map((s) => h('button', { class: 'btn sm ghost mono', onclick: () => { pf.input.value = s; } }, s))) : null;
  const md = openModal({ title: first ? 'Configurar o Workspace' : 'Pasta raiz do Workspace',
    body: [h('div', { class: 'muted' }, 'Escolha a pasta que contém os seus projetos (ex.: C:\\Projetos). Cada subpasta com repositório Git (até 3 níveis) vira um projeto, com Git próprio; pastas comuns do primeiro nível também aparecem. Tudo acontece nos arquivos reais — nada é copiado para o app.'),
      field('Pasta raiz', pf.el), sugg],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, first ? 'Depois' : 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const root = pf.get();
        try { await wmApi('PUT', '', { root }); } catch (err) {
          if (err.code !== 'WS_ROOT_MISSING') throw err;
          if (!(await confirmDialog({ title: 'Criar pasta', message: `A pasta ${root} não existe. Criar agora?`, okText: 'Criar pasta' }))) return;
          await wmApi('PUT', '', { root, createIfMissing: true });
        }
        md.close();
        WM.info = await wmApi('GET', '');
        WM.panes = { L: newPane(), R: newPane() }; WM.git = new Map(); WM.search = { q: '', results: null };
        await loadProjects();
        toast('Workspace configurado.');
      }) }, 'Salvar')] });
}

async function refreshEverything() {
  try { WM.info = await wmApi('GET', ''); } catch (e) { return fail(e); }
  await loadProjects();
  await reloadPanes();
  const gp = WM.panes[WM.gitSide]?.project;
  if (gp) loadGit(gp);
}
window.addEventListener('focus', () => { // voltou do VS Code/Explorer: atualiza o que pode ter mudado lá fora
  if (!WM?.refs || route().name !== 'workspace' || !WM.info?.rootExists) return;
  reloadPanes();
  const gp = WM.panes[WM.gitSide]?.project;
  if (gp) { loadGit(gp); refreshSummary(gp); }
});
