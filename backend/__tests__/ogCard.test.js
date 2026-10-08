'use strict';
// ---------------------------------------------------------------------------
// THE INVITE SHARE CARD IS DRAWN HERE (routes/ogCard.js)
//
//   * it is the website's card: the same code as frontend/api/_og-card.js, and
//     the same PNG bytes the library draws for the website, emoji and other
//     scripts included, given the same downloads;
//   * a signed URL draws a 1200x630 PNG; one the bundled font draws alone may
//     be kept for a year, one drawn with downloads for an hour;
//   * an unsigned, tampered or malformed URL is a 403 that never reaches the
//     renderer, and so is every card while OG_CARD_SECRET is unset or shorter
//     than 32 characters, which production names in its deploy log;
//   * memory: the renderer and its font load once, the font's list is shared
//     only for text the font draws by itself, one card is drawn at a time per
//     kind with a short line behind it, a card being drawn is drawn once for
//     everybody asking, recently drawn cards are kept, and the fallback loader
//     keeps nothing that grows with card text;
//   * a download that fails, refuses or stalls is a 503 that keeps nothing,
//     the deadline frees the line, and no log line carries card text;
//   * server.js mounts it where a request without a session reaches it;
//   * the card shows nothing the invite preview page does not already publish.
//
// The secret is generated per run. No test here reaches the network: every
// download goes to a stand-in for the three hosts, and where the library
// itself is drawn for comparison, global fetch is replaced for that draw and
// hands data: URLs straight through (the library's own layout engine loads
// through one on its first render). Every wait is bounded, so a regression
// fails its test instead of hanging the file: requests time out, the server
// drops its connections, and a test that fails with renders held lets them go
// before the next one starts. Each test sets up what it needs, so any one of
// them passes run alone.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const ogRoutes = require('../routes/ogCard');

const og = ogRoutes.__testables;
const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'frontend');
const FRONTEND_API = path.join(FRONTEND, 'api');
const websiteCard = require(path.join(FRONTEND_API, '_og-card.js'));
const preview = require(path.join(FRONTEND_API, 'invite-preview.js'));
const OG_DIST = path.join(path.dirname(require.resolve('@vercel/og/package.json')), 'dist');
const LIBRARY_FONT = fs.readFileSync(path.join(OG_DIST, 'noto-sans-v27-latin-regular.ttf'));

const SECRET = crypto.randomBytes(32).toString('base64url');
process.env.OG_CARD_SECRET = SECRET;

