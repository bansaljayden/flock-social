// ---------------------------------------------------------------------------
// The caller's own photo, for a live event that shows their face.
// ---------------------------------------------------------------------------
// Three events carry the acting person's photo: a member joining a plan
// (routes/flocks.js and the guest link's sign-in, routes/guest.js, both
// 'flock_invite_responded') and a friend setting their availability
// (routes/availability.js). All three read req.user.profile_image_url, and
// req.user never has one: middleware/auth.js selects id, email, name, role and
// the session columns, deliberately not the photo, because that column is a
// base64 data URL of up to MAX_AVATAR_DATA_URL_BYTES and the lookup runs on
// every request. So every one of those events said null, and a new joiner
// appeared on everyone's roster as a letter until the next refetch (backend
// audit 2026-10-03).
//
// Read here instead, only for the events that draw it, and capped the way the
// thirteen other avatar reads in routes/ cap it: over 12,000 bytes reads as
// null, which every client already draws as the letter. A failed read is also
// null: a face is never worth failing the event that carries it.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

async function ownAvatar(userId, db = pool) {
  try {
    const r = await db.query(
      `SELECT CASE WHEN LENGTH(profile_image_url) > 12000 THEN NULL ELSE profile_image_url END AS url
         FROM users WHERE id = $1`,
      [userId]
    );
    return (r.rows[0] && r.rows[0].url) || null;
  } catch {
    return null;
  }
}

module.exports = { ownAvatar };
