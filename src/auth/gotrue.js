// Cliente mínimo do Supabase Auth (GoTrue) — HTTP direto, sem dependências. Só o processo local (Node) fala com o Auth:
// tokens nunca vão para a tela. Nada aqui registra senha, código, token ou e-mail.
//   signIn(email, senha) · refresh(refreshToken) · verifyOtp(tipo, email, código) · setPassword(accessToken, senha)
//   recover(email) · signOut(accessToken)
'use strict';

class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Mensagens para a tela: nunca dizem se o e-mail existe (evita descobrir contas).
const MESSAGES = {
  INVALID_CREDENTIALS: 'E-mail ou senha incorretos.',
  NOT_CONFIRMED: 'Este acesso ainda não foi ativado. Use “Primeiro acesso” com o código recebido por e-mail.',
  SUSPENDED: 'Seu acesso está suspenso. Fale com o administrador.',
  INVALID_CODE: 'Código inválido ou expirado. Peça um novo código.',
  WEAK_PASSWORD: 'Senha fraca: use pelo menos 12 caracteres, com letras maiúsculas e minúsculas, números e símbolos.',
  RATE_LIMIT: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.',
  SESSION_EXPIRED: 'Sua sessão expirou. Entre novamente.',
  OFFLINE: 'Sem conexão com o servidor de autenticação. Verifique a internet e tente novamente.',
  FAILED: 'Não foi possível concluir a autenticação agora. Tente novamente.',
};
const fail = (code) => new AuthError(code, MESSAGES[code] || MESSAGES.FAILED);

function classify(status, body) {
  const code = String(body?.error_code || body?.code || body?.error || '').toLowerCase();
  const msg = String(body?.msg || body?.message || body?.error_description || '').toLowerCase();
  if (status === 429 || code.includes('rate_limit') || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return fail('RATE_LIMIT');
  if (code.includes('banned') || msg.includes('banned')) return fail('SUSPENDED');
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return fail('NOT_CONFIRMED');
  if (code === 'weak_password' || msg.includes('password should') || msg.includes('weak password')) return fail('WEAK_PASSWORD');
  if (code === 'otp_expired' || code.includes('otp') || msg.includes('token has expired') || msg.includes('otp')) return fail('INVALID_CODE');
  if (code.includes('refresh_token') || code === 'session_not_found' || code === 'session_expired' || msg.includes('refresh token')) return fail('SESSION_EXPIRED');
  if (code === 'invalid_credentials' || code === 'invalid_grant' || msg.includes('invalid login credentials')) return fail('INVALID_CREDENTIALS');
  if (status >= 500) return fail('OFFLINE');
  return fail('FAILED');
}

class GoTrueClient {
  constructor({ url, publishableKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    this.url = String(url).replace(/\/$/, '');
    this.key = publishableKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _call(method, path, { body, token } = {}) {
    let res;
    try {
      res = await this.fetch(`${this.url}/auth/v1${path}`, {
        method,
        headers: { apikey: this.key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw fail('OFFLINE');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
    if (!res.ok) throw classify(res.status, json);
    return json;
  }

  // Sessão normalizada: { accessToken, refreshToken, expiresAt (ms), userId, email }
  static session(json) {
    if (!json?.access_token || !json?.refresh_token || !json?.user?.id) throw fail('FAILED');
    const expiresAt = json.expires_at ? json.expires_at * 1000 : Date.now() + (Number(json.expires_in) || 3600) * 1000;
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt, userId: json.user.id, email: json.user.email || '' };
  }

  async signIn(email, password) {
    return GoTrueClient.session(await this._call('POST', '/token?grant_type=password', { body: { email, password } }));
  }
  async refresh(refreshToken) {
    return GoTrueClient.session(await this._call('POST', '/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } }));
  }
  // Convite (type 'invite') ou recuperação (type 'recovery') pelo CÓDIGO do e-mail (o app desktop não usa links).
  async verifyOtp(type, email, token) {
    return GoTrueClient.session(await this._call('POST', '/verify', { body: { type, email, token } }));
  }
  async setPassword(accessToken, password) {
    await this._call('PUT', '/user', { body: { password }, token: accessToken });
  }
  // Envia o código de recuperação. Resposta igual exista ou não o e-mail.
  async recover(email) {
    await this._call('POST', '/recover', { body: { email } });
  }
  // Servidor de autenticação alcançável? (modo offline das horas só é liberado quando NÃO está)
  async health() { await this._call('GET', '/health'); }
  // Revoga o refresh token desta sessão no servidor (escopo local: só esta sessão).
  async signOut(accessToken) {
    await this._call('POST', '/logout?scope=local', { token: accessToken });
  }
}

module.exports = { GoTrueClient, AuthError, AUTH_MESSAGES: MESSAGES };
