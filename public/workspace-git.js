'use strict';
// Workspace — painel Git (parte de baixo da tela), sempre de UM projeto: o do último painel usado (Origem/Destino)
// ou o escolhido em "Mostrar o Git". Cada projeto é um repositório independente; o servidor roda cada comando na pasta
// DAQUELE repositório. Só ações específicas (/api/wsm/git/…) — nenhum comando livre. Login no GitHub: Git Credential
// Manager / chave SSH já configurados na máquina.

const GIT_COLOR = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'R', U: 'U', '!': 'C' };
const gitProject = () => (WM.gitProject && WM.projects.some((p) => p.path === WM.gitProject) ? WM.gitProject : WM.panes[WM.gitSide]?.project) || null;
// Chamada Git do projeto atual do painel (ou de outro, se informado).
function gitApi(method, sub, body, project = gitProject()) {
  if (method === 'GET') {
    const [p, q] = sub.split('?');
    return api('GET', `/api/wsm/git${p}?${qs({ project })}${q ? `&${q}` : ''}`);
  }
  return api(method, `/api/wsm/git${sub}`, { ...(body || {}), project });
}
const gitUi = (project) => { WM.gitUi ||= new Map(); if (!WM.gitUi.has(project)) WM.gitUi.set(project, { msg: '', unchecked: new Set() }); return WM.gitUi.get(project); };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} dia(s)`; };

// Carrega o Git de um projeto (status, branches, remotes) e atualiza o que depende dele (painel e marcas nas árvores).
async function loadGit(project) {
  if (!project) return;
  const p = projectByPath(project);
  if (p && !p.git && WM.git.has(project) && WM.git.get(project)?.repo === false) { if (project === gitProject()) renderGitPanel(); return; }
  try { WM.git.set(project, await gitApi('GET', '', null, project)); } catch (e) { WM.git.set(project, { error: e.message }); }
  if (!WM?.refs) return;
  if (project === gitProject()) renderGitPanel();
  for (const side of ['L', 'R']) if (WM.panes[side].project === project && WM.view === 'panes' && WM.paneEls) renderPane(side);
}
function showGitOf(project, side) {
  WM.gitProject = project;
  if (side) WM.gitSide = side;
  if (!WM.git.has(project)) loadGit(project);
  renderGitPanel();
  if (WM.paneEls) { renderPane('L'); renderPane('R'); }
}
// Depois de algo que muda arquivos (pull, checkout, merge…): Git, árvores e resumo do projeto.
async function afterGitChange(project = gitProject()) {
  await loadGit(project);
  await reloadPanes();
  refreshSummary(project);
  refreshHistoryPanel(project);
}

// Erros do Git: mensagem clara + a saída original (nada escondido).
function gitError(e, title = 'Erro do Git') {
  const out = e.details?.gitOutput;
  if (!out) return fail(e);
  const m = openModal({ title, wide: true, body: [h('div', { class: 'box bad' }, e.message), h('div', { class: 'lbl' }, 'Saída do Git'), h('pre', { class: 'code' }, out)],
    footer: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar')] });
}
function gitOutputDialog(title, text, extra) {
  const m = openModal({ title, wide: true, body: [extra, text ? h('pre', { class: 'code' }, text) : null], footer: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar')] });
}
async function gitAction(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { gitError(e); return null; } finally { if (btn) btn.disabled = false; }
}

// ---------- Painel ----------
function renderGitPanel() {
  const R = WM?.refs;
  if (!R) return;
  const project = gitProject();
  const p = projectByPath(project);
  const g = project ? WM.git.get(project) : null;
  const n = g?.repo ? g.status.files.length : 0;
  const open = WM_PREFS.gitOpen !== false;
  // Aba clicada com o painel recolhido: abre o painel nela.
  const tab = (key, label) => h('button', { class: `wm-gtab${open && WM.gitTab === key ? ' active' : ''}`, 'aria-pressed': String(open && WM.gitTab === key), onclick: () => { WM.gitTab = key; if (!open) setGitOpen(true); else renderGitPanel(); } }, label);
  const sideOf = isDual() ? ['L', 'R'].find((s) => WM.panes[s].project === project) : null;
  const head = h('div', { class: 'wm-githead' },
    h('button', { class: 'ws-ibtn', title: open ? 'Recolher o painel Git' : 'Expandir o painel Git', 'aria-label': open ? 'Recolher o painel Git' : 'Expandir o painel Git', 'aria-expanded': String(open), onclick: () => setGitOpen(!open) }, icon(open ? 'chevronDown' : 'chevronUp', 15)),
    h('span', { class: 'wm-gitlabel' }, icon('branch', 14), 'Git'),
    p ? h('span', { class: 'wm-gitproj', title: g?.root || project }, displayName(p), sideOf ? h('span', { class: `wm-side ${sideOf === 'L' ? 'l' : 'r'}` }, SIDE_LABEL[sideOf]) : null,
      g?.repo ? h('span', { class: 'mono wm-gitbranch' }, g.status.branch || '(destacado)') : null) : h('span', { class: 'muted small' }, 'nenhum projeto'),
    h('span', { class: 'wm-tdiv' }),
    tab('changes', ['Alterações', n ? h('span', { class: 'wm-n' }, String(n)) : null]), tab('history', 'Histórico'),
    h('span', { class: 'spacer' }),
    isDual() ? ['L', 'R'].filter((s) => WM.panes[s].project && WM.panes[s].project !== project).map((s) => h('button', { class: 'btn sm ghost', title: `Mostrar o Git do projeto da ${SIDE_LABEL[s]}`, onclick: () => showGitOf(WM.panes[s].project, s) }, `Ver ${SIDE_LABEL[s]}: ${displayName(projectByPath(WM.panes[s].project))}`)) : null,
    project ? wmIconBtn('refresh', 'Atualizar o Git deste projeto', () => { loadGit(project); refreshSummary(project); if (WM.gitTab === 'history') refreshHistoryPanel(project, true); }) : null);
  if (!open) { // recolhido: só o cabeçalho (o Git continua carregado para as marcas na árvore e o contador)
    setKids(R.gitPanel, head);
    if (project && !g) loadGit(project);
    return;
  }
  const body = h('div', { class: 'wm-gitbody' });
  setKids(R.gitPanel, head, body);
  if (!project) return setKids(body, h('div', { class: 'ws-note' }, 'Escolha um projeto para ver o Git dele.'));
  if (!g) { loadGit(project); return setKids(body, h('div', { class: 'ws-note' }, 'Carregando…')); }
  if (g.error) return setKids(body, h('div', { class: 'ws-note bad' }, g.error));
  if (!g.available) return setKids(body, h('div', { class: 'ws-note' }, h('strong', null, 'Git não instalado.'), h('div', null, 'Instale o Git para Windows (git-scm.com) e reabra o app. O app usa o Git instalado; ele não tem um Git próprio.')));
  if (!g.repo) {
    return setKids(body, h('div', { class: 'ws-note' },
      h('div', null, `“${displayName(p)}” não é um repositório Git (não há .git nesta pasta).`),
      h('div', { class: 'inline' },
        h('button', { class: 'btn sm primary', onclick: (e) => gitAction(e.target, async () => {
          if (!(await confirmDialog({ title: 'Inicializar Git', message: `Criar um repositório Git NOVO (git init) em:\n${WM.info.root}\\${project.replace(/\//g, '\\')}`, okText: 'Inicializar' }))) return;
          await gitApi('POST', '/init'); toast('Repositório Git criado.');
          p.git = true; await afterGitChange(project); renderProjectsList();
        }) }, 'Inicializar Git aqui'),
        h('button', { class: 'btn sm', title: 'Clonar um repositório que já existe no GitHub como um novo projeto do Workspace', onclick: () => cloneProjectDialog() }, 'Clonar do GitHub como novo projeto…')),
      h('div', { class: 'muted small' }, `Git ${g.version}`)));
  }
  if (WM.gitTab === 'history') return renderHistoryPanel(body, project);
  renderGitChanges(body, project, g);
}

