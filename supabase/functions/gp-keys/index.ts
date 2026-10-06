// Edge Function gp-keys — entrega as chaves de dados (DEKs) a quem o BANCO autoriza.
//
// Envelope encryption:  KEK (secret GP_KEK_V<n>, só aqui)  ─embrulha→  DEK por escopo (tabela data_keys)  ─cifra→  dados.
// Fluxo de uma chamada:
//   1. JWT do usuário validado no Auth (getUser).
//   2. Autorização decidida no Postgres pela RPC public.key_access, executada COM O JWT DO USUÁRIO (mesmas regras do RLS).
//   3. DEKs lidas/criadas com service role, desembrulhadas aqui e devolvidas por TLS. A KEK nunca sai desta função.
// Falha fechada: qualquer erro → nada é entregue. Nunca registra chave, JWT ou conteúdo em log.
//
// POST { "scopes": ["global", "project:<id>", ...], "create": false }
//   → 200 { "keys": [{ "scope", "kid", "version", "key" (base64, 32 bytes), "current" }], "denied": [scope...] }
// POST { "action": "rewrap", "toKekVersion": 2 }   (só MASTER; rotação da KEK, re-embrulha todas as DEKs sem tocar nos dados)
//
// Secrets (Supabase → Edge Functions → Secrets): GP_KEK_V1 (base64 de 32 bytes aleatórios), GP_KEK_CURRENT (ex.: "1").
// SUPABASE_URL e as chaves do projeto são fornecidas automaticamente pelo runtime.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SCOPE_RE = /^(global|project:[A-Za-z0-9_-]{1,64})$/;
const MAX_SCOPES = 200;
const te = new TextEncoder();

const b64 = (u8: Uint8Array) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function envOr(names: string[], jsonName?: string): string {
  for (const n of names) { const v = Deno.env.get(n); if (v) return v; }
  if (jsonName) { try { const m = JSON.parse(Deno.env.get(jsonName) ?? '{}'); if (m.default) return m.default; } catch { /* ignora */ } }
  throw new Error('configuração ausente');
}
const SUPABASE_URL = () => envOr(['SUPABASE_URL']);
const SERVICE_KEY = () => envOr(['SUPABASE_SERVICE_ROLE_KEY'], 'SUPABASE_SECRET_KEYS');
const PUBLIC_KEY = () => envOr(['SUPABASE_ANON_KEY'], 'SUPABASE_PUBLISHABLE_KEYS');
const currentKekVersion = () => { const v = Number(Deno.env.get('GP_KEK_CURRENT') ?? '1'); if (!Number.isInteger(v) || v < 1) throw new Error('GP_KEK_CURRENT inválido'); return v; };

async function kek(version: number): Promise<CryptoKey> {
  const raw = Deno.env.get(`GP_KEK_V${version}`);
  if (!raw) throw new Error('KEK indisponível');
  const bytes = unb64(raw.trim());
  if (bytes.length !== 32) throw new Error('KEK com tamanho inválido');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
// AAD liga a DEK embrulhada ao seu escopo e versão: copiar wrapped_key para outra linha faz o unwrap falhar.
const aad = (scope: string, version: number) => te.encode(`gp:dek:v1:${scope}:${version}`);

async function wrap(dek: Uint8Array, scope: string, version: number, kekVersion: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(scope, version) }, await kek(kekVersion), dek));
  return `${b64(iv)}.${b64(ct)}`;
}
async function unwrap(wrapped: string, scope: string, version: number, kekVersion: number): Promise<Uint8Array> {
  const [iv, ct] = wrapped.split('.').map(unb64);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(scope, version) }, await kek(kekVersion), ct));
}

