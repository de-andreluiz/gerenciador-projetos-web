// Mapeamento do estado do app (o objeto `store.data`, mesmo formato do projects.json) ⇄ linhas das tabelas do Supabase.
// Puro (sem I/O, sem cifra): `decompose` produz linhas LÓGICAS (parte em claro + parte sensível ainda não cifrada) e as seções
// locais; `compose` faz o caminho inverso. A cifra (sensitive → enc) e a rede ficam no CloudBackend.
//
// Regras (docs/DATA-CLASSIFICATION.md, ADR-014/015):
// - Projeto: em claro SÓ a lista PROJECT_PLAIN (estrutura/ids/estado); todo o resto é cifrado → campo novo nasce cifrado.
// - Caminho de disco nunca vai à nuvem → `bindings` (vínculo local por usuário/máquina).
// - Senha (passwordEnc, DPAPI) nunca vai à nuvem → `secrets` locais.
// - Horas e Workspace → seções locais. Legado sem uso (integrations, emailSends, version) não é levado.
// Linha lógica: { table, key, rowId, scope, cols, doc?, sensitive? }  — rowId entra no AAD da cifra; scope escolhe a DEK.
'use strict';
const { extract, inject, pick, clone } = require('./split');

const PROJECT_PLAIN = ['createdAt', 'rootDirKind', 'coordinatorId', 'analystId', 'projectTypeId', 'originSystemId', 'defaultConnectionId',
  'cycleId', 'cycleVersion', 'steps', 'stepId', 'stageHistory', 'emailTemplateIds'];
const PROJECT_LOCAL = ['rootDir', 'bases[].directory', 'deparas[].targetDir', 'deparas[].sourceDir', 'deparas[].lastDownload',
  'environments.hml.dir', 'environments.prod.dir', 'notes[].refs[].path', 'workspace'];
const PROJECT_SECRETS = ['bases[].prod.passwordEnc', 'bases[].local.passwordEnc'];
// evidences[].file: no modo local o caminho leva o slug do nome do projeto e o nome do arquivo → cifrado (achado da Fase 3b).
const CHECKLIST_SENSITIVE = ['items[].note', 'items[].runs', 'items[].evidences[].name', 'items[].evidences[].description', 'items[].evidences[].file'];
const CONNECTION_PLAIN = ['env', 'auth', 'encrypt', 'trustServerCertificate', 'allowDestructive', 'createdAt', 'updatedAt'];
const GENERATION_PLAIN = ['at', 'by', 'projectId', 'templateId', 'templateName', 'edited', 'copied', 'copiedAt', 'attachments'];
const TEMPLATE_SENSITIVE = ['to', 'cc', 'bcc'];

// Seções do estado que ficam na máquina (por usuário) e chaves legadas descartadas.
const LOCAL_SECTIONS = { hours: ['hours', 'timers', 'timeEntries', 'timeNotes'], prefs: ['workspace'] };
const DROPPED = ['version', 'integrations', 'emailSends', 'cycle'];

const ORDER = '_order'; // ordem do array para tabelas sem coluna position (removida ao recompor)
const projectScope = (id) => `project:${id}`;
const isEmpty = (o) => !o || !Object.keys(o).length;

// Listas globais: tabela, coluna(s) extra, onde guardar a ordem, escopo/partes sensíveis.
const LISTS = [
  { list: 'stages', table: 'stages', pos: 'col' },
  { list: 'cycles', table: 'cycles', pos: 'col', cols: (x) => ({ version: Number.isInteger(x.version) && x.version > 0 ? x.version : 1 }) },
  { list: 'projectTypes', table: 'project_types', pos: 'col' },
  { list: 'originSystems', table: 'origin_systems', pos: 'col' },
  { list: 'checklists', table: 'checklists', pos: 'col' },
  { list: 'checklistItems', table: 'checklist_items', pos: 'col', cols: (x) => ({ checklist_id: x.checklistId }) },
  { list: 'documents', table: 'documents', pos: 'col', local: ['source.path'] },
  { list: 'emailImages', table: 'email_images', pos: 'doc', cols: (x) => ({ storage_path: x.file || '' }) },
  { list: 'scripts', table: 'scripts', pos: 'doc' },
  { list: 'coordinators', table: 'people', pos: 'col', noDoc: true, scope: () => 'global', plain: [] },
  { list: 'connections', table: 'connections', pos: 'doc', scope: () => 'global', plain: CONNECTION_PLAIN, secrets: ['passwordEnc'],
    cols: (x) => ({ env: x.env, auth_kind: x.auth === 'sql' ? 'sql' : 'windows' }) },
  { list: 'emailTemplates', table: 'email_templates', pos: 'col', sensitivePaths: TEMPLATE_SENSITIVE,
    scope: (x) => (x.scope === 'project' && x.projectId ? projectScope(x.projectId) : 'global'),
    cols: (x) => (x.scope === 'project' && x.projectId ? { scope: 'project', project_id: x.projectId } : { scope: 'global', project_id: null }) },
  { list: 'emailGenerations', table: 'email_generations', pos: 'none', scope: (x) => projectScope(x.projectId), plain: GENERATION_PLAIN,
    cols: (x) => ({ project_id: x.projectId, template_id: x.templateId || null }), insertCols: (x) => ({ created_at: x.at || null }) },
];
const LIST_BY_TABLE = Object.fromEntries(LISTS.map((d) => [d.table, d]));

