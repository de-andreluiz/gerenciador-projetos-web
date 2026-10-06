// Evidências dos itens de checklist: configuração (tipos/extensões/tamanho), validação de anexos e armazenamento em disco.
// Os arquivos ficam em <data>\evidencias\<projeto>\<passo>\ ; o app só guarda os metadados (caminho RELATIVO) no projects.json.
// Nada aqui executa um arquivo: anexos são tratados como dados (o "abrir" usa o programa padrão, só para tipos permitidos).
const fs = require('fs');
const path = require('path');
const { httpError, sanitizeFileName } = require('./util');

const DEFAULT_MAX_MB = 10;
const MAX_MB_LIMIT = 100;

// Extensões padrão de cada tipo. Podem ser ajustadas em Configurações (settings.evidence); a lógica nunca depende destes valores.
const DEFAULT_LISTS = {
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  document: ['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.txt'],
  extra: ['.csv', '.zip', '.gif', '.pptx', '.ppt', '.rtf', '.log', '.json', '.xml', '.md'], // só entram em "Qualquer arquivo permitido"
};

const TYPE_LABEL = { none: 'Nenhuma evidência', image: 'Imagem', document: 'Documento', imageOrDocument: 'Imagem ou documento', any: 'Qualquer arquivo permitido' };
const EVIDENCE_TYPES = ['image', 'document', 'imageOrDocument', 'any'];

// Nunca aceitos, mesmo que alguém os coloque na configuração: programas, scripts e páginas com conteúdo ativo.
const BLOCKED = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.scr', '.pif', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta',
  '.cpl', '.jar', '.lnk', '.reg', '.dll', '.sys', '.inf', '.url', '.application', '.gadget', '.sh', '.py', '.svg', '.html', '.htm', '.xhtml', '.mht', '.chm',
]);

const EXT_RE = /^\.[a-z0-9]{1,8}$/;
const cleanExt = (e) => { const v = String(e || '').trim().toLowerCase(); return v.startsWith('.') ? v : `.${v}`; };

// settings.evidence guarda só o que foi alterado: { maxMB, image:[…], document:[…], extra:[…] }.
function getConfig(settings) {
  const s = (settings && settings.evidence) || {};
  const mb = Number.isInteger(s.maxMB) && s.maxMB >= 1 && s.maxMB <= MAX_MB_LIMIT ? s.maxMB : DEFAULT_MAX_MB;
  const list = (k) => (Array.isArray(s[k]) ? s[k] : DEFAULT_LISTS[k]).map(cleanExt).filter((e) => EXT_RE.test(e) && !BLOCKED.has(e));
  const lists = { image: list('image'), document: list('document'), extra: list('extra') };
  const uniq = (...a) => [...new Set(a.flat())];
  const types = {
    image: { label: TYPE_LABEL.image, extensions: uniq(lists.image) },
    document: { label: TYPE_LABEL.document, extensions: uniq(lists.document) },
    imageOrDocument: { label: TYPE_LABEL.imageOrDocument, extensions: uniq(lists.image, lists.document) },
    any: { label: TYPE_LABEL.any, extensions: uniq(lists.image, lists.document, lists.extra) },
  };
  return { maxMB: mb, maxBytes: mb * 1024 * 1024, lists, types };
}

