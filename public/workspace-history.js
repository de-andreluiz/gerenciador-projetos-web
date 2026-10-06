'use strict';
// Workspace — Histórico Git em grafo (aba "Histórico" do painel Git), por projeto. Tudo vem do Git local do projeto
// (/api/wsm/git/graph, /commit, /commit-diff): git log com pais e refs, rev-list para local × remoto.
// O grafo é desenhado aqui (SVG por linha): cada "raia" é uma linha de desenvolvimento; merges juntam raias.

const HIST = { rowH: 32, laneW: 16, page: 100, maxCommits: 3000 };
const LANE_COLORS = ['#00B4D2', '#A44DFF', '#0E9F7E', '#FF8900', '#FF009E', '#7A9A00', '#0A46EA', '#C2410C'];
const laneColor = (k) => LANE_COLORS[k % LANE_COLORS.length];

// Estado do histórico de cada projeto (mantido ao trocar de aba/projeto).
function historyState(project) {
  WM.hist ||= new Map();
  if (!WM.hist.has(project)) WM.hist.set(project, { project, el: h('div', { class: 'hist' }), all: true, commits: [], data: null, selected: null, stale: true });
  return WM.hist.get(project);
}
function renderHistoryPanel(container, project) {
  const tab = historyState(project);
  setKids(container, tab.el);
  if (tab.stale && !tab.loading) loadHistory(tab, true); else renderHistory(tab);
}
// Depois de commit, pull, push, troca de branch…: recarrega se o histórico desse projeto estiver na tela; senão marca.
function refreshHistoryPanel(project, force = false) {
  const tab = WM.hist?.get(project);
  if (!tab) return;
  if (force || (WM.gitTab === 'history' && gitProject() === project)) loadHistory(tab, true); else tab.stale = true;
}

async function loadHistory(tab, reset) {
  const skip = reset ? 0 : tab.commits.length;
  tab.loading = true;
  tab.stale = false;
  renderHistory(tab);
  try {
    const page = await gitApi('GET', `/graph?skip=${skip}&limit=${HIST.page}&all=${tab.all ? 1 : 0}`, null, tab.project);
    if (reset) {
      tab.data = page;
      tab.commits = page.commits;
      tab.localOnly = new Set(page.localOnly || []);
      tab.incoming = new Set(page.incoming || []);
      if (tab.selected && !tab.commits.some((c) => c.hash === tab.selected)) { tab.selected = null; tab.details = null; }
    } else tab.commits = tab.commits.concat(page.commits);
    tab.hasMore = page.hasMore && tab.commits.length < HIST.maxCommits;
    tab.error = null;
  } catch (e) { tab.error = e.message; }
  tab.loading = false;
  renderHistory(tab);
}

