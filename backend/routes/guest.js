const express = require('express');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { rejectIfProfane } = require('../utils/moderation');
const { guestEntryId } = require('../utils/guestRsvp');
// Shape before content — see validators/shape.js. This router is the only
// UNAUTHENTICATED write surface in the app and every value it takes is
// re-broadcast to the flock, so it is the one that could least afford the hole.
const { scalarOnly, freeText } = require('../validators/shape');
const { broadcastGuestRsvp, emitToFlockExcludingBlocked } = require('../sockets/handlers');
// The ONE authenticated route in this file (POST /:token/join). Everything else
// here is deliberately unauthenticated; that route is deliberately not.
const { authenticate, requireVerified } = require('../middleware/auth');
// The member-facing venue tally has one implementation and it lives with the
// member vote routes — see broadcastGuestVote there for why a guest vote is
// announced through it rather than emitted from here.
const { broadcastGuestVote } = require('./venues');
const { pushIfOffline } = require('../services/pushHelper');

const router = express.Router();

// ---------------------------------------------------------------------------
// Guest access (NO auth) — the cold-start growth mechanic. Someone invited to
// a flock can see the plan, RSVP, and vote from a link WITHOUT an account.
//
// Security model:
// - The link token is 24 chars of unbiased crypto randomness (~138 bits);
//   knowing a flock id gets you nothing, and links can be revoked by
//   re-generating. Tokens minted before the 2026-08-14 widening are 12 chars
//   (~69 bits) and stay valid — resolveLink is an exact match either way.
// - Guests see the PLAN only: flock name/date/time, host FIRST name, going
//   count, the ROSTER (first names + each person's answer, see the privacy
//   boundary on rosterFor below), and venue tallies. Never messages, budgets,
//   emails, phone numbers, user ids, photos or surnames.
// - ONE route here is authenticated: POST /:token/join. Holding the link is
//   how you find the flock; holding an ACCOUNT is how you get into its chat.
//   There is deliberately no unauthenticated write to messages anywhere in
//   this file, and there must never be one: a guest has no age gate, no
//   account and no ban to enforce, so guest posting would put unmoderated UGC
//   on the public surface (Apple Guideline 1.2).
// - Guests are identified by a server-issued UUID (guest_token) returned once
//   at RSVP time; votes require it. Clients never mint their own identity.
// - Every route is rate-limited by the mount in server.js.
// ---------------------------------------------------------------------------

// The alphabet stays look-alike-free (no 0/O/1/I/l) because these tokens get
// read aloud and retyped; log2(55) ≈ 5.78 bits per character.
const LINK_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // gitleaks:allow -- character set for token generation, not a credential
// 24 × log2(55) ≈ 138.8 bits. The floor is 128: this is the app's only
// unauthenticated door and the token is the entire credential. The previous
// generator minted 12 chars (~69 bits) — never walkable through the rate
// limiter, but far under that floor — and those legacy tokens still resolve.
const LINK_TOKEN_LENGTH = 24;
// Accept legacy 12-char tokens (min 8 predates this file) up to the widened
// column (VARCHAR(64), migration 022). One definition for all three routes.
const LINK_TOKEN_PARAM_MIN = 8;
const LINK_TOKEN_PARAM_MAX = 64;

const newLinkToken = () => {
  // Rejection sampling, because `byte % 55` on the full 0..255 range is
  // biased: 256 % 55 = 36, so the first 36 characters of the alphabet would
  // each be 25% more likely than the rest. 220 is the largest multiple of 55
  // that fits in a byte; anything above it is redrawn.
  const usable = 256 - (256 % LINK_TOKEN_ALPHABET.length); // 220
  let t = '';
  while (t.length < LINK_TOKEN_LENGTH) {
    for (const b of crypto.randomBytes(LINK_TOKEN_LENGTH)) {
      if (b >= usable) continue;
      t += LINK_TOKEN_ALPHABET[b % LINK_TOKEN_ALPHABET.length];
      if (t.length === LINK_TOKEN_LENGTH) break;
    }
  }
  return t;
};

// ---------------------------------------------------------------------------
// Round 15 — creating a NEW guest identity is the only unauthenticated INSERT
// in the app, and everything expensive hangs off it:
//
//   - Each new guest may cast one guest vote, and guest votes are NOT
//     display-only: routes/venues.js folds them into the member-facing venue
//     tally and routes/flocks.js counts them as voters. A typical flock has ~5
//     members, and the per-flock guest cap is 50, so anyone holding a share link
//     could mint 50 identities and outvote the actual group 10:1, deciding
//     where they go.
//   - Each new "in" answer pushes the host a notification.
//   - Each one consumes a slot in the 50-guest cap, and hidden rows
//     deliberately still count toward that cap (a takedown must not hand the
//     abuser a fresh slot). The consequence nobody costed: filling all 50 slots
//     with junk is a PERMANENT denial of service on that invite link that no
//     moderator action can reverse — real guests get 429 until the host revokes
//     the link and re-shares a new one.
//
// The general limiter (300/15min per IP) is nowhere near tight enough: 50
// identities is 50 requests. A single script did the whole thing in one burst.
// So new-identity creation gets its own budget, per IP, per flock. Editing an
// existing RSVP is untouched — that path is already gated on holding a
// server-issued UUID and cannot create anything.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Round 23 — one bounded counter, because the hand-rolled one was neither.
//
// The old newGuestLog maintenance was: "if the map holds more than 5000
// entries, delete the ones that have already EXPIRED". On a one-hour window
// that deletes nothing at all while a flood is in progress — every entry the
// flood just made is fresh — so:
//
//   * the map had no ceiling. Keys are `ip|flockId` and both halves come from
//     the request, so an unauthenticated caller rotating source addresses grew
//     it without bound; and
//   * past 5000 entries EVERY new-guest request paid a full O(n) scan of it
//     before doing anything else, so growing the map was also a way to make
//     each subsequent request more expensive. Measured at 40,000 keys the scan
//     alone dominated the route.
//
// Eviction order is LEAST CONSUMED first, never a clear(). That is the rule
// utils/probeBudget.js states and routes/checkin.js repeats, and the reason is
// the attack itself: a flooder SPENDS their allowance and only then sprays
// fresh keys, so their own entry is the oldest thing in the map and an
// oldest-first policy (or a wholesale clear) deletes precisely the counter they
// wanted gone. Dropping the entries with almost nothing left to remember costs
// an attacker a flood of keys that have each already spent a full window.
//
// Evict down to a low-water mark rather than to the ceiling, for the reason
// probeBudget spells out: stopping exactly at the ceiling means a map held at
// the ceiling sorts itself on every single call.
//
// WHY NOT utils/probeBudget.js: createUserBudget refuses any identity that is
// not a positive integer user id — "a budget denies an identity it cannot pin
// down" is one of its tested invariants — and neither key here is one. Same
// reasoning routes/checkin.js records for its anonymous tap budget.
// ---------------------------------------------------------------------------
function createGuestCounter({ name, limit, windowMs, maxKeys }) {
  const entries = new Map(); // key -> { count, resetAt }
  const lowWater = Math.floor(maxKeys * 0.9);

  function evict(now) {
    for (const [k, v] of entries) { if (now > v.resetAt) entries.delete(k); }
    if (entries.size <= maxKeys) return;
    const byConsumption = [...entries.entries()].sort(
      (a, b) => (a[1].count - b[1].count) || (a[1].resetAt - b[1].resetAt)
    );
    for (const [k] of byConsumption) {
      if (entries.size <= lowWater) break;
      entries.delete(k);
    }
  }

  function allow(key) {
    const k = String(key);
    const now = Date.now();
    let entry = entries.get(k);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(k, entry);
      // NOTE, because two other caches in this codebase do the opposite: there
      // is deliberately no delete-before-set here. routes/checkin.js's tapCache
      // and utils/places.js's venue cache both evict by AGE, so they have to
      // delete first — a Map keeps an existing key's insertion position, which
      // would make a frequently refreshed entry look permanently old. Nothing
      // here reads insertion order: eviction sorts by CONSUMPTION, and the
      // expiry pass is order-independent. Adding the dance would be a line that
      // implies a rule this counter does not follow.
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    if (entries.size > maxKeys) evict(now);
    return true;
  }

  return { name, allow, entries, limit, windowMs, maxKeys };
}

