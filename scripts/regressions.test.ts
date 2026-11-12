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
  const anon = { tier: 'anon' as const, id: '1.2.3.4', perDay: 5000, perMinute: 60 };
  const key = (q: string) => {
    const url = new URL(`https://x/api/fighters?${q}`);
    return canonical(url, ['limit', 'offset'], paramCaps('/api/fighters', anon));
  };
  assert.equal(key('limit=5e2'), key('limit=500'));
  assert.equal(key('limit=500.0'), key('limit=500'));
  assert.equal(key('limit=9999'), key('limit=500'), 'over the cap is clamped to the cap');
});

test('an unknown API key is not looked up in D1 once the IP is over its ceiling', async () => {
  const { identify } = await import('../worker/src/guard.ts');
  let d1Reads = 0;
  const env = {
    RL_CEILING: { limit: async () => ({ success: false }) },
    RL_ANON: { limit: async () => ({ success: false }) },
    RL_KEY: { limit: async () => ({ success: false }) },
    DB: { prepare: () => { d1Reads++; return { bind: () => ({ first: async () => null }) }; } },
    ANON_PER_DAY: '5000', ANON_PER_MINUTE: '60', KEY_PER_MINUTE: '600',
  } as any;
  for (let i = 0; i < 3; i++) {
    const req = new Request('https://x/api/fighters', { headers: { 'X-API-Key': `random-${i}`, 'CF-Connecting-IP': '203.0.113.5' } });
    await identify(req, env);
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
    ${ids.map((i) => `<a href="http://ufcstats.com/event-details/${i}">x</a>`).join('')}</body></html>`;
  ingest(db, `http://ufcstats.com/fighter-details/${F1}`, profile([listedId, hiddenId, upcomingId]), opts);
  assert.equal(status(db, `http://ufcstats.com/event-details/${hiddenId}`), 'pending', 'the unlisted event is queued');
  assert.equal(db.prepare('SELECT 1 FROM pages WHERE url = ?').get(`http://ufcstats.com/event-details/${upcomingId}`), undefined,
    'an upcoming card is left for the completed list');
  ingest(db, `http://ufcstats.com/event-details/${hiddenId}`, eventPage('win').replace('UFC Test', 'PRIDE 1'), opts);
  const flag = (id: string) => (db.prepare('SELECT listed FROM events WHERE id = ?').get(id) as { listed: number }).listed;
  assert.equal(flag(listedId), 1);
  assert.equal(flag(hiddenId), 0);
});
