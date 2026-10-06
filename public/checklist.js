'use strict';
// Checklists: card dentro do projeto (itens, evidências, sincronização, aviso de bloqueio) e o editor dos itens de um checklist
// reutilizável em Configurações (a associação checklist ↔ estágio ↔ ciclo é feita no ciclo: ver config.js). As regras (o que bloqueia
// o avanço, o que vale como concluído) são do servidor; aqui só se mostra e se pede.

const CK = { view: new Map(), inst: new Map(), err: new Map(), loading: new Set(), open: new Set() };
const ckKey = (p, stepId) => `${p.id}:${stepId}`;
const ckStep = (p) => CK.view.get(p.id) || p.stepId; // passo exibido no card (o atual, salvo se a pessoa escolher outro)
const ckReset = () => { CK.inst.clear(); CK.err.clear(); }; // o modelo pode ter mudado: recarrega do servidor
const projectById = (id) => state.projects.find((x) => x.id === id) || null;
const ckWhen = (iso) => (iso ? fmtDateTime(iso) : '');

// Redesenha só o ciclo e o checklist (mantém a rolagem e os detalhes abertos).
function ckRefreshView(p) {
  const cycle = document.querySelector('[data-slot="cycle"]');
  const slot = document.querySelector('[data-slot="checklist"]');
  if (cycle) cycle.replaceChildren(cycleCard(p));
  if (slot) slot.replaceChildren(checklistCard(p));
}

// Guarda a resposta do servidor ({ instance, project }) e redesenha.
function ckApply(p, r) {
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) state.projects[i] = r.project;
  CK.inst.set(ckKey(p, r.instance.stepId), r.instance);
  CK.err.delete(ckKey(p, r.instance.stepId));
  const cur = projectById(p.id) || r.project;
  // Um item pode estar em outra etapa (pendência herdada) ou ser a dependência de itens de outras etapas: o que estava em cache das
  // outras etapas deste projeto fica obsoleto. A etapa exibida é relida em seguida, mantendo o que está na tela até a resposta chegar.
  const here = ckKey(p, r.instance.stepId);
  const shown = ckStep(cur);
  for (const k of [...CK.inst.keys()]) if (k.startsWith(`${p.id}:`) && k !== here && k !== ckKey(p, shown)) CK.inst.delete(k);
  ckRefreshView(cur);
  if (shown && shown !== r.instance.stepId) ckLoad(cur, shown);
  return r.instance;
}

async function ckLoad(p, stepId) {
  const key = ckKey(p, stepId);
  if (CK.loading.has(key)) return;
  CK.loading.add(key);
  try { ckApply(p, await api('POST', `/api/projects/${p.id}/checklists/${stepId}/open`, {})); } catch (e) { CK.err.set(key, e.message); ckRefreshView(projectById(p.id) || p); } finally { CK.loading.delete(key); }
}

const itemUrl = (p, inst, it) => `/api/projects/${p.id}/checklists/${inst.stepId}/items/${it.id}`;

