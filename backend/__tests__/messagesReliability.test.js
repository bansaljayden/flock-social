// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES RELIABILITY — routes/messages.js history reads, pagination, parity
// ─────────────────────────────────────────────────────────────────────────────
//
// The chat history endpoints paged on one key and sorted on another. The cursor
// was `id < before` (id: SERIAL, unique, monotone with arrival) but the sort
// was `created_at DESC` (TIMESTAMP DEFAULT NOW(): transaction-start time, no
// uniqueness). Two keys, two failure shapes:
//
//   * A burst of sends ties on created_at. Tie order is UNSPECIFIED, so the
//     LIMIT boundary could split the tie one way on page 1 and the other way
//     on page 2 — the same message on both pages, or on neither.
//   * Two concurrent transactions can commit with timestamps in the opposite
//     order to their ids. A row stamped older than everything on page 1 but
//     carrying an id ABOVE the cursor fails `id < before` on every later page:
//     not misplaced — invisible forever.
//
// Fixed by sorting on the cursor column itself (ORDER BY id DESC), which is
// also what makes a message arriving BETWEEN two page fetches harmless: it
// always takes a higher id, so no cursor page it is not on can shift.
//
// Second defect: messages.sender_id is ON DELETE SET NULL, and in SQL
// `NOT (NULL = ANY(nonempty_array))` evaluates to NULL, which WHERE discards.
// So a deleted member's messages vanished from flock history — but only for
// viewers holding at least one block relationship anywhere in the app (an
// empty array compares FALSE, and NOT FALSE keeps the row). Two members of the
// same flock saw two different histories.
//
// These tests INTERPRET the SQL the route actually issues (ordering, cursor,
// three-valued ANY() logic, LIMIT) rather than replaying the answer the route
// wants — the same discipline queryReliability.test.js writes down for its DM
// fixture: "a fixture that models what you meant instead of what you wrote
// tests nothing." Where tie order is unspecified, the fixture chooses the
// LEGAL order that is most hostile to the query, because Postgres is allowed
// to.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'messages-reliability-test-secret';

const pool = require('../config/database');

// ── Fixture dispatcher (same shape as queryReliability.test.js) ──────────────
let handlers = [];
let log = [];

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    return dispatch(sql, params);
  },
  release: () => {},
});

function on(re, fn) { handlers.push([re, fn]); }

// ── Module stubs, installed BEFORE the router is required ────────────────────
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });

const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => ({ allowed: true });

const messagesRouter = require('../routes/messages');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.set('io', null);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// ═════════════════════════════════════════════════════════════════════════════
// SQL interpreters
// ═════════════════════════════════════════════════════════════════════════════

// Sort DESC on created_at with UNSPECIFIED tie order, modelled hostilely: among
// equal timestamps the fixture returns ASCENDING ids, which Postgres is fully
// entitled to do (a heap scan in insertion order under a top-N sort does
// exactly this). A query that needs a particular tie order has to ask for it.
function hostileTimeSortDesc(rows, tiebreakIdDesc) {
  return [...rows].sort((a, b) => {
    const t = new Date(b.created_at) - new Date(a.created_at);
    if (t !== 0) return t;
    return tiebreakIdDesc ? b.id - a.id : a.id - b.id;
  });
}

