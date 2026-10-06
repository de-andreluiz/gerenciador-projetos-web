const path = require('path');
// Executado direto (node server.js): lê o .env da raiz (só chaves GP_* e PORT). Testes nunca leem o .env.
if (require.main === module) require('./src/config').loadDotEnv(__dirname);
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');

// ── Criptografia cross-platform (substitui secrets.js / DPAPI Windows) ────────
const { protect, unprotect } = require('./src/crypto-secrets');

const PORT = Number(process.env.PORT) || 4317;
const DATA_DIR = process.env.GP_DATA_DIR || path.join(__dirname, 'data');
const PLAN_TTL_MS = 20 * 60 * 1000;
const UPLOAD_TMP  = path.join(DATA_DIR, '.upload-tmp');

// ── Persistência: SQLite (padrão web) | local JSON | cloud (Supabase) ─────────
const { Store } = require('./src/store');
const { Audit } = require('./src/audit');

const STORAGE_BACKEND = process.env.GP_STORAGE_BACKEND || 'json';
let store = new Store(DATA_DIR);
let audit = new Audit(DATA_DIR);
let CLOUD = false;
let appCfg = require('./src/config').appConfig();
let session = null;
let launch = null;
const { parseSheetUrl } = require('./src/sheets');
const { parseDriveFolderUrl, uploadFile: driveUpload, listFiles: driveListFiles, getFolderMetadata } = require('./src/drive');
const configApi = require('./src/config-api');
const { readWorkbook } = require('./src/xlsx');
const plans = require('./src/sqlplan');
const db = require('./src/db');
const { projectSchedule, todayStr, DEFAULT_WARN_DAYS } = require('./src/schedule');
const { uid, httpError, str, sanitizeFileName } = require('./src/util');
const checklist = require('./src/checklist');
const cycles = require('./src/cycles');

// ── Upload de arquivos (substitui dialogs.js / seletor nativo Windows) ────────
let multer;
try { multer = require('multer'); } catch { /* multer opcional — endpoints de upload retornam 503 se ausente */ }

// ── Fábrica de store conforme GP_STORAGE_BACKEND ──────────────────────────────
async function initStore() {
  const appCfg = require('./src/config').appConfig();
  const CLOUD  = appCfg.mode === 'cloud';
  const backend = process.env.GP_STORAGE_BACKEND || (require.main === module ? 'sqlite' : 'json');

  if (backend === 'sqlite') {
    const { createSqliteStore } = require('./src/sqlite-db');
    const s = await createSqliteStore(DATA_DIR);
    console.log(`[store] SQLite — ${path.join(DATA_DIR, 'app.db')}`);
    return { store: s, audit: new Audit(DATA_DIR), CLOUD: false, appCfg, session: null };
  }

  if (backend === 'cloud' || CLOUD) {
    const { Store } = require('./src/store');
    const { localRoot } = require('./src/persistence/local-user-data');
    const { SignedOutBackend } = require('./src/persistence/signed-out-backend');
    const s = new Store(DATA_DIR, { backend: new SignedOutBackend() });
    return { store: s, audit: new Audit(path.join(localRoot(), 'logs')), CLOUD: true, appCfg, session: null };
  }

  // Fallback: JSON local legado
  const { Store } = require('./src/store');
  const s = new Store(DATA_DIR);
  console.log(`[store] JSON local — ${path.join(DATA_DIR, 'projects.json')}`);
  return { store: s, audit: new Audit(DATA_DIR), CLOUD: false, appCfg, session: null };
}

const app = express();
app.disable('x-powered-by');

