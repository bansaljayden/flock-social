// ---------------------------------------------------------------------------
// COHORT DIFFERENCING: "was it just us, or was everyone slow?"
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
//   HALF A (buildCohortStanding), TYPICALS, computable today, zero users.
//     ml_venue_baselines joined to ml_venues on (city, venue_category): the
//     distribution of Google-derived curves across the venue's cohort at one
//     day-of-week and hour, and where this venue's own curve sits inside it.
//     Answers "am I usually the quiet one here". Says NOTHING about any
//     specific night, and the copy holds that line: "your typical Friday 9 PM
//     sits in the bottom third" is legal, "you underperformed last Friday" is
//     a lie built from the same rows.
//
//   HALF B (buildCohortSameNight), ACTUALS, gated on density.
//     Owner readings (migration 031) from every verified venue in the same
//     city, category, night and hour band, the asking one included. This is the
//     actual moat. It answers today with a refusal, and it switches itself on
//     the first night five OTHER venues in one city and category post readings
//     that three of them could each have given. Nothing here is flag-gated: the
//     floor IS the flag, and it is checked against live data on every call.
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
// So the floor is FIVE OWNERS OTHER THAN THE ASKING ONE, per ROOST-OWNER-INPUT
// §5 ("any cohort or comparison sentence before five reporting venues" is on
// the do-not-build list) and ADVISOR-WHY-LAYER §D5.
//
// ── THE ONE PROPERTY THIS MODULE PROMISES ──────────────────────────────────
//
// Everything below holds one sentence true:
//
//   WHATEVER ELSE AN OBSERVER KNOWS OR CONTROLS, WHAT THEY LEARN ABOUT ANY
//   SINGLE REPORTER'S NUMBER IS AT MOST WHICH PUBLISHED BUCKET IT FELL IN.
//
// That is the strongest promise a published aggregate over a set the observer
// can help fill is able to make, and it is deliberately NOT "they learn
// nothing". Somebody holding every other reading in the cell can always narrow
// the last one to the resolution of the thing being printed. The job is to make
// that the ONLY resolution available: no arrangement of controlled readings, no
// choice of who asks, and no arithmetic on the payload may do better than the
// bucket the card already shows everybody.
//
// It is measured rather than asserted. __tests__/advisorCohort.test.js searches
// thousands of controlled configurations of five to ten reporters, sweeps the
// one honest reading across the whole 0 to 100 index, and asserts that no
// observable outcome, publication or refusal, ever isolates that reading to
// fewer than half a grid step. The same search run against the design this one
// replaced pins it to a single index point.
//
// Three earlier versions of this file failed that property, and the wreckage is
// the reason each guard below is shaped the way it is.
//
// ── THE GUARDS, IN THE ORDER THEY BITE ─────────────────────────────────────
//
//   1. AN ORDER STATISTIC, NEVER AN INTERPOLATION. The statistic is
//      percentile_disc, which returns a value some reporter actually posted.
//      percentile_cont, which this used to call, INTERPOLATES on an even count:
//      over [0, 0, 62, 70, 72, 100] it returns 66, the mean of the two middle
//      readings, verified against a real Postgres. A mean of two is exactly
//      invertible, so with one of them known the other falls out as
//      2*published - known, and the "no mean, sum or total may ever be added to
//      the payload" rule was being broken by the median itself every time the
//      reporter count was even. An order statistic has bounded influence: one
//      arrival moves it at most to the next reading in the sort, and it can
//      never sit between two readings at a distance that encodes either.
//
//   2. THE WINDOW IS CLOSED BEFORE IT IS PUBLISHED. Half B answers only about
//      a local date that has already ended (`night < today` on the venue's own
//      clock). A live, still-filling window is a ticker: poll it and you watch
//      each venue arrive one at a time, which is the join sequence a
//      differencing attack needs. A closed window has no arrivals left to
//      watch, and readings carry server-side timestamps with a 90 minute TTL,
//      so nothing can be added to or retracted from a night after it becomes
//      answerable. One night is one observation. This also happens to be the
//      honest product shape, since the question is retrospective by nature.
//
//   3. THE COHORT KEY IS SERVER-DERIVED AND HAS NO KNOBS. City and category
//      come from the asking venue's own ml_venues row; the hour band is snapped
//      to a FIXED three-hour grid (00-02, 03-05, ... 21-23) rather than
//      centered on anything the caller can move. POST /ask accepts one key,
//      `intentId`, and rejects any other body key with a 400 before a value is
//      read, so there is no radius, no date, no category and no window
//      parameter to sweep. A sliding band would have handed the attacker two
//      overlapping windows differing by one hour, which isolates whoever
//      reported in that hour. A fixed grid means any two venues' bands are
//      identical or disjoint, never offset by one.
//
//   4. THE COHORT DOES NOT DEPEND ON WHO IS ASKING, AND THIS FILE USED TO CLAIM
//      THAT WHILE DOING THE OPPOSITE. The header here once said "an attacker
//      cannot construct two cohorts whose difference is one venue, which is the
//      classic set-differencing move". It was false, and the counterexample was
//      a few lines further down in this module's own SQL: the asking venue was
//      excluded by place id and its owner by user id, so the caller chose the
//      one-element difference by signing into a different one of the venues
//      they already control.
//
//      Worked against a real Postgres. Five verified venues under five accounts
//      in one city and category, readings at 0, 20, 30, 40 and 60, one honest
//      competitor in the same cell. Asking the same chip from each of the five
//      produced five different cards, and the five-tuple of answers partitioned
//      the competitor's exact reading into ELEVEN classes, several of them
//      three points wide. A second review found the same hole independently
//      with a different set. No prior belief was needed, which is what made it
//      worse than the narrow sandwich this file already admitted to.
//
//      The exclusion is therefore GONE. Membership is every verified owner with
//      a live reading in (city, category, night, band), the asking one
//      included, so any two venues asking about the same night and band get a
//      byte for byte identical answer and there is no second cohort to
//      difference against. The exclusion's original justification was that
//      including the asking venue "hands the attacker one of the values for
//      free". It does, and that is worth far less than what it was buying them:
//      one known value out of six does not invert an order statistic, while a
//      rotatable exclusion pins the target exactly. Rerunning the search with
//      guard 8 in place but the exclusion restored still pins an honest reading
//      to a single index point, so dropping it is load-bearing rather than
//      tidy.
//
//      What follows from it: the middle reading now includes the asking venue's
//      own, and the card says so in words rather than implying the number is
//      built only from other people.
//
//   5. COARSENING, AND THE GRID IS THE PRIVACY UNIT. The published number is
//      rounded to the nearest MEDIAN_ROUND_TO points on the 0-100 index, and
//      that same rounding defines what "several reporters could have posted
//      this" means in guard 8. The two are one number on purpose: the moment
//      the printed value is finer than the bucket the support test counts over,
//      the card resolves an individual reading more sharply than the guard
//      protecting it. The grid is 10 rather than 5 for that reason, and moving
//      it moves the product's precision and the attacker's best case together.
//
//   6. THE COUNT SENTENCE IS A CONSTANT. The card names the FLOOR, "at least
//      five other venues", and never a number that tracks how many reported.
//      This used to publish the largest of 5, 10, 25, 50, 100 the count
//      reached, on the theory that a bucketed count moves only at boundaries.
//      A bucket boundary is still one bit about one named venue when somebody
//      supplies every other reporter: nine controlled owners plus one honest
//      neighbour reads as "at least ten", the same nine without them reads as
//      "at least five", and the difference discloses that neighbour's
//      participation exactly, with no inference required. Reducing the
//      resolution of a count does not remove its dependence on one venue being
//      present. A constant does. It still does the only honest job the count
//      was doing on the card, which is telling the owner the number is not
//      built on two venues.
//
//   7. THE FLOOR IS COUNTED IN OWNERS, NOT IN VENUES, and every venue one owner
//      holds collapses to ONE value before the statistic is taken. A cohort is
//      five independent businesses or it is not a cohort. Today
//      venue_profiles.user_id is UNIQUE, so one account holds at most one
//      verified venue and the two counts are the same number; the constraint is
//      written in owners anyway, because the day a group operator claims three
//      bars in one city is the day a venue-counted floor of five quietly
//      becomes an owner-counted floor of three. See the OPEN PRODUCT QUESTION
//      below.
//
//   8. THE PUBLISHED NUMBER HAS TO BE A NUMBER THREE OWNERS ACTUALLY POSTED.
//      The whole support test, and it is now one line: at least
//      MIN_MEDIAN_SUPPORT (3) reporting owners' readings round to the same grid
//      value the card is about to print. Nothing else. If three separate
//      businesses each posted a reading in that bucket, the bucket describes
//      three of them and names none, which is what k-anonymity means, applied
//      to the VALUE rather than to the set.
//
//      Guards 1 to 7 all assume the reporting set is not mostly one party's
//      construction, and five accounts defeat all of them at once. Post two
//      readings at 0 and two at 100, and the sorted set is [0, 0, target, 100,
//      100], whose middle IS the one honest venue's reading. The median is not
//      being inverted there, it is being POSITIONED, and bounded influence is
//      worth nothing when the neighbours on both sides were chosen. Under this
//      guard that set publishes nothing, because exactly one reading rounds to
//      the middle value.
//
//      THREE SHAPES OF THIS TEST WERE TRIED AND TWO WERE WRONG, which is worth
//      recording because both wrong ones look more careful than the right one:
//
//        * A TOTAL WITHIN A FIFTEEN POINT WINDOW plus a flank on each side.
//          Shipped, and inverted its own intent. The flank branch published
//          whenever one reader sat a clear step below the number and one a
//          clear step above, so five controlled readings arranged as a ladder
//          supplied both flanks and a single card pinned an honest reading to
//          ONE index point. Meanwhile the branch meant to carry ordinary flat
//          streets required MAX - MIN <= 15 across ALL reporters, which one
//          quiet venue in the cell kills, so it was unreachable at any real
//          size: ten owners with eight sitting exactly on the published value
//          were REFUSED while five owners with exactly one reader at the value
//          PUBLISHED. The gate was refusing its most anonymous nights and
//          printing its thinnest ones.
//
//        * THE SAME COUNT, BUT REQUIRED TO BE A MAJORITY of reporters. It reads
//          like the stronger claim and it fails the way the old one did: "more
//          than half of everyone inside one ten-point bucket" gets HARDER as
//          the cohort grows, so availability on a simulated street peaked near
//          six owners and fell from there. A privacy gate that tightens as the
//          population grows is the bug this file just finished fixing, wearing
//          a new coat. Measured: 44% of nights at six owners and 49% at
//          twenty-five, against 81% and 100% for the rule that shipped.
//
//      The rule that shipped is monotone in cohort size, which is the property
//      to check first on any future change here: more reporters must never mean
//      fewer answers.
//
//      The cost is real and it is named in numbers rather than adjectives. On a
//      simulated street where venues move together (one night level plus
//      per-venue noise of about twelve points) this publishes 50% of nights at
//      six reporting owners, 71% at eight, 84% at ten and 97% at fifteen, where
//      the shipped-and-broken version published 75%, 89%, 96% and 100%. The
//      lost nights are the genuinely dispersed ones, where no three venues on
//      the street agreed within ten points, and on those nights there is no
//      middle to report that is not somebody's own number.
//
// RESIDUAL, stated rather than hidden:
//
//   * THE BUCKET ITSELF. An observer supplying every other reading in the cell
//     learns which published bucket the remaining one fell in, and half a grid
//     step is as fine as that gets. That is guard 5's number and it is the
//     promise at the top of this section, not a hole in it. The way to make it
//     smaller is a coarser grid, which costs the product precision on every
//     honest card; the way to make it larger is a finer one, and nobody should.
//   * ONE BIT AT THE THRESHOLD. Any deterministic publish-or-refuse rule over a
//     set with one unknown element has a boundary, and an attacker who places
//     exactly MIN_MEDIAN_SUPPORT - 1 controlled readings inside one bucket
//     learns from a publication that the last reporter landed there too. That
//     costs them two verified venues sitting on a value they had to guess to
//     within half a grid step already, and it returns one bit for one night.
//     It cannot be removed without making publication independent of the data,
//     which is the same as publishing nothing.
//   * REFUSALS ARE OBSERVABLE. Both reviews noted that a coalition knows the
//     owner-count condition holds by construction, so a shared refusal wording
//     still tells them the support test was the one that bit. True, and it is
//     why the refusal wording is not doing the work here: the support test's
//     outcome is bounded by the two residuals above whether it is spoken or
//     silent. The single wording stays because it is the right answer for every
//     reader who is not running an attack.
//   * A retraction after publication removes one value from a window an owner
//     may already have read. The 90 minute TTL plus server-side timestamps plus
//     answering only finished days means a retraction cannot land inside the
//     answerable window, so this is bounded by guard 2 rather than tolerated.
//   * Two colluding owners in different bands can learn that somebody reported
//     in one band and not another. Participation-shaped, bounded, no value.
//   * Half A has no such surface at all: the corpus is frozen, so its cohort has
//     no joins or departures to difference.
//
// WHAT IS PUBLISHED: the middle reading, rounded to the grid, and the FLOOR on
// how many other owners reported, which is a constant. That is the whole list.
// Never a per-venue value, never a name, never a rank, never a min, max, range,
// spread, mean, sum or any other quantile. The extremes are the dangerous ones:
// a maximum IS one venue's exact reading, attributed to the venue anyone would
// guess. The per-venue values do not even cross the SQL boundary into
// JavaScript (see cohortNightAggregate): the aggregation happens inside the
// query and this process only ever holds counts and one rounded value.
//
// ── ONE REFUSAL, ONE SENTENCE ──────────────────────────────────────────────
//
// Half B has two ways to decline, too few owners and an unsupported value, and
// exactly ONE refusal, with one id and one wording. A refusal that said which
// test failed would hand back the fact it was protecting: "there were enough of
// you, the readings simply landed nowhere near each other" is a statement about
// the shape of that night's distribution, handed to somebody we have just
// decided may not see the middle of it. The copy names both conditions and
// never says which one bit.
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
//     five separate businesses. Their three bars collapse to one reading before
//     the statistic sees it, which is the part that matters; they are inside
//     their own answer now (guard 4) and the card says so.
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
// counted in owners rather than in venues per guard 7.
//
// "Other than the asking one" is now a COUNTING rule and no longer a membership
// rule. The asking owner is inside the cohort like everybody else (guard 4);
// what this floor asks is that at least five of the reporters are somebody
// else, so the sentence on the card stays true.
const MIN_COHORT_REPORTERS = 5;

