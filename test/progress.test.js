// Progresso do projeto (barra da lateral e da Visão Geral): uma única regra no servidor (checklist.projectProgress),
// mesma semântica do progresso por etapa (obrigatórios + opcionais; "concluído" = itemStatus), ciclo inteiro.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-pg-'));
const PORT = 4453;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const C = require('../src/checklist');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]);
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };
const upload = async (url, name, buf) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-File-Name': encodeURIComponent(name), 'X-File-Type': 'image/png' }, body: buf });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const S = {};
const progress = async () => (ok(await api('GET', '/api/state'))).projects.find((p) => p.id === S.p.id).progress;
const item = (inst, title) => [...inst.items, ...(inst.inherited || [])].find((i) => i.title === title);
const mark = async (stepId, it, done) => api('PUT', `/api/projects/${S.p.id}/checklists/${stepId}/items/${it.id}`, { done });

test('cenário: ciclo com 3 etapas e 5 itens (obrigatório com evidência, opcional, transferível, dependência)', async () => {
  const st1 = ok(await api('POST', '/api/stages', { name: 'Etapa P1', color: '#112233' }));
  const st2 = ok(await api('POST', '/api/stages', { name: 'Etapa P2', color: '#223344' }));
  const st3 = ok(await api('POST', '/api/stages', { name: 'Etapa P3', color: '#334455' })); // conclusão (sem checklist): só nela nada é transferível
  const ck1 = ok(await api('POST', '/api/checklists', { name: 'CK P1' }));
  const ck2 = ok(await api('POST', '/api/checklists', { name: 'CK P2' }));
  S.A = ok(await api('POST', `/api/checklists/${ck1.id}/items`, { title: 'A', required: true, evidence: { mode: 'required', type: 'image', min: 1, max: 3 } }));
  ok(await api('POST', `/api/checklists/${ck1.id}/items`, { title: 'B', required: false }));
  ok(await api('POST', `/api/checklists/${ck1.id}/items`, { title: 'T', required: true, carryForward: true }));
  ok(await api('POST', `/api/checklists/${ck2.id}/items`, { title: 'C', required: true, dependsOn: [S.A.id] }));
  ok(await api('POST', `/api/checklists/${ck2.id}/items`, { title: 'D', required: false }));
  S.cyc = ok(await api('POST', '/api/cycles', { name: 'Ciclo P', steps: [{ stageId: st1.id }, { stageId: st2.id }, { stageId: st3.id }] }));
  ok(await api('PUT', `/api/cycles/${S.cyc.id}/steps/${S.cyc.steps[0].id}/checklists`, { checklistIds: [ck1.id] }));
  S.cyc = ok(await api('PUT', `/api/cycles/${S.cyc.id}/steps/${S.cyc.steps[1].id}/checklists`, { checklistIds: [ck2.id] })).cycle || ok(await api('GET', '/api/state')).cycles.find((c) => c.id === S.cyc.id);
  S.p = ok(await api('POST', '/api/projects', { name: 'Projeto Progresso', cycleId: S.cyc.id }));
  [S.s1, S.s2] = S.cyc.steps.map((s) => s.id);
});

test('projeto novo: 0% com todos os itens do ciclo no universo (inclusive etapas não iniciadas)', async () => {
  const pr = await progress();
  assert.deepEqual([pr.done, pr.total, pr.percent], [0, 5, 0]);
  assert.equal(pr.steps, 3); assert.equal(pr.concluded, false);
  assert.equal(pr.requiredTotal, 3);
});

test('parcial, evidência faltando, revertido e dependência', async () => {
  ok(await api('PUT', `/api/projects/${S.p.id}/step`, { stepId: S.s1 }));
  let inst = ok(await api('POST', `/api/projects/${S.p.id}/checklists/${S.s1}/open`, {})).instance;
  ok(await mark(S.s1, item(inst, 'B'), true));
  assert.deepEqual([(await progress()).done, (await progress()).percent], [1, 11]); // opcional conta; etapa 1 = 1/3 dos itens → (1/3)/3 etapas
  ok(await mark(S.s1, item(inst, 'A'), true)); // marcado SEM a evidência exigida
  let pr = await progress();
  assert.equal(pr.done, 1); assert.equal(pr.awaitingEvidence, 1); // não conta como concluído
  // dependência: C depende de A (ainda aguardando evidência) → não conclui; o progresso não muda
  const i2 = ok(await api('POST', `/api/projects/${S.p.id}/checklists/${S.s2}/open`, {})).instance;
  assert.equal((await mark(S.s2, item(i2, 'C'), true)).json.code, 'DEPENDENCY_PENDING');
  assert.equal((await progress()).done, 1);
  const up = await upload(`/api/projects/${S.p.id}/checklists/${S.s1}/items/${item(inst, 'A').id}/evidence`, 'a.png', PNG);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual([(await progress()).done, (await progress()).percent], [2, 22]);
  ok(await mark(S.s1, item(inst, 'B'), false)); // revertido
  assert.equal((await progress()).done, 1);
  ok(await mark(S.s1, item(inst, 'B'), true));
  assert.equal((await progress()).done, 2);
});

