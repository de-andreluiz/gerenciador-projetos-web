const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-conn-'));
const PORT = 4401;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

test('conexões cadastradas: CRUD, senha nunca exposta, bases referenciam e importação das bases repetidas', async () => {
  {
    assert.equal((await api('POST', '/api/connections', { name: '', server: 'X' })).status, 400);
    assert.equal((await api('POST', '/api/connections', { name: 'Local', env: 'local', server: '10.0.0.5', database: 'x' })).status, 400, 'local precisa ser esta máquina');
    const prod = await api('POST', '/api/connections', { name: 'Produção RM', env: 'prod', server: 'SERVIDOR01', port: 1433, database: 'RM', auth: 'sql', user: 'usuario', password: 'segredo-123' });
    assert.equal(prod.status, 200, JSON.stringify(prod.json));
    assert.equal(prod.json.hasPassword, true);
    assert.equal(prod.json.passwordEnc, undefined);
    assert.ok(!JSON.stringify((await api('GET', '/api/state')).json).includes('segredo-123'));
    const raw = fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), 'utf8');
    assert.ok(!raw.includes('segredo-123'), 'senha nunca em texto puro');
    assert.ok(/"passwordEnc": "[A-Za-z0-9+/=]{40,}"/.test(raw), 'guardada com DPAPI');
    assert.equal((await api('POST', '/api/connections', { name: 'produção rm', server: 'Y' })).status, 409);
    assert.equal((await api('GET', '/api/state')).json.settings.defaultConnectionId, prod.json.id, 'primeira conexão vira a padrão');
    // editar sem senha mantém a senha
    const ed = await api('PUT', `/api/connections/${prod.json.id}`, { name: 'Produção RM', env: 'prod', server: 'SERVIDOR01', database: 'RM', auth: 'sql', user: 'usuario' });
    assert.equal(ed.json.hasPassword, true);

    // base usando a conexão cadastrada: guarda só a referência + banco
    const p = (await api('POST', '/api/projects', { name: 'Cliente A', defaultConnectionId: prod.json.id })).json;
    assert.equal(p.defaultConnectionId, prod.json.id);
    assert.equal((await api('POST', `/api/projects/${p.id}/bases`, { name: 'B', prod: { connectionId: 'nada', database: 'X' } })).status, 400);
    assert.equal((await api('POST', `/api/projects/${p.id}/bases`, { name: 'B', local: { connectionId: prod.json.id, database: 'X' } })).status, 400, 'conexão remota não pode ser Localhost');
    const withBase = (await api('POST', `/api/projects/${p.id}/bases`, { name: 'Base Cliente A', prod: { connectionId: prod.json.id, database: 'CLIENTE_A' } })).json;
    const b = withBase.bases[0];
    assert.equal(b.prod.connectionId, prod.json.id);
    assert.equal(b.prod.server, 'SERVIDOR01', 'a tela recebe os dados resolvidos');
    assert.equal(b.prod.database, 'CLIENTE_A');
    assert.equal(b.prod.passwordEnc, undefined);
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), 'utf8')).projects[0].bases[0].prod;
    assert.deepEqual(stored, { connectionId: prod.json.id, database: 'CLIENTE_A' });
    assert.equal((await api('DELETE', `/api/connections/${prod.json.id}`)).status, 409, 'em uso por uma base');

    // importar: 3 bases com o mesmo servidor/login/senha (blobs DPAPI diferentes) viram 1 conexão; senha diferente fica em outro grupo
    const mk = (name, pwd, dbn) => api('POST', `/api/projects/${p.id}/bases`, { name, prod: { server: '192.0.2.91', database: dbn, auth: 'sql', user: 'sa', password: pwd } });
    await mk('X1', 'mesma', 'DB1'); await mk('X2', 'mesma', 'DB2'); await mk('X3', 'mesma', 'DB3'); await mk('X4', 'outra', 'DB4');
    const groups = (await api('GET', '/api/connections-import')).json;
    assert.deepEqual(groups.map((g) => g.bases.length), [3, 1]);
    assert.ok(!JSON.stringify(groups).includes('mesma'));
    const imp = (await api('POST', '/api/connections-import', { groups: [{ key: groups[0].key, name: 'Produção 2.91' }] })).json;
    assert.deepEqual(imp.created.map((c) => [c.name, c.linked, c.total]), [['Produção 2.91', 3, 3]]);
    const after = (await api('GET', '/api/state')).json.projects.find((x) => x.id === p.id).bases;
    assert.deepEqual(after.filter((x) => x.prod.connectionId === imp.created[0].id).map((x) => x.prod.database), ['DB1', 'DB2', 'DB3'], 'cada base mantém o seu banco');
    assert.equal((await api('GET', '/api/connections-import')).json.length, 1, 'só sobra o grupo com outra senha');
  }
});

