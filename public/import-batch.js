'use strict';
// Importação por DIRETÓRIO (lote): 1 Origem → 2 Arquivos e abas → 3 Revisão → 4 Execução. Servidor: src/import-batch-api.js,
// que reaproveita o pipeline da importação de arquivo único (leitura, conversão, plano, pré-checagem, execução, scripts).
// Regras: uma aba selecionada = uma tabela própria; transação POR ABA (uma falha não desfaz as outras); scripts pós-importação
// no fim, numa transação própria, só se todas as abas deram certo. Nada é executado antes do passo 3.

// Mesmo algoritmo de src/import-batch.js (assignNames) — só para mostrar os nomes ao vivo; o servidor revalida e BLOQUEIA
// tabela repetida (nunca consolida duas abas numa tabela).
function batchAssignNames(list) {
  const taken = new Set(list.filter((x) => x.custom).map((x) => x.custom.trim().toLowerCase()));
  return list.map((x) => {
    if (x.custom) return x.custom.trim();
    let n = x.base;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${x.base.slice(0, 120)}_${i}`;
    taken.add(n.toLowerCase());
    return n;
  });
}

function openBatchImportWizard(project, preset = {}) {
  const usable = project.bases.filter((b) => b.local || b.prod);
  const fresh = () => state.projects.find((p) => p.id === project.id) || project;
  const w = {
    step: 1, baseId: usable[0]?.id, env: usable[0]?.local ? 'local' : 'prod', deparaId: preset.deparaId,
    schema: 'dbo', mode: 'fail', suggestedTypes: false, files: null, dir: '', filter: '', plan: null, timer: null, reading: '',
    scriptsOn: false, scriptIds: [], scriptVars: {}, scriptList: null,
  };
  const depara = () => fresh().deparas.find((d) => d.id === w.deparaId);
  const base = () => project.bases.find((b) => b.id === w.baseId);
  let modal;
  const stepsEl = () => h('div', { class: 'steps' }, ['1. Origem', '2. Arquivos e abas', '3. Revisão e autorização', '4. Execução'].map((t, i) => h('span', { class: w.step === i + 1 ? 'on' : w.step > i + 1 ? 'past' : '' }, t)));
  function show(body, footer) {
    const pos = modal?.overlay.scrollTop || 0;
    modal?.overlay.remove();
    modal = openModal({ title: `Importar planilhas do diretório — ${project.name}`, wide: true, steps: stepsEl(), body, footer, onClose: () => clearInterval(w.timer) });
    modal.overlay.scrollTop = pos;
  }
  const cancel = () => h('button', { class: 'btn', onclick: () => modal.close() }, 'Cancelar');
  const renderScriptsBox = (host) => importScriptsBox(host, w, { project, base, onChange: autosave, close: () => modal.close(),
    note: 'Rodam no FIM do lote, numa transação própria, só se todas as abas forem importadas com sucesso. Se um script falhar, só os scripts são desfeitos — as tabelas importadas continuam.' });

  // ---------- Passo 1: diretório (da planilha), base e ambiente ----------
  function step1() {
    w.step = 1;
    const d = depara(); const b = base();
    const blocked = d.importable === false;
    const dirBox = h('div', { class: 'box' },
      h('div', { class: 'inline', style: 'margin-bottom:6px' }, h('strong', { style: 'flex:1' }, `Planilha: ${d.label}`), h('span', { class: 'pill' }, 'Importação por diretório')),
      h('div', { class: 'small' }, 'Diretório: ', h('span', { class: 'mono' }, d.sourceDir || '—'), d.sourceDirExists === false ? h('span', { class: 'pill overdue', style: 'margin-left:6px' }, 'não encontrado') : null),
      blocked ? h('div', { class: 'small', style: 'color:var(--bad-text)' }, 'Esta planilha não está marcada para importação. Habilite ao editá-la.') : null,
      h('div', { class: 'hint', style: 'margin-top:6px' }, 'São consideradas as planilhas .xlsx deste diretório (sem subpastas). Planilhas abertas no Excel (~$…) são ignoradas. Para trocar o diretório, edite a planilha.'));
    const baseField = usable.length > 1
      ? field('Base de dados de destino', h('select', { onchange: (e) => { w.baseId = e.target.value; const nb = base(); if (!nb[w.env]) w.env = nb.local ? 'local' : 'prod'; step1(); } }, usable.map((x) => h('option', { value: x.id, selected: x.id === w.baseId }, x.name))))
      : h('div', null, h('span', { class: 'lbl' }, 'Base de dados de destino: '), b.name);
    const envRadio = (env, title, sub) => h('label', { class: 'check row', style: 'flex:1' },
      h('input', { type: 'radio', name: 'benv', checked: w.env === env, onchange: () => { w.env = env; step1(); } }),
      h('span', null, h('strong', null, title), h('div', { class: 'small muted' }, `${sub}: ${connLine(b[env])}`)));
    const envField = b.local && b.prod
      ? h('div', null, h('div', { class: 'lbl' }, 'Onde salvar'), h('div', { class: 'inline', style: 'align-items:stretch;margin-top:4px' }, envRadio('local', 'Localhost (teste)', 'Recomendado primeiro'), envRadio('prod', 'Produção', 'Base real')))
      : h('div', null, h('span', { class: 'lbl' }, 'Onde salvar: '), b.local ? `Localhost (teste) — ${connLine(b.local)}` : `Produção — ${connLine(b.prod)}`);
    const msg = h('div');
    show([dirBox, baseField, envField, w.env === 'prod' ? h('div', { class: 'box bad' }, h('strong', null, 'Atenção: produção. '), 'Você verá cada tabela, o servidor e o banco de destino antes de qualquer execução.') : null, msg],
      [cancel(), h('button', { class: 'btn primary', disabled: blocked || !d.sourceDir, onclick: (e) => busy(e.currentTarget, async () => {
        const r = await api('POST', '/api/import/batch/scan', { projectId: project.id, deparaId: d.id });
        if (!r.files.length) { msg.replaceChildren(h('div', { class: 'box warn' }, h('strong', null, 'Nenhuma planilha .xlsx encontrada neste diretório.'), h('div', { class: 'small' }, r.dir))); return; }
        w.dir = r.dir;
        applySaved(r.files);
        step2();
        loadQueue(w.files.filter((f) => f.wanted)); // arquivos lembrados da última vez: abas lidas em sequência
      }) }, 'Procurar planilhas')]);
  }

  // Configuração lembrada (seleção e nomes; nunca o modo de sobrescrita).
  function applySaved(list) {
    const saved = depara().batchConfig;
    w.schema = saved?.schema || 'dbo'; w.suggestedTypes = !!saved?.suggestedTypes;
    w.scriptsOn = !!saved?.scripts?.enabled; w.scriptIds = [...(saved?.scripts?.ids || [])]; w.scriptVars = { ...(saved?.scripts?.vars || {}) };
    w.files = list.map((f) => { const sv = saved?.files?.find((x) => x.name === f.name); return { ...f, saved: sv || null, wanted: !!sv?.include, open: false, sheets: null, loading: false, error: null }; });
  }

  // ---------- Leitura das abas: um arquivo por vez ----------
  async function loadSheets(f, { pickSingle = false } = {}) {
    if (f.sheets || f.loading) return;
    f.loading = true; f.error = null;
    try {
      const r = await api('POST', '/api/import/batch/sheets', { projectId: project.id, deparaId: w.deparaId, file: f.name });
      const relevant = r.sheets.filter((s) => !s.hidden && s.rowCount > 0);
      f.sheets = r.sheets.map((s) => {
        const sv = f.saved?.sheets?.find((x) => x.sheetName === s.name);
        const auto = pickSingle && relevant.length === 1 && relevant[0].name === s.name; // escolha automática só no caso óbvio
        return { ...s, include: sv ? sv.include : auto, custom: sv?.tableName || '', name0: s.name };
      });
      if (pickSingle && relevant.length !== 1) f.open = true; // várias abas: o usuário escolhe
    } catch (e) { f.error = e.message; }
    f.loading = false;
  }
  async function loadQueue(list, opts = {}) {
    for (const [i, f] of list.entries()) {
      w.reading = `Lendo abas ${i + 1} de ${list.length}: ${f.name}…`;
      if (w.step === 2) drawList();
      await loadSheets(f, opts);
    }
    w.reading = '';
    if (w.step === 2) drawList();
    autosave();
  }

  // Nomes ao vivo: abas selecionadas, na ordem arquivo → aba.
  function computeNames() {
    const sel = [];
    for (const f of w.files) for (const s of f.sheets || []) if (s.include) sel.push(s);
    const names = batchAssignNames(sel.map((s) => ({ base: s.base, custom: s.custom })));
    sel.forEach((s, i) => { s.table = names[i]; if (s.input && document.activeElement !== s.input) s.input.value = s.table; });
    for (const f of w.files) for (const s of f.sheets || []) if (!s.include) { s.table = s.custom || s.base; if (s.input && document.activeElement !== s.input) s.input.value = s.table; }
  }
  const selectedSheets = () => w.files.flatMap((f) => (f.sheets || []).filter((s) => s.include).map((s) => ({ f, s })));

  let saveTimer = null;
  const currentConfig = () => ({ schema: w.schema.trim(), suggestedTypes: w.suggestedTypes, scripts: { enabled: w.scriptsOn, ids: w.scriptIds, vars: w.scriptVars },
    files: w.files.filter((f) => f.sheets || f.saved).map((f) => (f.sheets
      ? { name: f.name, include: f.sheets.some((s) => s.include), sheets: f.sheets.map((s) => ({ sheetName: s.name, include: s.include, tableName: s.custom })) }
      : f.saved)) });
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const cfg = currentConfig();
      try { await api('PUT', `/api/projects/${project.id}/deparas/${w.deparaId}/batch-config`, cfg); const d = depara(); if (d) d.batchConfig = cfg; } catch { /* salva de novo ao gerar o plano */ }
    }, 500);
  }

  // ---------- Passo 2: arquivos e abas ----------
  let listHost = null; let countEl = null;
  function step2() {
    w.step = 2;
    const prodLocked = w.env === 'prod' && !base().allowProdOverwrite;
    if (prodLocked) w.mode = 'fail';
    listHost = h('div');
    countEl = h('span', { class: 'muted' });
    const search = h('input', { type: 'text', value: w.filter, placeholder: 'Filtrar arquivos…', 'aria-label': 'Filtrar arquivos', style: 'flex:1;min-width:200px', oninput: (e) => { w.filter = e.target.value; drawList(); } });
    const toolbar = h('div', { class: 'box', style: 'display:grid;gap:8px' },
      h('div', { class: 'small' }, 'Diretório: ', h('span', { class: 'mono' }, w.dir), h('span', { class: 'muted' }, ` · ${plural(w.files.length, 'planilha', 'planilhas')}`)),
      h('div', { class: 'inline' }, search,
        h('button', { class: 'btn sm', title: 'Lê as abas de todas as planilhas e marca as que têm dados (visíveis)', onclick: () => selectAll() }, 'Selecionar todas as abas com dados'),
        h('button', { class: 'btn sm ghost', onclick: () => { for (const f of w.files) for (const s of f.sheets || []) s.include = false; drawList(); autosave(); } }, 'Limpar seleção')),
      countEl);
    const modeHint = h('div', { class: 'hint' }, MODE_HINT[w.mode]);
    const general = h('div', { class: 'box', style: 'display:grid;gap:10px' },
      h('div', { class: 'cols3', style: 'grid-template-columns:minmax(0,2fr) minmax(0,1fr)' },
        field('Se a tabela já existir — vale para todas as abas', h('select', { onchange: (e) => { w.mode = e.target.value; modeHint.textContent = MODE_HINT[w.mode]; } },
          Object.entries(MODE_LABEL).map(([k, t]) => h('option', { value: k, selected: w.mode === k, disabled: prodLocked && k !== 'fail' }, t)))),
        field('Schema', h('input', { type: 'text', value: w.schema, oninput: (e) => { w.schema = e.target.value; autosave(); } }))),
      modeHint,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: w.suggestedTypes, onchange: (e) => { w.suggestedTypes = e.target.checked; autosave(); } }),
        h('span', null, 'Usar os tipos sugeridos (número, data, sim/não)', h('div', { class: 'hint' }, 'Desmarcado (padrão): todas as colunas viram texto, preservando zeros à esquerda — como na importação de arquivo único. Os nomes das colunas seguem o cabeçalho da planilha.'))),
      prodLocked ? h('div', { class: 'small', style: 'color:var(--warn-text)' }, 'Em produção, esta base só permite criar tabelas novas.') : null);
    const scriptsHost = h('div');
    renderScriptsBox(scriptsHost);
    show([h('div', { class: 'muted' }, 'Marque as abas que viram tabelas. Cada aba selecionada gera uma tabela própria; o nome padrão é o da aba (ou o do arquivo, quando ele tem uma única aba com dados) e pode ser editado. Nada é executado neste passo.'),
      toolbar, listHost, general, scriptsHost],
    [h('button', { class: 'btn', onclick: step1 }, '← Voltar'), h('span', { class: 'spacer' }), cancel(),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, buildPlan) }, 'Gerar plano (nada é executado ainda)')]);
    drawList();
  }
  async function selectAll() {
    await loadQueue(w.files.filter((f) => !f.sheets && !f.error));
    for (const f of w.files) for (const s of f.sheets || []) if (!s.hidden && s.rowCount > 0) s.include = true;
    drawList(); autosave();
  }
  function drawList() {
    if (!listHost) return;
    computeNames();
    const q = norm(w.filter.trim());
    const rows = [];
    for (const f of w.files) {
      if (q && !norm(f.name).includes(q)) continue;
      const n = (f.sheets || []).filter((s) => s.include).length;
      const fileBox = h('input', { type: 'checkbox', checked: n > 0, 'aria-label': `Usar ${f.name}`, disabled: !!f.error || f.loading,
        onchange: async (e) => {
          if (!e.target.checked) { for (const s of f.sheets || []) s.include = false; drawList(); autosave(); return; }
          if (!f.sheets) { await loadSheets(f, { pickSingle: true }); } else { const rel = f.sheets.filter((s) => !s.hidden && s.rowCount > 0); if (rel.length === 1) rel[0].include = true; else f.open = true; }
          drawList(); autosave();
        } });
      const toggle = h('button', { class: 'btn sm ghost', disabled: !!f.error, onclick: async () => { f.open = !f.open; if (f.open && !f.sheets) { drawList(); await loadSheets(f); } drawList(); } },
        f.loading ? 'lendo…' : `${f.open ? '▾' : '▸'} ${f.sheets ? plural(f.sheets.length, 'aba', 'abas') : 'abas'}`);
      rows.push(h('tr', { class: n ? '' : 'off' },
        h('td', null, fileBox),
        h('td', null, h('strong', null, f.name), f.error ? h('div', { class: 'small', style: 'color:var(--bad-text)', title: f.error }, f.error.split(': ')[0]) : null),
        h('td', { class: 'num small muted' }, fmtSize(f.size)),
        h('td', { class: 'small' }, n ? `${plural(n, 'aba selecionada', 'abas selecionadas')}` : h('span', { class: 'muted' }, '—')),
        h('td', null, toggle, f.open && f.sheets?.length > 1 ? h('button', { class: 'btn sm ghost', title: 'Marca todas as abas deste arquivo', onclick: () => { for (const s of f.sheets) s.include = true; drawList(); autosave(); } }, 'Todas as abas') : null)));
      if (f.open && f.sheets) {
        for (const s of f.sheets) {
          s.input = h('input', { type: 'text', value: s.table || '', 'aria-label': `Tabela destino de ${f.name} / ${s.name}`, disabled: !s.include,
            oninput: (e) => { s.custom = e.target.value.trim(); computeNames(); autosave(); }, onblur: () => { if (!s.custom) computeNames(); } });
          rows.push(h('tr', { class: `detail-sheet${s.include ? '' : ' off'}` },
            h('td', null),
            h('td', null, h('label', { class: 'check', style: 'gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: s.include, onchange: (e) => { s.include = e.target.checked; drawList(); autosave(); } }),
              h('span', null, s.name, s.hidden ? h('span', { class: 'small muted' }, ' (oculta)') : null, !s.rowCount ? h('span', { class: 'small muted' }, ' (vazia)') : null))),
            h('td', { class: 'num small muted' }, s.rowCount.toLocaleString('pt-BR')),
            h('td', { colspan: 2 }, h('div', { class: 'inline', style: 'gap:6px;flex-wrap:nowrap' }, h('span', { class: 'small muted' }, '→'), s.input,
              s.custom ? h('span', { class: 'small muted', title: 'Nome digitado por você' }, '✎') : null))));
        }
        if (!f.sheets.length) rows.push(h('tr', null, h('td', null), h('td', { colspan: 4, class: 'small muted' }, 'Planilha sem abas.')));
      }
    }
    const sel = selectedSheets();
    countEl.textContent = `${plural(sel.length, 'aba selecionada', 'abas selecionadas')} em ${plural(new Set(sel.map((x) => x.f.name)).size, 'arquivo', 'arquivos')}${w.reading ? ` · ${w.reading}` : ''}`;
    listHost.replaceChildren(h('div', { class: 'tablewrap', style: 'max-height:52vh' }, h('table', { class: 'compact batch-list' },
      h('thead', null, h('tr', null, ['', 'Arquivo / aba', 'Tamanho / linhas', 'Tabela destino', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 5, class: 'empty' }, q ? `Nenhum arquivo com “${w.filter.trim()}”.` : 'Nenhuma planilha.'))))));
  }

  async function buildPlan() {
    computeNames();
    const sel = selectedSheets();
    if (!sel.length) throw new Error('Selecione ao menos uma aba.');
    const scriptIds = w.scriptsOn ? w.scriptIds : [];
    if (w.scriptsOn && !scriptIds.length) throw new Error('Você marcou “Executar scripts SQL depois de importar”, mas nenhum script foi selecionado.');
    const needed = [...new Set(scriptIds.flatMap((id) => w.scriptList?.find((x) => x.id === id)?.analysis?.variables || []))].filter((n) => !isBuiltinVar(n));
    const empty = needed.filter((n) => !w.scriptVars[n]);
    if (empty.length) throw new Error(`Preencha o valor de ${empty.map((n) => `{{${n}}}`).join(', ')} em “Variáveis dos scripts”.`);
    w.plan = await api('POST', '/api/import/batch/plan', { projectId: project.id, baseId: w.baseId, deparaId: w.deparaId, env: w.env, schema: w.schema.trim(), suggestedTypes: w.suggestedTypes,
      items: sel.map(({ f, s }) => ({ file: f.name, sheet: s.name, table: s.table, mode: w.mode })), scriptIds, scriptVars: w.scriptVars, saveConfig: currentConfig() }, { timeoutMs: 600000 });
    await refresh();
    step3();
  }

  // ---------- Passo 3: revisão ----------
  function step3() {
    w.step = 3;
    const pl = w.plan; const prod = pl.env === 'prod';
    const run = async (dryRun) => { const r = await api('POST', `/api/import/batch/plans/${pl.planId}/execute`, { hash: pl.hash, authorized: true, dryRun }); step4(r.jobId, dryRun); };
    const label = `${prod ? 'Importar em PRODUÇÃO' : 'Importar'} ${plural(pl.runnable, 'aba', 'abas')}`;
    const runBtn = h('button', { class: `btn ${prod ? 'danger' : 'primary'}`, disabled: pl.blocked, onclick: (e) => busy(e.currentTarget, () => run(false)) }, label);
    const simBtn = !prod ? h('button', { class: 'btn', disabled: pl.blocked, onclick: (e) => busy(e.currentTarget, () => run(true)) }, 'Simular (executa e desfaz)') : null;
    const blockedN = pl.items.filter((x) => x.status !== 'ok').length;
    const rows = pl.items.map((t) => h('tr', { class: t.status === 'ok' ? '' : 'off' },
      h('td', null, t.file), h('td', null, t.sheet), h('td', { class: 'mono' }, `${t.schema}.${t.table}`), h('td', { class: 'num' }, t.rows == null ? '—' : t.rows.toLocaleString('pt-BR')),
      h('td', { class: 'small' }, t.status !== 'ok' ? h('span', { style: 'color:var(--bad-text)' }, `Não será importada: ${t.reason}`)
        : [t.exists ? h('span', { class: 'pill soon' }, `existe (${plural(t.existingRows ?? 0, 'linha', 'linhas')})`) : h('span', { class: 'pill ok' }, 'nova'), ' ',
          t.mode === 'fail' ? 'criar' : t.mode === 'replace' ? h('strong', { style: 'color:var(--bad-text)' }, 'DROP + criar') : h('strong', { style: 'color:var(--warn-text)' }, `renomear → ${t.backupName}`)])));
    show([
      h('div', { class: `box${prod ? ' bad' : ''}` }, h('div', { class: 'inline', style: 'margin-bottom:8px' }, pill(prod ? 'prod' : 'local', prod ? 'PRODUÇÃO' : 'LOCALHOST (teste)'), h('strong', null, 'Onde será executado')),
        h('dl', { class: 'kv', style: 'margin:0' }, h('dt', null, 'Servidor'), h('dd', null, `${pl.target.server}  (${pl.target.connectedTo})`), h('dt', null, 'Banco'), h('dd', null, pl.target.database),
          h('dt', null, 'Login'), h('dd', null, `${pl.target.login} · ${pl.target.auth === 'sql' ? 'SQL Server' : 'Windows'}`), h('dt', null, 'Origem'), h('dd', null, pl.dir))),
      pl.issues.length ? h('div', { class: 'box bad' }, h('strong', null, 'Bloqueios — corrija e gere o plano novamente:'), h('ul', null, pl.issues.map((i) => h('li', null, i)))) : null,
      blockedN && !pl.issues.length ? h('div', { class: 'box warn' }, h('strong', null, `${plural(blockedN, 'aba não será importada', 'abas não serão importadas')} (motivo na lista). `), `As outras ${plural(pl.runnable, 'aba', 'abas')} podem seguir; ou volte e ajuste.`) : null,
      h('div', null, h('div', { class: 'lbl', style: 'margin-bottom:4px' }, `O que será feito — ${pl.totalRows.toLocaleString('pt-BR')} linhas em ${plural(pl.runnable, 'tabela', 'tabelas')}`),
        h('div', { class: 'tablewrap', style: 'max-height:46vh' }, h('table', null, h('thead', null, h('tr', null, ['Arquivo', 'Aba', 'Tabela destino', 'Linhas', 'Situação / ação'].map((x) => h('th', null, x)))), h('tbody', null, rows)))),
      pl.userScripts?.length ? h('div', { class: 'box' }, h('strong', null, `Scripts que rodam no FIM (${pl.userScripts.length}), nesta ordem:`),
        h('ol', { style: 'margin:6px 0 0;padding-left:22px' }, pl.userScripts.map((x) => h('li', null, h('strong', null, x.name), ' ', h('span', { class: 'small muted mono' }, `${x.file} · ${plural(x.batches, 'lote', 'lotes')}`), ' ', scriptBadges(x.analysis)))),
        h('details', { class: 'hist', style: 'margin-top:6px' }, h('summary', null, 'Ver o texto dos scripts'), h('pre', { class: 'code' }, pl.scriptPreview))) : null,
      h('div', { class: 'hint' }, `Cada aba é importada na sua própria transação (criar → inserir → conferir a contagem → COMMIT). Se uma aba falhar, só ela é desfeita e as demais continuam; o resultado aparece aba por aba. `,
        pl.userScripts?.length ? 'Os scripts rodam no fim, numa transação própria, somente se todas as abas forem importadas. ' : '',
        `Hash do lote: ${pl.hash.slice(0, 16)}… — a planilha é relida na execução e precisa ser a mesma revisada. O plano expira às ${new Date(pl.expiresAt).toLocaleTimeString('pt-BR')}.`),
    ], [h('button', { class: 'btn', onclick: step2 }, '← Voltar e ajustar'), h('span', { class: 'spacer' }), cancel(), simBtn, runBtn]);
  }

  // ---------- Passo 4: execução com progresso aba por aba ----------
  function step4(jobId, dryRun) {
    w.step = 4;
    const bar = h('div'); const msg = h('div', { class: 'muted' }, 'Iniciando…'); const list = h('div'); const result = h('div');
    show([h('div', { class: 'progress' }, bar), msg, list, result], [h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => modal.close() }, 'Fechar')]);
    const icon2 = { pending: h('span', { class: 'muted' }, '○'), running: h('span', { class: 'ck-wait' }, '◐'), done: h('span', { class: 'ck-done' }, '✓'), error: h('span', { class: 'ck-bad' }, '✕'), skipped: h('span', { class: 'muted' }, '–') };
    clearInterval(w.timer);
    w.timer = setInterval(async () => {
      try {
        const j = await api('GET', `/api/jobs/${jobId}`);
        const frac = j.total ? Math.min(1, (j.done + (j.stepTotal ? (j.stepDone || 0) / j.stepTotal : 0)) / j.total) : 1;
        bar.style.width = `${Math.round(frac * 100)}%`;
        msg.textContent = j.status === 'running' ? `${dryRun ? 'Simulando' : 'Importando'} ${Math.min(j.done + 1, j.total)} de ${j.total}${j.current ? ` — ${j.current}` : ''}` : `${j.done} de ${j.total} processadas`;
        list.replaceChildren(h('div', { class: 'batch-result' }, j.items.map((x) => h('div', { class: `batch-item ${x.status}` }, icon2[x.status].cloneNode(true),
          h('div', { class: 'grow stack', style: 'gap:1px' }, h('span', null, h('strong', null, `${x.file} / ${x.sheet}`)),
            h('span', { class: 'small muted' }, `Tabela ${x.table}${x.rows != null ? ` · ${plural(x.rows, 'registro', 'registros')}` : ''}${x.status === 'done' && dryRun ? ' · desfeita (simulação)' : ''}`),
            x.error ? h('span', { class: 'small', style: 'color:var(--bad-text)' }, x.status === 'skipped' ? `Não importada: ${x.error}` : `Erro: ${x.error}`) : null)))));
        if (j.status === 'running') return;
        clearInterval(w.timer);
        bar.style.width = '100%';
        const r = j.result || { ok: 0, failed: 0, skipped: 0 };
        result.replaceChildren(...[ // replaceChildren escreveria "null": nulos filtrados
          j.status === 'error' ? h('div', { class: 'box bad' }, j.error)
            : h('div', { class: r.failed ? 'result-bad' : 'result-ok' }, dryRun ? `Simulação concluída: ${plural(r.ok, 'aba executou', 'abas executaram')} sem erro e tudo foi DESFEITO.${r.failed ? ` ${plural(r.failed, 'aba falhou', 'abas falharam')}.` : ''}`
              : `${plural(r.ok, 'aba importada', 'abas importadas')}${r.failed ? ` · ${plural(r.failed, 'com falha', 'com falha')} (só elas foram desfeitas)` : ''}${r.skipped ? ` · ${plural(r.skipped, 'não importada', 'não importadas')} (motivo acima)` : ''}.`),
          j.scripts ? h('div', { class: 'stack' }, h('strong', null, 'Scripts pós-importação'),
            j.scripts.status === 'done' ? (j.scripts.output || []).map((x) => scriptOutput(x, true))
              : j.scripts.status === 'error' ? [h('div', { class: 'box bad' }, `Os scripts falharam e foram desfeitos (as tabelas importadas continuam): ${j.scripts.error}`), ...(j.scripts.output || []).map((x) => scriptOutput(x, true))]
                : h('div', { class: 'small muted' }, j.scripts.reason || 'Não executados.')) : null,
          h('div', { class: 'hint' }, 'O registro de cada aba está na Auditoria de execuções.')].filter(Boolean));
      } catch (e) { clearInterval(w.timer); fail(e); }
    }, 400);
  }

  step1();
}
