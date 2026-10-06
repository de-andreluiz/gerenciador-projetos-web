// Checklist por passo do ciclo — regras puras (sem HTTP nem disco), para poderem ser testadas e reaproveitadas.
//
// DEFINIÇÃO × EXECUÇÃO
//  - Definição: checklists reutilizáveis (data.checklists) com seus itens (data.checklistItems, agrupados por checklistId, na ordem em
//    que aparecem), editados em Configurações. Um checklist não pertence a estágio nem a ciclo: quem os relaciona é o PASSO DO CICLO
//    (step.checklistIds, lista ordenada = ciclo + estágio + checklists; ver src/cycles.js). O modelo de um passo é a concatenação dos
//    itens dos checklists listados nele, na ordem da lista. O mesmo checklist pode estar em vários ciclos/estágios sem ser copiado.
//  - Execução (project.checklists): uma instância por PASSO DO CICLO (um estágio pode se repetir no ciclo, e cada passagem tem o seu
//    próprio andamento). Ao entrar no passo o projeto recebe uma CÓPIA dos itens dos checklists que o passo (da cópia do ciclo que o
//    projeto guarda) lista; mudar o modelo depois nunca altera projetos em andamento sozinho — só quando alguém pede "Sincronizar"
//    (com pré-visualização do que muda). Mudar os checklists de um passo no ciclo gera nova versão do ciclo (aplicada por projeto).
//  - Referências (descrição, links, scripts) são só apoio: não bloqueiam nada. Só "obrigatório" e "exige evidência" bloqueiam.
//  - PENDÊNCIA TRANSFERÍVEL (carryForward, definido no modelo): um obrigatório pendente pode seguir para a próxima etapa em vez de
//    bloquear o avanço. O item NÃO é copiado: continua morando na instância do passo de origem (mesmo id, mesmas evidências e
//    execuções) e só muda de "localização" (carriedTo = passo onde ele está agora, carryHistory = cada transferência). Continua
//    pendente até ser concluído pela regra de sempre (marcado + evidência exigida). Na conclusão do ciclo (último passo) nada
//    pode ser transferido: todos os obrigatórios do projeto precisam estar concluídos.
//    A transferência pode ser DESFEITA (restorePlan/applyRestore): o item volta à etapa de origem, nada é copiado nem perdido, e a
//    volta fica no mesmo histórico (carryHistory, entrada com restored:true).
//  - OBSERVAÇÃO do item (note): texto da EXECUÇÃO daquele projeto (a descrição é do modelo). Mora no item, então acompanha transferências.
//  - DEPENDÊNCIAS (dependsOn, no modelo e copiadas no snapshot): lista de ids de itens do modelo (defId) de qualquer etapa. O item só pode
//    ser concluído quando todos estiverem concluídos pela regra real (marcado + evidência exigida), onde quer que estejam no projeto
//    (inclusive transferidos). Nada é gravado sobre "dependência cumprida": é sempre calculado do estado do item de que se depende.
//  - Preparado para evoluir: cada item tem `condition` (hoje sempre null) para regras futuras do tipo "só se o tipo do projeto = X".
const { httpError, uid, str } = require('./util');
const { EVIDENCE_TYPES } = require('./evidence');
const { listIds } = require('./cycles');
const { applyGreeting } = require('./greeting');

const MAX_ITEMS_PER_CHECKLIST = 100;
const MAX_LINKS = 10;
const MAX_SCRIPTS = 10;
const MODES = ['none', 'optional', 'required'];
const MAX_DEPS = 20;
const MAX_NOTE = 1000;