// ---------- Segurança ----------
// Aceita apenas requisições de localhost (bloqueia DNS rebinding e CSRF).
const okHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
app.use((req, res, next) => {
  if (!okHosts.has(req.headers.host)) return res.status(403).json({ error: 'Host não permitido.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (!origin || !okHosts.has(origin.replace(/^https?:\/\//, ''))) return res.status(403).json({ error: 'Origem não permitida.' });
  }
  next();
});
app.use(express.json({ limit: '2mb' }));

// ── Sessão e Launch Guard (montados antes das rotas estáticas e de API) ───────
const S = require('./src/auth/session');
function initSession() {
  appCfg = require('./src/config').appConfig();
  CLOUD  = appCfg.mode === 'cloud';
  if (!CLOUD) {
    session = new S.LocalSession({ cfg: appCfg });
    launch  = null;
  } else {
    launch = S.launchGuard(process.env.GP_LAUNCH_TOKEN || undefined);
    const { Store } = require('./src/store');
    const { Audit } = require('./src/audit');
    const { localRoot } = require('./src/persistence/local-user-data');
    const { SignedOutBackend } = require('./src/persistence/signed-out-backend');
    store = new Store(DATA_DIR, { backend: new SignedOutBackend() });
    audit = new Audit(path.join(localRoot(), 'logs'));
    fs.mkdirSync(path.join(localRoot(), 'logs'), { recursive: true });

    const { GoTrueClient }   = require('./src/auth/gotrue');
    const { SupabaseRest }   = require('./src/persistence/supabase-rest');
    const conn = { url: appCfg.supabaseUrl, publishableKey: appCfg.publishableKey };
    session = new S.CloudSession({
      cfg: appCfg, store, audit, gotrue: new GoTrueClient(conn),
      transportFactory: ({ getAccessToken }) => new SupabaseRest({ ...conn, getAccessToken }),
      protect, unprotect,
    });
  }
}
initSession();

app.use((req, res, next) => (launch ? launch.middleware(req, res, next) : next()));
app.use((req, res, next) => (session ? session.middleware()(req, res, next) : next()));
session.mount(app);

app.use(express.static(path.join(__dirname, 'public')));


// ---------- Helpers ----------
const getProject = (id) => store.project(id) || (() => { throw httpError(404, 'Projeto não encontrado.'); })();
const getIn = (list, id, what) => list.find((x) => x.id === id) || (() => { throw httpError(404, `${what} não encontrado(a).`); })();
const dirOk = (p) => !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();

// Multer storage: temporário em DATA_DIR/.upload-tmp (limpo após cada requisição).
function makeUpload(opts = {}) {
  if (!multer) return (req, res, next) => res.status(503).json({ error: 'Módulo multer não instalado. Execute: npm install multer' });
  fs.mkdirSync(UPLOAD_TMP, { recursive: true });
  const storage = multer.diskStorage({
    destination: UPLOAD_TMP,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${sanitizeFileName(file.originalname, 'upload')}`),
  });
  return multer({ storage, limits: { fileSize: opts.maxMb ? opts.maxMb * 1024 * 1024 : 50 * 1024 * 1024 } });
}

// Remove arquivos temporários de upload após processar (evita acúmulo).
function cleanupUpload(req) {
  if (!req.file) return;
  try { fs.unlinkSync(req.file.path); } catch { /* ignora */ }
}

function isAbsPath(p) {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

function cleanDir(p, what) {
  const v = str(p, 500);
  if (!v) return '';
  if (!isAbsPath(v)) throw httpError(400, `${what}: informe um caminho completo (ex.: C:\\Projetos\\Cliente).`);
  return path.normalize(v);
}

// Pasta raiz do projeto: uma pasta local OU o link de uma pasta do Google Drive (nunca as duas ao mesmo tempo).
function cleanRoot(b) {
  if (b.rootDirKind === 'drive') {
    const url = str(b.rootDriveUrl, 600);
    if (url && !parseDriveFolderUrl(url)) throw httpError(400, 'O link precisa ser de uma pasta do Google Drive (https://drive.google.com/...).');
    return { rootDirKind: 'drive', rootDir: '', rootDriveUrl: url };
  }
  return { rootDirKind: 'local', rootDir: cleanDir(b.rootDir, 'Pasta raiz'), rootDriveUrl: '' };
}

// Grupo do WhatsApp do projeto: só o link de convite (https://chat.whatsapp.com/...); vazio = sem grupo.
function cleanWaGroup(v) {
  const s = str(v, 300);
  if (!s) return '';
  const url = require('./src/contacts').waGroupUrl(s);
  if (!url) throw httpError(400, 'O link do grupo precisa ser um convite do WhatsApp (https://chat.whatsapp.com/…).');
  return url;
}

// Conexão de uma base: dados próprios OU referência a uma conexão cadastrada ({ connectionId, database }).
// resolveConn devolve a conexão completa (servidor, login, senha criptografada) — é o que o acesso ao banco usa.
function resolveConn(c) {
  if (!c) return null;
  if (!c.connectionId) return c;
  const saved = store.data.connections.find((x) => x.id === c.connectionId);
  if (!saved) throw httpError(400, 'A conexão cadastrada usada por esta base foi removida. Edite a base e escolha outra conexão.');
  const { id, name, env, allowDestructive, notes, createdAt, updatedAt, ...conn } = saved;
  return { ...conn, database: c.database || saved.database, connectionId: saved.id, connectionName: saved.name };
}

function publicConn(c) {
  if (!c) return null;
  let full = c;
  if (c.connectionId) { try { full = resolveConn(c); } catch { return { connectionId: c.connectionId, database: c.database, missing: true, hasPassword: false }; } }
  const { passwordEnc, ...rest } = full;
  return { ...rest, hasPassword: !!passwordEnc };
}

// Andamento do checklist de cada passo do ciclo (só números; os itens e as evidências vêm por /api/projects/:id/checklists).
function checklistSummary(p) {
  const out = {};
  for (const c of checklist.stepsOf(p)) out[c.id] = checklist.progressForStep(store.data, p, c.id);
  return out;
}

function publicProject(p) {
  const warn = store.data.settings.warnDays ?? DEFAULT_WARN_DAYS;
  const { checklists, ...rest } = p;
  return {
    ...rest,
    checklist: checklistSummary(p),
    pendencies: checklist.projectPendencies(p), // obrigatórios pendentes no projeto inteiro (inclui herdados), para não haver "falso 100%"
    progress: checklist.projectProgress(store.data, p), // % do ciclo inteiro (barra da lateral e da Visão Geral; única fonte)
    cycleUpdate: cycles.cycleDiff(store.data, p), // "nova versão do ciclo disponível" (nada muda até aplicar)
    // Pasta local: existe/não existe. Link do Drive: não dá para checar sem login no Google, então fica null (n/a).
    rootDirExists: p.rootDirKind === 'drive' ? null : dirOk(p.rootDir),
    schedule: projectSchedule(p, todayStr(), warn),
    bases: p.bases.map((b) => ({ ...b, directoryExists: dirOk(b.directory), prod: publicConn(b.prod), local: publicConn(b.local) })),
    deparas: p.deparas.map((d) => ({ ...d, targetDirExists: dirOk(d.targetDir), fileExists: !!d.lastDownload && fs.existsSync(d.lastDownload.path), sourceDirExists: d.importMode === 'dir' ? dirOk(d.sourceDir) : null })),
  };
}

async function buildConn(input, existing, { local }) {
  if (input && input.connectionId) { // usar uma conexão cadastrada: guarda só a referência e o banco desta base
    const saved = store.data.connections.find((x) => x.id === input.connectionId);
    if (!saved) throw httpError(400, 'Conexão cadastrada inexistente.');
    if (local && !db.isLoopback(saved.server)) throw httpError(400, `A conexão “${saved.name}” não aponta para esta máquina e não pode ser usada como “Localhost (teste)”.`);
    const database = str(input.database, 128) || saved.database;
    if (!database) throw httpError(400, `Informe o banco desta base (a conexão “${saved.name}” não tem banco padrão).`);
    db.validateConnection({ ...saved, database });
    return { connectionId: saved.id, database };
  }
  if (!input || !input.server) return null;
  const auth = input.auth === 'sql' ? 'sql' : 'windows';
  const conn = {
    server: str(input.server, 200), port: input.port ? Number(input.port) : null, database: str(input.database, 128),
    auth, user: auth === 'sql' ? str(input.user, 128) : '',
    encrypt: input.encrypt !== false, trustServerCertificate: input.trustServerCertificate !== false,
    passwordEnc: auth === 'sql' ? existing?.passwordEnc || null : null,
  };
  db.validateConnection(conn);
  if (local && !db.isLoopback(conn.server)) throw httpError(400, 'A conexão "Localhost (teste)" precisa apontar para esta máquina (localhost, 127.0.0.1 ou .). Servidores remotos devem ser cadastrados como Produção.');
  if (auth === 'sql' && input.password) conn.passwordEnc = await protect(input.password);
  return conn;
}

// Senha ilegível (chave GP_SECRET_KEY trocada, blob corrompido ou blob DPAPI legado do Windows):
// 409 PASSWORD_UNREADABLE — o usuário precisa re-inserir a senha.
async function connPassword(conn) {
  if (!(conn.auth === 'sql' && conn.passwordEnc)) return '';
  try {
    return await unprotect(conn.passwordEnc);
  } catch (e) {
    if (e.code !== 'PASSWORD_UNREADABLE') throw e;
    const saved = conn.connectionId ? store.data.connections.find((x) => x.id === conn.connectionId) : store.data.connections.find((x) => x.passwordEnc === conn.passwordEnc);
    const where = saved ? `da conexão “${saved.name}”` : 'desta base';
    const fix = saved ? `Abra Configurações → Conexões, edite “${saved.name}”, informe a senha novamente e salve.` : 'Edite a base, informe a senha novamente e salve.';
    audit.log({ action: 'senha-ilegivel', detalhe: saved ? saved.name : 'conexão própria de base', server: db.label(conn) });
    throw httpError(409, `Não foi possível ler a senha salva ${where}. Isso ocorre quando a chave GP_SECRET_KEY mudou, o blob foi corrompido, ou a senha foi gerada com criptografia DPAPI do Windows (incompatível com este ambiente).\n\n${fix}`,
      { code: 'PASSWORD_UNREADABLE', connectionId: saved ? saved.id : null });
  }
}

// Modo Web / Linux: SYS (caminho do System32 do Windows) é null. Os módulos tratam SYS=null graciosamente.
const SYS = null;

// Conexões cadastradas (reutilizadas pelas bases e pela execução de scripts): mesmo formato, mesma senha, mesmo teste.
const connectionsMod = require('./src/connections-api').mount(app, { store, audit, db, buildConn: (b, ex, o) => buildConn({ ...b, connectionId: undefined }, ex, o), publicConn, connPassword });
// Coordenadores, estágios, ciclo, etapa do projeto, correções e documentos (src/config-api.js).
const cfg = configApi.mount(app, { store, audit, getProject, getIn, publicProject, SYS });
// Scripts SQL do usuário, executados depois da importação (src/scripts-api.js; arquivos em <data>\scripts).
const scriptsApi = require('./src/scripts-api');
const scriptsMod = scriptsApi.mount(app, { store, dataDir: DATA_DIR, SYS });
// Checklist por estágio: modelo, execução por projeto e evidências (src/checklist-api.js; arquivos em <data>\evidencias).
require('./src/checklist-api').mount(app, { store, audit, getProject, getIn, dataDir: DATA_DIR, SYS, publicProject });
// Executar scripts de apoio pelo checklist, com as mesmas travas dos scripts pós-importação (src/script-run.js).
require('./src/script-run').mount(app, { store, audit, db, getProject, dataDir: DATA_DIR, resolveConn, connPassword, publicProject });
// Controle de horas: jornada, cronômetros, apontamentos e exportação mensal (src/hours-api.js).
require('./src/hours-api').mount(app, { store, audit, dataDir: DATA_DIR, SYS });
const cleanCoordinatorId = (id) => {
  if (!id) return null;
  if (!store.data.coordinators.some((c) => c.id === id)) throw httpError(400, 'Coordenador inexistente.');
  return id;
};
// Analista responsável: vem do mesmo cadastro de pessoas (Configurações → Responsáveis), sem estrutura duplicada.
const cleanAnalystId = (id) => {
  if (!id) return null;
  if (!store.data.coordinators.some((c) => c.id === id)) throw httpError(400, 'Analista inexistente.');
  return id;
};
// Mesma checagem para as tags de tipo de projeto / sistema de origem (catálogos em src/config-api.js).
const cleanTagRef = (list, what) => (id) => {
  if (!id) return null;
  if (!store.data[list].some((s) => s.id === id)) throw httpError(400, `${what} inexistente.`);
  return id;
};
const cleanProjectTypeId = cleanTagRef('projectTypes', 'Tipo de projeto');
const cleanConnectionRef = cleanTagRef('connections', 'Conexão');
const cleanOriginSystemId = cleanTagRef('originSystems', 'Sistema de origem');

// ---------- Estado / Projetos ----------
app.get('/api/state', (req, res) => {
  res.json({ settings: store.data.settings, today: todayStr(), ...cfg.extras(), connections: store.data.connections.map(connectionsMod.publicSaved), projects: store.data.projects.map(publicProject) });
});

app.put('/api/settings', async (req, res) => {
  const d = Number(req.body.warnDays);
  if (!Number.isInteger(d) || d < 0 || d > 365) throw httpError(400, 'Dias de alerta inválido (0 a 365).');
  store.data.settings.warnDays = d;
  await store.save();
  res.json({ ok: true });
});

app.post('/api/projects', async (req, res) => {
  const name = str(req.body.name, 120);
  if (!name) throw httpError(400, 'Informe o nome do projeto.');
  const p = { id: uid(), name, description: str(req.body.description, 1000), ...cleanRoot(req.body), createdAt: new Date().toISOString(), bases: [], deparas: [], milestones: [],
    coordinatorId: cleanCoordinatorId(req.body.coordinatorId), analystId: cleanAnalystId(req.body.analystId), projectTypeId: cleanProjectTypeId(req.body.projectTypeId), originSystemId: cleanOriginSystemId(req.body.originSystemId),
    stepId: null, stageHistory: [], corrections: [], checklists: [], defaultConnectionId: cleanConnectionRef(req.body.defaultConnectionId), whatsappGroupUrl: cleanWaGroup(req.body.whatsappGroupUrl) };
  // Ciclo: o escolhido, senão o padrão do tipo do projeto, senão o ciclo padrão. O projeto recebe uma CÓPIA dos passos.
  cycles.assignCycle(p, cycles.cycleFor(store.data, { cycleId: str(req.body.cycleId, 40), projectTypeId: p.projectTypeId }));
  store.data.projects.push(p);
  await store.save();
  res.json(publicProject(p));
});

app.put('/api/projects/:id', async (req, res) => {
  const p = getProject(req.params.id);
  const name = str(req.body.name, 120);
  if (!name) throw httpError(400, 'Informe o nome do projeto.');
  Object.assign(p, { name, description: str(req.body.description, 1000), ...cleanRoot(req.body),
    coordinatorId: cleanCoordinatorId(req.body.coordinatorId), projectTypeId: cleanProjectTypeId(req.body.projectTypeId), originSystemId: cleanOriginSystemId(req.body.originSystemId),
    ...(req.body.defaultConnectionId !== undefined ? { defaultConnectionId: cleanConnectionRef(req.body.defaultConnectionId) } : {}),
    ...(req.body.whatsappGroupUrl !== undefined ? { whatsappGroupUrl: cleanWaGroup(req.body.whatsappGroupUrl) } : {}),
    ...(req.body.analystId !== undefined ? { analystId: cleanAnalystId(req.body.analystId) } : {}) }); // quem não envia o campo não apaga o analista
  // Trocar o ciclo de um projeto em andamento pede confirmação: a etapa atual só continua se existir no ciclo novo.
  const wantedCycle = str(req.body.cycleId, 40);
  if (wantedCycle && wantedCycle !== p.cycleId) {
    const c = cycles.cycleFor(store.data, { cycleId: wantedCycle });
    const keeps = !p.stepId || c.steps.some((x) => x.id === p.stepId);
    if (!keeps && !req.body.confirmCycleChange) {
      throw httpError(409, `O projeto está numa etapa que não existe no ciclo “${c.name}”. Ao trocar, ele fica sem etapa definida (o histórico e os checklists já feitos continuam guardados).`, { code: 'CYCLE_CHANGE' });
    }
    cycles.assignCycle(p, c);
    if (!keeps) { p.stageHistory.push({ stepId: null, stageId: null, name: `Sem etapa (ciclo trocado para ${c.name})`, color: '#8FB0BF', at: new Date().toISOString() }); p.stepId = null; }
    audit.log({ action: 'ciclo-aplicado', project: p.name, detalhe: `Ciclo trocado para “${c.name}”` });
  }
  await store.save();
  res.json(publicProject(p));
});

// Remove apenas o cadastro; nenhum arquivo em disco e nenhuma base é tocada.
app.delete('/api/projects/:id', async (req, res) => {
  getProject(req.params.id);
  store.data.projects = store.data.projects.filter((p) => p.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

// ---------- Cronograma (marcos opcionais) ----------
function cleanMilestone(b) {
  const title = str(b.title, 160);
  if (!title) throw httpError(400, 'Informe o título do prazo/entrega.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate || '') || Number.isNaN(Date.parse(b.dueDate))) throw httpError(400, 'Data inválida.');
  const alert = b.alertDays === '' || b.alertDays === null || b.alertDays === undefined ? null : Number(b.alertDays);
  if (alert !== null && (!Number.isInteger(alert) || alert < 0 || alert > 365)) throw httpError(400, 'Dias de alerta inválido.');
  return { title, dueDate: b.dueDate, alertDays: alert, done: !!b.done, note: str(b.note, 500) };
}

app.post('/api/projects/:id/milestones', async (req, res) => {
  const p = getProject(req.params.id);
  p.milestones.push({ id: uid(), ...cleanMilestone(req.body) });
  await store.save();
  res.json(publicProject(p));
});
app.put('/api/projects/:id/milestones/:mid', async (req, res) => {
  const p = getProject(req.params.id);
  Object.assign(getIn(p.milestones, req.params.mid, 'Prazo'), cleanMilestone(req.body));
  await store.save();
  res.json(publicProject(p));
});
app.delete('/api/projects/:id/milestones/:mid', async (req, res) => {
  const p = getProject(req.params.id);
  p.milestones = p.milestones.filter((m) => m.id !== req.params.mid);
  await store.save();
  res.json(publicProject(p));
});

// ---------- Bases de dados ----------
async function cleanBase(b, existing) {
  const name = str(b.name, 120);
  if (!name) throw httpError(400, 'Informe um nome para a base.');
  const prod = await buildConn(b.prod, existing?.prod, { local: false });
  const local = await buildConn(b.local, existing?.local, { local: true });
  if (!prod && !local) throw httpError(400, 'Configure ao menos uma conexão (Produção ou Localhost).');
  return { name, directory: cleanDir(b.directory, 'Diretório da base'), allowProdOverwrite: !!b.allowProdOverwrite, prod, local };
}

app.post('/api/projects/:id/bases', async (req, res) => {
  const p = getProject(req.params.id);
  p.bases.push({ id: uid(), ...(await cleanBase(req.body)) });
  await store.save();
  res.json(publicProject(p));
});
app.put('/api/projects/:id/bases/:bid', async (req, res) => {
  const p = getProject(req.params.id);
  const base = getIn(p.bases, req.params.bid, 'Base');
  Object.assign(base, await cleanBase(req.body, base));
  await store.save();
  res.json(publicProject(p));
});
app.delete('/api/projects/:id/bases/:bid', async (req, res) => {
  const p = getProject(req.params.id);
  p.bases = p.bases.filter((b) => b.id !== req.params.bid);
  await store.save();
  res.json(publicProject(p));
});

// Teste de conexão: apenas SELECT de identificação.
app.post('/api/projects/:id/bases/:bid/test', async (req, res) => {
  const base = getIn(getProject(req.params.id).bases, req.params.bid, 'Base');
  const env = req.body.env === 'prod' ? 'prod' : 'local';
  const conn = resolveConn(base[env]);
  if (!conn) throw httpError(400, 'Esta base não tem conexão configurada para o ambiente escolhido.');
  if (env === 'local' && !db.isLoopback(conn.server)) throw httpError(400, 'Conexão local precisa apontar para esta máquina.');
  const result = await db.testConnection(conn, await connPassword(conn));
  audit.log({ action: 'conexao-testada', project: getProject(req.params.id).name, base: base.name, env, server: db.label(conn), database: conn.database, ok: result.ok });
  res.json(result);
});

// ---------- Planilhas do projeto (anexo de .xlsx baixado do Google Sheets; algumas podem ser importadas ao banco) ----------
function cleanDepara(b) {
  const label = str(b.label, 120);
  if (!label) throw httpError(400, 'Informe um nome para a planilha.');
  const url = str(b.url, 600);
  // O link é opcional (serve só para o atalho "Abrir no Google Sheets"); se informado, precisa ser do Google Sheets.
  if (url && !parseSheetUrl(url)) throw httpError(400, 'O link precisa ser de uma planilha do Google Sheets (https://docs.google.com/spreadsheets/d/...).');
  // Padrão: importável (true), a menos que explicitamente desmarcada. Assim, planilhas cadastradas antes deste
  // campo existir, e novas planilhas sem o usuário mexer na opção, continuam podendo ser importadas.
  // Origem da importação: 'file' (padrão: um .xlsx anexado) ou 'dir' (lote: várias planilhas de um diretório; ver src/import-batch-api.js).
  const importMode = b.importMode === 'dir' ? 'dir' : 'file';
  const sourceDir = cleanDir(b.sourceDir, 'Diretório das planilhas');
  if (importMode === 'dir' && !sourceDir) throw httpError(400, 'Informe o diretório onde ficam as planilhas (importação por diretório).');
  return { label, url, targetDir: cleanDir(b.targetDir, 'Pasta de destino'), fileName: str(b.fileName, 150), importable: b.importable !== false, importMode, sourceDir };
}

app.post('/api/projects/:id/deparas', async (req, res) => {
  const p = getProject(req.params.id);
  p.deparas.push({ id: uid(), lastDownload: null, ...cleanDepara(req.body) });
  await store.save();
  res.json(publicProject(p));
});
app.put('/api/projects/:id/deparas/:did', async (req, res) => {
  const p = getProject(req.params.id);
  Object.assign(getIn(p.deparas, req.params.did, 'Planilha'), cleanDepara(req.body));
  await store.save();
  res.json(publicProject(p));
});
app.delete('/api/projects/:id/deparas/:did', async (req, res) => {
  const p = getProject(req.params.id);
  p.deparas = p.deparas.filter((d) => d.id !== req.params.did);
  await store.save();
  res.json(publicProject(p));
});

// Anexar planilha via upload multipart (substitui seletor de arquivo nativo do Windows).
// O front-end envia o .xlsx com Content-Type: multipart/form-data, campo "file".
// Compatibilidade retroativa: se vier `filePath` no body (legado local), usa a cópia de arquivo.
const xlsxUpload = makeUpload({ maxMb: 50 });
app.post('/api/projects/:id/deparas/:did/attach', xlsxUpload.single('file'), async (req, res) => {
  const p = getProject(req.params.id);
  const d = getIn(p.deparas, req.params.did, 'Planilha');

  let src;
  if (req.file) {
    // Upload via multipart
    src = req.file.path;
  } else if (req.body.filePath) {
    // Legado: caminho de arquivo local (modo desktop/local ainda suportado)
    src = path.resolve(str(req.body.filePath, 600));
  } else {
    throw httpError(400, 'Envie o arquivo .xlsx via upload (campo "file") ou informe filePath.');
  }

  if (!/\.xlsx$/i.test(req.file ? req.file.originalname : src) || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
    cleanupUpload(req);
    throw httpError(400, 'Selecione um arquivo .xlsx existente.');
  }
  const fd = fs.openSync(src, 'r'); const magic = Buffer.alloc(2); fs.readSync(fd, magic, 0, 2, 0); fs.closeSync(fd);
  if (magic.toString('latin1') !== 'PK') { cleanupUpload(req); throw httpError(400, 'O arquivo enviado não é um .xlsx válido.'); }

  // Se não houver pasta de destino configurada, usa o diretório temporário de upload
  let dest;
  if (dirOk(d.targetDir)) {
    let name = sanitizeFileName(d.fileName || d.label, 'depara');
    if (!/\.xlsx$/i.test(name)) name += '.xlsx';
    dest = path.join(d.targetDir, name);
    if (path.resolve(dest) !== path.resolve(src)) {
      if (fs.existsSync(dest) && !req.body.overwrite) { cleanupUpload(req); throw httpError(409, `O arquivo "${name}" já existe na pasta de destino.`, { code: 'EXISTS', path: dest }); }
      fs.copyFileSync(src, dest);
      cleanupUpload(req);
    }
  } else {
    // Sem pasta de destino: mantém no diretório de upload temporário permanente
    const uploadDir = path.join(DATA_DIR, 'uploads', req.params.id);
    fs.mkdirSync(uploadDir, { recursive: true });
    let name = sanitizeFileName(d.fileName || d.label, 'depara') + '.xlsx';
    dest = path.join(uploadDir, name);
    if (src !== dest) { if (fs.existsSync(dest) && !req.body.overwrite) { cleanupUpload(req); throw httpError(409, `O arquivo "${name}" já existe.`, { code: 'EXISTS', path: dest }); } fs.copyFileSync(src, dest); cleanupUpload(req); }
  }

  const size = fs.statSync(dest).size;
  d.lastDownload = { at: new Date().toISOString(), path: dest, size, manual: true };
  await store.save();
  audit.log({ action: 'depara-anexado', project: p.name, planilha: d.label, arquivo: dest, bytes: size });
  res.json({ path: dest, size, project: publicProject(p) });
});

// Upload genérico de .xlsx (sem vincular a um DE-PARA — para a tela de importação).
app.post('/api/upload/xlsx', makeUpload({ maxMb: 50 }).single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, 'Nenhum arquivo enviado (campo "file" ausente).');
  if (!/\.xlsx$/i.test(req.file.originalname)) { cleanupUpload(req); throw httpError(400, 'Apenas arquivos .xlsx são aceitos.'); }
  const fd = fs.openSync(req.file.path, 'r'); const magic = Buffer.alloc(2); fs.readSync(fd, magic, 0, 2, 0); fs.closeSync(fd);
  if (magic.toString('latin1') !== 'PK') { cleanupUpload(req); throw httpError(400, 'O arquivo enviado não é um .xlsx válido.'); }
  // Mover para a pasta de uploads permanentes
  const dest = path.join(DATA_DIR, 'uploads', `${Date.now()}-${sanitizeFileName(req.file.originalname, 'xlsx')}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(req.file.path, dest);
  res.json({ path: dest, name: req.file.originalname, size: fs.statSync(dest).size });
});

// Lista .xlsx disponíveis na pasta de uploads do servidor (substitui /api/downloads/recent do modo desktop).
app.get('/api/uploads/recent', (req, res) => {
  const uploadDir = path.join(DATA_DIR, 'uploads');
  let files = [];
  try {
    files = fs.readdirSync(uploadDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.xlsx$/i.test(e.name) && !e.name.startsWith('~$'))
      .map((e) => { const f = path.join(uploadDir, e.name); const st = fs.statSync(f); return { name: e.name, path: f, mtimeMs: st.mtimeMs, size: st.size }; })
      .filter((f) => Date.now() - f.mtimeMs < 72 * 3600 * 1000) // últimas 72h
      .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20);
  } catch { /* pasta inexistente: lista vazia */ }
  res.json({ dir: uploadDir, files });
});

// Mantém /api/downloads/recent como alias retrocompatível.
app.get('/api/downloads/recent', (req, res) => res.redirect(307, '/api/uploads/recent'));

// ---------- Diálogos / pastas (modo web) ----------
// Os endpoints /api/dialog/* do modo desktop (seletor nativo Windows) são substituídos por stubs
// que retornam null — o front-end deve usar o upload multipart (/api/upload/xlsx) ou campos de texto.
// Mantidos para não quebrar código legado que ainda chame esses endpoints.
function initialDir(body) {
  const cands = [...(Array.isArray(body.starts) ? body.starts : []), body.start].map((x) => str(x, 500)).filter(Boolean).slice(0, 8);
  cands.push(path.join(os.homedir(), 'Documents'));
  for (const c of cands) {
    if (!path.isAbsolute(c)) continue;
    try {
      const st = fs.statSync(c);
      if (st.isDirectory()) return path.normalize(c);
      if (st.isFile() && dirOk(path.dirname(c))) return path.dirname(path.normalize(c));
    } catch { /* inexistente/inacessível */ }
  }
  return '';
}
// Stub: seletor de pasta nativo não disponível no modo web.
app.post('/api/dialog/folder', (req, res) => res.json({ path: null, webMode: true }));
// Stub: seletor de arquivo nativo não disponível no modo web. Use POST /api/upload/xlsx.
app.post('/api/dialog/file', (req, res) => res.json({ path: null, webMode: true }));
app.post('/api/dialog/initial-dir', (req, res) => res.json({ dir: initialDir(req.body) }));

// /api/open-folder: abrir no Explorer não faz sentido em modo web — retorna info da pasta.
app.post('/api/open-folder', (req, res) => {
  const target = path.normalize(str(req.body.path, 500));
  const known = new Set();
  for (const p of store.data.projects) {
    if (p.rootDirKind !== 'drive' && p.rootDir) known.add(p.rootDir);
    p.bases.forEach((b) => known.add(b.directory));
    Object.values(p.environments || {}).forEach((e) => { if (e?.dir) known.add(e.dir); });
    p.deparas.forEach((d) => { known.add(d.targetDir); if (d.sourceDir) known.add(d.sourceDir); if (d.lastDownload) known.add(path.dirname(d.lastDownload.path)); });
  }
  if (!known.has(target) || !dirOk(target)) throw httpError(400, 'Pasta não cadastrada ou inexistente.');
  // Modo web: não abre o Explorer. Retorna os arquivos .xlsx da pasta.
  let files = [];
  try { files = fs.readdirSync(target).filter((f) => /\.xlsx$/i.test(f)).slice(0, 50); } catch { /* sem acesso */ }
  res.json({ ok: true, webMode: true, path: target, files });
});

// ─── Google Drive API ──────────────────────────────────────────────────────────

// Upload de arquivo para o Google Drive.
app.post('/api/drive/upload', makeUpload({ maxMb: 100 }).single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, 'Nenhum arquivo enviado (campo "file" ausente).');
  const folderId = str(req.body.folderId, 200) || null;
  let result;
  try {
    result = await driveUpload(req.file.path, req.file.mimetype, folderId);
  } finally {
    cleanupUpload(req);
  }
  audit.log({ action: 'drive-upload', arquivo: result.name, driveId: result.id, folderId });
  res.json(result);
});

