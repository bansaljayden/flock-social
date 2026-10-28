// How owners actually type, put back into the words Roost's cues are written in.
//
// Owners type on a phone between tickets: "how do i get more cusotmers",
// "is doordash worht it", "how to upsel desert". Every cue in the playbook and
// every offline route is written in plain spelling, so one transposed letter
// used to cost the whole answer (2026-10-28 stress test: 4 of 20 phone-typed
// questions found nothing, and "happy hr" was answered with mocktails).
//
// This is a table, not a fuzzy matcher, on purpose. A matcher one edit away
// would read "full" as "fill" and "stuff" as "staff", and both are words owners
// use. Every entry here is a misspelling, a shorthand, or a British form of a
// word a cue or a route depends on, and none of them is a word an owner would
// mean as written. The result is only ever matched against; the owner's own
// words are what the model and the answer see.

const SPELLING = Object.freeze({
  // The room and the people in it
  resturant: 'restaurant', restraunt: 'restaurant', restaraunt: 'restaurant', resteraunt: 'restaurant',
  restuarant: 'restaurant', restarant: 'restaurant', resturaunt: 'restaurant', restaurnt: 'restaurant',
  restaruant: 'restaurant', resturants: 'restaurants', restraunts: 'restaurants', restaraunts: 'restaurants',
  resto: 'restaurant',
  cusotmers: 'customers', custmers: 'customers', costumers: 'customers', customes: 'customers',
  cutomers: 'customers', custumers: 'customers', customrs: 'customers', cusomters: 'customers',
  cusotmer: 'customer', custmer: 'customer', costumer: 'customer', custumer: 'customer', cutomer: 'customer',
  peple: 'people', poeple: 'people', pepole: 'people', peolpe: 'people', ppl: 'people',
  regulers: 'regulars', reguler: 'regular', regualrs: 'regulars', regluars: 'regulars', regualr: 'regular',
  neighbour: 'neighbor', neighbours: 'neighbors',
  // Reviews
  reveiws: 'reviews', reviws: 'reviews', reivews: 'reviews', revews: 'reviews',
  reveiw: 'review', reivew: 'review', reviw: 'review', revew: 'review',
  // Menu, food and drink
  menue: 'menu', menues: 'menus', mneu: 'menu', meun: 'menu',
  desert: 'dessert', deserts: 'desserts', dessrt: 'dessert', desserst: 'desserts',
  appetisers: 'appetizers', appetiser: 'appetizer', appitizers: 'appetizers', appitizer: 'appetizer',
  apetizers: 'appetizers', apetizer: 'appetizer',
  coctails: 'cocktails', coctail: 'cocktail', cocktials: 'cocktails', cocktals: 'cocktails',
  beverege: 'beverage', bevarage: 'beverage', beverge: 'beverage',
  cofee: 'coffee', coffe: 'coffee',
  breakfest: 'breakfast', brekfast: 'breakfast', breakast: 'breakfast', brekkie: 'breakfast',
  lucnh: 'lunch', brucnh: 'brunch',
  kitchn: 'kitchen', kichen: 'kitchen', kitchin: 'kitchen',
  takeaway: 'takeout', takeaways: 'takeout',
  flavour: 'flavor', flavours: 'flavors',
  // Staff
  staf: 'staff', stafff: 'staff', satff: 'staff', stafing: 'staffing',
  quiting: 'quitting',
  employe: 'employee', empolyee: 'employee', employes: 'employees', emploees: 'employees', employess: 'employees',
  severs: 'servers', sever: 'server', servres: 'servers', srevers: 'servers',
  bartendar: 'bartender', bartendars: 'bartenders', bartendor: 'bartender', barternder: 'bartender',
  schedual: 'schedule', scedule: 'schedule', shedule: 'schedule', schdule: 'schedule', scheduel: 'schedule',
  sceduling: 'scheduling', scheduleing: 'scheduling', sheduling: 'scheduling',
  rota: 'schedule', rotas: 'schedules',
  // Days and times
  tuesdy: 'tuesday', tuesdys: 'tuesdays', teusday: 'tuesday', teusdays: 'tuesdays',
  tusday: 'tuesday', tusdays: 'tuesdays', tuseday: 'tuesday', tusedays: 'tuesdays',
  wensday: 'wednesday', wensdays: 'wednesdays', wednsday: 'wednesday', wednsdays: 'wednesdays',
  wendsday: 'wednesday', wendsdays: 'wednesdays', wedensday: 'wednesday', wedensdays: 'wednesdays',
  wednesdy: 'wednesday',
  thrusday: 'thursday', thrusdays: 'thursdays', thursdy: 'thursday', thurday: 'thursday', thurdays: 'thursdays',
  saterday: 'saturday', saterdays: 'saturdays', satruday: 'saturday', saturdy: 'saturday',
  mondy: 'monday', mondys: 'mondays', monady: 'monday',
  firday: 'friday', firdays: 'fridays', fridy: 'friday', friady: 'friday',
  sundy: 'sunday', sundys: 'sundays', sunady: 'sunday',
  weeknd: 'weekend', weeknds: 'weekends', wekend: 'weekend', wekends: 'weekends',
  weekned: 'weekend', weekneds: 'weekends',
  nigths: 'nights', nigth: 'night', nite: 'night', nites: 'nights', tonite: 'tonight',
  weeknite: 'weeknight', weeknites: 'weeknights', weeknigths: 'weeknights',
  yesturday: 'yesterday', yesterdy: 'yesterday',
  tomorow: 'tomorrow', tommorow: 'tomorrow', tommorrow: 'tomorrow', tmrw: 'tomorrow',
  hrs: 'hours',
  thanksgivng: 'thanksgiving', thanksgving: 'thanksgiving', thankgiving: 'thanksgiving', thanksgiveing: 'thanksgiving',
  haloween: 'halloween', hallowen: 'halloween',
  chrismas: 'christmas', christmass: 'christmas', xmas: 'christmas',
  holliday: 'holiday', hollidays: 'holidays', holidy: 'holiday',
  // Running the business
  buisness: 'business', busness: 'business', bussiness: 'business', buisiness: 'business', bizness: 'business',
  biz: 'business',
  busyest: 'busiest', buisiest: 'busiest', busyer: 'busier', buisy: 'busy', busey: 'busy', bizzy: 'busy',
  slamed: 'slammed', slaming: 'slamming',
  emtpy: 'empty', empy: 'empty',
  trafic: 'traffic', traffik: 'traffic',
  revenu: 'revenue', revnue: 'revenue', reveune: 'revenue',
  proffit: 'profit', profitt: 'profit', porfit: 'profit', proffits: 'profits',
  inventroy: 'inventory', inventry: 'inventory', invetory: 'inventory',
  marketting: 'marketing', markting: 'marketing', marekting: 'marketing',
  instagam: 'instagram', instgram: 'instagram', insta: 'instagram', facbook: 'facebook',
  promtion: 'promotion', promotoin: 'promotion', promtions: 'promotions',
  discout: 'discount', discouts: 'discounts', dicount: 'discount', dicounts: 'discounts',
  delievery: 'delivery', delivary: 'delivery', devlivery: 'delivery', delievry: 'delivery', delivey: 'delivery',
  catring: 'catering',
  reservaitons: 'reservations', resevations: 'reservations', reservatons: 'reservations',
  resevation: 'reservation', resos: 'reservations',
  privte: 'private', privat: 'private', pirvate: 'private',
  loyality: 'loyalty', loyaltey: 'loyalty', loyalti: 'loyalty',
  upsel: 'upsell', upseling: 'upselling', upssell: 'upsell',
  prcies: 'prices', pirces: 'prices', prcie: 'price',
  expencive: 'expensive', expesive: 'expensive', cheeper: 'cheaper',
  worht: 'worth', wroth: 'worth',
  tabels: 'tables', tabel: 'table',
  pateo: 'patio', weahter: 'weather', trivea: 'trivia', forcast: 'forecast',
  evnets: 'events', evetns: 'events', evnet: 'event',
  cheque: 'check', cheques: 'checks',
  licence: 'license', programme: 'program', centre: 'center',
  organise: 'organize', organising: 'organizing',
});

