// Conexões de banco cadastradas uma vez e reutilizadas (bases dos projetos, execução de scripts pelo checklist).
// Não é uma segunda camada de acesso ao banco: usa o MESMO formato de conexão das bases (buildConn/publicConn do server.js),
// a mesma senha criptografada com DPAPI do Windows (src/secrets.js) e o mesmo teste (src/db.js, em processo separado).
// Uma base pode apontar para uma conexão cadastrada ({ connectionId, database }): servidor, login e senha ficam num lugar só.
const crypto = require('crypto');
const { httpError, uid, str } = require('./util');

const ENVS = { prod: 'Produção', hml: 'Homologação', dev: 'Desenvolvimento', local: 'Localhost (teste)' };

function mount(app, { store, audit, db, buildConn, publicConn, connPassword }) {
  const data = () => store.data;
  const byId = (id) => data().connections.find((c) => c.id === id) || null;
  const orThrow = (id) => byId(id) || (() => { throw httpError(404, 'Conexão não encontrada.'); })();

  const publicSaved = (c) => ({ ...publicConn(c), id: c.id, name: c.name, env: c.env, envLabel: ENVS[c.env], allowDestructive: !!c.allowDestructive, notes: c.notes, createdAt: c.createdAt, updatedAt: c.updatedAt });

  // Bases que usam a conexão (para não excluir algo em uso e para mostrar onde ela aparece).
  function usedBy(id) {
    const out = [];
    for (const p of data().projects) for (const b of p.bases) for (const env of ['prod', 'local']) if (b[env]?.connectionId === id) out.push({ project: p.name, base: b.name, env });
    return out;
  }

  async function cleanSaved(b, existing) {
    const name = str(b.name, 80);
    if (!name) throw httpError(400, 'Informe o nome da conexão (ex.: Produção RM).');
    if (data().connections.some((c) => c.id !== existing?.id && c.name.trim().toLowerCase() === name.toLowerCase())) throw httpError(409, `Já existe uma conexão chamada “${name}”.`);
    const env = ENVS[b.env] ? b.env : 'prod';
    const conn = await buildConn({ ...b, database: b.database || 'master' }, existing, { local: env === 'local' });
    if (!conn) throw httpError(400, 'Informe o servidor.');
    if (!str(b.database, 128)) conn.database = ''; // banco padrão é opcional (cada base informa o seu)
    return { ...conn, name, env, allowDestructive: env !== 'local' && !!b.allowDestructive, notes: str(b.notes, 300) };
  }

  app.get('/api/connections', (req, res) => res.json(data().connections.map((c) => ({ ...publicSaved(c), usedBy: usedBy(c.id) }))));

  app.post('/api/connections', async (req, res) => {
    const now = new Date().toISOString();
    const c = { id: uid(), ...(await cleanSaved(req.body)), createdAt: now, updatedAt: now };
    data().connections.push(c);
    if (!data().settings.defaultConnectionId && c.env !== 'local') data().settings.defaultConnectionId = c.id;
    await store.save();
    audit.log({ action: 'conexao-cadastrada', detalhe: `${c.name} (${ENVS[c.env]})`, server: db.label(c), database: c.database || undefined });
    res.json(publicSaved(c));
  });

  app.put('/api/connections/:id', async (req, res) => {
    const c = orThrow(req.params.id);
    const next = await cleanSaved(req.body, c);
    if (next.env !== 'local' && usedBy(c.id).some((u) => u.env === 'local')) throw httpError(400, 'Esta conexão é usada como “Localhost (teste)” em alguma base, então precisa continuar apontando para esta máquina.');
    Object.assign(c, next, { updatedAt: new Date().toISOString() });
    await store.save();
    audit.log({ action: 'conexao-alterada', detalhe: `${c.name} (${ENVS[c.env]})`, server: db.label(c) });
    res.json(publicSaved(c));
  });

  app.delete('/api/connections/:id', async (req, res) => {
    const c = orThrow(req.params.id);
    const uses = usedBy(c.id);
    if (uses.length) throw httpError(409, `A conexão “${c.name}” é usada por ${uses.length} base(s): ${uses.slice(0, 4).map((u) => `${u.project} › ${u.base}`).join(', ')}${uses.length > 4 ? '…' : ''}. Troque a conexão dessas bases antes de excluir.`);
    data().connections = data().connections.filter((x) => x.id !== c.id);
    if (data().settings.defaultConnectionId === c.id) data().settings.defaultConnectionId = null;
    for (const p of data().projects) if (p.defaultConnectionId === c.id) p.defaultConnectionId = null;
    await store.save();
    audit.log({ action: 'conexao-excluida', detalhe: c.name });
    res.json({ ok: true });
  });

  app.put('/api/settings/default-connection', async (req, res) => {
    data().settings.defaultConnectionId = req.body.id ? orThrow(req.body.id).id : null;
    await store.save();
    res.json({ ok: true });
  });

  // Testa uma conexão cadastrada, ou o que está no formulário (antes de salvar). Senha em branco no formulário = usa a guardada.
  async function test(conn, label) {
    const result = await db.testConnection({ ...conn, database: conn.database || 'master' }, await connPassword(conn));
    audit.log({ action: 'conexao-testada', detalhe: label, server: db.label(conn), database: conn.database || 'master', ok: result.ok });
    return result;
  }
  app.post('/api/connections/:id/test', async (req, res) => {
    const c = orThrow(req.params.id);
    res.json(await test(c, c.name));
  });
  app.post('/api/connections-test', async (req, res) => {
    const existing = req.body.id ? orThrow(req.body.id) : null;
    const draft = await cleanSaved({ ...req.body, name: req.body.name || 'teste' }, existing);
    res.json(await test(draft, `${draft.name} (formulário)`));
  });

  // Conexões repetidas nas bases (mesmo servidor/porta/login): sugere cadastrar uma vez e vincular as bases.
  const keyOf = (c) => JSON.stringify([String(c.server).toLowerCase(), c.port || null, c.auth, String(c.user || '').toLowerCase(), c.encrypt !== false, c.trustServerCertificate !== false]);
  // A senha entra no agrupamento pelo hash (DPAPI gera um blob diferente a cada vez, então os blobs não podem ser comparados).
  // A senha é descriptografada só em memória, para comparar; nunca é devolvida nem regravada.
  async function importGroups() {
    const groups = new Map();
    const pw = new Map();
    for (const p of data().projects) for (const b of p.bases) for (const env of ['prod', 'local']) {
      const c = b[env];
      if (!c || c.connectionId) continue;
      let ph = '';
      if (c.auth === 'sql' && c.passwordEnc) {
        if (!pw.has(c.passwordEnc)) { try { pw.set(c.passwordEnc, crypto.createHash('sha256').update(await connPassword(c)).digest('hex')); } catch { pw.set(c.passwordEnc, `erro:${c.passwordEnc.slice(0, 16)}`); } }
        ph = pw.get(c.passwordEnc);
      }
      const k = `${env === 'local' ? 'local' : 'remote'}|${keyOf(c)}|${ph}`;
      if (!groups.has(k)) groups.set(k, { key: k, env: env === 'local' ? 'local' : 'prod', server: c.server, port: c.port, auth: c.auth, user: c.user, hasPassword: !!c.passwordEnc, bases: [] });
      groups.get(k).bases.push({ projectId: p.id, baseId: b.id, env, project: p.name, base: b.name, database: c.database });
    }
    return [...groups.values()].sort((a, b) => b.bases.length - a.bases.length);
  }
  app.get('/api/connections-import', async (req, res) => res.json((await importGroups()).map(({ key, env, server, port, auth, user, hasPassword, bases }) => ({ key: crypto.createHash('sha256').update(key).digest('hex').slice(0, 24), env, server, port, auth, user, hasPassword, bases }))));
  app.post('/api/connections-import', async (req, res) => {
    const wanted = Array.isArray(req.body.groups) ? req.body.groups : [];
    const groups = (await importGroups()).map((g) => ({ ...g, key: crypto.createHash('sha256').update(g.key).digest('hex').slice(0, 24) }));
    const created = [];
    for (const w of wanted) {
      const g = groups.find((x) => x.key === w.key);
      if (!g) throw httpError(409, 'As bases mudaram desde a análise; abra a importação de novo.');
      const name = str(w.name, 80) || `${g.server}${g.user ? ` (${g.user})` : ''}`;
      if (data().connections.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) throw httpError(409, `Já existe uma conexão chamada “${name}”.`);
      const first = g.bases[0];
      const src = data().projects.find((p) => p.id === first.projectId).bases.find((b) => b.id === first.baseId)[first.env];
      const now = new Date().toISOString();
      // mesma senha criptografada (DPAPI) da base de origem: nada é descriptografado nem regravado
      const c = { id: uid(), name, env: g.env, server: src.server, port: src.port, database: '', auth: src.auth, user: src.user, encrypt: src.encrypt, trustServerCertificate: src.trustServerCertificate,
        passwordEnc: src.passwordEnc || null, allowDestructive: false, notes: 'Criada a partir das bases dos projetos', createdAt: now, updatedAt: now };
      data().connections.push(c);
      let linked = 0;
      if (w.link !== false) {
        for (const ref of g.bases) {
          const base = data().projects.find((p) => p.id === ref.projectId).bases.find((b) => b.id === ref.baseId);
          base[ref.env] = { connectionId: c.id, database: base[ref.env].database }; // mesmo servidor, login e senha (agrupados acima)
          linked++;
        }
      }
      created.push({ id: c.id, name, linked, total: g.bases.length });
    }
    if (!data().settings.defaultConnectionId) data().settings.defaultConnectionId = created.find((x) => byId(x.id).env !== 'local')?.id || null;
    await store.save();
    for (const c of created) audit.log({ action: 'conexao-cadastrada', detalhe: `${c.name}: ${c.linked}/${c.total} base(s) vinculada(s)` });
    res.json({ created });
  });

  return { publicSaved, byId, ENVS };
}

module.exports = { mount, ENVS };
