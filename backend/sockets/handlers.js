const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { stripHtml } = require('../utils/sanitize');
// imageRejectionMessage, NOT IMAGE_REJECTED_MESSAGE. utils/moderation.js
// documents the function as the thing call sites are supposed to use, and it is
// the only one that can tell the two refusals apart: an image refused for being
// ANIMATED is a policy decision ("try a still photo"), not a safety verdict.
// Both send paths here reached past it for the constant, so a user whose sunset
// GIF was refused was told it had failed a safety check, which is both wrong and
// unactionable. It matters more now that the client shows these strings as a
// toast instead of console.warn-ing them (App.js, the 'error' listener).
const { moderateText, TEXT_REJECTED_MESSAGE, moderateImage, imageRejectionMessage } = require('../utils/moderation');
const { sanitizeVenueData, safeVenuePhotoUrl } = require('../utils/venuePayload');
// EXIF/XMP/IPTC removal for the bytes that actually get stored. See the header
// of utils/imageMetadata.js: a chat photo taken on a phone carries a GPS fix,
// and this app stores every chat photo inline and re-serves it to somebody else.
const { stripDataUrlMetadata } = require('../utils/imageMetadata');
const VENUE_REJECTED_MESSAGE = "That venue card couldn't be shared.";
const { isBlockedBetween, isBlockedBetweenCached, getInvisibleUserIds } = require('../utils/blocks');
const { isPlaceIdShaped, isKnownVenue } = require('../utils/places');
const {
  hasDmRelationship,
  hasDmRelationshipCached,
  invalidateDmRelationshipCache,
  NOT_CONNECTED_MESSAGE,
} = require('../utils/relationships');
const { pushIfOfflineDebounced } = require('../services/pushHelper');
// Round 17: the session revalidator re-verifies the handshake token, so it must
// accept the same (and only the same) algorithms the handshake did. Without the
// pin, a future change to how JWT_SECRET is loaded (a PEM/KeyObject) could
// silently widen the accepted set to the asymmetric family here while the
// handshake still refused it. Single source of truth in middleware/auth.js.
const { TOKEN_ALGORITHMS, tokenVersionOf } = require('../middleware/auth');

// Track which users are in which rooms for presence.
// Keyed by the CANONICAL room id (String(flockId)), because the client picks
// the type: emitting join_flock with 5 and again with "5" joins one Socket.io
// room (`flock:5`) but used to create two presence entries, so leaving/
// disconnecting announced the same person twice and one entry could outlive
// the other. Round 23: join_flock now normalizes the id with asId before
// anything touches it, so the id stored per entry (and echoed in every
// presence payload) is the canonical INTEGER — the same shape vote_venue's
// round 16 note established App.js compares with === against the id the REST
// API serves. The old rule ("keep the raw id the client sent") only worked for
// clients that already sent the integer; any other spelling produced an event
// every client silently discarded, plus a phantom room name and presence key.
const roomUsers = new Map(); // String(flockId) -> Map(socketId -> { socketId, userId, name, flockId })

// ---------------------------------------------------------------------------
// Chat photo ceiling — ONE number, both transports
// ---------------------------------------------------------------------------
// A chat photo travels inside the message body as a base64 data: URL, over
// whichever transport is up, and is stored verbatim in messages.image_url /
// direct_messages.image_url. Until now neither transport put a number on it:
//
//   * the socket's only ceiling was Socket.IO's 8MB maxHttpBufferSize, which is
//     a frame-size safety valve, not a product decision. It let a ~5.9MB data
//     URL into a TEXT column that is then re-sent to every member on every
//     history page load, and again to every recipient on the live fan-out;
//   * REST's only ceiling was `express.json({ limit: '1mb' })`, an unrelated
//     global that happens to sit in front of the route. Neither number was
//     chosen with the other in mind, so the fallback transport was ~8x narrower
//     than the primary one — and the fallback is the one that comes out when
//     the network is already bad, which is exactly when a big photo hurts.
//
// So: one explicit ceiling, enforced here and used to size the REST body limit
// in server.js (which imports this constant), and both transports now accept
// exactly the same photo. 1MiB of data URL is ~768KB of image after base64's
// 4/3 inflation. The client resizes to at most 700KiB before sending
// (CHAT_IMAGE_MAX_CHARS in App.js), so nothing a current client can produce is
// refused, and there is ~46% of headroom for the client to be retuned without
// needing a backend deploy. It also lines up with the rest of the app's image
// paths: stories cap a data URL at 700KiB, avatars at ~400KB.
const CHAT_IMAGE_MAX_BYTES = 1024 * 1024;
// The chat-photo thumbnail's own ceiling. See the block comment in
// routes/messages.js (readImageThumb there is this rule's REST twin): the
// thumb is client-derived, moderated like the image, and DROPPED on any
// failure rather than ever costing the message.
const THUMB_MAX_BYTES = 96 * 1024;
function readImageThumb(value) {
  if (typeof value !== 'string') return null;
  if (!/^data:image\//.test(value)) return null;
  if (Buffer.byteLength(value, 'utf8') > THUMB_MAX_BYTES) return null;
  return value;
}

// Wording for the refusals below. These strings are shown to the user verbatim
// (App.js toasts the server's 'error' channel), and both send paths must use
// the SAME one for the same condition — a divergence here reads to the user as
// two different products.
const IMAGE_TOO_LARGE_MESSAGE = 'That photo is too large to send. Try a smaller one.';
const IMAGE_FORMAT_MESSAGE = 'Unsupported image format';
// Matches routes/messages.js's EMPTY_MESSAGE exactly, for the same reason.
const EMPTY_MESSAGE = 'Message is required';
const MESSAGE_TOO_LONG_MESSAGE = 'Message too long (max 5000 characters)';

// The one gate both send paths use for an inbound image. Returns null when
// there is no image, or { ok } / { ok: false, message } otherwise.
//
// `typeof image_url === 'string'` is load-bearing, not decoration: the regex
// test coerces, so `['data:image/png;base64,AAAA']` passed the old check as a
// string, then went to Buffer.byteLength (a TypeError) and to pg as an array
// literal. Same shape class the REST twin closes with scalarOnly().
function checkInboundImage(image_url) {
  if (image_url === undefined || image_url === null || image_url === '') return null;
  if (typeof image_url !== 'string'
      || !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(image_url)) {
    return { ok: false, message: IMAGE_FORMAT_MESSAGE };
  }
  // Byte length, not .length: the prefix and the base64 body are ASCII, so the
  // two agree today, but what the body limit in server.js counts is bytes.
  if (Buffer.byteLength(image_url, 'utf8') > CHAT_IMAGE_MAX_BYTES) {
    return { ok: false, message: IMAGE_TOO_LARGE_MESSAGE };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The stored MIME comes from the bytes, not from the sender
// ---------------------------------------------------------------------------
// checkInboundImage's allowlist reads the DECLARED type off the front of the
// data: URL, and until now that declaration was stored verbatim in
// messages.image_url / direct_messages.image_url (and in stories.image_url via
// the REST route), even when the bytes behind it are a different format
// entirely. Nothing about SAFETY hangs on the declaration — browsers pick a
// decoder by sniffing the payload, which is exactly why the byte-level frame
// gate in utils/moderation.js is the real control and says so ("The declared
// type gates nothing; only the bytes do") — but a stored type the stored bytes
// contradict is a lie in the database: any future consumer that trusts it (an
// export, a Content-Type header on some future download path, a human reading
// a row) inherits the sender's claim instead of the file's. The avatar path
// already refuses to store the client's word for it (routes/users.js types the
// file from full magic numbers and builds the data URL from that answer);
// these are the SAME full signatures, deliberately, so the two byte-typers in
// this repo cannot reach different conclusions about the same bytes — the
// truncated-signature seam routes/users.js round 19 closed must not reopen
// here. Signatures are spelled as bytes, not strings, for the same reason
// routes/users.js spells them that way.
//
// Bytes that match NO signature keep the declared prefix ON PURPOSE. This is a
// re-typer, not a second gate: whether such a payload is stored at all is
// moderateImage's decision (fail-closed wherever it matters), and a refusal
// added here would invent a new rejection on paths whose accept/reject
// behaviour __tests__/chatTransportParity.test.js and
// __tests__/imageRouteParity.test.js pin exactly. Frame counting stays in
// utils/moderation.js; this types the container and nothing else.
const IMAGE_BYTE_SIGNATURES = {
  jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
  png:  [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  gif:  [
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),  // GIF, version 87a
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),  // GIF, version 89a
  ],
  // 'RIFF' alone is a container header, not an image one: WAV and AVI open the
  // same four bytes. The 'WEBP' form type at offset 8 is what makes it an image.
  webp: [Buffer.from([0x52, 0x49, 0x46, 0x46])],
};

const SNIFFED_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

function sniffImageFormat(bytes) {
  for (const [format, sigs] of Object.entries(IMAGE_BYTE_SIGNATURES)) {
    for (const sig of sigs) {
      if (bytes.length < sig.length || !bytes.subarray(0, sig.length).equals(sig)) continue;
      if (format === 'webp' && bytes.toString('latin1', 8, 12) !== 'WEBP') continue;
      return format;
    }
  }
  return null;
}

// Rewrites a data: URL's declared MIME to the sniffed one. The base64 payload
// is untouched — only the prefix moves — so the bytes that were screened are
// exactly the bytes that are stored. Anything that is not a data: URL string
// comes back unchanged: every caller runs its format gate first, so this only
// ever re-types values that gate already admitted.
function restampImageMime(imageUrl) {
  if (typeof imageUrl !== 'string') return imageUrl;
  const comma = imageUrl.indexOf(',');
  if (comma < 0) return imageUrl;
  // 64 base64 characters decode to 48 bytes; the longest signature test above
  // needs 12. ASCII whitespace is stripped from the WHOLE payload before the
  // head is taken, not left for Buffer.from to skip inside a fixed window.
  // The WHATWG data: URL decoder ignores whitespace anywhere in the payload
  // (imageToBlob in utils/moderation.js strips it before its canonical check
  // for exactly that reason), so a payload front-padded with 64+ spaces still
  // decodes and renders as an image — but a fixed 64-character window read
  // nothing except the padding, sniffed zero bytes, and waved the sender's
  // claimed MIME through. The bytes this types are the bytes a browser will
  // actually decode. One O(n) pass over a <=1MiB string, once per image send;
  // moderateImage runs the identical strip on the same payload anyway.
  const head = Buffer.from(
    imageUrl.slice(comma + 1).replace(/\s+/g, '').slice(0, 64),
    'base64'
  );
  const format = sniffImageFormat(head);
  const mime = format && SNIFFED_MIME[format];
  if (!mime) return imageUrl;
  return `data:${mime};base64,${imageUrl.slice(comma + 1)}`;
}

// What every image write path stores. Two steps, and the ORDER is the whole
// point: restampImageMime decides what the file IS from its bytes, and the
// stripper needs that answer to be about the same bytes it is walking, so the
// re-type runs first and the strip runs on its output.
//
// Why this is a separate function rather than more work inside restampImageMime:
// that one is a pure re-typer, and its contract ("the payload is byte-for-byte
// untouched, only the prefix moves") is asserted directly by
// __tests__/imageTrust.test.js. That is the right contract for a byte-typer to
// have. Removing metadata is a different job with a different failure mode, so
// it gets its own function and the call sites compose them here, once, instead
// of four times.
//
// Moderation runs BEFORE this, on the bytes the sender actually sent, and that
// is deliberate: what gets screened should be what was uploaded, and stripping
// only ever removes metadata segments, never pixels, so nothing can hide behind
// it. The stored bytes are a subset of the screened ones.
function sanitizeStoredImage(imageUrl) {
  return stripDataUrlMetadata(restampImageMime(imageUrl));
}

// Drop one socket's presence from one flock, cleaning up the empty room entry.
function forgetPresence(flockKey, socketId) {
  const key = String(flockKey);
  const users = roomUsers.get(key);
  if (!users) return;
  users.delete(socketId);
  if (users.size === 0) roomUsers.delete(key);
}

// Tell the client why it is being cut off, then cut it off. `disconnect(true)`
// closes the underlying connection so the client must re-handshake — which is
// what re-runs authenticateSocket.
function revokeSession(socket, reason) {
  try { socket.emit('session_revoked', { reason }); } catch (_) { /* already gone */ }
  try { socket.disconnect(true); } catch (_) { /* already gone */ }
}

// Per-socket AND per-user token buckets for mutating events.
//
// (audit 2026-08-12): Express rate limits stop at the handshake — after that a
// single connection could flood the database and push infrastructure without
// any ceiling.
//
// (audit 2026-08-14): the per-socket bucket was the ONLY ceiling, and a socket
// id is free. Nothing caps how many sockets one account holds at once (the
// handshake limiter in server.js counts new connections per IP, not concurrent
// ones per user), and every new socket id starts an empty bucket — so N
// parallel sockets bought N times the write rate, and a deliberate
// disconnect/reconnect reset the counters early. Both ceilings now apply: a
// burst is capped per connection, and the ACCOUNT is capped across every
// connection it holds, from any number of IPs.
const socketBuckets = new Map(); // socket.id -> Map(event -> {count, resetAt})
const userBuckets = new Map();   // userId    -> Map(event -> {count, resetAt})

// A user's aggregate allowance is deliberately wider than one socket's, so a
// phone plus an open laptop tab both behave normally — but twenty do not.
const USER_LIMIT_MULTIPLIER = 2;

function takeToken(store, key, event, limit, windowMs) {
  let events = store.get(key);
  if (!events) { events = new Map(); store.set(key, events); }
  const now = Date.now();
  let b = events.get(event);
  if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; events.set(event, b); }
  b.count++;
  return b.count <= limit;
}

function allowEvent(socket, event, limit, windowMs) {
  // Both counters must be charged, so `&&` short-circuiting is not allowed.
  const perSocket = takeToken(socketBuckets, socket.id, event, limit, windowMs);
  const userId = socket.user?.id;
  const perUser = userId == null
    ? true
    : takeToken(userBuckets, userId, event, limit * USER_LIMIT_MULTIPLIER, windowMs);
  return perSocket && perUser;
}

// --- Global per-socket packet ceiling --------------------------------------
//
// allowEvent's buckets are keyed on the EVENT NAME, which leaves two ways past
// them, and both are free:
//
//   * SPREAD. The per-name budgets are independent, so a client that cycles
//     through the handler list rather than hammering one name is charged
//     nothing extra: the ceilings above add up to roughly 500 packets per ten
//     seconds per socket before a single one is refused, and each of those
//     packets can be a database query.
//   * UNKNOWN NAMES. A packet for an event nobody registered is not metered at
//     all, because the meter lives inside the handlers. It still costs a frame
//     read, a decode of up to maxHttpBufferSize (8MB, server.js) and an
//     adapter dispatch, and nothing anywhere ever refuses one.
//
// So one ceiling over EVERY inbound packet, in front of the per-event ones.
// Socket.io's `socket.use` runs for every event the client sends, before the
// listener, and dropping the packet is a matter of not calling next().
//
// 300 per ten seconds is far above any real client. The busiest thing a phone
// does is a typing indicator and App.js debounces those, while 300 is well
// under the sum of the per-event budgets, which is the number that made the
// spread bypass worth anything.
const PACKETS_PER_WINDOW = 300;
const PACKET_WINDOW_MS = 10_000;

// A client that keeps pushing after everything is being dropped is a script,
// not a bug, so the connection goes. It is dropped WITHOUT `session_revoked`:
// that event means "your credentials stopped being valid" and App.js signs the
// user out on it, which is the wrong answer for a rate limit. A plain
// disconnect leaves the client free to reconnect, where the per-IP handshake
// limiter in server.js is the next ceiling.
const PACKET_FLOOD_DISCONNECT = PACKETS_PER_WINDOW * 3;

function allowPacket(socket) {
  if (allowEvent(socket, '__packet', PACKETS_PER_WINDOW, PACKET_WINDOW_MS)) return true;
  // Charged only for packets the ceiling above already refused, so this counts
  // how hard the client is pushing AFTER being told no.
  if (!allowEvent(socket, '__packet_refused', PACKET_FLOOD_DISCONNECT, PACKET_WINDOW_MS)) {
    try { socket.disconnect(true); } catch (_) { /* already gone */ }
  }
  return false;
}

// Concurrent connections per account. Without this a single account could hold
// hundreds of live sockets: every `io.to('user:X').emit(...)` then fans out
// hundreds of copies (server-side amplification of every message, vote and
// location update aimed at that user) and each socket carries its own rate
// bucket. Oldest sockets are evicted rather than refusing the new one, so a
// user's current device always wins over stale tabs.
const MAX_SOCKETS_PER_USER = 8;
const userSockets = new Map(); // userId -> Set<socketId> (insertion ordered)

function trackUserSocket(io, socket) {
  const userId = socket.user?.id;
  if (userId == null) return [];
  let set = userSockets.get(userId);
  if (!set) { set = new Set(); userSockets.set(userId, set); }
  set.add(socket.id);
  const evicted = [];
  while (set.size > MAX_SOCKETS_PER_USER) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    evicted.push(oldest);
    try { io?.sockets?.sockets?.get?.(oldest)?.disconnect?.(true); } catch (_) { /* already gone */ }
  }
  return evicted;
}

