// Links de planilhas do Google Sheets: usados apenas para "Abrir no Google Sheets".
// O app não baixa mais a planilha sozinha: o usuário baixa o .xlsx pelo navegador e o ANEXA ao projeto.
function parseSheetUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const m = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{10,})/);
  return m ? { id: m[1] } : null;
}

module.exports = { parseSheetUrl };
