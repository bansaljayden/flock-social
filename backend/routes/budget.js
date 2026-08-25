const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const { pushIfOffline, pushAlways } = require('../services/pushHelper');
const { emitToFlockMembers } = require('../sockets/handlers');
// Shape before content — see validators/shape.js.
const { scalarOnly } = require('../validators/shape');

const router = express.Router();
router.use(authenticate);

// SERIAL flock ids are INT4; an id past this reaches the query as an out-of-range
// value and 500s instead of 400ing. Bound every :flockId param to it (mirrors
// friends.js MAX_USER_ID and the routesReliability.test.js bug class).
const INT4_MAX = 2147483647;

// Rate limit reminders: 1 per flock per 5 minutes.
//
// This map gained one entry per flock that ever sent a reminder and never lost
// one — the only unswept in-memory map left in the codebase (crowd.js,
// venueDashboard.js, utils/probeBudget.js and the socket connection tracker all
// prune). Entries are worthless the moment the cooldown expires, so the sweep
// below is pure garbage collection, not a budget reset: nothing an attacker can
// recover by triggering it.
const reminderCooldowns = new Map();
const REMINDER_COOLDOWN_MS = 5 * 60 * 1000;
const REMINDER_SWEEP_INTERVAL_MS = 60 * 1000;
// Only reached if more than this many DISTINCT flocks are inside their 5-minute
// window at once, which the 300/15min limiter makes implausible. Kept as a hard
// ceiling so a pathological case cannot grow the map without bound either.
const REMINDER_MAX_ENTRIES = 10000;
let lastReminderSweep = 0;

// Currency is not an integer, and floor is not a formatter (round 21).
//
// The "Budget set!" push ran the ceiling through Math.floor(), so a group
// budget of $12.50 was announced as "up to $12" while the screen inside the app
// said $12.50 — the API and the notification disagreeing about the same money.
// Below a dollar it was worse: a $0.75 ceiling was announced as "up to $0".
//
// The column is NUMERIC(8,2), so the value never has more than two decimal
// places to begin with; the only question is whether to show them. Whole
// dollars stay whole ("$25", not "$25.00"), anything else keeps its cents.
const formatMoney = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// PRIVACY: the published ceiling is BANDED, never the raw MIN.
// (Money security audit 2026-08-16, finding M1 — HIGH.)
//
// The ceiling is MIN(amount) over the non-skipped submissions, published once
// three non-skipped submissions exist. That threshold was picked to beat the
// n=2 subtraction case, but it counts SUBMISSIONS, not independent people, and
// the flock creator picks who is in the flock. An attacker plus one sockpuppet
// account can pin two non-skips at $9,999; the third person's real amount is
// then the MIN, and the group is handed that person's exact number.
//
// No submission threshold can prevent that: people acting together always know
// their own amounts and can subtract them out. What a threshold CAN stop is the
// published number being anyone's exact figure, so the reveal is banded:
//
//   under $1      -> $0.01   (the only band below a dollar that is not $0)
//   $1 to $4.99   -> nearest $1 down
//   $5 to $49.99  -> nearest $5 down
//   $50 and above -> nearest $10 down
//
// ALWAYS DOWN. Rounding up would publish a cap that someone in the flock cannot
// actually afford, and the one thing the ceiling has to guarantee is that any
// venue under it works for everybody. Down is also what makes the function safe
// to apply twice: flocks.budget_ceiling now caches the banded value, and
// re-banding a banded value is a no-op, so rows cached before this fix get
// banded on their way out instead of leaking a stale MIN.
//
// A MIN sitting exactly on a band edge still reads as its band: $50 publishes
// $50, and the group learns "somewhere in [$50, $60)", not "exactly $50".
//
// Zero is deliberately not reachable. The frontend reads `ceiling` for
// truthiness (a 0 would render as "no ceiling yet"), and a $0 cap says nothing
// useful, so the sub-dollar band is a cent rather than nothing.
const CEILING_BANDS = [
  { from: 50, step: 10 },
  { from: 5, step: 5 },
  { from: 1, step: 1 },
];
const SUB_DOLLAR_CEILING = 0.01;