// Lista arquivos de uma pasta do Google Drive.
app.get('/api/drive/files/:folderId', async (req, res) => {
  const folderId = str(req.params.folderId, 200);
  if (!folderId) throw httpError(400, 'folderId ausente.');
  const files = await driveListFiles(folderId, { pageSize: Number(req.query.limit) || 100, query: str(req.query.q, 200) });
  res.json({ folderId, files });
});

// Metadados de uma pasta do Google Drive.
app.get('/api/drive/folder/:folderId', async (req, res) => {
  const folderId = str(req.params.folderId, 200);
  if (!folderId) throw httpError(400, 'folderId ausente.');
  res.json(await getFolderMetadata(folderId));
});

// ---------- Importação XLSX → SQL Server ----------
let wbCache = null; // uma planilha em memória por vez
async function loadWorkbook(filePath) {
  const resolved = path.resolve(filePath || '');
  const st = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
  if (wbCache && st && wbCache.file === resolved && wbCache.mtimeMs === st.mtimeMs && wbCache.size === st.size) return wbCache;
  wbCache = await readWorkbook(resolved);
  return wbCache;
}

app.post('/api/import/inspect', async (req, res) => {
  const wb = await loadWorkbook(str(req.body.filePath, 600));
  res.json({ file: wb.file, size: wb.size, sheets: plans.describeSheets(wb) });
});

