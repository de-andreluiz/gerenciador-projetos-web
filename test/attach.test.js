const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-attach-'));
const PORT = 4392;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

test('anexar a planilha DE-PARA baixada pelo navegador', async () => {
  {
    const dest = path.join(tmp, 'destino'); fs.mkdirSync(dest);
    const src = path.join(tmp, 'Baixado do Sheets.xlsx');
    fs.writeFileSync(src, Buffer.concat([Buffer.from('PK'), Buffer.alloc(50, 7)]));
    const p = (await api('POST', '/api/projects', { name: 'P' })).json;
    const withD = (await api('POST', `/api/projects/${p.id}/deparas`, { label: 'DEPARA X', url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit', targetDir: dest })).json;
    const did = withD.deparas[0].id;
    const url = `/api/projects/${p.id}/deparas/${did}/attach`;

    const ok = await api('POST', url, { filePath: src });
    assert.equal(ok.status, 200);
    assert.equal(path.basename(ok.json.path), 'DEPARA X.xlsx');
    assert.ok(fs.existsSync(src), 'o original não pode ser removido');
    assert.equal(ok.json.project.deparas[0].fileExists, true);

    const again = await api('POST', url, { filePath: src });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'EXISTS');
    assert.equal((await api('POST', url, { filePath: src, overwrite: true })).status, 200);

    const fake = path.join(tmp, 'falso.xlsx'); fs.writeFileSync(fake, 'isto nao e um zip');
    assert.equal((await api('POST', url, { filePath: fake })).status, 400);
    assert.equal((await api('POST', url, { filePath: path.join(tmp, 'naoexiste.xlsx') })).status, 400);
    assert.equal((await api('POST', url, { filePath: path.join(tmp, 'x.txt') })).status, 400);

    const recent = await api('GET', '/api/downloads/recent');
    assert.equal(recent.status, 200);
    assert.ok(Array.isArray(recent.json.files));
  }
});

test('pasta inicial do seletor: primeira candidata que existe; pasta de arquivo; nunca erro por pasta removida', async () => {
  {
    const dep = path.join(tmp, 'DEPARA'); fs.mkdirSync(dep, { recursive: true });
    const f = path.join(dep, 'x.xlsx'); fs.writeFileSync(f, 'PK');
    const dir = async (starts) => (await api('POST', '/api/dialog/initial-dir', { starts })).json.dir;
    assert.equal(await dir([dep]), dep);
    assert.equal(await dir([path.join(tmp, 'removida'), dep]), dep, 'pula a pasta que não existe');
    assert.equal(await dir([f]), dep, 'arquivo vale pela pasta dele');
    assert.equal(await dir(['..\relativo', path.join(tmp, 'nada')]), path.join(os.homedir(), 'Documents'), 'fallback: Documentos');
  }
});
