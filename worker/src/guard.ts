/**
 * Who is calling, and whether they're still inside their limits.
 * Counters are kept in the edge cache: cache reads and writes are free, so counting costs nothing, at the price of
 * being per data centre and approximate. The Workers rate-limit binding sits in front as a burst catcher.
 */

export type Tier = 'anon' | 'admin';

export interface Client {
  tier: Tier;
  /** IP (IPv6 by /64) for anonymous callers */
  id: string;
  perDay: number | null;
  perMinute: number | null;
}

function sameString(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

function ipv6Groups(ip: string): string[] {
  const parts = ip.split(':');
  const full: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i > 0 && i < parts.length - 1) {
      full.push(...Array(8 - parts.filter(Boolean).length).fill('0'));
    } else if (parts[i] !== '') full.push(parts[i]);
  }
  return full;
}

/** One IPv6 customer usually holds a whole /64; counting per address would let them rotate past the limit. */
export function ipOf(req: Request): string {
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  return ip.includes(':') ? ipv6Groups(ip).slice(0, 4).join(':') + '::/64' : ip;
}

/** A free tunnel hands out a /48 (65,536 /64s), so IPv6 also gets a wider bucket. IPv4 stays per address. */
export function blockOf(req: Request): string {
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  return ip.includes(':') ? ipv6Groups(ip).slice(0, 3).join(':') + '::/48' : ip;
}

const tooMany = (detail: string, retryAfter: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: 'rate_limited', detail, retry_after: retryAfter }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Retry-After': String(retryAfter), ...headers },
  });

/** The admin key (the owner's quiz Workers) is unlimited; everyone else is counted per IP. Any other key is ignored. */
export function identify(req: Request, env: Env): Client & { block: string } {
  const key = req.headers.get('X-API-Key');
  if (key && env.ADMIN_API_KEY && sameString(key, env.ADMIN_API_KEY)) {
    return { tier: 'admin', id: 'admin', block: 'admin', perDay: null, perMinute: null };
  }
  return { tier: 'anon', id: ipOf(req), block: blockOf(req), perDay: Number(env.ANON_PER_DAY), perMinute: Number(env.ANON_PER_MINUTE) };
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

export async function enforce(env: Env, client: Client & { block: string }, origin: string): Promise<LimitResult> {
  // The quiz Workers need far less than this; it only bounds what a leaked admin key could do.
  if (client.tier === 'admin') {
    const ok = (await env.RL_ADMIN.limit({ key: 'admin' })).success;
    return { blocked: ok ? null : tooMany('Admin limit reached. Wait a minute.', 60), headers: {} };
  }

  const headers: Record<string, string> = {
    'X-RateLimit-Limit-Minute': String(client.perMinute),
    'X-RateLimit-Limit-Day': String(client.perDay),
  };

  // Cloudflare's limiter catches fast parallel bursts, but it counts per server: live, it let 150 one-at-a-time
  // requests a minute through a limit of 30. The edge cache is shared across a data centre, so the minute and the day
  // are counted there too (free; per data centre, and requests in flight at the same moment can count as one).
  if (!(await env.RL_ANON.limit({ key: client.id })).success) {
    return { blocked: tooMany(`Limit is ${client.perMinute} requests a minute. Wait a minute.`, 60, headers), headers };
  }
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const toNextMinute = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
  const day = new Date(now).toISOString().slice(0, 10);
  const toMidnight = secondsToUtcMidnight();
  const counters = [
    { key: `__min/${minute}/${client.id}`, limit: client.perMinute!, ttl: toNextMinute,
      detail: `Limit is ${client.perMinute} requests a minute. Wait a minute.` },
    // After the per-IP minute, so one noisy /64 can't fill its /48's bucket on its own.
    ...(client.block !== client.id
      ? [{ key: `__min/${minute}/${client.block}`, limit: Number(env.BLOCK_PER_MINUTE), ttl: toNextMinute,
          detail: 'Too many requests from this network. Wait a minute.' }]
      : []),
    { key: `__day/${day}/${client.id}`, limit: client.perDay!, ttl: toMidnight,
      detail: `Daily allowance of ${client.perDay} requests used. It resets at 00:00 UTC.` },
  ];
  const cache = caches.default;
  const requestFor = (k: string) => new Request(`${origin}/${k.split('/').map(encodeURIComponent).join('/')}`);
  const used = await Promise.all(counters.map(async (c) => {
    const hit = await cache.match(requestFor(c.key));
    return hit ? Number(await hit.text()) || 0 : 0;
  }));
  headers['X-RateLimit-Remaining-Day'] = String(Math.max(0, client.perDay! - used[used.length - 1] - 1));
  for (let i = 0; i < counters.length; i++) {
    if (used[i] >= counters[i].limit) return { blocked: tooMany(counters[i].detail, counters[i].ttl, headers), headers };
  }
  // Awaited, not deferred, to keep the read-then-write window short.
  await Promise.all(counters.map((c, i) =>
    cache.put(requestFor(c.key), new Response(String(used[i] + 1), { headers: { 'Cache-Control': `public, max-age=${c.ttl}` } }))));
  return { blocked: null, headers };
}
