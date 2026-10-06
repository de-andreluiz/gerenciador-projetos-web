// Comunicações = GERADOR de e-mails (modelo + dados do projeto → destinatários/assunto/corpo prontos para copiar).
// A aplicação não envia nada: estes testes também provam que nenhuma rede externa é usada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-em-'));
const PORT = 4452;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
// Arquivo de dados de uma versão anterior, que ainda guardava credenciais do Gmail (agora sem uso): o app não pode apagá-las sozinho.
fs.mkdirSync(process.env.GP_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), JSON.stringify({ version: 1, settings: { warnDays: 7 }, projects: [],
  integrations: { gmail: { clientId: '1-a.apps.googleusercontent.com', clientSecretEnc: 'ENC-SECRETO', refreshTokenEnc: 'ENC-TOKEN', account: 'eu@gmail.com' } } }));

// Guarda de rede: qualquer conexão que NÃO seja para a própria máquina é registrada (e o teste final exige zero).
const external = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
  const o = args[0];
  const host = typeof o === 'object' && o !== null ? o.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) external.push(host);
  return realConnect.apply(this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => { if (!String(url).startsWith('http://localhost') && !String(url).startsWith('http://127.0.0.1')) external.push(String(url)); return realFetch(url, ...rest); };

const { app } = require('../server');
const M = require('../src/email');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { net.Socket.prototype.connect = realConnect; globalThis.fetch = realFetch; server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };

// ---------- Cenário: Cliente Alfa ----------
const S = {};
test('preparação: pessoas, estágio, ciclo, projeto e contatos', async () => {
  S.coord = ok(await api('POST', '/api/coordinators', { name: 'Carla Coord', email: 'coordenador@empresa.com' }));
  S.anal = ok(await api('POST', '/api/coordinators', { name: 'Ana Analista', email: 'analista@empresa.com' }));
  S.stage = ok(await api('POST', '/api/stages', { name: 'Homologação E', color: '#112233' }));
  S.cyc = ok(await api('POST', '/api/cycles', { name: 'Ciclo E-mail', steps: [{ stageId: S.stage.id }] }));
  S.p = ok(await api('POST', '/api/projects', { name: 'Cliente Alfa', coordinatorId: S.coord.id, analystId: S.anal.id, cycleId: S.cyc.id }));
  ok(await api('POST', `/api/projects/${S.p.id}/contacts`, { name: 'Cliente 1', email: 'cliente1@empresa.com', kind: 'stakeholder' }));
  ok(await api('POST', `/api/projects/${S.p.id}/contacts`, { name: 'Cliente 2', email: 'CLIENTE2@empresa.com', kind: 'stakeholder' }));
  const r = ok(await api('POST', `/api/projects/${S.p.id}/contacts`, { name: 'Sem e-mail', kind: 'stakeholder' }));
  assert.equal(r.contacts.length, 3);
  assert.equal((await api('POST', `/api/projects/${S.p.id}/contacts`, { name: 'X', email: 'nao-e-email' })).status, 400);
});

test('1–3. modelo: criar, validar, editar e duplicar', async () => {
  const bad = await api('POST', '/api/email-templates', { name: 'X', subject: 'Oi {{project.inventada}}', body: 'b', to: ['role:stakeholders'] });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'EMAIL_UNKNOWN_VARIABLE'); // não inventa variáveis
  assert.equal((await api('POST', '/api/email-templates', { name: 'X', subject: 's', body: 'b', to: ['nao-e-email'] })).status, 400);
  S.t = ok(await api('POST', '/api/email-templates', {
    name: 'Solicitação de Backup', description: 'Pede o backup ao cliente', subject: '[{{project.name}}] Solicitação de Backup',
    body: 'Olá,\n\nPara continuidade do projeto **{{project.name}}** (ciclo {{project.cycle}}, etapa {{project.current_stage}}), precisamos do backup.\n- Coordenador: {{project.coordinator}}\n- Analista: {{project.analyst}}\n\nAtenciosamente.',
    to: ['role:stakeholders'], cc: ['role:coordinator', 'role:analyst', 'gestao@empresa.com', 'coordenador@empresa.com'], bcc: ['role:sender'],
  }));
  assert.equal(S.t.scope, 'global'); assert.equal(S.t.active, true);
  assert.deepEqual(S.t.bcc, []); // papel "Eu" da versão com Gmail é ignorado
  assert.equal((await api('POST', '/api/email-templates', { name: 'solicitação de backup', subject: 's', body: 'b' })).status, 409); // nome único
  const ed = ok(await api('PUT', `/api/email-templates/${S.t.id}`, { description: 'Editado' }));
  assert.equal(ed.description, 'Editado'); assert.equal(ed.subject, S.t.subject);
  const dup = ok(await api('POST', `/api/email-templates/${S.t.id}/duplicate`));
  assert.equal(dup.name, 'Solicitação de Backup (cópia)'); assert.notEqual(dup.id, S.t.id); assert.deepEqual(dup.cc, S.t.cc);
  assert.equal((await api('DELETE', `/api/email-templates/${dup.id}`)).status, 200); // nunca usado: pode excluir
  const cat = ok(await api('GET', '/api/email-templates'));
  assert.ok(['project.name', 'project.start_date', 'project.cycle', 'project.current_stage'].every((k) => cat.variables.some((v) => v.key === k)));
  assert.ok(cat.roles.some((r) => r.key === 'role:stakeholders'));
  assert.equal(cat.roles.some((r) => r.key === 'role:sender'), false);
});

