// Scripts SQL do usuário (executados depois da importação da planilha, na mesma base e na mesma transação).
// Metadados no estado do app (data.scripts); o SQL fica na área de conteúdo de scripts (src/files/script-content.js):
// arquivos .sql locais ou, no modo nuvem, versões em public.script_versions + cópia de trabalho local para o SSMS/VS Code.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { httpError, uid, str } = require('./util');
const EH = require('./evidence-http');
const { prepareScript, analyzeScript, decodeSqlBuffer, applyVariables, MAX_SCRIPT_CHARS, MAX_BATCHES } = require('./sqlscan');

const MAX_SCRIPTS_PER_PLAN = 30;

// ---------- Variáveis {{NOME}} ----------
// Automáticas: preenchidas pelo app a partir do destino da importação (não podem ser redefinidas).
const BUILTIN_VARS = {
  BANCO: 'banco de dados de destino da importação (Localhost ou Produção, conforme o escolhido)',
  SCHEMA: 'schema escolhido na importação (ex.: dbo)',
  SERVIDOR: 'servidor da conexão usada',
  AMBIENTE: 'LOCAL ou PRODUCAO',
  PROJETO: 'nome do projeto',
  BASE: 'nome da base no app',
};
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
// O valor entra no texto do SQL: só letras, números, espaço, "_", "." e "-" (sem aspas, colchetes, ";" nem "--"),
// para que nunca consiga fechar um texto '...' nem começar um comando/comentário novo.
const VAR_VALUE_RE = /^[\p{L}\p{N}_. -]{1,128}$/u;
function checkVarValue(name, value) {
  const v = String(value ?? '');
  if (!VAR_VALUE_RE.test(v) || v.includes('--')) {
    throw httpError(400, `O valor da variável {{${name}}} (“${v.slice(0, 60)}”) tem caracteres não permitidos. Use só letras, números, espaço, _ . -`);
  }
  return v;
}
// Variáveis definidas pelo usuário na importação: { NOME: valor } (nomes automáticos são ignorados).
function cleanUserVars(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw).slice(0, 50)) {
    const name = String(k).toUpperCase();
    if (!VAR_NAME_RE.test(name) || BUILTIN_VARS[name]) continue;
    const val = str(v, 128);
    if (val) out[name] = val;
  }
  return out;
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function mount(app, { store, dataDir, SYS }) {
  const content = () => store.scripts();
  const list = () => store.data.scripts;
  const byId = (id) => list().find((s) => s.id === id) || (() => { throw httpError(404, 'Script não encontrado.'); })();

  // Resumo do que a análise achou (sem o texto do script).
  const summarize = (a) => ({
    batches: a.batches, blocked: a.blocked, destructive: a.destructive, counts: a.counts, dynamic: a.dynamic, tooManyBatches: a.tooManyBatches, variables: a.variables || [],
  });

  async function publicScript(s, { withAnalysis = false } = {}) {
    const c = content();
    const st = await c.stat(s);
    const out = { ...s, exists: !!st, size: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null, storage: c.kind };
    if (withAnalysis && st) { try { out.analysis = summarize(analyzeScript(await c.read(s))); } catch (e) { out.readError = e.message; } }
    if (c.kind === 'cloud') { const wc = await c.workingCopy(s); out.workingCopy = wc ? { changed: wc.changed, stale: wc.stale } : null; }
    return out;
  }

  function cleanMeta(b, ignoreId) {
    const name = str(b.name, 120);
    if (!name) throw httpError(400, 'Informe o nome do script.');
    if (list().some((s) => s.id !== ignoreId && s.name.toLowerCase() === name.toLowerCase())) throw httpError(409, `Já existe um script chamado “${name}”.`);
    return { name, description: str(b.description, 400) };
  }
  function cleanContent(c) {
    const text = String(c ?? '');
    if (!text.trim()) throw httpError(400, 'O script está vazio.');
    if (text.length > MAX_SCRIPT_CHARS) throw httpError(400, 'Script grande demais (máximo de ~1,5 milhão de caracteres).');
    return text;
  }

  // ---------- CRUD ----------
  app.get('/api/scripts', async (req, res) => {
    const out = [];
    for (const s of list()) out.push(await publicScript(s, { withAnalysis: true }));
    res.json(out);
  });

  app.get('/api/scripts/:id', async (req, res) => {
    const s = byId(req.params.id);
    const pub = await publicScript(s, { withAnalysis: true });
    if (!pub.exists) throw httpError(404, content().kind === 'cloud' ? `O conteúdo do script “${s.name}” não foi encontrado na nuvem.` : `O arquivo ${s.file} não foi encontrado na pasta de scripts.`);
    res.json({ ...pub, content: await content().read(s) });
  });

  // Análise ao vivo enquanto o script é digitado (não grava nada).
  app.post('/api/scripts/analyze', (req, res) => res.json(summarize(analyzeScript(String(req.body.content ?? '')))));

  app.post('/api/scripts', async (req, res) => {
    const meta = cleanMeta(req.body);
    const text = cleanContent(req.body.content);
    const s = await createScript(meta, text);
    res.json(await publicScript(s, { withAnalysis: true }));
  });

  // Cadastro primeiro (na nuvem a versão do conteúdo referencia o script), conteúdo depois. Se o conteúdo não puder ser gravado,
  // o cadastro é desfeito — nunca fica um script "sem conteúdo".
  async function createScript(meta, text) {
    const file = content().newFileName(meta.name, list().map((x) => x.file));
    const now = new Date().toISOString();
    const s = { id: uid(), ...meta, file, createdAt: now, updatedAt: now };
    if (content().kind === 'local') await content().write(s, text); // local: o arquivo antes (comportamento de sempre)
    list().push(s);
    await store.save();
    if (content().kind !== 'local') {
      try { await content().write(s, text); } catch (e) {
        store.data.scripts = list().filter((x) => x.id !== s.id);
        await store.save().catch(() => {});
        await EH.asHttp(Promise.reject(e)); // erro da nuvem vira erro HTTP com code
      }
    }
    return s;
  }

  // Traz para o app um .sql que já existe no computador (copia o conteúdo; o original não é alterado).
  app.post('/api/scripts/import-file', async (req, res) => {
    const src = path.resolve(str(req.body.filePath, 600));
    if (!/\.sql$/i.test(src) || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw httpError(400, 'Selecione um arquivo .sql existente.');
    if (fs.statSync(src).size > MAX_SCRIPT_CHARS * 4) throw httpError(400, 'Arquivo grande demais.');
    const text = cleanContent(decodeSqlBuffer(fs.readFileSync(src)));
    let name = str(req.body.name, 120) || path.basename(src, path.extname(src));
    // se já existir um script com esse nome, acrescenta um sufixo em vez de recusar
    const taken = new Set(list().map((s) => s.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) { let i = 2; while (taken.has(`${name} (${i})`.toLowerCase())) i++; name = `${name} (${i})`; }
    const meta = cleanMeta({ name, description: req.body.description });
    const s = await createScript(meta, text);
    res.json(await publicScript(s, { withAnalysis: true }));
  });

  app.put('/api/scripts/:id', async (req, res) => {
    const s = byId(req.params.id);
    // Valida tudo e grava o conteúdo ANTES de mexer no cadastro em memória: conteúdo recusado (ex.: 403 na nuvem) não deixa
    // alteração de nome/descrição pendurada na memória para ir junto no próximo salvamento.
    const meta = cleanMeta(req.body, s.id);
    if (req.body.content !== undefined) await EH.asHttp(content().write(s, cleanContent(req.body.content)));
    Object.assign(s, meta);
    s.updatedAt = new Date().toISOString();
    await store.save();
    res.json(await publicScript(s, { withAnalysis: true }));
  });

  // Modo nuvem: a cópia de trabalho editada no SSMS/VS Code vira a versão nova (se ninguém alterou o script desde que ela foi aberta).
  app.post('/api/scripts/:id/push', async (req, res) => {
    const s = byId(req.params.id);
    const r = await EH.asHttp(content().pushWorkingCopy(s, cleanContent));
    if (r.pushed) { s.updatedAt = new Date().toISOString(); await store.save(); }
    res.json({ ...r, script: await publicScript(s, { withAnalysis: true }) });
  });

  // Remove o cadastro e guarda o conteúdo em .removidos (recuperável): local = pasta de scripts; nuvem = cópia nesta máquina.
  app.delete('/api/scripts/:id', async (req, res) => {
    const s = byId(req.params.id);
    await EH.asHttp(content().trash(s));
    store.data.scripts = list().filter((x) => x.id !== s.id);
    await store.save();
    res.json({ ok: true });
  });

  const explorer = SYS ? path.join(SYS, 'explorer.exe') : null;
  // Abre para editar por fora: programa padrão (ex.: SSMS), VS Code ou "mostrar no Explorer". Só o arquivo cadastrado; nada é executado.
  app.post('/api/scripts/:id/open', async (req, res) => {
    const s = byId(req.params.id);
    if (!(await content().exists(s))) throw httpError(404, 'O arquivo do script não foi encontrado.');
    const abs = await EH.asHttp(content().openPath(s)); // nuvem: cópia de trabalho local (edição pendente nunca é sobrescrita)
    const how = req.body?.app;
    if (how === 'vscode') {
      const code = require('./workspace-api').findVsCode();
      if (!code) throw httpError(404, 'VS Code não encontrado neste computador. Use “Abrir” (programa padrão).', { code: 'NO_VSCODE' });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE; // o VS Code também é Electron: não pode herdar o modo "node" do app
      spawn(code, [abs], { detached: true, stdio: 'ignore', env }).unref();
    } else if (how === 'explorer') {
      if (!explorer) throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
      spawn(explorer, [`/select,${abs}`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      if (!explorer) throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
      spawn(explorer, [abs], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ ok: true });
  });
  app.post('/api/scripts-folder/open', (req, res) => {
    if (!explorer) throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
    fs.mkdirSync(content().dir, { recursive: true });
    spawn(explorer, [content().dir], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  });

  // ---------- Uso no plano de importação ----------
  // Lê os arquivos AGORA (nunca confia em conteúdo vindo da tela), troca as variáveis {{NOME}}, analisa o texto JÁ
  // substituído e devolve os lotes que serão executados. vars = valores automáticos + os definidos na importação.
  async function loadForPlan(ids, vars = {}) {
    const wanted = Array.isArray(ids) ? ids.map((i) => str(i, 40)).filter(Boolean) : [];
    if (wanted.length > MAX_SCRIPTS_PER_PLAN) throw httpError(400, `No máximo ${MAX_SCRIPTS_PER_PLAN} scripts por importação.`);
    if (new Set(wanted).size !== wanted.length) throw httpError(400, 'Script selecionado mais de uma vez.');
    const out = [];
    let totalBatches = 0;
    for (const id of wanted) {
      const s = byId(id);
      if (!(await content().exists(s))) throw httpError(400, `O conteúdo do script “${s.name}” (${s.file}) não foi encontrado.`);
      const raw = await content().read(s);
      const sub = applyVariables(raw, vars);
      if (sub.missing.length) {
        throw httpError(400, `O script “${s.name}” usa ${sub.missing.map((n) => `{{${n}}}`).join(', ')} sem valor definido. Preencha em “Executar scripts SQL depois de importar” (passo 2).`);
      }
      for (const [n, v] of Object.entries(sub.used)) checkVarValue(n, v);
      const text = sub.text;
      const { batches, analysis } = prepareScript(text);
      if (!batches.length) throw httpError(400, `O script “${s.name}” está vazio.`);
      if (analysis.tooManyBatches) throw httpError(400, `O script “${s.name}” tem lotes demais (máximo de ${MAX_BATCHES}).`);
      if (analysis.blocked.length) {
        const first = analysis.blocked.slice(0, 3).map((b) => `${b.message} (linha ${b.line})`).join('; ');
        throw httpError(400, `O script “${s.name}” não pode ser executado pelo app: ${first}${analysis.blocked.length > 3 ? '…' : ''}`);
      }
      totalBatches += batches.length;
      // sha256 = conteúdo do ARQUIVO (identifica a versão do script); o texto substituído entra no hash do plano.
      out.push({ id: s.id, name: s.name, file: s.file, sha256: sha(raw), variables: sub.used, batches, analysis: { ...summarize(analysis), variables: Object.keys(sub.used) } });
    }
    if (totalBatches > 2000) throw httpError(400, 'Lotes demais nos scripts selecionados (máximo de 2000).');
    return out;
  }

  app.get('/api/scripts-variables', (req, res) => res.json(Object.entries(BUILTIN_VARS).map(([name, description]) => ({ name, description }))));

  return { loadForPlan, publicScript };
}

module.exports = { mount, BUILTIN_VARS, cleanUserVars, checkVarValue };
