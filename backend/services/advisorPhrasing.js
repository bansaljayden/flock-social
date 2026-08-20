// ---------------------------------------------------------------------------
// Advisor phrasing — Layer C of the venue advisor (ADVISOR-GROUNDING.md).
//
// The one-way valve, stated once: facts flow to prose, never prose to facts.
// Layer B (services/advisorFacts.js) computes a typed fact block from SQL and
// existing route logic. This module turns that block into two or three
// sentences, and the LLM is allowed to touch NOTHING but the wording:
//
//   1. The model receives the fact block and a fixed system prompt. Never user
//      text, never conversation history, never a tool. One call, no loop.
//   2. The model may not write digits. Numbers appear only as {{fact:id}}
//      placeholders, and the SERVER substitutes real values after generation.
//   3. Any NUMERAL in the raw model output rejects the WHOLE output, in every
//      script Unicode has and not merely ASCII 0-9, and a spelled-out number
//      rejects any sentence that would have rendered. So does a dash of any
//      length, an unknown fact id, a causal verb, or a sentence that cites no
//      fact. Rejection is not retried ("a ceiling that retries
//      itself is not a ceiling", routes/ai.js) — the deterministic template
//      twin serves instead. Every phrased answer has a template twin, so the
//      LLM being down, over budget, or wrong costs wording, never truth.
//
// Why this is structural rather than stylistic: seven fabricated-crowd-number
// sites were purged from this repo, and a fabricated stats box was deleted
// from this exact dashboard on 2026-08-14 (SLOP-AUDIT rule 5). An
// unconstrained phrasing layer is a machine for regenerating that box.
//
// MODEL. ADVISOR_MODEL env var, default gemini-3.7-flash (Jayden's pick,
// 2026-08-19). The repo validates no model string anywhere — BIRDIE_MODEL is
// the same raw env-var idiom (routes/ai.js) — so the guard against a bad name
// is at runtime: a model the API answers 404 for is swapped once, in-process,
// for Birdie's default. Every guard here is server-side, so a model swap
// changes cost and wording quality, never truthfulness (grounding doc, guard 7).
//
// SPEND. Charge before the call, fail closed, never refund — the
// services/birdieUsage.js pattern, with the grounding doc's numbers:
//   * maxOutputTokens ACTUALLY passed to the API (closing the gap
//     birdieUsage.js documents in itself). It is sized for a THINKING model:
//     see ADVISOR_MAX_OUTPUT_TOKENS below for why the number is not a length
//     limit and why it stopped being 512 on 2026-08-20.
//   * 50 phrased answers per venue per UTC day (product cap; templates are
//     uncapped, they cost nothing).
//   * 150,000 tokens per venue per UTC day.
//   * 2,000,000 tokens global per UTC day.
// ALL THREE ARE POSTGRES-BACKED (advisor_spend, migration 035; and
// advisor_venue_spend, migration 037). birdieUsage's own header calls an
// in-memory global figure "a brake, not a cap" across deploys, and a paid
// surface starts with the fix it recommends. The per-venue pair joined it
// because a Map is per-CONTAINER, so on more than one replica a cap of fifty
// answers a day is fifty times the replica count, and the per-venue token cap
// is the number that decides how few venues can drain the global one.
// A refused charge is not an error: the template twin answers.
// ---------------------------------------------------------------------------

const { GoogleGenAI } = require('@google/genai');
const pool = require('../config/database');
const { boolFlag, warnOnce } = require('./entitlements');
const { upstreamSignal } = require('../utils/upstream');

// ── The intent registry (Layer A) ───────────────────────────────────────────
// This closed list is the entire GROUNDED question surface, and it stayed that
// way when free text arrived on 2026-08-20: a typed question about the venue's
// own numbers is routed to one of these ids and answered by the same pipeline
// the chip would have used (services/advisorFreeText.js). So the registry is
// still the whole answer surface for anything that states a number about this
// venue, and a typed question cannot reach a fact a chip could not.
//
// Layer B may refuse any of these (refusing is a first-class fact-engine
// output); the registry only says what may be ASKED, not what can be answered
// tonight, and GET /questions offers a venue only the ones its data supports.
// Ids must never contain digits: the valve rejects any digit in raw model
// output, placeholders included.
// The product's name, in exactly one backend place (its frontend twin is the
// fallback constant in components/VenueAdvisorChat.js, which prefers what
// this serves). Decided by Jayden 2026-08-19; renaming the whole feature is
// this line. The name stays quiet: a surface title, never a mascot voice.
const ADVISOR_NAME = 'Roost';

// Chips are grouped so the client can render themed sections. Every chip maps
// to a composition of Layer B's fact builders in routes/advisor.js — nothing
// here can be asked that the fact engine cannot ground or honestly refuse.
//
// "How many groups considered us" is deliberately absent: the fact engine has
// no considered-groups builder yet, and a chip that can only answer "not
// wired up" is a dead button (SLOP-AUDIT rule 5). Add the chip in the same
// change that adds its facts.
const ADVISOR_GROUPS = [
  { id: 'looking_ahead', label: 'The week ahead' },
  { id: 'looking_back', label: 'Looking back' },
  { id: 'your_room', label: 'Your room' },
  { id: 'your_street', label: 'Your street' },
  { id: 'your_data', label: 'The data behind this' },
];

// Chip copy is venue-universal: a breakfast cafe, a deli, and a nightclub all
// read these without translation. Days and times, never "nights"; the venue's
// own rhythm comes from its facts, not from the copy.
const ADVISOR_INTENTS = Object.assign(Object.create(null), {
  tonight_outlook: { chip: 'How does today look?', group: 'looking_ahead' },
  peak_hours: { chip: 'When do we peak this week?', group: 'looking_ahead' },
  weekend_outlook: { chip: 'What does the weekend look like?', group: 'looking_ahead' },
  quiet_nights: { chip: 'Which days look quiet?', group: 'looking_ahead' },
  // "How did we just do" is the most-asked question in the category by a wide
  // margin (operator telemetry across a hundred thousand plus locations puts
  // explicit forecasting at about one percent of prompts and this shape at the
  // top), and it was missing from the registry until 2026-08-20.
  //
  // It landed that morning as `last_day_compare`, which set the last day we
  // hold numbers for beside the same weekday before it and left the reader to
  // do the subtraction. It is now `last_night_verdict`, which does the
  // subtraction and says the answer: above, below, or ordinary, against the
  // venue's own same-weekday history, with a threshold that refuses to call a
  // wobble a bad day (services/lastNightVerdict.js carries the arithmetic and
  // the justification). Two chips for one question would have been a menu, so
  // the older one is gone rather than kept beside it.
  //
  // The copy says "yesterday", not "last night", for the reason the note above
  // this block gives: Roost serves breakfast cafes as well as bars.
  last_night_verdict: { chip: 'How did we do yesterday?', group: 'looking_back' },
  // The cohort pair. Question class 2 in ROOST-OWNER-INPUT, the highest
  // engagement class in the whole operator corpus and the one a single-tenant
  // POS structurally cannot answer, because no operator holds anybody else's
  // numbers. Two chips rather than one, because the two halves have different
  // subjects and different honesty: cohort_same_night is about ONE finished
  // day and needs five other venues to have reported before it says anything,
  // cohort_typical is about typicals and answers today from the frozen corpus.
  // Merging them would let a sentence about spring 2026 curves stand in for a
  // sentence about last night, which is the exact substitution the whole
  // why-layer exists to prevent.
  cohort_same_night: { chip: 'Was it just us, or was everyone slow?', group: 'looking_back' },
  cohort_typical: { chip: 'Where do we sit among venues like us?', group: 'your_street' },
  week_recap: { chip: 'What do the last seven days look like in numbers?', group: 'looking_back' },
  slow_night: { chip: 'Why was our slow day slow?', group: 'looking_back' },
  readings_vs_estimates: { chip: 'Did our readings match what Flock showed?', group: 'looking_back' },
  kitchen_vs_peak: { chip: 'Does our kitchen close before our peak?', group: 'your_room' },
  capacity_math: { chip: 'What does a busy reading mean in people?', group: 'your_room' },
  busy_nights_check: { chip: 'Are our busy times what we think they are?', group: 'your_room' },
  around_you: { chip: 'What is happening around us this week?', group: 'your_street' },
  data_status: { chip: 'What data do you have on us?', group: 'your_data' },
});

