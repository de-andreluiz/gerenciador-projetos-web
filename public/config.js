'use strict';
// Configurações: responsáveis (coordenadores e analistas), estágios (tags com cor), ciclo de migração e alertas de prazo.

// Abas (rota #/settings/<aba>): a página cresceu com ciclos, conexões, horas e evidências; cada assunto fica no seu lugar.
const SETTINGS_TABS = [
  { id: 'ciclos', label: 'Ciclos e checklists', hint: 'Tipos de projeto, ciclos de migração (com os checklists que cada estágio usa em cada ciclo), estágios e checklists reutilizáveis.' },
  { id: 'conexoes', label: 'Conexões', hint: 'Conexões de banco cadastradas uma vez e reutilizadas nas bases, no checklist e na execução de scripts.' },
  { id: 'horas', label: 'Jornada e horas', hint: 'Jornada, metas por dia da semana, exceções e aviso de fim de expediente.' },
  { id: 'evidencias', label: 'Evidências', hint: 'Tamanho máximo e tipos de arquivo aceitos como evidência.' },
  { id: 'comunicacoes', label: 'Comunicações', hint: 'Modelos de e-mail reutilizáveis (variáveis e destinatários do projeto) e histórico dos e-mails gerados. A aplicação gera e você copia; ela não envia.' },
  { id: 'geral', label: 'Geral', hint: 'Responsáveis (coordenadores e analistas), sistemas de origem e alertas de prazo.' },
];
function renderSettings(main) {
  const tabId = SETTINGS_TABS.some((t) => t.id === route().id) ? route().id : 'ciclos';
  const tab = SETTINGS_TABS.find((t) => t.id === tabId);
  const content = {
    ciclos: () => [projectTypesCard(), cyclesCard(), stagesCard(), checklistsCard()],
    conexoes: () => [connectionsCard()],
    horas: () => [h('div', { 'data-slot': 'hours-settings', 'data-built': '1' }, hoursSettingsCard())],
    evidencias: () => [evidenceSettingsCard()],
    comunicacoes: () => [emailTemplatesCard(), emailHistoryCard()],
    geral: () => [coordinatorsCard(),
      simpleTagCard({ cardTitle: 'Sistemas de origem', items: state.originSystems, apiPath: 'origin-systems', projectField: 'originSystemId', singular: 'sistema de origem', addLabel: '+ Sistema', placeholder: 'Ex.: RM Classic', emptyHint: 'Nenhum sistema cadastrado. É o sistema de onde os dados estão sendo migrados.' }),
      alertsCard()],
  }[tabId]();
  main.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Configurações'), h('div', { class: 'muted' }, tab.hint))),
    h('nav', { class: 'tabs settings-tabs', role: 'tablist' }, SETTINGS_TABS.map((t) => h('a', { class: `tab${t.id === tabId ? ' active' : ''}`, role: 'tab', 'aria-selected': t.id === tabId ? 'true' : 'false', href: `#/settings/${t.id}` }, t.label))),
    ...content));
}

// ---------- Coordenadores ----------
// Mesma regra do servidor (src/contacts.js), só para mostrar ao digitar qual conversa será aberta; o servidor valida de novo.
function waPreview(phone) {
  const raw = String(phone || '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (raw.startsWith('+')) return d.length >= 8 && d.length <= 15 ? d : null;
  if (d.startsWith('00')) d = d.slice(2); else if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.startsWith('55') && (d.length === 12 || d.length === 13) ? d : null;
}

function coordinatorForm(c) {
  const name = h('input', { type: 'text', value: c?.name || '', maxlength: 120 });
  const role = h('input', { type: 'text', value: c?.role || '', maxlength: 120, placeholder: 'Ex.: Coordenadora de Projetos, Analista de Migração' });
  const email = h('input', { type: 'text', value: c?.email || '', maxlength: 200, placeholder: 'nome@empresa.com.br' });
  const phone = h('input', { type: 'text', value: c?.phone || '', maxlength: 40, placeholder: '(11) 91234-5678' });
  const notes = h('textarea', { maxlength: 500 }, c?.notes || '');
  const hint = h('div', { class: 'hint' });
  const syncHint = () => {
    const n = waPreview(phone.value);
    hint.textContent = !phone.value.trim() ? 'WhatsApp: informe DDD + número, ou o número internacional começando com “+”.'
      : n ? `Abrirá a conversa no WhatsApp com +${n}.` : 'Número inválido para WhatsApp: use DDD + número (ex.: (11) 91234-5678) ou +código do país.';
    hint.style.color = phone.value.trim() && !n ? 'var(--bad-text)' : '';
  };
  phone.addEventListener('input', syncHint); syncHint();
  const md = openModal({
    title: c ? 'Editar responsável' : 'Novo responsável',
    body: [h('div', { class: 'cols2' }, field('Nome', name), field('Cargo / função', role)),
      h('div', { class: 'cols2' }, field('E-mail', email), h('div', { class: 'field' }, h('label', null, 'Telefone / WhatsApp'), phone, hint)), field('Observações', notes)],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { name: name.value, role: role.value, email: email.value, phone: phone.value, notes: notes.value };
        await (c ? api('PUT', `/api/coordinators/${c.id}`, body) : api('POST', '/api/coordinators', body));
        await refresh(); md.close(); toast('Responsável salvo.');
      }) }, 'Salvar')],
  });
  name.focus();
}