function clearBuckets(socket) {
  const socketId = typeof socket === 'string' ? socket : socket?.id;
  socketBuckets.delete(socketId);
  const userId = typeof socket === 'string' ? null : socket?.user?.id;
  if (userId == null) return;
  const set = userSockets.get(userId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(userId);
  }
  // The per-user bucket deliberately OUTLIVES the account's last connection.
  // Dropping it here would restore the exact bypass this exists to close:
  // disconnect everything, reconnect, spend the allowance again. It expires on
  // its own when its window rolls over (takeToken), and the sweep below keeps
  // the map from growing with every user the process has ever seen.
  if (userBuckets.size > 5000) {
    const now = Date.now();
    for (const [key, events] of userBuckets) {
      let live = false;
      for (const b of events.values()) { if (now < b.resetAt) { live = true; break; } }
      if (!live) userBuckets.delete(key);
    }
  }
}

// --- One-shot relay ceiling ------------------------------------------------
//
// For events that announce a state TRANSITION rather than carry new content
// (friend request sent / answered). Re-emitting one of these is pure noise in
// the recipient's client, and it is free to do, so "the row exists" was not a
// sufficient gate — see the note above the friend handlers.
//
// Process-global and keyed by the pair, not by socket: a socket id costs
// nothing, so a per-connection map would be reset by a reconnect.
const NOTIFY_ONCE_MS = 10 * 60 * 1000;
const RELAY_MAX_ENTRIES = 20000;
const relayedNotifications = new Map(); // "kind|from|to" -> last delivery ms

// How many DISTINCT relay targets one ACCOUNT may open in a NOTIFY_ONCE_MS
// window. Round 18: the global cap below is a fail-safe whose failure mode is
// global — once the map is full of live entries, alreadyRelayed refuses
// EVERYONE, so nobody's friend-request toast is delivered until the entries
// age out. Nothing stopped one account from filling all 20000 slots on its own:
// the event budget is 40/10s per account and each new (kind, from, to) key
// costs one slot, so ~85 minutes of one script bought a rolling ten-minute
// outage of the feature for the whole product. Bounding occupancy per account
// puts that out of reach of a single actor and leaves the global cap as what it
// was meant to be — a last resort, not the mechanism.
//
// 60 is far above any human: it is sixty different people friend-requested or
// answered inside ten minutes. It rides on the same per-user bucket store as
// the event limits, so it expires on its own and is swept by clearBuckets.
const RELAY_NEW_KEYS_PER_USER = 60;

function alreadyRelayed(key, actorId) {
  const now = Date.now();
  const last = relayedNotifications.get(key);
  if (last && now - last < NOTIFY_ONCE_MS) return true;
  // Charged only for a key that is about to be CREATED, so the ordinary
  // suppressed re-emit above (the flood case) never touches this budget.
  if (actorId != null
      && !takeToken(userBuckets, actorId, 'relay_new_key', RELAY_NEW_KEYS_PER_USER, NOTIFY_ONCE_MS)) {
    return true;
  }
  if (relayedNotifications.size > RELAY_MAX_ENTRIES) {
    for (const [k, ts] of relayedNotifications) {
      if (now - ts >= NOTIFY_ONCE_MS) relayedNotifications.delete(k);
    }
    // Every entry still live means the map is full of genuine recent pairs.
    // Refusing is the safe direction: a missed toast beats unbounded growth,
    // and the REST notification row is the durable record either way.
    if (relayedNotifications.size > RELAY_MAX_ENTRIES) return true;
  }
  relayedNotifications.set(key, now);
  return false;
}

// Test seam: rate limiting is process-global state, so tests need a way back
// to a known-empty starting point.
function __resetRateLimiters() {
  socketBuckets.clear();
  userBuckets.clear();
  userSockets.clear();
  relayedNotifications.clear();
}

// --- Live session revalidation -------------------------------------------
//
// authenticateSocket (middleware/auth.js) runs ONCE, at the handshake. After
// that the connection is trusted for as long as it stays open, and a socket
// stays open indefinitely (pingInterval keeps it alive; there is no maximum
// lifetime). That made every server-side revocation a no-op against an already
// connected client:
//   - a password change bumps users.token_version, which is precisely how a
//     victim is meant to evict someone holding a stolen JWT — the thief's live
//     socket kept receiving every message, DM, budget ceiling and live location
//     and kept posting as the victim;
//   - the OAuth account-claim in routes/auth.js bumps it for the same reason,
//     with the same hole;
//   - DELETE /api/users/me removes the row but leaves the socket in `user:{id}`
//     and every `flock:{id}` room it had joined;
//   - the 24h token expiry never arrived for a connection that predated it.
// (A moderator ban is the one case already handled — routes/admin.js calls
// disconnectSockets — and it stays handled here too, for ban paths that don't.)
const SESSION_RECHECK_MS = 60_000;

// tokenVersionOf ("a missing or non-integer version reads as 0") is imported
// from middleware/auth.js — it used to be a local copy of that file's private
// rule, which meant a change to how a missing `tv` claim is read there would
// not have reached the live-socket revalidation here.

// Pure: given the token's claims and the CURRENT user row, why (if at all) must
// this connection die? Mirrors authenticateSocket in middleware/auth.js — the
// handshake's rule set, which is the right one to mirror, and NOT the REST
// `authenticate`, which additionally applies the UNVERIFIED_DENY table to a
// request path. That gate has no socket equivalent and does not need one: every
// action it denies (creating a flock, joining, inviting, friend requests,
// payment handles) is persisted over REST, and the socket handlers for those
// only relay a row the REST endpoint already wrote. Refuse the write and the
// relay has nothing to announce.
function evaluateSession(decoded, row) {
  if (!row) return 'account_deleted';
  if (row.is_banned) return 'account_suspended';
  if (tokenVersionOf(decoded?.tv) !== tokenVersionOf(row.token_version)) return 'session_revoked';
  return null;
}

// One revalidation pass over a live connection. Returns the reason the socket
// was cut (or null), which is what the tests assert on.
async function revalidateSession(socket) {
  try {
    let decoded;
    try {
      decoded = jwt.verify(socket.handshake?.auth?.token, process.env.JWT_SECRET, { algorithms: TOKEN_ALGORITHMS });
    } catch (_) {
      // Expired or tampered — the same verdict the handshake would give it.
      revokeSession(socket, 'session_expired');
      return 'session_expired';
    }

    // Round 18: the token is re-verified above, and then the ROW is looked up
    // by socket.user.id — two identities that authenticateSocket set from the
    // same claim and that nothing here checked still agree. If they ever drift
    // (a future handshake path that sets socket.user from something other than
    // decoded.userId), this function would be checking one account's token
    // version against another account's row and calling the session healthy.
    // Same reasoning as the TOKEN_ALGORITHMS pin at the top of the file: cost
    // nothing, and it cannot become wrong later without being noticed.
    if (Number(decoded?.userId) !== Number(socket.user?.id)) {
      revokeSession(socket, 'session_revoked');
      return 'session_revoked';
    }

    // Round 23: reconcile the presence cache with the ROOM state before
    // anything that can throw. routes/flocks.js revokes room access directly
    // when a membership ends (socketsLeave on leave and on delete), which
    // roomUsers cannot observe — so the departed member's presence entry
    // outlived the revocation for the life of their connection: later joiners
    // were handed a roster naming them as online, and their eventual
    // disconnect announced `member_offline` by name into a flock they had
    // left. An entry whose socket is no longer in the room it claims is stale.
    // (join_flock runs the same check against the adapter's room set at read
    // time; this timer covers the paths where nobody joins again.)
    for (const [key, users] of roomUsers) {
      if (users.has(socket.id) && !socket.rooms.has(`flock:${key}`)) {
        forgetPresence(key, socket.id);
      }
    }

    const result = await pool.query(
      'SELECT id, email, name, role, profile_image_url, is_banned, token_version FROM users WHERE id = $1',
      [socket.user.id]
    );
    const row = result.rows[0];
    const reason = evaluateSession(decoded, row);
    if (reason) {
      revokeSession(socket, reason);
      return reason;
    }

    // Refresh the snapshot every handler broadcasts from, so a renamed or
    // demoted account stops speaking under its old name and role. Mutated IN
    // PLACE on purpose: registerHandlers closes over `socket.user` once, so
    // replacing the object would leave every handler holding the stale one.
    if (socket.user) Object.assign(socket.user, row);

    // Flock room membership is checked at join_flock and then trusted for the
    // life of the connection, while `flock:{id}` carries the budget ceiling
    // (routes/budget.js) and per-person bill shares (routes/billing.js).
    // Re-check it, so a membership that ended cannot leave a listener behind.
    const joined = [...socket.rooms].filter((r) => typeof r === 'string' && r.startsWith('flock:'));
    if (joined.length > 0) {
      const numericIds = joined
        .map((r) => r.slice('flock:'.length))
        .filter((id) => /^\d+$/.test(id))
        .map(Number);
      const allowed = numericIds.length
        ? await pool.query(
            "SELECT flock_id FROM flock_members WHERE user_id = $1 AND status = 'accepted' AND flock_id = ANY($2::int[])",
            [socket.user.id, numericIds]
          )
        : { rows: [] };
      for (const room of staleFlockRooms(joined, allowed.rows.map((r) => r.flock_id))) {
        socket.leave(room);
        forgetPresence(room.slice('flock:'.length), socket.id);
      }
    }
    return null;
  } catch (_) {
    // A database blip must never disconnect anyone — try again next tick.
    return null;
  }
}

// Pure: which `flock:*` rooms is this socket in that its membership no longer
// justifies? Anything that is not a plain integer id backed by an accepted
// membership is stale — unparseable room names fail closed.
function staleFlockRooms(rooms, allowedFlockIds) {
  const allowed = new Set([...(allowedFlockIds || [])].map((id) => String(id)));
  return [...(rooms || [])]
    .filter((r) => typeof r === 'string' && r.startsWith('flock:'))
    .filter((r) => !allowed.has(r.slice('flock:'.length)));
}

// --- Venue subscription gate ----------------------------------------------
//
// Same rule routes/checkin.js applies to an NFC tap, applied to a live
// subscription: the id must be shaped like a Google place id, and it must name
// a venue we already know. Round 16: the rule used to be copied here and in
// routes/checkin.js, and the comment that stood in this spot asked for a shared
// module. utils/places.js is that module, and both call sites now import it, so
// the security rule has one definition instead of two that can drift.
//
// Round 18: what stood here was an OPEN DECISION — isKnownVenue also counted
// `EXISTS (SELECT 1 FROM flocks WHERE venue_id = $1)`, which was self-serve
// (creating a flock is free and its venue_id is a client-supplied string), and
// this comment recorded the verdict to drop that clause on behalf of both
// consumers. utils/places.js round 17 carried it out. "Known" now means a
// claimed venue_profiles row, a provisioned sensor_devices row, or a curated
// ml_venues row — three kinds of evidence WE create, none of them mintable by
// an account. A stale open-question is worse than none: the next reader would
// have gone looking for a hole that is already closed, or assumed the clause
// was still there and reasoned from it.
//
// What to know about the current rule, since it does cost something: a deployed
// NFC tag whose venue has no profile, sensor or ml_venues row answers 404 until
// that row is written, and isKnownVenue fails CLOSED on a database error rather
// than throwing. See the long note in utils/places.js.
const MAX_VENUE_ROOMS_PER_SOCKET = 10;

// --- Wire-value normalizers ------------------------------------------------
//
// Socket payloads get none of express-validator's coercion, so every handler
// used to interpret ids and short strings its own way. These two are the
// socket equivalents of `param('id').isInt()` and
// `body('emoji').isLength({min:1,max:10})`, so the socket and REST twins of the
// same feature agree on what they accept.
//
// STRICT on purpose: parseInt('5abc') is 5 and Number.isInteger says yes, and
// Postgres silently trims ' 5 ' when casting to int — both produced ids that
// resolved in SQL but did not match the `user:5` room name built by string
// interpolation, so writes landed and deliveries did not.
// Bounded to the SERIAL (int4) range these columns actually use. Round 16
// second pass: without the ceiling, '99999999999999999999' passed the digit
// test, became 1e20, and reached Postgres as an out-of-range int — a swallowed
// error instead of a rejection, one query later than it needed to be.
const MAX_SERIAL_ID = 2147483647;
function asId(value) {
  const n = Number.isInteger(value)
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? parseInt(value.trim(), 10) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SERIAL_ID) return null;
  return n;
}

// Round 16: `typeof lat !== 'number'` was the only check on a coordinate, and
// `typeof NaN === 'number'` is true — so NaN and Infinity passed straight
// through to every peer's map, where JSON.stringify turns them into `null`.
// Coordinates that are not real coordinates are refused.
function isLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// dm_emoji_reactions.emoji is VARCHAR(10); the REST twin enforces 1-10 chars.
function normalizeEmoji(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 10) return null;
  return trimmed;
}

