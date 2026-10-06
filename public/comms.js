'use strict';
// Comunicações = GERADOR de e-mails: modelos (Configurações → Comunicações), card do projeto (contatos, modelos, e-mails gerados),
// janela "Gerar e-mail" (prévia → editar só desta geração → copiar) e detalhe de uma geração. Servidor: src/email-api.js.
// A aplicação NÃO envia nada: o usuário copia destinatários / assunto / corpo e cola no Gmail, Outlook ou outro cliente.
// Gerar ou copiar NÃO conclui item de checklist.

const EM = { cat: null };
async function emCatalog(force = false) { if (!EM.cat || force) EM.cat = await api('GET', '/api/email-templates'); return EM.cat; }
const emRoleLabel = (v) => EM.cat?.roles.find((r) => r.key === v)?.label || v;
const emList = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
const emSep = () => uiPref('emailSep', '; '); // separador de destinatários ao copiar (preferência de tela)
const emCopyState = (g) => (g.copied?.length ? h('span', { class: 'ck-done' }, '✓ copiado') : h('span', { class: 'muted' }, 'só gerado'));

// Copia para a área de transferência. Com `html`, o corpo vai também com formatação (negrito/lista/tabela/imagem/link) para colar no Gmail/Outlook.
// Devolve 'rich' (text/html + text/plain), 'text' (só texto: sem ClipboardItem ou plano B) ou false (nada foi copiado).
async function emCopy(text, html) {
  try {
    if (html && window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      return 'rich';
    }
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return 'text'; }
  } catch { /* cai no plano B */ }
  const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' }, text);
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok ? 'text' : false;
}
// Prévia exata do HTML do corpo: iframe isolado (sem scripts, sem acesso à página). O HTML vem do servidor, já escapado.
const emPreview = (html, h2 = 220) => h('iframe', { class: 'em-preview', style: `height:${h2}px`, sandbox: '', title: 'Prévia do corpo do e-mail', srcdoc: `<!doctype html><meta charset="utf-8"><body style="margin:12px;background:#fff">${html}</body>` });

// ---------- Editor de texto rico (corpo do modelo e edição de uma geração) ----------
// contenteditable + document.execCommand: sem biblioteca. O conteúdo é HTML estruturado; QUALQUER HTML que entra (colar) ou sai
// (salvar) passa pela sanitização do servidor (src/html-safe.js) — a tela nunca confia no que o navegador gerou.
const EM_FONTS = ['Arial', 'Verdana', 'Tahoma', 'Georgia', 'Times New Roman', 'Courier New', 'Calibri'];
const EM_SIZES = [['2', 'Pequeno'], ['3', 'Normal'], ['4', 'Médio'], ['5', 'Grande'], ['6', 'Muito grande']];

// Imagem para o e-mail: reduz para no máximo 720 px de largura (leve para colar) antes de enviar ao servidor.
async function emPrepareImage(file) {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) throw new Error('Use uma imagem PNG, JPG ou WEBP.');
  const bmp = await createImageBitmap(file);
  if (bmp.width <= 720 && file.size <= 600 * 1024) return file;
  const w = Math.min(720, bmp.width); const hgt = Math.round(bmp.height * (w / bmp.width));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = hgt;
  const cx = cv.getContext('2d'); cx.drawImage(bmp, 0, 0, w, hgt);
  const png = file.type === 'image/png';
  const blob = await new Promise((ok) => cv.toBlob(ok, png ? 'image/png' : 'image/jpeg', 0.85));
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg'), { type: png ? 'image/png' : 'image/jpeg' });
}

