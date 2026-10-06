'use strict';
// Conexões de banco cadastradas (Configurações → Conexões) e o seletor usado nas bases dos projetos.
// Mesmo formulário de conexão das bases (connFields, em app.js); a senha é guardada com DPAPI pelo servidor e nunca volta para a tela.

const CONN_ENVS = [['prod', 'Produção'], ['hml', 'Homologação'], ['dev', 'Desenvolvimento'], ['local', 'Localhost (teste)']];
const connById = (id) => state.connections.find((c) => c.id === id) || null;
const connSummary = (c) => `${c.server}${c.port ? ',' + c.port : ''}${c.database ? ` / ${c.database}` : ''} · ${c.auth === 'sql' ? `login ${c.user}` : 'Windows'}`;
const envPill = (env) => pill(env === 'local' ? 'local' : env === 'prod' ? 'prod' : 'soon', (CONN_ENVS.find((e) => e[0] === env) || [env, env])[1].toUpperCase());

// Resultado do teste em linha (sem toast): ✓ Conexão realizada com sucesso / ✕ Falha na conexão + erro original.
// fixPassword (opcional): senha salva ilegível (PASSWORD_UNREADABLE) — botão que abre o formulário para informá-la de novo.
function testResultBox(r, fixPassword) {
  return r.ok
    ? h('div', { class: 'box ok-box small' }, h('strong', null, '✓ Conexão realizada com sucesso.'), ` ${r.server} / ${r.database} · ${r.login}`)
    : h('div', { class: 'box bad small' }, h('strong', null, '✕ Falha na conexão.'), h('div', { class: 'mono', style: 'margin-top:4px;white-space:pre-wrap' }, r.error),
      fixPassword ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm primary', onclick: fixPassword }, 'Informar a senha novamente')) : null);
}
// Abre o formulário da conexão cadastrada já com o foco na senha (usado quando a senha salva não pode ser lida).
function connectionPasswordFix(connectionId) {
  const c = state.connections.find((x) => x.id === connectionId);
  if (!c) return null;
  return () => { connectionForm(c); setTimeout(() => document.querySelector('.modal input[type=password]')?.focus(), 50); };
}

function connectionForm(c) {
  const name = h('input', { type: 'text', value: c?.name || '', maxlength: 80, placeholder: 'Ex.: Produção RM' });
  const env = h('select', null, CONN_ENVS.map(([v, l]) => h('option', { value: v, selected: (c?.env || 'prod') === v }, l)));
  const f = connFields(c ? { ...c } : { auth: 'sql' }, { local: false });
  f.database.placeholder = 'Opcional (cada base informa o seu)';
  const allow = h('input', { type: 'checkbox', checked: !!c?.allowDestructive });
  const allowRow = h('label', { class: 'check' }, allow, h('span', null, h('strong', null, 'Permitir apagar dados por esta conexão '), h('span', { class: 'hint' }, '(DELETE, DROP, TRUNCATE em scripts executados pelo checklist). Desligado por padrão fora do localhost; mesmo ligado, sempre pede confirmação.')));
  const syncEnv = () => { allowRow.style.display = env.value === 'local' ? 'none' : ''; };
  env.addEventListener('change', syncEnv); syncEnv();
  const notes = h('input', { type: 'text', value: c?.notes || '', maxlength: 300, placeholder: 'Opcional' });
  const result = h('div');
  const body = () => ({ id: c?.id, name: name.value, env: env.value, ...(f.get() || {}), allowDestructive: allow.checked, notes: notes.value });
  const md = openModal({ title: c ? 'Editar conexão' : 'Nova conexão', size: 'md',
    body: [h('div', { class: 'cols2' }, field('Nome', name), field('Ambiente', env, 'Localhost precisa apontar para esta máquina.')), ...f.els, allowRow, field('Observação', notes), result],
    footer: [
      h('button', { class: 'btn', title: 'Testa com os dados do formulário (antes de salvar)', onclick: (e) => busy(e.target, async () => {
        result.replaceChildren(h('div', { class: 'small muted' }, 'Testando conexão…'));
        try { result.replaceChildren(testResultBox(await api('POST', '/api/connections-test', body(), { timeoutMs: 45000 }))); } catch (er) { result.replaceChildren(testResultBox({ ok: false, error: er.message })); }
      }, 'Testando…') }, 'Testar conexão'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        await (c ? api('PUT', `/api/connections/${c.id}`, body()) : api('POST', '/api/connections', body()));
        await refresh(); md.close(); toast('Conexão salva.');
      }) }, 'Salvar')] });
  name.focus();
}

