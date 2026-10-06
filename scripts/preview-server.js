// Servidor para conferência visual (preview do app no navegador) — SEMPRE com pastas temporárias, nunca o data\ real.
//   node scripts/preview-server.js          → modo local, porta 4460 (dados vazios de teste)
//   node scripts/preview-server.js cloud    → modo nuvem apontando para um servidor INEXISTENTE, porta 4464 (tela de login/offline)
// No modo nuvem o endereço com o token de inicialização é http://localhost:4464/?k=preview
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const cloud = process.argv[2] === 'cloud';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-preview-'));
for (const k of Object.keys(process.env)) if (k.startsWith('GP_')) delete process.env[k]; // nunca herda a configuração real
Object.assign(process.env, { GP_DATA_DIR: path.join(tmp, 'data'), GP_LOCAL_DIR: path.join(tmp, 'local'), PORT: cloud ? '4464' : '4460' });
if (cloud) {
  Object.assign(process.env, { GP_MODE: 'cloud', GP_SUPABASE_URL: 'https://preview-sem-servidor.invalid', GP_SUPABASE_PUBLISHABLE_KEY: 'pk_preview', GP_ENV: 'preview', GP_LAUNCH_TOKEN: 'preview' });
}
const { app, session } = require('../server');
app.listen(Number(process.env.PORT), '127.0.0.1', async () => {
  await session.restore?.().catch(() => false);
  console.log(`preview (${cloud ? 'nuvem sem servidor' : 'local'}) em http://localhost:${process.env.PORT}/${cloud ? '?k=preview' : ''} — dados temporários em ${tmp}`);
});
