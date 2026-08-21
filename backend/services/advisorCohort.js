// ---------------------------------------------------------------------------
// COHORT DIFFERENCING — "was it just us, or was everyone slow?"
//
// The highest-engagement question in the operator category (ROOST-OWNER-INPUT
// §1, question class 2: twelve forum threads, the largest comment counts in
// the corpus, and absent from Toast's own prompt telemetry because a
// single-tenant POS structurally cannot answer it). An operator comparing
// themselves to their own past has a POS for that. An operator asking whether
// the whole street was down has nothing, anywhere, and that is the one shape
// Flock's data can serve that theirs cannot.
//
// TWO HALVES, on purpose, split exactly where ADVISOR-WHY-LAYER.md §D5/D6
// splits them, because pretending they are one thing is how a thin cohort
// number gets shipped as a real one.
//
//   HALF A (buildCohortStanding) — TYPICALS, computable today, zero users.
//     ml_venue_baselines joined to ml_venues on (city, venue_category): the
//     distribution of Google-derived curves across the venue's cohort at one
//     day-of-week and hour, and where this venue's own curve sits inside it.
//     Answers "am I usually the quiet one here". Says NOTHING about any
//     specific night, and the copy holds that line: "your typical Friday 9 PM
//     sits in the bottom third" is legal, "you underperformed last Friday" is
//     a lie built from the same rows.
//
//   HALF B (buildCohortSameNight) — ACTUALS, gated on density.
//     Other venues' owner readings (migration 031) for the same night and the
//     same hour band. This is the actual moat. It answers today with a
//     refusal, and it switches itself on the first night five venues in one
//     city and category post a reading. Nothing here is flag-gated: the floor
//     IS the flag, and it is checked against live data on every call.
//
// THE FROZEN CORPUS IS NEVER SPOKEN AS CURRENT. Every half-A fact carries
// advisorFacts.CORPUS_AS_OF (2026-05-18, collected spring 2026) and its label
// says so in words. The corpus is 812 venues in Lehigh Valley, 1,103 in
// Philadelphia, and ten weeks of one spring; an August sentence that quotes it
// without its date is an invented statistic in slow motion.
//
// ── PRIVACY: THE FLOOR, AND WHY IT IS HIGHER THAN THE HOUSE FLOOR ───────────
//
// The repo already has a k-anonymity floor for aggregates over identifiable
// reporters: crowdEngine.MIN_CALIBRATION_REPORTERS = 3, reused by
// routes/venueDashboard.js for the verified-user-report average on the venue's
// own panel. Three is right THERE and wrong HERE, and the difference is who is
// being protected:
//
//   * There, the population is Flock USERS who walked into one building. The
//     owner can guess at them but the set is unbounded and unlisted.
//   * Here, the population is VENUES. A venue is a pin on a public map with a
//     name, a category and an address. An owner can enumerate every bar in
//     their city and category by eye. A statistic over an enumerable
//     population is much closer to naming its members than the same statistic
//     over an anonymous one, and the values being aggregated are a competitor's
//     own business data, which is a different class of secret from a stranger's
//     three-level crowd vote.
//
// So the floor is FIVE, per ROOST-OWNER-INPUT §5 ("any cohort or comparison
// sentence before five reporting venues" is on the do-not-build list) and
// ADVISOR-WHY-LAYER §D5, and it is applied to five venues OTHER than the
// asking venue. ROOST's own wording is "5 distinct reporting venues including
// you, so at least 4 others"; this module requires 5 others, which is that
// floor raised by one, for a reason that costs nothing: the asking venue
// already knows its own reading, so including it in the median hands the
// attacker one of the values for free. Excluding it means every value behind
// the published number is unknown to the reader.
//
// WHAT IS PUBLISHED: the median, and a FLOOR on the number of reporting owners
// ("at least five", "at least ten"), never the count itself. That is the whole
// list. Never a per-venue value, never a name, never a rank, never a min, max,
// range, spread or any other quantile. The extremes are the dangerous ones: a
// maximum IS one venue's exact reading, attributed to the venue anyone would
// guess. The per-venue values do not even cross the SQL boundary into
// JavaScript (see cohortNightAggregate): the aggregation happens inside the
// query and this process only ever holds counts and a median.
//
// The exact count used to be published and is not any more. A count that moves
// by one is a report card on which of an owner's named neighbours posted last
// night, readable by anyone who can read a map, and it is the signal that makes
// every join and every departure below observable one at a time. A bucket floor
// still does the only honest job the count was doing on the card, which is
// telling the owner the number is not built on two venues.
//
// ── THE DIFFERENCING ATTACK, WORKED THROUGH ────────────────────────────────
//
// Threat: an owner watches the published statistic while the reporting set
// changes, and backs out one competitor's reading. Five structural answers,
// in the order they bite:
//
//   1. MEDIAN, NEVER MEAN. A mean is exactly invertible: given n, mean(n) and
//      mean(n+1), the joiner's value is (n+1)*mean(n+1) - n*mean(n), with no
//      error term at all. A median is bounded-influence: one arrival moves it
//      at most to the next order statistic and leaks one bit ("the new value
//      fell above or below the old middle"), never a value. This is the single
//      reason the statistic is a median, and it is why no mean, sum or total
//      may ever be added to the payload.
//
//   2. THE WINDOW IS CLOSED BEFORE IT IS PUBLISHED. Half B answers only about
//      a local date that has already ended (`night < today` on the venue's own
//      clock). A live, still-filling window is a ticker: poll it and you watch
//      each venue arrive one at a time, which is the join sequence the whole
//      attack needs. A closed window has no arrivals left to watch. This also
//      happens to be the honest product shape, since the question is
//      retrospective by nature.
//
//   3. THE COHORT KEY IS SERVER-DERIVED AND HAS NO KNOBS. City and category
//      come from the asking venue's own ml_venues row; the hour band is snapped
//      to a FIXED three-hour grid (00-02, 03-05, ... 21-23) rather than
//      centered on anything the caller can move. POST /ask accepts one key,
//      `intentId`, and rejects any other body key with a 400 before a value is
//      read, so there is no radius, no date, no category and no window
//      parameter to sweep. An attacker cannot construct two cohorts whose
//      difference is one venue, which is the classic set-differencing move.
//      A sliding band would have handed it to them: two overlapping windows
//      differing by one hour isolate whoever reported in that hour. A fixed
//      grid means any two venues' bands are identical or disjoint, never
//      offset by one.
//
//   4. COARSENING. The median is rounded to the nearest 5 points on the 0-100
//      index before it leaves this module. The one bit a join leaks usually
//      moves the published number by nothing at all, and anything inferred
//      about an individual is at best "somewhere on one side of a five-point
//      bucket".
//
//   5. THE COUNT IS NEVER EXACT, AND IT IS NOT NARRATED AT ALL BELOW THE FLOOR.
//      Above the floor the card says "at least five"; the exact number never
//      leaves this module. Below it, the refusal names the floor (five) and
//      never the current number of reporters. "Three more venues would unlock
//      this" tells an owner who can read a map that exactly two of their named
//      neighbours posted a reading last night, which is participation
//      disclosure with a growth-loop bow on it. The refusal says what the floor
//      is, what would clear it, and that we deliberately do not say how close
//      it is.
//
//   6. THE FLOOR IS COUNTED IN OWNERS, NOT IN VENUES, and every venue one owner
//      holds collapses to ONE value before the median is taken. A cohort is
//      five independent businesses or it is not a cohort. Today
//      venue_profiles.user_id is UNIQUE, so one account holds at most one
//      verified venue and the two counts are the same number; the constraint is
//      written in owners anyway, because the day a group operator claims three
//      bars in one city is the day a venue-counted floor of five quietly becomes
//      an owner-counted floor of three. See the OPEN PRODUCT QUESTION below.
//
//   7. THE MIDDLE HAS TO BE SUPPORTED. Guards 1 to 6 all assume the reporting
//      set is not mostly one party's construction, and five accounts defeat all
//      of them at once. Post two readings at 0, two at 100, ask from a fifth
//      venue, and the sorted set is [0, 0, target, 100, 100], whose median IS
//      the one honest venue's reading, rounded to our own grid. The median is
//      not being inverted there, it is being POSITIONED, and bounded influence
//      is worth nothing when the neighbours on both sides were chosen. So the
//      number we are about to print has to be one that several reporters could
//      have supplied. Two conditions, and the value has to pass both:
//
//        a. MIN_MEDIAN_SUPPORT (3) reporters sit within MEDIAN_SUPPORT_WINDOW
//           (15 points) of the number about to be printed, and
//        b. it sits INSIDE that company rather than at the edge of it. Either
//           MIN_MEDIAN_FLANK (1) reporter falls a clear step under it and
//           another a clear step over it, both still inside the window, or three
//           reporters hold the number itself and the whole reporting set fits
//           inside one window, which is what an ordinary flat street looks like.
//           "A clear step" means further from it than half the publishing grid,
//           which is what keeps the reporter the median was TAKEN from out of
//           its own flank count: a target of 6 sandwiched between two zeroes
//           publishes as 5, and counting the 6 as the value above the 5 would
//           have let it prop itself up.
//
//      A sandwich fails (a) by construction, since the entire purpose of the
//      outer values is to be nowhere near the middle. (b) is what closes the
//      ends. Counted as a total alone, [0, 0, target, 100, 100] still published
//      whenever the target reported a nearly empty room: at a target of 10 the
//      two zeroes are inside the window, the count reaches three, and the card
//      prints the target's own reading. At a target of exactly 0 the three
//      zeroes even look like a cluster. Requiring company on both sides, or a
//      genuinely tight set, says a printed value has to be surrounded rather
//      than propped up from one direction, and a jaw is only ever on one side of
//      the thing it pins. An ordinary night, where venues in one city and one
//      category on one Friday sit in a cluster, clears both without noticing,
//      and so does a flat night where every venue reports the same number.
//
//      The cost is a real one and it is worth naming: a genuinely lopsided
//      honest night, three venues at 0 and two at 25, is refused as well. The
//      published number there would be one venue's own reading held up by two
//      venues sitting underneath nothing. We would rather lose that night's
//      card than print it.
//
// RESIDUAL, stated rather than hidden:
//
//   * A retraction after publication (031 rows can be retracted at any time)
//     removes one value from a window an owner may already have read, and
//     re-reading shows the change. Guards 1, 4 and 5 bound what that reveals to
//     one bit inside a five-point bucket, and dropping under the floor refuses
//     outright rather than publishing a thinner number.
//   * Guard 7 stops the WIDE sandwich, not the narrow one. An attacker who
//     already believes the target sits near 55 can set the jaws at 45 and 65
//     instead of 0 and 100: the support test passes and the published median
//     confirms the guess to the five-point grid. What the narrow version costs
//     them is everything the wide one did not: four verified venues in one city
//     and category under four separate accounts, a prior belief already accurate
//     to about fifteen points, and one probe per night, since readings are
//     stamped with the clock and a finished night cannot be re-entered. That
//     turns exact recovery from a standing start into confirmation of something
//     already suspected. It is a real residual, and what bounds it is how
//     expensive a verified venue account is, which is a verification problem
//     rather than an aggregation one.
//   * Two colluding owners in different bands can learn that somebody reported
//     in one band and not another. Participation-shaped, bounded, no value.
//   * Half A has no such surface at all: the corpus is frozen, so its cohort has
//     no joins or departures to difference.
//
// ── ONE REFUSAL, ONE SENTENCE ──────────────────────────────────────────────
//
// Half B has two ways to decline, too few owners and an unsupported middle, and
// exactly ONE refusal, with one id and one wording. A refusal that said which
// test failed would hand back the fact it was protecting: "there were enough of
// you, the readings were simply far apart" is a statement about the shape of
// that night's distribution, handed to somebody we have just decided may not
// see the middle of it. Worse, it restores the on/off signal guard 7 exists to
// remove, since the attacker learns their sandwich landed and only the support
// test caught it. The copy names both conditions and never says which one bit.
//
// ── OPEN PRODUCT QUESTION (Jayden's call, not this module's) ────────────────
//
// Should cohort membership be owner-grouped? This module already is: one owner
// contributes one value however many venues they hold, and the floor counts
// owners. That is the conservative reading and it costs nothing today, because
// venue_profiles.user_id is UNIQUE, so no owner holds two verified venues and
// the two ways of counting give the same number. If multi-venue operators are
// ever supported the choice starts to matter, and it is a product call:
//   * KEEP THIS (one value per owner). A three-bar operator moves the street
//     number no more than any single independent does, and a floor of five means
//     five separate businesses. Their own bars stay out of their own answer,
//     which is right, since they already know all three numbers.
//   * CHANGE IT (one value per venue). The cohort fills faster in thin cities
//     and reads more like the word "venues" that the card uses. The cost is that
//     five venues can be three parties, and the floor stops meaning what the
//     privacy note above says it means.
// Changing it means changing the GROUP BY in cohortNightAggregate and the
// wording of the count sentence. Nothing else in this module moves.
//
// ── WHY THERE IS NO RADIUS VARIANT ─────────────────────────────────────────
//
// The "this block" version is the one owners would ask for and it is the one
// that cannot be made safe here. A radius cohort is an ENUMERABLE set: an
// owner looking at a 400 m circle on a map can list every venue inside it by
// name, so "the median of five venues within 400 m" is the median of five
// named businesses, and with four of them known or guessed the fifth is
// solved. Worse, a radius is a dial, and a dial is a differencing instrument:
// widen it until the count ticks up and the venue that just entered the circle
// is the one whose reading moved the median. A city-and-category cohort in
// this corpus spans hundreds of venues (812 Lehigh Valley, 1,103
// Philadelphia), so its membership is not enumerable by eye and its boundary
// is not something the caller can move. City plus category is therefore the
// only geographic scope this module offers, and adding a radius later would
// need a different privacy mechanism, not a smaller number.
//
// NO NAMES, NO RANKS, NO LEADERBOARD. Nothing in this file selects a venue
// name, and the hard refusal class for competitor comparisons
// (advisorFacts.HARD_REFUSALS.competitorComparison) is unchanged and still
// covers "why is X busier than us". A cohort median is a fact about a street.
// An ordering of venues is a scoreboard, and a scoreboard is a product Flock
// has decided not to build.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { CITIES } = require('../scripts/ml/config');
const { venueNoun } = require('../utils/venueLabel');