const NEW_GUESTS_PER_IP_PER_FLOCK = 3;
const NEW_GUEST_WINDOW_MS = 60 * 60 * 1000;
const NEW_GUEST_MAX_KEYS = 5000;

const newGuestCounter = createGuestCounter({
  name: 'guest-identity',
  limit: NEW_GUESTS_PER_IP_PER_FLOCK,
  windowMs: NEW_GUEST_WINDOW_MS,
  maxKeys: NEW_GUEST_MAX_KEYS,
});
// The Map itself stays exported under its old name: __tests__/unauthSurface.js
// and __tests__/pushRestDelivery.js clear it between cases.
const newGuestLog = newGuestCounter.entries; // "ip|flockId" -> { count, resetAt }

function allowNewGuest(ip, flockId) {
  return newGuestCounter.allow(`${ip}|${flockId}`);
}

// ---------------------------------------------------------------------------
// Round 23 — a ceiling on what ONE guest identity can make the server do.
//
// allowNewGuest bounds how many identities a caller may MINT. Nothing bounded
// what an identity could then do with itself, and both remaining writes are
// amplifiers: each one re-runs the member-facing tally and emits a tailored
// payload into every accepted member's personal room.
//
//   - /vote had no repeat guard at all. Re-posting the same venue took a pool
//     connection, an advisory lock, a DELETE, an INSERT, a tally and a fan-out
//     to every member — for a vote that changed nothing. (That specific case is
//     now a no-op; see the route.)
//   - /rsvp DID guard a repeat, but only a literal one: `changed` compares the
//     name and the status, so alternating `in` / `out` is "changed" every time
//     and announced every time. The general limiter admits thousands of
//     requests per IP per window, and this route needs no account.
//
// 30 an hour is far above an honest guest — arrive, answer, change your mind,
// vote, change your vote — and far below useful as an amplifier.
//
// KEYED ON THE guest_rsvps ROW ID that the lookup returned — never on the
// guest_token the caller sent. Two reasons, and the second was found by
// mutating the first version of this fix rather than by reading it:
//
//   1. The token is caller-supplied, so budgeting on it BEFORE the lookup would
//      let anyone fill this map with invented UUIDs. Waiting for the row bounds
//      the key space by rows that actually exist; an unknown token is refused on
//      its own merits and leaves nothing behind.
//   2. A UUID has more than one spelling. Postgres compares the `uuid` type
//      case-insensitively, so `A1B2…` and `a1b2…` are the SAME row — but they
//      are two different Map keys, and a 36-character hex string can be
//      re-cased about 2^32 ways. Keying on the token would therefore have been
//      defeated exactly the way probeBudget.js records the email limiter being
//      defeated: "by changing the case". The row id has one spelling.
// ---------------------------------------------------------------------------
const GUEST_ACTIONS_PER_HOUR = 30;
const GUEST_ACTION_WINDOW_MS = 60 * 60 * 1000;
const GUEST_ACTION_MAX_KEYS = 20000;

const guestActionCounter = createGuestCounter({
  name: 'guest-action',
  limit: GUEST_ACTIONS_PER_HOUR,
  windowMs: GUEST_ACTION_WINDOW_MS,
  maxKeys: GUEST_ACTION_MAX_KEYS,
});
const guestActionLog = guestActionCounter.entries;

function allowGuestAction(guestRowId) {
  return guestActionCounter.allow(guestRowId);
}

// ---------------------------------------------------------------------------
// A flock that is over is not a live write surface.
//
// resolveLink only asked whether the LINK was revoked, so a share link to a
// cancelled or completed plan still accepted RSVPs and votes — writing rows,
// fanning out to every member and pushing the host "Alice is in!" about a plan
// they had already called off. Reading stays open (GET /:token still answers,
// and the preview carries `status`, which is how the holder finds out the plan
// is off); only the writes are refused.
// ---------------------------------------------------------------------------
const TERMINAL_FLOCK_STATUSES = new Set(['completed', 'cancelled']);
const flockIsOver = (link) => TERMINAL_FLOCK_STATUSES.has(String(link.status || ''));

