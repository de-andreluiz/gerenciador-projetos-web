// Executar um script de apoio direto do item do checklist, numa conexão escolhida (cadastrada ou de uma base do projeto).
// Reaproveita tudo o que já existe: arquivos da lista de Scripts SQL (nada é copiado), variáveis {{NOME}} e a mesma análise/trava
// dos scripts pós-importação (sqlscan + assertStatementSafe), a camada de banco (db.js, processo-filho com timeout) e o audit.log.
//
// Regras de segurança (as mesmas da importação, adaptadas):
//  - comandos bloqueados (USE, BEGIN TRAN, BACKUP, xp_cmdshell…) → nunca executa;
//  - DELETE / DROP / TRUNCATE fora do localhost só se a conexão (ou a base) permitir apagar dados; e sempre com confirmação;
//  - fora do localhost, qualquer comando que altera dados/objetos (UPDATE, INSERT, MERGE, ALTER, CREATE, SQL dinâmico) pede confirmação;
//  - a confirmação é um token do servidor ligado ao texto exato, à conexão e ao banco: mudou algo, pede de novo.
//  - executar NUNCA marca o item como concluído (é ferramenta de apoio); fica só registrado no histórico do item e na auditoria.
const crypto = require('crypto');
const { httpError, str } = require('./util');
const { prepareScript, applyVariables } = require('./sqlscan');
const { BUILTIN_VARS, cleanUserVars, checkVarValue } = require('./scripts-api');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const { who } = require('./auth/identity');
const MODIFY_KW = ['UPDATE', 'INSERT', 'MERGE', 'ALTER', 'CREATE'];
const ENV_LABEL = { prod: 'Produção', hml: 'Homologação', dev: 'Desenvolvimento', local: 'Localhost' };

