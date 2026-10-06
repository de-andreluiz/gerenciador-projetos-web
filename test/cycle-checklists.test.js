// Checklists por passo do ciclo (ciclo + estágio + checklists): o mesmo estágio em vários ciclos com checklists diferentes, o mesmo
// checklist reutilizado sem cópia, isolamento entre ciclos e projetos, migração segura de projetos existentes e exclusão protegida.
// Cenários do pedido: A (mesmo estágio, dois ciclos), B (mesmo checklist, sem duplicar), C (alterar o ciclo A não altera o B),
// D (projetos em ciclos diferentes), E (projeto existente antes da mudança), F (excluir o que está em uso), G (dependências,
// evidências e pendências herdadas continuam valendo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cyck-'));
const PORT = 4405;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

// ---- Arquivo de dados NO MODELO ANTIGO (checklists presos ao estágio), com um projeto em andamento ----
const item = (o) => ({ description: '', required: true, carryForward: false, dependsOn: [], evidence: { mode: 'none', type: 'imageOrDocument', min: 1, max: 10 }, links: [], scriptIds: [], condition: null, ...o });
const snap = (def, o = {}) => ({ id: `s-${def.id}`, defId: def.id, title: def.title, description: '', required: def.required, carryForward: false, dependsOn: [], evidence: def.evidence, links: [], scriptIds: [], checklistId: def.checklistId, condition: null,
  done: false, doneAt: null, doneBy: null, completedAt: null, completedBy: null, archived: false, evidences: [], runs: [], carriedTo: null, carriedAt: null, carryHistory: [], note: null, ...o });
const LEGACY_STEPS = [['cy-1', 'st-homologacao'], ['cy-2', 'st-documentacao'], ['cy-3', 'st-correcoes'], ['cy-4', 'st-producao'], ['cy-5', 'st-documentacao'], ['cy-6', 'st-correcoes'], ['cy-7', 'st-concluido']].map(([id, stageId]) => ({ id, stageId }));
const legacyItems = [
  item({ id: 'l1', stageId: 'st-homologacao', checklistId: 'ck-tec', title: 'Conferir carga', evidence: { mode: 'required', type: 'image', min: 1, max: 3 } }),
  item({ id: 'l2', stageId: 'st-homologacao', checklistId: 'ck-cli', title: 'Aprovação do cliente' }),
  item({ id: 'l3', stageId: 'st-homologacao', checklistId: 'ck-tec', title: 'Registrar observação', required: false }),
  item({ id: 'l4', stageId: 'st-documentacao', checklistId: 'ck-doc', title: 'Enviar documentação' }),
];
const legacyFile = {
  version: 1, settings: { warnDays: 7 },
  cycles: [{ id: 'cyc-padrao', name: 'Ciclo de migração padrão', description: '', steps: LEGACY_STEPS, version: 1, updatedAt: null }], defaultCycleId: 'cyc-padrao',
  checklists: [{ id: 'ck-tec', stageId: 'st-homologacao', name: 'Checklist Técnico' }, { id: 'ck-cli', stageId: 'st-homologacao', name: 'Checklist Cliente' }, { id: 'ck-doc', stageId: 'st-documentacao', name: 'Checklist' }],
  checklistItems: legacyItems,
  projects: [{
    id: 'legado1', name: 'Cliente Legado', description: '', rootDir: '', bases: [], deparas: [], milestones: [], cycleId: 'cyc-padrao', cycleVersion: 1, steps: JSON.parse(JSON.stringify(LEGACY_STEPS)),
    stepId: 'cy-1', stageHistory: [{ stepId: 'cy-1', stageId: 'st-homologacao', name: 'Homologação', color: '#00DBFF', at: '2026-01-01T00:00:00.000Z' }], corrections: [],
    checklists: [{ id: 'inst-1', stepId: 'cy-1', stageId: 'st-homologacao', stageName: 'Homologação', createdAt: '2026-01-01T00:00:00.000Z', syncedAt: '2026-01-01T00:00:00.000Z', items: [
      snap(legacyItems[0], { done: true, doneAt: 't', doneBy: 'elton', completedAt: 't', completedBy: 'elton', evidences: [{ id: 'ev-1', name: 'print.png', file: '1-cliente-legado-legado1/01-homologacao/ev-1_print.png', size: 70, type: 'image/png', at: 't', by: 'elton', description: '' }], note: { text: 'conferido no ambiente de teste', updatedAt: 't', updatedBy: 'elton' } }),
      snap(legacyItems[1]), snap(legacyItems[2])] }],
  }],
};
fs.mkdirSync(process.env.GP_DATA_DIR, { recursive: true });
const dataFile = path.join(process.env.GP_DATA_DIR, 'projects.json');
const legacyText = JSON.stringify(legacyFile, null, 2);
fs.writeFileSync(dataFile, legacyText);

