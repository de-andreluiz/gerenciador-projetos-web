// Processo-filho que executa UMA operação no SQL Server e sai. Existe para que uma conexão que "pendura"
// (VPN caída, servidor sem resposta) possa ser encerrada à força pelo processo pai sem travar o aplicativo.
const core = require('./db-core');

process.on('disconnect', () => process.exit(0)); // o pai morreu/fechou: não deixa processo órfão

process.once('message', async ({ op, args }) => {
  core.setOnConnected(() => process.send({ type: 'connected' }));
  const finish = (msg) => process.send(msg, () => process.exit(0));
  try {
    let value;
    if (op === 'test') value = await core.testConnection(args.conn, args.password);
    else if (op === 'precheck') value = await core.precheck(args.conn, args.password, args.tables);
    else if (op === 'execute') {
      value = await core.executePlan(args.conn, args.password, args.plan, {
        dryRun: args.dryRun, allowDestructive: args.allowDestructive, allowDestructiveScripts: args.allowDestructiveScripts,
        onProgress: (done, total) => process.send({ type: 'progress', done, total }),
      });
    } else if (op === 'runscript') value = await core.runScript(args.conn, args.password, args.script);
    else throw new Error(`Operação desconhecida: ${op}`);
    finish({ type: 'result', value });
  } catch (e) {
    finish({ type: 'error', message: e.message, status: e.status, executed: e.executed, scriptOutput: e.scriptOutput });
  }
});
