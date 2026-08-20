// Run: node --test  (from backend/)
//
// ===========================================================================
// THE MONDAY VENUE DIGEST SAYS ONLY WHAT THE FACT ENGINE SAID, AND SENDS
// ONLY WHEN EVERY GATE PASSES.
//
// services/venueDigest.js + templates/venueDigestEmail.js render the advisor
// card stack as one Monday email. This file pins the four properties the
// build is not allowed to lose:
//
//   * rendering is a pure function of the fact fixtures: no digit appears in
//     the output that is absent from the input (the fabricated Pro Tips box
//     rule, made mechanical), and no em dash appears anywhere (SLOP rule 1);
//   * tiers: Pro renders the full stack, Premium renders the events heads-up
//     only, free renders nothing;
//   * DIGEST_ENABLED unset means the sweep touches nothing and sends nothing;
//   * notification_prefs.weekly gates every send, and the opt-out token
//     flips it off with no login.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'venue-digest-test-secret';
delete process.env.DIGEST_ENABLED;
delete process.env.VENUE_BILLING_ENABLED;

// --- pg fake ---------------------------------------------------------------
const pool = require('../config/database');
let venueRows;        // what the sweep's venue query returns
let digestClaims;     // INSERT INTO venue_digest_sends rows, with params
let claimConflict;    // when true, the claim reports rowCount 0 (lost the race)
let markerDeletes;    // DELETE FROM venue_digest_sends (per-venue release only)
let prefUpdates;      // UPDATE venue_profiles ... notification_prefs
let queriesRan;       // every SQL string, to prove the OFF sweep runs none

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queriesRan.push(flat);
  if (/FROM venue_profiles vp JOIN users u/.test(flat)) {
    return Promise.resolve({ rows: venueRows, rowCount: venueRows.length });
  }
  if (/INSERT INTO venue_digest_sends/.test(flat)) {
    digestClaims.push({ sql: flat, params });
    return Promise.resolve({ rows: [], rowCount: claimConflict ? 0 : 1 });
  }
  if (/DELETE FROM venue_digest_sends WHERE venue_profile_id/.test(flat)) {
    markerDeletes.push({ sql: flat, params });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/DELETE FROM venue_digest_sends WHERE sent_at/.test(flat)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (/UPDATE venue_profiles/.test(flat)) {
    prefUpdates.push({ sql: flat, params });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// --- email fake, patched BEFORE venueDigest captures the reference ----------
const emailService = require('../services/emailService');
let sentEmails;
let sendResult;
emailService.sendEmail = async (msg) => {
  sentEmails.push(msg);
  return sendResult;
};

const digest = require('../services/venueDigest');
const tpl = require('../templates/venueDigestEmail');

function resetWorld() {
  venueRows = [];
  digestClaims = [];
  markerDeletes = [];
  prefUpdates = [];
  queriesRan = [];
  sentEmails = [];
  sendResult = { sent: true, id: 'test-send' };
  claimConflict = false;
  delete process.env.DIGEST_ENABLED;
  delete process.env.VENUE_BILLING_ENABLED;
  digest._setCardLoaderForTests(async () => FIXTURE_CARDS);
}

// --- fixtures ----------------------------------------------------------------
// The exact shape GET /api/venue/advisor/cards serves (routes/advisor.js,
// pinned by advisorCards.test.js): cards {id,title,facts,status}, facts made
// by advisorFacts.makeFact with the sentence in `label`. Values chosen so
// every digit is distinctive enough for the no-invented-digit sweep to bite.
const FIXTURE_CARDS = [
  {
    id: 'week_ahead',
    title: 'Week ahead',
    status: 'ok',
    facts: [
      { id: 'peak_2026-08-28', value: { date: '2026-08-28', weekday: 'Friday', peakHour: 21, peakScore: 87 }, source: 'model_holdout', asOf: '2026-08-24T12:00:00Z', label: 'Friday 9pm to 11pm projects busiest, a peak of 87 on the 0 to 100 index. An estimate, crowd model, spring 2026 corpus.' },
    ],
  },
  {
    id: 'around_you',
    title: 'Around you this week',
    status: 'ok',
    facts: [
      { id: 'event_2026-08-28', value: { name: 'Franklin Music Hall' }, source: 'events', asOf: '2026-08-24T12:00:00Z', label: 'A listed concert at Franklin Music Hall on Friday, about 800m from you.' },
      { id: 'weather_2026-08-29', value: { temp: 82 }, source: 'weather', asOf: '2026-08-24T12:00:00Z', label: 'The weekend outlook is clear, highs near 82F.' },
    ],
  },
  {
    id: 'listing_read_back',
    title: 'Your listing, read back',
    status: 'ok',
    facts: [
      { id: 'intake_kitchen_last_order', value: '21:00', source: 'intake', asOf: 'owner-set 2026-08-18', label: 'You told us the kitchen takes last orders at 21:00.' },
      // The firing gate: peak at or after last orders. The hedged wording is
      // the fact engine's; the digest only moves it into the anomaly slot.
      { id: 'kitchen_vs_peak', value: { kitchenLastOrder: '21:00', peakHour: 21, peakAtOrAfterLastOrder: true }, source: 'arithmetic', from: ['intake_kitchen_last_order', 'peak_2026-08-28'], asOf: '2026-08-24T12:00:00Z', label: "Friday's projected peak lands around 9pm, at or after your last orders at 21:00. Two facts, side by side." },
    ],
  },
  {
    id: 'readings_vs_estimates',
    title: 'What you said vs what we estimated',
    status: 'ok',
    facts: [
      { id: 'owner_reading_2026-08-22', value: { date: '2026-08-22', peakReading: 74, readings: 5 }, source: 'owner_report', asOf: '2026-08-22', label: 'Your highest reading on 2026-08-22 was 74, from 5 readings. Your own numbers, read back.' },
      { id: 'served_2026-08-22', value: { date: '2026-08-22', serves: 12, medianScore: 61 }, source: 'served_prediction', asOf: '2026-08-22', note: 'What Flock served to people who looked at your venue, not a measurement of your room.', label: 'On 2026-08-22 Flock served 12 crowd estimates for your venue, median 61 on the 0 to 100 index.' },
    ],
  },
];

const RENDER_INPUT_PRO = {
  businessName: 'The Copper Still',
  cards: FIXTURE_CARDS,
  tier: 'pro',
  optOutUrl: 'https://flock-app-production.up.railway.app/api/venue-digest/opt-out?token=TESTTOKEN',
  weekLabel: 'Aug 17 to Aug 23',
};

// A Monday, 9am in America/New_York (13:00Z). 2026-08-24 is a Monday.
const MONDAY_9AM_ET = new Date('2026-08-24T13:00:00Z');
const TUESDAY_9AM_ET = new Date('2026-08-25T13:00:00Z');

function eligibleVenueRow(overrides = {}) {
  return {
    id: 7,
    user_id: 42,
    business_name: 'The Copper Still',
    tier: 'pro',
    google_place_id: 'ChIJtestplace',
    notification_prefs: { bookings: true, reviews: true, weekly: true },
    email: 'owner@copperstill.example.com',
    email_verified: true,
    is_banned: false,
    timezone: 'America/New_York',
    ...overrides,
  };
}

// Every run of digits in the rendered output must exist somewhere in the
// input fixture. Styling numbers inside HTML attributes are exempted by
// checking TEXT content: tags are stripped first for the HTML variant.
function digitRuns(s) {
  return (s.match(/\d+/g) || []);
}
function assertNoInventedDigits(rendered, input) {
  const allowed = JSON.stringify(input);
  for (const run of digitRuns(rendered)) {
    assert.ok(
      allowed.includes(run),
      `rendered digest contains "${run}", which appears nowhere in the fact fixtures. ` +
      'Every figure must come from a fact object (SLOP rule 5; the Pro Tips precedent).'
    );
  }
}
function stripTags(html) {
  // Entities go back to characters before the digit sweep runs, or the
  // escaper's &#39; for an apostrophe reads as an invented "39".
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ============================================================================
// Rendering
// ============================================================================
test('pro digest renders all four cards, one anomaly block, recap before heads-up', () => {
  resetWorld();
  const text = tpl.renderDigestText(RENDER_INPUT_PRO);
  const html = tpl.renderDigestHtml(RENDER_INPUT_PRO);

  for (const out of [text, stripTags(html)]) {
    assert.ok(out.includes('The Copper Still'));
    assert.ok(out.includes('Your highest reading on 2026-08-22 was 74'));
    assert.ok(out.includes('Friday 9pm to 11pm projects busiest'));
    assert.ok(out.includes('A listed concert at Franklin Music Hall'));
    assert.ok(out.includes('kitchen takes last orders'));
  }

  // Exactly one anomaly block, and it is the card whose status fired.
  assert.strictEqual((text.match(/Worth a look/gi) || []).length, 1);
  assert.ok(/Worth a look: Your listing, read back/i.test(text));

  // Night-audit order: last week's numbers, then the anomaly, then the next
  // seven days.
  const upper = text.toUpperCase();
  const recapAt = upper.indexOf('YOUR HIGHEST READING');
  const anomalyAt = upper.indexOf('WORTH A LOOK');
  const headsUpAt = upper.indexOf('WEEK AHEAD');
  assert.ok(recapAt !== -1 && anomalyAt !== -1 && headsUpAt !== -1);
  assert.ok(recapAt < anomalyAt && anomalyAt < headsUpAt,
    'digest must read recap, then the one anomaly, then the heads-ups');

  // Sources and as-of dates ride along with the facts, worded for a person.
  assert.ok(text.includes('your reading'));
  assert.ok(!text.includes('owner_report'), 'source ids are machine vocabulary; the email words them');
  assert.ok(text.includes('2026-08-22'));

  // The opt-out link is in both variants.
  assert.ok(text.includes(RENDER_INPUT_PRO.optOutUrl));
  assert.ok(html.includes('Stop these emails'));
});

test('premium digest is the events heads-up only', () => {
  resetWorld();
  const input = { ...RENDER_INPUT_PRO, tier: 'premium' };
  const text = tpl.renderDigestText(input);
  assert.ok(text.includes('A listed concert at Franklin Music Hall'));
  assert.ok(!text.includes('Your highest reading on'),
    'premium must not receive the owner-numbers recap');
  assert.ok(!text.includes('projects busiest'),
    'premium must not receive the forecast card');
  assert.ok(!text.includes('kitchen takes last orders'),
    'premium must not receive the intake read-back');
  assert.ok(text.includes(input.optOutUrl));
});

test('free tier renders no cards at all', () => {
  resetWorld();
  const text = tpl.renderDigestText({ ...RENDER_INPUT_PRO, tier: 'free' });
  assert.ok(!text.includes('Franklin Music Hall'));
  assert.ok(!text.includes('74'));
});

test('no digit in the rendered digest is absent from the fixtures, both tiers, both formats', () => {
  resetWorld();
  for (const tier of ['pro', 'premium']) {
    const input = { ...RENDER_INPUT_PRO, tier };
    assertNoInventedDigits(tpl.renderDigestText(input), input);
    assertNoInventedDigits(stripTags(tpl.renderDigestHtml(input)), input);
  }
});

test('no em dash anywhere in the rendered digest (SLOP rule 1)', () => {
  resetWorld();
  for (const tier of ['pro', 'premium']) {
    const input = { ...RENDER_INPUT_PRO, tier };
    assert.ok(!tpl.renderDigestText(input).includes('—'));
    assert.ok(!tpl.renderDigestHtml(input).includes('—'));
  }
});

test('a long card truncates to a Roost pointer, with no invented count', () => {
  resetWorld();
  const manyFacts = Array.from({ length: 9 }, (_, i) => ({
    id: `owner_reading_2026-08-1${i}`,
    value: {},
    source: 'owner_report',
    asOf: `2026-08-1${i}`,
    label: `Your highest reading on 2026-08-1${i} was 70. Your own numbers, read back.`,
  }));
  const input = {
    ...RENDER_INPUT_PRO,
    cards: [{ id: 'readings_vs_estimates', title: 'What you said vs what we estimated', status: 'ok', facts: manyFacts }],
  };
  const text = tpl.renderDigestText(input);
  assert.ok(text.includes(`More in ${tpl.ADVISOR_FEATURE_NAME}, in your venue dashboard.`));
  assert.strictEqual(tpl.ADVISOR_FEATURE_NAME, 'Roost');
  assert.ok(!text.includes('2026-08-17'), 'lines past the cap are trimmed');
  assertNoInventedDigits(text, input);
});

test('a quiet week reads quiet week, with no urgency and no upsell', () => {
  resetWorld();
  const input = { ...RENDER_INPUT_PRO, cards: [], tier: 'pro' };
  const text = tpl.renderDigestText(input);
  assert.ok(text.includes('Nothing to report this week.'));
  assert.ok(!/upgrade|unlock|don't miss|act now/i.test(text));
});

// ============================================================================
// The sweep
// ============================================================================
test('DIGEST_ENABLED unset: the sweep runs no queries and sends nothing', async () => {
  resetWorld();
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.deepStrictEqual(tally, { considered: 0, sent: 0, skipped: 0, failed: 0 });
  assert.strictEqual(queriesRan.length, 0, 'an OFF digest must not even read the database');
  assert.strictEqual(sentEmails.length, 0);
});

test('DIGEST_ENABLED with a non-true value stays off', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'false';
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.sent, 0);
  assert.strictEqual(sentEmails.length, 0);
});

test('eligible venue on Monday morning gets exactly one digest, claimed before the send', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.sent, 1);
  assert.strictEqual(sentEmails.length, 1);
  assert.strictEqual(sentEmails[0].to, 'owner@copperstill.example.com');
  assert.ok(sentEmails[0].subject.includes('The Copper Still'));
  assert.ok(sentEmails[0].html.includes('Stop these emails'));
  // The dedupe row was claimed with the venue-local Monday as the key.
  assert.strictEqual(digestClaims.length, 1);
  assert.deepStrictEqual(digestClaims[0].params, [7, '2026-08-24']);
});