// Guarda nomes de tabelas/colunas e tipos usados na importação, para pré-preencher a próxima vez.
// Não guarda o modo de sobrescrita (ação destrutiva nunca vira padrão) nem nenhum dado das células.
function rememberImportConfig(project, cfg) {
  const d = cfg && project.deparas.find((x) => x.id === cfg.deparaId);
  if (!d || !Array.isArray(cfg.sheets)) return;
  d.importConfig = {
    savedAt: new Date().toISOString(),
    schema: str(cfg.schema, 128) || 'dbo',
    sheets: cfg.sheets.slice(0, 100).map((sh) => ({
      sheetName: str(sh.sheetName, 200), include: !!sh.include, tableName: str(sh.tableName, 128),
      columns: (Array.isArray(sh.columns) ? sh.columns : []).slice(0, 1024).map((c) => ({
        index: Number(c.index) || 0, header: str(c.header, 200), include: !!c.include, name: str(c.name, 128), type: plans.TYPES.includes(c.type) ? c.type : 'text',
      })),
    })),
    // Scripts pós-importação escolhidos (ordem incluída). Só ids: o conteúdo é sempre lido do arquivo na hora do plano.
    scripts: {
      enabled: !!cfg.scripts?.enabled,
      ids: (Array.isArray(cfg.scripts?.ids) ? cfg.scripts.ids : []).map((i) => str(i, 40)).filter(Boolean).slice(0, 30),
      vars: scriptsApi.cleanUserVars(cfg.scripts?.vars), // valores das variáveis {{NOME}} definidas pelo usuário
    },
  };
  return store.save(); // quem chama aguarda
}

