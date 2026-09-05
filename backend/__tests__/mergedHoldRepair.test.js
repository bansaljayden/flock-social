/**
 * A MERGED QUIET ROW WHOSE NEWEST MESSAGE IS GONE IS RE-POINTED, NOT DROPPED
 * (notifications audit, 2026-09-05).
 *
 * The overnight merge keeps only the newest message's id on the held row.
 * When that message was unsent or hidden before morning, contentGoneFor
 * answered "gone" for the whole conversation and the sweep dropped the row.
 * repairMergedHold finds the newest surviving message past the recipient's
 * cursor and swaps the id in, with a body that quotes nothing.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/mergedHoldRepair.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pool = require('../config/database');
const calls = [];
let script = [];
pool.query = async (sql, params) => {
  calls.push({ sql, params });
  const next = script.shift();
  if (!next) throw new Error('unscripted query: ' + sql.slice(0, 80));
  return next;
};

const { repairMergedHold } = require('../services/pushHelper');

test.beforeEach(() => { calls.length = 0; script = []; });

test('newest still visible: nothing to repair, one read', async () => {
  script = [{ rows: [{ gone: false }], rowCount: 1 }];
  const out = await repairMergedHold(7, { type: 'flock_message', flockId: '3', messageId: '90', firstMessageId: '80', merged: true });
  assert.strictEqual(out, null);
  assert.strictEqual(calls.length, 1);
});

test('flock: newest gone, an older held message survives past the cursor: re-pointed with a body that quotes nothing', async () => {
  script = [
    { rows: [{ gone: true }], rowCount: 1 },
    { rows: [{ id: 86 }], rowCount: 1 },
  ];
  const data = { type: 'flock_message', flockId: '3', senderId: '2', messageId: '90', firstMessageId: '80', merged: true };
  const out = await repairMergedHold(7, data);
  assert.deepStrictEqual(out, { body: 'New messages', data: { ...data, messageId: '86' } });
  const survivor = calls[1];
  assert.match(survivor.sql, /FROM messages m/);
  assert.match(survivor.sql, /m\.id >= \$3/);
  assert.match(survivor.sql, /m\.id > COALESCE\(fm\.last_read_message_id, 0\)/);
  assert.match(survivor.sql, /m\.sender_id != \$2/);
  assert.match(survivor.sql, /m\.is_hidden IS NOT TRUE/);
  assert.match(survivor.sql, /m\.sender_deleted_at IS NULL/);
  assert.deepStrictEqual(survivor.params, [3, 7, 80]);
});

test('flock: nothing survives: null, and the sweep drops the row as before', async () => {
  script = [
    { rows: [{ gone: true }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ];
  const out = await repairMergedHold(7, { type: 'flock_message', flockId: '3', messageId: '90', firstMessageId: '80', merged: true });
  assert.strictEqual(out, null);
});

test('dm: newest gone, an older unread one survives: re-pointed at that dm', async () => {
  script = [
    { rows: [{ gone: true }], rowCount: 1 },
    { rows: [{ id: 41 }], rowCount: 1 },
  ];
  const data = { type: 'dm', senderId: '2', dmId: '44', firstDmId: '40', merged: true };
  const out = await repairMergedHold(7, data);
  assert.deepStrictEqual(out, { body: 'New messages', data: { ...data, dmId: '41' } });
  assert.match(calls[1].sql, /FROM direct_messages dm/);
  assert.match(calls[1].sql, /dm\.read_status = FALSE/);
  assert.deepStrictEqual(calls[1].params, [7, 2, 40]);
});

test('a hold that never merged, or has no first id, is left alone', async () => {
  script = [{ rows: [{ gone: true }], rowCount: 1 }];
  const out = await repairMergedHold(7, { type: 'flock_message', flockId: '3', messageId: '90' });
  assert.strictEqual(out, null);
  assert.strictEqual(calls.length, 1, 'no survivor query without a lower bound');
});

test('a failed read repairs nothing rather than throwing into the sweep', async () => {
  script = [{ rows: [{ gone: true }], rowCount: 1 }];
  const out = await repairMergedHold(7, { type: 'flock_message', flockId: '3', messageId: '90', firstMessageId: '80', merged: true });
  assert.strictEqual(out, null);
});

test('the merge remembers that it merged and the first id it held, and the sweep repairs before delivering', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushHelper.js'), 'utf8');
  assert.match(src, /'merged', true,/);
  assert.match(src, /'firstMessageId', COALESCE\(push_outbox\.data->'firstMessageId', push_outbox\.data->'messageId'\)/);
  assert.match(src, /'firstDmId', COALESCE\(push_outbox\.data->'firstDmId', push_outbox\.data->'dmId'\)/);
  assert.match(src, /const repaired = row\.reason === 'quiet' && data\.merged === true/);
  assert.match(src, /repaired \? repaired\.body : row\.body,/);
  assert.match(src, /repaired \? repaired\.data : data,/);
});
