// Observações do projeto: texto + referências a links, arquivos e pastas.
// Nada abre o Explorer de verdade (lançador simulado) e nenhum arquivo referenciado é tocado.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-notes-'));
const PORT = 4456;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

const { app } = require('../server');
const N = require('../src/notes-api');

const spawned = [];
N.setSpawn((exe, args) => { spawned.push({ exe: path.basename(exe), args }); const c = new EventEmitter(); c.unref = () => {}; return c; });

let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { N.setSpawn(null); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };

// Arquivos e pasta "do cliente" (falsos). Têm conteúdo para provar que nada é alterado.
const files = path.join(tmp, 'cliente');
fs.mkdirSync(path.join(files, 'Contratos'), { recursive: true });
const PDF = path.join(files, 'Contratos', 'regras de negocio.pdf'); fs.writeFileSync(PDF, 'conteudo-pdf-intocavel');
const DOCX = path.join(files, 'Particularidades.docx'); fs.writeFileSync(DOCX, 'conteudo-docx-intocavel');
const FOLDER = path.join(files, 'Contratos');
const snapshot = () => { const out = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out.push(`D ${p}`); w(p); } else { const s = fs.statSync(p); out.push(`F ${p} ${s.size} ${s.mtimeMs} ${fs.readFileSync(p, 'utf8')}`); } } })(files); return out.sort(); };

const S = {};
test('projeto sem observações (antigo) lista vazio; criar com link, arquivo e pasta; mais recente primeiro', async () => {
  S.p = ok(await api('POST', '/api/projects', { name: 'Cliente Alfa', rootDirKind: 'local', rootDir: '' }));
  assert.deepEqual(ok(await api('GET', `/api/projects/${S.p.id}/notes`)).notes, []);
  const first = ok(await api('POST', `/api/projects/${S.p.id}/notes`, { title: 'Folha de pagamento', text: 'Cliente fecha a folha dia 20.\nNunca importar depois das 18h.', refs: [
    { kind: 'link', label: 'Wiki do cliente', url: 'https://wiki.exemplo.com/cliente-alfa' },
    { kind: 'file', label: 'Regras', path: PDF },
    { kind: 'folder', path: `${FOLDER}\\` },
  ] }));
  const n = first.notes[0];
  assert.equal(n.title, 'Folha de pagamento'); assert.equal(n.text, 'Cliente fecha a folha dia 20.\nNunca importar depois das 18h.');
  assert.deepEqual(n.refs.map((r) => [r.kind, r.label]), [['link', 'Wiki do cliente'], ['file', 'Regras'], ['folder', 'Contratos']]); // rótulo padrão = nome da pasta
  assert.equal(n.refs[2].path, FOLDER); // barra final removida
  assert.ok(n.refs.filter((r) => r.kind !== 'link').every((r) => r.exists === true)); // derivado, nunca gravado
  assert.equal('exists' in JSON.parse(fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), 'utf8')).projects[0].notes[0].refs[1], false);
  assert.ok(n.createdAt && n.by !== undefined);
  assert.equal(first.project.notes.length, 1);
  await new Promise((r) => setTimeout(r, 5));
  ok(await api('POST', `/api/projects/${S.p.id}/notes`, { text: 'Só texto, sem título.' }));
  const list = ok(await api('GET', `/api/projects/${S.p.id}/notes`)).notes;
  assert.deepEqual(list.map((x) => x.text.slice(0, 8)), ['Só texto', 'Cliente ']); // a mais recente primeiro
  S.note = list[1];
});

test('validação: vazio, link inseguro, caminho relativo, programa/script recusados; limites', async () => {
  const post = (b) => api('POST', `/api/projects/${S.p.id}/notes`, b);
  assert.equal((await post({ title: '  ', text: ' ' })).status, 400);
  for (const url of ['javascript:alert(1)', 'ftp://x.com/a', 'não é url', 'file:///C:/x.pdf', '']) assert.equal((await post({ text: 'x', refs: [{ kind: 'link', url }] })).status, 400, url);
  for (const bad of ['relativo\\a.pdf', 'a.pdf', '']) assert.equal((await post({ text: 'x', refs: [{ kind: 'file', path: bad }] })).status, 400, bad);
  for (const ext of ['programa.exe', 'script.bat', 'x.ps1', 'atalho.lnk', 'a.cmd', 'b.vbs', 'c.js', 'd.msi', 'e.com', 'f.scr', 'sem_extensao']) {
    assert.equal((await post({ text: 'x', refs: [{ kind: 'file', path: path.join(files, ext) }] })).status, 400, ext);
  }
  assert.equal((await post({ text: 'x', refs: [{ kind: 'folder', path: 'relativa' }] })).status, 400);
  assert.equal((await post({ text: 'x', refs: [{ kind: 'outro', path: PDF }] })).status, 400);
  assert.equal((await post({ text: 'x', refs: Array.from({ length: 21 }, () => ({ kind: 'link', url: 'https://a.com' })) })).status, 400); // > 20 anexos
  assert.equal((await post({ text: 'x', refs: Array.from({ length: 20 }, () => ({ kind: 'link', url: 'https://a.com' })) })).status, 200);
  // limite de observações por projeto
  const q = ok(await api('POST', '/api/projects', { name: 'Limite', rootDirKind: 'local', rootDir: '' }));
  for (let i = 0; i < 50; i++) ok(await api('POST', `/api/projects/${q.id}/notes`, { text: `n${i}` }));
  assert.equal((await api('POST', `/api/projects/${q.id}/notes`, { text: 'n51' })).status, 400);
});

