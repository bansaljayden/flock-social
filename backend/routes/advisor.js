// ---------------------------------------------------------------------------
// The venue advisor's HTTP surface. Mounted at /api/venue/advisor (server.js).
//
// Two halves share this file:
//   GET  /cards      Layer B's deterministic insight cards (services/
//                    advisorFacts.js): the four T0 MVP cards from
//                    ADVISOR-PRODUCT-SHAPE.md §5, zero LLM, refusals as data.
//                    Shape: { cards: [{ id, title, facts, status }] }.
//   POST /ask        the chip layer: one suggested-question chip in, one
//                    grounded answer out.
//   POST /question   the typed layer (2026-08-20): one free-text question in,
//                    one of three labeled answers out. See below.
//   GET  /questions  the four chips this venue's data can answer, the rest
//                    grouped behind a disclosure, and whether the typed field
//                    is on for this deploy.
//
// THE CHAT CONTRACT, as it now stands. The original build was chips ONLY, and
// that was the right first shape: with no user text anywhere, the one-way
// valve was airtight by construction. Jayden reopened it on 2026-08-20, in his
// words: the venue can ask any question about its business and how it can
// promote, drive, or have better business. That is the T2 tier
// ADVISOR-PRODUCT-SHAPE.md already designed, brought forward by decision, and
// it lives at POST /question with refusal as its default route.
//
// /ask DID NOT CHANGE, and its shape refusal is not legacy. It still accepts
// an intentId from the closed registry and NOTHING else, answering 400 to any
// body carrying prose before a value is read. Free text got its own door
// rather than a new field on this one, because the chip path's guarantee is
// worth keeping intact and because the typed path needs its own rate limiter,
// its own daily ceiling, and its own flag.
//
// FLAGS, BOTH DEFAULT ON since 2026-08-20. ADVISOR_PHRASING_ENABLED decides
// WORDING on the chip path: off means the deterministic template twin serves,
// carrying every number, so chips still work with zero LLM calls.
// ADVISOR_FREETEXT_ENABLED is separate, because free text is not a wording
// choice: there is no template that answers a question nobody wrote a template
// for, so with that flag off (or the model unreachable) the endpoint declines
// in plain words rather than half working, and /questions reports freeText
// false so the client can say so where the field is instead of hiding it.
// Both shipped default OFF and both stayed dark on every deploy, which is how
// a built, tested, documented feature reached its owner as an absence.
//
// GATES, in order: authenticate, then requireVenueTier('pro') (grounding doc
// section 5: Pro is the advisor's home; with VENUE_BILLING_ENABLED unset the
// gate is a no-op and every claimed venue sees it, the correct pilot
// posture). ADVISOR_PHRASING_ENABLED then decides only WORDING: off means the
// deterministic template twin serves, so this surface still works with zero
// LLM calls if the flag is ever turned back off.
//
// NO WRITE PATH, by design and by test. The advisor reads; it cannot post
// promotions, edit the profile, or touch the slider. An advisor that can act
// is a different and unapproved product (grounding doc, section 5).
// ---------------------------------------------------------------------------

const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requireVenueTier, getVenueTier, venueBillingEnabled } = require('../services/venueEntitlements');
const advisorPhrasing = require('../services/advisorPhrasing');
const advisorFreeText = require('../services/advisorFreeText');
// The measured floor below which an ordering claim is not made. Commit
// 1d1b92b established it for HOURS, on the same 0 to 100 index these day
// scores live on. Imported rather than restated: a second copy of a measured
// number is a number that will drift away from its measurement.
const { HOUR_ORDERING_MIN_GAP } = require('../services/crowdEngine');

const router = express.Router();

// The feature's user-facing name (Jayden's decision 2026-08-19). Backend
// identifiers and the route path stay 'advisor'; owner-visible copy says Roost.
const FEATURE_NAME = 'Roost';
const requirePro = requireVenueTier('pro');
// The cards' floor. Card 2 (around_you) is 'premium'; the other three are
// 'pro' and come back status:'locked' below that (ADVISOR-PRODUCT-SHAPE §5).
const requirePremium = requireVenueTier('premium');

// Layer B seam. The contract consumed here: a fact block
// { intent, facts: [{ id, value, source, asOf }], refusals: [] }, with
// refusing as a first-class output. Fact computation is NEVER duplicated in
// this file; the fact engine has exactly one home (services/advisorFacts.js),
// and /ask reaches it through the bridge below. Should the engine itself ever
// be absent from a build, /ask answers 503 in plain words.
let advisorFacts = null;
try {
  // eslint-disable-next-line global-require
  advisorFacts = require('../services/advisorFacts');
} catch (err) {
  advisorFacts = null;
}

// The verdict builder lives beside the fact engine rather than inside it: it is
// the one Roost answer that reads no forecast, no corpus and no model, only the
// venue's own readings, our own serve log and the recorded conditions of the
// day. Same lazy require and same fail-soft posture, so a build without it
// loses one card and one chip instead of the whole surface.
let lastNightVerdict = null;
try {
  // eslint-disable-next-line global-require
  lastNightVerdict = require('../services/lastNightVerdict');
} catch (err) {
  lastNightVerdict = null;
}

