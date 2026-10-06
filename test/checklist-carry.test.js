// Pendências transferíveis entre etapas (carryForward) e analista do projeto.
// Cenários do pedido: A (não transferível bloqueia), B (transferível pergunta), C (transferir = avança, continua pendente, aparece
// como herdada), D (evidência continua exigida), E (uma instância só, histórico preservado), F (conclusão bloqueada), G (conclusão
// liberada), H (analista criar → editar → visualizar) — além do isolamento modelo × projeto (sincronizar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-carry-'));
const PORT = 4403;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const C = require('../src/checklist');
const ExcelJS = require('exceljs');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]);
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const upload = async (url, name, buf) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-File-Name': encodeURIComponent(name), 'X-File-Type': 'image/png' }, body: buf });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

test('regras puras: transferível não bloqueia (vai para "transferable"); conclusão nunca transfere', () => {
  const data = require('../src/defaults').applyDefaults({ scripts: [], projects: [] });
  data.checklists = [{ id: 'ck-h', name: 'Checklist H' }];
  const def = (id, o = {}) => ({ id, checklistId: 'ck-h', title: id, description: '', required: true, carryForward: false, evidence: { mode: 'none', type: 'any', min: 1, max: 10 }, links: [], scriptIds: [], condition: null, ...o });
  data.checklistItems = [def('fixo'), def('leva', { carryForward: true }), def('opc', { required: false })];
  const p = { id: 'p', name: 'P', stepId: 'cy-1', stageHistory: [], checklists: [], steps: JSON.parse(JSON.stringify(data.cycles[0].steps)) };
  for (const st of p.steps) st.checklistIds = st.stageId === 'st-homologacao' ? ['ck-h'] : []; // só Homologação usa o checklist neste ciclo
  const inst = C.ensureInstance(data, p, 'cy-1');
  let g = C.checkAdvance(data, p, 'cy-2');
  assert.equal(g.ok, false, 'A: obrigatório não transferível bloqueia');
  assert.deepEqual(g.blocked[0].pending.map((x) => x.title), ['fixo']);
  assert.deepEqual(g.transferable.map((x) => x.title), ['leva']);
  C.setDone(inst.items[0], true, 'e', 't');
  g = C.checkAdvance(data, p, 'cy-2');
  assert.equal(g.ok, true, 'B: só o transferível pendente: pode avançar (com confirmação)');
  assert.equal(g.transferable.length, 1);
  assert.equal(g.final, false);
  // ir direto para o último passo (Concluído) = conclusão: o transferível passa a bloquear
  g = C.checkAdvance(data, p, 'cy-7');
  assert.equal(g.final, true);
  assert.equal(g.ok, false);
  assert.deepEqual(g.transferable, []);
  assert.ok(g.blocked.flatMap((b) => b.pending).some((x) => x.title === 'leva'));
  // transferir: o mesmo item muda de lugar, não é copiado
  const moved = C.applyCarry(data, p, C.checkAdvance(data, p, 'cy-2').transferable, 'cy-2', 'e', 't2');
  assert.equal(moved.length, 1);
  p.stepId = 'cy-2';
  C.ensureInstance(data, p, 'cy-2');
  assert.equal(C.inheritedAt(p, 'cy-2').length, 1);
  assert.equal(C.inheritedAt(p, 'cy-2')[0].it, inst.items[1], 'é o mesmo objeto do passo de origem');
  assert.equal(C.itemStatus(inst.items[1]), 'pending', 'transferir não conclui');
  assert.deepEqual(C.projectPendencies(p), { requiredPending: 1, inherited: 1, carried: 1 });
  assert.equal(C.progressForStep(data, p, 'cy-1').carriedOut, 1);
  assert.equal(C.progressForStep(data, p, 'cy-2').inherited.pending, 1);
});

