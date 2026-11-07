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
//   * tomorrow, and the day after tomorrow, which "the day after" is too
//     where the question says tomorrow ("Is tomorrow busier than the day
//     after?", "Will tomorrow or the day after be busier?");
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
  "\\b(?<dayAfter>the\\s+day\\s+after)\\b",
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
// Holidays named for a weekday: a date, not the coming weekday. And names
// that hold one ("the TGI Fridays crowd", "Ruby Tuesday next door"), no day
// at all (fourth repair, 2026-11-06).
const HOLIDAY_BEFORE = /\b(?:black|cyber|easter|palm|ash|holy|maundy|super\s+bowl|small\s+business|tgi|t\.g\.i\.?|ruby)\s+$/i;
// "Good", "super" and "giving" are ordinary words before a day too ("Is this
// a good Friday to run a promo?", "Gonna be a super Sunday?", "We're giving
// Tuesday another shot"), so they name a holiday only written as one, with
// capitals: "Good Friday", "Giving Tuesday" (acceptance, 2026-11-06).
const NAME_HOLIDAY_BEFORE = /\b(?:Good|Super|Giving)\s+$/;
const holidayBefore = (before, day) => HOLIDAY_BEFORE.test(before) || (/^[A-Z]/.test(day) && NAME_HOLIDAY_BEFORE.test(before));

