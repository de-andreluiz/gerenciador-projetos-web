// Servidor para conferência visual (preview do app no navegador) — SEMPRE com pastas temporárias, nunca o data\ real.
//   node scripts/preview-server.js          → modo local, porta 4460 (dados vazios de teste)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-preview-'));
for (const k of Object.keys(process.env)) if (k.startsWith('GP_')) delete process.env[k]; // nunca herda a configuração real
Object.assign(process.env, { GP_DATA_DIR: path.join(tmp, 'data'), GP_LOCAL_DIR: path.join(tmp, 'local'), PORT: '4460' });
const { app } = require('../server');
app.listen(Number(process.env.PORT), '127.0.0.1', async () => {
  console.log(`preview (local) em http://localhost:${process.env.PORT}/ — dados temporários em ${tmp}`);
});