// ── The intent -> facts bridge for /ask ──────────────────────────────────────
// If the fact engine ever grows a native buildFactBlock(userId, intentId),
// it wins outright. Until then, each chat intent is a composition of the SAME
// card builders /cards serves, so the chat can never say something the cards
// would not: one fact engine, two renderings.
//
// Entries from the builders mix facts and refusals. When at least one real
// fact exists, the partial refusals are dropped and the facts answer; when
// none does, the refusals ARE the answer, reason and unlock path joined.
function refusalText(r) {
  return [r.reason, r.whatWouldUnlock].filter(Boolean).join(' ');
}

// The trailing YYYY-MM-DD every dated builder id carries (peak_, refuse_peak_,
// event_, weather_, owner_reading_, served_).
const ID_DATE = /(\d{4}-\d{2}-\d{2})$/;
function entryDate(entry) {
  const m = entry && typeof entry.id === 'string' ? entry.id.match(ID_DATE) : null;
  return m ? m[1] : null;
}
function isWeekendDate(date) {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 5 || dow === 6 || dow === 0;
}

// One plan per chip: which builder outputs, filtered how. Filtering and
// ordering existing facts is composition; no plan computes a number the fact
// engine did not already construct. Builders are memoised per request because
// several plans read the same card.
const INTENT_PLANS = {
  // The week-ahead builder walks days in order from the venue's own today, so
  // its first entry (fact or refusal) IS tonight. Street facts for the same
  // date ride along.
  // ONE FACT IS NOT AN OUTLOOK. This plan used to hand over today's peak plus
  // whatever street facts carried today's exact date, and on most days that is
  // the peak alone: the weather feed starts at tomorrow, and the events fact
  // for a quiet street is `no_listed_events`, which carries no date at all and
  // so was filtered out by the very filter meant to keep other days out. The
  // owner asked how today looks and read one sentence, sitting under a screen
  // of cards that each carry three. Undated street facts are about the street
  // NOW and belong here; dated ones are still held to today.
  tonight_outlook: async (b) => {
    const week = await b.week();
    const tonight = week.slice(0, 1);
    const date = tonight.length ? entryDate(tonight[0]) : null;
    const around = await b.around();
    const street = around.filter((e) => {
      const d = entryDate(e);
      return d === null || d === date;
    });
    return [...tonight, ...street];
  },
  peak_hours: (b) => b.week(),
  // A REFUSAL CARRIES NO DATE, so a date filter deletes it. An out-of-corpus
  // cafe asking how Friday looks got the generic "nothing we track at your
  // venue grounds it so far", while the same venue asking about its peaks got
  // the real corpus refusal naming what is missing and how to fill it in: the
  // corpus gate's refusal has no day attached, so this filter dropped it and
  // the block arrived empty. Undated entries are kept when they are refusals,
  // which is the only kind of undated entry the week builder emits.
  weekend_outlook: async (b) => {
    const week = (await b.week()).filter((e) => {
      const d = entryDate(e);
      if (d === null) return advisorFacts.isRefusal(e);
      return isWeekendDate(d);
    });
    // Around-you weather facts are weekend-only already; keep dated street
    // entries that fall on the weekend, plus the no-events line if present.
    const street = (await b.around()).filter((e) => {
      const d = entryDate(e);
      return (d !== null && isWeekendDate(d)) || e.id === 'no_listed_events';
    });
    return [...week, ...street];
  },
  // The two quietest projected evenings: an ordering of existing peak facts,
  // lowest first. Refused days cannot be ranked and are left out unless
  // nothing at all was scored.
  // THE FACTS MUST SAY WHICH END OF THE WEEK THEY ARE. These are peak facts,
  // shaped exactly like the ones tonight_outlook and weekend_outlook hand over,
  // and the only thing that made them the QUIET days was the sort above. Asked
  // "which nights are quiet for us", the phrasing model received two ordinary
  // peak facts and wrote "the forecast estimates your busier stretches on
  // Friday and Saturday", which is the opposite of the question and reads as a
  // confident answer. A note is the block's own channel for exactly this (the
  // system prompt, section 2d: a note is a fact about the fact), so the sort
  // now travels with the facts instead of being lost the moment they leave.
  // Copied rather than mutated: the builders are memoised per request and the
  // same peak fact is served to other plans in the same breath.
  //
  // A FLAT WEEK HAS NO QUIET NIGHT, AND MUST SAY SO. Sorting always returns a
  // first element, so this chip named one whatever the spread was: a week
  // projecting 85, 88, 85, 89, 89, 90, 89 came back calling Saturday the
  // quietest at 85, which is five points off the busiest day of the same week
  // and inside the noise. Commit 3782777 refused to name a strongest DAY when
  // the Google curve was level, and 1d1b92b's HOUR_ORDERING_MIN_GAP is the
  // MEASURED floor for exactly this claim: below a ten point gap on the 0 to
  // 100 index, an ordering is not supported by the numbers underneath it.
  // Days are scored on that same index by the same model, so the same floor
  // applies. Naming one of seven near-identical days is naming noise, and it
  // reads as advice: an owner told Saturday is their quiet night may staff it
  // differently on a week where Saturday is not.
  //
  // The refusal is a REFUSAL rather than a quiet fallback to the whole week,
  // because "which days look quiet" has a real answer here and the answer is
  // none of them. It names the floor, the way every other refusal in this
  // product names what it would take.
  quiet_nights: async (b) => {
    const week = await b.week();
    const scored = week
      .filter((e) => !advisorFacts.isRefusal(e) && e.value && Number.isFinite(Number(e.value.peakScore)))
      .sort((a, z) => Number(a.value.peakScore) - Number(z.value.peakScore));
    if (!scored.length) return week;
    const spread = Number(scored[scored.length - 1].value.peakScore) - Number(scored[0].value.peakScore);
    if (spread < HOUR_ORDERING_MIN_GAP) {
      return [advisorFacts.makeRefusal({
        id: 'refuse_quiet_nights_flat_week',
        reason: `No day stands out as quiet in the week ahead. Every day projects within ${spread} points of every other on our 0 to 100 index, and we do not name a quietest day inside ${HOUR_ORDERING_MIN_GAP} points because the ordering under that is noise.`,
        whatWouldUnlock: 'A week whose days actually separate. The moment one does, this names it.',
      })];
    }
    const quietest = scored.slice(0, 2);
    return quietest.map((e, i) => ({
      ...e,
      note: [
        e.note,
        i === 0
          ? 'This is the LOWEST projected day in the week ahead. It is the quiet end of this venue\'s week, not a busy day.'
          : 'This is the second lowest projected day in the week ahead. It is the quiet end of this venue\'s week, not a busy day.',
      ].filter(Boolean).join(' '),
    }));
  },
  // "How did we just do." The most-asked question in the category, and the one
  // chip that returns a VERDICT rather than a row of numbers: the venue's own
  // highest reading yesterday, against its own recent same-weekday readings,
  // against what Flock published, with the day's recorded conditions stated
  // last and never blamed. It is its own builder rather than a composition,
  // because a verdict is arithmetic and arithmetic belongs in a fact engine,
  // not in a route plan. services/lastNightVerdict.js carries the threshold
  // and the reason it is 15 points and not 3.
  last_night_verdict: (b) => b.verdict(),
  // "Was it just us, or was everyone slow." The cohort pair, and the one
  // question class here that a single-tenant tool structurally cannot take.
  //
  // The refusal filter is the load-bearing line. /ask drops partial refusals
  // whenever any fact answered, which is right everywhere else and wrong here:
  // the same-night builder always emits the venue's OWN reading as a fact, and
  // "your highest reading was 20" is not an answer to a question about the
  // street. So when the density floor refuses, the refusal is the whole
  // answer, and the sentence that names the floor reaches the owner instead of
  // being swallowed as a partial. The card keeps both.
  cohort_same_night: async (b) => {
    const entries = await b.cohortNight();
    const refusals = entries.filter((e) => advisorFacts.isRefusal(e));
    return refusals.length ? refusals : entries;
  },
  cohort_typical: (b) => b.cohortTypical(),
  week_recap: (b) => b.readings(),
  // The why-layer's differencing shape: the venue's own reading on the slow
  // day and what was served against it, next to the street's conditions.
  // Never a cause.
  //
  // IT USED TO HAND OVER BOTH BUILDERS WHOLE, and the template twin printed
  // fourteen lines: seven daily readings, a served estimate, three weather
  // days, the anchors fact, the anchors-we-cannot-watch fact and the events
  // line. Every other template here runs two to four. Worse than the length,
  // most of it was about the wrong day. The weather feed starts at tomorrow
  // (see tonight_outlook), so a question about a slow day LAST week came back
  // carrying next weekend's forecast, and six of the seven readings were the
  // days that were not slow.
  //
  // So the plan SELECTS rather than dumps, and selecting is all it does: no
  // number is computed here, because arithmetic belongs in the fact engine and
  // not in a route plan (see last_night_verdict). The lowest reading is the
  // slow day by definition, it travels with a note saying which end of the
  // window it came from exactly as quiet_nights' facts do, and the street
  // facts are held to that same day by the filter tonight_outlook already
  // uses: undated street context is about the street itself and stays, dated
  // context for some other day goes.
  slow_night: async (b) => {
    const entries = await b.readings();
    const readings = entries.filter((e) => !advisorFacts.isRefusal(e) && e.id.startsWith('owner_reading_')
      && e.value && Number.isFinite(Number(e.value.peakReading)));
    if (!readings.length) return entries;
    const slowest = readings.reduce((lo, e) => (
      Number(e.value.peakReading) < Number(lo.value.peakReading) ? e : lo
    ));
    const date = entryDate(slowest);
    // Copied rather than mutated: the builders are memoised per request and
    // the same reading fact is served to other plans in the same breath.
    const slowDay = {
      ...slowest,
      note: [
        slowest.note,
        `This is the LOWEST of the ${readings.length} days you posted a reading on in this window. It is the slow day the question is about.`,
      ].filter(Boolean).join(' '),
    };
    const sameDay = entries.filter((e) => e !== slowest && entryDate(e) === date);
    const street = (await b.around()).filter((e) => {
      const d = entryDate(e);
      return d === null || d === date;
    });
    return [slowDay, ...sameDay, ...street];
  },
  // Days where a reading and a served estimate can actually be set side by
  // side; when none pair up, everything serves and the refusals speak.
  readings_vs_estimates: async (b) => {
    const entries = await b.readings();
    const facts = entries.filter((e) => !advisorFacts.isRefusal(e));
    const readingDates = new Set(facts.filter((e) => e.id.startsWith('owner_reading_')).map(entryDate));
    const servedDates = new Set(facts.filter((e) => e.id.startsWith('served_')).map(entryDate));
    const paired = [...readingDates].filter((d) => servedDates.has(d));
    // NO PAIRED DAY MEANS NO COMPARISON EXISTS, and returning the readings on
    // their own let the answer read like one. A live answer to "how do my
    // readings compare to what you showed people" came back as a list of six
    // readings and never mentioned that the other side of the comparison was
    // absent, which is a half answer wearing a whole answer's clothes. The
    // honest output is a refusal that names which half is missing, and the
    // unlock path is the readings themselves, which is what pairs the days.
    if (!paired.length) {
      return [advisorFacts.makeRefusal({
        id: 'refuse_readings_vs_estimates',
        reason: readingDates.size
          ? 'We have your own readings, but not one of those days is a day Flock also served a score for your venue, so there is nothing to hold them against.'
          : 'This needs both sides: your own readings for a day, and what Flock served people who looked you up that same day. We have neither yet.',
        whatWouldUnlock: 'Post a reading on a day people are looking your venue up in Flock. The comparison fills in the first time both land on the same day.',
      })];
    }
    return facts.filter((e) => paired.includes(entryDate(e)));
  },
  kitchen_vs_peak: async (b) => (await b.listing()).filter((e) => /kitchen/.test(e.id)),
  capacity_math: async (b) => (await b.listing()).filter((e) => /capacity/.test(e.id)),
  busy_nights_check: async (b) => (await b.listing()).filter((e) => /busy_/.test(e.id)),
  around_you: (b) => b.around(),
  // The corpus explainer: the gate refusal IS the honest answer for the modal
  // case, and it already names the unlock path. In the corpus, the profile's
  // own corpus columns are the fact.
  data_status: async (b) => {
    const gate = advisorFacts.corpusGate(b.ctx.profile);
    if (gate) return [gate];
    const p = b.ctx.profile;
    const rows = p.corpus_baseline_rows != null ? Number(p.corpus_baseline_rows) : null;
    const checked = p.corpus_checked_at ? String(p.corpus_checked_at).slice(0, 10) : null;
    return [advisorFacts.makeFact({
      id: 'corpus_status',
      // `status` is a column value ('baselines'), and it used to be substituted
      // into prose as one: "your Google profile's pattern is recorded as
      // baselines". advisorPhrasing's enum vocabulary now renders it, and the
      // key is named so the date part renders as a date too.
      value: { status: p.corpus_status, baselineRows: rows, checkedAt: checked },
      source: 'google_baseline',
      asOf: checked || advisorFacts.CORPUS_AS_OF,
      label: rows != null
        ? `This venue is in our measured corpus with ${rows} baseline rows${checked ? `, last checked ${checked}` : ''}. Model backed answers are on. Your own slider readings add history the corpus cannot.`
        : 'This venue is in our measured corpus, so model backed answers are on. Your own slider readings add history the corpus cannot.',
    })];
  },
};

