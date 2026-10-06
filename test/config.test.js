const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contacts = require('../src/contacts');

test('WhatsApp: número brasileiro, internacional e casos inválidos', () => {
  assert.equal(contacts.waLink('(11) 91234-5678'), 'https://wa.me/5511912345678');
  assert.equal(contacts.waLink('11 3456-7890'), 'https://wa.me/551134567890');      // fixo com DDD
  assert.equal(contacts.waLink('+55 (21) 99999-0000'), 'https://wa.me/5521999990000');
  assert.equal(contacts.waLink('5511912345678'), 'https://wa.me/5511912345678');     // já com 55
  assert.equal(contacts.waLink('+1 415 555 0100'), 'https://wa.me/14155550100');     // internacional só com "+"
  assert.equal(contacts.waLink('91234-5678'), null);                                  // sem DDD: não chuta
  assert.equal(contacts.waLink(''), null);
  assert.equal(contacts.waLink('abc'), null);
  assert.ok(contacts.isEmail('nome.sobrenome@empresa.com.br'));
  for (const bad of ['sem-arroba', 'a@b', 'a b@c.com', 'a@b.c', '<x>@y.com']) assert.ok(!contacts.isEmail(bad), bad);
});

// ---- API (dados isolados em pasta temporária) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cfg-'));
const PORT = 4393;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
// dados antigos: sem coordenadores, estágios, ciclo nem campos novos nos projetos
fs.mkdirSync(process.env.GP_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), JSON.stringify({
  version: 1, settings: { warnDays: 7 },
  projects: [{ id: 'legado', name: 'Projeto antigo', description: '', rootDir: '', bases: [], deparas: [], milestones: [] }],
}));
const { app } = require('../server');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('dados antigos ganham estágios, ciclo padrão e campos novos sem perder nada', async () => {
  const st = (await api('GET', '/api/state')).json;
  assert.deepEqual(st.stages.map((s) => s.name), ['Homologação', 'Documentação', 'Correções', 'Produção', 'Concluído']);
  assert.equal(st.cycles.length, 1);
  assert.equal(st.defaultCycleId, st.cycles[0].id);
  const names = st.cycles[0].steps.map((c) => st.stages.find((s) => s.id === c.stageId).name);
  assert.deepEqual(names, ['Homologação', 'Documentação', 'Correções', 'Produção', 'Documentação', 'Correções', 'Concluído']);
  const p = st.projects.find((x) => x.id === 'legado');
  assert.equal(p.cycleId, st.cycles[0].id, 'projeto antigo recebe o ciclo padrão');
  assert.deepEqual(p.steps.map((x) => x.id), st.cycles[0].steps.map((x) => x.id), 'com os mesmos ids de passo');
  assert.equal(p.cycleUpdate.available, false);
  assert.equal(p.name, 'Projeto antigo');
  assert.equal(p.coordinatorId, null); assert.equal(p.stepId, null);
  assert.deepEqual(p.corrections, []); assert.deepEqual(p.stageHistory, []);
});