// Um só cadastro de pessoas: cada projeto escolhe daqui o coordenador e o analista responsável.
function coordinatorsCard() {
  return card('Responsáveis (coordenadores e analistas)', h('button', { class: 'btn sm', onclick: () => coordinatorForm() }, '+ Responsável'),
    state.coordinators.length ? state.coordinators.map((c) => {
      const asCoord = state.projects.filter((p) => p.coordinatorId === c.id).length;
      const asAnalyst = state.projects.filter((p) => p.analystId === c.id).length;
      const used = state.projects.filter((p) => p.coordinatorId === c.id || p.analystId === c.id).length;
      return h('div', { class: 'row' },
        h('div', { class: 'grow stack' }, h('strong', null, c.name), c.role ? h('span', { class: 'small muted' }, c.role) : null,
          h('span', { class: 'small' }, [c.email, c.phone].filter(Boolean).join('  ·  ') || h('span', { class: 'muted' }, 'Sem contato cadastrado')),
          h('span', { class: 'small muted' }, used ? [asCoord ? `Coordenador em ${plural(asCoord, 'projeto', 'projetos')}` : null, asAnalyst ? `Analista em ${plural(asAnalyst, 'projeto', 'projetos')}` : null].filter(Boolean).join(' · ') : 'Não vinculado a projetos')),
        h('div', { class: 'actions' }, contactLinks(c),
          h('button', { class: 'btn sm ghost', onclick: () => coordinatorForm(c) }, 'Editar'),
          h('button', { class: 'btn sm ghost', onclick: async () => {
            const msg = used ? `Remover “${c.name}”? ${plural(used, 'projeto ficará', 'projetos ficarão')} sem este responsável (coordenador/analista). Os apontamentos de horas guardam o nome de quando foram feitos.` : `Remover “${c.name}”?`;
            if (await confirmDialog({ title: 'Remover responsável', message: msg, okText: 'Remover', danger: true })) { try { await api('DELETE', `/api/coordinators/${c.id}`); await refresh(); } catch (e) { fail(e); } }
          } }, 'Remover')));
    }) : h('div', { class: 'empty' }, 'Nenhum responsável cadastrado. Cadastre coordenadores e analistas para vincular aos projetos e chamar no WhatsApp ou por e-mail com um clique.'));
}

// ---------- Estágios (tags) ----------
const SWATCHES = ['#00DBFF', '#A44DFF', '#00FFD4', '#D9FF65', '#FF8900', '#FFB800', '#FF009E', '#0A46EA', '#8FB0BF'];

function stageForm(s) {
  const name = h('input', { type: 'text', value: s?.name || '', maxlength: 40, placeholder: 'Ex.: Aguardando cliente' });
  const color = h('input', { type: 'color', value: s?.color || '#00DBFF', 'aria-label': 'Cor do estágio', style: 'width:52px;height:34px;padding:2px;flex:none' });
  const preview = h('span', null);
  const sync = () => preview.replaceChildren(stageTag({ name: name.value.trim() || 'Pré-visualização', color: color.value }));
  name.addEventListener('input', sync); color.addEventListener('input', sync); sync();
  const swatches = h('div', { class: 'swatches' }, SWATCHES.map((c) => h('button', { type: 'button', class: 'swatch', title: c, style: `background:${c}`, onclick: () => { color.value = c; sync(); } })));
  const md = openModal({
    title: s ? 'Editar estágio' : 'Novo estágio',
    body: [field('Nome', name), h('div', { class: 'field' }, h('label', null, 'Cor'), h('div', { class: 'inline' }, color, swatches)),
      h('div', { class: 'field' }, h('label', null, 'Como aparece no projeto'), preview)],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { name: name.value, color: color.value };
        await (s ? api('PUT', `/api/stages/${s.id}`, body) : api('POST', '/api/stages', body));
        await refresh(); md.close();
      }) }, 'Salvar')],
  });
  name.focus();
}

