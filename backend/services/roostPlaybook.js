// ---------------------------------------------------------------------------
// THE ROOST PLAYBOOK: money moves from the trade, in our own words.
//
// Asked for on 2026-10-28: Roost should carry the best public advice from
// people who run rooms well, not only what a general model happens to know.
// Each tactic in roostPlaybook.json is one move an owner could start this
// week, why it makes or saves money, how to tell whether it worked, and the
// source distributions it rests on (`basis`, for our own audit; owners never see
// it). The words are ours. Nothing in the file is copied from a source.
//
// It does two jobs.
//   1. With the model up, the best few tactics for a question ride into the
//      advice payload as vetted moves to build on (advisorFreeText.advise),
//      so an answer starts from practice operators have tested instead of
//      from whatever a general model offers that day.
//   2. With the model down, out of allowance, or its draft thrown out by the
//      answer check, the best tactic IS the answer: one line, why it pays,
//      the money in the venue's own spend per head, what to watch, and one
//      alternative, sourced as the Roost playbook. Roost keeps answering
//      money questions with no model call at all.
//
// RETRIEVAL IS PLAIN ON PURPOSE: the words the owner typed against each
// tactic's cues, plus the topic the question routed to, filtered by what the
// venue is (a cafe never gets a cocktail move unless it asks about drinks).
// No embeddings, so there is no second model call, nothing drifts, and a test
// can say exactly which tactic a question gets.
// ---------------------------------------------------------------------------

const advisorAnswer = require('./advisorAnswer');

// The closed topic list. A tactic outside it fails at load, not in front of
// an owner.
const TOPICS = Object.freeze([
  'fill_slow_days', 'handle_the_rush', 'turn_tables', 'check_average', 'pricing',
  'menu_engineering', 'food_cost', 'labor', 'staff', 'reservations', 'waitlist',
  'regulars', 'marketing', 'reviews', 'events', 'takeout_delivery', 'beverage',
  'dayparts', 'weather_season', 'hospitality', 'costs',
]);
const VENUE_KINDS = Object.freeze(['all', 'full_service', 'quick_service', 'cafe', 'bakery', 'bar', 'club']);
const MONEY_KINDS = Object.freeze(['covers', 'check', 'cost', 'none']);

// Which topics a routed question leans toward. The first gets the bigger
// nudge. A question routed to quiet_nights with no word matching any cue still
// lands on a slow-day move, which is what it was about.
const INTENT_TOPICS = Object.freeze({
  // The money move chip: a week with a quiet end is filled, and a level
  // week's money is in each check (routes/advisor.js picks which).
  money_move: ['fill_slow_days', 'events'],
  money_move_level: ['check_average', 'pricing'],
  quiet_nights: ['fill_slow_days', 'events'],
  slow_night: ['fill_slow_days', 'weather_season'],
  last_night_verdict: ['fill_slow_days', 'regulars'],
  cohort_same_night: ['fill_slow_days', 'weather_season'],
  week_recap: ['fill_slow_days', 'labor'],
  peak_hours: ['handle_the_rush', 'labor'],
  tonight_outlook: ['handle_the_rush', 'labor'],
  weekend_outlook: ['handle_the_rush', 'events'],
  tables_service: ['turn_tables', 'labor'],
  tables_free: ['turn_tables', 'waitlist'],
  capacity_math: ['turn_tables', 'handle_the_rush'],
  kitchen_vs_peak: ['handle_the_rush', 'dayparts'],
  busy_nights_check: ['labor', 'fill_slow_days'],
  around_you: ['events', 'weather_season'],
  cohort_typical: ['marketing', 'regulars'],
});