// ---------- Card do projeto ----------
function ckProgress(pr) {
  return h('div', { class: 'ck-progress' },
    h('div', { class: 'ck-progress-text' }, h('strong', null, `${pr.done} de ${pr.total} ${pr.total === 1 ? 'item concluído' : 'itens concluídos'}`), h('span', { class: 'muted' }, `${pr.percent}%`)),
    h('div', { class: 'ck-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pr.percent }, h('div', { class: 'ck-bar-fill', style: `width:${pr.percent}%` })),
    h('div', { class: 'small muted' }, `Obrigatórios ${pr.requiredDone}/${pr.requiredTotal} · Opcionais ${pr.optionalDone}/${pr.optionalTotal}`, ' — a porcentagem considera todos os itens; só os obrigatórios bloqueiam o avanço.'));
}

// Itens próprios × pendências herdadas × obrigatórios pendentes no projeto inteiro: a etapa pode estar 100% e o projeto não.
function ckMetrics(inst) {
  const g = inst.global || { requiredPending: 0, carried: 0 };
  const ip = inst.inheritedProgress;
  if (!inst.inherited?.length && !g.carried) return null;
  return h('div', { class: 'ck-metrics small' },
    h('span', null, 'Itens próprios: ', h('strong', null, `${inst.progress.done}/${inst.progress.total}`)),
    inst.inherited?.length ? h('span', { class: ip.done < ip.total ? 'ck-wait' : 'ck-done' }, 'Pendências herdadas: ', h('strong', null, `${ip.done}/${ip.total}`), ' concluídas') : null,
    h('span', { class: g.requiredPending ? 'ck-wait' : 'ck-done' }, 'Obrigatórios pendentes no projeto: ', h('strong', null, g.requiredPending)));
}

// Pendências herdadas: o MESMO item da etapa de origem (mesmas evidências, scripts e histórico), mostrado à parte com a origem.
function ckInheritedGroup(p, inst) {
  const list = inst.inherited || [];
  if (!list.length) return null;
  const ip = inst.inheritedProgress;
  return h('div', { class: 'ck-group ck-inherited' },
    h('div', { class: 'ck-group-head' }, h('strong', null, '⚠ Pendências herdadas'),
      h('span', { class: `small ${ip.done < ip.total ? 'ck-wait' : 'muted'}` }, `${ip.done}/${ip.total} concluídas · vindas de etapas anteriores`)),
    h('div', { class: 'ck-list' }, list.map((it) => ckItem(p, { stepId: it.origin.stepId, stageName: it.origin.stageName, items: [it], viewStepId: inst.stepId }, it))));
}

function checklistCard(p) {
  const title = 'Checklist da etapa';
  const steps = projectSteps(p);
  if (!steps.length) return card(title, null, h('div', { class: 'empty' }, 'O ciclo deste projeto não tem etapas. Monte as etapas em Configurações → Ciclos.'));
  const stepId = ckStep(p);
  const step = steps.find((c) => c.id === stepId);
  if (!step) return card(title, null, h('div', { class: 'empty' }, 'Defina a etapa do projeto no ciclo acima para ver o checklist dela.'));
  const stage = stageById(step.stageId);
  const started = steps.filter((c) => c.id === p.stepId || p.checklist?.[c.id]?.started);
  const picker = started.length > 1 ? h('select', { class: 'ck-step-pick', 'aria-label': 'Etapa do checklist', onchange: (e) => { CK.view.set(p.id, e.target.value); ckRefreshView(p); } },
    started.map((c) => { const pr = p.checklist?.[c.id]; return h('option', { value: c.id, selected: c.id === stepId },
      `${stageById(c.stageId)?.name || '?'}${c.id === p.stepId ? ' (atual)' : ''}${pr?.total ? ` — ${pr.done}/${pr.total}` : ''}`); })) : null;
  const heading = ['Checklist da etapa ', stage ? stageTag(stage) : null];

  const key = ckKey(p, stepId);
  const inst = CK.inst.get(key);
  if (!inst) {
    if (CK.err.has(key)) return card(heading, picker, h('div', { class: 'box bad' }, CK.err.get(key), ' ', h('button', { class: 'btn sm', onclick: () => { CK.err.delete(key); ckRefreshView(p); } }, 'Tentar de novo')));
    ckLoad(p, stepId);
    return card(heading, picker, h('div', { class: 'empty' }, 'Carregando o checklist…'));
  }

  const head = h('div', { class: 'inline' }, picker, inst.sync.changed ? h('button', { class: 'btn sm', onclick: () => ckSyncDialog(p, inst) }, 'Sincronizar com o modelo') : null);
  if (!inst.items.length && !inst.archived.length && !inst.inherited?.length) {
    return card(heading, head, h('div', { class: 'ck-empty' },
      h('strong', null, inst.sync.changed ? 'O modelo deste estágio neste ciclo já tem itens.' : 'Nenhum checklist configurado para este estágio neste ciclo.'),
      h('span', { class: 'muted small' }, inst.sync.changed ? 'Use “Sincronizar com o modelo” para trazê-los para este projeto.' : 'Checklists definem o que precisa estar pronto antes de avançar para a próxima etapa. Escolha quais checklists este estágio usa na configuração do ciclo.'),
      p.cycleId && !inst.sync.changed ? h('div', null, h('button', { class: 'btn sm primary', onclick: () => { CYCLE_OPEN.add(p.cycleId); location.hash = '#/settings/ciclos'; } }, 'Configurar checklists do ciclo')) : null));
  }
  // Itens agrupados pelos checklists do estágio neste ciclo (ex.: Técnico, Funcional, Cliente), cada um com o seu progresso.
  const byId = new Map(inst.items.map((it) => [it.id, it]));
  const groups = (inst.groups && inst.groups.length ? inst.groups : [{ id: 'all', name: '', itemIds: inst.items.map((i) => i.id) }]);
  const many = groups.length > 1;
  return card(heading, head,
    ckProgress(inst.progress), ckMetrics(inst),
    inst.sync.changed ? h('div', { class: 'box warn' }, h('strong', null, 'O modelo deste estágio neste ciclo mudou.'),
      ` (${[inst.sync.added ? `${plural(inst.sync.added, 'item novo', 'itens novos')}` : null, inst.sync.updated ? `${plural(inst.sync.updated, 'alterado', 'alterados')}` : null, inst.sync.archived ? `${plural(inst.sync.archived, 'removido', 'removidos')}` : null].filter(Boolean).join(', ')}). `,
      'Este projeto continua com a cópia dele até você sincronizar.') : null,
    groups.map((g) => h('div', { class: 'ck-group' },
      many || g.name !== 'Checklist' ? h('div', { class: 'ck-group-head' }, h('strong', null, g.name || 'Checklist'),
        g.progress ? h('span', { class: `small ${g.progress.requiredDone < g.progress.requiredTotal ? 'ck-wait' : 'muted'}` }, `${g.progress.done}/${g.progress.total} · obrigatórios ${g.progress.requiredDone}/${g.progress.requiredTotal}`) : null) : null,
      h('div', { class: 'ck-list' }, g.itemIds.map((id) => byId.get(id)).filter(Boolean).map((it) => ckItem(p, inst, it))))),
    ckInheritedGroup(p, inst),
    ckFooter(p, inst),
    inst.archived.length ? h('details', { class: 'hist' }, h('summary', null, `Itens removidos do modelo (${inst.archived.length})`),
      h('div', { class: 'stack small muted', style: 'margin-top:6px' }, 'Guardados com suas marcações e evidências, mas fora da conta e do bloqueio.', inst.archived.map((it) => h('div', null, `• ${it.title}${it.done ? ' (concluído)' : ''}${it.evidences.length ? ` · 📎 ${it.evidences.length}` : ''}`)))) : null);
}

// Rodapé: o que falta para avançar (nunca escondido) ou o botão para avançar.
const ckPendLine = (i) => h('li', null, i.title,
  i.inherited && i.origin ? h('span', { class: 'muted' }, ` — origem: ${i.origin.stageName}`) : null,
  i.status === 'awaiting_evidence' ? h('span', { class: 'muted' }, ` — aguardando evidência (falta${i.missingEvidence === 1 ? '' : 'm'} ${i.missingEvidence})`) : i.missingEvidence ? h('span', { class: 'muted' }, ' — exige evidência') : null);

// Rodapé: o que falta para avançar (nunca escondido). Obrigatório transferível pendente não trava o avanço (pede confirmação);
// a conclusão do projeto (próximo passo = último) nunca transfere: exige todos os obrigatórios do projeto concluídos.
function ckFooter(p, inst) {
  if (!inst.isCurrent) return h('div', { class: 'small muted' }, 'Esta não é a etapa atual do projeto; o avanço é controlado pelo checklist da etapa atual.');
  const pend = inst.pending;
  const final = !!inst.next?.final;
  const blocking = final ? pend : pend.filter((i) => !i.carryForward);
  const carry = final ? [] : pend.filter((i) => i.carryForward);
  const elsewhere = final ? Math.max(0, (inst.global?.requiredPending || 0) - pend.length) : 0; // pendências esquecidas em etapas anteriores
  const elsewhereNote = elsewhere ? h('div', { class: 'small' }, `Há também ${plural(elsewhere, 'pendência obrigatória', 'pendências obrigatórias')} em etapas anteriores — todas precisam estar concluídas para concluir o projeto.`) : null;
  if (blocking.length) {
    return h('div', { class: 'box warn ck-foot' },
      h('strong', null, final ? `Para concluir o projeto (${inst.next.stageName}), ${blocking.length === 1 ? 'falta' : 'faltam'} ${plural(blocking.length, 'pendência obrigatória', 'pendências obrigatórias')}:`
        : inst.next ? `Para avançar para ${inst.next.stageName}, ${blocking.length === 1 ? 'falta' : 'faltam'} ${plural(blocking.length, 'item obrigatório', 'itens obrigatórios')}:` : `${blocking.length === 1 ? 'Falta' : 'Faltam'} ${plural(blocking.length, 'item obrigatório', 'itens obrigatórios')} nesta etapa:`),
      h('ul', null, blocking.map(ckPendLine)),
      final ? h('div', { class: 'small muted' }, 'Na conclusão nada pode ser transferido: todas as pendências obrigatórias (inclusive as herdadas) precisam estar concluídas.') : null,
      carry.length ? h('div', { class: 'small muted' }, `Além disso, ${plural(carry.length, 'item pode ser transferido', 'itens podem ser transferidos')} para ${inst.next ? inst.next.stageName : 'a próxima etapa'} quando os itens acima forem concluídos.`) : null,
      elsewhereNote);
  }
  if (carry.length && inst.next) {
    return h('div', { class: 'box warn ck-foot ck-carry' },
      h('strong', null, `Os obrigatórios que travam o avanço foram concluídos. ${carry.length === 1 ? 'Pendência transferível' : 'Pendências transferíveis'} (${carry.length}):`),
      h('ul', null, carry.map(ckPendLine)),
      h('div', { class: 'small muted' }, 'Ao avançar, elas seguem para a próxima etapa como “pendências herdadas” e continuam pendentes até serem concluídas.'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => setStep(p, inst.next.stepId) }, `Avançar para ${inst.next.stageName} e transferir…`)));
  }
  if (elsewhere) return h('div', { class: 'box warn ck-foot' }, h('strong', null, 'Os itens desta etapa estão concluídos, mas o projeto ainda não pode ser concluído.'), elsewhereNote);
  return h('div', { class: 'box ck-foot ck-ok' }, h('strong', null, 'Todos os itens obrigatórios foram concluídos.'),
    inst.next ? h('button', { class: 'btn primary', onclick: () => setStep(p, inst.next.stepId) }, final ? `Concluir projeto (${inst.next.stageName}) →` : `Avançar para ${inst.next.stageName} →`) : h('span', { class: 'muted' }, ' Esta é a última etapa do ciclo.'));
}

function ckItem(p, inst, it) {
  const open = CK.open.has(it.id);
  const toggleOpen = () => { if (CK.open.has(it.id)) CK.open.delete(it.id); else CK.open.add(it.id); ckRefreshView(projectById(p.id) || p); };
  const box = h('input', { type: 'checkbox', checked: it.done, 'aria-label': `Marcar “${it.title}”`, onchange: () => ckToggle(p, inst, it, box) });
  const ev = it.evidence;
  const statusLine = it.status === 'done' ? h('span', { class: 'small ck-done' }, `✓ Concluído em ${ckWhen(it.completedAt || it.doneAt)}${it.completedBy ? ` por ${it.completedBy}` : ''}`)
    : it.status === 'awaiting_evidence' ? h('span', { class: 'small ck-wait' }, `⚠ Marcado — aguardando evidência (${it.evidences.length} de ${ev.min} exigida${ev.min === 1 ? '' : 's'})`)
      : null;
  return h('div', { class: `ck-item ${it.status}${it.blocked ? ' blocked' : ''}`, 'data-item': it.id },
    h('div', { class: 'ck-item-main' },
      box,
      h('div', { class: 'ck-item-body' },
        h('div', { class: 'inline' }, h('strong', { class: 'ck-title' }, it.title),
          h('span', { class: `ck-badge ${it.required ? 'req' : 'opt'}` }, it.required ? 'Obrigatório' : 'Opcional'),
          ev.mode !== 'none' ? h('span', { class: 'ck-badge ev', title: `Tipos aceitos: ${ev.extensions.join(' ')}` }, `Evidência ${ev.mode === 'required' ? 'obrigatória' : 'opcional'}: ${ev.typeLabel}`) : null,
          it.origin ? h('span', { class: 'ck-badge inh', title: 'Pendência transferida de uma etapa anterior (é o mesmo item da origem)' }, `Origem: ${it.origin.stageName}`)
            : it.carriedTo ? h('span', { class: 'ck-badge moved', title: 'Este item seguiu para outra etapa como pendência; é o mesmo item' }, `↪ Transferido para ${it.carriedToStage || 'outra etapa'}`)
              : it.required && it.carryForward && it.status !== 'done' ? h('span', { class: 'ck-badge carry', title: 'Se estiver pendente, pode seguir para a próxima etapa (nunca na conclusão do projeto)' }, 'Transferível') : null),
        h('div', { class: 'ck-meta' }, statusLine, ckDepLine(p, it),
          it.carriedTo && it.carryHistory?.length ? h('span', { class: 'small muted' }, `Transferido em ${ckWhen(it.carriedAt)} · ${plural(it.carryHistory.length, 'etapa percorrida', 'etapas percorridas')}`) : null,
          it.carriedTo && !it.archived ? h('button', { class: 'btn xs', title: 'Devolve este mesmo item à etapa de origem (nada é apagado nem copiado)', onclick: () => ckRestore(p, inst, it) }, 'Restaurar para estágio original') : null,
          it.origin && it.modelCarryForward === false ? h('span', { class: 'small muted' }, 'O modelo deixou de permitir transferir este item (este projeto mantém a regra antiga até sincronizar).') : null,
          it.note ? h('span', { class: 'small ck-notepreview', title: it.note.text }, `📝 ${it.note.text.length > 90 ? `${it.note.text.slice(0, 90)}…` : it.note.text}`) : null,
          it.scripts.map((s) => h('span', { class: 'small inline', style: 'gap:4px' }, `Script: ${s.name} `, !s.missing && s.exists
            ? [h('button', { class: 'btn xs primary', title: 'Executar numa conexão (resultado aqui mesmo, sem marcar o item)', onclick: () => runScriptDialog(p, inst, it, s) }, '▶ Executar'),
              h('button', { class: 'btn xs', title: 'Abrir no programa padrão (ex.: SSMS)', onclick: () => ckOpenScript(s, 'default') }, 'Abrir')]
            : h('span', { class: 'muted' }, s.missing ? '(removido)' : '(arquivo não encontrado)'))),
          it.runs && it.runs[0] ? h('span', { class: `small ${it.runs[0].ok ? 'muted' : 'ck-bad'}`, title: 'Última execução de script neste item' }, `${it.runs[0].ok ? '✓' : '✕'} executado ${ckWhen(it.runs[0].at)}`) : null,
          ckEmailLine(p, inst, it),
          it.evidences.length ? h('span', { class: 'small' }, `📎 ${plural(it.evidences.length, 'evidência', 'evidências')}`) : null)),
      h('button', { class: 'btn sm ghost', 'aria-expanded': open ? 'true' : 'false', onclick: toggleOpen }, open ? 'Detalhes ▴' : 'Detalhes ▾')),
    open ? ckDetails(p, inst, it) : null);
}

