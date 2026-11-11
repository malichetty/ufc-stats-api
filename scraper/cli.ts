import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BlockedError, drain, enqueue, reparse, seed, status, unpublished, type CrawlOptions } from './crawl.ts';
import { nowIso, openDb } from './db.ts';
import { kindOf } from './parse.ts';
import { runWrangler, sync, D1_NAME, type Target } from './sync.ts';

const EXIT_BLOCKED = 2;
/** sysexits EX_TEMPFAIL: results not published yet; the retry run picks it up. */
const EXIT_NOT_YET = 75;

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    full: { type: 'boolean' },
    sample: { type: 'string' },
    since: { type: 'string' },
    target: { type: 'string' },
    'max-pages': { type: 'string' },
    'dry-run': { type: 'boolean' },
    'per-day': { type: 'string' },
  },
});
const [command, arg] = positionals;

function d1Target(): Target | null {
  const t = values.target ?? process.env.UFC_D1_TARGET ?? 'none';
  if (t === 'none') return null;
  if (t !== 'local' && t !== 'remote') throw new Error(`UFC_D1_TARGET must be local, remote or none (got ${t})`);
  return t;
}

/**
 * One run at a time on this machine, whatever the data folder: ufcstats should only ever see one page load at a time
 * from us, and a weekly run that starts during a long crawl would fetch the same pages twice.
 */
function lock(): () => void {
  const file = path.join(os.homedir(), '.ufc-stats-api.lock');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        log(`another run (pid ${pid}) is in progress; exiting`);
        process.exit(EXIT_NOT_YET);
      } catch { /* stale lock */ }
    }
  } catch { /* no lock */ }
  fs.writeFileSync(file, String(process.pid));
  return () => fs.rmSync(file, { force: true });
}

async function crawlRun(opts: CrawlOptions): Promise<number> {
  const db = openDb();
  const unlock = lock();
  const run = db.prepare('INSERT INTO runs (started_at, mode) VALUES (?, ?)').run(nowIso(), opts.mode);
  let outcome = 'ok';
  let fetched = 0;
  let code = 0;
  try {
    seed(db, opts);
    fetched = await drain(db, opts);
    log(`fetched ${fetched} pages`);
    const s = status(db);
    log(`crawl list: ${s.done} done, ${s.pending} pending, ${s.failed} failed`);
    if (opts.mode === 'weekly') {
      const late = unpublished(db);
      if (late.length) {
        outcome = `not published yet: ${late.map((e) => `${e.name} (${e.date})`).join(', ')}`;
        log(outcome);
        code = EXIT_NOT_YET;
      }
    }
    const target = d1Target();
    if (target) sync(db, target, { log });
  } catch (e) {
    if (e instanceof BlockedError) {
      outcome = `stopped: ${e.message}`;
      log(`STOPPED. ${e.message}. Not retrying; check ufcstats in a browser before running again.`);
      code = EXIT_BLOCKED;
    } else {
      outcome = `error: ${(e as Error).message}`;
      throw e;
    }
  } finally {
    db.prepare('UPDATE runs SET finished_at = ?, pages_fetched = ?, outcome = ? WHERE id = ?')
      .run(nowIso(), fetched, outcome, run.lastInsertRowid);
    unlock();
  }
  return code;
}

async function main(): Promise<number> {
  const maxPages = values['max-pages'] ? Number(values['max-pages']) : undefined;
  switch (command) {
    case 'crawl': {
      if (values.sample) return crawlRun({ mode: 'sample', sampleEvents: Number(values.sample), maxPages, log });
      if (values.full) return crawlRun({ mode: 'full', maxPages, log });
      throw new Error('crawl needs --full or --sample <events>');
    }
    case 'weekly':
      return crawlRun({ mode: 'weekly', since: values.since, maxPages, log });
    case 'status': {
      const db = openDb();
      const s = status(db);
      const total = s.done + s.pending + s.failed;
      const recent = db.prepare(`SELECT fetched_at FROM pages WHERE status = 'done' ORDER BY fetched_at DESC LIMIT 200`).all() as { fetched_at: string }[];
      let eta = 'unknown';
      if (recent.length > 10 && s.pending) {
        const span = Date.parse(recent[0].fetched_at) - Date.parse(recent[recent.length - 1].fetched_at);
        const perPage = span / (recent.length - 1);
        eta = `${((perPage * s.pending) / 3_600_000).toFixed(1)} h at ${(perPage / 1000).toFixed(1)} s/page`;
      }
      console.log(`pages: ${s.done} done of ${total} known (${s.pending} pending, ${s.failed} failed); time left: ${eta}`);
      for (const r of s.rows) console.log(`  ${r.kind.padEnd(14)} ${r.status.padEnd(8)} ${r.n}`);
      for (const t of ['events', 'fights', 'fight_stats', 'fighters']) {
        console.log(`  table ${t}: ${(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n}`);
      }
      const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 3').all();
      console.log('last runs:', runs);
      return 0;
    }
    case 'flag': {
      if (!arg) throw new Error('flag needs a ufcstats URL');
      kindOf(arg);
      openDb().prepare('INSERT OR REPLACE INTO flags (url, flagged_at) VALUES (?, ?)').run(arg, nowIso());
      log(`flagged ${arg}; the next weekly run fetches it again`);
      return 0;
    }
    case 'reparse': {
      const db = openDb();
      log(`re-parsed ${reparse(db, { mode: values.full ? 'full' : 'weekly', log })} stored pages`);
      return 0;
    }
    case 'enqueue': {
      if (!arg) throw new Error('enqueue needs a URL');
      enqueue(openDb(), arg, true);
      return 0;
    }
    case 'sync': {
      const target = d1Target();
      if (!target) throw new Error('sync needs --target local|remote');
      sync(openDb(), target, { log, dryRun: values['dry-run'] });
      return 0;
    }
    case 'key:create': {
      const target = d1Target();
      if (!arg || !target) throw new Error('usage: key:create <label> --target local|remote [--per-day 100000]');
      const key = `ufc_${crypto.randomBytes(18).toString('base64url')}`;
      const keyHash = crypto.createHash('sha256').update(key).digest('hex');
      const perDay = Number(values['per-day'] ?? 100_000);
      const label = arg.replace(/'/g, "''");
      runWrangler(['d1', 'execute', D1_NAME, `--${target}`, '--yes', '--command',
        `INSERT INTO api_keys (key_hash, label, per_day, created_at) VALUES ('${keyHash}', '${label}', ${perDay}, '${nowIso()}')`]);
      console.log(`API key for "${arg}" (shown once): ${key}`);
      return 0;
    }
    default:
      console.log('usage: cli.ts crawl --full | crawl --sample <n> | weekly [--since YYYY-MM-DD] | status | flag <url> | reparse | sync --target local|remote | key:create <label> --target ...');
      return command ? 1 : 0;
  }
}

process.exitCode = await main();
