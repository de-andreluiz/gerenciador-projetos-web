'use strict';
// Scripts SQL: tratamentos de dados guardados como arquivos .sql na pasta do app (data\scripts) e que podem
// ser executados automaticamente DEPOIS da importação de uma planilha (mesma base, mesma transação).

let scriptsCache = [];
const loadScripts = async () => { scriptsCache = await api('GET', '/api/scripts'); return scriptsCache; };

// Variáveis automáticas ({{BANCO}}, {{SCHEMA}}…): o app preenche a partir do destino da importação.
let builtinVars = null;
const loadBuiltinVars = async () => (builtinVars ||= await api('GET', '/api/scripts-variables').catch(() => []));
const isBuiltinVar = (n) => (builtinVars || []).some((v) => v.name === n);
const varTag = (n) => h('span', { class: `vartag${isBuiltinVar(n) ? ' auto' : ''}`, title: isBuiltinVar(n) ? 'Preenchida automaticamente pelo app' : 'Você informa o valor na importação' }, `{{${n}}}`);

const DESTRUCTIVE_LABEL = { DELETE: 'apaga linhas (DELETE)', TRUNCATE: 'esvazia tabelas (TRUNCATE)', DROP: 'remove objetos (DROP)' };

// Selos curtos usados na lista e no assistente de importação.
function scriptBadges(a) {
  if (!a) return [];
  return [
    a.blocked?.length ? h('span', { class: 'pill overdue', title: 'Contém comandos que o app nunca executa' }, 'bloqueado') : null,
    ...(a.destructive || []).map((d) => h('span', { class: 'pill soon', title: `Linha ${d.line}: ${DESTRUCTIVE_LABEL[d.kw] || d.kw}${d.dynamic ? ' — montado em SQL dinâmico' : ''}` }, d.dynamic ? `${d.kw} (dinâmico)` : d.kw)),
    a.dynamic ? h('span', { class: 'pill soon', title: 'SQL dinâmico: o app não consegue conferir o que ele fará' }, 'SQL dinâmico') : null,
  ].filter(Boolean);
}

