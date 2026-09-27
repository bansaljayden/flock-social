// ---------------------------------------------------------------------------
// Refresh credentials: how a Flock session outlives its access token
// ---------------------------------------------------------------------------
// The access token (middleware/auth.js signUserToken) lives 24 hours and there
// was nothing to renew it with, so every user was signed out a day after
// signing in: mid-chat, when sockets/handlers.js rechecked the socket's token,
// or at the next launch, when GET /api/auth/me answered 401. The expiry
// teardown then could not even sign the phone out properly, because
// POST /logout and the push unregister both sit behind the dead token.
//
// Stretching the access token would have fixed that by making every stolen
// token live as long. Instead a sign-in now hands out two things:
//
//   token          the access token, unchanged: short-lived, sent on every
//                  request and socket handshake.
//   refreshToken   32 random bytes, sent ONLY to POST /api/auth/refresh, which
//                  trades it for a new access token and a new refresh token.
//
// What makes the refresh credential safe to keep for weeks:
//
//   * STORED AS A HASH. The table (migration 097) holds SHA-256 of it, the rule
//     password_resets and email_verifications already follow. A read of the
//     database yields nothing that can be presented.
//   * ROTATED ON EVERY USE. Each exchange spends the presented credential and
//     issues its child. A credential copied off a device stops working the
//     first time either copy is used, and the second use is how we notice.
//   * BOUND TO token_version. It carries the version it was issued under and is
//     refused once users.token_version has moved, so a password change, a
//     reset, "sign out everywhere" or an account claim ends every refresh
//     credential exactly as it ends every access token. No new revocation path
//     had to be remembered by the code that bumps the version.
//   * REFUSED FOR A BANNED ACCOUNT. A ban already locks the access token out of
//     everything but deletion and SOS; refusing the renewal means the session
//     ends when that token does, as it always did.
//   * ONE FAMILY PER SIGN-IN. Every credential descended from one sign-in shares
//     family_id, so a sign-out (POST /logout sends it) or a detected replay ends
//     the whole chain in one statement.
//
// And what keeps it from signing honest people out, which is the bug it fixes:
//
//   * IDLE EXPIRY, SLIDING. Each credential lives REFRESH_TOKEN_TTL_DAYS from
//     its own issue, and each renewal issues a new one, so a phone that opens
//     Flock at least that often stays signed in however long ago it signed in,
//     and one that opens it after a day away is renewed rather than refused.
//   * A SHORT GRACE FOR RACES. Two tabs, or a retry, can present the same
//     credential moments apart. Inside REFRESH_REUSE_GRACE_MS of its rotation a
//     spent credential is exchanged again for a sibling, instead of being read
//     as a replay and ending the session. A sibling is a fork of the chain, and
//     only one fork may ever be used: the client keeps one answer and drops the
//     other (services/api.js performRenewal), so the first use of a credential
//     whose sibling was already used means two holders exist, and the sign-in
//     ends. Without that rule a copy presented inside the window became a
//     second chain that renewed for as long as it was used, and no replay was
//     ever seen, because each holder only presented its own latest credential.
//   * A LOST RESPONSE IS NOT A THEFT. A renewal whose answer never arrived
//     leaves the device holding a spent credential whose child nobody has.
//     Presented later, it is exchanged again if no child of it was ever used
//     (the unused children are retired), and treated as a replay only if one
//     was, because then two holders exist.
//
// auth_time rides along unchanged: every renewed access token carries the time
// the person actually signed in, so hasFreshSession (routes/users.js) never
// mistakes a renewal for a fresh sign-in.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const pool = require('../config/database');
const { signUserToken, tokenVersionOf, currentTokenVersion } = require('../middleware/auth');

// How long a refresh credential lives without being used. Sixty days: a person
// who opens the app every couple of months is still one tap from their plans,
// and a phone lost in a drawer stops being a way in by itself.
const REFRESH_TOKEN_TTL_DAYS = 60;

// How long after it was spent a credential may be presented again and treated
// as a race rather than a replay. Long enough for a second tab or a retry on a
// slow connection, short enough that it buys a thief nothing they did not
// already have by holding the credential at that moment.
const REFRESH_REUSE_GRACE_MS = 2 * 60 * 1000;

// How many rows one pass of the global prune deletes. The table is small at
// this size of product; the cap keeps a first run over a long backlog from
// holding a single statement open against the renewals it shares rows with.
const REFRESH_PRUNE_BATCH = 5000;

// A row that can never be presented successfully again: expired, and no longer
// the parent of a credential that can. The parent is kept while any child is
// live because the child's parent_id is how the replay and fork checks find its
// siblings, and deleting the parent sets that link to NULL (migration 097). A
// parent expires about a renewal interval before its children, so this keeps
// one extra row per sign-in for about a day, never more.
const PRUNABLE_REFRESH_SQL =
  `rt.expires_at < NOW()
   AND NOT EXISTS (
     SELECT 1 FROM refresh_tokens c WHERE c.parent_id = rt.id AND c.expires_at >= NOW()
   )`;