// Two display names are "the same" for takedown purposes if they differ only by
// case, surrounding space, or runs of whitespace. Deliberately conservative: it
// is a replay guard, not a similarity engine.
function normalizeGuestName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Is this display name one a moderator has already removed from this flock?
//
// ONE definition, because round 23 found the takedown had two doors and only
// one of them was locked — see the RSVP route. `run` is the query function to
// use, so the insert path can ask inside its transaction (under the same
// advisory lock that serialises the cap check) and the edit path can ask on the
// pool without checking a connection out.
//
// The comparison is normalised on both sides: SQL lowercases, trims and
// collapses whitespace runs in the stored name, normalizeGuestName does the
// same to the candidate. It runs on the SANITIZED name, because freeText's
// customSanitizer has already fired by the time a handler reads req.body — so
// `B<b></b>ob` is compared as `bob` and markup cannot split a removed name past
// the guard the way it once split words past the profanity filter.
// ---------------------------------------------------------------------------
async function nameIsTakenDown(run, flockId, name) {
  const r = await run(
    `SELECT 1 FROM guest_rsvps
     WHERE flock_id = $1
       AND COALESCE(is_hidden, false) = true
       AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = $2
     LIMIT 1`,
    [flockId, normalizeGuestName(name)]
  );
  return r.rows.length > 0;
}

// Resolve a link token to its live flock, or null.
//
// SECURITY-AUDIT-auth.md R2-4 (MEDIUM): `revoked = false` used to be the whole
// liveness test. Nothing else bounded a link in TIME — flockIsOver only catches
// a flock somebody manually marked completed/cancelled, and no code path does
// that on its own — so a token shared into a group chat stayed a working bearer
// credential to accepted membership indefinitely. `expires_at` (migration 028)
// is the deadline that applies when nobody revokes.
//
// An expired link resolves to NULL, which is the SAME answer an invented token
// gets: every caller of this function turns NULL into the not-found response,
// so the surface never tells a holder whether the link is expired, revoked, or
// was never real.
async function resolveLink(token) {
  const r = await pool.query(
    `SELECT il.flock_id, f.name, f.event_time, f.venue_name,
            f.status, u.name AS host_name
     FROM flock_invite_links il
     JOIN flocks f ON f.id = il.flock_id
     JOIN users u ON u.id = f.creator_id
     WHERE il.token = $1 AND il.revoked = false
       AND il.expires_at > NOW()`,
    [token]
  );
  return r.rows[0] || null;
}

