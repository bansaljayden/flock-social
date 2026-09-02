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
let markersOnRecord;  // week markers already in venue_digest_sends: `${vpId}|${weekStart}`
let markerReads;      // the pre-check SELECT, one per venue that reached it
let markerDeletes;    // DELETE FROM venue_digest_sends (per-venue release only)
let prefUpdates;      // UPDATE venue_profiles ... notification_prefs
let prefReads;        // SELECT notification_prefs (the GET page's only query)
let prefsOnRecord;    // what that SELECT finds; null means the row is gone
let queriesRan;       // every SQL string, to prove the OFF sweep runs none

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queriesRan.push(flat);
  if (/FROM venue_profiles vp JOIN users u/.test(flat)) {
    return Promise.resolve({ rows: venueRows, rowCount: venueRows.length });
  }
  if (/SELECT 1 FROM venue_digest_sends/.test(flat)) {
    markerReads.push({ sql: flat, params });
    const held = markersOnRecord.has(`${params[0]}|${params[1]}`);
    return Promise.resolve({ rows: held ? [{ '?column?': 1 }] : [], rowCount: held ? 1 : 0 });
  }
  if (/INSERT INTO venue_digest_sends/.test(flat)) {
    digestClaims.push({ sql: flat, params });
    if (claimConflict) return Promise.resolve({ rows: [], rowCount: 0 });
    markersOnRecord.add(`${params[0]}|${params[1]}`);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/DELETE FROM venue_digest_sends WHERE venue_profile_id/.test(flat)) {
    markerDeletes.push({ sql: flat, params });
    markersOnRecord.delete(`${params[0]}|${params[1]}`);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/DELETE FROM venue_digest_sends WHERE sent_at/.test(flat)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (/UPDATE venue_profiles/.test(flat)) {
    prefUpdates.push({ sql: flat, params });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/SELECT notification_prefs FROM venue_profiles/.test(flat)) {
    prefReads.push({ sql: flat, params });
    return prefsOnRecord === null
      ? Promise.resolve({ rows: [], rowCount: 0 })
      : Promise.resolve({ rows: [{ notification_prefs: prefsOnRecord }], rowCount: 1 });
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
  prefReads = [];
  prefsOnRecord = { bookings: true, reviews: true, weekly: true };
  queriesRan = [];
  sentEmails = [];
  sendResult = { sent: true, id: 'test-send' };
  claimConflict = false;
  markersOnRecord = new Set();
  markerReads = [];
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
  optOutUrl: 'https://api.flockcorp.com/api/venue-digest/opt-out?token=TESTTOKEN',
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

// The source chip on every line ended in a raw ISO date, because factAsOf
// trimmed `2026-08-24T12:00:00Z` to `2026-08-24` and printed that. Every fact
// the engine builds sets `asOf: now.toISOString()`, so EVERY line of EVERY
// digest carried one, in an email a bar owner reads on a Monday morning, while
// the same dates inside the fact labels were formatted properly by
// advisorFacts.shortDate. advisorFacts' own comment predicted this: "a date
// helper that lives in one of three files that all print dates is a raw ISO
// string waiting to reappear in the other two."
test('no raw ISO date reaches the reader: the source chips read Aug 24, not 2026-08-24', () => {
  resetWorld();
  // The chip is the parenthesised `(source, as-of)` suffix this file appends;
  // the sentence in front of it is the fact engine's label, whose own dates are
  // formatted by advisorFacts.shortDate (a couple of fixtures here quote raw
  // ISO strings that the real builders do not produce, which is why the
  // assertion is scoped to what THIS file writes).
  const text = tpl.renderDigestText(RENDER_INPUT_PRO);
  const html = stripTags(tpl.renderDigestHtml(RENDER_INPUT_PRO));
  for (const out of [text, html]) {
    const chips = out.match(/\([^()]*\)/g) || [];
    assert.ok(chips.length, 'no source chips rendered at all');
    for (const chip of chips) {
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(chip), `a raw column-shaped date reached the owner: ${chip}`);
    }
    assert.ok(chips.some((c) => c.includes('Aug 24')), 'the as-of date has to still be there, just worded');
  }
  // The already-worded form ("owner-set 2026-08-18") gets the same treatment
  // rather than only bare dates.
  assert.ok(text.includes('owner-set Aug 18'), 'a date inside worded asOf text is still a raw date');
});

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
  assert.deepStrictEqual(tally, { considered: 0, due: 0, alreadySent: 0, sent: 0, skipped: 0, failed: 0 });
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

test('a send the provider refused releases its marker so the next hourly sweep can retry', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  // `refused` is sendEmail's word for "the provider answered and declined", so
  // nothing left the building and a retry cannot duplicate anything.
  sendResult = { sent: false, error: 'provider blip', refused: true };
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.failed, 1);
  assert.strictEqual(markerDeletes.length, 1);
  assert.deepStrictEqual(markerDeletes[0].params, [7, '2026-08-24']);
});