test('6–14. variáveis e destinatários resolvidos (coordenador, analista, estágio, ciclo, fixos, duplicados, ausentes) — unitário', () => {
  const data = { coordinators: [{ id: 'c', name: 'Carla', email: 'c@x.com' }, { id: 'a', name: 'Ana', email: '' }], stages: [{ id: 's', name: 'Homologação' }], projectTypes: [{ id: 't', name: 'Folha' }],
    cycles: [{ id: 'cy', name: 'Ciclo Padrão' }], originSystems: [] };
  const project = { id: 'p', name: 'Cliente Alfa', coordinatorId: 'c', analystId: 'a', projectTypeId: 't', cycleId: 'cy', steps: [{ id: 'st', stageId: 's' }], stepId: 'st',
    stageHistory: [{ stepId: 'st', at: '2026-03-05T12:00:00.000Z' }], contacts: [{ name: 'J', email: 'j@cli.com', kind: 'stakeholder' }, { name: 'K', email: 'C@X.COM', kind: 'stakeholder' }] };
  const ctx = M.contextFor(data, project);
  const v = M.variableValues(ctx);
  assert.equal(v['project.name'], 'Cliente Alfa'); assert.equal(v['project.coordinator'], 'Carla'); assert.equal(v['project.current_stage'], 'Homologação');
  assert.equal(v['project.cycle'], 'Ciclo Padrão'); assert.equal(v['project.type'], 'Folha'); assert.equal(v['project.start_date'], '05/03/2026');
  assert.equal('project.analyst_email' in v, false); // sem valor não entra no mapa
  const r = M.renderText('[{{project.name}}] {{ project.current_stage }} {{project.analyst_email}} {{x.y}}', v);
  assert.equal(r.text, '[Cliente Alfa] Homologação {{project.analyst_email}} {{x.y}}'); // marcador mantido (nunca some em silêncio)
  assert.deepEqual(r.missing, ['project.analyst_email']); assert.deepEqual(r.unknown, ['x.y']);
  const g = M.generate({ subject: 'S {{project.name}}', body: 'Analista: {{project.analyst}} / {{project.analyst_email}}', to: ['role:stakeholders'], cc: ['role:coordinator', 'role:analyst', 'fixo@empresa.com'], bcc: ['fixo@empresa.com'] }, ctx);
  assert.deepEqual(g.to, ['j@cli.com', 'C@X.COM']);
  assert.deepEqual(g.cc, ['fixo@empresa.com']); // coordenador já está em Para (C@X.COM == c@x.com)
  assert.deepEqual(g.bcc, []); // fixo já em CC
  assert.ok(g.warnings.includes('Analista (Ana) sem e-mail cadastrado.'));
  assert.ok(g.warnings.includes('Analista sem e-mail cadastrado.')); // aviso da variável ausente
  assert.deepEqual(g.missingVariables, ['project.analyst_email']);
  assert.ok(g.body.includes('{{project.analyst_email}}'));
  const none = M.generate({ subject: 's', body: 'b', to: ['role:stakeholders'], cc: [], bcc: [] }, M.contextFor(data, { ...project, contacts: [], coordinatorId: null }));
  assert.ok(none.warnings.includes('Projeto sem stakeholder com e-mail definido.')); assert.ok(none.warnings.includes('Nenhum destinatário em “Para” foi resolvido.'));
  assert.ok(M.generate({ subject: 's', body: '{{project.analyst}}', to: [], cc: [], bcc: [] }, M.contextFor(data, { ...project, analystId: null })).warnings.includes('Analista não cadastrado no projeto.'));
  assert.ok(M.bodyToHtml('<b>x</b> **y**\n- a\nhttp://a.com/?q=1').includes('&lt;b&gt;x&lt;/b&gt; <strong>y</strong>'));
  assert.ok(!M.bodyToHtml('<script>alert(1)</script>').includes('<script>'));
  assert.equal(M.bodyToText('**negrito** e texto'), 'negrito e texto');
});

test('4–5. modelo global × específico do projeto; modelos habilitados por projeto', async () => {
  S.proj = ok(await api('POST', '/api/email-templates', { name: 'Só do projeto', scope: 'project', projectId: S.p.id, subject: 'Aviso {{project.name}}', body: 'b', to: ['x@y.com'] }));
  const outro = ok(await api('POST', '/api/projects', { name: 'Outro Projeto', cycleId: S.cyc.id }));
  const mine = ok(await api('GET', `/api/projects/${S.p.id}/emails`)).available.map((t) => t.name);
  assert.ok(mine.includes('Só do projeto') && mine.includes('Solicitação de Backup'));
  assert.deepEqual(ok(await api('GET', `/api/projects/${outro.id}/emails`)).available.map((t) => t.name), ['Solicitação de Backup']); // específico não vaza
  assert.equal((await api('POST', `/api/projects/${outro.id}/emails/generate`, { templateId: S.proj.id })).status, 409);
  ok(await api('PUT', `/api/projects/${S.p.id}/email-templates`, { ids: [] }));
  assert.equal(ok(await api('GET', `/api/projects/${S.p.id}/emails`)).available.map((t) => t.name).includes('Solicitação de Backup'), false);
  assert.equal((await api('POST', `/api/projects/${S.p.id}/emails/generate`, { templateId: S.t.id })).status, 409);
  ok(await api('PUT', `/api/projects/${S.p.id}/email-templates`, { ids: null }));
});

test('15–16. checklist → modelo; gerar mostra a prévia e não conclui o item', async () => {
  const ck = ok(await api('POST', '/api/checklists', { name: 'Comunicação E' }));
  assert.equal((await api('POST', `/api/checklists/${ck.id}/items`, { title: 'X', emailTemplateId: S.proj.id })).status, 400); // checklist só usa global
  S.item = ok(await api('POST', `/api/checklists/${ck.id}/items`, { title: 'Enviar solicitação de backup ao cliente', required: true, emailTemplateId: S.t.id }));
  ok(await api('PUT', `/api/cycles/${S.cyc.id}/steps/${S.cyc.steps[0].id}/checklists`, { checklistIds: [ck.id] }));
  await api('POST', `/api/projects/${S.p.id}/cycle/apply`, {});
  ok(await api('PUT', `/api/projects/${S.p.id}/step`, { stepId: S.cyc.steps[0].id }));
  const inst = ok(await api('POST', `/api/projects/${S.p.id}/checklists/${S.cyc.steps[0].id}/open`, {})).instance;
  S.inst = inst;
  S.it = inst.items.find((i) => i.title.startsWith('Enviar solicitação'));
  assert.ok(S.it, 'item no checklist do projeto');
  assert.equal(S.it.email.templateName, 'Solicitação de Backup'); assert.equal(S.it.email.lastGeneration, null);

  const g = ok(await api('POST', `/api/projects/${S.p.id}/emails/generate`, { stepId: inst.stepId, itemId: S.it.id }));
  assert.equal(g.subject, '[Cliente Alfa] Solicitação de Backup');
  assert.deepEqual(g.to, ['cliente1@empresa.com', 'CLIENTE2@empresa.com']);
  assert.deepEqual(g.cc, ['coordenador@empresa.com', 'analista@empresa.com', 'gestao@empresa.com']); // fixo repetido removido
  assert.ok(g.body.includes('Coordenador: Carla Coord') && g.body.includes('etapa Homologação E') && g.body.includes('ciclo Ciclo E-mail'));
  assert.ok(g.html.includes('<strong>Cliente Alfa</strong>'));
  assert.ok(g.warnings.some((w) => w.includes('Sem e-mail'))); // contato sem e-mail ignorado, avisado
  assert.equal(g.checklist.itemTitle, 'Enviar solicitação de backup ao cliente');
  S.g = g;
  const after = ok(await api('POST', `/api/projects/${S.p.id}/checklists/${inst.stepId}/open`, {})).instance.items.find((i) => i.id === S.it.id);
  assert.equal(after.done, false); assert.equal(after.status, 'pending'); // 20. gerar não conclui o item
  assert.equal(after.email.generations, 1); assert.ok(after.email.lastGeneration.at);
});