// WHAT THE BAND ACTUALLY GUARANTEES, stated honestly (round 18).
//
// The published residual used to be described as "two people who compare notes
// learn the band containing a third person's amount". That prices it wrong, and
// the understatement is the interesting part: COLLUSION IS NOT REQUIRED.
//
// The ceiling is MIN(amounts). Any member who submits $10,000, the maximum the
// validator allows, has removed themselves from the minimum, so the number
// published back to them is band(MIN(everyone else)) and nothing of their own.
// One account, one submission, no second party. `__tests__/abuseBudgetAnonymity`
// pins it. The real threshold for learning that band is not "colluders", it is
// "any flock that reaches three shared amounts", which is every flock the
// feature works in at all.
//
// This is not fixable while the feature keeps its point. The published cap has
// to be a number every member can afford, and the only such number IS the
// minimum; whoever is not the binding constraint learns a fact purely about the
// others, by arithmetic, no matter how the value is computed. Adding noise
// upward would publish a cap somebody in the flock cannot actually pay, which
// is the one thing the ceiling exists to prevent, and noise downward is what
// banding already is. Publishing a different number to each member would stop
// it being a group cap.
//
// So the guarantee is the BAND, not secrecy: every member learns an interval
// ($1, $5 or $10 wide) containing the lowest amount among the others, and never
// an exact figure or a name. The privacy policy and terms have to say that, not
// the collusion-only version.
//
// SKIP COUNT IS A PER-PERSON READ IN A SMALL FLOCK.
//
// skipCount was returned raw to every member. The caller always knows their own
// answer, so what they receive is really "how many of my co-members declined to
// share a number", and in a two-person flock that is a direct read of the one
// fact the mechanism exists to hide, with no arithmetic and no second account.
// In a three-person flock, 0 or 2 names both other members exactly.
//
// The same "three is a crowd" floor the ceiling uses applies here, measured over
// the population the count actually ranges over: the caller's co-members. Below
// three of them the split between "shared an amount" and "skipped" is withheld
// and the field is null. submissionCount and totalMembers are unaffected, so
// "2 of 4 answered" still renders and nobody's honest submission gets harder.
// The field stays present on the wire in both cases; a null is a withheld
// number, not a missing key.
const SKIP_COUNT_MIN_OTHERS = 3;
function publishableSkipCount(skipCount, totalMembers) {
  return (totalMembers - 1) >= SKIP_COUNT_MIN_OTHERS ? skipCount : null;
}

// MEMBERSHIP IS THE RELATIONSHIP (round 18).
//
// budget_submissions carries a flock_id and a user_id and no relationship to
// flock_members at all, and POST /api/flocks/:id/leave deletes the membership
// row and nothing else. So a submission outlived its author. Since the whole
// mechanism is a MIN, that is a griefing primitive with no counterplay:
// submit $0.01, leave, and the cent is the group's budget forever. The author
// cannot withdraw it (every write here needs an accepted membership row, so
// they are 403'd off their own row), nobody else can either (this router has no
// delete path), and /lock recomputes the same MIN and commits the group to it.
//
// routes/venues.js closed exactly this shape for venue_votes in round 17, where
// a vote outlived its voter and skewed the tally the flock goes by. Same rule
// here, and the stakes are higher, because the aggregate is also the privacy
// control: >= 3 non-skipped submissions is what unlocks the reveal, and rows
// left behind by departed accounts were carrying live flocks over that line.
// Two people in a room plus one throwaway that submits and leaves, and the
// ceiling those two are shown is a band around ONE of their amounts, with
// nobody else present to hide in. The throwaway cannot even take it back.
//
// So every aggregate on this router reads only rows whose author is still an
// accepted member. A JOIN, matching venues.js; flock_members is
// UNIQUE(flock_id, user_id), so it cannot multiply a submission row and inflate
// a COUNT that a privacy threshold is read from.
//
// The row itself is deliberately left in place. While its author is gone it is
// inert, and if they rejoin their number counts again, which is the same answer
// venues.js gives a returning voter. Deleting on leave would also destroy the
// one copy of a figure the account is entitled to see in its own data export.
const MEMBER_SUBMISSIONS = `budget_submissions bs
           JOIN flock_members bm ON bm.flock_id = bs.flock_id AND bm.user_id = bs.user_id
            AND bm.status = 'accepted'`;

