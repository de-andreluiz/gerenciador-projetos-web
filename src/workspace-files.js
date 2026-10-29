// Workspace — serviço de arquivos. Trabalha SEMPRE sobre os arquivos reais dentro da pasta raiz do Workspace
// (ex.: C:\Projetos); nada é copiado para o app. Toda operação recebe caminhos RELATIVOS à raiz e é validada aqui:
//  - nada de caminho absoluto, "..", nomes reservados do Windows ou atalhos/junções que levem para fora da raiz;
//  - copiar/mover nunca sobrescreve em silêncio: primeiro um PLANO lista os conflitos e cada um precisa de uma decisão
//    (substituir / manter ambos / pular); o arquivo substituído vai para a Lixeira do Windows;
//  - "excluir" manda para a Lixeira (recuperável).
const fs = require('fs');
const path = require('path');
const { httpError } = require('./util');
const { decodeSqlBuffer } = require('./sqlscan');
const { runPowerShell } = require('./powershell');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.vs', '.vscode', '.idea', '$RECYCLE.BIN', 'System Volume Information']);
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const PROJECT_DEPTH = 3; // repositórios Git são procurados até 3 níveis abaixo da raiz (ex.: Grupo\Cliente\.git)
const MAX_PROJECTS = 500;
const MAX_LIST = 5000;
const MAX_TRANSFER_FILES = 5000;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_VISITS = 200000;
const SEARCH_BUDGET_MS = 4000;
const MAX_COMPARE_BYTES = 5 * 1024 * 1024;

const toPosix = (p) => p.split(path.sep).join('/');
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const skipDir = (name) => SKIP_DIRS.has(name) || name.startsWith('.');
const hasGit = (dir) => fs.existsSync(path.join(dir, '.git'));

// Nome de UM arquivo/pasta digitado pelo usuário: recusa (não "corrige") o que o Windows não aceita.
function checkName(name, what = 'Nome') {
  const n = String(name ?? '').trim();
  if (!n) throw httpError(400, `${what} vazio.`);
  if (n.length > 150) throw httpError(400, `${what} longo demais (máximo 150 caracteres).`);
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) throw httpError(400, `${what} contém caracteres não permitidos: < > : " / \\ | ? *`);
  if (n === '.' || n === '..' || /[. ]$/.test(n)) throw httpError(400, `${what} não pode terminar com ponto ou espaço.`);
  if (RESERVED.test(n)) throw httpError(400, `${what} “${n}” é reservado pelo Windows.`);
  return n;
}

function isAbsPath(p) {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

// Pasta raiz do workspace: caminho absoluto de uma pasta comum (nunca a raiz de um disco nem pastas do sistema).
function checkRoot(p) {
  const v = String(p ?? '').trim();
  if (!v) return '';
  if (!isAbsPath(v)) throw httpError(400, 'Informe um caminho completo (ex.: /home/usuario/Projetos ou C:\\Projetos).');
  const abs = path.resolve(v);
  if (path.parse(abs).root.toLowerCase() === abs.toLowerCase() || /^\\\\[^\\]+\\[^\\]+\\?$/.test(abs) || /^[a-zA-Z]:[\\/]?$/.test(v)) {
    throw httpError(400, 'Escolha uma pasta, não a raiz de um disco.');
  }
  const sys = [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter(Boolean);
  if (sys.some((s) => isInside(path.resolve(s), abs))) throw httpError(400, 'Pastas do sistema (Windows, Arquivos de Programas, ProgramData) não podem ser usadas.');
  return abs;
}

// child está dentro de (ou é) parent? Comparação sem diferenciar maiúsculas (Windows).
function isInside(parent, child) {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// "PFUNC.sql" → "PFUNC (2).sql", "validacoes" → "validacoes (2)" (primeiro nome livre na pasta).
function freeName(dir, name, isDir, taken = new Set()) {
  const ext = isDir ? '' : path.extname(name);
  const base = isDir ? name : name.slice(0, name.length - ext.length);
  for (let i = 2; i < 10000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, cand)) && !taken.has(path.join(dir, cand).toLowerCase())) return cand;
  }
  throw httpError(409, `Não foi possível achar um nome livre para “${name}”.`);
}

