// ---------------------------------------------------------------------------
// ADVISOR FACT ENGINE — Layer B of ADVISOR-GROUNDING.md, T0 build.
//
// Deterministic. ZERO LLM. Every answer this module produces is a typed FACT
// carrying {id, value, source, asOf} or a typed REFUSAL carrying
// {status:'refused', reason, whatWouldUnlock}. A fact without a source cannot
// be constructed: makeFact throws, and nothing in this file builds a fact any
// other way. That is the structural half of the hallucination guards — the
// fabricated Pro Tips box deleted from the dashboard on 2026-08-14 could not
// be rebuilt through this module because its numbers had no source to name.
//
// WHAT THIS MODULE NEVER DOES, pinned by __tests__/advisorCards.test.js:
//   * No causal claims. The model may not explain anything (MODEL-EPOCH:
//     `month` is a collection artifact that would top the SHAP explanations).
//     HARD_REFUSALS.causalWhy is the only answer a why-intent can get.
//   * No competitor comparisons, and no strip orderings inside the minimum
//     gap. Ordering claims defer to the ONE definition in
//     routes/venueDashboard.js (stripOrderingClaim, measured 43.1% backwards
//     without the gap), so this file cannot drift from the dashboard's hedge.
//   * No flock budgets, in any form or aggregate. This module never reads
//     budget_submissions or bill_split tables (pinned as source text).
//   * Owner beliefs are never restated as measurement. An intake- or
//     owner-report-shaped fact with a measurement source is unconstructible.
//   * No writes. SELECTs only. An advisor with a write path is a new
//     consumer-facing surface, which is a different and unapproved product.
//
// CORPUS GATING. corpus_status='baselines' (with baseline rows) unlocks
// model-backed facts; everything else refuses WITH A PATH. Absent-from-corpus
// is the MODAL case (030's own header: the single real production profile is
// not in ml_venues), so the refusal is the main screen, not an error state.
//
// COST. Model-backed facts are scored from the ml_venues row, not from a paid
// Google Places call: the corpus gate guarantees the row exists before any
// scoring starts, so this surface spends no Places budget at all. Events and
// weather ride the existing cached, budgeted paths (mlPredictor's event cache,
// weatherService's cache). No module-scope cache of our own, deliberately —
// nothing here to add to utils/cacheKeyInventory.js.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const mlPredictor = require('./mlPredictor');
const crowdEngine = require('./crowdEngine');
const weatherService = require('./weatherService');
const venueCorpus = require('./venueCorpus');
const { moderateText } = require('../utils/moderation');
const { INTAKE_COLUMNS } = require('../validators/venueIntake');

// ─── The source vocabulary ───────────────────────────────────────────────────
//
// confidenceBasis values (crowdEngine.describePredictionSupport) plus the
// advisor extensions named in ADVISOR-GROUNDING §Layer B and the why-layer's
// §5 vocabulary. 'arithmetic' is for numbers derived from other facts and is
// only constructible with a `from` list naming the fact ids it was computed
// from, so even derived numbers trace to sources.
const FACT_SOURCES = new Set([
  // confidenceBasis vocabulary
  'model_holdout', 'user_reports', 'category_pattern', 'model_unverified_axis',
  // advisor extensions
  'intake', 'owner_report', 'votes', 'events', 'weather',
  'served_prediction', 'google_baseline', 'arithmetic',
  // Cohort differencing (services/advisorCohort.js). 'corpus' is the FROZEN
  // BestTime/Google corpus quoted as a distribution rather than as a curve for
  // one venue, and every fact carrying it also carries CORPUS_AS_OF.
  // 'cohort_reported' is other venues' own live readings, aggregated above a
  // k-anonymity floor and published as a median and a count only.
  'corpus', 'cohort_reported',
]);

// Sources that are the owner's own testimony. Facts built from them carry
// attribution 'owner_asserted' automatically, and a fact whose id says it is
// owner testimony (intake_*, owner_*) may not carry any other source: that is
// refusal class "owner beliefs restated as measurement", enforced by the type.
const OWNER_SOURCES = new Set(['intake', 'owner_report']);
const OWNER_ID_PREFIXES = ['intake_', 'owner_'];

// The corpus is frozen. Any fact quoted from it carries this date forever
// (ADVISOR-PRODUCT-SHAPE §0: an August product quoting a spring curve as
// current is an invented statistic in slow motion).
const CORPUS_AS_OF = '2026-05-18 (corpus frozen, collected spring 2026)';

// "Within ~1km" for the events card (ADVISOR-PRODUCT-SHAPE §5 card 2). The
// upstream Ticketmaster query runs at 2km; this is the advisor's tighter cut
// on the returned nearest distance.
const EVENT_RADIUS_KM = 1.0;

// How many days may clear the 85% band before the band has told us nothing.
// See the flat-curve note in buildListingReadBack: at six of seven there is no
// strongest day to name, and naming them all is a null result dressed as a
// finding.
const FLAT_CURVE_MIN_DAYS = 6;

// The anchor enum, in words an owner would recognise. venueIntake.js stores a
// closed list because "arena" and "the stadium" and "Lincoln Financial Field"
// are one fact and three strings (its own comment); reading 'stadium_arena'
// back at a person is that decision leaking out of the database. A standing
// test pins this map against ANCHOR_TYPES, so adding an anchor without its
// copy fails the suite instead of printing a column value at an owner.
const ANCHOR_WORDS = Object.freeze({
  stadium_arena: 'a stadium or arena',
  college_campus: 'a college campus',
  transit_hub: 'a transit hub',
  office_district: 'an office district',
  theater_music_hall: 'a theater or music hall',
  hotel_cluster: 'hotels',
  beach_boardwalk: 'a beach or boardwalk',
  nightlife_strip: 'a nightlife strip',
  highway_stop: 'a highway stop',
  hospital: 'a hospital',
  shopping_center: 'a shopping center',
});

// Which anchors a ticketed-events feed can even see. Ticketmaster lists ticketed
// events, so a stadium and a music hall show up there and a campus, a hospital
// or an office district never will. This is what makes the anchor columns worth
// reading on the street card: they say which of the owner's own demand
// generators our listings are structurally blind to.
const TICKETED_ANCHORS = new Set(['stadium_arena', 'theater_music_hall']);

function anchorWords(types) {
  return types.map((t) => ANCHOR_WORDS[t] || t).join(', ');
}

// SLOP-AUDIT, applied to every owner-visible string this module emits: no em
// dashes, no class words. Enforced at construction so a bad string throws in
// a test instead of shipping.
const BANNED_COPY = ['—', 'seamless', 'effortless', 'unlock deeper', 'personalize your experience'];
function assertCleanCopy(text, where) {
  const lower = String(text).toLowerCase();
  for (const banned of BANNED_COPY) {
    if (lower.includes(banned)) {
      throw new Error(`advisor copy violates SLOP-AUDIT (${where}): contains "${banned === '—' ? 'em dash' : banned}"`);
    }
  }
}

// ─── The outside world's strings ─────────────────────────────────────────────
//
// assertCleanCopy above guards copy WE wrote. Three strings in this file come
// from somewhere else and are interpolated into that copy: a Ticketmaster
// event's name and type, and OpenWeatherMap's conditions phrase. They are not
// ours, so they get sanitised rather than asserted, for two reasons that both
// bit:
//
//   1. AVAILABILITY. assertCleanCopy throws, and a thrown fact takes down the
//      whole card set with a 500. Event titles carry em dashes constantly
//      ("Band — Live at the Hall"), so an ordinary listing near a venue was
//      enough to blank that venue's advisor. A vendor's punctuation must
//      never be able to fail our endpoint.
//   2. THE PROMPT FENCE. These same strings are the only untrusted text that
//      reaches the phrasing model (services/advisorPhrasing.js flattens fact
//      values into the payload). ADVISOR-PROMPT section 10 tells the model
//      they are data; this is the half a machine can enforce. Braces would
//      collide with the {{fact:id}} placeholder grammar, control characters
//      and newlines let a value imitate the block's own framing, and an
//      unbounded title is unbounded prompt spend.
//
// Sanitising, not rejecting: an odd event title should read a little flatter,
// not erase the fact that an event exists.
const EXTERNAL_TEXT_MAX = 80;
// Code points rather than regex literals, on purpose: the classes below are
// invisible or punctuation characters, and a regex literal full of them is a
// line no reviewer can check and every editor is free to mangle.
const DASH_CODEPOINTS = new Set([0x2012, 0x2013, 0x2014, 0x2015, 0x2212]);
function isControlCp(cp) {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}
function isInvisibleCp(cp) {
  return (cp >= 0x200b && cp <= 0x200f)   // zero width, LTR/RTL marks
    || (cp >= 0x202a && cp <= 0x202e)     // bidi embedding and overrides
    || (cp >= 0x2066 && cp <= 0x2069)     // bidi isolates
    || cp === 0xfeff;                     // byte order mark
}

