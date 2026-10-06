// SQL Workspace — serviço Git. Usa o Git INSTALADO na máquina (nada de Git próprio) e só expõe ações específicas:
// não existe "executar comando" genérico. Cada método monta os argumentos aqui dentro, com validação dos dados
// variáveis (nome de branch, caminhos, URL de remote), e roda o git SEM shell (argumentos em lista).
// Autenticação (push/pull no GitHub): fica com o Git Credential Manager já configurado no Git; o app não guarda
// usuário, senha nem token.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { httpError } = require('./util');
const { decodeSqlBuffer } = require('./sqlscan');

const LOCAL_TIMEOUT = 60 * 1000;
const NETWORK_TIMEOUT = 5 * 60 * 1000; // push/pull podem abrir a janela de login do Git Credential Manager
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 10 * 1024 * 1024;

// ---- Localização do git ----
let gitPath = null;
function candidates() {
  const list = [];
  const gitBin = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) if (dir) list.push(path.join(dir.replace(/"/g, ''), gitBin));
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) list.push(path.join(base, 'Git', 'cmd', 'git.exe'));
  }
  return list;
}
function findGit() {
  if (gitPath && fs.existsSync(gitPath)) return gitPath;
  gitPath = candidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return gitPath;
}

// Executa o git com argumentos fixos. Nunca lança por código de saída ≠ 0: devolve { code, stdout, stderr }.
function run(cwd, args, { timeoutMs = LOCAL_TIMEOUT, input, raw = false } = {}) {
  const exe = findGit();
  if (!exe) return Promise.reject(httpError(503, 'Git não encontrado neste computador. Instale o Git para Windows (git-scm.com) e reabra o app.', { code: 'GIT_MISSING' }));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'core.pager=cat', ...args], {
      cwd, windowsHide: true, shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: process.env.LANG || 'pt_BR.UTF-8' },
    });
    const out = [];
    const err = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(httpError(504, `O Git não respondeu em ${Math.round(timeoutMs / 1000)} s (git ${args[0]}). Se uma janela de login do GitHub abriu, conclua o login e tente de novo.`)); }, timeoutMs);
    child.stdout.on('data', (d) => { size += d.length; if (size <= MAX_OUTPUT) out.push(d); });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      // O Windows não inicia processos numa pasta com caminho de mais de ~260 caracteres (e o Git também não entra nela).
      if (e.code === 'ENOENT' && String(cwd).length >= 248) return reject(httpError(400, `O caminho da pasta é longo demais para o Git no Windows (${String(cwd).length} caracteres; limite de 260). Use uma pasta com caminho mais curto.`, { code: 'GIT_LONG_PATH' }));
      reject(httpError(500, `Falha ao iniciar o Git: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      resolve({ code, stdout: raw ? stdoutBuf : stdoutBuf.toString('utf8'), stderr: Buffer.concat(err).toString('utf8').trim(), truncated: size > MAX_OUTPUT });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// Uma linha "1"/"2" do status v2 → arquivo alterado. XY = situação no índice (staged) e na pasta de trabalho.
const CODE_LABEL = { M: 'modificado', T: 'modificado', A: 'adicionado', D: 'excluído', R: 'renomeado', C: 'copiado' };
function entry(xy, p) {
  const c = xy[1] !== '.' ? xy[1] : xy[0];
  const code = c === 'T' ? 'M' : c;
  return { path: p, xy, code, label: CODE_LABEL[c] || c, staged: xy[0] !== '.' };
}

const gitError = (r, fallback) => {
  const raw = (r.stderr || r.stdout || fallback || 'O Git retornou um erro.').trim();
  const msg = /Filename too long/i.test(raw) ? `Caminho longo demais para o Git no Windows (limite de 260 caracteres). Habilite caminhos longos (git config --global core.longpaths true) ou use uma pasta mais curta.\n${raw}` : raw;
  return httpError(400, msg.slice(0, 4000), { code: 'GIT_ERROR', gitOutput: `${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(0, 20000) });
};
async function ok(cwd, args, opts) {
  const r = await run(cwd, args, opts);
  if (r.code !== 0) throw gitError(r);
  return r;
}