async function importConnectionsDialog() {
  let groups;
  try { groups = await api('GET', '/api/connections-import'); } catch (e) { return fail(e); }
  if (!groups.length) return toast('Nenhuma conexão repetida nas bases: todas já usam conexões cadastradas (ou não há bases).');
  const rows = groups.map((g) => ({ g, use: h('input', { type: 'checkbox', checked: g.bases.length > 1 }), name: h('input', { type: 'text', value: `${g.env === 'local' ? 'Localhost' : g.server}${g.user ? ` (${g.user})` : ''}`, maxlength: 80 }) }));
  const md = openModal({ title: 'Cadastrar conexões a partir das bases', size: 'lg',
    body: [h('div', { class: 'small muted' }, 'Bases com o mesmo servidor, porta, login e senha foram agrupadas. Cada grupo marcado vira uma conexão cadastrada e as bases passam a usá-la (cada uma mantém o seu banco). A senha é reaproveitada criptografada — nada é mostrado.'),
      h('div', { class: 'stack' }, rows.map(({ g, use, name }) => h('div', { class: 'row', style: 'align-items:flex-start' }, use,
        h('div', { class: 'grow stack' }, h('div', { class: 'inline' }, envPill(g.env), h('strong', { class: 'mono' }, `${g.server}${g.port ? ',' + g.port : ''}`), h('span', { class: 'small muted' }, g.auth === 'sql' ? `login ${g.user}` : 'Windows')),
          h('span', { class: 'small muted' }, `${plural(g.bases.length, 'base', 'bases')}: ${g.bases.map((b) => `${b.project} › ${b.base} (${b.database})`).join('; ')}`)),
        h('div', { style: 'width:240px' }, field('Nome da conexão', name)))))],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
      const chosen = rows.filter((r) => r.use.checked).map((r) => ({ key: r.g.key, name: r.name.value, link: true }));
      if (!chosen.length) throw new Error('Marque ao menos um grupo.');
      const r = await api('POST', '/api/connections-import', { groups: chosen });
      await refresh(); md.close(); toast(r.created.map((x) => `${x.name}: ${x.linked} base(s) vinculada(s)`).join(' · '));
    }) }, 'Cadastrar e vincular')] });
}