// The order chips are OFFERED in, which is a different question from what the
// registry contains. Roost's chips are whole sentences, so four is the honest
// visible budget on a phone and the rest belong behind a disclosure; this list
// decides which four a venue sees first.
//
// Three deliberate placements. THE VERDICT LEADS, and it took the top slot off
// the forecast on 2026-08-20: across 125,000+ locations, the daily recap was
// the prompt operators came back to and explicit forecasting was one percent,
// the least asked category measured, in a product that had a forecasting
// surface built in. "How does today look" is second, because it is the other
// thing an owner opens the dashboard already holding. Events and weather go
// LAST despite being the prettiest card: the same telemetry measured event and
// weather questions at about a twentieth of prompts, with nothing behind them
// in the trade forums either. Interesting to build is not the same as asked
// for.
const CHIP_PRIORITY = [
  'last_night_verdict',
  'tonight_outlook',
  // Third, inside the visible four. Forum engagement puts "are we down or is
  // everyone down" at the top of what operators actually lose sleep over, and
  // it is the one question here that no other tool in the category can take.
  // It is offered only to venues that have posted a reading of their own, so
  // the answer always has a your-side, and below the density floor the answer
  // is a refusal that names the floor. That refusal is the point, not a
  // shortfall: it is the only place the product asks for the thing that makes
  // it work.
  'cohort_same_night',
  'peak_hours',
  'quiet_nights',
  'week_recap',
  'readings_vs_estimates',
  'slow_night',
  'cohort_typical',
  'busy_nights_check',
  'kitchen_vs_peak',
  'capacity_math',
  'weekend_outlook',
  'data_status',
  'around_you',
];

function isKnownIntent(intentId) {
  return typeof intentId === 'string'
    && Object.prototype.hasOwnProperty.call(ADVISOR_INTENTS, intentId);
}

// ── Flag ─────────────────────────────────────────────────────────────────────
// DEFAULT ON since 2026-08-20. It shipped default OFF and stayed there, which
// meant the whole phrasing layer, and with it the typed question field that
// depends on it, was dark on every deploy including Jayden's own preview: he
// had never once seen the feature he asked for. A flag whose off state is
// invisible is not a safe default, it is a feature nobody can find.
//
// Off is still one env var away (ADVISOR_PHRASING_ENABLED=false), and every
// guard below is unchanged: with the flag off, or the key missing, or any
// ceiling hit, or the valve tripped, the deterministic template twin serves,
// carrying every number, so the chip surface works with zero LLM calls.
function phrasingEnabled() {
  return boolFlag('ADVISOR_PHRASING_ENABLED', true);
}

// ── Model ────────────────────────────────────────────────────────────────────
const DEFAULT_ADVISOR_MODEL = 'gemini-3.7-flash';
// Birdie's default (routes/ai.js), known-good on this key.
const FALLBACK_ADVISOR_MODEL = 'gemini-3.5-flash-lite';
let activeModel = process.env.ADVISOR_MODEL || DEFAULT_ADVISOR_MODEL;
let modelFellBack = false;

function advisorModel() {
  return activeModel;
}

function isModelNotFound(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  return /NOT_FOUND|not found|is not supported|unknown model|invalid model/i.test(err.message || '');
}

