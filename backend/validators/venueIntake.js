// ---------------------------------------------------------------------------
// VENUE INTAKE — the fuller registration form, defined ONCE.
//
// routes/venueProfile.js has two write paths, POST (claim) and PUT (settings),
// and its own comments already say the thing this file exists to enforce:
// "Same shape rule as the create route — the two must not drift." Eighteen
// fields duplicated across two validator arrays is eighteen chances to drift,
// so the rules, the bounds, the enumerations and the column mapping live here
// and both routes import them.
//
// The frontend imports nothing from here (it is a separate bundle), so the
// enumerations are ALSO exported for a test to pin against the option lists in
// frontend/src/App.js. A dropdown offering a value the server refuses is a form
// that 400s on submit, which is the failure mode the maxLength mirroring in the
// existing onboarding steps was added to prevent.
//
// SHAPE BEFORE CONTENT, everywhere — see validators/shape.js. Every scalar gets
// scalarOnly or freeText; the two weekday arrays and the anchor array are
// legitimately structured and get custom() rules, exactly like goals.
//
// WHAT IS NOT HERE, and why:
//   * Nothing is REQUIRED. SLOP-AUDIT §C: "never ask for a pile of personal
//     fields". Every one of these is skippable, and a skipped field means the
//     advisor stays quiet about that subject rather than guessing.
//   * No wait times, no busiest-hour estimate, no "average covers". Owners do
//     not know those to the accuracy that would make an answer better, and a
//     field whose answer is a guess is worse than an empty one: it reads as
//     measurement.
// ---------------------------------------------------------------------------

const { body } = require('express-validator');
const { scalarOnly, freeText } = require('./shape');

// int2 is the ceiling on four of these columns and int4 on capacity. The
// venueDashboard.js lesson (`capacity: 3000000000` was a 22003 from Postgres,
// i.e. a 500 for a plainly bad request) applies to every numeric here: bound
// it in the validator or the column bounds it with an exception.
const BOUNDS = {
  capacity: { min: 1, max: 20000 },
  largestWalkinGroup: { min: 1, max: 200 },
  typicalDwellMinutes: { min: 10, max: 600 },
  typicalSpendPerPerson: { min: 1, max: 1000 },
};

const MAX_EVENT_NOTE = 120;
const MAX_ANCHOR_NOTE = 200;
const MAX_QUIRKS = 1000;
const MAX_ANCHOR_TYPES = 6;

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const SERVICE_STYLES = [
  'seated_table',    // hosted, they sit you
  'counter_order',   // order at the counter, sit anywhere
  'bar_standing',    // mostly standing, order at the bar
  'mixed',
];

const RESERVATION_POLICIES = [
  'walk_in_only',
  'reservations_accepted',
  'reservations_required',
];

// The restriction, not the schedule. `age_restricted_after` says when it
// starts; null there means it applies all day.
const AGE_POLICIES = ['all_ages', 'eighteen_plus', 'twenty_one_plus'];

// What is NEXT DOOR, in the only vocabulary that is useful: a kind of demand
// event whose calendar somebody can go and look up. Deliberately a fixed list
// rather than free text, because "arena" and "the stadium" and "Lincoln
// Financial Field" are one fact and three strings.
const ANCHOR_TYPES = [
  'stadium_arena',
  'college_campus',
  'transit_hub',
  'office_district',
  'theater_music_hall',
  'hotel_cluster',
  'beach_boardwalk',
  'nightlife_strip',
  'highway_stop',
  'hospital',
  'shopping_center',
];

// 24-hour HH:MM. Not a TIME column (see migration 030), so the shape is this
// regex's job and nothing else's.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ─── Rule builders ───────────────────────────────────────────────────────────

// '' means "leave it alone" on this router — every field below is spelled into
// a COALESCE and a client that round-trips a blank must not 400. So every rule
// accepts the empty string and the write path maps it to null.
const optionalEnum = (field, label, allowed) =>
  scalarOnly(body(field).optional({ nullable: true }), label).trim()
    .custom((v) => v === '' || allowed.includes(v))
    .withMessage(`${label} must be one of: ${allowed.join(', ')}`);

