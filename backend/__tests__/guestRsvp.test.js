// Run: node --test  (from backend/)
//
// Round 14: guests could RSVP through a share link and the host never saw it.
// routes/flocks.js did not read guest_rsvps at all, so guest answers were
// absent from the flock detail payload, the roster and every count, and the
// `guest_rsvp` socket event went to a room the host is usually not in.
//
// These cover the pure pieces of that fix — the shape guests are returned in,
// the count arithmetic, and where the realtime event is addressed. The SQL
// itself is verified by reading it against migrations/001_baseline.sql and
// 005_guest_rsvp_takedown.sql (see the is_hidden assertions below).
const test = require('node:test');
const assert = require('node:assert');

const {
  GUEST_RSVP_SELECT,
  guestEntryId,
  toGuestEntry,
  combineRsvpCounts,
} = require('../utils/guestRsvp');

const pool = require('../config/database');
const { broadcastGuestRsvp } = require('../sockets/handlers');

const guestRow = (over = {}) => ({
  id: 12,
  name: 'Sam',
  status: 'in',
  created_at: '2026-08-13T20:00:00.000Z',
  updated_at: '2026-08-13T20:00:00.000Z',
  ...over,
});

test('guest entry is tagged and can never pass as a member', () => {
  const g = toGuestEntry(guestRow());

  assert.strictEqual(g.is_guest, true);
  assert.strictEqual(g.name, 'Sam');
  assert.strictEqual(g.guest_id, 12);

  // The id must not be usable as a user id. Member-only paths (attendance
  // marking) put it in `WHERE user_id = $1` against an INTEGER column: a bare
  // 12 would silently hit whichever real account owns id 12.
  assert.strictEqual(g.id, 'guest:12');
  assert.strictEqual(Number.isInteger(Number(g.id)), false);
  assert.notStrictEqual(g.id, g.guest_id);

  // Guests have no account, so none of the account-only fields may carry data.
  assert.strictEqual(g.profile_image_url, null);
  assert.strictEqual(g.reliability_score, null);
  assert.strictEqual(g.attendance, null);
  assert.strictEqual(g.id, guestEntryId(12));
});

test("guest status maps onto the member vocabulary, both ways round", () => {
  const yes = toGuestEntry(guestRow({ status: 'in' }));
  assert.strictEqual(yes.status, 'accepted');
  assert.strictEqual(yes.guest_status, 'in');

  const no = toGuestEntry(guestRow({ id: 13, status: 'out' }));
  assert.strictEqual(no.status, 'declined');
  assert.strictEqual(no.guest_status, 'out');
});

test('counts fold guests into "going" and into responses', () => {
  const members = [
    { status: 'accepted' },
    { status: 'accepted' },
    { status: 'invited' },   // has not answered
    { status: 'declined' },
  ];
  const guests = [
    toGuestEntry(guestRow({ id: 1, status: 'in' })),
    toGuestEntry(guestRow({ id: 2, status: 'in' })),
    toGuestEntry(guestRow({ id: 3, status: 'out' })),
  ];

  const c = combineRsvpCounts(members, guests);

  assert.strictEqual(c.memberAccepted, 2);
  assert.strictEqual(c.guestsGoing, 2);
  assert.strictEqual(c.accepted, 4);       // this is the "4 going" the host sees
  assert.strictEqual(c.declined, 2);       // 1 member + 1 guest
  assert.strictEqual(c.guestCount, 3);
  assert.strictEqual(c.total, 7);

  // A guest row only exists because someone answered the link, so every guest
  // is already a response — unlike the 'invited' member, who is not.
  assert.strictEqual(c.responded, 6);
  assert.ok(c.responded < c.total, 'the un-answered invite must still be pending');
});

test('counts are unchanged when a flock has no guests', () => {
  const members = [{ status: 'accepted' }, { status: 'invited' }];
  const c = combineRsvpCounts(members, []);
  assert.strictEqual(c.accepted, 1);
  assert.strictEqual(c.total, 2);
  assert.strictEqual(c.responded, 1);
  assert.strictEqual(c.guestCount, 0);
});

test('the guest roster query excludes moderator-hidden rows', () => {
  // Migration 005 added is_hidden with a DEFAULT, so drifted rows can be NULL —
  // a plain `is_hidden = false` would drop every pre-migration guest.
  assert.match(GUEST_RSVP_SELECT, /COALESCE\(is_hidden, false\) = false/);
  assert.match(GUEST_RSVP_SELECT, /FROM guest_rsvps/);
  assert.match(GUEST_RSVP_SELECT, /flock_id = \$1/);
});

test('guest_rsvp reaches every accepted member personally, not just the flock room', async () => {
  const realQuery = pool.query;
  pool.query = async () => ({ rows: [{ user_id: 7 }, { user_id: 9 }] });

  const emitted = [];
  const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };

  try {
    const delivered = await broadcastGuestRsvp(io, 42, { flockId: 42, name: 'Sam', status: 'in' });
    assert.deepStrictEqual(delivered, [7, 9]);
  } finally {
    pool.query = realQuery;
  }

  assert.strictEqual(emitted.length, 2);
  assert.deepStrictEqual(emitted.map(e => e.room).sort(), ['user:7', 'user:9']);
  assert.ok(emitted.every(e => e.event === 'guest_rsvp'));

  // The whole bug: `flock:42` is only joined while that flock's screen is open,
  // so a host anywhere else in the app never received the event.
  assert.ok(!emitted.some(e => e.room === 'flock:42'), 'must not target the flock room');

  // ...and exactly once each, so a host who DOES have the flock open does not
  // see the RSVP twice.
  assert.strictEqual(new Set(emitted.map(e => e.room)).size, emitted.length);
});

test('broadcast is a no-op without io rather than a throw', async () => {
  assert.deepStrictEqual(await broadcastGuestRsvp(null, 42, {}), []);
});
