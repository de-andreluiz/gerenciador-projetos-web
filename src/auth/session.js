// Sessão do usuário (Fase 4) — vive SÓ no processo local (Node). A tela nunca recebe access/refresh token.
//
//   login (e-mail + senha) ─┐
//   primeiro acesso (código do convite + nova senha) ─┼─► Supabase Auth ─► tokens ─► public.my_profile()
//   esqueci a senha (código de recuperação + nova senha) ─┘                              │
//        status active  → CloudBackend do usuário (dados permitidos pelo RLS) ligado ao Store
//        status pending → só a tela “aguardando configuração pelo administrador” (nenhum dado)
//        status suspended → sai na hora
//   renovação automática antes de expirar · expirou/revogado → Store volta a “sem sessão” e a tela pede login
//   “Manter conectado”: refresh token em arquivo protegido por DPAPI (só este usuário do Windows abre); sem a opção, nada em disco.
//   Sair: revoga a sessão no Auth, zera chaves/cópias temporárias/memória, apaga o arquivo DPAPI.
// Nada aqui registra senha, código, token ou e-mail.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const identity = require('./identity');
const { AUTH_MESSAGES } = require('./gotrue');
const { httpError } = require('../util');
const { localRoot, LocalUserData } = require('../persistence/local-user-data');
const { KeyService } = require('../persistence/keys');
const { CloudBackend } = require('../persistence/cloud-backend');
const { OfflineHoursBackend } = require('../persistence/offline-hours-backend');

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CODE_RE = /^[0-9]{6,10}$/;
const STATUS_MSG = {
  pending: 'Seu acesso foi criado e está aguardando configuração pelo administrador. Você será liberado assim que ele concluir.',
  suspended: AUTH_MESSAGES.SUSPENDED,
  expired: AUTH_MESSAGES.SESSION_EXPIRED,
  offline: 'Modo offline: só o controle de horas está disponível. Quando a conexão voltar, entre com seu usuário para ver os projetos.',
};

const authHttp = (e) => (e && e.code && AUTH_MESSAGES[e.code]
  ? httpError(e.code === 'OFFLINE' ? 503 : e.code === 'RATE_LIMIT' ? 429 : e.code === 'SUSPENDED' ? 403 : e.code === 'WEAK_PASSWORD' || e.code === 'INVALID_CODE' ? 400 : 401, e.message, { code: e.code })
  : e);

// Política mínima de senha (o Supabase Auth também confere a política configurada no painel).
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 12 || p.length > 200 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p)) {
    throw httpError(400, AUTH_MESSAGES.WEAK_PASSWORD, { code: 'WEAK_PASSWORD' });
  }
  return p;
}
function checkEmail(e) {
  const v = String(e || '').trim().toLowerCase();
  if (!EMAIL_RE.test(v)) throw httpError(400, 'Informe um e-mail válido.', { code: 'INVALID_EMAIL' });
  return v;
}
function checkCode(c) {
  const v = String(c || '').replace(/\s+/g, '');
  if (!CODE_RE.test(v)) throw httpError(400, 'Informe o código numérico recebido por e-mail.', { code: 'INVALID_CODE' });
  return v;
}

class CloudSession {
  constructor({ cfg, store, audit, gotrue, transportFactory, protect, unprotect, root = localRoot(), now = Date.now }) {
    Object.assign(this, { cfg, store, audit, gotrue, transportFactory, protect, unprotect, root, now });
    this.mode = 'cloud';
    this.status = 'signed_out';
    this.message = null;
    this.tokens = null;
    this.profile = null;
    this.remember = false;
    this.timer = null;
    this._refreshing = null;
    this.sessionFile = path.join(root, 'session.dpapi.json');
    this.markerFile = path.join(root, 'last-user.dpapi.json'); // último usuário que entrou neste usuário do Windows (modo offline das horas)
    this.offlineCandidate = null;
    this.offlineUser = null;
    this.machineLogs = path.join(root, 'logs');
    identity.setProvider(() => null);
  }