test('17–20. edição temporária e cópia: assunto, corpo e destinatários; o modelo não muda', async () => {
  const edited = { to: [...S.g.to, 'Extra@Cliente.com'], cc: S.g.cc, bcc: ['oculto@empresa.com'], subject: `${S.g.subject} — urgente`, body: `${S.g.body}\n\nObrigado!` };
  let r = ok(await api('POST', `/api/email-generations/${S.g.generationId}/copied`, { what: 'subject', ...edited, edited: true }));
  assert.deepEqual(r.copied, ['subject']);
  ok(await api('POST', `/api/email-generations/${S.g.generationId}/copied`, { what: 'body', ...edited, edited: true }));
  ok(await api('POST', `/api/email-generations/${S.g.generationId}/copied`, { what: 'to', ...edited }));
  r = ok(await api('POST', `/api/email-generations/${S.g.generationId}/copied`, { what: 'all', ...edited }));
  assert.deepEqual(r.copied, ['subject', 'body', 'to', 'all']);
  assert.equal((await api('POST', `/api/email-generations/${S.g.generationId}/copied`, { what: 'enviar' })).status, 400);
  const rec = ok(await api('GET', `/api/email-generations/${S.g.generationId}`));
  assert.equal(rec.subject, '[Cliente Alfa] Solicitação de Backup — urgente'); assert.ok(rec.body.endsWith('Obrigado!'));
  assert.deepEqual(rec.to, ['cliente1@empresa.com', 'CLIENTE2@empresa.com', 'Extra@Cliente.com']); assert.deepEqual(rec.bcc, ['oculto@empresa.com']);
  assert.equal(rec.edited, true); assert.ok(rec.copiedAt); assert.ok(rec.html.includes('Obrigado!'));
  // prévia do corpo editado: HTML seguro + texto puro (sem **)
  const pv = ok(await api('POST', '/api/emails/render', { body: '**Oi** <b>x</b>\n- item' }));
  assert.ok(pv.html.includes('<strong>Oi</strong>') && pv.html.includes('&lt;b&gt;') && pv.html.includes('<li>item</li>')); assert.ok(pv.text.startsWith('Oi <b>'));
  // o modelo permanece intacto
  const t = ok(await api('GET', '/api/email-templates')).templates.find((x) => x.id === S.t.id);
  assert.equal(t.subject, '[{{project.name}}] Solicitação de Backup'); assert.ok(!t.body.includes('Obrigado'));
});

test('histórico: gerado/copiado (nunca "enviado") e alterar o modelo não muda o passado', async () => {
  const h1 = ok(await api('GET', `/api/projects/${S.p.id}/emails`)).generations;
  assert.equal(h1.length, 1); assert.equal(h1[0].status, undefined); assert.equal(h1[0].gmailMessageId, undefined);
  ok(await api('PUT', `/api/email-templates/${S.t.id}`, { subject: 'Outro assunto {{project.name}}', body: 'Corpo novo', active: false }));
  const after = ok(await api('GET', `/api/email-generations/${S.g.generationId}`));
  assert.equal(after.subject, '[Cliente Alfa] Solicitação de Backup — urgente'); assert.ok(after.body.includes('Obrigado!')); assert.equal(after.templateName, 'Solicitação de Backup');
  assert.equal(ok(await api('GET', `/api/projects/${S.p.id}/emails`)).available.some((t) => t.id === S.t.id), false);
  assert.equal((await api('POST', `/api/projects/${S.p.id}/emails/generate`, { templateId: S.t.id })).status, 409); // desativado
  assert.equal((await api('DELETE', `/api/email-templates/${S.t.id}`)).json.code, 'EMAIL_TEMPLATE_IN_USE');
  ok(await api('PUT', `/api/email-templates/${S.t.id}`, { active: true }));
});

test('credenciais do Gmail da versão anterior: continuam até o usuário removê-las (ação explícita)', async () => {
  const file = path.join(tmp, 'data', 'projects.json');
  const st = ok(await api('GET', '/api/email-legacy-gmail'));
  assert.equal(st.stored, true); assert.equal(st.account, 'eu@gmail.com');
  assert.equal(JSON.stringify(st).includes('ENC-'), false); // nada secreto volta para a tela
  assert.equal(fs.readFileSync(file, 'utf8').includes('ENC-TOKEN'), true); // não foi apagado automaticamente
  assert.equal(ok(await api('DELETE', '/api/email-legacy-gmail')).stored, false);
  assert.equal(ok(await api('GET', '/api/email-legacy-gmail')).stored, false);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('ENC-TOKEN') || raw.includes('ENC-SECRETO'), false);
  assert.match(fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8'), /"action":"gmail-credenciais-removidas"/);
});