function renderGitChanges(body, project, g) {
  const st = g.status;
  const ui = gitUi(project);
  const files = st.files;
  const selected = files.filter((f) => !f.conflict && !ui.unchecked.has(f.path));
  const msg = h('textarea', { class: 'ws-commitmsg', rows: 3, placeholder: st.merging ? 'Mensagem do commit do merge (vazio = mensagem padrão do Git)' : 'Mensagem do commit (ex.: Ajusta migração PFUNC)', value: ui.msg, oninput: (e) => { ui.msg = e.target.value; } });
  const commitBtn = h('button', { class: 'btn sm primary', disabled: st.conflicts.length > 0 || (!selected.length && !st.merging), onclick: (e) => doCommit(e.target, project) }, st.merging ? '✔ Concluir merge (commit)' : `✔ Commit (${selected.length})`);
  msg.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commitBtn.click(); } });
  const allBox = h('input', { type: 'checkbox', title: 'Marcar/desmarcar todos', checked: files.length > 0 && selected.length === files.filter((f) => !f.conflict).length, onchange: (e) => {
    for (const f of files) if (e.target.checked) ui.unchecked.delete(f.path); else ui.unchecked.add(f.path);
    renderGitPanel();
  } });
  const menu = h('button', { class: 'btn sm ghost', title: 'Mais ações do Git', onclick: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: 'Branches (trocar / criar / excluir)…', run: () => wsGitBranchesDialog() },
      { label: 'Merge de outra branch na atual…', run: () => wsGitBranchesDialog('merge') },
      { label: 'Histórico (lista simples)…', run: () => gitLogDialog() },
      { label: 'Repositório e GitHub (remote)…', run: () => repoDialog() },
      '-',
      { label: 'Abrir o projeto no VS Code', disabled: !WM.info.vscode, run: () => openExternal(project, 'vscode') },
      { label: 'Abrir a pasta do repositório', run: () => openExternal(project, 'explorer') },
    ]);
  } }, icon('more', 14), 'Mais');
  setKids(body, h('div', { class: 'wm-gitcols' },
    h('div', { class: 'wm-gitleft' },
      repoCard(g),
      h('div', { class: 'ws-gitbar' },
        h('button', { class: 'btn sm ws-branch', title: 'Trocar / criar branch', onclick: () => wsGitBranchesDialog() }, icon('branch', 14), st.branch || '(HEAD destacado)'),
        h('span', { class: 'spacer' }),
        mainRemote(g) ? h('button', { class: 'btn sm', title: 'git fetch: busca o que há de novo no remoto sem alterar seus arquivos', onclick: (e) => doFetch(e.currentTarget, project) }, icon('refresh', 14), 'Fetch') : null,
        h('button', { class: 'btn sm', title: 'git pull', disabled: !mainRemote(g), onclick: (e) => doPull(e.currentTarget, project) }, icon('download', 14), `Pull${st.behind ? ` (${st.behind})` : ''}`),
        h('button', { class: 'btn sm', title: st.upstream ? 'git push' : 'git push -u (cria a branch no remoto)', disabled: !mainRemote(g), onclick: (e) => doPush(e.currentTarget, project) }, icon('upload', 14), `Push${st.ahead ? ` (${st.ahead})` : ''}`),
        menu),
      st.merging || st.rebasing ? h('div', { class: 'box warn ws-mergebox' }, h('strong', null, st.rebasing ? 'Rebase em andamento.' : `Merge em andamento${st.conflicts.length ? ` — ${plural(st.conflicts.length, 'arquivo em conflito', 'arquivos em conflito')}` : ' — conflitos resolvidos, falta o commit'}.`),
        h('div', { class: 'small' }, st.conflicts.length ? 'Abra cada arquivo (VS Code), escolha o que fica entre <<<<<<< e >>>>>>>, salve e clique em “Resolvido”.' : 'Escreva (ou não) a mensagem e clique em “Concluir merge”.'),
        st.merging ? h('button', { class: 'btn sm danger', onclick: (e) => doMergeAbort(e.target, project) }, 'Abortar merge') : null) : null,
      h('div', { class: 'ws-commit' }, msg, h('div', { class: 'inline' }, commitBtn, h('span', { class: 'muted small' }, 'Ctrl+Enter · só os arquivos marcados')))),
    h('div', { class: 'wm-gitright' },
      h('div', { class: 'ws-changes-head' }, allBox, h('strong', null, `Alterações (${files.length})`), h('span', { class: 'muted small' }, 'clique para ver as diferenças')),
      h('div', { class: 'ws-changes' }, files.length ? files.map((f) => changeRow(f, project)) : h('div', { class: 'ws-note' }, 'Nenhuma alteração: tudo commitado.')))));
}