test('notification_prefs.weekly false or missing means no send (opt-in only)', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [
    eligibleVenueRow({ notification_prefs: { bookings: true, reviews: true, weekly: false } }),
    eligibleVenueRow({ id: 8, notification_prefs: null }),
    eligibleVenueRow({ id: 9, notification_prefs: 'legacy-garbage' }),
  ];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.sent, 0);
  assert.strictEqual(sentEmails.length, 0);
  assert.strictEqual(digestClaims.length, 0, 'a skipped venue must not even claim a marker');
});

test('not Monday morning on the venue clock means no send', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(TUESDAY_9AM_ET);
  assert.strictEqual(tally.sent, 0);
  assert.strictEqual(sentEmails.length, 0);
});

test('venue-local clock decides: 13:00Z is Monday 9am in New York but Monday 10pm in Tokyo', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow({ timezone: 'Asia/Tokyo' })];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.sent, 0, 'Monday 10pm local is not Monday morning');
});

test('losing the dedupe claim means no send (deploy-overlap double-mail guard)', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  claimConflict = true;
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.sent, 0);
  assert.strictEqual(sentEmails.length, 0);
});

test('a failed send releases its marker so the next hourly sweep can retry', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  sendResult = { sent: false, error: 'provider blip' };
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.failed, 1);
  assert.strictEqual(markerDeletes.length, 1);
  assert.deepStrictEqual(markerDeletes[0].params, [7, '2026-08-24']);
});