function externalText(value, { max = EXTERNAL_TEXT_MAX } = {}) {
  if (value === null || value === undefined) return null;
  let s = '';
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    if (isInvisibleCp(cp)) continue;                      // dropped outright
    if (DASH_CODEPOINTS.has(cp)) { s += '-'; continue; }  // SLOP rule 1, no throw
    if (isControlCp(cp)) { s += ' '; continue; }
    if (ch === '{' || ch === '}') continue;               // never imitate {{fact:id}}
    s += ch;
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // The ellipsis is three characters and counts against the cap: the point of
  // the cap is the byte count that reaches the prompt, not a tidy number.
  if (s.length > max) s = `${s.slice(0, max - 3).trimEnd()}...`;
  // Whatever survives has to be printable inside our own copy without throwing.
  for (const banned of BANNED_COPY) {
    if (DASH_CODEPOINTS.has(banned.codePointAt(0))) continue; // normalised above
    if (s.toLowerCase().includes(banned)) {
      const escaped = banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(escaped, 'ig'), '').replace(/\s+/g, ' ').trim();
    }
  }
  return s || null;
}

// ─── The owner's own prose ───────────────────────────────────────────────────
//
// Three intake columns are free text a PERSON typed: event_note, anchor_note
// and quirks (validators/venueIntake.js INTAKE_TEXT_FIELDS). Migration 030
// collected all three and, until now, nothing anywhere read any of them: the
// only venue-specific truth in a system whose crowd model is deliberately
// venue-blind was sitting in three columns as dead weight.
//
// They are owner testimony, so they inherit every rule owner testimony already
// has here: source 'intake', attribution 'owner_asserted' stamped by makeFact,
// phrased "you told us", never restated as measurement. Two rules are theirs
// alone, because they are the first strings in this file that a person wrote
// rather than a vendor:
//
//   1. SCREENED AGAIN, HERE. routes/venueProfile.js screens all three at the
//      write, on both the POST and the PUT (screenIntakeText -> rejectIfProfane,
//      pinned by __tests__/venueIntake.test.js). That screen reads the RAW
//      request body, and validators/shape.js freeText strips markup but not
//      zero-width characters -- so "f<ZWNJ>uck" is a string content-checker
//      does not recognise, express-validator does not touch, and Postgres
//      stores verbatim. externalText above strips exactly that class of
//      character, so screening the FENCED string catches what screening the
//      raw body structurally cannot. It also covers the two cases a write-time
//      screen can never cover: a row written before the screen existed, and
//      the next write path somebody adds without it. Text that fails is not
//      surfaced at all.
//
//   2. NOT A NUMBER, EVER. Every other fact value in this file is something
//      the server computed, which is the whole reason the phrasing layer is
//      allowed to substitute one into a {{fact:id}} placeholder AFTER the
//      digit valve has read the draft. A sentence the owner typed is not a
//      computed quantity, and "{{fact:intake_quirks}}" would carry text, and
//      any digits inside it, through the one hole the valve does not watch.
//      So prose facts are built with textOnly:true, which keeps them out of
//      the substitutable fact list entirely (services/advisorPhrasing.js
//      partitions on the flag): the model may read them as owner context, and
//      an attempt to splice one is an unknown id that voids the whole answer
//      and serves the template twin. The template twin prints the owner's
//      words verbatim from the fact's label, which is the path that always
//      works and the path the phrasing flag leaves serving by default.
//
// Nothing here is a second fence. externalText IS the fence -- the same one
// the event titles and the weather phrases go through, for the same two
// reasons (availability, and never imitating the placeholder grammar). This
// adds the screen a vendor string does not need and a person's does.

// Caps for the PROMPT, not for the column. The columns are 120 / 200 / 1000
// (migration 030) and the owner reads their own full text back on the settings
// screen either way. What is bounded here is the payload that reaches a model,
// which ADVISOR-GROUNDING's cost model budgets at roughly 300 tokens of intake
// context in total.
const OWNER_TEXT_MAX = Object.freeze({ event_note: 120, anchor_note: 200, quirks: 400 });

/** Fenced and screened owner prose, or null when there is nothing safe to print. */
function ownerText(value, max) {
  const fenced = externalText(value, { max });
  if (!fenced) return null;
  if (!moderateText(fenced).allowed) return null;
  return fenced;
}

/**
 * One owner-typed column, resolved into either prose or the refusal that
 * explains its absence. Empty and unprintable are DIFFERENT answers: "you have
 * not told us" is simply false for an owner who typed something, and a field
 * that silently vanishes is the kind of thing an owner re-types three times.
 */
function ownerProse(raw, max, { promptId, promptReason, promptUnlock }) {
  const text = ownerText(raw, max);
  if (text) return { text, refusal: null };
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      text: null,
      refusal: makeRefusal({ id: promptId, reason: promptReason, whatWouldUnlock: promptUnlock }),
    };
  }
  return {
    text: null,
    refusal: makeRefusal({
      id: `withheld_${promptId.replace(/^prompt_/, '')}`,
      reason: 'There is something written in this field that we are not able to print back to you.',
      whatWouldUnlock: 'Rewording it in venue settings. We read this field back word for word, so it passes the same check as every other piece of written text in Flock.',
    }),
  };
}

// ─── Fact and refusal constructors ───────────────────────────────────────────

/**
 * The only way a fact exists. Throws on: missing/unknown source, missing id,
 * missing value, missing asOf, arithmetic without provenance, and an
 * owner-testimony id dressed in a measurement source.
 */
function makeFact(input) {
  if (!input || typeof input !== 'object') throw new TypeError('fact: not an object');
  const { id, value, source, asOf } = input;
  if (typeof id !== 'string' || !id) throw new TypeError('fact: id required');
  if (value === undefined) throw new TypeError(`fact ${id}: value required`);
  if (typeof source !== 'string' || !FACT_SOURCES.has(source)) {
    throw new TypeError(`fact ${id}: a fact without a known source is unconstructible (got "${source}")`);
  }
  if (typeof asOf !== 'string' || !asOf) throw new TypeError(`fact ${id}: asOf required`);

  const ownerShaped = OWNER_ID_PREFIXES.some((p) => id.startsWith(p));
  if (ownerShaped && !OWNER_SOURCES.has(source)) {
    throw new TypeError(`fact ${id}: an owner assertion may not be restated as measurement (source "${source}")`);
  }

  const fact = { id, value, source, asOf };
  if (OWNER_SOURCES.has(source)) fact.attribution = 'owner_asserted';
  if (source === 'arithmetic') {
    if (!Array.isArray(input.from) || input.from.length === 0 || !input.from.every((f) => typeof f === 'string' && f)) {
      throw new TypeError(`fact ${id}: arithmetic facts need a non-empty \`from\` list of fact ids`);
    }
    fact.from = [...input.from];
  }
  // Owner prose. See "The owner's own prose" above: this flag is what keeps a
  // sentence a person typed out of the placeholder grammar. Only owner
  // testimony can carry it, it has to actually be text, and it may not claim a
  // unit, because a unit is a rendering rule for a NUMBER and this is not one.
  if (input.textOnly === true) {
    if (!OWNER_SOURCES.has(source)) {
      throw new TypeError(`fact ${id}: only the owner's own testimony can be owner prose (source "${source}")`);
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`fact ${id}: owner prose needs a non-empty string value`);
    }
    if (input.unit !== undefined) {
      throw new TypeError(`fact ${id}: owner prose has no unit. A unit is a rendering rule for a number.`);
    }
    fact.textOnly = true;
  }
  for (const k of ['label', 'note']) {
    if (input[k] !== undefined) {
      assertCleanCopy(input[k], `fact ${id} ${k}`);
      fact[k] = String(input[k]);
    }
  }
  for (const k of ['gate', 'predictionMethod', 'unit']) {
    if (input[k] !== undefined) fact[k] = input[k];
  }
  return Object.freeze(fact);
}

