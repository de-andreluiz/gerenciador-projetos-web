// HTML do corpo dos e-mails (rich text) — sanitização por LISTA DE PERMISSÃO, sem dependências, e conversão para texto puro.
// O corpo do modelo é HTML estruturado vindo do editor da tela (contenteditable) ou de um colar; NADA que não esteja na lista passa:
//  - tags: negrito/itálico/sublinhado/tachado, parágrafos/divs/spans, títulos h1–h3, listas, tabelas, citação, linha horizontal, quebra, link e imagem;
//  - atributos: href (http/https/mailto), title; img: src (data:image base64 ou /api/email-images/<id>), alt, width, height; style filtrado;
//  - style: só alinhamento, tamanho/família de fonte (lista), cor, negrito/itálico/sublinhado e, para tabelas, borda/espaçamento/largura simples — nada de url(), expression(), position…
//  - script, style, iframe, object, embed, svg, form, input, comentários, eventos (onclick…) e javascript:/data: não-imagem são descartados.
// A saída é bem formada (tags balanceadas) e já escapada; sanitize() é idempotente (sanitizar o resultado não muda nada).
const ALLOWED = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'blockquote', 'hr', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
const VOID = new Set(['br', 'hr', 'img']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'textarea', 'select', 'option', 'title', 'head', 'form', 'frameset', 'applet', 'audio', 'video', 'canvas']);
const MAX_HTML = 120000;
const FONTS = ['arial', 'verdana', 'tahoma', 'georgia', 'times new roman', 'courier new', 'calibri', 'helvetica', 'trebuchet ms', 'segoe ui', 'sans-serif', 'serif', 'monospace'];
const SIZE_WORDS = new Set(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large']);
const IMG_REF = /^\/api\/email-images\/[a-f0-9]{12}$/;
const IMG_DATA = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
// Decodifica entidades (usado ANTES de checar esquemas de URL, para não deixar "jav&#x61;script:" passar).
function decode(s) {
  return String(s).replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, hex, dec, name) => {
    if (hex || dec) { const c = parseInt(hex || dec, hex ? 16 : 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
    return name.toLowerCase() in NAMED ? NAMED[name.toLowerCase()] : m;
  });
}

function safeUrl(v) {
  const u = decode(v).replace(/[\u0000-\u001f\u007f\s]+/g, '');
  return /^(https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i.test(u) ? u : null;
}
function safeImg(v) {
  const u = decode(v).replace(/[\u0000-\u001f\u007f\s]+/g, '');
  return IMG_REF.test(u) || IMG_DATA.test(u) ? u : null;
}
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;
const BORDER_COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|black|white|gray|grey|silver|red|green|blue|orange|navy|teal|maroon|windowtext)$/i;
const LEN = '(?:\\d{1,2}(?:\\.\\d{1,2})?|\\.\\d{1,2})(?:px|pt)?';
const BORDER_VAL = new RegExp('^(?:(' + LEN.replace('(?:px|pt)?', '(?:px|pt)') + ')\\s+)?(solid|dashed|dotted|double|none)(?:\\s+(#[0-9a-f]{3,6}|rgb\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*\\)|[a-z]+))?$');
const PAD_VAL = new RegExp('^' + LEN + '(?:\\s+' + LEN + '){0,3}$');
function safeBorder(val) {
  const m = BORDER_VAL.exec(val.replace(/\s+/g, ' '));
  if (!m) return null;
  if (m[3] && !BORDER_COLOR.test(m[3])) return null;
  return val.replace(/\s+/g, ' ').replace(/windowtext/g, '#000000').replace(/(rgb\()\s*/g, '$1').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')');
}
function safeSize(val) {
  const m = /^(\d{1,4}(?:\.\d{1,2})?)(px|pt|%)$/.exec(val);
  if (!m) return false;
  const n = parseFloat(m[1]);
  return m[2] === '%' ? n > 0 && n <= 100 : n > 0 && n <= 2000;
}
function safeStyle(v) {
  const out = [];
  for (const part of decode(v).split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim().toLowerCase().replace(/!important/g, '').trim();
    if (!val || /[\\<>{}]|url\(|expression|javascript|@/.test(val)) continue;
    if (prop === 'text-align' && /^(left|right|center|justify)$/.test(val)) out.push(`text-align:${val}`);
    else if (prop === 'font-size' && (SIZE_WORDS.has(val) || /^(\d{1,2}(\.\d)?)(px|pt)$/.test(val) && parseFloat(val) >= 8 && parseFloat(val) <= 48)) out.push(`font-size:${val}`);
    else if (prop === 'font-family') {
      const fams = val.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      if (fams.length && fams.every((x) => FONTS.includes(x))) out.push(`font-family:${fams.map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(', ')}`);
    } else if ((prop === 'color' || prop === 'background-color') && COLOR.test(val)) out.push(`${prop}:${val.replace(/\s+/g, '')}`);
    else if (prop === 'font-weight' && /^(bold|normal|[1-9]00)$/.test(val)) out.push(`font-weight:${val}`);
    else if (prop === 'font-style' && /^(italic|normal)$/.test(val)) out.push(`font-style:${val}`);
    else if ((prop === 'text-decoration' || prop === 'text-decoration-line') && /^(underline|line-through|none)$/.test(val)) out.push(`text-decoration:${val}`);
    else if (/^border(-(top|right|bottom|left))?$/.test(prop)) { const b = safeBorder(val); if (b) out.push(`${prop}:${b}`); }
    else if (prop === 'border-collapse' && /^(collapse|separate)$/.test(val)) out.push(`border-collapse:${val}`);
    else if (/^padding(-(top|right|bottom|left))?$/.test(prop) && PAD_VAL.test(val)) out.push(`${prop}:${val}`);
    else if ((prop === 'width' || prop === 'height') && safeSize(val)) out.push(`${prop}:${val}`);
    else if (prop === 'vertical-align' && /^(top|middle|bottom|baseline)$/.test(val)) out.push(`vertical-align:${val}`);
  }
  return out.join(';');
}

// Tokeniza: texto, <tag attrs>, </tag>. Comentários e declarações são ignorados; "<" solto vira texto escapado.
function* tokens(html) {
  const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0; let m;
  while ((m = re.exec(html))) {
    if (m.index > last) yield { text: html.slice(last, m.index) };
    last = re.lastIndex;
    if (m[2] === undefined) continue; // comentário/declaração
    yield { end: !!m[1], tag: m[2].toLowerCase(), attrs: m[3] };
  }
  if (last < html.length) yield { text: html.slice(last) };
}
function parseAttrs(src) {
  const out = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) { const k = m[1].toLowerCase(); if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? ''; }
  return out;
}
function openTag(tag, a) {
  let s = '';
  if (tag === 'a') { const h = a.href !== undefined ? safeUrl(a.href) : null; if (h) s += ` href="${esc(h)}"`; if (a.title) s += ` title="${esc(decode(a.title).slice(0, 200))}"`; }
  if (tag === 'img') {
    const src = a.src !== undefined ? safeImg(a.src) : null;
    if (!src) return null; // imagem sem origem válida some
    s += ` src="${esc(src)}" alt="${esc(decode(a.alt || '').slice(0, 200))}"`;
    for (const k of ['width', 'height']) { const n = parseInt(a[k], 10); if (n > 0 && n <= 2000 && /^\d+(px)?$/.test(String(a[k]).trim())) s += ` ${k}="${n}"`; }
  }
  if (tag === 'td' || tag === 'th') for (const k of ['colspan', 'rowspan']) { const n = parseInt(a[k], 10); if (/^\s*\d{1,2}\s*$/.test(String(a[k] ?? '')) && n > 1 && n <= 50) s += ` ${k}="${n}"`; }
  if (tag === 'table') for (const k of ['border', 'cellpadding', 'cellspacing']) { if (/^\s*\d{1,2}\s*$/.test(String(a[k] ?? '')) && parseInt(a[k], 10) <= 20) s += ` ${k}="${parseInt(a[k], 10)}"`; }
  if (['table', 'td', 'th'].includes(tag)) {
    const wd = String(a.width ?? '').trim();
    if (/^\d{1,4}$/.test(wd) && +wd > 0 && +wd <= 2000) s += ` width="${+wd}"`; else if (/^\d{1,3}%$/.test(wd) && +wd.slice(0, -1) > 0 && +wd.slice(0, -1) <= 100) s += ` width="${wd}"`;
    const al = String(a.align ?? '').trim().toLowerCase(); if (/^(left|center|right)$/.test(al)) s += ` align="${al}"`;
  }
  if (a.style) { const st = safeStyle(a.style); if (st) s += ` style="${esc(st)}"`; }
  return `<${tag}${s}${VOID.has(tag) ? '>' : '>'}`;
}

function sanitize(input) {
  const html = String(input ?? '').slice(0, MAX_HTML * 4);
  const out = []; const stack = []; let dropDepth = 0; let dropTag = null;
  for (const t of tokens(html)) {
    if (t.text !== undefined) { if (!dropDepth) out.push(esc(decode(t.text).replace(/\u0000/g, ''))); continue; }
    const { tag } = t;
    if (dropDepth) { // dentro de script/style/iframe…: ignora tudo até o fechamento do mesmo tipo
      if (tag === dropTag) { if (t.end) { dropDepth--; if (!dropDepth) dropTag = null; } else if (!/\/\s*$/.test(t.attrs)) dropDepth++; }
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) { if (!t.end && !/\/\s*$/.test(t.attrs)) { dropDepth = 1; dropTag = tag; } continue; }
    if (!ALLOWED.has(tag)) continue; // tag desconhecida: some, o texto fica
    if (t.end) {
      if (VOID.has(tag)) continue;
      const i = stack.lastIndexOf(tag);
      if (i < 0) continue; // fechamento sem abertura
      while (stack.length > i) out.push(`</${stack.pop()}>`);
      continue;
    }
    const o = openTag(tag, parseAttrs(t.attrs));
    if (o === null) continue;
    // Fechamentos implícitos do HTML (<li> sem </li>, bloco dentro de <p>): mantém a estrutura bem formada.
    if (tag === 'li') { const li = stack.lastIndexOf('li'); const lst = Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol')); if (li > lst) while (stack.length > li) out.push(`</${stack.pop()}>`); }
    if (['p', 'div', 'ul', 'ol', 'h1', 'h2', 'h3', 'blockquote', 'hr', 'li', 'table'].includes(tag) && stack[stack.length - 1] === 'p') out.push(`</${stack.pop()}>`);
    // Tabelas: <td> sem </td>, <tr> sem </tr>, seções sem fechamento — fecha o que ficou aberto dentro da mesma tabela/linha.
    const lastOf = (names) => Math.max(...names.map((n) => stack.lastIndexOf(n)));
    const closeTo = (names, stops) => { const i = lastOf(names); if (i >= 0 && i > lastOf(stops)) while (stack.length > i) out.push(`</${stack.pop()}>`); };
    if (tag === 'td' || tag === 'th') closeTo(['td', 'th'], ['tr', 'table']);
    else if (tag === 'tr') closeTo(['tr'], ['thead', 'tbody', 'tfoot', 'table']);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') closeTo(['thead', 'tbody', 'tfoot'], ['table']);
    out.push(o);
    if (!VOID.has(tag)) stack.push(tag);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  const res = out.join('');
  return res.length > MAX_HTML ? res.slice(0, MAX_HTML) : res;
}

// HTML sanitizado → texto puro (parte text/plain da cópia): blocos viram linhas, listas viram "- "/"1. ", tabelas viram uma linha por linha (células separadas por " | "), links mostram a URL.
function htmlToText(html) {
  let out = ''; const lists = []; let href = null; let linkText = ''; let cells = 0; let firstCell = true;
  const nl = (n = 1) => { out = out.replace(/[ \t]+$/g, ''); const have = (out.match(/\n*$/) || [''])[0].length; if (out && have < n) out += '\n'.repeat(n - have); };
  for (const t of tokens(String(html || ''))) {
    if (t.text !== undefined) { const x = decode(t.text).replace(/\s+/g, ' '); out += x; if (href !== null) linkText += x; continue; }
    const { tag } = t;
    if (tag === 'br') { out += '\n'; continue; }
    if (tag === 'hr') { nl(); out += '--------'; nl(); continue; }
    if (tag === 'img') { const a = parseAttrs(t.attrs); out += a.alt ? `[imagem: ${decode(a.alt)}]` : '[imagem]'; continue; }
    if (tag === 'ul' || tag === 'ol') { if (t.end) { lists.pop(); nl(); } else { nl(); lists.push({ ordered: tag === 'ol', n: 0 }); } continue; }
    if (tag === 'li') { if (!t.end) { nl(); const l = lists[lists.length - 1]; if (l) { l.n++; out += `${'  '.repeat(Math.max(0, lists.length - 1))}${l.ordered ? `${l.n}. ` : '- '}`; } } continue; }
    if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot') { nl(); continue; }
    if (tag === 'tr') { if (!t.end) { nl(); firstCell = true; } continue; }
    if (tag === 'td' || tag === 'th') { if (t.end) cells = Math.max(0, cells - 1); else { cells++; if (!firstCell) out += ' | '; firstCell = false; } continue; }
    if (['p', 'div', 'h1', 'h2', 'h3', 'blockquote'].includes(tag)) { if (cells) out += ' '; else nl(tag === 'p' || tag.startsWith('h') ? 2 : 1); continue; }
    if (tag === 'a') {
      if (!t.end) { href = safeUrl(parseAttrs(t.attrs).href || '') || null; linkText = ''; if (href === null) href = ''; }
      else { if (href && linkText.trim() && decode(href).replace(/^mailto:/i, '') !== linkText.trim() && href !== linkText.trim()) out += ` (${href.replace(/^mailto:/i, '')})`; href = null; }
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
}

const WRAP_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222';
const wrap = (fragment) => `<div style="${WRAP_STYLE}">${fragment}</div>`;
const hasContent = (html) => /<img\b/.test(html) || htmlToText(html).length > 0;

module.exports = { sanitize, htmlToText, wrap, hasContent, WRAP_STYLE, esc, MAX_HTML, FONTS };
