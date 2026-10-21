// Run: node --test  (from backend/)
//
// A VENUE'S EVENTS ON ITS CARD, ON A REAL DATABASE (2026-10-20).
//
// GET /api/venue-dashboard/public-events/:placeId fills the "Happening here"
// list on the venue card. Until it existed a venue event reached its owner and
// nobody else, and the dashboard said so. Every rule the read applies is SQL,
// so it is walked here through the real venue, report and admin routers on an
// embedded Postgres with every migration applied:
//
//   - only the events of a VERIFIED owner, written on that owner's own claim
//     on this place, and never those of a banned owner;
//   - a moderator's takedown and the owner's delete both take an event off;
//   - only a real calendar date that has not gone by, soonest first;
//   - an event about drinks only for an account we know is 21;
//   - a report takes the event off the reporter's card at once, and a
//     moderator's hide takes it off everyone's;
//   - the owner's own list says which of its events people can see, by the
//     same rules, and the editor's dates are checked without turning away the
//     free text an older app still sends.
//
// No migration: 019 gave venue_events its is_hidden column and made
// 'venue_event' a reportable content type, and 001 already has every column
// this read touches.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('venuePublicEventsRealDb');
const DB_NAME = 'flock_venue_public_events_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-venue-public-events';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;
delete process.env.VENUE_BILLING_ENABLED;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let seq = 0;
let placeSeq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-venue-public-events-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'venuePublicEventsRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/venue-dashboard', require('../routes/venueDashboard'));
  app.use('/api', require('../routes/moderation'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Dates on the real clock, because the route judges "upcoming" on it.
const DAY_MS = 24 * 60 * 60 * 1000;
const dayAhead = (n) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
const TODAY_UTC = () => new Date().toISOString().slice(0, 10);
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const AGE_30 = `${new Date().getUTCFullYear() - 30}-01-01`;

const newPlace = () => { placeSeq += 1; return `ChIJpublicEvents${String(placeSeq).padStart(6, '0')}`; };

async function user(name, { role = 'user', dob = null } = {}) {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, role, date_of_birth) VALUES ($1, 'x', $2, true, $3, $4) RETURNING *`,
    [`events${seq}.${Date.now()}@example.com`, name, role, dob]
  );
  return { ...u, token: signUserToken(u) };
}

async function venue(name, place, { verified = true } = {}) {
  const owner = await user(name, { role: 'venue_owner' });
  await pool.query(
    'INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, $2, $3, $4)',
    [owner.id, name, place, verified]
  );
  return owner;
}

// Written straight into the table, so a test controls the date, the order of
// creation and the flags an owner cannot set through the editor.
async function event(owner, place, title, eventDate, extra = {}) {
  const { rows: [e] } = await pool.query(
    `INSERT INTO venue_events (venue_user_id, google_place_id, title, event_date, event_time, is_hidden, owner_deleted_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW())) RETURNING *`,
    [owner.id, place, title, eventDate, extra.time ?? null, extra.hidden ?? false, extra.deletedAt ?? null, extra.createdAt ?? null]
  );
  return e;
}

async function call(method, url, who, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, body: json };
}

async function card(who, place) {
  const r = await call('GET', `/api/venue-dashboard/public-events/${place}`, who);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.events;
}
const titles = (events) => events.map((e) => e.title);

test('only upcoming events with a real date reach the card, soonest first', async () => {
  const place = newPlace();
  const owner = await venue('The Calendar Bar', place);
  const viewer = await user('Viewer');
  const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await event(owner, place, 'Trivia', dayAhead(3), { time: '8 PM', createdAt: earlier });
  await event(owner, place, 'Karaoke', dayAhead(1), { time: '9 PM' });
  // Same day as Trivia, written after it, and on earlier.
  await event(owner, place, 'Comedy hour', dayAhead(3), { time: '6:00 pm' });
  // Same day again, with a time nobody can order: after the readable ones.
  await event(owner, place, 'Late set', dayAhead(3), { time: 'doors whenever', createdAt: earlier });
  await event(owner, place, 'Tonight', TODAY_UTC());
  await event(owner, place, 'Last week', dayAhead(-7));
  await event(owner, place, 'Typed by hand', 'Friday');
  await event(owner, place, 'Not a day', `${NEXT_YEAR}-02-30`);
  await event(owner, place, 'Taken down', dayAhead(2), { hidden: true });
  await event(owner, place, 'Deleted', dayAhead(2), { deletedAt: new Date().toISOString() });
  await event(owner, newPlace(), 'Somewhere else', dayAhead(2));

  const events = await card(viewer, place);
  assert.deepStrictEqual(titles(events), ['Tonight', 'Karaoke', 'Comedy hour', 'Trivia', 'Late set']);
  // What a card needs and nothing about the owner: no account id, no
  // capacity, no flags.
  for (const e of events) assert.deepStrictEqual(Object.keys(e).sort(), ['event_date', 'event_time', 'id', 'title']);
});

test('an unverified claim shows nothing, and only the verified claimant speaks for the place', async () => {
  const place = newPlace();
  const claimant = await venue('Claimant', place, { verified: false });
  const viewer = await user('Viewer2');
  await event(claimant, place, 'Claimant night', dayAhead(4));
  assert.deepStrictEqual(await card(viewer, place), []);

  const realOwner = await venue('Real Owner', place);
  await event(realOwner, place, 'Owner night', dayAhead(4));
  assert.deepStrictEqual(titles(await card(viewer, place)), ['Owner night']);

  // Take the owner's verification away and the place speaks for nobody: the
  // join is on each event's own author, so the claimant's unverified claim
  // does not inherit the badge that just left.
  await pool.query('UPDATE venue_profiles SET verified = false WHERE user_id = $1', [realOwner.id]);
  assert.deepStrictEqual(await card(viewer, place), []);
});

test('a ban takes the owner\'s events off the card with it', async () => {
  const place = newPlace();
  const owner = await venue('Banned Bar', place);
  const viewer = await user('Viewer3');
  await event(owner, place, 'Open mic', dayAhead(2));
  assert.deepStrictEqual(titles(await card(viewer, place)), ['Open mic']);
  await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [owner.id]);
  assert.deepStrictEqual(await card(viewer, place), []);
});

test('an event about drinks reaches only an account we know is 21', async () => {
  const place = newPlace();
  const owner = await venue('Wine Room', place);
  const noDob = await user('No birthday');
  const adult = await user('Adult', { dob: AGE_30 });
  await event(owner, place, 'Quiz night', dayAhead(2), { time: '8 PM' });
  await event(owner, place, 'Wine tasting', dayAhead(3), { time: '7 PM' });
  await event(owner, place, 'Open mic', dayAhead(4), { time: 'happy hour first' });
  assert.deepStrictEqual(titles(await card(noDob, place)), ['Quiz night']);
  assert.deepStrictEqual(titles(await card(adult, place)), ['Quiz night', 'Wine tasting', 'Open mic']);
});

test('a report takes the event off the reporter\'s card at once, and a takedown off everyone\'s', async () => {
  const place = newPlace();
  const owner = await venue('Reported Bar', place);
  const reporter = await user('Reporter');
  const other = await user('Other');
  const admin = await user('Admin', { role: 'admin' });
  const e = await event(owner, place, 'Rude night', dayAhead(5));
  assert.deepStrictEqual(titles(await card(reporter, place)), ['Rude night']);

  // The card's Report control sends exactly this (VenueDetailSheet.js), with
  // no account id: the route finds the author from the row.
  const filed = await call('POST', '/api/reports', reporter, { content_type: 'venue_event', content_id: e.id, reason: 'hate' });
  assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));
  const report = (await pool.query(
    "SELECT id, reported_user_id, status FROM content_reports WHERE content_type = 'venue_event' AND content_id = $1", [e.id]
  )).rows[0];
  assert.ok(report, 'no report row was written');
  assert.strictEqual(report.reported_user_id, owner.id, 'the report must name the event\'s author');

  assert.deepStrictEqual(await card(reporter, place), [], 'the reporter still sees what they reported');
  assert.deepStrictEqual(titles(await card(other, place)), ['Rude night'], 'one report is not a takedown');

  // The owner cannot report their own event.
  assert.strictEqual((await call('POST', '/api/reports', owner, { content_type: 'venue_event', content_id: e.id, reason: 'spam' })).status, 400);

  const hidden = await call('PUT', `/api/admin/reports/${report.id}`, admin, { action: 'hide' });
  assert.strictEqual(hidden.status, 200, JSON.stringify(hidden.body));
  assert.deepStrictEqual(await card(other, place), []);
  assert.strictEqual((await pool.query('SELECT is_hidden FROM venue_events WHERE id = $1', [e.id])).rows[0].is_hidden, true);

  // The owner is told on their own list, which keeps the row and marks it.
  const mine = await call('GET', '/api/venue-dashboard/events', owner);
  const row = mine.body.events.find((x) => x.id === e.id);
  assert.strictEqual(row.hidden_by_moderation, true);
  assert.strictEqual(row.public_status, 'hidden');

  // A restore brings it back for everyone but the person who reported it.
  const restored = await call('PUT', `/api/admin/reports/${report.id}`, admin, { action: 'unhide' });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
  assert.deepStrictEqual(titles(await card(other, place)), ['Rude night']);
  assert.deepStrictEqual(await card(reporter, place), []);
});

test('the owner\'s list says which events people can see, by the card\'s own rules', async () => {
  const place = newPlace();
  const owner = await venue('Status Bar', place);
  const ids = {
    shown: (await event(owner, place, 'Shown', dayAhead(6))).id,
    needsDate: (await event(owner, place, 'Typed', 'next Friday')).id,
    past: (await event(owner, place, 'Gone by', dayAhead(-10))).id,
    hidden: (await event(owner, place, 'Taken down', dayAhead(6), { hidden: true })).id,
    otherPlace: (await event(owner, newPlace(), 'Old listing', dayAhead(6))).id,
  };
  const mine = await call('GET', '/api/venue-dashboard/events', owner);
  assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
  const status = Object.fromEntries(mine.body.events.map((e) => [e.id, e.public_status]));
  assert.deepStrictEqual(
    [status[ids.shown], status[ids.needsDate], status[ids.past], status[ids.hidden], status[ids.otherPlace]],
    ['shown', 'needs_date', 'past', 'hidden', 'other_place']
  );
  // And the card agrees with the one it calls shown.
  const viewer = await user('Viewer6');
  assert.deepStrictEqual(titles(await card(viewer, place)), ['Shown']);

  const waitingPlace = newPlace();
  const waiting = await venue('Waiting Bar', waitingPlace, { verified: false });
  const pending = await event(waiting, waitingPlace, 'Soon', dayAhead(6));
  const theirs = await call('GET', '/api/venue-dashboard/events', waiting);
  assert.strictEqual(theirs.body.events.find((e) => e.id === pending.id).public_status, 'unverified');
});

test('the editor\'s dates: a real day is saved and shown, a day that does not exist is refused, free text still saves', async () => {
  const place = newPlace();
  const owner = await venue('Editor Bar', place);
  const viewer = await user('Viewer7');

  const made = await call('POST', '/api/venue-dashboard/events', owner, { title: 'Jazz night', eventDate: dayAhead(10), eventTime: '9 PM' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.public_status, 'shown');
  assert.deepStrictEqual(titles(await card(viewer, place)), ['Jazz night']);

  // What build 49 and older send: the old text box. Saved as ever, never shown.
  const typed = await call('POST', '/api/venue-dashboard/events', owner, { title: 'Quiz', eventDate: 'this Friday', eventTime: 'doors 9' });
  assert.strictEqual(typed.status, 201, JSON.stringify(typed.body));
  assert.strictEqual(typed.body.public_status, 'needs_date');

  const impossible = await call('POST', '/api/venue-dashboard/events', owner, { title: 'Ghost night', eventDate: `${NEXT_YEAR}-02-30` });
  assert.strictEqual(impossible.status, 400);
  assert.match(impossible.body.error, /does not exist/);
  const far = await call('POST', '/api/venue-dashboard/events', owner, { title: 'Far off', eventDate: dayAhead(400) });
  assert.strictEqual(far.status, 400);
  assert.match(far.body.error, /within the next year/);

  // An edit can give an old free-text event its calendar date, and it shows.
  const dated = await call('PUT', `/api/venue-dashboard/events/${typed.body.id}`, owner, { eventDate: dayAhead(2) });
  assert.strictEqual(dated.status, 200, JSON.stringify(dated.body));
  assert.strictEqual(dated.body.public_status, 'shown');
  assert.deepStrictEqual(titles(await card(viewer, place)), ['Quiz', 'Jazz night']);

  // Retitling an event whose date has gone by sends that date back, and saves.
  const old = await event(owner, place, 'Last month', dayAhead(-30));
  const retitled = await call('PUT', `/api/venue-dashboard/events/${old.id}`, owner, { title: 'Last month, again', eventDate: old.event_date });
  assert.strictEqual(retitled.status, 200, JSON.stringify(retitled.body));
  assert.strictEqual(retitled.body.public_status, 'past');

  // Deleting takes it off the card.
  const del = await call('DELETE', `/api/venue-dashboard/events/${made.body.id}`, owner);
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.deepStrictEqual(titles(await card(viewer, place)), ['Quiz']);
});

test('a deal saved as Weekend, Mon-Fri by an older app still saves and still shows', async () => {
  // The two values left the editor's menus on 2026-10-20. The server never
  // listed them: both fields are free text, so an older app keeps working.
  const place = newPlace();
  const owner = await venue('Taco Bar', place);
  const viewer = await user('Viewer8');
  const made = await call('POST', '/api/venue-dashboard/promotions', owner, { title: 'Two tacos for $5', timeSlot: 'Weekend', days: 'Mon-Fri' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const seen = await call('GET', `/api/venue-dashboard/public-promotions/${place}`, viewer);
  assert.strictEqual(seen.status, 200, JSON.stringify(seen.body));
  const deal = seen.body.promotions.find((p) => p.title === 'Two tacos for $5');
  assert.ok(deal, 'the deal is not on the card');
  assert.strictEqual(deal.time_slot, 'Weekend');
  assert.strictEqual(deal.days, 'Mon-Fri');
  const edited = await call('PUT', `/api/venue-dashboard/promotions/${made.body.id}`, owner, { title: 'Two tacos for $5', timeSlot: 'Weekend', days: 'Mon-Fri' });
  assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
});