// Reusable membership check for socket handlers
async function verifyMembership(flockId, userId) {
  const result = await pool.query(
    "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
    [flockId, userId]
  );
  return result.rows.length > 0;
}

// Round 13: dm_vote_venue and dm_pin_venue accepted ANY receiverId the caller
// had not been blocked by, so a stranger could write rows into a conversation
// they are not part of. dm_pinned_venues is keyed on the (user1, user2) PAIR
// and upserts, so a single event from an outsider OVERWRITES whatever those two
// people had pinned. Persisting DM handlers require a real relationship: an
// accepted friendship, or a DM that already exists between the two accounts.
// (Round 24: the ephemeral handlers — typing, location — no longer stop at the
// block check either. See the long note above dm_share_location.)
//
// Round 16: the definition moved to utils/relationships.js so the REST twins in
// routes/messages.js can hold the same rule.
//
// Round 18: `send_dm` uses it too now. It used to be the documented exception,
// on the grounds that the REST route admitted any existing user; that route now
// requires a relationship, so the exception had quietly become the one way left
// to drop a message into a stranger's inbox. See the note in that handler.

// Room broadcast with the actor's blocked users excluded, for the presence
// events that are cheap and frequent enough that a per-member fan-out would be
// the wrong trade. `except()` takes room names, and every socket is in its own
// `user:{id}` room (joined on connect), so excluding those rooms excludes those
// people wherever they are connected from.
//
// `emitter` is either `socket.to(room)` (everyone but me) or `io.to(room)`
// (everyone). Falls back to an unfiltered emit only on a broadcaster that has
// no `except` — i.e. a stub — never on a block lookup failure, which fails
// CLOSED by throwing out to the caller's guard.
function broadcastExcluding(emitter, invisibleIds, event, payload) {
  let target = emitter;
  const ids = [...(invisibleIds || [])];
  if (ids.length && typeof target.except === 'function') {
    target = target.except(ids.map((id) => `user:${id}`));
  }
  target.emit(event, payload);
}

// The presence variant: looks the block list up, and stays silent rather than
// broadcasting unfiltered if it cannot.
async function announceToRoomExcludingBlocked(socket, room, event, payload) {
  let invisible = [];
  try {
    invisible = await getInvisibleUserIds(payload.userId);
  } catch (_) {
    // Fail closed. A presence ping is worth far less than the guarantee that a
    // blocked user never sees it.
    return;
  }
  broadcastExcluding(socket.to(room), invisible, event, payload);
}

// Block-aware alternative to a flock-room broadcast: emits to each accepted
// member individually, skipping anyone blocked either way with the actor.
// Room broadcasts leaked typing/vote identity across blocks (round 4).
async function emitToFlockExcludingBlocked(io, flockId, actorId, event, payload) {
  const members = await pool.query(
    "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
    [flockId, actorId]
  );
  const invisible = new Set(await getInvisibleUserIds(actorId));
  for (const m of members.rows) {
    if (invisible.has(m.user_id)) continue;
    io.to(`user:${m.user_id}`).emit(event, payload);
  }
}

// --- Per-member fan-out ----------------------------------------------------
//
// `flock:{id}` is NOT a membership list. A socket joins it when the client
// opens that flock's screen (join_flock) and stays in it for the life of the
// connection, so a room emit is wrong in both directions at once:
//
//   - it UNDER-delivers, because a member sitting anywhere else in the app —
//     the normal case for anything that happens while they are not staring at
//     the flock — is not in the room at all;
//   - it OVER-delivers, because membership is verified once at join time.
//     revalidateSession sweeps stale rooms, but only on a 60s timer, only when
//     JWT_SECRET is set, and it swallows database errors by design, so the
//     sweep is best-effort and the exposure window is open-ended.
//
// `user:{id}` is joined on connect and is a superset of the flock room, so
// fanning out to each accepted member reaches everyone exactly once and cannot
// reach anyone whose membership has ended. Membership is re-read at emit time,
// which is the property that makes it safe.
//
// `recipients` is for the one case the query cannot serve: an event about a
// flock whose rows are already gone (a delete CASCADEs flock_members away, so
// the members must be captured BEFORE the delete and passed in here).
//
// Returns the ids it delivered to (handy for tests and logging).
async function emitToFlockMembers(io, flockId, event, payload, recipients) {
  if (!io) return [];
  let ids = recipients;
  if (!Array.isArray(ids)) {
    const members = await pool.query(
      "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
      [flockId]
    );
    ids = members.rows.map((r) => r.user_id);
  }
  for (const id of ids) {
    io.to(`user:${id}`).emit(event, payload);
  }
  return ids;
}

// --- Venue content viewers -------------------------------------------------
//
// `venue_content:{placeId}` holds the sockets that have a venue's PUBLIC UGC on
// screen: the reviews and promotions the venue detail card renders from
// /public-reviews and /public-promotions. Its ONE consumer today is the
// moderation takedown in routes/admin.js, which needs to retract a hidden
// review or promotion from every open card rather than only from its author's.
//
// WHY THIS IS NOT `venue:{placeId}`. That room already exists a few hundred
// lines up and it is tempting to reuse. It holds the wrong people in both
// directions:
//
//   - It MISSES viewers. The client joins it from the map bottom sheet
//     (`activeVenue`), while the reviews and promotions live in state keyed on
//     the detail modal, which also opens from a flock card, a search result and
//     a chat share. Every card opened without a map pin would hear nothing.
//   - It ADDS the wrong ones. Map-sheet viewers hold no review or promotion
//     state, and the venue OWNER joins their own `venue:{placeId}` from the
//     dashboard — the one surface App.js deliberately does not retract reviews
//     from, because its header stats come from the server.
//
// Those two sets also have different lifetimes: the crowd feed is worth holding
// while a pin is selected, and this one is worth holding exactly as long as the
// content it can retract. Merging them would make a future change to who may
// subscribe to crowd levels silently change who hears about a takedown.
//
// Same privacy profile as the crowd room, so the same gate: reviews and
// promotions here are already served to any signed-in account by
// /public-reviews and /public-promotions, and the PAYLOAD carries no words, no
// author and no reason — a content type and an id, so the worst a subscriber
// learns is that a row they could already read is gone.
const VENUE_CONTENT_ROOM = (placeId) => `venue_content:${placeId}`;

// Returns whether it emitted, so a caller (and a test) can tell "delivered to
// an empty room" from "refused to build a room name".
//
// isPlaceIdShaped on the EMIT side as well as the join side. The value comes
// out of venue_reviews/venue_promotions, where google_place_id is a plain
// VARCHAR with no format constraint and is written from a client-supplied
// string on the claim path, so this is the one place a stored value would
// otherwise become a room name.
function emitToVenueContentViewers(io, placeId, event, payload) {
  if (!io || !isPlaceIdShaped(placeId)) return false;
  io.to(VENUE_CONTENT_ROOM(placeId)).emit(event, payload);
  return true;
}

// Guest RSVPs come in over an UNAUTHENTICATED share link (routes/guest.js), so
// there is no connected socket to broadcast from — the REST route calls this.
// Kept as its own name because routes/guest.js already imports it.
async function broadcastGuestRsvp(io, flockId, payload) {
  return emitToFlockMembers(io, flockId, 'guest_rsvp', payload);
}

