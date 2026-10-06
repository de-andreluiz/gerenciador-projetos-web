// Fase 5 — exportar/importar o controle de horas (.gphours): formato cifrado com senha, prévia, mescla sem duplicar,
// conflito mantém o atual, nunca cria sobreposição, anexos das observações, jornada só se o usuário escolher.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-hbk-'));
const PORT = 4462;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const HB = require('../src/hours-backup');
const { applyDefaults } = require('../src/defaults');

const PASS = 'Senha-Do-Arquivo-2026';
const base = `http://localhost:${PORT}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(40, 2)]);
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const api = async (method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = {}; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binário */ }
  return { status: r.status, json, buf, headers: r.headers };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };
const preview = (buf, pass = PASS) => api('POST', '/api/hours/backup/preview', buf, { 'Content-Type': 'application/octet-stream', 'X-Passphrase': encodeURIComponent(pass) });

const entry = (id, date, s, e, activity = 'Análise') => ({ id, projectId: 'internal', projectName: 'Atividade interna', date, startMin: s, endMin: e, pausedMin: 0, activity, note: '', source: 'manual', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' });
const state = (entries = [], notes = []) => applyDefaults({ version: 1, settings: {}, projects: [], timeEntries: entries, timeNotes: notes });

test('formato: ida e volta com a senha; senha errada, cabeçalho alterado e arquivo estranho são recusados; nada legível no arquivo', async () => {
  const d = state([entry('e1', '2026-09-01', 480, 540, 'ATIVIDADE_CONFIDENCIAL')]);
  const { buffer, counts } = await HB.buildBackup(d, new Map([['horas/2026-09/2026-09-01/ev1_print.png', PNG]]), { passphrase: PASS, appVersion: '1.0.0' });
  assert.deepEqual(counts, { entries: 1, notes: 0, files: 1 });
  assert.ok(!buffer.toString().includes('ATIVIDADE_CONFIDENCIAL') && !buffer.toString().includes('internal'));
  const { payload, header } = await HB.openBackup(buffer, PASS);
  assert.equal(payload.timeEntries[0].activity, 'ATIVIDADE_CONFIDENCIAL');
  assert.equal(header.version, 1);
  await assert.rejects(HB.openBackup(buffer, 'Outra-Senha-Qualquer'), { code: 'BACKUP_PASSPHRASE' });
  const doc = JSON.parse(buffer); doc.exportedAt = '2020-01-01T00:00:00.000Z';
  await assert.rejects(HB.openBackup(Buffer.from(JSON.stringify(doc)), PASS), { code: 'BACKUP_PASSPHRASE' }, 'cabeçalho é autenticado (AAD)');
  const newer = JSON.parse(buffer); newer.version = 2;
  await assert.rejects(HB.openBackup(Buffer.from(JSON.stringify(newer)), PASS), { code: 'BACKUP_VERSION' });
  await assert.rejects(HB.openBackup(Buffer.from('{"format":"outro"}'), PASS), { code: 'BACKUP_FORMAT' });
  await assert.rejects(HB.openBackup(Buffer.from('não é json'), PASS), { code: 'BACKUP_FORMAT' });
  await assert.rejects(HB.buildBackup(d, new Map(), { passphrase: 'curta' }), { code: 'BACKUP_PASSPHRASE' });
});

test('prévia/mescla: novo entra; igual não duplica; id igual com conteúdo diferente mantém o atual; sobreposição e inválido não entram', async () => {
  const current = state([entry('e1', '2026-09-01', 480, 540), entry('e2', '2026-09-01', 600, 660, 'Atual')]);
  const payload = {
    kind: 'gp-hours-payload', hours: current.hours,
    timeEntries: [entry('e1', '2026-09-01', 480, 540), entry('e2', '2026-09-01', 600, 660, 'Diferente'), entry('e3', '2026-09-01', 500, 520), entry('e4', '2026-09-02', 480, 540),
      entry('e5', '2026-09-02', 500, 530), { id: 'ruim', date: 'x', startMin: 1, endMin: 0 }],
    timeNotes: [{ id: 'n1', dates: ['2026-09-02'], date: '2026-09-02', title: 'Obs', evidences: [{ id: 'ev1', file: 'horas/2026-09/2026-09-02/ev1_print.png', name: 'print.png' }, { id: 'ev2', file: 'horas/2026-09/2026-09-02/ev2_x.exe', name: 'x.exe' }] }],
    files: { 'horas/2026-09/2026-09-02/ev1_print.png': PNG.toString('base64'), 'horas/2026-09/2026-09-02/ev2_x.exe': PNG.toString('base64') },
  };
  const plan = HB.planImport(current, payload);
  assert.deepEqual(plan.entries.add, ['e4']);
  assert.equal(plan.entries.same, 1); assert.equal(plan.entries.conflict, 1);
  assert.equal(plan.entries.overlap, 2, 'e3 sobrepõe e1; e5 sobrepõe e4 (que entra antes)'); assert.equal(plan.entries.invalid, 1);
  assert.deepEqual(plan.files.add, ['horas/2026-09/2026-09-02/ev1_print.png']); assert.equal(plan.files.invalid, 1, '.exe nunca entra');
  HB.applyImport(current, payload, plan);
  assert.deepEqual(current.timeEntries.map((e) => e.id), ['e1', 'e2', 'e4']);
  assert.equal(current.timeEntries.find((e) => e.id === 'e2').activity, 'Atual', 'conflito mantém o atual');
  assert.deepEqual(current.timeNotes[0].evidences.map((e) => e.id), ['ev1'], 'anexo recusado sai da observação');
  const again = HB.planImport(current, payload, { hasFile: () => true });
  assert.deepEqual([again.entries.add.length, again.notes.add.length, again.files.add.length], [0, 0, 0], 'importar de novo não duplica');
});

test('API: exportar (sempre com senha) → apagar → prévia → aplicar restaura apontamento, observação e anexo', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const e = ok(await api('POST', '/api/hours/entries', { projectId: 'internal', date: '2026-09-01', start: '08:00', end: '09:00', activity: 'Reunião de alinhamento' })).entry;
  const n = ok(await api('POST', '/api/hours/notes', { dates: [today], title: 'Sem sistema', description: 'x', category: 'info' })).note;
  ok(await api('POST', `/api/hours/notes/${n.id}/evidence`, PNG, { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'print.png', 'X-File-Type': 'image/png' }));
  assert.equal((await api('POST', '/api/hours/backup/export', { passphrase: 'curta' })).json.code, 'BACKUP_PASSPHRASE');
  const exp = await api('POST', '/api/hours/backup/export', { passphrase: PASS });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /Horas_\d{4}-\d{2}-\d{2}\.gphours/);
  const file = exp.buf;
  assert.ok(!file.toString().includes('Reunião de alinhamento'));
  // "outra máquina": os registros somem daqui
  ok(await api('DELETE', `/api/hours/entries/${e.id}`));
  ok(await api('DELETE', `/api/hours/notes/${n.id}`));
  assert.equal((await preview(file, 'Senha-Errada-12345')).json.code, 'BACKUP_PASSPHRASE');
  const pv = ok(await preview(file));
  assert.equal(pv.summary.entries.new, 1); assert.equal(pv.summary.notes.new, 1); assert.equal(pv.summary.files.new, 1);
  assert.equal(pv.summary.settingsDiffer, false);
  const ap = ok(await api('POST', '/api/hours/backup/apply', { token: pv.token }));
  assert.equal(ap.summary.entries.new, 1);
  assert.equal((await api('POST', '/api/hours/backup/apply', { token: pv.token })).json.code, 'BACKUP_EXPIRED', 'token vale uma vez');
  const entries = ok(await api('GET', '/api/hours/entries?from=2026-09-01&to=2026-09-01'));
  assert.ok(JSON.stringify(entries).includes('Reunião de alinhamento'));
  const st = ok(await api('GET', '/api/hours/state'));
  assert.ok(st.recentNotes.some((x) => x.id === n.id && x.evidenceCount === 1));
  const back = await api('GET', `/api/hours/notes/${n.id}/evidences/${st.recentNotes.find((x) => x.id === n.id) && (ok(await api('GET', `/api/hours/day?date=${today}`)).notes.find((x) => x.id === n.id).evidences[0].id)}/file`);
  assert.deepEqual(back.buf, PNG, 'anexo restaurado e legível');
  // importar de novo: nada novo
  const again = ok(await preview(file));
  assert.deepEqual([again.summary.entries.new, again.summary.entries.same, again.summary.notes.new], [0, 1, 0]);
});

test('API: jornada do arquivo só substitui a atual se o usuário escolher', async () => {
  const cfg = ok(await api('GET', '/api/hours/state')).config;
  const file = (await api('POST', '/api/hours/backup/export', { passphrase: PASS })).buf;
  ok(await api('PUT', '/api/hours/config', { ...cfg, schedule: { ...cfg.schedule, start: '07:00' } }));
  const pv = ok(await preview(file));
  assert.equal(pv.summary.settingsDiffer, true);
  ok(await api('POST', '/api/hours/backup/apply', { token: pv.token }));
  assert.equal(ok(await api('GET', '/api/hours/state')).config.schedule.start, '07:00', 'sem escolher, mantém a atual');
  const pv2 = ok(await preview(file));
  ok(await api('POST', '/api/hours/backup/apply', { token: pv2.token, includeSettings: true }));
  assert.equal(ok(await api('GET', '/api/hours/state')).config.schedule.start, cfg.schedule.start, 'escolheu: veio a do arquivo');
});
