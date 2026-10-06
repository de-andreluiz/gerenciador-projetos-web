const test = require('node:test');
const assert = require('node:assert/strict');
const { projectSchedule, milestoneState, daysBetween } = require('../src/schedule');
const { parseSheetUrl } = require('../src/sheets');
const { isLoopback, validateConnection } = require('../src/db');
const { sanitizeFileName } = require('../src/util');

test('projeto sem cronograma não é problema', () => {
  assert.equal(projectSchedule({}, '2026-09-25').state, 'none');
  assert.equal(projectSchedule({ milestones: [] }, '2026-09-25').state, 'none');
});

test('estados do cronograma', () => {
  const t = '2026-09-25';
  const ms = (dueDate, extra = {}) => ({ id: 'x', title: 'E', dueDate, ...extra });
  assert.equal(milestoneState(ms('2026-09-24'), t).state, 'overdue');
  assert.equal(milestoneState(ms('2026-09-25'), t).state, 'soon'); // vence hoje
  assert.equal(milestoneState(ms('2026-10-02'), t).state, 'soon'); // 7 dias
  assert.equal(milestoneState(ms('2026-10-03'), t).state, 'ok');
  assert.equal(milestoneState(ms('2026-10-03', { alertDays: 10 }), t).state, 'soon');
  assert.equal(milestoneState(ms('2026-01-01', { done: true }), t).state, 'done');
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
});

test('projeto: pior marco pendente define o estado; concluído ignora marcos feitos', () => {
  const t = '2026-09-25';
  const p = { milestones: [
    { id: 'a', title: 'A', dueDate: '2026-09-01', done: true },
    { id: 'b', title: 'B', dueDate: '2026-10-20' },
    { id: 'c', title: 'C', dueDate: '2026-09-27' },
  ] };
  const s = projectSchedule(p, t);
  assert.equal(s.state, 'soon');
  assert.equal(s.next.id, 'c');
  assert.equal(projectSchedule({ milestones: [{ id: 'a', title: 'A', dueDate: '2026-09-01', done: true }] }, t).state, 'done');
});

test('link do Google Sheets', () => {
  assert.equal(parseSheetUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0').id, '1AbCdEfGhIjKlMnOp');
  assert.equal(parseSheetUrl('https://evil.com/spreadsheets/d/1AbCdEfGhIjKlMnOp'), null);
  assert.equal(parseSheetUrl('http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp'), null);
  assert.equal(parseSheetUrl('lixo'), null);
});

test('conexão local só aceita loopback e conexões rejeitam injeção', () => {
  assert.ok(isLoopback('localhost'));
  assert.ok(isLoopback('LOCALHOST\\SQLEXPRESS'));
  assert.ok(isLoopback('.'));
  assert.ok(!isLoopback('10.0.0.5'));
  assert.ok(!isLoopback('localhost.evil.com'));
  assert.throws(() => validateConnection({ server: 'a;Server=b', database: 'x' }));
  assert.throws(() => validateConnection({ server: 'localhost', database: 'x;Trusted_Connection=No' }));
  assert.doesNotThrow(() => validateConnection({ server: 'localhost', database: 'MIGRA_X', auth: 'windows' }));
});

test('nome de arquivo seguro', () => {
  assert.equal(sanitizeFileName('a/b:c*?.xlsx'), 'a_b_c__.xlsx');
  assert.equal(sanitizeFileName('CON'), 'arquivo');
});