// The single words that say which part of the business a question is about.
// Cues are mostly phrases ("slow night deal", "fill seats"), and an owner
// types "how do I make Tuesdays better" or "turn tables faster": no phrase,
// but every word points at a topic. Each hit leans the question toward that
// topic's tactics (score below); the tactic's own cues still pick within it.
// Friday and Saturday are not slow-day words: most rooms are busy then.
const TOPIC_WORDS = Object.freeze({
  fill_slow_days: ['slow', 'slower', 'slowest', 'quiet', 'quieter', 'quietest', 'dead', 'empty', 'fill', 'midweek', 'monday', 'tuesday', 'wednesday', 'thursday', 'sunday', 'weekday', 'traffic', 'busier'],
  handle_the_rush: ['rush', 'busiest', 'peak', 'slammed', 'weeds', 'queue', 'swamped', 'overwhelmed', 'backed', 'line'],
  turn_tables: ['turn', 'turns', 'turnover', 'table', 'tables', 'linger', 'lingering', 'camp', 'camping', 'dwell', 'seat', 'seats', 'seating', 'faster', 'sit', 'sitting', 'laptop', 'laptops'],
  check_average: ['upsell', 'upselling', 'spend', 'check', 'ticket', 'dessert', 'desserts', 'appetizer', 'appetizers', 'sides', 'addon'],
  pricing: ['price', 'prices', 'pricing', 'charge', 'charging', 'raise', 'increase', 'expensive', 'cheap'],
  menu_engineering: ['menu', 'menus', 'dish', 'dishes', 'item', 'items', 'layout', 'bestseller', 'bestsellers'],
  food_cost: ['food', 'ingredient', 'ingredients', 'waste', 'portion', 'portions', 'supplier', 'suppliers', 'inventory', 'plate'],
  labor: ['staff', 'staffing', 'schedule', 'scheduling', 'shift', 'shifts', 'labor', 'labour', 'payroll', 'server', 'servers', 'cook', 'cooks', 'barista', 'baristas', 'bartender', 'bartenders', 'overstaffed', 'understaffed'],
  staff: ['hire', 'hiring', 'retain', 'quit', 'quitting', 'train', 'training', 'morale', 'team', 'employee', 'employees'],
  reservations: ['reservation', 'reservations', 'booking', 'bookings', 'cancellation', 'cancellations', 'deposit', 'deposits'],
  waitlist: ['wait', 'waiting', 'waitlist', 'walkaway', 'walkaways'],
  regulars: ['regulars', 'regular', 'loyalty', 'loyal', 'repeat', 'return', 'returning', 'punch', 'rewards'],
  marketing: ['marketing', 'market', 'advertise', 'advertising', 'instagram', 'social', 'tiktok', 'facebook', 'google', 'promote', 'promotion', 'email', 'newsletter', 'listing', 'followers'],
  reviews: ['review', 'reviews', 'rating', 'ratings', 'yelp', 'stars', 'complaint', 'complaints', 'feedback'],
  events: ['event', 'events', 'trivia', 'music', 'live', 'private', 'party', 'parties', 'holiday', 'tasting', 'class', 'classes'],
  takeout_delivery: ['delivery', 'deliveries', 'takeout', 'togo', 'pickup', 'doordash', 'ubereats', 'grubhub', 'apps', 'commission', 'packaging'],
  beverage: ['drink', 'drinks', 'beer', 'wine', 'cocktail', 'cocktails', 'coffee', 'liquor', 'pour', 'spirits', 'happy'],
  dayparts: ['breakfast', 'brunch', 'lunch', 'dinner', 'late', 'morning', 'mornings', 'afternoon', 'afternoons', 'evening', 'evenings', 'daypart', 'opening', 'catering'],
  weather_season: ['weather', 'rain', 'rainy', 'snow', 'cold', 'hot', 'heat', 'summer', 'winter', 'season', 'seasonal', 'patio'],
  hospitality: ['hospitality', 'service', 'welcome', 'greet', 'experience', 'friendly', 'warm', 'apology', 'mistake'],
  costs: ['costs', 'expenses', 'rent', 'utilities', 'energy', 'fees', 'overhead', 'bills', 'savings', 'profit', 'profitable', 'cash', 'losing', 'under'],
});

