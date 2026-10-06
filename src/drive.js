// src/drive.js
// Integração com a Google Drive API v3 (googleapis).
//
// Funcionalidades:
//   - Autenticação via Service Account (JSON key file) ou OAuth2 (token salvo em disco).
//   - uploadFile(filePath, mimeType, folderId)    → { id, name, webViewLink }
//   - downloadFile(fileId, destinationPath)        → { path, size }
//   - listFiles(folderId, opts?)                   → [{ id, name, mimeType, size, modifiedTime }]
//   - getFolderMetadata(folderId)                  → { id, name, webViewLink }
//   - parseDriveFolderUrl(url)                     → { url } | null   (legado — atalho de link)
//
// Configuração (variáveis de ambiente):
//   GP_DRIVE_KEYFILE     Caminho do JSON da Service Account (opcional; tem prioridade)
//   GP_DRIVE_CREDENTIALS Caminho do JSON de credenciais OAuth2 (client_id, client_secret, redirect_uris)
//   GP_DRIVE_TOKEN       Caminho do JSON do token OAuth2 salvo (access_token, refresh_token, …)
//   GP_DRIVE_SCOPE       Escopo padrão (padrão: https://www.googleapis.com/auth/drive)
//
// Quando nenhuma credencial estiver configurada, as funções de API lançam DRIVE_NOT_CONFIGURED.
// A função parseDriveFolderUrl() continua funcionando sem credenciais (só valida o URL).
'use strict';
const fs   = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// googleapis é opcional — importado sob demanda para não quebrar o app antes da instalação.
let _googleapis = null;
function requireGoogleapis() {
  if (!_googleapis) {
    try {
      _googleapis = require('googleapis');
    } catch (e) {
      throw Object.assign(
        new Error('Dependência "googleapis" não encontrada. Execute: npm install googleapis\n' + e.message),
        { code: 'DRIVE_DEPENDENCY_MISSING', status: 503 }
      );
    }
  }
  return _googleapis;
}

// ─── Erros ───────────────────────────────────────────────────────────────────

function driveError(msg, code, extra = {}) {
  return Object.assign(new Error(msg), { code, status: extra.status || 500, ...extra });
}

// ─── Autenticação ────────────────────────────────────────────────────────────

/**
 * Retorna um cliente autenticado do Google (google.auth.GoogleAuth ou OAuth2Client).
 * Prioridade: Service Account key file > OAuth2 credentials + token salvo.
 * Resultado é cacheado na memória durante a vida do processo.
 */
let _authClient = null;

async function getAuth() {
  if (_authClient) return _authClient;

  const { google } = requireGoogleapis();
  const SCOPE = process.env.GP_DRIVE_SCOPE || 'https://www.googleapis.com/auth/drive';

  // ── Opção 1: Service Account ──────────────────────────────────────────────
  const keyFile = process.env.GP_DRIVE_KEYFILE;
  if (keyFile) {
    if (!fs.existsSync(keyFile)) {
      throw driveError(`Arquivo de Service Account não encontrado: ${keyFile}`, 'DRIVE_KEYFILE_NOT_FOUND', { status: 503 });
    }
    const auth = new google.auth.GoogleAuth({ keyFile, scopes: [SCOPE] });
    _authClient = await auth.getClient();
    return _authClient;
  }

  // ── Opção 2: OAuth2 (credentials + token) ────────────────────────────────
  const credFile  = process.env.GP_DRIVE_CREDENTIALS;
  const tokenFile = process.env.GP_DRIVE_TOKEN;

  if (credFile && tokenFile) {
    if (!fs.existsSync(credFile))  throw driveError(`Arquivo de credenciais OAuth2 não encontrado: ${credFile}`,  'DRIVE_CRED_NOT_FOUND',   { status: 503 });
    if (!fs.existsSync(tokenFile)) throw driveError(`Arquivo de token OAuth2 não encontrado: ${tokenFile}`, 'DRIVE_TOKEN_NOT_FOUND',  { status: 503 });

    const creds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
    const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    oauth2.setCredentials(token);

    // Persiste refresh de token automaticamente
    oauth2.on('tokens', (newToken) => {
      const merged = { ...token, ...newToken };
      fs.writeFileSync(tokenFile, JSON.stringify(merged, null, 2), 'utf8');
    });

    _authClient = oauth2;
    return _authClient;
  }

  // ── Nenhuma credencial configurada ────────────────────────────────────────
  throw driveError(
    'Google Drive não configurado. Defina GP_DRIVE_KEYFILE (Service Account) ' +
    'ou GP_DRIVE_CREDENTIALS + GP_DRIVE_TOKEN (OAuth2) no arquivo .env.',
    'DRIVE_NOT_CONFIGURED',
    { status: 503 }
  );
}

