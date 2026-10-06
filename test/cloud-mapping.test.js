// Mapeamento estado do app ⇄ linhas da nuvem (src/persistence/mapping.js + split.js): ida e volta sem perda; nada sensível em claro,
// nenhum caminho de disco e nenhuma senha DPAPI na parte que vai para a nuvem; horas e Workspace só nas seções locais.
const test = require('node:test');
const assert = require('node:assert');
const { extract, inject } = require('../src/persistence/split');
const M = require('../src/persistence/mapping');
const { fixture, CANARY, PATHS, DPAPI } = require('./fixtures/cloud-fixture');

const withoutDropped = (d) => { const x = JSON.parse(JSON.stringify(d)); for (const k of M.DROPPED) delete x[k]; return x; };

test('split: extrai e reinsere por caminho, inclusive dentro de arrays (por id) e valores-objeto', () => {
  const o = { a: 1, env: { hml: { dir: 'C:\\x', url: 'u' } }, items: [{ id: 'i1', note: { t: 1 }, k: 2 }, { id: 'i2', k: 3 }], w: { deep: true } };
  const { rest, taken } = extract(o, ['env.hml.dir', 'items[].note', 'w', 'nao.existe']);
  assert.deepEqual(rest, { a: 1, env: { hml: { url: 'u' } }, items: [{ id: 'i1', k: 2 }, { id: 'i2', k: 3 }] });
  assert.deepEqual(inject(rest, taken), o);
  // reordenar o array não troca os valores de lugar
  const re = { ...rest, items: [rest.items[1], rest.items[0]] };
  assert.deepEqual(inject(re, taken).items, [{ id: 'i2', k: 3 }, { id: 'i1', k: 2, note: { t: 1 } }]);
  // estrutura removida não é recriada só para receber o valor guardado
  assert.deepEqual(inject({ a: 1 }, extract({ a: 1, env: { hml: { dir: 'x' } } }, ['env.hml.dir']).taken), { a: 1 });
});

test('ida e volta: compose(decompose(estado)) devolve o mesmo estado (exceto legado descartado)', () => {
  const data = fixture();
  const { rows, local } = M.decompose(data);
  const back = M.compose(JSON.parse(JSON.stringify(rows)), JSON.parse(JSON.stringify(local)));
  assert.equal(M.canonical(back), M.canonical(withoutDropped(data)));
});

test('nada sensível, nenhum caminho de disco e nenhuma senha DPAPI na parte em claro das linhas', () => {
  const { rows } = M.decompose(fixture());
  const plain = JSON.stringify(rows.map((r) => ({ table: r.table, key: r.key, cols: r.cols, doc: r.doc })));
  for (const [k, v] of Object.entries(CANARY)) assert.ok(!plain.includes(v), `canário ${k} em claro`);
  assert.ok(!plain.includes('SENSIVEL'), 'nenhum texto marcado como sensível em claro');
  for (const p of Object.values(PATHS)) assert.ok(!JSON.stringify(rows).includes(p.replace(/\\/g, '\\\\')), `caminho ${p} foi para a nuvem`);
  assert.ok(!JSON.stringify(rows).includes(DPAPI), 'senha DPAPI foi para a nuvem');
  // toda linha de tabela cifrada tem escopo de chave
  for (const r of rows.filter((x) => M.ENCRYPTED_TABLES.has(x.table))) assert.ok(r.scope && r.sensitive, `${r.table} sem escopo/sensitive`);
  // projeto: só a lista explícita em claro (+ ordem interna)
  const p = rows.find((r) => r.table === 'projects');
  assert.deepEqual(Object.keys(p.doc).sort(), [...M.PROJECT_PLAIN, '_order'].sort());
});

test('caminhos e senhas vão para as seções locais; horas e Workspace também; legado é descartado', () => {
  const { rows, local } = M.decompose(fixture());
  assert.equal(local.bindings.projects.p1.rootDir.$v, PATHS.root);
  assert.equal(local.bindings.lists.documents['doc-2'].source.path.$v, PATHS.doc);
  assert.equal(local.secrets.lists.connections.cx1.passwordEnc.$v, DPAPI);
  assert.equal(local.secrets.projects.p1['bases[]']['id:b2'].prod.passwordEnc.$v, DPAPI);
  assert.deepEqual(Object.keys(local.hours).sort(), ['hours', 'timeEntries', 'timeNotes', 'timers']);
  assert.ok(local.prefs.workspace);
  assert.ok(!rows.some((r) => /time|hours|timer/i.test(r.table)), 'horas nunca viram linha da nuvem');
  assert.ok(!JSON.stringify(rows).includes('te1'));
});

test('campo novo sem classificação na raiz é recusado (não some em silêncio na nuvem)', () => {
  assert.throws(() => M.decompose({ ...fixture(), novidade: [] }), { code: 'UNCLASSIFIED' });
});

test('campo novo DENTRO do projeto nasce cifrado (lista explícita do que fica em claro)', () => {
  const d = fixture();
  d.projects[0].campoFuturo = 'SENSIVEL_novo';
  const p = M.decompose(d).rows.find((r) => r.table === 'projects');
  assert.equal(p.sensitive.campoFuturo, 'SENSIVEL_novo');
  assert.ok(!('campoFuturo' in p.doc));
});

test('conteúdo canônico estável: mesma informação com chaves em outra ordem = sem mudança', () => {
  const a = M.decompose(fixture()).rows;
  const d = fixture();
  d.projects[0] = Object.fromEntries(Object.entries(d.projects[0]).reverse());
  const b = M.decompose(d).rows;
  assert.deepEqual(a.map(M.rowContent), b.map(M.rowContent));
});