// ── Words ────────────────────────────────────────────────────────────────────

// A crude stemmer, and crude is enough: the question and every cue go through
// the same function, so all it has to do is send "prices", "priced" and
// "pricing" to one key. It never has to be English.
const DOUBLED = /([bdgmnprt])\1$/;
function stem(word) {
  let s = String(word).replace(/'s$/, '').replace(/'/g, '');
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(?:sses|shes|ches|xes)$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ing')) {
    s = s.slice(0, -3);
    if (DOUBLED.test(s)) s = s.slice(0, -1);
  } else if (s.length > 4 && s.endsWith('ed')) {
    s = s.slice(0, -2);
    if (DOUBLED.test(s)) s = s.slice(0, -1);
  }
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

function words(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").match(/[a-z0-9']+/g) || [];
}

function stems(text) {
  return words(text).map(stem).filter(Boolean);
}

// Words too common to mean anything on their own. They still count inside a
// phrase cue ("more people"), where the order carries the meaning.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'my', 'our', 'we', 'i', 'is', 'are', 'do',
  'does', 'how', 'what', 'should', 'can', 'could', 'would', 'me', 'it', 'that', 'this', 'with', 'at', 'be',
  'get', 'you', 'your', 'more', 'make', 'have', 'has', 'there', 'they', 'them', 'us', 'so', 'if', 'any',
  'some', 'about', 'from', 'into', 'out', 'up', 'just', 'way', 'ways', 'want', 'need', 'help', 'best',
  'good', 'better', 'most', 'much', 'many', 'lot', 'lots', 'really', 'which', 'when', 'why', 'who', 'where',
  'will', 'am', 'was', 'were', 'its', 'than', 'then', 'too', 'very', 'all', 'one', 'no', 'not',
].map(stem));

