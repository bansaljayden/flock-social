const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const { pushIfOffline, isPushConfigured } = require('../services/pushHelper');

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// THIS FILE IS THE BILL SPLIT, NOT THE PAYWALL (trust sweep 2026-08-14)
//
// "Billing" here means who owes whom for dinner. Flock Pro lives in
// services/entitlements.js, and the only thing that decides who has paid is the
// column users.is_premium, written by exactly one writer in this repo:
// routes/revenuecat.js.
//
// Nothing below is premium-gated and nothing below reads a premium claim off the
// request. That is a fact worth writing down rather than leaving to be
// rediscovered, because the day a Pro-only bill feature is added the cheapest
// way to write it is `if (req.body.isPremium)` — and frontend gating is
// cosmetic, so a client claim is not evidence of anything. Any gate added here
// must ask services/entitlements.js, which reads the column on every call with
// no cache. __tests__/billingWebhookTrust.test.js fails if a premium claim is
// ever read off req.body, req.query, req.params or a header in this file.
// ---------------------------------------------------------------------------

// SERIAL ids are INT4; an id/payer past this 500s on the query rather than 400ing
// (same class as routesReliability.test.js; friends.js bounds user ids the same
// way). Every :flockId param and the paidBy body id below is bounded to it.
const INT4_MAX = 2147483647;

// ---------------------------------------------------------------------------
// Round 16 — how bill events are delivered.
//
// Every event in this file used to go to `io.to('flock:'+flockId)`. That room
// is NOT a membership list: sockets/handlers.js `join_flock` checks membership
// ONCE, when the client opens the flock screen, and then the socket stays in
// the room for the life of the connection. Two things follow, and `bill_created`
// carries the single most sensitive payload on any room surface — every
// member's name paired with the exact dollar amount they owe:
//
//   1. Someone removed from the flock (or who left) keeps receiving bill
//      events until the session watchdog notices. revalidateSession runs on a
//      60s timer, is skipped entirely when JWT_SECRET is unset, and swallows
//      database errors by design ("a blip must never disconnect anyone") — so
//      the eviction is best-effort and the exposure window is open-ended, not
//      bounded at 60s.
//   2. It is also under-delivery in the other direction: a member sitting
//      anywhere else in the app is not in the flock room at all and simply
//      missed the event.
//
// So bill events fan out to each accepted member's PERSONAL room, with the
// membership re-read from the database at emit time. The helper lives in
// sockets/handlers.js next to the room bookkeeping it compensates for, so that
// this rule has ONE definition — routes/guest.js and routes/flocks.js reach for
// the same module for the same reason.
// ---------------------------------------------------------------------------
const { emitToFlockMembers, emitToFlockExcludingBlocked } = require('../sockets/handlers');
const { getInvisibleUserIds, isBlockedBetween } = require('../utils/blocks');
// PRIVACY: ghost commit derives the estimated share from the CACHED
// flocks.budget_ceiling, which is only as banded as whatever last wrote it.
// Imported from routes/budget.js — the route that owns the banding rule — so
// there is one implementation of the thresholds rather than two that can drift.
// settledCeiling adds the WHEN rule to that: the column holds a published
// number only once the budget is locked, and before that a ghost commit has no
// group figure to estimate a share from.
const { settledCeiling, MEMBER_SUBMISSIONS } = require('./budget');
// Shape before content — see validators/shape.js.
const { scalarOnly } = require('../validators/shape');

// Refuses a settle-up flow whose whole payload is one blocked person's identity
// (name + Venmo / Cash App / Zelle handle — a stronger identifier than anything
// the bill sheet renders). GET /:flockId withholds a blocked payer's NAME, so
// handing over their payment handles one tap later would have made that
// redaction decorative.
//
// The cost is real and deliberate: while a block is in place between them, the
// debtor cannot pull the payer's handles out of Flock and has to unblock (or
// settle outside the app) to pay. Same direction-neutral wording as the DM
// routes, so which side blocked whom cannot be read off the refusal.
async function refuseIfBlockedPayer(res, userId, payerId) {
  if (payerId == null) return false;
  if (await isBlockedBetween(userId, payerId)) {
    res.status(403).json({ error: 'You can no longer interact with this user.' });
    return true;
  }
  return false;
}

// NOBODY IS ON THE OTHER END OF THIS PAYMENT (bill split audit 2026-08-26).
//
// Both link routes looked the payer up by bill_splits.paid_by and answered
// 404 "Payer not found" when the row came back empty. That reads like a
// server that lost something, and it was the answer given to everybody who
// still owed money in the two states where paid_by is legitimately NULL:
//
//   1. The payer deleted their account. paid_by is ON DELETE SET NULL, so the
//      bill survives with nobody on it. Everybody else's share row survives
//      too (the payer's own cascades away with their user row, which is why
//      the sheet also stops adding up to the total). Nobody is overcharged and
//      nobody can pay: the Pay button is a dead end with no explanation, and
//      the client turns the 404 into a toast reading "Could not load payment
//      links. Use Mark as Paid after paying", which is advice to go and pay
//      somebody who no longer exists.
//   2. A ghost-commit shell, where paid_by has never been set because nobody
//      has paid anything yet and the total on the sheet is this server's
//      estimate off the group budget.
//
// A 404 on a payment route is also the wrong status: the bill is there and the
// caller may read it. What is missing is a counterparty, which is a conflict
// with the state of the thing, not an absent thing. 409 with a machine-readable
// reason, and one sentence that is true in both states with the way out of both
// in it. While paid_by is NULL, POST /:flockId/create applies first-bill
// rules, so any member can post the bill naming who really paid.
function noPayerRefusal(res, payerId) {
  if (payerId != null) return false;
  res.status(409).json({
    error: 'Nobody is recorded as having paid this bill, so there is no one to pay. Add the bill again with who paid.',
    reason: 'no_payer',
  });
  return true;
}

// ---------------------------------------------------------------------------
// Blocks on the bill (audit 2026-08-14)
//
// Reaching the right ROOM was only half of it. `bill_created` names EVERY
// member and the exact amount each one owes, so it is not an event with one
// actor to filter on — every recipient needs their own view of it. A blocked
// user's name and their debt were being delivered, live, to the person who
// blocked them, on every bill and every bill edit.
//
// So the payload is rebuilt per recipient: shares belonging to someone they
// cannot see are dropped, and if the PAYER is someone they cannot see, the
// payer's name is withheld (the id stays — the client falls back to "Unknown",
// which is what it already renders for a member it cannot name).
//
// What is deliberately NOT redacted is `totalAmount` / `totalWithTip`. The bill
// total is a fact about the table, not about a person, and a total that
// silently shrank per viewer would have people arguing over which number is
// real. GET /:flockId applies the identical rule — a leak that survives one
// refresh is not closed.
// ---------------------------------------------------------------------------
const NOBODY = new Set();

// One query for the whole member set, not one per recipient: {id -> Set(ids
// invisible to them)}, both directions of every block.
async function invisibilityMap(userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const r = await pool.query(
    `SELECT blocker_id, blocked_id FROM user_blocks
     WHERE blocker_id = ANY($1::int[]) OR blocked_id = ANY($1::int[])`,
    [userIds]
  );
  for (const row of r.rows) {
    if (!map.has(row.blocker_id)) map.set(row.blocker_id, new Set());
    if (!map.has(row.blocked_id)) map.set(row.blocked_id, new Set());
    map.get(row.blocker_id).add(row.blocked_id);
    map.get(row.blocked_id).add(row.blocker_id);
  }
  return map;
}