test('a skipped send (no RESEND_API_KEY) releases its marker too', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  sendResult = { sent: false, skipped: true };
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.failed, 1);
  assert.strictEqual(markerDeletes.length, 1);
});

// The duplicate-send guard. sendEmail carries an 8s abort deadline, so a Resend
// call accepted at 8.1 seconds comes back here as a plain error having ALREADY
// queued the message. Releasing the marker on that let the next sweep inside
// the 07:00-11:59 window claim it again and mail the same digest a second time,
// billed a second time, up to five times on one Monday. An outcome nobody can
// prove was not sent keeps its marker.
test('an ambiguous failure keeps its marker, so an aborted-but-accepted send cannot be mailed twice', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  sendResult = { sent: false, error: 'The operation was aborted' };
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(tally.failed, 1);
  assert.strictEqual(markerDeletes.length, 0, 'the marker must survive an outcome nobody can prove was not sent');
});

// ============================================================================
// THE SEND WINDOW IS FIVE HOURS WIDE AND THE SWEEP IS HOURLY, SO A MAILED
// VENUE IS WALKED FOUR MORE TIMES.
//
// Building the card stack is not cheap and it is not local: buildAroundYou
// probes Ticketmaster once per day of the week through mlPredictor's shared
// event cache and daily budget, buildWeekAhead runs a seven-day model forecast,
// and the verdict and readings cards each aggregate the venue's own history.
// Doing all of that and THEN losing the claim, four times per venue, turns
// Monday breakfast into the heaviest hour of the product's week on work that by
// construction cannot produce an email.
// ============================================================================
test('a venue already mailed this Monday does not rebuild its advisor cards on the next hourly sweep', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  let builds = 0;
  digest._setCardLoaderForTests(async () => { builds += 1; return FIXTURE_CARDS; });
  venueRows = [eligibleVenueRow()];

  const first = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(first.sent, 1);
  assert.strictEqual(builds, 1);

  // 10 AM, same venue, same local Monday, marker already on record.
  const second = await digest.runVenueDigestSweep(new Date('2026-08-24T14:00:00Z'));
  assert.strictEqual(second.sent, 0);
  assert.strictEqual(second.alreadySent, 1);
  assert.strictEqual(sentEmails.length, 1, 'and still exactly one email');
  assert.strictEqual(builds, 1,
    'the second pass must ask the marker table before it asks the fact engine');
  assert.strictEqual(digestClaims.length, 1,
    'and must not spend an INSERT on a row it already owns');
});

test('the pre-check never stands in for the claim: a venue with no marker still builds and sends', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow()];
  const tally = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(markerReads.length, 1, 'one indexed read per due venue');
  assert.deepStrictEqual(markerReads[0].params, [7, '2026-08-24']);
  assert.strictEqual(tally.sent, 1);
});

test('a released marker is retried, so a refused send still gets its next hour', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  sendResult = { sent: false, error: 'provider blip', refused: true };
  venueRows = [eligibleVenueRow()];
  await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(markerDeletes.length, 1);
  // The pre-check must read the release, not a cached idea of it, or a venue
  // whose 7 AM send failed would never be mailed at 8 AM.
  sendResult = { sent: true, id: 'test-send' };
  const second = await digest.runVenueDigestSweep(new Date('2026-08-24T14:00:00Z'));
  assert.strictEqual(second.sent, 1);
  assert.strictEqual(second.alreadySent, 0);
});

