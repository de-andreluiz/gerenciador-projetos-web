// Ambientes RM do projeto (Homologação / Produção): link de download, diretório local e os RM.exe encontrados nele.
// O app só LISTA e ABRE o RM.exe (sempre com -Multi=True); nunca altera, copia, move ou apaga arquivos do ambiente.
// Quem encontra e valida o RM.exe é o servidor (src/rm-env.js); a tela só manda o caminho relativo que ele mesmo listou.
// Abre direto o RM.exe da pasta do ambiente (-Multi=True), sem janela de confirmação. Usado pelo card e pela barra do cabeçalho.
const rmOpen = (p, env, exe, btn) => busy(btn, async () => {
  await api('POST', `/api/projects/${p.id}/environments/${env.kind}/open`, { rel: exe.rel });
  toast(`RM aberto (${env.label}).`, 'ok');
}, 'Abrindo…');

// Acesso rápido no cabeçalho do projeto: um botão por ambiente que tem RM.exe na pasta informada; clique = abre.
// Sem nenhum ambiente configurado, mostra um atalho para o card “Ambientes RM”.
function rmQuickLaunch(p) {
  const box = h('div', { class: 'inline rm-quick', 'data-rm-bar': p.id });
  const draw = (envs) => {
    const ready = envs.filter((e) => e.dirExists && e.exes.length);
    const configured = envs.some((e) => e.dir || e.downloadUrl);
    box.replaceChildren(...ready.map((env) => h('button', { class: `btn sm rm-go${env.kind === 'prod' ? ' rm-prod' : ' primary'}`, title: `Abre o RM.exe de ${env.label} com -Multi=True`,
      onclick: (e) => rmOpen(p, env, env.exes[0], e.currentTarget) }, icon('play', 12), `Abrir ${env.label}`)),
    ...(ready.length ? [] : [h('button', { class: 'btn sm ghost', title: configured ? 'Nenhum RM.exe encontrado na pasta informada' : 'Cadastrar link e diretório dos ambientes', onclick: () => document.querySelector('[data-sec="ambientes"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, configured ? 'Ambientes RM: nenhum RM.exe' : '+ Ambientes RM')]));
  };
  const load = () => api('GET', `/api/projects/${p.id}/environments`).then((r) => draw(r.environments)).catch(() => box.replaceChildren());
  box.rmRefresh = load; // o card chama depois de salvar
  load();
  return box;
}

function rmEnvCard(p) {
  const body = h('div', { class: 'stack', style: 'gap:16px' }, h('div', { class: 'empty' }, 'Carregando…'));
  const head = h('div', { class: 'inline' });
  let envs = [];

  const openRm = (env, exe, btn) => rmOpen(p, env, exe, btn);

  const envBlock = (env) => {
    const exeRows = env.exes.map((x) => h('div', { class: 'rm-exe' },
      h('span', { class: 'mono', title: x.rel }, x.rel), h('span', { class: 'small muted grow' }, `${fmtSize(x.size)} · ${fmtDateTime(x.mtime)}`),
      h('button', { class: `btn xs ${env.kind === 'prod' ? 'rm-prod' : 'primary'}`, title: 'Abre o RM.exe com -Multi=True', onclick: (e) => openRm(env, x, e.currentTarget) }, 'Abrir (Multi)')));
    return h('div', { class: 'stack rm-env' },
      h('div', { class: 'inline' }, h('span', { class: `pill ${env.kind === 'prod' ? 'overdue' : 'soon'}` }, env.label),
        env.downloadUrl ? h('a', { class: 'btn xs', href: env.downloadUrl, target: '_blank', rel: 'noopener noreferrer', title: env.downloadUrl }, 'Baixar ambiente') : h('span', { class: 'small muted' }, 'sem link de download'),
        env.dir && env.dirExists ? h('button', { class: 'btn xs ghost', onclick: () => openFolder(env.dir) }, 'Abrir pasta') : null),
      env.dir ? dirLine(env.dir, env.dirExists) : h('span', { class: 'small muted' }, 'Nenhum diretório local definido.'),
      env.dir && env.dirExists
        ? (exeRows.length ? h('div', { class: 'stack', style: 'gap:4px' }, exeRows) : h('span', { class: 'small muted' }, 'Nenhum RM.exe nesta pasta (a busca não entra em subpastas — informe a pasta que contém o RM.exe).'))
        : null);
  };

  const draw = (list) => {
    envs = list;
    const empty = list.every((e) => !e.downloadUrl && !e.dir);
    head.replaceChildren(h('button', { class: 'btn xs ghost', title: 'Procurar os RM.exe de novo', onclick: () => { load(); document.querySelector('[data-rm-bar]')?.rmRefresh?.(); } }, '⟳'),
      h('button', { class: 'btn sm', onclick: () => rmEnvForm(p, envs, (r) => { replaceProjectQuiet(r.project); draw(r.environments); document.querySelector('[data-rm-bar]')?.rmRefresh?.(); }) }, 'Editar ambientes'));
    body.replaceChildren(...(empty ? [h('div', { class: 'empty' }, 'Nenhum ambiente cadastrado. Use “Editar ambientes” para informar o link de download e o diretório local de Homologação e Produção.')] : list.map(envBlock)),
      h('div', { class: 'small muted' }, 'O app só abre o RM.exe encontrado; não copia, move, altera nem apaga arquivos do ambiente.'));
  };
  const load = () => api('GET', `/api/projects/${p.id}/environments`).then((r) => draw(r.environments)).catch((e) => body.replaceChildren(h('div', { class: 'box bad' }, e.message)));
  load();
  return card('Ambientes RM', head, body);
}

function rmEnvForm(p, envs, onSaved) {
  const rows = envs.map((e) => ({ kind: e.kind, label: e.label,
    url: h('input', { type: 'text', value: e.downloadUrl || '', placeholder: 'https://…', maxlength: 600 }),
    dir: pathField({ value: e.dir || '', title: `Diretório do ambiente de ${e.label}`, placeholder: e.kind === 'prod' ? 'C:\\RM\\PRD\\CLIENTE' : 'C:\\RM\\HMG\\CLIENTE' }) }));
  const m = openModal({ title: 'Ambientes RM', size: 'md',
    body: [h('div', { class: 'small muted' }, 'Informe o link para baixar cada ambiente e/ou a pasta onde ele está neste computador. O app procura o RM.exe somente na pasta informada (sem entrar em subpastas) e abre com -Multi=True — nada é alterado.'),
      ...rows.map((r) => h('fieldset', { class: 'rm-fs' }, h('legend', null, r.label), field('Link de download', r.url), field('Diretório local', r.dir.el, 'A pasta que contém o RM.exe (ex.: C:\\RM\\HMG\\CLIENTE).')))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (ev) => busy(ev.target, async () => {
        const payload = Object.fromEntries(rows.map((r) => [r.kind, { downloadUrl: r.url.value, dir: r.dir.get() }]));
        const saved = await api('PUT', `/api/projects/${p.id}/environments`, payload);
        m.close(); onSaved(saved); toast('Ambientes salvos.', 'ok');
      }) }, 'Salvar')] });
}
