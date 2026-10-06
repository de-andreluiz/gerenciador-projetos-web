// Gera o aplicativo desktop (Windows x64) em .\app\ com o ícone do projeto.
// Uso: npm run build:desktop   (ou build_exe.bat)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const NAME = 'Gerenciador de Projetos';
const pkg = require(path.join(root, 'package.json'));

(async () => {
  const tmpOut = path.join(root, 'dist');
  const [built] = await packager({
    dir: root, name: NAME, platform: 'win32', arch: 'x64', out: tmpOut, overwrite: true,
    icon: path.join(root, 'assets', 'icone.ico'), appVersion: pkg.version, prune: true,
    asar: { unpack: '**/*.node' }, // biblioteca nativa do SQL Server precisa ficar fora do .asar
    // Mantém só os idiomas usados pelo Chromium (pt-BR e en-US): economiza ~45 MB.
    afterExtract: [async ({ buildPath }) => {
      const dir = path.join(buildPath, 'locales');
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (!/^(pt-BR|en-US)\.pak$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }],
    ignore: [
      /^\/(data|dist|app|test|scripts|\.git|\.claude)($|\/)/, /^\/assets\/gerar_icone\.py$/, /^\/(build_exe|iniciar)\.bat$/,
      /^\/(README\.md|\.gitignore)$/, /\/prebuilds\/(darwin|linux)[^/]*($|\/)/,
    ],
    win32metadata: { CompanyName: '', FileDescription: NAME, ProductName: NAME, InternalName: NAME, OriginalFilename: `${NAME}.exe` },
  });

  // Substitui .\app\ (somente se for uma saída anterior deste build) e cria o atalho na raiz do projeto.
  const target = path.join(root, 'app');
  if (fs.existsSync(target)) {
    if (!fs.existsSync(path.join(target, `${NAME}.exe`))) throw new Error(`A pasta ${target} existe e não parece ser uma saída anterior do build; nada foi alterado.`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.renameSync(built, target);
  fs.rmSync(tmpOut, { recursive: true, force: true });

  const lnk = path.join(root, `${NAME}.lnk`);
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:GP_LNK);$s.TargetPath=$env:GP_EXE;$s.WorkingDirectory=$env:GP_DIR;$s.IconLocation=$env:GP_ICO;$s.Description='Gerenciador de Projetos';$s.Save()`;
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-Command', ps],
    { env: { ...process.env, GP_LNK: lnk, GP_EXE: path.join(target, `${NAME}.exe`), GP_DIR: target, GP_ICO: path.join(target, `${NAME}.exe`) + ',0' } });

  console.log(`Aplicativo gerado em: ${target}\\${NAME}.exe`);
  console.log(`Atalho: ${lnk}`);
})().catch((e) => { console.error('Falha ao gerar o executável:', e.message); process.exit(1); });