function isHttpUrl(u) {
  try { const x = new URL(String(u).trim()); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

// ---------- Definição ----------
// Valida e normaliza o que a tela envia para um item do modelo.
function cleanDefinition(b, data, selfId = null) {
  const title = str(b.title, 160);
  if (!title) throw httpError(400, 'Informe o título do item.');
  const mode = MODES.includes(b.evidence?.mode) ? b.evidence.mode : 'none';
  let type = 'imageOrDocument';
  let min = 1;
  let max = 10;
  if (mode !== 'none') {
    type = EVIDENCE_TYPES.includes(b.evidence?.type) ? b.evidence.type : (() => { throw httpError(400, 'Escolha o tipo de evidência.'); })();
    min = mode === 'required' ? Number(b.evidence?.min ?? 1) : 0;
    max = Number(b.evidence?.max ?? 10);
    if (!Number.isInteger(max) || max < 1 || max > 20) throw httpError(400, 'A quantidade máxima de evidências deve ser de 1 a 20.');
    if (mode === 'required' && (!Number.isInteger(min) || min < 1 || min > max)) throw httpError(400, 'A quantidade mínima de evidências deve ser de 1 até o máximo.');
  }
  const rawLinks = Array.isArray(b.links) ? b.links : [];
  if (rawLinks.length > MAX_LINKS) throw httpError(400, `No máximo ${MAX_LINKS} links por item.`);
  const links = rawLinks.map((l) => {
    const url = str(l.url, 800);
    if (!isHttpUrl(url)) throw httpError(400, `O link “${str(l.title, 60) || url.slice(0, 40)}” precisa começar com http:// ou https://.`);
    let title2 = str(l.title, 120);
    if (!title2) { try { title2 = new URL(url).hostname; } catch { title2 = url.slice(0, 60); } }
    return { id: typeof l.id === 'string' && /^[a-f0-9]{12}$/.test(l.id) ? l.id : uid(), title: title2, url, description: str(l.description, 300) };
  });
  const scriptIds = [...new Set((Array.isArray(b.scriptIds) ? b.scriptIds : []).map((s) => str(s, 40)).filter(Boolean))];
  if (scriptIds.length > MAX_SCRIPTS) throw httpError(400, `No máximo ${MAX_SCRIPTS} scripts por item.`);
  for (const sid of scriptIds) if (!data.scripts.some((s) => s.id === sid)) throw httpError(400, 'Um dos scripts escolhidos não existe mais na lista de Scripts SQL.');
  const dependsOn = cleanDependsOn(b.dependsOn, data, selfId);
  // Ação "Gerar e-mail": modelo GLOBAL de Comunicações (o checklist é reutilizável). Só gravado quando há modelo (campo ausente =
  // nenhum), para itens antigos não aparecerem como "alterados" na sincronização. Gerar/copiar não conclui o item.
  const emailTemplateId = str(b.emailTemplateId, 40) || null;
  if (emailTemplateId) {
    const t = (data.emailTemplates || []).find((x) => x.id === emailTemplateId);
    if (!t) throw httpError(400, 'O modelo de e-mail escolhido não existe mais.');
    if (t.scope !== 'global') throw httpError(400, `O modelo “${t.name}” é específico de um projeto; itens de checklist só usam modelos globais.`);
  }
  // Transferir só faz sentido para obrigatório (opcional já não bloqueia); guardado como false nos opcionais.
  return { title, description: str(b.description, 1000), required: !!b.required, carryForward: !!b.required && !!b.carryForward, dependsOn, evidence: { mode, type, min, max }, links, scriptIds, ...(emailTemplateId ? { emailTemplateId } : {}), condition: null };
}

// ---------- Dependências (modelo) ----------
const defLabel = (data, d) => `${(data.checklists || []).find((c) => c.id === d.checklistId)?.name || '?'} / ${d.title}`;
// Caminho de dependências que sai de `from` e chega em `target` (ou null). Só segue as dependências JÁ GRAVADAS no modelo.
function depPath(data, from, target, seen = new Set()) {
  if (from === target) return [from];
  if (seen.has(from)) return null;
  seen.add(from);
  const d = data.checklistItems.find((x) => x.id === from);
  for (const n of d?.dependsOn || []) { const p = depPath(data, n, target, seen); if (p) return [from, ...p]; }
  return null;
}
function cleanDependsOn(raw, data, selfId) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map((x) => str(x, 40)).filter(Boolean))];
  if (ids.length > MAX_DEPS) throw httpError(400, `No máximo ${MAX_DEPS} dependências por item.`);
  for (const id of ids) {
    if (selfId && id === selfId) throw httpError(400, 'Um item não pode depender de si mesmo.');
    if (!data.checklistItems.some((x) => x.id === id)) throw httpError(400, 'Um dos itens escolhidos como dependência não existe mais no modelo.');
  }
  if (selfId) { // A→B→C→A: alguma dependência nova que já dependa (direta ou indiretamente) deste item fecha um círculo
    for (const id of ids) {
      const back = depPath(data, id, selfId);
      if (back) {
        const names = [selfId, ...back].map((x) => data.checklistItems.find((d) => d.id === x)?.title || '?');
        throw httpError(400, `Não é possível criar esta dependência. Ela geraria uma dependência circular: ${names.join(' → ')}.`, { code: 'DEPENDENCY_CIRCULAR' });
      }
    }
  }
  return ids;
}
// Quem depende dos itens `ids` (fora do próprio conjunto): serve para não apagar do modelo algo que é dependência de outro item.
function dependentsOf(data, ids) {
  const set = new Set(ids);
  return data.checklistItems.filter((d) => !set.has(d.id) && (d.dependsOn || []).some((x) => set.has(x)));
}
function dependentsMessage(data, what, deps) {
  return `${what} é usado como dependência por:\n${deps.map((d) => `• ${defLabel(data, d)}`).join('\n')}\n\nRemova ou altere essas dependências antes de excluir.`;
}