// Same lazy singleton as routes/ai.js, same key. Tests inject a fake.
let genAIClient = null;
let genAIOverride = null;
function getGenAI() {
  if (genAIOverride) return genAIOverride;
  if (!genAIClient && process.env.GEMINI_API_KEY) {
    genAIClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return genAIClient;
}

// ── Ceilings (grounding doc section 4 — hard constants, not env vars, for the
// 2am reason birdieUsage.js states) ─────────────────────────────────────────
// A THINKING MODEL SPENDS THIS BUDGET BEFORE IT WRITES A WORD, and that is
// what broke this layer silently for its whole life. gemini-3.7-flash reasons
// first and the reasoning is billed out of maxOutputTokens: at 512 it spent
// 490 tokens thinking and 18 writing, so every phrased answer came back cut
// off mid-placeholder, failed the valve, and served the template twin instead.
// Nothing logged, because a template IS a valid answer. Measured 2026-08-20
// across ninety live questions: an easy block finishes with roughly 540
// thinking tokens and 55 written, and the hardest one seen spent 1904 thinking
// and was still writing at 140, which truncated at half this ceiling. The
// number is a bound the model does not reach, not a guillotine it walks into,
// and responseText below refuses a truncated answer outright so a future model
// with a longer inner voice fails loudly instead of quietly.
//
// This is a CEILING, not a bill. The pre-charge below adds it to the ledger and
// settleTokens then trues the row to what the call actually metered, so raising
// it buys headroom rather than spend.
const ADVISOR_MAX_OUTPUT_TOKENS = 4096;
// Roost never needs deep reasoning: the phrasing model rewrites a fact block
// into two sentences, the router picks one id from a closed list, and the
// advice model follows a contract rather than deriving anything. Low is the
// floor gemini-3.7-flash accepts (MINIMAL is refused outright by this model),
// and models that do not think at all ignore the field, so the fallback takes
// it unchanged. This is a cost control, not a quality one: thinking tokens are
// billed and they count against every ceiling below.
const ADVISOR_THINKING_LEVEL = 'low';
const PER_VENUE_DAILY_ANSWERS = 50;
const PER_VENUE_DAILY_TOKENS = 150_000;
const ADVISOR_GLOBAL_DAILY_TOKENS = 2_000_000;
const CHARS_PER_TOKEN = 4; // birdieUsage's estimator convention
// Free text (services/advisorFreeText.js) gets its own, LOWER meter on the
// same row. A typed question is at least two model calls to a chip's one, and
// it is the only advisor payload the caller influences, so it is metered
// separately and more tightly than the chip path (migration 039). Twenty a day
// is a busy owner thinking out loud; it is not a loop.
const PER_VENUE_DAILY_QUESTIONS = 20;

// ── What a refused charge MEANS, which is two different things ──────────────
//
// These were booleans until 2026-08-20, and the false they returned covered
// both "this venue has spent its allowance for today" and "the meter could not
// count, so we are refusing". The free-text surface then served one sentence
// for both, and it was the sentence for the second: an owner who had simply
// used up the day's twenty questions was told we could not get to it just now
// and that it would take another go shortly. Jayden hit exactly that on his own
// preview and spent several minutes reading a working ceiling as a broken
// product, which is the whole cost of the conflation.
//
// A ceiling is a fact about the owner's own day and it has a time attached. An
// unavailable meter is a fault on our side with no time attached. They are not
// the same event, so the charge now says which one it was and the copy can
// stop guessing. A malformed charge is UNAVAILABLE rather than CEILING: a
// request larger than the whole daily cap is a bug on our side, not an
// allowance anybody spent.
const CHARGE_OK = 'ok';
const CHARGE_CEILING = 'ceiling';
const CHARGE_UNAVAILABLE = 'unavailable';

// Copied in intent from birdieUsage.accountKey: '5' and 5 share one bucket,
// anything unidentifiable is refused rather than handed a free lane.
function accountKey(userId) {
  if (typeof userId !== 'number' && typeof userId !== 'string') return null;
  const n = Number(userId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Charge the per-venue meters for one phrased answer, BEFORE the call.
// All-or-nothing, fail closed, never refunded.
//
// POSTGRES, not a Map (migration 037). These were in-process until this was
// written, on 035's reasoning that a per-venue cap is a product limit rather
// than money and that a deploy losing one is cheap. A deploy is cheap. A
// SECOND CONTAINER is not: every in-process meter in this repo is per-
// container, so a Map-backed cap of fifty answers a day quietly became fifty
// per replica, and the per-venue token cap is precisely the number that
// decides how few venues it takes to drain the global ceiling out from under
// everyone else. A fairness control that multiplies by the replica count is
// not a fairness control.
//
// The upsert refuses by returning no row. The pre-check on `tokens` matters:
// on the INSERT path there is no conflict, so the ON CONFLICT ... WHERE never
// runs and a single oversized request would otherwise open the day's row
// already over the cap.
async function allowVenuePhrasing(userId, tokens) {
  const id = accountKey(userId);
  if (id === null) return CHARGE_UNAVAILABLE;
  if (!Number.isInteger(tokens) || tokens < 1) return CHARGE_UNAVAILABLE;
  if (tokens > PER_VENUE_DAILY_TOKENS) return CHARGE_UNAVAILABLE;
  try {
    const r = await pool.query(
      `INSERT INTO advisor_venue_spend (day, venue_user_id, answers, tokens)
            VALUES (CURRENT_DATE, $1, 1, $2)
       ON CONFLICT (day, venue_user_id) DO UPDATE
            SET answers = advisor_venue_spend.answers + 1,
                tokens  = advisor_venue_spend.tokens + EXCLUDED.tokens
          WHERE advisor_venue_spend.answers + 1 <= $3
            AND advisor_venue_spend.tokens + EXCLUDED.tokens <= $4
       RETURNING tokens`,
      [id, tokens, PER_VENUE_DAILY_ANSWERS, PER_VENUE_DAILY_TOKENS]
    );
    return r.rowCount > 0 ? CHARGE_OK : CHARGE_CEILING;
  } catch (err) {
    // Same posture as the global counter: a meter that cannot count refuses.
    console.error('advisorPhrasing: venue spend counter unavailable, refusing the call:', err.message);
    return CHARGE_UNAVAILABLE;
  }
}

// The free-text twin of the charge above: one QUESTION and its tokens, on the
// same row and the same all-or-nothing terms, against the question cap rather
// than the answer cap (migration 039). A typed question that then produces a
// phrased answer is charged on BOTH meters, which is correct: it did both
// pieces of work, and the ledger should read the way the invoice does.
async function allowVenueQuestion(userId, tokens) {
  const id = accountKey(userId);
  if (id === null) return CHARGE_UNAVAILABLE;
  if (!Number.isInteger(tokens) || tokens < 1) return CHARGE_UNAVAILABLE;
  if (tokens > PER_VENUE_DAILY_TOKENS) return CHARGE_UNAVAILABLE;
  try {
    const r = await pool.query(
      `INSERT INTO advisor_venue_spend (day, venue_user_id, questions, tokens)
            VALUES (CURRENT_DATE, $1, 1, $2)
       ON CONFLICT (day, venue_user_id) DO UPDATE
            SET questions = advisor_venue_spend.questions + 1,
                tokens    = advisor_venue_spend.tokens + EXCLUDED.tokens
          WHERE advisor_venue_spend.questions + 1 <= $3
            AND advisor_venue_spend.tokens + EXCLUDED.tokens <= $4
       RETURNING tokens`,
      [id, tokens, PER_VENUE_DAILY_QUESTIONS, PER_VENUE_DAILY_TOKENS]
    );
    return r.rowCount > 0 ? CHARGE_OK : CHARGE_CEILING;
  } catch (err) {
    console.error('advisorPhrasing: venue question counter unavailable, refusing the call:', err.message);
    return CHARGE_UNAVAILABLE;
  }
}

// ── Releasing a reservation for a call that was never made ──────────────────
//
// THE ONE CASE THAT IS NOT A REFUND. Both charge functions above are written
// "never refunded", and that rule is about a call that FAILED: the upstream
// received the request and billed it, so the estimate stands whether or not we
// read the answer. This is the other case. The venue meter is charged first
// and the GLOBAL wall is checked second, so when the global wall is up, a venue
// has been charged a question (or an answer) and its tokens for a request that
// never left the process, that cost nobody anything, and that the owner was
// told to retry.
//
// Left unreleased, a shared, contagious condition -- the global ceiling, which
// any venue can drive and which none of the others can see -- silently destroys
// EVERY other venue's private daily allowance at one slot per attempt. Twenty
// attempts and a venue has spent its whole day on zero answers, having been
// invited to retry each time. Releasing here is not handing back budget that
// was spent; it is un-reserving budget that was never spent.
//
// GREATEST pins both columns at zero, so a release can never open a day's row
// below empty, and the row is only ever touched when it already exists (the
// charge that is being released created it).
function releaseVenueReservation(userId, { tokens, questions = 0, answers = 0 }) {
  const id = accountKey(userId);
  if (id === null) return;
  if (!Number.isInteger(tokens) || tokens < 0) return;
  pool.query(
    `UPDATE advisor_venue_spend
        SET tokens    = GREATEST(0, tokens - $1),
            questions = GREATEST(0, questions - $2),
            answers   = GREATEST(0, answers - $3)
      WHERE day = CURRENT_DATE AND venue_user_id = $4`,
    [tokens, questions, answers, id]
  ).catch((err) => console.error('advisorPhrasing: venue reservation release failed:', err.message));
}

// The global ceiling, denominated in money, in Postgres. One row per UTC day,
// conditionally incremented; no row back means the wall is reached (or the
// database is unreachable, and a spend control that cannot count refuses —
// the template twin answers either way, so nothing user-facing breaks).
async function allowGlobalTokens(tokens) {
  if (!Number.isInteger(tokens) || tokens < 1) return false;
  if (tokens > ADVISOR_GLOBAL_DAILY_TOKENS) return false;
  try {
    const r = await pool.query(
      `INSERT INTO advisor_spend (day, tokens) VALUES (CURRENT_DATE, $1)
       ON CONFLICT (day) DO UPDATE SET tokens = advisor_spend.tokens + EXCLUDED.tokens
       WHERE advisor_spend.tokens + EXCLUDED.tokens <= $2
       RETURNING tokens`,
      [tokens, ADVISOR_GLOBAL_DAILY_TOKENS]
    );
    return r.rowCount > 0;
  } catch (err) {
    console.error('advisorPhrasing: global spend counter unavailable, refusing the call:', err.message);
    return false;
  }
}

// True the estimate up from usageMetadata, difference only, never a refund —
// birdieUsage.settleGeminiCall's rule, applied to both ledgers.
function settleTokens(userId, estimated, actual) {
  if (!Number.isFinite(actual) || !Number.isFinite(estimated)) return;
  // A METERED FIGURE IS NOT NEGATIVE. `actual` is usageMetadata.totalTokenCount,
  // read off the upstream response with no bound on it, and every other guard
  // here is about the shape of the number rather than its sign. A negative one
  // would make `delta` larger than the charge it is reconciling, i.e. a refund
  // for more than was ever reserved. GREATEST(0, ...) floors each row so it
  // could not mint budget from an empty one, but it could empty a full one, and
  // the ledger is the thing that decides whether the next call is allowed.
  // Gemini does not send this. The clause costs one comparison.
  if (actual < 0 || estimated < 0) return;
  // BOTH DIRECTIONS, and the distinction that makes that safe: what was charged
  // before the call is an ESTIMATE, and what comes back on a successful call is
  // the metered figure. Reconciling an estimate to a measurement is what the
  // word settle means; it is not a refund, and the header's rule still stands
  // whole, because a call that FAILS never reaches this line at all. An aborted
  // or errored request keeps its full estimated charge, which is correct: the
  // upstream billed it whether or not we read the answer.
  //
  // It has to work downward now. The estimate adds maxOutputTokens, which on a
  // thinking model is deliberately far above what any answer spends: a phrased
  // call estimates around thirteen thousand tokens and meters around eight. One
  // way settling made a venue's daily token cap bite at roughly eleven answers
  // when the product cap is fifty, so the cheaper the model got, the earlier
  // the surface silently fell back to templates.
  const delta = Math.ceil(actual - estimated);
  if (delta === 0) return;
  const id = accountKey(userId);
  if (id !== null) {
    // The venue ledger is trued unconditionally, exactly like the global one
    // below: a true-up may carry a day's row past its cap, and the NEXT charge
    // is the thing that then refuses. GREATEST pins the row at zero so a
    // downward settle can never hand a venue free budget it never spent.
    pool.query(
      `UPDATE advisor_venue_spend SET tokens = GREATEST(0, tokens + $1)
        WHERE day = CURRENT_DATE AND venue_user_id = $2`,
      [delta, id]
    ).catch((err) => console.error('advisorPhrasing: venue settle failed:', err.message));
  }
  pool.query(
    'UPDATE advisor_spend SET tokens = GREATEST(0, tokens + $1) WHERE day = CURRENT_DATE',
    [delta]
  ).catch((err) => console.error('advisorPhrasing: settle failed:', err.message));
}

// ── When a spent ceiling comes back ─────────────────────────────────────────
//
// Every meter above is keyed on CURRENT_DATE, so a day's allowance returns the
// moment that date rolls over. WHICH MIDNIGHT THAT IS, IS NOT OURS TO ASSERT:
// CURRENT_DATE is evaluated in the database session's timezone, which is the
// deployment's business and not this file's. Measured on the local preview it
// is America/New_York; on Railway it is UTC. Copy naming a clock time would
// therefore be a guess in a product whose entire claim is that it does not
// guess, so the boundary is read from the same database that enforces the cap.
//
// Rendered as a DURATION rather than a time, which is both true in every zone
// and the more useful form: an owner who has run out wants to know how long,
// not what the server's calendar says. A meter we cannot read falls back to
// naming the boundary without a number, which is still true.
const RESET_UNKNOWN = 'when the day rolls over';
async function ceilingResetPhrase(now = new Date()) {
  try {
    const r = await pool.query('SELECT (CURRENT_DATE + 1)::timestamptz AS reset_at');
    const at = r.rows[0] && r.rows[0].reset_at;
    const ms = (at instanceof Date ? at.getTime() : Date.parse(at)) - now.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return RESET_UNKNOWN;
    const hours = Math.round(ms / 3_600_000);
    if (hours < 1) return 'in under an hour';
    if (hours === 1) return 'in about an hour';
    return `in about ${hours} hours`;
  } catch (err) {
    console.error('advisorPhrasing: could not read the ceiling reset boundary:', err.message);
    return RESET_UNKNOWN;
  }
}

// ── The system prompt ────────────────────────────────────────────────────────
// Fixed, cacheable, and deliberately the only place voice lives. Everything
// it asks for is ALSO enforced by the valve below, because no guard may live
// in the prompt alone (grounding doc, guard 7).
// The system prompt lives in its own module: it is a ten-page operator
// document (Jayden's direction) and the one file to edit when the voice or
// the contract changes. Every rule in it is also enforced by the valve below.
const { SYSTEM_PROMPT } = require('./advisorPrompt');

// ── The deterministic template twin ─────────────────────────────────────────
// String interpolation over the fact block, no LLM. This is what serves when
// the flag is off, the budget refuses, the model errors, or the valve trips.
// It is also the whole product for Class A answers: "the answer IS the
// number" (grounding doc, section 2).

const SOURCE_PHRASES = Object.assign(Object.create(null), {
  intake: 'you told us',
  owner_report: 'your own readings',
  model: 'model estimate',
  model_holdout: 'model estimate',
  forecast: 'model estimate',
  user_reports: 'reported by people who were there',
  votes: 'from Flock group activity',
  events: 'from Ticketmaster listings',
  weather: 'from the weather service',
  google_baseline: "your Google profile's own pattern",
  corpus: 'spring 2026 corpus',
  corpus_covariation: 'spring 2026 corpus',
  // Other venues' own readings, never one venue's and never a named one: a
  // median over at least five reporting venues (services/advisorCohort.js).
  cohort_reported: 'readings from venues like yours',
});

function sourcePhrase(source) {
  if (typeof source === 'string' && SOURCE_PHRASES[source]) return SOURCE_PHRASES[source];
  return typeof source === 'string' && source ? source.replace(/_/g, ' ') : 'unsourced';
}

// ISO-shaped strings render short; a phrase like "spring 2026" stays a phrase
// (same rule as the insight cards: never print precision the corpus lacks).
function shortAsOf(asOf) {
  if (asOf === null || asOf === undefined || asOf === '') return null;
  const s = String(asOf);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const d = new Date(t);
  // Rendered in UTC, matching the getUTCFullYear check below it. A bare
  // 'YYYY-MM-DD' parses as UTC midnight, so formatting it on the SERVER's zone
  // moved every date-only asOf back a day west of Greenwich: a fact whose own
  // sentence said "Friday 2026-08-14" was printing "(as of Aug 13)" beside
  // itself on the same line. The date is a calendar day, not an instant.
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

// '21:00' is a database value. Every other surface in this product renders an
// hour as "9 PM" (advisorFacts.hour12, the insight cards, the templates), and a
// phrased answer that says "your kitchen stops at 21:00" beside a card that
// says "9 PM" is one room described in two vocabularies.
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function clock12(h, minutes) {
  const n = ((Number(h) % 24) + 24) % 24;
  const twelve = n % 12 === 0 ? 12 : n % 12;
  const mm = minutes && minutes !== '00' ? `:${minutes}` : '';
  return `${twelve}${mm} ${n < 12 ? 'AM' : 'PM'}`;
}

// ── The vocabulary the owner picked from, spelled the way a person says it ──
//
// Intake enums are stored as the option token the form posted, and the token is
// not English: an answer that told a restaurant "your nearby anchors are
// theater_music_hall, shopping_center" printed two column values in the middle
// of a sentence. Everything the owner CHOSE (rather than typed) goes through
// this map on its way into prose. Unlisted tokens fall back to their own words
// with the underscores opened out, so a new option added to the form reads as
// English on the day it ships rather than on the day someone remembers this
// file. Owner-typed prose never reaches here: it is not an enum, it is theirs.
const ENUM_WORDS = Object.freeze({
  // venueIntake.js SERVICE_STYLES
  seated_table: 'seated table service',
  counter_order: 'counter service',
  bar_standing: 'standing room, ordering at the bar',
  mixed: 'a mix of seated and standing service',
  // RESERVATION_POLICIES
  walk_in_only: 'walk ins only',
  reservations_accepted: 'reservations and walk ins',
  reservations_required: 'reservations only',
  // AGE_POLICIES
  all_ages: 'all ages',
  eighteen_plus: 'eighteen and over',
  twenty_one_plus: 'twenty one and over',
  // WEEKDAYS. Stored lowercase because that is the option token the form
  // posts; a weekday is a proper noun in the sentence it lands in, and
  // "you told us you want to build tuesday" is a database value in prose.
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
  // ANCHOR_TYPES
  stadium_arena: 'a stadium or arena',
  college_campus: 'a college campus',
  transit_hub: 'a transit hub',
  office_district: 'an office district',
  theater_music_hall: 'a theater or music hall',
  hotel_cluster: 'a cluster of hotels',
  beach_boardwalk: 'a beach or boardwalk',
  nightlife_strip: 'a nightlife strip',
  highway_stop: 'a highway stop',
  hospital: 'a hospital',
  shopping_center: 'a shopping center',
  // venue_profiles.corpus_status. These follow the words "a status of" in
  // practice, so they are adjectival rather than noun phrases: "a status of a
  // weekly pattern we collected" is what the noun version produced.
  baselines: 'collected',
  absent: 'not collected',
  pending: 'still being collected',
});
// Multi-word tokens only, for the generic fallback: a bare word is far more
// likely to be someone's prose than an option token, and opening out
// underscores that are not there would change nothing anyway. Exact hits in the
// table above are honoured whatever their shape, which is how the single-word
// weekdays and corpus statuses get through.
const ENUM_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
function enumWords(v) {
  if (Object.prototype.hasOwnProperty.call(ENUM_WORDS, v)) return ENUM_WORDS[v];
  if (ENUM_RE.test(v)) return v.replace(/_/g, ' ');
  return null;
}

// SUBSTITUTION CAN STUTTER, and only after the fact. The model writes the noun
// it expects to need ("you run {{fact:service_style}} service", "drawn from
// {{fact:window}} days") and the server substitutes a value that already
// carries that noun, so the owner reads "seated table service service" and
// "drawn from seven days days". Both were live answers. The prompt now tells
// the model not to supply the noun, which is the fix; this is the net under it,
// because a prompt rule is a tendency and a rendered sentence is a promise.
// Only an EXACT adjacent repeat is touched, so no sentence is ever rewritten,
// only de-stuttered. English does write a doubled word ("had had", "that
// that"), and none of them can occur here: this register is short declarative
// sentences about hours and counts, and the check runs after substitution on
// text a machine assembled rather than on anything a person typed.
const STUTTER_RE = /\b([A-Za-z]+)\s+\1\b/gi;
function dedupeAdjacentWords(text) {
  return String(text).replace(STUTTER_RE, '$1');
}

function formatFactValue(fact) {
  const v = fact.value;
  if (fact.unit === 'hour' && Number.isFinite(Number(v))) return clock12(v);
  // A CALENDAR DAY IS NOT A COLUMN. '2026-08-25' reached the owner inside
  // sentences like "your highest peak lands on Tuesday, 2026-08-25" because the
  // date rode in as a scalar part of a composite fact and was transcribed
  // verbatim. Every card on the same screen writes "Aug 25".
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const short = shortAsOf(v);
    if (short) return short;
  }
  if (typeof v === 'string') {
    const m = v.match(CLOCK_RE);
    if (m) return clock12(m[1], m[2]);
    const words = enumWords(v);
    if (words) return words;
  }
  if (fact.unit === 'percent' && Number.isFinite(Number(v))) return `${v}%`;
  if (fact.unit === 'km' && Number.isFinite(Number(v))) return `${v} km`;
  if (fact.unit === 'days' && Number.isFinite(Number(v))) return `${v} days`;
  if (fact.unit === 'tempF' && Number.isFinite(Number(v))) return `${v} F`;
  // "a theater or music hall, a shopping center" is a list a database wrote.
  // The last comma becomes "and", which is what the owner would say out loud.
  if (Array.isArray(v)) {
    const words = v.map((x) => (typeof x === 'string' && enumWords(x)) || x);
    if (words.length <= 1) return words.join('');
    if (words.length === 2) return `${words[0]} and ${words[1]}`;
    return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  }
  if (v !== null && typeof v === 'object') {
    // Object values are flattened before the LLM ever sees them (below); this
    // path only serves the template twin's no-label fallback.
    return Object.entries(v)
      .filter(([, val]) => val !== null && typeof val !== 'object')
      .map(([k, val]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${val}`)
      .join(', ');
  }
  return String(v);
}

function factSources(facts) {
  return facts.map((f) => ({ id: f.sourceId || f.id, source: f.source, asOf: f.asOf }));
}

// ── Fact conditioning for the LLM path ──────────────────────────────────────
// Layer B's fact ids may carry dates ('served_2026-08-14') and object values
// ({ serves, medianScore }). Placeholder ids must be digit-free — the valve
// rejects any digit in raw output, placeholder ids included — and placeholder
// values must be scalars. So before the model sees the block: object values
// are flattened into one fact per scalar entry, and every id is re-keyed to a
// digit-free alias. `sourceId` keeps the original id for the sources chip.
// The template twin uses the RAW facts (their labels are Layer B's own hedged
// sentences); only the LLM path is conditioned.
// A UNIT THAT DESCRIBED THE WHOLE OBJECT DOES NOT DESCRIBE EACH OF ITS PARTS,
// and inheriting it wholesale is how "9 PM" reached the owner as "21". The peak
// fact is { weekday, peakHour, peakScore } carrying unit '0-100 index', which
// is true of peakScore and false of peakHour; the part inherited it, missed the
// unit === 'hour' branch in formatFactValue, and the server substituted a raw
// 24-hour integer into a sentence. The template twin never had the bug because
// it renders the fact's own label, which is why this survived until the
// phrasing layer was switched on for the first time on 2026-08-20.
//
// So a split part carries a unit derived from its OWN key, and nothing else.
// An unrecognised key gets no unit at all, which prints the value plainly, and
// plainly is the honest default: a wrong unit is a wrong claim, a missing one
// is only a plain number.
function partUnit(key) {
  if (/(^|[a-z])hour$/i.test(key)) return 'hour';
  if (/(^|[a-z])(lastorder|lastcall)$/i.test(key)) return 'hour';
  if (/(^|[a-z])(date|checkedat)$/i.test(key)) return 'date';
  if (/km$/i.test(key)) return 'km';
  if (/days$/i.test(key)) return 'days';
  // A temperature without its scale is a number with two readings, and the
  // parts of the weather fact used to inherit one from their parent. A live
  // answer read "scattered clouds at 63 for Friday".
  if (/tempf$/i.test(key)) return 'tempF';
  return undefined;
}

function flattenFacts(facts) {
  const out = [];
  for (const f of facts) {
    if (f && f.value !== null && typeof f.value === 'object' && !Array.isArray(f.value)) {
      for (const [k, v] of Object.entries(f.value)) {
        if (v === null || typeof v === 'object') continue;
        out.push({ ...f, sourceId: f.sourceId || f.id, id: `${f.id}_${k}`, value: v, unit: partUnit(k) });
      }
    } else if (f) {
      out.push(f);
    }
  }
  return out;
}

function aliasFacts(facts) {
  const used = new Set();
  return facts.map((f) => {
    const base = String(f.id || 'fact')
      .replace(/[0-9]/g, '')
      .replace(/[^A-Za-z_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'fact';
    let alias = base;
    let suffix = 'a';
    while (used.has(alias)) {
      alias = `${base}_${suffix}`;
      suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
      if (suffix > 'z') suffix = 'a'.repeat(suffix.length + 1); // never in practice
    }
    used.add(alias);
    return { ...f, id: alias, sourceId: f.sourceId || f.id };
  });
}

// Refusal copy. Layer B writes the reasons (each names the missing data and
// what would unlock the answer); this only frames them. No upsell, ever:
// "upgrade to see the answer" when the answer does not exist at any tier is
// the dark pattern ADVISOR-PRODUCT-SHAPE.md names.
const REFUSAL_LEAD = "We can't answer that yet.";
const REFUSAL_DEFAULT = "We can't answer that yet. Nothing we track at your venue grounds it so far.";

function refusalReasons(block) {
  const list = Array.isArray(block?.refusals) ? block.refusals : [];
  return list
    .map((r) => (typeof r === 'string' ? r : (r && (r.reason || r.missing || r.text)) || ''))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

function renderRefusal(block) {
  const reasons = refusalReasons(block);
  const text = reasons.length ? `${REFUSAL_LEAD} ${reasons.join(' ')}` : REFUSAL_DEFAULT;
  return { mode: 'refusal', text, sources: [] };
}

const provenancePhrase = (fact) => {
  const when = shortAsOf(fact.asOf);
  return when ? `${sourcePhrase(fact.source)}, as of ${when}` : sourcePhrase(fact.source);
};

const sentenceCase = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

// The last complete sentence of a multi-sentence label, or null. A label that
// is a single sentence has no tail to hoist: lifting it out would leave a
// blank line where the fact used to be.
function trailingSentence(text) {
  const parts = String(text).trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

// ONE ANSWER, ONE FOOTER.
//
// The per-sentence sourcing rule exists so no claim reaches an owner
// unattributed. Seven copies of one sentence honour that rule and destroy the
// answer: "when do we peak this week" returned seven paragraphs that differed
// by a weekday and a number and agreed on everything else, including the hedge
// Layer B appends to every peak label and the provenance chip after it. Seven
// screens for one sentence of information.
//
// So the rule stays and the repetition goes. When every fact in an answer
// carries the SAME source as of the SAME date, that provenance prints once, at
// the foot, under the facts it covers, and a closing sentence they all share is
// hoisted into the same line. The moment the facts disagree about where they
// came from, every line carries its own chip again, because then a single
// footer would be attributing facts to a source that did not produce them.
function renderTemplate(block) {
  const facts = Array.isArray(block?.facts) ? block.facts : [];
  const hasLabel = (f) => typeof f.label === 'string' && f.label.trim();

  // Collapsible only when there is more than one fact, every one of them
  // carries Layer B's own sentence, and they all name one source as of one
  // date. Anything else renders per line, exactly as before.
  const homogeneous = facts.length > 1
    && facts.every(hasLabel)
    && new Set(facts.map(provenancePhrase)).size === 1;
  const tails = homogeneous ? facts.map((f) => trailingSentence(f.label.trim())) : [];
  const sharedTail = homogeneous && tails.every((t) => t && t === tails[0]) ? tails[0] : null;

  const lines = facts.map((f) => {
    // Layer B facts carry a `label`: a complete, already-hedged sentence with
    // its numbers inline. Print it as written and add only the provenance
    // line. A label-less fact gets the plain "name: value" row.
    if (hasLabel(f)) {
      let sentence = f.label.trim();
      if (sharedTail) sentence = sentence.slice(0, sentence.length - sharedTail.length).trim();
      const period = /[.!?]$/.test(sentence) ? '' : '.';
      if (homogeneous) return `${sentence}${period}`;
      return `${sentence}${period} (${sentenceCase(provenancePhrase(f))}.)`;
    }
    const name = String(f.id || 'fact').replace(/_/g, ' ');
    return `${sentenceCase(name)}: ${formatFactValue(f)} (${provenancePhrase(f)}).`;
  });

  if (homogeneous) {
    const footer = `(${sentenceCase(provenancePhrase(facts[0]))}.)`;
    lines.push(sharedTail ? `${sharedTail} ${footer}` : footer);
  }
  return { mode: 'template', text: lines.join('\n'), sources: factSources(facts) };
}

// ── The valve ────────────────────────────────────────────────────────────────
// Post-generation validation and substitution, in this order. Returns null on
// ANY failure; null means the template twin serves. Never regenerates.
//
//   digits      the correct number of digits in raw phrasing output is zero.
//               No whitelist, no fuzzy matching (grounding doc, guard 2).
//   em dash     SLOP-AUDIT rule 1, enforced structurally, not just prompted.
//   causal verbs the why-layer grammar's banned list, enforced structurally.
//   citation    a sentence that references no fact does not render; an output
//               with no citing sentences at all is rejected whole.
//   substitution an unknown {{fact:id}} rejects the whole output. The model
//               cannot alter a digit it never emits.
const CAUSAL_VERBS = /\b(because|due to|caused|causes|thanks to|explains|explained by|driven by)\b/i;
const PLACEHOLDER = /\{\{fact:([A-Za-z_]+)\}\}/g;

// The digit valve, stated precisely. "No digits" has to mean no NUMBERS, and
// a bare /\d/ meant neither:
//
//   * /\d/ without the u flag is ASCII 0-9 only. Fullwidth digits, Arabic
//     Indic digits, Devanagari digits and the rest all sailed through, and
//     they render to the owner as numerals. \p{Nd} covers every decimal
//     digit Unicode has; \p{No} covers the superscripts and the vulgar
//     fractions, which are numbers wearing one code point.
//   * A model that is told not to write digits writes the words instead.
//     "around seventy on our index" is exactly the fabricated magnitude this
//     valve exists to stop, and it contains no digit at all.
//
// Rejecting costs wording and nothing else: the deterministic template twin
// serves, carrying the real numbers. So this errs strict on purpose. The
// small ordinals and "one" are left out of the word list because they carry
// ordinary prose ("no one", "one of", "first orders") far more often than
// they carry a quantity.
const UNICODE_NUMERIC = /[\p{Nd}\p{No}]/u;
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|dozen|dozens|half|quarter|twice|thrice|triple|quadruple)\b/i;
function hasNumerals(text) {
  return UNICODE_NUMERIC.test(text);
}

// SLOP-AUDIT rule 1 structurally. The em dash was the only one checked, so an
// en dash or a horizontal bar walked straight past a rule the prompt states
// three times. With every digit already rejected there is no numeric range
// left for an en dash to be legitimate in, so the whole family is refused.
const BANNED_DASHES = [0x2012, 0x2013, 0x2014, 0x2015];
function hasBannedDash(text) {
  for (const ch of text) {
    if (BANNED_DASHES.includes(ch.codePointAt(0))) return true;
  }
  return false;
}

// A VALVE REJECTION IS INVISIBLE FROM THE OUTSIDE, because the template twin
// answers and a template is a perfectly good answer. That is the right
// behaviour for the owner and the wrong behaviour for whoever has to work out
// why a surface that is switched on never phrases anything. Every exit below
// says which rule it was, once per process per rule, so the next silent
// degradation is one grep away instead of one bisect away.
function valveReject(reason) {
  warnOnce(
    `advisor:valve:${reason}`,
    `[advisor] the phrasing model's answer was rejected by the valve (${reason}) and the template served instead. `
    + 'This is safe but it is not free: the surface is running on templates until it stops.'
  );
  return null;
}

function applyValve(raw, block) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return valveReject('empty');
  if (hasNumerals(text)) return valveReject('digit in model output');
  if (hasBannedDash(text)) return valveReject('em dash');
  if (CAUSAL_VERBS.test(text)) return valveReject('causal verb');

  const facts = Array.isArray(block?.facts) ? block.facts : [];
  const byId = new Map(facts.map((f) => [String(f.id), f]));

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /\{\{fact:/.test(s));
  if (sentences.length === 0) return valveReject('no sentence cited a fact');

  // Spelled-out numbers are checked HERE, against the sentences that will
  // actually reach the owner, rather than against the whole draft. Numerals
  // above are judged on the whole draft because a model writing digits at all
  // is off-contract; a number WORD is only a fabricated quantity once it
  // renders, and the sentences dropped for citing nothing are exactly where
  // harmless prose ("these two line up") lives. Checked BEFORE substitution so
  // a venue called Seven Bar cannot reject its own answer.
  if (NUMBER_WORDS.test(sentences.join(' '))) return valveReject('number written as a word');

  const used = new Set();
  let unknownId = false;
  const rendered = sentences
    .map((s) => s.replace(PLACEHOLDER, (m, id) => {
      const f = byId.get(id);
      if (!f) { unknownId = true; return m; }
      used.add(id);
      return formatFactValue(f);
    }))
    .join(' ');
  if (unknownId) return valveReject('placeholder id not in the block');
  // A malformed placeholder that survived substitution (bad id charset,
  // unbalanced braces) is a failure, not a decoration.
  if (rendered.includes('{{') || rendered.includes('}}')) return valveReject('malformed placeholder');

  return {
    text: dedupeAdjacentWords(rendered),
    sources: [...used].map((id) => {
      const f = byId.get(id);
      return { id: f.sourceId || id, source: f.source, asOf: f.asOf };
    }),
  };
}

// ── Owner prose is context, never a placeholder value ───────────────────────
//
// Layer B marks the owner's own typed intake text with textOnly (services/
// advisorFacts.js: event_note, anchor_note, quirks). Those are the first
// strings in this product that a PERSON wrote, and they are the one kind of
// fact the placeholder grammar must not be able to carry.
//
// The reason is the order of operations in the valve. A {{fact:id}} is
// substituted AFTER the digit check has read the draft, and that is safe
// precisely because every other fact value is a number the server computed and
// stands behind. A sentence the owner typed is neither, so
// "{{fact:intake_quirks}}" would push text, and any digits inside it, through
// the one hole the valve does not watch.
//
// So they are partitioned out of the substitutable list and ride as
// ownerContext: a separate payload key with no ids in it, which is also the
// shape ADVISOR-GROUNDING's LLM contract specifies (system prompt, then the
// venue's intake context, then ONE fact block). The model may read them and
// attribute them; a model that tries to splice one writes an id that is not in
// the block, applyValve rejects the whole answer, and the template twin serves.
// The twin prints their labels either way, so the owner reads their own words
// verbatim on the path that always works and the path the flag leaves on.
function partitionOwnerContext(facts) {
  const substitutable = [];
  const ownerContext = [];
  for (const f of facts) {
    if (!f) continue;
    if (f.textOnly === true) {
      ownerContext.push({ field: f.id, text: String(f.value), source: f.source, asOf: f.asOf });
    } else {
      substitutable.push(f);
    }
  }
  return { substitutable, ownerContext };
}

// ── The one Gemini call ──────────────────────────────────────────────────────
function buildUserPayload(intent, facts, ownerContext) {
  // Typed fields only. Layer B builds facts from typed columns, never raw
  // concatenated text, which is what keeps venue names and event titles from
  // becoming prompt instructions; the system prompt's data fence is the
  // second layer, this is the first.
  return JSON.stringify({
    intent,
    facts: facts.map((f) => ({
      id: f.id,
      value: f.value,
      unit: f.unit,
      source: f.source,
      asOf: f.asOf,
      note: f.note,
    })),
    // The owner's own typed text, when they have any. A SEPARATE key from
    // `facts` on purpose: nothing in here carries a placeholder id, because
    // nothing in here is a number the server computed. Section 10 of the
    // system prompt tells the model what this key is and that it is data.
    ...(Array.isArray(ownerContext) && ownerContext.length ? { ownerContext } : {}),
  });
}

async function callModel(genAI, model, payload) {
  return genAI.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: payload }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: ADVISOR_THINKING_LEVEL },
      abortSignal: upstreamSignal('geminiAdvisor'),
    },
  });
}

