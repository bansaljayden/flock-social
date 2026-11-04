// ---------------------------------------------------------------------------
// WHAT BIRDIE MAY SAY ABOUT A VENUE (2026-11-03).
//
// Filming the LionCage demo, Birdie answered "Where's good tonight for 6 of
// us?" with "Thistle & Crust. The booths in the back fit six easily and the
// wood-fired pies are the whole reason to go." That venue's data said
// pizza_restaurant, restaurant, rated 4.6 from 301 ratings, on Chestnut St.
// Nothing said booths, a back room, how many it seats, or an oven. The system
// prompt already told the model its reasons come from the tools, and it wrote
// that sentence anyway, so this is the deterministic half, in the style of the
// other valves in routes/ai.js (the plain no to underage drinking, the bar
// filter for minors): it runs on what the model wrote, after the model is done,
// and costs no further call.
//
// HOW IT WORKS. The tool loop records, per venue, everything its tools
// returned for it this turn (createVenueFacts / noteToolResult / notePlan): a
// search row's name, address and Google types, a crowd lookup's words, a staged
// card's venue, the group's picks. Any field a tool adds later (an editorial
// summary, review snippets, the venue's active deal) is read the same way,
// because every string in the payload counts. The reply is then read for
// claims from a fixed lexicon of venue features (CLAIMS: seating and booths,
// the room, a patio or rooftop, how many it fits, dishes and drinks, the oven
// and how food is made, decor and vibe, music, games and amenities, service,
// reservations, deals and specials, the menu, a reputation). Each claim is
// held to the venue it is about (the one its own clause names, else the one
// named before it, else the one named after it, else the only venue the turn
// knows), and it stands
// when that venue's own data says it: the word itself, or a word the venue's
// Google types make a fact ("pizza" or "pies" at a pizza_restaurant, "lanes"
// at a bowling alley, "coffee" at a cafe). A deal-like claim ("happy hour",
// "half-price pies", "$5 pints") stands only on a deal field in that venue's
// payload that says it, object included.
//
// WHAT IS REMOVED. The clause the unsupported claim sits in, or its phrase
// ("in a booth"), or the whole sentence when nothing else in it stands, and the
// sentence is put back together as a plain sentence: a dangling "and" goes, a
// list keeps its "and", the full stop comes back. The venue the answer leads
// with, named only inside a removed clause, keeps its name as a sentence of its
// own ("Thistle & Crust."), so the pick is never lost with the made-up reason
// for it. An answer is never emptied: if nothing else stands, it is the
// venue's name.
//
// WHAT IS NOT. A sentence that asks ("want a booth?"), and a clause that denies
// or does not know ("no word on a patio", "can't tell if it has booths"),
// claim nothing. A reply that names no venue the turn knows, about no venue the
// turn knows, is left alone: there is nothing to hold it to. Words inside a
// venue's own name are not claims ("Brick Oven Pie Co.", "Luna Rooftop
// Lounge"), and a name can support its own detail.
//
// THE LEXICON IS DELIBERATELY NOT A QUALITY CHECK. "Great tacos" and "solid
// slices" pass at a taco place and a pizza place: a rating stands behind a
// good word, and the prompt governs the voice. What is removed is a fact about
// the place itself that no tool said.
//
// Pure functions, no I/O: __tests__/birdieGrounding.test.js reads them one
// rule at a time, and routes/ai.js calls them once per turn.
// ---------------------------------------------------------------------------

'use strict';

// ── Text helpers ────────────────────────────────────────────────────────────

// Lowercase words separated by single spaces, padded with a space at each end,
// so " word " tests a whole word. Accents fold away, "&" reads "and", and an
// apostrophe joins its word ("fennick's" is "fennicks").
const norm = (s) => ` ${String(s == null ? '' : s)
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/['‘’]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()} `;