// GET /api/flocks/:id/messages — understands both the shipped single-statement
// query and the two legacy branches, so reverting the route makes these tests
// fail on BEHAVIOUR, not on an unmatched fixture.
function scriptFlockHistory(corpus, { invisibleIds = [] } = {}) {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/,
    () => ({ rows: [{ id: 99 }], rowCount: 1 }));
  on(/blocked_id AS id FROM user_blocks/,
    () => ({ rows: invisibleIds.map((id) => ({ id })), rowCount: invisibleIds.length }));

  on(/FROM messages m LEFT JOIN users u/, (p, sql) => {
    let flockId, before, limit, invisible;
    if (sql.includes('($2::int IS NULL OR m.id < $2)') || sql.includes('m.id < $2')) {
      [flockId, before, limit, invisible] = p;
    } else {
      [flockId, limit, invisible] = p; before = null;
    }
    const inv = (invisible || []).map(Number);
    const nullGuard = sql.includes('m.sender_id IS NULL OR');
    const filtersHidden = sql.includes('is_hidden IS NOT TRUE');
    const filtersBlocks = sql.includes('= ANY(');

    let rows = corpus.filter((m) => {
      if (m.flock_id !== Number(flockId)) return false;
      if (before != null && !(m.id < Number(before))) return false;
      if (filtersHidden && m.is_hidden) return false;
      if (filtersBlocks) {
        if (m.sender_id == null) {
          // Postgres three-valued logic: NOT (NULL = ANY(nonempty)) is NULL,
          // and WHERE drops NULL. Empty array compares FALSE; NOT FALSE keeps.
          if (!nullGuard && inv.length > 0) return false;
        } else if (inv.includes(m.sender_id)) {
          return false;
        }
      }
      return true;
    });

    rows = /ORDER BY m\.id DESC/.test(sql)
      ? [...rows].sort((a, b) => b.id - a.id)
      : hostileTimeSortDesc(rows, /created_at DESC, m\.id DESC/.test(sql));
    rows = rows.slice(0, Number(limit));
    return {
      rows: rows.map((m) => ({
        ...m,
        sender_name: m.sender_id == null ? null : `User${m.sender_id}`,
        sender_image: null,
      })),
      rowCount: rows.length,
    };
  });

  on(/FROM emoji_reactions er JOIN users u/, (p) => {
    const wanted = new Set((p[0] || []).map(Number));
    const rows = corpus
      .flatMap((m) => (m.reactionRows || []).map((r) => ({ message_id: m.id, ...r })))
      .filter((r) => wanted.has(r.message_id))
      .map((r) => ({ ...r, user_name: `User${r.user_id}` }));
    return { rows, rowCount: rows.length };
  });
}

// GET /api/dm/:userId — same treatment for the DM thread.
function scriptDmThread(corpus, { blockedPair = false } = {}) {
  on(/SELECT 1 FROM user_blocks/, () => (blockedPair ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }));

  // Reply-preview hydration FIRST: it also matches "FROM direct_messages dm
  // JOIN users u", so it must be distinguished by its ANY($1) shape.
  on(/dm\.id = ANY\(\$1\)/, (p, sql) => {
    const wanted = new Set((p[0] || []).map(Number));
    const [, me, other] = [null, Number(p[1]), Number(p[2])];
    const filtersHidden = /COALESCE\(dm\.is_hidden, false\) = false/.test(sql) || /COALESCE\(is_hidden, false\) = false/.test(sql);
    const rows = corpus
      .filter((m) => wanted.has(m.id))
      .filter((m) => !(filtersHidden && m.is_hidden))
      .filter((m) => (m.sender_id === me && m.receiver_id === other) || (m.sender_id === other && m.receiver_id === me))
      .map((m) => ({ id: m.id, message_text: m.message_text, sender_name: `User${m.sender_id}` }));
    return { rows, rowCount: rows.length };
  });

  on(/FROM direct_messages dm JOIN users u ON u\.id = dm\.sender_id/, (p, sql) => {
    const me = Number(p[0]);
    const other = Number(p[1]);
    let before = null;
    let limit;
    if (sql.includes('($3::int IS NULL OR dm.id < $3)') || sql.includes('dm.id < $3')) {
      before = p[2]; limit = p[3];
    } else {
      limit = p[2];
    }
    const filtersHidden = /COALESCE\(dm\.is_hidden, false\) = false/.test(sql);

    let rows = corpus.filter((m) => {
      const inPair = (m.sender_id === me && m.receiver_id === other) || (m.sender_id === other && m.receiver_id === me);
      if (!inPair) return false;
      if (filtersHidden && m.is_hidden) return false;
      if (before != null && !(m.id < Number(before))) return false;
      return true;
    });
    rows = /ORDER BY dm\.id DESC/.test(sql)
      ? [...rows].sort((a, b) => b.id - a.id)
      : hostileTimeSortDesc(rows, /created_at DESC, dm\.id DESC/.test(sql));
    rows = rows.slice(0, Number(limit));
    return {
      rows: rows.map((m) => ({ ...m, sender_name: `User${m.sender_id}`, sender_image: null })),
      rowCount: rows.length,
    };
  });

  on(/FROM dm_emoji_reactions dr JOIN users u/, (p) => {
    const wanted = new Set((p[0] || []).map(Number));
    const rows = corpus
      .flatMap((m) => (m.reactionRows || []).map((r) => ({ dm_id: m.id, ...r })))
      .filter((r) => wanted.has(r.dm_id))
      .map((r) => ({ ...r, user_name: `User${r.user_id}` }));
    return { rows, rowCount: rows.length };
  });

  // Mark-as-read sweep — MUTATES the corpus, honouring exactly the predicate
  // the statement carries: if a hidden filter were added to this UPDATE, the
  // fixture would leave hidden rows unread and the unhide test below would say
  // so.
  on(/UPDATE direct_messages SET read_status = TRUE WHERE sender_id = \$1 AND receiver_id = \$2/, (p, sql) => {
    const filtersHidden = /COALESCE\(is_hidden, false\) = false/.test(sql);
    let n = 0;
    for (const m of corpus) {
      if (m.sender_id !== Number(p[0]) || m.receiver_id !== Number(p[1]) || m.read_status) continue;
      if (filtersHidden && m.is_hidden) continue;
      m.read_status = true;
      n += 1;
    }
    return { rows: [], rowCount: n };
  });
}