function stagesCard() {
  return card('Estágios', h('button', { class: 'btn sm', onclick: () => stageForm() }, '+ Estágio'),
    h('div', { class: 'hint' }, 'Cadastro reutilizável: cadastre cada estágio uma só vez e use-o em quantos ciclos quiser. Os checklists que o estágio usa são escolhidos em cada ciclo.'),
    state.stages.length ? state.stages.map((s) => {
      const inCycle = state.cycles.filter((c) => c.steps.some((x) => x.stageId === s.id)).length;
      const docs = state.documents.filter((d) => d.stageId === s.id).length;
      return h('div', { class: 'row' },
        h('div', { class: 'grow' }, stageTag(s)),
        h('span', { class: 'small muted' }, `${inCycle ? `em ${plural(inCycle, 'ciclo', 'ciclos')}` : 'fora dos ciclos'}${docs ? ` · ${plural(docs, 'documento', 'documentos')}` : ''}`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm ghost', onclick: () => stageForm(s) }, 'Editar'),
          h('button', { class: 'btn sm ghost', onclick: async () => {
            if (!inCycle && !(await confirmDialog({ title: 'Remover estágio', message: `Remover o estágio “${s.name}”?${docs ? ` Os ${docs} documento(s) associados ficam sem etapa.` : ''}`, okText: 'Remover', danger: true }))) return;
            try { await api('DELETE', `/api/stages/${s.id}`); await refresh(); } catch (e) { if (e.code === 'STAGE_IN_USE' || e.code === 'ITEM_IS_DEPENDENCY') ckInfo('Não é possível remover', e.message); else fail(e); }
          } }, 'Remover')));
    }) : h('div', { class: 'empty' }, 'Nenhum estágio. Cadastre os estágios para montar o ciclo de migração.'));
}

// ---------- Checklists (cadastro reutilizável) ----------
function checklistNameDialog(cl) {
  const name = h('input', { type: 'text', value: cl?.name || '', maxlength: 80, placeholder: 'Ex.: Checklist Funcionários, Infraestrutura, Conferência final…' });
  const stage = h('select', { 'aria-label': 'Estágio do checklist' }, h('option', { value: '' }, '— Nenhum (só uso manual nos ciclos) —'),
    state.stages.map((st) => h('option', { value: st.id, selected: cl?.stageId === st.id }, st.name)));
  const md = openModal({ title: cl ? 'Editar checklist' : 'Novo checklist', size: 'sm',
    body: [field('Nome', name), field('Estágio', stage, 'Os checklists de um estágio formam o conjunto dele: ao adicionar o estágio a um ciclo, todos já vêm selecionados (e dá para desmarcar por ciclo). Mudar o estágio não altera os ciclos que já usam este checklist.')],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
      const body = { name: name.value, stageId: stage.value || null };
      const saved = await (cl ? api('PUT', `/api/checklists/${cl.id}`, body) : api('POST', '/api/checklists', body));
      await refresh(); md.close();
      if (!cl) checklistEditor(saved); // checklist novo: já abre para cadastrar os itens
    }) }, 'Salvar')] });
  name.focus();
}

// Filtro do cartão de checklists (estágio + texto): vive fora do cartão para sobreviver aos redesenhos da página.
const CK_FILTER = { stage: '', q: '' };

