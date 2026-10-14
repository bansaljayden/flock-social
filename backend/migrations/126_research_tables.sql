-- 126: research data kept in tables of their own, apart from every production
-- table: the open real counts of the external replication study, the visual
-- counts that score the thermal counter's sealed tests, and the headline
-- numbers of the research paper with the file each one comes from.
--
-- ASCII only, like 122, 123 and 125: the embedded server the boot-safety
-- suite runs is WIN1252.
--
-- WHY. Three forecast findings were measured on a commercial provider's
-- relative 0-100 readings: persistence of the latest reading beats the
-- typical-week curve, the curve is poorly calibrated, and a departure from it
-- fades within hours. A pre-registered replication
-- (studies/replication/ANALYSIS-PLAN.md and AMENDMENT-1) re-tested them on
-- open pedestrian, transit, trail and occupancy counts: 15 datasets, 315
-- sites, 14 places. These tables hold exactly the hourly rows that analysis
-- used, with each source's licence and the attribution it requires, so a later
-- comparison (for example provider readings beside the Brisbane counters) can
-- join against the counts without downloading them again.
--
-- WHAT THEY HOLD.
--   research_external_sources: one row per source, keyed by the dataset id the
--     replication used ('brisbane', 'melbourne_2019', 'nyc_subway', ...):
--     title, publisher, city, country, kind of count, licence, licence URL,
--     the licence wording as published, the attribution text the licence
--     requires, the URLs downloaded, the download date, and the training span
--     and scoring window the analysis used.
--   research_external_counts: one row per (source, site_id, local hour): the
--     site's name, the local wall-clock hour the count starts at, as the
--     publisher stamps it (TIMESTAMP without time zone; never converted), the
--     count, and whether the publisher suppressed it. The count is NUMERIC
--     because one source, kit_seatfinder, is an hourly mean of 5-minute
--     seat-occupancy readings; every other source holds whole numbers. Brisbane prints counts
--     under 25 as "<25"; those rows carry count NULL and is_suppressed TRUE.
--
-- WHO WRITES IT. Nothing in the app. A one-off loader kept outside this repo
-- (studies/replication/db/load_research_external_counts.js) inserts the tidy
-- CSVs with ON CONFLICT DO NOTHING, so running it twice adds nothing. About
-- 5.3 million count rows and 15 source rows.
--
-- WHO READS IT. Nothing in the app. Research queries only.
--
-- LICENCES TRAVEL WITH THE ROWS. Every count row references its source row,
-- so a count cannot be stored without its licence and attribution. One
-- source, campus_gym, is under the ODbL: a database derived from it and made
-- public must be offered under the ODbL as well.
--
-- THE KEY IS THE INDEX ASKED FOR. The primary key is (source, site_id,
-- ts_local), which Postgres backs with a unique btree on exactly those
-- columns: it serves one site's series in time order and is the conflict
-- target of the loader. The second index, (source, ts_local), serves a time
-- window across all sites of a source.
--
-- ADDITIVE. Two new tables and one extra index; no existing table is touched.
-- A replay is a no-op (IF NOT EXISTS throughout).
-- @requires table research_external_sources
-- @requires table research_external_counts
-- @requires column research_external_counts.is_suppressed
-- @requires table research_owl_counts
-- @requires table research_results

CREATE TABLE IF NOT EXISTS research_external_sources (
  source          TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  publisher       TEXT NOT NULL,
  city            TEXT NOT NULL,
  country         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  licence         TEXT NOT NULL,
  licence_url     TEXT,
  licence_terms   TEXT,
  attribution     TEXT NOT NULL,
  source_urls     JSONB NOT NULL DEFAULT '[]'::jsonb,
  downloaded_on   DATE NOT NULL,
  training_start  DATE,
  training_end    DATE,
  scoring_start   DATE,
  scoring_end     DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_external_counts (
  source         TEXT NOT NULL REFERENCES research_external_sources (source),
  site_id        TEXT NOT NULL,
  site_name      TEXT NOT NULL,
  ts_local       TIMESTAMP NOT NULL,
  count          NUMERIC,
  is_suppressed  BOOLEAN NOT NULL DEFAULT FALSE,
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT research_external_counts_pkey PRIMARY KEY (source, site_id, ts_local),
  CONSTRAINT research_external_counts_count_nonneg CHECK (count IS NULL OR count >= 0),
  CONSTRAINT research_external_counts_suppressed_null CHECK (NOT is_suppressed OR count IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_research_external_counts_source_ts
  ON research_external_counts (source, ts_local);


-- research_owl_counts: one row per frame of a thermal test set the paper
-- scores against counts made for it (the sealed office set, the recounted
-- classroom frames). count_final is the agreed count; pass1 to pass3 are the
-- independent blind passes (pass3 only where the first two disagreed) and
-- resolution says how the final count was reached. owl_count and rule_count
-- were stored before any count was made; original_label is the dataset's own
-- label where it has one. No image is stored.
CREATE TABLE IF NOT EXISTS research_owl_counts (
  set_name        TEXT NOT NULL,
  frame_id        TEXT NOT NULL,
  count_final     INTEGER,
  count_pass1     INTEGER,
  count_pass2     INTEGER,
  count_pass3     INTEGER,
  resolution      TEXT,
  owl_count       INTEGER,
  rule_count      INTEGER,
  original_label  INTEGER,
  loaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT research_owl_counts_pkey PRIMARY KEY (set_name, frame_id)
);

-- research_results: the paper's headline numbers, one row per (study, key),
-- with the population each was measured on and the file that computed it.
CREATE TABLE IF NOT EXISTS research_results (
  study        TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        DOUBLE PRECISION,
  lo           DOUBLE PRECISION,
  hi           DOUBLE PRECISION,
  unit         TEXT,
  population   TEXT,
  source_file  TEXT,
  computed_on  DATE,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT research_results_pkey PRIMARY KEY (study, key)
);
