// DRINK DEALS GO ONLY TO PEOPLE WE KNOW ARE 21 (App Store Guideline 1.4.3).
//
// Flock's audience starts at 13, and the iPhone app asks for no date of birth
// at all (utils/clientShell.js), so most accounts have no known age. A venue
// promotion or an event about alcohol is served only to an account whose STORED
// date of birth makes it 21 or older today. Everyone else, an account with no
// date of birth included, never receives it: the row is left out of the
// response, not hidden by the screen. The owner's own dashboard still lists
// every promotion it wrote (GET /promotions in routes/venueDashboard.js).
//
// ONE LIST, PINNED. The words are reviewed by hand and __tests__/over21.test.js
// holds them word for word, so adding or dropping one is a visible change with
// a reason beside it, never a drive-by. The list errs toward hiding: "root beer
// float" and "shrimp cocktail" read as drinks here, and the cost of that is a
// food deal that people we do not know are 21 do not see. The opposite mistake
// is a drink deal in front of a 13-year-old.
//
// What is deliberately NOT on it, and why:
//   * "draft" alone, because of every "NFL Draft" watch party. "drafts" and
//     "on draft" are how a bar writes it.
//   * "drink" and "drinks" alone, because a cafe's "holiday drinks" are coffee.
//     "drink special(s)" and "drink deal(s)" are unambiguous. A PRICE on drinks
//     is how a bar writes a drink deal, though ("2-for-1 drinks", "$5 drinks",
//     "half-price drinks", "BOGO drinks"), so drinks next to a deal word count
//     unless the same promotion names a soft drink (DEAL_DRINKS_RE and
//     SOFT_DRINK_RE below): a cafe's "2-for-1 drinks: lattes and teas" still
//     reaches everyone.
//   * "brew", because "cold brew" is coffee. "brewery" and "brewpub" are not.
//   * "spirit" alone (Spirit Halloween, school spirit). "spirits" stays.
//   * "cider", "stout", "porter", "sake": all common words or soft drinks first.
// Tobacco, vape and cannabis words are on the list as well. 1.4.3 names them
// beside alcohol, and 21 is the purchase age for tobacco in the US too, so the
// same rule covers a hookah night with no second mechanism.
const { ageFromDob } = require('./age');

const OVER_21_AGE = 21;

const DRINK_WORDS = Object.freeze([
  // Beer
  'beer', 'beers', 'ale', 'ales', 'ipa', 'ipas', 'lager', 'lagers', 'pilsner', 'pilsners',
  'pint', 'pints', 'drafts', 'on draft', 'cask', 'casks', 'keg', 'kegs',
  'brewery', 'breweries', 'brewpub', 'brewpubs', 'taproom', 'taprooms', 'oktoberfest', 'octoberfest',
  // Wine
  'wine', 'wines', 'winery', 'wineries', 'champagne', 'prosecco', 'mimosa', 'mimosas', 'sangria', 'sangrias',
  // Spirits and mixed drinks
  'spirits', 'liquor', 'liquors', 'whiskey', 'whiskeys', 'whisky', 'whiskies', 'bourbon', 'bourbons',
  'tequila', 'tequilas', 'mezcal', 'vodka', 'vodkas', 'rum', 'rums', 'gin',
  'cocktail', 'cocktails', 'margarita', 'margaritas', 'shots', 'seltzer', 'seltzers',
  // Drinking itself
  'alcohol', 'alcoholic', 'booze', 'boozy', 'happy hour', 'happy hours', 'bottomless',
  'drink special', 'drink specials', 'drink deal', 'drink deals',
  'pub crawl', 'pub crawls', 'bar crawl', 'bar crawls',
  '21+', '21 and over', '21 and up', '21 & over', '21 & up',
]);

const SMOKE_WORDS = Object.freeze([
  'hookah', 'hookahs', 'shisha', 'cigar', 'cigars', 'cigarette', 'cigarettes', 'tobacco',
  'vape', 'vapes', 'vaping', 'nicotine', 'cannabis', 'marijuana', 'thc', 'dispensary', 'dispensaries',
]);

const OVER_21_WORDS = Object.freeze([...DRINK_WORDS, ...SMOKE_WORDS]);

// Whole words only, either case, and a phrase matches with any run of spaces
// or hyphens between its words (or none), so "Happy-Hour" and "#happyhour" are
// both happy hour. The edges are "not a letter or digit" rather than \b, which
// would never fire after the "+" in "21+".
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OVER_21_RE = new RegExp(
  `(?<![a-z0-9])(?:${OVER_21_WORDS.map((w) => escapeRe(w).split(' ').join('[\\s-]*')).join('|')})(?![a-z0-9])`,
  'i'
);