async function bridgeFactBlock(userId, intentId) {
  const ctx = await advisorFacts.getVenueContext(userId);
  if (!ctx || !ctx.profile.google_place_id) {
    return {
      intent: intentId,
      facts: [],
      refusals: [`${FEATURE_NAME} reads facts about your venue and does not know which venue is yours yet. Link your Google listing in Edit Profile and this fills in.`],
    };
  }
  if (!ctx.profile.verified) {
    return { intent: intentId, facts: [], refusals: [UNVERIFIED_REASON] };
  }

  const opts = { now: new Date(), userId };
  const memo = {};
  const b = {
    ctx,
    week: () => (memo.week = memo.week || advisorFacts.buildWeekAhead(ctx, opts)),
    around: () => (memo.around = memo.around || advisorFacts.buildAroundYou(ctx, opts)),
    readings: () => (memo.readings = memo.readings || advisorFacts.buildReadingsVsServed(ctx, opts)),
    listing: () => (memo.listing = memo.listing
      || Promise.resolve(b.week()).then((week) => advisorFacts.buildListingReadBack(ctx, week, opts))),
    verdict: () => (memo.verdict = memo.verdict
      || (lastNightVerdict
        ? lastNightVerdict.buildLastDayVerdict(ctx, opts)
        : Promise.resolve([]))),
    cohortNight: () => (memo.cohortNight = memo.cohortNight || advisorFacts.buildCohortSameNight(ctx, opts)),
    cohortTypical: () => (memo.cohortTypical = memo.cohortTypical || advisorFacts.buildCohortStanding(ctx, opts)),
  };

  const plan = INTENT_PLANS[intentId];
  const entries = plan ? await plan(b) : [];

  const facts = entries.filter((e) => !advisorFacts.isRefusal(e));
  const refusals = entries.filter((e) => advisorFacts.isRefusal(e)).map(refusalText);
  return { intent: intentId, facts, refusals: facts.length > 0 ? [] : refusals };
}