// A word's stem for matching, cheap and predictable: "booths" -> "booth",
// "couches" -> "couch", "pies" -> "pie". Matched as a word PREFIX, so the stem
// of a plural still finds the singular and the plural.
function stem(word) {
  const w = String(word || '').toLowerCase();
  if (w.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// Whether the normalised text `hay` has every word of `phrase`, each as the
// start of a word.
function hasWords(hay, phrase) {
  const words = norm(phrase).trim().split(' ').filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => hay.includes(` ${stem(w)}`));
}

// ── What the turn's tools returned, per venue ───────────────────────────────

// Keys whose values are never about the venue: ids and links, and the notes
// the route writes TO the model (a locked forecast, the UTC clock, a staged
// card's button), whose words are instructions, not facts about a place.
const SKIP_KEY = /^(?:place_id|photo_url|id|lat|lng|location|button|error|confidence|confidence_measurement)$|_note$/;
// Where a venue's deal lives, whatever a branch names it: a deal, deals, an
// active deal, specials, a promo, an offer. Its words are the only support a
// deal-like claim has.
const DEAL_KEY = /deal|special|promo|offer/i;

// The generic dishes, drinks and doings a Google type makes a fact about a
// place: a pizza restaurant serves pizza, a bowling alley has lanes. Specific
// dishes are not here ("birria" at a taco place, "wood-fired" anything): those
// need their own words in the venue's data.
const TYPE_FAMILIES = [
  [/\bpizza/, ['pizza', 'pizzas', 'pie', 'pies', 'slice', 'slices']],
  [/\bmexican\b|\btaco|\btaqueria\b/, ['taco', 'tacos', 'burrito', 'burritos', 'quesadilla', 'quesadillas', 'nachos', 'mexican']],
  [/\bramen\b|\bnoodle/, ['ramen', 'noodle', 'noodles']],
  [/\bsushi\b/, ['sushi']],
  [/\bindian\b/, ['curry', 'curries']],
  [/\bthai\b/, ['pad thai', 'curry']],
  [/\bitalian\b/, ['pasta']],
  [/\bseafood\b|\boyster/, ['seafood', 'fish']],
  [/\bsteak/, ['steak', 'steaks']],
  [/\bhamburger\b|\bburger/, ['burger', 'burgers', 'fries']],
  [/\bdiner\b/, ['pancakes', 'burger', 'burgers', 'fries', 'milkshake', 'milkshakes', 'shakes', 'coffee', 'eggs']],
  [/\bbreakfast\b|\bbrunch\b/, ['pancakes', 'waffles', 'eggs']],
  [/\bcafe\b|\bcoffee\b/, ['coffee', 'espresso', 'latte', 'lattes', 'cappuccino', 'pastries', 'pastry']],
  [/\bbakery\b/, ['pastries', 'pastry', 'croissant', 'croissants', 'cookies']],
  [/\bice cream\b|\bgelato\b|\bdessert\b|\byogurt\b/, ['ice cream', 'gelato', 'froyo', 'dessert', 'desserts', 'sundaes', 'cones']],
  [/\bdonut\b|\bdoughnut\b/, ['donuts', 'doughnuts']],
  [/\bsandwich\b|\bdeli\b/, ['sandwich', 'sandwiches', 'hoagie', 'hoagies']],
  [/\bbarbecue\b|\bbbq\b/, ['bbq', 'barbecue', 'brisket', 'ribs']],
  [/\bwings\b/, ['wings']],
  [/\bchicken\b/, ['chicken']],
  [/\bbar\b|\bpub\b|\btavern\b|\bbrew|\bbeer\b|\bnight club\b|\blounge\b/, ['beer', 'beers', 'cocktail', 'cocktails', 'drafts', 'on tap', 'taps', 'pints']],
  [/\bwine\b|\bwinery\b/, ['wine', 'wines']],
  [/\bnight club\b/, ['dj', 'djs', 'dancing', 'dance floor', 'music']],
  [/\bkaraoke\b/, ['karaoke']],
  [/\bbowling\b/, ['bowling', 'lanes', 'lane']],
  [/\bamusement center\b|\barcade\b/, ['games', 'arcade', 'machines', 'skee ball', 'skeeball', 'pinball']],
  [/\bvegan\b/, ['vegan']],
  [/\bvegetarian\b/, ['vegetarian']],
];

// Every string a payload carries, and the ones under a deal key, as plain text.
// Arrays and nested objects are walked; numbers and booleans say nothing a
// claim could rest on.
function collectStrings(value, key, into, deal, inDeal = false) {
  if (key && SKIP_KEY.test(key)) return;
  const dealHere = inDeal || (key ? DEAL_KEY.test(key) : false);
  if (typeof value === 'string') {
    // Google's types are words joined by underscores.
    const words = key === 'types' ? value.replace(/_/g, ' ') : value;
    into.push(words);
    if (dealHere) deal.push(words);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, key, into, deal, dealHere);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, k, into, deal, dealHere);
  }
}

// The words a venue's types and price make facts about it.
function impliedWords(typesText, priceLevel) {
  const out = new Set();
  for (const [re, words] of TYPE_FAMILIES) if (re.test(typesText)) for (const w of words) out.add(w);
  if (Number.isInteger(priceLevel) && priceLevel >= 3) for (const w of ['upscale', 'fancy', 'pricey', 'expensive', 'splurge']) out.add(w);
  return out;
}

/**
 * The facts a turn's tools returned, per venue. `add(name, payload)` folds a
 * payload into the venue of that name (two tools answering about one place are
 * one venue); an empty payload makes a venue the reply can be held to with
 * nothing that supports a detail about it.
 */
function createVenueFacts() {
  const venues = [];
  const byKey = new Map();
  return {
    add(name, payload) {
      if (typeof name !== 'string' || !name.trim()) return;
      const key = norm(name).trim();
      if (!key) return;
      let v = byKey.get(key);
      if (!v) {
        v = { name: name.trim(), key, strings: [name], deal: [], types: [], priceLevel: null };
        byKey.set(key, v);
        venues.push(v);
      }
      if (payload && typeof payload === 'object') {
        collectStrings(payload, '', v.strings, v.deal);
        if (Array.isArray(payload.types)) v.types.push(...payload.types.filter((t) => typeof t === 'string').map((t) => t.replace(/_/g, ' ')));
        if (Number.isInteger(payload.price_level)) v.priceLevel = payload.price_level;
      }
      v.text = norm(v.strings.join(' '));
      v.dealText = norm(v.deal.join(' '));
      v.implied = impliedWords(norm(v.types.join(' ')), v.priceLevel);
    },
    list() { return venues; },
    get size() { return venues.length; },
  };
}