// Salva na hora (a cada marcação/alteração no passo 2) a seleção de abas e nomes deste DE-PARA, sem precisar gerar o plano.
app.put('/api/projects/:id/deparas/:did/import-config', async (req, res) => {
  const p = getProject(req.params.id);
  getIn(p.deparas, req.params.did, 'Planilha');
  await rememberImportConfig(p, { ...req.body, deparaId: req.params.did });
  res.json({ ok: true });
});

const planStore = new Map();
const jobs = new Map();
const cleanupPlans = () => { const now = Date.now(); for (const [id, p] of planStore) if (p.expiresAt < now) planStore.delete(id); };
// Importação por diretório (lote): mesmo pipeline (leitura, plano, pré-checagem, execução, scripts) e o mesmo mapa de jobs.
require('./src/import-batch-api').mount(app, { store, audit, getProject, getIn, resolveConn, connPassword, db, scriptsMod, scriptsApi, readWorkbook, jobs, PLAN_TTL_MS, whoAmI: require('./src/evidence-http').whoAmI });

app.post('/api/import/plan', async (req, res) => {
  cleanupPlans();
  const project = getProject(str(req.body.projectId, 40));
  const base = getIn(project.bases, str(req.body.baseId, 40), 'Base');
  // Se o pedido veio de uma planilha específica, confirma de novo no servidor que ela está marcada como importável
  // (o botão já vem desabilitado na tela quando não está, mas a trava aqui não depende só da interface).
  if (req.body.deparaId) {
    const dep = getIn(project.deparas, str(req.body.deparaId, 40), 'Planilha');
    if (dep.importable === false) throw httpError(403, `A planilha "${dep.label}" não está marcada para permitir importação. Habilite em "Editar" na planilha.`);
  }
  const env = req.body.env === 'prod' ? 'prod' : 'local';
  const conn = resolveConn(base[env]);
  if (!conn) throw httpError(400, `Esta base não tem conexão de ${env === 'prod' ? 'Produção' : 'Localhost'} configurada.`);
  if (env === 'local' && !db.isLoopback(conn.server)) throw httpError(400, 'Conexão local precisa apontar para esta máquina.');

  // Scripts pós-importação: lidos dos arquivos agora e analisados (bloqueios viram erro 400 aqui, antes de qualquer conexão).
  // Variáveis: as automáticas vêm do destino (nunca da tela); as do usuário vêm do passo 2. Valores com caracteres
  // perigosos são recusados na hora de substituir (ver scripts-api.js).
  const firstSchema = Array.isArray(req.body.sheets) && req.body.sheets[0] ? str(req.body.sheets[0].schema, 128) : '';
  const scriptVars = {
    ...scriptsApi.cleanUserVars(req.body.scriptVars),
    BANCO: conn.database, SCHEMA: firstSchema || 'dbo', SERVIDOR: conn.server, AMBIENTE: env === 'prod' ? 'PRODUCAO' : 'LOCAL', PROJETO: project.name, BASE: base.name,
  };
  const userScripts = await scriptsMod.loadForPlan(req.body.scriptIds, scriptVars);
  // Scripts com DELETE/DROP/TRUNCATE em PRODUÇÃO seguem a mesma regra das tabelas: só se a base permitir sobrescrever/apagar.
  const scriptsDestructiveOk = env === 'local' || !!base.allowProdOverwrite;

  const wb = await loadWorkbook(str(req.body.filePath, 600));
  const plan = plans.buildPlan(wb, req.body.sheets, { env, allowOverwrite: base.allowProdOverwrite, userScripts });
  const pre = await db.precheck(conn, await connPassword(conn), plan.tables.map((t) => ({ schema: t.schema, table: t.table })));

  const issues = [];
  for (const s of userScripts) {
    if (s.analysis.destructive.length && !scriptsDestructiveOk) {
      issues.push(`O script “${s.name}” contém ${s.analysis.destructive.map((d) => `${d.kw} ×${d.count}`).join(', ')} e esta base não permite apagar/sobrescrever em PRODUÇÃO. Habilite a opção em “Editar” na base, ou retire o script desta importação.`);
    }
  }
  if (plan.errors.length) issues.push(`${plan.errors.length}${plan.errors.length >= 50 ? '+' : ''} valor(es) da planilha não puderam ser convertidos para o tipo escolhido.`);
  if (!pre.canCreateTable) issues.push('O login usado não tem permissão CREATE TABLE neste banco.');
  plan.tables.forEach((t, i) => {
    const c = pre.tables[i];
    t.exists = c.exists; t.existingRows = c.rowCount; t.schemaExists = c.schemaExists;
    if (!c.schemaExists) issues.push(`O schema "${t.schema}" não existe no banco (o app não cria schemas).`);
    if (c.exists && t.mode === 'fail') issues.push(`A tabela ${t.schema}.${t.table} já existe. Escolha "Substituir" ou "Renomear a antiga" para essa aba, ou mude o nome.`);
  });

  const target = { server: pre.identity.server, connectedTo: db.label(conn), database: pre.identity.database, login: pre.identity.login, version: pre.identity.version, auth: conn.auth };
  const planId = crypto.randomBytes(16).toString('hex');
  const scriptSummary = userScripts.map((s) => ({ id: s.id, name: s.name, file: s.file, sha256: s.sha256, batches: s.batches.length, variables: s.variables, analysis: s.analysis }));
  const entry = { id: planId, plan, conn, target, projectId: project.id, baseId: base.id, projectName: project.name, baseName: base.name, env, issues, allowScriptsDestructive: scriptsDestructiveOk, scriptSummary, used: false, expiresAt: Date.now() + PLAN_TTL_MS };
  planStore.set(planId, entry);
  await rememberImportConfig(project, req.body.saveConfig);

  const totalRows = plan.tables.reduce((n, t) => n + t.rows, 0);
  // Auditoria: só metadados dos scripts (nome, arquivo, lotes, hash do conteúdo); nunca o texto.
  const auditScripts = scriptSummary.map((s) => ({ nome: s.name, arquivo: s.file, lotes: s.batches, sha256: s.sha256, variaveis: s.variables }));
  audit.log({ action: 'plano-gerado', project: project.name, base: base.name, env, server: target.connectedTo, database: target.database, hash: plan.hash, tabelas: plan.tables.map((t) => ({ tabela: `${t.schema}.${t.table}`, modo: t.mode, linhas: t.rows })), scripts: auditScripts, bloqueios: issues.length });

  res.json({
    planId, hash: plan.hash, env, target, tables: plan.tables, destructive: plan.destructive, errors: plan.errors, issues,
    userScripts: scriptSummary,
    blocked: issues.length > 0, totalRows, statementCount: plan.statements.length,
    expiresAt: entry.expiresAt, scriptPreview: plans.renderScript(plan, target, { preview: true }),
  });
});

