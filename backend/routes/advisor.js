// ---------------------------------------------------------------------------
// The venue advisor's HTTP surface. Mounted at /api/venue/advisor (server.js).
//
// Two halves share this file:
//   GET  /cards      Layer B's deterministic insight cards (services/
//                    advisorFacts.js): the four T0 MVP cards from
//                    ADVISOR-PRODUCT-SHAPE.md §5, zero LLM, refusals as data.
//                    Shape: { cards: [{ id, title, facts, status }] }.
//   POST /ask        the chat layer (this file): one suggested-question chip
//                    in, one grounded answer out.
//   GET  /questions  the chip registry, so the client renders exactly the
//                    questions the server will accept.
//
// THE CHAT CONTRACT (ADVISOR-PRODUCT-SHAPE.md section 1, binding):
// suggested questions ONLY. There is no free-text field in this build, so
// this route accepts an intentId from the closed registry and NOTHING else —
// a body carrying prose is answered 400 before anything reads it. User text
// therefore never exists on this surface, which is what makes the one-way
// valve airtight: Layer B computes facts from SQL, Layer C phrases them, and
// no layer ever sees a word the user typed.
//
// GATES, in order: authenticate, then requireVenueTier('pro') (grounding doc
// section 5: Pro is the advisor's home; with VENUE_BILLING_ENABLED unset the
// gate is a no-op and every claimed venue sees it, the correct pilot
// posture). ADVISOR_PHRASING_ENABLED then decides only WORDING: off means the
// deterministic template twin serves, so this surface works with zero LLM
// calls from day one.
//
// NO WRITE PATH, by design and by test. The advisor reads; it cannot post
// promotions, edit the profile, or touch the slider. An advisor that can act
// is a different and unapproved product (grounding doc, section 5).
// ---------------------------------------------------------------------------

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { requireVenueTier, getVenueTier, venueBillingEnabled } = require('../services/venueEntitlements');
const advisorPhrasing = require('../services/advisorPhrasing');

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
  tonight_outlook: async (b) => {
    const week = await b.week();
    const tonight = week.slice(0, 1);
    const date = tonight.length ? entryDate(tonight[0]) : null;
    const street = date ? (await b.around()).filter((e) => entryDate(e) === date) : [];
    return [...tonight, ...street];
  },
  peak_hours: (b) => b.week(),
  weekend_outlook: async (b) => {
    const week = (await b.week()).filter((e) => {
      const d = entryDate(e);
      return d !== null && isWeekendDate(d);
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
  quiet_nights: async (b) => {
    const week = await b.week();
    const scored = week
      .filter((e) => !advisorFacts.isRefusal(e) && e.value && Number.isFinite(Number(e.value.peakScore)))
      .sort((a, z) => Number(a.value.peakScore) - Number(z.value.peakScore));
    return scored.length ? scored.slice(0, 2) : week;
  },
  week_recap: (b) => b.readings(),
  // The why-layer's differencing shape: the venue's own readings and what was
  // served, next to the street's conditions. Never a cause.
  slow_night: async (b) => [...(await b.readings()), ...(await b.around())],
  // Days where a reading and a served estimate can actually be set side by
  // side; when none pair up, everything serves and the refusals speak.
  readings_vs_estimates: async (b) => {
    const entries = await b.readings();
    const facts = entries.filter((e) => !advisorFacts.isRefusal(e));
    const readingDates = new Set(facts.filter((e) => e.id.startsWith('owner_reading_')).map(entryDate));
    const servedDates = new Set(facts.filter((e) => e.id.startsWith('served_')).map(entryDate));
    const paired = [...readingDates].filter((d) => servedDates.has(d));
    if (!paired.length) return entries;
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
const CARDS = [
  { id: 'week_ahead', title: 'Week ahead', tier: 'pro' },
  { id: 'around_you', title: 'Around you this week', tier: 'premium' },
  { id: 'listing_read_back', title: 'Your listing, read back', tier: 'pro' },
  { id: 'readings_vs_estimates', title: 'What you said vs what we estimated', tier: 'pro' },
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

    const [weekDef, aroundDef, listingDef, readingsDef] = CARDS;

    // Card 1 is built first because card 3's arithmetic reads its peak facts.
    const weekFacts = tierCovers(tier, weekDef.tier)
      ? await advisorFacts.buildWeekAhead(ctx, opts)
      : null;

    const cards = [];
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

    return res.json({ available: true, cards, generatedAt: now.toISOString() });
  } catch (err) {
    console.error('Advisor cards error:', err);
    return res.status(500).json({ error: 'Failed to build advisor cards' });
  }
});

// The chips, grouped by theme so the client renders sections. Everything the
// client may ask, which is everything this route will accept. Pro-gated like
// the rest of the surface so the question list cannot advertise a feature the
// caller's plan does not serve. `name` is the product name, served so a
// rename is one backend line.
router.get('/questions', authenticate, requirePro, (req, res) => {
  const groups = advisorPhrasing.ADVISOR_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    questions: Object.keys(advisorPhrasing.ADVISOR_INTENTS)
      .filter((id) => advisorPhrasing.ADVISOR_INTENTS[id].group === g.id)
      .map((id) => ({ id, label: advisorPhrasing.ADVISOR_INTENTS[id].chip })),
  })).filter((g) => g.questions.length > 0);
  res.json({ name: advisorPhrasing.ADVISOR_NAME, groups });
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

// Tests only: inject a fact engine without a services/advisorFacts.js on disk.
router.__setFactsForTests = (fn) => {
  router.__factsOverride = fn;
};

module.exports = router;