// ---------- Repositório: pasta, branch, remote/GitHub e situação (local × remoto) ----------
const mainRemote = (g) => g.remotes.find((x) => x.name === 'origin') || g.remotes[0] || null;
function syncSummary(g) {
  const st = g.status;
  const parts = [];
  const mod = st.files.filter((f) => !f.untracked && !f.conflict).length;
  const novos = st.files.filter((f) => f.untracked).length;
  if (st.conflicts.length) parts.push({ t: plural(st.conflicts.length, 'arquivo em conflito', 'arquivos em conflito'), k: 'bad' });
  if (mod) parts.push({ t: plural(mod, 'arquivo modificado', 'arquivos modificados'), k: 'warn' });
  if (novos) parts.push({ t: plural(novos, 'arquivo novo', 'arquivos novos'), k: 'warn' });
  if (st.ahead && st.behind) parts.push({ t: `divergiram: ↑ ${st.ahead} · ↓ ${st.behind}`, k: 'bad' });
  else if (st.ahead) parts.push({ t: `↑ ${plural(st.ahead, 'commit aguardando Push', 'commits aguardando Push')}`, k: 'warn' });
  else if (st.behind) parts.push({ t: `↓ ${plural(st.behind, 'commit aguardando Pull', 'commits aguardando Pull')}`, k: 'warn' });
  if (!g.remotes.length) parts.push({ t: 'repositório só local (sem remote)', k: 'muted' });
  else if (st.branch && !st.upstream) parts.push({ t: 'branch ainda não publicada no remoto', k: 'muted' });
  if (!parts.length) parts.push({ t: '✓ Sincronizado', k: 'ok' });
  return parts;
}
function repoCard(g) {
  const st = g.status;
  const rem = mainRemote(g);
  return h('div', { class: 'ws-repo' },
    h('div', { class: 'ws-kv' },
      h('span', null, 'Repositório'), h('span', { class: 'mono', title: `${g.root}\nTodas as operações Git deste projeto rodam nesta pasta — o repositório inteiro.` }, g.root),
      h('span', null, 'Branch'), h('span', { class: 'mono' }, st.branch || '(HEAD destacado)', st.upstream ? h('span', { class: 'muted' }, ` → ${st.upstream}`) : null),
      h('span', null, 'Remote'), rem ? h('span', { class: 'mono', title: rem.fetchUrl }, `${rem.name}: ${rem.fetchUrl.replace(/^https?:\/\//, '')}`, rem.webUrl ? [' ', h('a', { href: rem.webUrl, target: '_blank', rel: 'noopener noreferrer' }, 'abrir no GitHub')] : null)
        : h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); repoDialog(); } }, 'associar repositório do GitHub…')),
      h('span', null, 'Status'), h('span', { class: 'ws-sync' }, syncSummary(g).map((x, i) => [i ? ' · ' : '', h('span', { class: x.k }, x.t)])),
      h('span', null, 'GitIgnore'), h('span', { class: 'ws-sync' }, g.gitignore
        ? [h('span', { class: 'ok' }, '✓ configurado'), ' ', h('a', { href: '#', title: 'Editar <raiz do repositório>\\.gitignore', onclick: (e) => { e.preventDefault(); gitignoreDialog(g.project); } }, 'editar')]
        : [h('span', { class: 'warn' }, '⚠ não encontrado'), ' ', h('a', { href: '#', title: 'Criar .gitignore na raiz do repositório', onclick: (e) => { e.preventDefault(); gitignoreDialog(g.project); } }, 'Criar .gitignore')])),
    rem ? h('div', { class: 'small muted' }, g.fetchedAt ? `remoto consultado ${ago(g.fetchedAt)}` : 'remoto ainda não consultado — use Fetch para comparar com o GitHub') : null);
}

