// Rotas de Configurações e do ciclo do projeto: coordenadores, estágios (tags com cor), ciclo de migração,
// etapa atual do projeto (com histórico), planilhas de Correções e a biblioteca de Documentos e Modelos.
const fs = require('fs');
const path = require('path');
const { httpError, uid, str } = require('./util');
const contacts = require('./contacts');
const { parseSheetUrl } = require('./sheets');

const checklist = require('./checklist');
const cycles = require('./cycles');
const evidence = require('./evidence');

const HEX = /^#[0-9a-fA-F]{6}$/;
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const MAX_HISTORY = 200;

// Só tipos de documento podem ser abertos pelo app (nunca executáveis/scripts): o "abrir" usa o programa padrão do Windows.
const DOC_EXT = new Set([
  '.pdf', '.doc', '.docx', '.dot', '.dotx', '.rtf', '.odt', '.txt', '.md', '.csv', '.xls', '.xlsx', '.xlsm', '.xlt', '.xltx', '.ods',
  '.ppt', '.pptx', '.pot', '.potx', '.odp', '.sql', '.xml', '.json', '.png', '.jpg', '.jpeg', '.gif', '.zip',
]);
const isSafeDocFile = (p) => DOC_EXT.has(path.extname(String(p || '')).toLowerCase());

