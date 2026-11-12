import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EVENTS_LIST_URL, parseEventsList } from './parse.ts';

export const DATA_DIR = process.env.UFC_DATA_DIR ?? path.join(os.homedir(), 'ufc-stats-data');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- crawl list: one row per URL; status pending | done | failed
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS pages_status ON pages(status, kind);

CREATE TABLE IF NOT EXISTS raw_pages (
  url TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  html_gz BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT,
  location TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 0, -- on ufcstats' completed-events list; 0 = found only through a fighter profile
  first_seen_at TEXT NOT NULL,
  scraped_at TEXT
);

CREATE TABLE IF NOT EXISTS fights (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  bout_order INTEGER,
  fighter1_id TEXT,
  fighter2_id TEXT,
  fighter1_name TEXT,
  fighter2_name TEXT,
  fighter1_nickname TEXT,
  fighter2_nickname TEXT,
  fighter1_result TEXT,
  fighter2_result TEXT,
  weight_class TEXT,
  bout TEXT,
  title_bout INTEGER NOT NULL DEFAULT 0,
  bonuses TEXT NOT NULL DEFAULT '[]',
  method TEXT,
  method_short TEXT,
  method_detail TEXT,
  details TEXT,
  round INTEGER,
  time TEXT,
  time_format TEXT,
  referee TEXT,
  page_scraped_at TEXT
);
CREATE INDEX IF NOT EXISTS fights_event ON fights(event_id);

CREATE TABLE IF NOT EXISTS fight_stats (
  fight_id TEXT NOT NULL,
  fighter_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  kd INTEGER, sig_landed INTEGER, sig_attempted INTEGER, total_landed INTEGER, total_attempted INTEGER,
  td_landed INTEGER, td_attempted INTEGER, sub_att INTEGER, rev INTEGER, ctrl_seconds INTEGER,
  head_landed INTEGER, head_attempted INTEGER, body_landed INTEGER, body_attempted INTEGER,
  leg_landed INTEGER, leg_attempted INTEGER, distance_landed INTEGER, distance_attempted INTEGER,
  clinch_landed INTEGER, clinch_attempted INTEGER, ground_landed INTEGER, ground_attempted INTEGER,
  PRIMARY KEY (fight_id, fighter_id, round)
);

CREATE TABLE IF NOT EXISTS fighters (
  id TEXT PRIMARY KEY,
  name TEXT,
  first_name TEXT,
  last_name TEXT,
  nickname TEXT,
  record TEXT,
  wins INTEGER, losses INTEGER, draws INTEGER, no_contests INTEGER,
  height TEXT, height_inches INTEGER, weight TEXT, weight_lbs REAL, reach TEXT, reach_inches REAL,
  stance TEXT, dob TEXT,
  slpm REAL, str_acc REAL, sapm REAL, str_def REAL, td_avg REAL, td_acc REAL, td_def REAL, sub_avg REAL,
  is_champion INTEGER NOT NULL DEFAULT 0,
  profile_scraped_at TEXT
);

-- What the a-z fighter list pages say (names, nickname, champion belt), for every listed fighter, known or not:
-- the weekly run reads the lists before it meets this week's new fighters.
CREATE TABLE IF NOT EXISTS listed_fighters (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  nickname TEXT,
  is_champion INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS upcoming_events (
  id TEXT PRIMARY KEY,
  name TEXT,
  date TEXT,
  location TEXT,
  seen_at TEXT NOT NULL
);

-- URLs to fetch again on the next weekly run
CREATE TABLE IF NOT EXISTS flags (
  url TEXT PRIMARY KEY,
  flagged_at TEXT NOT NULL
);

-- what was last loaded into each D1 target, by content hash
CREATE TABLE IF NOT EXISTS served (
  target TEXT NOT NULL,
  tbl TEXT NOT NULL,
  id TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (target, tbl, id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  outcome TEXT
);
`;

export function openDb(dir = DATA_DIR): DatabaseSync {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'ufc.sqlite'));
  db.exec(SCHEMA);
  const cols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('listed')) {
    db.exec('ALTER TABLE events ADD COLUMN listed INTEGER NOT NULL DEFAULT 0');
    // A warehouse from before the flag: set it from the stored completed list, so a sync before the next crawl
    // doesn't publish every event as off the list.
    const list = db.prepare('SELECT html_gz FROM raw_pages WHERE url = ?').get(EVENTS_LIST_URL) as { html_gz: Uint8Array } | undefined;
    const ids = list ? parseEventsList(zlib.gunzipSync(list.html_gz).toString('utf8')).map((e) => e.id) : [];
    db.prepare('UPDATE events SET listed = 1 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
  }
  return db;
}

export const nowIso = () => new Date().toISOString();

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
