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
const { freeText, scalarOnly } = require('../validators/shape');
// The story visibility predicate. See the GET handler for why it is not written
// out here, and utils/relationships.js for what each argument decides.
const { storyVisibilitySql } = require('../utils/relationships');
// Called through the module object rather than destructured on purpose. The
// fail-closed image screen is the single most important line in this file and a
// destructured binding is frozen at require time, which leaves no way for
// __tests__/storiesFlow.test.js to prove BOTH that a refusal blocks the INSERT
// and that an approval lets it through. Keep the `moderation.` prefix.
const moderation = require('../utils/moderation');
// The stored data: URL's MIME is re-typed from the sniffed bytes before the
// INSERT — the declared prefix is a client claim, and the format regex below
// only ever reads that claim. The same call also removes the EXIF/XMP/IPTC
// blocks, which on a phone photo carry a GPS fix. One byte-typer and one
// stripper, defined in sockets/handlers.js and shared with both chat
// transports; never re-implement either here.
const { sanitizeStoredImage } = require('../sockets/handlers');
const { waitPhrase, refusalBody } = require('../utils/retryAfter');

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

// The refusal is DERIVED from the ceiling, and the conversion between them is
// written down rather than done in someone's head.
//
// This sentence was reported as a straight contradiction — it said "under about
// 500 KB" while the line below enforced 700 KB — and it is worth recording that
// it was NOT one, because the obvious fix is actively harmful. The two numbers
// are in different units. The ceiling is on the base64 DATA URL, and base64
// inflates by 4/3; the user picks a PHOTO. Quote 700 to them and a person with
// a 700 KB photo does exactly what they were told, encodes to ~933 KB, and is
// refused a second time by the same message. routes/users.js runs the identical
// convention for avatars (600 KB enforced, "about 400 KB" advertised).
//
// What WAS wrong is that the conversion lived nowhere: two literals, no
// arithmetic between them, so neither a reader nor the next person to move the
// ceiling could tell whether they agreed. Now the advertised number is computed
// from the enforced one and rounded DOWN to a round number, so the conversion
// keeps slack, and __tests__/imageRouteParity.test.js pins the property that
// actually matters — a photo of exactly the advertised size encodes to a data
// URL that fits under the enforced ceiling.
//
// The `data:image/...;base64,` prefix comes off BEFORE the conversion, and it is
// not a rounding nicety. It changes nothing here (700 KB gives 500 either way),
// but the same derivation without it hands routes/users.js a 450 KB answer for
// its 600 KB ceiling — and 450 KB of photo encodes to exactly 614,400 bytes,
// which IS that ceiling, so the prefix alone would put a photo of precisely the
// advertised size over it. Rounding down to a round number only keeps slack
// when there was slack to start with; taking the prefix off first is what
// guarantees it. The two files run the same arithmetic for that reason.
const DATA_URL_PREFIX_BYTES = 'data:image/jpeg;base64,'.length; // the longest we accept
const ADVERTISED_PHOTO_KB =
  Math.floor(Math.floor((MAX_IMAGE_DATA_URL_BYTES - DATA_URL_PREFIX_BYTES) / 4) * 3 / 1024 / 50) * 50;
const IMAGE_TOO_LARGE_MESSAGE =
  `That photo is too large to post. Please pick a smaller one (under about ${ADVERTISED_PHOTO_KB} KB).`;

// Flood control. Five posts an hour and ten live at once is far above what a
// real person does with a 24-hour format and far below what it takes to push
// everyone else out of a friend's feed. Enforced in SQL, not in a Map: an
// in-memory counter resets on every deploy and does not exist on the other
// instance.
const STORIES_PER_HOUR = 5;
const MAX_ACTIVE_STORIES = 10;

