// ---------------------------------------------------------------------------
// ROOST'S ANSWER CHECK (2026-10-28).
//
// Until this date Roost could not write a digit. Every number had to be a
// {{fact:id}} placeholder the server filled in, any digit in the model's
// draft threw the WHOLE answer away, numbers spelled as words did the same,
// and advice could not name a price, a percentage or a rule of thumb at all.
// It was safe and it was close to useless: an owner asking what a slow
// Tuesday costs them, or what to charge for a special, got a refusal or a
// paragraph of hedges.
//
// The rework, in three lines:
//   1. Numbers are allowed. Facts about the venue still arrive as
//      placeholders, because that is how the exact value and its unit get in,
//      but the model may write digits for arithmetic, prices, rules of thumb
//      and the numbers the owner typed.
//   2. A number that CLAIMS something about this venue ("your Friday hit 92",
//      "you had 140 covers") has to be one of its facts or worked out from
//      them. A sentence carrying one that is not is dropped on its own, and
//      the rest of the answer stands. One bad sentence no longer costs the
//      owner the whole answer.
//   3. The answer has a shape: a short direct answer first, then up to four
//      short points, then the sources once at the end (the client prints
//      them). The model returns it as JSON so the shape cannot drift.
//
// What did not move: an unknown placeholder, two facts fused into one number,
// a leaked prompt, an upsell, and instructions on employment law, health,
// privacy or dishonest reporting still void the whole answer.
//
// Pure functions only. The substitution and fact formatting it needs are
// passed in by advisorPhrasing, which requires this module, so nothing here
// can require it back.
// ---------------------------------------------------------------------------

// ── The shape ───────────────────────────────────────────────────────────────

// Not a text dump: a short answer and a few points. Anything past these is
// cut, not refused, because a long answer is still an answer.
const MAX_ANSWER_SENTENCES = 3;
const MAX_POINTS = 4;
// A plain-text reply (no JSON) longer than this is a wall of text, and it is
// discarded the way the old advice valve discarded one.
const MAX_PLAIN_SENTENCES = 8;
// A point is one line on a phone. Past this it is a paragraph wearing a bullet.
const MAX_POINT_CHARS = 260;

// The bullet the server writes into `text`. A client that predates the new
// shape prints each line as a paragraph, so the bullet has to read well there
// too, which a hyphen does not.
const BULLET = '• ';

// What the model is asked to return, for the API's structured output mode.
const RESPONSE_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    points: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['answer', 'points'],
});

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(“$])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A point the model wrote with its own bullet or number in front.
const LEADING_MARK = /^\s*(?:[-*•‣◦⁃]|\d{1,2}[.)])\s+/;

/**
 * Read the model's reply. JSON is what it is asked for; plain text is still
 * accepted, because the tests and a model that ignored the format both write
 * it, and a plain reply keeps the old single-paragraph rendering.
 * @returns {{structured: boolean, answer: string[], points: string[]}|null}
 */
function parseAnswer(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    let parsed = null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.answer === 'string') {
      const answer = splitSentences(parsed.answer.replace(/\s+/g, ' '));
      const points = (Array.isArray(parsed.points) ? parsed.points : [])
        .filter((p) => typeof p === 'string')
        .map((p) => p.replace(/\s+/g, ' ').replace(LEADING_MARK, '').trim())
        .filter(Boolean);
      if (answer.length === 0 && points.length === 0) return null;
      return { structured: true, answer, points };
    }
  }

  // Plain text. Lines that start with a bullet are points; everything before
  // the first of them is the answer.
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const bulletAt = lines.findIndex((l) => LEADING_MARK.test(l));
  if (bulletAt > 0) {
    return {
      structured: true,
      answer: splitSentences(lines.slice(0, bulletAt).join(' ')),
      points: lines.slice(bulletAt).map((l) => l.replace(LEADING_MARK, '').trim()).filter(Boolean),
    };
  }
  return { structured: false, answer: splitSentences(lines.join(' ')), points: [] };
}

/** The text the owner receives: the answer, then one line per point. */
function assemble({ structured, answer, points }) {
  if (!structured) return answer.join(' ');
  const lead = answer.join(' ');
  return [lead, ...points.map((p) => `${BULLET}${p}`)].filter(Boolean).join('\n');
}

// ── Dashes ───────────────────────────────────────────────────────────────────
//
// DESIGN-STANDARD rule 1 is no em dashes in anything an owner reads. The old valve
// threw the whole answer away for one; now it is mended in place, because a
// dash is punctuation, not a claim. A range between two numbers reads "to",
// and any other dash becomes a comma.
const DASH = '[\\u2012\\u2013\\u2014\\u2015]';
function repairDashes(text) {
  return String(text)
    .replace(new RegExp(`(\\d)\\s*${DASH}\\s*(?=[$\\d])`, 'g'), '$1 to ')
    .replace(new RegExp(`\\s*${DASH}+\\s*`, 'g'), ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?])/g, '$1');
}

