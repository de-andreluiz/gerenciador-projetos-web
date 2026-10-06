// Ciclos de migração reutilizáveis (modelo) e a cópia que cada projeto usa (execução).
//
//   Tipo de projeto ──(ciclo padrão do tipo)──► Ciclo (data.cycles: nome + passos [{id, stageId, checklistIds}] + versão)
//                                                  │  cada passo aponta para um Estágio reutilizável (data.stages) e traz a LISTA
//                                                  │  ORDENADA dos checklists que aquele estágio usa NAQUELE ciclo (a ordem faz parte
//                                                  ▼  da associação: o mesmo checklist pode ter posições diferentes em ciclos diferentes)
//   Projeto: cycleId + steps (CÓPIA dos passos) + cycleVersion      Checklist (data.checklists, reutilizável) ──► Itens
//
// Estágios e checklists são cadastros reutilizáveis e independentes; quem os relaciona é o passo do ciclo (ciclo + estágio +
// checklists). Um checklist nunca é copiado ao ser associado a outro ciclo: só o id vai para a lista do passo.
//
// O projeto nunca lê os passos "ao vivo" do ciclo: mudar o ciclo (inclusive os checklists de um passo) só incrementa a versão e o
// projeto mostra "nova versão disponível" até alguém revisar e aplicar. Os ids dos passos são únicos em todo o app e são mantidos
// entre versões, então o andamento (etapa atual, histórico, checklists por passo) continua valendo depois de aplicar uma versão nova.
const { httpError, uid, str } = require('./util');

const MAX_STEPS = 30;
const MAX_CHECKLISTS_PER_STEP = 20;
const copy = (x) => JSON.parse(JSON.stringify(x));
const listIds = (s) => (Array.isArray(s?.checklistIds) ? s.checklistIds : []);
const stepKey = (s) => [s.id, s.stageId, listIds(s).join(',')];
const sameSteps = (a, b) => JSON.stringify((a || []).map(stepKey)) === JSON.stringify((b || []).map(stepKey));

// Migração (idempotente): o ciclo único antigo (data.cycle) vira o "Ciclo de migração padrão"; projetos recebem a cópia dele
// com os MESMOS ids de passo, então a etapa atual e o histórico continuam iguais.
function ensureCycles(data, defaultSteps) {
  if (!Array.isArray(data.cycles)) {
    const steps = Array.isArray(data.cycle) && data.cycle.length ? data.cycle : copy(defaultSteps);
    data.cycles = [{ id: 'cyc-padrao', name: 'Ciclo de migração padrão', description: '', steps: copy(steps), version: 1, updatedAt: null }];
  }
  delete data.cycle;
  for (const c of data.cycles) {
    if (!Array.isArray(c.steps)) c.steps = [];
    if (!Number.isInteger(c.version)) c.version = 1;
    if (c.description === undefined) c.description = '';
  }
  if (!data.cycles.some((c) => c.id === data.defaultCycleId)) data.defaultCycleId = data.cycles[0]?.id || null;
  for (const t of data.projectTypes || []) if (t.cycleId === undefined) t.cycleId = null;
  const byId = new Map(data.cycles.map((c) => [c.id, c]));
  for (const p of data.projects || []) {
    if (p.cycleId === undefined || !Array.isArray(p.steps)) {
      const c = byId.get(p.cycleId) || byId.get(data.defaultCycleId);
      p.cycleId = c ? c.id : null;
      p.steps = c ? copy(c.steps) : [];
      p.cycleVersion = c ? c.version : 0;
    }
  }
  // Checklists por estágio: os itens antigos (um checklist implícito por estágio) passam a pertencer a "Checklist".
  if (!Array.isArray(data.checklists)) data.checklists = [];
  for (const it of data.checklistItems || []) { if (typeof it.carryForward !== 'boolean') it.carryForward = false; if (!Array.isArray(it.dependsOn)) it.dependsOn = []; } // transferência de pendência (padrão: não) e dependências
  for (const it of data.checklistItems || []) {
    if (it.checklistId && data.checklists.some((c) => c.id === it.checklistId)) continue;
    const id = `ck-${it.stageId}`;
    if (!data.checklists.some((c) => c.id === id)) data.checklists.push({ id, stageId: it.stageId, name: 'Checklist' });
    it.checklistId = id;
  }
  for (const p of data.projects || []) {
    for (const inst of p.checklists || []) {
      for (const it of inst.items || []) {
        if (!it.checklistId) it.checklistId = (data.checklistItems || []).find((d) => d.id === it.defId)?.checklistId || `ck-${inst.stageId}`;
        if (!Array.isArray(it.runs)) it.runs = [];
        if (typeof it.carryForward !== 'boolean') it.carryForward = false;
        if (!Array.isArray(it.dependsOn)) it.dependsOn = [];
        if (it.note === undefined) it.note = null;
        if (it.carriedTo === undefined) { it.carriedTo = null; it.carriedAt = null; }
        if (!Array.isArray(it.carryHistory)) it.carryHistory = [];
      }
    }
  }
  migrateStepChecklists(data);
  return data;
}