function mount(app, { store, audit, db, getProject, dataDir, resolveConn, connPassword, publicProject }) {
  const data = () => store.data;
  const content = () => store.scripts(); // .sql local ou versões na nuvem, conforme o backend atual

  // Conexões que o projeto pode usar: as cadastradas e as das bases do próprio projeto.
  function targets(p) {
    const out = data().connections.map((c) => ({ key: `conn:${c.id}`, label: c.name, group: 'Conexões cadastradas', env: c.env, envLabel: ENV_LABEL[c.env], server: db.label(c), database: c.database || '', needsDatabase: !c.database }));
    for (const b of p.bases) for (const env of ['prod', 'local']) {
      if (!b[env]) continue;
      let c; try { c = resolveConn(b[env]); } catch { continue; }
      out.push({ key: `base:${b.id}:${env}`, label: `${b.name} — ${env === 'prod' ? 'Produção' : 'Localhost'}`, group: `Bases do projeto`, env, envLabel: ENV_LABEL[env], server: db.label(c), database: c.database });
    }
    const preferred = [p.defaultConnectionId && `conn:${p.defaultConnectionId}`, data().settings.defaultConnectionId && `conn:${data().settings.defaultConnectionId}`].find((k) => k && out.some((t) => t.key === k));
    return { targets: out, defaultKey: preferred || out.find((t) => t.env === 'local')?.key || out[0]?.key || null };
  }
  app.get('/api/projects/:id/run-targets', (req, res) => res.json(targets(getProject(req.params.id))));

  function resolveTarget(p, key, database) {
    const [kind, a, b] = String(key || '').split(':');
    if (kind === 'conn') {
      const saved = data().connections.find((c) => c.id === a);
      if (!saved) throw httpError(400, 'Conexão cadastrada inexistente.');
      const { id, name, env, allowDestructive, notes, createdAt, updatedAt, ...conn } = saved;
      const db_ = str(database, 128) || saved.database;
      if (!db_) throw httpError(400, `Informe o banco: a conexão “${name}” não tem banco padrão.`);
      const local = env === 'local' && db.isLoopback(conn.server);
      return { conn: { ...conn, database: db_ }, label: name, env, local, allowDestructive: local || !!allowDestructive, baseName: name };
    }
    if (kind === 'base') {
      const base = p.bases.find((x) => x.id === a);
      if (!base || !['prod', 'local'].includes(b) || !base[b]) throw httpError(400, 'Base ou ambiente inexistente neste projeto.');
      const conn = resolveConn(base[b]);
      const local = b === 'local' && db.isLoopback(conn.server);
      if (b === 'local' && !local) throw httpError(400, 'A conexão "Localhost" desta base não aponta para esta máquina.');
      return { conn, label: `${base.name} — ${b === 'prod' ? 'Produção' : 'Localhost'}`, env: b, local, allowDestructive: local || !!base.allowProdOverwrite, baseName: base.name };
    }
    throw httpError(400, 'Escolha a conexão.');
  }

  app.post('/api/projects/:id/checklists/:stepId/items/:iid/run', async (req, res) => {
    const p = getProject(req.params.id);
    const inst = p.checklists.find((c) => c.stepId === req.params.stepId) || (() => { throw httpError(404, 'Checklist deste passo ainda não foi iniciado.'); })();
    const item = inst.items.find((i) => i.id === req.params.iid) || (() => { throw httpError(404, 'Item não encontrado.'); })();
    const scriptId = str(req.body.scriptId, 40);
    if (!item.scriptIds.includes(scriptId)) throw httpError(400, 'Este script não está relacionado a este item do checklist.');
    const s = data().scripts.find((x) => x.id === scriptId) || (() => { throw httpError(404, 'O script foi removido da lista de Scripts SQL.'); })();
    if (!(await content().exists(s))) throw httpError(404, `O conteúdo do script “${s.name}” não foi encontrado.`);
    const t = resolveTarget(p, req.body.target, req.body.database);

    // Texto lido do ARQUIVO agora (nunca da tela) + variáveis: automáticas do destino, as demais informadas na janela.
    const raw = await content().read(s);
    const vars = {
      ...cleanUserVars(req.body.vars),
      BANCO: t.conn.database, SCHEMA: 'dbo', SERVIDOR: t.conn.server, AMBIENTE: t.local ? 'LOCAL' : 'PRODUCAO', PROJETO: p.name, BASE: t.baseName,
    };
    const sub = applyVariables(raw, vars);
    if (sub.missing.length) throw httpError(400, `Informe o valor de ${sub.missing.map((n) => `{{${n}}}`).join(', ')}.`, { code: 'SCRIPT_VARS', missing: sub.missing.filter((n) => !BUILTIN_VARS[n]) });
    for (const [n, v] of Object.entries(sub.used)) checkVarValue(n, v);
    const { batches, analysis } = prepareScript(sub.text);
    if (!batches.length) throw httpError(400, 'O script está vazio.');
    if (analysis.tooManyBatches) throw httpError(400, 'O script tem lotes demais.');
    if (analysis.blocked.length) {
      throw httpError(400, `O app não executa este script: ${analysis.blocked.slice(0, 3).map((b) => `${b.message} (linha ${b.line})`).join('; ')}${analysis.blocked.length > 3 ? '…' : ''}`, { code: 'SCRIPT_BLOCKED' });
    }
    const destructive = analysis.destructive.map((d) => `${d.kw}${d.dynamic ? ' (em SQL dinâmico)' : ''} — linha ${d.line}`);
    if (destructive.length && !t.allowDestructive) {
      throw httpError(403, `Este script apaga dados (${analysis.destructive.map((d) => d.kw).join(', ')}) e a conexão “${t.label}” não permite apagar dados fora do localhost. Rode no Localhost ou habilite “permitir apagar/sobrescrever” na conexão/base.`, { code: 'SCRIPT_DESTRUCTIVE' });
    }
    const modifies = MODIFY_KW.filter((k) => analysis.counts[k]).map((k) => `${k} ×${analysis.counts[k]}`);
    const reasons = [
      ...(destructive.length ? [`Apaga dados: ${destructive.join('; ')}`] : []),
      ...(!t.local && modifies.length ? [`Altera dados/objetos em ${ENV_LABEL[t.env] || t.env}: ${modifies.join(', ')}`] : []),
      ...(!t.local && analysis.dynamic ? ['Usa SQL dinâmico (EXEC / sp_executesql): o app não consegue conferir tudo o que será executado'] : []),
    ];
    const textSha = sha(sub.text);
    const token = sha(JSON.stringify(['run-v1', scriptId, textSha, req.body.target, t.conn.server, t.conn.database]));
    if (reasons.length && req.body.confirmToken !== token) {
      throw httpError(409, 'Confirme a execução.', { code: 'SCRIPT_CONFIRM', confirm: { token, reasons, target: t.label, env: ENV_LABEL[t.env] || t.env, server: db.label(t.conn), database: t.conn.database } });
    }

    // Cancelamento: se a janela fechar/cancelar, a requisição cai e o processo-filho é encerrado (o SQL Server desfaz a transação).
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    // Senha ilegível vira 409 PASSWORD_UNREADABLE aqui, ANTES de qualquer execução (não entra no histórico do item como execução falha).
    const password = await connPassword(t.conn);
    const started = Date.now();
    let out; let error = null;
    try {
      out = await db.runScript(t.conn, password, { name: s.name, batches, allowDestructiveScripts: destructive.length > 0 }, { signal: ac.signal });
    } catch (e) {
      error = e.cancelled ? e.message : db.friendly(e);
      out = e.scriptOutput || null;
    }
    const ms = Date.now() - started;
    const run = {
      at: new Date().toISOString(), scriptId, scriptName: s.name, target: t.label, env: t.env, server: db.label(t.conn), database: t.conn.database, ok: !error, ms,
      batches: out?.batches ?? 0, returned: out?.returned ?? 0, affected: out?.affected ?? 0, error: error ? error.slice(0, 400) : null, by: who(),
    };
    item.runs = [...(item.runs || []), run].slice(-20); // histórico curto no item (sem os dados retornados)
    await store.save();
    audit.log({ action: error ? 'script-falhou' : 'script-executado', project: p.name, by: run.by, etapa: inst.stageName, item: item.title, detalhe: `${s.name} em ${t.label}`,
      env: t.local ? 'local' : 'prod', server: run.server, database: run.database, ms, resultado: error ? error.slice(0, 200) : `${run.returned} linha(s) retornada(s), ${run.affected} afetada(s)`, sha256: textSha });
    if (ac.signal.aborted) return;
    res.json({ ok: !error, error, run, ms, target: t.label, identity: out?.identity || null, results: out?.results || [], messages: out?.messages || [],
      affected: run.affected, returned: run.returned, batches: run.batches, totalBatches: batches.length, truncated: !!out?.truncated, errorInfo: out?.error || null, project: publicProject(p) });
  });

  // Variáveis que o script vai pedir (as automáticas são preenchidas pelo app).
  app.get('/api/scripts/:id/variables', async (req, res) => {
    const s = data().scripts.find((x) => x.id === req.params.id) || (() => { throw httpError(404, 'Script não encontrado.'); })();
    const { analysis } = prepareScript((await content().exists(s)) ? await content().read(s) : '');
    res.json({ user: analysis.variables.filter((n) => !BUILTIN_VARS[n]), builtin: analysis.variables.filter((n) => BUILTIN_VARS[n]) });
  });

  return { targets };
}

module.exports = { mount };
