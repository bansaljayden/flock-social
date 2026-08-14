// ---------------------------------------------------------------------------
// Stories — 24-hour user-generated photo posts.
//
//   GET    /api/stories       — feed of live stories from friends / flock mates
//   POST   /api/stories       — post a story (moderated, rate limited)
//   DELETE /api/stories/:id   — remove your own story
//
// There is deliberately NO edit route. Every story is screened once, at
// creation: the caption goes through the text filter and the image through
// Cloud Vision SafeSearch. An update route would let a story pass that screen
// with a clean photo and then be swapped for anything at all, with the row's
// moderation history unchanged and every viewer's cached feed none the wiser.
// A user who wants different content deletes and posts again, which re-runs
// both screens. Do not add PUT/PATCH here without also re-running moderation on
// the new content.
//
// For the same reason `image_url` may only ever be a data: URL. A remote https
// URL is content the author can change AFTER it was approved (and a tracking
// pixel pointed at every friend who opens the feed): the bytes we screened
// would not be the bytes anyone sees. routes/messages.js takes the same line.
// ---------------------------------------------------------------------------
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
// Shape before content — see validators/shape.js.
const { freeText } = require('../validators/shape');
// Called through the module object rather than destructured on purpose. The
// fail-closed image screen is the single most important line in this file and a
// destructured binding is frozen at require time, which leaves no way for
// __tests__/storiesFlow.test.js to prove BOTH that a refusal blocks the INSERT
// and that an approval lets it through. Keep the `moderation.` prefix.
const moderation = require('../utils/moderation');

const router = express.Router();

router.use(authenticate);

// stories.id and users.id are int4 columns. Anything outside the range names no
// row, and letting it reach Postgres turns a bad request into a 500.
const INT4_MAX = 2147483647;

// Feed page size. Story images are stored INLINE as base64 data URLs (this app
// has no object storage), so a page of stories is a page of whole images: the
// row cap is really a response-size cap. 50 rows x the 700KB per-story ceiling
// below is the worst case, and that is why the maximum is not larger. If
// stories ever move to hosted URLs, this can go back up.
const DEFAULT_FEED_LIMIT = 30;
const MAX_FEED_LIMIT = 50;

const MAX_CAPTION_LENGTH = 300;

// Matches the avatar ceiling in routes/users.js, for the same reason: a stored
// data URL is re-sent in full on every feed read. express.json caps the whole
// body at 1mb, so this also keeps a legitimate post from dying as a bare 413.
const MAX_IMAGE_DATA_URL_BYTES = 700 * 1024;

// Flood control. Five posts an hour and ten live at once is far above what a
// real person does with a 24-hour format and far below what it takes to push
// everyone else out of a friend's feed. Enforced in SQL, not in a Map: an
// in-memory counter resets on every deploy and does not exist on the other
// instance.
const STORIES_PER_HOUR = 5;
const MAX_ACTIVE_STORIES = 10;

// Strict, whole-string: prefix-only matching (`/^data:image\/png;base64,/`)
// accepts arbitrary trailing junk after the payload, which is a place to park
// markup that some future consumer renders.
//
// GIF is NOT on this list, unlike routes/messages.js. Cloud Vision SafeSearch
// screens an animated image by its FIRST FRAME, so an animated GIF is a way to
// show a moderator a photo of a sandwich and everyone else something else. That
// is not a complete fix — APNG ships as image/png and WebP animates too, and
// the real answer is re-encoding an upload to one static frame before screening
// it — but GIF is the format anyone reaching for this would actually use, and
// nobody posts a story from their camera roll as a GIF.
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// ---------------------------------------------------------------------------
// Retention — actually deleting expired stories
// ---------------------------------------------------------------------------
// Expiry has always been enforced on the READ path (`expires_at > NOW()`), so
// an expired story stops being visible to anyone whether or not this runs. But
// "stories last 24 hours" has to mean the row is gone, not merely skipped, or
// the promise is one `SELECT *` away from being false — on photos posted by
// minors, held forever.
//
// Rules this purge obeys:
//   * BOUNDED     — at most PURGE_BATCH rows per run, oldest first.
//   * IDEMPOTENT  — deleting nothing is a normal outcome, not an error.
//   * NEVER LIVE  — two independent predicates (`expires_at <= NOW()` and the
//                   grace window) must BOTH hold, and the grace value is
//                   clamped non-negative, so no configuration can point this at
//                   a story that is still on someone's feed.
//   * EVIDENCE    — a story with an open or under-review report is left alone.
//                   Deleting it would erase the only copy of the content a
//                   moderator is being asked to judge.
const PURGE_BATCH = 500;
const MAX_PURGE_GRACE_HOURS = 30 * 24;
const PURGE_GRACE_HOURS = (() => {
  const raw = parseInt(process.env.STORY_RETENTION_GRACE_HOURS, 10);
  if (!Number.isInteger(raw)) return 24;
  // Clamped at BOTH ends. A negative value would aim the delete at live
  // stories; an enormous one would quietly switch retention off and leave the
  // privacy promise resting on a variable nobody remembers setting.
  return Math.min(Math.max(raw, 0), MAX_PURGE_GRACE_HOURS);
})();

