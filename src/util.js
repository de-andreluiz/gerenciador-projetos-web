const crypto = require('crypto');

const uid = () => crypto.randomBytes(6).toString('hex');

// Nome de arquivo seguro para o Windows (sem caracteres reservados nem nomes de dispositivo).
function sanitizeFileName(name, fallback = 'arquivo') {
  let n = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = fallback;
  return n.slice(0, 150);
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

module.exports = { uid, sanitizeFileName, httpError, str };
