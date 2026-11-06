'use strict';

// THE DAY WORDS OF A QUESTION, READ BY A SMALL GRAMMAR (2026-11-06).
//
// Four rounds of review each found a new wrong day in a reader that guessed
// from short forms and their neighbours ("we sat 40 covers" was Saturday,
// "the sun rush" was Sunday, "if tomorrow will pick up" was today). This one
// reads words that say a day:
//
//   * a weekday written out ("Friday", "fridays", "Friday's"), with "next",
//     "next week", "of next week", "next week's" and "after next" beside it;
//     not after "last", and not in a holiday's name ("Black Friday", "Cyber
//     Monday", "Easter Sunday", "Good Friday" written as one): that day is a
//     date, not the coming weekday;
//   * a short form ("Fri night", "next sat", "Sun?") only where it is written
//     as a day (shortIsDay below), never where it is the word ("we sat 40
//     covers", "the sun rush", "with this sun");
//   * today, tonight, this morning, this afternoon, this evening;
//   * tomorrow, and the day after tomorrow;
//   * this weekend (any "weekend", never "last weekend"), next weekend, the
//     following weekend, the weekend after next, and "weekends", the habit;
//   * the week: this week, the week, our week, the whole week, the coming
//     week, the week ahead, and which or what day or night.
//
// A short form counts only where it is written as a day; one read beside
// another day is answered with both, never picked over it.
//
// WHERE: the question sentence. A question asks in its sentences that end on a
// question mark ("?!" too), or with none, in those that hold a question word,
// failing which in its last sentence; a comma before a question word starts
// the question's own sentence ("Saturdays are packed, how do I fill
// Tuesdays?", "It's Friday, how's the weekend looking?"), and so does a
// question word after a day in a run-on (RUN_ON below). Only when those name
// no day is the whole question read ("Sunday Funday is this weekend, how busy
// will it be?"), and then a weekday in the plural is the day asked ("Our
// Wednesdays are slow, any ideas?") unless it is a habit, the days the venue
// is shut ("we are closed mondays, what's our slowest open day?") or when
// something happens ("We do trivia on Tuesdays. Any tips?").
//
// A day word in the possessive ("tomorrow's game", "after tonight's rush")
// says what something belongs to, and counts only when no other day word does,
// a weekend or the week beside two or more of them aside.
// So does a day given as the reason, after since or because ("How busy will
// tonight be since tomorrow is a holiday?"), and a day said in the past
// ("Tonight was dead so I'm wondering if tomorrow will pick up"): the question
// is about the other day it names.
//
// The route reads what this returns against the venue's own today
// (routes/advisor.js readingFor): two words that name different days are
// answered with both, never with one picked from them.

const { SPELLING } = require('./ownerWords');

