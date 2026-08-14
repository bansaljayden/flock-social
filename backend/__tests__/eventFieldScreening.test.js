// Run: node --test  (from backend/)
//
// ROUND 22 — two handoffs left by the admin-queue work, and they are the same
// defect wearing different clothes: a screen that covers some of a surface, and
// a label that describes a limit that has been lifted.
//
//   1. VENUE EVENT DATE AND TIME PASSED THROUGH NO PROFANITY SCREEN.
//      routes/venueDashboard.js ran rejectIfProfane on `title` alone, on both
//      POST /events and PUT /events. `eventDate` and `eventTime` are FORTY
//      CHARACTERS OF OWNER-TYPED FREE TEXT each — not a DATE column and not a
//      TIME column, which is why "this Friday" and "doors 9, band 10" are the
//      ordinary values — and nothing looked at their content. freeText settled
//      their shape and stripped their markup; that is a different question from
//      what the words say.
//
//      Promotions had EXACTLY this gap closed in round 20: /public-promotions
//      serves time_slot and days to every user who opens the venue card, and
//      only title and description were screened, so "Fri <slur>" was published
//      while the same string in the title was refused. Events did not get the
//      same treatment. The same round also moved the screen onto the STRIPPED
//      string, so `f<b>u</b>ck` cannot use markup to split a word in half.
//
//      HONEST ABOUT URGENCY: venue events are served on no public surface
//      today. GET /events is the owner reading their own rows back. So this is
//      defence for the day an events surface ships — and migration 019 gave
//      venue_events a takedown column and admin.js a venue_event report type
//      for exactly that reason, which is what makes it worth doing properly now
//      rather than urgent in production.
//
//   2. THE CONSOLE'S "(first 280 characters)" LABEL OUTLIVED THE LIMIT.
//      That label was honest only while nothing could show more. GET
//      /api/admin/reports/:id/content now serves the rest, capped at 20,000,
//      with the same admin gate as the per-report image endpoint. A label
//      describing a limitation that no longer exists is a small lie, and it is
//      the same class of defect as a control that cannot succeed — so the label
//      became the control.
//
// No database and no renderer: the routes run against a scripted pg fake, and
// the console is read as text (it is a browser module; it cannot be required
// here, which is the whole reason console and server drift apart). Same two
// idioms __tests__/venueUgcShape.test.js and __tests__/moderationConsoleContract
// .test.js already use.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'event-field-screening-test-secret';
// Billing off, so requireVenueTier is a no-op and nothing stops at a paywall
// that has nothing to do with what is under test.
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.GOOGLE_PLACES_API_KEY;

const pool = require('../config/database');

const ROUTER_FILE = path.join(__dirname, '..', 'routes', 'venueDashboard.js');
const routerSrc = fs.readFileSync(ROUTER_FILE, 'utf8');

// The source of ONE route handler. Without this, a pin on the events edit could
// be satisfied by the promotions edit sitting 150 lines above it in the same
// file — which is precisely the statement this one was matched to.
function routerSrcAt(marker) {
  const start = routerSrc.indexOf(`'${marker}'`);
  assert.notStrictEqual(start, -1, `route ${marker} is gone from routes/venueDashboard.js`);
  const end = routerSrc.indexOf('\nrouter.', start);
  return routerSrc.slice(start, end === -1 ? routerSrc.length : end);
}

// ── Harness ────────────────────────────────────────────────────────────────
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

// Patched BEFORE the router is required: venueDashboard.js calls
// router.use(authenticate) at require time.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Owner', role: 'venue_owner' }; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); }));

test.beforeEach(() => { handlers = []; log = []; });

