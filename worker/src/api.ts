import type { Client } from './guard';

export interface Meta {
  version: string;
  kill: boolean;
  counts: { events: number; fights: number; fighters: number };
  methods: string[];
  overview: Record<string, unknown>;
  lastUpdated: string | null;
}

/** A finished response body. Bodies are assembled from stored JSON strings so big lists never get parsed. */
export interface Out {
  status: number;
  body: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ok = (body: string): Out => ({ status: 200, body });
const json = (v: unknown): Out => ok(JSON.stringify(v));
const notFound = (what: string): Out => ({ status: 404, body: JSON.stringify({ detail: `${what} not found` }) });

const ID = /^[0-9a-f]{16}$/;

const FIGHTER_SORTS = ['wins', 'losses', 'draws', 'slpm', 'str_acc', 'sapm', 'str_def', 'td_avg', 'td_acc', 'td_def', 'sub_avg'] as const;
const LEADER_STATS = ['slpm', 'str_acc', 'sapm', 'str_def', 'td_avg', 'td_acc', 'td_def', 'sub_avg', 'wins'] as const;
const MAX_SEARCH_WORDS = 4;

function int(p: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const raw = p.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(422, `${name} must be a whole number`);
  if (n < min) throw new HttpError(422, `${name} must be at least ${min}`);
  return Math.min(n, max);
}

const str = (p: URLSearchParams, name: string): string | null => {
  const v = p.get(name)?.trim();
  return v ? v.slice(0, 100) : null;
};

/** Same normalisation as scraper/build.ts `tokens`. */
const words = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);

/** `token >= w AND token < next(w)` is an index range: every token starting with w. */
const prefixEnd = (w: string) => w.slice(0, -1) + String.fromCharCode(w.charCodeAt(w.length - 1) + 1);

function tokenQuery(table: 'name_tokens' | 'event_tokens', col: string, terms: string[]): { sql: string; binds: string[] } {
  const parts = terms.map(() => `SELECT ${col} FROM ${table} WHERE token >= ? AND token < ?`);
  return { sql: parts.join(' INTERSECT '), binds: terms.flatMap((w) => [w, prefixEnd(w)]) };
}

const listBody = (total: number, limit: number, offset: number, rows: { s: string }[]) =>
  `{"total":${total},"limit":${limit},"offset":${offset},"data":[${rows.map((r) => r.s).join(',')}]}`;

/**
 * Canonical query string: only known params, sorted, and whole numbers written one way and clamped to their
 * maximum (`limit=5e2`, `500.0` and `9999` are one cache entry). Also the cache key.
 */
export function canonical(url: URL, allowed: string[], caps: Record<string, number>): string {
  const out = new URLSearchParams();
  for (const k of [...allowed].sort()) {
    let v = url.searchParams.get(k)?.trim();
    if (!v) continue;
    if (k in caps) {
      const n = Number(v);
      if (Number.isInteger(n)) v = String(Math.min(n, caps[k]));
    }
    out.set(k, v.slice(0, 100));
  }
  return out.toString();
}

/** Largest value each whole-number parameter accepts, per route; `int()` below enforces the same numbers. */
export function paramCaps(path: string, client: Client): Record<string, number> {
  const limit = path === '/api/fighters' ? maxLimit(client, 500) : path === '/api/stats/leaders' ? 50 : 200;
  return { limit, offset: 1_000_000, year: 2100, min_wins: 1000, min_fights: 100 };
}

function maxLimit(client: Client, normal: number): number {
  return client.tier === 'admin' ? 10_000 : client.tier === 'key' ? Math.max(normal, 1000) : normal;
}

