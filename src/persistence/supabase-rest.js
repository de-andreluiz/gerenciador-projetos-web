// Transporte HTTP para o Supabase (PostgREST + Edge Function gp-keys), sem dependências.
// Único lugar do app que fala com o Supabase para dados. Nunca registra tokens, chaves ou conteúdo.
// Usa a PUBLISHABLE key (apikey) + o JWT do usuário; a service role nunca existe no desktop.
'use strict';
const { DataError } = require('./errors');

const TABLE_RE = /^[a-z_]{1,63}$/;
const PAGE = 1000; // limite padrão de linhas por resposta do PostgREST no Supabase

// Código do Postgres/PostgREST → erro normalizado. Mensagem técnica fica só em `detail` (sem dados), nunca na tela.
function mapError(status, body) {
  const code = body?.code || '';
  if (code === 'GP409') return new DataError('STALE', 'STALE_DATA', { conflict: safeJson(body?.details) });
  if (code === '23505') return new DataError('STALE', 'registro já existe');
  if (code === '42501' || status === 403) return new DataError('FORBIDDEN', 'sem permissão');
  if (status === 401 || /^PGRST30[0-3]$/.test(code)) return new DataError('AUTH', 'sessão inválida');
  if (status >= 500 || status === 0) return new DataError('OFFLINE', `servidor indisponível (${status})`);
  return new DataError('INVALID', `recusado (${code || status})`, { pgCode: code });
}
function safeJson(s) { try { return typeof s === 'string' ? JSON.parse(s) : s || null; } catch { return null; } }

class SupabaseRest {
  constructor({ url, publishableKey, getAccessToken, timeoutMs = 20000, fetchImpl = globalThis.fetch }) {
    if (!require('../config').SUPABASE_URL_RE.test(String(url || '').replace(/\/$/, ''))) throw new Error('GP_SUPABASE_URL inválida (esperado https://<ref>.supabase.co).');
    if (!publishableKey) throw new Error('GP_SUPABASE_PUBLISHABLE_KEY ausente.');
    this.url = url.replace(/\/$/, '');
    this.key = publishableKey;
    this.getAccessToken = getAccessToken;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const token = await this.getAccessToken();
    if (!token) throw new DataError('AUTH', 'sem sessão');
    let res;
    try {
      res = await this.fetch(this.url + path, {
        method,
        headers: { apikey: this.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new DataError('OFFLINE', 'sem conexão'); // rede, DNS, timeout: nada foi gravado
    }
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) throw Object.assign(mapError(res.status, json), { status: res.status });
    return json;
  }

  // Todas as linhas visíveis (RLS) de uma tabela, paginando. `filter` = query string do PostgREST já montada pelo backend.
  async selectAll(table, { order = 'id', filter = '', columns = '*' } = {}) {
    if (!TABLE_RE.test(table)) throw new Error('tabela inválida');
    if (columns !== '*' && !/^[a-z_]+(,[a-z_]+)*$/.test(columns)) throw new Error('colunas inválidas');
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.request('GET', `/rest/v1/${table}?select=${columns}&order=${encodeURIComponent(order)}&limit=${PAGE}&offset=${offset}${filter ? `&${filter}` : ''}`);
      out.push(...(page || []));
      if (!page || page.length < PAGE) return out;
    }
  }

  rpc(name, args) {
    if (!TABLE_RE.test(name)) throw new Error('rpc inválida');
    return this.request('POST', `/rest/v1/rpc/${name}`, args || {});
  }

  // ---------- Storage (objetos já cifrados pelo app; o RLS do Storage decide quem lê/grava) ----------
  _objectUrl(kind, bucket, objectPath) {
    if (!/^[a-z-]{1,40}$/.test(bucket) || !/^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64})?$/.test(objectPath)) throw new Error('objeto inválido');
    return `${this.url}/storage/v1/object/${kind}${bucket}/${objectPath}`;
  }

  async _raw(method, url, { body, headers = {} } = {}) {
    const token = await this.getAccessToken();
    if (!token) throw new DataError('AUTH', 'sem sessão');
    let res;
    try {
      res = await this.fetch(url, { method, headers: { apikey: this.key, Authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120000)) });
    } catch {
      throw new DataError('OFFLINE', 'sem conexão');
    }
    if (res.ok) return res;
    const json = safeJson(await res.text());
    const st = String(json?.statusCode || res.status);
    const msg = `${json?.error || ''} ${json?.message || ''}`;
    if (st === '404' || /not.?found/i.test(msg)) throw new DataError('NOT_FOUND', 'objeto não encontrado');
    if (st === '409' || /duplicate|already exists/i.test(msg)) throw new DataError('STALE', 'objeto já existe');
    if (st === '403' || /row-level security|unauthorized/i.test(msg)) throw new DataError('FORBIDDEN', 'sem permissão');
    if (st === '413' || /payload too large|maximum allowed size/i.test(msg)) throw new DataError('TOO_LARGE', 'arquivo grande demais');
    throw mapError(res.status, json);
  }

  // Envia um objeto novo (nunca sobrescreve: x-upsert false).
  async storageUpload(bucket, objectPath, buffer) {
    await this._raw('POST', this._objectUrl('', bucket, objectPath), { body: buffer, headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' } });
  }

  async storageDownload(bucket, objectPath) {
    const res = await this._raw('GET', this._objectUrl('authenticated/', bucket, objectPath));
    return Buffer.from(await res.arrayBuffer());
  }

  // DEKs autorizadas pelo banco (Edge Function gp-keys). Resposta: { keys: [{scope, kid, version, key, current}], denied: [] }.
  // 500 da própria função (ex.: KEK ausente/trocada) não é "sem conexão": vira CRYPTO, para não mascarar problema de chaves.
  async fetchKeys(scopes, create = false) {
    try {
      return await this.request('POST', '/functions/v1/gp-keys', { scopes, create });
    } catch (e) {
      if (e.code === 'OFFLINE' && e.status === 500) throw new DataError('CRYPTO', 'falha ao obter as chaves de dados (gp-keys)');
      throw e;
    }
  }
}

module.exports = { SupabaseRest, mapError };