// advisorFacts is required lazily. This module builds every one of its outputs
// through that module's constructors, and that module reaches this one through
// a lazy wrapper of its own; resolving either at load time would close the
// cycle. By the time any function here runs, advisorFacts is fully loaded.
let _facts = null;
function F() {
  if (!_facts) _facts = require('./advisorFacts');
  return _facts;
}

// ─── The floors ─────────────────────────────────────────────────────────────

// Half B. Distinct OWNERS other than the asking one that must have posted a
// reading for the same night and band before any cohort number is published.
// See the privacy section above: higher than crowdEngine's
// MIN_CALIBRATION_REPORTERS = 3, since venues are identifiable from a map, and
// counted in owners rather than in venues per guard 6.
const MIN_COHORT_REPORTERS = 5;

// Half B, guard 7. The published median has to be a value at least this many
// reporters could have supplied. Three is the same k the house uses for
// aggregates over identifiable reporters, applied here to the VALUE rather than
// to the set: if three reporters sit within the window of the number on the
// card, that number names none of them.
const MIN_MEDIAN_SUPPORT = 3;

// And how many supporters have to sit a clear step out on each side of the
// published value, inside the same window. This is the half that stops a
// sandwich whose target happened to report near one of the jaws: supporters all
// crowded below the number mean the number is the top edge of a cluster, which
// is where a pinned value sits. A clear step is more than half the publishing
// grid, so the reporter the median was taken from cannot count as its own
// flank. A flat street has nobody out on either side and clears the guard
// through the tight-set branch instead. See guard 7.
const MIN_MEDIAN_FLANK = 1;