function billFor(bill, invisible) {
  if (!invisible || invisible.size === 0) return bill;
  return {
    ...bill,
    paidBy: invisible.has(bill.paidBy?.id)
      ? { id: bill.paidBy.id, name: null }
      : bill.paidBy,
    shares: (bill.shares || []).filter((s) => !invisible.has(s.userId)),
  };
}

// Recipients for an event that NAMES one actor (share_settled, ghost_committed
// — bill_created is the harder case handled above). Accepted members minus
// anyone blocked with the actor in either direction.
//
// Not sockets/handlers.js's emitToFlockExcludingBlocked, which also drops the
// ACTOR from the recipient list: right for the flock events it was written for,
// wrong here, because the person who just settled needs their own bill sheet to
// update on their other devices.
async function visibleRecipients(flockId, actorId) {
  const members = await pool.query(
    "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
    [flockId]
  );
  const invisible = new Set(await getInvisibleUserIds(actorId));
  return members.rows.map((r) => r.user_id).filter((id) => !invisible.has(id));
}

// Same membership rule as emitToFlockMembers (re-read at emit time, personal
// rooms), with a per-recipient payload on top.
async function emitBillCreated(io, flockId, bill) {
  if (!io) return [];
  const members = await pool.query(
    "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
    [flockId]
  );
  const ids = members.rows.map((r) => r.user_id);
  const blocks = await invisibilityMap(ids);
  for (const id of ids) {
    io.to(`user:${id}`).emit('bill_created', {
      flockId,
      bill: billFor(bill, blocks.get(id) || NOBODY),
    });
  }
  return ids;
}

