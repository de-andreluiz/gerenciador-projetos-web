// Fase 3b — arquivos no modo NUVEM pelas rotas do app (PGlite + migrations reais + RLS do Storage):
// evidências e imagens de e-mail cifradas no Storage; conteúdo dos scripts em script_versions com cópia de trabalho local;
// evidências de horas continuam locais; referências antigas (não migradas) não quebram a tela; cópia decifrada temporária some no logout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cloudfiles-'));
const PORT = 4458;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app, store } = require('../server');
const { createCloud } = require('./helpers/pglite-cloud');
const { CloudBackend } = require('../src/persistence/cloud-backend');
const { KeyService } = require('../src/persistence/keys');
const { LocalUserData } = require('../src/persistence/local-user-data');
const { fixture } = require('./fixtures/cloud-fixture');

let server;
let cloud;
const U = {};
const LOCAL = path.join(tmp, 'local');
const base = `http://localhost:${PORT}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('CONTEUDO_CONFIDENCIAL_PRINT'), Buffer.alloc(64, 7)]);
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const upload = async (url, name, buf, type = 'image/png') => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-File-Name': encodeURIComponent(name), 'X-File-Type': type }, body: buf });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const getBytes = async (url) => { const r = await fetch(base + url); return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()), json: r.ok ? null : await Promise.resolve(null) }; };
const backendFor = (uid) => {
  const transport = cloud.transport(uid);
  return new CloudBackend({ transport, keys: new KeyService((s, c) => transport.fetchKeys(s, c)), local: new LocalUserData(uid, LOCAL), userId: uid });
};
const as = (uid) => store.attach(backendFor(uid));

test.before(async () => {
  cloud = await createCloud();
  U.master = await cloud.user('master', { master: true });
  U.viewer = await cloud.user('viewer');
  U.editor = await cloud.user('editor');
  U.outsider = await cloud.user('outsider');
  await cloud.provision(U.master, U.viewer, { permissions: [] });
  await cloud.provision(U.master, U.editor, { permissions: ['config.scripts.manage'] });
  await cloud.provision(U.master, U.outsider, { permissions: ['projects.create'] });
  server = app.listen(PORT, '127.0.0.1');
  await as(U.master);
  store._replace(fixture());
  await store.save();
  await cloud.sqlAs(U.master, "select public.project_set_access('p1', $1, 'viewer')", [U.viewer]);
  await cloud.sqlAs(U.master, "select public.project_set_access('p1', $1, 'editor')", [U.editor]);
});
test.after(async () => { server.close(); await cloud.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const S = {};
const evidenceIds = async () => (await api('GET', '/api/projects/p1/checklists')).json;

test('evidência: upload pela rota de sempre → Storage só com ciphertext em <projeto>/<id>; metadado com referência cifrada', async () => {
  const r = await upload('/api/projects/p1/checklists/cy-1/items/ii-1/evidence', 'print SENSIVEL.png', PNG);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ev = r.json.instance.items.find((i) => i.id === 'ii-1').evidences.find((e) => e.name === 'print SENSIVEL.png');
  assert.ok(ev && ev.exists);
  S.ev = ev.id;
  const key = `evidence/p1/${ev.id}`;
  assert.ok(cloud.objects.has(key), 'objeto em <projeto>/<evidência>, sem nome de arquivo');
  const blob = cloud.objects.get(key);
  assert.equal(blob.subarray(0, 4).toString(), 'GPF1');
  assert.ok(!blob.includes(Buffer.from('CONTEUDO_CONFIDENCIAL')) && !blob.includes(PNG.subarray(0, 8)), 'nada do original no Storage');
  const row = (await cloud.sql("select doc::text d from public.project_checklists where project_id = 'p1' and step_id = 'cy-1'"))[0];
  assert.ok(!row.d.includes('sb:evidence') && !row.d.includes('SENSIVEL'), 'referência e nome só no envelope cifrado');
  const cached = fs.readdirSync(path.join(LOCAL, 'users', U.master, 'cache', 'files', 'evidence'));
  assert.ok(cached.length >= 1);
  for (const f of cached) assert.ok(!fs.readFileSync(path.join(LOCAL, 'users', U.master, 'cache', 'files', 'evidence', f)).includes(Buffer.from('CONTEUDO_CONFIDENCIAL')), 'cache local só com ciphertext');
});

test('evidência: visualizar devolve o original (tipo e cabeçalhos seguros); referência antiga não migrada → 404 claro', async () => {
  const g = await getBytes(`/api/projects/p1/evidences/${S.ev}/file?inline=1`);
  assert.equal(g.status, 200);
  assert.equal(g.type, 'image/png');
  assert.deepEqual(g.buf, PNG);
  const old = await fetch(`${base}/api/projects/p1/evidences/e1/file`); // evidência do fixture com caminho local
  assert.equal(old.status, 404);
  const body = await old.json();
  assert.equal(body.code, 'FILE_NOT_FOUND'); assert.match(body.error, /não foi migrado/);
});

test('abrir no Windows: cópia decifrada temporária na pasta do usuário (o programa padrão precisa do arquivo)', async () => {
  const p = store.project('p1');
  const ev = p.checklists.find((c) => c.stepId === 'cy-1').items[0].evidences.find((e) => e.id === S.ev);
  S.tempFile = await store.files('evidence').openPath(ev.file, ev.name);
  assert.ok(S.tempFile.startsWith(path.join(LOCAL, 'users', U.master, 'tmp-open')));
  assert.deepEqual(fs.readFileSync(S.tempFile), PNG);
});

test('viewer: vê a evidência; anexar é recusado pelo RLS do Storage (403) e nada é gravado', async () => {
  await as(U.viewer);
  assert.ok(!fs.existsSync(S.tempFile), 'troca de sessão apaga as cópias temporárias decifradas da sessão anterior');
  assert.deepEqual((await getBytes(`/api/projects/p1/evidences/${S.ev}/file`)).buf, PNG);
  const before = cloud.objects.size;
  const r = await upload('/api/projects/p1/checklists/cy-1/items/ii-1/evidence', 'outra.png', PNG);
  assert.equal(r.status, 403); assert.equal(r.json.code, 'FORBIDDEN');
  assert.equal(cloud.objects.size, before);
});

test('sem acesso ao projeto: nem baixar o objeto direto do Storage (RLS) nem receber a chave', async () => {
  const outsider = backendFor(U.outsider);
  await outsider.load();
  await assert.rejects(outsider.files('evidence').read(`sb:evidence/p1/${S.ev}`), { code: 'NOT_FOUND' });
  await assert.rejects(outsider.transport.storageDownload('evidence', `p1/${S.ev}`), { code: 'NOT_FOUND' });
  await outsider.keys.ensure(['project:p1'], { create: true });
  assert.equal(outsider.keys.ring.has('project:p1'), false, 'a DEK do projeto não é entregue a quem não lê o projeto');
});

test('remover evidência: sai dos metadados; o objeto cifrado permanece no Storage (nunca apagar — ADR-009)', async () => {
  await as(U.master);
  const r = await api('DELETE', `/api/projects/p1/evidences/${S.ev}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!store.project('p1').checklists.find((c) => c.stepId === 'cy-1').items[0].evidences.some((e) => e.id === S.ev));
  assert.ok(cloud.objects.has(`evidence/p1/${S.ev}`));
});