// Ação "Gerar e-mail" do item: modelo associado, "Gerar e-mail" (abre a prévia para copiar; a aplicação não envia nada) e a última geração.
// Gerar/copiar não conclui o item: a conclusão segue a regra de sempre (marcar + evidência exigida).
function ckEmailLine(p, inst, it) {
  const e = it.email;
  if (!e) return null;
  const last = e.lastGeneration;
  return h('span', { class: 'small inline ck-email', style: 'gap:4px' }, '📧 ', h('span', null, e.templateName || '(modelo removido)'),
    !e.missing && !e.active ? h('span', { class: 'pill overdue' }, 'modelo desativado') : null,
    e.active && !it.archived ? h('button', { class: 'btn xs primary', title: 'Monta o e-mail com os dados do projeto para você copiar e colar no Gmail/Outlook',
      onclick: async () => { await emGenerate(p, { stepId: inst.stepId, itemId: it.id }); ckLoad(p, inst.viewStepId || inst.stepId); } }, 'Gerar e-mail') : null,
    last ? h('span', { class: 'muted', title: `${e.generations} geração(ões) a partir deste item` }, `gerado em ${ckWhen(last.at)}${last.copiedAt ? ' · copiado' : ''}`) : null,
    last ? h('button', { class: 'btn xs ghost', onclick: () => emGenerationDialog(last.id) }, 'Ver') : null);
}

function ckDetails(p, inst, it) {
  const ev = it.evidence;
  return h('div', { class: 'ck-details' },
    it.description ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Descrição'), h('span', { style: 'white-space:pre-line' }, it.description)) : null,
    it.dependencies?.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Dependências'),
      it.dependencies.map((d) => h('div', { class: 'small' },
        d.status === 'done' ? h('span', { class: 'ck-done' }, '✓ ') : d.status === 'pending' ? h('span', { class: 'ck-wait' }, '○ ') : h('span', { class: 'muted' }, '— '),
        ckDepLink(p, d), h('span', { class: 'muted' }, d.status === 'done' ? ' — concluída' : d.status === 'pending' ? ' — pendente' : ' — não se aplica a este projeto')))) : null,
    h('div', { class: 'stack ck-note' }, h('div', { class: 'inline' }, h('span', { class: 'lbl' }, 'Observação'),
      it.archived ? null : h('button', { class: 'btn xs', onclick: () => ckNoteDialog(p, inst, it) }, it.note ? 'Editar' : 'Adicionar observação')),
      it.note ? [h('span', { style: 'white-space:pre-line' }, it.note.text), h('span', { class: 'small muted' }, `Atualizado em ${ckWhen(it.note.updatedAt)}${it.note.updatedBy ? ` por ${it.note.updatedBy}` : ''}`)]
        : h('span', { class: 'small muted' }, 'Nenhuma observação. Use para registrar o que aconteceu com este item neste projeto (a descrição acima é do modelo).')),
    it.scripts.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Scripts'),
      it.scripts.map((s) => h('div', { class: 'inline' }, h('span', { class: 'mono' }, s.name),
        s.missing || !s.exists ? h('span', { class: 'pill overdue' }, s.missing ? 'removido da lista de scripts' : 'arquivo não encontrado') : [
          h('button', { class: 'btn xs primary', title: 'Executar numa conexão', onclick: () => runScriptDialog(p, inst, it, s) }, '▶ Executar'),
          h('button', { class: 'btn xs', title: 'Programa padrão para .sql (ex.: SSMS)', onclick: () => ckOpenScript(s, 'default') }, 'Abrir'),
          h('button', { class: 'btn xs', title: 'Abrir no VS Code', onclick: () => ckOpenScript(s, 'vscode') }, 'VS Code'),
          h('button', { class: 'btn xs', title: 'Mostrar a pasta no Explorer', onclick: () => ckOpenScript(s, 'explorer') }, 'Explorer')]))) : null,
    it.runs && it.runs.length ? h('details', { class: 'hist' }, h('summary', null, `Execuções de scripts (${it.runs.length})`),
      h('div', { class: 'stack small', style: 'margin-top:6px' }, it.runs.map((r) => h('div', null, h('span', { class: r.ok ? 'ck-done' : 'ck-bad' }, r.ok ? '✓ ' : '✕ '),
        `${ckWhen(r.at)} · ${r.scriptName} · ${r.target} (${r.database}) · ${fmtMs(r.ms)}`, r.ok ? ` · ${r.returned} linha(s)${r.affected ? `, ${r.affected} afetada(s)` : ''}` : '', r.by ? ` · ${r.by}` : '',
        r.error ? h('div', { class: 'muted', style: 'margin-left:16px' }, r.error) : null)))) : null,
    it.links.length ? h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Links úteis'),
      it.links.map((l) => h('div', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.title), l.description ? h('span', { class: 'small muted' }, ` — ${l.description}`) : null))) : null,
    ev.mode !== 'none' ? h('div', { class: 'stack' },
      h('div', { class: 'inline' }, h('span', { class: 'lbl' }, 'Evidências'),
        h('span', { class: 'small muted' }, `${ev.mode === 'required' ? `exigidas: ${ev.min}` : 'opcionais'} · máx. ${ev.max} · ${ev.typeLabel.toLowerCase()} (${ev.extensions.join(' ')})`),
        h('button', { class: 'btn xs primary', disabled: it.evidences.length >= ev.max || it.archived, onclick: () => ckAddEvidence(p, inst, it) }, '+ Adicionar evidência')),
      it.evidences.length ? it.evidences.map((v) => ckEvidenceRow(p, inst, it, v)) : h('span', { class: 'small muted' }, 'Nenhuma evidência.')) : null,
    it.carryHistory?.length ? h('details', { class: 'hist' }, h('summary', null, `Ver histórico de transferências (${it.carryHistory.length})`),
      h('div', { class: 'stack small', style: 'margin-top:6px' }, it.origin ? h('span', { class: 'muted' }, `Origem: ${it.origin.stageName}`) : null,
        it.carryHistory.map((x) => h('div', null, x.restored ? `↩ Restaurado para ${x.toStage}` : `${x.fromStage} → ${x.toStage}`, h('span', { class: 'muted' }, ` · ${ckWhen(x.at)}${x.by ? ` · ${x.by}` : ''}`))))) : null,
    it.doneAt ? h('div', { class: 'small muted' }, `Marcado em ${ckWhen(it.doneAt)}${it.doneBy ? ` por ${it.doneBy}` : ''}`) : null);
}