// POST /api/billing/:flockId/create — Create a bill split
router.post('/:flockId/create',
  [
    param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'),
    body('totalAmount').isFloat({ min: 0.01, max: 100000 }).withMessage('Total must be between $0.01 and $100,000'),
    body('tipPercent').optional({ values: 'null' }).isFloat({ min: 0, max: 100 }).withMessage('Tip must be 0-100%'),
    // Round 19 (shape sweep). This is the one field in the body that reaches a
    // column WITHOUT being re-derived first: totalAmount, tipPercent and paidBy
    // are all rebuilt through Number()/parseInt() below, which flattens a
    // one-element array back to the right number, but splitType is written
    // straight into bill_splits.split_type. `["custom"]` satisfied isIn() by
    // coercion, then failed `splitType === 'custom'` (an array is never === a
    // string) so the bill silently split EQUALLY, and stored '{custom}' — which
    // GET /:flockId hands back as the split type the client renders. Not a 500;
    // a bill that says one thing and did another.
    scalarOnly(body('splitType').optional({ values: 'null' }), 'split type').isIn(['equal', 'custom']).withMessage('Split type must be equal or custom'),
    body('paidBy').optional({ values: 'null' }).isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid payer ID'),
    // Round 16: no maximum. Every element is reduced over, mapped, and pushed
    // into a Set before the "must be a member" check can reject it, so a
    // million-element array was a million-element CPU burn per request. 100 is
    // far above any real flock (max_members is a fraction of it).
    body('customShares').optional({ values: 'null' }).isArray({ max: 100 }).withMessage('Too many custom shares'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;
      // `??`, not a destructuring default: a default only fires for `undefined`,
      // and the validators above now let an explicit `null` through as "absent"
      // (round 19 — `.optional()` skipping only undefined is what made the
      // feedback route refuse every honest submission). A null splitType would
      // otherwise have been written to bill_splits.split_type as SQL NULL and
      // handed back by GET /:flockId as the split type the client renders.
      // tipPercent is safe either way — Number(null) is 0 — but is spelled the
      // same way so the two cannot drift.
      const { totalAmount, paidBy, customShares } = req.body;
      const tipPercent = req.body.tipPercent ?? 0;
      const splitType = req.body.splitType ?? 'equal';
      const payerId = paidBy ? parseInt(paidBy) : userId;

      // Verify membership
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Verify payer is a member
      const payerCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, payerId]
      );
      if (payerCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Payer must be a member of the flock' });
      }

      // Get accepted members.
      //
      // ORDER BY is load-bearing, not tidiness: the equal split hands its
      // leftover cents to the FIRST members of this list, and without an
      // explicit order Postgres may return the same roster in a different
      // sequence on the next read (a plan change, an UPDATE that moved a row).
      // The extra cent would then land on a different person every time the
      // bill was re-created, so "why do I owe a cent more than Ben" would have
      // no stable answer. Lowest user id carries it.
      const membersResult = await pool.query(
        `SELECT u.id, u.name FROM flock_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.flock_id = $1 AND fm.status = 'accepted'
         ORDER BY u.id`,
        [flockId]
      );
      const members = membersResult.rows;
      if (members.length === 0) {
        return res.status(400).json({ error: 'No accepted members in this flock' });
      }

      // Read PRE-COMMIT, on purpose. It only shapes the 201 body, but every
      // query after the COMMIT below is post-commit work: a throw there answers
      // 500 for a bill that exists, and the client's retry rewrites the split it
      // thinks failed. Asking here means a block-lookup failure is a clean 500
      // with nothing written.
      const invisibleToCreator = new Set(await getInvisibleUserIds(userId));

      // Get flock name + creator
      const flockResult = await pool.query('SELECT name, creator_id FROM flocks WHERE id = $1', [flockId]);
      const flockName = flockResult.rows[0]?.name || 'Flock';
      const flockCreatorId = flockResult.rows[0]?.creator_id;

      // Quantize the two inputs to the precision their columns actually hold,
      // BEFORE anything is computed from them or written.
      //
      // (mutation audit follow-up, 2026-08-14) Same disease as the share
      // rounding below, one level up. `total_amount` is DECIMAL(8,2) and
      // `tip_percent` is DECIMAL(4,1), and both were echoed back at the
      // client's precision while Postgres quietly rounded what it stored. A
      // bill posted as $33.333 answered 33.333 from POST and 33.33 from
      // GET /:flockId; an 18.55% tip was stored as 18.6, so GET recomputed
      // totalWithTip as 118.60 on a bill whose shares add up to 118.55 — the
      // sheet stops balancing on refresh, with no edit in between.
      //
      // Rounding here means the response, the shares and the row are all
      // derived from one number, and the two endpoints answer identically.
      const billTotal = Math.round(Number(totalAmount) * 100) / 100;
      const tipPct = Math.round(Number(tipPercent) * 10) / 10;

      // Calculate total with tip
      const totalWithTip = Math.round(billTotal * (1 + tipPct / 100) * 100) / 100;

      // Existing-bill authorization + preserved states are read INSIDE the
      // transaction below, under the flock row lock — checking here let two
      // concurrent "first" bills both pass and the loser silently overwrite
      // the winner without being its payer (round 5).
      const existingCommitments = new Map();
      const existingSettled = new Map();
      // What each of them settled FOR. A settled flag was carried onto a
      // rewritten share without ever comparing the two amounts, so re-posting a
      // corrected, higher total left the row reading "Bob $50.00, paid" over a
      // $25 payment, and the notification loop skips settled rows so Bob was
      // never told the bill had gone up.
      const existingAmounts = new Map();

      // Calculate shares
      let shares;
      if (splitType === 'custom' && customShares && customShares.length > 0) {
        // Round 16: `s.amount` was read straight off each element, so a single
        // `null` or a bare string in the array threw a TypeError that surfaced
        // as a 500 from the outer catch. Malformed input is a 400.
        if (customShares.some(s => s === null || typeof s !== 'object' || Array.isArray(s))) {
          return res.status(400).json({ error: 'Each custom share must be an object with userId and amount' });
        }
        // Round 16 (reliability audit): the tolerance used to be checked
        // against the RAW sum, and each share was rounded to cents only
        // afterwards. Three shares of 33.333333 on a $100.00 bill therefore
        // passed the check (raw sum 99.999999, within two cents) and then
        // stored as 33.33 three times — $99.99. The payer quietly ate the
        // difference, and the app showed a bill that did not add up.
        //
        // Everything below works in INTEGER CENTS, which is the only
        // representation in which "these shares equal that total" is a question
        // with an exact answer. Floating point never decides anything here.
        const parsed = customShares.map(s => ({
          userId: parseInt(s.userId),
          cents: Math.round(parseFloat(s.amount) * 100),
        }));

        // Round 3: every amount finite and non-negative, no duplicate users —
        // negative shares could offset an oversized one and NaN skipped the
        // total check entirely. Checked BEFORE the sum, so NaN cannot poison it.
        if (parsed.some(s => !Number.isFinite(s.cents) || s.cents < 0)) {
          return res.status(400).json({ error: 'Every share must be a valid non-negative amount' });
        }
        if (new Set(parsed.map(s => s.userId)).size !== parsed.length) {
          return res.status(400).json({ error: 'Each member can appear only once in custom shares' });
        }
        // Access control: every share must belong to an accepted flock member —
        // otherwise arbitrary user ids could be assigned debt + pushed notifications.
        const memberIds = new Set(members.map(m => m.id));
        const invalidShare = parsed.find(s => !Number.isFinite(s.userId) || !memberIds.has(s.userId));
        if (invalidShare) {
          return res.status(400).json({ error: 'All custom shares must be for members of this flock' });
        }

        const totalCents = Math.round(totalWithTip * 100);
        const sumCents = parsed.reduce((sum, s) => sum + s.cents, 0);
        const remainder = totalCents - sumCents;
        if (Math.abs(remainder) > 2) {
          return res.status(400).json({ error: `Custom shares must add up to $${totalWithTip.toFixed(2)}` });
        }
        // Within tolerance: absorb the last one or two cents rather than
        // leaving them unassigned. The largest share takes it, because that is
        // the one where a cent is least visible and it cannot be pushed
        // negative by a rounding remainder of at most two.
        if (remainder !== 0) {
          let biggest = 0;
          for (let i = 1; i < parsed.length; i++) {
            if (parsed[i].cents > parsed[biggest].cents) biggest = i;
          }
          parsed[biggest].cents += remainder;
          if (parsed[biggest].cents < 0) {
            return res.status(400).json({ error: `Custom shares must add up to $${totalWithTip.toFixed(2)}` });
          }
        }

        shares = parsed.map(s => ({ userId: s.userId, amount: s.cents / 100 }));
      } else {
        // Equal split, in integer cents — the same representation the custom
        // branch above was moved to, and for the same reason.
        //
        // (mutation audit 2026-08-14) The old arithmetic divided in DOLLARS and
        // then handed the leftover cents out as `baseShare + 0.01`. Neither
        // 0.01 nor 33.33 is representable in binary floating point, so about
        // 23% of (total, member count) pairs produced a share the client could
        // not render: $100.00 split three ways answered 33.339999999999996
        // while the DECIMAL(8,2) column stored the same share as 33.34. Three
        // surfaces then disagreed about one debt — the 201 body and the socket
        // payload carried the artifact, GET /:flockId (parseFloat off the
        // column) carried 33.34, and the push notification's toFixed(2)
        // carried a third rendering. The cent TOTALS were always right, so no
        // money was lost; what was lost was two friends being able to agree on
        // what one of them owes.
        //
        // Cents stay integers end to end and the divide by 100 happens once,
        // at the edge, which is the only place a rounding decision is made.
        // The leftover is deterministic and bounded: the first
        // `remainderCents` members in id order take exactly one extra cent
        // each (remainderCents < memberCount always), so the shares sum to the
        // total exactly and no share is more than a cent above the even split.
        const memberCount = members.length;
        const totalCents = Math.round(totalWithTip * 100);
        const baseCents = Math.floor(totalCents / memberCount);
        const remainderCents = totalCents - baseCents * memberCount;

        shares = members.map((m, i) => ({
          userId: m.id,
          amount: (baseCents + (i < remainderCents ? 1 : 0)) / 100,
        }));
      }

      // Use transaction
      const client = await pool.connect();
      let billId;
      try {
        await client.query('BEGIN');

        // Serialize bill writes per flock, then authorize replacement against
        // the row that actually exists at commit time.
        await client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
        const existingBill = await client.query(
          'SELECT id, paid_by FROM bill_splits WHERE flock_id = $1',
          [flockId]
        );
        if (existingBill.rows.length === 0 && payerId !== userId && userId !== flockCreatorId) {
          // Round 6: creating the FIRST bill with someone else as payer let any
          // member assign visible debts in another member's name. Only the
          // payer themselves (or the flock creator) can open a bill.
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Only the person who paid can start the bill' });
        }
        if (existingBill.rows.length > 0) {
          const prevPayer = existingBill.rows[0].paid_by;
          // A ghost-commit shell has paid_by NULL — nobody has claimed the
          // bill yet, so first-bill rules apply, not replacement rules
          // (round 7: NULL rejected every legitimate first payer).
          if (prevPayer === null) {
            if (payerId !== userId && userId !== flockCreatorId) {
              await client.query('ROLLBACK');
              return res.status(403).json({ error: 'Only the person who paid can start the bill' });
            }
          } else if (userId !== prevPayer && userId !== flockCreatorId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the person who paid or the flock creator can change this bill' });
          }
          const shareResult = await client.query(
            'SELECT user_id, committed, settled, settled_at FROM bill_split_shares WHERE bill_id = $1',
            [existingBill.rows[0].id]
          );
          for (const row of shareResult.rows) {
            if (row.committed) existingCommitments.set(row.user_id, true);
            // The payer's share is auto-settled below as an artifact of having
            // paid the venue — it is NOT a record that they settled a debt.
            // Carrying it across a payer CHANGE left the former payer marked
            // paid forever (audit 2026-08-13): Alice opens the bill (settled as
            // payer), then rewrites it with Bob as payer, and walks away owing
            // Bob nothing while everyone else still owes. Only a payer who is
            // still the payer keeps that flag.
            if (row.user_id === prevPayer && prevPayer !== payerId) continue;
            // A SETTLED FLAG ON A BILL NOBODY PAID IS NOT A PAYMENT (bill split
            // audit 2026-08-26). `settled` means "this person paid the payer
            // back", and a bill with paid_by NULL has no payer to have paid
            // back. It is either a ghost-commit shell, where the only money in
            // play is an estimate off the budget ceiling, or a bill whose payer
            // deleted their account. Carrying the flag across from one was a
            // free dinner with no exploit needed and no trace left behind:
            // ghost-commit, then POST /settle against the shell, and when the
            // real bill lands your share is inserted settled = true. The payer
            // is never told you owe (the push loop skips settled shares), the
            // sheet shows you paid, and you were never billed.
            //
            // POST /:flockId/settle now refuses a payerless bill outright, so
            // no new row can reach this loop in that state. This is the second
            // lock, and it is the one that covers rows already in the database.
            if (prevPayer === null) continue;
            if (row.settled) {
              existingSettled.set(row.user_id, row.settled_at || new Date());
              existingAmounts.set(row.user_id, Number(row.amount));
            }
          }
        }

        // UPSERT bill_splits
        const billResult = await client.query(
          `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (flock_id) DO UPDATE
           SET total_amount = $2, split_type = $3, paid_by = $4, tip_percent = $5, updated_at = NOW()
           RETURNING id`,
          [flockId, billTotal, splitType, payerId, tipPct]
        );
        billId = billResult.rows[0].id;

        // Delete existing shares (for re-creation). A blanket DELETE here
        // erased SETTLED rows for anyone the rewrite dropped from the split,
        // and a settled row is the only record that a debt was ever paid
        // (audit 2026-08-13). Two edits then re-issued a paid debt: rewrite
        // once with custom shares that omit Bob (his settled row is gone),
        // rewrite again including Bob, and he is billed a second time with no
        // trace of the first payment. Rows still in the split are rewritten
        // just below; rows dropped from it only go if they were unsettled.
        //
        // KNOWN GAP, recorded here rather than half-fixed (bill split audit
        // 2026-08-26). Keeping a settled row for somebody the rewrite dropped
        // is right, because they paid, but nothing then credits what they paid
        // against the new total, so the shares stop summing to the bill and the
        // people still on it make up the difference. Four friends, $100, $25
        // each; Bob pays his $25 and leaves the flock; the payer corrects the
        // total to $120; the equal split now runs over the three who are left
        // at $40 each, Bob's settled $25 stays on the sheet, and the sheet adds
        // to $145 for a $120 dinner. Carol and Dave are each out $8.33 and the
        // payer collects more than they spent.
        //
        // The fix is to split (total - sum of retained settled rows) over the
        // remaining roster, which is arithmetic this route can do but not from
        // here: `shares` is computed before the transaction opens, and the
        // amounts it would need are in a SELECT six test suites match on by its
        // exact column list. It also needs a product answer for the custom
        // branch, where the payer typed the numbers themselves and the same
        // credit would silently overwrite them. Not guessed at mid-audit.
        const keepIds = shares.map((s) => s.userId);
        await client.query(
          'DELETE FROM bill_split_shares WHERE bill_id = $1 AND user_id = ANY($2::int[])',
          [billId, keepIds]
        );
        await client.query(
          `DELETE FROM bill_split_shares
           WHERE bill_id = $1 AND user_id <> ALL($2::int[]) AND settled = false`,
          [billId, keepIds]
        );

        // Insert shares — settled records survive the rewrite (a paid debt
        // must not silently become unpaid because the bill was edited)
        for (const share of shares) {
          const isPayer = share.userId === payerId;
          const wasCommitted = existingCommitments.has(share.userId);
          // A settled debt survives a rewrite, but only for the amount it
          // settled. If the replacement asks this person for MORE than they
          // paid, the flag is theirs no longer: they owe the difference and the
          // sheet has to say so, and the notification loop below can only tell
          // somebody the bill moved if their row is unsettled. A smaller
          // replacement keeps the flag, because they are square or ahead and
          // un-settling a paid debt is the bug this whole branch exists to
          // avoid.
          const paidBefore = existingAmounts.get(share.userId);
          const owesMore = typeof paidBefore === 'number' && Number(share.amount) > paidBefore + 0.004;
          const wasSettled = existingSettled.has(share.userId) && !owesMore;
          const settledAt = isPayer ? new Date() : (wasSettled ? (existingSettled.get(share.userId) || null) : null);
          share.settled = isPayer || wasSettled; // response mirrors DB truth (round 3)
          share.committed = wasCommitted;
          await client.query(
            `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, settled_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [billId, share.userId, share.amount, wasCommitted, share.settled, settledAt]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        // Round 16: a throw from ROLLBACK (dead connection, already-aborted
        // transaction) replaced the real error with a useless one.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // -------- Everything below happens AFTER the commit. --------
      //
      // Round 16: this all used to sit INSIDE the transaction's try block, so a
      // failure in the notification loop (pushIfOffline reaches Firebase, which
      // can throw) ran `ROLLBACK` on an already-committed connection and then
      // answered 500. The bill was created and the client was told it was not —
      // and the client's retry takes the REPLACEMENT path, which rewrites the
      // split it thinks does not exist. Post-commit work cannot be allowed to
      // undo a successful write.

      // Build response with names
      // Round 4: mirror the DB truth computed above — recomputing settled as
      // payer-only told every client that previously paid members owed again.
      const shareDetails = shares.map(s => {
        const member = members.find(m => m.id === s.userId);
        return {
          userId: s.userId,
          name: member?.name || 'Unknown',
          amount: s.amount,
          settled: !!s.settled,
          committed: !!s.committed,
        };
      });

      const payer = members.find(m => m.id === payerId);
      const bill = {
        id: billId,
        flockId,
        // These two were echoed straight back off the request body. Round 16
        // fixed the TYPE (isFloat() accepts the string "90", so this endpoint
        // could answer with a string where GET /api/billing/:flockId always
        // answers with a number, and the client reaches for `?.toFixed(2)` on
        // them); the 2026-08-14 pass fixed the PRECISION, which was the same
        // mismatch a decimal place deeper. Both now come from the quantized
        // values above — the ones the columns will hold and the shares were
        // divided against.
        totalAmount: billTotal,
        tipPercent: tipPct,
        totalWithTip,
        splitType,
        // Always true on this path, because payerId is req.user.id or a validated
        // member id, never NULL. Sent anyway so the created bill and the
        // fetched bill are the same shape and the client has one field to
        // branch on rather than two. See the note in GET /:flockId.
        hasPayer: true,
        paidBy: { id: payerId, name: payer?.name || 'Unknown' },
        shares: shareDetails,
        createdAt: new Date().toISOString(),
      };

      // Answer FIRST, then notify. The response is the part the caller is
      // waiting on and the part that must not depend on Firebase being up.
      //
      // Filtered like every other view of this bill: the creator picked SHARE
      // IDS, the server supplied the names, so an unfiltered 201 would show a
      // blocked member's name once and then have it vanish on the next GET.
      // `bill` itself stays whole for the fan-out below, which needs the full
      // set to build each member's own view.
      res.status(201).json({ bill: billFor(bill, invisibleToCreator) });

      const io = req.app.get('io');
      // Per-member fan-out, membership re-read at emit time, and one payload
      // per recipient — this event names every member and what they owe, so
      // "who may receive it" was never the whole question. See emitBillCreated.
      try {
        await emitBillCreated(io, flockId, bill);
      } catch (emitErr) {
        console.error('bill_created fan-out failed:', emitErr.message);
      }

      // Push notifications for bill split. try/catch rather than `.catch()` on
      // the return value: pushIfOffline is not guaranteed to hand back a
      // promise, and a TypeError here would land in the outer catch — which is
      // exactly the "committed bill reported as a 500" failure this block was
      // moved out of the transaction to prevent.
      const payerName = payer?.name || 'Someone';
      // Concurrent fan-out: a 20-member bill was 20 sequential Firebase round
      // trips holding the request open after the response. allSettled runs them
      // at once, never rejects (so no post-commit throw reaches the outer catch),
      // and lets one failed delivery not abort the rest.
      //
      // fromUserId is the PAYER, not req.user: the block-gate suppresses a push
      // that NAMES a blocked user, and this body names the payer ("You owe
      // {payerName}"). paidBy can be set to a member other than the creator, so
      // req.user.id would leave the gate checking the wrong person. (The task
      // suggested req.user.id; payerId is what actually makes the gate do its
      // job here — flagged in the change report.)
      await Promise.allSettled(
        shares
          .filter((share) => share.userId !== payerId && !share.settled)
          .map((share) => pushIfOffline(io, share.userId,
            'Bill split created',
            `You owe ${payerName} $${share.amount.toFixed(2)} for ${flockName}`,
            { type: 'bill_created', flockId: String(flockId), fromUserId: String(payerId) }
          ))
      );
    } catch (err) {
      console.error('Bill create error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to create bill split' });
    }
  }
);

// GET /api/billing/:flockId — Get bill split for a flock
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

      const billResult = await pool.query(
        `SELECT bs.*, u.name AS payer_name
         FROM bill_splits bs
         LEFT JOIN users u ON u.id = bs.paid_by
         WHERE bs.flock_id = $1`,
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }

      const bill = billResult.rows[0];
      const totalWithTip = Math.round(parseFloat(bill.total_amount) * (1 + parseFloat(bill.tip_percent) / 100) * 100) / 100;

      const sharesResult = await pool.query(
        `SELECT bss.*, u.name FROM bill_split_shares bss
         JOIN users u ON u.id = bss.user_id
         WHERE bss.bill_id = $1
         ORDER BY bss.id`,
        [bill.id]
      );

      // Same block rule as the bill_created fan-out. Without it the socket
      // filtering was theatre: the names and amounts it withheld came straight
      // back on the next GET, which is what the client calls when it opens the
      // bill sheet.
      const invisible = new Set(await getInvisibleUserIds(userId));

      // WHOSE BILL IS THIS. paid_by NULL is not a rendering detail, it is two
      // real states the client had no way to tell apart from a finished bill
      // (bill split audit 2026-08-26), and it rendered both as "Paid by
      // Unknown" over a dollar total nobody had entered:
      //
      //   1. A ghost-commit shell. Nobody has paid anything and the total is an
      //      ESTIMATE this server computed from the group budget ceiling. The
      //      sheet offered "Settle Up" against it, which 404'd, and "Mark as
      //      Paid", which recorded a debt as paid before the debt existed.
      //   2. The payer deleted their account. bill_splits.paid_by is
      //      ON DELETE SET NULL, so the row survives with nobody on it while
      //      everyone else's share survives too. There is no one left to pay.
      //
      // Both are honestly described by one sentence, that nobody is recorded
      // as having paid this bill, and both have the same way out: post the
      // bill again naming who paid, which POST /:flockId/create allows any
      // member to do while paid_by is NULL. So one flag, not a guess between
      // two states this schema cannot distinguish after the fact.
      const hasPayer = bill.paid_by !== null && bill.paid_by !== undefined;

      // A payerless bill's numbers ARE the budget ceiling: ghost-commit writes
      // the banded ceiling into every share and ceiling * memberCount into the
      // total. routes/budget.js re-asks the reveal threshold on EVERY read, on
      // purpose, because members leave and a band around the last person left
      // is a band around one person's budget. This route published the same
      // number from a cached row and never re-asked, so it was the second door
      // out of the leak budget.js closed on the first.
      //
      // Only shells are gated: once a real bill lands the amounts are what
      // somebody actually spent, which is not a budget submission and is not
      // the ceiling's to withhold.
      let revealShellAmounts = true;
      if (!hasPayer) {
        const reveal = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${MEMBER_SUBMISSIONS}
           WHERE bs.flock_id = $1 AND skipped = false`,
          [flockId]
        );
        revealShellAmounts = (reveal.rows[0]?.n || 0) >= 3;
      }
      const money = (v) => (revealShellAmounts ? parseFloat(v) : null);

      res.json({
        bill: {
          id: bill.id,
          flockId: bill.flock_id,
          totalAmount: money(bill.total_amount),
          tipPercent: parseFloat(bill.tip_percent),
          totalWithTip: revealShellAmounts ? totalWithTip : null,
          splitType: bill.split_type,
          // Nobody is recorded as having paid. The client must not offer a way
          // to pay them or a way to mark them paid, and must not print the
          // total as a bill somebody rang up.
          hasPayer,
          paidBy: {
            id: bill.paid_by,
            name: invisible.has(bill.paid_by) ? null : bill.payer_name,
          },
          // Settled-ness over EVERY share, before the visibility filter below.
          // The client used to decide "All settled up" from the shares it could
          // see, and a viewer who has blocked a member sees one fewer row, so
          // it said the bill was settled while that member still owed.
          fullySettled: sharesResult.rows.length > 0 && sharesResult.rows.every((s) => !!s.settled),
          settledCount: sharesResult.rows.filter((s) => !!s.settled).length,
          shareCount: sharesResult.rows.length,
          shares: sharesResult.rows
            .filter((s) => !invisible.has(s.user_id))
            .map(s => ({
              userId: s.user_id,
              name: s.name,
              amount: money(s.amount),
              committed: s.committed,
              settled: s.settled,
              settledAt: s.settled_at,
            })),
          createdAt: bill.created_at,
        },
      });
    } catch (err) {
      console.error('Get bill error:', err);
      res.status(500).json({ error: 'Failed to get bill split' });
    }
  }
);

