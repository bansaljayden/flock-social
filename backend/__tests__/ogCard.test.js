'use strict';
// ---------------------------------------------------------------------------
// THE INVITE SHARE CARD IS DRAWN HERE (routes/ogCard.js)
//
//   * it is the website's card: the same code as frontend/api/_og-card.js, and
//     the same PNG bytes the library draws for the website;
//   * a signed URL draws a 1200x630 PNG that any cache may keep for a year;
//   * an unsigned, tampered or malformed URL is a 403 that never reaches the
//     renderer, and so is every card while OG_CARD_SECRET is unset or short;
//   * memory: the renderer and its font load once, the font's list is shared
//     only for text the font draws by itself, one card is drawn at a time per
//     kind with a short line behind it, and recently drawn cards are kept;
//   * the card shows nothing the invite preview page does not already publish.
//
// The secret is generated per run. No test here reaches the network: the one
// that would (an emoji card) runs with fetch replaced and expects the refusal.
// Every wait is bounded, so a regression fails its test instead of hanging the
// file: requests time out, the server drops its connections, and a test that
// fails with renders held lets them go before the next one starts.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const ogRoutes = require('../routes/ogCard');

const og = ogRoutes.__testables;
const FRONTEND_API = path.join(__dirname, '..', '..', 'frontend', 'api');
const websiteCard = require(path.join(FRONTEND_API, '_og-card.js'));
const preview = require(path.join(FRONTEND_API, 'invite-preview.js'));

const SECRET = crypto.randomBytes(32).toString('base64url');
process.env.OG_CARD_SECRET = SECRET;