/**
 * The model's answer, or null if there isn't a whole one.
 *
 * A REPLY THAT RAN OUT OF ROOM IS NOT A REPLY. finishReason MAX_TOKENS means
 * the model was still writing when the budget ended, so what came back is a
 * sentence fragment: "The forecast estimates your busiest stretch on {{fact:"
 * is a real observed value here. The valve happens to reject that one because
 * the placeholder is broken, but "your quietest stretch is early in the" is
 * also a truncation and the valve would pass it. Refusing the whole response
 * at the seam is the only check that catches both, and it turns a silent
 * half-sentence into the template twin, which is a complete answer.
 *
 * It is also the tripwire. Every caller logs this, so the next time a model's
 * inner monologue outgrows its budget the line says so instead of the surface
 * quietly reverting to templates for months, which is exactly what happened
 * between 2026-08-19 and 2026-08-20.
 */
function responseText(resp) {
  if (!resp) return null;
  if (truncated(resp)) return null;
  if (typeof resp.text === 'string') return resp.text;
  const parts = resp.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p.text || '').join('');
  return null;
}

function truncated(resp) {
  return resp?.candidates?.[0]?.finishReason === 'MAX_TOKENS';
}

// One line, once per process, naming the ceiling and what it cost. Repeating it
// per request would bury a real incident under its own alarm.
function warnTruncated(where, resp) {
  const u = resp?.usageMetadata || {};
  warnOnce(
    `advisor:truncated:${where}`,
    `[advisor] ${where}: the model hit its output ceiling before it finished writing `
    + `(thinking ${u.thoughtsTokenCount || 0} tokens, wrote ${u.candidatesTokenCount || 0}). `
    + 'The answer was discarded rather than served half written. Raise the ceiling for this call.'
  );
}

