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
const { normalizeOwnerText } = require('./ownerWords');
const { dayWords } = require('./roostDayReader');

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
  fill_slow_days: ['slow', 'slower', 'slowest', 'quiet', 'quieter', 'quietest', 'dead', 'empty', 'fill', 'midweek', 'monday', 'tuesday', 'wednesday', 'thursday', 'sunday', 'weekday', 'traffic', 'busier', 'weeknight', 'weeknights', 'nobody'],
  handle_the_rush: ['rush', 'busiest', 'peak', 'slammed', 'weeds', 'queue', 'swamped', 'overwhelmed', 'backed', 'line', 'forever', 'tickets'],
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
  marketing: ['marketing', 'market', 'advertise', 'advertising', 'instagram', 'social', 'tiktok', 'facebook', 'google', 'promote', 'promotion', 'email', 'newsletter', 'listing', 'followers', 'compete', 'competition', 'competitor', 'competitors', 'students', 'student', 'college', 'tourists', 'visibility'],
  reviews: ['review', 'reviews', 'rating', 'ratings', 'yelp', 'stars', 'complaint', 'complaints', 'feedback'],
  events: ['event', 'events', 'trivia', 'music', 'live', 'private', 'party', 'parties', 'holiday', 'tasting', 'class', 'classes', 'halloween', 'christmas', 'thanksgiving', 'valentines', 'easter', 'superbowl'],
  takeout_delivery: ['delivery', 'deliveries', 'takeout', 'togo', 'pickup', 'doordash', 'ubereats', 'grubhub', 'apps', 'commission', 'packaging'],
  beverage: ['drink', 'drinks', 'beer', 'wine', 'cocktail', 'cocktails', 'coffee', 'liquor', 'pour', 'spirits', 'happy'],
  dayparts: ['breakfast', 'brunch', 'lunch', 'dinner', 'late', 'morning', 'mornings', 'afternoon', 'afternoons', 'evening', 'evenings', 'daypart', 'opening', 'catering'],
  weather_season: ['weather', 'rain', 'rainy', 'snow', 'cold', 'hot', 'heat', 'summer', 'winter', 'season', 'seasonal', 'patio'],
  hospitality: ['hospitality', 'service', 'welcome', 'greet', 'experience', 'friendly', 'warm', 'apology', 'mistake', 'families', 'family', 'kids', 'children'],
  costs: ['costs', 'expenses', 'rent', 'utilities', 'energy', 'fees', 'overhead', 'bills', 'savings', 'profit', 'profitable', 'cash', 'losing', 'under', 'lost', 'flow', 'tight', 'struggling'],
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

