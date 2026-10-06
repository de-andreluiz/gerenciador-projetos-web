// Separação de um objeto em partes, por caminhos — base do mapeamento nuvem/local (sem I/O).
//
//   extract(obj, paths) → { rest, taken }   tira de `obj` (cópia) os valores dos caminhos e devolve-os numa árvore `taken`
//   inject(rest, taken) → obj               devolve os valores às mesmas posições
//
// Gramática dos caminhos: segmentos separados por ponto; `lista[]` percorre os elementos de um array, identificando cada elemento
// pelo seu `id` (ou pela posição `#i` quando não houver id). Ex.: 'items[].evidences[].name', 'environments.hml.dir', 'workspace'.
// Em `taken`, arrays viram objetos indexados pelo id do elemento → a reinserção não depende da ordem e sobrevive a reordenações;
// cada valor tirado fica embrulhado em { $v } (distingue “valor” de “continuação do caminho”).
'use strict';

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const elemKey = (el, i) => (isObj(el) && (typeof el.id === 'string' || typeof el.id === 'number') ? `id:${el.id}` : `#${i}`);

function parse(path) {
  return path.split('.').map((seg) => (seg.endsWith('[]') ? { key: seg.slice(0, -2), each: true } : { key: seg, each: false }));
}

function takeAt(node, segs, out) {
  if (!isObj(node)) return false;
  const [head, ...tail] = segs;
  if (!(head.key in node)) return false;
  if (!head.each) {
    if (!tail.length) { out[head.key] = { $v: node[head.key] }; delete node[head.key]; return true; } // folha: valor embrulhado
    const sub = isObj(out[head.key]) ? out[head.key] : {};
    const got = takeAt(node[head.key], tail, sub);
    if (got) out[head.key] = sub;
    return got;
  }
  const arr = node[head.key];
  if (!Array.isArray(arr)) return false;
  let any = false;
  const bucket = isObj(out[`${head.key}[]`]) ? out[`${head.key}[]`] : {};
  arr.forEach((el, i) => {
    const k = elemKey(el, i);
    if (!tail.length) return; // 'lista[]' sozinho não é caminho válido (use 'lista')
    const sub = isObj(bucket[k]) ? bucket[k] : {};
    if (takeAt(el, tail, sub)) { bucket[k] = sub; any = true; }
  });
  if (any) out[`${head.key}[]`] = bucket;
  return any;
}

function extract(obj, paths) {
  const rest = clone(obj);
  const taken = {};
  for (const p of paths) takeAt(rest, parse(p), taken);
  return { rest, taken };
}

function putBack(node, taken) {
  if (!isObj(node) || !isObj(taken)) return;
  for (const [k, v] of Object.entries(taken)) {
    if (k.endsWith('[]')) {
      const arr = node[k.slice(0, -2)];
      if (!Array.isArray(arr) || !isObj(v)) continue;
      arr.forEach((el, i) => { const sub = v[elemKey(el, i)]; if (sub) putBack(el, sub); });
    } else if (isObj(v) && '$v' in v) {
      node[k] = clone(v.$v);
    } else if (isObj(v) && isObj(node[k])) {
      putBack(node[k], v); // continuação do caminho; se o objeto não existe mais, o valor tirado é descartado (não recria estrutura)
    }
  }
}

function inject(rest, taken) {
  const out = clone(rest);
  putBack(out, taken || {});
  return out;
}

// Mantém só as chaves listadas (o resto vai para `others`). Usado para "em claro só o que está na lista" (seguro por padrão).
function pick(obj, keys) {
  const kept = {};
  const others = {};
  for (const [k, v] of Object.entries(obj || {})) (keys.includes(k) ? kept : others)[k] = clone(v);
  return { kept, others };
}

module.exports = { extract, inject, pick, clone };
