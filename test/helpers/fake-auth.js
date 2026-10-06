// Supabase Auth simulado para testes (mesma interface do GoTrueClient): contas, senhas, códigos de convite/recuperação,
// rotação de refresh token, revogação e ban. Os UUIDs são os mesmos de auth.users do PGlite (createCloud().user).
'use strict';
const { AuthError, AUTH_MESSAGES } = require('../../src/auth/gotrue');

const err = (code) => new AuthError(code, AUTH_MESSAGES[code]);

class FakeAuth {
  constructor() {
    this.users = new Map();   // e-mail → { uid, email, password, confirmed, banned }
    this.access = new Map();  // access token → uid
    this.refreshTokens = new Map(); // refresh token → e-mail
    this.codes = new Map();   // "tipo:e-mail" → código
    this.revoked = [];
    this.ttlMs = 3600 * 1000;
    this.n = 0;
    this.offline = false;
  }
  add(email, uid, { password = null, confirmed = true, banned = false } = {}) { this.users.set(email, { uid, email, password, confirmed, banned }); }
  invite(email, code) { this.codes.set(`invite:${email}`, code); }
  _guard() { if (this.offline) throw err('OFFLINE'); }
  _issue(u) {
    const n = ++this.n;
    const t = { accessToken: `acc_${u.uid}_${n}`, refreshToken: `ref_${u.uid}_${n}`, expiresAt: Date.now() + this.ttlMs, userId: u.uid, email: u.email };
    this.access.set(t.accessToken, u.uid);
    this.refreshTokens.set(t.refreshToken, u.email);
    return t;
  }
  async signIn(email, password) {
    this._guard();
    const u = this.users.get(email);
    if (!u || !u.password || u.password !== password) throw err('INVALID_CREDENTIALS');
    if (u.banned) throw err('SUSPENDED');
    if (!u.confirmed) throw err('NOT_CONFIRMED');
    return this._issue(u);
  }
  async refresh(refreshToken) {
    this._guard();
    const email = this.refreshTokens.get(refreshToken);
    if (!email) throw err('SESSION_EXPIRED');
    this.refreshTokens.delete(refreshToken); // rotação: o token antigo deixa de valer
    const u = this.users.get(email);
    if (u.banned) throw err('SUSPENDED');
    return this._issue(u);
  }
  async verifyOtp(type, email, code) {
    this._guard();
    if (this.codes.get(`${type}:${email}`) !== code) throw err('INVALID_CODE');
    this.codes.delete(`${type}:${email}`);
    const u = this.users.get(email);
    u.confirmed = true;
    return this._issue(u);
  }
  async setPassword(accessToken, password) {
    this._guard();
    const uid = this.access.get(accessToken);
    const u = [...this.users.values()].find((x) => x.uid === uid);
    if (!u) throw err('SESSION_EXPIRED');
    u.password = password;
  }
  async health() { this._guard(); }
  async recover(email) { this._guard(); if (this.users.has(email)) this.codes.set(`recovery:${email}`, '246810'); }
  async signOut(accessToken) {
    this._guard();
    this.revoked.push(accessToken);
    const uid = this.access.get(accessToken);
    this.access.delete(accessToken);
    for (const [r, email] of this.refreshTokens) if (this.users.get(email)?.uid === uid) this.refreshTokens.delete(r); // escopo local (simplificado)
  }
}

module.exports = { FakeAuth };