// Itens do modelo de uma lista de checklists (a de um passo do ciclo): na ordem da lista e, dentro de cada checklist, na ordem dos itens.
// Id que não existe mais no cadastro é ignorado (o checklist foi removido do modelo).
function defsFor(data, checklistIds) {
  return checklistsFor(data, checklistIds).flatMap((c) => data.checklistItems.filter((d) => d.checklistId === c.id));
}
function checklistsFor(data, checklistIds) {
  const byId = new Map((data.checklists || []).map((c) => [c.id, c]));
  return [...new Set(checklistIds || [])].map((id) => byId.get(id)).filter(Boolean);
}
const defsForStep = (data, step) => defsFor(data, listIds(step));
const checklistsForStep = (data, step) => checklistsFor(data, listIds(step));

// ---------- Execução ----------
const CRITERIA = ['title', 'description', 'required', 'carryForward', 'dependsOn', 'evidence', 'links', 'scriptIds', 'emailTemplateId', 'checklistId'];
const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x))); // campo ausente no modelo antigo continua ausente

function snapshotItem(def) {
  return {
    id: uid(), defId: def.id, ...copy(Object.fromEntries(CRITERIA.map((k) => [k, def[k]]))), condition: def.condition ?? null,
    done: false, doneAt: null, doneBy: null, completedAt: null, completedBy: null, archived: false, evidences: [], runs: [],
    carriedTo: null, carriedAt: null, carryHistory: [], // transferência de pendência (só muda a localização; o item é sempre este)
    note: null, // observação desta execução: { text, updatedAt, updatedBy }
  };
}

// Os passos vêm do PROJETO (cópia do ciclo que ele usa), não de um ciclo global: cada tipo de projeto pode ter o seu ciclo.
const stepsOf = (project) => (Array.isArray(project?.steps) ? project.steps : []);
const stepOf = (project, stepId) => stepsOf(project).find((c) => c.id === stepId) || null;
const stageOfStep = (data, step) => data.stages.find((s) => s.id === step?.stageId) || null;

// Instância do passo (cria a partir do modelo do estágio se ainda não existir). Devolve null se o passo não existe no ciclo.
function ensureInstance(data, project, stepId, now = new Date().toISOString()) {
  const existing = project.checklists.find((c) => c.stepId === stepId);
  if (existing) return existing;
  const step = stepOf(project, stepId);
  if (!step) return null;
  const stage = stageOfStep(data, step);
  const inst = { id: uid(), stepId, stageId: step.stageId, stageName: stage?.name || '?', createdAt: now, syncedAt: now, items: defsForStep(data, step).map(snapshotItem) };
  project.checklists.push(inst);
  return inst;
}

// pendente → marcado mas sem a evidência exigida → concluído
function itemStatus(item) {
  if (!item.done) return 'pending';
  if (item.evidence.mode === 'required' && item.evidences.length < item.evidence.min) return 'awaiting_evidence';
  return 'done';
}

const live = (inst) => inst.items.filter((i) => !i.archived);

