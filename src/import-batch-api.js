// Importação por DIRETÓRIO (lote) — rotas. Reaproveita o pipeline da importação de arquivo único: readWorkbook (src/xlsx.js),
// sqlplan.describeSheets/buildPlan (mesmas conversões, nomes e travas), db.precheck/executePlan (processo-filho, rede, trava),
// scripts pós-importação (scriptsMod.loadForPlan + sqlplan.buildScriptPlan) e o mesmo mapa de jobs (/api/jobs/:id).
//
// Diferenças em relação ao arquivo único (decisões explícitas, mostradas na tela):
//  - Transação POR ABA: cada aba vira um plano próprio (guard/drop/rename → CREATE → INSERT → COUNT) executado na sua transação.
//    Uma aba que falha é desfeita sozinha e as demais seguem; o resultado é mostrado aba por aba.
//  - Scripts pós-importação: rodam no FIM, numa transação própria, só se TODAS as abas foram importadas (senão: não rodam, e a
//    tela diz por quê). Na simulação (só localhost) cada aba é desfeita, então os scripts não são simulados.
//  - Memória: um arquivo por vez. No plano, cada aba é convertida e só o hash/resumo fica guardado; na execução a aba é
//    regerada do arquivo e o hash precisa bater com o revisado (senão: "a planilha mudou depois da revisão").
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError, str } = require('./util');
const plans = require('./sqlplan');
const B = require('./import-batch');

