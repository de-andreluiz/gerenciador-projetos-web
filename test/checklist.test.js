const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-chk-'));
const PORT = 4399;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { app } = require('../server');
const C = require('../src/checklist');
const E = require('../src/evidence');
const { applyDefaults } = require('../src/defaults');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 2)]);
const cfg = E.getConfig({});

// ---------- Regras puras ----------
test('cleanDefinition: valida título, links, scripts e evidência', () => {
  const data = applyDefaults({ scripts: [{ id: 's1', name: 'X' }], projects: [] });
  const ok = C.cleanDefinition({ title: ' Validar ', required: true, evidence: { mode: 'required', type: 'image', min: 1, max: 3 },
    links: [{ title: 'Wiki', url: 'https://wiki.local/x' }], scriptIds: ['s1', 's1'] }, data);
  assert.equal(ok.title, 'Validar');
  assert.deepEqual(ok.scriptIds, ['s1']);
  assert.equal(ok.evidence.min, 1);
  assert.throws(() => C.cleanDefinition({ title: '' }, data), /título/);
  assert.throws(() => C.cleanDefinition({ title: 'a', links: [{ url: 'javascript:alert(1)' }] }, data), /http/);
  assert.throws(() => C.cleanDefinition({ title: 'a', scriptIds: ['nao-existe'] }, data), /script/i);
  assert.throws(() => C.cleanDefinition({ title: 'a', evidence: { mode: 'required', type: 'x' } }, data), /tipo de evidência/i);
  assert.throws(() => C.cleanDefinition({ title: 'a', evidence: { mode: 'required', type: 'image', min: 5, max: 2 } }, data), /mínima/);
  assert.equal(C.cleanDefinition({ title: 'a' }, data).evidence.mode, 'none');
});

function fixture() {
  const data = applyDefaults({ scripts: [], projects: [] });
  data.checklists = [{ id: 'ck-h', name: 'Checklist H' }, { id: 'ck-d', name: 'Checklist D' }];
  const def = (o) => ({ id: o.id, checklistId: 'ck-h', title: o.id, description: '', required: !!o.required, evidence: o.evidence || { mode: 'none', type: 'any', min: 1, max: 10 }, links: [], scriptIds: [], condition: null });
  data.checklistItems = [def({ id: 'a', required: true }), def({ id: 'b', required: false }), def({ id: 'c', required: true, evidence: { mode: 'required', type: 'image', min: 1, max: 5 } })];
  const p = { id: 'p1', name: 'P', stepId: 'cy-1', stageHistory: [], checklists: [], steps: JSON.parse(JSON.stringify(data.cycles[0].steps)) };
  const byStage = { 'st-homologacao': ['ck-h'], 'st-documentacao': ['ck-d'] }; // checklists de cada passo NESTE ciclo
  for (const st of p.steps) st.checklistIds = byStage[st.stageId] || [];
  return { data, p };
}

test('avançar: só obrigatórios bloqueiam; evidência exigida sem arquivo continua pendente', () => {
  const { data, p } = fixture();
  const inst = C.ensureInstance(data, p, 'cy-1');
  assert.equal(inst.items.length, 3);
  let gate = C.checkAdvance(data, p, 'cy-2');
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.blocked[0].pending.map((i) => i.title), ['a', 'c']);

  const [a, b, c] = inst.items;
  C.setDone(a, true, 'elton', 't1');
  C.setDone(c, true, 'elton', 't1'); // marcado, mas exige imagem
  assert.equal(C.itemStatus(c), 'awaiting_evidence');
  gate = C.checkAdvance(data, p, 'cy-2');
  assert.deepEqual(gate.blocked[0].pending.map((i) => [i.title, i.status, i.missingEvidence]), [['c', 'awaiting_evidence', 1]]);

  c.evidences.push({ id: 'e1', name: 'x.png', file: 'x', size: 1 });
  C.refreshCompletion(c, 'elton', 't2');
  assert.equal(C.itemStatus(c), 'done');
  assert.equal(c.completedAt, 't2');
  assert.equal(C.checkAdvance(data, p, 'cy-2').ok, true, 'o opcional (b) pendente não bloqueia');
  assert.equal(C.progressOf(C.live(inst)).requiredDone, 2);
  assert.equal(C.progressOf(C.live(inst)).optionalDone, 0);

  // desmarcar mantém a evidência
  C.setDone(c, false, 'elton', 't3');
  assert.equal(c.evidences.length, 1);
  assert.equal(c.completedAt, null);
});