/** Refusals are data, with the same construction discipline as facts. */
function makeRefusal({ id, reason, whatWouldUnlock }) {
  if (typeof id !== 'string' || !id) throw new TypeError('refusal: id required');
  if (typeof reason !== 'string' || !reason) throw new TypeError(`refusal ${id}: reason required`);
  if (typeof whatWouldUnlock !== 'string' || !whatWouldUnlock) {
    throw new TypeError(`refusal ${id}: whatWouldUnlock required. A refusal that does not name the missing data is a dead end, not a refusal.`);
  }
  assertCleanCopy(reason, `refusal ${id} reason`);
  assertCleanCopy(whatWouldUnlock, `refusal ${id} whatWouldUnlock`);
  return Object.freeze({ id, status: 'refused', reason, whatWouldUnlock });
}

const isRefusal = (entry) => !!entry && entry.status === 'refused';

// ─── Hard refusal classes (ADVISOR-GROUNDING §1) ────────────────────────────
//
// Each is a FUNCTION returning a refusal, so the only thing a caller can do
// with one of these intents is refuse it. None of them mention an upgrade or
// a plan: "upgrade to see the answer" when the answer does not exist at any
// tier is the darkest pattern available here (ADVISOR-PRODUCT-SHAPE §4).
const HARD_REFUSALS = {
  // MODEL-EPOCH-FINDING item 5: nothing venue-facing explains a prediction
  // until the epoch figures are reproduced. The model's top signal tracks when
  // our data was collected, not what happened on the street.
  causalWhy: () => makeRefusal({
    id: 'refuse_causal_why',
    reason: 'We do not explain why a number moved. Any cause we named would be a guess dressed as analysis, and our own measurements say the model cannot support one.',
    whatWouldUnlock: 'A season of your own slider readings and user reports at your venue. Those observe your room directly, which the model does not.',
  }),
  // Parked by decision on the board: "not until the data can support them, if ever."
  competitorComparison: () => makeRefusal({
    id: 'refuse_competitor_comparison',
    reason: 'We do not compare you to named venues or explain their nights.',
    whatWouldUnlock: 'Live readings from enough nearby venues that a comparison would measure the street instead of guessing at it. That data does not exist yet.',
  }),
  // The budget-privacy invariant has no venue-side exception.
  flockBudgets: () => makeRefusal({
    id: 'refuse_flock_budgets',
    reason: 'What groups submit as budgets is private to them. We never show it to a venue, alone or in an aggregate.',
    whatWouldUnlock: 'Nothing. This stays closed by design.',
  }),
  // Also enforced structurally in makeFact; this is the intent-level answer.
  ownerBeliefAsMeasurement: () => makeRefusal({
    id: 'refuse_owner_belief_as_measurement',
    reason: 'What you told us stays labeled as what you told us. We do not restate your own answers as measurements.',
    whatWouldUnlock: 'Nothing. The labeling is the point.',
  }),
};

/**
 * Strip orderings defer to THE definition in routes/venueDashboard.js
 * (stripOrderingClaim + STRIP_ORDERING_MIN_GAP), required lazily so loading
 * this service does not load a router. Inside the gap, or with any rule-engine
 * side, the only output is a refusal: the strip was measured 43.1% backwards,
 * so inside the gap the honest answer is "too close to call".
 */
function stripOrderingFact(you, competitor, now = new Date()) {
  // Fail CLOSED if the hedge is not exported by the build this runs in (the
  // hedge ships with the dashboard's strip work): no hedge means no ordering
  // claims at all, never a second local copy of the arithmetic.
  const hedge = require('../routes/venueDashboard').__test || {};
  const { stripOrderingClaim, STRIP_ORDERING_MIN_GAP } = hedge;
  const claim = typeof stripOrderingClaim === 'function' ? stripOrderingClaim(you, competitor) : null;
  if (!claim) {
    return makeRefusal({
      id: 'refuse_strip_ordering',
      reason: 'Too close to call. We only state an order between two venues when the gap is wide enough that our measured error cannot flip it, and only when both sides were model scored.',
      whatWouldUnlock: 'A wider gap between the two forecasts, or model scores on both sides. Inside the gap there is no honest ordering to state.',
    });
  }
  return makeFact({
    id: 'strip_ordering',
    value: { claim, minGap: STRIP_ORDERING_MIN_GAP },
    source: 'model_holdout',
    asOf: now.toISOString(),
    gate: 'corpus_status=baselines',
  });
}

// ─── Corpus gating ───────────────────────────────────────────────────────────

/**
 * null when model-backed facts may be built; otherwise the refusal that IS the
 * main screen for the modal case. 'unknown' and NULL refuse like 'absent':
 * the absence of an answer is never permission (services/venueCorpus.js).
 */
function corpusGate(profile) {
  if (venueCorpus.hasModelBackedData(profile)) return null;
  const status = profile?.corpus_status;
  return makeRefusal({
    id: 'refuse_no_baseline',
    reason: venueCorpus.corpusSummary(profile),
    // WHAT WOULD UNLOCK IT IS NOT THE REFUSAL SAID AGAIN. The non-venue_only
    // branch used to open "This venue is not in our measured corpus, so nothing
    // model backed can be shown", which is word for word the claim `reason`
    // above has already made, in the one field reserved for the way out. Every
    // caller pastes both into one block, so the owner read the same sentence
    // twice: the kitchen line rendered as "no forecast of ours to set beside
    // it", then "we have no crowd history for this venue", then "this venue is
    // not in our measured corpus", three statements of one fact before anything
    // told them what to do. The path is the only thing this field owes them.
    whatWouldUnlock: status === 'venue_only'
      ? 'A baseline curve for this venue. It arrives with a corpus rebuild on our side, not with anything on yours.'
      : 'Your own slider readings build history for your venue that does not depend on the corpus.',
  });
}

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * One profile read (intake columns + corpus columns) plus the ml_venues row
 * when the venue is in the corpus. The ml_venues row is what model-backed
 * facts score from: coordinates, category, rating, review count, price level
 * and timezone, all already collected, no paid lookup.
 */
