const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceFiles, checkRoot } = require('../src/workspace-files');
const git = require('../src/git');

// Workspace de teste: C:\...\Projetos com projetos (repositórios) em 1 e 2 níveis e uma pasta comum.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ws-'));
const root = path.join(tmp, 'Projetos');
const outside = path.join(tmp, 'fora');
const w = (rel, text = 'SELECT 1\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
w('Cliente_A/scripts/PFUNC.sql', 'SELECT * FROM PFUNC\n');
w('Cliente_A/scripts/PPESSOA.sql');
w('Cliente_A/validacoes/valida_funcionario.sql');
w('Cliente_A/validacoes/valida_pessoa.sql');
w('Cliente_A/leia.txt', 'não é sql');
w('Cliente_B/scripts/PFHSTSAL.sql');
w('Cliente_B/scripts/PFUNC.sql', 'SELECT CHAPA FROM PFUNC -- versão do B\n');
w('ZMIGRA_CLIENTEGAMA/ZMIGRA_CLIENTEGAMA_CONSULT/MIGRACAO/PFUNC.sql');
w('Documentos/manual.sql');
for (const d of ['Cliente_A', 'Cliente_B', 'ZMIGRA_CLIENTEGAMA/ZMIGRA_CLIENTEGAMA_CONSULT']) fs.mkdirSync(path.join(root, d, '.git'));
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'segredo.sql'), 'SELECT 1');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const exists = (rel) => fs.existsSync(path.join(root, rel));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- Arquivos ----------
test('raiz: recusa disco inteiro e pastas do sistema', () => {
  const diskRoot = process.platform === 'win32' ? 'C:\\' : '/';
  assert.throws(() => checkRoot(diskRoot), /raiz de um disco/);
  if (process.platform === 'win32') {
    assert.throws(() => checkRoot('C:\\Windows\\Temp'), /sistema/);
  }
  assert.throws(() => checkRoot('relativo/pasta'), /caminho completo/);
  assert.equal(checkRoot(root), root);
});

test('projetos: repositórios até 3 níveis (com grupo) + pastas comuns do 1º nível', () => {
  const ws = new WorkspaceFiles(root);
  assert.deepEqual(ws.projects().map((p) => [p.path, p.git, p.group]), [
    ['Cliente_A', true, ''], ['Cliente_B', true, ''], ['Documentos', false, ''], ['ZMIGRA_CLIENTEGAMA/ZMIGRA_CLIENTEGAMA_CONSULT', true, 'ZMIGRA_CLIENTEGAMA'],
  ]);
  assert.equal(ws.projectOf('ZMIGRA_CLIENTEGAMA/ZMIGRA_CLIENTEGAMA_CONSULT/MIGRACAO/PFUNC.sql').path, 'ZMIGRA_CLIENTEGAMA/ZMIGRA_CLIENTEGAMA_CONSULT');
  assert.equal(ws.projectOf('Cliente_B/scripts').path, 'Cliente_B');
});

