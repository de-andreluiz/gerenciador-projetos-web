// Seletores nativos do Windows (pasta / arquivo) abertos via PowerShell.
const os = require('os');
const path = require('path');
const { runPowerShell } = require('./powershell');

const FOLDER = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:GP_TITLE
$d.ShowNewFolderButton = $true
if ($env:GP_START -and (Test-Path -LiteralPath $env:GP_START -PathType Container)) { $d.SelectedPath = $env:GP_START }
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;

const FILE = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = $env:GP_TITLE
$d.Filter = $env:GP_FILTER
if ($env:GP_START -and (Test-Path -LiteralPath $env:GP_START -PathType Container)) { $d.InitialDirectory = $env:GP_START }
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;

const SAVE = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = $env:GP_TITLE
$d.Filter = $env:GP_FILTER
$d.FileName = $env:GP_NAME
$d.OverwritePrompt = $true
if ($env:GP_START -and (Test-Path -LiteralPath $env:GP_START -PathType Container)) { $d.InitialDirectory = $env:GP_START }
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;

async function pickFolder({ title = 'Selecione uma pasta', start = '' } = {}) {
  const out = await runPowerShell(FOLDER, { sta: true, env: { GP_TITLE: title, GP_START: start } });
  return out.trim() || null;
}

// Filtros do seletor de arquivo (nomes fixos; o valor do filtro nunca vem de texto livre).
const FILTERS = {
  xlsx: 'Planilhas Excel (*.xlsx)|*.xlsx|Todos os arquivos (*.*)|*.*',
  sql: 'Scripts SQL (*.sql)|*.sql|Todos os arquivos (*.*)|*.*',
  docs: 'Documentos|*.pdf;*.doc;*.docx;*.dot;*.dotx;*.rtf;*.odt;*.txt;*.md;*.csv;*.xls;*.xlsx;*.xlsm;*.xlt;*.xltx;*.ods;*.ppt;*.pptx;*.pot;*.potx;*.odp;*.sql;*.xml;*.json;*.png;*.jpg;*.jpeg;*.gif;*.zip|Todos os arquivos (*.*)|*.*',
};

async function pickFile({ title = 'Selecione um arquivo', start = '', filter = 'xlsx' } = {}) {
  const out = await runPowerShell(FILE, { sta: true, env: { GP_TITLE: title, GP_START: start, GP_FILTER: FILTERS[filter] || FILTERS.xlsx } });
  return out.trim() || null;
}

// "Salvar como" (exportar): o próprio Windows pergunta se pode substituir um arquivo existente.
async function pickSaveFile({ title = 'Salvar como', fileName = '', start = '', filter = 'sql' } = {}) {
  const downloads = path.join(os.homedir(), 'Downloads');
  const out = await runPowerShell(SAVE, { sta: true, env: { GP_TITLE: title, GP_NAME: fileName, GP_START: start || downloads, GP_FILTER: FILTERS[filter] || FILTERS.sql } });
  return out.trim() || null;
}

module.exports = { pickFolder, pickFile, pickSaveFile };
