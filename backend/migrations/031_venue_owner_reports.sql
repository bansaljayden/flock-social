-- 031: venue_owner_reports — the owner's own 0-100 "how full are we right now"
--
-- (029 is skipped, like 010: 030 was claimed by venue_intake while this was
-- being designed, and reusing a number that ever existed in any branch is how
-- schema_migrations gets two files with one name.)
--
-- WHY THIS TABLE EXISTS. BestTime collection stopped 2026-05-18 and the corpus
-- is frozen; the 3-level user report (venue_feedback.crowd_level in {1,2,3})
-- cannot locate the centre of a 20-point window, so the per-venue calibration
-- layer measures exactly zero on it (MODEL-EPOCH-FINDING.md: +0.122pp, CI
-- straddling zero, against +1.661pp on real 0-100 observations). This slider is
-- the only live 0-100 label source in the plan. It is also the one reading the
-- model can never beat while it is fresh: the operator can see the room.
--
-- WHAT A ROW IS. One assertion, by the venue's claimed-and-verified owner
-- account, that the building is at busy_percent right now. It is:
--
--   * ATTRIBUTABLE — venue_user_id is the authenticated owner, and every
--     surface that publishes the number labels it as the venue's own claim
--     (the category-derived attribution from utils/venueLabel.js, never
--     Flock's own voice). A user seeing 72% can tell who said it.
--   * PERISHABLE — the serve path reads only rows younger than 90 minutes
--     (services/ownerReports.js OWNER_REPORT_TTL_MINUTES; the SQL interval and
--     the constant are pinned equal by __tests__/ownerBusyReports.test.js).
--     70% set at 8pm is misleading at 11pm, and forgetting to clear it is the
--     NORMAL case, so expiry is automatic and the published number falls back
--     to the prediction on its own. No expiry column: created_at plus the one
--     constant is the whole rule, so there is no second clock to drift.
--   * REVERSIBLE — retracted=true is the owner's own kill switch
--     (DELETE /api/venue-dashboard/busy-now). Rows are never deleted: a
--     retracted or expired reading is still a labelled observation of a
--     venue-hour, which is the training-corpus half of why this exists.
--   * ACCOUNTABLE — diverged=true is stamped by the serve path when three or
--     more verified user reporters contradicted a live owner reading by more
--     than OWNER_DIVERGENCE_POINTS. Three diverged rows inside 30 days and the
--     override is suppressed for that venue: the number users see reverts to
--     the prediction until the strikes age out. "Packed" as social proof and
--     "quiet, come now" to fill seats are both plausible strategies and both
--     corrupt the signal; repeated divergence from the people actually in the
--     room has to cost the venue the thing it was gaming (VENUE-ADVISOR.md).
--
-- WHAT THIS IS NOT. Not a paid feature. The write path carries no
-- requireVenueTier and never may: a business paying to influence a number
-- consumers rely on is the LendEDU order (FTC 2020, undisclosed paid ratings).
-- The reading is labelled, free at every tier, and outranked by real user
-- reports, which is what keeps it a disclosure rather than an advertisement.
--
-- TRAINING PATH: export-only. scripts/ml/train/export_training_data.js emits
-- these as label_source='owner_report' rows (owner-median anchored, handoff
-- weight 0.10). Nothing here may ever write ml_venue_baselines: the serving
-- baseline is Google's curve on the venue's clock, and feeding it self-reports
-- would let an owner steer the model's anchor as well as tonight's number.

CREATE TABLE IF NOT EXISTS venue_owner_reports (
  id SERIAL PRIMARY KEY,
  venue_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_place_id VARCHAR(255) NOT NULL,
  busy_percent SMALLINT NOT NULL CHECK (busy_percent BETWEEN 0 AND 100),
  retracted BOOLEAN NOT NULL DEFAULT false,
  diverged BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The serve path's read: newest live row per place id. Partial on the live
-- predicate's cheap half (retracted) — created_at recency is range-scanned.
CREATE INDEX IF NOT EXISTS idx_venue_owner_reports_place_created
  ON venue_owner_reports (google_place_id, created_at DESC)
  WHERE retracted = false;

-- The rate limiter's read (reports today by this owner) and the export's
-- per-venue sweep.
CREATE INDEX IF NOT EXISTS idx_venue_owner_reports_user_created
  ON venue_owner_reports (venue_user_id, created_at DESC);
