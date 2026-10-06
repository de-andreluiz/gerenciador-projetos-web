'use strict';
// UI compartilhada das evidências: janela de envio (escolher, arrastar ou colar), linha com ações, miniatura e preview.
// Usada pelo checklist (checklist.js) e pelas observações do dia (hours-notes.js). Cada quem só informa ONDE a evidência mora
// (url base "…/evidences" e a url de envio); a validação de verdade é sempre do servidor (src/evidence-http.js).

const EV_ICON = { image: '📷', pdf: '📄', file: '📄' };
const evWhen = (iso) => (iso ? fmtDateTime(iso) : '');
const evUrl = (base, v, tail = '') => `${base}/${v.id}${tail}`;

// Envio de UM arquivo: o corpo é o arquivo cru; nome, tipo declarado e descrição vão em cabeçalhos.
async function evUploadTo(url, file, description) {
  const r = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Type': file.type || '', 'X-Description': encodeURIComponent(description || '') }, body: file });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error || `Erro ${r.status}`), { status: r.status });
  return json;
}

function evDownload(url, name) { const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); }

function evPreview(base, v) {
  const m = openModal({ title: v.name, wide: true,
    body: [h('div', { class: 'ck-preview' }, h('img', { src: `${evUrl(base, v, '/file')}?inline=1`, alt: v.name })), h('div', { class: 'small muted' }, `${evWhen(v.at)} · ${fmtSize(v.size)}${v.description ? ` · ${v.description}` : ''}`)],
    footer: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar')] });
}

// Miniatura de uma imagem (clique = preview). Documentos ficam com o ícone.
function evThumb(base, v) {
  if (v.kind === 'image' && v.exists) {
    return h('button', { class: 'ev-thumb', type: 'button', title: `${v.name} — clique para visualizar`, 'aria-label': `Visualizar ${v.name}`, onclick: () => evPreview(base, v) },
      h('img', { src: `${evUrl(base, v, '/file')}?inline=1`, alt: '', loading: 'lazy' }));
  }
  return h('span', { class: 'ck-ev-ic' }, EV_ICON[v.kind] || '📄');
}

// Linha de uma evidência: Visualizar (imagem), Abrir (programa padrão), Baixar e Remover (com confirmação; o arquivo vai para .removidas).
// onRemoved(json) recebe a resposta do servidor depois de remover; removeExtra acrescenta um aviso ao texto da confirmação.
function evRow(base, v, { onRemoved, removeExtra = '', thumb = false } = {}) {
  return h('div', { class: 'ck-ev' },
    thumb ? evThumb(base, v) : h('span', { class: 'ck-ev-ic' }, EV_ICON[v.kind] || '📄'),
    h('div', { class: 'grow stack' }, h('strong', null, v.name),
      h('span', { class: 'small muted' }, `${evWhen(v.at)} · ${fmtSize(v.size)}${v.by ? ` · ${v.by}` : ''}`),
      v.description ? h('span', { class: 'small' }, v.description) : null,
      !v.exists ? h('span', { class: 'pill overdue', style: 'width:fit-content' }, 'arquivo não encontrado') : null),
    h('div', { class: 'actions' },
      v.kind === 'image' && v.exists ? h('button', { class: 'btn xs', onclick: () => evPreview(base, v) }, 'Visualizar') : null,
      v.exists ? [h('button', { class: 'btn xs', title: 'Abrir no programa padrão do Windows', onclick: () => api('POST', evUrl(base, v, '/open'), {}).catch(fail) }, 'Abrir'),
        h('button', { class: 'btn xs', title: 'Salvar uma cópia', onclick: () => evDownload(evUrl(base, v, '/file'), v.name) }, 'Baixar')] : null,
      h('button', { class: 'btn xs ghost', onclick: async () => {
        if (!(await confirmDialog({ title: 'Remover evidência', message: `Remover “${v.name}”?\nO arquivo é movido para a pasta “.removidas” dentro de evidências (não é apagado).${removeExtra}`, okText: 'Remover', danger: true }))) return;
        try { const json = await api('DELETE', evUrl(base, v)); if (onRemoved) onRemoved(json); } catch (e) { fail(e); }
      } }, 'Remover')));
}

// Janela de envio. Opções: title, hint (texto do topo), footNote, accept (extensões, só para o seletor), maxMB,
// canAdd() → texto de limite atingido ou null, upload(file, description) → Promise (o servidor confere tudo de novo), onDone(qtdEnviada).
function evUploadDialog({ title, hint, footNote, accept = [], canAdd, upload, onDone }) {
  const desc = h('input', { type: 'text', maxlength: 300, placeholder: 'Opcional: o que este arquivo comprova' });
  const msg = h('div', { class: 'stack' });
  const input = h('input', { type: 'file', multiple: true, accept: accept.join(','), style: 'display:none' });
  const zone = h('div', { class: 'ck-drop', tabindex: 0, role: 'button' }, h('strong', null, 'Arraste os arquivos aqui'), h('span', { class: 'muted' }, ' ou clique para escolher'),
    h('div', { class: 'small muted' }, 'Também dá para colar uma imagem da área de transferência (Ctrl+V).'));
  const say = (text, cls) => msg.append(h('div', { class: `small ${cls || ''}` }, text));
  let working = false;
  const send = async (list) => {
    if (working) return;
    working = true; msg.replaceChildren(); zone.classList.add('busy');
    let ok = 0;
    for (const f of list) {
      const limit = canAdd ? canAdd() : null;
      if (limit) { say(`${limit}; “${f.name}” não foi enviada.`, 'ck-wait'); break; }
      try { await upload(f, desc.value); ok++; say(`✓ ${f.name}`, 'ck-done'); } catch (e) { say(`✗ ${f.name}: ${e.message}`, 'ck-bad'); }
    }
    working = false; zone.classList.remove('busy');
    if (ok) { if (onDone) onDone(ok); if (!msg.querySelector('.ck-bad, .ck-wait')) { m.close(); toast(ok === 1 ? 'Evidência adicionada.' : `${ok} evidências adicionadas.`); } }
  };
  const named = (f) => { // imagem colada vem como "image.png": dá um nome que ajude depois
    if (f.name && f.name !== 'image.png') return f;
    const d = new Date(); const z = (n) => String(n).padStart(2, '0');
    return new File([f], `captura-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.png`, { type: f.type });
  };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { const fs = [...input.files]; input.value = ''; if (fs.length) send(fs); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) send(fs); });
  const onPaste = (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); send(fs.map(named)); } };
  document.addEventListener('paste', onPaste);
  const m = openModal({ title, size: 'md',
    body: [h('div', { class: 'small muted' }, hint), field('Descrição', desc), zone, input, msg, footNote ? h('div', { class: 'small muted' }, footNote) : null].filter(Boolean),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar')],
    onClose: () => document.removeEventListener('paste', onPaste) });
  zone.focus();
}
