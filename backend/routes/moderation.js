// ---------------------------------------------------------------------------
// UGC moderation routes (Apple 1.2 / Google UGC policy):
//   POST   /api/reports            — report content or a user
//   GET    /api/blocks             — list users I've blocked
//   POST   /api/blocks/:userId     — block a user (mutual invisibility)
//   DELETE /api/blocks/:userId     — unblock
// ---------------------------------------------------------------------------
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { invalidateBlockCache } = require('../utils/blocks');
// Shape before content — see validators/shape.js.
const { scalarOnly, freeText } = require('../validators/shape');
// The story feed's visibility rule, defined once. The report gate below used to
// carry its own copy, which had already drifted from routes/stories.js — see
// the long note on storyVisibilitySql for which differences are deliberate.
const { storyVisibilitySql } = require('../utils/relationships');
// Per-user probe budget, the same primitive routes/users.js and routes/friends.js
// ration their directory answers with. See blockProbeBudget below.
const { createUserBudget } = require('../utils/probeBudget');

const router = express.Router();
router.use(authenticate);

// users.id is int4. `param('userId').isInt()` with no ceiling accepted
// 99999999999, which Postgres answers with 22003 and this file's catch turns
// into a 500 — on the two routes that ARE the Guideline 1.2 safety control.
// Same bound the rest of the backend uses.
const INT4_MAX = 2147483647;

// venue_review added round 6: public UGC with no report path is an
// App Review 1.2 blocker.
//
// guest_rsvp added round 13. Migration 005 gave guest_rsvps an is_hidden column
// and every read honours it, but NOTHING could ever set it: the type was
// missing here and from the admin table map, so an abusive unauthenticated
// guest name — broadcast live to every member of the flock — had no takedown
// path at all. Reporting it is gated below on the reporter being an accepted
// member of that RSVP's flock.
//
// Round 17: 'guest_rsvp' was accepted here and mapped in admin.js, but the
// content_reports.content_type CHECK constraint still listed only six types
// (last set in migration 003), so every guest RSVP report passed validation,
// passed the visibility gate, and then died on the INSERT as a 23514 — served
// to the reporter as `500 Failed to submit report`. Migration 016 widens the
// constraint (this line said 015 for a while; 015 is the password reset, and
// pointing a maintainer at the wrong file is how the next drift gets missed);
// __tests__/safetyFlow.test.js now diffs this array against the
// migration text so the two can never drift apart again. If you add a type
// here, add a migration in the same commit.
//
// venue_event added round 20, ahead of the surface that will serve it. Nothing
// renders a venue event publicly today, so this is the one entry here that is
// not yet reachable from a real screen, and that is the point. venue_events is
// owner-typed UGC that sits next to venue_promotions in the same dashboard,
// screened by the same rejectIfProfane on write, and it was the ONLY venue
// table with no is_hidden column and no report type. Migration 005 built
// exactly that pipeline for guest_rsvps and nothing was wired to it for two
// rounds; 016 and 017 are both post-mortems of route code widening ahead of the
// schema. Closing it now costs one column and one CHECK value. Discovering it
// on the day somebody adds `GET /api/venues/:placeId/events` costs a Guideline
// 1.2 rejection, because that release ships user-generated content with no
// takedown path at all. Migration 019 is the schema half.
const VALID_CONTENT_TYPES = ['flock_message', 'dm', 'profile', 'story', 'venue_review', 'venue_promotion', 'guest_rsvp', 'venue_event'];
const VALID_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'other'];

// Every report is answered with this exact string, whether it created a row,
// matched an open report the same user already filed, or named content a
// moderator has already taken down. A reporter must not be able to infer the
// state of the queue from the wording.
const REPORT_ACCEPTED = 'Report received. Our team will review it promptly.';

// Round 9: every report inserted a row and paged a moderator with no ceiling,
// so one account could bury real reports below the dashboard's LIMIT 200 view
// and spam the alert channel. 10 reports/hour per user, in-memory (matches
// waitlist.js) — fine on the single-instance deployment.
const reportHourly = new Map(); // userId -> { count, resetAt }
const REPORTS_PER_HOUR = 10;

