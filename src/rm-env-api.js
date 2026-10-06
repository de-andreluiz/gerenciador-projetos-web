// Rotas dos ambientes RM do projeto: salvar link/diretório, listar RM.exe encontrados e abrir um deles com -Multi=True.
const R = require('./rm-env');
const { httpError, str } = require('./util');

function mount(app, { store, audit, getProject, publicProject }) {
  const kindOf = (k) => { if (!R.KINDS[k]) throw httpError(404, 'Ambiente não encontrado.'); return k; };

  // Cada ambiente com o que a tela precisa: link, diretório, se existe e os RM.exe achados (só leitura).
  const view = (p) => Object.keys(R.KINDS).map((kind) => {
    const e = R.envOf(p, kind);
    const dirExists = R.isDir(e.dir);
    const exes = dirExists ? R.findRmExes(e.dir).map(({ abs, ...x }) => x) : [];
    return { kind, label: R.KINDS[kind], downloadUrl: e.downloadUrl, dir: e.dir, dirExists, exes };
  });

  app.get('/api/projects/:id/environments', (req, res) => {
    res.json({ environments: view(getProject(req.params.id)) });
  });

  app.put('/api/projects/:id/environments', async (req, res) => {
    const p = getProject(req.params.id);
    p.environments = R.cleanEnvironments(req.body, p.environments);
    await store.save();
    audit.log({ action: 'ambientes-atualizados', project: p.name, detalhe: Object.keys(R.KINDS).filter((k) => req.body?.[k] !== undefined).map((k) => R.KINDS[k]).join(', ') });
    res.json({ environments: view(p), project: publicProject(p) });
  });

  // Abre o RM.exe da pasta do ambiente. A tela manda só o nome listado; o servidor refaz a busca e exige que ele esteja nela.
  app.post('/api/projects/:id/environments/:kind/open', async (req, res) => {
    const p = getProject(req.params.id);
    const kind = kindOf(req.params.kind);
    const e = R.envOf(p, kind);
    if (!e.dir) throw httpError(400, `Defina o diretório do ambiente de ${R.KINDS[kind]} antes de abrir.`);
    if (!R.isDir(e.dir)) throw httpError(400, 'O diretório do ambiente não existe mais neste computador.');
    const rel = str(req.body?.rel, 500).toLowerCase();
    const found = R.findRmExes(e.dir).find((x) => x.rel.toLowerCase() === rel);
    if (!found) throw httpError(404, 'RM.exe não encontrado neste ambiente. Atualize a lista e tente de novo.');
    await R.launchRm(found.abs);
    audit.log({ action: 'rm-aberto', project: p.name, detalhe: `${R.KINDS[kind]}: ${found.rel} (-Multi=True)` });
    res.json({ ok: true });
  });
}

module.exports = { mount };
