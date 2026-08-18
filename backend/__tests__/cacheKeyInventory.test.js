// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE STANDING CONTROL BEHIND utils/cacheKeyInventory.js
// ---------------------------------------------------------------------------
// A one-time sweep decays the moment somebody adds a map. This is what turns it
// into something that keeps holding: the build fails if a module-scope
// `new Map(` or a `createUserBudget(` appears anywhere in the swept directories
// without a row in the inventory, and it fails the other way too if a row names
// something that no longer exists.
//
// WHY THIS SHAPE OF TEST, rather than another audit. Four rounds found the same
// class of bug — a control whose key or whose denominator the caller partly
// picks — and four fixes each closed the instance that was reported. Round 3
// applied the rule to `place_id` and missed `lat/lng`; it applied it to `/card`
// and missed `/search`. The failure was never the rule, it was that nothing
// forced the rule to be applied to the whole class at once. An inventory that
// the build refuses to let drift is that forcing function.
//
// It deliberately checks PRESENCE and FRESHNESS, not correctness: no test can
// decide whether "the caller controls this half of the key" was reasoned about
// honestly. What it can do is make sure the reasoning EXISTS and is attached to
// the code, so the next round checks an argument instead of rediscovering a
// map.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { INVENTORY, SWEPT, SWEPT_FILES } = require('../utils/cacheKeyInventory');

const BACKEND = path.join(__dirname, '..');

// The message every failure below ends with. It has to say what to DO, because
// the person who trips it is adding a feature, not reading an audit report.
const HOWTO = `
  ────────────────────────────────────────────────────────────────────────────
  ADD YOUR CACHE OR BUDGET TO backend/utils/cacheKeyInventory.js.

  A cache key or a spend counter is a security control, and it is only as good
  as the part of the key the CALLER CANNOT CHOOSE. Four audit rounds in a row
  found a control whose key or denominator the caller partly picked, so a new
  one does not get to land unexamined.

  Copy an existing row and answer these, honestly, in the row itself:

    key             what the key is actually built from
    callerControls  WHICH PART OF THAT THE CALLER PICKS. If the answer is "all
                    of it", the cache is not a control — it is an optimisation
                    the caller can switch off at will, and something else has
                    to be the control.
    protects        the scarce thing behind a MISS: money? a Postgres round
                    trip? an email? a push? milliseconds of the only thread?
    denominator     what your counter counts. If it counts requests and the
                    scarce thing is tokens, bytes or milliseconds, it is
                    counting the wrong noun.
    bound           max entries AND eviction order. Least-consumed-first for
                    anything holding a count (an attacker spends first, then
                    floods, so oldest-first deletes exactly the counter they
                    wanted gone). Never clear().
    verdict         SAFE only if you argued it. OPEN if you found something and
                    are not fixing it here — then write the exploit in "why".
    why             one line the next audit round can CHECK instead of
                    rediscovering your map from scratch.

  Two things to get right that are easy to miss:
    * A budget that refuses a MISS must also refuse the cache WRITE, or the
      caller can still evict real users' entries.
    * Raising the cache size is never the fix. No cache beats an unbounded key
      space.
  ────────────────────────────────────────────────────────────────────────────`;

// ── Sweep ───────────────────────────────────────────────────────────────────

function jsFilesUnder(dir) {
  const abs = path.join(BACKEND, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith('.js'))
    .map((f) => `${dir}/${f}`);
}

const FILES = [...SWEPT.flatMap(jsFilesUnder), ...SWEPT_FILES];

// Module scope only, and that is deliberate: a `new Map()` declared inside a
// request handler dies with the request and is not a shared control. The regex
// is anchored at column zero for exactly that reason, so indentation is the
// discriminator. Factory-internal maps (createUserBudget's own `entries`,
// guest.js's counter factories) are indented and therefore skipped; they are
// listed in the inventory anyway, under names ending "(factory-internal)".
const MAP_DECL = /^const ([A-Za-z_$][\w$]*) = new Map\(/gm;
const BUDGET_DECL = /createUserBudget\(\{[\s\S]{0,200}?name: '([^']+)'/g;

function scan() {
  const maps = [];
  const budgets = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(BACKEND, rel), 'utf8').replace(/\r\n/g, '\n');
    for (const m of src.matchAll(MAP_DECL)) maps.push({ file: rel, name: m[1] });
    for (const m of src.matchAll(BUDGET_DECL)) budgets.push({ file: rel, budgetName: m[1] });
  }
  return { maps, budgets };
}

const listed = new Set(INVENTORY.map((e) => `${e.file}::${e.name}`));

// ── 1. Nothing new may land unenumerated ────────────────────────────────────

