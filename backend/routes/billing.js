const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const { pushIfOffline } = require('../services/pushHelper');

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
            if (row.settled) existingSettled.set(row.user_id, row.settled_at || new Date());
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
          const wasSettled = existingSettled.has(share.userId);
          const settledAt = isPayer ? new Date() : (existingSettled.get(share.userId) || null);
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

      res.json({
        bill: {
          id: bill.id,
          flockId: bill.flock_id,
          totalAmount: parseFloat(bill.total_amount),
          tipPercent: parseFloat(bill.tip_percent),
          totalWithTip,
          splitType: bill.split_type,
          paidBy: {
            id: bill.paid_by,
            name: invisible.has(bill.paid_by) ? null : bill.payer_name,
          },
          shares: sharesResult.rows
            .filter((s) => !invisible.has(s.user_id))
            .map(s => ({
              userId: s.user_id,
              name: s.name,
              amount: parseFloat(s.amount),
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

      // Mark as settled
      const updateResult = await pool.query(
        `UPDATE bill_split_shares SET settled = true, settled_at = NOW()
         WHERE bill_id = $1 AND user_id = $2
         RETURNING *`,
        [billId, userId]
      );
      if (updateResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you on this bill' });
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
    } catch (err) {
      console.error('Settle error:', err);
      res.status(500).json({ error: 'Failed to settle share' });
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
        'SELECT budget_ceiling, status, ghost_mode_enabled FROM flocks WHERE id = $1',
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
      const thresholdResult = await pool.query(
        `SELECT COUNT(*)::int AS n FROM budget_submissions WHERE flock_id = $1 AND skipped = false`,
        [flockId]
      );
      if ((thresholdResult.rows[0]?.n || 0) < 3) {
        return res.status(400).json({ error: 'Ghost commit opens after at least 3 people have submitted budgets' });
      }

      const ceiling = flockResult.rows[0].budget_ceiling ? parseFloat(flockResult.rows[0].budget_ceiling) : null;
      if (!ceiling) {
        return res.status(400).json({ error: 'No budget ceiling set, so we cannot estimate a share' });
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
          // Create placeholder bill
          const newBill = await client.query(
            `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent)
             VALUES ($1, $2, 'equal', NULL, 0)
             RETURNING id`,
            [flockId, estimatedTotal]
          );
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