  // O que a tela pode saber da sessão (sem tokens).
  view() {
    const p = this.profile;
    if (this.status === 'offline_hours') {
      return { mode: 'cloud', status: 'offline_hours', message: this.message, env: this.cfg.env, appVersion: this.cfg.appVersion,
        user: { email: '', displayName: this.offlineUser?.displayName || '', username: '', role: null, permissions: [], offline: true }, offlineHours: null };
    }
    return {
      mode: 'cloud', status: this.status, message: this.message, env: this.cfg.env, appVersion: this.cfg.appVersion,
      offlineHours: !this.tokens && this.offlineCandidate ? { available: true, displayName: this.offlineCandidate.displayName || '' } : null,
      user: this.tokens ? { email: this.tokens.email, displayName: p?.displayName || '', username: p?.username || '', role: p?.role || null,
        permissions: this.status === 'active' ? (p?.permissions || []) : [] } : null,
    };
  }

  async getAccessToken() {
    if (!this.tokens) return null;
    if (this.now() > this.tokens.expiresAt - REFRESH_MARGIN_MS) await this._refresh();
    return this.tokens ? this.tokens.accessToken : null;
  }

  _setTokens(t) {
    this.tokens = t;
    clearTimeout(this.timer);
    const wait = Math.max(5000, t.expiresAt - REFRESH_MARGIN_MS - this.now());
    this.timer = setTimeout(() => { this._refresh().catch(() => {}); }, wait);
    this.timer.unref?.();
  }

