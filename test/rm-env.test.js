// Grupo do WhatsApp do projeto + ambientes RM (link de download, diretório local, RM.exe com -Multi=True).
// Nada aqui toca em C:\RM nem inicia programa de verdade: a árvore é falsa (pasta temporária, RM.exe vazios) e o lançador é simulado.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rm-'));
const PORT = 4455;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

const { app } = require('../server');
const R = require('../src/rm-env');
const { waGroupUrl } = require('../src/contacts');

// Lançador simulado: registra o que SERIA iniciado.
const launches = [];
let spawnMode = 'ok';
R.setSpawn((exe, args, opts) => {
  const child = new EventEmitter(); child.unref = () => {};
  launches.push({ exe, args, opts });
  process.nextTick(() => (spawnMode === 'ok' ? child.emit('spawn') : child.emit('error', new Error('spawn UNKNOWN'))));
  return child;
});

const S = {};
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { R.setSpawn(null); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };

// Árvore falsa no estilo C:\RM\HMG\CLIENTE\RM.exe
const touch = (...parts) => { const f = path.join(tmp, 'rm', ...parts); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'conteudo-intocavel'); return f; };
const HMG = path.join(tmp, 'rm', 'HMG'); // pasta "pai": só tem subpastas de clientes, nenhum RM.exe direto
const BOA = path.join(HMG, 'CLIENTE ALFA'); // ambiente de Homologação informado pelo usuário
const BETA = path.join(HMG, 'CLIENTE BETA');
const SEM = path.join(HMG, 'SEM EXE');
const GEN = path.join(tmp, 'rm', 'PRD', 'CLIENTEGAMA'); // ambiente de Produção informado pelo usuário
touch('HMG', 'CLIENTE ALFA', 'RM.exe');
touch('HMG', 'CLIENTE ALFA', 'RM.Atualizador.exe'); // parecido, mas não é RM.exe
touch('HMG', 'CLIENTE ALFA', 'Biblioteca.dll');
touch('HMG', 'CLIENTE ALFA', 'UPDATE_LastVersion', 'RM.exe'); // em subpasta: NÃO deve ser considerado
touch('HMG', 'CLIENTE BETA', 'rm.EXE'); // maiúsculas/minúsculas diferentes
touch('HMG', 'CLIENTE BETA', 'UPDATE_LastVersion', 'RM.exe');
fs.mkdirSync(path.join(SEM, 'RM.exe'), { recursive: true }); // pasta chamada RM.exe: não é arquivo
touch('PRD', 'CLIENTEGAMA', 'RM.exe');
touch('PRD', 'CLIENTEGAMA', 'UPDATE_LastVersion', 'RM.exe');
const snapshot = (dir) => { const out = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out.push(`D ${p}`); w(p); } else { const s = fs.statSync(p); out.push(`F ${p} ${s.size} ${s.mtimeMs}`); } } })(dir); return out.sort(); };

