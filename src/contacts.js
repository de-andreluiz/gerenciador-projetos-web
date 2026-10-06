// Contatos dos coordenadores: número de WhatsApp (link wa.me) e e-mail.

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// Número no formato internacional, só dígitos (o que o wa.me espera), ou null se não der para montar.
//  - começa com "+" → já é internacional, usa como digitado;
//  - 10 ou 11 dígitos (DDD + número) → assume Brasil e acrescenta 55;
//  - 12 ou 13 dígitos começando em 55 → já tem o código do Brasil;
//  - qualquer outra coisa (ex.: sem DDD) → null, para não abrir conversa com o número errado.
function waNumber(phone) {
  const raw = String(phone ?? '').trim();
  let d = digits(raw);
  if (!d) return null;
  if (raw.startsWith('+')) return d.length >= 8 && d.length <= 15 ? d : null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  return null;
}

const waLink = (phone) => { const n = waNumber(phone); return n ? `https://wa.me/${n}` : null; };

// Convite de grupo do WhatsApp: só https://chat.whatsapp.com/<código>. Devolve a URL normalizada (sem parâmetros) ou null.
function waGroupUrl(v) {
  const m = /^(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9]{10,40})\/?(?:[?#].*)?$/i.exec(String(v ?? '').trim());
  return m ? `https://chat.whatsapp.com/${m[1]}` : null;
}

// Validação simples (uma barra de validação completa de e-mail é impossível; o objetivo é barrar erros de digitação).
const isEmail = (e) => /^[^\s@<>()[\]\\,;:"?]+@[^\s@<>()[\]\\,;:"?]+\.[^\s@<>()[\]\\,;:"?]{2,}$/.test(String(e ?? '').trim());

module.exports = { waNumber, waLink, waGroupUrl, isEmail, digits };
