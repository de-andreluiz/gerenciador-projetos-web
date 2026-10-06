// {{greeting}}: regra compartilhada (src/greeting.js) e uso na observação do item do checklist (resolvida ao SALVAR). Horário sempre controlado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { greetingFor, applyGreeting } = require('../src/greeting');
const C = require('../src/checklist');
const M = require('../src/email');

const at = (h, m = 0) => new Date(2026, 9, 5, h, m, 0); // horário LOCAL controlado

test('faixas da saudação (compartilhadas): 05:00–11:59 bom dia, 12:00–17:59 boa tarde, 18:00–04:59 boa noite', () => {
  const cases = [[5, 0, 'Bom dia'], [11, 59, 'Bom dia'], [12, 0, 'Boa tarde'], [17, 59, 'Boa tarde'], [18, 0, 'Boa noite'], [23, 59, 'Boa noite'], [0, 0, 'Boa noite'], [4, 59, 'Boa noite']];
  for (const [h, m, want] of cases) assert.equal(greetingFor(at(h, m)), want, `${h}:${m}`);
  assert.equal(M.greetingFor, greetingFor); // e-mail e checklist usam a MESMA regra
});

test('applyGreeting: troca {{greeting}} (caixa/espaços variados, várias vezes) e não mexe no resto', () => {
  assert.equal(applyGreeting('{{greeting}}, cliente avisou.', at(9)), 'Bom dia, cliente avisou.');
  assert.equal(applyGreeting('{{ Greeting }} e {{GREETING}}!\n{{greeting}}', at(15)), 'Boa tarde e Boa tarde!\nBoa tarde');
  assert.equal(applyGreeting('Falei com o RH {{greeting}}', at(20)), 'Falei com o RH Boa noite');
  assert.equal(applyGreeting('sem variável {{project.name}} {{greeting_x}} {greeting}', at(9)), 'sem variável {{project.name}} {{greeting_x}} {greeting}'); // outras variáveis/escritas ficam como estão
  assert.equal(applyGreeting('', at(9)), ''); assert.equal(applyGreeting(null, at(9)), '');
});

test('observação do item: {{greeting}} vira a saudação NO MOMENTO DE SALVAR e o que fica gravado é o texto resolvido', () => {
  const save = (text, h, m = 0) => { const it = { note: null }; const changed = C.setNote(it, text, 'eu', at(h, m).toISOString()); return { it, changed }; };
  assert.equal(save('{{greeting}}, cliente enviará o arquivo.', 9).it.note.text, 'Bom dia, cliente enviará o arquivo.');
  assert.equal(save('{{greeting}}, cliente enviará o arquivo.', 15).it.note.text, 'Boa tarde, cliente enviará o arquivo.');
  assert.equal(save('{{greeting}}, cliente enviará o arquivo.', 20).it.note.text, 'Boa noite, cliente enviará o arquivo.');
  assert.equal(save('{{greeting}}', 11, 59).it.note.text, 'Bom dia'); assert.equal(save('{{greeting}}', 12).it.note.text, 'Boa tarde');
  assert.doesNotMatch(save('x {{greeting}} y {{ greeting }}', 9).it.note.text, /\{\{/); // nenhuma variável sobra
  // limite de tamanho vale sobre o texto resolvido; vazio continua removendo; igual não conta como mudança
  const longo = save(`{{greeting}} ${'a'.repeat(2000)}`, 9).it.note.text; assert.equal(longo.length, C.MAX_NOTE); assert.ok(longo.startsWith('Bom dia '));
  const it = { note: null }; C.setNote(it, '{{greeting}}!', 'eu', at(9).toISOString());
  assert.equal(C.setNote(it, 'Bom dia!', 'eu', at(9).toISOString()), false); // reabrir e salvar o texto já resolvido não muda nada
  assert.equal(C.setNote(it, '   ', 'eu', at(9).toISOString()), true); assert.equal(it.note, null);
  // texto sem a variável não é alterado
  assert.equal(save('Cliente {{project.name}} pendente', 9).it.note.text, 'Cliente {{project.name}} pendente');
});