function allowReport(userId) {
  const now = Date.now();
  if (reportHourly.size > 5000) {
    for (const [k, v] of reportHourly) { if (now > v.resetAt) reportHourly.delete(k); }
  }
  let entry = reportHourly.get(userId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60 * 60 * 1000 };
    reportHourly.set(userId, entry);
  }
  if (entry.count >= REPORTS_PER_HOUR) return false;
  entry.count += 1;
  return true;
}

// POST /api/reports — file a report against content or a user.
router.post('/reports',
  [
    // Round 19 (shape sweep). `content_type: ["dm"]` satisfied isIn() by
    // coercion, then matched none of the `content_type === '...'` branches
    // below (an array is never === a string), so the visibility check was
    // skipped entirely and the array reached the INSERT — where the
    // content_reports CHECK refused '{dm}' with 23514. That landed in the catch
    // as a 500 AND printed the "VALID_CONTENT_TYPES has drifted ahead of the
    // constraint" alarm, which would have sent the next maintainer hunting for
    // a missing migration that does not exist.
    //
    // `reason` is NOT the same: content_reports.reason is a bare VARCHAR(50)
    // with no CHECK behind it anywhere in the migrations, so VALID_REASONS is
    // enforced here and only here. That is deliberate and it is what makes the
    // alarm in the catch below able to say a 23514 on this table means exactly
    // one thing. An earlier version of this comment claimed reason carried the
    // same constraint, which would have had the next maintainer looking for a
    // migration to widen instead of reading this array.
    // __tests__/moderationSafetySweep.test.js pins both halves.
    scalarOnly(body('content_type'), 'content type').isIn(VALID_CONTENT_TYPES).withMessage('Invalid content type'),
    scalarOnly(body('reason'), 'reason').isIn(VALID_REASONS).withMessage('Invalid reason'),
    // Round 17: these were validated but never CONVERTED. isInt() accepts the
    // string "5" as happily as the number 5, so a client that sent ids as
    // strings (any form-encoded post, or a JS client that read them out of a
    // DOM attribute) reached the author check below as `5 !== "5"` and was
    // told "Reported user does not match the content author" — a legitimate
    // report refused with an accusation. .toInt() makes the comparison mean
    // what it reads as.
    //
    // .toInt() does NOT rescue the array case: it writes back `[5]`, still an
    // array, which then reached `WHERE m.id = $1` on an int4 column as '{5}'
    // (22P02, another 500). The shape has to be settled before the conversion.
    scalarOnly(body('content_id').optional({ values: 'null' }), 'content id').isInt({ min: 1 }).withMessage('Invalid content id').toInt(),
    scalarOnly(body('reported_user_id').optional({ values: 'null' }), 'user id').isInt({ min: 1 }).withMessage('Invalid user id').toInt(),
    // `details` is free text a reporter types and a moderator reads in the
    // console; as an array it kept its markup past stripHtml and was stored.
    freeText(body('details').optional(), 'details').isLength({ max: 1000 }),
  ],
  async (req, res) => {
    try {
      // Round 15: the quota was spent BEFORE validation, so every malformed
      // request burned one of the ten reports a user gets per hour. Reporting
      // abuse is an App Review 1.2 obligation and the budget must only be spent
      // on real reports — validate first, meter second. Round 22 puts the
      // self-report refusal in the same half for the same reason: see the note
      // on it below.
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      // KNOWN GAP, left open deliberately, round 20. A report naming NEITHER
      // content nor a user — `{"content_type":"profile","reason":"spam"}` — is
      // accepted and filed. Both ids are optional for good reasons (a profile
      // report has no content_id, a guest RSVP report has no account behind
      // it), and with neither present every check below is skipped, because
      // each one is conditional on one of the two. The row that lands is
      // unactionable in every direction: 'hide' refuses (no content), 'ban'
      // refuses (nobody named), and dismiss is the only move. Ten an hour per
      // account in a LIMIT 200 queue is a cheap way to push real reports off
      // the bottom of it.
      //
      // It is NOT fixed here because the behaviour is pinned by a test in
      // another owner's file: __tests__/arrayShapeSweep.test.js, the case
      // `['POST', '/api/reports', { content_type: 'profile', reason: 'spam',
      // content_id: null, reported_user_id: null, details: null }, true]`,
      // which asserts this payload is NOT a 400 and DOES reach the database.
      // That test is making a different and also correct point (an explicit
      // null must read as absent, not as a validation error), so the two rules
      // have to be reconciled by whoever owns that file, not routed around.
      const { content_type, content_id, reported_user_id, reason, details } = req.body;

      // ---------------------------------------------------------------------
      // A REPORT NAMING YOURSELF IS NOT A REPORT (round 22).
      // ---------------------------------------------------------------------
      // `{"content_type":"profile","reason":"spam","reported_user_id":<me>}` is
      // the cheapest actionable-looking payload in the app. It needs no other
      // account, no content and no visibility: the only gate on that shape is
      // the "does this user exist" lookup below, and the caller is the proof.
      // Every one of them filed a row, and every row paged every moderator
      // through alertModerators. Ten an hour per account, all of them landing
      // in the same LIMIT 200 queue as real reports, and all of them
      // unactionable in every direction — admin.js refuses to hide a profile,
      // and the only person there is to ban is the reporter.
      //
      // The block route beside this one has always refused the mirror-image
      // request in so many words ("You cannot block yourself"). The two halves
      // of the same Guideline 1.2 control now answer the same question the same
      // way.
      //
      // BEFORE THE METER, deliberately, and for round 15's reason: the ten
      // reports an account gets per hour must only be spent on real ones.
      // Somebody who taps report on their own profile by accident must not lose
      // a slot they may need for a real report minutes later. Nothing is stored
      // and nothing is mailed on this path, so there is nothing for the meter
      // to bound — the global API limiter already covers raw request volume.
      if (reported_user_id && reported_user_id === req.user.id) {
        return res.status(400).json({ error: 'You cannot report yourself' });
      }

      if (!allowReport(req.user.id)) {
        return res.status(429).json({ error: 'You have filed a lot of reports recently. Try again in a little while.' });
      }

      // Round 3: a report must reference REAL content the reporter can see,
      // authored by the person being reported — otherwise users can frame
      // accounts or probe private message ids via the report pipeline.
      // Round 17: the four public-surface branches carried
      // `AND is_hidden = false` INSIDE the visibility query, so content a
      // moderator had already taken down was indistinguishable from content
      // that never existed — both produced `400 That content could not be
      // found`. Two people reporting the same abusive venue review seconds
      // apart meant the second one got an error message accusing them of
      // making it up. Visibility and takedown-state are now separate: the
      // reporter still has to be able to see the row, but "already handled" is
      // answered with the same success string as a fresh report (and files
      // nothing, because there is nothing left to do).
      // The author the content row resolves to, carried out of the block so
      // the INSERT can name them when the client could not (see there).
      let contentAuthorId = null;
      if (content_id) {
        let row = null;
        // 'flock_message' is the validated type name — checking 'message' here
        // made every legitimate group-chat report 400 as "not found"
        if (content_type === 'flock_message') {
          const r = await pool.query(
            `SELECT m.sender_id, COALESCE(m.is_hidden, false) AS is_hidden FROM messages m
             JOIN flock_members fm ON fm.flock_id = m.flock_id AND fm.user_id = $2 AND fm.status = 'accepted'
             WHERE m.id = $1`,
            [content_id, req.user.id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'dm') {
          const r = await pool.query(
            `SELECT sender_id, COALESCE(is_hidden, false) AS is_hidden FROM direct_messages
             WHERE id = $1 AND (sender_id = $2 OR receiver_id = $2)`,
            [content_id, req.user.id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'venue_review') {
          // Public surface: anyone who can see the review can report it.
          const r = await pool.query(
            `SELECT user_id AS sender_id, COALESCE(is_hidden, false) AS is_hidden FROM venue_reviews
             WHERE id = $1`,
            [content_id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'venue_promotion') {
          const r = await pool.query(
            `SELECT venue_user_id AS sender_id, COALESCE(is_hidden, false) AS is_hidden FROM venue_promotions
             WHERE id = $1`,
            [content_id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'venue_event') {
          // Same shape as venue_promotion, and deliberately so: both are
          // business-authored copy attached to a public place id, and both are
          // read by a bare id because whoever can see the venue card can see
          // them. The id-existence oracle that implies is the same one the two
          // branches above already accept — a venue event is not private, and
          // the alternative (answering "found" for ids that do not exist) makes
          // the queue a dumping ground for reports naming nothing.
          const r = await pool.query(
            `SELECT venue_user_id AS sender_id, COALESCE(is_hidden, false) AS is_hidden FROM venue_events
             WHERE id = $1`,
            [content_id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'guest_rsvp') {
          // A guest RSVP is only visible to accepted members of its flock, so
          // only they may report it. sender_id stays NULL: there is no Flock
          // account behind a guest, which also means a reported_user_id sent
          // alongside this type correctly fails the author check below.
          const r = await pool.query(
            `SELECT NULL::int AS sender_id, COALESCE(gr.is_hidden, false) AS is_hidden FROM guest_rsvps gr
             JOIN flock_members fm ON fm.flock_id = gr.flock_id AND fm.user_id = $2 AND fm.status = 'accepted'
             WHERE gr.id = $1`,
            [content_id, req.user.id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'story') {
          // Same visibility predicate as the story feed — a bare id lookup let
          // any user probe/report stories they could never see.
          //
          // Round 20: it is now literally the same predicate rather than a
          // second copy of it. utils/relationships.js owns the definition and
          // the three differences from the feed are arguments with reasons
          // attached, not silently divergent SQL:
          //
          //   excludeHidden:false       already-taken-down content is answered
          //                             as a success below, not as "could not
          //                             be found" (round 17's fix, which a
          //                             shared `is_hidden = false` would undo).
          //   excludeBannedAuthor:false the feed retracts a banned account's
          //                             stories; a report about one is still a
          //                             real report about content that was on
          //                             real screens.
          //   includeOwn:true           you can see your own story, so the
          //                             honest answer to a report against it is
          //                             not "that content could not be found".
          //                             The old copy left it out, which is the
          //                             kind of difference two blocks of
          //                             duplicated SQL hide.
          const r = await pool.query(
            `SELECT s.user_id AS sender_id, COALESCE(s.is_hidden, false) AS is_hidden FROM stories s
             WHERE s.id = $1
               AND ${storyVisibilitySql({
                 viewer: '$2',
                 includeOwn: true,
                 excludeHidden: false,
                 excludeBannedAuthor: false,
               })}`,
            [content_id, req.user.id]
          );
          row = r.rows[0] || null;
        }
        if (!row) {
          return res.status(400).json({ error: 'That content could not be found' });
        }
        // The other road to a self-report, and the one the story branch above
        // opens on purpose. includeOwn:true is there so that reporting your own
        // story is not answered with "that content could not be found", which
        // would be a denial that the story exists; the honest answer it was
        // reaching for is this one. Same for a venue review, a DM or a flock
        // message you wrote yourself: your own content is not something a
        // moderator can be asked to adjudicate, and you can delete it.
        //
        // `!= null` rather than a truthy test: a guest RSVP resolves sender_id
        // to NULL because there is no Flock account behind a guest, and reading
        // "no author" as "the author is me" would take the only takedown path
        // for an abusive guest name back off the board — the exact outage
        // migration 016 was written to end.
        if (row.sender_id != null && row.sender_id === req.user.id) {
          return res.status(400).json({ error: 'You cannot report your own content' });
        }
        if (row.is_hidden) {
          // Already taken down. Nothing to queue, nothing to alert on, and the
          // reporter did the right thing — so this is a success, worded
          // identically to every other success.
          return res.status(201).json({ message: REPORT_ACCEPTED, report: null });
        }
        contentAuthorId = row.sender_id != null ? row.sender_id : null;
        if (reported_user_id && row.sender_id !== reported_user_id) {
          return res.status(400).json({ error: 'Reported user does not match the content author' });
        }
      } else if (reported_user_id) {
        // Round 17: a report naming a user but no content skipped every check,
        // so `{"content_type":"profile","reported_user_id":999999,"reason":"spam"}`
        // filed a real row against an account that does not exist. Those land
        // in the same LIMIT 200 queue as real reports and a moderator cannot
        // action them (admin.js refuses to hide a profile, and there is nobody
        // to ban). The block route already 404s an unknown id; so does this.
        const target = await pool.query('SELECT id FROM users WHERE id = $1', [reported_user_id]);
        if (target.rows.length === 0) {
          return res.status(404).json({ error: 'User not found' });
        }
      }

      // Round 9: one reporter re-filing the same target repeatedly inserted a
      // new row and re-paged moderators every time. While their earlier report
      // is still unhandled, answer the same success without a second row or a
      // second alert. The response is identical either way, so a reporter
      // learns nothing about what is already in the queue.
      const dupe = await pool.query(
        `SELECT id, status, created_at FROM content_reports
         WHERE reporter_id = $1
           AND content_type = $2
           AND content_id IS NOT DISTINCT FROM $3::int
           AND reported_user_id IS NOT DISTINCT FROM $4::int
           AND status IN ('open', 'under_review')
         LIMIT 1`,
        [req.user.id, content_type, content_id || null, reported_user_id || null]
      );
      if (dupe.rows.length > 0) {
        return res.status(201).json({ message: REPORT_ACCEPTED, report: dupe.rows[0] });
      }

      const result = await pool.query(
        `INSERT INTO content_reports (reporter_id, reported_user_id, content_type, content_id, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, status, created_at`,
        // The author the content row resolved to, when the client could not
        // name one: the public promotion read carries no owner id, so a
        // promotion report reached the queue with no reported user, no prior
        // history, and neither Warn nor Ban to press (UGC-loop audit,
        // 2026-09-05). The author-mismatch check above already holds the two
        // consistent when both are present; a guest row resolves to null.
        [req.user.id, reported_user_id || contentAuthorId, content_type, content_id || null, reason, details || null]
      );

      // Alert moderators (A6 — push/email). Fire-and-forget; never block the reporter.
      try {
        const { alertModerators } = require('../services/moderationAlerts');
        alertModerators(req.app.get('io'), {
          reportId: result.rows[0].id, content_type, reason, reporter: req.user.name,
        }).catch(() => {});
      } catch (_) { /* alerts service optional until A6 lands */ }

      res.status(201).json({ message: REPORT_ACCEPTED, report: result.rows[0] });
    } catch (err) {
      // 23514 is a CHECK violation, which on this table means exactly one
      // thing: VALID_CONTENT_TYPES above has drifted ahead of the constraint
      // and a whole report surface is silently down. That has now happened
      // twice (rounds 7 and 17), both times invisible because the log line
      // said nothing about which report was refused or why.
      if (err.code === '23514') {
        console.error(
          `[MODERATION] REPORT REJECTED BY THE DATABASE — content_type "${req.body?.content_type}" is not in the content_reports CHECK constraint. ` +
          'A reportable surface is unreachable; add a migration widening content_reports_content_type_check.',
          err.constraint || ''
        );
      } else {
        console.error('Create report error:', err);
      }
      res.status(500).json({ error: 'Failed to submit report' });
    }
  }
);

// GET /api/blocks — users the current user has blocked.
//
// Round 21: this was the last list in the moderation/admin surface with no
// ceiling. Nothing caps how many accounts one user may block — POST
// /blocks/:userId has no per-user quota (unlike POST /reports, which has one),
// so the row count here is chosen by the caller, and the response size with it.
// Every block also had to be joined against users and serialised on every load
// of the Blocked-accounts screen.
//
// LIMIT + 1 rather than LIMIT, so "there are exactly 500" and "there are more
// than 500" stay distinguishable without a second COUNT. `truncated` is an
// additive field: the shipping client reads `blocked` and ignores it, and a
// screen that silently shows 500 of 900 without saying so is the failure mode
// this flag exists to prevent when somebody does read it.
const BLOCK_LIST_LIMIT = 500;

router.get('/blocks', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.blocked_id AS user_id, u.name, u.profile_image_url, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC
       LIMIT $2`,
      [req.user.id, BLOCK_LIST_LIMIT + 1]
    );
    const truncated = result.rows.length > BLOCK_LIST_LIMIT;
    res.json({ blocked: result.rows.slice(0, BLOCK_LIST_LIMIT), truncated });
  } catch (err) {
    console.error('List blocks error:', err);
    res.status(500).json({ error: 'Failed to list blocked users' });
  }
});

// POST /api/blocks/:userId — block a user. Mutual invisibility is enforced by
// isBlockedBetween() across DMs, friend requests, invites, and visibility.
// Round 15: `param('userId').isInt()` was declared on both block routes and its
// result was never read, so the validator did nothing. `POST /api/blocks/abc`
// reached Postgres as NaN and came back a 500 ("invalid input syntax for type
// integer"), and `POST /api/blocks/12abc` silently blocked user 12 — parseInt
// stops at the first non-digit. Blocking is the 1.2 safety control; it has to
// act on the id the caller actually named or say plainly that it did not.
function badId(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Invalid user id' });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Directory-probe budget for the block route (object-authz sweep, round 2)
// ---------------------------------------------------------------------------
// This route answers the same question GET /api/users/:id/card and
// POST /api/friends/request answer, "is there an account behind this id", and
// it was the last one in the backend answering it for free. It ran
// `SELECT id FROM users WHERE id = $1` and branched: 201 "User blocked" for a
// real id, 404 "User not found" for a made-up one. users.id is a SERIAL, so
// that is a walkable integer space, and the only ceiling in front of it was the
// generic apiLimiter at 3000 requests per 15 minutes, i.e. 12,000 an hour. The
// side effect landed in the CALLER'S OWN block list, which DELETE
// /api/blocks/:userId removes again, so a walk was repeatable and left no trace
// on the accounts it found. It also confirmed BANNED accounts, which
// GET /:id/card deliberately hides.
//
// The shape below is the one those two routes already use: one refusal body for
// every refused case, a per-user budget charged on hits AND misses alike so the
// misses are not the free answers, and an exhausted budget answering exactly
// what a miss answers. A distinguishable 429 would move the oracle rather than
// close it, which is the reasoning written out at friends.js's `miss()`.
//
// WHY 60/HOUR AND 150/DAY, above friends.js's 20/60 and below users.js's
// 120/400. THIS IS A SAFETY CONTROL, so the number is set by the worst
// legitimate hour rather than the typical one, and it must not be reachable by
// anybody acting on their own behalf. The heaviest case anyone has described is
// "I was pulled into a flock full of strangers and I want none of them able to
// reach me": a link-joined flock caps at LINK_JOIN_MEMBER_CAP = 50 members, so
// 60 covers blocking every one of them with room left over, the same way
// users.js's search budget sits above its heaviest typing session rather than
// exactly on it. 150 a day covers three such episodes back to back. Typical use
// is a handful of blocks in the lifetime of an account, so nothing a real
// person does comes near this.
//
// It still cuts a directory walk from ~288,000 ids a day to 150, and unlike the
// IP limiter a fresh lane costs a fresh account rather than a fresh proxy.
//
// A SEPARATE budget from the friend and card probes, for the reason users.js
// gives: folding a safety action's allowance into a social one would either
// starve the safety action or widen the social one.
const BLOCK_PROBE_HOURLY = 60;
const BLOCK_PROBE_DAILY = 150;
const blockProbeBudget = createUserBudget({ name: 'block-probe', hourly: BLOCK_PROBE_HOURLY, daily: BLOCK_PROBE_DAILY });

router.post('/blocks/:userId', [param('userId').isInt({ min: 1, max: INT4_MAX })], async (req, res) => {
  try {
    if (badId(req, res)) return;
    const blockedId = parseInt(req.params.userId, 10);
    if (blockedId === req.user.id) return res.status(400).json({ error: 'You cannot block yourself' });

    // The single response for "nothing here". A nonexistent id, a banned
    // account and a spent budget all end here, with the same status and the
    // same body, so none of the three can be told apart from the others.
    const miss = () => res.status(404).json({ error: 'User not found' });

    // Runs FIRST because it reads the caller's OWN rows and therefore carries
    // no directory information: it decides whether this call is a probe at all.
    // Re-blocking somebody you have already blocked tells you nothing you did
    // not already know, so it stays free, and the block button cannot burn a
    // frightened user's allowance on double-taps. Same exemption, same reason,
    // as the existing-friendship exemption in friends.js.
    const already = await pool.query(
      'SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [req.user.id, blockedId]
    );

    // Charged on every probe at a stranger, hit or miss. Charging only on hits
    // would leave the misses free and unbounded, and "the free answers are the
    // misses" is the enumeration signal itself.
    const withinBudget = already.rows.length > 0 || blockProbeBudget.allow(req.user.id);

    // Deliberately queried even when the budget is spent, so the exhausted path
    // does the same one lookup a genuine miss does and cannot be separated from
    // it by response time.
    //
    // `AND is_banned IS NOT TRUE` is where a banned account becomes invisible:
    // GET /:id/card already reads banned as deleted, and the block route must
    // not be the one surface left that confirms such an account exists. IS NOT
    // TRUE rather than = false, because a NULL in that column has to read as
    // "not banned" (the same NULL rule flocks.js writes out for its gates).
    const exists = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND is_banned IS NOT TRUE',
      [blockedId]
    );
    if (!withinBudget || exists.rows.length === 0) return miss();

    // ONE statement, and that is the point. This was an INSERT followed by a
    // separate DELETE whose rejection was swallowed by .catch(() => {}), so any
    // failure of the second half left a block and a friendship coexisting with
    // nothing logged and nothing to notice it. A friendship is not cosmetic
    // here: it is what availability fans a name and a free-text note out over,
    // and what several "people you know" surfaces read.
    //
    // A data-modifying CTE makes both halves one statement, so they commit
    // together or not at all, and a failure now reaches the catch below and
    // answers 500 instead of reporting a block it only half performed. It also
    // keeps the work on pool.query rather than a pool.connect() client, which
    // matters because the DROP/TRUNCATE pool guard only wraps pool.query.
    await pool.query(
      `WITH placed AS (
         INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING
         RETURNING 1
       )
       DELETE FROM friendships
        WHERE ((requester_id = $1 AND addressee_id = $2)
           OR (requester_id = $2 AND addressee_id = $1))
          AND status <> 'declined'`,
      [req.user.id, blockedId]
    );

    // The 30s block cache must not outlive the block itself — live location/
    // typing events check the cached variant (round 5).
    invalidateBlockCache(req.user.id, blockedId);

    // Tell BOTH clients to stop any live DM location interval aimed at the
    // other; the server already refuses the events in both directions, this
    // stops the pointless emitting too.
    //
    // Round 22: only the blocked side was told, and the missing half is the one
    // that matters more. Blocking somebody you are currently sharing your live
    // location with in a DM is not a corner case, it is one of the likelier
    // reasons to reach for the block button — and the blocker's own device kept
    // a ten-second emit loop pointed at them and kept showing "sharing location
    // with <the person you just blocked>" until the screen was navigated away
    // from. The server dropped the coordinates, so nothing leaked; the UI told
    // the user something about their own safety that was not true.
    //
    // App.js's onBlockedBy handler reads the payload as "stop emitting at this
    // id" (it clears dmSharingLocation when it matches), so each side is sent
    // the OTHER id and the existing client needs no change.
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${blockedId}`).emit('blocked_by', { userId: req.user.id });
      io.to(`user:${req.user.id}`).emit('blocked_by', { userId: blockedId });
    }

    res.status(201).json({ message: 'User blocked' });
  } catch (err) {
    console.error('Block user error:', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// DELETE /api/blocks/:userId — unblock.
router.delete('/blocks/:userId', [param('userId').isInt({ min: 1, max: INT4_MAX })], async (req, res) => {
  try {
    if (badId(req, res)) return;
    const blockedId = parseInt(req.params.userId, 10);
    const result = await pool.query(
      'DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING id',
      [req.user.id, blockedId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not blocked' });
    invalidateBlockCache(req.user.id, blockedId);
    // Both sides hear it, the way both hear a block: the other person's
    // thread used to stay on "closed on both sides" with no composer until
    // they left it and came back (UGC-loop audit, 2026-09-05).
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${blockedId}`).emit('unblocked_by', { userId: req.user.id });
      io.to(`user:${req.user.id}`).emit('unblocked_by', { userId: blockedId });
    }
    res.json({ message: 'User unblocked' });
  } catch (err) {
    console.error('Unblock user error:', err);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

module.exports = router;
// Exposed for __tests__/safetyFlow.test.js. A property on the router changes
// nothing about the mount in server.js (same pattern as checkin.js/safety.js).
module.exports.__test = {
  VALID_CONTENT_TYPES,
  VALID_REASONS,
  REPORTS_PER_HOUR,
  REPORT_ACCEPTED,
  // The block probe budget is process-wide in-memory state, so a suite needs a
  // way to start each case from a clean allowance and to read what a call
  // actually consumed. Nothing in the running server calls these.
  blockProbeBudget,
  resetBlockProbeBudget: () => blockProbeBudget.reset(),
  BLOCK_PROBE_HOURLY,
  BLOCK_PROBE_DAILY,
};