async function getVenueContext(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, google_place_id, verified, business_name, updated_at,
            corpus_status, corpus_baseline_rows, corpus_checked_at,
            ${INTAKE_COLUMNS.join(', ')}
       FROM venue_profiles WHERE user_id = $1`,
    [userId]
  );
  const profile = rows[0];
  if (!profile) return null;

  let mlVenue = null;
  if (profile.google_place_id) {
    const r = await pool.query(
      `SELECT name, latitude, longitude, venue_category, google_types,
              price_level, rating, review_count, timezone
         FROM ml_venues WHERE google_place_id = $1`,
      [profile.google_place_id]
    );
    mlVenue = r.rows[0] || null;
  }
  return { profile, mlVenue };
}

// ─── Clock helpers ───────────────────────────────────────────────────────────

/**
 * UTC offset in minutes for an IANA zone at an instant, or null. ml_venues
 * stores the zone name; crowdEngine.venueLocalNow wants minutes. Same
 * fallback contract as everywhere else: null means "use the server clock".
 */
function tzOffsetMinutes(timeZone, at = new Date()) {
  if (!timeZone) return null;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const parts = {};
    for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute)
    );
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hour12(h) {
  const n = ((Number(h) % 24) + 24) % 24;
  const period = n >= 12 ? 'PM' : 'AM';
  const display = n === 0 ? 12 : n > 12 ? n - 12 : n;
  return `${display} ${period}`;
}

// hour12 above takes a bare hour. The intake clock COLUMNS do not hold one:
// kitchen_last_order and its siblings come back as database time strings
// ('21:00', '21:30'), and printing one straight into prose put "your last
// orders at 21:00" in the same sentence as "around 8 PM". One room, two
// vocabularies, and the raw one is the database's. This is the same defect
// commit 1d0538b fixed for DATE columns on the last two cards, and
// advisorPhrasing.clock12 fixed for the PHRASED answer. The fact LABELS the
// phrasing reads from were still carrying the raw clock column, so the
// template twin and every card printed it.
//
// An unparseable value returns null so the caller can fall back to the raw
// string. A time we cannot read is still the owner's own answer, and dropping
// it would be worse than printing it plainly.
function clockTime(value) {
  const m = /^(\d{1,2}):([0-5]\d)/.exec(String(value === null || value === undefined ? '' : value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (!Number.isInteger(h) || h > 23) return null;
  return m[2] === '00' ? hour12(h) : hour12(h).replace(' ', `:${m[2]} `);
}

function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// '2026-08-22' is a database value. An owner reading their own card sees
// "Aug 22" everywhere else on it, so a raw ISO string dropped into the middle
// of a sentence is the column name leaking into copy. Rendered in UTC, for the
// same reason advisorPhrasing.shortAsOf is: these are calendar days, not
// instants, and formatting one in the server's zone moved it back a day for
// every host west of Greenwich. Anything that is not a plain ISO date renders
// verbatim, so a phrase never gets squeezed into a precision it lacks.
function shortDate(value) {
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return s;
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** The venue-shaped object mlPredictor.predictBusyness scores from. */
function venueForScoring(ctx, now = new Date()) {
  const m = ctx.mlVenue;
  if (!m) return null;
  return {
    place_id: ctx.profile.google_place_id,
    google_place_id: ctx.profile.google_place_id,
    name: m.name || ctx.profile.business_name || '',
    rating: m.rating != null ? Number(m.rating) : null,
    user_ratings_total: m.review_count != null ? Number(m.review_count) : 0,
    price_level: m.price_level != null ? Number(m.price_level) : null,
    types: Array.isArray(m.google_types) ? m.google_types : [],
    location: { latitude: Number(m.latitude), longitude: Number(m.longitude) },
    utcOffsetMinutes: tzOffsetMinutes(m.timezone, now),
  };
}

/** The venue's "today", server-Date shaped, per the /intelligence idiom. */
function venueBaseDate(utcOffsetMinutes, now) {
  const clock = crowdEngine.venueLocalNow(utcOffsetMinutes, now);
  const localDay = clock ? clock.day : now.getDay();
  const base = new Date(now);
  base.setDate(base.getDate() + crowdEngine.weekdayOffset(base.getDay(), localDay));
  return base;
}

const intakeAsOf = (profile) =>
  profile.updated_at ? `owner-set ${toDateStr(profile.updated_at)}` : 'owner-set (date not recorded)';

// ─── The venue's own curve, and the hours it actually runs ───────────────────
//
// Roost serves ANY venue type (Jayden's directive 2026-08-19): a breakfast
// cafe peaks at 8 AM, so nothing here may hardcode an evening window. The
// venue's Google-derived weekly curve says which hours the building actually
// runs, per weekday, and every scan below walks THOSE hours. No dayparts are
// assumed, no nightlife vocabulary is used; a peak is wherever the venue's own
// day puts it.

async function fetchBaselineCurve(placeId) {
  const { rows } = await pool.query(
    `SELECT day_of_week, hour, baseline
       FROM ml_venue_baselines
      WHERE google_place_id = $1`,
    [placeId]
  );
  return rows
    .map((r) => ({ day: Number(r.day_of_week), hour: Number(r.hour), baseline: Number(r.baseline) }))
    .filter((r) => Number.isFinite(r.day) && Number.isFinite(r.hour) && Number.isFinite(r.baseline));
}

/** Hours with any recorded activity, per weekday (0=Sunday), ascending. */
function openHoursByDay(curve) {
  const days = Array.from({ length: 7 }, () => []);
  for (const r of curve) {
    if (r.day >= 0 && r.day <= 6 && r.baseline > 0) days[r.day].push(r.hour);
  }
  for (const list of days) list.sort((a, b) => a - b);
  return days;
}

/** The curve's own busiest hour per weekday, or null where nothing registers. */
function busiestHourByDay(curve) {
  const best = Array.from({ length: 7 }, () => null);
  for (const r of curve) {
    if (r.day < 0 || r.day > 6 || r.baseline <= 0) continue;
    if (best[r.day] === null || r.baseline > best[r.day].baseline) best[r.day] = { hour: r.hour, baseline: r.baseline };
  }
  return best.map((b) => (b ? b.hour : null));
}

/** The strongest scored day in a week-ahead fact list, or null. */
function strongestPeak(entries) {
  let best = null;
  for (const f of entries) {
    if (isRefusal(f) || !f.id || !String(f.id).startsWith('peak_')) continue;
    const score = Number(f.value && f.value.peakScore);
    if (!Number.isFinite(score)) continue;
    if (!best || score > Number(best.value.peakScore)) best = f;
  }
  return best;
}

/** Mean of the positive baseline hours per weekday: the day's typical strength. */
function dayMeans(curve) {
  const sums = Array.from({ length: 7 }, () => ({ total: 0, n: 0 }));
  for (const r of curve) {
    if (r.day < 0 || r.day > 6 || r.baseline <= 0) continue;
    sums[r.day].total += r.baseline;
    sums[r.day].n += 1;
  }
  return sums.map((s, day) => (s.n > 0 ? { day, mean: s.total / s.n } : null)).filter(Boolean);
}

// ─── Card 1: Week ahead ──────────────────────────────────────────────────────
//
// Projected peak window per day for the next 7 days, each carrying its
// predictionMethod, tagged estimate, and gated hard on the corpus: without a
// baseline the whole card is ONE refusal, and no model call is spent finding
// that out (the gate is a field read on the profile row, 030's design intent).
// The scan covers the venue's FULL operating hours from its own curve, so a
// breakfast peak at 8 AM surfaces exactly like a dinner peak at 8 PM.
async function buildWeekAhead(ctx, { now = new Date(), userId } = {}) {
  const gate = corpusGate(ctx.profile);
  if (gate) return [gate];
  if (!ctx.mlVenue) {
    // 'baselines' with no ml_venues row is a drifted corpus; refuse honestly
    // rather than scoring a venue we cannot shape.
    return [makeRefusal({
      id: 'refuse_no_corpus_row',
      reason: 'This venue is flagged as modelled but its corpus row is missing, so no forecast can be built right now.',
      whatWouldUnlock: 'A corpus recheck on our side. Nothing on yours.',
    })];
  }

  const venue = venueForScoring(ctx, now);
  const weather = await weatherService.getWeather(
    venue.location.latitude, venue.location.longitude, { userId }
  ).catch(() => null);
  const base = venueBaseDate(venue.utcOffsetMinutes, now);
  const curve = await fetchBaselineCurve(ctx.profile.google_place_id);
  const openByDay = openHoursByDay(curve);
  const out = [];

  for (let d = 0; d <= 6; d++) {
    const day = new Date(base);
    day.setDate(day.getDate() + d);
    const date = day.toISOString().slice(0, 10);
    const weekday = WEEKDAY_NAMES[day.getDay()];

    // The venue's own hours for this weekday. No hardcoded window: a cafe's
    // scan starts at 6 AM, a club's at 9 PM, because the curve says so.
    const scanHours = openByDay[day.getDay()];
    if (!scanHours.length) {
      out.push(makeRefusal({
        id: `refuse_peak_${date}`,
        reason: `Your Google profile's curve shows no activity on ${weekday}, so there is no peak to project for that day.`,
        whatWouldUnlock: 'Google recording activity for that day, or your own slider readings building a curve of your own.',
      }));
      continue;
    }

    let peak = null;
    for (const h of scanHours) {
      const ts = new Date(day);
      ts.setHours(h, 0, 0, 0);
      try {
        const r = await mlPredictor.predictBusyness(venue, weather, ts, { userId });
        if (r && Number.isFinite(Number(r.score)) && (!peak || Number(r.score) > peak.score)) {
          peak = {
            score: Number(r.score), hour: h,
            method: r.predictionMethod || 'rule_engine',
            modelVersion: r.modelVersion || null,
          };
        }
      } catch { /* one dead hour does not kill the day; a day with no hours refuses below */ }
    }

    if (!peak) {
      out.push(makeRefusal({
        id: `refuse_peak_${date}`,
        reason: `No forecast for ${weekday}. The model returned nothing for that day.`,
        whatWouldUnlock: 'A model score for that day. This is usually transient.',
      }));
      continue;
    }
    if (peak.method !== 'ml') {
      // A rule-engine number is a category prior: the same figure for every
      // venue like this one. Suppressed rather than dressed as a forecast,
      // the same rule the strip's hedge enforces.
      out.push(makeRefusal({
        id: `refuse_peak_${date}`,
        reason: `${weekday} was scored by category rules, not by the model, so the number would be the same for every venue like yours. We do not present that as your forecast.`,
        whatWouldUnlock: 'A model scored day for this venue. The baseline curve exists, so this is usually transient.',
      }));
      continue;
    }

    const support = crowdEngine.describePredictionSupport('ml', 0);
    out.push(makeFact({
      id: `peak_${date}`,
      value: { date, weekday, peakHour: peak.hour, peakScore: peak.score, modelVersion: peak.modelVersion },
      source: support.basis,
      asOf: now.toISOString(),
      predictionMethod: 'ml',
      gate: 'corpus_status=baselines',
      unit: '0-100 index',
      label: `${weekday} projects busiest around ${hour12(peak.hour)}, at ${peak.score} on our 0 to 100 index. This is an estimate, not a promise of foot traffic.`,
    }));
  }
  return out;
}

