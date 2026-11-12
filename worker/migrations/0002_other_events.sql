-- Events ufcstats leaves off its completed list (PRIDE, WEC, Strikeforce, Contender Series, Road to UFC).
-- Lists stay UFC-only unless ?include=all. `seq` now orders every row; `ufc_seq` is dense over UFC rows only (0 for
-- the rest), so default paging is still an index range of exactly `limit` rows.
ALTER TABLE events ADD COLUMN ufc INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN ufc_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX events_ufc_seq ON events(ufc_seq);

ALTER TABLE fights ADD COLUMN ufc INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fights ADD COLUMN ufc_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX fights_ufc_seq ON fights(ufc_seq);

-- Set only for fighters with fights outside the UFC list: the ?include=all versions of summary and doc.
ALTER TABLE fighters ADD COLUMN summary_all TEXT;
ALTER TABLE fighters ADD COLUMN doc_all TEXT;
