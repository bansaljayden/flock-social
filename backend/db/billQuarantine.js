'use strict';
// ---------------------------------------------------------------------------
// THE QUARANTINE ON BILLS FROM BEFORE AUGUST 27, AS ONE PREDICATE.
// ---------------------------------------------------------------------------
//
// Migration 089 set bill_splits.quarantined on every bill made before
// 2026-08-27 04:00 UTC in a flock that could have had a budget, because the
// early ghost commit could copy one person's budget answer into such a bill
// (089's header has why whole bills, and which). The routes read the flag and
// nothing else: a bill whose flag is not true is an ordinary bill.
//
// A flag in a row does not survive every way the row can arrive. The restore
// runbook (BACKUP-AND-VERIFICATION.md, "Bringing Flock back from nothing")
// builds the schema with db/migrate.js on an EMPTY database, where 089 matches
// nothing and is recorded as applied, and only then loads the dump, whose
// INSERTs name the columns the source had. A dump taken before 089 has no
// quarantined column, so every legacy bill in it lands with the flag at its
// default, false, nothing runs 089 again, and GET hands one person's budget
// answer to the rest of the plan.
//
// So db/migrate.js runs REQUARANTINE_SQL after the files on every boot, before
// server.js calls listen(), and scripts/verify-backup.js fails a restored
// database on which COUNT_OUTSIDE_QUARANTINE_SQL finds anything after that
// boot. Both read the WHERE below, which is 089's own, word for word;
// __tests__/migrationBootSafety.test.js holds the two equal, and holds
// migration 090's index to the same text so the boot reads nothing when there
// is nothing to change.
// ---------------------------------------------------------------------------

// A bill still outside the quarantine, made before the cut-off (or with no
// creation time at all), in a flock whose budget flag is not false or that
// holds a budget answer.
const LEGACY_BILL_OUTSIDE_QUARANTINE = `b.quarantined = false
   AND (b.created_at IS NULL OR b.created_at < TIMESTAMPTZ '2026-08-27 04:00:00+00')
   AND EXISTS (SELECT 1 FROM flocks f
                WHERE f.id = b.flock_id
                  AND (f.budget_enabled IS NOT FALSE
                       OR EXISTS (SELECT 1 FROM budget_submissions s WHERE s.flock_id = f.id)))`;

// Run by db/migrate.js on every boot. It only ever sets true, on rows that are
// false, so a second run changes nothing, and it locks no row it does not
// change: on a healthy database it matches nothing and takes no row lock.
const REQUARANTINE_SQL = `UPDATE bill_splits b SET quarantined = true
 WHERE ${LEGACY_BILL_OUTSIDE_QUARANTINE}`;

// Read by scripts/verify-backup.js: how many such bills are still out.
const COUNT_OUTSIDE_QUARANTINE_SQL = `SELECT COUNT(*)::bigint AS n FROM bill_splits b
 WHERE ${LEGACY_BILL_OUTSIDE_QUARANTINE}`;

module.exports = {
  LEGACY_BILL_OUTSIDE_QUARANTINE,
  REQUARANTINE_SQL,
  COUNT_OUTSIDE_QUARANTINE_SQL,
};
