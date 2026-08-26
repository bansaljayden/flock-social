const express = require('express');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
// Round 18: a takedown has to reach the people looking at the content right
// now, the same way a ban force-disconnects instead of waiting for a refetch.
// Round 22: the venue half of the same idea. Both room names are defined in
// sockets/handlers.js and neither is built by string interpolation here — a
// route that spells a room name itself is how the two halves drift.
const { emitToFlockMembers, emitToVenueContentViewers } = require('../sockets/handlers');
// One definition of "this report has a federal reporting duty behind it",
// shared with the alert path. See the note on the export in that file.
const { isChildSafetyReason, CHILD_SAFETY_DOC } = require('../services/moderationAlerts');
// The warning email. Held as the module object rather than destructured for the
// reason services/pushHelper.js holds firebaseService that way: tests replace
// the exported function and a destructured copy keeps calling the original.
const emailService = require('../services/emailService');
// The age gate's own arithmetic, so "is this person a minor" means the same
// thing on the moderation queue as it does at signup.
const { ageFromDob } = require('../utils/age');

const router = express.Router();
router.use(authenticate);

// Every id this router takes names a SERIAL (int4) primary key. `/^\d+$/` alone
// was already stopping `abc` from reaching Postgres as NaN, but it happily let
// `99999999999` through, which comes back as 22003 "out of range for type
// integer" and lands in each route's catch as a 500. On the moderation queue a
// 500 is indistinguishable from "the takedown failed", which is the one thing a
// moderator must never be unsure about. An id no column can hold names no row:
// that is a 404.
const INT4_MAX = 2147483647;

function serialId(raw) {
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 && n <= INT4_MAX ? n : null;
}

// Round 24: pagination bounds for the queue. Digits-only for the same reason
// serialId is — anything else is refused rather than coerced, because these two
// numbers are INTERPOLATED into LIMIT/OFFSET rather than bound. Interpolation
// is deliberate, not an oversight: __tests__/adminEvidence.test.js pins a
// literal `LIMIT <digits>` onto every admin list query precisely so a missing
// ceiling is visible in the SQL text, and a bound $n would blind that pin. The
// value that reaches the template is a Number produced by this parse and range
// check, never the request string — same discipline as FULL_TEXT_MAX above.
function pageParam(raw, { dflt, min, max }) {
  if (raw === undefined) return dflt;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= min && n <= max ? n : null;
}

// The console asks for a growing window (limit) rather than pages (offset),
// but both exist and both are bounded: 1000 rows of 280-char excerpts is still
// a small response, and OFFSET past a million names work no moderation queue
// holds.
const QUEUE_LIMIT_DEFAULT = 200;
const QUEUE_LIMIT_MAX = 1000;
const QUEUE_OFFSET_MAX = 1000000;

// Admin middleware.
//
// `!req.user` is not defensive decoration. This middleware reads a property off
// req.user, so mounted before `authenticate` (or on a router whose authenticate
// was moved) it throws a TypeError, which Express turns into a 500 — a gate that
// fails by CRASHING is a gate nobody notices has stopped gating. Same doctrine
// as requireVerified in middleware/auth.js: no user is a refusal, loudly, not an
// exception. Every route below is behind this; __tests__/adminEvidence.test.js
// walks router.stack and refuses to let a new one be added without it.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// WHAT THE REPORTED CONTENT ACTUALLY SAYS — one definition, two readers
// ---------------------------------------------------------------------------
//
// Round 21. The queue built its excerpt from ONE column per type, and for two
// types that column is not where the words are:
//
//   flock_message / dm   A venue card carries its name, address and category in
//                        `venue_data` (JSONB). Those three strings are clamped
//                        and profanity-screened by utils/venuePayload.js, and
//                        they are otherwise WHATEVER THE SENDER TYPED — the
//                        server never checks a place_id against Google, so
//                        "venue name" is a 256-character free-text field that
//                        renders as the card's title on every recipient's
//                        screen. A report against one arrived at the moderator
//                        as the accompanying message_text ("Check out X!") and
//                        nothing else, and against a hand-rolled client that
//                        sends a bland message_text, as evidence of nothing.
//   venue_review         `venue_reply` is the venue owner's public answer,
//                        rendered under the review by the same screen, capped at
//                        1000 characters of owner-typed text — and there is no
//                        'venue_review_reply' content type, so reporting the
//                        review IS how a user reports the reply. The queue
//                        showed vr.text: the moderator read the reviewer's words
//                        while judging a complaint about the owner's.
//
// Both readers now come from this map, so a type cannot be rendered one way in
// the list and another in the detail endpoint. `alias` is always a table alias
// this file wrote; nothing here interpolates a request value.
function venueCardSql(t) {
  // NULLIF collapses a card with no usable strings to NULL, and `'…' || NULL`
  // is NULL, so an empty venue_data adds no label rather than a bare prefix.
  return `('Venue card: ' || NULLIF(CONCAT_WS(' · ', ${t}.venue_data->>'name', ${t}.venue_data->>'addr', ${t}.venue_data->>'category'), ''))`;
}

// chr(10) rather than an escaped newline: this SQL is built in a JS template
// literal and read back by a test that matches on it, and a literal newline in
// the middle of a quoted SQL string is the kind of thing that survives one edit
// and not the next.
const CONTENT_TEXT_SQL = {
  flock_message: (t) => `NULLIF(CONCAT_WS(chr(10), NULLIF(${t}.message_text, ''), ${venueCardSql(t)}), '')`,
  dm: (t) => `NULLIF(CONCAT_WS(chr(10), NULLIF(${t}.message_text, ''), ${venueCardSql(t)}), '')`,
  story: (t) => `NULLIF(${t}.caption, '')`,
  venue_review: (t) => `NULLIF(CONCAT_WS(chr(10), NULLIF(${t}.text, ''), ('Owner reply: ' || NULLIF(${t}.venue_reply, ''))), '')`,
  // time_slot and days are not decoration. GET /public-promotions serves all
  // FOUR of these columns to every user who opens the venue card — round 20's
  // own note in routes/venueDashboard.js records "Fri <slur>" being published
  // from the days field — and a wordlist screen is not a substitute for a
  // moderator being able to READ the field, because it catches slurs and not
  // "text me at 555-0100".
  venue_promotion: (t) => `NULLIF(CONCAT_WS(chr(10), NULLIF(CONCAT_WS(': ', ${t}.title, ${t}.description), ''), NULLIF(CONCAT_WS(' · ', ${t}.time_slot, ${t}.days), '')), '')`,
  // Same shape. routes/venueDashboard.js used to run rejectIfProfane on `title`
  // ALONE, leaving event_date and event_time — 40 characters of owner-typed text
  // apiece — through no screen at all; round 22 fixed that, and both the POST and
  // the PUT now screen all three strings on the STRIPPED value. The queue still
  // reads all three, because a wordlist is not a substitute for a moderator being
  // able to READ the field: it catches slurs and not "text me at 555-0100".
  // Nothing renders venue events publicly yet, which is exactly why the queue
  // should be able to read them before something does.
  venue_event: (t) => `NULLIF(CONCAT_WS(chr(10), NULLIF(${t}.title, ''), NULLIF(CONCAT_WS(' · ', ${t}.event_date, ${t}.event_time), '')), '')`,
  // A guest has no account: the reported content IS the self-chosen name.
  guest_rsvp: (t) => `NULLIF(${t}.name, '')`,
  // The profile IS the reported content, so every field a stranger can see has to
  // reach the moderator. That is name, interests, the bio, and the avatar (served
  // by /reports/:id/image).
  //
  // bio was missing here until 2026-08-18. This comment used to say "users has no
  // bio column", which was true when it was written and stopped being true at
  // migration 026 — the column shipped, GET /users/:id/card serves it to any
  // stranger who taps the person card (routes/users.js), and 200 characters of
  // free text is exactly the surface a harassing or contact-soliciting profile
  // uses. A profile reported FOR its bio therefore arrived in the queue with the
  // offending string not displayed, and the moderator was asked to judge content
  // they could not read. Same shape as the avatar gap the paragraph above exists
  // to close, one field over.
  profile: (t) => `NULLIF(CONCAT_WS(' / ', ${t}.name, NULLIF(ARRAY_TO_STRING(${t}.interests, ', '), ''), NULLIF(${t}.bio, '')), '')`,
};

