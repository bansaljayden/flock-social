// Run: node --test __tests__/bannedAccountSurfaces.test.js  (from backend/)
//
// A BANNED ACCOUNT IS GONE FROM EVERY SURFACE (UGC-loop audit, 2026-09-05).
// The profile card, stories, the push gate and the promotions read already
// treated a ban as a removal; the review reads, the roster previews, the DM
// inbox and the DM send door did not. Source pins for each, plus the one
// behavioural check: getInvisibleUserIds now answers banned ids too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('every venue_reviews read drops a banned author', () => {
  const src = read('routes/venueDashboard.js');
  const reads = src.match(/FROM venue_reviews vr[\s\S]{0,420}/g) || [];
  assert.strictEqual(reads.length, 5, `expected five review reads, found ${reads.length}`);
  for (const r of reads) {
    assert.ok(/u\.is_banned IS NOT TRUE|bu\.is_banned IS TRUE/.test(r), `a review read admits a banned author:\n${r}`);
  }
});

test('the roster previews, the socket send door and the REST send door refuse a banned account', () => {
  assert.match(read('routes/flocks.js'), /JOIN users mu ON mu\.id = mfm\.user_id AND mu\.is_banned IS NOT TRUE/);
  assert.match(read('sockets/handlers.js'), /SELECT id, name FROM users WHERE id = \$1 AND is_banned IS NOT TRUE/);
  // Every DM door asks hasDmRelationship; a banned counterpart answers no.
  const rel = read('utils/relationships.js');
  assert.strictEqual((rel.match(/NOT EXISTS \(SELECT 1 FROM users bu WHERE bu\.id = \$2 AND bu\.is_banned IS TRUE\)/g) || []).length, 2);
});

test('getInvisibleUserIds answers banned accounts beside blocks, and never the caller', async () => {
  const { getInvisibleUserIds } = require('../utils/blocks');
  const seen = [];
  const db = { query: async (sql, params) => { seen.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: [{ id: 4 }, { id: 9 }] }; } };
  const ids = await getInvisibleUserIds(7, db);
  assert.deepStrictEqual(ids, [4, 9]);
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0].sql, /UNION SELECT id FROM users WHERE is_banned IS TRUE AND id <> \$1/);
  assert.deepStrictEqual(seen[0].params, [7]);
});