// ---------- Executar script (janela compacta: conexão, variáveis, resultado) ----------
const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2).replace('.', ',')} s`);
const RUN_PREF = 'gp-run-target';
function runPref(projectId, v) {
  try {
    const all = JSON.parse(localStorage.getItem(RUN_PREF) || '{}');
    if (v === undefined) return all[projectId] || null;
    all[projectId] = v; localStorage.setItem(RUN_PREF, JSON.stringify(all));
  } catch { /* sem armazenamento */ }
  return null;
}

// Grade de resultado: rolagem interna nas duas direções, cabeçalho fixo, nº da linha e célula longa cortada (valor completo na dica).
function resultGrid(rs) {
  return h('div', { class: 'run-grid' }, h('table', null,
    h('thead', null, h('tr', null, h('th', { class: 'rn' }, '#'), rs.columns.map((c) => h('th', { title: c }, c)))),
    h('tbody', null, rs.rows.map((row, i) => h('tr', null, h('td', { class: 'rn' }, i + 1), row.map((v) => (v === null ? h('td', { class: 'null' }, 'NULL') : h('td', { title: v.length > 40 ? v : null }, v))))))));
}

async function runScriptDialog(p, inst, it, script) {
  let info;
  try { [info] = await Promise.all([api('GET', `/api/projects/${p.id}/run-targets`)]); } catch (e) { return fail(e); }
  if (!info.targets.length) {
    return confirmDialog({ title: 'Nenhuma conexão disponível', message: 'Cadastre uma conexão em Configurações → Conexões (ou associe uma base ao projeto) para executar scripts.', okText: 'Abrir Conexões' })
      .then((ok) => { if (ok) location.hash = '#/settings/conexoes'; });
  }
  const vars = await api('GET', `/api/scripts/${script.id}/variables`).catch(() => ({ user: [] }));
  const saved = runPref(p.id);
  const sel = h('select', { 'aria-label': 'Conexão' });
  const groups = [...new Set(info.targets.map((t) => t.group))];
  for (const g of groups) sel.append(h('optgroup', { label: g }, info.targets.filter((t) => t.group === g).map((t) => h('option', { value: t.key }, t.key.startsWith('conn:') ? `${t.label} — ${t.envLabel}` : t.label))));
  sel.value = info.targets.some((t) => t.key === saved) ? saved : info.defaultKey;
  const dbInput = h('input', { type: 'text', placeholder: 'Banco', style: 'width:200px' });
  const targetInfo = h('span', { class: 'small muted' });
  const syncTarget = () => {
    const t = info.targets.find((x) => x.key === sel.value);
    const isConn = t?.key.startsWith('conn:');
    dbInput.style.display = isConn ? '' : 'none';
    if (isConn && !dbInput.dataset.touched) dbInput.value = t.database || '';
    targetInfo.replaceChildren(t ? h('span', null, pill(t.env === 'local' ? 'local' : t.env === 'prod' ? 'prod' : 'soon', t.envLabel.toUpperCase()), ` ${t.server}${!isConn ? ` / ${t.database}` : ''}`) : '');
  };
  dbInput.addEventListener('input', () => { dbInput.dataset.touched = '1'; });
  sel.addEventListener('change', () => { dbInput.dataset.touched = ''; syncTarget(); });
  syncTarget();
  const varInputs = Object.fromEntries(vars.user.map((n) => [n, h('input', { type: 'text', maxlength: 128, placeholder: n, style: 'width:180px' })]));
  const varsBox = vars.user.length ? h('div', { class: 'inline' }, h('span', { class: 'small muted' }, 'Variáveis:'), vars.user.map((n) => h('label', { class: 'inline small', style: 'gap:4px' }, h('span', { class: 'mono' }, `{{${n}}}`), varInputs[n]))) : null;
  const runBtn = h('button', { class: 'btn primary' }, '▶ Executar');
  const stopBtn = h('button', { class: 'btn', style: 'display:none', title: 'Cancela a execução (o que o script já fez é desfeito)' }, 'Parar');
  const status = h('div', { class: 'run-status small muted' }, 'O resultado aparece aqui. Executar não marca o item como concluído.');
  const out = h('div', { class: 'run-out' });
  let ctrl = null; let timer = null;

  const show = (r) => {
    const tabs = [...r.results.map((rs, i) => ({ id: `r${i}`, label: `Resultado ${r.results.length > 1 ? i + 1 : ''} (${rs.total})`.replace('  ', ' '), el: () => h('div', { class: 'stack' }, resultGrid(rs),
      h('div', { class: 'small muted' }, `${plural(rs.total, 'registro', 'registros')}${rs.total > rs.rows.length ? ` · mostrando os primeiros ${rs.rows.length}` : ''}${rs.hiddenColumns ? ` · ${rs.hiddenColumns} coluna(s) não exibida(s)` : ''}`)) })),
      { id: 'msg', label: `Mensagens${r.messages.length ? ` (${r.messages.length})` : ''}`, el: () => (r.messages.length ? h('pre', { class: 'run-msgs' }, r.messages.join('\n')) : h('div', { class: 'small muted' }, 'Nenhuma mensagem (PRINT) do servidor.')) }];
    let active = r.ok ? (r.results.length ? 'r0' : 'msg') : 'msg';
    const bar = h('div', { class: 'tabs sm' });
    const pane = h('div');
    const draw = () => {
      bar.replaceChildren(...tabs.map((t) => h('button', { class: `tab${t.id === active ? ' active' : ''}`, onclick: () => { active = t.id; draw(); } }, t.label)));
      pane.replaceChildren(tabs.find((t) => t.id === active).el());
    };
    draw();
    const summary = r.ok
      ? h('div', { class: 'box ok-box small' }, h('strong', null, r.results.length ? `✓ ${plural(r.returned, 'registro retornado', 'registros retornados')}` : '✓ Comando executado com sucesso.'),
        r.affected ? ` ${plural(r.affected, 'registro afetado', 'registros afetados')}.` : '', ` · Tempo: ${fmtMs(r.ms)} · ${plural(r.batches, 'lote', 'lotes')} · ${r.target}${r.identity ? ` (${r.identity.server} / ${r.identity.database})` : ''}`,
        r.truncated ? h('div', { class: 'muted' }, 'Parte do resultado foi omitida (limite da janela).') : null)
      : h('div', { class: 'box bad small' }, h('strong', null, '✕ Erro ao executar — nada foi gravado (a transação foi desfeita).'), h('div', { class: 'mono', style: 'margin-top:4px;white-space:pre-wrap' }, r.error),
        r.errorInfo?.number ? h('div', { class: 'muted' }, `Erro ${r.errorInfo.number}${r.errorInfo.severity ? `, nível ${r.errorInfo.severity}` : ''}${r.errorInfo.state !== null ? `, estado ${r.errorInfo.state}` : ''} · ${fmtMs(r.ms)}`) : null);
    out.replaceChildren(...[summary, r.results.length || r.messages.length ? h('div', { class: 'stack' }, bar, pane) : null].filter(Boolean));
  };

  const exec = async (confirmToken) => {
    const t = info.targets.find((x) => x.key === sel.value);
    runPref(p.id, sel.value);
    const body = { scriptId: script.id, target: sel.value, database: t?.key.startsWith('conn:') ? dbInput.value : undefined, vars: Object.fromEntries(Object.entries(varInputs).map(([n, el]) => [n, el.value])), confirmToken };
    ctrl = new AbortController();
    const t0 = Date.now();
    runBtn.disabled = true; stopBtn.style.display = ''; sel.disabled = true;
    status.textContent = 'Executando script… 0 s';
    timer = setInterval(() => { status.textContent = `Executando script… ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
    try {
      const r = await fetch(`/api/projects/${p.id}/checklists/${inst.stepId}/items/${it.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (json.code === 'SCRIPT_CONFIRM') {
          const c = json.confirm;
          const ok = await confirmDialog({ title: 'Confirmar execução', message: `${script.name}\nConexão: ${c.target} (${c.env}) — ${c.server} / ${c.database}\n\n${c.reasons.map((x) => `• ${x}`).join('\n')}\n\nO script roda numa transação: se der erro, nada é gravado.`, okText: 'Executar mesmo assim', danger: true });
          status.textContent = ok ? '' : 'Execução cancelada.';
          if (ok) { clearInterval(timer); return exec(c.token); }
          return;
        }
        if (json.code === 'SCRIPT_VARS') { (json.missing || []).forEach((n) => varInputs[n]?.classList.add('invalid')); (varInputs[json.missing?.[0]])?.focus(); }
        status.textContent = '';
        const fix = json.code === 'PASSWORD_UNREADABLE' && json.connectionId ? connectionPasswordFix(json.connectionId) : null; // senha salva ilegível
        out.replaceChildren(h('div', { class: 'box bad small', style: 'white-space:pre-line' }, json.error || `Erro ${r.status}`,
          fix ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm primary', onclick: () => { m.close(); fix(); } }, 'Informar a senha da conexão')) : null));
        return;
      }
      status.textContent = '';
      show(json);
      replaceProjectQuiet(json.project);
      ckLoad(projectById(p.id) || p, inst.stepId); // atualiza o histórico de execuções do item (o item NÃO é marcado)
    } catch (e) {
      status.textContent = e.name === 'AbortError' ? 'Execução cancelada — o que o script já tinha feito foi desfeito.' : '';
      if (e.name !== 'AbortError') out.replaceChildren(h('div', { class: 'box bad small' }, e.message));
    } finally {
      clearInterval(timer); ctrl = null; runBtn.disabled = false; stopBtn.style.display = 'none'; sel.disabled = false;
    }
  };
  runBtn.addEventListener('click', () => exec());
  stopBtn.addEventListener('click', () => ctrl && ctrl.abort());
  const m = openModal({ title: ['Executar script — ', h('span', { class: 'mono' }, script.name)], size: 'lg',
    body: [h('div', { class: 'run-bar' }, h('label', { class: 'inline', style: 'gap:6px' }, h('span', { class: 'lbl' }, 'Conexão'), sel), dbInput, runBtn, stopBtn), targetInfo, varsBox, status, out].filter(Boolean),
    footer: [h('span', { class: 'small muted', style: 'margin-right:auto' }, `Item: ${it.title}`), h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar')],
    onClose: () => { if (ctrl) ctrl.abort(); } });
  runBtn.focus();
}

async function ckOpenScript(s, how) { try { await api('POST', `/api/scripts/${s.id}/open`, { app: how }); } catch (e) { fail(e); } }

async function ckToggle(p, inst, it, box) {
  const done = box.checked;
  box.disabled = true;
  try {
    const cur = ckApply(p, await api('PUT', itemUrl(p, inst, it), { done }));
    const now = cur.items.find((i) => i.id === it.id);
    if (done && now?.status === 'awaiting_evidence') ckEvidencePrompt(projectById(p.id) || p, cur, now);
  } catch (e) {
    box.checked = !done; box.disabled = false;
    if (e.code === 'DEPENDENCY_PENDING') ckDependencyDialog(p, it, e); else fail(e);
  }
}

// ---------- Dependências, observação e reversão (itens do checklist) ----------
function ckInfo(title, message) {
  const m = openModal({ title, size: 'sm', body: [h('p', { style: 'margin:0;white-space:pre-line' }, message)], footer: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar')] });
}

// Leva até o item de que se depende, em qualquer etapa: abre a etapa onde ele está agora (inclusive como pendência herdada).
function ckGoTo(p, d) {
  if (!d.itemId || !d.viewStepId) { toast(d.status === 'na' ? 'Este item não se aplica a este projeto.' : 'A etapa deste item ainda não foi iniciada neste projeto.'); return; }
  CK.view.set(p.id, d.viewStepId); CK.open.add(d.itemId);
  ckRefreshView(projectById(p.id) || p);
  const go = (tries) => {
    const el = document.querySelector(`[data-item="${d.itemId}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('ck-flash'); setTimeout(() => el.classList.remove('ck-flash'), 1800); } else if (tries > 0) setTimeout(() => go(tries - 1), 400);
  };
  setTimeout(() => go(4), 150);
}
const ckDepLink = (p, d) => (d.itemId && d.viewStepId
  ? h('a', { href: '#', class: 'ck-deplink', title: 'Ir para o item', onclick: (e) => { e.preventDefault(); ckGoTo(p, d); } }, `${d.stageName ? `${d.stageName} / ` : ''}${d.title}`)
  : h('span', { title: d.status === 'pending' ? 'A etapa deste item ainda não foi iniciada' : '' }, `${d.stageName ? `${d.stageName} / ` : ''}${d.title}`));
const ckJoin = (list, fn) => list.flatMap((x, i) => (i ? [', ', fn(x)] : [fn(x)]));

// Linha discreta no item: bloqueado (com as pendentes), ou dependências atendidas.
function ckDepLine(p, it) {
  const deps = it.dependencies || [];
  if (!deps.length) return null;
  if (it.blocked) return h('span', { class: 'small ck-dep blocked' }, '🔒 Bloqueado por dependência — pendente: ', ckJoin(deps.filter((d) => d.status === 'pending'), (d) => ckDepLink(p, d)));
  if (it.status === 'done') return h('span', { class: 'small muted' }, '🔗 Depende de: ', ckJoin(deps, (d) => ckDepLink(p, d)));
  return h('span', { class: 'small ck-done' }, '✓ Dependências atendidas');
}

function ckDependencyDialog(p, it, err) {
  const list = err.details?.blocked || [];
  const m = openModal({ title: 'Não é possível concluir este item', size: 'sm',
    body: [h('p', { style: 'margin:0' }, `“${it.title}” só pode ser concluído depois que ${list.length === 1 ? 'a dependência abaixo estiver concluída' : 'as dependências abaixo estiverem concluídas'} (inclusive a evidência exigida, se houver).`),
      h('div', { class: 'box warn' }, h('strong', null, list.length === 1 ? 'Dependência pendente:' : 'Dependências pendentes:'), h('ul', { style: 'margin:4px 0 0' }, list.map((d) => h('li', null, d.stageName ? `${d.stageName} / ${d.title}` : d.title))))],
    footer: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar')] });
}

function ckNoteDialog(p, inst, it) {
  const ta = h('textarea', { rows: 5, maxlength: 1000, placeholder: 'Ex.: Cliente informou que enviará o arquivo apenas amanhã.' });
  ta.value = it.note?.text || '';
  const save = async (text, msg) => {
    try { ckApply(p, await api('PUT', `${itemUrl(p, inst, it)}/note`, { text })); m.close(); toast(msg); } catch (e) { fail(e); }
  };
  const m = openModal({ title: `Observação — ${it.title}`, size: 'md',
    body: [h('div', { class: 'small muted' }, 'Registro desta execução no projeto (o que aconteceu com este item). A descrição do item vem do modelo e não é alterada aqui. A observação acompanha o item se ele for transferido ou restaurado.'),
      field('Observação', ta, it.note ? `Atualizada em ${ckWhen(it.note.updatedAt)}${it.note.updatedBy ? ` por ${it.note.updatedBy}` : ''}.` : null),
      h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn xs', title: 'Insere {{greeting}} na posição do cursor', onclick: () => {
        const a = ta.selectionStart ?? ta.value.length; const b = ta.selectionEnd ?? a;
        ta.setRangeText('{{greeting}}', a, b, 'end'); ta.focus();
      } }, '+ {{greeting}}'), h('span', { class: 'small muted' }, 'Ao salvar, vira “Bom dia”, “Boa tarde” ou “Boa noite” conforme o horário.'))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      it.note ? h('button', { class: 'btn ghost', onclick: () => save('', 'Observação removida.') }, 'Remover observação') : null,
      h('button', { class: 'btn primary', onclick: () => save(ta.value, 'Observação salva.') }, 'Salvar')] });
  ta.focus();
}