const BASIC = { n: 'Friday Tacos', w: 'Fri, Oct 9 at 9:00 PM EDT', g: '4' };
const FIXED_COPY = ['FLOCK', "You're invited. Vote on where it lands.", 'No app needed'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// What Intl puts between a time and AM/PM on current ICU, and so what the
// preview's when label can carry.
const NARROW_NBSP = String.fromCharCode(0x202f);
// A made-up invite token in the real shape (24 alphanumerics), built at run
// time so no literal in this file reads as a credential to the secret scanner.
const inviteToken = () => crypto.randomBytes(12).toString('hex');

// The contract, written out independently of the route: HMAC-SHA256 over
// "n\nw\ng", base64url, the first 22 characters.
function sign(n, w, g, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(n + '\n' + w + '\n' + g).digest('base64url').slice(0, 22);
}

function cardPath(fields, extra = {}) {
  const s = sign(fields.n, fields.w, fields.g);
  return '/api/og/invite?' + new URLSearchParams({ n: fields.n, w: fields.w, g: fields.g, s, ...extra });
}

async function withServer(fn) {
  const app = express();
  app.use('/api/og', ogRoutes);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Every request is handled from the moment it starts and settled by
// cleanup(), so one a failed test leaves behind cannot surface later as an
// unhandled rejection inside some other test.
const inFlight = new Set();

function get(base, urlPath, ms = 10000) {
  const request = (async () => {
    const res = await fetch(base + urlPath, { signal: AbortSignal.timeout(ms) });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  })();
  inFlight.add(request);
  request.catch(() => {}).finally(() => inFlight.delete(request));
  return request;
}

function assertCardPng(body) {
  assert.ok(body.subarray(0, 8).equals(PNG_SIGNATURE), 'the body is not a PNG');
  assert.strictEqual(body.toString('latin1', 12, 16), 'IHDR');
  assert.strictEqual(body.readUInt32BE(16), 1200, 'the card is not 1200 wide');
  assert.strictEqual(body.readUInt32BE(20), 630, 'the card is not 630 high');
  assert.ok(body.length > 5 * 1024 && body.length < 200 * 1024, `${body.length} bytes is not the size of a card`);
}

// What the library draws for the website: its own default font list and the
// website's own tree. The card here has to be these exact bytes.
async function websitePng(fields) {
  const { ImageResponse } = await import('@vercel/og');
  const params = websiteCard.cardParams(fields);
  const response = new ImageResponse(websiteCard.cardTree(params), { width: websiteCard.CARD_W, height: websiteCard.CARD_H });
  return Buffer.from(await response.arrayBuffer());
}

// Every string the tree puts on the card.
function textsOf(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => textsOf(child, out));
  else if (node && node.props) textsOf(node.props.children, out);
  return out;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

async function until(predicate, what) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

// A renderer the test holds: a draw waits until the test lets it go, unless
// `holds` says otherwise for that card.
function heldRenderer(holds = () => true) {
  const r = { calls: [], held: [], running: 0, most: 0, holding: true };
  r.draw = async (params, shared) => {
    r.calls.push({ name: params.name, shared });
    r.running += 1;
    r.most = Math.max(r.most, r.running);
    try {
      if (r.holding && holds(params, shared)) await new Promise((resolve) => r.held.push(resolve));
    } finally {
      r.running -= 1;
    }
    return Buffer.from('a drawn card: ' + params.name);
  };
  // Lets held draws go, one at a time as they arrive, until `done`.
  r.drain = (done) => until(() => {
    if (r.held.length) r.held.shift()();
    return done();
  }, 'the line to drain');
  // Stops holding and lets everything go.
  r.letGo = () => {
    r.holding = false;
    while (r.held.length) r.held.shift()();
  };
  return r;
}

function isIdle() {
  const { shared, fallback } = og.lineState();
  return shared.running + shared.waiting + fallback.running + fallback.waiting === 0;
}

function assertIdle() {
  const { shared, fallback } = og.lineState();
  assert.deepStrictEqual({ shared, fallback },
    { shared: { running: 0, waiting: 0 }, fallback: { running: 0, waiting: 0 } },
    'a render line was left occupied');
}

// After every test, passed or failed: let held draws go, settle its requests,
// give the lines a moment to empty, then the real renderer and an empty
// memory. A line that stays occupied fails the next test's assertIdle, which
// is where it belongs.
async function cleanup(r) {
  if (r) r.letGo();
  await Promise.allSettled([...inFlight]);
  const deadline = Date.now() + 2000;
  while (!isIdle() && Date.now() < deadline) await tick();
  og.setDrawForTests(null);
  og.forgetCardsForTests();
}

// ── 1. The website's card ───────────────────────────────────────────────────

test('the card here is the website card: the same code and the same output', () => {
  const source = (fn) => fn.toString().replace(/\r\n/g, '\n');
  for (const name of ['cleanText', 'cardParams', 'cardTree']) {
    assert.strictEqual(source(og[name]), source(websiteCard[name]),
      `${name} in routes/ogCard.js has drifted from frontend/api/_og-card.js; copy it across again`);
  }
  assert.strictEqual(og.CARD_W, websiteCard.CARD_W);
  assert.strictEqual(og.CARD_H, websiteCard.CARD_H);

  const bell = String.fromCharCode(7);
  const corpus = [
    {},
    BASIC,
    { n: 'x'.repeat(400), w: 'y'.repeat(100), g: '2000' },
    { n: `Taco${bell} Night\nwith\ttabs`, w: '  Fri  ', g: '-3' },
    { n: 'Birthday dinner 🎉', w: `Sat, Oct 10 at 8:30${NARROW_NBSP}PM EDT`, g: '1' },
    { n: ['an', 'array'], w: { an: 'object' }, g: ['5'] },
    { n: '', w: '', g: 'abc' },
    { g: '0' }, { g: '12abc' }, { g: '999' }, { g: '1000' },
  ];
  for (const q of corpus) {
    assert.deepStrictEqual(og.cardParams(q), websiteCard.cardParams(q), JSON.stringify(q));
    const params = websiteCard.cardParams(q);
    assert.deepStrictEqual(og.cardTree(params), websiteCard.cardTree(params), JSON.stringify(q));
  }
});

test('a signed URL draws the website card as a PNG any cache may keep for a year', async () => {
  await cleanup();
  try {
    await withServer(async (base) => {
      const res = await get(base, cardPath(BASIC));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'image/png');
      assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assertCardPng(res.body);
      assert.ok(res.body.equals(await websitePng(BASIC)),
        'the card differs from the one the library draws for the website');
    });
  } finally {
    await cleanup();
  }
});

// ── 2. Only signed cards ────────────────────────────────────────────────────

test('an unsigned, tampered or malformed card is a 403 that never reaches the renderer', async () => {
  await cleanup();
  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  const { n, w, g } = BASIC;
  const good = sign(n, w, g);
  const q = (fields) => '/api/og/invite?' + new URLSearchParams(fields);
  const en = encodeURIComponent;
  const refused = [
    ['no signature', q({ n, w, g })],
    ['an empty signature', q({ n, w, g, s: '' })],
    ['the going count changed', q({ n, w, g: '5', s: good })],
    ['the name changed', q({ n: 'Friday Tacos!', w, g, s: good })],
    ['the time changed', q({ n, w: 'Sat, Oct 10 at 9:00 PM EDT', g, s: good })],
    ['signed with another secret', q({ n, w, g, s: sign(n, w, g, crypto.randomBytes(32).toString('base64url')) })],
    ['one character short', q({ n, w, g, s: good.slice(1) })],
    ['one character long', q({ n, w, g, s: good + 'A' })],
    ['22 characters outside base64url', q({ n, w, g, s: '!'.repeat(22) })],
    ['22 bytes of multibyte text', q({ n, w, g, s: 'ü'.repeat(11) })],
    ['a repeated name', `/api/og/invite?n=${en(n)}&n=x&w=${en(w)}&g=${g}&s=${good}`],
    ['a repeated signature', `/api/og/invite?n=${en(n)}&w=${en(w)}&g=${g}&s=${good}&s=${good}`],
    ['a bracketed name', `/api/og/invite?n[0]=${en(n)}&w=${en(w)}&g=${g}&s=${good}`],
  ];
  try {
    await withServer(async (base) => {
      for (const [why, urlPath] of refused) {
        const res = await get(base, urlPath);
        assert.strictEqual(res.status, 403, why);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store', `${why}: a refusal must not be cached`);
        assert.match(res.headers.get('content-type'), /^application\/json/, why);
        assert.deepStrictEqual(JSON.parse(res.body.toString()), { error: 'This card is not signed.' }, why);
      }
      // The control: the same server draws the untouched card.
      assert.strictEqual((await get(base, cardPath(BASIC))).status, 200);
    });
    assert.strictEqual(r.calls.length, 1, 'a refused card reached the renderer');
    assertIdle();
  } finally {
    await cleanup(r);
  }
});

test('every card is refused while OG_CARD_SECRET is unset or shorter than 16 characters', async () => {
  await cleanup();
  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  const { n, w, g } = BASIC;
  const saved = process.env.OG_CARD_SECRET;
  try {
    await withServer(async (base) => {
      for (const value of [undefined, '', '   ', 'fifteen-chars-x', ' fifteen-chars-x\n', ' '.repeat(20)]) {
        if (value === undefined) delete process.env.OG_CARD_SECRET;
        else process.env.OG_CARD_SECRET = value;
        const label = value === undefined ? 'unset' : JSON.stringify(value);
        // Signed with that very value, the strongest case for drawing it.
        const own = '/api/og/invite?' + new URLSearchParams({ n, w, g, s: sign(n, w, g, (value || '').trim()) });
        for (const urlPath of [own, cardPath(BASIC)]) {
          const res = await get(base, urlPath);
          assert.strictEqual(res.status, 403, `secret ${label}`);
          assert.strictEqual(res.headers.get('cache-control'), 'no-store');
        }
      }
      // Trimmed the way the website trims it: a pasted trailing newline signs
      // the same cards.
      process.env.OG_CARD_SECRET = `  ${SECRET}\n`;
      assert.strictEqual((await get(base, cardPath(BASIC))).status, 200);
    });
    assert.strictEqual(r.calls.length, 1, 'a card was drawn without a usable secret');
  } finally {
    process.env.OG_CARD_SECRET = saved;
    await cleanup(r);
  }
});

// ── 3. Memory: the line, the font, the cache ────────────────────────────────

test('one card is drawn at a time, a short line waits, and past it the answer is a 503 at once', async () => {
  await cleanup();
  const r = heldRenderer();
  og.setDrawForTests(r.draw);
  const overflow = 3;
  const total = 1 + og.MAX_WAITING + overflow;
  try {
    await withServer(async (base) => {
      const done = [];
      const pending = Array.from({ length: total }, (_, i) =>
        get(base, cardPath({ n: `Card ${i}`, w: BASIC.w, g: '2' })).then((res) => { done.push(res); return res; }));

      await until(() => done.length === overflow, 'the overflow to be refused');
      assert.deepStrictEqual(og.lineState().shared, { running: 1, waiting: og.MAX_WAITING });
      for (const res of done) {
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.headers.get('retry-after'), '5');
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
      }

      await r.drain(() => done.length === total);
      const results = await Promise.all(pending);
      assert.strictEqual(results.filter((res) => res.status === 200).length, 1 + og.MAX_WAITING);
      assert.strictEqual(results.filter((res) => res.status === 503).length, overflow);
    });
    assert.strictEqual(r.most, 1, `${r.most} cards were drawn at once`);
    assert.strictEqual(r.calls.length, 1 + og.MAX_WAITING);
    assertIdle();
  } finally {
    await cleanup(r);
  }
});