// Resumo do que o script faz e do que o app recusa/avisa (mesma análise usada como trava na execução).
function scriptFindings(a) {
  if (!a) return null;
  const counts = Object.entries(a.counts || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ');
  return h('div', { class: 'stack' },
    h('div', { class: 'small muted' }, `${plural(a.batches, 'lote', 'lotes')}${counts ? ` · ${counts}` : ''}`),
    a.tooManyBatches ? h('div', { class: 'box bad' }, h('strong', null, 'Lotes demais.'), ' Divida o script em partes.') : null,
    a.blocked?.length ? h('div', { class: 'box bad' }, h('strong', null, 'O app não executa este script:'),
      h('ul', null, a.blocked.slice(0, 8).map((b) => h('li', null, `${b.message} `, h('span', { class: 'muted' }, `(linha ${b.line})`))),
        a.blocked.length > 8 ? h('li', null, `… e mais ${a.blocked.length - 8}`) : null),
      h('div', { class: 'small' }, 'Transações, troca de banco, backup/restore, permissões, xp_cmdshell e similares são bloqueados por segurança.')) : null,
    a.destructive?.length ? h('div', { class: 'box warn' }, h('strong', null, 'Este script apaga dados:'),
      h('ul', null, a.destructive.map((d) => h('li', null, `${DESTRUCTIVE_LABEL[d.kw] || d.kw} ×${d.count}${d.dynamic ? ' — dentro de um texto de SQL dinâmico' : ''} `, h('span', { class: 'muted' }, `(1ª na linha ${d.line})`)))),
      h('div', { class: 'small' }, 'Em bases de produção só roda se a base tiver a permissão de sobrescrever/apagar habilitada.')) : null,
    a.dynamic ? h('div', { class: 'box warn' }, h('strong', null, 'Usa SQL dinâmico (EXEC / sp_executesql).'),
      ' O app procura DELETE/DROP/TRUNCATE e comandos proibidos dentro dos textos, mas não consegue conferir tudo o que será montado — revise com atenção.') : null,
    a.variables?.length ? h('div', { class: 'box' }, h('strong', null, 'Variáveis: '), a.variables.map((n) => [varTag(n), ' ']),
      h('div', { class: 'small muted', style: 'margin-top:4px' }, a.variables.every(isBuiltinVar)
        ? 'Todas são preenchidas automaticamente com os dados do destino da importação.'
        : 'As marcadas em cinza são automáticas; as demais você preenche no passo 2 da importação (o valor fica lembrado por planilha).')) : null);
}

function scriptRow(s) {
  const a = s.analysis;
  return h('div', { class: 'row' },
    h('div', { class: 'grow stack' },
      h('div', { class: 'inline' }, h('strong', null, s.name), scriptBadges(a), (a?.variables || []).map(varTag),
        !s.exists ? h('span', { class: 'pill overdue' }, 'arquivo não encontrado') : null,
        // Modo nuvem: cópia de trabalho editada no SSMS/VS Code ainda não enviada / versão mais nova na nuvem
        s.workingCopy?.changed ? h('span', { class: 'pill soon', title: 'A cópia aberta nesta máquina foi editada e ainda não foi enviada.' }, 'alterações locais não enviadas') : null,
        s.workingCopy?.stale ? h('span', { class: 'pill overdue', title: 'Outra pessoa salvou uma versão mais nova depois que você abriu a cópia.' }, 'há versão mais nova') : null),
      s.description ? h('span', { class: 'small muted' }, s.description) : null,
      h('span', { class: 'small muted mono' }, `${s.file}${s.exists ? ` · ${fmtSize(s.size)} · ${plural(a?.batches ?? 0, 'lote', 'lotes')} · alterado em ${fmtDateTime(s.mtimeMs ? new Date(s.mtimeMs).toISOString() : s.updatedAt)}` : ''}`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn sm primary', disabled: !s.exists, onclick: () => scriptForm(s) }, 'Editar'),
      h('button', { class: 'btn sm', disabled: !s.exists, title: 'Abrir no programa padrão para .sql (ex.: SSMS)', onclick: () => api('POST', `/api/scripts/${s.id}/open`).catch(fail) }, 'Abrir arquivo'),
      s.workingCopy?.changed ? h('button', { class: 'btn sm primary', title: 'Grava a cópia editada nesta máquina como nova versão do script (para todos).', onclick: async () => {
        try { await api('POST', `/api/scripts/${s.id}/push`); await loadScripts(); render(); toast('Alterações enviadas: nova versão do script salva.'); } catch (e) { fail(e); }
      } }, 'Enviar alterações') : null,
      h('button', { class: 'btn sm ghost', onclick: async () => {
        if (await confirmDialog({ title: 'Remover script', message: `Remover “${s.name}”? O arquivo é movido para a pasta “.removidos” dentro da pasta de scripts (não é apagado). Importações já configuradas deixam de executá-lo.`, okText: 'Remover', danger: true })) {
          try { await api('DELETE', `/api/scripts/${s.id}`); await loadScripts(); render(); toast('Script removido.'); } catch (e) { fail(e); }
        }
      } }, 'Remover')));
}

// Editor: nome, descrição e o texto do script, com análise ao vivo.
async function scriptForm(s) {
  await loadBuiltinVars();
  let content = '';
  if (s) {
    try { content = (await api('GET', `/api/scripts/${s.id}`)).content; } catch (e) { return fail(e); }
  }
  const name = h('input', { type: 'text', value: s?.name || '', maxlength: 120, placeholder: 'Ex.: Ajustar CPFs após importação' });
  const desc = h('input', { type: 'text', value: s?.description || '', maxlength: 400, placeholder: 'Opcional: o que este tratamento faz' });
  const text = h('textarea', { spellcheck: 'false', wrap: 'off', rows: 18, style: 'font-family:var(--mono);font-size:12.5px;white-space:pre;min-height:260px', placeholder: "-- Ex.:\nUPDATE dbo.CLIENTES SET CPF = REPLACE(REPLACE(CPF, '.', ''), '-', '')\nGO" });
  text.value = content;
  const out = h('div');
  let timer = 0, seq = 0;
  const analyze = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      if (!text.value.trim()) return out.replaceChildren();
      try { const a = await api('POST', '/api/scripts/analyze', { content: text.value }); if (mine === seq) out.replaceChildren(scriptFindings(a)); } catch { /* análise é só informativa */ }
    }, 350);
  };
  text.addEventListener('input', analyze);
  analyze();

  const md = openModal({
    title: s ? `Editar script — ${s.name}` : 'Novo script SQL', wide: true,
    body: [field('Nome', name), field('Descrição', desc),
      field('Script (T-SQL)', text, 'Use GO em linha própria para separar lotes (obrigatório antes de CREATE PROCEDURE/VIEW/FUNCTION). Ele roda na base escolhida na importação, dentro da mesma transação: se algo falhar, a importação inteira é desfeita.'),
      h('details', { class: 'small' }, h('summary', { style: 'cursor:pointer;color:var(--accent);font-weight:700' }, 'Variáveis: um mesmo script para todas as bases'),
        h('div', { class: 'stack', style: 'margin-top:6px' },
          h('div', null, 'Escreva ', h('code', null, '{{NOME}}'), ' onde o valor muda de uma base para outra. Antes de gerar o plano o app troca pelo valor, e a revisão mostra o texto já trocado. Ex.: ',
            h('code', null, "DECLARE @BancoDestino SYSNAME = '{{BANCO}}';")),
          h('div', null, 'Automáticas:'),
          h('ul', { style: 'margin:0;padding-left:20px' }, (builtinVars || []).map((v) => h('li', null, h('code', null, `{{${v.name}}}`), ` — ${v.description}`))),
          h('div', null, 'Qualquer outro nome (ex.: ', h('code', null, '{{ORIGEM_1}}'), ') vira um campo para preencher na importação. Valores aceitam só letras, números, espaço, _ . - (sem aspas nem ;), então sempre escreva a variável dentro de aspas ou colchetes quando for um nome: ',
            h('code', null, "'{{BANCO}}'"), ' ou ', h('code', null, '[{{BANCO}}]'), '.'))),
      out],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { name: name.value, description: desc.value, content: text.value };
        await (s ? api('PUT', `/api/scripts/${s.id}`, body) : api('POST', '/api/scripts', body));
        await loadScripts(); md.close(); render(); toast('Script salvo.');
      }) }, 'Salvar')],
  });
  (s ? text : name).focus();
}

