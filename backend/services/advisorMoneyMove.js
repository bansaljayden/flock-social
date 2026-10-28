// ---------------------------------------------------------------------------
// THE MONEY MOVE: where this week's money is, in one place.
//
// "What is our best money move this week?" is Roost's first chip, and since
// 2026-10-28 it is also a section of the Monday email, so the selection, the
// move and the arithmetic live here once and both read them.
//
//   1. The pick. The quietest projected day is the room with the most seats
//      to sell, and the busiest is given beside it for contrast. Inside the
//      measured ordering floor no day is named: a level week's money is in
//      each check rather than in one day.
//   2. The move. The playbook's best one for that shape of week, fitted to the
//      venue (roostPlaybook.moveFor).
//   3. The money. What 10 more covers on the quiet day are worth at the
//      venue's own spend per head, or what a small lift on every check is
//      worth in a level week, with the working in the sentence.
//
// Selection and arithmetic on the owner's own figure only. No number here is
// one the fact engine or the owner did not supply.
// ---------------------------------------------------------------------------

const roostPlaybook = require('./roostPlaybook');

const LOWEST_NOTE = 'This is the LOWEST projected day in the week ahead: the room with the most seats to sell, which is where this week\'s money move is.';
const LEVEL_NOTE = 'This week projects level: no day sits far enough from the rest to be worth filling on its own, so the money is in each check.';
const HIGHEST_NOTE = 'This is the HIGHEST projected day in the week ahead, given for contrast.';

const scored = (f) => Boolean(f && f.value && Number.isFinite(Number(f.value.peakScore)));

/**
 * The plan's selection from a week of entries (facts and refusals). Returns
 * the lowest and highest day with notes saying which they are, or the
 * entries untouched when no day was scored, so the week's refusals speak.
 */
function pickFacts(entries, isRefusal) {
  const list = Array.isArray(entries) ? entries : [];
  const days = list
    .filter((e) => !isRefusal(e) && scored(e))
    .sort((a, z) => Number(a.value.peakScore) - Number(z.value.peakScore));
  if (!days.length) return list;
  const low = days[0];
  const top = days[days.length - 1];
  const level = roostPlaybook.isLevelWeek({ facts: [low, top] });
  const picked = [{ ...low, note: [low.note, level ? LEVEL_NOTE : LOWEST_NOTE].filter(Boolean).join(' ') }];
  if (top !== low) picked.push({ ...top, note: [top.note, HIGHEST_NOTE].filter(Boolean).join(' ') });
  return picked;
}

/** What the move is worth in the venue's own money, or null without a spend. */
function moneyLine(block, spend) {
  if (!(spend > 0)) return null;
  if (roostPlaybook.isLevelWeek(block)) return roostPlaybook.moneyLine({ money: 'check' }, spend);
  const facts = block && Array.isArray(block.facts) ? block.facts : [];
  const low = facts
    .filter((f) => scored(f) && typeof f.value.weekday === 'string')
    .reduce((a, b) => (!a || Number(b.value.peakScore) < Number(a.value.peakScore) ? b : a), null);
  if (!low) return null;
  const week = spend * 10;
  return `At your ${roostPlaybook.dollars(spend)} a head, every 10 extra covers on ${low.value.weekday} is ${roostPlaybook.dollars(week)} a week, about ${roostPlaybook.dollars(week * 52)} a year.`;
}

/**
 * The move and the money, as lines with their sources: what the chip's
 * template twin ends on and what the email lists under the day.
 */
function extras({ block, venue = null, spend = null, spendAsOf = 'owner-set' }) {
  const tactic = roostPlaybook.moveFor('money_move', block, venue);
  if (!tactic) return { lines: [], sources: [] };
  const lines = [{ text: tactic.move, source: { ...roostPlaybook.PLAYBOOK_SOURCE } }];
  const money = moneyLine(block, spend);
  if (money) {
    lines.push({ text: money, source: { id: 'intake_typical_spend_per_person', source: 'intake', asOf: spendAsOf } });
  }
  return { lines: lines.map((l) => l.text), sources: lines.map((l) => l.source) };
}

const DIGEST_TITLE = 'This week\'s money move';

/**
 * The Monday email's money move section, or null when the week has nothing
 * to say. `lead` is the chip's own first sentence (advisorPhrasing renders
 * it), so the email and the chat say the same thing.
 */
function digestCard({ weekFacts, ctx, isRefusal, renderLead }) {
  const picked = pickFacts(weekFacts, isRefusal).filter((e) => !isRefusal(e));
  if (!picked.length) return null;
  const lead = renderLead({ intent: 'money_move', facts: picked, refusals: [] });
  if (!lead) return null;
  const p = (ctx && ctx.profile) || {};
  const spendAsOf = p.updated_at ? `owner-set ${String(p.updated_at).slice(0, 10)}` : 'owner-set';
  const { lines, sources } = extras({
    block: { facts: picked },
    venue: roostPlaybook.venueOf(ctx),
    spend: roostPlaybook.spendOf(ctx),
    spendAsOf,
  });
  const facts = [
    { id: 'money_move_day', label: lead, source: picked[0].source, asOf: picked[0].asOf },
    ...lines.map((text, i) => ({ id: `money_move_${i ? 'money' : 'play'}`, label: text, source: sources[i].source, asOf: sources[i].asOf })),
  ];
  return { id: 'money_move', title: DIGEST_TITLE, facts, status: 'ok' };
}

module.exports = {
  pickFacts,
  moneyLine,
  extras,
  digestCard,
  DIGEST_TITLE,
  LOWEST_NOTE,
  LEVEL_NOTE,
  HIGHEST_NOTE,
};
