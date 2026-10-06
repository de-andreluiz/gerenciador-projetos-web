// Sessão do usuário. Modo local (sem nuvem/login): vive SÓ no processo local (Node).
'use strict';
const identity = require('./identity');
const { httpError } = require('../util');

// Política mínima de senha (mantida para reaproveitamento por outras telas que peçam troca de senha local).
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 12 || p.length > 200 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p)) {
    throw httpError(400, 'Senha fraca: use pelo menos 12 caracteres, com letras maiúsculas e minúsculas, números e símbolos.', { code: 'WEAK_PASSWORD' });
  }
  return p;
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

module.exports = { LocalSession, checkPassword };