async function importScriptFile() {
  try {
    const r = { path: await pickFileIn('sql', { title: 'Selecione o script .sql', filter: 'sql', starts: [(WM && WM.info && WM.info.root) || ''] }) };
    if (!r.path) return;
    const created = await api('POST', '/api/scripts/import-file', { filePath: r.path });
    await loadScripts(); render(); toast(`Script “${created.name}” importado.`);
  } catch (e) { fail(e); }
}

async function renderScripts(main) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Carregando…')));
  try { await Promise.all([loadScripts(), loadBuiltinVars()]); } catch (e) { return fail(e); }
  if (route().name !== 'scripts') return; // o usuário trocou de tela enquanto carregava
  main.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Scripts SQL'),
      h('div', { class: 'muted' }, 'Tratamentos de dados guardados como arquivos .sql na pasta do aplicativo. Na importação de uma planilha você escolhe quais rodam depois, na mesma base — sem retrabalho.')),
    h('div', { class: 'inline' },
      h('button', { class: 'btn', onclick: () => api('POST', '/api/scripts-folder/open').catch(fail) }, 'Abrir pasta'),
      h('button', { class: 'btn', onclick: importScriptFile }, 'Importar .sql…'),
      h('button', { class: 'btn primary', onclick: () => scriptForm() }, '+ Novo script'))),
    h('div', { class: 'box' }, h('strong', null, 'Como funciona a segurança'),
      h('ul', null,
        h('li', null, 'O app mostra, na revisão da importação, o texto completo de cada script que vai rodar, com a base de destino.'),
        h('li', null, 'Tudo roda numa única transação: se a importação ou qualquer script falhar, nada é gravado. “Simular” também executa os scripts e desfaz no final.'),
        h('li', null, 'São bloqueados: trocar de banco, transações próprias, backup/restore, xp_cmdshell, permissões/logins e acesso a outros servidores.'),
        h('li', null, 'DELETE, TRUNCATE e DROP são sinalizados e, em produção, só rodam se a base permitir sobrescrever/apagar dados.'),
        h('li', null, 'A análise é feita sobre o texto do script; em SQL dinâmico (EXEC/sp_executesql) o app procura comandos perigosos dentro dos textos, mas não confere tudo — leia com atenção.'),
        h('li', null, 'Variáveis {{NOME}} deixam o mesmo script servir a várias bases: {{BANCO}} vira o banco de destino da importação.'))),
    !scriptsCache.length ? h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('h2', null, 'Nenhum script cadastrado'),
      h('div', { class: 'muted' }, 'Cadastre aqui os scripts de tratamento que você costuma rodar depois de importar dados (ex.: limpar CPFs, preencher códigos, criar índices).'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => scriptForm() }, '+ Novo script'))))
      : card(plural(scriptsCache.length, 'script', 'scripts'), null, scriptsCache.map(scriptRow))));
}
