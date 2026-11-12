/**
 * End-to-end check of the Worker against `wrangler dev` and the local D1 (PRD US-005 and US-006).
 *   pnpm dev            (worker/.dev.vars: ADMIN_API_KEY=dev-admin-key, META_TTL_SECONDS=2)
 *   E2E_BASE=http://127.0.0.1:8799 pnpm e2e
 */
import assert from 'node:assert/strict';
import { runWrangler } from '../scraper/sync.ts';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8799';
const ADMIN = process.env.E2E_ADMIN_KEY ?? 'dev-admin-key';
let ipCounter = 10;
/** Each check gets its own caller address so the per-IP limits of one check don't spill into the next. */
const freshIp = () => `198.51.100.${ipCounter++}`;

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, { headers: { 'CF-Connecting-IP': freshIp(), ...headers } });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

const results: { name: string; ok: boolean; err?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, err: (e as Error).message });
  }
}

const d1 = (sql: string) => runWrangler(['d1', 'execute', 'ufc-stats', '--local', '--json', '--command', sql]);

const FIGHTER_KEYS = ['id', 'name', 'record', 'wins', 'losses', 'draws', 'height', 'weight', 'reach', 'stance',
  'slpm', 'str_acc', 'sapm', 'str_def', 'td_avg', 'td_acc', 'td_def', 'sub_avg', 'is_champion', 'fights'];

const events = (await get('/api/events?limit=200')).body;
const anEvent = events.data[0];
const eventDoc = (await get(`/api/events/${anEvent.id}`)).body;
const aFight = eventDoc.fights[0];
const aFighterId = aFight.fighter1.id;
const otherFighterId = aFight.fighter2.id;
const aFighterName: string = aFight.fighter1.name;

await check('GET / lists the endpoints', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.ok(r.body.endpoints.fighters);
});

await check('GET /health reports loaded counts', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'healthy');
  assert.ok(r.body.fighters_loaded > 0 && r.body.events_loaded > 0 && r.body.fights_loaded > 0);
});

await check('GET /docs serves Swagger UI, /openapi.json lists every route', async () => {
  const docs = await fetch(BASE + '/docs');
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /swagger-ui/);
  const spec = (await get('/openapi.json')).body;
  for (const p of ['/api/fighters', '/api/fighters/compare', '/api/fighters/{id}', '/api/fighters/{id}/stats',
    '/api/fighters/{id}/fights', '/api/events', '/api/events/{id}', '/api/fights', '/api/fights/{id}',
    '/api/stats/leaders', '/api/stats/overview', '/health']) {
    assert.ok(spec.paths[p], `openapi missing ${p}`);
  }
});

await check('GET /api/fighters keeps the old list shape and fields', async () => {
  const r = await get('/api/fighters?limit=5');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['data', 'limit', 'offset', 'total']);
  assert.equal(r.body.data.length, 5);
  for (const k of FIGHTER_KEYS) assert.ok(k in r.body.data[0], `fighter list item missing ${k}`);
  const withFights = r.body.data.find((f: any) => f.fights.length);
  assert.ok(withFights, 'some fighter has fights');
  assert.ok(['win', 'loss', 'draw', 'nc'].includes(withFights.fights[0].result));
  assert.ok(typeof withFights.fights[0].method === 'string');
});

await check('GET /api/fighters search, stance, min_wins, sort_by, weight_class', async () => {
  const last = aFighterName.split(' ').pop()!.toLowerCase();
  const s = await get(`/api/fighters?search=${encodeURIComponent(last.slice(0, 4))}`);
  assert.ok(s.body.data.some((f: any) => f.id === aFighterId), `search ${last.slice(0, 4)} finds ${aFighterName}`);
  const st = await get('/api/fighters?stance=orthodox&limit=500');
  assert.ok(st.body.total > 0 && st.body.data.every((f: any) => f.stance === 'Orthodox'));
  const mw = await get('/api/fighters?min_wins=20&limit=500');
  assert.ok(mw.body.data.every((f: any) => f.wins >= 20));
  const sorted = await get('/api/fighters?sort_by=slpm&limit=20');
  const v = sorted.body.data.map((f: any) => f.slpm ?? -1);
  assert.deepEqual(v, [...v].sort((a: number, b: number) => b - a));
  const wc = await get('/api/fighters?weight_class=heavyweight&limit=500');
  assert.ok(wc.body.total > 0 && wc.body.data.every((f: any) => f.weight_class === 'Heavyweight'));
  const bad = await get('/api/fighters?sort_by=nope');
  assert.equal(bad.status, 422);
});

