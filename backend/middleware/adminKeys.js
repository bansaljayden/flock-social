'use strict';
// ---------------------------------------------------------------------------
// ADMIN ACCESS KEYS
// ---------------------------------------------------------------------------
// Every admin route takes a signed-in session: requireAdmin in routes/admin.js
// reads req.user.role, and only a browser where the owner is signed in has a
// session to send. So an admin job (the waitlist launch email, a bill on the
// expense list) needed the owner at that browser. An admin access key is a
// second credential for the same routes, minted once from that browser and
// kept on the owner's computer, so a script there (tools/flock-admin/admin.mjs)
// can do the admin work on its own.
//
// WHAT A KEY IS. `flk_admin_` and 32 random bytes in base64url. The prefix is
// there so secret scanners can name it (tools/publish/scan-secrets.py has a
// rule for it) and so a request carrying one is told apart from a session
// before any token is verified. The server keeps SHA-256 of the key and
// nothing else (migration 135): a read of the database yields nothing that can
// be presented, and the key is shown once, in the answer that mints it.
//
// HOW A REQUEST WITH A KEY IS ANSWERED. middleware/auth.js hands every bearer
// that starts with the prefix to this file before it verifies anything, in
// all three of its variants, so no router can accept a key by accident:
//
//   * On the admin router (mounted at /api/admin), the key is looked up by its
//     hash and checked: not revoked, not expired, and still bound to an admin.
//     Then the route is checked against ADMIN_KEY_ROUTES below. A key that
//     passes acts as the admin who minted it: req.user is that account,
//     req.authVia is 'admin_key' and req.adminKey carries the key's id, name,
//     scopes and expiry.
//   * On a router that is only passing the request along to /api/admin (the
//     two bare /api catch-alls in server.js run authenticate on everything that
//     reaches them), the router is skipped with next('router'). Nothing in that
//     router sees the request, so no route there can ever run on a key.
//   * Everywhere else the key is refused with 403. A key never acts as its
//     owner in the social app: not on /api/users, not on a plan, not on a chat.
//     It cannot open a socket either, because the handshake verifies a JWT and
//     a key is not one.
//
// HOW A KEY IS MINTED, two ways, both from a signed-in admin session and never
// from a key (POST /api/admin/keys in routes/admin.js):
//
//   * From a session that signed in within ADMIN_KEY_MINT_FRESH_SECONDS. The
//     key works at once, and the owner is emailed that it was made.
//   * From an older session. The key is PENDING: it authenticates nothing, and
//     every route answers it 403 "awaiting approval". The owner's address gets
//     an email with an Approve link and a "This wasn't me" link
//     (services/adminKeyMail.js), carrying a one-use token that is stored as
//     its hash and dies after ADMIN_KEY_APPROVAL_MINUTES. Each link opens a
//     page and only the page's button acts (routes/keyApproval.js), so a mail
//     scanner that fetches every link approves and revokes nothing. Approving
//     takes no Flock session: holding the link is the proof of the mailbox,
//     which is the step up a fresh sign-in would otherwise be. A pending key
//     whose link ran out can never work.
//
// Every mint, approval and revoke is emailed to the owner.
//
// WHAT A KEY CAN REACH is ADMIN_KEY_ROUTES, and nothing else. It is an explicit
// list, not a prefix: a route added to routes/admin.js tomorrow is refused to a
// key until somebody adds it here, and __tests__/adminAccessKeys.test.js fails
// until every admin route is on one of the two lists. ADMIN_KEY_REFUSED_ROUTES
// names the admin routes a key may never reach and why. The rule behind the
// split: a key may read the admin surfaces and keep the books, and it may not
// change what any account is allowed to do, mint a credential, or open
// reported content. Minting and listing keys take a person signed in.
//
// WHAT IS WRITTEN DOWN. Every use of a real key lands in admin_key_uses: the
// method, the path (never the query string), the answer's status, the time and
// the caller's address. A use that reaches a route is written BEFORE the route
// runs, so a use that could not be logged is a use that did not happen, and
// its status is written when the answer goes out. A refused use is written
// with the reason, up to ADMIN_KEY_REFUSALS_LOGGED_PER_HOUR a key each hour so
// a replayed dead key cannot fill the table. A key nobody minted is logged to
// the console only, by address: there is no key to attach it to, and a
// database row per guess would hand anyone a way to fill the table.
//
// WHAT ENDS A KEY. Its expiry (90 days by default, 180 at most); a revoke, from
// the dashboard, by the key itself, or from the "This wasn't me" link; an
// approval link that runs out before a pending key is approved; and anything
// that ends the owner's
// sessions: the key carries users.token_version from the moment it was minted,
// so a password change, a reset, sign out everywhere or an account claim ends
// every key minted before it. A key also stops the moment its owner is no
// longer an admin or is banned, and goes with the account if it is deleted.
//
// RATE LIMITS are the ones the routes already have. A key request is charged
// to apiLimiter on /api/admin like any other, keyed by address, and the global
// backstop sees it the same way. A key is 256 bits, so guessing one is not a
// thing a ceiling has to stop.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const pool = require('../config/database');
const { stripHtml } = require('../utils/sanitize');

