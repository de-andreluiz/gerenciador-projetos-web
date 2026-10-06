// Saudação pelo horário LOCAL ("Bom dia" / "Boa tarde" / "Boa noite") — única fonte da regra, usada onde existe a variável {{greeting}}:
// modelos de e-mail (resolvida ao GERAR) e observação do item do checklist (resolvida ao SALVAR). Regras puras (sem HTTP/disco).
// Faixas por hora de início; o que sobra (18:00–04:59) é "Boa noite".
const GREETINGS = [{ from: 5, text: 'Bom dia' }, { from: 12, text: 'Boa tarde' }, { from: 18, text: 'Boa noite' }];

function greetingFor(date = new Date()) {
  const h = date.getHours();
  return (h < GREETINGS[0].from ? GREETINGS[GREETINGS.length - 1] : [...GREETINGS].reverse().find((g) => h >= g.from)).text;
}

const GREETING_RE = /\{\{\s*greeting\s*\}\}/gi;

// Troca {{greeting}} (qualquer caixa, espaços opcionais) pela saudação do momento; o resto do texto fica intacto.
const applyGreeting = (text, date = new Date()) => String(text ?? '').replace(GREETING_RE, () => greetingFor(date));

module.exports = { GREETINGS, greetingFor, applyGreeting };