// ─── The street the OWNER says they are on ───────────────────────────────────
//
// anchor_types and anchor_note belong to the street card, because that is
// where the listed events are and the whole value of the pair is that they sit
// next to each other. 030's own header: "a stadium across the road is a demand
// event the model cannot see, because the model cannot see where the venue
// is." Our listings cannot see a campus or a hospital at all, and the owner is
// the only party who ever told us one is there.
//
// Both are context, both are attributed, and neither is offered as the reason
// for anything. The street card is what routes/advisor.js composes into
// slow_night, which is the why-layer's differencing shape, and
// ADVISOR-WHY-LAYER's grammar allows a condition to be stated and forbids it
// to be blamed.
function ownerStreetContext(ctx, now) {
  const out = [];
  const anchors = Array.isArray(ctx.profile.anchor_types) ? ctx.profile.anchor_types : [];
  const asOf = intakeAsOf(ctx.profile);

  if (anchors.length) {
    out.push(makeFact({
      id: 'intake_anchor_types',
      value: anchors,
      source: 'intake',
      asOf,
      label: `You told us what is next to you: ${anchorWords(anchors)}.`,
    }));
    // The honest limit of the events card, computed from what the owner told
    // us. An owner who named a campus is reading a listings feed that will
    // never contain one, and saying so is worth more than a quiet zero.
    const unlisted = anchors.filter((t) => !TICKETED_ANCHORS.has(t));
    if (unlisted.length) {
      out.push(makeFact({
        id: 'anchors_our_listings_miss',
        value: { yourAnchors: anchors, notCoveredByListings: unlisted },
        source: 'arithmetic',
        from: ['intake_anchor_types'],
        asOf: now.toISOString(),
        label: `Our event listings cover ticketed events, so ${anchorWords(unlisted)} will not appear on this card whatever is happening there. You told us that is next to you, and we cannot watch it.`,
      }));
    }
  }

  const note = ownerProse(ctx.profile.anchor_note, OWNER_TEXT_MAX.anchor_note, {
    promptId: 'prompt_anchor_note',
    promptReason: 'You have not told us what sits around your venue.',
    promptUnlock: 'Name it in venue settings and it reads back here, beside the events we can list and the ones we cannot.',
  });
  if (note.text) {
    out.push(makeFact({
      id: 'intake_anchor_note',
      value: note.text,
      source: 'intake',
      asOf,
      textOnly: true,
      label: `On what is around you, you told us: "${note.text}"`,
      note: 'The owner\'s own words about their own street. We do not verify it and nothing we hold measures it.',
    }));
  } else if (anchors.length === 0 || note.refusal.id !== 'prompt_anchor_note') {
    // Only PROMPT when the whole subject is blank: an owner who picked anchor
    // types and skipped the sentence has answered the question. A withheld
    // note is always reported, because something IS in there.
    out.push(note.refusal);
  }
  return out;
}