// Checklists por passo do ciclo (antes: por estágio). Antes cada checklist pertencia a um estágio (checklist.stageId) e TODO ciclo que
// usava o estágio recebia todos eles. Para nada mudar, cada passo (do ciclo E da cópia que cada projeto guarda) passa a listar os
// checklists que o seu estágio tinha, na mesma ordem. Só atua em passo SEM `checklistIds` (idempotente: depois de migrado nunca mais
// é recalculado, então editar a associação de um ciclo não é desfeito). `checklist.stageId` é o estágio para o qual o checklist foi
// cadastrado (conjunto disponível do estágio); `item.stageId` é só legado, ignorado.
function migrateStepChecklists(data) {
  const byStage = new Map();
  for (const ck of data.checklists || []) {
    if (!ck.stageId) continue;
    if (!byStage.has(ck.stageId)) byStage.set(ck.stageId, []);
    byStage.get(ck.stageId).push(ck.id);
  }
  const fill = (steps) => { for (const s of steps || []) if (!Array.isArray(s.checklistIds)) s.checklistIds = [...(byStage.get(s.stageId) || [])]; };
  for (const c of data.cycles || []) fill(c.steps);
  for (const p of data.projects || []) fill(p.steps);
}

// O arquivo salvo ainda está no modelo antigo (passos sem checklistIds)? Usado para guardar uma cópia antes da primeira migração.
function needsChecklistMigration(raw) {
  const missing = (steps) => Array.isArray(steps) && steps.some((s) => !Array.isArray(s.checklistIds));
  if (!Array.isArray(raw?.cycles)) return Array.isArray(raw?.checklistItems) && raw.checklistItems.length > 0; // ciclo único antigo
  return raw.cycles.some((c) => missing(c.steps)) || (raw.projects || []).some((p) => missing(p.steps));
}

// Onde um checklist é usado: [{ cycleId, cycleName, stepId, stageId, stageName }] (um estágio repetido no ciclo aparece em cada passo).
function checklistUsage(data, checklistId) {
  const out = [];
  for (const c of data.cycles || []) {
    for (const s of c.steps) {
      if (listIds(s).includes(checklistId)) out.push({ cycleId: c.id, cycleName: c.name, stepId: s.id, stageId: s.stageId, stageName: data.stages.find((x) => x.id === s.stageId)?.name || '?' });
    }
  }
  return out;
}
const usageLabel = (u) => `${u.cycleName} / ${u.stageName}`;

// Checklists cadastrados para um estágio (checklist.stageId), na ordem do cadastro: é o conjunto "disponível" daquele estágio e o PADRÃO de
// uma etapa nova do ciclo (todos selecionados). Depois de criada, a etapa guarda a sua própria lista e só muda quando a pessoa edita.
const checklistPool = (data, stageId) => (data.checklists || []).filter((c) => stageId && c.stageId === stageId).map((c) => c.id);

// Lista (ordenada) de checklists de um passo: ids repetidos contam uma vez; todos precisam existir no cadastro de checklists.
function cleanChecklistIds(data, raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map((x) => str(x, 40)).filter(Boolean))];
  if (ids.length > MAX_CHECKLISTS_PER_STEP) throw httpError(400, `No máximo ${MAX_CHECKLISTS_PER_STEP} checklists por estágio em um ciclo.`);
  const known = new Set((data.checklists || []).map((c) => c.id));
  if (!ids.every((id) => known.has(id))) throw httpError(400, 'Um dos checklists escolhidos não existe mais. Recarregue a tela e tente de novo.');
  return ids;
}

// Passos vindos da tela: estágio precisa existir; ids já usados NESTE ciclo são mantidos, os demais recebem id novo.
// Checklists do passo: os enviados; senão, os que o passo já tinha (só se continua no mesmo estágio); passo novo — ou passo que trocou de
// estágio, porque a associação é do par ciclo + estágio — começa com TODOS os checklists cadastrados para o estágio (padrão).
function cleanSteps(data, raw, existingSteps = []) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_STEPS) throw httpError(400, `O ciclo precisa ter de 1 a ${MAX_STEPS} passos.`);
  const known = new Set(data.stages.map((s) => s.id));
  const before = new Map(existingSteps.map((s) => [s.id, s]));
  const used = new Set();
  return raw.map((s) => {
    if (!known.has(s?.stageId)) throw httpError(400, 'Estágio inexistente no ciclo.');
    const keep = before.has(s.id) && !used.has(s.id);
    const id = keep ? s.id : uid();
    used.add(id);
    const prev = keep ? before.get(s.id) : null;
    const checklistIds = Array.isArray(s.checklistIds) ? cleanChecklistIds(data, s.checklistIds)
      : prev && prev.stageId === s.stageId ? [...listIds(prev)] : checklistPool(data, s.stageId);
    return { id, stageId: s.stageId, checklistIds };
  });
}

