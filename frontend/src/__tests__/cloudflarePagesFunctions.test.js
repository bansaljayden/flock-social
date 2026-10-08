/**
 * @jest-environment node
 */
/*
 * The Cloudflare Pages Functions (functions/): the vercel.json rules that
 * look at the User-Agent or the query string, which functions/_middleware.js
 * runs in code because _redirects and _headers match on the path alone, and
 * the Functions around the unchanged api/ handlers. What is pinned here:
 * - who gets what on "/", the five marketing paths and /i/<token>: AI
 *   crawlers, preview bots, people, ?open, exactly one path segment;
 * - every Function answer carries vercel.json's security headers, and an
 *   s-maxage answer reaches the browser the way Vercel sent it;
 * - the demo relay signs CF-Connecting-IP and nothing a caller can write;
 * - the share-card proxy sends only signed cards upstream and keeps only real
 *   ones;
 * - byte ranges on the background video;
 * - the edge cache keeps what Vercel's CDN kept, and nothing else.
 * Nothing here leaves the process: fetch is a stand-in for the backend.
 * The configuration files and the build script are in cloudflarePages.test.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The Workers runtime has fetch's classes and Web Crypto as globals; Jest 27's
// node environment has neither. Node's own implementations of the same WHATWG
// classes live in the realm outside the test sandbox, so the tests lend them.
const outer = require('vm').runInThisContext('globalThis');
global.Response = outer.Response;
global.Headers = outer.Headers;
global.Request = outer.Request;
global.crypto = crypto.webcrypto;

const { onRequest: middleware } = require('../../functions/_middleware.js');
const marketingFunction = require('../../functions/api/marketing-page.js');
const invitePreviewFunction = require('../../functions/api/invite-preview.js');
const demoRelayFunction = require('../../functions/api/demo-relay.js');
const appSiteAssociationFunction = require('../../functions/api/apple-app-site-association.js');
const inviteOgFunction = require('../../functions/api/invite-og.js');
const { withByteRanges } = require('../../functions/_lib/range.js');
const { edgeCached } = require('../../functions/_lib/edge-cache.js');
const { runNodeHandler } = require('../../functions/_lib/node-adapter.js');
const { cardSignature, sameSignature, MIN_SECRET } = require('../../functions/_lib/card-signature.js');
const marketing = require('../../api/marketing-page.js');
const preview = require('../../api/invite-preview.js');
const relay = require('../../api/demo-relay.js');
const build = require('../../scripts/build-cloudflare.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const vercel = JSON.parse(read('vercel.json'));
const VERCEL_CSP = vercel.headers.find((r) => r.source === '/(.*)').headers
  .find((h) => h.key === 'Content-Security-Policy').value;
const ROOT_LINK = vercel.headers.find((r) => r.source === '/').headers.find((h) => h.key === 'Link').value;
const SECURITY = JSON.parse(read('cloudflare/security-headers.json')).headers;
const AGENTS = JSON.parse(read('cloudflare/user-agents.json'));
const BANNER = fs.readFileSync(path.join(ROOT, 'public', 'og-image.png'));
const VIDEO = fs.readFileSync(path.join(ROOT, 'public', 'bg-city.mp4'));

const SITE = 'https://www.flockcorp.com';
// What Vercel sends a browser for any answer that carried s-maxage.
const BROWSER_CACHE = 'public, max-age=0, must-revalidate';
const SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';
const UA = {
  person: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  twitterbot: 'Twitterbot/1.0',
  imessage: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
  applebot: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3)',
};

const GOOD_TOKEN = 'GoodToken0123456789';
const PAYLOAD = {
  flock: { name: 'Friday Tacos', when: '2026-10-10T01:00:00Z', chosenVenue: 'El Vez', status: 'confirmed' },
  host: 'Sam',
  going: 4,
  venues: [],
};
const CARD_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(64)]);

// The preview page the handler renders for PAYLOAD, built the handler's way.
function invitePage(token) {
  const copy = preview.describe(PAYLOAD);
  return preview.renderPage({ title: copy.title, description: copy.description, card: copy.card || null, token });
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

// Stands in for the Railway API: the guest read, the two demo reads and the
// card renderer. Tests swap it for failures.
function railway(u) {
  if (u.pathname.startsWith('/api/guest/')) {
    return u.pathname === '/api/guest/' + GOOD_TOKEN ? json(200, PAYLOAD) : json(404, { error: 'This invite link is no longer active' });
  }
  if (u.pathname.startsWith('/api/public/demo/')) return json(200, { ok: true }, { 'Cache-Control': 'private, no-store' });
  if (u.pathname === '/api/og/invite') {
    return new Response(CARD_PNG, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  return json(404, { error: 'not found' });
}

// caches.default, holding a snapshot of each stored answer the way the Cache
// API does.
function memoryCache() {
  const store = new Map();
  return {
    store,
    match: jest.fn(async (request) => {
      const hit = store.get(request.url);
      return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
    }),
    put: jest.fn(async (request, response) => {
      store.set(request.url, { status: response.status, headers: [...response.headers], body: Buffer.from(await response.arrayBuffer()) });
    }),
  };
}

// What a Pages Function receives. next() stands in for the rest of the chain:
// by default the static asset server answering with the app shell.
function pagesContext(url, { method = 'GET', headers = {}, env = {}, next } = {}) {
  const waits = [];
  const context = {
    request: new Request(url, { method, headers }),
    env: { ASSETS: { fetch: jest.fn(async () => new Response(BANNER, { headers: { 'Content-Type': 'image/png' } })) }, ...env },
    waitUntil: (promise) => { waits.push(promise); },
    passThroughOnException: jest.fn(),
    settled: () => Promise.all(waits),
    staticAnswer: new Response(SHELL, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
  };
  context.next = jest.fn(next ? () => next(context) : async () => context.staticAnswer);
  return context;
}

async function run(url, options) {
  const context = pagesContext(url, options);
  const res = await middleware(context);
  await context.settled();
  expect(context.passThroughOnException).toHaveBeenCalledTimes(1);
  return { context, res };
}

const bytes = async (res) => Buffer.from(await res.arrayBuffer());
const botUa = (name) => 'Mozilla/5.0 (compatible; ' + name + '/1.0; +https://example.com/bot)';

function expectSecurityHeaders(res, except = []) {
  for (const [name, value] of SECURITY) {
    if (!except.includes(name)) expect([name, res.headers.get(name)]).toEqual([name, value]);
  }
  expect(res.headers.get('Content-Security-Policy')).toBe(VERCEL_CSP);
}

function fakeTeamId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) id += alphabet[crypto.randomInt(alphabet.length)];
  return id;
}

async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error('the condition never held');
}

let upstream;
let backend;

beforeEach(() => {
  upstream = [];
  backend = railway;
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = new URL(String(url));
    upstream.push({ url: String(url), path: u.pathname, init });
    return backend(u, init);
  });
  global.caches = { default: memoryCache() };
  process.env.RELAY_SIGNING_SECRET = crypto.randomBytes(24).toString('base64url');
});

afterEach(() => {
  delete global.fetch;
  delete global.caches;
  delete process.env.RELAY_SIGNING_SECRET;
  delete process.env.APPLE_TEAM_ID;
});

describe('who gets what', () => {
  test('"/" sends every AI crawler to /landing with a 307 and the query, and anyone else to the static page', async () => {
    for (const name of AGENTS.aiCrawlers.split('|')) {
      const { context, res } = await run(SITE + '/?utm_source=x&b=2', { headers: { 'User-Agent': botUa(name) } });
      expect([name, res.status, res.headers.get('Location')]).toEqual([name, 307, '/landing?utm_source=x&b=2']);
      // vercel.json's "/" rule went onto the redirect as well.
      expect(res.headers.get('Link')).toBe(ROOT_LINK);
      expect(res.headers.get('Cache-Control')).toBe(BROWSER_CACHE);
      expectSecurityHeaders(res);
      expect(context.next).not.toHaveBeenCalled();
    }
    // Vercel matched the list case-sensitively, so "gptbot" is not GPTBot.
    for (const ua of [UA.person, UA.twitterbot, UA.applebot, UA.googlebot, botUa('gptbot'), '']) {
      const { context, res } = await run(SITE + '/', { headers: ua ? { 'User-Agent': ua } : {} });
      expect([ua, res === context.staticAnswer]).toEqual([ua, true]);
    }
  });

  test('the five marketing paths give AI crawlers the static document, byte for byte', async () => {
    for (const [route, key] of [['/landing', 'home'], ['/about', 'about'], ['/support', 'support'], ['/privacy', 'privacy'], ['/terms', 'terms']]) {
      const { context, res } = await run(SITE + route, { headers: { 'User-Agent': UA.gptbot } });
      expect([route, res.status]).toEqual([route, 200]);
      expect([route, await res.text()]).toEqual([route, marketing.renderPage(key)]);
      expect(res.headers.get('Link')).toBe('<' + SITE + marketing.PAGE_META[key].path + '>; rel="canonical"');
      expect(res.headers.get('Vary')).toBe('User-Agent');
      expect(res.headers.get('Cache-Control')).toBe(BROWSER_CACHE);
      expect(res.headers.get('X-Robots-Tag')).toBeNull();
      expectSecurityHeaders(res);
      expect(context.next).not.toHaveBeenCalled();
    }
  });

  test('people, preview bots and every other path or spelling keep the app', async () => {
    const cases = [
      ['/about', UA.person], ['/about', UA.twitterbot], ['/about', UA.applebot], ['/landing', UA.person],
      ['/about/', UA.gptbot], ['/About', UA.gptbot], ['/research', UA.gptbot],
    ];
    for (const [route, ua] of cases) {
      const { context, res } = await run(SITE + route, { headers: { 'User-Agent': ua } });
      expect([route, ua, res === context.staticAnswer]).toEqual([route, ua, true]);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an ambiguous ?page falls back to the home document, as Vercel\'s merged query did', async () => {
    let { res } = await run(SITE + '/about?page=privacy', { headers: { 'User-Agent': UA.gptbot } });
    expect(await res.text()).toBe(marketing.renderPage('home'));
    ({ res } = await run(SITE + '/about?page=about', { headers: { 'User-Agent': UA.gptbot } }));
    expect(await res.text()).toBe(marketing.renderPage('about'));
  });

  test('every preview bot gets the invite preview, and one backend read serves them all', async () => {
    const expected = invitePage(GOOD_TOKEN);
    for (const ua of [UA.imessage, ...AGENTS.previewBots.split('|').map(botUa)]) {
      const { context, res } = await run(SITE + '/i/' + GOOD_TOKEN, { headers: { 'User-Agent': ua } });
      expect([ua, res.status]).toEqual([ua, 200]);
      expect([ua, await res.text()]).toEqual([ua, expected]);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex, noarchive');
      expect(res.headers.get('Vary')).toBe('User-Agent');
      expect(res.headers.get('Cache-Control')).toBe(BROWSER_CACHE);
      expectSecurityHeaders(res, ['Referrer-Policy']);
      expect(context.next).not.toHaveBeenCalled();
    }
    // The first answer is kept for its s-maxage ten minutes.
    expect(upstream.map((u) => u.path)).toEqual(['/api/guest/' + GOOD_TOKEN]);
  });

  test('?open, people, AI crawlers and anything but one path segment get the app', async () => {
    const cases = [
      ['/i/' + GOOD_TOKEN + '?open=1', UA.twitterbot],
      ['/i/' + GOOD_TOKEN + '?open', UA.imessage],
      ['/i/' + GOOD_TOKEN, UA.person],
      ['/i/' + GOOD_TOKEN, UA.safari],
      ['/i/' + GOOD_TOKEN, UA.gptbot],
      ['/i', UA.twitterbot],
      ['/i/', UA.twitterbot],
      ['/i/' + GOOD_TOKEN + '/extra', UA.twitterbot],
      ['/i/' + GOOD_TOKEN + '/', UA.twitterbot],
    ];
    for (const [route, ua] of cases) {
      const { context, res } = await run(SITE + route, { headers: { 'User-Agent': ua } });
      expect([route, ua, res === context.staticAnswer]).toEqual([route, ua, true]);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a revoked link, a failed backend or an ambiguous token gives the generic tags, never kept', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const generic = async (route) => {
      const { res } = await run(SITE + route, { headers: { 'User-Agent': UA.twitterbot } });
      expect([route, res.status]).toEqual([route, 200]);
      expect(await res.text()).toContain('<title>Flock | Plans that actually happen</title>');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    };
    await generic('/i/RevokedToken123');
    await generic('/i/RevokedToken123');
    expect(upstream.map((u) => u.path)).toEqual(['/api/guest/RevokedToken123', '/api/guest/RevokedToken123']);

    backend = () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); };
    await generic('/i/' + GOOD_TOKEN);
    expect(quiet.mock.calls.flat().join(' ')).not.toContain(GOOD_TOKEN);

    // /i/AAA?token=BBB reaches the handler as two tokens, as Vercel's merge
    // did; it answers without asking the backend.
    upstream.length = 0;
    await generic('/i/' + GOOD_TOKEN + '?token=OtherToken99');
    expect(upstream).toEqual([]);
    expect(global.caches.default.store.size).toBe(0);
    quiet.mockRestore();
  });

  test('/api/ answers get the security headers, and the marketing function URL is noindex', async () => {
    let { res } = await run(SITE + '/api/marketing-page?page=about', { next: (c) => marketingFunction.onRequest(c) });
    expect(await res.text()).toBe(marketing.renderPage('about'));
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toBe(BROWSER_CACHE);
    expectSecurityHeaders(res);

    // A name with no function falls through to the app shell, as on Vercel.
    const { context, res: shell } = await run(SITE + '/api/nonexistent');
    expect(context.next).toHaveBeenCalledTimes(1);
    expect(await shell.text()).toBe(SHELL);
    expectSecurityHeaders(shell);

    // A Function's own header wins over the site-wide one: no-referrer stays.
    ({ res } = await run(SITE + '/api/invite-preview?token=' + GOOD_TOKEN, { next: (c) => invitePreviewFunction.onRequest(c) }));
    expect(await res.text()).toBe(invitePage(GOOD_TOKEN));
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expectSecurityHeaders(res, ['Referrer-Policy']);
  });

  test('on the pages.dev copy every Function answer is noindex; on www none is added', async () => {
    let { res } = await run('https://flockcorp.pages.dev/about', { headers: { 'User-Agent': UA.gptbot } });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    ({ res } = await run('https://flockcorp.pages.dev/?x=1', { headers: { 'User-Agent': UA.gptbot } }));
    expect([res.status, res.headers.get('X-Robots-Tag')]).toEqual([307, 'noindex']);
    ({ res } = await run('https://flockcorp.pages.dev/i/' + GOOD_TOKEN, { headers: { 'User-Agent': UA.twitterbot } }));
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, noarchive');
    ({ res } = await run(SITE + '/?x=1', { headers: { 'User-Agent': UA.gptbot } }));
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  test('a Function that throws has already handed the request back to Pages\' static answer', async () => {
    global.caches = { default: { match: async () => { throw new Error('cache unavailable'); }, put: async () => {} } };
    const context = pagesContext(SITE + '/i/' + GOOD_TOKEN, { headers: { 'User-Agent': UA.twitterbot } });
    await expect(middleware(context)).rejects.toThrow('cache unavailable');
    expect(context.passThroughOnException).toHaveBeenCalledTimes(1);
  });
});

describe('the demo relay signs CF-Connecting-IP and nothing a caller can write', () => {
  const DEMO = SITE + '/relay/public/demo/venues?lat=40.1&lng=-75.2';
  const signature = (ip, ts) => crypto.createHmac('sha256', process.env.RELAY_SIGNING_SECRET).update(ip + '.' + ts).digest('hex');
  const signedHeaders = (init) => Object.keys(init.headers).filter((k) => k.startsWith('x-flock-relay')).sort();

  test('CF-Connecting-IP wins over any X-Forwarded-For or X-Real-IP the caller sent', async () => {
    const { res } = await run(DEMO, {
      headers: {
        'User-Agent': UA.person,
        Accept: 'application/json',
        'CF-Connecting-IP': '203.0.113.7',
        'X-Forwarded-For': '198.51.100.88, 203.0.113.7',
        'X-Real-IP': '198.51.100.66',
        'X-Vercel-Forwarded-For': '198.51.100.99',
        'True-Client-IP': '198.51.100.77',
      },
    });
    expect(upstream).toHaveLength(1);
    const { url, init } = upstream[0];
    expect(url).toBe(relay.UPSTREAM + '/api/public/demo/venues?lat=40.1&lng=-75.2');
    // Accept, the relay's own User-Agent and the signature: no address header
    // the caller wrote goes upstream.
    expect(Object.keys(init.headers).sort()).toEqual(['Accept', 'User-Agent', 'x-flock-relay-ip', 'x-flock-relay-sig', 'x-flock-relay-ts']);
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['x-flock-relay-ip']).toBe('203.0.113.7');
    expect(init.headers['x-flock-relay-sig']).toBe(signature('203.0.113.7', init.headers['x-flock-relay-ts']));
    expect(Math.abs(Number(init.headers['x-flock-relay-ts']) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expectSecurityHeaders(res);
  });

  test('without CF-Connecting-IP nothing is signed, whatever address headers the caller sent', async () => {
    await run(DEMO, { headers: { 'X-Forwarded-For': '198.51.100.88', 'X-Real-IP': '198.51.100.66', 'X-Vercel-Forwarded-For': '198.51.100.99' } });
    expect(upstream).toHaveLength(1);
    expect(signedHeaders(upstream[0].init)).toEqual([]);
  });

  test('an unparseable CF-Connecting-IP is not signed; an IPv6 one is', async () => {
    await run(DEMO, { headers: { 'CF-Connecting-IP': 'unknown', 'X-Forwarded-For': '198.51.100.88' } });
    expect(signedHeaders(upstream[0].init)).toEqual([]);
    await run(DEMO, { headers: { 'CF-Connecting-IP': '2001:db8::7' } });
    const { init } = upstream[1];
    expect(init.headers['x-flock-relay-ip']).toBe('2001:db8::7');
    expect(init.headers['x-flock-relay-sig']).toBe(signature('2001:db8::7', init.headers['x-flock-relay-ts']));
  });

  test('GET only, the two demo paths only, and /api/demo-relay is the same relay', async () => {
    let { res } = await run(SITE + '/relay/public/demo/venues', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    expect([res.status, res.headers.get('Allow')]).toEqual([405, 'GET']);
    expectSecurityHeaders(res);
    for (const route of ['/relay/public/secret/admin', '/relay/public', '/relay/public/', '/relay/public/demo']) {
      ({ res } = await run(SITE + route));
      expect([route, res.status, await res.json()]).toEqual([route, 404, { error: 'Not found' }]);
    }
    expect(upstream).toEqual([]);

    await run(SITE + '/relay/public/demo/venue/ChIJabc-123_x?localHour=9', { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    expect(upstream[0].url).toBe(relay.UPSTREAM + '/api/public/demo/venue/ChIJabc-123_x?localHour=9');

    ({ res } = await run(SITE + '/api/demo-relay?path=demo/venues&lat=1', {
      headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '198.51.100.88' },
      next: (c) => demoRelayFunction.onRequest(c),
    }));
    expect(res.status).toBe(200);
    expect(upstream[1].url).toBe(relay.UPSTREAM + '/api/public/demo/venues?lat=1');
    expect(upstream[1].init.headers['x-flock-relay-ip']).toBe('203.0.113.9');
  });

  test('a 429 and its Retry-After come back unchanged', async () => {
    backend = () => json(429, { error: 'The live demo is taking a breather. The full thing is in the app.' }, { 'Retry-After': '60' });
    const { res } = await run(DEMO, { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    expect([res.status, res.headers.get('Retry-After'), res.headers.get('Cache-Control')]).toEqual([429, '60', 'private, no-store']);
  });
});

describe('the app-site-association function', () => {
  test('/api/apple-app-site-association answers the bytes the build writes as a file', async () => {
    process.env.APPLE_TEAM_ID = fakeTeamId();
    const { res } = await run(SITE + '/api/apple-app-site-association', { next: (c) => appSiteAssociationFunction.onRequest(c) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await res.text()).toBe(build.appSiteAssociation());
    expectSecurityHeaders(res);
  });

  test('without a Team ID it says so with an uncached 503', async () => {
    const { res } = await run(SITE + '/api/apple-app-site-association', { next: (c) => appSiteAssociationFunction.onRequest(c) });
    expect([res.status, res.headers.get('Cache-Control')]).toEqual([503, 'no-store']);
    expect((await res.json()).error).toMatch(/APPLE_TEAM_ID/);
  });
});

describe('the share-card proxy draws only signed cards', () => {
  const CARD = { n: 'Friday Tacos', w: 'Fri, Oct 9 at 9:00 PM EDT', g: '4' };
  const sign = (secret, { n, w, g }) => crypto.createHmac('sha256', secret).update(n + '\n' + w + '\n' + g).digest('base64url').slice(0, 22);
  const cardUrl = (card, s) => SITE + '/api/invite-og?' + new URLSearchParams(s === undefined ? card : { ...card, s });
  const rendererUrl = (query) => 'https://api.flockcorp.com/api/og/invite?' + new URLSearchParams(query);
  const og = (url, env, options = {}) => run(url, {
    headers: { 'User-Agent': UA.imessage }, env, next: (c) => inviteOgFunction.onRequest(c), ...options,
  });
  const expectBanner = async (res) => {
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await bytes(res)).equals(BANNER)).toBe(true);
  };

  test('without an OG_CARD_SECRET of 32 characters every card is the static banner, and nothing goes upstream', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const env of [{}, { OG_CARD_SECRET: 'short-secret' }, { OG_CARD_SECRET: ' '.repeat(40) }]) {
      const { res } = await og(cardUrl(CARD, 'A'.repeat(22)), env);
      await expectBanner(res);
      expectSecurityHeaders(res);
    }
    // Correctly signed with a secret one character short, trimmed or not:
    // the length alone refuses it.
    for (const secret of ['k'.repeat(31), ' ' + 'k'.repeat(31) + '\n', crypto.randomBytes(23).toString('base64url')]) {
      const { res } = await og(cardUrl(CARD, sign(secret.trim(), CARD)), { OG_CARD_SECRET: secret });
      await expectBanner(res);
    }
    expect(upstream).toEqual([]);
    quiet.mockRestore();
  });

  test('32 characters is enough, the floor the signer and the backend use', async () => {
    expect(MIN_SECRET).toBe(32);
    expect(preview.OG_CARD_SECRET_MIN).toBe(MIN_SECRET);
    const secret = 'k'.repeat(32);
    const { res } = await og(cardUrl(CARD, sign(secret, CARD)), { OG_CARD_SECRET: secret });
    expect(upstream.map((u) => u.url)).toEqual([rendererUrl({ ...CARD, s: sign(secret, CARD) })]);
    expect((await bytes(res)).equals(CARD_PNG)).toBe(true);
  });

  test('a secret that is set but short is named by its length once, never by its value', () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.isolateModules(() => {
      const { cardSecret } = require('../../functions/_lib/card-signature.js');
      expect(cardSecret({ OG_CARD_SECRET: 'k'.repeat(31) })).toBe('');
      expect(cardSecret({ OG_CARD_SECRET: 'k'.repeat(31) })).toBe('');
      expect(cardSecret({})).toBe('');
      expect(cardSecret(undefined)).toBe('');
      expect(cardSecret({ OG_CARD_SECRET: ' ' + 'k'.repeat(32) + '\n' })).toBe('k'.repeat(32));
    });
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(quiet.mock.calls[0].join(' ')).toContain('31 characters');
    expect(quiet.mock.calls[0].join(' ')).not.toContain('k'.repeat(31));
    quiet.mockRestore();
  });

  test('the signature the preview page puts in og:image is the one this Function draws', async () => {
    // The signer (api/invite-preview.js, reading process.env) and this check
    // (reading the Function's env) hold the same secret on Pages.
    const secret = crypto.randomBytes(32).toString('base64url');
    process.env.OG_CARD_SECRET = secret;
    try {
      const { res: page } = await run(SITE + '/i/' + GOOD_TOKEN, { headers: { 'User-Agent': UA.imessage } });
      const html = await page.text();
      const image = /<meta property="og:image" content="([^"]+)">/.exec(html)[1].replace(/&amp;/g, '&');
      const card = new URL(image).searchParams;
      expect([...card.keys()]).toEqual(['n', 'w', 'g', 's']);
      expect(card.get('s')).toBe(sign(secret, { n: card.get('n'), w: card.get('w'), g: card.get('g') }));
      expect(image.startsWith(SITE + '/api/invite-og?')).toBe(true);

      upstream.length = 0;
      const { res } = await og(image, { OG_CARD_SECRET: secret });
      expect(upstream.map((u) => u.url)).toEqual([rendererUrl(Object.fromEntries(card))]);
      expect((await bytes(res)).equals(CARD_PNG)).toBe(true);
    } finally {
      delete process.env.OG_CARD_SECRET;
    }
  });

  test('a signed card is drawn once by the backend and then served from the edge', async () => {
    const secret = crypto.randomBytes(32).toString('base64url');
    const s = sign(secret, CARD);
    // The secret is trimmed on both sides, as pasted values often carry a newline.
    const env = { OG_CARD_SECRET: ' ' + secret + '\n' };
    let { res } = await og(cardUrl(CARD, s), env);
    expect(upstream.map((u) => u.url)).toEqual([rendererUrl({ ...CARD, s })]);
    expect(upstream[0].init.headers.Accept).toBe('image/png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe(BROWSER_CACHE);
    expect((await bytes(res)).equals(CARD_PNG)).toBe(true);
    expectSecurityHeaders(res);
    // Every input is in the URL, so the copy is kept for thirty days.
    const [stored] = [...global.caches.default.store.values()];
    expect(new Headers(stored.headers).get('Cache-Control')).toBe('public, max-age=2592000');

    ({ res } = await og(cardUrl(CARD, s), env));
    expect(upstream).toHaveLength(1);
    expect((await bytes(res)).equals(CARD_PNG)).toBe(true);
  });

  test('a tampered, truncated or foreign signature gets the banner without a backend call', async () => {
    const secret = crypto.randomBytes(32).toString('base64url');
    const s = sign(secret, CARD);
    const forged = [
      cardUrl({ ...CARD, g: '5' }, s),
      cardUrl({ ...CARD, n: 'Friday Tacos!' }, s),
      cardUrl(CARD),
      cardUrl(CARD, s.slice(0, 21)),
      cardUrl(CARD, s + 'A'),
      cardUrl(CARD, sign(crypto.randomBytes(32).toString('base64url'), CARD)),
    ];
    for (const url of forged) {
      const { res } = await og(url, { OG_CARD_SECRET: secret });
      await expectBanner(res);
    }
    expect(upstream).toEqual([]);
  });

  test('a refused, failed or wrong-typed render is the banner and is not kept', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const secret = crypto.randomBytes(32).toString('base64url');
    const s = sign(secret, CARD);
    const failures = [
      () => json(403, { error: 'This card is not signed.' }),
      () => new Response('down', { status: 503 }),
      () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
      () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); },
    ];
    for (const failure of failures) {
      upstream.length = 0;
      backend = failure;
      for (let i = 0; i < 2; i++) await expectBanner((await og(cardUrl(CARD, s), { OG_CARD_SECRET: secret })).res);
      // Not kept, so a later fetch of the same URL can still get the card.
      expect(upstream).toHaveLength(2);
    }
    expect(global.caches.default.store.size).toBe(0);
    const logged = quiet.mock.calls.flat().join(' ');
    expect(logged).not.toContain(s);
    expect(logged).not.toContain('Tacos');
    quiet.mockRestore();
  });

  test('a renderer slower than four seconds gets the banner', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    backend = (u, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    });
    const secret = crypto.randomBytes(32).toString('base64url');
    const context = pagesContext(cardUrl(CARD, sign(secret, CARD)), {
      env: { OG_CARD_SECRET: secret }, next: (c) => inviteOgFunction.onRequest(c),
    });
    const pending = middleware(context);
    await until(() => upstream.length === 1);
    const deadline = timers.mock.calls.find(([, ms]) => ms === 4000);
    expect(deadline).toBeDefined();
    deadline[0]();
    await expectBanner(await pending);
    expect(quiet.mock.calls.flat().join(' ')).toContain('AbortError');
    timers.mockRestore();
    quiet.mockRestore();
  });

  test('only GET and HEAD', async () => {
    const { res } = await og(cardUrl(CARD, 'A'.repeat(22)), {}, { method: 'POST' });
    expect([res.status, res.headers.get('Allow')]).toEqual([405, 'GET, HEAD']);
  });

  test('the Function\'s check is the backend\'s: HMAC-SHA256 over name, when and going, base64url, 22 characters', async () => {
    const secret = crypto.randomBytes(32).toString('base64url');
    // Built from code points so this file stays pure ASCII.
    const eAcute = String.fromCharCode(0xe9);
    const aAcute = String.fromCharCode(0xe1);
    const taco = String.fromCodePoint(0x1f32e);
    const cards = [
      CARD,
      { n: 'Caf' + eAcute + ' Ol' + eAcute, w: 'S' + aAcute + 'b, 12 de oct', g: '12' },
      { n: taco + ' Night', w: '', g: '0' },
      { n: '', w: '', g: '' },
      { n: 'a&b=c?d', w: 'x+y z', g: '999' },
    ];
    for (const card of cards) {
      expect([card.n, await cardSignature(secret, card.n, card.w, card.g)]).toEqual([card.n, sign(secret, card)]);
    }
    // A second secret is a second key, never the first one reused.
    const other = crypto.randomBytes(32).toString('base64url');
    expect(await cardSignature(other, CARD.n, CARD.w, CARD.g)).toBe(sign(other, CARD));
    // A fixed vector, pinned for the signer in inviteShareCard.test.js too.
    expect(await cardSignature('k'.repeat(43), 'Friday dinner', 'Fri 8:00 PM', '3 going')).toBe('vY2GCt-sA90cCCipNMEOKC');
    expect(preview.cardSignature('k'.repeat(43), 'Friday dinner', 'Fri 8:00 PM', '3 going')).toBe('vY2GCt-sA90cCCipNMEOKC');
    expect(sameSignature('abc', 'abc')).toBe(true);
    expect(sameSignature('abc', 'abd')).toBe(false);
    expect(sameSignature('abc', 'abcd')).toBe(false);
    expect(sameSignature(undefined, 'abc')).toBe(false);
  });
});

describe('byte ranges on the background video', () => {
  const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const VIDEO_CACHE = 'public, max-age=86400, stale-while-revalidate=604800';
  const file = (extra = {}) => new Response(BODY, {
    headers: { 'Content-Type': 'video/mp4', 'Cache-Control': VIDEO_CACHE, ETag: '"v1"', ...extra },
  });
  const ask = (range, method = 'GET') => new Request(SITE + '/bg-city.mp4', { method, headers: range ? { Range: range } : {} });

  test('a single range is a 206 cut from the file, keeping the file\'s own headers', async () => {
    const res = await withByteRanges(ask('bytes=0-1'), file({ 'Content-Encoding': 'identity' }));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/1000');
    expect(res.headers.get('Content-Length')).toBe('2');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Cache-Control')).toBe(VIDEO_CACHE);
    expect(res.headers.get('ETag')).toBe('"v1"');
    expect(res.headers.get('Content-Encoding')).toBeNull();
    expect((await bytes(res)).equals(BODY.subarray(0, 2))).toBe(true);
  });

  test('open-ended, suffix and overlong ranges', async () => {
    const cases = [
      ['bytes=990-', 'bytes 990-999/1000', BODY.subarray(990)],
      ['bytes=-100', 'bytes 900-999/1000', BODY.subarray(900)],
      ['bytes=-5000', 'bytes 0-999/1000', BODY],
      ['bytes=500-99999', 'bytes 500-999/1000', BODY.subarray(500)],
      [' bytes=7-7 ', 'bytes 7-7/1000', BODY.subarray(7, 8)],
    ];
    for (const [range, contentRange, expected] of cases) {
      const res = await withByteRanges(ask(range), file());
      expect([range, res.status, res.headers.get('Content-Range')]).toEqual([range, 206, contentRange]);
      expect([range, (await bytes(res)).equals(expected)]).toEqual([range, true]);
    }
  });

  test('a range that starts past the end is a 416 that names the size', async () => {
    for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=-0', 'bytes=5-2']) {
      const res = await withByteRanges(ask(range), file());
      expect([range, res.status, res.headers.get('Content-Range')]).toEqual([range, 416, 'bytes */1000']);
      expect(await res.text()).toBe('');
    }
  });

  test('no range, HEAD, or a range it does not handle: the whole file', async () => {
    let res = await withByteRanges(ask(), file());
    expect([res.status, res.headers.get('Accept-Ranges')]).toEqual([200, 'bytes']);
    expect((await bytes(res)).equals(BODY)).toBe(true);
    res = await withByteRanges(ask('bytes=0-1', 'HEAD'), file());
    expect([res.status, res.headers.get('Accept-Ranges')]).toEqual([200, 'bytes']);
    for (const range of ['bytes=0-1,5-6', 'items=0-1', 'bytes=-', 'bytes=a-b']) {
      res = await withByteRanges(ask(range), file());
      expect([range, res.status]).toEqual([range, 200]);
      expect((await bytes(res)).equals(BODY)).toBe(true);
    }
  });

  test('an answer Pages already made partial, conditional or missing passes straight through', async () => {
    for (const status of [206, 304, 404]) {
      for (const range of ['bytes=0-1', undefined]) {
        const answer = new Response(status === 304 ? null : 'x', { status });
        expect([status, range, (await withByteRanges(ask(range), answer)) === answer]).toEqual([status, range, true]);
      }
    }
  });

  test('/bg-city.mp4 through the middleware: Safari\'s first probe gets bytes 0-1 of the real file', async () => {
    const { context, res } = await run(SITE + '/bg-city.mp4', {
      headers: { Range: 'bytes=0-1', 'User-Agent': UA.safari },
      next: async () => new Response(VIDEO, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': VIDEO_CACHE } }),
    });
    expect(context.next).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/' + VIDEO.length);
    expect(res.headers.get('Cache-Control')).toBe(VIDEO_CACHE);
    expect((await bytes(res)).equals(VIDEO.subarray(0, 2))).toBe(true);
  });
});