// Arquivos com o mesmo conteúdo? (só compara arquivos de até 5 MB com o mesmo tamanho)
function sameContent(a, b) {
  try {
    const sa = fs.statSync(a); const sb = fs.statSync(b);
    if (sa.size !== sb.size || sa.size > MAX_COMPARE_BYTES) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

// Envia vários caminhos para a Lixeira (no Windows via PowerShell) ou exclui diretamente no Linux/macOS.
async function sendToRecycleBin(absPaths) {
  if (!absPaths.length) return;
  if (process.platform === 'win32') {
    const script = `
Add-Type -AssemblyName Microsoft.VisualBasic
$lista = [Console]::In.ReadToEnd() -split "\`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
foreach ($p in $lista) {
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
}`;
    await runPowerShell(script, { input: absPaths.join('\n'), timeoutMs: 120000 });
  } else {
    for (const p of absPaths) {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }
  const left = absPaths.filter((p) => fs.existsSync(p));
  if (left.length) throw httpError(500, `Não foi possível excluir: ${left.map((p) => path.basename(p)).join(', ')}`);
}

class WorkspaceFiles {
  constructor(root) {
    this.root = checkRoot(root);
    if (!this.root) throw httpError(400, 'A pasta raiz do Workspace não está configurada.', { code: 'WS_NOT_CONFIGURED' });
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) throw httpError(404, `A pasta ${this.root} não existe.`, { code: 'WS_ROOT_MISSING' });
    this.realRoot = fs.realpathSync.native(this.root);
  }

  // Caminho relativo (com / ou \) → absoluto, garantindo que fica dentro da raiz (inclusive seguindo junções/links).
  resolve(rel, { allowRoot = false } = {}) {
    const r = String(rel ?? '').replace(/\\/g, '/');
    if (r.includes('\0')) throw httpError(400, 'Caminho inválido.');
    if (r.startsWith('/') || /^[a-zA-Z]:/.test(r) || path.isAbsolute(r)) throw httpError(400, 'Use um caminho relativo à pasta do Workspace.');
    if (r.split('/').some((seg) => seg === '..')) throw httpError(400, 'Caminho fora da pasta do Workspace.');
    const abs = path.resolve(this.root, r);
    if (!isInside(this.root, abs)) throw httpError(400, 'Caminho fora da pasta do Workspace.');
    if (!allowRoot && abs.toLowerCase() === this.root.toLowerCase()) throw httpError(400, 'Operação não permitida na pasta raiz do Workspace.');
    // O ancestral existente mais próximo, com links resolvidos, também precisa estar dentro da raiz real.
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    if (!isInside(this.realRoot, fs.realpathSync.native(probe))) throw httpError(400, 'Caminho aponta para fora da pasta do Workspace.');
    return abs;
  }
  rel(abs) { return toPosix(path.relative(this.root, abs)); }
  dir(rel, what = 'Pasta') {
    const abs = this.resolve(rel, { allowRoot: true });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw httpError(404, `${what} não encontrada: ${rel || '(raiz)'}`);
    return abs;
  }

  // ---- Projetos ----
  // Cada repositório Git (pasta com .git) até 3 níveis abaixo da raiz é um projeto; pastas do 1º nível que não são
  // nem contêm repositórios também aparecem (projetos "sem Git"). Pastas que só agrupam repositórios viram "grupo".
  projects() {
    const out = [];
    const walk = (dir, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      let found = false;
      for (const e of entries) {
        if (out.length >= MAX_PROJECTS) break;
        if (!e.isDirectory() || skipDir(e.name)) continue; // links/junções não são seguidos
        const full = path.join(dir, e.name);
        if (hasGit(full)) { out.push({ path: this.rel(full), name: e.name, git: true }); found = true; continue; }
        if (depth < PROJECT_DEPTH && walk(full, depth + 1)) { found = true; continue; }
        if (depth === 1) out.push({ path: this.rel(full), name: e.name, git: false });
      }
      return found;
    };
    walk(this.root, 1);
    for (const p of out) { const g = path.posix.dirname(p.path); p.group = g === '.' ? '' : g; }
    return out.sort((a, b) => a.path.localeCompare(b.path, 'pt-BR', { numeric: true, sensitivity: 'base' }));
  }
  // Projeto (da lista acima) ao qual um caminho pertence — o de caminho mais longo que o contém.
  projectOf(rel, projects = this.projects()) {
    const r = String(rel || '').toLowerCase();
    return projects.filter((p) => r === p.path.toLowerCase() || r.startsWith(`${p.path.toLowerCase()}/`)).sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  // ---- Leitura ----
  // Conteúdo de UMA pasta (a árvore é carregada sob demanda, pasta por pasta). all=false: só pastas e .sql.
  list(rel, { all = false } = {}) {
    const dir = this.dir(rel);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw httpError(403, `Sem acesso à pasta: ${e.code || e.message}`); }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (dirs.length + files.length >= MAX_LIST) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) dirs.push({ name: e.name, path: this.rel(full), git: hasGit(full) }); }
      else if (e.isFile() && (all ? e.name !== '.git' : /\.sql$/i.test(e.name))) {
        let st = null;
        try { st = fs.statSync(full); } catch { /* sumiu no meio da leitura */ }
        files.push({ name: e.name, path: this.rel(full), size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 });
      }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' });
    return { path: this.rel(dir), dirs: dirs.sort(byName), files: files.sort(byName), truncated: dirs.length + files.length >= MAX_LIST };
  }

  // Busca por nome/caminho (todas as palavras precisam aparecer; sem diferenciar acentos/maiúsculas).
  search(q, { all = false, within = '' } = {}) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return { results: [], truncated: false };
    const start = this.dir(within);
    const t0 = Date.now();
    const results = [];
    let visits = 0;
    let truncated = false;
    const queue = [start];
    while (queue.length) {
      if (results.length >= MAX_SEARCH_RESULTS || visits >= MAX_SEARCH_VISITS || Date.now() - t0 > SEARCH_BUDGET_MS) { truncated = true; break; }
      const dir = queue.shift();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        visits++;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!skipDir(e.name)) queue.push(full); continue; }
        if (!e.isFile() || (!all && !/\.sql$/i.test(e.name))) continue;
        const rel = this.rel(full);
        const hay = norm(rel);
        if (words.every((w) => hay.includes(w))) {
          results.push({ name: e.name, path: rel });
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    }
    return { results, truncated };
  }

  // Conteúdo de dois arquivos para comparação (texto; arquivos binários ou grandes demais só são sinalizados).
  compare(aRel, bRel) {
    const read = (rel) => {
      const abs = this.resolve(rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(404, `Arquivo não encontrado: ${rel}`);
      const st = fs.statSync(abs);
      if (st.size > MAX_COMPARE_BYTES) return { path: rel, size: st.size, tooBig: true, text: '' };
      const buf = fs.readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0) && !(buf[0] === 0xFF && buf[1] === 0xFE) && !(buf[0] === 0xFE && buf[1] === 0xFF)) return { path: rel, size: st.size, binary: true, text: '' };
      return { path: rel, size: st.size, mtimeMs: st.mtimeMs, text: decodeSqlBuffer(buf).replace(/\r\n?/g, '\n') };
    };
    return { a: read(aRel), b: read(bRel) };
  }

  // ---- Criar / renomear / excluir ----
  createFile(dirRel, name) {
    const n = checkName(name, 'Nome do arquivo');
    const fileName = path.extname(n) ? n : `${n}.sql`; // sem extensão: script SQL
    const dir = this.dir(dirRel);
    const abs = this.resolve(this.rel(path.join(dir, fileName)));
    if (fs.existsSync(abs)) throw httpError(409, `Já existe “${fileName}” nesta pasta.`);
    fs.writeFileSync(abs, '', { flag: 'wx' });
    return this.rel(abs);
  }

  createDir(dirRel, name) {
    const n = checkName(name, 'Nome da pasta');
    const parent = this.dir(dirRel);
    const abs = this.resolve(this.rel(path.join(parent, n)));
    if (fs.existsSync(abs)) throw httpError(409, `Já existe “${n}” nesta pasta.`);
    fs.mkdirSync(abs);
    return this.rel(abs);
  }

  rename(rel, newName) {
    const src = this.resolve(rel);
    if (!fs.existsSync(src)) throw httpError(404, `Não encontrado: ${rel}`);
    const isDir = fs.statSync(src).isDirectory();
    const name = checkName(newName, isDir ? 'Nome da pasta' : 'Nome do arquivo');
    const dest = this.resolve(this.rel(path.join(path.dirname(src), name)));
    if (dest === src) return this.rel(src);
    // Só troca de maiúsculas/minúsculas (ex.: pfunc.sql → PFUNC.sql) é permitido; qualquer outro destino existente não.
    if (fs.existsSync(dest) && dest.toLowerCase() !== src.toLowerCase()) throw httpError(409, `Já existe “${name}” nesta pasta.`);
    fs.renameSync(src, dest);
    return this.rel(dest);
  }

  async trash(rels) {
    const list = [...new Set((rels || []).map((r) => this.resolve(r)))];
    if (!list.length) throw httpError(400, 'Nada selecionado.');
    for (const abs of list) if (!fs.existsSync(abs)) throw httpError(404, `Não encontrado: ${this.rel(abs)}`);
    // não manda uma pasta E um arquivo dentro dela (o de dentro já vai junto)
    const top = list.filter((a) => !list.some((b) => b !== a && isInside(b, a)));
    await sendToRecycleBin(top);
    return top.map((a) => this.rel(a));
  }

  // ---- Copiar / mover ----
  // items: [{ src, destDir, createDest? }] (caminhos relativos). Devolve a lista de arquivos a transferir e os conflitos.
  // createDest: cria a pasta de destino se ainda não existir (usado em "Clonar para projeto", que mantém o caminho).
  plan(items, op = 'copy') {
    if (!Array.isArray(items) || !items.length) throw httpError(400, 'Selecione ao menos um arquivo ou pasta.');
    if (!['copy', 'move'].includes(op)) throw httpError(400, 'Operação inválida.');
    const files = [];
    const dirs = [];
    const seenDest = new Set();
    const add = (from, to) => {
      if (files.length >= MAX_TRANSFER_FILES) throw httpError(400, `Arquivos demais numa operação (máximo ${MAX_TRANSFER_FILES}).`);
      const key = to.toLowerCase();
      if (seenDest.has(key)) throw httpError(400, `Dois itens selecionados iriam para o mesmo destino: ${this.rel(to)}`);
      seenDest.add(key);
      files.push({ from, to });
    };
    for (const it of items) {
      const src = this.resolve(it.src);
      if (!fs.existsSync(src)) throw httpError(404, `Não encontrado: ${it.src}`);
      const destDir = this.resolve(it.destDir ?? '', { allowRoot: true });
      if (!fs.existsSync(destDir)) {
        if (!it.createDest) throw httpError(404, `Pasta de destino não encontrada: ${it.destDir || '(raiz)'}`);
      } else if (!fs.statSync(destDir).isDirectory()) throw httpError(400, `O destino não é uma pasta: ${it.destDir}`);
      const isDir = fs.statSync(src).isDirectory();
      const to = path.join(destDir, path.basename(src));
      if (isDir && isInside(src, destDir)) throw httpError(400, `Não é possível ${op === 'move' ? 'mover' : 'copiar'} a pasta “${path.basename(src)}” para dentro dela mesma.`);
      if (to.toLowerCase() === src.toLowerCase() && op === 'move') throw httpError(400, `“${path.basename(src)}” já está nesta pasta.`);
      if (!isDir) { add(src, to); continue; }
      dirs.push({ from: src, to });
      const walk = (d, t) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          const g = path.join(t, e.name);
          if (e.isDirectory()) { if (e.name !== '.git') { dirs.push({ from: f, to: g }); walk(f, g); } } // o .git de um repositório nunca é copiado
          else if (e.isFile()) add(f, g);
        }
      };
      walk(src, to);
    }
    // Todos os destinos dentro da raiz (inclusive pastas novas criadas pela operação).
    for (const f of files) this.resolve(this.rel(f.to));
    for (const d of dirs) if (fs.existsSync(d.to) && !fs.statSync(d.to).isDirectory()) throw httpError(409, `Já existe um ARQUIVO com o nome da pasta de destino: ${this.rel(d.to)}`);
    const conflicts = [];
    for (const f of files) {
      if (!fs.existsSync(f.to)) continue;
      if (fs.statSync(f.to).isDirectory()) throw httpError(409, `Já existe uma PASTA com o nome do arquivo: ${this.rel(f.to)}`);
      const a = fs.statSync(f.from); const b = fs.statSync(f.to);
      conflicts.push({ from: this.rel(f.from), to: this.rel(f.to), self: f.from.toLowerCase() === f.to.toLowerCase(),
        identical: f.from.toLowerCase() !== f.to.toLowerCase() && sameContent(f.from, f.to),
        src: { size: a.size, mtimeMs: a.mtimeMs }, dest: { size: b.size, mtimeMs: b.mtimeMs } });
    }
    return { op, files, dirs, conflicts, count: files.length };
  }

  // Executa o plano. resolutions: { "<destino relativo>": "replace" | "keepBoth" | "skip" } — obrigatória para cada
  // conflito (senão nada é feito e os conflitos voltam com erro 409). Arquivos substituídos vão para a Lixeira antes.
  async transfer(items, op, resolutions = {}) {
    const plan = this.plan(items, op);
    const pending = plan.conflicts.filter((c) => !['replace', 'keepBoth', 'skip'].includes(resolutions[c.to]));
    if (pending.length) throw httpError(409, `${pending.length} arquivo(s) já existe(m) no destino. Escolha o que fazer com cada um.`, { code: 'WS_CONFLICTS', conflicts: plan.conflicts });
    const bad = plan.conflicts.find((c) => c.self && resolutions[c.to] === 'replace');
    if (bad) throw httpError(400, `“${bad.to}” é o próprio arquivo de origem: escolha “Manter ambos” ou “Pular”.`);
    const byTo = new Map(plan.conflicts.map((c) => [c.to.toLowerCase(), resolutions[c.to]]));
    const toTrash = plan.files.filter((f) => byTo.get(this.rel(f.to).toLowerCase()) === 'replace').map((f) => f.to);
    await sendToRecycleBin(toTrash);
    const done = []; const skipped = []; const replaced = toTrash.map((t) => this.rel(t)); const renamed = [];
    const taken = new Set();
    for (const d of plan.dirs) fs.mkdirSync(d.to, { recursive: true });
    for (const f of plan.files) {
      const decision = byTo.get(this.rel(f.to).toLowerCase());
      if (decision === 'skip') { skipped.push(this.rel(f.from)); continue; }
      let to = f.to;
      if (decision === 'keepBoth') {
        to = path.join(path.dirname(f.to), freeName(path.dirname(f.to), path.basename(f.to), false, taken));
        renamed.push({ from: this.rel(f.to), to: this.rel(to) });
      }
      taken.add(to.toLowerCase());
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (op === 'move') {
        try { fs.renameSync(f.from, to); } catch (e) {
          if (e.code !== 'EXDEV') throw e;
          fs.copyFileSync(f.from, to); fs.unlinkSync(f.from);
        }
      } else fs.copyFileSync(f.from, to);
      done.push({ from: this.rel(f.from), to: this.rel(to) });
    }
    // Mover pasta: remove as pastas de origem que ficaram vazias (de baixo para cima). Arquivos "pulados" ficam onde estavam.
    if (op === 'move') {
      for (const d of [...plan.dirs].reverse()) {
        try { if (fs.existsSync(d.from) && !fs.readdirSync(d.from).length) fs.rmdirSync(d.from); } catch { /* ficou algo dentro */ }
      }
    }
    return { op, done, skipped, replaced, renamed };
  }
}

module.exports = { WorkspaceFiles, checkRoot, checkName, isInside, hasGit, sendToRecycleBin };
