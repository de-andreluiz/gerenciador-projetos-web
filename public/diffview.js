'use strict';
// Visualizador de diferenças (sem editor): compara dois textos linha a linha (algoritmo de Myers) e mostra no estilo
// "unified" — linhas removidas/adicionadas com os números de linha dos dois lados e trechos iguais recolhidos.
// Usado no Git (alterações e commits) e para comparar arquivos de dois projetos.

const DIFF_MAX_EDIT = 2000;   // acima disso de diferenças, mostra as duas versões inteiras (evita travar)
const DIFF_CONTEXT = 3;
const DIFF_MAX_RENDER = 6000; // linhas desenhadas no máximo

// Devolve [{ t: '=', a, b } | { t: '-', a } | { t: '+', b }] (a/b = índice da linha em cada lado) ou null se grande demais.
function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA); const B = b.slice(start, endB);
  const N = A.length; const M = B.length;
  const middle = [];
  if (N || M) {
    const MAX = N + M;
    const off = MAX + 1;
    const V = new Int32Array(2 * MAX + 3);
    const trace = [];
    let found = false;
    for (let d = 0; d <= Math.min(MAX, DIFF_MAX_EDIT); d++) {
      trace.push(V.slice(off - d - 1, off + d + 2)); // V antes deste passo (só a janela usada)
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        V[off + k] = x;
        if (x >= N && y >= M) { found = true; break; }
      }
      if (found) break;
    }
    if (!found) return null;
    let x = N; let y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
      const w = trace[d];
      const vv = (k) => w[k + d + 1];
      const k = x - y;
      const prevK = (k === -d || (k !== d && vv(k - 1) < vv(k + 1))) ? k + 1 : k - 1;
      const prevX = vv(prevK); const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { middle.push({ t: '=', a: start + x - 1, b: start + y - 1 }); x--; y--; }
      if (d > 0) { if (x === prevX) middle.push({ t: '+', b: start + y - 1 }); else middle.push({ t: '-', a: start + x - 1 }); }
      x = prevX; y = prevY;
    }
    middle.reverse();
  }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: '=', a: i, b: i });
  ops.push(...middle);
  for (let i = 0; i < a.length - endA; i++) ops.push({ t: '=', a: endA + i, b: endB + i });
  return ops;
}

// Modal com as diferenças. labels: ['Antes', 'Agora'] (ou nomes dos arquivos). notes: avisos (arquivo novo, binário…).
function showDiffModal({ title, subtitle, original = '', modified = '', labels = ['Antes', 'Agora'], notes = [] }) {
  const a = original === '' ? [] : String(original).split('\n');
  const b = modified === '' ? [] : String(modified).split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  const ops = diffLines(a, b);
  let full = false;
  const body = h('div', { class: 'dv-body' });
  const stats = h('span', { class: 'dv-stats' });
  const draw = () => {
    if (!ops) {
      setKids(body, h('div', { class: 'box warn' }, 'Os arquivos são diferentes demais para alinhar linha a linha: abaixo, as duas versões completas.'),
        h('div', { class: 'dv-two' }, h('div', null, h('div', { class: 'lbl' }, labels[0]), h('pre', { class: 'code' }, original)), h('div', null, h('div', { class: 'lbl' }, labels[1]), h('pre', { class: 'code' }, modified))));
      return;
    }
    const add = ops.filter((o) => o.t === '+').length; const del = ops.filter((o) => o.t === '-').length;
    setKids(stats, h('span', { class: 'add' }, `+${add}`), ' ', h('span', { class: 'del' }, `−${del}`));
    if (!add && !del) { setKids(body, h('div', { class: 'ws-note' }, 'Os dois lados são iguais.')); return; }
    // quais linhas mostrar: as alteradas e 3 de contexto em volta (ou tudo)
    const show = new Array(ops.length).fill(full);
    if (!full) ops.forEach((o, i) => { if (o.t !== '=') for (let j = Math.max(0, i - DIFF_CONTEXT); j <= Math.min(ops.length - 1, i + DIFF_CONTEXT); j++) show[j] = true; });
    const rows = [];
    let hidden = 0;
    let drawn = 0;
    const flushHidden = () => { if (hidden) { rows.push(h('div', { class: 'dv-gap' }, `… ${plural(hidden, 'linha igual', 'linhas iguais')} …`)); hidden = 0; } };
    for (let i = 0; i < ops.length; i++) {
      if (!show[i]) { hidden++; continue; }
      flushHidden();
      if (++drawn > DIFF_MAX_RENDER) { rows.push(h('div', { class: 'dv-gap' }, 'Diferença muito longa: o restante foi omitido.')); break; }
      const o = ops[i];
      const text = o.t === '+' ? b[o.b] : a[o.a];
      rows.push(h('div', { class: `dv-line ${o.t === '+' ? 'add' : o.t === '-' ? 'del' : ''}` },
        h('span', { class: 'dv-n' }, o.a !== undefined ? o.a + 1 : ''), h('span', { class: 'dv-n' }, o.b !== undefined ? o.b + 1 : ''),
        h('span', { class: 'dv-s' }, o.t === '=' ? ' ' : o.t === '+' ? '+' : '−'), h('span', { class: 'dv-t' }, text)));
    }
    flushHidden();
    setKids(body, h('div', { class: 'dv-lines' }, rows));
  };
  const toggle = h('label', { class: 'check small' }, h('input', { type: 'checkbox', onchange: (e) => { full = e.target.checked; draw(); } }), ' arquivo inteiro');
  draw();
  const m = openModal({ title, wide: true,
    body: [h('div', { class: 'dv-head' }, subtitle ? h('span', { class: 'mono small muted' }, subtitle) : null, h('span', { class: 'spacer' }),
      h('span', { class: 'dv-legend small' }, h('span', { class: 'del' }, `− ${labels[0]}`), '  ', h('span', { class: 'add' }, `+ ${labels[1]}`)), stats, ops ? toggle : null),
    notes.length ? h('div', { class: 'box warn small' }, notes.map((n) => h('div', null, n))) : null, body],
    footer: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar')] });
  m.el.classList.add('dv-modal');
  return m;
}
