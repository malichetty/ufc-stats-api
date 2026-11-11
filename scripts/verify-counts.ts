/**
 * Compares the Studio tables with the ufcstats pages they came from (the stored raw pages), and, with --full,
 * with the public reference dataset's totals (Greco1899/scrape_ufc_stats, 2026-11-08).
 *   UFC_DATA_DIR=... node scripts/verify-counts.ts [--full]
 */
import zlib from 'node:zlib';
import { openDb } from '../scraper/db.ts';
import { EVENTS_LIST_URL, parseEvent, parseEventsList, parseFight } from '../scraper/parse.ts';

const db = openDb();
const raw = (url: string) => {
  const r = db.prepare('SELECT html_gz FROM raw_pages WHERE url = ?').get(url) as { html_gz: Uint8Array } | undefined;
  return r ? zlib.gunzipSync(r.html_gz).toString('utf8') : null;
};
const n = (sql: string, ...a: string[]) => (db.prepare(sql).get(...a) as { n: number }).n;

const problems: string[] = [];
const events = db.prepare('SELECT id, name FROM events WHERE scraped_at IS NOT NULL ORDER BY date DESC').all() as { id: string; name: string }[];
const rows: string[][] = [];
let pageFights = 0, ourFights = 0, pageRounds = 0, ourRoundRows = 0;
for (const e of events) {
  const html = raw(`http://ufcstats.com/event-details/${e.id}`);
  if (!html) continue;
  const card = parseEvent(e.id, html).fights;
  const ours = n('SELECT COUNT(*) n FROM fights WHERE event_id = ? AND page_scraped_at IS NOT NULL', e.id);
  pageFights += card.length;
  ourFights += ours;
  let evRounds = 0, evRows = 0;
  for (const f of card) {
    const fh = raw(`http://ufcstats.com/fight-details/${f.id}`);
    if (!fh) continue;
    const pf = parseFight(f.id, fh);
    const stored = n('SELECT COUNT(*) n FROM fight_stats WHERE fight_id = ? AND round > 0', f.id);
    const expected = pf.stats.length ? (pf.round ?? 0) * 2 : 0;
    evRounds += expected;
    evRows += stored;
    if (stored !== expected) problems.push(`fight ${f.id}: page says ${pf.round} rounds (${expected} rows), stored ${stored}`);
  }
  pageRounds += evRounds;
  ourRoundRows += evRows;
  if (events.length <= 20) rows.push([e.name, String(card.length), String(ours), String(evRounds), String(evRows)]);
  if (card.length !== ours) problems.push(`event ${e.id} ${e.name}: page lists ${card.length} fights, stored ${ours}`);
}

if (rows.length) {
  console.log('| Event | Fights on page | Fights stored | Round rows expected | Round rows stored |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
}
console.log(`\nfights: ${ourFights} stored of ${pageFights} on event pages; per-round rows: ${ourRoundRows} stored of ${pageRounds} expected`);
const fighterIds = n(`SELECT COUNT(*) n FROM (SELECT fighter1_id f FROM fights UNION SELECT fighter2_id FROM fights) WHERE f IS NOT NULL`);
const profiles = n('SELECT COUNT(*) n FROM fighters WHERE profile_scraped_at IS NOT NULL');
console.log(`fighters in stored fights: ${fighterIds}; fighter profiles stored: ${profiles}`);

if (process.argv.includes('--full')) {
  const listed = parseEventsList(raw(EVENTS_LIST_URL) ?? '').length;
  const ref = { events: 796, fights: 9015, round_rows: 42356, fighters: 4628 };
  const ours = {
    events: n('SELECT COUNT(*) n FROM events WHERE scraped_at IS NOT NULL'),
    fights: n('SELECT COUNT(*) n FROM fights WHERE page_scraped_at IS NOT NULL'),
    round_rows: n('SELECT COUNT(*) n FROM fight_stats WHERE round > 0'),
    fighters: profiles,
  };
  console.log(`\nevents listed on ufcstats: ${listed}`);
  console.log('| | Reference (2026-11-08) | Ours | Difference |');
  console.log('|---|---|---|---|');
  for (const k of Object.keys(ref) as (keyof typeof ref)[]) {
    const d = ((ours[k] - ref[k]) / ref[k]) * 100;
    console.log(`| ${k} | ${ref[k]} | ${ours[k]} | ${d >= 0 ? '+' : ''}${d.toFixed(2)}% |`);
    if (Math.abs(d) > 1) problems.push(`${k}: ${ours[k]} vs reference ${ref[k]} (${d.toFixed(2)}%)`);
  }
}

console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.slice(0, 30).join('\n  ')}` : '\nno problems');
process.exitCode = problems.length ? 1 : 0;