const KNOWN_ROOT = new Set(['settings', 'defaultCycleId', 'projects', ...LISTS.map((d) => d.list), ...Object.values(LOCAL_SECTIONS).flat(), ...DROPPED]);

const keyOf = (table, key) => `${table}|${JSON.stringify(key)}`;

// Divide um item de lista global em doc (claro) / sensitive (cifrar) / local / secrets.
function splitListItem(def, x, i) {
  const { id, ...body } = clone(x);
  let rest = body;
  let local = null;
  let secrets = null;
  if (def.local) { const r = extract(rest, def.local); rest = r.rest; local = isEmpty(r.taken) ? null : r.taken; }
  if (def.secrets) { const r = extract(rest, def.secrets); rest = r.rest; secrets = isEmpty(r.taken) ? null : r.taken; }
  let doc = rest;
  let sensitive = null;
  if (def.plain) { const p = pick(rest, def.plain); doc = p.kept; sensitive = p.others; }
  if (def.sensitivePaths) { const r = extract(rest, def.sensitivePaths); doc = r.rest; sensitive = r.taken; }
  const cols = def.cols ? def.cols(x) : {};
  const insertCols = def.insertCols ? def.insertCols(x) : undefined;
  if (def.pos === 'col') cols.position = i;
  if (def.pos === 'doc' && !def.noDoc) doc = { ...doc, [ORDER]: i };
  const row = { table: def.table, key: { id }, rowId: id, scope: def.scope ? def.scope(x) : null, cols, ...(insertCols ? { insertCols } : {}) };
  if (!def.noDoc) row.doc = doc;
  if (def.scope) row.sensitive = sensitive || {};
  return { row, local, secrets };
}

