// INTEGRAÇÃO com um Supabase REAL local (Docker: Postgres 17, Auth/GoTrue, PostgREST, Storage, Edge Functions/Deno, Mailpit).
// Exercita o app de verdade, sem simulação: servidor em modo nuvem → Supabase Auth → my_profile → gp-keys (KEK) → apply_changes
// → Storage cifrado → gp-admin (convite/suspensão) → e-mails com CÓDIGO (Mailpit) → primeiro acesso / recuperação → DPAPI real.
// Pré-requisitos: Docker Desktop + `npx supabase start` na raiz (migrations aplicadas). Rodar: npm run test:supabase
// A service role do Supabase LOCAL é usada só por este roteiro de teste (criar contas de teste, ler o Storage cru);
// o app nunca a recebe. A KEK de teste é aleatória, gerada aqui e passada às funções por arquivo temporário fora do projeto.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sblocal-'));
const PORT = 4461;
const TOKEN = crypto.randomBytes(24).toString('hex');
const PASS = 'Senha-Forte-2026';
const RUN = Date.now().toString(36); // e-mails únicos por execução (o banco local persiste entre execuções)
const mail = (n) => `${n}.${RUN}@exemplo.test`;

let S; // status do Supabase local (URLs e chaves LOCAIS de desenvolvimento)
let functionsProc;
let server;
let app; let store; let session;
let cookie = '';
const U = {};