test('coordenadores: cadastro, validação, WhatsApp e exclusão desvincula dos projetos', async () => {
  assert.equal((await api('POST', '/api/coordinators', { name: '' })).status, 400);
  assert.equal((await api('POST', '/api/coordinators', { name: 'A', email: 'ruim' })).status, 400);
  assert.equal((await api('POST', '/api/coordinators', { name: 'A', phone: '123' })).status, 400);
  const c = (await api('POST', '/api/coordinators', { name: 'Maria Souza', role: 'Coordenadora', email: 'maria@x.com', phone: '(11) 91234-5678' })).json;
  assert.equal(c.waUrl, 'https://wa.me/5511912345678');

  assert.equal((await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', coordinatorId: 'nao-existe' })).status, 400);
  const withC = (await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', coordinatorId: c.id })).json;
  assert.equal(withC.coordinatorId, c.id);

  const del = (await api('DELETE', `/api/coordinators/${c.id}`)).json;
  assert.equal(del.unassigned, 1);
  const st = (await api('GET', '/api/state')).json;
  assert.equal(st.projects.find((p) => p.id === 'legado').coordinatorId, null);
  assert.equal(st.coordinators.length, 0);
});

test('estágios: nome único, cor válida, e não exclui estágio usado no ciclo', async () => {
  assert.equal((await api('POST', '/api/stages', { name: 'Pausado', color: 'vermelho' })).status, 400);
  assert.equal((await api('POST', '/api/stages', { name: 'homologação', color: '#112233' })).status, 409); // duplicado (sem diferenciar maiúsculas/acentos de caixa)
  const s = (await api('POST', '/api/stages', { name: 'Aguardando cliente', color: '#ffb800' })).json;
  assert.equal(s.color, '#FFB800');
  assert.equal((await api('DELETE', '/api/stages/st-homologacao')).status, 409);
  assert.equal((await api('DELETE', `/api/stages/${s.id}`)).status, 200);
});

test('etapa do projeto: avança com histórico; remover passo do ciclo limpa a etapa; restaurar ciclo padrão', async () => {
  assert.equal((await api('PUT', '/api/projects/legado/step', { stepId: 'nao-existe' })).status, 400);
  await api('PUT', '/api/projects/legado/step', { stepId: 'cy-1' });
  await api('PUT', '/api/projects/legado/step', { stepId: 'cy-1' });          // repetido: não duplica no histórico
  const p = (await api('PUT', '/api/projects/legado/step', { stepId: 'cy-2' })).json;
  assert.equal(p.stepId, 'cy-2');
  assert.deepEqual(p.stageHistory.map((h) => h.name), ['Homologação', 'Documentação']);

  // remove o passo cy-2 do ciclo: o projeto NÃO muda sozinho; mostra "nova versão" e só aplica quando confirmado
  let st = (await api('GET', '/api/state')).json;
  const cyc = st.cycles[0];
  const put = await api('PUT', `/api/cycles/${cyc.id}`, { steps: cyc.steps.filter((c) => c.id !== 'cy-2') });
  assert.equal(put.status, 200);
  assert.equal(put.json.version, 2);
  st = (await api('GET', '/api/state')).json;
  let lp = st.projects.find((x) => x.id === 'legado');
  assert.equal(lp.stepId, 'cy-2', 'nada muda silenciosamente');
  assert.equal(lp.steps.length, 7);
  assert.equal(lp.cycleUpdate.available, true);
  assert.equal(lp.cycleUpdate.currentRemoved, true);
  assert.deepEqual(lp.cycleUpdate.removed.map((r) => r.id), ['cy-2']);
  const blocked = await api('POST', '/api/projects/legado/cycle/apply', {});
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, 'CYCLE_CURRENT_REMOVED');
  assert.equal((await api('POST', '/api/projects/legado/cycle/apply', { dryRun: true })).json.diff.removed.length, 1);
  const applied = (await api('POST', '/api/projects/legado/cycle/apply', { confirmCurrentRemoved: true })).json.project;
  assert.equal(applied.stepId, null);
  assert.equal(applied.steps.length, 6);
  assert.equal(applied.cycleVersion, 2);
  assert.equal(applied.cycleUpdate.available, false);
  assert.equal(applied.stageHistory.length, 3, 'histórico mantido (+ registro da mudança)');

  // renomear sem mudar passos não cria versão nova
  assert.equal((await api('PUT', `/api/cycles/${cyc.id}`, { name: 'Ciclo principal' })).json.version, 2);
  assert.equal((await api('PUT', `/api/cycles/${cyc.id}`, { steps: [{ stageId: 'inexistente' }] })).status, 400);
  assert.equal((await api('PUT', `/api/cycles/${cyc.id}`, { steps: [] })).status, 400);
  assert.equal((await api('DELETE', `/api/cycles/${cyc.id}`)).status, 409, 'em uso / padrão');

  // ciclos por tipo de projeto: projeto novo do tipo recebe o ciclo do tipo (cópia própria)
  const edu = (await api('POST', '/api/cycles', { name: 'Migração Educacional', steps: [{ stageId: 'st-producao' }, { stageId: 'st-concluido' }] })).json;
  assert.equal(edu.steps.length, 2);
  assert.ok(!['cy-4', 'cy-7'].includes(edu.steps[0].id), 'passos de ciclos diferentes têm ids próprios');
  assert.equal((await api('POST', '/api/cycles', { name: 'migração educacional', steps: [{ stageId: 'st-producao' }] })).status, 409);
  const copy = (await api('POST', '/api/cycles', { name: 'Cópia', copyFrom: edu.id })).json;
  assert.equal(copy.steps.length, 2);
  const tipo = (await api('POST', '/api/project-types', { name: 'Migração Educacional', color: '#A44DFF' })).json;
  assert.equal((await api('PUT', `/api/project-types/${tipo.id}/cycle`, { cycleId: edu.id })).json.cycleId, edu.id);
  const np = (await api('POST', '/api/projects', { name: 'Escola X', projectTypeId: tipo.id })).json;
  assert.equal(np.cycleId, edu.id);
  assert.deepEqual(np.steps.map((x) => x.id), edu.steps.map((x) => x.id));
  const other = (await api('POST', '/api/projects', { name: 'Escola Y', projectTypeId: tipo.id, cycleId: cyc.id })).json;
  assert.equal(other.cycleId, cyc.id, 'o ciclo escolhido vence o do tipo');
  // avançar usa os passos do PRÓPRIO projeto
  assert.equal((await api('PUT', `/api/projects/${np.id}/step`, { stepId: 'cy-1' })).status, 400);
  assert.equal((await api('PUT', `/api/projects/${np.id}/step`, { stepId: edu.steps[0].id })).status, 200);
  // trocar o ciclo de um projeto em andamento pede confirmação
  const sw = await api('PUT', `/api/projects/${np.id}`, { name: 'Escola X', projectTypeId: tipo.id, cycleId: cyc.id });
  assert.equal(sw.status, 409); assert.equal(sw.json.code, 'CYCLE_CHANGE');
  const sw2 = (await api('PUT', `/api/projects/${np.id}`, { name: 'Escola X', projectTypeId: tipo.id, cycleId: cyc.id, confirmCycleChange: true })).json;
  assert.equal(sw2.cycleId, cyc.id); assert.equal(sw2.stepId, null);
  // um ciclo usado por um tipo não pode ser excluído; o padrão pode ser trocado
  assert.equal((await api('DELETE', `/api/cycles/${edu.id}`)).status, 409);
  assert.equal((await api('DELETE', `/api/cycles/${copy.id}`)).status, 200);
  assert.equal((await api('PUT', '/api/cycles-default', { id: edu.id })).status, 200);
  assert.equal((await api('POST', '/api/projects', { name: 'Sem tipo' })).json.cycleId, edu.id);
  await api('PUT', '/api/cycles-default', { id: cyc.id });
  // estágio usado num ciclo (ou na cópia de um projeto) não pode ser excluído
  assert.equal((await api('DELETE', '/api/stages/st-concluido')).status, 409);
});

test('correções: só link do Google Sheets', async () => {
  assert.equal((await api('POST', '/api/projects/legado/corrections', { label: 'X', url: 'https://evil.com/spreadsheets/d/abcdefghijk' })).status, 400);
  const p = (await api('POST', '/api/projects/legado/corrections', { label: 'Correções homologação', url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit' })).json;
  assert.equal(p.corrections.length, 1);
  const p2 = (await api('DELETE', `/api/projects/legado/corrections/${p.corrections[0].id}`)).json;
  assert.equal(p2.corrections.length, 0);
});

test('documentos: só tipos de documento; nunca executáveis; links só http(s); abrir valida tudo', async () => {
  const pdf = path.join(tmp, 'Modelo de homologação.pdf'); fs.writeFileSync(pdf, '%PDF-1.4');
  const reject = async (source) => assert.equal((await api('POST', '/api/documents', { title: 'T', source })).status, 400, JSON.stringify(source));
  await reject({ type: 'file', path: 'C:\\Windows\\System32\\cmd.exe' });
  await reject({ type: 'file', path: path.join(tmp, 'script.bat') });
  await reject({ type: 'file', path: path.join(tmp, 'atalho.lnk') });
  await reject({ type: 'file', path: 'relativo.pdf' });
  await reject({ type: 'link', url: 'javascript:alert(1)' });
  await reject({ type: 'link', url: 'file:///C:/Windows/System32/cmd.exe' });

  const d1 = (await api('POST', '/api/documents', { title: 'Modelo de homologação', kind: 'modelo', stageId: 'st-homologacao', source: { type: 'file', path: pdf } })).json;
  assert.equal(d1.fileExists, true);
  const d2 = (await api('POST', '/api/documents', { title: 'Guia', kind: 'documento', source: { type: 'link', url: 'https://exemplo.com/guia' } })).json;
  assert.equal(d2.fileExists, null);
  assert.equal((await api('POST', `/api/documents/${d2.id}/open`)).status, 400);     // link: abre pelo navegador
  assert.equal((await api('POST', '/api/documents/nao-existe/open')).status, 404);
  assert.equal((await api('POST', '/api/documents', { title: 'T', stageId: 'xx', source: { type: 'link', url: 'https://a.com' } })).status, 400);

  fs.rmSync(pdf);
  assert.equal((await api('POST', `/api/documents/${d1.id}/open`)).status, 404);      // arquivo sumiu
  assert.equal((await api('GET', '/api/state')).json.documents.find((d) => d.id === d1.id).fileExists, false);

  // excluir o estágio limpa a associação nos documentos
  const s = (await api('POST', '/api/stages', { name: 'Temporário', color: '#123456' })).json;
  const d3 = (await api('POST', '/api/documents', { title: 'Doc', stageId: s.id, source: { type: 'link', url: 'https://a.com' } })).json;
  await api('DELETE', `/api/stages/${s.id}`);
  assert.equal((await api('GET', '/api/state')).json.documents.find((d) => d.id === d3.id).stageId, null);
});

test('tipo de projeto e sistema de origem: cadastro, cor, nome único, vínculo e exclusão desvincula', async () => {
  for (const path of ['project-types', 'origin-systems']) {
    assert.equal((await api('POST', `/api/${path}`, { name: '', color: '#112233' })).status, 400);
    assert.equal((await api('POST', `/api/${path}`, { name: 'X', color: 'azul' })).status, 400);
  }
  const pt = (await api('POST', '/api/project-types', { name: 'TOTVS Educacional', color: '#00dbff' })).json;
  assert.equal(pt.color, '#00DBFF');
  assert.equal((await api('POST', '/api/project-types', { name: 'totvs educacional', color: '#112233' })).status, 409);
  const os = (await api('POST', '/api/origin-systems', { name: 'RM Classic', color: '#ff8900' })).json;

  assert.equal((await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', projectTypeId: 'nao-existe' })).status, 400);
  assert.equal((await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', originSystemId: 'nao-existe' })).status, 400);
  const withTags = (await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', projectTypeId: pt.id, originSystemId: os.id })).json;
  assert.equal(withTags.projectTypeId, pt.id);
  assert.equal(withTags.originSystemId, os.id);

  const renamed = (await api('PUT', `/api/project-types/${pt.id}`, { name: 'TOTVS Folha', color: '#A44DFF' })).json;
  assert.equal(renamed.name, 'TOTVS Folha');

  const del = (await api('DELETE', `/api/project-types/${pt.id}`)).json;
  assert.equal(del.unassigned, 1);
  const st = (await api('GET', '/api/state')).json;
  assert.equal(st.projects.find((p) => p.id === 'legado').projectTypeId, null);
  assert.equal(st.projects.find((p) => p.id === 'legado').originSystemId, os.id); // o outro catálogo não é afetado
  assert.ok(!st.projectTypes.some((t) => t.id === pt.id));
  assert.equal(st.originSystems.length, 1);
});

test('pasta raiz: local exige caminho absoluto; Drive exige link do drive.google.com; trocar de tipo limpa o outro campo', async () => {
  const local = (await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', rootDirKind: 'local', rootDir: 'C:/Projetos/X' })).json;
  assert.equal(local.rootDirKind, 'local');
  assert.equal(local.rootDir, path.normalize('C:/Projetos/X'));
  assert.equal(local.rootDriveUrl, '');
  assert.equal(local.rootDirExists, false); // caminho válido mas inexistente

  assert.equal((await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', rootDirKind: 'local', rootDir: 'relativo' })).status, 400);
  assert.equal((await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', rootDirKind: 'drive', rootDriveUrl: 'https://dropbox.com/x' })).status, 400);
  assert.equal((await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', rootDirKind: 'drive', rootDriveUrl: 'http://drive.google.com/drive/folders/abc' })).status, 400); // precisa ser https

  const drive = (await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', rootDirKind: 'drive', rootDriveUrl: 'https://drive.google.com/drive/folders/1AbCdEf' })).json;
  assert.equal(drive.rootDirKind, 'drive');
  assert.equal(drive.rootDriveUrl, 'https://drive.google.com/drive/folders/1AbCdEf');
  assert.equal(drive.rootDir, ''); // trocar para Drive limpa a pasta local
  assert.equal(drive.rootDirExists, null); // não dá para checar um link do Drive

  const backToLocal = (await api('PUT', '/api/projects/legado', { name: 'Projeto antigo', rootDirKind: 'local', rootDir: 'C:/Projetos/Y' })).json;
  assert.equal(backToLocal.rootDriveUrl, ''); // trocar de volta para local limpa o link do Drive
});

test('planilhas: flag "importable" controla se a importação é permitida (na criação, na edição e no servidor)', async () => {
  const withBase = (await api('POST', `/api/projects/legado/bases`, { name: 'B', local: { server: 'localhost', database: 'X', auth: 'windows' } })).json;
  const baseId = withBase.bases[0].id;

  const d1 = (await api('POST', '/api/projects/legado/deparas', { label: 'Só referência', url: '', targetDir: 'C:/X', importable: false })).json.deparas.at(-1);
  assert.equal(d1.importable, false);
  const d2 = (await api('POST', '/api/projects/legado/deparas', { label: 'Padrão', url: '', targetDir: 'C:/X' })).json.deparas.at(-1);
  assert.equal(d2.importable, true); // sem enviar o campo, continua importável (compatível com o comportamento anterior)

  const blocked = await api('POST', '/api/import/plan', { projectId: 'legado', baseId, env: 'local', filePath: 'C:/nao-existe.xlsx', deparaId: d1.id, sheets: [] });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.error, /não está marcada para permitir importação/);

  // desmarcar depois de criada também bloqueia; marcar de novo libera (a checagem é sempre no valor atual salvo)
  const edited = (await api('PUT', `/api/projects/legado/deparas/${d2.id}`, { label: 'Padrão', url: '', targetDir: 'C:/X', importable: false })).json.deparas.find((x) => x.id === d2.id);
  assert.equal(edited.importable, false);
  const blocked2 = await api('POST', '/api/import/plan', { projectId: 'legado', baseId, env: 'local', filePath: 'C:/nao-existe.xlsx', deparaId: d2.id, sheets: [] });
  assert.equal(blocked2.status, 403);

  await api('DELETE', `/api/projects/legado/bases/${baseId}`);
  await api('DELETE', `/api/projects/legado/deparas/${d1.id}`);
  await api('DELETE', `/api/projects/legado/deparas/${d2.id}`);
});
