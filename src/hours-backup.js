// Exportar / importar o controle de horas (Fase 5, ADR-014) — levar as horas de uma máquina para outra, por decisão do usuário.
// Horas nunca vão ao Supabase: o arquivo .gphours é o único caminho entre máquinas.
//
// Formato (JSON, versionado):  { format: 'gp-hours', version: 1, exportedAt, app, kdf: { scrypt, salt }, cipher: { A256GCM, iv }, tag, ciphertext }
//   - SEMPRE cifrado com uma senha escolhida na exportação: scrypt (N=2^15, r=8, p=1) → AES-256-GCM. O cabeçalho entra como AAD:
//     alterar qualquer campo (versão, parâmetros) invalida o arquivo. Senha errada e arquivo alterado dão o mesmo erro.
//   - Conteúdo: jornada/metas (hours), apontamentos (timeEntries), observações (timeNotes) e, opcionalmente, os anexos das observações.
//     Cronômetros em andamento NÃO vão (são estado da máquina).
// Importar = prévia → aplicar. Mescla por id, nunca duplica; id igual com conteúdo diferente mantém o ATUAL; apontamento que
// sobreporia outro não entra; jornada/metas só se o usuário escolher. Sem I/O aqui (arquivos e gravação ficam na rota).
'use strict';
const crypto = require('crypto');
const path = require('path');
const { httpError } = require('./util');
const H = require('./hours');
const E = require('./evidence');

const FORMAT = 'gp-hours';
const VERSION = 1;
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 };
const MAX_BYTES = 200 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// anexo de observação: horas/AAAA-MM/AAAA-MM-DD/<id>_<nome> — nome sem os caracteres que a pasta de evidências recusa
const REF_RE = /^horas\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{1,64}_[^/\\:<>"|?*\u0000-\u001f]{1,200}$/;

const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v === undefined ? null : v));
const fail = (status, msg, code) => httpError(status, msg, { code });

function checkPassphrase(p) {
  if (typeof p !== 'string' || p.length < 12 || p.length > 200) throw fail(400, 'Use uma senha de exportação com pelo menos 12 caracteres (ela será pedida para importar).', 'BACKUP_PASSPHRASE');
  return p;
}