test('21–22, 25. garantia de não envio: nenhuma rede externa, nenhum código/rota de Gmail, SMTP ou mailto no gerador', async () => {
  // rotas de envio/Gmail não existem
  for (const [m, u] of [['GET', '/api/gmail'], ['POST', '/api/gmail/connect'], ['POST', `/api/projects/${S.p.id}/emails/send`], ['POST', `/api/projects/${S.p.id}/emails/prepare`], ['POST', `/api/projects/${S.p.id}/emails/attachments`]]) {
    assert.equal((await api(m, u, m === 'GET' ? undefined : {})).status, 404, `${m} ${u}`);
  }
  // nenhuma conexão para fora desta máquina durante TODO o fluxo acima
  assert.deepEqual(external, []);
  // o código do gerador não menciona nenhum mecanismo de envio
  const root = path.join(__dirname, '..');
  const forbidden = /gmail\.googleapis|googleapis\.com|messages\.send|drafts\.send|nodemailer|smtp|createTransport|mailto:|oauth2|sendMessage/i;
  for (const f of ['src/email.js', 'src/email-api.js', 'src/html-safe.js']) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/mailto:/g, ''), forbidden, f); // mailto: só como esquema permitido de LINK no texto
  // comms.js: nenhuma abertura automática de e-mail (o "mailto:" que aparece é só o esquema aceito ao inserir um link)
  const comms = fs.readFileSync(path.join(root, 'public/comms.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(comms.replace(/mailto:/g, ''), forbidden);
  assert.doesNotMatch(comms, /(window\.open|location(\.href)?\s*=)\s*\(?\s*[`'"]mailto/i);
  for (const f of ['src/gmail.js', 'src/gmail-api.js', 'src/mime.js', 'public/gmail.js']) assert.equal(fs.existsSync(path.join(root, f)), false, `${f} deveria ter sido removido`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /mailer|googleapis|google-auth/i.test(d)), false);
});

test('tokens/segredos nunca aparecem em log, histórico ou arquivo de dados; auditoria usa "gerado/copiado"', async () => {
  const audit = fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  assert.match(audit, /"action":"email-gerado"/); assert.match(audit, /"action":"email-copiado"/); assert.match(audit, /"action":"email-modelo-criado"/);
  assert.doesNotMatch(audit, /email-enviado|email-falhou|Bearer|refresh_token|client_secret/);
});

// ============================================================================================================
// Rich text, imagens, anexos sugeridos, recentes recolhidos e abas fixas
// ============================================================================================================
const H = require('../src/html-safe');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]);
const rawUpload = async (url, name, buf, type = 'image/png') => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-File-Name': encodeURIComponent(name), 'X-File-Type': type }, body: buf });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

test('sanitização: script, iframe, eventos, javascript: (inclusive com entidades) e imagens inseguras somem; é idempotente', () => {
  const bad = '<p onclick="x()">Oi <b>ok</b><script>alert(1)</script><iframe src="http://x"></iframe><a href="javascript:alert(1)">j</a><a href="jav&#x61;script:alert(2)">j2</a>'
    + '<a href="https://a.com/?q=1&b=2">ok</a><img src=x onerror=alert(1)><img src="data:image/svg+xml;base64,AAA"><span style="color:red;background:url(x);position:fixed;font-size:20px">s</span><!-- c --></p>';
  const out = H.sanitize(bad);
  assert.doesNotMatch(out, /script|iframe|onclick|onerror|javascript|svg|url\(|position|<!--/i);
  assert.match(out, /<b>ok<\/b>/); assert.match(out, /<a href="https:\/\/a\.com\/\?q=1&amp;b=2">ok<\/a>/); assert.match(out, /font-size:20px/);
  assert.equal(H.sanitize(out), out); // idempotente
  assert.ok(H.sanitize('<img src="/api/email-images/0123456789ab" width=100>').includes('/api/email-images/0123456789ab'));
});

test('modelo antigo (texto simples) continua válido: abre no editor com o mesmo visual e gera como sempre', async () => {
  const t = ok(await api('POST', '/api/email-templates', { name: 'Antigo texto', subject: 'Aviso {{project.name}}', body: 'Olá **Time**,\n- item um\n- item dois\nhttps://exemplo.com/x', to: ['role:stakeholders'] }));
  assert.equal(t.bodyHtml, undefined); // nada é migrado à força
  const view = ok(await api('GET', '/api/email-templates')).templates.find((x) => x.id === t.id);
  assert.match(view.editHtml, /<strong>Time<\/strong>/); assert.match(view.editHtml, /<ul><li>item um<\/li><li>item dois<\/li><\/ul>/); assert.match(view.editHtml, /<a href="https:\/\/exemplo\.com\/x">/);
  const g = ok(await api('POST', `/api/projects/${S.p.id}/emails/generate`, { templateId: t.id }));
  assert.match(g.html, /<strong>Time<\/strong>/); assert.match(g.html, /<li>item dois<\/li>/);
});

test('rich text: negrito, itálico, sublinhado, listas, links e variáveis dentro da formatação; html e text/plain coerentes', async () => {
  S.p2 = ok(await api('POST', '/api/projects', { name: 'Cia <Teste> & Filhos', coordinatorId: S.coord.id, analystId: S.anal.id, cycleId: S.cyc.id }));
  const html = '<p>Olá, <b>{{project.coordinator}}</b>!</p><p>O projeto <i>{{project.name}}</i> <u>entrou</u> na etapa <b>{{project.current_stage}}</b> {{project.start_date}}</p>'
    + '<ol><li>Backup</li><li>Base</li></ol><ul><li>Item <a href="https://x.com/a">site</a></li></ul><h2>Título</h2><p style="text-align:center">Centro</p><script>alert(1)</script>';
  S.rich = ok(await api('POST', '/api/email-templates', { name: 'Rich Backup', subject: '[{{project.name}}] Backup', bodyHtml: html, to: ['role:coordinator'], cc: [] }));
  assert.doesNotMatch(S.rich.bodyHtml, /script/); assert.match(S.rich.bodyHtml, /<b>\{\{project\.coordinator\}\}<\/b>/); // variável dentro de negrito preservada
  assert.match(S.rich.body, /- Item site \(https:\/\/x\.com\/a\)/); assert.match(S.rich.body, /1\. Backup/); // texto puro derivado
  assert.equal((await api('POST', '/api/email-templates', { name: 'Var ruim', subject: 's', bodyHtml: '<p>{{project.inventada}}</p>' })).status, 400); // variável desconhecida também no HTML
  assert.equal((await api('POST', '/api/email-templates', { name: 'Vazio', subject: 's', bodyHtml: '<p><br></p>' })).status, 400);
  const g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: S.rich.id }));
  assert.match(g.html, /<b>Carla Coord<\/b>/); assert.match(g.html, /<i>Cia &lt;Teste&gt; &amp; Filhos<\/i>/); // valores entram ESCAPADOS, tags intactas
  assert.match(g.html, /<u>entrou<\/u>/); assert.match(g.html, /<ol><li>Backup<\/li><li>Base<\/li><\/ol>/); assert.match(g.html, /<a href="https:\/\/x\.com\/a">site<\/a>/);
  assert.match(g.html, /text-align:center/); assert.doesNotMatch(g.html, /script/);
  assert.ok(g.html.startsWith('<div style="font-family:Arial')); // o MESMO html que a prévia mostra e a cópia usa
  assert.match(g.text, /Olá, Carla Coord!/); assert.match(g.text, /1\. Backup\n2\. Base/); assert.match(g.text, /- Item site \(https:\/\/x\.com\/a\)/); assert.doesNotMatch(g.text, /<\/?(b|i|u|p|ul|ol|li|h2)>|\*\*/); // sem tags nem marcas
  assert.ok(g.warnings.some((w) => /data de início/i.test(w))); // variável sem valor: marcador visível + aviso
  assert.match(g.html, /\{\{project\.start_date\}\}/);
  assert.equal(g.bodyHtml.includes('<div style="font-family'), false); // fragmento editável sem o invólucro
});

test('editar: rich → rich; editar só o texto (modelo/API antigos) descarta o HTML antigo', async () => {
  const ed = ok(await api('PUT', `/api/email-templates/${S.rich.id}`, { bodyHtml: '<p>Novo <b>corpo</b> {{project.name}}</p>' }));
  assert.match(ed.bodyHtml, /Novo <b>corpo<\/b>/); assert.equal(ed.body, 'Novo corpo {{project.name}}');
  assert.equal(ok(await api('PUT', `/api/email-templates/${S.rich.id}`, { subject: 'Só o assunto' })).bodyHtml.includes('Novo'), true); // outras edições preservam o corpo rico
  const txt = ok(await api('PUT', `/api/email-templates/${S.rich.id}`, { body: 'Voltou ao texto simples' }));
  assert.equal(txt.bodyHtml, undefined); assert.equal(txt.body, 'Voltou ao texto simples');
  ok(await api('PUT', `/api/email-templates/${S.rich.id}`, { bodyHtml: '<p>Olá <b>{{project.coordinator}}</b></p><img src="/api/email-images/0123456789ab">' }));
});

test('imagem no corpo: upload validado, servida pela aplicação, e na geração vira data URL (prévia = cópia); referência sem arquivo é avisada', async () => {
  assert.equal((await rawUpload('/api/email-images', 'x.exe', Buffer.from('MZ....'), 'application/octet-stream')).status, 400);
  assert.equal((await rawUpload('/api/email-images', 'grande.png', Buffer.concat([PNG, Buffer.alloc(2.2 * 1024 * 1024, 1)]))).status, 413);
  const up = await rawUpload('/api/email-images', 'explica.png', PNG);
  assert.equal(up.status, 200, JSON.stringify(up.json)); assert.match(up.json.url, /^\/api\/email-images\/[a-f0-9]{12}$/);
  const served = await fetch(base + up.json.url);
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png');
  const t = ok(await api('POST', '/api/email-templates', { name: 'Com imagem', subject: 'Img', bodyHtml: `<p>Veja:</p><img src="${up.json.url}" alt="explica" width="300"><img src="/api/email-images/aaaaaaaaaaaa">`, to: ['x@y.com'] }));
  assert.match(t.bodyHtml, new RegExp(up.json.url)); // o modelo guarda só a REFERÊNCIA (projects.json não incha)
  const g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: t.id }));
  assert.match(g.html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="explica" width="300">/); // a prévia já é o que será colado
  assert.equal(g.bodyHtml.includes('data:image'), false); assert.match(g.bodyHtml, new RegExp(up.json.url));
  assert.ok(g.warnings.some((w) => /imagem do modelo não foi encontrada/i.test(w))); assert.doesNotMatch(g.html, /aaaaaaaaaaaa/);
  assert.match(g.text, /\[imagem: explica\]/);
  S.imgT = t;
  const raw = fs.readFileSync(path.join(tmp, 'data', 'projects.json'), 'utf8');
  assert.equal(raw.includes('base64,'), false); // nenhuma imagem embutida no arquivo de dados
});

test('anexos sugeridos: referências a Documentos e Modelos (vários, nenhum, ausente, arquivo movido, link); nada é copiado nem enviado', async () => {
  const f1 = path.join(tmp, 'Relatorio_Final.xlsx'); const f2 = path.join(tmp, 'Instrucoes.pdf'); fs.writeFileSync(f1, 'x'); fs.writeFileSync(f2, 'y');
  const doc = async (title, source) => ok(await api('POST', '/api/documents', { title, kind: 'documento', source }));
  const d1 = await doc('Relatório Final', { type: 'file', path: f1 }); const d2 = await doc('Instruções', { type: 'file', path: f2 });
  const d3 = await doc('Documento sumido', { type: 'file', path: path.join(tmp, 'nao-existe.docx') }); const d4 = await doc('Guia online', { type: 'link', url: 'https://exemplo.com/guia' });
  const t = ok(await api('POST', '/api/email-templates', { name: 'Com anexos', subject: 'A', bodyHtml: '<p>Segue.</p>', to: ['x@y.com'], attachments: [{ documentId: d1.id }, d2.id, { documentId: d3.id }, { documentId: d4.id }, { documentId: d1.id }] }));
  assert.deepEqual(t.attachments.map((a) => a.title), ['Relatório Final', 'Instruções', 'Documento sumido', 'Guia online']); // duplicado ignorado; só referência + título
  assert.equal(JSON.stringify(t.attachments).includes(f1), false); // caminho não é copiado para o modelo
  let g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: t.id }));
  const by = Object.fromEntries(g.attachments.map((a) => [a.title, a]));
  assert.equal(by['Relatório Final'].name, 'Relatorio_Final.xlsx'); assert.equal(by['Relatório Final'].fileMissing, false); assert.equal(by['Relatório Final'].path, f1);
  assert.equal(by['Documento sumido'].fileMissing, true); assert.match(by['Documento sumido'].problem, /movido ou apagado/);
  assert.equal(by['Guia online'].sourceType, 'link'); assert.equal(by['Guia online'].url, 'https://exemplo.com/guia');
  assert.ok(g.warnings.some((w) => w.includes('Documento sumido'))); assert.ok(g.generationId);
  // documento excluído de Documentos e Modelos: a geração NÃO quebra; avisa e permite corrigir a referência
  ok(await api('DELETE', `/api/documents/${d2.id}`));
  g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: t.id }));
  const gone = g.attachments.find((a) => a.documentId === d2.id);
  assert.equal(gone.missing, true); assert.equal(gone.title, 'Instruções'); assert.ok(g.warnings.some((w) => /Documento não encontrado/i.test(w) && w.includes('Instruções')));
  const fixed = ok(await api('PUT', `/api/email-templates/${t.id}`, { attachments: [{ documentId: d1.id }] })); // corrigir = trocar/remover a referência
  assert.deepEqual(fixed.attachments.map((a) => a.title), ['Relatório Final']);
  assert.deepEqual(ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: S.rich.id })).attachments, []); // modelo sem anexo
  assert.equal((await api('POST', '/api/email-templates', { name: 'Anexos demais', subject: 'A', bodyHtml: '<p>x</p>', attachments: Array.from({ length: 11 }, (_, i) => ({ documentId: `d${i}` })) })).status, 400);
  assert.equal(fs.readFileSync(f1, 'utf8'), 'x'); // os arquivos ficam onde estão
  const hist = ok(await api('GET', `/api/email-generations/${g.generationId}`));
  assert.deepEqual(hist.attachments.map((a) => a.title).sort(), ['Documento sumido', 'Guia online', 'Instruções', 'Relatório Final'].sort().filter((x) => x !== 'Instruções' || true)); // fotografia do que era sugerido
  assert.ok(hist.attachmentsInfo.some((a) => a.missing));
});

test('copiar corpo e copiar tudo: a cópia registra o HTML sanitizado e o texto; o histórico mostra o mesmo conteúdo', async () => {
  const g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: S.rich.id }));
  const r = ok(await api('POST', `/api/email-generations/${g.generationId}/copied`, { what: 'body', bodyHtml: '<p>Editado <b>forte</b><script>x</script></p>', edited: true }));
  assert.deepEqual(r.copied, ['body']);
  ok(await api('POST', `/api/email-generations/${g.generationId}/copied`, { what: 'all' }));
  const rec = ok(await api('GET', `/api/email-generations/${g.generationId}`));
  assert.equal(rec.body, 'Editado forte'); assert.match(rec.bodyHtml, /<b>forte<\/b>/); assert.doesNotMatch(rec.bodyHtml, /script/);
  assert.match(rec.html, /<b>forte<\/b>/); assert.deepEqual(rec.copied, ['body', 'all']); assert.equal(rec.edited, true);
  // render (edição na tela): devolve o mesmo html/texto que a prévia e a cópia usam
  const rn = ok(await api('POST', '/api/emails/render', { bodyHtml: '<p>a <i>b</i><iframe src=x></iframe></p><ul><li>c</li></ul>' }));
  assert.match(rn.html, /<i>b<\/i>/); assert.doesNotMatch(rn.html, /iframe/); assert.equal(rn.text, 'a b\n\n- c');
  assert.equal(ok(await api('POST', '/api/emails/sanitize', { html: '<b onclick=1>x</b><script>1</script>' })).html, '<b>x</b>');
  assert.equal(JSON.stringify(ok(await api('GET', '/api/email-generations'))).includes('base64,'), false);
});

test('tela: copiar com text/html + text/plain (ClipboardItem), recentes recolhidos por padrão, abas de Configurações fixas', () => {
  const root = path.join(__dirname, '..', 'public');
  const comms = fs.readFileSync(path.join(root, 'comms.js'), 'utf8');
  assert.match(comms, /new ClipboardItem\(\{[^\n]*'text\/plain'[^\n]*'text\/html'/); // rich + texto, com plano B para texto puro
  assert.match(comms, /navigator\.clipboard\.writeText/); assert.match(comms, /document\.execCommand\('copy'\)/);
  assert.match(comms, /uiPref\('emRecentOpen', false\)/); assert.match(comms, /uiPref\('emHistOpen', false\)/); // recolhidos por padrão (a escolha é lembrada)
  assert.doesNotMatch(comms, /\balert\(/); // feedback por toast
  assert.match(comms, /toast\(`\$\{label\} copiado/);
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.page > \.tabs\.settings-tabs \{[^}]*position: sticky;[^}]*top: 0;[^}]*z-index: 6;[^}]*background: var\(--bg\)/);
  assert.match(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), /class: 'tabs settings-tabs'/);
});