function bandCeiling(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const { from, step } of CEILING_BANDS) {
    if (n >= from) return Math.floor(n / step) * step;
  }
  return SUB_DOLLAR_CEILING;
}

function sweepReminderCooldowns(now) {
  if (now - lastReminderSweep < REMINDER_SWEEP_INTERVAL_MS && reminderCooldowns.size <= REMINDER_MAX_ENTRIES) return;
  lastReminderSweep = now;
  for (const [key, ts] of reminderCooldowns) {
    if (now - ts >= REMINDER_COOLDOWN_MS) reminderCooldowns.delete(key);
  }
  // Insertion order is close enough to expiry order (every entry has the same
  // fixed lifetime), so oldest-first drops whatever is nearest to expiring.
  while (reminderCooldowns.size > REMINDER_MAX_ENTRIES) {
    reminderCooldowns.delete(reminderCooldowns.keys().next().value);
  }
}

// POST /api/budget/:flockId/submit — Submit or update a budget amount
router.post('/:flockId/submit',
  [
    param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'),
    //
    // Round 19, two separate faults on this one line.
    //
    // SHAPE. `amount: ["50"]` satisfied isFloat by coercion and stayed an array
    // in req.body, then went into budget_submissions.amount (DECIMAL) as the
    // literal '{50}' — 22P02, i.e. a 500 with the whole submit transaction
    // rolled back. `skipped: ["false"]` was worse than a 500: isBoolean passed,
    // `!!skipped` read the ARRAY as true, and a person who said "no, here is my
    // budget" was recorded as having skipped. This is the anonymous
    // budget-matching surface, where a wrong `skipped` moves the 3-submission
    // privacy threshold that gates the ceiling.
    //
    // OPTIONALITY. `.optional()` skips only `undefined`, and the shipping
    // client's Skip button posts `{ amount: 0, skipped: true }`
    // (frontend/src/App.js -> submitBudget). 0 is PRESENT, so it fell through to
    // isFloat({ min: 0.01 }) and every skip in the app was answered
    // "400 Amount must be between $0.01 and $10,000" — the same shape of bug as
    // the feedback route's `optional()`-vs-null. checkFalsy skips 0/''/null/
    // undefined; a non-skip submission with no usable amount is still refused,
    // by the explicit check in the handler that says so in words.
    scalarOnly(body('amount').optional({ checkFalsy: true }), 'amount')
      .isFloat({ min: 0.01, max: 10000 }).withMessage('Amount must be between $0.01 and $10,000'),
    // values:'null' for the same reason — an explicit `skipped: null` means "not
    // skipped", which is what `!!skipped` already computes, so refusing it was
    // pure friction.
    //
    // Round 21: `.toBoolean()` is the other half of the round 19 finding, and
    // it was left open. isBoolean() ACCEPTS THE STRINGS 'true', 'false', '0'
    // and '1' — and `!!'false'` is true, and `!!'0'` is true. So the exact bug
    // the note above describes for `skipped: ["false"]` was still live for
    // `skipped: "false"`: the validator called it a valid boolean, `!!skipped`
    // read it as a skip, the person's amount was written as NULL, and someone
    // who said "no, here is my $50" stopped counting toward the ceiling. That
    // also moves the 3-submission privacy threshold that gates the whole
    // feature. Recognising a boolean is not enough; it has to be COERCED, so
    // the handler and the column see the same answer the caller gave.
    scalarOnly(body('skipped').optional({ values: 'null' }), 'skip flag').isBoolean().toBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;
      const { amount, skipped } = req.body;

      // Verify membership
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Validate: if not skipped, amount is required
      if (!skipped && (!amount || amount <= 0)) {
        return res.status(400).json({ error: 'Amount is required when not skipping' });
      }

      // PRIVACY INVARIANT: submission, ceiling recompute, and counting run in
      // ONE transaction holding the flock row lock. As autocommit queries, a
      // concurrent skip could slip between this route's checks and /lock's
      // count, letting the lock emit a ceiling backed by <3 submissions.
      // Individual amounts never leave the server on any path; the aggregate
      // that does leave is the BANDED ceiling, see bandCeiling above.
      const client = await pool.connect();
      let countRow;
      let ceiling;
      let hadNonSkipBefore = false;
      try {
        await client.query('BEGIN');

        const flockCheck = await client.query(
          'SELECT budget_enabled, budget_locked FROM flocks WHERE id = $1 FOR UPDATE',
          [flockId]
        );
        if (flockCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Flock not found' });
        }
        if (!flockCheck.rows[0].budget_enabled) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
        }
        if (flockCheck.rows[0].budget_locked) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Budget has been locked' });
        }

        // Prior state of THIS user's row — needed to detect a true threshold
        // crossing (an edit by one of the original three must not re-push).
        const priorRow = await client.query(
          'SELECT skipped FROM budget_submissions WHERE flock_id = $1 AND user_id = $2',
          [flockId, userId]
        );
        hadNonSkipBefore = priorRow.rows.length > 0 && priorRow.rows[0].skipped === false;

        // UPSERT budget submission
        await client.query(
          `INSERT INTO budget_submissions (flock_id, user_id, amount, skipped, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (flock_id, user_id) DO UPDATE
           SET amount = $3, skipped = $4, updated_at = NOW()`,
          [flockId, userId, skipped ? null : amount, !!skipped]
        );

        // Recalculate ceiling: MIN of non-skipped amounts from PRESENT members
        // (see MEMBER_SUBMISSIONS: a departed account's cent used to set this
        // forever).
        const ceilingResult = await client.query(
          `SELECT MIN(amount) AS ceiling FROM ${MEMBER_SUBMISSIONS}
           WHERE bs.flock_id = $1 AND skipped = false`,
          [flockId]
        );
        // Band it before anything else can see it. The cached column is read by
        // GET /api/budget/:flockId here, by the flock list and flock detail in
        // routes/flocks.js, and by the ghost commit in routes/billing.js —
        // banding on the way IN is what makes every one of those surfaces
        // publish the band rather than one person's exact amount.
        ceiling = bandCeiling(ceilingResult.rows[0].ceiling);

        // Update cached ceiling on flocks table
        await client.query(
          'UPDATE flocks SET budget_ceiling = $1, updated_at = NOW() WHERE id = $2',
          [ceiling, flockId]
        );

        // Count submissions. One query answers both questions this route has:
        // the aggregate counts for the response, and (derived below) whether
        // the ceiling was already public before this submission. This used to
        // be TWO statements — the second re-counted non-skips excluding this
        // user — but this submit only ever changes this user's own row, so
        // "others' non-skips" is exactly non_skip_count minus this user's
        // contribution, already known. Reliability pass 2026-08-14: dropped the
        // redundant query (submit transaction: 9 statements -> 8).
        //
        // Counted over present members only, same as the MIN above: the
        // non-skip count IS the privacy threshold, so a row from someone who
        // left was borrowing anonymity for a flock that does not have it.
        const countResult = await client.query(
          `SELECT
             COUNT(*) AS total_submissions,
             COUNT(*) FILTER (WHERE skipped = false) AS non_skip_count,
             COUNT(*) FILTER (WHERE skipped = true) AS skip_count
           FROM ${MEMBER_SUBMISSIONS} WHERE bs.flock_id = $1`,
          [flockId]
        );
        countRow = countResult.rows[0];

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      const { total_submissions, non_skip_count, skip_count } = countRow;
      const submissionCount = parseInt(total_submissions);
      const skipCount = parseInt(skip_count);
      const nonSkipCount = parseInt(non_skip_count);
      // Other members' non-skip rows, unchanged by this submit: the count above
      // ran AFTER the upsert inside the same transaction, so it includes this
      // user's row iff they did not skip — subtract that contribution back out.
      const othersNonSkipBefore = nonSkipCount - (skipped ? 0 : 1);

      // Total members
      const memberResult = await pool.query(
        "SELECT COUNT(*) AS total FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const totalMembers = parseInt(memberResult.rows[0].total);

      // Privacy: ceiling only visible when 3+ non-skip submissions, and even
      // then it is the band, not the MIN (`ceiling` was banded above).
      const isReady = nonSkipCount >= 3;
      const visibleCeiling = isReady ? ceiling : null;
      // And the skip/share split only when it ranges over three co-members or
      // more. See publishableSkipCount.
      const visibleSkipCount = publishableSkipCount(skipCount, totalMembers);

      // Emit socket event to flock room
      const io = req.app.get('io');
      if (io) {
        // Per-member fan-out, not the `flock:{id}` room, so a member sitting
        // anywhere else in the app still gets the budget-ready signal. Payload
        // is aggregate-only (visibleCeiling is null below the 3-submission
        // threshold, and banded above it); no individual amount is ever put on
        // the wire. This carries the SAME value the REST response below carries,
        // which matters: a raw MIN reaching the socket while REST published a
        // band would hand the whole fix back. Guarded so a fan-out failure
        // cannot 500 a submission that already committed.
        await emitToFlockMembers(io, flockId, 'budget_updated', {
          flockId,
          ceiling: visibleCeiling,
          submissionCount,
          totalMembers,
          isReady,
          skipCount: visibleSkipCount,
        }).catch((e) => console.error('budget_updated fan-out failed:', e.message));
      }

      // Push "Budget set!" only when this submission CROSSED the threshold
      const wasReadyBefore = (othersNonSkipBefore + (hadNonSkipBefore ? 1 : 0)) >= 3;
      if (isReady && visibleCeiling && !wasReadyBefore) {
        const flockNameResult = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
        const flockName = flockNameResult.rows[0]?.name || 'Flock';
        const membersResult = await pool.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
          [flockId, userId]
        );
        for (const m of membersResult.rows) {
          await pushIfOffline(io, m.user_id,
            'Budget set!',
            `Group budget: up to $${formatMoney(visibleCeiling)} for ${flockName}`,
            { type: 'budget_ready', flockId: String(flockId) }
          );
        }
      }

      res.json({
        submitted: true,
        ceiling: visibleCeiling,
        submissionCount,
        totalMembers,
        isReady,
        skipCount: visibleSkipCount,
        userSubmitted: true,
      });
    } catch (err) {
      console.error('Budget submit error:', err);
      res.status(500).json({ error: 'Failed to submit budget' });
    }
  }
);