// Member + guest vote tallies for a flock, grouped by venue name. No voter
// identities are exposed on the guest surface, only counts.
// Round 9: a hidden (taken-down) guest RSVP contributes nothing anywhere, votes
// included, so a moderator action fully removes them from the public surface.
async function guestTallies(flockId) {
  const r = await pool.query(
    `SELECT venue_name, SUM(c)::int AS votes FROM (
       SELECT venue_name, COUNT(*) AS c FROM venue_votes WHERE flock_id = $1 GROUP BY venue_name
       UNION ALL
       SELECT gv.venue_name, COUNT(*) AS c FROM guest_votes gv
       JOIN guest_rsvps gr ON gr.id = gv.guest_rsvp_id
       WHERE gv.flock_id = $1 AND COALESCE(gr.is_hidden, false) = false
       GROUP BY gv.venue_name
     ) t GROUP BY venue_name ORDER BY votes DESC LIMIT 12`,
    [flockId]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// THE ROSTER — who is going, who is not, and who has not answered.
//
// The preview used to return two integers (`members` and `guests`, summed into
// `going`), which answered "how many" and never "who". The person deciding
// whether to walk across town is deciding about PEOPLE, so the page has to be
// able to name them.
//
// PRIVACY BOUNDARY, decided here because this is an unauthenticated surface and
// no caller can re-decide it:
//
//   WHAT CROSSES: a display FIRST name, and one of three answers.
//   WHAT NEVER CROSSES: emails, phone numbers, user ids, guest row ids, guest
//   tokens, profile photos, surnames, reliability scores, join times, or any
//   way to tell a member apart from the account behind them.
//
// First name only is the rule `host` has followed since this route was written
// (`.split(' ')[0]`), applied to everyone else on the plan. It is the same
// amount of identity a group chat shows before you open it, and it is not
// enough to find someone with. A surname plus a plan plus a time is.
//
// `kind` ('member' | 'guest') crosses because the page tells the truth about
// what joining buys: guests answered from a link, members are in the chat. It
// says nothing about the person that the answer does not already say.
//
// HIDDEN ROWS. Every is_hidden filter on this surface is load-bearing: a
// moderator takedown removes a guest from the counts, the tallies and now the
// roster, in the SQL rather than in a forgettable `if`. A roster that listed a
// taken-down name would undo the takedown on the one page the abuser can still
// reach.
//
// BOUNDED. A leaked link must not become a paginated directory, and the payload
// must not grow with the flock, so the list is capped. The cap is deliberately
// above the 50-guest cap this file already enforces.
// ---------------------------------------------------------------------------
const ROSTER_LIMIT = 60;

// The same reduction `host` uses, in one place, with a length cap so a 60-char
// single-token "first name" cannot be used to pad the payload.
function firstNameOnly(name) {
  return String(name || '').trim().split(/\s+/)[0].slice(0, 24);
}

async function rosterFor(flockId) {
  const [members, guests] = await Promise.all([
    // flock_members.status is invited | accepted | declined (CHECK constraint,
    // migration 000). accepted IS the yes on this product: every capability and
    // every count in the backend keys on it, and POST /:id/join is what a
    // member taps to say they are coming.
    pool.query(
      `SELECT u.name AS name, fm.status AS status
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY CASE fm.status WHEN 'accepted' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END, fm.id
       LIMIT $2`,
      [flockId, ROSTER_LIMIT]
    ),
    pool.query(
      `SELECT name, status
       FROM guest_rsvps
       WHERE flock_id = $1 AND COALESCE(is_hidden, false) = false
       ORDER BY CASE status WHEN 'in' THEN 0 ELSE 1 END, id
       LIMIT $2`,
      [flockId, ROSTER_LIMIT]
    ),
  ]);

  const MEMBER_ANSWER = { accepted: 'in', declined: 'out', invited: 'none' };
  const rows = [
    ...members.rows.map((r) => ({
      name: firstNameOnly(r.name),
      rsvp: MEMBER_ANSWER[r.status] || 'none',
      kind: 'member',
    })),
    ...guests.rows.map((r) => ({
      name: firstNameOnly(r.name),
      // guest_rsvps.status is in | out (CHECK constraint). A guest who opened
      // the link and never answered has no row at all, so there is no third
      // state to represent here.
      rsvp: r.status === 'out' ? 'out' : 'in',
      kind: 'guest',
    })),
  ].filter((p) => p.name.length > 0);

  // Yes first, then no, then silent, so the page's most useful line is its
  // first one. Ordering is done here rather than in two ORDER BYs because the
  // two lists interleave.
  const RANK = { in: 0, out: 1, none: 2 };
  rows.sort((a, b) => RANK[a.rsvp] - RANK[b.rsvp]);
  return rows.slice(0, ROSTER_LIMIT);
}

// Tell the members a guest answered the link.
//
// Round 14: the old code emitted `guest_rsvp` into the `flock:{id}` room and
// only on first insert. Two holes: (1) nobody is in that room unless they have
// the flock screen open, so the host normally never saw it; (2) a guest
// CHANGING their answer (in -> out) returned early and broadcast nothing, so
// the host's count silently drifted from the truth. Fan-out is in
// sockets/handlers so the "reach the host wherever they are" rule has exactly
// one implementation.
//
// Never throws: the RSVP is already committed, and a broadcast failure must not
// turn a saved RSVP into a 500 the guest will retry.
async function announceGuestRsvp(req, link, { guestId, name, status, isNew }) {
  try {
    const io = req.app.get('io');
    if (!io) return;

    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM flock_members WHERE flock_id = $1 AND status = 'accepted')::int AS members,
         (SELECT COUNT(*) FROM guest_rsvps WHERE flock_id = $1 AND status = 'in'
            AND COALESCE(is_hidden, false) = false)::int AS guests`,
      [link.flock_id]
    );
    const guestsGoing = counts.rows[0].guests;
    const going = counts.rows[0].members + guestsGoing;

    await broadcastGuestRsvp(io, link.flock_id, {
      flockId: link.flock_id,
      // Same identity shape the REST roster returns, so a client can reconcile
      // the live event against the list it already rendered.
      guestId: guestEntryId(guestId),
      name,
      status,
      isGuest: true,
      going,
      guestsGoing,
    });

    // An offline host still needs to know somebody answered the link — that is
    // the whole point of sharing it. Only on a NEW yes, so a guest toggling
    // their answer can't be used to hammer the host's notifications.
    if (isNew && status === 'in') {
      const host = await pool.query('SELECT creator_id, name FROM flocks WHERE id = $1', [link.flock_id]);
      if (host.rows.length) {
        await pushIfOffline(io, host.rows[0].creator_id,
          `${name} is in!`,
          host.rows[0].name,
          // A guest has no user account, so there is nobody the host could have
          // blocked; the namespaced guest id (guest:N) is a non-numeric string,
          // so the block-gate's actor check reads it as "no actor" and correctly
          // skips the block lookup. Carried for payload consistency with the
          // authenticated push sites.
          { type: 'guest_rsvp', flockId: String(link.flock_id), fromUserId: guestEntryId(guestId) }
        );
      }
    }
  } catch (err) {
    console.error('Guest RSVP broadcast error:', err.message);
  }
}

// GET /api/guest/:token — the public plan preview
router.get('/:token',
  param('token').trim().isLength({ min: LINK_TOKEN_PARAM_MIN, max: LINK_TOKEN_PARAM_MAX }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid link' });

      const link = await resolveLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'This invite link is no longer active' });

      const [tallies, going, people] = await Promise.all([
        guestTallies(link.flock_id),
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM flock_members WHERE flock_id = $1 AND status = 'accepted')::int AS members,
             (SELECT COUNT(*) FROM guest_rsvps WHERE flock_id = $1 AND status = 'in' AND COALESCE(is_hidden, false) = false)::int AS guests`,
          [link.flock_id]
        ),
        rosterFor(link.flock_id),
      ]);

      res.json({
        flock: {
          name: link.name,
          // event_time is the full timestamp; the page formats day + time
          // in the guest's own locale.
          when: link.event_time || null,
          chosenVenue: link.venue_name || null,
          status: link.status,
        },
        // First name only — the host invited these people, but the page is
        // reachable by anyone with the link, so keep it minimal.
        host: firstNameOnly(link.host_name),
        going: going.rows[0].members + going.rows[0].guests,
        // Who those people are, and what each of them said. The exact fields,
        // and the ones deliberately withheld, are on rosterFor above.
        people,
        venues: tallies,
      });
    } catch (err) {
      console.error('Guest preview error:', err);
      res.status(500).json({ error: 'Could not load this invite' });
    }
  }
);