// ── Two senses of one word ───────────────────────────────────────────────────
//
// "TUESDAYS ARE SLOW" IS TRAFFIC; "THE SERVICE IS SLOW" IS SPEED. The second
// was answered with a slow-day move ("reviews say the service is slow", 2026-10-28
// stress test). A speed complaint is taken out of the traffic words, so "slow"
// stops leaning toward empty rooms, and the phrase the speed moves are cued on
// goes in its place. "Lunch service is slow" names a meal, so it stays traffic.
const SPEED_OF = Object.freeze({
  service: 'slow service', server: 'slow service', servers: 'slow service', staff: 'slow service',
  waiter: 'slow service', waiters: 'slow service', waitress: 'slow service', waitresses: 'slow service',
  waitstaff: 'slow service',
  food: 'slow kitchen', kitchen: 'slow kitchen', ticket: 'slow kitchen', tickets: 'slow kitchen',
  cook: 'slow kitchen', cooks: 'slow kitchen',
  line: 'slow counter', counter: 'slow counter', checkout: 'slow counter', register: 'slow counter',
  queue: 'slow counter',
  drink: 'drinks slow', drinks: 'drinks slow', bartender: 'drinks slow', bartenders: 'drinks slow',
  barista: 'drinks slow', baristas: 'drinks slow',
  payment: 'slow payment', payments: 'slow payment',
});
const SPEED_NOUNS = Object.keys(SPEED_OF).join('|');
const SPEED = new RegExp(`\\b(${SPEED_NOUNS})\\s+(?:is|are|was|were|has\\s+been|have\\s+been|been|gets?|got|seems?|feels?|felt|comes?\\s+out|came\\s+out|goes|moves?|moving|runs?|running)\\s+(?:so\\s+|too\\s+|really\\s+|super\\s+|very\\s+|kinda\\s+|kind\\s+of\\s+|a\\s+bit\\s+|a\\s+little\\s+|pretty\\s+|way\\s+too\\s+|painfully\\s+|extremely\\s+|incredibly\\s+)?slow(?:ly)?\\b|\\bslow\\s+(${SPEED_NOUNS})\\b`, 'g');
const MEAL_BEFORE = /\b(?:breakfast|brunch|lunch|dinner|supper|weekday|weeknight|evening|morning|night|late|weekend|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+$/;
const FOREVER = /\b(?:takes?|taking|took)\s+(?:forever|ages|too\s+long|so\s+long|way\s+too\s+long)\b/;
const SPEED_NOUN_IN = new RegExp(`\\b(${SPEED_NOUNS})\\b`);

// "DEAD ON MONDAYS" IS A SLOW DAY; "EMPTY UNTIL 3" IS A SLOW STRETCH INSIDE ONE.
// A coffee shop "packed until 10 then empty until 3" was told to give its slowest
// day a weekly reason to visit. A dead stretch in the middle of the day leans
// to the dayparts moves (an afternoon offer, staffing the lull) instead.
const DEAD = '(?:dead|slow|quiet|empty|nobody|no\\s+one|crickets)';
const MIDDAY = '(?:noon|midday|lunch|(?:12|[1-5])(?::[0-5]\\d)?\\s*(?:pm|p\\.m\\.)?)';
const LULL = new RegExp([
  `\\b${DEAD}\\b[^.?!]{0,40}\\b(?:until|till|til|after|from|between|to)\\s+${MIDDAY}(?![\\d:])`,
  `\\b(?:after|until|till|til|between|from)\\s+${MIDDAY}(?![\\d:])[^.?!]{0,30}\\b${DEAD}\\b`,
  `\\b(?:midday|mid-day|middle\\s+of\\s+the\\s+day|mid\\s*afternoons?|afternoons?|between\\s+lunch\\s+and\\s+dinner)\\b[^.?!]{0,20}\\b(?:${DEAD}|lull|slump)\\b`,
  `\\b${DEAD}\\s+(?:in\\s+the\\s+)?(?:afternoons?|midday|mid-day)\\b`,
].join('|'));
const LULL_TOPICS = Object.freeze(['dayparts', 'labor']);
// "More people in the afternoon" asks to fill a part of the day, not a day.
// The growth words would find the slow-day move on their own ("more people
// in" is its cue), so they come out and the part of the day's own phrase goes
// in. Dinner and evenings are most rooms' main service, so they stay slow-day.
const DAYPART_GROWTH = /\b(more\s+(?:people|customers|guests|traffic|sales|business)(?:\s+in)?|busier|fill(?:ing)?|bring(?:ing)?\s+(?:people\s+|guests\s+)?in|get(?:ting)?\s+(?:people\s+|guests\s+)?in)\b([^.?!]{0,25}\b)(mornings?|afternoons?|midday|mid-day|lunch(?:time)?|breakfast|brunch)\b/;
const DAYPART_PHRASE = Object.freeze({
  morning: 'morning sales', mornings: 'morning sales', breakfast: 'morning sales', brunch: 'brunch menu',
  afternoon: 'afternoon lull', afternoons: 'afternoon lull', midday: 'afternoon lull', 'mid-day': 'afternoon lull',
  lunch: 'lunch crowd', lunchtime: 'lunch crowd',
});
const DAYPART_TOPICS = Object.freeze(['dayparts', 'fill_slow_days']);
// "GET PEOPLE IN BEFORE 7PM" ASKS FOR AN EARLIER CROWD (2026-11-03). The
// router sent it to peak hours, and every venue was answered with the rush
// moves and offered "How do I set prep pars?" next: no word of it named the
// early evening that the happy hour and early arrival moves are cued on. A
// growth word with an evening hour, dinner or the rush after "before" or "by",
// or "early in the evening", is read as that ask, and ranked() says it in the
// cues of the draw that fits the room: a club fills early with an early
// arrival offer at the door, every other room with a happy hour style draw.
// "Before 7 AM" is a morning and is left alone.
const EARLY_EVENING = new RegExp([
  "\\b(?:get(?:ting)?|bring(?:ing)?|draw(?:ing)?|pull(?:ing)?|fill(?:ing)?|pack(?:ing)?|attract(?:ing)?|more)\\b[^.?!]{0,30}?\\b(?:before|by)\\s+(?:[5-8](?::[0-5]\\d)?(?:\\s*(?:pm|p\\.m\\.|o'?clock))?(?![\\d:]|\\s*(?:am|a\\.m\\.))|dinner(?:\\s+rush)?|the\\s+(?:dinner\\s+)?rush)\\b",
  '\\bearl(?:y|ier)\\s+(?:in\\s+the\\s+)?(?:evenings?|nights?)\\b',
].join('|'));
// Only a draw written for this kind of room: the phrase is ours, not the
// owner's, so it must never be what lets another kind's move in (review,
// 2026-11-03: a bakery and a counter shop were led to the happy hour move,
// which nobody named). A room with no early evening draw of its own gets none.
function earlyEveningPhrase(venue, compiled) {
  const order = venue && venue.kind === 'club' ? ['early crowd', 'early evening'] : ['early evening', 'early crowd'];
  return order.find((phrase) => {
    const cue = stems(phrase).join(' ');
    return compiled.some((t) => forThisKind(t, venue) && t.cueStems.some((c) => c.join(' ') === cue));
  }) || null;
}

/**
 * The question with its speed complaints taken out of the traffic words.
 * @param {string} text normalized owner text (ownerWords.normalizeOwnerText)
 * @returns {{text: string, speed: string[], phrases: string[], lull: boolean, daypart: boolean}}
 */
function trafficView(text) {
  const speed = [];
  let traffic = String(text || '').replace(SPEED, (m, a, b, offset, whole) => {
    const noun = a || b;
    if (noun === 'service' && MEAL_BEFORE.test(whole.slice(0, offset))) return m;
    speed.push(SPEED_OF[noun]);
    return ' ';
  });
  if (FOREVER.test(traffic)) {
    const noun = SPEED_NOUN_IN.exec(traffic);
    speed.push(noun ? SPEED_OF[noun[1]] : 'slow service');
  }
  const lull = LULL.test(traffic);
  const phrases = [...new Set(speed)];
  if (lull) phrases.push('afternoon lull');
  const growth = DAYPART_GROWTH.exec(traffic);
  if (growth) {
    traffic = traffic.replace(growth[0], ` ${growth[2]}${growth[3]}`);
    phrases.push(DAYPART_PHRASE[growth[3]]);
  }
  return {
    text: traffic, speed: [...new Set(speed)], phrases: [...new Set(phrases)], lull, daypart: lull || Boolean(growth),
    earlyEvening: EARLY_EVENING.test(traffic),
  };
}

// ── What the owner already ruled out ────────────────────────────────────────
//
// "WE TRIED A HAPPY HOUR AND IT DIDN'T WORK, WHAT SHOULD WE DO" was answered
// with a happy hour (2026-10-28 stress test): the one move the owner had just
// crossed off. The words after "tried", before "didn't work", or after
// "already do" when the owner asks for something else, name a move that is off
// the table. Any tactic cued inside them is set aside, and the words stop
// leaning the question toward their topic. "How do we make it work" keeps the
// subject: then the tried move is what the owner is asking about.
const CLAUSE_END = new Set(['.', '!', '?', ';', ':']);
const MEANS = new Set(['with', 'by', 'using', 'through', 'via']);
const LIST_JOIN = new Set([',', 'and', 'or']);
const SPAN_STOP = new Set([
  ',', 'and', 'or', 'but', 'so', 'because', 'cause', 'since', 'though', 'although', 'while', 'then', 'it',
  'that', 'which', 'who', 'nothing', 'what', 'how', 'should', 'could', 'would', 'can', 'now', 'still', 'yet',
  'last', 'this', 'these', 'those', 'every', 'each', 'on', 'in', 'at', 'during', 'for', 'to', 'from', 'over',
  'about', 'after', 'before', 'until', 'till', 'when', 'if', 'we', 'i', 'they', 'you', 'nobody', 'no', 'never',
  'did', 'didnt', "didn't", 'does', 'doesnt', "doesn't", 'was', 'were', 'is', 'are', 'has', 'have', 'had',
  'but', 'people', 'guests', 'customers', 'anyone', 'anybody', 'everyone', 'everybody',
  // A please or thanks ends what is refused: "No happy hour please help me get
  // people in" refuses the happy hour, not getting people in (re-check of the
  // third round, 2026-11-03).
  'please', 'pls', 'plz', 'thanks', 'thank',
]);
const PRONOUN = new Set(['it', 'that', 'they', 'this', 'those', 'these', 'which', 'everything', 'nothing', 'all']);
const GOAL = /^(?:fill|filling|get|getting|bring|bringing|make|making|attract|attracting|increase|increasing|boost|boosting|grow|growing|drive|driving|draw|drawing|pull|pulling|build|building|cut|cutting|lower|lowering|reduce|reducing|keep|keeping|save|saving|fix|fixing)$/;
const PIVOT = new Set([
  'did', 'do', 'done', 'doing', 'ran', 'run', 'running', 'had', 'have', 'tried', 'trying', 'offered', 'offer',
  'offering', 'added', 'adding', 'started', 'starting', 'launched', 'used', 'using', 'put', 'gave', 'tested',
  'introduced', 'with', 'by',
]);
const EXISTING = new Set(['do', 'did', 'done', 'have', 'had', 'run', 'ran', 'offer', 'offered', 'use', 'used', 'got', 'host', 'hosted']);
const FAILED = /\b(?:did\s*n'?t|did\s+not|does\s*n'?t|does\s+not|do\s*n'?t|never|wo\s*n'?t|would\s*n'?t|would\s+not|will\s+not|is\s*n'?t|was\s*n'?t|was\s+not)\s+(?:really\s+|even\s+|actually\s+|ever\s+)?(?:work(?:ed|ing|s)?|help(?:ed|s)?|do\s+(?:anything|much|a\s+thing)|move\s+the\s+needle|pay\s+off)\b|\b(?:flopped|failed|bombed|fizzled|tanked|went\s+nowhere|was\s+a\s+(?:flop|bust|waste|failure|disaster|dud)|nobody\s+came|no\s+one\s+came)\b/g;
const ELSE = /\b(?:else|other|another|besides|beyond|instead|alternatives?|different)\b/;
const KEEP_SUBJECT = /\b(?:make|making|get|getting)\s+(?:it|them|that|this)\s+(?:to\s+)?(?:work|better|busier|popular|going|stick|pay\s+off)\b|\b(?:improve|fix|tweak|change|adjust|promote|market|price|reprice|time|run|restart|relaunch|rework|revive|save)\s+(?:it|them|that|this)\b|\bmore\s+people\s+to\s+(?:come|use|join|show|sign)\b/;
const TOKEN = /[a-z0-9']+|[.,!?;:]/g;
const SPAN_MAX = 12;

function takeSpan(tokens, start) {
  const out = [];
  let i = start;
  while (i < tokens.length && out.length < SPAN_MAX) {
    const w = tokens[i];
    if (CLAUSE_END.has(w) || MEANS.has(w)) break;
    if (LIST_JOIN.has(w)) {
      // A list keeps going ("discounts, trivia and a happy hour"); a new
      // clause ("and it didn't work") ends it.
      const next = tokens[i + 1];
      if (!next || CLAUSE_END.has(next) || SPAN_STOP.has(next) || LIST_JOIN.has(next)) break;
      i += 1;
    } else if (SPAN_STOP.has(w)) {
      break;
    } else {
      out.push(w);
      i += 1;
    }
  }
  return { words: out, end: i };
}

// The move named from `start`. A goal ("tried to fill Tuesdays") is not a
// move; the move is what the goal was tried with.
function moveFrom(tokens, start) {
  const { words: span, end } = takeSpan(tokens, start);
  if (!span.length || !GOAL.test(span[0])) return span;
  for (let j = end; j < tokens.length && !CLAUSE_END.has(tokens[j]); j += 1) {
    if (MEANS.has(tokens[j])) return takeSpan(tokens, j + 1).words;
  }
  return [];
}

// WHAT THE OWNER WILL NOT DO IS RULED OUT TOO. "I don't want to discount, how
// do I fill Tuesdays" led with the discount move, and so did "without
// discounting" and "besides discounts" (2026-10-28 probe). Returns where the
// refused move starts, or null. A constraint is not a move: "without losing
// regulars" and "don't have enough staff" name what to avoid or lack, so
// "without" needs a move after it and "don't" needs a verb of doing.
const REFUSE_VERB = new Set(['do', 'run', 'offer', 'use', 'try', 'add', 'give', 'start', 'doing', 'running', 'offering', 'using', 'trying', 'adding', 'giving', 'starting', 'go']);
const MOVE_VERB = /^(?:discount|discounting|advertise|advertising|deliver|delivering|cater|catering)$/;
const OUTCOME = /^(?:losing|lose|hurting|hurt|killing|kill|scaring|upsetting|annoying|alienating|spending|breaking|going|making|getting|having|being|looking|seeming|feeling|raising|cutting|paying|wasting|giving)$/;
const PAIRS = Object.freeze({ other: 'than', instead: 'of', rather: 'than', apart: 'from' });
// Who refuses matters: "my staff refuse to upsell" is a staffing problem, not
// the owner ruling upselling out (2026-10-28 second review).
const OWNER = new Set(['i', 'we', "we're", 'were', "i'm", 'im']);
function refusedFrom(tokens, i, asksElse) {
  const w = tokens[i];
  const next = tokens[i + 1];
  const before = tokens[i - 1];
  if (w === 'without' || w === 'besides' || w === 'except') {
    if (!next || OUTCOME.test(next)) return null;
    // A limit, not a move: "without more staff", "without hiring", "without
    // our regulars noticing" (2026-10-28 second review's probe).
    if (w === 'without' && LIMIT_START.test(next)) return null;
    for (let k = i + 1; k < Math.min(tokens.length, i + 6); k += 1) {
      if (NOTICING.test(tokens[k])) return null;
      if (CLAUSE_END.has(tokens[k]) || tokens[k] === ',') break;
    }
    return i + 1;
  }
  if (PAIRS[w] && next === PAIRS[w]) return tokens[i + 2] && !OUTCOME.test(tokens[i + 2]) ? i + 2 : null;
  // "but not with a happy hour" refuses; "we're not with doordash, should we
  // sign up?" says where things stand.
  if (w === 'not' && next === 'with') return (before === 'but' || before === ',') && tokens[i + 2] ? i + 2 : null;
  if (w === 'refuse' && next === 'to') {
    if (!OWNER.has(before)) return null;
    return REFUSE_VERB.has(tokens[i + 2]) ? i + 3 : i + 2;
  }
  // "but no discounts", "with no discounts" refuse anywhere; a bare "no X"
  // opening a clause refuses only when the owner asks for something else
  // ("no happy hour, what else"), since "no regulars anymore" is a complaint.
  // "No problem", "no worries" and "no rush" refuse nothing (re-check of the
  // third round, 2026-11-03: "No problem, please help me fill Tuesdays" ruled
  // out every move for Tuesdays), standing alone before a comma, the clause's
  // end or a please; "no rush pricing" and "no rush hour discounts" still do.
  const interjection = NO_INTERJECTION.has(next)
    && (i + 2 >= tokens.length || tokens[i + 2] === ',' || CLAUSE_END.has(tokens[i + 2]) || POLITE.has(tokens[i + 2]));
  if (w === 'no' && next && !SPAN_STOP.has(next) && !interjection) {
    if (before === 'but' || before === 'with') return i + 1;
    // "No happy hour please" refuses too, the way "no happy hour, what else"
    // does: a please or thanks before the clause ends (review, 2026-11-03).
    if ((i === 0 || before === ',') && (asksElse || politeUntilClauseEnd(tokens, i + 1))) return i + 1;
    return null;
  }
  let at = null;
  if (w === 'dont' || w === "don't" || w === 'wont' || w === "won't" || w === 'never'
      || w === 'cant' || w === "can't" || w === 'cannot') at = i + 1;
  else if ((w === 'do' || w === 'will' || w === 'can') && next === 'not') at = i + 2;
  else if (w === 'not' && (next === 'going' || REFUSE_VERB.has(next))) at = i + 1;
  if (at === null) return null;
  if (['want', 'wanna', 'plan', 'like', 'going'].includes(tokens[at])) at += 1;
  if (tokens[at] === 'to') at += 1;
  let from = null;
  if (REFUSE_VERB.has(tokens[at])) from = at + 1;
  else if (MOVE_VERB.test(tokens[at] || '')) from = at;
  if (from === null) return null;
  // "We don't offer delivery YET" is a move not made so far, and usually the
  // one being asked about; "we don't start brunch UNTIL 10" is a schedule.
  // Neither rules the move out.
  for (let k = from; k < Math.min(tokens.length, from + 6); k += 1) {
    if (NOT_YET.has(tokens[k])) return null;
    if (CLAUSE_END.has(tokens[k]) || tokens[k] === ',') break;
  }
  return from;
}
const NOT_YET = new Set(['yet', 'until', 'till', 'til', 'before', 'after']);
const POLITE = new Set(['please', 'pls', 'plz', 'thanks', 'thank']);
const NO_INTERJECTION = new Set(['problem', 'problems', 'worries', 'worry', 'rush', 'pressure', 'idea', 'doubt', 'kidding', 'offense', 'offence', 'way', 'thanks', 'biggie', 'sweat', 'stress']);
function politeUntilClauseEnd(tokens, from) {
  for (let k = from; k < tokens.length && k < from + 8; k += 1) {
    if (CLAUSE_END.has(tokens[k]) || tokens[k] === ',') return POLITE.has(tokens[k + 1] || '');
    if (POLITE.has(tokens[k])) return true;
  }
  return false;
}
const LIMIT_START = /^(?:more|extra|additional|much|any|big|new|hiring|adding|spending|paying|raising|a\s+big)$/;
const NOTICING = /^(?:noticing|complaining|knowing|minding|leaving|caring|realizing|seeing)$/;

// What failed, read backward from "didn't work": the clause right before it,
// or, when that is only "it", what the clause before that did or ran.
function failedBefore(before) {
  const tokens = before.match(TOKEN) || [];
  const clauses = [[]];
  for (const w of tokens) {
    if (w === ',' || w === 'and' || w === 'but' || w === 'so' || w === 'which') clauses.push([]);
    else clauses[clauses.length - 1].push(w);
  }
  const last = clauses[clauses.length - 1];
  const content = last.filter((w) => !PRONOUN.has(w));
  if (content.length) return moveFrom(content, 0);
  const prev = clauses[clauses.length - 2] || [];
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (PIVOT.has(prev[i])) return moveFrom(prev, i + 1);
  }
  return prev.slice(-4).filter((w) => !SPAN_STOP.has(w));
}

/**
 * The moves the owner ruled out, as word lists, and the question without them.
 * @param {string} text normalized owner text
 * @returns {{spans: string[][], text: string}}
 */
function ruledOut(text) {
  const source = String(text || '');
  if (KEEP_SUBJECT.test(source)) return { spans: [], text: source };
  const asksElse = ELSE.test(source);
  const spans = [];
  for (const sentence of source.split(/[.!?;\n]+/)) {
    const tokens = sentence.match(TOKEN) || [];
    tokens.forEach((w, i) => {
      if (w === 'tried' || w === 'tested') {
        spans.push(moveFrom(tokens, i + (tokens[i + 1] === 'to' ? 2 : 1)));
      } else if (w === 'already' && EXISTING.has(tokens[i + 1]) && asksElse) {
        spans.push(moveFrom(tokens, i + 2));
      } else {
        const after = refusedFrom(tokens, i, asksElse);
        if (after !== null) spans.push(moveFrom(tokens, after));
      }
    });
    FAILED.lastIndex = 0;
    let m = FAILED.exec(sentence);
    while (m) {
      spans.push(failedBefore(sentence.slice(0, m.index)));
      m = FAILED.exec(sentence);
    }
  }
  const named = spans.filter((s) => s.some((w) => !STOP.has(stem(w))));
  // Each named span is blanked where it sits, found by walking the words:
  // its words in order, at most 2 other words apart (a list's "and"). Nothing
  // is compiled from owner text. A RegExp built from the span used to do
  // this, and a crafted 279 character question held the server for 1.4 s on
  // its backtracking (2026-10-28 review).
  const words = [...source.matchAll(/[a-z0-9']+/g)];
  const used = new Set();
  const ranges = [];
  for (const span of named) {
    const hit = locateSpan(words, span, used);
    if (!hit) continue;
    for (let k = hit[0]; k <= hit[1]; k += 1) used.add(k);
    ranges.push([words[hit[0]].index, words[hit[1]].index + words[hit[1]][0].length]);
  }
  ranges.sort((a, z) => a[0] - z[0]);
  let rest = '';
  let at = 0;
  for (const [from, to] of ranges) {
    if (from < at) continue;
    rest += `${source.slice(at, from)} `;
    at = to;
  }
  rest += source.slice(at);
  return { spans: named, text: rest };
}

// Where a span's words sit among the question's words: [first, last] word
// index, each next span word within 3 words of the one before, or null.
function locateSpan(words, span, used) {
  for (let s = 0; s < words.length; s += 1) {
    if (used.has(s) || words[s][0] !== span[0]) continue;
    let at = s;
    let ok = true;
    for (let k = 1; k < span.length && ok; k += 1) {
      ok = false;
      for (let j = at + 1; j <= at + 3 && j < words.length; j += 1) {
        if (words[j][0] === span[k]) { at = j; ok = true; break; }
      }
    }
    if (ok) return [s, at];
  }
  return null;
}

/**
 * Everything retrieval needs from the owner's question, read once.
 * @returns {{qStems: string[], qSet: Set<string>, ruled: string[][], lull: boolean, drinks: boolean}}
 */
function readQuestion(question) {
  const out = ruledOut(normalizeOwnerText(String(question || '')));
  const view = trafficView(out.text);
  const base = stems(view.text);
  const qStems = [...base];
  const extra = [];
  for (const phrase of view.phrases) {
    const run = stems(phrase);
    // The sentinel keeps an added phrase from joining the words before it,
    // and "slow" from a speed phrase never leans toward empty rooms.
    qStems.push('|', ...run);
    extra.push(...run.filter((w) => w !== 'slow'));
  }
  return {
    qStems,
    qSet: new Set([...base, ...extra].filter((w) => !STOP.has(w))),
    ruled: out.spans.map((s) => stems(s.join(' '))),
    lull: view.lull,
    daypart: view.daypart,
    earlyEvening: view.earlyEvening,
    drinks: DRINK_WORDS.test(view.text),
  };
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
// A static index (word stem -> its topics), built once from the constants
// above and frozen. Not a cache: nothing a caller sends ever writes to it.
const TOPIC_OF_WORD = Object.freeze(Object.entries(TOPIC_WORDS).reduce((index, [topic, list]) => {
  for (const w of list) {
    const key = stem(w);
    index[key] = index[key] ? [...new Set([...index[key], topic])] : [topic];
  }
  return index;
}, Object.create(null)));

function topicLean(qSet) {
  const hits = new Map();
  for (const w of qSet) {
    for (const topic of TOPIC_OF_WORD[w] || []) hits.set(topic, (hits.get(topic) || 0) + 1);
  }
  return hits;
}

// The score, and how much of it the owner's own words earned (`cues`), which
// answerFrom reads to decide whether a runner-up is worth an "Another option".
function score(t, qStems, qSet, topics, venue, lean) {
  let cues = 0;
  // Whether a cue of more than one word was found in the owner's words: the
  // owner named this move, not just its subject (ranked, below).
  let phrase = false;
  t.cueStems.forEach((cue, i) => {
    const hit = cue.length === 1 ? qSet.has(cue[0]) : containsRun(qStems, cue);
    if (!hit) return;
    cues += t.cueWeights[i];
    if (cue.length > 1) phrase = true;
  });
  const ownKind = forThisKind(t, venue);
  if (!ownKind && cues < NAMED_MIN) return { s: 0, cues, phrase, routed: 0 };
  let s = cues + Math.min(TOPIC_WORD_CAP, (lean.get(t.topic) || 0) * TOPIC_WORD_WEIGHT);
  const routed = topics[0] === t.topic ? 1.5 : topics[1] === t.topic ? 1 : 0;
  s += routed;
  if (s === 0) return { s: 0, cues, phrase, routed };
  let shared = 0;
  for (const w of qSet) if (t.textStems.has(w)) shared += 1;
  s += Math.min(TEXT_CAP, shared * TEXT_WEIGHT);
  if (!ownKind) s -= OTHER_KIND_PENALTY;
  // The venue tiebreak only separates moves the owner's words found. On a
  // topic alone ("how do I make more money"), it put a move written for one
  // kind of venue ahead of the topic's general lead, so it waits for a cue.
  else if (cues > 0 && venue && venue.kind && t.venues.includes(venue.kind)) s += 0.25;
  return { s, cues, phrase, routed };
}

// A MOVE THE OWNER'S WORDS NAME OUTRANKS ONE THAT ONLY SHARES THE ROUTED
// TOPIC (2026-11-03). The routed topic's lean is how a question no cue phrase
// matches still lands on its subject ("when do we peak" on the rush moves).
// It was also outscoring the moves the owner's words did name: "how do I get
// people in before 7pm", routed to peak hours, led with the prep pars move
// (1.5 for the topic and nothing from the words) ahead of the early evening
// and the "get people in" moves, at every venue. When a phrase of the owner's
// matches a move written for this kind of room, no move that only shares the
// routed topic (no cue of the owner's at all) is ranked above it: those keep
// their order among themselves and follow it, so the named move leads the
// answer and its follow-up is the one offered. A move another kind of room
// was written for changes nothing: a bar asking to turn tables faster keeps
// its own staffing moves and a follow-up written for a bar. A question no
// phrase matches is ranked exactly as before.
function wordsOverRoute(scored, venue) {
  const named = scored.filter((x) => x.phrase && x.s >= MIN_SCORE && forThisKind(x.t, venue));
  if (!named.length) return scored;
  const floor = Math.min(...named.map((x) => x.s));
  const routedOnly = (x) => x.cues === 0 && x.routed > 0 && x.s >= floor;
  const highest = Math.max(floor, ...scored.filter(routedOnly).map((x) => x.s));
  return scored.map((x) => (routedOnly(x) ? { ...x, s: floor - 0.001 - (highest - x.s) * 1e-6 } : x));
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
   * The best tactics for a question with their scores, best first.
   * @param {string} question
   * @param {{intentId?: string|null, venue?: {kind: string|null, alcohol: boolean}, limit?: number, exclude?: string[]}} opts
   * @returns {Array<{t: object, s: number, cues: number}>}
   */
  function ranked(question, { intentId = null, venue = null, limit = 3, exclude = [] } = {}) {
    const q = readQuestion(question);
    const ruled = new Set(q.ruled.length
      ? compiled.filter((t) => t.cueStems.some((c) => q.ruled.some((span) => containsRun(span, c)))).map((t) => t.id)
      : []);
    let topics = INTENT_TOPICS[intentId] || [];
    // A dead stretch inside the day is a dayparts question, and so is filling
    // one part of the day, unless the route already named something other
    // than a slow day.
    if (q.daypart && (!topics.length || topics[0] === 'fill_slow_days')) topics = q.lull ? LULL_TOPICS : DAYPART_TOPICS;
    const lean = topicLean(q.qSet);
    // An early evening asked for, in the cues of the draw that fits the room.
    const early = q.earlyEvening ? earlyEveningPhrase(venue, compiled) : null;
    const qStems = early ? [...q.qStems, '|', ...stems(early)] : q.qStems;
    const qSet = early ? new Set([...q.qSet, ...stems(early).filter((w) => !STOP.has(w))]) : q.qSet;
    const rank = (onTopics) => wordsOverRoute(compiled
      .filter((t) => !exclude.includes(t.id) && !ruled.has(t.id) && fits(t, venue, q.drinks))
      .map((t) => ({ t, ...score(t, qStems, qSet, onTopics, venue, lean) })), venue)
      .filter(({ s }) => s >= MIN_SCORE)
      .sort((a, b) => (b.s - a.s) || (a.t.order - b.t.order))
      .slice(0, limit);
    const picks = rank(topics);
    if (picks.length || !ruled.size || topics.length) return picks;
    // All the owner named was the move they ruled out ("we tried a happy hour
    // and it didn't work"): another move from the same topic.
    const crossedOff = compiled.find((t) => ruled.has(t.id));
    return rank([crossedOff.topic]);
  }

  /** The best tactics for a question, best first. Same options as ranked(). */
  function find(question, opts) {
    return ranked(question, opts).map(({ t }) => t);
  }

  return { tactics: compiled, byId, find, ranked };
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

// THE DAY A QUESTION ASKS ABOUT (2026-11-06): roostDayReader
// reads the day words where the question asks, by a small grammar, and a
// short form ("Fri night", "next sat", "Sun?") only where it is written as a
// day, never where it is the word ("we sat 40 covers"). One word is
// { weekday, next, nextWeek?, afterNext? }, { today }, { tomorrow } or
// { dayAfterTomorrow }; two or more are { several } (the route reads them
// against the venue's own today and answers both, routes/advisor.js
// bothAnswer); a weekend or the week alone, or none, is null. "Saturdays are
// packed, how do I fill Tuesdays?" asks in its own clause, about Tuesday
// (2026-10-28 second review).
function askedDay(question) {
  const words = dayWords(question);
  if (words.length > 1) return { several: words };
  const [w] = words;
  if (!w) return null;
  if (w.kind === 'weekday') {
    return { weekday: w.weekday, next: w.next, ...(w.nextWeek ? { nextWeek: true } : {}), ...(w.afterNext ? { afterNext: true } : {}) };
  }
  if (w.kind === 'today') return { today: true };
  if (w.kind === 'tomorrow') return { tomorrow: true };
  return w.kind === 'dayAfterTomorrow' ? { dayAfterTomorrow: true } : null;
}

function namedWeekday(question) {
  const asked = askedDay(question);
  return asked && asked.weekday ? asked.weekday : null;
}

// "9 PM", and "midnight" and "noon" on the hour (services/clockWords.js).
const { spokenClock: clockHour } = require('./clockWords');
const {
  KIND_FORECAST, isKindForecast, unownDays, isBesideWeek,
} = require('./kindForecast');

// `askedFor`, when the route has read the question against the venue's own
// today (routes/advisor.js readingFor), is the weekday it asks about, or null
// for a day no fact can stand for ("next Monday" asked on a Monday); left out,
// the question's own named day is read.
function groundedLead(intentId, facts, question = '', askedFor = undefined) {
  // A day past the week ahead has no line here. "How do I fill next Monday?"
  // on a Monday used to open on the week's quietest day, Sunday, an answer
  // about a day the owner did not ask about (review, 2026-11-06).
  if (askedFor === null) return null;
  const peaks = (Array.isArray(facts) ? facts : []).filter((f) => f && f.value
    && typeof f.value.weekday === 'string' && Number.isFinite(Number(f.value.peakScore)));
  if (!peaks.length) return null;
  // Today's entry handed beside a no-history venue's card for a question
  // about today's weekday (routes/advisor.js withNamedToday) answers that
  // question and is never ranked with the week's days: the card's week starts
  // tomorrow, and its quietest day is the one the money move names
  // (services/kindForecast.js besideWeek).
  const days = peaks.filter((f) => !isBesideWeek(f));
  // Flock's forecast for places like this venue, for a venue with no crowd
  // history of its own, says so first and never says "your" day
  // (services/kindForecast.js); the venue's own forecast reads as it did.
  const kind = peaks.some(isKindForecast);
  const open = (s) => (kind ? `In ${KIND_FORECAST}, ${s}` : s);
  const your = kind ? 'the' : 'your';
  // TWO DAYS OR MORE, EACH SAID, NONE PICKED (acceptance, 2026-11-06). The
  // route hands the days a question names (routes/advisor.js, the advice
  // path): "how many bartenders for fri and sat" opens on each day's own
  // peak, in the order asked. One with no forecast is left out; one left is
  // said as a single named day is.
  if (Array.isArray(askedFor)) {
    const said = [];
    for (const w of askedFor) {
      const f = peaks.find((p) => p.value.weekday === w);
      if (f && !said.includes(f)) said.push(f);
    }
    if (said.length < 2) return said.length ? groundedLead(intentId, facts, question, said[0].value.weekday) : null;
    const at = (f, i) => {
      const hour = Number(f.value.peakHour);
      const when = Number.isInteger(hour) && hour >= 0 && hour < 24 ? ` around ${clockHour(hour)}` : '';
      const night = f.value.afterMidnight === true ? ' night' : '';
      return `${f.value.weekday}${night}${i ? '' : ' projects busiest'}${when}, at ${Number(f.value.peakScore)}`;
    };
    const parts = said.map(at);
    const list = `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
    return { text: open(`${list}, on our 0 to 100 index.`), fact: said[0], facts: said };
  }
  // A question about a named day is answered about that day. "How do I fill
  // Thursdays" used to open on whichever day was quietest (2026-10-28), an
  // answer to a different question. With no forecast for the named day there
  // is no lead at all, rather than one about another day.
  const named = askedFor !== undefined ? askedFor : namedWeekday(question);
  if (named) {
    const day = peaks.find((f) => f.value.weekday === named);
    if (!day) return null;
    // Named and the quietest of a real week: that is the stronger sentence.
    const quietest = days.length
      ? days.reduce((a, b) => (Number(b.value.peakScore) < Number(a.value.peakScore) ? b : a))
      : null;
    // Only from a whole week, or from the quiet-days plan's own marking of the
    // week's lowest day; 3 days of a weekend cannot say "quietest this week".
    const markedLowest = /LOWEST projected day in the week/.test(String(day.note || ''));
    if (!isBesideWeek(day) && (markedLowest || (days.length >= 6 && quietest === day))) {
      return { text: open(`${named} projects as ${your} quietest day this week.`), fact: day };
    }
    const hour = Number(day.value.peakHour);
    const when = Number.isInteger(hour) && hour >= 0 && hour < 24 ? ` around ${clockHour(hour)}` : '';
    // A peak in the small hours is that day's night (advisorFacts.nightTailHours).
    const night = day.value.afterMidnight === true ? ' night' : '';
    return { text: open(`${named}${night} projects busiest${when}, at ${Number(day.value.peakScore)} on our 0 to 100 index.`), fact: day };
  }
  if (!days.length) return null;
  if (intentId === 'money_move') {
    // A level week has no quiet day to name (the plan's note says so).
    if (days.some((f) => /projects level/.test(String(f.note || '')))) return null;
    const low = days.reduce((a, b) => (Number(b.value.peakScore) < Number(a.value.peakScore) ? b : a));
    return { text: open(`${low.value.weekday} projects as ${your} quietest day this week.`), fact: low };
  }
  if (intentId === 'quiet_nights') {
    return { text: open(`${days[0].value.weekday} projects as ${your} quietest day this week.`), fact: days[0] };
  }
  if (intentId === 'peak_hours') {
    const top = days.reduce((a, b) => (Number(b.value.peakScore) > Number(a.value.peakScore) ? b : a));
    return { text: open(`${top.value.weekday} projects as ${your} busiest day this week.`), fact: top };
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

function calculatorAnswer(book, { question, ctx, venue, intentId, exclude = [] }) {
  const asked = coversIn(question);
  if (!asked) return null;
  const spend = spendOf(ctx);
  // The move under a covers sum is one that BRINGS covers: "10 more covers is
  // $380" followed by a move about closing early answers a different question.
  // Picked by topic, not by the question's words: "covers", "week" and "make"
  // say nothing about which move fits, and matched incidental text instead.
  // And in the playbook's own order, so the topic's lead move wins rather than
  // whichever one happens to be tagged for this kind of venue.
  const candidates = book.find('', { intentId: intentId || 'quiet_nights', venue, limit: 12, exclude })
    .sort((a, z) => a.order - z.order);
  const move = candidates.find((t) => t.money === 'covers') || candidates[0];
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
function answerFrom(book, { question, intentId = null, ctx = null, groundedFacts = [], exclude = [], askedFor = undefined } = {}) {
  const venue = venueOf(ctx);
  const calc = calculatorAnswer(book, { question: normalizeOwnerText(String(question || '')), ctx, venue, intentId, exclude });
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
      followUp: calc.move ? followUpFor([calc.move], venue, question) : null,
    };
  }
  const ranking = book.ranked(question, { intentId, venue, limit: 3, exclude });
  if (!ranking.length) return null;
  const [top] = ranking;
  // "ANOTHER OPTION" EARNS ITS LINE: the owner's own words found it, or failing
  // that it works the same topic as the first move. A runner-up from another
  // topic that only shared a word read as a non sequitur (brunch under "how do
  // I get more people in for dinner on Tuesdays", a spray valve over the
  // cash-flow move the words found, 2026-10-28), so the answer goes without.
  // And it is written for this kind of room. The first move may come from
  // another kind when the owner names its subject; a second one offered on
  // top read as a stray (a coffee counter's line move under a club's door
  // line, 2026-10-28).
  const rest = ranking.slice(1).filter((x) => forThisKind(x.t, venue));
  const runnerUp = rest.find((x) => x.cues > 0) || rest.find((x) => x.t.topic === top.t.topic);
  const first = top.t;
  const second = runnerUp ? runnerUp.t : null;
  const picks = second ? [first, second] : [first];
  const spend = spendOf(ctx);
  const lead = groundedLead(intentId, groundedFacts, question, askedFor);
  // Under a lead that names a day of Flock's forecast for places like this
  // venue, the move names that day, never "your slowest day"
  // (services/kindForecast.js unownDays).
  // With two days or more led, the quieter of them is the day a fill move
  // names, as the one day led is.
  const quiet = lead && lead.facts
    ? lead.facts.reduce((a, f) => (Number(f.value.peakScore) < Number(a.value.peakScore) ? f : a))
    : (lead && lead.fact);
  const say = lead && isKindForecast(lead.fact) ? (s) => unownDays(s, quiet.value.weekday) : (s) => s;

  const points = [say(first.why)];
  const money = moneyLine(first, spend);
  if (money) points.push(money);
  else if (first.example) points.push(say(first.example));
  points.push(say(first.watch));
  if (second && points.length < advisorAnswer.MAX_POINTS) points.push(`${ANOTHER}${lowerFirst(say(second.move))}`);
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
  if (lead) sources.push(...(lead.facts || [lead.fact]).map(factSource));

  return {
    mode: 'advice',
    text: advisorAnswer.assemble({ structured: true, answer: [lead ? `${lead.text} ${say(first.move)}` : first.move], points }),
    sources,
    tactics: picks.map((t) => t.id),
    topic: first.topic,
    followUp: followUpFor(picks, venue, question),
  };
}

// ── What to ask next ────────────────────────────────────────────────────────
//
// THE NEXT QUESTION FITS THIS KIND OF ROOM (2026-11-03). A move written for
// another kind of room is offered when the owner names its subject ("how do I
// turn tables faster" from a club), and its own follow-up came with it: the
// live eval offered a bar and a club "Where do meals lose the most time?". A
// move's follow-up is offered when the move is written for this kind of room,
// or when the follow-up carries on in the owner's own words ("What should go
// on a happy hour menu?" to a club that asked about a happy hour, "What else
// cuts no shows?" to a bar that asked about no-shows); otherwise the next
// move's is.
//
// AND IT IS NEVER THE QUESTION AGAIN. "What should my food cost be" was offered
// "What food cost should I aim for?", "what should I post on instagram" was
// offered "What should I post on social media?", and "is delivery worth it with
// the app fees" was offered "Should I be on delivery apps at all?": a tap that
// asks what was just answered. A follow-up whose words are all in the question
// (the words that only frame a question set aside, and a platform read as the
// social media it is) restates it, and the next move's follow-up is offered.
const FRAME_WORDS = new Set(['aim', 'target', 'worth', 'ideal', 'right', 'usually', 'typical', 'normal'].map(stem));
const SAME_SUBJECT = Object.freeze({
  instagram: ['social', 'media'],
  tiktok: ['social', 'media'],
  facebook: ['social', 'media'],
  insta: ['social', 'media'],
  ig: ['social', 'media'],
});

function subjectWords(text) {
  const out = new Set();
  for (const w of stems(normalizeOwnerText(String(text || '')))) {
    if (STOP.has(w) || FRAME_WORDS.has(w)) continue;
    out.add(w);
    // Own keys only: "constructor" is a word an owner can type, and read off
    // a plain object it is a function, which threw here and took the answer
    // with it (2026-11-03).
    for (const same of Object.hasOwn(SAME_SUBJECT, w) ? SAME_SUBJECT[w] : []) out.add(stem(same));
  }
  return out;
}

/** True when every word a follow-up asks about is already in the question. */
function restates(followUp, question) {
  const next = subjectWords(followUp);
  if (!next.size) return false;
  const asked = subjectWords(question);
  return [...next].every((w) => asked.has(w));
}

/**
 * The follow-up an answer built on these moves offers, or null: in the moves'
 * order, the first that does not ask the question again and either belongs to
 * a move written for this kind of room or carries on in the owner's words;
 * failing that, the first that does not ask the question again.
 */
function followUpFor(tactics, venue, question = '') {
  const offered = (Array.isArray(tactics) ? tactics : [])
    .filter((t) => t && typeof t.follow_up === 'string' && !restates(t.follow_up, question));
  const asked = subjectWords(question);
  const carriesOn = (t) => [...subjectWords(t.follow_up)].some((w) => asked.has(w));
  const pick = offered.find((t) => forThisKind(t, venue) || carriesOn(t)) || offered[0];
  return pick ? pick.follow_up : null;
}

// ── The one move a chip answer ends on ──────────────────────────────────────
//
// The chips whose facts always raise the same kind of move. The template twin
// ends on this move (routes/advisor.js withMove), and the phrasing model is
// handed the same one to build on (advisorPhrasing.phrase), so a chip answers
// with one vetted move whichever of the two wrote it.
const { HOUR_ORDERING_MIN_GAP } = require('./crowdEngine');

// The chip move for a topic where the file's lead does not fit a kind of room.
const LEAD_FOR_KIND = Object.freeze({
  club: Object.freeze({ handle_the_rush: 'rush_door_lanes' }),
  bar: Object.freeze({ handle_the_rush: 'labor_stagger_starts' }),
});

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
  // NO FILL MOVE FOR A BUSY TODAY (review, 2026-11-06). A question about
  // today on the quiet-days chip is answered from today's entry alone
  // (routes/advisor.js withNamedToday), and on a Saturday at 74, the week's
  // high, it ended on "Give Saturday one recurring reason to visit". Today is
  // filled only from the quiet end of its week (kindForecast.besideWeek); any
  // other today gets the busy-day move the peaks chip ends on.
  if (intentId === 'quiet_nights' && facts.some((f) => isBesideWeek(f) && f.quietEnd === false)) {
    return moveFor('peak_hours', block, venue);
  }
  if (intentId === 'last_night_verdict') {
    const verdict = facts.find((f) => f && /^last_day_verdict_/.test(String(f.id)));
    if (!verdict || !verdict.value || verdict.value.verdict !== 'below') return null;
  }
  const key = intentId === 'money_move' && isLevelWeek(block) ? 'money_move_level' : intentId;
  // THE TOPIC'S LEAD MOVE, IN THE PLAYBOOK'S OWN ORDER. With no question words
  // to rank by, find() fell to its venue tiebreak and handed a cafe's money
  // move "if you run a happy hour..." over the plain slow-day lead (found by
  // dumping the stand-in eval's payloads, 2026-10-28). The file lists each
  // topic's strongest, most general move first, so that is the one a chip
  // ends on, among the moves that fit this venue.
  const [topic] = INTENT_TOPICS[key] || [];
  const drinks = false;
  // A room whose peak is not a kitchen's: the topic's lead in file order is
  // "run a shorter menu at the rush", which a club with no kitchen cannot use
  // and a bar mostly does not need (2026-10-28 chip audit). A club's peak
  // waits at the door; a bar's is covered by who is on and when.
  const pinned = venue && venue.kind && LEAD_FOR_KIND[venue.kind] ? LEAD_FOR_KIND[venue.kind][topic] : null;
  const pinnedTactic = pinned ? BOOK.byId.get(pinned) : null;
  if (pinnedTactic && fits(pinnedTactic, venue, drinks)) return pinnedTactic;
  const lead = BOOK.tactics.find((t) => t.topic === topic && fits(t, venue, drinks) && forThisKind(t, venue));
  if (lead) return lead;
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

function ranked(question, opts) {
  return BOOK.ranked(question, opts);
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
  ranked,
  answer,
  answerFrom,
  createPlaybook,
  validateTactic,
  venueOf,
  spendOf,
  moneyLine,
  groundedLead,
  namedWeekday,
  askedDay,
  coversIn,
  dollars,
  MOVE_INTENTS,
  isLevelWeek,
  moveFor,
  forPayload,
  forThisKind,
  followUpFor,
  restates,
  stem,
  stems,
  trafficView,
  ruledOut,
  __copyStrings,
};