/**
 * Phrase one fact block. Always answers; the mode says how.
 *
 * @param {object} block        Layer B fact block: { intent, facts, refusals }
 * @param {object} opts         { venueUserId } — the authenticated owner's users.id
 * @returns {Promise<{mode: 'refusal'|'template'|'phrased', text: string, sources: Array, model?: string}>}
 */
async function phrase(block, { venueUserId } = {}) {
  // Refusals and empty blocks never reach the model: rule 6 rendered by the
  // server, costing zero tokens (grounding doc, guard 4 — refusal is the path
  // of least resistance).
  if (!block || !Array.isArray(block.facts)) return renderRefusal(block);
  if (refusalReasons(block).length > 0 || block.facts.length === 0) return renderRefusal(block);

  const template = renderTemplate(block);
  if (!phrasingEnabled()) return template;

  const genAI = getGenAI();
  if (!genAI) return template;

  // The owner's own prose leaves the fact list here and rides as context.
  const { substitutable, ownerContext } = partitionOwnerContext(block.facts);
  // Owner prose ALONE is not a phrasing job: there is no computed number to
  // build a sentence around and no placeholder for the model to hang one on,
  // so the call would be spent to produce something the valve rejects. The
  // twin prints the owner's words verbatim, which is the right answer anyway.
  if (substitutable.length === 0) return template;

  // Digit-free ids, scalar values: the shape the placeholder contract needs.
  const llmFacts = aliasFacts(flattenFacts(substitutable));
  const payload = buildUserPayload(block.intent, llmFacts, ownerContext);
  const estimate = Math.ceil((SYSTEM_PROMPT.length + payload.length) / CHARS_PER_TOKEN)
    + ADVISOR_MAX_OUTPUT_TOKENS;

  // Charge before the call, local then global; either refusal serves the twin.
  // The chip path does not care WHICH refusal it was: a ceiling and an
  // unreachable meter both mean the deterministic twin answers, carrying every
  // number. Only the free-text surface has to tell them apart, because only
  // there does a refusal reach the owner as a sentence instead of an answer.
  if (await allowVenuePhrasing(venueUserId, estimate) !== CHARGE_OK) return template;
  if (!(await allowGlobalTokens(estimate))) {
    // Charged locally, refused globally, and no request left this process. The
    // venue keeps its answer slot rather than paying for the wall someone else
    // reached. See releaseVenueReservation.
    releaseVenueReservation(venueUserId, { tokens: estimate, answers: 1 });
    return template;
  }

  let resp;
  try {
    resp = await callModel(genAI, activeModel, payload);
  } catch (err) {
    // A model name the API refuses is swapped once for Birdie's known-good
    // default, and the retry is a second billed attempt so it is charged like
    // one. Anything else (timeout, 5xx, quota) serves the twin — no retry;
    // the template is already the answer.
    if (isModelNotFound(err) && activeModel !== FALLBACK_ADVISOR_MODEL) {
      console.warn(`advisorPhrasing: model "${activeModel}" not accepted, falling back to "${FALLBACK_ADVISOR_MODEL}"`);
      activeModel = FALLBACK_ADVISOR_MODEL;
      modelFellBack = true;
      if (await allowVenuePhrasing(venueUserId, estimate) !== CHARGE_OK) return template;
      if (!(await allowGlobalTokens(estimate))) {
        // The same release as the branch above, for the same reason: the
        // swapped model was never called either, so the second reservation was
        // never spent. Missing here, this branch left a venue holding a full
        // second estimate for a call that never left the process.
        releaseVenueReservation(venueUserId, { tokens: estimate, answers: 1 });
        return template;
      }
      try {
        resp = await callModel(genAI, activeModel, payload);
      } catch (err2) {
        console.error('advisorPhrasing: fallback model call failed:', err2.message);
        return template;
      }
    } else {
      console.error('advisorPhrasing: model call failed:', err.message);
      return template;
    }
  }

  settleTokens(venueUserId, estimate, resp?.usageMetadata?.totalTokenCount);

  if (truncated(resp)) warnTruncated('phrasing', resp);
  const valved = applyValve(responseText(resp), { facts: llmFacts });
  if (!valved) return template;
  return { mode: 'phrased', text: valved.text, sources: valved.sources, model: activeModel };
}

