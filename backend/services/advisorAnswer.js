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
    re: /\b(unpaid|off\s+the\s+clock|without\s+pay|dock(?:ing)?\s+(?:their|his|her|the)?\s*(?:pay|wages|tips)|withhold(?:ing)?\s+(?:their\s+|the\s+)?(?:pay|wages|tips)|garnish|minimum\s+wage|independent\s+contractor|cash\s+in\s+hand|under\s+the\s+table|tip\s+(?:pool|credit|out)|fire\s+(?:them|him|her|a\s+(?:server|bartender|barista|cook|chef|host|hostess|manager|member|porter|runner)|your\s+(?:staff|crew|team|opener|closer|server|bartender|barista|cook|chef|host|hostess|manager|employee|worker))|terminat(?:e|ing)\s+(?:them|their|his|her)|let\s+(?:them|him|her)\s+go|write\s+(?:them|him|her)\s+up|disciplinary|non[\s-]?compete|probationary\s+period|hold\s+(?:the\s+|my\s+|your\s+|our\s+)?(?:last\s+|closing\s+|late\s+|whole\s+)?(?:shift|crew|staff|team|servers?|closers?|openers?|porters?|them|him|her)\s+back\b|condition\s+of\s+the\s+(?:shift|rota|job|role)|(?:no|nothing)\s+extra\s+on\s+the\s+(?:sheet|books|rota|clock)|off\s+the\s+(?:sheet|books)|start\s+(?:their|his|her|the)\s+clock|compel(?:ling)?\s+(?:the\s+|a\s+|my\s+|our\s+|any\s+)?(?:waiter|waitress|server|staff|team|crew|barista|bartender|cook|chef|host|hostess|porter|employee|worker|them|him|her)|remain(?:ing)?\s+(?:beyond|past|after)\s+(?:closing|close|their\s+shift|the\s+shift))\b|\b(?:work|works|working|stay|stays|staying|remain|remains|remaining|shift|shifts|closing|overtime)\b[^.!?]{0,40}\bgratis\b|\bgratis\b[^.!?]{0,40}\b(?:work|shift|closing|hours?)\b/i,
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
];

/** The reason the whole answer is void, or null. */
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
const NUMBER = /(\$\s?)?\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:(st|nd|rd|th)\b)?(\s?(?:%|percent\b|per\s+cent\b))?/gi;

/**
 * Every number written in a piece of text, with where it sits. Clock times
 * come out as hours of the day (9:30 PM is 21.5) and also carry the hour as
 * it was written, because "9" and "21" are both the same kitchen.
 */
