'use strict';

// THE DAY WORDS OF A QUESTION, READ BY A SMALL GRAMMAR (2026-11-06).
//
// Four rounds of review each found a new wrong day in a reader that guessed
// from short forms and their neighbours ("we sat 40 covers" was Saturday,
// "the sun rush" was Sunday, "if tomorrow will pick up" was today). This one
// reads only words that say a day and nothing else:
//
//   * a weekday written out ("Friday", "fridays", "Friday's"), with "next",
//     "next week", "of next week", "next week's" and "after next" beside it;
//     not after "last", and not in a holiday's name ("Black Friday", "Cyber
//     Monday", "Easter Sunday"): that day is a date, not the coming weekday;
//   * today, tonight, this morning, this afternoon, this evening;
//   * tomorrow, and the day after tomorrow;
//   * this weekend (any "weekend"), next weekend, the following weekend, the
//     weekend after next;
//   * the week: this week, the week, our week, the whole week, the coming
//     week, the week ahead, and which or what day or night.
//
// No short form is read ("Sat", "Fri", "Tues", "Sun"): four of them are
// English words, and every rule that told the day from the word ran into an
// owner's sentence it misread.
//
// WHERE: the question sentence. A question asks in its sentences that end on a
// question mark, or with none, in its last sentence; a comma before a question
// word starts the question's own sentence ("Saturdays are packed, how do I fill
// Tuesdays?", "It's Friday, how's the weekend looking?"). Only when those name
// no day is the whole question read ("Sunday Funday is this weekend, how busy
// will it be?"), and then a weekday in the plural is a habit, not a day asked
// ("we are closed mondays, what's our slowest open day?").
//
// A day word in the possessive ("tomorrow's game", "after tonight's rush")
// says what something belongs to, and counts only when no other day word does.
//
// The route reads what this returns against the venue's own today
// (routes/advisor.js readingFor): two words that name different days are
// answered with both, never with one picked from them.

const { SPELLING } = require('./ownerWords');

const ASKS = "(?:how|how's|hows|what|what's|whats|which|when|where|why|who|will|would|won't|is|isn't|are|aren't|was|were|should|shall|could|can|do|does|did|any)";
const SENTENCES = /(?<=[!?]|(?<!\bvs)\.)\s+|\n+/;
const SPLICE = new RegExp(`[,;:]\\s+(?=(?:(?:so|and|but|then|ok|okay|well|also|anyway)\\s+)*${ASKS}\\b)`, 'i');

const TOKEN = new RegExp([
  "\\b(?<dat>(?:the\\s+)?day\\s+after\\s+tomorrow)\\b",
  "\\b(?<after>weekend\\s+after\\s+next|following\\s+weekend|weekend\\s+after\\s+this(?:\\s+one)?)\\b",
  "\\b(?<nextWeekend>next\\s+weekend)\\b(?<nwPoss>')?",
  "\\b(?<weekend>weekends?)\\b(?<wePoss>')?",
  "\\b(?<week>(?:this|the|our|whole|coming)\\s+week|week\\s+ahead|(?:which|what)\\s+(?:days?|nights?|evenings?))\\b",
  "\\b(?<tomorrow>tomorrow)\\b(?<tmPoss>')?",
  "\\b(?<today>today|tonight|this\\s+(?:evening|afternoon|morning))\\b(?<tdPoss>')?",
  "\\b(?<day>(?:mon|tues|wednes|thurs|fri|satur|sun)day)(?<plural>s)?\\b(?<dayPoss>')?",
].join('|'), 'gi');

// The week after this one, said beside the day ("Friday next week", "Friday of
// next week", "Monday be next week", "next week's Friday"); and two out ("the
// Friday after next"). Not "Friday compared to next week".
const NEXT_WEEK_AFTER = /^\s*,?\s*(?:(?:be|look|looks|seem|run)\s+(?:like\s+)?)?(?:of\s+)?next\s+week\b/i;
const NEXT_WEEK_BEFORE = /\bnext\s+week'?s\s+$/i;
const AFTER_NEXT = /^\s+after\s+next\b/i;
// Holidays named for a weekday: a date, not the coming weekday.
const HOLIDAY_BEFORE = /\b(?:black|cyber|good|easter|palm|ash|holy|maundy|giving|super(?:\s+bowl)?|small\s+business)\s+$/i;

const WEEKDAY = (stem) => `${stem[0].toUpperCase()}${stem.slice(1).toLowerCase()}`;

function normalize(question) {
  return String(question || '').normalize('NFKC').replace(/[‘’]/g, "'")
    .replace(/[A-Za-z]+/g, (w) => (Object.hasOwn(SPELLING, w.toLowerCase()) ? SPELLING[w.toLowerCase()] : w));
}

/** The parts of `text` a question asks in, and every part. */
function parts(text) {
  const pieces = text.split(SENTENCES).flatMap((s) => s.split(SPLICE)).map((s) => s.trim()).filter(Boolean);
  const marked = pieces.filter((p) => /\?\s*$/.test(p));
  return { asking: marked.length ? marked : pieces.slice(-1), all: pieces };
}

