const express = require('express');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
// Round 18: a takedown has to reach the people looking at the content right
// now, the same way a ban force-disconnects instead of waiting for a refetch.
const { emitToFlockMembers } = require('../sockets/handlers');

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
  // The profile IS the reported content. users has no bio column, so name plus
  // interests plus the avatar (served by /reports/:id/image) is all of it.
  profile: (t) => `NULLIF(CONCAT_WS(' / ', ${t}.name, NULLIF(ARRAY_TO_STRING(${t}.interests, ', '), '')), '')`,
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

// GET /api/admin/reports?status=open — moderation queue
router.get('/reports', async (req, res) => {
  try {
    const { status } = req.query;
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
                 AND c.body IS NULL AND c.created_at IS NULL) AS content_missing
       FROM content_reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users tu ON tu.id = r.reported_user_id
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
       ORDER BY (r.status = 'open') DESC, r.created_at DESC
       LIMIT 200`,
      params
    );
    // Counts for the queue header
    const counts = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM content_reports GROUP BY status`
    );
    res.json({ reports: result.rows, counts: counts.rows });
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
// two column names so the caller does not branch: `flock_id` (fan out to
// accepted members) and `notify_*` user ids (personal rooms). 'profile' is
// deliberately absent — a profile report has no row to hide.
//
// ROUND 20, HONEST SCOPE. This block used to claim the emit reaches "the people
// who can currently see the content". That is true for exactly two of the six
// entries and the comment was doing real harm, because it reads as a guarantee
// that the takedown retracts content from live screens everywhere:
//
//   flock_message  TRUE  — every accepted member, re-read at emit time.
//   guest_rsvp     TRUE  — same, and a guest has no account to tell.
//   dm             TRUE  — a DM has exactly two viewers and both are told.
//   story          NO    — the AUTHOR only. Its viewers are the author's
//                          friends and flock mates, computed per viewer by the
//                          feed query; there is no room that holds them.
//   venue_review   NO    — the author only.
//   venue_promotion NO   — the venue owner only.
//   venue_event    NO    — the venue owner only.
//
// The comment is corrected rather than the audience widened, deliberately:
//
//   * There is no venue viewer room to emit into. `venue:{placeId}` exists in
//     sockets/handlers.js for crowd updates, and its members are whoever asked
//     for live crowd levels, which is neither the set looking at the reviews
//     nor a set anyone maintains for this purpose.
//   * A story's audience is a per-viewer SQL predicate (see
//     utils/relationships.js), so widening means running a fan-out query per
//     takedown and emitting into hundreds of personal rooms for content that
//     expires in 24 hours anyway.
//   * Nothing on the client listens. `content_removed` has no handler in
//     frontend/src for ANY type, so today the widening would be fan-out with no
//     receiver. The three narrow emits are already ahead of the client.
//
// What actually protects a reader in the meantime is that every read path
// filters is_hidden, so the content is gone the moment anything refetches. The
// live retraction is the optimisation, not the takedown. If the client ever
// grows a handler, widen story first: it is the type where the gap between "the
// author knows" and "the viewers stop seeing it" lasts longest.
const TAKEDOWN_TARGETS = {
  // Flock chat: the audience is the flock, not the author.
  flock_message: { table: 'messages', audience: 'flock_id, NULL::int AS notify_a, NULL::int AS notify_b' },
  // A DM has exactly two people who can see it, and both need to be told: the
  // recipient so it leaves their thread, the author so a takedown is not silent.
  dm: { table: 'direct_messages', audience: 'NULL::int AS flock_id, sender_id AS notify_a, receiver_id AS notify_b' },
  story: { table: 'stories', audience: 'NULL::int AS flock_id, user_id AS notify_a, NULL::int AS notify_b' },
  venue_review: { table: 'venue_reviews', audience: 'NULL::int AS flock_id, user_id AS notify_a, NULL::int AS notify_b' },
  venue_promotion: { table: 'venue_promotions', audience: 'NULL::int AS flock_id, venue_user_id AS notify_a, NULL::int AS notify_b' },
  // venue_event: is_hidden added by migration 019. Nothing serves venue events
  // publicly yet, so no report can be filed against one from a real screen
  // today — but routes/moderation.js accepts the type, which means one CAN
  // arrive, and a report the queue cannot action is the failure this map exists
  // to prevent (round 13's guest_rsvp hole, which sat open for two rounds).
  venue_event: { table: 'venue_events', audience: 'NULL::int AS flock_id, venue_user_id AS notify_a, NULL::int AS notify_b' },
  // A guest RSVP has no account behind it, so there is nobody personal to tell;
  // the flock members watching the roster are the whole audience.
  guest_rsvp: { table: 'guest_rsvps', audience: 'flock_id, NULL::int AS notify_a, NULL::int AS notify_b' },
};

// PUT /api/admin/reports/:id — take a moderation action:
//   action ∈ 'hide' (take content down) | 'unhide' (put it back) | 'ban' |
//            'unban' | 'dismiss'
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
    if (!['hide', 'unhide', 'ban', 'unban', 'dismiss'].includes(action)) {
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
            const row = changed.rows[0];
            audience = {
              flockId: row.flock_id ?? null,
              // Nullable on purpose: messages.sender_id is ON DELETE SET NULL,
              // and a guest RSVP has no account behind it at all.
              userIds: [row.notify_a, row.notify_b].filter((id) => id != null),
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
          // psql prompt against production. On a deployment with one admin (the
          // current one — ADMIN_USER_IDS is unset, so today there are none at
          // all) that is the whole Guideline 1.2 control gone, silently, with
          // the console still answering 200 to the click that did it.
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
    // for four of the seven types it reaches the author and nobody else. The
    // table up there lists which is which and why the narrow ones stay narrow;
    // do not read the paragraph above as a promise that every viewer is told.
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
        }
      } catch (emitErr) {
        // The content IS hidden and the audit row IS written — both committed
        // above. A socket failure must not turn that into a 500 that tells the
        // moderator to try the takedown again.
        console.error('Takedown notify failed (the action itself committed):', emitErr);
      }
    }

    res.json({ message: 'Action applied', status: newStatus, action: actionType });
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
      `SELECT vp.id, vp.user_id, vp.business_name, vp.location, vp.google_place_id, vp.created_at, u.email
       FROM venue_profiles vp JOIN users u ON u.id = vp.user_id
       WHERE vp.verified = false ORDER BY vp.created_at DESC
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
    const result = await pool.query(
      `WITH target AS (
         SELECT id, google_place_id FROM venue_profiles WHERE id = $2
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
         UPDATE venue_profiles SET verified = $1, updated_at = NOW()
         WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM blocked)
         RETURNING id, business_name, verified
       )
       SELECT u.id, u.business_name, u.verified,
              t.google_place_id,
              (SELECT user_id FROM blocked) AS conflict_user_id
       FROM target t LEFT JOIN upd u ON true`,
      [verified, profileId]
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

// POST /api/admin/venues/:userId/tier — comp or change a venue's tier
// (VENUE-BILLING.md Phase 0: tier is server-written only; this is the manual
// path for demos and hand-sold venues until Stripe self-serve exists).
router.post('/venues/:userId/tier', async (req, res) => {
  try {
    const { tier, reason } = req.body;
    if (!['free', 'premium', 'pro'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be free, premium, or pro' });
    }
    // A non-numeric :userId reached Postgres as NaN and came back a 500; users.id
    // is an integer key, so a non-digit id names no venue owner — 404, not 500.
    const targetUserId = serialId(req.params.userId);
    if (targetUserId === null) return res.status(404).json({ error: 'Venue profile not found' });
    const result = await pool.query(
      'UPDATE venue_profiles SET tier = $1, updated_at = NOW() WHERE user_id = $2 RETURNING id, business_name, tier',
      [tier, targetUserId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Venue profile not found' });
    console.log(`[Admin] venue tier: user ${req.params.userId} -> ${tier} by admin ${req.user.id} (${reason || 'no reason given'})`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin venue tier error:', err);
    res.status(500).json({ error: 'Failed to update tier' });
  }
});

// GET /api/admin/moderation-actions — audit log
router.get('/moderation-actions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ma.*, mod.name AS moderator_name, tu.name AS target_user_name
       FROM moderation_actions ma
       LEFT JOIN users mod ON mod.id = ma.moderator_id
       LEFT JOIN users tu ON tu.id = ma.target_user_id
       ORDER BY ma.created_at DESC LIMIT 200`
    );
    res.json({ actions: result.rows });
  } catch (err) {
    console.error('Admin audit log error:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

module.exports = router;
// Exposed for __tests__/adminEvidence.test.js, which diffs CONTENT_TEXT_SQL and
// REPORT_TEXT_SOURCES against routes/moderation.js's VALID_CONTENT_TYPES — the
// same drift guard safetyFlow.test.js runs against the migration and
// moderationConsoleContract.test.js runs against the console. A property on the
// router changes nothing about the mount in server.js.
module.exports.__test = {
  CONTENT_TEXT_SQL,
  REPORT_TEXT_SOURCES,
  REPORT_IMAGE_SOURCES,
  TAKEDOWN_TARGETS,
  FULL_TEXT_MAX,
};
