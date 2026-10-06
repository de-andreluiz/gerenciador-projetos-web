// Quem está usando o app — fonte ÚNICA para os campos "feito por" (doneBy, by, createdBy…) e para a auditoria local.
//   modo local → usuário do Windows (como sempre)
//   modo nuvem → nome de exibição do usuário logado (o UUID autoritativo de cada alteração fica na auditoria do banco, por trigger)
'use strict';
const os = require('os');

const windowsUser = () => { try { return os.userInfo().username || null; } catch { return null; } };
let provider = windowsUser;

function who() { try { return provider() || null; } catch { return null; } }
function setProvider(fn) { provider = typeof fn === 'function' ? fn : windowsUser; }

module.exports = { who, setProvider, windowsUser };