test('avançar: voltar nunca bloqueia; pular etapa com obrigatório pendente bloqueia', () => {
  const { data, p } = fixture();
  data.checklistItems.push({ id: 'd', checklistId: 'ck-d', title: 'd', description: '', required: true, evidence: { mode: 'none', type: 'any', min: 1, max: 10 }, links: [], scriptIds: [], condition: null });
  const inst = C.ensureInstance(data, p, 'cy-1');
  for (const it of inst.items.filter((i) => i.required)) C.setDone(it, true, 'e', 't');
  C.ensureInstance(data, p, 'cy-1').items.find((i) => i.id).evidences.push();
  const c = inst.items.find((i) => i.defId === 'c'); c.evidences.push({ id: 'e', name: 'x.png', file: 'x', size: 1 });
  // cy-1 completo; cy-2 (Documentação) tem o obrigatório "d" pendente → ir direto para cy-3 é bloqueado por causa do cy-2
  const gate = C.checkAdvance(data, p, 'cy-3');
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked.length, 1);
  assert.equal(gate.blocked[0].stageName, 'Documentação');
  p.stepId = 'cy-3';
  assert.equal(C.checkAdvance(data, p, 'cy-1').ok, true, 'voltar é livre');
  assert.equal(C.checkAdvance(data, p, null).ok, true);
  p.stepId = null;
  assert.equal(C.checkAdvance(data, p, 'cy-4').ok, true, 'sem etapa atual: nada a conferir');
});

test('sincronizar: adiciona novos, atualiza critérios, arquiva removidos e nunca perde marcações', () => {
  const { data, p } = fixture();
  const inst = C.ensureInstance(data, p, 'cy-1');
  C.setDone(inst.items[0], true, 'e', 't');
  assert.equal(C.syncPlan(data, p, inst).changed, false);

  data.checklistItems.push({ id: 'n', checklistId: 'ck-h', title: 'novo', description: '', required: true, evidence: { mode: 'none', type: 'any', min: 1, max: 10 }, links: [], scriptIds: [], condition: null });
  data.checklistItems.find((d) => d.id === 'b').title = 'b renomeado';
  data.checklistItems = data.checklistItems.filter((d) => d.id !== 'c');
  const before = JSON.stringify(inst);
  const plan = C.syncPlan(data, p, inst);
  assert.equal(JSON.stringify(inst), before, 'a pré-visualização não altera nada');
  assert.deepEqual([plan.added.length, plan.updated.length, plan.archived.length], [1, 1, 1]);

  C.applySync(data, p, inst);
  assert.equal(inst.items.find((i) => i.defId === 'a').done, true);
  assert.equal(inst.items.find((i) => i.defId === 'c').archived, true, 'removido do modelo = arquivado, não apagado');
  assert.equal(C.live(inst).length, 3);
  assert.equal(C.live(inst).find((i) => i.defId === 'b').title, 'b renomeado');
  assert.ok(!C.pendingRequired(C.live(inst)).some((i) => i.title === 'c'));
  assert.equal(C.syncPlan(data, p, inst).changed, false);
});