// ---------------------------------------------------------------------------
// TWO DIFFERENT CEILINGS SHARED ONE SENTENCE, AND ONE OF THEM WAS NOT A RATE.
//
// "You've posted a lot of stories recently. Try again in a little while." was
// the answer to both. STORIES_PER_HOUR is a rate and frees a slot an hour after
// the post that filled it. MAX_ACTIVE_STORIES is a CAPACITY on how many of your
// stories are live at once, and it frees a slot only when a story EXPIRES,
// which with a 24-hour format is most of a day away. Somebody holding ten live
// stories who is told "a little while" comes back all evening to the same
// refusal, having been told the wrong thing about a limit they could have
// cleared instantly by deleting one.
//
// So: name which one, say when, and on the capacity one say the thing the
// person can actually do about it.
// ---------------------------------------------------------------------------
// The counts AND the two instants, in one statement, used by both refusal
// sites so they cannot drift apart.
//
// The hourly leg is done with an OFFSET rather than a MIN. MIN is only correct
// when the count sits exactly on the ceiling; the guarded INSERT below can lose
// a race by one under READ COMMITTED, and in that case MIN + 1 hour is a slot
// short and sends the person back to the same refusal. The offset is how many
// posts have to age out before there is room.
//
// BOTH INSTANTS ARE CAST TO timestamptz, AND THAT CAST IS THE WHOLE ANSWER TO
// A REFUSAL THAT NAMED THE WRONG TIME.
//
// stories.created_at and stories.expires_at are `TIMESTAMP`, timestamp WITHOUT
// time zone (migrations/000_bootstrap.sql). node-postgres parses that type by
// building a Date out of the LOCAL calendar fields, because a naive timestamp
// carries no offset for it to honour. So `new Date(row.hour_frees_at)` in
// storyLimitRefusal below was not reading the instant the database meant: it
// was reading those digits as the app process's wall clock. Measured with the
// driver's own parser, `2026-08-26 14:00:00` comes back as 18:00Z under
// TZ=America/New_York.
//
// Every consequence lands on the user. `waitPhrase` turns a four-hour error
// into "in about 4 hours" on a limit that lifts in a minute, `Retry-After`
// carries 14400 seconds, and `resetsAt` is an instant that has not happened.
// That is exactly the defect utils/retryAfter.js was written to end, a refusal
// that names a window the caller can follow and still be refused, arriving
// through the timestamp parser instead of through bad arithmetic.
//
// Production runs UTC today, where local and UTC coincide and the bug is
// invisible; a laptop, a container with TZ set, or a region change is all it
// takes. The cast makes the question moot rather than leaving it resting on an
// environment variable: Postgres renders a timestamptz with an offset, the
// driver parses the offset, and no local calendar is consulted anywhere. The
// naive column and the cast agree on the instant by construction, because both
// are read back through the same session TimeZone that NOW() wrote them under.
//
// Do not "simplify" either cast away. __tests__/storiesEndToEnd.test.js fails
// if a bare timestamp reaches the driver on either leg.
const STORY_LIMIT_STATE_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS last_hour,
    COUNT(*) FILTER (WHERE expires_at > NOW())::int AS active,
    ((SELECT created_at FROM stories
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY created_at ASC
       OFFSET GREATEST(
         (SELECT COUNT(*)::int FROM stories
           WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour') - $2::int, 0)
       LIMIT 1) + INTERVAL '1 hour')::timestamptz AS hour_frees_at,
    -- A different clock entirely: this leg frees when the earliest LIVE story
    -- expires, which with a 24-hour format can be most of a day away.
    (SELECT MIN(expires_at) FROM stories
      WHERE user_id = $1 AND expires_at > NOW())::timestamptz AS active_frees_at
  FROM stories WHERE user_id = $1`;

function storyLimitRefusal(res, row, overHour, overActive) {
  const at = (value) => (value ? new Date(value).getTime() - Date.now() : 0);
  // When both hold, the wait is the later of the two: clearing one leaves the
  // other still refusing.
  if (overActive && overHour) {
    const ms = Math.max(at(row.active_frees_at), at(row.hour_frees_at));
    return refusalBody(res, ms,
      `You have ${MAX_ACTIVE_STORIES} stories live and you have posted ${STORIES_PER_HOUR} in the last hour. The next slot opens ${waitPhrase(ms)}, or delete one to post now.`);
  }
  if (overActive) {
    const ms = at(row.active_frees_at);
    return refusalBody(res, ms,
      `You have ${MAX_ACTIVE_STORIES} stories live, which is the most at once. The oldest expires ${waitPhrase(ms)}, or delete one to post now.`);
  }
  const ms = at(row.hour_frees_at);
  return refusalBody(res, ms,
    `You have posted ${STORIES_PER_HOUR} stories in the last hour, which is the most per hour. You can post again ${waitPhrase(ms)}.`);
}

// Strict, whole-string: prefix-only matching (`/^data:image\/png;base64,/`)
// accepts arbitrary trailing junk after the payload, which is a place to park
// markup that some future consumer renders.
//
// THIS IS A FORMAT ALLOWLIST. IT IS NOT THE ANIMATION GATE, and it must not be
// read as one — a client-declared MIME type cannot see frames. An APNG is
// served as `image/png` and an animated WebP as `image/webp`, so both satisfy
// this regex; leaving GIF off it stops the one format people reach for on
// purpose and closes nothing else. This comment used to claim the omission WAS
// the anti-animation defence, which is the dangerous kind of wrong: it reads
// like a control is in place here, so the next person to widen the list has no
// reason to look for the real one.
//
// The real gate is byte-level and lives in utils/moderation.js
// (inspectImageFrames, called by moderateImage before the provider is ever
// contacted). It reads magic numbers and walks the length-prefixed chunk
// structures of the PNG, RIFF, GIF, ISO base media, ICO and TIFF families, and
// refuses anything it can PROVE holds more than one frame — on every upload
// path in the app at once. Do not restate its rules here or anywhere else:
// __tests__/animatedImageModeration.test.js fails any caller that starts
// deciding animation for itself, because two copies of that logic would drift
// and only one of them would be the one actually protecting users. POST below
// goes through the shared screen: moderateImage() runs on every story,
// fail-closed, before the INSERT.
//
// GIF stays off this list anyway. Removing it was argued on its own merits and
// declined, and the accounting is worth writing down because the obvious
// version of the argument is wrong in both directions:
//
//   * Dropping the format does NOT weaken the animation defence. An animated
//     GIF that reached moderateImage would be refused by the byte-level gate,
//     and refused for FREE — that gate runs before the provider is contacted,
//     so it never costs a Vision call either way.
//   * What the omission actually buys is the STILL GIF. That one is a real
//     image, so it would go all the way to the provider and cost a billed call
//     to reach the answer "yes, that is a photo of something" — for a format
//     nobody's camera roll produces. Refusing it from the MIME string costs
//     nothing at all.
//
// So it stays: same answer, no invoice. __tests__/storiesFlow.test.js pins that
// a GIF story costs zero moderation calls, and that the rule is about the
// FORMAT, not about frames — a still GIF is refused here too.
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
//                   moderator is being asked to judge. Known limit: once that
//                   report is resolved or dismissed, the row purges after the
//                   grace window like any other — so the ONE-YEAR preservation
//                   that 18 U.S.C. § 2258A(h) attaches to content behind a
//                   CyberTipline report cannot rest on this table (nor can it
//                   survive the author deleting their account, which cascades
//                   this row away regardless of report status). The control
//                   that satisfies § 2258A(h) is MODERATION-LEGAL.md step 2:
//                   export the evidence out of the database BEFORE resolving
//                   the report or touching the account.
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

// WHAT TRIGGERS IT, AND WHY THAT LIST CHANGED.
//
// This used to hang off ONE thing: somebody reading the feed. The reasoning was
// "there is no scheduler in this app (routes/users.js says the same about ban
// tombstones), so the purge hangs off the one thing that reliably happens to
// stories". Both halves of that sentence are now false, and together they left
// the deletion promise unenforceable in production:
//
//   * READING THE FEED IS NOT A THING THAT HAPPENS. The product decision of
//     2026-08-14 is that stories never get a UI, and it held: `getStories` in
//     frontend/src/services/api.js has zero callers, App.js holds no story
//     state, no story screen and no call to it, and routes/admin.js's takedown
//     map cites that absence as the reason a story takedown tells nobody. So
//     GET /api/stories is a door the launch client never opens, which made this
//     purge unreachable code on every deployed instance. POST is not:
//     routes/users.js's data export says it outright ("No UI can create a story
//     (server-only by decision), but the API can"), and server.js's
//     KEEP_DEMO_STORIES refresh writes to this table directly. Rows can exist.
//     Nothing was ever going to remove them.
//
//     That is the whole privacy promise inverted. "Stories last 24 hours" was
//     true of the VIEW, because every read path filters expires_at in SQL, and
//     false of the ROW, which is the case the comment above this one says must
//     not happen: photos, posted by minors, held forever, a `SELECT *` away.
//
//   * THERE IS A SCHEDULER. backend/server.js starts six interval sweeps at
//     boot with staggered kickoffs (two of them env-gated), one of which,
//     prunePhotoStore, is hourly and the same shape as this: expire cached
//     bytes because keeping them is not allowed. That one exists for a Google
//     TERMS obligation. This one is the privacy obligation, and it is the one
//     that never got a sweep. Recount them before quoting the number.
//
// So the purge now hangs off every door that TOUCHES a story, not just the one
// that reads them: the feed, a successful post, and a delete. POST is the only
// door in this router that creates a row, so the path that fills the table is
// now also a path that drains it, and a process serving one story write cleans
// up after every story write that came before it, including the seeded ones.
//
// THIS IS STILL NOT A SCHEDULER, and the difference is worth stating rather
// than leaving for someone to discover: a table full of expired stories in a
// process nobody posts to stays full. The durable fix is one more sweep in
// server.js next to prunePhotoStore, hourly, calling purgeExpiredStories.
// server.js was outside this change's lane; the handoff says so.
//
// Fire-and-forget, at most once an hour per process, so it can never add
// latency to a request or turn a cleanup failure into a failed one.
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
    // `checkFalsy`, not the bare `.optional()`. `.optional()` skips only
    // `undefined`, and `?limit=&offset=` is what a client that builds its query
    // string out of possibly-unset state actually sends — the empty string is
    // present, so the rule ran and the whole feed was a 400. A parameter the
    // caller did not set is a parameter the caller did not set.
    //
    // `'0'` is a non-empty string and therefore still checked, so `?limit=0` is
    // refused as the out-of-range value it is rather than silently defaulting.
    //
    // And both carry a message. Without one the user is shown express-
    // validator's default, "Invalid value", as the whole explanation of why
    // their feed did not load.
    // scalarOnly, because `?limit=30&limit=50` makes req.query.limit an array
    // and express-validator runs isInt on each ELEMENT — both pass, the value
    // stays an array, and `parseInt(['30','50'], 10)` quietly answers 30. The
    // consequence here is only a silently-ignored second value rather than a
    // 500, but the rule is the rule: settle the shape before anything reads it.
    scalarOnly(query('limit').optional({ checkFalsy: true }), 'limit')
      .isInt({ min: 1, max: MAX_FEED_LIMIT })
      .withMessage(`Ask for between 1 and ${MAX_FEED_LIMIT} stories at a time`),
    // The upper bound is not decoration. `isInt({ min: 0 })` accepts
    // "99999999999999999999", which parseInt turns into 1e20 and node-postgres
    // sends as a literal Postgres refuses as out of range for bigint — a 500 on
    // a request that is plainly the client's fault.
    scalarOnly(query('offset').optional({ checkFalsy: true }), 'offset')
      .isInt({ min: 0, max: INT4_MAX })
      .withMessage('That page of stories does not exist'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const limit = parseInt(req.query.limit, 10) || DEFAULT_FEED_LIMIT;
      const offset = parseInt(req.query.offset, 10) || 0;

      // "Can this account see that story?" — ONE definition, in
      // utils/relationships.js, shared with the report gate in
      // routes/moderation.js. This route used to carry its own copy, and the
      // copies had already drifted: the report gate had lost the see-your-own-
      // post clause, so reporting your OWN story answered "content could not be
      // found". With two blocks of literal SQL there was no way to tell which
      // differences were deliberate, which is why the differences are named
      // arguments now.
      //
      // The feed's settings, and why they are the feed's:
      //   * excludeHidden (default) — a takedown has to hold here.
      //   * excludeBannedAuthor (default) — a ban must retract what the account
      //     already posted; middleware/auth.js only locks the USER out, which
      //     left their stories on friends' feeds for up to 24 more hours.
      //   * authorAlias: 'u' — this SELECT already joins users for the name and
      //     avatar, so the ban check is a column read rather than a second
      //     EXISTS. Passing an alias this query does not declare would be a
      //     syntax error, which is why the helper validates it as a bare
      //     identifier and refuses anything else.
      // Blocks (both directions) and the own/friend/flock-mate grants come with
      // it. Nothing is interpolated from the request: `$1` is a bind
      // placeholder the helper checks the shape of, and the viewer's id travels
      // as a parameter exactly as before.
      const result = await pool.query(
        `SELECT s.id, s.user_id, s.image_url, s.caption, s.created_at, s.expires_at,
                u.name AS user_name, u.profile_image_url
         FROM stories s
         JOIN users u ON u.id = s.user_id
         WHERE ${storyVisibilitySql({ viewer: '$1', authorAlias: 'u' })}
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

      // A story is other people's photograph, it is inline base64 in this
      // response rather than a URL, and the whole format is a promise that it
      // stops existing in a day. A cached copy breaks all three at once.
      //
      // routes/admin.js already sets exactly this on GET /reports/:id/image,
      // which serves THE SAME BYTES to one moderator. The feed hands them to
      // everyone the author is friends with, and did not. The launch client is
      // a Capacitor web view, so "the cache" is NSURLCache writing an
      // authenticated JSON body into the app container, where it outlives the
      // expiry the feed itself enforces in SQL.
      res.set('Cache-Control', 'no-store, private');
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
        return res.status(400).json({ error: IMAGE_TOO_LARGE_MESSAGE });
      }

      // Text screen (Apple 1.2) before anything is stored.
      if (moderation.rejectIfProfane(res, caption)) return;

      // Cheap flood check first, so a script cannot burn the Cloud Vision quota
      // (and the bill) on images it was never going to be allowed to post. The
      // authoritative check is the guarded INSERT below; this one only spares
      // the expensive call.
      // Same two counts this check has always made, plus the two instants the
      // refusal needs, in the same round trip.
      const recent = await pool.query(STORY_LIMIT_STATE_SQL, [req.user.id, STORIES_PER_HOUR]);
      const overHour = recent.rows[0].last_hour >= STORIES_PER_HOUR;
      const overActive = recent.rows[0].active >= MAX_ACTIVE_STORIES;
      if (overHour || overActive) {
        return res.status(429).json(storyLimitRefusal(res, recent.rows[0], overHour, overActive));
      }

      // Image screen — FAIL CLOSED. moderateImage already answers a provider
      // error with `allowed: false`; the try/catch is here so that a throw it
      // did not anticipate (a module that failed to load, an out-of-memory on a
      // large buffer) also lands on "not allowed" rather than on the outer
      // catch, where it would be indistinguishable from a database fault. On a
      // teen app with photo UGC there is no failure mode that stores the image.
      let verdict;
      try {
        verdict = await moderation.moderateImage(image_url, { userId: req.user.id });
      } catch (modErr) {
        console.error('🛡️ Story image moderation threw, rejecting (fail-closed):', modErr.message);
        verdict = { allowed: false, reason: 'moderation_error' };
      }
      if (!verdict || !verdict.allowed) {
        // imageRejectionMessage(), never IMAGE_REJECTED_MESSAGE directly. The
        // two refusals this screen can produce are not the same event: an
        // ANIMATED image is refused by policy (SafeSearch only ever sees frame
        // 1), and telling that user their photo "couldn't be verified as safe"
        // is both wrong and unactionable — there is nothing they can do to a
        // sunset GIF to make it verify. They need "try a still photo instead".
        // The messages.js call sites and both socket send paths already route
        // through this helper; this was the last one that did not, which also
        // means a reason added to moderateImage() in future arrives here with a
        // message that fits it rather than one that misdescribes it.
        return res.status(400).json({
          error: moderation.imageRejectionMessage(verdict),
          moderation: verdict ? verdict.reason : 'moderation_error',
        });
      }

      // The rate limit lives in the INSERT itself, so the gap between the cheap
      // pre-check above and this write cannot be walked through: by the time
      // the count is taken, the row is going in on the same statement. A story
      // hidden by a moderator still counts against the active cap: a takedown
      // must not hand the poster a free slot.
      //
      // WHAT THIS DOES NOT DO, corrected during the §O sweep. This comment used
      // to claim that "two requests racing each other cannot both read 4 in the
      // last hour and both write", and that is not true of an INSERT ... SELECT
      // under READ COMMITTED. Two concurrent statements each take their own
      // snapshot, neither sees the other's uncommitted row, both count 4 and
      // both insert. N simultaneous posts can overshoot by up to N-1.
      //
      // That is a real gap and it is left open on purpose, written down rather
      // than quietly fixed the wrong way: closing it properly means serialising
      // every post through a per-user lock, and 5/hour is a courtesy cap on a
      // 24-hour format, not a safety control. The two things this looks like it
      // is protecting are protected elsewhere and not by this count — the
      // moderation screen runs on every image whatever the count says, and the
      // Cloud Vision spend is bounded by its own budget (see
      // __tests__/imageSpendLimits.test.js), which is what the cheap pre-check
      // above is really for. A claim that a race is handled is worse than no
      // claim, because the next person to add a hard limit here will copy this
      // shape and believe it.
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
        [req.user.id,
          // Re-typed from the sniffed bytes and stripped of metadata
          // (sanitizeStoredImage): the stored payload is the screened one with
          // its EXIF, XMP and IPTC segments removed. Stripping only ever takes
          // bytes away, never adds pixels, so nothing can hide behind it.
          sanitizeStoredImage(image_url),
          caption, STORIES_PER_HOUR, MAX_ACTIVE_STORIES]
      );

      if (result.rows.length === 0) {
        // The guarded INSERT is the authoritative check and it answers with a
        // row count, not with a reason, so re-read which of the two ceilings
        // holds. Without this the race that only this statement can catch would
        // be the one case still told "in a little while".
        const state = await pool.query(STORY_LIMIT_STATE_SQL, [req.user.id, STORIES_PER_HOUR]);
        const row = state.rows[0] || {};
        return res.status(429).json(storyLimitRefusal(
          res, row, row.last_hour >= STORIES_PER_HOUR, row.active >= MAX_ACTIVE_STORIES
        ));
      }

      res.status(201).json({ story: result.rows[0] });

      // Retention, after the response and never able to affect it. This door is
      // the one that matters: a story row exists because a POST created it, so
      // the create path is the only trigger guaranteed to be running in a
      // process where there is anything to purge. See maybePurgeStories.
      maybePurgeStories();
    } catch (err) {
      console.error('Create story error:', err);
      // Same reason the feed guards this: the purge above runs after the
      // response is on the wire, and writing a second time would turn a request
      // that succeeded into an ERR_HTTP_HEADERS_SENT crash.
      if (res.headersSent) return;
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
        res.json({ message: 'Story removed' });
        maybePurgeStories();
        return;
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

      // The branch that most needs the purge to be real. Nothing was deleted
      // here: the row survived because a moderator has an open report on it,
      // and all the author got was an expiry brought forward. The bytes leave
      // only when this sweep runs, so the path that reports "Story removed"
      // without removing anything is the path that drives the sweep.
      maybePurgeStories();
    } catch (err) {
      console.error('Delete story error:', err);
      if (res.headersSent) return;
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
  ADVERTISED_PHOTO_KB,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_DATA_URL,
};