test('grupo do WhatsApp: só convite chat.whatsapp.com, normalizado; vazio remove', async () => {
  assert.equal(waGroupUrl('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv'), 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(waGroupUrl(' chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv?mode=r_c#x '), 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv'); // sem https e com parâmetros
  for (const bad of ['', 'https://wa.me/5511912345678', 'https://evil.com/chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv', 'https://chat.whatsapp.com.evil.com/AbCdEfGhIjKlMnOpQrStUv', 'javascript:alert(1)', 'https://chat.whatsapp.com/curto', 'https://chat.whatsapp.com/<script>alert(1)</script>']) assert.equal(waGroupUrl(bad), null, bad);

  const link = 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv';
  const p = ok(await api('POST', '/api/projects', { name: 'Cliente Alfa', rootDirKind: 'local', rootDir: '', whatsappGroupUrl: `${link}?mode=r_c` }));
  assert.equal(p.whatsappGroupUrl, link);
  assert.equal((await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Alfa', rootDirKind: 'local', rootDir: '', whatsappGroupUrl: 'https://wa.me/55119' })).status, 400);
  assert.equal(ok(await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Alfa 2', rootDirKind: 'local', rootDir: '' })).whatsappGroupUrl, link); // quem não envia o campo não apaga o link
  assert.equal(ok(await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Alfa 2', rootDirKind: 'local', rootDir: '', whatsappGroupUrl: '' })).whatsappGroupUrl, ''); // vazio = sem grupo
  const legacy = ok(await api('POST', '/api/projects', { name: 'Sem grupo', rootDirKind: 'local', rootDir: '' }));
  assert.equal(legacy.whatsappGroupUrl, ''); // projeto sem o campo continua válido
});

test('ambientes: salvar link e diretório (validação); projeto antigo sem o campo vem vazio', async () => {
  const p = ok(await api('POST', '/api/projects', { name: 'Ambientes', rootDirKind: 'local', rootDir: '' }));
  S.p = p;
  const first = ok(await api('GET', `/api/projects/${p.id}/environments`)).environments;
  assert.deepEqual(first.map((e) => [e.kind, e.label, e.downloadUrl, e.dir, e.dirExists, e.exes.length]), [['hml', 'Homologação', '', '', false, 0], ['prod', 'Produção', '', '', false, 0]]);
  for (const bad of [{ hml: { dir: 'relativo\\pasta' } }, { hml: { dir: 'C:\\' } }, { hml: { downloadUrl: 'javascript:alert(1)' } }, { prod: { downloadUrl: 'ftp://x.com/a' } }, { prod: { downloadUrl: 'não é url' } }]) {
    assert.equal((await api('PUT', `/api/projects/${p.id}/environments`, bad)).status, 400, JSON.stringify(bad));
  }
  const saved = ok(await api('PUT', `/api/projects/${p.id}/environments`, { hml: { downloadUrl: 'https://exemplo.com/hmg.zip', dir: `${BOA}\\` } }));
  assert.equal(saved.environments[0].downloadUrl, 'https://exemplo.com/hmg.zip');
  assert.equal(saved.environments[0].dir, BOA); // barra final removida
  assert.equal(saved.project.environments.hml.dir, BOA);
  assert.equal(saved.environments[1].dir, ''); // prod não enviado: continua vazio
  ok(await api('PUT', `/api/projects/${p.id}/environments`, { prod: { downloadUrl: 'http://exemplo.com/prd.zip', dir: GEN } }));
  const after = ok(await api('GET', `/api/projects/${p.id}/environments`)).environments;
  assert.equal(after[0].downloadUrl, 'https://exemplo.com/hmg.zip'); // enviar só prod não apaga hml
  assert.equal(after[1].dir, GEN);
});

test('busca: SOMENTE na pasta informada (nunca em subpastas), qualquer caixa, ignora parecidos e pasta chamada RM.exe; só leitura', async () => {
  const before = snapshot(path.join(tmp, 'rm'));
  const [hml, prod] = ok(await api('GET', `/api/projects/${S.p.id}/environments`)).environments;
  assert.equal(hml.dirExists, true);
  assert.deepEqual(hml.exes.map((e) => e.rel), ['RM.exe']); // o UPDATE_LastVersion\RM.exe da subpasta não aparece
  assert.deepEqual(prod.exes.map((e) => e.rel), ['RM.exe']);
  assert.ok(hml.exes.every((e) => !('abs' in e) && e.size > 0)); // a tela nunca recebe o caminho do disco
  assert.deepEqual(R.findRmExes(BETA).map((e) => e.rel), ['rm.EXE']); // maiúsculas/minúsculas diferentes
  assert.deepEqual(R.findRmExes(HMG), []); // pasta "pai" com RM.exe só nas subpastas: nada é procurado lá dentro
  assert.deepEqual(R.findRmExes(SEM), []); // pasta chamada RM.exe não é arquivo
  assert.deepEqual(R.findRmExes(path.join(tmp, 'não existe')), []);
  // link (junção) chamado RM.exe apontando para fora: não vale
  const outside = path.join(tmp, 'fora'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'RM.exe'), 'x');
  const linkDir = path.join(tmp, 'rm', 'LINK'); fs.mkdirSync(linkDir);
  let junction = false; try { fs.symlinkSync(outside, path.join(linkDir, 'RM.exe'), 'junction'); junction = true; } catch { /* sem permissão: ignora */ }
  if (junction) assert.deepEqual(R.findRmExes(linkDir), []);
  fs.rmSync(linkDir, { recursive: true, force: true });
  assert.deepEqual(snapshot(path.join(tmp, 'rm')), before); // nada criado, alterado, movido ou apagado
});

test('abrir: direto (sem confirmação), só o RM.exe da pasta informada, -Multi=True fixo, sem shell; o resto é recusado', async () => {
  const before = snapshot(path.join(tmp, 'rm'));
  ok(await api('POST', `/api/projects/${S.p.id}/environments/hml/open`, { rel: 'RM.exe' })); // uma chamada só: o servidor não pede confirmação
  assert.equal(launches.length, 1);
  const l = launches[0];
  assert.equal(l.exe, path.join(BOA, 'RM.exe'));
  assert.deepEqual(l.args, ['-Multi=True']);
  assert.equal(l.opts.cwd, BOA);
  assert.equal(l.opts.detached, true); assert.equal(l.opts.stdio, 'ignore'); assert.notEqual(l.opts.shell, true);
  assert.equal('ELECTRON_RUN_AS_NODE' in l.opts.env, false);
  ok(await api('POST', `/api/projects/${S.p.id}/environments/hml/open`, { rel: 'rm.EXE' })); // sem diferenciar maiúsculas; abre o arquivo real
  assert.equal(launches[1].exe, path.join(BOA, 'RM.exe'));
  ok(await api('POST', `/api/projects/${S.p.id}/environments/prod/open`, { rel: 'RM.exe' })); // Produção também abre direto
  assert.equal(launches[2].exe, path.join(GEN, 'RM.exe'));

  const n = launches.length;
  for (const rel of ['UPDATE_LastVersion\\RM.exe', 'UPDATE_LastVersion/RM.exe', '..\\CLIENTE BETA\\rm.EXE', path.join(GEN, 'RM.exe'), 'RM.Atualizador.exe', 'Biblioteca.dll', '.\\..\\PRD', '', 'RM.exe\\..\\RM.exe']) {
    assert.equal((await api('POST', `/api/projects/${S.p.id}/environments/hml/open`, { rel })).status, 404, rel);
  }
  assert.equal((await api('POST', `/api/projects/${S.p.id}/environments/dev/open`, { rel: 'RM.exe' })).status, 404); // ambiente que não existe
  assert.equal(launches.length, n); // nenhuma tentativa recusada iniciou algo
  assert.deepEqual(snapshot(path.join(tmp, 'rm')), before);

  const q = ok(await api('POST', '/api/projects', { name: 'Sem pasta', rootDirKind: 'local', rootDir: '' }));
  assert.equal((await api('POST', `/api/projects/${q.id}/environments/prod/open`, { rel: 'RM.exe' })).status, 400); // sem diretório definido
  ok(await api('PUT', `/api/projects/${q.id}/environments`, { prod: { dir: path.join(tmp, 'apagada') } }));
  assert.equal((await api('POST', `/api/projects/${q.id}/environments/prod/open`, { rel: 'RM.exe' })).status, 400); // diretório sumiu

  spawnMode = 'error';
  const failed = await api('POST', `/api/projects/${S.p.id}/environments/prod/open`, { rel: 'RM.exe' });
  assert.equal(failed.status, 500); assert.match(failed.json.error, /Não foi possível iniciar o RM\.exe/);
  spawnMode = 'ok';
  const audit = fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'audit.log'), 'utf8');
  assert.match(audit, /"action":"rm-aberto"/); assert.match(audit, /Homologação: RM\.exe \(-Multi=True\)/);
});

test('garantia estática: o serviço não escreve, move, copia nem apaga nada em disco e este teste só usa pasta temporária', () => {
  for (const f of ['../src/rm-env.js', '../src/rm-env-api.js']) {
    const code = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /writeFile|appendFile|unlink|rmSync|rmdir|\.rm\(|rename|copyFile|mkdir|truncate|symlink|createWriteStream|chmod|utimes/, f);
    assert.doesNotMatch(code, /shell\s*:\s*true|exec\(|execSync|execFile/, f); // sem shell
  }
  const ui = fs.readFileSync(path.join(__dirname, '../public/rm-env.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(ui, /confirmDialog|window\.confirm|\bconfirm\(/); // abrir o RM é direto: nenhuma caixa de confirmação
  assert.doesNotMatch(ui, /Vários RM\.exe|choose\(/); // e nenhuma janela de escolha
  const me = fs.readFileSync(__filename, 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(me, new RegExp(['C:', '[\\\\/]+', 'RM'].join(''), 'i')); // este arquivo não aponta para a pasta real do computador
  assert.ok(HMG.startsWith(os.tmpdir()));
});
