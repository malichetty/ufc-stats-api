-- Serving tables. The Studio builds every row (scraper/build.ts); the Worker only reads.
-- `summary` and `doc` are finished JSON responses, so a detail request is one primary-key read.

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,          -- 1 = oldest event; dense, so list paging reads only `limit` rows
  name TEXT NOT NULL,
  date TEXT,
  year INTEGER,
  summary TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX events_seq ON events(seq);
CREATE INDEX events_year ON events(year, seq);

CREATE TABLE fights (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,          -- 1 = oldest fight; within an event the main event has the highest seq
  event_id TEXT NOT NULL,
  date TEXT,
  fighter1_id TEXT,
  fighter2_id TEXT,
  winner_id TEXT,
  method TEXT,
  weight_class TEXT,
  title_bout INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX fights_seq ON fights(seq);
CREATE INDEX fights_event ON fights(event_id, seq);
CREATE INDEX fights_fighter1 ON fights(fighter1_id, seq);
CREATE INDEX fights_fighter2 ON fights(fighter2_id, seq);
CREATE INDEX fights_method ON fights(method, seq);
CREATE INDEX fights_weight_class ON fights(weight_class COLLATE NOCASE, seq);

CREATE TABLE fighters (
  id TEXT PRIMARY KEY,
  name TEXT,
  sort_name TEXT NOT NULL,
  stance TEXT,
  weight_class TEXT,
  wins INTEGER,
  losses INTEGER,
  draws INTEGER,
  total_fights INTEGER,
  is_champion INTEGER NOT NULL DEFAULT 0,
  slpm REAL, str_acc REAL, sapm REAL, str_def REAL,
  td_avg REAL, td_acc REAL, td_def REAL, sub_avg REAL,
  summary TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX fighters_sort_name ON fighters(sort_name, id);
CREATE INDEX fighters_stance ON fighters(stance COLLATE NOCASE, sort_name);
CREATE INDEX fighters_weight_class ON fighters(weight_class COLLATE NOCASE, sort_name);
CREATE INDEX fighters_wins ON fighters(wins);
CREATE INDEX fighters_losses ON fighters(losses);
CREATE INDEX fighters_draws ON fighters(draws);
CREATE INDEX fighters_slpm ON fighters(slpm);
CREATE INDEX fighters_str_acc ON fighters(str_acc);
CREATE INDEX fighters_sapm ON fighters(sapm);
CREATE INDEX fighters_str_def ON fighters(str_def);
CREATE INDEX fighters_td_avg ON fighters(td_avg);
CREATE INDEX fighters_td_acc ON fighters(td_acc);
CREATE INDEX fighters_td_def ON fighters(td_def);
CREATE INDEX fighters_sub_avg ON fighters(sub_avg);

-- Word-prefix search index over fighter names and nicknames ("mcg" finds Conor McGregor), so search never scans.
CREATE TABLE name_tokens (
  token TEXT NOT NULL,
  fighter_id TEXT NOT NULL,
  PRIMARY KEY (token, fighter_id)
) WITHOUT ROWID;
CREATE INDEX name_tokens_fighter ON name_tokens(fighter_id);

-- Same for event names ("ufc 229").
CREATE TABLE event_tokens (
  token TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (token, event_id)
) WITHOUT ROWID;
CREATE INDEX event_tokens_event ON event_tokens(event_id);

-- data_version, counts, overview, kill switch
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY,     -- sha256 of the key; the key itself is never stored
  label TEXT NOT NULL,
  per_day INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
