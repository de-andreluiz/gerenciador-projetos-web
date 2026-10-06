'use strict';
// Biblioteca de Documentos e Modelos: arquivos locais ou links, organizados por etapa do ciclo de migração.

const docFilter = { q: '', kind: '', stage: '' };
const KIND_LABEL = { modelo: 'Modelo', documento: 'Documento' };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fileName = (p) => String(p || '').split(/[\\/]/).pop();
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

// Linha de um documento. compact = versão da tela do projeto (só abrir); completa = biblioteca (editar/remover).
function docRow(d, { compact = false } = {}) {
  const isFile = d.source.type === 'file';
  const open = isFile
    ? h('button', { class: 'btn sm primary', disabled: d.fileExists === false, onclick: (e) => busy(e.target, () => api('POST', `/api/documents/${d.id}/open`)) }, 'Abrir')
    : h('a', { class: 'btn sm primary', href: d.source.url, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir link');
  return h('div', { class: 'row' },
    h('div', { class: 'grow stack' },
      h('div', { class: 'inline' }, h('strong', null, d.title), h('span', { class: `kind ${d.kind}` }, KIND_LABEL[d.kind]),
        isFile && d.fileExists === false ? h('span', { class: 'pill overdue' }, 'arquivo não encontrado') : null),
      d.description ? h('span', { class: 'small muted' }, d.description) : null,
      h('span', { class: 'small muted mono' }, isFile ? d.source.path : hostOf(d.source.url))),
    h('div', { class: 'actions' }, open,
      isFile ? h('button', { class: 'btn sm', disabled: d.fileExists === false, title: 'Abrir a pasta do arquivo', onclick: () => api('POST', `/api/documents/${d.id}/open-folder`).catch(fail) }, 'Pasta') : null,
      compact ? null : [h('button', { class: 'btn sm ghost', onclick: () => docForm(d) }, 'Editar'),
        h('button', { class: 'btn sm ghost', onclick: async () => {
          if (await confirmDialog({ title: 'Remover documento', message: `Remover “${d.title}” da biblioteca? O arquivo ou link original não é alterado.`, okText: 'Remover', danger: true })) { try { await api('DELETE', `/api/documents/${d.id}`); await refresh(); } catch (e) { fail(e); } }
        } }, 'Remover')]));
}

function docForm(d) {
  const title = h('input', { type: 'text', value: d?.title || '', maxlength: 160, placeholder: 'Ex.: Modelo de termo de homologação' });
  const kind = h('select', null, Object.entries(KIND_LABEL).map(([k, t]) => h('option', { value: k, selected: (d?.kind || 'modelo') === k }, t)));
  const stage = h('select', null, h('option', { value: '' }, '— Sem etapa (uso geral) —'),
    state.stages.map((s) => h('option', { value: s.id, selected: d?.stageId === s.id }, s.name)));
  const desc = h('input', { type: 'text', value: d?.description || '', maxlength: 600, placeholder: 'Opcional: quando/como usar' });
  const isLink = d?.source.type === 'link';
  const file = pathField({ value: !isLink ? d?.source.path || '' : '', kind: 'file', filter: 'docs', title: 'Selecione o documento ou modelo' });
  const link = h('input', { type: 'text', value: isLink ? d.source.url : '', placeholder: 'https://…' });
  const src = h('select', { onchange: () => sync() }, h('option', { value: 'file', selected: !isLink }, 'Arquivo neste computador'), h('option', { value: 'link', selected: isLink }, 'Link (Google Docs, Drive, site…)'));
  const fileBox = field('Arquivo', file.el, 'PDF, Word, Excel, PowerPoint, texto, imagem, zip… O arquivo continua onde está; o app guarda só o caminho.');
  const linkBox = field('Link', link);
  const sync = () => { fileBox.style.display = src.value === 'file' ? '' : 'none'; linkBox.style.display = src.value === 'link' ? '' : 'none'; };
  sync();
  const md = openModal({
    title: d ? 'Editar documento' : 'Novo documento ou modelo',
    body: [field('Título', title), h('div', { class: 'cols2' }, field('Tipo', kind), field('Etapa em que é usado', stage)), field('Descrição', desc), field('Origem', src), fileBox, linkBox],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { title: title.value, kind: kind.value, stageId: stage.value || null, description: desc.value,
          source: src.value === 'link' ? { type: 'link', url: link.value } : { type: 'file', path: file.get() } };
        await (d ? api('PUT', `/api/documents/${d.id}`, body) : api('POST', '/api/documents', body));
        await refresh(); md.close(); toast('Documento salvo.');
      }) }, 'Salvar')],
  });
  title.focus();
}

