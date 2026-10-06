'use strict';
// Tela do projeto: coordenador, ciclo de migração (barra de progresso), planilhas de Correções e documentos da etapa.

// Responsáveis do projeto (coordenador e analista vêm do mesmo cadastro de pessoas), discretos, um por linha.
function personChip(label, c, p) {
  if (!c) return h('span', { class: 'coord muted small' }, `Sem ${label.toLowerCase()} `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); projectForm(p); } }, 'definir'));
  return h('span', { class: 'coord' }, h('span', { class: 'muted small' }, `${label}:`), h('strong', null, c.name),
    c.role ? h('span', { class: 'muted small' }, `(${c.role})`) : null, contactLinks(c));
}
function coordinatorChip(p) {
  return h('div', { class: 'people' }, personChip('Coordenador', coordinatorById(p.coordinatorId), p), personChip('Analista', coordinatorById(p.analystId), p));
}

// Barra de progresso do ciclo. Passos já concluídos ficam preenchidos com a cor do estágio, o atual é destacado.
// Sem onPick a barra é só de exibição (ex.: pré-visualização em Configurações).
// summary (opcional): andamento do checklist por passo (project.checklist) — mostra "Concluído / Em andamento / Não iniciado" e N/M itens.
function cycleBar(steps, currentId, { onPick, summary } = {}) {
  const cur = steps.findIndex((s) => s.id === currentId);
  const bar = h('div', { class: 'cycle', role: 'list' }, steps.map((s, i) => {
    const stage = stageById(s.stageId) || { name: '?', color: '#8FB0BF' };
    const done = cur >= 0 && i < cur;
    const pr = summary?.[s.id];
    const situation = cur < 0 ? 'Não iniciado' : done ? '✓ Concluído' : i === cur ? '● Em andamento' : '○ Não iniciado';
    return h('button', {
      class: `step${done ? ' done' : ''}${i === cur ? ' current' : ''}`, role: 'listitem', style: tagStyle(stage.color), disabled: !onPick,
      'aria-current': i === cur ? 'step' : null, title: onPick ? `Definir etapa: ${stage.name}${pr?.total ? ` — checklist ${pr.done}/${pr.total}` : ''}` : stage.name, onclick: onPick ? () => onPick(s) : null,
    }, h('span', { class: 'node' }, done ? '✓' : String(i + 1)), h('span', { class: 'lbl' }, stage.name),
    summary ? h('span', { class: 'sub' }, situation, pr?.total ? h('span', { class: 'sub-n' }, `${pr.done}/${pr.total} itens`) : null,
      pr?.inherited?.pending ? h('span', { class: 'sub-n sub-warn', title: 'Pendências herdadas de etapas anteriores' }, `⚠ ${pr.inherited.pending} herdada${pr.inherited.pending === 1 ? '' : 's'}`) : null,
      pr?.carriedOut ? h('span', { class: 'sub-n sub-warn', title: 'Itens desta etapa que seguiram adiante ainda pendentes' }, `↪ ${pr.carriedOut} transferida${pr.carriedOut === 1 ? '' : 's'}`) : null) : null);
  }));
  // Ciclo longo rola na horizontal: a etapa atual fica centralizada e as bordas esmaecem enquanto houver etapas escondidas.
  const fades = () => { bar.classList.toggle('fade-l', bar.scrollLeft > 4); bar.classList.toggle('fade-r', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4); };
  bar.addEventListener('scroll', fades, { passive: true });
  requestAnimationFrame(() => {
    const el = cur >= 0 ? bar.children[cur] : null;
    if (el && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, el.offsetLeft - (bar.clientWidth - el.offsetWidth) / 2);
    fades();
  });
  return bar;
}

// Devolve true se a etapa mudou. Pendências transferíveis: o servidor pergunta (CHECKLIST_CARRY) e só avança com a confirmação.
async function setStep(p, stepId, extra = {}) {
  try {
    const saved = await api('PUT', `/api/projects/${p.id}/step`, { stepId, ...extra });
    CK.view.delete(p.id); ckReset(); // itens podem ter mudado de etapa: os checklists abertos são relidos
    replaceProject(saved);
    return true;
  } catch (e) {
    if (e.code === 'CHECKLIST_PENDING') ckBlockedDialog(p, e);
    else if (e.code === 'CHECKLIST_CARRY') ckCarryDialog(p, stepId, e);
    else fail(e);
    return false;
  }
}