const optionalInt = (field, label, { min, max }) =>
  scalarOnly(body(field).optional({ nullable: true }), label)
    .custom((v) => {
      if (v === '' || v === null || v === undefined) return true;
      // Hand-rolled rather than isInt(): isInt() coerces, so `true` passes as 1
      // and "90.5" would silently truncate into a column the owner then reads
      // back as a number they did not type. Bounded on BOTH ends for the
      // venueDashboard.js reason — an unbounded max is a 22003 from Postgres,
      // i.e. a 500 for a plainly bad request.
      if (typeof v === 'boolean') return false;
      const n = Number(v);
      return Number.isInteger(n) && n >= min && n <= max;
    })
    .withMessage(`${label} must be a whole number between ${min} and ${max}`);

const optionalTime = (field, label) =>
  scalarOnly(body(field).optional({ nullable: true }), label).trim()
    .custom((v) => v === '' || HHMM_RE.test(v))
    .withMessage(`${label} must be a time like 21:30`);

const optionalBool = (field, label) =>
  scalarOnly(body(field).optional({ nullable: true }), label)
    .custom((v) => v === null || v === undefined || typeof v === 'boolean')
    .withMessage(`${label} must be yes or no`);

// A set, stored as an array. Order is normalised to WEEKDAYS/ANCHOR_TYPES order
// at the write, so ["friday","monday"] and ["monday","friday"] are one value and
// the dashboard cannot render the owner's clicks back to them shuffled.
const optionalSet = (field, label, allowed, max) =>
  body(field).optional({ nullable: true }).custom((v) => {
    if (!Array.isArray(v)) throw new Error(`${label} must be a list`);
    if (v.length > max) throw new Error(`Too many ${label} (max ${max})`);
    for (const item of v) {
      if (typeof item !== 'string' || !allowed.includes(item)) {
        throw new Error(`${label} must be chosen from the list`);
      }
    }
    return true;
  });

// The three owner-typed strings. freeText settles the shape and strips markup;
// what the WORDS say is a different question, answered by rejectIfProfane at
// the handler, exactly as routes/venueDashboard.js does for the three strings
// on a venue event. See screenIntakeText below.
const optionalProse = (field, label, max) =>
  freeText(body(field).optional({ nullable: true }), label)
    .isLength({ max }).withMessage(`${label} is too long (max ${max} characters)`);

// The full chain, in one array, for both routes.
const intakeRules = [
  optionalInt('capacity', 'Capacity', BOUNDS.capacity),
  optionalEnum('serviceStyle', 'Service style', SERVICE_STYLES),
  optionalEnum('reservationPolicy', 'Reservation policy', RESERVATION_POLICIES),
  optionalInt('largestWalkinGroup', 'Largest walk-in group', BOUNDS.largestWalkinGroup),
  optionalInt('typicalDwellMinutes', 'Typical visit length', BOUNDS.typicalDwellMinutes),
  optionalInt('typicalSpendPerPerson', 'Typical spend per person', BOUNDS.typicalSpendPerPerson),
  optionalBool('hasOutdoorSeating', 'Outdoor seating'),
  optionalTime('kitchenLastOrder', 'Kitchen last order'),
  optionalTime('lastCall', 'Last call'),
  optionalEnum('agePolicy', 'Age policy', AGE_POLICIES),
  optionalTime('ageRestrictedAfter', 'Age restriction start time'),
  optionalSet('eventNights', 'event nights', WEEKDAYS, WEEKDAYS.length),
  optionalProse('eventNote', 'What runs on those nights', MAX_EVENT_NOTE),
  optionalSet('ownerBusyNights', 'busy nights', WEEKDAYS, WEEKDAYS.length),
  optionalEnum('targetNight', 'Night you want fuller', WEEKDAYS),
  optionalSet('anchorTypes', 'nearby anchors', ANCHOR_TYPES, MAX_ANCHOR_TYPES),
  optionalProse('anchorNote', 'Nearby anchor detail', MAX_ANCHOR_NOTE),
  optionalProse('quirks', 'What a stranger would not guess', MAX_QUIRKS),
];

