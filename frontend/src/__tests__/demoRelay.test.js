/**
 * @jest-environment node
 */
/*
 * The website demo's relay (api/demo-relay.js): it forwards the two demo
 * requests to the backend and signs who is asking, so the backend's
 * per-visitor demo limits count people instead of Vercel's edge. What is
 * pinned here: the signature the backend checks (routes/publicCrowd.js
 * visitorKey), that nothing is signed without the secret, that only the two
 * demo paths go through, and that the backend's answer comes back unchanged.
 */
const crypto = require('crypto');

const relay = require('../../api/demo-relay.js');

const SECRET = ['relay', 'unit', 'secret', 'x'.repeat(24)].join('-');

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; },
  };
  return res;
}

function upstreamResponse({ status = 200, body = '{"ok":true}', headers = { 'content-type': 'application/json; charset=utf-8' } } = {}) {
  const buf = Buffer.from(body);
  return {
    status,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(headers, k.toLowerCase()) ? headers[k.toLowerCase()] : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const realFetch = global.fetch;
let calls;

beforeEach(() => {
  calls = [];
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, init });
    return upstreamResponse();
  });
  process.env.RELAY_SIGNING_SECRET = SECRET;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.RELAY_SIGNING_SECRET;
});

function req(url, headers = {}) {
  return { method: 'GET', url, headers: { 'x-real-ip': '203.0.113.7', ...headers } };
}

test('signs the visitor address the backend verifies, and forwards the query', async () => {
  const res = fakeRes();
  await relay(req('/api/demo-relay?path=demo/venues&lat=39.95&lng=-75.16&localHour=21&localDay=5'), res);
  expect(calls).toHaveLength(1);
  const { url, init } = calls[0];
  expect(url).toBe(`${relay.UPSTREAM}/api/public/demo/venues?lat=39.95&lng=-75.16&localHour=21&localDay=5`);
  const h = init.headers;
  expect(h['x-flock-relay-ip']).toBe('203.0.113.7');
  expect(Math.abs(Number(h['x-flock-relay-ts']) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
  const expected = crypto.createHmac('sha256', SECRET).update(`203.0.113.7.${h['x-flock-relay-ts']}`).digest('hex');
  expect(h['x-flock-relay-sig']).toBe(expected);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body.toString()).toBe('{"ok":true}');
});

test('reads the original path when the rewrite left the URL as it was', async () => {
  const res = fakeRes();
  await relay(req('/relay/public/demo/venue/ChIJ_abc-123?localHour=9&localDay=1'), res);
  expect(calls[0].url).toBe(`${relay.UPSTREAM}/api/public/demo/venue/ChIJ_abc-123?localHour=9&localDay=1`);
});

test('without the secret it forwards unsigned, which is the old rewrite', async () => {
  delete process.env.RELAY_SIGNING_SECRET;
  await relay(req('/api/demo-relay?path=demo/venues&lat=1&lng=2'), fakeRes());
  expect(Object.keys(calls[0].init.headers).filter((k) => k.startsWith('x-flock-relay'))).toEqual([]);
  process.env.RELAY_SIGNING_SECRET = 'short';
  await relay(req('/api/demo-relay?path=demo/venues&lat=1&lng=2'), fakeRes());
  expect(Object.keys(calls[1].init.headers).filter((k) => k.startsWith('x-flock-relay'))).toEqual([]);
});

test('an address that does not parse is not signed', async () => {
  await relay(req('/api/demo-relay?path=demo/venues&lat=1&lng=2', { 'x-real-ip': 'unknown', 'x-forwarded-for': 'garbage' }), fakeRes());
  expect(calls[0].init.headers['x-flock-relay-ip']).toBeUndefined();
  expect(relay.clientAddress({ headers: { 'x-forwarded-for': '198.51.100.4, 76.76.21.9' } })).toBe('198.51.100.4');
});

test('only the two demo paths go through, and only as GET', async () => {
  for (const p of ['admin/users', 'demo/venue/..%2F..%2Fadmin', 'demo/venue/a/b', 'demo', '', 'demo/venue/' + 'x'.repeat(600)]) {
    const res = fakeRes();
    await relay(req(`/api/demo-relay?path=${p}`), res);
    expect([p, res.statusCode]).toEqual([p, 404]);
  }
  const post = fakeRes();
  await relay({ ...req('/api/demo-relay?path=demo/venues'), method: 'POST' }, post);
  expect(post.statusCode).toBe(405);
  expect(post.headers.allow).toBe('GET');
  expect(calls).toHaveLength(0);
});

test('the backend answer passes through unchanged, and is never cached at the edge by default', async () => {
  global.fetch = jest.fn(async () => upstreamResponse({
    status: 429,
    body: '{"error":"The live demo is taking a breather. The full thing is in the app."}',
    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' },
  }));
  const res = fakeRes();
  await relay(req('/api/demo-relay?path=demo/venues&lat=1&lng=2'), res);
  expect(res.statusCode).toBe(429);
  expect(res.headers['retry-after']).toBe('60');
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(JSON.parse(res.body.toString()).error).toMatch(/breather/);

  global.fetch = jest.fn(async () => upstreamResponse({ headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } }));
  const cached = fakeRes();
  await relay(req('/api/demo-relay?path=demo/venues&lat=1&lng=2'), cached);
  expect(cached.headers['cache-control']).toBe('public, max-age=30');
});

test('a failed or slow backend reads as the demo resting, never as an address in the log', async () => {
  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  global.fetch = jest.fn(async () => { const e = new Error('connect ECONNREFUSED 203.0.113.7'); e.name = 'TypeError'; throw e; });
  const res = fakeRes();
  await relay(req('/api/demo-relay?path=demo/venues&lat=1&lng=2'), res);
  expect(res.statusCode).toBe(502);
  expect(JSON.parse(res.body).error).toMatch(/breather/);

  global.fetch = jest.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const slow = fakeRes();
  await relay(req('/api/demo-relay?path=demo/venues&lat=1&lng=2'), slow);
  expect(slow.statusCode).toBe(504);

  const logged = errSpy.mock.calls.flat().join(' ');
  expect(logged).not.toMatch(/203\.0\.113\.7/);
  errSpy.mockRestore();
});