// ─── Card 2: Around you this week ────────────────────────────────────────────
//
// Ticketmaster listings within ~1km over the next 7 days plus the weekend
// weather line. Presence is a fact; attendance is a vendor-side heuristic and
// is deliberately NOT surfaced (ADVISOR-WHY-LAYER D3: say "a listed event",
// never a headcount). Weather is context only, never an explanation.
async function buildAroundYou(ctx, { now = new Date(), userId } = {}) {
  const m = ctx.mlVenue;
  // The owner's own account of their street is built FIRST and returned on
  // both paths. A venue with no coordinates is a venue outside the corpus,
  // which 030's header records as the MODAL case, and for that venue what the
  // owner told us is the only thing this card can honestly hold. Putting it
  // behind the coordinates gate would have hidden it from exactly the venues
  // it is worth the most to.
  const street = ownerStreetContext(ctx, now);
  if (!m || m.latitude == null || m.longitude == null) {
    return [...street, makeRefusal({
      id: 'refuse_no_location',
      reason: 'We do not hold map coordinates for this venue, so we cannot look up events or weather around it.',
      whatWouldUnlock: 'Coordinates arrive when this venue enters our measured corpus. Nothing on your side is missing.',
    })];
  }
  const lat = Number(m.latitude);
  const lng = Number(m.longitude);
  const offset = tzOffsetMinutes(m.timezone, now);
  const out = [];

  // Probe each day at the venue's OWN busiest curve hour, so a brunch spot
  // checks the street mid-morning and a club checks it at night. 19:00 local
  // is only the fallback when no curve hour exists for that weekday.
  let probeHourByDay = Array.from({ length: 7 }, () => null);
  try {
    probeHourByDay = busiestHourByDay(await fetchBaselineCurve(ctx.profile.google_place_id));
  } catch { /* no curve is fine; the fallback hour covers it */ }

  // Events, one probe per day. Rides mlPredictor's shared event cache and
  // budget; a missing key refuses instead of reading as a quiet street.
  if (!process.env.TICKETMASTER_API_KEY) {
    out.push(makeRefusal({
      id: 'refuse_events_unavailable',
      reason: 'Event listings are not available right now.',
      whatWouldUnlock: 'The events feed coming back on our side.',
    }));
  } else {
    // The venue's local calendar, walked from its own midnight.
    const shifted = offset != null ? new Date(now.getTime() + offset * 60000) : new Date(now);
    const y = offset != null ? shifted.getUTCFullYear() : shifted.getFullYear();
    const mo = offset != null ? shifted.getUTCMonth() : shifted.getMonth();
    const da = offset != null ? shifted.getUTCDate() : shifted.getDate();
    let sawEvent = false;
    for (let d = 0; d <= 6; d++) {
      const dayForDow = offset != null ? new Date(Date.UTC(y, mo, da + d)) : new Date(y, mo, da + d);
      const dow = offset != null ? dayForDow.getUTCDay() : dayForDow.getDay();
      const probeHour = probeHourByDay[dow] != null ? probeHourByDay[dow] : 19;
      // The probe hour on the venue's wall clock, expressed as a true instant.
      const instant = offset != null
        ? new Date(Date.UTC(y, mo, da + d, probeHour, 0) - offset * 60000)
        : new Date(y, mo, da + d, probeHour, 0);
      let ev = null;
      try {
        ev = await mlPredictor._internals.getNearbyEvents(lat, lng, instant, userId);
      } catch { ev = null; }
      if (!ev || !ev.hasEvent) continue;
      const dist = Number(ev.nearestDistance);
      if (!Number.isFinite(dist) || dist > EVENT_RADIUS_KM) continue;
      sawEvent = true;
      const evDate = dayForDow.toISOString().slice(0, 10);
      const weekday = WEEKDAY_NAMES[dow];
      const distRounded = Math.round(dist * 10) / 10;
      // The vendor's title, made safe to print and safe to put in a prompt.
      const evName = externalText(ev.nearestName);
      out.push(makeFact({
        id: `event_${evDate}`,
        value: {
          date: evDate, weekday,
          name: evName || 'Listed event',
          distanceKm: distRounded,
          type: externalText(ev.nearestType, { max: 24 }),
        },
        source: 'events',
        asOf: now.toISOString(),
        note: 'A ticketed listing near you. Whether an event night feeds your room or drains it is not something we can measure yet.',
        label: `${weekday}: a listed event about ${distRounded} km away, ${evName || 'unnamed listing'}.`,
      }));
    }
    if (!sawEvent) {
      out.push(makeFact({
        id: 'no_listed_events',
        value: { listedEventsWithinRadius: 0, radiusKm: EVENT_RADIUS_KM, windowDays: 7 },
        source: 'events',
        asOf: now.toISOString(),
        label: 'No big listed events within about a kilometer over the next 7 days. That covers ticketed listings only, not everything happening on your street.',
      }));
    }
  }

  out.push(...street);

  // The weekend weather line: Friday, Saturday, Sunday from the daily forecast.
  const forecast = await weatherService.getForecast(lat, lng, { userId }).catch(() => null);
  if (!forecast || !Array.isArray(forecast)) {
    out.push(makeRefusal({
      id: 'refuse_weather_unavailable',
      reason: 'The weather outlook is not available right now.',
      whatWouldUnlock: 'The weather feed answering again. This is usually transient.',
    }));
  } else {
    for (const entry of forecast) {
      if (!entry || typeof entry.date !== 'string') continue;
      const dow = new Date(`${entry.date}T12:00:00Z`).getUTCDay();
      if (dow !== 5 && dow !== 6 && dow !== 0) continue;
      const weekday = WEEKDAY_NAMES[dow];
      const temp = entry.temp != null && Number.isFinite(Number(entry.temp)) ? Math.round(Number(entry.temp)) : null;
      // The weather vendor's phrase, same treatment as the event title.
      const conditions = externalText(entry.conditions, { max: 40 });
      out.push(makeFact({
        id: `weather_${entry.date}`,
        value: { date: entry.date, weekday, conditions, middayTempF: temp },
        source: 'weather',
        asOf: now.toISOString(),
        note: 'Context only. Weather is never offered as the explanation of a number.',
        label: temp != null
          ? `${weekday} ${shortDate(entry.date)}: ${conditions || 'no conditions reported'}, around ${temp} F midday.`
          : `${weekday} ${shortDate(entry.date)}: ${conditions || 'no conditions reported'}.`,
      }));
    }
  }
  return out;
}