// Devolve o MESMO item à etapa de origem. O servidor sempre pede confirmação (e avisa o que muda) e valida se a origem ainda existe.
async function ckRestore(p, inst, it) {
  const url = `${itemUrl(p, inst, it)}/restore`;
  try { await api('POST', url, {}); return; } catch (e) {
    if (e.code === 'RESTORE_IMPOSSIBLE') return ckInfo('Não foi possível restaurar', e.message);
    if (e.code !== 'RESTORE_CONFIRM') return fail(e);
    const w = e.details?.warnings || [];
    const ok = await confirmDialog({ title: 'Restaurar para o estágio original',
      message: [e.message, 'Não é criada nenhuma cópia: é o mesmo item, e a volta fica registrada no histórico de transferências.',
        w.length ? ['Atenção:', ...w.map((x) => `• ${x}`)].join('\n') : null].filter(Boolean).join('\n\n'), okText: 'Restaurar' });
    if (!ok) return;
  }
  try { ckReset(); ckApply(p, await api('POST', url, { confirm: true })); toast('Item restaurado para a etapa original.'); } catch (e2) { fail(e2); }
}

// Marcou um item que exige evidência: ainda não está concluído até anexá-la.
function ckEvidencePrompt(p, inst, it) {
  const m = openModal({
    title: 'Este item exige evidência',
    body: [h('p', { style: 'margin:0' }, `“${it.title}” só será considerado concluído depois que você anexar a evidência (${it.evidence.typeLabel.toLowerCase()}).`),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Se preferir anexar depois, o item fica marcado como “aguardando evidência” e continua bloqueando o avanço.')],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Anexar depois'),
      h('button', { class: 'btn primary', onclick: () => { m.close(); ckAddEvidence(p, inst, it); } }, 'Adicionar evidência')],
  });
}

