// Senhas de conexão são guardadas criptografadas com DPAPI do Windows (escopo do usuário atual):
// só este usuário, nesta máquina, consegue descriptografar o valor salvo em data/projects.json.
//
// Senha ilegível: se o valor foi gravado por outro usuário/computador (arquivo de dados copiado) ou a chave DPAPI do usuário mudou
// (ex.: senha do Windows redefinida por um administrador), o Windows recusa com "Chave inválida para uso no estado especificado"
// (NTE_BAD_KEY_STATE). Isso não tem conserto pelo app — só informando a senha de novo. O script devolve o código DPAPI_EXIT e
// unprotect lança um erro com code 'PASSWORD_UNREADABLE' para quem chama montar a mensagem certa (nunca o CLIXML do PowerShell).
const { runPowerShell } = require('./powershell');

const DPAPI_EXIT = 3; // CryptographicException (chave/dados DPAPI) — distinto de qualquer outra falha do PowerShell

const PROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($in)
try { $out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
catch [Security.Cryptography.CryptographicException] { [Console]::Error.Write($_.Exception.Message); exit ${DPAPI_EXIT} }
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

const UNPROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
try { $bytes = [Convert]::FromBase64String($in) } catch { [Console]::Error.Write('valor salvo não é um texto criptografado válido'); exit ${DPAPI_EXIT} }
try { $out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
catch [Security.Cryptography.CryptographicException] { [Console]::Error.Write($_.Exception.Message); exit ${DPAPI_EXIT} }
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

async function protect(plain) {
  const input = Buffer.from(String(plain), 'utf8').toString('base64');
  try {
    return (await runPowerShell(PROTECT, { input })).trim();
  } catch (e) {
    if (e.exitCode === DPAPI_EXIT) throw Object.assign(new Error(`Não foi possível proteger a senha com a criptografia do Windows (DPAPI): ${e.message}`), { status: 500, code: 'PASSWORD_PROTECT_FAILED' });
    throw e;
  }
}

async function unprotect(blob) {
  try {
    const out = await runPowerShell(UNPROTECT, { input: blob });
    return Buffer.from(out.trim(), 'base64').toString('utf8');
  } catch (e) {
    if (e.exitCode === DPAPI_EXIT) throw Object.assign(new Error(`Senha salva ilegível para este usuário do Windows (DPAPI: ${e.message})`), { code: 'PASSWORD_UNREADABLE', dpapi: e.message });
    throw e;
  }
}

module.exports = { protect, unprotect, DPAPI_EXIT };