test('pendência herdada: o item transferido continua contando (uma vez só) até ser concluído', async () => {
  let r = await api('PUT', `/api/projects/${S.p.id}/step`, { stepId: S.s2 });
  assert.equal(r.json.code, 'CHECKLIST_CARRY', JSON.stringify(r.json));
  ok(await api('PUT', `/api/projects/${S.p.id}/step`, { stepId: S.s2, confirmCarry: true, carryKeys: r.json.transferable.map((x) => x.key) }));
  let pr = await progress();
  assert.deepEqual([pr.done, pr.total, pr.percent], [2, 5, 22]); // T herdado pela etapa 2: mesmo item, ainda pendente, sem duplicar
  const i2 = ok(await api('POST', `/api/projects/${S.p.id}/checklists/${S.s2}/open`, {})).instance;
  const T = item(i2, 'T');
  assert.ok(T && T.origin, 'T aparece como herdada');
  ok(await mark(T.origin.stepId, T, true));
  ok(await mark(S.s2, item(i2, 'C'), true)); // A concluída: a dependência libera
  pr = await progress();
  assert.deepEqual([pr.done, pr.total, pr.percent], [4, 5, 50]); // etapa 1 completa (1) + etapa 2 com 1 de 2 (0,5), sobre 3 etapas
  ok(await mark(S.s2, item(i2, 'D'), true));
  pr = await progress();
  assert.deepEqual([pr.done, pr.total, pr.percent], [5, 5, 67]); // TODOS os itens marcados, mas ainda na etapa 2 de 3: NÃO é 100%
  assert.equal(pr.concluded, false);
  ok(await api('PUT', `/api/projects/${S.p.id}/step`, { stepId: S.cyc.steps[2].id })); // conclui o ciclo (último passo)
  pr = await progress();
  assert.deepEqual([pr.percent, pr.concluded], [100, true]);
});

test('arredondamento nunca mostra 100% com pendência; ciclo sem checklist = null; sidebar e Visão Geral usam o mesmo valor', async () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ archived: false, required: true, done: i < 199, evidence: { mode: 'none' }, evidences: [] }));
  const data = { checklists: [], checklistItems: [] };
  const project = { steps: [{ id: 's', checklistIds: [] }, { id: 't', checklistIds: [] }], checklists: [{ stepId: 's', items }], stepId: 's' };
  assert.equal(C.projectProgress(data, project).percent, 50); // 1 de 2 etapas (199/200 itens ≈ 0,995)
  const ok1 = (n) => Array.from({ length: n }, () => ({ archived: false, required: true, done: true, evidence: { mode: 'none' }, evidences: [] }));
  const all = { steps: project.steps, stepId: 's', checklists: [{ stepId: 's', items: ok1(3) }, { stepId: 't', items: ok1(3) }] }; // tudo marcado, mas o ciclo não foi concluído
  assert.equal(C.projectProgress(data, all).percent, 99); // teto: 100% só ao concluir o ciclo
  assert.equal(C.projectProgress(data, { steps: [], checklists: [], stepId: null }).percent, null);
  // a tela não calcula: a lateral (renderNav) e a Visão Geral (renderHome) desenham p.progress pela mesma função
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const nav = appJs.slice(appJs.indexOf('function renderNav'), appJs.indexOf('const NAV_MENU'));
  const home = appJs.slice(appJs.indexOf('function renderHome'), appJs.indexOf('// ---------- Projeto ----------'));
  assert.match(nav, /projectProgressBar\(/); assert.match(home, /projectProgressBar\(/);
  assert.doesNotMatch(appJs, /itemStatus|requiredDone \/|done \/ .*total \* 100/); // nenhuma conta de % no front para o projeto
});

test('REGRESSÃO do relato: todos os itens marcados, mas etapas por vir (inclusive sem checklist) → nunca 100%', () => {
  const done = (n) => Array.from({ length: n }, () => ({ archived: false, required: true, done: true, evidence: { mode: 'none' }, evidences: [] }));
  const data = { checklists: [], checklistItems: [], stages: [] };
  // ciclo de 5 etapas: 1 e 2 com itens (todos marcados), 3 e 4 SEM checklist, 5 = conclusão. Projeto na etapa 2.
  const steps = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, checklistIds: [] }));
  const project = { steps, stepId: 'b', checklists: [{ stepId: 'a', items: done(4) }, { stepId: 'b', items: done(2) }] };
  let pr = C.projectProgress(data, project);
  assert.equal(pr.done, pr.total); // 100% dos itens...
  assert.equal(pr.percent, 40); // ...mas só 2 de 5 etapas feitas
  // passou pelas etapas sem checklist: cada uma conta ao ser ultrapassada
  assert.equal(C.projectProgress(data, { ...project, stepId: 'd' }).percent, 60); // a, b (itens) + c (ultrapassada); d é a atual
  assert.equal(C.projectProgress(data, { ...project, stepId: 'e' }).percent, 100); // último passo = ciclo concluído
  assert.equal(C.projectProgress(data, { ...project, stepId: null }).percent, 40); // sem etapa atual: só o que os itens já fizeram
});