// GET /api/admin/analytics - Research analytics dashboard data
router.get('/analytics', async (req, res) => {
  try {
    const totalFlocks = await pool.query('SELECT COUNT(*) AS count FROM flocks');

    const completionRate = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status IN ('completed', 'cancelled')) AS terminal
       FROM flocks`
    );

    const avgGroupSize = await pool.query(
      `SELECT AVG(group_size)::NUMERIC(4,1) AS avg_size FROM research_analytics`
    );

    const budgetAdoption = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE budget_enabled = true) AS with_budget,
        COUNT(*) AS total
       FROM research_analytics`
    );

    const avgTimeToConfirm = await pool.query(
      `SELECT AVG(time_to_confirmation)::INTEGER AS avg_minutes
       FROM research_analytics WHERE flock_completed = true`
    );

    // The only variable-length result on this router that had no ceiling.
    // stall_point is server-chosen today (routes/flocks.js picks one of five
    // words), so this returns five rows — but that is a property of ANOTHER
    // file, and "a route widened the set of values it writes and the thing
    // reading them back did not hear about it" is the exact drift this codebase
    // has now hit four times (003, 016, 017, and the guest_rsvp console gap).
    // A dashboard chart with more than 50 categories is not a chart anyway.
    const stallPoints = await pool.query(
      `SELECT stall_point, COUNT(*) AS count
       FROM research_analytics
       GROUP BY stall_point
       ORDER BY count DESC
       LIMIT 50`
    );

    const weeklyTrends = await pool.query(
      `SELECT
        DATE_TRUNC('week', created_at) AS week,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE flock_completed = true) AS completed,
        AVG(group_size)::NUMERIC(4,1) AS avg_group_size
       FROM research_analytics
       WHERE created_at > NOW() - INTERVAL '8 weeks'
       GROUP BY week
       ORDER BY week DESC`
    );

    const userStats = await pool.query(
      `SELECT COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
       FROM users`
    );

    const reliabilityDistribution = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE reliability_score >= 80) AS reliable,
        COUNT(*) FILTER (WHERE reliability_score >= 50 AND reliability_score < 80) AS moderate,
        COUNT(*) FILTER (WHERE reliability_score > 0 AND reliability_score < 50) AS flaky,
        COUNT(*) FILTER (WHERE reliability_score IS NULL) AS unscored
       FROM users`
    );

    const cr = completionRate.rows[0];
    const terminal = parseInt(cr.terminal) || 0;
    const ba = budgetAdoption.rows[0];
    const baTotal = parseInt(ba.total) || 0;

    res.json({
      totalFlocks: parseInt(totalFlocks.rows[0].count),
      completionRate: terminal > 0 ? Math.round((parseInt(cr.completed) / terminal) * 100) : 0,
      avgGroupSize: avgGroupSize.rows[0].avg_size ? parseFloat(avgGroupSize.rows[0].avg_size) : 0,
      budgetAdoptionRate: baTotal > 0 ? Math.round((parseInt(ba.with_budget) / baTotal) * 100) : 0,
      avgTimeToConfirmation: avgTimeToConfirm.rows[0].avg_minutes || 0,
      stallPointDistribution: stallPoints.rows,
      weeklyTrends: weeklyTrends.rows,
      totalUsers: parseInt(userStats.rows[0].total_users),
      newUsersThisWeek: parseInt(userStats.rows[0].new_this_week),
      reliabilityDistribution: reliabilityDistribution.rows[0],
    });
  } catch (err) {
    console.error('Admin analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ---------------------------------------------------------------------------
// Moderation queue (A6) — Apple 1.2 / Google UGC. Admin-only (requireAdmin above).
// ---------------------------------------------------------------------------

// GET /api/admin/reports?status=open&limit=200&offset=0 — moderation queue
//
// ROUND 24 — THE LONGEST-WAITING REPORTS WERE THE ONES THAT FELL OFF.
//
// The queue ordered open-first then created_at DESC with a bare LIMIT 200, so
// the moment open reports outgrew the window, the rows that vanished were the
// OLDEST open ones — the people who had been waiting longest, which is the
// exact population Guideline 1.2's "act promptly" is about. Two changes:
//
//   1. ORDER. Unhandled work (open + under_review, the same pair the console's
//      UNHANDLED_STATUS names) sorts OLDEST-first, so the report that has
//      waited longest is row one and can never fall off any window. Handled
//      work still sorts newest-first below it — a closed report is read as
//      "what did we decide recently", not as a queue. r.id breaks created_at
//      ties so paging is deterministic.
//   2. PAGINATION. limit/offset, validated by pageParam and interpolated as
//      literals (see pageParam for why not $n). Offset pagination over keyset,
//      argued: the sort key is two-tier and direction-mixed, so a keyset
//      cursor is three columns of complexity — and it buys nothing here,
//      because acting on a report MOVES it (open bucket -> handled bucket),
//      so no cursor over this ordering is stable under the console's own use
//      anyway. At admin-console row counts OFFSET is free. The console
//      actually uses a growing `limit` window (offset 0), which re-reads the
//      whole window on every refresh: no append/dedupe state, no stale rows.
//
// One extra row is fetched past the limit so `hasMore` is a fact rather than
// the length==limit guess, and it is sliced off before the response.
router.get('/reports', async (req, res) => {
  try {
    const { status } = req.query;
    const limit = pageParam(req.query.limit, { dflt: QUEUE_LIMIT_DEFAULT, min: 1, max: QUEUE_LIMIT_MAX });
    if (limit === null) {
      return res.status(400).json({ error: `limit must be a whole number from 1 to ${QUEUE_LIMIT_MAX}` });
    }
    const offset = pageParam(req.query.offset, { dflt: 0, min: 0, max: QUEUE_OFFSET_MAX });
    if (offset === null) {
      return res.status(400).json({ error: `offset must be a whole number from 0 to ${QUEUE_OFFSET_MAX}` });
    }
    const params = [];
    let where = '';
    if (status && ['open', 'under_review', 'resolved', 'dismissed'].includes(status)) {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    // Round 11: the queue returned the report row and two names, never the
    // content being reported, so moderators were asked to hide or ban with no
    // evidence in front of them. The lateral pulls the ONE reported item per
    // report (nothing else from the thread) and the excerpt is capped so a
    // 200-row queue stays a small response. Additive columns only — the
    // existing dashboard keeps rendering unchanged.
    // NB: config/database.js rejects any query whose TEXT matches the word
    // starting "TRUNC...", alias names and comments included, which is why the
    // clipped flag is named content_excerpt_clipped.
    const result = await pool.query(
      `SELECT r.*, ru.name AS reporter_name,
              tu.name AS reported_user_name, tu.is_banned AS reported_user_banned,
              LEFT(c.body, 280) AS content_excerpt,
              (COALESCE(LENGTH(c.body), 0) > 280) AS content_excerpt_clipped,
              (c.image_url IS NOT NULL) AS content_has_image,
              -- Hosted URLs are small enough to inline in a 200-row queue.
              -- Inline base64 is not: a story photo is up to 700KB on its own
              -- (routes/stories.js caps it there) and 200 of those is a
              -- response no console should ask for.
              --
              -- Round 11 answered that by nulling the column, which made the
              -- queue unable to show the single most reported thing in a photo
              -- app: a moderator opening an image report saw an empty body and
              -- no picture, and was asked to hide or ban on the strength of the
              -- reporter's word. content_image_deferred says "there IS an
              -- image and it is not in this payload"; GET /reports/:id/image
              -- fetches it, one report at a time, at the moment somebody
              -- actually looks. Size is bounded by what the console opens
              -- rather than by the length of the queue.
              --
              -- A thumbnail would be better on the wire and is not available:
              -- there is no image library in backend/package.json, so resizing
              -- would mean a native dependency on the deploy path for a queue
              -- one person reads.
              CASE WHEN c.image_url LIKE 'data:%' OR LENGTH(c.image_url) > 500
                   THEN NULL ELSE c.image_url END AS content_image_url,
              (c.image_url IS NOT NULL
                 AND (c.image_url LIKE 'data:%' OR LENGTH(c.image_url) > 500)) AS content_image_deferred,
              c.author_id AS content_author_id,
              c.created_at AS content_created_at,
              c.is_hidden AS content_is_hidden,
              (r.content_id IS NOT NULL AND r.content_type <> 'profile' AND c.author_id IS NULL
                 AND c.body IS NULL AND c.created_at IS NULL) AS content_missing,
              -- ROUND 25. THE THREE THINGS A MODERATOR HAD TO LEAVE THE SCREEN
              -- TO FIND OUT, and could not find out at all without a psql
              -- prompt. Each is one indexed lookup per row.
              --
              -- content_open_reports  how many people are waiting on THIS piece
              --   of content. Ten reporters on one message is ten rows in this
              --   queue (the duplicate check in routes/moderation.js is
              --   per-REPORTER, deliberately, so a second person reporting the
              --   same thing is never silently swallowed). The card can now say
              --   so instead of presenting the tenth report as one more
              --   unrelated complaint. Uses idx_content_reports_content
              --   (migration 018).
              -- user_total_reports    what this account's record looks like.
              --   "First complaint anyone has made" and "eleventh this week"
              --   are different decisions and the screen showed neither.
              --   Counts every status, because a dismissed report against
              --   somebody is still a report against them.
              -- prior.action/at       what we did LAST time. A warning already
              --   given, or a takedown already made, is the difference between
              --   escalating and starting over.
              --
              -- All three are NULL-guarded on the id they key off, so a profile
              -- report (no content_id) never groups with every other profile
              -- report, and a guest RSVP report (no account behind it) reads
              -- zero rather than counting every report that names nobody.
              (SELECT COUNT(*)::int FROM content_reports dup
                 WHERE r.content_id IS NOT NULL
                   AND dup.content_type = r.content_type
                   AND dup.content_id = r.content_id
                   AND dup.status IN ('open', 'under_review')) AS content_open_reports,
              (SELECT COUNT(*)::int FROM content_reports pr
                 WHERE r.reported_user_id IS NOT NULL
                   AND pr.reported_user_id = r.reported_user_id
                   AND pr.id <> r.id) AS user_total_reports,
              prior.action AS user_last_action,
              prior.created_at AS user_last_action_at,
              -- Who closed it, by name. content_reports.handled_by has always
              -- been written and never once shown: a second moderator opening a
              -- resolved report saw the word "resolved" and no idea whether a
              -- colleague had handled it a minute ago or a month ago. Two people
              -- acting on the same report is not prevented anywhere (every
              -- action is accepted at any status, on purpose. See the note on
              -- the console's gating), so the defence is that the screen says
              -- who already acted.
              hb.name AS handled_by_name,
              -- IS A MINOR INVOLVED. The date of birth itself never leaves this
              -- function: both columns are reduced to a boolean below and
              -- deleted from the row, so the console is told "under 18" and
              -- never told a birthday. That is the least the screen can be
              -- given and still answer the question, and the question decides
              -- whether MODERATION-LEGAL.md applies.
              --
              -- BOTH sides, because either can be the child. The reported
              -- account is the obvious one; the reporter is the one who matters
              -- when a 13-year-old is the person being sent the content.
              tu.date_of_birth AS reported_user_dob,
              ru.date_of_birth AS reporter_dob
       FROM content_reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users tu ON tu.id = r.reported_user_id
       LEFT JOIN users hb ON hb.id = r.handled_by
       LEFT JOIN LATERAL (
         -- The last DECISION about this account, not the last access record.
         -- 'evidence_viewed' rows are records of a moderator reading, and one
         -- of them answering "what happened last time" would be a lie.
         SELECT ma.action, ma.created_at
         FROM moderation_actions ma
         WHERE r.reported_user_id IS NOT NULL
           AND ma.target_user_id = r.reported_user_id
           AND ma.action <> 'evidence_viewed'
           AND ma.report_id IS DISTINCT FROM r.id
         ORDER BY ma.created_at DESC, ma.id DESC
         LIMIT 1
       ) prior ON true
       LEFT JOIN LATERAL (
         -- Every body expression comes from CONTENT_TEXT_SQL above, which the
         -- detail endpoint reads too, so the excerpt and the full text can never
         -- describe the same row differently.
         SELECT ${CONTENT_TEXT_SQL.flock_message('m')} AS body, m.image_url, m.sender_id AS author_id,
                m.created_at, COALESCE(m.is_hidden, false) AS is_hidden
         FROM messages m WHERE r.content_type = 'flock_message' AND m.id = r.content_id
         UNION ALL
         SELECT ${CONTENT_TEXT_SQL.dm('d')}, d.image_url, d.sender_id, d.created_at, COALESCE(d.is_hidden, false)
         FROM direct_messages d WHERE r.content_type = 'dm' AND d.id = r.content_id
         UNION ALL
         SELECT ${CONTENT_TEXT_SQL.story('s')}, s.image_url, s.user_id, s.created_at, COALESCE(s.is_hidden, false)
         FROM stories s WHERE r.content_type = 'story' AND s.id = r.content_id
         UNION ALL
         SELECT ${CONTENT_TEXT_SQL.venue_review('vr')}, NULL, vr.user_id, vr.created_at, COALESCE(vr.is_hidden, false)
         FROM venue_reviews vr WHERE r.content_type = 'venue_review' AND vr.id = r.content_id
         UNION ALL
         -- Guest RSVPs have no Flock account behind them, so author_id is NULL;
         -- the reported content IS the guest's self-chosen display name.
         SELECT ${CONTENT_TEXT_SQL.guest_rsvp('gr')}, NULL, NULL, gr.created_at, COALESCE(gr.is_hidden, false)
         FROM guest_rsvps gr WHERE r.content_type = 'guest_rsvp' AND gr.id = r.content_id
         UNION ALL
         SELECT ${CONTENT_TEXT_SQL.venue_promotion('vp')}, NULL, vp.venue_user_id,
                vp.created_at, COALESCE(vp.is_hidden, false)
         FROM venue_promotions vp WHERE r.content_type = 'venue_promotion' AND vp.id = r.content_id
         UNION ALL
         -- venue_event: owner-typed copy, takedown flag added by migration 019.
         -- Listed here for the same reason it is in TAKEDOWN_TARGETS below: a
         -- type the queue cannot render is a type a moderator cannot judge, and
         -- the report already reaches this table.
         SELECT ${CONTENT_TEXT_SQL.venue_event('ve')}, NULL, ve.venue_user_id, ve.created_at, COALESCE(ve.is_hidden, false)
         FROM venue_events ve WHERE r.content_type = 'venue_event' AND ve.id = r.content_id
         UNION ALL
         -- A profile report has no row to hide, which is why it is absent from
         -- TAKEDOWN_TARGETS. It is NOT absent from the queue: the profile IS
         -- the reported content. Until now the card showed the account's name
         -- and nothing else, so "sexual content" filed against an avatar
         -- reached a moderator with the avatar missing and the only available
         -- action being a permanent ban. The keyed column is reported_user_id,
         -- not content_id — a profile report carries no content_id at all.
         SELECT ${CONTENT_TEXT_SQL.profile('pu')},
                pu.profile_image_url, pu.id, pu.created_at::timestamptz, false
         FROM users pu WHERE r.content_type = 'profile' AND pu.id = r.reported_user_id
         LIMIT 1
       ) c ON true
       ${where}
       -- Unhandled work oldest-first: the report that has waited longest can
       -- never fall off a window again. The CASE is NULL for handled rows, so
       -- they tie on it and fall through to newest-first, below all open work.
       ORDER BY (r.status IN ('open', 'under_review')) DESC,
                CASE WHEN r.status IN ('open', 'under_review') THEN r.created_at END ASC,
                r.created_at DESC,
                r.id ASC
       LIMIT ${limit + 1} OFFSET ${offset}`,
      params
    );
    // One row past the limit was fetched so hasMore is a fact, not a guess.
    const reports = result.rows;
    const hasMore = reports.length > limit;
    if (hasMore) reports.length = limit;
    // WHICH ROWS CARRY A REPORTING DUTY, decided by the same function that
    // decides which alert email says CHILD SAFETY in its subject line. Derived
    // here rather than in the console for the reason every other map on this
    // router is: a second copy of the rule in a different build is a copy that
    // drifts, and this one drifting means a report with a statutory clock on it
    // renders as an ordinary row.
    for (const row of reports) {
      row.child_safety = isChildSafetyReason(row.reason);
      // The floor is 13 and the target audience is 15 to 22, so most of the
      // queue is minors and a flag on every row would say nothing. It is not
      // decoration on a child-safety row: it is the difference between a
      // sexual-content report between two adults and one that starts a
      // statutory clock, and the console had no way to tell them apart.
      const reportedAge = ageFromDob(row.reported_user_dob);
      const reporterAge = ageFromDob(row.reporter_dob);
      row.reported_user_is_minor = reportedAge === null ? null : reportedAge < 18;
      row.reporter_is_minor = reporterAge === null ? null : reporterAge < 18;
      // A date of birth is not evidence and the screen never needs one.
      delete row.reported_user_dob;
      delete row.reporter_dob;
    }
    // Counts for the queue header
    const counts = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM content_reports GROUP BY status`
    );
    res.json({ reports, counts: counts.rows, limit, offset, hasMore });
  } catch (err) {
    console.error('Admin list reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/reports/:id/image — the picture the queue could not carry
// ---------------------------------------------------------------------------
//
// The report LIST above deliberately withholds inline base64 images, because a
// 200-row queue carrying 200 story photos is a hundred-megabyte response. Round
// 11 stopped there, and the result was that the most important category of
// report in a photo-sharing app arrived at the moderator blank: an image
// message has no message_text, so the card showed an empty body, no picture,
// and two buttons that permanently hide content or ban a 15-year-old.
//
// This is the other half. One report, one image, fetched when a human opens it.
//
// Column names come from THIS map and never from the request — same rule as
// TAKEDOWN_TARGETS below, and the reason the interpolation on the query is out
// of reach of user input. Types absent from the map have no image column at
// all (venue reviews, promotions, events and guest RSVPs are text), and are
// answered as "no image" rather than as an error.
//
// Deliberately NOT filtered on is_hidden: a moderator reviewing an un-hide
// request has to be able to see what was taken down. Everything on this router
// is behind requireAdmin.
const REPORT_IMAGE_SOURCES = {
  flock_message: { table: 'messages', column: 'image_url' },
  dm: { table: 'direct_messages', column: 'image_url' },
  story: { table: 'stories', column: 'image_url' },
  // A profile report carries no content_id; the reported content is the
  // account, and the part of it that gets reported is the avatar.
  profile: { table: 'users', column: 'profile_image_url', keyedOn: 'reported_user_id' },
};

const NO_IMAGE = 'That report has no image attached.';

router.get('/reports/:id/image', async (req, res) => {
  try {
    // Same id rule as PUT /reports/:id: a non-numeric id names no row, and a
    // 500 here reads as "the console is broken" on the one screen a moderator
    // needs to trust.
    const reportId = serialId(req.params.id);
    if (reportId === null) return res.status(404).json({ error: 'Report not found' });

    const rep = await pool.query(
      'SELECT id, content_type, content_id, reported_user_id FROM content_reports WHERE id = $1',
      [reportId]
    );
    if (rep.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    const report = rep.rows[0];

    // hasOwnProperty, not a bare lookup: `content_type = 'constructor'` walks
    // the prototype chain and comes back TRUTHY, which would carry a
    // `{ table: undefined, column: undefined }` into the interpolation below.
    // The CHECK constraint on content_reports makes that unreachable today —
    // this is the guard for the day somebody widens the constraint and not this
    // map, which is the exact direction 003, 016 and 017 all drifted.
    const source = Object.prototype.hasOwnProperty.call(REPORT_IMAGE_SOURCES, report.content_type)
      ? REPORT_IMAGE_SOURCES[report.content_type]
      : null;
    if (!source) return res.status(404).json({ error: NO_IMAGE });

    const rowId = source.keyedOn === 'reported_user_id' ? report.reported_user_id : report.content_id;
    if (!rowId) return res.status(404).json({ error: NO_IMAGE });

    const found = await pool.query(
      `SELECT ${source.column} AS image_url FROM ${source.table} WHERE id = $1`,
      [rowId]
    );
    if (found.rows.length === 0) {
      // Distinct from "no image": the row is gone, which is also the answer to
      // why the queue card looked empty, and it points at the action that is
      // still available.
      return res.status(404).json({ error: 'That content no longer exists. Dismiss the report instead.' });
    }
    const imageUrl = found.rows[0].image_url;
    if (!imageUrl) return res.status(404).json({ error: NO_IMAGE });

    // Round 23: the access is RECORDED. This endpoint serves reported UGC in
    // full, deliberately unfiltered on is_hidden, and — the sentence below has
    // said it since round 11 — sometimes from a minor's camera roll. Until now
    // nothing distinguished a moderator who opened one report from one who
    // enumerated the queue. One 'evidence_viewed' row per successful serve
    // ('evidence_viewed' becomes legal in migration 020, same commit): a row
    // per view is the honest unit, because "who read this, when" is exactly
    // the question the record exists to answer, and a coarser record (first
    // view only, or a counter) cannot answer it. The audit-log LIST excludes
    // these rows by default so they do not drown the decisions a moderator
    // reads it for — see GET /moderation-actions below.
    //
    // Written BEFORE the response and awaited, so a failed write is a failed
    // read (the 500 serves nothing). Fail-open logging records nothing exactly
    // when the database is flaky, which is when you least know who read what.
    // Refusal paths above record nothing on purpose: a 404 handed nobody any
    // evidence, and the record answers "who read", not "who knocked".
    // target_user_id stays NULL — its FK is ON DELETE CASCADE, so naming the
    // reported user would delete the access record with their account;
    // report_id (SET NULL) and the content coordinates carry the linkage.
    await pool.query(
      `INSERT INTO moderation_actions (report_id, moderator_id, action, content_type, content_id, reason)
       VALUES ($1, $2, 'evidence_viewed', $3, $4, 'image')`,
      [reportId, req.user.id, report.content_type, report.content_id]
    );

    // Reported UGC, served to a moderator, sometimes from a minor's camera
    // roll. It must not sit in a proxy or a browser cache.
    res.set('Cache-Control', 'no-store, private');
    res.json({
      reportId,
      contentType: report.content_type,
      contentId: report.content_id,
      imageUrl,
    });
  } catch (err) {
    console.error('Admin report image error:', err);
    res.status(500).json({ error: 'Failed to load the reported image' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/reports/:id/content — the rest of the words
// ---------------------------------------------------------------------------
//
// Round 21, the text half of the image endpoint above, and for the same reason.
// The queue clips its excerpt at 280 characters so a 200-row response stays
// small; nothing served the other 4,720 a flock message is allowed to hold. A
// moderator judging "harassment" on a long message read the opening and decided
// on it, and the console could only tell them honestly that they were looking at
// the first 280 characters — which is a truthful label on an incomplete record,
// not a way to see the record.
//
// 280 is genuinely enough for most reports and is the right default for the
// LIST. It is not enough for the ones that matter: abuse is routinely buried
// under a civil opening, and that is not an accident of the medium, it is how
// people write when they know something is being logged.
//
// Same gate (requireAdmin, whole router), same id rule (serialId), same
// no-store, same hasOwnProperty-guarded map, and deliberately NOT filtered on
// is_hidden — a moderator reviewing an un-hide request has to read what was
// taken down.
const REPORT_TEXT_SOURCES = {
  flock_message: { table: 'messages' },
  dm: { table: 'direct_messages' },
  story: { table: 'stories' },
  venue_review: { table: 'venue_reviews' },
  venue_promotion: { table: 'venue_promotions' },
  venue_event: { table: 'venue_events' },
  guest_rsvp: { table: 'guest_rsvps' },
  // A profile report carries no content_id; the row IS the account.
  profile: { table: 'users', keyedOn: 'reported_user_id' },
};

// One row, one admin, one open card — but still bounded. venue_reviews.text is
// an uncapped TEXT column on a table any signed-in user can write to, so
// "serve whatever is in there" is a response size set by an attacker rather
// than by the content. 20,000 is four times the longest thing any write path in
// this backend accepts, and `clipped` says plainly when even that was not all
// of it rather than trailing off the way the 280-character excerpt used to.
const FULL_TEXT_MAX = 20000;
const NO_TEXT = 'That report has no text content.';

router.get('/reports/:id/content', async (req, res) => {
  try {
    const reportId = serialId(req.params.id);
    if (reportId === null) return res.status(404).json({ error: 'Report not found' });

    const rep = await pool.query(
      'SELECT id, content_type, content_id, reported_user_id FROM content_reports WHERE id = $1',
      [reportId]
    );
    if (rep.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    const report = rep.rows[0];

    // hasOwnProperty on BOTH maps: a bare lookup answers 'constructor' and
    // '__proto__' from the prototype chain with a truthy value, and here that
    // value would be a function reaching the SQL interpolation. Unreachable
    // while the content_reports CHECK holds; 003, 016 and 017 are three separate
    // occasions on which it did not.
    const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);
    const source = own(REPORT_TEXT_SOURCES, report.content_type);
    const bodySql = own(CONTENT_TEXT_SQL, report.content_type);
    if (!source || typeof bodySql !== 'function') return res.status(404).json({ error: NO_TEXT });

    const rowId = source.keyedOn === 'reported_user_id' ? report.reported_user_id : report.content_id;
    if (!rowId) return res.status(404).json({ error: NO_TEXT });

    const found = await pool.query(
      `SELECT LEFT(${bodySql('t')}, ${FULL_TEXT_MAX}) AS body,
              (COALESCE(LENGTH(${bodySql('t')}), 0) > ${FULL_TEXT_MAX}) AS clipped,
              COALESCE(LENGTH(${bodySql('t')}), 0) AS total_length
       FROM ${source.table} t WHERE t.id = $1`,
      [rowId]
    );
    if (found.rows.length === 0) {
      // Distinct from "no text": the row is gone, which is also the answer to
      // why the card looked empty, and it names the action still available.
      return res.status(404).json({ error: 'That content no longer exists. Dismiss the report instead.' });
    }
    const { body, clipped, total_length: totalLength } = found.rows[0];
    if (!body) return res.status(404).json({ error: NO_TEXT });

    // Round 23: same access record as the image endpoint above, same rules
    // (before the response, awaited, refusals record nothing, target_user_id
    // NULL because of the CASCADE), and the reason names WHICH half was read
    // so one row is interpretable on its own.
    await pool.query(
      `INSERT INTO moderation_actions (report_id, moderator_id, action, content_type, content_id, reason)
       VALUES ($1, $2, 'evidence_viewed', $3, $4, 'full text')`,
      [reportId, req.user.id, report.content_type, report.content_id]
    );

    // Reported UGC, sometimes written by a minor, served to a moderator. It must
    // not sit in a proxy or a browser cache — same rule as the image endpoint.
    res.set('Cache-Control', 'no-store, private');
    res.json({
      reportId,
      contentType: report.content_type,
      contentId: report.content_id,
      text: body,
      clipped: !!clipped,
      totalLength: Number(totalLength) || 0,
    });
  } catch (err) {
    console.error('Admin report content error:', err);
    res.status(500).json({ error: 'Failed to load the reported text' });
  }
});

// The takedown target for each reportable content type. Hoisted out of the
// 'hide' branch (round 18) because un-hide needs exactly the same map — a
// second copy inline is how the guest_rsvp entry went missing from one of two
// places last time. Table names come from THIS map and never from the request
// body, which is what keeps the interpolation below out of reach of user input.
//
// `audience` is the SQL the takedown UPDATE returns, captured inside the
// transaction before it can change underneath us. Every entry returns the same
// THREE column names so the caller does not branch: `flock_id` (fan out to
// accepted members), `notify_*` user ids (personal rooms), and `place_id` (the
// venue-content room — the people with that venue's card open right now).
// 'profile' is deliberately absent — a profile report has no row to hide.
//
// ROUND 22 — WHO IS TOLD, RE-DECIDED PER TYPE.
//
// Round 20 wrote the honest table below and then declined to widen ANY of the
// four narrow types. It gave three reasons. The load-bearing one has since
// become false, so the decision is re-made here rather than re-explained:
//
//   flock_message   every accepted member, re-read at emit time.
//   guest_rsvp      same, and a guest has no account to tell.
//   dm              both participants.
//   venue_review    the author AND everyone holding that venue's card.  WIDENED
//   venue_promotion the venue owner AND everyone holding that card.     WIDENED
//   venue_event     the venue owner only.        (still narrow — see below)
//   story           the author only.             (still narrow — see below)
//
// WHAT CHANGED. Round 20's decisive reason was "nothing on the client listens,
// so widening is fan-out with no receiver". That is no longer true.
// frontend/src/services/socket.js registers `content_removed` and
// `content_restored` through the subscription registry that replays across a
// socket rebuild, and frontend/src/App.js has a per-type handler with drop and
// mark behaviour written per content type. The two venue types are the ones the
// gap hurt: /public-reviews and /public-promotions fill `venueDetailReviews`
// and `venueDetailPromos`, and the effect that loads them is keyed on the open
// card and never refetches, so a taken-down review or promotion stayed on every
// open card for as long as the app stayed open.
//
// THE CLIENT STILL OWES TWO THINGS, and neither is in this file's gift. Until
// they land, the room emit below is addressed at an empty room — which is a
// server that is ready rather than a server that is guessing, and is the same
// order the flock and DM emits shipped in:
//
//   1. join_venue_content / leave_venue_content, fired with the venue detail
//      card. Nothing joins the room yet. socket.js's registry replays room
//      joins on reconnect, so this rides for free once it is wired.
//   2. venue_promotion has to DROP from `venueDetailPromos` as well as mark in
//      `promotions`. App.js's venue_promotion branch only calls
//      setModerationHidden on the owner's own list today, which is right for
//      the owner (routes/venueDashboard.js keeps a hidden promotion visible and
//      marked, so silently dropping it would explain nothing) and wrong for a
//      viewer, who must simply stop seeing it. Both calls, unconditionally:
//      neither list contains the other's rows. venue_review already does the
//      viewer half (dropContentById on venueDetailReviews).
//
// THE ROOM. The venue-viewer room did not exist and reusing the crowd room was
// not an option, which is why round 20 stopped here. `venue:{placeId}` is
// joined off `activeVenue` (the map bottom sheet) and off the venue OWNER's own
// dashboard; the review and promotion state is keyed on `venueDetailModal`,
// which is also opened from a flock card, a search result and a chat share. The
// crowd room is therefore wrong in both directions at once: it misses every
// card that was opened without a map pin, and it delivers to map-sheet viewers
// who hold none of this state and to the owner dashboard, which App.js
// deliberately does NOT retract from (its review header stats come from the
// server, so dropping a row there prints "12 reviews" over eleven).
// `venue_content:{placeId}` in sockets/handlers.js is joined and left with the
// card that holds the content, which is exactly the lifetime of the state being
// retracted. See emitToVenueContentViewers there for the room's own rules.
//
// WHAT STAYS NARROW, on current facts rather than round 20's:
//
//   venue_event — there is no public route that serves a venue event to
//     anybody. routes/venueDashboard.js has /public-reviews and
//     /public-promotions and no events twin, so the owner IS the whole
//     audience. This is the one type round 20's "fan-out with no receiver"
//     sentence still describes. Widen it in the same commit that ships a public
//     events route, and not before.
//   story — the audience is a per-viewer SQL predicate (utils/relationships.js:
//     friends, flock mates, minus blocks), so widening means one fan-out query
//     per takedown. That COST is not the reason and round 20 overstated it:
//     takedowns happen at the rate a moderator clicks a button, not at traffic
//     rate, the predicate is two indexed EXISTS clauses, and it is bounded by
//     the author's own friend and flock-mate count. The real reason is that
//     there is nobody to tell: the launch client renders no stories at all
//     (`getStories` in frontend/src/services/api.js has zero callers and App.js
//     does not contain the word), which is why App.js's TAKEDOWN_HANDLED marks
//     story 'none' and frontend/src/__tests__/contentTakedownWiring.test.js
//     pins that claim to the absence of the reader. Round 20 named story as the
//     type to widen FIRST; on current facts it is the one to widen LAST, and
//     the commit that ships a story feed is the one that owes it.
//
// Still true, and still the thing that actually protects a reader: every read
// path filters is_hidden, so the content is gone the moment anything refetches.
// The live retraction is the optimisation, not the takedown.
const TAKEDOWN_TARGETS = {
  // Flock chat: the audience is the flock, not the author.
  flock_message: { table: 'messages', audience: 'flock_id, NULL::int AS notify_a, NULL::int AS notify_b, NULL::text AS place_id' },
  // A DM has exactly two people who can see it, and both need to be told: the
  // recipient so it leaves their thread, the author so a takedown is not silent.
  dm: { table: 'direct_messages', audience: 'NULL::int AS flock_id, sender_id AS notify_a, receiver_id AS notify_b, NULL::text AS place_id' },
  story: { table: 'stories', audience: 'NULL::int AS flock_id, user_id AS notify_a, NULL::int AS notify_b, NULL::text AS place_id' },
  // The two public venue types. `google_place_id` is what addresses the room,
  // and it is read out of the row being hidden rather than off the report, so
  // it names the venue the content is actually attached to.
  venue_review: { table: 'venue_reviews', audience: 'NULL::int AS flock_id, user_id AS notify_a, NULL::int AS notify_b, google_place_id AS place_id' },
  venue_promotion: { table: 'venue_promotions', audience: 'NULL::int AS flock_id, venue_user_id AS notify_a, NULL::int AS notify_b, google_place_id AS place_id' },
  // venue_event: is_hidden added by migration 019. Nothing serves venue events
  // publicly yet, so no report can be filed against one from a real screen
  // today — but routes/moderation.js accepts the type, which means one CAN
  // arrive, and a report the queue cannot action is the failure this map exists
  // to prevent (round 13's guest_rsvp hole, which sat open for two rounds).
  //
  // venue_events HAS a google_place_id column, so the NULL here is a decision
  // and not a schema limit: with no public route serving events, the room would
  // be addressed at nobody. Change this line and the events route together.
  venue_event: { table: 'venue_events', audience: 'NULL::int AS flock_id, venue_user_id AS notify_a, NULL::int AS notify_b, NULL::text AS place_id' },
  // A guest RSVP has no account behind it, so there is nobody personal to tell;
  // the flock members watching the roster are the whole audience.
  guest_rsvp: { table: 'guest_rsvps', audience: 'flock_id, NULL::int AS notify_a, NULL::int AS notify_b, NULL::text AS place_id' },
};

// ---------------------------------------------------------------------------
// THE WARNING EMAIL, round 25, and the reason 'warn' exists at all
// ---------------------------------------------------------------------------
//
// 'user_warned' has been a legal value in the moderation_actions.action CHECK
// since migration 001 and NOTHING has ever written one. Until now the console
// offered exactly two account-level outcomes: leave it alone, or ban the
// account permanently, with no expiry column anywhere and no route that clears
// is_banned except another moderator's click. On an app whose floor is 13, the
// first rude message a 14-year-old sends had two available answers and one of
// them was "gone forever". A queue with no middle rung is a queue that either
// over-punishes or does nothing, and doing nothing is the one that happens.
//
// This is the middle rung, and it is a real one because it is DELIVERED, not
// logged. The email goes out BEFORE anything is written: if it cannot be sent,
// the action is refused whole and no audit row claims a warning that nobody
// received. That ordering can, in a double failure, mail somebody and then fail
// to commit: a warned user with no audit row, which a retry fixes and which is
// strictly better than the reverse (a permanent record of a warning that was
// never sent).
//
// Deliberately NOT a push notification: services/pushHelper.js is a no-op
// without FIREBASE_SERVICE_ACCOUNT and delivers nothing to a user with no
// registered device, so a "warning" that rides only on push is a warning that
// silently reaches nobody. Deliberately NOT an in-app notice either: there is
// no notifications table and no screen that would render one, and inventing one
// here would be claiming a surface that does not exist.
const WARN_SUBJECT = 'About your recent activity on Flock';

function warnEmailText(name) {
  return [
    `Hi ${name || 'there'},`,
    '',
    'Someone reported content you posted on Flock, and a moderator reviewed it. '
    + 'It broke our Community Guidelines, so this is a warning on your account.',
    '',
    'What happens next is up to you. Accounts that keep breaking the guidelines get banned, '
    + 'and a ban is permanent.',
    '',
    'The guidelines are at https://www.flockcorp.com/guidelines. '
    + 'If you think this was a mistake, reply to this email and a person will read it.',
    '',
    'The Flock Team',
  ].join('\n');
}

function warnEmailHtml(name) {
  const safe = emailService.escapeHtml(String(name || 'there'));
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#16233a">
    <p>Hi ${safe},</p>
    <p>Someone reported content you posted on Flock, and a moderator reviewed it. It broke our Community Guidelines, so this is a warning on your account.</p>
    <p>What happens next is up to you. Accounts that keep breaking the guidelines get banned, and a ban is permanent.</p>
    <p>The guidelines are at <a href="https://www.flockcorp.com/guidelines">flockcorp.com/guidelines</a>. If you think this was a mistake, reply to this email and a person will read it.</p>
    <p>The Flock Team</p>
  </div>`;
}

// PUT /api/admin/reports/:id — take a moderation action:
//   action ∈ 'hide' (take content down) | 'unhide' (put it back) | 'warn' |
//            'ban' | 'unban' | 'dismiss'
router.put('/reports/:id', async (req, res) => {
  try {
    // A non-numeric :id used to reach Postgres as NaN and surface as a 500,
    // which in the moderation queue is indistinguishable from "the takedown
    // failed" — the one thing a moderator must never be unsure about.
    const reportId = serialId(req.params.id);
    if (reportId === null) return res.status(404).json({ error: 'Report not found' });

    // `|| {}` matches PUT /venues/:profileId/verify below, and it is honestly
    // belt-and-braces rather than a live bug fix: body-parser 1.20 assigns
    // `req.body = req.body || {}` BEFORE deciding whether to parse, so under
    // the express.json() this router is mounted behind, req.body is never
    // undefined — MEASURED, by deleting this `|| {}` and watching every test
    // still pass. It earns its place only for a mount without that parser,
    // where destructuring undefined is a TypeError the moderator reads as
    // `500 Failed to apply action`. Do not read it as a tested guard.
    const { action, reason } = req.body || {};
    if (!['hide', 'unhide', 'warn', 'ban', 'unban', 'dismiss'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    // `reason` is free text a moderator writes for other moderators and it is
    // stored verbatim in the audit log. node-postgres does not refuse a
    // non-string for a TEXT parameter, it CONVERTS one: `["harassment"]` lands
    // as the array literal `{harassment}` and `{"a":1}` as `{"a":1}`, so the
    // permanent record of why an account was banned would read as neither what
    // was sent nor what was meant. Nor is it length-bounded anywhere else —
    // moderation_actions.reason is an uncapped TEXT column read back by a
    // LIMIT 200 list. Refuse rather than coerce, and say which it was.
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== 'string') {
        return res.status(400).json({ error: 'reason must be text' });
      }
      if (reason.length > 1000) {
        return res.status(400).json({ error: 'reason is too long (max 1000 characters)' });
      }
    }

    const rep = await pool.query('SELECT * FROM content_reports WHERE id = $1', [reportId]);
    if (rep.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    const report = rep.rows[0];

    // An un-hide resolves the report as DISMISSED, not resolved (round 18).
    // `resolved` is this queue's word for "the complaint was upheld and we
    // acted on it"; putting the content back is the opposite finding, so
    // recording it as resolved would sit next to a `content_restored` audit row
    // contradicting it, and would count a reversed takedown in the same header
    // tally as the ones we stand behind — which is exactly the number you would
    // look at to find out how often we get this wrong.
    //
    // 'unban' is knowingly NOT changed here. It is the murkier case (a ban is
    // usually lifted from a different report than the one that imposed it, and
    // is as often a time-served decision as a reversal), and it is out of the
    // scope this change was asked to settle. The asymmetry is deliberate, not
    // an oversight.
    const newStatus = (action === 'dismiss' || action === 'unhide') ? 'dismissed' : 'resolved';

    // THE WARNING GOES OUT BEFORE ANYTHING IS WRITTEN. Every refusal below
    // happens with nothing recorded and nothing sent, and each one names the
    // action the moderator can take instead, the same rule as the takedown
    // refusals further down.
    if (action === 'warn') {
      if (!report.reported_user_id) {
        return res.status(400).json({ error: 'This report names no user, so there is nobody to warn. Hide the content or dismiss the report.' });
      }
      const who = await pool.query(
        'SELECT id, name, email, is_banned FROM users WHERE id = $1',
        [report.reported_user_id]
      );
      const target = who.rows[0];
      if (!target) {
        return res.status(404).json({ error: 'That user no longer exists. Dismiss the report instead.' });
      }
      if (target.is_banned) {
        return res.status(409).json({ error: 'That account is already banned, so a warning would say less than what has already happened. Unban it first if that is what you mean to do.' });
      }
      if (!emailService.isMailableAddress(target.email)) {
        // An Apple private-relay placeholder or an evicted-squat tombstone.
        // There is no other channel: push is inert without Firebase and there
        // is no in-app notice to write to, so this is honestly a dead end and
        // says so rather than logging a warning into the void.
        return res.status(409).json({ error: 'That account has no address a warning could be sent to, so the only real options are a takedown, a ban, or dismissing the report.' });
      }
      const sent = await emailService.sendEmail({
        to: target.email,
        subject: WARN_SUBJECT,
        text: warnEmailText(target.name),
        html: warnEmailHtml(target.name),
      });
      if (!sent || !sent.sent) {
        console.error(`[MODERATION] warning email for report ${reportId} was NOT delivered (${sent && (sent.error || sent.reason) ? (sent.error || sent.reason) : 'skipped'}); nothing was recorded.`);
        return res.status(502).json({ error: 'The warning email could not be sent, so nothing was recorded. Try again, or ban the account if this cannot wait.' });
      }
    }

    // Round 11: the mutation, the report resolution and the audit row were
    // three independent pool.query calls. A failure between them could ban a
    // user or hide content with NO audit record, or resolve a report that was
    // never acted on. All three commit together or none of them do.
    // Round 13: a moderator action that performs NOTHING must not report
    // success. `refusal` short-circuits the transaction and is answered after
    // the client is released, so the route never rolls back and releases twice.
    const client = await pool.connect();
    let actionType;
    let banTargetId = null;
    let refusal = null;
    let audience = null;
    // How many OTHER open reports about the same content this takedown closed.
    // Reported back so the console can say it out loud rather than leaving a
    // moderator to notice nine cards missing on the next refresh.
    let alsoResolved = 0;
    // A boolean rather than a second read of the audit action name. The drift
    // guard in __tests__/unhidePath.test.js scrapes this file for assignments to
    // that variable and reads every quoted string up to the next semicolon as a
    // value written to moderation_actions.action. Testing it in a condition that
    // wraps a SQL statement would hand the scraper the status literals inside
    // that statement and fail a guard which is protecting something real.
    let sweepSiblingReports = false;
    try {
      await client.query('BEGIN');

      if (action === 'hide' || action === 'unhide') {
        // Round 18: hide and un-hide are ONE branch over a boolean. Before this
        // there was no un-hide at all — a mistaken takedown could only be
        // reversed with direct database access, because every read path in the
        // app filters COALESCE(is_hidden, false) = false and nothing anywhere
        // wrote false back.
        const hiding = action === 'hide';
        // guest_rsvps added round 13 — migration 005 built the takedown and
        // nothing was ever wired to it, so an abusive guest RSVP name could not
        // be removed by anyone.
        // hasOwnProperty for the same reason the image route uses it: a bare
        // lookup answers 'constructor' and '__proto__' from the prototype chain
        // with a truthy object, and `UPDATE undefined SET is_hidden` is a 500
        // the moderator reads as "the takedown failed" instead of the honest
        // refusal below. The content_reports CHECK makes it unreachable today.
        const target = Object.prototype.hasOwnProperty.call(TAKEDOWN_TARGETS, report.content_type)
          ? TAKEDOWN_TARGETS[report.content_type]
          : null;

        // FAIL LOUDLY (round 13). A 'profile' report has no row in this map, so
        // the UPDATE never ran — and the route still answered "Action applied",
        // resolved the report, and wrote an audit row claiming content_hidden.
        // A moderator was told abusive content was down while it was still
        // live, and the audit log recorded work nobody did.
        if (!target || !report.content_id) {
          refusal = {
            status: 400,
            error: report.content_type === 'profile'
              // "or dismiss the report" on both halves because it is the one
              // alternative that is always available: an un-hide can be reached
              // on a report whose user was never banned, so offering only
              // "unban" would name an action that does nothing.
              ? `A profile report has no content to ${hiding ? 'hide' : 'restore'}. ${hiding ? 'Ban' : 'Unban'} the user or dismiss the report.`
              : `There is nothing to ${hiding ? 'hide' : 'restore'} on this report.`,
          };
        } else {
          // RETURNING captures the audience INSIDE the transaction. Reading it
          // afterwards would be reading a world the takedown has already
          // changed (a DM's receiver, a message's flock), and on a rollback it
          // would name people about an event that never happened.
          const changed = await client.query(
            `UPDATE ${target.table} SET is_hidden = $1 WHERE id = $2 RETURNING ${target.audience}`,
            [hiding, report.content_id]
          );
          if (changed.rowCount === 0) {
            refusal = hiding
              ? { status: 404, error: 'That content no longer exists. Dismiss the report instead.' }
              // Every refusal on this route leaves the moderator an action they
              // can actually take. A dead end tells someone the takedown queue
              // is broken when it is only telling them the row is gone.
              : { status: 404, error: 'That content no longer exists, so there is nothing to restore. Dismiss the report instead.' };
          } else {
            // The audit action is derived from what the database actually did,
            // never assumed. 'content_restored' only became a legal value in
            // migration 017; without it this INSERT dies as a 23514 and takes
            // the un-hide down with it.
            actionType = hiding ? 'content_hidden' : 'content_restored';
            // ROUND 25. TEN PEOPLE REPORTING ONE MESSAGE LEFT NINE REPORTS
            // OPEN AFTER IT WAS TAKEN DOWN.
            //
            // routes/moderation.js dedupes per REPORTER and nothing else, on
            // purpose: a second person reporting the same thing is a second
            // person waiting on an answer and must never be swallowed. The
            // consequence lands here. Once the content is hidden, every other
            // open report about it describes something that is already gone.
            // the console correctly refuses to hide it twice, so the only move
            // left on each of those cards is Dismiss, one click at a time, and
            // a brigade of two hundred reports on one message is two hundred
            // clicks of work with nothing behind them. That is not a tidiness
            // problem: it is the queue filling with resolved work while real
            // reports sit under it.
            //
            // Hiding closes them, in the SAME transaction as the takedown, so
            // there is no window in which the content is down and the reports
            // still say open. Each closed row records handled_by and
            // resolved_at like any other, which is the audit trail for those
            // rows; the single content_hidden action row names this exact
            // content_type and content_id, so "why did report #N close" is
            // answered by the takedown of the thing it was about. One audit row
            // per swept report would put two hundred rows into a LIMIT 200 log
            // and bury the decision that caused them.
            //
            // Only on the way DOWN. An un-hide does not reopen them: the
            // reports were closed by a decision a moderator has now reversed,
            // and silently pushing two hundred rows back into the queue is a
            // second surprise on top of the first. The reversal is the
            // moderator's to communicate, and content_reports keeps the row.
            //
            // The sweep itself runs below, AFTER this report's own resolution,
            // so the first content_reports write in the transaction is always
            // the one about the report in the URL.
            sweepSiblingReports = hiding;
            const row = changed.rows[0];
            audience = {
              flockId: row.flock_id ?? null,
              // Nullable on purpose: messages.sender_id is ON DELETE SET NULL,
              // and a guest RSVP has no account behind it at all.
              userIds: [row.notify_a, row.notify_b].filter((id) => id != null),
              // Read from the SAME row and the SAME statement as the user ids,
              // for the reason the RETURNING exists at all: a second read would
              // see a world the takedown has already changed, and on a rollback
              // it would address a venue about an event that never happened.
              //
              // It does NOT make hide and un-hide address the same room — they
              // are separate requests, and an owner who moves a promotion to a
              // different place id between them moves its audience with it.
              // That is correct rather than a gap: /public-promotions serves by
              // place id, so after the move the old venue's card no longer
              // carries the row and the new venue's card does. What IS
              // guaranteed is that hide and un-hide compute their audience the
              // same way from the same column, which is what stops a takedown
              // from being wider than its reversal.
              //
              // `typeof` rather than `?? null` is BELT AND BRACES, and worth
              // saying so rather than letting it read as a tested guard: every
              // non-string google_place_id is refused a second time by
              // emitToVenueContentViewers, so swapping this for `?? null`
              // changes no behaviour (MEASURED — the mutation passes every test
              // in __tests__/takedownAudience.test.js). It earns its place by
              // making `audience.placeId` honestly `string | null` for anything
              // that reads this object later, rather than "whatever the column
              // held", which is how the value would reach a room name if a
              // future caller trusted it without the helper.
              placeId: typeof row.place_id === 'string' ? row.place_id : null,
            };
          }
        }
      } else if (action === 'ban' || action === 'unban') {
        // Same lie, same fix: without a reported user there is nobody to ban.
        if (!report.reported_user_id) {
          refusal = { status: 400, error: 'This report names no user, so there is nobody to ban or unban.' };
        } else {
          const banned = action === 'ban';
          // ROUND 21 — A BAN MUST NOT BE ABLE TO CLOSE THE CONSOLE.
          //
          // middleware/auth.js refuses a banned account with 403 BEFORE
          // requireAdmin ever runs, and server.js only ever GRANTS the role
          // (`UPDATE users SET role='admin' WHERE id = ANY($1) AND role !=
          // 'admin'`) — it never clears is_banned. So banning an admin, whether
          // that is a mis-click on your own row or one moderator acting on
          // another, permanently removes that account's access to the only
          // moderation surface this product has, and the only way back in is a
          // psql prompt against production. This deployment has ONE admin:
          // ADMIN_USER_IDS was confirmed set on the Railway service on
          // 2026-08-18 (this comment said it was unset, which was true when it
          // was written and had stopped being true by the time it was read), so
          // exactly one account can reach the console and banning it is the
          // whole Guideline 1.2 control gone, silently, with the console still
          // answering 200 to the click that did it.
          //
          // Un-ban is deliberately NOT guarded: it is the recovery direction and
          // it cannot lock anybody out.
          //
          // The role check rides on the UPDATE's own WHERE rather than a
          // separate SELECT, so the success path costs no extra round trip and
          // no race window; the refusal path pays one read to say WHICH refusal
          // it was, because "that user no longer exists" would be a lie about a
          // moderator who is sitting right there.
          const changed = await client.query(
            banned
              ? `UPDATE users SET is_banned = true, banned_at = NOW()
                 WHERE id = $1 AND COALESCE(role, 'user') <> 'admin'`
              : 'UPDATE users SET is_banned = false, banned_at = NULL WHERE id = $1',
            [report.reported_user_id]
          );
          if (changed.rowCount === 0 && banned) {
            const who = await client.query('SELECT id, role FROM users WHERE id = $1', [report.reported_user_id]);
            refusal = who.rows.length === 0
              ? { status: 404, error: 'That user no longer exists. Dismiss the report instead.' }
              : {
                status: 403,
                error: report.reported_user_id === req.user.id
                  ? 'You cannot ban your own moderator account. A banned account cannot reach this console, and nothing in the app can undo that.'
                  : 'That account is a moderator, and a banned moderator cannot reach this console again. Remove its admin role on the deployment first.',
              };
          } else if (changed.rowCount === 0) {
            refusal = { status: 404, error: 'That user no longer exists. Dismiss the report instead.' };
          } else {
            actionType = banned ? 'user_banned' : 'user_unbanned';
            if (banned) banTargetId = report.reported_user_id;
          }
        }
      } else if (action === 'warn') {
        // The email is already delivered. See the block above the transaction.
        // Nothing about the account row changes: a warning is a record and a
        // message, not a state. That is the whole point of it existing between
        // "do nothing" and "banned forever".
        actionType = 'user_warned';
      } else {
        actionType = 'dismissed';
      }

      if (refusal) {
        await client.query('ROLLBACK');
      } else {
        await client.query(
          'UPDATE content_reports SET status = $1, handled_by = $2, resolved_at = NOW() WHERE id = $3',
          [newStatus, req.user.id, reportId]
        );
        // The other people waiting on this same piece of content. See the note
        // in the hide branch for why this exists and why it is one direction
        // only. Same transaction as the takedown and this report's resolution:
        // there is no moment in which the content is down and nine reports
        // still say open.
        if (sweepSiblingReports) {
          const swept = await client.query(
            `UPDATE content_reports SET status = 'resolved', handled_by = $1, resolved_at = NOW()
             WHERE content_type = $2 AND content_id = $3 AND id <> $4
               AND status IN ('open', 'under_review')`,
            [req.user.id, report.content_type, report.content_id, reportId]
          );
          alsoResolved = swept.rowCount || 0;
        }
        await client.query(
          `INSERT INTO moderation_actions (report_id, moderator_id, target_user_id, action, content_type, content_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [reportId, req.user.id, report.reported_user_id || null, actionType, report.content_type, report.content_id || null, reason || null]
        );

        await client.query('COMMIT');
      }
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    if (refusal) {
      return res.status(refusal.status).json({ error: refusal.error });
    }

    // Ban must bite NOW: the socket handshake checks is_banned once, so an
    // established connection would otherwise keep working indefinitely. Runs
    // after COMMIT so a rolled-back ban never kicks anyone off.
    if (banTargetId) {
      const io = req.app.get('io');
      if (io) io.in(`user:${banTargetId}`).disconnectSockets(true);
    }

    // Round 18: a takedown must bite as immediately as a ban does. Hiding a
    // message only changes what a FUTURE fetch returns, so the harassing DM sat
    // on the victim's screen, and in every open flock thread, until somebody
    // happened to reload. Same reasoning as the disconnect above, same
    // placement: after COMMIT, so a rolled-back takedown never tells anyone
    // their content is gone when it is still live.
    //
    // How far this reaches depends entirely on the TAKEDOWN_TARGETS entry, and
    // for two of the seven types (story, venue_event) it reaches the author and
    // nobody else. The table up there lists which is which and why those two
    // stay narrow; do not read the paragraph above as a promise that every
    // viewer is told.
    //
    // Deliberate deviation worth naming: the un-hide emits 'content_restored',
    // not 'content_removed' with an inverted flag. A client that has already
    // dropped the row needs a different instruction than one that still has it,
    // and an event called "removed" that means "put it back" is the kind of
    // name that gets handled wrong once and stays wrong.
    if (audience) {
      try {
        const io = req.app.get('io');
        if (io) {
          const event = actionType === 'content_hidden' ? 'content_removed' : 'content_restored';
          // Carries only what a client needs to drop or restore its own copy.
          // No moderator id, no reason, no reporter: the reason is free text a
          // moderator wrote for other moderators, and the reporter's identity
          // is the one thing a report must never hand to the reported.
          const payload = {
            contentType: report.content_type,
            contentId: report.content_id,
            flockId: audience.flockId,
          };
          // Membership is re-read at emit time by emitToFlockMembers, so this
          // cannot reach someone whose membership has already ended. It returns
          // the ids it delivered to, which the personal fan-out below subtracts:
          // nobody is told twice, whatever a future map entry does.
          const already = new Set();
          if (audience.flockId != null) {
            for (const id of await emitToFlockMembers(io, audience.flockId, event, payload)) {
              already.add(id);
            }
          }
          for (const uid of new Set(audience.userIds)) {
            if (already.has(uid)) continue;
            io.to(`user:${uid}`).emit(event, payload);
          }
          // The venue card viewers, LAST — the author is owed the notice
          // whatever happens to the room emit, and this one is addressed to a
          // room rather than to a list of ids.
          //
          // It is not de-duplicated against the personal rooms above, and it
          // cannot be: a room emit has no id list to subtract. So an author or
          // a venue owner who is looking at the public card their own content
          // sits on is told twice. That is a deliberate no-op rather than an
          // oversight — every reducer on the client half is idempotent and
          // returns the SAME array it was given when nothing matched
          // (dropContentById, setModerationHidden in frontend/src/App.js), so
          // the second delivery costs one comparison and no re-render. The
          // alternative is chaining Socket.io's .except() on the personal
          // rooms, which would make an exactly-once guarantee depend on room
          // bookkeeping in order to save a comparison.
          if (audience.placeId) {
            emitToVenueContentViewers(io, audience.placeId, event, payload);
          }
        }
      } catch (emitErr) {
        // The content IS hidden and the audit row IS written — both committed
        // above. A socket failure must not turn that into a 500 that tells the
        // moderator to try the takedown again.
        console.error('Takedown notify failed (the action itself committed):', emitErr);
      }
    }

    res.json({ message: 'Action applied', status: newStatus, action: actionType, alsoResolved });
  } catch (err) {
    console.error('Admin moderate error:', err);
    res.status(500).json({ error: 'Failed to apply action' });
  }
});

// ---------------------------------------------------------------------------
// Venue verification: admin flips verified after checking real ownership
// (public badge/promotions/review-replies are gated on it).
// ---------------------------------------------------------------------------
router.get('/venues/unverified', async (req, res) => {
  try {
    const result = await pool.query(
      // LIMIT, like every other list on this router. Unverified claims are the
      // one venue_profiles subset an outsider can grow: signing up as a venue
      // and claiming a place id creates a row here, and nothing prunes them, so
      // this was the only admin query whose response size was set by how many
      // junk claims exist. The queue and the audit log have carried LIMIT 200
      // since they were written.
      // Claims whose owner pressed "Request verification" come FIRST, oldest
      // request first, so the person who has waited longest cannot fall off
      // the window — the same fairness rule the report queue adopted in round
      // 24, for the same reason. Un-requested claims (junk included) keep the
      // old newest-first order below them. verification_requested_at is
      // migration 047; routes/venueProfile.js POST /request-verification is
      // the only writer of a non-null value.
      `SELECT vp.id, vp.user_id, vp.business_name, vp.location, vp.google_place_id,
              vp.created_at, vp.verification_requested_at, u.email
       FROM venue_profiles vp JOIN users u ON u.id = vp.user_id
       WHERE vp.verified = false
       ORDER BY (vp.verification_requested_at IS NOT NULL) DESC,
                vp.verification_requested_at ASC,
                vp.created_at DESC
       LIMIT 200`
    );
    res.json({ venues: result.rows });
  } catch (err) {
    console.error('Admin unverified venues error:', err);
    res.status(500).json({ error: 'Failed to load venues' });
  }
});

router.put('/venues/:profileId/verify', async (req, res) => {
  try {
    // A non-numeric :profileId used to reach Postgres as NaN and surface as a
    // 500 ("invalid input syntax for type integer"); it is a 404. venue_profiles.id
    // is a SERIAL integer, so anything that is not all digits names no row.
    const profileId = serialId(req.params.profileId);
    if (profileId === null) return res.status(404).json({ error: 'Venue profile not found' });
    // `verified` defaults to true (the button that just says "Verify" sends no
    // body), but anything that is not a real boolean is refused rather than
    // coerced: `{"verified":"false"}` used to VERIFY a claim, which is the
    // dangerous direction to get wrong on the route that decides who is allowed
    // to speak as a business.
    const payload = req.body || {};
    if ('verified' in payload && typeof payload.verified !== 'boolean') {
      return res.status(400).json({ error: 'verified must be true or false' });
    }
    const verified = payload.verified !== false;
    // Optional, and validated exactly like the reason on PUT /reports/:id, for
    // the same reason: node-postgres CONVERTS a non-string for a TEXT
    // parameter rather than refusing it, and this string is about to become
    // the permanent record of why a business badge was granted or pulled.
    const reason = payload.reason;
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== 'string') {
        return res.status(400).json({ error: 'reason must be text' });
      }
      if (reason.length > 1000) {
        return res.status(400).json({ error: 'reason is too long (max 1000 characters)' });
      }
    }
    // Migration 002 puts a unique partial index on venue_profiles
    // (google_place_id) WHERE verified = true, so verifying a SECOND claimant on
    // a place someone else already holds raised 23505 and came back a 500 — the
    // admin was told the system broke when in fact it correctly refused, and the
    // real reason (another account already owns this place) was never named.
    //
    // The conflict is detected inside the same statement rather than by a
    // separate SELECT, so there is no window between the check and the write:
    // `target` names the row being verified, `blocked` is the OTHER verified
    // claim on its place id, and the UPDATE simply does not fire when one
    // exists. The outer SELECT still returns a row whenever the profile exists,
    // so "no such profile" (0 rows) stays distinguishable from "refused" (a row
    // whose UPDATE half is missing) without a second query.
    //
    // Un-verifying is never blocked, and a NULL google_place_id cannot conflict
    // (the partial index treats NULLs as distinct), so both skip the check.
    //
    // Round 23: the `audit` CTE. This route flips the gate on who may speak as
    // a business (the public badge, promotions, review replies all key off
    // `verified`) and until now recorded nothing in either direction — the only
    // state-changing admin route with no moderation_actions row. The INSERT
    // rides INSIDE the same statement as the UPDATE rather than in a second
    // query or a client transaction, so the flip and its record land together
    // or not at all — the same doctrine as the takedown transaction above, at
    // the cost of zero extra round trips (and the venueTierGate tests hold the
    // route to exactly one statement). Reading FROM upd is what keeps the log
    // honest: a refused conflict or a missing profile produces no upd row and
    // therefore no audit row claiming work nobody did (round 13's rule).
    //
    // The action is derived from the SAME bound boolean as the write, so the
    // record cannot say the opposite of what happened. 'venue_verified' and
    // 'venue_unverified' become legal values in migration 020 — same commit,
    // per 017's hard-learned rule. target_user_id is the venue OWNER (the
    // person the action is about); content_id carries the profile id so the
    // row still names the claim when user_id is NULL.
    const result = await pool.query(
      `WITH target AS (
         SELECT id, user_id, google_place_id FROM venue_profiles WHERE id = $2
       ),
       blocked AS (
         SELECT other.user_id
         FROM venue_profiles other
         JOIN target t ON other.google_place_id = t.google_place_id
         WHERE $1::boolean = true
           AND t.google_place_id IS NOT NULL
           AND other.verified = true
           AND other.id <> t.id
         LIMIT 1
       ),
       upd AS (
         -- The pending request clears in BOTH directions: verifying fulfils
         -- it, and un-verifying (or declining) is a decision made, so leaving
         -- the timestamp would tell the owner a human still has it and keep a
         -- decided claim at the front of the queue above people still waiting.
         UPDATE venue_profiles SET verified = $1, verification_requested_at = NULL, updated_at = NOW()
         WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM blocked)
         RETURNING id, business_name, verified
       ),
       audit AS (
         INSERT INTO moderation_actions (moderator_id, target_user_id, action, content_type, content_id, reason)
         SELECT $3, t.user_id,
                CASE WHEN $1::boolean THEN 'venue_verified' ELSE 'venue_unverified' END,
                'venue_profile', t.id, $4
         FROM upd u JOIN target t ON t.id = u.id
       )
       SELECT u.id, u.business_name, u.verified,
              t.google_place_id,
              (SELECT user_id FROM blocked) AS conflict_user_id
       FROM target t LEFT JOIN upd u ON true`,
      [verified, profileId, req.user.id, reason || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Venue profile not found' });
    const row = result.rows[0];
    // The refusal is read off the UPDATE, not off the conflicting owner's id:
    // venue_profiles.user_id is nullable, so a conflicting row with a NULL
    // user_id would otherwise have looked like success and answered 200 with a
    // row of nulls. `blocked` is the only thing that can stop the UPDATE, so a
    // target that exists with no updated row IS the conflict.
    if (row.id == null) {
      const who = row.conflict_user_id != null ? `Another account (user ${row.conflict_user_id})` : 'Another account';
      return res.status(409).json({
        error: `${who} is already the verified owner of Google place ${row.google_place_id}. Un-verify that claim first.`,
        code: 'PLACE_ALREADY_VERIFIED',
        conflictUserId: row.conflict_user_id ?? null,
        googlePlaceId: row.google_place_id,
      });
    }
    res.json({ id: row.id, business_name: row.business_name, verified: row.verified });
  } catch (err) {
    // Two admins verifying rival claims on the same place at the same instant
    // both see an empty `blocked`, and the unique index decides. That is the
    // same refusal, so it gets the same answer instead of a 500.
    if (err && err.code === '23505') {
      return res.status(409).json({
        error: 'Another account is already the verified owner of that Google place. Un-verify that claim first.',
        code: 'PLACE_ALREADY_VERIFIED',
      });
    }
    console.error('Admin verify venue error:', err);
    res.status(500).json({ error: 'Failed to update verification' });
  }
});

// The founding-venue offer, from VENUE-PRICING.md: the first 10-15 verified
// venues in one city get Roost free for SIX MONTHS, in exchange for keeping
// their slider current and completing intake. Six months is the offer, so six
// months is what `grantReason: 'founding_comp'` means when nobody names an end
// date — the one length in this file that comes from a decision rather than a
// default. Change it here and in VENUE-PRICING.md together, or the offer and
// the code stop being the same promise.
const FOUNDING_COMP_MONTHS = 6;

// The machine-readable WHY of a grant. The human sentence stays in `reason`,
// which lands in moderation_actions like every other admin action's reason;
// this is the part a query can group by when someone asks how many founding
// comps are still running.
const GRANT_REASONS = ['founding_comp', 'paid', 'admin', 'demo'];

const MAX_GRANT_DAYS = 1095; // three years. Longer than that, say null and mean it.

// Calendar months, not 30-day blocks: "free until February" is the promise the
// venue heard, and 183 days is not that sentence. JS rolls a short month
// forward (Aug 31 + 6 => Mar 3), which is the harmless direction.
function monthsFromNow(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// POST /api/admin/venues/:userId/tier — comp or change a venue's tier
// (VENUE-BILLING.md Phase 0: tier is server-written only; this is the manual
// path for demos and hand-sold venues until Stripe self-serve exists).
//
// ONE STATEMENT WRITES THREE THINGS, and that is load-bearing: the cache
// (venue_profiles.tier), the grant the gate actually reads (venue_subscriptions,
// migration 040) and the durable audit row. A tier that exists in one of those
// and not the others is the bug this route is most likely to grow, so they must
// not be three round trips that can half-fail.
router.post('/venues/:userId/tier', async (req, res) => {
  try {
    const { tier, reason, grantReason, expiresAt, durationDays } = req.body || {};
    if (!['free', 'premium', 'pro'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be free, premium, or pro' });
    }
    if (grantReason !== undefined && grantReason !== null && !GRANT_REASONS.includes(grantReason)) {
      return res.status(400).json({ error: 'grantReason must be one of ' + GRANT_REASONS.join(', ') });
    }
    // Two ways to say the same thing, so saying both is a mistake worth
    // refusing rather than quietly resolving in one of their favours.
    if (expiresAt !== undefined && durationDays !== undefined) {
      return res.status(400).json({ error: 'send expiresAt or durationDays, not both' });
    }

    // THE TRI-STATE THAT KEEPS A GRANT FROM BEING SILENTLY EXTENDED.
    //   omitted        -> whatever end date is already on file survives
    //   expiresAt:null -> the admin is explicitly saying "no end date"
    //   a value        -> that is the end date
    // Re-granting the same tier to fix a typo in the reason must not hand the
    // venue another six months, which is exactly what a plain COALESCE in the
    // upsert below would have done.
    const expirySpecified = expiresAt !== undefined || durationDays !== undefined;
    let endsAt = null;
    if (durationDays !== undefined) {
      if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_GRANT_DAYS) {
        return res.status(400).json({ error: 'durationDays must be a whole number of days from 1 to ' + MAX_GRANT_DAYS });
      }
      endsAt = new Date(Date.now() + durationDays * 86400000);
    } else if (expiresAt !== undefined && expiresAt !== null) {
      if (typeof expiresAt !== 'string') {
        return res.status(400).json({ error: 'expiresAt must be an ISO date string or null' });
      }
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'expiresAt must be an ISO date string or null' });
      }
      // A grant that has already expired is not a grant, it is a downgrade
      // written the confusing way. Say tier free instead.
      if (parsed.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'expiresAt is in the past. To remove a tier, set tier to free.' });
      }
      endsAt = parsed;
    }

    // The founding default, applied ONLY when nobody named a date, and only to a
    // grant that does not already have one (the COALESCE in the upsert). A
    // second founding_comp grant is a correction, not a renewal.
    const foundingDefault = !expirySpecified && grantReason === 'founding_comp' && tier !== 'free';
    if (foundingDefault) endsAt = monthsFromNow(FOUNDING_COMP_MONTHS);
    // Round 23: the reason is validated like every other audit reason on this
    // router (see PUT /reports/:id) because it is about to be stored, not
    // logged. Before this round it was interpolated into console.log, which
    // Railway rotates away — so the ONLY server-side writer of
    // venue_profiles.tier, the whole manual billing control, kept no durable
    // record of who comped what or why.
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== 'string') {
        return res.status(400).json({ error: 'reason must be text' });
      }
      if (reason.length > 1000) {
        return res.status(400).json({ error: 'reason is too long (max 1000 characters)' });
      }
    }
    // A non-numeric :userId reached Postgres as NaN and came back a 500; users.id
    // is an integer key, so a non-digit id names no venue owner — 404, not 500.
    const targetUserId = serialId(req.params.userId);
    if (targetUserId === null) return res.status(404).json({ error: 'Venue profile not found' });
    // One statement, three CTEs, same shape and same reasons as the verify
    // route above: `old` reads the tier from the statement's snapshot (i.e.
    // BEFORE the write), so the audit row records a transition — "tier free ->
    // premium" — and not merely that something changed; `audit` reads FROM upd
    // so a missing profile writes no row; and 'tier_changed' becomes legal in
    // migration 020, in this same commit. The stored reason is the transition
    // plus the moderator's text, because moderation_actions has no other
    // column for it and a tier_changed row that does not say from-what
    // to-what answers none of the questions a billing dispute asks.
    const result = await pool.query(
      `WITH old AS (
         SELECT user_id, tier, verified FROM venue_profiles WHERE user_id = $2
       ),
       upd AS (
         UPDATE venue_profiles SET tier = $1, updated_at = NOW()
         FROM old
         WHERE venue_profiles.user_id = old.user_id
           AND ($1 = 'free' OR old.verified = true)
         RETURNING venue_profiles.id, venue_profiles.business_name, venue_profiles.tier, old.tier AS old_tier
       ),
       granted AS (
         INSERT INTO venue_subscriptions
           (user_id, tier, source, status, granted_reason, granted_at, granted_by, expires_at, updated_at)
         SELECT $2, $1, $9, 'active', $8, NOW(), $3, $5::timestamptz, NOW() FROM upd
         ON CONFLICT (user_id) DO UPDATE SET
           tier = EXCLUDED.tier,
           source = EXCLUDED.source,
           status = 'active',
           granted_reason = EXCLUDED.granted_reason,
           granted_at = NOW(),
           granted_by = EXCLUDED.granted_by,
           expires_at = CASE
             WHEN $1 = 'free' THEN NULL
             WHEN $6 THEN EXCLUDED.expires_at
             WHEN $7 THEN COALESCE(venue_subscriptions.expires_at, EXCLUDED.expires_at)
             ELSE venue_subscriptions.expires_at
           END,
           updated_at = NOW()
         RETURNING user_id, expires_at, granted_reason
       ),
       audit AS (
         INSERT INTO moderation_actions (moderator_id, target_user_id, action, content_type, content_id, reason)
         SELECT $3, $2, 'tier_changed', 'venue_profile', u.id,
                'tier ' || COALESCE(u.old_tier, 'free') || ' -> ' || u.tier || COALESCE(': ' || $4::text, '')
                  || COALESCE(' (until ' || to_char(g.expires_at, 'YYYY-MM-DD') || ')', '')
         FROM upd u LEFT JOIN granted g ON g.user_id = $2
       )
       SELECT u.id, u.business_name, u.tier, g.expires_at, g.granted_reason
         FROM old o
         LEFT JOIN upd u ON true
         LEFT JOIN granted g ON true`,
      [tier, targetUserId, req.user.id, reason || null, endsAt, expirySpecified, foundingDefault,
        grantReason || (tier === 'free' ? null : 'admin'),
        grantReason === 'founding_comp' ? 'comp' : 'admin']
    );
    // No `old` row at all: this user has no venue profile.
    if (result.rows.length === 0) return res.status(404).json({ error: 'Venue profile not found' });
    // A profile that exists but did not update: the UPDATE's own guard refused
    // it. VENUE-BILLING.md states the rule three times because it is the one
    // that costs money if missed. A paid tier requires venue_profiles.verified,
    // because a role is not proof of ownership, and comping Roost to an
    // unverified claim hands a stranger a forecast about someone else's bar.
    // Verify the claim first, then grant. Downgrades to free are always allowed.
    if (result.rows[0].id === null || result.rows[0].id === undefined) {
      return res.status(409).json({
        error: 'This venue is not verified yet. Verify the claim before granting a paid tier.',
        code: 'VENUE_NOT_VERIFIED',
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin venue tier error:', err);
    res.status(500).json({ error: 'Failed to update tier' });
  }
});

// GET /api/admin/moderation-actions — audit log
router.get('/moderation-actions', async (req, res) => {
  try {
    // Round 23: evidence-access records ('evidence_viewed', two per fully
    // opened report) are excluded from the DEFAULT list, because they would
    // drown the LIMIT-200 window a moderator reads for DECISIONS — hides,
    // bans, reversals. They are not hidden: ?include_evidence=true serves
    // them, so answering "which reports did this moderator open" is one query
    // away rather than a psql prompt. A bound boolean, not string-built SQL.
    const includeEvidence = req.query.include_evidence === 'true';
    const result = await pool.query(
      `SELECT ma.*, mod.name AS moderator_name, tu.name AS target_user_name
       FROM moderation_actions ma
       LEFT JOIN users mod ON mod.id = ma.moderator_id
       LEFT JOIN users tu ON tu.id = ma.target_user_id
       WHERE ($1::boolean OR ma.action <> 'evidence_viewed')
       ORDER BY ma.created_at DESC LIMIT 200`,
      [includeEvidence]
    );
    res.json({ actions: result.rows });
  } catch (err) {
    console.error('Admin audit log error:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/costs — what Flock costs, in three clearly separated kinds
// ---------------------------------------------------------------------------
//
// Admin only, like everything else on this router (requireAdmin at the top).
//
// THE ONE RULE THIS ROUTE EXISTS TO ENFORCE: a ceiling is not a bill. Three
// blocks come back and they never share a number.
//
//   observed   what the meters counted, priced at the rate card
//   worstCase  what the ceilings permit, priced at the same rate card
//   fixed      the bills that arrive whether anybody uses the app or not
//
// services/costModel.js owns the arithmetic and the rate card. This route owns
// only the reads: it turns meters into COUNTS and constants into LIMITS, and
// hands each set to the builder that may see it. buildObserved() is never given
// a limit and buildWorstCase() is never given a meter, so neither can print the
// other's number even by mistake. __tests__/costModel.test.js pins that.
//
// WHAT THE NUMBERS ARE WORTH, said here as well as in the payload, because
// somebody will read this route before they read the panel:
//   * The Postgres ledgers (advisor_spend, advisor_venue_spend,
//     venue_digest_sends) are durable. They survive deploys and replicas and
//     they add up over a month.
//   * Every other meter is in one container's memory. It reads zero after a
//     deploy and it divides by the instance count. Those lines are labelled
//     durable false, and the panel says "today, this process only" rather than
//     pretending to be a month.
//   * None of it is an invoice. costModel.RECONCILED carries the only figure a
//     human has actually seen on a bill, and its date says how stale it is.
//
// Every ledger read is wrapped: a meter that throws must degrade to "not
// measured" rather than 500 the whole panel, because the fixed-cost half is
// still worth showing when the database is unreachable.
const costModel = require('../services/costModel');
const birdieUsage = require('../services/birdieUsage');
const { placesBudgetStatus } = require('../utils/placesBudget');
const { visionBudgetStatus } = require('../utils/visionBudget');
const { weatherBudgetStatus } = require('../services/weatherService');
const advisorPhrasing = require('../services/advisorPhrasing');
const advisorPrompt = require('../services/advisorPrompt');
const advisorFreeText = require('../services/advisorFreeText');

// Roost's price, from VENUE-PRICING.md (2026-08-20). One location, monthly.
// A constant rather than a query because nothing has ever been charged, so
// there is no row anywhere that knows it.
const VENUE_PRICE_USD = 99;

// The per-venue spend table is one row per venue per day. Bounded like every
// other list on this router.
const COST_VENUE_LIMIT = 25;

// The estimator convention shared by birdieUsage and advisorPhrasing.
const COST_CHARS_PER_TOKEN = 4;

// Never let one broken meter take the panel down with it.
function meterOrNull(read) {
  try {
    const v = read();
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

router.get('/costs', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // -- In-memory meters, turned into plain counts -----------------------------
  const birdieTokensToday = meterOrNull(() => birdieUsage.geminiSpendStatus(null).globalUsed);
  const placesCallsToday = meterOrNull(() => placesBudgetStatus(null).globalUsed);
  // The photo meter is no longer in this list: it moved out of memory and into
  // places_photo_spend, so it reads with the durable ledgers below.
  const visionCallsToday = meterOrNull(() => visionBudgetStatus(null).globalUsed);
  const weatherCallsToday = meterOrNull(() => weatherBudgetStatus().dailyUsed);
  const ticketmasterCallsToday = meterOrNull(() => require('./events').budgetStatus().globalUsed);
  const nightContextCallsToday = meterOrNull(
    () => require('../services/nightContext').nightContextBudgetStatus().globalUsed
  );
  // The THIRD Ticketmaster ledger. Every crowd prediction's event enrichment is
  // charged here (services/mlPredictor.js EVENT_DAILY_BUDGET), and it was the
  // one ledger this panel had no meter for, so both the observed count and the
  // worst-case ceiling below were short by 1,500 calls a day.
  const crowdEventCallsToday = meterOrNull(
    () => require('../services/mlPredictor').eventBudgetStatus().globalUsed
  );

  // -- Durable ledgers --------------------------------------------------------
  // Each read is independent: one unavailable table leaves that line unmeasured
  // rather than emptying the panel.
  const safe = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error('Admin costs: a ledger read failed:', err.message);
      return null;
    }
  };

  // Google Place Photos, from the durable ledger. Historically the largest line
  // on the Google bill and, until 2026-08-20, the one meter that read zero after
  // every deploy, so the panel under-reported photo spend by the most on
  // exactly the days there was the most of it.
  const photoSpend = await safe(() => require('../services/photoStore').photoSpendStatus());

  const advisorSpend = await safe(async () => {
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(tokens) FILTER (WHERE day = CURRENT_DATE), 0)                       AS today,
         COALESCE(SUM(tokens) FILTER (WHERE day >= DATE_TRUNC('month', CURRENT_DATE)), 0) AS month
       FROM advisor_spend`
    );
    const row = r.rows[0] || {};
    return { today: Number(row.today) || 0, month: Number(row.month) || 0 };
  });

  const venueSpend = await safe(async () => {
    const r = await pool.query(
      `SELECT venue_user_id,
              SUM(tokens)::bigint AS tokens,
              SUM(answers)::int   AS answers,
              SUM(questions)::int AS questions
         FROM advisor_venue_spend
        WHERE day >= DATE_TRUNC('month', CURRENT_DATE)
        GROUP BY venue_user_id
        ORDER BY tokens DESC
        LIMIT ${COST_VENUE_LIMIT}`
    );
    return (r.rows || []).map((v) => ({
      venueUserId: v.venue_user_id,
      tokens: Number(v.tokens) || 0,
      answers: Number(v.answers) || 0,
      questions: Number(v.questions) || 0,
    }));
  });

  const digestEmailsMonth = await safe(async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM venue_digest_sends
        WHERE sent_at >= DATE_TRUNC('month', CURRENT_DATE)`
    );
    return Number(r.rows[0] && r.rows[0].n) || 0;
  });

  const payingVenues = await safe(async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM venue_subscriptions
        WHERE granted_reason = 'paid'
          AND status IN ('active', 'trialing', 'past_due')
          AND (expires_at IS NULL OR expires_at > NOW())`
    );
    return Number(r.rows[0] && r.rows[0].n) || 0;
  });

  // -- The advisor's own shape, read from the modules that own it -------------
  // Not restated here. The system prompt's length and the maxOutputTokens the
  // API is actually handed are what decide the input/output split, and both
  // live in other files. Copying either would make this panel drift the first
  // time somebody edits a prompt.
  const advisorPromptTokens = Math.ceil(advisorPrompt.SYSTEM_PROMPT.length / COST_CHARS_PER_TOKEN);
  const advisorMaxOutputTokens = advisorPhrasing.ADVISOR_MAX_OUTPUT_TOKENS;
  // The free-text half of the same surface. Its advice call has a SHORTER
  // system prompt against the same output ceiling, so its output fraction is
  // the highest of any advisor call, and output bills at five times input.
  // Both the global worst case and the per-venue band need it: either ceiling
  // can be spent entirely on advice.
  const advisorAdvicePromptTokens = Math.ceil(advisorPrompt.ADVICE_SYSTEM_PROMPT.length / COST_CHARS_PER_TOKEN);
  const advisorAdviceMaxOutputTokens = advisorFreeText.ADVICE_MAX_OUTPUT_TOKENS;
  const advisorModel = advisorPhrasing.advisorModel();
  const birdieModel = process.env.BIRDIE_MODEL || 'gemini-3.5-flash-lite';

  // -- COUNTS go to the observed builder. No limit is in this object. ---------
  const observed = costModel.buildObserved({
    onDate: today,
    birdieTokensToday,
    birdieModel,
    advisorTokensToday: advisorSpend ? advisorSpend.today : null,
    advisorTokensMonth: advisorSpend ? advisorSpend.month : null,
    advisorModel,
    advisorPromptTokens,
    advisorMaxOutputTokens,
    placesCallsToday,
    placesPhotoCallsToday: photoSpend ? photoSpend.dayUsed : null,
    placesPhotoCallsMonth: photoSpend ? photoSpend.monthUsed : null,
    placesPhotoBudget: photoSpend ? photoSpend.limits : null,
    visionCallsToday,
    weatherCallsToday,
    ticketmasterCallsToday,
    nightContextCallsToday,
    crowdEventCallsToday,
    digestEmailsMonth,
  });

  // -- LIMITS go to the worst-case builder. No count is in this object. -------
  const worstCase = costModel.buildWorstCase({
    onDate: today,
    birdieGlobalDailyTokens: birdieUsage.GLOBAL_DAILY_TOKENS,
    birdieModel,
    advisorGlobalDailyTokens: advisorPhrasing.ADVISOR_GLOBAL_DAILY_TOKENS,
    advisorPerVenueDailyTokens: advisorPhrasing.PER_VENUE_DAILY_TOKENS,
    advisorModel,
    advisorPromptTokens,
    advisorMaxOutputTokens,
    advisorAdvicePromptTokens,
    advisorAdviceMaxOutputTokens,
    placesGlobalDaily: placesBudgetStatus(null).limits.globalDaily,
    visionGlobalDaily: visionBudgetStatus(null).limits.globalDaily,
    weatherDaily: weatherBudgetStatus().limits.daily,
    ticketmasterGlobalDaily: meterOrNull(() => require('./events').budgetStatus().limits.globalDaily),
    crowdEventGlobalDaily: meterOrNull(
      () => require('../services/mlPredictor').eventBudgetStatus().limits.globalDaily
    ),
    nightContextGlobalDaily: meterOrNull(
      () => require('../services/nightContext').nightContextBudgetStatus().limits.globalDaily
    ),
  });

  // The busiest venue this month is the one worth pricing, because it is the
  // only one whose number is not zero. With no rows at all this stays null and
  // the panel says nothing has been measured.
  const topVenue = venueSpend && venueSpend.length > 0 ? venueSpend[0] : null;

  const venueUnitEconomics = costModel.buildVenueUnitEconomics({
    onDate: today,
    priceUsd: VENUE_PRICE_USD,
    perVenueDailyTokens: advisorPhrasing.PER_VENUE_DAILY_TOKENS,
    advisorModel,
    advisorPromptTokens,
    advisorMaxOutputTokens,
    // The free-text half of the same surface: the highest output fraction of
    // any advisor call, and what sets the top of the per-venue cost band.
    advisorAdvicePromptTokens,
    advisorAdviceMaxOutputTokens,
    observedTokensMonth: topVenue ? topVenue.tokens : null,
  });

  const fixed = costModel.buildFixed();

  // Is Cloud Vision actually reachable on the project its key belongs to.
  // A key being SET and the API being ENABLED are different facts, and only
  // the second decides whether an upload can be screened at all. This probe
  // costs nothing: it sends zero images. utils/moderation.js explains why.
  const visionProvider = await safe(() => require('../utils/moderation').probeVisionEnabled());

  res.json({
    generatedAt: new Date().toISOString(),
    observed,
    worstCase,
    fixed,
    venueUnitEconomics,
    watchlist: costModel.WATCHLIST,
    reconciled: costModel.RECONCILED,
    // EVERY group on the rate card, not the three that happened to be named
    // here. Nine of the twelve carried a checked date and a source that no
    // screen ever showed, which is the same as not carrying one.
    rates: {
      checked: Object.fromEntries(
        Object.entries(costModel.RATES).map(([k, v]) => [k, v.checked])
      ),
      sources: Object.fromEntries(
        Object.entries(costModel.RATES).map(([k, v]) => [k, v.source])
      ),
    },
    // The photo budget, whole, because it is the one ceiling in this panel that
    // a person is expected to RAISE rather than merely watch. Historically the
    // largest line on the Google bill, and now the only one with a dollar figure
    // attached to it instead of a request count.
    photoBudget: photoSpend,
    // THE INVENTORY. Every outside thing Flock depends on, including the ones
    // that cost nothing. "What am I paying for" and "what am I using" are
    // different questions and only the first was ever answered on this
    // screen. It carries join keys rather than numbers: the panel resolves
    // each entry against observed, fixed and watchlist, so no price and no
    // sentence exists twice in this payload.
    dependencies: costModel.buildDependencies({
      onDate: today,
      birdieModel,
      advisorModel,
    }),
    // Google's own per-day quota caps, set by hand in the Cloud console on
    // 2026-08-20. Unlike every other ceiling on this panel these cannot be
    // raised with a deploy, and hitting one refuses the call, so a quota is
    // now a real failure mode with a visible shape: a venue card with no
    // picture, a search that finds nothing.
    // The photo brake is passed as a LIMIT, read from the constant rather than
    // from the ledger status, so it still arrives when Postgres is down.
    googleQuotas: costModel.buildGoogleQuotas({
      photoBurstPerDay: require('../services/photoStore').PHOTO_FETCH_BURST_PER_DAY,
    }),
    // Whether images can be screened at all right now. A cost panel that
    // says Vision billed nothing, without saying whether Vision answers, is
    // reporting the least useful true thing available.
    visionProvider,
    venues: {
      paying: payingVenues,
      priceUsd: VENUE_PRICE_USD,
      withRoostSpendThisMonth: venueSpend ? venueSpend.length : null,
      perVenue: venueSpend,
    },
    // Said in the payload, not only in the panel, so an API reader cannot miss
    // it either.
    disclaimer:
      'observed is priced from meters and is an estimate of a bill, not a bill. worstCase is what ceilings permit and nothing has ever reached one. reconciled is the only line a human has seen on an invoice.',
  });
});

module.exports = router;
// Exposed for __tests__/adminEvidence.test.js, which diffs CONTENT_TEXT_SQL and
// REPORT_TEXT_SOURCES against routes/moderation.js's VALID_CONTENT_TYPES — the
// same drift guard safetyFlow.test.js runs against the migration and
// moderationConsoleContract.test.js runs against the console. A property on the
// router changes nothing about the mount in server.js.
module.exports.__test = {
  CONTENT_TEXT_SQL,
  VENUE_PRICE_USD,
  COST_VENUE_LIMIT,
  REPORT_TEXT_SOURCES,
  REPORT_IMAGE_SOURCES,
  TAKEDOWN_TARGETS,
  FULL_TEXT_MAX,
  QUEUE_LIMIT_DEFAULT,
  QUEUE_LIMIT_MAX,
  QUEUE_OFFSET_MAX,
};