const BASIC = { n: 'Friday Tacos', w: 'Fri, Oct 9 at 9:00 PM EDT', g: '4' };
const EMOJI = { n: 'Birthday dinner 🎉', w: 'Sat, Oct 10 at 8:30 PM EDT', g: '6' };
const KANJI = { n: '東京の夜', w: BASIC.w, g: '3' };
// Two emoji whose Twemoji names turn on the emoji presentation selector
// (U+FE0F), built from code points so nothing invisible sits in this file: a
// heart, named without the selector, and a rainbow flag, a zero-width-joiner
// sequence and so named with it.
const HEART = String.fromCodePoint(0x2764, 0xfe0f);
const RAINBOW_FLAG = String.fromCodePoint(0x1f3f3, 0xfe0f, 0x200d, 0x1f308);
const SELECTORS = { n: `Movie night ${HEART} ${RAINBOW_FLAG}`, w: BASIC.w, g: '2' };
const FIXED_COPY = ['FLOCK', "You're invited. Vote on where it lands.", 'No app needed'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const YEAR = 'public, max-age=31536000, immutable';
const HOUR = 'public, max-age=3600';
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

// The local e2e stack (tools/e2e) holds these ports for its web app, API and
// Postgres; an ephemeral port that lands on one is drawn again.
const E2E_PORTS = new Set([3199, 5199, 59610]);

async function serve(app, fn) {
  const server = http.createServer(app);
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    if (!E2E_PORTS.has(server.address().port)) break;
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function withServer(fn) {
  const app = express();
  app.use('/api/og', ogRoutes);
  return serve(app, fn);
}

// The same, counting the requests that have reached the route. The handler
// runs synchronously up to the point where it waits on a render, so once the
// count is reached and a tick has passed, every one of them is waiting.
function withCountingServer(fn) {
  let arrived = 0;
  const app = express();
  app.use('/api/og', (req, res, next) => { arrived += 1; next(); }, ogRoutes);
  return serve(app, (base) => fn(base, () => arrived));
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

function assertRefused(res, status, error, why) {
  assert.strictEqual(res.status, status, why);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store', `${why}: a refusal must not be cached`);
  assert.match(res.headers.get('content-type'), /^application\/json/, why);
  assert.deepStrictEqual(JSON.parse(res.body.toString()), { error }, why);
}

// Global fetch replaced for the length of fn, with data: URLs handed through.
async function withGlobalFetch(stub, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith('data:') ? realFetch(url, init) : stub(url, init));
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// What the library draws for the website: its own default font list, its own
// loader and the website's own tree. The card here has to be these exact bytes.
async function websitePng(fields) {
  const { ImageResponse } = await import('@vercel/og');
  const params = websiteCard.cardParams(fields);
  const response = new ImageResponse(websiteCard.cardTree(params), { width: websiteCard.CARD_W, height: websiteCard.CARD_H });
  return Buffer.from(await response.arrayBuffer());
}

// ── A stand-in for the three hosts ──────────────────────────────────────────
// It answers the requests the loader makes the way the real hosts answer them:
// a ranges stylesheet listing unicode-range lines per family, a font
// stylesheet linking a TrueType file on fonts.gstatic.com, the file itself (the
// library's own font, standing in for a Google subset) and a Twemoji SVG.
// `twist(url, init)` may answer first: a Response, a throw, or undefined for
// the ordinary answer.
const EMOJI_PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#f4900c"/><path d="M10 20h16v3H10z" fill="#292f33"/></svg>';
const EVERY_RANGE = 'U+0000-024F, U+0370-03FF, U+0400-04FF, U+0600-06FF, U+1E00-1EFF, U+2000-2BFF, U+3000-30FF, U+4E00-9FFF';

function standInAnswer(url) {
  if (url.startsWith('https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/')) return new Response(EMOJI_PICTURE);
  if (url.startsWith('https://fonts.googleapis.com/css2?') && url.endsWith('display=swap')) {
    const families = new URL(url).searchParams.getAll('family');
    return new Response(families.map((f) => `@font-face {\n  font-family: '${f}';\n  font-style: normal;\n  font-weight: 400;\n`
      + `  src: url(https://fonts.gstatic.com/s/stand-in.woff2) format('woff2');\n  unicode-range: ${EVERY_RANGE};\n}\n`).join(''));
  }
  if (url.startsWith('https://fonts.googleapis.com/css2?')) {
    const family = new URL(url).searchParams.get('family');
    return new Response(`@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 400;\n`
      + `  src: url(https://fonts.gstatic.com/l/font?kit=stand-in) format('truetype');\n}\n`);
  }
  if (url.startsWith('https://fonts.gstatic.com/')) return new Response(LIBRARY_FONT);
  return new Response('not here', { status: 404 });
}

function standIn(twist = () => undefined) {
  const web = { calls: [] };
  web.fetch = async (url, init) => {
    const u = String(url);
    web.calls.push({ url: u, init: init || {} });
    const twisted = await twist(u, init || {});
    return twisted === undefined ? standInAnswer(u) : twisted;
  };
  web.count = (prefix) => web.calls.filter((c) => c.url.startsWith(prefix)).length;
  return web;
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
// `holds` says otherwise for that card. Its "PNG" names all three fields, so
// two cards that differ in any one of them never look alike.
function heldRenderer(holds = () => true) {
  const r = { calls: [], held: [], running: 0, most: 0, holding: true };
  r.draw = async (params, shared, signal) => {
    r.calls.push({ name: params.name, when: params.when, going: params.going, shared, signal });
    r.running += 1;
    r.most = Math.max(r.most, r.running);
    try {
      if (r.holding && holds(params, shared)) await new Promise((resolve) => r.held.push(resolve));
    } finally {
      r.running -= 1;
    }
    return Buffer.from(`a drawn card: ${params.name} | ${params.when} | ${params.going}`);
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
  const { shared, fallback, rendering } = og.lineState();
  return shared.running + shared.waiting + fallback.running + fallback.waiting + rendering === 0;
}

function assertIdle() {
  const { shared, fallback, rendering } = og.lineState();
  assert.deepStrictEqual({ shared, fallback, rendering },
    { shared: { running: 0, waiting: 0 }, fallback: { running: 0, waiting: 0 }, rendering: 0 },
    'a render line or a render in progress was left behind');
}

// console.error, captured for one test and put back after it.
function captureErrors() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore() { console.error = original; } };
}

// Before and after every test, passed or failed: let held draws go, settle
// its requests, give the lines a moment to empty, then the real renderer, the
// real downloads, the real timings and an empty memory. A line that stays
// occupied fails the next test's assertIdle, which is where it belongs.
async function cleanup(r) {
  if (r) r.letGo();
  await Promise.allSettled([...inFlight]);
  const deadline = Date.now() + 2000;
  while (!isIdle() && Date.now() < deadline) await tick();
  og.setDrawForTests(null);
  og.setRendererForTests(null);
  og.setDownloadForTests(null);
  og.setTimingForTests(null);
  og.forgetCardsForTests();
  og.forgetRangesForTests();
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
      assert.strictEqual(res.headers.get('cache-control'), YEAR);
      assertCardPng(res.body);
      assert.ok(res.body.equals(await websitePng(BASIC)),
        'the card differs from the one the library draws for the website');
    });
  } finally {
    await cleanup();
  }
});