test('caminhos: nada sai da pasta do workspace (.., absoluto, outro disco, junção apontando para fora)', () => {
  const ws = new WorkspaceFiles(root);
  for (const bad of ['../fora/segredo.sql', '..\\fora', 'Cliente_A/../../fora', 'C:\\Windows', '/etc', 'a\0b']) {
    assert.throws(() => ws.list(bad), /fora da pasta|relativo|inválido/, bad);
  }
  fs.symlinkSync(outside, path.join(root, 'Cliente_A', 'atalho'), 'junction');
  assert.throws(() => ws.list('Cliente_A/atalho'), /fora da pasta/);
  assert.throws(() => ws.plan([{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_A/atalho' }]), /fora da pasta/);
  assert.throws(() => ws.plan([{ src: 'Cliente_A/atalho/segredo.sql', destDir: 'Cliente_B' }]), /fora da pasta/);
  fs.rmSync(path.join(root, 'Cliente_A', 'atalho'));
  assert.throws(() => ws.createFile('Cliente_A', '..\\x'), /não permitidos/);
  assert.throws(() => ws.createDir('Cliente_A', 'CON'), /reservado/);
  assert.throws(() => ws.rename('', 'x'), /raiz/);
});

test('listar pasta: sob demanda, só .sql por padrão (todos com all), sem .git, marca subpastas que são repositórios', () => {
  const ws = new WorkspaceFiles(root);
  const a = ws.list('Cliente_A');
  assert.deepEqual(a.dirs.map((d) => d.name), ['scripts', 'validacoes']);
  assert.deepEqual(a.files.map((f) => f.name), []);
  assert.deepEqual(ws.list('Cliente_A', { all: true }).files.map((f) => f.name), ['leia.txt']);
  assert.deepEqual(ws.list('').dirs.map((d) => [d.name, d.git]), [['Cliente_A', true], ['Cliente_B', true], ['Documentos', false], ['ZMIGRA_CLIENTEGAMA', false]]);
});

test('busca por nome/caminho em todos os projetos (sem acento/maiúsculas, várias palavras)', () => {
  const ws = new WorkspaceFiles(root);
  assert.deepEqual(ws.search('pfunc').results.map((r) => r.path).sort(), ['Cliente_A/scripts/PFUNC.sql', 'Cliente_B/scripts/PFUNC.sql', 'ZMIGRA_CLIENTEGAMA/ZMIGRA_CLIENTEGAMA_CONSULT/MIGRACAO/PFUNC.sql']);
  assert.deepEqual(ws.search('cliente_b pfunc').results.map((r) => r.path), ['Cliente_B/scripts/PFUNC.sql']);
  assert.deepEqual(ws.search('VALIDAÇÕES funcionário').results.map((r) => r.path), ['Cliente_A/validacoes/valida_funcionario.sql']); // acento/maiúscula na busca não atrapalham
  assert.deepEqual(ws.search('validacoes funcionario').results.map((r) => r.path), ['Cliente_A/validacoes/valida_funcionario.sql']);
  assert.deepEqual(ws.search('leia').results, []);
  assert.deepEqual(ws.search('leia', { all: true }).results.map((r) => r.path), ['Cliente_A/leia.txt']);
  assert.deepEqual(ws.search('pfunc', { within: 'Cliente_B' }).results.map((r) => r.path), ['Cliente_B/scripts/PFUNC.sql']);
});

test('copiar arquivo entre projetos: sem conflito copia; com conflito NADA acontece até decidir', async () => {
  const ws = new WorkspaceFiles(root);
  let r = await ws.transfer([{ src: 'Cliente_A/scripts/PPESSOA.sql', destDir: 'Cliente_B/scripts' }], 'copy');
  assert.deepEqual(r.done.map((d) => d.to), ['Cliente_B/scripts/PPESSOA.sql']);
  assert.ok(exists('Cliente_A/scripts/PPESSOA.sql') && exists('Cliente_B/scripts/PPESSOA.sql'));

  const plan = ws.plan([{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_B/scripts' }], 'copy');
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].identical, false);
  await assert.rejects(() => ws.transfer([{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_B/scripts' }], 'copy'), (e) => e.code === 'WS_CONFLICTS' && e.conflicts.length === 1);
  assert.match(read('Cliente_B/scripts/PFUNC.sql'), /versão do B/); // intacto

  r = await ws.transfer([{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_B/scripts' }], 'copy', { 'Cliente_B/scripts/PFUNC.sql': 'keepBoth' });
  assert.deepEqual(r.renamed, [{ from: 'Cliente_B/scripts/PFUNC.sql', to: 'Cliente_B/scripts/PFUNC (2).sql' }]);
  assert.match(read('Cliente_B/scripts/PFUNC.sql'), /versão do B/);
  assert.equal(read('Cliente_B/scripts/PFUNC (2).sql'), 'SELECT * FROM PFUNC\n');

  r = await ws.transfer([{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_B/scripts' }], 'copy', { 'Cliente_B/scripts/PFUNC.sql': 'skip' });
  assert.deepEqual(r.skipped, ['Cliente_A/scripts/PFUNC.sql']);
  assert.match(read('Cliente_B/scripts/PFUNC.sql'), /versão do B/);
});

test('conflito "idêntico" é detectado; copiar para a mesma pasta só permite manter ambos/pular', async () => {
  const ws = new WorkspaceFiles(root);
  const same = ws.plan([{ src: 'Cliente_A/scripts/PPESSOA.sql', destDir: 'Cliente_B/scripts' }], 'copy');
  assert.equal(same.conflicts[0].identical, true);
  const self = ws.plan([{ src: 'Cliente_A/scripts/PPESSOA.sql', destDir: 'Cliente_A/scripts' }], 'copy');
  assert.equal(self.conflicts[0].self, true);
  await assert.rejects(() => ws.transfer([{ src: 'Cliente_A/scripts/PPESSOA.sql', destDir: 'Cliente_A/scripts' }], 'copy', { 'Cliente_A/scripts/PPESSOA.sql': 'replace' }), /próprio arquivo/);
  const r = await ws.transfer([{ src: 'Cliente_A/scripts/PPESSOA.sql', destDir: 'Cliente_A/scripts' }], 'copy', { 'Cliente_A/scripts/PPESSOA.sql': 'keepBoth' });
  assert.equal(r.done[0].to, 'Cliente_A/scripts/PPESSOA (2).sql');
});

test('vários arquivos de uma vez e pasta inteira (mantendo a estrutura; o .git de dentro nunca vai junto)', async () => {
  const ws = new WorkspaceFiles(root);
  fs.mkdirSync(path.join(root, 'Cliente_C'));
  let r = await ws.transfer([
    { src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_C' },
    { src: 'Cliente_A/scripts/PPESSOA.sql', destDir: 'Cliente_C' },
    { src: 'Cliente_B/scripts/PFHSTSAL.sql', destDir: 'Cliente_C' },
  ], 'copy');
  assert.equal(r.done.length, 3);
  r = await ws.transfer([{ src: 'Cliente_A/validacoes', destDir: 'Cliente_B' }], 'copy');
  assert.deepEqual(r.done.map((d) => d.to).sort(), ['Cliente_B/validacoes/valida_funcionario.sql', 'Cliente_B/validacoes/valida_pessoa.sql']);
  r = await ws.transfer([{ src: 'Cliente_B', destDir: 'Cliente_C' }], 'copy'); // copiar um projeto inteiro: sem o .git
  assert.ok(exists('Cliente_C/Cliente_B/scripts/PFHSTSAL.sql'));
  assert.ok(!exists('Cliente_C/Cliente_B/.git'));
  assert.throws(() => ws.plan([{ src: 'Cliente_A', destDir: 'Cliente_A/scripts' }], 'copy'), /dentro dela mesma/);
  assert.throws(() => ws.plan([{ src: 'Cliente_A/scripts/PFUNC.sql', destDir: 'Cliente_Z' }], 'copy'), /não encontrada/);
});

test('clonar para projeto: mantém o caminho relativo e cria as pastas que faltam', async () => {
  const ws = new WorkspaceFiles(root);
  fs.mkdirSync(path.join(root, 'Cliente_D'));
  const r = await ws.transfer([{ src: 'Cliente_A/validacoes/valida_pessoa.sql', destDir: 'Cliente_D/validacoes', createDest: true }], 'copy');
  assert.deepEqual(r.done.map((d) => d.to), ['Cliente_D/validacoes/valida_pessoa.sql']);
});

test('mover: arquivos e pasta (a pasta de origem vazia some; o que foi pulado fica)', async () => {
  const ws = new WorkspaceFiles(root);
  w('Cliente_A/mover/um.sql'); w('Cliente_A/mover/dois.sql');
  w('Cliente_D/mover/dois.sql', 'já existia');
  const r = await ws.transfer([{ src: 'Cliente_A/mover', destDir: 'Cliente_D' }], 'move', { 'Cliente_D/mover/dois.sql': 'skip' });
  assert.deepEqual(r.done.map((d) => d.to), ['Cliente_D/mover/um.sql']);
  assert.ok(exists('Cliente_A/mover/dois.sql') && !exists('Cliente_A/mover/um.sql'));
  assert.equal(read('Cliente_D/mover/dois.sql'), 'já existia');
  w('Cliente_A/sozinho/x.sql');
  await ws.transfer([{ src: 'Cliente_A/sozinho', destDir: 'Cliente_D' }], 'move');
  assert.ok(!exists('Cliente_A/sozinho') && exists('Cliente_D/sozinho/x.sql'));
  assert.throws(() => ws.plan([{ src: 'Cliente_D/sozinho/x.sql', destDir: 'Cliente_D/sozinho' }], 'move'), /já está nesta pasta/);
});

test('criar, renomear (inclusive só maiúsculas), comparar', () => {
  const ws = new WorkspaceFiles(root);
  assert.equal(ws.createFile('Cliente_B/scripts', 'NOVO'), 'Cliente_B/scripts/NOVO.sql');
  assert.equal(ws.createFile('Cliente_B', 'notas.txt'), 'Cliente_B/notas.txt');
  assert.throws(() => ws.createFile('Cliente_B/scripts', 'NOVO.sql'), /Já existe/);
  assert.equal(ws.createDir('Cliente_B', 'docs'), 'Cliente_B/docs');
  assert.equal(ws.rename('Cliente_B/scripts/NOVO.sql', 'novo.sql'), 'Cliente_B/scripts/novo.sql');
  assert.throws(() => ws.rename('Cliente_B/scripts/novo.sql', 'PFUNC.sql'), /Já existe/);
  const c = ws.compare('Cliente_A/scripts/PFUNC.sql', 'Cliente_B/scripts/PFUNC.sql');
  assert.equal(c.a.text, 'SELECT * FROM PFUNC\n');
  assert.match(c.b.text, /versão do B/);
});

// ---------- Git (repositório temporário + "remoto" local, sem GitHub) ----------
const G = (dir, args) => git.run(dir, args).then((r) => { if (r.code !== 0) throw new Error(r.stderr); return r.stdout; });
async function mkRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = new git.GitRepo(dir);
  await r.init();
  await G(dir, ['config', 'user.name', 'Teste']);
  await G(dir, ['config', 'user.email', 'teste@exemplo.com']);
  await G(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return r;
}

test('git: status, commit SÓ dos arquivos escolhidos, diff, log', async () => {
  const dir = path.join(tmp, 'repo1');
  const r = await mkRepo(dir);
  fs.writeFileSync(path.join(dir, 'PFUNC.sql'), 'SELECT 1\n');
  fs.writeFileSync(path.join(dir, 'teste.sql'), 'SELECT 2\n');
  let st = await r.status();
  assert.equal(st.branch, 'main');
  assert.deepEqual(st.files.map((f) => [f.path, f.code]).sort(), [['PFUNC.sql', 'U'], ['teste.sql', 'U']]);
  const c = await r.commit('Primeiro commit', ['PFUNC.sql']);
  assert.match(c.hash, /^[0-9a-f]{7,}$/);
  st = await r.status();
  assert.deepEqual(st.files.map((f) => f.path), ['teste.sql']); // o não selecionado continua pendente
  fs.writeFileSync(path.join(dir, 'PFUNC.sql'), 'SELECT\n    CHAPA\nFROM PFUNC;\n');
  st = await r.status();
  assert.deepEqual(st.files.find((f) => f.path === 'PFUNC.sql').code, 'M');
  const d = await r.diff('PFUNC.sql');
  assert.equal(d.original, 'SELECT 1\n');
  assert.match(d.modified, /CHAPA/);
  assert.deepEqual((await r.log()).map((l) => l.subject), ['Primeiro commit']);
  await assert.rejects(() => r.commit('', ['PFUNC.sql']), /mensagem/);
  await assert.rejects(() => r.commit('x', []), /Selecione/);
  await assert.rejects(() => r.commit('x', ['../fora.sql']), /inválido|fora/);
  await assert.rejects(() => r.diff('.git/config'), /inválido/);
});

test('git: branches (criar/trocar/excluir com segurança) e nomes inválidos', async () => {
  const dir = path.join(tmp, 'repo2');
  const r = await mkRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.sql'), 'SELECT 1\n');
  await r.commit('base', ['a.sql']);
  assert.equal(await r.createBranch('feature/importacao'), 'feature/importacao');
  assert.equal((await r.status()).branch, 'feature/importacao');
  fs.writeFileSync(path.join(dir, 'a.sql'), 'SELECT 2\n');
  await r.commit('muda', ['a.sql']);
  await r.checkout('main');
  await assert.rejects(() => r.deleteBranch('feature/importacao'), (e) => e.code === 'GIT_NOT_MERGED'); // não perde trabalho
  await assert.rejects(() => r.deleteBranch('main'), /branch atual/);
  for (const bad of ['-x', 'a b', 'a..b', 'x~1', 'x:y', '']) await assert.rejects(() => r.createBranch(bad), /inválido/, bad);
  const names = (await r.branches()).map((b) => [b.name, b.current]);
  assert.deepEqual(names, [['feature/importacao', false], ['main', true]]);
});

test('git: merge com conflito → lista os arquivos, recusa "resolvido" com marcadores, conclui após edição', async () => {
  const dir = path.join(tmp, 'repo3');
  const r = await mkRepo(dir);
  fs.writeFileSync(path.join(dir, 'PFUNC.sql'), 'SELECT 1\n');
  await r.commit('base', ['PFUNC.sql']);
  await r.createBranch('dev');
  fs.writeFileSync(path.join(dir, 'PFUNC.sql'), 'SELECT 2 -- dev\n');
  await r.commit('dev', ['PFUNC.sql']);
  await r.checkout('main');
  fs.writeFileSync(path.join(dir, 'PFUNC.sql'), 'SELECT 3 -- main\n');
  await r.commit('main', ['PFUNC.sql']);
  const m = await r.merge('dev');
  assert.equal(m.conflict, true);
  assert.deepEqual(m.conflicts, ['PFUNC.sql']);
  const st = await r.status();
  assert.equal(st.merging, true);
  assert.equal(st.files[0].code, '!');
  await assert.rejects(() => r.commit('x', ['PFUNC.sql']), (e) => e.code === 'GIT_CONFLICT');
  await assert.rejects(() => r.markResolved('PFUNC.sql'), (e) => e.code === 'GIT_MARKERS');
  fs.writeFileSync(path.join(dir, 'PFUNC.sql'), 'SELECT 3 -- resolvido\n');
  await r.markResolved('PFUNC.sql');
  const c = await r.commit('Merge dev', []);
  assert.equal(c.merge, true);
  assert.equal((await r.status()).merging, false);
  assert.equal((await r.log())[0].subject, 'Merge dev');
});

test('git: push (cria upstream), pull, push rejeitado e conflito no pull — com um remoto local', async () => {
  const bare = path.join(tmp, 'remoto.git');
  fs.mkdirSync(bare);
  await G(bare, ['init', '--bare']);
  await G(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const url = `file:///${bare.replace(/\\/g, '/')}`;

  const a = await mkRepo(path.join(tmp, 'clienteA'));
  await assert.rejects(() => a.push(), (e) => e.code === 'GIT_NO_REMOTE');
  await a.addRemote('origin', url);
  await assert.rejects(() => a.addRemote('-x', url), /inválido/);
  await assert.rejects(() => a.setRemoteUrl('origin', 'ext::sh -c touch% /tmp/x'), /inválida/);
  assert.deepEqual((await a.remotes()).map((x) => x.name), ['origin']);
  fs.writeFileSync(path.join(a.root, 'PFUNC.sql'), 'SELECT 1\n');
  await a.commit('c1', ['PFUNC.sql']);
  await assert.rejects(() => a.pull(), (e) => e.code === 'GIT_NO_UPSTREAM');
  const p1 = await a.push();
  assert.equal(p1.setUpstream, true);
  assert.equal((await a.status()).upstream, 'origin/main');

  // segundo clone (outra pessoa/computador)
  await G(tmp, ['clone', url, 'clienteB']);
  const bDir = path.join(tmp, 'clienteB');
  await G(bDir, ['config', 'user.name', 'B']);
  await G(bDir, ['config', 'user.email', 'b@exemplo.com']);
  const b = new git.GitRepo(bDir);
  fs.writeFileSync(path.join(bDir, 'PFUNC.sql'), 'SELECT 2 -- B\n');
  await b.commit('c2 (B)', ['PFUNC.sql']);
  await b.push();

  fs.writeFileSync(path.join(a.root, 'PFUNC.sql'), 'SELECT 3 -- A\n');
  await a.commit('c3 (A)', ['PFUNC.sql']);
  await assert.rejects(() => a.push(), (e) => e.code === 'GIT_REMOTE' && /rejeitado/.test(e.message));
  const pl = await a.pull();
  assert.equal(pl.conflict, true);
  assert.deepEqual(pl.conflicts, ['PFUNC.sql']);
  await a.mergeAbort();
  assert.equal((await a.status()).merging, false);
});

test('git: versão detectada e pasta fora de repositório', async () => {
  const v = await git.version();
  assert.equal(v.available, true);
  assert.match(v.version, /^\d+\.\d+/);
  const lone = path.join(tmp, 'sem-git');
  fs.mkdirSync(lone);
  // pode estar dentro de um repositório de um diretório acima (ex.: pasta temporária num repo); só não pode dar erro
  const top = await git.toplevel(lone);
  assert.ok(top === null || typeof top === 'string');
});