const { app } = require('../server');
const C = require('../src/checklist');
const cycles = require('../src/cycles');
const { applyDefaults } = require('../src/defaults');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- Migração (cenário E) ----------
test('E: dados antigos — cada passo recebe os checklists que o estágio tinha; nada some e nenhum projeto vira “versão nova”', async () => {
  const st = (await api('GET', '/api/state')).json;
  const cyc = st.cycles[0];
  const ids = (stepId) => cyc.steps.find((s) => s.id === stepId).checklistIds;
  assert.deepEqual(ids('cy-1'), ['ck-tec', 'ck-cli'], 'mesma lista e mesma ordem de antes');
  assert.deepEqual(ids('cy-2'), ['ck-doc']);
  assert.deepEqual(ids('cy-5'), ['ck-doc'], 'o estágio repetido no ciclo continua com os mesmos checklists nas duas passagens');
  assert.deepEqual(ids('cy-4'), []);
  assert.deepEqual(st.checklists.map((c) => c.id), ['ck-tec', 'ck-cli', 'ck-doc']);
  assert.equal(st.checklistItems.length, 4);
  const p = st.projects.find((x) => x.id === 'legado1');
  assert.deepEqual(p.steps.find((s) => s.id === 'cy-1').checklistIds, ['ck-tec', 'ck-cli'], 'a cópia do ciclo que o projeto guarda também foi migrada');
  assert.equal(p.cycleUpdate.available, false, 'a migração não gera “nova versão disponível”');
  assert.equal(p.cycleVersion, 1);
  assert.equal(p.checklist['cy-1'].total, 3);

  // o projeto em andamento continua com tudo: itens, marcação, evidência, observação e a mesma ordem de grupos
  const inst = (await api('POST', '/api/projects/legado1/checklists/cy-1/open', {})).json.instance;
  assert.deepEqual(inst.groups.map((g) => g.name), ['Checklist Técnico', 'Checklist Cliente']);
  const conf = inst.items.find((i) => i.title === 'Conferir carga');
  assert.equal(conf.status, 'done');
  assert.equal(conf.evidences.length, 1);
  assert.equal(conf.note.text, 'conferido no ambiente de teste');
  assert.equal(inst.sync.changed, false, 'o modelo do passo é igual ao que o projeto tem');
  // a regra de avanço continua a mesma (o obrigatório do checklist do cliente bloqueia)
  const gate = await api('PUT', '/api/projects/legado1/step', { stepId: 'cy-2' });
  assert.equal(gate.status, 409);
  assert.equal(gate.json.code, 'CHECKLIST_PENDING');
  assert.deepEqual(gate.json.blocked[0].pending.map((x) => x.title), ['Aprovação do cliente']);
  // projeto novo no mesmo ciclo recebe os mesmos checklists de antes
  const np = (await api('POST', '/api/projects', { name: 'Projeto Novo' })).json;
  const ni = (await api('POST', `/api/projects/${np.id}/checklists/cy-1/open`, {})).json.instance;
  assert.deepEqual(ni.items.map((i) => i.title), ['Conferir carga', 'Registrar observação', 'Aprovação do cliente']);
});