function progressOf(items) {
  const req = items.filter((i) => i.required);
  const opt = items.filter((i) => !i.required);
  const isDone = (i) => itemStatus(i) === 'done';
  const done = items.filter(isDone).length;
  return {
    total: items.length, done, percent: items.length ? Math.round((done / items.length) * 100) : 0,
    requiredTotal: req.length, requiredDone: req.filter(isDone).length, optionalTotal: opt.length, optionalDone: opt.filter(isDone).length,
    awaitingEvidence: items.filter((i) => itemStatus(i) === 'awaiting_evidence').length,
  };
}

// Sem instância ainda: o que seria criado a partir do modelo do passo (nada concluído).
const virtualItems = (data, step) => defsForStep(data, step).map(snapshotItem);

// Progresso do PASSO (itens próprios) + herdadas (vindas de etapas anteriores) + transferidas (próprias que seguiram adiante, ainda pendentes).
function progressForStep(data, project, stepId) {
  const inst = project.checklists.find((c) => c.stepId === stepId);
  const inh = inheritedAt(project, stepId).map((x) => x.it);
  const inherited = { total: inh.length, done: inh.filter((i) => itemStatus(i) === 'done').length, pending: inh.filter((i) => i.required && itemStatus(i) !== 'done').length };
  if (inst) {
    const carriedOut = live(inst).filter((i) => i.carriedTo && locationOf(project, inst, i) !== stepId && itemStatus(i) !== 'done').length;
    return { ...progressOf(live(inst)), started: true, inherited, carriedOut };
  }
  const step = stepOf(project, stepId);
  return { ...progressOf(step ? virtualItems(data, step) : []), started: false, inherited, carriedOut: 0 };
}

// Progresso do PROJETO no ciclo (barra da lateral e da Visão Geral — a ÚNICA definição; a tela nunca recalcula).
// Cada ETAPA do ciclo vale o mesmo (1/N) e a etapa só soma o quanto foi feito DENTRO dela:
//  - etapa com checklist: fração de itens concluídos (obrigatórios E opcionais, como em progressOf; concluído = itemStatus 'done',
//    ou seja, marcado + evidência exigida). Itens da instância se ela existe (vivos; pendência transferida continua no passo de
//    origem até ser concluída); senão os do modelo do passo (todos pendentes);
//  - etapa SEM itens de checklist: conta 100% só quando o projeto já passou por ela (ou concluiu o ciclo); a etapa atual e as
//    futuras contam 0 — assim "todos os itens marcados" nunca vira 100% com etapas ainda por vir;
//  - o projeto só chega a 100% ao CONCLUIR o ciclo (estar no último passo, a mesma regra de "projeto concluído" das horas);
//    antes disso o teto é 99%. Sem etapas no ciclo → percent null (a tela não mostra barra).
// Devolve também a contagem de itens (done/total) e de etapas (stepsPassed/steps) para a dica da barra.
function projectProgress(data, project) {
  const steps = stepsOf(project);
  const n = steps.length;
  if (!n) return { percent: null, total: 0, done: 0, steps: 0, stepsPassed: 0, current: 0, concluded: false, requiredTotal: 0, requiredDone: 0, awaitingEvidence: 0 };
  const cur = steps.findIndex((s) => s.id === project.stepId);
  const concluded = cur === n - 1;
  const inCycle = new Set(steps.map((s) => s.id));
  const own = new Map(steps.map((s) => [s.id, []])); // itens de cada etapa (no passo de ORIGEM)
  for (const { inst, it } of liveItems(project)) if (own.has(inst.stepId) && inCycle.has(locationOf(project, inst, it))) own.get(inst.stepId).push(it);
  let fractions = 0; const all = [];
  steps.forEach((step, i) => {
    const hasInst = (project.checklists || []).some((c) => c.stepId === step.id);
    const items = hasInst ? own.get(step.id) : virtualItems(data, step);
    all.push(...items);
    if (items.length) fractions += items.filter((x) => itemStatus(x) === 'done').length / items.length;
    else if (concluded || (cur >= 0 && i < cur)) fractions += 1; // etapa sem itens já ultrapassada
  });
  const p = progressOf(all);
  const percent = concluded ? 100 : Math.min(99, Math.round((fractions / n) * 100));
  return { percent, total: p.total, done: p.done, steps: n, stepsPassed: concluded ? n : Math.max(cur, 0), current: cur + 1, concluded, requiredTotal: p.requiredTotal, requiredDone: p.requiredDone, awaitingEvidence: p.awaitingEvidence };
}