test('every module-scope cache in the swept directories is in the inventory', () => {
  const { maps } = scan();
  assert.ok(maps.length > 30,
    'the sweep found almost nothing, which means the scanner is broken rather than the tree being clean');

  const missing = maps.filter((m) => !listed.has(`${m.file}::${m.name}`));
  assert.deepStrictEqual(missing, [],
    `${missing.length} module-scope cache(s) are not in the inventory:\n`
    + missing.map((m) => `    ${m.file}  ->  const ${m.name} = new Map(`).join('\n')
    + '\n' + HOWTO);
});

test('every per-account spend budget in the swept directories is in the inventory', () => {
  const { budgets } = scan();
  assert.ok(budgets.length >= 8,
    'the budget scanner found almost nothing, which means it is broken');

  // Matched on the budget's own `name:` string appearing verbatim in a row for
  // the same file. Deliberately exact rather than fuzzy: a fuzzy match would
  // let a new budget ride in on a similar-looking neighbour's row, which is the
  // "the control exists on paper" failure this whole file is about.
  const missing = budgets.filter(({ file, budgetName }) =>
    !INVENTORY.some((e) => e.file === file && JSON.stringify(e).includes(budgetName)));

  assert.deepStrictEqual(missing, [],
    `${missing.length} createUserBudget instantiation(s) are not in the inventory:\n`
    + missing.map((b) => `    ${b.file}  ->  createUserBudget({ name: '${b.budgetName}' ... })`).join('\n')
    + '\n' + HOWTO);
});

// ── 2. The inventory may not rot the other way either ───────────────────────

test('no inventory row names a cache that has been deleted or renamed', () => {
  const { maps } = scan();
  const live = new Set(maps.map((m) => `${m.file}::${m.name}`));

  // Rows for budgets, factory internals and global day counters are not
  // `new Map(` declarations, so they are checked by file existence only.
  const stale = INVENTORY.filter((e) => {
    if (!fs.existsSync(path.join(BACKEND, e.file))) return true;
    if (e.kind !== 'cache' && e.kind !== 'inflight' && e.kind !== 'table') return false;
    if (e.name.includes('(')) return false;
    return !live.has(`${e.file}::${e.name}`);
  });

  assert.deepStrictEqual(stale.map((e) => `${e.file}::${e.name}`), [],
    'the inventory describes caches that no longer exist. A stale row is worse than '
    + 'no row: the next audit round reasons from a key that is gone, which is exactly '
    + 'what round-4 finding R4-I6 was. Delete the row in the same change that deletes '
    + 'the map.');
});

// ── 3. Every row has to actually say something ──────────────────────────────

test('every inventory row answers the questions, and no row is a shrug', () => {
  const REQUIRED = ['file', 'name', 'kind', 'key', 'callerControls', 'protects',
    'denominator', 'bound', 'verdict', 'why'];
  const VERDICTS = new Set(['SAFE', 'OPEN', 'FIXED-THIS-ROUND']);

  for (const e of INVENTORY) {
    for (const f of REQUIRED) {
      assert.ok(typeof e[f] === 'string' && e[f].length > 0,
        `${e.file}::${e.name} is missing "${f}".\n${HOWTO}`);
    }
    assert.ok(VERDICTS.has(e.verdict),
      `${e.file}::${e.name} has verdict "${e.verdict}"; use SAFE, OPEN or FIXED-THIS-ROUND.`);
    // The `why` line is the whole point of the row — it is what the next round
    // checks instead of re-deriving the map. A one-word "safe" is not that.
    assert.ok(e.why.length >= 40,
      `${e.file}::${e.name} has a "why" too short to be an argument: "${e.why}"\n`
      + 'Say WHY the caller-controlled part of the key cannot be turned into work, '
      + 'or say what it costs.' + HOWTO);
    // An OPEN row is a finding, so it owes the next person an exploit and a
    // recommended fix rather than just a worry.
    if (e.verdict === 'OPEN') {
      assert.ok(/fix:/i.test(e.why),
        `${e.file}::${e.name} is OPEN but names no fix. An OPEN row must carry the `
        + 'exploit AND the recommended fix, so it can be picked up without re-deriving it.');
    }
  }
});

// ── 4. The rule itself, kept where a contributor will read it ───────────────

test('the inventory states the rule the four audit rounds converged on', () => {
  // Comment prefixes and wrapping are stripped first: the rule is a sentence,
  // and a sentence that happens to break across two lines is still the rule.
  const src = fs.readFileSync(path.join(BACKEND, 'utils', 'cacheKeyInventory.js'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\/\/ ?/gm, '')
    .replace(/\s+/g, ' ');
  assert.match(src, /only as good as the part of the key the caller cannot choose/i,
    'the rule this file exists to enforce has been edited out of its own header');
  assert.match(src, /WHICH PART OF THE KEY CAN THE CALLER PICK/i);
  assert.match(src, /WHAT DOES A MISS COST/i);
});