// POST /api/billing/:flockId/settle — Mark current user's share as settled
router.post('/:flockId/settle',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Membership, like every other route in this file. Share rows outlive
      // the flock_members row (leaving a flock does not delete the bill), so
      // "you have a share" was not the same test as "you are in this flock".
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Find the bill
      const billResult = await pool.query(
        'SELECT id FROM bill_splits WHERE flock_id = $1',
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }
      const billId = billResult.rows[0].id;

      // Mark as settled. Two conditions were added to this WHERE clause by the
      // bill split audit of 2026-08-26, and both of them are about real money.
      //
      // `settled IS NOT TRUE` makes a repeat tap a no-op instead of a rewrite.
      // Two things came off the rewrite. settled_at, the one record of WHEN a
      // debt was cleared, drifted forward to whenever the button was last
      // pressed. And the push at the bottom of this handler fired again on
      // every one of those taps, so any member could tell the payer they had
      // been paid back as many times as they liked, from a control that is one
      // tap deep on the bill sheet with nothing in front of it. IS NOT TRUE
      // rather than = false for the same reason the fully-settled count below
      // uses it: the column has no NOT NULL constraint.
      //
      // `EXISTS (... paid_by IS NOT NULL)` is the harder one. Settling means "I
      // paid the payer back", and a bill with paid_by NULL has no payer to have
      // paid back: it is either a ghost-commit shell, where the total is this
      // server's estimate off the group budget and nobody has bought anything
      // yet, or a bill whose payer deleted their account (paid_by is
      // ON DELETE SET NULL). Against a shell it was a free dinner. Ghost
      // commit, settle, and when the real bill finally landed
      // POST /:flockId/create carried the flag onto it. The payer is never
      // told you owe, because the notification loop skips settled shares, the
      // sheet shows you paid, and you were never billed. The carry is refused
      // at /create as well now; this is the lock on the door rather than on the
      // safe, and it is the one that keeps new rows out of that state.
      //
      // Written as one statement rather than a SELECT then an UPDATE because
      // the read would have to be its own round trip and this route's queries
      // are what several suites match on to script it, but also because a
      // check-then-write here is a race with the payer's own /create.
      const updateResult = await pool.query(
        `UPDATE bill_split_shares SET settled = true, settled_at = NOW()
         WHERE bill_id = $1 AND user_id = $2 AND settled IS NOT TRUE
           AND EXISTS (SELECT 1 FROM bill_splits WHERE id = $1 AND paid_by IS NOT NULL)
         RETURNING *`,
        [billId, userId]
      );
      if (updateResult.rows.length === 0) {
        // Nothing moved, and the three reasons are three different answers.
        // Only reached on the path where nothing was written, so the ordinary
        // settle is still two queries.
        const existing = await pool.query(
          `SELECT bss.settled, bs.paid_by
             FROM bill_split_shares bss
             JOIN bill_splits bs ON bs.id = bss.bill_id
            WHERE bss.bill_id = $1 AND bss.user_id = $2`,
          [billId, userId]
        );
        if (existing.rows.length === 0) {
          return res.status(404).json({ error: 'No share found for you on this bill' });
        }
        if (existing.rows[0].paid_by == null) {
          // The way out of both no-payer states is the same, so the message
          // names it: somebody posts the bill with a payer on it. While paid_by
          // is NULL, POST /:flockId/create applies first-bill rules, so any
          // member can do that for themselves and the flock creator can do it
          // for anyone.
          return res.status(409).json({
            error: 'Nobody is recorded as having paid this bill, so there is nothing to settle up. Add the bill again with who paid.',
            reason: 'no_payer',
          });
        }
        // Already settled. Not an error, because what the caller wanted is already
        // true, and a retry after a dropped response must not be punished.
        // 200 without re-notifying anybody.
        return res.json({ settled: true, alreadySettled: true });
      }

      // Emit settled event (per-member fan-out — see emitToFlockMembers).
      //
      // Round 16, second pass: notification is POST-COMMIT work here too. The
      // UPDATE above has already landed, so letting a fan-out failure reach the
      // outer catch would answer 500 for a debt that IS settled — the same
      // shape of bug as the /create push loop, and worse in consequence,
      // because the user then pays a second time to clear it.
      const io = req.app.get('io');
      if (io) {
        try {
          // Blocks: `userName` is the settler's name (round 2 of the same
          // audit — bill_created was not the only event here that names a
          // person). bill_fully_settled below names nobody and stays unfiltered:
          // "this bill is closed" is a fact about the bill.
          await emitToFlockMembers(io, flockId, 'share_settled', {
            flockId,
            userId,
            userName: req.user.name,
          }, await visibleRecipients(flockId, userId));

          // Round 16: `settled = false` silently ignores NULL, and the column
          // has no NOT NULL constraint — a row written by anything that omits
          // it would make the bill look fully settled while someone still owed.
          // `IS NOT TRUE` counts both.
          const unsettled = await pool.query(
            'SELECT COUNT(*) AS count FROM bill_split_shares WHERE bill_id = $1 AND settled IS NOT TRUE',
            [billId]
          );
          if (parseInt(unsettled.rows[0].count) === 0) {
            await emitToFlockMembers(io, flockId, 'bill_fully_settled', { flockId });
          }
        } catch (emitErr) {
          console.error('Settle fan-out failed:', emitErr.message);
        }
      }

      res.json({ settled: true });

      // ── THE OTHER HALF OF A BILL ──────────────────────────────────────────
      //
      // `bill_created` tells you that you OWE. Nothing told the person who
      // fronted the money that they had been paid back, so the only party with
      // an outstanding debt to track was the only party never notified about
      // it. `bill_settled` has been a declared type on all three deep-link
      // tables since they were written, with nothing emitting it; this is it.
      //
      // ONE push, to ONE person, and only when somebody actually pays. It does
      // not fan out to the flock: the rest of the table does not need to be
      // interrupted about a transfer between two other people, and the
      // `share_settled` socket event above already updates the sheet for
      // anybody looking at it.
      //
      // Post-response, own try/catch, and every query behind it is skipped
      // outright when push is not configured, so a deployment without delivery
      // pays nothing for this.
      if (isPushConfigured()) {
        try {
          // Both facts in one round trip, and only on the path that uses them.
          // The route's own `SELECT id FROM bill_splits` is deliberately left
          // alone rather than widened: it is the statement several suites match
          // on to script this route.
          const payerRow = await pool.query(
            `SELECT bs.paid_by, f.name AS flock_name
               FROM bill_splits bs
               JOIN flocks f ON f.id = bs.flock_id
              WHERE bs.id = $1`,
            [billId]
          );
          const payerId = payerRow.rows[0]?.paid_by;
          const amount = Number(updateResult.rows[0]?.amount);
          // Nobody is told they paid themselves back, and a bill with no
          // recorded payer has nobody to tell.
          if (payerId && Number(payerId) !== Number(userId)) {
            const flockName = payerRow.rows[0]?.flock_name || 'your plan';
            const money = Number.isFinite(amount) ? ` $${amount.toFixed(2)}` : '';
            // fromUserId is the SETTLER, because the body names them. Same
            // reason /create names the payer: the block gate suppresses a push
            // that carries a blocked person's name.
            // FLOCK DID NOT SEE THIS MONEY (honesty pass 2026-08-26). "You got
            // paid back" is a statement of fact about a transfer this app never
            // touched. Nothing here processes, holds, guarantees or verifies a
            // payment: /payment-links hands the debtor off to Venmo, Cash App
            // or Zelle and the debtor comes back and taps a button. All the
            // server knows is that somebody SAID they paid. A payer who reads
            // "You got paid back" and stops checking their own payment app is
            // out of pocket on Flock's word, for a fact Flock does not have.
            //
            // So the notification reports the claim and names who made it, and
            // the amount stays in it because that is the figure the payer has
            // to go and check against.
            await pushIfOffline(io, payerId,
              'Marked as paid back',
              `${req.user.name} says they paid you${money} for ${flockName}. Check your payment app.`,
              { type: 'bill_settled', flockId: String(flockId), fromUserId: String(userId) }
            );
          }
        } catch (pushErr) {
          console.error('Bill settled push error:', pushErr.message);
        }
      }
    } catch (err) {
      console.error('Settle error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to settle share' });
    }
  }
);