test('API: fluxo completo Preparação → Migração → Validação → Homologação → Concluído com pendências transferidas', async () => {
  const mkStage = async (name, color) => (await api('POST', '/api/stages', { name, color })).json;
  const [P, M, V, Hm, Z] = [await mkStage('Preparação', '#00DBFF'), await mkStage('Migração', '#A44DFF'), await mkStage('Validação', '#FF8900'), await mkStage('Homologação T', '#00FFD4'), await mkStage('Concluído T', '#D9FF65')];
  const cyc = (await api('POST', '/api/cycles', { name: 'Ciclo transferência', steps: [P, M, V, Hm, Z].map((s) => ({ stageId: s.id })) })).json;
  const [sP, sM, sV, sH, sZ] = cyc.steps.map((s) => s.id);
  // um checklist por estágio, associado ao passo desse estágio NESTE ciclo (o projeto recebe a cópia dos passos ao ser criado)
  const cks = new Map();
  const item = async (stage, o) => {
    let ck = cks.get(stage.id);
    if (!ck) {
      ck = (await api('POST', '/api/checklists', { name: `Checklist ${stage.name}` })).json; cks.set(stage.id, ck);
      const step = cyc.steps.find((x) => x.stageId === stage.id);
      assert.equal((await api('PUT', `/api/cycles/${cyc.id}/steps/${step.id}/checklists`, { checklistIds: [ck.id] })).status, 200);
    }
    const r = await api('POST', `/api/checklists/${ck.id}/items`, { required: true, ...o }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
  };
  await item(P, { title: 'Receber documentação complementar', carryForward: true });
  await item(M, { title: 'Executar carga principal' }); // obrigatório, NÃO transferível
  await item(M, { title: 'Receber arquivo complementar', carryForward: true, evidence: { mode: 'required', type: 'image', min: 1, max: 3 } });
  await item(M, { title: 'Gerar relatório', required: false });
  const conf = await item(V, { title: 'Executar conferência' });
  await item(Hm, { title: 'Aprovação cliente' });
  // opcional marcado como transferível: o servidor guarda false (só faz sentido em obrigatório)
  assert.equal((await item(V, { title: 'Opcional qualquer', required: false, carryForward: true })).carryForward, false);

  const p = (await api('POST', '/api/projects', { name: 'Cliente A', cycleId: cyc.id })).json;
  const step = (stepId, extra = {}) => api('PUT', `/api/projects/${p.id}/step`, { stepId, ...extra });
  const open = async (stepId) => (await api('POST', `/api/projects/${p.id}/checklists/${stepId}/open`, {})).json.instance;
  const mark = async (stepId, it, done = true) => api('PUT', `/api/projects/${p.id}/checklists/${stepId}/items/${it.id}`, { done });
  const byTitle = (inst, t) => inst.items.find((i) => i.title === t);

  assert.equal((await step(sP)).status, 200);
  // B: transferível pendente → pergunta (409 CHECKLIST_CARRY), nada muda até confirmar
  let r = await step(sM);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CHECKLIST_CARRY');
  assert.deepEqual(r.json.transferable.map((x) => [x.title, x.origin.stageName]), [['Receber documentação complementar', 'Preparação']]);
  assert.equal(r.json.target.stageName, 'Migração');
  assert.equal((await api('GET', '/api/state')).json.projects.find((x) => x.id === p.id).stepId, sP, 'sem confirmação, não avançou');
  assert.equal((await step(sM, { confirmCarry: true, carryKeys: ['outra-lista'] })).json.code, 'CHECKLIST_CARRY', 'lista diferente da atual: pergunta de novo');
  // C: confirmar → avança, o item continua pendente e aparece como herdado
  r = await step(sM, { confirmCarry: true, carryKeys: r.json.transferable.map((x) => x.key) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.stepId, sM);
  assert.deepEqual(r.json.pendencies, { requiredPending: 3, inherited: 1, carried: 1 });
  assert.equal(r.json.stageHistory.at(-1).carried, 1);
  let iM = await open(sM);
  assert.deepEqual(iM.inherited.map((x) => [x.title, x.origin.stageName, x.status]), [['Receber documentação complementar', 'Preparação', 'pending']]);
  assert.equal(iM.items.some((x) => x.title === 'Receber documentação complementar'), false, 'não aparece como item próprio da Migração');
  const iP = await open(sP);
  const docP = byTitle(iP, 'Receber documentação complementar');
  assert.equal(docP.status, 'pending', 'na origem continua pendente (não vira concluído por ter avançado)');
  assert.equal(docP.carriedToStage, 'Migração');
  assert.equal(iP.progress.requiredDone, 0);

  // A: obrigatório NÃO transferível pendente bloqueia (mesmo havendo transferíveis)
  r = await step(sV, { confirmCarry: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CHECKLIST_PENDING');
  assert.deepEqual(r.json.blocked.flatMap((b) => b.pending.map((x) => x.title)), ['Executar carga principal']);
  assert.equal(r.json.transferable.length, 2, 'informa também o que poderia ser transferido');
  // D (parte 1): marcar sem a evidência exigida → aguardando evidência = ainda pendente
  await mark(sM, byTitle(iM, 'Executar carga principal'));
  const arq = byTitle(iM, 'Receber arquivo complementar');
  iM = (await mark(sM, arq)).json.instance;
  assert.equal(byTitle(iM, 'Receber arquivo complementar').status, 'awaiting_evidence');
  // B com vários itens: os dois transferíveis seguem juntos
  r = await step(sV);
  assert.equal(r.json.code, 'CHECKLIST_CARRY');
  assert.deepEqual(r.json.transferable.map((x) => x.title).sort(), ['Receber arquivo complementar', 'Receber documentação complementar']);
  assert.equal((await step(sV, { confirmCarry: true, carryKeys: r.json.transferable.map((x) => x.key) })).status, 200);

  // Validação: conclui o próprio e transfere de novo (E: mesma instância, histórico acumulado)
  let iV = await open(sV);
  assert.equal(iV.inherited.length, 2);
  assert.equal(iV.pending.filter((x) => x.inherited).length, 2);
  await mark(sV, byTitle(iV, 'Executar conferência'));
  r = await step(sH);
  assert.equal(r.json.code, 'CHECKLIST_CARRY');
  assert.equal((await step(sH, { confirmCarry: true, carryKeys: r.json.transferable.map((x) => x.key) })).status, 200);
  const iH = await open(sH);
  const doc = iH.inherited.find((x) => x.title === 'Receber documentação complementar');
  assert.deepEqual(doc.carryHistory.map((x) => `${x.fromStage}→${x.toStage}`), ['Preparação→Migração', 'Migração→Validação', 'Validação→Homologação T']);
  assert.equal(doc.id, docP.id, 'mesmo id do item original');
  const raw = (await api('GET', '/api/state')).json.projects.find((x) => x.id === p.id);
  assert.equal(raw.pendencies.inherited, 2);
  assert.equal(raw.checklist[sH].inherited.pending, 2);
  assert.equal(raw.checklist[sM].carriedOut, 1, 'Migração mostra que um item seu seguiu adiante');
  // só existe UMA cópia de cada pendência em todo o projeto
  const all = await Promise.all([sP, sM, sV, sH].map(open));
  const titles = all.flatMap((i) => i.items.map((x) => x.title));
  assert.equal(titles.filter((t) => t === 'Receber documentação complementar').length, 1);
  assert.equal(titles.filter((t) => t === 'Receber arquivo complementar').length, 1);

  // F: conclusão (último passo) com pendência transferível → bloqueia e NÃO oferece transferir
  await mark(sH, byTitle(iH, 'Aprovação cliente'));
  r = await step(sZ, { confirmCarry: true, carryKeys: [] });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CHECKLIST_PENDING');
  assert.equal(r.json.final, true);
  assert.deepEqual(r.json.transferable, []);
  assert.match(r.json.error, /concluir este projeto/);
  assert.deepEqual(r.json.blocked.flatMap((b) => b.pending.map((x) => [x.title, x.origin.stageName])).sort(),
    [['Receber arquivo complementar', 'Migração'], ['Receber documentação complementar', 'Preparação']]);
  // D (parte 2): transferido 2 vezes e a evidência continua exigida; resolver na etapa atual (item herdado)
  const arqH = iH.inherited.find((x) => x.title === 'Receber arquivo complementar');
  assert.equal(arqH.status, 'awaiting_evidence');
  assert.equal(arqH.evidence.mode, 'required');
  const up = await upload(`/api/projects/${p.id}/checklists/${arqH.origin.stepId}/items/${arqH.id}/evidence`, 'arquivo.png', PNG);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(byTitle(up.json.instance, 'Receber arquivo complementar').status, 'done');
  r = await step(sZ);
  assert.equal(r.json.code, 'CHECKLIST_PENDING', 'ainda falta a documentação');
  await mark(doc.origin.stepId, doc);
  // G: todos os obrigatórios concluídos → conclusão permitida (o opcional pendente não impede)
  r = await step(sZ);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.pendencies.requiredPending, 0);

  const acts = (await api('GET', '/api/audit')).json;
  assert.equal(acts.filter((a) => a.action === 'checklist-pendencia-transferida').length, 5);
  assert.ok(acts.some((a) => a.action === 'avanco-bloqueado' && /Conclusão do projeto bloqueada/.test(a.detalhe)));

  // Modelo × projeto: marcar como transferível no modelo NÃO muda o projeto em andamento até sincronizar
  const d = conf;
  assert.equal((await api('PUT', `/api/checklist-items/${d.id}`, { ...d, carryForward: true })).status, 200);
  const iV2 = await open(sV);
  assert.equal(byTitle(iV2, 'Executar conferência').carryForward, false);
  const plan = (await api('POST', `/api/projects/${p.id}/checklists/${sV}/sync`, { dryRun: true })).json.plan;
  assert.deepEqual(plan.updated.map((u) => u.changes), [['carryForward']]);
});

test('API: analista do projeto — mesmo cadastro de pessoas; criar, editar, visualizar, remover e apontamentos com fotografia', async () => {
  const maria = (await api('POST', '/api/coordinators', { name: 'Maria Santos', role: 'Analista de migração' })).json;
  const joao = (await api('POST', '/api/coordinators', { name: 'João Silva', role: 'Coordenador' })).json;
  assert.equal((await api('POST', '/api/projects', { name: 'X', analystId: 'nao-existe' })).status, 400);
  const p = (await api('POST', '/api/projects', { name: 'Cliente Analista', coordinatorId: joao.id, analystId: maria.id })).json;
  assert.deepEqual([p.coordinatorId, p.analystId], [joao.id, maria.id]);
  // editar sem mandar o campo (cliente antigo) não apaga; mandar null limpa
  let e = (await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Analista', coordinatorId: joao.id })).json;
  assert.equal(e.analystId, maria.id);
  e = (await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Analista', coordinatorId: joao.id, analystId: null })).json;
  assert.equal(e.analystId, null);
  e = (await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Analista', coordinatorId: joao.id, analystId: maria.id })).json;
  assert.equal((await api('GET', '/api/state')).json.projects.find((x) => x.id === p.id).analystId, maria.id);

  // apontamento guarda a fotografia do analista; trocar o analista depois não altera o histórico
  const d = new Date(); d.setDate(d.getDate() - 1);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const en = await api('POST', '/api/hours/entries', { date, projectId: p.id, activity: 'Carga', start: '09:00', end: '10:00' });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Analista', coordinatorId: joao.id, analystId: joao.id });
  const day = (await api('GET', `/api/hours/day?date=${date}`)).json;
  assert.equal(day.entries.find((x) => x.projectId === p.id).analystName, 'Maria Santos');
  const res = await fetch(`${base}/api/hours/export?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Apontamentos');
  assert.equal(ws.getRow(1).getCell(6).value, 'Analista');
  let row = null; ws.eachRow((r2, n) => { if (n > 1 && r2.getCell(7).value === 'Carga') row = r2; });
  assert.equal(row.getCell(6).value, 'Maria Santos');
  assert.equal(wb.getWorksheet('Resumo por Projeto').getRow(1).getCell(3).value, 'Analista(s)');

  // remover a pessoa do cadastro desvincula dos projetos (coordenador e analista)
  const del = (await api('DELETE', `/api/coordinators/${joao.id}`)).json;
  assert.equal(del.unassigned, 1);
  const after = (await api('GET', '/api/state')).json.projects.find((x) => x.id === p.id);
  assert.deepEqual([after.coordinatorId, after.analystId], [null, null]);
});