test('E: antes de migrar guarda uma cópia do arquivo original (uma vez só) e o arquivo salvo continua com os dados antigos', () => {
  const bak = `${dataFile}.antes-checklists-por-ciclo.bak`;
  assert.ok(fs.existsSync(bak), 'cópia criada na primeira carga');
  assert.equal(fs.readFileSync(bak, 'utf8'), legacyText, 'idêntica ao arquivo que existia antes da mudança');
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(saved.checklists.every((c) => c.stageId), 'o vínculo antigo (origem) fica no arquivo como legado: dá para voltar à versão anterior');
});

test('migração é idempotente: não refaz a associação de um passo que já foi migrado/editado', () => {
  const raw = JSON.parse(legacyText);
  const once = applyDefaults(JSON.parse(JSON.stringify(raw)));
  once.cycles[0].steps.find((s) => s.id === 'cy-1').checklistIds = ['ck-cli']; // pessoa escolheu só o checklist do cliente neste ciclo
  const twice = applyDefaults(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice.cycles[0].steps.find((s) => s.id === 'cy-1').checklistIds, ['ck-cli']);
  assert.equal(cycles.needsChecklistMigration(raw), true);
  assert.equal(cycles.needsChecklistMigration(once), false);
  assert.equal(cycles.needsChecklistMigration({ projects: [] }), false, 'arquivo sem checklists não precisa de cópia');
});

