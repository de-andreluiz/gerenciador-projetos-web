// Ambientes RM do projeto (Homologação / Produção): link de download + diretório local onde ficam os RM.exe.
//
// SEGURANÇA — são ambientes de clientes reais:
//  - A busca é SOMENTE LEITURA e olha apenas a pasta informada pelo usuário (não entra em subpastas): confere (lstat) o arquivo
//    chamado RM.exe. Nunca abre, lê, copia, move, renomeia ou apaga nada; não segue links simbólicos.
//  - O único programa que o app inicia é um arquivo chamado exatamente RM.exe, ENCONTRADO por essa busca na pasta cadastrada
//    do projeto, sempre com o argumento fixo -Multi=True (spawn sem shell; a tela só envia o nome que o servidor listou).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { httpError, str } = require('./util');

const KINDS = { hml: 'Homologação', prod: 'Produção' };
const EXE_NAME = 'rm.exe';
const LAUNCH_ARGS = ['-Multi=True'];

const isRoot = (p) => path.parse(p).root.toLowerCase() === p.toLowerCase();

function cleanEnv(b) {
  const downloadUrl = str(b?.downloadUrl, 600);
  if (downloadUrl) {
    let u = null; try { u = new URL(downloadUrl); } catch { /* inválida */ }
    if (!u || !/^https?:$/.test(u.protocol)) throw httpError(400, 'O link de download precisa começar com http:// ou https://.');
  }
  let dir = str(b?.dir, 500);
  if (dir) {
    if (!path.isAbsolute(dir)) throw httpError(400, 'Diretório do ambiente: informe um caminho completo (ex.: C:\\RM\\HMG\\CLIENTE).');
    dir = path.normalize(dir);
    if (!isRoot(dir)) dir = dir.replace(/[\\/]+$/, '');
    if (isRoot(dir)) throw httpError(400, 'Escolha uma pasta, não a raiz de um disco.');
  }
  return { downloadUrl, dir };
}

// Lê só os ambientes enviados (hml/prod); o que não vier continua como está. Projeto antigo sem o campo = tudo vazio.
function cleanEnvironments(body, existing) {
  const out = { ...(existing || {}) };
  for (const k of Object.keys(KINDS)) if (body && body[k] !== undefined) out[k] = cleanEnv(body[k]);
  return out;
}
const envOf = (p, kind) => ({ downloadUrl: '', dir: '', ...(p.environments?.[kind] || {}) });

const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };

// RM.exe SOMENTE na pasta informada — nunca entra em subpastas. Só leitura. Devolve 0 ou 1 item (o Windows não aceita dois
// arquivos com o mesmo nome, em qualquer caixa, na mesma pasta).
function findRmExes(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.toLowerCase() !== EXE_NAME) continue;
    const full = path.join(dir, e.name);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    out.push({ rel: e.name, abs: full, folder: '.', size: st.size, mtime: st.mtime.toISOString() });
  }
  return out;
}

// Ponto único de criação de processo (os testes trocam por um simulado: nenhum teste inicia programa de verdade).
let spawner = spawn;
const setSpawn = (fn) => { spawner = fn || spawn; };

// Inicia o RM.exe (já validado) com -Multi=True, desacoplado do app. Resolve quando o processo nasceu; rejeita se o Windows recusar.
function launchRm(exeAbs, spawnFn = spawner) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // o RM não é Node; evita herdar o modo do Electron
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn(exeAbs, LAUNCH_ARGS, { cwd: path.dirname(exeAbs), detached: true, stdio: 'ignore', env }); } catch (e) { return reject(httpError(500, `Não foi possível iniciar o RM.exe: ${e.message}`)); }
    child.once('error', (e) => reject(httpError(500, `Não foi possível iniciar o RM.exe: ${e.message}`)));
    child.once('spawn', () => { child.unref?.(); resolve(); });
  });
}

module.exports = { KINDS, LAUNCH_ARGS, cleanEnvironments, envOf, findRmExes, launchRm, setSpawn, isDir };