// Nova versão do ciclo: mostra o antes/depois e só aplica quando a pessoa confirma (nada muda sozinho).
async function cycleUpdateDialog(p) {
  let r;
  try { r = await api('POST', `/api/projects/${p.id}/cycle/apply`, { dryRun: true }); } catch (e) { return fail(e); }
  const d = r.diff;
  if (!d.available) { replaceProject(r.project); return toast('O projeto já está com a versão atual do ciclo.'); }
  const list = (arr, sign) => arr.map((x) => h('div', { class: 'small' }, `${sign} ${x.stageName}`, x.started ? h('span', { class: 'muted' }, ' (checklist já iniciado — fica guardado)') : null));
  const m = openModal({ title: `Nova versão do ciclo “${d.cycleName}”`,
    body: [h('p', { style: 'margin:0' }, `Este projeto usa a versão ${d.from}; a versão atual é a ${d.version}. Revise antes de aplicar — o andamento, o histórico e os checklists das etapas que continuam são mantidos.`),
      h('div', { class: 'cols2' },
        h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Hoje neste projeto'), h('ol', { class: 'small', style: 'margin:0;padding-left:20px' }, d.before.map((n) => h('li', null, n)))),
        h('div', { class: 'stack' }, h('span', { class: 'lbl' }, 'Versão nova'), h('ol', { class: 'small', style: 'margin:0;padding-left:20px' }, d.after.map((n) => h('li', null, n))))),
      d.added.length ? h('div', { class: 'stack' }, h('strong', null, `Etapas novas (${d.added.length})`), list(d.added, '+')) : null,
      d.removed.length ? h('div', { class: 'stack' }, h('strong', null, `Etapas que saem (${d.removed.length})`), list(d.removed, '−')) : null,
      d.changed.length ? h('div', { class: 'stack' }, h('strong', null, `Etapas trocadas (${d.changed.length})`), list(d.changed, '~')) : null,
      d.checklistChanges?.length ? h('div', { class: 'stack' }, h('strong', null, `Checklists alterados (${d.checklistChanges.length} ${d.checklistChanges.length === 1 ? 'etapa' : 'etapas'})`),
        d.checklistChanges.map((x) => h('div', { class: 'small' }, `~ ${x.stageName}: `,
          x.added.length ? h('span', null, `+ ${x.added.join(', ')} `) : null, x.removed.length ? h('span', null, `− ${x.removed.join(', ')} `) : null, x.reordered ? h('span', { class: 'muted' }, 'só a ordem mudou ') : null,
          x.started ? h('span', { class: 'muted' }, '(checklist já iniciado: depois de aplicar, use “Sincronizar com o modelo”; marcações e evidências ficam preservadas)') : null))) : null,
      d.reordered ? h('div', { class: 'small muted' }, 'Só a ordem das etapas mudou.') : null,
      d.currentRemoved ? h('div', { class: 'box warn small' }, 'A etapa atual do projeto sai do ciclo: ao aplicar, o projeto fica sem etapa definida (você escolhe a etapa de novo em seguida).') : null].filter(Boolean),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Agora não'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const res = await api('POST', `/api/projects/${p.id}/cycle/apply`, { confirmCurrentRemoved: d.currentRemoved });
        replaceProject(res.project); m.close(); toast('Nova versão do ciclo aplicada ao projeto.');
      }, 'Aplicando…') }, 'Aplicar ao projeto')] });
}

// Aplicar a nova versão de um ciclo em vários projetos de uma vez (cada um continua podendo ser revisado individualmente).
function cycleBulkDialog(c) {
  const outdated = state.projects.filter((p) => p.cycleId === c.id && p.cycleUpdate?.available);
  const rows = outdated.map((p) => ({ p, box: h('input', { type: 'checkbox', checked: !p.cycleUpdate.currentRemoved }) }));
  const m = openModal({ title: `Nova versão do ciclo “${c.name}”`, size: 'md',
    body: [h('div', { class: 'small muted' }, 'Os projetos marcados recebem a versão atual do ciclo. O andamento, o histórico e os checklists das etapas que continuam são mantidos. Projetos cuja etapa atual sai do ciclo ficam desmarcados — revise-os um a um.'),
      h('div', { class: 'stack' }, rows.map(({ p, box }) => { const d = p.cycleUpdate; return h('label', { class: 'row', style: 'padding:6px 10px;cursor:pointer' }, box,
        h('div', { class: 'grow stack', style: 'gap:2px' }, h('strong', null, p.name), h('span', { class: 'small muted' }, `v${d.from} → v${d.version} · ${[d.added.length ? `+${d.added.length} etapa(s)` : null, d.removed.length ? `−${d.removed.length} etapa(s)` : null, d.changed.length ? `${d.changed.length} trocada(s)` : null, d.checklistChanges?.length ? `checklists em ${d.checklistChanges.length} etapa(s)` : null, d.reordered ? 'só a ordem' : null].filter(Boolean).join(', ')}`),
          d.currentRemoved ? h('span', { class: 'small ck-wait' }, 'A etapa atual sai do ciclo') : null),
        h('button', { class: 'btn xs', onclick: (e) => { e.preventDefault(); m.close(); cycleUpdateDialog(p); } }, 'Revisar')); }))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
      const chosen = rows.filter((r) => r.box.checked);
      if (!chosen.length) throw new Error('Marque ao menos um projeto.');
      let ok = 0;
      for (const { p } of chosen) { await api('POST', `/api/projects/${p.id}/cycle/apply`, { confirmCurrentRemoved: !!p.cycleUpdate.currentRemoved }); ok++; }
      await refresh(); m.close(); toast(`Nova versão aplicada em ${plural(ok, 'projeto', 'projetos')}.`);
    }, 'Aplicando…') }, 'Aplicar aos marcados')] });
}

