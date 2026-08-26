const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { rejectIfProfane } = require('../utils/moderation');
// Shape before content — see validators/shape.js.
const { scalarOnly, freeText } = require('../validators/shape');
const { pushIfOffline, isPushConfigured } = require('../services/pushHelper');

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// "I AM FREE TONIGHT", AND WHY IT IS THE MOST RATIONED PUSH IN THE APP
// ---------------------------------------------------------------------------
// The pulse is the loop the product is FOR, and until now it was a socket event
// and nothing else: it reached the friends who already had the app open, which
// is the set of people who did not need telling. Everyone else found out by
// opening Flock and looking, which is the behaviour the pulse exists to replace.
//
// It is also the only push here that is not about a row the recipient already
// owns, so it is the one that could turn a phone into a nuisance fastest. A
// person with thirty friends could be interrupted thirty times on a Friday for
// thirty facts they can act on once. Four rules, and each one closes a
// different way for that to happen:
//
//   1. ONLY 'down'. "Maybe" and "Not" are answers to a question, not
//      invitations. Nobody is woken up for a maybe.
//   2. ONLY ON THE WAY IN. The push fires when a pulse BECOMES 'down', never
//      when an existing one is edited. Fixing a typo in your note is not news.
//   3. ONE PER SENDER, PER NIGHT. A friend who toggles down/not/down six times
//      buzzes you once. SENDER_COOLDOWN_MS.
//   4. ONE PER RECIPIENT, PER HOUR, from anybody. This is the rule that
//      actually bounds the evening: the first friend who says they are free
//      buzzes you, and the next nine do not. They are all still on the friends
//      list when you look, which is where the answer to "who else is out" has
//      always lived. RECIPIENT_COOLDOWN_MS.
//
// Rules 3 and 4 are process-local for the same reason routes/flocks.js's RSVP
// digest is: a miss costs one extra notification, never a storm, and a Postgres
// claim row per pulse would be a write to save a notification. See
// utils/cacheKeyInventory.js.
//
// 4.5.4: transactional. It reports a specific thing a specific friend did, to
// people that friend chose to be friends with, and it names no price, product
// or offer. It is not a re-engagement nudge: nothing here fires because a user
// has been away.
const SENDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RECIPIENT_COOLDOWN_MS = 60 * 60 * 1000;
const PULSE_PUSH_MAX = 20000;
const lastPulsePushBySender = new Map(); // senderId -> ms
const lastPulsePushByRecipient = new Map(); // recipientId -> ms

// Swept rather than cleared: a wholesale clear would hand everybody a fresh
// window at once, which is the exact burst these maps exist to prevent.
function sweepPulsePushes(now) {
  for (const [k, ts] of lastPulsePushBySender) {
    if (now - ts > SENDER_COOLDOWN_MS) lastPulsePushBySender.delete(k);
  }
  for (const [k, ts] of lastPulsePushByRecipient) {
    if (now - ts > RECIPIENT_COOLDOWN_MS) lastPulsePushByRecipient.delete(k);
  }
  // Still oversized after the sweep means live windows, so drop the oldest,
  // which are the ones closest to expiring anyway.
  while (lastPulsePushBySender.size > PULSE_PUSH_MAX) {
    lastPulsePushBySender.delete(lastPulsePushBySender.keys().next().value);
  }
  while (lastPulsePushByRecipient.size > PULSE_PUSH_MAX) {
    lastPulsePushByRecipient.delete(lastPulsePushByRecipient.keys().next().value);
  }
}

// availability_pulses table lives in migrations/003 — route-owned DDL raced
// the migration runner on fresh deployments (see REVIEW-ROUND5).

