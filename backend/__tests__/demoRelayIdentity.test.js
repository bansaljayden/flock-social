'use strict';
// ---------------------------------------------------------------------------
// WHO THE DEMO THINKS IS ASKING.
//
// The website demo reaches this backend through a Vercel function
// (frontend/api/demo-relay.js), so the source address of every relayed request
// is Vercel's egress, shared by everyone behind that edge. The relay now signs
// the visitor's address (HMAC under RELAY_SIGNING_SECRET, with a timestamp),
// and routes/publicCrowd.js visitorKey believes it only when the signature
// checks out. These tests pin both halves of that: a real signature separates
// visitors, and nothing a direct caller can type does.
// ---------------------------------------------------------------------------
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const SECRET = ['relay', 'test', 'secret', 'x'.repeat(24)].join('-');
const saved = {
  RELAY_SIGNING_SECRET: process.env.RELAY_SIGNING_SECRET,
  PAYWALL_ENABLED: process.env.PAYWALL_ENABLED,
};
process.env.RELAY_SIGNING_SECRET = SECRET;

const {
  visitorKey, relayVerdict, RELAY_MAX_SKEW_S,
  allowDemo, mayShowCrowd, resetDemoLimitsForTest, IP_LIMIT, DEMO_FREE_VENUES,
} = require('../routes/publicCrowd').__testables;

const EGRESS = '76.76.21.9'; // one Vercel edge, shared by every relayed visitor

function signed(ip, { secret = SECRET, tsOffset = 0, sig } = {}) {
  const ts = String(Math.floor(Date.now() / 1000) + tsOffset);
  const mac = sig || crypto.createHmac('sha256', secret).update(`${ip}.${ts}`).digest('hex');
  return {
    ip: EGRESS,
    headers: { 'x-flock-relay-ip': ip, 'x-flock-relay-ts': ts, 'x-flock-relay-sig': mac },
  };
}

beforeEach(() => {
  process.env.RELAY_SIGNING_SECRET = SECRET;
  delete process.env.PAYWALL_ENABLED;
  resetDemoLimitsForTest();
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  resetDemoLimitsForTest();
});

test('a valid relay signature keys the demo on the visitor, not the edge', () => {
  assert.strictEqual(visitorKey(signed('203.0.113.7')), '203.0.113.7');
  assert.strictEqual(visitorKey(signed('2001:DB8::1')), '2001:db8::1', 'IPv6 is keyed in one spelling');
  assert.strictEqual(relayVerdict(signed('203.0.113.7')).status, 'valid');
});

test('forged, stale, partial, malformed and repeated headers all fall back to the source address', () => {
  const cases = [
    ['signed with another secret', signed('203.0.113.7', { secret: 'some-other-secret-value-xx' }), 'bad-signature'],
    ['a signature that is not hex', signed('203.0.113.7', { sig: 'z'.repeat(64) }), 'bad-signature'],
    ['a truncated signature', signed('203.0.113.7', { sig: 'ab'.repeat(16) }), 'bad-signature'],
    ['too old', signed('203.0.113.7', { tsOffset: -(RELAY_MAX_SKEW_S + 5) }), 'stale'],
    ['from the future', signed('203.0.113.7', { tsOffset: RELAY_MAX_SKEW_S + 5 }), 'stale'],
    ['not an address', signed('not-an-address'), 'bad-address'],
    ['an out-of-range octet', signed('999.1.1.1'), 'bad-address'],
  ];
  for (const [what, req, status] of cases) {
    assert.strictEqual(visitorKey(req), EGRESS, `${what} was believed`);
    assert.strictEqual(relayVerdict(req).status, status, what);
  }

  const partial = signed('203.0.113.7');
  delete partial.headers['x-flock-relay-sig'];
  assert.strictEqual(visitorKey(partial), EGRESS, 'a missing signature was believed');

  const doubled = signed('203.0.113.7');
  doubled.headers['x-flock-relay-ip'] = ['203.0.113.7', '198.51.100.1'];
  assert.strictEqual(visitorKey(doubled), EGRESS, 'a repeated header was believed');

  const badTs = signed('203.0.113.7');
  badTs.headers['x-flock-relay-ts'] = '12e9';
  assert.strictEqual(visitorKey(badTs), EGRESS, 'a non-integer timestamp was believed');

  assert.strictEqual(visitorKey({ ip: EGRESS }), EGRESS, 'no headers is the source address');
  assert.strictEqual(visitorKey({ ip: EGRESS, headers: {} }), EGRESS);
});

test('with no secret configured, even a correctly shaped signature is not believed', () => {
  const req = signed('203.0.113.7');
  delete process.env.RELAY_SIGNING_SECRET;
  assert.strictEqual(visitorKey(req), EGRESS);
  assert.strictEqual(relayVerdict(req).status, 'unconfigured');
  process.env.RELAY_SIGNING_SECRET = 'short';
  assert.strictEqual(visitorKey(req), EGRESS, 'a secret under 16 characters is no secret');
});

test('two visitors behind one edge get their own hourly allowance', () => {
  const a = () => signed('203.0.113.7');
  const b = () => signed('203.0.113.8');
  for (let i = 0; i < IP_LIMIT; i += 1) assert.strictEqual(allowDemo(a()), true, `visitor A call ${i}`);
  assert.strictEqual(allowDemo(a()), false, 'visitor A is over their own limit');
  assert.strictEqual(allowDemo(b()), true, 'visitor B was refused because of visitor A');
});

test('a direct caller typing addresses without the signature stays on its own source address', () => {
  const spoof = (n) => ({
    ip: '198.51.100.23',
    headers: { 'x-flock-relay-ip': `203.0.113.${n}`, 'x-flock-relay-ts': String(Math.floor(Date.now() / 1000)), 'x-flock-relay-sig': 'f'.repeat(64) },
  });
  for (let i = 0; i < IP_LIMIT; i += 1) assert.strictEqual(allowDemo(spoof(i)), true, `call ${i}`);
  assert.strictEqual(allowDemo(spoof(200)), false, 'a new made-up address minted a fresh allowance');
});

test('with the paywall on, the three venues a day are per visitor behind the relay', () => {
  process.env.PAYWALL_ENABLED = 'true';
  const venues = Array.from({ length: DEMO_FREE_VENUES + 1 }, (_, i) => `V${i}`);
  for (const id of venues.slice(0, DEMO_FREE_VENUES)) assert.strictEqual(mayShowCrowd(signed('203.0.113.7'), id), true);
  assert.strictEqual(mayShowCrowd(signed('203.0.113.7'), venues[DEMO_FREE_VENUES]), false, 'visitor A got a fourth');
  assert.strictEqual(mayShowCrowd(signed('203.0.113.8'), venues[DEMO_FREE_VENUES]), true, "visitor B inherited visitor A's count");

  // Unsigned, every relayed visitor is the edge, and the edge has one three.
  for (const id of venues.slice(0, DEMO_FREE_VENUES)) assert.strictEqual(mayShowCrowd({ ip: EGRESS }, id), true);
  assert.strictEqual(mayShowCrowd({ ip: EGRESS }, venues[DEMO_FREE_VENUES]), false);
});