const ASKS = "(?:how|how's|hows|what|what's|whats|which|when|where|why|who|will|would|won't|is|isn't|are|aren't|was|were|should|shall|could|can|do|does|did|any)";
const SENTENCES = /(?<=[!?]|(?<!\bvs)\.)\s+|\n+/;
const SPLICE = new RegExp(`[,;:]\\s+(?=(?:(?:so|and|but|then|ok|okay|well|also|anyway)\\s+)*${ASKS}\\b)`, 'i');
// A RUN-ON STARTS ITS QUESTION WITHOUT A COMMA (acceptance, 2026-11-06). "we
// did 300 covers saturday what should i expect sunday", "Since we're closed
// monday will tuesday be busy?", "saturday got rained out so how busy will
// sunday be" and "friday we had a private party what about saturday" ask in
// their last clause, as a comma would have said. A clause starts at a
// question word straight after a day word; at "will", "should", "can" and
// the like after a day word when a subject follows ("monday will tuesday
// be", never "tomorrow will be busy"); at "so how" or "then what"; and at
// "what about" or "how about" anywhere. Not "is" after a day ("Friday is
// payday"), and not "when" ("tonight when the Eagles play").
const RUN_DAY = '(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|today|tonight|tomorrow|weekends?)';
const RUN_WH = "(?:how|how's|hows|what|what's|whats|which)";
const RUN_MODAL = '(?:will|would|should|could|can|do|does)';
const RUN_ON = new RegExp([
  `(?<=\\b${RUN_DAY}'?s?)\\s+(?=${RUN_WH}\\b|${RUN_MODAL}\\s+(?:we|i|you|it|they|there|${RUN_DAY})\\b)`,
  `\\s+(?=(?:so|then)\\s+(?:${RUN_WH}|${RUN_MODAL})\\b)`,
  '\\s+(?=(?:what|how)\\s+about\\b)',
].join('|'), 'i');
// A sentence asks when it ends on a question mark, "?!" and "?!!" too.
const MARKED = /\?[!?.]*\s*$/;
// With no question mark anywhere, the parts that hold a question word ask
// ("how busy will tonight be. tomorrow is a holiday"), and failing those the
// last part does ("Slow tonight. Not sure if tomorrow will be any better.").
// "What a dead night tonight." asks nothing.
const HOLDS_ASK = /^(?:(?:so|and|but|then|ok|okay|well|also|anyway)\s+)*(?:when|when's|whens)\b|\b(?:how|how's|hows|what's|whats|which|whether)\b|\bwhat\b(?!\s+an?\b)/i;

const TOKEN = new RegExp([
  "\\b(?<dat>(?:the\\s+)?day\\s+after\\s+tomorrow)\\b",
  "\\b(?<after>weekend\\s+after\\s+next|following\\s+weekend|weekend\\s+after\\s+this(?:\\s+one)?)\\b",
  "\\b(?<nextWeekend>next\\s+weekend)\\b(?<nwPoss>')?",
  "\\b(?<weekend>weekends?)\\b(?<wePoss>')?",
  "\\b(?<week>(?:this|the|our|whole|coming)\\s+week|week\\s+ahead|(?:which|what)\\s+(?:days?|nights?|evenings?))\\b",
  "\\b(?<tomorrow>tomorrow)\\b(?<tmPoss>')?",
  "\\b(?<today>today|tonight|this\\s+(?:evening|afternoon|morning))\\b(?<tdPoss>')?",
  "\\b(?<day>(?:mon|tues|wednes|thurs|fri|satur|sun)day)(?<plural>s)?\\b(?<dayPoss>')?",
  "\\b(?<short>mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)\\b\\.?",
].join('|'), 'gi');

// THE SHORT FORMS, ONLY WHERE THEY ARE WRITTEN AS A DAY (2026-11-06). "Tues",
// "Thurs", "Fri" and "Weds" are no English word and count anywhere but in a
// range ("Mon-Fri" is the hours or a habit) or a word made on them
// ("Fri-yay"). "Mon", "Wed", "Sat" and "Sun" are words too ("we sat 40
// covers", "the sun rush", "c'mon"), so they count only after on, this, next,
// every or coming ("on Sun", "next sat"); joined to another day ("Fri or
// Sat", "Sat/Sun"); as the whole sentence ("Sun?"); capitalised before a part
// of the day or a date ("Sun brunch", "Sat 14th"); or capitalised inside a
// sentence and not after "the" or "a" nor before a name ("How busy will Sat
// be?", not "the Sun Devils"). "SAT" in capitals from an owner who writes in
// lower case too is a test. One read beside another day is answered with
// both (routes/advisor.js bothAnswer), never picked over it.
const SHORT_DAYS = Object.freeze({
  mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', weds: 'Wednesday', thu: 'Thursday',
  thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
});
const WORDS_TOO = new Set(['mon', 'wed', 'sat', 'sun']);
const DAY_FORMS = '(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)';
const PART_NEXT = /^\s*(?:-\s*)?(?:(?:night|nite|morning|afternoon|evening|brunch|lunch|dinner|breakfast|service|shift|crowd|rush)s?\b|(?:am|pm)\b|[ap]\.m\.)/i;
const DATE_NEXT = /^\s*(?:\d{1,2}(?:st|nd|rd|th)\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d)/i;
const RANGE_JOIN = '(?:-|\\u2013|through|thru|to|till|til|until)';
const SET_JOIN = '(?:\\/|&|\\+|and|or|n|vs\\.?|versus)';
const RANGE_NEXT = new RegExp(`^\\s*${RANGE_JOIN}\\s*${DAY_FORMS}\\b`, 'i');
const RANGE_BEFORE = new RegExp(`\\b${DAY_FORMS}\\.?\\s*${RANGE_JOIN}\\s*$`, 'i');
const SET_NEXT = new RegExp(`^\\s*${SET_JOIN}\\s*${DAY_FORMS}\\b`, 'i');
const SET_BEFORE = new RegExp(`\\b${DAY_FORMS}\\.?\\s*${SET_JOIN}\\s*$`, 'i');
const MARK_BEFORE = /\b(?:on|this|next|every|each|coming|upcoming)\s+$/i;
const NAME_NEXT = /^\s+[A-Z][a-z]/;
const ARTICLE_BEFORE = /\b(?:the|a|an)\s+$/i;
const SENTENCE_START = /(?:^|[.!?]\s+|\n\s*)$/;
const SENTENCE_END = /^\s*(?:[.!?]+\s*)?$|^\s*[.!?]+\s/;

/** True when the short form `short`, between `before` and `after`, is written as a day. */
function shortIsDay(short, before, after, shouting) {
  if (RANGE_NEXT.test(after) || RANGE_BEFORE.test(before)) return false;
  if (/^-[a-z]/i.test(after)) return false;
  const word = WORDS_TOO.has(short.toLowerCase());
  const capital = !shouting && /^[A-Z]/.test(short);
  const partOrDate = PART_NEXT.test(after) || DATE_NEXT.test(after);
  if (!word) return !(capital && NAME_NEXT.test(after) && !partOrDate);
  if (!shouting && short === short.toUpperCase()) return false;
  // "this sun" in lower case is the weather ("How busy will the patio be
  // with this sun?"), not the day (acceptance, 2026-11-06).
  const marked = MARK_BEFORE.test(before) && !(short === 'sun' && /\bthis\s+$/i.test(before));
  if (marked || SET_NEXT.test(after) || SET_BEFORE.test(before)) return true;
  if (SENTENCE_START.test(before) && SENTENCE_END.test(after)) return true;
  if (capital && partOrDate) return true;
  if (!capital || ARTICLE_BEFORE.test(before)) return false;
  return !NAME_NEXT.test(after) && !SENTENCE_START.test(before);
}

// The week after this one, said beside the day ("Friday next week", "Friday of
// next week", "Monday be next week", "next week's Friday"); and two out ("the
// Friday after next"). Not "Friday compared to next week".
const NEXT_WEEK_AFTER = /^\s*,?\s*(?:(?:be|look|looks|seem|run)\s+(?:like\s+)?)?(?:of\s+)?next\s+week\b/i;
const NEXT_WEEK_BEFORE = /\bnext\s+week'?s\s+$/i;
const AFTER_NEXT = /^\s+after\s+next\b/i;
// Holidays named for a weekday: a date, not the coming weekday.
const HOLIDAY_BEFORE = /\b(?:black|cyber|easter|palm|ash|holy|maundy|super\s+bowl|small\s+business)\s+$/i;
// "Good", "super" and "giving" are ordinary words before a day too ("Is this
// a good Friday to run a promo?", "Gonna be a super Sunday?", "We're giving
// Tuesday another shot"), so they name a holiday only written as one, with
// capitals: "Good Friday", "Giving Tuesday" (acceptance, 2026-11-06).
const NAME_HOLIDAY_BEFORE = /\b(?:Good|Super|Giving)\s+$/;
const holidayBefore = (before, day) => HOLIDAY_BEFORE.test(before) || (/^[A-Z]/.test(day) && NAME_HOLIDAY_BEFORE.test(before));

// The reason a question gives, after since or because in its own sentence.
const GIVEN_BEFORE = /\b(?:since|because|cause|cuz|coz)\b/i;
// A day said as the past ("Tonight was dead", "Saturday was packed") is no
// forecast's day, so it too counts only when no other day is said.
const PAST_AFTER = /^\s+(?:was|were|had)\b/i;
const WEEKDAY = (stem) => `${stem[0].toUpperCase()}${stem.slice(1).toLowerCase()}`;

function normalize(question) {
  return String(question || '').normalize('NFKC').replace(/[‘’]/g, "'")
    .replace(/[A-Za-z]+/g, (w) => (Object.hasOwn(SPELLING, w.toLowerCase()) ? SPELLING[w.toLowerCase()] : w));
}

/** The parts of `text` a question asks in, and every part. */
function parts(text) {
  const asking = [];
  const all = [];
  for (const sentence of text.split(SENTENCES).map((s) => s.trim()).filter(Boolean)) {
    const pieces = sentence.split(SPLICE).flatMap((p) => p.split(RUN_ON)).map((p) => p.trim()).filter(Boolean);
    all.push(...pieces);
    // The last part of a sentence that ends on a question mark asks.
    if (pieces.length && MARKED.test(sentence)) asking.push(pieces[pieces.length - 1]);
  }
  if (!asking.length) {
    const holding = all.filter((p) => HOLDS_ASK.test(p));
    asking.push(...(holding.length ? holding : all.slice(-1)));
  }
  return { asking, all };
}

// A WEEKEND GONE BY IS NO WEEKEND ASKED (acceptance, 2026-11-06): "last
// weekend", "the past weekend" and "the weekend before" are said beside next
// weekend as the other side of a comparison, and were read as this weekend.
const GONE_BEFORE = /\b(?:last|past|previous)\s+$/i;
const GONE_AFTER = /^\s+before\b/i;

// A WEEKDAY IN THE PLURAL, WHERE NOTHING ELSE IS ASKED (acceptance, 2026-11-06).
// "Our Wednesdays are slow, any ideas?", "Mondays are killing us. What should
// we do?" and "We're always slow on Mondays" ask about that day, as they always
// were read. Two kinds of plural are a habit and no day asked: one the venue
// is shut on ("we are closed mondays, what's our slowest open day?"), and one
// that only says when something happens ("We do trivia on Tuesdays. Any tips
// for a slow night?"), where its sentence says nothing of how busy it is.
const SHUT_SAID = /\b(?:closed|shut|close|off)\b/i;
const HABIT_BEFORE = /\b(?:on|every|most|some)\s+$/i;
const CROWD_SAID = /\b(?:busy|busier|busiest|slow|slower|slowest|quiet|quieter|quietest|dead|deadest|packed|slammed|empty|full|crowded|crowds?|rush)\b/i;

function tokensIn(piece, shouting = false) {
  const out = [];
  // The weekdays this part says the venue is shut on (shutDaysIn below).
  const shutHere = shutDaysIn(piece);
  for (const m of piece.matchAll(TOKEN)) {
    const g = { ...m.groups };
    const before = piece.slice(0, m.index);
    const after = piece.slice(m.index + m[0].length);
    if (g.short) {
      if (!shortIsDay(g.short, before, after, shouting)) continue;
      g.day = SHORT_DAYS[g.short.toLowerCase()];
    }
    // A day given as the reason ("How busy will tonight be since tomorrow is a
    // holiday?") or said as the past counts only when no other day is said, as
    // a possessive does.
    const given = GIVEN_BEFORE.test(before) || PAST_AFTER.test(after);
    const at = out.length;
    if (g.dat) out.push({ kind: 'dayAfterTomorrow' });
    else if (g.after) out.push({ kind: 'weekend', scope: /after\s+next/i.test(g.after) ? 'after_next' : 'next' });
    else if (g.nextWeekend) out.push({ kind: 'weekend', scope: 'next_words', weak: Boolean(g.nwPoss) });
    else if (g.weekend) {
      if (GONE_BEFORE.test(before) || GONE_AFTER.test(after)) continue;
      // "Weekends" is a habit, the weekends the week ahead holds, read as the
      // week ahead's Friday, Saturday and Sunday ("Are weekends busier than
      // weekdays for us?" on a Sunday is no question about that Sunday alone).
      out.push({ kind: 'weekend', scope: /s$/i.test(g.weekend) ? 'habit' : 'this', weak: Boolean(g.wePoss) });
    } else if (g.week) out.push({ kind: 'week' });
    else if (g.tomorrow) out.push({ kind: 'tomorrow', weak: Boolean(g.tmPoss) });
    else if (g.today) {
      // Which part of today: the night ("tonight", "this evening"), the day
      // ("this morning", "this afternoon"), or today itself, which in the
      // small hours is either (routes/advisor.js targetsFor).
      let part = 'today';
      if (/night|evening/i.test(g.today)) part = 'tonight';
      else if (/morning|afternoon/i.test(g.today)) part = 'day';
      out.push({ kind: 'today', part, weak: Boolean(g.tdPoss) });
    }
    else if (g.day) {
      if (/\blast\s+$/i.test(before) || holidayBefore(before, m[0])) continue;
      const tok = { kind: 'weekday', weekday: WEEKDAY(g.day), next: /\bnext\s+$/i.test(before), weak: Boolean(g.dayPoss), possessive: Boolean(g.dayPoss), plural: Boolean(g.plural) };
      if (tok.plural) tok.habit = SHUT_SAID.test(piece) || (HABIT_BEFORE.test(before) && !CROWD_SAID.test(piece));
      if (NEXT_WEEK_AFTER.test(after) || NEXT_WEEK_BEFORE.test(before)) tok.nextWeek = true;
      if (AFTER_NEXT.test(after)) tok.afterNext = true;
      out.push(tok);
    }
    // A DAY THE OWNER SAYS THE VENUE IS SHUT ON IS NO DAY ASKED (recheck,
    // 2026-11-06): "how busy will friday be, saturday we are closed" asks
    // about Friday, and was answered with Saturday as the week's busiest. It
    // counts only when no other day word does, as a reason given does.
    const shutSaid = Boolean(g.day) && out.length > at && shutHere.includes(out[at].weekday);
    if ((given || shutSaid) && out.length > at) Object.assign(out[at], { weak: true, possessive: false });
  }
  return out;
}

// THE WEEKDAYS AN OWNER SAYS THE VENUE IS SHUT ON (acceptance, 2026-11-06):
// "We're closed Sundays. How does this weekend look?" asked on a Sunday is
// about the coming weekend, and was answered with that Sunday. Read from the
// owner's own words, either way round ("we are closed on Mondays and
// Tuesdays", "we close on Sundays", "Sundays we're closed", "saturday we are
// closed"), or "closed on Sundays" with no subject at all; the weekend's
// route leaves those days out (routes/advisor.js weekend_outlook), and the
// day reader does not read them as a day asked (tokensIn above).
//
// ONLY THE OWNER'S OWN VENUE, AND ONLY SHUT NOW (recheck, 2026-11-06). "The bar
// next door is closed Sundays, how busy will we be this weekend?" and "We're
// not closed Sundays anymore. How does this weekend look?" each dropped
// Sunday from the weekend: "closed" was read beside any subject and after
// "not". Another subject ("the bar next door is", "they're"), a negation ("not
// closed", "no longer closed", "aren't closed") and the past ("we used to be
// closed") say nothing of this venue's week. "We close early on Sundays" and
// "we close at 3 on Sundays" are its hours, not a day shut.
const DAY_NAME = '(?:mon|tues|wednes|thurs|fri|satur|sun)days?';
const DAY_LIST = `${DAY_NAME}(?:\\s*(?:,|and|&|\\/|or)\\s*${DAY_NAME})*`;
const OWN_SUBJECT = "(?:we're|we\\s+are|we|i'm|i\\s+am)";
const STILL = '(?:(?:always|usually|also|now)\\s+)?';
const ON_DAYS = `(?:on\\s+|all\\s+day\\s+|every\\s+)?(?:this\\s+)?(${DAY_LIST})`;
// Not a time of day after the days, nor "early" or "at 3" after "close".
const NO_TIME = '(?!\\s+(?:at|by|around|from|till|until)\\s+\\d|\\s+(?:early|earlier)\\b)';
const NO_HOURS = '(?!\\s+(?:at|by|around|before|after|early|earlier|late|later)\\b|\\s+\\d)';
const SHUT_ON = new RegExp([
  // "we're closed Sundays", "we close on Sundays", "I'm shut on Mondays".
  `\\b${OWN_SUBJECT}\\s+${STILL}(?:closed|shut|close)\\s+${ON_DAYS}\\b${NO_TIME}`,
  // "Closed on Sundays, how does this weekend look?": no subject at all.
  `(?:^|[.!?;:,]\\s*|\\n\\s*)(?:(?:but|and|so|also)\\s+)?(?:closed|shut)\\s+${ON_DAYS}\\b${NO_TIME}`,
  // "Sundays we're closed", "saturday we are closed", "on Sundays we close".
  `\\b(${DAY_LIST})\\s*,?\\s+${OWN_SUBJECT}\\s+${STILL}(?:closed|shut|close)\\b${NO_HOURS}`,
].join('|'), 'gi');
// The weekdays `text` (already normalised) says the venue is shut on.
function shutDaysIn(text) {
  const out = [];
  for (const m of text.matchAll(SHUT_ON)) {
    for (const d of (m[1] || m[2] || m[3]).match(new RegExp(DAY_NAME, 'gi')) || []) {
      const day = WEEKDAY(d.replace(/s$/i, ''));
      if (!out.includes(day)) out.push(day);
    }
  }
  return out;
}
function saidShut(question) {
  return shutDaysIn(normalize(question));
}

const same = (a, b) => a.kind === b.kind && a.weekday === b.weekday && a.scope === b.scope
  && Boolean(a.next) === Boolean(b.next) && Boolean(a.nextWeek) === Boolean(b.nextWeek) && Boolean(a.afterNext) === Boolean(b.afterNext);

/**
 * The day words a question says where it asks (above), in the order said, each
 * once: { kind: 'weekday', weekday, next, nextWeek?, afterNext? } | { kind:
 * 'today', part: 'tonight' | 'day' | 'today' } | { kind: 'tomorrow' } | {
 * kind: 'dayAfterTomorrow' } | { kind: 'weekend', scope: 'this' | 'next_words'
 * | 'next' | 'after_next' | 'habit' } | { kind: 'week' }. Empty when it says
 * none.
 */
function dayWords(question) {
  const text = normalize(question);
  const { asking, all } = parts(text);
  // A question in capitals throughout says nothing by its case.
  const shouting = !/[a-z]/.test(text);
  let found = asking.flatMap((p) => tokensIn(p, shouting));
  if (!found.length) found = all.flatMap((p) => tokensIn(p, shouting)).filter((t) => !t.habit);
  const strong = found.filter((t) => !t.weak);
  let kept = strong.length ? strong : found;
  // Two weekdays or more in the possessive beside only a weekend or the week
  // are the days asked, and the weekend or the week says which ones ("How will
  // Friday's crowd compare to Saturday's this weekend?", acceptance,
  // 2026-11-06); one alone is what something belongs to ("How's the rest of
  // the weekend after Saturday's rush?").
  const owned = found.filter((t) => t.possessive && t.kind === 'weekday');
  if (strong.length && strong.every((t) => t.kind === 'weekend' || t.kind === 'week')
      && new Set(owned.map((t) => t.weekday)).size > 1) {
    kept = found.filter((t) => !t.weak || owned.includes(t));
  }
  // The week beside a weekday only says which one ("Monday this week").
  if (kept.some((t) => t.kind === 'weekday')) kept = kept.filter((t) => t.kind !== 'week');
  const out = [];
  for (const t of kept) {
    const { weak, plural, habit, possessive, ...tok } = t;
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
// "Not including tonight" leaves today out, and is read before the
// "including" inside it (acceptance, 2026-11-06).
const LEAVE_OUT = '(?:besides|other\\s+than|except(?:\\s+for)?|apart\\s+from|aside\\s+from|excluding|not\\s+counting|not\\s+including)';
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

module.exports = { dayWords, todayInRanking, saidShut, __parts: (q) => parts(normalize(q)) };
