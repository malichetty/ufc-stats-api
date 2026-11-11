import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