// Half B, guard 8. How many reporting owners' readings have to round to the
// number about to be printed. Three is the same k the house uses for aggregates
// over identifiable reporters, applied here to the VALUE rather than to the
// set: if three separate businesses each posted a reading in that bucket, the
// bucket describes three of them and names none.
//
// This is the WHOLE support test. There is no window, no flank count and no
// spread comparison any more; the header records why each of those was worse
// than it looked. The one property to preserve on any change: the test must get
// EASIER as the cohort grows, never harder.
const MIN_MEDIAN_SUPPORT = 3;

// Half A. Corpus venues that must sit in the (city, category, day, hour) cell
// before a position inside it means anything. This floor is statistical rather
// than privacy-driven: the values are Google's published popular-times curves,
// which are not any venue's private business data, and the corpus is frozen so
// the cell cannot be differenced. Ten is the number at which the thirds this
// module reports carry at least three venues each, so one venue does not own a
// band.
const MIN_COHORT_CORPUS_VENUES = 10;

// The published middle reading is rounded to this grid, and the SAME rounding
// decides which readings count as supporting it in guard 8. Guard 5 above says
// why those cannot be two different numbers, and why this one is 10 rather than
// the 5 it used to be: it is simultaneously the product's precision and the
// finest an observer who controls every other reporter can resolve the one they
// do not control.
const MEDIAN_ROUND_TO = 10;

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
 * Which grid bucket a reading falls in, which is the same arithmetic the SQL
 * does when it counts guard 8's support. Exported so the suite can state the
 * guard in one line instead of restating the rounding.
 */