// ── Numbers in house style ──────────────────────────────────────────────────
//
// THE 2026-11-03 LIVE EVAL READ ALL 179 ANSWERS AND FOUND THE SAME SLIPS AGAIN
// AND AGAIN, every one in a number the model wrote itself (a placeholder
// already renders in house style): "$1350" a line under "$1,350", "13:00",
// "20:00" and "22:00" beside "2:30 PM" and "10 PM", "4pm to 6pm", "5:00 PM"
// beside "5 PM", "your reading was -18 points under your typical Monday", and
// "On Tuesday Oct 27". Each is set right here, after the check has read the
// draft, and none changes what a number says.
//
// EVERY RULE IS NARROW, AND TWO ADVERSARIAL REVIEWS ARE WHY. The first
// version grouped every long number (a zip code became "10,001"), turned any
// HH:MM into a clock ("keep ticket times under 15:00" became "under 3 PM"),
// and dropped signs inside ranges ("-18 to -25 points under" read "-18 to
// 25"); the second still read a timer after a clock word ("after 15:00 on the
// timer" became "after 3 PM"), put a full stop after "a.m." before any
// capital ("Open at 10 a.m. Sunday" became "10 AM. Sunday"), and dropped one
// sign of "-18 or -25". Now:
//   * only a dollar amount gets its thousands comma;
//   * "7pm", "7 pm" and "5:00 PM" read "7 PM" and "5 PM"; a dotted "a.m." is
//     left as written, since it can also end the sentence;
//   * a 24-hour time is turned to 12 hours only in a line that already shows
//     a 12-hour one (the "22:00" beside "11 PM" the owner saw), only for
//     13:00 to 23:59, only after a clock word ("at", "before", "after",
//     "until", "around", "from", "between", "opens", "closes", "doors") or at
//     the end of a range that began with one, and never in a line where a
//     time is a duration ("15:00 minutes"); "9:00" or "5:00" could be either
//     half of the day, and a guess would put a 5 PM special at 5 AM;
//   * a sign goes only in "-18 points under your usual ...": a points or
//     percent gap, a word that agrees with the sign, the venue's own usual
//     after it, and nothing in front that makes it half of a range or of a
//     longer number.
const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)';
const WEEKDAY_THEN_DATE = new RegExp(`\\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (${MONTHS}\\.? \\d{1,2})\\b`, 'g');
const MONEY_UNGROUPED = /\$([1-9]\d{3,})(?!\d|,\d)/g;
const TWELVE_HOUR_SHOWN = /\b\d{1,2}(?::[0-5]\d)?\s[AP]M\b/;
const A_DURATION = /\b\d{1,2}:[0-5]\d\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b/i;
const NOT_BEFORE_A_UNIT = '(?![\\d:])(?!\\s*(?:[aApP]\\.?\\s?[mM]|minutes?|mins?|hours?|hrs?|seconds?|secs?)\\b)';
const CLOCK_WORD_24 = new RegExp(`(?<=\\b(?:at|before|after|until|till|around|from|between|opens?|opening|closes?|closing|doors?)\\s+)(1[3-9]|2[0-3]):([0-5]\\d)${NOT_BEFORE_A_UNIT}`, 'gi');
const RANGE_END_24 = new RegExp(`(?<=\\b\\d{1,2}(?::[0-5]\\d)?\\s[AP]M\\s+(?:and|to|until|till|through|-)\\s+)(1[3-9]|2[0-3]):([0-5]\\d)${NOT_BEFORE_A_UNIT}`, 'g');
const TIDY_CLOCK_AMPM = /(?<![$\d.,:])\b(\d{1,2})(?::([0-5]\d))?\s?([aApP])[mM]\b(?![a-zA-Z])/g;
const USUAL = '\\s+(?:(?:your|the|their|our)\\s+)?(?:usual|typical|normal|own|baseline|median|middle|average|regular)\\b';
const NOT_IN_A_RANGE = '(?<![\\d.,]\\s*)(?<![\\w$.,])(?<!\\b(?:from|to|and|or|nor|vs|versus|through|between)\\.?\\s+)';
const MINUS_UNDER_USUAL = new RegExp(`${NOT_IN_A_RANGE}[-\\u2212](\\d+(?:\\.\\d+)?)(?![\\d.,]*\\s+(?:or|to|and|vs|versus|nor)\\b)(?=(?:\\s?%|\\s?percent|\\s+points?)?\\s+(?:under|below|behind|short\\s+of)${USUAL})`, 'g');
const PLUS_OVER_USUAL = new RegExp(`${NOT_IN_A_RANGE}\\+(\\d+(?:\\.\\d+)?)(?![\\d.,]*\\s+(?:or|to|and|vs|versus|nor)\\b)(?=(?:\\s?%|\\s?percent|\\s+points?)?\\s+(?:over|above|ahead\\s+of)${USUAL})`, 'g');

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function twelveHour(hour, minutes) {
  const h = Number(hour) % 24;
  const mm = minutes && minutes !== '00' ? `:${minutes}` : '';
  return `${h % 12 === 0 ? 12 : h % 12}${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/** One answer line with the model's own numbers in house style. */
function tidyNumbers(text) {
  let out = String(text)
    .replace(MONEY_UNGROUPED, (m, d) => `$${groupThousands(d)}`)
    .replace(TIDY_CLOCK_AMPM, (m, h, mm, half) => {
      const hour = Number(h);
      if (hour < 1 || hour > 12) return m;
      return `${hour}${mm && mm !== '00' ? `:${mm}` : ''} ${half.toUpperCase()}M`;
    });
  if (TWELVE_HOUR_SHOWN.test(out) && !A_DURATION.test(out)) {
    out = out
      .replace(CLOCK_WORD_24, (m, h, mm) => twelveHour(h, mm))
      .replace(RANGE_END_24, (m, h, mm) => twelveHour(h, mm));
  }
  return out
    .replace(MINUS_UNDER_USUAL, '$1')
    .replace(PLUS_OVER_USUAL, '$1')
    .replace(WEEKDAY_THEN_DATE, '$1, $2');
}

// ── Content that voids the whole answer ─────────────────────────────────────

// A refusal that sells is the darkest pattern available to this product.
const UPSELL = /\b(upgrade|pro\s+plan|premium\s+plan|subscription|paid\s+tier|paid\s+plan|our\s+plans)\b/i;
// The model reciting its own contract.
const PROMPT_LEAK = /(ROOST\s+(PHRASING|OPERATING\s+ADVICE|QUESTION|ANSWER)\s+(CONTRACT|ROUTER)|\bmy\s+instructions\b|\bsystem\s+prompt\b|\bthese\s+instructions\b|\bthe\s+fact\s+block\b|\bSECTION\s+(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)\b)/i;

// The classes Roost does not give instructions on, read on the way OUT. A
// question that routes cleanly can still be answered with an employment
// instruction, so the boundary is held where the text is (the 2026-08-20
// review: "Make unpaid late work a condition of the shift" was once served as
// advice). Narrowed on 2026-10-28 so ordinary money advice gets through:
// payroll and overtime are words an owner managing labour cost uses every
// week, and "keep payroll near a third of sales" is advice, not law.
const PROHIBITED_ADVICE = [
  {
    reason: 'employment, pay or hiring instruction',
    re: /\b(unpaid|off\s+the\s+clock|without\s+pay|dock(?:ing)?\s+(?:their|his|her|the)?\s*(?:pay|wages|tips)|withhold(?:ing)?\s+(?:their\s+|the\s+|his\s+|her\s+|your\s+|staff\s+)?(?:pay|wages|tips)|garnish\w*(?:\s+(?!and\b|then\b)[\w']+){0,3}\s+(?:wages?|pay|paychecks?|earnings|salary)|wage\s+garnish\w*|minimum\s+wage|independent\s+contractors?|cash\s+in\s+hand|under\s+the\s+table|tip\s+(?:pool|credit|out)|fire\s+(?:them|him|her|a\s+(?:server|bartender|barista|cook|chef|host|hostess|manager|member|porter|runner)|your\s+(?:staff|crew|team|opener|closer|server|bartender|barista|cook|chef|host|hostess|manager|employee|worker))|terminat(?:e|ing)\s+(?:them|their|his|her)|let\s+(?:them|him|her|the\s+(?:rest|others))\s+go|write\s+(?:them|him|her)\s+up|disciplinary|non[\s-]?compete|probationary\s+period|hold\s+(?:the\s+|my\s+|your\s+|our\s+)?(?:last\s+|closing\s+|late\s+|whole\s+)?(?:shift|crew|staff|team|servers?|closers?|openers?|porters?|them|him|her)\s+back\b|condition\s+of\s+the\s+(?:shift|rota|job|role)|(?:no|nothing)\s+extra\s+on\s+the\s+(?:sheet|books|rota|clock)|off\s+the\s+(?:sheet|books)|start\s+(?:their|his|her|the)\s+clock|compel(?:ling)?\s+(?:the\s+|a\s+|my\s+|our\s+|any\s+)?(?:waiter|waitress|server|staff|team|crew|barista|bartender|cook|chef|host|hostess|porter|employee|worker|them|him|her)|remain(?:ing)?\s+(?:beyond|past|after)\s+(?:closing|close|their\s+shift|the\s+shift))\b|\b(?:work|works|working|stay|stays|staying|remain|remains|remaining|shift|shifts|closing|overtime)\b[^.!?]{0,40}\bgratis\b|\bgratis\b[^.!?]{0,40}\b(?:work|shift|closing|hours?)\b/i,
  },
  {
    reason: 'legal, tax, licensing or insurance instruction',
    re: /\b(liabilit(?:y|ies)|liable\s+for|held\s+liable|lawsuit|sue\s+(?:them|him|her|us)|small\s+claims|breach\s+of\s+contract|(?:your|the)\s+lease|zoning|liquor\s+licen[cs]e|health\s+(?:code|inspector|inspection)|food\s+safety\s+inspection|fire\s+marshal|sales\s+tax|income\s+tax|tax\s+(?:deduction|return|write[\s-]?off|bill)|the\s+irs|insurance\s+(?:claim|policy|cover|coverage)|indemnif|waiver)\b/i,
  },
  {
    reason: 'health or medical instruction',
    re: /\b(symptoms?|diagnos(?:e|is|ed)|prescri(?:be|ption)|medication|dosage|allergic\s+reaction|epi[\s-]?pen|concussion|faint(?:ing|ed)?|seizure|overdose|alcohol\s+poisoning|mental\s+health|therapy|paramedics?|ambulance|first\s+aid|urgent\s+care|passed\s+out|unresponsive|not\s+breathing|went\s+(?:white|pale|grey|gray)|blacked\s+out|slumped|convuls|the\s+recovery\s+position|call\s+(?:nine|911|999|112|an?\s+ambulance)|heimlich|abdominal\s+thrusts?|back\s+blows?|chest\s+compressions?|cpr\b|defibrillator|\baed\b|epinephrine|tourniquet|choking|anaphyla\w*|cardiac\s+arrest|heart\s+attack)\b/i,
  },
  {
    reason: 'private information about an individual',
    re: /\b((?:identify|track|name|profile|target|single\s+out|list|find|contact|text|email|call|message|approach)\s+(?:individual|specific|particular|named|which)\s+(?:user|customer|guest|patron|people|person|regular)|(?:phone\s+numbers?|email\s+addresses|contact\s+details|names?)\s+of\s+(?:individual|specific|particular|the|your|our)?\s*(?:user|customer|guest|patron|people|person|regular)s?|personal\s+(?:data|details|information)|home\s+address(?:es)?|date\s+of\s+birth|how\s+old\s+(?:they|each|individual))\b/i,
  },
  {
    reason: 'dishonest reporting',
    re: /\b(look\s+busier|appear\s+busier|seem\s+busier|busier\s+than\s+(?:it|you)\s+(?:is|are|really)|inflat(?:e|ing)\s+(?:your|the)\s+(?:reading|readings|numbers|count|counts|slider|score)|overstat(?:e|ing)|exaggerat(?:e|ing)|fake\s+(?:a\s+)?(?:review|reading|check[\s-]?in|report|booking)s?|buy\s+reviews?|astroturf|pad\s+(?:the|your)\s+(?:numbers|count|counts|figures)|fudg(?:e|ing)|misrepresent|under[\s-]?report(?:ing)?|over[\s-]?report(?:ing)?|game\s+the\s+(?:system|ranking|rankings|algorithm))\b/i,
  },
  {
    // Timing a self-reported reading to flatter the room is the same lie as
    // inflating it, written as a schedule instead of a figure.
    reason: 'dishonest reporting, written as timing',
    re: /\b(?:post|set|put|enter|leave|hold|log|record)\s+(?:your|the)\s+(?:reading|readings|slider|score|count|number)\b[^.!?]*\b(?:fullest|busiest|peak|peaks|highest|at\s+its\s+best)\b|\bleave\s+it\s+(?:there|up|set)\b[^.!?]*\b(?:rest\s+of\s+the\s+(?:night|service|shift|week)|all\s+(?:night|service|week))\b/i,
  },
  // A MEDICINE BY NAME IS A MEDICAL INSTRUCTION in any answer a venue reads.
  // An adversarial review (2026-11-03) got "Give him 400 mg of ibuprofen and
  // run the hand under cool water for 20 minutes" past the entry above. A
  // wider set of patterns was tried the same night, for cash wages off
  // payroll, tip splitting, doses and gaming the app's reading, and a second
  // review found it voided ordinary advice ("guests pay the bartender in
  // cash", "keep 100% of their tips", "a large cold brew can top 300 mg", a
  // Painkiller on the tiki list, "run your finger down the book") while close
  // variants of all four still passed. Only the medicine names stayed: they
  // have no other sense in a venue's answer.
  {
    reason: 'health or medical instruction',
    re: /\b(?:ibuprofen|naproxen|paracetamol|acetaminophen|tylenol|advil|motrin|aleve|nurofen|panadol|aspirin|antihistamines?|benadryl|zyrtec|claritin|cetirizine|loratadine|inhalers?|burn\s+(?:cream|gel|dressing))\b/i,
  },
];

/**
 * The reason the whole answer is void, or null.
 *
 * NO WORD IS READ IN ITS INNOCENT SENSE, ON PURPOSE (2026-11-03). The live
 * eval lost two good answers to a word read the other way: "Release unpaid or
 * unconfirmed tables" (a club, on no-shows) as an employment instruction and
 * "without choking the room" (a bar, on bottle service) as a medical one.
 * Setting those words aside when they named a guest's money or a part of the
 * room was tried the same night, and an adversarial review got real
 * instructions through it: "Make the waiter cover unpaid tabs out of pocket",
 * "Ask new hires to work two unpaid tables as a trial", "If a guest starts
 * choking the floor staff should stand behind them and pull sharply in and up
 * under the ribs". The check stays strict, and the contract asks the model to
 * keep both words for their one sense (advisorPrompt, STYLE).
 *
 * NO REFERRAL EXEMPTION, ON PURPOSE (2026-10-28 night). "Talk to an
 * accountant or a lawyer about debts, the lease or winding down" voided a
 * whole answer to "we are going under" in a stand-in model eval. Exempting a
 * sentence that names who to ask was tried, and an adversarial review got
 * real instructions through it with a hedge on the end ("Fire him for the
 * no-shows, and ask your lawyer to draft the letter", "Ask your bookkeeper to
 * dock their pay"). The advice prompt now asks for the referral to name who
 * to ask and leave the legal matter unnamed.
 */
function wholeAnswerVeto(text) {
  if (UPSELL.test(text)) return 'upsell';
  if (PROMPT_LEAK.test(text)) return 'prompt leak';
  for (const { reason, re } of PROHIBITED_ADVICE) {
    if (re.test(text)) return reason;
  }
  return null;
}

// ── Content that drops one sentence ─────────────────────────────────────────

// A study, survey or report nobody can find is a number wearing borrowed
// authority. Rules of thumb are fine ("most rooms keep food cost near a
// third"); a citation the model made up is not.
const FABRICATED_SOURCE = /\b(stud(?:y|ies)\s+(?:show|shows|showed|found|find|finds|suggest|suggests)|research\s+(?:shows?|showed|found|finds|suggests?)|surveys?\s+(?:show|shows|showed|found|find|finds)|according\s+to\s+(?:a|the|one|recent)\s+(?:study|report|survey|poll)|a\s+(?:recent\s+)?(?:study|survey|report|poll)\s+(?:by|from|found|showed|shows))\b/i;
// General advice dressed as a measurement of THIS venue, or of venues like it.
// A sentence that also carries one of the venue's own facts is reading those
// facts out, which is fine.
const FALSE_MEASUREMENT = /\b((?:our|the)\s+(?:data|numbers|measurements?|model|analysis|corpus)\s+(?:shows?|says?|said|found|indicates?|suggests?)|we\s+(?:measured|counted|observed|tracked|analy[sz]ed)\b|venues?\s+(?:like\s+yours|in\s+your\s+area)\s+(?:saw|see|report|reported|averaged?|earn|earned|make|made))/i;
// MISSING DATA IS NOT AN EMPTY ROOM (2026-11-03). A club asking about a second
// barista on Saturday mornings was told "Saturday mornings carry no recorded
// traffic for your room, so adding morning staff is unneeded payroll": the
// block simply held no morning hours. "No recorded traffic" turns what we do
// not have into a claim that nobody came. "We have no reading for Saturday
// mornings" is the true sentence, and a point about the data itself ("no
// recorded sales data") is not touched. Only a part of the venue's week is
// read as emptied this way: "loyalty members with no recorded visits since
// spring", "if no registered guests have arrived by 10 PM" and "a section with
// no logged covers by 7 PM" are ordinary advice (2026-11-03 review), and so is
// what we say we hold ("we have no recorded traffic for Saturday mornings").
const PART_OF_THE_WEEK = '(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|mornings?|afternoons?|evenings?|nights?|weekends?|weekdays?|lunch(?:es)?|brunch(?:es)?|dinners?|(?:your|the)\\s+room)';
const NO_RECORDED = '(?<!\\bwe\\s+(?:have|hold|keep|got)\\s+)(?:no|zero)\\s+(?:recorded|measured|logged|tracked|reported|registered)\\s+(?:foot\\s*traffic|traffic|activity|visits?|visitors|customers|guests|covers|demand|crowds?)\\b(?!\\s+(?:data|figures|numbers|readings|records|history|counts?)\\b)';
const NO_DATA_AS_EMPTY = new RegExp(
  `\\b${PART_OF_THE_WEEK}\\b[^.!?]{0,40}?\\b${NO_RECORDED}|\\b${NO_RECORDED}[^.!?]{0,20}?\\b(?:on|during|across|for|in)\\s+(?:the\\s+|your\\s+)?${PART_OF_THE_WEEK}\\b`,
  'i',
);

// ── Numbers ──────────────────────────────────────────────────────────────────

// Digits in any script, folded to ASCII, so a claim written in fullwidth or
// Arabic-Indic digits is read as the number it shows the owner.
function asciiDigits(text) {
  return String(text).normalize('NFKC').replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp >= 0x30 && cp <= 0x39) return ch;
    let zero = cp;
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
    return String((cp - zero) % 10);
  });
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?/g;
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gi;
const CLOCK_TIME = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])\.?\s?m\b\.?/gi;
const CLOCK_24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
// MIDNIGHT AND NOON ARE CLOCK TIMES WRITTEN AS WORDS (2026-11-03). A claim
// can carry the hour as a word, and a word this check did not read was a
// claim it never checked: "your Friday peaks at midnight" passed with nothing
// behind it. They are read as the hours they name, the way "12 AM" and
// "12 PM" are. "Midday" is a part of the day, not a time, and stays prose.
const CLOCK_WORD = /\b(midnight|noon)\b/gi;
const CLOCK_WORD_HOUR = Object.freeze({ midnight: 0, noon: 12 });
const NUMBER = /(\$\s?)?\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:(st|nd|rd|th)\b)?(\s?(?:%|percent\b|per\s+cent\b))?/gi;
// AN ORDINAL THAT NAMES A DAY OF THE MONTH IS A DATE (third round,
// 2026-11-03). Positions up to the 10th pass as rankings the owner can check
// ("your 2nd busiest night"), and that let "your busiest night was the 3rd"
// and "your peak lands on Friday the 7th" through with no date behind them.
// An ordinal is a date when nothing it could rank follows it (the clause ends,
// or "of" a month does), or when "on the" or a weekday stands right before it.
// "The 4th was huge", "the 7th this month" and "the 4th again" are days too:
// after "the", an ordinal followed by a word that cannot be what it ranks (a
// verb, "this", "again", "at") is a day, and "the 3rd week" and "our 25th
// anniversary" are positions (review, 2026-11-03).
const ORDINAL_DATE_BEFORE = /(?:\bon\s+the|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day,?(?:\s+the)?)\s+$/i;
const ORDINAL_DATE_AFTER = /^(?:\s*(?:[.,;:!?)\]]|$)|\s+of\s+(?:(?:this|the|next|last)\s+month\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b))/i;
const ORDINAL_THE = /\bthe\s+$/i;
const ORDINAL_DAY_NEXT = /^\s+(?:was|is|were|will|would|had|has|saw|got|hit|did|went|came|drew|brought|peaked|peaks|again|this|that|last|next|at|with|when|after|before|by|so|but|too|as|which|for|to|in|on|you|we|your|our|it|there|then|because|since|until|till|only|alone)\b/i;

// A NUMBER WRITTEN AS A WORD IS A NUMBER (third round, 2026-11-03). Only
// digits were read, so "Your Friday hits ninety" and "Nearly half of your
// reviews mention the wait" reached the owner with nothing behind them while
// "hits 90" lost its line. Counts from two up are read the way digits are
// ("forty-five", "a hundred and forty", "two dozen", "twice"); a lone "one"
// is not, since it is in nearly every sentence and as a count it is never
// checked anyway. A share ("half", "a third", "two thirds", "a quarter") is
// read as a percentage when what follows says what it is a share of ("half
// your seats", "a third of your covers", "half full"), never in "half an
// hour", "half price", "cut it in half" or "a third bartender". A share is a
// rounding by nature, so it matches the venue's own percentage within 5
// points (supportFor), and only a percentage: a 45 on the index is no "half".
const WORD_VALUE = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, a: 1, an: 1,
});
const UNIT_WORDS = 'one|two|three|four|five|six|seven|eight|nine';
const UNDER_100 = `(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-]+(?:${UNIT_WORDS}))?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|${UNIT_WORDS})`;
const NUMBER_WORDS = new RegExp(`\\b(?:(?:a|${UNDER_100})\\s+(?:hundred|thousand)(?:\\s+(?:and\\s+)?${UNDER_100})?|(?:a|${UNDER_100})\\s+dozen|${UNDER_100}|twice)\\b`, 'gi');
const VAGUE_SPAN_AFTER = new RegExp(`^\\s+or\\s+${UNDER_100}\\b`, 'i');
function wordsValue(phrase) {
  const words = phrase.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== 'and');
  if (words[0] === 'twice') return 2;
  let total = 0;
  let part = 0;
  for (const w of words) {
    if (w === 'dozen') part = (part || 1) * 12;
    else if (w === 'hundred') part = (part || 1) * 100;
    else if (w === 'thousand') { total += (part || 1) * 1000; part = 0; } else part += WORD_VALUE[w] || 0;
  }
  return total + part;
}
const FRACTION_OF = Object.freeze({
  half: 1 / 2, halves: 1 / 2, third: 1 / 3, thirds: 1 / 3, quarter: 1 / 4, quarters: 1 / 4, fifth: 1 / 5, fifths: 1 / 5,
  sixth: 1 / 6, sixths: 1 / 6, eighth: 1 / 8, eighths: 1 / 8, tenth: 1 / 10, tenths: 1 / 10,
});
const FRACTION_WORDS = new RegExp(`\\b(?:(a|an|${UNIT_WORDS})[\\s-]+(halves|half|thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)|(half))\\b(?=[\\s-]+(?:full|empty|booked|sold)\\b|\\s+(?:of|your|our|my|their|the|its|them|those|these|that|this|all|every|capacity)\\b)`, 'gi');

// AM AND PM ARE TWO DIFFERENT HOURS (2026-11-03, third round). A clock time
// used to carry its 12-hour reading beside its 24-hour one, and so did every
// hour fact, so a 9 PM peak vouched for "your Friday peaks at 9 AM", "21:00"
// for a 9 AM fact, a midnight fact for "12 PM" and the owner's "we close at
// 2am" for "your Friday peaks at 2 PM". A time that says which half of the day
// it is in ("9 PM", "21:30", "09:30", "12:00", "midnight") is now only that
// hour. Only a time from 1:00 to 11:59 written without one ("9:30") is either
// half, and it carries the other half as its second reading, matched but
// never worked with.
/** The other half of the day for an hour from 1 to 11 written without AM or PM: 9 is also 21. */
function otherHalf(hour) {
  return hour + 12;
}

/**
 * Every number written in a piece of text, with where it sits. Clock times
 * come out as hours of the day (9:30 PM is 21.5). A time written without AM or
 * PM ("9:30") also carries the other half of the day as `alt` (21.5).
 */
function numbersIn(text) {
  const src = asciiDigits(text);
  const out = [];
  const taken = new Array(src.length).fill(false);
  const mark = (i, n) => { for (let k = i; k < i + n; k++) taken[k] = true; };

  let m;
  // Dates first: a calendar day is a number a claim can name ("your peak lands
  // on Oct 25") and never an operand of arithmetic, so it is tagged as one.
  // A DAY IS MATCHED AS A DAY (review, 2026-11-03). Its year and month rode
  // along as second readings, so any fact measured in November vouched for
  // "your busiest night was the 11th" and "Nov 11", and any fact of 2026 for
  // "Oct 4, 2026". A date's value is its day of the month, and nothing else.
  ISO_DATE.lastIndex = 0;
  while ((m = ISO_DATE.exec(src)) !== null) {
    out.push({ index: m.index, length: m[0].length, value: Number(m[3]), alt: [], kind: 'date', dim: 'date' });
    mark(m.index, m[0].length);
  }
  MONTH_DAY.lastIndex = 0;
  while ((m = MONTH_DAY.exec(src)) !== null) {
    if (taken[m.index]) continue;
    out.push({ index: m.index, length: m[0].length, value: Number(m[2]), alt: [], kind: 'date', dim: 'date' });
    mark(m.index, m[0].length);
  }
  CLOCK_TIME.lastIndex = 0;
  while ((m = CLOCK_TIME.exec(src)) !== null) {
    const h12 = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const pm = m[3].toLowerCase() === 'p';
    const h24 = (h12 % 12) + (pm ? 12 : 0);
    // AM or PM says which hour it is: no second reading.
    out.push({ index: m.index, length: m[0].length, value: h24 + min / 60, alt: [], kind: 'clock', dim: 'clock' });
    mark(m.index, m[0].length);
  }
  CLOCK_24.lastIndex = 0;
  while ((m = CLOCK_24.exec(src)) !== null) {
    if (taken[m.index]) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    // "21:30", "00:30" and the database's "09:30" say which half of the day
    // they are in, and "12:00" is noon (midnight is never noon, 2026-11-03
    // review); "9:30" could be either.
    const eitherHalf = h >= 1 && h <= 11 && !/^0/.test(m[1]);
    out.push({ index: m.index, length: m[0].length, value: h + min / 60, alt: eitherHalf ? [otherHalf(h) + min / 60] : [], kind: 'clock', dim: 'clock' });
    mark(m.index, m[0].length);
  }
  CLOCK_WORD.lastIndex = 0;
  while ((m = CLOCK_WORD.exec(src)) !== null) {
    const h = CLOCK_WORD_HOUR[m[1].toLowerCase()];
    // No second reading: "12 AM" also reads as a bare 12, but midnight is
    // never noon, and an alternate 12 here let a "midnight" anywhere in the
    // owner's words or a label vouch for "your Friday peaks at 12 PM"
    // (2026-11-03 review).
    // `word`: matched as the hour it names, never an operand of arithmetic.
    // The owner's "stay open till midnight" beside a 9 PM peak made "21 hours
    // before closing" (|21 - 0|) look worked out (2026-11-03 review); "12 AM"
    // typed as digits always did that, and a word now does not.
    out.push({ index: m.index, length: m[0].length, value: h, alt: [], kind: 'clock', dim: 'clock', word: true });
    mark(m.index, m[0].length);
  }
  // Numbers written as words (third round, 2026-11-03), shares first so "two
  // thirds" is one number.
  FRACTION_WORDS.lastIndex = 0;
  while ((m = FRACTION_WORDS.exec(src)) !== null) {
    const count = m[1] ? WORD_VALUE[m[1].toLowerCase()] || 1 : 1;
    const value = count * FRACTION_OF[(m[2] || m[3]).toLowerCase()] * 100;
    out.push({ index: m.index, length: m[0].length, value, alt: [], kind: 'fraction', dim: 'pct', spelled: true });
    mark(m.index, m[0].length);
  }
  NUMBER_WORDS.lastIndex = 0;
  while ((m = NUMBER_WORDS.exec(src)) !== null) {
    if (taken[m.index]) continue;
    // "Nine PM" and "one AM" are hours, read the way "9 PM" is; "nine
    // o'clock" could be either half of the day (review, 2026-11-03: "your
    // Friday peaks at nine PM" was a plain 9 an owner's "9 tables" vouched for).
    const spokenHour = wordsValue(m[0]);
    const meridiem = /^\s*(?:([ap])\.?\s?m\b\.?|o['’]?clock\b)/i.exec(src.slice(m.index + m[0].length));
    if (meridiem && spokenHour >= 1 && spokenHour <= 12) {
      const h24 = meridiem[1] ? (spokenHour % 12) + (meridiem[1].toLowerCase() === 'p' ? 12 : 0) : spokenHour;
      const eitherHalf = !meridiem[1] && spokenHour <= 11;
      out.push({ index: m.index, length: m[0].length + meridiem[0].length, value: h24, alt: eitherHalf ? [otherHalf(spokenHour)] : [], kind: 'clock', dim: 'clock', spelled: true });
      mark(m.index, m[0].length + meridiem[0].length);
      continue;
    }
    if (/^one$/i.test(m[0])) continue;
    // "An hour or two", "two or three bartenders": a span, not a count.
    if (/\bor\s+$/i.test(src.slice(Math.max(0, m.index - 4), m.index)) || VAGUE_SPAN_AFTER.test(src.slice(m.index + m[0].length))) continue;
    const value = wordsValue(m[0]);
    if (!(value >= 2)) continue;
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 16);
    const pct = /^\s?(?:%|percent\b|per\s+cent\b)/i.exec(after);
    let dim = pct ? 'pct' : 'plain';
    if (dim === 'plain' && /^\s*(?:minutes?|mins?|hours?|hrs?)\b/i.test(after)) dim = 'duration';
    if (dim === 'plain' && /^\s*(?:dollars?|bucks)\b/i.test(after)) dim = 'money';
    const length = m[0].length + (pct ? pct[0].length : 0);
    out.push({ index: m.index, length, value, alt: [], kind: pct ? 'percent' : 'number', dim, spelled: true });
    mark(m.index, length);
  }
  NUMBER.lastIndex = 0;
  while ((m = NUMBER.exec(src)) !== null) {
    if (taken[m.index] || taken[m.index + (m[1] ? m[1].length : 0)]) continue;
    const value = Number(`${m[2].replace(/,/g, '')}${m[3] || ''}`);
    if (!Number.isFinite(value)) continue;
    const kind = m[5] ? 'percent' : m[1] ? 'money' : m[4] ? 'ordinal' : 'number';
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 16);
    const ahead = src.slice(m.index + m[0].length);
    const behind = src.slice(Math.max(0, m.index - 24), m.index);
    if (kind === 'ordinal' && value >= 1 && value <= 31
      && (ORDINAL_DATE_AFTER.test(ahead) || ORDINAL_DATE_BEFORE.test(behind) || (ORDINAL_THE.test(behind) && ORDINAL_DAY_NEXT.test(ahead)))) {
      out.push({ index: m.index, length: m[0].length, value, alt: [], kind, dim: 'date' });
      continue;
    }
    let dim = kind === 'percent' ? 'pct' : kind === 'money' ? 'money' : 'plain';
    if (dim === 'plain' && /^\s*(?:minutes?|mins?|hours?|hrs?)\b/i.test(after)) dim = 'duration';
    if (dim === 'plain' && /^\s*(?:dollars?|bucks)\b/i.test(after)) dim = 'money';
    out.push({ index: m.index, length: m[0].length, value, alt: [], kind, dim });
  }
  return out.sort((a, b) => a.index - b.index);
}

// WHO A CLAIM IS ABOUT. A number is only a claim about the venue when
// something in front of it says so: the owner ("you", "your"), Roost speaking
// for Flock ("we", "our estimate"), or a day or a stretch of the venue's own
// clock ("Friday", "yesterday", "your mornings").
const SUBJECT = /\b(you|your|yours|you['’](?:re|ve|ll)|we|our|ours|us|yesterday|today|tonight|this\s+(?:week|weekend|month|morning|afternoon|evening)|last\s+(?:night|week|weekend|month|\w+day)|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|(?:mon|tues|wednes|thurs|fri|satur|sun)day['’]s|mornings?|lunch(?:es)?|brunch(?:es)?|dinners?|evenings?|nights?|weekends?|weekdays?|the\s+(?:room|floor|kitchen|bar|patio|peak|rush|forecast|estimate|index|reading|readings|score|week|weekend|day))\b/i;
// The verb that turns a number into a reading: it sits within a few words in
// front of the number.
const CLAIM_VERB = /\b(is|are|was|were|ran|run|runs|hit|hits|had|has|have|got|gets|saw|sees|peaked|peaks|peak|averaged|averages|came|comes|sat|sits|read|reads|dropped|drops|fell|falls|rose|rises|climbed|climbs|jumped|grew|grows|slipped|slips|projects|projected|shows|showed|landed|lands|land|puts|put|served|serves|seated|turn|turned|turns|filled|fills|waited|waits|lasted|lasts|took|takes|stayed|stays|totaled|totalled|totals|reached|reaches|held|holds|scored|scores|logged|recorded|expect|expects|expected|estimate|estimates|estimated|forecasts|forecast|measured|counted|posted|did|does|made|makes|earned|earns|brought|brings|pulled|pulls|missed|lost|gained|added|cleared|clears|closes|closed|opens|opened|stops|stopped|starts|started|ends|ended|peaking|running|sitting|landing|coming|averaging|reading|holding|hitting|turning|closing|opening|starting|ending)\b|['’]s\b|:\s*$/i;
// THE SAME VERBS IN THE BASE FORM, RIGHT AFTER THE ROOM DOING THEM (third
// round, 2026-11-03). CLAIM_VERB reads "your Friday sees 300" and "you saw
// 300", and "On Fridays you see 300 people", "we pour 400 drinks" and "your
// guests spend $40 a head" passed: after "you", "we", "they" or the room's own
// plural ("your Fridays", "your regulars") the verb takes its base form.
// A closed list of what a room does, read with the doer right in front of
// the verb and at most three words between the verb and the number ("see
// about 300", "mention the wait 40 times", "stay for 90 minutes"), none of
// them opening a clause of its own ("see why 2 lanes matter"). "You keep $15
// of a $20 order", "you give up $0.88 a cover" and "you need 2 servers" are
// worked examples and advice, and their verbs are not in the list.
const BASE_VERB = /(?:see|serve|pour|sell|seat|host|draw|pull|bring|fill|do|get|average|reach|top|book|welcome|pack|handle|count|log|record|post|ring|gross|net|take|make|earn|hold|attract|run|hit|turn|peak|land|open|close|start|end|stay|sit|wait|visit|order|tip|drink|eat|rate|mention|complain|return|arrive|come|walk|leave|show|spend)/;
const DOER = /(?:(?:you|we|they)(?:['’]ll|\s+will)?|(?:mon|tues|wednes|thurs|fri|satur|sun)days|weekends|weekdays|nights|evenings|mornings|afternoons|lunches|dinners|brunches|guests|customers|regulars|diners|visitors|patrons|servers|bartenders|staff|crowds|reviews|reviewers|people)/;
const OFTEN = /(?:usually|typically|often|normally|always|still|also|only|generally|regularly|reliably|consistently|routinely|easily|already)/;
const VERB_TO_NUMBER = /(?:\s+(?!(?:and|but|or|so|then|if|when|whether|because|which|who|whom|that|while|why|how|what|where)\b)[^\s,;:.!?]+){0,3}\s*$/;
// And one day or the room itself doing it, in the third person ("your Friday
// draws 300 people", "your bar sells 400 drinks", "your door lets in 300"):
// the same list with its "-s", which CLAIM_VERB holds only some of.
const ONE_DOER = /(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:the|your|our)\s+(?:\w+\s+)?(?:room|bar|kitchen|floor|door|crowd|patio|place|venue|line|team|menu|special|night|week|weekend|brunch|lunch|dinner|service|rush|peak|day|event))/;
const BASE_VERB_S = /(?:sees|serves|pours|sells|seats|hosts|draws|pulls|brings|fills|does|gets|averages|reaches|tops|books|welcomes|packs|handles|counts|logs|records|posts|rings|grosses|nets|takes|makes|earns|holds|attracts|runs|hits|turns|peaks|lands|opens|closes|starts|ends|stays|sits|waits|visits|orders|rates|mentions|returns|arrives|comes|walks|leaves|shows|spends|lets)/;
const DOES = `(?:${DOER.source}\\s+(?:${OFTEN.source}\\s+)?${BASE_VERB.source}|${ONE_DOER.source}\\s+(?:${OFTEN.source}\\s+)?${BASE_VERB_S.source})\\b${VERB_TO_NUMBER.source}`;
const DOER_THEN_BASE = new RegExp(`\\b${DOES}`, 'i');
// A target or a condition in front of the doer is not a reading: "make sure
// you get 2 servers on", "until you fill 40 seats", "once you hit 100 covers".
const DOER_AIMED = new RegExp(`\\b(?:make\\s+sure|be\\s+sure|ensure|so\\s+that|until|till|unless|once|before|after|as\\s+soon\\s+as|by\\s+the\\s+time|in\\s+case|as\\s+long\\s+as|provided)\\s+(?:that\\s+)?${DOES}`, 'i');
// Nor is the outcome of a command: "Fill 15 early seats and you bring in
// roughly $450" is "if you fill them, you bring in", worked from a price the
// answer suggested (the 2026-11-03 prereview run). The sentence opens on the
// command and the doer comes after "and".
const COMMAND_OPENS = /^\s*(?:(?:first|then|now|so|just)\s*,?\s+)?(?:fill|add|book|run|seat|sell|get|bring|turn|push|post|offer|put|keep|move|start|try|test|price|charge|cut|raise|drop|staff|schedule|train|ask|invite|host|hold|open|close|make|give|use|pick|set|send|feature|promote|pair|bundle|batch|prep|pull|draw|serve|pour|launch|build|swap|switch|stagger|split|limit|release|track|reward|greet|clear|win|land|sign|convert|catch|capture|hook|lure|attract|welcome|pack)\b/i;
const AND_THE_DOER = new RegExp(`\\band\\s+(?:then\\s+)?${DOES}`, 'i');
// The money flows a worked example ends on are not in the list: "you keep",
// "you pay", "you save", "you lose", "you give up". "spend" is read after the
// room's own guests ("your guests spend $40"), never after "you" or "we",
// whose spending is what a worked example adds up.
const DOER_SPENDS = /\b(?:you|we)(?:['’]ll|\s+will)?\s+(?:\w+\s+)?spend\b/i;
const DOER_FLOWS = new RegExp(`\\b(?:you|we)(?:['’]ll|\\s+will)?\\s+(?:${OFTEN.source}\\s+)?(?:spend|pay|lose|keep|save|owe|give\\s+(?:up|away))\\b${VERB_TO_NUMBER.source}`, 'i');

// Words that make the number a suggestion, a hypothetical, a price or a
// general rule rather than a reading: "if you add 10 covers", "aim for 85",
// "charge $12", "your best move is", "most rooms run".
const NOT_A_READING = /\b(if|when|whenever|aim|aiming|target|targets|goal|try|trying|test|testing|consider|could|would|['’]d|might|may|can|should|imagine|say|suppose|example|instance|such\s+as|charge|charging|price|priced|pricing|add|adding|raise|raising|cut|cutting|offer|offering|need|needs|want|wants|plan|planning|budget|every|each|per|another|extra|more|fewer|less|move|bet|idea|play|fix|option|step|lever|most|many|industry|rule\s+of\s+thumb|places|restaurants|cafes|bars|venues|operators|rooms)\b/i;
// A number set against the venue's own history is a reading even with no
// verb in front of it: "Down 18% on your usual Tuesday", "12 points under
// last Friday".
const AGAINST_HISTORY = /^\s*(?:%|percent|per\s+cent|points?|covers?|people|guests?|customers?|tables?|minutes?)?\s*(?:under|over|above|below|ahead\s+of|behind|short\s+of|more\s+than|less\s+than|fewer\s+than|on|from|against|versus|vs\.?)\s+(?:\w+\s+){0,3}?(?:your\s+(?:usual|typical|normal|average|own)|yesterday|last\s+(?:night|week|weekend|month|\w+day))\b/i;
// A clause ends where a new subject could start.
const CLAUSE_BREAK = /[;()]|,\s+(?=(?:but|and|so|while|which|though|although|whereas|yet|then)\b)|\s+(?:but|whereas|while)\s+|\.\s/gi;

function clauseStart(text, index) {
  let start = 0;
  CLAUSE_BREAK.lastIndex = 0;
  let m;
  while ((m = CLAUSE_BREAK.exec(text)) !== null) {
    const after = m.index + m[0].length;
    if (after > index) break;
    start = after;
  }
  return start;
}

const LAST_WORDS = 5;

// "Expect around 45 people tonight" has no subject in front of it and is the
// plainest forecast claim there is. The owner is the subject it leaves out.
const EXPECT_LEAD = /\bexpect(?:ing)?\s+(?:about|around|roughly|up\s+to|close\s+to|near(?:ly)?|over|under|at\s+least)?\s*\$?\s*$/i;

// "Run it 6 weeks", "give the special 4 weeks", "keep them for 8 weeks": the
// verb comes BEFORE its object, so the number is how long to try something,
// which the contract invites. A reading puts its subject first: "your
// Tuesdays run 30% under". Found by a stand-in model eval (2026-10-28), where
// "build it from items you already prep and run it 6 weeks before judging"
// lost its sentence to the check.
const TRIAL_SPAN = /\b(?:run|keep|give|hold|test|try|trial)\s+(?:it|them|this|that|(?:the|your)\s+\w+)\s+(?:for\s+)?(?:about\s+|at\s+least\s+|a\s+full\s+)?$/i;

// NOT LOOSENED, ON PURPOSE (2026-10-28 night). A stand-in model eval found
// suggestions this check reads as readings: "Read your 50 latest reviews",
// "At the peak, run 2 door lanes", "a weekly reason to visit: 25 more covers
// a week". Exempting an opening verb or "more covers a week" was tried, and
// an adversarial review got made-up readings through both ("Bring in a
// second bartender because your Friday hit 92", "Your Tuesday special brought
// in 25 more covers a week"). A dropped good sentence costs one line; a
// made-up number shown as the venue's costs the owner's trust. The prompt's
// numbers rule now shows the model how to write a suggestion so it reads as
// one (advisorPrompt SHARED_NUMBERS, Six). Two of those shapes, a count of the
// newest records to read and a count of lanes to split into, were set aside
// on 2026-11-03, number by number and only in their own shape (countToDo).

// TWO COUNTS TO DO, SET ASIDE ONLY IN THEIR OWN SHAPE (2026-11-03). The live
// eval still lost two good lines to the claim rules: "Read through your 50
// most recent reviews, tally every delay complaint" ("read" is a claim verb in
// "your index read 92", and "your" a subject) and "To keep the line moving at
// peak, split your door into 2 lanes" ("peak" is a claim verb in "Fridays
// peak at 92"), which also cost the point after it its sense ("both lanes").
// Neither number says anything about the venue: one is how many of the newest
// records to go through, the other how many lanes to set up.
//
// A DROPPED LINE WAS ALSO DROPPING WHAT RODE WITH IT, so each is set aside only
// when the sentence is nothing but the instruction. A review of the first
// version (2026-11-03) showed why: with the count set aside, "We went through
// your listing, read your 50 most recent reviews, and found the wait is the
// top complaint", "Read your 50 most recent reviews: all but 1 mention the
// wait", "..., which all mention slow service" and a second sentence "40 of
// them mention the wait" all reached the owner, because a narrative, a claim
// in words, and a number that opens its own sentence are things this check
// does not read on their own. So, all of it, number by number:
//   * the line (an answer line or a point) is this one sentence;
//   * nothing before the instruction verb names who did anything (no "we",
//     "you", "your", no day, no subject at all): the verb is a command;
//   * no colon, semicolon or bracket, and no "which", "who", "where", "but",
//     "because" or "since" anywhere in it;
//   * between the verb and the count only "your", "the" or what is being split;
//     right after the count, the newest of a kind of record, or a lane, line
//     or station;
//   * what follows is only more commands ("tally every complaint, and fix the
//     top one"), or for lanes what each lane is for ("1 for list guests and 1
//     for door sales", "with IDs checked in both");
//   * no other number, except the 1s that say what each lane is for;
//   * and nothing after the count says in words what the records hold: no
//     count in words ("the forty that mention the wait"), no narrator ("the
//     wait we see"), and no share of the records saying or holding anything
//     ("most mention the wait", "the wait in nearly every one"). A share may
//     only be what a command acts on: "answer every one".
// "Your rating fell across your 50 most recent reviews", "Read through your
// 140 one-star reviews", "At peak, your door, split into 2 lanes, clears the
// line" and "At peak, split your 300 guests into 2 lanes" all still lose
// their line (advisorValveBoundary.test.js).
//
// TWO OTHERS STAY DROPPED, ON PURPOSE. "So your food cost stays around 30%"
// has the shape of "so your Friday stays at 92", which presumes a reading, and
// "shortly before dinner decisions get made, around 4 PM" the shape of "before
// your Friday rush starts, around 7 PM" and "your drinks get made in 90
// seconds", which are claims about the venue. No rule tells those apart from
// the target and the time they were meant as, so the prompt shows the model
// the shapes that read as suggestions instead (advisorPrompt, Six).
const SAMPLE_VERB = /^\s*(?:(?:first|then|now|so)\s*,?\s+)?(?:read|re-?read|go\s+through|look\s+(?:through|over)|pull(?:\s+up)?|scan|skim|tally|sort|print|export)(?:\s+(?:through|over|back\s+through))?\s+(?:(?:your|the|all|of)\s+){0,3}$/i;
const SAMPLE_NOUN = /^\s+(?:most\s+recent|latest|newest|last)\s+(?:(?:google|yelp|online|guest|customer|delivery)\s+)?(?:reviews?|comments?|ratings?|receipts?|tickets?|checks?|orders?|surveys?|complaints?|messages?|emails?|responses?)\b/i;
const SETUP_VERB = /^\s*(?:(?:first|then|so)\s*,?\s+)?(?:split|divide|break|separate)\s+(?:(?:your|the)\s+)?(?:[a-z]+\s+){0,2}into\s+$/i;
const SETUP_NOUN = /^\s+(?:(?:door|entry|bar|separate|parallel)\s+)?(?:lanes?|lines?|queues?|stations?|registers?|tills?|sections?|zones?)\b/i;
// Who did it: a subject before the verb makes it a narrative, not a command,
// and so does a verb in the past ("Pulled the listing, read your 50 ...").
const NARRATOR = /\b(?:i|we|they|he|she|it|someone|somebody|everyone|everybody|nobody|flock|roost)\b/i;
const PAST_TENSE = /\b(?:\w{2,}(?<!e)ed|fell|rose|grew|went|came|took|got|ran|saw|made|had|was|were|did|found|left|lost|spent|brought|bought|sold|paid|kept|led|said|told|knew|thought)\b/i;
// The room doing something in the past, right in front of its verb, with the
// number within three words after it: a report with or without a time word.
// A few verbs in the past that PAST_TENSE does not hold are read here only
// ("your Friday drew 300", "your kitchen sent out 200 plates").
const PAST_TOO = /\b(?:drew|sent|held|gave|won|rang|began|ate|drank|sat|stood|fed|let)\b/;
const DOER_IN_THE_PAST = new RegExp(`\\b(?:${DOER.source}|${ONE_DOER.source})\\s+(?:${OFTEN.source}\\s+)?(?:${PAST_TENSE.source}|${PAST_TOO.source})${VERB_TO_NUMBER.source}`, 'i');
// Where a narrative or a claim can start inside the sentence: a colon (or a
// letter that looks like one), a semicolon, a bracket, a second sentence, or
// a word that opens a clause of its own.
const CLAIM_OPENING = /[:;()[\]꞉ː∶։׃]|[.!?]\s+\S|\b(?:which|who|whom|whose|where|but|because|since|whereas)\b/i;
// What may follow the count: another command, or (lanes) what each lane is for.
// The bare verb only: "pinpointed" or "isolated" is a report, and fails here.
const NEXT_COMMAND = /^(?:then\s+)?(?:tally|count|list|note|mark|fix|find|flag|sort|group|pick|reply|answer|compare|check|write|track|look|read|start|address|share|train|brief|time|watch|move|staff|put|run|keep|add|use|sign|label|post|ask|call|cut|drop|change|test|try|chase|clear|log|circle|highlight|rank|tag|tackle|solve|coach|walk|work|strip|batch|prep|stock|set|open|send|hand|give|seat|greet|quote|text|fill|pinpoint|isolate|identify|single\s+out|figure\s+out)\b/i;
const LANE_DETAIL = /^(?:(?:1|one)\s+for\b|with\b)/i;
// A claim in words after the count, where no figure is read (second round's
// review, 2026-11-03): "and find the forty that mention the wait", "and find
// the wait we see in nearly every one", "then pinpoint why most mention the
// wait", "and find the wait in every one" all passed as commands.
const COUNT_IN_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|dozens?|half|halves|thirds?|quarters?|twice|thrice|doubles|doubled|doubling|triples|tripled|tripling)\b/i;
const NARRATOR_AFTER = /\b(?:we|i|our|ours|us|flock|roost)\b/i;
const SHARE_SAYS = /\b(?:every|each|all|most|many|few|several|none|both|majority|minority)\s+(?:(?!(?:that|which|who)\b)[a-z'-]+\s+){0,2}(?:mention|mentions|name|names|say|says|praise|praises|complain|complains|cite|cites|rate|rates|flag|flags|call|calls|bring|brings|point|points|love|loves|hate|hates|want|wants|ask|asks|give|gives|show|shows)\b|\bthey\s+all\b|\ball\s+but\b|\bone\s+(?:in|out\s+of)\b/i;
const RECORDS_SHARE = /\b(?:(?:nearly|almost)\s+)?(?:(?:every|each|all|most|many|few|several|none|both|any)\s+(?:single\s+)?ones?|(?:every|each|all|most|many|few|several|none|both|any|some)\s+of\s+(?:them|those|these)|(?:no|not)\s+(?:single\s+)?one)\b/i;
// A share of the records may be what the command acts on ("answer every
// one", "reply to each one"), and nothing else in its segment.
function shareOfRecords(segment) {
  const body = segment.replace(NEXT_COMMAND, '').replace(/^\s*(?:to|on|with|through|over)\b/i, '').trim();
  const lead = RECORDS_SHARE.exec(body);
  return RECORDS_SHARE.test(lead && lead.index === 0 ? body.slice(lead[0].length) : body);
}
// A CLAIM RIDING ON THE COUNT MAKES THE COUNT A READING, WHATEVER THE VERB
// (third round, 2026-11-03). "Read your 50 most recent reviews, which all
// mention slow service" lost its line only because "read" is a claim verb and
// "your" a subject: "Go through", "Scan", "Pull" or "Skim" in its place, or
// "the 50" for "your 50", and the line reached the owner, a made-up fact about
// the venue's reviews attached to a count to do. When the records' count is
// followed by a share of them saying something, a narrator, a ", which" clause
// on the records, a count of them saying something, or the records holding a
// thing, the count is read as the venue's, and nothing supports it. An
// instruction that only cannot be set aside ("note exactly which part of the
// meal guests called slow", a colon list of places to look) keeps the rules
// it had.
// The verb agrees with what says it, which keeps the nouns out: "every one
// mentions" and "all mention" are claims, "log every recurring mention" and
// "note every mention of wait times" are instructions (the 2026-11-03 live and
// polish runs), and so is "fix anything with 2 mentions". A form in the past
// after a share is read only where it cannot be a description: "every one
// mentioned", "all of them said", "the 40 that mentioned"; "note every
// bottleneck mentioned more than 2 times" and "tally every delay mentioned"
// are instructions (the run3 and second polish runs).
const SAYS_ONE = '(?:mentions|names|says|praises|complains|cites|rates|flags|calls|brings|points|loves|hates|wants|asks|gives|shows)';
const SAY_MANY = '(?:mention|name|say|praise|complain|cite|rate|flag|call|bring|point|love|hate|want|ask|give|show)';
const SAID = '(?:mentioned|named|said|praised|complained|cited|rated|flagged|called)';
const SHARE_CLAIMS = new RegExp(`\\b(?:(?:every|each)\\s+(?:(?!(?:that|which|who)\\b)[a-z'-]+\\s+){0,2}${SAYS_ONE}|(?:every|each)\\s+(?:single\\s+)?one\\s+${SAID}|(?:all|most|many|few|several|none|both|majority|minority)\\s+(?:(?!(?:that|which|who)\\b)[a-z'-]+\\s+){0,2}${SAY_MANY}|(?:every|each|all|most|many|few|several|none|both|some|any)\\s+(?:(?:single\\s+)?one\\s+)?of\\s+(?:them|those|these)\\s+(?:${SAYS_ONE}|${SAY_MANY}|${SAID}))\\b|\\bthey\\s+all\\b|\\ball\\s+but\\b|\\bone\\s+(?:in|out\\s+of)\\b`, 'i');
const COUNT_SAYS = new RegExp(`\\b(?:\\d+|${COUNT_IN_WORDS.source.replace(/^\\b|\\b$/g, '')})\\s+(?:of\\s+(?:them|those|these)\\s+)?(?:(?:that|which|who)\\s+(?:${SAY_MANY}|${SAID})|(?:[a-z'-]+\\s+)?${SAY_MANY})\\b`, 'i');
function claimRides(riding) {
  if (SHARE_CLAIMS.test(riding) || NARRATOR_AFTER.test(riding) || COUNT_SAYS.test(riding)) return true;
  if (/^\s*,?\s*(?:which|who)\b/i.test(riding)) return true;
  return riding.replace(/[.!?]+\s*$/, '').split(/\s*[,;:]\s*|\s+(?:and|then)\s+/i)
    .map((s) => s.replace(/^(?:and|then)\s+/i, '').trim())
    .filter(Boolean)
    .some(shareOfRecords);
}

// 'todo' when the count is set aside, 'claim' when it is read as the venue's,
// and null when the rules below decide.
function countToDo(text, num, prefix, all, alone) {
  if (num.dim !== 'plain') return null;
  const after = text.slice(num.index + num.length);
  const stretchAt = prefix.lastIndexOf(',') + 1;
  const stretch = prefix.slice(stretchAt);
  const sample = SAMPLE_VERB.test(stretch) && SAMPLE_NOUN.exec(after);
  const setup = !sample && SETUP_VERB.test(stretch) && SETUP_NOUN.exec(after);
  const noun = sample || setup;
  if (!noun) return null;
  if (claimRides(after.slice(noun[0].length))) return 'claim';
  if (!alone) return null;
  if (CLAIM_OPENING.test(text.replace(/[.!?]+\s*$/, ''))) return null;
  // Nothing before the command says who did anything.
  const head = text.slice(0, num.index - prefix.length + stretchAt);
  if (SUBJECT.test(head) || NARRATOR.test(head) || PAST_TENSE.test(head)) return null;
  // No other figure rides with it; lanes may say "1 for" each kind of guest.
  if (all.some((n) => n !== num && !(setup && n.dim === 'plain' && (n.value === 0 || n.value === 1)))) return null;
  // And what follows is only more commands, or what each lane is for. A
  // command word in the past is a report ("staff complaints doubled").
  const rest = after.slice(noun[0].length).replace(/[.!?]+\s*$/, '').trim();
  if (!rest) return 'todo';
  if (!/^,/.test(rest) && !/^(?:and|then)\b/i.test(rest)) return null;
  if (COUNT_IN_WORDS.test(rest) || NARRATOR_AFTER.test(rest) || SHARE_SAYS.test(rest)) return null;
  return rest.split(/\s*,\s*|\s+(?:and|then)\s+/i)
    .map((s) => s.replace(/^(?:and|then)\s+/i, '').trim())
    .filter(Boolean)
    .every((s) => ((NEXT_COMMAND.test(s) && !PAST_TENSE.test(s)) || (setup && LANE_DETAIL.test(s))) && !shareOfRecords(s)) ? 'todo' : null;
}

// A NUMBER THAT OPENS ITS CLAUSE AS THE SUBJECT OF A CLAIM IS A READING
// (2026-11-03 review). The rules below look for a subject and a verb in front
// of a number, so "40 of them mention the wait", "140 covers came in last
// Friday" and "On Friday, 140 covers came in" were never read at all, and a
// line set aside as a count to do could carry one in its next sentence. Read
// as a claim when nothing but "and", "so" or "then" stands before the number
// in its clause and what follows says it is a share of a group ("of them",
// "of your") or what that many people did, or what reviews say. A target, a
// hypothetical or a worked example after it ("should", "would", "is the
// goal", "a sensible ceiling", "is $1,000") keeps it a suggestion, unless the
// clause puts it in the past ("140 covers came in last Friday, which is
// $5,320" is still a reading).
// A rounding word may stand in front of it (third round, 2026-11-03):
// "Nearly half of your reviews mention the wait" and "Nearly 40 of your
// reviews mention the wait" were never read.
// And a time or "another" may too (review of the round): "Last month 50% of
// your guests came back", "In October 300 people came through your door",
// "Another 40 guests came in last Friday".
const NUMBER_FIRST_LEAD = /^\s*(?:(?:and|so|then|also|plus)\s+)?(?:(?:(?:last|this|next)\s+(?:night|week|weekend|month|year|(?:mon|tues|wednes|thurs|fri|satur|sun)day)|yesterday|today|tonight|in\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|on\s+(?:mon|tues|wednes|thurs|fri|satur|sun)days?|another)\s+)?(?:(?:nearly|almost|about|around|roughly|over|under|just\s+over|just\s+under|well\s+over|well\s+under|more\s+than|less\s+than|fewer\s+than|close\s+to|at\s+least|up\s+to|only|barely|exactly|some)\s+)?$/i;
// A share in words says what it is a share of with no "of": "half your
// guests", "half the room".
const SHARE_OF_THE_VENUE = /^\s+(?:of\s+)?(?:your|our|their|them|those|these|the\s+(?:room|floor|tables?|seats?|bar|crowd|covers?|guests?|customers?|reviews?|line|door|place|venue|kitchen|staff|regulars?|nights?|week|menu|sales|orders?|bookings?|reservations?))\b/i;
// And a share, or a number after a rounding word, is a claim only with a verb
// after it before the clause ends: "half your covers are walk-ins" says
// something, "Charge $18 to $21, about half your typical spend, to fill
// lunch seats" describes the price (five recorded runs wrote it). Only forms
// that are never the noun they describe: "your typical spend", "your drink
// orders" and "two turns" name things.
const FIRST_CLAIM_VERB = /\b(?:is|are|was|were|has|have|had|come|comes|came|arrive|arrives|arrived|ordered|leave|left|wait|waited|stay|stayed|sit|sits|sat|spent|booked|visited|mention|mentioned|named|say|says|said|complain|complains|complained|cite|cites|cited|praise|praises|praised|rated|walked|showed|paid|tipped|returned|go|goes|went|turned|filled|asked|gave|wanted|brought|skipped|cancell?ed|drank|ate|bought|joined|landed|ran|ended|happen|happens|happened)\b|\b(?:guests|customers|diners|patrons|regulars|visitors|people|reviewers|reviews|covers|tables|seats|bookings|parties|groups)\s+(?:\w+\s+)?(?:order|book|visit|spend|walk|show|pay|tip|rate|return|turn|ask|give|want|bring|skip|cancel|drink|eat|buy|join)\b/i;
const NUMBER_FIRST_CLAIM = /^\s*(?:%|percent|per\s+cent)?\s*(?:of\s+(?:them|those|these|your|our)\b|(?:out\s+of|in)\s+(?:\d+|ten|twenty|five|four|three|two|hundred|a\s+hundred)\s+(?:of\s+)?(?:your|our|them|those|these|the)\b|(?:[a-z'-]+\s+){0,3}(?:mentioned|came|walked|left|waited|ordered|booked|visited|complained|said|named|showed|stayed|spent|paid|returned|went|rated|gave|praised|asked|cancell?ed|arrived|turned|sat|ate|drank|bought|tipped|joined|mention|mentions|names|says|complain|complains|praise|praises|cites)\b)/i;
const NUMBER_FIRST_SUGGESTION = /\b(?:should|would|could|can|might|may|aim|aims|target|goal|ceiling|cap|limit|plenty|enough|sensible|healthy|ideal|needs?\s+to|to\s+be|if|when|equals|adds?\s+up\s+to|comes?\s+to)\b|\bis\s+(?:about\s+|roughly\s+|around\s+)?\$|=/i;
function numberFirstClaim(text, num, prefix) {
  const stretch = prefix.slice(prefix.lastIndexOf(',') + 1);
  if (!NUMBER_FIRST_LEAD.test(stretch)) return false;
  const after = text.slice(num.index + num.length).split(/[.!?;]/)[0];
  if (!NUMBER_FIRST_CLAIM.test(after) && !(num.kind === 'fraction' && SHARE_OF_THE_VENUE.test(after))) return false;
  // A share or a rounded number says something only with a verb of its own.
  const rounded = num.kind === 'fraction' || /\S/.test(stretch.replace(/^\s*(?:(?:and|so|then|also|plus)\s+)?/i, ''));
  if (rounded && !FIRST_CLAIM_VERB.test(after.split(',')[0])) return false;
  return PAST_TIME.test(after) || !NUMBER_FIRST_SUGGESTION.test(after);
}

// A SUGGESTION WORD EARLIER IN THE CLAUSE DOES NOT MAKE A PAST READING A
// SUGGESTION (adversarial review, 2026-10-28 night): "When your Friday hit 92
// last week", "Each Saturday last month you ran 140 covers", "You had a
// 140-cover Saturday last week" all passed, because "when", "each" and "a"
// exempt a number wherever they sit in front of it. A word placing the clause
// in the past, with a subject and a claim verb right in front of the number,
// makes it a reading again, ahead of every exemption below.
const PAST_TIME = /\b(?:last\s+(?:night|week|weekend|month|year|time|\w+day)|yesterday|ago|so\s+far|earlier\s+this\s+(?:week|month))\b/i;
// A VERB IN THE PAST THAT THE LIST DOES NOT HOLD IS STILL A REPORT (third
// round, 2026-11-03). "Your guests complained 40 times last month" and
// "Guests left 40 complaints last month" passed: "complained" and "left" are
// not claim verbs, and "guests" is not the venue. In a clause placed in the
// past, any verb in the past after the venue or its people makes the number a
// reading.
const PEOPLE = /\b(?:guests|customers|diners|patrons|regulars|visitors|people|reviewers|reviews|staff|servers|bartenders|crowds?|walk-?ins|bookings|reservations|parties|groups)\b/i;
function pastReading(prefix, after) {
  if (!PAST_TIME.test(prefix) && !PAST_TIME.test(after.split(/[.!?;]/)[0])) return false;
  const tail = prefix.trim().split(/\s+/).slice(-LAST_WORDS).join(' ');
  if (SUBJECT.test(tail) && CLAIM_VERB.test(tail)) return true;
  return (SUBJECT.test(tail) || PEOPLE.test(tail)) && PAST_TENSE.test(tail);
}

// A STANDING CLAIM ABOUT A DAY IS A READING TOO (second round's review,
// 2026-11-03). "Every", "each", "most" and "many" mark a rate or a rule of
// thumb below ("every 10 more covers", "most rooms run"), so in front of a day
// they let "Every Friday your room hits 92", "Each Saturday you run 140
// covers" and "Most Fridays your room hits 92" through, in the advice and the
// grounded answers alike. One of them on a day or a stretch of the week, with
// the venue (or the day itself) doing a claim verb right in front of the
// number, makes it a reading, unless the clause asks or supposes, or the
// number names a kind of thing ("a 6 week test").
const HABITUAL = /\b(?:every|each|most|many)\s+(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|days?|nights?|evenings?|mornings?|afternoons?|weekends?|weekdays?|weeks?|months?|shifts?|services?|lunch(?:es)?|brunch(?:es)?|dinners?)\b/i;
const VENUE_DOES = /\b(?:you|your|you['’](?:re|ve)|we|our|the\s+(?:room|floor|kitchen|bar|patio|door|line|crowd|rush|peak|place|venue))\b/i;
const DAY_DOES = /\b(?:hits|runs|peaks|sees|gets|lands|tops|reaches|fills|averages|comes|sits|holds|draws|brings|pulls|ran|peaked|saw|got|landed|topped|reached|filled|averaged|came|sat|held|drew|brought|pulled)\b/i;
const SUPPOSES = /\b(?:if|when|whenever|aim|aiming|target|goal|try|trying|test|testing|consider|could|would|['’]d|might|may|can|should|imagine|suppose|need|needs|want|wants|plan|planning|budget)\b/i;
function standingReading(prefix, num, all) {
  if (!HABITUAL.test(prefix) || SUPPOSES.test(prefix)) return false;
  if (TRIAL_SPAN.test(prefix) || /\b(?:a|an)\s*\$?\s*$/i.test(prefix)) return false;
  const tail = prefix.trim().split(/\s+/).slice(-LAST_WORDS).join(' ');
  if (CLAIM_VERB.test(tail) && (VENUE_DOES.test(tail) || DAY_DOES.test(tail))) return true;
  // And with the doer and its verb in the base form or the past, or money
  // flowing with no working shown (review of the third round, 2026-11-03):
  // "Every Friday you see 300 people", "Most Fridays you pour 400 drinks",
  // "Every week you lose $500 to no-shows".
  return (DOER_THEN_BASE.test(prefix) && !DOER_AIMED.test(prefix)) || DOER_IN_THE_PAST.test(prefix)
    || flowsUnworked(prefix, num, all);
}

// Money flowing with no other figure in its sentence to work it from.
function flowsUnworked(prefix, num, all) {
  return DOER_FLOWS.test(prefix) && !all.some((n) => n !== num && !n.spelled && n.dim !== 'date');
}

// A SHARE IN A GERUND'S SCENARIO IS A SUPPOSITION (2026-11-03, the round's
// final live run). "At $24 a head, running your 120-capacity room half-empty
// costs you about $1,440" and "running your 28 seats half empty across a
// morning costs around $150 to $200" price an occupancy the sentence
// supposes; "running" is a claim verb ("your Friday is running 20% under"),
// so once words were read the share lost both lines, one of them a money
// question's only figure. A share written in words, inside "running",
// "leaving", "keeping" or "having" the room or its seats empty or full, and
// followed straight away by what that costs, is set aside. "Your room runs
// half empty on Tuesdays" and "Your room sits half empty, which costs you
// $1,440" stay readings, and so does "50% empty" in digits, as it always was.
const SCENARIO_BEFORE = /(?:^|[,;:]\s*|^\s*(?:at\s+[^,]{1,60},\s*))(?:running|leaving|keeping|having|operating)\s+(?:your|the)\s+(?:[\w-]+\s+){0,3}?(?:room|rooms|seats|tables|floor|bar|place|venue|space|house|capacity)\s+$/i;
const SCENARIO_AFTER = /^[\s-]+(?:empty|full)\b(?:\s+(?:across|over|for|through|during|on|every|each)\s+(?:(?:a|an|the|one|your|each|every)\s+)?[\w-]+){0,2},?\s+(?:costs?|means?|leaves?|loses?|burns?|wastes?)\b/i;
function shareScenario(text, num, prefix) {
  return num.kind === 'fraction' && SCENARIO_BEFORE.test(prefix) && SCENARIO_AFTER.test(text.slice(num.index + num.length));
}

// `alone`: the sentence is the whole answer line or point it sits in, the
// one place a count to do may be set aside (countToDo).
function isReadingSlot(text, num, all = numbersIn(text), alone = false) {
  const prefix = text.slice(clauseStart(text, num.index), num.index);
  if (EXPECT_LEAD.test(prefix)) return true;
  if (pastReading(prefix, text.slice(num.index + num.length))) return true;
  if (numberFirstClaim(text, num, prefix)) return true;
  const toDo = countToDo(text, num, prefix, all, alone);
  if (toDo === 'claim') return true;
  if (toDo === 'todo') return false;
  if (shareScenario(text, num, prefix)) return false;
  if (standingReading(prefix, num, all)) return true;
  // "Most" marks a rule of thumb ("most rooms run"), never "most recent": with
  // the 50 above set aside, "Read your 50 most recent reviews: 40 mention the
  // wait" would have let the 40 through on it (2026-11-03 self-review).
  if (NOT_A_READING.test(prefix.replace(/\bmost\s+recent\b/gi, ' '))) return false;
  if (TRIAL_SPAN.test(prefix)) return false;
  // "a $12 special", "an 85 seat room": the article makes it a kind of
  // thing, not a reading of one.
  if (/\b(?:a|an)\s*\$?\s*$/i.test(prefix)) return false;
  if (AGAINST_HISTORY.test(text.slice(num.index + num.length))) return true;
  if (!SUBJECT.test(prefix)) return false;
  const tail = prefix.trim().split(/\s+/).slice(-LAST_WORDS).join(' ');
  if (CLAIM_VERB.test(tail)) return true;
  // The doer and its verb in the past ("your guests complained 40 times",
  // "you comped 25 drinks") or in the base form (third round, 2026-11-03).
  if (DOER_IN_THE_PAST.test(prefix)) return true;
  // A command's outcome is set aside only as money worked from a price the
  // answer gave ("Fill 15 early seats and you bring in roughly $450"); "Keep
  // doing what works and you see 300 people on Fridays" says what the room
  // does now (review of the third round, 2026-11-03).
  if (DOER_THEN_BASE.test(prefix) && !DOER_AIMED.test(prefix) && !DOER_SPENDS.test(tail)
    && !(num.dim === 'money' && COMMAND_OPENS.test(text) && AND_THE_DOER.test(prefix))) return true;
  // MONEY THAT FLOWS WITH NO WORKING SHOWN IS A READING. The flows a worked
  // example ends on ("you keep $15 of a $20 order", "you spend $250 for 50
  // flyers") stay set aside, and "You spend $2,000 a week on labor", "You
  // lose $500 every Tuesday" and "You pay $3,000 a month in rent", with no
  // other figure in the sentence, state the venue's own costs (same review).
  return flowsUnworked(prefix, num, all);
}

// ── What the venue's numbers support ────────────────────────────────────────

// `share`: a share the owner wrote in words, which only a share may match.
function addValue(list, value, ids, { owner = false, arith = true, dim = 'plain', share = false } = {}) {
  if (!Number.isFinite(value)) return;
  list.push({ value, ids, owner, arith, dim, ...(share ? { share: true } : {}) });
}

// What kind of quantity a fact's own value is, from its unit. Arithmetic is
// only done between kinds that can meet: a gap between two clock times, a
// share of two counts, dollars times covers. Never dollars against an hour.
const DIM_OF_UNIT = Object.freeze({
  hour: 'clock',
  usd: 'money',
  minutes: 'duration',
  percent: 'pct',
  km: 'distance',
  tempF: 'temp',
  date: 'date',
});
function dimOfFact(f) {
  return DIM_OF_UNIT[f && f.unit] || 'plain';
}

/**
 * Every number this answer may state about the venue: each fact's value in
 * every form it can be written (a 21 is also 9 PM), the numbers inside the
 * server's own sentences about it, the numbers the owner typed, and simple
 * arithmetic between any two of them.
 *
 * @param {object} p
 * @param {Array} p.facts      the facts the model was shown, with ids
 * @param {Array} [p.extraFacts] facts it was not shown but that the server
 *                               computed for this answer (labels, notes)
 * @param {function} [p.format] formatFactValue, for the rendered form
 * @param {string[]} [p.texts]  the owner's own words: their question and
 *                               their settings text
 */
function buildSupport({ facts = [], extraFacts = [], format = null, texts = [] } = {}) {
  const base = [];
  const counts = new Map();
  for (const f of [...facts, ...extraFacts]) {
    if (!f) continue;
    const ids = new Set([String(f.id)]);
    const v = f.value;
    const dim = dimOfFact(f);
    // An hour fact is the hour it holds, in one half of the day. Its 12-hour
    // reading ("9" for 21) used to be offered beside it, and it vouched for
    // "9 AM" (third round, 2026-11-03); a claim written without AM or PM
    // ("9:00") still finds it through the claim's own second reading.
    if (typeof v === 'number') {
      addValue(base, v, ids, { dim });
      if (Math.abs(v) <= 1 && v !== 0) addValue(base, v * 100, ids, { dim: 'pct' });
    } else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
      addValue(base, Number(v), ids, { dim });
    } else if (Array.isArray(v)) {
      addValue(base, v.length, ids);
    }
    const written = [];
    if (typeof v === 'string' || typeof v === 'number') written.push(String(v));
    if (format) {
      try { written.push(String(format(f))); } catch { /* a value with no rendering */ }
    }
    for (const s of [f.label, f.note]) if (typeof s === 'string') written.push(s);
    for (const s of written) {
      for (const n of numbersIn(s)) {
        // Server-written words are prose, never a figure ("fewer than half of
        // the weeks", "two different kinds of number"): a label's "half" read
        // as 50% vouched for "you had 50 covers" (review, 2026-11-03).
        if (n.spelled) continue;
        const opts = { arith: n.dim !== 'date' && !n.word, dim: n.dim === 'plain' ? dim : n.dim };
        addValue(base, n.value, ids, opts);
        for (const a of n.alt) addValue(base, a, ids, { ...opts, arith: false });
      }
    }
    // When a fact was measured is a date the answer may name, never a number
    // to do sums with: "21 + 19" from a peak hour and an asOf day is a 40%
    // nobody measured.
    if (typeof f.asOf === 'string') {
      for (const n of numbersIn(f.asOf)) {
        addValue(base, n.value, ids, { arith: false, dim: 'date' });
        for (const a of n.alt) addValue(base, a, ids, { arith: false, dim: 'date' });
      }
    }
    const key = String(f.source || '');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // "You have three events listed nearby" counts facts the block carries.
  for (const n of counts.values()) addValue(base, n, new Set(), { arith: false });
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const n of numbersIn(t)) {
      // The owner's own words: a share they wrote ("half my reviews") vouches
      // for the same share and nothing else; a count in words ("forty seats",
      // "two bartenders") vouches for nothing, the way it did before words
      // were read (review, 2026-11-03).
      if (n.spelled) {
        if (n.kind === 'fraction') addValue(base, n.value, new Set(), { owner: true, arith: false, dim: 'pct', share: true });
        continue;
      }
      const opts = { owner: true, arith: n.dim !== 'date' && !n.word, dim: n.dim };
      addValue(base, n.value, new Set(), opts);
      for (const a of n.alt) addValue(base, a, new Set(), { ...opts, arith: false });
    }
  }
  // The owner's numbers once each. A repeat carries nothing a first one does
  // not (they have no fact ids), and the arithmetic below pairs every number
  // with every other, so a question and notes full of repeated small numbers
  // cost the search its square (review, 2026-11-03).
  const ownerSeen = new Set();
  return {
    base: base.filter((e) => {
      if (!e.owner) return true;
      const key = `${e.value}|${e.dim}|${e.arith}|${Boolean(e.share)}`;
      if (ownerSeen.has(key)) return false;
      ownerSeen.add(key);
      return true;
    }),
  };
}

// THE SAME NUMBER, written the way a person writes it. Exact to the unit, a
// decimal rounded either way, and a total rounded to a round figure ("about
// $1,400" for 1,388). Anything looser and every number is somebody's rounding
// of something.
function close(n, v) {
  if (Math.abs(n - v) <= 0.5) return true;
  if (Math.abs(n) >= 100 && n % 10 === 0 && Math.abs(n - v) <= Math.abs(v) * 0.05) return true;
  return false;
}

// The arithmetic a sentence is allowed to have done, and only between kinds
// of quantity that can meet: the gap between two clock times or two readings,
// a percentage change or a share of two like numbers, a sum of like numbers,
// dollars times a count, and a percentage of a figure. Each result says what
// kind it is, so a "40%" can only come out of a percentage and a "$350" only
// out of money.
const SAME_KIND = new Set(['plain', 'duration', 'money', 'pct', 'distance', 'temp']);
function derived(a, b) {
  const out = [];
  const A = a.value;
  const B = b.value;
  if (a.dim === 'clock' || b.dim === 'clock') {
    if (a.dim === 'clock' && b.dim === 'clock') out.push({ value: Math.abs(A - B), dim: 'duration' });
    return out;
  }
  if (a.dim === b.dim && SAME_KIND.has(a.dim)) {
    out.push({ value: A + B, dim: a.dim }, { value: Math.abs(A - B), dim: a.dim });
    if (B !== 0 && a.dim !== 'pct') {
      out.push({ value: (A / B) * 100, dim: 'pct' }, { value: Math.abs((A - B) / B) * 100, dim: 'pct' });
    }
    if (a.dim === 'plain') out.push({ value: A * B, dim: 'plain' });
  }
  if (b.dim === 'plain' && ['money', 'duration', 'plain'].includes(a.dim)) {
    out.push({ value: A * B, dim: a.dim });
  }
  if (b.dim === 'pct' && ['money', 'plain', 'duration'].includes(a.dim)) {
    out.push({ value: (A * B) / 100, dim: a.dim });
  }
  return out;
}

// Which of the venue's numbers a claim may simply BE. A clock time is only
// ever a clock time from the facts, and a day of the month only a date: "your
// kitchen closes at 7 PM" is not vouched for by a fact measured on the 19th.
const DIRECT = Object.freeze({
  clock: ['clock'],
  date: ['date'],
  plain: ['plain', 'duration', 'pct'],
  duration: ['plain', 'duration'],
  pct: ['pct', 'plain'],
  money: ['money', 'plain'],
});
function directKinds(claimDim, factDim) {
  return (DIRECT[claimDim] || ['plain']).includes(factDim || 'plain');
}

// Which kinds of result a claimed number can be. A bare number can be a count
// or a duration ("58" minutes is written as a number); the others are what
// they say they are.
function acceptsDim(num, dim) {
  if (num.dim === 'plain') return dim === 'plain' || dim === 'duration';
  return num.dim === dim;
}

// A share in words ("half", "a third") is a rounding of a percentage: it
// matches one within 5 points, and only a percentage (numbersIn).
function nearFor(num) {
  return num.kind === 'fraction' ? (a, b) => Math.abs(a - b) <= 5 : close;
}

/** The ids of a fact or owner number this number simply is, or null. No arithmetic. */
function supportedDirectly(num, support) {
  const targets = [num.value, ...(num.alt || [])];
  const share = num.kind === 'fraction';
  const near = nearFor(num);
  // A percentage may also be a share the facts hold as a fraction (0.42 is
  // 42%), matched at the fraction's own scale: "82%" is not "about 1".
  const ratio = num.dim === 'pct' ? num.value / 100 : null;
  for (const entry of support.base) {
    if (!directKinds(num.dim, entry.dim) || (share && entry.dim !== 'pct') || (entry.share && !share)) continue;
    if (targets.some((t) => near(t, entry.value))) return entry.ids;
    if (ratio !== null && entry.value > 0 && entry.value <= 1 && Math.abs(ratio - entry.value) <= (share ? 0.05 : 0.005)) return entry.ids;
  }
  return null;
}

/**
 * Which fact ids a number came from, or null when nothing supports it.
 *
 * ARITHMETIC IS ONLY ALLOWED ON NUMBERS THE ANSWER SHOWS. Closed over every
 * pair of facts in a block, a handful of values covers almost every integer
 * under a hundred as somebody's sum or gap, and the check would pass anything.
 * So a worked-out figure has to come from the facts this answer actually
 * cites (`inPlay.ids`), the owner's own numbers, or the other numbers the
 * answer wrote (`inPlay.literals`, "10 more covers at your $35 is $350"), and
 * at least one side of it has to be a fact or the owner's: two numbers the
 * model wrote cannot vouch for a third.
 */
function supportFor(num, support, inPlay = {}) {
  const ids = inPlay.ids instanceof Set ? inPlay.ids : new Set();
  const literals = Array.isArray(inPlay.literals) ? inPlay.literals : [];
  const targets = [num.value, ...(num.alt || [])];
  // Nought and one are never a fabricated count of any consequence, and
  // positions ("your 2nd busiest day") are rankings the owner can check.
  // A CLOCK TIME OR A DATE IS NOT A COUNT (2026-11-03): "12 AM" is hour 0,
  // "1 AM" is hour 1 and "Nov 1" is day 1, and all three were waved through
  // here, so "your Friday peaks at 1 AM" passed with nothing behind it. Those
  // are claims about the venue's clock and calendar and are checked like any
  // other.
  if (num.dim !== 'clock' && num.dim !== 'date' && targets.some((t) => t === 0 || t === 1)) return new Set();
  // A position, never a day of the month (numbersIn reads those as dates).
  if (num.kind === 'ordinal' && num.dim !== 'date' && num.value <= 10) return new Set();

  const direct = supportedDirectly(num, support);
  if (direct) return direct;
  const near = nearFor(num);
  const anchored = support.base.filter((e) => e.arith !== false && (e.owner || [...e.ids].some((id) => ids.has(id))));
  // A number never vouches for itself, which it would as "60 - 30 = 30", and a
  // date is never half of a sum.
  const others = [
    ...anchored,
    ...literals
      .filter((l) => l.value !== num.value && l.dim !== 'date' && !l.word && !l.spelled)
      .map((l) => ({ value: l.value, ids: new Set(), dim: l.dim })),
  ];
  const matches = (d) => acceptsDim(num, d.dim) && near(num.value, d.value);
  for (const a of anchored) {
    for (const b of others) {
      if (a === b) continue;
      if (derived(a, b).some(matches) || derived(b, a).some(matches)) return new Set([...a.ids, ...b.ids]);
    }
  }
  return null;
}

// Placeholders are values the server fills in, so they are not the model's
// numbers. They are blanked to a word of the same length so positions hold.
function blankPlaceholders(text) {
  return String(text).replace(/\{\{fact:[A-Za-z_]+\}\}/g, (m) => 'x'.repeat(m.length));
}

/**
 * Check one sentence's numbers against what supports them.
 *
 * A WORKED-OUT NUMBER SHOWS ITS WORKING IN ITS OWN SENTENCE. The operands of
 * any arithmetic are the facts this sentence cites and the numbers it writes
 * (plus anything the owner typed), never a fact three lines up: "Yesterday
 * came in at 41, 18% under your usual 50" can be checked by the owner reading
 * it, and so can the server. The contracts say so.
 * @returns {{ok: boolean, ids: Set<string>, number?: string}}
 */
// A YEAR OF A WEEK (2026-10-28, stand-in model eval). "10 covers short is
// $380 a week, or $19,760 over 52 weeks" lost its sentence: $380 is worked out
// from the owner's $38, but a second step on a worked-out figure is not
// arithmetic the check does, so the yearly figure the playbook itself writes
// ("$380, about $19,760 a year") was refused when the model wrote it.
//
// Narrow, after two adversarial reviews: the weekly or monthly figure has to
// be worked out in this sentence (not a fact or the owner's number restated,
// whose period the model would be inventing: "you spend $38 a week" when $38
// is per head), it carries its own period ("$380 a week"), the year phrase
// sits right after the yearly figure (so "over half a year ... $19,760" is no
// year), and the product is within 2% ("about $20,000" for $19,760 passes,
// "$20,700" does not).
const OWN_PERIOD = /^\s*(?:(?:a|per|each|every)\s+(week|month)\b|(week|month)ly\b)/i;
const OWN_YEAR = /^\s*(?:(?:a|per|each|every|in\s+a)\s+year\b|yearly\b|annually\b|over\s+(?:52\s+weeks|12\s+months|a\s+(?:full\s+)?year)\b)/i;
function restated(num, support) {
  return support.base.some((e) => directKinds(num.dim, e.dim) && close(num.value, e.value));
}
function yearOf(num, text, support, inPlay) {
  if (num.dim !== 'money' || !OWN_YEAR.test(text.slice(num.index + num.length))) return null;
  for (const lit of inPlay.literals) {
    if (lit.dim !== 'money' || lit.value === num.value || lit.spelled) continue;
    const period = text.slice(lit.index + lit.length).match(OWN_PERIOD);
    if (!period || restated(lit, support)) continue;
    const yearly = lit.value * ((period[1] || period[2]).toLowerCase() === 'week' ? 52 : 12);
    if (Math.abs(num.value - yearly) > Math.max(0.5, yearly * 0.02)) continue;
    const from = supportFor(lit, support, inPlay);
    if (from) return from;
  }
  return null;
}

// A WORKED FIGURE IN A SUPPOSITION MUST ADD UP (third round, 2026-11-03).
// "If", "say" and "suppose" set every number after them aside, and that set
// aside the RESULT of the arithmetic too: "If 80 guests pay $38 each, that is
// $4,000" reached the owner, a wrong product dressed as a worked example. The
// operands are the supposition's own (80 guests is not a reading), so the
// figure it works out is checked against the numbers its sentence shows, its
// facts and the owner's numbers, worked one or two steps ("say 10 tables of 6
// turn once more at $45 a head: that is $2,700"). A worked figure is one
// written right after "that is", "comes to", "adds up to", "works out to",
// "equals" or "=", or after "is" where a quantity stands in front of it ("4
// hours is $60"; "if your food cost is 38%" sets a number and works out none).
// Only in a supposition: outside one, the recorded runs state correct yearly
// and weekly figures whose working sits in the line before ("Over a year,
// those 10 weekly covers add up to $19,760"), and a sentence-by-sentence check
// cannot see it.
const SUPPOSING = /\b(?:if|say|suppose|supposing|imagine|assuming|assume|for\s+example|for\s+instance)\b/i;
// And the supposition's outcome said as what the owner takes or gives
// ("If 80 guests pay $38 each, you clear $4,000", "...that totals $4,000"),
// which a review of the round found unread (2026-11-03).
const RESULT_MARK = /(?:\b(?:that\s+is|that['’]s|that\s+(?:comes|adds\s+up|works\s+out)\s+to|that\s+would\s+be|that['’]d\s+be|which\s+is|which\s+(?:comes|adds\s+up|works\s+out)\s+to|for\s+a\s+total\s+of|equals|(?:comes?|adds?\s+up|works?\s+out)\s+to|(?:that|which|it)\s+totals|totall?ing|you(?:['’]d|['’]ll|\s+would|\s+will)?\s+(?:clear|make|net|gross|take\s+in|bring\s+in|earn|pocket|keep|save|lose|give\s+(?:up|away)))|=)\s*(?:about|roughly|around|nearly|almost|close\s+to|just\s+over|just\s+under|over|under|some)?\s*$/i;
const IS_MARK = /\b(?:is|are)\s+(?:(?:about|roughly|around|nearly|almost|close\s+to|just\s+over|just\s+under|over|under|some)\s+)?$/i;
// The working is shown when at least two operands stand in front of the
// figure, numbers or placeholders: "If 20 guests order the special, that is
// $240" works from a price stated in another line, and is not judged here.
const OPERAND_SHOWN = /x{10,}/g;
function workedResult(text, num, all) {
  const before = text.slice(0, num.index);
  if (!SUPPOSING.test(before)) return false;
  const shown = all.filter((n) => n !== num && n.index < num.index && n.dim !== 'date' && !n.word && !n.spelled).length
    + (before.match(OPERAND_SHOWN) || []).length;
  if (shown < 2) return false;
  if (RESULT_MARK.test(before)) return true;
  if (!IS_MARK.test(before)) return false;
  const clauseAt = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf(':')) + 1;
  return all.some((n) => n !== num && n.index >= clauseAt && n.index < num.index && n.dim !== 'date')
    || /x{10,}/.test(before.slice(clauseAt));
}
// Generous on purpose: it can only take away a line no other rule reads, so a
// rate times hours ("$15 an hour: 4 hours is $60"), a rate per hour ("$1,800
// over 40 labor hours is $45 per labor hour", the playbook's own example) and
// a gap in points ("from 38% to 35% is 3 points") count too.
function workedSteps(a, b) {
  const out = derived(a, b);
  if (b.value !== 0 && (b.dim === 'plain' || b.dim === 'duration') && ['money', 'plain', 'duration'].includes(a.dim)) {
    out.push({ value: a.value / b.value, dim: a.dim });
  }
  return out;
}
// BOUNDED, BECAUSE OWNER TEXT IS LONG (review, 2026-11-03). The search runs
// one or two steps over every pair and triple of its operands, and with the
// owner's numbers among them a question of 132 small numbers held the server
// for 18 seconds on one supposition. A supposition's operands are written in
// its own sentence, so the operands are the sentence's own numbers and the
// facts it cites, each value once, and at most WORKED_OPERANDS of them.
const WORKED_OPERANDS = 8;
function workedFrom(num, support, inPlay, all) {
  const ids = inPlay.ids instanceof Set ? inPlay.ids : new Set();
  const operands = [];
  const seen = new Set();
  const take = (e) => {
    const key = `${e.dim}:${e.value}`;
    if (seen.has(key) || operands.length >= WORKED_OPERANDS) return;
    seen.add(key);
    operands.push(e);
  };
  for (const n of all) {
    if (n !== num && n.dim !== 'date' && !n.word && !n.spelled) take({ value: n.value, ids: new Set(), dim: n.dim });
  }
  for (const e of support.base) {
    if (e.arith !== false && !e.owner && [...e.ids].some((id) => ids.has(id))) take(e);
  }
  const pool = [...operands, ...operands.filter((e) => e.dim === 'duration').map((e) => ({ ...e, dim: 'plain' }))];
  // Within 5%, since a worked figure is said rounded ("$110 less 25 to 30% is
  // about $75 to $80"); the wrong product this exists for is far off ($4,000
  // for $3,040). The second step may take an operand again: what is kept of
  // $110 after 30% is 110 less 30% of 110.
  const matches = (d) => (acceptsDim(num, d.dim) || (num.dim === 'plain' && d.dim === 'pct'))
    && (close(num.value, d.value) || Math.abs(num.value - d.value) <= Math.abs(d.value) * 0.05);
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = 0; j < pool.length; j += 1) {
      if (i === j) continue;
      for (const r of workedSteps(pool[i], pool[j])) {
        if (matches(r)) return true;
        for (let k = 0; k < pool.length; k += 1) {
          if (workedSteps(r, pool[k]).some(matches) || workedSteps(pool[k], r).some(matches)) return true;
        }
      }
    }
  }
  return false;
}

function checkSentenceNumbers(sentence, support, { alone = false } = {}) {
  const inPlay = inPlayFor([sentence]);
  // Folded the way numbersIn folds it, so the positions it reports are
  // positions in this text: an ellipsis is three characters after folding,
  // and reading the unfolded text at folded positions moved every clause two
  // places and let "Heads up… expect around 45 people tonight" past the
  // claim rules (adversarial review, 2026-10-28 night).
  const text = asciiDigits(blankPlaceholders(sentence));
  const ids = new Set();
  const all = numbersIn(text);
  for (const num of all) {
    if (!isReadingSlot(text, num, all, alone)) {
      // A worked figure inside a supposition still adds up: a number the
      // facts or the owner hold, a year of a week, or the bounded search.
      if (workedResult(text, num, all) && !supportedDirectly(num, support)
        && !yearOf(num, text, support, inPlay) && !workedFrom(num, support, inPlay, all)) {
        return { ok: false, ids, number: text.slice(num.index, num.index + num.length) };
      }
      continue;
    }
    const from = supportFor(num, support, inPlay) || yearOf(num, text, support, inPlay);
    const written = text.slice(num.index, num.index + num.length);
    if (!from) return { ok: false, ids, number: written };
    for (const id of from) ids.add(id);
  }
  return { ok: true, ids };
}

/** What an answer shows: the facts it cites and the numbers it writes. */
function inPlayFor(sentences) {
  const ids = new Set();
  const literals = [];
  for (const s of sentences) {
    for (const m of String(s).matchAll(/\{\{fact:([A-Za-z_]+)\}\}/g)) ids.add(m[1]);
    literals.push(...numbersIn(blankPlaceholders(s)));
  }
  return { ids, literals };
}

/** The reason one sentence must go, or null. */
function sentenceVeto(sentence, { mode } = {}) {
  if (FABRICATED_SOURCE.test(sentence)) return 'a study or survey nobody can find';
  if (NO_DATA_AS_EMPTY.test(sentence)) return 'missing data read as an empty room';
  if (mode === 'advice' && FALSE_MEASUREMENT.test(sentence) && !/\{\{fact:/.test(sentence)) {
    return 'general advice dressed as our measurement';
  }
  return null;
}

module.exports = {
  MAX_ANSWER_SENTENCES,
  MAX_POINTS,
  MAX_PLAIN_SENTENCES,
  MAX_POINT_CHARS,
  BULLET,
  RESPONSE_SCHEMA,
  parseAnswer,
  assemble,
  splitSentences,
  repairDashes,
  tidyNumbers,
  wholeAnswerVeto,
  sentenceVeto,
  numbersIn,
  isReadingSlot,
  buildSupport,
  supportFor,
  checkSentenceNumbers,
  inPlayFor,
  PROHIBITED_ADVICE,
  UPSELL,
  PROMPT_LEAK,
  FABRICATED_SOURCE,
  FALSE_MEASUREMENT,
  NO_DATA_AS_EMPTY,
};