// What one tool call adds. A search adds every row it returned (after the bar
// filter for minors, so a row the model never saw supports nothing), a crowd
// lookup its own result, a staged plan or vote card its venue, and a plan
// list each plan's venue by name, with nothing behind it.
function noteToolResult(facts, toolName, result) {
  if (!facts || !result || typeof result !== 'object' || result.error) return;
  if (toolName === 'search_venues' && Array.isArray(result.venues)) {
    for (const v of result.venues) if (v && typeof v.name === 'string') facts.add(v.name, v);
  } else if (toolName === 'get_crowd_prediction') {
    if (typeof result.venue_name === 'string') facts.add(result.venue_name, result);
  } else if ((toolName === 'draft_flock' || toolName === 'add_venue_to_vote') && result.venue && typeof result.venue.name === 'string') {
    facts.add(result.venue.name, result.venue);
  } else if (toolName === 'get_user_flocks' && Array.isArray(result.flocks)) {
    for (const f of result.flocks) if (f && typeof f.venue_name === 'string') facts.add(f.venue_name, null);
  }
}

// The group's plan (services/birdiePlan.js): its picks and the venue it is
// locked in at are venues the reply can be about. Their votes are a fact about
// the group, not the place, so they support no detail.
function notePlan(facts, plan) {
  if (!facts || !plan) return;
  for (const v of [plan.locked, plan.venueSoFar, ...(plan.picks || [])]) {
    if (v && typeof v.name === 'string') facts.add(v.name, null);
  }
}

// ── The claims ──────────────────────────────────────────────────────────────

const NUM = '(?:[3-9]|1\\d|[2-9]\\d|\\d{3}|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|a dozen)';
const CROWD = '(?:everyone|everybody|y\'?all|all of (?:you|us)|the (?:whole )?(?:group|crew)|your (?:whole )?(?:group|crew|squad|flock|party)|a (?:big |large )?(?:group|crowd|party)|big groups|large groups|groups)';

