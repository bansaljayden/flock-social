// Run: node --test  (from backend/)
//
// The other three helpers in backend/utils that a client's ordinary input
// flows through, audited with the same question that turned up the stripHtml
// corruption: does this do something surprising to input that is perfectly
// valid?  (utils/sanitize.js has its own file, sanitizeText.test.js.)
const test = require('node:test');
const assert = require('node:assert');
const { ageFromDob, MIN_AGE } = require('../utils/age');
const { isDisposableEmail } = require('../utils/disposableEmail');
const { sanitizeVenueData, safeVenuePhotoUrl } = require('../utils/venuePayload');

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ===========================================================================
// utils/age.js — the age gate must not depend on where the server runs
// ===========================================================================

function inTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('a date of birth is read as a calendar date, not as a UTC instant', () => {
  // `new Date('2013-06-16')` is UTC midnight and the getters are local, so
  // west of UTC the stored birthday used to land on the 15th and the account
  // turned 13 a day early. Railway runs UTC, which is the only reason this
  // was invisible; a TZ variable is all it takes to move the age gate.
  for (const tz of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    inTimezone(tz, () => {
      assert.strictEqual(ageFromDob('2013-06-16', new Date(2026, 5, 15)), 12, `${tz}: the day before the 13th birthday`);
      assert.strictEqual(ageFromDob('2013-06-16', new Date(2026, 5, 16)), 13, `${tz}: the 13th birthday itself`);
      assert.strictEqual(ageFromDob('2013-06-16', new Date(2026, 5, 17)), 13, `${tz}: the day after`);
    });
  }
});

test('the under-13 boundary is the same in every timezone', () => {
  const results = ['America/Los_Angeles', 'UTC', 'Asia/Tokyo'].map((tz) =>
    inTimezone(tz, () => ageFromDob('2013-06-16', new Date(2026, 5, 15)) >= MIN_AGE));
  assert.deepStrictEqual(results, [false, false, false], 'the same person must be let in, or not, everywhere');
});

test('a full ISO timestamp is accepted and its time part ignored', () => {
  const NOW = new Date(2026, 5, 16);
  assert.strictEqual(ageFromDob('2013-06-16T23:59:59.999Z', NOW), 13);
  assert.strictEqual(ageFromDob('2013-06-16 00:00:00', NOW), 13);
  assert.strictEqual(ageFromDob('  2013-06-16  ', NOW), 13);
});

test('a Date object still works, which is how the existing gate tests call it', () => {
  const NOW = new Date(2026, 5, 16);
  assert.strictEqual(ageFromDob(new Date(2013, 5, 16), NOW), 13);
  assert.strictEqual(ageFromDob(new Date(2013, 5, 17), NOW), 12);
  assert.strictEqual(ageFromDob(new Date('nonsense'), NOW), null);
});

test('a shape that a DATE column would reject is null here, not an age', () => {
  // isISO8601 (the /signup validator) accepts '2000' and '2000-W01-1'. Those
  // used to parse with `new Date`, clear the gate, and then reach pg — which
  // is a 500 on signing up, the exact class routes/auth.js has fixed twice.
  // Every caller treats null as "no usable date of birth" and answers 400/403.
  const NOW = new Date(2026, 5, 16);
  for (const junk of ['2000', '2000-W01-1', '2000-001', '01/01/2000', 'yesterday', 'not-a-date',
    946684800000, ['2000-01-01'], { y: 2000 }, true, null, undefined, '']) {
    assert.strictEqual(ageFromDob(junk, NOW), null, `${JSON.stringify(junk)} must not produce an age`);
  }
});

test('a date that does not exist is refused instead of rolling forward', () => {
  const NOW = new Date(2026, 5, 16);
  assert.strictEqual(ageFromDob('2013-02-30', NOW), null);
  assert.strictEqual(ageFromDob('2013-04-31', NOW), null);
  assert.strictEqual(ageFromDob('2013-13-01', NOW), null);
  assert.strictEqual(ageFromDob('2013-00-10', NOW), null);
  assert.strictEqual(ageFromDob('2013-02-29', NOW), null, '2013 is not a leap year');
  assert.strictEqual(ageFromDob('2012-02-29', NOW), 14, 'but 2012 is');
});

// ===========================================================================
// utils/disposableEmail.js
// ===========================================================================

test('a non-string address is answered, never thrown at', () => {
  // It measured String(email) and then sliced `email` itself. An array reaches
  // Array.prototype.slice and the .toLowerCase() after it is a TypeError —
  // a 500 out of a signup handler instead of true or false. The OAuth paths
  // pass the provider's value straight in.
  for (const v of [['a@mailinator.com'], { a: 1 }, 42, true, null, undefined, '']) {
    assert.strictEqual(typeof isDisposableEmail(v), 'boolean', `threw or returned junk for ${JSON.stringify(v)}`);
  }
  assert.strictEqual(isDisposableEmail(['a@mailinator.com']), true);
});

test('the fully-qualified form of a disposable domain is still disposable', () => {
  assert.strictEqual(isDisposableEmail('a@mailinator.com.'), true, 'a trailing root dot walked past the list');
  assert.strictEqual(isDisposableEmail('a@MAILINATOR.COM'), true);
  assert.strictEqual(isDisposableEmail('a@ mailinator.com '), true);
  assert.strictEqual(isDisposableEmail('a@throwaway.mailinator.com'), true, 'subdomains too');
  assert.strictEqual(isDisposableEmail('a+tag@guerrillamail.com'), true);
});