// POST /api/guest/:token/rsvp — { name, status } -> { guestToken }
router.post('/:token/rsvp',
  [
    param('token').trim().isLength({ min: LINK_TOKEN_PARAM_MIN, max: LINK_TOKEN_PARAM_MAX }),
    // max 60 matches the guest_rsvps.name column cap, so an over-long name is a
    // 400 here instead of a database error.
    // Round 13: this was the only user-writable name field in the app that
    // skipped stripHtml, and it is written WITHOUT authentication then
    // broadcast to every member over the `guest_rsvp` socket event. Sanitize
    // before the length check so markup can't smuggle past the 60-char cap.
    // Round 19 (shape sweep): `name: ["<b>x</b>"]` satisfied isLength, was left
    // untouched by stripHtml AND by rejectIfProfane (both return a non-string
    // unchanged), and then went into a VARCHAR(60) column, out over the
    // `guest_rsvp` socket event to every member, and into the host's push
    // notification title — with its markup and anything the profanity filter
    // exists to stop. It also slipped the takedown replay guard, because
    // normalizeGuestName(["Bob",""]) is "bob," and no longer matches the hidden
    // "bob". Unauthenticated, so this was the cheapest hole in the app.
    freeText(body('name'), 'name').isLength({ min: 1, max: 60 }).withMessage('Tell them who you are'),
    // guest_rsvps.status is VARCHAR(10) with CHECK (status IN ('in','out')).
    // `["in"]` passed isIn by coercion and reached the INSERT as '{in}', which
    // Postgres refused with 23514 — a 500 on an unauthenticated route.
    scalarOnly(body('status'), 'RSVP').isIn(['in', 'out']).withMessage('RSVP must be in or out'),
    // isUUID() accepts a one-element array too, and guest_rsvps.guest_token is
    // a UUID column: '{9d3f...}' is 22P02, i.e. another unauthenticated 500.
    scalarOnly(body('guestToken').optional({ values: 'null' }), 'guest token').isUUID(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const link = await resolveLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'This invite link is no longer active' });
      if (flockIsOver(link)) {
        return res.status(409).json({ error: 'This plan is no longer taking RSVPs' });
      }

      const { name, status, guestToken } = req.body;

      // Round 9: this is an UNAUTHENTICATED write whose value is broadcast to
      // every member over the socket, so it gets the same profanity screen as
      // every other user-writable text field.
      if (rejectIfProfane(res, name)) return;

      // Returning guest updates their RSVP; new guest gets a fresh identity.
      if (guestToken) {
        const existing = await pool.query(
          // `id` is selected for the per-guest budget below — it is the identity
          // the counter is keyed on, because a uuid has many spellings and a
          // row id has one.
          `SELECT id, name, status, COALESCE(is_hidden, false) AS is_hidden
           FROM guest_rsvps WHERE guest_token = $1 AND flock_id = $2`,
          [guestToken, link.flock_id]
        );
        if (existing.rows.length && existing.rows[0].is_hidden) {
          return res.status(403).json({ error: 'This RSVP was removed and cannot be edited' });
        }

        // Round 23 — the takedown had two doors.
        //
        // Round 15 made a removed name stick by refusing to INSERT it again,
        // because dropping your guest_token and re-RSVPing was a one-request
        // bypass. The guard went on the creation path only, and this is the
        // other one: a guest holding ANY live token for this flock could simply
        // RENAME their existing row to the removed name. Same column, same
        // broadcast to every member, and the row is not hidden so no read
        // filters it. The per-IP allowance is three identities an hour, so the
        // same person who was moderated usually still holds one.
        //
        // Checked on every edit rather than only when the name changes: the
        // sanitizer means `B<b></b>ob` and `Bob` are the same submitted value,
        // and "did it change" is not the question a takedown asks.
        if (existing.rows.length) {
          // Only now — the row is confirmed, so the budget's key space is
          // bounded by rows that exist rather than by tokens a caller invented.
          if (!allowGuestAction(existing.rows[0].id)) {
            return res.status(429).json({ error: 'Too many changes. Try again later.' });
          }
          if (await nameIsTakenDown((q, p) => pool.query(q, p), link.flock_id, name)) {
            return res.status(403).json({ error: 'That name cannot be used on this flock. Try a different one.' });
          }
        }

        // A guest editing their answer is now broadcast (it wasn't before, which
        // is how a host's count silently drifted). That makes an UNAUTHENTICATED
        // route a fan-out amplifier, so a re-POST of the SAME answer — the
        // cheapest thing to script against a link — announces nothing. That
        // guard is necessary and not sufficient: alternating `in` / `out` is
        // "changed" every time, which is what the per-guest budget above bounds.
        const prior = existing.rows[0] || null;
        const changed = !prior || prior.name !== name || prior.status !== status;
        const upd = await pool.query(
          `UPDATE guest_rsvps SET name = $1, status = $2, updated_at = NOW()
           WHERE guest_token = $3 AND flock_id = $4 AND COALESCE(is_hidden, false) = false
           RETURNING id, guest_token`,
          [name, status, guestToken, link.flock_id]
        );
        if (upd.rows.length) {
          if (changed) {
            await announceGuestRsvp(req, link, { guestId: upd.rows[0].id, name, status, isNew: false });
          }
          return res.json({ guestToken: upd.rows[0].guest_token, status });
        }
      }

      // Everything below creates a NEW guest identity. See allowNewGuest above
      // for why that is the expensive operation on this route and the edit path
      // is not.
      if (!allowNewGuest(req.ip, link.flock_id)) {
        return res.status(429).json({ error: 'Too many RSVPs from here. Try again later.' });
      }

      // Cap guests per flock so a leaked link can't flood a plan. Hidden rows
      // still count toward the cap: a takedown must not free up a slot.
      //
      // Round 10: the count and the insert were separate statements on an
      // UNAUTHENTICATED route, so concurrent requests all read the same
      // under-cap number and every one of them landed. Both now run in one
      // transaction behind a per-flock advisory lock, which serializes
      // concurrent RSVPs on the same link.
      const client = await pool.connect();
      let ins;
      let blockedByTakedown = false;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('guest_rsvp:' || $1::text))", [String(link.flock_id)]);

        const count = await client.query('SELECT COUNT(*)::int AS n FROM guest_rsvps WHERE flock_id = $1', [link.flock_id]);
        if (count.rows[0].n >= 50) {
          await client.query('ROLLBACK');
          return res.status(429).json({ error: 'This flock has too many guest RSVPs' });
        }

        // Round 15 — make a takedown STICK.
        //
        // Hiding a guest RSVP was a one-request bypass: the 403 above only
        // guards the path where the guest presents their original guestToken,
        // and nothing forces them to. Dropping the token fell straight through
        // to this INSERT, minting a fresh row with a fresh guest_token and the
        // SAME abusive display name — which is then broadcast live to every
        // member of the flock again. The name is the reported content here, so
        // a moderator who removed it had removed nothing.
        //
        // Profanity screening does not cover this: the names that get reported
        // are targeted at a person, not obscene, and pass the filter cleanly.
        //
        // Round 23: the same question the EDIT path now asks, from the same
        // definition, so the two doors cannot be locked differently.
        const revoked = await nameIsTakenDown((q, p) => client.query(q, p), link.flock_id, name);
        if (revoked) {
          blockedByTakedown = true;
          await client.query('ROLLBACK');
        } else {
          ins = await client.query(
            `INSERT INTO guest_rsvps (flock_id, name, status) VALUES ($1, $2, $3)
             RETURNING id, guest_token, COALESCE(is_hidden, false) AS is_hidden`,
            [link.flock_id, name, status]
          );
          await client.query('COMMIT');
        }
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      // Deliberately vague, and the same shape as any other refusal: a
      // moderated-off guest learns that this name will not go through, not that
      // a moderator acted on them specifically.
      if (blockedByTakedown) {
        return res.status(403).json({ error: 'That name cannot be used on this flock. Try a different one.' });
      }

      // Let members see the RSVP land in real time. Hidden rows are never
      // broadcast (a default-false column means this is normally true).
      if (!ins.rows[0].is_hidden) {
        await announceGuestRsvp(req, link, { guestId: ins.rows[0].id, name, status, isNew: true });
      }

      res.status(201).json({ guestToken: ins.rows[0].guest_token, status });
    } catch (err) {
      console.error('Guest RSVP error:', err);
      res.status(500).json({ error: 'Could not save your RSVP' });
    }
  }
);