function renderDocs(main) {
  const q = norm(docFilter.q);
  const match = (d) => (!docFilter.kind || d.kind === docFilter.kind)
    && (docFilter.stage === '' || (docFilter.stage === 'none' ? !d.stageId : d.stageId === docFilter.stage))
    && (!q || norm(`${d.title} ${d.description} ${stageById(d.stageId)?.name || ''}`).includes(q));
  const docs = state.documents.filter(match);

  const search = h('input', { type: 'text', value: docFilter.q, placeholder: 'Buscar por título, descrição ou etapa…', 'aria-label': 'Buscar documentos', style: 'flex:1;min-width:220px' });
  const kindSel = h('select', { style: 'width:auto', onchange: (e) => { docFilter.kind = e.target.value; render(); } },
    h('option', { value: '' }, 'Todos os tipos'), Object.entries(KIND_LABEL).map(([k, t]) => h('option', { value: k, selected: docFilter.kind === k }, t)));
  const stageSel = h('select', { style: 'width:auto', onchange: (e) => { docFilter.stage = e.target.value; render(); } },
    h('option', { value: '' }, 'Todas as etapas'), h('option', { value: 'none', selected: docFilter.stage === 'none' }, 'Sem etapa'),
    state.stages.map((s) => h('option', { value: s.id, selected: docFilter.stage === s.id }, s.name)));
  search.addEventListener('input', () => {
    docFilter.q = search.value; const pos = search.selectionStart; render();
    const again = document.querySelector('input[aria-label="Buscar documentos"]'); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  });

  // Agrupa por etapa, na ordem do ciclo (estágios fora do ciclo depois; "Sem etapa" por último).
  const order = [...new Set([...state.cycles.flatMap((c) => c.steps.map((s) => s.stageId)), ...state.stages.map((s) => s.id)])];
  const groups = [...order.map((id) => ({ id, docs: docs.filter((d) => d.stageId === id) })), { id: null, docs: docs.filter((d) => !d.stageId) }].filter((g) => g.docs.length);

  main.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Documentos e Modelos'),
      h('div', { class: 'muted' }, 'A documentação de cada etapa do ciclo de migração, sempre à mão. Aparece também dentro de cada projeto, na etapa correspondente.')),
    h('button', { class: 'btn primary', onclick: () => docForm() }, '+ Documento / modelo')),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'inline' }, search, kindSel, stageSel),
      h('div', { class: 'hint' }, `${plural(docs.length, 'item', 'itens')}${docs.length !== state.documents.length ? ` de ${state.documents.length}` : ''}`))),
    !state.documents.length ? h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('h2', null, 'Biblioteca vazia'),
      h('div', { class: 'muted' }, 'Cadastre os modelos e documentos que precisam ser enviados em cada etapa (ex.: termo de homologação, guia de correções). Você pode apontar para um arquivo do computador ou para um link.'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => docForm() }, '+ Documento / modelo'))))
      : !docs.length ? h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'empty' }, 'Nada encontrado com esses filtros.')))
        : groups.map((g) => card([g.id ? stageTag(stageById(g.id)) : noStageTag('Sem etapa (uso geral)'), h('span', { class: 'muted small', style: 'margin-left:8px' }, plural(g.docs.length, 'item', 'itens'))], null, g.docs.map((d) => docRow(d))))));
}