// ---- Validações dos dados que entram nos argumentos ----
async function checkBranchName(cwd, name) {
  const n = String(name ?? '').trim();
  if (!n || n.startsWith('-') || n.length > 200) throw httpError(400, 'Nome de branch inválido.');
  const r = await run(cwd, ['check-ref-format', '--branch', n]);
  if (r.code !== 0) throw httpError(400, `Nome de branch inválido: “${n}” (sem espaços, “..”, “~”, “^”, “:”, “?”, “*”, “[”, nem terminar com “/” ou “.lock”).`);
  return n;
}
function checkRemoteName(name) {
  const n = String(name ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n)) throw httpError(400, 'Nome de remote inválido (ex.: origin).');
  return n;
}
function checkRemoteUrl(url) {
  const u = String(url ?? '').trim();
  const okUrl = /^https:\/\/[^\s"'`<>]+$/i.test(u) || /^ssh:\/\/[^\s"'`<>]+$/i.test(u) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s"'`<>]+$/.test(u) || /^file:\/\/\/[^\s"'`<>]+$/i.test(u);
  if (!okUrl || u.startsWith('-') || u.length > 500) throw httpError(400, 'URL de remote inválida. Use https://github.com/usuario/repositorio.git (ou SSH git@github.com:usuario/repositorio.git).');
  return u;
}

class GitRepo {
  // root = pasta raiz do repositório (onde fica o .git), já validada por quem chama.
  constructor(root) { this.root = root; }

  // Caminho relativo ao repositório (o que o git status devolve) → validado dentro do repositório.
  checkPath(rel) {
    const r = String(rel ?? '').replace(/\\/g, '/');
    if (!r || r.includes('\0') || r.startsWith('/') || /^[a-zA-Z]:/.test(r) || r.startsWith('-') || r.split('/').includes('..') || r.split('/')[0] === '.git') throw httpError(400, `Caminho inválido: ${r}`);
    const abs = path.resolve(this.root, r);
    const relBack = path.relative(this.root, abs);
    if (relBack.startsWith('..') || path.isAbsolute(relBack)) throw httpError(400, `Caminho fora do repositório: ${r}`);
    return r;
  }

