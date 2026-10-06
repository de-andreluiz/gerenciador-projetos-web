// Senha salva ilegível (DPAPI de outro usuário/computador ou chave do Windows trocada): o app precisa dizer o que aconteceu e como
// corrigir — nunca mostrar o CLIXML do PowerShell — e não pode tentar nada no banco nem registrar uma "execução que falhou".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sec-'));
const PORT = 4406;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
// Blob com o cabeçalho DPAPI, mas que este usuário não consegue abrir (o Windows recusa com CryptographicException).
const BAD = `AQAAANCMnd8BFdERjHoAwE/Cl+sB${'A'.repeat(300)}`;
fs.mkdirSync(process.env.GP_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), JSON.stringify({
  version: 1, settings: { warnDays: 7 }, projects: [],
  connections: [{ id: 'cx', name: 'Conexão de teste', env: 'dev', server: '192.0.2.10', port: null, database: '', auth: 'sql', user: 'u', passwordEnc: BAD, encrypt: true, trustServerCertificate: true, allowDestructive: false }],
}));
const { app } = require('../server');
const { cleanPsError } = require('../src/powershell');
const { protect, unprotect } = require('../src/secrets');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('CLIXML do PowerShell vira texto legível (sem XML, sem progresso, sem a linha de código)', () => {
  const raw = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparando módulos para primeiro uso.</AV></PR></MS></Obj>'
    + '<S S="Error">Exceção ao chamar "Unprotect" com "3" argumento(s): "Chave inválida para uso no estado especificado._x000D__x000A_"_x000D__x000A_</S><S S="Error">No linha:7 caractere:1_x000D__x000A_</S><S S="Error">+ $out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null ..._x000D__x000A_</S><S S="Error">+ ~~~~~~_x000D__x000A_</S></Objs>';
  const msg = cleanPsError(raw);
  assert.match(msg, /Chave inválida para uso no estado especificado/);
  assert.doesNotMatch(msg, /CLIXML|<Obj|_x000D_|Preparando módulos|No linha|\+ \$out/);
  assert.equal(cleanPsError('erro simples'), 'erro simples', 'texto comum passa intacto');
});

test('DPAPI: ida e volta funciona; blob de outro usuário/corrompido vira PASSWORD_UNREADABLE (sem CLIXML)', async () => {
  assert.equal(await unprotect(await protect('s3nh@ ç')), 's3nh@ ç');
  await assert.rejects(unprotect(BAD), (e) => e.code === 'PASSWORD_UNREADABLE' && !/CLIXML/.test(e.message));
  await assert.rejects(unprotect('isto não é base64!!'), (e) => e.code === 'PASSWORD_UNREADABLE');
});

const unreadable = (r) => {
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, 'PASSWORD_UNREADABLE');
  assert.equal(r.json.connectionId, 'cx');
  assert.match(r.json.error, /Não foi possível ler a senha salva da conexão “Conexão de teste”/);
  assert.match(r.json.error, /Configurações → Conexões, edite “Conexão de teste”, informe a senha novamente e salve/);
  assert.match(r.json.error, /nada foi executado no banco/);
  assert.doesNotMatch(r.json.error, /CLIXML|<Objs|Unprotect|_x000D_/);
};

test('testar a conexão cadastrada e a base que a usa: mensagem clara com a correção', async () => {
  unreadable(await api('POST', '/api/connections/cx/test', {}));
  // formulário com a senha digitada de novo: passa da etapa da senha (aqui falha só por não haver servidor, nunca por DPAPI)
  const typed = await api('POST', '/api/connections-test', { id: 'cx', name: 'Conexão de teste', env: 'dev', server: '192.0.2.10', auth: 'sql', user: 'u', password: 'nova' });
  assert.notEqual(typed.json.code, 'PASSWORD_UNREADABLE');
  const p = (await api('POST', '/api/projects', { name: 'CLIENTE ALFA' })).json;
  const b = await api('POST', `/api/projects/${p.id}/bases`, { name: 'CLIENTE ALFA', directory: tmp, prod: { connectionId: 'cx', database: 'ZMIGRA_CLIENTEALFA' } });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  const bid = b.json.bases[0].id;
  unreadable(await api('POST', `/api/projects/${p.id}/bases/${bid}/test`, { env: 'prod' }));
  const log = (await api('GET', '/api/audit')).json.map((x) => x.action);
  assert.ok(log.includes('senha-ilegivel'));
});

test('executar script pelo checklist: recusa antes de conectar e não registra execução falha no item', async () => {
  const s = (await api('POST', '/api/scripts', { name: '400-ANALISE', content: 'SELECT 1 AS x;' })).json;
  const ck = (await api('POST', '/api/checklists', { name: 'Checklist Run' })).json;
  assert.equal((await api('PUT', '/api/cycles/cyc-padrao/steps/cy-1/checklists', { checklistIds: [ck.id] })).status, 200);
  await api('POST', `/api/checklists/${ck.id}/items`, { title: 'Registrar quantitativos', required: true, scriptIds: [s.id] });
  const p = (await api('POST', '/api/projects', { name: 'CLIENTE ALFA 2' })).json;
  const inst = (await api('POST', `/api/projects/${p.id}/checklists/cy-1/open`, {})).json.instance;
  const it = inst.items[0];
  const r = await api('POST', `/api/projects/${p.id}/checklists/cy-1/items/${it.id}/run`, { scriptId: s.id, target: 'conn:cx', database: 'ZMIGRA_CLIENTEALFA' });
  unreadable(r);
  const after = (await api('POST', `/api/projects/${p.id}/checklists/cy-1/open`, {})).json.instance.items[0];
  assert.deepEqual(after.runs, [], 'nada foi executado: o histórico de execuções do item continua vazio');
});