// "THE DAY AFTER" IS THE DAY AFTER TOMORROW WHERE THE QUESTION SAYS TOMORROW
// (recheck, 2026-11-06). "Is tomorrow busier than the day after?" and "Will
// tomorrow or the day after be busier?" were answered with tomorrow alone,
// where the week's ranking had held both days. "The day after" is a day
// unless what follows it is what it comes after: "the day after the game",
// "the day after that", "the day after we reopen", "the day after
// Thanksgiving" or a date. It counts only where tomorrow is said in the
// question (dayWords), as in "Is tomorrow slower than the day after at our
// place?".
const DAY_AFTER_OF = /^\s+(?:the|a|an|that|this|these|those|our|my|your|his|her|their|its|we|we're|i|i'm|you|they|he|she|it|next|last|each|every|thanksgiving|christmas|xmas|easter|halloween|new|memorial|labor|labour|independence|valentine'?s|mother'?s|father'?s|payday|game|show|event|concert|match|parade|holiday|holidays|festival|opening|launch|reopening|closing)\b/i;
const DAY_AFTER_NAME = /^\s+[A-Z]|^\s*\d/;

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

/**
 * Every part of `text`, each with where it starts in `text` ({ p, at }), and
 * the indices of the parts a question asks in.
 */
function partsAt(text) {
  const all = [];
  const asking = [];
  let from = 0;
  for (const raw of text.split(SENTENCES)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const sentenceAt = text.indexOf(sentence, from);
    from = sentenceAt + sentence.length;
    const pieces = sentence.split(SPLICE).flatMap((p) => p.split(RUN_ON)).map((p) => p.trim()).filter(Boolean);
    let pieceFrom = 0;
    for (const p of pieces) {
      const pieceAt = sentence.indexOf(p, pieceFrom);
      pieceFrom = pieceAt + p.length;
      all.push({ p, at: sentenceAt + pieceAt });
    }
    // The last part of a sentence that ends on a question mark asks.
    if (pieces.length && MARKED.test(sentence)) asking.push(all.length - 1);
  }
  if (!asking.length) {
    const holding = all.map((_, i) => i).filter((i) => HOLDS_ASK.test(all[i].p));
    asking.push(...(holding.length ? holding : all.map((_, i) => i).slice(-1)));
  }
  return { all, asking };
}
/** The parts of `text` a question asks in, and every part. */
function parts(text) {
  const { all, asking } = partsAt(text);
  return { asking: asking.map((i) => all[i].p), all: all.map((x) => x.p) };
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

// The day words of one part, each with where it is said in the question
// (`at` to `end`, from `offset`, where the part starts).
function tokensIn(piece, shouting = false, offset = 0) {
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
    else if (g.dayAfter) {
      if (DAY_AFTER_OF.test(after) || DAY_AFTER_NAME.test(after)) continue;
      out.push({ kind: 'dayAfterTomorrow', loose: true });
    }
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
    // Where the word is said, for the words the reading uses (analyze below).
    if (out.length > at) Object.assign(out[at], { at: offset + m.index, end: offset + m.index + m[0].length });
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
  return shutDaysIn(analysisOf(question).text);
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
  return analysisOf(question).words.map((t) => ({ ...t }));
}

// THE WEEKDAYS A QUESTION NAMES ANYWHERE IN IT (recheck, 2026-11-06), for the
// weekend's route, which says every day of the weekend the venue is shut on
// when a question names one (routes/advisor.js weekendShutSaid): "Weekend
// outlook? Particularly Saturday night." asks in its first sentence and names
// Saturday in its second. A weekday counts as dayWords counts one, never a day
// said as the past, a reason, a possessive, a habit or a day the owner says
// the venue is shut on, and never next week's. Nor one in a part that says
// when anyone closes ("Our competitor closes Sundays; how busy is this
// weekend?"): that day is someone's hours, not a day asked.
const CLOSING_SAID = /\b(?:clos(?:e|ed|es|ing)|shut(?:s|ting)?)\b/i;
function weekdaysNamed(question) {
  const a = analysisOf(question);
  if (!a.named) {
    a.named = [];
    a.all.forEach(({ p }, i) => {
      if (CLOSING_SAID.test(p)) return;
      for (const t of a.tokens[i]) {
        if (t.kind !== 'weekday' || t.weak || t.habit || t.next || t.nextWeek || t.afterNext) continue;
        if (!a.named.includes(t.weekday)) a.named.push(t.weekday);
      }
    });
  }
  return [...a.named];
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

// Each, matched throughout, for where the today word it reads is said
// (analyze below).
const TODAY_LEFT_OUT_ALL = new RegExp(TODAY_LEFT_OUT.source, 'gi');
const TODAY_IN_ALL = new RegExp(TODAY_IN.source, 'gi');
const TODAY_SAID = /\b(?:today|tonight|this\s+(?:evening|afternoon|morning))\b/g;

/** 'out' when the question leaves today out of the days it ranks, 'in' when it puts today in, else null. */
function todayInRanking(question) {
  return analysisOf(question).todayCue;
}

// ─── HOW SURE THE READING IS (third recheck, 2026-11-06) ─────────────────────
//
// Three rechecks each found a new kind of question where main's answer, the
// week's or the weekend's whole ranking, happened to hold the day the owner
// meant, and this reader's narrower reading did not: a range of days ("Friday
// thru Sunday" read as its two ends), a holiday ("Black Friday", "Thanksgiving
// weekend"), "after tomorrow", "the day after that", a weekend beside a day
// the owner dwells on, a habit beside "this one". Patching each wording left
// the next one open. So the reading says how sure it is, and the route uses it
// only where it is sure: the shapes the catalog and the batteries prove.
//
//   * one day said plainly: a weekday written out or a short form written as
//     a day ("Fri night"), with next, next week or after next beside it;
//     today, tonight, this morning; tomorrow; the day after tomorrow;
//   * two such days the question joins ("Is Saturday busier than Friday?",
//     "Will tomorrow be busier than tonight?", daysJoined below);
//   * one weekend said with a weekend word (this weekend, next weekend, the
//     following weekend, the weekend after next);
//   * the week, alone or beside today ("Which day is busiest this week,
//     starting today?");
//   * no day word at all;
//
// and only where the reading uses every word of the question that is or may
// be a day or a weekend (unusedWord below, fourth recheck): the same day said
// again elsewhere is used, a day the grammar sets aside (a day said shut, a
// reason, the past, a possessive) is not.
//
// Anything else is not sure, and the route answers it exactly as main does
// (routes/advisor.js mainBridge), so it cannot come out worse than main: a
// range of days, a holiday by name, a date, "after tomorrow", "in two days",
// "the day after" or "the day before" said from another day, three days or
// more, two weekends, a day beside a weekend, weekends as a habit, a word
// that may be a day this grammar does not read ("sat nite", "satday", "w/e")
// beside one it does, a day or weekend word anywhere in the question the
// reading does not use, two days the question does not join, and a day it
// leaves out ("besides monday?").
//
// These checks now stand behind the plain forms (THE PLAIN FORMS below,
// sixth recheck): a question is sure only when it is one of those forms, and
// then only when it passes every check here too.
const DAY_FORM = '(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)';
const SPAN_JOIN = '(?:-|\\u2013|\\u2014|through|thru|to|till|til|until|into)';
// A range of days asked about ("Friday thru Sunday", "Thu-Sat", "from Friday
// until Sunday", "between Friday and Sunday", "Thursday through the weekend"),
// not the venue's hours ("We're open Mon-Fri, how busy will Wed be?").
const RANGE_SAID = new RegExp([
  `\\b${DAY_FORM}\\.?(?:'s)?\\s*${SPAN_JOIN}\\s*${DAY_FORM}\\b`,
  `\\bbetween\\s+${DAY_FORM}\\s+(?:and|&)\\s+${DAY_FORM}\\b`,
  `\\b${DAY_FORM}\\s+(?:through|thru|to|till|til|until|into)\\s+(?:the\\s+)?(?:weekend|end\\s+of\\s+the\\s+week)\\b`,
].join('|'), 'gi');
const HOURS_BEFORE = /\b(?:open|opens|opened|closed|shut|hours|serve|serving|run|running)\s+(?:on\s+|from\s+|only\s+)?$/i;
const HOLIDAY_SAID = new RegExp(`\\b(?:${[
  'black\\s+friday', 'cyber\\s+monday', 'small\\s+business\\s+saturday', 'super\\s+bowl', 'thanksgiving', 'christmas',
  "new\\s+year'?s?", 'nye', 'easter', 'memorial\\s+day', 'labou?r\\s+day', "veterans'?\\s+day", 'independence\\s+day',
  '(?:4th|fourth)\\s+of\\s+july', 'july\\s+(?:4th|4|fourth)', 'halloween', "valentine'?s", "mother'?s\\s+day",
  "father'?s\\s+day", "st\\.?\\s+(?:patrick|paddy)'?s", "patrick'?s\\s+day", 'cinco\\s+de\\s+mayo', 'juneteenth',
  "presidents?'?\\s+day", 'mlk\\s+day', 'martin\\s+luther\\s+king', 'columbus\\s+day', "indigenous\\s+peoples?'?\\s+day",
  'boxing\\s+day', 'hanukkah', 'chanukah', 'diwali', 'eid', 'ramadan', 'lunar\\s+new\\s+year', 'chinese\\s+new\\s+year',
  'mardi\\s+gras', 'fat\\s+tuesday', 'ash\\s+wednesday', 'palm\\s+sunday', 'maundy\\s+thursday', 'holy\\s+(?:thursday|saturday)',
  'election\\s+day', 'bank\\s+holiday', 'long\\s+weekend', 'holiday\\s+weekend', 'public\\s+holiday',
].join('|')})\\b`, 'i');
// Ordinary words before a day as well ("a good Friday to run a promo"), so a
// holiday only with capitals, as the grammar reads them (NAME_HOLIDAY_BEFORE).
const HOLIDAY_NAMED = /\b(?:Good\s+Friday|Giving\s+Tuesday|Super\s+Sunday)\b/;
const AFTER_TOMORROW = new RegExp([
  '(?<!\\bday\\s)\\bafter\\s+tomorrow\\b',
  '\\bovermorrow\\b',
  '\\bin\\s+(?:two|2|three|3|four|4|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|a\\s+few|few)\\s+days\\b',
  '\\b(?:two|2|three|3|four|4)\\s+days\\s+(?:from\\s+(?:now|today)|out|ahead|away|later|time)\\b',
  '\\bnext\\s+(?:two|2|three|3|four|4|few|couple(?:\\s+of)?)\\s+(?:days|nights)\\b',
].join('|'), 'i');
// A day said from another one: "the day after" (that, the game, or
// tomorrow's), "the day before", "the next day", "the night before
// Saturday", "the eve of".
const DAY_FROM_DAY = /\bthe\s+day\s+after\b(?!\s+tomorrow\b)|\bday\s+before\b|\b(?:the\s+)?(?:next|following|previous)\s+(?:day|night|evening)\b|\b(?:night|evening|morning|afternoon)\s+(?:before|after)\b|\beve\s+of\b/i;
// A week counted on from a day ("a week from Friday", "the following
// Saturday", "the Friday after this one", "two Fridays from now"): the
// grammar reads the weekday as this week's.
const WEEK_ON = new RegExp([
  '\\b(?:a|one|two|2|three|3|four|4)\\s+weeks?\\s+(?:from|after|out|later|on)\\b',
  '\\bweeks?\\s+from\\b',
  '\\bfrom\\s+now\\b',
  '\\bfortnight\\b',
  '\\bevery\\s+other\\b',
  '\\b(?:the\\s+)?following\\s+(?:mon|tues|wednes|thurs|fri|satur|sun)days?\\b',
  '\\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\\s+after\\s+(?!next\\b)(?:this|that|the|it|tomorrow|tonight)\\b',
  '\\b(?:two|2|three|3|four|4)\\s+(?:mon|tues|wednes|thurs|fri|satur|sun)days\\b',
].join('|'), 'i');
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?';
// "the 2nd seating" and "1st turn" are no dates.
const NOT_DATE_AFTER = '(?!\\s+(?:seating|sitting|turn|time|round|shift|floor|course|table|service|wave|half|place|week|weekend|month|year|of\\s+(?:the|our|my)\\b))';
const DATE_SAID = new RegExp([
  `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`,
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}`,
  `\\b(?:the|on|by|until|till|for|from)\\s+\\d{1,2}(?:st|nd|rd|th)\\b${NOT_DATE_AFTER}`,
  '\\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\s*(?:am|pm|a\\.m|p\\.m|:|covers|people|guests|tables|staff|servers|bartenders))',
  '(?<![\\d/])\\b(?!24\\/7\\b)(?:0?[1-9]|[12]\\d|3[01])\\/(?:0?[1-9]|[12]\\d|3[01])(?:\\/\\d{2,4})?\\b(?![\\d/])',
].join('|'), 'i');
// A short form written with a date ("Sat 14th", "Fri 11/13").
const SHORT_DATE = /\b(?:Mon|Tues?|Weds?|Thu(?:rs?)?|Fri|Sat|Sun)\.?,?\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th|\/\d{1,2})?\b(?!\s*(?:am|pm|a\.m|p\.m|:|seating|sitting|turn|covers?|people|guests?|tables?|staff|servers?|bartenders?))/;

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// A WORD THAT MAY BE A DAY, which this grammar does not read: a misspelling
// near a weekday ("satday", "thrusdy"), the weekend ("w/e", "weeekend") or
// tomorrow ("tmr", "2moro"), and a short form a lower-case owner may mean as
// the day ("sat nite", "how about sun", "esp sat"). Beside a day the grammar
// does read, the reading may have lost one, and is not sure.
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NOT_A_DAY = new Set(['today', 'tonight', 'tomorrow', 'weekend', 'weekends', 'weekday', 'weekdays', 'weekly', 'money',
  'monkey', 'monkeys', 'mondo', 'moody', 'month', 'months', 'sunny', 'sundae', 'sundaes', 'sundry', 'funday', 'fundays',
  'fridge', 'fridges', 'friend', 'friends', 'frida', 'tuesdays', 'saturn', 'satay', 'thursty', 'weekender', 'weekenders',
  'weakened', 'tomato', 'tomatoes', 'tonights', 'tomorrows']);
const MAYBE_WEEKEND = /^(?:w\/e|w\/end|wkd|wkds|wknd|wknds|wkend|wkends|wk-end|wk-ends|week-end|week-ends)$/;
const MAYBE_TOMORROW = /^(?:tmr|tmw|tmmrw|tmrrw|tmrow|tomoz|tomo|2moro|2morro|2morrow|2morow|2mrw|2mro)$/;
const MAYBE_TODAY = /^(?:2nite|2night|2nyt|tnite|tn|2day|tday|tdy)$/;
// 'day' or 'weekend' for a word that may be one, else null.
function nearDayKind(w) {
  if (NOT_A_DAY.has(w) || DAY_NAMES.includes(w) || DAY_NAMES.includes(w.replace(/s$/, ''))) return null;
  if (MAYBE_WEEKEND.test(w)) return 'weekend';
  if (MAYBE_TOMORROW.test(w) || MAYBE_TODAY.test(w)) return 'day';
  if (w.length < 5 || !/^[a-z]+$/.test(w)) return null;
  const near = (target, most) => w.slice(0, 2) === target.slice(0, 2) && (editDistance(w, target) <= most || editDistance(w, `${target}s`) <= most);
  if (DAY_NAMES.some((d) => near(d, 2))) return 'day';
  if (w.length < 6) return null;
  if (near('weekend', 2)) return 'weekend';
  return near('tomorrow', 2) || near('tonight', 1) ? 'day' : null;
}
// Each word of `text` that may be a day or a weekend (nearDayKind), with
// where it is said; where lower case moves the letters (a letter that lowers
// to two), with nowhere, which no word the reading uses holds.
function maybeWordsIn(text, lower) {
  const moved = lower.length !== text.length;
  const out = [];
  for (const m of lower.matchAll(/[a-z0-9/'-]+/g)) {
    const kind = nearDayKind(m[0].replace(/'s$/, '').replace(/^'+|'+$/g, ''));
    if (kind) out.push(moved ? { at: -1, end: Infinity, kind } : { at: m.index, end: m.index + m[0].length, kind });
  }
  return out;
}
const SHORT_WORD = /\b(mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)\b\.?/gi;
// "We sat dinner at 6", "the sun rush", "with this sun", "C'mon": the word.
const WORD_BEFORE = /(?:\b(?:we|i|they|you|he|she|it|who|people|guests|everyone|everybody|the|a|an|this|that|in|with|of|under|our|their)\s+|c')$/i;
const MAYBE_BEFORE = /(?:\b(?:about|abt|for|by|till|til|until|and|or|n|vs|versus|esp|especially|mostly|mainly|particularly)\.?\s+|[&+/]\s*)$/i;
// Nothing but marks to the end, an emoji included ("fri 🍻 sat 🍻?").
const MAYBE_AFTER = /^[^A-Za-z0-9]*$|^\s*(?:[&+/]|and\b|or\b|n\b|vs\b)|^\s+(?:in\s+particular|esp(?:ecially)?\b|mostly|mainly|only|too|also)\b/i;
// "sat 1st turn by 6:30": a count, not a date.
const COUNT_NEXT = /^\s*\d{1,2}(?:st|nd|rd|th)?\s+(?:seating|sitting|turn|time|round|shift|table|tables|covers?|people|guests?|wave)\b/i;
function maybeShortForms(piece, shouting) {
  const out = [];
  for (const m of piece.matchAll(SHORT_WORD)) {
    const before = piece.slice(0, m.index);
    const after = piece.slice(m.index + m[0].length);
    if (shortIsDay(m[1], before, after, shouting) || WORD_BEFORE.test(before)) continue;
    // A range is its own kind above, the venue's hours when it says so.
    if (RANGE_NEXT.test(after) || RANGE_BEFORE.test(before) || /^-[a-z]/i.test(after) || COUNT_NEXT.test(after)) continue;
    if (PART_NEXT.test(after) || DATE_NEXT.test(after) || MAYBE_BEFORE.test(before) || MAYBE_AFTER.test(after)) out.push(m[1]);
  }
  return out;
}

const DAY_KINDS = new Set(['weekday', 'today', 'tomorrow', 'dayAfterTomorrow']);

// TWO DAYS ARE READ TOGETHER ONLY WHERE THE QUESTION JOINS THEM (fourth
// recheck, 2026-11-06). The reading answers two days it reads with both,
// the busier first, which is right for "Is Saturday busier than Friday?" and
// wrong where the owner names one day and means the other: a correction
// ("Saturday, I mean Sunday, how busy?", "how busy is tuesday *wednesday",
// "How busy will tonight be, I mean tomorrow night"), a rhetorical question
// before the real one ("Who even goes out on a Monday? How's Tuesday?"), a
// day in a name or beside a thing ("Saturday Night Fever theme on Friday",
// "Is the Saturday crew enough for Friday?") or a condition ("How busy will
// tonight be if it rains tomorrow?"). So two days said one after the other
// are sure only where the question joins them: in one part, a few words
// apart, with a word that joins or compares them right before the second
// ("Friday or Saturday", "Is Sunday busier than Saturday", "Saturday and
// Sunday", "Is Monday as busy as Tuesday", "compare tonight with tomorrow",
// never "Is Friday busy or should I ask about Thursday?"); or the second in
// a short part of its own that starts with one ("Is Saturday going to be
// busy? Or Sunday?", "How busy will today be? and tomorrow?", never "Is
// Friday busy? Or should I ask about Thursday?").
const JOIN_BETWEEN = /\b(?:or|and|n|nor|vs|versus|than|plus|compar\w*)\b|[&/+]|\bas\s+\S+\s+as\b/gi;
const JOIN_COMPARED = /\b(?:with|to|against)\b/gi;
const JOIN_LEADS = /^[^\p{L}\p{N}]*(?:(?:ok|okay|so|well|also)\b[^\p{L}\p{N}]*)*(?:(?:or|and|n|nor|vs|versus|plus)\b|[&/+])/iu;
const WORDS = /[\p{L}\p{N}]+/gu;
const wordCount = (s) => (s.match(WORDS) || []).length;
// At most this many words between two days joined in one part, at most this
// many after the word that joins them, and at most this many beside the
// second day in a part of its own.
const JOIN_MOST_WORDS = 6;
const JOIN_MOST_AFTER = 2;
const JOIN_PART_MOST_WORDS = 3;
function daysJoined(a) {
  const days = a.kept.filter((t) => DAY_KINDS.has(t.kind)).sort((x, y) => x.at - y.at);
  for (let i = 1; i < days.length; i += 1) {
    const x = days[i - 1];
    const y = days[i];
    if (same(x, y) && x.part === y.part) continue;
    if (x.piece === y.piece) {
      const between = a.text.slice(x.end, y.at);
      if (wordCount(between) > JOIN_MOST_WORDS) return false;
      const joins = [...between.matchAll(JOIN_BETWEEN)];
      if (/\bcompar/i.test(a.all[x.piece].p)) joins.push(...between.matchAll(JOIN_COMPARED));
      if (!joins.length) return false;
      const last = Math.max(...joins.map((m) => m.index + m[0].length));
      if (wordCount(between.slice(last)) > JOIN_MOST_AFTER) return false;
    } else {
      const part = a.all[y.piece];
      const rest = a.text.slice(part.at, y.at) + a.text.slice(y.end, part.at + part.p.length);
      if (!JOIN_LEADS.test(a.text.slice(part.at, y.at)) || wordCount(rest) > JOIN_PART_MOST_WORDS) return false;
    }
  }
  return true;
}
// A question that asks which day: "which other day is quietest?", "what's our
// busiest night?".
const CHOICE_ASKED = /\b(?:which|what)\b[^.?!]{0,40}?\b(?:day|night|evening)s?\b/i;

// EVERY WORD THAT IS OR MAY BE A DAY OR A WEEKEND, WHEREVER IT IS SAID (fourth
// recheck, 2026-11-06). The rechecks kept finding a day the owner named and
// then set aside in a later sentence with no question mark ("How busy will
// Saturday be? Sorry, I meant Friday.", "Why is Monday always dead? Anyway,
// tell me about Thursday."), a short form that is the only day word ("wknd
// outlook? sat esp"), a contraction read as a possessive ("If Thursday's
// busier than Friday I'll move trivia. Is it?") and a day in another language
// ("sabado"), each read with confidence and answered with the wrong day. So
// the reading is sure only when it uses every word of the question that is or
// may be a day or a weekend, in every sentence, the previous turn's included
// when the follow-on reads it in (advisorFollowOn): a weekday in any case,
// plural, possessive or contraction; a short form (mon, tue, tues, wed, weds,
// thu, thur, thurs, thr, fri, sat, sun), however it is used ("we sat 40
// covers" too); today, tonight, tomorrow, yesterday, this morning, this
// afternoon, this evening, this night; a misspelling or a short spelling of
// any of them (nearDayKind); the weekend, written out or short; and the
// weekdays, today, tomorrow, yesterday and the weekend in Spanish, French,
// Portuguese, German and Italian. A word the reading does not use, anywhere,
// leaves it unsure, and the route answers as main answers.
const FOREIGN_DAYS = [
  // Spanish and Portuguese
  'lunes', 'martes', 'mi[e\\u00e9]rcoles', 'jueves', 'viernes', 's[a\\u00e1]bados?', 'domingos?',
  'segunda(?:-feira)?s?', 'ter[c\\u00e7]a(?:-feira)?s?', 'quarta(?:-feira)?s?', 'quinta(?:-feira)?s?', 'sexta(?:-feira)?s?',
  'hoy', 'ma[n\\u00f1]ana', 'ayer', 'anoche', 'esta\\s+noche', 'hoje', 'amanh[a\\u00e3]', 'ontem', 'esta\\s+noite',
  // French
  'lundis?', 'mardis?', 'mercredis?', 'jeudis?', 'vendredis?', 'samedis?', 'dimanches?',
  "aujourd'hui", 'demain', 'hier', 'ce\\s+soir',
  // German
  'montags?', 'dienstags?', 'mittwochs?', 'donnerstags?', 'freitags?', 'samstags?', 'sonnabends?', 'sonntags?',
  'heute', 'morgen', '[u\\u00fc]bermorgen', 'gestern',
  // Italian
  'luned[i\\u00ec\\u00ed]', 'marted[i\\u00ec\\u00ed]', 'mercoled[i\\u00ec\\u00ed]', 'gioved[i\\u00ec\\u00ed]', 'venerd[i\\u00ec\\u00ed]',
  'sabat[oi]', 'domenic(?:a|he)', 'oggi', 'domani', 'dopodomani', 'ieri', 'stasera', 'stanotte',
];
const FOREIGN_WEEKENDS = [
  'fin\\s+de\\s+semana', 'fin\\s+de\\s+semaine', 'fim\\s+de\\s+semana', 'fine\\s+settimana', 'findes?', 'wochenenden?',
];
// A word on its own: no letter or digit beside it, and not after a letter and
// an apostrophe ("c'mon").
const ALONE_BEFORE = "(?<![\\p{L}\\p{N}])(?<!\\p{L}')";
const ALONE_AFTER = '(?![\\p{L}\\p{N}])';
const DAY_SAID_ANYWHERE = new RegExp(`${ALONE_BEFORE}(?:${[
  '(?:mon|tues|wednes|thurs|fri|satur|sun)days?',
  'mon|tues?|weds?|thu(?:rs?)?|thrs?|fri|sat|sun',
  'today|tonight|tomorrow|yesterday|todays|tonights|tomorrows',
  'this\\s+(?:morning|afternoon|evening|night)',
  ...FOREIGN_DAYS,
].join('|')})${ALONE_AFTER}`, 'giu');
const WEEKEND_SAID_ANYWHERE = new RegExp(`${ALONE_BEFORE}(?:${['weekends?', ...FOREIGN_WEEKENDS].join('|')})${ALONE_AFTER}`, 'giu');
// 'day' or 'weekend' for the first word of the question that is or may be
// one and that the reading does not use, else null. A word the reading uses
// is one it reads where it asks (a.used), or the same day said again
// elsewhere, as the grammar reads that day ("Thursday trivia flopped, how do I
// fill Thursdays?", "Saturday was packed. How busy will Saturday be?"); a
// word the grammar reads as another day, or reads as no day at all, is not.
function unusedWord(a) {
  const said = [...a.maybe];
  for (const m of a.text.matchAll(DAY_SAID_ANYWHERE)) said.push({ at: m.index, end: m.index + m[0].length, kind: 'day' });
  for (const m of a.text.matchAll(WEEKEND_SAID_ANYWHERE)) said.push({ at: m.index, end: m.index + m[0].length, kind: 'weekend' });
  const inside = (w) => ([at, end]) => w.at >= at && w.end <= end;
  const sameDay = (t) => a.words.some((o) => same(o, t) && o.part === t.part);
  const all = a.tokens.flat();
  const loose = said.find((w) => {
    if (a.used.some(inside(w))) return false;
    const t = all.find((x) => inside(w)([x.at, x.end]));
    return !(t && sameDay(t));
  });
  return loose ? loose.kind : null;
}

// ─── THE PLAIN FORMS (sixth recheck, 2026-11-07) ────────────────────────────
//
// Five rechecks each found wordings the checks above were sure of and that
// were answered worse than main: a day set aside after it ("Saturday aside",
// "Sunday excluded", "not included", "doesn't count", "off the table") or
// before it in words no list held ("ignoring", "w/o", "excl.", "sans", "drop
// Saturday", "leave out", "that isn't", "other than the obvious"), a
// correction joined by "or" ("Monday or rather Wednesday"), a pair narrowed by
// saying one day again ("Saturday or Sunday? Just Sunday."), a day glued to a
// word ("fridaynight"), a day in another language, a day said with a time of
// night ("1am Saturday"). The checks were sure unless a warning they knew
// appeared, so every wording nobody had listed came out sure. Now it is the
// other way round: the reader is sure only of a question that is, as a whole,
// one of the plain forms below, and every other question is answered exactly
// as main answers it.
//
// The question is read in lower case, with its punctuation and emoji taken
// out, the spellings owners type put right (ownerWords) and a few greetings
// and fillers set aside at either end ("hey", "ok", "so", "quick question",
// "please", "thanks"). A letter of another alphabet, or a mark that says no
// ("❌ Saturday", "!Saturday"), is no plain form. Each day the form holds is
// one day reference:
//   * a weekday, written out or short ("Friday", "fri", "this Sat", "next
//     Saturday", "Friday next week", "the Friday after next"), with a part of
//     the day after it ("Friday night", "Sun brunch") or as "Friday's happy
//     hour";
//   * today, tonight, this morning, this afternoon, this evening; tomorrow,
//     "tomorrow night"; the day after tomorrow;
//   * this weekend, the weekend, the rest of the weekend, next weekend, the
//     following weekend, the weekend after next.
// The forms are the questions that won over main in the catalog, the
// batteries and the sweeps, said plainly (FORMS below): how busy one day or
// weekend will be; two different days compared; the week ranked, today put in
// or left out of it in so many words ("Besides tonight, which day is busiest
// this week?"); and staffing, prep and promotion with exactly one day.
// Advice about two days ("how many bartenders for fri and sat") is not one.
// Which routes each form is read on is the route's to say (routes/advisor.js
// formOnRoute, which reads plainFormOf below).
//
// A plain form is still read by the grammar above, and is sure only where that
// reading holds exactly the form's days ("how busy will sat be" in lower case
// reads no day, the word "sat") and passes every check above.
const FORM_WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const FORM_SHORT = '(?:mon|tues?|weds?|thu|thurs?|fri|sat|sun)';
const FORM_PART = '(?:night|evening|morning|afternoon|brunch|lunch|dinner|breakfast)';
const FORM_OWNED = '(?:night|evening|morning|afternoon|brunch|lunch|dinner|breakfast|happy hour|crowd|rush)';
// One day reference, the longest first.
const FORM_REF = new RegExp([
  '(?<dat>(?:the )?day after tomorrow)',
  '(?<afterNextWeekend>the weekend after next)',
  '(?<followingWeekend>the following weekend)',
  '(?<nextWeekend>(?:the )?next weekend)',
  '(?<weekend>this weekend|the rest of the weekend|the weekend|weekend)',
  `the (?<afterNext>${FORM_WEEKDAY}) after next`,
  `(?<nextWeek>${FORM_WEEKDAY}) next week`,
  `(?<owned>${FORM_WEEKDAY})'s ${FORM_OWNED}`,
  `next (?<next>${FORM_WEEKDAY}|${FORM_SHORT})(?: ${FORM_PART})?`,
  `(?:this )?(?<day>${FORM_WEEKDAY}|${FORM_SHORT})(?: ${FORM_PART})?`,
  `(?<tomorrowOwned>tomorrow)'s ${FORM_OWNED}`,
  `(?<tomorrow>tomorrow)(?: ${FORM_PART})?`,
  '(?<today>today|tonight|this morning|this afternoon|this evening)',
].map((s) => `\\b${s}\\b`).join('|'), 'g');
// The day word a reference is, as dayWords writes it.
function formWord(g) {
  const weekday = (w) => SHORT_DAYS[w] || WEEKDAY(w);
  if (g.dat) return { kind: 'dayAfterTomorrow' };
  if (g.afterNextWeekend) return { kind: 'weekend', scope: 'after_next' };
  if (g.followingWeekend) return { kind: 'weekend', scope: 'next' };
  if (g.nextWeekend) return { kind: 'weekend', scope: 'next_words' };
  if (g.weekend) return { kind: 'weekend', scope: 'this' };
  if (g.afterNext) return { kind: 'weekday', weekday: weekday(g.afterNext), afterNext: true };
  if (g.nextWeek) return { kind: 'weekday', weekday: weekday(g.nextWeek), nextWeek: true };
  if (g.owned) return { kind: 'weekday', weekday: weekday(g.owned) };
  if (g.next) return { kind: 'weekday', weekday: weekday(g.next), next: true };
  if (g.day) return { kind: 'weekday', weekday: weekday(g.day) };
  if (g.tomorrowOwned || g.tomorrow) return { kind: 'tomorrow' };
  return { kind: 'today', part: /night|evening/.test(g.today) ? 'tonight' : (/morning|afternoon/.test(g.today) ? 'day' : 'today') };
}
const wordKey = (t) => [t.kind, t.weekday || '', t.part || '', t.scope || '', t.next ? 'next' : '', t.nextWeek ? 'nextWeek' : '', t.afterNext ? 'afterNext' : ''].join('|');

const FORM_LEAD = /^(?:(?:hey|hi|hello|hiya|yo|ok|okay|so|well|um+|uh+|hmm+|alright|roost|quick question|quick q|question|q|c'mon|come on|good (?:morning|afternoon|evening))\s+)+/;
const FORM_TAIL = /(?:\s+(?:please|pls|plz|thanks|thank you|thx|ty|roost))+$/;
// A mark that says no: "❌ Saturday", "🚫", "👎", "Friday ≠ Saturday", "!Saturday".
const FORM_NO = /[\u274C\u274E\u2716\u26D4\u2260\u{1F6AB}\u{1F645}\u{1F44E}]|![\p{L}]/u;
const FORM_MOST_CHARS = 120;
// The question as the forms read it, or '' when it can be no plain form.
function formText(question) {
  let t = String(question || '').normalize('NFKC');
  if (FORM_NO.test(t)) return '';
  t = t.toLowerCase().replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
    .replace(/[a-z]+/g, (w) => (Object.hasOwn(SPELLING, w) ? SPELLING[w] : w))
    .replace(/\s*[&+]\s*/g, ' and ').replace(/(?<=[a-z])\s*\/\s*(?=[a-z])/g, ' and ');
  // A letter outside a to z: another alphabet, or an accent.
  if (/[^\x00-\x7f]/.test(t.replace(/[^\p{L}\p{N}]+/gu, ''))) return '';
  // An apostrophe inside a word stays; every other mark and emoji is a space.
  t = t.replace(/'(?![a-z])|(?<![a-z])'/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\bn\b/g, 'and');
  return t.replace(FORM_LEAD, '').replace(FORM_TAIL, '');
}

const F_ADJ = '(?:busy|packed|dead|slow|quiet|crowded|full|slammed|empty|hectic|rammed|steady|lively)';
const F_MORE = '(?:busier|quieter|slower|deader|emptier|fuller|bigger|more packed|more crowded|less busy)';
const F_MOST = '(?:busiest|quietest|slowest|deadest|biggest)';
const F_BE = '(?:be|get)';
const F_GOING = '(?:going to be|gonna be)';
const F_WHO = '(?:it|we|things|the place|the bar|the restaurant|the cafe|the venue|the lunch rush|the dinner rush|the rush)';
const F_ON = '(?:(?:on|for) )?';
const F_WEEK = '(?: (?:this|of the) week)?';
const F_US = '(?: for us| at our place)?';
const F_STAFF = '(?:staff|servers|bartenders|people|cooks|line cooks|baristas|hosts|bussers|runners|dishwashers|employees|waiters|waitstaff|barbacks|hands|workers|staffers)';
const F_HAND = '(?:staff|server|bartender|cook|line cook|barista|host|busser|runner|dishwasher|person|barback|hand|worker|staffer)';
const F_PROMO = '(?:promo|promotion|special|deal|discount|happy hour|happy hour special|event|special event)';
const F_OUT = '(?:besides|other than|apart from|aside from|except|except for|excluding|not counting|not including)';
const F_IN = '(?:including|starting|starting from|starting with|counting)';
// The week ranked, with no day in it.
const F_RANK = `(?:${[
  `(?:what's|whats|what is|which is) (?:the|our) ${F_MOST} (?:day|night)${F_WEEK}`,
  `(?:what|which) (?:day|night)(?: this week)? (?:is|will be)(?: the| our)? ${F_MOST}${F_WEEK}`,
  `which (?:days|nights)(?: this week)? (?:are|will be|look)(?: the)? (?:${F_ADJ}|${F_MOST})${F_WEEK}`,
  `what are (?:the|our|my) ${F_MOST} (?:days|nights)${F_WEEK}`,
  `(?:the |our )?${F_MOST} (?:day|night)${F_WEEK}`,
  `which will be (?:the |our )?${F_MOST}(?: day| night)?${F_WEEK}`,
  `when (?:are we|will we be|is it|will it be) (?:${F_MOST}|${F_ADJ})${F_WEEK}`,
  `when (?:do|will) we peak${F_WEEK}`,
  `when's (?:our|the) peak${F_WEEK}`,
].join('|')})`;
// Each form, over the question with every day reference written D: its name,
// its words, and { days: how many references (1 unless said), pair: two
// different days and no weekend, cue: 'in' or 'out' for today or tonight put
// in or left out of the week ranked, weekend: the reference is a weekend,
// nextWeek: "next week" said after "be" }.
const FORMS = [
  // How busy one day or one weekend will be.
  ['how busy will D be', `how ${F_ADJ} will D ${F_BE}(?: this week)?${F_US}`],
  ['how busy will D be next week', `how ${F_ADJ} will D be next week`, { nextWeek: true }],
  ['how busy is D', `how ${F_ADJ} is D(?: ${F_GOING}| going to get| gonna get| looking)?${F_US}`],
  ['how busy will we be D', `how ${F_ADJ} (?:will ${F_WHO} ${F_BE}|is ${F_WHO}(?: ${F_GOING})?|are we(?: ${F_GOING}| going to get)?) ${F_ON}D${F_US}`],
  ['how busy D', `how ${F_ADJ} ${F_ON}D${F_US}`],
  ['D, how busy', `(?:and )?(?:on )?D how ${F_ADJ}(?: will it ${F_BE}| is it(?: ${F_GOING})?| are we| will we ${F_BE})?`],
  ['how is D looking', `(?:how's|hows|how is) D (?:looking|lookin|shaping up)${F_US}`],
  ['how does D look', `how (?:does|will) D look${F_US}`],
  ['what is D looking like', `(?:what's|whats|what is) D (?:looking|lookin) like${F_US}`],
  ['what does D look like', `what (?:does|will) D look like${F_US}`],
  ['is D busy', `(?:is|will) D(?: ${F_GOING}| be)? ${F_ADJ}${F_US}`],
  ['D busy', `D(?: is| will be| ${F_GOING})? ${F_ADJ}`],
  ['will it be busy D', `(?:is it|are we|will it be|will we be|is it ${F_GOING}|are we ${F_GOING}) ${F_ADJ} ${F_ON}D${F_US}`],
  ['busy D', `${F_ADJ} ${F_ON}D`],
  ['what about D', '(?:and )?(?:what|how) about D(?: then)?'],
  ['D', '(?:and )?D'],
  ['D outlook', 'D outlook|outlook for D'],
  ['when will we peak D', `(?:when|what time) (?:will|do|does) (?:we|it) peak ${F_ON}D`],
  ['when does D peak', '(?:when|what time) (?:does|will) D peak'],
  ['when does the rush start D', `(?:when|what time) (?:does|will) the rush (?:start|hit|begin|kick in) ${F_ON}D`],
  ['what should I expect D', `(?:what (?:should|can|do) (?:i|we) expect|(?:should|can|do) (?:i|we) expect a (?:crowd|rush|big crowd)) ${F_ON}D`],
  ['how many people should I expect D', `how many (?:people|guests|covers|customers) (?:should|can|do|will) (?:i|we) (?:expect|get|see) ${F_ON}D`],
  // Two different days compared.
  ['is D busier than D', `(?:is|will) D(?: be| ${F_GOING})? ${F_MORE} than D${F_US}`, { pair: true }],
  ['which is busier, D or D', `which (?:(?:one |day |night )?(?:is|will be) )?${F_MORE}(?: this week)? ${F_ON}D (?:or|vs|versus) D`, { pair: true }],
  ['D or D, which is busier', `D (?:or|vs|versus|and) D(?: which (?:one )?(?:is|will be))? ${F_MORE}`, { pair: true }],
  ['is D or D busier', `(?:is|will) D or D(?: be)? ${F_MORE}(?: this week)?${F_US}`, { pair: true }],
  ['D or D', 'D (?:or|vs|versus|and) D', { pair: true }],
  ['compare D with D', 'compare D (?:with|to|and|vs|versus) D', { pair: true }],
  ['how does D compare to D', 'how does D compare (?:to|with) D', { pair: true }],
  ['how busy will D be compared to D', `how ${F_ADJ} will D be compared (?:to|with) D`, { pair: true }],
  ['how busy will we be D and D', `how ${F_ADJ} will (?:we|it) be ${F_ON}D (?:and|or) D`, { pair: true }],
  ['how busy will D and D be', `how ${F_ADJ} will D (?:and|or) D be`, { pair: true }],
  // The week ranked; today put in or left out of it; a day against the week.
  ['which day is busiest this week', `${F_RANK}${F_US}`, { days: 0 }],
  ['which day is busiest this weekend', `(?:what's|whats|what is|which is) (?:the|our) ${F_MOST} (?:day|night) (?:of )?D|which (?:day|night) (?:of )?D (?:is|will be) ${F_MOST}`, { weekend: true }],
  ['besides tonight, which day is busiest', `${F_OUT} D ${F_RANK}`, { cue: 'out' }],
  ['which day is busiest, besides tonight', `${F_RANK} ${F_OUT} D`, { cue: 'out' }],
  ['including today, which day is busiest', `${F_IN} D ${F_RANK}`, { cue: 'in' }],
  ['which day is busiest, including today', `${F_RANK} ${F_IN} D`, { cue: 'in' }],
  ['besides tonight, how busy is the rest of the week', `${F_OUT} D how ${F_ADJ} (?:is|will be) the rest of the week`, { cue: 'out' }],
  ['how busy is the rest of the week, besides today', `how ${F_ADJ} (?:will the(?: rest of the)? week be|is the rest of the week) (?:${F_OUT}|after) D`, { cue: 'out' }],
  ['how does the rest of the week look after today', `how does the(?: rest of the)? week look (?:${F_OUT}|after) D`, { cue: 'out' }],
  ['is D the busiest night this week', `is D (?:${F_GOING} )?(?:the|our) ${F_MOST}(?: day| night)?${F_WEEK}`],
  ['how does D compare to the week', 'how does D compare (?:to|with) the(?: rest of the)? week'],
  // Staffing, prep and promotions, on one day.
  ['how should I staff D', `how (?:should|do|can|would) (?:i|we) staff ${F_ON}D`],
  ['how many servers do I need D', `how many ${F_STAFF}(?: (?:should|do|will|would) (?:i|we) (?:need|have|schedule|bring in|put on|book|staff))? ${F_ON}D`],
  ['should I bring in extra staff D', `should (?:i|we) (?:bring in|call in|add|schedule|get|have) (?:an? )?(?:extra|more|another) ${F_HAND}s? ${F_ON}D`],
  ['how do I fill D', 'how (?:do|can|should) (?:i|we) (?:fill (?:a slow |the slow )?D|make D busier)'],
  ['should I run a promo D', `should (?:i|we) (?:run|do|have|try|offer|host) (?:a |an )?${F_PROMO} ${F_ON}D|what ${F_PROMO} should (?:i|we) run ${F_ON}D`],
  ['how much should I prep for D', `(?:how much should (?:i|we) prep|should (?:i|we) prep more|how much (?:do|should) (?:i|we) prep) ${F_ON}D`],
].map(([name, words, o = {}]) => ({
  name, re: new RegExp(`^(?:${words})$`), days: o.days !== undefined ? o.days : (o.pair ? 2 : 1), ...o,
}));
const FORM_BARE_WEEKDAY = new RegExp(`^${FORM_WEEKDAY}$`);

// The plain form `question` is ({ form, refs: [{ said, word }], cue }), or null.
function plainForm(question) {
  const text = formText(question);
  if (!text || text.length > FORM_MOST_CHARS) return null;
  const refs = [];
  const skeleton = text.replace(FORM_REF, (said, ...rest) => {
    refs.push({ said, word: formWord(rest[rest.length - 1]) });
    return 'D';
  });
  for (const f of FORMS) {
    if (refs.length !== f.days || !f.re.test(skeleton)) continue;
    if (f.pair && (refs.some((r) => r.word.kind === 'weekend') || wordKey(refs[0].word) === wordKey(refs[1].word))) continue;
    if (f.cue && !refs.every((r) => r.said === 'today' || r.said === 'tonight')) continue;
    if (f.weekend && !refs.every((r) => r.word.kind === 'weekend')) continue;
    if (f.nextWeek) {
      if (refs[0].word.kind !== 'weekday' || !FORM_BARE_WEEKDAY.test(refs[0].said)) continue;
      refs[0].word = { ...refs[0].word, nextWeek: true };
    }
    return { form: f.name, refs, cue: f.cue || null };
  }
  return null;
}
// Whether the reading holds exactly the plain form's days: the days it reads
// where it asks (the week aside), and for a cue today put in or left out as
// the form says, that today word aside.
function formRead(a, form) {
  const read = new Set(a.words.filter((t) => t.kind !== 'week').map(wordKey));
  const want = new Set();
  for (const r of form.refs) {
    if (form.cue) read.delete(wordKey(r.word));
    else want.add(wordKey(r.word));
  }
  if (form.cue && a.todayCue !== form.cue) return false;
  return read.size === want.size && [...want].every((k) => read.has(k));
}

/**
 * The plain form `question` is, for the route to weigh against the route it
 * was given (routes/advisor.js formOnRoute): { form, days, words, cue }, its
 * name, how many day references it holds, their day words, and 'in' or 'out'
 * for today put in or left out of the week ranked (null for neither); or null.
 */
function plainFormOf(question) {
  const form = formOf(question);
  return form ? {
    form: form.form, days: form.refs.length, words: form.refs.map((r) => ({ ...r.word })), cue: form.cue,
  } : null;
}

/**
 * How sure the reading of `question` is: { sure: true } for a plain form whose
 * reading holds its days and passes every check above, else { sure: false, why }.
 */
function dayConfidence(question) {
  const form = formOf(question);
  if (!form) return { sure: false, why: 'not one of the plain forms' };
  const a = analysisOf(question);
  if (!a.conf) a.conf = confidenceOf(a, question, form);
  return { ...a.conf };
}
function confidenceOf(a, question, form) {
  const { text, shouting } = a;
  const unsure = (why) => ({ sure: false, why });
  for (const m of text.matchAll(RANGE_SAID)) {
    if (!HOURS_BEFORE.test(text.slice(0, m.index))) return unsure('a range of days');
  }
  if (HOLIDAY_SAID.test(text) || HOLIDAY_NAMED.test(text)) return unsure('a holiday');
  if (AFTER_TOMORROW.test(text)) return unsure('a day counted on from tomorrow');
  if (WEEK_ON.test(text)) return unsure('a week counted on from a day');
  if (DAY_FROM_DAY.test(text)) return unsure('a day said from another day');
  if (DATE_SAID.test(text) || SHORT_DATE.test(text)) return unsure('a date');
  const { words } = a;
  const days = words.filter((t) => DAY_KINDS.has(t.kind));
  // A weekend said anywhere in the question, not only where it asks: "Will
  // we be busy on the weekend, esp. Sunday?" asks in "Sunday?".
  const weekends = [...words, ...a.tokens.flat()].filter((t) => t.kind === 'weekend');
  if (days.length >= 3) return unsure('three days or more');
  if (new Set(weekends.map((t) => t.scope)).size >= 2) return unsure('two weekends');
  if (weekends.some((t) => t.scope === 'habit')) return unsure('weekends as a habit');
  if (weekends.length && (days.length || weekdaysNamed(question).length)) return unsure('a day beside a weekend');
  // A day read from outside the sentence that asks, when that sentence asks
  // which day ("We might shut Wednesday, which other day is quietest?"): the
  // day is the setup, and may be the one the owner sets aside.
  if (days.length && !todayInRanking(question) && a.asking.some((i) => CHOICE_ASKED.test(a.all[i].p))
      && !a.asking.some((i) => a.tokens[i].some((t) => DAY_KINDS.has(t.kind)))) {
    return unsure('a day said outside a question that asks which day');
  }
  if (words.length && (a.maybe.length || a.all.some(({ p }) => maybeShortForms(p, shouting).length))) {
    return unsure('a word that may be a day');
  }
  const loose = unusedWord(a);
  if (loose) return unsure(`a ${loose} word the reading does not use`);
  if (!daysJoined(a)) return unsure('two days the question does not join');
  if (a.leftOut) return unsure('a day the question leaves out');
  // TODAY PUT IN A RANKING THAT SAYS NO WEEK (seventh recheck, 2026-11-07).
  // "Including today, when are we busiest?", "The busiest night, counting
  // tonight" and "Including tonight, what's the quietest night?" read today
  // alone: their ranking words say no week the way "which day" or "this week"
  // do, so the route answered about today and lost the week's busiest or
  // quietest day, which main names. Today put in a ranking is sure only
  // beside a week word ("Including today, which day is busiest?").
  if (form.cue === 'in' && !words.some((t) => t.kind === 'week')) return unsure('today put in a ranking that says no week');
  if (!formRead(a, form)) return unsure('a reading that is not the plain form\'s');
  return { sure: true };
}

// A DAY THE QUESTION LEAVES OUT IS NO DAY ASKED (fourth recheck, 2026-11-06).
// "Which day is quietest this week? besides monday?" was answered with
// Monday's line: the reading read the day the owner set aside as the day
// asked. A day word straight after a word that leaves it out (besides, other
// than, except, apart from, excluding, not counting, not, but, skip, forget,
// never mind, instead of, rather than, without, minus, no), anywhere in the
// question ("Is Friday or Saturday busier? Never mind Saturday."), leaves the
// reader unsure, but today where the route ranks the week without it
// (todayInRanking).
const LEFT_OUT_BEFORE = /\b(?:besides|other\s+than|except(?:\s+for)?|apart\s+from|aside\s+from|excluding|not\s+counting|not\s+including|not|but|skip(?:ping)?|forget(?:\s+about)?|never\s*mind|instead\s+of|rather\s+than|without|minus|no)\s+(?:(?:the|this|next|on|a|an)\s+)?$/i;

// ONE READING OF A QUESTION, KEPT (fourth recheck, 2026-11-06). The route
// reads a question's days several times over (dayGate, readingFor, the
// weekend's plan, the advice path), and each read normalised it, split it and
// read every part again. The reading is made once per question and kept for
// the last few questions, so a question costs one reading. A reading is of the
// question's text alone, so a kept one is the one a new read would make. The
// plain form the question is (plainForm) is kept beside it (sixth recheck,
// 2026-11-07): the route asks for it on every read (dayConfidence,
// formOnRoute), and a question that is no plain form is never read further.
const READINGS = new Map();
const READINGS_KEPT = 32;
function keptFor(question) {
  const key = String(question || '');
  let kept = READINGS.get(key);
  if (!kept) {
    kept = { key, form: undefined, analysis: null };
    if (READINGS.size >= READINGS_KEPT) READINGS.delete(READINGS.keys().next().value);
    READINGS.set(key, kept);
  }
  return kept;
}
function analysisOf(question) {
  const kept = keptFor(question);
  if (!kept.analysis) kept.analysis = analyze(kept.key);
  return kept.analysis;
}
function formOf(question) {
  const kept = keptFor(question);
  if (kept.form === undefined) kept.form = plainForm(kept.key);
  return kept.form;
}
// The reading of `question`: its text, its parts and each part's day words,
// the day words it says where it asks (dayWords), today put in or left out of
// the week (todayInRanking), where the words those read are said in it
// (`used`, each [at, end]), and the words in it that may be a day
// (maybeWordsIn).
function analyze(question) {
  const text = normalize(question);
  const lower = text.toLowerCase();
  // A question in capitals throughout says nothing by its case.
  const shouting = !/[a-z]/.test(text);
  const { all, asking } = partsAt(text);
  const tokens = all.map(({ p, at }, i) => tokensIn(p, shouting, at).map((t) => Object.assign(t, { piece: i })));
  // "The day after" is a day only where tomorrow is said (DAY_AFTER_OF).
  const saysTomorrow = /\btomorrow\b/i.test(text);
  const read = (i) => tokens[i].filter((t) => !t.loose || saysTomorrow);
  let found = asking.flatMap(read);
  if (!found.length) found = all.flatMap((_, i) => read(i)).filter((t) => !t.habit);
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
  const words = [];
  for (const t of kept) {
    const {
      weak, plural, habit, possessive, loose, at, end, piece, ...tok
    } = t;
    if (!words.some((o) => same(o, tok))) words.push(tok);
  }
  const used = kept.map((t) => [t.at, t.end]);
  // Today put in or left out of the week in so many words ("Besides tonight,
  // which day is busiest this week?") is a reading of that today word, which
  // the route ranks the week by (routes/advisor.js readingFor).
  let todayCue = null;
  if (TODAY_LEFT_OUT.test(lower)) todayCue = 'out';
  else if (TODAY_IN.test(lower)) todayCue = 'in';
  const cued = [];
  if (todayCue && lower.length === text.length) {
    for (const m of lower.matchAll(todayCue === 'out' ? TODAY_LEFT_OUT_ALL : TODAY_IN_ALL)) {
      for (const w of m[0].matchAll(TODAY_SAID)) cued.push([m.index + w.index, m.index + w.index + w[0].length]);
    }
  }
  used.push(...cued);
  // A day the question leaves out (LEFT_OUT_BEFORE above), wherever it is
  // said, other than today in a cue the route ranks the week by.
  const leftOut = tokens.flat().some((t) => t.kind !== 'week' && LEFT_OUT_BEFORE.test(text.slice(0, t.at))
    && !cued.some(([at, end]) => at >= t.at && end <= t.end));
  return {
    text, shouting, all, asking, tokens, words, kept, todayCue, used, leftOut, maybe: maybeWordsIn(text, lower),
  };
}

module.exports = {
  dayWords, todayInRanking, saidShut, weekdaysNamed, dayConfidence, plainFormOf, __parts: (q) => parts(normalize(q)), __plainForm: plainForm,
};