function containsRun(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ── The venue ────────────────────────────────────────────────────────────────

// ml_venues.venue_category (mlPredictor.guessCategory) onto the playbook's
// venue kinds. A category with no mapping is unknown, and an unknown venue is
// offered every tactic that does not need alcohol.
const CATEGORY_KIND = Object.freeze({
  restaurant: 'full_service',
  nightclub: 'club',
  bar: 'bar',
  brewery: 'bar',
  cafe: 'cafe',
  fast_food: 'quick_service',
  dessert: 'bakery',
});

const DRINK_WORDS = /\b(drinks?|bar|beers?|wines?|cocktails?|liquor|spirits|happy\s+hour|pints?|taps?|booze|alcohol|bottles?|pours?)\b/i;

/** What the playbook needs to know about the venue: its kind and whether it pours. */
function venueOf(ctx) {
  const p = (ctx && ctx.profile) || {};
  const category = String((ctx && ctx.mlVenue && ctx.mlVenue.venue_category) || '').toLowerCase();
  let kind = CATEGORY_KIND[category] || null;
  if (p.service_style === 'counter_order' && (kind === 'full_service' || !kind)) kind = 'quick_service';
  if (p.service_style === 'bar_standing' && !kind) kind = 'bar';
  // Never assumed. A venue pours when its kind is a bar or a club, or when
  // the owner told us something only a venue that pours would set.
  const alcohol = kind === 'bar' || kind === 'club' || p.service_style === 'bar_standing'
    || Boolean(p.last_call) || p.age_policy === 'twenty_one_plus';
  return { kind, alcohol };
}

/** The owner's typical spend per person, or null. */
function spendOf(ctx) {
  const v = Number(ctx && ctx.profile ? ctx.profile.typical_spend_per_person : NaN);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ── Loading ──────────────────────────────────────────────────────────────────

function fail(id, why) {
  throw new Error(`roostPlaybook: tactic ${id || '(no id)'} ${why}`);
}

/** Every rule a tactic must meet to load. A bad edit fails the suite, not an owner. */
function validateTactic(t) {
  if (!t || typeof t !== 'object') fail(null, 'is not an object');
  if (typeof t.id !== 'string' || !/^[a-z]+(?:_[a-z]+)*$/.test(t.id)) fail(t.id, 'needs an id of lowercase letters and underscores');
  if (!TOPICS.includes(t.topic)) fail(t.id, `has an unknown topic "${t.topic}"`);
  if (!Array.isArray(t.venues) || !t.venues.length || t.venues.some((v) => !VENUE_KINDS.includes(v))) fail(t.id, 'needs venues from the closed list');
  if (typeof t.alcohol !== 'boolean') fail(t.id, 'needs alcohol true or false');
  if (!Array.isArray(t.cues) || t.cues.length === 0 || t.cues.some((c) => typeof c !== 'string' || !stems(c).length)) fail(t.id, 'needs cues');
  for (const field of ['move', 'why', 'watch']) {
    if (typeof t[field] !== 'string' || !t[field].trim()) fail(t.id, `needs ${field}`);
  }
  if (t.example !== undefined && t.example !== null && typeof t.example !== 'string') fail(t.id, 'has a non-text example');
  if (!MONEY_KINDS.includes(t.money)) fail(t.id, `has an unknown money kind "${t.money}"`);
  if (t.follow_up !== undefined && t.follow_up !== null && (typeof t.follow_up !== 'string' || !/\?$/.test(t.follow_up))) fail(t.id, 'has a follow_up that is not a question');
}

function compile(tactics) {
  const seen = new Set();
  const out = tactics.map((t, order) => {
    validateTactic(t);
    if (seen.has(t.id)) fail(t.id, 'is listed twice');
    seen.add(t.id);
    return {
      ...t,
      order,
      cueStems: t.cues.map((c) => stems(c)).filter((c) => c.length > 1 || !STOP.has(c[0])),
      // The tactic's own words, for the weak second signal in score().
      textStems: new Set(stems(`${t.move} ${t.why}`).filter((w) => !STOP.has(w) && w.length > 2)),
    };
  });
  // A CUE THAT HALF THE PLAYBOOK SHARES SAYS LITTLE. "slow" is a cue on every
  // slow-day tactic, "happy hour" on one; the rarer cue is the one that picks
  // between them. Each cue counts 1 over the square root of how many tactics
  // carry it.
  const df = new Map();
  for (const t of out) {
    for (const key of new Set(t.cueStems.map((c) => c.join(' ')))) df.set(key, (df.get(key) || 0) + 1);
  }
  for (const t of out) {
    t.cueWeights = t.cueStems.map((c) => (c.length > 1 ? 2 : 1) / Math.sqrt(df.get(c.join(' ')) || 1));
  }
  return out;
}

// ── Retrieval ────────────────────────────────────────────────────────────────

// Alcohol is the one hard gate: a venue that does not pour never gets a
// drinks move unless it asked about drinks.
function fits(t, venue, asksAboutDrinks) {
  return !(t.alcohol && !(venue && venue.alcohol) && !asksAboutDrinks);
}

function forThisKind(t, venue) {
  if (t.venues.includes('all') || !venue || !venue.kind) return true;
  return t.venues.includes(venue.kind);
}

// A TACTIC WRITTEN FOR OTHER KINDS OF VENUE IS OFFERED WHEN THE OWNER NAMES
// ITS SUBJECT. Venue tags say where a move usually applies; a bar asking
// about no-shows takes bookings, and a counter cafe asking about brunch is
// thinking of serving one. The question is the evidence, so a cue match this
// strong lets the tactic through, a little behind any that were written for
// the venue.
const NAMED_MIN = 0.75;
const OTHER_KIND_PENALTY = 0.25;

// The weak second signal: words the question shares with the move itself.
// Worth a fraction of a cue each and capped, so it breaks ties between
// tactics a cue already found and never finds one on its own.
const TEXT_WEIGHT = 0.2;
const TEXT_CAP = 0.6;

// Each topic word in the question leans it toward that topic, up to a cap,
// so a question no cue phrase matches still finds its topic's best tactic.
const TOPIC_WORD_WEIGHT = 0.5;
const TOPIC_WORD_CAP = 1.5;
const TOPIC_OF_WORD = new Map();
for (const [topic, list] of Object.entries(TOPIC_WORDS)) {
  for (const w of list) {
    const key = stem(w);
    if (!TOPIC_OF_WORD.has(key)) TOPIC_OF_WORD.set(key, new Set());
    TOPIC_OF_WORD.get(key).add(topic);
  }
}

function topicLean(qSet) {
  const hits = new Map();
  for (const w of qSet) {
    for (const topic of TOPIC_OF_WORD.get(w) || []) hits.set(topic, (hits.get(topic) || 0) + 1);
  }
  return hits;
}

function score(t, qStems, qSet, topics, venue, lean) {
  let cues = 0;
  t.cueStems.forEach((cue, i) => {
    if (cue.length === 1 ? qSet.has(cue[0]) : containsRun(qStems, cue)) cues += t.cueWeights[i];
  });
  const ownKind = forThisKind(t, venue);
  if (!ownKind && cues < NAMED_MIN) return 0;
  let s = cues + Math.min(TOPIC_WORD_CAP, (lean.get(t.topic) || 0) * TOPIC_WORD_WEIGHT);
  if (topics[0] === t.topic) s += 1.5;
  else if (topics[1] === t.topic) s += 1;
  if (s === 0) return 0;
  let shared = 0;
  for (const w of qSet) if (t.textStems.has(w)) shared += 1;
  s += Math.min(TEXT_CAP, shared * TEXT_WEIGHT);
  if (!ownKind) s -= OTHER_KIND_PENALTY;
  else if (venue && venue.kind && t.venues.includes(venue.kind)) s += 0.25;
  return s;
}

// The floor a tactic has to clear to be offered at all: a cue nobody else
// shares, two shared ones, or the topic the question routed to. Below it the
// playbook has nothing to say and says nothing, rather than answering a
// question it was not asked.
const MIN_SCORE = 0.5;

function createPlaybook(tactics) {
  const compiled = compile(Array.isArray(tactics) ? tactics : []);
  const byId = new Map(compiled.map((t) => [t.id, t]));

  /**
   * The best tactics for a question, best first.
   * @param {string} question
   * @param {{intentId?: string|null, venue?: {kind: string|null, alcohol: boolean}, limit?: number, exclude?: string[]}} opts
   */
  function find(question, { intentId = null, venue = null, limit = 3, exclude = [] } = {}) {
    const qStems = stems(question);
    const qSet = new Set(qStems.filter((w) => !STOP.has(w)));
    const topics = INTENT_TOPICS[intentId] || [];
    const drinks = DRINK_WORDS.test(String(question || ''));
    const lean = topicLean(qSet);
    return compiled
      .filter((t) => !exclude.includes(t.id) && fits(t, venue, drinks))
      .map((t) => ({ t, s: score(t, qStems, qSet, topics, venue, lean) }))
      .filter(({ s }) => s >= MIN_SCORE)
      .sort((a, b) => (b.s - a.s) || (a.t.order - b.t.order))
      .slice(0, limit)
      .map(({ t }) => t);
  }

  return { tactics: compiled, byId, find };
}

// ── The answer ───────────────────────────────────────────────────────────────

function dollars(n) {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r)
    ? `$${r.toLocaleString('en-US')}`
    : `$${r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The move put in the venue's own money. Arithmetic on the owner's own figure,
// with the working in the sentence, the way the answer contract asks of the
// model (advisorPrompt, NUMBERS rule Four). Ten covers is a unit to scale
// from, not a forecast.
function moneyLine(tactic, spend) {
  if (!(spend > 0)) return null;
  if (tactic.money === 'covers') {
    const week = spend * 10;
    return `At your ${dollars(spend)} a head, every 10 extra covers a week is ${dollars(week)}, about ${dollars(week * 52)} a year.`;
  }
  if (tactic.money === 'check') {
    const bump = spend < 15 ? 1 : spend < 40 ? 2 : 5;
    const lift = Math.round((bump / spend) * 100);
    return `At your ${dollars(spend)} a head, ${dollars(bump)} more on each check is about ${lift}% more from every cover you already serve.`;
  }
  return null;
}

// One line of the venue's own forecast, when the question routed to a day.
// Only the weekday is read: it is the one part of a peak fact that needs no
// unit and no clock to say right.
function groundedLead(intentId, facts) {
  const days = (Array.isArray(facts) ? facts : []).filter((f) => f && f.value
    && typeof f.value.weekday === 'string' && Number.isFinite(Number(f.value.peakScore)));
  if (!days.length) return null;
  if (intentId === 'money_move') {
    // A level week has no quiet day to name (the plan's note says so).
    if (days.some((f) => /projects level/.test(String(f.note || '')))) return null;
    const low = days.reduce((a, b) => (Number(b.value.peakScore) < Number(a.value.peakScore) ? b : a));
    return { text: `${low.value.weekday} projects as your quietest day this week.`, fact: low };
  }
  if (intentId === 'quiet_nights') {
    return { text: `${days[0].value.weekday} projects as your quietest day this week.`, fact: days[0] };
  }
  if (intentId === 'peak_hours') {
    const top = days.reduce((a, b) => (Number(b.value.peakScore) > Number(a.value.peakScore) ? b : a));
    return { text: `${top.value.weekday} projects as your busiest day this week.`, fact: top };
  }
  return null;
}

// "Another option: raise prices", not "Another option: Raise prices". A move
// that opens on a name or an acronym ("Google", "SMS") keeps its capital.
function lowerFirst(s) {
  return /^[A-Z][a-z]/.test(s) && !/^(?:I|Google|Instagram|TikTok|Facebook|Yelp)\b/.test(s)
    ? `${s.charAt(0).toLowerCase()}${s.slice(1)}`
    : s;
}

const SPEND_NUDGE = 'Add your typical spend per person in your venue settings and Roost will put a dollar figure on moves like this.';
const ANOTHER = 'Another option: ';

// The source every playbook answer carries. The chat names it in the sources
// line at the end (components/VenueAdvisorChat.js SOURCE_LABELS).
const PLAYBOOK_SOURCE = Object.freeze({ id: 'roost_playbook', source: 'roost_playbook', asOf: null });

function factSource(f) {
  return { id: f.sourceId || f.id, source: f.source, asOf: f.asOf };
}

// ── The calculator ───────────────────────────────────────────────────────────
//
// "How much would 10 more covers a week make me" is arithmetic on two
// numbers, one in the question and one in the owner's settings, and it should
// never wait on a model. Covers or guests or people, optionally per week,
// night, day or month. Tables count only with a party size ("3 more tables of
// 4"), because guessing the size of a party is inventing a number.
const MORE_COVERS = /\b(\d{1,4})\s+(?:more|extra|additional|new)\s+(covers?|guests?|customers?|people|diners?|heads?|tables?)(?:\s+of\s+(\d{1,2}))?(?:\s+(?:a|per|each|every)\s+(week|night|day|month))?/i;
// The rule of thumb behind "what is left after food": most rooms keep food
// cost near 30% of sales (the playbook's food cost tactic gives the range).
const TYPICAL_FOOD_COST = 0.3;
const ANNUAL = Object.freeze({ week: 52, month: 12 });
const CALC_NO_SPEND_POINT = 'Each extra cover brings in your average check, and at a typical food cost near 30%, about 70% of it is left after food.';

function coversIn(question) {
  const m = MORE_COVERS.exec(String(question || ''));
  if (!m) return null;
  let covers = Number(m[1]);
  if (/^tables?$/i.test(m[2])) {
    if (!m[3]) return null;
    covers *= Number(m[3]);
  }
  if (!(covers > 0)) return null;
  return { covers, per: (m[4] || 'week').toLowerCase() };
}

function calculatorAnswer(book, { question, ctx, venue, intentId }) {
  const asked = coversIn(question);
  if (!asked) return null;
  const spend = spendOf(ctx);
  const [move] = book.find(question, { intentId: intentId || 'quiet_nights', venue, limit: 1 });
  if (spend === null) {
    return {
      lead: `Add your typical spend per person in your venue settings and Roost will price ${asked.covers} more covers a ${asked.per} in dollars.`,
      points: [
        CALC_NO_SPEND_POINT,
        ...(move ? [move.move] : []),
      ],
      spendUsed: false,
      move,
    };
  }
  const gross = spend * asked.covers;
  const annual = ANNUAL[asked.per];
  const lead = annual
    ? `At your ${dollars(spend)} a head, ${asked.covers} more covers a ${asked.per} is ${dollars(gross)}, about ${dollars(gross * annual)} a year.`
    : `At your ${dollars(spend)} a head, ${asked.covers} more covers a ${asked.per} is ${dollars(gross)}.`;
  const kept = Math.round(gross * (1 - TYPICAL_FOOD_COST));
  return {
    lead,
    points: [
      `At a typical food cost near 30%, about ${dollars(kept)} of that ${dollars(gross)} is left after food.`,
      ...(move ? [move.move, move.watch] : []),
    ],
    spendUsed: true,
    move,
  };
}

/**
 * Answer one money question from the playbook, with no model call.
 * Returns null when no tactic clears the floor.
 * @returns {{mode: 'advice', text: string, sources: Array, tactics: string[], followUp: string|null}|null}
 */
function answerFrom(book, { question, intentId = null, ctx = null, groundedFacts = [] } = {}) {
  const venue = venueOf(ctx);
  const calc = calculatorAnswer(book, { question, ctx, venue, intentId });
  if (calc) {
    const sources = [{ ...PLAYBOOK_SOURCE }];
    if (calc.spendUsed) {
      const p = (ctx && ctx.profile) || {};
      sources.push({
        id: 'intake_typical_spend_per_person',
        source: 'intake',
        asOf: p.updated_at ? `owner-set ${String(p.updated_at).slice(0, 10)}` : 'owner-set',
      });
    }
    return {
      mode: 'advice',
      text: advisorAnswer.assemble({ structured: true, answer: [calc.lead], points: calc.points.slice(0, advisorAnswer.MAX_POINTS) }),
      sources,
      tactics: calc.move ? [calc.move.id] : [],
      topic: calc.move ? calc.move.topic : 'fill_slow_days',
      followUp: calc.move ? calc.move.follow_up || null : null,
    };
  }
  const picks = book.find(question, { intentId, venue, limit: 2 });
  if (!picks.length) return null;
  const [first, second] = picks;
  const spend = spendOf(ctx);
  const lead = groundedLead(intentId, groundedFacts);

  const points = [first.why];
  const money = moneyLine(first, spend);
  if (money) points.push(money);
  else if (first.example) points.push(first.example);
  points.push(first.watch);
  if (second && points.length < advisorAnswer.MAX_POINTS) points.push(`${ANOTHER}${lowerFirst(second.move)}`);
  if (!money && spend === null && (first.money === 'covers' || first.money === 'check')
      && points.length < advisorAnswer.MAX_POINTS) {
    points.push(SPEND_NUDGE);
  }

  const sources = [{ ...PLAYBOOK_SOURCE }];
  if (money) {
    const p = ctx.profile || {};
    sources.push({
      id: 'intake_typical_spend_per_person',
      source: 'intake',
      asOf: p.updated_at ? `owner-set ${String(p.updated_at).slice(0, 10)}` : 'owner-set',
    });
  }
  if (lead) sources.push(factSource(lead.fact));

  return {
    mode: 'advice',
    text: advisorAnswer.assemble({ structured: true, answer: [lead ? `${lead.text} ${first.move}` : first.move], points }),
    sources,
    tactics: picks.map((t) => t.id),
    topic: first.topic,
    followUp: first.follow_up || null,
  };
}

// ── The one move a chip answer ends on ──────────────────────────────────────
//
// The chips whose facts always raise the same kind of move. The template twin
// ends on this move (routes/advisor.js withMove), and the phrasing model is
// handed the same one to build on (advisorPhrasing.phrase), so a chip answers
// with one vetted move whichever of the two wrote it.
const { HOUR_ORDERING_MIN_GAP } = require('./crowdEngine');

const MOVE_INTENTS = Object.freeze(new Set([
  'money_move', 'peak_hours', 'quiet_nights', 'slow_night', 'tables_service', 'tables_free', 'last_night_verdict',
]));

/** True when the block's projected days sit inside the ordering floor. */
function isLevelWeek(block) {
  const scores = (block && Array.isArray(block.facts) ? block.facts : [])
    .filter((f) => f && f.value && Number.isFinite(Number(f.value.peakScore)))
    .map((f) => Number(f.value.peakScore));
  return scores.length < 2 || Math.max(...scores) - Math.min(...scores) < HOUR_ORDERING_MIN_GAP;
}

/**
 * The move a chip's answer ends on, or null. Yesterday's verdict raises one
 * only when the venue's own numbers call it a quiet day, and the money move
 * picks its topic by the week's shape.
 */
function moveFor(intentId, block, venue = null) {
  if (!MOVE_INTENTS.has(intentId)) return null;
  const facts = block && Array.isArray(block.facts) ? block.facts : [];
  if (intentId === 'last_night_verdict') {
    const verdict = facts.find((f) => f && /^last_day_verdict_/.test(String(f.id)));
    if (!verdict || !verdict.value || verdict.value.verdict !== 'below') return null;
  }
  const key = intentId === 'money_move' && isLevelWeek(block) ? 'money_move_level' : intentId;
  const [tactic] = BOOK.find('', { intentId: key, venue, limit: 1 });
  return tactic || null;
}

/**
 * The tactics to hand the advice model, as plain data. No ids, no sources:
 * the model is given moves to build on, never something to cite.
 */
function forPayload(tactics) {
  return tactics.map((t) => ({
    move: t.move,
    why: t.why,
    ...(t.example ? { example: t.example } : {}),
    watch: t.watch,
  }));
}

// The shipped playbook. Loaded once; a file that fails validation throws
// here, which fails every suite that requires this module.
// eslint-disable-next-line global-require
const BOOK = createPlaybook(require('./roostPlaybook.json'));

function find(question, opts) {
  return BOOK.find(question, opts);
}

function answer(opts) {
  return answerFrom(BOOK, opts);
}

// Every user-visible string this module can emit, for the standing design review.
function __copyStrings() {
  const out = [SPEND_NUDGE, ANOTHER.trim(), CALC_NO_SPEND_POINT];
  for (const t of BOOK.tactics) {
    out.push(t.move, t.why, t.watch);
    if (t.example) out.push(t.example);
    if (t.follow_up) out.push(t.follow_up);
  }
  return out;
}

module.exports = {
  TOPICS,
  TOPIC_WORDS,
  VENUE_KINDS,
  MONEY_KINDS,
  INTENT_TOPICS,
  PLAYBOOK_SOURCE,
  SPEND_NUDGE,
  tactics: BOOK.tactics,
  find,
  answer,
  answerFrom,
  createPlaybook,
  validateTactic,
  venueOf,
  spendOf,
  moneyLine,
  groundedLead,
  coversIn,
  dollars,
  MOVE_INTENTS,
  isLevelWeek,
  moveFor,
  forPayload,
  stem,
  stems,
  __copyStrings,
};