function cleanCycle(data, b, existing) {
  const name = str(b.name, 80);
  if (!name) throw httpError(400, 'Informe o nome do ciclo.');
  if (data.cycles.some((c) => c.id !== existing?.id && c.name.trim().toLowerCase() === name.toLowerCase())) throw httpError(409, `Já existe um ciclo chamado “${name}”.`);
  const steps = cleanSteps(data, b.steps, existing?.steps || []);
  return { name, description: str(b.description, 400), steps };
}

// Qual ciclo um projeto novo recebe: o escolhido, senão o do tipo, senão o padrão.
function cycleFor(data, { cycleId, projectTypeId }) {
  const byId = (id) => data.cycles.find((c) => c.id === id) || null;
  if (cycleId) { const c = byId(cycleId); if (!c) throw httpError(400, 'Ciclo inexistente.'); return c; }
  const t = (data.projectTypes || []).find((x) => x.id === projectTypeId);
  return (t && byId(t.cycleId)) || byId(data.defaultCycleId) || data.cycles[0] || null;
}

function assignCycle(project, cycle) {
  project.cycleId = cycle ? cycle.id : null;
  project.steps = cycle ? copy(cycle.steps) : [];
  project.cycleVersion = cycle ? cycle.version : 0;
}

// Diferença entre os passos do projeto e a versão atual do ciclo (o que "Aplicar" faria).
function cycleDiff(data, project) {
  const cycle = data.cycles.find((c) => c.id === project.cycleId);
  if (!cycle) return { available: false, missing: !!project.cycleId };
  const stageName = (id) => data.stages.find((s) => s.id === id)?.name || '?';
  const mine = project.steps || [];
  const theirs = cycle.steps;
  if (sameSteps(mine, theirs)) return { available: false, cycleName: cycle.name, version: cycle.version };
  const ids = new Set(theirs.map((s) => s.id));
  const had = new Set(mine.map((s) => s.id));
  const removed = mine.filter((s) => !ids.has(s.id)).map((s) => ({ id: s.id, stageName: stageName(s.stageId), started: (project.checklists || []).some((c) => c.stepId === s.id) }));
  const added = theirs.filter((s) => !had.has(s.id)).map((s) => ({ id: s.id, stageName: stageName(s.stageId) }));
  const changed = theirs.filter((s) => had.has(s.id) && mine.find((m) => m.id === s.id).stageId !== s.stageId).map((s) => ({ id: s.id, stageName: stageName(s.stageId) }));
  // Checklists de um passo que continua com o mesmo estágio: quais entram, quais saem e se só a ordem mudou.
  const ckName = (id) => data.checklists.find((c) => c.id === id)?.name || '(removido)';
  const checklistChanges = theirs.filter((s) => had.has(s.id) && mine.find((m) => m.id === s.id).stageId === s.stageId).map((s) => {
    const was = listIds(mine.find((m) => m.id === s.id));
    const now = listIds(s);
    if (was.join(',') === now.join(',')) return null;
    const added = now.filter((x) => !was.includes(x)).map(ckName);
    const removed = was.filter((x) => !now.includes(x)).map(ckName);
    return { id: s.id, stageName: stageName(s.stageId), added, removed, reordered: !added.length && !removed.length, // só a ordem mudou
      started: (project.checklists || []).some((c) => c.stepId === s.id) };
  }).filter(Boolean);
  const order = !removed.length && !added.length && !changed.length && !checklistChanges.length;
  return {
    available: true, cycleName: cycle.name, version: cycle.version, from: project.cycleVersion, added, removed, changed, checklistChanges, reordered: order,
    currentRemoved: !!project.stepId && !ids.has(project.stepId),
    before: mine.map((s) => stageName(s.stageId)), after: theirs.map((s) => stageName(s.stageId)),
  };
}

module.exports = { ensureCycles, migrateStepChecklists, needsChecklistMigration, cleanSteps, cleanChecklistIds, cleanCycle, cycleFor, assignCycle, cycleDiff, sameSteps, checklistUsage, usageLabel, listIds, checklistPool, MAX_STEPS, MAX_CHECKLISTS_PER_STEP };