function checklistsCard() {
  const usageText = (use) => (use.length ? `usado em: ${use.slice(0, 3).map((u) => u.label).join(' · ')}${use.length > 3 ? ` e mais ${use.length - 3}` : ''}` : 'não usado em nenhum ciclo');
  const rowFor = (cl) => {
      const items = state.checklistItems.filter((i) => i.checklistId === cl.id).length;
      const use = ckUsage(cl);
      return h('div', { class: 'row' },
        h('div', { class: 'grow stack' }, h('div', { class: 'inline' }, h('strong', null, ckLabel(cl)), cl.stageId && stageById(cl.stageId) ? stageTag(stageById(cl.stageId)) : h('span', { class: 'small muted' }, 'sem estágio')),
          h('span', { class: 'small muted', title: use.map((u) => u.label).join('\n') }, `${plural(items, 'item', 'itens')} · ${usageText(use)}`)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm', title: 'Itens deste checklist', onclick: () => checklistEditor(cl) }, items ? `Itens (${items})` : 'Adicionar itens'),
          h('button', { class: 'btn sm ghost', onclick: () => checklistNameDialog(cl) }, 'Renomear'),
          h('button', { class: 'btn sm ghost', onclick: async () => {
            // em uso: o servidor recusa e lista onde (nada é apagado); sem uso: confirma antes
            if (!use.length && !(await confirmDialog({ title: 'Remover checklist', message: `Remover o checklist “${cl.name}”${items ? ` e seus ${plural(items, 'item', 'itens')}` : ''} do modelo?\nProjetos que já receberam esses itens continuam com a cópia deles até você sincronizar.`, okText: 'Remover', danger: true }))) return;
            try { await api('DELETE', `/api/checklists/${cl.id}`); await refresh(); } catch (e) { if (e.code === 'CHECKLIST_IN_USE' || e.code === 'ITEM_IS_DEPENDENCY') ckInfo('Não é possível remover', e.message); else fail(e); }
          } }, 'Remover')));
  };
  const total = state.checklists.length;
  const noStage = (c) => !stageById(c.stageId);
  const list = h('div', { class: 'stack' });
  const count = h('span', { class: 'small muted' });
  const q = h('input', { type: 'search', value: CK_FILTER.q, placeholder: 'Buscar checklist por nome…', 'aria-label': 'Buscar checklist', style: 'flex:1 1 220px;min-width:160px', oninput: () => { CK_FILTER.q = q.value; draw(); } });
  const stageSel = h('select', { 'aria-label': 'Filtrar por estágio', style: 'width:auto;min-width:220px;max-width:100%', onchange: () => { CK_FILTER.stage = stageSel.value; draw(); } },
    h('option', { value: '' }, `Todos os estágios (${total})`),
    h('option', { value: '-' }, `Sem estágio (${state.checklists.filter(noStage).length})`),
    state.stages.map((st) => h('option', { value: st.id }, `${st.name} (${state.checklists.filter((c) => c.stageId === st.id).length})`)));
  stageSel.value = CK_FILTER.stage;
  if (stageSel.value !== CK_FILTER.stage) { CK_FILTER.stage = ''; stageSel.value = ''; } // o estágio filtrado foi removido
  const clear = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { CK_FILTER.stage = ''; CK_FILTER.q = ''; stageSel.value = ''; q.value = ''; draw(); } }, 'Limpar filtro');
  const draw = () => {
    const nq = norm(CK_FILTER.q);
    const shown = state.checklists.filter((c) => (!CK_FILTER.stage || (CK_FILTER.stage === '-' ? noStage(c) : c.stageId === CK_FILTER.stage)) && (!nq || norm(c.name).includes(nq)));
    const filtering = !!(CK_FILTER.stage || nq);
    count.textContent = filtering ? `${shown.length} de ${total}` : plural(total, 'checklist', 'checklists');
    clear.style.display = filtering ? '' : 'none';
    list.replaceChildren(...(shown.length ? shown.map(rowFor)
      : [h('div', { class: 'empty' }, filtering ? 'Nenhum checklist encontrado com esse filtro.' : 'Nenhum checklist cadastrado. Crie os checklists (ex.: Funcionários, Folha, Financeiro) e depois associe-os aos estágios de cada ciclo.')]));
  };
  draw();
  return card('Checklists', h('button', { class: 'btn sm', onclick: () => checklistNameDialog(null) }, '+ Checklist'),
    h('div', { class: 'hint' }, 'Cadastro reutilizável: cada checklist existe uma só vez e é cadastrado para um estágio. Ao adicionar o estágio a um ciclo, todos os checklists dele já vêm selecionados; em cada ciclo você pode personalizar quais usar e em que ordem (Ciclos de migração → etapa → Editar checklists). Usar em vários ciclos não copia o checklist.'),
    total ? h('div', { class: 'inline', style: 'flex-wrap:wrap' }, stageSel, q, count, clear) : null,
    list);
}

// ---------- Tipo de projeto e Sistema de origem (catálogos simples: nome + cor) ----------
function simpleTagForm({ title, item, apiPath, placeholder }) {
  const name = h('input', { type: 'text', value: item?.name || '', maxlength: 60, placeholder });
  const color = h('input', { type: 'color', value: item?.color || '#0A46EA', 'aria-label': 'Cor', style: 'width:52px;height:34px;padding:2px;flex:none' });
  const preview = h('span', null);
  const sync = () => preview.replaceChildren(stageTag({ name: name.value.trim() || 'Pré-visualização', color: color.value }));
  name.addEventListener('input', sync); color.addEventListener('input', sync); sync();
  const swatches = h('div', { class: 'swatches' }, SWATCHES.map((c) => h('button', { type: 'button', class: 'swatch', title: c, style: `background:${c}`, onclick: () => { color.value = c; sync(); } })));
  const md = openModal({
    title, body: [field('Nome', name), h('div', { class: 'field' }, h('label', null, 'Cor'), h('div', { class: 'inline' }, color, swatches)),
      h('div', { class: 'field' }, h('label', null, 'Como aparece'), preview)],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { name: name.value, color: color.value };
        await (item ? api('PUT', `/api/${apiPath}/${item.id}`, body) : api('POST', `/api/${apiPath}`, body));
        await refresh(); md.close();
      }) }, 'Salvar')],
  });
  name.focus();
}