type KeyRow = { id: string; scope: string; version: number; kek_version: number; wrapped_key: string; retired_at: string | null };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Método não permitido.' });
  const authz = req.headers.get('Authorization') ?? '';
  const jwt = authz.match(/^Bearer\s+(\S+)$/)?.[1];
  if (!jwt) return json(401, { error: 'Não autenticado.' });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'JSON inválido.' }); }

  try {
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    const asUser = createClient(SUPABASE_URL(), PUBLIC_KEY(), { ...opts, global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: who, error: whoErr } = await asUser.auth.getUser(jwt);
    if (whoErr || !who?.user) return json(401, { error: 'Sessão inválida ou expirada.' });
    const admin = createClient(SUPABASE_URL(), SERVICE_KEY(), opts);

    // ---------- rotação da KEK (MASTER) ----------
    if (body.action === 'rewrap') {
      const { data: me, error } = await asUser.rpc('my_profile');
      if (error || me?.role !== 'MASTER' || me?.status !== 'active') return json(403, { error: 'Sem permissão.' });
      const to = Number(body.toKekVersion);
      if (!Number.isInteger(to) || to < 1) return json(400, { error: 'toKekVersion inválido.' });
      await kek(to); // falha cedo se o secret da nova versão não existir
      const { data: rows, error: rErr } = await admin.from('data_keys').select('id, scope, version, kek_version, wrapped_key').neq('kek_version', to);
      if (rErr) throw rErr;
      let n = 0;
      for (const r of (rows ?? []) as KeyRow[]) {
        const dek = await unwrap(r.wrapped_key, r.scope, r.version, r.kek_version);
        const wrapped = await wrap(dek, r.scope, r.version, to);
        dek.fill(0);
        const { error: uErr } = await admin.from('data_keys').update({ wrapped_key: wrapped, kek_version: to }).eq('id', r.id).eq('kek_version', r.kek_version);
        if (uErr) throw uErr;
        n++;
      }
      await asUser.rpc('log_event', { p_action: 'kek-rewrap', p_entity_type: 'data_keys', p_details: { count: n, toKekVersion: to } });
      return json(200, { rewrapped: n });
    }

    // ---------- entrega / criação de DEKs ----------
    const scopes = [...new Set(Array.isArray(body.scopes) ? body.scopes : [])].filter((s): s is string => typeof s === 'string');
    if (!scopes.length || scopes.length > MAX_SCOPES || scopes.some((s) => !SCOPE_RE.test(s))) {
      return json(400, { error: `Informe de 1 a ${MAX_SCOPES} escopos válidos.` });
    }
    const { data: access, error: aErr } = await asUser.rpc('key_access', { p_scopes: scopes });
    if (aErr) return json(403, { error: 'Sem permissão.' }); // inativo/pendente/suspenso ou falha: nega
    const rules = new Map<string, { read: boolean; create: boolean }>();
    for (const a of access ?? []) rules.set(a.scope, { read: !!a.can_read, create: !!a.can_create });

    const allowed = scopes.filter((s) => rules.get(s)?.read || (body.create === true && rules.get(s)?.create));
    const denied = scopes.filter((s) => !allowed.includes(s));
    const out: { scope: string; kid: string; version: number; key: string; current: boolean }[] = [];
    if (allowed.length) {
      const { data: rows, error: kErr } = await admin.from('data_keys')
        .select('id, scope, version, kek_version, wrapped_key, retired_at').in('scope', allowed).order('version');
      if (kErr) throw kErr;
      const byScope = new Map<string, KeyRow[]>();
      for (const r of (rows ?? []) as KeyRow[]) byScope.set(r.scope, [...(byScope.get(r.scope) ?? []), r]);

      for (const scope of allowed) {
        let list = byScope.get(scope) ?? [];
        // Chave já existente só é entregue a quem pode LER o escopo (direito de criar não dá acesso a chave alheia).
        if (list.length && !rules.get(scope)?.read) { denied.push(scope); continue; }
        if (!list.length) {
          if (!(body.create === true && rules.get(scope)?.create)) { denied.push(scope); continue; }
          const dek = crypto.getRandomValues(new Uint8Array(32));
          const kv = currentKekVersion();
          const { data: ins, error: iErr } = await admin.from('data_keys')
            .insert({ scope, version: 1, kek_version: kv, wrapped_key: await wrap(dek, scope, 1, kv), created_by: who.user.id })
            .select('id, scope, version, kek_version, wrapped_key, retired_at');
          dek.fill(0);
          if (iErr) { // corrida: outro cliente criou a mesma chave ao mesmo tempo → relê
            const { data: again, error: gErr } = await admin.from('data_keys').select('id, scope, version, kek_version, wrapped_key, retired_at').eq('scope', scope);
            if (gErr || !again?.length) throw iErr;
            if (!rules.get(scope)?.read) { denied.push(scope); continue; } // a chave é de outra pessoa
            list = again as KeyRow[];
          } else {
            list = ins as KeyRow[];
            await asUser.rpc('log_event', { p_action: 'key-created', p_entity_type: 'data_keys', p_entity_id: scope, p_details: {} });
          }
        }
        // Quem só pode CRIAR (projeto ainda inexistente) recebe a chave recém-criada; leitura das versões exige can_read.
        const current = list.filter((r) => !r.retired_at).reduce((a, b) => (b.version > a.version ? b : a), list[0]);
        for (const r of list) {
          const dek = await unwrap(r.wrapped_key, r.scope, r.version, r.kek_version);
          out.push({ scope, kid: r.id, version: r.version, key: b64(dek), current: r.id === current.id });
          dek.fill(0);
        }
      }
    }
    return json(200, { keys: out, denied });
  } catch (e) {
    console.error('gp-keys: falha', (e as { code?: string })?.code ?? 'sem-código'); // nunca o conteúdo
    return json(500, { error: 'Não foi possível obter as chaves. Nada foi entregue.' });
  }
});