function emRichEditor({ html = '', placeholder = '', onInput } = {}) {
  const ed = h('div', { class: 'em-rich', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Corpo do e-mail', spellcheck: 'true', 'data-placeholder': placeholder });
  ed.innerHTML = html; // vem do servidor, já sanitizado
  let saved = null;
  const keep = () => { const sel = getSelection(); if (sel.rangeCount && ed.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange(); };
  const restore = () => { ed.focus(); if (saved) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(saved); } };
  for (const ev of ['keyup', 'mouseup', 'focusout']) ed.addEventListener(ev, keep);
  ed.addEventListener('input', () => { keep(); onInput && onInput(); });
  // B/I/U/listas geram tags simples (<b>, <i>, <u>); alinhamento, fonte e tamanho usam estilos (permitidos pela sanitização).
  const exec = (cmd, val, css = false) => { restore(); document.execCommand('styleWithCSS', false, css); document.execCommand(cmd, false, val); keep(); onInput && onInput(); };
  const addImage = async (file) => {
    try {
      const f = await emPrepareImage(file);
      const r = await evUploadTo('/api/email-images', f);
      restore(); document.execCommand('insertImage', false, r.url); keep(); onInput && onInput();
    } catch (e) { fail(e); }
  };
  ed.addEventListener('paste', async (e) => {
    const cd = e.clipboardData; if (!cd) return;
    const img = [...(cd.files || [])].find((f) => f.type.startsWith('image/'));
    const htmlText = cd.getData('text/html');
    e.preventDefault();
    if (img) return addImage(img);
    if (htmlText) {
      try {
        const r = await api('POST', '/api/emails/sanitize', { html: htmlText }); document.execCommand('insertHTML', false, r.html);
        const lost = (htmlText.match(/<img\b/gi) || []).length - (r.html.match(/<img\b/gi) || []).length; // imagem externa/sem arquivo não é mantida: avisa em vez de sumir calada
        if (lost > 0) toast(`${lost === 1 ? '1 imagem não foi mantida' : `${lost} imagens não foram mantidas`} (só imagens enviadas pelo botão “Imagem” são suportadas). Use “Imagem” para inserir o arquivo.`, 'error');
      } catch (er) { fail(er); }
    } else document.execCommand('insertText', false, cd.getData('text/plain'));
  });
  // Tabela 3×3 (cabeçalho + 2 linhas) com bordas simples, que sobrevivem ao colar no Gmail. Tab move entre células; Tab na última cria linha.
  const insertTable = () => {
    const cell = (t) => `<${t} style="border:1px solid #999999;padding:4px 8px${t === 'th' ? ';background-color:#eeeeee' : ''}">&nbsp;</${t}>`;
    const row = (t) => `<tr>${cell(t)}${cell(t)}${cell(t)}</tr>`;
    restore(); document.execCommand('insertHTML', false, `<table style="border-collapse:collapse"><tbody>${row('th')}${row('td')}${row('td')}</tbody></table><p><br></p>`); keep(); onInput && onInput();
  };
  ed.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const n = getSelection().anchorNode; const cell = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('td,th');
    if (!cell || !ed.contains(cell)) return;
    e.preventDefault();
    const cells = [...cell.closest('table').querySelectorAll('td,th')];
    let next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)];
    if (!next && !e.shiftKey) { const tr = cell.closest('tr').cloneNode(true); tr.querySelectorAll('td,th').forEach((c) => { c.innerHTML = '&nbsp;'; }); cell.closest('tr').after(tr); next = tr.querySelector('td,th'); onInput && onInput(); }
    if (next) { const r = document.createRange(); r.selectNodeContents(next); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  const tb = (label, title, fn, cls = '') => h('button', { type: 'button', class: `em-tb ${cls}`, title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
  const sel = (title, opts, onpick) => h('select', { class: 'em-tsel', title, 'aria-label': title, onchange: (e) => { const v = e.target.value; e.target.selectedIndex = 0; if (v) onpick(v); } },
    h('option', { value: '' }, title), opts.map(([v, t]) => h('option', { value: v }, t)));
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: () => { if (fileIn.files[0]) addImage(fileIn.files[0]); fileIn.value = ''; } });
  const link = async () => {
    keep();
    const had = saved && !saved.collapsed;
    let url = await promptDialog({ title: 'Inserir link', label: 'Endereço (http://, https:// ou mailto:)', value: 'https://', okText: 'Inserir' });
    if (!url || url === 'https://') return;
    if (!/^(https?:|mailto:)/i.test(url)) url = `https://${url}`;
    restore();
    if (had) document.execCommand('createLink', false, url); else document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/[<>&]/g, '')}</a>`);
    keep(); onInput && onInput();
  };
  const bar = h('div', { class: 'em-toolbar', role: 'toolbar', 'aria-label': 'Formatação' },
    tb(h('b', null, 'N'), 'Negrito (Ctrl+B)', () => exec('bold')), tb(h('i', null, 'I'), 'Itálico (Ctrl+I)', () => exec('italic')), tb(h('u', null, 'S'), 'Sublinhado (Ctrl+U)', () => exec('underline')),
    h('span', { class: 'em-tsep' }),
    sel('Parágrafo', [['<p>', 'Parágrafo'], ['<h2>', 'Título'], ['<h3>', 'Subtítulo']], (v) => exec('formatBlock', v)),
    sel('Fonte', EM_FONTS.map((f) => [f, f]), (v) => exec('fontName', v, true)),
    sel('Tamanho', EM_SIZES, (v) => exec('fontSize', v, true)),
    h('span', { class: 'em-tsep' }),
    tb('• Lista', 'Lista com marcadores', () => exec('insertUnorderedList')), tb('1. Lista', 'Lista numerada', () => exec('insertOrderedList')),
    h('span', { class: 'em-tsep' }),
    tb('⇤', 'Alinhar à esquerda', () => exec('justifyLeft', null, true)), tb('↔', 'Centralizar', () => exec('justifyCenter', null, true)), tb('⇥', 'Alinhar à direita', () => exec('justifyRight', null, true)),
    h('span', { class: 'em-tsep' }),
    tb('Link', 'Inserir link', link), tb('Tabela', 'Inserir tabela (Tab move entre as células)', insertTable), tb('Imagem', 'Inserir imagem (reduzida para até 720 px)', () => fileIn.click()), tb('Limpar', 'Remover a formatação da seleção', () => exec('removeFormat')), fileIn);
  return {
    el: h('div', { class: 'em-richbox' }, bar, ed),
    getHtml: () => ed.innerHTML,
    insertText: (t) => { restore(); document.execCommand('insertText', false, t); keep(); onInput && onInput(); },
    focus: () => ed.focus(),
  };
}

// ---------- Anexos sugeridos (referências a Documentos e Modelos; a aplicação não anexa nem envia nada) ----------
function emAttachmentsPicker(initial) {
  let chosen = new Map((initial || []).map((a) => [a.documentId, a.title]));
  const docs = state.documents || [];
  const known = new Set(docs.map((d) => d.id));
  const list = h('div', { class: 'em-attlist' });
  const draw = () => {
    const missing = [...chosen.entries()].filter(([id]) => !known.has(id));
    list.replaceChildren(...[
      ...missing.map(([id, title]) => h('div', { class: 'em-attrow bad' }, h('span', null, '⚠ ', h('strong', null, title), ' — documento não encontrado (foi excluído de Documentos e Modelos)'),
        h('button', { type: 'button', class: 'btn xs', onclick: () => { chosen.delete(id); draw(); } }, 'Remover referência'))),
      ...docs.map((d) => h('label', { class: `em-attrow${d.source.type === 'file' && d.fileExists === false ? ' warn' : ''}` },
        h('input', { type: 'checkbox', checked: chosen.has(d.id), onchange: (e) => { if (e.target.checked) chosen.set(d.id, d.title); else chosen.delete(d.id); } }),
        h('span', { class: 'grow' }, h('strong', null, d.title), h('span', { class: 'small muted' }, ` · ${d.kind === 'modelo' ? 'modelo' : 'documento'} · ${d.source.type === 'link' ? 'link' : d.source.path.split(/[\\/]/).pop()}`),
          d.source.type === 'file' && d.fileExists === false ? h('span', { class: 'small', style: 'color:var(--warn-text)' }, ' ⚠ arquivo não encontrado') : null))),
    ].filter(Boolean));
    if (!docs.length && !missing.length) list.replaceChildren(h('div', { class: 'small muted' }, 'Nenhum documento cadastrado. Cadastre arquivos em Documentos e Modelos para sugeri-los como anexos.'));
  };
  draw();
  return { el: list, get: () => [...chosen.entries()].map(([documentId, title]) => ({ documentId, title })) };
}

// Anexos sugeridos na janela de geração: abrir o arquivo/pasta rapidamente para arrastar ao e-mail. Nada é anexado pelo app.
function emAttachmentsBlock(list, onEditTemplate) {
  if (!list?.length) return null;
  const run = (fn) => async (e) => { try { await fn(); } catch (er) { fail(er); } };
  return h('div', { class: 'em-row em-attach' }, h('span', { class: 'lbl' }, `Anexos sugeridos (${list.length}) — anexe você mesmo no e-mail`),
    list.map((a) => h('div', { class: `em-attrow${a.problem ? ' warn' : ''}` },
      h('span', { class: 'grow' }, '📎 ', h('strong', null, a.title), a.name && !a.missing ? h('span', { class: 'small muted' }, ` · ${a.name}`) : null,
        a.problem ? h('div', { class: 'small', style: 'color:var(--warn-text)' }, `⚠ ${a.problem}`) : null),
      a.missing ? h('button', { class: 'btn xs', onclick: onEditTemplate }, 'Corrigir no modelo')
        : a.sourceType === 'link' ? [h('button', { class: 'btn xs', onclick: () => window.open(a.url, '_blank', 'noopener') }, 'Abrir link'), h('button', { class: 'btn xs ghost', onclick: run(async () => { if (await emCopy(a.url)) toast('Link copiado.'); }) }, 'Copiar link')]
          : [h('button', { class: 'btn xs', disabled: a.fileMissing, onclick: run(() => api('POST', `/api/documents/${a.documentId}/open`)) }, 'Abrir'),
            h('button', { class: 'btn xs ghost', disabled: a.fileMissing, onclick: run(() => api('POST', `/api/documents/${a.documentId}/open-folder`)) }, 'Abrir localização'),
            h('button', { class: 'btn xs ghost', onclick: run(async () => { if (await emCopy(a.path)) toast('Caminho copiado.'); }) }, 'Copiar caminho')])));
}

// ---------- Configurações → Comunicações ----------
function emailTemplatesCard() {
  const box = h('div', { class: 'stack' }, h('div', { class: 'empty' }, 'Carregando…'));
  const head = h('div', { class: 'inline' });
  const legacy = h('div');
  const draw = async () => {
    let cat;
    try { cat = await emCatalog(true); } catch (e) { box.replaceChildren(h('div', { class: 'box bad' }, e.message)); return; }
    head.replaceChildren(h('button', { class: 'btn sm primary', onclick: () => emTemplateForm(null, draw) }, '+ Novo modelo'));
    const rows = cat.templates.slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'pt-BR'));
    box.replaceChildren(...(rows.length ? rows.map((t) => emTemplateRow(t, draw)) : [h('div', { class: 'empty' }, 'Nenhum modelo ainda. Crie modelos como “Solicitação de Backup” ou “Início da Homologação” e use-os nos projetos e nos itens de checklist.')]));
  };
  draw();
  api('GET', '/api/email-legacy-gmail').then((g) => { if (g.stored) legacy.replaceChildren(emLegacyBox(g, () => legacy.replaceChildren())); }).catch(() => {});
  return card('Modelos de e-mail', head, h('div', { class: 'hint' }, 'A aplicação gera o e-mail (variáveis e destinatários do projeto) e você copia e cola no Gmail/Outlook — ela não envia nada. Alterar um modelo nunca muda o histórico.'), legacy, box);
}
// Resto da integração com o Gmail da versão anterior (já removida): só avisa e deixa o usuário apagar, com confirmação.
function emLegacyBox(g, done) {
  return h('div', { class: 'box warn stack' }, h('strong', null, 'Credenciais do Gmail da versão anterior ainda estão salvas neste computador.'),
    h('div', { class: 'small' }, `${g.account ? `Conta ${g.account}. ` : ''}O app não envia mais e-mails e não usa mais essas credenciais. Você pode apagá-las daqui; a autorização no Google se remove em myaccount.google.com/permissions.`),
    h('div', null, h('button', { class: 'btn sm danger', onclick: async () => {
      if (!(await confirmDialog({ title: 'Remover credenciais do Gmail', message: 'Apagar deste computador o Client ID, o segredo e o token do Gmail salvos? Nada mais é alterado.', okText: 'Remover', danger: true }))) return;
      try { await api('DELETE', '/api/email-legacy-gmail'); toast('Credenciais do Gmail removidas.'); done(); } catch (e) { fail(e); }
    } }, 'Remover credenciais salvas')));
}
function emTemplateRow(t, redraw) {
  const u = t.usage;
  const usage = [u.checklistItems ? plural(u.checklistItems, 'item de checklist', 'itens de checklist') : null, u.generations ? plural(u.generations, 'e-mail gerado', 'e-mails gerados') : null].filter(Boolean).join(' · ');
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); redraw(); } catch (e) { fail(e); } };
  return h('div', { class: `row${t.active ? '' : ' em-off'}` },
    h('div', { class: 'grow stack' },
      h('div', { class: 'inline' }, h('strong', null, t.name), h('span', { class: 'pill' }, t.scope === 'project' ? `Só: ${t.projectName}` : 'Global'), t.active ? null : h('span', { class: 'pill overdue' }, 'Desativado')),
      t.description ? h('span', { class: 'small' }, t.description) : null,
      h('span', { class: 'small muted' }, `Assunto: ${t.subject}`),
      h('span', { class: 'small muted' }, `Para: ${t.to.map(emRoleLabel).join(', ') || '—'}${t.cc.length ? ` · CC: ${t.cc.map(emRoleLabel).join(', ')}` : ''}${usage ? ` · usado em ${usage}` : ''}`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn sm', onclick: () => emTemplateForm(t, redraw) }, 'Editar'),
      h('button', { class: 'btn sm', disabled: !t.active, title: 'Gerar com os dados de um projeto (só mostra a prévia; você copia)', onclick: () => emTestTemplate(t) }, 'Testar'),
      h('button', { class: 'btn sm ghost', onclick: () => act(() => api('POST', `/api/email-templates/${t.id}/duplicate`), 'Modelo duplicado.') }, 'Duplicar'),
      h('button', { class: 'btn sm ghost', onclick: () => act(() => api('PUT', `/api/email-templates/${t.id}`, { active: !t.active }), t.active ? 'Modelo desativado.' : 'Modelo reativado.') }, t.active ? 'Desativar' : 'Ativar'),
      !u.generations && !u.checklistItems && !u.projectItems && !u.projects ? h('button', { class: 'btn sm ghost', onclick: async () => {
        if (await confirmDialog({ title: 'Excluir modelo', message: `Excluir “${t.name}”? Ele nunca foi usado.`, okText: 'Excluir', danger: true })) act(() => api('DELETE', `/api/email-templates/${t.id}`), 'Modelo excluído.');
      } }, 'Excluir') : null));
}
function emTestTemplate(t) {
  const projs = t.scope === 'project' ? state.projects.filter((p) => p.id === t.projectId) : state.projects;
  if (!projs.length) return toast('Cadastre um projeto para testar o modelo.', 'error');
  const sel = h('select', null, projs.map((p) => h('option', { value: p.id }, p.name)));
  const m = openModal({ title: `Testar “${t.name}”`, size: 'sm',
    body: [field('Projeto usado nas variáveis e destinatários', sel, 'Abre a prévia como ficaria nesse projeto. Nada é enviado: você copia o que quiser.')],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => { m.close(); emGenerate(projectById(sel.value), { templateId: t.id }); } }, 'Gerar prévia')] });
}

// Destinatários do modelo: contatos do projeto (papéis) e/ou e-mails fixos.
function emRecipientsEditor(initial) {
  let list = [...(initial || [])];
  const chips = h('div', { class: 'em-chips' });
  const roleSel = h('select', { 'aria-label': 'Adicionar contato do projeto', onchange: () => { if (roleSel.value && !list.includes(roleSel.value)) { list.push(roleSel.value); draw(); } roleSel.value = ''; } },
    h('option', { value: '' }, '+ Contato do projeto…'), EM.cat.roles.map((r) => h('option', { value: r.key }, r.label)));
  const mail = h('input', { type: 'text', placeholder: '+ e-mail fixo (Enter)', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addMail(); } }, onblur: () => addMail() });
  const addMail = () => { for (const v of emList(mail.value)) if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v); mail.value = ''; draw(); };
  const draw = () => chips.replaceChildren(...(list.length ? list.map((v) => h('span', { class: `em-chip${v.startsWith('role:') ? ' role' : ''}` }, emRoleLabel(v),
    h('button', { type: 'button', 'aria-label': `Remover ${emRoleLabel(v)}`, onclick: () => { list = list.filter((x) => x !== v); draw(); } }, '✕'))) : [h('span', { class: 'small muted' }, 'ninguém')]));
  draw();
  return { el: h('div', { class: 'stack' }, chips, h('div', { class: 'em-addrow' }, roleSel, mail)), get: () => { addMail(); return list; } };
}

async function emTemplateForm(t, onSaved) {
  try { await emCatalog(true); } catch (e) { return fail(e); }
  const name = h('input', { type: 'text', value: t?.name || '', maxlength: 80, placeholder: 'Ex.: Solicitação de Backup' });
  const desc = h('input', { type: 'text', value: t?.description || '', maxlength: 300, placeholder: 'Quando usar este modelo (opcional)' });
  const scope = h('select', { onchange: () => { projField.style.display = scope.value === 'project' ? '' : 'none'; } },
    h('option', { value: 'global', selected: t?.scope !== 'project' }, 'Global (reutilizável; pode ir em itens de checklist)'), h('option', { value: 'project', selected: t?.scope === 'project' }, 'Específico de um projeto'));
  const projSel = h('select', null, state.projects.map((p) => h('option', { value: p.id, selected: t?.projectId === p.id }, p.name)));
  const active = h('input', { type: 'checkbox', checked: t ? t.active : true });
  const to = emRecipientsEditor(t?.to || ['role:stakeholders']);
  const cc = emRecipientsEditor(t?.cc || []);
  const bcc = emRecipientsEditor(t?.bcc || []);
  const subject = h('input', { type: 'text', value: t?.subject || '[{{project.name}}] ', maxlength: 250 });
  // Corpo rico: o modelo guarda HTML sanitizado; modelo antigo (texto simples) abre convertido, com o mesmo visual (editHtml).
  const editor = emRichEditor({ html: t?.editHtml || '', placeholder: 'Escreva o corpo do e-mail… use as variáveis, ex.: {{project.name}}' });
  let target = 'body'; // onde a variável clicada entra
  subject.addEventListener('focus', () => { target = 'subject'; });
  editor.el.addEventListener('focusin', () => { target = 'body'; });
  const insert = (key) => {
    const v = `{{${key}}}`;
    if (target === 'body') return editor.insertText(v);
    const el = subject; const s0 = el.selectionStart ?? el.value.length; const e0 = el.selectionEnd ?? s0;
    el.value = el.value.slice(0, s0) + v + el.value.slice(e0); el.focus(); el.setSelectionRange(s0 + v.length, s0 + v.length);
  };
  const attach = emAttachmentsPicker(t?.attachments);
  const groups = [...new Set(EM.cat.variables.map((v) => v.group))];
  const vars = h('div', { class: 'em-vars' }, h('strong', { class: 'small' }, 'Variáveis disponíveis'), h('span', { class: 'small muted' }, 'Clique para inserir no assunto ou no corpo (onde estiver o cursor). Funcionam dentro do texto formatado.'),
    groups.map((g) => [h('div', { class: 'em-vgroup' }, g), EM.cat.variables.filter((v) => v.group === g).map((v) => h('button', { type: 'button', class: 'em-var', title: v.label, onclick: () => insert(v.key) }, `{{${v.key}}}`, h('span', null, v.label)))]));
  const projField = field('Projeto', projSel);
  projField.style.display = scope.value === 'project' ? '' : 'none';
  const m = openModal({ title: t ? `Editar modelo — ${t.name}` : 'Novo modelo de e-mail', wide: true,
    body: [h('div', { class: 'em-editor' },
      h('div', { class: 'stack', style: 'gap:12px' },
        h('div', { class: 'cols2' }, field('Nome', name), field('Descrição', desc)),
        h('div', { class: 'cols2' }, field('Uso', scope), projField),
        field('Para', to.el), h('div', { class: 'cols2' }, field('CC', cc.el), field('CCO (cópia oculta)', bcc.el)),
        field('Assunto', subject),
        field('Corpo', editor.el, 'Formate como no e-mail (negrito, listas, links, alinhamento, imagens). As variáveis funcionam dentro do texto formatado; ao copiar o corpo, a formatação vai junto.'),
        field('Anexos sugeridos', attach.el, 'Documentos de “Documentos e Modelos” que normalmente acompanham este e-mail. A aplicação só guarda a referência e ajuda a abrir os arquivos: você anexa no Gmail/Outlook.'),
        h('label', { class: 'check' }, active, ' Modelo ativo (desativado não aparece para gerar e-mails novos; o histórico continua)')),
      vars)],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => {
        const payload = { name: name.value, description: desc.value, scope: scope.value, projectId: scope.value === 'project' ? projSel.value : null, active: active.checked,
          to: to.get(), cc: cc.get(), bcc: bcc.get(), subject: subject.value, bodyHtml: editor.getHtml(), attachments: attach.get() };
        await (t ? api('PUT', `/api/email-templates/${t.id}`, payload) : api('POST', '/api/email-templates', payload));
        m.close(); toast('Modelo salvo.'); onSaved && onSaved();
      }) }, 'Salvar')] });
  name.focus();
}

function emailHistoryCard() {
  // Secundário: começa recolhido (contagem + “Ver histórico”); a escolha é lembrada.
  const box = h('div', null);
  let list = null; let open = uiPref('emHistOpen', false);
  const draw = () => {
    if (!list) return;
    const head = h('button', { type: 'button', class: 'em-recent-head', 'aria-expanded': String(open), onclick: () => { open = !open; setUiPref('emHistOpen', open); draw(); } },
      icon(open ? 'chevronDown' : 'chevronRight', 14), h('span', { class: 'em-recent-t' }, 'Histórico'), h('span', { class: 'em-count' }, String(list.length)),
      list[0] ? h('span', { class: 'small muted em-recent-last' }, `último: ${list[0].templateName || list[0].subject} · ${fmtDateTime(list[0].at)}`) : null,
      h('span', { class: 'btn xs ghost' }, open ? 'Recolher' : 'Ver histórico'));
    box.replaceChildren(...[head, open ? (list.length ? h('div', { class: 'tablewrap tall' }, h('table', null,
      h('thead', null, h('tr', null, ['Gerado em', 'Projeto', 'Modelo', 'Assunto', 'Situação'].map((x) => h('th', null, x)))),
      h('tbody', null, list.map((s) => h('tr', { class: 'em-histrow', onclick: () => emGenerationDialog(s.id) },
        h('td', null, fmtDateTime(s.at)), h('td', null, s.projectName), h('td', null, s.templateName || '—'), h('td', { class: 'clip', title: s.subject }, s.subject), h('td', null, emCopyState(s)))))))
      : h('div', { class: 'empty' }, 'Nenhum e-mail gerado ainda.')) : null].filter(Boolean));
  };
  api('GET', '/api/email-generations').then((l) => { list = l; draw(); }).catch((e) => box.replaceChildren(h('div', { class: 'box bad' }, e.message)));
  return card('E-mails gerados', null, h('div', { class: 'hint' }, 'Registro de quando um e-mail foi gerado e do que foi copiado. A aplicação não sabe se você chegou a enviá-lo.'), box);
}

// ---------- Janela "Gerar e-mail": prévia → (editar só desta geração) → copiar ----------
// src = { templateId } (a partir do projeto) ou { stepId, itemId } (item do checklist).
// Fluxo único: modelo (HTML sanitizado) → variáveis resolvidas no servidor → d.html (prévia) = o que vai para a área de transferência.
async function emGenerate(p, src) {
  let d;
  try { d = await api('POST', `/api/projects/${p.id}/emails/generate`, src); } catch (e) { return fail(e); }
  commsRefresh(p.id);
  const st = { to: [...d.to], cc: [...d.cc], bcc: [...d.bcc], subject: d.subject, bodyHtml: d.bodyHtml, html: d.html };
  const first = JSON.stringify([st.to, st.cc, st.bcc, st.subject]);
  let editing = false; let bodyDirty = false;
  let plain = d.text; // texto puro do corpo, já pronto: copiar não espera a rede (a cópia precisa acontecer dentro do clique)
  let editor = null;
  let pending = null;
  const content = h('div', { class: 'em-compose' });
  const foot = h('div', { class: 'em-foot' });
  const m = openModal({ title: d.template.name, size: 'md', body: [content], footer: [foot] });
  const edited = () => bodyDirty || JSON.stringify([st.to, st.cc, st.bcc, st.subject]) !== first;
  const join = (list) => list.join(emSep());
  let renderTimer = null;
  // Sanitiza e recalcula prévia/texto a partir do que está no editor (mesmo HTML que será copiado).
  const refresh = async () => { if (!editor) return; try { const r = await api('POST', '/api/emails/render', { bodyHtml: editor.getHtml() }); st.bodyHtml = r.bodyHtml; st.html = r.html; plain = r.text; } catch { /* mantém a anterior */ } };
  const rerender = () => { bodyDirty = true; clearTimeout(renderTimer); pending = new Promise((ok) => { renderTimer = setTimeout(async () => { await refresh(); pending = null; ok(); }, 300); }); };
  const flush = async () => { if (pending) { clearTimeout(renderTimer); await refresh(); pending = null; } };
  const editTemplate = async () => {
    try { const t = (await emCatalog(true)).templates.find((x) => x.id === d.template.id); if (!t) throw new Error('Modelo não encontrado.'); m.close(); emTemplateForm(t, () => {}); } catch (e) { fail(e); }
  };

  // Copia e avisa o servidor só para o histórico (com os valores finais, já editados).
  async function copy(what, label, { asText = false } = {}) {
    await flush();
    const f = { to: join(st.to), cc: join(st.cc), bcc: join(st.bcc) };
    let text; let html = null;
    if (what === 'body') { text = plain; html = asText ? null : st.html; }
    else if (what === 'all') {
      const att = (d.attachments || []).filter((a) => !a.missing).map((a) => `- ${a.name || a.title}`);
      text = [f.to ? `Para:\n${f.to}` : null, f.cc ? `CC:\n${f.cc}` : null, f.bcc ? `BCC:\n${f.bcc}` : null, `Assunto:\n${st.subject}`, `Corpo:\n\n${plain}`, att.length ? `Anexos sugeridos:\n${att.join('\n')}` : null].filter(Boolean).join('\n\n');
    } else text = what === 'subject' ? st.subject : f[what];
    if (!text) return toast(`${label}: nada para copiar.`, 'error');
    if (!(await emCopy(text, html))) return toast('Não foi possível copiar. Selecione o texto e use Ctrl+C.', 'error');
    toast(`${label} copiado${what === 'body' && !asText ? ' (com formatação)' : ''}.`);
    api('POST', `/api/email-generations/${d.generationId}/copied`, { what, to: st.to, cc: st.cc, bcc: st.bcc, subject: st.subject, bodyHtml: st.bodyHtml, edited: edited() }).catch(() => {});
  }
  // “Abrir no Gmail”: (1) corpo rico → área de transferência (text/html + text/plain), (2) URL de composição (Para/CC/CCO/Assunto) montada no
  // servidor — o corpo NUNCA vai na URL, (3) abre o Gmail no navegador padrão. Nada é enviado nem automatizado: o usuário cola (Ctrl+V), anexa e envia.
  const gmailBox = h('div');
  const GMAIL_OK = 'Gmail aberto. O corpo formatado foi copiado para a área de transferência. Cole-o no corpo da mensagem com Ctrl+V.';
  const GMAIL_NOCLIP = 'O Gmail foi aberto, mas não foi possível copiar o conteúdo formatado. Utilize “Copiar corpo formatado” para tentar novamente.';
  async function openInGmail(btn) {
    btn.disabled = true;
    try {
      await flush();
      const how = await emCopy(plain, st.html); // logo após o clique (a cópia exige gesto do usuário)
      const g = await api('POST', '/api/emails/gmail-url', { to: st.to, cc: st.cc, bcc: st.bcc, subject: st.subject });
      let opened = true;
      try { window.open(g.url, '_blank', 'noopener'); } catch { opened = false; } // no desktop o Electron encaminha https ao navegador padrão
      const rich = how === 'rich';
      const msg = opened ? (rich ? GMAIL_OK : GMAIL_NOCLIP) : `Não foi possível abrir o navegador automaticamente. ${rich ? 'O corpo formatado foi copiado.' : 'O conteúdo formatado também não foi copiado.'} Use o link abaixo.`;
      toast(opened ? msg : 'Não foi possível abrir o navegador. Use o link “Abrir o Gmail de novo”.', opened && rich ? 'ok' : 'error');
      gmailBox.replaceChildren(h('div', { class: `box small stack${opened && rich ? ' ok-box' : ' warn'}` }, h('strong', null, msg),
        g.warnings.length ? h('ul', null, g.warnings.map((w) => h('li', null, `⚠ ${w}`))) : null,
        (d.attachments || []).length ? h('span', null, 'Anexe você mesmo os arquivos sugeridos antes de enviar.') : null,
        h('a', { href: g.url, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir o Gmail de novo')));
      api('POST', `/api/email-generations/${d.generationId}/copied`, { what: 'gmail', to: st.to, cc: st.cc, bcc: st.bcc, subject: st.subject, bodyHtml: st.bodyHtml, edited: edited() }).catch(() => {});
    } catch (e) { fail(e); } finally { btn.disabled = false; }
  }
  const row = (label, what, valueEl, hide, extra) => (hide ? null : h('div', { class: 'em-row' }, h('div', { class: 'em-rowhead' }, h('span', { class: 'lbl' }, label), h('span', { class: 'inline', style: 'gap:4px' }, extra || null, h('button', { class: 'btn xs', onclick: () => copy(what, label === 'Mensagem' ? 'Corpo' : label) }, what === 'body' ? 'Copiar corpo formatado' : 'Copiar'))), valueEl));
  const val = (text, empty) => (text ? h('div', { class: 'em-val' }, text) : h('div', { class: 'em-val muted' }, empty));

  function draw() {
    const warn = [...d.warnings, ...(d.unknownVariables.length ? [`Variáveis desconhecidas ficaram no texto: ${d.unknownVariables.map((k) => `{{${k}}}`).join(', ')}.`] : [])];
    const warnBox = warn.length ? h('div', { class: 'box warn small stack' }, h('strong', null, 'Confira antes de copiar'), h('ul', null, warn.map((w) => h('li', null, w.startsWith('⚠') ? w : `⚠ ${w}`)))) : null;
    const sep = h('select', { class: 'em-sep', 'aria-label': 'Separador de destinatários', title: 'Separador usado ao copiar os destinatários', onchange: (e) => { setUiPref('emailSep', e.target.value); draw(); } },
      h('option', { value: '; ', selected: emSep() === '; ' }, 'Separar com ;'), h('option', { value: ', ', selected: emSep() === ', ' }, 'Separar com ,'));
    const origin = [d.checklist ? `Item: ${d.checklist.itemTitle} (${d.checklist.stageName})` : null, `Projeto: ${p.name}`].filter(Boolean).join(' · ');
    let rows;
    if (editing) {
      const lst = (k) => h('input', { type: 'text', value: st[k].join(', '), 'aria-label': k, oninput: (e) => { st[k] = emList(e.target.value); } });
      editor = emRichEditor({ html: st.bodyHtml, onInput: rerender });
      rows = [h('div', { class: 'em-row' }, h('span', { class: 'lbl' }, 'Para'), lst('to')), h('div', { class: 'cols2' }, h('div', { class: 'em-row' }, h('span', { class: 'lbl' }, 'CC'), lst('cc')), h('div', { class: 'em-row' }, h('span', { class: 'lbl' }, 'BCC'), lst('bcc'))),
        h('div', { class: 'em-row' }, h('span', { class: 'lbl' }, 'Assunto'), h('input', { type: 'text', value: st.subject, maxlength: 250, oninput: (e) => { st.subject = e.target.value; } })),
        h('div', { class: 'em-row' }, h('span', { class: 'lbl' }, 'Corpo'), editor.el),
        h('div', { class: 'hint' }, 'Ajustes só desta geração — o modelo não muda. Para mudar o modelo, use “Editar modelo”.')];
    } else {
      editor = null;
      rows = [row('Para', 'to', val(join(st.to), '— nenhum destinatário —')), row('CC', 'cc', val(join(st.cc)), !st.cc.length), row('BCC', 'bcc', val(join(st.bcc)), !st.bcc.length),
        row('Assunto', 'subject', val(st.subject, '—')),
        row('Mensagem', 'body', emPreview(st.html, 240), false, h('button', { class: 'btn xs ghost', title: 'Copia só o texto, sem formatação', onclick: () => copy('body', 'Corpo', { asText: true }) }, 'como texto')),
        emAttachmentsBlock(d.attachments, editTemplate)];
    }
    content.replaceChildren(...[h('div', { class: 'inline' }, h('span', { class: 'small muted grow' }, origin), editing ? null : sep), warnBox, gmailBox, ...rows].filter(Boolean));
    foot.replaceChildren(h('button', { class: 'btn primary em-gmail', title: 'Copia o corpo formatado e abre a composição do Gmail no navegador (você cola, anexa e envia)', onclick: (e) => openInGmail(e.currentTarget) }, icon('external', 14), 'Abrir no Gmail'),
      h('button', { class: 'btn', title: 'Copia o corpo com formatação (text/html + texto) para colar no Gmail/Outlook', onclick: () => copy('body', 'Corpo') }, 'Copiar corpo formatado'),
      h('button', { class: 'btn', onclick: () => copy('all', 'Tudo') }, 'Copiar tudo'),
      h('button', { class: 'btn', onclick: async () => { if (editing) { await flush(); if (editor) { await refresh(); } } editing = !editing; draw(); } }, editing ? 'Ver prévia' : 'Editar'),
      h('button', { class: 'btn ghost', title: 'Muda o modelo permanente (não esta geração)', onclick: editTemplate }, 'Editar modelo'),
      h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'));
  }
  draw();
}

// Detalhe de uma geração do histórico (fotografia; não muda se o modelo mudar).
async function emGenerationDialog(id) {
  let s;
  try { s = await api('GET', `/api/email-generations/${id}`); } catch (e) { return fail(e); }
  const p = projectById(s.projectId);
  const m = openModal({ title: `E-mail gerado — ${s.subject}`, size: 'md',
    body: [h('div', { class: 'inline' }, emCopyState(s), h('span', { class: 'small muted' }, `gerado em ${fmtDateTime(s.at)}${s.copiedAt ? ` · copiado em ${fmtDateTime(s.copiedAt)}` : ''}`), s.edited ? h('span', { class: 'pill' }, 'ajustado antes de copiar') : null),
      h('div', { class: 'small muted' }, 'Registro do que foi gerado/copiado. Não indica envio: a aplicação não envia e-mails.'),
      h('dl', { class: 'em-head' },
        h('dt', null, 'Projeto'), h('dd', null, s.projectName), h('dt', null, 'Modelo'), h('dd', null, s.templateName || '—'),
        s.checklist ? [h('dt', null, 'Item'), h('dd', null, `${s.checklist.itemTitle} (${s.checklist.stageName})`)] : null,
        h('dt', null, 'Para'), h('dd', null, s.to.join('; ') || '—'),
        s.cc.length ? [h('dt', null, 'CC'), h('dd', null, s.cc.join('; '))] : null, s.bcc.length ? [h('dt', null, 'BCC'), h('dd', null, s.bcc.join('; '))] : null,
        h('dt', null, 'Assunto'), h('dd', null, h('strong', null, s.subject))),
      emPreview(s.html, 200),
      emAttachmentsBlock(s.attachmentsInfo, () => {})],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'),
      p && s.templateId ? h('button', { class: 'btn primary', title: 'Gera de novo a partir do modelo atual e dos dados atuais do projeto', onclick: () => { m.close(); emGenerate(p, s.checklist ? { stepId: s.checklist.stepId, itemId: s.checklist.itemId } : { templateId: s.templateId }); } }, 'Gerar novamente') : null] });
}

// ---------- Card do projeto ----------
function commsRefresh(projectId) {
  const slot = document.querySelector(`[data-slot="comms"][data-project="${projectId}"]`);
  if (slot) slot.replaceChildren(projectCommsCard(projectById(projectId)));
}
function projectCommsCard(p) {
  const body = h('div', { class: 'stack', style: 'gap:14px' }, h('div', { class: 'empty' }, 'Carregando…'));
  const head = h('div', { class: 'inline' });
  const redraw = (r) => {
    head.replaceChildren(h('button', { class: 'btn sm primary', disabled: !r.available.length, title: r.available.length ? 'Escolhe um modelo e mostra o e-mail pronto para copiar' : 'Nenhum modelo disponível para este projeto', onclick: () => emNewCommunication(p, r) }, 'Gerar e-mail'));
    const kind = (k) => r.contactKinds[k] || k;
    const contacts = h('div', { class: 'stack' }, h('div', { class: 'inline' }, h('span', { class: 'lbl' }, 'Contatos do projeto'), h('button', { class: 'btn xs', onclick: () => emContactForm(p, null, redraw) }, '+ Contato'),
      h('span', { class: 'small muted' }, 'Coordenador e analista vêm do cadastro de Responsáveis.')),
    r.contacts.length ? r.contacts.map((c) => h('div', { class: 'inline small' }, h('strong', null, c.name), h('span', { class: 'pill' }, kind(c.kind)), c.role ? h('span', { class: 'muted' }, c.role) : null,
      c.email ? h('span', { class: 'mono' }, c.email) : h('span', { class: 'ck-wait' }, 'sem e-mail'),
      h('button', { class: 'btn xs ghost', onclick: () => emContactForm(p, c, redraw) }, 'Editar'),
      h('button', { class: 'btn xs ghost', onclick: async () => { if (await confirmDialog({ title: 'Remover contato', message: `Remover ${c.name} dos contatos do projeto? O histórico não muda.`, okText: 'Remover', danger: true })) { try { const x = await api('DELETE', `/api/projects/${p.id}/contacts/${c.id}`); replaceProjectQuiet(x.project); redraw(x); } catch (e) { fail(e); } } } }, 'Remover')))
      : h('span', { class: 'small muted' }, 'Nenhum contato. Cadastre stakeholders e contatos do cliente para usá-los como destinatários.'));
    const models = h('div', { class: 'stack' }, h('div', { class: 'inline' }, h('span', { class: 'lbl' }, 'Modelos disponíveis'), h('span', { class: 'small muted' }, r.selection === null ? 'todos os modelos globais ativos' : 'selecionados para este projeto'),
      h('button', { class: 'btn xs', onclick: () => emChooseTemplates(p, r, redraw) }, 'Escolher modelos…')),
    h('div', { class: 'chips' }, r.available.length ? r.available.map((t) => h('span', { class: 'pill', title: t.description || '' }, t.name)) : h('span', { class: 'small muted' }, 'Nenhum — crie modelos em Configurações → Comunicações.')));
    // Secundário: recolhido por padrão (contagem + último); expandido mostra os 5 mais recentes e “Ver todos”.
    let showAll = false; let open = uiPref('emRecentOpen', false);
    const gensBox = h('div', { class: 'stack' });
    const drawGens = () => {
      const n = r.generations.length;
      const last = r.generations[0];
      const head = h('button', { type: 'button', class: 'em-recent-head', 'aria-expanded': String(open), disabled: !n, onclick: () => { open = !open; setUiPref('emRecentOpen', open); drawGens(); } },
        icon(open ? 'chevronDown' : 'chevronRight', 14), h('span', { class: 'em-recent-t' }, 'E-mails gerados recentemente'), h('span', { class: 'em-count' }, String(n)),
        last ? h('span', { class: 'small muted em-recent-last' }, `último: ${last.templateName || last.subject} · ${fmtDateTime(last.at)}`) : h('span', { class: 'small muted' }, 'nenhum ainda'),
        n ? h('span', { class: 'btn xs ghost' }, open ? 'Recolher' : 'Ver recentes') : null);
      const rows = open ? [...(showAll ? r.generations : r.generations.slice(0, 5)).map((s) => h('button', { class: 'em-sendrow', onclick: () => emGenerationDialog(s.id) },
        h('span', { class: 'small muted' }, fmtDateTime(s.at)), h('span', { class: 'grow' }, s.templateName || s.subject, s.checklist ? h('span', { class: 'small muted' }, ` · item: ${s.checklist.itemTitle}`) : null), emCopyState(s))),
      n > 5 ? h('button', { class: 'btn xs ghost', onclick: () => { showAll = !showAll; drawGens(); } }, showAll ? 'Mostrar menos' : `Ver todos (${n})`) : null] : [];
      gensBox.replaceChildren(...[head, ...rows].filter(Boolean));
    };
    drawGens();
    body.replaceChildren(contacts, models, gensBox);
  };
  api('GET', `/api/projects/${p.id}/emails`).then(redraw).catch((e) => body.replaceChildren(h('div', { class: 'box bad' }, e.message)));
  return card('Comunicações', head, body);
}
function emNewCommunication(p, r) {
  const m = openModal({ title: 'Gerar e-mail', size: 'md',
    body: [h('div', { class: 'small muted' }, 'Escolha o modelo. A próxima tela mostra o e-mail pronto, com os dados do projeto, para você copiar e colar no Gmail/Outlook.'),
      h('div', { class: 'stack' }, r.available.map((t) => h('button', { class: 'em-pick', onclick: () => { m.close(); emGenerate(p, { templateId: t.id }); } }, h('strong', null, t.name), t.description ? h('span', { class: 'small muted' }, t.description) : null)))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar')] });
}
function emChooseTemplates(p, r, redraw) {
  const all = h('input', { type: 'radio', name: 'em-sel', checked: r.selection === null, onchange: () => sync() });
  const some = h('input', { type: 'radio', name: 'em-sel', checked: r.selection !== null, onchange: () => sync() });
  const chosen = new Set(r.selection || r.globals.filter((t) => t.active).map((t) => t.id));
  const list = h('div', { class: 'ck-scripts' }, r.globals.map((t) => h('label', { class: 'ck-check' }, h('input', { type: 'checkbox', checked: chosen.has(t.id), onchange: (e) => { if (e.target.checked) chosen.add(t.id); else chosen.delete(t.id); } }),
    ` ${t.name}`, t.active ? null : h('span', { class: 'small muted' }, ' (desativado)'))));
  const sync = () => { list.style.display = some.checked ? '' : 'none'; };
  sync();
  const m = openModal({ title: `Modelos de e-mail — ${p.name}`, size: 'md',
    body: [h('label', { class: 'check' }, all, ' Todos os modelos globais ativos (padrão)'), h('label', { class: 'check' }, some, ' Só os selecionados:'), list,
      h('div', { class: 'hint' }, 'Modelos específicos deste projeto sempre aparecem. Itens de checklist com modelo associado continuam podendo usá-lo.')],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => {
      const x = await api('PUT', `/api/projects/${p.id}/email-templates`, { ids: all.checked ? null : [...chosen] });
      replaceProjectQuiet(x.project); m.close(); redraw(x);
    }) }, 'Salvar')] });
}
function emContactForm(p, c, redraw) {
  const name = h('input', { type: 'text', value: c?.name || '', maxlength: 120 });
  const email = h('input', { type: 'text', value: c?.email || '', maxlength: 200, placeholder: 'nome@cliente.com' });
  const kind = h('select', null, Object.entries(EM.cat?.contactKinds || { stakeholder: 'Stakeholder', client: 'Cliente', other: 'Outro' }).map(([k, l]) => h('option', { value: k, selected: (c?.kind || 'stakeholder') === k }, l)));
  const role = h('input', { type: 'text', value: c?.role || '', maxlength: 120, placeholder: 'Ex.: Gerente de TI' });
  const m = openModal({ title: c ? 'Editar contato' : 'Novo contato do projeto', size: 'md',
    body: [h('div', { class: 'cols2' }, field('Nome', name), field('E-mail', email)), h('div', { class: 'cols2' }, field('Tipo', kind, 'Stakeholder e Cliente viram destinatários dos modelos.'), field('Cargo', role))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => {
      const b = { name: name.value, email: email.value, kind: kind.value, role: role.value };
      const x = await (c ? api('PUT', `/api/projects/${p.id}/contacts/${c.id}`, b) : api('POST', `/api/projects/${p.id}/contacts`, b));
      replaceProjectQuiet(x.project); m.close(); redraw(x);
    }) }, 'Salvar')] });
  name.focus();
}
