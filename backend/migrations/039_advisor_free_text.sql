-- Free-text questions get their own meter on the advisor's per-venue ledger
-- (services/advisorPhrasing.js, table created by 037).
--
-- Why a THIRD counter rather than reusing `answers`. A chip answer is one
-- model call over a fact block the server sized itself. A typed question is at
-- least two calls (a classifier pass, then either the phrasing model or the
-- advice model) over a prompt that carries the owner's own words, and it is
-- the only advisor path where the caller influences the payload at all. Those
-- are different risks and they deserve different ceilings, so the free-text
-- cap is set LOWER than the chip cap and counted separately. Sharing one
-- column would let a day of chips lock the owner out of typing, or a loop of
-- typed questions eat the chip budget, and neither is the behaviour we want.
--
-- Charged in the same all-or-nothing upsert as the other two columns, so a
-- venue cannot buy the question count without paying its tokens.

ALTER TABLE advisor_venue_spend
  ADD COLUMN IF NOT EXISTS questions integer NOT NULL DEFAULT 0;
