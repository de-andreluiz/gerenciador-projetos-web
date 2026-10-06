// Tela de acesso (Fase 4, modo nuvem): entrar, primeiro acesso (código do convite), esqueci a senha, aguardando liberação.
// A tela nunca vê tokens: tudo passa pela API local (/api/auth/*), que fala com o Supabase Auth. Senhas não são guardadas no navegador.
// Modo local: nada muda (a sessão local é sempre "ativa").
const AUTH = { session: null, shown: false };

// Ponto de entrada (DOMContentLoaded em app.js): decide entre a tela de acesso e o app.
async function authBoot() {
  let s;
  try { s = await api('GET', '/api/session'); } catch (e) { if (e.silent) return; throw e; }
  AUTH.session = s;
  if (s.mode === 'local' || s.status === 'active') { renderUserBox(s); return refresh(); }
  if (s.status === 'offline_hours') { // sem conexão: só o controle de horas (local) do último usuário deste Windows
    renderUserBox(s);
    if (!location.hash.startsWith('#/hours')) location.hash = '#/hours';
    render();
    return;
  }
  authShow(s.status === 'pending' ? 'pending' : 'login', s.message);
}

// Chamado por api() quando o servidor responde 401/403 de sessão no meio do uso.
function authLost(json) {
  if (AUTH.shown) return;
  if (json.code === 'LAUNCH_REQUIRED') return authShow('launch'); // a própria tela já explica (sem mensagem repetida)
  // Recarrega: a memória e a tela do usuário anterior são descartadas (nada fica visível por trás da tela de acesso).
  location.reload();
}

function renderUserBox(s) {
  const box = document.getElementById('userBox');
  if (!box || s.mode !== 'cloud' || !s.user) return;
  const name = s.user.displayName || s.user.username || s.user.email;
  if (s.user.offline) {
    box.replaceChildren(h('div', { class: 'user-box offline' },
      h('div', { class: 'grow' }, h('b', null, name), h('span', { class: 'small muted' }, 'Modo offline · só controle de horas')),
      h('button', { class: 'btn sm', title: 'Sair do modo offline e entrar com o usuário (precisa de conexão)', onclick: authLogout }, 'Reconectar')));
    return;
  }
  box.replaceChildren(h('div', { class: 'user-box' },
    h('div', { class: 'grow' }, h('b', null, name), h('span', { class: 'small muted' }, [s.user.role, s.env !== 'prod' ? `ambiente ${s.env}` : ''].filter(Boolean).join(' · '))),
    h('button', { class: 'btn sm', title: 'Sair (encerra a sessão nesta máquina)', onclick: authLogout }, 'Sair')));
}

async function authLogout() {
  try { await api('POST', '/api/auth/logout'); } catch (e) { if (!e.silent) fail(e); }
  location.reload();
}

const authInput = (type, attrs = {}) => h('input', { type, ...attrs });
const PASSWORD_HINT = 'Mínimo de 12 caracteres, com letras maiúsculas e minúsculas, números e símbolos.';

