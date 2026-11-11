/**
 * Who is calling, and whether they're still inside their limits.
 * Minute limits use the Workers rate-limit binding. The daily allowance is a counter kept in the edge cache:
 * cache reads and writes are free, so counting costs nothing, at the price of being per data centre and approximate.
 */

export type Tier = 'anon' | 'key' | 'admin';

export interface Client {
  tier: Tier;
  /** IP (IPv6 by /64) for anonymous callers, a key-hash prefix for key holders */
  id: string;
  perDay: number | null;
  perMinute: number | null;
}

const KEY_CACHE_MS = 5 * 60_000;
const KEY_CACHE_MAX = 1000;
const keyMemo = new Map<string, { at: number; perDay: number | null }>();

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

export function ipOf(req: Request): string {
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  if (!ip.includes(':')) return ip;
  // One IPv6 customer usually holds a whole /64; counting per address would let them rotate past the limit.
  const parts = ip.split(':');
  const full: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i > 0 && i < parts.length - 1) {
      full.push(...Array(8 - parts.filter(Boolean).length).fill('0'));
    } else if (parts[i] !== '') full.push(parts[i]);
  }
  return full.slice(0, 4).join(':') + '::/64';
}

async function keyPerDay(env: Env, keyHash: string): Promise<number | null | undefined> {
  const memo = keyMemo.get(keyHash);
  if (memo && Date.now() - memo.at < KEY_CACHE_MS) return memo.perDay ?? undefined;
  const row = await env.DB.prepare('SELECT per_day, disabled FROM api_keys WHERE key_hash = ?')
    .bind(keyHash)
    .first<{ per_day: number; disabled: number }>();
  const perDay = row && !row.disabled ? row.per_day : null;
  if (keyMemo.size >= KEY_CACHE_MAX) keyMemo.clear();
  keyMemo.set(keyHash, { at: Date.now(), perDay });
  return perDay ?? undefined;
}

export async function identify(req: Request, env: Env): Promise<Client> {
  const key = req.headers.get('X-API-Key');
  if (key && env.ADMIN_API_KEY && sameString(key, env.ADMIN_API_KEY)) {
    return { tier: 'admin', id: 'admin', perDay: null, perMinute: null };
  }
  if (key && key.length <= 200) {
    const keyHash = await sha256(key);
    const perDay = await keyPerDay(env, keyHash);
    if (perDay !== undefined) {
      return { tier: 'key', id: `key:${keyHash.slice(0, 16)}`, perDay, perMinute: Number(env.KEY_PER_MINUTE) };
    }
  }
  // An unknown key is treated as no key, as the old API did.
  return { tier: 'anon', id: ipOf(req), perDay: Number(env.ANON_PER_DAY), perMinute: Number(env.ANON_PER_MINUTE) };
}

export interface LimitResult {
  blocked: Response | null;
  headers: Record<string, string>;
}

const secondsToUtcMidnight = () => {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
};

export async function enforce(req: Request, env: Env, ctx: ExecutionContext, client: Client, origin: string): Promise<LimitResult> {
  if (client.tier === 'admin') return { blocked: null, headers: {} };

  const tooMany = (detail: string, retryAfter: number, headers: Record<string, string>) => ({
    blocked: new Response(JSON.stringify({ error: 'rate_limited', detail, retry_after: retryAfter }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter), ...headers },
    }),
    headers,
  });

  const headers: Record<string, string> = {
    'X-RateLimit-Limit-Minute': String(client.perMinute),
    'X-RateLimit-Limit-Day': String(client.perDay),
  };

  // A ceiling per IP whatever key is sent, so random keys can't be used to get around the per-IP limit.
  const ip = ipOf(req);
  if (!(await env.RL_CEILING.limit({ key: ip })).success) {
    return tooMany('Too many requests from this address. Wait a minute.', 60, headers);
  }
  const minute = client.tier === 'key' ? env.RL_KEY : env.RL_ANON;
  if (!(await minute.limit({ key: client.id })).success) {
    return tooMany(`Limit is ${client.perMinute} requests a minute. Wait a minute.`, 60, headers);
  }

  if (client.perDay !== null) {
    const day = new Date().toISOString().slice(0, 10);
    const counterKey = new Request(`${origin}/__day/${day}/${encodeURIComponent(client.id)}`);
    const cache = caches.default;
    const hit = await cache.match(counterKey);
    const used = hit ? Number(await hit.text()) || 0 : 0;
    const reset = secondsToUtcMidnight();
    headers['X-RateLimit-Remaining-Day'] = String(Math.max(0, client.perDay - used - 1));
    if (used >= client.perDay) {
      return tooMany(`Daily allowance of ${client.perDay} requests used. It resets at 00:00 UTC.`, reset, headers);
    }
    ctx.waitUntil(
      cache.put(counterKey, new Response(String(used + 1), { headers: { 'Cache-Control': `public, max-age=${reset}` } })),
    );
  }
  return { blocked: null, headers };
}