async function call(method, path_, body) {
  log = [];
  const res = await fetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
// Named rather than anchored on `^(INSERT|UPDATE|DELETE)`: the events UPDATE is
// wrapped in a CTE (see the takedown refusal below), so an anchored pattern
// would stop seeing the one write these assertions exist to forbid.
const WRITES = /INSERT INTO venue_events|UPDATE venue_events|DELETE FROM venue_events/i;

function venueExists() {
  handlers.push([/FROM venue_profiles WHERE user_id/, () => ({
    rows: [{ id: 1, google_place_id: 'PLACE_A', verified: true }],
  })]);
}

function eventWritesSucceed() {
  handlers.push([/INSERT INTO venue_events/, () => ({ rows: [{ id: 9 }], rowCount: 1 })]);
  handlers.push([/UPDATE venue_events/, () => ({ rows: [{ id: 9, target_hidden: false }], rowCount: 1 })]);
}

// The wiring is asserted through the route, so this test does not encode
// content-checker's word list. If the filter ever stops rejecting all three,
// every screening assertion below would silently pass — so refuse to run
// instead of passing vacuously.
const { moderateText } = require('../utils/moderation');
const DIRTY = ['shit', 'fuck', 'bitch'].find((w) => !moderateText(w).allowed);

test('the profanity filter still rejects something, or nothing below means anything', () => {
  assert.ok(DIRTY, 'utils/moderation rejects none of the sample words; every screening test here would pass vacuously.');
  // The other half of the round-20 rule, stated once: moderateText answers
  // allowed:true for a non-string, which is why freeText has to settle the
  // shape before the screen ever runs.
  assert.strictEqual(moderateText([DIRTY]).allowed, true,
    'moderateText now reads arrays; the shape guard is what this screen depends on');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Every owner-typed string on an event is screened
// ═══════════════════════════════════════════════════════════════════════════

const EVENT_TEXT_FIELDS = ['title', 'eventDate', 'eventTime'];

test('a slur in any event text field is a 400 on create, and nothing is written', async () => {
  for (const field of EVENT_TEXT_FIELDS) {
    handlers = [];
    venueExists();
    eventWritesSucceed();
    const res = await call('POST', '/api/venue-dashboard/events', { title: 'Quiz night', [field]: DIRTY });
    assert.strictEqual(res.status, 400, `event ${field} was stored unscreened: ${res.status} ${res.text}`);
    assert.deepStrictEqual(ran(WRITES).map((q) => q.sql), [], `event ${field}: written anyway`);
  }
});

test('a slur in any event text field is a 400 on edit, and nothing is written', async () => {
  for (const field of EVENT_TEXT_FIELDS) {
    handlers = [];
    venueExists();
    eventWritesSucceed();
    const res = await call('PUT', '/api/venue-dashboard/events/9', { [field]: DIRTY });
    assert.strictEqual(res.status, 400, `edited event ${field} was stored unscreened: ${res.status} ${res.text}`);
    assert.deepStrictEqual(ran(WRITES).map((q) => q.sql), [], `edited event ${field}: written anyway`);
  }
});

// The screen has to run on the value AFTER freeText's sanitizer, not before.
// content-checker matches words, so `f<b>u</b>ck` is three unrecognised tokens
// to a screen placed in front of the strip and one rejected word to a screen
// placed behind it. This is the assertion that fails if someone moves the
// rejectIfProfane loop above the validation chain, or reads a raw copy of the
// body instead of the sanitized one.
test('markup cannot split a word in half on any event field, on create or edit', async () => {
  const split = `${DIRTY[0]}<b>${DIRTY.slice(1)}</b>`;
  assert.strictEqual(moderateText(split).allowed, true,
    'the raw markup-split form is already rejected, so this test proves nothing about ordering');
  for (const field of EVENT_TEXT_FIELDS) {
    for (const [method, path_] of [['POST', '/api/venue-dashboard/events'], ['PUT', '/api/venue-dashboard/events/9']]) {
      handlers = [];
      venueExists();
      eventWritesSucceed();
      const body = method === 'POST' ? { title: 'Quiz night', [field]: split } : { [field]: split };
      const res = await call(method, path_, body);
      assert.strictEqual(res.status, 400,
        `${method} ${field}=${split} reached the column: ${res.status} ${res.text}`);
      assert.deepStrictEqual(ran(WRITES).map((q) => q.sql), [], `${method} ${field}: written anyway`);
    }
  }
});

// ── Controls: the screen is not a blanket refusal ──────────────────────────
//
// Without these, "reject everything" would pass every assertion above.
test('an ordinary event still creates, with its date and time intact', async () => {
  venueExists();
  let insert = null;
  handlers.push([/^INSERT INTO venue_events/, (p) => { insert = p; return { rows: [{ id: 9 }] }; }]);
  const res = await call('POST', '/api/venue-dashboard/events', {
    title: 'Quiz night', eventDate: 'this Friday', eventTime: 'doors 9, band 10', capacity: 80,
  });
  assert.strictEqual(res.status, 201, res.text);
  // [venue_user_id, google_place_id, title, event_date, event_time, capacity]
  assert.strictEqual(insert[2], 'Quiz night');
  assert.strictEqual(insert[3], 'this Friday');
  assert.strictEqual(insert[4], 'doors 9, band 10');
  assert.strictEqual(insert[5], 80);
});

test('an ordinary event still edits, and an absent field still means "leave it alone"', async () => {
  venueExists();
  let upd = null;
  handlers.push([/UPDATE venue_events/, (p) => { upd = p; return { rows: [{ id: 9, target_hidden: false }] }; }]);
  const res = await call('PUT', '/api/venue-dashboard/events/9', { eventDate: 'Sat 12 Sep' });
  assert.strictEqual(res.status, 200, res.text);
  // [title, event_date, event_time, capacity, id, venue_user_id]
  assert.strictEqual(upd[0], null, 'an absent title stopped meaning "leave it alone"');
  assert.strictEqual(upd[1], 'Sat 12 Sep');
  assert.strictEqual(upd[2], null);
  assert.ok(!('target_hidden' in res.body), 'the takedown probe column is leaking into the response body');
});

// capacity is an integer, and running an integer through a text screen would be
// a silent 400 on a perfectly good number (moderateText answers allowed:true for
// a non-string today, so this would break only if the screen list grew a field
// that is not text).
test('a numeric capacity is not fed to the text screen', async () => {
  venueExists();
  handlers.push([/^INSERT INTO venue_events/, () => ({ rows: [{ id: 9 }] })]);
  const res = await call('POST', '/api/venue-dashboard/events', { title: 'Quiz night', capacity: 120 });
  assert.strictEqual(res.status, 201, res.text);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. The takedown affordance venue_events got in migration 019, which the
//     owner-facing routes had not caught up with. Both halves are the same
//     defect promotions had fixed in round 18, found while auditing this file
//     for the classes above.
// ═══════════════════════════════════════════════════════════════════════════

// A hidden promotion stays VISIBLE to its author on purpose — it is the owner's
// own copy, and dropping it silently leaves them re-creating something a
// moderator removed. But it has to be MARKED. `SELECT *` handed a taken-down
// event back looking exactly like a running one.
test("a taken-down event is still listed to its author, and is marked as taken down", async () => {
  venueExists();
  handlers.push([/SELECT \* FROM venue_events/, () => ({
    rows: [{ id: 1, title: 'Quiz night', is_hidden: true }, { id: 2, title: 'Open mic', is_hidden: false }],
  })]);
  const res = await call('GET', '/api/venue-dashboard/events');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.events.length, 2, 'the hidden event vanished from its own author’s list');
  assert.strictEqual(res.body.events[0].hidden_by_moderation, true,
    'a taken-down event comes back looking exactly like a running one');
  assert.strictEqual(res.body.events[1].hidden_by_moderation, false);
});

// The old statement updated a hidden row and answered 200 with it: the owner
// retitled an event moderation had removed and was told it saved.
test('an edit to a taken-down event is refused by name, not answered 200', async () => {
  venueExists();
  // The CTE's UPDATE half does not fire on a hidden row, so the outer SELECT
  // returns the target with every `upd` column NULL. That missing row IS the
  // refusal — this is the shape the real statement produces.
  handlers.push([/UPDATE venue_events/, () => ({ rows: [{ target_hidden: true, id: null }] })]);
  const res = await call('PUT', '/api/venue-dashboard/events/9', { title: 'Something else' });
  assert.strictEqual(res.status, 409, `a hidden event was edited and reported as saved: ${res.status} ${res.text}`);
  assert.strictEqual(res.body.code, 'CONTENT_HIDDEN');
  // SLOP-AUDIT.md rule 5: the message must not name a feature that does not
  // exist. Nothing in this codebase emails a content author about a takedown.
  assert.ok(!/email/i.test(res.body.error), 'the refusal points at a notification path that was never built');
});

test('"not yours or gone" stays distinguishable from "taken down"', async () => {
  venueExists();
  handlers.push([/UPDATE venue_events/, () => ({ rows: [] })]);
  const res = await call('PUT', '/api/venue-dashboard/events/9', { title: 'Something else' });
  assert.strictEqual(res.status, 404, res.text);
});

// One statement, so there is no window between reading is_hidden and writing.
test('the refusal is decided inside the write, not by a separate SELECT first', () => {
  const put = routerSrcAt('/events/:id');
  assert.ok(/WITH target AS \(/.test(put),
    'the events edit no longer reads the takedown flag inside the same statement that writes; a SELECT-then-UPDATE can be raced.');
  assert.ok(/EXISTS \(SELECT 1 FROM target t WHERE t\.is_hidden = false\)/.test(put),
    'nothing in the UPDATE stops it firing on a hidden row');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The rule, pinned against the source — including the fields NOT yet added
// ═══════════════════════════════════════════════════════════════════════════

test('the create and update event routes screen the same three fields, in the promotions shape', () => {
  const screens = routerSrc.match(/for \(const field of \['title', 'eventDate', 'eventTime'\]\)/g) || [];
  assert.strictEqual(screens.length, 2,
    'both POST /events and PUT /events must screen title, eventDate and eventTime — an unscreened edit route makes a screened create route decorative.');
  // Matched, not invented: promotions is the file's own precedent and the two
  // must not drift into different spellings of the same rule.
  const promoScreens = routerSrc.match(/for \(const field of \['title', 'description', 'timeSlot', 'days'\]\)/g) || [];
  assert.strictEqual(promoScreens.length, 2, 'the promotions screen this was matched to has changed shape; re-check both.');
});

// THE GENERIC GUARD, and the reason this file is worth more than the two tests
// above. `freeText(body('x'))` is how this router marks a field as "a person
// typed this and another person reads it back". Every one of them must reach a
// screen somewhere in the file. This is what would have caught eventDate and
// eventTime the day they were added, and it is what will catch the next one.
test('every owner-typed field on this router reaches a profanity screen', () => {
  const typed = new Set([...routerSrc.matchAll(/freeText\(body\('(\w+)'\)/g)].map((m) => m[1]));
  assert.ok(typed.size >= 8, `parsed only ${typed.size} freeText fields; the parser is wrong, not the code.`);

  const screened = new Set();
  // The loop form: `for (const field of ['a', 'b']) { ... rejectIfProfane ... }`
  for (const m of routerSrc.matchAll(/for \(const field of \[([^\]]+)\]\)/g)) {
    for (const q of m[1].matchAll(/'([^']+)'/g)) screened.add(q[1]);
  }
  // The single-field form: `rejectIfProfane(res, req.body.reply)` /
  // `rejectIfProfane(res, text)` — the latter destructured just above the call.
  for (const m of routerSrc.matchAll(/rejectIfProfane\(res,\s*(?:req\.body\.)?(\w+)\)/g)) screened.add(m[1]);

  for (const field of typed) {
    assert.ok(screened.has(field),
      `body('${field}') goes through freeText — so it is owner-typed text somebody reads back — and no rejectIfProfane call in routes/venueDashboard.js names it.`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The console: the label became a control
// ═══════════════════════════════════════════════════════════════════════════

const CONSOLE_FILE = path.join(__dirname, '..', '..', 'frontend', 'src', 'website', 'ModerationDashboard.js');
const ADMIN_FILE = path.join(__dirname, '..', 'routes', 'admin.js');
const consoleSrc = fs.readFileSync(CONSOLE_FILE, 'utf8');
const adminSrc = fs.readFileSync(ADMIN_FILE, 'utf8');

test('the server still serves the rest of the words, under the same admin gate', () => {
  assert.ok(/router\.get\('\/reports\/:id\/content'/.test(adminSrc),
    'GET /api/admin/reports/:id/content is gone from routes/admin.js, and the console has a control pointed at nothing.');
  // The three names the console reads off the response. A rename here is a
  // silently blank panel on the one screen a moderator has to trust.
  for (const key of ['text: body', 'clipped: !!clipped', 'totalLength: Number(totalLength)']) {
    assert.ok(adminSrc.includes(key), `the content endpoint no longer answers \`${key}\`; the console reads it.`);
  }
  // Reported UGC, sometimes a minor's words, served to a moderator: it must not
  // sit in a proxy or a browser cache, the same rule the image endpoint follows.
  const contentRoute = adminSrc.slice(adminSrc.indexOf("router.get('/reports/:id/content'"));
  assert.ok(/no-store/.test(contentRoute.slice(0, 3000)), 'the content endpoint stopped setting Cache-Control: no-store.');
});

test('the console no longer claims the excerpt is all a moderator can have', () => {
  assert.ok(!/first 280 characters/.test(consoleSrc),
    'ModerationDashboard.js still labels the excerpt "(first 280 characters)". The endpoint that lifts that limit exists; the label is now a small lie.');
});

test('the full text is fetched with the admin token, not hung off a plain URL', () => {
  assert.ok(
    /adminFetch\(`\/api\/admin\/reports\/\$\{[^}]+\}\/content`\)/.test(consoleSrc),
    'The console must fetch the full text through adminFetch, which sends the Authorization header. A plain URL 401s: the whole admin router is behind a Bearer token.'
  );
  // The image endpoint's own fetch has to survive this change: the two states
  // live side by side on the same card.
  assert.ok(
    /adminFetch\(`\/api\/admin\/reports\/\$\{[^}]+\}\/image`\)/.test(consoleSrc),
    'the per-report image fetch was lost while the text control was added'
  );
});

test('the console renders every field the content endpoint answers with', () => {
  for (const field of ['data.text', 'data.clipped', 'data.totalLength']) {
    assert.ok(consoleSrc.includes(field),
      `ModerationDashboard.js never reads ${field}. \`clipped\` and \`totalLength\` are how the console says what was withheld instead of trailing off.`);
  }
});

// Scoped to the TEXT control's own code, never to the file. Asserting
// `'Try again'` appears in ModerationDashboard.js at all would be satisfied by
// the image block, which has carried that label since it was written — so the
// text control could lose its retry entirely and the test would stay green.
// That is exactly what the sabotage round caught.
function regionBetween(src, startMarker, endMarker, what) {
  const start = src.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `${what}: "${startMarker}" is gone from ModerationDashboard.js`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(end, -1, `${what}: "${endMarker}" is gone from ModerationDashboard.js`);
  return src.slice(start, end);
}

test('the text control mirrors the image control rather than inventing a second pattern', () => {
  // Loading, fetch-failure and retry, all present — the image block's own
  // states. A control that can fail and cannot be retried is the failure the
  // image block was already fixed for once.
  const fn = regionBetween(consoleSrc, 'const toggleText = async (report) => {', 'const markImageBroken', 'toggleText');
  assert.ok(/status: 'loading'/.test(fn),
    'toggleText no longer marks a loading state, so the card sits silent while a fetch is in flight');
  assert.ok(/status: 'error'/.test(fn),
    'a failed full-text fetch no longer lands in an error state the card can render');
  // An empty 200 is a failure to show anything; rendering a blank box under a
  // button that just said "loading" explains nothing.
  assert.ok(/returned no text for this report/.test(fn),
    'a 200 carrying no text is treated as success again');
  // The control has to be reversible. Expanding 20,000 characters of reported
  // UGC with no way to collapse it again buries the action row under the
  // evidence on a 200-row queue.
  assert.ok(/delete next\[report\.id\]/.test(fn),
    'expanding the full text is now one-way; there is no way to collapse it again');
});

test('the full-text button carries every state it can be in', () => {
  const btn = regionBetween(consoleSrc, 'onClick={onToggleText}', '</button>', 'the full-text button');
  for (const [label, why] of [
    ['Show the full text', 'the control has no resting label'],
    ['Show less', 'the expanded control cannot be collapsed from its own button'],
    ['Try again', 'a failed full-text fetch cannot be retried from the card — the image block was already fixed for exactly this'],
  ]) {
    assert.ok(btn.includes(label), `${why} (no "${label}" on the full-text button).`);
  }
});

// ── The swallowed load, found while auditing the same file ─────────────────
//
// `setReports(r.reports || [])` turned a malformed 200 — a proxy page, a gzip
// failure, a redirect to HTML, all of which adminFetch reduces to {} — into an
// empty queue, and an empty queue renders as "Queue is clear." That is the most
// reassuring sentence on the screen and the one it must never say by accident.
// Same class as the strip view in routes/venueDashboard.js, whose round-19 note
// says it in one line: an upstream failure is not an empty result set.
test('a malformed queue response is an error, never an empty queue', () => {
  const fn = regionBetween(consoleSrc, 'const load = useCallback(', 'useEffect(() => { load(); }', 'load');
  assert.ok(/Array\.isArray\(r\.reports\)/.test(fn),
    'the reports list is trusted to be a list again; a malformed 200 renders as "Queue is clear."');
  // Round 24 moved the audit-log read into its own loadLog (the evidence
  // toggle re-reads that list without re-reading the queue), so the shape
  // check is probed where it now lives. The guarded property is unchanged: a
  // malformed 200 must never render as "No actions yet."
  const logFn = regionBetween(consoleSrc, 'const loadLog = useCallback(', 'const load = useCallback(', 'loadLog');
  assert.ok(/Array\.isArray\(a\.actions\)/.test(logFn),
    'the audit log is trusted to be a list again; a malformed 200 renders as "No actions yet."');
  assert.ok(!/setReports\(r\.reports \|\| \[\]\)/.test(fn), 'the `|| []` swallow is back on the reports list');
  assert.ok(!/setActions\(a\.actions \|\| \[\]\)/.test(logFn), 'the `|| []` swallow is back on the audit log');
});

test('neither empty state claims there is nothing to do when the load failed', () => {
  // Belt to the braces above: even if a future change lets an empty list
  // through, the sentence itself is gated on there being no error.
  const src = blankCommentsOnly(consoleSrc);
  for (const [claim, why] of [
    ['Queue is clear.', 'the queue'],
    ['No actions yet.', 'the audit log'],
  ]) {
    const at = src.indexOf(`'${claim}'`);
    assert.notStrictEqual(at, -1, `the "${claim}" empty state is gone; this guard needs updating.`);
    const before = src.slice(Math.max(0, at - 160), at);
    assert.ok(/error \?/.test(before),
      `${why} still prints "${claim}" without first checking whether the load failed. An unread list and an empty list look identical, and only one of them means there is nothing to do.`);
  }
});

// ── The gate: the control must not appear when there is nothing behind it ──
//
// This is the "control that cannot succeed" rule applied to its own fix. When
// content_excerpt_clipped is false the excerpt IS the whole body, so a button
// promising more could only re-render what is already on the screen.
//
// Asserted structurally rather than by proximity: strings and comments are
// blanked (length-preserving, so indices still line up), then the parenthesis
// opened by the gate is balanced, and the button has to fall inside that span.
function blankOut(src, alsoStrings) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? src.length : nl;
      out += ' '.repeat(stop - i); i = stop; continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\') j += 1; j += 1; }
      const stop = Math.min(j + 1, src.length);
      out += alsoStrings
        ? ch + src.slice(i + 1, stop - 1).replace(/[^\n]/g, ' ') + (stop - 1 < src.length ? ch : '')
        : src.slice(i, stop);
      i = stop; continue;
    }
    out += ch; i += 1;
  }
  return out;
}
const blankLiteralsAndComments = (src) => blankOut(src, true);
// Comments blanked, string bodies kept: a prose mention of a sentence in a
// comment must not be mistaken for the code that prints it.
const blankCommentsOnly = (src) => blankOut(src, false);

test('the full-text control is rendered only when the excerpt is actually clipped', () => {
  const blanked = blankLiteralsAndComments(consoleSrc);
  const gate = blanked.indexOf('r.content_excerpt_clipped ? (');
  assert.notStrictEqual(gate, -1,
    'no `r.content_excerpt_clipped ? (` gate in ModerationDashboard.js — the control now renders on reports whose excerpt is already the whole body.');

  // Balance from the `(` the gate opens.
  const open = blanked.indexOf('(', gate + 'r.content_excerpt_clipped ?'.length);
  let depth = 0;
  let end = -1;
  for (let i = open; i < blanked.length; i += 1) {
    if (blanked[i] === '(') depth += 1;
    else if (blanked[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.notStrictEqual(end, -1, 'the gate expression is never closed; this parser needs updating.');

  const span = blanked.slice(open, end);
  // If the blanking ever runs away, the span swallows the rest of the component
  // and this test would pass on anything. The image block is the next thing in
  // the file, so its absence is the proof that it did not.
  assert.ok(!span.includes('content_has_image'),
    'the parsed gate span ran past the excerpt block; this parser needs updating rather than the code.');
  assert.ok(span.includes('onClick={onToggleText}'),
    'the "Show the full text" button is outside the content_excerpt_clipped gate, so it renders on reports where the excerpt is already the whole body — a control that can only re-render what is on the screen.');
});

// ── The control can succeed for every type the queue can render ────────────
//
// The image control is deliberately absent for the four text-only types. The
// TEXT control is not allowed that excuse: every reportable type has words, so
// every one of them needs an entry in both maps behind the endpoint, or the
// button 404s on a card a moderator is being asked to judge.
test('every content type the console can label has full text behind it', () => {
  function topLevelKeys(src, name, file) {
    const head = `const ${name} = {`;
    const start = src.indexOf(head);
    assert.notStrictEqual(start, -1, `${name} not found in ${file}; this guard went with it.`);
    const body = src.slice(start + head.length - 1)
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
    let depth = 0;
    let kept = '';
    for (const ch of body) {
      if (ch === '{') { depth += 1; if (depth === 1) continue; }
      else if (ch === '}') { depth -= 1; if (depth === 0) break; }
      if (depth === 1 && ch !== '{' && ch !== '}') kept += ch;
    }
    return [...kept.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  }

  const labelled = topLevelKeys(consoleSrc, 'TYPE_LABEL', 'ModerationDashboard.js');
  assert.ok(labelled.length >= 8, `parsed only ${labelled.length} TYPE_LABEL keys; the parser is wrong.`);
  const textSources = topLevelKeys(adminSrc, 'REPORT_TEXT_SOURCES', 'routes/admin.js');
  const textSql = topLevelKeys(adminSrc, 'CONTENT_TEXT_SQL', 'routes/admin.js');

  for (const type of labelled) {
    assert.ok(textSources.includes(type),
      `REPORT_TEXT_SOURCES has no "${type}" entry, so "Show the full text" can only ever 404 on a ${type} report.`);
    assert.ok(textSql.includes(type),
      `CONTENT_TEXT_SQL has no "${type}" entry; the endpoint refuses the request before it reads a row.`);
  }
});