// POST /api/billing/:flockId/unsettle: take back a settlement you reported
//
// SETTLEMENT IS SELF-REPORTED AND WAS ONE-WAY (bill split audit 2026-08-26).
// Nothing in Flock observes a payment. The only thing that moves a share to
// settled is the debtor tapping "Mark as Paid (cash or other)", which sits one
// tap deep on the bill sheet, under the Settle Up button, with no confirmation
// in front of it and nothing that undoes it, not on this router and not anywhere
// in the app. A thumb landing an inch low erased a real debt permanently, told
// the payer they had been paid, and removed the person from the notification
// loop that would have chased them.
//
// The bill sheet's other correction path does not cover this either. Reposting
// the bill through /create deliberately PRESERVES settled rows, because the
// alternative is re-billing somebody who really did pay. So the only record
// that a debt was cleared had no way back, and the payer was the one out of
// pocket for the mistake.
//
// The rules are narrow on purpose:
//   - You may only take back your OWN report. Nobody gets to mark anybody else
//     unpaid, the same way nobody gets to mark anybody else paid.
//   - The PAYER cannot use this. Their share is settled as an artifact of
//     having paid the venue, not as a debt they cleared, and clearing that flag
//     would put them in debt to themselves.
//   - It is idempotent, and a share that was never settled is not an error.
router.post('/:flockId/unsettle',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Membership, like every other route in this file, and for the reason
      // /settle records: share rows outlive the flock_members row.
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      const billResult = await pool.query(
        'SELECT id, paid_by FROM bill_splits WHERE flock_id = $1',
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }
      const billId = billResult.rows[0].id;
      const payerId = billResult.rows[0].paid_by;

      if (payerId != null && Number(payerId) === Number(userId)) {
        return res.status(409).json({
          error: 'You are the person who paid this bill, so there is nothing of yours to mark unpaid.',
          reason: 'payer',
        });
      }

      const updateResult = await pool.query(
        `UPDATE bill_split_shares SET settled = false, settled_at = NULL
         WHERE bill_id = $1 AND user_id = $2 AND settled IS TRUE
         RETURNING *`,
        [billId, userId]
      );
      if (updateResult.rows.length === 0) {
        const existing = await pool.query(
          'SELECT settled FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
          [billId, userId]
        );
        if (existing.rows.length === 0) {
          return res.status(404).json({ error: 'No share found for you on this bill' });
        }
        // Already unsettled. What the caller wanted is already true.
        return res.json({ settled: false, alreadyUnsettled: true });
      }

      res.json({ settled: false });

      // Post-response, like every other notification in this file: the write
      // has landed and a delivery failure must not answer 500 for it.
      const io = req.app.get('io');
      if (io) {
        try {
          // Names the person who took the report back, so it is block-filtered
          // like share_settled.
          await emitToFlockMembers(io, flockId, 'share_unsettled', {
            flockId,
            userId,
            userName: req.user.name,
          }, await visibleRecipients(flockId, userId));
        } catch (emitErr) {
          console.error('Unsettle fan-out failed:', emitErr.message);
        }
      }

      // NO PUSH, and this is a deliberate gap rather than an oversight.
      //
      // The payer was told "X says they paid you $25" when the report was made,
      // so the honest thing is to tell them it was taken back. That needs a
      // `bill_unsettled` type, and a push type is not one constant: it has to
      // be added to FLOCK_SCOPED_TYPES and FLOCK_VIEW in
      // services/firebaseService.js AND to FLOCK_TYPES and VIEW_FOR_TYPE in
      // frontend/src/services/pushNavigation.js, which are pinned against each
      // other by a frontend suite. Half of that is another file's change and
      // shipping only the backend half means the notification delivers and then
      // opens the wrong screen.
      //
      // Until it exists, `share_unsettled` above reaches every connected
      // member's personal room, including the payer's, so an open bill sheet
      // corrects itself immediately. A payer who is not connected finds out the
      // next time they open the bill. Nothing tells them a debt was cleared
      // that has not been, so the correction is late for them and never wrong.
    } catch (err) {
      console.error('Unsettle error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to mark the share unpaid' });
    }
  }
);