function mount(app, { store, audit, getProject, getIn, resolveConn, connPassword, db, scriptsMod, scriptsApi, readWorkbook, jobs, PLAN_TTL_MS, whoAmI }) {
  const planStore = new Map();
  const cleanupPlans = () => { const now = Date.now(); for (const [id, p] of planStore) if (p.expiresAt < now) planStore.delete(id); };
  const described = new Map(); // caminho|mtime|tamanho → abas descritas (só metadados: nomes, linhas, colunas sugeridas)

  // Planilha configurada para importação por diretório, com o diretório validado.
  function batchDepara(project, deparaId) {
    const d = getIn(project.deparas, str(deparaId, 40), 'Planilha');
    if (d.importable === false) throw httpError(403, `A planilha "${d.label}" não está marcada para permitir importação. Habilite em "Editar" na planilha.`);
    if (d.importMode !== 'dir') throw httpError(400, `A planilha "${d.label}" está configurada para importação de arquivo único.`);
    if (!d.sourceDir) throw httpError(400, `Informe o diretório das planilhas em "Editar" na planilha "${d.label}".`);
    return d;
  }
  function readDir(dir) {
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) throw httpError(400, `O caminho ${dir} não é um diretório.`);
      return B.spreadsheetEntries(fs.readdirSync(dir, { withFileTypes: true }));
    } catch (e) {
      if (e.status) throw e;
      if (e.code === 'ENOENT') throw httpError(400, `O diretório ${dir} não existe (foi movido ou renomeado?). Ajuste em "Editar" na planilha.`, { code: 'BATCH_DIR_MISSING' });
      if (e.code === 'EACCES' || e.code === 'EPERM') throw httpError(400, `Sem permissão para ler o diretório ${dir}.`, { code: 'BATCH_DIR_DENIED' });
      throw httpError(400, `Não foi possível ler o diretório ${dir}: ${e.message}`);
    }
  }
  const fileIn = (d, name) => path.join(d.sourceDir, B.cleanFileName(name));
  async function describe(abs) {
    let st;
    try { st = fs.statSync(abs); } catch { throw httpError(400, `Arquivo não encontrado: ${path.basename(abs)} (foi removido ou renomeado?).`); }
    const key = `${abs}|${st.mtimeMs}|${st.size}`;
    if (described.has(key)) return described.get(key);
    const wb = await readWorkbook(abs); // um arquivo por vez; o conteúdo não fica guardado
    const out = plans.describeSheets(wb);
    if (described.size > 300) described.clear();
    described.set(key, out);
    return out;
  }

  // ---------- Descoberta ----------
  app.post('/api/import/batch/scan', (req, res) => {
    const project = getProject(str(req.body.projectId, 40));
    const d = batchDepara(project, req.body.deparaId);
    const names = readDir(d.sourceDir);
    const files = names.map((name) => {
      try { const st = fs.statSync(path.join(d.sourceDir, name)); return { name, size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; }
    }).filter(Boolean);
    res.json({ dir: d.sourceDir, files, truncated: names.length >= B.MAX_FILES });
  });

  // Abas de UM arquivo (lido sob demanda, um de cada vez). Erro de leitura = só deste arquivo.
  app.post('/api/import/batch/sheets', async (req, res) => {
    const project = getProject(str(req.body.projectId, 40));
    const d = batchDepara(project, req.body.deparaId);
    const sheets = await describe(fileIn(d, req.body.file));
    const bases = B.baseNames(req.body.file, sheets);
    res.json({ file: req.body.file, sheets: sheets.map((s, i) => ({ name: s.name, hidden: s.hidden, rowCount: s.rowCount, columns: s.columns.length, notes: s.notes, base: bases[i] })) });
  });

  // Lembra a seleção (arquivos, abas, nomes, schema, scripts) por planilha. Nunca o modo de sobrescrita.
  function rememberBatch(project, deparaId, cfg) {
    const d = project.deparas.find((x) => x.id === deparaId);
    if (!d || !cfg) return;
    d.batchConfig = B.cleanBatchConfig(cfg, scriptsApi.cleanUserVars);
    return store.save(); // quem chama aguarda
  }
  app.put('/api/projects/:id/deparas/:did/batch-config', async (req, res) => {
    const p = getProject(req.params.id);
    getIn(p.deparas, req.params.did, 'Planilha');
    await rememberBatch(p, req.params.did, req.body);
    res.json({ ok: true });
  });

  // ---------- Plano (revisão) ----------
  app.post('/api/import/batch/plan', async (req, res) => {
    cleanupPlans();
    const project = getProject(str(req.body.projectId, 40));
    const base = getIn(project.bases, str(req.body.baseId, 40), 'Base');
    const d = batchDepara(project, req.body.deparaId);
    readDir(d.sourceDir); // diretório ainda existe e é legível
    const env = req.body.env === 'prod' ? 'prod' : 'local';
    const conn = resolveConn(base[env]);
    if (!conn) throw httpError(400, `Esta base não tem conexão de ${env === 'prod' ? 'Produção' : 'Localhost'} configurada.`);
    if (env === 'local' && !db.isLoopback(conn.server)) throw httpError(400, 'Conexão local precisa apontar para esta máquina.');
    const items = B.cleanItems(req.body.items, req.body.schema);
    const useTypes = !!req.body.suggestedTypes;
    const now = Date.now();

    // Scripts: os mesmos da importação de arquivo único (lidos dos arquivos agora, analisados, variáveis automáticas do destino).
    const scriptVars = { ...scriptsApi.cleanUserVars(req.body.scriptVars), BANCO: conn.database, SCHEMA: items[0].schema, SERVIDOR: conn.server, AMBIENTE: env === 'prod' ? 'PRODUCAO' : 'LOCAL', PROJETO: project.name, BASE: base.name };
    const userScripts = await scriptsMod.loadForPlan(req.body.scriptIds, scriptVars);
    const scriptsDestructiveOk = env === 'local' || !!base.allowProdOverwrite;
    const scriptPlan = userScripts.length ? plans.buildScriptPlan(userScripts, { env }) : null;

    const issues = [];
    for (const dup of B.duplicateTables(items)) issues.push(`A tabela ${dup.table} foi escolhida para duas abas (${dup.a} e ${dup.b}). Cada aba precisa de uma tabela própria: mude um dos nomes.`);
    for (const s of userScripts) if (s.analysis.destructive.length && !scriptsDestructiveOk) issues.push(`O script “${s.name}” contém ${s.analysis.destructive.map((x) => `${x.kw} ×${x.count}`).join(', ')} e esta base não permite apagar/sobrescrever em PRODUÇÃO.`);

    // Cada arquivo é lido uma vez, em sequência; cada aba vira um plano próprio (validado e com hash), e o conteúdo é descartado.
    const byFile = new Map();
    items.forEach((it) => { if (!byFile.has(it.file)) byFile.set(it.file, []); byFile.get(it.file).push(it); });
    for (const [file, list] of byFile) {
      let wb = null; let descs = null;
      try { wb = await readWorkbook(fileIn(d, file)); descs = plans.describeSheets(wb); } catch (e) { for (const it of list) Object.assign(it, { status: 'blocked', reason: e.message }); continue; }
      for (const it of list) {
        const di = descs.findIndex((x) => x.name === it.sheet);
        if (di < 0) { Object.assign(it, { status: 'blocked', reason: `A aba “${it.sheet}” não existe mais em ${file} (foi renomeada ou removida).` }); continue; }
        if (!descs[di].columns.length) { Object.assign(it, { status: 'blocked', reason: 'Aba vazia (sem colunas).' }); continue; }
        it.columns = B.columnsFor(descs[di], useTypes);
        try {
          const pl = plans.buildPlan(wb, [{ sheetName: it.sheet, schema: it.schema, tableName: it.table, mode: it.mode, columns: it.columns }], { env, allowOverwrite: base.allowProdOverwrite, now });
          const t = pl.tables[0];
          Object.assign(it, { rows: t.rows, backupName: t.backupName || null, hash: pl.hash, statements: pl.statements.length });
          if (pl.errors.length) {
            const e0 = pl.errors[0];
            Object.assign(it, { status: 'blocked', reason: `${pl.errors.length}${pl.errors.length >= 50 ? '+' : ''} valor(es) não convertidos para o tipo sugerido (ex.: linha ${e0.row}, coluna ${e0.column}: ${e0.message}). Desmarque “Usar tipos sugeridos” para importar tudo como texto.` });
          } else it.status = 'ok';
        } catch (e) { Object.assign(it, { status: 'blocked', reason: e.message }); }
      }
      wb = null; // libera a planilha antes de abrir a próxima
    }

    // Pré-checagem somente leitura no destino (identidade, permissão, schema, tabelas existentes) — mesma da importação atual.
    const checkable = items.filter((it) => it.status === 'ok');
    const pre = await db.precheck(conn, await connPassword(conn), checkable.length ? checkable.map((t) => ({ schema: t.schema, table: t.table })) : [{ schema: items[0].schema, table: items[0].table }]);
    if (!pre.canCreateTable) issues.push('O login usado não tem permissão CREATE TABLE neste banco.');
    const missingSchemas = new Set();
    checkable.forEach((it, i) => {
      const c = pre.tables[i];
      Object.assign(it, { exists: c.exists, existingRows: c.rowCount });
      if (!c.schemaExists) missingSchemas.add(it.schema);
      if (c.exists && it.mode === 'fail') Object.assign(it, { status: 'blocked', reason: `A tabela ${it.schema}.${it.table} já existe. Escolha “Substituir” ou “Renomear a antiga” para esta aba, ou mude o nome.` });
    });
    for (const s of missingSchemas) issues.push(`O schema "${s}" não existe no banco (o app não cria schemas).`);
    const runnable = items.filter((it) => it.status === 'ok');
    if (!runnable.length && !issues.length) issues.push('Nenhuma aba pode ser importada: veja o motivo de cada uma na lista.');

    const target = { server: pre.identity.server, connectedTo: db.label(conn), database: pre.identity.database, login: pre.identity.login, version: pre.identity.version, auth: conn.auth };
    const h = crypto.createHash('sha256');
    for (const it of runnable) h.update(`${it.file}\u0001${it.sheet}\u0001${it.hash}\u0002`);
    if (scriptPlan) h.update(`scripts\u0001${scriptPlan.hash}`);
    const hash = h.digest('hex');
    const planId = crypto.randomBytes(16).toString('hex');
    const scriptSummary = userScripts.map((s) => ({ id: s.id, name: s.name, file: s.file, sha256: s.sha256, batches: s.batches.length, variables: s.variables, analysis: s.analysis }));
    const entry = { id: planId, kind: 'batch', hash, dir: d.sourceDir, deparaId: d.id, conn, target, env, now, items, scriptPlan, scriptSummary, allowScriptsDestructive: scriptsDestructiveOk,
      allowOverwrite: base.allowProdOverwrite, projectId: project.id, projectName: project.name, baseName: base.name, issues, used: false, expiresAt: Date.now() + PLAN_TTL_MS };
    planStore.set(planId, entry);
    await rememberBatch(project, d.id, req.body.saveConfig);
    audit.log({ action: 'lote-plano-gerado', project: project.name, base: base.name, env, server: target.connectedTo, database: target.database, hash, arquivo: d.sourceDir,
      tabelas: runnable.map((t) => ({ tabela: `${t.schema}.${t.table}`, modo: t.mode, linhas: t.rows, arquivo: t.file, aba: t.sheet })), bloqueadas: items.length - runnable.length, bloqueios: issues.length,
      scripts: scriptSummary.map((s) => ({ nome: s.name, arquivo: s.file, lotes: s.batches, sha256: s.sha256 })) });

    const pub = (it) => ({ file: it.file, sheet: it.sheet, schema: it.schema, table: it.table, mode: it.mode, rows: it.rows ?? null, columns: it.columns?.length ?? null,
      status: it.status, reason: it.reason || null, exists: !!it.exists, existingRows: it.existingRows ?? null, backupName: it.backupName || null });
    res.json({
      planId, hash, env, target, dir: d.sourceDir, items: items.map(pub), issues, blocked: issues.length > 0 || !runnable.length,
      runnable: runnable.length, totalRows: runnable.reduce((n, t) => n + t.rows, 0), userScripts: scriptSummary,
      scriptPreview: scriptPlan ? plans.renderScript(scriptPlan, target, { preview: true }) : null, expiresAt: entry.expiresAt,
    });
  });

  // ---------- Execução: aba por aba (transação própria), scripts no fim ----------
  app.post('/api/import/batch/plans/:id/execute', async (req, res) => {
    const e = planStore.get(req.params.id);
    if (!e || e.expiresAt < Date.now()) throw httpError(404, 'Plano expirado. Gere o plano novamente.');
    if (e.used) throw httpError(409, 'Este plano já foi executado. Gere um novo plano.');
    if (e.issues.length) throw httpError(409, 'O plano tem bloqueios e não pode ser executado.');
    if (req.body.hash !== e.hash) throw httpError(409, 'O plano autorizado não corresponde ao plano gerado.');
    if (req.body.authorized !== true) throw httpError(403, 'Autorização explícita ausente.');
    const dryRun = !!req.body.dryRun;
    if (dryRun && e.env === 'prod') throw httpError(400, 'Simulação só é permitida no Localhost.');
    e.used = true;

    const runnable = e.items.filter((it) => it.status === 'ok');
    const jobId = crypto.randomBytes(8).toString('hex');
    const job = { id: jobId, kind: 'batch', status: 'running', dryRun, done: 0, total: runnable.length, current: null,
      items: e.items.map((it) => ({ file: it.file, sheet: it.sheet, table: `${it.schema}.${it.table}`, rows: it.rows ?? null, status: it.status === 'ok' ? 'pending' : 'skipped', error: it.status === 'ok' ? null : it.reason })),
      scripts: e.scriptPlan ? { status: 'pending', names: e.scriptSummary.map((s) => s.name) } : null };
    jobs.set(jobId, job);
    const meta = { project: e.projectName, base: e.baseName, env: e.env, server: e.target.connectedTo, database: e.target.database, login: e.target.login, hash: e.hash, dryRun, by: whoAmI() };
    audit.log({ action: 'lote-iniciado', ...meta, arquivo: e.dir, resultado: `${runnable.length} aba(s)` });

    (async () => {
      const pw = await connPassword(e.conn);
      const byFile = new Map();
      runnable.forEach((it) => { if (!byFile.has(it.file)) byFile.set(it.file, []); byFile.get(it.file).push(it); });
      for (const [file, list] of byFile) {
        let wb = null; let readErr = null;
        try { wb = await readWorkbook(path.join(e.dir, file)); } catch (err) { readErr = err.message; }
        for (const it of list) {
          const ji = job.items.find((x) => x.file === it.file && x.sheet === it.sheet);
          job.current = `${it.file} / ${it.sheet}`; ji.status = 'running'; job.stepDone = 0; job.stepTotal = it.statements;
          try {
            if (readErr) throw new Error(readErr);
            const pl = plans.buildPlan(wb, [{ sheetName: it.sheet, schema: it.schema, tableName: it.table, mode: it.mode, columns: it.columns }], { env: e.env, allowOverwrite: e.allowOverwrite, now: e.now });
            if (pl.hash !== it.hash) throw httpError(409, 'A planilha mudou depois da revisão (conteúdo, aba ou colunas). Gere o plano de novo.');
            const r = await db.executePlan(e.conn, pw, pl, { dryRun, allowDestructive: pl.destructive.length > 0, allowDestructiveScripts: false, onProgress: (n) => { job.stepDone = n; } });
            Object.assign(ji, { status: 'done', committed: !!r.committed });
            audit.log({ action: dryRun ? 'lote-item-simulado' : 'lote-item-importado', ...meta, arquivo: it.file, detalhe: `${it.file} / ${it.sheet}`, tabelas: [{ tabela: ji.table, modo: it.mode, linhas: it.rows }] });
          } catch (err) {
            Object.assign(ji, { status: 'error', error: err.status ? err.message : db.friendly(err) });
            audit.log({ action: 'lote-item-falhou', ...meta, arquivo: it.file, detalhe: `${it.file} / ${it.sheet}`, erro: ji.error, resultado: 'ROLLBACK desta aba' });
          }
          job.done++;
        }
        wb = null; // um arquivo por vez
      }
      const failed = job.items.filter((x) => x.status === 'error').length;
      // Scripts pós-importação: no fim, numa transação própria, só se todas as abas foram importadas de verdade.
      if (job.scripts) {
        if (dryRun) Object.assign(job.scripts, { status: 'skipped', reason: 'Simulação: as tabelas foram desfeitas, então os scripts não são executados.' });
        else if (failed) Object.assign(job.scripts, { status: 'skipped', reason: `Não executados porque ${failed} aba(s) falharam. Corrija e importe de novo (ou rode os scripts depois).` });
        else {
          job.current = 'Scripts pós-importação'; job.stepDone = 0; job.stepTotal = e.scriptPlan.statements.length;
          try {
            const r = await db.executePlan(e.conn, pw, e.scriptPlan, { allowDestructive: false, allowDestructiveScripts: e.allowScriptsDestructive, onProgress: (n) => { job.stepDone = n; } });
            Object.assign(job.scripts, { status: 'done', output: r.scripts || [] });
            audit.log({ action: 'lote-scripts-executados', ...meta, scripts: e.scriptSummary.map((s) => ({ nome: s.name, arquivo: s.file, lotes: s.batches, sha256: s.sha256 })) });
          } catch (err) {
            Object.assign(job.scripts, { status: 'error', error: db.friendly(err), output: err.scriptOutput || [] });
            audit.log({ action: 'lote-scripts-falharam', ...meta, erro: db.friendly(err), resultado: 'ROLLBACK dos scripts (as tabelas importadas continuam)' });
          }
        }
      }
      const okN = job.items.filter((x) => x.status === 'done').length;
      Object.assign(job, { status: 'done', current: null, result: { ok: okN, failed, skipped: job.items.filter((x) => x.status === 'skipped').length } });
      audit.log({ action: failed ? 'lote-concluido-com-falhas' : 'lote-concluido', ...meta, resultado: `${okN} importada(s)${failed ? `, ${failed} com falha` : ''}${dryRun ? ' (simulação: tudo desfeito)' : ''}` });
    })().catch((err) => Object.assign(job, { status: 'error', error: db.friendly(err) }));
    res.json({ jobId });
  });

  return { planStore };
}

module.exports = { mount };
