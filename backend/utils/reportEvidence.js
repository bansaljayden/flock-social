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

module.exports = {
  PRESERVED_CONTENT_TYPES,
  PRESERVE_REPORTED_PLAN_CONTENT_SQL,
  PRESERVE_REPORTED_HOSTED_CONTENT_SQL,
  reportedPlanContentInsert,
};
