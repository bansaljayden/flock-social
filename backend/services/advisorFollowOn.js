// A typed question that only makes sense after the last answer.
//
// Owners talk to Roost the way they talk to anyone: "what else?" after a move
// they do not like, "what about Wednesdays?" after a Tuesday answer. Each of
// those arrived alone and got "we could not get to that one" (2026-10-28),
// because a typed question carried nothing of what came before it.
//
// THE CLIENT CARRIES THE CONTEXT, NOT THE SERVER. The chat already holds its
// own thread, so it sends the last turn back as `previous` ({question,
// intentId, tactics}) with the next typed question. Nothing about the owner's
// earlier words is kept here between requests. And because `previous` is
// client input, every part of it is checked against a closed list before use,
// and the question built from it goes through the same screens, router and
// class checks as anything typed: a follow-on is never a way around them.
//
// Only two shapes use the context. Anything else is answered as written.
//   "what else" / "another idea" / "we already tried that"
//       The last question again, with the moves already given set aside.
//   "what about Wednesdays" / "and lunch?"
//       The last question with that day or part of the day in it instead.

const { normalizeOwnerText } = require('./ownerWords');
const roostPlaybook = require('./roostPlaybook');

const PREVIOUS_KEYS = Object.freeze(['question', 'intentId', 'tactics']);
const MAX_PREVIOUS_TACTICS = 6;
const TACTIC_IDS = Object.freeze(new Set(roostPlaybook.tactics.map((t) => t.id)));

const LEAD_IN = '(?:(?:ok(?:ay)?|cool|thanks|thank\\s+you|thx|got\\s+it|hmm+|and|so|alright|right|sure|nice|great|yeah|yes|no|nah|good|perfect|interesting|makes\\s+sense)[\\s,.!]+)*';

const ELSE = new RegExp(`^${LEAD_IN}(?:what\\s+else|anything\\s+else|any\\s+other\\s+(?:ideas?|options?|moves?|ways?|suggestions?)|other\\s+(?:ideas?|options?|moves?|suggestions?)|another\\s+(?:idea|option|move|one|way|suggestion)|something\\s+else|(?:any\\s+)?more\\s+ideas|give\\s+me\\s+(?:another(?:\\s+one)?|more|something\\s+else)|(?:i|we)\\s+(?:already\\s+)?(?:tried|do|did|have\\s+done|have\\s+tried)\\s+(?:that|this|it)(?:\\s+already)?|(?:that|this|it)\\s+(?:won'?t|doesn'?t|didn'?t|wouldn'?t)\\s+work(?:\\s+(?:for\\s+us|for\\s+me|here))?)(?:[\\s,]+(?:can|could|should|would)\\s+(?:i|we)\\s+(?:do|try))?[\\s?.!]*$`);

const DAY_WORDS = '(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekends?|weekdays?|weeknights?|tonight|tomorrow)';
const PART_WORDS = '(?:breakfast|brunch|lunch|dinner|mornings?|afternoons?|evenings?|late\\s+nights?|happy\\s+hour)';
const DAY = new RegExp(`\\b${DAY_WORDS}\\b`);
const PART = new RegExp(`\\b${PART_WORDS}\\b`);
const SWAP = new RegExp(`^${LEAD_IN}(?:(?:and\\s+)?(?:what|how)\\s+about|and|same\\s+(?:for|with)|now|what\\s+if\\s+it'?s)\\s+(?:on\\s+|for\\s+|at\\s+|in\\s+the\\s+|the\\s+)?(${DAY_WORDS}|${PART_WORDS})[\\s?.!]*$`);

/**
 * Check the `previous` a client sent. Absent is fine; anything malformed is a
 * bad request, because a well-behaved chat never sends one.
 * @param {*} raw req.body.previous
 * @param {{sanitize: function, isIntent: function}} checks
 * @returns {{ok: true, previous: null|{question: string, intentId: string|null, tactics: string[]}}|{ok: false}}
 */
function readPrevious(raw, { sanitize, isIntent }) {
  if (raw === undefined) return { ok: true, previous: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const keys = Object.keys(raw);
  if (!keys.includes('question') || keys.some((k) => !PREVIOUS_KEYS.includes(k))) return { ok: false };
  const clean = sanitize(raw.question);
  if (!clean || !clean.ok) return { ok: false };
  let intentId = null;
  if (raw.intentId !== undefined && raw.intentId !== null) {
    if (typeof raw.intentId !== 'string' || !isIntent(raw.intentId)) return { ok: false };
    intentId = raw.intentId;
  }
  let tactics = [];
  if (raw.tactics !== undefined) {
    if (!Array.isArray(raw.tactics) || raw.tactics.length > MAX_PREVIOUS_TACTICS) return { ok: false };
    if (raw.tactics.some((id) => typeof id !== 'string' || !TACTIC_IDS.has(id))) return { ok: false };
    tactics = [...new Set(raw.tactics)];
  }
  return { ok: true, previous: { question: clean.text, intentId, tactics } };
}

function kindOf(word) {
  if (DAY.test(word)) return 'day';
  if (PART.test(word)) return 'part';
  return null;
}

// "How do I fill Tuesdays" + "what about Wednesdays" is "how do I fill
// Wednesdays". A day replaces a day and a part of the day replaces a part of
// the day; a question with neither gets the new one added on the end.
function swapInto(question, word) {
  const kind = kindOf(word);
  const text = normalizeOwnerText(question);
  const same = kind === 'day' ? DAY : PART;
  if (same.test(text)) return text.replace(same, word);
  const joint = kind === 'day' && !/^(?:tonight|tomorrow)$/.test(word) ? 'on' : kind === 'day' ? '' : 'at';
  return `${text.replace(/[\s?.!]+$/, '')} ${joint ? `${joint} ` : ''}${word}`.replace(/\s+/g, ' ');
}

/**
 * What the owner is asking, read with the turn before it.
 * @param {string} question the sanitised question as typed
 * @param {null|{question: string, intentId: string|null, tactics: string[]}} previous
 * @param {{maxChars: number}} limits
 * @returns {{question: string, kind: 'else'|'swap'|null, exclude: string[], previous: object|null}}
 */
function followOn(question, previous, { maxChars }) {
  const asIs = { question, kind: null, exclude: [], previous: null };
  if (!previous) return asIs;
  const said = normalizeOwnerText(question).trim();
  if (ELSE.test(said)) {
    // Both questions go to the router and the screens together, so the
    // earlier one is checked again here and is never let through on the
    // strength of having been asked before.
    const both = `${previous.question} ${question}`;
    return {
      question: both.length <= maxChars ? both : previous.question,
      kind: 'else',
      exclude: previous.tactics,
      previous,
    };
  }
  const swap = SWAP.exec(said);
  if (swap) {
    const swapped = swapInto(previous.question, swap[1].replace(/\s+/g, ' '));
    if (swapped.length <= maxChars) return { question: swapped, kind: 'swap', exclude: [], previous };
  }
  return asIs;
}

module.exports = {
  readPrevious,
  followOn,
  MAX_PREVIOUS_TACTICS,
};