// How near the published median a reading has to be to count as supporting it,
// on the 0-100 index. Fifteen is three times the publishing grid, which is wide
// enough that an ordinary Friday cluster in one city and category clears it and
// narrow enough that a sandwich built to pin the middle does not: jaws inside 15
// points of the target are jaws whose owner already knew the answer to 15
// points. Widening this weakens guard 7 in direct proportion.
const MEDIAN_SUPPORT_WINDOW = 15;

// The count of reporting owners is published as the largest of these it reaches,
// never as itself. Guard 5: an exact count is the differencing signal.
const REPORTER_COUNT_BUCKETS = [5, 10, 25, 50, 100];

// Half A. Corpus venues that must sit in the (city, category, day, hour) cell
// before a position inside it means anything. This floor is statistical rather
// than privacy-driven: the values are Google's published popular-times curves,
// which are not any venue's private business data, and the corpus is frozen so
// the cell cannot be differenced. Ten is the number at which the thirds this
// module reports carry at least three venues each, so one venue does not own a
// band.
const MIN_COHORT_CORPUS_VENUES = 10;

// The published median is rounded to this grid. Guard 4 above.
const MEDIAN_ROUND_TO = 5;

// The fixed hour grid. Bands are 00-02, 03-05, ... 21-23, the same boundaries
// for every venue in every city. Guard 3 above: a band an attacker can slide
// is a band an attacker can difference.
const BAND_HOURS = 3;

