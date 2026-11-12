import {
  HttpError, canonical, compareFighters, paramCaps, getEvent, getFight, getFighter, getFighterFights, getFighterStats,
  listEvents, listFighters, listFights, overview, statLeaders, type Meta, type Out,
} from './api';
import { enforce, identify, type Client } from './guard';
import { DOCS_HTML, openapi } from './openapi';

/** How long a cached response lives at the edge. Keys carry the data version, so a weekly load never serves stale data. */
const EDGE_TTL = 7 * 24 * 3600;
/** How long browsers and clients may reuse a response. */
const CLIENT_TTL = 300;

const META_KEYS = [
  'data_version', 'kill', 'count_events', 'count_fights', 'count_fighters', 'count_events_all', 'count_fights_all',
  'methods', 'overview', 'last_updated',
];
let metaMemo: { at: number; meta: Meta } | null = null;

/**
 * Data version, counts and the kill flag. Read from D1 at most once a minute per data centre (edge cache) and per
 * isolate (memory), so a cache hit never touches D1.
 */
async function loadMeta(env: Env, ctx: ExecutionContext, origin: string): Promise<Meta> {
  // One minute, so the watchdog's fallback kill flag and a new data version reach every data centre within ~2 minutes.
  const ttl = Number(env.META_TTL_SECONDS ?? 60);
  if (metaMemo && Date.now() - metaMemo.at < Math.min(60, ttl) * 1000) return metaMemo.meta;
  const key = new Request(`${origin}/__meta`);
  let raw: Record<string, string> | null = null;
  const hit = await caches.default.match(key);
  if (hit) raw = await hit.json();
  else {
    const marks = META_KEYS.map(() => '?').join(',');
    try {
      const { results } = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (${marks})`)
        .bind(...META_KEYS)
        .all<{ key: string; value: string }>();
      raw = Object.fromEntries(results.map((r) => [r.key, r.value]));
    } catch (e) {
      // D1 down: keep answering from the edge cache with the version we last knew.
      if (metaMemo) return metaMemo.meta;
      throw e;
    }
    ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(raw), { headers: { 'Cache-Control': `public, max-age=${ttl}` } })));
  }
  const r = raw ?? {};
  const meta: Meta = {
    version: r.data_version ?? '0',
    kill: r.kill === '1',
    counts: {
      events: Number(r.count_events ?? 0),
      fights: Number(r.count_fights ?? 0),
      fighters: Number(r.count_fighters ?? 0),
      eventsAll: Number(r.count_events_all ?? r.count_events ?? 0),
      fightsAll: Number(r.count_fights_all ?? r.count_fights ?? 0),
    },
    methods: JSON.parse(r.methods ?? '[]'),
    overview: JSON.parse(r.overview ?? '{}'),
    lastUpdated: r.last_updated ?? null,
  };
  metaMemo = { at: Date.now(), meta };
  return meta;
}

type Handler = (env: Env, meta: Meta, p: URLSearchParams, client: Client, m: RegExpMatchArray, origin: string) => Promise<Out> | Out;
interface Route {
  re: RegExp;
  params: string[];
  handle: Handler;
  /** Cheap responses built without D1 skip the edge cache. */
  static?: boolean;
}

const json = (v: unknown): Out => ({ status: 200, body: JSON.stringify(v) });

const ROUTES: Route[] = [
  { re: /^\/$/, params: [], static: true, handle: (e, _m, _p, _c, _x, origin) => json(rootInfo(e, origin)) },
  {
    re: /^\/health$/,
    params: [],
    static: true,
    handle: (_e, meta) =>
      json({
        status: 'healthy',
        fighters_loaded: meta.counts.fighters,
        events_loaded: meta.counts.events,
        fights_loaded: meta.counts.fights,
        data_version: meta.version,
        last_updated: meta.lastUpdated,
        timestamp: new Date().toISOString(),
      }),
  },
  { re: /^\/openapi\.json$/, params: [], static: true, handle: (_e, _m, _p, _c, _x, origin) => json(openapi(origin)) },
  { re: /^\/api\/fighters$/, params: ['limit', 'offset', 'search', 'min_wins', 'stance', 'weight_class', 'sort_by', 'include'], handle: (e, m, p, c) => listFighters(e, m, p, c) },
  { re: /^\/api\/fighters\/compare$/, params: ['fighter1', 'fighter2'], handle: (e, _m, p) => compareFighters(e, p) },
  { re: /^\/api\/fighters\/([^/]+)\/stats$/, params: [], handle: (e, _m, _p, _c, x) => getFighterStats(e, x[1]) },
  { re: /^\/api\/fighters\/([^/]+)\/fights$/, params: ['include'], handle: (e, _m, p, _c, x) => getFighterFights(e, x[1], p) },
  { re: /^\/api\/fighters\/([^/]+)$/, params: ['include'], handle: (e, _m, p, _c, x) => getFighter(e, x[1], p) },
  { re: /^\/api\/events$/, params: ['limit', 'offset', 'year', 'search', 'include'], handle: (e, m, p) => listEvents(e, m, p) },
  { re: /^\/api\/events\/([^/]+)$/, params: [], handle: (e, _m, _p, _c, x) => getEvent(e, x[1]) },
  { re: /^\/api\/fights$/, params: ['limit', 'offset', 'method', 'search', 'fighter_id', 'event_id', 'weight_class', 'include'], handle: (e, m, p) => listFights(e, m, p) },
  { re: /^\/api\/fights\/([^/]+)$/, params: [], handle: (e, _m, _p, _c, x) => getFight(e, x[1]) },
  { re: /^\/api\/stats\/leaders$/, params: ['stat', 'limit', 'min_fights'], handle: (e, _m, p) => statLeaders(e, p) },
  { re: /^\/api\/stats\/overview$/, params: [], handle: (_e, m) => overview(m) },
];

function rootInfo(env: Env, origin: string) {
  return {
    message: 'UFC Stats API',
    version: '2.0.0',
    docs: `${origin}/docs`,
    source: 'ufcstats.com, updated every Sunday after UFC cards',
    rate_limit: {
      limit: `${Number(env.ANON_PER_DAY).toLocaleString('en-US')} requests/day per IP`,
      burst: `${env.ANON_PER_MINUTE} requests/minute per IP`,
    },
    endpoints: {
      fighters: '/api/fighters',
      fighter_detail: '/api/fighters/{id}',
      fighter_stats: '/api/fighters/{id}/stats',
      fighter_fights: '/api/fighters/{id}/fights',
      compare: '/api/fighters/compare?fighter1=ID&fighter2=ID',
      events: '/api/events',
      event_detail: '/api/events/{id}',
      fights: '/api/fights',
      fight_detail: '/api/fights/{id}',
      stat_leaders: '/api/stats/leaders',
      overview: '/api/stats/overview',
    },
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function respond(req: Request, status: number, body: string | null, headers: Record<string, string>): Response {
  return new Response(req.method === 'HEAD' ? null : body, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

const errorBody = (detail: string) => JSON.stringify({ detail });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = url.origin;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return respond(req, 405, errorBody('Method not allowed'), { Allow: 'GET, HEAD, OPTIONS' });
    }

    try {
      const meta = await loadMeta(env, ctx, origin);
      if (meta.kill) {
        return respond(req, 503, errorBody('The API is paused. Try again later.'), { 'Retry-After': '3600' });
      }

      const client = identify(req, env);
      const limit = await enforce(env, client, origin);
      if (limit.blocked) return limit.blocked;
      const base = { ...limit.headers, 'X-Data-Version': meta.version };

      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/docs') {
        return new Response(req.method === 'HEAD' ? null : DOCS_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${CLIENT_TTL}`, ...CORS },
        });
      }
      let match: RegExpMatchArray | null = null;
      const route = ROUTES.find((r) => (match = path.match(r.re)));
      if (!route || !match) return respond(req, 404, errorBody('Not found. See /docs.'), base);

      if (route.static) {
        const out = await route.handle(env, meta, url.searchParams, client, match, origin);
        return respond(req, out.status, out.body, { ...base, 'Cache-Control': `public, max-age=${CLIENT_TTL}` });
      }

      // The tier is part of the key because the largest allowed `limit` depends on it.
      const query = canonical(url, route.params, paramCaps(path, client));
      const cacheKey = new Request(`${origin}/__c/${meta.version}/${client.tier === 'anon' ? 'a' : client.tier}${path}?${query}`);
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        return respond(req, hit.status, await hit.text(), { ...base, 'Cache-Control': `public, max-age=${CLIENT_TTL}`, 'X-Cache': 'HIT' });
      }

      const params = new URLSearchParams(query);
      const out = await route.handle(env, meta, params, client, match, origin);
      if (out.status === 200 || out.status === 404) {
        ctx.waitUntil(
          caches.default.put(cacheKey, new Response(out.body, {
            status: out.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${EDGE_TTL}` },
          })),
        );
      }
      return respond(req, out.status, out.body, { ...base, 'Cache-Control': `public, max-age=${CLIENT_TTL}`, 'X-Cache': 'MISS' });
    } catch (e) {
      if (e instanceof HttpError) return respond(req, e.status, errorBody(e.message), {});
      console.error('request failed', url.pathname, (e as Error).stack ?? e);
      return respond(req, 500, errorBody('Internal error'), {});
    }
  },
} satisfies ExportedHandler<Env>;