test('a stalled emoji card holds up other emoji cards, never the cards the font draws itself', async () => {
  await cleanup();
  const r = heldRenderer((params, shared) => !shared);
  og.setDrawForTests(r.draw);
  try {
    await withServer(async (base) => {
      const first = get(base, cardPath({ n: 'Taco night 🌮', w: BASIC.w, g: '3' }));
      await until(() => r.held.length === 1, 'the emoji card to start drawing');
      const second = get(base, cardPath({ n: 'Pizza night 🍕', w: BASIC.w, g: '3' }));
      await until(() => og.lineState().fallback.waiting === 1, 'the second emoji card to queue');

      // A stalled download does not touch the other line: this one is drawn
      // straight away, so it gets three seconds rather than the default ten.
      assert.strictEqual((await get(base, cardPath(BASIC), 3000)).status, 200);
      assert.deepStrictEqual(og.lineState().fallback, { running: 1, waiting: 1 });

      r.held.shift()();
      assert.strictEqual((await first).status, 200);
      await until(() => r.held.length === 1, 'the second emoji card to start');
      r.held.shift()();
      assert.strictEqual((await second).status, 200);
    });
    assert.deepStrictEqual(r.calls.map((c) => c.shared), [false, true, false]);
    assert.strictEqual(r.most, 2, 'the two lines should have run side by side');
    assertIdle();
  } finally {
    await cleanup(r);
  }
});