test('{{greeting}}: saudação pelo horário local da geração (faixas centralizadas, relógio controlado)', () => {
  const at = (hh, mm) => new Date(2026, 9, 2, hh, mm, 0); // horário LOCAL controlado (não depende do relógio real)
  const cases = [[5, 0, 'Bom dia'], [11, 59, 'Bom dia'], [12, 0, 'Boa tarde'], [17, 59, 'Boa tarde'], [18, 0, 'Boa noite'], [23, 59, 'Boa noite'], [0, 0, 'Boa noite'], [4, 59, 'Boa noite'], [9, 0, 'Bom dia'], [15, 0, 'Boa tarde'], [20, 0, 'Boa noite']];
  for (const [hh, mm, want] of cases) assert.equal(M.greetingFor(at(hh, mm)), want, `${hh}:${mm}`);
  assert.ok(M.publicVariables().some((v) => v.key === 'greeting' && v.group === 'Geral')); // aparece na lista da tela junto com as demais
  assert.deepEqual(M.unknownVariables('{{greeting}}, {{ GREETING }}'), []); // é uma variável conhecida (o modelo pode ser salvo)

  const data = { coordinators: [{ id: 'c', name: 'Carla', email: 'c@x.com' }], stages: [], projectTypes: [], cycles: [], originSystems: [] };
  const project = { id: 'p', name: 'Cliente Alfa', coordinatorId: 'c', steps: [], contacts: [] };
  const ctx = (hh) => M.contextFor(data, project, { now: at(hh, 0) });
  // modelo de texto, junto com outras variáveis
  const plain = { subject: '{{greeting}} — {{project.name}}', body: '{{greeting}}, {{project.coordinator}}.\n\nPrecisamos validar o projeto {{project.name}} ({{today}}).', to: [], cc: [], bcc: [] };
  assert.equal(M.generate(plain, ctx(9)).body, 'Bom dia, Carla.\n\nPrecisamos validar o projeto Cliente Alfa (02/10/2026).');
  assert.equal(M.generate(plain, ctx(15)).subject, 'Boa tarde — Cliente Alfa');
  assert.match(M.generate(plain, ctx(20)).body, /^Boa noite, Carla\./);
  // rich text: formatação, link, lista, imagem e demais variáveis intactos
  const rich = { subject: 's', body: '', to: [], cc: [], bcc: [],
    bodyHtml: '<p><b>{{greeting}}</b>, <i>{{project.coordinator}}</i>.</p><ul><li>{{greeting}} item</li></ul><p><a href="https://x.com/a">guia</a> <img src="/api/email-images/abcdefabcdef" alt=""></p>' };
  const g = M.generate(rich, ctx(15));
  assert.equal(g.bodyHtml, '<p><b>Boa tarde</b>, <i>Carla</i>.</p><ul><li>Boa tarde item</li></ul><p><a href="https://x.com/a">guia</a> <img src="/api/email-images/abcdefabcdef" alt=""></p>');
  assert.match(g.body, /^Boa tarde, Carla\./); assert.deepEqual(g.missingVariables, []); assert.deepEqual(g.warnings.filter((w) => /saudação|greeting/i.test(w)), []);
  // sem efeito colateral: o modelo guarda só a variável; demais variáveis seguem iguais
  assert.match(rich.bodyHtml, /\{\{greeting\}\}/);
  const v = M.variableValues(ctx(9)); assert.equal(v['project.name'], 'Cliente Alfa'); assert.equal(v['project.coordinator'], 'Carla'); assert.equal(v.today, '02/10/2026'); assert.equal(v.greeting, 'Bom dia');
});