test('executar script pelo checklist: travas, variáveis, confirmação, histórico e nunca conclui o item', async () => {
  {
    const mkScript = async (name, content) => (await api('POST', '/api/scripts', { name, content })).json;
    const sel = await mkScript('VALIDA_SELECT', 'SELECT COUNT(*) AS total FROM {{TABELA}};');
    const upd = await mkScript('AJUSTE_UPDATE', "UPDATE dbo.X SET A = 1 WHERE B = 2;");
    const del = await mkScript('LIMPA_DELETE', 'DELETE FROM dbo.X WHERE B = 2;');
    const bad = await mkScript('PROIBIDO', 'BACKUP DATABASE X TO DISK = \'c:\\x.bak\';');
    const other = await mkScript('OUTRO', 'SELECT 1;');
    // conexões: produção (remota) e "localhost" numa porta fechada, para a execução falhar rápido sem precisar de SQL Server
    const prod = (await api('POST', '/api/connections', { name: 'Prod', env: 'prod', server: 'SERVIDOR01', database: 'RM', auth: 'sql', user: 'u', password: 'p' })).json;
    const loc = (await api('POST', '/api/connections', { name: 'Local fechado', env: 'local', server: '127.0.0.1', port: 1, database: 'master', auth: 'sql', user: 'u', password: 'p' })).json;
    // checklist reutilizável associado ao 1º passo do ciclo padrão (antes de criar o projeto, que recebe a cópia dos passos)
    const ck = (await api('POST', '/api/checklists', { name: 'Checklist Run' })).json;
    assert.equal((await api('PUT', '/api/cycles/cyc-padrao/steps/cy-1/checklists', { checklistIds: [ck.id] })).status, 200);
    await api('POST', `/api/checklists/${ck.id}/items`, { title: 'Validar PFUNC', required: true, scriptIds: [sel.id, upd.id, del.id, bad.id] });
    const p = (await api('POST', '/api/projects', { name: 'Proj Run' })).json;
    const moved = (await api('PUT', `/api/projects/${p.id}/step`, { stepId: p.steps[0].id })).json;
    assert.equal(moved.stepId, p.steps[0].id);
    const inst = (await api('POST', `/api/projects/${p.id}/checklists/${p.steps[0].id}/open`, {})).json.instance;
    const it = inst.items.find((i) => i.title === 'Validar PFUNC');
    const url = `/api/projects/${p.id}/checklists/${p.steps[0].id}/items/${it.id}/run`;
    const run = (o) => api('POST', url, o);

    const targets = (await api('GET', `/api/projects/${p.id}/run-targets`)).json;
    assert.ok(targets.targets.some((t) => t.key === `conn:${prod.id}`));
    assert.equal((await run({ scriptId: other.id, target: `conn:${loc.id}` })).status, 400, 'script não relacionado ao item');
    assert.equal((await run({ scriptId: sel.id, target: 'conn:nada' })).status, 400);
    const blocked = await run({ scriptId: bad.id, target: `conn:${loc.id}` });
    assert.equal(blocked.status, 400); assert.equal(blocked.json.code, 'SCRIPT_BLOCKED');
    const vars = await run({ scriptId: sel.id, target: `conn:${loc.id}` });
    assert.equal(vars.json.code, 'SCRIPT_VARS'); assert.deepEqual(vars.json.missing, ['TABELA']);
    assert.equal((await run({ scriptId: sel.id, target: `conn:${loc.id}`, vars: { TABELA: "X'; DROP" } })).status, 400, 'valor perigoso de variável');
    // DELETE em produção sem permissão: bloqueado (mesma regra da importação)
    const d = await run({ scriptId: del.id, target: `conn:${prod.id}` });
    assert.equal(d.status, 403); assert.equal(d.json.code, 'SCRIPT_DESTRUCTIVE');
    // UPDATE em produção: pede confirmação com token; token de outro texto/alvo não vale
    const c = await run({ scriptId: upd.id, target: `conn:${prod.id}` });
    assert.equal(c.status, 409); assert.equal(c.json.code, 'SCRIPT_CONFIRM');
    assert.match(c.json.confirm.reasons[0], /UPDATE/);
    assert.equal((await run({ scriptId: upd.id, target: `conn:${prod.id}`, confirmToken: 'x' })).status, 409);
    // DELETE no localhost: permitido, mas com confirmação
    assert.equal((await run({ scriptId: del.id, target: `conn:${loc.id}` })).json.code, 'SCRIPT_CONFIRM');
    // SELECT no localhost: executa sem confirmação (aqui falha rápido: porta fechada) e fica no histórico, sem concluir o item
    const r = await run({ scriptId: sel.id, target: `conn:${loc.id}`, vars: { TABELA: 'dbo.PFUNC' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, false);
    assert.ok(r.json.error);
    const after = (await api('POST', `/api/projects/${p.id}/checklists/${p.steps[0].id}/open`, {})).json.instance.items.find((i) => i.id === it.id);
    assert.equal(after.done, false, 'executar não conclui o item');
    assert.equal(after.runs.length, 1);
    assert.deepEqual([after.runs[0].scriptName, after.runs[0].target, after.runs[0].ok], ['VALIDA_SELECT', 'Local fechado', false]);
    const log = (await api('GET', '/api/audit')).json;
    const entry = log.find((x) => x.action === 'script-falhou');
    assert.ok(entry && entry.sha256 && !JSON.stringify(entry).includes('SELECT COUNT'), 'auditoria sem o texto do script');
  }
});