// ---------- .gitignore (sempre na raiz do repositório do projeto; o caminho nunca sai da tela) ----------
const GITIGNORE_PRESETS = {
  'Temporários': ['*.tmp', '*.temp', '*.bak', '*.swp', '~$*', '*.xlsx#'],
  'Logs': ['*.log', 'logs/'],
  'VS Code': ['.vscode/', '*.code-workspace'],
  'Windows': ['Thumbs.db', 'desktop.ini', '$RECYCLE.BIN/'],
  'Segredos': ['.env', '.env.*', '*.pem', '*.key'],
  'Node': ['node_modules/', 'npm-debug.log*', 'dist/', 'build/'],
  'Python': ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '*.egg-info/'],
  'Migração': ['evidencias/temp/', '*.bak', 'exportacoes/', 'backup/'],
};
async function gitignoreDialog(project) {
  let cur;
  try { cur = await gitApi('GET', '/gitignore', null, project); } catch (e) { return gitError(e); }
  const ta = h('textarea', { class: 'mono gi-text', spellcheck: 'false', rows: 14, placeholder: '# um padrão por linha, ex.:\n*.log\n.env\n.vscode/' }, cur.content);
  const preview = h('div');
  const err = h('div');
  const has = () => new Set(ta.value.split('\n').map((l) => l.trim()).filter(Boolean));
  // Sugestão: mostra o que seria ACRESCENTADO (só linhas que ainda não existem) e só aplica ao confirmar — nunca substitui o conteúdo.
  const suggest = (name) => {
    const missing = GITIGNORE_PRESETS[name].filter((l) => !has().has(l));
    if (!missing.length) { preview.replaceChildren(h('div', { class: 'small muted' }, `Os padrões de “${name}” já estão no arquivo.`)); return; }
    preview.replaceChildren(h('div', { class: 'box small stack' }, h('strong', null, `Acrescentar ${plural(missing.length, 'padrão', 'padrões')} de “${name}” ao final:`),
      h('pre', { class: 'mono', style: 'margin:0' }, missing.join('\n')),
      h('div', { class: 'inline' }, h('button', { class: 'btn sm primary', onclick: () => {
        const base = ta.value.replace(/\s*$/, '');
        ta.value = `${base}${base ? '\n\n' : ''}# ${name}\n${missing.join('\n')}\n`;
        preview.replaceChildren(); ta.focus();
      } }, 'Acrescentar'), h('button', { class: 'btn sm', onclick: () => preview.replaceChildren() }, 'Cancelar'))));
  };
  const save = h('button', { class: 'btn primary' }, cur.exists ? 'Salvar' : 'Criar .gitignore');
  save.addEventListener('click', () => busy(save, async () => {
    err.replaceChildren();
    try {
      await gitApi('PUT', '/gitignore', { content: ta.value, baseHash: cur.hash }, project);
      m.close(); toast(cur.exists ? '.gitignore salvo.' : '.gitignore criado.'); afterGitChange(project);
    } catch (e) {
      err.replaceChildren(h('div', { class: 'box bad small' }, e.message, e.code === 'GITIGNORE_CHANGED' ? [' ', h('button', { class: 'btn sm', onclick: () => { m.close(); gitignoreDialog(project); } }, 'Reabrir com a versão atual')] : null));
    }
  }, 'Salvando…'));
  const m = openModal({ title: `.gitignore — ${displayName(projectByPath(project)) || project}`, size: 'md',
    body: [h('div', { class: 'small muted' }, cur.exists ? `Arquivo na raiz do repositório (${plural(cur.lines, 'padrão', 'padrões')}). Suas alterações só são gravadas ao salvar.` : 'Este repositório ainda não tem .gitignore. Ele será criado na raiz do repositório.'),
      h('div', { class: 'inline' }, h('span', { class: 'small muted' }, 'Sugestões:'), Object.keys(GITIGNORE_PRESETS).map((n) => h('button', { class: 'btn xs', title: GITIGNORE_PRESETS[n].join('  '), onclick: () => suggest(n) }, n))),
      preview, ta, err],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), save] });
  ta.focus();
}