function simpleTagCard({ cardTitle, items, apiPath, projectField, singular, addLabel, placeholder, emptyHint, extra }) {
  return card(cardTitle, h('button', { class: 'btn sm', onclick: () => simpleTagForm({ title: `Novo(a) ${singular}`, apiPath, placeholder }) }, addLabel),
    items.length ? items.map((s) => {
      const used = state.projects.filter((p) => p[projectField] === s.id).length;
      return h('div', { class: 'row' },
        h('div', { class: 'grow' }, stageTag(s)),
        extra ? extra(s) : null,
        h('span', { class: 'small muted' }, used ? plural(used, 'projeto', 'projetos') : 'nenhum projeto'),
        h('div', { class: 'actions' }, h('button', { class: 'btn sm ghost', onclick: () => simpleTagForm({ title: `Editar ${singular}`, item: s, apiPath, placeholder }) }, 'Editar'),
          h('button', { class: 'btn sm ghost', onclick: async () => {
            const msg = used ? `Remover “${s.name}”? ${plural(used, 'projeto ficará', 'projetos ficarão')} sem ${singular}.` : `Remover “${s.name}”?`;
            if (await confirmDialog({ title: `Remover ${singular}`, message: msg, okText: 'Remover', danger: true })) { try { await api('DELETE', `/api/${apiPath}/${s.id}`); await refresh(); } catch (e) { fail(e); } }
          } }, 'Remover')));
    }) : h('div', { class: 'empty' }, emptyHint));
}

// ---------- Tipos de projeto (cada um com o seu ciclo padrão) ----------
function projectTypesCard() {
  const base = simpleTagCard({ cardTitle: 'Tipos de projeto', items: state.projectTypes, apiPath: 'project-types', projectField: 'projectTypeId', singular: 'tipo de projeto', addLabel: '+ Tipo', placeholder: 'Ex.: Migração Folha',
    emptyHint: 'Nenhum tipo cadastrado. Ex.: Migração Folha, Migração Educacional, Projeto Interno. Cada tipo pode ter o seu ciclo padrão.',
    extra: (t) => h('label', { class: 'inline small', title: 'Projetos novos deste tipo recebem este ciclo' }, h('span', { class: 'muted' }, 'Ciclo:'),
      h('select', { style: 'width:auto;min-width:180px', onchange: async (e) => { try { await api('PUT', `/api/project-types/${t.id}/cycle`, { cycleId: e.target.value || null }); await refresh(); toast('Ciclo do tipo atualizado.'); } catch (er) { fail(er); } } },
        h('option', { value: '' }, `Padrão (${cycleById(state.defaultCycleId)?.name || '—'})`), state.cycles.map((c) => h('option', { value: c.id, selected: t.cycleId === c.id }, c.name)))) });
  return base;
}

// ---------- Ciclos de migração (reutilizáveis) ----------
function cycleForm(c) {
  const name = h('input', { type: 'text', value: c?.name || '', maxlength: 80, placeholder: 'Ex.: Migração RM Folha' });
  const desc = h('input', { type: 'text', value: c?.description || '', maxlength: 400, placeholder: 'Opcional' });
  const from = h('select', null, h('option', { value: '' }, 'Começar vazio (1 etapa)'), state.cycles.map((x) => h('option', { value: x.id }, `Copiar etapas de “${x.name}”`)));
  const md = openModal({ title: c ? 'Renomear ciclo' : 'Novo ciclo', size: 'sm',
    body: [field('Nome', name), field('Descrição', desc), c ? null : field('Etapas', from, 'Depois você ajusta a sequência no cartão do ciclo.')],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
      if (c) await api('PUT', `/api/cycles/${c.id}`, { name: name.value, description: desc.value });
      else { const n = await api('POST', '/api/cycles', { name: name.value, description: desc.value, copyFrom: from.value || null }); CYCLE_OPEN.add(n.id); }
      await refresh(); md.close(); toast(c ? 'Ciclo atualizado.' : 'Ciclo criado.');
    }) }, 'Salvar')] });
  name.focus();
}

const CYCLE_OPEN = new Set(); // ciclos expandidos no cartão (sobrevive ao refresh)

const STEP_EDIT = new Map(); // etapa (id) → { sel: ids em edição }: rascunho que sobrevive aos redesenhos; Cancelar descarta