test('real mailboxes are not blocked', () => {
  for (const email of [
    'jayden@gmail.com', 'a@icloud.com', 'a@outlook.com', 'a@yahoo.co.uk', 'a@hotmail.com',
    'a@privaterelay.appleid.com', // Apple's relay is NOT disposable — blocking it breaks Sign in with Apple
    'student@school.k12.ca.us', 'a@notmailinator.com', 'a@mailinator.company.com', 'a@my-tempmail.com',
    'no-at-sign', 'a@', '@example.com',
  ]) {
    assert.strictEqual(isDisposableEmail(email), false, `blocked a real address: ${email}`);
  }
});

// ===========================================================================
// utils/venuePayload.js
// ===========================================================================

test('venue text that jsonb refuses is cleaned instead of 500ing the send', () => {
  // venue_data is JSONB, which rejects a null byte (22P05) and unpaired surrogates.
  // Both used to travel from the client, through here, to pg as an error on
  // sending a message rather than as a bad venue card.
  const { data } = sanitizeVenueData({ name: `Bar${NUL}None`, addr: `12${NUL} Main St` });
  assert.strictEqual(data.name, 'BarNone');
  assert.strictEqual(data.addr, '12 Main St');
  assert.ok(!JSON.stringify(data).includes(NUL));

  const torn = sanitizeVenueData({ name: `Bar\uD83D None` }).data.name;
  assert.ok(!LONE_SURROGATE.test(torn), 'a lone surrogate survived');
});

test('an emoji sitting exactly on the length clamp is not cut in half', () => {
  const name = 'a'.repeat(255) + '\u{1F600}';
  const out = sanitizeVenueData({ name }).data.name;
  assert.ok(!LONE_SURROGATE.test(out), `the clamp tore an emoji: ${JSON.stringify(out.slice(-4))}`);
  assert.ok(out.length <= 256);
  // A whole emoji inside the limit is left alone.
  assert.strictEqual(sanitizeVenueData({ name: 'Cafe \u{1F600} Bar' }).data.name, 'Cafe \u{1F600} Bar');
});

test('the fields the venue card actually renders survive the sanitizer', () => {
  // category, crowd and the lat/lng spelling the flock-create card sends were
  // all dropped, so a card looked right on the sender's screen (local copy)
  // and came back uncoloured, crowd-less and unpinnable for everybody else.
  const { ok, data } = sanitizeVenueData({
    name: 'The Rooftop', addr: '12 Main St', place_id: 'abc',
    category: 'Nightlife', crowd: 55, type: 'Bar',
    rating: 4.4, price_level: 2, lat: 40.7128, lng: -74.006,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(data.category, 'Nightlife');
  assert.strictEqual(data.crowd, 55);
  assert.strictEqual(data.latitude, 40.7128);
  assert.strictEqual(data.longitude, -74.006);
  assert.strictEqual(data.rating, 4.4);
  // The canonical spellings still win when both are present.
  const both = sanitizeVenueData({ latitude: 1, lat: 2, longitude: 3, lng: 4 }).data;
  assert.deepStrictEqual([both.latitude, both.longitude], [1, 3]);
  const nested = sanitizeVenueData({ location: { latitude: 5, longitude: 6 } }).data;
  assert.deepStrictEqual([nested.latitude, nested.longitude], [5, 6]);
});

test('numbers outside the range they mean are dropped, not printed', () => {
  const { data } = sanitizeVenueData({
    name: 'Bar', rating: 1e308, price_level: 99, crowd: 5000,
    latitude: 900, longitude: -900, user_ratings_total: -5,
  });
  assert.deepStrictEqual(
    [data.rating, data.price_level, data.crowd, data.latitude, data.longitude, data.user_ratings_total],
    [null, null, null, null, null, null]
  );
  // Legitimate extremes still pass.
  const edge = sanitizeVenueData({ rating: 5, price_level: 0, crowd: 100, latitude: -90, longitude: 180 }).data;
  assert.deepStrictEqual([edge.rating, edge.price_level, edge.crowd, edge.latitude, edge.longitude], [5, 0, 100, -90, 180]);
});

test('category is screened like the other displayed text', () => {
  // It renders as the card subtitle whenever `type` is absent, so it is UGC
  // on the same terms as the name.
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', category: 'Food' }).ok, true);
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', category: 'fucking bullshit' }).ok, false);
});

test('photo_url still only ever points at our own proxy', () => {
  assert.strictEqual(safeVenuePhotoUrl('/api/venues/photo?ref=abc&maxwidth=400'), '/api/venues/photo?ref=abc&maxwidth=400');
  assert.strictEqual(
    safeVenuePhotoUrl('https://api.flockcorp.com/api/venues/photo?ref=abc&maxwidth=400'),
    '/api/venues/photo?ref=abc&maxwidth=400',
    'an absolute url is re-anchored at our host, not trusted'
  );
  for (const bad of [
    'https://evil.example/pixel.gif',
    'http://evil.example/api/venues/photos?ref=x',
    '/api/venues/photo?ref=<script>',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//evil.example/api/venues/photo?ref=x/../../',
    null, 42, {},
  ]) {
    const out = safeVenuePhotoUrl(bad);
    assert.ok(out === null || out.startsWith('/api/venues/photo?'), `let through ${JSON.stringify(bad)} -> ${out}`);
  }
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', photo_url: 'https://evil.example/pixel.gif' }).data.photo_url, null);
});

test('a payload that is not an object is not a venue', () => {
  for (const raw of [null, undefined, 'Bar', 42, ['Bar']]) {
    assert.deepStrictEqual(sanitizeVenueData(raw), { ok: true, data: null }, `${JSON.stringify(raw)}`);
  }
});
