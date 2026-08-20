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
//   * maxOutputTokens 512, ACTUALLY passed to the API (closing the gap
//     birdieUsage.js documents in itself).
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
const { boolFlag } = require('./entitlements');
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
// Default OFF. With the flag off (or the key missing, or any ceiling hit, or
// the valve tripped) the deterministic template twin serves, so the chat
// surface works on day one with zero LLM calls.
function phrasingEnabled() {
  return boolFlag('ADVISOR_PHRASING_ENABLED');
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
const ADVISOR_MAX_OUTPUT_TOKENS = 512;
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
  if (id === null) return false;
  if (!Number.isInteger(tokens) || tokens < 1) return false;
  if (tokens > PER_VENUE_DAILY_TOKENS) return false;
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
    return r.rowCount > 0;
  } catch (err) {
    // Same posture as the global counter: a meter that cannot count refuses.
    console.error('advisorPhrasing: venue spend counter unavailable, refusing the call:', err.message);
    return false;
  }
}

// The free-text twin of the charge above: one QUESTION and its tokens, on the
// same row and the same all-or-nothing terms, against the question cap rather
// than the answer cap (migration 039). A typed question that then produces a
// phrased answer is charged on BOTH meters, which is correct: it did both
// pieces of work, and the ledger should read the way the invoice does.
async function allowVenueQuestion(userId, tokens) {
  const id = accountKey(userId);
  if (id === null) return false;
  if (!Number.isInteger(tokens) || tokens < 1) return false;
  if (tokens > PER_VENUE_DAILY_TOKENS) return false;
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
    return r.rowCount > 0;
  } catch (err) {
    console.error('advisorPhrasing: venue question counter unavailable, refusing the call:', err.message);
    return false;
  }
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
  const delta = Math.ceil(actual - estimated);
  if (!(delta > 0)) return;
  const id = accountKey(userId);
  if (id !== null) {
    // The venue ledger is trued up unconditionally, exactly like the global one
    // below: a true-up may carry a day's row past its cap, and the NEXT charge
    // is the thing that then refuses. Capping the settle instead would be a
    // refund by another name.
    pool.query(
      `UPDATE advisor_venue_spend SET tokens = tokens + $1
        WHERE day = CURRENT_DATE AND venue_user_id = $2`,
      [delta, id]
    ).catch((err) => console.error('advisorPhrasing: venue settle failed:', err.message));
  }
  pool.query(
    'UPDATE advisor_spend SET tokens = tokens + $1 WHERE day = CURRENT_DATE',
    [delta]
  ).catch((err) => console.error('advisorPhrasing: settle failed:', err.message));
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

function formatFactValue(fact) {
  const v = fact.value;
  if (fact.unit === 'hour' && Number.isFinite(Number(v))) {
    const h = ((Number(v) % 24) + 24) % 24;
    const twelve = h % 12 === 0 ? 12 : h % 12;
    return `${twelve}${h < 12 ? 'am' : 'pm'}`;
  }
  if (fact.unit === 'percent' && Number.isFinite(Number(v))) return `${v}%`;
  if (Array.isArray(v)) return v.join(', ');
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
function flattenFacts(facts) {
  const out = [];
  for (const f of facts) {
    if (f && f.value !== null && typeof f.value === 'object' && !Array.isArray(f.value)) {
      for (const [k, v] of Object.entries(f.value)) {
        if (v === null || typeof v === 'object') continue;
        out.push({ ...f, sourceId: f.sourceId || f.id, id: `${f.id}_${k}`, value: v });
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

function renderTemplate(block) {
  const facts = Array.isArray(block?.facts) ? block.facts : [];
  const lines = facts.map((f) => {
    const when = shortAsOf(f.asOf);
    const provenance = when ? `${sourcePhrase(f.source)}, as of ${when}` : sourcePhrase(f.source);
    // Layer B facts carry a `label`: a complete, already-hedged sentence with
    // its numbers inline. Print it as written and add only the provenance
    // line. A label-less fact gets the plain "name: value" row.
    if (typeof f.label === 'string' && f.label.trim()) {
      const sentence = f.label.trim();
      const period = /[.!?]$/.test(sentence) ? '' : '.';
      return `${sentence}${period} (${provenance.charAt(0).toUpperCase()}${provenance.slice(1)}.)`;
    }
    const name = String(f.id || 'fact').replace(/_/g, ' ');
    return `${name.charAt(0).toUpperCase()}${name.slice(1)}: ${formatFactValue(f)} (${provenance}).`;
  });
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

function applyValve(raw, block) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (hasNumerals(text)) return null;
  if (hasBannedDash(text)) return null;
  if (CAUSAL_VERBS.test(text)) return null;

  const facts = Array.isArray(block?.facts) ? block.facts : [];
  const byId = new Map(facts.map((f) => [String(f.id), f]));

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /\{\{fact:/.test(s));
  if (sentences.length === 0) return null;

  // Spelled-out numbers are checked HERE, against the sentences that will
  // actually reach the owner, rather than against the whole draft. Numerals
  // above are judged on the whole draft because a model writing digits at all
  // is off-contract; a number WORD is only a fabricated quantity once it
  // renders, and the sentences dropped for citing nothing are exactly where
  // harmless prose ("these two line up") lives. Checked BEFORE substitution so
  // a venue called Seven Bar cannot reject its own answer.
  if (NUMBER_WORDS.test(sentences.join(' '))) return null;

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
  if (unknownId) return null;
  // A malformed placeholder that survived substitution (bad id charset,
  // unbalanced braces) is a failure, not a decoration.
  if (rendered.includes('{{') || rendered.includes('}}')) return null;

  return {
    text: rendered,
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
      abortSignal: upstreamSignal('gemini'),
    },
  });
}

function responseText(resp) {
  if (!resp) return null;
  if (typeof resp.text === 'string') return resp.text;
  const parts = resp.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p.text || '').join('');
  return null;
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
  if (!(await allowVenuePhrasing(venueUserId, estimate))) return template;
  if (!(await allowGlobalTokens(estimate))) return template;

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
      if (!(await allowVenuePhrasing(venueUserId, estimate))) return template;
      if (!(await allowGlobalTokens(estimate))) return template;
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
  getGenAI,
  isModelNotFound,
  noteModelNotFound,
  responseText,
  allowVenuePhrasing,
  allowVenueQuestion,
  allowGlobalTokens,
  settleTokens,
  hasNumerals,
  hasBannedDash,
  formatFactValue,
  factSources,
  // The owner-prose split. Any path that builds a model payload from a fact
  // block has to run this first, or owner text becomes a placeholder value on
  // that path and the digit valve stops meaning what it says.
  partitionOwnerContext,
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