// How far back half B will look for a completed day the venue itself reported
// on. Long enough that a Friday question still works on the following
// Thursday, short enough that "last night" stays a recent memory.
const OWN_READING_LOOKBACK_DAYS = 14;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hour12(h) {
  const n = ((Number(h) % 24) + 24) % 24;
  const period = n >= 12 ? 'PM' : 'AM';
  const display = n === 0 ? 12 : n > 12 ? n - 12 : n;
  return `${display} ${period}`;
}

// TOTAL, because a NaN band is a published NaN. Number(undefined) is NaN and
// NaN survives every arithmetic step below, so an unreadable hour used to come
// out as { from: NaN, to: NaN }, which JSON.stringify writes as null in the
// payload and hour12 renders as "NaN AM to NaN AM" in the owner's sentence.
// Callers get null here and are expected to refuse rather than publish a band
// nobody can read; see buildCohortSameNight.
function bandFor(hour) {
  const raw = Number(hour);
  if (!Number.isFinite(raw)) return null;
  const h = ((raw % 24) + 24) % 24;
  const from = Math.floor(h / BAND_HOURS) * BAND_HOURS;
  return { from, to: from + BAND_HOURS - 1 };
}

function roundToGrid(value) {
  return Math.round(Number(value) / MEDIAN_ROUND_TO) * MEDIAN_ROUND_TO;
}

/**
 * The largest bucket the reporting-owner count reaches. Guard 5: what goes on
 * the card is "at least five", not "six", so a venue joining or leaving the
 * reporting set moves the published sentence on bucket boundaries only.
 */
function reporterFloor(count) {
  const n = Number(count);
  let floor = REPORTER_COUNT_BUCKETS[0];
  for (const bucket of REPORTER_COUNT_BUCKETS) {
    if (n >= bucket) floor = bucket;
  }
  return floor;
}