// ── Shared plumbing for the free-text path ──────────────────────────────────
// services/advisorFreeText.js is Layer A grown a mouth: it runs its own model
// calls (a router pass and an advice pass) and needs the SAME client, the same
// ledgers, the same model-fallback behaviour, and the same numeric checks this
// module already owns. It gets them from here rather than growing a second
// copy, because a second copy of a spend ceiling is a spend ceiling with a
// hole in it, and a second copy of the digit check is a second place the valve
// can drift.
function noteModelNotFound() {
  if (activeModel === FALLBACK_ADVISOR_MODEL) return null;
  console.warn(`advisorPhrasing: model "${activeModel}" not accepted, falling back to "${FALLBACK_ADVISOR_MODEL}"`);
  activeModel = FALLBACK_ADVISOR_MODEL;
  modelFellBack = true;
  return activeModel;
}

const internals = {
  dedupeAdjacentWords,
  getGenAI,
  isModelNotFound,
  noteModelNotFound,
  responseText,
  truncated,
  warnTruncated,
  ADVISOR_THINKING_LEVEL,
  allowVenuePhrasing,
  allowVenueQuestion,
  allowGlobalTokens,
  settleTokens,
  ceilingResetPhrase,
  CHARGE_OK,
  CHARGE_CEILING,
  CHARGE_UNAVAILABLE,
  RESET_UNKNOWN,
  hasNumerals,
  hasBannedDash,
  formatFactValue,
  factSources,
  // The owner-prose split. Any path that builds a model payload from a fact
  // block has to run this first, or owner text becomes a placeholder value on
  // that path and the digit valve stops meaning what it says.
  partitionOwnerContext,
  releaseVenueReservation,
  sourcePhrase,
  NUMBER_WORDS,
  PLACEHOLDER,
  CAUSAL_VERBS,
  CHARS_PER_TOKEN,
};