// GET /api/budget/:flockId — Get budget status for a flock
router.get('/:flockId',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Verify membership
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Count submissions FIRST, then read the cached ceiling. The order is
      // load-bearing for the privacy invariant: these are two autocommit
      // statements with two snapshots, and the reveal decision (>= 3 non-skips)
      // is made from THIS count. Read the other way round — ceiling first,
      // count second — a third submission committing between the two left the
      // count saying "3, reveal" while the ceiling still held the MIN over the
      // TWO amounts that existed when it was read; in a three-person flock that
      // stale MIN hands one member the other's exact number at the precise
      // moment everyone is watching the crossing. Counting first means a
      // crossing mid-request errs to "withhold", and a >= 3 count is only ever
      // paired with a ceiling at least as new as the state it counted.
      const countResult = await pool.query(
        `SELECT
           COUNT(*) AS total_submissions,
           COUNT(*) FILTER (WHERE skipped = false) AS non_skip_count,
           COUNT(*) FILTER (WHERE skipped = true) AS skip_count
         FROM ${MEMBER_SUBMISSIONS} WHERE bs.flock_id = $1`,
        [flockId]
      );

      // Get flock budget config (and the cached ceiling — see the note above).
      const flockResult = await pool.query(
        'SELECT budget_enabled, budget_context, budget_locked, budget_ceiling, ghost_mode_enabled FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      const flock = flockResult.rows[0];
      const submissionCount = parseInt(countResult.rows[0].total_submissions);
      const nonSkipCount = parseInt(countResult.rows[0].non_skip_count);
      const skipCount = parseInt(countResult.rows[0].skip_count);

      // Total members
      const memberResult = await pool.query(
        "SELECT COUNT(*) AS total FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const totalMembers = parseInt(memberResult.rows[0].total);

      // User's own submission (privacy: only their own)
      const userResult = await pool.query(
        'SELECT amount, skipped FROM budget_submissions WHERE flock_id = $1 AND user_id = $2',
        [flockId, userId]
      );
      const userSubmission = userResult.rows[0] || null;

      // The reveal gate is the COUNT, on this route and on the four other
      // surfaces that publish the same number (the flock list, the flock
      // detail, the flock update, and the ghost commit in routes/billing.js).
      // budgetCeilingReadParity pins all five answering alike, so "locked, and
      // therefore once revealed, therefore still revealable" is not a shortcut
      // this route gets to take on its own. A locked flock that falls back
      // under three sharers withholds, like every other reader of it.
      const isReady = nonSkipCount >= 3;

      // RECOMPUTE, DO NOT TRUST THE CACHE (round 18, the other half of the
      // poison-and-run fix).
      //
      // flocks.budget_ceiling is written by /submit and by /lock and by nothing
      // else. Leaving a flock writes nothing at all. So teaching the aggregates
      // to skip a departed account's row only half closed it: the cached column
      // still HELD that account's number, and this route, which is the screen
      // every member actually looks at, went on publishing the griefer's cent
      // until somebody happened to submit again. A stale cache is the same leak
      // one statement later.
      //
      // Recomputing over present members is the only reading that cannot be
      // stale, and it runs AFTER the count above for the reason spelled out
      // there: a crossing mid-request errs to "withhold".
      //
      // A LOCKED budget is the deliberate exception. Locking is the group
      // committing to a number; a member leaving afterwards must not silently
      // move the figure everyone agreed to. There the cached value IS the
      // answer, re-banded on the way out so a row cached as a raw MIN before
      // the M1 fix cannot publish an exact amount.
      let ceiling;
      if (flock.budget_locked) {
        ceiling = bandCeiling(flock.budget_ceiling);
      } else {
        const ceilingResult = await pool.query(
          `SELECT MIN(amount) AS ceiling FROM ${MEMBER_SUBMISSIONS}
           WHERE bs.flock_id = $1 AND skipped = false`,
          [flockId]
        );
        ceiling = bandCeiling(ceilingResult.rows[0].ceiling);
      }
      const visibleCeiling = isReady ? ceiling : null;
      // See publishableSkipCount: in a flock with fewer than three co-members
      // this number names who declined to share.
      const visibleSkipCount = publishableSkipCount(skipCount, totalMembers);

      res.json({
        budgetEnabled: flock.budget_enabled,
        budgetContext: flock.budget_context,
        budgetLocked: flock.budget_locked,
        ceiling: visibleCeiling,
        submissionCount,
        totalMembers,
        isReady,
        skipCount: visibleSkipCount,
        userSubmitted: !!userSubmission,
        userAmount: userSubmission && !userSubmission.skipped ? parseFloat(userSubmission.amount) : null,
        userSkipped: userSubmission ? userSubmission.skipped : false,
      });
    } catch (err) {
      console.error('Budget status error:', err);
      res.status(500).json({ error: 'Failed to get budget status' });
    }
  }
);