// ---------- Evidências ----------
// A linha, o preview e a janela de envio são compartilhados com as observações do dia (evidence-ui.js);
// aqui só fica o que é do checklist: onde a evidência mora, o limite do item e a atualização do checklist.
function ckEvidenceRow(p, inst, it, v) {
  const wasNeeded = it.done && it.evidence.mode === 'required' && it.evidences.length <= it.evidence.min;
  return evRow(`/api/projects/${p.id}/evidences`, v, {
    removeExtra: wasNeeded ? '\n\nO item volta a “aguardando evidência”.' : '',
    onRemoved: (json) => ckApply(p, json),
  });
}

async function ckUploadOne(p, inst, it, file, description) {
  return ckApply(p, await evUploadTo(`${itemUrl(p, inst, it)}/evidence`, file, description));
}

// Janela de envio: escolher, arrastar ou colar (Ctrl+V) uma imagem. Cada arquivo é conferido de novo pelo servidor.
function ckAddEvidence(p, inst, it) {
  const ev = it.evidence;
  const maxMB = state.evidence?.maxMB || 10;
  let cur = inst;
  evUploadDialog({
    title: `Evidência — ${it.title}`,
    hint: `Aceita ${ev.typeLabel.toLowerCase()} (${ev.extensions.join(' ')}) · até ${maxMB} MB por arquivo · ${it.evidences.length} de no máximo ${ev.max} anexadas${ev.mode === 'required' ? ` · exigidas: ${ev.min}` : ''}.`,
    footNote: 'O arquivo é guardado na pasta de evidências do app, dentro de uma pasta do projeto e da etapa. Nada é executado.',
    accept: ev.extensions,
    canAdd: () => {
      const now = (CK.inst.get(ckKey(p, inst.stepId)) || cur).items.find((i) => i.id === it.id);
      return now && now.evidences.length >= now.evidence.max ? `Limite de ${now.evidence.max} evidência(s) atingido` : null;
    },
    upload: async (f, description) => { cur = await ckUploadOne(projectById(p.id) || p, cur, it, f, description); },
  });
}

// ---------- Sincronizar com o modelo ----------
async function ckSyncDialog(p, inst) {
  let plan;
  try { plan = (await api('POST', `/api/projects/${p.id}/checklists/${inst.stepId}/sync`, { dryRun: true })).plan; } catch (e) { return fail(e); }
  if (!plan.changed) { toast('O checklist já está igual ao modelo.'); return ckLoad(p, inst.stepId); }
  const FIELD = { title: 'título', description: 'descrição', required: 'obrigatório/opcional', carryForward: 'permite transferir para a próxima etapa', dependsOn: 'dependências', evidence: 'regra de evidência', links: 'links', scriptIds: 'scripts', emailTemplateId: 'modelo de e-mail', checklistId: 'checklist' };
  const m = openModal({ title: 'Sincronizar com o modelo',
    body: [h('p', { style: 'margin:0' }, 'Compare o que vai mudar neste projeto. As marcações e as evidências que já existem são mantidas.'),
      plan.added.length ? h('div', { class: 'stack' }, h('strong', null, `Itens novos (${plan.added.length})`), plan.added.map((a) => h('div', { class: 'small' }, `+ ${a.title} `, h('span', { class: `ck-badge ${a.required ? 'req' : 'opt'}` }, a.required ? 'Obrigatório' : 'Opcional')))) : null,
      plan.updated.length ? h('div', { class: 'stack' }, h('strong', null, `Itens alterados (${plan.updated.length})`), plan.updated.map((u) => h('div', { class: 'small' }, `~ ${u.title} `, h('span', { class: 'muted' }, u.restore ? '(volta ao checklist)' : `(${u.changes.map((c) => FIELD[c] || c).join(', ')})`)))) : null,
      plan.archived.length ? h('div', { class: 'stack' }, h('strong', null, `Itens que saíram do modelo (${plan.archived.length})`), plan.archived.map((a) => h('div', { class: 'small' }, `− ${a.title}`)),
        h('span', { class: 'small muted' }, 'Ficam guardados (com evidências), mas deixam de contar e de bloquear.')) : null,
      h('div', { class: 'box warn small' }, 'Se um item passou a exigir evidência e ainda não tem, ele volta a “aguardando evidência”; itens obrigatórios novos passam a bloquear o avanço desta etapa.')],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const r = await api('POST', `/api/projects/${p.id}/checklists/${inst.stepId}/sync`, {});
        ckApply(p, r); m.close(); toast('Checklist sincronizado com o modelo.');
      }) }, 'Sincronizar')] });
}