// POST /api/guest/:token/vote — { guestToken, venueName } -> updated tallies
router.post('/:token/vote',
  [
    param('token').trim().isLength({ min: LINK_TOKEN_PARAM_MIN, max: LINK_TOKEN_PARAM_MAX }),
    scalarOnly(body('guestToken'), 'guest token').isUUID().withMessage('RSVP first, then vote'),
    // venueName is compared against three tables and then written to a
    // VARCHAR(255); as an array it reached all four as a Postgres array literal.
    scalarOnly(body('venueName'), 'venue').trim().isLength({ min: 1, max: 255 }).withMessage('Pick a venue'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const link = await resolveLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'This invite link is no longer active' });
      if (flockIsOver(link)) {
        return res.status(409).json({ error: 'This plan is no longer taking votes' });
      }

      const { guestToken, venueName } = req.body;

      const guest = await pool.query(
        `SELECT id FROM guest_rsvps
         WHERE guest_token = $1 AND flock_id = $2 AND COALESCE(is_hidden, false) = false`,
        [guestToken, link.flock_id]
      );
      if (!guest.rows.length) return res.status(403).json({ error: 'RSVP first, then vote' });
      const guestId = guest.rows[0].id;

      // Round 23: budget the identity, now that the database has confirmed it
      // and named it. Before the confirmation the key would be a caller-invented
      // UUID; after it, the key space is bounded by rows that exist and the key
      // itself has exactly one spelling. Nothing below this line is free — the
      // tally and the per-member fan-out are the expensive part of this route,
      // and this is an UNAUTHENTICATED caller.
      if (!allowGuestAction(guestId)) {
        return res.status(429).json({ error: 'Too many votes. Try again later.' });
      }

      // Guests vote on venues the group is already considering — they can't
      // introduce new venues from outside the flock.
      const known = await pool.query(
        `SELECT 1 FROM venue_votes WHERE flock_id = $1 AND venue_name = $2
         UNION SELECT 1 FROM guest_votes WHERE flock_id = $1 AND venue_name = $2
         UNION SELECT 1 FROM flocks WHERE id = $1 AND venue_name = $2 LIMIT 1`,
        [link.flock_id, venueName]
      );
      if (!known.rows.length) return res.status(400).json({ error: 'That venue is not in this flock' });

      // One vote per guest per flock — the same model member voting follows in
      // routes/venues.js. Round 11: this was an INSERT ... DO NOTHING that
      // never cleared the guest's previous pick, so a single guest could vote
      // for every venue in the flock one after another and inflate all of them.
      // Delete-then-insert under a per-guest advisory lock, so two taps racing
      // each other can't both land (guest.rsvp id, not the flock: guests on the
      // same link vote independently).
      // ---------------------------------------------------------------------
      // Round 23: a vote that changes nothing does nothing.
      //
      // The RSVP route has refused to announce an unchanged answer since round
      // 14, and said why: an unauthenticated route that fans out to every
      // member is an amplifier, and re-posting the same value is the cheapest
      // thing to script against a share link. This route had no equivalent, so
      // one guest token could spend the general limiter's whole allowance on
      // pool checkouts, advisory locks, paired writes, two tally queries and an
      // N-member socket fan-out, all to re-assert a vote already on record.
      //
      // Asked as one cheap counting query rather than by reading the row back:
      // the no-op is only correct when this venue is the guest's ONLY vote, so
      // the answer needed is "how many, and how many of them are this one".
      // A stale extra row (there should never be one — the write below is a
      // delete-then-insert) therefore falls through to the normal path and gets
      // cleaned up, rather than being mistaken for a no-op.
      // ---------------------------------------------------------------------
      const current = await pool.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE venue_name = $3)::int AS same
         FROM guest_votes WHERE flock_id = $1 AND guest_rsvp_id = $2`,
        [link.flock_id, guestId, venueName]
      );
      const cur = current.rows[0];
      const unchanged = !!cur && cur.n === 1 && cur.same === 1;

      if (!unchanged) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT pg_advisory_xact_lock(hashtext('guest_vote:' || $1::text))", [String(guestId)]);
          await client.query(
            'DELETE FROM guest_votes WHERE flock_id = $1 AND guest_rsvp_id = $2 AND venue_name <> $3',
            [link.flock_id, guestId, venueName]
          );
          await client.query(
            `INSERT INTO guest_votes (flock_id, guest_rsvp_id, venue_name)
             VALUES ($1, $2, $3) ON CONFLICT (flock_id, guest_rsvp_id, venue_name) DO NOTHING`,
            [link.flock_id, guestId, venueName]
          );
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw txErr;
        } finally {
          client.release();
        }
      }

      const venues = await guestTallies(link.flock_id);

      // The GUEST gets counts only (guestTallies) — no voter identities ever
      // cross onto the public link surface. The MEMBERS get the same `new_vote`
      // payload a member vote produces, fanned out to their personal rooms, so
      // a guest answering the link reaches them wherever they are in the app
      // and their tally arrives complete rather than needing a refetch. One
      // implementation of that tally, in the file that owns it — see
      // broadcastGuestVote in routes/venues.js.
      //
      // Not for a no-op: the members' tally is byte-for-byte what they already
      // hold, so the only thing the fan-out would carry is load.
      if (!unchanged) {
        await broadcastGuestVote(req.app.get('io'), link.flock_id, venueName);
      }

      // The guest still gets the live tally back either way — their client asked
      // what the standings are, and "you already voted for this" is not an error.
      res.status(201).json({ venues });
    } catch (err) {
      console.error('Guest vote error:', err);
      res.status(500).json({ error: 'Could not save your vote' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/guest/:token/join — the invited person joins the flock FOR REAL.
//
// This is the whole point of the page. Before this route existed, an invite
// link was a dead end: a stranger could see the plan, answer it and vote on it,
// and had no way at all to reach the conversation the plan was being made in.
// The only path into a flock was the host manually inviting an account that
// already existed, which is not something the person holding the link can do.
//
// WHY THIS IS AUTHENTICATED, AND WHY THE CHAT WILL NEVER BE OPEN TO GUESTS.
// Everything else in this file is unauthenticated on purpose: reading a plan
// and saying "I'm in" is inert. Posting into a flock's chat is not. A guest has
// no age gate (the 13+ floor is checked from a stored date of birth), no
// account to suspend, no ban to enforce and no report trail. Unauthenticated
// posting would put unmoderated user content on a public link, which is the
// exact shape of an Apple Guideline 1.2 rejection. So joining is the primary
// action on the invite page, and the account is what buys the chat.
//
// WHAT IT COSTS THE FLOCK. Anyone holding the link can join, which is the same
// trust model the link already had for RSVPs and votes: the token IS the
// credential, and a host who leaked it revokes and re-shares (routes/flocks.js
// { regenerate: true }). What is different is that a member is a real account,
// so the moderation stack that guests are outside of applies in full: bans
// (authenticate refuses a banned account before this handler runs), blocks (the
// ROSTER GATE below refuses the membership outright, and the join fan-out is
// block-aware on top of it), reports, and the 13+ floor.
//
// GATES, in the order they refuse:
//   401  no session                     (authenticate)
//   403  banned account                 (authenticate)
//   403  unverified email               (requireVerified, plus the EXISTS in
//                                        the write itself, plus the deny list
//                                        in middleware/auth.js — three layers,
//                                        deliberately, because this is now the
//                                        SECOND statement in the codebase that
//                                        promotes anybody to accepted flock
//                                        membership and it must carry the same
//                                        invariant as the first)
//   404  unknown / revoked link, or a deleted flock — byte-identical to the
//        other three routes, so this one cannot become the enumeration oracle
//        the others were written to avoid
//   403  somebody already on this plan's accepted roster is in a block with
//        the caller, in either direction. Names nobody: see the gate itself.
//   409  the plan is cancelled or completed
//   429  this link has already pulled in too many accounts
//
// ALREADY A MEMBER is a 200, not an error. Someone who is already in the flock
// and taps their own invite link wants the chat, not a lecture; they get sent
// to the same place, with `joined: false` so the client can stay quiet about it.
// ---------------------------------------------------------------------------

// A leaked link must not be able to pack a flock. 50 accepted members is far
// above any real group and matches the guest cap this file already enforces, so
// the two doors into a flock have the same ceiling.
const LINK_JOIN_MEMBER_CAP = 50;

// And one account cannot spend the route in a loop. Keyed on `userId|flockId`:
// both halves are integers the server resolved (the id came off a verified JWT,
// the flock id off the link lookup), so unlike the unauthenticated counters
// above there is no caller-supplied spelling to defeat it with.
const JOINS_PER_USER_PER_FLOCK = 10;
const JOIN_WINDOW_MS = 60 * 60 * 1000;
const JOIN_MAX_KEYS = 20000;

const joinCounter = createGuestCounter({
  name: 'link-join',
  limit: JOINS_PER_USER_PER_FLOCK,
  windowMs: JOIN_WINDOW_MS,
  maxKeys: JOIN_MAX_KEYS,
});
const joinLog = joinCounter.entries;

router.post('/:token/join',
  authenticate,
  requireVerified,
  param('token').trim().isLength({ min: LINK_TOKEN_PARAM_MIN, max: LINK_TOKEN_PARAM_MAX }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid link' });

      const link = await resolveLink(req.params.token);
      // The same sentence the other three routes answer a dead token with. A
      // signed-in caller must not be able to learn more about which tokens
      // exist than an anonymous one can.
      if (!link) return res.status(404).json({ error: 'This invite link is no longer active' });
      if (flockIsOver(link)) {
        return res.status(409).json({ error: 'This plan is over. Ask them to start a new one.' });
      }

      if (!joinCounter.allow(`${req.user.id}|${link.flock_id}`)) {
        return res.status(429).json({ error: 'Too many tries. Give it a minute.' });
      }

      // Already in? Answer before touching anything, so the common re-tap costs
      // one indexed read and writes nothing.
      const existing = await pool.query(
        'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [link.flock_id, req.user.id]
      );

      // BLOCKS HOLD ON THE LINK DOOR TOO (security round 5, 2026-08-20).
      //
      // Until this check, the header above claimed "blocks (the join fan-out
      // below is block-aware)" and only the ANNOUNCEMENT was. The membership
      // itself was minted regardless, so a share link — a bearer credential
      // that spreads by design, through group chats and screenshots — was a
      // way past the one control the product offers for exactly this.
      //
      // WHAT THAT BOUGHT AN ATTACKER, and why mutual invisibility made it
      // worse rather than better. B, blocked by A, gets the link to A's plan
      // and joins. B is now an accepted member of the flock A is going to:
      // the venue, the time, the chat the rest of the group holds about the
      // night. And because every read in routes/flocks.js and every socket
      // fan-out in sockets/handlers.js filters the pair out of each other's
      // view, A is never shown that B is there. The block did not keep B away
      // from A's evening; it hid B from A while B walked into it.
      //
      // The rule is the one POST /api/flocks (invited_user_ids) and POST
      // /:id/invite already enforce in the other direction: a blocked pair
      // does not become co-members. Applied across the WHOLE accepted roster,
      // not just the host, because "who is at this plan" is what the joiner
      // learns and what the members are exposed to — the host is one of them,
      // not the only one that counts.
      //
      // Bidirectional, matching utils/blocks.js: it does not matter which side
      // pressed the button. Asked in one set-based query rather than a call
      // per member, and it runs BEFORE the advisory-lock transaction so a
      // refusal never takes a lock.
      //
      // ALREADY-ACCEPTED MEMBERS ARE NOT REFUSED. Two people already in a
      // flock who then block each other stay where they were — that is the
      // existing behaviour everywhere else, the flock's own reads already keep
      // them apart, and turning a re-tap of your own plan's link into a 403
      // would be a new eviction rule smuggled in through a share link. This
      // gate is about a NEW membership, so it sits after the already-in
      // answer and before the write.
      //
      // The refusal names no one. Telling B which member blocked them would
      // hand over exactly the fact the block exists to withhold — that A is on
      // this plan — so the sentence is the same one whoever is on the roster.
      if (!(existing.rows.length && existing.rows[0].status === 'accepted')) {
        const blocked = await pool.query(
          `SELECT 1
             FROM flock_members fm
             JOIN user_blocks b
               ON (b.blocker_id = $2 AND b.blocked_id = fm.user_id)
               OR (b.blocked_id = $2 AND b.blocker_id = fm.user_id)
            WHERE fm.flock_id = $1
              AND fm.status = 'accepted'
              AND fm.user_id <> $2
            LIMIT 1`,
          [link.flock_id, req.user.id]
        );
        if (blocked.rows.length > 0) {
          return res.status(403).json({ error: 'You cannot join this plan.' });
        }
      }
      if (existing.rows.length && existing.rows[0].status === 'accepted') {
        return res.json({ flockId: link.flock_id, flockName: link.name, joined: false });
      }
      const wasInvited = existing.rows.length > 0;

      // The cap check and the write run in one transaction behind the same
      // per-flock advisory lock the guest INSERT uses, for the same reason:
      // read-then-write on a route several people can hit at once lets every
      // concurrent caller read the same under-cap number and all of them land.
      const client = await pool.connect();
      let joined = false;
      let overCap = false;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('flock_join:' || $1::text))", [String(link.flock_id)]);

        // An already-invited account is not new weight on the flock: the host
        // put them there. Only a link walk-up is capped.
        if (!wasInvited) {
          const count = await client.query(
            "SELECT COUNT(*)::int AS n FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
            [link.flock_id]
          );
          if (count.rows[0].n >= LINK_JOIN_MEMBER_CAP) {
            overCap = true;
            await client.query('ROLLBACK');
          }
        }

        if (!overCap) {
          // The EXISTS clause is the last line of the unverified-account gate,
          // written where the membership is actually minted. requireVerified
          // above and the middleware deny list both already refuse this
          // request, so in normal operation it never decides anything. It is
          // here because "an unverified account is never an accepted member"
          // must be a property of the write, not of two middlewares both
          // continuing to be mounted. IS NOT FALSE, not = TRUE, for the reason
          // routes/flocks.js records: a NULL must read as "not gated".
          const ins = await client.query(
            `INSERT INTO flock_members (flock_id, user_id, status, joined_at)
             SELECT $1::int, $2::int, 'accepted', NOW()
             WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = $2::int AND u.email_verified IS NOT FALSE)
             ON CONFLICT (flock_id, user_id)
             DO UPDATE SET status = 'accepted', joined_at = NOW()
             WHERE flock_members.status <> 'accepted'
             RETURNING id`,
            [link.flock_id, req.user.id]
          );
          joined = ins.rowCount > 0;
          await client.query('COMMIT');
        }
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      if (overCap) {
        return res.status(429).json({
          error: 'This plan is full. Ask them to add you in the app.',
        });
      }

      res.json({ flockId: link.flock_id, flockName: link.name, joined });

      // Everything below is after the response: the membership is committed and
      // the joiner is not waiting on the rest of the flock finding out.
      if (!joined) return;
      try {
        const io = req.app.get('io');
        if (io) {
          // Per-member fan-out, not the `flock:{id}` room, and block-aware —
          // the same shape POST /api/flocks/:id/join uses, so a person joining
          // through a link is announced exactly like a person accepting an
          // invite, and never to someone who blocked them.
          await emitToFlockExcludingBlocked(io, link.flock_id, req.user.id, 'flock_invite_responded', {
            flockId: link.flock_id,
            userId: req.user.id,
            userName: req.user.name,
            userImage: req.user.profile_image_url || null,
            action: 'accepted',
          });
        }
        const host = await pool.query('SELECT creator_id, name FROM flocks WHERE id = $1', [link.flock_id]);
        if (host.rows.length && host.rows[0].creator_id !== req.user.id) {
          await pushIfOffline(io, host.rows[0].creator_id,
            `${req.user.name} is going!`,
            host.rows[0].name,
            { type: 'flock_rsvp', flockId: String(link.flock_id), fromUserId: String(req.user.id) }
          );
        }
      } catch (announceErr) {
        console.error('Link join announce error:', announceErr.message);
      }
    } catch (err) {
      console.error('Link join error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Could not join this flock' });
    }
  }
);

module.exports = {
  router,
  newLinkToken,
  LINK_TOKEN_ALPHABET,
  LINK_TOKEN_LENGTH,
  LINK_TOKEN_PARAM_MAX,
  allowNewGuest,
  normalizeGuestName,
  newGuestLog,
  // Round 23 — exposed for __tests__/guestSurfaceAbuse.test.js, which pins the
  // ceilings and the eviction order rather than trusting them.
  allowGuestAction,
  guestActionLog,
  // The counter factory itself, so its eviction ORDER can be exercised on a
  // ten-key instance instead of by flooding the twenty-thousand-key one.
  createGuestCounter,
  GUEST_ACTIONS_PER_HOUR,
  GUEST_ACTION_MAX_KEYS,
  NEW_GUESTS_PER_IP_PER_FLOCK,
  NEW_GUEST_MAX_KEYS,
  TERMINAL_FLOCK_STATUSES,
  // The join path — pinned by __tests__/inviteJoinFlow.test.js, which exercises
  // the ceilings rather than trusting them, and clears joinLog between cases.
  rosterFor,
  firstNameOnly,
  ROSTER_LIMIT,
  LINK_JOIN_MEMBER_CAP,
  JOINS_PER_USER_PER_FLOCK,
  joinLog,
};