// 32 random bytes in base64url is exactly 43 characters from this alphabet.
// Anything else is refused before it reaches a hash or a query.
const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function isRefreshTokenShape(raw) {
  return typeof raw === 'string' && REFRESH_TOKEN_RE.test(raw);
}

function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function mintRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const INSERT_REFRESH_SQL =
  `INSERT INTO refresh_tokens (user_id, family_id, parent_id, token_hash, token_version, auth_time, expires_at)
   VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision), NOW() + make_interval(days => $7::int))`;

// Write one credential and return it. `db` is the pool at a sign-in and the
// exchange's transaction client at a renewal, so a renewal's child is
// committed with the spend of its parent or not at all.
async function insertRefreshToken(db, { userId, familyId, parentId, tokenVersion, authTime }) {
  const raw = mintRefreshToken();
  await db.query(INSERT_REFRESH_SQL, [
    userId, familyId, parentId, hashRefreshToken(raw), tokenVersion, authTime, REFRESH_TOKEN_TTL_DAYS,
  ]);
  return raw;
}

// What a sign-in answers with: the access token, and a refresh credential that
// starts a new family. Every door that signs a person in calls this rather than
// signUserToken, so none of them can hand out an access token nobody can renew.
//
// The refresh credential is best effort. If writing it fails, the sign-in still
// succeeds with the access token alone, which is exactly the session every sign-in
// gave before this existed; failing the sign-in over it would turn a database
// blip into a locked door.
async function issueSession(user, { authTime } = {}) {
  const signedIn = Number.isInteger(authTime) && authTime > 0 ? authTime : Math.floor(Date.now() / 1000);
  const token = signUserToken(user, { authTime: signedIn });
  let refreshToken = null;
  try {
    refreshToken = await insertRefreshToken(pool, {
      userId: user.id,
      familyId: crypto.randomUUID(),
      parentId: null,
      tokenVersion: currentTokenVersion(user),
      authTime: signedIn,
    });
  } catch (err) {
    console.error(`[auth] refresh credential not issued for user ${user.id}:`, err.message);
  }
  return refreshToken ? { token, refreshToken } : { token };
}

