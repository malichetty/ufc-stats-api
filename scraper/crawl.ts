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
  /** weekly mode: event pages queued from fighter-profile links so far this run */
  discovered?: number;
}

const PRIORITY: Record<PageKind, number> = {
  events_list: 0, upcoming_list: 0, fighter_list: 1, event: 2, fight: 3, fighter: 4,
};
const MAX_ATTEMPTS = 3;
/** About 5 minutes a run at the crawl's pace. */
const PROFILE_REFRESH_PER_RUN = 100;
const MAX_FAILURES_IN_A_ROW = 5;
/** Real profiles link at most 50 events; far more means the page isn't what it claims. */
const MAX_EVENT_LINKS_PER_PROFILE = 100;
/** A weekly run finds a handful of new off-list cards at most; more waits for the next run. */
const MAX_DISCOVERED_EVENTS_PER_RUN = 25;
/** Stored text fields are at most ~150 characters on ufcstats; a field far over that is a broken or hostile page. */
const MAX_TEXT = 2_000;
/** Answered but unusable (404, refused page): more in a row than a weekly run's discovery cap means ufcstats changed. */
const MAX_UNUSABLE_IN_A_ROW = MAX_DISCOVERED_EVENTS_PER_RUN + MAX_FAILURES_IN_A_ROW;

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * force: queue the page again even if it was fetched. 'refresh' does the same but leaves a 404'd ('gone') page alone,
 * for the automatic re-queues; `true` (flag, enqueue) reopens it on purpose.
 */
export function enqueue(db: DatabaseSync, url: string, force: boolean | 'refresh' = false): boolean {
  const kind = kindOf(url);
  if (force) {
    return db.prepare(
      `INSERT INTO pages (url, kind, status) VALUES (?, ?, 'pending')
       ON CONFLICT(url) DO UPDATE SET status = 'pending', attempts = 0, last_error = NULL
       ${force === 'refresh' ? "WHERE pages.status != 'gone'" : ''}`,
    ).run(url, kind).changes > 0;
  }
  return db.prepare(`INSERT OR IGNORE INTO pages (url, kind, status) VALUES (?, ?, 'pending')`).run(url, kind).changes > 0;
}

/**
 * A ufcstats layout change parses as empty or blank rather than failing, and writing that would wipe good stored data.
 * Throwing here, before any write, makes it a page failure: retried, reported, and nothing changes.
 */
function unrecognised(what: string, detail: string): never {
  throw new Error(`${what} not recognised (${detail}); layout change? Nothing updated`);
}