test('imagens de e-mail: cifradas no bucket email-images; o e-mail gerado embute a imagem decifrada; limite conferido antes do upload', async () => {
  const r = await upload('/api/email-images', 'logo.png', PNG);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const key = `email-images/${r.json.id}`;
  assert.ok(cloud.objects.has(key));
  assert.ok(!cloud.objects.get(key).includes(Buffer.from('CONTEUDO_CONFIDENCIAL')));
  assert.deepEqual((await getBytes(`/api/email-images/${r.json.id}`)).buf, PNG);
  const out = await api('POST', '/api/emails/render', { bodyHtml: `<p>Olá</p><p><img src="/api/email-images/${r.json.id}" alt="logo"></p>` });
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.ok(out.json.html.includes(`data:image/png;base64,${PNG.toString('base64')}`));
  const before = cloud.objects.size;
  const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(3 * 1024 * 1024, 1)]);
  const tooBig = await upload('/api/email-images', 'grande.png', big);
  assert.equal(tooBig.status, 413); assert.match(tooBig.json.error, /limite no e-mail/);
  assert.equal(cloud.objects.size, before, 'nada grande demais chega ao Storage');
});

test('scripts: conteúdo em script_versions (uma linha por versão); listar, ler, editar e variáveis pelas rotas de sempre', async () => {
  const c = await api('POST', '/api/scripts', { name: 'Ajuste Cloud', content: 'SELECT {{TABELA}} FROM dbo.X;' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  S.script = c.json;
  assert.equal(c.json.storage, 'cloud'); assert.equal(c.json.exists, true);
  const e = await api('PUT', `/api/scripts/${S.script.id}`, { name: 'Ajuste Cloud', description: 'v2', content: 'SELECT 2 FROM dbo.{{TABELA}};' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const versions = await cloud.sql('select version, content from public.script_versions where script_id = $1 order by version', [S.script.id]);
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  assert.equal(versions[1].content, 'SELECT 2 FROM dbo.{{TABELA}};');
  assert.equal((await api('GET', `/api/scripts/${S.script.id}`)).json.content, 'SELECT 2 FROM dbo.{{TABELA}};');
  assert.deepEqual((await api('GET', `/api/scripts/${S.script.id}/variables`)).json.user, ['TABELA']);
  const list = (await api('GET', '/api/scripts')).json;
  assert.equal(list.find((s) => s.id === S.script.id).analysis.batches, 1);
  assert.equal(list.find((s) => s.id === 'sc-1').exists, false, 'script do fixture sem conteúdo migrado aparece como ausente');
});

test('scripts: cópia de trabalho para SSMS/VS Code → "Enviar alterações" cria a versão 3; edição local nunca é sobrescrita', async () => {
  const s = store.data.scripts.find((x) => x.id === S.script.id);
  const wc = await store.scripts().openPath(s);
  assert.ok(wc.startsWith(path.join(LOCAL, 'users', U.master, 'scripts')));
  fs.writeFileSync(wc, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('SELECT 3 FROM dbo.{{TABELA}};\r\n')]));
  assert.equal((await store.scripts().openPath(s)), wc);
  assert.match(fs.readFileSync(wc, 'utf8'), /SELECT 3/, 'abrir de novo não apaga a edição pendente');
  const listed = (await api('GET', '/api/scripts')).json.find((x) => x.id === s.id);
  assert.deepEqual(listed.workingCopy, { changed: true, stale: false });
  const p = await api('POST', `/api/scripts/${s.id}/push`);
  assert.equal(p.status, 200, JSON.stringify(p.json)); assert.equal(p.json.pushed, true);
  assert.equal((await cloud.sql('select max(version)::int v from public.script_versions where script_id = $1', [s.id]))[0].v, 3);
});

test('scripts: conflito — outra pessoa salvou depois que a cópia foi aberta → 409, nada sobrescrito; corrida na mesma versão → 409', async () => {
  const s = store.data.scripts.find((x) => x.id === S.script.id);
  const wc = await store.scripts().openPath(s);
  const editor = backendFor(U.editor);
  await editor.load();
  await editor.scripts().write(s, 'SELECT 4 FROM dbo.X; -- editor');
  fs.writeFileSync(wc, 'SELECT 5 FROM dbo.X; -- master\r\n');
  const p = await api('POST', `/api/scripts/${s.id}/push`);
  assert.equal(p.status, 409); assert.equal(p.json.code, 'SCRIPT_WC_CONFLICT');
  assert.match((await api('GET', `/api/scripts/${s.id}`)).json.content, /editor/);
  // duas máquinas gravando a MESMA próxima versão: a segunda recebe STALE (chave duplicada)
  const late = editor.scripts();
  const real = late._latest.bind(late);
  late._latest = async (id) => ({ ...(await real(id, { fresh: true })), version: 3 }); // enxerga a versão 3 (velha)
  await assert.rejects(late.write(s, 'SELECT 6;'), { code: 'STALE' });
});

test('scripts: viewer sem config.scripts.manage não grava conteúdo (403) e o cadastro em memória não muda', async () => {
  await as(U.viewer);
  const r = await api('PUT', `/api/scripts/${S.script.id}`, { name: 'Renomeado indevido', description: '', content: 'SELECT 7;' });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'FORBIDDEN');
  assert.equal(store.data.scripts.find((x) => x.id === S.script.id).name, 'Ajuste Cloud');
});

test('remover script: cópia recuperável fica nesta máquina (.removidos)', async () => {
  await as(U.master);
  const r = await api('DELETE', `/api/scripts/${S.script.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const dir = path.join(LOCAL, 'users', U.master, 'scripts', '.removidos');
  const kept = fs.readdirSync(dir);
  assert.equal(kept.length, 1);
  assert.match(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), /editor/);
});

test('evidências das observações de horas continuam locais no modo nuvem (pasta do usuário, nada no Storage)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const n = await api('POST', '/api/hours/notes', { dates: [today], title: 'Obs', description: 'x', category: 'info' });
  assert.equal(n.status, 200, JSON.stringify(n.json));
  const before = cloud.objects.size;
  const up = await upload(`/api/hours/notes/${n.json.note.id}/evidence`, 'h.png', PNG);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(cloud.objects.size, before);
  assert.ok(fs.existsSync(path.join(LOCAL, 'users', U.master, 'evidencias', 'horas')));
});

test('logout: cópias decifradas temporárias são apagadas', async () => {
  const ev = store.project('p1').checklists.find((c) => c.stepId === 'cy-1').items[0];
  const r = await upload('/api/projects/p1/checklists/cy-1/items/ii-1/evidence', 'ultima.png', PNG);
  const id = r.json.instance.items.find((i) => i.id === ev.id).evidences.find((e) => e.name === 'ultima.png').id;
  const ref = store.project('p1').checklists.find((c) => c.stepId === 'cy-1').items[0].evidences.find((e) => e.id === id).file;
  const temp = await store.files('evidence').openPath(ref, 'ultima.png');
  assert.ok(fs.existsSync(temp));
  await store.detach();
  assert.ok(!fs.existsSync(temp));
});