function changeRow(f, project) {
  const ui = gitUi(project);
  const name = f.path.split('/').pop();
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  const box = h('input', { type: 'checkbox', disabled: f.conflict, checked: !f.conflict && !ui.unchecked.has(f.path), title: 'Incluir no commit', onclick: (e) => e.stopPropagation(), onchange: (e) => {
    if (e.target.checked) ui.unchecked.delete(f.path); else ui.unchecked.add(f.path);
    renderGitPanel();
  } });
  return h('div', { class: `ws-change g-${GIT_COLOR[f.code] || 'M'}`, title: `${f.path} — ${f.label}${f.origPath ? ` (era ${f.origPath})` : ''}\nClique para ver as diferenças`, onclick: () => openDiff(f, project) },
    box, h('span', { class: 'grow ws-cname' }, name, dir ? h('span', { class: 'muted small' }, ` ${dir}`) : null),
    f.conflict ? [h('button', { class: 'btn sm', disabled: !WM.info.vscode, title: 'Abrir no VS Code para resolver', onclick: (e) => { e.stopPropagation(); openExternal(f.wsPath, 'vscode'); } }, 'Abrir'),
      h('button', { class: 'btn sm primary', title: 'Marcar como resolvido (git add)', onclick: (e) => { e.stopPropagation(); doResolve(e.target, f, project); } }, 'Resolvido')]
      : f.code !== 'D' ? wmIconBtn('external', WM.info.vscode ? 'Abrir no VS Code' : 'Abrir com aplicativo padrão', (e) => { e.stopPropagation(); openExternal(f.wsPath, WM.info.vscode ? 'vscode' : 'default'); }) : null,
    h('span', { class: 'ws-gcode' }, f.code));
}

// Diferenças: versão do último commit (HEAD) × arquivo atual no disco.
async function openDiff(f, project) {
  let d;
  try { d = await gitApi('GET', `/diff?${qs({ path: f.path, orig: f.origPath })}`, null, project); } catch (e) { return gitError(e); }
  showDiffModal({ title: `${f.path.split('/').pop()} — ${f.label}`, subtitle: f.path, original: d.original, modified: d.modified, labels: ['último commit', 'disco agora'],
    notes: [!d.inHead ? 'Arquivo novo: não existe no último commit.' : null, !d.exists ? 'Arquivo excluído: não existe mais no disco.' : null].filter(Boolean) });
}