  // ---- Leitura ----
  // Estado completo: branch, upstream, à frente/atrás, arquivos alterados e conflitos (git status --porcelain=v2).
  async status() {
    const r = await ok(this.root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
    const st = { branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0, files: [], conflicts: [] };
    const parts = r.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith('# branch.head ')) { const h = line.slice(14); st.detached = h === '(detached)'; st.branch = st.detached ? null : h; }
      else if (line.startsWith('# branch.oid ')) st.oid = line.slice(13) === '(initial)' ? null : line.slice(13);
      else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
      else if (line[0] === '1') { const f = line.split(' '); st.files.push(entry(f[1], f.slice(8).join(' '))); }
      else if (line[0] === '2') { const f = line.split(' '); const e = entry(f[1], f.slice(9).join(' ')); e.origPath = parts[++i]; st.files.push(e); }
      else if (line[0] === 'u') { const f = line.split(' '); const p = f.slice(10).join(' '); st.conflicts.push(p); st.files.push({ path: p, xy: f[1], code: '!', label: 'conflito', staged: false, conflict: true }); }
      else if (line[0] === '?') st.files.push({ path: line.slice(2), xy: '??', code: 'U', label: 'novo (não rastreado)', staged: false, untracked: true });
    }
    st.merging = fs.existsSync(path.join(this.root, '.git', 'MERGE_HEAD'));
    st.rebasing = fs.existsSync(path.join(this.root, '.git', 'rebase-merge')) || fs.existsSync(path.join(this.root, '.git', 'rebase-apply'));
    return st;
  }

  async branches() {
    const r = await run(this.root, ['for-each-ref', '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:iso-strict)', 'refs/heads']);
    if (r.code !== 0) throw gitError(r);
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const [name, head, upstream, track, date] = l.split('\x1f');
      return { name, current: head === '*', upstream: upstream || null, track: track || '', date: date || null };
    });
  }

  async remotes() {
    const r = await ok(this.root, ['remote', '-v']);
    const map = new Map();
    for (const l of r.stdout.split('\n').filter(Boolean)) {
      const m = l.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!m) continue;
      const cur = map.get(m[1]) || { name: m[1], fetchUrl: '', pushUrl: '' };
      cur[m[3] === 'fetch' ? 'fetchUrl' : 'pushUrl'] = m[2];
      map.set(m[1], cur);
    }
    return [...map.values()].map((x) => ({ ...x, fetchUrl: safeUrl(x.fetchUrl), pushUrl: safeUrl(x.pushUrl), github: /github\.com[/:]/i.test(x.fetchUrl), webUrl: webUrlOf(x.fetchUrl) }));
  }

  async log(limit = 100) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const r = await run(this.root, ['log', `-n${n}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e']);
    if (r.code !== 0) {
      if (/does not have any commits|não tem nenhum commit|ambiguous argument 'HEAD'|unknown revision/i.test(r.stderr)) return [];
      throw gitError(r);
    }
    return r.stdout.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [hash, short, author, email, date, subject] = s.split('\x1f');
      return { hash, short, author, email, date, subject };
    });
  }

  // ---- Histórico em grafo (tudo a partir do Git local: log, refs, rev-list — sem API do GitHub) ----
  // Uma página de commits em ordem topológica, com os pais (para desenhar o grafo) e as refs de cada commit
  // (HEAD, branches locais, branches remotas, tags). all=false mostra só o que é alcançável pela branch atual.
  async graph({ skip = 0, limit = 100, all = true } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const s = Math.max(0, Math.min(100000, Number(skip) || 0));
    const range = all ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD'];
    const remotes = await this.remoteNames();
    const r = await run(this.root, ['log', ...range, '--topo-order', `--skip=${s}`, `-n${n + 1}`, '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e']);
    if (r.code !== 0) {
      if (/does not have any commits|não tem nenhum commit|ambiguous argument 'HEAD'|unknown revision/i.test(r.stderr)) return { commits: [], hasMore: false };
      throw gitError(r);
    }
    const commits = r.stdout.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => {
      const [hash, parents, author, email, date, subject, deco] = x.split('\x1f');
      return { hash, short: hash.slice(0, 7), parents: parents ? parents.split(' ') : [], author, email, date, subject, refs: parseRefs(deco, remotes) };
    });
    return { commits: commits.slice(0, n), hasMore: commits.length > n };
  }

  // Quanto a branch local está à frente/atrás da remota, e QUAIS commits (para marcar no grafo):
  // localOnly = só existem aqui (aguardando push); incoming = só no remoto (chegaram por fetch, aguardando pull).
  async aheadBehind(branch, upstream, { limit = 500 } = {}) {
    if (!branch || !upstream) return { ahead: 0, behind: 0, localOnly: [], incoming: [] };
    const b = await checkBranchName(this.root, branch);
    if (!/^[A-Za-z0-9._\-/]+$/.test(upstream) || upstream.startsWith('-')) throw httpError(400, 'Upstream inválido.');
    const list = async (range) => {
      const r = await run(this.root, ['rev-list', `--max-count=${limit}`, range]);
      return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    };
    const count = async (range) => { const r = await run(this.root, ['rev-list', '--count', range]); return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0; };
    const [localOnly, incoming, ahead, behind] = await Promise.all([list(`${upstream}..${b}`), list(`${b}..${upstream}`), count(`${upstream}..${b}`), count(`${b}..${upstream}`)]);
    return { ahead, behind, localOnly, incoming };
  }

  async remoteNames() {
    const r = await run(this.root, ['remote']);
    return r.code === 0 ? r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
  }

  async remoteBranches() {
    const r = await run(this.root, ['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)', 'refs/remotes']);
    if (r.code !== 0) throw gitError(r);
    // origin/HEAD é só um ponteiro para a branch padrão do remoto: fica de fora.
    return r.stdout.split('\n').filter(Boolean).map((l) => { const [ref, hash, date] = l.split('\x1f'); return { name: ref.replace(/^refs\/remotes\//, ''), hash, date }; }).filter((x) => !x.name.endsWith('/HEAD'));
  }

  // Detalhes de um commit: mensagem completa, autor/committer, pais, refs e arquivos alterados (+/−).
  // Em merge, os arquivos são comparados com o primeiro pai (o que entrou na branch com o merge).
  async commitDetails(hash) {
    const h = checkHash(hash);
    const remotes = await this.remoteNames();
    const meta = await ok(this.root, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%B', h]);
    const [full, parents, author, email, date, committer, committerDate, deco, ...body] = meta.stdout.split('\x1f');
    const ps = parents ? parents.trim().split(' ').filter(Boolean) : [];
    const base = ps.length ? [ps[0], full] : ['--root', full];
    const [num, names] = await Promise.all([
      ok(this.root, ['diff-tree', '-r', '-M', '--no-commit-id', '--numstat', '-z', ...base]),
      ok(this.root, ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', ...base]),
    ]);
    const files = parseNameStatus(names.stdout);
    const stats = parseNumstat(num.stdout);
    for (const f of files) { const s = stats.get(f.path); if (s) Object.assign(f, s); }
    return { hash: full, short: full.slice(0, 7), parents: ps, author, email, date, committer, committerDate, refs: parseRefs(deco, remotes), message: body.join('\x1f').trim(), files: files.slice(0, 2000), merge: ps.length > 1 };
  }

  // Versões de um arquivo antes (primeiro pai) e depois do commit, para o editor de diferenças.
  async commitFileDiff(hash, rel, { origPath } = {}) {
    const h = checkHash(hash);
    const p = this.checkPath(rel);
    const before = origPath ? this.checkPath(origPath) : p;
    const parents = (await ok(this.root, ['show', '-s', '--format=%P', h])).stdout.trim().split(' ').filter(Boolean);
    const show = async (rev, file) => { if (!rev) return ''; const r = await run(this.root, ['show', `${rev}:${file}`], { raw: true }); return r.code === 0 ? decodeSqlBuffer(r.stdout.subarray(0, MAX_DIFF_BYTES)).replace(/\r\n?/g, '\n') : ''; };
    const [original, modified] = await Promise.all([show(parents[0], before), show(h, p)]);
    return { path: p, hash: h, parent: parents[0] || null, original, modified };
  }

  // Versões "antes" (HEAD) e "agora" (arquivo no disco) de um arquivo, para o editor de diferenças.
  async diff(rel, { origPath } = {}) {
    const p = this.checkPath(rel);
    const before = origPath ? this.checkPath(origPath) : p;
    const head = await run(this.root, ['show', `HEAD:${before}`], { raw: true });
    const original = head.code === 0 ? decodeSqlBuffer(head.stdout.subarray(0, MAX_DIFF_BYTES)).replace(/\r\n?/g, '\n') : '';
    const abs = path.join(this.root, p);
    let modified = '';
    let exists = false;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      exists = true;
      modified = decodeSqlBuffer(fs.readFileSync(abs).subarray(0, MAX_DIFF_BYTES)).replace(/\r\n?/g, '\n');
    }
    return { path: p, origPath: origPath || null, original, modified, inHead: head.code === 0, exists };
  }

  // Quando foi o último contato com o remoto (git fetch/pull): o "atrás" (↓) do status só é atual depois dele.
  lastFetch() {
    try { return fs.statSync(path.join(this.root, '.git', 'FETCH_HEAD')).mtimeMs; } catch { return null; }
  }

  // Busca o que há de novo no remoto SEM alterar arquivos nem branches locais (atualiza ↑/↓ do status).
  async fetch() {
    const rem = await this.remotes();
    if (!rem.length) throw httpError(400, 'Nenhum remote configurado.', { code: 'GIT_NO_REMOTE' });
    const r = await run(this.root, ['fetch', '--all', '--prune'], { timeoutMs: NETWORK_TIMEOUT });
    if (r.code !== 0) throw friendlyNetwork(r, 'fetch');
    return { output: `${r.stdout}\n${r.stderr}`.trim() };
  }

  // ---- Escrita (cada uma é uma ação específica) ----
  async init() { const r = await ok(this.root, ['init']); return r.stdout.trim(); }

  // Commit SÓ dos arquivos escolhidos (git add -A -- <arquivos> e git commit -- <arquivos>). Durante um merge o Git
  // exige commitar tudo o que foi resolvido, então nesse caso os arquivos marcados são adicionados e o commit é completo.
  async commit(message, paths) {
    const msg = String(message ?? '').trim();
    if (!msg) throw httpError(400, 'Escreva a mensagem do commit.');
    if (msg.length > 5000) throw httpError(400, 'Mensagem do commit longa demais.');
    const st = await this.status();
    const list = [...new Set((paths || []).map((p) => this.checkPath(p)))];
    if (!list.length && !st.merging) throw httpError(400, 'Selecione ao menos um arquivo para o commit.');
    if (st.conflicts.length) throw httpError(409, `Ainda há arquivos em conflito: ${st.conflicts.join(', ')}. Resolva e marque como resolvidos antes do commit.`, { code: 'GIT_CONFLICT' });
    if (list.length) await ok(this.root, ['add', '-A', '--', ...list]);
    const args = st.merging ? ['commit', '-F', '-'] : ['commit', '-F', '-', '--', ...list];
    const r = await run(this.root, args, { input: msg });
    if (r.code !== 0) {
      if (/Please tell me who you are|user\.email|user\.name/i.test(r.stderr)) {
        throw httpError(400, 'O Git não sabe quem é o autor dos commits. Configure uma vez (no Prompt): git config --global user.name "Seu Nome"  e  git config --global user.email "voce@exemplo.com".', { code: 'GIT_IDENTITY', gitOutput: r.stderr });
      }
      throw gitError(r);
    }
    const head = await ok(this.root, ['rev-parse', '--short', 'HEAD']);
    return { hash: head.stdout.trim(), output: `${r.stdout}\n${r.stderr}`.trim(), files: list.length, merge: st.merging };
  }

  async pull() {
    const st = await this.status();
    if (!st.branch) throw httpError(400, 'Nenhuma branch ativa (HEAD destacado). Troque para uma branch antes do pull.');
    // Sem upstream: se o remoto (origin, ou o único remote) já tem uma branch com o mesmo nome — ex.: acabou de associar
    // um repositório existente do GitHub —, traz essa branch e passa a acompanhá-la. Senão, o Push é que cria a branch lá.
    let track = null;
    if (!st.upstream) {
      const rem = await this.remotes();
      const target = rem.find((x) => x.name === 'origin') || (rem.length === 1 ? rem[0] : null);
      if (!target) throw httpError(400, rem.length ? 'Há mais de um remote e nenhum se chama “origin”.' : 'Nenhum remote configurado. Associe o repositório do GitHub em “Repositório e GitHub”.', { code: 'GIT_NO_REMOTE' });
      const f = await run(this.root, ['fetch', '--prune', target.name], { timeoutMs: NETWORK_TIMEOUT });
      if (f.code !== 0) throw friendlyNetwork(f, 'fetch');
      const exists = await run(this.root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${target.name}/${st.branch}`]);
      if (exists.code !== 0) throw httpError(400, `O remoto “${target.name}” ainda não tem a branch “${st.branch}”. Faça um Push para criá-la lá.`, { code: 'GIT_NO_UPSTREAM' });
      track = { remote: target.name, branch: st.branch };
    }
    // Respeita pull.rebase se o usuário configurou; senão, merge (comportamento tradicional).
    const cfg = await run(this.root, ['config', '--get', 'pull.rebase']);
    const args = ['pull', '--no-edit', ...(cfg.code === 0 ? [] : ['--no-rebase']), ...(track ? [track.remote, st.branch] : [])];
    const r = await run(this.root, args, { timeoutMs: NETWORK_TIMEOUT });
    const after = await this.status();
    const output = `${r.stdout}\n${r.stderr}`.trim();
    if (after.conflicts.length) return { ok: false, conflict: true, conflicts: after.conflicts, output };
    if (r.code !== 0) throw friendlyNetwork(r, 'pull');
    if (track) await run(this.root, ['branch', `--set-upstream-to=${track.remote}/${track.branch}`, st.branch]);
    return { ok: true, output, setUpstream: !!track };
  }

  async push() {
    const st = await this.status();
    if (!st.branch) throw httpError(400, 'Nenhuma branch ativa (HEAD destacado). Troque para uma branch antes do push.');
    let args;
    if (st.upstream) args = ['push'];
    else {
      // Sem upstream: publica a branch atual no remote (origin, ou o único remote existente) e liga o upstream.
      const rem = await this.remotes();
      if (!rem.length) throw httpError(400, 'Nenhum remote configurado. Adicione um remote (ex.: origin → https://github.com/usuario/repositorio.git) na aba Git.', { code: 'GIT_NO_REMOTE' });
      const target = rem.find((x) => x.name === 'origin') || (rem.length === 1 ? rem[0] : null);
      if (!target) throw httpError(400, `Há mais de um remote (${rem.map((x) => x.name).join(', ')}) e nenhum se chama “origin”. Configure o upstream da branch.`);
      args = ['push', '-u', target.name, `refs/heads/${st.branch}:refs/heads/${st.branch}`];
    }
    const r = await run(this.root, args, { timeoutMs: NETWORK_TIMEOUT });
    if (r.code !== 0) throw friendlyNetwork(r, 'push');
    return { ok: true, output: `${r.stdout}\n${r.stderr}`.trim(), setUpstream: !st.upstream };
  }

  async createBranch(name, { checkout = true } = {}) {
    const n = await checkBranchName(this.root, name);
    await ok(this.root, checkout ? ['switch', '-c', n] : ['branch', n]);
    return n;
  }
  async checkout(name) {
    const n = await checkBranchName(this.root, name);
    const r = await run(this.root, ['switch', n]);
    if (r.code !== 0) {
      if (/would be overwritten|seriam sobrescritas|commit your changes or stash/i.test(r.stderr)) {
        throw httpError(409, `Não foi possível trocar para “${n}”: há alterações não commitadas que seriam sobrescritas. Faça commit (ou descarte) antes de trocar de branch.`, { code: 'GIT_DIRTY', gitOutput: r.stderr });
      }
      throw gitError(r);
    }
    return n;
  }
  // Exclusão segura (git branch -d): o Git recusa se a branch tiver commits que não estão em outra branch.
  async deleteBranch(name) {
    const n = await checkBranchName(this.root, name);
    const st = await this.status();
    if (st.branch === n) throw httpError(400, 'Não é possível excluir a branch atual. Troque de branch antes.');
    const r = await run(this.root, ['branch', '-d', n]);
    if (r.code !== 0) {
      if (/not fully merged|não está totalmente mesclad/i.test(r.stderr)) throw httpError(409, `A branch “${n}” tem commits que não foram mesclados em outra branch; o app não a exclui para não perder trabalho.`, { code: 'GIT_NOT_MERGED', gitOutput: r.stderr });
      throw gitError(r);
    }
    return n;
  }

  // Merge da branch escolhida na atual. Em conflito, NÃO tenta resolver: devolve a lista de arquivos em conflito.
  async merge(source) {
    const n = await checkBranchName(this.root, source);
    const st = await this.status();
    if (st.merging) throw httpError(409, 'Já existe um merge em andamento. Conclua (commit) ou aborte antes.', { code: 'GIT_MERGING' });
    if (st.branch === n) throw httpError(400, 'Escolha uma branch diferente da atual.');
    const r = await run(this.root, ['merge', '--no-edit', n], { timeoutMs: NETWORK_TIMEOUT });
    const after = await this.status();
    const output = `${r.stdout}\n${r.stderr}`.trim();
    if (after.conflicts.length) return { ok: false, conflict: true, conflicts: after.conflicts, output };
    if (r.code !== 0) throw gitError(r);
    return { ok: true, output };
  }
  async mergeAbort() { await ok(this.root, ['merge', '--abort']); return true; }

  // "Marcar como resolvido" (git add do arquivo). Recusa se ainda houver marcadores de conflito no arquivo.
  async markResolved(rel) {
    const p = this.checkPath(rel);
    const abs = path.join(this.root, p);
    if (fs.existsSync(abs)) {
      const text = decodeSqlBuffer(fs.readFileSync(abs));
      if (/^(<{7}|>{7})( |$)/m.test(text)) throw httpError(409, `“${p}” ainda tem marcadores de conflito (<<<<<<< / >>>>>>>). Edite o arquivo e remova-os antes.`, { code: 'GIT_MARKERS' });
    }
    await ok(this.root, ['add', '-A', '--', p]);
    return p;
  }

  async addRemote(name, url) { const n = checkRemoteName(name); await ok(this.root, ['remote', 'add', n, checkRemoteUrl(url)]); return n; }
  async setRemoteUrl(name, url) { const n = checkRemoteName(name); await ok(this.root, ['remote', 'set-url', n, checkRemoteUrl(url)]); return n; }
}