test('an emoji or another script draws the website card too: the same requests and the same bytes', async () => {
  // The library draws these through its own loader, and the route through
  // one of its own. Fed one stand-in web, the two must ask for exactly the
  // same files with the same User-Agent strings, and draw identical PNGs. The
  // library's language detector remembers families for the life of the
  // process, so this test is the only one that draws non-Latin text through
  // it, and the route's own memory of families starts empty here too.
  await cleanup();
  const asked = (calls) => calls
    .map((c) => `${c.url} ${(c.init && c.init.headers && c.init.headers['User-Agent']) || '-'}`).sort();
  try {
    for (const fields of [EMOJI, SELECTORS, KANJI, { n: 'Phở night', w: BASIC.w, g: '2' }, { n: 'مساء الخير ★', w: BASIC.w, g: '5' }]) {
      const params = og.cardParams(fields);
      assert.strictEqual(og.usesSharedFont(params), false, `${fields.n} should need a fallback`);

      const ours = standIn();
      og.setDownloadForTests(ours.fetch);
      const ourPng = await og.drawPng(params, false);

      const theirs = standIn();
      const theirPng = await withGlobalFetch(theirs.fetch, () => websitePng(fields));

      assert.ok(ours.calls.length > 0, `${fields.n} asked for nothing`);
      assert.deepStrictEqual(asked(ours.calls), asked(theirs.calls), `${fields.n}: the downloads differ from the library's`);
      if (fields === SELECTORS) {
        const pictures = ours.calls.map((c) => c.url.replace('https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/', '')).sort();
        assert.deepStrictEqual(pictures, ['1f3f3-fe0f-200d-1f308.svg', '2764.svg'], 'a Twemoji picture was asked for by the wrong name');
      }
      assertCardPng(ourPng);
      assert.ok(ourPng.equals(theirPng), `${fields.n}: the card differs from the one the library draws`);
    }
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
        assertRefused(await get(base, urlPath), 403, 'This card is not signed.', why);
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

test('every card is refused while OG_CARD_SECRET is unset or shorter than 32 characters', async () => {
  await cleanup();
  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  const { n, w, g } = BASIC;
  const saved = process.env.OG_CARD_SECRET;
  const key = crypto.randomBytes(32).toString('base64url');
  // The short-secret line belongs to the next test; here it is only kept off
  // the console.
  const logged = captureErrors();
  try {
    assert.strictEqual(og.MIN_SECRET, 32);
    await withServer(async (base) => {
      for (const value of [undefined, '', '   ', key.slice(0, 31), ` ${key.slice(0, 31)}\n\n`, ' '.repeat(40)]) {
        if (value === undefined) delete process.env.OG_CARD_SECRET;
        else process.env.OG_CARD_SECRET = value;
        const label = value === undefined ? 'unset' : JSON.stringify(value);
        // Signed with that very value, the strongest case for drawing it.
        const own = '/api/og/invite?' + new URLSearchParams({ n, w, g, s: sign(n, w, g, (value || '').trim()) });
        for (const urlPath of [own, cardPath(BASIC)]) {
          assertRefused(await get(base, urlPath), 403, 'This card is not signed.', `secret ${label}`);
        }
      }
      // Exactly 32 characters is enough.
      process.env.OG_CARD_SECRET = key.slice(0, 32);
      const atFloor = '/api/og/invite?' + new URLSearchParams({ n, w, g, s: sign(n, w, g, key.slice(0, 32)) });
      assert.strictEqual((await get(base, atFloor)).status, 200);
      // Trimmed the way the website trims it: a pasted trailing newline signs
      // the same cards.
      process.env.OG_CARD_SECRET = `  ${SECRET}\n`;
      assert.strictEqual((await get(base, cardPath(BASIC))).status, 200);
    });
    assert.strictEqual(r.calls.length, 1, 'a card was drawn without a usable secret');
  } finally {
    logged.restore();
    process.env.OG_CARD_SECRET = saved;
    await cleanup(r);
  }
});

test('a short secret is named once per length, by its length and never its value', async () => {
  await cleanup();
  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  const saved = process.env.OG_CARD_SECRET;
  const logged = captureErrors();
  // Lengths no other test uses, since each is named once per process.
  const short = crypto.randomBytes(32).toString('base64url').slice(0, 29);
  const shorter = crypto.randomBytes(32).toString('base64url').slice(0, 20);
  try {
    await withServer(async (base) => {
      process.env.OG_CARD_SECRET = short;
      await get(base, cardPath(BASIC));
      await get(base, cardPath(BASIC));
      process.env.OG_CARD_SECRET = shorter;
      await get(base, cardPath(BASIC));
      // A cleared variable is unset, not short.
      process.env.OG_CARD_SECRET = '   ';
      await get(base, cardPath(BASIC));
    });
    const said = logged.lines.filter((line) => line.includes('OG_CARD_SECRET'));
    assert.strictEqual(said.length, 2, `one line per length, not one per request:\n${said.join('\n')}`);
    assert.match(said[0], /OG_CARD_SECRET is 29 characters/);
    assert.match(said[1], /OG_CARD_SECRET is 20 characters/);
    for (const line of said) {
      assert.match(line, /treated as UNSET/);
      assert.ok(!line.includes(short) && !line.includes(shorter), 'the line names the length, never the value');
    }
    assert.strictEqual(r.calls.length, 0);
  } finally {
    logged.restore();
    process.env.OG_CARD_SECRET = saved;
    await cleanup(r);
  }
});

test('in production the secret is named at boot when it is unset or short, and a good one boots quietly', () => {
  // A fresh copy of the route is loaded the way a boot loads it, and the copy
  // the rest of this file uses is put back afterwards.
  const id = require.resolve('../routes/ogCard');
  const original = require.cache[id];
  const saved = { NODE_ENV: process.env.NODE_ENV, OG_CARD_SECRET: process.env.OG_CARD_SECRET };
  const setEnv = (env) => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
  const boot = (env) => {
    const logged = captureErrors();
    try {
      setEnv(env);
      delete require.cache[id];
      require(id);
      return logged.lines.filter((line) => line.includes('OG_CARD_SECRET'));
    } finally {
      logged.restore();
      setEnv(saved);
      require.cache[id] = original;
    }
  };

  const unset = boot({ NODE_ENV: 'production', OG_CARD_SECRET: undefined });
  assert.strictEqual(unset.length, 1, 'one line, at require time');
  assert.match(unset[0], /OG_CARD_SECRET is not set/);
  assert.deepStrictEqual(boot({ NODE_ENV: 'production', OG_CARD_SECRET: '  \n' }), unset, 'whitespace is unset too');

  const short = crypto.randomBytes(8).toString('hex'); // 16 characters
  const said = boot({ NODE_ENV: 'production', OG_CARD_SECRET: short });
  assert.strictEqual(said.length, 1, 'one line, at require time');
  assert.match(said[0], /OG_CARD_SECRET is 16 characters/);
  assert.ok(!said[0].includes(short), 'naming the length, never the value');

  assert.deepStrictEqual(boot({ NODE_ENV: 'production', OG_CARD_SECRET: crypto.randomBytes(32).toString('base64url') }), [],
    'a real secret boots quietly');
  assert.deepStrictEqual(boot({ NODE_ENV: 'development', OG_CARD_SECRET: short }), [],
    'outside production the line waits for the first card');
  assert.deepStrictEqual(boot({ NODE_ENV: 'development', OG_CARD_SECRET: undefined }), [],
    'and an unset secret is the ordinary local state');
  // The boot smoke test fails any boot whose output reads like a crash.
  for (const line of [...unset, ...said]) assert.doesNotMatch(line, /ReferenceError|SyntaxError|is not defined/);
});

test('the signature is the contract the website shares: the pinned vector', async () => {
  // Computed once with Node's crypto and pinned, so the website's signer, the
  // Pages proxy and this route can each check the same 22 characters.
  const VECTOR = { secret: 'k'.repeat(43), n: 'Friday dinner', w: 'Fri 8:00 PM', g: '3 going', s: 'vY2GCt-sA90cCCipNMEOKC' };
  assert.strictEqual(og.cardSignature(VECTOR.secret, VECTOR.n, VECTOR.w, VECTOR.g), VECTOR.s);
  assert.strictEqual(sign(VECTOR.n, VECTOR.w, VECTOR.g, VECTOR.secret), VECTOR.s);

  await cleanup();
  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  const saved = process.env.OG_CARD_SECRET;
  process.env.OG_CARD_SECRET = VECTOR.secret;
  try {
    await withServer(async (base) => {
      const { n, w, g, s } = VECTOR;
      const res = await get(base, '/api/og/invite?' + new URLSearchParams({ n, w, g, s }));
      assert.strictEqual(res.status, 200, 'the route refuses the pinned vector');
      const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
      assertRefused(await get(base, '/api/og/invite?' + new URLSearchParams({ n, w, g, s: flipped })),
        403, 'This card is not signed.', 'one character changed');
    });
    assert.deepStrictEqual(r.calls.map((c) => [c.name, c.when, c.going]), [['Friday dinner', 'Fri 8:00 PM', 3]]);
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
        assertRefused(res, 503, 'Too many cards are being drawn. Try again in a moment.', 'past the line');
        assert.strictEqual(res.headers.get('retry-after'), '5');
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
    // Only a fallback render carries a deadline for its downloads.
    assert.ok(r.calls[0].signal instanceof AbortSignal && r.calls[2].signal instanceof AbortSignal);
    assert.strictEqual(r.calls[1].signal, undefined);
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
  const logged = captureErrors();
  try {
    await withServer(async (base) => {
      const failed = await get(base, cardPath(BASIC));
      assertRefused(failed, 503, 'The card could not be drawn.', 'a failed render');
      assertIdle();
      assert.strictEqual(og.lineState().cards, 0, 'a failed card was kept');
      assert.strictEqual((await get(base, cardPath(BASIC))).status, 200);
    });
    assert.strictEqual(draws, 2);
    // The log names the error and carries none of the card's text.
    assert.deepStrictEqual(logged.lines, ['[og-card] could not draw a card: TypeError']);
  } finally {
    logged.restore();
    await cleanup();
  }
});

test('simultaneous requests for one card share one render and take no place in the line', async () => {
  await cleanup();
  const r = heldRenderer();
  og.setDrawForTests(r.draw);
  const OTHER = { n: 'Saturday Brunch', w: BASIC.w, g: '6' };
  try {
    await withCountingServer(async (base, arrived) => {
      const a1 = get(base, cardPath(BASIC));
      await until(() => r.held.length === 1, 'the first draw');
      const copies = [get(base, cardPath(BASIC)), get(base, cardPath(BASIC)), get(base, cardPath(BASIC, { utm: 'x' }))];
      const b = get(base, cardPath(OTHER));
      await until(() => arrived() === 5 && og.lineState().shared.waiting === 1, 'every request to arrive');
      await tick();
      // The copies joined the render in progress instead of queueing.
      assert.deepStrictEqual(og.lineState().shared, { running: 1, waiting: 1 });
      assert.strictEqual(og.lineState().rendering, 2, 'one render per card, two cards');
      await r.drain(() => isIdle());
      const [x, ...ys] = await Promise.all([a1, ...copies]);
      assert.strictEqual(x.status, 200);
      for (const y of ys) {
        assert.strictEqual(y.status, 200);
        assert.ok(y.body.equals(x.body));
      }
      assert.strictEqual((await b).status, 200);
      const again = await get(base, cardPath(BASIC));
      assert.ok(again.body.equals(x.body));
    });
    assert.deepStrictEqual(r.calls.map((c) => c.name), ['Friday Tacos', 'Saturday Brunch'],
      'a card was drawn more than once');
    assertIdle();
  } finally {
    await cleanup(r);
  }
});

test('a shared render that fails fails once for everyone on it, and the next request draws afresh', async () => {
  await cleanup();
  let draws = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  og.setDrawForTests(async (params) => {
    draws += 1;
    if (draws === 1) {
      await gate;
      throw new TypeError('fetch failed');
    }
    return Buffer.from('a drawn card: ' + params.name);
  });
  const logged = captureErrors();
  try {
    await withCountingServer(async (base, arrived) => {
      const all = [get(base, cardPath(BASIC)), get(base, cardPath(BASIC)), get(base, cardPath(BASIC))];
      await until(() => arrived() === 3 && draws === 1, 'every request to arrive');
      await tick();
      assert.strictEqual(og.lineState().rendering, 1);
      release();
      for (const res of await Promise.all(all)) assertRefused(res, 503, 'The card could not be drawn.', 'a shared failure');
      assertIdle();
      assert.strictEqual(og.lineState().cards, 0);
      assert.strictEqual((await get(base, cardPath(BASIC))).status, 200);
    });
    assert.strictEqual(draws, 2, 'three waiting requests made more than one render');
    assert.deepStrictEqual(logged.lines, Array(3).fill('[og-card] could not draw a card: TypeError'));
  } finally {
    logged.restore();
    await cleanup();
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

test('cards that differ only in g, only in w or only in n are different cards', async () => {
  await cleanup();
  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  const variants = [
    BASIC,
    { ...BASIC, g: '5' },
    { ...BASIC, w: 'Sat, Oct 10 at 9:00 PM EDT' },
    { ...BASIC, n: 'Friday Tacos!' },
  ];
  try {
    await withServer(async (base) => {
      const bodies = [];
      for (const v of variants) {
        const res = await get(base, cardPath(v));
        assert.strictEqual(res.status, 200);
        bodies.push(res.body.toString());
      }
      assert.strictEqual(new Set(bodies).size, variants.length, 'two different cards were answered with one picture');
      assert.strictEqual(r.calls.length, variants.length, 'a card was served from another card\'s entry');
      // And each is kept under its own entry.
      for (const [i, v] of variants.entries()) assert.strictEqual((await get(base, cardPath(v))).body.toString(), bodies[i]);
      assert.strictEqual(r.calls.length, variants.length);
    });
    assert.deepStrictEqual(r.calls.map((c) => [c.name, c.when, c.going]), [
      ['Friday Tacos', BASIC.w, 4], ['Friday Tacos', BASIC.w, 5],
      ['Friday Tacos', 'Sat, Oct 10 at 9:00 PM EDT', 4], ['Friday Tacos!', BASIC.w, 4],
    ]);
  } finally {
    await cleanup(r);
  }
});

test('the renderer and its font load once, and the font list is the library\'s own', async () => {
  await cleanup();
  const first = await og.loadRenderer();
  const again = await og.loadRenderer();
  assert.strictEqual(first, again, 'the renderer was loaded twice');
  assert.strictEqual(typeof first.satori, 'function');
  assert.strictEqual(typeof first.Resvg, 'function');
  assert.strictEqual(first.sharedFonts, again.sharedFonts);
  assert.strictEqual(first.sharedFonts.length, 1);
  const [font] = first.sharedFonts;
  assert.deepStrictEqual({ ...font, data: undefined }, { name: 'sans serif', data: undefined, weight: 700, style: 'normal' });
  assert.strictEqual(font.data, first.fontData);
  assert.ok(font.data.equals(LIBRARY_FONT), 'the shared font is not the file the library draws with');
});

test('a shared card is drawn on the one shared font list, and a fallback card on a list of its own', async () => {
  // satori parses a font once per list it is handed, so this choice is the
  // memory story: the shared list for every shared card (one parse), a new
  // list for every fallback card (its downloads never land on the shared
  // one), and always a list (with none, satori would parse the library's
  // default every render).
  await cleanup();
  const fontData = Buffer.from('a stand-in font');
  const sharedFonts = [{ name: 'sans serif', data: fontData, weight: 700, style: 'normal' }];
  const seen = [];
  let resvgOptions = null;
  og.setRendererForTests({
    satori: async (tree, options) => { seen.push(options); return '<svg xmlns="http://www.w3.org/2000/svg"/>'; },
    Resvg: class {
      constructor(svg, options) { resvgOptions = options; }
      render() { return { asPng: () => Buffer.from('a png'), free() {} }; }
      free() {}
    },
    fontData,
    sharedFonts,
  });
  const web = standIn();
  og.setDownloadForTests(web.fetch);
  try {
    const shared = og.cardParams(BASIC);
    const fallback = og.cardParams(EMOJI);
    await og.drawPng(shared, true);
    await og.drawPng(shared, true);
    await og.drawPng(fallback, false);
    await og.drawPng(fallback, false);
    // And through the route, which decides the kind for itself.
    await withServer(async (base) => {
      assert.strictEqual((await get(base, cardPath({ ...BASIC, g: '9' }))).status, 200);
      assert.strictEqual((await get(base, cardPath({ ...EMOJI, g: '9' }))).status, 200);
    });

    assert.strictEqual(seen.length, 6);
    for (const options of seen) {
      assert.strictEqual(options.width, 1200);
      assert.strictEqual(options.height, 630);
      assert.strictEqual(options.debug, false);
      assert.ok(Array.isArray(options.fonts), 'a render was handed no font list');
    }
    for (const i of [0, 1, 4]) {
      assert.strictEqual(seen[i].fonts, sharedFonts, `render ${i} of a shared card did not get the shared list`);
      await assert.rejects(seen[i].loadAdditionalAsset('emoji', '🎉'), { name: 'SharedFontFallback' });
    }
    for (const i of [2, 3, 5]) {
      assert.notStrictEqual(seen[i].fonts, sharedFonts, `render ${i} of a fallback card got the shared list`);
      assert.deepStrictEqual(seen[i].fonts, [{ name: 'sans serif', data: fontData, weight: 700, style: 'normal' }]);
      assert.strictEqual(seen[i].fonts[0].data, fontData, 'the bundled font was read again');
    }
    assert.notStrictEqual(seen[2].fonts, seen[3].fonts, 'two fallback renders shared one list');
    // A fallback render's loader is the real one, fed by the downloads.
    const picture = await seen[2].loadAdditionalAsset('emoji', '🎉');
    assert.strictEqual(picture, 'data:image/svg+xml;base64,' + Buffer.from(EMOJI_PICTURE).toString('base64'));
    assert.ok(web.calls.some((c) => c.url === 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f389.svg'));
    assert.deepStrictEqual(resvgOptions, { fitTo: { mode: 'width', value: 1200 } });
  } finally {
    await cleanup();
  }
});

test('text the bundled font draws by itself never asks for a fallback', async () => {
  // Every character the shared list is allowed to draw, rendered for real. The
  // shared list refuses any fallback, so a single ask would fail the render,
  // and nothing may be downloaded.
  await cleanup();
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

  const web = standIn(() => { throw new TypeError('no network in this test'); });
  og.setDownloadForTests(web.fetch);
  try {
    for (let i = 0; i < allowed.length; i += 55) {
      const params = og.cardParams({ n: allowed.slice(i, i + 55).join(''), w: BASIC.w, g: '3' });
      assert.ok(og.usesSharedFont(params));
      assertCardPng(await og.drawPng(params, true));
    }
    assert.deepStrictEqual(web.calls, [], 'the shared list downloaded something');

    // The refusal is real: an emoji on the shared list fails rather than grow it.
    const emoji = og.cardParams({ n: 'Taco night 🌮', w: BASIC.w, g: '3' });
    await assert.rejects(og.drawPng(emoji, true), { name: 'SharedFontFallback' });
    assert.deepStrictEqual(web.calls, []);
    // The other kind goes to the downloads, which is why it gets its own list.
    await assert.rejects(og.drawPng(emoji, false), { name: 'TypeError' });
    assert.deepStrictEqual(web.calls.map((c) => c.url), ['https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f32e.svg']);
  } finally {
    await cleanup();
  }
});

// ── 4. Downloads ────────────────────────────────────────────────────────────

test('a fallback card is drawn from the three hosts, with the deadline on every download, and kept for an hour', async () => {
  await cleanup();
  const web = standIn();
  og.setDownloadForTests(web.fetch);
  try {
    await withServer(async (base) => {
      const emoji = await get(base, cardPath(EMOJI));
      assert.strictEqual(emoji.status, 200);
      assert.strictEqual(emoji.headers.get('cache-control'), HOUR, 'a card drawn with downloads is not kept for a year');
      assertCardPng(emoji.body);
      assert.deepStrictEqual(web.calls.map((c) => c.url), ['https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f389.svg']);

      const kanji = await get(base, cardPath(KANJI));
      assert.strictEqual(kanji.status, 200);
      assert.strictEqual(kanji.headers.get('cache-control'), HOUR);
      const hosts = new Set(web.calls.map((c) => new URL(c.url).host));
      assert.deepStrictEqual([...hosts].sort(), ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']);
      // The two stylesheets are asked for with the library's two User-Agents.
      const agent = (c) => c.init.headers && c.init.headers['User-Agent'];
      assert.match(agent(web.calls.find((c) => c.url.endsWith('display=swap'))), /Chrome\/112/);
      assert.match(agent(web.calls.find((c) => c.url.includes('&text='))), /Version\/5\.0\.5 Safari/);
      assert.ok(web.calls.every((c) => c.init.signal instanceof AbortSignal), 'a download went without the deadline');

      const before = web.calls.length;
      const plain = await get(base, cardPath(BASIC));
      assert.strictEqual(plain.headers.get('cache-control'), YEAR);
      assert.strictEqual(web.calls.length, before, 'a shared card downloaded something');
      // A kept fallback card keeps its hour.
      assert.strictEqual((await get(base, cardPath(EMOJI))).headers.get('cache-control'), HOUR);
    });
    assertIdle();
  } finally {
    await cleanup();
  }
});

test('every download carries a deadline: the render\'s own, or a fresh one of the same length', async () => {
  // The real download function this time, with global fetch standing in for
  // the hosts. The length is the one utils/upstream.js records for these
  // downloads, and it has to sit inside the 4 s the website's proxy waits.
  await cleanup();
  const { UPSTREAM_TIMEOUT_MS } = require('../utils/upstream');
  assert.strictEqual(og.FALLBACK_DEADLINE_MS, UPSTREAM_TIMEOUT_MS.cardAssets);
  assert.ok(og.FALLBACK_DEADLINE_MS < 4000, 'the deadline outlasts the website proxy');
  const seen = [];
  try {
    await withGlobalFetch(async (url, init) => { seen.push(init || {}); return standInAnswer(String(url)); }, async () => {
      assertCardPng(await og.drawPng(og.cardParams(EMOJI), false));
      const controller = new AbortController();
      assertCardPng(await og.drawPng(og.cardParams({ ...EMOJI, g: '7' }), false, controller.signal));
      assert.strictEqual(seen.length, 2, 'each render downloads its emoji');
      assert.ok(seen[0].signal instanceof AbortSignal, 'a download without a render deadline went without one');
      assert.strictEqual(seen[0].signal.aborted, false);
      assert.notStrictEqual(seen[0].signal, controller.signal);
      assert.strictEqual(seen[1].signal, controller.signal, 'a download did not carry its render\'s deadline');
    });
  } finally {
    await cleanup();
  }
});

test('a download that fails or answers with anything but its file is a 503 that keeps nothing, and is asked again next time', async () => {
  const TWEMOJI = 'https://cdn.jsdelivr.net/';
  const RANGES = (u) => u.startsWith('https://fonts.googleapis.com/') && u.endsWith('display=swap');
  const FONT_CSS = (u) => u.startsWith('https://fonts.googleapis.com/') && u.includes('&text=');
  const cases = [
    ['the emoji CDN answers 503', EMOJI, (u) => (u.startsWith(TWEMOJI) ? new Response('busy', { status: 503 }) : undefined), 'DownloadRefused', TWEMOJI],
    ['the font file is missing', KANJI, (u) => (u.startsWith('https://fonts.gstatic.com/') ? new Response('gone', { status: 404 }) : undefined), 'DownloadRefused', 'https://fonts.gstatic.com/'],
    ['the ranges stylesheet fails', { n: 'Phở night', w: BASIC.w, g: '2' }, (u) => (RANGES(u) ? new Response('oops', { status: 500 }) : undefined), 'DownloadRefused', 'https://fonts.googleapis.com/'],
    ['the network drops a font stylesheet', { n: 'Ночь', w: BASIC.w, g: '2' }, (u) => { if (FONT_CSS(u)) throw new TypeError('fetch failed'); return undefined; }, 'TypeError', 'https://fonts.googleapis.com/'],
    ['a font stylesheet names no file', { n: 'مساء الخير', w: BASIC.w, g: '2' }, (u) => (FONT_CSS(u) ? new Response("@font-face { font-family: 'Noto Sans Arabic'; }") : undefined), 'DownloadRefused', 'https://fonts.googleapis.com/'],
    ['a ranges stylesheet leaves out a family', { n: '★ ✓ ∑', w: BASIC.w, g: '2' }, (u) => (RANGES(u)
      ? new Response(`@font-face {\n  font-family: 'Noto Sans Symbols';\n  unicode-range: ${EVERY_RANGE};\n}\n`) : undefined), 'DownloadRefused', 'https://fonts.googleapis.com/'],
    ['a font stylesheet points at another host', { n: 'Καλησπέρα', w: BASIC.w, g: '2' }, (u) => (FONT_CSS(u)
      ? new Response("@font-face {\n  src: url(https://fonts.example.com/font.ttf) format('truetype');\n}\n") : undefined), 'DownloadRefused', 'https://fonts.googleapis.com/'],
  ];
  for (const [why, fields, twist, errorName, askedAgain] of cases) {
    await cleanup();
    let broken = true;
    const web = standIn((u, init) => (broken ? twist(u, init) : undefined));
    og.setDownloadForTests(web.fetch);
    const logged = captureErrors();
    try {
      await withServer(async (base) => {
        assertRefused(await get(base, cardPath(fields)), 503, 'The card could not be drawn.', why);
        assertIdle();
        assert.strictEqual(og.lineState().cards, 0, `${why}: the broken card was kept`);
        const firstTry = web.count(askedAgain);
        broken = false;
        const healed = await get(base, cardPath(fields));
        assert.strictEqual(healed.status, 200, `${why}: the card stayed broken after the host recovered`);
        assertCardPng(healed.body);
        assert.ok(web.count(askedAgain) > firstTry, `${why}: the failed download was remembered instead of asked again`);
      });
      assert.ok(!web.calls.some((c) => c.url.includes('example.com')), `${why}: a download left the three hosts`);
      // The name of the error and nothing else: no URL, no card text.
      assert.deepStrictEqual(logged.lines, [`[og-card] could not draw a card: ${errorName}`], why);
    } finally {
      logged.restore();
      await cleanup();
    }
  }
});

test('a fallback render has a deadline: its downloads are aborted and the line is free at once', async () => {
  await cleanup();
  og.setTimingForTests({ deadlineMs: 80 });
  let stalled = null;
  let stall = true;
  const web = standIn((u, init) => {
    if (!stall || !u.startsWith('https://cdn.jsdelivr.net/')) return undefined;
    stalled = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  og.setDownloadForTests(web.fetch);
  const logged = captureErrors();
  try {
    await withServer(async (base) => {
      const started = Date.now();
      const res = await get(base, cardPath(EMOJI));
      assertRefused(res, 503, 'The card could not be drawn.', 'a stalled download');
      assert.ok(Date.now() - started < 2500, `the deadline took ${Date.now() - started} ms`);
      assert.ok(stalled && stalled.aborted, 'the stalled download was left running');
      assert.strictEqual(stalled.reason.name, 'TimeoutError');
      assertIdle();
      assert.strictEqual(og.lineState().cards, 0);
      stall = false;
      assert.strictEqual((await get(base, cardPath(EMOJI))).status, 200);
    });
    assert.deepStrictEqual(logged.lines, ['[og-card] could not draw a card: TimeoutError']);
  } finally {
    logged.restore();
    await cleanup();
  }
});

test('a card still waiting for the fallback line when its wait runs out gives up without being drawn', async () => {
  // The website's proxy stops listening at 4 s, so a render nobody waits for
  // would only hold up the next card.
  await cleanup();
  og.setTimingForTests({ waitMs: 60 });
  const r = heldRenderer();
  og.setDrawForTests(r.draw);
  try {
    await withServer(async (base) => {
      const first = get(base, cardPath(EMOJI));
      await until(() => r.held.length === 1, 'the first card to start drawing');
      const second = await get(base, cardPath(KANJI));
      assertRefused(second, 503, 'Too many cards are being drawn. Try again in a moment.', 'the wait ran out');
      assert.strictEqual(second.headers.get('retry-after'), '5');
      assert.deepStrictEqual(og.lineState().fallback, { running: 1, waiting: 0 });
      r.held.shift()();
      assert.strictEqual((await first).status, 200);
    });
    assert.deepStrictEqual(r.calls.map((c) => c.name), [EMOJI.n], 'the card that gave up was drawn anyway');
    assertIdle();
  } finally {
    await cleanup(r);
  }
});

test('hundreds of distinct fallback cards leave nothing behind that grows with their text', async () => {
  // The library's own loader keeps every font and emoji it downloads for the
  // life of the process. This one keeps only the unicode ranges, one entry per
  // family in its fixed table, and none of the downloads: the same emoji card
  // drawn twice downloads its emoji twice.
  await cleanup();
  const web = standIn();
  og.setDownloadForTests(web.fetch);
  const families = new Set(Object.values(og.FALLBACK_FAMILIES).flat());
  const sample = ['東京', 'Ночь', 'مساء', '★✓', 'Phở', 'Καλή', '🎉', '🌮', '🍕'];
  try {
    await withGlobalFetch(() => { throw new Error('the loader reached for global fetch'); }, async () => {
      for (let i = 0; i < 120; i++) {
        const params = og.cardParams({ n: `${sample[i % sample.length]} ${String.fromCodePoint(0x4e00 + i * 37)} ${i}`, w: BASIC.w, g: '2' });
        assert.strictEqual(og.usesSharedFont(params), false);
        assertCardPng(await og.drawPng(params, false));
      }
      assert.ok(og.lineState().families <= families.size, `${og.lineState().families} families kept`);
      const picture = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f389.svg';
      const before = web.count(picture);
      await og.drawPng(og.cardParams(EMOJI), false);
      await og.drawPng(og.cardParams(EMOJI), false);
      assert.strictEqual(web.count(picture), before + 2, 'a downloaded emoji was kept between renders');
    });
    assert.strictEqual(og.lineState().rendering, 0);
    // The library's loader, the map that never shrinks, is never loaded: the
    // route reads the library's font file and nothing else of it.
    const src = fs.readFileSync(path.join(BACKEND, 'routes', 'ogCard.js'), 'utf8');
    assert.doesNotMatch(src, /import\(\s*['"]@vercel\/og['"]\s*\)|require\(\s*['"]@vercel\/og['"]\s*\)/);
    assert.match(src, /require\.resolve\('@vercel\/og\/package\.json'\)/);
  } finally {
    await cleanup();
  }
});

// ── 5. Mounted where a request without a session reaches it ─────────────────

test('server.js mounts the route ahead of every mount that could answer for it', async () => {
  // Every literal-path mount in server.js, replayed in source order. Each one
  // but the card's answers anything that reaches it with a marker, so an
  // unsigned card request gets the route's own 403 only if no earlier mount,
  // a catch-all that demands a session above all, can take it first. Deleting
  // the mount or moving it below the catch-alls fails here.
  await cleanup();
  const src = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const mounts = [...src.matchAll(/^app\.(use|get|post|put|patch|delete|all)\('([^']+)',(.*)$/gm)];
  const card = mounts.filter((m) => m[3].includes("require('./routes/ogCard')"));
  assert.strictEqual(card.length, 1, 'server.js does not mount routes/ogCard.js exactly once');
  assert.strictEqual(card[0][2], '/api/og');
  assert.match(card[0][3], /^\s*apiLimiter, require\('\.\/routes\/ogCard'\)\);/, 'the card is mounted without apiLimiter in front');
  assert.ok(mounts.filter((m) => m[2] === '/api').length >= 2, 'the replay found no /api catch-alls, so it proves nothing');

  const app = express();
  for (const [, verb, mountPath, args] of mounts) {
    if (args.includes("require('./routes/ogCard')")) app[verb](mountPath, ogRoutes);
    else app[verb](mountPath, (req, res) => res.status(418).json({ answeredBy: mountPath }));
  }
  app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

  const r = heldRenderer(() => false);
  og.setDrawForTests(r.draw);
  try {
    await serve(app, async (base) => {
      assertRefused(await get(base, '/api/og/invite?n=x&w=y&g=1'), 403, 'This card is not signed.', 'unsigned, through the real mount order');
      const signed = await get(base, cardPath(BASIC));
      assert.strictEqual(signed.status, 200);
      assert.strictEqual(signed.headers.get('content-type'), 'image/png');
    });
    assert.strictEqual(r.calls.length, 1);
  } finally {
    await cleanup(r);
  }
});

// ── 6. The renderer is the website's ────────────────────────────────────────

test('satori and resvg here are the versions the website\'s @vercel/og draws with', () => {
  // The route calls satori and resvg itself, so this service's copies have to
  // be the ones @vercel/og 0.8.6 pins, and that has to be the version the
  // website's lockfile resolves.
  const backendPkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
  const ogPkg = JSON.parse(fs.readFileSync(require.resolve('@vercel/og/package.json'), 'utf8'));
  const installed = (name) => JSON.parse(fs.readFileSync(path.join(BACKEND, 'node_modules', name, 'package.json'), 'utf8')).version;
  for (const name of ['satori', '@resvg/resvg-wasm']) {
    assert.strictEqual(backendPkg.dependencies[name], ogPkg.dependencies[name],
      `backend/package.json pins ${name} ${backendPkg.dependencies[name]}, and @vercel/og ${ogPkg.version} draws with ${ogPkg.dependencies[name]}`);
    assert.strictEqual(installed(name), ogPkg.dependencies[name], `the installed ${name} is not the pinned one`);
  }
  assert.strictEqual(backendPkg.dependencies['@vercel/og'], ogPkg.version);
  const websiteLock = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package-lock.json'), 'utf8'));
  assert.strictEqual(websiteLock.packages['node_modules/@vercel/og'].version, ogPkg.version,
    'the website draws its cards with another @vercel/og');
});

// ── 7. Nothing the preview does not already publish ─────────────────────────

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
