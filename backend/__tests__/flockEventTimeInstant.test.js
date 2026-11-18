// Run: node --test __tests__/flockEventTimeInstant.test.js  (from backend/)
//
// A PLAN'S TIME IS A REAL INSTANT, AND IT IS STORED AS UTC.
//
// flocks.event_time is a naive TIMESTAMP holding UTC wall time. The three
// routes that write it from a request (POST /, PUT /:id, POST /:id/rerun)
// checked it with a bare isISO8601(), which tests the shape of a string and not
// the instant it names:
//
//   * `2027-02-30T20:00:00Z`, a day that does not exist, and the week, ordinal
//     and truncated forms (`2027-W05-3`, `2027-036`, `2027`) all passed it and
//     reached Postgres, which refused them: a 500 for a value the caller picks.
//   * `2027-03-05T21:00:00-05:00` passed it too, and a TIMESTAMP column drops an
//     offset without converting, so the plan was stored five hours early.
//
// This runs the chains the router really mounts against a request, the way
// validatorMessagesNamed.test.js does, and reads what the handler would get.

const test = require('node:test');
const assert = require('node:assert');
const { validationResult } = require('express-validator');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'event-time-instant-test-secret';

const flocks = require('../routes/flocks');

const ROUTES = [
  ['post', '/', {}],
  ['put', '/:id', { id: '5' }],
  ['post', '/:id/rerun', { id: '5' }],
];

function chainsOf(method, path) {
  const layer = flocks.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `routes/flocks.js has no ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle).filter((h) => h && h.builder);
}

// The event_time error, if any, and the value the handler would read.
async function runEventTime(method, path, params, eventTime) {
  const req = { params, body: { name: 'Dinner', event_time: eventTime }, query: {}, headers: {}, cookies: {} };
  for (const chain of chainsOf(method, path)) await chain.run(req);
  const error = validationResult(req).array().find((e) => e.path === 'event_time');
  return { error: error ? error.msg : null, value: req.body.event_time };
}

test('a time that is not a real instant is refused with the message the app shows', async () => {
  const refused = [
    '2027-02-30T20:00:00Z', // February has no 30th
    '2027-02-31',
    '2026-02-29T20:00:00Z', // not a leap year
    '2027-W05-3', // ISO week date
    '2027-036', // ISO ordinal date
    '2027', '2027-03', // truncated
    '20270301T200000Z', // basic form
    '2027-03-01T24:00:00Z',
    '2027-03-01T23:60:00Z',
    '0000-03-01T00:00:00Z', // no year zero
    '9999-12-31T23:00:00-05:00', // past the last year a column takes, once in UTC
    'next friday',
    20270301,
  ];
  for (const [method, path, params] of ROUTES) {
    for (const value of refused) {
      const { error } = await runEventTime(method, path, params, value);
      assert.strictEqual(error, 'Invalid event time', `${method.toUpperCase()} ${path} took ${JSON.stringify(value)}`);
    }
  }
});

test('an offset is converted, not dropped, and the handler gets the instant in UTC', async () => {
  const cases = [
    ['2027-03-05T21:00:00-05:00', '2027-03-06T02:00:00.000Z'],
    ['2027-03-05T21:00:00+0530', '2027-03-05T15:30:00.000Z'],
    ['2027-03-05T21:00:00+05', '2027-03-05T16:00:00.000Z'],
    // What the app sends (Date.toISOString) goes through unchanged.
    ['2027-03-01T20:00:00.000Z', '2027-03-01T20:00:00.000Z'],
    ['2027-03-01T20:00Z', '2027-03-01T20:00:00.000Z'],
    ['2024-02-29T20:00:00Z', '2024-02-29T20:00:00.000Z'],
    // No offset was always stored as given, which the column reads as UTC; it
    // is not left to the server's own timezone.
    ['2027-03-01T20:00:00', '2027-03-01T20:00:00.000Z'],
    ['2027-03-01 20:00:00', '2027-03-01T20:00:00.000Z'],
    ['2027-03-01', '2027-03-01T00:00:00.000Z'],
  ];
  for (const [method, path, params] of ROUTES) {
    for (const [sent, stored] of cases) {
      const { error, value } = await runEventTime(method, path, params, sent);
      assert.strictEqual(error, null, `${method.toUpperCase()} ${path} refused ${sent}`);
      assert.strictEqual(value, stored, `${method.toUpperCase()} ${path} ${sent}`);
    }
  }
});

test('an event time left out is still left out', async () => {
  for (const [method, path, params] of ROUTES) {
    const req = { params, body: { name: 'Dinner' }, query: {}, headers: {}, cookies: {} };
    for (const chain of chainsOf(method, path)) await chain.run(req);
    assert.ok(!validationResult(req).array().some((e) => e.path === 'event_time'));
    assert.strictEqual(req.body.event_time, undefined);
  }
});