const ADMIN_KEY_PREFIX = 'flk_admin_';
const ADMIN_KEY_RANDOM_BYTES = 32;
// 32 bytes in base64url is 43 characters, with no padding.
const ADMIN_KEY_SHAPE = /^flk_admin_[A-Za-z0-9_-]{43}$/;

const ADMIN_KEY_DEFAULT_DAYS = 90;
const ADMIN_KEY_MAX_DAYS = 180;
const ADMIN_KEY_NAME_MAX = 60;
// Live keys one admin may hold at once. A tool per machine is a handful; ten
// is room for that with a ceiling on a runaway script that mints in a loop.
const ADMIN_KEY_ACTIVE_MAX = 10;
// A key outlives the session that mints it by months, so a key works at once
// only when it is minted within this long of a sign-in. A session renewed for
// weeks carries the time it actually signed in (auth_time), so an old session,
// or a token lifted from one, mints a PENDING key instead, which works only
// once the owner approves it from the email.
const ADMIN_KEY_MINT_FRESH_SECONDS = 15 * 60;
// How long an approval link lives, and how many pending keys one account may
// have waiting at once, which bounds the approval emails an old session can
// make the server send.
const ADMIN_KEY_APPROVAL_MINUTES = 15;
const ADMIN_KEY_PENDING_MAX = 3;
// An approval token is 32 random bytes in base64url, like the key.
const APPROVAL_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_KEY_LIST_LIMIT = 50;
const ADMIN_KEY_RECENT_USES = 5;
// Refused uses written down per key per hour. A key that leaked and was then
// revoked can still be replayed, and every replay is a refusal; past this many
// in an hour the rest are refused without a row, so the log says the key is
// being tried without a stranger being able to fill the table. Uses that
// reach a route are never capped here: the route's own rate limit bounds them.
const ADMIN_KEY_REFUSALS_LOGGED_PER_HOUR = 200;

// The scopes a key can carry, with what each one covers. One for now; the
// table's CHECK refuses any word not listed here (migration 135).
const ADMIN_KEY_SCOPES = Object.freeze({
  admin: 'The admin routes in ADMIN_KEY_ROUTES, read and write.',
});
const DEFAULT_SCOPES = Object.freeze(['admin']);

const ADMIN_MOUNT = '/api/admin';

// EVERY ROUTE A KEY CAN REACH. Method and path, matched exactly; `:id` is a
// whole number. `self` means the id must be the key's own.
const ADMIN_KEY_ROUTES = Object.freeze([
  { method: 'GET', path: '/api/admin/whoami', scope: 'admin', why: 'Who the key acts as, and when it expires.' },
  { method: 'GET', path: '/api/admin/money', scope: 'admin', why: 'The money hub.' },
  { method: 'GET', path: '/api/admin/costs', scope: 'admin', why: 'The cost panel.' },
  { method: 'POST', path: '/api/admin/costs/reconciled', scope: 'admin', why: "A vendor's bill recorded against a reconciled cost line." },
  { method: 'GET', path: '/api/admin/expenses', scope: 'admin', why: 'The expense list.' },
  { method: 'GET', path: '/api/admin/expenses/export', scope: 'admin', why: 'The expense list as CSV.' },
  { method: 'POST', path: '/api/admin/expenses', scope: 'admin', why: 'A bill added to the list.' },
  { method: 'POST', path: '/api/admin/expenses/import', scope: 'admin', why: 'The whole list pasted at once.' },
  { method: 'PUT', path: '/api/admin/expenses/:id', scope: 'admin', why: 'A bill edited, or marked stopped.' },
  { method: 'DELETE', path: '/api/admin/expenses/:id', scope: 'admin', why: 'A bill entered by mistake, removed.' },
  { method: 'POST', path: '/api/admin/waitlist/announce', scope: 'admin', why: 'The waitlist launch email, and its dry run.' },
  { method: 'GET', path: '/api/admin/analytics', scope: 'admin', why: 'The Research tab.' },
  { method: 'GET', path: '/api/admin/reports', scope: 'admin', why: 'The moderation queue, read only.' },
  { method: 'GET', path: '/api/admin/moderation-actions', scope: 'admin', why: 'The moderation audit log, read only.' },
  { method: 'GET', path: '/api/admin/venues/unverified', scope: 'admin', why: 'The venue verification queue, read only.' },
  { method: 'DELETE', path: '/api/admin/keys/:id', scope: 'admin', self: true, why: 'The key revoking itself. Any other id is refused.' },
]);