/** 'YYYY-MM-DD' on the venue's own wall clock. */
function localDateStr(timeZone, at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * 'YYYY-MM-DD' from whatever the driver hands back. pg parses a DATE column
 * into a Date at LOCAL midnight, so String(row.night) is "Thu Aug 14 2026 ..."
 * and toISOString() is the previous day anywhere east of Greenwich. Reading the
 * local parts is right on both counts, and it is the same date the query
 * grouped by.
 */
function toDateStr(v) {
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

/**
 * The city as a person would say it. ml_venues.city holds a CITIES key
 * ('lehigh', 'philly'); anything else is a database value we did not write, so
 * it goes through the same fence the vendor strings use.
 */
function cityWords(cityKey) {
  const known = CITIES[cityKey];
  if (known && known.name) return known.name;
  return F().externalText(cityKey, { max: 40 }) || 'your city';
}

/** 'bars', 'cafes', 'breweries'. The 13-token vocabulary lives in venueLabel. */
function categoryWords(category) {
  const noun = venueNoun(category);
  if (!noun) return 'venues';
  return /y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}

/** bottom / middle / top third, which is all a percentile is worth here. */
function bandWords(percentile) {
  if (percentile <= 33) return 'the bottom third';
  if (percentile >= 67) return 'the top third';
  return 'the middle third';
}

// ─── Shared refusals ────────────────────────────────────────────────────────

function refuseNoMembership() {
  return F().makeRefusal({
    id: 'refuse_no_cohort_membership',
    reason: 'This venue is not on our measured map, so there is no city and category group to place it in. A cohort needs a city and a category we hold for you, and we hold neither.',
    whatWouldUnlock: 'This venue entering our measured corpus, which happens on our side with a collection run, not with anything on yours. Your own slider readings build history that does not wait on it.',
  });
}

// ─── The cohort key ─────────────────────────────────────────────────────────
//
// Server-derived, always. Nothing about the cohort is ever taken from a
// request: the caller supplies an intent id and this reads the rest from the
// venue's own corpus row. Guard 3.
async function cohortKey(placeId) {
  if (!placeId) return null;
  const { rows } = await pool.query(
    `SELECT city, venue_category FROM ml_venues WHERE google_place_id = $1`,
    [placeId]
  );
  const row = rows[0];
  if (!row || !row.city || !row.venue_category) return null;
  return { city: row.city, category: row.venue_category };
}

// ═══ HALF A ═════════════════════════════════════════════════════════════════
//
// Where this venue's own TYPICAL sits inside its city and category cohort, at
// the venue's own strongest slot. Computable today from the frozen corpus with
// zero users and zero paid calls.

/**
 * Aggregates only. `you` is the asking venue's own baseline, which it already
 * owns; `below` and `tied` are counts, never values.
 *
 * baseline > 0 filters the cell to venues the corpus measured as OPEN at that
 * hour. Including the closed ones would compare a Friday 9 PM bar against
 * every cafe that shut at four and report it as strength.
 */
async function cohortBaselineCell({ city, category, day, hour, you }) {
  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT b.google_place_id, b.baseline::numeric AS baseline
         FROM ml_venue_baselines b
         JOIN ml_venues v ON v.google_place_id = b.google_place_id
        WHERE v.city = $1
          AND v.venue_category = $2
          AND b.day_of_week = $3
          AND b.hour = $4
          AND b.baseline > 0
     )
     SELECT COUNT(*)::int AS venues,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY baseline) AS median_baseline,
            COUNT(*) FILTER (WHERE baseline < $5)::int AS below,
            COUNT(*) FILTER (WHERE baseline = $5)::int AS tied
       FROM cohort`,
    [city, category, day, hour, you]
  );
  const r = rows[0] || {};
  return {
    venues: Number(r.venues || 0),
    medianBaseline: r.median_baseline != null ? Number(r.median_baseline) : null,
    below: Number(r.below || 0),
    tied: Number(r.tied || 0),
  };
}

async function buildCohortStanding(ctx, { now = new Date() } = {}) {
  const facts = F();
  const placeId = ctx.profile.google_place_id;

  // Model-backed and vendor-baseline-backed facts share one gate, and for the
  // modal venue (030's header: absent from ml_venues is the normal case) the
  // gate's refusal IS the screen.
  const gate = facts.corpusGate(ctx.profile);
  if (gate) return [gate];

  const key = await cohortKey(placeId);
  if (!key) return [refuseNoMembership()];

  const curve = await facts.fetchBaselineCurve(placeId);
  let mine = null;
  for (const row of curve) {
    if (row.day < 0 || row.day > 6 || !(row.baseline > 0)) continue;
    if (!mine || row.baseline > mine.baseline) mine = row;
  }
  if (!mine) {
    return [facts.makeRefusal({
      id: 'refuse_no_curve_slot',
      reason: 'Your own weekly curve does not show a busiest hour we can compare, so there is no slot to place you in.',
      whatWouldUnlock: 'A curve for this venue with measured activity in it. That arrives with a corpus rebuild on our side.',
    })];
  }

  const cell = await cohortBaselineCell({
    city: key.city, category: key.category, day: mine.day, hour: mine.hour, you: mine.baseline,
  });

  const cityName = cityWords(key.city);
  const plural = categoryWords(key.category);
  const weekday = WEEKDAY_NAMES[mine.day];
  const when = `${weekday} ${hour12(mine.hour)}`;

  if (cell.venues < MIN_COHORT_CORPUS_VENUES || cell.medianBaseline == null) {
    return [facts.makeRefusal({
      id: 'refuse_cohort_cell_thin',
      reason: `We hold fewer than ${MIN_COHORT_CORPUS_VENUES} ${cityName} ${plural} that our corpus measured as open at ${when}. A position inside a group that small is an anecdote with a percentage sign on it, so we do not state one.`,
      whatWouldUnlock: `More ${plural} in ${cityName} inside our measured corpus. Collection has been frozen since 2026-05-18, so this one grows on our side rather than yours.`,
    })];
  }

  // Rank without ever printing a value that is not this venue's own: the count
  // below plus half the ties, over the cell. Mid-rank on ties so a cluster of
  // identical curves does not hand one of them the whole band.
  const percentile = Math.round(((cell.below + cell.tied / 2) / cell.venues) * 100);
  const median = Math.round(cell.medianBaseline);

  return [
    facts.makeFact({
      id: 'cohort_typical_at_your_peak',
      value: {
        city: key.city, cityName, category: key.category,
        weekday, hour: mine.hour, venues: cell.venues, medianBaseline: median,
      },
      source: 'corpus',
      asOf: facts.CORPUS_AS_OF,
      note: 'Google measured curves from our frozen corpus, collected in spring 2026. It describes that window and no other.',
      label: `Across the ${cell.venues} ${cityName} ${plural} our corpus measured as open at ${when}, the middle of the pack sits at ${median} on the 0 to 100 index. Collected spring 2026 and frozen on 2026-05-18, so read it as what that window looked like, not as this week.`,
    }),
    facts.makeFact({
      id: 'cohort_your_standing',
      value: {
        yourBaseline: Math.round(mine.baseline),
        percentile,
        band: bandWords(percentile),
        venues: cell.venues,
        weekday,
        hour: mine.hour,
      },
      source: 'corpus',
      asOf: facts.CORPUS_AS_OF,
      note: 'A comparison of typicals against typicals. It says nothing about any particular night, yours or anyone else\'s.',
      label: `Your own curve puts your ${when} typical at ${Math.round(mine.baseline)}, which lands in ${bandWords(percentile)} of those ${cell.venues}. That is your usual against their usual, measured spring 2026. No night in it.`,
    }),
  ];
}

// ═══ HALF B ═════════════════════════════════════════════════════════════════
//
// The same night, from other venues' own readings. Refuses until five other
// venues in the cohort posted one for the same band, and switches itself on
// the first night they do.

/**
 * The asking venue's own most recent COMPLETED local day with a live reading,
 * and the hour its highest reading landed on. Its own data, so no floor
 * applies; the completed-day condition is guard 2, which closes the window
 * before anything about it is published.
 */
async function ownLatestNight(placeId, tz, today) {
  const { rows } = await pool.query(
    `SELECT (created_at AT TIME ZONE $2)::date AS night,
            EXTRACT(HOUR FROM (created_at AT TIME ZONE $2))::int AS hour,
            busy_percent::int AS reading
       FROM venue_owner_reports
      WHERE google_place_id = $1
        AND retracted = false
        AND created_at >= NOW() - ($4::text || ' days')::interval
        AND (created_at AT TIME ZONE $2)::date < $3::date
      ORDER BY 1 DESC, busy_percent DESC
      LIMIT 1`,
    [placeId, tz, today, String(OWN_READING_LOOKBACK_DAYS)]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    night: toDateStr(r.night),
    hour: Number(r.hour),
    reading: Number(r.reading),
  };
}

/**
 * The cohort's night, aggregated INSIDE the query. This function returns three
 * counts and a median and nothing else: the per-venue peaks never cross into
 * this process, so no later refactor can leak one by accident, and no logging
 * or error path can hold one. That includes the support count, which is guard
 * 7's input and is a COUNT of readings near the middle, never the readings.
 *
 * One row per OWNER, not per venue (guard 6): whatever an owner holds in this
 * city and category collapses to a single peak before the median sees it, so a
 * cohort of five is five separate businesses. The asking venue is excluded by
 * place id, and its owner by user id, so nothing behind the published number is
 * a value the reader already has.
 *
 * The reporting venues must be claimed and verified, and the timezone used is
 * the asking venue's own. Every venue in one CITIES key shares a wall clock, so
 * one tz for the whole cohort is correct rather than convenient.
 */
async function cohortNightAggregate({ city, category, excludePlaceId, excludeOwnerId, tz, night, band }) {
  const { rows } = await pool.query(
    `WITH reporters AS (
       SELECT vp.user_id AS owner, MAX(r.busy_percent)::numeric AS peak
         FROM venue_owner_reports r
         JOIN ml_venues v ON v.google_place_id = r.google_place_id
         JOIN venue_profiles vp ON vp.google_place_id = r.google_place_id AND vp.verified = true
        WHERE v.city = $1
          AND v.venue_category = $2
          AND r.google_place_id <> $3
          AND vp.user_id IS NOT NULL
          AND vp.user_id IS DISTINCT FROM $8::int
          AND r.retracted = false
          AND (r.created_at AT TIME ZONE $4)::date = $5::date
          AND EXTRACT(HOUR FROM (r.created_at AT TIME ZONE $4))::int BETWEEN $6 AND $7
        GROUP BY vp.user_id
     ),
     middle AS (
       SELECT COUNT(*)::int AS owners,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY peak) AS median_peak
         FROM reporters
     ),
     shown AS (
       -- ::numeric BEFORE the ROUND, and it is load-bearing. percentile_cont
       -- returns double precision even over a numeric column, and round() on a
       -- double is the C library's rint(), which breaks a tie to EVEN: a median
       -- of 42.5 rounds to 40 there and to 45 in roundToGrid(), which is
       -- Math.round and breaks ties upward. Guard 7 would then have been
       -- measured around a number the owner never sees, one grid step away from
       -- the one printed. round() on a numeric breaks ties away from zero, which
       -- is what JavaScript does for the 0-100 values this column holds.
       SELECT owners, median_peak,
              ROUND(median_peak::numeric / $9::numeric) * $9::numeric AS grid
         FROM middle
     )
     SELECT s.owners,
            s.median_peak,
            (SELECT COUNT(*) FROM reporters n
              WHERE ABS(n.peak - s.grid) <= $10::numeric)::int AS support,
            (SELECT COUNT(*) FROM reporters n
              WHERE (s.grid - n.peak) * 2 > $9::numeric
                AND s.grid - n.peak <= $10::numeric)::int AS support_below,
            (SELECT COUNT(*) FROM reporters n
              WHERE (n.peak - s.grid) * 2 > $9::numeric
                AND n.peak - s.grid <= $10::numeric)::int AS support_above,
            (SELECT COUNT(*) FROM reporters n
              WHERE ABS(n.peak - s.grid) * 2 <= $9::numeric)::int AS at_value,
            (SELECT COALESCE(MAX(n.peak) - MIN(n.peak), 0) <= $10::numeric
               FROM reporters n) AS tight
       FROM shown s`,
    [city, category, excludePlaceId, tz, night, band.from, band.to,
      excludeOwnerId == null ? null : Number(excludeOwnerId),
      MEDIAN_ROUND_TO, MEDIAN_SUPPORT_WINDOW]
  );
  const r = rows[0] || {};
  return {
    owners: Number(r.owners || 0),
    medianPeak: r.median_peak != null ? Number(r.median_peak) : null,
    // Guard 7's inputs, all of them COUNTS of readings near the number we would
    // publish and one boolean, never the readings. They are measured against
    // the ROUNDED median, which is the value that actually reaches the owner, so
    // the guard is stated about the thing on the card rather than about an
    // intermediate nobody sees. `tight` is a comparison, not a range: the spread
    // itself stays in the database, since a spread is a publishable-looking
    // number this process has no business holding.
    support: Number(r.support || 0),
    supportBelow: Number(r.support_below || 0),
    supportAbove: Number(r.support_above || 0),
    atValue: Number(r.at_value || 0),
    tight: r.tight === true,
  };
}

/**
 * The cohort's FROZEN typical for the same weekday and band, so the night's
 * median has something to be read beside. Supplementary: when the cell is thin
 * this returns null and the card simply carries one fewer fact, rather than a
 * second refusal on a card that already answered.
 */
async function cohortBandTypical({ city, category, day, band }) {
  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT b.google_place_id, AVG(b.baseline)::numeric AS baseline
         FROM ml_venue_baselines b
         JOIN ml_venues v ON v.google_place_id = b.google_place_id
        WHERE v.city = $1
          AND v.venue_category = $2
          AND b.day_of_week = $3
          AND b.hour BETWEEN $4 AND $5
          AND b.baseline > 0
        GROUP BY 1
     )
     SELECT COUNT(*)::int AS venues,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY baseline) AS median_baseline
       FROM cohort`,
    [city, category, day, band.from, band.to]
  );
  const r = rows[0] || {};
  const venues = Number(r.venues || 0);
  if (venues < MIN_COHORT_CORPUS_VENUES || r.median_baseline == null) return null;
  return { venues, medianBaseline: Number(r.median_baseline) };
}

