// Supabase "de bolso" para testes: PGlite + stub de auth/storage + as migrations reais.
// - transport(user): mesmo contrato do SupabaseRest (selectAll / rpc / fetchKeys), executando COMO o usuário (role authenticated +
//   JWT com sub), então o RLS e as RPCs são os de produção.
// - fetchKeys imita a Edge Function gp-keys: a autorização vem de public.key_access (no banco, com o JWT do usuário); as DEKs
//   ficam num mapa em memória (a KEK não importa aqui).
// PGlite tem uma conexão só: toda operação passa por um mutex para a troca de papel não se misturar.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DataError } = require('../../src/persistence/errors');

const ROOT = path.join(__dirname, '..', '..', 'supabase');

async function createCloud() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(ROOT, 'tests', 'supabase-stub.sql'), 'utf8'));
  for (const f of fs.readdirSync(path.join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
  }
  let lock = Promise.resolve();
  const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };
  const keys = new Map(); // scope → [{ kid, version, key }]
  const objects = new Map(); // "bucket/caminho" → bytes (o conteúdo; a linha em storage.objects é o que o RLS confere)

  const asUser = (uid, fn) => serial(async () => {
    const claims = JSON.stringify({ sub: uid, role: 'authenticated', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });
    await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [uid, claims]);
    await db.exec('set role authenticated');
    try { return await fn(); } catch (e) { throw toDataError(e); } finally {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)");
    }
  });
  const asOwner = (fn) => serial(fn);

  function toDataError(e) {
    if (e instanceof DataError) return e;
    if (e.code === 'GP409') { let c = null; try { c = JSON.parse(e.detail); } catch { /* */ } return new DataError('STALE', 'STALE_DATA', { conflict: c }); }
    if (e.code === '23505') return new DataError('STALE', 'registro já existe');
    if (e.code === '42501') return new DataError('FORBIDDEN', 'sem permissão');
    return new DataError('INVALID', `recusado (${e.code})`, { pgCode: e.code, pgMessage: e.message });
  }

  // Filtro no formato do PostgREST usado pelo CloudBackend: col=eq.valor | col=is.null, separados por &.
  function where(filter) {
    if (!filter) return { sql: '', params: [] };
    const params = [];
    const parts = filter.split('&').map((f) => {
      const [col, rest] = f.split('=');
      if (!/^[a-z_]+$/.test(col)) throw new Error('coluna inválida');
      if (rest === 'is.null') return `${col} is null`;
      if (rest.startsWith('eq.')) { params.push(decodeURIComponent(rest.slice(3))); return `${col}::text = $${params.length}`; }
      throw new Error(`filtro não suportado: ${f}`);
    });
    return { sql: ` where ${parts.join(' and ')}`, params };
  }

  function transport(uid, state = { offline: false }) {
    const guard = () => { if (state.offline) throw new DataError('OFFLINE', 'sem conexão (simulado)'); };
    return {
      state,
      async selectAll(table, { order = 'id', filter = '', columns = '*' } = {}) {
        guard();
        if (!/^[a-z_]+$/.test(table) || !/^[a-z_,]+$/.test(order) || !/^(\*|[a-z_]+(,[a-z_]+)*)$/.test(columns)) throw new Error('inválido');
        const w = where(filter);
        return asUser(uid, async () => (await db.query(`select ${columns} from public.${table}${w.sql} order by ${order}`, w.params)).rows.map(normalize));
      },
      // Storage: a linha em storage.objects passa pelo RLS de produção (migration de Storage); os bytes ficam no mapa.
      async storageUpload(bucket, objectPath, buffer) {
        guard();
        const k = `${bucket}/${objectPath}`;
        if (objects.has(k)) throw new DataError('STALE', 'objeto já existe');
        await asUser(uid, () => db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, objectPath]));
        objects.set(k, Buffer.from(buffer));
      },
      async storageDownload(bucket, objectPath) {
        guard();
        const seen = await asUser(uid, async () => (await db.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, objectPath])).rows);
        if (!seen.length || !objects.has(`${bucket}/${objectPath}`)) throw new DataError('NOT_FOUND', 'objeto não encontrado');
        return Buffer.from(objects.get(`${bucket}/${objectPath}`));
      },
      async rpc(name, args) {
        guard();
        if (!/^[a-z_]+$/.test(name)) throw new Error('inválido');
        const names = Object.keys(args || {});
        const sql = `select public.${name}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
        const values = names.map((n) => (typeof args[n] === 'object' && args[n] !== null ? JSON.stringify(args[n]) : args[n]));
        return asUser(uid, async () => (await db.query(sql, values)).rows[0]?.r ?? null);
      },
      async fetchKeys(scopes, create) {
        guard();
        const access = await asUser(uid, async () => (await db.query('select * from public.key_access($1)', [scopes])).rows);
        const out = [];
        for (const a of access) {
          let list = keys.get(a.scope);
          if (list && !a.can_read) continue;
          if (!list) {
            if (!(create && a.can_create)) continue;
            list = [{ kid: crypto.randomUUID(), version: 1, key: crypto.randomBytes(32).toString('base64') }];
            keys.set(a.scope, list);
          }
          for (const k of list) out.push({ scope: a.scope, kid: k.kid, version: k.version, key: k.key, current: k.version === Math.max(...list.map((x) => x.version)) });
        }
        return { keys: out, denied: scopes.filter((s) => !out.some((k) => k.scope === s)) };
      },
    };
  }

  // jsonb volta como objeto; datas como Date → string ISO (como o PostgREST entrega)
  function normalize(row) {
    const o = {};
    for (const [k, v] of Object.entries(row)) o[k] = v instanceof Date ? v.toISOString() : v;
    return o;
  }

  async function user(name, { provision = true, permissions = ['projects.create'], role = 'USER', master = false } = {}) {
    const id = (await asOwner(() => db.query('insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id', [`${name}@exemplo.test`]))).rows[0].id;
    if (master) await asOwner(() => db.query('select gp.bootstrap_master($1)', [id]));
    return id;
  }
  async function provision(masterId, uid, { role = 'USER', permissions = ['projects.create'] } = {}) {
    await asUser(masterId, () => db.query('select public.admin_provision_user($1, $2, $3, $4, $5)', [uid, null, null, role, permissions]));
  }
  const sql = (q, params) => asOwner(async () => (await db.query(q, params)).rows);
  const sqlAs = (uid, q, params) => asUser(uid, async () => (await db.query(q, params)).rows);

  return { db, transport, user, provision, sql, sqlAs, keys, objects, close: () => db.close() };
}

module.exports = { createCloud };