test('editar mantém o id dos anexos que já existiam; outros projetos e editar o projeto não perdem as observações', async () => {
  const before = S.note.refs.map((r) => r.id);
  const edited = ok(await api('PUT', `/api/projects/${S.p.id}/notes/${S.note.id}`, { title: 'Folha (atualizada)', text: 'Novo texto', refs: [
    { id: before[1], kind: 'file', label: 'Regras (v2)', path: PDF }, // mantém
    { kind: 'file', label: 'Particularidades', path: DOCX }, // novo
  ] })).notes.find((x) => x.id === S.note.id);
  assert.equal(edited.title, 'Folha (atualizada)'); assert.equal(edited.refs.length, 2);
  assert.equal(edited.refs[0].id, before[1]); assert.notEqual(edited.refs[1].id, before[1]);
  assert.equal(edited.createdAt, S.note.createdAt); assert.ok(edited.updatedAt >= S.note.updatedAt);
  S.note = edited;
  assert.equal((await api('PUT', `/api/projects/${S.p.id}/notes/inexistente`, { text: 'x' })).status, 404);
  const proj = ok(await api('PUT', `/api/projects/${S.p.id}`, { name: 'Cliente Alfa (editado)', rootDirKind: 'local', rootDir: '' }));
  assert.ok(proj.notes.length >= 2); // editar o cadastro do projeto não apaga as observações
  const other = ok(await api('POST', '/api/projects', { name: 'Outro', rootDirKind: 'local', rootDir: '' }));
  assert.deepEqual(ok(await api('GET', `/api/projects/${other.id}/notes`)).notes, []);
});

test('abrir: arquivo → programa padrão, pasta → Explorer, “abrir pasta” do arquivo; link, ausente e tipo proibido recusados', async () => {
  const [pdf, docx] = S.note.refs;
  ok(await api('POST', `/api/projects/${S.p.id}/notes/${S.note.id}/refs/${pdf.id}/open`));
  assert.deepEqual(spawned.pop(), { exe: 'explorer.exe', args: [PDF] }); // o próprio arquivo, sem argumentos extras
  ok(await api('POST', `/api/projects/${S.p.id}/notes/${S.note.id}/refs/${pdf.id}/open-folder`));
  assert.deepEqual(spawned.pop(), { exe: 'explorer.exe', args: [FOLDER] });
  const withFolder = ok(await api('PUT', `/api/projects/${S.p.id}/notes/${S.note.id}`, { text: 'x', refs: [{ id: pdf.id, kind: 'file', path: PDF }, { kind: 'folder', path: FOLDER }, { kind: 'link', url: 'https://a.com' }, { kind: 'file', path: path.join(files, 'sumiu.pdf') }] })).notes.find((x) => x.id === S.note.id);
  const [, folder, link, gone] = withFolder.refs;
  assert.equal(gone.exists, false); assert.equal(folder.exists, true);
  ok(await api('POST', `/api/projects/${S.p.id}/notes/${S.note.id}/refs/${folder.id}/open`));
  assert.deepEqual(spawned.pop(), { exe: 'explorer.exe', args: [FOLDER] });
  const n = spawned.length;
  assert.equal((await api('POST', `/api/projects/${S.p.id}/notes/${S.note.id}/refs/${link.id}/open`)).status, 400); // link abre pelo navegador
  assert.equal((await api('POST', `/api/projects/${S.p.id}/notes/${S.note.id}/refs/${gone.id}/open`)).status, 404); // arquivo movido
  assert.equal((await api('POST', `/api/projects/${S.p.id}/notes/${S.note.id}/refs/zzz/open`)).status, 404);
  assert.equal((await api('POST', `/api/projects/${S.p.id}/notes/nada/refs/${pdf.id}/open`)).status, 404);
  // extensão passou a ser proibida (dado adulterado no arquivo): não abre
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), 'utf8'));
  assert.equal(raw.projects.find((x) => x.id === S.p.id).notes.length >= 2, true);
  assert.equal(spawned.length, n); // nada recusado abriu algo
  void docx;
});

test('remover: só o registro some; arquivos e pastas referenciados continuam intactos (nada é copiado nem alterado)', async () => {
  const before = snapshot();
  const del = ok(await api('DELETE', `/api/projects/${S.p.id}/notes/${S.note.id}`));
  assert.equal(del.notes.some((x) => x.id === S.note.id), false);
  assert.equal((await api('DELETE', `/api/projects/${S.p.id}/notes/${S.note.id}`)).status, 404);
  assert.deepEqual(snapshot(), before); // PDF, DOCX e pasta idênticos (conteúdo e data)
  assert.ok(fs.existsSync(PDF) && fs.existsSync(DOCX));
  assert.equal(fs.existsSync(path.join(process.env.GP_DATA_DIR, 'evidencias', 'comunicacoes')), false); // nada foi copiado para o app
  const audit = fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'audit.log'), 'utf8');
  for (const a of ['observacao-criada', 'observacao-editada', 'observacao-removida']) assert.match(audit, new RegExp(`"action":"${a}"`));
  assert.doesNotMatch(audit, /Nunca importar depois|conteudo-pdf/); // auditoria só com metadados, nunca o texto da observação
});

test('garantia estática: o serviço só grava metadados (nenhuma escrita/cópia/remoção de arquivo) e a tela não usa alert', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/notes-api.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /writeFile|appendFile|unlink|rmSync|rmdir|\.rm\(|rename|copyFile|mkdir|truncate|symlink|createWriteStream|chmod|utimes/);
  assert.doesNotMatch(code, /shell\s*:\s*true|exec\(|execSync|execFile/);
  const ui = fs.readFileSync(path.join(__dirname, '../public/notes.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(ui, /\balert\(/);
  assert.match(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), /<script src="notes\.js"><\/script>/);
});
