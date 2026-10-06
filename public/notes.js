// Observações do projeto: particularidades em texto, com links, arquivos e pastas para consulta rápida.
// Os anexos são REFERÊNCIAS (link ou caminho, como em Documentos e Modelos): o app não copia, altera nem apaga o arquivo/pasta.
function projectNotesCard(p) {
  const body = h('div', { class: 'stack', style: 'gap:12px' }, h('div', { class: 'empty' }, 'Carregando…'));
  const head = h('div', { class: 'inline' });
  const url = (n, r, tail = '') => `/api/projects/${p.id}/notes/${n.id}/refs/${r.id}/${tail}`;
  const open = (n, r, tail) => api('POST', url(n, r, tail)).catch(fail); // erro (arquivo movido etc.) vira aviso na tela

  const refChip = (n, r) => {
    if (r.kind === 'link') return h('a', { class: 'btn sm note-ref', href: r.url, target: '_blank', rel: 'noopener noreferrer', title: r.url }, icon('external', 13), r.label);
    const gone = r.exists === false;
    const main = h('button', { class: 'btn sm note-ref', disabled: gone, title: gone ? 'Não encontrado no caminho cadastrado' : r.path, onclick: () => open(n, r, 'open') }, icon(r.kind === 'folder' ? 'folder' : 'file', 13), r.label);
    return h('span', { class: 'note-refgrp' }, main,
      r.kind === 'file' && !gone ? h('button', { class: 'btn sm ghost', title: 'Abrir a pasta do arquivo', onclick: () => open(n, r, 'open-folder') }, 'pasta') : null,
      gone ? h('span', { class: 'pill overdue', title: r.path }, 'não encontrado') : null);
  };

  const noteBlock = (n) => h('div', { class: 'note' },
    h('div', { class: 'inline' }, n.title ? h('strong', { class: 'grow' }, n.title) : h('span', { class: 'grow' }), h('span', { class: 'small muted' }, fmtDateTime(n.updatedAt)),
      h('button', { class: 'btn xs ghost', onclick: () => noteForm(p, n, redraw) }, 'Editar'),
      h('button', { class: 'btn xs ghost', onclick: async () => {
        if (!(await confirmDialog({ title: 'Remover observação', message: `Remover esta observação${n.title ? ` (“${n.title}”)` : ''}? Os links, arquivos e pastas anexados não são alterados.`, okText: 'Remover', danger: true }))) return;
        try { redraw(await api('DELETE', `/api/projects/${p.id}/notes/${n.id}`)); } catch (e) { fail(e); }
      } }, 'Remover')),
    n.text ? h('div', { class: 'note-text' }, n.text) : null,
    n.refs.length ? h('div', { class: 'note-refs' }, n.refs.map((r) => refChip(n, r))) : null);

  const redraw = (r) => {
    if (r.project) replaceProjectQuiet(r.project);
    head.replaceChildren(h('button', { class: 'btn sm primary', onclick: () => noteForm(p, null, redraw) }, '+ Observação'));
    body.replaceChildren(...(r.notes.length ? r.notes.map(noteBlock) : [h('div', { class: 'empty' }, 'Nenhuma observação. Registre particularidades deste projeto e anexe links, arquivos ou pastas para consulta rápida.')]));
  };
  api('GET', `/api/projects/${p.id}/notes`).then(redraw).catch((e) => body.replaceChildren(h('div', { class: 'box bad' }, e.message)));
  return card('Observações', head, body);
}

// Criar/editar uma observação: título (opcional), texto e a lista de links, arquivos e pastas.
function noteForm(p, note, onSaved) {
  const title = h('input', { type: 'text', value: note?.title || '', maxlength: 120, placeholder: 'Resumo curto (opcional)' });
  const text = h('textarea', { rows: 6, maxlength: 2000, placeholder: 'Particularidades, combinados com o cliente, cuidados…' }, note?.text || '');
  const rows = [];
  const list = h('div', { class: 'stack', style: 'gap:8px' });
  const KIND = { link: 'Link', file: 'Arquivo', folder: 'Pasta' };
  const addRow = (kind, r = {}) => {
    const label = h('input', { type: 'text', value: r.label || '', maxlength: 120, placeholder: 'Nome (opcional)' });
    const val = kind === 'link' ? h('input', { type: 'text', value: r.url || '', placeholder: 'https://…' })
      : pathField({ value: r.path || '', kind: kind === 'file' ? 'file' : 'folder', filter: kind === 'file' ? 'docs' : undefined, title: kind === 'file' ? 'Selecione o arquivo' : 'Selecione a pasta' });
    const el = h('div', { class: 'note-row' }, h('span', { class: 'pill' }, KIND[kind]), label, kind === 'link' ? val : val.el,
      h('button', { type: 'button', class: 'btn xs ghost', 'aria-label': 'Remover anexo', onclick: () => { rows.splice(rows.indexOf(row), 1); el.remove(); } }, '✕'));
    const row = { kind, id: r.id, label, value: () => (kind === 'link' ? val.value.trim() : val.get()), el };
    rows.push(row); list.append(el);
  };
  (note?.refs || []).forEach((r) => addRow(r.kind, r));
  const m = openModal({ title: note ? 'Editar observação' : 'Nova observação', size: 'md',
    body: [field('Título', title), field('Observação', text),
      h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'lbl' }, 'Links, arquivos e pastas'),
        h('div', { class: 'small muted' }, 'O app guarda só o link ou o caminho; não copia nem altera o arquivo ou a pasta. Arquivos: documentos (PDF, Office, texto, imagem, zip…), nunca programas.'),
        list, h('div', { class: 'inline' }, h('button', { type: 'button', class: 'btn sm', onclick: () => addRow('link') }, '+ Link'), h('button', { type: 'button', class: 'btn sm', onclick: () => addRow('file') }, '+ Arquivo'), h('button', { type: 'button', class: 'btn sm', onclick: () => addRow('folder') }, '+ Pasta')))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const refs = rows.filter((r) => r.value()).map((r) => ({ id: r.id, kind: r.kind, label: r.label.value, ...(r.kind === 'link' ? { url: r.value() } : { path: r.value() }) }));
        const saved = note ? await api('PUT', `/api/projects/${p.id}/notes/${note.id}`, { title: title.value, text: text.value, refs })
          : await api('POST', `/api/projects/${p.id}/notes`, { title: title.value, text: text.value, refs });
        m.close(); onSaved(saved); toast('Observação salva.', 'ok');
      }) }, 'Salvar')] });
  (note ? text : title).focus();
}