  // Renovação única em andamento (várias requisições ao mesmo tempo não renovam duas vezes).
  _refresh() {
    if (!this._refreshing) {
      this._refreshing = (async () => {
        const current = this.tokens;
        if (!current) return;
        try {
          this._setTokens(await this.gotrue.refresh(current.refreshToken));
          if (this.remember) await this._saveRemember();
        } catch (e) {
          if (e.code === 'OFFLINE' && this.now() < current.expiresAt) { this._retrySoon(); return; } // ainda válido: tenta de novo
          await this._end(e.code === 'SUSPENDED' ? 'suspended' : 'expired');
        }
      })().finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }
  _retrySoon() { clearTimeout(this.timer); this.timer = setTimeout(() => { this._refresh().catch(() => {}); }, 30000); this.timer.unref?.(); }

  async _establish(tokens, { remember }) {
    this._setTokens(tokens);
    this.remember = !!remember;
    const transport = this.transportFactory({ userId: tokens.userId, getAccessToken: () => this.getAccessToken() });
    let profile;
    try { profile = await transport.rpc('my_profile', {}); } catch (e) {
      await this._end(null);
      throw e.code === 'OFFLINE' ? httpError(503, AUTH_MESSAGES.OFFLINE, { code: 'OFFLINE' }) : httpError(503, 'Não foi possível ler o seu perfil de acesso. Tente novamente.', { code: 'PROFILE_UNAVAILABLE' });
    }
    this.profile = profile || null;
    const status = profile?.status;
    if (status === 'suspended') {
      await this.logout({ reason: 'suspended' });
      throw httpError(403, STATUS_MSG.suspended, { code: 'SUSPENDED' });
    }
    if (status !== 'active') { // invited/pending/sem perfil: autenticado, mas SEM acesso a dado algum (RLS também bloqueia)
      this.status = 'pending';
      this.message = STATUS_MSG.pending;
      if (this.remember) await this._saveRemember(); else this._forgetRemember();
      this._log('login-pendente');
      return;
    }
    const local = new LocalUserData(tokens.userId, this.root);
    const backend = new CloudBackend({ transport, keys: new KeyService((s, c) => transport.fetchKeys(s, c)), local, userId: tokens.userId });
    try {
      await this.store.attach(backend); // carrega só o que o RLS permite; falha → nada muda
    } catch (e) {
      await this._end(null); // fail closed: sem dados carregados não fica sessão "meio aberta"
      throw e;
    }
    identity.setProvider(() => profile.displayName || profile.username || tokens.email.split('@')[0] || null);
    this.audit.setDir(local.dir); // auditoria local passa a ser a deste usuário
    this.status = 'active';
    this.message = null;
    if (this.remember) await this._saveRemember(); else this._forgetRemember();
    await this._saveMarker(tokens.userId, profile.displayName || profile.username || tokens.email.split('@')[0]);
    this._log('login');
  }

  // ---------- Modo offline das horas ----------
  async _saveMarker(userId, displayName) {
    try {
      const enc = await this.protect(JSON.stringify({ userId, displayName }));
      fs.mkdirSync(this.root, { recursive: true });
      fs.writeFileSync(this.markerFile, JSON.stringify({ format: 1, enc }));
      this.offlineCandidate = { userId, displayName };
    } catch { /* sem o marcador, só não há modo offline */ }
  }
  async _readMarker() {
    try {
      const { enc } = JSON.parse(fs.readFileSync(this.markerFile, 'utf8'));
      const m = JSON.parse(await this.unprotect(enc)); // DPAPI: só o mesmo usuário do Windows abre
      return /^[0-9a-f-]{36}$/.test(m.userId || '') ? { userId: m.userId, displayName: String(m.displayName || '') } : null;
    } catch { return null; }
  }

  // Sem conexão com o Supabase: abre SÓ as horas locais do último usuário deste usuário do Windows. Com conexão, exige login.
  async enterOfflineHours() {
    if (this.tokens) throw httpError(409, 'Você já está conectado.', { code: 'ALREADY_SIGNED_IN' });
    const c = this.offlineCandidate || (this.offlineCandidate = await this._readMarker());
    if (!c) throw httpError(400, 'Nenhum usuário entrou antes neste computador: o primeiro acesso precisa de conexão.', { code: 'OFFLINE_UNAVAILABLE' });
    let reachable = true;
    try { await this.gotrue.health(); } catch (e) { reachable = e.code !== 'OFFLINE'; }
    if (reachable) throw httpError(409, 'Há conexão com o servidor: entre normalmente com seu usuário.', { code: 'ONLINE' });
    const local = new LocalUserData(c.userId, this.root);
    await this.store.attach(new OfflineHoursBackend(local));
    identity.setProvider(() => c.displayName || null);
    this.audit.setDir(local.dir);
    this.offlineUser = c;
    this.status = 'offline_hours';
    this.message = STATUS_MSG.offline;
    this._log('offline-horas', { usuario: c.userId });
  }

  async login(email, password, remember) {
    const e = checkEmail(email);
    if (typeof password !== 'string' || !password) throw httpError(400, 'Informe a senha.', { code: 'INVALID_CREDENTIALS' });
    if (this.tokens || this.status === 'offline_hours') await this.logout({ quiet: true });
    let t;
    try { t = await this.gotrue.signIn(e, password); } catch (err) {
      this._log('login-recusado', { motivo: err.code });
      if (err.code === 'OFFLINE' && !this.offlineCandidate) this.offlineCandidate = await this._readMarker(); // a tela passa a oferecer o modo offline
      throw authHttp(err);
    }
    await this._establish(t, { remember });
  }

  // Primeiro acesso: código do convite + senha definida pelo próprio usuário (nunca senha padrão).
  async firstAccess(email, code, newPassword) {
    const e = checkEmail(email); const c = checkCode(code); checkPassword(newPassword);
    if (this.tokens || this.status === 'offline_hours') await this.logout({ quiet: true });
    try {
      const t = await this.gotrue.verifyOtp('invite', e, c);
      await this.gotrue.setPassword(t.accessToken, newPassword);
      await this._establish(t, { remember: false });
    } catch (err) { throw authHttp(err); }
  }

  // Resposta sempre igual (não revela se o e-mail existe), exceto excesso de tentativas/sem rede.
  async requestRecovery(email) {
    const e = checkEmail(email);
    try { await this.gotrue.recover(e); } catch (err) { if (err.code === 'RATE_LIMIT' || err.code === 'OFFLINE') throw authHttp(err); }
  }

  async recover(email, code, newPassword) {
    const e = checkEmail(email); const c = checkCode(code); checkPassword(newPassword);
    if (this.tokens || this.status === 'offline_hours') await this.logout({ quiet: true });
    try {
      const t = await this.gotrue.verifyOtp('recovery', e, c);
      await this.gotrue.setPassword(t.accessToken, newPassword);
      await this._establish(t, { remember: false });
    } catch (err) { throw authHttp(err); }
  }

  // Pendente: conferir de novo se o administrador já liberou.
  async check() {
    if (!this.tokens) throw httpError(401, 'Entre com seu usuário para continuar.', { code: 'AUTH_REQUIRED' });
    if (this.status === 'active') return;
    const token = await this.getAccessToken();
    if (!token) throw httpError(401, AUTH_MESSAGES.SESSION_EXPIRED, { code: 'AUTH_REQUIRED' });
    await this._establish(this.tokens, { remember: this.remember });
  }

  async logout({ reason = null, quiet = false } = {}) {
    const t = this.tokens;
    const wasOffline = this.status === 'offline_hours';
    await this._end(reason, { revoke: t });
    if (!wasOffline) this._forgetRemember(); // sair do modo offline não apaga a sessão guardada para quando a conexão voltar
    if (!quiet) this._log('logout');
  }

  // Encerra a sessão local: revoga no Auth (melhor esforço), zera tokens, chaves, cópias temporárias e o estado em memória.
  async _end(reason, { revoke } = {}) {
    clearTimeout(this.timer);
    this.tokens = null;
    this.profile = null;
    this.offlineUser = null;
    this.status = 'signed_out';
    this.message = reason ? STATUS_MSG[reason] || null : null;
    identity.setProvider(() => null);
    if (revoke) { try { await this.gotrue.signOut(revoke.accessToken); } catch { /* sem rede: o token expira sozinho */ } }
    await this.store.detach();
    this.audit.setDir(this.machineLogs);
  }

  // Inicialização: “manter conectado” → renova a sessão guardada (DPAPI). Sem rede: fica na tela de login com o aviso.
  async restore() {
    this.offlineCandidate = await this._readMarker();
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')); } catch { return false; }
    try {
      const refreshToken = await this.unprotect(saved.refreshEnc);
      const t = await this.gotrue.refresh(refreshToken);
      await this._establish(t, { remember: true });
      return true;
    } catch (e) {
      if (e.code === 'OFFLINE' || e.status === 503) { this.message = AUTH_MESSAGES.OFFLINE; return false; }
      this._forgetRemember(); // sessão guardada inválida/revogada/de outro usuário do Windows: descarta
      this.message = STATUS_MSG.expired;
      return false;
    }
  }

  async _saveRemember() {
    const enc = await this.protect(this.tokens.refreshToken);
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.sessionFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: 1, userId: this.tokens.userId, refreshEnc: enc, savedAt: new Date().toISOString() }));
    fs.renameSync(tmp, this.sessionFile);
  }
  _forgetRemember() { try { fs.rmSync(this.sessionFile, { force: true }); } catch { /* */ } }

  _log(action, extra = {}) {
    try { this.audit.log({ action: `sessao-${action}`, usuario: this.tokens?.userId || this.offlineUser?.userId || null, ...extra }); } catch { /* auditoria local não derruba o login */ }
  }

  // ---------- HTTP ----------
  // Bloqueio no servidor local: sem sessão → 401; pendente → 403. Liberado só o necessário para entrar.
  middleware() {
    const open = new Set(['/api/session', '/api/auth/login', '/api/auth/first-access', '/api/auth/recover-request', '/api/auth/recover', '/api/auth/logout', '/api/auth/check', '/api/auth/offline-hours']);
    return (req, res, next) => {
      if (!req.path.startsWith('/api/') || open.has(req.path)) return next();
      if (this.status === 'offline_hours') return req.path.startsWith('/api/hours/') ? next() : res.status(503).json({ error: STATUS_MSG.offline, code: 'OFFLINE_MODE' });
      if (!this.tokens) return res.status(401).json({ error: this.message || 'Entre com seu usuário para continuar.', code: 'AUTH_REQUIRED' });
      if (this.status !== 'active') return res.status(403).json({ error: STATUS_MSG.pending, code: 'ACCOUNT_PENDING' });
      return next();
    };
  }

  mount(app) {
    app.get('/api/session', (req, res) => res.json(this.view()));
    app.post('/api/auth/login', async (req, res) => { await this.login(req.body?.email, req.body?.password, !!req.body?.remember); res.json(this.view()); });
    app.post('/api/auth/first-access', async (req, res) => { await this.firstAccess(req.body?.email, req.body?.code, req.body?.password); res.json(this.view()); });
    app.post('/api/auth/recover-request', async (req, res) => {
      await this.requestRecovery(req.body?.email);
      res.json({ ok: true, message: 'Se o e-mail estiver cadastrado, um código de recuperação foi enviado.' });
    });
    app.post('/api/auth/recover', async (req, res) => { await this.recover(req.body?.email, req.body?.code, req.body?.password); res.json(this.view()); });
    app.post('/api/auth/check', async (req, res) => { await this.check(); res.json(this.view()); });
    app.post('/api/auth/logout', async (req, res) => { await this.logout(); res.json(this.view()); });
    app.post('/api/auth/offline-hours', async (req, res) => { await this.enterOfflineHours(); res.json(this.view()); });
  }
}