/** Every string in a parsed page, however nested, must be a plausible length before anything is written. */
function capped(what: string, parsed: unknown): void {
  const walk = (v: unknown, at: string): void => {
    if (typeof v === 'string') { if (v.length > MAX_TEXT) unrecognised(what, `${at} is ${v.length} characters`); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
  };
  walk(parsed, '');
}

/** Parse a fetched page into the tables and queue the pages it links to. */
export function ingest(db: DatabaseSync, url: string, html: string, opts: CrawlOptions): void {
  const kind = kindOf(url);
  const now = nowIso();
  const id = url.split('/').pop()!;

  if (kind === 'events_list') {
    const parsed = parseEventsList(html);
    capped('completed-events list', parsed);
    // A layout change on ufcstats would parse as an empty or short list, and a whole-list read would then mark every
    // stored event as off the list. Refuse it: the page counts as failed and nothing changes.
    const had = (db.prepare('SELECT COUNT(*) n FROM events WHERE listed = 1').get() as { n: number }).n;
    if (parsed.length === 0 || parsed.length < had * 0.9) {
      unrecognised('completed-events list', `${parsed.length} events, under 90% of the ${had} stored`);
    }
    let listed = parsed.filter((e) => !e.date || e.date <= today());
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
    const parsed = parseEventsList(html);
    capped('upcoming-events list', parsed);
    // The completed list wins: a card on it can't also be upcoming, or the next build would withhold it. Dropped, not
    // refused, because a stored upcoming page older than the completed one overlaps it and would abort a reparse.
    const done = db.prepare('SELECT 1 FROM events WHERE id = ? AND listed = 1');
    const upcoming = parsed.filter((e) => !done.get(e.id));
    const hadUpcoming = (db.prepare('SELECT COUNT(*) n FROM upcoming_events').get() as { n: number }).n;
    if (parsed.length === 0 && hadUpcoming > 0) unrecognised('upcoming-events list', `0 events, ${hadUpcoming} stored`);
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
    const listedFighters = parseFighterList(html);
    capped('fighter list page', listedFighters);
    if (listedFighters.length === 0) unrecognised('fighter list page', '0 fighters');
    for (const f of listedFighters) {
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
    if (!e.name) unrecognised('event page', 'no event name');
    capped('event page', e);
    // An upcoming card can be empty for a while; a card that already happened never is.
    if (e.fights.length === 0 && e.date && e.date <= today()) unrecognised('event page', 'past event with no fights');
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
         ON CONFLICT(id) DO UPDATE SET
           -- A card lists fights, but only the fight's own page (which links its event) may move a stored fight.
           event_id = CASE WHEN fights.page_scraped_at IS NULL THEN excluded.event_id ELSE fights.event_id END,
           bout_order = excluded.bout_order,
           weight_class = excluded.weight_class, bonuses = excluded.bonuses, method_short = excluded.method_short,
           method_detail = excluded.method_detail, round = COALESCE(fights.round, excluded.round),
           time = COALESCE(fights.time, excluded.time)`,
      ).run(f.id, e.id, f.bout_order, f.fighter1_id, f.fighter2_id, f.fighter1_name, f.fighter2_name,
        f.weight_class, JSON.stringify(f.bonuses), f.method, f.method_detail, f.round, f.time);
      // Fetch the fight page again while it has no result (the event page shows none yet, or we stored the fight page
      // before the result was posted), or when this card claims a fight stored under another event (a merged card).
      const stored = db.prepare('SELECT fighter1_result r, page_scraped_at at, event_id ev FROM fights WHERE id = ?').get(f.id) as
        { r: string | null; at: string | null; ev: string } | undefined;
      const recheck = f.flags.length === 0 || (!!stored?.at && (stored.r === null || stored.ev !== e.id));
      enqueue(db, fightUrl(f.id), recheck ? 'refresh' : false);
    }
    return;
  }

  if (kind === 'fight') {
    const f = parseFight(id, html);
    if (f.fighters.length < 2) unrecognised('fight page', `${f.fighters.length} fighters`);
    capped('fight page', f);
    const before = db.prepare('SELECT page_scraped_at, fighter1_result FROM fights WHERE id = ?').get(id) as
      | { page_scraped_at: string | null; fighter1_result: string | null } | undefined;
    const [a, b] = f.fighters;
    db.prepare(
      `INSERT INTO fights (id, event_id, fighter1_id, fighter2_id, fighter1_name, fighter2_name, fighter1_nickname,
         fighter2_nickname, fighter1_result, fighter2_result, bout, title_bout, method, details, round, time,
         time_format, referee, page_scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET event_id = COALESCE(NULLIF(excluded.event_id, ''), fights.event_id),
         fighter1_id = excluded.fighter1_id, fighter2_id = excluded.fighter2_id,
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
      enqueue(db, fighterUrl(p.id), changed && opts.mode !== 'full' ? 'refresh' : false);
    }
    return;
  }

  if (kind === 'fighter') {
    const p = parseFighter(id, html);
    if (!p.name) unrecognised('fighter page', 'no name');
    capped('fighter page', p);
    if (p.event_ids.length > MAX_EVENT_LINKS_PER_PROFILE) unrecognised('fighter page', `${p.event_ids.length} event links`);
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
      const queued = db.prepare('SELECT 1 FROM pages WHERE url = ?');
      for (const ev of p.event_ids) {
        if (known.get(ev) || queued.get(eventUrl(ev))) continue;
        if (opts.mode === 'weekly' && (opts.discovered ?? 0) >= MAX_DISCOVERED_EVENTS_PER_RUN) {
          // Over this run's cap: flag the profile so the next weekly run reads it again and queues the rest.
          db.prepare('INSERT OR REPLACE INTO flags (url, flagged_at) VALUES (?, ?)').run(url, now);
          (opts.log ?? console.log)(`discovery cap of ${MAX_DISCOVERED_EVENTS_PER_RUN} events reached; ${url} is read again next run`);
          break;
        }
        if (enqueue(db, eventUrl(ev))) opts.discovered = (opts.discovered ?? 0) + 1;
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
  let unusable: string[] = [];
  let stopping = false;
  const stop = (sig: string) => {
    log(`${sig} received; finishing the current page and stopping`);
    stopping = true;
  };
  // No answer (timeout, 5xx, challenge) on 5 first tries in a row stops the run: the sign ufcstats stopped answering.
  // Retries of pages that failed before are that page's problem. An answer we can't use (4xx, a page ingest refuses)
  // never stops the run, so links a bad page plants can't hold back the load. A 404 is final ('gone'; `pnpm flag`
  // reopens it), except in a streak of 30 unusable answers in a row: that is ufcstats changing or failing, not those
  // pages, so the whole streak is kept as 'failed' (one quiet retry each run) and nothing is retried this run.
  const fail = (next: { url: string; attempts: number }, e: unknown, answered: boolean) => {
    const msg = (e as Error).message;
    const attempts = next.attempts + 1;
    const status = /HTTP 404/.test(msg) ? 'gone' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    db.prepare(`UPDATE pages SET attempts = ?, last_error = ?, status = ? WHERE url = ?`)
      .run(attempts, String(msg).slice(0, 500), status, next.url);
    log(`error on ${next.url}: ${msg}`);
    if (answered) {
      unusable.push(next.url);
      if (unusable.length >= MAX_UNUSABLE_IN_A_ROW) {
        if (unusable.length === MAX_UNUSABLE_IN_A_ROW) log(`${MAX_UNUSABLE_IN_A_ROW} unusable answers in a row; ufcstats may have changed`);
        db.prepare(`UPDATE pages SET status = 'failed', attempts = ? WHERE url IN (SELECT value FROM json_each(?))`)
          .run(MAX_ATTEMPTS, JSON.stringify(unusable));
      }
      return;
    }
    if (next.attempts === 0 && ++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
      throw new BlockedError(`${MAX_FAILURES_IN_A_ROW} page failures in a row; stopping (last: ${msg})`);
    }
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
      let html: string;
      try {
        html = await fetcher.get(next.url);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        fail(next, e, /HTTP 4\d\d/.test((e as Error).message));
        continue;
      }
      try {
        tx(db, () => {
          db.prepare('INSERT OR REPLACE INTO raw_pages (url, fetched_at, html_gz) VALUES (?, ?, ?)')
            .run(next.url, nowIso(), zlib.gzipSync(html));
          ingest(db, next.url, html, opts);
          db.prepare(`UPDATE pages SET status = 'done', fetched_at = ?, last_error = NULL WHERE url = ?`)
            .run(nowIso(), next.url);
        });
        fetched++;
        failuresInARow = 0;
        unusable = [];
        if (fetched % 50 === 0) log(`fetched ${fetched} pages (last: ${next.url})`);
      } catch (e) {
        fail(next, e, true);
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
    enqueue(db, eventUrl(e.id), 'refresh');
  }
  // Off-list cards (Contender Series, Road to UFC) are linked only from fighter profiles, and a later tournament
  // round can be all known fighters. So each run also re-reads some known profiles (Aris approved 2026-11-12): half
  // from fighters on an off-list card in the last two years, half from everyone else, longest unread first in each,
  // so neither group starves the other.
  // NULLs filtered out: one NULL in a NOT IN list makes it match nothing.
  const recent = `SELECT id FROM (
      SELECT f.fighter1_id id FROM fights f JOIN events e ON e.id = f.event_id WHERE e.listed = 0 AND e.date BETWEEN date('now', '-2 years') AND date('now')
      UNION SELECT f.fighter2_id FROM fights f JOIN events e ON e.id = f.event_id WHERE e.listed = 0 AND e.date BETWEEN date('now', '-2 years') AND date('now')
    ) WHERE id IS NOT NULL`;
  const pick = (inGroup: boolean, n: number) => db.prepare(
    `SELECT url FROM pages WHERE kind = 'fighter' AND status = 'done' AND substr(url, -16) ${inGroup ? '' : 'NOT '}IN (${recent})
     ORDER BY fetched_at LIMIT ?`,
  ).all(n) as { url: string }[];
  const fromRecent = pick(true, PROFILE_REFRESH_PER_RUN / 2);
  for (const r of [...fromRecent, ...pick(false, PROFILE_REFRESH_PER_RUN - fromRecent.length)]) enqueue(db, r.url, 'refresh');
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