// ============================================================================
// A SCHEDULED JOB THAT STOPS DOING ITS JOB LOOKS EXACTLY LIKE ONE WITH NOTHING
// TO DO. The sweep used to print a line only when something was sent or failed,
// so a Monday on which it mailed nobody was byte-identical in the log to a
// Tuesday, to a sweep whose venue query threw, and to a process where the timer
// was never registered at all.
// ============================================================================
test('a Monday sweep says how many venues were due even when it mails none of them', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow(), eligibleVenueRow({ id: 8, user_id: 43 })];
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await digest.runVenueDigestSweep(MONDAY_9AM_ET);         // both mailed
    lines.length = 0;
    await digest.runVenueDigestSweep(new Date('2026-08-24T14:00:00Z')); // both already mailed
  } finally {
    console.log = realLog;
  }
  const line = lines.find((l) => l.includes('[venueDigest] sweep:'));
  assert.ok(line, 'an hour with venues due has to leave evidence that it ran');
  assert.match(line, /2 due/);
  assert.match(line, /2 already mailed/);
});

test('a sweep with nothing due stays quiet, so the heartbeat means something', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow()];
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const tally = await digest.runVenueDigestSweep(TUESDAY_9AM_ET);
    assert.strictEqual(tally.due, 0);
  } finally {
    console.log = realLog;
  }
  assert.strictEqual(lines.filter((l) => l.includes('[venueDigest] sweep:')).length, 0,
    'a line printed 168 times a week is a line nobody reads on the one hour it matters');
});

test('the digest is sent as marketing and carries a plain-text alternative part', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow()];
  await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(sentEmails.length, 1);
  const msg = sentEmails[0];
  assert.strictEqual(msg.category, 'marketing',
    'the digest is a recurring commercial mailing, so a general unsubscribe has to bind on it');
  assert.ok(typeof msg.text === 'string' && msg.text.trim().length > 0,
    'an HTML-only message scores worse with every major spam filter');
  assert.ok(msg.text.includes('Your week at'), 'the text part is the digest, not a placeholder');
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

// ============================================================================
// The link in the email: GET RENDERS, POST WRITES.
//
// A GET that unsubscribed on arrival was an unsubscribe that anything could
// fire. Microsoft Defender Safe Links, Proofpoint URL Defense and Gmail's
// scanner all follow every href in a message unattended, so the first thing
// to reach that link would have been a robot, and the owner's only evidence
// would be a dashboard switch that turned itself off. These tests pin the
// split: the GET touches no write, the POST is the whole mutation, and a
// second POST is a success rather than an error.
// ============================================================================
function openRouter() {
  const app = express();
  app.use('/api/venue-digest', require('../routes/venueDigest'));
  return new Promise((resolve) => {
    const s = app.listen(0, () => {
      const port = s.address().port;
      const call = (method, path) => new Promise((res, rej) => {
        const req = http.request(
          { host: '127.0.0.1', port, path, method },
          (r) => {
            let body = '';
            r.on('data', (c) => { body += c; });
            r.on('end', () => res({ status: r.statusCode, body }));
          }
        );
        req.on('error', rej);
        req.end();
      });
      resolve({
        get: (path) => call('GET', path),
        post: (path) => call('POST', path),
        close: () => new Promise((done) => s.close(done)),
      });
    });
  });
}

const OPT_OUT = '/api/venue-digest/opt-out';
const linkFor = (id) => `${OPT_OUT}?token=${encodeURIComponent(digest.optOutToken(id))}`;

test('the emailed GET only renders: a valid token draws a confirm form and writes nothing', async () => {
  resetWorld();
  const srv = await openRouter();
  try {
    // Twice, because a mail scanner and then the recipient is the real
    // sequence, and neither fetch may be the unsubscribe.
    const first = await srv.get(linkFor(7));
    const second = await srv.get(linkFor(7));

    for (const res of [first, second]) {
      assert.strictEqual(res.status, 200);
      assert.ok(/<form[^>]+method="post"/i.test(res.body), 'the GET must offer the write, not perform it');
      assert.ok(res.body.includes('Turn off the Monday digest'));
      assert.ok(!res.body.includes('You are unsubscribed'));
    }
    assert.deepStrictEqual(prefUpdates, [], 'a GET on the unsubscribe link must not write');
    assert.strictEqual(prefReads.length, 2, 'the page reads the current switch, and only that');
    assert.ok(
      queriesRan.every((q) => !/^(UPDATE|INSERT|DELETE)/i.test(q)),
      `a GET ran a mutating statement: ${queriesRan.join(' | ')}`
    );
    // The form posts back to the same link, token and all.
    assert.ok(new RegExp(`action="${OPT_OUT}\\?token=[^"]+"`).test(first.body));
  } finally {
    await srv.close();
  }
});

