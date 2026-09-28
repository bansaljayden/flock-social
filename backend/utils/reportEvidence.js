// Reported plan content that outlives the plan (migration 110).
//
// messages and guest_rsvps cascade away with their flock, so a plan delete used
// to take reported content with it and leave the report pointing at nothing.
// Every door that deletes a plan runs one of the statements below first, in the
// same transaction as the delete, so the copy and the delete commit or roll back
// together:
//
//   - DELETE /api/flocks/:id and the host's leave (routes/flocks.js) run
//     PRESERVE_REPORTED_PLAN_CONTENT_SQL with $1 the plan id, just before their
//     DELETE FROM flocks.
//   - The last member's leave deletes the plan only when it empties it, so it
//     runs reportedPlanContentInsert() under that same condition, and the
//     copy is taken exactly when the plan goes.
//   - An account deletion cascades every plan the account still hosts
//     (routes/users.js), and runs PRESERVE_REPORTED_HOSTED_CONTENT_SQL with $1
//     the account id, after that account's own messages are already gone.
//
// Only content an open or under-review report names is copied: a report a
// moderator has already closed is judged, the line the story purge draws too.
// Nothing here is ever read by a member-facing route; routes/admin.js is the
// only reader, and it falls back to a copy only when the live row is gone.
// That includes the author's own data export: a copy exists only because a
// report about the message was open, so handing it to the author would tell
// them about the report. The privacy policy names that as an exception to
// "the messages you sent", with the period below.
//
// A copy is not kept for ever. It exists so a moderator can judge a report, so
// it goes EVIDENCE_RETENTION_DAYS after the last report naming it is closed,
// by purgeClosedReportEvidence below on an hourly timer in server.js. The
// privacy policy states that period, and a test ties the two together.

const pool = require('../config/database');

// The content types a plan delete can take with it, which are the only types a
// copy is ever kept for. routes/admin.js reads this list to decide where to
// look when the live row is missing.
const PRESERVED_CONTENT_TYPES = Object.freeze(['flock_message', 'guest_rsvp']);

const OPEN_REPORT = (type, alias) => `EXISTS (SELECT 1 FROM content_reports r
                WHERE r.content_type = '${type}' AND r.content_id = ${alias}.id
                  AND r.status IN ('open', 'under_review'))`;

// `flocks` is a SQL predicate on the plan id column it is handed (`m.flock_id`
// or `g.flock_id`), `when` an optional extra condition. Both are written in
// this file or by the caller, never built from a request value.
function reportedPlanContentInsert(flocks, when = null) {
  const extra = when ? `\n   AND (${when})` : '';
  return `INSERT INTO content_report_evidence
       (content_type, content_id, flock_id, message_text, venue_data, image_url,
        name, author_id, created_at, is_hidden)
SELECT 'flock_message', m.id, m.flock_id, m.message_text, m.venue_data, m.image_url,
       NULL, m.sender_id, m.created_at, COALESCE(m.is_hidden, false)
  FROM messages m
 WHERE ${flocks('m.flock_id')}
   AND ${OPEN_REPORT('flock_message', 'm')}${extra}
UNION ALL
SELECT 'guest_rsvp', g.id, g.flock_id, NULL, NULL, NULL,
       g.name, NULL, g.created_at, COALESCE(g.is_hidden, false)
  FROM guest_rsvps g
 WHERE ${flocks('g.flock_id')}
   AND ${OPEN_REPORT('guest_rsvp', 'g')}${extra}
ON CONFLICT (content_type, content_id) DO NOTHING`;
}

// One plan, $1 its id.
const PRESERVE_REPORTED_PLAN_CONTENT_SQL = reportedPlanContentInsert((col) => `${col} = $1`);

// Every plan account $1 still hosts, which is every plan its deletion is about
// to cascade: the ones handed on to another member no longer name it.
const PRESERVE_REPORTED_HOSTED_CONTENT_SQL = reportedPlanContentInsert(
  (col) => `${col} IN (SELECT id FROM flocks WHERE creator_id = $1)`
);

// ---------------------------------------------------------------------------
// Retention: deleting a copy once its reports are closed
// ---------------------------------------------------------------------------
// The copy is the message or guest name its plan's delete would otherwise have
// taken, kept only so the report naming it can be judged. Once every report
// naming it is closed, that purpose is over, and a guest's copy has no account
// behind it whose deletion would ever take it (author_id is NULL), so without
// this the name was kept for good.
//
// Seven days after the last close, not the moment it closes. There is no way
// to reopen a report, so the week is the time left to save the evidence off
// the database for a report that was closed before anybody did. Seven days is
// also the period the privacy policy already gives a spent password reset
// link, so the page states one short period rather than a new one.
//
// A copy is kept while any report naming it is open or under review, or was
// closed less than the period ago. Every close writes resolved_at
// (PUT /api/admin/reports/:id, and the takedown that closes the other reports
// on the same content), so a closed report with no resolved_at, or a copy no
// report names at all, holds nothing and goes on the next run.
const EVIDENCE_RETENTION_DAYS = 7;
const EVIDENCE_PURGE_BATCH = 500;
const EVIDENCE_PURGE_INTERVAL_MS = 60 * 60 * 1000;

// $1 the period in days, $2 the batch size. SKIP LOCKED, so a copy a plan
// delete is still writing is left for the next pass rather than waited on.
const PURGE_CLOSED_REPORT_EVIDENCE_SQL = `DELETE FROM content_report_evidence
 WHERE id IN (
   SELECT e.id FROM content_report_evidence e
    WHERE NOT EXISTS (
      SELECT 1 FROM content_reports r
       WHERE r.content_type = e.content_type AND r.content_id = e.content_id
         AND (r.status IN ('open', 'under_review')
              OR r.resolved_at > NOW() - ($1::int * INTERVAL '1 day'))
    )
    ORDER BY e.preserved_at
    LIMIT $2::int
    FOR UPDATE SKIP LOCKED
 )`;

// Resolves to the number of copies deleted. In batches, so a first run over a
// backlog is a few short statements rather than one long one.
async function purgeClosedReportEvidence(batch = EVIDENCE_PURGE_BATCH, db = pool) {
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await db.query(PURGE_CLOSED_REPORT_EVIDENCE_SQL, [EVIDENCE_RETENTION_DAYS, batch]);
    const n = result.rowCount || 0;
    total += n;
    if (n < batch) return total;
  }
}

module.exports = {
  PRESERVED_CONTENT_TYPES,
  PRESERVE_REPORTED_PLAN_CONTENT_SQL,
  PRESERVE_REPORTED_HOSTED_CONTENT_SQL,
  reportedPlanContentInsert,
  EVIDENCE_RETENTION_DAYS,
  EVIDENCE_PURGE_BATCH,
  EVIDENCE_PURGE_INTERVAL_MS,
  PURGE_CLOSED_REPORT_EVIDENCE_SQL,
  purgeClosedReportEvidence,
};