function registerHandlers(io, socket) {
  const user = socket.user; // Set by authenticateSocket middleware

  // Every handler goes through this wrapper: a malformed payload (null where
  // an object is destructured) or a DB error inside a handler without its own
  // try/catch became an unhandled rejection that killed the whole process on
  // Node 18+ (round 8). Handlers keep their local try/catch; this is the net.
  const rawOn = socket.on.bind(socket);
  socket.on = (event, handler) =>
    rawOn(event, async (...args) => {
      try {
        await handler(...args);
      } catch (err) {
        console.error(`socket ${event} handler error:`, err.message);
      }
    });

  // One meter over every inbound packet, ahead of the per-event ones (see
  // allowPacket). Guarded because the test harness's stub sockets implement
  // only what the handlers use; a stub without `use` simply has no global
  // ceiling, which is what the per-event assertions already expect.
  if (typeof socket.use === 'function') {
    socket.use((_packet, next) => {
      if (!allowPacket(socket)) return; // dropped: not calling next() ends it here
      next();
    });
  }

  // Cap concurrent connections for this account (see MAX_SOCKETS_PER_USER).
  trackUserSocket(io, socket);

  // Re-verify this connection's session on a timer (see SESSION_RECHECK_MS).
  // Skipped when there is no JWT_SECRET — the handshake could not have
  // succeeded with one missing, so this only affects stubbed/test sockets.
  if (process.env.JWT_SECRET && socket.handshake) {
    const sessionTimer = setInterval(() => { revalidateSession(socket); }, SESSION_RECHECK_MS);
    if (typeof sessionTimer.unref === 'function') sessionTimer.unref();
    socket.on('disconnect', () => clearInterval(sessionTimer));
  }

  // --- Flock room management ---

  socket.on('join_flock', async (rawFlockId) => {
    if (!allowEvent(socket, 'join_flock', 20, 10_000)) return;
    try {
      // Round 23: normalized like vote_venue (round 16) instead of used raw.
      // The raw value reached the membership query, the room name, the presence
      // key and the echoed payloads, and Postgres trims whitespace when casting
      // to int — so '7 ' passed membership for flock 7 and then joined the
      // phantom room 'flock:7 ' under the phantom presence key '7 ', while the
      // raw spelling went back out in member_joined/room_members where App.js
      // compares with === against the INTEGER id the REST API serves. An id
      // that names no possible flock is dropped before it can cost a query.
      const flockId = asId(rawFlockId);
      if (flockId === null) return;

      // Verify membership before allowing room join
      const membership = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, user.id]
      );

      if (membership.rows.length === 0) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      const key = String(flockId);
      const room = `flock:${key}`;

      // Bound the number of flock rooms one connection can hold. Real usage
      // joins the room that is on screen; memberships are finite but presence
      // bookkeeping should not be able to grow with them without limit.
      const alreadyIn = [...socket.rooms].some((r) => r === room);
      if (!alreadyIn) {
        const held = [...socket.rooms].filter((r) => typeof r === 'string' && r.startsWith('flock:')).length;
        if (held >= 50) return;
      }
      socket.join(room);

      // Track user presence in the room. Keyed by socket id — the old
      // Set-of-objects never deduplicated, so repeated join_flock emits grew
      // presence, memory, and room_members payloads without bound (round 5).
      if (!roomUsers.has(key)) {
        roomUsers.set(key, new Map());
      }
      roomUsers.get(key).set(socket.id, {
        socketId: socket.id,
        userId: user.id,
        name: user.name,
        flockId,
      });

      // Presence is identity, so it obeys blocks like every other live signal
      // (typing, votes, location already do). Without this, blocking someone
      // still told them the moment you opened the flock, under your name.
      //
      // Round 18: this was the one block filter on the file that failed OPEN.
      // An unavailable block list became an EMPTY block list, and the handler
      // carried on to announce `member_joined` under the joiner's name to the
      // whole room and to hand the joiner a roster containing everyone they had
      // blocked. Every counterpart already fails closed — leave_flock's
      // member_offline, the disconnect broadcast, flock_invite_responded,
      // update_location, the send_message fan-out — so a database blip silently
      // reopened, on the arrival half of presence only, exactly what rounds 4/5
      // closed on the departure half. The room join itself stays unconditional:
      // it carries no identity, and refusing it would strand a member outside
      // their own flock over a transient error. Only the two identity-bearing
      // emits are dropped, which is the same trade the rest of the file makes —
      // a missing presence ping beats a leaked one, and the REST roster fills
      // it in on the next read.
      let invisible;
      try {
        invisible = new Set(await getInvisibleUserIds(user.id));
      } catch (_) {
        return;
      }

      // Notify other members. Round 18: this hand-rolled the same `except`
      // chain broadcastExcluding already owns, which is how it came to differ
      // from its siblings in the first place. One implementation, one shape.
      broadcastExcluding(socket.to(room), invisible, 'member_joined', {
        userId: user.id,
        name: user.name,
        flockId,
      });

      // Send current online members to the joining user — deduped by USER,
      // since one person can hold several sockets (phone + tab, reconnects).
      //
      // Round 23: cross-checked against the ROOM'S live socket set first.
      // routes/flocks.js revokes room access directly when a membership ends
      // (`io.in('user:X').socketsLeave('flock:Y')` on leave, `io.socketsLeave`
      // on delete) — which this cache cannot observe, so a departed member's
      // presence entry survived their revocation for as long as their socket
      // stayed connected, and every later joiner was handed an "online" roster
      // naming someone who had left the flock. The adapter's room set is the
      // authoritative record of who is actually still joined; an entry whose
      // socket the room no longer holds is stale and is purged, not listed.
      // Guarded, because stub broadcasters in tests have no adapter rooms —
      // absence of the room set means "cannot verify", which keeps behaviour,
      // never "everyone is stale". revalidateSession runs the same
      // reconciliation on its 60s timer for the paths that never re-join.
      const present = roomUsers.get(key) || new Map();
      const liveRoom = io?.sockets?.adapter?.rooms?.get?.(room);
      const seen = new Set();
      const onlineMembers = [];
      for (const [sid, u] of present) {
        if (liveRoom && sid !== socket.id && !liveRoom.has(sid)) {
          present.delete(sid);
          continue;
        }
        if (seen.has(u.userId)) continue;
        if (invisible.has(u.userId)) continue;
        seen.add(u.userId);
        onlineMembers.push({ userId: u.userId, name: u.name });
      }
      if (present.size === 0) roomUsers.delete(key);
      socket.emit('room_members', { flockId, members: onlineMembers });
    } catch (err) {
      console.error('join_flock error:', err);
      socket.emit('error', { message: 'Failed to join flock room' });
    }
  });

  socket.on('leave_flock', async (rawFlockId) => {
    // Round 23: normalized like join_flock, and SYMMETRICALLY with it — join
    // only ever enters the canonical room now, so leave must compute the same
    // canonical name or a client that joined with "7" and left with "7 " would
    // stay subscribed until the 60s sweep. Detaching stays free and
    // unconditional (see the round 16 note below); an unparseable id still
    // runs the raw-string detach so it remains a harmless no-op, and is then
    // dropped before the announce path, which no junk id may reach.
    const flockId = asId(rawFlockId);
    const key = flockId !== null ? String(flockId) : String(rawFlockId);
    const room = `flock:${key}`;
    socket.leave(room);

    // Remove from presence tracking. Like disconnect, only announce offline
    // when the user has no OTHER socket left in the room (round 7). This runs
    // BEFORE the membership lookup so a bad flockId (which makes the query
    // throw) can never leak a roomUsers entry.
    let announce = true;
    if (roomUsers.has(key)) {
      const users = roomUsers.get(key);
      users.delete(socket.id);
      announce = ![...users.values()].some((u) => u.userId === user.id);
      if (users.size === 0) roomUsers.delete(key);
    }

    // Round 13: this emitted `member_offline` into any room id the caller
    // named, with no membership check — a stranger could push fake presence
    // events into any flock whose id they guessed. Leaving the room and the
    // presence bookkeeping stay unconditional (a removed member must still be
    // able to detach); only the BROADCAST is gated. join_flock already verifies.
    //
    // Round 16: this was the only handler running a database query per event
    // with no ceiling of any kind, and `leave_flock` is the cheapest event on
    // the wire (a bare id), so a tight loop was unbounded database load.
    //
    // Round 16, second pass: the meter deliberately guards ONLY the query and
    // the broadcast, and is checked here rather than at the top of the handler.
    // Rate-limiting the whole handler would mean a refused `leave_flock` left
    // the socket subscribed to `flock:{id}` — which carries the budget ceiling
    // and per-person bill shares. Failing to detach is a worse outcome than
    // the load it would have prevented, so detaching is always free.
    if (flockId === null) return; // a name no real flock can have — nothing to announce
    if (!allowEvent(socket, 'leave_flock', 30, 10_000)) return;
    let isMember = false;
    try { isMember = await verifyMembership(flockId, user.id); } catch (_) { isMember = false; }

    if (announce && isMember) {
      // Round 16: `member_joined` above hides itself from blocked users
      // (rounds 4/5 — "presence is identity, so it obeys blocks like every
      // other live signal"), but its counterpart did not. The result was a
      // one-sided leak in the direction that matters least to the leaker and
      // most to the person who blocked: they never appeared to come online, and
      // then announced, by name, the moment they left.
      await announceToRoomExcludingBlocked(socket, room, 'member_offline', {
        userId: user.id,
        name: user.name,
        flockId,
      });
    }
  });

  // --- Venue rooms (live sensor + checkin updates) ---
  //
  // A venue room is a PUBLIC feed by design — busyness at a bar is not private
  // information, and the same numbers are served unauthenticated by
  // /api/public and the embeddable badge. That is only defensible while the
  // feed stays anonymous, and it did not: `venue_checkin` carried `user_id` and
  // `crowd_update` carried `updated_by`, so subscribing to a handful of venues
  // gave any account a live "who just walked in where" feed, ignoring blocks,
  // on an app whose users are 15-22 (audit 2026-08-14, with the public-surface
  // pass). Both identifiers are gone; see the emit sites.
  //
  // The subscription itself is now gated too, because "no authorization at all"
  // is the wrong default even for public data:
  //   - the id must LOOK like a Google place id, and
  //   - it must name a venue this system actually knows about, so a socket
  //     cannot mint arbitrary room names (Socket.io keeps a map entry per
  //     room) or silently prepare to receive whatever a future event adds.
  // No presence tracking — these are read-only feeds, not group chats.
  const venueRooms = new Set(); // insertion ordered — oldest is evicted first
  socket.on('join_venue', async (data) => {
    if (!allowEvent(socket, 'join_venue', 30, 10_000)) return;
    const placeId = typeof data === 'string' ? data : data?.placeId;
    if (!isPlaceIdShaped(placeId)) return;
    if (!venueRooms.has(placeId)) {
      if (!(await isKnownVenue(placeId))) return;
      // Evict rather than refuse: a real client watches one venue at a time and
      // leaves on unmount, so hitting this cap means stale rooms, and silently
      // refusing the room the user is actually looking at would be a bug.
      while (venueRooms.size >= MAX_VENUE_ROOMS_PER_SOCKET) {
        const oldest = venueRooms.values().next().value;
        venueRooms.delete(oldest);
        socket.leave(`venue:${oldest}`);
      }
    }
    venueRooms.add(placeId);
    socket.join(`venue:${placeId}`);
  });

  socket.on('leave_venue', (data) => {
    const placeId = typeof data === 'string' ? data : data?.placeId;
    if (!placeId) return;
    venueRooms.delete(placeId);
    socket.leave(`venue:${placeId}`);
  });

  // --- Venue CONTENT rooms (live moderation takedowns on public venue UGC) ---
  //
  // Deliberately a SECOND subscription rather than a flag on join_venue: see
  // the note above emitToVenueContentViewers for why the crowd room is the
  // wrong set of people. A client joins this one when it opens a venue card
  // that is holding reviews or promotions and leaves it when that card closes
  // or changes venue, so the room's membership is the set of screens a takedown
  // can actually retract from.
  //
  // Same gate as join_venue, for the same reason: a socket must not be able to
  // mint arbitrary room names, and "the id names a venue we already know" is
  // the rule utils/places.js exists to define once. Same eviction policy too —
  // a real client holds one card at a time, so hitting the cap means stale
  // rooms and refusing the one the user is looking at would be the bug. The Set
  // is separate from venueRooms so the two subscriptions cannot evict each
  // other; a card open on the same venue as the map sheet needs both.
  const venueContentRooms = new Set(); // insertion ordered — oldest evicted first
  socket.on('join_venue_content', async (data) => {
    if (!allowEvent(socket, 'join_venue_content', 30, 10_000)) return;
    const placeId = typeof data === 'string' ? data : data?.placeId;
    if (!isPlaceIdShaped(placeId)) return;
    if (!venueContentRooms.has(placeId)) {
      if (!(await isKnownVenue(placeId))) return;
      while (venueContentRooms.size >= MAX_VENUE_ROOMS_PER_SOCKET) {
        const oldest = venueContentRooms.values().next().value;
        venueContentRooms.delete(oldest);
        socket.leave(VENUE_CONTENT_ROOM(oldest));
      }
    }
    venueContentRooms.add(placeId);
    socket.join(VENUE_CONTENT_ROOM(placeId));
  });

  // No shape check on the way OUT, matching leave_venue: leaving a room you
  // could never have joined is a no-op, and refusing a malformed id here would
  // only strand a socket in a room it wanted to drop. The bare-string form is
  // accepted for the same reason join does, and that half IS tested.
  //
  // `if (!placeId) return` is PARITY WITH leave_venue, not a tested guard, and
  // saying so is cheaper than letting the next reader assume it protects
  // something. Deleting it changes no observable behaviour: Set.delete and
  // socket.leave are both no-ops for a member that is not there, and
  // `venue_content:undefined` is a room name Socket.io never creates because
  // nothing ever joins it. MEASURED, by removing the line and watching every
  // test in __tests__/takedownAudience.test.js still pass.
  socket.on('leave_venue_content', (data) => {
    const placeId = typeof data === 'string' ? data : data?.placeId;
    if (!placeId) return;
    venueContentRooms.delete(placeId);
    socket.leave(VENUE_CONTENT_ROOM(placeId));
  });

  // --- Real-time messaging ---

  socket.on('send_message', async (data) => {
    try {
      if (!allowEvent(socket, 'send_message', 20, 10_000)) {
        socket.emit('error', { message: 'Slow down a moment.' });
        return;
      }
      // `data` is whatever came off the wire, including nothing at all. It used
      // to be destructured bare, so `socket.emit('send_message')` threw a
      // TypeError into the catch below and came back as the generic "Failed to
      // send message" — a server-fault sentence for a client-shaped mistake.
      // send_dm has always read its payload defensively (`data?.receiverId`).
      const { message_type, venue_data, image_url } = data || {};
      const message_text = stripHtml(typeof data?.message_text === 'string' ? data.message_text.trim() : '');

      // Validate inputs. Round 23: asId, like vote_venue — the raw value used
      // to reach the membership query, the insert, and the push payload, so a
      // non-canonical spelling ('7 ') wrote real rows while anything worse was
      // a thrown query dressed up as the generic "Failed to send message".
      const flockId = asId(data?.flockId);
      if (flockId === null) {
        socket.emit('error', { message: 'That flock could not be found.' });
        return;
      }
      // A message must CARRY something: text or an image.
      //
      // The old rule was `!message_text && message_type !== 'image'`, which is
      // a test of the TYPE LABEL rather than of the payload, and it was wrong in
      // both directions. A bare `{ message_type: 'image' }` with no image and no
      // text passed it and stored an empty row (a blank bubble in the thread),
      // while a photo whose caller had not set message_type was refused even
      // though it carried an image. routes/messages.js already spells the rule
      // as "text or an image" and its comment asks this handler to adopt that
      // one rather than the other way round; this is that. Nothing a real client
      // sends changes: every image send carries image_url.
      const imageCheck = checkInboundImage(image_url);
      if (!message_text && !imageCheck) {
        socket.emit('error', { message: EMPTY_MESSAGE });
        return;
      }
      if (message_text.length > 5000) {
        socket.emit('error', { message: MESSAGE_TOO_LONG_MESSAGE });
        return;
      }
      // UGC text filter (Apple 1.2) — reject objectionable content before storing.
      if (!moderateText(message_text).allowed) {
        socket.emit('error', { message: TEXT_REJECTED_MESSAGE });
        return;
      }
      const allowedTypes = ['text', 'venue_card', 'image'];
      const safeType = allowedTypes.includes(message_type) ? message_type : 'text';

      // Image safety (round 3): socket sends bypassed the moderation endpoint
      // entirely. Only data-URL images are accepted (no arbitrary remote URLs
      // that could track recipients), and every image is screened fail-closed
      // before it is stored or delivered.
      //
      // The FREE image refusals (format, size) stay ahead of the membership
      // query below, matching the REST twin where the validator chain runs
      // before any query. Only the BILLED half moves behind membership.
      if (imageCheck && !imageCheck.ok) {
        socket.emit('error', { message: imageCheck.message });
        return;
      }

      // Verify membership — BEFORE the billed Vision call below, not after it.
      // Round 23: this query used to sit after image moderation, so a
      // non-member (including a member kicked mid-session whose socket was
      // still open) could make this handler spend a PAID Cloud Vision call per
      // attempt on a flock they could never deliver into — 10/min per socket,
      // 20/min per account, of someone else's money. The REST twin has always
      // run membership ahead of moderateImage (routes/messages.js: "a stranger
      // who cannot deliver the message must not be able to spend money finding
      // that out" is send_dm's phrasing of the same rule), so the socket was
      // the one transport where the order was inverted.
      const membership = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, user.id]
      );
      if (membership.rows.length === 0) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      if (imageCheck) {
        // Round 16: an image send was charged the same single token as a
        // one-word text message, and an image is not the same thing. Each one
        // costs a PAID Google Vision call (utils/moderation.js), a row holding
        // up to CHAT_IMAGE_MAX_BYTES, and that payload again for every
        // recipient. The socket path allowed 2 per second of a far larger
        // payload with no separate ceiling at all. Its own bucket, so photos are
        // metered as photos and normal chat is unaffected.
        //
        // WHAT THE REST TWIN ACTUALLY HAS. This comment used to say the REST
        // side was "capped by the body limit in server.js and 300 requests per
        // 15 minutes", and both halves were wrong. apiLimiter is 3000 per 15
        // minutes, not 300 — 200 requests a minute, per ADDRESS — so the number
        // that made REST look already handled overstated the protection by a
        // factor of ten, and that misreading is a direct cause of the hole
        // server.js's billed-image limiter was later written to close. There is
        // now a real per-image meter on that side: imageSpendLimiter in
        // server.js charges IMAGE_SCREENS_PER_WINDOW screens per window, keyed
        // on the verified ACCOUNT rather than the address, deliberately mirrored
        // off this very call site. __tests__/imageSpendLimits.test.js reads both
        // files and fails if one number moves without the other, so do not
        // change the literals below without reading it.
        //
        // The format and size checks are deliberately AHEAD of this bucket:
        // refusing a malformed or oversized frame costs nothing, so it should
        // not consume a token the user needs for a photo that would work.
        if (!allowEvent(socket, 'send_image', 10, 60_000)) {
          socket.emit('error', { message: 'Slow down a moment.' });
          return;
        }
        const verdict = await moderateImage(image_url, { userId: user.id });
        if (!verdict.allowed) {
          socket.emit('error', { message: imageRejectionMessage(verdict) });
          return;
        }
      }
      // The thumbnail rides only when its full image passed; moderated like
      // it, dropped on any failure. routes/messages.js documents the rule.
      let safeThumb = null;
      if (imageCheck) {
        const rawThumb = readImageThumb(data && data.thumb_url);
        if (rawThumb) {
          try {
            const thumbVerdict = await moderateImage(rawThumb, { userId: user.id });
            if (thumbVerdict.allowed) safeThumb = sanitizeStoredImage(rawThumb);
          } catch { /* no thumbnail */ }
        }
      }

      // Venue cards carry sender-controlled text and photo URLs — same
      // sanitizing as the REST path (round 8).
      const venueCheck = sanitizeVenueData(venue_data);
      if (!venueCheck.ok) {
        socket.emit('error', { message: VENUE_REJECTED_MESSAGE });
        return;
      }

      // Persist to database (membership was verified above, before the billed
      // image screen)
      const result = await pool.query(
        `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, image_url, thumb_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          flockId,
          user.id,
          message_text,
          safeType,
          venueCheck.data ? JSON.stringify(venueCheck.data) : null,
          // imageCheck is non-null exactly when a (validated, moderated) image
          // is present. Stored with its MIME re-typed from the sniffed bytes —
          // see restampImageMime above; the REST twin does the same.
          imageCheck ? sanitizeStoredImage(image_url) : null,
          safeThumb,
        ]
      );

      const message = result.rows[0];
      message.sender_name = user.name;
      // Oversized base64 avatars fan out to every member on every message —
      // drop them from the payload instead of amplifying them (REVIEW-ROUND5)
      message.sender_image =
        (user.profile_image_url && user.profile_image_url.length <= 12000)
          ? user.profile_image_url
          : null;
      message.reactions = [];

      // Fan out per-member instead of to the whole room, so mutual blocks are
      // honored live (the room broadcast let blocked users inject messages
      // into their blocker's open client — HTTP history filters them, sockets
      // didn't). Sender always gets their own echo.
      try {
        const flockInfo = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
        const flockName = flockInfo.rows[0]?.name || 'Flock';
        const members = await pool.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
          [flockId, user.id]
        );
        const invisible = new Set(await getInvisibleUserIds(user.id));
        const preview = (message_text || '').substring(0, 100);
        socket.emit('new_message', message);
        for (const m of members.rows) {
          if (invisible.has(m.user_id)) continue;
          io.to(`user:${m.user_id}`).emit('new_message', message);
          // Floating promise: a rejection here is an UNHANDLED rejection, which
          // Node 18+ turns into a process exit — the enclosing try only catches
          // what it awaits. The DM path already guards this way.
          pushIfOfflineDebounced(io, m.user_id,
            `${user.name} in ${flockName}`,
            preview,
            { type: 'flock_message', flockId: String(flockId) }
          ).catch(() => {});
        }
      } catch (fanoutErr) {
        // FAIL CLOSED (round 3): broadcasting to the room here would deliver
        // to blocked users exactly when the block filter is unavailable. The
        // message is persisted; other members get it from history on refresh.
        console.error('Message fan-out error (flock msg):', fanoutErr.message);
        socket.emit('new_message', message);
        socket.emit('error', { message: 'Message saved, but live delivery is delayed.' });
      }
    } catch (err) {
      console.error('send_message error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // --- Typing indicators ---

  // Round 23: both normalized with asId — see vote_venue's round 16 note. The
  // raw value was echoed to EVERY member's client: Postgres trims whitespace
  // casting to int, so '7' padded with kilobytes of spaces passed membership
  // for flock 7 and was then fanned out verbatim at 60 events per 10s — junk
  // amplification by member count, in a payload App.js discards anyway because
  // it compares flockId with === against the integer id.
  socket.on('typing', async (rawFlockId) => {
    if (!allowEvent(socket, 'typing', 60, 10_000)) return;
    const flockId = asId(rawFlockId);
    if (flockId === null) return;
    if (!(await verifyMembership(flockId, user.id))) return;
    await emitToFlockExcludingBlocked(io, flockId, user.id, 'user_typing', {
      userId: user.id,
      name: user.name,
      flockId,
    });
  });

  socket.on('stop_typing', async (rawFlockId) => {
    if (!allowEvent(socket, 'typing', 60, 10_000)) return;
    const flockId = asId(rawFlockId);
    if (flockId === null) return;
    if (!(await verifyMembership(flockId, user.id))) return;
    await emitToFlockExcludingBlocked(io, flockId, user.id, 'user_stopped_typing', {
      userId: user.id,
      flockId,
    });
  });

  // --- Venue voting ---

  socket.on('vote_venue', async (data) => {
    try {
      if (!allowEvent(socket, 'vote_venue', 30, 10_000)) return;
      // Round 16: `new_vote` has two producers — this handler and
      // routes/venues.js — and they disagreed on the shape of `flockId`. The
      // REST route sends `parseInt(flockId, 10)`; this one echoed whatever came
      // off the wire. App.js matches with `f.id !== data.flockId`, a strict
      // comparison against the integer id the API gave it, so a socket vote
      // carrying "42" produced an event every client silently discarded. Same
      // reasoning applies to select_venue and flock_invite_response below.
      const flockId = asId(data?.flockId);
      const venue_name = stripHtml(typeof data.venue_name === 'string' ? data.venue_name.trim() : '');
      // Round 9: the vote name is persisted and broadcast to the whole flock,
      // so it needs the same screen every other user-writable field gets.
      // 255 matches the VARCHAR(255) venue_id columns.
      const venue_id = typeof data.venue_id === 'string' ? data.venue_id.slice(0, 255) : null;

      // Validate inputs
      if (!flockId || !venue_name) {
        socket.emit('error', { message: 'Venue name is required' });
        return;
      }
      if (venue_name.length > 255) {
        socket.emit('error', { message: 'Venue name too long' });
        return;
      }
      if (!moderateText(venue_name).allowed) {
        socket.emit('error', { message: TEXT_REJECTED_MESSAGE });
        return;
      }

      if (!(await verifyMembership(flockId, user.id))) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      // One vote per user per flock. The unique key is
      // (flock_id, user_id, venue_name), so a plain INSERT let one person
      // accumulate a vote on every venue they ever tapped: switching picks
      // never cleared the previous row (round 10). Delete-then-insert in one
      // transaction, mirroring the REST route and the DM vote handler.
      //
      // Round 11: the transaction had no lock, so two rapid switches could both
      // DELETE before either INSERTed and both commit — the unique key is per
      // venue name, so the member ends up with two live votes. Serialize per
      // (flock, user) with the same advisory lock the REST route takes.
      const voteClient = await pool.connect();
      try {
        await voteClient.query('BEGIN');
        await voteClient.query(
          "SELECT pg_advisory_xact_lock(hashtext('flockvote:' || $1::text || ':' || $2::text))",
          [String(flockId), String(user.id)]
        );
        await voteClient.query(
          'DELETE FROM venue_votes WHERE flock_id = $1 AND user_id = $2 AND venue_name <> $3',
          [flockId, user.id, venue_name]
        );
        await voteClient.query(
          // Round 16: COALESCE, matching the REST route. Plain
          // `venue_id = EXCLUDED.venue_id` let a re-vote that arrived without a
          // place id (the client re-sends its current pick whenever the tally
          // changes) NULL out an id the row already had — which is how rows for
          // one venue ended up with mixed ids in the first place.
          `INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (flock_id, user_id, venue_name)
           DO UPDATE SET venue_id = COALESCE(EXCLUDED.venue_id, venue_votes.venue_id)`,
          [flockId, user.id, venue_name, venue_id]
        );
        await voteClient.query('COMMIT');
      } catch (txErr) {
        await voteClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        voteClient.release();
      }

      // Fetch updated vote tallies (ids kept internally so each recipient's
      // blocked users can be stripped from the names list — round 5)
      // Round 16: this grouped by (venue_name, venue_id). The unique key on
      // venue_votes is (flock_id, user_id, venue_name) — venue_id is NOT part
      // of it, and it is nullable — so two members voting for the same place
      // from different entry points (one row carries the Google place id, one
      // carries NULL) produced TWO groups with the same name. The flock then
      // saw "Joe's Bar 1" twice instead of "Joe's Bar 2", and the winner of a
      // vote could be a venue with fewer real supporters. Group by the name
      // alone (the thing the unique key is actually on) and keep one non-null
      // id as the group's representative.
      //
      // ROUND 18 — `new_vote` HAS TWO PRODUCERS AND THEY COUNTED DIFFERENTLY.
      // routes/venues.js collectVoteRows/tailorVotes builds the same event, and
      // opens with "every tally in this file comes from here so the REST
      // responses, the socket broadcasts and the GET all agree". They did not
      // agree, because this is a second tally that the file's comment does not
      // know about. Four differences, all visible on a phone:
      //
      //   - DEPARTED MEMBERS. Round 17 gave the REST tally a join on an
      //     accepted flock_members row, because POST /:id/leave deletes the
      //     membership and nothing else: a vote outlived its voter, their name
      //     stayed in the list, and they could not withdraw it (DELETE /vote
      //     requires membership). That is a public tally anyone can skew by
      //     joining, voting and leaving from a second account — and the winning
      //     venue is where the flock actually goes. The live path had none of
      //     it, so the skew simply worked over the socket instead.
      //   - GUEST VOTES. The REST tally adds guest-link votes (filtered by the
      //     guest_rsvps takedown flag) and surfaces guest_count so the UI can
      //     say "+2 guests"; venues only guests have voted for still appear.
      //     This one ignored guests entirely, so the live bars and the bars
      //     after a refresh ranked venues differently.
      //   - vote_count was `COUNT(*)`, which node-pg returns as a STRING for a
      //     bigint, while the REST payload's is a number.
      //   - the field guest_count was simply absent from this payload.
      //
      // One statement rather than two so the tally stays a single round trip.
      // The real fix is for both producers to share one module, the way
      // utils/places.js and utils/relationships.js collapsed their duplicated
      // rules — collectVoteRows lives in routes/, so that is not this file's to
      // do alone.
      const votes = await pool.query(
        `WITH member_votes AS (
           SELECT venue_name,
                  MIN(vv.venue_id) FILTER (WHERE vv.venue_id IS NOT NULL) AS venue_id,
                  COUNT(*)::int AS member_count,
                  ARRAY_AGG(json_build_object('id', u.id, 'name', u.name)) AS voter_rows
           FROM venue_votes vv
           JOIN users u ON u.id = vv.user_id
           JOIN flock_members fm ON fm.flock_id = vv.flock_id AND fm.user_id = vv.user_id
             AND fm.status = 'accepted'
           WHERE vv.flock_id = $1
           GROUP BY venue_name
         ), guest_tally AS (
           SELECT gv.venue_name, COUNT(*)::int AS guest_count
           FROM guest_votes gv
           JOIN guest_rsvps gr ON gr.id = gv.guest_rsvp_id
           WHERE gv.flock_id = $1 AND COALESCE(gr.is_hidden, false) = false
           GROUP BY gv.venue_name
         )
         SELECT COALESCE(m.venue_name, g.venue_name) AS venue_name,
                m.venue_id AS venue_id,
                COALESCE(m.member_count, 0) AS member_count,
                COALESCE(g.guest_count, 0) AS guest_count,
                COALESCE(m.voter_rows, '{}'::json[]) AS voter_rows
         FROM member_votes m
         FULL JOIN guest_tally g ON g.venue_name = m.venue_name`,
        [flockId]
      );

      const members = await pool.query(
        "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const memberIds = members.rows.map(r => r.user_id);
      const blockRows = memberIds.length
        ? await pool.query(
            'SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ANY($1::int[]) OR blocked_id = ANY($1::int[])',
            [memberIds]
          )
        : { rows: [] };
      const invisibleOf = (uid) => {
        const s = new Set();
        for (const b of blockRows.rows) {
          if (b.blocker_id === uid) s.add(b.blocked_id);
          if (b.blocked_id === uid) s.add(b.blocker_id);
        }
        return s;
      };
      // Same wire shape as routes/venues.js tailorVotes: vote_count is the total
      // the bars are drawn from (members + guests), guest_count lets the UI say
      // "+2 guests", and the ordering is applied AFTER the blend rather than in
      // SQL — a venue's rank must not depend on which producer built the event.
      const tailor = (invisible) => votes.rows
        .map(v => ({
          venue_name: v.venue_name,
          venue_id: v.venue_id,
          vote_count: v.member_count + v.guest_count,
          guest_count: v.guest_count,
          voters: (v.voter_rows || []).filter(p => !invisible.has(p.id)).map(p => p.name),
        }))
        .sort((a, b) => b.vote_count - a.vote_count);

      socket.emit('new_vote', { flockId, voter: { userId: user.id, name: user.name }, venue_name, votes: tailor(invisibleOf(user.id)) });
      for (const uid of memberIds) {
        if (uid === user.id) continue;
        const invisible = invisibleOf(uid);
        if (invisible.has(user.id)) continue;
        io.to(`user:${uid}`).emit('new_vote', { flockId, voter: { userId: user.id, name: user.name }, venue_name, votes: tailor(invisible) });
      }
    } catch (err) {
      console.error('vote_venue error:', err);
      socket.emit('error', { message: 'Failed to vote' });
    }
  });

  // --- Location sharing ---

  socket.on('update_location', async (data) => {
    try {
      if (!allowEvent(socket, 'update_location', 30, 10_000)) return;
      const { lat, lng } = data || {};
      const flockId = asId(data?.flockId); // round 23 — see vote_venue

      // Round 16: see isLatLng — `typeof NaN === 'number'`, so NaN/Infinity
      // used to reach every member's map as a JSON `null`.
      if (flockId === null || !isLatLng(lat, lng)) return;
      if (!(await verifyMembership(flockId, user.id))) return;

      // Exact coordinates never reach blocked users (round 3). Per-member
      // fan-out instead of room broadcast; fails closed by construction.
      const members = await pool.query(
        "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
        [flockId, user.id]
      );
      const invisible = new Set(await getInvisibleUserIds(user.id));
      const payload = { userId: user.id, name: user.name, lat, lng, timestamp: Date.now() };
      for (const m of members.rows) {
        if (invisible.has(m.user_id)) continue;
        io.to(`user:${m.user_id}`).emit('location_update', payload);
      }
    } catch (err) {
      console.error('update_location error:', err.message);
    }
  });

  // THE STOP MUST REACH EVERYONE THE PIN REACHED.
  //
  // update_location fans out to `user:{id}` for every accepted member, and it
  // does that deliberately (round 16: a room broadcast leaks to whoever is in
  // the room). Both stops were `flock:{id}` room broadcasts, and the flock room
  // holds only the sockets currently ON that chat screen.
  //
  // So a member sitting on the Map tab who never opened the chat received every
  // location_update - the client writes them into flockMemberLocations with no
  // flock scoping and renders them as markers - and then was not in the room to
  // hear the stop. The pin stayed on their map, green dot and all, for the rest
  // of the session. Same for anyone who opened the chat and navigated away.
  //
  // A pin that says a person is somewhere they left is the one failure this
  // feature must not have, so the stop now uses the pin's own audience. Blocks
  // are honoured the same way update_location honours them, and the sharer is
  // excluded in the query rather than by relying on socket.to().
  async function announceStoppedSharing(flockId) {
    const members = await pool.query(
      "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
      [flockId, user.id]
    );
    const invisible = new Set(await getInvisibleUserIds(user.id));
    for (const m of members.rows) {
      if (invisible.has(m.user_id)) continue;
      io.to(`user:${m.user_id}`).emit('member_stopped_sharing', { userId: user.id, flockId });
    }
  }

  socket.on('stop_sharing_location', async (data) => {
    // Round 16: update_location right above is metered at 30/10s; its
    // counterpart had no limit while doing the same verifyMembership query, so
    // it was the unmetered way to make the server run a query per packet.
    //
    // Round 16, second pass: its OWN bucket, not update_location's. Sharing one
    // meant a client streaming location at the allowed rate had already spent
    // the budget by the time it wanted to stop, so the "stop" was dropped and
    // every peer kept a stale pin on the map — a privacy regression introduced
    // by a rate limit meant to prevent load.
    if (!allowEvent(socket, 'stop_sharing_location', 30, 10_000)) return;
    const flockId = asId(data?.flockId); // round 23 — see vote_venue
    if (flockId === null) return;
    // Round 13: no membership check — update_location right above has one, but
    // its counterpart let any authenticated user fire `member_stopped_sharing`
    // into any flock room they could guess the id of.
    if (!(await verifyMembership(flockId, user.id))) return;
    // Round 17 made this block-aware; it was still addressed to the room
    // rather than to the people who actually got the pin. See
    // announceStoppedSharing above. Fails closed: a lookup that throws sends
    // nothing rather than sending to everyone.
    try {
      await announceStoppedSharing(flockId);
    } catch (err) {
      console.error('stop_sharing_location announce error:', err.message);
    }
  });

  // --- Friend request events ---

  // These events only RELAY state that the REST endpoints already persisted —
  // the DB row is verified first, so a bare socket emit can't fabricate a
  // friend request or response that never happened (round 4).
  //
  // Round 16: verifying the row was not enough. A friendship row stays
  // 'pending' until the recipient answers, and re-emitting is free — so one
  // attacker with ONE legitimately pending request could re-fire this at the
  // event budget (20 per 10s per socket, more per account) and ring the
  // victim's client indefinitely. The victim's only escape was to accept or
  // decline, i.e. to interact with their harasser. Nothing is written, so the
  // write budgets never covered it.
  //
  // The fix is a per-PAIR delivery ceiling rather than a tighter rate limit:
  // the event carries no new information the second time, because it announces
  // a state transition that has already happened. One delivery per pair per
  // transition is exactly right. See alreadyRelayed at module scope — it is
  // deliberately NOT per-socket, because a socket id is free and reconnecting
  // would otherwise reset the ceiling, which is the exact bypass the rate
  // buckets at the top of this file were rewritten to close.
  socket.on('friend_request_sent', async (data) => {
    if (!allowEvent(socket, 'friend_event', 20, 10_000)) return;
    const toUserId = asId(data?.toUserId);
    if (toUserId === null || toUserId === user.id) return;
    // Checked BEFORE the two queries, so a flood costs nothing downstream.
    if (alreadyRelayed(`req|${user.id}|${toUserId}`, user.id)) return;
    if (await isBlockedBetween(user.id, toUserId)) return;
    const row = await pool.query(
      `SELECT 1 FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
      [user.id, toUserId]
    );
    if (row.rows.length === 0) return;
    io.to(`user:${toUserId}`).emit('friend_request_received', {
      fromUserId: user.id,
      fromUserName: user.name,
    });
  });

  socket.on('friend_request_response', async (data) => {
    if (!allowEvent(socket, 'friend_event', 20, 10_000)) return;
    const { action } = data || {}; // action: 'accepted' | 'declined'
    const toUserId = asId(data?.toUserId);
    if (toUserId === null || toUserId === user.id || !['accepted', 'declined'].includes(action)) return;
    // An answered request is just as re-emittable as a pending one: 'accepted'
    // is a terminal state, so this would relay forever otherwise.
    if (alreadyRelayed(`res|${user.id}|${toUserId}|${action}`, user.id)) return;
    if (await isBlockedBetween(user.id, toUserId)) return;
    // The claimed outcome must match the persisted friendship state.
    const row = await pool.query(
      `SELECT 1 FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = $3`,
      [toUserId, user.id, action]
    );
    if (row.rows.length === 0) return;
    io.to(`user:${toUserId}`).emit('friend_request_responded', {
      fromUserId: user.id,
      fromUserName: user.name,
      action,
    });
  });

  // --- Flock invite events ---

  socket.on('flock_invite', async (data) => {
    try {
      if (!allowEvent(socket, 'flock_invite', 10, 10_000)) return;
      const { invitedUserIds } = data || {};
      const flockId = asId(data?.flockId); // round 23 — see vote_venue
      if (flockId === null || !Array.isArray(invitedUserIds) || invitedUserIds.length === 0 || invitedUserIds.length > 25) return;

      if (!(await verifyMembership(flockId, user.id))) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      const flockResult = await pool.query('SELECT id, name FROM flocks WHERE id = $1', [flockId]);
      if (flockResult.rows.length === 0) return;
      const flockName = flockResult.rows[0].name;

      // Relay persisted state only (round 5): each target must actually hold
      // an 'invited' membership row — otherwise any member could spoof-flood
      // invite toasts to arbitrary user ids.
      const invitedRows = await pool.query(
        // Round 23: asId per element, not Number/isInteger — Number.isInteger
        // is true for 1e20 and for 0, so those reached Postgres as an
        // out-of-int4-range value (a swallowed error) and an id no user holds.
        `SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'invited' AND user_id = ANY($2::int[])`,
        [flockId, invitedUserIds.map(asId).filter((n) => n !== null)]
      );
      for (const row of invitedRows.rows) {
        const uid = row.user_id;
        // Blocked users never see each other's invites
        if (await isBlockedBetween(user.id, uid)) continue;
        io.to(`user:${uid}`).emit('flock_invite_received', {
          flockId,
          flockName,
          invitedBy: { userId: user.id, name: user.name },
        });
      }

      // Echo the ids the DATABASE confirmed, never the array off the wire. The
      // raw list was relayed verbatim into every other client's state: 25
      // arbitrary attacker-chosen values (objects, huge strings, ids of people
      // who were never invited) amplified to the whole room.
      //
      // Round 18: and it names the inviter. Its REST twin (routes/flocks.js
      // POST /:id/invite) has fanned this event out per member skipping blocked
      // pairs since the takedown audit — __tests__/takedownLeaks.js pins it —
      // while the socket producer of the SAME event still handed the inviter's
      // name to anyone in the room who had blocked them. Two transports, one
      // event, one guard: same block-excluded broadcast as
      // flock_invite_responded below, delivery scope (room only) unchanged.
      // Fails closed, because an unreadable block list is not an empty one.
      let inviteInvisible;
      try {
        inviteInvisible = await getInvisibleUserIds(user.id);
      } catch (_) {
        return;
      }
      broadcastExcluding(socket.to(`flock:${flockId}`), inviteInvisible, 'flock_members_invited', {
        flockId,
        invitedBy: { userId: user.id, name: user.name },
        invitedUserIds: invitedRows.rows.map((r) => r.user_id),
      });
    } catch (err) {
      console.error('flock_invite error:', err);
    }
  });

  socket.on('flock_invite_response', async (data) => {
    try {
      if (!allowEvent(socket, 'invite_response', 10, 10_000)) return;
      const { action } = data;
      const flockId = asId(data?.flockId); // round 16 — see vote_venue
      if (flockId === null || !['accepted', 'declined'].includes(action)) return;
      // Round 3: any socket could broadcast fake RSVP activity into a guessed
      // flock id. Round 4: holding a row isn't enough — the persisted status
      // must MATCH the claimed action, so the event only relays what the REST
      // endpoint already recorded.
      const mem = await pool.query(
        'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [flockId, user.id]
      );
      if (mem.rows.length === 0 || mem.rows[0].status !== action) return;

      const flockResult = await pool.query('SELECT id, name FROM flocks WHERE id = $1', [flockId]);
      if (flockResult.rows.length === 0) return;

      // Round 17: this was the last identity-bearing flock-room broadcast that
      // did not obey blocks. `member_joined`/`member_offline` exclude blocked
      // users, and this event's REST twin (routes/flocks.js flock_invite_responded)
      // already fans out block-filtered — but a member who blocked the responder
      // still saw "<name> accepted" live, by name, over the socket path. Filter
      // the room broadcast the same way the disconnect handler does, keeping the
      // delivery scope (room only) unchanged. Fails closed: no toast beats a
      // leaked one, and REST + chat history still deliver it.
      let invisible;
      try {
        invisible = await getInvisibleUserIds(user.id);
      } catch (_) {
        return;
      }
      broadcastExcluding(io.to(`flock:${flockId}`), invisible, 'flock_invite_responded', {
        flockId,
        userId: user.id,
        userName: user.name,
        action,
      });
    } catch (err) {
      console.error('flock_invite_response error:', err);
    }
  });

  // --- Direct Messages (real-time) ---

  // Join a personal DM room so we can receive DMs
  socket.join(`user:${user.id}`);

  socket.on('send_dm', async (data) => {
    try {
      if (!allowEvent(socket, 'send_dm', 20, 10_000)) {
        socket.emit('error', { message: 'Slow down a moment.' });
        return;
      }
      const { message_type, venue_data, image_url, reply_to_id } = data;
      const text = stripHtml(typeof data.message_text === 'string' ? data.message_text.trim() : '');

      // Round 16: `receiverId` went to the database, to `isBlockedBetween`, to
      // `user:${receiverId}` and to the push helper exactly as it arrived off
      // the wire. Two concrete problems, both closed by normalizing once:
      //
      //   - a NON-INTEGER id ("5 ", "5abc", an object) either threw inside a
      //     query or — worse for "5 " — inserted fine (Postgres trims when
      //     casting to int) while `user: 5 ` matched no room, so the DM was
      //     stored and never delivered to anyone but the sender;
      //   - the id was never compared with the sender's own. POST /api/dm/:userId
      //     refuses a self-DM with a 400; the socket path happily persisted one
      //     and echoed it into the sender's other tabs.
      //
      // ROUND 18 — WHO MAY DM WHOM. What used to stand here was a reasoned
      // decision NOT to require a relationship, argued from the REST route:
      // "POST /api/dm/:userId admits ANY existing user, gated only by a mutual
      // block, so matching REST means closing the id-normalization divergences,
      // not narrowing DMs."
      //
      // That premise is now false. routes/messages.js POST /dm/:userId requires
      // hasDmRelationship and answers 403 NOT_CONNECTED_MESSAGE otherwise — it
      // was a directory walk otherwise, dropping a message into a stranger's
      // inbox for every id that resolved, and answering 404 for the ids that
      // did not. Closing it there and not here does not close it: the socket is
      // the transport the app actually sends on, and REST is its offline
      // fallback. So the hole simply moved to the primary path, on an app whose
      // users are 15-22.
      //
      // Both files also asserted, in prose, that this handler already had the
      // gate — utils/relationships.js opens with "sockets/handlers.js already
      // refuses to persist a DM ... between two accounts with no relationship".
      // Now it does.
      //
      // Checked BEFORE moderateImage: a Vision call is billed per image, and a
      // stranger who cannot deliver the message must not be able to spend money
      // finding that out. The receiver-exists lookup further down stays, but it
      // is no longer the only thing standing between an id and an inbox — and
      // note the ONE refusal deliberately covers both "no such user" and "not
      // connected", so neither can be read off the other.
      const receiverId = asId(data?.receiverId);
      if (receiverId === null || receiverId === user.id) return;

      // Same "text or an image" rule as the flock path above, for the same
      // reasons — and these two refusals now SAY something. They used to be
      // bare `return`s, so the message vanished server-side while the client sat
      // on a pending bubble that declared itself failed eight seconds later with
      // no reason attached. The REST twin answers 400 with a worded error for
      // both conditions; the silence was the divergence, not the rejection. (The
      // refusals above this line stay silent on purpose: whether an id exists,
      // and whether you are connected to it, must not be readable off the
      // response.)
      const dmImageCheck = checkInboundImage(image_url);
      if (!text && !dmImageCheck) {
        socket.emit('error', { message: EMPTY_MESSAGE });
        return;
      }
      if (text.length > 5000) {
        socket.emit('error', { message: MESSAGE_TOO_LONG_MESSAGE });
        return;
      }

      // Mutual block — no DMs in either direction.
      if (await isBlockedBetween(user.id, receiverId)) {
        socket.emit('error', { message: 'You can no longer message this user.' });
        return;
      }
      // An accepted friendship, or a conversation that already exists.
      if (!(await hasDmRelationship(user.id, receiverId))) {
        socket.emit('error', { message: NOT_CONNECTED_MESSAGE });
        return;
      }
      // UGC text filter (Apple 1.2).
      if (!moderateText(text).allowed) {
        socket.emit('error', { message: TEXT_REJECTED_MESSAGE });
        return;
      }

      const allowedTypes = ['text', 'venue_card', 'image'];
      const safeType = allowedTypes.includes(message_type) ? message_type : 'text';

      // Image safety (round 3): socket sends bypassed the moderation endpoint
      // entirely. Only data-URL images are accepted (no arbitrary remote URLs
      // that could track recipients), and every image is screened fail-closed
      // before it is stored or delivered.
      if (dmImageCheck) {
        if (!dmImageCheck.ok) {
          socket.emit('error', { message: dmImageCheck.message });
          return;
        }
        // Round 16: an image send was charged the same single token as a
        // one-word text message, and an image is not the same thing. Each one
        // costs a PAID Google Vision call (utils/moderation.js), a row holding
        // up to CHAT_IMAGE_MAX_BYTES, and that payload again for the recipient.
        // The socket path allowed 2 per second of a far larger payload with no
        // separate ceiling at all. Its own bucket, so photos are metered as
        // photos and normal chat is unaffected.
        //
        // WHAT THE REST TWIN ACTUALLY HAS — same correction as the flock-chat
        // send above, restated because this call site is read on its own. The
        // old text here claimed "the body limit in server.js and 300 requests
        // per 15 minutes"; apiLimiter is 3000 per 15 minutes (200 a minute, per
        // ADDRESS), and POST /api/dm/:userId is now metered per image by
        // imageSpendLimiter in server.js, keyed on the verified ACCOUNT and
        // sized off the literals below. Keep the two call sites identical:
        // __tests__/imageSpendLimits.test.js asserts they meter the same way.
        if (!allowEvent(socket, 'send_image', 10, 60_000)) {
          socket.emit('error', { message: 'Slow down a moment.' });
          return;
        }
        const verdict = await moderateImage(image_url, { userId: user.id });
        if (!verdict.allowed) {
          socket.emit('error', { message: imageRejectionMessage(verdict) });
          return;
        }
      }

      // Verify receiver exists
      const receiver = await pool.query('SELECT id, name FROM users WHERE id = $1', [receiverId]);
      if (receiver.rows.length === 0) return;

      // SECURITY: a reply may only reference a message from THIS conversation.
      // Without this check, any authenticated user could DM themselves an
      // arbitrary message ID and read someone else's private message text.
      // Round 16: normalized like every other id on this handler. The REST
      // twin runs `body('reply_to_id').optional().isInt()`; here a non-numeric
      // value threw inside the query and dropped the whole message with no
      // explanation to the sender. The tombstone twin rides with is_hidden
      // here exactly as it does on the REST route: this SELECT returns
      // message_text and the row is fanned out verbatim, so a reply to an
      // unsent message would re-broadcast the words unsend just removed.
      const replyToId = reply_to_id === undefined || reply_to_id === null ? null : asId(reply_to_id);
      let replyRow = null;
      if (reply_to_id !== undefined && reply_to_id !== null && replyToId === null) return;
      if (replyToId) {
        const replyResult = await pool.query(
          `SELECT dm.id, dm.message_text, u.name AS sender_name
           FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
           WHERE dm.id = $1
             AND COALESCE(dm.is_hidden, false) = false
             AND dm.sender_deleted_at IS NULL
             AND ((dm.sender_id = $2 AND dm.receiver_id = $3) OR (dm.sender_id = $3 AND dm.receiver_id = $2))`,
          [replyToId, user.id, receiverId]
        );
        replyRow = replyResult.rows[0] || null;
        if (!replyRow) {
          // Foreign, hidden, or nonexistent reply target. REST answers 400
          // here; the socket used to drop the message with nothing said.
          socket.emit('error', { message: 'That message is no longer there to reply to.' });
          return;
        }
      }

      // Same venue-card sanitizing as the flock send path (round 8).
      const dmVenueCheck = sanitizeVenueData(venue_data);
      if (!dmVenueCheck.ok) {
        socket.emit('error', { message: VENUE_REJECTED_MESSAGE });
        return;
      }

      // The thumbnail, under the same rule as every other door: moderated
      // like its image, dropped on any failure, never fatal.
      let dmSafeThumb = null;
      if (dmImageCheck) {
        const rawThumb = readImageThumb(data && data.thumb_url);
        if (rawThumb) {
          try {
            const thumbVerdict = await moderateImage(rawThumb, { userId: user.id });
            if (thumbVerdict.allowed) dmSafeThumb = sanitizeStoredImage(rawThumb);
          } catch { /* no thumbnail */ }
        }
      }

      // Persist to database
      const result = await pool.query(
        `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, venue_data, image_url, reply_to_id, thumb_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [user.id, receiverId, text, safeType, dmVenueCheck.data ? JSON.stringify(dmVenueCheck.data) : null,
          // Same re-typing as send_message: the stored MIME is the sniffed one.
          dmImageCheck ? sanitizeStoredImage(image_url) : null,
          replyRow ? replyToId : null,
          dmSafeThumb]
      );

      // This row IS the relationship (hasDmRelationship counts an existing DM),
      // so the cached "not connected" from a moment ago is now wrong. Without
      // this, the typing dots and live location on a brand new conversation sat
      // out the rest of the 30s TTL after the first message landed.
      invalidateDmRelationshipCache(user.id, receiverId);

      const msg = result.rows[0];
      msg.sender_name = user.name;
      // Same oversized-avatar guard as the flock send path (REVIEW-ROUND5)
      msg.sender_image =
        (user.profile_image_url && user.profile_image_url.length <= 12000)
          ? user.profile_image_url
          : null;
      msg.reactions = [];
      if (replyRow) msg.reply_to = replyRow;

      // Send to receiver's personal room
      socket.to(`user:${receiverId}`).emit('new_dm', msg);
      // Also send back to sender for confirmation
      socket.emit('new_dm', msg);

      // Push notification for offline DM recipient
      const preview = (text || '').substring(0, 100);
      pushIfOfflineDebounced(io, receiverId,
        user.name,
        preview,
        { type: 'dm_message', senderId: String(user.id) }
      ).catch(() => {});
    } catch (err) {
      console.error('send_dm error:', err);
      // send_message says so; this one swallowed it, and the sender waited out
      // the echo timer with no reason.
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // DM reactions (real-time)
  // DM reactions: the counterpart is DERIVED from the message row, never
  // trusted from the client, and mutual blocks apply (audit 2026-08-12).
  // Round 16: `emoji` was taken raw here. Anything longer than VARCHAR(10) was
  // a Postgres error swallowed by the catch — but the same value is echoed
  // straight back out in `dm_reaction_added`, so a non-string (object, array)
  // reached the counterpart's client verbatim before the insert ever failed.
  // normalizeEmoji is the socket copy of the REST validator; see module scope.
  //
  // Round 18 — TAKEDOWN PARITY. POST /api/dm/messages/:id/react looks the
  // message up with `AND COALESCE(is_hidden, false) = false` and answers 404
  // for a moderator-hidden DM; this lookup had no predicate at all, so the same
  // action simply succeeded over the other transport. A client holding the id
  // (every client that saw the message before it was taken down holds it) could
  // keep writing dm_emoji_reactions rows against hidden content and keep
  // pushing `dm_reaction_added` — naming the reactor — at the person the
  // takedown was meant to protect. A guard that only one of two transports has
  // is not a guard.
  //
  // REMOVAL stays ungated on purpose: see dm_remove_react below.
  socket.on('dm_react', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_react', 30, 10_000)) return;
      const dmId = asId(data?.dmId);
      const emoji = normalizeEmoji(data?.emoji);
      if (dmId === null || !emoji) return;

      const dm = await pool.query(
        `SELECT sender_id, receiver_id FROM direct_messages
         WHERE id = $1 AND COALESCE(is_hidden, false) = false
           AND sender_deleted_at IS NULL`,
        [dmId]
      );
      if (dm.rows.length === 0) return;
      if (dm.rows[0].sender_id !== user.id && dm.rows[0].receiver_id !== user.id) return;
      const counterpart = dm.rows[0].sender_id === user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
      if (await isBlockedBetween(user.id, counterpart)) return;

      await pool.query(
        `INSERT INTO dm_emoji_reactions (dm_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [dmId, user.id, emoji]
      );

      // The echo goes to the ACCOUNT's room, not back down this one socket.
      //
      // An account is explicitly several devices here: MAX_SOCKETS_PER_USER is
      // 8 and device tokens are stored per device, so the laptop with the web
      // app open and the phone in the hand are both live sockets sitting in
      // `user:{id}`. `socket.emit` reaches exactly one of them, the one that
      // sent the event, so a reaction tapped on the phone left the laptop
      // showing the old count until something made it re-read the thread.
      // POST /api/dm/messages/:id/react — the same action, the fallback the
      // client uses when its socket is DOWN — has always echoed with
      // `io.to(user:${req.user.id})` and reached every device, so the tap
      // worked properly only on the worse connection. `user:{id}` contains
      // this socket too, so the device that acted still gets its own copy.
      const payload = { dmId, emoji, userId: user.id, userName: user.name };
      socket.to(`user:${counterpart}`).emit('dm_reaction_added', payload);
      io.to(`user:${user.id}`).emit('dm_reaction_added', payload);
    } catch (err) {
      console.error('dm_react error:', err);
    }
  });

  // Deliberately NOT filtered on is_hidden, and the DELETE twin in
  // routes/messages.js is not either — cleaning up after a takedown is not
  // interaction with the content. Someone who reacted before a message was
  // hidden must still be able to take that reaction back; refusing here would
  // freeze their name onto content a moderator has removed. The row this
  // touches is the caller's OWN reaction (dm_id + user_id + emoji), it reads no
  // message text, and the event it emits carries no content.
  //
  // Sweep of every other row lookup on this file for the same missing
  // predicate (round 18, prompted by the dm_react gap above):
  //   - send_dm's reply-target lookup already filters
  //     `COALESCE(dm.is_hidden, false) = false`, so a hidden DM cannot be
  //     quoted back into the thread over the socket either;
  //   - the vote tally in vote_venue reads `guest_rsvps`, and it filters
  //     `COALESCE(gr.is_hidden, false) = false` — a guest whose RSVP a
  //     moderator removed must not still be moving the venue vote (and
  //     broadcastGuestRsvp receives an already-filtered payload from
  //     routes/guest.js, so it reads nothing itself);
  //   - nothing else here reads a moderatable row. The remaining lookups are
  //     users, flocks, flock_members, friendships, user_blocks, venue_votes,
  //     guest_votes, dm_venue_votes and venue_profiles — none of which carry
  //     is_hidden. `messages`, `stories`, `venue_reviews` and
  //     `venue_promotions` do, and no socket handler reads any of them.
  socket.on('dm_remove_react', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_react', 30, 10_000)) return;
      const dmId = asId(data?.dmId);
      const emoji = normalizeEmoji(data?.emoji);
      if (dmId === null || !emoji) return;

      const dm = await pool.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [dmId]);
      if (dm.rows.length === 0) return;
      if (dm.rows[0].sender_id !== user.id && dm.rows[0].receiver_id !== user.id) return;
      const counterpart = dm.rows[0].sender_id === user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
      // Blocks end all interaction, removals included (same as dm_react).
      if (await isBlockedBetween(user.id, counterpart)) return;

      await pool.query(
        'DELETE FROM dm_emoji_reactions WHERE dm_id = $1 AND user_id = $2 AND emoji = $3',
        [dmId, user.id, emoji]
      );

      const payload = { dmId, emoji, userId: user.id };
      socket.to(`user:${counterpart}`).emit('dm_reaction_removed', payload);
      // The account room rather than this socket, for the reason written out
      // over dm_react above. DELETE /api/dm/messages/:id/react/:emoji is the
      // twin, and it already echoes to `user:${req.user.id}`.
      io.to(`user:${user.id}`).emit('dm_reaction_removed', payload);
    } catch (err) {
      console.error('dm_remove_react error:', err);
    }
  });

  // DM venue voting (real-time)
  socket.on('dm_vote_venue', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_vote_venue', 30, 10_000)) return;
      const receiverId = asId(data?.receiverId);
      // Round 16: this was `parseInt(data.receiverId, 10)`, so "7abc" became 7.
      // Round 16: venue_name and venue_id went to the database and out to the
      // counterpart with no length clamp and no UGC screen, while the flock
      // twin (vote_venue, above) and dm_pin_venue both clamp AND screen. Both
      // columns are VARCHAR(255): an over-long name was a swallowed Postgres
      // error rather than a rejection, and a slur was simply accepted, which is
      // the exact Apple 1.2 gap the other two handlers were fixed for.
      const venue_name = stripHtml(typeof data?.venue_name === 'string' ? data.venue_name.trim() : '').slice(0, 255);
      const venue_id = typeof data?.venue_id === 'string' ? data.venue_id.slice(0, 255) : null;
      if (receiverId === null || receiverId === user.id || !venue_name) return;
      if (!moderateText(venue_name).allowed) {
        socket.emit('error', { message: TEXT_REJECTED_MESSAGE });
        return;
      }
      if (await isBlockedBetween(user.id, receiverId)) return;
      // Round 13: this wrote dm_venue_votes rows into any pair the caller named.
      if (!(await hasDmRelationship(user.id, receiverId))) return;

      const u1 = Math.min(user.id, receiverId);
      const u2 = Math.max(user.id, receiverId);

      // Round 16: read-then-write across three separate pool checkouts, so the
      // toggle raced exactly the way the flock vote did before round 11 — two
      // taps in flight could both see "no existing vote", both DELETE, and both
      // INSERT. UNIQUE is (pair, user, venue_name), so two DIFFERENT venue names
      // survive and one person holds two votes in a two-person conversation.
      // Same fix as vote_venue: one transaction, serialized on the pair+voter
      // with an advisory lock.
      const dmVoteClient = await pool.connect();
      try {
        await dmVoteClient.query('BEGIN');
        await dmVoteClient.query(
          "SELECT pg_advisory_xact_lock(hashtext('dmvote:' || $1::text || ':' || $2::text || ':' || $3::text))",
          [String(u1), String(u2), String(user.id)]
        );
        const existing = await dmVoteClient.query(
          `SELECT id FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3 AND venue_name = $4`,
          [u1, u2, user.id, venue_name]
        );
        // Either way the voter ends up with AT MOST one row in this pair: the
        // unconditional delete makes the toggle-off and the switch the same
        // statement, so no path can leave two behind.
        await dmVoteClient.query(
          `DELETE FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3`,
          [u1, u2, user.id]
        );
        if (existing.rows.length === 0) {
          await dmVoteClient.query(
            `INSERT INTO dm_venue_votes (user1_id, user2_id, user_id, venue_name, venue_id) VALUES ($1, $2, $3, $4, $5)`,
            [u1, u2, user.id, venue_name, venue_id]
          );
        }
        await dmVoteClient.query('COMMIT');
      } catch (txErr) {
        await dmVoteClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        dmVoteClient.release();
      }

      const votes = await pool.query(
        `SELECT venue_name, MIN(venue_id) FILTER (WHERE venue_id IS NOT NULL) AS venue_id, COUNT(*)::int AS vote_count, ARRAY_AGG(u.name) AS voters
         FROM dm_venue_votes vv JOIN users u ON u.id = vv.user_id
         WHERE vv.user1_id = $1 AND vv.user2_id = $2
         GROUP BY venue_name ORDER BY vote_count DESC`,
        [u1, u2]
      );

      // `withUserId` names the OTHER side of the conversation this tally
      // belongs to, and it is therefore different for each recipient. Without
      // it the event was unattributable: App.js keeps one vote list for
      // whichever DM is open, and `voter` is the sender in the copy that goes
      // out and the recipient themselves in the echo, so neither client could
      // tell whether an arriving tally was for the thread on screen. A vote in
      // any other conversation overwrote the list the user was looking at.
      const tally = { voter: { userId: user.id, name: user.name }, venue_name, votes: votes.rows };
      socket.to(`user:${receiverId}`).emit('dm_new_vote', { ...tally, withUserId: user.id });
      // The account room rather than this socket, for the reason written out
      // over dm_react above. Only the delivery changes: the two payloads stay
      // different, because each side has to be told who the OTHER side is, and
      // the voter's copy still names the receiver. There is no emit at all on
      // POST /api/dm/:userId/venue-votes; that route answers with the fresh
      // tally in its body, so over REST the acting device is served by the
      // response and there is nothing to echo. Over the socket there is no
      // response, which makes this the only thing the voter's other devices
      // ever hear.
      io.to(`user:${user.id}`).emit('dm_new_vote', { ...tally, withUserId: receiverId });
    } catch (err) {
      console.error('dm_vote_venue error:', err);
    }
  });

  // DM pin venue (real-time sync)
  socket.on('dm_pin_venue', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_pin_venue', 20, 10_000)) return;
      const { venue_name, venue_address, venue_id, venue_rating, venue_photo_url } = data;
      const receiverId = asId(data?.receiverId); // round 16: was parseInt, so "7abc" resolved to 7
      if (receiverId === null || receiverId === user.id || !venue_name) return;
      if (await isBlockedBetween(user.id, receiverId)) return;
      // Round 13: dm_pinned_venues upserts on the (user1, user2) pair, so
      // without this a stranger could overwrite two other people's pinned venue.
      if (!(await hasDmRelationship(user.id, receiverId))) return;
      const u1 = Math.min(user.id, receiverId);
      const u2 = Math.max(user.id, receiverId);
      const safeName = stripHtml(typeof venue_name === 'string' ? venue_name.trim() : '').slice(0, 255);
      // Round 8: same screen + photo-proxy-only rule as venue cards.
      if (!moderateText(safeName).allowed) return;
      const safeAddress = typeof venue_address === 'string' ? stripHtml(venue_address.trim()).slice(0, 512) : null;
      if (safeAddress && !moderateText(safeAddress).allowed) return;
      const safeVenueId = typeof venue_id === 'string' ? venue_id.slice(0, 256) : null;
      const safeRating = Number.isFinite(venue_rating) ? venue_rating : null;
      const safePhoto = safeVenuePhotoUrl(venue_photo_url);

      await pool.query(
        `INSERT INTO dm_pinned_venues (user1_id, user2_id, venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user1_id, user2_id) DO UPDATE SET
           venue_name = EXCLUDED.venue_name, venue_address = EXCLUDED.venue_address, venue_id = EXCLUDED.venue_id,
           venue_rating = EXCLUDED.venue_rating, venue_photo_url = EXCLUDED.venue_photo_url,
           pinned_by = EXCLUDED.pinned_by, updated_at = NOW()`,
        [u1, u2, safeName, safeAddress, safeVenueId, safeRating, safePhoto, user.id]
      );

      // Same per-recipient `withUserId` as dm_new_vote above, for the same
      // reason: `pinned_by` is the sender in both copies, so the echo the
      // sender gets back names themselves and identifies no conversation. The
      // pin is one slot in App.js keyed on the open thread, and this row
      // upserts on the PAIR, so an unattributable event meant a pin set in one
      // conversation redrew the card in whichever one happened to be open.
      const pin = { venue_name: safeName, venue_address: safeAddress, venue_id: safeVenueId, venue_rating: safeRating, venue_photo_url: safePhoto, pinned_by: user.id, pinned_by_name: user.name };
      socket.to(`user:${receiverId}`).emit('dm_venue_pinned', { ...pin, withUserId: user.id });
      // The account room rather than this socket, for the reason written out
      // over dm_react above, and the two payloads stay different for the reason
      // written out just here. PUT /api/dm/:userId/pinned-venue already echoes
      // to `user:${req.user.id}`, so a pin set from a phone redrew the card on
      // a laptop only when the phone had fallen back to HTTP.
      io.to(`user:${user.id}`).emit('dm_venue_pinned', { ...pin, withUserId: receiverId });
    } catch (err) {
      console.error('dm_pin_venue error:', err);
    }
  });

  // DM location sharing
  // Mutual-block enforcement on ephemeral DM events (audit 2026-08-12): these
  // previously trusted any receiverId, letting a blocked user ping typing/
  // location events into their blocker's client. Cached check keeps the
  // per-keystroke cost off the database.
  //
  // ROUND 24 — "NOT BLOCKED" WAS NEVER THE WHOLE GATE ON THESE FOUR.
  // Round 13 recorded a deliberate split: persisting DM handlers require a
  // relationship, "ephemeral handlers — typing, location — keep the cheaper
  // block-only check". That split was defensible while send_dm admitted any
  // existing user, because these four could then reach nobody a message could
  // not already reach. Round 18 closed send_dm (and the REST twin) behind
  // hasDmRelationship and did not come back for them, so the four handlers
  // below became the only way left to put yourself into a stranger's client:
  //
  //   * dm_share_location hands an arbitrary account your NAME and your live
  //     coordinates, and App.js writes them straight into the pin it draws for
  //     the person the user is actually talking to;
  //   * dm_stop_sharing_location clears that pin, so a stranger can also blank
  //     out the location of the friend the victim is genuinely tracking;
  //   * dm_typing puts a stranger's name behind "is typing" in an open thread.
  //
  // None of it is persisted, which is exactly why the write budgets never
  // covered it. The relationship check is the same one send_dm runs, through a
  // 30s pair cache (utils/relationships.js) so a per-keystroke event still does
  // not mean a per-keystroke query — the same trade isBlockedBetweenCached
  // already makes for the control right next to it. Block first, relationship
  // second: both are cached, and the block answer is the one that must not be
  // reachable around.
  // Round 16: all four of these took `receiverId` raw. Two consequences, and
  // the id is normalized here for both:
  //   - the value became part of isBlockedBetweenCached's cache key, so junk
  //     ids churned a fixed-size cache that real block decisions live in
  //     (utils/blocks.js clears the whole map at 5000 entries), costing extra
  //     database lookups for everybody else;
  //   - anything that was not exactly the id's canonical spelling produced a
  //     `user:{junk}` room name that matched nobody, so the event was silently
  //     lost rather than refused.
  // WHO IS CURRENTLY BEING SHOWN THIS SOCKET'S LOCATION IN A DM.
  //
  // The flock share has a disconnect path; the DM share had none. It is
  // symmetric only while both sides stay connected, and the far more likely end
  // of a DM share is that the sharer's connection simply goes - services/
  // socket.js tears the socket down the instant the app is backgrounded on
  // native. Their emit loop stops, no stop is ever sent, and the recipient's
  // dmMemberLocation is only cleared by dm_member_stopped_sharing or by
  // switching threads. The banner kept saying the other person was sharing,
  // indefinitely. Their React state does not survive a relaunch either, so they
  // never resume and never send the stop themselves.
  //
  // Per socket, so a second device sharing to the same peer is tracked on its
  // own connection, exactly like the flock rooms above.
  const dmSharingWith = new Set();

  socket.on('dm_share_location', async (data) => {
    if (!allowEvent(socket, 'dm_location', 30, 10_000)) return;
    const receiverId = asId(data?.receiverId);
    const { lat, lng } = data || {};
    if (receiverId === null || !isLatLng(lat, lng)) return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    if (!(await hasDmRelationshipCached(user.id, receiverId))) return;
    dmSharingWith.add(receiverId);
    socket.to(`user:${receiverId}`).emit('dm_location_update', {
      userId: user.id, name: user.name, lat, lng, timestamp: Date.now(),
    });
  });

  socket.on('dm_stop_sharing_location', async (data) => {
    if (!allowEvent(socket, 'dm_location', 30, 10_000)) return;
    const receiverId = asId(data?.receiverId);
    if (receiverId === null) return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    if (!(await hasDmRelationshipCached(user.id, receiverId))) return;
    dmSharingWith.delete(receiverId);
    socket.to(`user:${receiverId}`).emit('dm_member_stopped_sharing', { userId: user.id });
  });

  // DM typing indicators
  socket.on('dm_typing', async (data) => {
    if (!allowEvent(socket, 'dm_typing', 60, 10_000)) return;
    const receiverId = asId(data?.receiverId);
    if (receiverId === null) return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    if (!(await hasDmRelationshipCached(user.id, receiverId))) return;
    socket.to(`user:${receiverId}`).emit('dm_user_typing', {
      userId: user.id,
      name: user.name,
    });
  });

  socket.on('dm_stop_typing', async (data) => {
    if (!allowEvent(socket, 'dm_typing', 60, 10_000)) return;
    const receiverId = asId(data?.receiverId);
    if (receiverId === null) return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    if (!(await hasDmRelationshipCached(user.id, receiverId))) return;
    socket.to(`user:${receiverId}`).emit('dm_user_stopped_typing', {
      userId: user.id,
    });
  });

  // --- Venue confirmed by creator ---

  socket.on('select_venue', async (data) => {
    try {
      if (!allowEvent(socket, 'select_venue', 10, 10_000)) return;
      const flockId = asId(data?.flockId); // round 16 — see vote_venue
      if (flockId === null) return;
      // Round 9: these went straight from the wire into the flock row and the
      // broadcast. Clamp and screen them like every other venue text field.
      const venue_name = stripHtml(typeof data.venue_name === 'string' ? data.venue_name.trim() : '').slice(0, 255);
      const venue_address = typeof data.venue_address === 'string'
        ? stripHtml(data.venue_address.trim()).slice(0, 512) || null
        : null;
      const venue_id = typeof data.venue_id === 'string' ? data.venue_id.slice(0, 255) : null;

      if (!venue_name) {
        socket.emit('error', { message: 'Venue name is required' });
        return;
      }
      if (!moderateText(venue_name).allowed || (venue_address && !moderateText(venue_address).allowed)) {
        socket.emit('error', { message: TEXT_REJECTED_MESSAGE });
        return;
      }

      // Only the flock creator can confirm a venue
      const flock = await pool.query('SELECT creator_id FROM flocks WHERE id = $1', [flockId]);
      if (flock.rows.length === 0 || flock.rows[0].creator_id !== user.id) {
        socket.emit('error', { message: 'Only the flock creator can select a venue' });
        return;
      }

      await pool.query(
        `UPDATE flocks
         SET venue_name = $1, venue_address = $2, venue_id = $3, status = 'confirmed', updated_at = NOW()
         WHERE id = $4`,
        [venue_name, venue_address, venue_id, flockId]
      );

      // Round 18: `selected_by` carries the creator's name, and this was the
      // last identity-bearing broadcast on the file that reached the room
      // unfiltered. The precedent is settled in both directions — round 17 did
      // this to flock_invite_responded here, and routes/flocks.js already
      // block-filters flock_updated, which is the same thing (a plan state
      // change that names who made it). A member who blocked the flock creator
      // was still told, by name, the moment that creator confirmed the venue.
      // Fails closed; the venue itself still arrives on the next REST read, so
      // what a blocked member loses is the live toast, not the plan.
      let selectInvisible;
      try {
        selectInvisible = await getInvisibleUserIds(user.id);
      } catch (_) {
        return;
      }
      broadcastExcluding(io.to(`flock:${flockId}`), selectInvisible, 'venue_selected', {
        flockId,
        venue_name,
        venue_address,
        venue_id,
        selected_by: { userId: user.id, name: user.name },
      });
    } catch (err) {
      console.error('select_venue error:', err);
      socket.emit('error', { message: 'Failed to select venue' });
    }
  });

  // --- Crowd level updates (for venue owners) ---

  socket.on('crowd_update', async (data) => {
    try {
      if (!allowEvent(socket, 'crowd_update', 6, 60_000)) return;
      const { venue_id, level } = data; // level: 'low' | 'moderate' | 'busy' | 'packed'

      // Round 18: `!venue_id` was the whole check on the id, while join_venue
      // one section up refuses anything that is not shaped like a Google place
      // id before it will even subscribe to `venue:{id}`. Two handlers, one
      // decision — "what is a valid venue room" — and only one of them made it.
      // The gap is reachable through the `user.role === 'admin'` bypass below,
      // which skips the venue_profiles claim that is otherwise what guarantees
      // a real place id: an admin (or anyone holding an admin session) could
      // publish a crowd_update into an arbitrary room name that no client could
      // ever have subscribed to, and a non-string id reached Postgres as a
      // swallowed error instead of a refusal.
      const allowedLevels = ['low', 'moderate', 'busy', 'packed'];
      if (!isPlaceIdShaped(venue_id) || !allowedLevels.includes(level)) {
        socket.emit('error', { message: 'Invalid crowd update data' });
        return;
      }

      // Round 5: role alone is forgeable (venue onboarding self-assigns it).
      // The broadcaster must hold the VERIFIED claim on this exact venue.
      const claim = await pool.query(
        'SELECT 1 FROM venue_profiles WHERE user_id = $1 AND google_place_id = $2 AND verified = true',
        [user.id, venue_id]
      );
      if (claim.rows.length === 0 && user.role !== 'admin') {
        socket.emit('error', { message: 'Only the verified owner can update crowd levels' });
        return;
      }

      // Broadcast to clients watching this venue (its room, not the world).
      //
      // NEVER put a user identifier in this payload. `venue:{id}` is a public
      // feed — any authenticated account may subscribe to any known venue, and
      // that subscription is not filtered by blocks — so `updated_by: user.id`
      // published "this person is at this venue, right now" to anyone who
      // asked, including people they had blocked (audit 2026-08-14). Nothing
      // consumed it. Who set the level is available to the venue's own
      // dashboard through an authenticated REST route; it does not belong here.
      io.to(`venue:${venue_id}`).emit('crowd_update', {
        venue_id,
        level,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('crowd_update error:', err.message);
    }
  });

  // --- Cleanup on disconnect ---

  socket.on('disconnect', async () => {
    clearBuckets(socket);

    // The presence bookkeeping is decided FIRST and synchronously, so nothing
    // about it depends on the block lookup below succeeding.
    const departures = [];
    for (const [key, users] of roomUsers.entries()) {
      const wasPresent = users.get(socket.id);
      if (users.delete(socket.id)) {
        // Only report offline when the user has NO other socket in this room.
        const stillHere = [...users.values()].some((u) => u.userId === wasPresent.userId);
        if (!stillHere) {
          // `flockId` is the canonical integer join_flock stored (round 23),
          // which is what App.js's === comparisons against REST ids expect.
          departures.push({ key, flockId: wasPresent.flockId !== undefined ? wasPresent.flockId : key });
        }
      }
      if (users.size === 0) roomUsers.delete(key);
    }
    // THE DM HALF GOES FIRST, above the early return: a socket can be sharing
    // in a DM while holding no flock room at all, and `departures.length === 0`
    // ends this handler on the next line.
    //
    // Not block-filtered, deliberately. This peer is already looking at a live
    // pin of where this user is; clearing it can only reduce what they know,
    // and withholding it would leave the location on their screen. That is the
    // opposite trade from the flock presence events, which ADD identity.
    for (const receiverId of dmSharingWith) {
      io.to(`user:${receiverId}`).emit('dm_member_stopped_sharing', { userId: user.id });
    }
    dmSharingWith.clear();

    if (departures.length === 0) return;

    // Round 16: these two were the last identity-bearing broadcasts that did
    // not obey blocks. `member_joined` (join_flock) has excluded blocked users
    // since round 4/5 on the grounds that "presence is identity"; leaving did
    // not, so a blocked person never saw you arrive and then got told, by name,
    // the moment you went offline. ONE lookup for the whole disconnect, not one
    // per room — a disconnect is rare compared with a message, but a client
    // holding several flocks open should not cost several queries.
    let invisible;
    try {
      invisible = await getInvisibleUserIds(user.id);
    } catch (_) {
      return; // fail closed: no presence event beats a leaked one
    }
    const stoppedSharingFor = [];
    for (const { key, flockId } of departures) {
      broadcastExcluding(io.to(`flock:${key}`), invisible, 'member_offline', {
        userId: user.id,
        name: user.name,
        flockId,
      });
      // Also notify that location sharing stopped — to the pin's audience,
      // not the room's. A dropped connection is the MOST likely way a share
      // ends without a stop (socket.js tears the socket down the instant the
      // app is backgrounded on native), so this is the path a stale pin
      // actually arrives through.
      stoppedSharingFor.push(flockId);
    }
    for (const flockId of stoppedSharingFor) {
      try {
        const members = await pool.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
          [flockId, user.id]
        );
        for (const m of members.rows) {
          if (invisible.includes(m.user_id)) continue;
          io.to(`user:${m.user_id}`).emit('member_stopped_sharing', { userId: user.id, flockId });
        }
      } catch (err) {
        console.error('disconnect stop-sharing announce error:', err.message);
      }
    }
  });
}