test('a failed render answers 503, frees its turn, and is not kept', async () => {
  await cleanup();
  let draws = 0;
  og.setDrawForTests(async (params) => {
    draws += 1;
    if (draws === 1) throw new TypeError('fetch failed for Friday Tacos');
    return Buffer.from('a drawn card: ' + params.name);
  });
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await withServer(async (base) => {
      const failed = await get(base, cardPath(BASIC));
      assert.strictEqual(failed.status, 503);
      assert.strictEqual(failed.headers.get('cache-control'), 'no-store');
      assert.deepStrictEqual(JSON.parse(failed.body.toString()), { error: 'The card could not be drawn.' });
      assertIdle();
      assert.strictEqual(og.lineState().cards, 0, 'a failed card was kept');
      assert.strictEqual((await get(base, cardPath(BASIC))).status, 200);
    });
    assert.strictEqual(draws, 2);
    // The log names the error and carries none of the card's text.
    assert.deepStrictEqual(logged, ['[og-card] could not draw a card: TypeError']);
  } finally {
    console.error = realError;
    await cleanup();
  }
});

test('a card is drawn once: a repeat, and a copy queued behind it, come from memory', async () => {
  await cleanup();
  const r = heldRenderer();
  og.setDrawForTests(r.draw);
  const OTHER = { n: 'Saturday Brunch', w: BASIC.w, g: '6' };
  try {
    await withServer(async (base) => {
      const a1 = get(base, cardPath(BASIC));
      await until(() => r.held.length === 1, 'the first draw');
      const a2 = get(base, cardPath(BASIC));
      const b = get(base, cardPath(OTHER));
      await until(() => og.lineState().shared.waiting === 2, 'both to queue');
      await r.drain(() => r.calls.length >= 2 && isIdle());
      const [x, y, z] = await Promise.all([a1, a2, b]);
      assert.deepStrictEqual([x.status, y.status, z.status], [200, 200, 200]);
      assert.ok(x.body.equals(y.body));
      const again = await get(base, cardPath(BASIC));
      assert.strictEqual(again.status, 200);
      assert.ok(again.body.equals(x.body));
    });
    assert.deepStrictEqual(r.calls.map((c) => c.name), ['Friday Tacos', 'Saturday Brunch']);
    assertIdle();
  } finally {
    await cleanup(r);
  }
});

