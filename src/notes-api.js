// Observações do projeto: texto livre (particularidades do cliente/projeto) com referências a links, arquivos e pastas.
//
// As referências são só ISSO — o caminho/URL guardado no cadastro (como em Documentos e Modelos). O app não copia, move, altera nem
// apaga o arquivo ou a pasta; remover uma observação remove apenas o registro. Arquivo: caminho absoluto + extensão de documento
// (DOC_EXT; nunca programa/script). Abrir = programa padrão do Windows (arquivo) ou Explorer (pasta); link abre no navegador.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { httpError, uid, str } = require('./util');
const { isSafeDocFile, isHttpUrl } = require('./config-api');

const MAX_NOTES = 50;
const MAX_REFS = 20;
const KINDS = new Set(['link', 'file', 'folder']);

let spawner = spawn; // ponto único de criação de processo (os testes trocam por um simulado)
const setSpawn = (fn) => { spawner = fn || spawn; };

const baseName = (p) => path.basename(p) || p;
const isRoot = (p) => path.parse(p).root.toLowerCase() === p.toLowerCase();

function cleanRef(b, existingIds) {
  const kind = KINDS.has(b?.kind) ? b.kind : null;
  if (!kind) throw httpError(400, 'Tipo de anexo inválido (use link, arquivo ou pasta).');
  const label = str(b.label, 120);
  const id = typeof b.id === 'string' && existingIds.has(b.id) ? b.id : uid(); // quem já existia mantém o id
  if (kind === 'link') {
    const url = str(b.url, 800);
    if (!isHttpUrl(url)) throw httpError(400, 'O link precisa começar com http:// ou https://.');
    return { id, kind, label: label || url, url };
  }
  let p = str(b.path, 600);
  if (!p || !path.isAbsolute(p)) throw httpError(400, kind === 'file' ? 'Selecione o arquivo (caminho completo).' : 'Selecione a pasta (caminho completo).');
  p = path.normalize(p);
  if (kind === 'file') {
    if (!isSafeDocFile(p)) throw httpError(400, 'Tipo de arquivo não permitido. Use documentos (PDF, Word, Excel, PowerPoint, texto, imagem, zip…), nunca programas ou scripts.');
    return { id, kind, label: label || baseName(p), path: p };
  }
  if (!isRoot(p)) p = p.replace(/[\\/]+$/, '');
  return { id, kind, label: label || baseName(p), path: p };
}

function cleanNote(b, existing) {
  const title = str(b?.title, 120);
  const text = String(b?.text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
  if (!title && !text) throw httpError(400, 'Escreva a observação (título ou texto).');
  const list = Array.isArray(b?.refs) ? b.refs : [];
  if (list.length > MAX_REFS) throw httpError(400, `Uma observação pode ter até ${MAX_REFS} links/arquivos/pastas.`);
  const ids = new Set((existing?.refs || []).map((r) => r.id));
  return { title, text, refs: list.map((r) => cleanRef(r, ids)) };
}

const exists = (r) => { try { const s = fs.statSync(r.path); return r.kind === 'folder' ? s.isDirectory() : s.isFile(); } catch { return false; } };

function mount(app, { store, audit, getProject, publicProject, SYS }) {
  const notesOf = (p) => (p.notes ||= []);
  const noteOf = (p, nid) => notesOf(p).find((n) => n.id === nid) || (() => { throw httpError(404, 'Observação não encontrada.'); })();
  const refOf = (n, rid) => n.refs.find((r) => r.id === rid) || (() => { throw httpError(404, 'Anexo não encontrado.'); })();
  // Mais recentes primeiro; cada arquivo/pasta ganha `exists` (derivado, nunca gravado) e nenhum caminho de link/arquivo é alterado.
  const view = (p) => [...(p.notes || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((n) => ({ ...n, refs: n.refs.map((r) => (r.kind === 'link' ? r : { ...r, exists: exists(r) })) }));
  const reply = (p, res) => res.json({ notes: view(p), project: publicProject(p) });
  const { who } = require('./auth/identity');

  app.get('/api/projects/:id/notes', (req, res) => res.json({ notes: view(getProject(req.params.id)) }));

  app.post('/api/projects/:id/notes', async (req, res) => {
    const p = getProject(req.params.id);
    if (notesOf(p).length >= MAX_NOTES) throw httpError(400, `Limite de ${MAX_NOTES} observações por projeto.`);
    const now = new Date().toISOString();
    notesOf(p).push({ id: uid(), ...cleanNote(req.body), createdAt: now, updatedAt: now, by: who() });
    await store.save();
    audit.log({ action: 'observacao-criada', project: p.name, detalhe: str(req.body?.title, 120) || 'sem título' });
    reply(p, res);
  });

  app.put('/api/projects/:id/notes/:nid', async (req, res) => {
    const p = getProject(req.params.id);
    const n = noteOf(p, req.params.nid);
    Object.assign(n, cleanNote(req.body, n), { updatedAt: new Date().toISOString() });
    await store.save();
    audit.log({ action: 'observacao-editada', project: p.name, detalhe: n.title || 'sem título' });
    reply(p, res);
  });

  // Remove só o registro da observação; arquivos e pastas referenciados não são tocados.
  app.delete('/api/projects/:id/notes/:nid', async (req, res) => {
    const p = getProject(req.params.id);
    const n = noteOf(p, req.params.nid);
    p.notes = notesOf(p).filter((x) => x.id !== n.id);
    await store.save();
    audit.log({ action: 'observacao-removida', project: p.name, detalhe: n.title || 'sem título' });
    reply(p, res);
  });

  // Arquivo → programa padrão; pasta → Explorer. Só o que está cadastrado, com a extensão ainda permitida e existente.
  const target = (req, folderOfFile) => {
    const r = refOf(noteOf(getProject(req.params.id), req.params.nid), req.params.rid);
    if (r.kind === 'link') throw httpError(400, 'Este anexo é um link; abra-o pelo navegador.');
    if (r.kind === 'file' && !isSafeDocFile(r.path)) throw httpError(400, 'Tipo de arquivo não permitido.');
    if (!exists(r)) throw httpError(404, r.kind === 'folder' ? 'A pasta não foi encontrada no caminho cadastrado. Edite a observação e selecione-a de novo.' : 'O arquivo não foi encontrado no caminho cadastrado. Edite a observação e selecione-o de novo.');
    return r.kind === 'file' && folderOfFile ? path.dirname(r.path) : r.path;
  };
  const explorer = () => (SYS ? path.join(SYS, 'explorer.exe') : null);
  app.post('/api/projects/:id/notes/:nid/refs/:rid/open', (req, res) => {
    const t = target(req, false);
    const ex = explorer();
    if (!ex) throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
    spawner(ex, [t], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  });
  app.post('/api/projects/:id/notes/:nid/refs/:rid/open-folder', (req, res) => {
    const t = target(req, true);
    const ex = explorer();
    if (!ex) throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
    spawner(ex, [t], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  });
}

module.exports = { mount, setSpawn };
