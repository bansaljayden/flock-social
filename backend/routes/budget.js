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
//
// AND THE SAME THRESHOLD IS A FACT ABOUT ONE NUMBER, WHICH IS NOT WHAT WAS
// LEAKING (round 23).
//
// Everything above bounds the VALUE of a single read: over three or more
// co-members, "one of them skipped" names nobody. It says nothing about a
// SEQUENCE of those reads, and the sequence was published live on every
// surface, on every submission, exactly as the ceiling used to be. Both deltas
// range over one person rather than three:
//
//   * A submission moves submissionCount by one. skipCount moves with it or it
//     does not, and that bit is the answer the person who just answered gave.
//     The threshold does not touch it: the delta is over the single row that
//     was just written no matter how many co-members the total ranges over.
//   * A DEPARTURE moves both, and a departure is not anonymous. Every aggregate
//     on this router reads only rows whose author is still an accepted member
//     (see MEMBER_SUBMISSIONS), and the roster is on the screen, so a member
//     leaving is an event with a name on it. skipCount falling by one as they
//     go says they skipped; submissionCount falling while skipCount holds says
//     they shared an amount. No collusion, no second account, no arithmetic
//     past one subtraction, and nothing to know out of band: you watch the
//     screen, which is the sentence the ceiling fix was written for.
//
// So the split follows the ceiling's rule rather than its own: it is published
// in exactly one payload, the one that settles the budget, and never on a read.
// One number, no earlier number to subtract it from, and a departure after the
// settle cannot move a number nobody is being shown any more. The threshold
// above still gates that single publication, because a single read of it in a
// small flock was a real finding and closing the sequence does not close that.
//
// Nothing renders this. It is stored in App.js's budget state and read from
// there nowhere, so withholding it costs the product nothing at all; what it
// costs is the one channel on this route that still moved.
const SKIP_COUNT_MIN_OTHERS = 3;
function publishableSkipCount(skipCount, totalMembers) {
  return (totalMembers - 1) >= SKIP_COUNT_MIN_OTHERS ? skipCount : null;
}