describe('the edge cache keeps what Vercel\'s CDN kept, and nothing else', () => {
  const KEY = SITE + '/__edge-cache/test';
  const answer = (status, cacheControl, extra = {}) => () => new Response('body ' + status, {
    status, headers: cacheControl ? { 'Cache-Control': cacheControl, ...extra } : extra,
  });

  test('a 200 with s-maxage is kept for that long and comes back with its own headers', async () => {
    const produce = jest.fn(answer(200, 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600', { Vary: 'User-Agent', 'X-Robots-Tag': 'noindex' }));
    let context = pagesContext(SITE + '/x');
    const first = await edgeCached(context, KEY, produce);
    await context.settled();
    expect(await first.text()).toBe('body 200');
    const stored = new Headers(global.caches.default.store.get(KEY).headers);
    expect(stored.get('Cache-Control')).toBe('public, max-age=600');
    expect(stored.get('Vary')).toBeNull();

    context = pagesContext(SITE + '/x');
    const second = await edgeCached(context, KEY, produce);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(await second.text()).toBe('body 200');
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=600, stale-while-revalidate=3600');
    expect(second.headers.get('Vary')).toBe('User-Agent');
    expect(second.headers.get('X-Robots-Tag')).toBe('noindex');
    expect([...second.headers.keys()].filter((name) => name.startsWith('x-flock'))).toEqual([]);
  });

  test('no-store, no s-maxage, s-maxage=0 and anything but a 200 are never kept', async () => {
    const makers = [
      answer(200, 'private, no-store, max-age=0'),
      answer(200, 'public, max-age=3600'),
      answer(200, 'public, s-maxage=0'),
      answer(200, undefined),
      answer(404, 'public, s-maxage=600'),
      answer(503, 'public, max-age=0, s-maxage=600'),
    ];
    for (const make of makers) {
      const context = pagesContext(SITE + '/x');
      await edgeCached(context, KEY, make);
      await context.settled();
    }
    expect(global.caches.default.put).not.toHaveBeenCalled();
  });

  test('HEAD reads the cache but never fills it; other methods never touch it', async () => {
    const produce = jest.fn(answer(200, 'public, s-maxage=600'));
    const call = async (method) => {
      const context = pagesContext(SITE + '/x', { method });
      const res = await edgeCached(context, KEY, produce);
      await context.settled();
      return res;
    };
    await call('HEAD');
    expect(global.caches.default.store.size).toBe(0);
    await call('GET');
    expect(global.caches.default.store.size).toBe(1);
    await call('HEAD');
    expect(produce).toHaveBeenCalledTimes(2);
    const matches = global.caches.default.match.mock.calls.length;
    await call('POST');
    expect(produce).toHaveBeenCalledTimes(3);
    expect(global.caches.default.match.mock.calls.length).toBe(matches);
  });
});

describe('the node adapter runs an api/ handler unchanged', () => {
  test('statusCode, setHeader, getHeader, removeHeader and end become a Response', async () => {
    const res = await runNodeHandler((req, r) => {
      r.statusCode = 201;
      r.setHeader('X-One', 'a');
      r.setHeader('X-List', ['b', 'c']);
      r.setHeader('X-Gone', 'd');
      r.removeHeader('X-Gone');
      expect(r.getHeader('x-one')).toBe('a');
      expect(r.getHeader('X-Missing')).toBeUndefined();
      r.end('hello ' + req.url);
      r.end('a second end is ignored');
    }, { method: 'GET', url: '/api/x?y=1', query: { y: '1' }, headers: {} });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-List')).toBe('b, c');
    expect(res.headers.get('X-Gone')).toBeNull();
    expect(await res.text()).toBe('hello /api/x?y=1');
  });

  test('status().json(), Buffer bodies, and a handler that returns without ending', async () => {
    let res = await runNodeHandler((req, r) => r.status(503).json({ error: 'x' }), {});
    expect([res.status, res.headers.get('Content-Type'), await res.text()]).toEqual([503, 'application/json; charset=utf-8', '{"error":"x"}']);
    res = await runNodeHandler((req, r) => {
      r.setHeader('Content-Type', 'application/json');
      r.status(200).json([1]);
    }, {});
    expect(res.headers.get('Content-Type')).toBe('application/json');
    res = await runNodeHandler((req, r) => r.end(Buffer.from([1, 2, 3])), {});
    expect((await bytes(res)).equals(Buffer.from([1, 2, 3]))).toBe(true);
    res = await runNodeHandler(async (req, r) => { r.statusCode = 204; }, {});
    expect([res.status, await res.text()]).toEqual([204, '']);
  });

  test('a handler that throws rejects, which hands the request to the static fallback', async () => {
    await expect(runNodeHandler(() => { throw new Error('boom'); }, {})).rejects.toThrow('boom');
    await expect(runNodeHandler(async () => { throw new Error('later'); }, {})).rejects.toThrow('later');
  });
});