test('{{greeting}} pela API: salvar modelo mantém a variável; a geração resolve no momento', async () => {
  const t = ok(await api('POST', '/api/email-templates', { name: 'Saudação', subject: 'Oi', bodyHtml: '<p><b>{{greeting}}</b>, {{project.coordinator}}.</p>', to: [], cc: [] }));
  assert.match(t.bodyHtml, /<b>\{\{greeting\}\}<\/b>/); // nunca "Bom dia" gravado no modelo
  const g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: t.id }));
  assert.match(g.html, /<b>(Bom dia|Boa tarde|Boa noite)<\/b>, Carla Coord\./); assert.doesNotMatch(g.html, /\{\{greeting\}\}/);
  const cat = ok(await api('GET', '/api/email-templates'));
  assert.ok(cat.variables.some((x) => x.key === 'greeting'));
});

test('Abrir no Gmail: URL de composição com Para/CC/CCO/Assunto codificados; o corpo NUNCA vai na URL; entradas ruins tratadas', async () => {
  const dec = (url) => Object.fromEntries(new URL(url).searchParams.entries());
  const BASE = 'https://mail.google.com/mail/?view=cm&fs=1';
  // vários Para/CC e CCO, assunto com acentos e caracteres especiais: ida e volta idêntica
  const subject = 'Reunião de validação: 50% & “café” #1 +a =b? ção — Cliente Alfa';
  const r = M.buildGmailComposeUrl({ to: ['ana@cli.com', 'bia@cli.com', 'caio@cli.com'], cc: ['d@x.com', 'e@x.com'], bcc: ['oculto@x.com'], subject });
  assert.ok(r.url.startsWith(BASE)); assert.deepEqual(dec(r.url), { view: 'cm', fs: '1', to: 'ana@cli.com,bia@cli.com,caio@cli.com', cc: 'd@x.com,e@x.com', bcc: 'oculto@x.com', su: subject });
  assert.doesNotMatch(r.url, /[?&]body=/); assert.doesNotMatch(r.url, /[“”ãçé ]/); // tudo codificado, nada de espaço/acento cru
  // Para vazio, CC vazio, CCO vazio, sem assunto: só o que existe vai na URL
  assert.equal(M.buildGmailComposeUrl({}).url, BASE);
  assert.deepEqual(dec(M.buildGmailComposeUrl({ to: [], cc: [], bcc: [], subject: '' }).url), { view: 'cm', fs: '1' });
  assert.deepEqual(dec(M.buildGmailComposeUrl({ cc: ['d@x.com'] }).url), { view: 'cm', fs: '1', cc: 'd@x.com' }); // Para vazio
  assert.ok(M.buildGmailComposeUrl({ subject: 'só assunto' }).warnings.some((w) => /Nenhum destinatário em “Para”/.test(w)));
  // separadores ; , espaço, repetidos (sem diferenciar maiúsculas), inválidos e limite por campo
  const m = M.buildGmailComposeUrl({ to: 'a@x.com; b@x.com, c@x.com   A@X.COM', cc: ['Fulano <f>', 'ok@x.com', 'sem-arroba'], subject: 'Linha 1\nLinha 2\r\nLinha 3' });
  assert.deepEqual(dec(m.url).to.split(','), ['a@x.com', 'b@x.com', 'c@x.com']); assert.equal(dec(m.url).cc, 'ok@x.com');
  assert.equal(dec(m.url).su, 'Linha 1 Linha 2 Linha 3'); assert.ok(m.warnings.some((w) => /inválido\(s\).*Fulano.*sem-arroba/.test(w)));
  const many = M.buildGmailComposeUrl({ to: Array.from({ length: 45 }, (_, i) => `u${i}@x.com`) });
  assert.equal(dec(many.url).to.split(',').length, 30);
  assert.equal(dec(M.buildGmailComposeUrl({ subject: 'x'.repeat(400) }).url).su.length, 250); // assunto grande
  // mesma regra pela API (a tela usa a rota) e histórico aceita “gmail”
  const viaApi = ok(await api('POST', '/api/emails/gmail-url', { to: ['ana@cli.com'], cc: [], bcc: [], subject: 'Olá ção' }));
  assert.deepEqual(dec(viaApi.url), { view: 'cm', fs: '1', to: 'ana@cli.com', su: 'Olá ção' });
  assert.equal(ok(await api('POST', '/api/emails/gmail-url', {})).url, BASE);
  // é só uma URL: nenhuma rota de envio ou de abertura pelo servidor foi criada
  for (const u of ['/api/emails/send', '/api/emails/open-gmail', '/api/gmail']) assert.equal((await api('POST', u, {})).status, 404, u);
});

