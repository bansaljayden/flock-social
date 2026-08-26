// ---------------------------------------------------------------------------
// THE BLOCK PROBE IS EVALUATED, NOT DESCRIBED.
//
// `isBlockedBetween` is the control Apple 1.2 is tested on, and the only thing
// standing between a block and the blocker's DMs, invites, live location and
// group surfaces. On 2026-08-26 a mutation dropped
// `OR (blocker_id = $2 AND blocked_id = $1)` from it and all 4,676 tests stayed
// green, because every mock of that query in the repo dispatches on a prefix
// the one-directional query still contains. `safetyPathAudit.test.js` closed
// that by asserting a PROPERTY: swapping the two bind placeholders must leave
// the set of OR-terms unchanged, which a one-directional clause fails. That
// assertion works. Dropping either direction turns it red and a reorder does
// not, both measured.
//
// WHAT SYMMETRY DOES NOT SAY. It says the clause treats the two people alike.
// It does not say the clause matches anybody. A predicate that matches NOTHING
// is perfectly symmetric, and two of them survive it:
//
//   WHERE (blocker_id = $1 AND blocked_id = $1)
//      OR (blocker_id = $2 AND blocked_id = $2)   -- both terms self-paired
//
//   ... LIMIT 0                                   -- the row cap zeroed
//
// Both were run on 2026-08-26. The first is symmetric under the swap, because
// the two terms exchange places and the SET is unchanged, and it has two
// OR-terms so it clears the `terms.size >= 2` floor as well: green across
// safetyPathAudit and moderationReach. The second is green across every
// block-related suite in the repo, because the helper that reads the terms
// strips a trailing `LIMIT n` before comparing, and that is exactly the token
// deciding whether the query can return a row at all. Neither would ever
// report a block. What ships is A blocks B, and B keeps reaching A, and A keeps
// reaching B.
//
// So this file asks the question symmetry cannot: WHO DOES THE PREDICATE
// SELECT. The WHERE clause the function actually sends is translated into a
// boolean over a `user_blocks` row and evaluated against fixture rows. A block
// written either way round must match. A self-referential row, a row about one
// of the two and a stranger, and a row about two strangers must not.
//
// THE TRANSLATION IS ALLOWLISTED, AND THAT IS THE POINT. A clause containing
// any token this evaluator does not recognise is a HARD FAILURE with the token
// named, never a skipped case and never a pass. The failure this whole file
// exists to prevent is a check that quietly stops checking, so a predicate that
// grows a construct nobody taught it about has to be read by a person.
//
// WHAT IT STILL CANNOT SEE. Nothing here executes SQL, so this judges the text
// the function sends rather than what Postgres does with it. That is the same
// boundary every other suite in this repo works inside, and it is why the row
// cap is asserted separately: `LIMIT 0` is not a WHERE clause defect and no
// evaluation of the predicate would ever find it.
//
// HOW TO RUN
//   cd backend && node --test __tests__/utils/blockPredicate.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');

const blocks = require('../../utils/blocks');

const A = 7;
const B = 9;
const STRANGER = 5;

/** Records the one query the probe sends, and answers "no rows". */
function recordingDb() {
  const asked = [];
  return {
    asked,
    query: async (text, params) => {
      asked.push({ sql: String(text), params });
      return { rows: [] };
    },
  };
}

const flatten = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/**
 * The row cap, or null when there is none. `LIMIT 0` is a query that can never
 * answer "blocked", whatever its WHERE clause says.
 */
function rowCap(sql) {
  const m = /\bLIMIT\s+(\d+)\b/i.exec(flatten(sql));
  return m ? Number(m[1]) : null;
}

/** Everything after the first WHERE, with any trailing LIMIT removed. */
function whereClause(sql) {
  const flat = flatten(sql);
  const at = flat.toUpperCase().indexOf(' WHERE ');
  assert.ok(at > 0, 'the block probe must have a WHERE clause');
  return flat.slice(at + ' WHERE '.length).replace(/\s*LIMIT\s+\d+\s*$/i, '').trim();
}

// The only tokens this evaluator will judge. Anything else and it refuses.
const OPERAND = {
  blocker_id: 'row.blocker_id',
  blocked_id: 'row.blocked_id',
  $1: 'a',
  $2: 'b',
};
const OPERATOR = {
  AND: '&&',
  OR: '||',
  NOT: '!',
  '(': '(',
  ')': ')',
  '=': '===',
  '<>': '!==',
  '!=': '!==',
};

/**
 * Turns the WHERE clause into a predicate over (row, a, b).
 *
 * Deliberately small and deliberately strict: every token is either an operand
 * or an operator from the two tables above, and the scan must consume the whole
 * clause. A clause this cannot read throws by name.
 */