// POST /api/billing/:flockId/ghost-commit — Pre-commit estimated share (ghost mode)
router.post('/:flockId/ghost-commit',
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

      // Get budget ceiling and member count
      const flockResult = await pool.query(
        'SELECT budget_ceiling, budget_locked, status, ghost_mode_enabled FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }

      // PRIVACY (audit 2026-08-12): this endpoint was a third door to the raw
      // ceiling. Same anonymity threshold as everywhere else, and ghost mode
      // must actually be on for a ghost commit.
      if (!flockResult.rows[0].ghost_mode_enabled) {
        return res.status(400).json({ error: 'Ghost mode is not enabled for this flock' });
      }
      // MEMBERSHIP IS THE RELATIONSHIP, on this route too (bill split audit
      // 2026-08-26). This count used to read budget_submissions with no join,
      // and routes/budget.js counts the same rows through MEMBER_SUBMISSIONS,
      // only submissions whose author is still an accepted member, because a
      // submission row is deliberately left behind when its author leaves.
      //
      // The two counts therefore diverged the moment anybody left, and they
      // diverged in the direction that publishes: three people submit, the
      // budget locks, one of them leaves, and GET /api/budget/:flockId goes
      // back to withholding the ceiling (isReady is re-evaluated on every read)
      // while this route still counted three and handed the banded ceiling out
      // as `estimatedShare`. That is the exact shape budget.js closed for its
      // own aggregates: two people plus a throwaway that submits and leaves,
      // and the band is a band around ONE of the two remaining people.
      //
      // budgetCeilingReadParity could not see it, because its pg fake answers both
      // count statements from the same number, so it was pinning the ceiling
      // VALUE the two routes publish and never the threshold each one asks.
      const thresholdResult = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${MEMBER_SUBMISSIONS}
         WHERE bs.flock_id = $1 AND skipped = false`,
        [flockId]
      );
      if ((thresholdResult.rows[0]?.n || 0) < 3) {
        return res.status(400).json({ error: 'Ghost commit opens after at least 3 people have submitted budgets' });
      }

      // Settled and banded, not raw and not live. estimatedShare below IS this
      // number on the wire and it is also WRITTEN into a bill_split_shares row
      // that GET /api/billing/:flockId serves back later, so a ghost commit
      // taken while the budget was still open would have persisted a snapshot
      // of the running minimum and let anyone difference two of them at leisure.
      // Banding is a no-op on an already-banded value, so it only ever repairs
      // a legacy row.
      const ceiling = settledCeiling(flockResult.rows[0].budget_locked, flockResult.rows[0].budget_ceiling);
      if (!ceiling) {
        return res.status(400).json({
          error: 'The group budget is not set yet, so we cannot estimate a share',
        });
      }

      // Get member count for estimated share
      const memberCountResult = await pool.query(
        "SELECT COUNT(*) AS count FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const memberCount = parseInt(memberCountResult.rows[0].count);
      // bill_splits.total_amount is DECIMAL(8,2): ceiling (up to 10,000) times
      // a large roster overflowed the column and surfaced as a 500 instead of
      // a placeholder bill.
      const estimatedTotal = Math.min(Math.round(ceiling * memberCount * 100) / 100, 999999.99);
      const estimatedShare = ceiling;

      // Create or find placeholder bill
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        let billId;
        const existingBill = await client.query(
          'SELECT id, paid_by FROM bill_splits WHERE flock_id = $1',
          [flockId]
        );

        if (existingBill.rows.length > 0) {
          // A ghost commit is a pre-commitment made BEFORE anyone has paid, so
          // it only ever belongs on a placeholder shell (paid_by NULL). Against
          // a real bill it was a write primitive on someone else's split
          // (audit 2026-08-13): a member left out of a custom split could
          // INSERT themselves a share at the budget ceiling, and any member
          // could flip `committed` on rows the payer had already finalized.
          // Inserting that share also handed them /payment-links, which
          // discloses the payer's Venmo, Cash App and Zelle handles.
          if (existingBill.rows[0].paid_by !== null) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'The bill for this flock is already in, so there is nothing to pre-commit' });
          }
          billId = existingBill.rows[0].id;
        } else {
          // Create placeholder bill.
          //
          // ON CONFLICT, because bill_splits carries UNIQUE(flock_id) and this
          // path takes no flock row lock the way POST /:flockId/create does.
          // The "Lock in your share?" card appears for every member the moment
          // the venue is confirmed, so two people tapping Commit inside the
          // same second is the ordinary case, not a rare one: both read no
          // existing bill, the second INSERT raised 23505, the whole
          // transaction rolled back, and that member got "Failed to commit"
          // with nothing recorded. A second tap then worked, so it read as a
          // random glitch. DO UPDATE rather than DO NOTHING so the row is
          // always returned; the write is a no-op on the column it touches.
          const newBill = await client.query(
            `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent)
             VALUES ($1, $2, 'equal', NULL, 0)
             ON CONFLICT (flock_id) DO UPDATE SET flock_id = EXCLUDED.flock_id
             RETURNING id, paid_by`,
            [flockId, estimatedTotal]
          );
          // The row we lost the race to could be a real posted bill, which is
          // the same state the branch above refuses. Undefined is not "there is
          // a payer": it is a driver or a fake that did not return the column,
          // and a freshly inserted row has none by construction.
          if (newBill.rows[0].paid_by !== null && newBill.rows[0].paid_by !== undefined) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'The bill for this flock is already in, so there is nothing to pre-commit' });
          }
          billId = newBill.rows[0].id;
        }

        // Upsert the user's share with committed=true
        await client.query(
          `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled)
           VALUES ($1, $2, $3, true, false)
           ON CONFLICT (bill_id, user_id) DO UPDATE
           SET committed = true`,
          [billId, userId, estimatedShare]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // Emit socket event (per-member fan-out — see emitToFlockMembers).
      // Post-commit, so a fan-out failure must not 500 a committed commitment.
      const io = req.app.get('io');
      if (io) {
        try {
          // Blocks: names a person AND the money they just committed to.
          await emitToFlockMembers(io, flockId, 'ghost_committed', {
            flockId,
            userId,
            userName: req.user.name,
            estimatedShare,
          }, await visibleRecipients(flockId, userId));
        } catch (emitErr) {
          console.error('Ghost commit fan-out failed:', emitErr.message);
        }
      }

      res.json({ committed: true, estimatedShare });
    } catch (err) {
      console.error('Ghost commit error:', err);
      res.status(500).json({ error: 'Failed to commit' });
    }
  }
);

// GET /api/billing/:flockId/venmo-link — Generate Venmo deep-link
router.get('/:flockId/venmo-link',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // These routes disclose the payer's Venmo / Cash App / Zelle handles, so
      // they need the same membership test as the rest of the file. Holding a
      // share row is not the same thing: share rows survive leaving the flock,
      // so an ex-member kept pulling the payer's payment handles forever.
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Get the bill
      const billResult = await pool.query(
        `SELECT bs.id, bs.paid_by, bs.flock_id, f.name AS flock_name
         FROM bill_splits bs
         JOIN flocks f ON f.id = bs.flock_id
         WHERE bs.flock_id = $1`,
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }
      const bill = billResult.rows[0];
      if (await refuseIfBlockedPayer(res, userId, bill.paid_by)) return;
      if (noPayerRefusal(res, bill.paid_by)) return;

      // Get the user's share
      const shareResult = await pool.query(
        'SELECT amount FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
        [bill.id, userId]
      );
      if (shareResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you' });
      }
      const amount = parseFloat(shareResult.rows[0].amount);

      // Get payer's venmo username
      const payerResult = await pool.query(
        'SELECT name, venmo_username FROM users WHERE id = $1',
        [bill.paid_by]
      );
      if (payerResult.rows.length === 0) {
        return res.status(404).json({ error: 'Payer not found' });
      }

      const payer = payerResult.rows[0];
      if (!payer.venmo_username) {
        return res.json({
          deepLink: null,
          webLink: null,
          amount,
          payTo: payer.name,
          note: `Flock - ${bill.flock_name}`,
          reason: 'no_venmo',
        });
      }

      const note = encodeURIComponent(`Flock - ${bill.flock_name}`);
      // Round 16: the handle was interpolated RAW into both links. Payment
      // handles are free text — routes/users.js validates only `max 50 chars`
      // and strips a leading '@' — so a payer could store
      // `me&amount=500` and every member who tapped "Pay" got a link carrying
      // a SECOND amount parameter after the real one. Whichever the wallet app
      // reads last wins, and the member sees Flock's own UI quoting the honest
      // figure. Encoding the handle makes the query string un-splittable.
      // (Cross-area: users.js should also constrain these to the character sets
      // the wallets actually allow — reported, not edited, it is not my file.)
      const venmoUser = encodeURIComponent(payer.venmo_username);

      res.json({
        deepLink: `venmo://paycharge?txn=pay&recipients=${venmoUser}&amount=${amount}&note=${note}`,
        webLink: `https://venmo.com/${venmoUser}?txn=pay&amount=${amount}&note=${note}`,
        amount,
        payTo: payer.name,
        note: `Flock - ${bill.flock_name}`,
      });
    } catch (err) {
      console.error('Venmo link error:', err);
      res.status(500).json({ error: 'Failed to generate Venmo link' });
    }
  }
);

