// Edge Function gp-admin — operações administrativas que exigem a service role do Supabase Auth.
// A service role existe SOMENTE aqui (runtime do Supabase). O app desktop nunca a recebe.
//
// Autorização: decidida no Postgres, com o JWT de quem pede, ANTES de qualquer uso da service role.
//   POST { "action": "invite", "email", "displayName", "username" }   → exige users.manage
//        Convida pelo Supabase Auth (o e-mail traz o CÓDIGO do convite; ver template em SETUP-SUPABASE.md).
//        O perfil nasce 'invited' sem acesso; depois do primeiro login vira 'pending' até ser provisionado.
//   POST { "action": "set_status", "userId", "status": "suspended" | "active" }
//        public.admin_set_status valida hierarquia (nunca o MASTER) e muda o estado; aqui aplica/remove o ban no Auth,
//        o que impede novos logins e a renovação de sessões já abertas.
// Nunca registra e-mail, token ou senha em log.
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
function envOr(names: string[], jsonName?: string): string {
  for (const n of names) { const v = Deno.env.get(n); if (v) return v; }
  if (jsonName) { try { const m = JSON.parse(Deno.env.get(jsonName) ?? '{}'); if (m.default) return m.default; } catch { /* ignora */ } }
  throw new Error('configuração ausente');
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Método não permitido.' });
  const jwt = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+(\S+)$/)?.[1];
  if (!jwt) return json(401, { error: 'Não autenticado.' });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'JSON inválido.' }); }

  try {
    const url = envOr(['SUPABASE_URL']);
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    const asUser = createClient(url, envOr(['SUPABASE_ANON_KEY'], 'SUPABASE_PUBLISHABLE_KEYS'), { ...opts, global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: who, error: whoErr } = await asUser.auth.getUser(jwt);
    if (whoErr || !who?.user) return json(401, { error: 'Sessão inválida ou expirada.' });
    const admin = createClient(url, envOr(['SUPABASE_SERVICE_ROLE_KEY'], 'SUPABASE_SECRET_KEYS'), opts);

    if (body.action === 'invite') {
      const { data: me, error } = await asUser.rpc('my_profile');
      if (error || me?.status !== 'active' || !(me?.permissions ?? []).includes('users.manage')) return json(403, { error: 'Sem permissão.' });
      const email = String(body.email ?? '').trim().toLowerCase();
      const username = String(body.username ?? '').trim();
      const displayName = String(body.displayName ?? '').trim().slice(0, 120);
      if (!EMAIL_RE.test(email)) return json(400, { error: 'E-mail inválido.' });
      if (username && !USERNAME_RE.test(username)) return json(400, { error: 'Usuário: 3 a 40 letras, números, ponto, hífen ou sublinhado.' });
      const { data, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, { data: { display_name: displayName, username } });
      if (invErr) {
        const exists = /already|registered|exists/i.test(invErr.message);
        return json(exists ? 409 : 502, { error: exists ? 'Já existe um usuário com este e-mail.' : 'O Supabase Auth recusou o convite (verifique o SMTP).' });
      }
      await asUser.rpc('log_event', { p_action: 'user-invited', p_entity_type: 'profile', p_entity_id: data.user?.id ?? '', p_details: {} });
      return json(200, { userId: data.user?.id });
    }

    if (body.action === 'set_status') {
      const userId = String(body.userId ?? '');
      const status = body.status === 'suspended' ? 'suspended' : body.status === 'active' ? 'active' : '';
      if (!UUID_RE.test(userId) || !status) return json(400, { error: 'Parâmetros inválidos.' });
      const { error } = await asUser.rpc('admin_set_status', { p_user: userId, p_status: status }); // autoriza e muda o estado
      if (error) return json(403, { error: 'Sem permissão para alterar este usuário.' });
      const { error: banErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: status === 'suspended' ? '876000h' : 'none' });
      if (banErr) return json(502, { error: 'Estado alterado no app, mas o Auth não aplicou o bloqueio de login. Tente de novo.' });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Ação desconhecida.' });
  } catch (e) {
    console.error('gp-admin: falha', (e as { code?: string })?.code ?? 'sem-código');
    return json(500, { error: 'Falha na operação administrativa. Nada foi alterado no Auth.' });
  }
});