function authShow(view, message) {
  AUTH.shown = true;
  document.body.classList.add('signed-out');
  document.getElementById('main')?.replaceChildren();
  document.getElementById('nav')?.replaceChildren();
  let screen = document.getElementById('authScreen');
  if (!screen) { screen = h('div', { id: 'authScreen', class: 'auth-screen', role: 'main' }); document.body.append(screen); }
  const msg = h('div', { class: 'auth-msg', role: 'alert', 'aria-live': 'polite' }, message || '');
  const say = (text, kind = 'error') => { msg.textContent = text || ''; msg.className = `auth-msg ${kind}`; };
  const submit = (btn, fn) => async (ev) => {
    ev.preventDefault();
    say('');
    btn.disabled = true;
    try { await fn(); } catch (e) { if (!e.silent) say(e.message); } finally { btn.disabled = false; }
  };
  const done = (v) => { if (v.status === 'active') location.reload(); else authShow(v.status === 'pending' ? 'pending' : 'login', v.message); };
  const link = (label, to) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); authShow(to); } }, label);
  const views = {
    login: () => {
      const email = authInput('text', { inputmode: 'email', autocomplete: 'username', required: true, autofocus: true });
      const pass = authInput('password', { autocomplete: 'current-password', required: true });
      const remember = authInput('checkbox', { id: 'authRemember' });
      const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
      const off = AUTH.session?.offlineHours;
      // Nome acessível = o texto visível; a explicação vai em dica visível (não em title, que leitores de tela leem no lugar do rótulo).
      const offBtn = off?.available ? h('button', { class: 'btn', type: 'button', 'aria-describedby': 'offHint' }, `Trabalhar offline (só controle de horas)${off.displayName ? ` — ${off.displayName}` : ''}`) : null;
      const offHint = offBtn ? h('div', { id: 'offHint', class: 'small muted' }, 'Sem conexão com o servidor: abre só as horas guardadas neste computador.') : null;
      if (offBtn) offBtn.onclick = submit(offBtn, async () => { await api('POST', '/api/auth/offline-hours'); location.reload(); });
      const tryLogin = async () => {
        try { done(await api('POST', '/api/auth/login', { email: email.value, password: pass.value, remember: remember.checked })); } catch (e) {
          if (e.code === 'OFFLINE' && !off?.available) { // sem conexão: se houver usuário anterior neste Windows, oferece o modo offline das horas
            try { AUTH.session = await api('GET', '/api/session'); } catch { /* */ }
            if (AUTH.session?.offlineHours?.available) return authShow('login', e.message);
          }
          throw e;
        }
      };
      return h('form', { class: 'stack', onsubmit: submit(btn, tryLogin) },
        field('E-mail', email), field('Senha', pass),
        h('label', { class: 'inline small' }, remember, h('span', null, 'Manter conectado neste computador')),
        btn, offBtn, offHint, h('div', { class: 'auth-links small' }, link('Primeiro acesso (tenho um código)', 'first'), link('Esqueci minha senha', 'forgot')));
    },
    first: () => codeForm('Primeiro acesso', 'Informe o e-mail convidado, o código recebido no convite e crie a sua senha.', '/api/auth/first-access'),
    reset: () => codeForm('Redefinir senha', 'Informe o código recebido por e-mail e a nova senha.', '/api/auth/recover'),
    forgot: () => {
      const email = authInput('text', { inputmode: 'email', autocomplete: 'username', required: true, autofocus: true });
      const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Enviar código');
      return h('form', { class: 'stack', onsubmit: submit(btn, async () => { const r = await api('POST', '/api/auth/recover-request', { email: email.value }); AUTH.lastEmail = email.value; authShow('reset', r.message); }) },
        h('p', { class: 'small muted' }, 'Enviaremos um código para o e-mail cadastrado.'), field('E-mail', email), btn,
        h('div', { class: 'auth-links small' }, link('Já tenho o código', 'reset'), link('Voltar', 'login')));
    },
    pending: () => {
      const check = h('button', { class: 'btn primary', type: 'button' }, 'Verificar novamente');
      check.onclick = submit(check, async () => done(await api('POST', '/api/auth/check')));
      return h('div', { class: 'stack' }, h('p', null, 'Seu acesso está aguardando configuração pelo administrador. Nenhum dado é exibido até a liberação.'),
        h('div', { class: 'inline' }, check, h('button', { class: 'btn', type: 'button', onclick: authLogout }, 'Sair')));
    },
    launch: () => h('p', null, 'Por segurança, abra o aplicativo pelo atalho do Gerenciador de Projetos (ou pelo endereço completo mostrado ao iniciar).'),
  };
  function codeForm(title, help, url) {
    const email = authInput('text', { inputmode: 'email', autocomplete: 'username', required: true, value: AUTH.lastEmail || '' });
    const code = authInput('text', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 10 });
    const p1 = authInput('password', { autocomplete: 'new-password', required: true });
    const p2 = authInput('password', { autocomplete: 'new-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Salvar senha e entrar');
    return h('form', { class: 'stack', onsubmit: submit(btn, async () => {
      if (p1.value !== p2.value) throw new Error('As duas senhas não conferem.');
      done(await api('POST', url, { email: email.value, code: code.value, password: p1.value }));
    }) }, h('p', { class: 'small muted' }, help), field('E-mail', email), field('Código', code), field('Nova senha', p1, PASSWORD_HINT), field('Confirmar a nova senha', p2), btn,
    h('div', { class: 'auth-links small' }, link('Voltar', 'login')));
  }
  const titles = { login: 'Entrar', first: 'Primeiro acesso', forgot: 'Esqueci minha senha', reset: 'Redefinir senha', pending: 'Acesso aguardando liberação', launch: 'Abra pelo atalho' };
  const env = AUTH.session?.env && AUTH.session.env !== 'prod' ? h('span', { class: 'pill soon' }, `ambiente ${AUTH.session.env}`) : null;
  screen.replaceChildren(h('div', { class: 'card auth-card' },
    h('div', { class: 'card-head' }, h('img', { src: 'icone.png', alt: '', width: 28, height: 28 }), h('div', { class: 'grow' }, h('b', null, 'Gerenciador de Projetos'), h('div', { class: 'small muted' }, titles[view] || '')), env),
    h('div', { class: 'card-body' }, msg, (views[view] || views.login)())));
  if (message) say(message, view === 'reset' || view === 'pending' ? 'info' : 'error');
}
