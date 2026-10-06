// Fachada de acesso ao SQL Server usada pelo servidor web.
// Toda operação roda num processo-filho (dbworker.js) com timeout de conexão e é precedida de um teste rápido
// de rede: assim, VPN caída ou servidor sem resposta viram uma mensagem clara em segundos, nunca uma tela
// "carregando" para sempre — e uma conexão pendurada nunca impede as demais (ex.: o teste do localhost).
const path = require('path');
const net = require('net');
const dns = require('dns');
const { fork } = require('child_process');
const core = require('./db-core');
const { assertStatementSafe } = require('./sqlplan');
const { httpError } = require('./util');

const CONNECT_TIMEOUT_MS = 25000; // tempo máximo para o SQL Server aceitar a conexão (depois disso o processo é encerrado)
const DNS_TIMEOUT_MS = 4000;
const TCP_TIMEOUT_MS = 6000;

const withTimeout = (promise, ms, makeError) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(makeError()), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// Falha rápido (em poucos segundos) quando o servidor não é alcançável. Servidores locais são pulados
// (o SQL Server local pode aceitar só memória compartilhada, sem TCP).
async function assertReachable(conn) {
  if (core.isLoopback(conn.server)) return;
  const [host, instance] = String(conn.server).split('\\');
  const dica = 'Confira o nome do servidor e se a VPN está conectada.';

  let addr = host;
  if (!net.isIP(host)) {
    try {
      addr = (await withTimeout(dns.promises.lookup(host), DNS_TIMEOUT_MS, () => Object.assign(new Error('timeout'), { code: 'GP_TIMEOUT' }))).address;
    } catch (e) {
      throw httpError(502, e.code === 'GP_TIMEOUT'
        ? `O DNS não respondeu ao procurar "${host}" em ${DNS_TIMEOUT_MS / 1000} s. ${dica}`
        : `Não foi possível encontrar o servidor "${host}" na rede. ${dica}`);
    }
  }
  if (instance && !conn.port) return; // instância nomeada: porta dinâmica (SQL Browser/UDP); só o DNS pôde ser conferido

  const port = conn.port ? Number(conn.port) : 1433;
  await new Promise((resolve, reject) => {
    const s = net.connect({ host: addr, port });
    const fail = (msg) => { s.destroy(); reject(httpError(502, msg)); };
    s.setTimeout(TCP_TIMEOUT_MS, () => fail(`Sem resposta de ${host}:${port} em ${TCP_TIMEOUT_MS / 1000} s. ${dica}`));
    s.once('connect', () => { s.destroy(); resolve(); });
    s.once('error', (e) => fail(e.code === 'ECONNREFUSED'
      ? `${host}:${port} recusou a conexão (o SQL Server está parado ou a porta está errada).`
      : `Não foi possível conectar em ${host}:${port} (${e.code || e.message}). ${dica}`));
  });
}

// Roda uma operação no processo-filho. O timeout vale só até a conexão ser estabelecida; depois disso
// (ex.: importação longa) o processo roda até terminar.
function runWorker(op, args, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'dbworker.js'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      settle(reject, httpError(504, `O servidor SQL não respondeu em ${CONNECT_TIMEOUT_MS / 1000} s. Confira a VPN, o servidor e o tipo de autenticação. Nada foi alterado.`));
      child.kill();
    }, CONNECT_TIMEOUT_MS);
    child.on('message', (m) => {
      if (m.type === 'connected') clearTimeout(timer);
      else if (m.type === 'progress') onProgress && onProgress(m.done, m.total);
      else if (m.type === 'result') settle(resolve, m.value);
      else if (m.type === 'error') settle(reject, Object.assign(new Error(m.message), { status: m.status, executed: m.executed, scriptOutput: m.scriptOutput }));
    });
    if (signal) { // cancelado (ex.: a pessoa fechou a janela ou clicou em Parar): encerra o processo; o SQL Server desfaz a transação aberta
      const stop = () => { settle(reject, Object.assign(new Error('Execução cancelada. O que o script já tinha feito foi desfeito (a transação não foi confirmada).'), { status: 499, cancelled: true })); child.kill(); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    }
    child.on('error', (e) => settle(reject, e));
    child.on('exit', () => settle(reject, new Error('O processo de acesso ao banco terminou inesperadamente.')));
    child.send({ op, args });
  });
}

async function testConnection(conn, password) {
  try {
    core.validateConnection(conn);
    await assertReachable(conn);
    return await runWorker('test', { conn, password });
  } catch (e) {
    return { ok: false, error: core.friendly(e) };
  }
}

async function precheck(conn, password, tables) {
  core.validateConnection(conn);
  await assertReachable(conn);
  return runWorker('precheck', { conn, password, tables });
}

async function executePlan(conn, password, plan, { dryRun = false, allowDestructive = false, allowDestructiveScripts = false, onProgress } = {}) {
  for (const s of plan.statements) assertStatementSafe(s, { allowDestructive, allowDestructiveScripts }); // valida TUDO antes de qualquer conexão (o filho valida de novo)
  core.validateConnection(conn);
  await assertReachable(conn);
  const statements = plan.statements.map(({ kind, sql, table, rows, expected, scriptId, script, file, batch, of }) => ({ kind, sql, table, rows, expected, scriptId, script, file, batch, of }));
  return runWorker('execute', { conn, password, plan: { statements }, dryRun, allowDestructive, allowDestructiveScripts }, { onProgress });
}

// Script de apoio (checklist): mesma cadeia das outras operações — validação, teste de rede/VPN e processo-filho com timeout.
async function runScript(conn, password, script, { signal } = {}) {
  core.validateConnection(conn);
  await assertReachable(conn);
  return runWorker('runscript', { conn, password, script }, { signal });
}

module.exports = {
  isLoopback: core.isLoopback, validateConnection: core.validateConnection, friendly: core.friendly, label: core.label,
  testConnection, precheck, executePlan, runScript, assertReachable,
};
