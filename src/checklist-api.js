// Rotas dos checklists: modelo reutilizável (Configurações), execução por projeto/passo do ciclo e evidências.
// Regras em src/checklist.js; validação e armazenamento de anexos em src/evidence.js. Auditoria no audit.log existente.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { httpError, uid, str } = require('./util');
const C = require('./checklist');
const { applyGreeting } = require('./greeting');
const cycles = require('./cycles');
const E = require('./evidence');

const EH = require('./evidence-http');
const EM = require('./email');
const { readBody } = EH;
const whoAmI = EH.whoAmI;

function mount(app, { store, audit, getProject, getIn, dataDir, SYS, publicProject }) {
  const data = () => store.data;
  const files = () => store.files('evidence'); // local (pasta) ou nuvem (Storage cifrado), conforme o backend atual
  const explorer = SYS ? path.join(SYS, 'explorer.exe') : null;
  const log = (action, p, extra = {}) => audit.log({ action, project: p?.name, by: whoAmI(), ...extra });

  // ---------- Configuração de evidências (tamanho máximo e extensões por tipo) ----------
  app.put('/api/settings/evidence', async (req, res) => {
    data().settings.evidence = E.cleanConfig(req.body || {});
    await store.save();
    log('evidencia-config', null, { detalhe: `máx. ${data().settings.evidence.maxMB} MB` });
    res.json({ evidence: E.getConfig(data().settings) });
  });

  // ---------- Modelo (definição): checklists reutilizáveis ----------
  // Checklist é um cadastro próprio (não pertence a estágio nem a ciclo). Quem o associa a um estágio é o passo do ciclo
  // (PUT /api/cycles/:id/steps/:stepId/checklists, em config-api.js): o mesmo checklist pode estar em vários ciclos, sem cópia.
  const defOrThrow = (id) => getIn(data().checklistItems, id, 'Item do checklist');
  const listOrThrow = (id) => getIn(data().checklists, id, 'Checklist');
  const MAX_CHECKLISTS = 200;
  // Estágio para o qual o checklist é cadastrado (opcional): forma o conjunto disponível do estágio, que é o padrão das etapas do ciclo.
  function cleanListStage(b) {
    const id = str(b.stageId, 40) || null;
    if (id && !data().stages.some((s) => s.id === id)) throw httpError(400, 'Estágio inexistente.');
    return id;
  }
  // Nome único dentro do mesmo estágio (o mesmo nome pode existir em estágios diferentes).
  function cleanListName(b, stageId, ignoreId) {
    const name = str(b.name, 80);
    if (!name) throw httpError(400, 'Informe o nome do checklist.');
    if (data().checklists.some((c) => c.id !== ignoreId && (c.stageId || null) === stageId && c.name.trim().toLowerCase() === name.toLowerCase())) throw httpError(409, `Já existe um checklist chamado “${name}”${stageId ? ' neste estágio' : ''}.`);
    return name;
  }

  app.post('/api/checklists', async (req, res) => {
    if (data().checklists.length >= MAX_CHECKLISTS) throw httpError(400, `No máximo ${MAX_CHECKLISTS} checklists cadastrados.`);
    const stageId = cleanListStage(req.body);
    const c = { id: uid(), name: cleanListName(req.body, stageId), stageId };
    data().checklists.push(c);
    await store.save();
    log('checklist-modelo-alterado', null, { detalhe: `Checklist “${c.name}” criado` });
    res.json(c);
  });
  app.put('/api/checklists/:cid', async (req, res) => {
    const c = listOrThrow(req.params.cid);
    const old = c.name;
    const stageId = req.body.stageId === undefined ? (c.stageId || null) : cleanListStage(req.body);
    // Nome repetido já existente continua aceito enquanto nem o nome nem o estágio mudam.
    c.name = str(req.body.name, 80) === old && stageId === (c.stageId || null) ? old : cleanListName(req.body, stageId, c.id);
    c.stageId = stageId; // só muda o conjunto disponível do estágio: as etapas de ciclo que já usam o checklist continuam usando
    await store.save();
    if (old !== c.name) log('checklist-modelo-alterado', null, { detalhe: `Checklist “${old}” renomeado para “${c.name}”` });
    res.json(c);
  });
  // Não exclui em silêncio: se algum ciclo usa o checklist, a resposta lista onde (“Ciclo / Estágio”) e nada é removido.
  // Fora disso remove só o modelo; projetos que já receberam os itens ficam com a cópia deles até sincronizar.
  app.delete('/api/checklists/:cid', async (req, res) => {
    const c = listOrThrow(req.params.cid);
    const usage = cycles.checklistUsage(data(), c.id);
    if (usage.length) {
      throw httpError(409, `Este checklist (“${c.name}”) está sendo utilizado em:\n${usage.map((u) => `• ${cycles.usageLabel(u)}`).join('\n')}\n\nRemova essas associações antes de excluir.`,
        { code: 'CHECKLIST_IN_USE', usage: usage.map((u) => ({ ...u, label: cycles.usageLabel(u) })) });
    }
    const mine = data().checklistItems.filter((d) => d.checklistId === c.id);
    const deps = C.dependentsOf(data(), mine.map((d) => d.id));
    if (deps.length) throw httpError(409, C.dependentsMessage(data(), `Este checklist (“${c.name}”) tem itens que são usados como dependência: o conjunto`, deps), { code: 'ITEM_IS_DEPENDENCY', dependents: deps.map((d) => C.defLabel(data(), d)) });
    const n = mine.length;
    data().checklistItems = data().checklistItems.filter((d) => d.checklistId !== c.id);
    data().checklists = data().checklists.filter((x) => x.id !== c.id);
    await store.save();
    log('checklist-modelo-alterado', null, { detalhe: `Checklist “${c.name}” removido do modelo (${n} item(ns))` });
    res.json({ ok: true });
  });

  app.post('/api/checklists/:cid/items', async (req, res) => {
    const list = listOrThrow(req.params.cid);
    if (data().checklistItems.filter((d) => d.checklistId === list.id).length >= C.MAX_ITEMS_PER_CHECKLIST) throw httpError(400, `No máximo ${C.MAX_ITEMS_PER_CHECKLIST} itens por checklist.`);
    const item = { id: uid(), checklistId: list.id, ...C.cleanDefinition(req.body, data()) };
    data().checklistItems.push(item);
    await store.save();
    log('checklist-modelo-alterado', null, { detalhe: `Item “${item.title}” criado no checklist ${list.name}` });
    res.json(item);
  });
  app.put('/api/checklist-items/:iid', async (req, res) => {
    const item = defOrThrow(req.params.iid);
    const before = item.checklistId;
    let checklistId = before;
    if (req.body.checklistId && req.body.checklistId !== before) { // mover para outro checklist
      const to = listOrThrow(req.body.checklistId);
      if (data().checklistItems.filter((d) => d.checklistId === to.id).length >= C.MAX_ITEMS_PER_CHECKLIST) throw httpError(400, `No máximo ${C.MAX_ITEMS_PER_CHECKLIST} itens por checklist.`);
      checklistId = to.id;
    }
    const clean = C.cleanDefinition(req.body, data(), item.id);
    if (!clean.emailTemplateId) delete item.emailTemplateId; // campo opcional: tirar o modelo de e-mail remove o campo
    Object.assign(item, clean, { checklistId });
    if (checklistId !== before) data().checklistItems = [...data().checklistItems.filter((d) => d.id !== item.id), item]; // vai para o fim do destino
    await store.save();
    log('checklist-modelo-alterado', null, { detalhe: `Item “${item.title}” alterado no checklist ${listOrThrow(item.checklistId).name}` });
    res.json(item);
  });
  // Remove só do modelo: projetos que já receberam o item continuam com a cópia deles até alguém sincronizar.
  app.delete('/api/checklist-items/:iid', async (req, res) => {
    const item = defOrThrow(req.params.iid);
    const deps = C.dependentsOf(data(), [item.id]);
    if (deps.length) throw httpError(409, C.dependentsMessage(data(), `Este item (“${item.title}”)`, deps), { code: 'ITEM_IS_DEPENDENCY', dependents: deps.map((d) => C.defLabel(data(), d)) });
    data().checklistItems = data().checklistItems.filter((d) => d.id !== item.id);
    await store.save();
    log('checklist-modelo-alterado', null, { detalhe: `Item “${item.title}” removido do modelo` });
    res.json({ ok: true });
  });
  // Reordena os itens de um checklist. Precisa receber exatamente os ids que existem.
  function reorder(mine, ids) {
    if (ids.length !== mine.length || new Set(ids).size !== ids.length || !ids.every((i) => mine.some((d) => d.id === i))) throw httpError(400, 'A lista de itens mudou; recarregue e tente de novo.');
    const rank = new Map(ids.map((id, i) => [id, i]));
    const set = new Set(ids);
    data().checklistItems = [...data().checklistItems.filter((d) => !set.has(d.id)), ...[...mine].sort((x, y) => rank.get(x.id) - rank.get(y.id))];
  }
  app.put('/api/checklists/:cid/order', async (req, res) => {
    const list = listOrThrow(req.params.cid);
    reorder(data().checklistItems.filter((d) => d.checklistId === list.id), Array.isArray(req.body.ids) ? req.body.ids : []);
    await store.save();
    res.json({ ok: true });
  });

  // ---------- Visão de uma instância (o que a tela precisa; nunca caminhos do disco) ----------
  const scriptRef = (id) => {
    const s = data().scripts.find((x) => x.id === id);
    return s ? { id, name: s.name, exists: store.scripts().existsSync(s), missing: false } : { id, name: 'Script removido', exists: false, missing: true };
  };
  function itemView(it, cfg, p, idx) {
    const ext = it.evidence.mode === 'none' ? [] : cfg.types[it.evidence.type]?.extensions || [];
    const deps = p && idx ? C.dependenciesOf(idx, it) : [];
    const def = it.defId ? data().checklistItems.find((d) => d.id === it.defId) : null;
    return {
      note: it.note || null, modelCarryForward: def ? !!def.carryForward : null,
      dependencies: deps, blocked: itemPending(it) && deps.some((d) => d.status === 'pending'),
      // {{greeting}} na descrição (texto do MODELO) aparece como Bom dia/Boa tarde/Boa noite do momento em que o item é visto; o modelo mantém a variável.
      id: it.id, defId: it.defId, title: it.title, description: applyGreeting(it.description), required: it.required, carryForward: !!it.carryForward,
      carriedTo: it.carriedTo || null, carriedToStage: it.carriedTo && p ? C.stageNameOf(data(), p, it.carriedTo) : null, carriedAt: it.carriedAt || null,
      carryHistory: (it.carryHistory || []).map((x) => ({ fromStage: x.fromStage, toStage: x.toStage, at: x.at, by: x.by, restored: !!x.restored })),
      evidence: { ...it.evidence, typeLabel: E.TYPE_LABEL[it.evidence.mode === 'none' ? 'none' : it.evidence.type], extensions: ext },
      links: it.links, scripts: it.scriptIds.map(scriptRef), checklistId: it.checklistId, email: emailRef(it, p),
      runs: (it.runs || []).slice(-10).reverse(),
      done: it.done, doneAt: it.doneAt, doneBy: it.doneBy, completedAt: it.completedAt, completedBy: it.completedBy, status: C.itemStatus(it), archived: !!it.archived,
      evidences: it.evidences.map((v) => EH.evidencePublic(files(), v)),
    };
  }
  // Ação "Gerar e-mail" do item: modelo (da cópia do item) + última geração feita a partir dele (Comunicações). Não é envio.
  function emailRef(it, p) {
    if (!it.emailTemplateId) return null;
    const t = (data().emailTemplates || []).find((x) => x.id === it.emailTemplateId);
    const last = p ? EM.lastGenerationFor(data(), p.id, it.id) : null;
    return { templateId: it.emailTemplateId, templateName: t ? t.name : null, active: !!t?.active, missing: !t,
      generations: p ? (data().emailGenerations || []).filter((s) => s.projectId === p.id && s.checklist?.itemId === it.id).length : 0,
      lastGeneration: last ? { id: last.id, at: last.at, copiedAt: last.copiedAt, subject: last.subject } : null };
  }
  const itemPending = (it) => C.itemStatus(it) !== 'done';
  function instanceView(p, inst) {
    const cfg = E.getConfig(data().settings);
    const depIdx = C.buildDepIndex(data(), p); // dependências organizadas uma vez só
    const items = C.live(inst);
    const sync = C.syncPlan(data(), p, inst);
    const steps = C.stepsOf(p);
    const idx = steps.findIndex((c) => c.id === inst.stepId);
    const isCurrent = p.stepId === inst.stepId;
    const next = isCurrent && idx >= 0 ? steps[idx + 1] : null;
    // Grupos (checklists) na ordem do modelo do passo neste ciclo; itens de um checklist que saiu dele continuam aparecendo, num grupo próprio.
    const order = C.modelChecklists(data(), p, inst);
    const groups = [];
    for (const it of items) {
      let g = groups.find((x) => x.id === it.checklistId);
      if (!g) {
        const def = order.find((c) => c.id === it.checklistId);
        const any = def || data().checklists.find((c) => c.id === it.checklistId); // existe, mas já não faz parte do passo (aguardando sincronizar)
        g = { id: it.checklistId, name: any ? any.name : 'Checklist removido do modelo', rank: def ? order.indexOf(def) : 1e6, items: [] };
        groups.push(g);
      }
      g.items.push(it);
    }
    groups.sort((x, y) => x.rank - y.rank);
    // Pendências herdadas: itens de etapas anteriores transferidos para este passo (o mesmo item, com a origem indicada).
    const inherited = C.inheritedAt(p, inst.stepId).map(({ inst: o, it }) => ({ ...itemView(it, cfg, p, depIdx), origin: { stepId: o.stepId, stageName: o.stageName } }));
    const inheritedRaw = C.inheritedAt(p, inst.stepId).map((x) => x.it);
    // O que falta NESTE passo: próprios que ainda estão aqui + herdados (cada um diz se pode ser transferido).
    const here = items.filter((i) => C.locationOf(p, inst, i) === inst.stepId);
    const pending = [...C.pendingRequired(here).map((x) => ({ ...x, inherited: false })),
      ...C.inheritedAt(p, inst.stepId).flatMap(({ inst: o, it }) => C.pendingRequired([it]).map((x) => ({ ...x, inherited: true, origin: { stepId: o.stepId, stageName: o.stageName } })))];
    return {
      id: inst.id, stepId: inst.stepId, stageId: inst.stageId, stageName: inst.stageName, createdAt: inst.createdAt, syncedAt: inst.syncedAt, isCurrent,
      progress: C.progressOf(items), pending,
      items: items.map((i) => itemView(i, cfg, p, depIdx)),
      inherited, inheritedProgress: C.progressOf(inheritedRaw),
      groups: groups.map((g) => ({ id: g.id, name: g.name, progress: C.progressOf(g.items), itemIds: g.items.map((i) => i.id) })), archived: inst.items.filter((i) => i.archived).map((i) => itemView(i, cfg, p, depIdx)),
      sync: { changed: sync.changed, added: sync.added.length, updated: sync.updated.length, archived: sync.archived.length },
      next: next ? { stepId: next.id, stageName: C.stageOfStep(data(), next)?.name || '?', final: idx + 1 === steps.length - 1 } : null,
      global: C.projectPendencies(p),
    };
  }
  const reply = (res, p, inst) => res.json({ instance: instanceView(p, inst), project: publicProject(p) });

  function findInstance(p, stepId) {
    return p.checklists.find((c) => c.stepId === stepId) || (() => { throw httpError(404, 'Checklist deste passo ainda não foi iniciado.'); })();
  }
  const findItem = (inst, iid) => inst.items.find((i) => i.id === iid) || (() => { throw httpError(404, 'Item não encontrado.'); })();
  const auditItem = (action, p, inst, it, extra = {}) => log(action, p, { etapa: inst.stageName, item: it.title, detalhe: it.title, ...extra });

  // Abre (e cria, na primeira vez) o checklist do passo: cópia dos checklists que o passo tem neste ciclo.
  app.post('/api/projects/:id/checklists/:stepId/open', async (req, res) => {
    const p = getProject(req.params.id);
    const had = p.checklists.some((c) => c.stepId === req.params.stepId);
    const inst = C.ensureInstance(data(), p, req.params.stepId);
    if (!inst) throw httpError(404, 'Este passo não existe mais no ciclo.');
    if (!had) { await store.save(); log('checklist-iniciado', p, { etapa: inst.stageName, detalhe: `${inst.items.length} item(ns) copiados do modelo` }); }
    reply(res, p, inst);
  });

  // Marcar / desmarcar. Desmarcar NÃO apaga evidências (evita perda acidental); marcar sem a evidência exigida deixa o item "aguardando".
  app.put('/api/projects/:id/checklists/:stepId/items/:iid', async (req, res) => {
    const p = getProject(req.params.id);
    const inst = findInstance(p, req.params.stepId);
    const it = findItem(inst, req.params.iid);
    if (it.archived) throw httpError(400, 'Este item foi removido do modelo e não pode mais ser alterado.');
    const done = !!req.body.done;
    if (done && !it.done) { // concluir exige as dependências concluídas (desmarcar é sempre livre)
      const pend = C.dependenciesOf(C.buildDepIndex(data(), p), it).filter((d) => d.status === 'pending');
      if (pend.length) {
        auditItem('checklist-bloqueado-dependencia', p, inst, it, { resultado: `dependência pendente: ${pend.map((d) => d.title).join('; ')}`.slice(0, 300) });
        throw httpError(409, `Não é possível concluir este item. ${pend.length === 1 ? 'Dependência pendente' : 'Dependências pendentes'}: ${pend.map((d) => d.title).join('; ')}.`,
          { code: 'DEPENDENCY_PENDING', blocked: pend.map((d) => ({ title: d.title, stageName: d.stageName })) });
      }
    }
    if (done !== it.done) {
      C.setDone(it, done, whoAmI(), new Date().toISOString());
      await store.save();
      auditItem(done ? 'checklist-marcado' : 'checklist-desmarcado', p, inst, it, { resultado: C.itemStatus(it) === 'awaiting_evidence' ? 'aguardando evidência' : undefined });
    }
    reply(res, p, inst);
  });

  // Observação do item (texto da execução deste projeto; a descrição do item é do modelo). Texto vazio remove.
  app.put('/api/projects/:id/checklists/:stepId/items/:iid/note', async (req, res) => {
    const p = getProject(req.params.id);
    const inst = findInstance(p, req.params.stepId);
    const it = findItem(inst, req.params.iid);
    if (it.archived) throw httpError(400, 'Este item foi removido do modelo e não pode mais ser alterado.');
    if (String(req.body.text ?? '').trim().length > C.MAX_NOTE) throw httpError(400, `A observação pode ter até ${C.MAX_NOTE} caracteres.`);
    const before = !!it.note;
    if (C.setNote(it, req.body.text, whoAmI())) {
      await store.save();
      auditItem('checklist-observacao', p, inst, it, { resultado: !it.note ? 'removida' : before ? 'editada' : 'criada' });
    }
    reply(res, p, inst);
  });

  // Reverter transferência: o mesmo item volta ao passo de origem (nada é apagado nem copiado). Sempre pede confirmação: a primeira chamada
  // devolve 409 RESTORE_CONFIRM com o que vai acontecer e os avisos; só com { confirm: true } o item é movido.
  app.post('/api/projects/:id/checklists/:stepId/items/:iid/restore', async (req, res) => {
    const p = getProject(req.params.id);
    const inst = findInstance(p, req.params.stepId);
    const it = findItem(inst, req.params.iid);
    const plan = C.restorePlan(data(), p, inst, it);
    if (!plan.ok) throw httpError(plan.status, plan.error, plan.code ? { code: plan.code } : {});
    if (!req.body.confirm) {
      throw httpError(409, `Restaurar “${it.title}” para “${plan.toStage}”? O item continua pendente, com as mesmas evidências, observação e histórico.`,
        { code: 'RESTORE_CONFIRM', warnings: plan.warnings, target: { stepId: plan.to, stageName: plan.toStage }, from: { stepId: plan.from, stageName: plan.fromStage } });
    }
    C.applyRestore(it, plan, whoAmI());
    await store.save();
    auditItem('checklist-pendencia-restaurada', p, inst, it, { etapa: plan.fromStage, detalhe: `${it.title}: ${plan.fromStage} → ${plan.toStage} (restaurado ao estágio original)` });
    reply(res, p, inst);
  });

  // Sincronizar com o modelo: só quando pedido. dryRun mostra o que mudaria sem gravar nada.
  app.post('/api/projects/:id/checklists/:stepId/sync', async (req, res) => {
    const p = getProject(req.params.id);
    const inst = findInstance(p, req.params.stepId);
    const plan = C.syncPlan(data(), p, inst);
    if (req.body.dryRun) return res.json({ plan });
    C.applySync(data(), p, inst);
    await store.save();
    log('checklist-sincronizado', p, { etapa: inst.stageName, detalhe: `${plan.added.length} novo(s), ${plan.updated.length} atualizado(s), ${plan.archived.length} arquivado(s)` });
    res.json({ plan, instance: instanceView(p, inst), project: publicProject(p) });
  });

  // ---------- Evidências ----------
  // Upload: o arquivo vem cru no corpo (Content-Type: application/octet-stream); nome, tipo declarado e descrição vão em cabeçalhos.
  app.post('/api/projects/:id/checklists/:stepId/items/:iid/evidence', async (req, res) => {
    const p = getProject(req.params.id);
    const inst = findInstance(p, req.params.stepId);
    const it = findItem(inst, req.params.iid);
    if (it.archived) throw httpError(400, 'Este item foi removido do modelo e não recebe mais evidências.');
    if (it.evidence.mode === 'none') throw httpError(400, 'Este item não usa evidências.');
    if (it.evidences.length >= it.evidence.max) throw httpError(400, `Este item já tem o máximo de ${it.evidence.max} evidência(s). Remova uma para anexar outra.`);
    const stepNo = Math.max(0, C.stepsOf(p).findIndex((c) => c.id === inst.stepId)) + 1;
    const rec = await EH.receiveUpload(req, { files: files(), cfg: E.getConfig(data().settings), type: it.evidence.type, folder: files().folderFor(p, stepNo, inst.stageName), projectId: p.id });
    it.evidences.push(rec);
    C.refreshCompletion(it, whoAmI(), rec.at);
    await store.save();
    auditItem('evidencia-adicionada', p, inst, it, { arquivo: rec.name, bytes: rec.size, resultado: C.itemStatus(it) === 'done' ? 'item concluído' : undefined });
    reply(res, p, inst);
  });

  function findEvidence(p, eid) {
    for (const inst of p.checklists) for (const it of inst.items) {
      const ev = it.evidences.find((x) => x.id === eid);
      if (ev) return { inst, it, ev };
    }
    throw httpError(404, 'Evidência não encontrada.');
  }
  // Visualizar (imagem, na própria tela) ou baixar/exportar: a entrega segura é a mesma de todas as evidências (evidence-http.js).
  app.get('/api/projects/:id/evidences/:eid/file', async (req, res) => {
    const { ev } = findEvidence(getProject(req.params.id), req.params.eid);
    await EH.sendEvidence(res, files(), ev, { inline: req.query.inline === '1' });
  });
  app.post('/api/projects/:id/evidences/:eid/open', async (req, res) => {
    const { ev } = findEvidence(getProject(req.params.id), req.params.eid);
    await EH.openEvidence(explorer, files(), ev, { folder: !!req.body.folder });
    res.json({ ok: true });
  });
  // Remover: o arquivo vai para <data>\evidencias\.removidas (recuperável). O item volta a "aguardando evidência" se ela era exigida.
  app.delete('/api/projects/:id/evidences/:eid', async (req, res) => {
    const p = getProject(req.params.id);
    const { inst, it, ev } = findEvidence(p, req.params.eid);
    await files().remove(ev.file);
    it.evidences = it.evidences.filter((x) => x.id !== ev.id);
    C.refreshCompletion(it, whoAmI(), new Date().toISOString());
    await store.save();
    auditItem('evidencia-removida', p, inst, it, { arquivo: ev.name });
    reply(res, p, inst);
  });

  return { instanceView, log };
}

module.exports = { mount, readBody };