const derive = (pass, salt, kdf) => new Promise((resolve, reject) => {
  crypto.scrypt(pass, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
});

// files: Map(ref → Buffer) dos anexos das observações a incluir.
async function buildBackup(data, files, { passphrase, appVersion = '', now = new Date() }) {
  checkPassphrase(passphrase);
  const payload = {
    kind: 'gp-hours-payload',
    hours: data.hours || null,
    timeEntries: data.timeEntries || [],
    timeNotes: data.timeNotes || [],
    files: Object.fromEntries([...(files || new Map())].map(([ref, buf]) => [ref, buf.toString('base64')])),
  };
  const header = { format: FORMAT, version: VERSION, exportedAt: now.toISOString(), app: String(appVersion), kdf: { ...KDF, salt: crypto.randomBytes(16).toString('base64') }, cipher: { alg: 'A256GCM', iv: crypto.randomBytes(12).toString('base64') } };
  const key = await derive(passphrase, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
  const c = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(header.cipher.iv, 'base64'), { authTagLength: 16 });
  c.setAAD(Buffer.from(canonical(header), 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final()]);
  key.fill(0);
  const counts = { entries: payload.timeEntries.length, notes: payload.timeNotes.length, files: Object.keys(payload.files).length };
  return { buffer: Buffer.from(JSON.stringify({ ...header, tag: c.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') }), 'utf8'), counts };
}

async function openBackup(buffer, passphrase) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail(400, 'Arquivo vazio.', 'BACKUP_FORMAT');
  if (buffer.length > MAX_BYTES) throw fail(413, 'Arquivo de horas grande demais.', 'BACKUP_FORMAT');
  let doc;
  try { doc = JSON.parse(buffer.toString('utf8')); } catch { throw fail(400, 'Este arquivo não é uma exportação do controle de horas (.gphours).', 'BACKUP_FORMAT'); }
  if (doc?.format !== FORMAT) throw fail(400, 'Este arquivo não é uma exportação do controle de horas (.gphours).', 'BACKUP_FORMAT');
  if (!Number.isInteger(doc.version) || doc.version > VERSION) throw fail(400, 'Arquivo gerado por uma versão mais nova do aplicativo. Atualize o aplicativo para importar.', 'BACKUP_VERSION');
  const k = doc.kdf || {};
  if (k.name !== 'scrypt' || k.N !== KDF.N || k.r !== KDF.r || k.p !== KDF.p || doc.cipher?.alg !== 'A256GCM') throw fail(400, 'Parâmetros de proteção do arquivo não reconhecidos.', 'BACKUP_FORMAT');
  checkPassphrase(passphrase);
  const { tag, ciphertext, ...header } = doc;
  const key = await derive(passphrase, Buffer.from(String(k.salt), 'base64'), k);
  let payload;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(doc.cipher.iv), 'base64'), { authTagLength: 16 });
    d.setAAD(Buffer.from(canonical(header), 'utf8'));
    d.setAuthTag(Buffer.from(String(tag), 'base64'));
    payload = JSON.parse(Buffer.concat([d.update(Buffer.from(String(ciphertext), 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw fail(400, 'Senha incorreta ou arquivo alterado/corrompido. Nada foi importado.', 'BACKUP_PASSPHRASE');
  } finally { key.fill(0); }
  if (payload?.kind !== 'gp-hours-payload') throw fail(400, 'Conteúdo do arquivo de horas inválido.', 'BACKUP_FORMAT');
  return { header: { exportedAt: header.exportedAt, app: header.app, version: header.version }, payload };
}

// ---------- validação dos registros vindos do arquivo (nunca confiar no conteúdo) ----------
function validEntry(e) {
  return e && ID_RE.test(e.id || '') && DATE_RE.test(e.date || '') && Number.isInteger(e.startMin) && Number.isInteger(e.endMin)
    && e.startMin >= 0 && e.endMin <= 1440 && e.endMin > e.startMin && typeof e.activity === 'string' && e.activity.trim().length > 0
    && (e.pausedMin === undefined || (Number.isInteger(e.pausedMin) && e.pausedMin >= 0));
}
function validNote(n) {
  return n && ID_RE.test(n.id || '') && Array.isArray(n.dates) && n.dates.length > 0 && n.dates.every((d) => DATE_RE.test(d))
    && typeof n.title === 'string' && Array.isArray(n.evidences || []);
}
function validFile(ref, buf) {
  if (!REF_RE.test(ref)) return false;
  const ext = path.extname(ref).toLowerCase();
  if (!ext || E.BLOCKED.has(ext)) return false;
  return buf.length > 0 && !(buf[0] === 0x4D && buf[1] === 0x5A) && !(buf[0] === 0x7F && buf[1] === 0x45); // nunca executável
}

// Prévia: o que entraria, o que já existe, o que conflita. Nada é alterado.
function planImport(data, payload, { hasFile = () => false } = {}) {
  const plan = { entries: { add: [], same: 0, conflict: 0, overlap: 0, invalid: 0 }, notes: { add: [], same: 0, conflict: 0, invalid: 0 }, files: { add: [], present: [], invalid: 0 }, settingsDiffer: false };
  const sim = { ...data, timeEntries: [...(data.timeEntries || [])] };
  const byId = new Map(sim.timeEntries.map((e) => [e.id, e]));
  for (const e of Array.isArray(payload.timeEntries) ? payload.timeEntries : []) {
    if (!validEntry(e)) { plan.entries.invalid++; continue; }
    const cur = byId.get(e.id);
    if (cur) { if (canonical(cur) === canonical(e)) plan.entries.same++; else plan.entries.conflict++; continue; }
    try { H.assertNoOverlap(sim, e, null); } catch { plan.entries.overlap++; continue; }
    sim.timeEntries.push(e); byId.set(e.id, e);
    plan.entries.add.push(e.id);
  }
  const notes = new Map((data.timeNotes || []).map((n) => [n.id, n]));
  const fileRefs = new Set();
  for (const n of Array.isArray(payload.timeNotes) ? payload.timeNotes : []) {
    if (!validNote(n)) { plan.notes.invalid++; continue; }
    const cur = notes.get(n.id);
    if (cur) { if (canonical(cur) === canonical(n)) plan.notes.same++; else plan.notes.conflict++; continue; }
    plan.notes.add.push(n.id);
    for (const ev of n.evidences || []) fileRefs.add(ev.file);
  }
  for (const [ref, b64] of Object.entries(payload.files || {})) {
    if (!fileRefs.has(ref)) continue; // só anexos das observações que entram
    const buf = Buffer.from(String(b64), 'base64');
    if (!validFile(ref, buf)) { plan.files.invalid++; continue; }
    if (hasFile(ref)) plan.files.present.push(ref); else plan.files.add.push(ref);
  }
  plan.settingsDiffer = !!payload.hours && canonical(payload.hours) !== canonical(data.hours || null);
  return plan;
}

// Aplica um plano (feito agora, sobre o estado atual). Devolve os anexos a gravar: [{ ref, buffer }].
function applyImport(data, payload, plan, { includeSettings = false } = {}) {
  const addE = new Set(plan.entries.add);
  for (const e of payload.timeEntries || []) if (addE.has(e.id)) data.timeEntries.push(e);
  const addN = new Set(plan.notes.add);
  for (const n of payload.timeNotes || []) if (addN.has(n.id)) data.timeNotes.push({ ...n, evidences: (n.evidences || []).filter((ev) => plan.files.add.includes(ev.file) || plan.files.present.includes(ev.file)) }); // anexo inválido/ausente sai da observação
  if (includeSettings && payload.hours) data.hours = payload.hours;
  const dates = [...(payload.timeEntries || []).filter((e) => addE.has(e.id)).map((e) => e.date)].sort();
  if (dates.length && data.hours && (!data.hours.trackingFrom || dates[0] < data.hours.trackingFrom)) data.hours.trackingFrom = dates[0];
  H.ensureHours(data);
  return plan.files.add.map((ref) => ({ ref, buffer: Buffer.from(String(payload.files[ref]), 'base64') }));
}

module.exports = { buildBackup, openBackup, planImport, applyImport, checkPassphrase, FORMAT, VERSION, MAX_BYTES };