function factEngine() {
  if (router.__factsOverride) return router.__factsOverride;
  if (!advisorFacts) return null;
  if (typeof advisorFacts.buildFactBlock === 'function') return advisorFacts.buildFactBlock;
  if (typeof advisorFacts.getVenueContext === 'function') return bridgeFactBlock;
  return null;
}

// ─── GET /cards — the four T0 insight cards ─────────────────────────────────
//
// Deterministic composition over services/advisorFacts.js. Every fact carries
// {id, value, source, asOf}; refusals are data with a path; the modal case (a
// venue absent from the corpus) renders as refusal cards, which are a designed
// screen, not an error. Verified claims only, same soft answer /intelligence
// and /strip use. Pinned by __tests__/advisorCards.test.js.

// Same sentence /intelligence and /strip use for the same condition.
const UNVERIFIED_REASON = 'Verify your venue to unlock this. We check ownership before turning on forecasts.';

// The four MVP cards, in the order the product shape lists them.
//
// THE VERDICT IS CARD ZERO. It leads the stack because "how did we just do" is
// what operators actually open a tool to ask (Toast's own prompt telemetry
// across 125,000+ locations; explicit forecasting was one percent of prompts,
// the least asked category they measured). Every card under it is a forecast
// or a read-back; this one grades a day that already happened, from the
// venue's own numbers, and it is the only card here that works for a venue our
// corpus has never seen.
const CARDS = [
  { id: 'last_night_verdict', title: 'Yesterday, against your own numbers', tier: 'pro' },
  { id: 'week_ahead', title: 'Week ahead', tier: 'pro' },
  { id: 'around_you', title: 'Around you this week', tier: 'premium' },
  { id: 'listing_read_back', title: 'Your listing, read back', tier: 'pro' },
  { id: 'readings_vs_estimates', title: 'What you said vs what we estimated', tier: 'pro' },
  // The cohort card. Every other card on this list compares the venue to
  // itself or to a forecast; this one is the only place Flock holds something
  // no operator can get anywhere else, which is somebody else's numbers. It
  // carries both halves at once because that is how the question is actually
  // asked: the street's readings for the day (or the refusal that names the
  // floor of five reporting venues), then where the venue's own typical sits
  // in its city and category. services/advisorCohort.js holds the floors and
  // the differencing analysis.
  { id: 'cohort', title: 'You and venues like you', tier: 'pro' },
];