function tokensIn(piece) {
  const out = [];
  for (const m of piece.matchAll(TOKEN)) {
    const g = m.groups;
    const before = piece.slice(0, m.index);
    const after = piece.slice(m.index + m[0].length);
    if (g.dat) out.push({ kind: 'dayAfterTomorrow' });
    else if (g.after) out.push({ kind: 'weekend', scope: /after\s+next/i.test(g.after) ? 'after_next' : 'next' });
    else if (g.nextWeekend) out.push({ kind: 'weekend', scope: 'next_words', weak: Boolean(g.nwPoss) });
    else if (g.weekend) out.push({ kind: 'weekend', scope: 'this', weak: Boolean(g.wePoss), plural: /s$/i.test(g.weekend) });
    else if (g.week) out.push({ kind: 'week' });
    else if (g.tomorrow) out.push({ kind: 'tomorrow', weak: Boolean(g.tmPoss) });
    else if (g.today) out.push({ kind: 'today', weak: Boolean(g.tdPoss) });
    else if (g.day) {
      if (/\blast\s+$/i.test(before) || HOLIDAY_BEFORE.test(before)) continue;
      const tok = { kind: 'weekday', weekday: WEEKDAY(g.day), next: /\bnext\s+$/i.test(before), weak: Boolean(g.dayPoss), plural: Boolean(g.plural) };
      if (NEXT_WEEK_AFTER.test(after) || NEXT_WEEK_BEFORE.test(before)) tok.nextWeek = true;
      if (AFTER_NEXT.test(after)) tok.afterNext = true;
      out.push(tok);
    }
  }
  return out;
}

const same = (a, b) => a.kind === b.kind && a.weekday === b.weekday && a.scope === b.scope
  && Boolean(a.next) === Boolean(b.next) && Boolean(a.nextWeek) === Boolean(b.nextWeek) && Boolean(a.afterNext) === Boolean(b.afterNext);

/**
 * The day words a question says where it asks (above), in the order said, each
 * once: { kind: 'weekday', weekday, next, nextWeek?, afterNext? } | { kind:
 * 'today' } | { kind: 'tomorrow' } | { kind: 'dayAfterTomorrow' } | { kind:
 * 'weekend', scope: 'this' | 'next_words' | 'next' | 'after_next' } | { kind:
 * 'week' }. Empty when it says none.
 */
function dayWords(question) {
  const text = normalize(question);
  const { asking, all } = parts(text);
  let found = asking.flatMap((p) => tokensIn(p));
  if (!found.length) found = all.flatMap((p) => tokensIn(p)).filter((t) => !t.plural);
  const strong = found.filter((t) => !t.weak);
  let kept = strong.length ? strong : found;
  // The week beside a weekday only says which one ("Monday this week").
  if (kept.some((t) => t.kind === 'weekday')) kept = kept.filter((t) => t.kind !== 'week');
  const out = [];
  for (const t of kept) {
    const { weak, plural, ...tok } = t;
    if (!out.some((o) => same(o, tok))) out.push(tok);
  }
  return out;
}

// TODAY IN THE WEEK RANKED, OR LEFT OUT OF IT (third review, 2026-11-06).
// When a question says today beside the week, which days to rank is said in
// so many words: "including today", "starting today", "Is tonight
// the busiest night this week?" put today in; "besides tonight", "other than
// today", "the rest of the week after today" leave it out. Neither picks a
// day, and with neither the week is ranked as the plan ranks it.
const TODAY_W = "(?:today|tonight|this\\s+(?:evening|afternoon|morning))\\b(?!')";
const LEAVE_OUT = '(?:besides|other\\s+than|except(?:\\s+for)?|apart\\s+from|aside\\s+from|excluding|not\\s+counting)';
const TODAY_LEFT_OUT = new RegExp(`\\b(?:${LEAVE_OUT}\\s+${TODAY_W}|after\\s+(?:today|tonight|this\\s+evening)\\b(?!'))`, 'i');
const TODAY_IN = new RegExp([
  `\\b(?:including|incl\\.?|starting(?:\\s+(?:from|with))?|counting|from)\\s+${TODAY_W}`,
  `\\b${TODAY_W}\\s+included\\b`,
  `\\b${TODAY_W}\\s+(?:compares?|ranks?|stacks?\\s+up|measures?\\s+up)\\b`,
  `\\b(?:compare|rank)\\s+${TODAY_W}`,
  `\\b${TODAY_W}\\s+(?:(?:is|be|will\\s+be|going\\s+to\\s+be|gonna\\s+be)\\s+)?(?:one\\s+of\\s+)?(?:the|our)\\s+(?:[a-z']+\\s+)?(?:busiest|quietest|slowest|deadest|biggest|best|worst|top|highest|lowest)\\b`,
].join('|'), 'i');

/** 'out' when the question leaves today out of the days it ranks, 'in' when it puts today in, else null. */
function todayInRanking(question) {
  const text = normalize(question).toLowerCase();
  if (TODAY_LEFT_OUT.test(text)) return 'out';
  return TODAY_IN.test(text) ? 'in' : null;
}

module.exports = { dayWords, todayInRanking, __parts: (q) => parts(normalize(q)) };