// Resumo (estado padrão da área à direita do estágio): quantos checklists estão ativos, se são todos e onde editar.
function stepCkSummary(x) {
  const pool = state.checklists.filter((k) => k.stageId === x.stageId);
  const chosen = (x.checklistIds || []).map((id) => state.checklists.find((k) => k.id === id)).filter(Boolean);
  const inPool = chosen.filter((k) => k.stageId === x.stageId);
  const extras = chosen.length - inPool.length; // checklists de outros estágios escolhidos à mão
  const all = pool.length > 0 && inPool.length === pool.length;
  const edit = h('button', { class: 'btn sm', title: 'Escolher quais checklists este estágio usa neste ciclo', onclick: () => { STEP_EDIT.set(x.id, { sel: chosen.map((k) => k.id) }); render(); } }, pool.length || chosen.length ? 'Editar checklists' : 'Criar checklist');
  if (!pool.length && !chosen.length) {
    return h('div', { class: 'cy-ck' }, h('div', { class: 'cy-ck-head' }, h('strong', null, 'Checklists'), h('span', { class: 'pill' }, '0 checklists')), h('span', { class: 'small muted' }, 'Nenhum checklist cadastrado para este estágio.'), h('div', null, edit));
  }
  return h('div', { class: 'cy-ck' },
    h('div', { class: 'cy-ck-head' }, h('strong', null, 'Checklists'),
      h('span', { class: `pill ${all && !extras ? 'done' : 'soon'}`, title: all && !extras ? 'Todos os checklists do estágio estão ativos (padrão)' : 'Seleção personalizada neste ciclo' }, `${inPool.length}/${pool.length} selecionados`),
      all && !extras ? h('span', { class: 'small muted' }, 'Todos ativos por padrão') : h('span', { class: 'small ck-wait' }, 'Personalizado'),
      extras ? h('span', { class: 'small muted' }, `+ ${plural(extras, 'de outro estágio', 'de outros estágios')}`) : null),
    h('span', { class: 'cy-ck-names small muted', title: chosen.map(ckLabel).join('\n') }, chosen.length ? chosen.map((k) => k.name).join(' · ') : 'Nenhum checklist ativo nesta etapa'),
    h('div', null, edit));
}

// Editor inline dos checklists de UM estágio dentro de UM ciclo (ciclo + estágio + checklists). A ordem da lista de cima é a ordem em que
// aparecem no projeto. Salvar muda só esta associação: não copia checklist, não altera o cadastro, o estágio nem os outros ciclos.
function stepCkEditor(c, x) {
  const draft = STEP_EDIT.get(x.id);
  const stage = stageById(x.stageId);
  const projects = state.projects.filter((p) => p.cycleId === c.id).length;
  const box = h('div', { class: 'cy-ck-edit' });
  const newName = h('input', { type: 'text', maxlength: 80, placeholder: 'Nome do novo checklist deste estágio', 'aria-label': 'Nome do novo checklist' });
  const close = () => { STEP_EDIT.delete(x.id); render(); };
  const move = (i, d) => { const a = draft.sel; [a[i], a[i + d]] = [a[i + d], a[i]]; draw(); };
  const draw = () => {
    const kOf = (id) => state.checklists.find((k) => k.id === id);
    draft.sel = draft.sel.filter(kOf); // checklist removido do cadastro enquanto editava
    const pool = state.checklists.filter((k) => k.stageId === x.stageId);
    const items = (k) => plural(state.checklistItems.filter((i) => i.checklistId === k.id).length, 'item', 'itens');
    const toggle = (k, on) => { if (on) draft.sel.push(k.id); else draft.sel = draft.sel.filter((id) => id !== k.id); draw(); };
    const check = (k, on) => h('label', { class: 'ck-check grow', style: 'cursor:pointer;min-width:0' },
      h('input', { type: 'checkbox', checked: on, onchange: (e) => toggle(k, e.target.checked) }), ` ${k.name} `,
      k.stageId !== x.stageId ? h('span', { class: 'small muted' }, `(${stageById(k.stageId)?.name || 'sem estágio'}) `) : null, h('span', { class: 'small muted' }, items(k)));
    const rest = pool.filter((k) => !draft.sel.includes(k.id));
    const others = state.checklists.filter((k) => k.stageId !== x.stageId && !draft.sel.includes(k.id));
    box.replaceChildren(...[
      h('div', { class: 'inline' }, h('strong', null, 'Checklists do estágio'), stage ? stageTag(stage) : null, h('span', { class: 'small muted' }, `neste ciclo: ${c.name}`)),
      projects ? h('div', { class: 'small muted' }, `${plural(projects, 'projeto usa', 'projetos usam')} este ciclo: salvar gera uma nova versão e cada projeto só muda quando você revisa e aplica.`) : null,
      h('div', { class: 'stack', style: 'gap:4px' },
        draft.sel.map((id, i) => h('div', { class: 'row' }, h('span', { class: 'cycle-n' }, i + 1), check(kOf(id), true),
          h('div', { class: 'actions' },
            h('button', { class: 'btn xs ghost', disabled: i === 0, title: 'Subir', 'aria-label': 'Subir', onclick: () => move(i, -1) }, '↑'),
            h('button', { class: 'btn xs ghost', disabled: i === draft.sel.length - 1, title: 'Descer', 'aria-label': 'Descer', onclick: () => move(i, 1) }, '↓')))),
        rest.map((k) => h('div', { class: 'row' }, h('span', { class: 'cycle-n off' }, '–'), check(k, false))),
        !pool.length && !draft.sel.length ? h('div', { class: 'small muted' }, 'Nenhum checklist cadastrado para este estágio. Crie o primeiro abaixo.') : null),
      others.length ? h('details', { class: 'hist' }, h('summary', null, `Usar também um checklist de outro estágio (${others.length})`),
        h('div', { class: 'stack', style: 'gap:4px;margin-top:6px' }, others.map((k) => h('div', { class: 'row' }, check(k, false))))) : null,
      h('div', { class: 'inline' }, newName, h('button', { type: 'button', class: 'btn sm', onclick: (e) => busy(e.target, async () => {
        const k = await api('POST', '/api/checklists', { name: newName.value, stageId: x.stageId });
        draft.sel.push(k.id); await refresh(); toast('Checklist criado para este estágio. Adicione os itens em “Checklists”.');
      }) }, '+ Criar checklist deste estágio')),
      h('div', { class: 'inline', style: 'justify-content:space-between' },
        h('div', { class: 'inline' },
          h('button', { type: 'button', class: 'btn xs ghost', onclick: () => { draft.sel = [...draft.sel, ...pool.map((k) => k.id).filter((id) => !draft.sel.includes(id))]; draw(); } }, 'Selecionar todos do estágio'),
          h('button', { type: 'button', class: 'btn xs ghost', onclick: () => { draft.sel = []; draw(); } }, 'Limpar seleção')),
        h('div', { class: 'inline' }, h('button', { class: 'btn', onclick: close }, 'Cancelar'),
          h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
            await api('PUT', `/api/cycles/${c.id}/steps/${x.id}/checklists`, { checklistIds: draft.sel });
            STEP_EDIT.delete(x.id); await refresh(); toast(`Checklists de ${stage?.name || 'o estágio'} salvos neste ciclo.`);
          }) }, 'Salvar')))].filter(Boolean)); // (null direto no replaceChildren viraria o texto "null")
  };
  draw();
  return box;
}