// ---- Layout do grafo: raias estáveis (uma raia só muda de dono quando fica livre) ----
function layoutGraph(commits) {
  const lanes = [];
  const rows = [];
  let maxLanes = 1;
  for (const c of commits) {
    const before = lanes.slice();
    let col = before.indexOf(c.hash);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; } // início de uma linha (topo de branch)
    const incoming = [];
    before.forEach((x, k) => { if (x === c.hash) incoming.push(k); });
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) lanes[k] = null;
    const parentCols = c.parents.map((p, i) => {
      let k = lanes.indexOf(p); // outra raia já espera por esse pai → convergência
      if (k < 0) {
        if (i === 0 && (lanes[col] === null || lanes[col] === undefined)) k = col;
        else { k = lanes.indexOf(null); if (k < 0) k = lanes.length; }
        lanes[k] = p;
      }
      return k;
    });
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1);
    rows.push({ col, before, incoming, parentCols });
  }
  return { rows, maxLanes };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) { const e = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
function graphCell(row, c, width, marks) {
  const H = HIST.rowH; const W = HIST.laneW; const mid = H / 2;
  const x = (k) => k * W + W / 2;
  const svg = svgEl('svg', { width, height: H, class: 'hist-svg', 'aria-hidden': 'true' });
  const curve = (x1, y1, x2, y2) => (x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
  row.before.forEach((hsh, k) => {
    if (hsh && hsh !== c.hash) svg.append(svgEl('path', { d: `M${x(k)} 0 L${x(k)} ${H}`, stroke: laneColor(k), 'stroke-width': 2, fill: 'none' }));
  });
  for (const k of row.incoming) svg.append(svgEl('path', { d: curve(x(k), 0, x(row.col), mid), stroke: laneColor(k), 'stroke-width': 2, fill: 'none' }));
  row.parentCols.forEach((k) => svg.append(svgEl('path', { d: curve(x(row.col), mid, x(k), H), stroke: laneColor(k), 'stroke-width': 2, fill: 'none' })));
  const color = laneColor(row.col);
  if (c.parents.length > 1) svg.append(svgEl('circle', { cx: x(row.col), cy: mid, r: 6.5, fill: 'none', stroke: color, 'stroke-width': 2 })); // merge: anel duplo
  svg.append(svgEl('circle', { cx: x(row.col), cy: mid, r: marks.head ? 5.5 : 4.5, fill: marks.localOnly || marks.incoming ? 'var(--s0)' : color, stroke: marks.head ? 'var(--text)' : color, 'stroke-width': marks.head ? 2.5 : 2 }));
  return svg;
}

function refBadges(refs, { compact = false } = {}) {
  return (refs || []).filter((r) => r.type !== 'head').map((r) => h('span', {
    class: `hist-ref ${r.type}${r.current ? ' current' : ''}`,
    title: r.type === 'remote' ? `Branch remota ${r.name} (última posição conhecida — use Fetch para atualizar)` : r.type === 'tag' ? `Tag ${r.name}` : r.current ? `Branch atual (HEAD) ${r.name}` : `Branch local ${r.name}`,
  }, r.type === 'remote' ? `☁ ${r.name}` : r.type === 'tag' ? `🏷 ${r.name}` : r.current && !compact ? `● ${r.name}` : r.name));
}
const fmtWhen = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };

// ---- Cartão local × remoto ----
function syncCard(tab) {
  const d = tab.data;
  if (!d) return null;
  const up = d.upstream;
  let state;
  if (d.detached) state = h('span', { class: 'warn' }, 'HEAD destacado (fora de uma branch)');
  else if (!up) state = h('span', { class: 'muted' }, d.remotes?.length ? `Branch “${d.branch}” ainda não publicada no remoto (o Push cria ${d.remotes[0].name}/${d.branch}).` : 'Repositório só local (sem remote).');
  else if (!d.ahead && !d.behind) state = h('span', { class: 'ok' }, `✓ Sincronizado com ${up}`);
  else if (d.ahead && d.behind) state = h('span', { class: 'bad', title: 'Faça Pull (resolva conflitos, se houver) e depois Push.' }, `Divergiram: ↑ ${plural(d.ahead, 'local', 'locais')} · ↓ ${plural(d.behind, 'remoto', 'remotos')}`);
  else if (d.ahead) state = h('span', { class: 'warn' }, `${plural(d.ahead, 'commit', 'commits')} à frente de ${up} — ↑ ${d.ahead} para Push`);
  else state = h('span', { class: 'warn' }, `${plural(d.behind, 'commit', 'commits')} atrás de ${up} — ↓ ${d.behind} para Pull`);
  const rem = d.remotes?.[0];
  return h('div', { class: 'hist-sync' },
    h('div', { class: 'hist-kv' },
      h('span', null, 'Branch'), h('strong', { class: 'mono' }, d.branch || '(HEAD destacado)'),
      h('span', null, 'Remota'), h('span', { class: 'mono' }, up || '—'),
      h('span', null, 'Remote'), h('span', { class: 'mono', title: rem?.fetchUrl || '' }, rem ? `${rem.name}: ${rem.fetchUrl.replace(/^https?:\/\//, '')}` : '—'),
      h('span', null, 'Status'), h('span', null, state, d.changes ? h('span', { class: 'muted' }, ` · ${plural(d.changes, 'arquivo alterado', 'arquivos alterados')} ainda sem commit`) : null)),
    h('div', { class: 'hist-actions' },
      h('span', { class: 'muted small' }, rem ? (d.fetchedAt ? `remoto consultado ${ago(d.fetchedAt)}` : 'remoto ainda não consultado') : ''),
      rem ? h('button', { class: 'btn sm', title: 'git fetch: busca o que há no remoto SEM alterar seus arquivos', onclick: (e) => doFetch(e.target, tab.project) }, '⟳ Fetch') : null,
      rem ? h('button', { class: 'btn sm', disabled: !d.behind && !!up, title: 'git pull', onclick: (e) => doPull(e.target, tab.project) }, `⇣ Pull${d.behind ? ` (${d.behind})` : ''}`) : null,
      rem ? h('button', { class: 'btn sm', disabled: !d.ahead && !!up, title: up ? 'git push' : 'git push -u (cria a branch no remoto)', onclick: (e) => doPush(e.target, tab.project) }, `⇡ Push${d.ahead ? ` (${d.ahead})` : ''}`) : null,
      h('label', { class: 'check small', title: 'Mostrar também as outras branches locais e remotas' },
        h('input', { type: 'checkbox', checked: tab.all, onchange: (e) => { tab.all = e.target.checked; loadHistory(tab, true); } }), ' todas as branches'),
      h('button', { class: 'btn sm ghost', title: 'Recarregar', onclick: () => loadHistory(tab, true) }, '↻')));
}

// ---- Render ----
function renderHistory(tab) {
  const list = tab.el.querySelector('.hist-list');
  const keepScroll = list ? list.scrollTop : 0;
  const legend = h('div', { class: 'hist-legend small muted' },
    h('span', null, h('i', { class: 'lg head' }), ' HEAD (onde você está)'), h('span', null, h('i', { class: 'lg push' }), ' só local — aguardando Push'),
    h('span', null, h('i', { class: 'lg pull' }), ' só no remoto — aguardando Pull'), h('span', null, h('i', { class: 'lg merge' }), ' merge'));
  if (tab.error) { setKids(tab.el, syncCard(tab), h('div', { class: 'ws-note bad' }, tab.error)); return; }
  if (!tab.data) { setKids(tab.el, h('div', { class: 'ws-note' }, 'Carregando histórico…')); return; }
  const { rows, maxLanes } = layoutGraph(tab.commits);
  const width = Math.min(maxLanes, 24) * HIST.laneW + 6;
  const headHash = tab.data.head;
  const body = h('div', { class: 'hist-list', role: 'list' }, tab.commits.map((c, i) => {
    const marks = { head: c.hash === headHash, localOnly: tab.localOnly?.has(c.hash), incoming: tab.incoming?.has(c.hash) };
    const row = h('div', { class: `hist-row${tab.selected === c.hash ? ' sel' : ''}${marks.incoming ? ' incoming' : ''}`, role: 'listitem', 'data-hash': c.hash, onclick: () => selectCommit(tab, c.hash) },
      graphCell(rows[i], c, width, marks),
      h('div', { class: 'hist-main' },
        h('div', { class: 'hist-line1' },
          marks.head ? h('span', { class: 'hist-ref head', title: 'HEAD: o commit em que o seu repositório está agora' }, 'HEAD') : null,
          refBadges(c.refs),
          marks.localOnly ? h('span', { class: 'hist-flag push', title: 'Existe só neste computador: ainda não foi enviado (Push)' }, '↑ push') : null,
          marks.incoming ? h('span', { class: 'hist-flag pull', title: 'Já está no remoto (chegou pelo Fetch), mas ainda não na sua branch: aguardando Pull' }, '↓ pull') : null,
          c.parents.length > 1 ? h('span', { class: 'hist-flag merge', title: `Merge de ${c.parents.length} pais` }, 'merge') : null,
          h('span', { class: 'hist-subject', title: c.subject }, c.subject)),
        h('div', { class: 'hist-line2' }, h('span', { class: 'mono' }, c.short), h('span', null, c.author), h('span', null, fmtWhen(c.date)))));
    return row;
  }),
  tab.hasMore ? h('div', { class: 'hist-more' }, h('button', { class: 'btn sm', disabled: tab.loading, onclick: () => loadHistory(tab, false) }, tab.loading ? 'Carregando…' : `Carregar mais ${HIST.page}`), h('span', { class: 'muted small' }, ` ${tab.commits.length} carregados`))
    : h('div', { class: 'hist-more muted small' }, tab.commits.length ? `Fim do histórico · ${plural(tab.commits.length, 'commit', 'commits')}` : 'Nenhum commit ainda.'));
  tab.detailsEl ||= h('aside', { class: 'hist-details' });
  renderDetails(tab);
  setKids(tab.el, syncCard(tab), legend, h('div', { class: `hist-split${tab.selected ? ' with-details' : ''}` }, body, tab.detailsEl));
  body.scrollTop = keepScroll;
}

async function selectCommit(tab, hash) {
  tab.selected = hash;
  tab.el.querySelectorAll('.hist-row').forEach((r) => r.classList.toggle('sel', r.dataset.hash === hash));
  tab.el.querySelector('.hist-split')?.classList.add('with-details');
  tab.details = { loading: true, hash };
  renderDetails(tab);
  try { tab.details = await gitApi('GET', `/commit?hash=${hash}`, null, tab.project); } catch (e) { tab.details = { error: e.message, hash }; }
  if (tab.selected === hash) renderDetails(tab);
}

function renderDetails(tab) {
  const el = tab.detailsEl;
  if (!el) return;
  const d = tab.details;
  if (!tab.selected || !d) { setKids(el); return; }
  const close = h('button', { class: 'ws-x', title: 'Fechar detalhes', onclick: () => { tab.selected = null; tab.details = null; tab.el.querySelectorAll('.hist-row.sel').forEach((r) => r.classList.remove('sel')); tab.el.querySelector('.hist-split')?.classList.remove('with-details'); setKids(el); } }, '✕');
  if (d.loading) { setKids(el, h('div', { class: 'hist-dhead' }, h('strong', null, 'Commit'), close), h('div', { class: 'ws-note' }, 'Carregando…')); return; }
  if (d.error) { setKids(el, h('div', { class: 'hist-dhead' }, h('strong', null, 'Commit'), close), h('div', { class: 'ws-note bad' }, d.error)); return; }
  const loaded = (hsh) => tab.commits.some((c) => c.hash === hsh);
  const totals = d.files.reduce((a, f) => ({ add: a.add + (f.additions || 0), del: a.del + (f.deletions || 0) }), { add: 0, del: 0 });
  setKids(el,
    h('div', { class: 'hist-dhead' }, h('strong', null, `Commit ${d.short}`), d.merge ? h('span', { class: 'hist-flag merge' }, 'merge') : null, tab.localOnly?.has(d.hash) ? h('span', { class: 'hist-flag push' }, '↑ push') : null,
      tab.incoming?.has(d.hash) ? h('span', { class: 'hist-flag pull' }, '↓ pull') : null, h('span', { class: 'spacer' }), close),
    h('pre', { class: 'hist-msg' }, d.message || '(sem mensagem)'),
    h('div', { class: 'hist-refs' }, refBadges(d.refs)),
    h('dl', { class: 'hist-dl' },
      h('dt', null, 'Hash'), h('dd', { class: 'mono' }, d.hash, ' ', h('button', { class: 'btn sm ghost', title: 'Copiar hash', onclick: () => navigator.clipboard.writeText(d.hash).then(() => toast('Hash copiado.'), fail) }, 'Copiar')),
      h('dt', null, 'Autor'), h('dd', { title: d.email }, `${d.author} · ${fmtWhen(d.date)}`),
      d.committer && (d.committer !== d.author || d.committerDate !== d.date) ? [h('dt', null, 'Commit por'), h('dd', null, `${d.committer} · ${fmtWhen(d.committerDate)}`)] : null,
      h('dt', null, d.parents.length > 1 ? 'Pais' : 'Pai'), h('dd', null, d.parents.length ? d.parents.map((p, i) => [i ? ' ' : '', loaded(p)
        ? h('a', { href: '#', class: 'mono', title: 'Ir para este commit', onclick: (e) => { e.preventDefault(); selectCommit(tab, p); tab.el.querySelector(`.hist-row[data-hash="${p}"]`)?.scrollIntoView({ block: 'center' }); } }, p.slice(0, 7))
        : h('span', { class: 'mono' }, p.slice(0, 7))]) : h('span', { class: 'muted' }, 'nenhum (primeiro commit)'))),
    h('div', { class: 'hist-fhead' }, h('strong', null, `${plural(d.files.length, 'arquivo alterado', 'arquivos alterados')}`), h('span', { class: 'add' }, ` +${totals.add}`), h('span', { class: 'del' }, ` −${totals.del}`),
      d.merge ? h('span', { class: 'muted small' }, ' (em relação ao 1º pai: o que o merge trouxe)') : null),
    h('div', { class: 'hist-files' }, d.files.map((f) => h('div', { class: `hist-file g-${f.status === 'A' ? 'A' : f.status === 'D' ? 'D' : f.status === 'R' ? 'R' : 'M'}`, title: `${f.origPath ? `${f.origPath} → ` : ''}${f.path}\nClique para ver as diferenças`, onclick: () => openCommitDiff(d, f, tab.project) },
      h('span', { class: 'ws-gcode' }, f.status), h('span', { class: 'grow ws-cname' }, f.path.split('/').pop(), h('span', { class: 'muted small' }, ` ${f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}`)),
      f.binary ? h('span', { class: 'muted small' }, 'binário') : [h('span', { class: 'add small' }, `+${f.additions ?? 0}`), h('span', { class: 'del small' }, `−${f.deletions ?? 0}`)]))));
}

// Diferenças de um arquivo NO commit (1º pai × commit).
async function openCommitDiff(d, f, project) {
  let r;
  try { r = await gitApi('GET', `/commit-diff?${qs({ hash: d.hash, path: f.path, orig: f.origPath })}`, null, project); } catch (e) { return gitError(e); }
  showDiffModal({ title: `${f.path.split('/').pop()} — commit ${d.short}`, subtitle: `${f.origPath ? `${f.origPath} → ` : ''}${f.path} · ${d.message.split(/\r?\n/)[0]}`,
    original: r.original, modified: r.modified, labels: [r.parent ? `antes (${r.parent.slice(0, 7)})` : 'antes (vazio)', `commit ${d.short}`],
    notes: [!r.parent ? 'Primeiro commit: não há versão anterior.' : null, d.merge ? 'Merge: comparado com o 1º pai (o que o merge trouxe para a branch).' : null].filter(Boolean) });
}