// ---------- Modelo novo (cenários A, B, C, D, F, G) ----------
const mkStage = async (name) => (await api('POST', '/api/stages', { name, color: '#112233' })).json;
const mkCk = async (name) => { const r = await api('POST', '/api/checklists', { name }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const mkItem = async (ck, o) => { const r = await api('POST', `/api/checklists/${ck.id}/items`, { required: true, ...o }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const link = async (cyc, stepIdx, cks) => { const r = await api('PUT', `/api/cycles/${cyc.id}/steps/${cyc.steps[stepIdx].id}/checklists`, { checklistIds: cks.map((c) => c.id) }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const stateOf = async () => (await api('GET', '/api/state')).json;
const open = async (p, stepId) => (await api('POST', `/api/projects/${p.id}/checklists/${stepId}/open`, {})).json.instance;
const groupsOf = (inst) => inst.groups.map((g) => g.name);

test('A+B+C+D: mesmo estágio em dois ciclos com checklists diferentes, checklist reutilizado sem cópia, isolamento entre ciclos e projetos', async () => {
  const Pre = await mkStage('Preparação CK'); const Val = await mkStage('Validação CK');
  const [func, folha, fin, acad, matr, infra] = [await mkCk('Funcionários'), await mkCk('Folha'), await mkCk('Financeiro'), await mkCk('Acadêmico'), await mkCk('Matrículas'), await mkCk('Infraestrutura')];
  for (const c of [func, folha, fin, acad, matr]) await mkItem(c, { title: `Item ${c.name}` });
  await mkItem(infra, { title: 'Validar servidor' });

  const mkCycle = async (name) => (await api('POST', '/api/cycles', { name, steps: [{ stageId: Pre.id }, { stageId: Val.id }] })).json;
  let cF = await mkCycle('Migração Folha CK'); let cE = await mkCycle('Migração Educacional CK');
  assert.deepEqual(cF.steps.map((s) => s.checklistIds), [[], []], 'passo novo começa sem checklists');
  await link(cF, 0, [infra]); await link(cE, 0, [infra]); // B: o mesmo checklist nos dois ciclos
  const before = await stateOf();
  const nCk = before.checklists.length; const nItems = before.checklistItems.length;
  await link(cF, 1, [func, folha, fin]); // A: o MESMO estágio “Validação”, outros checklists
  await link(cE, 1, [acad, matr]);
  const st = await stateOf();
  assert.equal(st.stages.filter((s) => s.name === 'Validação CK').length, 1, 'o estágio foi cadastrado uma vez só');
  assert.equal(st.checklists.length, nCk, 'associar não cria checklist');
  assert.equal(st.checklistItems.length, nItems, 'B: associar não copia itens');
  cF = st.cycles.find((c) => c.id === cF.id); cE = st.cycles.find((c) => c.id === cE.id);
  assert.deepEqual(cF.steps[1].checklistIds, [func.id, folha.id, fin.id]);
  assert.deepEqual(cE.steps[1].checklistIds, [acad.id, matr.id]);
  assert.equal(cF.steps[1].stageId, cE.steps[1].stageId);

  // D: cada projeto recebe a configuração do SEU ciclo
  const pF = (await api('POST', '/api/projects', { name: 'Cliente Folha', cycleId: cF.id })).json;
  const pE = (await api('POST', '/api/projects', { name: 'Cliente Edu', cycleId: cE.id })).json;
  const iF = await open(pF, cF.steps[1].id); const iE = await open(pE, cE.steps[1].id);
  assert.deepEqual(groupsOf(iF), ['Funcionários', 'Folha', 'Financeiro']);
  assert.deepEqual(groupsOf(iE), ['Acadêmico', 'Matrículas']);
  assert.deepEqual(iF.items.map((i) => i.title), ['Item Funcionários', 'Item Folha', 'Item Financeiro']);
  assert.equal(iE.items.some((i) => /Funcion|Folha|Financ/.test(i.title)), false);
  // B: o checklist reutilizado é a mesma definição nos dois projetos (mesmo defId), cada um com o seu próprio estado
  const infF = (await open(pF, cF.steps[0].id)).items[0]; const infE = (await open(pE, cE.steps[0].id)).items[0];
  assert.equal(infF.defId, infE.defId);
  assert.notEqual(infF.id, infE.id);
  await api('PUT', `/api/projects/${pF.id}/checklists/${cF.steps[0].id}/items/${infF.id}`, { done: true });
  assert.equal((await open(pE, cE.steps[0].id)).items[0].done, false, 'marcar num projeto não marca no outro');

  // ordem é da associação: no outro ciclo a mesma definição pode vir em outra posição
  await link(cE, 1, [matr, acad]);
  assert.deepEqual((await stateOf()).cycles.find((c) => c.id === cE.id).steps[1].checklistIds, [matr.id, acad.id]);
  assert.deepEqual((await stateOf()).cycles.find((c) => c.id === cF.id).steps[1].checklistIds, [func.id, folha.id, fin.id], 'o ciclo Folha não mudou');

  // C: alterar o ciclo A não altera o B; o projeto do ciclo A só muda quando a pessoa aplica a nova versão
  const vB = (await stateOf()).cycles.find((c) => c.id === cE.id).version;
  const markFunc = iF.items.find((i) => i.title === 'Item Funcionários');
  await api('PUT', `/api/projects/${pF.id}/checklists/${cF.steps[1].id}/items/${markFunc.id}`, { done: true });
  await link(cF, 1, [fin, func]); // sai “Folha”, muda a ordem
  const after = await stateOf();
  assert.equal(after.cycles.find((c) => c.id === cE.id).version, vB, 'ciclo B intacto (nem versão nova)');
  assert.deepEqual(after.cycles.find((c) => c.id === cE.id).steps[1].checklistIds, [matr.id, acad.id]);
  const projF = after.projects.find((p) => p.id === pF.id);
  assert.deepEqual(projF.steps[1].checklistIds, [func.id, folha.id, fin.id], 'o projeto continua com a cópia dele');
  assert.equal(projF.cycleUpdate.available, true, 'mas é avisado de que há versão nova');
  assert.deepEqual(projF.cycleUpdate.checklistChanges.map((c) => [c.stageName, c.added, c.removed]), [['Validação CK', [], ['Folha']]]);
  // o projeto do ciclo Educacional só tem versão nova por causa da reordenação feita nele mesmo (nunca por mudanças do ciclo Folha)
  const dE = after.projects.find((p) => p.id === pE.id).cycleUpdate;
  assert.deepEqual(dE.checklistChanges.map((c) => [c.stageName, c.added, c.removed, c.reordered]), [['Validação CK', [], [], true]]);
  assert.deepEqual(groupsOf(await open(pE, cE.steps[1].id)), ['Acadêmico', 'Matrículas'], 'e continua com a ordem da cópia dele até aplicar');
  assert.deepEqual(groupsOf(await open(pF, cF.steps[1].id)), ['Funcionários', 'Folha', 'Financeiro'], 'nada muda sozinho');
  // aplicar: o checklist aberto avisa que o modelo mudou; sincronizar arquiva só o que saiu e preserva marcações
  assert.equal((await api('POST', `/api/projects/${pF.id}/cycle/apply`, {})).status, 200);
  const stale = await open(pF, cF.steps[1].id);
  assert.equal(stale.sync.changed, true);
  const synced = (await api('POST', `/api/projects/${pF.id}/checklists/${cF.steps[1].id}/sync`, {})).json.instance;
  assert.deepEqual(groupsOf(synced), ['Financeiro', 'Funcionários']);
  assert.equal(synced.items.find((i) => i.title === 'Item Funcionários').done, true, 'marcação preservada');
  assert.deepEqual(synced.archived.map((i) => i.title), ['Item Folha'], 'saiu do modelo: arquivado, não apagado');

  // projeto novo no ciclo A já nasce com a nova configuração
  const pF2 = (await api('POST', '/api/projects', { name: 'Cliente Folha 2', cycleId: cF.id })).json;
  assert.deepEqual(groupsOf(await open(pF2, cF.steps[1].id)), ['Financeiro', 'Funcionários']);
});

test('copiar ciclo leva as referências dos checklists (sem duplicar); trocar o estágio do passo começa sem checklists; ids repetidos contam uma vez', async () => {
  const S1 = await mkStage('Copia 1'); const S2 = await mkStage('Copia 2');
  const ck = await mkCk('Checklist de cópia'); await mkItem(ck, { title: 'Único item' });
  const cA = (await api('POST', '/api/cycles', { name: 'Origem cópia', steps: [{ stageId: S1.id, checklistIds: [ck.id, ck.id] }] })).json;
  assert.deepEqual(cA.steps[0].checklistIds, [ck.id], 'repetido conta uma vez');
  const nItems = (await stateOf()).checklistItems.length;
  const cB = (await api('POST', '/api/cycles', { name: 'Cópia do ciclo', copyFrom: cA.id })).json;
  assert.deepEqual(cB.steps[0].checklistIds, [ck.id]);
  assert.notEqual(cB.steps[0].id, cA.steps[0].id);
  assert.equal((await stateOf()).checklistItems.length, nItems, 'copiar o ciclo não copia itens');
  // editar o ciclo sem mandar checklistIds mantém; trocar o estágio do passo zera
  let r = await api('PUT', `/api/cycles/${cA.id}`, { steps: [{ id: cA.steps[0].id, stageId: S1.id }] });
  assert.deepEqual(r.json.steps[0].checklistIds, [ck.id]);
  r = await api('PUT', `/api/cycles/${cA.id}`, { steps: [{ id: cA.steps[0].id, stageId: S2.id }] });
  assert.deepEqual(r.json.steps[0].checklistIds, [], 'a associação é do par ciclo + estágio');
  assert.deepEqual((await stateOf()).cycles.find((c) => c.id === cB.id).steps[0].checklistIds, [ck.id], 'a cópia não foi afetada');
  assert.equal((await api('PUT', `/api/cycles/${cB.id}/steps/${cB.steps[0].id}/checklists`, { checklistIds: ['nao-existe'] })).status, 400);
});

test('F: excluir o que está em uso — checklist e estágio são bloqueados com a lista de onde são usados', async () => {
  const S = await mkStage('Estágio em uso');
  const ck = await mkCk('Checklist em uso'); await mkItem(ck, { title: 'Item em uso' });
  const c1 = (await api('POST', '/api/cycles', { name: 'Ciclo Uso 1', steps: [{ stageId: S.id }] })).json;
  const c2 = (await api('POST', '/api/cycles', { name: 'Ciclo Uso 2', steps: [{ stageId: S.id }, { stageId: S.id }] })).json;
  await link(c1, 0, [ck]); await link(c2, 1, [ck]);

  let r = await api('DELETE', `/api/checklists/${ck.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CHECKLIST_IN_USE');
  assert.match(r.json.error, /Este checklist \(“Checklist em uso”\) está sendo utilizado em:/);
  assert.match(r.json.error, /• Ciclo Uso 1 \/ Estágio em uso/);
  assert.match(r.json.error, /• Ciclo Uso 2 \/ Estágio em uso/);
  assert.match(r.json.error, /Remova essas associações antes de excluir\./);
  assert.deepEqual(r.json.usage.map((u) => u.cycleName), ['Ciclo Uso 1', 'Ciclo Uso 2']);
  assert.equal((await stateOf()).checklistItems.filter((i) => i.checklistId === ck.id).length, 1, 'nada foi apagado');

  r = await api('DELETE', `/api/stages/${S.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'STAGE_IN_USE');
  assert.match(r.json.error, /• Ciclo Uso 1/);
  assert.match(r.json.error, /• Ciclo Uso 2 \(2 vezes\)/);
  assert.match(r.json.error, /Remova o estágio desses ciclos antes de excluir\./);

  // removendo as associações, o checklist pode ser excluído (junto com seus itens); o estágio depois de sair dos ciclos
  await link(c1, 0, []); await link(c2, 1, []);
  assert.equal((await api('DELETE', `/api/checklists/${ck.id}`)).status, 200);
  assert.ok(!(await stateOf()).checklistItems.some((i) => i.checklistId === ck.id));
  assert.equal((await api('DELETE', `/api/cycles/${c1.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/cycles/${c2.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/stages/${S.id}`)).status, 200);
});

test('G: dependências entre checklists, evidências e pendências herdadas continuam valendo com a nova associação', async () => {
  const [A, B, H, Z] = [await mkStage('G Validação'), await mkStage('G Conferência'), await mkStage('G Homologação'), await mkStage('G Fim')];
  const base_ = await mkCk('G Base'); const fech = await mkCk('G Fechamento');
  const cadastro = await mkItem(base_, { title: 'Cadastrar base', carryForward: true, evidence: { mode: 'required', type: 'image', min: 1, max: 2 } });
  const caixa = await mkItem(fech, { title: 'Fechar caixa', dependsOn: [cadastro.id] }); // dependência ENTRE checklists
  const mk = async (name, steps) => (await api('POST', '/api/cycles', { name, steps: steps.map((s) => ({ stageId: s.id })) })).json;
  // Ciclo com os dois checklists na mesma etapa; outro ciclo só com o de fechamento (a dependência não se aplica lá)
  const cX = await mk('Ciclo G completo', [A, B, H, Z]); const cY = await mk('Ciclo G só fechamento', [A, H, Z]);
  await link(cX, 0, [base_, fech]); await link(cY, 0, [fech]);
  const pX = (await api('POST', '/api/projects', { name: 'G Projeto X', cycleId: cX.id })).json;
  const pY = (await api('POST', '/api/projects', { name: 'G Projeto Y', cycleId: cY.id })).json;
  assert.equal((await api('PUT', `/api/projects/${pX.id}/step`, { stepId: cX.steps[0].id })).status, 200);
  assert.equal((await api('PUT', `/api/projects/${pY.id}/step`, { stepId: cY.steps[0].id })).status, 200);

  const iX = await open(pX, cX.steps[0].id); const iY = await open(pY, cY.steps[0].id);
  const fx = iX.items.find((i) => i.title === 'Fechar caixa'); const fy = iY.items.find((i) => i.title === 'Fechar caixa');
  assert.equal(fx.blocked, true, 'no ciclo em que o checklist base está presente a dependência vale');
  assert.deepEqual(fx.dependencies.map((d) => [d.title, d.status, d.stageName]), [['Cadastrar base', 'pending', 'G Validação']]);
  assert.equal(fy.blocked, false, 'no ciclo em que nenhuma etapa usa o checklist base a dependência não se aplica (não trava para sempre)');
  assert.equal((await api('PUT', `/api/projects/${pY.id}/checklists/${cY.steps[0].id}/items/${fy.id}`, { done: true })).status, 200);
  assert.equal((await api('PUT', `/api/projects/${pX.id}/checklists/${cX.steps[0].id}/items/${fx.id}`, { done: true })).status, 409, 'dependência pendente bloqueia');

  // evidência exigida: marcado sem arquivo continua pendente; com o arquivo, conclui e libera a dependência
  const cad = iX.items.find((i) => i.title === 'Cadastrar base');
  const url = `/api/projects/${pX.id}/checklists/${cX.steps[0].id}/items/${cad.id}`;
  let r = await api('PUT', url, { done: true });
  assert.equal(r.json.instance.items.find((i) => i.id === cad.id).status, 'awaiting_evidence');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]);
  const up = await fetch(`${base}${url}/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-File-Name': encodeURIComponent('print.png'), 'X-File-Type': 'image/png' }, body: PNG });
  assert.equal(up.status, 200);
  assert.equal((await api('PUT', `/api/projects/${pX.id}/checklists/${cX.steps[0].id}/items/${fx.id}`, { done: true })).status, 200, 'concluída a dependência (marcado + evidência), libera');

  // pendência herdada: item transferível do checklist compartilhado segue para a etapa seguinte e continua o mesmo item
  r = await api('PUT', url, { done: false });
  const adv = await api('PUT', `/api/projects/${pX.id}/step`, { stepId: cX.steps[1].id });
  assert.equal(adv.status, 409);
  assert.equal(adv.json.code, 'CHECKLIST_CARRY');
  const ok = await api('PUT', `/api/projects/${pX.id}/step`, { stepId: cX.steps[1].id, confirmCarry: true, carryKeys: adv.json.transferable.map((x) => x.key) });
  assert.equal(ok.status, 200);
  const next = await open(pX, cX.steps[1].id);
  assert.deepEqual(next.inherited.map((i) => [i.title, i.origin.stageName, i.status]), [['Cadastrar base', 'G Validação', 'pending']]);
  assert.equal(next.inherited[0].id, cad.id, 'o mesmo item (mesmo id, mesmas evidências), não uma cópia');
  assert.equal(next.inherited[0].evidences.length, 1);
  // o outro projeto, do outro ciclo, não tem pendência herdada
  assert.deepEqual((await stateOf()).projects.find((p) => p.id === pY.id).pendencies, { requiredPending: 0, inherited: 0, carried: 0 });
  // reverter a transferência continua funcionando
  const back = await api('POST', `/api/projects/${pX.id}/checklists/${cX.steps[0].id}/items/${cad.id}/restore`, { confirm: true });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal((await open(pX, cX.steps[1].id)).inherited.length, 0);

  // regras puras: instância e modelo seguem os checklists do passo, na ordem da associação
  const data = (await stateOf());
  const step = data.cycles.find((c) => c.id === cX.id).steps[0];
  assert.deepEqual(C.defsForStep({ checklists: data.checklists, checklistItems: data.checklistItems }, step).map((d) => d.title), ['Cadastrar base', 'Fechar caixa']);
  assert.ok(caixa.id);
});

// ---------- Padrão "todos selecionados" e personalização por ciclo ----------
test('padrão: etapa nova (ou com estágio trocado) já vem com TODOS os checklists do estágio; personalizar vale só para aquele ciclo e persiste', async () => {
  const S = await mkStage('Padrão Validação'); const T = await mkStage('Padrão Outro');
  const mkFor = async (stage, name) => { const r = await api('POST', '/api/checklists', { name, stageId: stage.id }); assert.equal(r.status, 200, JSON.stringify(r.json)); await mkItem(r.json, { title: `Item ${name}` }); return r.json; };
  const [a, b, c3] = [await mkFor(S, 'Padrão A'), await mkFor(S, 'Padrão B'), await mkFor(S, 'Padrão C')];
  const outro = await mkFor(T, 'Padrão Outro Estágio');
  assert.equal((await api('POST', '/api/checklists', { name: 'x', stageId: 'nao-existe' })).status, 400);
  assert.equal((await api('POST', '/api/checklists', { name: ' padrão a ', stageId: S.id })).status, 409, 'nome único dentro do estágio');
  const mesmoNome = await api('POST', '/api/checklists', { name: 'Padrão A', stageId: T.id });
  assert.equal(mesmoNome.status, 200, 'o mesmo nome em outro estágio é permitido');
  const poolT = [outro.id, mesmoNome.json.id]; // checklists cadastrados para o estágio T, na ordem do cadastro

  // 1) estágio adicionado ao ciclo = todos os checklists dele selecionados, na ordem do cadastro
  const mk = async (name) => (await api('POST', '/api/cycles', { name, steps: [{ stageId: S.id }] })).json;
  const cA = await mk('Padrão Ciclo A'); const cB = await mk('Padrão Ciclo B');
  assert.deepEqual(cA.steps[0].checklistIds, [a.id, b.id, c3.id]);
  assert.deepEqual(cB.steps[0].checklistIds, [a.id, b.id, c3.id]);
  // etapa adicionada depois (sem id) e etapa que troca de estágio também começam com todos
  let r = await api('PUT', `/api/cycles/${cA.id}`, { steps: [{ id: cA.steps[0].id, stageId: S.id }, { stageId: T.id }] });
  assert.deepEqual(r.json.steps[1].checklistIds, poolT);
  r = await api('PUT', `/api/cycles/${cA.id}`, { steps: [{ id: r.json.steps[0].id, stageId: T.id }, { id: r.json.steps[1].id, stageId: T.id }] });
  assert.deepEqual(r.json.steps[0].checklistIds, poolT, 'trocar o estágio = todos do novo estágio');
  await api('PUT', `/api/cycles/${cA.id}`, { steps: [{ id: r.json.steps[0].id, stageId: S.id }] });

  // 3/4) personalizar no ciclo A (desmarcar B e reordenar) persiste e NÃO muda o ciclo B, o cadastro nem o estágio
  const before = await stateOf();
  const stepA = (await stateOf()).cycles.find((x) => x.id === cA.id).steps[0];
  await api('PUT', `/api/cycles/${cA.id}/steps/${stepA.id}/checklists`, { checklistIds: [c3.id, a.id] });
  const after = await stateOf();
  assert.deepEqual(after.cycles.find((x) => x.id === cA.id).steps[0].checklistIds, [c3.id, a.id]);
  assert.deepEqual(after.cycles.find((x) => x.id === cB.id).steps[0].checklistIds, [a.id, b.id, c3.id], 'ciclo B intacto');
  assert.deepEqual(after.checklists, before.checklists, 'cadastro de checklists intacto');
  assert.deepEqual(after.stages, before.stages, 'estágio intacto');
  assert.deepEqual(after.checklistItems, before.checklistItems);
  // 5) cancelar na tela não chama a API: o estado do servidor é o mesmo (nada a fazer além de reler)
  assert.deepEqual((await stateOf()).cycles.find((x) => x.id === cA.id).steps[0].checklistIds, [c3.id, a.id], 'persistiu');

  // 8) projetos herdam só os checklists selecionados no ciclo deles
  const pA = (await api('POST', '/api/projects', { name: 'Padrão Proj A', cycleId: cA.id })).json;
  const pB = (await api('POST', '/api/projects', { name: 'Padrão Proj B', cycleId: cB.id })).json;
  assert.deepEqual(groupsOf(await open(pA, cA.steps[0].id)), ['Padrão C', 'Padrão A']);
  assert.deepEqual(groupsOf(await open(pB, cB.steps[0].id)), ['Padrão A', 'Padrão B', 'Padrão C']);

  // excluir um estágio sem uso não apaga os checklists cadastrados para ele: ficam sem estágio
  const U = await mkStage('Padrão Descartável');
  const ck = (await api('POST', '/api/checklists', { name: 'Padrão Órfão', stageId: U.id })).json;
  assert.equal((await api('DELETE', `/api/stages/${U.id}`)).status, 200);
  const orphan = (await stateOf()).checklists.find((k) => k.id === ck.id);
  assert.ok(orphan, 'o checklist continua cadastrado');
  assert.equal(orphan.stageId, null);
});