async function doCommit(btn, project) {
  const g = WM.git.get(project);
  const st = g.status;
  const ui = gitUi(project);
  const paths = st.files.filter((f) => !f.conflict && !ui.unchecked.has(f.path)).map((f) => f.path);
  const message = (ui.msg || '').trim() || (st.merging ? 'Merge' : '');
  if (!message) return toast('Escreva a mensagem do commit.', 'error');
  await gitAction(btn, async () => {
    const r = await gitApi('POST', '/commit', { message, paths }, project);
    ui.msg = '';
    for (const p of paths) ui.unchecked.delete(p);
    toast(`Commit ${r.hash} criado (${plural(r.files, 'arquivo', 'arquivos')}).`);
    await afterGitChange(project);
  });
}
async function doFetch(btn, project) {
  await gitAction(btn, async () => { await gitApi('POST', '/fetch', {}, project); toast('Remoto consultado (fetch). Nada foi alterado nos seus arquivos.'); await afterGitChange(project); });
}
async function doPull(btn, project) {
  await gitAction(btn, async () => {
    const r = await gitApi('POST', '/pull', {}, project);
    await afterGitChange(project);
    if (r.conflict) conflictDialog('Pull com conflitos', r);
    else toast(r.setUpstream ? 'Pull concluído — a branch passou a acompanhar a do remoto.' : 'Pull concluído.');
  });
}
async function doPush(btn, project) {
  await gitAction(btn, async () => {
    const r = await gitApi('POST', '/push', {}, project);
    toast(r.setUpstream ? 'Push concluído — branch criada no remoto e ligada (upstream).' : 'Push concluído.');
    await afterGitChange(project);
  });
}
async function doResolve(btn, f, project) {
  await gitAction(btn, async () => { await gitApi('POST', '/resolve', { path: f.path }, project); toast(`${f.path.split('/').pop()} marcado como resolvido.`); await afterGitChange(project); });
}
async function doMergeAbort(btn, project) {
  if (!(await confirmDialog({ title: 'Abortar merge', message: 'Desfazer o merge em andamento (git merge --abort)? Os arquivos voltam ao estado de antes do merge; edições feitas nos arquivos em conflito serão perdidas.', okText: 'Abortar merge', danger: true }))) return;
  await gitAction(btn, async () => { await gitApi('POST', '/merge-abort', {}, project); await afterGitChange(project); toast('Merge abortado.'); });
}
function conflictDialog(title, r) {
  WM.gitTab = 'changes'; renderGitPanel();
  gitOutputDialog(title, r.output, h('div', { class: 'box warn' }, h('strong', null, `${plural(r.conflicts.length, 'arquivo ficou', 'arquivos ficaram')} em conflito:`),
    h('ul', null, r.conflicts.map((c) => h('li', { class: 'mono' }, c))),
    h('div', { class: 'small' }, 'O Git parou o processo. No painel Git (Alterações): abra cada arquivo no VS Code, resolva os trechos entre <<<<<<< e >>>>>>>, salve, clique em “Resolvido” e depois em “Concluir merge”. Ou use “Abortar merge”.')));
}