function cycleCard(p) {
  const steps = projectSteps(p);
  const cyc = cycleById(p.cycleId);
  const title = ['Ciclo de migração', cyc ? h('span', { class: 'muted small', style: 'font-weight:400' }, `  ${cyc.name}`) : null];
  const editLink = h('a', { class: 'link-quiet', href: '#/settings/ciclos', title: 'Ciclos, estágios e checklists' }, 'Editar ciclos');
  const update = p.cycleUpdate?.available ? h('div', { class: 'box warn inline', style: 'justify-content:space-between' },
    h('span', null, h('strong', null, 'Nova versão disponível para este ciclo'), ` (v${p.cycleUpdate.from} → v${p.cycleUpdate.version}).`),
    h('button', { class: 'btn sm', onclick: () => cycleUpdateDialog(p) }, 'Revisar alterações')) : null;
  if (!steps.length) return card(title, editLink, update, h('div', { class: 'empty' }, 'O ciclo deste projeto não tem etapas. Escolha um ciclo em “Editar” (projeto) ou monte as etapas em Configurações → Ciclos.'));

  const i = stepIndex(p);
  const st = stageOf(p);
  const last = steps.length - 1;
  const nextStage = i < last ? stageById(steps[i + 1].stageId) : null;
  const entry = [...p.stageHistory].reverse().find((x) => x.stepId === p.stepId);
  const since = entry ? Math.max(0, Math.round((Date.parse(state.today) - Date.parse(localDateOf(entry.at))) / 86400000)) : null;
  const hist = [...p.stageHistory].reverse();
  const curCk = p.stepId ? p.checklist?.[p.stepId] : null;

  return card(title, editLink, update,
    cycleBar(steps, p.stepId, { summary: p.checklist, onPick: (s) => { if (s.id !== p.stepId) setStep(p, s.id); } }),
    h('div', { class: 'row' },
      h('div', { class: 'grow stack' },
        st ? h('span', null, 'Etapa atual: ', stageTag(st), h('span', { class: 'muted small' }, `  passo ${i + 1} de ${steps.length}`))
          : h('span', { class: 'muted' }, 'Etapa ainda não definida. Clique em um passo acima ou inicie o ciclo.'),
        entry ? h('span', { class: 'small muted' }, `Nesta etapa desde ${fmtDate(localDateOf(entry.at))}${since === 0 ? ' (hoje)' : ` (${plural(since, 'dia', 'dias')})`}`) : null,
        curCk && curCk.requiredTotal ? h('span', { class: `small ${curCk.requiredDone < curCk.requiredTotal ? 'ck-wait' : 'ck-done'}` },
          `Checklist: ${curCk.requiredDone}/${curCk.requiredTotal} obrigatórios${curCk.requiredDone < curCk.requiredTotal ? ' — faltam para avançar ' : ' ✓'}`,
          curCk.requiredDone < curCk.requiredTotal ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); document.querySelector('[data-slot="checklist"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, '(ver checklist)') : null) : null,
        p.pendencies?.inherited ? h('span', { class: 'small ck-wait' }, `⚠ ${plural(p.pendencies.inherited, 'pendência herdada', 'pendências herdadas')} de etapas anteriores `,
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); CK.view.delete(p.id); ckRefreshView(p); document.querySelector('[data-slot="checklist"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, '(ver)')) : null,
        p.pendencies && p.pendencies.requiredPending > (curCk ? curCk.requiredTotal - curCk.requiredDone : 0) ? h('span', { class: 'small muted' }, `Obrigatórios pendentes no projeto: ${p.pendencies.requiredPending} (a conclusão exige todos)`) : null),
      h('div', { class: 'actions' },
        h('button', { class: 'btn sm', disabled: i <= 0, onclick: () => setStep(p, steps[i - 1].id) }, '← Voltar etapa'),
        h('button', { class: 'btn sm primary', disabled: i === last, onclick: () => setStep(p, steps[i + 1].id) },
          i < 0 ? 'Iniciar ciclo →' : i === last ? 'Ciclo concluído' : i + 1 === last ? `Concluir projeto (${nextStage ? nextStage.name : ''}) →` : `Avançar para ${nextStage ? nextStage.name : ''} →`),
        i >= 0 ? h('button', { class: 'btn sm ghost', title: 'Voltar a “sem etapa”', onclick: () => setStep(p, null) }, 'Limpar') : null)),
    hist.length ? h('details', { class: 'hist' }, h('summary', null, `Histórico de etapas (${hist.length})`),
      h('div', { class: 'stack', style: 'margin-top:6px' }, hist.map((x) => h('div', { class: 'small' },
        h('span', { class: 'tag', style: x.stepId ? tagStyle(x.color) : null }, x.name), h('span', { class: 'muted' }, `  ${fmtDateTime(x.at)}`),
        x.carried ? h('span', { class: 'ck-wait' }, `  · ${plural(x.carried, 'pendência transferida', 'pendências transferidas')}`) : null)))) : null);
}

// ---------- Planilhas de Correções (link do Google Sheets) ----------
function correctionForm(p, c) {
  const label = h('input', { type: 'text', value: c?.label || 'Correções', maxlength: 120, placeholder: 'Ex.: Correções – Homologação' });
  const url = h('input', { type: 'text', value: c?.url || '', placeholder: 'https://docs.google.com/spreadsheets/d/…' });
  const note = h('input', { type: 'text', value: c?.note || '', maxlength: 300, placeholder: 'Opcional' });
  const md = openModal({
    title: c ? 'Editar planilha de correções' : 'Anexar planilha de correções',
    body: [field('Nome', label, 'Ex.: uma por rodada (homologação, produção).'), field('Link do Google Sheets', url), field('Observação', note)],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { label: label.value, url: url.value, note: note.value };
        replaceProject(c ? await api('PUT', `/api/projects/${p.id}/corrections/${c.id}`, body) : await api('POST', `/api/projects/${p.id}/corrections`, body));
        md.close();
      }) }, 'Salvar')],
  });
  (c ? label : url).focus();
}

