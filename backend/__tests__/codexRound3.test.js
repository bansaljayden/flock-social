/**
 * CODEX ROUND 3 (2026-09-05): thirteen findings, pinned.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/codexRound3.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('billing: a retried handoff replays as applied, and no-op settles carry the tally', () => {
  const src = read('routes/billing.js');
  assert.match(src, /return refuse\(403, \{ error: 'Only the person who paid or the flock creator can change this bill', billId: existingBill\.rows\[0\]\.id, code: 'NOT_PAYER' \}\);/);
  assert.match(src, /alreadySettled: true, bill_tally: await billTallyFor\(billId\)/);
  assert.match(src, /alreadyUnsettled: true, bill_tally: await billTallyFor\(billId\)/);
});

test('admin: omitting expiresAt keeps only a live grant', () => {
  const src = read('routes/admin.js');
  assert.match(src, /live AS \(\n\s+SELECT 1 FROM venue_subscriptions\n\s+WHERE user_id = \$2 AND status = 'active' AND \(expires_at IS NULL OR expires_at > NOW\(\)\)\n\s+\)/);
  assert.match(src, /AND NOT \(\$10::boolean AND NOT EXISTS \(SELECT 1 FROM live\)\)/);
  assert.match(src, /needsLiveGrant && !hasLive\)/);
});

test('safety: the audience is written before the alarm, and empty snapshots are authoritative', () => {
  const src = read('routes/safety.js');
  assert.match(src, /const audience = members\.rows\.map\(\(row\) => Number\(row\.user_id\)\);\n\s+if \(alertId\) \{\n\s+await pool\.query\('UPDATE emergency_alerts SET flock_recipient_ids = \$1::int\[\] WHERE id = \$2', \[audience, alertId\]\);/);
  assert.match(src, /alertFlockMembers\(req\.app\.get\('io'\), req\.user, coords, emailsSent, alertId\)/);
  assert.match(src, /VALUES \(\$1, \$2, \$3, 0, '\{\}'::int\[\], '\[\]'::jsonb\) RETURNING id/);
  assert.match(src, /flock_recipient_ids : null;/);
  assert.match(src, /: null;\n\s+\/\/ A recorded empty list[\s\S]{0,200}if \(withEmail === null\) \{/);
  const mig = read('migrations/064_emergency_alert_snapshot_sentinel.sql');
  assert.match(mig, /ALTER COLUMN flock_recipient_ids DROP DEFAULT/);
  assert.match(mig, /SET flock_recipient_ids = NULL, contact_recipients = NULL/);
});

test('moderation and friends: a block keeps the decline cooldown, cancel is not an oracle, banned actors are gone', () => {
  const mod = read('routes/moderation.js');
  assert.match(mod, /DELETE FROM friendships\n\s+WHERE \(\(requester_id = \$1 AND addressee_id = \$2\)\n\s+OR \(requester_id = \$2 AND addressee_id = \$1\)\)\n\s+AND status <> 'declined'/);
  const fr = read('routes/friends.js');
  assert.match(fr, /if \(masked\.rows\.length > 0\) return res\.json\(\{ message: 'Removed' \}\);/);
  const msgs = read('routes/messages.js');
  assert.match(msgs, /if \(\(await getInvisibleUserIds\(req\.user\.id\)\)\.some\(\(id\) => Number\(id\) === otherUserId\)\) \{\n\s+return res\.json\(\{ messages: \[\], blocked: true \}\);/);
  const venues = read('routes/venues.js');
  assert.match(venues, /JOIN users u ON u\.id = vv\.user_id AND u\.is_banned IS NOT TRUE/);
});

test('push: the merged-hold repair carries the survivor sender and skips blocked or banned senders', () => {
  const src = read('services/pushHelper.js');
  assert.match(src, /SELECT m\.id, m\.sender_id\n\s+FROM messages m/);
  assert.match(src, /JOIN users su ON su\.id = m\.sender_id AND su\.is_banned IS NOT TRUE/);
  assert.match(src, /senderId: String\(r\.rows\[0\]\.sender_id\)/);
  assert.match(src, /JOIN users su ON su\.id = dm\.sender_id AND su\.is_banned IS NOT TRUE/);
});

test('birdie: a refund is bound to the day it was charged on', () => {
  const usage = require('../services/birdieUsage');
  const u = 920000 + Math.floor(Math.random() * 1000);
  const first = usage.checkUserRateLimit(u, 10);
  assert.strictEqual(typeof first.chargeDay, 'string');
  assert.strictEqual(usage.getUsedToday(u), 1);
  usage.refundTurn(u, 'some-other-day');
  assert.strictEqual(usage.getUsedToday(u), 1, 'a refund for another day does nothing');
  usage.refundTurn(u, first.chargeDay);
  assert.strictEqual(usage.getUsedToday(u), 0);
  const ai = read('routes/ai.js');
  assert.match(ai, /res\.locals\.chirpDay = rateCheck\.chargeDay;/);
  assert.match(ai, /refundTurn\(res\.locals\.chirpUser, res\.locals\.chirpDay\);/);
});

test('crowd: the calm shortcut calibrates first and returns the reserved search unit', () => {
  const src = read('routes/crowd.js');
  const at = src.indexOf('const targetOnly = buildCalibrationAdjustment(targetFeedback.rows || [], targetResult.score);');
  assert.ok(at > -1);
  assert.match(src.slice(at, at + 900), /if \(searchUnitReserved\) refundPlacesSearch\(req\.user\.id, 1\);\n\s+return res\.json\(\{ alternatives: \[\] \}\);/);
});

test('moderation: provider provenance needs a provider-shaped id', () => {
  const mod = require('../utils/moderation');
  assert.strictEqual(mod.moderateVenueText('Sexy Fish', 'abcdef').allowed, false, 'six characters are not a place id');
  assert.strictEqual(mod.moderateVenueText('Sexy Fish', 'ChIJN1t_tDeuEmsRUsoyG83frY4').allowed, true, 'a place-shaped id keeps the provider list');
  assert.strictEqual(mod.moderateVenueText("Dick's Sporting Goods", 'ChIJN1t_tDeuEmsRUsoyG83frY4').allowed, true);
});