// THE ADMIN ROUTES A KEY MAY NEVER REACH, and why. Refusal does not depend on
// this list (anything not in ADMIN_KEY_ROUTES is refused); it exists so every
// admin route has a written decision, and the test holds the two lists to the
// router.
const ADMIN_KEY_REFUSED_ROUTES = Object.freeze([
  { method: 'POST', path: '/api/admin/keys', why: 'Minting a key takes a person signed in. A key never makes another key.' },
  { method: 'GET', path: '/api/admin/keys', why: 'A key cannot list keys.' },
  { method: 'PUT', path: '/api/admin/reports/:id', why: 'Moderation decisions ban and unban accounts, which ends or restores their sessions, and hide or restore content. They stay with a person at the console.' },
  { method: 'GET', path: '/api/admin/reports/:id/image', why: "Reported photos, which can come from a minor's camera roll, are opened by a person, and each opening is recorded against that person." },
  { method: 'GET', path: '/api/admin/reports/:id/content', why: 'Reported content in full, on the same rule as the photos.' },
  { method: 'PUT', path: '/api/admin/venues/:profileId/verify', why: 'Verification decides who may speak as a business, a permission on another account.' },
  { method: 'POST', path: '/api/admin/venues/:userId/tier', why: 'A tier changes what a venue account is entitled to.' },
  { method: 'GET', path: '/api/admin/venues/tag-url', why: 'It mints an NFC tag signature, a credential that verifies check-ins.' },
]);

// What a refused or dead key is told. None of these names the key.
const KEY_WORDS = Object.freeze({
  invalid: 'That admin key is not valid.',
  revoked: 'This admin key was revoked.',
  expired: 'This admin key has expired. Mint a new one from a signed-in browser.',
  ended: 'This admin key has ended: its account signed out everywhere, changed its password, or is no longer an admin.',
  pending: "This admin key is awaiting approval. Tap Approve in the email sent to the account's address.",
  unapproved: 'This admin key was never approved, and its approval link has expired. Mint a new one.',
  route: 'An admin key cannot reach this route.',
  notSelf: 'An admin key can revoke only itself.',
  offAdmin: 'An admin key works on admin routes only. It cannot act as its owner anywhere else in the app.',
  unlogged: 'The use could not be logged, so the key was not used. Try again.',
});

// ---------------------------------------------------------------------------
// The key itself
// ---------------------------------------------------------------------------

function generateAdminKey() {
  return ADMIN_KEY_PREFIX + crypto.randomBytes(ADMIN_KEY_RANDOM_BYTES).toString('base64url');
}

function hashAdminKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

function isAdminKeyShape(value) {
  return typeof value === 'string' && ADMIN_KEY_SHAPE.test(value);
}

// The bearer, when it is an admin key, read the way middleware/auth.js reads
// every bearer (`header.split(' ')[1]`), so the two can never see different
// strings in one header. Anything starting with the prefix is a key attempt,
// well formed or not: it is answered here and never reaches jwt.verify.
function adminKeyBearer(req) {
  const header = req && req.headers ? req.headers.authorization : undefined;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.split(' ')[1];
  return typeof token === 'string' && token.startsWith(ADMIN_KEY_PREFIX) ? token : null;
}

// ---------------------------------------------------------------------------
// Where a key request is, and whether it may be there
// ---------------------------------------------------------------------------

// The router handling this request is the admin router. req.baseUrl is the
// mount Express matched (lower-cased here, as Express matches mounts without
// regard to case).
function onAdminMount(req) {
  return String(req.baseUrl || '').toLowerCase().replace(/\/+$/, '') === ADMIN_MOUNT;
}

// This request is on its way to the admin router: a catch-all mounted at /api
// is running its authenticate on a path under /api/admin.
function boundForAdminMount(req) {
  const p = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  return p === ADMIN_MOUNT || p.startsWith(`${ADMIN_MOUNT}/`);
}

// The path a key request is judged on: the mount and the path Express routed,
// lower case, one trailing slash dropped. A key's requests come from a script,
// so a path that is not plain (a doubled slash, an escape, a dot segment) is
// refused rather than interpreted.
const PLAIN_PATH = /^(?:\/[a-z0-9_-]+)+$/;