function supabaseStatus() {
  const out = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'status', '-o', 'json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out.slice(out.indexOf('{')));
  return {
    api: j.API_URL, anon: j.PUBLISHABLE_KEY || j.ANON_KEY, service: j.SERVICE_ROLE_KEY || j.SECRET_KEY,
    mailpit: j.MAILPIT_URL || j.INBUCKET_URL || 'http://127.0.0.1:54324', dbContainer: 'supabase_db_gerenciador-projetos-local',
  };
}
const psql = (sql) => execFileSync('docker', ['exec', S.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', sql], { encoding: 'utf8' }).trim();
const admin = async (method, p, body) => {
  const r = await fetch(`${S.api}${p}`, { method, headers: { apikey: S.service, Authorization: `Bearer ${S.service}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`${p}: ${r.status} ${t}`); return t ? JSON.parse(t) : null;
};
const createUser = async (name) => (await admin('POST', '/auth/v1/admin/users', { email: mail(name), password: PASS, email_confirm: true })).id;
async function codeFor(email, kind) { // último e-mail recebido pelo destinatário no Mailpit → código numérico
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${S.mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const m = (list.messages || []).find((x) => (kind === 'invite' ? /Convite/ : /Redefini/).test(x.Subject));
    if (m) { const full = await (await fetch(`${S.mailpit}/api/v1/message/${m.ID}`)).json(); const code = /(\d{6,10})/.exec(full.Text || full.HTML || ''); if (code) return code[1]; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`código não chegou para ${email}`);
}
const call = async (method, url, body, extraHeaders = {}) => {
  const r = await fetch(`http://localhost:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}`, Cookie: cookie, ...extraHeaders }, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body) });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};
const login = (name, remember = false, password = PASS) => call('POST', '/api/auth/login', { email: mail(name), password, remember });
const fn = async (name, body, token) => {
  const r = await fetch(`${S.api}/functions/v1/${name}`, { method: 'POST', headers: { apikey: S.anon, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('CONTEUDO_CONFIDENCIAL_REAL'), Buffer.alloc(64, 3)]);

test.before(async () => {
  S = supabaseStatus();
  // Banco LOCAL de testes começa limpo a cada execução (a KEK de teste é nova a cada execução; dados antigos não abririam).
  // TRUNCATE não dispara os triggers de linha (a auditoria append-only só é limpa aqui, no banco local descartável).
  psql(`truncate public.projects, public.data_keys, public.audit_events, public.stages, public.cycles, public.project_types, public.origin_systems,
    public.checklists, public.checklist_items, public.documents, public.email_images, public.scripts, public.people, public.connections,
    public.app_settings, public.email_templates, public.migration_runs, public.app_releases cascade;`);
  // storage.objects não é limpo: o próprio Supabase proíbe exclusão direta (só pela API) e os caminhos usam ids novos a cada execução.
  // Edge Functions com KEK de TESTE aleatória (arquivo temporário fora do projeto, apagado no fim)
  const envFile = path.join(tmp, 'functions.env');
  fs.writeFileSync(envFile, `GP_KEK_V1=${crypto.randomBytes(32).toString('base64')}\nGP_KEK_CURRENT=1\n`);
  const spawnedAt = Date.now();
  functionsProc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'functions', 'serve', '--env-file', envFile], { cwd: ROOT, shell: process.platform === 'win32', stdio: 'ignore' });
  // `functions serve` RECRIA o contêiner das Edge Functions (com a KEK de teste): espera o contêiner novo subir e responder,
  // senão os testes falam com o contêiner antigo (sem KEK) ou pegam a troca no meio (502).
  const edgeStarted = () => { try { return Date.parse(execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', 'supabase_edge_runtime_gerenciador-projetos-local'], { encoding: 'utf8' }).trim()); } catch { return 0; } };
  let ready = 0;
  for (let i = 0; i < 240 && ready < 3; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (edgeStarted() < spawnedAt - 2000) continue;
    const r = await fetch(`${S.api}/functions/v1/gp-keys`, { method: 'POST', headers: { apikey: S.anon } }).catch(() => null);
    ready = r && r.status === 401 ? ready + 1 : 0; // 3 respostas seguidas do contêiner novo
  }
  if (ready < 3) throw new Error('Edge Functions locais não subiram (veja `npx supabase functions serve`).');
  U.master = await createUser('master');
  psql(`select gp.bootstrap_master('${U.master}')`.replace("select gp.bootstrap_master", "select case when exists (select 1 from public.profiles where role = 'MASTER') then null else gp.bootstrap_master") + ' end');
  if (psql(`select role from public.profiles where id = '${U.master}'`) !== 'MASTER') {
    // banco local já tinha MASTER de execução anterior: transfere para o desta execução (break-glass documentado, só no banco local)
    psql(`begin; select set_config('gp.allow_master_change','on',true); update public.profiles set role='MASTER', status='active' where id='${U.master}'; commit;`);
  }
  U.outsider = await createUser('outsider');
  Object.assign(process.env, { PORT: String(PORT), GP_DATA_DIR: path.join(tmp, 'data'), GP_MODE: 'cloud', GP_LOCAL_DIR: path.join(tmp, 'local'), GP_LAUNCH_TOKEN: TOKEN,
    GP_SUPABASE_URL: S.api, GP_SUPABASE_PUBLISHABLE_KEY: S.anon, GP_ENV: 'local' });
  ({ app, store, session } = require('../../server'));
  server = app.listen(PORT, '127.0.0.1');
  const r = await fetch(`http://localhost:${PORT}/?k=${TOKEN}`, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  try { await session?.logout({ quiet: true }); } catch { /* */ }
  try { functionsProc && (process.platform === 'win32' ? execFileSync('taskkill', ['/pid', String(functionsProc.pid), '/T', '/F'], { stdio: 'ignore' }) : functionsProc.kill()); } catch { /* */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('migrations no Postgres real do Supabase: RLS em todas as tabelas, anon sem grant, 14 permissões, buckets privados', () => {
  assert.equal(psql("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity"), '0');
  assert.equal(psql("select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'"), '0');
  assert.equal(psql('select count(*) from public.permissions'), '14');
  assert.equal(psql("select string_agg(id || ':' || public::text, ',' order by id) from storage.buckets where id in ('evidence','email-images','releases')"), 'email-images:false,evidence:false,releases:false');
});

test('Edge Functions reais: sem JWT → 401; usuário sem acesso não recebe DEK de projeto', async () => {
  assert.equal((await fn('gp-keys', { scopes: ['global'] })).status, 401);
  const o = await (await fetch(`${S.api}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: S.anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: mail('outsider'), password: PASS }) })).json();
  const denied = await fn('gp-keys', { scopes: ['project:qualquer', 'global'], create: false }, o.access_token);
  assert.equal(denied.status, 403, JSON.stringify(denied.json)); // perfil pendente: key_access recusa (fail closed)
});

test('Auth real: /health responde (o modo offline das horas só é liberado quando NÃO responde)', async () => {
  const { GoTrueClient } = require('../../src/auth/gotrue');
  await new GoTrueClient({ url: S.api, publishableKey: S.anon }).health();
  await assert.rejects(new GoTrueClient({ url: 'http://127.0.0.1:9', publishableKey: S.anon, timeoutMs: 3000 }).health(), { code: 'OFFLINE' });
});

test('login real do MASTER pelo app: Supabase Auth → perfil → dados; resposta sem tokens', async () => {
  const r = await login('master');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'active'); assert.equal(r.json.user.role, 'MASTER');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(r.text), 'nenhum JWT na resposta');
});

test('gravação real: projeto e contato cifrados no Postgres (DEK via gp-keys + KEK), lido de volta em claro pelo app', async () => {
  const p = await call('POST', '/api/projects', { name: `Cliente Integração ${RUN}`, description: 'Descrição confidencial', rootDirKind: 'local', rootDir: '' });
  assert.equal(p.status, 200, p.text);
  U.project = p.json.id;
  assert.equal((await call('POST', `/api/projects/${U.project}/contacts`, { name: 'Contato Confidencial', email: 'contato.confidencial@exemplo.test', kind: 'client' })).status, 200);
  const raw = psql(`select doc::text || enc::text from public.projects where id = '${U.project}'`);
  assert.ok(raw.includes('"alg": "A256GCM"') || raw.includes('"alg":"A256GCM"'));
  assert.ok(!raw.includes(`Cliente Integração ${RUN}`) && !raw.includes('Descrição confidencial'));
  const contact = psql(`select enc::text from public.project_contacts where project_id = '${U.project}'`);
  assert.ok(!contact.includes('Contato Confidencial') && !contact.includes('contato.confidencial'));
  assert.equal(psql(`select owner_id from public.projects where id = '${U.project}'`), U.master);
  assert.ok(Number(psql("select count(*) from public.data_keys where scope = 'project:" + U.project + "'")) === 1, 'DEK do projeto embrulhada no banco');
  const st = (await call('GET', '/api/state')).json;
  assert.equal(st.projects.find((x) => x.id === U.project).name, `Cliente Integração ${RUN}`);
});

test('Storage real: evidência sobe cifrada, o objeto cru (service role) não tem o conteúdo, o app devolve o original', async () => {
  // estágio + checklist mínimo para receber evidência
  const st = await call('POST', '/api/stages', { name: `Etapa ${RUN}`, color: '#123456' });
  const ck = await call('POST', '/api/checklists', { name: `CK ${RUN}`, stageId: st.json.id });
  assert.equal(ck.status, 200, ck.text);
  const item = await call('POST', `/api/checklists/${ck.json.id}/items`, { title: 'Print', required: true, evidence: { mode: 'required', type: 'image', min: 1, max: 2 } });
  assert.equal(item.status, 200, item.text);
  const cyc = await call('POST', '/api/cycles', { name: `Ciclo ${RUN}`, steps: [{ stageId: st.json.id }] });
  assert.equal(cyc.status, 200, cyc.text);
  const applied = await call('PUT', `/api/projects/${U.project}`, { name: `Cliente Integração ${RUN}`, description: 'Descrição confidencial', rootDirKind: 'local', rootDir: '', cycleId: cyc.json.id, confirmCycleChange: true });
  assert.equal(applied.status, 200, applied.text);
  const proj = store.project(U.project);
  U.step = proj.steps[0].id;
  assert.equal((await call('PUT', `/api/projects/${U.project}/step`, { stepId: U.step })).status, 200);
  const inst = (await call('POST', `/api/projects/${U.project}/checklists/${U.step}/open`)).json.instance;
  U.item = inst.items[0].id;
  const up = await call('POST', `/api/projects/${U.project}/checklists/${U.step}/items/${U.item}/evidence`, PNG, { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'print.png', 'X-File-Type': 'image/png' });
  assert.equal(up.status, 200, up.text);
  U.ev = up.json.instance.items[0].evidences[0].id;
  const rawObj = Buffer.from(await (await fetch(`${S.api}/storage/v1/object/evidence/${U.project}/${U.ev}`, { headers: { apikey: S.service, Authorization: `Bearer ${S.service}` } })).arrayBuffer());
  assert.equal(rawObj.subarray(0, 4).toString(), 'GPF1');
  assert.ok(!rawObj.includes(Buffer.from('CONTEUDO_CONFIDENCIAL_REAL')));
  const got = await fetch(`http://localhost:${PORT}/api/projects/${U.project}/evidences/${U.ev}/file`, { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
});

test('gp-admin real: convite com CÓDIGO no e-mail → primeiro acesso pelo app → pendente → MASTER provisiona → ativo', async () => {
  const masterJwt = await session.getAccessToken();
  const inv = await fn('gp-admin', { action: 'invite', email: mail('viewer'), displayName: 'Viewer Teste', username: `viewer.${RUN}` }, masterJwt);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  U.viewer = inv.json.userId;
  const code = await codeFor(mail('viewer'), 'invite');
  await call('POST', '/api/auth/logout');
  const fa = await call('POST', '/api/auth/first-access', { email: mail('viewer'), code, password: 'Viewer-Senha-2026' });
  assert.equal(fa.status, 200, fa.text); assert.equal(fa.json.status, 'pending');
  assert.equal((await call('GET', '/api/state')).json.code, 'ACCOUNT_PENDING');
  await call('POST', '/api/auth/logout');
  assert.equal((await login('master')).json.status, 'active');
  const t = await session.getAccessToken();
  const rpc = (name, args) => fetch(`${S.api}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: S.anon, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  assert.equal((await rpc('admin_provision_user', { p_user: U.viewer, p_username: `viewer.${RUN}`, p_display_name: 'Viewer Teste', p_role: 'USER', p_permissions: [] })).status, 204);
  assert.equal((await rpc('project_set_access', { p_project: U.project, p_user: U.viewer, p_access: 'viewer' })).status, 204);
  await call('POST', '/api/auth/logout');
  const v = await call('POST', '/api/auth/login', { email: mail('viewer'), password: 'Viewer-Senha-2026' });
  assert.equal(v.json.status, 'active', v.text);
});

test('viewer real: lê projeto e evidência; anexar → Storage real recusa (403 FORBIDDEN mapeado); editar → 403', async () => {
  const st = (await call('GET', '/api/state')).json;
  assert.deepEqual(st.projects.map((p) => p.id), [U.project]);
  const got = await fetch(`http://localhost:${PORT}/api/projects/${U.project}/evidences/${U.ev}/file`, { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
  const up = await call('POST', `/api/projects/${U.project}/checklists/${U.step}/items/${U.item}/evidence`, PNG, { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'outra.png', 'X-File-Type': 'image/png' });
  assert.equal(up.status, 403, up.text); assert.equal(up.json.code, 'FORBIDDEN');
  const ed = await call('PUT', `/api/projects/${U.project}`, { name: 'Hack', description: '', rootDirKind: 'local', rootDir: '' });
  assert.equal(ed.status, 403, ed.text); assert.equal(ed.json.code, 'FORBIDDEN');
});

test('gp-admin real: suspender → ban no Auth (login recusado) e RLS corta o acesso na hora', async () => {
  const viewerJwt = await session.getAccessToken();
  await call('POST', '/api/auth/logout');
  await login('master');
  const s = await fn('gp-admin', { action: 'set_status', userId: U.viewer, status: 'suspended' }, await session.getAccessToken());
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const direct = await fetch(`${S.api}/rest/v1/projects?select=id`, { headers: { apikey: S.anon, Authorization: `Bearer ${viewerJwt}` } });
  assert.deepEqual(await direct.json(), [], 'token antigo ainda válido não enxerga nada (RLS checa o estado)');
  await call('POST', '/api/auth/logout');
  const v = await call('POST', '/api/auth/login', { email: mail('viewer'), password: 'Viewer-Senha-2026' });
  assert.equal(v.status, 403, v.text); assert.equal(v.json.code, 'SUSPENDED');
});

test('recuperação real: código por e-mail → nova senha → entra; senha antiga deixa de valer', async () => {
  assert.equal((await call('POST', '/api/auth/recover-request', { email: mail('master') })).status, 200);
  const code = await codeFor(mail('master'), 'recovery');
  const r = await call('POST', '/api/auth/recover', { email: mail('master'), code, password: 'Master-Nova-2026' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'active');
  await call('POST', '/api/auth/logout');
  assert.equal((await login('master')).status, 401);
  assert.equal((await login('master', false, 'Master-Nova-2026')).json.status, 'active');
});

test('"manter conectado" com DPAPI real e logout que revoga o refresh token no Auth real', async () => {
  await call('POST', '/api/auth/logout');
  const r = await login('master', true, 'Master-Nova-2026');
  assert.equal(r.json.status, 'active');
  const file = path.join(tmp, 'local', 'session.dpapi.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!saved.refreshEnc.includes(session.tokens.refreshToken), 'refresh token só protegido por DPAPI');
  const { unprotect } = require('../../src/secrets');
  assert.equal(await unprotect(saved.refreshEnc), session.tokens.refreshToken, 'DPAPI real do usuário do Windows abre');
  const oldRefresh = session.tokens.refreshToken;
  await call('POST', '/api/auth/logout');
  assert.ok(!fs.existsSync(file));
  const reuse = await fetch(`${S.api}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: S.anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: oldRefresh }) });
  assert.notEqual(reuse.status, 200, 'refresh token revogado no logout');
});