app.get('/api/import/plans/:id/script.sql', (req, res) => {
  const e = planStore.get(req.params.id);
  if (!e) throw httpError(404, 'Plano expirado. Gere o plano novamente.');
  res.type('text/plain; charset=utf-8').set('Content-Disposition', `attachment; filename="plano-${e.plan.hash.slice(0, 8)}.sql"`)
    .send('\ufeff' + plans.renderScript(e.plan, e.target));
});

app.post('/api/import/plans/:id/execute', async (req, res) => {
  const e = planStore.get(req.params.id);
  if (!e || e.expiresAt < Date.now()) throw httpError(404, 'Plano expirado. Gere o plano novamente.');
  if (e.used) throw httpError(409, 'Este plano já foi executado. Gere um novo plano.');
  if (e.issues.length) throw httpError(409, 'O plano tem bloqueios e não pode ser executado.');
  if (req.body.hash !== e.plan.hash) throw httpError(409, 'O plano autorizado não corresponde ao plano gerado.');
  // O clique em "Executar" na tela de revisão (que mostra o alvo e o script) é a autorização; a API exige que venha explícita.
  if (req.body.authorized !== true) throw httpError(403, 'Autorização explícita ausente.');
  const dryRun = !!req.body.dryRun;
  if (dryRun && e.env === 'prod') throw httpError(400, 'Simulação só é permitida no Localhost.');

  e.used = true;
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { id: jobId, status: 'running', done: 0, total: e.plan.statements.length, dryRun };
  jobs.set(jobId, job);
  const meta = { project: e.projectName, base: e.baseName, env: e.env, server: e.target.connectedTo, database: e.target.database, login: e.target.login, hash: e.plan.hash, dryRun, tabelas: e.plan.tables.map((t) => ({ tabela: `${t.schema}.${t.table}`, modo: t.mode, linhas: t.rows })),
    scripts: e.scriptSummary.map((s) => ({ nome: s.name, arquivo: s.file, lotes: s.batches, sha256: s.sha256 })) };
  audit.log({ action: 'execucao-iniciada', ...meta });

  (async () => {
    try {
      const r = await db.executePlan(e.conn, await connPassword(e.conn), e.plan, {
        dryRun, allowDestructive: e.plan.destructive.length > 0, allowDestructiveScripts: e.allowScriptsDestructive,
        onProgress: (done) => { job.done = done; },
      });
      Object.assign(job, { status: 'done', result: r });
      audit.log({ action: dryRun ? 'simulacao-concluida' : 'importacao-concluida', ...meta, resultado: r.committed ? 'COMMIT' : 'ROLLBACK (simulação)' });
    } catch (err) {
      Object.assign(job, { status: 'error', error: db.friendly(err), executed: err.executed ?? 0, scripts: err.scriptOutput || [] });
      audit.log({ action: 'importacao-falhou', ...meta, erro: db.friendly(err), resultado: 'ROLLBACK' });
    }
  })();
  res.json({ jobId });
});

