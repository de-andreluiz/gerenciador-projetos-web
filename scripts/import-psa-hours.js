#!/usr/bin/env node
// scripts/import-psa-hours.js
// Importa apontamentos de horas exportados do PSA (Dynamics 365) para data/app.db.
// Entrada: um JSON (gerado a partir da planilha) com [{ date, startMin, endMin, project, cliente, activity, local }, ...].
//
// Uso:
//   node scripts/import-psa-hours.js --input /caminho/psa_entries.json [--dry-run] [--data-dir /caminho/para/data]
'use strict';
require('../src/config').loadDotEnv(require('path').join(__dirname, '..'));

const path = require('path');
const fs = require('fs');
const H = require('../src/hours');
const { uid } = require('../src/util');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const inputIdx = args.indexOf('--input');
const dirIdx = args.indexOf('--data-dir');
const INPUT = inputIdx !== -1 ? args[inputIdx + 1] : null;
const DATA_DIR = dirIdx !== -1 ? args[dirIdx + 1] : (process.env.GP_DATA_DIR || path.join(__dirname, '..', 'data'));

async function main() {
  if (!INPUT) {
    console.error('❌ Use --input <arquivo.json>');
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  console.log(`📂 ${rows.length} linhas lidas de ${INPUT}`);

  const { createSqliteStore } = require('../src/sqlite-db');
  const store = await createSqliteStore(DATA_DIR);
  const data = store.data;

  // 1) Garante um projeto por nome distinto encontrado na planilha.
  const projectByName = new Map(data.projects.map((p) => [p.name, p]));
  let created = 0;
  for (const r of rows) {
    if (!r.project) continue;
    if (!projectByName.has(r.project)) {
      const now = new Date().toISOString();
      const proj = { id: uid(), name: r.project, description: r.cliente ? `Cliente: ${r.cliente}` : '', status: 'active', createdAt: now, updatedAt: now };
      data.projects.push(proj);
      projectByName.set(r.project, proj);
      created++;
    }
  }
  console.log(`🏗️  Projetos novos criados: ${created} (total: ${data.projects.length})`);

  // 2) O PSA não registra o horário real de cada atividade: várias linhas do mesmo dia saem com
  //    o mesmo horário "08:00" de largada. Para não violar a regra de não-sobreposição (e sem
  //    inventar precisão que a planilha não tem), encadeia sequencialmente as linhas de cada dia
  //    mantendo a duração de cada uma e a ordem em que apareceram na planilha.
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const resequenced = [];
  for (const [, rawDayRows] of byDate) {
    const dayRows = [...rawDayRows].sort((a, b) => a.startMin - b.startMin);
    let cursor = dayRows[0].startMin;
    for (const r of dayRows) {
      const dur = r.endMin - r.startMin;
      resequenced.push({ ...r, startMin: cursor, endMin: cursor + dur });
      cursor += dur;
    }
  }

  // 3) Monta os apontamentos (mesma validação usada pela rota POST /api/hours/entries).
  const nowMs = Date.now();
  const iso = new Date(nowMs).toISOString();
  let ok = 0;
  const skipped = [];
  for (const r of resequenced) {
    const proj = projectByName.get(r.project);
    const body = {
      date: r.date, startMin: r.startMin, endMin: r.endMin, pausedMin: 0,
      projectId: proj ? proj.id : H.INTERNAL.id,
      activity: r.activity || '(sem descrição)',
      note: r.local && r.local !== 'ATENDIMENTO INTERNO' ? r.local : '',
    };
    try {
      const fields = H.cleanEntry(body, { data, nowMs });
      H.assertNoOverlap(data, fields, null);
      const entry = { id: uid(), ...fields, source: 'import-psa', createdAt: iso, updatedAt: iso };
      data.timeEntries.push(entry);
      ok++;
    } catch (e) {
      skipped.push({ row: r, error: e.message });
    }
  }

  console.log(`✅ Apontamentos válidos: ${ok}`);
  console.log(`⚠️  Pulados (conflito/erro): ${skipped.length}`);
  for (const s of skipped) console.log(`   - ${s.row.date} ${s.row.project} :: ${s.error}`);

  if (DRY_RUN) {
    console.log('\n🔍 Modo dry-run: nada foi gravado.');
    store.close();
    return;
  }

  await store.save();
  console.log(`\n💾 Gravado em ${path.join(DATA_DIR, 'app.db')}`);
  store.close();
}

main().catch((e) => {
  console.error('❌ Falha na importação:', e);
  process.exit(1);
});
