'use strict';
// Assistente de importação XLSX → SQL Server.
// Fluxo: 1 Origem → 2 Abas/tabelas → 3 Revisão e autorização → 4 Execução.
// Nada é executado antes do passo 3 ser autorizado explicitamente.

const TYPE_LABEL = { text: 'Texto', bigint: 'Inteiro', decimal: 'Decimal', datetime: 'Data/hora', bit: 'Sim/Não' };
const MODE_LABEL = {
  fail: 'Não sobrescrever (parar se existir)',
  replace: 'Apagar a antiga (DROP) e criar de novo',
  backup: 'Renomear a antiga como backup e criar nova',
};
const MODE_HINT = {
  fail: 'Se alguma tabela já existir, o plano fica bloqueado e nada é alterado.',
  replace: 'As tabelas que já existirem serão apagadas (DROP TABLE) e recriadas. Você ainda verá o script antes de executar.',
  backup: 'As tabelas que já existirem serão renomeadas para <nome>_bkp_<data_hora> e recriadas. Nenhum dado é apagado.',
};

// ---------- Scripts SQL depois da importação (opcional) — compartilhado pelos assistentes de arquivo único e de diretório ----------
// Lista os scripts cadastrados; os marcados rodam nesta ordem, na mesma base (em que transação: ctx.note de cada assistente).
async function importScriptsBox(host, w, ctx) {
  if (!w.scriptList) {
    host.replaceChildren(h('div', { class: 'box muted' }, 'Carregando scripts…'));
    try { [w.scriptList] = await Promise.all([api('GET', '/api/scripts'), loadBuiltinVars()]); } catch (e) { host.replaceChildren(h('div', { class: 'box warn' }, `Não foi possível carregar os scripts: ${e.message}`)); return; }
  }
  const all = w.scriptList;
  const byId = (id) => all.find((x) => x.id === id);
  const usable = (x) => x.exists && !x.analysis?.blocked?.length && !x.analysis?.tooManyBatches && x.analysis?.batches > 0;
  w.scriptIds = w.scriptIds.filter((id) => byId(id)); // scripts removidos deixam de ser lembrados
  const { project, base } = ctx;
  const redraw = () => { ctx.onChange(); importScriptsBox(host, w, ctx); };
  const move = (i, d) => { const ids = w.scriptIds; [ids[i], ids[i + d]] = [ids[i + d], ids[i]]; redraw(); };
  const toggle = (id, on) => { w.scriptIds = on ? [...w.scriptIds, id] : w.scriptIds.filter((x) => x !== id); redraw(); };

  const line = (x, i) => {
    const on = i >= 0, ok = usable(x);
    const why = !x.exists ? 'arquivo não encontrado' : x.analysis?.blocked?.length ? 'contém comandos bloqueados — edite o script' : x.analysis?.tooManyBatches ? 'lotes demais' : !x.analysis?.batches ? 'script vazio' : '';
    return h('div', { class: 'row' },
      h('label', { class: 'check grow', style: 'display:flex;gap:8px;align-items:flex-start' },
        h('input', { type: 'checkbox', checked: on, disabled: !ok && !on, onchange: (e) => toggle(x.id, e.target.checked) }),
        h('span', { class: 'stack' },
          h('span', { class: 'inline' }, on ? h('span', { class: 'pill done' }, `${i + 1}º`) : null, h('strong', null, x.name), scriptBadges(x.analysis), why ? h('span', { class: 'pill overdue' }, why) : null),
          x.description ? h('span', { class: 'small muted' }, x.description) : null,
          h('span', { class: 'small muted mono' }, `${x.file} · ${plural(x.analysis?.batches ?? 0, 'lote', 'lotes')}`))),
      on ? h('div', { class: 'actions' },
        h('button', { class: 'btn sm ghost', disabled: i === 0, title: 'Executar antes', 'aria-label': `Subir ${x.name}`, onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn sm ghost', disabled: i === w.scriptIds.length - 1, title: 'Executar depois', 'aria-label': `Descer ${x.name}`, onclick: () => move(i, 1) }, '↓')) : null);
  };
  const chosen = w.scriptIds.map((id, i) => line(byId(id), i));
  const others = all.filter((x) => !w.scriptIds.includes(x.id)).map((x) => line(x, -1));
  const onBox = h('input', { type: 'checkbox', checked: w.scriptsOn, onchange: (e) => { w.scriptsOn = e.target.checked; redraw(); } });

  // Variáveis {{NOME}} dos scripts marcados: as automáticas mostram o valor que será usado; as demais viram campos.
  const used = [...new Set(w.scriptIds.flatMap((id) => byId(id)?.analysis?.variables || []))];
  const conn = base()[w.env] || {};
  const autoValue = { BANCO: conn.database, SCHEMA: w.schema.trim() || 'dbo', SERVIDOR: conn.server, AMBIENTE: w.env === 'prod' ? 'PRODUCAO' : 'LOCAL', PROJETO: project.name, BASE: base().name };
  const varsBox = used.length ? h('div', { class: 'box', style: 'display:grid;gap:8px;background:var(--s0)' },
    h('strong', null, 'Variáveis dos scripts'),
    h('div', { class: 'varsgrid' }, used.map((n) => isBuiltinVar(n)
      ? [varTag(n), h('span', { class: 'mono' }, autoValue[n] ?? '—', h('span', { class: 'muted' }, '  (automática)'))]
      : [varTag(n), h('input', { type: 'text', value: w.scriptVars[n] || '', maxlength: 128, placeholder: 'valor (ex.: nome de um banco)', 'aria-label': `Valor de ${n}`,
        oninput: (e) => { w.scriptVars[n] = e.target.value.trim(); ctx.onChange(); } })])),
    h('div', { class: 'hint' }, 'Os valores são trocados no texto antes de gerar o plano; a revisão mostra o script já com eles. Valores aceitam só letras, números, espaço, _ . -')) : null;

  host.replaceChildren(h('div', { class: 'box', style: 'display:grid;gap:10px' },
    h('label', { class: 'check', style: 'display:flex;gap:8px;align-items:flex-start' }, onBox,
      h('span', { class: 'stack' }, h('strong', null, 'Executar scripts SQL depois de importar'),
        h('span', { class: 'small muted' }, ctx.note))),
    w.scriptsOn ? (all.length
      ? h('div', { class: 'stack' }, chosen, varsBox, others.length ? h('div', { class: 'hint' }, chosen.length ? 'Outros scripts disponíveis:' : 'Marque os scripts que devem rodar (a ordem de marcação é a ordem de execução):') : null, others,
        !w.scriptIds.length ? h('div', { class: 'small', style: 'color:var(--warn-text)' }, 'Nenhum script marcado.') : null,
        h('div', { class: 'hint' }, 'Você verá o texto completo de cada script na revisão, antes de executar. ', h('a', { href: '#/scripts', onclick: () => ctx.close() }, 'Gerenciar scripts')))
      : h('div', { class: 'small muted' }, 'Nenhum script cadastrado ainda. ', h('a', { href: '#/scripts', onclick: () => ctx.close() }, 'Cadastrar em “Scripts SQL”'), '.')) : null));
}

// Saída de um script: resumo + mensagens (PRINT) + pequenos resultados de SELECT. Só na tela, nunca na auditoria.
function scriptOutput(x, open) {
  const hasOut = x.messages?.length || x.results?.length;
  return h('details', { class: 'scriptout', open: open && hasOut ? true : null },
    h('summary', null, h('strong', null, x.name), ` — ${plural(x.batches, 'lote executado', 'lotes executados')}, ${plural(x.rowsAffected, 'linha afetada', 'linhas afetadas')}`,
      hasOut ? h('span', { class: 'muted' }, ` · ${plural(x.messages.length, 'mensagem', 'mensagens')}${x.results.length ? `, ${plural(x.results.length, 'resultado', 'resultados')}` : ''}`) : null),
    x.messages?.length ? h('pre', { class: 'code', style: 'max-height:260px' }, x.messages.join('\n')) : null,
    (x.results || []).map((rs) => h('div', { class: 'tablewrap', style: 'max-height:220px;margin-top:6px' }, h('table', null,
      h('thead', null, h('tr', null, rs.columns.map((c) => h('th', null, c || '(sem nome)')))),
      h('tbody', null, rs.rows.map((r) => h('tr', null, r.map((v) => h('td', { class: v === null ? 'muted' : '' }, v === null ? 'NULL' : v))))),
      rs.total > rs.rows.length ? h('caption', { class: 'small muted', style: 'caption-side:bottom;text-align:left' }, `mostrando ${rs.rows.length} de ${rs.total} linhas`) : null))),
    x.truncated ? h('div', { class: 'hint' }, 'Saída muito longa: parte das mensagens/resultados foi omitida.') : null);
}

function openImportWizard(project, preset = {}) {
  const usable = project.bases.filter((b) => b.local || b.prod);
  const fresh = () => state.projects.find((p) => p.id === project.id) || project; // estado atualizado após anexar
  // A planilha DE-PARA do projeto já vem associada: a indicada, senão a primeira com arquivo anexado, senão a primeira cadastrada.
  const firstDepara = project.deparas.find((d) => d.id === preset.deparaId) || project.deparas.find((d) => d.fileExists) || project.deparas[0];
  // Planilha configurada para importação por DIRETÓRIO: assistente próprio (import-batch.js). Os dois modos nunca se misturam.
  if (firstDepara?.importMode === 'dir') return openBatchImportWizard(project, { deparaId: firstDepara.id });
  const w = {
    step: 1, baseId: usable[0]?.id, env: usable[0]?.local ? 'local' : 'prod', deparaId: firstDepara?.id,
    mode: 'fail', schema: 'dbo', filter: '', restored: false, filePath: '', inspect: null, cfg: [], plan: null, timer: null,
    scriptsOn: false, scriptIds: [], scriptVars: {}, scriptList: null, // scripts SQL executados depois da importação (ordem = ordem de execução)
  };
  const depara = () => fresh().deparas.find((d) => d.id === w.deparaId);
  let modal;
  const stepsEl = () => h('div', { class: 'steps' }, ['1. Origem', '2. Abas e tabelas', '3. Revisão e autorização', '4. Execução'].map((t, i) => h('span', { class: w.step === i + 1 ? 'on' : w.step > i + 1 ? 'past' : '' }, t)));
  const base = () => project.bases.find((b) => b.id === w.baseId);

  const renderScriptsBox = (host) => importScriptsBox(host, w, { project, base, onChange: autosave, close: () => modal.close(),
    note: 'Os scripts marcados rodam na mesma base, logo após as tabelas serem criadas e conferidas, dentro da mesma transação (se algum falhar, a importação inteira é desfeita).' });

  function show(body, footer) {
    const pos = modal?.overlay.scrollTop || 0;
    modal?.overlay.remove();
    modal = openModal({ title: `Importar planilha — ${project.name}`, wide: true, steps: stepsEl(), body, footer, onClose: () => clearInterval(w.timer) });
    modal.overlay.scrollTop = pos;
  }
  const cancel = () => h('button', { class: 'btn', onclick: () => modal.close() }, 'Cancelar');

  // ---------- Passo 1: planilha (já associada), base e ambiente ----------
  function step1() {
    w.step = 1;
    const b = base();
    const dep = depara();
    const hasFile = dep.fileExists;
    const blockedByFlag = dep.importable === false; // trava extra (o botão que abre o assistente já vem desabilitado nesse caso)

    // A planilha já vem associada ao projeto; para trocar pela versão mais nova, basta anexar de novo.
    const deparaBlock = h('div', { class: 'box' },
      h('div', { class: 'inline', style: 'margin-bottom:6px' }, h('strong', { style: 'flex:1' }, `Planilha: ${dep.label}`),
        fresh().deparas.length > 1 ? h('select', { style: 'width:auto', onchange: (e) => { w.deparaId = e.target.value; if (depara()?.importMode === 'dir') { modal.close(); openBatchImportWizard(project, { deparaId: w.deparaId }); return; } step1(); } }, fresh().deparas.map((d) => h('option', { value: d.id, selected: d.id === w.deparaId }, d.label))) : null),
      blockedByFlag ? h('div', { class: 'small', style: 'color:var(--bad-text)' }, 'Esta planilha não está marcada para importação. Habilite “Permitir importar esta planilha para o banco” ao editá-la.') : null,
      hasFile
        ? h('div', { class: 'small' }, h('span', { class: 'mono' }, dep.lastDownload.path), h('div', { class: 'muted' }, `Anexada em ${fmtDateTime(dep.lastDownload.at)} · ${fmtSize(dep.lastDownload.size)}`))
        : h('div', { class: 'small', style: 'color:var(--warn-text)' }, 'Nenhum arquivo anexado. Baixe o .xlsx pelo Google Sheets (Arquivo → Fazer download → Microsoft Excel) e anexe aqui.'),
      h('div', { class: 'inline', style: 'margin-top:8px' },
        h('button', { class: `btn sm${hasFile ? '' : ' primary'}`, onclick: async () => { if (await attachDepara(fresh(), dep)) step1(); } }, hasFile ? 'Anexar nova versão…' : 'Anexar planilha…')),
      hasFile ? h('div', { class: 'hint', style: 'margin-top:6px' }, 'Baixou uma versão mais nova? Anexe antes de continuar. Feche a planilha no Excel.') : null);

    // Só pergunta o que realmente tem escolha: base (se houver mais de uma) e ambiente (se houver os dois).
    const baseField = usable.length > 1
      ? field('Base de dados de destino', h('select', { onchange: (e) => { w.baseId = e.target.value; const nb = base(); if (!nb[w.env]) w.env = nb.local ? 'local' : 'prod'; step1(); } },
        usable.map((x) => h('option', { value: x.id, selected: x.id === w.baseId }, x.name))))
      : h('div', null, h('span', { class: 'lbl' }, 'Base de dados de destino: '), b.name);
    const envRadio = (env, title, sub) => h('label', { class: 'check row', style: 'flex:1' },
      h('input', { type: 'radio', name: 'env', checked: w.env === env, onchange: () => { w.env = env; step1(); } }),
      h('span', null, h('strong', null, title), h('div', { class: 'small muted' }, `${sub}: ${connLine(b[env])}`)));
    const envField = b.local && b.prod
      ? h('div', null, h('div', { class: 'lbl' }, 'Onde salvar'), h('div', { class: 'inline', style: 'align-items:stretch;margin-top:4px' },
        envRadio('local', 'Localhost (teste)', 'Recomendado primeiro'), envRadio('prod', 'Produção', 'Base real')))
      : h('div', null, h('span', { class: 'lbl' }, 'Onde salvar: '), b.local ? `Localhost (teste) — ${connLine(b.local)}` : `Produção — ${connLine(b.prod)}`);

    show([deparaBlock, baseField, envField,
      w.env === 'prod' ? h('div', { class: 'box bad' }, h('strong', null, 'Atenção: produção. '), 'Você verá o script completo, com o servidor e o banco de destino, antes de qualquer execução.') : null,
    ], [cancel(), h('button', { class: 'btn primary', disabled: !hasFile || blockedByFlag, title: blockedByFlag ? 'Planilha não marcada para importação' : hasFile ? '' : 'Anexe a planilha para continuar', onclick: (e) => busy(e.target, async () => {
      const d = depara();
      w.filePath = d.lastDownload.path;
      w.inspect = await api('POST', '/api/import/inspect', { filePath: w.filePath });
      buildConfig(d);
      step2();
    }) }, 'Continuar')]);
  }

  // Monta a configuração das abas: padrões da planilha + o que foi usado na última importação deste DE-PARA
  // (nomes de tabelas/colunas e tipos; o modo de sobrescrita NUNCA é lembrado).
  function buildConfig(d, useSaved = true) {
    const saved = useSaved ? d.importConfig : null;
    w.restored = !!saved;
    w.schema = saved?.schema || 'dbo';
    w.scriptsOn = !!saved?.scripts?.enabled; // só os ids são lembrados; o texto é sempre lido do arquivo na hora do plano
    w.scriptIds = [...(saved?.scripts?.ids || [])];
    w.scriptVars = { ...(saved?.scripts?.vars || {}) };
    w.cfg = w.inspect.sheets.map((s) => {
      const sv = saved?.sheets?.find((x) => x.sheetName === s.name);
      return {
        sheet: s.name, include: sv ? sv.include : s.rowCount > 0 && !s.hidden, table: sv?.tableName || s.suggestedTable,
        cols: s.columns.map((c) => {
          const sc = sv?.columns?.find((x) => x.index === c.index && x.header === c.header);
          return { index: c.index, include: sc ? sc.include : true, name: sc?.name || c.suggestedName, type: sc?.type || 'text', suggested: c.suggestedType, header: c.header, sample: c.sample };
        }),
      };
    });
  }

  // Seleção atual (todas as abas, inclusive as desmarcadas) no formato lembrado por DE-PARA. O modo de sobrescrita NÃO entra.
  const currentConfig = () => ({ deparaId: w.deparaId, schema: w.schema.trim(), scripts: { enabled: w.scriptsOn, ids: w.scriptIds, vars: w.scriptVars }, sheets: w.cfg.map((s) => ({
    sheetName: s.sheet, include: s.include, tableName: s.table.trim(),
    columns: s.cols.map((c) => ({ index: c.index, header: c.header, include: c.include, name: c.name.trim(), type: c.type })),
  })) });
  // Salva 0,5 s depois da última alteração, sem precisar gerar o plano; também atualiza o estado local para a próxima abertura.
  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const cfg = currentConfig();
      try {
        await api('PUT', `/api/projects/${project.id}/deparas/${cfg.deparaId}/import-config`, cfg);
        const d = depara(); if (d) d.importConfig = { savedAt: new Date().toISOString(), schema: cfg.schema, sheets: cfg.sheets, scripts: cfg.scripts };
      } catch { /* silencioso: o salvamento também acontece ao gerar o plano */ }
    }, 500);
  }

  // ---------- Passo 2: abas, tabelas e a regra geral de sobrescrita ----------
  function step2() {
    w.step = 2;
    const prodLocked = w.env === 'prod' && !base().allowProdOverwrite;
    if (prodLocked) w.mode = 'fail';
    const selected = () => w.cfg.filter((s) => s.include).length;
    const refs = []; // uma entrada por aba: { sh, tr, detail, box, match, open }

    // Lista compacta: uma linha por aba (marcar + nome + linhas + tabela destino). As colunas ficam recolhidas
    // e só abrem se você quiser ajustar nome/tipo. Tudo o que for marcado/alterado é salvo na hora para a próxima importação.
    const rows = w.cfg.flatMap((sh, si) => {
      const meta = w.inspect.sheets[si];
      const notes = [];
      if (meta.notes?.formulaErrors) notes.push(`${plural(meta.notes.formulaErrors, 'célula com erro de fórmula', 'células com erro de fórmula')} (#N/A, #REF!…) → NULL`);
      if (meta.notes?.noValue) notes.push(`${plural(meta.notes.noValue, 'fórmula sem valor salvo', 'fórmulas sem valor salvo')} → NULL`);

      // Colunas da aba, com busca própria; "marcar/desmarcar" vale só para as colunas visíveis na busca.
      const colRefs = [];
      const colSearch = h('input', { type: 'text', placeholder: 'Buscar coluna…', 'aria-label': `Buscar coluna em ${sh.sheet}`, style: 'max-width:260px' });
      const colMark = h('button', { class: 'btn sm', onclick: () => setCols(true) }, 'Marcar todas');
      const colClear = h('button', { class: 'btn sm ghost', onclick: () => setCols(false) }, 'Desmarcar todas');
      const colEmpty = h('div', { class: 'hint', hidden: true }, 'Nenhuma coluna corresponde à busca.');
      const setCols = (v) => { for (const x of colRefs) if (!x.tr.hidden) { x.c.include = v; x.box.checked = v; } autosave(); };
      const applyColFilter = () => {
        const q = norm(colSearch.value.trim());
        for (const x of colRefs) x.tr.hidden = !!q && !norm(`${x.c.header} ${x.c.name}`).includes(q);
        const n = colRefs.filter((x) => !x.tr.hidden).length;
        colMark.textContent = q ? `Marcar ${plural(n, 'visível', 'visíveis')}` : 'Marcar todas';
        colClear.textContent = q ? `Desmarcar ${plural(n, 'visível', 'visíveis')}` : 'Desmarcar todas';
        colEmpty.hidden = !(q && n === 0);
      };
      colSearch.addEventListener('input', applyColFilter);
      const colsTable = h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Usar', 'Coluna na planilha', 'Nome na tabela', 'Tipo', 'Exemplos'].map((t) => h('th', null, t)))),
        h('tbody', null, sh.cols.map((c) => {
          const box = h('input', { type: 'checkbox', checked: c.include, onchange: (e) => { c.include = e.target.checked; autosave(); } });
          const ctr = h('tr', null,
            h('td', null, box),
            h('td', null, c.header || h('span', { class: 'muted' }, '(sem título)')),
            h('td', null, h('input', { type: 'text', value: c.name, oninput: (e) => { c.name = e.target.value; autosave(); } })),
            h('td', null, h('select', { onchange: (e) => { c.type = e.target.value; autosave(); } }, Object.entries(TYPE_LABEL).map(([k, t]) => h('option', { value: k, selected: c.type === k }, k === c.suggested && k !== 'text' ? `${t} (sugerido)` : t)))),
            h('td', { class: 'small muted' }, c.sample.join(' · ')));
          colRefs.push({ c, tr: ctr, box });
          return ctr;
        }))));
      const detail = h('tr', { class: 'detail', hidden: true }, h('td', { colspan: 5 },
        h('div', { class: 'inline', style: 'margin-bottom:6px' }, colSearch, colMark, colClear),
        colsTable, colEmpty, h('div', { class: 'hint', style: 'margin:4px 0 0' }, 'Por padrão tudo vira texto, preservando zeros à esquerda.')));

      const match = h('span', { class: 'small muted' });
      const ref = { sh, tr: null, detail, box: null, match, open: false };
      const toggle = h('button', { class: 'btn sm ghost', title: 'Ver/ajustar colunas', onclick: () => { ref.open = !ref.open; applyOpen(ref); toggle.textContent = `${ref.open ? '▾' : '▸'} ${plural(sh.cols.length, 'coluna', 'colunas')}`; } }, `▸ ${plural(sh.cols.length, 'coluna', 'colunas')}`);
      ref.box = h('input', { type: 'checkbox', title: 'Importar esta aba', checked: sh.include, onchange: (e) => { sh.include = e.target.checked; ref.tr.classList.toggle('off', !sh.include); refreshCount(); autosave(); } });
      ref.tr = h('tr', { class: sh.include ? '' : 'off' },
        h('td', null, ref.box),
        h('td', null, h('strong', null, sh.sheet), meta.hidden ? h('span', { class: 'small muted' }, ' (oculta)') : null,
          notes.length ? h('span', { class: 'small', style: 'color:var(--warn-text);cursor:help', title: notes.join('\n') }, ' ⚠') : null, match),
        h('td', { class: 'num small muted' }, meta.rowCount.toLocaleString('pt-BR')),
        h('td', null, h('input', { type: 'text', value: sh.table, 'aria-label': `Tabela destino de ${sh.sheet}`, oninput: (e) => { sh.table = e.target.value; autosave(); } })),
        h('td', null, toggle));
      refs.push(ref);
      return [ref.tr, detail];
    });
    const applyOpen = (r) => { r.detail.hidden = !(r.open && !r.tr.hidden); }; // colunas de uma aba escondida pela busca não aparecem
    const emptyRow = h('tr', { hidden: true }, h('td', { colspan: 5, class: 'empty' }, ''));
    const list = h('div', { class: 'tablewrap', style: 'max-height:none' }, h('table', { class: 'compact' },
      h('thead', null, h('tr', null, ['', 'Aba', 'Linhas', 'Tabela destino', 'Colunas'].map((t) => h('th', null, t)))), h('tbody', null, rows, emptyRow)));

    // ---- Busca de abas (nome da aba, nome da tabela ou colunas) e seleção só do que está visível ----
    const count = h('span', { class: 'muted' });
    const selAll = h('button', { class: 'btn sm', onclick: () => setVisible(true) }, 'Selecionar todas');
    const selNone = h('button', { class: 'btn sm ghost', onclick: () => setVisible(false) }, 'Limpar seleção');
    const searchBox = h('input', { type: 'text', value: w.filter, placeholder: 'Buscar aba, tabela ou coluna…', 'aria-label': 'Buscar abas', style: 'flex:1;min-width:220px',
      oninput: (e) => { w.filter = e.target.value; applyFilter(); },
      onkeydown: (e) => { if (e.key === 'Escape') { e.target.value = ''; w.filter = ''; applyFilter(); } } });
    const clearSearch = h('button', { class: 'btn sm ghost', title: 'Limpar busca (Esc)', onclick: () => { searchBox.value = ''; w.filter = ''; applyFilter(); searchBox.focus(); } }, '✕');
    function refreshCount() {
      const q = w.filter.trim();
      const hiddenPicked = q ? refs.filter((r) => r.tr.hidden && r.sh.include).length : 0;
      const shown = refs.filter((r) => !r.tr.hidden).length;
      count.textContent = `${selected()} de ${w.cfg.length} abas selecionadas${q ? ` · mostrando ${shown}` : ''}${hiddenPicked ? ` · ${plural(hiddenPicked, 'selecionada está fora da busca', 'selecionadas estão fora da busca')} (continuam valendo)` : ''}`;
    }
    function applyFilter() {
      const q = norm(w.filter.trim());
      for (const r of refs) {
        const nameHit = !q || norm(`${r.sh.sheet} ${r.sh.table}`).includes(q);
        const colHit = q && !nameHit ? r.sh.cols.find((c) => norm(`${c.header} ${c.name}`).includes(q)) : null;
        r.tr.hidden = !(nameHit || colHit);
        r.match.textContent = colHit ? ` · coluna: ${colHit.header || colHit.name}` : '';
        applyOpen(r);
      }
      const n = refs.filter((r) => !r.tr.hidden).length;
      selAll.textContent = q ? `Selecionar ${plural(n, 'visível', 'visíveis')}` : 'Selecionar todas';
      selNone.textContent = q ? `Limpar ${plural(n, 'visível', 'visíveis')}` : 'Limpar seleção';
      selAll.disabled = selNone.disabled = n === 0;
      clearSearch.hidden = !q;
      emptyRow.hidden = !(q && n === 0);
      emptyRow.firstChild.textContent = `Nenhuma aba corresponde a “${w.filter.trim()}”.`;
      refreshCount();
    }
    // Marca/desmarca SÓ as abas visíveis (as escondidas pela busca não são alteradas).
    function setVisible(v) {
      for (const r of refs) if (!r.tr.hidden) { r.sh.include = v; r.box.checked = v; r.tr.classList.toggle('off', !v); }
      refreshCount(); autosave();
    }

    const hint = h('div', { class: 'hint' }, MODE_HINT[w.mode]);
    const modeSel = h('select', { onchange: (e) => { w.mode = e.target.value; hint.textContent = MODE_HINT[w.mode]; hint.style.color = w.mode === 'replace' ? 'var(--bad-text)' : ''; } },
      Object.entries(MODE_LABEL).map(([k, t]) => h('option', { value: k, selected: w.mode === k, disabled: prodLocked && k !== 'fail' }, t)));
    hint.style.color = w.mode === 'replace' ? 'var(--bad-text)' : '';

    // Regra única para TODAS as abas selecionadas (nada de configurar tabela por tabela).
    const general = h('div', { class: 'box', style: 'display:grid;gap:10px' },
      h('div', { class: 'cols3', style: 'grid-template-columns:minmax(0,2fr) minmax(0,1fr)' },
        field('Se a tabela já existir — vale para todas as abas selecionadas', modeSel),
        field('Schema', h('input', { type: 'text', value: w.schema, oninput: (e) => { w.schema = e.target.value; autosave(); } }))),
      hint,
      prodLocked ? h('div', { class: 'small', style: 'color:var(--warn-text)' }, 'Em produção, esta base só permite criar tabelas novas (sobrescrever está desativado nas configurações da base).') : null);
    const toolbar = h('div', { class: 'box', style: 'display:grid;gap:8px' }, h('div', { class: 'inline' }, searchBox, clearSearch),
      h('div', { class: 'inline' }, count, selAll, selNone));
    applyFilter(); // aplica a busca mantida (ex.: ao voltar para este passo) e atualiza contadores

    const scriptsHost = h('div');
    renderScriptsBox(scriptsHost);

    show([
      h('div', { class: 'muted' }, 'Marque as abas que viram tabelas e confira os nomes. Nada é executado neste passo. A seleção é salva automaticamente para a próxima importação.'),
      w.restored ? h('div', { class: 'small muted' }, 'Seleção, nomes e tipos da última importação desta planilha foram aplicados. ',
        h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); buildConfig(depara(), false); autosave(); step2(); } }, 'Voltar aos padrões da planilha')) : null,
      general, toolbar, list, scriptsHost,
    ], [h('button', { class: 'btn', onclick: step1 }, '← Voltar'), h('span', { class: 'spacer' }), cancel(),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, buildPlan) }, 'Gerar plano (nada é executado ainda)')]);
  }

  async function buildPlan() {
    const chosen = w.cfg.filter((s) => s.include);
    const sheets = chosen.map((s) => ({
      sheetName: s.sheet, schema: w.schema.trim(), tableName: s.table.trim(), mode: w.mode,
      columns: s.cols.filter((c) => c.include).map((c) => ({ index: c.index, name: c.name.trim(), type: c.type })),
    }));
    const scriptIds = w.scriptsOn ? w.scriptIds : [];
    if (w.scriptsOn && !scriptIds.length) throw new Error('Você marcou “Executar scripts SQL depois de importar”, mas nenhum script foi selecionado. Selecione um script ou desmarque a opção.');
    const needed = [...new Set(scriptIds.flatMap((id) => w.scriptList?.find((x) => x.id === id)?.analysis?.variables || []))].filter((n) => !isBuiltinVar(n));
    const empty = needed.filter((n) => !w.scriptVars[n]);
    if (empty.length) throw new Error(`Preencha o valor de ${empty.map((n) => `{{${n}}}`).join(', ')} em “Variáveis dos scripts”.`);
    w.plan = await api('POST', '/api/import/plan', { projectId: project.id, baseId: w.baseId, env: w.env, filePath: w.filePath, deparaId: w.deparaId, sheets, scriptIds, scriptVars: w.scriptVars, saveConfig: currentConfig() });
    await refresh(); // traz para a tela a configuração lembrada (usada na próxima abertura do assistente)
    step3();
  }


  // ---------- Passo 3 ----------
  function step3() {
    w.step = 3;
    const pl = w.plan;
    const prod = pl.env === 'prod';
    // Sem caixas de confirmação nem texto a digitar: esta tela mostra alvo, comandos destrutivos e o script; o clique
    // em "Executar" é a autorização. Em produção o botão é vermelho e o rótulo diz PRODUÇÃO.
    async function execute(dryRun) {
      const r = await api('POST', `/api/import/plans/${pl.planId}/execute`, { hash: pl.hash, authorized: true, dryRun });
      step4(r.jobId, dryRun);
    }
    const runBtn = h('button', { class: `btn ${prod ? 'danger' : 'primary'}`, disabled: pl.blocked, onclick: (e) => busy(e.target, () => execute(false)) }, prod ? 'Executar em PRODUÇÃO' : 'Executar');
    const simBtn = !prod ? h('button', { class: 'btn', disabled: pl.blocked, onclick: (e) => busy(e.target, () => execute(true)) }, 'Simular (executa e desfaz)') : null;

    const tableRows = pl.tables.map((t) => h('tr', null,
      h('td', null, t.sheet), h('td', { class: 'mono' }, `${t.schema}.${t.table}`), h('td', null, t.rows.toLocaleString('pt-BR')), h('td', null, t.columns.length),
      h('td', null, t.exists ? h('span', { class: 'pill soon' }, `existe (${plural(t.existingRows ?? 0, 'linha', 'linhas')})`) : h('span', { class: 'pill ok' }, 'nova')),
      h('td', { class: 'small' }, t.mode === 'fail' ? 'criar' : t.mode === 'replace' ? h('strong', { style: 'color:var(--bad-text)' }, 'DROP + criar') : h('strong', { style: 'color:var(--warn-text)' }, `renomear → ${t.backupName}`))));

    show([
      h('div', { class: `box${prod ? ' bad' : ''}` }, h('div', { class: 'inline', style: 'margin-bottom:8px' }, pill(prod ? 'prod' : 'local', prod ? 'PRODUÇÃO' : 'LOCALHOST (teste)'), h('strong', null, 'Onde será executado')),
        h('dl', { class: 'kv', style: 'margin:0' }, h('dt', null, 'Servidor'), h('dd', null, `${pl.target.server}  (${pl.target.connectedTo})`), h('dt', null, 'Banco'), h('dd', null, pl.target.database),
          h('dt', null, 'Login'), h('dd', null, `${pl.target.login} · ${pl.target.auth === 'sql' ? 'SQL Server' : 'Windows'}`), h('dt', null, 'Origem'), h('dd', null, w.filePath))),
      pl.issues.length ? h('div', { class: 'box bad' }, h('strong', null, 'Bloqueios — corrija e gere o plano novamente:'), h('ul', null, pl.issues.map((i) => h('li', null, i)))) : null,
      pl.errors.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Aba', 'Linha', 'Coluna', 'Problema', 'Valor'].map((t) => h('th', null, t)))),
        h('tbody', null, pl.errors.map((e) => h('tr', null, h('td', null, e.sheet), h('td', null, e.row), h('td', null, e.column), h('td', null, e.message), h('td', { class: 'mono' }, e.value)))))) : null,
      pl.destructive.length ? h('div', { class: 'box warn' }, h('strong', null, 'Comandos destrutivos neste plano:'), h('ul', null, pl.destructive.map((d) => h('li', null, h('span', { class: 'mono' }, d.table), ' → ', d.action)))) : null,
      pl.userScripts?.length ? h('div', { class: 'box' }, h('strong', null, `Scripts SQL que rodam DEPOIS da importação (${pl.userScripts.length}), nesta ordem:`),
        h('ol', { style: 'margin:6px 0 0;padding-left:22px' }, pl.userScripts.map((x) => h('li', null, h('strong', null, x.name), ' ', h('span', { class: 'small muted mono' }, `${x.file} · ${plural(x.batches, 'lote', 'lotes')}`), ' ', scriptBadges(x.analysis),
          Object.keys(x.variables || {}).length ? h('div', { class: 'small' }, Object.entries(x.variables).map(([k, v]) => [varTag(k), ' = ', h('strong', { class: 'mono' }, v), '   '])) : null))),
        pl.userScripts.some((x) => x.analysis?.dynamic) ? h('div', { class: 'small', style: 'color:var(--warn-text);margin-top:6px' }, 'Há SQL dinâmico: o app não consegue conferir o que ele fará. Leia o texto no script abaixo.') : null,
        h('div', { class: 'hint' }, `O texto completo está no script abaixo, em ${pl.target.server} / ${pl.target.database}. Mesma transação: se um script falhar, a importação também é desfeita.`)) : null,
      h('div', null, h('div', { class: 'lbl', style: 'margin-bottom:4px' }, `O que será feito — ${pl.totalRows.toLocaleString('pt-BR')} linhas em ${plural(pl.tables.length, 'tabela', 'tabelas')}, ${pl.statementCount} comandos, numa única transação`),
        h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Aba', 'Tabela destino', 'Linhas', 'Colunas', 'Situação atual', 'Ação'].map((t) => h('th', null, t)))), h('tbody', null, tableRows)))),
      h('div', null, h('div', { class: 'inline', style: 'margin-bottom:4px' }, h('span', { class: 'lbl grow', style: 'flex:1' }, 'Script que será executado (prévia)'),
        h('a', { class: 'btn sm', href: `/api/import/plans/${pl.planId}/script.sql`, download: '' }, 'Baixar script completo (.sql)')),
        h('pre', { class: 'code' }, pl.scriptPreview),
        h('div', { class: 'hint' }, `Hash do plano: ${pl.hash.slice(0, 16)}… — o servidor só executa exatamente este plano, em ${pl.target.server} / ${pl.target.database}. Se algo falhar, todas as alterações são desfeitas (ROLLBACK). Ao final, a contagem de linhas de cada tabela é conferida antes do COMMIT. O plano expira às ${new Date(pl.expiresAt).toLocaleTimeString('pt-BR')}.`)),
    ], [h('button', { class: 'btn', onclick: step2 }, '← Voltar e ajustar'), h('span', { class: 'spacer' }), cancel(), simBtn, runBtn]);
  }

  // ---------- Passo 4 ----------
  function step4(jobId, dryRun) {
    w.step = 4;
    const bar = h('div', null); const msg = h('div', { class: 'muted' }, 'Executando na transação…'); const result = h('div', null);
    show([h('div', { class: 'progress' }, bar), msg, result], [h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => modal.close() }, 'Fechar')]);
    clearInterval(w.timer);
    w.timer = setInterval(async () => {
      try {
        const j = await api('GET', `/api/jobs/${jobId}`);
        bar.style.width = `${Math.round((j.done / j.total) * 100)}%`;
        msg.textContent = `${j.done} de ${j.total} comandos`;
        if (j.status === 'running') return;
        clearInterval(w.timer);
        if (j.status === 'done') {
          bar.style.width = '100%';
          result.replaceChildren(h('div', { class: 'result-ok' }, dryRun ? 'Simulação concluída: tudo executou sem erro e foi DESFEITO (nada foi gravado).' : 'Importação concluída com sucesso (COMMIT).'),
            h('div', { class: 'muted' }, `${w.plan.tables.map((t) => `${t.schema}.${t.table} (${plural(t.rows, 'linha', 'linhas')})`).join(', ')} em ${w.plan.target.server} / ${w.plan.target.database}.`),
            j.result?.scripts?.length ? h('div', { class: 'stack' }, h('strong', null, dryRun ? 'Scripts SQL executados (desfeitos):' : 'Scripts SQL executados:'),
              j.result.scripts.map((x) => scriptOutput(x, true))) : null,
            h('div', { class: 'hint' }, 'O registro está na página de Auditoria.'));
        } else {
          result.replaceChildren(h('div', { class: 'result-bad' }, 'A execução falhou. Todas as alterações foram desfeitas (ROLLBACK).'), h('div', { class: 'box bad' }, j.error),
            (j.scripts || []).map((x) => scriptOutput(x, x.messages?.length > 0)));
        }
      } catch (e) { clearInterval(w.timer); fail(e); }
    }, 400);
  }

  step1();
}