function correctionsCard(p) {
  return card('Planilhas de Correções (Google Sheets)', h('button', { class: 'btn sm', onclick: () => correctionForm(p) }, '+ Planilha'),
    p.corrections.length ? p.corrections.map((c) => h('div', { class: 'row' },
      h('div', { class: 'grow stack' }, h('strong', null, c.label), c.note ? h('span', { class: 'small muted' }, c.note) : null),
      h('div', { class: 'actions' },
        h('a', { class: 'btn sm primary', href: c.url, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir no Google Sheets'),
        h('button', { class: 'btn sm ghost', onclick: () => correctionForm(p, c) }, 'Editar'),
        h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog({ title: 'Remover planilha', message: `Remover “${c.label}” do projeto? A planilha no Google Sheets não é alterada.`, okText: 'Remover', danger: true })) { try { replaceProject(await api('DELETE', `/api/projects/${p.id}/corrections/${c.id}`)); } catch (e) { fail(e); } } } }, 'Remover'))))
      : h('div', { class: 'empty' }, 'Nenhuma planilha de correções. Anexe o link da planilha do Google Sheets usada nas rodadas de correção.'));
}

// ---------- Documentos e modelos da etapa atual ----------
function stageDocsCard(p) {
  const st = stageOf(p);
  const docs = st ? state.documents.filter((d) => d.stageId === st.id) : [];
  return card(['Documentos e modelos desta etapa ', st ? stageTag(st) : null], h('a', { class: 'link-quiet', href: '#/docs' }, 'Abrir biblioteca'),
    !st ? h('div', { class: 'empty' }, 'Defina a etapa do projeto no ciclo acima para ver os documentos e modelos dela.')
      : docs.length ? docs.map((d) => docRow(d, { compact: true }))
        : h('div', { class: 'empty' }, 'Nenhum documento ou modelo cadastrado para esta etapa. Cadastre na biblioteca de Documentos e Modelos.'));
}