// Default expiry: end of "tonight" — 4am next-day in user's local TZ.
// Frontend sends `expires_at` so the server doesn't need to know the user's TZ.
// Cap at 36h from now to prevent abuse.
function clampExpiry(clientExpiry) {
  const now = Date.now();
  const cap = now + 36 * 60 * 60 * 1000;
  if (!clientExpiry) return new Date(now + 12 * 60 * 60 * 1000); // default 12h
  const t = new Date(clientExpiry).getTime();
  if (isNaN(t)) return new Date(now + 12 * 60 * 60 * 1000);
  if (t <= now) return new Date(now + 60 * 60 * 1000); // min 1h forward
  if (t > cap) return new Date(cap);
  return new Date(t);
}

// POST /api/availability — set my pulse
router.post('/',
  // SHAPE BEFORE CONTENT (round 20). `{"status": ["down"]}` satisfied isIn():
  // express-validator stringifies a one-element array before testing it, and
  // the value then stays an array in req.body. It reached pg as a parameter for
  // availability_pulses.status, which is VARCHAR(10) behind
  // CHECK (status IN ('down','maybe','not')) — a 500 (23514/22001) for a body
  // the caller picks, instead of the 400 this line is written to give.
  scalarOnly(body('status'), 'status').isIn(['down', 'maybe', 'not']).withMessage('status must be down, maybe, or not'),
  // Round 13: the note is UGC pushed to every friend over the
  // `availability_updated` socket event, and it was the last free-text field
  // with neither sanitizing nor a profanity screen.
  //
  // Round 20: `optional()` skips ONLY undefined, so a client clearing its note
  // with an explicit `null` was answered 400 by isString() even though the
  // handler below already reads a falsy note as "no note". freeText() also adds
  // the trailing trim the old chain lacked, so a markup-only note ("<b> </b>")
  // is measured after sanitizing and stored as NULL rather than as a space.
  freeText(body('note').optional({ nullable: true }), 'note').isLength({ max: 80 }),
  // clampExpiry() already coerces anything unusable to a default, so a
  // non-scalar here was inert rather than dangerous — but it was inert by
  // accident, and `null` (which clampExpiry handles) was refused by isISO8601.
  scalarOnly(body('expires_at').optional({ nullable: true }), 'expiry').isISO8601(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { status, note, expires_at } = req.body;

      // Same screen every other broadcast text field gets (Apple 1.2).
      if (note && rejectIfProfane(res, note)) return;

      const expiry = clampExpiry(expires_at);

      // Rule 2 above: the push is for a pulse that BECOMES 'down'. That has to
      // be measured before the upsert, because afterwards there is no previous
      // status left to compare against. Only read on the one path that can
      // push, so an ordinary pulse still costs exactly one statement.
      let wasAlreadyDown = false;
      const couldPush = status === 'down' && isPushConfigured();
      if (couldPush) {
        const prior = await pool.query(
          'SELECT status FROM availability_pulses WHERE user_id = $1 AND expires_at > NOW()',
          [req.user.id]
        );
        wasAlreadyDown = prior.rows[0]?.status === 'down';
      }

      const result = await pool.query(
        `INSERT INTO availability_pulses (user_id, status, note, set_at, expires_at)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (user_id) DO UPDATE
           SET status = EXCLUDED.status,
               note = EXCLUDED.note,
               set_at = NOW(),
               expires_at = EXCLUDED.expires_at
         RETURNING status, note, set_at, expires_at`,
        [req.user.id, status, note || null, expiry]
      );

      const pulse = result.rows[0];

      // Broadcast to all friends so their UI updates live
      const io = req.app.get('io');
      let friendIds = [];
      if (io) {
        const friends = await pool.query(
          `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
           FROM friendships
           WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
          [req.user.id]
        );
        friendIds = friends.rows.map((r) => r.friend_id);
        const payload = {
          userId: req.user.id,
          name: req.user.name,
          status: pulse.status,
          note: pulse.note,
          setAt: pulse.set_at,
          expiresAt: pulse.expires_at,
        };
        for (const r of friends.rows) {
          io.to(`user:${r.friend_id}`).emit('availability_updated', payload);
        }
      }

      res.json({ pulse });

      // Post-response, like every other push in this app: the pulse is saved,
      // the caller has their answer, and nothing about it depends on Firebase.
      // Own try/catch for the same reason.
      if (couldPush && !wasAlreadyDown && friendIds.length > 0) {
        try {
          const now = Date.now();
          sweepPulsePushes(now);
          const senderLast = lastPulsePushBySender.get(req.user.id);
          if (senderLast == null || now - senderLast >= SENDER_COOLDOWN_MS) {
            // Claimed before the sends, so two pulses landing together cannot
            // both pass. Not rolled back on a failed delivery: unlike an invite,
            // nothing here is waiting to be re-sent, and a retry window would
            // only ever mean a second buzz for the same fact.
            lastPulsePushBySender.set(req.user.id, now);
            // The note is the whole message ("anyone want food"), so it is the
            // body when there is one. Without it the title carries everything.
            const bodyText = pulse.note ? `"${pulse.note}"` : 'Tap to make a plan.';
            await Promise.allSettled(
              friendIds
                .filter((id) => {
                  const last = lastPulsePushByRecipient.get(id);
                  if (last != null && now - last < RECIPIENT_COOLDOWN_MS) return false;
                  lastPulsePushByRecipient.set(id, now);
                  return true;
                })
                .map((id) => pushIfOffline(io, id,
                  `${req.user.name} is free tonight`,
                  bodyText,
                  { type: 'availability_pulse', fromUserId: String(req.user.id) }
                ))
            );
          }
        } catch (pushErr) {
          console.error('Availability push error:', pushErr.message);
        }
      }
    } catch (err) {
      console.error('Set availability error:', err);
      // headersSent: the push above runs post-response and must not be able to
      // turn a saved pulse into a 500.
      if (!res.headersSent) res.status(500).json({ error: 'Failed to set availability' });
    }
  }
);

// DELETE /api/availability — clear my pulse
router.delete('/', async (req, res) => {
  try {
    await pool.query('DELETE FROM availability_pulses WHERE user_id = $1', [req.user.id]);

    const io = req.app.get('io');
    if (io) {
      const friends = await pool.query(
        `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
         FROM friendships
         WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
        [req.user.id]
      );
      for (const r of friends.rows) {
        io.to(`user:${r.friend_id}`).emit('availability_updated', { userId: req.user.id, status: null });
      }
    }

    res.json({ message: 'Cleared' });
  } catch (err) {
    console.error('Clear availability error:', err);
    res.status(500).json({ error: 'Failed to clear availability' });
  }
});