function cycleEditor(c) {
  const steps = c.steps;
  const save = async (next) => {
    // checklistIds ausente (etapa nova ou estágio trocado) = o servidor começa com TODOS os checklists do estágio; presente = mantém a seleção
    try { await api('PUT', `/api/cycles/${c.id}`, { steps: next.map((x) => ({ id: x.id, stageId: x.stageId, checklistIds: x.checklistIds })) }); await refresh(); } catch (e) { fail(e); }
  };
  const move = (i, d) => { const a = steps.map((x) => ({ ...x })); [a[i], a[i + d]] = [a[i + d], a[i]]; save(a); };
  const inProjects = (stepId) => state.projects.filter((p) => p.cycleId === c.id && p.stepId === stepId).length;
  return h('div', { class: 'stack' },
    steps.map((x, i) => {
      const inStep = inProjects(x.id);
      const editing = STEP_EDIT.has(x.id);
      return h('div', { class: `row cy-step${editing ? ' editing' : ''}`, style: 'padding:8px 10px' },
        h('span', { class: 'cycle-n' }, i + 1),
        h('div', { class: 'cy-stage stack', style: 'gap:2px' },
          h('select', { 'aria-label': `Estágio da etapa ${i + 1}`, onchange: async (e) => {
            // a seleção é do par ciclo + estágio: ao trocar o estágio, a etapa passa a usar todos os checklists do novo estágio
            const custom = (x.checklistIds || []).length;
            if (custom && !(await confirmDialog({ title: 'Trocar o estágio da etapa', message: `Esta etapa tem ${plural(custom, 'checklist selecionado', 'checklists selecionados')} neste ciclo. Ao trocar o estágio, a seleção é substituída por todos os checklists do novo estágio (os outros ciclos não mudam).`, okText: 'Trocar estágio' }))) { e.target.value = x.stageId; return; }
            STEP_EDIT.delete(x.id);
            save(steps.map((y) => (y.id === x.id ? { id: y.id, stageId: e.target.value } : y)));
          } }, state.stages.map((st) => h('option', { value: st.id, selected: st.id === x.stageId }, st.name))),
          inStep ? h('span', { class: 'small muted' }, plural(inStep, 'projeto nesta etapa', 'projetos nesta etapa')) : null),
        stepCkSummary(x),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm ghost', disabled: i === 0, title: 'Mover para cima', 'aria-label': 'Mover para cima', onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'btn sm ghost', disabled: i === steps.length - 1, title: 'Mover para baixo', 'aria-label': 'Mover para baixo', onclick: () => move(i, 1) }, '↓'),
          h('button', { class: 'btn sm ghost', title: 'Remover etapa', 'aria-label': 'Remover etapa', disabled: steps.length === 1, onclick: () => save(steps.filter((y) => y.id !== x.id)) }, '✕')),
        editing ? stepCkEditor(c, x) : null);
    }),
    h('div', null, h('button', { class: 'btn sm', disabled: !state.stages.length, onclick: () => save([...steps, { stageId: state.stages[0].id }]) }, '+ Etapa')));
}