test('POST is the unsubscribe, and a second POST is a success rather than an error', async () => {
  resetWorld();
  const srv = await openRouter();
  try {
    const first = await srv.post(linkFor(7));
    assert.strictEqual(first.status, 200);
    assert.ok(first.body.includes('You are unsubscribed'));
    assert.strictEqual(prefUpdates.length, 1);
    assert.ok(/"weekly": false/.test(prefUpdates[0].sql));
    assert.deepStrictEqual(prefUpdates[0].params, [7]);

    // Idempotent: the UPDATE has no predicate on the old value, so the repeat
    // writes false over false and answers the same page.
    const second = await srv.post(linkFor(7));
    assert.strictEqual(second.status, 200);
    assert.ok(second.body.includes('You are unsubscribed'));
    assert.strictEqual(prefUpdates.length, 2);
  } finally {
    await srv.close();
  }
});

test('a venue that is already unsubscribed sees the plain page, not a button', async () => {
  resetWorld();
  prefsOnRecord = { bookings: true, reviews: true, weekly: false };
  const srv = await openRouter();
  try {
    const res = await srv.get(linkFor(7));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('You are unsubscribed'));
    assert.ok(!/<form/i.test(res.body), 'there is nothing left to turn off');
    assert.deepStrictEqual(prefUpdates, []);
  } finally {
    await srv.close();
  }
});