// Trade a refresh credential for a new access token and its successor.
//
// Returns { ok: true, token, refreshToken, userId } or { ok: false, status,
// reason }. status is 401 for a credential that is unknown, expired, revoked,
// replayed or from before a token_version bump, and 403 for a banned account,
// matching what middleware/auth.js answers the access token with.
//
// Everything happens in one transaction with the presented row locked, so two
// presentations of one credential are serialised: the second one sees the
// first one's rotation and takes the grace or the replay branch, never a
// second clean exchange.
//
// The presented row's PARENT is locked first, and that is what serialises two
// siblings as well. Two copies of one chain presented at once (the person's
// credential and a sibling minted for a copy inside the grace window, or a
// credential and its already spent parent) would otherwise each read the other
// as unused and both go on. Always the parent before the child, on every path,
// so two exchanges in one chain wait for each other instead of deadlocking.
async function exchangeRefreshToken(raw) {
  if (!isRefreshTokenShape(raw)) return { ok: false, status: 401, reason: 'invalid' };
  const tokenHash = hashRefreshToken(raw);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const located = await client.query(
      'SELECT parent_id FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash]
    );
    if (located.rows[0] && located.rows[0].parent_id !== null) {
      await client.query('SELECT id FROM refresh_tokens WHERE id = $1 FOR UPDATE', [located.rows[0].parent_id]);
    }
    const { rows } = await client.query(
      `SELECT rt.id, rt.user_id, rt.family_id, rt.parent_id, rt.token_version,
              EXTRACT(EPOCH FROM rt.auth_time)::bigint AS auth_time,
              rt.expires_at, rt.rotated_at, rt.revoked_at,
              u.token_version AS current_token_version, u.is_banned
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
        FOR UPDATE OF rt`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, status: 401, reason: 'invalid' };
    }

    // A refusal that ends the chain commits the revocation it made; one that
    // does not has written nothing.
    const refuse = async (status, reason, endFamily) => {
      if (endFamily) {
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL',
          [row.family_id]
        );
      }
      await client.query('COMMIT');
      return { ok: false, status, reason };
    };

    // Revoked: the family was signed out or caught replaying, or this one was
    // retired because a lost-response retry issued its replacement. In that last
    // case somebody is presenting a credential that was replaced, which only
    // happens when two holders exist, so the family ends either way.
    if (row.revoked_at) return refuse(401, 'revoked', true);
    if (new Date(row.expires_at).getTime() <= Date.now()) return refuse(401, 'expired', false);
    // Issued before the last token_version bump. Whatever bumped it meant every
    // session to end.
    if (tokenVersionOf(row.token_version) !== tokenVersionOf(row.current_token_version)) {
      return refuse(401, 'revoked', true);
    }
    if (row.is_banned) return refuse(403, 'suspended', true);

    if (row.rotated_at) {
      const used = await client.query(
        'SELECT 1 FROM refresh_tokens WHERE parent_id = $1 AND rotated_at IS NOT NULL LIMIT 1',
        [row.id]
      );
      if (used.rows.length > 0) {
        // The chain moved on from this credential and somebody still holds a
        // copy of it. One of the two holders is not the person, and there is
        // no telling which, so both are signed out. Inside the grace window
        // too: a race partner is at most a couple of minutes behind and has
        // not renewed again since, so a used child means the chain has already
        // moved on, and a sibling minted now would be a second chain.
        console.warn(`[auth] replayed refresh credential for user ${row.user_id}; ending that sign-in`);
        return refuse(401, 'replayed', true);
      }
      const spentFor = Date.now() - new Date(row.rotated_at).getTime();
      if (spentFor > REFRESH_REUSE_GRACE_MS) {
        // Nobody ever used what this credential was exchanged for: the answer
        // that carried it was lost. Retire those unused children, so only the
        // one issued now can continue the chain.
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = NOW() WHERE parent_id = $1 AND revoked_at IS NULL',
          [row.id]
        );
      }
    } else {
      if (row.parent_id !== null) {
        // The first use of this credential. If a sibling (another answer to the
        // same parent, minted inside the grace window) has already been used,
        // the chain forked and both forks are in use: the client keeps exactly
        // one answer, so two holders exist. The sign-in ends, as for a replay.
        const forked = await client.query(
          `SELECT 1 FROM refresh_tokens
            WHERE parent_id = $1 AND id <> $2 AND rotated_at IS NOT NULL
            LIMIT 1`,
          [row.parent_id, row.id]
        );
        if (forked.rows.length > 0) {
          console.warn(`[auth] a second answer to one refresh credential was used for user ${row.user_id}; ending that sign-in`);
          return refuse(401, 'replayed', true);
        }
      }
      await client.query('UPDATE refresh_tokens SET rotated_at = NOW() WHERE id = $1', [row.id]);
    }

    const authTime = Number(row.auth_time);
    const tokenVersion = tokenVersionOf(row.current_token_version);
    const refreshToken = await insertRefreshToken(client, {
      userId: row.user_id,
      familyId: row.family_id,
      parentId: row.id,
      tokenVersion,
      authTime,
    });
    await client.query('COMMIT');

    // Rows that expired can never be presented successfully again, so they
    // are only weight. Per account, after the commit, and never allowed to
    // fail the renewal it rides on. pruneExpiredRefreshTokens below does the
    // same for every account on a timer, for the ones that never renew again.
    pool.query(`DELETE FROM refresh_tokens rt WHERE rt.user_id = $1 AND ${PRUNABLE_REFRESH_SQL}`, [row.user_id])
      .catch((e) => console.warn(`[auth] refresh credential prune failed for user ${row.user_id}:`, e.message));

    return {
      ok: true,
      token: signUserToken({ id: row.user_id, token_version: tokenVersion }, { authTime }),
      refreshToken,
      userId: row.user_id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// End the sign-in a refresh credential belongs to: every credential in its
// family, spent or not. Scoped to the account signing out, so a credential of
// somebody else's that turned up in the body cannot be used to sign them out.
// Resolves to the number of credentials retired; a malformed credential
// retires nothing.
async function revokeRefreshFamily(raw, userId) {
  if (!isRefreshTokenShape(raw)) return 0;
  const result = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE revoked_at IS NULL
        AND user_id = $2
        AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2)`,
    [hashRefreshToken(raw), userId]
  );
  return result.rowCount || 0;
}

// Delete credentials that can never be presented successfully again, for every
// account. The prune inside a renewal only reaches an account that renews, and
// the rows that pile up are the ones whose account never does again: signed
// out, idle past REFRESH_TOKEN_TTL_DAYS, or a family a replay ended. server.js
// runs this on an hourly timer. Resolves to the number of rows deleted.
//
// SKIP LOCKED, so a row an exchange is holding is left for the next pass
// rather than waited on, and in batches, so a first run over a backlog is a
// few short statements rather than one long one.
async function pruneExpiredRefreshTokens(batch = REFRESH_PRUNE_BATCH) {
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await pool.query(
      `DELETE FROM refresh_tokens
        WHERE id IN (
          SELECT rt.id FROM refresh_tokens rt
           WHERE ${PRUNABLE_REFRESH_SQL}
           ORDER BY rt.expires_at
           LIMIT $1::int
           FOR UPDATE SKIP LOCKED
        )`,
      [batch]
    );
    const deleted = result.rowCount || 0;
    total += deleted;
    if (deleted < batch) return total;
  }
}

module.exports = {
  issueSession,
  exchangeRefreshToken,
  revokeRefreshFamily,
  pruneExpiredRefreshTokens,
  isRefreshTokenShape,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_DAYS,
  REFRESH_REUSE_GRACE_MS,
};