// GET /api/billing/:flockId/payment-links — Generate all payment options for settle-up
router.get('/:flockId/payment-links',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Same membership gate as /venmo-link — this response carries the payer's
      // Venmo, Cash App and Zelle identifiers.
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Get the bill
      const billResult = await pool.query(
        `SELECT bs.id, bs.paid_by, bs.flock_id, f.name AS flock_name
         FROM bill_splits bs
         JOIN flocks f ON f.id = bs.flock_id
         WHERE bs.flock_id = $1`,
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }
      const bill = billResult.rows[0];
      if (await refuseIfBlockedPayer(res, userId, bill.paid_by)) return;
      if (noPayerRefusal(res, bill.paid_by)) return;

      // Get the user's share amount
      const shareResult = await pool.query(
        'SELECT amount FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
        [bill.id, userId]
      );
      if (shareResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you' });
      }
      const amount = parseFloat(shareResult.rows[0].amount);

      // Get payer's payment details
      const payerResult = await pool.query(
        'SELECT name, venmo_username, cashapp_cashtag, zelle_identifier FROM users WHERE id = $1',
        [bill.paid_by]
      );
      if (payerResult.rows.length === 0) {
        return res.status(404).json({ error: 'Payer not found' });
      }

      const payer = payerResult.rows[0];
      const note = `Flock - ${bill.flock_name}`;
      const encodedNote = encodeURIComponent(note);
      const methods = [];

      // Round 16: same raw-interpolation problem as /venmo-link, on all three
      // methods — see the comment there. `handle` stays human-readable (it is
      // rendered as text, not parsed as a URL); only the URLs are encoded.
      if (payer.venmo_username) {
        const u = payer.venmo_username;
        const uEnc = encodeURIComponent(u);
        methods.push({
          method: 'venmo',
          label: 'Venmo',
          handle: `@${u}`,
          deepLink: `venmo://paycharge?txn=pay&recipients=${uEnc}&amount=${amount}&note=${encodedNote}`,
          webLink: `https://venmo.com/${uEnc}?txn=pay&amount=${amount}&note=${encodedNote}`,
        });
      }

      if (payer.cashapp_cashtag) {
        const tag = payer.cashapp_cashtag;
        const tagEnc = encodeURIComponent(tag);
        methods.push({
          method: 'cashapp',
          label: 'Cash App',
          handle: `$${tag}`,
          deepLink: `cashapp://cash.app/pay/$${tagEnc}?amount=${amount}&note=${encodedNote}`,
          webLink: `https://cash.app/$${tagEnc}/${amount}`,
        });
      }

      if (payer.zelle_identifier) {
        methods.push({
          method: 'zelle',
          label: 'Zelle',
          handle: payer.zelle_identifier,
          deepLink: null,
          webLink: null,
          instructions: `Open your banking app and send $${amount.toFixed(2)} to ${payer.zelle_identifier} via Zelle`,
        });
      }

      res.json({ amount, payTo: payer.name, note, methods });
    } catch (err) {
      console.error('Payment links error:', err);
      res.status(500).json({ error: 'Failed to generate payment links' });
    }
  }
);

module.exports = router;
