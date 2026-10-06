// Histórico Git em grafo (GitRepo.graph / aheadBehind / commitDetails / commitFileDiff): só Git local, com um remoto local.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-hist-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const G = (dir, args) => git.run(dir, args).then((r) => { if (r.code !== 0) throw new Error(r.stderr); return r.stdout; });
const write = (dir, f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };

test('grafo: pais (merge com 2), refs HEAD/local/remota/tag, à frente/atrás com os commits de cada lado, detalhes e diff', async () => {
  const bare = path.join(tmp, 'remoto.git');
  fs.mkdirSync(bare);
  await G(bare, ['init', '--bare']);
  await G(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const url = `file:///${bare.replace(/\\/g, '/')}`;

  const dir = path.join(tmp, 'local');
  fs.mkdirSync(dir);
  const r = new git.GitRepo(dir);
  await r.init();
  await G(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await G(dir, ['config', 'user.name', 'Elton']);
  await G(dir, ['config', 'user.email', 'e@exemplo.com']);
  write(dir, 'PFUNC.sql', 'SELECT 1\n');
  const c1 = await r.commit('Versão inicial', ['PFUNC.sql']);
  await G(dir, ['tag', 'v1']);
  await r.createBranch('feature/ferias');
  write(dir, 'PFUFERIAS.sql', 'SELECT 2\n');
  await r.commit('Ajusta PFUFERIAS', ['PFUFERIAS.sql']);
  await r.checkout('main');
  write(dir, 'PFUNC.sql', 'SELECT 1\nSELECT 3\n');
  await r.commit('Corrige validação salarial', ['PFUNC.sql']);
  const m = await r.merge('feature/ferias');
  assert.equal(m.ok, true);
  await r.addRemote('origin', url);
  await r.push();
  write(dir, 'PFUNC.sql', 'SELECT 1\nSELECT 3\nSELECT 4\n');
  const local = await r.commit('Ajusta importação PFUNC', ['PFUNC.sql']); // só local → aguardando push

  // outra pessoa publica um commit → depois do fetch, "aguardando pull"
  await G(tmp, ['clone', url, 'outro']);
  const o = path.join(tmp, 'outro');
  await G(o, ['config', 'user.name', 'Maria']);
  await G(o, ['config', 'user.email', 'm@exemplo.com']);
  write(o, 'EVENTOS.sql', 'SELECT 5\n');
  await new git.GitRepo(o).commit('Corrige eventos', ['EVENTOS.sql']);
  await new git.GitRepo(o).push();
  await r.fetch();

  const page = await r.graph({ limit: 50 });
  const by = Object.fromEntries(page.commits.map((c) => [c.subject, c]));
  assert.deepEqual(Object.keys(by).sort(), ['Ajusta PFUFERIAS', 'Ajusta importação PFUNC', 'Corrige eventos', 'Corrige validação salarial', 'Merge branch \'feature/ferias\'', 'Versão inicial'].sort());
  const merge = by["Merge branch 'feature/ferias'"];
  assert.equal(merge.parents.length, 2);
  const topRefs = by['Ajusta importação PFUNC'].refs;
  assert.ok(topRefs.some((x) => x.type === 'head') && topRefs.some((x) => x.type === 'local' && x.name === 'main' && x.current));
  assert.ok(by['Corrige eventos'].refs.some((x) => x.type === 'remote' && x.name === 'origin/main'));
  assert.ok(by['Ajusta PFUFERIAS'].refs.some((x) => x.type === 'local' && x.name === 'feature/ferias')); // "feature/…" local não vira remota
  assert.ok(by['Versão inicial'].refs.some((x) => x.type === 'tag' && x.name === 'v1'));
  assert.equal(by['Versão inicial'].parents.length, 0);
  // ordem topológica: filhos antes dos pais
  const idx = (s) => page.commits.findIndex((c) => c.subject === s);
  assert.ok(idx('Ajusta importação PFUNC') < idx("Merge branch 'feature/ferias'") && idx("Merge branch 'feature/ferias'") < idx('Versão inicial'));

  const ab = await r.aheadBehind('main', 'origin/main');
  assert.equal(ab.ahead, 1);
  assert.equal(ab.behind, 1);
  assert.equal(ab.localOnly[0].slice(0, 7), local.hash.slice(0, 7));
  assert.equal(ab.incoming.length, 1);
  assert.equal(ab.incoming[0], by['Corrige eventos'].hash);
  assert.deepEqual((await r.remoteBranches()).map((b) => b.name), ['origin/main']);

  // paginação
  const p1 = await r.graph({ limit: 2 });
  const p2 = await r.graph({ skip: 2, limit: 2 });
  assert.equal(p1.hasMore, true);
  assert.equal(p1.commits.length, 2);
  assert.notEqual(p2.commits[0].hash, p1.commits[1].hash);
  // só a branch atual (sem o commit do remoto)
  assert.ok(!(await r.graph({ all: false })).commits.some((c) => c.subject === 'Corrige eventos'));

  const d = await r.commitDetails(by['Corrige validação salarial'].hash);
  assert.equal(d.author, 'Elton');
  assert.equal(d.parents[0].slice(0, 7), c1.hash.slice(0, 7));
  assert.deepEqual(d.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [['PFUNC.sql', 'M', 1, 0]]);
  const md = await r.commitDetails(merge.hash);
  assert.equal(md.merge, true);
  assert.deepEqual(md.files.map((f) => [f.path, f.status]), [['PFUFERIAS.sql', 'A']]); // o que o merge trouxe para a main
  const fd = await r.commitFileDiff(by['Corrige validação salarial'].hash, 'PFUNC.sql');
  assert.equal(fd.original.replace(/\r/g, ''), 'SELECT 1\n');
  assert.equal(fd.modified.replace(/\r/g, ''), 'SELECT 1\nSELECT 3\n');
  const first = await r.commitFileDiff(by['Versão inicial'].hash, 'PFUNC.sql');
  assert.equal(first.original, '');
  assert.equal(first.parent, null);

  await assert.rejects(() => r.commitDetails('--all'), /inválido/);
  await assert.rejects(() => r.commitFileDiff(merge.hash, '../fora.sql'), /inválido|fora/);
  await assert.rejects(() => r.aheadBehind('main', '--upload-pack=x'), /inválido/);
});