// Itens obrigatórios que ainda não estão concluídos (com o motivo, para a tela explicar).
function pendingRequired(items) {
  return items.filter((i) => i.required && itemStatus(i) !== 'done').map((i) => {
    const status = itemStatus(i);
    return { id: i.id, title: i.title, status, missingEvidence: status === 'awaiting_evidence' ? i.evidence.min - i.evidences.length : (i.evidence.mode === 'required' ? i.evidence.min : 0), carryForward: !!i.carryForward };
  });
}

// ---------- Localização das pendências (transferência) ----------
const stageNameOf = (data, project, stepId) => stageOfStep(data, stepOf(project, stepId))?.name || '?';
// Onde o item está agora: o passo para onde foi transferido (se ainda existir no ciclo; se o passo saiu do ciclo, a pendência
// fica na etapa atual para não sumir) ou o próprio passo de origem.
function locationOf(project, inst, it) {
  if (!it.carriedTo) return inst.stepId;
  return stepOf(project, it.carriedTo) ? it.carriedTo : (project.stepId || inst.stepId);
}
// Itens vivos de todas as instâncias do projeto, com a instância (passo) de origem.
const liveItems = (project) => (project.checklists || []).flatMap((inst) => live(inst).map((it) => ({ inst, it })));
// Pendências herdadas de um passo: itens de OUTROS passos que foram transferidos para ele (concluídos ou não — o histórico fica visível).
const inheritedAt = (project, stepId) => liveItems(project).filter(({ inst, it }) => it.carriedTo && inst.stepId !== stepId && locationOf(project, inst, it) === stepId);
// Itens que estão neste passo: os próprios que não foram transferidos + os herdados.
const itemsAt = (project, stepId) => liveItems(project).filter(({ inst, it }) => locationOf(project, inst, it) === stepId);

function carryRef(data, project, inst, it, loc) {
  const base = pendingRequired([it])[0];
  return {
    ...base, key: `${inst.stepId}:${it.id}`, origin: { stepId: inst.stepId, stageName: inst.stageName }, at: { stepId: loc, stageName: stageNameOf(data, project, loc) },
    inherited: loc !== inst.stepId, transfers: (it.carryHistory || []).length,
  };
}