function decompose(data) {
  const unknown = Object.keys(data).filter((k) => !KNOWN_ROOT.has(k));
  if (unknown.length) throw Object.assign(new Error(`Campos sem classificação para a nuvem: ${unknown.join(', ')}. Classifique em src/persistence/mapping.js.`), { code: 'UNCLASSIFIED' });
  const rows = [];
  const bindings = { projects: {}, lists: {} };
  const secrets = { projects: {}, lists: {} };

  for (const def of LISTS) {
    (data[def.list] || []).forEach((x, i) => {
      const { row, local, secrets: sec } = splitListItem(def, x, i);
      rows.push(row);
      if (local) (bindings.lists[def.list] ||= {})[x.id] = local;
      if (sec) (secrets.lists[def.list] ||= {})[x.id] = sec;
    });
  }

  for (const [k, v] of Object.entries(data.settings || {})) rows.push({ table: 'app_settings', key: { key: `settings.${k}` }, rowId: `settings.${k}`, scope: null, cols: { value: v === undefined ? null : v } });
  if (data.defaultCycleId !== undefined) rows.push({ table: 'app_settings', key: { key: 'root.defaultCycleId' }, rowId: 'root.defaultCycleId', scope: null, cols: { value: data.defaultCycleId } });

  (data.projects || []).forEach((p, pi) => {
    const { id, checklists = [], contacts = [], ...body } = clone(p);
    const scope = projectScope(id);
    const loc = extract(body, PROJECT_LOCAL);
    const sec = extract(loc.rest, PROJECT_SECRETS);
    const { kept: doc, others: sensitive } = pick(sec.rest, PROJECT_PLAIN);
    if (!isEmpty(loc.taken)) bindings.projects[id] = loc.taken;
    if (!isEmpty(sec.taken)) secrets.projects[id] = sec.taken;
    rows.push({ table: 'projects', key: { id }, rowId: id, scope, doc: { ...doc, [ORDER]: pi }, sensitive,
      cols: { cycle_id: p.cycleId ?? null, project_type_id: p.projectTypeId ?? null, origin_system_id: p.originSystemId ?? null, step_id: p.stepId ?? null } });
    checklists.forEach((inst, ci) => {
      const r = extract(inst, CHECKLIST_SENSITIVE);
      rows.push({ table: 'project_checklists', key: { project_id: id, step_id: inst.stepId }, rowId: `${id}:${inst.stepId}`, scope, cols: {}, doc: { ...r.rest, [ORDER]: ci }, sensitive: r.taken });
    });
    contacts.forEach((c, i) => {
      const { id: cid, ...rest } = c;
      rows.push({ table: 'project_contacts', key: { id: cid }, rowId: cid, scope, cols: { project_id: id, kind: ['stakeholder', 'client'].includes(c.kind) ? c.kind : 'other', position: i }, sensitive: rest });
    });
  });

  // Colunas exatamente como o banco devolve (ausente = null): o conteúdo comparado pelo Unit of Work é o mesmo nos dois lados.
  for (const r of rows) {
    const extra = Object.keys(r.cols).filter((c) => !COLS[r.table].includes(c));
    if (extra.length) throw new Error(`Coluna sem mapeamento em ${r.table}: ${extra.join(', ')}`);
    r.cols = Object.fromEntries(COLS[r.table].map((c) => [c, r.cols[c] === undefined ? null : r.cols[c]]));
  }

  const local = {};
  for (const [section, keys] of Object.entries(LOCAL_SECTIONS)) {
    local[section] = {};
    for (const k of keys) if (data[k] !== undefined) local[section][k] = clone(data[k]);
  }
  local.bindings = bindings;
  local.secrets = secrets;
  return { rows, local };
}

// Linhas lógicas (já decifradas) + seções locais → estado do app.
function compose(rows, local = {}) {
  const data = { settings: {}, projects: [] };
  for (const def of LISTS) data[def.list] = [];
  const bindings = local.bindings || { projects: {}, lists: {} };
  const secrets = local.secrets || { projects: {}, lists: {} };
  const byTable = new Map();
  for (const r of rows) (byTable.get(r.table) || byTable.set(r.table, []).get(r.table)).push(r);

  for (const def of LISTS) {
    const list = (byTable.get(def.table) || []).map((r) => {
      let x = { id: r.key.id, ...(r.doc || {}), ...(r.sensitive && def.plain ? r.sensitive : {}) };
      if (def.sensitivePaths) x = inject(x, r.sensitive);
      const order = def.pos === 'col' ? r.cols.position : def.pos === 'doc' ? x[ORDER] : x.at;
      delete x[ORDER];
      const loc = bindings.lists?.[def.list]?.[x.id];
      if (loc) x = inject(x, loc);
      const sec = secrets.lists?.[def.list]?.[x.id];
      if (sec) x = inject(x, sec);
      return { x, order: order ?? '', id: String(x.id) };
    });
    list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    data[def.list] = list.map((e) => e.x);
  }

  for (const r of byTable.get('app_settings') || []) {
    if (r.key.key === 'root.defaultCycleId') data.defaultCycleId = r.cols.value;
    else if (r.key.key.startsWith('settings.')) data.settings[r.key.key.slice(9)] = r.cols.value;
  }

  const checklists = new Map();
  for (const r of byTable.get('project_checklists') || []) {
    const arr = checklists.get(r.key.project_id) || checklists.set(r.key.project_id, []).get(r.key.project_id);
    const inst = inject(r.doc, r.sensitive);
    arr.push({ inst, order: inst[ORDER] ?? 0 });
    delete inst[ORDER];
  }
  const contacts = new Map();
  for (const r of (byTable.get('project_contacts') || []).slice().sort((a, b) => a.cols.position - b.cols.position)) {
    const arr = contacts.get(r.cols.project_id) || contacts.set(r.cols.project_id, []).get(r.cols.project_id);
    arr.push({ id: r.key.id, ...r.sensitive });
  }
  const projects = (byTable.get('projects') || []).map((r) => {
    let p = { id: r.key.id, ...r.doc, ...r.sensitive };
    const order = p[ORDER] ?? 0;
    delete p[ORDER];
    if (bindings.projects?.[p.id]) p = inject(p, bindings.projects[p.id]);
    if (secrets.projects?.[p.id]) p = inject(p, secrets.projects[p.id]);
    p.checklists = (checklists.get(p.id) || []).sort((a, b) => a.order - b.order).map((e) => e.inst);
    p.contacts = contacts.get(p.id) || [];
    return { p, order };
  });
  data.projects = projects.sort((a, b) => a.order - b.order).map((e) => e.p);

  for (const [section, keys] of Object.entries(LOCAL_SECTIONS)) {
    for (const k of keys) if (local[section] && local[section][k] !== undefined) data[k] = clone(local[section][k]);
  }
  return data;
}