// ─── Card 3: Your listing, read back ─────────────────────────────────────────
//
// Pure arithmetic over the 030 intake columns and the card-1 forecast. Every
// owner-typed value is attributed ("you told us"); every derived number is an
// arithmetic fact naming the facts it came from. Empty intake fields become a
// prompt to complete intake, never a guess.
async function buildListingReadBack(ctx, weekFacts, { now = new Date() } = {}) {
  const p = ctx.profile;
  const asOf = intakeAsOf(p);
  const out = [];
  const facts = Array.isArray(weekFacts) ? weekFacts : [];
  const peakFact = facts.find((f) => !isRefusal(f) && f.id && f.id.startsWith('peak_')) || null;
  const gateReason = corpusGate(p);

  // kitchen_last_order vs projected peak — migration 030's flagship sentence.
  if (p.kitchen_last_order) {
    // The VALUE keeps the column exactly as stored: it is data, it is what the
    // placeholder path and any consumer downstream should read, and rounding a
    // stored time into prose form would lose the minutes. Only the LABEL, which
    // is the sentence an owner reads, gets the clock treatment.
    const kitchenClock = clockTime(p.kitchen_last_order) || p.kitchen_last_order;
    const kitchenFact = makeFact({
      id: 'intake_kitchen_last_order',
      value: p.kitchen_last_order,
      source: 'intake',
      asOf,
      label: `You told us the kitchen takes last orders at ${kitchenClock}.`,
    });
    out.push(kitchenFact);
    if (peakFact) {
      const kitchenHour = Number(String(p.kitchen_last_order).slice(0, 2));
      const { peakHour, weekday, date } = peakFact.value;
      // The ordering claim is only drawn when both clocks read as the same
      // service day. A last-order time in the small hours (an overnight
      // kitchen) makes "before/after" ambiguous against ANY peak, and a
      // morning peak (a cafe) against an evening kitchen is simply "before".
      // Roost serves every venue type, so the arithmetic must survive both.
      const comparable = Number.isFinite(kitchenHour) && kitchenHour >= 6;
      const peakAtOrAfterLastOrder = comparable ? peakHour >= kitchenHour : null;
      out.push(makeFact({
        id: 'kitchen_vs_peak',
        value: { kitchenLastOrder: p.kitchen_last_order, peakHour, peakDate: date, peakAtOrAfterLastOrder },
        source: 'arithmetic',
        from: [kitchenFact.id, peakFact.id],
        asOf: now.toISOString(),
        label: !comparable
          ? `Your kitchen takes last orders at ${kitchenClock} and ${weekday}'s projected peak lands around ${hour12(peakHour)}. Overnight hours make the order of those two ambiguous, so we state both and stop.`
          : peakAtOrAfterLastOrder
            ? `${weekday}'s projected peak lands around ${hour12(peakHour)}, at or after your last orders at ${kitchenClock}. Two facts, side by side.`
            : `${weekday}'s projected peak lands around ${hour12(peakHour)}, before your last orders at ${kitchenClock}.`,
      }));
    } else if (gateReason) {
      out.push(makeRefusal({
        id: 'refuse_kitchen_vs_peak',
        // NAME WHAT WE HOLD, THEN LET THE GATE SAY WHY, ONCE. The prefix used
        // to carry "but no forecast of ours to set beside it" and gateReason
        // immediately said the same thing in its own words. Two sentences, one
        // fact, and the reader has to check whether the second is a new claim.
        reason: 'You have told us when the kitchen takes last orders. ' + gateReason.reason,
        whatWouldUnlock: gateReason.whatWouldUnlock,
      }));
    }
  } else {
    out.push(makeRefusal({
      id: 'prompt_kitchen_last_order',
      reason: 'You have not told us when the kitchen takes last orders.',
      whatWouldUnlock: 'Add it in venue settings and this line reads your kitchen clock against the projected peak.',
    }));
  }

  // owner_busy_nights (the 030 column name) vs the venue's own Google-derived
  // curve. 030's comments call this disagreement the only thing on the list
  // worth money on its own. Labels and derived ids are TIME-NEUTRAL ("busy
  // days"): the comparison is between days of the week, computed over the
  // venue's full operating hours, so a breakfast cafe's strong Sunday counts
  // exactly like a bar's strong Friday.
  const ownerBusyDays = Array.isArray(p.owner_busy_nights) ? p.owner_busy_nights : null;
  if (ownerBusyDays && ownerBusyDays.length) {
    const beliefFact = makeFact({
      id: 'intake_owner_busy_nights',
      value: ownerBusyDays,
      source: 'intake',
      asOf,
      label: `You told us your busy days are ${ownerBusyDays.join(', ')}.`,
    });
    out.push(beliefFact);
    if (!gateReason) {
      const means = dayMeans(await fetchBaselineCurve(p.google_place_id));
      if (means.length) {
        const best = Math.max(...means.map((r) => r.mean));
        const curveDays = means
          .filter((r) => best > 0 && r.mean >= 0.85 * best)
          .sort((a, b) => b.mean - a.mean)
          .map((r) => WEEKDAY_NAMES[r.day].toLowerCase());
        // A FLAT CURVE HAS NO STRONGEST DAY, AND MUST SAY SO.
        //
        // The 85% band had a floor and no ceiling, so a venue whose week is
        // level cleared it on every day and the card published all seven as
        // "your strongest days". That is a null result wearing a fact's
        // clothes, which is the exact failure the rest of this module exists
        // to prevent: it reads as a measurement, it is unfalsifiable, and it
        // is the same sentence a venue with a real Friday spike gets.
        //
        // Six of seven is the ceiling because a week with one quiet day is
        // still a week without a peak. Past it the honest answer is the null
        // one, and the agreement fact is dropped entirely rather than
        // computed: "you and your curve agree on Friday" is worthless when the
        // curve agreed with every day the owner could possibly have named.
        const flatCurve = curveDays.length >= FLAT_CURVE_MIN_DAYS;
        const curveFact = makeFact({
          id: 'google_baseline_busy_days',
          value: { days: flatCurve ? [] : curveDays, window: 'the venue\'s own operating hours' },
          source: 'google_baseline',
          asOf: CORPUS_AS_OF,
          label: flatCurve
            ? 'No day stands out in your Google curve. Every day of the week sits close to the strongest one, so we name none of them.'
            : `Your Google profile's strongest days in the spring 2026 corpus: ${curveDays.join(', ') || 'none stood out'}.`,
        });
        out.push(curveFact);
        if (!flatCurve) {
          const shared = ownerBusyDays.filter((n) => curveDays.includes(n));
          out.push(makeFact({
            id: 'busy_days_agreement',
            value: { youSaid: ownerBusyDays, curveSays: curveDays, sharedDays: shared },
            source: 'arithmetic',
            from: [beliefFact.id, curveFact.id],
            asOf: now.toISOString(),
            label: shared.length
              ? `You and your Google curve agree on ${shared.join(', ')}.`
              : 'Your busy days and your Google curve\'s strongest days do not line up. Worth a look. We state both and stop there.',
          }));
        }
      }
    } else {
      out.push(makeRefusal({
        id: 'refuse_busy_days_check',
        reason: 'You have told us which days run busiest for you. ' + gateReason.reason,
        whatWouldUnlock: gateReason.whatWouldUnlock,
      }));
    }
  } else {
    out.push(makeRefusal({
      id: 'prompt_owner_busy_days',
      reason: 'You have not told us which days usually run busiest for you.',
      whatWouldUnlock: 'Pick them in venue settings and this line checks your read of the week against the measured curve.',
    }));
  }

  // capacity turns the 0-100 index into people — arithmetic on the owner's own
  // number, labelled as such.
  if (p.capacity != null && Number.isFinite(Number(p.capacity))) {
    const capacity = Number(p.capacity);
    const capacityFact = makeFact({
      id: 'intake_capacity',
      value: capacity,
      source: 'intake',
      asOf,
      label: `You told us your capacity is ${capacity}.`,
    });
    out.push(capacityFact);
    if (peakFact) {
      const approxPeople = Math.round((capacity * Number(peakFact.value.peakScore)) / 100);
      out.push(makeFact({
        id: 'capacity_at_projected_peak',
        value: { capacity, peakScore: peakFact.value.peakScore, approxPeople },
        source: 'arithmetic',
        from: [capacityFact.id, peakFact.id],
        asOf: now.toISOString(),
        label: `At your stated capacity of ${capacity}, a reading of ${peakFact.value.peakScore} is roughly ${approxPeople} people. Arithmetic on your own number, not a headcount.`,
      }));
    }
  } else {
    out.push(makeRefusal({
      id: 'prompt_capacity',
      reason: 'You have not told us your capacity.',
      whatWouldUnlock: 'Add it in venue settings and the 0 to 100 index turns into people.',
    }));
  }

  // ── The week the owner PROGRAMMES ────────────────────────────────────────
  //
  // event_nights and event_note are one answer to one question ("which days,
  // and what runs on them"), so they are read back as one. The nights are a
  // closed set and the note is the owner's own sentence about them; neither is
  // a claim about anybody's numbers. Set beside the week's strongest projected
  // day, which is the same juxtaposition shape as kitchen-versus-peak: two
  // facts, both sourced, and no arrow drawn between them.
  const eventDays = Array.isArray(p.event_nights) ? p.event_nights : [];
  if (eventDays.length) {
    const eventDaysFact = makeFact({
      id: 'intake_event_nights',
      value: eventDays,
      source: 'intake',
      asOf,
      label: `You told us you run something on ${eventDays.join(', ')}.`,
    });
    out.push(eventDaysFact);
    const strongest = strongestPeak(facts);
    if (strongest) {
      const { weekday, date } = strongest.value;
      const programmed = eventDays.includes(String(weekday).toLowerCase());
      out.push(makeFact({
        id: 'event_days_vs_peak',
        value: {
          youProgramme: eventDays,
          strongestProjectedDay: weekday,
          strongestProjectedDate: date,
          fallsOnADayYouProgramme: programmed,
        },
        source: 'arithmetic',
        from: [eventDaysFact.id, strongest.id],
        asOf: now.toISOString(),
        label: programmed
          ? `The strongest day in this week's forecast is ${weekday}, one of the days you programme. Two facts, side by side.`
          : `The strongest day in this week's forecast is ${weekday}, which is not one of the days you programme. We state both and stop there.`,
      }));
    } else if (gateReason) {
      out.push(makeRefusal({
        id: 'refuse_event_days_vs_peak',
        reason: 'You have told us which days you programme. ' + gateReason.reason,
        whatWouldUnlock: gateReason.whatWouldUnlock,
      }));
    }
  }

  const eventNote = ownerProse(p.event_note, OWNER_TEXT_MAX.event_note, {
    promptId: 'prompt_event_note',
    promptReason: 'You have not told us what you run during the week.',
    promptUnlock: 'Name the days and what runs on them in venue settings, and they read back here against the forecast.',
  });
  if (eventNote.text) {
    out.push(makeFact({
      id: 'intake_event_note',
      value: eventNote.text,
      source: 'intake',
      asOf,
      textOnly: true,
      label: eventDays.length
        ? `On those days, you told us: "${eventNote.text}"`
        : `On what you run, you told us: "${eventNote.text}"`,
      note: 'The owner\'s own words about their own calendar. We do not verify it and nothing we hold measures it.',
    }));
  } else if (eventDays.length === 0 || eventNote.refusal.id !== 'prompt_event_note') {
    // An owner who ticked the days and skipped the sentence has answered the
    // question; only a blank subject earns the prompt. A withheld note is
    // always reported, because something is in there.
    out.push(eventNote.refusal);
  }

  // ── The thing a stranger would not guess ─────────────────────────────────
  //
  // quirks is the one intake column with no measured twin anywhere, and that
  // is exactly its value: it is what the owner knows about their own room that
  // no vendor feed, no corpus curve and no model will ever hold. So nothing is
  // set beside it. It is read back as standing context, in the owner's own
  // words, attributed to them, and the card stops there.
  const quirks = ownerProse(p.quirks, OWNER_TEXT_MAX.quirks, {
    promptId: 'prompt_quirks',
    promptReason: 'You have not told us anything about your room that a stranger would not guess.',
    promptUnlock: 'Add it in venue settings. It is the one thing here no dataset of ours can hold, so it stays beside these numbers as context we cannot measure.',
  });
  if (quirks.text) {
    out.push(makeFact({
      id: 'intake_quirks',
      value: quirks.text,
      source: 'intake',
      asOf,
      textOnly: true,
      label: `On what a stranger would not guess about your room, you told us: "${quirks.text}"`,
      note: 'The owner\'s own words, quoted back. We hold nothing that measures this, and nothing here contradicts or confirms it.',
    }));
  } else {
    out.push(quirks.refusal);
  }

  return out;
}