// GET /api/dm — the conversation list, with the same hostile tie modelling on
// the DISTINCT ON pick.
function scriptDmList(corpus, { invisibleIds = [] } = {}) {
  on(/blocked_id AS id FROM user_blocks/,
    () => ({ rows: invisibleIds.map((id) => ({ id })), rowCount: invisibleIds.length }));

  on(/DISTINCT ON \(other_id\)/, (p, sql) => {
    const [me, invisible, limit] = p;
    const hiddenPartners = new Set(sql.includes('NOT (other_id = ANY($2::int[]))') ? (invisible || []) : []);
    const innerTiebreak = /ORDER BY other_id, created_at DESC, id DESC/.test(sql);
    const outerTiebreak = /ORDER BY l\.created_at DESC, l\.id DESC/.test(sql);
    const limits = /LIMIT \$3\s*$/.test(sql.trim());

    const latest = new Map();
    for (const m of corpus) {
      if (m.sender_id !== me && m.receiver_id !== me) continue;
      if (m.is_hidden) continue;
      const other = m.sender_id === me ? m.receiver_id : m.sender_id;
      if (hiddenPartners.has(other)) continue;
      const held = latest.get(other);
      if (!held) { latest.set(other, m); continue; }
      const dt = new Date(m.created_at) - new Date(held.created_at);
      // DISTINCT ON keeps the FIRST row of its sort. On a timestamp tie the
      // pick is unspecified without an id tiebreak — model it hostilely: the
      // EARLIER message wins the tie unless the query asks for id DESC.
      if (dt > 0 || (dt === 0 && innerTiebreak && m.id > held.id)) latest.set(other, m);
    }
    let rows = [...latest.values()].sort((a, b) => {
      const t = new Date(b.created_at) - new Date(a.created_at);
      if (t !== 0) return t;
      return outerTiebreak ? b.id - a.id : a.id - b.id;
    });
    if (limits) rows = rows.slice(0, limit);
    rows = rows.map((m) => {
      const other = m.sender_id === me ? m.receiver_id : m.sender_id;
      return {
        id: m.id, message_text: m.message_text, created_at: m.created_at,
        read_status: m.read_status, sender_id: m.sender_id,
        other_id: other, other_name: `User${other}`, other_image: null,
      };
    });
    return { rows, rowCount: rows.length };
  });

  on(/unread_count/, (p, sql) => {
    const scopes = sql.includes('sender_id = ANY($2::int[])');
    const filtersHidden = /COALESCE\(is_hidden, false\) = false/.test(sql);
    const scoped = new Set(p[1] || []);
    const counts = new Map();
    for (const m of corpus) {
      if (m.receiver_id !== p[0] || m.read_status) continue;
      if (filtersHidden && m.is_hidden) continue;
      if (scopes && !scoped.has(m.sender_id)) continue;
      counts.set(m.sender_id, (counts.get(m.sender_id) || 0) + 1);
    }
    return { rows: [...counts].map(([sender_id, unread_count]) => ({ sender_id, unread_count })) };
  });
}

const ids = (res) => res.body.messages.map((m) => m.id);

// ═════════════════════════════════════════════════════════════════════════════
// 1. Flock history pagination — pages must tile exactly
// ═════════════════════════════════════════════════════════════════════════════