test('tabelas: preservadas (estrutura, bordas, colspan, variáveis), saneadas e convertidas para texto; malformadas corrigidas', async () => {
  const H = require('../src/html-safe');
  const table = '<table border="1" cellpadding="4" width="100%" style="border-collapse:collapse;border:1px solid #999999"><thead><tr><th style="background-color:#eeeeee;padding:4px 8px">Item</th><th colspan="2">Valor</th></tr></thead>'
    + '<tbody><tr><td style="border:1px solid #999999;text-align:right">{{project.name}}</td><td><b>1</b></td><td>2</td></tr></tbody></table>';
  const s = H.sanitize(table);
  assert.equal(s, table); assert.equal(H.sanitize(s), s); // nada válido é perdido e é idempotente
  assert.equal(H.htmlToText(s), 'Item | Valor\n{{project.name}} | 1 | 2');
  assert.equal(H.sanitize('<table><tr><td>a<td>b<tr><td>c<td>d</table>'), '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'); // sem fechar tags
  const evil = H.sanitize('<table onclick="x()" style="background:url(javascript:1);border:1px solid url(x);position:absolute;width:9999px"><tr><td onmouseover="y()" colspan="99" style="border:1px dashed red;padding:2px 4px"><script>alert(1)</script>ok<iframe src=x></iframe></td></tr></table>');
  assert.equal(evil, '<table><tr><td style="border:1px dashed red;padding:2px 4px">ok</td></tr></table>');
  assert.equal(H.sanitize('<table><tr><td style="border:.5pt solid windowtext;padding:0 5.4pt" width=64>x</td></tr></table>'), '<table><tr><td width="64" style="border:.5pt solid #000000;padding:0 5.4pt">x</td></tr></table>'); // colado do Excel/Word
  // modelo com tabela: variável dentro da célula (escapada), HTML idêntico na prévia/cópia e texto com colunas
  const t = ok(await api('POST', '/api/email-templates', { name: 'Com tabela', subject: 'Tabela', bodyHtml: `<p>Resumo:</p>${table}<p>Fim</p>`, to: ['x@y.com'] }));
  assert.match(t.bodyHtml, /<table border="1"/);
  const g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: t.id }));
  assert.match(g.html, /<td style="border:1px solid #999999;text-align:right">Cia &lt;Teste&gt; &amp; Filhos<\/td>/); assert.match(g.html, /<th colspan="2">Valor<\/th>/);
  assert.match(g.text, /Item \| Valor\nCia <Teste> & Filhos \| 1 \| 2/);
  S.tableT = t;
});

