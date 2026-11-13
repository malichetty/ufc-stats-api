/**
 * Regression tests for bugs the review panel reproduced on b5d60de. Run: node --test scripts/regressions.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.UFC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-regress-'));
const { openDb } = await import('../scraper/db.ts');
const { enqueue, ingest } = await import('../scraper/crawl.ts');

const EVENT = 'aaaaaaaaaaaaaaaa';
const FIGHT = 'bbbbbbbbbbbbbbbb';
const F1 = 'cccccccccccccccc';
const F2 = 'dddddddddddddddd';

const eventPage = (flag: string) => `<html><body>
<span class="b-content__title-highlight">UFC Test</span>
<ul class="b-list__box-list"><li><i class="b-list__box-item-title">Date:</i> November 07, 2026</li></ul>
<table><tbody><tr class="b-fight-details__table-row" data-link="http://ufcstats.com/fight-details/${FIGHT}">
<td>${flag ? `<i class="b-flag__text">${flag}</i>` : ''}</td>
<td><p><a href="http://ufcstats.com/fighter-details/${F1}">A One</a></p><p><a href="http://ufcstats.com/fighter-details/${F2}">B Two</a></p></td>
<td></td><td></td><td></td><td></td><td><p>Lightweight</p></td><td><p>KO/TKO</p><p>Punch</p></td><td><p>1</p></td><td><p>1:00</p></td>
</tr></tbody></table></body></html>`;

const fightPage = (r1: string, r2: string) => `<html><body>
<h2 class="b-content__title"><a href="http://ufcstats.com/event-details/${EVENT}">UFC Test</a></h2>
<div class="b-fight-details__person"><i class="b-fight-details__person-status">${r1}</i><h3 class="b-fight-details__person-name"><a class="b-fight-details__person-link" href="http://ufcstats.com/fighter-details/${F1}">A One</a></h3></div>
<div class="b-fight-details__person"><i class="b-fight-details__person-status">${r2}</i><h3 class="b-fight-details__person-name"><a class="b-fight-details__person-link" href="http://ufcstats.com/fighter-details/${F2}">B Two</a></h3></div>
<i class="b-fight-details__fight-title">Lightweight Bout</i></body></html>`;

const status = (db: any, url: string) => (db.prepare('SELECT status FROM pages WHERE url = ?').get(url) as { status: string }).status;

test('a fight stored before its result was posted is fetched again, with its fighters, once the result appears', () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const fightUrl = `http://ufcstats.com/fight-details/${FIGHT}`;
  const done = (url: string) => db.prepare(`UPDATE pages SET status = 'done' WHERE url = ?`).run(url);

  // Run 1: the card is listed but the result isn't up yet.
  ingest(db, `http://ufcstats.com/event-details/${EVENT}`, eventPage(''), opts);
  ingest(db, fightUrl, fightPage('', ''), opts);
  for (const u of [fightUrl, `http://ufcstats.com/fighter-details/${F1}`, `http://ufcstats.com/fighter-details/${F2}`]) done(u);

  // Retry run: the event page now shows the result.
  ingest(db, `http://ufcstats.com/event-details/${EVENT}`, eventPage('win'), opts);
  assert.equal(status(db, fightUrl), 'pending', 'the stale fight page is queued again');

  ingest(db, fightUrl, fightPage('W', 'L'), opts);
  assert.equal(status(db, `http://ufcstats.com/fighter-details/${F1}`), 'pending', 'fighter 1 profile is queued again');
  assert.equal(status(db, `http://ufcstats.com/fighter-details/${F2}`), 'pending', 'fighter 2 profile is queued again');
});

test('an event stays open while a fight page still has no result, even if the event page shows one', () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const recent = new Date(Date.now() - 86_400_000).toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
  ingest(db, `http://ufcstats.com/event-details/${EVENT}`, eventPage('win').replace('November 07, 2026', recent), opts);
  ingest(db, `http://ufcstats.com/fight-details/${FIGHT}`, fightPage('', ''), opts);
  const ev = db.prepare('SELECT complete FROM events WHERE id = ?').get(EVENT) as { complete: number };
  assert.equal(ev.complete, 0);
});

test('a page that failed three times is retried on the next weekly run', async () => {
  const { seed } = await import('../scraper/crawl.ts');
  const db = openDb();
  const url = 'http://ufcstats.com/fight-details/eeeeeeeeeeeeeeee';
  enqueue(db, url);
  db.prepare(`UPDATE pages SET status = 'failed', attempts = 3 WHERE url = ?`).run(url);
  seed(db, { mode: 'weekly' });
  assert.equal(status(db, url), 'pending');
});

test('pages that keep failing do not stop the run, so the weekly load still happens', async () => {
  const { drain, seed } = await import('../scraper/crawl.ts');
  const db = openDb();
  db.exec('DELETE FROM pages');
  const broken = ['1', '2', '3', '4', '5', '6'].map((n) => `http://ufcstats.com/fight-details/${n.repeat(16)}`);
  for (const u of broken) {
    enqueue(db, u);
    db.prepare(`UPDATE pages SET status = 'failed', attempts = 3 WHERE url = ?`).run(u);
  }
  seed(db, { mode: 'weekly' }); // queues the lists again and resets the failed pages
  db.exec(`UPDATE pages SET status = 'done' WHERE kind != 'fight'`); // only the broken pages are left to fetch
  const fetcher = {
    open: async () => {},
    close: async () => {},
    get: async (url: string) => { throw new Error(`HTTP 500 for ${url}`); },
  };
  await drain(db, { mode: 'weekly', log: () => {} }, fetcher); // must not throw
  for (const u of broken) assert.equal(status(db, u), 'failed');
});

test('a 404 page is gone: later runs do not fetch it again until it is flagged', async () => {
  const { seed } = await import('../scraper/crawl.ts');
  const db = openDb();
  const url = 'http://ufcstats.com/fight-details/ffffffffffffffff';
  enqueue(db, url);
  db.prepare(`UPDATE pages SET status = 'gone', attempts = 1 WHERE url = ?`).run(url);
  seed(db, { mode: 'weekly' });
  assert.equal(status(db, url), 'gone');
  enqueue(db, url, true); // what `pnpm flag` leads to on the next run
  assert.equal(status(db, url), 'pending');
});

test('equal numbers spelled differently share one cache key', async () => {
  const { canonical, paramCaps } = await import('../worker/src/api.ts');
  const anon = { tier: 'anon' as const, id: '1.2.3.4', perDay: 1000, perMinute: 30 };
  const key = (q: string) => {
    const url = new URL(`https://x/api/fighters?${q}`);
    return canonical(url, ['limit', 'offset'], paramCaps('/api/fighters', anon));
  };
  assert.equal(key('limit=5e2'), key('limit=500'));
  assert.equal(key('limit=500.0'), key('limit=500'));
  assert.equal(key('limit=9999'), key('limit=500'), 'over the cap is clamped to the cap');
});

test('an unknown API key never reads D1 and counts as anonymous', async () => {
  const { identify } = await import('../worker/src/guard.ts');
  let d1Reads = 0;
  const env = {
    DB: { prepare: () => { d1Reads++; return { bind: () => ({ first: async () => null }) }; } },
    ADMIN_API_KEY: 'the-admin-key', ANON_PER_DAY: '1000', ANON_PER_MINUTE: '60',
  } as any;
  for (let i = 0; i < 3; i++) {
    const req = new Request('https://x/api/fighters', { headers: { 'X-API-Key': `random-${i}`, 'CF-Connecting-IP': '203.0.113.5' } });
    const c = identify(req, env);
    assert.equal(c.tier, 'anon');
    assert.equal(c.id, '203.0.113.5');
  }
  assert.equal(d1Reads, 0);
});

test('an event ufcstats links only from fighter pages is fetched, and kept apart from the UFC list', async () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const listedId = '1111111111111111', hiddenId = '2222222222222222', upcomingId = '3333333333333333';
  const list = `<table><tr class="b-statistics__table-row"><td><a href="http://ufcstats.com/event-details/${listedId}">UFC 1</a>
    <span class="b-statistics__date">November 12, 1993</span></td><td>Denver</td></tr></table>`;
  ingest(db, 'http://ufcstats.com/statistics/events/completed?page=all', list, opts);
  db.prepare(`INSERT OR REPLACE INTO upcoming_events (id, name, seen_at) VALUES (?, 'UFC 999', 'now')`).run(upcomingId);
  const profile = (ids: string[]) => `<html><body><span class="b-content__title-highlight">A One</span>
    <table><tbody>${ids.map((i) => `<tr class="b-fight-details__table-row"><td><a href="http://ufcstats.com/event-details/${i}">x</a></td></tr>`).join('')}</tbody></table></body></html>`;
  ingest(db, `http://ufcstats.com/fighter-details/${F1}`, profile([listedId, hiddenId, upcomingId]), opts);
  assert.equal(status(db, `http://ufcstats.com/event-details/${hiddenId}`), 'pending', 'the unlisted event is queued');
  assert.equal(db.prepare('SELECT 1 FROM pages WHERE url = ?').get(`http://ufcstats.com/event-details/${upcomingId}`), undefined,
    'an upcoming card is left for the completed list');
  ingest(db, `http://ufcstats.com/event-details/${hiddenId}`, eventPage('win').replace('UFC Test', 'PRIDE 1'), opts);
  const flag = (id: string) => (db.prepare('SELECT listed FROM events WHERE id = ?').get(id) as { listed: number }).listed;
  assert.equal(flag(listedId), 1);
  assert.equal(flag(hiddenId), 0);
});

test('a card that leaves the upcoming list without reaching the completed list is fetched', () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const card = '4444444444444444';
  const upcoming = (ids: string[]) => `<table>${ids.map((i) => `<tr class="b-statistics__table-row"><td>
    <a href="http://ufcstats.com/event-details/${i}">Road to UFC</a><span class="b-statistics__date">December 01, 2099</span></td><td>Macau</td></tr>`).join('')}</table>`;
  ingest(db, 'http://ufcstats.com/statistics/events/upcoming?page=all', upcoming([card]), opts);
  assert.equal(db.prepare('SELECT 1 FROM pages WHERE url = ?').get(`http://ufcstats.com/event-details/${card}`), undefined);
  ingest(db, 'http://ufcstats.com/statistics/events/upcoming?page=all', upcoming(['9999999999999999']), opts); // the card moved off
  assert.equal(status(db, `http://ufcstats.com/event-details/${card}`), 'pending');
});

test('one-at-a-time requests past 30 a minute are refused even when the rate-limit binding lets them through', async () => {
  const { enforce, identify } = await import('../worker/src/guard.ts');
  const store = new Map<string, string>();
  (globalThis as any).caches = {
    default: {
      match: async (r: Request) => (store.has(r.url) ? new Response(store.get(r.url)) : undefined),
      put: async (r: Request, res: Response) => { store.set(r.url, await res.text()); },
    },
  };
  // Live, Cloudflare's limiter let 150 sequential requests a minute through a limit of 30.
  const env = {
    RL_ANON: { limit: async () => ({ success: true }) }, RL_ADMIN: { limit: async () => ({ success: true }) },
    ANON_PER_DAY: '1000', ANON_PER_MINUTE: '30', BLOCK_PER_MINUTE: '120',
  } as any;
  const req = new Request('https://x/api/fighters', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) {
    const r = await enforce(env, identify(req, env), 'https://x');
    statuses.push(r.blocked ? r.blocked.status : 200);
  }
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
  assert.equal(statuses[30], 429);
});

test('a card whose fight page keeps failing is held back instead of going out missing that bout', async () => {
  const { build } = await import('../scraper/build.ts');
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const ev = '5555555555555555';
  const fight = '5a5a5a5a5a5a5a5a';
  const page = eventPage('win').replace(new RegExp(EVENT, 'g'), ev).replace(new RegExp(FIGHT, 'g'), fight).replace('November 07, 2026', 'November 07, 2020');
  ingest(db, `http://ufcstats.com/event-details/${ev}`, page, opts);
  const fightUrl = `http://ufcstats.com/fight-details/${fight}`;
  db.prepare(`UPDATE fights SET page_scraped_at = NULL WHERE id = ?`).run(fight);
  db.prepare(`UPDATE pages SET status = 'failed', attempts = 3 WHERE url = ?`).run(fightUrl);
  db.prepare(`INSERT INTO fight_stats (fight_id, fighter_id, round) VALUES (?, ?, 1)`).run(fight, F1);
  const held = build(db);
  assert.ok(!held.events.some((e) => e.id === ev), 'held back while the fight page fails');
  const overview = JSON.parse(String(held.meta.find((m) => m.key === 'overview')!.value));
  assert.equal(overview.other_round_stat_rows, 0, "a held-back card's round stats aren't counted anywhere");
  db.prepare(`UPDATE pages SET status = 'gone' WHERE url = ?`).run(fightUrl);
  assert.ok(build(db).events.some((e) => e.id === ev), 'published once ufcstats has removed the page');
});

test('re-reading an event page does not reopen a fight page ufcstats removed (404)', () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const fightUrl = `http://ufcstats.com/fight-details/${FIGHT}`;
  db.prepare(`UPDATE pages SET status = 'gone' WHERE url = ?`).run(fightUrl);
  ingest(db, `http://ufcstats.com/event-details/${EVENT}`, eventPage(''), opts); // no result flag: a forced re-queue
  assert.equal(status(db, fightUrl), 'gone');
});

test('a weekly run re-reads 100 known profiles, split between recent off-list fighters and everyone else', async () => {
  const { seed } = await import('../scraper/crawl.ts');
  const db = openDb();
  db.exec(`DELETE FROM pages WHERE kind = 'fighter'`);
  const hidden = '6666666666666666';
  db.prepare(`INSERT OR REPLACE INTO events (id, name, date, listed, first_seen_at) VALUES (?, 'Road to UFC 9.1', date('now', '-30 days'), 0, 'x')`).run(hidden);
  const recent = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(16, 'b'));
  const others = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(16, 'c'));
  recent.forEach((id, i) => db.prepare(`INSERT OR REPLACE INTO fights (id, event_id, fighter1_id, fighter2_id) VALUES (?, ?, ?, NULL)`)
    .run(i.toString(16).padStart(16, 'd'), hidden, id));
  for (const id of [...recent, ...others]) {
    db.prepare(`INSERT INTO pages (url, kind, status, fetched_at) VALUES (?, 'fighter', 'done', '2026-01-01')`)
      .run(`http://ufcstats.com/fighter-details/${id}`);
  }
  seed(db, { mode: 'weekly' });
  const pending = (ids: string[]) => ids.filter((id) => status(db, `http://ufcstats.com/fighter-details/${id}`) === 'pending').length;
  assert.equal(pending(recent), 50, 'half from recent off-list fighters');
  assert.equal(pending(others), 50, 'half from everyone else, so they are not starved');
});

test('a card whose result-less fight is being fetched again is held back until the result is in', async () => {
  const { build } = await import('../scraper/build.ts');
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const ev = '8888888888888888';
  const fight = '8a8a8a8a8a8a8a8a';
  const page = eventPage('win').replace(new RegExp(EVENT, 'g'), ev).replace(new RegExp(FIGHT, 'g'), fight).replace('November 07, 2026', 'November 07, 2020');
  ingest(db, `http://ufcstats.com/event-details/${ev}`, page, opts);
  const fightUrl = `http://ufcstats.com/fight-details/${fight}`;
  // Stored before its result was posted, and the refetch keeps failing.
  db.prepare(`UPDATE fights SET page_scraped_at = '2020-11-07', fighter1_result = NULL, fighter2_result = NULL WHERE id = ?`).run(fight);
  db.prepare(`UPDATE pages SET status = 'failed', attempts = 3 WHERE url = ?`).run(fightUrl);
  assert.ok(!build(db).events.some((e) => e.id === ev), 'held back while the result-less fight is retried');
  assert.ok(build(db, new Set([ev])).events.some((e) => e.id === ev), 'a card already live stays live while it retries');
  // The real path: sync reads what is live on the target from `served` and must not delete the card.
  const { sync } = await import('../scraper/sync.ts');
  db.prepare(`INSERT OR REPLACE INTO served (target, tbl, id, hash) VALUES ('remote', 'events', ?, 'old')`).run(ev);
  const res = sync(db, 'remote', { dryRun: true, log: () => {} });
  assert.equal(res.deleted.events, 0, 'sync keeps the live card');
  db.prepare(`UPDATE fights SET fighter1_result = 'W', fighter2_result = 'L' WHERE id = ?`).run(fight);
  db.prepare(`UPDATE pages SET status = 'done' WHERE url = ?`).run(fightUrl);
  assert.ok(build(db).events.some((e) => e.id === ev), 'published once the result is in');
});

test('a completed-events page that parses short (a layout change) changes nothing', () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  db.exec(`UPDATE events SET listed = 1`);
  const before = (db.prepare('SELECT COUNT(*) n FROM events WHERE listed = 1').get() as { n: number }).n;
  assert.ok(before > 0);
  assert.throws(() => ingest(db, 'http://ufcstats.com/statistics/events/completed?page=all', '<html><body>new layout</body></html>', opts));
  assert.equal((db.prepare('SELECT COUNT(*) n FROM events WHERE listed = 1').get() as { n: number }).n, before);
});

test('fighter, fight and event pages that parse blank (a layout change) change nothing', () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const blank = '<html><body>new layout</body></html>';
  const name = (db.prepare('SELECT name FROM fighters WHERE id = ?').get(F1) as { name: string } | undefined)?.name;
  assert.throws(() => ingest(db, `http://ufcstats.com/fighter-details/${F1}`, blank, opts));
  assert.equal((db.prepare('SELECT name FROM fighters WHERE id = ?').get(F1) as { name: string } | undefined)?.name, name);
  assert.throws(() => ingest(db, `http://ufcstats.com/fight-details/${FIGHT}`, blank, opts));
  assert.throws(() => ingest(db, `http://ufcstats.com/event-details/${EVENT}`, blank, opts));
  const titleOnly = eventPage('win').replace(/<table>[\s\S]*<\/table>/, '<div>new card layout</div>');
  assert.throws(() => ingest(db, `http://ufcstats.com/event-details/${EVENT}`, titleOnly, opts), /no fights/);
});

test('the watchdog keeps the API paused when the domain is re-attached the same day (e.g. by wrangler deploy)', async () => {
  const { execFileSync } = await import('node:child_process');
  const run = (steps: unknown[]) => execFileSync(process.execPath, ['--no-warnings', 'scripts/fixtures/watchdog/run.mjs', JSON.stringify(steps)], { encoding: 'utf8' })
    .trim().split('\n').map((l) => JSON.parse(l) as { requests: number; attached: boolean; kill: boolean });
  const ticks = run([150_000, 'deploy', 160_000]);
  assert.equal(ticks[0].attached, false, 'paused over the cap');
  assert.equal(ticks[1].attached, false, 're-attached domain detached again on the next over-cap tick');
  assert.equal(ticks[1].kill, true, 'the D1 kill flag backs the pause');
});

test('one event page cannot move a published fight to another event, so sync keeps it', async () => {
  const { sync } = await import('../scraper/sync.ts');
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const real = '6b6b6b6b6b6b6b6b', fake = '6c6c6c6c6c6c6c6c', fight = '6d6d6d6d6d6d6d6d';
  const card = (ev: string, date: string) => eventPage('win').replace(new RegExp(EVENT, 'g'), ev).replace(new RegExp(FIGHT, 'g'), fight).replace('November 07, 2026', date);
  ingest(db, `http://ufcstats.com/event-details/${real}`, card(real, 'November 07, 2020'), opts);
  ingest(db, `http://ufcstats.com/fight-details/${fight}`, fightPage('W', 'L').replace(new RegExp(EVENT, 'g'), real), opts);
  db.exec(`UPDATE pages SET status = 'done'`);
  sync(db, 'remote', { dryRun: true, log: () => {} });
  const { build } = await import('../scraper/build.ts');
  for (const t of ['events', 'fights'] as const) for (const r of build(db)[t]) {
    db.prepare(`INSERT OR REPLACE INTO served (target, tbl, id, hash) VALUES ('remote', ?, ?, 'x')`).run(t, r.id);
  }
  ingest(db, `http://ufcstats.com/event-details/${fake}`, card(fake, 'December 01, 2099'), opts);
  assert.equal((db.prepare('SELECT event_id FROM fights WHERE id = ?').get(fight) as { event_id: string }).event_id, real);
  assert.equal(sync(db, 'remote', { dryRun: true, log: () => {} }).deleted.fights, 0);
});

test('a real card merge moves a completed fight once its own fight page confirms the new event', () => {
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const from = '6e6e6e6e6e6e6e6e', to = '6f6f6f6f6f6f6f6f', fight = '5f5f5f5f5f5f5f5f';
  const card = (ev: string) => eventPage('win').replace(new RegExp(EVENT, 'g'), ev).replace(new RegExp(FIGHT, 'g'), fight).replace('November 07, 2026', 'November 07, 2020');
  ingest(db, `http://ufcstats.com/event-details/${from}`, card(from), opts);
  ingest(db, `http://ufcstats.com/fight-details/${fight}`, fightPage('W', 'L').replace(new RegExp(EVENT, 'g'), from), opts);
  db.exec(`UPDATE pages SET status = 'done'`);
  ingest(db, `http://ufcstats.com/event-details/${to}`, card(to), opts);
  assert.equal(status(db, `http://ufcstats.com/fight-details/${fight}`), 'pending', 'the fight page is checked again');
  ingest(db, `http://ufcstats.com/fight-details/${fight}`, fightPage('W', 'L').replace(new RegExp(EVENT, 'g'), to), opts);
  assert.equal((db.prepare('SELECT event_id FROM fights WHERE id = ?').get(fight) as { event_id: string }).event_id, to);
});

test('an upcoming-list page cannot withdraw a published event, and neither can a future date on its page', async () => {
  const { build } = await import('../scraper/build.ts');
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const ev = '7b7b7b7b7b7b7b7b';
  const list = (ids: string[]) => `<table>${ids.map((i) => `<tr class="b-statistics__table-row"><td>
    <a href="http://ufcstats.com/event-details/${i}">UFC 7</a><span class="b-statistics__date">December 05, 2099</span></td><td>Vegas</td></tr>`).join('')}</table>`;
  db.prepare(`INSERT OR REPLACE INTO events (id, name, date, listed, first_seen_at) VALUES (?, 'UFC 7', '2020-11-07', 1, 'x')`).run(ev);
  ingest(db, 'http://ufcstats.com/statistics/events/upcoming?page=all', list([ev, '7d7d7d7d7d7d7d7d']), opts);
  assert.deepEqual((db.prepare('SELECT id FROM upcoming_events').all() as { id: string }[]).map((r) => r.id), ['7d7d7d7d7d7d7d7d']);
  ingest(db, `http://ufcstats.com/event-details/${ev}`, eventPage('win').replace(new RegExp(EVENT, 'g'), ev).replace(new RegExp(FIGHT, 'g'), '7c7c7c7c7c7c7c7c').replace('November 07, 2026', 'December 01, 2099'), opts);
  assert.ok(build(db, new Set([ev])).events.some((e) => e.id === ev), 'a live event dated in the future stays published');
});

test('a load that would delete many published rows is refused unless allowed', async () => {
  const { sync } = await import('../scraper/sync.ts');
  const db = openDb();
  for (let i = 0; i < 20; i++) db.prepare(`INSERT OR REPLACE INTO served (target, tbl, id, hash) VALUES ('mass', 'fights', ?, 'x')`).run(i.toString(16).padStart(16, 'e'));
  assert.throws(() => sync(db, 'mass' as 'remote', { dryRun: true, log: () => {} }), /would delete 20 of 20 published fights/);
  assert.equal(sync(db, 'mass' as 'remote', { dryRun: true, allowDeletes: true, log: () => {} }).deleted.fights, 20);
});

test('an oversized text field is refused at ingest, and a row over the statement limit (in bytes) loads slimmed in place', async () => {
  const { sync } = await import('../scraper/sync.ts');
  const db = openDb();
  const opts = { mode: 'weekly' as const };
  const page = (nick: string) => `<html><body><span class="b-content__title-highlight">Long Nick</span><p class="b-content__Nickname">${nick}</p></body></html>`;
  assert.throws(() => ingest(db, 'http://ufcstats.com/fighter-details/8b8b8b8b8b8b8b8b', page('A'.repeat(46_000)), opts), /nickname is 46000 characters/);
  // The name lands in four columns of the row: 40,000 UTF-16 units (under the limit by length) but 120,000 bytes.
  db.prepare(`INSERT OR REPLACE INTO fighters (id, name, profile_scraped_at) VALUES ('8c8c8c8c8c8c8c8c', ?, 'x')`).run('漢'.repeat(10_000));
  const { file } = sync(db, 'remote', { dryRun: true, allowDeletes: true, log: () => {} });
  const row = fs.readFileSync(file!, 'utf8').split('\n').find((l) => l.startsWith(`('8c8c8c8c8c8c8c8c'`))!;
  assert.ok(row.includes('"too_large":true') && row.includes('"fights":[]'), 'kept, slimmed, response shape intact');
  db.prepare(`DELETE FROM fighters WHERE id = '8c8c8c8c8c8c8c8c'`).run();
});


test('a fighter page linking many unknown events cannot stop the weekly crawl', async () => {
  const { drain } = await import('../scraper/crawl.ts');
  const db = openDb();
  db.exec('DELETE FROM pages');
  const ids = Array.from({ length: 12 }, (_, i) => (i + 1).toString(16).padStart(16, '0'));
  const profile = `<html><body><div class="b-foot"></div><span class="b-content__title-highlight">Link Farm</span><table><tbody>
    ${ids.map((i) => `<tr class="b-fight-details__table-row"><td><a href="http://ufcstats.com/event-details/${i}">x</a></td></tr>`).join('')}</tbody></table></body></html>`;
  enqueue(db, 'http://ufcstats.com/fighter-details/9b9b9b9b9b9b9b9b');
  const fetcher = {
    open: async () => {}, close: async () => {},
    get: async (url: string) => {
      if (url.includes('/fighter-details/')) return profile;
      if (url.endsWith('1')) throw new Error('HTTP 404');
      return '<html><body><div class="b-foot"></div></body></html>'; // answered, but not an event page
    },
  };
  await drain(db, { mode: 'weekly', log: () => {} }, fetcher); // must not throw BlockedError
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM pages WHERE status = 'pending'`).get() as { n: number }).n, 0);
});

test('rotating /64s inside one IPv6 /48 cannot multiply the daily allowance', async () => {
  const { enforce, identify } = await import('../worker/src/guard.ts');
  const store = new Map<string, string>();
  (globalThis as any).caches = {
    default: {
      match: async (r: Request) => (store.has(r.url) ? new Response(store.get(r.url)) : undefined),
      put: async (r: Request, res: Response) => { store.set(r.url, await res.text()); },
    },
  };
  const env = {
    RL_ANON: { limit: async () => ({ success: true }) }, RL_BLOCK: { limit: async () => ({ success: true }) },
    ANON_PER_DAY: '1000', ANON_PER_MINUTE: '30', BLOCK_PER_MINUTE: '120', BLOCK_PER_DAY: '4000',
  } as any;
  const realNow = Date.now;
  let clock = Date.parse('2026-11-12T00:00:30Z');
  Date.now = () => clock;
  let served = 0;
  try {
    for (let minute = 0; minute < 60; minute++, clock += 60_000) {
      for (let i = 0; i < 120; i++) {
        const req = new Request('https://x/api/fighters', { headers: { 'CF-Connecting-IP': `2001:db8:abcd:${minute * 120 + i}::1` } });
        if (!(await enforce(env, identify(req, env), 'https://x')).blocked) served++;
      }
    }
  } finally { Date.now = realNow; }
  assert.equal(served, 4000);
});

test('a weekly run that hits the discovery cap flags the profile so the rest is queued next run', async () => {
  const db = openDb();
  const opts: { mode: 'weekly'; discovered?: number } = { mode: 'weekly' };
  db.exec('DELETE FROM flags');
  const ids = Array.from({ length: 30 }, (_, i) => (i + 1).toString(16).padStart(16, 'a'));
  const profile = `<html><body><span class="b-content__title-highlight">Many Cards</span><table><tbody>
    ${ids.map((i) => `<tr class="b-fight-details__table-row"><td><a href="http://ufcstats.com/event-details/${i}">x</a></td></tr>`).join('')}</tbody></table></body></html>`;
  const url = 'http://ufcstats.com/fighter-details/9c9c9c9c9c9c9c9c';
  ingest(db, url, profile, opts);
  assert.equal(opts.discovered, 25);
  assert.ok(db.prepare('SELECT 1 FROM flags WHERE url = ?').get(url), 'profile flagged for the next run');
});

test('ufcstats answering 404 for everything marks nothing gone, run after run', async () => {
  const { drain, seed } = await import('../scraper/crawl.ts');
  const db = openDb();
  db.exec('DELETE FROM pages');
  for (let i = 0; i < 30; i++) enqueue(db, `http://ufcstats.com/fight-details/${i.toString(16).padStart(16, 'd')}`);
  const fetcher = { open: async () => {}, close: async () => {}, get: async () => { throw new Error('HTTP 404'); } };
  for (let run = 0; run < 2; run++) { // the next run, still all 404, keeps them the same way
    seed(db, { mode: 'weekly' });
    await drain(db, { mode: 'weekly', log: () => {} }, fetcher);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM pages WHERE status = 'gone'`).get() as { n: number }).n, 0);
    assert.equal(status(db, 'http://ufcstats.com/fight-details/ddddddddddddddd0'), 'failed');
  }
});

test('five first-try timeouts or 5xx answers in a row still stop the run', async () => {
  const { drain, BlockedError } = await import('../scraper/crawl.ts');
  for (const err of ['Timeout 45000ms exceeded', 'HTTP 502']) {
    const db = openDb();
    db.exec('DELETE FROM pages');
    for (let i = 0; i < 8; i++) enqueue(db, `http://ufcstats.com/fight-details/${i.toString(16).padStart(16, 'c')}`);
    let calls = 0;
    const fetcher = { open: async () => {}, close: async () => {}, get: async () => { calls++; throw new Error(err); } };
    await assert.rejects(drain(db, { mode: 'weekly', log: () => {} }, fetcher), BlockedError);
    assert.equal(calls, 5);
  }
});