// The corpus stages both failure shapes at once: ids 3 and 4 tie on created_at
// across the page-1 boundary, and id 5 carries a timestamp OLDER than that tie
// (a concurrent transaction that grabbed NOW() early and committed late).
// Under the old created_at sort with a hostile-but-legal tie order, page 1 was
// [6,3,4], the client's cursor became 4, and page 2 (`id < 4`) returned
// [3,2,1]: id 3 delivered twice, id 5 delivered never.
function pagedCorpus() {
  return [
    { id: 1, flock_id: 7, sender_id: 2, message_text: 'm1', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:00.000Z' },
    { id: 2, flock_id: 7, sender_id: 3, message_text: 'm2', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:05.000Z' },
    { id: 3, flock_id: 7, sender_id: 2, message_text: 'm3', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:10.000Z' },
    { id: 4, flock_id: 7, sender_id: 3, message_text: 'm4', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:10.000Z' },
    { id: 5, flock_id: 7, sender_id: 2, message_text: 'm5', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:08.000Z' },
    { id: 6, flock_id: 7, sender_id: 3, message_text: 'm6', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:20.000Z' },
  ];
}

test('flock history: pages tile exactly across timestamp ties and id/timestamp inversions', async () => {
  const corpus = pagedCorpus();
  scriptFlockHistory(corpus);

  const page1 = await call('GET', '/api/flocks/7/messages?limit=3');
  assert.strictEqual(page1.status, 200, page1.text);
  assert.strictEqual(page1.body.messages.length, 3);

  // The paging client's cursor: the id of the OLDEST message it received —
  // messages arrive chronological, so that is the first element.
  const cursor = page1.body.messages[0].id;
  const page2 = await call('GET', `/api/flocks/7/messages?limit=3&before=${cursor}`);
  assert.strictEqual(page2.status, 200, page2.text);

  const seen = [...ids(page1), ...ids(page2)].sort((a, b) => a - b);
  assert.deepStrictEqual(seen, [1, 2, 3, 4, 5, 6],
    'every visible message exactly once across the two pages — a duplicate is the tie ' +
    'splitting differently per page, a gap is the cursor filtering on a key the sort ignored');
});

test('flock history: a message arriving between page fetches shifts nothing already paged', async () => {
  const corpus = pagedCorpus();
  scriptFlockHistory(corpus);

  const page1 = await call('GET', '/api/flocks/7/messages?limit=3');
  const cursor = page1.body.messages[0].id;

  // Two sends land while the user scrolls: one normal, one whose timestamp
  // LAGS the whole first page (its transaction started before the fetch).
  corpus.push(
    { id: 7, flock_id: 7, sender_id: 2, message_text: 'live', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:30.000Z' },
    { id: 8, flock_id: 7, sender_id: 3, message_text: 'laggard', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:02.000Z' },
  );

  const page2 = await call('GET', `/api/flocks/7/messages?limit=3&before=${cursor}`);
  const seen = [...ids(page1), ...ids(page2)].sort((a, b) => a - b);
  assert.deepStrictEqual(seen, [1, 2, 3, 4, 5, 6],
    'the cursor page must contain exactly the pre-fetch backlog: new arrivals carry higher ' +
    'ids and belong to a FRESH first page, never spliced into a page already cut');
});

test('flock history: each page arrives chronological and carries a reactions array per message', async () => {
  const corpus = pagedCorpus();
  corpus[5].reactionRows = [{ emoji: '🔥', user_id: 2 }];
  scriptFlockHistory(corpus);

  const res = await call('GET', '/api/flocks/7/messages?limit=50');
  assert.strictEqual(res.status, 200, res.text);
  const order = ids(res);
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'chronological, oldest first');
  assert.ok(res.body.messages.every((m) => Array.isArray(m.reactions)), 'response shape: reactions on every message');
  assert.deepStrictEqual(res.body.messages.find((m) => m.id === 6).reactions.map((r) => r.emoji), ['🔥']);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The deleted-sender / block-filter interaction
// ═════════════════════════════════════════════════════════════════════════════

test('a deleted account\'s messages survive for viewers who hold a block anywhere', async () => {
  const corpus = pagedCorpus();
  corpus.push({ id: 9, flock_id: 7, sender_id: null, message_text: 'from a deleted account', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:40.000Z' });

  // Viewer 1 has blocked user 3 — somewhere, anywhere. Under the old
  // predicate this single fact deleted every null-sender message from their
  // copy of EVERY flock's history, via NOT (NULL = ANY(nonempty)) = NULL.
  scriptFlockHistory(corpus, { invisibleIds: [3] });

  const res = await call('GET', '/api/flocks/7/messages?limit=50');
  assert.strictEqual(res.status, 200, res.text);
  const got = ids(res);
  assert.ok(got.includes(9), 'the deleted account\'s message must not vanish behind the block filter');
  assert.ok(!got.some((id) => [2, 4, 6].includes(id)), 'while the blocked user\'s messages stay gone');
  assert.strictEqual(res.body.messages.find((m) => m.id === 9).sender_name, null,
    'and it renders as an anonymous row, not an error');
});

test('with no blocks at all, the deleted account\'s messages were already visible — pinned so the fix cannot regress the easy case', async () => {
  const corpus = pagedCorpus();
  corpus.push({ id: 9, flock_id: 7, sender_id: null, message_text: 'from a deleted account', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:40.000Z' });
  scriptFlockHistory(corpus, { invisibleIds: [] });

  const res = await call('GET', '/api/flocks/7/messages?limit=50');
  assert.ok(ids(res).includes(9));
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Hidden messages — no resurfacing, no reaction orphans
// ═════════════════════════════════════════════════════════════════════════════

test('a taken-down flock message with reactions: absent from the page, and its id never reaches the reactions query', async () => {
  const corpus = pagedCorpus();
  corpus[2].is_hidden = true; // id 3
  corpus[2].reactionRows = [{ emoji: '👍', user_id: 2 }, { emoji: '🔥', user_id: 3 }];
  scriptFlockHistory(corpus);

  const res = await call('GET', '/api/flocks/7/messages?limit=50');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!ids(res).includes(3), 'hidden message resurfaced through the history read');

  const reactionsQ = log.find((q) => /FROM emoji_reactions/.test(q.sql));
  assert.ok(reactionsQ, 'reactions were fetched for the visible rows');
  assert.ok(!(reactionsQ.params[0] || []).map(Number).includes(3),
    'the hidden message\'s id was handed to the reactions query — its reaction rows ' +
    '(sitting orphaned until an unhide or a delete cascade) must never be read back out');
});

test('a blocked user\'s reaction on a visible third-party message is filtered from the reactions list', async () => {
  const corpus = pagedCorpus();
  // id 5 is from user 2 — a third party neither side of the block.
  corpus[4].reactionRows = [{ emoji: '🔥', user_id: 3 }, { emoji: '👍', user_id: 4 }];
  scriptFlockHistory(corpus, { invisibleIds: [3] });

  const res = await call('GET', '/api/flocks/7/messages?limit=50');
  const msg5 = res.body.messages.find((m) => m.id === 5);
  assert.ok(msg5, 'the third party\'s message itself is visible');
  assert.deepStrictEqual(msg5.reactions.map((r) => r.user_id), [4],
    'the blocked user\'s name and activity leaked through the reactions list');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. DM thread — same paging law, plus reply previews and the read sweep
// ═════════════════════════════════════════════════════════════════════════════

function dmThreadCorpus() {
  // Conversation between 1 and 2, staged like the flock corpus: ids 13/14 tie
  // on created_at, id 15's timestamp lags them.
  return [
    { id: 11, sender_id: 2, receiver_id: 1, message_text: 'd1', message_type: 'text', is_hidden: false, read_status: true, reply_to_id: null, created_at: '2026-08-14T11:00:00.000Z' },
    { id: 12, sender_id: 1, receiver_id: 2, message_text: 'd2', message_type: 'text', is_hidden: false, read_status: true, reply_to_id: null, created_at: '2026-08-14T11:00:05.000Z' },
    { id: 13, sender_id: 2, receiver_id: 1, message_text: 'd3', message_type: 'text', is_hidden: false, read_status: false, reply_to_id: null, created_at: '2026-08-14T11:00:10.000Z' },
    { id: 14, sender_id: 1, receiver_id: 2, message_text: 'd4', message_type: 'text', is_hidden: false, read_status: true, reply_to_id: null, created_at: '2026-08-14T11:00:10.000Z' },
    { id: 15, sender_id: 2, receiver_id: 1, message_text: 'd5', message_type: 'text', is_hidden: false, read_status: false, reply_to_id: null, created_at: '2026-08-14T11:00:08.000Z' },
    { id: 16, sender_id: 1, receiver_id: 2, message_text: 'd6', message_type: 'text', is_hidden: false, read_status: true, reply_to_id: null, created_at: '2026-08-14T11:00:20.000Z' },
  ];
}

test('DM thread: pages tile exactly, including across an id/timestamp inversion', async () => {
  const corpus = dmThreadCorpus();
  scriptDmThread(corpus);

  const page1 = await call('GET', '/api/dm/2?limit=3');
  assert.strictEqual(page1.status, 200, page1.text);
  const cursor = page1.body.messages[0].id;

  // A DM lands mid-scroll; it must not disturb the cursor page.
  corpus.push({ id: 17, sender_id: 2, receiver_id: 1, message_text: 'live', message_type: 'text', is_hidden: false, read_status: false, reply_to_id: null, created_at: '2026-08-14T11:00:30.000Z' });

  const page2 = await call('GET', `/api/dm/2?limit=3&before=${cursor}`);
  const seen = [...ids(page1), ...ids(page2)].sort((a, b) => a - b);
  assert.deepStrictEqual(seen, [11, 12, 13, 14, 15, 16]);
});

test('DM thread: a hidden message is gone, and a reply POINTING at it carries no preview of the taken-down text', async () => {
  const corpus = dmThreadCorpus();
  corpus[0].is_hidden = true; // id 11 taken down
  corpus[0].reactionRows = [{ emoji: '💀', user_id: 2 }];
  corpus[4].reply_to_id = 11; // id 15 quotes the taken-down message
  corpus[5].reply_to_id = 12; // id 16 quotes a visible one
  scriptDmThread(corpus);

  const res = await call('GET', '/api/dm/2?limit=50');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!ids(res).includes(11), 'hidden DM resurfaced in the thread');

  const quoting = res.body.messages.find((m) => m.id === 15);
  assert.strictEqual(quoting.reply_to, undefined,
    'the takedown leaked back out through the reply preview');
  const okQuote = res.body.messages.find((m) => m.id === 16);
  assert.strictEqual(okQuote.reply_to.message_text, 'd2', 'visible reply targets still hydrate');

  const reactionsQ = log.find((q) => /FROM dm_emoji_reactions/.test(q.sql));
  assert.ok(!(reactionsQ.params[0] || []).map(Number).includes(11),
    'the hidden DM\'s reaction rows must never be read back out');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Unread counts — a takedown can never leave a permanent badge
// ═════════════════════════════════════════════════════════════════════════════

test('a hidden unread DM is not counted, and opening the thread sweeps it read so an unhide cannot resurrect a stale badge', async () => {
  const corpus = [
    { id: 21, sender_id: 2, receiver_id: 1, message_text: 'taken down', message_type: 'text', is_hidden: true, read_status: false, reply_to_id: null, created_at: '2026-08-14T12:00:00.000Z' },
    { id: 22, sender_id: 2, receiver_id: 1, message_text: 'hello', message_type: 'text', is_hidden: false, read_status: true, reply_to_id: null, created_at: '2026-08-14T12:00:05.000Z' },
  ];
  scriptDmList(corpus);
  scriptDmThread(corpus);

  const list = await call('GET', '/api/dm');
  assert.strictEqual(list.status, 200, list.text);
  assert.strictEqual(list.body.conversations.length, 1);
  assert.strictEqual(list.body.conversations[0].unread, 0,
    'a hidden message held the unread badge above zero — a badge the user can never clear, ' +
    'because no read surface will ever show them the message behind it');
  assert.strictEqual(list.body.conversations[0].lastMessage, 'hello',
    'and the preview must be the visible message, not the taken-down one');

  // Opening the thread marks the partner's unread messages read — INCLUDING
  // hidden ones. That is deliberate: the count already excludes them, so the
  // sweep costs nothing now, and if a moderator later UNHIDES the message it
  // comes back read instead of resurrecting a badge for a conversation the
  // user has already been through.
  const thread = await call('GET', '/api/dm/2?limit=50');
  assert.strictEqual(thread.status, 200, thread.text);
  assert.strictEqual(corpus[0].read_status, true,
    'the read sweep skipped the hidden row, so an unhide would bring it back as phantom unread');

  corpus[0].is_hidden = false; // moderator reverses the takedown
  log = [];
  const after = await call('GET', '/api/dm');
  assert.strictEqual(after.body.conversations[0].unread, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. DM conversation list — the DISTINCT ON tie
// ═════════════════════════════════════════════════════════════════════════════

test('when a partner\'s last two messages tie on created_at, the preview is the LATER one', async () => {
  const corpus = [
    { id: 31, sender_id: 3, receiver_id: 1, message_text: 'first of the burst', message_type: 'text', is_hidden: false, read_status: true, reply_to_id: null, created_at: '2026-08-14T13:00:00.000Z' },
    { id: 32, sender_id: 3, receiver_id: 1, message_text: 'actually, this instead', message_type: 'text', is_hidden: false, read_status: true, reply_to_id: null, created_at: '2026-08-14T13:00:00.000Z' },
  ];
  scriptDmList(corpus);

  const res = await call('GET', '/api/dm');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.conversations[0].lastMessage, 'actually, this instead',
    'DISTINCT ON with no id tiebreak picks an arbitrary row of the tie — the inbox preview ' +
    'showed a message the sender had already followed up on');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. N+1 — the round trip count must not grow with the page size
// ═════════════════════════════════════════════════════════════════════════════

test('flock history: query count for a 50-message page equals the count for 1 message', async () => {
  const one = [{ id: 1, flock_id: 7, sender_id: 2, message_text: 'm', message_type: 'text', is_hidden: false, created_at: '2026-08-14T10:00:00.000Z', reactionRows: [{ emoji: '🔥', user_id: 2 }] }];
  scriptFlockHistory(one);
  const resOne = await call('GET', '/api/flocks/7/messages?limit=50');
  assert.strictEqual(resOne.status, 200, resOne.text);
  const countForOne = log.length;

  handlers = []; log = [];
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1, flock_id: 7, sender_id: 2 + (i % 3), message_text: `m${i}`, message_type: 'text',
    is_hidden: false, created_at: new Date(Date.UTC(2026, 7, 14, 10, 0, i)).toISOString(),
    reactionRows: [{ emoji: '🔥', user_id: 2 }],
  }));
  scriptFlockHistory(many);
  const resMany = await call('GET', '/api/flocks/7/messages?limit=50');
  assert.strictEqual(resMany.status, 200, resMany.text);
  assert.strictEqual(resMany.body.messages.length, 50);

  assert.strictEqual(log.length, countForOne,
    'a per-message lookup crept back in — reactions and sender profiles are batched');
  assert.ok(countForOne <= 4, `constant part grew: ${countForOne} queries for one message`);
});

test('DM thread: query count for 50 messages with reactions and replies equals the count for 1', async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    id: i + 1, sender_id: i % 2 === 0 ? 2 : 1, receiver_id: i % 2 === 0 ? 1 : 2,
    message_text: `d${i}`, message_type: 'text', is_hidden: false, read_status: false,
    reply_to_id: i > 0 ? i : null, // every message quotes its predecessor
    created_at: new Date(Date.UTC(2026, 7, 14, 11, 0, i)).toISOString(),
    reactionRows: [{ emoji: '🔥', user_id: 2 }],
  }));

  scriptDmThread(mk(1));
  const resOne = await call('GET', '/api/dm/2?limit=100');
  assert.strictEqual(resOne.status, 200, resOne.text);
  const countForOne = log.length;

  handlers = []; log = [];
  scriptDmThread(mk(50));
  const resMany = await call('GET', '/api/dm/2?limit=100');
  assert.strictEqual(resMany.status, 200, resMany.text);
  assert.strictEqual(resMany.body.messages.length, 50);

  // 1 message has no reply target in-thread, so the reply hydration query may
  // legitimately not run for it; allow exactly that one statement of headroom
  // and nothing per-message.
  assert.ok(log.length - countForOne <= 1,
    `query count grew with the page: ${countForOne} for 1 message, ${log.length} for 50`);
  assert.ok(log.length <= 6, `constant part grew: ${log.length} queries for a 50-message page`);
});
