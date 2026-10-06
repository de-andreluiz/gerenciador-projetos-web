const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

// Estes testes NÃO precisam de SQL Server: cobrem a checagem de rede que impede "carregar para sempre" com a VPN caída.

test('servidor que não resolve no DNS falha rápido com mensagem clara', async () => {
  const t0 = Date.now();
  const r = await db.testConnection({ server: 'servidor-inexistente.invalid', database: 'X', auth: 'windows' }, '');
  assert.equal(r.ok, false);
  assert.match(r.error, /VPN/);
  assert.ok(Date.now() - t0 < 10000, 'deveria falhar em segundos');
});

test('servidor inalcançável (endereço de documentação) falha em poucos segundos, sem travar', async () => {
  const t0 = Date.now();
  const r = await db.testConnection({ server: '192.0.2.1', database: 'X', auth: 'sql', user: 'sa' }, 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /VPN|conectar/);
  assert.ok(Date.now() - t0 < 10000, `demorou ${Date.now() - t0} ms`);
});

test('assertReachable pula servidores locais e rejeita os inalcançáveis', async () => {
  await assert.doesNotReject(db.assertReachable({ server: 'localhost' }));
  await assert.doesNotReject(db.assertReachable({ server: '127.0.0.1', port: 1 }));
  await assert.rejects(db.assertReachable({ server: '192.0.2.1', port: 1433 }), /VPN|conectar/);
});

test('execução: a trava de segurança roda ANTES de qualquer conexão', async () => {
  const plan = { statements: [{ kind: 'drop', sql: 'DROP TABLE x' }] };
  await assert.rejects(db.executePlan({ server: '192.0.2.1', database: 'X', auth: 'windows' }, '', plan, {}), /bloqueado/);
});