async function buildCohortSameNight(ctx, { now = new Date() } = {}) {
  const facts = F();
  const placeId = ctx.profile.google_place_id;
  const tz = (ctx.mlVenue && ctx.mlVenue.timezone) || 'UTC';

  // No corpus gate here, deliberately. Half B reads readings, not baselines,
  // so a venue collected but not modelled ('venue_only') can both feed and
  // receive this answer. That is the half that grows with users rather than
  // with our collection runs, which is the whole point of it.
  const key = await cohortKey(placeId);
  if (!key) return [refuseNoMembership()];

  const today = localDateStr(tz, now);
  const own = await ownLatestNight(placeId, tz, today);
  if (!own) {
    return [facts.makeRefusal({
      id: 'refuse_no_reading_of_your_own',
      reason: `We did not have a reading from your room on any finished day in the last ${OWN_READING_LOOKBACK_DAYS} days, so there is nothing of yours to set beside the street.`,
      whatWouldUnlock: 'The busy slider on your dashboard, which is free for every venue. One reading on the day you want to ask about gives this question a your-side.',
    })];
  }

  // THE NIGHT AND THE HOUR HAVE TO BE READABLE BEFORE ANYTHING IS SAID ABOUT
  // THEM. Both come out of a DATE and an EXTRACT, so in practice they always
  // are; the guard is here because the failure was silent and owner-visible
  // rather than loud. weekdayOf returns null for an unparseable date and
  // WEEKDAY_NAMES[null] is undefined, which printed as "posted readings for
  // 9 PM to 11 PM that undefined"; bandFor returns null for an unreadable hour,
  // which printed as "NaN AM to NaN AM" and put a NaN in the payload. A cohort
  // sentence we cannot date is one we do not publish.
  const band = bandFor(own.hour);
  const dow = weekdayOf(own.night);
  const weekday = dow == null ? null : WEEKDAY_NAMES[dow];
  if (!band || !weekday) {
    return [facts.makeRefusal({
      id: 'refuse_unreadable_night',
      reason: 'We could not read the day and hour of your own last reading, so there is no night to compare and nothing we would state about one.',
      whatWouldUnlock: 'A fresh reading from the busy slider on your dashboard. If this keeps happening, tell us and we will look at the record on our side.',
    })];
  }
  const cityName = cityWords(key.city);
  const plural = categoryWords(key.category);
  const window = `${hour12(band.from)} to ${hour12(band.to)}`;

  const out = [facts.makeFact({
    id: 'owner_night_peak',
    value: { night: own.night, hour: own.hour, peakReading: own.reading },
    source: 'owner_report',
    asOf: own.night,
    label: `Your own highest reading on ${facts.shortDate(own.night)}, a ${weekday}, was ${own.reading}, posted around ${hour12(own.hour)}.`,
  })];

  const cohort = await cohortNightAggregate({
    city: key.city,
    category: key.category,
    excludePlaceId: placeId,
    excludeOwnerId: ctx.profile.user_id,
    tz,
    night: own.night,
    band,
  });

  // Two conditions, ONE refusal, and the copy never says which of them bit. See
  // "ONE REFUSAL, ONE SENTENCE" in the header: naming the failing test would
  // publish the shape of the distribution to the reader we just decided may not
  // see the middle of it, and would tell an attacker their sandwich landed.
  const enoughOwners = cohort.owners >= MIN_COHORT_REPORTERS && cohort.medianPeak != null;
  // Guard 7. Enough company near the number, and the number sitting inside that
  // company rather than propped up from one side of it. A flat street clears
  // the second test through the tight-set branch.
  const flanked = cohort.supportBelow >= MIN_MEDIAN_FLANK && cohort.supportAbove >= MIN_MEDIAN_FLANK;
  const clustered = cohort.atValue >= MIN_MEDIAN_SUPPORT && cohort.tight;
  const supported = cohort.support >= MIN_MEDIAN_SUPPORT && (flanked || clustered);
  if (!enoughOwners || !supported) {
    out.push(facts.makeRefusal({
      id: 'refuse_cohort_thin_reporters',
      reason: `We do not hold readings from ${MIN_COHORT_REPORTERS} other ${cityName} ${plural} for ${window} that ${weekday} that add up to a middle value we can state on its own terms, so there is no street number to give you. Under that floor, and when the readings we do hold sit far apart from each other, a middle value sits close enough to one venue's own reading to name them, and venues are findable on a map in a way people are not.`,
      whatWouldUnlock: `${MIN_COHORT_REPORTERS} venues near you, in your category, under ${MIN_COHORT_REPORTERS} separate owners, posting readings for the same hours. We do not say how many have so far, and we do not say which of those two conditions this night missed. Both are facts about which of your neighbours reported and what they said, and they are theirs, not ours to hand over.`,
    }));
    return out;
  }

  const median = roundToGrid(cohort.medianPeak);
  const atLeast = reporterFloor(cohort.owners);
  out.push(facts.makeFact({
    id: 'cohort_night_median',
    value: {
      night: own.night,
      weekday,
      hourFrom: band.from,
      hourTo: band.to,
      reportingVenuesAtLeast: atLeast,
      medianReading: median,
    },
    source: 'cohort_reported',
    asOf: own.night,
    note: 'The middle reading, rounded, and a floor on how many venues stand behind it. We never publish the exact number of reporters, a single venue\'s number, a highest, a lowest, a spread or a name.',
    label: `At least ${atLeast} other ${cityName} ${plural} posted readings for ${window} that ${weekday}. The middle of those readings was about ${median} on the 0 to 100 index.`,
  }));

  const typical = await cohortBandTypical({
    city: key.city, category: key.category, day: dow, band,
  });
  if (typical) {
    out.push(facts.makeFact({
      id: 'cohort_band_typical',
      value: {
        weekday, hourFrom: band.from, hourTo: band.to,
        venues: typical.venues, medianBaseline: Math.round(typical.medianBaseline),
      },
      source: 'corpus',
      asOf: facts.CORPUS_AS_OF,
      note: 'A Google measured typical from the frozen corpus, next to a set of live readings. Two different kinds of number, put side by side. Subtracting one from the other is not a measurement of anything.',
      label: `For scale, the same group's frozen typical for ${weekday} ${window} sits at ${Math.round(typical.medianBaseline)} across ${typical.venues} ${plural}, measured spring 2026.`,
    }));
  }

  return out;
}

module.exports = {
  buildCohortStanding,
  buildCohortSameNight,
  // Floors and helpers, exported for the standing test.
  MIN_COHORT_REPORTERS,
  MIN_COHORT_CORPUS_VENUES,
  MIN_MEDIAN_SUPPORT,
  MIN_MEDIAN_FLANK,
  MEDIAN_SUPPORT_WINDOW,
  REPORTER_COUNT_BUCKETS,
  MEDIAN_ROUND_TO,
  BAND_HOURS,
  OWN_READING_LOOKBACK_DAYS,
  bandFor,
  roundToGrid,
  reporterFloor,
  toDateStr,
  bandWords,
  cityWords,
  categoryWords,
  localDateStr,
};
