const { spawn } = require('child_process');
const path = require('path');

// Caminhos absolutos: não dependem do PATH do processo que iniciou o app.
const SYS = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Executa um script PowerShell fixo (nunca montado com dados do usuário).
// Dados variáveis entram por stdin ou variáveis de ambiente, nunca por concatenação no script.
function runPowerShell(script, { input, env = {}, sta = false, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const prelude = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n";
    const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    if (sta) args.push('-STA');
    args.push('-EncodedCommand', encoded);
    const child = spawn(POWERSHELL, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell excedeu o tempo limite.')); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error(cleanPsError(err) || `PowerShell terminou com código ${code}`), { exitCode: code }));
      resolve(out);
    });
    child.stdin.end(input ?? '');
  });
}

// Com a saída redirecionada, o PowerShell escreve os erros em CLIXML ("#< CLIXML <Objs …><S S="Error">…"). Extrai só o texto das
// linhas de erro (sem o XML, sem o "progresso" e com as quebras _x000D__x000A_ decodificadas), para nada disso chegar cru à tela.
function cleanPsError(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('#< CLIXML')) return s;
  const unxml = (t) => t.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const parts = [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => unxml(m[1]));
  return parts.join('').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() && !/^\s*[+~]/.test(l) && !/^No linha:|^At line:/.test(l.trim())).join('\n').trim();
}

module.exports = { runPowerShell, cleanPsError, SYS };
