const express = require('express');
// SECURITY-AUDIT-auth.md A5-1 (MEDIUM). This file was the half of the bcrypt
// swap that f9699d1 missed. routes/auth.js moved its login compare to the
// native library so the pure-JS key schedule stops running on the only thread;
// this file kept `bcryptjs` and kept running THREE compares and one hash on it
// — and one of those is repeatable at will, which the login compare is not.
//
// THE DOOR. PUT /api/users/profile clears the proof throttle on a CORRECT
// password (deliberately: a user who mistypes and then gets it right must not
// be held back), so a caller who owns an account and knows its password is
// never throttled by proofFailures and is bounded only by apiLimiter at
// 3000/15 min per IP, about 200/min. Measured by the audit: one `bcryptjs`
// compare is 43 ms and 8 concurrent compares are 341 ms of wall time with
// exactly ONE event-loop turn available inside it — 8.6 s of head-of-line
// blocking per minute per address. Seven addresses and one free account
// saturate the process. That is R4-A2's mechanism at an eighth of the address
// cost, because apiLimiter is 300x looser than authLimiter's 10/min.
//
// Hash parity across the swap is total in both directions and across the
// $2a/$2b/$2y/$2x prefixes, so no stored hash becomes unverifiable and
// `bcryptjs` stays in package.json as the rollback path (the seed scripts and
// most of the test suites still write their fixtures with it). Proven for THIS
// file's four call sites by __tests__/usersBcryptAndProofEviction.test.js
// rather than assumed to carry over from the auth suite.
//
// The concurrency ceiling this buys is UV_THREADPOOL_SIZE, which nothing here
// sets, so it is Node's default 4 — a queue on the libuv pool rather than a
// stall of the HTTP server. If authLimiter or apiLimiter is ever raised, that
// is the number to raise with it.
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { body, param, query, validationResult } = require('express-validator');
const multer = require('multer');
const { stripImageMetadata } = require('../utils/imageMetadata');
const path = require('path');
const pool = require('../config/database');
const { waitPhrase, refusalBody } = require('../utils/retryAfter');
const { isDisposableEmail } = require('../utils/disposableEmail');
const {
  authenticate,
  authenticateAllowBanned,
  signUserToken,
  revokeUserSessions,
  TOKEN_ALGORITHMS,
  UNVERIFIED_MESSAGE,
} = require('../middleware/auth');
// stripHtml is no longer imported here: the one chain that called it is now
// freeText(), which applies it (and the trailing trim it was missing).
const { sanitizeArray } = require('../utils/sanitize');
const { rejectIfProfane, moderateImage, imageRejectionMessage } = require('../utils/moderation');
const { revokeAppleToken, isConfigured: appleAuthConfigured } = require('../services/appleAuth');
// Shape before content — see validators/shape.js. PUT /profile settles its own
// shape in the handler with a STRICTER rule (string-or-absent, which also
// refuses a number reaching a text column), so it keeps that check; every other
// write in this file uses the shared predicate.
const { scalarOnly, freeText } = require('../validators/shape');
// The card route serves a fact about ANOTHER user, so it asks the block
// question the way every cross-user surface does — through the single source
// of truth, both directions at once.
const { isBlockedBetween, getInvisibleUserIds } = require('../utils/blocks');
// Deleting an account CASCADEs away every flock the account created, which is
// somebody else's plan for tonight. DELETE /api/flocks/:id has always told the
// members; this route never did. Same two helpers it uses, for the same reason
// its comments give: the members have to be captured before the delete and
// handed to the emit, and the people who are not in the app are exactly the
// ones who would otherwise turn up at the bar. See the fan-out in
// deleteAccount.
const { emitToFlockMembers } = require('../sockets/handlers');
const { pushIfOffline, isPushConfigured } = require('../services/pushHelper');
// "Has this plan already happened?" has one answer in this codebase and it is
// the sweep's. Importing its window rather than restating it is what stops the
// push gate and the completion sweep from drifting apart. See the read in
// deleteAccount.
const { graceHours: flockGraceHours } = require('../services/flockSweep');
// The card answers a question about SOMEBODY ELSE by bare sequential id, which
// is the exact shape utils/probeBudget.js was written for. See cardProbeBudget.
const { createUserBudget } = require('../utils/probeBudget');
// Contact discovery. `phoneDiscoveryHash` is the ONLY thing written into
// users.phone_hash, and it is an HMAC over a canonical E.164 string under a
// namespace of its own — deliberately a different namespace from the ban
// tombstone digests below, so neither table's rows can be compared with the
// other's. See utils/phone.js.
const { phoneDiscoveryHash } = require('../utils/phone');

const router = express.Router();
const SALT_ROUNDS = 10;

// users.id is SERIAL (INT4). Same ceiling, same reason as routes/flocks.js:
// an unbounded isInt() lets "9999999999" reach the query and come back a 500
// ("integer out of range") instead of a clean 400.
const INT4_MAX = 2147483647;

// DELETE /api/users/me is defined FIRST, with its own ban-tolerant auth, and is
// the only route in the app that runs without the ban check. See deleteAccount
// at the bottom of this file and the comment on makeAuthenticate in
// middleware/auth.js — this replaces a URL-regex carve-out that any DELETE
// request could satisfy with a crafted query string.
router.delete('/me', authenticateAllowBanned, deleteAccount);

router.use(authenticate);

// user_settings table lives in migrations/003 — route-owned DDL raced the
// migration runner on fresh deployments (see REVIEW-ROUND5).

// Magic bytes for image validation.
//
// Round 19: these were TRUNCATED signatures — four bytes of PNG's eight, and a
// bare `GIF8` rather than the two GIF versions that exist. That let this
// function and utils/moderation.js's inspectImageFrames disagree about what a
// file IS: bytes beginning `47 49 46 38 58 61` typed as a GIF here, were
// stamped `data:image/gif` and stored, and were an unrecognised container over
// there — which is the branch that does NOT look for extra frames. Two
// byte-typers in one repo that can reach different conclusions about the same
// bytes is a moderation bypass waiting for someone to find the seam. Full
// signatures, so both answer the same question the same way.
//
// This is format TYPING, not frame counting: how many frames a file holds is
// decided in exactly one place, inside moderateImage. Real uploads are
// unaffected — the only two GIF versions ever published are 87a and 89a.
const IMAGE_SIGNATURES = {
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  png:  [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  gif:  [
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),  // GIF, version 87a
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),  // GIF, version 89a
  ],
  // 'RIFF' alone is a container header, not an image one: WAV and AVI open the
  // same four bytes. The 'WEBP' form type at offset 8 is what makes it an image.
  webp: [Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF header
};

// Returns the format the BYTES say this is, or null. The name is the answer:
// callers must not re-derive a type from the filename or the upload's declared
// MIME, both of which the client writes.
function detectImageFormat(buf) {
  try {
    for (const [format, sigs] of Object.entries(IMAGE_SIGNATURES)) {
      for (const sig of sigs) {
        if (!buf.subarray(0, sig.length).equals(sig)) continue;
        if (format === 'webp' && buf.toString('latin1', 8, 12) !== 'WEBP') continue;
        return format;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const DETECTED_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Configure multer for profile image uploads.
//
// Round 12: this used multer.diskStorage into backend/uploads, and server.js
// served that directory statically. Railway's filesystem is EPHEMERAL and no
// volume is mounted, so every redeploy wiped the directory. The upload handler
// already converts to a base64 data URL and stores it in
// users.profile_image_url (the same way message images work), so the disk was
// only ever a temp staging area whose files could — and on a crash between
// write and unlink, did — survive as orphans until the next deploy erased
// them. Buffering in memory removes the ephemeral-filesystem dependency
// entirely: no volume to configure, nothing to leak, nothing to lose on
// redeploy. The 5 MB limit below bounds the buffer, and the stored data URL is
// separately capped at 600 KB further down.
// ---------------------------------------------------------------------------
// fileSize was the ONLY limit here, and fileSize bounds one part (round 26).
// ---------------------------------------------------------------------------
// multer's other ceilings default to Infinity: `fields`, `parts` and `files` are
// all unbounded unless they are named. `fileSize` therefore bounded the FILE at
// 5 MB and bounded the REQUEST at nothing at all: a single multipart body of
// ordinary text fields (`name=a&name=a&...`, no file part at all) is accumulated
// into `req.body` by multer's own field handler, one allocation per field, until
// the client stops sending. That is a gigabyte of heap on a Railway container
// with a few hundred megabytes of it, from one connection, and the billed-image
// limiter in server.js cannot help: it refuses REQUESTS, and this is one
// request. The dyno OOMs and every user is offline while it restarts.
//
// The numbers are what THIS endpoint actually uses, not generous ones. The
// client posts exactly one part named `image` and no text fields at all, so
// `files: 1` and `parts: 2` (the file, plus one spare) are already slack.
// `fieldSize` and `fieldNameSize` bound the parts that are not the file so a
// refusal happens on the first oversized one rather than after buffering it.
//
// A refused part aborts the read: multer stops consuming the stream and calls
// back with a MulterError, which the handler below turns into a 400. The bytes
// past the limit are never allocated, which is the property `fileSize` alone had
// only for the file part.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
    files: 1,
    parts: 2,
    fields: 1,
    fieldSize: 4 * 1024,
    fieldNameSize: 100,
    headerPairs: 100,
  },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, PNG, GIF, WebP) are allowed'));
    }
  },
});

// ---------------------------------------------------------------------------
// The avatar ceiling, and the number the user is told
// ---------------------------------------------------------------------------
// Cap the STORED data URL, not just the raw upload. Avatars are stored inline
// in users.profile_image_url and repeated on every message-history row and
// socket send, so a multi-MB base64 avatar amplifies into hundreds of MB of
// transfer (REVIEW-ROUND5). 600KB keeps that bounded.
const MAX_AVATAR_DATA_URL_BYTES = 600 * 1024;

// The two numbers in this pair are in DIFFERENT UNITS, and that is correct, not
// a bug: the ceiling above is on the base64 data URL, while the sentence below
// is about the photo the person picked off their camera roll. Quote them the
// enforced figure and someone with a 600 KB photo does exactly what they were
// told, encodes to ~800 KB, and is refused a second time by the same message.
// routes/stories.js runs the identical convention.
//
// What was wrong is that the conversion lived in someone's head: two literals,
// no arithmetic between them, so neither could be moved safely and neither a
// reader nor a test could tell whether they still agreed. It is written down
// now, and it is written down INCLUDING THE PREFIX, which is the part that
// bites here. Base64 is 4 bytes out for every 3 in, so the naive inverse of
// 600 KB is exactly 450 KB — and a 450 KB photo encodes to exactly 614,400
// bytes, which is the ceiling to the byte, so `data:image/jpeg;base64,` on the
// front pushes it over and the advertised number would be one a user cannot
// actually use. Taking the prefix off first, then rounding the photo size DOWN
// to a round number, leaves the slack the sentence promises.
const DATA_URL_PREFIX_BYTES = 'data:image/jpeg;base64,'.length; // the longest of the four
const advertisedPhotoKb = (ceilingBytes) =>
  Math.floor(Math.floor((ceilingBytes - DATA_URL_PREFIX_BYTES) / 4) * 3 / 1024 / 50) * 50;

const ADVERTISED_AVATAR_KB = advertisedPhotoKb(MAX_AVATAR_DATA_URL_BYTES);
const AVATAR_TOO_LARGE_MESSAGE =
  `That photo is too large to use as a profile picture. Please pick a smaller photo (under about ${ADVERTISED_AVATAR_KB} KB).`;