// JSON canônico (chaves ordenadas): base da comparação do Unit of Work.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const rowContent = (r) => canonical({ cols: r.cols, doc: r.doc, sensitive: r.sensitive ?? null });

// Ordem das tabelas no lote (pais antes dos filhos); exclusões na ordem inversa.
const TABLE_ORDER = ['stages', 'cycles', 'project_types', 'origin_systems', 'checklists', 'checklist_items', 'documents', 'email_images',
  'scripts', 'people', 'connections', 'app_settings', 'projects', 'project_checklists', 'project_contacts', 'email_templates', 'email_generations'];
const ENCRYPTED_TABLES = new Set(['projects', 'project_checklists', 'project_contacts', 'people', 'connections', 'email_templates', 'email_generations']);
const PK = { project_checklists: ['project_id', 'step_id'], app_settings: ['key'] };
const pkOf = (table) => PK[table] || ['id'];

// Colunas que fazem parte do CONTEÚDO de cada tabela (as mesmas que `decompose` produz). Datas do banco (created_at…) ficam de fora
// de propósito: voltam em outro formato e fariam o Unit of Work enxergar mudança onde não há.
const COLS = {
  stages: ['position'], cycles: ['position', 'version'], project_types: ['position'], origin_systems: ['position'], checklists: ['position'],
  checklist_items: ['position', 'checklist_id'], documents: ['position'], email_images: ['storage_path'], scripts: [], people: ['position'],
  connections: ['env', 'auth_kind'], email_templates: ['position', 'scope', 'project_id'], email_generations: ['project_id', 'template_id'],
  app_settings: ['value'], projects: ['cycle_id', 'project_type_id', 'origin_system_id', 'step_id'], project_checklists: [],
  project_contacts: ['project_id', 'kind', 'position'],
};
const HAS_DOC = new Set(Object.keys(COLS).filter((t) => !['people', 'project_contacts', 'app_settings'].includes(t)));

// Linha do banco (sem a parte cifrada) → linha lógica (sem `sensitive`; o backend decifra e completa).
function fromDb(table, db) {
  const key = Object.fromEntries(pkOf(table).map((k) => [k, db[k]]));
  const rowId = table === 'project_checklists' ? `${db.project_id}:${db.step_id}` : table === 'app_settings' ? db.key : db.id;
  const cols = Object.fromEntries(COLS[table].map((c) => [c, db[c] === undefined ? null : db[c]]));
  let scope = null;
  if (['projects'].includes(table)) scope = projectScope(db.id);
  else if (['project_checklists', 'project_contacts', 'email_generations'].includes(table)) scope = projectScope(db.project_id);
  else if (table === 'email_templates') scope = db.scope === 'project' && db.project_id ? projectScope(db.project_id) : 'global';
  else if (table === 'people' || table === 'connections') scope = 'global';
  const row = { table, key, rowId, scope, cols };
  if (HAS_DOC.has(table)) row.doc = db.doc || {};
  return row;
}

module.exports = { decompose, compose, canonical, rowContent, keyOf, TABLE_ORDER, ENCRYPTED_TABLES, pkOf, projectScope, LISTS, LIST_BY_TABLE, COLS, fromDb,
  PROJECT_PLAIN, PROJECT_LOCAL, PROJECT_SECRETS, CHECKLIST_SENSITIVE, LOCAL_SECTIONS, DROPPED };