const SPELLED = /[a-z]+/g;
const own = (w) => Object.prototype.hasOwnProperty.call(SPELLING, w);

// "Quite" is a real word ("quite busy"), and it is also how "quiet" gets typed.
// At the end of a clause, or before when and where, nobody means "quite":
// "Mondays are quite", "it's quite on Sundays".
const QUITE_AS_QUIET = /\bquite\b(?=\s*(?:[.,!?;:]|$|\s+(?:on|in|at|during|lately|today|tonight|this|these|and|but|so|after|before|until|til|till|between|from|all|every|most|when|now|recently|again|mid\w*)\b))/g;

/**
 * The owner's question in the spelling Roost's cues use. Lowercase, straight
 * apostrophes, and every misspelling in the table above put right. Running it
 * twice changes nothing.
 * @param {string} text
 * @returns {string}
 */
function normalizeOwnerText(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/\bw\//g, 'with ')
    .replace(/\bhappy\s+hr(s?)\b/g, 'happy hour$1')
    .replace(/\b(\d+)\s*hr(s?)\b/g, (m, n, s) => `${n} hour${s}`)
    .replace(QUITE_AS_QUIET, 'quiet')
    // Own keys only: "constructor" is a word too, and the table's prototype
    // would answer it with a function.
    .replace(SPELLED, (w) => (own(w) ? SPELLING[w] : w));
}

module.exports = {
  normalizeOwnerText,
  SPELLING,
};