// Valida o que a tela envia ao salvar as configurações de evidência.
function cleanConfig(body) {
  const out = {};
  const mb = Number(body.maxMB);
  if (!Number.isInteger(mb) || mb < 1 || mb > MAX_MB_LIMIT) throw httpError(400, `O tamanho máximo deve ser de 1 a ${MAX_MB_LIMIT} MB.`);
  out.maxMB = mb;
  for (const k of Object.keys(DEFAULT_LISTS)) {
    const raw = Array.isArray(body[k]) ? body[k] : String(body[k] ?? '').split(/[\s,;]+/);
    const list = [...new Set(raw.map((e) => String(e).trim()).filter(Boolean).map(cleanExt))];
    for (const e of list) {
      if (!EXT_RE.test(e)) throw httpError(400, `Extensão inválida: “${e}”. Use algo como .pdf`);
      if (BLOCKED.has(e)) throw httpError(400, `A extensão ${e} não pode ser usada em evidências (programas, scripts e páginas web são sempre recusados).`);
    }
    if (list.length > 40) throw httpError(400, 'Muitas extensões (máximo de 40 por tipo).');
    if (k !== 'extra' && !list.length) throw httpError(400, `Informe ao menos uma extensão para “${TYPE_LABEL[k]}”.`);
    out[k] = list;
  }
  return out;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.md': 'text/markdown; charset=utf-8',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf', '.zip': 'application/zip',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']); // as que o navegador mostra como pré-visualização (SVG fica de fora de propósito)
const TEXT_EXT = new Set(['.txt', '.csv', '.log', '.json', '.xml', '.md']);
const mimeOf = (ext) => MIME[ext] || 'application/octet-stream';
const kindOf = (ext) => (IMAGE_EXT.has(ext) ? 'image' : ext === '.pdf' ? 'pdf' : 'file');

const startsWith = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const OLE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
// Assinatura (primeiros bytes) que cada extensão precisa ter. Extensões sem regra aqui (as que você adicionar) só passam pela checagem geral.
const SIGNATURES = {
  '.png': (b) => startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  '.jpg': (b) => startsWith(b, [0xFF, 0xD8, 0xFF]), '.jpeg': (b) => startsWith(b, [0xFF, 0xD8, 0xFF]),
  '.webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  '.gif': (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  '.bmp': (b) => startsWith(b, ascii('BM')),
  '.pdf': (b) => b.subarray(0, 1024).includes('%PDF-'),
  '.rtf': (b) => startsWith(b, ascii('{\\rtf')),
  '.doc': (b) => startsWith(b, OLE), '.xls': (b) => startsWith(b, OLE), '.ppt': (b) => startsWith(b, OLE),
  '.docx': (b) => startsWith(b, ascii('PK')), '.xlsx': (b) => startsWith(b, ascii('PK')), '.pptx': (b) => startsWith(b, ascii('PK')), '.zip': (b) => startsWith(b, ascii('PK')),
};
const isUtf16Bom = (b) => (b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF);
const DANGEROUS_MIME = /^(text\/html|application\/(x-msdownload|x-dosexec|x-msdos-program|javascript|x-javascript|x-sh|x-bat|hta)|text\/javascript|image\/svg\+xml)$/i;

// Valida um anexo ANTES de gravar. O nome vindo da tela nunca vira caminho: só serve para exibir e para achar a extensão.
// Devolve { ext, name, mime, kind, size } ou lança um erro com a mensagem para o usuário.
function checkUpload({ name, buffer, type, cfg, declaredMime }) {
  const shown = sanitizeFileName(path.basename(String(name || '').replace(/\\/g, '/')), 'evidencia');
  const ext = path.extname(shown).toLowerCase();
  if (!ext) throw httpError(400, 'O arquivo precisa ter extensão (ex.: .png, .pdf).');
  if (BLOCKED.has(ext)) throw httpError(400, `Arquivos ${ext} não são aceitos como evidência (programas, scripts e páginas web são recusados por segurança).`);
  const allowed = cfg.types[type]?.extensions;
  if (!allowed) throw httpError(400, 'Tipo de evidência inválido.');
  if (!allowed.includes(ext)) throw httpError(400, `Este item aceita ${TYPE_LABEL[type].toLowerCase()}: ${allowed.join(' ')}. O arquivo enviado é ${ext}.`);
  if (!buffer.length) throw httpError(400, 'O arquivo está vazio.');
  if (buffer.length > cfg.maxBytes) throw httpError(413, `Arquivo grande demais (${(buffer.length / 1048576).toFixed(1)} MB). O máximo por evidência é ${cfg.maxMB} MB.`);
  const dm = String(declaredMime || '').split(';')[0].trim().toLowerCase();
  if (dm && DANGEROUS_MIME.test(dm)) throw httpError(400, 'O tipo do arquivo (MIME) não é aceito como evidência.');
  if (dm && MIME[ext] && (IMAGE_EXT.has(ext) || ext === '.pdf') && dm !== 'application/octet-stream' && dm !== MIME[ext].split(';')[0]) {
    throw httpError(400, `O conteúdo enviado (${dm}) não confere com a extensão ${ext}.`);
  }
  // Conteúdo: programas do Windows/Linux nunca passam, e a assinatura precisa bater com a extensão.
  if (startsWith(buffer, ascii('MZ')) || startsWith(buffer, [0x7F, 0x45, 0x4C, 0x46])) throw httpError(400, 'O conteúdo do arquivo é um programa executável e não pode ser anexado.');
  const sig = SIGNATURES[ext];
  if (sig && !sig(buffer)) throw httpError(400, `O conteúdo do arquivo não parece ser um ${ext} válido (a assinatura do arquivo não confere com a extensão).`);
  if (TEXT_EXT.has(ext) && !isUtf16Bom(buffer) && buffer.subarray(0, 8000).includes(0)) throw httpError(400, `O arquivo ${ext} contém dados binários; envie um texto puro.`);
  return { ext, name: shown, mime: mimeOf(ext), kind: kindOf(ext), size: buffer.length };
}

// ---------- Armazenamento ----------
function slug(s, fallback = 'x') {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

class EvidenceFiles {
  constructor(dataDir) {
    this.root = path.resolve(dataDir, 'evidencias');
    this.removed = path.join(this.root, '.removidas');
    fs.mkdirSync(this.removed, { recursive: true });
  }

  // Pasta do passo, relativa à raiz: <projeto>-<id>/<NN>-<estágio> (o id garante que dois projetos com o mesmo nome não se misturem).
  folderFor(project, stepNo, stageName) {
    return `${slug(project.name, 'projeto')}-${project.id}/${pad(stepNo)}-${slug(stageName, 'etapa')}`;
  }

  // Observações do controle de horas: horas/<AAAA-MM>/<AAAA-MM-DD> (as evidências do checklist ficam em <projeto>/<etapa>).
  folderForNote(date) { return `horas/${String(date).slice(0, 7)}/${date}`; }


  // Resolve um caminho relativo guardado no cadastro e garante que continua DENTRO da pasta de evidências.
  resolve(rel) {
    const parts = String(rel || '').split('/');
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || /[:\\<>"|?*\u0000]/.test(p))) throw httpError(400, 'Caminho de evidência inválido.');
    const full = path.resolve(this.root, ...parts);
    if (!full.startsWith(this.root + path.sep) || full.startsWith(this.removed + path.sep)) throw httpError(400, 'Caminho de evidência inválido.');
    return full;
  }

  // Grava sem sobrescrever nada: o nome no disco é "<id>_<nome>", e o id é novo a cada anexo (mesmo nome enviado 2x = 2 arquivos).
  save(folderRel, evidenceId, safeName, buffer) {
    const rel = `${folderRel}/${evidenceId}_${safeName}`;
    const full = this.resolve(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer, { flag: 'wx' });
    return rel;
  }

  stat(rel) { try { const s = fs.statSync(this.resolve(rel)); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null; } catch { return null; } }

  // "Remover" move o arquivo para .removidas (nunca apaga) — mesma ideia da pasta de scripts.
  trash(rel) {
    let full;
    try { full = this.resolve(rel); } catch { return null; }
    if (!fs.existsSync(full)) return null;
    const dest = path.join(this.removed, `${stamp()}_${path.basename(full)}`);
    fs.renameSync(full, dest);
    return dest;
  }
}

module.exports = { getConfig, cleanConfig, checkUpload, EvidenceFiles, TYPE_LABEL, EVIDENCE_TYPES, DEFAULT_LISTS, BLOCKED, MIME, mimeOf, IMAGE_EXT, kindOf };
