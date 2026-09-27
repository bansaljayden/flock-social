// Run: node --test  (from backend/)
//
// ===========================================================================
// AN EDIT CAN EMPTY A DEAL'S DESCRIPTION.
//
// PUT /api/venue-dashboard/promotions/:id bound the description as
// `description || null` into `COALESCE($2, description)`, so an empty box read
// as "no change". An owner who cleared the description and pressed Save was
// answered 200 with the old text still on the row, and on the venue card.
//
// It matters more now than it did: the Post a Deal card used to send its one
// line as both title and description, and those rows are still out there. The
// venue card and the owner's list hide a description equal to the title, and
// the edit form opens such a deal with the box empty. If the save could not
// clear it, the first retitle would leave the old sentence as the description,
// no longer equal to the new title, and both lists would show it again.
//
// Pinned here, through the real route with the database faked:
//   1. An empty description is bound as '' and the statement turns '' into
//      NULL, so it clears.
//   2. An absent or null description is bound as null and the statement keeps
//      the stored one, as every other field here does.
//   3. Whitespace or markup that sanitizes to nothing clears too, rather than
//      storing an empty-looking string.
// What Postgres makes of the statement (that $2 prepares as one type) is
// __tests__/sqlParameterTypes.test.js's job; that suite reads this statement
// out of the route like every other.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'promotion-description-edit-test-secret';
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.GOOGLE_PLACES_API_KEY;

const pool = require('../config/database');

// Every statement, flattened, with its parameters.
let log = [];
pool.query = async (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  if (/^WITH target AS/.test(flat) && /UPDATE venue_promotions SET/.test(flat)) {
    return { rows: [{ target_hidden: false, id: 2, title: params[0], description: null }], rowCount: 1 };
  }
  if (/FROM venue_profiles WHERE user_id = \$1/.test(flat)) {
    return { rows: [{ id: 1, google_place_id: 'PLACE_A', verified: true }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => ({ query: pool.query, release: () => {} });

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
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

async function edit(body) {
  log = [];
  const res = await fetch(`${base}/api/venue-dashboard/promotions/2`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const update = log.find((q) => /UPDATE venue_promotions SET/.test(q.sql));
  return { status: res.status, update };
}

test('the statement clears on an empty description and keeps on a missing one', async () => {
  const { update } = await edit({ title: 'Two for one before nine' });
  assert.ok(update, 'the edit never reached the database');
  assert.match(update.sql,
    /description = CASE WHEN \$2::text IS NULL THEN description ELSE NULLIF\(\$2::text, ''\) END,/,
    'the description went back to a COALESCE, so an empty box reads as no change');
  assert.doesNotMatch(update.sql, /description = COALESCE\(\$2, description\)/);
  // The other three still mean "no change" when absent or empty.
  assert.match(update.sql, /title = COALESCE\(\$1, title\)/);
  assert.match(update.sql, /time_slot = COALESCE\(\$3, time_slot\)/);
  assert.match(update.sql, /days = COALESCE\(\$4, days\)/);
});

test('an emptied description is sent to the statement as empty, not as "no change"', async () => {
  const r = await edit({ title: 'Two for one before nine', description: '', timeSlot: 'Happy Hour', days: 'Daily' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.update.params[1], '',
    "'' was bound as null, which the statement reads as keep the old description");
});

test('a missing or null description still leaves the stored one alone', async () => {
  const missing = await edit({ title: 'Two for one before nine' });
  assert.strictEqual(missing.status, 200);
  assert.strictEqual(missing.update.params[1], null);

  const nulled = await edit({ title: 'Two for one before nine', description: null });
  assert.strictEqual(nulled.status, 200);
  assert.strictEqual(nulled.update.params[1], null);
});

test('a description that sanitizes to nothing clears, it is not stored as blank text', async () => {
  for (const description of ['   ', '<b></b>', ' <i> </i> ']) {
    const r = await edit({ title: 'Two for one before nine', description });
    assert.strictEqual(r.status, 200, `${JSON.stringify(description)} -> ${r.status}`);
    assert.strictEqual(r.update.params[1], '', `${JSON.stringify(description)} was bound as ${JSON.stringify(r.update.params[1])}`);
  }
});

test('a real description is sent as written', async () => {
  const r = await edit({ title: 'Two for one before nine', description: 'Draft beers and house wine' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.update.params[1], 'Draft beers and house wine');
});