test('tier gating: premium venue gets the events-only digest, free venue gets nothing, when billing is enforced', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  process.env.VENUE_BILLING_ENABLED = 'true';
  venueRows = [
    eligibleVenueRow({ id: 11, tier: 'premium', business_name: 'Premium Bar' }),
    eligibleVenueRow({ id: 12, tier: 'free', business_name: 'Free Bar' }),
  ];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.sent, 1);
  assert.strictEqual(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.ok(html.includes('Franklin Music Hall'), 'premium keeps the events heads-up');
  assert.ok(!html.includes('projects busiest'), 'premium must not get the forecast card');
  assert.ok(!stripTags(html).includes('74'), 'premium must not get the owner-numbers recap');
});

test('unverified email, banned owner, unmailable address: all skipped', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [
    eligibleVenueRow({ id: 21, email_verified: false }),
    eligibleVenueRow({ id: 22, is_banned: true }),
    eligibleVenueRow({ id: 23, email: 'owner@copperstill.invalid' }),
  ];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.sent, 0);
  assert.strictEqual(sentEmails.length, 0);
});

// ============================================================================
// Opt-out
// ============================================================================
test('the opt-out token flips notification_prefs.weekly to false', async () => {
  resetWorld();
  const token = digest.optOutToken(7);
  const result = await digest.applyOptOut(token);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(prefUpdates.length, 1);
  assert.ok(/"weekly": false/.test(prefUpdates[0].sql));
  assert.deepStrictEqual(prefUpdates[0].params, [7]);
});