function numbersIn(text) {
  const src = asciiDigits(text);
  const out = [];
  const taken = new Array(src.length).fill(false);
  const mark = (i, n) => { for (let k = i; k < i + n; k++) taken[k] = true; };

  let m;
  // Dates first: a calendar day is a number a claim can name ("your peak lands
  // on Oct 25") and never an operand of arithmetic, so it is tagged as one.
  ISO_DATE.lastIndex = 0;
  while ((m = ISO_DATE.exec(src)) !== null) {
    out.push({ index: m.index, length: m[0].length, value: Number(m[3]), alt: [Number(m[1]), Number(m[2])], kind: 'date', dim: 'date' });
    mark(m.index, m[0].length);
  }
  MONTH_DAY.lastIndex = 0;
  while ((m = MONTH_DAY.exec(src)) !== null) {
    if (taken[m.index]) continue;
    out.push({ index: m.index, length: m[0].length, value: Number(m[2]), alt: m[3] ? [Number(m[3])] : [], kind: 'date', dim: 'date' });
    mark(m.index, m[0].length);
  }
  CLOCK_TIME.lastIndex = 0;
  while ((m = CLOCK_TIME.exec(src)) !== null) {
    const h12 = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const pm = m[3].toLowerCase() === 'p';
    const h24 = (h12 % 12) + (pm ? 12 : 0);
    out.push({ index: m.index, length: m[0].length, value: h24 + min / 60, alt: [h12 + min / 60], kind: 'clock', dim: 'clock' });
    mark(m.index, m[0].length);
  }
  CLOCK_24.lastIndex = 0;
  while ((m = CLOCK_24.exec(src)) !== null) {
    if (taken[m.index]) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    out.push({ index: m.index, length: m[0].length, value: h + min / 60, alt: [(h % 12 || 12) + min / 60], kind: 'clock', dim: 'clock' });
    mark(m.index, m[0].length);
  }
  NUMBER.lastIndex = 0;
  while ((m = NUMBER.exec(src)) !== null) {
    if (taken[m.index] || taken[m.index + (m[1] ? m[1].length : 0)]) continue;
    const value = Number(`${m[2].replace(/,/g, '')}${m[3] || ''}`);
    if (!Number.isFinite(value)) continue;
    const kind = m[5] ? 'percent' : m[1] ? 'money' : m[4] ? 'ordinal' : 'number';
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 16);
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

function isReadingSlot(text, num) {
  const prefix = text.slice(clauseStart(text, num.index), num.index);
  if (EXPECT_LEAD.test(prefix)) return true;
  if (NOT_A_READING.test(prefix)) return false;
  // "a $12 special", "an 85 seat room": the article makes it a kind of
  // thing, not a reading of one.
  if (/\b(?:a|an)\s*\$?\s*$/i.test(prefix)) return false;
  if (AGAINST_HISTORY.test(text.slice(num.index + num.length))) return true;
  if (!SUBJECT.test(prefix)) return false;
  const tail = prefix.trim().split(/\s+/).slice(-LAST_WORDS).join(' ');
  return CLAIM_VERB.test(tail);
}

// ── What the venue's numbers support ────────────────────────────────────────

function addValue(list, value, ids, { owner = false, arith = true, dim = 'plain' } = {}) {
  if (!Number.isFinite(value)) return;
  list.push({ value, ids, owner, arith, dim });
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
    if (typeof v === 'number') {
      addValue(base, v, ids, { dim });
      if (f.unit === 'hour') addValue(base, (v % 12) || 12, ids, { dim });
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
        const opts = { arith: n.dim !== 'date', dim: n.dim === 'plain' ? dim : n.dim };
        addValue(base, n.value, ids, opts);
        for (const a of n.alt) addValue(base, a, ids, opts);
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
      const opts = { owner: true, arith: n.dim !== 'date', dim: n.dim };
      addValue(base, n.value, new Set(), opts);
      for (const a of n.alt) addValue(base, a, new Set(), opts);
    }
  }
  return { base };
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
  // Nought and one are never a fabricated reading of any consequence, and
  // positions ("your 2nd busiest day") are rankings the owner can check.
  if (targets.some((t) => t === 0 || t === 1)) return new Set();
  if (num.kind === 'ordinal' && num.value <= 10) return new Set();

  // A percentage may also be a share the facts hold as a fraction (0.42 is
  // 42%), matched at the fraction's own scale: "82%" is not "about 1".
  const ratio = num.dim === 'pct' ? num.value / 100 : null;
  for (const entry of support.base) {
    if (!directKinds(num.dim, entry.dim)) continue;
    if (targets.some((t) => close(t, entry.value))) return entry.ids;
    if (ratio !== null && entry.value > 0 && entry.value <= 1 && Math.abs(ratio - entry.value) <= 0.005) return entry.ids;
  }
  const anchored = support.base.filter((e) => e.arith !== false && (e.owner || [...e.ids].some((id) => ids.has(id))));
  // A number never vouches for itself, which it would as "60 - 30 = 30", and a
  // date is never half of a sum.
  const others = [
    ...anchored,
    ...literals
      .filter((l) => l.value !== num.value && l.dim !== 'date')
      .map((l) => ({ value: l.value, ids: new Set(), dim: l.dim })),
  ];
  const matches = (d) => acceptsDim(num, d.dim) && close(num.value, d.value);
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
function checkSentenceNumbers(sentence, support) {
  const inPlay = inPlayFor([sentence]);
  const text = blankPlaceholders(sentence);
  const ids = new Set();
  for (const num of numbersIn(text)) {
    if (!isReadingSlot(text, num)) continue;
    const from = supportFor(num, support, inPlay);
    if (!from) return { ok: false, ids, number: text.slice(num.index, num.index + num.length) };
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
};
