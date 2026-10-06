// Workspace — rotas. Uma pasta raiz (ex.: C:\Projetos) com VÁRIOS projetos; cada projeto pode ser um repositório Git
// independente. Camadas: rotas (aqui) → serviços (workspace-files.js para arquivos, git.js para Git). Nada de comando
// livre: cada rota faz UMA ação conhecida, com os dados validados nos serviços. A edição dos scripts fica com as
// ferramentas externas (VS Code, SSMS); aqui é gerenciamento de arquivos, cópia entre projetos e Git.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { httpError, str } = require('./util');
const { WorkspaceFiles, checkRoot, checkName, isInside, hasGit } = require('./workspace-files');
const git = require('./git');
const crypto = require('crypto');

const GIT_CONCURRENCY = 4;
// "Abrir com o aplicativo padrão" não abre executáveis/scripts do Windows (seriam EXECUTADOS, não abertos).
const BLOCK_DEFAULT_OPEN = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|hta|cpl|lnk|reg|jar|pif|appref-ms)$/i;

// VS Code instalado (Code.exe): pela pasta "bin" no PATH ou pelos locais padrão de instalação.
let vscodePath;
function findVsCode() {
  if (vscodePath !== undefined && (vscodePath === null || fs.existsSync(vscodePath))) return vscodePath;
  const cands = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (/microsoft vs code/i.test(dir) && /[\\/]bin[\\/]?$/i.test(dir)) cands.push(path.join(dir.replace(/"/g, ''), '..', 'Code.exe'));
  }
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (pf) cands.push(path.join(pf, 'Microsoft VS Code', 'Code.exe'));
  vscodePath = cands.map((c) => path.resolve(c)).find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
  return vscodePath;
}

// Executa tarefas assíncronas com no máximo N ao mesmo tempo (status Git de muitos repositórios).
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}

function mount(app, { store, audit }) {
  const cfg = () => store.data.workspace || (store.data.workspace = { root: '', aliases: {} });
  const files = () => new WorkspaceFiles(cfg().root);
  const log = (action, extra) => audit.log({ action, workspace: cfg().root, ...extra });

  // Sugestões de pasta raiz a partir do que já existe nos projetos do app (pasta raiz, diretórios das bases, repositório
  // usado antes): a pasta de cima de cada uma e a de cima dela.
  function suggestions() {
    const out = [];
    const add = (p) => { if (p && fs.existsSync(p) && !out.some((x) => x.toLowerCase() === p.toLowerCase())) { try { checkRoot(p); out.push(p); } catch { /* raiz de disco / sistema */ } } };
    for (const p of store.data.projects) {
      for (const d of [p.workspace?.gitRoot, p.workspace?.sqlRoot, p.rootDirKind === 'drive' ? null : p.rootDir, ...p.bases.map((b) => b.directory)]) {
        if (!d) continue;
        add(path.dirname(d)); add(path.dirname(path.dirname(d)));
      }
    }
    return out.slice(0, 8);
  }
  // Projetos do app ligados a uma pasta do Workspace (a pasta raiz, uma base ou o repositório do projeto estão dentro dela).
  function appProjectsFor(absDir) {
    return store.data.projects.filter((p) => [p.workspace?.gitRoot, p.workspace?.sqlRoot, p.rootDirKind === 'drive' ? null : p.rootDir, ...p.bases.map((b) => b.directory)]
      .some((d) => d && isInside(absDir, d))).map((p) => ({ id: p.id, name: p.name }));
  }

  // ---------- Configuração ----------
  app.get('/api/wsm', async (req, res) => {
    const c = cfg();
    const gv = await git.version().catch(() => ({ available: false }));
    res.json({ root: c.root || '', rootExists: !!c.root && fs.existsSync(c.root) && fs.statSync(c.root).isDirectory(), aliases: c.aliases || {}, suggestions: suggestions(), git: gv, vscode: !!findVsCode() });
  });
  app.put('/api/wsm', async (req, res) => {
    const c = cfg();
    if (req.body.root !== undefined) {
      const root = checkRoot(req.body.root);
      if (!root) throw httpError(400, 'Informe a pasta raiz do Workspace.');
      if (!fs.existsSync(root)) {
        if (!req.body.createIfMissing) throw httpError(404, `A pasta ${root} não existe.`, { code: 'WS_ROOT_MISSING' });
        fs.mkdirSync(root, { recursive: true });
      }
      if (!fs.statSync(root).isDirectory()) throw httpError(400, 'O caminho não é uma pasta.');
      if (root !== c.root) log('workspace-configurado', { anterior: c.root || undefined, pasta: root });
      c.root = root;
    }
    if (req.body.alias !== undefined) { // nome de exibição de um projeto (metadado; a pasta não muda)
      const p = str(req.body.alias.path, 500);
      files().dir(p);
      const name = str(req.body.alias.name, 80);
      c.aliases ||= {};
      if (name) c.aliases[p] = name; else delete c.aliases[p];
    }
    await store.save();
    res.json({ ok: true, root: c.root, aliases: c.aliases || {} });
  });

  // ---------- Projetos e painel de repositórios ----------
  // Resumo Git de um projeto (branch, alterações, à frente/atrás, remote). null = não é repositório.
  async function gitSummary(absDir) {
    if (!hasGit(absDir)) return null;
    try {
      const r = new git.GitRepo(absDir);
      const [st, remotes] = await Promise.all([r.status(), r.remotes()]);
      const rem = remotes.find((x) => x.name === 'origin') || remotes[0] || null;
      return { branch: st.branch, detached: st.detached, upstream: st.upstream, ahead: st.ahead, behind: st.behind, changes: st.files.length,
        conflicts: st.conflicts.length, merging: st.merging, remote: rem ? { name: rem.name, url: rem.fetchUrl, webUrl: rem.webUrl, github: rem.github } : null, fetchedAt: r.lastFetch(),
        gitignore: fs.existsSync(path.join(absDir, '.gitignore')) };
    } catch (e) { return { error: String(e.message).slice(0, 300) }; }
  }
  app.get('/api/wsm/projects', async (req, res) => {
    const ws = files();
    const list = ws.projects();
    const aliases = cfg().aliases || {};
    for (const p of list) { p.alias = aliases[p.path] || null; p.appProjects = appProjectsFor(ws.resolve(p.path)); }
    if (req.query.git === '1') await mapLimit(list, GIT_CONCURRENCY, async (p) => { p.summary = p.git ? await gitSummary(ws.resolve(p.path)) : null; });
    res.json({ root: ws.root, projects: list });
  });

  // ---------- Arquivos ----------
  app.get('/api/wsm/list', (req, res) => res.json(files().list(str(req.query.path, 1000), { all: req.query.all === '1' })));
  app.get('/api/wsm/search', (req, res) => res.json(files().search(str(req.query.q, 200), { all: req.query.all === '1', within: str(req.query.within, 1000) })));
  app.get('/api/wsm/compare', (req, res) => res.json(files().compare(str(req.query.a, 1000), str(req.query.b, 1000))));
  app.post('/api/wsm/folder', (req, res) => {
    const rel = files().createDir(str(req.body.dir, 1000), str(req.body.name, 200));
    log('workspace-pasta-criada', { pasta: rel });
    res.json({ path: rel });
  });
  app.post('/api/wsm/file', (req, res) => {
    const rel = files().createFile(str(req.body.dir, 1000), str(req.body.name, 200));
    log('workspace-arquivo-criado', { arquivo: rel });
    res.json({ path: rel });
  });
  app.post('/api/wsm/rename', (req, res) => {
    const from = str(req.body.path, 1000);
    const to = files().rename(from, str(req.body.newName, 200));
    log('workspace-renomeado', { de: from, para: to });
    res.json({ path: to });
  });
  app.post('/api/wsm/delete', async (req, res) => {
    const paths = Array.isArray(req.body.paths) ? req.body.paths.slice(0, 1000).map((p) => str(p, 1000)) : [];
    const done = await files().trash(paths);
    log('workspace-enviado-lixeira', { itens: done });
    res.json({ paths: done });
  });

  // Copiar/mover/clonar entre pastas e projetos. dryRun=true só planeja (lista conflitos). Sem dryRun, cada conflito
  // precisa de uma decisão em "resolutions"; faltando alguma, NADA é feito e os conflitos voltam (409).
  // items: [{ src, destDir, createDest? }]
  app.post('/api/wsm/transfer', async (req, res) => {
    const ws = files();
    const op = req.body.op === 'move' ? 'move' : 'copy';
    const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 1000).map((it) => ({ src: str(it?.src, 1000), destDir: str(it?.destDir, 1000), createDest: !!it?.createDest }));
    if (req.body.dryRun) {
      const plan = ws.plan(items, op);
      return res.json({ op, count: plan.count, conflicts: plan.conflicts });
    }
    const resolutions = {};
    for (const [k, v] of Object.entries(req.body.resolutions || {})) resolutions[str(k, 1000)] = str(v, 20);
    try {
      const r = await ws.transfer(items, op, resolutions);
      log(op === 'move' ? 'workspace-movido' : 'workspace-copiado', { itens: items.map((i) => i.src), destino: [...new Set(items.map((i) => i.destDir))], arquivos: r.done.length, substituidos: r.replaced.length, pulados: r.skipped.length, renomeados: r.renamed.length });
      res.json(r);
    } catch (e) {
      if (e.code === 'WS_CONFLICTS') return res.status(409).json({ error: e.message, code: e.code, conflicts: e.conflicts });
      throw e;
    }
  });

  // Abrir fora do app: VS Code (pasta do projeto + arquivo), ou recusa (sem navegador de arquivos do SO no modo Web).
  app.post('/api/wsm/open', (req, res) => {
    const ws = files();
    const rel = str(req.body.path, 1000);
    const abs = ws.resolve(rel, { allowRoot: true });
    if (!fs.existsSync(abs)) throw httpError(404, 'Não encontrado.');
    const isDir = fs.statSync(abs).isDirectory();
    const how = req.body.app;
    if (how === 'vscode') {
      const code = findVsCode();
      if (!code) throw httpError(404, 'VS Code não encontrado neste computador. Use “Abrir com aplicativo padrão”.', { code: 'NO_VSCODE' });
      const proj = isDir ? null : ws.projectOf(rel);
      const args = proj ? [ws.resolve(proj.path), abs] : [abs]; // arquivo: abre a pasta do projeto e o arquivo (Git do VS Code funciona)
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE; // o VS Code também é Electron: não pode herdar o modo "node" do app
      spawn(code, args, { detached: true, stdio: 'ignore', env }).unref();
      res.json({ ok: true });
      return;
    }
    if (how !== 'explorer' && !isDir && BLOCK_DEFAULT_OPEN.test(abs)) throw httpError(400, 'Por segurança, programas e scripts do Windows não são abertos pelo app. Use “Abrir no Explorer”.');
    throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
  });

  // ---------- Git (por projeto: cada projeto é um repositório independente) ----------
  // O projeto vem como caminho relativo à raiz (ex.: "Cliente_A" ou "Grupo/Cliente_B"); todas as operações rodam com
  // a pasta DESSE repositório como pasta de trabalho.
  const projectDir = (rel) => files().dir(str(rel, 1000), 'Projeto');
  const repoOf = (rel) => {
    const dir = projectDir(rel);
    if (!hasGit(dir)) throw httpError(400, 'Este projeto não é um repositório Git. Use “Inicializar Git” ou clone o repositório.', { code: 'GIT_NO_REPO' });
    return new git.GitRepo(dir);
  };
  const projParam = (req) => (req.method === 'GET' ? req.query.project : req.body.project);
  const G = (req) => repoOf(projParam(req));
  const logGit = (req, action, extra) => log(action, { projeto: str(projParam(req), 500), ...extra });
  const gitRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      try { logGit(req, 'git-erro', { rota: req.path.split('/').pop(), erro: String(e.message).slice(0, 300) }); } catch { /* ignora */ }
      throw e;
    }
  };

  app.get('/api/git/version', async (req, res) => res.json(await git.version()));

  app.get('/api/wsm/git', async (req, res) => {
    const gv = await git.version();
    if (!gv.available) return res.json({ available: false });
    const rel = str(req.query.project, 1000);
    const dir = projectDir(rel);
    if (!hasGit(dir)) return res.json({ available: true, version: gv.version, repo: false, project: rel });
    const r = new git.GitRepo(dir);
    const [status, branches, remotes] = await Promise.all([r.status(), r.branches(), r.remotes()]);
    const prefix = files().rel(dir);
    for (const f of status.files) f.wsPath = prefix ? `${prefix}/${f.path}` : f.path; // caminho no Workspace (para marcar na árvore)
    res.json({ available: true, version: gv.version, repo: true, project: rel, root: dir, status, branches, remotes, fetchedAt: r.lastFetch(), gitignore: fs.existsSync(path.join(dir, '.gitignore')) });
  });

  // ---------- .gitignore do repositório ----------
  // Sempre <raiz do repositório do projeto>\.gitignore: a tela só informa o projeto (validado dentro da pasta raiz), nunca um caminho.
  // Salvar exige o "hash" do conteúdo que a tela carregou: se o arquivo mudou por fora (ou foi criado nesse meio-tempo), recusa em vez de
  // sobrescrever. Preserva BOM e quebra de linha do arquivo existente.
  const GITIGNORE_MAX = 256 * 1024;
  const hashOf = (buf) => (buf ? crypto.createHash('sha256').update(buf).digest('hex') : null);
  function gitignoreFile(rel) {
    const dir = projectDir(rel);
    if (!hasGit(dir)) throw httpError(400, 'Este projeto não é um repositório Git.', { code: 'GIT_NO_REPO' });
    const file = path.join(dir, '.gitignore');
    let st = null;
    try { st = fs.lstatSync(file); } catch { /* não existe */ }
    if (st && (st.isSymbolicLink() || !st.isFile())) throw httpError(400, 'O .gitignore deste repositório não é um arquivo comum (atalho/junção); edite-o por fora.');
    if (st && st.size > GITIGNORE_MAX) throw httpError(400, 'O .gitignore é grande demais para editar pelo app.');
    return { dir, file, buf: st ? fs.readFileSync(file) : null };
  }
  app.get('/api/wsm/git/gitignore', (req, res) => {
    const { buf } = gitignoreFile(str(req.query.project, 1000));
    const text = buf ? buf.toString('utf8').replace(/^\uFEFF/, '') : '';
    res.json({ exists: !!buf, content: text.replace(/\r\n/g, '\n'), hash: hashOf(buf), eol: buf && /\r\n/.test(text) ? 'crlf' : 'lf', lines: text ? text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length : 0 });
  });
  app.put('/api/wsm/git/gitignore', gitRoute(async (req, res) => {
    const rel = str(req.body.project, 1000);
    const { file, buf } = gitignoreFile(rel);
    if ((req.body.baseHash || null) !== hashOf(buf)) throw httpError(409, 'O .gitignore foi alterado (ou criado) fora do app depois que você abriu o editor. Reabra para ver a versão atual — nada foi sobrescrito.', { code: 'GITIGNORE_CHANGED' });
    const content = String(req.body.content ?? '');
    if (content.length > GITIGNORE_MAX) throw httpError(400, 'Conteúdo grande demais.');
    if (/\u0000/.test(content)) throw httpError(400, 'Conteúdo inválido.');
    const old = buf ? buf.toString('utf8') : '';
    const eol = buf ? (/\r\n/.test(old) ? '\r\n' : '\n') : '\n';
    let out = content.replace(/\r\n?/g, '\n');
    if (out && !out.endsWith('\n')) out += '\n';
    out = out.replace(/\n/g, eol);
    const bom = buf && old.startsWith('\uFEFF') ? '\uFEFF' : '';
    fs.writeFileSync(file, bom + out, 'utf8');
    logGit(req, 'gitignore-salvo', { detalhe: `${buf ? 'alterado' : 'criado'} (${out.split(eol).filter((l) => l.trim() && !l.trim().startsWith('#')).length} padrões)` });
    res.json({ ok: true, created: !buf, hash: hashOf(fs.readFileSync(file)) });
  }));
  app.get('/api/wsm/git/summary', async (req, res) => res.json(await gitSummary(projectDir(str(req.query.project, 1000)))));

  app.post('/api/wsm/git/init', gitRoute(async (req, res) => {
    const dir = projectDir(str(req.body.project, 1000));
    if (hasGit(dir)) throw httpError(400, 'Este projeto já é um repositório Git.');
    const out = await new git.GitRepo(dir).init();
    logGit(req, 'git-init', { pasta: dir });
    res.json({ ok: true, output: out });
  }));
  // Clonar um repositório existente (GitHub etc.) como um NOVO projeto dentro da raiz (ou de uma pasta dela).
  app.post('/api/wsm/git/clone', gitRoute(async (req, res) => {
    const ws = files();
    const parent = ws.dir(str(req.body.parent, 1000));
    const name = checkName(req.body.name, 'Nome da pasta');
    ws.resolve(ws.rel(path.join(parent, name)));
    const out = await git.clone(req.body.url, parent, name);
    log('git-clone', { projeto: ws.rel(out.root), url: git.safeUrl(str(req.body.url, 500)) });
    res.json({ project: ws.rel(out.root), output: out.output });
  }));

  app.get('/api/wsm/git/diff', gitRoute(async (req, res) => { res.json(await G(req).diff(str(req.query.path, 1000), { origPath: req.query.orig ? str(req.query.orig, 1000) : undefined })); }));
  app.get('/api/wsm/git/log', gitRoute(async (req, res) => { res.json(await G(req).log(req.query.limit)); }));
  // Histórico em grafo (somente leitura): uma página de commits; na primeira página vem também a situação
  // local × remoto (à frente/atrás e quais commits), branches locais/remotas e quando o remoto foi consultado.
  app.get('/api/wsm/git/graph', gitRoute(async (req, res) => {
    const r = G(req);
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const page = await r.graph({ skip, limit: Number(req.query.limit) || 100, all: req.query.all !== '0' });
    if (skip === 0) {
      const st = await r.status();
      const [ab, branches, remoteBranches, remotes] = await Promise.all([r.aheadBehind(st.branch, st.upstream), r.branches(), r.remoteBranches(), r.remotes()]);
      Object.assign(page, { head: st.oid, branch: st.branch, detached: st.detached, upstream: st.upstream, ...ab, branches, remoteBranches, remotes, fetchedAt: r.lastFetch(), changes: st.files.length, merging: st.merging });
    }
    res.json(page);
  }));
  app.get('/api/wsm/git/commit', gitRoute(async (req, res) => { res.json(await G(req).commitDetails(str(req.query.hash, 64))); }));
  app.get('/api/wsm/git/commit-diff', gitRoute(async (req, res) => {
    res.json(await G(req).commitFileDiff(str(req.query.hash, 64), str(req.query.path, 1000), { origPath: req.query.orig ? str(req.query.orig, 1000) : undefined }));
  }));

  app.post('/api/wsm/git/fetch', gitRoute(async (req, res) => {
    const r = G(req);
    const out = await r.fetch();
    logGit(req, 'git-fetch', { repo: r.root });
    res.json(out);
  }));
  app.post('/api/wsm/git/commit', gitRoute(async (req, res) => {
    const r = G(req);
    const out = await r.commit(req.body.message, Array.isArray(req.body.paths) ? req.body.paths.slice(0, 2000) : []);
    const st = await r.status();
    logGit(req, 'git-commit', { repo: r.root, branch: st.branch, hash: out.hash, arquivos: out.files, merge: out.merge });
    res.json(out);
  }));
  app.post('/api/wsm/git/pull', gitRoute(async (req, res) => {
    const r = G(req);
    const out = await r.pull();
    logGit(req, out.conflict ? 'git-pull-conflito' : 'git-pull', { repo: r.root, conflitos: out.conflicts?.length });
    res.json(out);
  }));
  app.post('/api/wsm/git/push', gitRoute(async (req, res) => {
    const r = G(req);
    const out = await r.push();
    const st = await r.status();
    logGit(req, 'git-push', { repo: r.root, branch: st.branch, upstream: st.upstream });
    res.json(out);
  }));
  app.post('/api/wsm/git/branch', gitRoute(async (req, res) => {
    const r = G(req);
    const name = await r.createBranch(req.body.name, { checkout: req.body.checkout !== false });
    logGit(req, 'git-branch-criada', { repo: r.root, branch: name });
    res.json({ name });
  }));
  app.post('/api/wsm/git/checkout', gitRoute(async (req, res) => {
    const r = G(req);
    const name = await r.checkout(req.body.name);
    logGit(req, 'git-checkout', { repo: r.root, branch: name });
    res.json({ name });
  }));
  app.post('/api/wsm/git/branch-delete', gitRoute(async (req, res) => {
    const r = G(req);
    const name = await r.deleteBranch(req.body.name);
    logGit(req, 'git-branch-excluida', { repo: r.root, branch: name });
    res.json({ name });
  }));
  app.post('/api/wsm/git/merge', gitRoute(async (req, res) => {
    const r = G(req);
    const out = await r.merge(req.body.source);
    logGit(req, out.conflict ? 'git-merge-conflito' : 'git-merge', { repo: r.root, origem: str(req.body.source, 200), conflitos: out.conflicts?.length });
    res.json(out);
  }));
  app.post('/api/wsm/git/merge-abort', gitRoute(async (req, res) => {
    const r = G(req);
    await r.mergeAbort();
    logGit(req, 'git-merge-abortado', { repo: r.root });
    res.json({ ok: true });
  }));
  app.post('/api/wsm/git/resolve', gitRoute(async (req, res) => {
    const r = G(req);
    const file = await r.markResolved(req.body.path);
    logGit(req, 'git-conflito-resolvido', { repo: r.root, arquivo: file });
    res.json({ path: file });
  }));
  // Adicionar remote (git remote add) ou trocar a URL de um existente (git remote set-url). Trocar exige confirmação
  // explícita (confirmReplace), e um remote com o mesmo nome nunca é sobrescrito por um "adicionar".
  app.post('/api/wsm/git/remote', gitRoute(async (req, res) => {
    const r = G(req);
    const name = git.checkRemoteName(req.body.name);
    const current = (await r.remotes()).find((x) => x.name === name);
    if (current && !req.body.confirmReplace) {
      throw httpError(409, `O remote “${name}” já existe e aponta para ${current.fetchUrl}. Confirme se deseja substituir a URL.`, { code: 'GIT_REMOTE_EXISTS', current: current.fetchUrl });
    }
    if (current) await r.setRemoteUrl(name, req.body.url); else await r.addRemote(name, req.body.url);
    logGit(req, current ? 'git-remote-alterado' : 'git-remote-adicionado', { repo: r.root, remote: name, url: git.safeUrl(str(req.body.url, 500)), anterior: current ? current.fetchUrl : undefined });
    res.json({ name, replaced: !!current });
  }));
}

module.exports = { mount, findVsCode };