// ─── Card 4: What you said vs what we estimated ──────────────────────────────
//
// Last 7 days of venue_owner_reports beside served_predictions for the same
// days. Owner rows are the owner's own testimony, read back with attribution.
// Served rows are the server's own record of what it published (032 is an
// append-only serve log); they are quoted as "what we served to people who
// looked", never as a measurement of the room, and days with no serves simply
// have no row rather than an invented zero.
async function buildReadingsVsServed(ctx) {
  const p = ctx.profile;
  const tz = ctx.mlVenue?.timezone || 'UTC';
  const out = [];

  const readings = await pool.query(
    `SELECT (created_at AT TIME ZONE $2)::date AS day,
            MAX(busy_percent)::int AS peak_reading,
            COUNT(*)::int AS readings
       FROM venue_owner_reports
      WHERE google_place_id = $1 AND retracted = false
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY 1 DESC`,
    [p.google_place_id, tz]
  );
  for (const r of readings.rows) {
    const date = toDateStr(r.day);
    out.push(makeFact({
      id: `owner_reading_${date}`,
      value: { date, peakReading: Number(r.peak_reading), readings: Number(r.readings) },
      source: 'owner_report',
      asOf: date,
      label: `Your highest reading on ${shortDate(date)} was ${Number(r.peak_reading)}, from ${Number(r.readings)} ${Number(r.readings) === 1 ? 'reading' : 'readings'}. Your own numbers, read back.`,
    }));
  }
  if (readings.rows.length === 0) {
    out.push(makeRefusal({
      id: 'refuse_no_owner_readings',
      reason: 'No readings from you in the last 7 days.',
      whatWouldUnlock: 'The busy slider on your dashboard. Each reading you post lands here next to what Flock estimated for the same day.',
    }));
  }

  // PROVENANCE, THE SAME ALLOWLIST 038 WROTE FOR EVERY OTHER READER OF THIS
  // TABLE, and it was missing here (money audit round 4).
  //
  // served_predictions is written by three call sites in routes/crowd.js, and
  // one of them is POST /api/crowd/batch, whose scoring inputs arrive IN THE
  // REQUEST BODY: rating, review count, price level, types, opening hours and
  // utcOffsetMinutes are range-checked and then scored. The place id is
  // deliberately not owned by the caller either. So ANY authenticated Flock
  // account can name somebody else's venue, choose the inputs that produce the
  // number it wants, and POST twenty of them at a time.
  //
  // Every other reader already refuses those rows. routes/feedback.js takes
  // source = 'detail' only, services/ownerReportContext.js takes it before
  // writing a training label, and services/lastNightVerdict.js takes it for the
  // daily verdict. This query took everything, so the sentence card 4 reads
  // back to an owner ("Flock served N crowd estimates for your venue, median
  // X") was computed over rows a stranger could mint. The owner cannot tell,
  // because the card's whole claim is that it is reporting what WE served.
  //
  // ALLOWLIST, NOT BLOCKLIST, for 038's stated reason: `source <> 'batch'`
  // re-opens this the day a fourth write path lands, and lets the pre-038 NULL
  // rows through in the meantime (NULL <> 'batch' is NULL, never true).
  //
  // No clock predicate here, unlike ownerReportContext: this fact is a daily
  // rollup of what was on screen across the whole day, not a serve paired with
  // one owner reading at one hour.
  const served = await pool.query(
    `SELECT (served_at AT TIME ZONE $2)::date AS day,
            COUNT(*)::int AS serves,
            ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY score))::int AS median_score
       FROM served_predictions
      WHERE venue_place_id = $1
        AND served_at >= NOW() - INTERVAL '7 days'
        AND source = 'detail'
      GROUP BY 1 ORDER BY 1 DESC`,
    [p.google_place_id, tz]
  );
  for (const r of served.rows) {
    const date = toDateStr(r.day);
    out.push(makeFact({
      id: `served_${date}`,
      value: { date, serves: Number(r.serves), medianScore: r.median_score != null ? Number(r.median_score) : null },
      source: 'served_prediction',
      asOf: date,
      note: 'What Flock served to people who looked at your venue, not a measurement of your room.',
      label: `On ${shortDate(date)} Flock served ${Number(r.serves)} crowd ${Number(r.serves) === 1 ? 'estimate' : 'estimates'} for your venue, median ${r.median_score != null ? Number(r.median_score) : 'unavailable'} on the 0 to 100 index.`,
    }));
  }
  if (served.rows.length === 0) {
    out.push(makeRefusal({
      id: 'refuse_no_served_predictions',
      reason: 'Nobody was served a crowd estimate for your venue in the last 7 days.',
      whatWouldUnlock: 'This fills in on its own when people view your venue in Flock. Nothing is missing on your side.',
    }));
  }

  return out;
}

// ─── Card 5: You and venues like you ─────────────────────────────────────────
//
// Cohort differencing, the answer to "was it just us, or was everyone slow".
// The work lives in services/advisorCohort.js because it is long enough to
// deserve its own header: two halves, a k-anonymity floor of five reporting
// venues, and a worked differencing-attack analysis. Both halves build their
// output through makeFact and makeRefusal from THIS module, so the require is
// lazy on both sides and the cycle never closes at load time.
//
// Half A (typicals from the frozen corpus) answers today for any venue with a
// baseline curve. Half B (the same night, from other venues' own readings)
// refuses until five other venues in the city and category have posted for the
// same hour band, and turns itself on the night they do. The floor is checked
// against live data on every call, so nothing has to be flipped by hand.
function buildCohortStanding(ctx, opts) {
  return require('./advisorCohort').buildCohortStanding(ctx, opts);
}
function buildCohortSameNight(ctx, opts) {
  return require('./advisorCohort').buildCohortSameNight(ctx, opts);
}

module.exports = {
  // constructors and guards
  makeFact,
  makeRefusal,
  isRefusal,
  HARD_REFUSALS,
  stripOrderingFact,
  corpusGate,
  // context + cards
  getVenueContext,
  buildWeekAhead,
  buildAroundYou,
  buildListingReadBack,
  buildReadingsVsServed,
  buildCohortStanding,
  buildCohortSameNight,
  // constants + helpers, exported for the standing test
  FACT_SOURCES,
  OWNER_SOURCES,
  CORPUS_AS_OF,
  EVENT_RADIUS_KM,
  tzOffsetMinutes,
  // 'Aug 22', not '2026-08-22'. Exported because the verdict and cohort
  // builders write owner-facing sentences around the same calendar days this
  // module does, and a date helper that lives in one of three files that all
  // print dates is a raw ISO string waiting to reappear in the other two.
  shortDate,
  assertCleanCopy,
  externalText,
  EXTERNAL_TEXT_MAX,
  // owner prose: the fence plus the screen, and the copy the enum reads as
  ownerText,
  ownerProse,
  OWNER_TEXT_MAX,
  ANCHOR_WORDS,
  TICKETED_ANCHORS,
  anchorWords,
  strongestPeak,
  // curve helpers (full-operating-hours scanning; Roost serves any venue type)
  fetchBaselineCurve,
  openHoursByDay,
  busiestHourByDay,
  dayMeans,
};
