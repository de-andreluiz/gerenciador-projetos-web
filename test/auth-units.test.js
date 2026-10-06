// Peças sem rede: configuração (.env), política de senha.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDotEnv, appConfig } = require('../src/config');
const { checkPassword } = require('../src/auth/session');

test('config: modo é sempre local', () => {
  assert.equal(appConfig({}).mode, 'local');
  assert.equal(appConfig({ GP_ENV: 'prod' }).env, 'prod');
});

test('.env: só chaves GP_* e PORT, sem sobrescrever o ambiente; comentários ignorados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '# comentário\nGP_TESTE_X=valor # nota\nGP_TESTE_Y="aspas"\nPATH=hackeado\nGP_TESTE_JA=novo\n');
  process.env.GP_TESTE_JA = 'antigo';
  const before = process.env.PATH;
  loadDotEnv(dir);
  assert.equal(process.env.GP_TESTE_X, 'valor'); assert.equal(process.env.GP_TESTE_Y, 'aspas');
  assert.equal(process.env.GP_TESTE_JA, 'antigo'); assert.equal(process.env.PATH, before);
  for (const k of ['GP_TESTE_X', 'GP_TESTE_Y', 'GP_TESTE_JA']) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

test('senha: mínimo 12 com maiúscula, minúscula, número e símbolo', () => {
  for (const bad of ['123', 'curta1!A', 'semnumero!!AAaa', 'SEMMINUSCULA1!!', 'semmaiuscula1!!', 'SemSimbolo1234', undefined]) assert.throws(() => checkPassword(bad), { code: 'WEAK_PASSWORD' }, String(bad));
  assert.equal(checkPassword('Senha-Forte-2026'), 'Senha-Forte-2026');
});
