// Erros da camada de dados da nuvem → contrato HTTP da tela (httpError com `code`). Mensagens nunca expõem dado sensível.
'use strict';
const { httpError } = require('../util');

// Erro normalizado do transporte/backend.
class DataError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const MESSAGES = {
  STALE: [409, 'STALE_DATA', 'Estes dados foram alterados por outra pessoa enquanto você editava. A tela foi atualizada — confira e refaça a alteração.'],
  RELOADED: [409, 'STALE_DATA', 'Os dados foram atualizados antes de concluir esta alteração. Confira e refaça a alteração.'],
  FORBIDDEN: [403, 'FORBIDDEN', 'Você não tem permissão para esta alteração. Nada foi salvo.'],
  OFFLINE: [503, 'OFFLINE', 'Sem conexão com o servidor de dados. Nada foi salvo — verifique a internet e tente novamente.'],
  AUTH: [401, 'AUTH_REQUIRED', 'Sua sessão expirou. Entre novamente.'],
  CRYPTO: [500, 'CRYPTO', 'Não foi possível proteger/ler dados cifrados. Nada foi salvo.'],
  INVALID: [500, 'DATA_INVALID', 'O servidor de dados recusou a alteração. Nada foi salvo.'],
  NOT_FOUND: [404, 'FILE_NOT_FOUND', 'O arquivo não foi encontrado no armazenamento da nuvem (ou ainda não foi migrado).'],
  TOO_LARGE: [413, 'FILE_TOO_LARGE', 'Arquivo grande demais para o armazenamento da nuvem.'],
};

// Converte para o erro que as rotas devolvem (o error handler do server.js já repassa `code`).
function toHttp(err) {
  if (err && err.status && err.code && !(err instanceof DataError)) return err; // já é httpError
  const [status, code, message] = MESSAGES[err?.code] || MESSAGES.INVALID;
  return httpError(status, message, { code });
}

module.exports = { DataError, toHttp, MESSAGES };
