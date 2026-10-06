#!/usr/bin/env node
// scripts/migrate-to-sqlite.js
// Migração única: importa data/projects.json (backend JSON legado) → data/app.db (SQLite).
//
// Uso:
//   node scripts/migrate-to-sqlite.js
//   node scripts/migrate-to-sqlite.js --data-dir /caminho/para/data
//   node scripts/migrate-to-sqlite.js --dry-run   (só lê, não grava)
//
// Garantias:
//   - Idempotente: pode ser executado quantas vezes quiser (INSERT OR REPLACE).
//   - Não apaga o projects.json original — faça o backup se necessário.
//   - Verifica a integridade do JSON antes de migrar.
'use strict';
require('../src/config').loadDotEnv(require('path').join(__dirname, '..'));

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dirIdx  = args.indexOf('--data-dir');
const DATA_DIR = dirIdx !== -1 ? args[dirIdx + 1] : (process.env.GP_DATA_DIR || path.join(__dirname, '..', 'data'));

async function main() {
  const jsonFile = path.join(DATA_DIR, 'projects.json');

  if (!fs.existsSync(jsonFile)) {
    console.error(`❌ projects.json não encontrado em: ${jsonFile}`);
    console.error('   Verifique GP_DATA_DIR ou passe --data-dir <pasta>');
    process.exit(1);
  }

  console.log(`📂 Lendo: ${jsonFile}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (e) {
    console.error(`❌ Erro ao ler projects.json: ${e.message}`);
    process.exit(1);
  }

  const { applyDefaults } = require('../src/defaults');
  const data = applyDefaults({ ...raw });

  console.log(`📊 Dados encontrados:`);
  console.log(`   Projetos:          ${(data.projects || []).length}`);
  console.log(`   Conexões:          ${(data.connections || []).length}`);
  console.log(`   Coordenadores:     ${(data.coordinators || []).length}`);
  console.log(`   Itens de checklist:${(data.checklistItems || []).length}`);
  console.log(`   Ciclos:            ${(data.cycles || []).length}`);
  console.log(`   E-mail templates:  ${(data.emailTemplates || []).length}`);

  if (DRY_RUN) {
    console.log('\n🔍 Modo dry-run: nenhuma alteração gravada.');
    return;
  }

  const dbFile = path.join(DATA_DIR, 'app.db');
  if (fs.existsSync(dbFile)) {
    const bak = `${dbFile}.bak-${Date.now()}`;
    fs.copyFileSync(dbFile, bak);
    console.log(`💾 Backup do app.db existente: ${bak}`);
  }

  console.log(`\n⚙️  Inicializando SQLite em: ${dbFile}`);
  const { createSqliteStore } = require('../src/sqlite-db');
  const store = await createSqliteStore(DATA_DIR);

  console.log('⬆️  Importando dados...');
  await store.importFromJson(data);

  // Verificação pós-migração
  const projCount = store.data.projects.length;
  const connCount = store.data.connections.length;

  console.log(`\n✅ Migração concluída:`);
  console.log(`   Projetos migrados:  ${projCount}`);
  console.log(`   Conexões migradas:  ${connCount}`);
  console.log(`   Arquivo SQLite:     ${dbFile}`);

  store.close();
  console.log('\n💡 Próximo passo: defina GP_STORAGE_BACKEND=sqlite no .env e reinicie o servidor.');
}

main().catch((e) => {
  console.error('❌ Falha na migração:', e);
  process.exit(1);
});