// premium covers premium+pro; pro covers pro only. The rank arithmetic lives
// in services/venueEntitlements.js; this only needs the two named cases.
function tierCovers(tier, required) {
  return required === 'premium' ? (tier === 'premium' || tier === 'pro') : tier === 'pro';
}

function finishedCard(def, facts) {
  return {
    id: def.id,
    title: def.title,
    facts,
    // 'ok' when at least one real fact rendered; 'refused' when the card is
    // all refusals — the MODAL case for a venue outside the corpus.
    status: facts.some((f) => !advisorFacts.isRefusal(f)) ? 'ok' : 'refused',
  };
}

function lockedCard(def) {
  return {
    id: def.id,
    title: def.title,
    facts: [],
    status: 'locked',
    // The same vocabulary the 403 contract uses, so the client's existing
    // UPGRADE_REQUIRED handling renders this without new plumbing.
    requiredTier: def.tier,
    code: 'UPGRADE_REQUIRED',
  };
}

router.get('/cards', authenticate, requirePremium, async (req, res) => {
  try {
    if (!advisorFacts || typeof advisorFacts.getVenueContext !== 'function') {
      return res.status(503).json({ error: `${FEATURE_NAME} is not connected to its data yet. Check back soon.` });
    }
    const userId = req.user.id;
    const ctx = await advisorFacts.getVenueContext(userId);
    if (!ctx || !ctx.profile.google_place_id) {
      return res.json({ available: false, reason: `Link your Google listing in Edit Profile to see your ${FEATURE_NAME} cards`, cards: [] });
    }
    if (!ctx.profile.verified) {
      return res.json({ available: false, unverified: true, reason: UNVERIFIED_REASON, cards: [] });
    }

    // With billing off everyone acts pro, mirroring requireVenueTier itself.
    const tier = venueBillingEnabled() ? await getVenueTier(userId) : 'pro';
    const now = new Date();
    const opts = { now, userId };

    const [verdictDef, weekDef, aroundDef, listingDef, readingsDef, cohortDef] = CARDS;

    // Card 1 is built first because card 3's arithmetic reads its peak facts.
    const weekFacts = tierCovers(tier, weekDef.tier)
      ? await advisorFacts.buildWeekAhead(ctx, opts)
      : null;

    const cards = [];
    if (lastNightVerdict) {
      cards.push(tierCovers(tier, verdictDef.tier)
        ? finishedCard(verdictDef, await lastNightVerdict.buildLastDayVerdict(ctx, opts))
        : lockedCard(verdictDef));
    }
    cards.push(weekFacts ? finishedCard(weekDef, weekFacts) : lockedCard(weekDef));
    cards.push(tierCovers(tier, aroundDef.tier)
      ? finishedCard(aroundDef, await advisorFacts.buildAroundYou(ctx, opts))
      : lockedCard(aroundDef));
    cards.push(tierCovers(tier, listingDef.tier)
      ? finishedCard(listingDef, await advisorFacts.buildListingReadBack(ctx, weekFacts || [], opts))
      : lockedCard(listingDef));
    cards.push(tierCovers(tier, readingsDef.tier)
      ? finishedCard(readingsDef, await advisorFacts.buildReadingsVsServed(ctx, opts))
      : lockedCard(readingsDef));
    // Both halves on one card, same-night first. A card keeps its refusals
    // inline, which is exactly what the density half needs: the floor refusal
    // is the growth loop and it has to be readable next to the half that
    // already answers.
    if (typeof advisorFacts.buildCohortSameNight === 'function') {
      cards.push(tierCovers(tier, cohortDef.tier)
        ? finishedCard(cohortDef, [
          ...await advisorFacts.buildCohortSameNight(ctx, opts),
          ...await advisorFacts.buildCohortStanding(ctx, opts),
        ])
        : lockedCard(cohortDef));
    }

    return res.json({ available: true, cards, generatedAt: now.toISOString() });
  } catch (err) {
    console.error('Advisor cards error:', err);
    return res.status(500).json({ error: 'Failed to build advisor cards' });
  }
});

