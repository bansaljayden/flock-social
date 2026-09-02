-- 059: the reconciled invoice figure moves out of code and into a table.
--
-- services/costModel.js carries RECONCILED, the one cost line a human has read
-- off a real invoice, as a hand-edited constant with a date beside it. That is
-- why it stood at a mid-month snapshot for twelve days on 2026-09-01: recording
-- a paid bill meant editing a JavaScript file and deploying. Jayden's ask that
-- day was that he should never have to do that to record a bill.
--
-- One row per reconciled line, keyed by the same id the constant uses, written
-- only by POST /api/admin/costs/reconciled behind the admin gate. The code
-- constant stays as the seed and the fallback: costModel.readReconciled merges
-- these rows over it, so a line with a row reads from here and a line without
-- one reads from code, and the admin panel says which.
--
-- Pure CREATE TABLE IF NOT EXISTS, no backfill, so the boot-safety replay in
-- __tests__/migrationBootSafety.test.js can apply it over live data and over an
-- empty database alike.
CREATE TABLE IF NOT EXISTS cost_reconciled (
  line_id        TEXT PRIMARY KEY,
  usd_per_month  NUMERIC(10, 2) NOT NULL CHECK (usd_per_month >= 0),
  as_of          DATE NOT NULL,
  note           TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     INTEGER
);