// ---------- Anexos ----------
test('anexos: extensão, assinatura, tamanho, executáveis e nomes perigosos', () => {
  const ok = E.checkUpload({ name: 'print.PNG', buffer: PNG, type: 'image', cfg });
  assert.equal(ok.ext, '.png'); assert.equal(ok.kind, 'image');
  assert.equal(E.checkUpload({ name: 'laudo.pdf', buffer: PDF, type: 'imageOrDocument', cfg }).kind, 'pdf');
  assert.throws(() => E.checkUpload({ name: 'laudo.pdf', buffer: PDF, type: 'image', cfg }), /aceita imagem/i);
  assert.throws(() => E.checkUpload({ name: 'a.png', buffer: PDF, type: 'image', cfg }), /assinatura/);
  assert.throws(() => E.checkUpload({ name: 'a.exe', buffer: Buffer.from('MZ....'), type: 'any', cfg }), /não são aceitos/);
  assert.throws(() => E.checkUpload({ name: 'a.txt', buffer: Buffer.from('MZ\x90\x00'), type: 'document', cfg }), /executável/);
  assert.throws(() => E.checkUpload({ name: 'a.txt', buffer: Buffer.from([65, 0, 66, 0, 67]), type: 'document', cfg }), /binários/);
  assert.throws(() => E.checkUpload({ name: 'a.png.exe', buffer: PNG, type: 'any', cfg }), /não são aceitos/);
  assert.throws(() => E.checkUpload({ name: 'a.svg', buffer: Buffer.from('<svg/>'), type: 'any', cfg }), /não são aceitos/);
  assert.throws(() => E.checkUpload({ name: 'semextensao', buffer: PNG, type: 'any', cfg }), /extensão/);
  assert.throws(() => E.checkUpload({ name: 'a.png', buffer: Buffer.alloc(0), type: 'image', cfg }), /vazio/);
  assert.throws(() => E.checkUpload({ name: 'a.png', buffer: PNG, type: 'image', cfg, declaredMime: 'text/html' }), /MIME/);
  assert.throws(() => E.checkUpload({ name: 'a.png', buffer: PNG, type: 'image', cfg, declaredMime: 'image/jpeg' }), /não confere/);
  const big = E.getConfig({ evidence: { maxMB: 1 } });
  assert.throws(() => E.checkUpload({ name: 'a.png', buffer: Buffer.concat([PNG, Buffer.alloc(1048576)]), type: 'image', cfg: big }), (e) => e.status === 413);
  // o nome vindo da tela nunca vira caminho
  assert.equal(E.checkUpload({ name: '..\\..\\Windows\\sys.png', buffer: PNG, type: 'image', cfg }).name, 'sys.png');
  assert.equal(E.checkUpload({ name: 'C:/x/../y.png', buffer: PNG, type: 'image', cfg }).name, 'y.png');
});

test('configuração: extensões perigosas nunca entram e o tamanho tem limites', () => {
  assert.throws(() => E.cleanConfig({ maxMB: 10, image: ['.png'], document: ['.pdf', '.exe'], extra: [] }), /não pode ser usada/);
  assert.throws(() => E.cleanConfig({ maxMB: 0, image: ['.png'], document: ['.pdf'], extra: [] }), /tamanho/);
  assert.throws(() => E.cleanConfig({ maxMB: 101, image: ['.png'], document: ['.pdf'], extra: [] }), /tamanho/);
  const c = E.getConfig({ evidence: E.cleanConfig({ maxMB: 5, image: 'png, .bmp', document: ['.pdf'], extra: ['.zip'] }) });
  assert.deepEqual(c.types.image.extensions, ['.png', '.bmp']);
  assert.ok(c.types.any.extensions.includes('.zip') && c.types.imageOrDocument.extensions.includes('.pdf'));
  // valor manipulado no arquivo de dados também não libera executáveis
  assert.ok(!E.getConfig({ evidence: { document: ['.pdf', '.exe', '.bat'] } }).types.document.extensions.includes('.exe'));
});

test('armazenamento: nunca sai da pasta de evidências e não sobrescreve', () => {
  const files = new E.EvidenceFiles(path.join(tmp, 'store'));
  assert.throws(() => files.resolve('../x.png'), /inválido/);
  assert.throws(() => files.resolve('a/../../x.png'), /inválido/);
  assert.throws(() => files.resolve('C:/Windows/x.png'), /inválido/);
  assert.throws(() => files.resolve('.removidas/x.png'), /inválido/);
  const rel1 = files.save('proj-1/01-etapa', 'id1', 'print.png', PNG);
  const rel2 = files.save('proj-1/01-etapa', 'id2', 'print.png', PNG);
  assert.notEqual(rel1, rel2);
  assert.throws(() => files.save('proj-1/01-etapa', 'id1', 'print.png', PNG), /EEXIST/);
  const moved = files.trash(rel1);
  assert.ok(moved.includes('.removidas') && fs.existsSync(moved));
  assert.equal(files.stat(rel1), null);
});

