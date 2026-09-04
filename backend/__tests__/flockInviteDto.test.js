// The invite card DTO and the live invite carry what the card needs. From
// the Nest trace of 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const flocks = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');

test('both invite cards say whether the plan is finished, without leaking status', () => {
  // The list card: a derived boolean, since status and creator_id are
  // private to members (flocksAuthz pins that).
  const i = flocks.indexOf('invitePreview: true,');
  const dto = flocks.slice(i - 900, i);
  assert.match(dto, /finished: f\.status === 'completed' \|\| f\.status === 'cancelled',/);
  assert.doesNotMatch(dto, /\n\s*status: f\.status,/);
  assert.doesNotMatch(dto, /creator_id: f\.creator_id,/);
  // The detail card carries the same key, so the two stay one shape.
  const j = flocks.indexOf('invitePreview: true,', i + 1);
  const detail = flocks.slice(j - 600, j);
  assert.match(detail, /finished: inv\.status === 'completed' \|\| inv\.status === 'cancelled',/);
});

test('the live invite from a new flock says when and where', () => {
  const i = flocks.indexOf("io.to(`user:${uid}`).emit('flock_invite_received', {");
  const emit = flocks.slice(i, i + 600);
  assert.match(emit, /eventTime: flock\.event_time \|\| null,\s*venueName: flock\.venue_name \|\| null,\s*goingCount: 1,/);
});