async function purgeExpiredStories(batch = PURGE_BATCH) {
  const result = await pool.query(
    `DELETE FROM stories
      WHERE id IN (
        SELECT s.id FROM stories s
         WHERE s.expires_at <= NOW()
           AND s.expires_at <= NOW() - ($1::int * INTERVAL '1 hour')
           AND NOT EXISTS (
             SELECT 1 FROM content_reports r
              WHERE r.content_type = 'story'
                AND r.content_id = s.id
                AND r.status IN ('open', 'under_review')
           )
         ORDER BY s.expires_at
         LIMIT $2::int
         FOR UPDATE SKIP LOCKED
      )`,
    [PURGE_GRACE_HOURS, batch]
  );
  return result.rowCount || 0;
}

// There is no scheduler in this app (routes/users.js says the same about ban
// tombstones), so the purge hangs off the one thing that reliably happens to
// stories: somebody reading the feed. Fire-and-forget, at most once an hour per
// process, so it can never add latency to a read or turn a cleanup failure into
// a failed request.
//
// The clock starts at module load rather than at zero: the first purge waits a
// full interval after boot, so a crash loop or a rapid series of redeploys
// cannot re-run the delete on every restart, and a short-lived process (a test,
// a one-shot script) never runs it at all.
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurgeAt = Date.now();