function cyclesCard() {
  return card('Ciclos de migração', h('button', { class: 'btn sm primary', onclick: () => cycleForm(null) }, '+ Ciclo'),
    h('div', { class: 'hint' }, 'Um ciclo é a sequência de etapas (estágios) de um tipo de projeto, e cada etapa diz quais checklists usa naquele ciclo (o mesmo estágio pode usar checklists diferentes em outro ciclo). Cada projeto recebe uma cópia: alterar um ciclo — etapas ou checklists — gera uma nova versão, que os projetos só recebem quando alguém revisa e aplica (no próprio projeto).'),
    state.cycles.length ? state.cycles.map((c) => {
      const projects = state.projects.filter((p) => p.cycleId === c.id);
      const outdated = projects.filter((p) => p.cycleUpdate?.available).length;
      const types = state.projectTypes.filter((t) => t.cycleId === c.id || (!t.cycleId && c.id === state.defaultCycleId));
      const open = CYCLE_OPEN.has(c.id);
      return h('div', { class: 'cy-card' },
        h('div', { class: 'cy-head' },
          h('button', { class: 'btn sm ghost', 'aria-expanded': open ? 'true' : 'false', title: open ? 'Recolher' : 'Editar etapas', onclick: () => { if (open) CYCLE_OPEN.delete(c.id); else CYCLE_OPEN.add(c.id); render(); } }, open ? '▾' : '▸'),
          h('div', { class: 'grow stack' },
            h('div', { class: 'inline' }, h('strong', null, c.name), c.id === state.defaultCycleId ? h('span', { class: 'pill done' }, 'padrão') : null, h('span', { class: 'small muted' }, `v${c.version} · ${plural(c.steps.length, 'etapa', 'etapas')}`)),
            h('span', { class: 'small muted' }, [c.description, plural(projects.length, 'projeto', 'projetos'), types.length ? `tipos: ${types.map((t) => t.name).join(', ')}` : null, outdated ? `${outdated} com versão antiga` : null].filter(Boolean).join(' · '))),
          h('div', { class: 'actions' },
            c.id !== state.defaultCycleId ? h('button', { class: 'btn sm ghost', title: 'Projetos sem tipo (ou tipo sem ciclo) recebem o ciclo padrão', onclick: async () => { try { await api('PUT', '/api/cycles-default', { id: c.id }); await refresh(); } catch (e) { fail(e); } } }, 'Tornar padrão') : null,
            h('button', { class: 'btn sm ghost', onclick: () => cycleForm(c) }, 'Renomear'),
            h('button', { class: 'btn sm ghost', onclick: async () => {
              if (!(await confirmDialog({ title: 'Excluir ciclo', message: `Excluir o ciclo “${c.name}”? Só é possível se nenhum projeto ou tipo de projeto o usar.`, okText: 'Excluir', danger: true }))) return;
              try { await api('DELETE', `/api/cycles/${c.id}`); await refresh(); } catch (e) { fail(e); }
            } }, 'Excluir'))),
        h('div', { class: 'cycle-preview' }, cycleBar(c.steps, null)),
        open ? cycleEditor(c) : null);
    }) : h('div', { class: 'empty' }, 'Nenhum ciclo. Crie o primeiro.'));
}

// ---------- Alertas de prazo (movido da Visão geral) ----------
function alertsCard() {
  const warn = h('input', { type: 'number', min: 0, max: 365, value: state.settings.warnDays, style: 'width:80px;flex:none' });
  return card('Alertas de prazo', null,
    h('div', { class: 'inline' }, h('span', null, 'Considerar “próximo do prazo” quando faltarem até'), warn, h('span', null, 'dias'),
      h('button', { class: 'btn sm', onclick: (e) => busy(e.target, async () => { await api('PUT', '/api/settings', { warnDays: Number(warn.value) }); await refresh(); toast('Configuração salva.'); }) }, 'Salvar')),
    h('div', { class: 'hint' }, 'Cada prazo pode ter seu próprio número de dias de aviso, que prevalece sobre este padrão.'));
}