test('a card already drawn is served at once, even while the line is full', async () => {
  // A replayed real card must not queue behind new ones, or a full line would
  // turn every repeat into a 503 and every preview into the static banner.
  await cleanup();
  const r = heldRenderer((params) => params.name !== BASIC.n);
  og.setDrawForTests(r.draw);
  try {
    await withServer(async (base) => {
      assert.strictEqual((await get(base, cardPath(BASIC))).status, 200);
      const pending = Array.from({ length: 1 + og.MAX_WAITING }, (_, i) =>
        get(base, cardPath({ n: `Card ${i}`, w: BASIC.w, g: '2' })));
      await until(() => og.lineState().shared.waiting === og.MAX_WAITING, 'the line to fill');
      const repeat = await get(base, cardPath(BASIC), 3000);
      assert.strictEqual(repeat.status, 200);
      assert.strictEqual(r.calls.filter((c) => c.name === BASIC.n).length, 1);
      await r.drain(() => isIdle());
      assert.ok((await Promise.all(pending)).every((res) => res.status === 200));
    });
  } finally {
    await cleanup(r);
  }
});

test('only the last CACHE_MAX cards are kept, and the oldest goes first', async () => {
  await cleanup();
  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  const card = (i) => ({ n: `Card ${i}`, w: BASIC.w, g: '2' });
  try {
    await withServer(async (base) => {
      for (let i = 0; i <= og.CACHE_MAX; i++) assert.strictEqual((await get(base, cardPath(card(i)))).status, 200);
      assert.strictEqual(og.lineState().cards, og.CACHE_MAX);
      assert.strictEqual(r.calls.length, og.CACHE_MAX + 1);
      await get(base, cardPath(card(og.CACHE_MAX)));
      assert.strictEqual(r.calls.length, og.CACHE_MAX + 1, 'the newest card was drawn again');
      await get(base, cardPath(card(0)));
      assert.strictEqual(r.calls.length, og.CACHE_MAX + 2, 'the oldest card was still kept');
      assert.strictEqual(og.lineState().cards, og.CACHE_MAX);
    });
  } finally {
    await cleanup(r);
  }
});

test('the renderer and its font load once, and the font list is the library\'s own', async () => {
  const first = await og.loadRenderer();
  const again = await og.loadRenderer();
  assert.strictEqual(first, again, 'the renderer was loaded twice');
  assert.strictEqual(first.sharedFonts, again.sharedFonts);
  assert.strictEqual(first.sharedFonts.length, 1);
  const [font] = first.sharedFonts;
  assert.deepStrictEqual({ ...font, data: undefined }, { name: 'sans serif', data: undefined, weight: 700, style: 'normal' });
  assert.strictEqual(font.data, first.fontData);
  assert.strictEqual(font.data.readUInt32BE(0), 0x00010000, 'the shared font is not a TrueType file');
});