function isHttpUrl(u) {
  try { const x = new URL(String(u).trim()); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

function mount(app, { store, audit, getProject, getIn, publicProject }) {
  const data = () => store.data;
  const nameKey = (s) => s.trim().toLowerCase();

  // ---------- Visões públicas ----------
  const publicCoordinator = (c) => ({ ...c, waUrl: contacts.waLink(c.phone) });
  const publicDocument = (d) => ({ ...d, fileExists: d.source.type === 'file' ? fs.existsSync(d.source.path) : null });
  const extras = () => ({
    coordinators: data().coordinators.map(publicCoordinator),
    stages: data().stages, cycles: data().cycles, defaultCycleId: data().defaultCycleId, checklists: data().checklists,
    projectTypes: data().projectTypes, originSystems: data().originSystems,
    documents: data().documents.map(publicDocument),
    checklistItems: data().checklistItems, evidence: evidence.getConfig(data().settings),
  });

  // ---------- Responsáveis (coordenadores e analistas: um só cadastro de pessoas; a chave antiga "coordinators" foi mantida) ----------
  function cleanCoordinator(b) {
    const name = str(b.name, 120);
    if (!name) throw httpError(400, 'Informe o nome do coordenador.');
    const email = str(b.email, 200);
    if (email && !contacts.isEmail(email)) throw httpError(400, 'E-mail inválido.');
    const phone = str(b.phone, 40);
    if (phone && !contacts.waNumber(phone)) throw httpError(400, 'Telefone inválido para WhatsApp: informe DDD + número (ex.: (11) 91234-5678) ou o número internacional começando com "+".');
    return { name, role: str(b.role, 120), email, phone, notes: str(b.notes, 500) };
  }

  app.post('/api/coordinators', async (req, res) => {
    const c = { id: uid(), ...cleanCoordinator(req.body) };
    data().coordinators.push(c);
    await store.save();
    res.json(publicCoordinator(c));
  });
  app.put('/api/coordinators/:id', async (req, res) => {
    const c = getIn(data().coordinators, req.params.id, 'Coordenador');
    Object.assign(c, cleanCoordinator(req.body));
    await store.save();
    res.json(publicCoordinator(c));
  });
  // Projetos que tinham este coordenador ficam sem coordenador (nada é apagado além do cadastro).
  app.delete('/api/coordinators/:id', async (req, res) => {
    getIn(data().coordinators, req.params.id, 'Coordenador');
    data().coordinators = data().coordinators.filter((c) => c.id !== req.params.id);
    let unassigned = 0;
    for (const p of data().projects) {
      let hit = false;
      if (p.coordinatorId === req.params.id) { p.coordinatorId = null; hit = true; }
      if (p.analystId === req.params.id) { p.analystId = null; hit = true; }
      if (hit) unassigned++;
    }
    await store.save();
    res.json({ ok: true, unassigned });
  });

  // ---------- Catálogos simples de tags (Tipo de projeto, Sistema de origem): nome + cor, sem outra amarração ----------
  function mountTagCatalog({ key, path, field, label }) {
    const list = () => data()[key];
    function cleanTag(b, ignoreId) {
      const name = str(b.name, 60);
      if (!name) throw httpError(400, `Informe o nome do(a) ${label.toLowerCase()}.`);
      if (!HEX.test(String(b.color || ''))) throw httpError(400, 'Cor inválida (use o formato #RRGGBB).');
      if (list().some((s) => s.id !== ignoreId && nameKey(s.name) === nameKey(name))) throw httpError(409, `Já existe um(a) ${label.toLowerCase()} chamado(a) “${name}”.`);
      return { name, color: b.color.toUpperCase() };
    }
    app.post(`/api/${path}`, async (req, res) => {
      const s = { id: uid(), ...cleanTag(req.body) };
      list().push(s);
      await store.save();
      res.json(s);
    });
    app.put(`/api/${path}/:id`, async (req, res) => {
      const s = getIn(list(), req.params.id, label);
      Object.assign(s, cleanTag(req.body, s.id));
      await store.save();
      res.json(s);
    });
    // Remove o cadastro; projetos que usavam esta tag ficam sem ela (nada mais é alterado).
    app.delete(`/api/${path}/:id`, async (req, res) => {
      getIn(list(), req.params.id, label);
      data()[key] = list().filter((s) => s.id !== req.params.id);
      let unassigned = 0;
      for (const p of data().projects) if (p[field] === req.params.id) { p[field] = null; unassigned++; }
      await store.save();
      res.json({ ok: true, unassigned });
    });
  }
  mountTagCatalog({ key: 'projectTypes', path: 'project-types', field: 'projectTypeId', label: 'Tipo de projeto' });
  mountTagCatalog({ key: 'originSystems', path: 'origin-systems', field: 'originSystemId', label: 'Sistema de origem' });

  // ---------- Estágios (tags com cor) ----------
  function cleanStage(b, ignoreId) {
    const name = str(b.name, 40);
    if (!name) throw httpError(400, 'Informe o nome do estágio.');
    if (!HEX.test(String(b.color || ''))) throw httpError(400, 'Cor inválida (use o formato #RRGGBB).');
    if (data().stages.some((s) => s.id !== ignoreId && nameKey(s.name) === nameKey(name))) throw httpError(409, `Já existe um estágio chamado “${name}”.`);
    return { name, color: b.color.toUpperCase() };
  }
  app.post('/api/stages', async (req, res) => {
    const s = { id: uid(), ...cleanStage(req.body) };
    data().stages.push(s);
    await store.save();
    res.json(s);
  });
  app.put('/api/stages/:id', async (req, res) => {
    const s = getIn(data().stages, req.params.id, 'Estágio');
    Object.assign(s, cleanStage(req.body, s.id));
    await store.save();
    res.json(s);
  });
  app.delete('/api/stages/:id', async (req, res) => {
    const s = getIn(data().stages, req.params.id, 'Estágio');
    // Estágio é um cadastro reutilizável: enquanto algum ciclo o usa, não é removido (a mensagem diz onde).
    const inCycles = data().cycles.filter((c) => c.steps.some((x) => x.stageId === s.id));
    if (inCycles.length) throw httpError(409, `O estágio “${s.name}” está sendo utilizado em:\n${inCycles.map((c) => `• ${c.name}${c.steps.filter((x) => x.stageId === s.id).length > 1 ? ` (${c.steps.filter((x) => x.stageId === s.id).length} vezes)` : ''}`).join('\n')}\n\nRemova o estágio desses ciclos antes de excluir.`,
      { code: 'STAGE_IN_USE', usage: inCycles.map((c) => ({ cycleId: c.id, cycleName: c.name })) });
    const inProjects = data().projects.filter((p) => (p.steps || []).some((x) => x.stageId === s.id)).map((p) => p.name);
    if (inProjects.length) throw httpError(409, `O estágio “${s.name}” ainda está no ciclo de ${inProjects.length} projeto(s) (${inProjects.slice(0, 3).join(', ')}${inProjects.length > 3 ? '…' : ''}). Aplique a nova versão do ciclo nesses projetos antes de excluir.`);
    data().stages = data().stages.filter((x) => x.id !== s.id);
    for (const c of data().checklists) if (c.stageId === s.id) c.stageId = null; // os checklists são cadastro à parte: ficam, sem estágio
    for (const d of data().documents) if (d.stageId === s.id) d.stageId = null;
    await store.save();
    res.json({ ok: true });
  });

  // ---------- Ciclos de migração (modelos reutilizáveis; um estágio pode se repetir no mesmo ciclo) ----------
  // Mudar os passos de um ciclo só incrementa a versão: os projetos que o usam mostram "nova versão disponível" e só mudam
  // quando alguém revisa e aplica (POST /api/projects/:id/cycle/apply). Nada é alterado silenciosamente.
  const cycleOr404 = (id) => getIn(data().cycles, id, 'Ciclo');
  const usage = (c) => ({ projects: data().projects.filter((p) => p.cycleId === c.id).length, types: data().projectTypes.filter((t) => t.cycleId === c.id).length });
  app.post('/api/cycles', async (req, res) => {
    const from = req.body.copyFrom ? cycleOr404(req.body.copyFrom) : null;
    // Copiar de outro ciclo leva também os checklists de cada estágio (só as referências: nenhum checklist é duplicado).
    const body = { ...req.body, steps: req.body.steps || (from ? from.steps.map((x) => ({ stageId: x.stageId, checklistIds: cycles.listIds(x) })) : null) };
    if (!body.steps) { // ciclo novo vazio: começa com o primeiro estágio, para ser editado em seguida
      if (!data().stages.length) throw httpError(400, 'Cadastre ao menos um estágio antes de criar um ciclo.');
      body.steps = [{ stageId: data().stages[0].id }];
    }
    const c = { id: uid(), ...cycles.cleanCycle(data(), body, null), version: 1, updatedAt: new Date().toISOString() };
    data().cycles.push(c);
    await store.save();
    audit.log({ action: 'ciclo-alterado', detalhe: `Ciclo “${c.name}” criado (${c.steps.length} passos)` });
    res.json(c);
  });
  app.put('/api/cycles/:id', async (req, res) => {
    const c = cycleOr404(req.params.id);
    const next = cycles.cleanCycle(data(), { name: req.body.name ?? c.name, description: req.body.description ?? c.description, steps: req.body.steps ?? c.steps }, c);
    const changed = !cycles.sameSteps(c.steps, next.steps);
    Object.assign(c, next);
    // Versão nova só importa para quem já usa o ciclo: enquanto nenhum projeto o usa, editar não gera versões (evita v1 → v7 ao montar).
    if (changed) { if (data().projects.some((p) => p.cycleId === c.id)) c.version += 1; c.updatedAt = new Date().toISOString(); }
    await store.save();
    if (changed) audit.log({ action: 'ciclo-alterado', detalhe: `Ciclo “${c.name}” versão ${c.version} (${c.steps.length} passos; ${usage(c).projects} projeto(s) poderão aplicar)` });
    res.json(c);
  });
  // Checklists de UM estágio dentro de UM ciclo (ciclo + estágio + checklists; a ordem do array é a ordem de exibição). Só mexe neste ciclo:
  // os outros ciclos, mesmo usando o mesmo estágio ou os mesmos checklists, não mudam. Em ciclo em uso gera nova versão (os projetos só
  // recebem quando alguém revisa e aplica).
  app.put('/api/cycles/:id/steps/:stepId/checklists', async (req, res) => {
    const c = cycleOr404(req.params.id);
    const step = c.steps.find((x) => x.id === req.params.stepId);
    if (!step) throw httpError(404, 'Este passo não existe neste ciclo.');
    const ids = cycles.cleanChecklistIds(data(), req.body.checklistIds);
    if (cycles.listIds(step).join(',') !== ids.join(',')) {
      const stage = data().stages.find((x) => x.id === step.stageId);
      step.checklistIds = ids;
      if (data().projects.some((p) => p.cycleId === c.id)) c.version += 1;
      c.updatedAt = new Date().toISOString();
      await store.save();
      audit.log({ action: 'ciclo-checklists-alterados', detalhe: `Ciclo “${c.name}” / ${stage?.name || '?'}: ${ids.length ? ids.map((id) => data().checklists.find((k) => k.id === id)?.name || '?').join(', ') : 'nenhum checklist'} (versão ${c.version}; ${usage(c).projects} projeto(s) poderão aplicar)` });
    }
    res.json(c);
  });
  app.delete('/api/cycles/:id', async (req, res) => {
    const c = cycleOr404(req.params.id);
    const u = usage(c);
    if (u.projects || u.types) throw httpError(409, `O ciclo “${c.name}” está em uso (${plural(u.projects, 'projeto', 'projetos')}, ${plural(u.types, 'tipo de projeto', 'tipos de projeto')}). Troque o ciclo deles antes de excluir.`);
    if (data().defaultCycleId === c.id) throw httpError(409, 'Este é o ciclo padrão. Defina outro ciclo como padrão antes de excluir.');
    data().cycles = data().cycles.filter((x) => x.id !== c.id);
    await store.save();
    audit.log({ action: 'ciclo-alterado', detalhe: `Ciclo “${c.name}” excluído` });
    res.json({ ok: true });
  });
  app.put('/api/cycles-default', async (req, res) => {
    data().defaultCycleId = cycleOr404(req.body.id).id;
    await store.save();
    res.json({ ok: true });
  });
  // Ciclo padrão de um tipo de projeto (os projetos novos daquele tipo recebem este ciclo).
  app.put('/api/project-types/:id/cycle', async (req, res) => {
    const t = getIn(data().projectTypes, req.params.id, 'Tipo de projeto');
    t.cycleId = req.body.cycleId ? cycleOr404(req.body.cycleId).id : null;
    await store.save();
    res.json(t);
  });

  // Nova versão do ciclo no projeto: dryRun mostra o que muda; aplicar troca os passos (mantém andamento, histórico e checklists).
  app.post('/api/projects/:id/cycle/apply', async (req, res) => {
    const p = getProject(req.params.id);
    const diff = cycles.cycleDiff(data(), p);
    if (req.body.dryRun || !diff.available) return res.json({ diff, project: publicProject(p) });
    if (diff.currentRemoved && !req.body.confirmCurrentRemoved) throw httpError(409, 'A etapa atual do projeto não existe na nova versão do ciclo. Confirme para aplicar (o projeto fica sem etapa definida; o histórico e os checklists continuam guardados).', { code: 'CYCLE_CURRENT_REMOVED' });
    cycles.assignCycle(p, data().cycles.find((c) => c.id === p.cycleId));
    if (diff.currentRemoved) { p.stageHistory.push({ stepId: null, stageId: null, name: 'Sem etapa (ciclo atualizado)', color: '#8FB0BF', at: new Date().toISOString() }); p.stepId = null; }
    await store.save();
    audit.log({ action: 'ciclo-aplicado', project: p.name, detalhe: `${diff.cycleName} v${diff.from} → v${diff.version}: ${diff.added.length} passo(s) novo(s), ${diff.removed.length} removido(s)` });
    res.json({ diff, project: publicProject(p) });
  });

  // ---------- Etapa atual do projeto (com histórico) ----------
  // Ir para uma etapa À FRENTE exige os itens obrigatórios do checklist concluídos (de cada etapa que está sendo deixada). Voltar não é bloqueado.
  // Obrigatórios pendentes marcados como transferíveis não bloqueiam: a primeira chamada devolve 409 CHECKLIST_CARRY com a lista, e só a
  // segunda (confirmCarry + as mesmas chaves) avança e transfere. Concluir o ciclo (último passo) exige TODOS os obrigatórios do projeto.
  app.put('/api/projects/:id/step', async (req, res) => {
    const p = getProject(req.params.id);
    const stepId = req.body.stepId ?? null;
    const who = require('./auth/identity').who();
    if (stepId !== null) {
      const steps = checklist.stepsOf(p);
      const step = steps.find((c) => c.id === stepId);
      if (!step) throw httpError(400, 'Passo inexistente no ciclo deste projeto.');
      const gate = checklist.checkAdvance(data(), p, stepId);
      const toName = data().stages.find((s) => s.id === step.stageId)?.name || '?';
      if (!gate.ok) {
        const count = gate.blocked.reduce((n, b) => n + b.pending.length, 0);
        audit.log({ action: 'avanco-bloqueado', project: p.name, by: who, etapa: gate.blocked[0].stageName,
          detalhe: gate.final ? `Conclusão do projeto bloqueada: ${plural(count, 'pendência obrigatória', 'pendências obrigatórias')}` : `Avanço para ${toName} bloqueado: ${plural(count, 'item obrigatório pendente', 'itens obrigatórios pendentes')}`,
          pendentes: gate.blocked.flatMap((b) => b.pending.map((i) => i.title)) });
        const msg = gate.final
          ? `Não é possível concluir este projeto: ${plural(count, 'pendência obrigatória ainda não foi concluída', 'pendências obrigatórias ainda não foram concluídas')}. Todas as pendências obrigatórias devem ser concluídas antes da finalização do ciclo.`
          : `Não é possível avançar para ${toName}: ${plural(count, 'item obrigatório está pendente', 'itens obrigatórios estão pendentes')} no checklist.`;
        throw httpError(409, msg, { code: 'CHECKLIST_PENDING', blocked: gate.blocked, final: gate.final, transferable: gate.transferable, target: gate.target });
      }
      if (gate.transferable.length) {
        const keys = gate.transferable.map((e) => e.key).sort();
        const sent = Array.isArray(req.body.carryKeys) ? req.body.carryKeys.map(String).sort() : null;
        if (!req.body.confirmCarry || JSON.stringify(sent) !== JSON.stringify(keys)) { // a lista mudou desde a pergunta: pergunta de novo
          throw httpError(409, `${plural(keys.length, 'item obrigatório pendente pode ser transferido', 'itens obrigatórios pendentes podem ser transferidos')} para ${toName}.`,
            { code: 'CHECKLIST_CARRY', transferable: gate.transferable, target: gate.target });
        }
      }
      if (p.stepId !== stepId) {
        const now = new Date().toISOString();
        const carried = gate.transferable.length ? checklist.applyCarry(data(), p, gate.transferable, stepId, who, now) : [];
        for (const c of carried) {
          audit.log({ action: 'checklist-pendencia-transferida', project: p.name, by: who, etapa: c.from, item: c.it.title,
            detalhe: `${c.it.title}: ${c.from} → ${c.to} (origem: ${c.inst.stageName}; ${plural(c.it.carryHistory.length, 'transferência', 'transferências')})` });
        }
        const from = steps.findIndex((c) => c.id === p.stepId);
        const to = steps.findIndex((c) => c.id === stepId);
        if (from >= 0 && to > from) { // etapa(s) concluída(s): fica registrado, com o andamento do checklist
          for (let i = from; i < to; i++) {
            const cs = steps[i];
            const pr = checklist.progressForStep(data(), p, cs.id);
            const moved = carried.filter((c) => c.fromStepId === cs.id).length;
            audit.log({ action: 'etapa-concluida', project: p.name, by: who, etapa: data().stages.find((s) => s.id === cs.stageId)?.name, detalhe: `Checklist: ${pr.done}/${pr.total} itens (${pr.requiredDone}/${pr.requiredTotal} obrigatórios)${moved ? ` · ${plural(moved, 'pendência transferida', 'pendências transferidas')}` : ''}` });
          }
        }
        const had = p.checklists.some((c) => c.stepId === stepId);
        const inst = checklist.ensureInstance(data(), p, stepId); // ao iniciar a etapa, o projeto recebe uma cópia dos checklists do passo no ciclo dele
        if (!had && inst) audit.log({ action: 'checklist-iniciado', project: p.name, by: who, etapa: inst.stageName, detalhe: `${inst.items.length} item(ns) copiados do modelo` });
        const st = data().stages.find((s) => s.id === step.stageId);
        p.stageHistory.push({ stepId, stageId: step.stageId, name: st?.name || '?', color: st?.color || '#8FB0BF', at: now, ...(carried.length ? { carried: carried.length } : {}) });
        if (p.stageHistory.length > MAX_HISTORY) p.stageHistory.splice(0, p.stageHistory.length - MAX_HISTORY);
      }
    } else if (p.stepId !== null) {
      p.stageHistory.push({ stepId: null, stageId: null, name: 'Sem etapa', color: '#8FB0BF', at: new Date().toISOString() });
    }
    p.stepId = stepId;
    await store.save();
    res.json(publicProject(p));
  });

  // ---------- Planilhas de Correções (link do Google Sheets) ----------
  function cleanCorrection(b) {
    const label = str(b.label, 120) || 'Correções';
    const url = str(b.url, 600);
    if (!parseSheetUrl(url)) throw httpError(400, 'O link precisa ser de uma planilha do Google Sheets (https://docs.google.com/spreadsheets/d/...).');
    return { label, url, note: str(b.note, 300) };
  }
  app.post('/api/projects/:id/corrections', async (req, res) => {
    const p = getProject(req.params.id);
    p.corrections.push({ id: uid(), ...cleanCorrection(req.body) });
    await store.save();
    res.json(publicProject(p));
  });
  app.put('/api/projects/:id/corrections/:cid', async (req, res) => {
    const p = getProject(req.params.id);
    Object.assign(getIn(p.corrections, req.params.cid, 'Planilha de correções'), cleanCorrection(req.body));
    await store.save();
    res.json(publicProject(p));
  });
  app.delete('/api/projects/:id/corrections/:cid', async (req, res) => {
    const p = getProject(req.params.id);
    p.corrections = p.corrections.filter((c) => c.id !== req.params.cid);
    await store.save();
    res.json(publicProject(p));
  });

  // ---------- Documentos e Modelos ----------
  function cleanDocument(b) {
    const title = str(b.title, 160);
    if (!title) throw httpError(400, 'Informe o título do documento.');
    const kind = b.kind === 'documento' ? 'documento' : 'modelo';
    const stageId = b.stageId || null;
    if (stageId && !data().stages.some((s) => s.id === stageId)) throw httpError(400, 'Estágio inexistente.');
    const src = b.source || {};
    let source;
    if (src.type === 'link') {
      if (!isHttpUrl(src.url)) throw httpError(400, 'O link precisa começar com http:// ou https://.');
      source = { type: 'link', url: str(src.url, 800) };
    } else {
      const p = str(src.path, 600);
      if (!p || !path.isAbsolute(p)) throw httpError(400, 'Selecione o arquivo (caminho completo).');
      if (!isSafeDocFile(p)) throw httpError(400, 'Tipo de arquivo não permitido. Use documentos (PDF, Word, Excel, PowerPoint, texto, imagem, zip…), nunca programas ou scripts.');
      source = { type: 'file', path: path.normalize(p) };
    }
    return { title, kind, stageId, description: str(b.description, 600), source };
  }
  app.post('/api/documents', async (req, res) => {
    const d = { id: uid(), createdAt: new Date().toISOString(), ...cleanDocument(req.body) };
    data().documents.push(d);
    await store.save();
    res.json(publicDocument(d));
  });
  app.put('/api/documents/:id', async (req, res) => {
    const d = getIn(data().documents, req.params.id, 'Documento');
    Object.assign(d, cleanDocument(req.body));
    await store.save();
    res.json(publicDocument(d));
  });
  app.delete('/api/documents/:id', async (req, res) => {
    getIn(data().documents, req.params.id, 'Documento');
    data().documents = data().documents.filter((d) => d.id !== req.params.id);
    await store.save();
    res.json({ ok: true });
  });
  const docFile = (id) => {
    const d = getIn(data().documents, id, 'Documento');
    if (d.source.type !== 'file') throw httpError(400, 'Este documento é um link; abra-o pelo navegador.');
    if (!isSafeDocFile(d.source.path)) throw httpError(400, 'Tipo de arquivo não permitido.');
    if (!fs.existsSync(d.source.path) || !fs.statSync(d.source.path).isFile()) throw httpError(404, 'O arquivo não foi encontrado no caminho cadastrado. Edite o documento e selecione-o de novo.');
    return d.source.path;
  };
  // Abrir arquivo/pasta no navegador de arquivos do SO: não disponível no modo Web. Só valida (cadastrado, extensão, existência).
  app.post('/api/documents/:id/open', (req, res) => {
    docFile(req.params.id);
    throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
  });
  app.post('/api/documents/:id/open-folder', (req, res) => {
    docFile(req.params.id);
    throw httpError(400, 'Navegador de arquivos do SO indisponível no modo Web.');
  });

  return { extras, publicCoordinator };
}

module.exports = { mount, isSafeDocFile, DOC_EXT, isHttpUrl };