test('a bad, missing or wrong-purpose token is refused on BOTH verbs, with no write', async () => {
  resetWorld();
  const sessionish = jwt.sign({ userId: 9, vp: 7 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const wrongPurpose = jwt.sign({ vp: 7, purpose: 'password_reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const bad = [
    `${OPT_OUT}?token=garbage`,
    `${OPT_OUT}?token=${encodeURIComponent(sessionish)}`,
    `${OPT_OUT}?token=${encodeURIComponent(wrongPurpose)}`,
    OPT_OUT,
  ];
  const srv = await openRouter();
  try {
    for (const path of bad) {
      const got = await srv.get(path);
      assert.strictEqual(got.status, 400, `GET ${path}`);
      assert.ok(!/<form/i.test(got.body), `GET ${path} must not offer the button`);
      const posted = await srv.post(path);
      assert.strictEqual(posted.status, 400, `POST ${path}`);
      assert.ok(!posted.body.includes('You are unsubscribed'), `POST ${path}`);
    }
    assert.deepStrictEqual(prefUpdates, [], 'a refused link must not write');
    assert.deepStrictEqual(prefReads, [], 'a token that does not verify never reaches the database');
  } finally {
    await srv.close();
  }
});

test('a stale link whose venue_profiles row is gone is refused, not confirmed', async () => {
  resetWorld();
  prefsOnRecord = null;
  const srv = await openRouter();
  try {
    const res = await srv.get(linkFor(7));
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.includes('expired'));
  } finally {
    await srv.close();
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

// ============================================================================
// RFC 8058. List-Unsubscribe alone gets the mail client's own unsubscribe
// affordance shown; the -Post header is what makes it a one-click POST instead
// of a browser trip, which is the pairing that makes a GET that refuses to
// mutate safe to ship AND the deliverability signal Gmail grades on.
// ============================================================================
test('the mailed digest carries the one-click unsubscribe headers, pointing at the signed link', async () => {
  resetWorld();
  process.env.DIGEST_ENABLED = 'true';
  venueRows = [eligibleVenueRow()];
  await digest.runVenueDigestSweep(MONDAY_9AM_ET);
  assert.strictEqual(sentEmails.length, 1);

  const headers = sentEmails[0].headers || {};
  assert.strictEqual(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const listUnsub = headers['List-Unsubscribe'];
  assert.ok(listUnsub, 'a digest without List-Unsubscribe is a digest Gmail grades as spam');
  const inner = /^<(.+)>$/.exec(listUnsub);
  assert.ok(inner, 'List-Unsubscribe must be angle-bracketed per RFC 2369');
  assert.ok(inner[1].startsWith('https://'), inner[1]);
  assert.ok(inner[1].includes('/api/venue-digest/opt-out?token='), inner[1]);

  // The URI the header points at is the same one in the body, so one-click and
  // the visible link cannot drift apart.
  const inBody = sentEmails[0].html.match(/href="([^"]*opt-out[^"]*)"/)[1]
    .replace(/&amp;/g, '&');
  assert.strictEqual(inner[1], inBody);
});

test('a header value carrying a CRLF cannot smuggle a second header into the message', () => {
  const { safeHeaders } = require('../services/emailService');
  const out = safeHeaders({
    'List-Unsubscribe': '<https://api.example.com/x>\r\nBcc: attacker@example.com',
    'Bad Name': 'dropped',
    'X-Object': { nope: true },
  });
  assert.deepStrictEqual(Object.keys(out), ['List-Unsubscribe']);
  assert.ok(!/[\r\n]/.test(out['List-Unsubscribe']));
  assert.strictEqual(out['List-Unsubscribe'], '<https://api.example.com/x> Bcc: attacker@example.com');
  assert.strictEqual(safeHeaders(undefined), null);
});

// ============================================================================
// THE ROUTER HAS TO BE REACHABLE, AND EVERY TEST ABOVE MOUNTS IT ON A BARE APP.
//
// Security round 26 found the whole file dead in the product. server.js mounts
// two routers on the bare `/api` prefix — routes/moderation.js and
// routes/messages.js — and both call `router.use(authenticate)`, so they answer
// EVERY unauthenticated /api/* request 401 before any router registered after
// them runs. `/api/venue-digest` was registered after them.
//
// The measured effect on the live preview stack, before the fix:
//
//   GET  /api/venue-digest/opt-out?token=<valid>   ->  401 {"error":"No token provided"}
//   POST /api/venue-digest/opt-out?token=<valid>   ->  401 {"error":"No token provided"}
//   ... and with an unrelated venue owner's session Bearer attached, the same
//   request rendered the page perfectly. So the one authorisation this router
//   is built around — a signed, purpose-labelled token in the query string,
//   held by a recipient who by construction has no Flock session in the mail
//   client fetching it — was the one thing that could not get in.
//
// That is the confirm page not rendering, RFC 8058 one-click unsubscribe
// failing for Gmail and Apple Mail (the deliverability signal this file's last
// test exists to protect), and the CAN-SPAM path off the list being "sign in to
// the dashboard".
//
// Every test above mounts routes/venueDigest.js on its own express app, which
// is why none of them could see it. This one reads server.js instead, and pins
// the ONE property those tests cannot: the mount is registered before the first
// bare-/api catch-all. Source text is compared by index into the whole file
// rather than by line, so it does not care how this checkout ends its lines
// (core.autocrlf=true; commit 19039ee is the last test that got that wrong).
// ============================================================================
test('server.js mounts /api/venue-digest ahead of the bare /api catch-alls, or the emailed link 401s', () => {
  const src = fs.readFileSync(require.resolve('../server.js'), 'utf8');

  const mount = src.indexOf("app.use('/api/venue-digest'");
  assert.notStrictEqual(mount, -1, 'server.js does not mount routes/venueDigest.js at all');
  assert.strictEqual(
    src.indexOf("app.use('/api/venue-digest'", mount + 1), -1,
    'two mounts for /api/venue-digest — one of them is unreachable'
  );

  // The catch-alls: `app.use('/api', ...)` with nothing after the prefix.
  const catchAll = /app\.use\('\/api',/g;
  const positions = [];
  let m;
  while ((m = catchAll.exec(src)) !== null) positions.push(m.index);
  assert.ok(positions.length >= 1, 'expected at least one bare /api catch-all mount in server.js');

  assert.ok(
    mount < Math.min(...positions),
    'routes/venueDigest.js authenticates with a signed query-string token and NO JWT, so it must be '
    + 'mounted before the bare /api catch-alls. Mounted after them, moderation.js\'s router.use(authenticate) '
    + 'answers every emailed unsubscribe link 401 "No token provided" and the router never runs.'
  );
});
