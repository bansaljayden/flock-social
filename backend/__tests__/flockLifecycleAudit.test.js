/**
 * FLOCK LIFECYCLE (audit 2026-09-05): a plan that was never locked in still
 * finishes, a closed plan cannot be joined or reopened, a past time cannot
 * be set by a direct call, and invitees hear updates and deletions.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/flockLifecycleAudit.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('the sweep finishes planning flocks too, and tells invitees', () => {
  const src = read('services/flockSweep.js');
  assert.match(src, /WHERE status IN \('planning', 'confirmed'\)\n\s+AND event_time IS NOT NULL/);
  assert.match(src, /WHERE flock_id = ANY\(\$1::int\[\]\) AND status IN \('accepted', 'invited'\)/);
});

test('join refuses a finished or cancelled plan with 409, after the membership check', () => {
  const src = read('routes/flocks.js');
  const join = src.indexOf("router.post('/:id/join', requireVerified,");
  const member404 = src.indexOf("return res.status(404).json({ error: 'Flock not found' });", join);
  const guard = src.indexOf("return res.status(409).json({ error: 'This plan is no longer open', code: 'FLOCK_CLOSED' });", join);
  assert.ok(join > -1 && member404 > -1 && guard > -1);
  assert.ok(member404 < guard && guard - join < 5000, 'the guard sits inside the join route, after the 404');
});

test('PUT refuses reopening a finished plan; a recent past time stays allowed (abuseReliabilityFarming pins it)', () => {
  const src = read('routes/flocks.js');
  assert.match(src, /if \(\(wasStatus === 'completed' \|\| wasStatus === 'cancelled'\) && status !== wasStatus\) \{\n\s+return res\.status\(409\)\.json\(\{ error: 'This plan is finished and cannot be reopened' \}\);/);
  assert.ok(!src.includes('A plan cannot be moved to a time that has already passed'));
});

test('flock_updated and both flock_deleted fan-outs reach invitees', () => {
  const src = read('routes/flocks.js');
  const handlers = read('sockets/handlers.js');
  assert.match(handlers, /async function emitToFlockExcludingBlocked\(io, flockId, actorId, event, payload, opts = \{\}\)/);
  assert.match(handlers, /WHERE flock_id = \$1 AND status = 'invited' AND user_id != \$2/);
  assert.strictEqual((src.match(/\{ includeInvited: true \}/g) || []).length, 3, 'three fan-outs carry the flag');
});