// Modo local (sem nuvem): sem login, como sempre. A tela recebe o mesmo formato de sessão.
class LocalSession {
  constructor({ cfg }) { this.mode = 'local'; this.cfg = cfg; identity.setProvider(null); }
  view() { return { mode: 'local', status: 'active', message: null, env: 'local', appVersion: this.cfg.appVersion, user: { displayName: identity.who() || '', email: '', username: '', role: null, permissions: [] } }; }
  middleware() { return (req, res, next) => next(); }
  mount(app) {
    app.get('/api/session', (req, res) => res.json(this.view()));
    app.post(/^\/api\/auth\//, () => { throw httpError(400, 'O aplicativo está no modo local (sem login).', { code: 'LOCAL_MODE' }); });
  }
  async restore() { return false; }
}

// Cookie de inicialização (modo nuvem): a API local só atende quem abriu o app pelo endereço com o token aleatório desta execução.
// Protege contra outros usuários do Windows na mesma máquina (localhost é compartilhado entre sessões, ex.: Terminal Server).
function launchGuard(token = crypto.randomBytes(24).toString('hex')) {
  const secret = crypto.randomBytes(32).toString('hex');
  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const cookieOf = (req) => (/(?:^|;\s*)gp_k=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1];
  return {
    token,
    middleware: (req, res, next) => {
      if (req.method === 'GET' && typeof req.query?.k === 'string' && !req.path.startsWith('/api/')) {
        if (!same(req.query.k, token)) return res.status(403).send('Endereço de inicialização inválido. Abra o aplicativo pelo atalho.');
        res.setHeader('Set-Cookie', `gp_k=${secret}; HttpOnly; SameSite=Strict; Path=/`);
        return res.redirect(302, req.path);
      }
      if (req.path.startsWith('/api/') && !same(cookieOf(req), secret)) {
        return res.status(401).json({ error: 'Abra o aplicativo pelo atalho (ou pelo endereço mostrado ao iniciar).', code: 'LAUNCH_REQUIRED' });
      }
      return next();
    },
  };
}

module.exports = { CloudSession, LocalSession, launchGuard, checkPassword };