function connectionsCard() {
  const def = h('select', { style: 'width:auto;min-width:220px', onchange: async (e) => { try { await api('PUT', '/api/settings/default-connection', { id: e.target.value || null }); await refresh(); toast('Conexão padrão atualizada.'); } catch (er) { fail(er); } } },
    h('option', { value: '' }, '— Nenhuma —'), state.connections.map((c) => h('option', { value: c.id, selected: state.settings.defaultConnectionId === c.id }, c.name)));
  const usage = (id) => state.projects.reduce((n, p) => n + p.bases.filter((b) => b.prod?.connectionId === id || b.local?.connectionId === id).length, 0);
  return card('Conexões de banco', h('div', { class: 'inline' },
    h('button', { class: 'btn sm', title: 'Encontra conexões repetidas nas bases dos projetos e cadastra uma vez só', onclick: () => importConnectionsDialog() }, 'Importar das bases'),
    h('button', { class: 'btn sm primary', onclick: () => connectionForm(null) }, '+ Conexão')),
    h('div', { class: 'inline' }, h('span', { class: 'lbl' }, 'Conexão padrão'), def, h('span', { class: 'hint' }, 'Pré-selecionada ao executar scripts pelo checklist (cada projeto pode ter a sua, em “Editar” do projeto).')),
    state.connections.length ? state.connections.map((c) => {
      const res = h('div');
      const used = usage(c.id);
      return h('div', { class: 'row', style: 'align-items:flex-start' },
        h('div', { class: 'grow stack' },
          h('div', { class: 'inline' }, h('strong', null, c.name), envPill(c.env), state.settings.defaultConnectionId === c.id ? h('span', { class: 'pill done' }, 'padrão') : null,
            c.allowDestructive ? h('span', { class: 'pill soon', title: 'Scripts com DELETE/DROP/TRUNCATE podem rodar (com confirmação)' }, 'permite apagar') : null),
          h('span', { class: 'small mono' }, connSummary(c)),
          h('span', { class: 'small muted' }, [used ? `usada por ${plural(used, 'base', 'bases')}` : 'não usada por bases', c.notes].filter(Boolean).join(' · ')), res),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: (e) => busy(e.target, async () => {
            try { res.replaceChildren(testResultBox(await api('POST', `/api/connections/${c.id}/test`, {}, { timeoutMs: 45000 }))); }
            catch (er) { res.replaceChildren(testResultBox({ ok: false, error: er.message }, er.code === 'PASSWORD_UNREADABLE' ? connectionPasswordFix(c.id) : null)); }
          }, 'Testando…') }, 'Testar conexão'),
          h('button', { class: 'btn sm ghost', onclick: () => connectionForm(c) }, 'Editar'),
          h('button', { class: 'btn sm ghost', onclick: async () => {
            if (!(await confirmDialog({ title: 'Excluir conexão', message: `Excluir a conexão “${c.name}”? Só é possível se nenhuma base a usar.`, okText: 'Excluir', danger: true }))) return;
            try { await api('DELETE', `/api/connections/${c.id}`); await refresh(); } catch (e) { fail(e); }
          } }, 'Excluir')));
    }) : h('div', { class: 'ck-empty' }, h('strong', null, 'Nenhuma conexão cadastrada.'),
      h('span', { class: 'muted small' }, 'Cadastre as conexões que você usa sempre (ex.: Produção RM) e selecione-as nas bases e na execução de scripts, sem digitar servidor, login e senha de novo.'),
      state.projects.some((p) => p.bases.length) ? h('div', null, h('button', { class: 'btn sm', onclick: () => importConnectionsDialog() }, 'Importar das bases existentes')) : null));
}

// Seletor da conexão de uma base: conexão cadastrada (só escolhe o banco) OU dados informados à mão (como antes).
function connPicker(c, { local }) {
  const options = state.connections.filter((x) => (local ? x.env === 'local' : x.env !== 'local'));
  const manual = connFields(c && !c.connectionId ? c : local ? { server: 'localhost', auth: 'windows' } : null, { local });
  const sel = h('select', null, h('option', { value: '' }, 'Informar os dados manualmente'), options.map((x) => h('option', { value: x.id, selected: c?.connectionId === x.id }, `${x.name} — ${x.server}${x.port ? ',' + x.port : ''}`)));
  const db = h('input', { type: 'text', value: c?.connectionId ? c.database || '' : '', placeholder: 'Nome do banco desta base' });
  const refBox = h('div', { class: 'stack' }, field('Banco', db, 'Servidor, login e senha vêm da conexão cadastrada.'));
  const manualBox = h('div', { class: 'stack' }, manual.els);
  const sync = () => { const ref = !!sel.value; refBox.style.display = ref ? '' : 'none'; manualBox.style.display = ref ? 'none' : ''; if (ref && !db.value) db.value = connById(sel.value)?.database || manual.database.value || ''; };
  sel.addEventListener('change', sync); sync();
  let touched = false;
  [db, manual.database].forEach((el) => el.addEventListener('input', () => { touched = true; }));
  return {
    els: [options.length ? field('Conexão', sel) : h('div', { class: 'hint' }, 'Dica: cadastre as conexões que você usa sempre em Configurações → Conexões e escolha aqui, sem digitar tudo de novo.'), refBox, manualBox],
    getDb: () => (sel.value ? db.value : manual.database.value),
    setDb: (v) => { if (sel.value) db.value = v; else manual.database.value = v; },
    onDbInput: (fn) => [db, manual.database].forEach((el) => el.addEventListener('input', fn)),
    touched: () => touched,
    get: () => (sel.value ? { connectionId: sel.value, database: db.value } : manual.get()),
  };
}
