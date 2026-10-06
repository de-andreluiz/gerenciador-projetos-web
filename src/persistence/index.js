// Montagem do backend da nuvem para um usuário autenticado (usada pelo login na Fase 4).
// Recebe só o necessário: URL + publishable key (configuração do build) e um provedor do access token da sessão.
// Nenhum segredo de servidor passa por aqui.
'use strict';
const { SupabaseRest } = require('./supabase-rest');
const { KeyService } = require('./keys');
const { CloudBackend } = require('./cloud-backend');
const { LocalUserData, localRoot } = require('./local-user-data');

function createCloudBackend({ url, publishableKey, getAccessToken, userId, root = localRoot(), fetchImpl }) {
  const transport = new SupabaseRest({ url, publishableKey, getAccessToken, fetchImpl });
  const keys = new KeyService((scopes, create) => transport.fetchKeys(scopes, create));
  return new CloudBackend({ transport, keys, local: new LocalUserData(userId, root), userId });
}

module.exports = { createCloudBackend };