await check('GET /api/fighters/{id}, /stats, /fights', async () => {
  const f = await get(`/api/fighters/${aFighterId}`);
  assert.equal(f.status, 200);
  for (const k of FIGHTER_KEYS) assert.ok(k in f.body, `fighter detail missing ${k}`);
  assert.ok(f.body.fights.some((x: any) => x.fight_id === aFight.id));
  const s = await get(`/api/fighters/${aFighterId}/stats`);
  assert.deepEqual(Object.keys(s.body), ['id', 'name', 'record', 'striking', 'grappling', 'physical']);
  const h = await get(`/api/fighters/${aFighterId}/fights`);
  assert.equal(h.body.total, h.body.fights.length);
  assert.equal((await get('/api/fighters/0000000000000000')).status, 404);
  assert.equal((await get('/api/fighters/not-an-id')).status, 404);
});

await check('GET /api/fighters/compare', async () => {
  const r = await get(`/api/fighters/compare?fighter1=${aFighterId}&fighter2=${otherFighterId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['fighter1', 'fighter2', 'stats_comparison', 'advantages']);
  assert.equal(Object.keys(r.body.stats_comparison).length, 8);
  assert.equal((await get(`/api/fighters/compare?fighter1=${aFighterId}`)).status, 422);
});

await check('GET /api/events paging, year, search, detail', async () => {
  assert.equal(events.data.length, Math.min(events.total, 200), 'a full page');
  const dates = events.data.map((e: any) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  const page2 = await get('/api/events?limit=1&offset=1');
  assert.equal(page2.body.data[0].id, events.data[1].id);
  const year = anEvent.date.slice(0, 4);
  const y = await get(`/api/events?year=${year}`);
  assert.ok(y.body.data.every((e: any) => e.date.startsWith(year)));
  const word = anEvent.name.split(' ').pop().toLowerCase();
  const s = await get(`/api/events?search=${encodeURIComponent(word)}`);
  assert.ok(s.body.data.some((e: any) => e.id === anEvent.id));
  assert.equal(eventDoc.fights.length, anEvent.fight_count);
  assert.equal(eventDoc.fights[0].bout_order, 1);
});

await check('GET /api/fights keeps totals.fighter1.fighter and method; filters work', async () => {
  const r = await get('/api/fights?limit=10');
  assert.equal(r.status, 200);
  const f = r.body.data[0];
  assert.ok(typeof f.method === 'string');
  assert.ok(typeof f.totals.fighter1.fighter === 'string');
  const page2 = await get('/api/fights?limit=1&offset=1');
  assert.equal(page2.body.data[0].id, r.body.data[1].id);
  const ko = await get('/api/fights?method=ko&limit=200');
  assert.ok(ko.body.total > 0 && ko.body.data.every((x: any) => /ko/i.test(x.method)));
  const byFighter = await get(`/api/fights?fighter_id=${aFighterId}`);
  assert.ok(byFighter.body.data.some((x: any) => x.id === aFight.id));
  const search = await get(`/api/fights?search=${encodeURIComponent(aFighterName.split(' ').pop()!)}`);
  assert.ok(search.body.data.some((x: any) => x.id === aFight.id));
  const byEvent = await get(`/api/fights?event_id=${anEvent.id}&limit=200`);
  assert.equal(byEvent.body.total, anEvent.fight_count);
});

await check('GET /api/fights/{id} has per-round stats', async () => {
  const r = await get(`/api/fights/${aFight.id}`);
  assert.equal(r.status, 200);
  for (const k of ['method', 'round', 'time', 'time_format', 'referee', 'details', 'totals', 'rounds', 'fighter1', 'fighter2', 'bonuses']) {
    assert.ok(k in r.body, `fight detail missing ${k}`);
  }
  assert.equal(r.body.rounds.length, r.body.round, 'one stats row per round fought');
  const line = r.body.rounds[0].fighter1;
  for (const k of ['kd', 'sig_str', 'total_str', 'td', 'sub_att', 'rev', 'ctrl', 'head', 'body', 'leg', 'distance', 'clinch', 'ground']) {
    assert.ok(k in line, `round line missing ${k}`);
  }
});

await check('GET /api/stats/leaders and /overview', async () => {
  const l = await get('/api/stats/leaders?stat=slpm&min_fights=1&limit=5');
  assert.equal(l.status, 200);
  assert.equal(l.body.leaders[0].rank, 1);
  const v = l.body.leaders.map((x: any) => x.value);
  assert.deepEqual(v, [...v].sort((a: number, b: number) => b - a));
  assert.equal((await get('/api/stats/leaders?stat=drop_table')).status, 422);
  const o = await get('/api/stats/overview');
  for (const k of ['total_fighters', 'total_events', 'total_fights', 'champions', 'stances', 'last_updated']) {
    assert.ok(k in o.body, `overview missing ${k}`);
  }
});

await check('Lists are UFC-only by default; include=all adds the events ufcstats leaves off its list', async () => {
  const o = (await get('/api/stats/overview')).body;
  assert.ok(o.other_events > 0 && o.other_fights > 0, 'the local data has events found through fighter pages');
  const ev = await get('/api/events?limit=200');
  assert.equal(ev.body.total, o.total_events);
  assert.ok(ev.body.data.every((e: any) => e.ufc === true));
  const evAll = await get('/api/events?limit=200&include=all');
  assert.equal(evAll.body.total, o.total_events + o.other_events);
  const dates = evAll.body.data.map((e: any) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  const yearAll = await get(`/api/events?year=2005&include=all&limit=200`);
  const year = await get(`/api/events?year=2005&limit=200`);
  assert.ok(yearAll.body.total > year.body.total && year.body.data.every((e: any) => e.ufc));
  const fights = await get('/api/fights?limit=200');
  assert.equal(fights.body.total, o.total_fights);
  assert.ok(fights.body.data.every((f: any) => f.ufc === true));
  const all = await get('/api/fights?limit=200&include=all&offset=0');
  assert.equal(all.body.total, o.total_fights + o.other_fights);
  // An event ufcstats leaves off its list, reached through its fights.
  const other = (await get(`/api/events?include=all&limit=200&offset=${o.total_events + o.other_events - 200}`)).body.data
    .find((e: any) => !e.ufc);
  assert.ok(other, 'paging to the oldest events finds one off the UFC list');
  const card = (await get(`/api/events/${other.id}`)).body;
  assert.equal(card.ufc, false);
  const fight = (await get(`/api/fights/${card.fights[0].id}`)).body;
  assert.equal(fight.ufc, false);
  const who = fight.fighter1.id;
  const plain = (await get(`/api/fighters/${who}`)).body;
  assert.ok(!plain.fights.some((x: any) => x.fight_id === fight.id), 'default history leaves it out');
  const full = (await get(`/api/fighters/${who}?include=all`)).body;
  assert.ok(full.fights.some((x: any) => x.fight_id === fight.id && x.ufc === false), 'include=all has it');
  const hist = (await get(`/api/fighters/${who}/fights?include=all`)).body;
  assert.equal(hist.total, full.fights.length);
  const byFighter = await get(`/api/fights?fighter_id=${who}&limit=200`);
  assert.ok(!byFighter.body.data.some((x: any) => x.id === fight.id));
  const byFighterAll = await get(`/api/fights?fighter_id=${who}&limit=200&include=all`);
  assert.ok(byFighterAll.body.data.some((x: any) => x.id === fight.id));
  assert.equal((await get('/api/events?include=everything')).status, 422);
});

await check('A repeated request is served from the edge cache', async () => {
  // Offsets are capped at 20,000, so stay under it for a key no earlier run has cached.
  const path = `/api/fights?limit=3&offset=${Date.now() % 19_000}&method=dec`;
  const first = await get(path);
  assert.equal(first.headers.get('x-cache'), 'MISS');
  // The cache write finishes after the response; locally it can take a moment.
  let second = await get(path);
  for (let i = 0; i < 6 && second.headers.get('x-cache') !== 'HIT'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    second = await get(path);
  }
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.deepEqual(second.body, first.body);
});

await check('Anonymous callers get 429 with Retry-After past 30 a minute', async () => {
  const ip = '203.0.113.77';
  let last = 0;
  let retryAfter: string | null = null;
  for (let i = 0; i < 35; i++) {
    const r = await get('/api/stats/overview', { 'CF-Connecting-IP': ip });
    last = r.status;
    retryAfter = r.headers.get('retry-after');
    if (last === 429) break;
  }
  assert.equal(last, 429);
  assert.equal(retryAfter, '60');
});

await check('Rotating /64s inside one IPv6 /48 hits the network limit; offsets past the end read nothing', async () => {
  let last = 0;
  for (let i = 0; i < 125 && last !== 429; i++) {
    // 25 requests from each of five /64s: under the per-/64 limit, over the /48 one.
    const ip = `2001:db8:77:${Math.floor(i / 25)}::${(i % 25) + 1}`;
    last = (await get('/api/stats/overview', { 'CF-Connecting-IP': ip })).status;
  }
  assert.equal(last, 429);
  const far = await get('/api/fights?offset=999999&limit=5&method=dec');
  assert.equal(far.status, 200);
  assert.equal(far.body.offset, 20000, 'offset is clamped');
  assert.equal(far.body.data.length, 0);
});

await check('Admin key lifts the limits and the page-size cap; unknown keys count as anonymous', async () => {
  const admin = await get('/api/fighters?limit=10000', { 'X-API-Key': ADMIN });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.limit, 10000);
  assert.equal(admin.headers.get('x-ratelimit-limit-minute'), null);
  const unknown = await get('/api/fighters?limit=10000', { 'X-API-Key': 'not-a-real-key' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.limit, 500);
  assert.equal(unknown.headers.get('x-ratelimit-limit-minute'), '30');
});

await check('A new data version rolls the cache over', async () => {
  const path = '/api/stats/overview';
  const before = await get(path);
  const old = before.headers.get('x-data-version')!;
  const bumped = `e2e${Date.now().toString(36)}`;
  d1(`UPDATE meta SET value = '${bumped}' WHERE key = 'data_version'`);
  try {
    await new Promise((r) => setTimeout(r, 3500));
    const after = await get(path);
    assert.equal(after.headers.get('x-data-version'), bumped);
    assert.equal(after.headers.get('x-cache'), 'MISS');
  } finally {
    d1(`UPDATE meta SET value = '${old}' WHERE key = 'data_version'`);
  }
});

await check('Request-path queries use indexes (no full table scans)', async () => {
  const plans = [
    'SELECT summary FROM events WHERE ufc_seq BETWEEN 1 AND 10 ORDER BY ufc_seq DESC LIMIT 5',
    'SELECT summary FROM events WHERE seq BETWEEN 1 AND 10 ORDER BY seq DESC LIMIT 5',
    'SELECT summary FROM events WHERE ufc = 1 AND year = 2005 ORDER BY seq DESC LIMIT 5',
    'SELECT summary FROM fights WHERE ufc_seq BETWEEN 1 AND 10 ORDER BY ufc_seq DESC LIMIT 5',
    'SELECT summary FROM fights WHERE seq BETWEEN 1 AND 10 ORDER BY seq DESC LIMIT 5',
    "SELECT summary FROM fights WHERE method IN ('KO/TKO') AND ufc = 1 ORDER BY seq DESC LIMIT 5 OFFSET 5",
    "SELECT summary FROM fights WHERE (fighter1_id = 'x' OR fighter2_id = 'x') AND ufc = 1 ORDER BY seq DESC LIMIT 5",
    "SELECT summary FROM fights WHERE (fighter1_id IN (SELECT fighter_id FROM name_tokens WHERE token >= 'mc' AND token < 'md') OR fighter2_id IN (SELECT fighter_id FROM name_tokens WHERE token >= 'mc' AND token < 'md')) ORDER BY seq DESC LIMIT 5",
    "SELECT summary FROM fighters WHERE id IN (SELECT fighter_id FROM name_tokens WHERE token >= 'mc' AND token < 'md') ORDER BY sort_name, id LIMIT 5",
    "SELECT summary FROM fighters WHERE stance = 'orthodox' COLLATE NOCASE ORDER BY sort_name, id LIMIT 5",
    'SELECT id FROM fighters WHERE slpm IS NOT NULL AND total_fights >= 5 ORDER BY slpm DESC LIMIT 10',
    'SELECT summary FROM fighters ORDER BY wins DESC LIMIT 50 OFFSET 50',
    "SELECT doc FROM fights WHERE id = 'x'",
  ];
  for (const sql of plans) {
    const out = JSON.parse(d1(`EXPLAIN QUERY PLAN ${sql}`));
    const details: string[] = out[0].results.map((r: any) => r.detail);
    const scans = details.filter((d) => /^SCAN (events|fights|fighters|name_tokens)\b/.test(d) && !/USING (COVERING )?INDEX/.test(d));
    assert.equal(scans.length, 0, `${sql}\n  plan: ${details.join(' | ')}`);
    // An ORDER BY that has to sort every matching row is a scan in disguise. Exempt: name searches and one
    // fighter's fights (a few dozen rows), and multi-method filters (bounded by the fights table; see the PR).
    if (!/name_tokens|IN \('|fighter1_id = /.test(sql)) {
      assert.ok(!details.some((d) => /TEMP B-TREE FOR ORDER BY/.test(d)), `${sql} sorts every row\n  plan: ${details.join(' | ')}`);
    }
  }
});

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.err ? `\n      ${r.err}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