test('a token without the digest purpose is refused, even when validly signed', async () => {
  resetWorld();
  const sessionish = jwt.sign({ vp: 7, purpose: 'something_else' }, process.env.JWT_SECRET);
  const result = await digest.applyOptOut(sessionish);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(prefUpdates.length, 0);

  const noPurpose = jwt.sign({ userId: 7 }, process.env.JWT_SECRET);
  const result2 = await digest.applyOptOut(noPurpose);
  assert.strictEqual(result2.ok, false);
  assert.strictEqual(prefUpdates.length, 0);
});

// Round 25 (adversarial): the opt-out family and the session family must be
// separable by KEY, not only by a claim. The purpose check held one direction;
// the other direction held by accident (a digest token reaching
// middleware/auth.js verifies its signature and is rejected only because it
// carries no userId to look up). A derived key closes both directions for good.
test('an opt-out token and a session token cannot cross, in either direction', async () => {
  resetWorld();

  // Direction 1: correctly-shaped claims signed with the RAW session secret
  // must not unsubscribe anything. Before the derived key this was accepted:
  // the signature verified and the purpose claim was right.
  const forged = jwt.sign({ vp: 7, purpose: 'venue_digest_optout' }, process.env.JWT_SECRET);
  const r1 = await digest.applyOptOut(forged);
  assert.strictEqual(r1.ok, false, 'a JWT_SECRET-signed opt-out claim must not verify here');
  assert.strictEqual(prefUpdates.length, 0);

  // Direction 2: a real opt-out token must not verify against the session
  // secret, so no session verifier can ever be reached by one.
  const real = digest.optOutToken(7);
  assert.throws(
    () => jwt.verify(real, process.env.JWT_SECRET),
    /signature/i,
    'an opt-out token must not verify against JWT_SECRET'
  );
  // ...and it still works against its own key.
  assert.strictEqual((await digest.applyOptOut(real)).ok, true);
});