function keyRequestPath(req) {
  let p = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function compileRoute(template) {
  const source = template
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '(\\d{1,10})' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

const COMPILED_ROUTES = ADMIN_KEY_ROUTES.map((r) => ({ ...r, re: compileRoute(r.path) }));

// { allowed, rule, notSelf }. Scopes are checked too: a key reaches a route
// only if it carries the route's scope.
function keyRouteDecision(method, path, key) {
  const scopes = key && Array.isArray(key.scopes) ? key.scopes : [];
  if (typeof path !== 'string' || !PLAIN_PATH.test(path)) return { allowed: false };
  for (const r of COMPILED_ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    if (!scopes.includes(r.scope)) return { allowed: false, rule: r };
    if (r.self && !(key && Number(m[1]) === Number(key.id))) return { allowed: false, rule: r, notSelf: true };
    return { allowed: true, rule: r };
  }
  return { allowed: false };
}

// ---------------------------------------------------------------------------
// Looking a key up, and writing its uses down
// ---------------------------------------------------------------------------

// `expired` and `approval_open` are read off the database clock, the one the
// deadlines were written with, so the server's own clock cannot stretch a key.
const KEY_LOOKUP_SQL = `SELECT k.id, k.name, k.key_hash, k.scopes, k.session_version, k.created_at, k.expires_at,
          k.revoked_at, k.approved_at, (k.expires_at <= NOW()) AS expired,
          (k.approval_expires_at > NOW()) AS approval_open,
          u.id AS user_id, u.email, u.name AS user_name, u.role, u.email_verified, u.is_banned, u.token_version
     FROM admin_access_keys k
     JOIN users u ON u.id = k.created_by
    WHERE k.key_hash = $1`;

// One statement for the key's last use and the log row, so a use is never on
// one and missing from the other.
// The key must still be live and approved at this statement too, so a revoke
// that lands between the lookup and here wins: nothing is written, and the use
// is refused.
const USE_INSERT_SQL = `WITH used AS (
       UPDATE admin_access_keys SET last_used_at = NOW(), last_used_ip = $2::text
        WHERE id = $1::int AND revoked_at IS NULL AND approved_at IS NOT NULL AND expires_at > NOW()
        RETURNING id
     )
     INSERT INTO admin_key_uses (key_id, method, route, ip)
     SELECT id, $3::text, $4::text, $2::text FROM used
     RETURNING id`;

const USE_STATUS_SQL = `UPDATE admin_key_uses SET status = $2 WHERE id = $1 AND status IS NULL`;

// Written only while this key has fewer than $7 refusals in the last hour
// (ADMIN_KEY_REFUSALS_LOGGED_PER_HOUR), counted on the (key_id, used_at) index.
const REFUSAL_INSERT_SQL = `INSERT INTO admin_key_uses (key_id, method, route, status, ip, refused)
     SELECT $1::int, $2::text, $3::text, $4::smallint, $5::text, $6::text
      WHERE (SELECT COUNT(*) FROM admin_key_uses
              WHERE key_id = $1::int AND refused IS NOT NULL AND used_at > NOW() - INTERVAL '1 hour') < $7::int`;

// What one use is written as. The path only, never the query string, which a
// caller can fill with anything; all three bounded to their columns.
function useContext(req) {
  const route = `${req.baseUrl || ''}${req.path || ''}` || '/';
  return {
    method: String(req.method || '?').slice(0, 10),
    route: route.slice(0, 200),
    ip: req.ip ? String(req.ip).slice(0, 64) : null,
  };
}

async function lookupKey(token) {
  if (!isAdminKeyShape(token)) return null;
  const presented = hashAdminKey(token);
  const { rows } = await pool.query(KEY_LOOKUP_SQL, [presented]);
  const row = rows[0];
  if (!row) return null;
  // The row was found BY this hash, so this compare is belt and braces. It is
  // constant-time anyway: nothing about a key is ever compared any other way.
  const a = Buffer.from(String(row.key_hash), 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

// Why a key that exists cannot act, or null. token_version is compared with
// middleware/auth.js's own rule, required lazily because that file requires
// this one. An ended key stays ended whatever else is true of it, so a key that
// was pending when its account signed out everywhere reads as ended, and the
// approval page refuses it the same way.
function deadReason(row) {
  const { tokenVersionOf } = require('./auth');
  if (row.revoked_at) return 'revoked';
  if (row.expired === true) return 'expired';
  if (tokenVersionOf(row.session_version) !== tokenVersionOf(row.token_version)) return 'ended';
  if (row.role !== 'admin' || row.is_banned === true) return 'ended';
  if (!row.approved_at) return row.approval_open === true ? 'pending' : 'unapproved';
  return null;
}

// A pending key is refused as forbidden (the key is real and waiting); every
// other dead key as unauthenticated.
const DEAD_STATUS = (reason) => (reason === 'pending' ? 403 : 401);

function refuseDead(res, reason) {
  const body = { error: KEY_WORDS[reason] };
  if (reason === 'pending') body.adminKeyPending = true;
  return res.status(DEAD_STATUS(reason)).json(body);
}

async function recordRefusal(keyId, ctx, status, reason) {
  try {
    await pool.query(REFUSAL_INSERT_SQL, [keyId, ctx.method, ctx.route, status, ctx.ip, reason, ADMIN_KEY_REFUSALS_LOGGED_PER_HOUR]);
  } catch (err) {
    console.error(`[admin-key] key ${keyId}: a refused use (${reason}) could not be logged: ${err.message}`);
  }
}

async function recordUse(keyId, ctx) {
  const { rows } = await pool.query(USE_INSERT_SQL, [keyId, ctx.ip, ctx.method, ctx.route]);
  return rows[0] ? rows[0].id : null;
}

// The status goes on the row when the answer is sent. A client that hangs up
// before then leaves it empty, which reads as "no answer went out".
function recordStatusOnFinish(res, useId) {
  res.once('finish', () => {
    pool.query(USE_STATUS_SQL, [useId, res.statusCode])
      .catch((err) => console.error(`[admin-key] use ${useId}: the status was not logged: ${err.message}`));
  });
}

function refuseUnknown(req, res) {
  console.warn(`[admin-key] a key that matches no admin key, from ${req.ip}, on ${req.method} ${useContext(req).route}`);
  return res.status(401).json({ error: KEY_WORDS.invalid });
}

// ---------------------------------------------------------------------------
// The three answers middleware/auth.js hands a key to
// ---------------------------------------------------------------------------

// On the admin router.
async function authenticateAdminKey(req, res, next, token) {
  const ctx = useContext(req);
  let row;
  try {
    row = await lookupKey(token);
  } catch (err) {
    console.error('[admin-key] lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
  if (!row) return refuseUnknown(req, res);

  const dead = deadReason(row);
  if (dead) {
    await recordRefusal(row.id, ctx, DEAD_STATUS(dead), dead);
    return refuseDead(res, dead);
  }

  const decision = keyRouteDecision(req.method, keyRequestPath(req), { id: row.id, scopes: row.scopes });
  if (!decision.allowed) {
    await recordRefusal(row.id, ctx, 403, 'route');
    return res.status(403).json({ error: decision.notSelf ? KEY_WORDS.notSelf : KEY_WORDS.route, adminKeyRefused: true });
  }

  let useId;
  try {
    useId = await recordUse(row.id, ctx);
  } catch (err) {
    console.error(`[admin-key] key ${row.id}: the use could not be logged, so it was refused: ${err.message}`);
    return res.status(503).json({ error: KEY_WORDS.unlogged });
  }
  // The key was revoked, ran out or went with its account between the lookup
  // and the write.
  if (!useId) return res.status(401).json({ error: KEY_WORDS.invalid });
  recordStatusOnFinish(res, useId);

  // The same fields authenticate puts on req.user for a session.
  req.user = {
    id: row.user_id,
    email: row.email,
    name: row.user_name,
    role: row.role,
    email_verified: row.email_verified,
    is_banned: row.is_banned,
    token_version: row.token_version,
  };
  req.authVia = 'admin_key';
  req.adminKey = {
    id: row.id,
    name: row.name,
    scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  // A key is not a sign-in, so nothing that asks how recent the sign-in was
  // can be satisfied by one.
  req.tokenIssuedAt = null;
  return next();
}

// Anywhere that is not the admin router. Always a refusal; the lookup is only
// so the refusal can be written against the key that was tried.
async function refuseAdminKeyOffAdmin(req, res, token) {
  const ctx = useContext(req);
  let row;
  try {
    row = await lookupKey(token);
  } catch (err) {
    console.error('[admin-key] lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
  if (!row) return refuseUnknown(req, res);
  const dead = deadReason(row);
  if (dead) {
    await recordRefusal(row.id, ctx, DEAD_STATUS(dead), dead);
    return refuseDead(res, dead);
  }
  await recordRefusal(row.id, ctx, 403, 'route');
  return res.status(403).json({ error: KEY_WORDS.offAdmin, adminKeyRefused: true });
}

// The one entry point middleware/auth.js calls for a key bearer.
function handleAdminKeyBearer(req, res, next, token) {
  if (onAdminMount(req)) return authenticateAdminKey(req, res, next, token);
  if (boundForAdminMount(req)) return next('router');
  return refuseAdminKeyOffAdmin(req, res, token);
}

// ---------------------------------------------------------------------------
// Minting, listing and revoking, for routes/admin.js
// ---------------------------------------------------------------------------

// What a key is, as the routes show it. Never the key and never its hash. A
// key never approved reads as pending while its approval link lives and as
// expired after, because then it can never work.
function keyState(row, now = Date.now()) {
  const { tokenVersionOf } = require('./auth');
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return 'expired';
  if (row.token_version !== undefined
    && tokenVersionOf(row.session_version) !== tokenVersionOf(row.token_version)) return 'ended';
  if (row.role !== undefined && (row.role !== 'admin' || row.is_banned === true)) return 'ended';
  if (!row.approved_at) {
    const open = row.approval_expires_at && new Date(row.approval_expires_at).getTime() > now;
    return open ? 'pending' : 'expired';
  }
  return 'active';
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

function keyMetadata(row, now = Date.now()) {
  return {
    id: Number(row.id),
    name: row.name,
    scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
    createdAt: iso(row.created_at),
    createdIp: row.created_ip || null,
    expiresAt: iso(row.expires_at),
    approvedAt: iso(row.approved_at),
    approvedVia: row.approved_via || null,
    approvalExpiresAt: row.approved_at ? null : iso(row.approval_expires_at),
    lastUsedAt: iso(row.last_used_at),
    lastUsedIp: row.last_used_ip || null,
    revokedAt: iso(row.revoked_at),
    revokedVia: row.revoked_via || null,
    state: keyState(row, now),
  };
}

// The body POST /api/admin/keys takes: { name, days }. Returns { name, days }
// or { error }.
function readMintBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof b.name !== 'string') return { error: 'name is required: a few words for where the key will live, such as "PC tools".' };
  // Markup out and whitespace folded, the way every typed name in the app is
  // stored, so the dashboard shows the words that were meant.
  const name = stripHtml(b.name).replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > ADMIN_KEY_NAME_MAX) {
    return { error: `name must be 1 to ${ADMIN_KEY_NAME_MAX} characters` };
  }
  let days = ADMIN_KEY_DEFAULT_DAYS;
  if (b.days !== undefined && b.days !== null) {
    if (!Number.isInteger(b.days) || b.days < 1 || b.days > ADMIN_KEY_MAX_DAYS) {
      return { error: `days must be a whole number from 1 to ${ADMIN_KEY_MAX_DAYS}` };
    }
    days = b.days;
  }
  return { name, days };
}

// Seconds since the session that sent this request signed in, or null when
// it cannot be told (req.tokenIssuedAt, set by middleware/auth.js).
function sessionAgeSeconds(req, nowMs = Date.now()) {
  const at = req.tokenIssuedAt;
  if (!Number.isInteger(at) || at <= 0) return null;
  return Math.floor(nowMs / 1000) - at;
}

// True when a mint from this request works at once: a session, signed in
// within ADMIN_KEY_MINT_FRESH_SECONDS. A clock skew that puts the sign-in a
// moment in the future counts as fresh, as it does in routes/users.js.
function isFreshSession(req, nowMs = Date.now()) {
  const age = sessionAgeSeconds(req, nowMs);
  return age !== null && age <= ADMIN_KEY_MINT_FRESH_SECONDS;
}

function generateApprovalToken() {
  return crypto.randomBytes(ADMIN_KEY_RANDOM_BYTES).toString('base64url');
}

function isApprovalTokenShape(value) {
  return typeof value === 'string' && APPROVAL_TOKEN_SHAPE.test(value);
}

const MINT_LOCK_SQL = 'SELECT id FROM users WHERE id = $1 FOR UPDATE';
// Live: approved and not ended by its own dates, or still waiting inside its
// approval window. A pending key whose window closed counts as neither.
const MINT_COUNTS_SQL = `SELECT
          COUNT(*) FILTER (WHERE approved_at IS NOT NULL OR approval_expires_at > NOW())::int AS live,
          COUNT(*) FILTER (WHERE approved_at IS NULL AND approval_expires_at > NOW())::int AS pending
     FROM admin_access_keys
    WHERE created_by = $1 AND revoked_at IS NULL AND expires_at > NOW()`;
const MINT_ACTIVE_SQL = `INSERT INTO admin_access_keys
       (name, key_hash, scopes, created_by, created_ip, session_version, expires_at, approved_at, approved_via)
     VALUES ($1, $2, $3::text[], $4, $5, $6, NOW() + make_interval(days => $7::int), NOW(), 'session')
     RETURNING id, name, scopes, created_at, created_ip, expires_at, approved_at, approved_via, approval_expires_at,
               last_used_at, last_used_ip, revoked_at, revoked_via, session_version`;
const MINT_PENDING_SQL = `INSERT INTO admin_access_keys
       (name, key_hash, scopes, created_by, created_ip, session_version, expires_at, approval_hash, approval_expires_at)
     VALUES ($1, $2, $3::text[], $4, $5, $6, NOW() + make_interval(days => $7::int), $8, NOW() + make_interval(mins => $9::int))
     RETURNING id, name, scopes, created_at, created_ip, expires_at, approved_at, approved_via, approval_expires_at,
               last_used_at, last_used_ip, revoked_at, revoked_via, session_version`;

// Mints one key for `user`: active when `fresh`, pending with an approval
// token otherwise. The user row is locked for the length of the transaction so
// two mints at once cannot both pass a ceiling. Returns { key, row,
// approvalToken } (approvalToken null for an active key), { tooMany: true } or
// { tooManyPending: true }.
async function mintAdminKey(user, { name, days, fresh, ip }) {
  const { currentTokenVersion } = require('./auth');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(MINT_LOCK_SQL, [user.id]);
    const { rows: [counts] } = await client.query(MINT_COUNTS_SQL, [user.id]);
    if (counts && counts.live >= ADMIN_KEY_ACTIVE_MAX) {
      await client.query('ROLLBACK');
      return { tooMany: true };
    }
    if (!fresh && counts && counts.pending >= ADMIN_KEY_PENDING_MAX) {
      await client.query('ROLLBACK');
      return { tooManyPending: true };
    }
    const key = generateAdminKey();
    const approvalToken = fresh ? null : generateApprovalToken();
    const base = [name, hashAdminKey(key), [...DEFAULT_SCOPES], user.id, ip ? String(ip).slice(0, 64) : null, currentTokenVersion(user), days];
    const { rows: [row] } = fresh
      ? await client.query(MINT_ACTIVE_SQL, base)
      : await client.query(MINT_PENDING_SQL, [...base, hashAdminKey(approvalToken), ADMIN_KEY_APPROVAL_MINUTES]);
    await client.query('COMMIT');
    return {
      key,
      approvalToken,
      row: { ...row, role: user.role, is_banned: user.is_banned, token_version: user.token_version },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A pending key whose approval email could not be sent can never work, and it
// was never handed out, so it goes. Only a key nobody approved or used.
const DISCARD_PENDING_SQL = `DELETE FROM admin_access_keys
    WHERE id = $1 AND approved_at IS NULL AND last_used_at IS NULL`;

async function discardPendingKey(id) {
  await pool.query(DISCARD_PENDING_SQL, [id]);
}

// Live keys first, then the newest. Bounded like every list the admin routes
// return; the limits are bound rather than spelled into the text so the SQL
// sweep (__tests__/sqlParameterTypes.test.js) prepares both statements.
const LIST_SQL = `SELECT k.id, k.name, k.scopes, k.created_at, k.created_ip, k.expires_at, k.approved_at, k.approved_via,
          k.approval_expires_at, k.last_used_at, k.last_used_ip, k.revoked_at, k.revoked_via, k.session_version,
          u.role, u.is_banned, u.token_version
     FROM admin_access_keys k
     JOIN users u ON u.id = k.created_by
    ORDER BY (k.revoked_at IS NULL AND k.expires_at > NOW()
              AND (k.approved_at IS NOT NULL OR k.approval_expires_at > NOW())) DESC,
             k.created_at DESC, k.id DESC
    LIMIT $1::int`;

const RECENT_USES_SQL = `SELECT key_id, used_at, method, route, status, refused
     FROM (SELECT key_id, used_at, method, route, status, refused,
                  ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY used_at DESC, id DESC) AS rn
             FROM admin_key_uses
            WHERE key_id = ANY($1::int[])) recent
    WHERE rn <= $2::int
    ORDER BY key_id, used_at DESC
    LIMIT $3::int`;

async function listAdminKeys(now = Date.now()) {
  const { rows } = await pool.query(LIST_SQL, [ADMIN_KEY_LIST_LIMIT]);
  const ids = rows.map((r) => Number(r.id));
  const uses = {};
  if (ids.length > 0) {
    const { rows: recent } = await pool.query(RECENT_USES_SQL, [
      ids, ADMIN_KEY_RECENT_USES, ADMIN_KEY_LIST_LIMIT * ADMIN_KEY_RECENT_USES,
    ]);
    for (const u of recent) {
      const id = Number(u.key_id);
      if (!uses[id]) uses[id] = [];
      uses[id].push({
        at: iso(u.used_at),
        method: u.method,
        route: u.route,
        status: u.status === null || u.status === undefined ? null : Number(u.status),
        refused: u.refused || null,
      });
    }
  }
  return rows.map((r) => ({ ...keyMetadata(r, now), recentUses: uses[Number(r.id)] || [] }));
}

// Revokes, and answers with the key and its owner's address, which the revoke
// email goes to.
const REVOKE_SQL = `UPDATE admin_access_keys k SET revoked_at = NOW(), revoked_via = $2
     FROM users u
    WHERE k.id = $1 AND k.revoked_at IS NULL AND u.id = k.created_by
    RETURNING k.id, k.name, k.scopes, k.created_at, k.created_ip, k.expires_at, k.approved_at, k.approved_via,
              k.approval_expires_at, k.last_used_at, k.last_used_ip, k.revoked_at, k.revoked_via,
              u.email AS owner_email, u.name AS owner_name`;
const REVOKED_ALREADY_SQL = `SELECT id, name, scopes, created_at, created_ip, expires_at, approved_at, approved_via,
          approval_expires_at, last_used_at, last_used_ip, revoked_at, revoked_via
     FROM admin_access_keys WHERE id = $1`;

// Revokes key `id`. `via` is 'session' or 'key'. Returns null for a key that
// does not exist, or { key, already, owner }.
async function revokeAdminKey(id, via) {
  const { rows: [row] } = await pool.query(REVOKE_SQL, [id, via]);
  if (row) return { key: keyMetadata(row), already: false, owner: { email: row.owner_email, name: row.owner_name } };
  const { rows: [was] } = await pool.query(REVOKED_ALREADY_SQL, [id]);
  if (!was) return null;
  return { key: keyMetadata(was), already: true, owner: null };
}

// ---------------------------------------------------------------------------
// The approval link, for routes/keyApproval.js
// ---------------------------------------------------------------------------

const APPROVAL_LOOKUP_SQL = `SELECT k.id, k.name, k.approval_hash, k.created_at, k.created_ip, k.expires_at, k.approved_at,
          k.revoked_at, k.revoked_via, k.approval_used_at, k.session_version,
          (k.approval_expires_at > NOW()) AS approval_open, (k.expires_at <= NOW()) AS expired,
          u.email AS owner_email, u.name AS owner_name, u.role, u.is_banned, u.token_version
     FROM admin_access_keys k
     JOIN users u ON u.id = k.created_by
    WHERE k.approval_hash = $1`;

// Both writes carry every condition in their own WHERE, so an approval racing a
// revoke, a second tap, or the window closing cannot both land: the statement
// that loses changes nothing.
const APPROVE_SQL = `UPDATE admin_access_keys k
      SET approved_at = NOW(), approved_via = 'email', approved_ip = $2::text, approval_used_at = NOW()
     FROM users u
    WHERE k.approval_hash = $1::text AND u.id = k.created_by
      AND k.approved_at IS NULL AND k.revoked_at IS NULL AND k.approval_used_at IS NULL
      AND k.approval_expires_at > NOW() AND k.expires_at > NOW()
      AND u.role = 'admin' AND u.is_banned IS NOT TRUE AND u.token_version = k.session_version
    RETURNING k.id, k.name, k.expires_at, k.approved_at, u.email AS owner_email, u.name AS owner_name`;
const DENY_SQL = `UPDATE admin_access_keys k
      SET revoked_at = NOW(), revoked_via = 'email', approval_used_at = NOW()
     FROM users u
    WHERE k.approval_hash = $1::text AND u.id = k.created_by
      AND k.approved_at IS NULL AND k.revoked_at IS NULL AND k.approval_used_at IS NULL
      AND k.approval_expires_at > NOW()
    RETURNING k.id, k.name, k.revoked_at, u.email AS owner_email, u.name AS owner_name`;

// The key an approval token was made for, or null. Looked up by the token's
// hash, then compared in constant time like a key.
async function findApproval(token) {
  if (!isApprovalTokenShape(token)) return null;
  const presented = hashAdminKey(token);
  const { rows: [row] } = await pool.query(APPROVAL_LOOKUP_SQL, [presented]);
  if (!row) return null;
  const a = Buffer.from(String(row.approval_hash), 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

// What a link can still do: 'open' while the key waits, or why not.
function approvalState(row) {
  const { tokenVersionOf } = require('./auth');
  if (!row) return 'invalid';
  if (row.revoked_at) return 'revoked';
  if (row.approved_at) return 'approved';
  if (row.approval_used_at) return 'used';
  if (row.expired === true || row.approval_open !== true) return 'expired';
  if (tokenVersionOf(row.session_version) !== tokenVersionOf(row.token_version)
    || row.role !== 'admin' || row.is_banned === true) return 'ended';
  return 'open';
}

// Approves (`action` 'approve') or revokes ('deny') the key behind `token`.
// Returns { done: true, row } or { done: false, state } with the reason.
async function settleApproval(token, action, ip) {
  if (!isApprovalTokenShape(token)) return { done: false, state: 'invalid' };
  const hash = hashAdminKey(token);
  const sql = action === 'approve' ? APPROVE_SQL : DENY_SQL;
  const params = action === 'approve' ? [hash, ip ? String(ip).slice(0, 64) : null] : [hash];
  const { rows: [row] } = await pool.query(sql, params);
  if (row) return { done: true, row };
  return { done: false, state: approvalState(await findApproval(token)) };
}

module.exports = {
  ADMIN_KEY_PREFIX,
  ADMIN_KEY_SHAPE,
  ADMIN_KEY_DEFAULT_DAYS,
  ADMIN_KEY_MAX_DAYS,
  ADMIN_KEY_NAME_MAX,
  ADMIN_KEY_ACTIVE_MAX,
  ADMIN_KEY_MINT_FRESH_SECONDS,
  ADMIN_KEY_APPROVAL_MINUTES,
  ADMIN_KEY_PENDING_MAX,
  ADMIN_KEY_LIST_LIMIT,
  ADMIN_KEY_RECENT_USES,
  ADMIN_KEY_REFUSALS_LOGGED_PER_HOUR,
  ADMIN_KEY_SCOPES,
  ADMIN_KEY_ROUTES,
  ADMIN_KEY_REFUSED_ROUTES,
  KEY_WORDS,
  generateAdminKey,
  hashAdminKey,
  isAdminKeyShape,
  isApprovalTokenShape,
  adminKeyBearer,
  handleAdminKeyBearer,
  keyRouteDecision,
  keyRequestPath,
  keyMetadata,
  keyState,
  readMintBody,
  sessionAgeSeconds,
  isFreshSession,
  mintAdminKey,
  discardPendingKey,
  listAdminKeys,
  revokeAdminKey,
  findApproval,
  approvalState,
  settleApproval,
};

module.exports.__testing = {
  onAdminMount,
  boundForAdminMount,
  compileRoute,
  deadReason,
  lookupKey,
  authenticateAdminKey,
  refuseAdminKeyOffAdmin,
};