// A LIVE CEILING IS A DIFFERENCE, AND THE DIFFERENCE NAMES A PERSON (round 22).
//
// Everything above this line is about the VALUE that gets published. This is
// about WHEN, and the when was the leak. No collusion, no second account, no
// arithmetic beyond subtraction: you watch the screen.
//
// The ceiling was recomputed and broadcast on every submission. It is a MIN, so
// it only ever moves when a new minimum arrives. Three people submit, the
// number appears. The fourth person submits and the number DROPS, and every
// member watching sees the count go 3 to 4 and the ceiling move in the same
// instant. That pair of observations attributes the new band to exactly one
// person, and the person it attributes it to is always the one with the least
// money, because nobody else can move a minimum. The two members who had not
// even submitted yet learn it too.
//
// The feature exists so that nobody has to say "that is too expensive" in front
// of six people. Publishing a live minimum said it for them, by name.
//
// Banding does not fix this. It is a fix for the VALUE (an interval instead of
// an exact figure) and it was doing that job. It cannot fix a sequence: two
// banded numbers still differ, and the difference is still attributable.
//
// THE FIX IS THAT THERE IS ONLY EVER ONE NUMBER. A ceiling is published when
// the budget is SETTLED and never before, and once settled it does not move, so
// there is no before-and-after pair left to subtract:
//
//   - Before the budget is locked, every surface publishes aggregate only:
//     submissionCount, totalMembers, isReady. Never a ceiling. "3 of 4
//     answered" is coordination and it stays; the number is not.
//   - The budget settles when the last member has answered (submitted or
//     skipped) with at least three shared amounts, and /submit locks it in the
//     same transaction that records that last answer. The creator can also
//     settle it early with POST /lock once three amounts exist, which is the
//     same single publication one action sooner.
//   - After that, budget_locked refuses further submissions (the check at the
//     top of the submit transaction), so a late amount BELOW the published cap
//     is turned away rather than silently excluded. Refusing is the honest of
//     the two options: quietly dropping someone's number would mean the group
//     is shown a cap that a present member cannot actually afford, which is the
//     one guarantee the ceiling has to keep. The person is told the budget is
//     already set, which is true and is a thing they can act on out loud.
//
// Two consequences worth stating plainly, because they are costs and not
// details. Answers close the moment everyone has answered, so "Change" is gone
// after that, and a member who joins a settled flock cannot submit at all. Both
// follow from publishing once; a second publication is the leak.
//
// flocks.budget_ceiling therefore means THE PUBLISHED NUMBER, not the running
// minimum. Nothing writes it until the budget settles, so an unlocked flock
// carries NULL there, and a reader that forgets the gate below still has
// nothing to leak. That is deliberate: this file has now been the subject of
// two separate audit findings whose shape was "one of the five readers forgot".
// (routes/flocks.js drops budget_ceiling from research_analytics for a flock
// that never settled, which is correct: there was no group number.)
function settledCeiling(budgetLocked, cachedCeiling) {
  if (!budgetLocked) return null;
  return bandCeiling(cachedCeiling);
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

// AND A GUEST'S ANSWER BINDS THE NUMBER BUT CANNOT BE THE CROWD.
//
// A share link can answer the budget (routes/guest.js POST /:token/budget;
// migration 071 adds budget_submissions.guest_rsvp_id). Two different
// questions are asked of the rows, and they get two different fragments:
//
//   MEMBER_SUBMISSIONS, above, is THE CROWD: the rows a published number can
//   hide a person in. It stays accounts only. The three-amount floor exists
//   because a MIN over fewer people is one person's figure, and a guest row is
//   minted by whoever holds the link, with no account, no invitation and no
//   departure, twelve an hour from one address. If those rows could be the
//   crowd, a creator alone in a plan could mint two, answer ten thousand on
//   each, answer their own number, and read the band of it back off the link:
//   the "two people plus a throwaway" shape the MEMBERSHIP note closed, for
//   free. So every threshold in this file, in routes/flocks.js and in
//   routes/billing.js counts accounts only, and a guest never makes three:
//   THIS fragment while the budget is open, and the crowd it settled over
//   once it has (settledCrowdHolds, below), which is member rows too.
//
//   PRESENT_ANSWERS, below, is WHO HAS ANSWERED AND WHAT BINDS: members plus
//   guests, each on the terms of their own presence. A guest's number is in
//   the MIN (a cap somebody going cannot afford is not a cap) and their row
//   counts toward "everyone has answered"; a guest who flips to out, is hidden
//   by a moderator, or joins for real (the join hides the guest row) leaves
//   both in the same statement a departed member does, and comes back with
//   their answer if they come back.
//
// THE SHAPE. Callers own the WHERE clause (every reader appends its own
// `WHERE bs.flock_id = $1 AND skipped = false`), so presence has to be
// enforced inside the FROM fragment. Two LEFT JOINs, one per kind of author,
// and an inner join on "one of them matched" does that without moving a
// predicate into the callers. bm.id and bg.id are non-NULL exactly when the
// row's author is present, and a row has one author (CHECK
// budget_submissions_one_author), so a row is never counted twice; and
// `bm.id IS NOT NULL` inside a COUNT FILTER is how one statement over this
// fragment still counts the crowd.
const PRESENT_ANSWERS = `budget_submissions bs
           LEFT JOIN flock_members bm ON bm.flock_id = bs.flock_id AND bm.user_id = bs.user_id
            AND bm.status = 'accepted'
           LEFT JOIN guest_rsvps bg ON bg.id = bs.guest_rsvp_id AND bg.flock_id = bs.flock_id
            AND bg.status = 'in' AND COALESCE(bg.is_hidden, false) = false
           JOIN (SELECT 1) present ON (bm.id IS NOT NULL OR bg.id IS NOT NULL)`;

// WHO HAS TO ANSWER. The denominator of "3 of 6 answered" and of the settle
// decision: accepted members plus visible 'in' guests, which is who the roster
// shows as going. The member count is also returned on its own, because the
// skip/share split is published over the CROWD (see publishableSkipCount): a
// link holder's guest rows must not be able to push a two-member plan over
// that floor. Two statements rather than one, on purpose: the member count is
// the statement every budget fixture already models, and a guest count of
// zero is what every plan that exists today has. `run` is the query function,
// so the settle can ask inside its transaction and the reads can ask on the
// pool.
const GUEST_ANSWERERS_SQL = `SELECT COUNT(*) AS total FROM guest_rsvps
   WHERE flock_id = $1 AND status = 'in' AND COALESCE(is_hidden, false) = false`;
async function answeringPopulation(run, flockId) {
  const memberResult = await run(
    "SELECT COUNT(*) AS total FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
    [flockId]
  );
  const guestResult = await run(GUEST_ANSWERERS_SQL, [flockId]);
  const members = parseInt((memberResult.rows && memberResult.rows[0] && memberResult.rows[0].total) || 0);
  const guests = parseInt((guestResult.rows && guestResult.rows[0] && guestResult.rows[0].total) || 0);
  return { total: members + guests, members, guests };
}

// ONCE SETTLED, THE CROWD IS THE ONE IT SETTLED OVER.
//
// Every threshold above asks "do three present members still share an
// amount?", and before the settle that is the right question: nothing has
// been published, and the number will be published over whoever is present
// when it settles. After the settle it was the wrong question, and asking it
// on every read leaked. The number is frozen by then (settledCeiling). It was
// computed over the answers present at the settle and shown to everybody
// present, so a departure can neither change it nor take it back from anyone
// who saw it. What a departure could change was the answer to "still three?",
// and the roster names who left. Three members share, the budget settles, one
// of the three leaves, and the number vanished from every reader at once:
// everybody watching had just been told that the person who left had shared
// an amount rather than skipped. That is the bit publishableSkipCount stopped
// publishing on reads, moving through isReady and the ceiling instead, and
// withholding the number protected nobody, because everyone it could be about
// had already been shown it.
//
// So a SETTLED budget is gated on the crowd it settled over: every
// member-authored row that shared an amount, present or not. Leaving deletes
// no row (see MEMBERSHIP) and a settled budget accepts no answer, so this
// count does not move when somebody walks out. Every lock this code takes
// requires three present member sharers first, so for those the gate always
// holds. It keeps one job: a flock locked by the first version of the lock
// route, which had no threshold at all, and holding fewer than three shared
// amounts stays withheld rather than being published now over one or two
// people. A guest row is never the crowd, here as everywhere else.
//
// The one event that still moves it is an account deletion, which cascades
// that account's rows away: a settled flock sitting on exactly three shared
// amounts withholds again when one of the three deletes their account.
//
// An OPEN budget still counts present members through MEMBER_SUBMISSIONS:
// it publishes no number, and its isReady is what the creator's Lock is
// gated on. `settledSharersOf` is the same count as a correlated subquery for
// the statements that read many flocks at once (routes/flocks.js); flockRef is
// always a column reference written in this codebase, never request input.
const settledSharersOf = (flockRef) => `(SELECT COUNT(*) FROM budget_submissions bs
     WHERE bs.flock_id = ${flockRef} AND bs.skipped = false AND bs.user_id IS NOT NULL)`;
const SETTLED_SHARERS_SQL = `SELECT COUNT(*)::int AS n FROM budget_submissions bs
   WHERE bs.flock_id = $1 AND bs.skipped = false AND bs.user_id IS NOT NULL`;
async function settledCrowdHolds(run, flockId) {
  const r = await run(SETTLED_SHARERS_SQL, [flockId]);
  return Number((r && r.rows && r.rows[0] && r.rows[0].n) || 0) >= 3;
}
// Settled AND over a crowd of three, in one statement, for a reader that has
// not read the flock row itself (the shell read in routes/billing.js). The
// cached column rides along so shownCeiling, below, can hand back the number
// itself from the same read.
const SETTLED_NUMBER_SHOWN_SQL = `SELECT f.budget_locked, f.budget_ceiling,
          (f.budget_locked IS TRUE AND ${settledSharersOf('f.id')} >= 3) AS shown
   FROM flocks f WHERE f.id = $1`;
async function settledNumberShown(run, flockId) {
  const r = await run(SETTLED_NUMBER_SHOWN_SQL, [flockId]);
  return !!(r && r.rows && r.rows[0] && r.rows[0].shown === true);
}
// THE PUBLISHED NUMBER ITSELF, or null wherever settledNumberShown says no.
// An estimate bill (routes/billing.js GET) serves this and never the figure a
// ghost commit stored. A stored figure is only as good as the day it was
// written: the first versions of the ghost commit copied the cached column
// while it was still the live, unbanded minimum, with no threshold in front of
// it, so an old row can hold one person's exact answer. This is the number
// every reader is allowed to show, banded again on the way out like every
// other read of the column (settledCeiling).
async function shownCeiling(run, flockId) {
  const r = await run(SETTLED_NUMBER_SHOWN_SQL, [flockId]);
  const row = r && r.rows && r.rows[0];
  if (!row || row.shown !== true) return null;
  return settledCeiling(row.budget_locked, row.budget_ceiling);
}

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

// ---------------------------------------------------------------------------
// ONE SETTLE, ONE PUBLICATION, TWO DOORS.
//
// POST /submit (a member) and routes/guest.js POST /:token/budget (a guest
// holding the invite link) each write their own row and then run exactly this:
// recompute the MIN over present rows, count them, read the population, lock
// the flock if this answer completed it, and publish the same aggregate the
// same way. The statements and their order are the ones the privacy fixtures
// model; a second door that recomputed them its own way would be the "one of
// the readers forgot" finding this file has already had twice.
//
// settleIfComplete runs INSIDE the caller's transaction, after the caller's
// own upsert, with the flock row already held FOR UPDATE.
// ---------------------------------------------------------------------------
async function settleIfComplete(client, flockId) {
  // Recalculate ceiling: MIN of non-skipped amounts from PRESENT rows (see
  // MEMBER_SUBMISSIONS: a departed account's cent used to set this forever).
  const ceilingResult = await client.query(
    `SELECT MIN(amount) AS ceiling FROM ${PRESENT_ANSWERS}
     WHERE bs.flock_id = $1 AND skipped = false`,
    [flockId]
  );
  // Band it before anything else can see it. The cached column is read by
  // GET /api/budget/:flockId here, by the flock list and flock detail in
  // routes/flocks.js, and by the ghost commit in routes/billing.js; banding on
  // the way IN is what makes every one of those surfaces publish the band
  // rather than one person's exact amount.
  const ceiling = bandCeiling(ceilingResult.rows[0].ceiling);

  // Count submissions, over present rows only, same as the MIN above: the
  // non-skip count IS the privacy threshold, so a row from someone who left
  // was borrowing anonymity for a flock that does not have it.
  //
  // non_skip_count is THE CROWD (member sharers, `bm.id IS NOT NULL`); the
  // other two range over everyone present. See the note above PRESENT_ANSWERS
  // for why a guest's amount binds the number and never counts toward three.
  const countResult = await client.query(
    `SELECT
       COUNT(*) AS total_submissions,
       COUNT(*) FILTER (WHERE skipped = false AND bm.id IS NOT NULL) AS non_skip_count,
       COUNT(*) FILTER (WHERE skipped = true) AS skip_count
     FROM ${PRESENT_ANSWERS} WHERE bs.flock_id = $1`,
    [flockId]
  );
  const countRow = countResult.rows[0];

  // The population is read INSIDE the transaction, because the settle
  // decision below is made from it: "everyone has answered" is a comparison
  // between two counts, and reading one of them from a different snapshot is
  // how a flock settles on a roster that no longer exists.
  const population = await answeringPopulation((q, p) => client.query(q, p), flockId);
  const totalMembers = population.total;

  // SETTLE, ONCE. Everyone who has to answer has, and at least three of them
  // shared an amount, so this is the last moment at which a number can be
  // published without a previous number to subtract it from. The flock row
  // is held FOR UPDATE, so exactly one answer wins this branch; anything
  // arriving after it meets budget_locked at the top of its transaction and
  // is refused.
  //
  // Below the three-amount floor nothing settles and nothing is written, even
  // when everybody has answered: the group can still reach three by someone
  // turning a skip into an amount, and locking would take that away for a
  // number we are not allowed to publish anyway.
  const everyoneAnswered = totalMembers > 0
    && parseInt(countRow.total_submissions) >= totalMembers;
  const settledNow = everyoneAnswered && parseInt(countRow.non_skip_count) >= 3 && !!ceiling;
  if (settledNow) {
    // Same statement as POST /lock, deliberately: settling is settling, and
    // flocks.budget_ceiling is written by exactly these two places and holds
    // exactly the number that was published.
    await client.query(
      'UPDATE flocks SET budget_locked = true, budget_ceiling = $2, updated_at = NOW() WHERE id = $1',
      [flockId, ceiling]
    );
  }
  return { ceiling, countRow, totalMembers, memberCount: population.members, settledNow };
}

// What the answerer is told and what the room is told: one object.
//
// isReady means "enough amounts have been shared for a number to be
// publishable", which is what the creator's Lock button is gated on. It is
// NOT "here is the number": the ceiling goes out only in the answer that
// settled the budget (see settledCeiling), and the skip/share split on the
// same terms (see publishableSkipCount). Every other answer carries null in
// both, so a member watching the screen has no earlier number to subtract.
//
// The split's floor is measured over the CROWD (memberCount), not the
// population: a link holder's guest rows must not push a two-member plan over
// "three co-members" and hand out a count the two of them can subtract.
function answerPayload({ countRow, ceiling, totalMembers, memberCount, settledNow }) {
  const submissionCount = parseInt(countRow.total_submissions);
  const skipCount = parseInt(countRow.skip_count);
  const nonSkipCount = parseInt(countRow.non_skip_count);
  const crowd = Number.isFinite(Number(memberCount)) ? Number(memberCount) : 0;
  return {
    ceiling: settledNow ? ceiling : null,
    submissionCount,
    totalMembers,
    isReady: nonSkipCount >= 3,
    skipCount: settledNow ? publishableSkipCount(skipCount, crowd) : null,
    budgetLocked: settledNow,
  };
}

// Per-member fan-out, not the `flock:{id}` room, so a member sitting anywhere
// else in the app still gets the budget-ready signal. This carries the SAME
// value the REST response carries, which matters twice over: a raw MIN
// reaching the socket while REST published a band would hand back the value
// fix, and a live ceiling reaching the socket while REST withheld it would
// hand back the sequence fix, which is the one this payload used to leak on
// every keystroke. Guarded so a fan-out failure cannot 500 an answer that
// already committed.
//
// memberCount rides on the room's copy only, and the room is accepted members.
// It is the part of totalMembers that can make the three (a guest's answer
// binds the number and never counts toward three), so the app can say "no
// group number in a flock this size" about two members and three guests
// instead of telling them a number appears once three people have shared,
// which three of them already have. It is a roster count every member already
// reads off the flock itself; no amount and no answer moves it. The guest
// door's own reply does not carry it.
async function emitAnswer(io, flockId, payload, memberCount) {
  if (!io) return;
  const members = Number.isFinite(Number(memberCount)) ? { memberCount: Number(memberCount) } : {};
  await emitToFlockMembers(io, flockId, 'budget_updated', { flockId, ...payload, ...members })
    .catch((e) => console.error('budget_updated fan-out failed:', e.message));
}

// Push "Budget set!" on the settling answer, which happens at most once per
// flock because the budget is locked from here on. Runs AFTER the response,
// inside its own try/catch, and fans out with allSettled, for the reason
// billing.js records: pushIfOffline is not guaranteed to hand back a promise,
// so a synchronous throw here, while this sat before the response, landed in
// the outer catch and answered a budget that had already settled in the
// transaction with a 500 that a retry then refuses. The settle is committed by
// this point, so a delivery failure must not unwind it, and a twenty-member
// fan-out must not be twenty sequential Firebase round trips the answerer
// waits on. `exceptUserId` is the member who just answered (they are looking
// at it); a guest's answer has nobody to exclude.
async function pushBudgetSet(io, flockId, ceiling, exceptUserId) {
  if (!ceiling) return;
  try {
    const flockNameResult = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
    const flockName = flockNameResult.rows[0]?.name || 'Flock';
    const membersResult = exceptUserId != null
      ? await pool.query(
        "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
        [flockId, exceptUserId]
      )
      : await pool.query(
        "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
    await Promise.allSettled(
      membersResult.rows.map((m) => pushIfOffline(io, m.user_id,
        'Budget set!',
        `Group budget: up to $${formatMoney(ceiling)} for ${flockName}`,
        { type: 'budget_ready', flockId: String(flockId) }
      ))
    );
  } catch (pushErr) {
    console.error('Budget set push fan-out failed:', pushErr.message);
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

      // PRIVACY INVARIANT: submission, ceiling recompute, counting, and the
      // settle decision run in ONE transaction holding the flock row lock. As
      // autocommit queries, a concurrent skip could slip between this route's
      // checks and /lock's count, letting the lock emit a ceiling backed by <3
      // submissions. Individual amounts never leave the server on any path; the
      // aggregate that can leave is the BANDED ceiling, and it leaves only in
      // the request that settles the budget (see settledCeiling above).
      const client = await pool.connect();
      let countRow;
      let ceiling;
      let totalMembers = 0;
      let memberCount = 0;
      let settledNow = false;
      try {
        await client.query('BEGIN');

        const flockCheck = await client.query(
          'SELECT budget_enabled, budget_locked, status FROM flocks WHERE id = $1 FOR UPDATE',
          [flockId]
        );
        if (flockCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Flock not found' });
        }
        if (flockCheck.rows[0].status === 'completed' || flockCheck.rows[0].status === 'cancelled') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'This plan is finished and cannot accept budget submissions',
            code: 'FLOCK_CLOSED',
          });
        }
        if (!flockCheck.rows[0].budget_enabled) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
        }
        if (flockCheck.rows[0].budget_locked) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Budget has been locked' });
        }

        // UPSERT budget submission
        await client.query(
          `INSERT INTO budget_submissions (flock_id, user_id, amount, skipped, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (flock_id, user_id) DO UPDATE
           SET amount = $3, skipped = $4, updated_at = NOW()`,
          [flockId, userId, skipped ? null : amount, !!skipped]
        );

        // The recompute, the counts, the population and the settle decision
        // live in settleIfComplete above, because the guest door
        // (routes/guest.js POST /:token/budget) runs the identical sequence
        // after its own upsert, and a second copy of it would be the next
        // "one of the doors forgot" finding.
        ({ ceiling, countRow, totalMembers, memberCount, settledNow } = await settleIfComplete(client, flockId));

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      // Answer, then tell the room, then push, in that order, from one shape
      // (answerPayload / emitAnswer / pushBudgetSet, shared with the guest
      // door). The payload is aggregate-only on every answer but the one that
      // settles the budget, where it carries the banded number once.
      const payload = answerPayload({ countRow, ceiling, totalMembers, memberCount, settledNow });
      const io = req.app.get('io');
      await emitAnswer(io, flockId, payload, memberCount);
      // The member's own reply carries memberCount too, for the reason
      // emitAnswer gives: it is what "a flock this size" is judged on.
      res.json({ submitted: true, ...payload, memberCount, userSubmitted: true });
      await pushBudgetSet(io, flockId, payload.ceiling, userId);
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
      //
      // Totals over everyone present (PRESENT_ANSWERS), the reveal threshold
      // over the crowd inside them (`bm.id IS NOT NULL`): see the fragments.
      const countResult = await pool.query(
        `SELECT
           COUNT(*) AS total_submissions,
           COUNT(*) FILTER (WHERE skipped = false AND bm.id IS NOT NULL) AS non_skip_count,
           COUNT(*) FILTER (WHERE skipped = true) AS skip_count
         FROM ${PRESENT_ANSWERS} WHERE bs.flock_id = $1`,
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

      // Who has to answer: accepted members plus visible 'in' guests, the
      // same population the settle counts (see answeringPopulation). The
      // members alone ride along as memberCount, see emitAnswer.
      const population = await answeringPopulation((q, p) => pool.query(q, p), flockId);
      const totalMembers = population.total;

      // User's own submission (privacy: only their own)
      const userResult = await pool.query(
        'SELECT amount, skipped FROM budget_submissions WHERE flock_id = $1 AND user_id = $2',
        [flockId, userId]
      );
      const userSubmission = userResult.rows[0] || null;

      // The reveal gate, on this route and on every other surface that
      // publishes the same number (the flock list, the flock detail, the
      // flock update, the guest's POST /:token/me, and the ghost commit and
      // the shell read in routes/billing.js). budgetCeilingReadParity pins
      // them answering alike. Open, it is three PRESENT member sharers, which
      // is what the creator's Lock is gated on. Settled, it is the crowd the
      // budget settled over (settledCrowdHolds), so a departure after the
      // settle moves neither isReady nor the number: withdrawing them when a
      // named member left told the room that member had shared an amount.
      const isReady = flock.budget_locked
        ? await settledCrowdHolds((q, p) => pool.query(q, p), flockId)
        : nonSkipCount >= 3;

      // THE READ PATH GETS THE SAME RULE AS THE BROADCAST, or the fix moved the
      // leak instead of closing it: a client that polls this route once per
      // second reconstructs exactly the sequence the socket stopped emitting.
      //
      // So there is no live recompute here any more. This route used to
      // recompute MIN(amount) over present members on every unlocked read,
      // which was the right answer to the round-18 stale-cache finding and the
      // wrong answer to this one, because it made the running minimum readable on
      // demand, which is the oracle the whole differencing attack is built on.
      // The cached column is now written only when the budget settles (see
      // settledCeiling), so an unlocked flock has nothing cached to go stale
      // and nothing live to publish, and both findings are closed by the same
      // line.
      //
      // Locked is still re-banded on the way out, so a row cached as a raw MIN
      // before the M1 fix cannot publish an exact amount, and a flock locked
      // without three shared amounts at all (the first lock route had no
      // floor) still withholds, like every other reader of it
      // (budgetCeilingReadParity pins that).
      const visibleCeiling = isReady ? settledCeiling(flock.budget_locked, flock.budget_ceiling) : null;
      // THE SKIP/SHARE SPLIT IS NOT READABLE HERE AT ALL. See
      // publishableSkipCount: a single read of it in a small flock named who
      // declined, and a SEQUENCE of reads in a flock of any size names one
      // person per delta, which is what a poller of this route was collecting.
      // It is published once, by the submission that settles the budget, and
      // this route is the second door that would have made the sequence
      // readable on demand, the same way it was the second door to the live
      // ceiling. A settled flock is not exempt: members leave after a settle,
      // and a departure moves this number with a name attached to it.
      const visibleSkipCount = null;

      res.json({
        budgetEnabled: flock.budget_enabled,
        budgetContext: flock.budget_context,
        budgetLocked: flock.budget_locked,
        ceiling: visibleCeiling,
        submissionCount,
        totalMembers,
        memberCount: population.members,
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
          'SELECT creator_id, budget_enabled, budget_locked FROM flocks WHERE id = $1 FOR UPDATE',
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
        // LOCKING IS ONCE, AND THIS IS WHAT MAKES IT ONCE. Without this the
        // route recomputed MIN over whoever is present and rewrote the cached
        // column, so a creator who locked, watched the member with the lowest
        // amount leave, and locked again was shown a HIGHER number the second
        // time: the same before-and-after pair the submit path stopped
        // publishing, with the departed member named by it. The published
        // number is now the first one, permanently.
        if (flockResult.rows[0].budget_locked) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Budget has been locked' });
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
          `SELECT MIN(amount) AS ceiling FROM ${PRESENT_ANSWERS}
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

// A BUDGET CAN COMPLETE WITHOUT AN ANSWER. "Everyone has answered" compares
// the answers against the population, and the population moves when an 'in'
// guest says out (routes/guest.js): three members may have answered a budget
// that was waiting on exactly that person, and nothing would have settled it.
// The same settle, under the same flock lock, publishing the same way, or
// nothing at all. Never throws: it runs after a write that already
// committed, and a failure here must not turn that write into a 500.
//
// A member leaving is the same shape and is older than this file's guest
// arm; today the creator's /lock covers it once three amounts exist.
async function settleAfterPopulationChange(io, flockId) {
  let settled = null;
  let client;
  try {
    // Checking out the connection is the one step that can reject BEFORE the
    // try below, and an exhausted pool here would answer a committed RSVP with
    // a 500 that the client's retry then reads as a duplicate.
    client = await pool.connect();
  } catch (err) {
    console.error('Settle after population change could not connect:', err.message);
    return false;
  }
  try {
    await client.query('BEGIN');
    const f = await client.query(
      'SELECT budget_enabled, budget_locked, status FROM flocks WHERE id = $1 FOR UPDATE',
      [flockId]
    );
    const row = f.rows && f.rows[0];
    if (!row || !row.budget_enabled || row.budget_locked
        || row.status === 'completed' || row.status === 'cancelled') {
      await client.query('ROLLBACK');
      return false;
    }
    settled = await settleIfComplete(client, flockId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Settle after population change failed:', err.message);
    return false;
  } finally {
    client.release();
  }
  if (!settled || !settled.settledNow) return false;
  const payload = answerPayload(settled);
  await emitAnswer(io, flockId, payload, settled.memberCount);
  await pushBudgetSet(io, flockId, payload.ceiling, null);
  return true;
}

// POST /api/budget/:flockId/reset — the creator starts the budget over.
//
// WHY IT EXISTS. The ceiling is a MIN, and it is published once and never
// moves (settledCeiling). Those two rules together mean a single cent, once it
// has settled, is the group's budget for good: hiding its author cannot move a
// number that is not allowed to move, and there was no path off it. A member
// could always park one (they were chosen, and the MEMBERSHIP note concedes
// it); a guest holding the link can now park one too, and a guest was not
// chosen. So the creator gets the one recovery that is privacy-safe:
// everything goes, and the next publication is a FIRST publication, with no
// earlier number to subtract it from. Deleting every row rather than unlocking
// around them is the whole point: an unlock that kept the rows would publish
// a second number over the same people, which is the sequence leak.
//
// WHAT A SECOND ROUND DOES AND DOES NOT GIVE AWAY. The room remembers the
// first band; nothing can un-publish it. The sequence leak this file closes is
// a number that moves while ONE row changes, which attributes the move to that
// row's author. After a reset every row is new, so the second band is a band
// over a fresh set of answers, and what a member learns from it is exactly
// what any settle hands them: an interval containing the lowest amount among
// the others (see the note at CEILING_BANDS). Two rounds are two such
// intervals, not a narrower one, and nobody's move between them is visible.
//
// Creator only, one transaction under the flock lock, and a real DELETE bounded
// by flock_id. The room is told with the same aggregate shape every other
// budget event carries, all zeros, so a screen showing "up to $30" draws the
// open state again.
//
// THE ESTIMATES GO WITH THE NUMBER THEY WERE TAKEN FROM. A ghost commit
// (routes/billing.js) writes the settled ceiling into a payerless bill: every
// share is the ceiling and the total is the ceiling times the members. The
// reset cleared the number and left that bill standing, and nothing the next
// settle does reaches it (the commit's upsert only ever set `committed`), so
// after a reset and a lower settle the bill card still quoted the old cap
// while the budget said the new one. The shell now goes in the same
// transaction as the answers it was estimated from, under the same flock lock
// billing.js takes, and the first commit after the next settle starts a fresh
// one at the new number.
//
// Only a bill that never had a payer, and only while it holds nothing but
// those estimates. paid_by NULL is two states (billing.js, noPayerRefusal): a
// shell, and a real bill whose payer deleted their account, and the shares
// cannot tell the two apart. Posting a bill over a shell copies `committed`
// onto the real rows, and the payer's own settled row goes with their
// account, so a real bill can be left holding nothing but unpaid commitments
// at real amounts. This used to call that shape an estimate "whichever way it
// got there" and deleted a dinner somebody had rung up. bill_splits.had_payer
// (migration 086) is set in the statement that stores a payer and nothing
// clears it, so it is the test. The share check stays for payerless rows from
// before that column which the migration could not prove were ever posted: a
// share that is settled, carries a credit, or was never a commitment is a
// record of real money, and its bill stays.
const RESET_SHELL_SQL = `DELETE FROM bill_splits b
   WHERE b.flock_id = $1 AND b.paid_by IS NULL
     AND NOT EXISTS (SELECT 1 FROM bill_split_shares s
                      WHERE s.bill_id = b.id
                        AND (s.committed IS NOT TRUE OR s.settled IS TRUE OR COALESCE(s.paid_amount, 0) <> 0))
     AND b.had_payer IS NOT TRUE`;
router.post('/:flockId/reset',
  [param('flockId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Membership first, like /lock: a stranger cannot learn which ids exist.
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const flockResult = await client.query(
          'SELECT creator_id, budget_enabled, budget_locked FROM flocks WHERE id = $1 FOR UPDATE',
          [flockId]
        );
        if (flockResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Flock not found' });
        }
        if (flockResult.rows[0].creator_id !== userId) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Only the flock creator can start the budget over' });
        }
        if (!flockResult.rows[0].budget_enabled) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
        }
        // Only a settled budget has a number to get off. An open one is
        // still collecting private answers, and deleting those buys nothing
        // the members did not already have (Change is on their own row).
        if (!flockResult.rows[0].budget_locked) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'The budget is still open, so there is nothing to start over', code: 'BUDGET_OPEN' });
        }
        await client.query('DELETE FROM budget_submissions WHERE flock_id = $1', [flockId]);
        await client.query(RESET_SHELL_SQL, [flockId]);
        await client.query(
          'UPDATE flocks SET budget_locked = false, budget_ceiling = NULL, updated_at = NOW() WHERE id = $1',
          [flockId]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      const population = await answeringPopulation((q, p) => pool.query(q, p), flockId);
      const io = req.app.get('io');
      if (io) {
        await emitToFlockMembers(io, flockId, 'budget_updated', {
          flockId,
          ceiling: null,
          submissionCount: 0,
          totalMembers: population.total,
          memberCount: population.members,
          isReady: false,
          skipCount: null,
          budgetLocked: false,
          reset: true,
        }).catch((e) => console.error('budget_updated fan-out failed:', e.message));
      }
      res.json({ reset: true, totalMembers: population.total, memberCount: population.members });
    } catch (err) {
      console.error('Budget reset error:', err);
      res.status(500).json({ error: 'Failed to start the budget over' });
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
        'SELECT creator_id, name, budget_enabled, budget_locked FROM flocks WHERE id = $1',
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
      // A locked budget refuses every submission (POST /submit answers "Budget
      // has been locked"), so a reminder to "Submit your budget" is a push
      // asking people to do something the server will not let them do. Only the
      // client gate stopped it, which is a cosmetic gate with no server-side
      // twin, and that is the one shape the design standard names outright.
      if (flockResult.rows[0].budget_locked) {
        return res.status(409).json({ error: 'The budget is closed, so there is nothing left to remind anyone about' });
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

      // Find members who haven't submitted — the organiser excluded.
      //
      // This route is creator-only and a creator is always an accepted member of
      // their own flock (routes/flocks.js writes that row on create), so the
      // person tapping "Remind everyone" was in their own result set whenever
      // they had not filled in a number yet. That is not a corner case; chasing
      // the people who are holding the budget up is exactly the moment an
      // organiser has not got round to their own. So the reminder came back to
      // the phone that sent it: a budget_reminder toast on the screen they were
      // already looking at, and then a push. The push is pushAlways, which skips
      // the presence gate on purpose because a creator asking for attention
      // should not be swallowed by "they look online", so it really does buzz a
      // device that is plainly in the sender's hand.
      //
      // The count in the response was wrong for the same reason, and wrong in
      // the direction that hides the mistake: an organiser with three
      // outstanding members was told four people had been reminded.
      //
      // NOT EXISTS rather than NOT IN: a guest's answer carries a NULL user_id
      // (migration 071), and one NULL inside a NOT IN list makes the whole
      // predicate unknown, which would have reminded nobody on any plan where
      // a guest had answered.
      const missingResult = await pool.query(
        `SELECT u.id, u.name FROM flock_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.flock_id = $1 AND fm.status = 'accepted'
         AND fm.user_id <> $2
         AND NOT EXISTS (SELECT 1 FROM budget_submissions bs
                          WHERE bs.flock_id = $1 AND bs.user_id = fm.user_id)`,
        [flockId, userId]
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

      // ANSWER FIRST, THEN PUSH. This loop used to sit in front of the
      // response and await one full Firebase delivery per outstanding member,
      // one after another. Each pushAlways is roughly four database round trips
      // (visibility, quiet-hours zone, unread badge, device tokens) plus an FCM
      // call whose own deadline is eight seconds, so an organiser chasing four
      // people held the button for half a second on a good day and could hold
      // it for half a minute on a bad one.
      //
      // None of it feeds the response: `reminded` counts rows, not deliveries.
      // The socket toasts the caller actually cares about went out above.
      //
      // This is the shape routes/flocks.js pushInvitesToOffline already uses,
      // and its comment makes the same argument for invites. allSettled, so one
      // recipient's Firebase failure cannot abort the rest. Its own try/catch,
      // because the response is already gone by the time any of this runs and a
      // throw here must never try to answer twice.
      res.json({ reminded: missingResult.rows.length });

      try {
        await Promise.allSettled(missingResult.rows.map((member) => pushAlways(
          member.id,
          'Budget reminder',
          `Submit your budget for ${flockName}`,
          { type: 'budget_reminder', flockId: String(flockId) }
        )));
      } catch (pushErr) {
        console.error('Budget reminder push error:', pushErr.message);
      }
      return;
    } catch (err) {
      console.error('Budget remind error:', err);
      // headersSent: the push fan-out above runs POST-response, so a failure
      // that reaches here must not attempt a second write to a finished
      // response. Same guard routes/friends.js POST /accept carries, for the
      // same reason.
      if (!res.headersSent) res.status(500).json({ error: 'Failed to send reminders' });
    }
  }
);

module.exports = router;

// Exported so the regression tests can drive the banding rule from the route
// that owns it instead of retyping the thresholds, and so a future reader of
// flocks.js / billing.js can see where their cached ceiling was banded.
module.exports.bandCeiling = bandCeiling;
// Exported for the same reason bandCeiling is: routes/flocks.js and
// routes/billing.js read the cached column too, and the WHEN rule has to have
// one implementation for the same reason the banding does. See settledCeiling.
module.exports.settledCeiling = settledCeiling;
// The WHO rule, exported for the same reason the WHEN rule above is.
// settledCeiling answers "may this number be published yet"; the threshold
// answers "is there a crowd of three to hide in". While the budget is open
// that is present members (MEMBER_SUBMISSIONS), which the lock asks. Once it
// has settled it is the crowd it settled over (settledCrowdHolds and its two
// siblings), which every reader of the published number asks, so a departure
// after the settle cannot make the number blink off and name who shared.
module.exports.MEMBER_SUBMISSIONS = MEMBER_SUBMISSIONS;
module.exports.settledSharersOf = settledSharersOf;
module.exports.SETTLED_SHARERS_SQL = SETTLED_SHARERS_SQL;
module.exports.settledCrowdHolds = settledCrowdHolds;
module.exports.SETTLED_NUMBER_SHOWN_SQL = SETTLED_NUMBER_SHOWN_SQL;
module.exports.settledNumberShown = settledNumberShown;
module.exports.shownCeiling = shownCeiling;
module.exports.RESET_SHELL_SQL = RESET_SHELL_SQL;
module.exports.CEILING_BANDS = CEILING_BANDS;
module.exports.SUB_DOLLAR_CEILING = SUB_DOLLAR_CEILING;
// The guest door in routes/guest.js runs the same settle and the same
// publication as POST /submit, from these, so there is one implementation of
// each. answeringPopulation is the denominator every "n of m answered" reads.
module.exports.answeringPopulation = answeringPopulation;
module.exports.GUEST_ANSWERERS_SQL = GUEST_ANSWERERS_SQL;
module.exports.PRESENT_ANSWERS = PRESENT_ANSWERS;
module.exports.settleIfComplete = settleIfComplete;
module.exports.answerPayload = answerPayload;
module.exports.emitAnswer = emitAnswer;
module.exports.pushBudgetSet = pushBudgetSet;
module.exports.settleAfterPopulationChange = settleAfterPopulationChange;
module.exports.publishableSkipCount = publishableSkipCount;

// Test hook only — the reminder cooldown is process-wide in-memory state, so a
// test suite needs a way to start each case from a clean window.
module.exports.__resetReminderCooldowns = () => {
  reminderCooldowns.clear();
  lastReminderSweep = 0;
};
// Test hook only — lets a test assert the map actually shrinks, which is the
// whole point of the sweep and is otherwise invisible from outside.
module.exports.__reminderCooldownCount = () => reminderCooldowns.size;
