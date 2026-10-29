#!/usr/bin/env node
// Corrige os projetos criados por import-psa-hours.js, que não tinham o formato completo
// usado por POST /api/projects (bases, deparas, ciclo, etc.) — causava erro no front (`p.bases.map`).
'use strict';
require('../src/config').loadDotEnv(require('path').join(__dirname, '..'));
const path = require('path');
const cycles = require('../src/cycles');

async function main() {
  const DATA_DIR = process.env.GP_DATA_DIR || path.join(__dirname, '..', 'data');
  const { createSqliteStore } = require('../src/sqlite-db');
  const store = await createSqliteStore(DATA_DIR);
  const data = store.data;

  let fixed = 0;
  for (const p of data.projects) {
    if (Array.isArray(p.bases)) continue; // já no formato completo
    Object.assign(p, {
      bases: [], deparas: [], milestones: [],
      coordinatorId: p.coordinatorId ?? null,
      analystId: p.analystId ?? null,
      projectTypeId: p.projectTypeId ?? null,
      originSystemId: p.originSystemId ?? null,
      stepId: null, stageHistory: [], corrections: [], checklists: [],
      defaultConnectionId: null, whatsappGroupUrl: '',
    });
    cycles.assignCycle(p, cycles.cycleFor(data, { cycleId: '', projectTypeId: p.projectTypeId }));
    fixed++;
  }
  console.log(`🔧 Projetos corrigidos: ${fixed}`);
  await store.save();
  store.close();
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