// ---------- Branches e merge ----------
async function wsGitBranchesDialog(focus) {
  const project = gitProject();
  const g = WM.git.get(project);
  if (!g?.repo) return;
  const cur = g.status.branch;
  const dirtyNote = g.status.files.length ? h('div', { class: 'box warn small' }, `Há ${plural(g.status.files.length, 'arquivo alterado', 'arquivos alterados')} sem commit: o Git pode recusar trocar de branch ou fazer merge até você fazer commit.`) : null;
  const list = h('div', { class: 'stack' }, g.branches.map((b) => h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('strong', { class: 'mono' }, b.name), b.current ? h('span', { class: 'pill ok', style: 'margin-left:8px' }, 'atual') : null,
      h('div', { class: 'small muted' }, b.upstream ? `${b.upstream} ${b.track}` : 'sem branch remota')),
    h('div', { class: 'actions' },
      !b.current ? h('button', { class: 'btn sm primary', onclick: (e) => gitAction(e.target, async () => {
        await gitApi('POST', '/checkout', { name: b.name }, project); md.close(); await afterGitChange(project); toast(`Agora na branch ${b.name}.`);
      }) }, 'Trocar') : null,
      !b.current ? h('button', { class: 'btn sm ghost', onclick: (e) => gitAction(e.target, async () => {
        if (!(await confirmDialog({ title: 'Excluir branch', message: `Excluir a branch local “${b.name}”? (O Git recusa se ela tiver commits que não estão em outra branch.)`, okText: 'Excluir', danger: true }))) return;
        await gitApi('POST', '/branch-delete', { name: b.name }, project); md.close(); await afterGitChange(project); toast(`Branch ${b.name} excluída.`);
      }) }, 'Excluir') : null))));
  const newName = h('input', { type: 'text', placeholder: 'ex.: feature/importacao' });
  const sw = h('input', { type: 'checkbox', checked: true });
  const create = h('button', { class: 'btn primary', onclick: (e) => gitAction(e.target, async () => {
    const r = await gitApi('POST', '/branch', { name: newName.value.trim(), checkout: sw.checked }, project); md.close(); await afterGitChange(project); toast(`Branch ${r.name} criada${sw.checked ? ' (atual)' : ''}.`);
  }) }, 'Criar branch');
  const others = g.branches.filter((b) => !b.current);
  const src = h('select', null, others.map((b) => h('option', { value: b.name }, b.name)));
  const mergeBtn = h('button', { class: 'btn', disabled: !others.length || !cur, onclick: (e) => gitAction(e.target, async () => {
    if (!(await confirmDialog({ title: 'Merge', message: `Trazer as alterações de “${src.value}” para a branch atual “${cur}” (git merge ${src.value})?`, okText: 'Fazer merge' }))) return;
    const r = await gitApi('POST', '/merge', { source: src.value }, project); md.close(); await afterGitChange(project);
    if (r.conflict) conflictDialog('Merge com conflitos', r); else gitOutputDialog('Merge concluído', r.output);
  }) }, 'Merge na branch atual');
  const mergeBox = h('div', { class: 'box', style: 'display:grid;gap:8px' }, h('strong', null, `Merge em “${cur || '—'}”`),
    others.length ? h('div', { class: 'inline' }, h('span', null, 'Trazer de'), src, mergeBtn) : h('div', { class: 'muted small' }, 'Não há outra branch local.'),
    h('div', { class: 'hint' }, 'Em conflito, o merge para e os arquivos aparecem em Alterações para resolver.'));
  const md = openModal({
    title: `Branches — ${displayName(projectByPath(project))}`, wide: true,
    body: [h('div', { class: 'muted' }, `Branch atual: ${cur || '(HEAD destacado)'}`), dirtyNote, list,
      h('div', { class: 'box', style: 'display:grid;gap:8px' }, h('strong', null, 'Nova branch (a partir da atual)'), h('div', { class: 'inline' }, newName, create), h('label', { class: 'check' }, sw, ' trocar para ela')),
      mergeBox],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Fechar')],
  });
  if (focus === 'merge') mergeBox.scrollIntoView(); else newName.focus();
}

async function gitLogDialog() {
  let log;
  try { log = await gitApi('GET', '/log?limit=200'); } catch (e) { return gitError(e); }
  const md = openModal({ title: 'Histórico de commits', wide: true,
    body: [log.length ? h('div', { class: 'tablewrap', style: 'max-height:60vh' }, h('table', null,
      h('thead', null, h('tr', null, ['Hash', 'Data', 'Autor', 'Mensagem'].map((t) => h('th', null, t)))),
      h('tbody', null, log.map((c) => h('tr', null, h('td', { class: 'mono', title: c.hash }, c.short), h('td', { class: 'small' }, new Date(c.date).toLocaleString('pt-BR')), h('td', { title: c.email }, c.author), h('td', null, c.subject))))))
      : h('div', { class: 'empty' }, 'Nenhum commit ainda.')],
    footer: [h('button', { class: 'btn primary', onclick: () => md.close() }, 'Fechar')] });
}