// Dishes and drinks a reply can claim. The generic ones a venue's types make a
// fact (TYPE_FAMILIES) are in this list too; the support check reads both.
// Idioms are left out on purpose: "piece of cake", "spill the tea", "your
// best shot", "game" (tonight's game is a schedule fact).
const DISH_WORDS = [
  'pizza', 'pizzas', 'pie', 'pies', 'slice', 'slices', 'calzone', 'calzones', 'stromboli', 'garlic knots',
  'taco', 'tacos', 'burrito', 'burritos', 'quesadilla', 'quesadillas', 'nachos', 'birria', 'al pastor', 'carnitas', 'elote', 'churros', 'guacamole', 'guac',
  'ramen', 'noodle', 'noodles', 'sushi', 'dumplings', 'bao', 'pho', 'banh mi', 'bibimbap', 'kimchi', 'poke', 'pad thai', 'curry', 'curries', 'tikka', 'naan', 'biryani',
  'pasta', 'gnocchi', 'carbonara', 'lasagna', 'risotto', 'tiramisu', 'cannoli', 'tapas', 'small plates', 'charcuterie',
  'seafood', 'oysters', 'lobster', 'crab', 'ceviche', 'steak', 'steaks', 'brisket', 'ribs', 'bbq', 'barbecue',
  'burger', 'burgers', 'fries', 'wings', 'tenders', 'nuggets', 'mac and cheese', 'cheesesteak', 'cheesesteaks', 'hoagie', 'hoagies', 'sandwich', 'sandwiches',
  'pancakes', 'waffles', 'eggs', 'bagels', 'croissant', 'croissants', 'pastries', 'pastry', 'donuts', 'doughnuts', 'cupcakes', 'cookies',
  'milkshake', 'milkshakes', 'shakes', 'ice cream', 'gelato', 'froyo', 'sundaes', 'dessert', 'desserts',
  'coffee', 'espresso', 'latte', 'lattes', 'cappuccino', 'cold brew', 'matcha', 'boba', 'smoothies',
  'beer', 'beers', 'craft beer', 'ipa', 'ipas', 'cider', 'drafts', 'on tap', 'taps', 'pints', 'wine', 'wines', 'natural wine',
  'cocktail', 'cocktails', 'mocktails', 'margarita', 'margaritas', 'sangria', 'sake', 'whiskey', 'bourbon', 'mezcal', 'tequila', 'espresso martini', 'espresso martinis',
  'games', 'arcade', 'machines', 'skee ball', 'skee-ball', 'skeeball', 'pinball', 'bowling', 'lanes', 'lane', 'karaoke', 'dj', 'djs', 'dancing', 'dance floor',
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DISH_RE = new RegExp(`\\b(?:${[...DISH_WORDS].sort((a, b) => b.length - a.length).map((w) => escapeRe(w).replace(/ /g, '[\\s-]+')).join('|')})\\b`, 'gi');

// The rest of the lexicon. `kind` names the claim in the log (fixed words,
// never the reply's). `support` is how the venue's data stands behind it:
// 'self' (the claim's own words are in the venue's data), a list of stems
// (any one of them is), or 'deal' (the venue's deal says it).
const CLAIMS = [
  { kind: 'seating', re: /\bbooths?\b/gi, support: ['booth'] },
  { kind: 'seating', re: /\b(?:couch|couches|sofas?|armchairs?|bean ?bags?|high[- ]?tops?|bar ?stools?)\b/gi, support: 'self' },
  { kind: 'seating', re: /\b(?:communal|long|big|large|huge|giant|picnic|round|group|family[- ]style) tables?\b/gi, support: 'self' },
  { kind: 'seating', re: /\b(?:outdoor|indoor|bar|counter|sidewalk|lounge|patio|covered|heated) seating\b|\bseating (?:area|outside)\b/gi, support: 'self' },
  { kind: 'room', re: /\b(?:back|private|party|side|event|function|game|dining) rooms?\b|\bupstairs\b|\bdownstairs\b|\bmezzanine\b|\b(?:in|out) (?:the )?back\b/gi, support: 'self' },
  { kind: 'outdoor', re: /\b(?:patios?|rooftops?|roof ?decks?|terraces?|beer gardens?|courtyards?|back ?yards?|balcon(?:y|ies)|fire ?pits?|outdoor (?:space|area|bar)|sit outside|al fresco)\b/gi, support: 'self' },
  {
    kind: 'capacity',
    re: new RegExp(`\\b(?:fits?|fitting|seats|holds?|accommodates?|sits)\\s+(?:all\\s+)?(?:(?:the\\s+)?${NUM}(?:\\s+of\\s+(?:you|y'?all|us))?|${CROWD})\\b`
      + `|\\b(?:room|space|tables?|seats?|booths?|spots?) for (?:all\\s+)?(?:(?:the\\s+)?${NUM}(?:\\s+of\\s+(?:you|y'?all|us))?|${CROWD})\\b`
      + '|\\bbig enough for\\b|\\bplenty of (?:room|space|seats|seating|tables)\\b|\\b(?:roomy|spacious|cavernous)\\b'
      + '|\\b(?:good|great|perfect|built|made|set up) for (?:big |large )?groups\\b|\\bgroup[- ]friendly\\b|\\bcapacity\\b', 'gi'),
    support: ['capacity', 'group', 'large part', 'spacious', 'roomy'],
  },
  { kind: 'service', re: /\b(?:(?:fast|quick|slow|friendly|great|good|attentive|rude|table|counter) service|the (?:staff|servers|bartenders?|waitstaff|waiters?|baristas?|chefs?)|moves? fast|turns? (?:tables|over) fast)\b/gi, support: 'self' },
  // "Walk-ins" is a door policy; "you can walk in" is the crowd, and is not here.
  { kind: 'reservations', re: /\breservations?\b|\b(?:book|reserve) (?:a |your )?table\b|\bwalk-ins?\b|\bwalk ins\b/gi, support: ['reserv', 'walk in'] },
  { kind: 'preparation', re: /\b(?:wood[- ]?fired|wood oven|brick[- ]?oven|coal[- ]?fired|coal oven|stone[- ]?oven|stone[- ]?baked|clay oven|tandoori?|smoker|smoked|home[- ]?made|house[- ]?made|hand[- ]?made|hand[- ]?pulled|hand[- ]?tossed|hand[- ]?rolled|hand[- ]?cut|from scratch|scratch[- ]?made|fresh[- ]?baked|freshly (?:made|baked)|made to order|made fresh|farm[- ]to[- ]table|locally sourced|organic|gluten[- ]free|vegan|vegetarian|plant[- ]based|halal|kosher|deep[- ]dish|thin[- ]crust|neapolitan|detroit[- ]style|new york[- ]style|sicilian)\b/gi, support: 'self' },
  { kind: 'decor', re: /\b(?:decor|décor|interior|lighting|(?:low|dim|soft|warm|moody) (?:light|lights)|dimly[- ]lit|candle[- ]?lit|candles|string lights|neon|murals?|exposed brick|fireplaces?|chandeliers?|cozy|cosy|intimate|romantic|homey|rustic|industrial|swanky|classy|upscale|fancy|ritzy|divey|dive bar|hole[- ]in[- ]the[- ]wall|laid[- ]back|artsy|trendy|old[- ]school|retro|vintage|aesthetic|instagrammable|views|(?:the|a|great|nice|killer|city) view|skyline|waterfront|scenic)\b/gi, support: 'self' },
  { kind: 'vibe', re: /\b(?:vibes?|atmosphere|ambiance|ambience|energy)\b/gi, support: 'self', crowdExempt: true },
  { kind: 'music', re: /\b(?:live music|live bands?|music|playlists?|jukebox|trivia(?: night)?|open mic|jazz|sound system|comedy|drag (?:show|brunch)|bingo)\b/gi, support: 'self' },
  { kind: 'amenities', re: /\b(?:pool tables?|billiards|darts|shuffleboard|cornhole|ping[- ]?pong|foosball|board games|arcade games|air hockey|tvs|televisions?|big screens?|projector|wi-?fi|outlets|charging|parking|valet|coat check|dog[- ]friendly|pet[- ]friendly|kid[- ]friendly|family[- ]friendly|wheelchair accessible)\b/gi, support: 'self' },
  { kind: 'menu', re: /\b(?:menu|menus|drink list|wine list|beer list|tap list|kitchen)\b/gi, support: 'self' },
  { kind: 'reputation', re: /\b(?:famous|known for|legendary|iconic|signature|an institution|cult (?:following|favorite|classic)|(?:local|neighborhood|crowd|fan) favorite|everyone loves|locals love|people love|must[- ]try|can'?t[- ]miss|never misses|hidden gem|award[- ]winning|michelin|world[- ]class)\b|\bbest (?!time\b|bet\b|shot\b|move\b|call\b|way\b|window\b|chance\b|part\b|pick\b|option\b|choice\b|spot\b|place\b|plan\b)(?:[a-z]+ ){0,2}?[a-z]+ (?:around(?: here)?|in (?:town|the city|the area|the neighborhood|philly|philadelphia|miami|allentown))\b/gi, support: 'self' },
  {
    kind: 'deal',
    re: /\b(?:happy[- ]hours?|(?:daily |nightly |weekly |drink |food |lunch |dinner |late[- ]night )?specials?|deals?|discounts?|promos?|coupons?|half[- ]?(?:price[ds]?|off)|\d{1,2}\s?% off|(?:two|2)[- ]for[- ](?:one|1)|bogo|buy one get one|bottomless|all[- ]you[- ]can[- ](?:eat|drink)|prix[- ]fixe|tasting menu|byob)\b(?:\s+(?:on\s+)?(?:all\s+)?([a-z]+))?|\$\s?(\d+)(?:\.\d{2})?\s+(pints?|beers?|drafts?|wings|slices?|tacos?|drinks?|cocktails?|shots?|burgers?|pies?|apps?|appetizers?|margaritas?|wells?)\b/gi,
    support: 'deal',
  },
];

// The word that ends a deal claim's head, before its object ("half-price
// pies": "pies").
const DEAL_HEAD = /^(?:happy[- ]hours?|(?:daily |nightly |weekly |drink |food |lunch |dinner |late[- ]night )?specials?|deals?|discounts?|promos?|coupons?|half[- ]?(?:price[ds]?|off)|\d{1,2}\s?% off|(?:two|2)[- ]for[- ](?:one|1)|bogo|buy one get one|bottomless|all[- ]you[- ]can[- ](?:eat|drink)|prix[- ]fixe|tasting menu|byob)/i;
// "A deal", "specials", "a promo": any deal the venue has says that much.
const GENERIC_DEAL = /^(?:(?:daily |nightly |weekly |drink |food |lunch |dinner |late[- ]night )?specials?|deals?|discounts?|promos?|coupons?)$/i;
// An object word worth holding a deal to: a dish, or a drink.
const DISH_WORD_SET = new Set(DISH_WORDS.map((w) => norm(w).trim()));

// A clause that denies or does not know: it claims nothing. Read outside the
// claim's own words, so "never misses" is still a claim.
const DENIES = /\b(?:no|not|never|without|unsure|unknown|whether|unclear)\b|n['’]t\b/i;
// A comparison, after which a word can be about the other side of it.
const COMPARED = /\b(?:than|unlike|instead of|compared to|versus|vs)\b/i;
// A clause that carries a crowd reading: its "vibe" is the crowd.
const CROWD_WORDS = /\b(?:quiet|quieter|busy|busier|packed|dead|steady|slow|empty|crowded|slammed|mobbed|lowkey|low-key|chill|calm|mellow)\b|\b\d{1,3}\s?%|\bat \d{1,3}\b/i;

// Family words for a dish, so "pies" is held up by "pizza" in a name.
function familyOf(word) {
  const w = norm(word).trim();
  const out = new Set([w]);
  for (const [, words] of TYPE_FAMILIES) if (words.includes(w)) for (const x of words) out.add(x);
  return out;
}

function dishSupported(word, venue) {
  const w = norm(word).trim();
  if (venue.implied.has(w)) return true;
  for (const f of familyOf(w)) if (hasWords(venue.text, f)) return true;
  return false;
}

function claimSupported(claim, venue) {
  if (!venue) return true;
  if (claim.kind === 'dish') return dishSupported(claim.text, venue);
  if (claim.support === 'deal') {
    if (!venue.dealText.trim()) return false;
    const head = (DEAL_HEAD.exec(claim.text) || [claim.text])[0];
    if (claim.money) return hasWords(venue.dealText, claim.money) && hasWords(venue.dealText, claim.object || '');
    if (!GENERIC_DEAL.test(head) && !hasWords(venue.dealText, head)) return false;
    const object = claim.object && DISH_WORD_SET.has(norm(claim.object).trim()) ? claim.object : null;
    return object ? [...familyOf(object)].some((f) => hasWords(venue.dealText, f)) : true;
  }
  if (claim.support === 'self') {
    const words = norm(claim.text).trim().split(' ').filter((w) => w.length > 2 && !STOP.has(w));
    if (!words.length) return false;
    return words.every((w) => venue.implied.has(w) || hasWords(venue.text, w));
  }
  return claim.support.some((s) => hasWords(venue.text, s) || venue.implied.has(s));
}
const STOP = new Set(['the', 'and', 'for', 'all', 'out', 'with', 'your', 'you', 'its', 'our', 'their', 'big', 'large', 'huge', 'giant', 'good', 'great', 'fast', 'quick', 'slow', 'low', 'dim', 'soft', 'warm', 'moody', 'live', 'local', 'freshly', 'made']);

// Every claim in a stretch of text, with offsets into it.
function findClaims(s) {
  const out = [];
  const push = (c) => {
    if (out.some((x) => c.start < x.end && x.start < c.end)) return;
    out.push(c);
  };
  for (const def of CLAIMS) {
    def.re.lastIndex = 0;
    for (const m of s.matchAll(def.re)) {
      const claim = { kind: def.kind, support: def.support, text: m[0], start: m.index, end: m.index + m[0].length, crowdExempt: Boolean(def.crowdExempt) };
      if (def.support === 'deal') {
        if (m[2]) { claim.money = m[2]; claim.object = m[3]; } else if (m[1]) claim.object = m[1];
      }
      push(claim);
    }
  }
  DISH_RE.lastIndex = 0;
  for (const m of s.matchAll(DISH_RE)) push({ kind: 'dish', text: m[0], start: m.index, end: m.index + m[0].length });
  return out.sort((a, b) => a.start - b.start);
}

// ── Where the venues are named ──────────────────────────────────────────────

// The shorter forms a reply calls a venue by: "Copper Kettle" for "Copper
// Kettle Cafe", "Pinwheel" for "Pinwheel Lanes", "Galaxy Arcade" for "Galaxy
// Arcade & Laser Tag". Generic last words go one at a time, then a leading
// "The", down to four letters; and the part before an "&", an "and", a dash or
// a full stop is a form of its own, trimmed the same way.
const GENERIC_TAIL = /\s+(?:philly|philadelphia|restaurant|pizzeria|cafe|café|bar|grill|kitchen|bistro|tavern|co\.?|inc\.?|llc|tacos|taqueria|diner|lounge|pub|room|lanes|arcade|wings|house|tap|taproom|eatery|cantina|shop|pie)$/i;
function nameForms(name) {
  const forms = [];
  const addTrimmed = (from) => {
    let n = String(from || '').trim();
    while (n.replace(/[^\p{L}\p{N}]/gu, '').length >= 4 && !forms.includes(n)) {
      forms.push(n);
      const shorter = n.replace(GENERIC_TAIL, '');
      n = shorter !== n ? shorter.trim() : n.replace(/^the\s+/i, '').trim();
    }
  };
  const full = String(name || '').trim();
  addTrimmed(full);
  const head = full.split(/\.\s+|\s+(?:&|and|\+|[-–:|])\s+/i)[0];
  if (head && head !== full) addTrimmed(head);
  return forms;
}

// A pattern for one form of a name, over the reply as written: its words in
// order, "&" or "and", any punctuation between ("Fennick's" is "Fennicks").
function formPattern(form) {
  const tokens = form.match(/[\p{L}\p{N}]+|&/gu) || [];
  if (!tokens.length) return null;
  const body = tokens.map((t) => (t === '&' ? '(?:&|and)' : escapeRe(t))).join('[^\\p{L}\\p{N}]{0,3}');
  // "Brick Oven Pie Co." takes its full stop, which does not end a sentence.
  const dot = /\.$/.test(form) ? '\\.?' : '';
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${dot}(?![\\p{L}\\p{N}])`, 'giu');
}

// Every place a known venue is named in the text, longest names first, no two
// overlapping.
function findMentions(text, venues) {
  const found = [];
  const candidates = [];
  for (const v of venues) for (const f of nameForms(v.name)) candidates.push({ v, f });
  candidates.sort((a, b) => b.f.length - a.f.length);
  for (const { v, f } of candidates) {
    const re = formPattern(f);
    if (!re) continue;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (found.some((x) => start < x.end && x.start < end)) continue;
      found.push({ start, end, venue: v });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// The text with every venue's name covered, so a word inside a name is never a
// claim and a full stop inside one ("Brick Oven Pie Co.") never ends a
// sentence. Same length, so every offset still points into the original.
function mask(text, mentions) {
  let out = text;
  for (const m of mentions) out = out.slice(0, m.start) + '#'.repeat(m.end - m.start) + out.slice(m.end);
  return out;
}

// ── Sentences and their clauses ─────────────────────────────────────────────

const ABBREV = /(?:\b(?:st|ave|rd|blvd|dr|mt|ft|jr|sr|no|vs|approx|co|inc|ltd|ste)|\b[ap]\.m|\be\.g|\bi\.e)\.$/i;

// Sentences as [start, end) offsets: a run ending in . ! or ? (and any closing
// quote) followed by space, or a line break. Not after a short abbreviation.
// A sentence starts at its first character, so the space before it stays the
// space between two sentences.
function pushSentence(out, masked, start, end) {
  let from = start;
  while (from < end && /\s/.test(masked[from])) from += 1;
  if (from < end) out.push({ start: from, end });
}
function splitSentences(masked) {
  const out = [];
  let start = 0;
  const re = /[.!?]+["'”’)]*(?=\s)|\n+/g;
  let m;
  while ((m = re.exec(masked))) {
    const end = m.index + m[0].length;
    if (m[0][0] !== '\n' && ABBREV.test(masked.slice(Math.max(0, m.index - 6), m.index + 1))) continue;
    pushSentence(out, masked, start, end);
    start = end;
  }
  pushSentence(out, masked, start, masked.length);
  return out;
}

const OPENERS = "(?:the|it|it['’]s|its|they|they['’]re|their|there|there['’]s|that|that['’]s|this|these|those|you|you['’]ll|you['’]re|your|we|we['’]re|i|i['’]m|he|she|everyone|everybody|nobody|anyone|#)";
// Where a sentence divides: a semicolon, a comma, a conjunction that starts a
// new clause, and the start of a phrase that hangs off the clause before it
// ("with booths", "in a booth", "on the patio").
const SEPARATOR = new RegExp([
  ';\\s+',
  ',\\s+',
  `\\s+(?=(?:and|but|so|plus|while|though|although|yet|or)\\s+${OPENERS})`,
  '\\s+(?=(?:with|without|featuring|including)\\s)',
  '\\s+(?=(?:in|on|at|by|near|under|inside|outside|out|upstairs|downstairs)\\s+(?:a|an|the|its|their|our|your|one|some|back)\\b)',
].join('|'), 'gi');
const MODIFIER_START = /^(?:with|without|featuring|including|in|on|at|by|near|under|inside|outside|out|upstairs|downstairs)\b/i;
const LEADING_CONJ = /^(?:and|but|so|plus|or|while|though|although|yet|then|also)\s+/i;

// A sentence's segments: [start, end) offsets relative to it, the separator in
// front of each, and whether it is a phrase hanging off the one before.
function segmentsOf(maskedSentence) {
  const segs = [];
  let start = 0;
  let sep = '';
  // Every separator takes at least one character, so none is empty.
  for (const m of maskedSentence.matchAll(SEPARATOR)) {
    if (m.index === 0) continue;
    segs.push({ start, end: m.index, sep });
    sep = m[0];
    start = m.index + m[0].length;
  }
  segs.push({ start, end: maskedSentence.length, sep });
  for (const g of segs) g.modifier = MODIFIER_START.test(maskedSentence.slice(g.start, g.end));
  return segs;
}

// ── The check ───────────────────────────────────────────────────────────────

/**
 * The reply with every unsupported venue detail taken out (see the header).
 * Returns { text, removed: [{ kind, venue }] }. `text` is the original when
 * nothing was removed, and never empty when the original was not.
 */
function groundVenueDetails(text, facts) {
  const original = typeof text === 'string' ? text : '';
  const venues = facts && typeof facts.list === 'function' ? facts.list() : [];
  if (!original.trim() || !venues.length) return { text: original, removed: [] };

  const mentions = findMentions(original, venues);
  const masked = mask(original, mentions);
  const sentences = splitSentences(masked);
  const removed = [];
  const onlyVenue = venues.length === 1 ? venues[0] : null;
  const firstNamed = mentions.length ? mentions[0].venue : null;

  let lastVenue = null;
  const pieces = [];
  const namedSoFar = new Set();
  let cursor = 0;
  for (const s of sentences) {
    const between = original.slice(cursor, s.start);
    cursor = s.end;
    const sOrig = original.slice(s.start, s.end);
    const sMasked = masked.slice(s.start, s.end);
    const sMentions = mentions.filter((m) => m.start >= s.start && m.end <= s.end)
      .map((m) => ({ ...m, start: m.start - s.start, end: m.end - s.start }));
    const asks = /\?["'”’)]*\s*$/.test(sOrig);
    const claims = asks ? [] : findClaims(sMasked);
    const segs = claims.length ? segmentsOf(sMasked) : [];
    const segOf = (pos) => segs.findIndex((g) => pos >= g.start && pos < Math.max(g.end, g.start + 1));

    // The venue a claim is about: the one its own clause names, else the one
    // named before it in the sentence, else the last one before the sentence,
    // else one named after it ("The booths at Thistle & Crust" is the same
    // clause; "Pizza place, and Larkspur Tap is the bar pick" is not).
    const venueAt = (pos, seg) => {
      const inSeg = seg ? sMentions.filter((m) => m.start >= seg.start && m.end <= seg.end) : [];
      const segBefore = inSeg.filter((m) => m.end <= pos).pop();
      if (segBefore) return segBefore.venue;
      if (inSeg.length) return inSeg[0].venue;
      const before = sMentions.filter((m) => m.end <= pos).pop();
      if (before) return before.venue;
      if (lastVenue) return lastVenue;
      const after = sMentions.find((m) => m.start >= pos);
      if (after) return after.venue;
      return firstNamed || onlyVenue;
    };

    const drop = new Set();
    for (const c of claims) {
      const gi = segOf(c.start);
      const seg = gi >= 0 ? segs[gi] : { start: 0, end: sMasked.length };
      const venue = venueAt(c.start, seg);
      if (!venue) continue;
      const segText = sMasked.slice(seg.start, seg.end);
      const outside = segText.slice(0, c.start - seg.start) + ' ' + segText.slice(c.end - seg.start);
      if (DENIES.test(outside)) continue;
      if (c.crowdExempt && CROWD_WORDS.test(outside)) continue;
      if (claimSupported(c, venue)) continue;
      // "than the pizza rush around the corner": a word after a comparison is
      // about what is compared, which can be another venue the turn knows.
      if (COMPARED.test(segText.slice(0, c.start - seg.start)) && venues.some((v) => claimSupported(c, v))) continue;
      removed.push({ kind: c.kind, venue: venue.name });
      if (gi >= 0) {
        drop.add(gi);
        // A clause takes the phrases that hang off it.
        if (!segs[gi].modifier) for (let j = gi + 1; j < segs.length && segs[j].modifier; j++) drop.add(j);
      }
    }

    let rebuilt = sOrig;
    if (drop.size) {
      rebuilt = rebuild(sOrig, segs, drop);
      // The pick (the venue the answer leads with), named only in what went,
      // keeps its name as a sentence of its own. Another venue named only in a
      // removed clause goes with it.
      const lead = firstNamed;
      const said = lead ? sMentions.find((m) => m.venue.key === lead.key) : null;
      const keptMentions = findMentions(rebuilt, venues).map((m) => m.venue.key);
      const namedLater = mentions.some((m) => m.start >= s.end && m.venue.key === (lead && lead.key));
      if (said && !keptMentions.includes(lead.key) && !namedSoFar.has(lead.key) && !namedLater) {
        rebuilt = `${sOrig.slice(said.start, said.end)}.${rebuilt ? ` ${rebuilt}` : ''}`;
      }
    }
    if (rebuilt) {
      pieces.push((pieces.length ? between : between.replace(/^\s+/, '')) + rebuilt);
      for (const m of findMentions(rebuilt, venues)) namedSoFar.add(m.venue.key);
    }
    if (sMentions.length) lastVenue = sMentions[sMentions.length - 1].venue;
  }
  if (!removed.length) return { text: original, removed: [] };
  let out = pieces.join('').replace(/[ \t]+$/g, '');
  if (!out.trim()) {
    // Nothing of it stood. Never an empty answer: the venue it was about.
    const v = firstNamed || lastVenue || onlyVenue || venues[0];
    out = `${v.name}.`;
  }
  return { text: out, removed };
}

// A sentence with segments `drop` taken out, put back together as a plain
// sentence (see WHAT IS REMOVED in the header).
function rebuild(sOrig, segs, drop) {
  const kept = segs.map((g, i) => ({ ...g, i })).filter((g) => !drop.has(g.i));
  if (!kept.length) return '';
  const lastSeg = segs[segs.length - 1];
  const tail = sOrig.slice(lastSeg.start, lastSeg.end);
  const terminator = (/[.!?]+["'”’)]*\s*$/.exec(tail) || [''])[0].trim();
  const startsUpper = /^[\s"'(“]*[A-Z]/.test(sOrig);
  const parts = kept.map((g) => ({ sep: g.sep, body: sOrig.slice(g.start, g.end), i: g.i, modifier: g.modifier }));
  // The first part opens the sentence: no separator, no leading conjunction.
  parts[0].sep = '';
  parts[0].body = parts[0].body.replace(/^\s+/, '').replace(LEADING_CONJ, '');
  if (startsUpper) parts[0].body = parts[0].body.replace(/^([^A-Za-z]*)([a-z])/, (m, pre, ch) => pre + ch.toUpperCase());
  // The list repairs count clauses, not the phrases hanging off them.
  const clauses = parts.filter((p) => !p.modifier);
  // A clause that went from between two that stayed: "A, and B" reads "A and B".
  // Not after a phrase went: "fries in a booth, and the crowd" keeps its comma.
  if (clauses.length === 2) {
    const [a, b] = clauses;
    const clauseBetween = segs.slice(a.i + 1, b.i).some((g) => !g.modifier);
    if (clauseBetween && /^,\s+$/.test(b.sep) && /^and\s/i.test(b.body)) b.sep = ' ';
  }
  // The list's last item went, and with it its "and": the new last item takes it.
  const lastKept = parts[parts.length - 1];
  const droppedAfter = segs.slice(lastKept.i + 1);
  const carriedAnd = droppedAfter.some((g) => !g.modifier && /^and\s/i.test(sOrig.slice(g.start, g.end)));
  if (clauses.length >= 2 && carriedAnd && !lastKept.modifier && /^,\s+$/.test(lastKept.sep) && !LEADING_CONJ.test(lastKept.body)) {
    if (clauses.length === 2) lastKept.sep = ' ';
    lastKept.body = `and ${lastKept.body}`;
  }
  let out = parts.map((p) => p.sep + p.body).join('');
  out = out.replace(/[\s,;:]+$/g, '');
  if (out && !/[.!?]["'”’)]*$/.test(out)) out += terminator;
  return out.trim();
}

module.exports = {
  createVenueFacts,
  noteToolResult,
  notePlan,
  groundVenueDetails,
  // For __tests__/birdieGrounding.test.js.
  __internals: { findClaims, findMentions, splitSentences, segmentsOf, norm, stem, nameForms },
};