// ─── Which chips this venue actually gets offered ───────────────────────────
//
// The registry has thirteen questions. A venue should not be shown thirteen
// buttons, and it should certainly not be shown nine that decline.
//
// TWO SEPARATE PROBLEMS, fixed together.
//
// 1. HOW MANY. Roost's chips are whole sentences at thirty to fifty characters,
//    so a phone fits three or four before the list becomes a wall. `lead` is
//    the four the venue sees; the rest stay grouped behind a disclosure. The
//    order comes from advisorPhrasing.CHIP_PRIORITY, which leads with today's
//    outlook and puts events and weather last despite them being the prettiest
//    card, because the questions owners actually ask are about their own room.
//
// 2. WHICH ONES. corpusGate already knows, before anything is built, that a
//    venue outside the measured corpus cannot be given a forecast, and the
//    readings questions already know they have nothing to say for a venue that
//    has not posted a reading. Offering those chips anyway is a menu of dead
//    buttons, which SLOP-AUDIT rule 5 bans in every other surface in this repo.
//    So availability is computed DETERMINISTICALLY from the profile plus one
//    cheap EXISTS pair, not by building every card: a chip is offered when the
//    data behind it exists.
//
// Three chips are always offered and all three earn it. `around_you` needs no
// corpus and no history. `data_status` answers with the corpus gate's own
// refusal, which for the modal venue IS the honest answer to what data we hold.
// `last_night_verdict` is the third and the deliberate one: it is the only chip
// whose refusal names an action the owner can take in one tap, and hiding it
// from venues with no readings would hide the argument for posting one. It is
// also uncorpused by construction, so it is the one forecast-free answer a
// venue outside our corpus can ever get.
const ALWAYS_AVAILABLE = new Set(['around_you', 'data_status', 'last_night_verdict']);
// `cohort_typical` is a corpus question: it places the venue's own Google curve
// inside the frozen distribution of its city and category, so without a curve
// there is nothing to place.
const NEEDS_CORPUS = new Set(['tonight_outlook', 'peak_hours', 'weekend_outlook', 'quiet_nights', 'cohort_typical']);
// `cohort_same_night` is a history question for a reason that is about honesty
// rather than plumbing: "was it just us" needs a your-side, and a venue that
// has posted nothing has no side. Offered to venues that have their own
// readings, it always has one, and when the street is too thin to publish it
// answers with the refusal that names the floor. That refusal is not a dead
// button; it is the only sentence in the product that asks for the thing which
// makes the product work.
const NEEDS_HISTORY = new Set(['week_recap', 'slow_night', 'readings_vs_estimates', 'cohort_same_night']);
// The listing read-back questions need the corpus AND the intake field each one
// reads. An owner who never filled in a kitchen time is not shown a chip about
// their kitchen time.
const NEEDS_CORPUS_AND_INTAKE = {
  kitchen_vs_peak: 'kitchen_last_order',
  capacity_math: 'capacity',
  busy_nights_check: 'owner_busy_nights',
};

function intakeFilled(profile, column) {
  const v = profile ? profile[column] : null;
  if (v === null || v === undefined || v === '') return false;
  return !Array.isArray(v) || v.length > 0;
}

async function hasRecentHistory(placeId) {
  if (!placeId) return false;
  try {
    const { rows } = await pool.query(
      // `source = 'detail'` for migration 038's reason, which this half of the
      // check was missing (money audit round 4). POST /api/crowd/batch writes
      // served_predictions rows for a caller-named place id from caller-supplied
      // scoring inputs, so without the allowlist any authenticated account could
      // keep another venue's history chips lit up, and keep them lit after the
      // venue itself had gone quiet. Every other reader of this table already
      // takes 'detail' only. Allowlist rather than `<> 'batch'`: the pre-038
      // rows carry NULL, and NULL <> 'batch' is NULL, never true.
      `SELECT EXISTS (SELECT 1 FROM venue_owner_reports
                       WHERE google_place_id = $1 AND retracted = false
                         AND created_at >= NOW() - INTERVAL '7 days') AS readings,
              EXISTS (SELECT 1 FROM served_predictions
                       WHERE venue_place_id = $1
                         AND source = 'detail'
                         AND served_at >= NOW() - INTERVAL '7 days') AS served`,
      [placeId]
    );
    return !!(rows[0] && (rows[0].readings || rows[0].served));
  } catch (err) {
    // A chip list that cannot check offers the history questions rather than
    // hiding them: the fact engine refuses honestly on its own, so the failure
    // mode of a broken check should be a chip that declines, never a venue that
    // silently loses questions it is entitled to.
    console.error('Advisor question availability check failed:', err.message);
    return true;
  }
}

