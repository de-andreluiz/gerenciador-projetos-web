// Observação por item, reversão de pendência herdada e dependências entre itens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-extras-'));
const PORT = 4404;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const C = require('../src/checklist');
const { applyDefaults } = require('../src/defaults');
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

// ---------- Regras puras: dependências no modelo ----------
function model() {
  const data = applyDefaults({ scripts: [], projects: [] });
  data.checklists = [{ id: 'ck-h', name: 'Checklist H' }];
  const def = (id, o = {}) => ({ id, checklistId: 'ck-h', title: id.toUpperCase(), description: '', required: true, carryForward: false, dependsOn: [], evidence: { mode: 'none', type: 'any', min: 1, max: 10 }, links: [], scriptIds: [], condition: null, ...o });
  data.checklistItems = ['a', 'b', 'c', 'd'].map((id) => def(id));
  return data;
}

test('dependências (modelo): sem auto-dependência, sem item inexistente, sem ciclos (direto ou indireto); cadeia A→B→C→D funciona', () => {
  const data = model();
  const clean = (id, deps) => C.cleanDefinition({ title: 'x', dependsOn: deps }, data, id);
  assert.deepEqual(clean('a', ['b', 'b', 'c']).dependsOn, ['b', 'c'], 'repetidos saem');
  assert.throws(() => clean('a', ['a']), /depender de si mesmo/);
  assert.throws(() => clean('a', ['nao-existe']), /não existe mais/);
  // A depende de B, B de C, C de D: cadeia válida
  const dep = (id, list) => { data.checklistItems.find((x) => x.id === id).dependsOn = list; };
  dep('a', ['b']); dep('b', ['c']); dep('c', ['d']);
  assert.deepEqual(clean('d', []).dependsOn, []);
  // fechar o círculo
  assert.throws(() => clean('b', ['a']), /dependência circular/);
  assert.throws(() => clean('d', ['a']), /Não é possível criar esta dependência\. Ela geraria uma dependência circular: D → A → B → C → D/);
  assert.equal(C.dependentsOf(data, ['b']).map((x) => x.id).join(), 'a');
  assert.equal(C.dependentsOf(data, ['a', 'b']).map((x) => x.id).join(), '', 'dependente dentro do próprio conjunto não conta');
});

test('dependências (execução): concluído = regra real (marcado + evidência); por id, não por posição; etapa fora do ciclo não trava', () => {
  const data = model();
  data.checklistItems.find((x) => x.id === 'a').evidence = { mode: 'required', type: 'image', min: 1, max: 3 };
  data.checklistItems.find((x) => x.id === 'b').dependsOn = ['a'];
  const p = { id: 'p', name: 'P', stepId: 'cy-1', stageHistory: [], checklists: [], steps: JSON.parse(JSON.stringify(data.cycles[0].steps)) };
  for (const st of p.steps) st.checklistIds = st.stageId === 'st-homologacao' ? ['ck-h'] : [];
  const inst = C.ensureInstance(data, p, 'cy-1');
  const a = inst.items.find((i) => i.title === 'A');
  const b = inst.items.find((i) => i.title === 'B');
  const state = () => C.dependenciesOf(C.buildDepIndex(data, p), b)[0].status;
  assert.equal(state(), 'pending');
  C.setDone(a, true, 'e', 't');
  assert.equal(state(), 'pending', 'marcado mas sem a evidência exigida ainda é pendente');
  a.evidences.push({ id: 'e1', name: 'x.png', file: 'x', size: 1 });
  C.refreshCompletion(a, 'e', 't2');
  assert.equal(state(), 'done');
  inst.items.reverse(); // a ordem não importa: a dependência aponta para o id do item
  assert.equal(state(), 'done');
  data.checklists.push({ id: 'ck-x', name: 'Checklist de outro ciclo' });
  data.checklistItems.push({ ...data.checklistItems[0], id: 'z', checklistId: 'ck-x', dependsOn: [] });
  assert.equal(C.dependencyState(C.buildDepIndex(data, p), 'z').status, 'na', 'checklist que nenhuma etapa do ciclo do projeto usa não bloqueia para sempre');
  p.steps.find((x) => x.id === 'cy-4').checklistIds = ['ck-x']; // se o ciclo do projeto passa a usar o checklist, a dependência vale (ainda não aberto = pendente)
  assert.equal(C.dependencyState(C.buildDepIndex(data, p), 'z').status, 'pending');
  p.steps.find((x) => x.id === 'cy-4').checklistIds = [];
  // o item concluído não é "reaberto" por a dependência voltar a ficar pendente
  C.setDone(b, true, 'e', 't3');
  C.setDone(a, false, 'e', 't4');
  assert.equal(C.itemStatus(b), 'done');
  assert.deepEqual(C.blockedBy(C.buildDepIndex(data, p), b), []);
});