module.exports = {
  registerHandlers,
  emitToFlockExcludingBlocked,
  // Round 16: exported so routes/ stops reaching for `io.to('flock:'+id)`.
  //
  // Round 18: the migration this note asked for is DONE. It used to read
  // "routes/flocks.js still emits flock_updated, flock_deleted,
  // flock_member_left and attendance_marked into the flock room; each of those
  // should become an emitToFlockMembers call" — all four now go through
  // emitToFlockExcludingBlocked, because each names an actor, and
  // __tests__/takedownLeaks.test.js greps flocks/messages/billing for any
  // surviving `io.to(\`flock:` and fails on one. routes/admin.js and
  // routes/billing.js are the current callers of this function.
  //
  // The `recipients` argument still exists for the one case the membership
  // query cannot serve: deleting a flock CASCADEs flock_members away, so a
  // flock_deleted has to capture its recipients BEFORE the delete.
  //
  // Still outstanding, and not this file's to change: routes/guest.js emits
  // `new_vote` straight into `flock:{id}`. It is anonymous (`voter:{guest:true}`)
  // so nothing leaks, but the room is not a membership list, so members who are
  // not looking at that flock never see the guest's vote arrive.
  emitToFlockMembers,
  // Round 22: routes/admin.js needs to reach the people holding a venue card,
  // and the room name is defined here rather than spelled in the route.
  emitToVenueContentViewers,
  VENUE_CONTENT_ROOM,
  broadcastGuestRsvp,
  // Exported for tests: the security-relevant decisions, isolated from timers
  // and from Socket.io.
  allowEvent,
  // Round 24: the global packet ceiling that sits in front of the per-event
  // ones, exported so a test can drive it without a real Socket.io socket.
  allowPacket,
  PACKETS_PER_WINDOW,
  PACKET_FLOOD_DISCONNECT,
  // Round 18: the relay ceiling is now bounded per account as well as globally,
  // and the per-account bound is only reachable over ten real minutes of live
  // traffic — so it is asserted against this function directly rather than
  // through a handler that the event rate limiter would gate first.
  alreadyRelayed,
  RELAY_NEW_KEYS_PER_USER,
  clearBuckets,
  trackUserSocket,
  evaluateSession,
  revalidateSession,
  staleFlockRooms,
  __resetRateLimiters,
  MAX_SOCKETS_PER_USER,
  USER_LIMIT_MULTIPLIER,
  // server.js sizes the REST body limit from this, so the two transports cannot
  // drift apart again without someone editing the number they share.
  CHAT_IMAGE_MAX_BYTES,
  checkInboundImage,
  // One byte-typer for every chat/story image write path — routes/messages.js
  // and routes/stories.js import it (never re-implement it), the same way they
  // import the constants above.
  restampImageMime,
  // What the write paths actually call: restamp, then strip EXIF/XMP/IPTC.
  sanitizeStoredImage,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_FORMAT_MESSAGE,
  EMPTY_MESSAGE,
  MESSAGE_TOO_LONG_MESSAGE,
};