// Mensagens claras para os erros de rede mais comuns, sem esconder a saída original do Git.
function friendlyNetwork(r, op) {
  const raw = `${r.stdout}\n${r.stderr}`.trim();
  let msg;
  if (/\[rejected\]|non-fast-forward|fetch first|rejeitad/i.test(raw)) msg = 'Push rejeitado: o remoto tem commits que você ainda não tem. Faça Pull, resolva conflitos se houver, e tente o Push de novo.';
  else if (/Authentication failed|could not read Username|Permission denied|403|autentica/i.test(raw)) msg = 'Falha de autenticação no remoto. Verifique seu acesso ao repositório (o login é feito pelo Git Credential Manager).';
  else if (/Could not resolve host|unable to access|Failed to connect|timed out/i.test(raw)) msg = 'Não foi possível acessar o remoto (rede/VPN/URL).';
  else if (/unrelated histories|históricos não relacionados/i.test(raw)) msg = 'O repositório local e o remoto têm históricos independentes (foram criados separadamente); o Git não os junta automaticamente. Para trabalhar com o repositório do GitHub, clone-o numa pasta nova (“Clonar do GitHub”).';
  else if (/Need to specify how to reconcile divergent branches|divergent/i.test(raw)) msg = 'As branches local e remota divergiram. Configure como o pull deve reconciliar (git config pull.rebase false) e tente de novo.';
  else if (/Your local changes .* would be overwritten|seriam sobrescritas/i.test(raw)) msg = 'Há alterações locais não commitadas que seriam sobrescritas pelo pull. Faça commit antes.';
  else msg = `O ${op} falhou.`;
  return httpError(400, msg, { code: 'GIT_REMOTE', gitOutput: raw.slice(0, 20000) });
}