/** Retorna um cliente drive v3 autenticado. */
async function getDriveClient() {
  const { google } = requireGoogleapis();
  const auth = await getAuth();
  return google.drive({ version: 'v3', auth });
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Faz upload de um arquivo local para o Google Drive.
 *
 * @param {string}  filePath   Caminho absoluto do arquivo local
 * @param {string}  [mimeType] MIME type (ex: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
 *                             Se omitido, tenta detectar pela extensão.
 * @param {string}  [folderId] ID da pasta de destino no Drive (null = raiz do Drive)
 * @returns {Promise<{id: string, name: string, webViewLink: string, size: number}>}
 */
async function uploadFile(filePath, mimeType, folderId) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw driveError(`Arquivo não encontrado para upload: ${filePath}`, 'DRIVE_FILE_NOT_FOUND', { status: 400 });
  }

  const drive     = await getDriveClient();
  const fileName  = path.basename(filePath);
  const resolvedMime = mimeType || _guessMime(filePath);
  const stat      = fs.statSync(filePath);

  const meta = { name: fileName };
  if (folderId) meta.parents = [folderId];

  let response;
  try {
    response = await drive.files.create({
      requestBody: meta,
      media: { mimeType: resolvedMime, body: fs.createReadStream(filePath) },
      fields: 'id, name, webViewLink, size',
    });
  } catch (e) {
    throw driveError(`Falha no upload para o Google Drive: ${e.message}`, 'DRIVE_UPLOAD_FAILED', { status: 502, cause: e });
  }

  return {
    id:          response.data.id,
    name:        response.data.name,
    webViewLink: response.data.webViewLink,
    size:        Number(response.data.size) || stat.size,
  };
}

/**
 * Faz download de um arquivo do Google Drive para o disco.
 *
 * @param {string} fileId          ID do arquivo no Drive
 * @param {string} destinationPath Caminho absoluto de destino (inclui nome do arquivo)
 * @returns {Promise<{path: string, size: number}>}
 */
async function downloadFile(fileId, destinationPath) {
  if (!fileId) throw driveError('fileId é obrigatório.', 'DRIVE_MISSING_ARG', { status: 400 });
  if (!destinationPath) throw driveError('destinationPath é obrigatório.', 'DRIVE_MISSING_ARG', { status: 400 });

  const drive = await getDriveClient();
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  let response;
  try {
    response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  } catch (e) {
    throw driveError(`Falha ao baixar arquivo do Google Drive (${fileId}): ${e.message}`, 'DRIVE_DOWNLOAD_FAILED', { status: 502, cause: e });
  }

  const dest = fs.createWriteStream(destinationPath);
  await pipeline(response.data, dest);
  const size = fs.statSync(destinationPath).size;
  return { path: destinationPath, size };
}

/**
 * Lista arquivos de uma pasta do Google Drive.
 *
 * @param {string}  folderId           ID da pasta (null = raiz)
 * @param {object}  [opts]
 * @param {number}  [opts.pageSize=100] Máximo de resultados
 * @param {string}  [opts.query]        Filtro adicional no formato querystring do Drive API
 * @returns {Promise<Array<{id, name, mimeType, size, modifiedTime, webViewLink}>>}
 */
async function listFiles(folderId, opts = {}) {
  const drive    = await getDriveClient();
  const pageSize = Math.min(1000, Math.max(1, opts.pageSize || 100));

  let q = folderId
    ? `'${folderId}' in parents and trashed = false`
    : 'trashed = false';
  if (opts.query) q += ` and (${opts.query})`;

  let response;
  try {
    response = await drive.files.list({
      q,
      pageSize,
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
    });
  } catch (e) {
    throw driveError(`Falha ao listar arquivos no Google Drive: ${e.message}`, 'DRIVE_LIST_FAILED', { status: 502, cause: e });
  }

  return (response.data.files || []).map((f) => ({
    id:           f.id,
    name:         f.name,
    mimeType:     f.mimeType,
    size:         Number(f.size) || 0,
    modifiedTime: f.modifiedTime,
    webViewLink:  f.webViewLink,
  }));
}

/**
 * Retorna os metadados de uma pasta do Google Drive pelo ID.
 *
 * @param {string} folderId  ID da pasta no Drive
 * @returns {Promise<{id, name, webViewLink}>}
 */
async function getFolderMetadata(folderId) {
  if (!folderId) throw driveError('folderId é obrigatório.', 'DRIVE_MISSING_ARG', { status: 400 });

  const drive = await getDriveClient();
  let response;
  try {
    response = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, mimeType, webViewLink',
    });
  } catch (e) {
    throw driveError(`Pasta não encontrada no Google Drive (${folderId}): ${e.message}`, 'DRIVE_FOLDER_NOT_FOUND', { status: 404, cause: e });
  }

  const f = response.data;
  if (f.mimeType !== 'application/vnd.google-apps.folder') {
    throw driveError(`O ID "${folderId}" não é uma pasta do Google Drive.`, 'DRIVE_NOT_A_FOLDER', { status: 400 });
  }

  return { id: f.id, name: f.name, webViewLink: f.webViewLink };
}

// ─── Helpers internos ────────────────────────────────────────────────────────

const MIME_MAP = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls':  'application/vnd.ms-excel',
  '.csv':  'text/csv',
  '.pdf':  'application/pdf',
  '.sql':  'text/plain',
  '.txt':  'text/plain',
  '.json': 'application/json',
  '.zip':  'application/zip',
};

function _guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// ─── Legado: parseDriveFolderUrl ─────────────────────────────────────────────
// Mantida para compatibilidade com as rotas existentes do server.js que verificam
// se o link de pasta raiz de um projeto é um URL válido do Google Drive.

/**
 * Valida e normaliza um link de pasta do Google Drive.
 * Não requer autenticação — só valida o URL.
 *
 * @param {string} url
 * @returns {{ url: string } | null}
 */
function parseDriveFolderUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com') return null;
  return { url: u.toString() };
}

// ─── Invalidação de cache de autenticação (útil em testes) ───────────────────

function resetAuthCache() {
  _authClient = null;
}

module.exports = {
  // API principal
  uploadFile,
  downloadFile,
  listFiles,
  getFolderMetadata,
  // Legado / utilitário
  parseDriveFolderUrl,
  // Internos expostos para testes
  getAuth,
  getDriveClient,
  resetAuthCache,
};