// Mudança de passo: só ir PARA A FRENTE exige o checklist. Cada passo que está sendo deixado para trás (inclusive os pulados)
// não pode ter obrigatório pendente — nem os próprios, nem os herdados que estão nele. Obrigatório pendente marcado como
// transferível não bloqueia: volta em `transferable` (a rota pede confirmação e só então transfere).
// Conclusão (ir para o ÚLTIMO passo): nada é transferível e TODO obrigatório pendente do projeto bloqueia, de qualquer etapa.
// Voltar, repetir o mesmo passo e limpar a etapa nunca são bloqueados.
function checkAdvance(data, project, targetStepId) {
  const steps = stepsOf(project);
  const from = steps.findIndex((c) => c.id === project.stepId);
  const to = targetStepId ? steps.findIndex((c) => c.id === targetStepId) : -1;
  const target = to >= 0 ? { stepId: steps[to].id, stageName: stageOfStep(data, steps[to])?.name || '?' } : null;
  if (to < 0 || to <= from) return { ok: true, blocked: [], transferable: [], final: false, target };
  const final = to === steps.length - 1;
  const idx = new Map(steps.map((s, i) => [s.id, i]));
  const leaving = (i) => from >= 0 && i >= from && i < to;
  const found = []; // [índice do passo onde está, pendência]
  for (const { inst, it } of liveItems(project)) {
    if (!it.required || itemStatus(it) === 'done') continue;
    const loc = locationOf(project, inst, it);
    const i = idx.get(loc);
    if (i === undefined) continue; // instância de um passo que saiu do ciclo, sem transferência: fica guardada, fora da conta (como antes)
    if (leaving(i) || (final && i < to)) found.push([i, carryRef(data, project, inst, it, loc)]);
  }
  // Passos pulados que nunca foram abertos: os obrigatórios do modelo (ainda não copiados) também contam.
  for (let i = Math.max(from, 0); from >= 0 && i < to; i++) {
    const step = steps[i];
    if (project.checklists.some((c) => c.stepId === step.id)) continue;
    const stageName = stageOfStep(data, step)?.name || '?';
    for (const d of defsForStep(data, step)) {
      if (!d.required) continue;
      const p = pendingRequired([snapshotItem(d)])[0];
      found.push([i, { ...p, id: null, defId: d.id, virtual: true, key: `${step.id}:def:${d.id}`, origin: { stepId: step.id, stageName }, at: { stepId: step.id, stageName }, inherited: false, transfers: 0 }]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const blocked = [];
  const transferable = [];
  for (const [, e] of found) {
    if (!final && e.carryForward) { transferable.push(e); continue; }
    let g = blocked.find((b) => b.stepId === e.at.stepId);
    if (!g) { g = { stepId: e.at.stepId, stageName: e.at.stageName, pending: [] }; blocked.push(g); }
    g.pending.push(e);
  }
  return { ok: !blocked.length, blocked, transferable, final, target };
}

// Transfere as pendências confirmadas para o passo de destino. Não cria cópia: o item muda de localização e ganha uma linha no
// histórico. Passo pulado que nunca foi aberto recebe a sua instância primeiro (o item precisa existir para ser acompanhado).
function applyCarry(data, project, entries, targetStepId, who, now = new Date().toISOString()) {
  const toStage = stageNameOf(data, project, targetStepId);
  const moved = [];
  for (const e of entries) {
    const inst = project.checklists.find((c) => c.stepId === e.origin.stepId) || ensureInstance(data, project, e.origin.stepId, now);
    if (!inst) continue;
    const it = e.virtual ? live(inst).find((i) => i.defId === e.defId) : inst.items.find((i) => i.id === e.id);
    if (!it || itemStatus(it) === 'done') continue;
    it.carryHistory = [...(it.carryHistory || []), { fromStepId: e.at.stepId, fromStage: e.at.stageName, toStepId: targetStepId, toStage, at: now, by: who || null }];
    it.carriedTo = targetStepId === inst.stepId ? null : targetStepId;
    it.carriedAt = now;
    moved.push({ inst, it, fromStepId: e.at.stepId, from: e.at.stageName, to: toStage });
  }
  return moved;
}

// ---------- Reverter transferência ----------
// Valida se o item pode voltar ao passo de origem. Não move nada; devolve o que a tela precisa para pedir a confirmação.
function restorePlan(data, project, inst, it) {
  if (it.archived) return { status: 400, error: 'Este item foi removido do modelo e não pode mais ser alterado.' };
  if (!it.carriedTo) return { status: 400, error: 'Este item não está transferido para outra etapa.' };
  const steps = stepsOf(project);
  const oi = steps.findIndex((s) => s.id === inst.stepId);
  if (oi < 0) return { status: 409, code: 'RESTORE_IMPOSSIBLE', error: `Não foi possível restaurar: a etapa original deste item (${inst.stageName}) não existe mais no ciclo deste projeto. O item não foi movido.` };
  if (steps[oi].stageId !== inst.stageId) {
    return { status: 409, code: 'RESTORE_IMPOSSIBLE', error: `Não foi possível restaurar: a etapa original deste item era “${inst.stageName}”, mas esse passo do ciclo agora é “${stageNameOf(data, project, inst.stepId)}”. O item não foi movido.` };
  }
  const from = locationOf(project, inst, it);
  const cur = steps.findIndex((s) => s.id === project.stepId);
  const warnings = [];
  if (cur >= 0 && oi < cur) {
    warnings.push(`A etapa original (${inst.stageName}) já foi deixada para trás. O item volta para lá e continua pendente: enquanto estiver lá, ele não trava o avanço das etapas seguintes, mas continua impedindo a conclusão do projeto (se for obrigatório). Se quiser resolvê-lo junto com as etapas em andamento, não restaure — ou volte o projeto para “${inst.stageName}”.`);
  }
  return { ok: true, from, fromStage: stageNameOf(data, project, from), to: inst.stepId, toStage: inst.stageName, warnings };
}
// Devolve o MESMO item ao passo de origem. Não apaga nem copia nada (evidências, observação, scripts, links e histórico ficam).
function applyRestore(it, plan, who, now = new Date().toISOString()) {
  it.carryHistory = [...(it.carryHistory || []), { fromStepId: plan.from, fromStage: plan.fromStage, toStepId: plan.to, toStage: plan.toStage, at: now, by: who || null, restored: true }];
  it.carriedTo = null;
  it.carriedAt = null;
}

// ---------- Observação do item ----------
// Devolve false se nada mudou. Texto vazio remove a observação. {{greeting}} vira Bom dia/Boa tarde/Boa noite NO MOMENTO DE SALVAR
// (horário local); o que fica gravado é o texto já resolvido, e não a variável.
function setNote(it, text, who, now = new Date().toISOString()) {
  const t = str(applyGreeting(text, new Date(now)), MAX_NOTE);
  if ((it.note?.text || '') === t) return false;
  it.note = t ? { text: t, updatedAt: now, updatedBy: who || null } : null;
  return true;
}

// ---------- Dependências (execução) ----------
// Índice feito UMA vez por resposta (evita varrer o projeto a cada item): defId → itens vivos do projeto com esse defId.
function buildDepIndex(data, project) {
  const byDef = new Map();
  for (const x of liveItems(project)) { if (!x.it.defId) continue; if (!byDef.has(x.it.defId)) byDef.set(x.it.defId, []); byDef.get(x.it.defId).push(x); }
  const stepByChecklist = new Map(); // checklist → primeiro passo do ciclo DESTE projeto que o usa
  for (const s of stepsOf(project)) for (const id of listIds(s)) if (!stepByChecklist.has(id)) stepByChecklist.set(id, s);
  return { data, project, byDef, defs: new Map((data.checklistItems || []).map((d) => [d.id, d])), stepByChecklist };
}
// Situação de UMA dependência, sempre calculada do item de que se depende (regra real de conclusão, inclusive a evidência).
//  done | pending | na (nenhuma etapa do ciclo deste projeto usa o checklist do item, ou o item saiu do modelo: não bloqueia).
// Se o checklist aparece em mais de uma etapa (ou a etapa se repete) no ciclo, basta UMA passagem concluída.
function dependencyState(idx, defId) {
  const g = idx.byDef.get(defId);
  if (g && g.length) {
    const done = g.find((x) => itemStatus(x.it) === 'done');
    const ref = done || g[0];
    return { defId, title: ref.it.title, stageName: ref.inst.stageName, status: done ? 'done' : 'pending', itemId: ref.it.id, stepId: ref.inst.stepId, viewStepId: locationOf(idx.project, ref.inst, ref.it) };
  }
  const def = idx.defs.get(defId);
  if (!def) return { defId, title: 'Item removido do modelo', stageName: '', status: 'na', itemId: null, stepId: null, viewStepId: null };
  const step = idx.stepByChecklist.get(def.checklistId);
  return { defId, title: def.title, stageName: step ? (stageOfStep(idx.data, step)?.name || '?') : '', checklistName: idx.data.checklists.find((c) => c.id === def.checklistId)?.name || '?', status: step ? 'pending' : 'na', itemId: null, stepId: step?.id || null, viewStepId: null };
}
const dependenciesOf = (idx, it) => (it.dependsOn || []).map((d) => dependencyState(idx, d));
// Dependências pendentes que impedem CONCLUIR o item (item já concluído não é reaberto por isso).
const blockedBy = (idx, it) => (itemStatus(it) === 'done' ? [] : dependenciesOf(idx, it).filter((d) => d.status === 'pending'));

// Pendências do projeto inteiro (não só da etapa atual), para não haver "falso 100%":
//  requiredPending = obrigatórios não concluídos que estão em qualquer etapa até a atual (próprios, herdados ou esquecidos);
//  inherited = os que estão na etapa atual vindos de etapas anteriores; carried = todos os transferidos ainda pendentes.
function projectPendencies(project) {
  const steps = stepsOf(project);
  const cur = steps.findIndex((c) => c.id === project.stepId);
  const idx = new Map(steps.map((s, i) => [s.id, i]));
  const out = { requiredPending: 0, inherited: 0, carried: 0 };
  for (const { inst, it } of liveItems(project)) {
    if (!it.required || itemStatus(it) === 'done') continue;
    const loc = locationOf(project, inst, it);
    const i = idx.get(loc);
    if (i === undefined) continue;
    if (it.carriedTo) out.carried++;
    if (cur >= 0 && i <= cur) out.requiredPending++;
    if (loc === project.stepId && inst.stepId !== loc) out.inherited++;
  }
  return out;
}

// ---------- Conclusão ----------
function refreshCompletion(item, who, now) {
  if (itemStatus(item) === 'done') { if (!item.completedAt) { item.completedAt = now; item.completedBy = who; } } else { item.completedAt = null; item.completedBy = null; }
}

function setDone(item, done, who, now) {
  item.done = !!done;
  item.doneAt = done ? now : null;
  item.doneBy = done ? who : null;
  refreshCompletion(item, who, now);
}

// ---------- Sincronizar com o modelo ----------
// Checklists que o modelo atual traz para a instância: os do passo, na cópia do ciclo que o projeto guarda. Se o passo saiu do ciclo
// do projeto, ou passou a ser de outro estágio, a instância continua com os checklists que já tem (só os itens deles são atualizados).
function modelIds(project, inst) {
  const step = stepOf(project, inst.stepId);
  if (step && step.stageId === inst.stageId) return listIds(step);
  return [...new Set(inst.items.filter((i) => !i.archived).map((i) => i.checklistId))];
}
const modelDefs = (data, project, inst) => defsFor(data, modelIds(project, inst));
const modelChecklists = (data, project, inst) => checklistsFor(data, modelIds(project, inst));

// Compara a instância com o modelo do passo. Nada é apagado: itens que saíram do modelo são ARQUIVADOS (somem da conta e do
// bloqueio, mas continuam guardados com suas evidências); marcações e evidências nunca são alteradas.
function syncPlan(data, project, inst) {
  const defs = modelDefs(data, project, inst);
  const byDef = new Map(inst.items.filter((i) => i.defId).map((i) => [i.defId, i]));
  const added = defs.filter((d) => !byDef.has(d.id));
  const updated = [];
  for (const d of defs) {
    const it = byDef.get(d.id);
    if (!it) continue;
    const changes = CRITERIA.filter((k) => JSON.stringify(it[k]) !== JSON.stringify(d[k]));
    if (changes.length || it.archived) updated.push({ id: it.id, title: it.title, changes, restore: !!it.archived });
  }
  const defIds = new Set(defs.map((d) => d.id));
  const archived = inst.items.filter((i) => !i.archived && i.defId && !defIds.has(i.defId)).map((i) => ({ id: i.id, title: i.title }));
  return { added: added.map((d) => ({ id: d.id, title: d.title, required: d.required })), updated, archived, changed: !!(added.length || updated.length || archived.length) };
}

function applySync(data, project, inst, now = new Date().toISOString()) {
  const plan = syncPlan(data, project, inst);
  const defs = modelDefs(data, project, inst);
  const byDef = new Map(inst.items.filter((i) => i.defId).map((i) => [i.defId, i]));
  const ordered = [];
  for (const d of defs) {
    let it = byDef.get(d.id);
    if (!it) it = snapshotItem(d);
    else { for (const k of CRITERIA) it[k] = copy(d[k]); it.archived = false; }
    ordered.push(it);
  }
  const defIds = new Set(defs.map((d) => d.id));
  const keep = inst.items.filter((i) => !ordered.includes(i)).map((i) => { if (i.defId && !defIds.has(i.defId)) i.archived = true; return i; });
  inst.items = [...ordered, ...keep];
  for (const it of inst.items) refreshCompletion(it, it.completedBy || null, now); // evidência que passou a ser exigida reabre o item
  inst.syncedAt = now;
  return plan;
}

module.exports = {
  MAX_ITEMS_PER_CHECKLIST, MODES, cleanDefinition, defsFor, defsForStep, modelChecklists, ensureInstance, itemStatus, live, progressOf, progressForStep, pendingRequired,
  checkAdvance, applyCarry, restorePlan, applyRestore, setNote, MAX_NOTE, buildDepIndex, dependencyState, dependenciesOf, blockedBy, dependentsOf, dependentsMessage, defLabel, projectPendencies, projectProgress, locationOf, inheritedAt, itemsAt, liveItems, stageNameOf, setDone, stepsOf, checklistsFor, checklistsForStep, snapshotItem, refreshCompletion, syncPlan, applySync, stepOf, stageOfStep, isHttpUrl,
};