// Drinks with a price on them: a deal word within a few words before "drink(s)",
// or a price within a few words after it. Deal words: "2-for-1" and its
// spellings, BOGO, buy one get one, half price or half off, a dollar price, a
// percentage off, "discounted" and "cheap".
const DEAL = String.raw`(?:(?:\d+|one|two)[\s-]*for[\s-]*(?:\d+|one|two)|bogo|buy[\s-]+one[\s,-]*get[\s-]+one|half[\s-]*(?:price|off)|\$\s*\d+(?:\.\d{1,2})?|\d+\s*%\s*off|discounted|cheap)`;
const DEAL_DRINKS_RE = new RegExp(
  String.raw`(?<![a-z0-9])${DEAL}(?![a-z0-9])(?:[\s,:-]+[a-z0-9'&]+){0,3}?[\s,:-]+drinks?(?![a-z0-9])` +
    String.raw`|(?<![a-z0-9])drinks?(?:[\s,:-]+[a-z0-9'&]+){0,3}?[\s,:-]+${DEAL}(?![a-z0-9])`,
  'i'
);
// A soft drink named anywhere in the same promotion makes its "drinks" coffee,
// tea and the like, and the deal reaches everyone.
const SOFT_DRINK_RE = new RegExp(
  String.raw`(?<![a-z0-9])(?:coffees?|lattes?|espressos?|cappuccinos?|mochas?|teas?|chai|matcha|smoothies?|juices?|lemonades?|sodas?|soft[\s-]*drinks?|milkshakes?|shakes|boba|hot[\s-]*chocolates?|cocoa|mocktails?|frapp(?:e|uccino)s?|cold[\s-]*brews?|kombucha|slushies?|slushes?)(?![a-z0-9])`,
  'i'
);

// Accents folded first, so an accented letter is a letter to the edges above:
// "Ginés" is a name, and unfolded its "é" would end a word and leave "gin".
const fold = (t) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '');

function mentionsOver21(...texts) {
  const folded = texts.filter((t) => typeof t === 'string' && t !== '').map(fold);
  if (folded.some((t) => OVER_21_RE.test(t))) return true;
  // Read together, so a title's "2-for-1 drinks" is excused by a description
  // that says the drinks are lattes.
  const all = folded.join(' \n ');
  return DEAL_DRINKS_RE.test(all) && !SOFT_DRINK_RE.test(all);
}

// Every field a person sees on the promotion. The time slot and the days are
// either a menu value or the owner's own words (the editor's Custom choice),
// and the card prints both as "time slot · days". "Happy Hour" is on the menu,
// and an owner can type it into either box, so any of the four fields saying
// it counts like any other mention of happy hour.
function promotionIsOver21(p) {
  return !!p && mentionsOver21(p.title, p.description, p.time_slot, p.days);
}

// A Ticketmaster event as routes/events.js maps it. Its name, its headliner and
// Ticketmaster's own genre labels. Not `info` or `please_note`: those are where
// a family concert says "no outside alcohol", and reading them would hide it.
function eventIsOver21(e) {
  if (!e) return false;
  const acts = Array.isArray(e.attractions) ? e.attractions.map((a) => a && a.name) : [];
  return mentionsOver21(e.name, e.attraction_name, e.genre, e.subgenre, ...acts);
}

// 21 or older by the stored date of birth. No date, or one that is not a real
// calendar date, is not a known age, and that answer is no.
function knownOver21(dob, now = new Date()) {
  const age = ageFromDob(dob, now);
  return Number.isInteger(age) && age >= OVER_21_AGE;
}

// The viewer's answer, read fresh from users.date_of_birth (req.user carries no
// birthday). Any failure is "not known", which can only hide a drink deal from
// somebody who could have seen it, never show one to somebody who should not.
async function viewerKnownOver21(db, userId) {
  if (!db || userId == null) return false;
  try {
    const { rows } = await db.query('SELECT date_of_birth FROM users WHERE id = $1', [userId]);
    return knownOver21(rows[0] ? rows[0].date_of_birth : null);
  } catch (err) {
    console.error('Viewer age read failed:', err.message);
    return false;
  }
}

module.exports = {
  OVER_21_AGE,
  DRINK_WORDS,
  SMOKE_WORDS,
  OVER_21_WORDS,
  DEAL_DRINKS_RE,
  SOFT_DRINK_RE,
  mentionsOver21,
  promotionIsOver21,
  eventIsOver21,
  knownOver21,
  viewerKnownOver21,
};