async function availableIntents(ctx) {
  const profile = ctx ? ctx.profile : null;
  const inCorpus = !!profile && advisorFacts.corpusGate(profile) === null;
  const history = await hasRecentHistory(profile && profile.google_place_id);
  return advisorPhrasing.CHIP_PRIORITY.filter((id) => {
    if (!advisorPhrasing.isKnownIntent(id)) return false;
    if (ALWAYS_AVAILABLE.has(id)) return true;
    if (NEEDS_CORPUS.has(id)) return inCorpus;
    if (NEEDS_HISTORY.has(id)) return history;
    const column = NEEDS_CORPUS_AND_INTAKE[id];
    if (column) return inCorpus && intakeFilled(profile, column);
    // An intent nobody has classified yet is OFFERED, not hidden. Hiding by
    // omission is the worse failure: a chip that declines wastes a tap and says
    // what is missing, but a chip that silently disappears because a new intent
    // landed in the registry before it landed in the table above is a feature
    // the owner never learns exists. The cohort pair (cohort_same_night,
    // cohort_typical) is the current unclassified set; classify it here in the
    // change that wires its fact builders.
    return true;
  });
}

// The number of chips shown before the disclosure. Four, because the chips are
// sentences and a phone that shows five shows a wall.
const LEAD_CHIP_COUNT = 4;