// ---- Auxiliares do histórico ----
function checkHash(h) {
  const v = String(h ?? '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(v)) throw httpError(400, 'Commit inválido.');
  return v;
}
// "%D" do git log → [{ type: 'head'|'local'|'remote'|'tag', name }]. remotes = nomes dos remotes do repositório
// (branch remota = "<remote>/<branch>"; assim "feature/x" local não é confundida com remota).
function parseRefs(deco, remotes = []) {
  const out = [];
  const isRemote = (n) => remotes.some((r) => n.startsWith(`${r}/`));
  for (const raw of String(deco || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (raw.startsWith('HEAD -> ')) { out.push({ type: 'head', name: 'HEAD' }); out.push({ type: 'local', name: raw.slice(8), current: true }); }
    else if (raw === 'HEAD') out.push({ type: 'head', name: 'HEAD' });
    else if (raw.startsWith('tag: ')) out.push({ type: 'tag', name: raw.slice(5) });
    else if (isRemote(raw)) { if (!/\/HEAD$/.test(raw)) out.push({ type: 'remote', name: raw }); } // origin/HEAD só polui
    else out.push({ type: 'local', name: raw });
  }
  return out;
}
function parseNameStatus(out) {
  const parts = out.split('\0').filter((x) => x !== '');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (/^[RC]\d*$/.test(code)) { files.push({ status: code[0], origPath: parts[i + 1], path: parts[i + 2] }); i += 2; }
    else if (/^[AMDTUX]$/.test(code)) { files.push({ status: code === 'T' ? 'M' : code, path: parts[i + 1] }); i += 1; }
  }
  return files;
}
function parseNumstat(out) {
  const map = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    let file = m[3];
    if (file === '') { file = parts[i + 2]; i += 2; } // renomeado: "add\tdel\t" + origem + destino
    map.set(file, { additions: m[1] === '-' ? null : Number(m[1]), deletions: m[2] === '-' ? null : Number(m[2]), binary: m[1] === '-' });
  }
  return map;
}