test('e-mail rico completo: parágrafos, negrito/itálico/sublinhado, link, listas, tabela, várias imagens e variáveis → um HTML (prévia = cópia) + texto puro + URL do Gmail', async () => {
  const up1 = await rawUpload('/api/email-images', 'um.png', PNG); const up2 = await rawUpload('/api/email-images', 'dois.png', Buffer.concat([PNG, Buffer.alloc(8, 2)]));
  const html = `<p>{{greeting}}, <b>{{project.coordinator}}</b>!</p><p>Linha <i>itálica</i> e <u>sublinhada</u> com <a href="https://exemplo.com/a?x=1&y=2">link</a>.<br>Segunda linha com acentos: ação, coração, não.</p>`
    + `<ul><li>Um</li><li>Dois</li></ul><ol><li>Primeiro</li></ol><table style="border-collapse:collapse"><tr><th style="border:1px solid #999999">Col</th></tr><tr><td style="border:1px solid #999999">v</td></tr></table>`
    + `<p><img src="${up1.json.url}" alt="um" width="200"> <img src="${up2.json.url}" alt="dois"></p><p style="text-align:center;color:#ff0000;font-size:18px">Centro vermelho</p>`;
  const t = ok(await api('POST', '/api/email-templates', { name: 'Rico completo', subject: '{{greeting}} — [{{project.name}}] Validação', bodyHtml: html, to: ['role:coordinator', 'ana@cli.com'], cc: ['role:analyst'], bcc: ['oculto@x.com'] }));
  const g = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: t.id }));
  const rich = [/<b>Carla Coord<\/b>/, /<i>itálica<\/i>/, /<u>sublinhada<\/u>/, /<a href="https:\/\/exemplo\.com\/a\?x=1&amp;y=2">link<\/a>/, /<ul><li>Um<\/li><li>Dois<\/li><\/ul>/, /<ol><li>Primeiro<\/li><\/ol>/, /<table style="border-collapse:collapse">/,
    /<th style="border:1px solid #999999">Col<\/th>/, /ação, coração, não/, /text-align:center;color:#ff0000;font-size:18px/];
  for (const re of rich) assert.match(g.html, re, String(re));
  assert.equal((g.html.match(/<img src="data:image\/png;base64,/g) || []).length, 2); // as duas imagens vão dentro do HTML da cópia
  assert.match(g.html, /^<div style="font-family:Arial/); assert.match(g.text, /^(Bom dia|Boa tarde|Boa noite), Carla Coord!/);
  assert.match(g.text, /Col\nv/); assert.match(g.text, /\[imagem: um\] \[imagem: dois\]/); assert.doesNotMatch(g.text, /<\/?[a-z]/i); // texto puro sem tags
  // a URL do Gmail usa os valores finais (coordenador e analista já resolvidos; CCO) e não carrega o corpo
  const u = ok(await api('POST', '/api/emails/gmail-url', { to: g.to, cc: g.cc, bcc: g.bcc, subject: g.subject }));
  const q = Object.fromEntries(new URL(u.url).searchParams.entries());
  assert.deepEqual(q.to.split(','), g.to); assert.equal(q.bcc, 'oculto@x.com'); assert.equal(q.su, g.subject); assert.ok(g.to.includes('ana@cli.com'));
  assert.equal('body' in q, false); assert.ok(u.url.length < 2000);
  // corpo grande: o HTML cresce, a URL não (o corpo não está nela)
  const big = ok(await api('POST', '/api/email-templates', { name: 'Corpo grande', subject: 'Grande', bodyHtml: `<p>${'Parágrafo longo com acentuação ção. '.repeat(400)}</p>`, to: ['x@y.com'] }));
  const gb = ok(await api('POST', `/api/projects/${S.p2.id}/emails/generate`, { templateId: big.id }));
  assert.ok(gb.html.length > 10000); assert.ok(ok(await api('POST', '/api/emails/gmail-url', { to: gb.to, cc: gb.cc, bcc: gb.bcc, subject: gb.subject })).url.length < 400);
  // histórico: abrir no Gmail é registrado como “gmail” (não é envio)
  const c = ok(await api('POST', `/api/email-generations/${g.generationId}/copied`, { what: 'gmail', to: g.to, cc: g.cc, bcc: g.bcc, subject: g.subject, bodyHtml: g.bodyHtml }));
  assert.ok(c.copied.includes('gmail'));
});

test('tela “Abrir no Gmail”: ordem copiar → URL do servidor → abrir; avisos amigáveis; sem automação do Gmail nem segredos', () => {
  const root = path.join(__dirname, '..');
  const comms = fs.readFileSync(path.join(root, 'public/comms.js'), 'utf8');
  assert.match(comms, /'Abrir no Gmail'/); assert.match(comms, /'Copiar corpo formatado'/);
  const fn = comms.slice(comms.indexOf('const gmailBox'), comms.indexOf('const row = (label'));
  assert.ok(fn.indexOf('emCopy(plain, st.html)') > 0 && fn.indexOf('emCopy(plain, st.html)') < fn.indexOf('/api/emails/gmail-url') && fn.indexOf('/api/emails/gmail-url') < fn.indexOf('window.open(g.url')); // copia primeiro, depois abre
  assert.match(fn, /Gmail aberto\. O corpo formatado foi copiado para a área de transferência\. Cole-o no corpo da mensagem com Ctrl\+V\./);
  assert.match(fn, /O Gmail foi aberto, mas não foi possível copiar o conteúdo formatado\. Utilize “Copiar corpo formatado” para tentar novamente\./);
  assert.match(fn, /try \{ window\.open/); assert.match(fn, /Abrir o Gmail de novo/); // falha ao abrir o navegador não é erro fatal: aviso + link
  assert.doesNotMatch(fn, /\balert\(/);
  assert.doesNotMatch(comms, /mail\.google\.com/); // a URL nasce em um lugar só: o servidor
  assert.match(comms, /return 'rich'/); assert.match(comms, /new ClipboardItem\(\{[^\n]*'text\/plain'[^\n]*'text\/html'/);
  // nenhuma automação do navegador/Gmail nem biblioteca de envio
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /selenium|puppeteer|playwright|nodemailer|googleapis|google-auth/i.test(d)), false);
  const code = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\/[^\n]*/g, '');
  for (const f of ['src/email.js', 'src/email-api.js', 'public/comms.js', 'main.js']) assert.doesNotMatch(code(f), /selenium|puppeteer|playwright|chrome-remote|webdriver|gmail\.send/i, f);
  for (const f of ['src/email.js', 'public/comms.js', 'main.js']) assert.doesNotMatch(code(f), /clientSecret|refresh_token|client_secret/i, f); // (email-api.js só DETECTA credenciais antigas para o usuário removê-las)
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8'); // segurança do Electron intacta e sem preload novo
  assert.match(main, /contextIsolation: true/); assert.match(main, /nodeIntegration: false/); assert.equal(/preload/.test(main), false);
});

test('rodada rich text: nenhuma chamada externa e nenhuma imagem/HTML de envio', () => {
  assert.deepEqual(external, []);
});
