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

// THE TALLY OVER EVERY ROW, after a settlement moved. GET /:flockId computes
// fullySettled, settledCount and shareCount over all rows and then sends
// `shares` with anyone the viewer has blocked removed, so the client's header
// cannot be rebuilt from the array it holds. share_settled and share_unsettled
// name the actor and are therefore block-filtered, which left a viewer who had
// blocked the actor holding a header that could not move again until a
// refresh: it kept saying All settled up over a debt that had been taken back
// (adversarial audit round 2, 2026-09-05). This tally names nobody, so it goes
// to every member, and it rides on the settle and unsettle responses too so
// the actor's own sheet sets it rather than guessing. `IS TRUE` for the reason
// the old count used IS NOT TRUE: settled has no NOT NULL constraint.
async function billTallyFor(billId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS share_count,
            COUNT(*) FILTER (WHERE settled IS TRUE)::int AS settled_count
       FROM bill_split_shares WHERE bill_id = $1`,
    [billId]
  );
  const shareCount = Number(rows[0]?.share_count) || 0;
  const settledCount = Number(rows[0]?.settled_count) || 0;
  return { shareCount, settledCount, fullySettled: shareCount > 0 && settledCount === shareCount };
}
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

// WHAT IS STILL OWED ON A SHARE, decided in one place for every reader that
// publishes it: the 201 body of /create, GET /:flockId, the two payment-link
// routes and the settle push. bill_split_shares.paid_amount (migration 061) is
// what this person had already paid before the current version of the bill
// was posted, and `settled` says the rest was paid too, so the figure to ask
// for is the share less the credit while unsettled and nothing once settled.
// Integer cents, because that is the only representation in which "100 minus
// 30" is exactly 70 and not a float that renders as 69.99999. Never negative:
// a share revised below what was paid is owed BACK, and that is a number for
// the sheet to show beside the credit, not a debt to put in a Venmo link.
function outstandingOn(amount, paidAmount, settled) {
  if (settled) return 0;
  const shareCents = Math.round(Number(amount) * 100);
  const paidCents = Math.round(Number(paidAmount == null ? 0 : paidAmount) * 100);
  if (!Number.isFinite(shareCents)) return 0;
  return Math.max(0, shareCents - (Number.isFinite(paidCents) ? paidCents : 0)) / 100;
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
      // The one figure every split below is checked against and divided from,
      // in the integer cents all of the arithmetic is done in.
      const totalCents = Math.round(totalWithTip * 100);

      // WHAT THE CLIENT ASKED FOR IS NOT ALWAYS WHAT HAPPENED (money audit
      // 2026-09-04). The branch below takes the custom path only when there is
      // actually a list of typed amounts to honour, so a client that sends
      // splitType 'custom' before anybody has typed anything, which is the shape
      // the bill sheet posts while the custom fields are still blank, runs the
      // EQUAL split. The INSERT underneath then wrote the REQUESTED split type
      // into bill_splits.split_type regardless. A $90 bill over three members
      // was stored as 'custom' over three identical $30 shares nobody had
      // chosen, GET /:flockId handed that back as the split type the client
      // renders, and the sheet opened an "edit these amounts" affordance on
      // numbers the payer had never seen. The record of how the bill was
      // actually divided was simply wrong, quietly, on a row nobody would think
      // to doubt. effectiveSplit is what this route DID, and it is what both the
      // column and the response body carry from here down.
      const useCustomShares = !!(splitType === 'custom' && customShares && customShares.length > 0);
      const effectiveSplit = useCustomShares ? 'custom' : 'equal';

      // Filled inside the transaction, after the membership check and before
      // anything is written; see the note where it is read.
      let invisibleToCreator;

      // Existing-bill authorization + preserved states are read INSIDE the
      // transaction below, under the flock row lock — checking here let two
      // concurrent "first" bills both pass and the loser silently overwrite
      // the winner without being its payer (round 5).
      const existingCommitments = new Map();
      const existingSettled = new Map();
      // What each of them has PAID so far, in cents, which is not the same
      // thing as whether they are settled. A settled flag was carried onto a
      // rewritten share without ever comparing the two amounts, so re-posting
      // a corrected, higher total left the row reading "Bob $50.00, paid" over
      // a $25 payment, and the notification loop skips settled rows so Bob was
      // never told the bill had gone up. Then the comparison was added and it
      // fixed the flag while losing the money: Bob's $25 was cleared off the
      // row along with the flag, /payment-links asked him for the whole $50,
      // and a Bob who trusted the app paid $75 against a $50 share. The credit
      // now rides on its own column (bill_split_shares.paid_amount, migration
      // 061) and this map is what feeds it. The reading rule is in the loop
      // that fills it.
      const existingPaidCents = new Map();
      // Cents that people who are no longer on this split have already handed
      // over. Filled under the flock lock below; spent by the credit block that
      // sits just above the UPSERT, which is where the reasoning lives.
      let retainedPaidCents = 0;
      // How many of those people's rows the second DELETE below leaves on the
      // bill. The 201 body and the bill_created payload carry the same three
      // tallies GET /:flockId computes over every row, and these rows are
      // the ones `shares` does not hold once the response is built.
      let retainedRowCount = 0;
      // Rows of departed people whose allocation has to be restated as what
      // they paid so the sheet still adds up. See the credit block.
      const retainedRewrites = [];

      // EVERYTHING THAT DECIDES WHO IS IN THIS FLOCK, WHO MAY TOUCH THE BILL
      // AND WHO THE MONEY GOES TO IS READ UNDER THE LOCK (adversarial audit
      // 2026-09-04). The membership check, the payer check and the roster used
      // to be read on the pool before the transaction opened, with the row
      // lock taken only afterwards to serialise the write. That left a window
      // between the reads and the BEGIN in which the world could change and
      // the request would carry on with the old one. Bob starts posting the
      // bill naming himself as payer, leaves the flock before this handler
      // reaches BEGIN, and the stale request commits a bill payable to a
      // person who is no longer in the flock. Bob cannot open the bill sheet
      // any more (every route here checks membership), and the creator cannot
      // hand the bill to anybody else, because the rule below reserves a payer
      // change for the outgoing payer, who cannot reach it either. The bill is
      // stuck with the money pointed at somebody who has left.
      //
      // So the transaction opens FIRST, the flock row is locked, and every
      // read this handler makes a decision from happens inside it. What that
      // buys is exact and worth stating exactly: the reads and the write are
      // now one transaction, so the roster this bill is divided across and the
      // payer it is written against are the ones that existed when the lock was
      // taken, not some earlier moment. What it does not buy is a lock on the
      // membership table itself. routes/flocks.js does not take this row lock
      // to leave or remove somebody, so a departure can still commit between
      // the read and the COMMIT below; closing that fully means that route
      // taking the same lock, which is that file's change and not this one.
      //
      // A refusal in here is a ROLLBACK and then the answer, in that order.
      // Nothing has been written at any of those points, and the rollback is
      // what releases the row lock for the next request on this flock.
      const client = await pool.connect();
      let billId;
      let members;
      let shares;
      let flockName;
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
        const refuse = async (status, payload) => {
          await client.query('ROLLBACK');
          res.status(status).json(payload);
        };

        // Verify membership
        const memberCheck = await client.query(
          "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
          [flockId, userId]
        );
        if (memberCheck.rows.length === 0) {
          return refuse(403, { error: 'You are not a member of this flock' });
        }

        // Verify payer is a member
        const payerCheck = await client.query(
          "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
          [flockId, payerId]
        );
        if (payerCheck.rows.length === 0) {
          return refuse(400, { error: 'Payer must be a member of the flock' });
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
        const membersResult = await client.query(
          `SELECT u.id, u.name FROM flock_members fm
           JOIN users u ON u.id = fm.user_id
           WHERE fm.flock_id = $1 AND fm.status = 'accepted'
           ORDER BY u.id`,
          [flockId]
        );
        members = membersResult.rows;
        if (members.length === 0) {
          return refuse(400, { error: 'No accepted members in this flock' });
        }

        // Read PRE-COMMIT, on purpose. It only shapes the 201 body, but every
        // query after the COMMIT below is post-commit work: a throw there
        // answers 500 for a bill that exists, and the client's retry rewrites
        // the split it thinks failed. Asking here means a block-lookup failure
        // is a clean 500 with nothing written. It sits after the membership
        // check for the same reason every other read does: a caller who is
        // not in this flock gets the 403 and nothing else is looked up on
        // their behalf. It goes through the pool rather than the client
        // because utils/blocks.js owns that query, and a block is a fact
        // about two people, not about the row this transaction holds.
        invisibleToCreator = new Set(await getInvisibleUserIds(userId));

        // Get flock name + creator. creator_id is an authorization input for
        // the existing-bill rules below, which is why it is read in here.
        const flockResult = await client.query('SELECT name, creator_id FROM flocks WHERE id = $1', [flockId]);
        flockName = flockResult.rows[0]?.name || 'Flock';
        const flockCreatorId = flockResult.rows[0]?.creator_id;

        // The SHAPE of a custom split is checked here, against the roster just
        // read. The SUM is not, and that is deliberate: what the typed shares
        // have to add up to depends on what people who have left this split
        // already paid, and that is not known until the existing rows have
        // been read further down. One sum check, in one place, against the
        // right figure. See the credit block.
        let parsed = null;
        if (useCustomShares) {
          // Round 16: `s.amount` was read straight off each element, so a single
          // `null` or a bare string in the array threw a TypeError that surfaced
          // as a 500 from the outer catch. Malformed input is a 400.
          if (customShares.some(s => s === null || typeof s !== 'object' || Array.isArray(s))) {
            return refuse(400, { error: 'Each custom share must be an object with userId and amount' });
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
          parsed = customShares.map(s => ({
            userId: parseInt(s.userId),
            cents: Math.round(parseFloat(s.amount) * 100),
          }));

          // Round 3: every amount finite and non-negative, no duplicate users —
          // negative shares could offset an oversized one and NaN skipped the
          // total check entirely. Checked BEFORE the sum, so NaN cannot poison it.
          if (parsed.some(s => !Number.isFinite(s.cents) || s.cents < 0)) {
            return refuse(400, { error: 'Every share must be a valid non-negative amount' });
          }
          if (new Set(parsed.map(s => s.userId)).size !== parsed.length) {
            return refuse(400, { error: 'Each member can appear only once in custom shares' });
          }
          // Access control: every share must belong to an accepted flock member —
          // otherwise arbitrary user ids could be assigned debt + pushed notifications.
          const memberIds = new Set(members.map(m => m.id));
          const invalidShare = parsed.find(s => !Number.isFinite(s.userId) || !memberIds.has(s.userId));
          if (invalidShare) {
            return refuse(400, { error: 'All custom shares must be for members of this flock' });
          }
        }

        // WHO the new split is for is known before HOW MUCH each of them owes,
        // and the two are separated on purpose: the credit taken below is
        // decided over the rows that are NOT on this list, and the amounts on
        // the list depend on that credit. Exactly the rows the two DELETEs
        // further down will leave behind, decided from the same id list those
        // statements are handed, so the credit and the retention rule cannot
        // drift apart.
        const plannedShareIds = new Set(useCustomShares ? parsed.map((s) => s.userId) : members.map((m) => m.id));

        // Authorize replacement against the row that actually exists at commit
        // time, under the lock taken above.
        const existingBill = await client.query(
          'SELECT id, paid_by FROM bill_splits WHERE flock_id = $1',
          [flockId]
        );
        if (existingBill.rows.length === 0 && payerId !== userId && userId !== flockCreatorId) {
          // Round 6: creating the FIRST bill with someone else as payer let any
          // member assign visible debts in another member's name. Only the
          // payer themselves (or the flock creator) can open a bill.
          return refuse(403, { error: 'Only the person who paid can start the bill' });
        }
        // Whether anything already on this bill can count as money. A shell
        // (paid_by NULL) has nobody to have been paid, so nothing on it is a
        // payment, and the DELETE below is handed this so it clears every
        // departed row on a shell rather than sparing a flag that was never a
        // receipt.
        let hadRealPayer = false;
        // The payer this rewrite is taking the bill away from, or null. Read
        // by the DELETE block below, which is outside the branch that learns
        // it, so it lives out here.
        let formerPayerId = null;
        if (existingBill.rows.length > 0) {
          const prevPayer = existingBill.rows[0].paid_by;
          // A ghost-commit shell has paid_by NULL — nobody has claimed the
          // bill yet, so first-bill rules apply, not replacement rules
          // (round 7: NULL rejected every legitimate first payer).
          if (prevPayer === null) {
            if (payerId !== userId && userId !== flockCreatorId) {
              return refuse(403, { error: 'Only the person who paid can start the bill' });
            }
          } else if (userId !== prevPayer && userId !== flockCreatorId) {
            // A former payer retrying a handoff whose response was lost lands
            // here too, and the server cannot tell them from a bystander who
            // names the current payer (no idempotency ledger yet; Codex round 3,
            // 2026-09-05). The refusal carries the bill id so the client
            // re-reads the bill instead of staying on its stale state.
            return refuse(403, { error: 'Only the person who paid or the flock creator can change this bill', billId: existingBill.rows[0].id, code: 'NOT_PAYER' });

          } else if (payerId !== prevPayer && userId !== prevPayer) {
            // WHO MAY EDIT IS NOT WHO MAY BECOME THE PAYER.
            //
            // The clause above lets the flock creator correct a bill they did
            // not pay, which is the point of it: somebody has to be able to fix
            // a typed total when the payer has gone home. But nothing then
            // constrained `paidBy`, and `paid_by` is what GET /payment-links
            // resolves to a Venmo, Cash App and Zelle handle.
            //
            // So the creator could POST the same bill back with themselves as
            // payer. The loop below drops the outgoing payer's auto-settled row
            // (correctly - see the note on it), so Alice, who actually handed
            // the restaurant $200, is re-inserted owing $50; every other member
            // is pushed "you owe Carol $50"; and the payment links now serve
            // Carol's handles. One request, no exploit, and the money goes to
            // the wrong person.
            //
            // The claim can still be TRANSFERRED, because a payer giving up
            // their own receivable is theirs to give - that is the case
            // money.test.js pins. What cannot happen is somebody else moving it
            // onto themselves.
            return refuse(403, { error: 'Only the person who paid can hand this bill to someone else' });
          }
          hadRealPayer = prevPayer !== null;
          if (prevPayer !== null && prevPayer !== payerId) formerPayerId = prevPayer;
          const shareResult = await client.query(
            // `amount` and `paid_amount` ARE LOAD-BEARING, not decoration. They
            // feed existingPaidCents, which is the only thing that decides
            // whether a settled flag survives a revision and what the revised
            // share is credited with. `amount` was missing from this list once,
            // so `Number(row.amount)` was Number(undefined) = NaN; `typeof NaN
            // === 'number'` passes, and every comparison against NaN is false,
            // so the upward-revision guard was false for every share on every
            // edit. A settled row survived any increase, and the push loop at
            // the bottom only notifies UNSETTLED shares, so a $100 bill
            // re-posted at $400 left everyone who had already paid $25 marked
            // paid, told nothing, and the payer $75 short with no record of it.
            // money.test.js pins the SELECT list because the fake hands back
            // whatever the fixture holds whether or not the SQL asked for it.
            'SELECT user_id, amount, paid_amount, committed, settled, settled_at FROM bill_split_shares WHERE bill_id = $1',
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
            //
            // THE FLAG IS THE ARTIFACT; THE MONEY IS NOT (adversarial audit
            // round 2, 2026-09-05). This used to `continue` past the former
            // payer's row entirely, which did two wrong things. Their
            // paid_amount, if any, was paid on an earlier version of this bill
            // when somebody else was payer, and skipping the row forgot it: if
            // they were on the new split their new share carried no credit.
            // And if they were NOT on the new split, the row was neither
            // counted nor restated here, and the DELETE below kept it because
            // it read settled = true, so a settled row at the old share amount
            // stayed on the bill: the sheet's rows summed above the total, GET
            // showed a row this response and bill_created did not, and the
            // "payer" it recorded as paid had paid nothing. The row is read
            // instead as UNSETTLED, worth exactly its credit, the way any
            // other row is; the flag itself is cleared on the row just before
            // the DELETE so that statement sees the same thing this loop did.
            const payerArtifact = row.user_id === prevPayer && prevPayer !== payerId;
            const rowSettled = row.settled && !payerArtifact;
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
            // It covers the credit too: an estimate somebody "settled" on a
            // shell is not money this bill has collected, so a departed
            // committer's shell row is neither credited nor kept.
            if (prevPayer === null) continue;
            // WHAT THIS PERSON HAS PAID, read the way migration 061 defines the
            // two columns. paid_amount is what was credited from earlier
            // versions of the bill; settled says the rest of the current share
            // was paid too. So an unsettled row has paid exactly its credit,
            // and a settled row has paid the larger of its share and its
            // credit (larger, because a share revised DOWN below a payment
            // keeps the flag and the payment both). A row whose numbers are not
            // numbers has paid nothing this code can vouch for and is skipped:
            // that is a corrupt row rather than a payment, and letting NaN into
            // a sum would ruin every share on the bill instead of leaving one
            // row uncounted.
            const amountCents = Math.round(Number(row.amount) * 100);
            const creditCents = Math.round(Number(row.paid_amount == null ? 0 : row.paid_amount) * 100);
            if (!Number.isFinite(amountCents) || !Number.isFinite(creditCents)) continue;
            const paidCents = rowSettled ? Math.max(amountCents, creditCents) : creditCents;
            if (!plannedShareIds.has(row.user_id)) {
              // The second DELETE below keeps this row when it is settled or
              // carries a credit, and every kept row ends the rewrite settled:
              // it already was, or it is restated to its credit just under
              // the DELETE. Counted here for the tallies on the response.
              if (rowSettled || creditCents > 0) retainedRowCount += 1;
              // Somebody who has paid and is not on the new split keeps their
              // row, because that row is the only record that they paid. What
              // they paid is money this bill has already collected, so it is
              // banked here and taken off the total the remaining roster is
              // asked to cover. If the row does not already read as "paid this
              // much, nothing outstanding" it is restated below so that it
              // does; the reason is with the credit block.
              if (paidCents > 0) {
                retainedPaidCents += paidCents;
                if (!rowSettled || paidCents !== amountCents) {
                  retainedRewrites.push({ userId: row.user_id, paidCents });
                }
              }
              continue;
            }
            if (rowSettled) existingSettled.set(row.user_id, row.settled_at || new Date());
            if (paidCents > 0) existingPaidCents.set(row.user_id, paidCents);
          }
        }

        // CREDIT WHAT THE PEOPLE WHO LEFT HAVE ALREADY PAID (money audit
        // 2026-09-04). This is the second half of sparing their settled rows,
        // and until now it was recorded at the DELETE below as a known gap
        // rather than done.
        //
        // Keeping a settled row for somebody the rewrite dropped is right,
        // because they paid. Nothing then took what they paid off the new
        // total, so the shares stopped summing to the bill and the people still
        // on it covered the difference. Four friends, $100, $25 each; Bob pays
        // his $25 and leaves the flock; the payer corrects the total to $120;
        // the equal split ran over the three who were left at $40 each, Bob's
        // settled $25 stayed on the sheet, and the sheet came to $145 for a $120
        // dinner. Carol and Dave were each out $8.33, the payer collected more
        // than they spent, and fullySettled in GET /:flockId ranged over Bob's
        // stale row on top of that.
        //
        // The remaining roster now covers the total MINUS what those rows
        // already carry, in the same integer cents and under the same
        // deterministic leftover rule the equal split uses, so the sheet adds
        // to the total exactly again. That $120 reads $31.67, $31.67, $31.66
        // beside Bob's retained $25, which is $120.00 to the cent.
        //
        // The custom branch was refused rather than corrected, and it still is
        // when the typed numbers do not reach the right figure: the payer typed
        // those numbers, and quietly scaling them to fit a credit they were
        // never shown would be this route inventing a split nobody asked for,
        // which is the same kind of lie as storing 'custom' over an equal
        // split. What changed (adversarial audit 2026-09-04) is that the custom
        // branch could not be SUBMITTED at all once a credit existed. The sum
        // used to be checked against the full total before the credit had been
        // read, and then refused again if it did not equal the remainder, and
        // no list of numbers satisfies both. So a payer who took the 400 at its
        // word and retyped the shares to the figure it named got the other 400
        // instead. There is one sum check now, here, against the remainder,
        // and its refusal names the amount already paid and the figure the
        // typed shares have to reach so the payer can actually retype them.
        //
        // A departed person's allocation is what they paid. That is what
        // "the remaining roster covers the rest" means, and it is also the only
        // way the rows on the sheet can add up to the total. A row of theirs
        // that says otherwise, because the bill went up after they paid and
        // before they left, or went down below what they paid, is restated
        // to their credit and marked settled: the one restatement here that is
        // not a lie, because nobody is being asked for anything they did not
        // already hand over.
        const remainingCents = totalCents - retainedPaidCents;
        if (remainingCents < 0) {
          // More has been paid than the corrected bill is worth. There is no
          // division of a negative number that is not somebody being handed
          // money they are not owed, so this one is the payer's to sort out
          // with the people who left, not the route's to guess at.
          return refuse(400, {
            error: `People who are no longer in this split have already paid $${(retainedPaidCents / 100).toFixed(2)} toward this bill, which is more than the new total of $${totalWithTip.toFixed(2)}. Pay them back directly or raise the total.`,
          });
        }

        // Calculate shares
        if (useCustomShares) {
          const sumRefusal = () => (retainedPaidCents > 0
            ? `People who are no longer in this split have already paid $${(retainedPaidCents / 100).toFixed(2)} toward this bill, so custom shares must add up to $${(remainingCents / 100).toFixed(2)}, not $${totalWithTip.toFixed(2)}`
            : `Custom shares must add up to $${totalWithTip.toFixed(2)}`);
          const sumCents = parsed.reduce((sum, s) => sum + s.cents, 0);
          const remainder = remainingCents - sumCents;
          if (Math.abs(remainder) > 2) {
            return refuse(400, { error: sumRefusal() });
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
              return refuse(400, { error: sumRefusal() });
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
          const baseCents = Math.floor(remainingCents / memberCount);
          const remainderCents = remainingCents - baseCents * memberCount;

          shares = members.map((m, i) => ({
            userId: m.id,
            amount: (baseCents + (i < remainderCents ? 1 : 0)) / 100,
          }));
        }

        // UPSERT bill_splits
        const billResult = await client.query(
          `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (flock_id) DO UPDATE
           SET total_amount = $2, split_type = $3, paid_by = $4, tip_percent = $5, updated_at = NOW()
           RETURNING id`,
          [flockId, billTotal, effectiveSplit, payerId, tipPct]
        );
        billId = billResult.rows[0].id;

        // Delete existing shares (for re-creation). A blanket DELETE here
        // erased SETTLED rows for anyone the rewrite dropped from the split,
        // and a settled row is the only record that a debt was ever paid
        // (audit 2026-08-13). Two edits then re-issued a paid debt: rewrite
        // once with custom shares that omit Bob (his settled row is gone),
        // rewrite again including Bob, and he is billed a second time with no
        // trace of the first payment. Rows still in the split are rewritten
        // just below; rows dropped from it only go if nothing has been paid on
        // them, which since migration 061 means unsettled AND no carried
        // credit, because a person who paid $25 of a $40 share and then left
        // has a record that is worth exactly as much as a settled one.
        //
        // The gap this comment used to record, that a retained row was never
        // credited against the new total, is closed by the block above: what
        // those rows carry comes off the total before the remaining roster
        // divides it. Read that block for the arithmetic. The one rule to keep
        // in step is which rows survive, because the credit is taken over
        // precisely the set these two statements leave behind, and the loop
        // that banks the credit and the third parameter here answer the same
        // question the same way: on a bill that never had a payer nothing is a
        // payment, so nothing of a departed person's is kept.
        const keepIds = shares.map((s) => s.userId);
        // The former payer's settled flag was an artifact of having paid the
        // venue, and the credit loop above read their row without it. The
        // DELETE that follows has to see the same row the loop saw, or a
        // row worth nothing survives on the flag alone (see the loop).
        if (formerPayerId !== null) {
          await client.query(
            'UPDATE bill_split_shares SET settled_at = NULL, settled = false WHERE bill_id = $1 AND user_id = $2',
            [billId, formerPayerId]
          );
        }
        await client.query(
          'DELETE FROM bill_split_shares WHERE bill_id = $1 AND user_id = ANY($2::int[])',
          [billId, keepIds]
        );
        await client.query(
          `DELETE FROM bill_split_shares
           WHERE bill_id = $1 AND user_id <> ALL($2::int[])
             AND ($3::boolean OR (settled = false AND paid_amount = 0))`,
          [billId, keepIds, !hadRealPayer]
        );
        for (const rewrite of retainedRewrites) {
          await client.query(
            `UPDATE bill_split_shares SET amount = $3, paid_amount = $3, settled = true
             WHERE bill_id = $1 AND user_id = $2`,
            [billId, rewrite.userId, rewrite.paidCents / 100]
          );
        }

        // Insert shares. What was paid survives the rewrite (a paid debt
        // must not silently become unpaid because the bill was edited, and a
        // payment must not silently become unpaid either)
        for (const share of shares) {
          const isPayer = share.userId === payerId;
          const wasCommitted = existingCommitments.has(share.userId);
          const newCents = Math.round(share.amount * 100);
          // A payment survives a rewrite for exactly its amount. What this
          // person paid against the old share rides across as paid_amount, and
          // the flag is then a plain consequence: if the payment covers the new
          // share they are settled (square, or ahead, and un-settling a paid
          // debt is the bug this whole branch exists to avoid), and if it does
          // not they owe the difference, the sheet says so, and the push loop
          // below can tell them the bill moved because their row is unsettled.
          // Nothing they paid is asked for twice in either direction, and a
          // share revised below a payment keeps the payment on the row, which
          // is the record of what they are owed back. The payer's own row
          // carries no credit: it is settled as an artifact of having paid the
          // venue, and they are not a debtor on their own bill.
          const carriedCents = isPayer ? 0 : (existingPaidCents.get(share.userId) || 0);
          const coveredByCredit = carriedCents > 0 && carriedCents >= newCents;
          const settledAt = isPayer ? new Date() : (coveredByCredit ? (existingSettled.get(share.userId) || null) : null);
          share.settled = isPayer || coveredByCredit; // response mirrors DB truth (round 3)
          share.committed = wasCommitted;
          share.paidAmount = carriedCents / 100;
          share.outstanding = share.settled ? 0 : (newCents - carriedCents) / 100;
          await client.query(
            `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, settled_at, paid_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [billId, share.userId, share.amount, wasCommitted, share.settled, settledAt, share.paidAmount]
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
          // Same two fields GET /:flockId serves, so the sheet the creator
          // sees straight after posting and the sheet after a refresh agree
          // about who has paid what and who still owes what.
          paidAmount: s.paidAmount,
          outstanding: s.outstanding,
          settled: !!s.settled,
          committed: !!s.committed,
        };
      });

      const payer = members.find(m => m.id === payerId);
      // Settled-ness over EVERY row the bill holds after this rewrite, counted
      // the way GET /:flockId counts it: the shares just written plus the rows
      // kept for people who paid and left. billTally in the client reads these
      // three beside a `shares` array that has anyone the viewer blocked
      // removed, so the denominator has to come from here. GET sent all three
      // and this route sent none, so straight after posting a bill, or on
      // receiving bill_created, a viewer who had blocked one of three sharers
      // counted the two rows they could see and read "All settled up" over the
      // blocked person's open share until the next refresh.
      const shareCount = shares.length + retainedRowCount;
      const settledCount = shares.filter((s) => s.settled).length + retainedRowCount;
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
        // effectiveSplit, not the requested splitType: the 201 body and the
        // socket payload have to say what the route did, for the same reason
        // the column does. See the note where it is derived.
        splitType: effectiveSplit,
        // Always true on this path, because payerId is req.user.id or a validated
        // member id, never NULL. Sent anyway so the created bill and the
        // fetched bill are the same shape and the client has one field to
        // branch on rather than two. See the note in GET /:flockId.
        hasPayer: true,
        paidBy: { id: payerId, name: payer?.name || 'Unknown' },
        fullySettled: shareCount > 0 && settledCount === shareCount,
        settledCount,
        shareCount,
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
          // The OUTSTANDING figure, not the share. Somebody who paid $30
          // against a share that is now $100 owes $70, and "You owe $100.00"
          // was the sentence that had Ben paying $130 for a $100 share.
          .map((share) => pushIfOffline(io, share.userId,
            'Bill split created',
            `You owe ${payerName} $${share.outstanding.toFixed(2)} for ${flockName}`,
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
              // The credit carried from earlier versions of this bill and
              // what is still owed after it, see outstandingOn. Both are
              // money, so both are withheld on a shell the reveal rule hides.
              paidAmount: money(s.paid_amount == null ? 0 : s.paid_amount),
              outstanding: revealShellAmounts ? outstandingOn(s.amount, s.paid_amount, s.settled) : null,
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
      //
      // AND IT TAKES THE FLOCK LOCK, because one statement is not enough
      // against /create. That route BEGINs, holds
      // `SELECT id FROM flocks WHERE id = $1 FOR UPDATE`, READS the existing
      // shares, and only then DELETEs and re-INSERTs them from that snapshot.
      // A settle landing anywhere in that window commits, returns 200, sends
      // the payer "Bob says they paid you $25" - and is then erased, because
      // /create re-inserts Bob's row with settled = false out of a snapshot
      // taken before he paid. The sheet says he owes it again and the money is
      // already gone. Serialising on the same row is what closes it; the
      // statement below stays single because everything it guards is still
      // true.
      const client = await pool.connect();
      let updateResult;
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
        updateResult = await client.query(
          `UPDATE bill_split_shares SET settled = true, settled_at = NOW()
           WHERE bill_id = $1 AND user_id = $2 AND settled IS NOT TRUE
             AND EXISTS (SELECT 1 FROM bill_splits WHERE id = $1 AND paid_by IS NOT NULL)
           RETURNING *`,
          [billId, userId]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
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
        // The no-op answer carries the tally too, or a retry after a lost
        // response leaves the client on a stale count (Codex round 3).
        return res.json({ settled: true, alreadySettled: true, bill_tally: await billTallyFor(billId) });
      }

      // Emit settled event (per-member fan-out — see emitToFlockMembers).
      //
      // Round 16, second pass: notification is POST-COMMIT work here too. The
      // UPDATE above has already landed, so letting a fan-out failure reach the
      // outer catch would answer 500 for a debt that IS settled — the same
      // shape of bug as the /create push loop, and worse in consequence,
      // because the user then pays a second time to clear it.
      // The tally after the write. Post-commit work, so a failure here is
      // logged and the response still says what is true: the debt is settled.
      let tally = null;
      try { tally = await billTallyFor(billId); } catch (tallyErr) {
        console.error('Settle tally failed:', tallyErr.message);
      }
      const io = req.app.get('io');
      if (io) {
        try {
          // Blocks: `userName` is the settler's name (round 2 of the same
          // audit — bill_created was not the only event here that names a
          // person). bill_fully_settled and bill_tally below name nobody and
          // stay unfiltered: "this bill is closed" and "2 of 3 rows are
          // settled" are facts about the bill.
          await emitToFlockMembers(io, flockId, 'share_settled', {
            flockId,
            userId,
            userName: req.user.name,
          }, await visibleRecipients(flockId, userId));

          if (tally) {
            await emitToFlockMembers(io, flockId, 'bill_tally', { flockId, ...tally });
            if (tally.fullySettled) {
              await emitToFlockMembers(io, flockId, 'bill_fully_settled', { flockId });
            }
          }
        } catch (emitErr) {
          console.error('Settle fan-out failed:', emitErr.message);
        }
      }

      res.json({ settled: true, ...(tally || {}) });

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
          // What this tap cleared is the share less whatever was already
          // credited to it from an earlier version of the bill, which is the
          // figure the payer has to look for in their payment app. The row
          // came back from RETURNING * already marked settled, so the
          // outstanding is asked for as it stood before the UPDATE.
          const settledRow = updateResult.rows[0] || {};
          const amount = outstandingOn(settledRow.amount, settledRow.paid_amount, false);
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

      // EVERY READ THIS ROUTE DECIDES ON HAPPENS UNDER THE FLOCK LOCK, on the
      // connection that writes (adversarial audit round 2, 2026-09-05). The
      // membership check and the paid_by read used to run on the pool before
      // the transaction began, so a request could pass both, wait on the lock
      // behind a /create that was making this caller the payer, and then clear
      // the auto-settled payer row that /create had just written: the payer
      // "owed" themselves and the sheet said so. A departure in the same
      // window let a former member take a report back after leaving. Both
      // reads now sit inside BEGIN, after the lock, so nothing that takes the
      // same lock can move between them and the UPDATE.
      //
      // Membership, like every other route in this file, and for the reason
      // /settle records: share rows outlive the flock_members row.
      //
      // `paid_amount < amount` is the credit rule from migration 061. A share
      // whose carried credit already covers it was marked settled by the bill
      // edit that carried the credit, not by a tap, so there is no report to
      // take back and clearing the flag would put somebody who has paid in
      // full back on the sheet as owing. That case is told apart below and
      // refused with its own reason.
      const client = await pool.connect();
      let updateResult;
      let billId;
      let payerId;
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
        const memberCheck = await client.query(
          "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
          [flockId, userId]
        );
        if (memberCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'You are not a member of this flock' });
        }
        const billResult = await client.query(
          'SELECT id, paid_by FROM bill_splits WHERE flock_id = $1',
          [flockId]
        );
        if (billResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'No bill found for this flock' });
        }
        billId = billResult.rows[0].id;
        payerId = billResult.rows[0].paid_by;
        if (payerId != null && Number(payerId) === Number(userId)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'You are the person who paid this bill, so there is nothing of yours to mark unpaid.',
            reason: 'payer',
          });
        }
        updateResult = await client.query(
          `UPDATE bill_split_shares SET settled = false, settled_at = NULL
           WHERE bill_id = $1 AND user_id = $2 AND settled IS TRUE AND paid_amount < amount
           RETURNING *`,
          [billId, userId]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      if (updateResult.rows.length === 0) {
        const existing = await pool.query(
          'SELECT settled, amount, paid_amount FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
          [billId, userId]
        );
        if (existing.rows.length === 0) {
          return res.status(404).json({ error: 'No share found for you on this bill' });
        }
        const row = existing.rows[0];
        if (row.settled && outstandingOn(row.amount, row.paid_amount, false) === 0) {
          return res.status(409).json({
            error: 'What you paid on an earlier version of this bill already covers your share, so there is nothing to mark unpaid.',
            reason: 'credit',
          });
        }
        // Already unsettled. What the caller wanted is already true.
        return res.json({ settled: false, alreadyUnsettled: true, bill_tally: await billTallyFor(billId) });
      }

      // The tally after the write; see billTallyFor. Post-commit, logged on
      // failure, and the response still says what is true.
      let tally = null;
      try { tally = await billTallyFor(billId); } catch (tallyErr) {
        console.error('Unsettle tally failed:', tallyErr.message);
      }
      res.json({ settled: false, ...(tally || {}) });

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
          // And the tally, to everyone, naming nobody: the one event a viewer
          // who has blocked this person still receives, so their header can
          // come back down from All settled up.
          if (tally) await emitToFlockMembers(io, flockId, 'bill_tally', { flockId, ...tally });
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

      // EVERY READ UNDER THE FLOCK LOCK, on the connection that writes
      // (adversarial audit round 2, 2026-09-05). Membership, ghost mode, the
      // three-person threshold, the settled ceiling and the member count were
      // all read on the pool before this transaction began. A member could
      // pass every check, leave the flock (a departure takes this same lock
      // and commits), and then resume here and write a share as a former
      // member; and a contributor leaving in the same gap let the stored
      // estimate be computed over a count the budget route would already
      // refuse to publish. Inside BEGIN, after the lock, nothing that takes
      // the lock can move between these reads and the INSERT below.
      //
      // THE SAME ROW /create HOLDS. The paid_by IS NULL check further down is
      // the guard that keeps a ghost commit off a real bill, and without this
      // lock it is a check-then-write across a transaction boundary: read
      // paid_by NULL, let /create run to completion with a custom split, then
      // INSERT anyway. The result is a share row on a bill that now has a
      // payer - which is the write primitive on someone else's split that
      // check exists to prevent, and which also passes the
      // `shareResult.rows.length === 0` gate in /payment-links and hands the
      // committer the payer's Venmo, Cash App and Zelle identifiers.
      const client = await pool.connect();
      let estimatedShare;
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);

        // Verify membership
        const memberCheck = await client.query(
          "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
          [flockId, userId]
        );
        if (memberCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'You are not a member of this flock' });
        }

        // Get budget ceiling and member count
        const flockResult = await client.query(
          'SELECT budget_ceiling, budget_locked, status, ghost_mode_enabled FROM flocks WHERE id = $1',
          [flockId]
        );
        if (flockResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Flock not found' });
        }

        // PRIVACY (audit 2026-08-12): this endpoint was a third door to the raw
        // ceiling. Same anonymity threshold as everywhere else, and ghost mode
        // must actually be on for a ghost commit.
        if (!flockResult.rows[0].ghost_mode_enabled) {
          await client.query('ROLLBACK');
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
        const thresholdResult = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${MEMBER_SUBMISSIONS}
           WHERE bs.flock_id = $1 AND skipped = false`,
          [flockId]
        );
        if ((thresholdResult.rows[0]?.n || 0) < 3) {
          await client.query('ROLLBACK');
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
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'The group budget is not set yet, so we cannot estimate a share',
          });
        }

        // Get member count for estimated share
        const memberCountResult = await client.query(
          "SELECT COUNT(*) AS count FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
          [flockId]
        );
        const memberCount = parseInt(memberCountResult.rows[0].count);
        // bill_splits.total_amount is DECIMAL(8,2): ceiling (up to 10,000) times
        // a large roster overflowed the column and surfaced as a 500 instead of
        // a placeholder bill.
        const estimatedTotal = Math.min(Math.round(ceiling * memberCount * 100) / 100, 999999.99);
        estimatedShare = ceiling;

        // Create or find placeholder bill
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

      // Get the user's share. The link carries what is still OWED, which is
      // the share less anything already credited to it from an earlier
      // version of the bill (migration 061); handing a wallet app the whole
      // share was how a person who had paid $30 got asked for $100.
      const shareResult = await pool.query(
        'SELECT amount, settled, paid_amount FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
        [bill.id, userId]
      );
      if (shareResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you' });
      }
      const shareRow = shareResult.rows[0];
      const shareAmount = parseFloat(shareRow.amount);
      const paidAmount = shareRow.paid_amount == null ? 0 : parseFloat(shareRow.paid_amount);
      const amount = outstandingOn(shareRow.amount, shareRow.paid_amount, shareRow.settled);

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
          shareAmount,
          paidAmount,
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
        shareAmount,
        paidAmount,
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

      // Get the user's share. `amount` below is what is still OWED, which
      // every link and the Zelle instruction carry, and it is the share less
      // anything already credited to it from an earlier version of the bill
      // (migration 061). The share and the credit ride alongside so the sheet
      // can say "$70.00 of $100.00, $30.00 already paid" instead of a bare
      // figure nobody can reconcile.
      const shareResult = await pool.query(
        'SELECT amount, settled, paid_amount FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
        [bill.id, userId]
      );
      if (shareResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you' });
      }
      const shareRow = shareResult.rows[0];
      const shareAmount = parseFloat(shareRow.amount);
      const paidAmount = shareRow.paid_amount == null ? 0 : parseFloat(shareRow.paid_amount);
      const amount = outstandingOn(shareRow.amount, shareRow.paid_amount, shareRow.settled);

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

      res.json({ amount, shareAmount, paidAmount, payTo: payer.name, note, methods });
    } catch (err) {
      console.error('Payment links error:', err);
      res.status(500).json({ error: 'Failed to generate payment links' });
    }
  }
);

module.exports = router;