// The owner-typed strings, named once. The handler screens exactly these.
const INTAKE_TEXT_FIELDS = ['eventNote', 'anchorNote', 'quirks'];

// ─── Body -> columns ─────────────────────────────────────────────────────────
//
// body key -> [column, coerce]. A key ABSENT from the body leaves its column
// alone; a key present but empty ('' / null) CLEARS it. That asymmetry is
// deliberate and it is the difference between this and the fields above it on
// the route: businessName is a COALESCE because there is no such thing as a
// venue with no name, but "we do not serve food" has to be expressible, and the
// only way an owner clears a field they filled in by mistake is if empty means
// empty.
const COLUMNS = {
  capacity: ['capacity', (v) => Number(v)],
  serviceStyle: ['service_style', (v) => v],
  reservationPolicy: ['reservation_policy', (v) => v],
  largestWalkinGroup: ['largest_walkin_group', (v) => Number(v)],
  typicalDwellMinutes: ['typical_dwell_minutes', (v) => Number(v)],
  typicalSpendPerPerson: ['typical_spend_per_person', (v) => Number(v)],
  hasOutdoorSeating: ['has_outdoor_seating', (v) => v],
  kitchenLastOrder: ['kitchen_last_order', (v) => v],
  lastCall: ['last_call', (v) => v],
  agePolicy: ['age_policy', (v) => v],
  ageRestrictedAfter: ['age_restricted_after', (v) => v],
  eventNights: ['event_nights', (v) => orderedSet(v, WEEKDAYS)],
  eventNote: ['event_note', (v) => v],
  ownerBusyNights: ['owner_busy_nights', (v) => orderedSet(v, WEEKDAYS)],
  targetNight: ['target_night', (v) => v],
  anchorTypes: ['anchor_types', (v) => orderedSet(v, ANCHOR_TYPES)],
  anchorNote: ['anchor_note', (v) => v],
  quirks: ['quirks', (v) => v],
};

function orderedSet(list, order) {
  const present = new Set(list);
  return order.filter((k) => present.has(k));
}

const isEmptyValue = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Turn a request body into SET fragments for an UPDATE on venue_profiles.
 *
 * Pushes onto `params` and returns the fragments; the caller decides the
 * statement around them and appends the WHERE parameter LAST, so the numbering
 * cannot go stale when a field is added to COLUMNS.
 *
 * A contradiction is made unrepresentable rather than merely refused: setting
 * agePolicy to 'all_ages' also clears age_restricted_after, because "everyone
 * is welcome, after 22:00" is a stored value an advisor would read out loud.
 *
 * @param {object} bodyIn  req.body, already validated
 * @param {Array} params   the parameter array being built (mutated)
 * @returns {string[]} SET fragments, possibly empty
 */
function buildIntakeSet(bodyIn, params) {
  const sets = [];
  const src = { ...(bodyIn && typeof bodyIn === 'object' && !Array.isArray(bodyIn) ? bodyIn : {}) };

  // The contradiction guard, applied to the INPUT rather than patched into the
  // statement afterwards. Only fires when this request is the one setting the
  // policy, so a PUT that never mentions agePolicy cannot silently wipe a time
  // the owner set in an earlier save.
  if (src.agePolicy === 'all_ages') src.ageRestrictedAfter = null;

  for (const [key, [column, coerce]] of Object.entries(COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const raw = src[key];
    const value = isEmptyValue(raw) ? null : coerce(raw);
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  return sets;
}

/** The columns this module owns, for a SELECT list or a test. */
const INTAKE_COLUMNS = Object.values(COLUMNS).map(([c]) => c);

module.exports = {
  intakeRules,
  buildIntakeSet,
  INTAKE_TEXT_FIELDS,
  INTAKE_COLUMNS,
  BOUNDS,
  MAX_EVENT_NOTE,
  MAX_ANCHOR_NOTE,
  MAX_QUIRKS,
  MAX_ANCHOR_TYPES,
  WEEKDAYS,
  SERVICE_STYLES,
  RESERVATION_POLICIES,
  AGE_POLICIES,
  ANCHOR_TYPES,
  HHMM_RE,
};