// The chips, plus the free-text field's own availability. Pro-gated like the
// rest of the surface so the question list cannot advertise a feature the
// caller's plan does not serve. `name` is the product name, served so a rename
// is one backend line; `freeText` is served the same way, so the client renders
// the input only when the server will actually answer it.
router.get('/questions', authenticate, requirePro, async (req, res) => {
  try {
    const chip = (id) => ({ id, label: advisorPhrasing.ADVISOR_INTENTS[id].chip });
    let offered = advisorPhrasing.CHIP_PRIORITY.filter((id) => advisorPhrasing.isKnownIntent(id));

    if (advisorFacts && typeof advisorFacts.getVenueContext === 'function') {
      const ctx = await advisorFacts.getVenueContext(req.user.id);
      if (ctx && ctx.profile && ctx.profile.google_place_id && ctx.profile.verified) {
        offered = await availableIntents(ctx);
      }
    }

    const lead = offered.slice(0, LEAD_CHIP_COUNT);
    const rest = new Set(offered.slice(LEAD_CHIP_COUNT));
    const groups = advisorPhrasing.ADVISOR_GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      questions: advisorPhrasing.CHIP_PRIORITY
        .filter((id) => rest.has(id) && advisorPhrasing.ADVISOR_INTENTS[id].group === g.id)
        .map(chip),
    })).filter((g) => g.questions.length > 0);

    return res.json({
      name: advisorPhrasing.ADVISOR_NAME,
      freeText: advisorFreeText.freeTextAvailable(),
      lead: lead.map(chip),
      groups,
    });
  } catch (err) {
    console.error('Advisor questions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// One chip in, one answer out.
const FREE_TEXT_REFUSAL = `${FEATURE_NAME} takes the suggested questions only. Pick one of the question chips.`;
const UNKNOWN_INTENT = `That question isn't one ${FEATURE_NAME} can take. Pick one of the question chips.`;

router.post('/ask', authenticate, requirePro, [
  body('intentId').isString().withMessage(UNKNOWN_INTENT),
], async (req, res) => {
  try {
    // Free text is rejected by SHAPE, before validation and before anything
    // reads a value: the only key this endpoint has ever heard of is
    // intentId. This is Layer A with the parsing removed — no field exists
    // for user language to arrive in.
    const keys = Object.keys(req.body || {});
    if (keys.some((k) => k !== 'intentId')) {
      return res.status(400).json({ error: FREE_TEXT_REFUSAL });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { intentId } = req.body;
    if (!advisorPhrasing.isKnownIntent(intentId)) {
      return res.status(400).json({ error: UNKNOWN_INTENT });
    }

    const buildFactBlock = factEngine();
    if (!buildFactBlock) {
      return res.status(503).json({ error: `${FEATURE_NAME} is not connected to its data yet. Check back soon.` });
    }

    const block = await buildFactBlock(req.user.id, intentId);
    const answer = await advisorPhrasing.phrase(block, { venueUserId: req.user.id });

    return res.json({
      intentId,
      mode: answer.mode, // 'refusal' | 'template' | 'phrased'
      text: answer.text,
      sources: answer.sources,
    });
  } catch (err) {
    console.error('Advisor ask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /question — one typed question, one of three answers ──────────────
//
// SEPARATE FROM /ask ON PURPOSE. /ask keeps its shape refusal: one intentId
// key, prose answered 400 before a value is read. That is not legacy, it is the
// chip path's guarantee, and a chip answer should not become reachable by
// typing into the endpoint that promises it cannot be. Free text gets its own
// door, its own rate limiter (server.js), its own daily ceiling (migration
// 039), and its own flag.
//
// The three modes leave here labeled, because the whole design is that an owner
// always knows which one they are reading:
//   mode 'phrased' | 'template' | 'refusal'  a grounded answer, exactly what
//                                            the matching chip would have said
//   mode 'advice'                            general trade knowledge, marked
//   mode 'refusal'                           declined, with the reason
const FREETEXT_OFF = advisorFreeText.UNAVAILABLE_TEXT;

router.post('/question', authenticate, requirePro, async (req, res) => {
  try {
    // Same shape refusal /ask uses: one key, and a non-string is rejected
    // before anything reads it.
    const keys = Object.keys(req.body || {});
    if (keys.length !== 1 || keys[0] !== 'question') {
      return res.status(400).json({ error: 'Send one question, as text.' });
    }

    const clean = advisorFreeText.sanitizeQuestion(req.body.question);
    if (!clean.ok) return res.status(400).json({ error: clean.error });

    // The flag is checked AFTER the shape so a malformed body still gets the
    // honest 400, and BEFORE any spend so a dark feature costs nothing. Free
    // text needs the model: with it off there is no template that answers a
    // question nobody wrote a template for, so this declines in plain words
    // rather than half working.
    if (!advisorFreeText.freeTextAvailable()) {
      return res.json({ mode: 'refusal', text: FREETEXT_OFF, sources: [], question: clean.text });
    }

    const buildFactBlock = factEngine();
    if (!buildFactBlock) {
      return res.status(503).json({ error: `${FEATURE_NAME} is not connected to its data yet. Check back soon.` });
    }

    const userId = req.user.id;

    // ── IS THE CALLER A VENUE AT ALL ────────────────────────────────────────
    //
    // requirePro DOES NOT ANSWER THAT, and cannot, in the posture this product
    // actually deploys in. services/venueEntitlements.js returns next() outright
    // while VENUE_BILLING_ENABLED is unset, which it is on Railway and which is
    // the correct pilot posture -- every CLAIMED venue sees the advisor without
    // anyone selling them a tier first. What that leaves is a gate that reads
    // as an authorisation check at every call site and is a pass-through at
    // runtime, and this is the one route where the difference is money: the
    // very next line is a Gemini call, and the advice branch below is a second
    // one, both charged to a ledger whose unit of identity is an account.
    //
    // Signup is free and unlimited. Measured on the preview stack: an ordinary
    // consumer account with no venue_profiles row and no subscription got a
    // real two-call advice answer, and moved the GLOBAL advisor_spend row. At
    // roughly six and a half thousand tokens a question and twenty questions an
    // account, sixteen throwaway accounts drain the two million token global
    // wall and put every real venue on template answers for the rest of the
    // day, on our invoice.
    //
    // So the spend gets the check the tier gate is not making. Not a TIER check
    // -- that stays exactly as dormant as it is meant to be -- just the floor
    // underneath it: this endpoint is for a venue, and a caller with no venue
    // profile is not one. The chip path does not need this; a venue-less
    // account gets a fact block with nothing in it and advisorPhrasing renders
    // the refusal before it charges anything (advisorPhrasing.js, phrase()).
    // Free text has no such shape: the router is asked to classify the question
    // before anything has looked at whose venue it is about.
    //
    // Hoisted rather than duplicated: the advice branch below needs this same
    // context and used to fetch it again after both calls were already spent.
    // getVenueContext answers null for BOTH "no such venue" and "this build has
    // no fact engine", so the two are told apart here rather than conflated:
    // only a build that can look is allowed to conclude anything from not
    // finding one.
    const canReadVenue = !!advisorFacts && typeof advisorFacts.getVenueContext === 'function';
    const ctx = canReadVenue ? await advisorFacts.getVenueContext(userId) : null;
    if (canReadVenue && !(ctx && ctx.profile)) {
      return res.json({
        mode: 'refusal',
        text: `${FEATURE_NAME} answers questions about a venue you have claimed. Claim your venue first and every answer here comes from its own numbers.`,
        sources: [],
        question: clean.text,
      });
    }

    const route = await advisorFreeText.classify({ userId, question: clean.text });

    if (route.mode === 'refused') {
      return res.json({ mode: 'refusal', text: route.refusal, sources: [], question: clean.text });
    }

    // GROUNDED: the existing pipeline, unchanged. Free text is another way in,
    // never a second way to answer.
    if (route.mode === 'grounded') {
      const block = await buildFactBlock(userId, route.intentId);
      const answer = await advisorPhrasing.phrase(block, { venueUserId: userId });
      return res.json({
        mode: answer.mode,
        intentId: route.intentId,
        text: answer.text,
        sources: answer.sources,
        question: clean.text,
      });
    }

    // ADVICE: general knowledge, labeled, with the digit valve still closed
    // around anything about this venue. The router may attach an intent when
    // the venue's own numbers would inform the answer; those facts ride along
    // as placeholders, and a refusal in the block is simply dropped, because
    // advice does not need the venue's data to be answerable. `ctx` is the one
    // fetched above, before the router was paid for, rather than a second
    // lookup after both calls have already been spent.
    let groundedFacts = [];
    if (route.intentId) {
      const block = await buildFactBlock(userId, route.intentId);
      groundedFacts = Array.isArray(block.facts) ? block.facts : [];
    }
    const answer = await advisorFreeText.advise({ userId, question: clean.text, ctx, groundedFacts });
    return res.json({
      mode: answer.mode,
      intentId: route.intentId || null,
      text: answer.text,
      sources: answer.sources,
      question: clean.text,
    });
  } catch (err) {
    console.error('Advisor question error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Tests only: inject a fact engine without a services/advisorFacts.js on disk.
router.__setFactsForTests = (fn) => {
  router.__factsOverride = fn;
};

module.exports = router;
// The route plans, for tests. A plan is a pure function from the memoised
// builder to the entries one chip answers with, and the two that SELECT rather
// than pass through (quiet_nights refusing a level week, slow_night picking the
// slow day) are the ones worth driving directly: reaching them through the
// endpoint would mean standing up a whole database fixture to test a sort.
module.exports.__INTENT_PLANS = INTENT_PLANS;