test('text the bundled font draws by itself never sends the library for a fallback font', async () => {
  // Every character the shared list is allowed to draw, rendered for real with
  // the network replaced. A single fetch would mean satori asked for a
  // fallback font, which it would then keep on the shared list for good.
  const allowed = [];
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ch = String.fromCharCode(code);
    if (og.usesSharedFont({ name: ch, when: '' })) allowed.push(ch);
  }
  assert.ok(allowed.length >= 190 && allowed.length < 260, `${allowed.length} characters on the shared list`);
  assert.ok(!og.usesSharedFont(og.cardParams({ n: 'Taco night 🌮' })), 'an emoji went to the shared list');
  assert.ok(!og.usesSharedFont(og.cardParams({ n: '東京の夜' })), 'Japanese went to the shared list');
  assert.ok(!og.usesSharedFont(og.cardParams({ n: 'Phở night' })), 'Vietnamese went to the shared list');
  assert.ok(og.usesSharedFont(og.cardParams({ n: 'Our café “night” – 9 • 10…', w: BASIC.w })));

  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    throw new TypeError('no network in this test');
  };
  try {
    for (let i = 0; i < allowed.length; i += 55) {
      const params = og.cardParams({ n: allowed.slice(i, i + 55).join(''), w: BASIC.w, g: '3' });
      assert.ok(og.usesSharedFont(params));
      assertCardPng(await og.drawPng(params, true));
    }
    assert.deepStrictEqual(fetched, [], 'satori asked for a fallback font for text the bundled font covers');

    // The other kind goes to the network, which is why it gets its own list.
    const emoji = og.cardParams({ n: 'Taco night 🌮', w: BASIC.w, g: '3' });
    await assert.rejects(og.drawPng(emoji, false));
    assert.ok(fetched.length > 0, 'an emoji card drew without asking for the emoji');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── 4. Nothing the preview does not already publish ─────────────────────────

test('the card shows nothing the invite preview page does not already publish', async () => {
  await cleanup();
  const token = inviteToken();
  const payload = {
    flock: {
      name: 'Friday Tacos',
      when: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      chosenVenue: 'Taqueria Sol',
      status: 'planning',
    },
    host: 'The host',
    going: 4,
    venues: [],
  };
  const copy = preview.describe(payload);
  const html = preview.renderPage({ title: copy.title, description: copy.description, card: copy.card, token });
  const ogImage = /<meta property="og:image" content="([^"]+)">/.exec(html)[1].replace(/&amp;/g, '&');
  const url = new URL(ogImage);
  assert.strictEqual(url.pathname, '/api/invite-og');
  assert.deepStrictEqual([...url.searchParams.keys()].filter((k) => k !== 's').sort(), ['g', 'n', 'w'],
    'the card URL carries something besides the three card fields');
  assert.ok(!ogImage.includes(token), 'the invite token is in the card URL');

  const fields = { n: url.searchParams.get('n'), w: url.searchParams.get('w'), g: url.searchParams.get('g') };
  // Once the preview signs (OG_CARD_SECRET set on the website), its signature
  // has to be the one this route accepts; a preview that does not sign yet is
  // signed here, by the contract above.
  const s = url.searchParams.get('s') || sign(fields.n, fields.w, fields.g);
  try {
    await withServer(async (base) => {
      const res = await get(base, '/api/og/invite?' + new URLSearchParams({ ...fields, s }));
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.equals(await websitePng(fields)));
    });
  } finally {
    await cleanup();
  }

  // Every word on the card is fixed copy, or already on the preview page.
  const drawn = textsOf(og.cardTree(og.cardParams(fields)));
  assert.deepStrictEqual(drawn.filter((t) => FIXED_COPY.includes(t)), FIXED_COPY);
  for (const t of drawn.filter((x) => !FIXED_COPY.includes(x))) {
    for (const part of t.split(' · ')) {
      assert.ok(html.includes(preview.esc(part)), `the card shows "${part}", which the preview page does not`);
    }
  }
  // And it draws only its three fields: not the host, the venue or the token,
  // although the preview page names the first two.
  for (const other of ['The host', 'Taqueria Sol', token]) {
    assert.ok(!drawn.some((t) => t.includes(other)), `the card shows "${other}"`);
  }
});

test('a parameter beyond n, w, g and s changes nothing on the card', async () => {
  await cleanup();
  try {
    await withServer(async (base) => {
      const plain = await get(base, cardPath(BASIC));
      og.forgetCardsForTests(); // drawn again from scratch, not served from memory
      const padded = await get(base, cardPath(BASIC, {
        token: inviteToken(), host: 'The host', venue: 'Taqueria Sol', status: 'planning',
      }));
      assert.strictEqual(plain.status, 200);
      assert.strictEqual(padded.status, 200);
      assert.ok(padded.body.equals(plain.body), 'an extra parameter reached the card');
    });
  } finally {
    await cleanup();
  }
});