export async function listFighters(env: Env, meta: Meta, p: URLSearchParams, client: Client): Promise<Out> {
  const limit = int(p, 'limit', 50, 1, maxLimit(client, 500));
  const offset = int(p, 'offset', 0, 0, 1_000_000);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const search = str(p, 'search');
  if (search) {
    const terms = words(search);
    if (terms.length === 0) return ok(listBody(0, limit, offset, []));
    const t = tokenQuery('name_tokens', 'fighter_id', terms);
    where.push(`id IN (${t.sql})`);
    binds.push(...t.binds);
  }
  const minWins = p.get('min_wins') ? int(p, 'min_wins', 0, 0, 1000) : null;
  if (minWins) {
    where.push('wins >= ?');
    binds.push(minWins);
  }
  const stance = str(p, 'stance');
  if (stance) {
    where.push('stance = ? COLLATE NOCASE');
    binds.push(stance);
  }
  const wc = str(p, 'weight_class');
  if (wc) {
    where.push('weight_class = ? COLLATE NOCASE');
    binds.push(wc);
  }
  const sortBy = str(p, 'sort_by');
  if (sortBy && !(FIGHTER_SORTS as readonly string[]).includes(sortBy) && sortBy !== 'name') {
    throw new HttpError(422, `sort_by must be one of: name, ${FIGHTER_SORTS.join(', ')}`);
  }
  // A stat sort orders by the stat alone so SQLite walks that stat's index instead of sorting every fighter.
  const order = !sortBy || sortBy === 'name' ? 'sort_name, id' : `${sortBy} DESC`;
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = where.length
    ? ((await env.DB.prepare(`SELECT COUNT(*) n FROM fighters ${w}`).bind(...binds).first<{ n: number }>())?.n ?? 0)
    : meta.counts.fighters;
  const { results } = await env.DB.prepare(`SELECT summary s FROM fighters ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<{ s: string }>();
  return ok(listBody(total, limit, offset, results));
}

async function fighterRow(env: Env, id: string, col: 'summary' | 'doc'): Promise<string | null> {
  if (!ID.test(id)) return null;
  const row = await env.DB.prepare(`SELECT ${col} v FROM fighters WHERE id = ?`).bind(id).first<{ v: string }>();
  return row?.v ?? null;
}

export async function getFighter(env: Env, id: string): Promise<Out> {
  const doc = await fighterRow(env, id, 'doc');
  return doc ? ok(doc) : notFound('Fighter');
}

export async function getFighterFights(env: Env, id: string): Promise<Out> {
  const doc = await fighterRow(env, id, 'doc');
  if (!doc) return notFound('Fighter');
  const f = JSON.parse(doc);
  return json({ id: f.id, name: f.name, total: f.fights.length, fights: f.fights });
}

export async function getFighterStats(env: Env, id: string): Promise<Out> {
  const s = await fighterRow(env, id, 'summary');
  if (!s) return notFound('Fighter');
  const f = JSON.parse(s);
  return json({
    id: f.id,
    name: f.name,
    record: { wins: f.wins, losses: f.losses, draws: f.draws, no_contests: f.no_contests, total_fights: f.wins + f.losses + f.draws },
    striking: { slpm: f.slpm, str_acc: f.str_acc, sapm: f.sapm, str_def: f.str_def },
    grappling: { td_avg: f.td_avg, td_acc: f.td_acc, td_def: f.td_def, sub_avg: f.sub_avg },
    physical: { height: f.height, weight: f.weight, reach: f.reach, stance: f.stance, dob: f.dob },
  });
}

const COMPARE: [string, string, boolean][] = [
  ['slpm', 'Strikes Landed/Min', true],
  ['str_acc', 'Strike Accuracy', true],
  ['sapm', 'Strikes Absorbed/Min', false],
  ['str_def', 'Strike Defense', true],
  ['td_avg', 'Takedown Avg', true],
  ['td_acc', 'Takedown Accuracy', true],
  ['td_def', 'Takedown Defense', true],
  ['sub_avg', 'Submission Avg', true],
];

export async function compareFighters(env: Env, p: URLSearchParams): Promise<Out> {
  const id1 = str(p, 'fighter1');
  const id2 = str(p, 'fighter2');
  if (!id1 || !id2) throw new HttpError(422, 'fighter1 and fighter2 are required');
  const [s1, s2] = await Promise.all([fighterRow(env, id1, 'summary'), fighterRow(env, id2, 'summary')]);
  if (!s1) return { status: 404, body: JSON.stringify({ detail: `Fighter ${id1} not found` }) };
  if (!s2) return { status: 404, body: JSON.stringify({ detail: `Fighter ${id2} not found` }) };
  const f1 = JSON.parse(s1), f2 = JSON.parse(s2);
  const v = (f: Record<string, unknown>, k: string) => (f[k] ?? 0) as number;
  const advantages = { fighter1: [] as string[], fighter2: [] as string[] };
  for (const [k, label, higher] of COMPARE) {
    const a = v(f1, k), b = v(f2, k);
    if (!a || !b || a === b) continue;
    ((higher ? a > b : a < b) ? advantages.fighter1 : advantages.fighter2).push(label);
  }
  return json({
    fighter1: { id: f1.id, name: f1.name, record: f1.record },
    fighter2: { id: f2.id, name: f2.name, record: f2.record },
    stats_comparison: Object.fromEntries(COMPARE.map(([k]) => [k, { fighter1: v(f1, k), fighter2: v(f2, k) }])),
    advantages,
  });
}

export async function listEvents(env: Env, meta: Meta, p: URLSearchParams): Promise<Out> {
  const limit = int(p, 'limit', 50, 1, 200);
  const offset = int(p, 'offset', 0, 0, 1_000_000);
  const year = p.get('year') ? int(p, 'year', 0, 1993, 2100) : null;
  const search = str(p, 'search');
  if (!search && year === null) {
    // seq is dense from 1 (oldest), so newest-first paging is an index range of exactly `limit` rows.
    const top = meta.counts.events - offset;
    const { results } = await env.DB.prepare('SELECT summary s FROM events WHERE seq <= ? ORDER BY seq DESC LIMIT ?')
      .bind(top, limit)
      .all<{ s: string }>();
    return ok(listBody(meta.counts.events, limit, offset, results));
  }
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (year !== null) {
    where.push('year = ?');
    binds.push(year);
  }
  if (search) {
    const terms = words(search);
    if (terms.length === 0) return ok(listBody(0, limit, offset, []));
    const t = tokenQuery('event_tokens', 'event_id', terms);
    where.push(`id IN (${t.sql})`);
    binds.push(...t.binds);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM events ${w}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const { results } = await env.DB.prepare(`SELECT summary s FROM events ${w} ORDER BY seq DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<{ s: string }>();
  return ok(listBody(total, limit, offset, results));
}

export async function getEvent(env: Env, id: string): Promise<Out> {
  if (!ID.test(id)) return notFound('Event');
  const row = await env.DB.prepare('SELECT doc FROM events WHERE id = ?').bind(id).first<{ doc: string }>();
  return row ? ok(row.doc) : notFound('Event');
}

export async function listFights(env: Env, meta: Meta, p: URLSearchParams): Promise<Out> {
  const limit = int(p, 'limit', 50, 1, 200);
  const offset = int(p, 'offset', 0, 0, 1_000_000);
  const where: string[] = [];
  const binds: (string | number)[] = [];

  const method = str(p, 'method');
  if (method) {
    // Old API matched any part of the method; match against the known methods, then use the index.
    const m = method.toLowerCase();
    const hits = meta.methods.filter((x) => x.toLowerCase().includes(m));
    if (hits.length === 0) return ok(listBody(0, limit, offset, []));
    where.push(`method IN (${hits.map(() => '?').join(',')})`);
    binds.push(...hits);
  }
  const fighterId = str(p, 'fighter_id');
  if (fighterId) {
    if (!ID.test(fighterId)) return ok(listBody(0, limit, offset, []));
    where.push('(fighter1_id = ? OR fighter2_id = ?)');
    binds.push(fighterId, fighterId);
  }
  const search = str(p, 'search');
  if (search) {
    const terms = words(search);
    if (terms.length === 0) return ok(listBody(0, limit, offset, []));
    // D1 allows 100 bound values per query, so the matching fighters stay a subquery rather than a list of IDs.
    const t = tokenQuery('name_tokens', 'fighter_id', terms);
    where.push(`(fighter1_id IN (${t.sql}) OR fighter2_id IN (${t.sql}))`);
    binds.push(...t.binds, ...t.binds);
  }
  const eventId = str(p, 'event_id');
  if (eventId) {
    where.push('event_id = ?');
    binds.push(eventId);
  }
  const wc = str(p, 'weight_class');
  if (wc) {
    where.push('weight_class = ? COLLATE NOCASE');
    binds.push(wc);
  }

  if (where.length === 0) {
    const top = meta.counts.fights - offset;
    const { results } = await env.DB.prepare('SELECT summary s FROM fights WHERE seq <= ? ORDER BY seq DESC LIMIT ?')
      .bind(top, limit)
      .all<{ s: string }>();
    return ok(listBody(meta.counts.fights, limit, offset, results));
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM fights ${w}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const { results } = await env.DB.prepare(`SELECT summary s FROM fights ${w} ORDER BY seq DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<{ s: string }>();
  return ok(listBody(total, limit, offset, results));
}

export async function getFight(env: Env, id: string): Promise<Out> {
  if (!ID.test(id)) return notFound('Fight');
  const row = await env.DB.prepare('SELECT doc FROM fights WHERE id = ?').bind(id).first<{ doc: string }>();
  return row ? ok(row.doc) : notFound('Fight');
}

export async function statLeaders(env: Env, p: URLSearchParams): Promise<Out> {
  const stat = str(p, 'stat') ?? 'slpm';
  if (!(LEADER_STATS as readonly string[]).includes(stat)) {
    throw new HttpError(422, `stat must be one of: ${LEADER_STATS.join(', ')}`);
  }
  const limit = int(p, 'limit', 10, 1, 50);
  const minFights = int(p, 'min_fights', 5, 0, 100);
  const { results } = await env.DB.prepare(
    `SELECT id, name, wins, losses, draws, ${stat} v FROM fighters
     WHERE ${stat} IS NOT NULL AND total_fights >= ? ORDER BY ${stat} DESC LIMIT ?`,
  )
    .bind(minFights, limit)
    .all<{ id: string; name: string; wins: number; losses: number; draws: number; v: number }>();
  return json({
    stat,
    min_fights: minFights,
    leaders: results.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, value: r.v, record: `${r.wins}-${r.losses}-${r.draws}` })),
  });
}

export function overview(meta: Meta): Out {
  return json({ ...meta.overview, last_updated: meta.lastUpdated });
}