// ---------- API ----------
let seq = 0;
// Ciclo de 4 etapas (todas novas) e um projeto nele. items = { P: [...], M: [...], V: [...], Z: [...] } (definições do modelo).
async function scenario(items, { analyst = false } = {}) {
  seq++;
  const mk = async (name, color) => (await api('POST', '/api/stages', { name: `${name} ${seq}`, color })).json;
  const st = { P: await mk('Prep', '#00DBFF'), M: await mk('Migr', '#A44DFF'), V: await mk('Valid', '#FF8900'), Z: await mk('Fim', '#D9FF65') };
  const cyc = (await api('POST', '/api/cycles', { name: `Ciclo extras ${seq}`, steps: ['P', 'M', 'V', 'Z'].map((k) => ({ stageId: st[k].id })) })).json;
  const steps = { P: cyc.steps[0].id, M: cyc.steps[1].id, V: cyc.steps[2].id, Z: cyc.steps[3].id };
  const defs = {};
  const cks = {}; // um checklist por estágio, associado ao passo desse estágio NESTE ciclo (antes de criar o projeto, que copia os passos)
  for (const k of ['P', 'M', 'V', 'Z']) for (const d of items[k] || []) {
    if (!cks[k]) {
      cks[k] = (await api('POST', '/api/checklists', { name: `Checklist ${k} ${seq}` })).json;
      assert.equal((await api('PUT', `/api/cycles/${cyc.id}/steps/${steps[k]}/checklists`, { checklistIds: [cks[k].id] })).status, 200);
    }
    const body = { required: true, ...d, dependsOn: (d.dependsOn || []).map((key) => defs[key].id) };
    const r = await api('POST', `/api/checklists/${cks[k].id}/items`, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    defs[d.key || d.title] = r.json;
  }
  const p = (await api('POST', '/api/projects', { name: `Cliente ${seq}`, cycleId: cyc.id })).json;
  const step = (k, extra = {}) => api('PUT', `/api/projects/${p.id}/step`, { stepId: steps[k], ...extra });
  const open = async (k) => (await api('POST', `/api/projects/${p.id}/checklists/${steps[k]}/open`, {})).json.instance;
  const itemUrl = (k, it) => `/api/projects/${p.id}/checklists/${steps[k]}/items/${it.id}`;
  const carry = async (k) => { // avança aceitando a transferência
    const q = await step(k);
    assert.equal(q.json.code, 'CHECKLIST_CARRY', JSON.stringify(q.json));
    const r = await step(k, { confirmCarry: true, carryKeys: q.json.transferable.map((x) => x.key) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const by = (inst, t) => inst.items.find((i) => i.title === t) || inst.inherited.find((i) => i.title === t);
  return { st, cyc, steps, defs, p, step, open, itemUrl, carry, by, mark: (k, it, done = true) => api('PUT', itemUrl(k, it), { done }) };
}

test('API: observação por item — criar, editar, limpar; fica no mesmo item ao transferir e restaurar; não se mistura com a descrição', async () => {
  const s = await scenario({ P: [{ title: 'Receber documentação', description: 'Solicitar o arquivo atualizado.', carryForward: true }], M: [{ title: 'Carga M' }], V: [{ title: 'Conferência V' }] });
  await s.step('P');
  const iP = await s.open('P');
  const item = by0(iP, 'Receber documentação');
  function by0(i, t) { return i.items.find((x) => x.title === t); }
  const url = `${s.itemUrl('P', item)}/note`;
  assert.equal(item.note, null);
  let r = await api('PUT', url, { text: '  Cliente enviará o arquivo amanhã.  ' });
  assert.equal(r.status, 200);
  let n = by0(r.json.instance, 'Receber documentação');
  assert.equal(n.note.text, 'Cliente enviará o arquivo amanhã.');
  assert.ok(n.note.updatedAt);
  assert.ok('updatedBy' in n.note);
  assert.equal(n.description, 'Solicitar o arquivo atualizado.', 'descrição (modelo) e observação (execução) não se misturam');
  r = await api('PUT', url, { text: 'Arquivo atrasado: o cliente está ajustando.' });
  assert.equal(by0(r.json.instance, 'Receber documentação').note.text, 'Arquivo atrasado: o cliente está ajustando.');
  assert.equal((await api('PUT', url, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await api('PUT', url, { text: '   ' })).status, 200, 'texto vazio limpa');
  assert.equal(by0(await s.open('P'), 'Receber documentação').note, null);
  await api('PUT', url, { text: 'Cliente ainda não disponibilizou o arquivo.' });

  // transferir P→M→V: a observação continua no mesmo item
  await s.carry('M');
  await s.mark('M', by0(await s.open('M'), 'Carga M'));
  await s.carry('V');
  const iV = await s.open('V');
  assert.equal(iV.inherited[0].note.text, 'Cliente ainda não disponibilizou o arquivo.');
  assert.equal(iV.inherited[0].id, item.id);
  // dá para editar a observação estando o item herdado (a rota usa o passo de origem)
  r = await api('PUT', url, { text: 'Ainda pendente em Validação.' });
  assert.equal((await s.open('V')).inherited[0].note.text, 'Ainda pendente em Validação.');

  // restaurar: a observação permanece
  const rest = `${s.itemUrl('P', item)}/restore`;
  assert.equal((await api('POST', rest, { confirm: true })).status, 200);
  assert.equal(by0(await s.open('P'), 'Receber documentação').note.text, 'Ainda pendente em Validação.');
  const acts = (await api('GET', '/api/audit')).json.map((x) => x.action);
  for (const a of ['checklist-observacao', 'checklist-pendencia-restaurada']) assert.ok(acts.includes(a), a);
});

test('API: observação com {{greeting}} — é resolvida ao salvar (Bom dia/Boa tarde/Boa noite) e fica gravada já resolvida', async () => {
  const s = await scenario({ P: [{ title: 'Receber documentação' }], M: [{ title: 'Carga M' }], V: [{ title: 'Conferência V' }] });
  await s.step('P');
  const item = (await s.open('P')).items.find((x) => x.title === 'Receber documentação');
  const r = await api('PUT', `${s.itemUrl('P', item)}/note`, { text: '{{greeting}}, cliente avisou que envia amanhã. {{ Greeting }}!' });
  assert.equal(r.status, 200);
  const saved = r.json.instance.items.find((x) => x.title === 'Receber documentação').note.text;
  assert.match(saved, /^(Bom dia|Boa tarde|Boa noite), cliente avisou que envia amanhã\. (Bom dia|Boa tarde|Boa noite)!$/); // saudação do horário atual
  assert.doesNotMatch(saved, /\{\{/);
  const again = (await s.open('P')).items.find((x) => x.title === 'Receber documentação').note.text;
  assert.equal(again, saved); // o que a tela reabre é o texto resolvido
});

test('API: {{greeting}} na descrição do item — o projeto mostra a saudação do momento; o modelo continua guardando a variável', async () => {
  const desc = '{{greeting}} prezados,\nCom o DE-PARA analisado, estarei dando seguimento. {{ Greeting }}!';
  const s = await scenario({ P: [{ title: 'Enviar mensagem no Grupo', description: desc }], M: [{ title: 'Carga M' }], V: [{ title: 'Conferência V' }] });
  await s.step('P');
  const shown = (await s.open('P')).items.find((x) => x.title === 'Enviar mensagem no Grupo').description;
  assert.match(shown, /^(Bom dia|Boa tarde|Boa noite) prezados,\nCom o DE-PARA analisado, estarei dando seguimento\. (Bom dia|Boa tarde|Boa noite)!$/);
  assert.doesNotMatch(shown, /\{\{/);
  assert.equal(s.defs['Enviar mensagem no Grupo'].description, desc); // o modelo (Configurações) guarda e devolve a variável intacta
  const model = (await api('GET', '/api/state')).json.checklistItems.find((x) => x.title === 'Enviar mensagem no Grupo' && x.checklistId === s.defs['Enviar mensagem no Grupo'].checklistId);
  assert.equal(model.description, desc);
  const stored = JSON.parse(require('fs').readFileSync(require('path').join(process.env.GP_DATA_DIR, 'projects.json'), 'utf8'));
  assert.ok(stored.checklistItems.some((x) => x.description === desc)); // e no arquivo de dados também (nada de "Bom dia" gravado)
});

test('API: reverter transferência — mesmo item volta à origem, pendente, sem perder evidência, observação, scripts, links nem histórico', async () => {
  const scr = (await api('POST', '/api/scripts', { name: 'PFUNC_REVERTER', content: 'SELECT 1;' })).json;
  const s = await scenario({
    P: [{ title: 'Validar carga PFUNC', carryForward: true, scriptIds: [scr.id], links: [{ title: 'Wiki', url: 'https://wiki.local/x' }], evidence: { mode: 'required', type: 'image', min: 1, max: 3 } }],
    M: [{ title: 'Carga M' }], V: [{ title: 'Conferência V' }],
  });
  await s.step('P');
  const item = (await s.open('P')).items[0];
  await api('PUT', `${s.itemUrl('P', item)}/note`, { text: 'Aguardando o print do cliente.' });
  assert.equal((await upload(`${s.itemUrl('P', item)}/evidence`, 'print.png', PNG)).status, 200);
  await s.mark('P', item, false); // evidência anexada, item segue pendente

  // sem transferência, não há o que restaurar
  assert.equal((await api('POST', `${s.itemUrl('P', item)}/restore`, { confirm: true })).status, 400);

  await s.carry('M');
  await s.mark('M', (await s.open('M')).items[0]);
  await s.carry('V');
  assert.deepEqual((await s.open('V')).inherited.map((x) => x.carryHistory.length), [2]);

  // sempre pede confirmação e avisa que a etapa de origem já ficou para trás
  const rest = `${s.itemUrl('P', item)}/restore`;
  let r = await api('POST', rest, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'RESTORE_CONFIRM');
  assert.equal(r.json.target.stageName, `Prep ${seq}`);
  assert.equal(r.json.from.stageName, `Valid ${seq}`);
  assert.match(r.json.warnings[0], /já foi deixada para trás/);
  assert.equal((await s.open('V')).inherited.length, 1, 'sem confirmar, nada mudou');

  r = await api('POST', rest, { confirm: true });
  assert.equal(r.status, 200);
  const back = r.json.instance.items.find((i) => i.id === item.id);
  assert.equal(back.id, item.id, 'é o MESMO item (não há cópia)');
  assert.equal(back.carriedTo, null);
  assert.ok(['pending', 'awaiting_evidence'].includes(back.status) && back.status !== 'done', 'continua pendente');
  assert.equal(back.done, false);
  assert.equal(back.evidences.length, 1, 'evidência preservada');
  assert.equal(back.note.text, 'Aguardando o print do cliente.');
  assert.equal(back.scripts.length, 1);
  assert.equal(back.links.length, 1);
  assert.deepEqual(back.carryHistory.map((x) => (x.restored ? `restaurado para ${x.toStage}` : `${x.fromStage} → ${x.toStage}`)),
    [`Prep ${seq} → Migr ${seq}`, `Migr ${seq} → Valid ${seq}`, `restaurado para Prep ${seq}`]);
  assert.equal((await s.open('V')).inherited.length, 0, 'deixou de ser pendência herdada de Validação');
  const total = r.json.project.checklist;
  assert.equal(total[s.steps.V].inherited.pending, 0);
  assert.equal(r.json.project.pendencies.requiredPending, 2, 'continua contando no projeto (o item + a conferência de Validação)');
  assert.equal((await api('POST', rest, { confirm: true })).status, 400, 'já está na origem');
  // nada foi duplicado: um só item com esse defId em todo o projeto
  const all = await Promise.all(['P', 'M', 'V'].map((k) => s.open(k)));
  assert.equal(all.flatMap((i) => i.items).filter((i) => i.title === 'Validar carga PFUNC').length, 1);
  // a evidência continua exigida: só conclui marcando + evidência (já existe)
  assert.equal((await s.mark('P', item)).json.instance.items.find((i) => i.id === item.id).status, 'done');
});

test('API: reverter — etapa original removida ou trocada no ciclo: mensagem clara e nada é movido', async () => {
  for (const mode of ['removida', 'trocada']) {
    const s = await scenario({ P: [{ title: `Item ${mode}`, carryForward: true }], M: [{ title: 'Carga M' }] });
    await s.step('P');
    const item = (await s.open('P')).items[0];
    await s.carry('M');
    const steps = s.cyc.steps.map((x) => ({ id: x.id, stageId: x.stageId }));
    const next = mode === 'removida' ? steps.filter((x) => x.id !== s.steps.P) : steps.map((x) => (x.id === s.steps.P ? { ...x, stageId: s.st.Z.id } : x));
    assert.equal((await api('PUT', `/api/cycles/${s.cyc.id}`, { steps: next })).status, 200);
    assert.equal((await api('POST', `/api/projects/${s.p.id}/cycle/apply`, {})).status, 200);
    const r = await api('POST', `${s.itemUrl('P', item)}/restore`, { confirm: true });
    assert.equal(r.status, 409, mode);
    assert.equal(r.json.code, 'RESTORE_IMPOSSIBLE');
    assert.match(r.json.error, mode === 'removida' ? /não existe mais no ciclo/ : /agora é/);
    const still = (await s.open('M')).inherited;
    assert.equal(still.length, 1, 'o item não foi movido');
  }
});

test('API: dependências — bloqueia concluir, evidência conta, entre etapas, herdada, restaurar, opcional, modelo × projeto, remoção e ciclos', async () => {
  const s = await scenario({
    P: [{ key: 'A', title: 'Cadastrar pasta raiz', carryForward: true, evidence: { mode: 'required', type: 'image', min: 1, max: 3 } }],
    M: [{ key: 'B', title: 'Copiar arquivos para pasta raiz', carryForward: true, dependsOn: ['A'] }],
    V: [{ key: 'C', title: 'Opcional C', required: false }, { key: 'D', title: 'Validar cópia', dependsOn: ['C'] }, { key: 'F', title: 'Filler V' }],
  });
  const A = s.defs.A; const B = s.defs.B;
  assert.deepEqual(B.dependsOn, [A.id]);

  // configuração: auto-dependência, circular e item inexistente
  assert.equal((await api('PUT', `/api/checklist-items/${A.id}`, { ...A, dependsOn: [A.id] })).status, 400);
  let r = await api('PUT', `/api/checklist-items/${A.id}`, { ...A, dependsOn: [B.id] });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'DEPENDENCY_CIRCULAR');
  assert.match(r.json.error, /Não é possível criar esta dependência/);
  assert.equal((await api('PUT', `/api/checklist-items/${A.id}`, { ...A, dependsOn: ['nao-existe'] })).status, 400);

  // remover do modelo algo usado como dependência: não apaga em silêncio
  r = await api('DELETE', `/api/checklist-items/${A.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'ITEM_IS_DEPENDENCY');
  assert.match(r.json.error, /Copiar arquivos para pasta raiz/);
  assert.equal((await api('DELETE', `/api/stages/${s.st.P.id}`)).status, 409);
  const inUse = await api('DELETE', `/api/checklists/${A.checklistId}`);
  assert.equal(inUse.status, 409);
  assert.equal(inUse.json.code, 'CHECKLIST_IN_USE', 'associado ao ciclo: bloqueia antes mesmo de olhar as dependências');

  await s.step('P');
  const iP = await s.open('P');
  const a = s.by(iP, 'Cadastrar pasta raiz');
  await s.carry('M'); // A segue para Migração como pendência herdada
  let iM = await s.open('M');
  let b = s.by(iM, 'Copiar arquivos para pasta raiz');
  assert.deepEqual(b.dependencies.map((d) => [d.title, d.status, d.stageName]), [['Cadastrar pasta raiz', 'pending', `Prep ${seq}`]]);
  assert.equal(b.blocked, true);
  assert.equal(b.dependencies[0].itemId, a.id, 'aponta para o item (id), onde quer que ele esteja');
  assert.equal(b.dependencies[0].viewStepId, s.steps.M, 'A está herdado em Migração');

  // concluir B bloqueado (A pendente, herdado)
  r = await s.mark('M', b);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'DEPENDENCY_PENDING');
  assert.match(r.json.error, /Não é possível concluir este item\. Dependência pendente: Cadastrar pasta raiz/);
  assert.deepEqual(r.json.blocked.map((x) => x.title), ['Cadastrar pasta raiz']);
  assert.equal(s.by(await s.open('M'), 'Copiar arquivos para pasta raiz').done, false);
  // A marcado mas sem a evidência exigida continua pendente: B segue bloqueado
  assert.equal((await s.mark('P', a)).json.instance.items.find((i) => i.id === a.id).status, 'awaiting_evidence');
  assert.equal((await s.mark('M', b)).status, 409);

  // A e B podem ser transferidos juntos (transferir ≠ concluir); B continua bloqueado
  await s.carry('V');
  let iV = await s.open('V');
  b = s.by(iV, 'Copiar arquivos para pasta raiz');
  assert.equal(b.blocked, true);
  assert.equal(b.dependencies[0].viewStepId, s.steps.V);
  assert.equal((await s.mark('M', b)).status, 409);

  // restaurar A para a origem: a dependência de B continua apontando para o mesmo A
  r = await api('POST', `${s.itemUrl('P', a)}/restore`, { confirm: true });
  assert.equal(r.status, 200);
  iV = await s.open('V');
  b = s.by(iV, 'Copiar arquivos para pasta raiz');
  assert.equal(b.dependencies[0].itemId, a.id);
  assert.equal(b.dependencies[0].stepId, s.steps.P);
  assert.equal(b.dependencies[0].viewStepId, s.steps.P);
  assert.equal(b.blocked, true);

  // evidência → A concluído → B pode ser concluído (não tem evidência própria)
  assert.equal((await upload(`${s.itemUrl('P', a)}/evidence`, 'pasta.png', PNG)).status, 200);
  iV = await s.open('V');
  assert.equal(s.by(iV, 'Copiar arquivos para pasta raiz').blocked, false);
  assert.equal(s.by(iV, 'Copiar arquivos para pasta raiz').dependencies[0].status, 'done');
  r = await s.mark('M', s.by(iV, 'Copiar arquivos para pasta raiz'));
  assert.equal(r.status, 200);
  assert.equal(s.by(r.json.instance, 'Copiar arquivos para pasta raiz').status, 'done');
  // desmarcar A depois não reabre B sozinho (nada silencioso)
  await s.mark('P', a, false);
  assert.equal(s.by(await s.open('V'), 'Copiar arquivos para pasta raiz').status, 'done');

  // item opcional como dependência bloqueia só o dependente
  const d = s.by(iV, 'Validar cópia'); const c = s.by(iV, 'Opcional C');
  assert.equal(d.blocked, true);
  assert.equal((await s.mark('V', d)).status, 409);
  assert.equal((await s.mark('V', c)).status, 200);
  assert.equal((await s.mark('V', d)).status, 200);

  // modelo × projeto: dependência nova no modelo só chega ao projeto ao sincronizar
  const F = s.defs.F;
  assert.equal((await api('PUT', `/api/checklist-items/${F.id}`, { ...F, dependsOn: [A.id] })).status, 200);
  const f0 = s.by(await s.open('V'), 'Filler V');
  assert.deepEqual(f0.dependencies, [], 'projeto em andamento não muda sozinho');
  const plan = (await api('POST', `/api/projects/${s.p.id}/checklists/${s.steps.V}/sync`, { dryRun: true })).json.plan;
  assert.deepEqual(plan.updated.map((u) => u.changes), [['dependsOn']]);
  const synced = (await api('POST', `/api/projects/${s.p.id}/checklists/${s.steps.V}/sync`, {})).json.instance;
  assert.deepEqual(s.by(synced, 'Filler V').dependencies.map((x) => x.title), ['Cadastrar pasta raiz']);

  // ao tirar as dependências, o item pode sair do modelo
  assert.equal((await api('PUT', `/api/checklist-items/${F.id}`, { ...F, dependsOn: [] })).status, 200);
  assert.equal((await api('PUT', `/api/checklist-items/${B.id}`, { ...B, dependsOn: [] })).status, 200);
  assert.equal((await api('DELETE', `/api/checklist-items/${A.id}`)).status, 200);
});
