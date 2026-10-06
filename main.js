// Aplicativo desktop (Electron): abre o Gerenciador de Projetos numa janela própria.
// O servidor local (server.js) roda dentro do próprio aplicativo, escutando só em 127.0.0.1.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const crypto = require('crypto');

const APP_NAME = 'Gerenciador de Projetos';
const BASE_PORT = 4317;

// Dados (projetos, conexões e auditoria): pasta "data" ao lado da pasta do aplicativo — a mesma usada
// pelo modo web (iniciar.bat), então os dois modos enxergam os mesmos projetos.
const exeDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const dataDir = process.env.GP_DATA_DIR || (app.isPackaged ? path.join(exeDir, '..', 'data') : path.join(__dirname, 'data'));

let win = null;
let server = null;
let launchToken = null; // modo nuvem: a janela abre com o token desta execução (a API local só atende quem tem o cookie)

if (!app.requestSingleInstanceLock()) {
  app.quit(); // já existe uma janela aberta: ela é trazida para frente (evento abaixo)
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > start + 30) return reject(new Error('Nenhuma porta local livre encontrada.'));
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function startServer() {
  const port = await freePort(BASE_PORT);
  process.env.PORT = String(port); // lido por server.js na hora do require (lista de hosts permitidos)
  process.env.GP_DATA_DIR = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  if (!app.isPackaged) require('./src/config').loadDotEnv(__dirname); // desenvolvimento: .env da raiz (só GP_* e PORT)
  process.env.GP_LAUNCH_TOKEN = crypto.randomBytes(24).toString('hex');
  const { app: web, session, launch } = require('./server');
  launchToken = launch ? launch.token : null;
  await new Promise((resolve, reject) => {
    server = web.listen(port, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  await session.restore().catch(() => false); // "manter conectado" (modo nuvem)
  return port;
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 960, minHeight: 600,
    title: APP_NAME, backgroundColor: '#002233', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icone.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  const home = `http://localhost:${port}`;
  // Links externos abrem fora do app: sites/WhatsApp (https) no navegador padrão e e-mail (mailto:) no programa de e-mail.
  // Qualquer outro protocolo (file:, ms-*:, etc.) é ignorado.
  const openExternal = (url) => { if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(home)) return;
    e.preventDefault();
    openExternal(url);
  });
  win.on('closed', () => { win = null; });
  win.loadURL(launchToken ? `${home}/?k=${launchToken}` : home);
}

// Autoteste (usado ao gerar o executável): sobe o servidor, confere a API e a biblioteca do SQL Server e sai.
async function selfTest(port) {
  const out = { ok: false, port, dataDir, packaged: app.isPackaged };
  try {
    const state = await fetch(`http://localhost:${port}/api/state`).then((r) => r.json());
    out.projetos = state.projects.length;
    // Mesmo caminho do uso real: operações de banco rodam num processo-filho com timeout (dbworker.js).
    const db = require('./src/db');
    const local = await db.testConnection({ server: 'localhost', database: 'master', auth: 'windows' }, '');
    out.sql = local.ok ? local.server : `ERRO: ${local.error}`;
    const t0 = Date.now(); // VPN caída simulada (endereço de documentação, inalcançável): deve falhar rápido com mensagem clara
    const off = await db.testConnection({ server: '192.0.2.1', database: 'X', auth: 'windows' }, '');
    out.servidorInalcancavel = { falhou: !off.ok, segundos: Number(((Date.now() - t0) / 1000).toFixed(1)), mensagem: off.error };
    const rapido = !off.ok && Date.now() - t0 < 12000;
    const depois = await db.testConnection({ server: 'localhost', database: 'master', auth: 'windows' }, ''); // segue respondendo
    out.localDepois = depois.ok;
    // Workspace: a rota responde e o Git instalado foi encontrado.
    const wsm = await fetch(`http://localhost:${port}/api/wsm`).then((r) => r.json());
    out.workspace = { root: wsm.root || '(não configurado)', vscode: wsm.vscode };
    out.git = wsm.git?.available ? wsm.git.version : 'não encontrado';
    out.ok = local.ok && rapido && depois.ok && typeof wsm.rootExists === 'boolean';
  } catch (e) { out.erro = String(e.message || e); }
  fs.writeFileSync(process.env.GP_SELFTEST_OUT || path.join(exeDir, 'selftest.json'), JSON.stringify(out, null, 2));
  app.exit(out.ok ? 0 : 1);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    const port = await startServer();
    if (process.env.GP_SELFTEST) return selfTest(port);
    createWindow(port);
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `Não foi possível iniciar o aplicativo.\n\n${e.message}`);
    app.exit(1);
  }
});

app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