// URL para exibir: nunca mostra senha/token embutido (https://usuario:token@host/...).
function safeUrl(u) { return String(u || '').replace(/^(https?:\/\/[^/@:]+):[^/@]+@/i, '$1:***@'); }
// Página web do repositório (GitHub via https ou SSH), para o botão "Abrir no GitHub".
function webUrlOf(u) {
  const s = String(u || '').replace(/^(https?:\/\/)[^/@]+@/i, '$1');
  let m = s.match(/^https:\/\/(github\.com\/[^\s]+?)(?:\.git)?\/?$/i);
  if (m) return `https://${m[1]}`;
  m = s.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^\s]+?)(?:\.git)?$/i);
  return m ? `https://github.com/${m[1]}` : null;
}

// Clona um repositório existente (ex.: do GitHub) para uma pasta NOVA. O login fica com o Git Credential Manager/SSH.
async function clone(url, parentDir, name) {
  const u = checkRemoteUrl(url);
  const dest = path.join(parentDir, name);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw httpError(409, `A pasta ${dest} já existe e não está vazia. Escolha outro nome ou use “Usar repositório que já está neste computador”.`);
  const r = await run(parentDir, ['clone', '--', u, dest], { timeoutMs: NETWORK_TIMEOUT });
  if (r.code !== 0) throw friendlyNetwork(r, 'clone');
  return { root: dest, output: `${r.stdout}\n${r.stderr}`.trim() };
}

// Informações gerais (sem repositório): versão do Git e se a pasta está dentro de um repositório.
async function version() {
  if (!findGit()) return { available: false };
  const r = await run(process.cwd(), ['--version']);
  return { available: r.code === 0, version: r.stdout.trim().replace(/^git version /, ''), path: gitPath };
}
async function toplevel(dir) {
  const r = await run(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? path.resolve(r.stdout.trim()) : null;
}

module.exports = { GitRepo, version, toplevel, clone, run, checkBranchName, checkRemoteName, checkRemoteUrl, safeUrl, webUrlOf, findGit, NETWORK_TIMEOUT };