// POST /api/budget/:flockId/lock — Creator locks the budget
router.post('/:flockId/lock',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // EXISTENCE ORACLE, closed (object-authz sweep, round 2).
      //
      // This route read the flocks row on the id alone and only THEN compared
      // creator_id, so a total outsider got 403 for a real flock and 404 for a
      // made-up one. flocks.id is a SERIAL, so that difference walks the whole
      // table one request at a time, and nothing on this route is rationed by a
      // probe budget. GET /:flockId and /submit in this same file check
      // membership FIRST and therefore answer a stranger identically whether
      // the flock exists or not, which made this an inconsistency inside one
      // file rather than a policy choice. routes/flocks.js states the rule at
      // hasMembershipRow: "unless you hold a membership row, every flock looks
      // like it does not exist".
      //
      // Same statement, same 403 body as the two siblings, so the four budget
      // routes now refuse a stranger identically and none of them can be told
      // which ids are real.
      //
      // The distinction that MATTERS survives. An accepted member who is not
      // the creator passes this gate and falls through to the creator check
      // below, which still runs under FOR UPDATE, so he is still told in so
      // many words that only the creator may lock, and the app can still
      // explain a disabled button. It is only the TOTAL OUTSIDER, who cannot be
      // told anything at all without confirming the flock exists, whose answer
      // is flattened onto the answer for an id that is not there.
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // PRIVACY INVARIANT (README "hard invariants"): the ceiling is the MIN of
      // submissions, so revealing it below the 3-submission threshold exposes an
      // individual's exact budget. The threshold check, lock, and ceiling read
      // happen in ONE transaction holding the flock row lock — otherwise a
      // concurrent skip between the count and the response could leave this
      // emitting a ceiling backed by fewer than 3 submissions. Above the
      // threshold the number published here is the BANDED ceiling, for the
      // collusion reason spelled out at bandCeiling.
      const client = await pool.connect();
      let ceiling;
      try {
        await client.query('BEGIN');

        const flockResult = await client.query(
          'SELECT creator_id, budget_enabled FROM flocks WHERE id = $1 FOR UPDATE',
          [flockId]
        );
        if (flockResult.rows.length === 0) {
          await client.query('ROLLBACK');
          // Reachable only as a race now (the flock was deleted between the
          // membership check and this lock), never by an outsider probing ids.
          return res.status(404).json({ error: 'Flock not found' });
        }
        if (flockResult.rows[0].creator_id !== userId) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Only the flock creator can lock the budget' });
        }
        if (!flockResult.rows[0].budget_enabled) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
        }

        const countResult = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${MEMBER_SUBMISSIONS}
           WHERE bs.flock_id = $1 AND skipped = false`,
          [flockId]
        );
        if ((countResult.rows[0]?.n || 0) < 3) {
          await client.query('ROLLBACK');
          // The threshold is three NON-SKIPPED submissions, because the ceiling
          // is a MIN and revealing it over fewer than three amounts exposes one
          // person's budget. The old wording said "at least 3 people have
          // submitted" while the screen directly above the button said
          // "4 of 4 submitted" — submissionCount counts skips and this does
          // not. In a four-person flock where two skip, the creator was told
          // everyone had answered AND that not enough people had answered, with
          // nothing to explain the gap. State the actual rule.
          return res.status(400).json({
            error: 'Budget locks once 3 people have shared an amount. Skips do not count.',
          });
        }

        // Recompute inside the transaction — the cached column could be stale
        // relative to the submissions this count just validated.
        const ceilingResult = await client.query(
          `SELECT MIN(amount) AS ceiling FROM ${MEMBER_SUBMISSIONS}
           WHERE bs.flock_id = $1 AND skipped = false`,
          [flockId]
        );
        // Same banding as the submit path, and the locked value is what gets
        // cached, so the lock cannot re-publish a raw MIN a submit had banded.
        // Same membership join too: the lock is where a poisoned cent became
        // the number the group actually committed to.
        ceiling = bandCeiling(ceilingResult.rows[0].ceiling);

        await client.query(
          'UPDATE flocks SET budget_locked = true, budget_ceiling = $2, updated_at = NOW() WHERE id = $1',
          [flockId, ceiling]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      const io = req.app.get('io');
      if (io) {
        // Per-member fan-out so the lock reaches members wherever they are.
        // `ceiling` here is only computed after the >=3 non-skip check above and
        // is banded, so it is never an individual's exact amount, and it is the
        // same value the response below returns. Guarded (post-commit work).
        await emitToFlockMembers(io, flockId, 'budget_locked', {
          flockId,
          ceiling,
          locked: true,
        }).catch((e) => console.error('budget_locked fan-out failed:', e.message));
      }

      res.json({ locked: true, ceiling });
    } catch (err) {
      console.error('Budget lock error:', err);
      res.status(500).json({ error: 'Failed to lock budget' });
    }
  }
);

// POST /api/budget/:flockId/remind — Send reminder to members who haven't submitted
router.post('/:flockId/remind',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // EXISTENCE ORACLE, closed (object-authz sweep, round 2). Identical fault
      // and identical fix to /lock above, where the reasoning is written out:
      // this read the flocks row on the id alone and only then compared
      // creator_id, so a stranger got 403 for a real flock and 404 for a fake
      // one and could walk the SERIAL id space. The member who is not the
      // creator still reaches the creator check below and is still told why he
      // cannot send reminders.
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Verify creator
      const flockResult = await pool.query(
        'SELECT creator_id, name, budget_enabled FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockResult.rows.length === 0) {
        // A race, not a probe: the membership row above says this flock existed
        // a statement ago.
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (flockResult.rows[0].creator_id !== userId) {
        return res.status(403).json({ error: 'Only the flock creator can send reminders' });
      }
      if (!flockResult.rows[0].budget_enabled) {
        return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
      }

      // Rate limit: 1 reminder per flock per 5 minutes.
      //
      // The read and the write used to sit on either side of the member lookup
      // and the whole push fan-out, so two requests in flight both saw an
      // expired cooldown and both notified everyone — the limit was one
      // reminder per five minutes PER REQUEST THAT FINISHED FIRST. The slot is
      // claimed here, synchronously, in the same tick as the check: there is no
      // await between them, so a second request cannot interleave. Claiming
      // before the work means a later failure still burns the window, which is
      // the correct direction for a spam control to fail.
      const cooldownKey = `remind:${flockId}`;
      const now = Date.now();
      const lastReminder = reminderCooldowns.get(cooldownKey);
      if (lastReminder && now - lastReminder < REMINDER_COOLDOWN_MS) {
        return res.status(429).json({ error: 'Please wait before sending another reminder' });
      }
      reminderCooldowns.set(cooldownKey, now);
      sweepReminderCooldowns(now);

      // Find members who haven't submitted
      const missingResult = await pool.query(
        `SELECT u.id, u.name FROM flock_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.flock_id = $1 AND fm.status = 'accepted'
         AND fm.user_id NOT IN (SELECT user_id FROM budget_submissions WHERE flock_id = $1)`,
        [flockId]
      );

      const io = req.app.get('io');
      const flockName = flockResult.rows[0].name;
      if (io) {
        for (const member of missingResult.rows) {
          io.to(`user:${member.id}`).emit('budget_reminder', {
            flockId,
            flockName,
            message: "Don't forget to submit your budget!",
          });
        }
      }

      // Push regardless of online status — explicit creator action
      for (const member of missingResult.rows) {
        await pushAlways(member.id,
          'Budget reminder',
          `Submit your budget for ${flockName}`,
          { type: 'budget_reminder', flockId: String(flockId) }
        );
      }

      res.json({ reminded: missingResult.rows.length });
    } catch (err) {
      console.error('Budget remind error:', err);
      res.status(500).json({ error: 'Failed to send reminders' });
    }
  }
);

module.exports = router;

// Exported so the regression tests can drive the banding rule from the route
// that owns it instead of retyping the thresholds, and so a future reader of
// flocks.js / billing.js can see where their cached ceiling was banded.
module.exports.bandCeiling = bandCeiling;
module.exports.CEILING_BANDS = CEILING_BANDS;
module.exports.SUB_DOLLAR_CEILING = SUB_DOLLAR_CEILING;

// Test hook only — the reminder cooldown is process-wide in-memory state, so a
// test suite needs a way to start each case from a clean window.
module.exports.__resetReminderCooldowns = () => {
  reminderCooldowns.clear();
  lastReminderSweep = 0;
};
// Test hook only — lets a test assert the map actually shrinks, which is the
// whole point of the sweep and is otherwise invisible from outside.
module.exports.__reminderCooldownCount = () => reminderCooldowns.size;