function compile(clause) {
  const pattern = /\s*(\(|\)|<>|!=|=|\$\d+|[A-Za-z_][A-Za-z0-9_]*)/g;
  const pieces = [];
  let cursor = 0;
  let match = pattern.exec(clause);
  while (match !== null) {
    assert.equal(
      match.index,
      cursor,
      `the block predicate has something this evaluator cannot read at "${clause.slice(cursor, cursor + 40)}". `
        + 'Teach it the construct rather than deleting the assertion: an unreadable predicate is not a passing one'
    );
    cursor = pattern.lastIndex;
    const raw = match[1];
    const upper = raw.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(OPERAND, raw)) pieces.push(OPERAND[raw]);
    else if (Object.prototype.hasOwnProperty.call(OPERATOR, upper)) pieces.push(OPERATOR[upper]);
    else {
      assert.fail(
        `the block predicate names "${raw}", which this evaluator does not know. `
          + 'If the clause legitimately grew a column or a function, add it to OPERAND above. Never widen it to a wildcard'
      );
    }
    match = pattern.exec(clause);
  }
  assert.equal(cursor, clause.length, `trailing text in the block predicate: "${clause.slice(cursor)}"`);
  // Eleven pieces is the smallest two-direction clause: ( x = y && x = y ) || ( ... ).
  // A shorter one cannot be naming both directions, so it is refused before it
  // is run rather than quietly evaluated.
  assert.ok(pieces.length >= 11, `the block predicate is too short to name two directions: "${clause}"`);
  // eslint-disable-next-line no-new-func
  return new Function('row', 'a', 'b', `return !!(${pieces.join(' ')});`);
}

/** Rows and the answer the block rule requires for each of them. */
const CASES = [
  [{ blocker_id: A, blocked_id: B }, true, 'A blocked B'],
  [{ blocker_id: B, blocked_id: A }, true, 'B blocked A, the direction that used to be droppable'],
  [{ blocker_id: A, blocked_id: A }, false, 'a row about A alone is not a block between A and B'],
  [{ blocker_id: B, blocked_id: B }, false, 'nor is a row about B alone'],
  [{ blocker_id: A, blocked_id: STRANGER }, false, 'A blocking a third person says nothing about B'],
  [{ blocker_id: STRANGER, blocked_id: B }, false, 'nor does a third person blocking B'],
  [{ blocker_id: STRANGER, blocked_id: STRANGER + 1 }, false, 'two strangers are two strangers'],
];

test('blocks: the pair probe SELECTS a block written either way round, and nothing else', async () => {
  const db = recordingDb();
  assert.equal(await blocks.isBlockedBetween(A, B, db), false, 'no rows means not blocked');
  assert.equal(db.asked.length, 1, 'one probe, or everything below is judging the wrong query');

  const { sql, params } = db.asked[0];
  assert.match(sql, /\bFROM\s+user_blocks\b/, 'the answer must come from user_blocks itself');
  assert.deepEqual(params, [A, B], 'the ids are bound, not inlined');

  const cap = rowCap(sql);
  assert.ok(
    cap === null || cap >= 1,
    `the probe caps itself at ${cap} rows, so it can never report a block however its WHERE clause reads`
  );

  const predicate = compile(whereClause(sql));
  for (const [row, expected, why] of CASES) {
    assert.equal(
      predicate(row, params[0], params[1]),
      expected,
      `${JSON.stringify(row)} should be ${expected ? 'a block' : 'not a block'}: ${why}`
    );
  }
});

test('blocks: the evaluator above says no to the predicates that got past symmetry', () => {
  // The evaluator is the instrument, so it is calibrated here rather than
  // trusted. Each clause below either survived the symmetry assertion or is the
  // defect symmetry was written for, and each one must fail at least one of the
  // cases the live probe passes.
  const wrongOnes = [
    ['one direction only', '(blocker_id = $1 AND blocked_id = $2)'],
    ['both terms self-paired', '(blocker_id = $1 AND blocked_id = $1) OR (blocker_id = $2 AND blocked_id = $2)'],
    ['columns confused', '(blocker_id = $1 AND blocker_id = $2) OR (blocker_id = $2 AND blocker_id = $1)'],
    ['matches everybody', '(blocker_id = $1 OR blocked_id = $2) OR (blocker_id = $2 OR blocked_id = $1)'],
  ];

  for (const [name, clause] of wrongOnes) {
    let predicate = null;
    try {
      predicate = compile(clause);
    } catch (err) {
      // A clause too short to be two directions is refused before it runs,
      // which is a rejection and counts as one.
      continue; // eslint-disable-line no-continue
    }
    const wrong = CASES.filter(([row, expected]) => predicate(row, A, B) !== expected);
    assert.ok(wrong.length > 0, `the evaluator accepted "${name}", so it is not measuring anything`);
  }

  // And the shape the app actually ships passes, so the cases above are not
  // simply unsatisfiable by construction.
  const good = compile('(blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)');
  for (const [row, expected] of CASES) assert.equal(good(row, A, B), expected);
});

test('blocks: a predicate the evaluator cannot read is a failure, not a skip', () => {
  // The quiet way this file could stop working: the clause grows a construct
  // nobody taught the translator, the translator shrugs, and the suite goes
  // green over a predicate nothing judged.
  assert.throws(
    () => compile('(blocker_id = $1 AND created_at > NOW()) OR (blocker_id = $2 AND blocked_id = $1)'),
    /cannot read|does not know/,
    'an unknown column or operator must be named and refused'
  );
  assert.throws(
    () => compile('(blocker_id = $1 AND blocked_id = $2) OR (blocker_id ~ $2)'),
    /cannot read|does not know/,
    'an unknown operator must be refused at the character it appears'
  );
});