// ---------- API ----------
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const upload = async (url, name, buf, { type = 'application/octet-stream', fileType = '' } = {}) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': type, Origin: base, 'X-File-Name': encodeURIComponent(name), 'X-File-Type': fileType, 'X-Description': encodeURIComponent('teste ç') }, body: buf });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

test('API: modelo → projeto → bloqueio de avanço → evidência → avanço → sincronização', async () => {
  const server = app.listen(PORT, '127.0.0.1');
  try {
    const dataDir = process.env.GP_DATA_DIR;
    const scr = (await api('POST', '/api/scripts', { name: 'PFUNC_VALIDACAO', content: 'SELECT 1;' })).json;
    // modelo: checklist reutilizável, associado ao estágio Homologação NO ciclo padrão (o projeto recebe a cópia dos passos ao ser criado)
    const ck = (await api('POST', '/api/checklists', { name: 'Checklist Homologação A' })).json;
    assert.equal((await api('PUT', '/api/cycles/cyc-padrao/steps/cy-1/checklists', { checklistIds: [ck.id] })).status, 200);
    const p = (await api('POST', '/api/projects', { name: 'Cliente A' })).json;
    assert.deepEqual(p.steps.find((s) => s.id === 'cy-1').checklistIds, [ck.id]);
    const mk = async (o) => (await api('POST', `/api/checklists/${ck.id}/items`, o));
    const a = await mk({ title: 'Receber documentação', required: true, description: 'Pedir ao cliente' });
    const b = await mk({ title: 'Registrar observação', required: false });
    const c = await mk({ title: 'Validar PFUNC', required: true, scriptIds: [scr.id], links: [{ title: 'Wiki', url: 'https://wiki.local/pfunc', description: 'guia' }], evidence: { mode: 'required', type: 'image', min: 1, max: 3 } });
    assert.equal(a.status, 200);
    assert.equal((await mk({ title: 'x', links: [{ url: 'file:///c:/a' }] })).status, 400);
    assert.equal((await mk({ title: 'x', scriptIds: ['nada'] })).status, 400);
    assert.equal((await api('POST', '/api/checklists/nao-existe/items', { title: 'x' })).status, 404);
    const stateA = (await api('GET', '/api/state')).json;
    assert.equal(stateA.checklistItems.length, 3);
    assert.equal(stateA.evidence.maxMB, 10);

    // reordenar
    const ids = [c.json.id, a.json.id, b.json.id];
    assert.equal((await api('PUT', `/api/checklists/${ck.id}/order`, { ids })).status, 200);
    assert.equal((await api('PUT', `/api/checklists/${ck.id}/order`, { ids: ids.slice(1) })).status, 400);
    assert.deepEqual((await api('GET', '/api/state')).json.checklistItems.map((i) => i.title), ['Validar PFUNC', 'Receber documentação', 'Registrar observação']);

    // entrar na etapa cria a cópia; o projeto público não vaza a estrutura interna
    const inStep = await api('PUT', `/api/projects/${p.id}/step`, { stepId: 'cy-1' });
    assert.equal(inStep.status, 200);
    assert.equal(inStep.json.checklists, undefined);
    assert.equal(inStep.json.checklist['cy-1'].total, 3);
    assert.equal(inStep.json.checklist['cy-1'].requiredTotal, 2);
    const open = await api('POST', `/api/projects/${p.id}/checklists/cy-1/open`, {});
    const inst = open.json.instance;
    assert.deepEqual(inst.items.map((i) => i.title), ['Validar PFUNC', 'Receber documentação', 'Registrar observação']);
    assert.equal(inst.items[0].scripts[0].name, 'PFUNC_VALIDACAO');
    assert.equal(inst.items[0].links[0].title, 'Wiki');
    assert.ok(!JSON.stringify(open.json).includes('evidencias/'), 'nenhum caminho de disco vai para a tela');
    const [itC, itA, itB] = inst.items;
    const itemUrl = (i) => `/api/projects/${p.id}/checklists/cy-1/items/${i.id}`;

    // bloqueio explicado
    const blocked = await api('PUT', `/api/projects/${p.id}/step`, { stepId: 'cy-2' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'CHECKLIST_PENDING');
    assert.deepEqual(blocked.json.blocked[0].pending.map((i) => i.title), ['Validar PFUNC', 'Receber documentação']);
    assert.match(blocked.json.error, /2 itens obrigatórios/);
    assert.equal((await api('GET', '/api/state')).json.projects.find((x) => x.id === p.id).stepId, 'cy-1', 'nada mudou');

    // marcar item que exige evidência: fica aguardando e continua bloqueando
    let r = await api('PUT', itemUrl(itC), { done: true });
    assert.equal(r.json.instance.items[0].status, 'awaiting_evidence');
    assert.equal(r.json.instance.pending.length, 2);

    // uploads
    const evUrl = `${itemUrl(itC)}/evidence`;
    assert.equal((await upload(evUrl, 'virus.exe', Buffer.from('MZ...'))).status, 400);
    assert.equal((await upload(evUrl, 'falso.png', Buffer.from('<html>oi</html>'))).status, 400);
    assert.equal((await upload(evUrl, 'doc.pdf', PDF)).status, 400, 'item aceita só imagem');
    assert.equal((await upload(evUrl, 'a.png', PNG, { fileType: 'text/html' })).status, 400);
    assert.equal((await upload(`${itemUrl(itB)}/evidence`, 'a.png', PNG)).status, 400, 'item sem evidência não recebe anexos');
    r = await upload(evUrl, '..\\..\\..\\Windows\\print 1.png', PNG, { fileType: 'image/png' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ev1 = r.json.instance.items[0].evidences[0];
    assert.equal(ev1.name, 'print 1.png');
    assert.equal(ev1.description, 'teste ç');
    assert.equal(r.json.instance.items[0].status, 'done');
    assert.ok(r.json.instance.items[0].completedAt);
    r = await upload(evUrl, 'print 1.png', PNG); // mesmo nome: não sobrescreve
    assert.equal(r.status, 200);
    const evs = r.json.instance.items[0].evidences;
    assert.equal(evs.length, 2);
    const stored = fs.readdirSync(path.join(dataDir, 'evidencias', `cliente-a-${p.id}`, '01-homologacao'));
    assert.equal(stored.length, 2);
    assert.ok(stored.every((f) => f.endsWith('_print 1.png')) && new Set(stored).size === 2);
    assert.equal((await upload(evUrl, 'c.png', PNG)).status, 200);
    assert.equal((await upload(evUrl, 'd.png', PNG)).status, 400, 'máximo de 3 por item');

    // visualizar / baixar
    const view = await fetch(`${base}/api/projects/${p.id}/evidences/${ev1.id}/file?inline=1`);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('content-type'), 'image/png');
    assert.equal(view.headers.get('x-content-type-options'), 'nosniff');
    assert.match(view.headers.get('content-disposition'), /^inline/);
    assert.deepEqual(Buffer.from(await view.arrayBuffer()), PNG);
    const dl = await fetch(`${base}/api/projects/${p.id}/evidences/${ev1.id}/file`);
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
    assert.equal((await fetch(`${base}/api/projects/${p.id}/evidences/inexistente/file`)).status, 404);

    // ainda falta o obrigatório A
    assert.equal((await api('PUT', `/api/projects/${p.id}/step`, { stepId: 'cy-2' })).status, 409);
    r = await api('PUT', itemUrl(itA), { done: true });
    assert.equal(r.json.instance.pending.length, 0);

    // desmarcar C mantém as evidências; remover uma evidência move o arquivo (não apaga)
    r = await api('PUT', itemUrl(itC), { done: false });
    assert.equal(r.json.instance.items[0].evidences.length, 3);
    r = await api('PUT', itemUrl(itC), { done: true });
    assert.equal(r.json.instance.items[0].status, 'done');
    for (const e of r.json.instance.items[0].evidences.slice(1)) assert.equal((await api('DELETE', `/api/projects/${p.id}/evidences/${e.id}`)).status, 200);
    assert.equal(fs.readdirSync(path.join(dataDir, 'evidencias', '.removidas')).length, 2);
    r = await api('DELETE', `/api/projects/${p.id}/evidences/${ev1.id}`);
    assert.equal(r.json.instance.items[0].status, 'awaiting_evidence', 'sem a evidência exigida o item volta a pendente');
    assert.equal(r.json.instance.pending.length, 1);
    r = await upload(evUrl, 'de novo.png', PNG);
    assert.equal(r.json.instance.pending.length, 0);

    // modelo muda depois: o projeto NÃO muda sozinho
    await mk({ title: 'Item novo', required: true });
    const still = await api('POST', `/api/projects/${p.id}/checklists/cy-1/open`, {});
    assert.equal(still.json.instance.items.length, 3);
    assert.equal(still.json.instance.sync.added, 1, 'mas avisa que há mudanças no modelo');
    const dry = await api('POST', `/api/projects/${p.id}/checklists/cy-1/sync`, { dryRun: true });
    assert.equal(dry.json.plan.added.length, 1);
    assert.equal((await api('POST', `/api/projects/${p.id}/checklists/cy-1/open`, {})).json.instance.items.length, 3);

    // avança (o novo item ainda não foi copiado), depois sincroniza
    const moved = await api('PUT', `/api/projects/${p.id}/step`, { stepId: 'cy-2' });
    assert.equal(moved.status, 200);
    const synced = await api('POST', `/api/projects/${p.id}/checklists/cy-1/sync`, {});
    assert.equal(synced.json.instance.items.length, 4);
    assert.equal(synced.json.instance.pending.length, 1);
    assert.equal(synced.json.instance.items.find((i) => i.title === 'Validar PFUNC').status, 'done', 'marcações e evidências preservadas');
    // voltar nunca é bloqueado
    assert.equal((await api('PUT', `/api/projects/${p.id}/step`, { stepId: 'cy-1' })).status, 200);

    // auditoria
    const log = (await api('GET', '/api/audit')).json.map((x) => x.action);
    for (const act of ['checklist-iniciado', 'checklist-marcado', 'checklist-desmarcado', 'evidencia-adicionada', 'evidencia-removida', 'avanco-bloqueado', 'etapa-concluida', 'checklist-sincronizado', 'checklist-modelo-alterado']) {
      assert.ok(log.includes(act), `auditoria sem ${act}`);
    }

    // configuração de evidências
    assert.equal((await api('PUT', '/api/settings/evidence', { maxMB: 1, image: ['.png'], document: ['.pdf', '.exe'], extra: [] })).status, 400);
    assert.equal((await api('PUT', '/api/settings/evidence', { maxMB: 1, image: ['.png'], document: ['.pdf'], extra: [] })).status, 200);
    const big = await upload(evUrl, 'grande.png', Buffer.concat([PNG, Buffer.alloc(1200000)]));
    assert.equal(big.status, 413);

    // excluir o estágio (sem uso em ciclo) não apaga os checklists: eles são cadastro à parte
    const created = (await api('POST', '/api/stages', { name: 'Temporário', color: '#112233' })).json;
    assert.equal((await api('DELETE', `/api/stages/${created.id}`)).status, 200);
    assert.ok((await api('GET', '/api/state')).json.checklists.some((c) => c.id === ck.id), 'o checklist continua cadastrado');
    // excluir item do modelo não mexe no projeto
    assert.equal((await api('DELETE', `/api/checklist-items/${a.json.id}`)).status, 200);
    assert.equal((await api('POST', `/api/projects/${p.id}/checklists/cy-1/open`, {})).json.instance.items.length, 4);
    assert.equal((await api('POST', `/api/projects/${p.id}/checklists/cy-99/open`, {})).status, 404);
  } finally { server.close(); }
});

test('API: N checklists por passo do ciclo — grupos na execução, ordem, mover item e remover checklist (bloqueado enquanto associado)', async () => {
  await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(PORT, '127.0.0.1');
  const b = `http://localhost:${PORT}`;
  const call = async (method, url, body) => { const r = await fetch(b + url, { method, headers: { 'Content-Type': 'application/json', Origin: b }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    const st = 'st-producao';
    const tec = (await call('POST', '/api/checklists', { name: 'Checklist Técnico' })).json;
    const cli = (await call('POST', '/api/checklists', { name: 'Checklist Cliente' })).json;
    assert.equal((await call('POST', '/api/checklists', { name: '' })).status, 400);
    assert.equal((await call('POST', '/api/checklists', { name: ' checklist cliente ' })).status, 409, 'nome repetido');
    const i1 = (await call('POST', `/api/checklists/${tec.id}/items`, { title: 'Conferir carga', required: true })).json;
    const i2 = (await call('POST', `/api/checklists/${cli.id}/items`, { title: 'Aprovação do cliente', required: true })).json;
    await call('POST', `/api/checklists/${tec.id}/items`, { title: 'Observação', required: false });
    // a ordem dos checklists vem da associação com o passo do ciclo: Cliente primeiro
    assert.equal((await call('PUT', '/api/cycles/cyc-padrao/steps/cy-4/checklists', { checklistIds: [cli.id, tec.id] })).status, 200);
    assert.equal((await call('PUT', '/api/cycles/cyc-padrao/steps/cy-4/checklists', { checklistIds: ['nao-existe'] })).status, 400);
    assert.equal((await call('PUT', '/api/cycles/cyc-padrao/steps/passo-fantasma/checklists', { checklistIds: [] })).status, 404);
    const p = (await call('POST', '/api/projects', { name: 'Proj N checklists' })).json;
    const prodStep = p.steps.find((s) => s.stageId === st);
    // leva o projeto direto para Produção (os passos anteriores não têm itens obrigatórios de teste aqui? podem ter: usa a primeira etapa de Produção)
    const r = await call('POST', `/api/projects/${p.id}/checklists/${prodStep.id}/open`, {});
    const inst = r.json.instance;
    assert.deepEqual(inst.groups.map((g) => g.name), ['Checklist Cliente', 'Checklist Técnico']);
    assert.deepEqual(inst.groups.map((g) => [g.progress.total, g.progress.requiredTotal]), [[1, 1], [2, 1]]);
    assert.equal(inst.progress.requiredTotal, 2, 'o bloqueio considera todos os checklists do estágio');
    // mover item para o outro checklist: o projeto só muda ao sincronizar
    assert.equal((await call('PUT', `/api/checklist-items/${i1.id}`, { title: 'Conferir carga', required: true, checklistId: cli.id })).json.checklistId, cli.id);
    const plan = (await call('POST', `/api/projects/${p.id}/checklists/${prodStep.id}/sync`, { dryRun: true })).json.plan;
    assert.deepEqual(plan.updated.map((u) => u.changes), [['checklistId']]);
    const synced = (await call('POST', `/api/projects/${p.id}/checklists/${prodStep.id}/sync`, {})).json.instance;
    assert.deepEqual(synced.groups.map((g) => [g.name, g.itemIds.length]), [['Checklist Cliente', 2], ['Checklist Técnico', 1]]);
    // checklist associado a um ciclo não é excluído em silêncio: a resposta diz onde ele é usado
    const inUse = await call('DELETE', `/api/checklists/${tec.id}`);
    assert.equal(inUse.status, 409);
    assert.equal(inUse.json.code, 'CHECKLIST_IN_USE');
    assert.match(inUse.json.error, /Ciclo de migração padrão \/ Produção/);
    assert.match(inUse.json.error, /Remova essas associações antes de excluir/);
    assert.ok((await call('GET', '/api/state')).json.checklists.some((c) => c.id === tec.id), 'nada foi removido');
    // tirando a associação do ciclo (nova versão do ciclo; o projeto continua com a cópia dele), a exclusão é liberada
    assert.equal((await call('PUT', '/api/cycles/cyc-padrao/steps/cy-4/checklists', { checklistIds: [cli.id] })).status, 200);
    // remover um checklist do modelo não mexe no projeto até sincronizar
    assert.equal((await call('DELETE', `/api/checklists/${tec.id}`)).status, 200);
    assert.ok(!(await call('GET', '/api/state')).json.checklistItems.some((d) => d.checklistId === tec.id));
    const still = (await call('POST', `/api/projects/${p.id}/checklists/${prodStep.id}/open`, {})).json.instance;
    assert.equal(still.items.length, 3);
    assert.equal(still.groups.find((g) => g.name === 'Checklist removido do modelo').itemIds.length, 1);
    assert.equal(still.sync.archived, 1);
    assert.ok(i2.id);
  } finally { server.close(); }
});