// GET /api/users/profile - Get current user's full profile
router.get('/profile', async (req, res) => {
  try {
    const result = await pool.query(
      // phone_discoverable is here because the client cannot render an honest
      // toggle for it otherwise, and a settings switch that does not show its
      // real state is worse than no switch. phone_hash is NOT here and must
      // never be: it is a matching key, the row's owner has no use for it, and
      // the fewer places it is copied to the better.
      `SELECT id, email, name, phone, phone_discoverable, interests, role, profile_image_url, bio, venmo_username, cashapp_cashtag, zelle_identifier, is_premium, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Include flock count
    const flockCount = await pool.query(
      "SELECT COUNT(*) FROM flock_members WHERE user_id = $1 AND status = 'accepted'",
      [req.user.id]
    );

    const profile = result.rows[0];
    profile.flock_count = parseInt(flockCount.rows[0].count);

    res.json({ user: profile });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// ---------------------------------------------------------------------------
// Directory-probe budget for the person card (audit round 3, I3-1)
//
// GET /:id/card answers "is there a user behind this id, and what are they
// called?" — the same question routes/friends.js already meters with
// friendProbeBudget, and it answers it with MORE than the friend probe leaked
// (name, avatar and the free-text bio). It shipped with no probe budget, so the
// only ceiling in front of it was the router-wide apiLimiter: 3,000 requests
// per 15 minutes PER IP, i.e. ~288,000 sequential ids a day, and rotating IPs
// multiplies that while the account stays the same.
//
// WHY 120/hour AND 400/day, and not friends.js's 20/60. Opening a person card
// is a far more frequent gesture than adding a friend: it is what a tap on a
// face resolves to, from a flock roster, a chat, a friends list and the past-
// flocks list. The largest single legitimate surface is a full roster
// (LINK_JOIN_MEMBER_CAP = 50 members), and a heavy session might open most of
// one plus a scroll through friends — call it ~100 cards. 120 an hour covers
// that burst with room to spare; 400 a day covers three or four such sessions
// back to back. It still cuts a directory walk from ~288,000 ids/day to 400
// (a ~720x reduction), and unlike the IP limiter a fresh lane costs a fresh
// account rather than a fresh proxy.
//
// A SEPARATE budget from friendProbeBudget, not a shared one: these are
// different gestures at very different rates, and folding the card's 400 into
// the friend probe's 60 would either starve the card or hand an enumerator a
// 400-wide lane into /request's push notifications.
//
// Viewing your OWN card is free — it is not a probe, it tells the caller
// nothing they did not already know, and the profile screen reads it.
// Deliberately NOT exempting friends/co-members the way friends.js exempts an
// existing friendship row: that exemption would cost a relationship query on
// every single card open, and at 400/day there is no legitimate session the
// unconditional charge can starve.
// ---------------------------------------------------------------------------
const cardProbeBudget = createUserBudget({ name: 'card-probe', hourly: 120, daily: 400 });

// ---------------------------------------------------------------------------
// THE SECOND DOOR INTO THE SAME DIRECTORY — audit round 4, R4-I1
// ---------------------------------------------------------------------------
// The budget above closed `GET /:id/card`. It did not close the CLASS, because
// `GET /search` answers the same question — "who is behind this identity, and
// what are they called?" — and answers it more efficiently, since it does not
// require guessing an id. Everything else about that route was already right
// (LIKE metacharacters escaped, `q` capped at users.name's width, blocked pairs
// mutually invisible, caller excluded, no email in the projection) and none of
// it is a ceiling. Iterating `q` over two-character substrings is 676 requests,
// well inside one 15-minute apiLimiter window, and each 200 returns up to 20
// {id, name, avatar}. For any realistic user base that is the whole table.
//
// This is the pattern the round-4 audit asked to be fixed as a class rather
// than as an instance: **a spend counter is a security control, and applying it
// to the route that was reported rather than to every route that answers the
// question leaves the control complete on paper and absent in practice.**
//
// WHY 90/HOUR AND 300/DAY, below the card's 120/400. A search is TYPED and a
// card open is a TAP. A person types a few characters, reads the twenty results
// and taps one; they do not type ninety searches in an hour, whereas they
// genuinely can open a hundred cards scrolling a single roster.
//
// The number is set by the worst legitimate case rather than the typical one,
// and that case is a DEBOUNCED SEARCH BOX: the client sends a request per
// settled prefix, so a six-character name typed slowly is six requests, and ten
// such searches in one hour is 60. A first pass at 60/hour put the ceiling
// exactly on that figure — the test in __tests__/searchProbeBudget.test.js that
// walks a real typing session is what caught it, which is the reason that case
// asserts headroom rather than asserting the constant. 90 leaves a third of the
// allowance spare on top of the heaviest hour anyone has described.
//
// It still cuts the two-character walk from ~288,000 requests a day to 300, a
// ~960x reduction, and the fresh lane costs a fresh account rather than a fresh
// proxy.
//
// CHARGED PER REQUEST, NOT PER ROW. The rows are a consequence of the probe,
// not the probe itself, and per-row charging would make a query that matched
// nothing free — which is exactly the "the free answers are the misses" signal
// the card budget refuses to emit.
// ---------------------------------------------------------------------------
const searchProbeBudget = createUserBudget({ name: 'search-probe', hourly: 90, daily: 300 });

// GET /api/users/:id/card - Mini profile card for any user: id, name, avatar,
// bio. Four fields, and only four — this is the surface a stranger's tap on an
// avatar resolves to, so it must never grow an email, a phone number, or a
// score without a deliberate decision.
//
// 404, not 403, for every refused case — a blocked pair (either direction), a
// banned account, a deleted account — and it is the SAME 404 a made-up id gets.
// User ids are sequential integers, so any distinction between "no such user"
// and "you may not see this user" is an oracle: it would tell a blocked person
// they are blocked, and tell anyone walking the id space which rows exist.
router.get('/:id/card',
  param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const targetId = parseInt(req.params.id, 10);

      // Charged on every probe at somebody else, hit or miss. Charging only on
      // hits would leave the misses free and unbounded, and "the free answers
      // are the misses" is the enumeration signal itself (routes/friends.js
      // makes the same call for the same reason).
      const withinBudget = targetId === req.user.id || cardProbeBudget.allow(req.user.id);

      // Queried even when the budget is spent, so the exhausted path does the
      // same one lookup a genuine miss does and cannot be separated from it by
      // response time. THE REFUSAL MUST NOT BECOME A NEW ORACLE: an exhausted
      // budget returns the same 404 body as a nonexistent id, at the same query
      // cost, so a walker who runs out learns nothing about the ids they could
      // no longer read. (A 429 would be honest to a real client, but it would
      // also confirm that the request got as far as the budget — and, more to
      // the point, the whole class of "this refusal is shaped differently" is
      // what the uniform 404 on this route exists to prevent.)
      const result = await pool.query(
        'SELECT id, name, profile_image_url, bio, is_banned FROM users WHERE id = $1',
        [targetId]
      );
      // Banned reads as deleted: a banned account's content is withdrawn
      // everywhere else, and its card must not be the one surface that still
      // vouches for it.
      if (!withinBudget || result.rows.length === 0 || result.rows[0].is_banned) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Mutual invisibility (utils/blocks.js): if either side blocked the
      // other, neither can pull the other's card. isBlockedBetween answers
      // false for self, so viewing your own card stays allowed.
      if (await isBlockedBetween(req.user.id, targetId)) {
        return res.status(404).json({ error: 'User not found' });
      }

      const u = result.rows[0];
      res.json({ id: u.id, name: u.name, profile_image_url: u.profile_image_url, bio: u.bio });
    } catch (err) {
      console.error('Get user card error:', err);
      res.status(500).json({ error: 'Failed to get user' });
    }
  }
);

// Mirrors express-validator's normalizeEmail() defaults, for COMPARISON only.
// The submitted address is normalized by the validator; stored addresses are
// not always (OAuth rows keep the provider's address verbatim, and rows predate
// the sanitizer), so comparing raw against normalized would read an UNCHANGED
// profile form as an email change and reject it.
function normalizedAddress(addr) {
  if (typeof addr !== 'string') return '';
  const at = addr.lastIndexOf('@');
  if (at < 1) return addr.toLowerCase();
  let local = addr.slice(0, at).toLowerCase();
  let domain = addr.slice(at + 1).toLowerCase();
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return `${local}@${domain}`;
}

// ---------------------------------------------------------------------------
// Recent-possession proof ("sudo mode") — round 16
// ---------------------------------------------------------------------------
// A Flock JWT lives 24h and nothing about holding one proves the holder is the
// account owner right now. Two actions in this file are irreversible or
// identity-defining enough that a bearer token alone must not be sufficient:
// deleting the account (which also revokes the Apple grant and cannot be
// undone) and changing the phone number (which is the key friend discovery
// resolves against, so claiming someone else's number redirects their
// contact-sync lookups at you).
//
// Password accounts prove possession the obvious way: retype the password.
// That locks nobody out, because typing the password is the ONLY way a
// password account can sign in at all — anyone legitimately holding a live
// session for one knows it.
//
// OAuth accounts have no password to retype, so the equivalent is a session
// that was minted by an actual provider sign-in moments ago. `iat` is stamped
// by jsonwebtoken on every token signUserToken issues, so a token that is more
// than REAUTH_WINDOW_MS old fails the check and the client has to re-run Sign
// in with Apple / Google to get a fresh one. A token lifted hours earlier (the
// realistic theft) is stale by definition.
//
// Deletion stays genuinely reachable either way, which is the Apple 5.1.1(v)
// requirement: banned accounts can still sign in (the ban is enforced by
// middleware/auth.js on API calls, not by the sign-in routes), so a banned user
// can always obtain the proof and finish deleting.
const REAUTH_WINDOW_MS = 5 * 60 * 1000;

function tokenIssuedAtMs(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  // Split exactly the way middleware/auth.js does. Taking the rest of the
  // header instead would read a DIFFERENT string out of `Bearer <token> junk`
  // than the one that was just verified, and the only possible outcome of that
  // divergence is refusing a request the middleware accepted.
  const token = header.split(' ')[1];
  if (!token) return null;
  try {
    // Re-verified, not just decoded: this must never accept an unsigned or
    // tampered `iat`. The request already passed the same verification in
    // middleware/auth.js, so this can only agree with it or fail closed.
    // The `||` is not decoration: an undefined `algorithms` makes jsonwebtoken
    // infer the accepted set from the key instead of pinning it, so if that
    // export is ever renamed in middleware/auth.js this must not quietly widen.
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: TOKEN_ALGORITHMS || ['HS256'],
    });
    return Number.isFinite(decoded?.iat) ? decoded.iat * 1000 : null;
  } catch {
    return null;
  }
}

function hasFreshSession(req, now = Date.now()) {
  const issuedAt = tokenIssuedAtMs(req);
  if (issuedAt === null) return false;
  // A token minted "in the future" is clock skew between the signer and this
  // process, not an attack (the signer is this same app), so it counts as fresh.
  return now - issuedAt <= REAUTH_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Per-account attempt ceilings
// ---------------------------------------------------------------------------
// Asking for a password creates a place to GUESS a password. Nothing else in
// this file counted attempts, and the API limiter is 300 requests / 15 min PER
// IP, which is not a limit at all for someone with a stolen token and a handful
// of cloud addresses: they could sit on DELETE /api/users/me and brute force
// the account password (8 characters, one uppercase, one digit), which is worth
// far more than the account itself because people reuse it. Each guess also
// costs the server a full bcrypt round, so an unbounded guesser is a CPU drain
// on top. routes/auth.js does exactly this for /login (round 15); this is the
// same primitive for the two proofs in this file.
//
// In memory and therefore per process: a real ceiling on the single-instance
// Railway deployment, a partial one behind N instances. Same trade documented
// on the login throttle, and the same bounded map so an attacker cycling ids
// cannot grow it without limit.
const ATTEMPT_MAX_KEYS = 20000;
// Evict down to 90%, not to the ceiling. Stopping exactly at the ceiling makes
// a map held AT the ceiling sort itself on every single record(), which is a
// CPU lever the caller controls. Same low-water rule and the same number as
// routes/auth.js evictLoginFailures, routes/publicCrowd.js and
// utils/probeBudget.js.
const ATTEMPT_LOW_WATER = Math.floor(ATTEMPT_MAX_KEYS * 0.9);

// SECURITY-AUDIT-auth.md A5-3 (LOW), and the class round 23 swept everywhere
// else. This memory guard used to end in `hits.clear()` — the last wholesale
// clear() left on a live path in the backend, and it sits under FOUR counters
// including proofFailures, the password-guess throttle on account deletion,
// data export and profile edit. Round 2 triaged the clear as unreachable
// ("filling it requires 20,000 real accounts"), and that judgement still holds
// for proofFailures because its key is an authenticated users.id — but
// `emailChangeAttempts` and `phoneChangeAttempts` are keyed the same way and
// the argument is about the data rather than about the code. A control that
// gets WEAKER the harder it is pushed does not get to stay in the tree on the
// strength of an argument about how many accounts exist.
//
// EXPIRE FIRST, THEN EVICT LEAST CONSUMED FIRST — never clear(). Consumption
// order rather than insertion age, for the reason evictLoginFailures spells
// out: the entry an attacker wants gone is the throttled one, and a throttled
// entry is both the OLDEST and the FULLEST, so an age-ordered drop deletes
// precisely the entry that was doing the work. Lowest-count-first deletes the
// flooder's own one-hit entries instead, so displacing a locked entry costs
// ~20,000 accounts that have EACH already been failed to the limit.
function evictAttempts(hits, now) {
  for (const [k, v] of hits) if (now >= v.expiresAt) hits.delete(k);
  if (hits.size <= ATTEMPT_MAX_KEYS) return;
  const byConsumption = [...hits.entries()].sort((a, b) => a[1].count - b[1].count);
  for (const [k] of byConsumption) {
    if (hits.size <= ATTEMPT_LOW_WATER) break;
    hits.delete(k);
  }
}

function attemptLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    lockedFor(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry) return 0;
      if (now >= entry.expiresAt) { hits.delete(key); return 0; }
      return entry.count >= limit ? entry.expiresAt - now : 0;
    },
    record(key, now = Date.now()) {
      // Bounded: a caller cycling keys must not grow this without limit — and
      // must never be able to EMPTY it.
      if (hits.size > ATTEMPT_MAX_KEYS) evictAttempts(hits, now);
      const entry = hits.get(key);
      if (!entry || now >= entry.expiresAt) {
        hits.set(key, { count: 1, expiresAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },
    // Per-KEY, not wholesale: this deletes the caller's own entry and nothing
    // else. proofFailures uses it on a correct password so a user who mistypes
    // and then gets it right is not held back; the key is the authenticated
    // users.id, so the only counter a caller can clear here is their own.
    clear(key) { hits.delete(key); },
    // Tests only. Production code must never reset a throttle wholesale.
    clearAll() { hits.clear(); },
    size() { return hits.size; },
  };
}

// Wrong current-password / deletion-password proofs. Cleared on success, so a
// user who mistypes and then gets it right is never held back. Five attempts
// then a cooling-off period still leaves deletion genuinely reachable, which is
// the Apple 5.1.1(v) line this must not cross.
const proofFailures = attemptLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
// The refusal, with the real window in it. lockedFor() has always returned the
// milliseconds left, and the three routes that call this threw them away for
// "a few minutes" against a window of fifteen. That is the advice
// utils/retryAfter.js exists to stop: the person came back at three, was
// refused again, and read that as the feature being broken. /login already
// says it this way, and the client renders the sentence as sent.
function tooManyProofs(res, lockedMs, extra = {}) {
  return res.status(429).json({
    ...refusalBody(res, lockedMs, `Too many incorrect passwords. You can try again ${waitPhrase(lockedMs)}.`),
    ...extra,
  });
}

// Phone-number CHANGE attempts, successful ones included. The uniqueness check
// added below answers "is this number registered here?", which is an
// enumeration oracle that would otherwise run at the API limiter's 300 per 15
// minutes and bypass the contact-sync budget POST /api/friends/find-by-phone is
// metered by. Nobody changes their number five times an hour.
const phoneChangeAttempts = attemptLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

// Email-address CHANGE attempts, successful ones included — round 19.
//
// The phone branch got this treatment and the email branch beside it did not,
// even though the email uniqueness check answers the strictly more valuable
// question: "does an account exist at this address?" That is the same oracle
// POST /api/auth/signup answers, and signup is behind the 10/min auth limiter
// precisely because of it — while PUT /api/users/profile sits behind the general
// API limiter at 3000/15min, roughly 200/min. So the profile form was a ~20x
// cheaper way to enumerate Flock's user base by address than the endpoint that
// was rate limited for exactly that reason, and the "already in use" 400 and the
// 200 are both answers.
//
// Ten an hour rather than the phone branch's five: an address is the field
// people actually mistype, and this must not turn a user who fat-fingers their
// new address a few times into a support ticket. Ten still takes the oracle from
// two hundred a minute to ten an hour, and costs an attacker a whole fresh
// account (which needs an address and a DOB, through the throttled auth
// limiter) for every ten probes.
const emailChangeAttempts = attemptLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
const TOO_MANY_EMAIL_CHANGES_MESSAGE =
  'You have changed your email address several times already. Try again later.';

// ---------------------------------------------------------------------------
// Ban-evasion tombstones (round 16) — see migrations/012_banned_identities.sql
// ---------------------------------------------------------------------------
// A banned user is allowed to delete their own account (Apple 5.1.1(v)), and
// before this nothing survived that deletion, so the ban was reversible by the
// banned person: delete, sign up again on the same email, get a clean row.
// Deleting a BANNED account now leaves keyed one-way digests of the identifiers
// a returning user would reuse. The full privacy and retention rationale is in
// the migration; the short version is that these users are frequently minors,
// so we store no plaintext, nothing that is not needed to recognise a return,
// and nothing that outlives the retention window.
const BAN_TOMBSTONE_RETENTION_DAYS = 365;

// The pepper is what makes these digests safe to hold: a 10-digit phone number
// has almost no entropy, so an unkeyed SHA-256 of one is reversible by anyone
// who reads the table. Dedicated env var if set, JWT_SECRET otherwise (always
// present — the server cannot mint a token without it).
function identityPepper() {
  return process.env.BAN_TOMBSTONE_SECRET || process.env.JWT_SECRET || '';
}

// `kind` is inside the HMAC input so an email digest can never be compared
// against, or collide with, a phone digest.
function identityDigest(kind, value) {
  const key = identityPepper();
  if (!key || !value) return null;
  return crypto.createHmac('sha256', key).update(`${kind}:${value}`).digest('hex');
}

// The BAN TOMBSTONE canonical form, which is deliberately looser than the
// contact-discovery one and must stay that way.
//
// This used to say "match the comparison friend discovery actually uses", and
// that was true until 2026-08-25, when find-by-phone moved to a canonical E.164
// string (utils/phone.js `toE164`). The two are now different on purpose:
//
//   discovery  +1 then exactly 10 valid NANP digits, or a whole international
//              number as written. A fragment resolves to nothing, because a
//              fragment used to match a thousand real numbers at once.
//   tombstone  the last 10 digits, 7 or more. Looser is CORRECT here. This
//              answers "is the person creating this account the banned person
//              who left", and the banned person is actively trying to look
//              different: a country code added, a leading 1 dropped, a number
//              stored in a shape `toE164` would decline. A tombstone that only
//              matched perfectly formed numbers would be evaded by retyping.
//              Nothing is returned to a caller from this comparison, so its
//              looseness costs a rare false positive on signup and never leaks
//              a directory answer.
//
// These two digests also live under different HMAC namespaces ('phone:' here,
// 'contact-discovery:v1:' there), so a value from one table can never be
// compared against a value from the other even where the canonical forms would
// have agreed. Changing THIS function invalidates every stored tombstone; do
// not fold the two together.
function canonicalPhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return '';
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  return digits.length >= 7 ? digits : '';
}

function identityDigests({ email, phone, oauthProvider, oauthId } = {}) {
  const canonicalMail = typeof email === 'string' ? normalizedAddress(email.trim()) : '';
  const canonicalNumber = canonicalPhone(phone);
  const oauthKey = oauthProvider && oauthId
    ? `${String(oauthProvider).toLowerCase()}:${String(oauthId)}`
    : '';
  return {
    emailHash: canonicalMail ? identityDigest('email', canonicalMail) : null,
    phoneHash: canonicalNumber ? identityDigest('phone', canonicalNumber) : null,
    oauthHash: oauthKey ? identityDigest('oauth', oauthKey) : null,
  };
}

// The signup-side lookup. Exported for routes/auth.js, which owns every account
// creation path (password signup, Google, Apple).
//
// FAILS OPEN on a database error, deliberately. This sits in front of every
// signup in the product: failing closed would turn one bad query into "nobody
// can create an account", which is a far worse outcome than a banned user
// getting back in during an outage. The failure is logged loudly instead.
async function isIdentityBanned(identity) {
  try {
    const { emailHash, phoneHash, oauthHash } = identityDigests(identity || {});
    if (!emailHash && !phoneHash && !oauthHash) return false;
    const result = await pool.query(
      `SELECT 1 FROM banned_identities
        WHERE expires_at > NOW()
          AND (($1::text IS NOT NULL AND email_hash = $1)
            OR ($2::text IS NOT NULL AND phone_hash = $2)
            OR ($3::text IS NOT NULL AND oauth_hash = $3))
        LIMIT 1`,
      [emailHash, phoneHash, oauthHash]
    );
    maybePurgeExpired();
    return result.rows.length > 0;
  } catch (err) {
    console.error('[ban-tombstone] lookup failed, allowing signup:', err.message);
    return false;
  }
}

// Deliberately vague, and identical whatever matched: a precise message would
// tell an attacker which of a victim's identifiers is on the list, turning this
// into an oracle ("is this phone number banned?").
// social@flockcorp.com is the address the app actually sends from
// (services/emailService.js). Inventing a support@ that nobody reads would be
// worse than saying nothing, and this is the only route a false positive (a
// recycled phone number) has back to a human.
const BANNED_IDENTITY_MESSAGE =
  'This account cannot be created. If you believe this is a mistake, contact social@flockcorp.com.';

// Mirrors rejectIfProfane(res, name) in utils/moderation.js: returns true when
// it has already sent the response, so the caller writes one line.
async function rejectIfBannedIdentity(res, identity) {
  if (!(await isIdentityBanned(identity))) return false;
  console.warn(`[ban-tombstone] blocked signup for a tombstoned identity at ${new Date().toISOString()}`);
  res.status(403).json({ error: BANNED_IDENTITY_MESSAGE });
  return true;
}

// Written inside the account-deletion transaction (see deleteAccount) so the
// tombstone and the row's disappearance are the same atomic event. If this
// throws, the whole deletion rolls back and the caller is told to retry, which
// is the same trade the round-12 moderation-evidence de-attribution already
// makes: never let the account vanish while the record of it fails to land.
async function recordBannedIdentity(client, user) {
  // HIGH 1 (re-audit): a password account's email is UNVERIFIED — proving
  // ownership is the entire reason email verification exists. Hashing
  // user.email unconditionally turned this into a poison pill: register a
  // password squat on a victim's address (unverified squats are allowed), get
  // it banned (unverified accounts can still send DMs, so an abuse-report ban
  // is reachable), then delete the squat, and this wrote HMAC(victim's address)
  // with a 365-day expiry. The real owner could then never sign up on any path
  // (password, Google, Apple all 403 on the tombstone), and the reclaim-via-
  // verified-OAuth-claim path never runs because the squat row is gone. So only
  // tombstone an address this account actually PROVED. The oauth digest stays
  // unconditional — a provider-verified identity genuinely belongs to the
  // banned person. An unverified banned account then leaves only an oauth
  // tombstone or none, never a block on a stranger's mailbox.
  // A grandfathered row (verified before migration 011) carries email_verified
  // TRUE with a NULL verified_email; claimDecision() in routes/auth.js trusts
  // exactly that state, so this mirrors it — a null recorded address on a
  // verified row means "trust the address it holds". The attack this closes is
  // an UNVERIFIED squat, which has email_verified === false and never reaches
  // here.
  //
  // ROUND 19 (re-audit): the first cut of this fix required verified_email to
  // MATCH the current email and tombstoned user.email. That branded the address
  // the row HOLDS, and it only did so when the row also still held the address
  // it had PROVED — so an account that moved off its proven address before the
  // ban landed shed the tombstone entirely. Deleting it recorded nothing about
  // an email, and the banned person signed up again on the original address with
  // a clean row. (The ban blocks PUT /profile, so the move has to happen before
  // the ban; that narrows the window, it does not close it.)
  //
  // Brand the PROVED address instead. verified_email is only ever written as
  // `verified_email = email` at the moment a link was clicked (consumeVerification
  // in routes/auth.js), at an OAuth INSERT where the provider vouched for the
  // address, or by migration 011's grandfathering — it is never attacker-chosen
  // free text. So it carries the same poison-pill safety the round-16 fix was
  // reaching for: an address a squatter merely TYPED into its profile never
  // appears here, and a stranger's mailbox can still never be branded by
  // someone who cannot read it. What it adds is that the brand follows the
  // proof rather than the current holder of the row.
  //
  // Order matters: verified_email FIRST, current email only as the grandfathered
  // fallback. Reading them the other way round would go back to branding the
  // address the row holds whenever it happens to be flagged verified, which is
  // the state a pre-round-18 profile edit leaves behind (email_verified TRUE for
  // an address the row never proved) — the poison pill, exactly.
  //
  // Residual, accepted: if the banned row vacated its proved address long enough
  // ago that somebody else has since registered it, that person's address is now
  // branded too — they keep their account, but a delete-and-re-signup would be
  // refused for the rest of the retention window. It is the same recycled-
  // identifier exposure the phone digest already carries, it needs the address to
  // have been vacated AND re-registered AND then re-registered again, and the
  // alternative is branding nothing at all, which is a guaranteed evasion. A
  // "skip if another row holds it now" check would be worse: it hands the
  // attacker a suppression switch (park a second account on the address before
  // the ban lands).
  //
  // NOT used: email_verifications rows with used_at set. That looks like a proof
  // history, but releaseSquattedAddress() in routes/auth.js bulk-stamps used_at
  // on an evicted squat's PENDING links purely to invalidate them, so a row
  // there can record an address that was never read by anybody. Tombstoning off
  // that table would re-arm the exact poison pill this guard exists to prevent.
  const provenAddress = user.verified_email
    || (user.email_verified === true ? user.email : null);
  const { emailHash, phoneHash, oauthHash } = identityDigests({
    email: provenAddress || undefined,
    phone: user.phone,
    oauthProvider: user.oauth_provider,
    oauthId: user.oauth_id,
  });
  if (!emailHash && !phoneHash && !oauthHash) {
    // No usable identifier (no pepper configured, or an Apple relay row with
    // nothing but a placeholder address). Writing an empty row would violate
    // the table's CHECK and would hold data about a minor for no purpose.
    console.warn('[ban-tombstone] no usable identifier for the deleted banned account, nothing recorded');
    return false;
  }
  await client.query(
    `INSERT INTO banned_identities (email_hash, phone_hash, oauth_hash, banned_at, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 day'))`,
    [emailHash, phoneHash, oauthHash, user.banned_at || null, BAN_TOMBSTONE_RETENTION_DAYS]
  );
  return true;
}

// Retention is enforced by the read path (every lookup filters expires_at), so
// an expired tombstone stops having any effect the moment it expires whether or
// not this has run. But "it expires" has to mean the row is actually gone, not
// just ignored, or the retention promise in the migration is a lie the first
// time anyone reads the table. Best-effort and outside any transaction: it must
// never be able to fail an account deletion.
async function purgeExpiredBannedIdentities() {
  try {
    const result = await pool.query('DELETE FROM banned_identities WHERE expires_at <= NOW()');
    return result.rowCount || 0;
  } catch (err) {
    console.error('[ban-tombstone] purge failed:', err.message);
    return 0;
  }
}

// There is no scheduler in this app, and hanging retention off "a banned
// account happened to be deleted" would mean a quiet year leaves expired rows
// on disk indefinitely. Signups are the one thing that reliably happens, so the
// lookup triggers the purge — at most once an hour per process, fire and
// forget, so it can never add latency to a signup or fail one.
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

function maybePurgeExpired(now = Date.now()) {
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return false;
  lastPurgeAt = now;
  purgeExpiredBannedIdentities().catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Field bounds — every ceiling this file owns, and where each number came from
// ---------------------------------------------------------------------------
// AUDIT 2026-08-14. Six fields on these routes had no maximum OF THEIR OWN, so
// the only thing deciding how large they could be was express.json()'s limit in
// server.js. That limit was just moved from 1MB to 64KB as a security fix, which
// means six unrelated fields silently got sixteen times smaller and nobody
// reviewed the change to any of them. A field whose bound lives in another file
// is a field whose bound moves when somebody tunes a number two files away, and
// it is a field nobody can reason about from the route that accepts it.
//
// Column widths are read from migrations/000_bootstrap.sql. Over a VARCHAR width
// is a Postgres 22001, which surfaces as a 500 for what is plainly a client
// mistake, so each of these is also the difference between a 400 and a 500:
//
//   MAX_NAME          users.name VARCHAR(255)
//   MAX_EMAIL         users.email VARCHAR(255). A BACKSTOP, not the active
//                     gate, and it is worth being precise about that: the thing
//                     refusing a 300-character address today is validator.js,
//                     whose isEmail caps the WHOLE address at 254 characters
//                     (measured, not assumed). So the column is safe right now
//                     because of a number in node_modules. `ignore_max_length`
//                     is an isEmail option, that default is a library's to
//                     change, and this route would then write straight past its
//                     own column. The bound says what THIS route will accept.
//                     __tests__/fieldBounds.test.js measures the largest address
//                     the route really takes and checks it against the column
//                     rather than trusting either number.
//   MAX_PHONE         users.phone VARCHAR(20)
//   MAX_SEARCH_QUERY  users.name VARCHAR(255) again, and for a second reason
//                     that is stronger than the first: GET /search matches
//                     `%term%` against that column, so a term wider than the
//                     column cannot match any row no matter how long it is.
//                     Everything past the column width is pure ILIKE cost.
//
// The rest have no column width to borrow, so they come from the product:
//
//   MAX_AVATAR_URL    the only URL this route accepts is a DiceBear one (the
//                     host allowlist below is a single entry), and the URL the
//                     client builds is about 55 characters:
//                     https://api.dicebear.com/7.x/<style>/svg?seed=<seed>.
//                     255 is over four times that, leaves room for DiceBear's
//                     option parameters, and matches the width of every other
//                     identifier column this file writes. It matters because
//                     profile_image_url is repeated on every message row,
//                     roster entry and push payload the user appears in.
//   MAX_PASSWORD      bcrypt ignores everything past 72 bytes, so no character
//                     beyond that can change the outcome of a compare or a hash.
//                     1024 is fourteen times the part that can matter and far
//                     above what any password manager generates, so it cannot
//                     lock out an account whose password predates this bound.
//                     Deliberately generous for exactly that reason: routes/
//                     auth.js has never had a maximum, so a longer password may
//                     already exist and must still be typeable.
//   MAX_INTERESTS     interests is TEXT[], which has no width at all, so both of
//                     these come from the picker. The interests screen in
//                     frontend/src/App.js offers 12 suggestions on top of 3
//                     defaults, so 15 chips are reachable without typing a
//                     single character. 30 is double that, which covers somebody
//                     who types their own and never removes any.
//   MAX_INTEREST_LEN  the longest interest the product itself defines is
//                     "art & culture", 13 characters, in the interestToTM map in
//                     routes/events.js. 40 is three times that.
//                     __tests__/fieldBounds.test.js reads that map and fails if
//                     either ceiling drops below what it needs, which is the
//                     half of a bound that boundary tests cannot check: they are
//                     driven from the constant, so they follow it downwards.
const MAX_NAME = 255;
const MAX_EMAIL = 255;
const MAX_PHONE = 20;
const MAX_SEARCH_QUERY = 255;
const MAX_AVATAR_URL = 255;
const MAX_PASSWORD = 1024;
const MAX_INTERESTS = 30;
const MAX_INTEREST_LEN = 40;
// users.bio is TEXT (migration 026), so the column has no width of its own and
// this ceiling is the whole bound. 200 is a product number: the card the bio
// renders on is a mini profile, not a page. Measured AFTER freeText strips the
// markup, i.e. against the string that will actually be stored — a real
// 200-character bio fits, and a bio that is nothing but tags strips to '',
// which is falsy and leaves the stored value alone like every other blank
// field on this form.
const MAX_BIO = 200;

// interests is TEXT[] and node-pg will serialize whatever it is handed into it,
// so the contents have to be checked and not merely the fact that an array
// arrived. Before this, the chain was `isArray()` and nothing else, and
// sanitizeArray (utils/sanitize.js) bounds nothing either — it strips markup per
// element and drops non-scalars, which is a content rule, not a size one. So the
// array length AND each element's length were both decided by server.js.
//
// Strings only. sanitizeArray keeps numbers and booleans as they are, which
// would store `true` as the text "true" in a column whose whole content is
// human-typed tags. Nothing legitimate sends one, and the frontend picker only
// ever produces strings.
//
// Measured BEFORE stripHtml runs, on purpose and in the direction that is safe:
// stripping can only shorten, so a value inside this bound is inside it in the
// column too, while a 300-character value made of tags is refused rather than
// quietly becoming a short one. The blank-after-stripping case is caught in the
// handler, where the stripped array exists.
const interestsRule = body('interests').optional({ nullable: true }).custom((v) => {
  if (!Array.isArray(v)) throw new Error('Interests must be a list');
  if (v.length > MAX_INTERESTS) throw new Error(`Too many interests (max ${MAX_INTERESTS})`);
  for (const item of v) {
    if (typeof item !== 'string') throw new Error('Each interest must be text');
    if (item.length > MAX_INTEREST_LEN) {
      throw new Error(`Each interest must be under ${MAX_INTEREST_LEN} characters`);
    }
  }
  return true;
});

// PUT /api/users/profile - Update current user's profile (requires current password)
router.put('/profile',
  [
    // `optional({ nullable: true })` throughout (round 20): the handler below
    // already reads a falsy value as "leave this column alone" — `name || null`,
    // `Boolean(email)`, `if (new_password)`, and a bcrypt compare against '' —
    // while express-validator's `optional()` skips only `undefined`. A client
    // that spells an untouched field as an explicit null (which the phone field
    // beside them has accepted since round 16) was answered 400 by the chain for
    // a submission the handler knows how to serve.
    // `scalarOnly` at the HEAD of this chain, not in the handler loop below
    // (round 20). That loop catches an array, because an array survives the
    // chain intact — but `trim()` stringifies an OBJECT, so `{"name": {}}` had
    // already become the string "[object Object]" by the time the loop saw it,
    // passed as a perfectly good string, and was stored in users.name. Shape has
    // to be settled before the first sanitizer, not after the last one.
    // freeText = shape -> trim -> stripHtml -> trim, and the trailing trim is
    // the half this chain was missing: stripHtml('<b> </b>') is a single space,
    // which satisfies isLength({ min: 1 }) and sails past rejectIfProfane, so
    // the rename accepted a BLANK name into the column every roster, invite,
    // chat row and push renders. Sanitize, then trim, then measure.
    freeText(body('name').optional({ nullable: true }), 'name')
      .isLength({ min: 1, max: MAX_NAME }).withMessage(`Name must be 1-${MAX_NAME} characters`),
    // Same treatment as name: shape -> trim -> stripHtml -> trim, then the
    // ceiling. Free text a stranger reads (the /:id/card route serves it to any
    // authenticated user), so it takes the full freeText chain and the
    // profanity screen in the handler below.
    freeText(body('bio').optional({ nullable: true }), 'bio')
      .isLength({ max: MAX_BIO }).withMessage(`Bio must be ${MAX_BIO} characters or fewer`),
    // normalizeEmail() matches signup and login (routes/auth.js), so
    // `v.ictim@gmail.com` cannot be stored as a distinct row that shadows
    // `victim@gmail.com` in the LOWER(email) lookups those paths use.
    //
    // MEASURED TWICE, AND THE SECOND ONE IS THE ONE THAT PROTECTS THE COLUMN.
    //
    // The first draft of this rule measured the raw address only, on the
    // reasoning that "normalizeEmail can only shorten: it lowercases and strips
    // Gmail dots and +subaddresses". That reasoning is wrong, and the
    // counterexample is live rather than theoretical. isEmail allows a UTF-8
    // local part by default, and lowercasing U+0130 (İ, dotted capital I) yields
    // TWO code points. isEmail caps the local part at 64 BYTES, so a local part
    // of 32 İ is legal, 32 code points wide, and 64 code points wide once it has
    // been normalized. Put that in front of a long legal domain and a
    // 254-code-point address that passes every check on this route becomes 286
    // code points on its way to a VARCHAR(255): Postgres 22001, i.e. a 500, on
    // the exact overflow this bound exists to stop. (Measured, not reasoned:
    // __tests__/fieldBounds.test.js sends that address.)
    //
    // So the width is checked again AFTER the sanitizer, against the value that
    // will actually be written. The first check is kept as well, because it is
    // what keeps a 64KB string away from isEmail's regex work.
    body('email').optional({ nullable: true })
      .isLength({ max: MAX_EMAIL }).withMessage('Email address is too long')
      .isEmail().withMessage('Valid email required')
      .normalizeEmail()
      .isLength({ max: MAX_EMAIL }).withMessage('Email address is too long'),
      // The disposable-domain rule is applied in the handler, once the stored
      // address is known: it is a rule about MOVING to such an address, not
      // about naming one. See changingEmail.
    // Round 16: this was `body('phone').optional()` with NO validation at all,
    // while signup runs isMobilePhone(). Two separate problems came out of that:
    // anything at all could be written into the column (a name, a URL, an
    // address — the field is shown to friends), and a string longer than the
    // VARCHAR(20) column 500'd at the database instead of returning a 400.
    // checkFalsy keeps the existing behaviour for clients that submit the whole
    // profile form with an empty phone field: '' becomes NULL in the parameter
    // list and COALESCE leaves the stored value alone, exactly as before. It
    // must not start 400ing them.
    body('phone').optional({ nullable: true, checkFalsy: true }).trim()
      .isMobilePhone().withMessage('Invalid phone number')
      .isLength({ max: MAX_PHONE }).withMessage('Phone number is too long'),
    interestsRule,
    // Optional at the validator layer: OAuth accounts have no password, and a
    // notEmpty() here 400'd their profile edits before the OAuth-aware handler
    // below could run. Password accounts still fail closed — the bcrypt
    // compare against a missing value returns 401.
    //
    // Both password fields carry a ceiling of their own now (see MAX_PASSWORD).
    // The cost of an unbounded one is not CPU — bcrypt reads 72 bytes and
    // ignores the rest — it is that "how long may a password be" was answered by
    // the JSON parser in server.js, on the two fields where the answer should be
    // deliberate.
    body('current_password').optional({ nullable: true }).isString()
      .isLength({ max: MAX_PASSWORD }).withMessage('Password is too long'),
    body('new_password').optional({ nullable: true })
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
      .isLength({ max: MAX_PASSWORD }).withMessage('New password is too long')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
      .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { name, email, phone, interests, bio, current_password, new_password } = req.body;

      // ARRAY-SHAPED FIELDS WALK PAST express-validator (round 16). Given
      // `{"phone": ["+12025550122"]}` the chain runs per ELEMENT, every element
      // passes isMobilePhone, and req.body.phone is STILL AN ARRAY afterwards —
      // sanitizers write back element by element and never collapse it. It then
      // goes to pg as an array parameter for a text column, which stores the
      // literal `{"+12025550122"}`: a value that is not a phone number, is
      // still matched digit-for-digit by find-by-phone, and can overflow
      // VARCHAR(20) into a 500. The same shape hits name, email and the two
      // password fields (bcrypt throws on a non-string, which is another 500).
      // Validators check CONTENT; this checks TYPE, which is the half they
      // structurally cannot do.
      for (const [field, value] of Object.entries({ name, email, phone, bio, current_password, new_password })) {
        if (value !== undefined && value !== null && typeof value !== 'string') {
          return res.status(400).json({ error: `Invalid ${field.replace('_', ' ')}` });
        }
      }

      // UGC text filter on display name (Apple 1.2). `name` has already been
      // through stripHtml by this point (freeText applies it as a sanitizer), so
      // this screens the string that will actually be stored.
      if (name && rejectIfProfane(res, name)) return;

      // Same UGC screen for the bio, on the stripped string (freeText already
      // ran), for the same Apple 1.2 reason as the name above.
      if (bio && rejectIfProfane(res, bio)) return;

      // interests is UGC that somebody other than its author reads: routes/
      // admin.js renders it into the moderation queue's profile evidence
      // (ARRAY_TO_STRING(u.interests, ', ')), which is the surface a moderator
      // decides a ban on. sanitizeArray already stripped its markup; nothing
      // screened it.
      //
      // The screen runs on what came OUT of sanitizeArray, not on what went in,
      // and the ordering is load-bearing rather than tidy. A tag WRAPPING a word
      // does not hide it (the wordlist tokenizes on the angle brackets, so
      // "<b>shit</b>" is caught either way) — a tag INSIDE one does: "sh<b>it"
      // is three harmless tokens before stripHtml and one slur after it. Screen
      // first and that value is stored, screened, as the slur it becomes. This
      // is the same reason freeText applies stripHtml before `name` is screened
      // on the field above, measured rather than assumed:
      // __tests__/fieldBounds.test.js asserts both halves of it.
      let safeInterests = null;
      if (interests) {
        safeInterests = sanitizeArray(interests).map((v) => String(v).trim());
        for (const interest of safeInterests) {
          // Blank only AFTER stripping, i.e. an interest made entirely of
          // markup. Storing it would put an empty chip in the array and an empty
          // slot in the moderator's evidence line.
          if (interest === '') {
            return res.status(400).json({ error: 'An interest cannot be blank' });
          }
          if (rejectIfProfane(res, interest)) return;
        }
      }

      // Fetch current user with password
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      // Verify current password. OAuth accounts have no password (round 3:
      // bcrypt.compare against null threw and locked Google/Apple users out
      // of every profile edit); their bearer token is their auth. They can't
      // SET a password here either — that would bolt a second credential
      // onto an OAuth account without any email-ownership verification.
      if (user.password) {
        // Round 16: bounded. See proofFailures above — this is a password
        // guessing surface for anyone holding a token, and it counted nothing.
        const lockedMs = proofFailures.lockedFor(user.id);
        if (lockedMs > 0) return tooManyProofs(res, lockedMs);
        const validPassword = await bcrypt.compare(
          typeof current_password === 'string' ? current_password : '',
          user.password
        );
        if (!validPassword) {
          proofFailures.record(user.id);
          // reauthRequired: the client treats any other 401 on a signed-in
          // request as a dead session, cleared it, and said "Your session
          // expired". A mistyped current password threw the person to the
          // sign-in screen. The export route already speaks this way.
          return res.status(401).json({ error: 'Current password is incorrect', reauthRequired: 'password' });
        }
        proofFailures.clear(user.id);
      } else if (new_password) {
        return res.status(400).json({ error: 'This account signs in with Google or Apple and has no password.' });
      }

      // Check email uniqueness if changing email
      const changingEmail = Boolean(email) && normalizedAddress(email) !== normalizedAddress(user.email);
      if (changingEmail) {
        // The same block all three account-creation paths in routes/auth.js
        // apply. Without it a throwaway address that signup refused was one
        // profile save away: create the account on an address you keep, then
        // move it to the disposable one here. Applied only to a CHANGE
        // (adversarial audit round 2, 2026-09-05): the form sends the current
        // address on every save, so a rule at the validator refused every
        // name, bio and phone edit on an account whose domain joined the list
        // after it signed up, and there was no address such a person could
        // type to get their own account back.
        if (isDisposableEmail(email)) {
          return res.status(400).json({ error: 'Temporary email addresses cannot be used. Use an address you keep.' });
        }
        // PERMANENT EMAIL SQUAT (round 13). Nothing here ever verified that the
        // caller owns the address they are moving to, and an OAuth row needs no
        // password to reach this handler at all. So: sign in with your own
        // Google account, set email = victim@gmail.com, and the victim can
        // never join Flock — Google 409s, Apple 409s, password signup says
        // "already registered". The round-8 claim logic in routes/auth.js
        // deliberately refuses to claim a row that already carries an
        // oauth_provider, so that squat is the exact case it cannot break, and
        // no admin route exists to undo it.
        //
        // On an OAuth row the PROVIDER owns the address: the row's email is the
        // one Google/Apple verified, and it is the linkage users see. Refuse to
        // change it. (Password rows keep the edit — it is gated on the current
        // password above, and a password row CAN still be claimed back by the
        // address's verified owner through the OAuth claim path.)
        if (user.oauth_provider) {
          return res.status(400).json({
            error: 'This account signs in with Google or Apple, so its email is managed by that provider and cannot be changed here.',
          });
        }
        // Belt (round 19): every branch below assumes this request proved
        // possession, and for a password row it did — the bcrypt compare above
        // refuses the whole handler otherwise. An OAuth row is refused outright
        // just above. That leaves a row with NEITHER, which no path in the app
        // is supposed to produce; if one ever appears (a drifted row, a future
        // provider unlink), changing the account's identifying address would be
        // the one identity-defining edit in this file reachable on a bearer
        // token alone. Require the same recent sign-in the phone branch does.
        if (!user.password && !hasFreshSession(req)) {
          return res.status(401).json({
            error: 'For your security, sign in again before changing your email address.',
            reauthRequired: 'reauth',
          });
        }

        // Metered BEFORE the uniqueness probe, the same way the phone branch
        // meters before its own — the refusal below IS the oracle's answer, so
        // counting only the attempts that get past it would meter everything
        // except the thing worth metering. See emailChangeAttempts above.
        if (emailChangeAttempts.lockedFor(req.user.id) > 0) {
          return res.status(429).json({ error: TOO_MANY_EMAIL_CHANGES_MESSAGE });
        }
        emailChangeAttempts.record(req.user.id);

        // SHADOW ACCOUNT (round 18 re-audit). This was a plain LOWER() match
        // while every lookup in routes/auth.js compares in the CANONICAL
        // alphabet, and the two sides of that comparison are written in
        // different ones: the submitted address has been through
        // normalizeEmail() (Gmail dots and +subaddresses stripped) while an
        // OAuth row stores the provider's address verbatim, dots and all. So a
        // victim signed in with Google as `john.doe@gmail.com`, an attacker
        // moved their own row onto `johndoe@gmail.com`, LOWER() saw no clash,
        // the users.email UNIQUE index saw a different string, and two rows
        // owned one mailbox. That is precisely the hole canonicalEmail() was
        // written for; this route was the one door still open to it.
        //
        // The expression comes from routes/auth.js so the two cannot drift.
        // Required lazily for the same reason that file requires this one
        // lazily: neither module should be pulled in at the other's load time.
        // AND binds tighter than OR, so this reads `(exact AND other) OR
        // (canonical AND other)` — both halves exclude the caller's own row.
        const { canonicalEmail, EMAIL_CANONICAL_SQL } = require('./auth');
        const emailCheck = await pool.query(
          `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2
              OR ${EMAIL_CANONICAL_SQL} = $3 AND id != $2`,
          [email, req.user.id, canonicalEmail(email)]
        );
        if (emailCheck.rows.length > 0) {
          return res.status(400).json({ error: 'Email is already in use' });
        }

        // ROUND 19 (re-audit): the same gap MEDIUM 3 closed for phone, left open
        // for email. banned_identities.email_hash is consulted on the three
        // ACCOUNT CREATION paths in routes/auth.js and nowhere else, so a banned
        // user who deleted their account could sign up on a throwaway address
        // (allowed — nothing about it is tombstoned) and then MOVE that fresh row
        // onto their tombstoned address here, which is the address their friends,
        // their invites and their reputation are attached to. Every other gate on
        // this branch waves it through: the address is free (the banned row was
        // deleted), the row has no oauth_provider, and the current-password proof
        // is their own. Consult the tombstone where the address is actually
        // claimed, not only where a row is created.
        //
        // Placed AFTER the uniqueness check on purpose. It adds no oracle that
        // does not already exist — POST /api/auth/signup answers "is this address
        // tombstoned?" with a 403 for free — and putting it last keeps the
        // cheapest answer on this route the one it already gave.
        //
        // No poison-pill risk in the other direction: a tombstoned address is
        // already refused to everyone at signup, so refusing it here denies
        // nothing that was still available.
        if (await rejectIfBannedIdentity(res, { email })) return;
      }

      // PHONE NUMBER CLAIMS (round 16). phone is not a cosmetic profile field:
      // POST /api/friends/find-by-phone resolves contact-sync lookups against
      // it, so whoever holds a number receives the friend requests meant for
      // it. Nothing here verified ownership (no SMS verification exists yet)
      // and nothing even checked the number was free, so an attacker could type
      // a victim's number into their own profile and start collecting the
      // victim's contact-sync hits. Two guards, in the order they matter:
      //
      //   1. Same proof as changing a password. Password accounts already
      //      cleared that bar above (this handler refuses every edit without
      //      the current password). OAuth accounts have no password, so a
      //      stolen token could rewrite the number silently — they must show a
      //      session minted by a provider sign-in in the last few minutes.
      //   2. One account per number. Not ownership proof, but it stops the
      //      claim from ever pointing two rows at one number, which is the
      //      state the lookup cannot disambiguate.
      //
      // Comparison is on the last 10 digits, matching find-by-phone, so
      // reformatting the same number is not treated as a change and costs the
      // user nothing.
      const clearPhone = req.body.phone === null && Boolean(user.phone);
      const changingPhone = Boolean(phone) && canonicalPhone(phone) !== canonicalPhone(user.phone);
      if (changingPhone) {
        // HIGH 2 (re-audit): "unverified accounts cannot accumulate" is the
        // whole point of email verification, but the UNVERIFIED_DENY backstop in
        // middleware/auth.js lists the payment, friends and flock routes and NOT
        // PUT /api/users/profile, and nothing mounts requireVerified here (the
        // deny list fails open for unlisted routes). Signup deliberately no
        // longer accepts a phone precisely to stop a squatter claiming a
        // victim's number, but this route reopened that hole: an unverified
        // account could PUT { phone: "<victim's number>" }, the uniqueness check
        // only blocks already-registered numbers, so an unregistered victim
        // number succeeds and contact-sync discovery then resolves it to the
        // attacker. Gate the phone change (only) on verification; the name edits
        // on this route stay open to unverified accounts, which is why this is a
        // branch-level check and not a coarse requireVerified on the route.
        // (current_password is NOT proof of phone ownership; a real fix needs
        // SMS possession, which is out of scope here.)
        //
        // Round 19: read BOTH copies of the flag, not just req.user's. req.user
        // is middleware/auth.js's projection of the row and this handler has
        // already re-read the whole row into `user`; a gate that consults only
        // the projection fails OPEN the day that SELECT stops carrying the
        // column, and it would fail open silently. `=== false` on each is the
        // convention claimDecision() uses for a NOT NULL column that was
        // grandfathered TRUE. `user` is also the fresher of the two reads, so a
        // row that lost its verification between the middleware's SELECT and
        // this one is caught in the right direction.
        if (user.email_verified === false || req.user.email_verified === false) {
          return res.status(403).json({ error: UNVERIFIED_MESSAGE, emailVerificationRequired: true });
        }

        // Proof first, THEN metering. Counting unproven attempts would let
        // anyone holding a stale token burn the real owner's quota and lock
        // them out of their own profile for an hour without ever getting past
        // this line.
        if (!user.password && !hasFreshSession(req)) {
          return res.status(401).json({
            error: 'For your security, sign in again before changing your phone number.',
            reauthRequired: 'reauth',
          });
        }

        // The 409 below is an existence oracle for "is this number registered
        // with Flock", and it must not be a cheaper one than contact sync,
        // which POST /api/friends/find-by-phone meters for exactly that reason.
        // Attempts count whether they end in a 409 or a successful change.
        if (phoneChangeAttempts.lockedFor(req.user.id) > 0) {
          return res.status(429).json({ error: 'You have changed your phone number several times already. Try again later.' });
        }
        phoneChangeAttempts.record(req.user.id);

        // MEDIUM 3 (re-audit): banned_identities.phone_hash is WRITTEN on the
        // deletion of a banned account but was never READ anywhere — every
        // rejectIfBannedIdentity call in routes/auth.js passes only email and
        // oauth identifiers, and the phone-set path never consulted the
        // tombstone. So a banned user could re-attach the same number under a
        // fresh email and regain contact-sync discovery. Consult it here, where
        // a phone is actually set, after the verification and re-auth gates so
        // the check runs against a number this account can genuinely hold, and
        // after metering so it is not a cheaper "is this number banned?" oracle.
        // The refusal message is the generic banned-identity one, which leaks
        // nothing about which identifier matched.
        if (await rejectIfBannedIdentity(res, { phone })) return;

        const digits = canonicalPhone(phone);
        if (digits) {
          const phoneCheck = await pool.query(
            `SELECT id FROM users
              WHERE id != $1 AND phone IS NOT NULL
                AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2
              LIMIT 1`,
            [req.user.id, digits]
          );
          if (phoneCheck.rows.length > 0) {
            return res.status(409).json({ error: 'That phone number is already linked to another Flock account.' });
          }
        }
      }

      // Hash new password if provided
      let hashedPassword = null;
      if (new_password) {
        hashedPassword = await bcrypt.hash(new_password, SALT_ROUNDS);
      }

      // A password change bumps token_version, which invalidates every JWT
      // already outstanding for this account (round 13 — that is the whole
      // point of changing a password you think someone else has). The caller's
      // own token dies with the rest, so we mint and return a replacement.
      //
      // AN EMAIL CHANGE UN-VERIFIES THE ROW (round 18 re-audit). Verification is
      // per-ADDRESS: email_verified means "this account proved it can read the
      // address it currently holds", and moving the address makes that claim
      // false. Leaving the flag set was a PERMANENT SQUAT on any address:
      // sign up, verify your own mailbox, then move the row onto victim@gmail
      // and stop. claimDecision() in routes/auth.js compares verified_email
      // against the provider's address, sees a row that proved a DIFFERENT
      // mailbox, and returns 'refuse' — so the victim's Google sign-in 409s,
      // their Apple sign-in 409s and password signup says "already registered",
      // for ever, with no admin route to undo it. Refusing to hand the row over
      // was the right call; leaving it holding the address was not.
      //
      // Un-verified, the same row decides as 'evict': the address's real owner
      // signs in with a provider-verified token, takes the address back, and the
      // squatter keeps their own data under a tombstone. It also stops a
      // moved-onto address being tombstoned on deletion (recordBannedIdentity
      // reads exactly these two columns) and puts the row back inside the
      // round-16 accumulation gate until it proves the NEW address.
      //
      // Written as CASE over $2 rather than a new parameter on purpose: $2 is
      // already `changingEmail ? email : null`, so the two columns move with the
      // address and only with the address, and the statement keeps its shape.
      //
      // THE DISCOVERY DIGEST MOVES WITH THE NUMBER, OR IT IS A LIE ($8/$9).
      // users.phone_hash is what POST /api/friends/find-by-phone matches on, so
      // leaving it behind on a number change would keep an opted-in user
      // findable by the number they just gave up (which may already belong to a
      // stranger) and unfindable by the one they actually hold. $8 is a marker
      // that is non-null only on a real change, so an untouched form rewrites
      // neither column, and it is a CASE over that marker for the same reason
      // the email pair above is: the columns move with the field and only with
      // the field.
      //
      // phone_discoverable ($10) FAILS CLOSED on a number this server cannot
      // canonicalise. No digest means no way to be found, so the flag must not
      // stay TRUE claiming otherwise. A number that DOES canonicalise keeps the
      // user's existing choice, because the consent was to being findable by
      // their number and it is the number that moved. NULL on every other edit,
      // so COALESCE leaves the stored choice alone.
      const nextPhoneHash = changingPhone ? phoneDiscoveryHash(phone) : null;
      const result = await pool.query(
        `UPDATE users
         SET name = COALESCE($1, name),
             email = COALESCE($2, email),
             email_verified = CASE WHEN $2::text IS NULL THEN email_verified ELSE FALSE END,
             verified_email = CASE WHEN $2::text IS NULL THEN verified_email ELSE NULL END,
             phone = COALESCE($3, phone),
             interests = COALESCE($4, interests),
             password = COALESCE($5, password),
             token_version = token_version + CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,
             bio = COALESCE($7, bio),
             phone_hash = CASE WHEN $8::text IS NULL THEN phone_hash ELSE $9::text END,
             phone_discoverable = COALESCE($10, phone_discoverable),
             updated_at = NOW()
         WHERE id = $6
         RETURNING id, email, name, phone, phone_discoverable, interests, role, profile_image_url, bio, email_verified, token_version, created_at, updated_at`,
        // Only write the email column on a real change, so an unchanged form
        // never silently rewrites a stored address into its normalized form.
        //
        // bio is $7, AFTER the id, out of textual order on purpose: several
        // fixture dispatchers outside this file read params[5] as the user id
        // on this statement, and re-numbering the id would silently hand every
        // one of them a bio string where they expect an id. A parameter's
        // number is a name, not a position in the SET list.
        //
        // $8/$9 are appended AFTER bio for the same reason bio sits after the
        // id: a parameter's number is a name here, and re-numbering would hand
        // every fixture dispatcher that reads params[5] as the user id
        // something else.
        [
          name || null, changingEmail ? email : null, phone || null, safeInterests,
          hashedPassword, req.user.id, bio || null,
          changingPhone ? 'phone-changed' : null,
          changingPhone ? nextPhoneHash : null,
          changingPhone ? Boolean(user.phone_discoverable) && Boolean(nextPhoneHash) : null,
        ]
      );

      // An explicit null clears the number, its digest and the discovery
      // switch together. COALESCE above reads a blank as "leave alone", so a
      // number could be added and never removed, and turning discovery off
      // erased only the digest. Its own statement, so the profile UPDATE's
      // text, which two fixtures interpret clause by clause, is unchanged.
      if (clearPhone) {
        await pool.query(
          'UPDATE users SET phone = NULL, phone_hash = NULL, phone_discoverable = FALSE, updated_at = NOW() WHERE id = $1',
          [req.user.id]
        );
        result.rows[0].phone = null;
        result.rows[0].phone_discoverable = false;
      }

      // A password change bumps token_version, which stops the thief's REST
      // calls, but a WebSocket authenticates once at the handshake and then
      // lives indefinitely in user:{id}, where every DM, flock message and
      // location update is delivered. Without this the person you changed your
      // password to evict keeps reading your traffic in real time.
      if (hashedPassword) {
        revokeUserSessions(req.app.get('io'), req.user.id);
        // And retire any outstanding reset link. Changing the password in
        // Settings is the other way somebody answers "I think my password is
        // known", and a live link in their inbox overwrites the new password
        // and re-revokes every session for the rest of its hour.
        // Not awaited into the response: the password is already changed and
        // the sessions are already gone, so a failure here must not report the
        // change itself as failed.
        pool.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [req.user.id])
          .catch((e) => console.error(`[users] reset link retirement failed for user ${req.user.id}:`, e.message));
      }

      const { token_version: _tv, ...safeUser } = result.rows[0];
      res.json({
        user: safeUser,
        ...(hashedPassword ? { token: signUserToken(result.rows[0]) } : {}),
        // The address moved, so the row is unverified again and the round-16
        // gate is back on. Say so, or the next payment/friend/flock call is an
        // unexplained 403. POST /api/auth/resend-verification mails the link for
        // the new address.
        ...(changingEmail ? { emailVerificationRequired: true } : {}),
      });
    } catch (err) {
      console.error('Update profile error:', err);
      // The canonical-email unique index (migration 062): the address is a
      // dot or plus variant of one another account holds, and that account
      // arrived between the uniqueness read above and this write. Same
      // sentence the read gives when it is not raced.
      if (err.code === '23505') {
        return res.status(400).json({ error: 'Email is already in use' });
      }
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }
);

// ---------------------------------------------------------------------------
// PUT /api/users/phone-discovery - "let people who have my number find me"
// ---------------------------------------------------------------------------
// The consent switch behind POST /api/friends/find-by-phone. Two reasons this
// is its own route rather than another field on PUT /api/users/profile:
//
//   1. That route demands the current password (or a fresh provider session)
//      for EVERY edit, because it can move the address and the number. This is
//      a settings toggle. Making a user retype their password to stop being
//      findable would mean the fastest way out is the one with a hurdle in
//      front of it, and the direction that needs to be effortless is OFF.
//
//   2. Turning this ON is the moment users.phone_hash is written, and turning
//      it OFF is the moment it is erased. Keeping that in one small statement
//      is what makes "the database holds a phone digest only for people who
//      asked to be findable by phone" a fact you can read rather than a claim.
//
// NO PROBE BUDGET, deliberately, and the reason is the test from
// utils/cacheKeyInventory.js: this route reads and writes the CALLER'S OWN row
// and answers nothing about anybody else, so there is no directory information
// in it to ration. The general limiter covers the write cost.
router.put('/phone-discovery',
  scalarOnly(body('enabled'), 'enabled').isBoolean().withMessage('enabled must be true or false'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      // isBoolean() accepts the strings 'true'/'false' as well as the literals,
      // so normalise rather than trusting the type that arrived.
      const enabled = req.body.enabled === true || req.body.enabled === 'true';

      const current = await pool.query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
      if (current.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      const phone = current.rows[0].phone;

      if (!enabled) {
        // OFF erases the digest as well as clearing the flag. Keeping a digest
        // for somebody who has opted out would leave the one piece of data this
        // feature exists to use sitting in the row of a person who said no.
        await pool.query(
          'UPDATE users SET phone_discoverable = FALSE, phone_hash = NULL, phone_discoverable_at = NULL, updated_at = NOW() WHERE id = $1',
          [req.user.id]
        );
        return res.json({ phone_discoverable: false, phone_on_file: Boolean(phone) });
      }

      // ON needs a number that resolves to one whole E.164 string. A row with no
      // phone, or with something in the column that cannot be canonicalised,
      // gets an explanation rather than a switch that flips and does nothing.
      const hash = phoneDiscoveryHash(phone);
      if (!hash) {
        return res.status(400).json({
          error: phone
            ? 'Add your phone number in a form we can read before turning this on.'
            : 'Add your phone number to your profile before turning this on.',
          phone_discoverable: false,
          phone_on_file: Boolean(phone),
        });
      }

      await pool.query(
        `UPDATE users
            SET phone_discoverable = TRUE, phone_hash = $2, phone_discoverable_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [req.user.id, hash]
      );
      res.json({ phone_discoverable: true, phone_on_file: true });
    } catch (err) {
      console.error('Phone discovery toggle error:', err);
      res.status(500).json({ error: 'Failed to update phone discovery' });
    }
  }
);

// GET /api/users/stats - Get user's real stats (friends, XP, streak)
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;

    // Friend count
    const friendResult = await pool.query(
      `SELECT COUNT(*) FROM friendships WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
      [userId]
    );
    const friendCount = parseInt(friendResult.rows[0].count);

    // Flock count
    const flockResult = await pool.query(
      `SELECT COUNT(*) FROM flock_members WHERE user_id = $1 AND status = 'accepted'`,
      [userId]
    );
    const flockCount = parseInt(flockResult.rows[0].count);

    // Messages sent (flock + DM)
    const flockMsgResult = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE sender_id = $1`,
      [userId]
    );
    const dmMsgResult = await pool.query(
      `SELECT COUNT(*) FROM direct_messages WHERE sender_id = $1`,
      [userId]
    );
    const messageCount = parseInt(flockMsgResult.rows[0].count) + parseInt(dmMsgResult.rows[0].count);

    // Flocks created
    const createdResult = await pool.query(
      `SELECT COUNT(*) FROM flocks WHERE creator_id = $1`,
      [userId]
    );
    const flocksCreated = parseInt(createdResult.rows[0].count);

    // Calculate XP: 50 per flock created, 20 per flock joined, 5 per message, 10 per friend
    const xp = (flocksCreated * 50) + (Math.max(0, flockCount - flocksCreated) * 20) + (messageCount * 5) + (friendCount * 10);
    const level = Math.floor(xp / 100) + 1;

    // Streak: count consecutive days with activity (messages or flock joins) going back from today
    const activityResult = await pool.query(
      `SELECT DISTINCT DATE(created_at AT TIME ZONE 'UTC') AS d FROM (
        SELECT created_at FROM messages WHERE sender_id = $1
        UNION ALL
        SELECT created_at FROM direct_messages WHERE sender_id = $1
        UNION ALL
        SELECT joined_at AS created_at FROM flock_members WHERE user_id = $1
      ) AS activity ORDER BY d DESC LIMIT 60`,
      [userId]
    );
    let streak = 0;
    if (activityResult.rows.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dates = activityResult.rows.map(r => {
        const d = new Date(r.d);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      });
      // Check if today or yesterday has activity, then count back
      const dayMs = 86400000;
      let checkDate = today.getTime();
      if (!dates.includes(checkDate)) {
        checkDate -= dayMs; // allow yesterday as start
      }
      while (dates.includes(checkDate)) {
        streak++;
        checkDate -= dayMs;
      }
    }

    // Reliability score
    const reliabilityResult = await pool.query(
      'SELECT reliability_score, total_plans_joined, total_plans_attended FROM users WHERE id = $1',
      [userId]
    );
    const rel = reliabilityResult.rows[0] || {};

    res.json({
      friendCount, flockCount, flocksCreated, messageCount, xp, level, streak,
      reliabilityScore: rel.reliability_score ? parseFloat(rel.reliability_score) : null,
      totalPlansJoined: rel.total_plans_joined || 0,
      totalPlansAttended: rel.total_plans_attended || 0,
    });
  } catch (err) {
    console.error('Get user stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// GET /api/users/search?q= - Search users by name only (no email exposure)
router.get('/search',
  // `?q[]=a&q[]=b` is an array to express and satisfies isLength by coercion.
  // `String(req.query.q)` below already flattened it to "a,b" so it never
  // reached pg structured — but a search term that silently means something
  // other than what was typed is worth refusing rather than guessing at.
  // The MAXIMUM is the half this was missing. `q` had a floor and no ceiling, so
  // the largest search term the API accepted was whatever express.json() and the
  // URL length allowed, and every character of it was paid for twice: once
  // escaping it into the LIKE pattern and once by Postgres scanning `name ILIKE
  // '%…%'` across the users table. MAX_SEARCH_QUERY is users.name's own width,
  // which is also the point past which a substring match is arithmetically
  // impossible.
  scalarOnly(query('q'), 'search query').trim()
    .isLength({ min: 1 }).withMessage('Search query is required')
    .isLength({ max: MAX_SEARCH_QUERY }).withMessage('Search query is too long'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      // ---------------------------------------------------------------------
      // NORMALISE BEFORE CHARGING, because a term that cannot match is not a
      // probe and should not cost the caller a unit or the database a scan.
      //
      // Three spellings of the same question were three different searches:
      //
      //   * NFKC folds compatibility variants. An iOS keyboard set to a
      //     full-width layout types "Ｊａｙｄｅｎ", which is a different string
      //     from "Jayden" at every byte and matched nobody.
      //   * \s+ collapses whitespace RUNS. "John  Smith" pasted out of a
      //     message, or a "John Smith" carrying the U+00A0 non-breaking space an
      //     iOS autocorrect inserts, both failed against a stored "John Smith"
      //     while looking identical on screen.
      //   * trim() again afterwards, because the validator's trim ran before
      //     NFKC and NFKC can produce a leading or trailing space of its own
      //     (U+2000 and friends fold to U+0020).
      //
      // Case needs nothing here: the match is ILIKE and the ranking below uses
      // lower(), so "jayden", "Jayden" and "JAYDEN" were already one search.
      // Diacritics are NOT folded and this is the one thing left undone: "Jose"
      // does not find "José". Folding it properly wants the `unaccent`
      // extension, which this database does not have (no migration issues a
      // CREATE EXTENSION), and folding it in SQL with translate() puts a
      // per-row function call on the one query in this backend that already
      // scans every row. That is a schema decision, not a copy fix.
      const term = String(req.query.q).normalize('NFKC').replace(/\s+/g, ' ').trim();
      // Only reachable when normalisation emptied a string the validator had
      // already accepted. Same body as "nobody matched", which is what it is.
      if (!term) return res.json({ users: [] });

      // R4-I1. Charged per request, hit or miss, BEFORE the query — and unlike
      // /card this route returns early rather than querying anyway.
      //
      // THAT DIVERGENCE IS DELIBERATE AND IT IS THE WHOLE POINT HERE. /card's
      // lookup is a primary-key seek, so running it unconditionally costs
      // almost nothing and buys timing parity between an exhausted budget and a
      // genuine miss. This route's query is the only leading-wildcard
      // `ILIKE '%…%'` in the backend: no index can serve it, so every call is a
      // sequential scan of `users` on the 20-connection primary pool. Running
      // it anyway would preserve the timing parity and leave the load
      // amplification — which is half of what the budget is for — completely
      // untouched. The expensive query IS the metered resource, so the meter
      // has to sit in front of it.
      //
      // What that trades away is small and already spent: the only thing the
      // timing difference separates is "my own budget is exhausted" from "no
      // rows matched", and an attacker who exhausted the budget did so by
      // counting their own requests. That is the same bit the /card analysis
      // concluded exhaust-then-observe already yields.
      //
      // THE REFUSAL MUST NOT BECOME A NEW ORACLE, which is the rule /card
      // established and the reason this returns 200 `{users: []}` rather than a
      // 429: an empty result set is a completely ordinary answer here (most
      // substrings match nobody), so the refusal is shaped exactly like the
      // most common success. A 429 would instead confirm that the request
      // reached the budget, and would hand an enumerator a free signal for
      // pacing their walk to stay just under the ceiling.
      if (!searchProbeBudget.allow(req.user.id)) {
        return res.json({ users: [] });
      }

      // ILIKE wildcards have to be escaped, not interpolated. `q=%` built the
      // pattern '%%%', which matches every row: 20 arbitrary accounts (id,
      // name, avatar) per request, and patterns like `a%` / `_` let a caller
      // walk the whole user directory a slice at a time. Escaping turns the
      // query back into a literal substring search.
      const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
      const searchTerm = `%${escaped}%`;
      const prefixTerm = `${escaped}%`;

      // Mutual invisibility: blocked pairs never rediscover each other here.
      //
      // Banned accounts are withheld for the reason find-by-phone states in its
      // own header: a banned account is not somebody to hand anyone. The ban was
      // enforced at the door, on sign-in, and nowhere on the surfaces that hand
      // one account to another, so a removed account kept being offered by name
      // with a face next to it. A friend request to it is accepted and then
      // waits forever against an account that can never sign in again. On a
      // product whose floor is 13, that is the ban failing to reach the one
      // place a stranger reaches a child.
      //
      // It is folded into the same row filter as the block, deliberately, so a
      // banned account is byte-identical to a name nobody has rather than a
      // distinguishable refusal. It also still costs a probe unit above, so
      // withholding cannot be counted for free.
      // ---------------------------------------------------------------------
      // TWENTY MATCHES IN NO PARTICULAR ORDER IS NOT A SEARCH RESULT.
      // ---------------------------------------------------------------------
      // This was `LIMIT 20` with no ORDER BY, so the twenty rows were whatever
      // the sequential scan happened to reach first, which is physical row
      // order and therefore roughly signup order. Typing a friend's EXACT name
      // could return twenty other people and not them: "ann" matched Anna,
      // Joanna, Roseanne and Ann, and Ann is the one the person was looking
      // for. On a search box whose whole job is "find the person I already
      // know", that is the failure that matters.
      //
      // Three buckets, most specific first: the whole name, then a name that
      // STARTS with what was typed, then a name that merely contains it. Inside
      // a bucket the shorter name wins, because a shorter name containing the
      // term is a closer match to it, and then name and id, so the order is
      // total and the same query twice gives the same twenty rows.
      //
      // COST. `name ILIKE '%…%'` is unindexable, so this query already reads
      // every row in `users` to evaluate its predicate. What the ORDER BY costs
      // on top is that Postgres can no longer stop early once it has found
      // twenty matches, plus a top-N heapsort over the matches. That is paid
      // only by broad terms, it is bounded by searchProbeBudget above (90/hour
      // per account), and it buys the difference between a search box that
      // works and one that does not. If `users` ever grows to where this hurts,
      // the answer is a trigram index (pg_trgm), not going back to a random
      // twenty.
      //
      // `lower(name) = lower($3)` rather than `name ILIKE $3`: $3 is the raw
      // typed term, and ILIKE would read a `%` in it as a wildcard. Equality on
      // lower() has no pattern semantics, so it needs no escaping and cannot be
      // turned into a match-everything by what somebody types.
      const result = await pool.query(
        `SELECT id, name, profile_image_url
         FROM users
         WHERE name ILIKE $1 AND id != $2
           AND COALESCE(is_banned, FALSE) = FALSE
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = users.id)
                OR (b.blocker_id = users.id AND b.blocked_id = $2)
           )
         ORDER BY
           CASE
             WHEN lower(name) = lower($3) THEN 0
             WHEN name ILIKE $4 THEN 1
             ELSE 2
           END,
           length(name),
           name ASC,
           id ASC
         LIMIT 20`,
        [searchTerm, req.user.id, term, prefixTerm]
      );

      res.json({ users: result.rows });
    } catch (err) {
      console.error('Search users error:', err);
      res.status(500).json({ error: 'Failed to search users' });
    }
  }
);

// GET /api/users/suggested - Get suggested users (flock mates, ordered by shared flock count)
router.get('/suggested', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, COUNT(fm2.flock_id) AS shared_flocks
       FROM flock_members fm1
       JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != fm1.user_id AND fm2.status = 'accepted'
       JOIN users u ON u.id = fm2.user_id
       WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
         AND COALESCE(u.is_banned, FALSE) = FALSE
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
         )
       GROUP BY u.id, u.name, u.profile_image_url
       ORDER BY shared_flocks DESC, u.name ASC
       LIMIT 10`,
      [req.user.id]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Suggested users error:', err);
    res.status(500).json({ error: 'Failed to get suggested users' });
  }
});

// POST /api/users/upload-image - Upload profile image
router.post('/upload-image', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 5 MB.' });
      }
      console.error('[Upload] Error:', err.message);
      return res.status(400).json({ error: 'Upload failed. Please try a different image.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Verify file content matches an actual image (magic bytes)
    const format = detectImageFormat(req.file.buffer);
    if (!format) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    // Strip EXIF/XMP/IPTC before anything else touches these bytes. An avatar
    // is the image with the widest blast radius in the app, repeated on every
    // message row, every roster and every push. A photo straight off a phone
    // carries a GPS fix, the device serial on some bodies, and often a
    // full-size thumbnail of the UNCROPPED original. See utils/imageMetadata.js;
    // it returns the input unchanged if the container does not parse, so this
    // cannot be the reason an upload fails.
    //
    // Ahead of the size ceiling on purpose, in the direction that helps: the
    // metadata is real bytes, so a photo that was over the 600 KB limit only
    // because of a fat EXIF thumbnail now fits. Ahead of moderateImage for the
    // same reason the size check is: a smaller payload is a cheaper Vision
    // call, and stripping removes metadata segments only, never pixels, so the
    // screen sees the same picture either way.
    const imageBytes = stripImageMetadata(req.file.buffer);

    try {
      // Convert to base64 data URL and store in DB (survives Railway redeploys).
      //
      // Re-audit: the MIME in this data URL used to be `req.file.mimetype`,
      // which is a header the CLIENT writes, copied verbatim into a string that
      // is then stored forever and rendered as an <img src> on every message
      // row, roster and profile in the app. Two problems, one fix: the declared
      // type could disagree with the bytes we just verified (a GIF announced as
      // image/png), and the fileFilter above tests it with a SUBSTRING regex, so
      // values like `image/svg+xml;png` passed it and produced a malformed data
      // URL. The magic bytes already told us what this file is; use that answer
      // and nothing else.
      //
      // Belt: a format added to IMAGE_SIGNATURES without a matching entry here
      // would otherwise ship `data:undefined;base64,...` into every avatar slot
      // in the app, which renders as a broken image and is unfixable for the
      // user. The two tables must not be able to drift apart silently.
      const detectedMime = DETECTED_MIME[format];
      if (!detectedMime) {
        console.error(`[Upload] no MIME mapped for detected format "${format}"`);
        return res.status(400).json({ error: 'That image format is not supported.' });
      }
      const dataUrl = `data:${detectedMime};base64,${imageBytes.toString('base64')}`;

      // See MAX_AVATAR_DATA_URL_BYTES above for the ceiling and for how the
      // number this refusal quotes is derived from it. Ahead of moderateImage,
      // which is a BILLED Cloud Vision call: a refusal we can make for free
      // from a byte count must never be made after paying for one.
      if (Buffer.byteLength(dataUrl) > MAX_AVATAR_DATA_URL_BYTES) {
        return res.status(400).json({ error: AVATAR_TOO_LARGE_MESSAGE });
      }

      // Image moderation (A2b) — synchronous + FAIL-CLOSED. This is the only
      // upload endpoint, so screening here gates every user image before its
      // URL is returned or stored. Dev (no provider) allows with a warning;
      // prod requires a provider via IMAGE_MODERATION_REQUIRED=true.
      //
      // Round 18: this also covers ANIMATED avatars. Cloud Vision screens only
      // frame 1, so an animated GIF/APNG/WebP avatar could carry anything past
      // it — and an avatar is the one image that follows a user onto every
      // message row, every roster and every push. The fileFilter above still
      // accepts image/gif on purpose: a STILL GIF is fine, and a filter on
      // extension or MIME could not tell the two apart anyway (an APNG is
      // `image/png`). The frame count is decided from the bytes inside
      // moderateImage.
      const verdict = await moderateImage(dataUrl, { userId: req.user.id });
      if (!verdict.allowed) {
        return res.status(400).json({ error: imageRejectionMessage(verdict), moderation: verdict.reason });
      }

      await pool.query(
        'UPDATE users SET profile_image_url = $1, updated_at = NOW() WHERE id = $2',
        [dataUrl, req.user.id]
      );

      res.json({ profile_image_url: dataUrl });
    } catch (dbErr) {
      console.error('Upload image error:', dbErr);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });
});

// PUT /api/users/profile-image - Save an external avatar URL (e.g. DiceBear)
router.put('/profile-image',
  [
    // Shape first (round 20). `{"url": ["https://api.dicebear.com/x"]}`
    // satisfied isURL by coercion and stayed an array, and `new URL(value)`
    // stringifies its argument — so the host allowlist below passed too, and the
    // array went to pg as a parameter for users.profile_image_url (TEXT). A 500
    // on the one route in this file that writes the avatar every roster, message
    // row and push renders.
    // Width BEFORE isURL, and both halves of that order matter. profile_image_url
    // is TEXT, so an over-long URL is not a 22001 — it is simply stored, and then
    // repeated on every message row, roster entry and push payload this user
    // appears in, which is the same amplification MAX_AVATAR_DATA_URL_BYTES
    // exists to bound on the upload path. This route had no bound at all.
    // Checking the length first also keeps a 64KB string away from isURL's
    // regex work.
    scalarOnly(body('url'), 'URL').trim()
      .isLength({ max: MAX_AVATAR_URL }).withMessage('Avatar URL is too long')
      .isURL({ protocols: ['https'], require_protocol: true }).withMessage('Valid HTTPS URL required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { url } = req.body;

      // Only allow URLs from trusted avatar services
      const allowedHosts = ['api.dicebear.com'];
      let hostname;
      try { hostname = new URL(url).hostname; } catch { return res.status(400).json({ error: 'Invalid URL' }); }
      if (!allowedHosts.includes(hostname)) {
        return res.status(400).json({ error: 'Avatar URL must be from a trusted provider' });
      }

      await pool.query(
        'UPDATE users SET profile_image_url = $1, updated_at = NOW() WHERE id = $2',
        [url, req.user.id]
      );

      res.json({ profile_image_url: url });
    } catch (err) {
      console.error('Save avatar URL error:', err);
      res.status(500).json({ error: 'Failed to save avatar' });
    }
  }
);

// PUT /api/users/venmo-username — Update Venmo username
router.put('/venmo-username',
  [
    // SHAPE BEFORE CONTENT (round 20). A payment handle is the field that
    // decides who gets paid when a bill is split, and `{"venmo_username":
    // ["evil"]}` satisfied both isLength and matches() — express-validator
    // stringifies a one-element array before testing it — then stayed an array,
    // so `venmo_username.replace(/^@/, '')` below threw a TypeError and the
    // route answered 500. An empty array was worse in kind: `[]` is TRUTHY in
    // JavaScript, so it took the "clean it" branch instead of the "clear it"
    // branch and threw there too.
    scalarOnly(body('venmo_username').optional({ nullable: true }), 'Venmo username')
      .trim().isLength({ max: 50 }).withMessage('Venmo username too long')
      .matches(/^[a-zA-Z0-9_-]*$/).withMessage('Venmo username can only contain letters, numbers, hyphens, and underscores'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { venmo_username } = req.body;
      // Strip leading @ if provided
      const clean = venmo_username ? venmo_username.replace(/^@/, '') : null;

      await pool.query(
        'UPDATE users SET venmo_username = $1, updated_at = NOW() WHERE id = $2',
        [clean, req.user.id]
      );

      res.json({ venmo_username: clean });
    } catch (err) {
      console.error('Update venmo username error:', err);
      res.status(500).json({ error: 'Failed to update Venmo username' });
    }
  }
);

// PUT /api/users/payment-methods — Update all payment method handles
router.put('/payment-methods',
  [
    // Same guard as PUT /venmo-username above, on all three handles. The Zelle
    // field fails differently and no more happily: nothing calls .replace() on
    // it, so a one-element array sailed through the whole handler and reached
    // pg as a text[] parameter for zelle_identifier VARCHAR(255).
    scalarOnly(body('venmo_username').optional({ nullable: true }), 'Venmo username')
      .trim().isLength({ max: 50 })
      .withMessage('Venmo username too long')
      .matches(/^[a-zA-Z0-9_-]*$/).withMessage('Venmo username can only contain letters, numbers, hyphens, and underscores'),
    scalarOnly(body('cashapp_cashtag').optional({ nullable: true }), 'Cash App cashtag')
      .trim().isLength({ max: 50 })
      .withMessage('Cash App cashtag too long')
      .matches(/^[a-zA-Z0-9_]*$/).withMessage('Cashtag can only contain letters, numbers, and underscores'),
    // zelle_identifier is the only one of the three that is FREE TEXT — the other
    // two are constrained to [a-zA-Z0-9_-] by the rules above, so neither can
    // carry markup — and routes/billing.js hands it to OTHER flock members:
    // `Open your banking app and send $X to ${payer.zelle_identifier} via Zelle`
    // is rendered on their bill-split screen. So it is UGC on somebody else's
    // screen, and it went through no strip and no screen. freeText strips the
    // markup; the wordlist runs in the handler, on the stripped string.
    // 255 is unchanged and is users.zelle_identifier VARCHAR(255).
    freeText(body('zelle_identifier').optional({ nullable: true }), 'Zelle identifier')
      .isLength({ max: 255 })
      .withMessage('Zelle identifier too long')
      // A real Zelle identifier is an email address or a US phone number, and
      // this string is rendered on OTHER members' bill screens ("send $X to
      // <this> via Zelle" in routes/billing.js) — so a link stored here is a
      // phishing line delivered under the app's own voice. freeText already
      // stripped markup; this refuses the link shapes that survive stripping:
      // a scheme, a www. prefix, or any path separator. Deliberately a
      // NEGATIVE rule rather than an email-or-phone shape check, so no odd but
      // harmless identifier someone already stored becomes unsaveable.
      .custom((v) => {
        if (typeof v === 'string' && /[\/\\]|www\.|https?:/i.test(v)) {
          throw new Error('A Zelle identifier is an email address or phone number, not a link.');
        }
        return true;
      }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { venmo_username, cashapp_cashtag, zelle_identifier } = req.body;

      // See the note on the zelle_identifier rule above: this string is rendered
      // to other flock members by routes/billing.js. Screened AFTER freeText has
      // stripped it, so the wordlist reads the string that will be stored rather
      // than one with tags sitting between its letters. venmo_username and
      // cashapp_cashtag are not screened: their character class already rules out
      // markup, and they are handles a bank or Venmo assigned, which we cannot
      // ask the user to change.
      if (zelle_identifier && rejectIfProfane(res, zelle_identifier)) return;

      // Clean inputs — strip leading @ for venmo, $ for cashapp
      const cleanVenmo = venmo_username !== undefined
        ? (venmo_username ? venmo_username.replace(/^@/, '') : null)
        : undefined;
      const cleanCashapp = cashapp_cashtag !== undefined
        ? (cashapp_cashtag ? cashapp_cashtag.replace(/^\$/, '') : null)
        : undefined;
      const cleanZelle = zelle_identifier !== undefined
        ? (zelle_identifier || null)
        : undefined;

      // Build dynamic SET clause — only update fields that were sent
      const sets = [];
      const values = [];
      let paramIdx = 1;

      if (cleanVenmo !== undefined) {
        sets.push(`venmo_username = $${paramIdx++}`);
        values.push(cleanVenmo);
      }
      if (cleanCashapp !== undefined) {
        sets.push(`cashapp_cashtag = $${paramIdx++}`);
        values.push(cleanCashapp);
      }
      if (cleanZelle !== undefined) {
        sets.push(`zelle_identifier = $${paramIdx++}`);
        values.push(cleanZelle);
      }

      if (sets.length === 0) {
        return res.status(400).json({ error: 'No payment methods provided' });
      }

      sets.push('updated_at = NOW()');
      values.push(req.user.id);

      await pool.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${paramIdx}`,
        values
      );

      res.json({
        venmo_username: cleanVenmo !== undefined ? cleanVenmo : undefined,
        cashapp_cashtag: cleanCashapp !== undefined ? cleanCashapp : undefined,
        zelle_identifier: cleanZelle !== undefined ? cleanZelle : undefined,
      });
    } catch (err) {
      console.error('Update payment methods error:', err);
      res.status(500).json({ error: 'Failed to update payment methods' });
    }
  }
);

// GET /api/users/settings - Fetch user's synced app settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT settings FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ settings: result.rows[0]?.settings || {} });
  } catch (err) {
    console.error('Get user settings error:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PATCH /api/users/settings - Merge partial settings into stored JSONB
router.patch('/settings', async (req, res) => {
  try {
    // Bounded (round 7): a plain object only (arrays CONCATENATE under
    // jsonb ||), payload capped, and the MERGED result capped — otherwise one
    // account can grow a single row without limit.
    const partial = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (JSON.stringify(partial).length > 8192) {
      return res.status(400).json({ error: 'Settings payload too large' });
    }
    const current = await pool.query('SELECT settings FROM user_settings WHERE user_id = $1', [req.user.id]);
    const merged = { ...(current.rows[0]?.settings || {}), ...partial };
    const serialized = JSON.stringify(merged);
    if (serialized.length > 16384) {
      return res.status(400).json({ error: 'Settings storage limit reached' });
    }
    const result = await pool.query(
      `INSERT INTO user_settings (user_id, settings, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET settings = EXCLUDED.settings,
           updated_at = NOW()
       RETURNING settings`,
      [req.user.id, serialized]
    );
    res.json({ settings: result.rows[0].settings });
  } catch (err) {
    console.error('Update user settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/users/export — data portability (GDPR Art. 20, CCPA 1798.100/.130)
// ---------------------------------------------------------------------------
// Both laws grant a user a copy of their data in a "structured, commonly used
// and machine-readable format"; JSON is the canonical answer. Scope follows the
// EDPB reading of Art. 20: data the user PROVIDED (profile, interests, calendar,
// messages, budget amounts, trusted contacts, reports, settings) plus data
// OBSERVED about their use (check-ins, availability pulses, membership
// history). DERIVED data — reliability internals beyond what the app already
// shows them, ML predictions, moderation state — is not required and is not
// included.
//
// Art. 20(4): the export "shall not adversely affect the rights and freedoms of
// others". Every query below is keyed on the caller's own user id, so:
//   * flock messages: sender_id = caller. Other members' messages never appear.
//   * DMs: the caller's SENT half only. The other party's messages are the
//     other party's data; they can export their own half. read_status and
//     reply_to_id are omitted too — one describes the other party's behaviour,
//     the other points into their content.
//   * budget_submissions: the caller's own row only. The group ceiling and
//     everyone else's amounts stay behind the same >=3-submission privacy
//     threshold routes/budget.js enforces; this route never reads them.
//   * reports filed: the caller's own words (reason, details) and the report's
//     status. reported_user_id, content_id and handled_by are omitted — they
//     identify the reported person and the moderator.
//   * flock rows: name/venue/time only — shared context the member already
//     sees — never the roster, other RSVPs, or the flock's budget columns.
//   * venue reviews: the caller's rating and text. venue_reply and
//     venue_replied_at are the venue owner's words and behaviour, omitted.
//   * bill splits: the caller's own share, and the bill's total/tip only on
//     bills the caller paid (they typed those numbers). Other members' share
//     amounts never appear, on the same principle as budget_submissions.
//   * crowd reports (venue_feedback): the caller's own report. predicted_score
//     is the model's number at the time, i.e. DERIVED data — omitted.
//   * emoji reactions: the caller's emoji and when. The message ids they point
//     at are omitted for the same reason DM reply_to_id is: pointers into
//     content that may be somebody else's.
//   * friends: accepted friendships only — the durable friend list the caller
//     already sees in the app. Pending and declined rows are the OTHER
//     person's undecided or negative decision, and are not exported.
//   * SOS alerts (emergency_alerts): the caller's own stored coordinates —
//     the one location trail the privacy policy says the database holds.
//
// STRIPPED AT SOURCE: every SELECT names its columns and every object below is
// built from an explicit pick list, so password, apple_refresh_token,
// token_version, oauth_id and verifier hashes can never enter the payload. The
// stripSecretFields backstop in server.js also runs, but this route must be
// clean without it.
//
// SYNC, NOT A JOB, and the bound that makes that safe: the app has no scheduler
// and Railway's filesystem is ephemeral, so an async export would have to
// invent both a queue and a durable artifact store. It doesn't need to: every
// query is a single-user indexed lookup, rows are capped (EXPORT_MESSAGE_ROW_CAP
// per message table, EXPORT_ROW_CAP elsewhere — at most ~42k rows total), and
// inline data-URL images are replaced with a marker, so the worst-case response
// is a few tens of MB of text and the typical one is well under 1 MB. If real
// usage ever outgrows those caps, that is the moment to build the async job —
// not before.
//
// PROOF AND METERING, same shape as deleteAccount: an export is the single most
// valuable read in the API to someone holding a stolen 24h token, so a bearer
// token alone is not enough. Password accounts retype their password (sent in
// the X-Export-Password header — a GET cannot carry a body from a browser, and
// a query parameter would land in access logs); OAuth accounts need a session
// minted in the last REAUTH_WINDOW_MS. Wrong guesses land in the same
// proofFailures budget the deletion and profile proofs share, so this route
// adds no new password-guessing capacity. Proof runs BEFORE metering (a token
// thief must not burn the owner's quota), then exportRequests caps proven
// exports per account — nobody ports their data out five times an hour, and the
// cap bounds both the DB cost and how fast a fresh account-takeover can drain
// data before the owner notices.
// ---------------------------------------------------------------------------
// THE CLIENT EXISTS. This block said "THIS ROUTE HAS NO CLIENT. Nobody can
// call it" and listed what to build; all of it shipped and the note outlived
// the fact.
// ---------------------------------------------------------------------------
// `exportMyData` is in services/api.js and sends the proof as an
// `x-export-password` header; the control is "Get a copy of my data" on the
// You tab (screens/ProfileSettings.js), and services/dataExport.js hands the
// file over by share sheet, download or clipboard, saying which happened.
//
// The proof requirement is what keeps this unreachable by anyone but the
// owner: a password account must send its own password in a header and an
// OAuth account must hold a token minted in the last five minutes. Nobody can
// run an export on a user's behalf through this route.
//
// Still open, and a product decision: a BANNED account cannot export at all.
// `router.use(authenticate)` refuses a banned caller and only
// DELETE /api/users/me opts into authenticateAllowBanned, so a suspended user
// can destroy their account but cannot take a copy of it with them first.
// ---------------------------------------------------------------------------
const EXPORT_MESSAGE_ROW_CAP = 5000; // messages, direct_messages
const EXPORT_ROW_CAP = 2000;         // every other per-row section
const exportRequests = attemptLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
const TOO_MANY_EXPORTS_MESSAGE =
  'You have exported your data several times already. Try again later.';
// Names WHICH images, because the blanket version was not true. This note said
// "Inline image data is not included in the export", and the profile photo is
// inline image data that IS included: users.profile_image_url holds a base64
// data URL on every account that uploaded a photo rather than pointing at one
// (that is what MAX_AVATAR_DATA_URL_BYTES above bounds), and the profile
// section copies it out untouched. Keeping it is the right call, since it is
// the user's own photo and 600KB is the ceiling on it, so the note is what had
// to change. exportImage() is the marker, and it is applied to message and
// story images only.
const EXPORT_IMAGE_OMITTED_NOTE =
  'Images inside messages and stories, and your profile photo, are not included in this file. ' +
  'They are visible in the app.';
// Named in the privacy policy as the four things not in this file.
const EXPORT_OMISSIONS_NOTE =
  'Not in this file: the crowd predictions served to you, the accounts you have blocked, ' +
  "your device's push tokens, and any venue profile. Email social@flockcorp.com for those.";

// Fetches cap+1 and slices, so "exactly cap rows exist" and "the cap cut rows
// off" are distinguishable and the payload can say so honestly.
async function exportRows(text, params, cap) {
  const result = await pool.query(text, [...params, cap + 1]);
  const truncated = result.rows.length > cap;
  return { rows: truncated ? result.rows.slice(0, cap) : result.rows, truncated };
}

// Message images are stored as base64 data URLs (up to 600KB each), so leaving
// them inline would make the response size proportional to images sent, which
// is the one term the sync bound above cannot afford. External URLs pass
// through untouched.
function exportImage(url) {
  if (typeof url === 'string' && url.startsWith('data:')) {
    return { image_url: null, image_omitted: true };
  }
  return { image_url: url || null };
}

router.get('/export', async (req, res) => {
  try {
    const userId = req.user.id;

    const u = await pool.query(
      // phone_discoverable / phone_discoverable_at trail the list because they
      // arrived last (migration 051) and because the columns before them are
      // what the export test harness matches this SELECT on. They are here at
      // all because they are a CONSENT RECORD: a switch the user set and the
      // moment they set it. The privacy policy names four things this file
      // leaves out and says so on purpose; a fifth that nobody decided to
      // leave out is not honesty, it is drift, and the sweep in
      // __tests__/accountDeletionSurface.test.js now fails when a new users
      // column is neither exported nor named as a deliberate omission.
      //
      // phone_hash is NOT here and must not be. It is a keyed HMAC of the
      // number under a server secret, so it is not a copy of anything the user
      // gave us; the number itself is already exported as `phone`.
      `SELECT id, email, name, phone, interests, role, profile_image_url, bio,
              venmo_username, cashapp_cashtag, zelle_identifier, is_premium,
              oauth_provider, email_verified, terms_accepted_at, date_of_birth,
              reliability_score, total_plans_joined, total_plans_attended,
              created_at, updated_at, password,
              phone_discoverable, phone_discoverable_at
         FROM users WHERE id = $1`,
      [userId]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const account = u.rows[0];

    // Recent-possession proof — see the header comment and deleteAccount.
    if (account.password) {
      const header = req.headers['x-export-password'];
      const supplied = typeof header === 'string' ? header : '';
      if (supplied.length > MAX_PASSWORD) {
        return res.status(400).json({ error: 'Password is too long', reauthRequired: 'password' });
      }
      const lockedMs = proofFailures.lockedFor(userId);
      if (lockedMs > 0) return tooManyProofs(res, lockedMs, { reauthRequired: 'password' });
      const proven = supplied ? await bcrypt.compare(supplied, account.password) : false;
      if (!proven) {
        // An absent header is a client that has not prompted yet, not a guess.
        if (supplied) proofFailures.record(userId);
        return res.status(401).json({
          error: 'Enter your password to export your data.',
          reauthRequired: 'password',
        });
      }
      proofFailures.clear(userId);
    } else if (!hasFreshSession(req)) {
      return res.status(401).json({
        error: 'For your security, sign in again and then export your data.',
        reauthRequired: 'reauth',
      });
    }

    // Metered AFTER the proof, so an unproven token cannot burn the owner's
    // quota — the same ordering the phone-change branch documents.
    if (exportRequests.lockedFor(userId) > 0) {
      return res.status(429).json({ error: TOO_MANY_EXPORTS_MESSAGE });
    }
    exportRequests.record(userId);

    const flocks = await exportRows(
      `SELECT f.id AS flock_id, f.name, f.status AS flock_status, f.venue_name,
              f.venue_address, f.event_time, f.created_at,
              fm.status AS membership_status, fm.attendance, fm.joined_at,
              (f.creator_id = $1) AS is_creator
         FROM flock_members fm
         JOIN flocks f ON f.id = fm.flock_id
        WHERE fm.user_id = $1
        ORDER BY fm.joined_at ASC, f.id ASC
        LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const flockMessages = await exportRows(
      `SELECT id, flock_id, message_text, message_type, venue_data, image_url, created_at
         FROM messages WHERE sender_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_MESSAGE_ROW_CAP
    );

    const dmsSent = await exportRows(
      `SELECT id, receiver_id, message_text, message_type, venue_data, image_url, created_at
         FROM direct_messages WHERE sender_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_MESSAGE_ROW_CAP
    );

    const budgets = await exportRows(
      `SELECT flock_id, amount, skipped, submitted_at, updated_at
         FROM budget_submissions WHERE user_id = $1
        ORDER BY submitted_at ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const checkins = await exportRows(
      `SELECT venue_place_id, checkin_source, created_at
         FROM venue_checkins WHERE user_id = $1
        ORDER BY created_at ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const reports = await exportRows(
      `SELECT content_type, reason, details, status, created_at, resolved_at
         FROM content_reports WHERE reporter_id = $1
        ORDER BY created_at ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const contacts = await exportRows(
      `SELECT contact_name, contact_phone, contact_email, relationship, created_at
         FROM trusted_contacts WHERE user_id = $1
        ORDER BY created_at ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const calendar = await exportRows(
      `SELECT id, title, venue, event_date, time_label, color, created_at, updated_at
         FROM calendar_events WHERE user_id = $1
        ORDER BY event_date ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    // COMPLETENESS SWEEP 2026-08-14. The first cut of this export stopped at
    // the tables above, but the privacy policy's "What we collect" list is the
    // promise this file has to keep, and it also names venue votes, emoji
    // reactions, venue reviews, crowd reports, bill splits, and stored SOS
    // alerts — every one keyed to the account, every one absent from the first
    // cut. Each addition below follows the same two rules as the originals:
    // keyed on the caller's id, columns named explicitly, nothing that is
    // another person's data or a derived model output. Per-section scope notes
    // are in the header comment.
    const venueVotes = await exportRows(
      `SELECT flock_id, venue_name, venue_id, created_at
         FROM venue_votes WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const dmVenueVotes = await exportRows(
      `SELECT venue_name, venue_id, created_at
         FROM dm_venue_votes WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const reactions = await exportRows(
      `SELECT emoji, created_at
         FROM emoji_reactions WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const dmReactions = await exportRows(
      `SELECT emoji, created_at
         FROM dm_emoji_reactions WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const reviews = await exportRows(
      `SELECT google_place_id, rating, text, created_at
         FROM venue_reviews WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const crowdReports = await exportRows(
      `SELECT flock_id, venue_place_id, venue_name, crowd_level, price_worth,
              rating, day_of_week, hour, created_at
         FROM venue_feedback WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const billShares = await exportRows(
      `SELECT b.flock_id, s.amount AS your_share, s.committed, s.settled,
              s.settled_at, (b.paid_by = $1) AS you_paid,
              CASE WHEN b.paid_by = $1 THEN b.total_amount END AS total_amount,
              CASE WHEN b.paid_by = $1 THEN b.tip_percent END AS tip_percent,
              b.created_at
         FROM bill_split_shares s
         JOIN bill_splits b ON b.id = s.bill_id
        WHERE s.user_id = $1
        ORDER BY b.created_at ASC, s.id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const sosAlerts = await exportRows(
      `SELECT latitude, longitude, contacts_alerted, created_at
         FROM emergency_alerts WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    // No UI can create a story (server-only by decision), but the API can, so
    // any row that does exist is this user's content and belongs in their copy.
    const storyRows = await exportRows(
      `SELECT caption, image_url, created_at, expires_at
         FROM stories WHERE user_id = $1
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const friends = await exportRows(
      `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_user_id,
              CASE WHEN requester_id = $1 THEN 'sent' ELSE 'received' END AS request_direction,
              created_at
         FROM friendships
        WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [userId], EXPORT_ROW_CAP
    );

    const settingsRow = await pool.query(
      'SELECT settings, updated_at FROM user_settings WHERE user_id = $1',
      [userId]
    );

    const availabilityRow = await pool.query(
      'SELECT status, note, set_at, expires_at FROM availability_pulses WHERE user_id = $1',
      [userId]
    );

    const truncatedSections = [];
    const section = (name, r) => { if (r.truncated) truncatedSections.push(name); return r.rows; };

    const payload = {
      export_format: {
        version: 1,
        product: 'Flock',
        generated_at: new Date().toISOString(),
        // Honest about scope: what is absent and why, in the file itself, so
        // the copy the user keeps explains itself without our help.
        notes: [
          'This export contains the data you provided to Flock and activity recorded about your account.',
          'Messages other people sent (including their half of your DMs), other members\' budget amounts, group budget results, other members\' bill-split shares, and venue owners\' replies to your reviews are their data and are not included.',
          EXPORT_IMAGE_OMITTED_NOTE,
          EXPORT_OMISSIONS_NOTE,
        ],
      },
      profile: {
        id: account.id,
        email: account.email,
        name: account.name,
        phone: account.phone,
        interests: account.interests || [],
        role: account.role,
        // An uploaded avatar is a data: URL, and the client refuses to deliver a
        // file carrying image data (see services/dataExport.js). Copying it
        // untouched made every export fail for anyone with a photo, and each
        // try spent one of the five hourly slots. Same rule as message images.
        ...(typeof account.profile_image_url === 'string' && account.profile_image_url.startsWith('data:')
          ? { profile_image_url: null, profile_photo_omitted: true }
          : { profile_image_url: account.profile_image_url || null }),
        // bio is data the user typed about themselves — squarely inside the
        // "data you provided to Flock" promise this export keeps.
        bio: account.bio ?? null,
        venmo_username: account.venmo_username,
        cashapp_cashtag: account.cashapp_cashtag,
        zelle_identifier: account.zelle_identifier,
        is_premium: account.is_premium,
        sign_in_method: account.oauth_provider || 'password',
        email_verified: account.email_verified,
        terms_accepted_at: account.terms_accepted_at,
        date_of_birth: account.date_of_birth,
        reliability_score: account.reliability_score,
        total_plans_joined: account.total_plans_joined,
        total_plans_attended: account.total_plans_attended,
        // "Let friends find me by my phone number", and when it was switched
        // on. A consent and its timestamp are the user's own record of what
        // they agreed to, which is the first thing an export is for.
        phone_discoverable: account.phone_discoverable ?? false,
        phone_discoverable_at: account.phone_discoverable_at ?? null,
        created_at: account.created_at,
        updated_at: account.updated_at,
      },
      settings: settingsRow.rows[0]?.settings || {},
      availability: availabilityRow.rows[0] || null,
      calendar_events: section('calendar_events', calendar),
      flocks: section('flocks', flocks),
      flock_messages: section('flock_messages', flockMessages).map((m) => ({
        id: m.id,
        flock_id: m.flock_id,
        message_text: m.message_text,
        message_type: m.message_type,
        venue_data: m.venue_data,
        created_at: m.created_at,
        ...exportImage(m.image_url),
      })),
      direct_messages_sent: section('direct_messages_sent', dmsSent).map((m) => ({
        id: m.id,
        receiver_id: m.receiver_id,
        message_text: m.message_text,
        message_type: m.message_type,
        venue_data: m.venue_data,
        created_at: m.created_at,
        ...exportImage(m.image_url),
      })),
      budget_submissions: section('budget_submissions', budgets),
      venue_votes: section('venue_votes', venueVotes),
      dm_venue_votes: section('dm_venue_votes', dmVenueVotes),
      emoji_reactions: section('emoji_reactions', reactions),
      dm_emoji_reactions: section('dm_emoji_reactions', dmReactions),
      venue_reviews: section('venue_reviews', reviews),
      crowd_reports: section('crowd_reports', crowdReports),
      bill_splits: section('bill_splits', billShares),
      venue_checkins: section('venue_checkins', checkins),
      sos_alerts: section('sos_alerts', sosAlerts),
      stories: section('stories', storyRows).map((s) => ({
        caption: s.caption,
        created_at: s.created_at,
        expires_at: s.expires_at,
        ...exportImage(s.image_url),
      })),
      friends: section('friends', friends),
      reports_filed: section('reports_filed', reports),
      trusted_contacts: section('trusted_contacts', contacts),
      truncated_sections: truncatedSections,
    };

    // A file download, and a sensitive one: name it, and keep it out of every
    // cache on the path.
    res.setHeader('Content-Disposition', 'attachment; filename="flock-data-export.json"');
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  } catch (err) {
    console.error('Export data error:', err);
    res.status(500).json({ error: 'Failed to export your data' });
  }
});

// DELETE /api/users/me - Permanently delete the authenticated user's account.
// Hard-deletes the user row; ON DELETE CASCADE removes their flocks, memberships,
// messages, DMs, friendships, budgets, trusted contacts, device tokens, settings,
// etc. (a few FKs are ON DELETE SET NULL, which de-attribute content rather than
// delete it). Required for Apple Guideline 5.1.1(v) and Google Play's account-
// deletion policy. Irreversible.
//
// Registered at the TOP of this file against authenticateAllowBanned (function
// declaration, hoisted) so the banned-user exemption is a property of this one
// route rather than a string match every DELETE in the API could trip.
async function deleteAccount(req, res) {
  try {
    const u = await pool.query(
      // email_verified + verified_email are selected so recordBannedIdentity can
      // tell a PROVEN address from an unverified squat (HIGH 1 re-audit). They
      // trail the columns the test harness matches this SELECT on, so the
      // `apple_refresh_token, is_banned, banned_at` substring stays intact.
      `SELECT id, email, phone, password, oauth_provider, oauth_id, apple_refresh_token, is_banned, banned_at, email_verified, verified_email
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const account = u.rows[0];

    // RE-AUTHENTICATION (round 16). Before this, a bearer token was the whole
    // requirement, so a token lifted off a shared laptop or an unlocked phone —
    // good for up to 24h, with no way for the owner to revoke it before
    // /logout-all existed — could irreversibly destroy the account, cascade
    // away every flock the user created, and permanently revoke their Apple
    // grant. That is the most destructive call in the API and it was the
    // cheapest one to make.
    //
    // This runs BEFORE the Apple revocation below on purpose: an unproven
    // request must not be able to disconnect someone's Apple sign-in as a side
    // effect of being rejected.
    //
    // Deletion stays reachable, which Apple 5.1.1(v) requires. Password
    // accounts retype the password they already use to sign in; OAuth accounts
    // re-run Sign in with Apple / Google and call this again with the fresh
    // token. `reauthRequired` tells the client which prompt to show.
    if (account.password) {
      // The same ceiling PUT /profile puts on its two password fields, on the
      // one this route reads by hand. Refused rather than treated as absent: an
      // over-long value is a client bug, and answering it with the "enter your
      // password" prompt would send the user round the loop for ever.
      if (typeof req.body?.password === 'string' && req.body.password.length > MAX_PASSWORD) {
        return res.status(400).json({ error: 'Password is too long', reauthRequired: 'password' });
      }
      // Bounded (see proofFailures): without a ceiling this endpoint is an
      // offline-grade password guessing oracle for anyone holding a token, and
      // every guess costs a bcrypt round of server CPU.
      const lockedMs = proofFailures.lockedFor(account.id);
      if (lockedMs > 0) return tooManyProofs(res, lockedMs, { reauthRequired: 'password' });
      const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
      const proven = supplied ? await bcrypt.compare(supplied, account.password) : false;
      if (!proven) {
        // An absent password is the shipped client's current behaviour, not a
        // guess, so it must not burn an attempt and lock a user out of the
        // deletion flow before their client has even prompted them.
        if (supplied) proofFailures.record(account.id);
        return res.status(401).json({
          error: 'Enter your password to delete your account.',
          reauthRequired: 'password',
        });
      }
      proofFailures.clear(account.id);
    } else if (!hasFreshSession(req)) {
      return res.status(401).json({
        error: 'For your security, sign in again and then delete your account.',
        reauthRequired: 'reauth',
      });
    }

    // Apple 5.1.1(v): revoke Sign in with Apple tokens before deleting the row.
    // Round 5: when revocation is CONFIGURED and fails, abort — deleting the
    // row destroys the only stored refresh token, so a swallowed failure would
    // make revocation permanently impossible. Unconfigured env stays a no-op.
    let appleRevoked = false;
    if (u.rows[0].oauth_provider === 'apple' && u.rows[0].apple_refresh_token && appleAuthConfigured()) {
      let revoked = false;
      try { revoked = await revokeAppleToken(u.rows[0].apple_refresh_token); } catch (_) { revoked = false; }
      if (!revoked) {
        return res.status(503).json({ error: "We couldn't disconnect your Apple sign-in just now. Try again in a minute." });
      }
      appleRevoked = true;
    }

    // Moderation evidence survives the account (round 5): cascade deletes let
    // an abuser (or a reporter) erase open reports and completed action
    // history by deleting their account. De-attribute instead.
    //
    // Round 12: these were four separate autocommit statements, three of them
    // with `.catch(() => {})`. If a de-attribution UPDATE failed — lock
    // timeout, a drifted database where the column is still NOT NULL, anything
    // — the failure was swallowed and the hard DELETE ran anyway, so the
    // CASCADE erased exactly the evidence this code exists to preserve. The
    // live scenario is a banned abuser deleting their account. All four
    // statements plus the DELETE now share ONE transaction with no swallowed
    // errors: either the evidence is safely de-attributed and the account is
    // gone, or nothing happened and the caller gets a 503 to retry.
    //
    // PRESERVATION LIMIT (18 U.S.C. § 2258A(h) — see MODERATION-LEGAL.md).
    // What survives this transaction is the content_reports and
    // moderation_actions ROWS, de-attributed. The CONTENT does not: the DELETE
    // below removes every flock message the user authored, reported or not,
    // and the users CASCADE takes their stories and DMs with the row. So if
    // any of it is evidence behind a CyberTipline report, the one-year
    // preservation duty can NOT be met from these tables — the offender can
    // walk it all through this route with one authenticated request. That is
    // why MODERATION-LEGAL.md step 2 says export the evidence OUT of the
    // database the moment a child-safety report is judged real, before any
    // other action. Blocking deletion for flagged accounts would be the
    // stronger control, but it trades against the 5.1.1(v) deletion
    // requirement this route exists for and needs a product/legal decision,
    // not a drive-by edit here.

    // WHOSE PLANS THIS CANCELS, read before anything is deleted.
    //
    // flocks.creator_id is ON DELETE CASCADE, so deleting this account deletes
    // every flock it created and, with them, the chat, the RSVPs and the votes
    // of everyone else who was going. DELETE /api/flocks/:id has emitted
    // flock_deleted and pushed "Plan cancelled" since the day its own comment
    // was written ("the people who were not in the app when it happened turned
    // up at the bar"). This route cancelled the same plans and said nothing at
    // all, so a member sitting in the flock chat kept a screen for a plan that
    // no longer existed, and a member who was not in the app found out by
    // arriving.
    //
    // Two audiences, deliberately different:
    //   - the SOCKET event goes to the members of every flock that is being
    //     deleted, whatever its state, because it is a state reconciliation:
    //     it is what takes the row out of a list somebody is looking at.
    //   - the PUSH goes only to flocks that have not already happened. An
    //     account with a year of history would otherwise interrupt its friends
    //     with "Taco night is off" about a plan from March.
    //
    // WHAT "HAS NOT ALREADY HAPPENED" MEANS, and why it is not the status.
    // This asked `status NOT IN ('completed', 'cancelled')` on its own, which
    // sounds like the same question and is not. services/flockSweep.js is the
    // ONLY thing that moves a plan to 'completed' without the host pressing
    // something, and its WHERE clause is `status = 'confirmed' AND event_time
    // IS NOT NULL`. So two large families of plan are permanently open by
    // status and permanently past by the calendar: a plan that never got out
    // of 'planning', which is the status every flock is born in, and a
    // confirmed plan with no time on it. Taco night in March, never confirmed,
    // is 'planning' forever, and the status test called it upcoming and pushed
    // "Taco night is off" to everyone who was in it. That is the exact
    // interruption the paragraph above says this gate prevents.
    //
    // So the clock is asked as well, on the sweep's own terms: the same grace
    // window, so a plan the sweep would have closed is exactly a plan this
    // treats as past, and the two can never drift into disagreeing. A plan
    // with no event_time falls back to migration 028's floor, created_at + 14
    // days, for the reason 028 gives in writing: event_time is nullable, and
    // fourteen days is the planning horizon the product assumes, so a plan
    // still being arranged is never called finished while an untimed plan from
    // last spring is.
    //
    // Blocked members are dropped from the socket fan-out because the payload
    // names the person, which is the rule emitToFlockExcludingBlocked applies
    // on the flocks.js path. user_blocks CASCADEs away with the row, so this
    // has to be read now as well.
    const deleterName = req.user.name;
    let cancelledFlocks = [];
    let invisibleToDeleter = new Set();
    try {
      const owned = await pool.query(
        `SELECT f.id, f.name,
                (f.status NOT IN ('completed', 'cancelled')
                 AND COALESCE(f.event_time, f.created_at + INTERVAL '14 days')
                     > (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $2::int)) AS upcoming,
                COALESCE(
                  ARRAY_AGG(fm.user_id) FILTER (
                    WHERE fm.user_id IS NOT NULL AND fm.user_id <> $1 AND fm.status = 'accepted'
                  ), '{}'
                ) AS member_ids
           FROM flocks f
           LEFT JOIN flock_members fm ON fm.flock_id = f.id
          WHERE f.creator_id = $1
          GROUP BY f.id, f.name, f.status, f.event_time, f.created_at`,
        [req.user.id, flockGraceHours()]
      );
      cancelledFlocks = owned.rows.filter((r) => r.member_ids.length > 0);
      if (cancelledFlocks.length > 0) {
        invisibleToDeleter = new Set(await getInvisibleUserIds(req.user.id));
      }
    } catch (readErr) {
      // A notification that could not be prepared must never stop a deletion
      // Apple 5.1.1(v) requires to stay reachable. The plans still go; the
      // people in them are told nothing, which is what happened before this
      // block existed, and the log line is what makes that visible.
      console.error('Delete account: could not read the flocks this cancels:', readErr.message);
      cancelledFlocks = [];
    }

    const client = await pool.connect();
    let deleted;
    let tombstoned = false;
    // What the LOCKED read said, not the stale fetch at the top — the audit line
    // and the retention purge below both key off "was this account banned", and
    // after the re-read that answer is only correct inside the transaction.
    let wasBanned = account.is_banned;
    try {
      await client.query('BEGIN');

      await client.query('UPDATE content_reports SET reporter_id = NULL WHERE reporter_id = $1', [req.user.id]);
      await client.query('UPDATE content_reports SET reported_user_id = NULL WHERE reported_user_id = $1', [req.user.id]);
      await client.query('UPDATE moderation_actions SET target_user_id = NULL WHERE target_user_id = $1', [req.user.id]);

      // messages.sender_id is ON DELETE SET NULL (anonymize). Explicitly remove the
      // user's flock messages so no authored content is retained after deletion.
      await client.query('DELETE FROM messages WHERE sender_id = $1', [req.user.id]);

      // Round 16: a BAN has to outlive the account it was imposed on, or
      // deleting the account is a one-tap ban reset. Same transaction as the
      // evidence de-attribution above and for the same reason — the account
      // must never vanish while the record of why it was banned fails to land.
      // Nothing is written for accounts that were not banned.
      //
      // Round 19 (re-audit): decided on a row re-read INSIDE the transaction and
      // locked, not on the copy fetched at the top of this handler. Between the
      // two reads sit a bcrypt compare and, for an Apple account, a network call
      // to Apple's revocation endpoint — hundreds of milliseconds to seconds in
      // which a moderator's ban can commit. On the stale copy that ban is
      // invisible, so the account deletes clean and the tombstone is never
      // written: the ban is lost by losing a race, which is the same one-tap ban
      // reset this block exists to prevent, just harder to hit on purpose. FOR
      // UPDATE makes the ban and this decision serialize instead of interleave.
      // Deliberately the same statement text as the fetch above so it stays one
      // query to keep in step, and so the existing harnesses keep matching it.
      const locked = await client.query(
        `SELECT id, email, phone, password, oauth_provider, oauth_id, apple_refresh_token, is_banned, banned_at, email_verified, verified_email
           FROM users WHERE id = $1 FOR UPDATE`,
        [req.user.id]
      );
      // A missing row means it went away underneath us; the guarded DELETE below
      // is what turns that into a 404, so nothing is decided here.
      const banState = locked.rows[0] || account;
      wasBanned = Boolean(banState.is_banned);
      if (wasBanned) {
        tombstoned = await recordBannedIdentity(client, banState);
      }

      const result = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.user.id]);
      deleted = result.rows.length > 0;

      if (!deleted) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found' });
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Delete account: de-attribution failed, account NOT deleted:', txErr.message);
      // "Nothing was changed" is untrue for an Apple account: the revocation
      // above already ran, and it is the reason the sign-in has to happen
      // again before a retry can revoke a fresh token.
      return res.status(503).json({
        error: appleRevoked
          ? 'Your Apple sign-in was disconnected, but the account could not be deleted just now. Sign in with Apple again, then try once more.'
          : "We couldn't finish deleting your account just now. Nothing was changed. Please try again in a minute.",
      });
    } finally {
      client.release();
    }

    // Round 19 (re-audit): the row is gone, so every REST call 401s on the next
    // request — but a Socket.io connection authenticates ONCE at the handshake
    // and then lives on the TCP connection. Without this, a deleted account's
    // live socket stays subscribed to `user:{id}` and keeps emitting on the
    // rooms it already joined until the SESSION_RECHECK_MS sweep in
    // sockets/handlers.js gets to it, which is up to a minute of a deleted
    // account still being present in the product. Every other path in the app
    // that ends a session calls this (the OAuth claims, the squat eviction, the
    // password reset, /logout-all, the password change above); the one that ends
    // the ACCOUNT did not. A missing io is a documented no-op, so this can never
    // turn a completed deletion into an error — and it deliberately runs AFTER
    // the COMMIT, so a rolled-back deletion never disconnects anyone.
    const io = req.app.get('io');
    revokeUserSessions(io, req.user.id);

    // The socket half of the cancellation fan-out read above. After the COMMIT,
    // so a rolled-back deletion never tells anybody their plan is off, and with
    // the recipients passed in, because flock_members is already gone and the
    // helper's own comment says that is exactly what the argument is for.
    if (io && cancelledFlocks.length > 0) {
      for (const f of cancelledFlocks) {
        const recipients = f.member_ids.filter((id) => !invisibleToDeleter.has(id));
        if (recipients.length === 0) continue;
        await emitToFlockMembers(io, f.id, 'flock_deleted', {
          flockId: f.id, flockName: f.name, deletedBy: deleterName,
        }, recipients).catch((e) => console.error('flock_deleted fan-out failed:', e.message));
      }
    }

    // Says what actually happened: recordBannedIdentity can decline to write
    // (no usable identifier), and an audit line that claims a tombstone exists
    // when none does is worse than no line at all.
    console.log(`Account deleted: user ${req.user.id}${wasBanned ? (tombstoned ? ' (banned, tombstoned)' : ' (banned, NOT tombstoned)') : ''} at ${new Date().toISOString()}`);

    // Housekeeping. Outside the transaction, rate limited to once an hour per
    // process, and fully swallowed: a failed purge is a tidiness problem and
    // must never turn into a failed account deletion.
    if (wasBanned) maybePurgeExpired();

    res.json({ message: 'Account deleted' });

    // The push half. Post-response and in its own try/catch, like every push in
    // routes/flocks.js, and only for plans that have not already happened.
    //
    // NO flockId in the payload, for the reason the flocks.js cancellation push
    // records: the row is gone, so pushHelper's visibility gate would find no
    // flock and suppress every send, and there is no screen left to open.
    // Nobody is named either, so this needs no block gate.
    if (isPushConfigured()) {
      const upcoming = cancelledFlocks.filter((f) => f.upcoming);
      if (upcoming.length > 0) {
        try {
          await Promise.allSettled(upcoming.flatMap((f) =>
            f.member_ids.map((userId) => pushIfOffline(io, userId,
              'Plan cancelled',
              `${f.name || 'A plan'} is off.`,
              { type: 'flock_cancelled' }
            ))
          ));
        } catch (pushErr) {
          console.error('Delete account cancellation push error:', pushErr.message);
        }
      }
    }
  } catch (err) {
    console.error('Delete account error:', err);
    // headersSent, because work now continues AFTER the 200: the cancellation
    // push below res.json. Without the guard a throw out there would try to
    // send a 500 on a response that already said "Account deleted", which
    // Express answers with ERR_HTTP_HEADERS_SENT and an unhandled error, not
    // with a second body. Same guard, same reason, as routes/flocks.js.
    if (!res.headersSent) res.status(500).json({ error: 'Failed to delete account' });
  }
}

module.exports = router;

// ---------------------------------------------------------------------------
// Exports for other routers and for backend/__tests__/banEvasion.test.js.
//
// HANDOFF (routes/auth.js owner): every account-creation path needs the
// tombstone lookup. One line per path, after validation and after the existing
// duplicate-email check:
//
//   if (await rejectIfBannedIdentity(res, { email, phone })) return;                     // /signup
//   if (await rejectIfBannedIdentity(res, { email, oauthProvider: 'google', oauthId: googleId })) return;  // /google, new-user branch
//   if (await rejectIfBannedIdentity(res, { email, oauthProvider: 'apple', oauthId: appleId })) return;    // /apple, new-user branch
//
// with `const { rejectIfBannedIdentity } = require('./users');` at the top.
// There is no require cycle: routes/users.js does not require routes/auth.js.
// ---------------------------------------------------------------------------
module.exports.isIdentityBanned = isIdentityBanned;
module.exports.rejectIfBannedIdentity = rejectIfBannedIdentity;
module.exports.purgeExpiredBannedIdentities = purgeExpiredBannedIdentities;
module.exports.__testing = {
  cardProbeBudget,
  // Test hook only. The budget above is process-wide in-memory state, so a
  // suite needs a way to start each case from a clean allowance. Nothing in the
  // running server calls this.
  resetCardProbeBudget: () => cardProbeBudget.reset(),
  // R4-I1. Same seam, same reason: the search budget is process-wide in-memory
  // state, so a suite needs a clean allowance per case.
  searchProbeBudget,
  resetSearchProbeBudget: () => searchProbeBudget.reset(),
  detectImageFormat,
  // Round 26. The upload middleware itself, so a test can drive a real
  // multipart body through it: `limits` is the only thing standing between one
  // connection and the container's whole heap, and defaults that were never
  // named are exactly what this pins.
  upload,
  DETECTED_MIME,
  MAX_AVATAR_DATA_URL_BYTES,
  ADVERTISED_AVATAR_KB,
  AVATAR_TOO_LARGE_MESSAGE,
  advertisedPhotoKb,
  identityDigests,
  canonicalPhone,
  normalizedAddress,
  hasFreshSession,
  recordBannedIdentity,
  maybePurgeExpired,
  resetPurgeClock: () => { lastPurgeAt = 0; },
  proofFailures,
  phoneChangeAttempts,
  emailChangeAttempts,
  // A5-1 / A5-3. Exported so __tests__/usersBcryptAndProofEviction.test.js can
  // drive the throttle's memory guard directly and pin that a flood cannot
  // empty it, rather than reasoning about how many accounts exist.
  attemptLimiter,
  ATTEMPT_MAX_KEYS,
  ATTEMPT_LOW_WATER,
  SALT_ROUNDS,
  exportRequests,
  EXPORT_ROW_CAP,
  EXPORT_MESSAGE_ROW_CAP,
  REAUTH_WINDOW_MS,
  BAN_TOMBSTONE_RETENTION_DAYS,
  BANNED_IDENTITY_MESSAGE,
};
