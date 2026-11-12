import type { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { BlockedError, Fetcher } from './browser.ts';
import { nowIso, tx } from './db.ts';
import {
  EVENTS_LIST_URL, FIGHTER_LIST_URLS, UPCOMING_LIST_URL, eventUrl, fightUrl, fighterUrl, kindOf,
  parseEvent, parseEventsList, parseFight, parseFighter, parseFighterList, STAT_FIELDS, type PageKind,
} from './parse.ts';

export type Mode = 'full' | 'weekly' | 'sample';

export interface CrawlOptions {
  mode: Mode;
  /** sample mode: how many of the newest events to take */
  sampleEvents?: number;
  /** weekly mode: ignore listed events older than this date (used for sample databases) */
  since?: string;
  maxPages?: number;
  log?: (msg: string) => void;
}

const PRIORITY: Record<PageKind, number> = {
  events_list: 0, upcoming_list: 0, fighter_list: 1, event: 2, fight: 3, fighter: 4,
};
const MAX_ATTEMPTS = 3;
/** About 5 minutes a run at the crawl's pace. */
const PROFILE_REFRESH_PER_RUN = 100;
const MAX_FAILURES_IN_A_ROW = 5;

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * force: queue the page again even if it was fetched. 'refresh' does the same but leaves a 404'd ('gone') page alone,
 * for the automatic re-queues; `true` (flag, enqueue) reopens it on purpose.
 */
export function enqueue(db: DatabaseSync, url: string, force: boolean | 'refresh' = false): void {
  const kind = kindOf(url);
  if (force) {
    db.prepare(
      `INSERT INTO pages (url, kind, status) VALUES (?, ?, 'pending')
       ON CONFLICT(url) DO UPDATE SET status = 'pending', attempts = 0, last_error = NULL
       ${force === 'refresh' ? "WHERE pages.status != 'gone'" : ''}`,
    ).run(url, kind);
  } else {
    db.prepare(`INSERT OR IGNORE INTO pages (url, kind, status) VALUES (?, ?, 'pending')`).run(url, kind);
  }
}

/** Parse a fetched page into the tables and queue the pages it links to. */
export function ingest(db: DatabaseSync, url: string, html: string, opts: CrawlOptions): void {
  const kind = kindOf(url);
  const now = nowIso();
  const id = url.split('/').pop()!;

  if (kind === 'events_list') {
    let listed = parseEventsList(html).filter((e) => !e.date || e.date <= today());
    if (opts.mode === 'sample') listed = listed.slice(0, opts.sampleEvents ?? 4);
    if (opts.since) listed = listed.filter((e) => e.date && e.date >= opts.since!);
    for (const e of listed) {
      db.prepare(
        `INSERT INTO events (id, name, date, location, first_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date, location = excluded.location`,
      ).run(e.id, e.name, e.date, e.location, now);
      enqueue(db, eventUrl(e.id));
    }
    // A partial list (sample, --since) can't say an event dropped off, so only a whole list clears the flag.
    const whole = opts.mode !== 'sample' && !opts.since;
    db.prepare(`UPDATE events SET listed = (id IN (SELECT value FROM json_each(?1)))${whole ? '' : ' WHERE id IN (SELECT value FROM json_each(?1))'}`)
      .run(JSON.stringify(listed.map((e) => e.id)));
    return;
  }

  if (kind === 'upcoming_list') {
    const upcoming = parseEventsList(html);
    // Fighter-profile discovery skips upcoming cards, so a card that leaves this list without reaching the completed
    // list (ufcstats merged Road to UFC 4.6 into another event) is fetched here instead.
    const still = new Set(upcoming.map((e) => e.id));
    for (const { id: gone } of db.prepare('SELECT id FROM upcoming_events WHERE id NOT IN (SELECT id FROM events)').all() as { id: string }[]) {
      if (!still.has(gone)) enqueue(db, eventUrl(gone));
    }
    db.exec('DELETE FROM upcoming_events');
    for (const e of upcoming) {
      db.prepare(`INSERT OR REPLACE INTO upcoming_events (id, name, date, location, seen_at) VALUES (?, ?, ?, ?, ?)`)
        .run(e.id, e.name, e.date, e.location, now);
    }
    return;
  }

  if (kind === 'fighter_list') {
    for (const f of parseFighterList(html)) {
      db.prepare(`INSERT OR REPLACE INTO listed_fighters (id, first_name, last_name, nickname, is_champion) VALUES (?, ?, ?, ?, ?)`)
        .run(f.id, f.first_name, f.last_name, f.nickname, f.is_champion ? 1 : 0);
      // Not forced: only fighters without a stored profile are fetched, and a new fighter's profile is how the
      // weekly run finds a new Contender Series or Road to UFC card.
      if (opts.mode !== 'sample') enqueue(db, fighterUrl(f.id));
    }
    return;
  }

  if (kind === 'event') {
    const e = parseEvent(id, html);
    const complete = e.fights.length > 0 && e.fights.every((f) => f.flags.length > 0);
    db.prepare(
      `INSERT INTO events (id, name, date, location, complete, first_seen_at, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date, location = excluded.location,
         complete = excluded.complete, scraped_at = excluded.scraped_at`,
    ).run(e.id, e.name, e.date, e.location, complete ? 1 : 0, now, now);
    for (const f of e.fights) {
      db.prepare(
        `INSERT INTO fights (id, event_id, bout_order, fighter1_id, fighter2_id, fighter1_name, fighter2_name,
           weight_class, bonuses, method_short, method_detail, round, time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET event_id = excluded.event_id, bout_order = excluded.bout_order,
           weight_class = excluded.weight_class, bonuses = excluded.bonuses, method_short = excluded.method_short,
           method_detail = excluded.method_detail, round = COALESCE(fights.round, excluded.round),
           time = COALESCE(fights.time, excluded.time)`,
      ).run(f.id, e.id, f.bout_order, f.fighter1_id, f.fighter2_id, f.fighter1_name, f.fighter2_name,
        f.weight_class, JSON.stringify(f.bonuses), f.method, f.method_detail, f.round, f.time);
      // Fetch the fight page again while it has no result: either the event page shows none yet, or we stored the
      // fight page before the result was posted.
      const stored = db.prepare('SELECT fighter1_result r, page_scraped_at at FROM fights WHERE id = ?').get(f.id) as
        { r: string | null; at: string | null } | undefined;
      enqueue(db, fightUrl(f.id), f.flags.length === 0 || (!!stored?.at && stored.r === null) ? 'refresh' : false);
    }
    return;
  }

  if (kind === 'fight') {
    const f = parseFight(id, html);
    const before = db.prepare('SELECT page_scraped_at, fighter1_result FROM fights WHERE id = ?').get(id) as
      | { page_scraped_at: string | null; fighter1_result: string | null } | undefined;
    const [a, b] = f.fighters;
    db.prepare(
      `INSERT INTO fights (id, event_id, fighter1_id, fighter2_id, fighter1_name, fighter2_name, fighter1_nickname,
         fighter2_nickname, fighter1_result, fighter2_result, bout, title_bout, method, details, round, time,
         time_format, referee, page_scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET fighter1_id = excluded.fighter1_id, fighter2_id = excluded.fighter2_id,
         fighter1_name = excluded.fighter1_name, fighter2_name = excluded.fighter2_name,
         fighter1_nickname = excluded.fighter1_nickname, fighter2_nickname = excluded.fighter2_nickname,
         fighter1_result = excluded.fighter1_result, fighter2_result = excluded.fighter2_result,
         bout = excluded.bout, title_bout = excluded.title_bout, method = excluded.method, details = excluded.details,
         round = excluded.round, time = excluded.time, time_format = excluded.time_format, referee = excluded.referee,
         page_scraped_at = excluded.page_scraped_at`,
    ).run(id, f.event_id ?? '', a?.id ?? null, b?.id ?? null, a?.name ?? null, b?.name ?? null,
      a?.nickname ?? null, b?.nickname ?? null, a?.result ?? null, b?.result ?? null, f.bout, f.title_bout ? 1 : 0,
      f.method, f.details, f.round, f.time, f.time_format, f.referee, now);
    if (!a?.result && !b?.result && f.event_id) {
      // The event page can show a result before the fight page does; keep a recent event open so the next run
      // fetches it, and through it this fight, again. Older events are left alone so a fight ufcstats never filled
      // in isn't refetched every week.
      db.prepare(`UPDATE events SET complete = 0 WHERE id = ? AND date >= date('now', '-30 days')`).run(f.event_id);
    }
    db.prepare('DELETE FROM fight_stats WHERE fight_id = ?').run(id);
    const cols = ['fight_id', 'fighter_id', 'round', ...STAT_FIELDS];
    const ins = db.prepare(`INSERT INTO fight_stats (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const s of f.stats) ins.run(id, s.fighter_id, s.round, ...STAT_FIELDS.map((k) => s[k]));
    // A fighter who just fought, or whose result was just posted, has a new record and new career stats.
    const changed = !before?.page_scraped_at || (before.fighter1_result ?? null) !== (a?.result ?? null);
    for (const p of f.fighters) {
      if (!p.id) continue;
      db.prepare('INSERT OR IGNORE INTO fighters (id, name) VALUES (?, ?)').run(p.id, p.name);
      enqueue(db, fighterUrl(p.id), changed && opts.mode !== 'full');
    }
    return;
  }

  if (kind === 'fighter') {
    const p = parseFighter(id, html);
    db.prepare(
      `INSERT INTO fighters (id, name, nickname, record, wins, losses, draws, no_contests, height, height_inches,
         weight, weight_lbs, reach, reach_inches, stance, dob, slpm, str_acc, sapm, str_def, td_avg, td_acc, td_def,
         sub_avg, profile_scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, nickname = excluded.nickname, record = excluded.record,
         wins = excluded.wins, losses = excluded.losses, draws = excluded.draws, no_contests = excluded.no_contests,
         height = excluded.height, height_inches = excluded.height_inches, weight = excluded.weight,
         weight_lbs = excluded.weight_lbs, reach = excluded.reach, reach_inches = excluded.reach_inches,
         stance = excluded.stance, dob = excluded.dob, slpm = excluded.slpm, str_acc = excluded.str_acc,
         sapm = excluded.sapm, str_def = excluded.str_def, td_avg = excluded.td_avg, td_acc = excluded.td_acc,
         td_def = excluded.td_def, sub_avg = excluded.sub_avg, profile_scraped_at = excluded.profile_scraped_at`,
    ).run(p.id, p.name, p.nickname, p.record, p.wins, p.losses, p.draws, p.no_contests, p.height, p.height_inches,
      p.weight, p.weight_lbs, p.reach, p.reach_inches, p.stance, p.dob, p.slpm, p.str_acc, p.sapm, p.str_def,
      p.td_avg, p.td_acc, p.td_def, p.sub_avg, now);
    // ufcstats leaves some events off its completed list (PRIDE, WEC, Strikeforce, Contender Series, Road to UFC);
    // a fighter's history is the only place that links them.
    if (opts.mode !== 'sample') {
      // Upcoming cards are linked too; they're fetched once they're on the completed list.
      const known = db.prepare('SELECT 1 FROM events WHERE id = ?1 UNION ALL SELECT 1 FROM upcoming_events WHERE id = ?1');
      for (const ev of new Set(Array.from(html.matchAll(/event-details\/([0-9a-f]{16})/g), (m) => m[1]))) {
        if (!known.get(ev)) enqueue(db, eventUrl(ev));
      }
    }
  }
}

function nextPending(db: DatabaseSync): { url: string; kind: PageKind; attempts: number } | undefined {
  return db.prepare(
    `SELECT url, kind, attempts FROM pages WHERE status = 'pending'
     ORDER BY attempts, CASE kind WHEN 'events_list' THEN 0 WHEN 'upcoming_list' THEN 0 WHEN 'fighter_list' THEN 1
       WHEN 'event' THEN 2 WHEN 'fight' THEN 3 ELSE 4 END, url LIMIT 1`,
  ).get() as { url: string; kind: PageKind; attempts: number } | undefined;
}

/** Fetch every pending page, one at a time. Returns the number of pages fetched. Throws BlockedError to stop. */
export async function drain(
  db: DatabaseSync,
  opts: CrawlOptions,
  fetcher: Pick<Fetcher, 'open' | 'get' | 'close'> = new Fetcher(),
): Promise<number> {
  const log = opts.log ?? console.log;
  if (!nextPending(db)) return 0;
  await fetcher.open();
  let fetched = 0;
  let failuresInARow = 0;
  let stopping = false;
  const stop = (sig: string) => {
    log(`${sig} received; finishing the current page and stopping`);
    stopping = true;
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    for (;;) {
      if (stopping) break;
      if (opts.maxPages !== undefined && fetched >= opts.maxPages) break;
      const next = nextPending(db);
      if (!next) break;
      try {
        const html = await fetcher.get(next.url);
        tx(db, () => {
          db.prepare('INSERT OR REPLACE INTO raw_pages (url, fetched_at, html_gz) VALUES (?, ?, ?)')
            .run(next.url, nowIso(), zlib.gzipSync(html));
          ingest(db, next.url, html, opts);
          db.prepare(`UPDATE pages SET status = 'done', fetched_at = ?, last_error = NULL WHERE url = ?`)
            .run(nowIso(), next.url);
        });
        fetched++;
        failuresInARow = 0;
        if (fetched % 50 === 0) log(`fetched ${fetched} pages (last: ${next.url})`);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        // Only a page's first-ever try counts toward the stop: that is the evidence ufcstats has stopped answering.
        // Retries of pages that failed before are that page's problem. A 404 is final ('gone'); `pnpm flag` reopens it.
        if (next.attempts === 0) failuresInARow++;
        const gone = /HTTP 404/.test((e as Error).message);
        const attempts = next.attempts + 1;
        db.prepare(`UPDATE pages SET attempts = ?, last_error = ?, status = ? WHERE url = ?`)
          .run(attempts, String((e as Error).message).slice(0, 500), gone ? 'gone' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', next.url);
        log(`error on ${next.url}: ${(e as Error).message}`);
        if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          throw new BlockedError(`${MAX_FAILURES_IN_A_ROW} page failures in a row; stopping (last: ${(e as Error).message})`);
        }
      }
    }
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    await fetcher.close();
  }
  return fetched;
}

/** Re-run the parsers over every stored page, without touching ufcstats. */
export function reparse(db: DatabaseSync, opts: CrawlOptions): number {
  const rows = db.prepare('SELECT url, html_gz FROM raw_pages').all() as { url: string; html_gz: Uint8Array }[];
  const order = (u: string) => PRIORITY[kindOf(u)];
  rows.sort((a, b) => order(a.url) - order(b.url));
  tx(db, () => {
    for (const r of rows) ingest(db, r.url, zlib.gunzipSync(r.html_gz).toString('utf8'), opts);
  });
  return rows.length;
}

/** Queue what this kind of run needs. */
export function seed(db: DatabaseSync, opts: CrawlOptions): void {
  enqueue(db, EVENTS_LIST_URL, true);
  if (opts.mode === 'sample') return;
  // Pages that failed three times in an earlier run (flagged pages included) get one quiet retry each run; at
  // attempts = MAX - 1 a failure sends them straight back to 'failed' and doesn't count toward the stop.
  db.exec(`UPDATE pages SET status = 'pending', attempts = ${MAX_ATTEMPTS - 1} WHERE status = 'failed'`);
  enqueue(db, UPCOMING_LIST_URL, true);
  for (const u of FIGHTER_LIST_URLS) enqueue(db, u, opts.mode === 'weekly');
  if (opts.mode !== 'weekly') return;
  for (const f of db.prepare('SELECT url FROM flags').all() as { url: string }[]) enqueue(db, f.url, true);
  db.exec('DELETE FROM flags');
  for (const e of db.prepare('SELECT id FROM events WHERE complete = 0').all() as { id: string }[]) {
    enqueue(db, eventUrl(e.id), true);
  }
  // Off-list cards (Contender Series, Road to UFC) are linked only from fighter profiles, and a later tournament
  // round can be all known fighters. So each run also re-reads some known profiles (Aris approved 2026-11-12):
  // fighters from an off-list card in the last two years first, then the longest unread.
  const refresh = db.prepare(
    `SELECT p.url FROM pages p WHERE p.kind = 'fighter' AND p.status = 'done'
     ORDER BY substr(p.url, -16) IN (
       SELECT f.fighter1_id FROM fights f JOIN events e ON e.id = f.event_id WHERE e.listed = 0 AND e.date >= date('now', '-2 years')
       UNION SELECT f.fighter2_id FROM fights f JOIN events e ON e.id = f.event_id WHERE e.listed = 0 AND e.date >= date('now', '-2 years')
     ) DESC, p.fetched_at ASC
     LIMIT ?`,
  ).all(PROFILE_REFRESH_PER_RUN) as { url: string }[];
  for (const r of refresh) enqueue(db, r.url, 'refresh');
}

/** Events ufcstats still lists as upcoming although their date has passed: results not published yet. */
export function unpublished(db: DatabaseSync): { id: string; name: string; date: string }[] {
  return db.prepare(
    `SELECT u.id, u.name, u.date FROM upcoming_events u LEFT JOIN events e ON e.id = u.id
     WHERE u.date < ? AND (e.id IS NULL OR e.complete = 0)`,
  ).all(today()) as { id: string; name: string; date: string }[];
}

export function status(db: DatabaseSync) {
  const rows = db.prepare('SELECT kind, status, COUNT(*) n FROM pages GROUP BY kind, status').all() as
    { kind: string; status: string; n: number }[];
  const by = (s: string) => rows.filter((r) => r.status === s).reduce((t, r) => t + r.n, 0);
  return { rows, done: by('done'), pending: by('pending'), failed: by('failed'), gone: by('gone') };
}

export { BlockedError };