test('the opt-out verifier pins its algorithm', async () => {
  resetWorld();
  const src = fs.readFileSync(require.resolve('../services/venueDigest.js'), 'utf8');
  assert.ok(
    /jwt\.verify\(\s*token,\s*key,\s*\{\s*algorithms:/.test(src),
    'jwt.verify must pin algorithms — an undefined set is inferred from the key'
  );
  assert.ok(
    !/jwt\.(sign|verify)\([^)]*process\.env\.JWT_SECRET/.test(src),
    'neither half of the opt-out token may touch the session secret directly'
  );
});

test('garbage and empty tokens are refused without touching the database', async () => {
  resetWorld();
  for (const bad of ['not-a-token', '', null, undefined]) {
    const result = await digest.applyOptOut(bad);
    assert.strictEqual(result.ok, false);
  }
  assert.strictEqual(prefUpdates.length, 0);
});

test('GET /api/venue-digest/opt-out works end to end and answers a person, not an API client', async () => {
  resetWorld();
  const app = express();
  app.use('/api/venue-digest', require('../routes/venueDigest'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

  try {
    const good = await get(`/api/venue-digest/opt-out?token=${encodeURIComponent(digest.optOutToken(7))}`);
    assert.strictEqual(good.status, 200);
    assert.ok(good.body.includes('You are unsubscribed'));
    assert.strictEqual(prefUpdates.length, 1);

    const bad = await get('/api/venue-digest/opt-out?token=garbage');
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.body.includes('expired'));

    const missing = await get('/api/venue-digest/opt-out');
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(prefUpdates.length, 1, 'a refused link must not write');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ============================================================================
// The email itself carries no em dash either (the sweep path, not just the
// template unit): render through the sweep and check what sendEmail got.
// ============================================================================
test('the mailed HTML carries no em dash and no digits foreign to the facts', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow()];
  await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.ok(!html.includes('—'));
  // Digits allowed: the fixtures, the venue row, the week label the sweep
  // computed from the venue-local calendar, and the signed opt-out link.
  const textOnly = stripTags(html);
  const allowed = JSON.stringify({
    cards: FIXTURE_CARDS,
    row: venueRows[0],
    weekLabel: digest.lastWeekLabel(digest.localParts(MONDAY_9AM_ET, 'America/New_York')),
    optOut: sentEmails[0].html.match(/href="([^"]*opt-out[^"]*)"/)?.[1] || '',
  });
  for (const run of (textOnly.match(/\d+/g) || [])) {
    assert.ok(allowed.includes(run),
      `mailed digest contains "${run}" from nowhere in the facts or the calendar`);
  }
});
