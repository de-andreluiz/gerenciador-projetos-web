// Git do SQL Workspace: associação a repositórios existentes (local/remoto), raiz do repositório e remotes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-wsg-'));
const G = (dir, args) => git.run(dir, args).then((r) => { if (r.code !== 0) throw new Error(r.stderr); return r.stdout; });
async function mkRepo(dir, { commit } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  await G(dir, ['init']);
  await G(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await G(dir, ['config', 'user.name', 'Teste']);
  await G(dir, ['config', 'user.email', 'teste@exemplo.com']);
  if (commit) { for (const [f, t] of Object.entries(commit)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } await G(dir, ['add', '-A']); await G(dir, ['commit', '-m', 'inicial']); }
  return new git.GitRepo(dir);
}
const bareUrl = async (name) => {
  const bare = path.join(tmp, name);
  fs.mkdirSync(bare);
  await G(bare, ['init', '--bare']);
  await G(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return `file:///${bare.replace(/\\/g, '/')}`;
};

// ---------- Serviço ----------
test('URLs: token embutido nunca aparece; link do GitHub a partir de HTTPS ou SSH', () => {
  assert.equal(git.safeUrl('https://elton:ghp_SEGREDO@github.com/u/r.git'), 'https://elton:***@github.com/u/r.git');
  assert.equal(git.safeUrl('https://github.com/u/r.git'), 'https://github.com/u/r.git');
  assert.equal(git.webUrlOf('https://github.com/meuusuario/cliente-a.git'), 'https://github.com/meuusuario/cliente-a');
  assert.equal(git.webUrlOf('git@github.com:meuusuario/cliente-b.git'), 'https://github.com/meuusuario/cliente-b');
  assert.equal(git.webUrlOf('https://dev.azure.com/x/y'), null);
});

test('associar remoto EXISTENTE: pull traz a branch do remoto e passa a acompanhá-la; fetch não mexe nos arquivos', async () => {
  const url = await bareUrl('remoto1.git');
  const origem = await mkRepo(path.join(tmp, 'origem'), { commit: { 'scripts/PFUNC.sql': 'SELECT 1\n' } });
  await origem.addRemote('origin', url);
  await origem.push();

  const novo = await mkRepo(path.join(tmp, 'novo')); // repositório local vazio, associado depois ao remoto existente
  await novo.addRemote('origin', url);
  const r = await novo.pull();
  assert.equal(r.setUpstream, true);
  const lerPfunc = () => fs.readFileSync(path.join(novo.root, 'scripts', 'PFUNC.sql'), 'utf8').replace(/\r/g, ''); // core.autocrlf do Git para Windows
  assert.equal(lerPfunc(), 'SELECT 1\n');
  assert.equal((await novo.status()).upstream, 'origin/main');

  fs.writeFileSync(path.join(origem.root, 'scripts', 'PFUNC.sql'), 'SELECT 2\n');
  await origem.commit('c2', ['scripts/PFUNC.sql']);
  await origem.push();
  await novo.fetch();
  const st = await novo.status();
  assert.equal(st.behind, 1); // "1 commit remoto aguardando pull"
  assert.equal(lerPfunc(), 'SELECT 1\n'); // fetch não altera arquivos
  assert.ok(novo.lastFetch() > 0);
});

test('históricos independentes: pull recusado com explicação; clone não usa pasta que já tem arquivos', async () => {
  const url = await bareUrl('remoto2.git');
  const a = await mkRepo(path.join(tmp, 'a2'), { commit: { 'x.sql': 'SELECT 1\n' } });
  await a.addRemote('origin', url);
  await a.push();
  const b = await mkRepo(path.join(tmp, 'b2'), { commit: { 'y.sql': 'SELECT 2\n' } });
  await b.addRemote('origin', url);
  await assert.rejects(() => b.pull(), /históricos independentes/);

  const c = await git.clone(url, tmp, 'clonado');
  assert.ok(fs.existsSync(path.join(c.root, 'x.sql')));
  await assert.rejects(() => git.clone(url, tmp, 'clonado'), /já existe e não está vazia/);
  await assert.rejects(() => git.clone('ext::sh -c x', tmp, 'z'), /inválida/);
});

// ---------- API do Workspace (raiz com vários projetos; Git independente por projeto) ----------
const PORT = 4398;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const wsRoot = path.join(tmp, 'Projetos');
test('API: raiz do Workspace, projetos com resumo Git por repositório e pasta que não é repositório', async () => {
  assert.equal((await api('PUT', '/api/wsm', { root: path.join(tmp, 'nao-existe') })).json.code, 'WS_ROOT_MISSING');
  assert.equal((await api('PUT', '/api/wsm', { root: 'C:\\' })).status, 400);
  const url = await bareUrl('remotoA.git');
  const a = await mkRepo(path.join(wsRoot, 'Cliente_A'), { commit: { 'scripts/PFUNC.sql': 'SELECT 1\n', 'scripts/PPESSOA.sql': 'SELECT 2\n' } });
  await a.addRemote('origin', url);
  await a.push();
  await mkRepo(path.join(wsRoot, 'Cliente_B'), { commit: { 'scripts/PFHSTSAL.sql': 'SELECT 3\n' } });
  fs.mkdirSync(path.join(wsRoot, 'Documentos'));
  assert.equal((await api('PUT', '/api/wsm', { root: wsRoot })).status, 200);
  const info = (await api('GET', '/api/wsm')).json;
  assert.equal(info.root, wsRoot);
  assert.equal(info.rootExists, true);
  assert.equal(info.git.available, true);

  const list = (await api('GET', '/api/wsm/projects?git=1')).json.projects;
  assert.deepEqual(list.map((p) => [p.path, p.git]), [['Cliente_A', true], ['Cliente_B', true], ['Documentos', false]]);
  const A = list[0].summary;
  assert.equal(A.branch, 'main');
  assert.equal(A.upstream, 'origin/main');
  assert.equal(A.changes, 0);
  assert.equal(A.remote.name, 'origin');
  assert.equal(list[1].summary.remote, null); // repositório só local
  assert.equal(list[2].summary, null);
  assert.equal((await api('GET', '/api/wsm/git?project=Documentos')).json.repo, false);
  assert.equal((await api('GET', '/api/wsm/git?project=..%2F..')).status, 400);
});

test('API: copiar script do Cliente A para o Cliente B → aparece no Git do B → commit só no B (git_root de cada projeto)', async () => {
  let r = await api('POST', '/api/wsm/transfer', { op: 'copy', dryRun: true, items: [{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_B/scripts' }] });
  assert.deepEqual(r.json, { op: 'copy', count: 1, conflicts: [] });
  r = await api('POST', '/api/wsm/transfer', { op: 'copy', items: [{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_B/scripts' }] });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(wsRoot, 'Cliente_B', 'scripts', 'PFUNC.sql'))); // arquivo físico no destino

  const gb = (await api('GET', '/api/wsm/git?project=Cliente_B')).json;
  assert.equal(gb.root.toLowerCase(), path.join(wsRoot, 'Cliente_B').toLowerCase());
  assert.deepEqual(gb.status.files.map((f) => [f.path, f.code, f.wsPath]), [['scripts/PFUNC.sql', 'U', 'Cliente_B/scripts/PFUNC.sql']]);
  assert.equal((await api('GET', '/api/wsm/git?project=Cliente_A')).json.status.files.length, 0); // origem intacta

  const c = await api('POST', '/api/wsm/git/commit', { project: 'Cliente_B', message: 'Traz PFUNC do Cliente A', paths: ['scripts/PFUNC.sql'] });
  assert.equal(c.status, 200);
  const hist = (await api('GET', '/api/wsm/git/graph?project=Cliente_B')).json;
  assert.equal(hist.commits[0].subject, 'Traz PFUNC do Cliente A');
  assert.equal((await api('GET', '/api/wsm/git/graph?project=Cliente_A')).json.commits[0].subject, 'inicial');
});

test('API: conflito ao copiar volta 409 com a lista (nada é feito); decisão por arquivo aplica', async () => {
  fs.writeFileSync(path.join(wsRoot, 'Cliente_A', 'scripts', 'PFUNC.sql'), 'SELECT 1 -- nova versão do A\n');
  const items = [{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_B/scripts' }, { src: 'Cliente_A/scripts/PPESSOA.sql', destDir: 'Cliente_B/scripts' }];
  let r = await api('POST', '/api/wsm/transfer', { op: 'copy', items });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'WS_CONFLICTS');
  assert.deepEqual(r.json.conflicts.map((x) => x.to), ['Cliente_B/scripts/PFUNC.sql']);
  assert.ok(!fs.existsSync(path.join(wsRoot, 'Cliente_B', 'scripts', 'PPESSOA.sql')), 'nada foi copiado enquanto havia conflito sem decisão');
  const cmp = (await api('GET', '/api/wsm/compare?a=Cliente_A/scripts/PFUNC.sql&b=Cliente_B/scripts/PFUNC.sql')).json;
  assert.match(cmp.a.text, /nova versão do A/);
  r = await api('POST', '/api/wsm/transfer', { op: 'copy', items, resolutions: { 'Cliente_B/scripts/PFUNC.sql': 'keepBoth' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.done.map((d) => d.to).sort(), ['Cliente_B/scripts/PFUNC (2).sql', 'Cliente_B/scripts/PPESSOA.sql']);
  const codes = (await api('GET', '/api/wsm/git?project=Cliente_B')).json.status.files.map((f) => `${f.code} ${f.path}`).sort();
  assert.deepEqual(codes, ['U scripts/PFUNC (2).sql', 'U scripts/PPESSOA.sql']);
});

test('API: remote existente só é trocado com confirmação; clone como novo projeto; abrir recusa executável', async () => {
  let r = await api('POST', '/api/wsm/git/remote', { project: 'Cliente_B', name: 'origin', url: 'https://github.com/meuusuario/cliente-b.git' });
  assert.equal(r.json.replaced, false);
  r = await api('POST', '/api/wsm/git/remote', { project: 'Cliente_B', name: 'origin', url: 'https://github.com/outro/repo.git' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'GIT_REMOTE_EXISTS');
  assert.equal((await api('GET', '/api/wsm/git?project=Cliente_B')).json.remotes[0].fetchUrl, 'https://github.com/meuusuario/cliente-b.git');

  const url = `file:///${path.join(tmp, 'remotoA.git').replace(/\\/g, '/')}`;
  r = await api('POST', '/api/wsm/git/clone', { url, parent: '', name: 'Cliente_A_copia' });
  assert.equal(r.status, 200);
  assert.equal(r.json.project, 'Cliente_A_copia');
  assert.ok((await api('GET', '/api/wsm/projects')).json.projects.some((p) => p.path === 'Cliente_A_copia' && p.git));

  fs.writeFileSync(path.join(wsRoot, 'Documentos', 'instalar.bat'), 'echo x');
  assert.equal((await api('POST', '/api/wsm/open', { path: 'Documentos/instalar.bat', app: 'default' })).status, 400);
  assert.equal((await api('POST', '/api/wsm/open', { path: '../fora', app: 'explorer' })).status, 400);
  const audit = JSON.stringify((await api('GET', '/api/audit')).json);
  assert.ok(audit.includes('workspace-copiado') && audit.includes('git-commit') && audit.includes('git-clone'));
});

test('API: .gitignore do repositório — detectar, criar, mesclar sem sobrescrever calado e nunca outro caminho', async () => {
  let g = (await api('GET', '/api/wsm/git/gitignore?project=Cliente_B')).json;
  assert.equal(g.exists, false);
  assert.equal((await api('GET', '/api/wsm/projects?git=1')).json.projects.find((p) => p.path === 'Cliente_B').summary.gitignore, false);
  assert.equal((await api('GET', '/api/wsm/git/gitignore?project=Documentos')).status, 400, 'pasta sem Git');
  assert.equal((await api('GET', '/api/wsm/git/gitignore?project=..')).status, 400, 'fora da raiz');
  const created = await api('PUT', '/api/wsm/git/gitignore', { project: 'Cliente_B', content: '*.log\n.env', baseHash: null });
  assert.equal(created.status, 200); assert.equal(created.json.created, true);
  const file = path.join(wsRoot, 'Cliente_B', '.gitignore');
  assert.equal(fs.readFileSync(file, 'utf8'), '*.log\n.env\n');
  // alguém mudou por fora: o hash antigo não vale mais → 409 e nada é sobrescrito
  fs.writeFileSync(file, '*.log\r\n.env\r\nsegredo.txt\r\n');
  const stale = await api('PUT', '/api/wsm/git/gitignore', { project: 'Cliente_B', content: '*.tmp', baseHash: created.json.hash });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'GITIGNORE_CHANGED');
  assert.match(fs.readFileSync(file, 'utf8'), /segredo\.txt/);
  g = (await api('GET', '/api/wsm/git/gitignore?project=Cliente_B')).json;
  assert.equal(g.eol, 'crlf'); assert.equal(g.lines, 3);
  const saved = await api('PUT', '/api/wsm/git/gitignore', { project: 'Cliente_B', content: `${g.content}*.tmp\n`, baseHash: g.hash });
  assert.equal(saved.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), '*.log\r\n.env\r\nsegredo.txt\r\n*.tmp\r\n', 'mantém a quebra de linha do arquivo');
  assert.equal((await api('GET', '/api/wsm/projects?git=1')).json.projects.find((p) => p.path === 'Cliente_B').summary.gitignore, true);
  // o caminho nunca vem da tela: campos extras são ignorados
  await api('PUT', '/api/wsm/git/gitignore', { project: 'Cliente_A', path: path.join(tmp, 'x.txt'), content: 'a', baseHash: null });
  assert.equal(fs.existsSync(path.join(tmp, 'x.txt')), false);
  assert.equal(fs.readFileSync(path.join(wsRoot, 'Cliente_A', '.gitignore'), 'utf8'), 'a\n');
});