// Every user-visible string this module can emit on its own (templates,
// refusal frames, source phrases, chips). The standing test walks this list
// for SLOP compliance (no em dashes); keep it complete when adding copy.
function __copyStrings() {
  return [
    REFUSAL_LEAD,
    REFUSAL_DEFAULT,
    ADVISOR_NAME,
    ...ADVISOR_GROUPS.map((g) => g.label),
    ...Object.values(SOURCE_PHRASES),
    ...Object.keys(ADVISOR_INTENTS).map((k) => ADVISOR_INTENTS[k].chip),
  ];
}

// Tests only. Production code must never reset a spending counter or swap the
// client.
function __setGenAIForTests(fake) {
  genAIOverride = fake;
}
function __resetAdvisorSpend() {
  activeModel = process.env.ADVISOR_MODEL || DEFAULT_ADVISOR_MODEL;
  modelFellBack = false;
}

module.exports = {
  phrase,
  renderTemplate,
  renderRefusal,
  applyValve,
  phrasingEnabled,
  advisorModel,
  isKnownIntent,
  flattenFacts,
  aliasFacts,
  ADVISOR_NAME,
  ADVISOR_GROUPS,
  ADVISOR_INTENTS,
  SYSTEM_PROMPT,
  ADVISOR_MAX_OUTPUT_TOKENS,
  ADVISOR_THINKING_LEVEL,
  PER_VENUE_DAILY_ANSWERS,
  PER_VENUE_DAILY_TOKENS,
  PER_VENUE_DAILY_QUESTIONS,
  ADVISOR_GLOBAL_DAILY_TOKENS,
  DEFAULT_ADVISOR_MODEL,
  FALLBACK_ADVISOR_MODEL,
  CHIP_PRIORITY,
  internals,
  __copyStrings,
  __setGenAIForTests,
  __resetAdvisorSpend,
};