function maybePurgeStories(now = Date.now()) {
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return false;
  lastPurgeAt = now;
  purgeExpiredStories().catch((err) => {
    console.error('[stories] retention purge failed:', err.message);
  });
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/stories — live stories from friends and flock mates only
// ---------------------------------------------------------------------------
router.get('/',
  [
    query('limit').optional().isInt({ min: 1, max: MAX_FEED_LIMIT }),
    // The upper bound is not decoration. `isInt({ min: 0 })` accepts
    // "99999999999999999999", which parseInt turns into 1e20 and node-postgres
    // sends as a literal Postgres refuses as out of range for bigint — a 500 on
    // a request that is plainly the client's fault.
    query('offset').optional().isInt({ min: 0, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const limit = parseInt(req.query.limit, 10) || DEFAULT_FEED_LIMIT;
      const offset = parseInt(req.query.offset, 10) || 0;

      // Only return stories from: the user themselves, accepted friends, or accepted flock mates
      const result = await pool.query(
        `SELECT s.id, s.user_id, s.image_url, s.caption, s.created_at, s.expires_at,
                u.name AS user_name, u.profile_image_url
         FROM stories s
         JOIN users u ON u.id = s.user_id
         WHERE s.expires_at > NOW()
           -- Admin takedowns (is_hidden) and blocks must hold here, not just
           -- in messaging: shared-flock membership survives a block, so the
           -- friendship/flock grants below would otherwise keep leaking
           -- stories across a block in both directions.
           AND s.is_hidden IS NOT TRUE
           -- A ban is the strongest action a moderator has, and it left the
           -- banned account's stories on their friends' feeds for up to 24
           -- more hours: middleware/auth.js locks the banned USER out, nothing
           -- retracted what they had already posted. Suspending someone has to
           -- take their content down with them.
           AND u.is_banned IS NOT TRUE
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = s.user_id)
                OR (b.blocker_id = s.user_id AND b.blocked_id = $1)
           )
           AND (
             s.user_id = $1
             OR s.user_id IN (
               SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END
               FROM friendships WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
             )
             OR s.user_id IN (
               SELECT fm2.user_id FROM flock_members fm1
               JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != $1 AND fm2.status = 'accepted'
               WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
             )
           )
         ORDER BY s.created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      );

      // Group stories by user, newest poster first.
      //
      // This was a plain object keyed by user_id, and that quietly threw away
      // the ordering the query above works to produce: integer-like keys are
      // enumerated in ASCENDING NUMERIC order by every JS engine, never in
      // insertion order, so `Object.values` handed back the groups sorted by
      // account id. The oldest accounts sat permanently at the top of everyone's
      // feed and a story posted a minute ago appeared below one from yesterday.
      // A Map preserves insertion order, which here is `created_at DESC`.
      const byUser = new Map();
      for (const row of result.rows) {
        if (!byUser.has(row.user_id)) {
          byUser.set(row.user_id, {
            user_id: row.user_id,
            user_name: row.user_name,
            profile_image_url: row.profile_image_url,
            stories: [],
          });
        }
        byUser.get(row.user_id).stories.push({
          id: row.id,
          image_url: row.image_url,
          caption: row.caption,
          created_at: row.created_at,
          expires_at: row.expires_at,
        });
      }

      res.json({ story_groups: [...byUser.values()] });

      // Retention, after the response and never able to affect it.
      maybePurgeStories();
    } catch (err) {
      console.error('Stories fetch error:', err);
      // The purge above runs after the response is on the wire. If anything
      // there ever throws synchronously, the feed has already been served and
      // writing a second time would be an ERR_HTTP_HEADERS_SENT crash on a
      // request that actually succeeded.
      if (res.headersSent) return;
      res.status(500).json({ error: 'Failed to fetch stories' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/stories — post a story
// ---------------------------------------------------------------------------
router.post('/',
  [
    body('image_url')
      .isString().withMessage('A photo is required')
      .bail()
      .matches(IMAGE_DATA_URL).withMessage('That photo could not be posted. Stories take JPEG, PNG or WebP images.'),
    // Round 19 (shape sweep): `caption: ["<b>x</b>"]` was left alone by both
    // stripHtml and moderation.rejectIfProfane (each returns a non-string
    // unchanged), satisfied the length rule by coercion, and was written through
    // the explicit `$3::text` cast as the array literal — so an unscreened
    // caption went onto every friend's feed. image_url above is safe already:
    // .isString() is itself a shape check and rejects an array outright.
    freeText(body('caption').optional({ checkFalsy: true }), 'caption')
      .isLength({ max: MAX_CAPTION_LENGTH })
      .withMessage(`Captions are limited to ${MAX_CAPTION_LENGTH} characters`),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { image_url } = req.body;
      const caption = req.body.caption || null;

      // Length is checked against the ENCODED string because that is what gets
      // stored and re-sent on every feed read.
      if (Buffer.byteLength(image_url, 'utf8') > MAX_IMAGE_DATA_URL_BYTES) {
        return res.status(400).json({
          error: 'That photo is too large to post. Please pick a smaller one (under about 500 KB).',
        });
      }

      // Text screen (Apple 1.2) before anything is stored.
      if (moderation.rejectIfProfane(res, caption)) return;

      // Cheap flood check first, so a script cannot burn the Cloud Vision quota
      // (and the bill) on images it was never going to be allowed to post. The
      // authoritative check is the guarded INSERT below; this one only spares
      // the expensive call.
      const recent = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS last_hour,
           COUNT(*) FILTER (WHERE expires_at > NOW())::int AS active
         FROM stories WHERE user_id = $1`,
        [req.user.id]
      );
      if (recent.rows[0].last_hour >= STORIES_PER_HOUR || recent.rows[0].active >= MAX_ACTIVE_STORIES) {
        return res.status(429).json({ error: "You've posted a lot of stories recently. Try again in a little while." });
      }

      // Image screen — FAIL CLOSED. moderateImage already answers a provider
      // error with `allowed: false`; the try/catch is here so that a throw it
      // did not anticipate (a module that failed to load, an out-of-memory on a
      // large buffer) also lands on "not allowed" rather than on the outer
      // catch, where it would be indistinguishable from a database fault. On a
      // teen app with photo UGC there is no failure mode that stores the image.
      let verdict;
      try {
        verdict = await moderation.moderateImage(image_url);
      } catch (modErr) {
        console.error('🛡️ Story image moderation threw, rejecting (fail-closed):', modErr.message);
        verdict = { allowed: false, reason: 'moderation_error' };
      }
      if (!verdict || !verdict.allowed) {
        return res.status(400).json({
          error: moderation.IMAGE_REJECTED_MESSAGE,
          moderation: verdict ? verdict.reason : 'moderation_error',
        });
      }

      // The rate limit lives in the INSERT itself so two requests racing each
      // other cannot both read "4 in the last hour" and both write. A story
      // hidden by a moderator still counts against the active cap: a takedown
      // must not hand the poster a free slot.
      //
      // The parameters carry explicit casts because this is INSERT ... SELECT,
      // not INSERT ... VALUES: a bare `$1` in a SELECT target list resolves to
      // text, and text -> integer is an EXPLICIT cast in Postgres, so the
      // untyped form can fail at parse time on the user_id column. The casts
      // make the types the route's own statement, not something inferred.
      //
      // The response deliberately does not echo image_url back. It is the same
      // ~700KB data URL the client just uploaded, and returning it doubles the
      // cost of posting a story on a phone connection for no information.
      const result = await pool.query(
        `INSERT INTO stories (user_id, image_url, caption, expires_at)
         SELECT $1::int, $2::text, $3::text, NOW() + INTERVAL '24 hours'
          WHERE (SELECT COUNT(*) FROM stories
                  WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour') < $4::int
            AND (SELECT COUNT(*) FROM stories
                  WHERE user_id = $1 AND expires_at > NOW()) < $5::int
         RETURNING id, user_id, caption, created_at, expires_at`,
        [req.user.id, image_url, caption, STORIES_PER_HOUR, MAX_ACTIVE_STORIES]
      );

      if (result.rows.length === 0) {
        return res.status(429).json({ error: "You've posted a lot of stories recently. Try again in a little while." });
      }

      res.status(201).json({ story: result.rows[0] });
    } catch (err) {
      console.error('Create story error:', err);
      res.status(500).json({ error: 'Failed to post story' });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/stories/:id — remove your own story
// ---------------------------------------------------------------------------
// Author-only, and a story belonging to somebody else answers exactly like one
// that does not exist: a distinct 403 would confirm the id is real, which is
// all an id-walker needs.
router.delete('/:id',
  [param('id').isInt({ min: 1, max: INT4_MAX })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid story id' });
      }
      const storyId = parseInt(req.params.id, 10);

      // A story someone has reported, while that report is still unhandled, is
      // the evidence a moderator has been asked to look at — and its author is
      // the person with the strongest reason to make it vanish. So the row
      // survives an open report, and the retention purge above removes it for
      // real once the report is closed and the grace window passes.
      //
      // The report check is a predicate INSIDE the delete rather than a
      // separate SELECT before it. Read first, delete second and there is a
      // window — small, but exactly the window a reported user is racing for —
      // in which the report lands after the check and the evidence is destroyed
      // anyway.
      const deleted = await pool.query(
        `DELETE FROM stories
          WHERE id = $1 AND user_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM content_reports r
               WHERE r.content_type = 'story' AND r.content_id = $1
                 AND r.status IN ('open', 'under_review')
            )
          RETURNING id`,
        [storyId, req.user.id]
      );
      if (deleted.rows.length > 0) {
        return res.json({ message: 'Story removed' });
      }

      // The delete matched nothing, which means one of: no such story, not the
      // caller's, or the evidence guard held. Only the last of those is still
      // actionable, and for the author it must look exactly like a delete: the
      // story comes off every feed immediately, because expiry is the predicate
      // every read path in the product applies. Nothing can see it afterwards.
      const retired = await pool.query(
        `UPDATE stories
            SET expires_at = CASE WHEN expires_at > NOW() THEN NOW() ELSE expires_at END
          WHERE id = $1 AND user_id = $2
          RETURNING id`,
        [storyId, req.user.id]
      );
      if (retired.rows.length === 0) {
        return res.status(404).json({ error: 'Story not found' });
      }

      res.json({ message: 'Story removed' });
    } catch (err) {
      console.error('Delete story error:', err);
      res.status(500).json({ error: 'Failed to remove story' });
    }
  }
);

module.exports = router;
// Exposed for __tests__/storiesFlow.test.js. A property on the router changes
// nothing about the mount in server.js (same pattern as routes/moderation.js).
module.exports.__test = {
  purgeExpiredStories,
  maybePurgeStories,
  setLastPurgeAt: (t) => { lastPurgeAt = t; },
  PURGE_BATCH,
  PURGE_GRACE_HOURS,
  PURGE_INTERVAL_MS,
  STORIES_PER_HOUR,
  MAX_ACTIVE_STORIES,
  MAX_FEED_LIMIT,
  DEFAULT_FEED_LIMIT,
  MAX_CAPTION_LENGTH,
  MAX_IMAGE_DATA_URL_BYTES,
  IMAGE_DATA_URL,
};