// ---------- Avanço bloqueado ----------
function ckBlockedDialog(p, err) {
  const blocked = err.details?.blocked || [];
  const final = !!err.details?.final;
  const carry = err.details?.transferable || [];
  const count = blocked.reduce((n, b) => n + b.pending.length, 0);
  const m = openModal({ title: final ? 'Não é possível concluir este projeto' : 'Não é possível avançar',
    body: [h('p', { style: 'margin:0' }, err.message),
      h('div', { class: 'box warn' }, h('strong', null, final ? `Pendências obrigatórias (${count}):` : `${count === 1 ? 'O item obrigatório abaixo precisa' : 'Os itens obrigatórios abaixo precisam'} ser concluído${count === 1 ? '' : 's'} (${count}):`),
        blocked.map((b) => h('div', { class: 'stack', style: 'margin-top:8px' }, blocked.length > 1 ? h('span', { class: 'lbl' }, b.stageName) : null,
          h('ul', { style: 'margin:0' }, b.pending.map((i) => h('li', null, i.title,
            i.origin && (i.inherited || final) ? h('span', { class: 'muted' }, ` — origem: ${i.origin.stageName}`) : null,
            i.status === 'awaiting_evidence' ? h('span', { class: 'muted' }, ' — aguardando evidência') : i.missingEvidence ? h('span', { class: 'muted' }, ' — exige evidência') : null)))))),
      final ? h('div', { class: 'small muted' }, 'Na conclusão do ciclo não existe próxima etapa: pendências (inclusive as transferíveis) não podem ser transferidas de novo.') : null,
      !final && carry.length ? h('div', { class: 'small muted' }, `${plural(carry.length, 'Outro item pendente pode', 'Outros itens pendentes podem')} ser transferido${carry.length === 1 ? '' : 's'} depois que os itens acima forem concluídos.`) : null].filter(Boolean),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'),
      h('button', { class: 'btn primary', onclick: () => { m.close(); if (blocked[0]) CK.view.set(p.id, blocked[0].stepId); ckRefreshView(projectById(p.id) || p); document.querySelector('[data-slot="checklist"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 'Ver checklist')] });
}

// ---------- Avançar transferindo pendências (confirmação) ----------
function ckCarryDialog(p, stepId, err) {
  const list = err.details?.transferable || [];
  const to = err.details?.target?.stageName || 'a próxima etapa';
  const m = openModal({ title: 'Transferir pendências e avançar', size: 'md',
    body: [h('p', { style: 'margin:0' }, `${list.length === 1 ? 'Existe' : 'Existem'} ${plural(list.length, 'item obrigatório pendente que pode ser transferido', 'itens obrigatórios pendentes que podem ser transferidos')} para o próximo estágio.`),
      h('div', { class: 'box warn' }, h('strong', null, `${plural(list.length, 'item', 'itens')}:`),
        h('ul', { style: 'margin:4px 0 0' }, list.map((i) => h('li', null, i.title,
          h('span', { class: 'muted' }, ` — origem: ${i.origin.stageName}${i.inherited ? ` (hoje em ${i.at.stageName})` : ''}${i.status === 'awaiting_evidence' ? ' · aguardando evidência' : i.missingEvidence ? ' · exige evidência' : ''}`))))),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Eles NÃO serão marcados como concluídos: continuam pendentes, com as mesmas evidências e o mesmo histórico, e aparecem em “Pendências herdadas” na próxima etapa. A conclusão do projeto exige todos eles concluídos.'),
      h('p', { style: 'margin:0' }, h('strong', null, `Deseja avançar e transferir ${list.length === 1 ? 'essa pendência' : 'essas pendências'} para “${to}”?`))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => { m.close(); if (await setStep(p, stepId, { confirmCarry: true, carryKeys: list.map((i) => i.key) })) toast(`${plural(list.length, 'pendência transferida', 'pendências transferidas')} para ${to}.`); } }, 'Transferir e avançar')] });
}

// ---------- Configurações: checklists reutilizáveis ----------
function ckEvidenceLabel(mode, type) {
  if (mode === 'none') return null;
  return `Evidência ${mode === 'required' ? 'obrigatória' : 'opcional'}: ${state.evidence?.types?.[type]?.label || type}`;
}

// Nome para escolher/mostrar um checklist. Os checklists antigos eram um “Checklist” por estágio; quando o nome se repete, a origem
// (estágio em que ele nasceu) desambigua. Só exibição: nada no modelo depende dela.
function ckLabel(cl) {
  if (!cl) return '?';
  const dup = state.checklists.filter((x) => x.name.trim().toLowerCase() === cl.name.trim().toLowerCase()).length > 1;
  const origin = dup && cl.stageId ? stageById(cl.stageId)?.name : null;
  return origin ? `${cl.name} · ${origin}` : cl.name;
}
// Onde o checklist é usado: “Ciclo / Estágio” de cada passo de cada ciclo que o lista.
function ckUsage(cl) {
  return state.cycles.flatMap((c) => c.steps.filter((s) => (s.checklistIds || []).includes(cl.id)).map((s) => ({ cycle: c, step: s, label: `${c.name} / ${stageById(s.stageId)?.name || '?'}` })));
}
const ckDepLabel = (d) => `${ckLabel(state.checklists.find((c) => c.id === d.checklistId))} / ${d.title}`;

// Itens de UM checklist (o conteúdo reutilizável). Quais ciclos/estágios o usam é definido no ciclo, não aqui.
function checklistEditor(cl0) {
  const cur = () => state.checklists.find((c) => c.id === cl0.id) || cl0;
  const list = h('div', { class: 'stack', style: 'gap:14px' });
  const usageLine = h('div', { class: 'small muted' });
  const reload = async () => { await refresh(); draw(); };
  const orderItems = async (ids) => { try { await api('PUT', `/api/checklists/${cl0.id}/order`, { ids }); await reload(); } catch (e) { fail(e); } };
  const draw = () => {
    const cl = cur();
    const items = state.checklistItems.filter((i) => i.checklistId === cl.id);
    const use = ckUsage(cl);
    usageLine.textContent = use.length ? `Usado em: ${use.map((u) => u.label).join(' · ')}` : 'Ainda não é usado em nenhum ciclo. Associe-o a um estágio na configuração do ciclo.';
    const itemRow = (it, i) => h('div', { class: 'row' },
      h('span', { class: 'cycle-n' }, i + 1),
      h('div', { class: 'grow stack' },
        h('div', { class: 'inline' }, h('strong', null, it.title), h('span', { class: `ck-badge ${it.required ? 'req' : 'opt'}` }, it.required ? 'Obrigatório' : 'Opcional'),
          it.required && it.carryForward ? h('span', { class: 'ck-badge carry', title: 'Pendente, pode seguir para a próxima etapa (nunca na conclusão do projeto)' }, 'Transferível') : null,
          it.dependsOn?.length ? h('span', { class: 'ck-badge dep', title: `Só pode ser concluído depois de: ${it.dependsOn.map((id) => { const d = state.checklistItems.find((x) => x.id === id); return d ? ckDepLabel(d) : '(removido)'; }).join('; ')}` }, `🔗 ${plural(it.dependsOn.length, 'dependência', 'dependências')}`) : null,
          ckEvidenceLabel(it.evidence.mode, it.evidence.type) ? h('span', { class: 'ck-badge ev' }, ckEvidenceLabel(it.evidence.mode, it.evidence.type)) : null),
        it.description ? h('span', { class: 'small muted' }, it.description.slice(0, 140)) : null,
        h('span', { class: 'small muted' }, [it.scriptIds.length ? plural(it.scriptIds.length, 'script', 'scripts') : null, it.links.length ? plural(it.links.length, 'link', 'links') : null, it.emailTemplateId ? '📧 e-mail' : null].filter(Boolean).join(' · '))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn sm ghost', disabled: i === 0, title: 'Subir', 'aria-label': 'Subir', onclick: () => { const ids = items.map((x) => x.id); [ids[i], ids[i - 1]] = [ids[i - 1], ids[i]]; orderItems(ids); } }, '↑'),
        h('button', { class: 'btn sm ghost', disabled: i === items.length - 1, title: 'Descer', 'aria-label': 'Descer', onclick: () => { const ids = items.map((x) => x.id); [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]]; orderItems(ids); } }, '↓'),
        h('button', { class: 'btn sm ghost', onclick: () => ckItemForm(it, draw) }, 'Editar'),
        h('button', { class: 'btn sm ghost', onclick: async () => {
          if (await confirmDialog({ title: 'Remover item', message: `Remover “${it.title}” do modelo?\nProjetos que já receberam este item continuam com a cópia deles até você sincronizar.`, okText: 'Remover', danger: true })) {
            try { await api('DELETE', `/api/checklist-items/${it.id}`); await reload(); } catch (e) { if (e.code === 'ITEM_IS_DEPENDENCY') ckInfo('Não é possível remover', e.message); else fail(e); }
          }
        } }, 'Remover')));
    list.replaceChildren(items.length ? h('div', { class: 'stack' }, items.map(itemRow)) : h('div', { class: 'ck-empty' }, h('strong', null, 'Nenhum item neste checklist.'), h('span', { class: 'muted small' }, 'Adicione os itens que precisam ser conferidos.')),
      h('div', null, h('button', { class: 'btn primary', onclick: () => ckItemForm(null, draw, cl.id) }, '+ Adicionar item')));
  };
  draw();
  const m = openModal({ title: ['Itens — ', ckLabel(cur())], size: 'lg',
    body: [h('div', { class: 'box small' }, 'Este checklist é reutilizável: o mesmo conteúdo pode ser usado em vários ciclos e estágios (a associação é feita na configuração do ciclo). Ao entrar na etapa, o projeto recebe uma cópia dos itens; mudanças posteriores só chegam aos projetos em andamento quando você usa “Sincronizar com o modelo” dentro do projeto. Só itens obrigatórios (e a evidência exigida deles) bloqueiam o avanço; links, scripts e descrição são apoio.'),
      usageLine, list],
    footer: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar')] });
}

async function ckItemForm(it, onSaved, checklistId) {
  const scripts = await loadScripts().catch(() => []);
  const emCat = await emCatalog(true).catch(() => null);
  // Ação relacionada "Enviar e-mail": só modelos GLOBAIS (o checklist é reutilizável). Desativado só aparece se já estiver escolhido.
  const emTpls = (emCat?.templates || []).filter((t) => t.scope === 'global' && (t.active || t.id === it?.emailTemplateId));
  const emailSel = h('select', null, h('option', { value: '' }, 'Nenhuma'),
    emTpls.map((t) => h('option', { value: t.id, selected: it?.emailTemplateId === t.id }, `Gerar e-mail — ${t.name}${t.active ? '' : ' (desativado)'}`)));
  const title = h('input', { type: 'text', value: it?.title || '', maxlength: 160, placeholder: 'Ex.: Validar funcionários migrados' });
  const lists = state.checklists;
  const listSel = h('select', null, lists.map((c) => h('option', { value: c.id, selected: (it?.checklistId || checklistId) === c.id }, ckLabel(c))));
  const desc = h('textarea', { maxlength: 1000, placeholder: 'Opcional: como fazer, o que conferir…' }, it?.description || '');
  const req = h('select', { onchange: () => syncCarry() }, h('option', { value: '1', selected: it ? it.required : true }, 'Obrigatório (bloqueia o avanço)'), h('option', { value: '0', selected: it ? !it.required : false }, 'Opcional (não bloqueia)'));
  const carryBox = h('input', { type: 'checkbox', checked: !!it?.carryForward });
  const carryField = h('div', { class: 'field' }, h('label', { class: 'ck-check' }, carryBox, ' Permitir transferir pendência para a próxima etapa'),
    h('div', { class: 'hint' }, 'Se este item obrigatório ainda estiver pendente ao avançar, ele pode seguir para a próxima etapa (com confirmação) em vez de travar o avanço. Continua pendente e conta para a conclusão: o projeto nunca é concluído com ele pendente. Projetos em andamento só recebem a mudança ao “Sincronizar com o modelo”.'));
  const syncCarry = () => { carryField.style.display = req.value === '1' ? '' : 'none'; };
  syncCarry();
  // Dependências: outros itens do modelo, de QUALQUER checklist (por id, não por posição). Ficam de fora o próprio item e quem já depende
  // dele, direta ou indiretamente (o servidor também recusa círculos). Um item opcional escolhido aqui passa a ser exigido só para este.
  const blockedIds = new Set(it ? [it.id] : []);
  for (let grew = !!it; grew;) { grew = false; for (const d of state.checklistItems) if (!blockedIds.has(d.id) && (d.dependsOn || []).some((x) => blockedIds.has(x))) { blockedIds.add(d.id); grew = true; } }
  let deps = [...(it?.dependsOn || [])];
  const depLabel = ckDepLabel;
  const depList = h('div', { class: 'stack' });
  const depSel = h('select', { 'aria-label': 'Item de que este depende' });
  const depAdd = h('button', { type: 'button', class: 'btn sm', onclick: () => { if (depSel.value && !deps.includes(depSel.value) && deps.length < 20) { deps.push(depSel.value); drawDeps(); } } }, '+ Adicionar dependência');
  const drawDeps = () => {
    depList.replaceChildren(...deps.map((id) => { const d = state.checklistItems.find((x) => x.id === id);
      return h('div', { class: 'ck-deprow' }, h('span', { class: 'grow' }, d ? depLabel(d) : '(item removido do modelo)'), d && !d.required ? h('span', { class: 'ck-badge opt', title: 'Opcional: passa a ser exigido só para este item' }, 'Opcional') : null,
        h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': 'Remover dependência', onclick: () => { deps = deps.filter((x) => x !== id); drawDeps(); } }, '✕')); }));
    const groups = state.checklists.map((c) => ({ s: { name: ckLabel(c) }, list: state.checklistItems.filter((d) => d.checklistId === c.id && !blockedIds.has(d.id) && !deps.includes(d.id)) })).filter((g) => g.list.length);
    depSel.replaceChildren(h('option', { value: '' }, groups.length ? '— Escolher o item de que este depende —' : '— Nenhum outro item disponível —'),
      ...groups.map((g) => h('optgroup', { label: g.s.name }, g.list.map((d) => h('option', { value: d.id }, d.title)))));
    depAdd.disabled = !groups.length || deps.length >= 20;
  };
  drawDeps();
  const depField = field(`Dependências`, h('div', { class: 'stack' }, depList, h('div', { class: 'inline' }, depSel, depAdd)),
    'Este item só poderá ser concluído quando todos os itens escolhidos estiverem concluídos (inclusive a evidência exigida), em qualquer etapa e mesmo que tenham sido transferidos. Se o checklist do item escolhido não for usado no ciclo do projeto, a dependência não se aplica a ele. Transferir continua permitido. Projetos em andamento só recebem a mudança ao “Sincronizar com o modelo”.');
  const mode = h('select', { onchange: () => syncEv() },
    [['none', 'Não usa evidência'], ['optional', 'Aceita evidência (opcional)'], ['required', 'Exige evidência']].map(([v, l]) => h('option', { value: v, selected: (it?.evidence.mode || 'none') === v }, l)));
  const types = state.evidence?.types || {};
  const typeSel = h('select', { onchange: () => syncEv() }, ['image', 'document', 'imageOrDocument', 'any'].map((k) => h('option', { value: k, selected: (it?.evidence.type || 'imageOrDocument') === k }, types[k]?.label || k)));
  const min = h('input', { type: 'number', min: 1, max: 20, value: it?.evidence.min || 1 });
  const max = h('input', { type: 'number', min: 1, max: 20, value: it?.evidence.max || 10 });
  const extHint = h('div', { class: 'hint' });
  const evBox = h('div', { class: 'stack' }, h('div', { class: 'cols3' }, field('Tipo de evidência', typeSel), field('Quantidade mínima', min), field('Quantidade máxima', max)), extHint);
  const syncEv = () => {
    evBox.style.display = mode.value === 'none' ? 'none' : '';
    min.parentElement.style.display = mode.value === 'required' ? '' : 'none';
    extHint.textContent = `Extensões aceitas: ${(types[typeSel.value]?.extensions || []).join(' ')} — ajustáveis em Configurações → Evidências.`;
  };
  // links úteis
  let links = (it?.links || []).map((l) => ({ ...l }));
  const linksBox = h('div', { class: 'stack' });
  const drawLinks = () => linksBox.replaceChildren(...links.map((l, i) => h('div', { class: 'ck-linkrow' },
    h('input', { type: 'text', value: l.title, placeholder: 'Título (ex.: Documentação RM)', maxlength: 120, oninput: (e) => { l.title = e.target.value; } }),
    h('input', { type: 'text', value: l.url, placeholder: 'https://…', maxlength: 800, oninput: (e) => { l.url = e.target.value; } }),
    h('input', { type: 'text', value: l.description || '', placeholder: 'Descrição (opcional)', maxlength: 300, oninput: (e) => { l.description = e.target.value; } }),
    h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': 'Remover link', onclick: () => { links.splice(i, 1); drawLinks(); } }, '✕'))),
  h('div', null, h('button', { type: 'button', class: 'btn sm', disabled: links.length >= 10, onclick: () => { links.push({ title: '', url: '', description: '' }); drawLinks(); } }, '+ Link')));
  drawLinks();
  // scripts já cadastrados (só a referência; o arquivo não é copiado)
  const chosen = new Set(it?.scriptIds || []);
  const scriptsBox = scripts.length ? h('div', { class: 'ck-scripts' }, scripts.map((s) => h('label', { class: 'ck-check' },
    h('input', { type: 'checkbox', checked: chosen.has(s.id), onchange: (e) => { if (e.target.checked) chosen.add(s.id); else chosen.delete(s.id); } }), ` ${s.name}`)))
    : h('div', { class: 'hint' }, 'Nenhum script cadastrado ainda. Cadastre em “Scripts SQL” para poder relacioná-los aqui.');
  syncEv();
  const m = openModal({ title: it ? 'Editar item do checklist' : 'Novo item do checklist', wide: true,
    body: [lists.length > 1 ? field('Checklist', listSel, it ? 'Mover o item para outro checklist só chega aos projetos em andamento ao “Sincronizar com o modelo”.' : null) : null, field('Título', title), field('Descrição', desc, 'Dica: use {{greeting}} para a saudação — no projeto aparece como “Bom dia”, “Boa tarde” ou “Boa noite” conforme o horário em que o item é aberto (o modelo continua com a variável).'), h('div', { class: 'cols2' }, field('Tipo', req), field('Evidência', mode)), carryField, depField, evBox,
      field('Links úteis', linksBox, 'Abrem em uma nova aba. Não bloqueiam a conclusão.'), field('Scripts relacionados', scriptsBox, 'Referência aos scripts da lista de Scripts SQL (o arquivo não é copiado). Não bloqueiam a conclusão.'),
      field('Ação: gerar e-mail', emailSel, emTpls.length ? 'No projeto, o item mostra “Gerar e-mail”: monta o e-mail com os dados do projeto para você copiar e colar no Gmail/Outlook. A aplicação não envia nada e gerar não conclui o item.' : 'Nenhum modelo global ativo. Crie em Configurações → Comunicações.')],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { checklistId: listSel.value || checklistId || null, title: title.value, description: desc.value, required: req.value === '1', carryForward: req.value === '1' && carryBox.checked, dependsOn: deps,
          evidence: { mode: mode.value, type: typeSel.value, min: Number(min.value), max: Number(max.value) },
          links: links.filter((l) => l.title.trim() || l.url.trim()), scriptIds: [...chosen], emailTemplateId: emailSel.value || null };
        if (!body.checklistId) throw new Error('Escolha o checklist do item.');
        await (it ? api('PUT', `/api/checklist-items/${it.id}`, body) : api('POST', `/api/checklists/${body.checklistId}/items`, body));
        await refresh(); m.close(); onSaved && onSaved(); toast('Item salvo no modelo.');
      }) }, 'Salvar')] });
  title.focus();
}

// ---------- Configurações: evidências (tamanho máximo e tipos) ----------
function evidenceSettingsCard() {
  const ev = state.evidence || { maxMB: 10, lists: { image: [], document: [], extra: [] } };
  const maxMB = h('input', { type: 'number', min: 1, max: 100, value: ev.maxMB, style: 'width:90px' });
  const listInput = (k) => h('input', { type: 'text', value: (ev.lists[k] || []).join(' '), placeholder: '.pdf .docx' });
  const image = listInput('image'); const document_ = listInput('document'); const extra = listInput('extra');
  return card('Evidências dos checklists', null,
    h('div', { class: 'cols2' }, field('Tamanho máximo por evidência (MB)', maxMB, 'De 1 a 100 MB.'), h('div')),
    field('Imagem', image, 'Extensões aceitas quando o item pede “Imagem” (e “Imagem ou documento”).'),
    field('Documento', document_, 'Extensões aceitas quando o item pede “Documento”.'),
    field('Outros (só em “Qualquer arquivo permitido”)', extra),
    h('div', { class: 'hint' }, 'Programas, scripts e páginas web (.exe, .bat, .ps1, .js, .html, .svg…) são sempre recusados, mesmo que estejam na lista. Além da extensão, o servidor confere o conteúdo do arquivo.'),
    h('div', null, h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
      await api('PUT', '/api/settings/evidence', { maxMB: Number(maxMB.value), image: image.value, document: document_.value, extra: extra.value });
      await refresh(); toast('Configuração de evidências salva.');
    }) }, 'Salvar')));
}