// Workspace: pasta raiz com vários projetos — arquivos, cópia entre projetos e Git por projeto (src/workspace-api.js).
// SYS removido: sem PowerShell/Explorer no modo web. Os módulos que usavam SYS para abrir pastas recebem null.
require('./src/workspace-api').mount(app, { store, audit, SYS: null });
require('./src/notes-api').mount(app, { store, audit, getProject, publicProject, SYS: null }); // observações do projeto
require('./src/rm-env-api').mount(app, { store, audit, getProject, publicProject }); // ambientes RM
require('./src/email-api').mount(app, { store, audit, getProject, getIn, publicProject, dataDir: DATA_DIR }); // e-mails (não envia)

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) throw httpError(404, 'Execução não encontrada.');
  res.json(j);
});

app.get('/api/audit', (req, res) => res.json(audit.tail(Math.min(2000, Math.max(1, Number(req.query.limit) || 300)))));

// ---------- Erros ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Erro do multer (arquivo muito grande, tipo inválido)
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo muito grande. Limite: 50 MB.' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    error: status === 500 ? db.friendly(err) : err.message,
    code: err.code, path: err.path, gitOutput: err.gitOutput, current: err.current,
    blocked: err.blocked, timer: err.timer, conflicts: err.conflicts, confirm: err.confirm,
    missing: err.missing, transferable: err.transferable, target: err.target, final: err.final,
    warnings: err.warnings, from: err.from, dependents: err.dependents, usage: err.usage,
    connectionId: err.connectionId,
  });
});



// ── Startup ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    // 1. Inicializa o store (SQLite, JSON ou Supabase) antes de qualquer request.
    const ctx = await initStore();
    store   = ctx.store;
    audit   = ctx.audit;
    CLOUD   = ctx.CLOUD;
    appCfg  = ctx.appCfg;
    if (session) {
      session.store = store;
      session.audit = audit;
    }

    // 2. Sobe o servidor.
    app.listen(PORT, '127.0.0.1', async () => {
      if (CLOUD) await session.restore().catch(() => false);
      const url = `http://localhost:${PORT}/${launch ? `?k=${launch.token}` : ''}`;
      const mode = STORAGE_BACKEND === 'sqlite' ? 'SQLite' : CLOUD ? `nuvem (${appCfg.env})` : 'JSON local';
      console.log(`Gerenciador de Projetos [${mode}] — ${url}  (dados em ${DATA_DIR})`);
      // Abre o navegador (Linux: xdg-open; Windows: start)
      if (process.env.GP_OPEN_BROWSER === '1') {
        const opener = process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
        spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
      }
    });
  })().catch((err) => { console.error('Falha na inicialização:', err); process.exit(1); });
}

module.exports = { app, get store() { return store; }, get session() { return session; }, get launch() { return launch; } };