// ---------- Repositório e GitHub (remote) ----------
// Associa o repositório local a um repositório remoto EXISTENTE (git remote add). Um remote que já existe nunca é
// substituído sem confirmação: o servidor recusa (409) e a tela pergunta, mostrando a URL atual.
function repoDialog() {
  const project = gitProject();
  const g = WM.git.get(project);
  if (!g?.repo) return;
  const rem = mainRemote(g);
  const name = h('input', { type: 'text', value: rem ? rem.name : 'origin', placeholder: 'origin' });
  const url = h('input', { type: 'text', value: '', placeholder: 'https://github.com/meuusuario/cliente-a.git' });
  const md = openModal({ title: `Repositório e GitHub — ${displayName(projectByPath(project))}`, wide: true,
    body: [
      h('dl', { class: 'kv', style: 'margin:0;grid-template-columns:130px minmax(0,1fr)' },
        h('dt', null, 'Repositório local'), h('dd', { class: 'mono' }, g.root),
        h('dt', null, 'Branch'), h('dd', { class: 'mono' }, `${g.status.branch || '(HEAD destacado)'}${g.status.upstream ? ` → ${g.status.upstream}` : ' (sem upstream)'}`),
        h('dt', null, 'Status'), h('dd', null, syncSummary(g).map((x) => x.t).join(' · '))),
      h('div', { class: 'lbl' }, 'Remotes'),
      g.remotes.length ? h('div', { class: 'stack' }, g.remotes.map((r) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('strong', null, r.name), r.github ? h('span', { class: 'pill done', style: 'margin-left:8px' }, 'GitHub') : null,
          h('div', { class: 'mono small' }, r.fetchUrl), r.pushUrl && r.pushUrl !== r.fetchUrl ? h('div', { class: 'mono small muted' }, `push: ${r.pushUrl}`) : null),
        r.webUrl ? h('a', { class: 'btn sm', href: r.webUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir no GitHub') : null,
        h('button', { class: 'btn sm ghost', onclick: () => { name.value = r.name; url.value = ''; url.placeholder = r.fetchUrl; url.focus(); } }, 'Alterar URL…'))))
        : h('div', { class: 'muted' }, 'Nenhum remote: o repositório é só local (commit, branch, merge e histórico funcionam normalmente). Para Pull/Push, informe abaixo a URL do repositório que já existe no GitHub.'),
      h('div', { class: 'box', style: 'display:grid;gap:8px' }, h('strong', null, rem ? 'Adicionar outro remote ou alterar a URL de um existente' : 'Conectar a um repositório existente (git remote add)'),
        h('div', { class: 'cols2', style: 'grid-template-columns:minmax(0,1fr) minmax(0,3fr)' }, field('Nome', name), field('URL', url))),
      h('div', { class: 'hint' }, 'Autenticação: o app só executa o Git; quem faz o login é o mecanismo já configurado na máquina — Git Credential Manager (HTTPS) ou sua chave SSH (git@github.com:…). O app não guarda usuário, senha nem token.'),
    ],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Fechar'),
      h('button', { class: 'btn primary', onclick: (e) => gitAction(e.target, async () => {
        const body = { name: name.value.trim(), url: url.value.trim() };
        let r;
        try { r = await gitApi('POST', '/remote', body, project); } catch (err) {
          if (err.code !== 'GIT_REMOTE_EXISTS') throw err;
          const ok = await confirmDialog({ title: 'Substituir URL do remote', danger: true, okText: 'Substituir',
            message: `O remote “${body.name}” já existe:\n${err.details?.current || ''}\n\nSubstituir por:\n${body.url}` });
          if (!ok) return;
          r = await gitApi('POST', '/remote', { ...body, confirmReplace: true }, project);
        }
        md.close(); await afterGitChange(project);
        toast(r.replaced ? `URL do remote “${r.name}” substituída.` : `Remote “${r.name}” adicionado. Use Pull para trazer o que já existe nele, ou Push para publicar a branch.`);
      }) }, 'Salvar remote')] });
  url.focus();
}

// Clonar um repositório existente (ex.: do GitHub) como um NOVO projeto dentro da raiz do Workspace.
function cloneProjectDialog() {
  const url = h('input', { type: 'text', placeholder: 'https://github.com/meuusuario/cliente-a.git' });
  const name = h('input', { type: 'text', placeholder: 'Cliente_A' });
  const groups = [...new Set(WM.projects.map((p) => p.group).filter(Boolean))];
  const parent = h('select', null, h('option', { value: '' }, `(raiz) ${WM.info.root}`), groups.map((g) => h('option', { value: g }, g)));
  url.addEventListener('input', () => { if (!name.dataset.touched) { const m = url.value.trim().match(/([^/:]+?)(?:\.git)?\/?$/); name.value = m ? m[1] : ''; } });
  name.addEventListener('input', () => { name.dataset.touched = '1'; });
  const md = openModal({ title: 'Clonar repositório como novo projeto', wide: true,
    body: [field('URL do repositório', url, 'HTTPS ou SSH. O login é feito pelo Git Credential Manager (ou sua chave SSH); o app não guarda senha nem token.'),
      h('div', { class: 'cols2' }, field('Criar dentro de', parent), field('Nome da pasta do projeto', name)),
      h('div', { class: 'hint' }, 'O app executa git clone para uma pasta NOVA dentro do Workspace; ela passa a aparecer na lista de projetos.')],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => gitAction(e.target, async () => {
        toast('Clonando… (pode abrir a janela de login do GitHub)');
        const r = await api('POST', '/api/wsm/git/clone', { url: url.value.trim(), parent: parent.value, name: name.value.trim() });
        md.close(); await loadProjects(); setPaneProject('L', r.project); showGitOf(r.project, 'L'); renderAll();
        toast(`Repositório clonado em ${r.project}.`);
      }) }, 'Clonar')] });
  url.focus();
}