function bucketOf(value) {
  return roundToGrid(value);
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
 * counts and one middle reading and nothing else: the per-venue peaks never
 * cross into this process, so no later refactor can leak one by accident, and
 * no logging or error path can hold one. That includes guard 8's input, which
 * is a COUNT of readings that round to the printed value, never the readings.
 *
 * One row per OWNER, not per venue (guard 7): whatever an owner holds in this
 * city and category collapses to a single peak before the statistic sees it, so
 * a cohort of five is five separate businesses.
 *
 * NOBODY IS EXCLUDED, and that is the fix for the rotation attack rather than
 * an oversight. Membership is a pure function of (city, category, night, band),
 * so which of the reporting venues is doing the asking cannot change the set,
 * and there is no second cohort to difference this one against. Guard 4 in the
 * header has the worked attack this replaced. The asking owner is counted
 * separately (`you`) so the floor can still be stated in OTHER owners and the
 * card can say whose readings are in the number.
 *
 * The reporting venues must be claimed and verified, and the timezone used is
 * the asking venue's own. Every venue in one CITIES key shares a wall clock, so
 * one tz for the whole cohort is correct rather than convenient.
 */
async function cohortNightAggregate({ city, category, askingOwnerId, tz, night, band }) {
  const { rows } = await pool.query(
    `WITH reporters AS (
       SELECT vp.user_id AS owner, MAX(r.busy_percent)::numeric AS peak
         FROM venue_owner_reports r
         JOIN ml_venues v ON v.google_place_id = r.google_place_id
         JOIN venue_profiles vp ON vp.google_place_id = r.google_place_id AND vp.verified = true
        WHERE v.city = $1
          AND v.venue_category = $2
          AND vp.user_id IS NOT NULL
          AND r.retracted = false
          AND (r.created_at AT TIME ZONE $3)::date = $4::date
          AND EXTRACT(HOUR FROM (r.created_at AT TIME ZONE $3))::int BETWEEN $5 AND $6
        GROUP BY vp.user_id
     ),
     middle AS (
       SELECT COUNT(*)::int AS owners,
              COUNT(*) FILTER (WHERE owner IS NOT DISTINCT FROM $7::int)::int AS you,
              -- percentile_DISC, not _cont. Guard 1: _cont interpolates on an
              -- even count and returns the mean of the two middle readings,
              -- which is exactly invertible from either one of them. _disc
              -- returns a value a reporter actually posted.
              percentile_disc(0.5) WITHIN GROUP (ORDER BY peak) AS median_peak
         FROM reporters
     ),
     shown AS (
       -- ::numeric BEFORE the ROUND, and it is load-bearing. round() on a
       -- double is the C library's rint(), which breaks a tie to EVEN: a middle
       -- reading of 45 would round to 40 there and to 50 in roundToGrid(),
       -- which is Math.round and breaks ties upward. Guard 8 would then have
       -- been counted around a number the owner never sees, one grid step away
       -- from the one printed. round() on a numeric breaks ties away from zero,
       -- which is what JavaScript does for the 0-100 values this column holds.
       SELECT owners, you, median_peak,
              ROUND(median_peak::numeric / $8::numeric) * $8::numeric AS grid
         FROM middle
     )
     SELECT s.owners,
            s.you,
            s.median_peak,
            -- Guard 8, whole. The reading has to round to the SAME grid value
            -- the card prints, which is bucket equality rather than a distance
            -- test: a reading exactly half a step above the value rounds to the
            -- next bucket up, and counting it here would have credited the
            -- printed number with support that belongs to its neighbour.
            (SELECT COUNT(*) FROM reporters n
              WHERE ROUND(n.peak / $8::numeric) * $8::numeric = s.grid)::int AS at_value
       FROM shown s`,
    [city, category, tz, night, band.from, band.to,
      askingOwnerId == null ? null : Number(askingOwnerId),
      MEDIAN_ROUND_TO]
  );
  const r = rows[0] || {};
  return {
    owners: Number(r.owners || 0),
    // 1 when the asking owner is one of the reporters, which they normally are:
    // the band was derived from their own reading. Their own participation is
    // not a secret from them, and it is what lets the floor stay written in
    // OTHER owners now that nobody is excluded from the set.
    you: Number(r.you || 0),
    medianPeak: r.median_peak != null ? Number(r.median_peak) : null,
    // Guard 8's input: a COUNT of readings that round to the number we would
    // publish, never the readings. Counted against the ROUNDED value, which is
    // what actually reaches the owner, so the guard is stated about the thing on
    // the card rather than about an intermediate nobody sees.
    atValue: Number(r.at_value || 0),
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
    askingOwnerId: ctx.profile.user_id,
    tz,
    night: own.night,
    band,
  });

  // Two conditions, ONE refusal, and the copy never says which of them bit. See
  // "ONE REFUSAL, ONE SENTENCE" in the header: naming the failing test would
  // publish the shape of the distribution to the reader we just decided may not
  // see the middle of it.
  //
  // The floor is counted in owners who are NOT the asking one, which is the
  // only place the asking venue still gets special treatment. It is a counting
  // rule, not a membership rule: the set itself is the same whoever asks.
  const others = Math.max(0, cohort.owners - cohort.you);
  const enoughOwners = others >= MIN_COHORT_REPORTERS && cohort.medianPeak != null;
  // Guard 8, whole. Three reporting owners posted a reading that rounds to the
  // number about to be printed, so the number describes three businesses and
  // names none of them.
  const supported = cohort.atValue >= MIN_MEDIAN_SUPPORT;
  if (!enoughOwners || !supported) {
    out.push(facts.makeRefusal({
      id: 'refuse_cohort_thin_reporters',
      reason: `We do not hold readings from ${MIN_COHORT_REPORTERS} other ${cityName} ${plural} for ${window} that ${weekday} that land on a middle value ${MIN_MEDIAN_SUPPORT} of them could each have posted, so there is no street number to give you. Under that floor, and when the readings we do hold land nowhere near each other, a middle value sits close enough to one venue's own reading to name them, and venues are findable on a map in a way people are not.`,
      whatWouldUnlock: `${MIN_COHORT_REPORTERS} venues near you, in your category, under ${MIN_COHORT_REPORTERS} separate owners, posting readings for the same hours. We do not say how many have so far, and we do not say which of those two conditions this night missed. Both are facts about which of your neighbours reported and what they said, and they are theirs, not ours to hand over.`,
    }));
    return out;
  }

  const median = roundToGrid(cohort.medianPeak);
  // The count sentence is the FLOOR and never the count. Guard 6: a figure that
  // tracks how many reported crosses a boundary when one named venue joins, and
  // that crossing is that venue's participation, however coarse the buckets are.
  const whoReported = cohort.you > 0
    ? `You and at least ${MIN_COHORT_REPORTERS} other ${cityName} ${plural}`
    : `At least ${MIN_COHORT_REPORTERS} ${cityName} ${plural}`;
  out.push(facts.makeFact({
    id: 'cohort_night_median',
    value: {
      night: own.night,
      weekday,
      hourFrom: band.from,
      hourTo: band.to,
      otherVenuesAtLeast: MIN_COHORT_REPORTERS,
      yourReadingCounted: cohort.you > 0,
      medianReading: median,
    },
    source: 'cohort_reported',
    asOf: own.night,
    note: 'The middle reading of the whole group, rounded to the nearest 10, and the floor on how many other venues stand behind it. We never publish how many reported, a single venue\'s number, a highest, a lowest, a spread or a name.',
    label: `${whoReported} posted readings for ${window} that ${weekday}. The middle of those readings was about ${median} on the 0 to 100 index, which we round to the nearest ${MEDIAN_ROUND_TO} and never state more finely.`,
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
  MEDIAN_ROUND_TO,
  BAND_HOURS,
  OWN_READING_LOOKBACK_DAYS,
  bandFor,
  roundToGrid,
  bucketOf,
  toDateStr,
  bandWords,
  cityWords,
  categoryWords,
  localDateStr,
};
