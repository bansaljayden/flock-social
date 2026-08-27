// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE SOCKET CEILING IS SIZED FOR A BAR, NOT FOR A PHONE
// ---------------------------------------------------------------------------
// The handshake limiter keys on the client's public IP, and Flock's audience
// sits behind shared school, dorm and bar NATs, so one bucket is a whole venue.
// At the old ceiling of 10 a minute, one wifi blip at a fifty-person bar meant
// most of five minutes with no realtime for the whole room, silently: the
// client retries forever, the first ten win, and the bucket refills at ten a
// minute. Nothing on any screen says why chat stopped moving.
//
// So two properties, and both directions matter:
//
//   * The ceiling stays venue-sized. 200/minute matches the main API limiter
//     (3000 per 15 minutes); opening a socket must not be scarcer than calling
//     the REST API two hundred times. A later "tidy" that reverts it to a
//     small number reintroduces the collective lockout.
//   * Dev bypasses it, and ONLY dev. Every express limiter has the same isDev
//     passthrough; the socket one never did, which is how five local test
//     browsers sharing 127.0.0.1 starved each other. But the bypass must stay
//     keyed on the same isDev the others use, never on anything a request can
//     influence.
//
// These read the source with comments stripped, because this section of
// server.js now discusses both numbers at length in prose, and a scan that
// cannot tell code from a comment reports whatever the prose says. That
// mistake has defeated six guards in this repository so far.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function stripComments(src) {
  const s = src.split('\r').join('');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i += 1;
      while (i < s.length) {
        out += s[i];
        if (s[i] === '\\') { out += s[i + 1] || ''; i += 2; continue; }
        if (s[i] === q) { i += 1; break; }
        if (q !== '`' && s[i] === '\n') break;
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

const SRC = stripComments(RAW);

test('the stripper still tells code from prose (canary)', () => {
  const out = stripComments('// const maxConnections = 10;\nconst real = 1;');
  assert.ok(!out.includes('maxConnections'), 'a commented-out ceiling would be read as the ceiling');
  assert.ok(out.includes('const real = 1;'));
});

test('the ceiling is declared once, named, and venue-sized', () => {
  const m = SRC.match(/const SOCKET_HANDSHAKES_PER_MINUTE = (\d+);/);
  assert.ok(m, 'SOCKET_HANDSHAKES_PER_MINUTE is gone; the ceiling is back to an inline magic number');
  const ceiling = Number(m[1]);
  // 200 is the decision, made 2026-08-26 and recorded at the declaration. The
  // assertion is a floor rather than an equality so a deliberate future raise
  // does not break a test, while any quiet slide back toward 10 does.
  assert.ok(ceiling >= 120,
    `${ceiling}/minute per shared NAT is a whole-venue lockout again: one wifi blip at a bar `
    + 'and the room waits minutes for realtime to come back, with nothing on screen saying why');
});

test('the limiter reads the named constant, not its own number', () => {
  const at = SRC.indexOf('const maxConnections =');
  assert.ok(at > -1, 'the limiter no longer declares maxConnections at all');
  const line = SRC.slice(at, SRC.indexOf(';', at));
  assert.match(line, /SOCKET_HANDSHAKES_PER_MINUTE/,
    'maxConnections is an inline number again, so the declaration above is decorative');
});

test('dev bypasses the socket limiter the same way every express limiter does', () => {
  // The bypass has to be the FIRST thing inside the limiter middleware, before
  // any per-IP state is touched.
  const at = SRC.indexOf('io.use((socket, next) => {\n  if (isDev) return next();');
  const atCrlf = SRC.indexOf('io.use((socket, next) => {');
  assert.ok(at > -1 || (atCrlf > -1 && /io\.use\(\(socket, next\) => \{\s*if \(isDev\) return next\(\);/.test(SRC)),
    'the socket limiter has no dev bypass, so local multi-browser work starves itself while every express limiter passes through');
});

test('the bypass is keyed on isDev and nothing else', () => {
  // isDev is NODE_ENV === 'development', set once at boot. The one wrong
  // version of this bypass is one a request can influence.
  const decl = SRC.match(/const isDev = ([^;]+);/);
  assert.ok(decl, 'isDev is gone');
  assert.match(decl[1], /process\.env\.NODE_ENV === 'development'/,
    'isDev is no longer the boot-time environment check the other limiters trust');
  // And the limiter must not consult headers, query or auth to decide.
  const from = SRC.indexOf('if (isDev) return next();');
  const body = SRC.slice(from, SRC.indexOf('io.use(authenticateSocket)', from));
  assert.ok(!/handshake\.(query|auth)\b[^\n]*next\(\)/.test(body.split('const ip =')[0]),
    'something request-controlled decides the bypass');
});

test('a refused handshake still does not consume the window (the round 9 rule)', () => {
  // Counting the rejection kept the window permanently full, so a client that
  // tripped the limit could never recover inside the minute. The raise must
  // not silently lose that: the refusal path returns BEFORE the push.
  const at = SRC.indexOf('if (timestamps.length >= maxConnections)');
  assert.ok(at > -1, 'the refusal check is gone');
  const after = SRC.slice(at, at + 400);
  const refuse = after.indexOf('return next(new Error');
  const record = after.indexOf('timestamps.push(now)');
  assert.ok(refuse > -1 && record > -1 && refuse < record,
    'the refusal records the attempt, so a limited client can never recover inside the window');
});