// GET /api/availability/me — my current pulse (or null if none/expired)
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, note, set_at, expires_at
       FROM availability_pulses
       WHERE user_id = $1 AND expires_at > NOW()`,
      [req.user.id]
    );
    res.json({ pulse: result.rows[0] || null });
  } catch (err) {
    console.error('Get my availability error:', err);
    res.status(500).json({ error: 'Failed to get availability' });
  }
});

// GET /api/availability/friends — active pulses for my friends
router.get('/friends', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url,
              ap.status, ap.note, ap.set_at, ap.expires_at
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       JOIN availability_pulses ap ON ap.user_id = u.id
       WHERE f.status = 'accepted'
         AND (f.requester_id = $1 OR f.addressee_id = $1)
         AND ap.expires_at > NOW()
       ORDER BY
         CASE ap.status WHEN 'down' THEN 1 WHEN 'maybe' THEN 2 ELSE 3 END,
         ap.set_at DESC`,
      [req.user.id]
    );
    res.json({ friends: result.rows });
  } catch (err) {
    console.error('Get friends availability error:', err);
    res.status(500).json({ error: 'Failed to get friend availability' });
  }
});

module.exports = router;

// Test hook only. The two pulse cooldowns are process-wide in-memory state, so
// without this one test's suppression window silently decides the next test's
// expectations — which is the same failure the invite debounce needed a seam
// for in routes/flocks.js.
module.exports.__resetPulseWindows = () => {
  lastPulsePushBySender.clear();
  lastPulsePushByRecipient.clear();
};
