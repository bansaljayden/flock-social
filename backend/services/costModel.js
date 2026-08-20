// ---------------------------------------------------------------------------
// WHAT FLOCK COSTS. One rate card, three kinds of number, and a hard wall
// between them.
// ---------------------------------------------------------------------------
//
// THE THREE KINDS OF NUMBER, AND WHY THE DISTINCTION IS THE WHOLE POINT.
//
//   1. BILLED       — money that has actually left an account. Only a human can
//                     know this, because only a human reads the invoice. It
//                     lives in RECONCILED below, hand-maintained, dated.
//   2. OBSERVED     — what this system's own meters counted, priced at the rate
//                     card. Real usage, real arithmetic, but it is an ESTIMATE
//                     of a bill and not the bill. Built by buildObserved(),
//                     which is handed COUNTS and nothing else.
//   3. WORST CASE   — what the month would cost if every ceiling in the repo
//                     were hit every day. Built by buildWorstCase(), which is
//                     handed NO counts at all.
//
// A ceiling is not a bill. That confusion has already cost this project a bad
// afternoon, and the structural defence against repeating it is that the two
// builders below take disjoint inputs: buildObserved() cannot see a limit
// because no limit is passed to it, and buildWorstCase() cannot see a meter
// because no meter is passed to it. Neither can borrow the other's number by
// accident. __tests__/costModel.test.js pins that property directly.
//
// WHY A CONSTANTS BLOCK AND NOT A LOOKUP. Every rate here is a published price
// that a vendor changes without telling us. There is no API to read them from,
// so the honest shape is a table a person edits, with the date it was last
// checked sitting beside every line. A rate with a stale `checked` date is not
// wrong, it is unverified, and the dashboard says so rather than pretending.
//
// RECONCILING WITH THE REPO'S OWN RECORDED RATES. Three files already wrote a
// price down, and all three were re-checked on 2026-08-20 rather than
// overridden:
//   * services/birdieUsage.js says gemini-3.5-flash-lite is $0.30 in and $2.50
//     out. CONFIRMED, unchanged.
//   * utils/visionBudget.js says SafeSearch is $1.50 per 1,000. CONFIRMED,
//     unchanged. VISION_UNIT_PRICE_USD stays the single source for that leg and
//     is imported here rather than copied.
//   * frontend/src/App.js's Projections tab carried the fixed-cost array by
//     hand (Railway $20, Claude Max $125, Codex $20, Apple $99/yr, BestTime
//     $1,500 once). Those are Jayden's real bills, so they are carried over
//     verbatim into FIXED_MONTHLY / ANNUAL / ONE_TIME and the frontend now
//     reads them from here instead of holding a second copy.
//
// ONE CORRECTION THIS FILE MAKES, AND IT IS EXPENSIVE. Every venue-shaped
// Places call in this repo — ten of them, across routes/venueSearch.js,
// routes/ai.js, routes/crowd.js, routes/badge.js, routes/publicCrowd.js and
// routes/venueDashboard.js, not the two originally noted — requests `rating`,
// `userRatingCount`, `priceLevel` and `currentOpeningHours`. Google bills a
// Places (New) request at the tier of the most expensive field in the mask, and
// all four of those are ENTERPRISE fields, not Pro. So Text Search bills at $35
// per 1,000 rather than the Pro $32, Place Details at $20 rather than $17, and
// the free monthly allowance for each is 1,000 calls rather than 5,000.
//
// WHERE THE MONEY ACTUALLY IS, because the rate delta is the small half. Pro
// saves $3 per 1,000 on either SKU — 9% of Text Search, 15% of Place Details.
// The free allowance is the big half and it is a step, not a slope: below 1,000
// calls a month both tiers cost $0, and above 5,000 both tiers charge for
// everything past their cap, so the tier only really decides the bill BETWEEN
// those two numbers. At exactly 5,000 Text Searches a month Enterprise costs
// $140 and Pro costs nothing. That band is ahead of Flock, not behind it.
//
// AND IT IS STILL NOT AVAILABLE, which is the correction to the correction.
// Three of the four are TRAINED MODEL COLUMNS. services/mlPredictor.js
// buildFeatureMap emits `rating`, `price_level`, `review_count` and
// `log_review_count` from exactly these Google fields, and it fills a missing
// one with the corpus median instead of failing — so striking them from a mask
// does not break a screen, it silently scores every venue as a 4.0-star,
// mid-priced, zero-review venue and keeps answering. That is train/serve skew.
// routes/badge.js (round 10) and routes/venueDashboard.js (round 20) each shipped
// a version of this and each was found as a product bug. `currentOpeningHours`
// is not a model input but drives the closed-hours zeroing, `isOpen` and the
// hours list, and dropping it alone moves neither SKU while the other three stay.
// __tests__/placesFieldMaskModelInputs.test.js now pins all ten masks so this
// cannot be re-proposed as a billing change; it is a retrain.
//
// THE SAVING THAT IS REAL AND IS NOT A TIER CHANGE: opening one venue's detail
// screen makes TWO paid Enterprise Place Details calls for the same place id.
// frontend/src/App.js openVenueDetail fires getVenueDetails and
// getCrowdPrediction in one Promise.allSettled; the first is
// routes/venueSearch.js runPlaceDetails and the second is routes/crowd.js
// fetchVenueFromGoogle, and the second mask is a strict subset of the first.
// They cache separately (5 min on place id; 10 min on place id + hour, so it
// misses on every hour boundary) and charge the shared ledger twice. Collapsing
// them onto one cached raw Places response halves the Place Details SKU — 50%
// against the 15% the tier question was worth — and touches no field mask, so
// it carries none of the model risk above. Not done here: it spans two route
// files and one of them is the model's serving path.
// ---------------------------------------------------------------------------

const { VISION_UNIT_PRICE_USD } = require('../utils/visionBudget');

// Average days in a month, used everywhere a per-day figure is annualised to a
// month. 365.25/12. One constant so the monthly numbers on the dashboard all
// agree with each other.
const DAYS_PER_MONTH = 30.4375;

// ---------------------------------------------------------------------------
// THE RATE CARD
// ---------------------------------------------------------------------------
// Every entry carries `checked` (the date a human last read the vendor's own
// pricing page) and `source` (that page). Update both together or not at all:
// a rate moved without its date is a rate nobody can audit.

const RATES = {
  // Gemini. Priced per MILLION tokens, input and output separately. Thinking
  // tokens bill at the OUTPUT rate on all of these.
  //
  // gemini-3.7-flash is on promotional pricing that DOUBLES on 2027-01-01.
  // Roost's whole variable cost is this model, so that date is a real event for
  // this business and both rate cards are carried rather than only today's.
  gemini: {
    checked: '2026-08-20',
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    models: {
      'gemini-3.7-flash': {
        inputPerMTok: 0.75,
        outputPerMTok: 3.75,
        // Same model, list price, from 2027-01-01.
        laterInputPerMTok: 1.50,
        laterOutputPerMTok: 7.50,
        laterFrom: '2027-01-01',
        freeTier: true,
      },
      'gemini-3.5-flash-lite': {
        inputPerMTok: 0.30,
        outputPerMTok: 2.50,
        freeTier: true,
      },
      'gemini-2.5-flash-lite': {
        inputPerMTok: 0.10,
        outputPerMTok: 0.40,
        freeTier: true,
      },
    },
  },

  // Google Places (New). Per 1,000 requests, with a per-SKU monthly free cap.
  // The tier names are Google's and they are decided by the FIELD MASK, not by
  // the endpoint. See the correction in the header.
  places: {
    checked: '2026-08-20',
    source: 'https://developers.google.com/maps/billing-and-pricing/sku-details',
    skus: {
      textSearchEnterprise: { label: 'Text Search (Enterprise fields)', perThousand: 35.00, freePerMonth: 1000 },
      detailsEnterprise: { label: 'Place Details (Enterprise fields)', perThousand: 20.00, freePerMonth: 1000 },
      // Nearby Search is its OWN SKU with its own free allowance, not a Text
      // Search. routes/venueDashboard.js calls places:searchNearby for the
      // owner's competitor set. It is carried here so the surface is on the
      // record; it does not widen the band the panel quotes below, because
      // Nearby and Text Search price identically at $35 and Place Details is
      // still the cheapest of the three.
      nearbySearchEnterprise: { label: 'Nearby Search (Enterprise fields)', perThousand: 35.00, freePerMonth: 1000 },
      photos: { label: 'Place Details Photos', perThousand: 7.00, freePerMonth: 1000 },
      // Carried for the comparison the correction above describes: what the
      // same two calls would cost if the four Enterprise fields were dropped.
      textSearchPro: { label: 'Text Search (Pro fields)', perThousand: 32.00, freePerMonth: 5000 },
      detailsPro: { label: 'Place Details (Pro fields)', perThousand: 17.00, freePerMonth: 5000 },
    },
  },

  // Cloud Vision SafeSearch. The per-unit price is NOT restated here: it is
  // imported from utils/visionBudget.js, which already owns it and already
  // prints it in its own log lines. Two copies of a price is how they drift.
  vision: {
    checked: '2026-08-20',
    source: 'https://cloud.google.com/vision/pricing',
    perThousand: VISION_UNIT_PRICE_USD * 1000,
    freePerMonth: 1000,
  },

  // OpenWeatherMap. services/weatherService.js calls data/2.5/weather and
  // data/2.5/forecast, which are free-plan endpoints: 60 calls a minute and
  // 1,000,000 calls a month at no charge. WX_DAILY is 950, so even a maxed day
  // every day of the month lands around 29,000 calls, three percent of the free
  // allowance. This is $0 and stays $0 until the call volume grows by a factor
  // of thirty.
  weather: {
    checked: '2026-08-20',
    source: 'https://openweathermap.org/price',
    freePerMonth: 1000000,
    freePerMinute: 60,
    perCallOverFree: null, // Not applicable to the endpoints this repo calls.
  },

  // Ticketmaster Discovery. Free public tier, 5,000 calls a day. The repo's two
  // ledgers (routes/events.js at 2,000/day and services/nightContext.js at
  // 200/day) were deliberately sized to stay under it, and 2,200 does.
  ticketmaster: {
    checked: '2026-08-20',
    source: 'https://developer.ticketmaster.com/products-and-docs/apis/getting-started/',
    freePerDay: 5000,
    perCallOverFree: null,
  },

  // Resend. Free tier is 3,000 emails a month and 100 a day. The Monday venue
  // digest is one email per venue per week, so the daily cap is the binding one
  // and it is not close to binding.
  resend: {
    checked: '2026-08-20',
    source: 'https://resend.com/pricing',
    freePerMonth: 3000,
    freePerDay: 100,
    nextTierUsd: 20.00,
    nextTierIncluded: 50000,
  },

  // MapTiler. The frontend's map styles. Metered in SESSIONS (one map load),
  // not tiles.
  maptiler: {
    checked: '2026-08-20',
    source: 'https://www.maptiler.com/cloud/pricing/',
    freeSessionsPerMonth: 5000,
    freeApiRequestsPerMonth: 100000,
    nextTierUsd: 30.00,
  },

  // PostHog. Product analytics events.
  posthog: {
    checked: '2026-08-20',
    source: 'https://posthog.com/pricing',
    freeEventsPerMonth: 1000000,
    perEventOverFree: 0.00005,
  },

  // Sentry. SENTRY_DSN is unset on the Railway service, so nothing is being
  // sent and the free tier is not even being consumed.
  sentry: {
    checked: '2026-08-20',
    source: 'https://sentry.io/pricing/',
    freeErrorsPerMonth: 5000,
    nextTierUsd: 26.00,
    nextTierNote: 'Team, billed annually. The monthly-billing price is higher and was not confirmed.',
  },

  // RevenueCat. Free under $2,500 monthly tracked revenue, then 1% of it. The
  // paywall has never been switched on, so tracked revenue is $0.
  revenuecat: {
    checked: '2026-08-20',
    source: 'https://www.revenuecat.com/pricing/',
    freeMonthlyTrackedRevenueUsd: 2500,
    percentOverFree: 1.0,
  },

  // Push. Both legs are free and neither publishes a per-message price. FCM is
  // listed as no-cost on both Firebase plans; APNs is included with the Apple
  // Developer Program. The APNs line is a conclusion from an ABSENCE of any
  // published price, which is weaker evidence than a quoted zero.
  push: {
    checked: '2026-08-20',
    source: 'https://firebase.google.com/pricing',
    fcmUsd: 0,
    apnsUsd: 0,
    apnsNote: 'Free by absence of any published price, not by a quoted figure.',
  },

  // Store commissions. Not a cost today (nothing is purchasable) but the number
  // that decides what a subscription is actually worth when it is.
  stores: {
    checked: '2026-08-20',
    source: 'https://developer.apple.com/app-store/small-business-program/',
    appleStandardPct: 30,
    appleSmallBusinessPct: 15,
    appleAfterYearOnePct: 15,
  },
};

// ---------------------------------------------------------------------------
// FIXED COSTS — the bills that arrive whether anybody uses the app or not.
// ---------------------------------------------------------------------------
// UPDATE THESE WHEN A BILL CHANGES, and move `checked` when you do. `verified`
// means a human has seen this exact number on an invoice or a dashboard, not
// merely on the vendor's public pricing page. An unverified line is still
// counted in the total, and the total says how many of its lines are unverified
// rather than hiding them.

const FIXED_MONTHLY = [
  {
    id: 'railway',
    label: 'Railway (backend and Postgres)',
    usd: 20.00,
    verified: true,
    checked: '2026-08-20',
    source: 'https://railway.com/pricing',
    note: 'Matches Railway Pro at $20/month, which includes $20 of usage credits. Compute and volume draw down that credit before anything is billed on top.',
  },
  {
    id: 'claude-max',
    label: 'Claude Max',
    usd: 125.00,
    verified: true,
    checked: '2026-08-20',
    source: null,
    note: 'Development tooling, not app infrastructure. It is a real recurring bill so it is counted, but no user causes it.',
  },
  {
    id: 'codex',
    label: 'Codex',
    usd: 20.00,
    verified: true,
    checked: '2026-08-20',
    source: null,
    note: 'Development tooling, same as above.',
  },
  {
    id: 'vercel',
    label: 'Vercel (web hosting)',
    usd: 0,
    verified: false,
    checked: '2026-08-20',
    source: 'https://vercel.com/pricing',
    note: 'Assumed Hobby, which is free. Pro is $20/month per seat. Confirm against the Vercel billing page before quoting this to anyone.',
  },
];

const FIXED_ANNUAL = [
  {
    id: 'apple-developer',
    label: 'Apple Developer Program',
    usd: 99.00,
    verified: true,
    checked: '2026-08-20',
    source: 'https://developer.apple.com/support/enrollment/',
    note: 'Also covers APNs, which has no separate price.',
  },
  {
    id: 'domain',
    label: 'flockcorp.com',
    usd: 12.00,
    verified: false,
    checked: '2026-08-20',
    source: 'https://porkbun.com/products/domains',
    note: 'Published .com renewal prices run about $11 to $16 a year. $12 is a placeholder inside that band. Replace it with the registrar invoice figure and set verified.',
  },
];

const ONE_TIME = [
  {
    id: 'besttime-corpus',
    label: 'BestTime training data (the model corpus)',
    usd: 1500.00,
    verified: true,
    checked: '2026-08-20',
    source: null,
    note: 'Spent, finished, and not recurring. The key is dead and the corpus is frozen, so this line can never grow.',
  },
];

// ---------------------------------------------------------------------------
// WATCHLIST — costs that are not on the bill today and could be tomorrow.
// ---------------------------------------------------------------------------
// A cost inventory that lists only what is currently charged is the one that
// gets surprised. These are the live exposures found by a full sweep of the
// repo on 2026-08-20: none of them appears on an invoice right now, each of
// them could. `usd` is null wherever no number can be defended, and a null
// stays null rather than becoming a plausible guess.
const WATCHLIST = [
  {
    id: 'maptiler-satellite',
    label: 'MapTiler map sessions (basemap + satellite)',
    where: 'frontend/src/App.js, every Discover map load',
    usd: null,
    severity: 'watch',
    note: 'Free plan is 5,000 map sessions and 100,000 API requests a month; the next tier up is Flex at $30/month, and Flex overages bill automatically. This became the ONLY satellite source on 2026-08-20, when the unkeyed Esri ArcGIS World_Imagery fallback was removed from the satellite style. That fallback was a licence exposure rather than a bill — Esri basemaps are not free for commercial use and Flock has no Esri account — and it was already dead in every shipping build, because Vercel and Codemagic both set REACT_APP_MAPTILER_KEY and the MapTiler branch won whenever it was present. It was removed because the repo is public: a contributor cloning Flock without a key and tapping the satellite toggle was making unlicensed Esri requests from their own address. With no key the toggle is now hidden rather than falling back.',
  },
  {
    id: 'carto-basemaps',
    label: 'CARTO basemap tiles',
    where: 'frontend/src/App.js, the light and dark styles, used whenever REACT_APP_MAPTILER_KEY is unset',
    usd: null,
    severity: 'watch',
    note: 'Free with attribution and unkeyed, so there is no account to bill. It is the fallback path, which means a missing MapTiler key silently moves the map onto somebody else free tier.',
  },
  {
    id: 'besttime-subscription',
    label: 'BestTime.app subscription',
    where: 'backend/scripts/ml/, offline collection scripts only',
    usd: null,
    severity: 'cancel',
    note: 'No server code path calls it and no scheduler runs the scripts, so it generates no usage. If a plan is still active on the account it is being paid for nothing. Check the vendor dashboard and cancel.',
  },
  {
    id: 'codemagic',
    label: 'Codemagic iOS builds',
    where: 'codemagic.yaml, the ios-capacitor workflow on a mac_mini_m2',
    usd: null,
    severity: 'usage',
    note: 'No trigger block, so it runs only when a build is started by hand. Cost is per build rather than per month, and a build takes on the order of twenty minutes on a premium-billed instance.',
  },
  {
    id: 'github-actions',
    label: 'GitHub Actions (gitleaks)',
    where: '.github/workflows/gitleaks.yml, on every push and pull request',
    usd: 0,
    severity: 'watch',
    note: 'A short ubuntu-latest job. Free on public repositories and inside the free monthly minutes on private ones.',
  },
  {
    id: 'seatgeek',
    label: 'SeatGeek API',
    where: 'backend/scripts/ml/eventService.js, offline scripts only',
    usd: 0,
    severity: 'watch',
    note: 'A key is held but no server code reads it. Free tier in practice.',
  },
  {
    id: 'dicebear',
    label: 'DiceBear avatars',
    where: 'frontend/src/App.js, default avatar images',
    usd: 0,
    severity: 'watch',
    note: 'Free hosted tier, unkeyed.',
  },
  {
    id: 'postgres-images',
    label: 'Postgres row growth from images',
    where: 'users.profile_image_url, messages.image_url, stories.image_url',
    usd: null,
    severity: 'growth',
    note: 'Uploads are stored in the database as base64 data URLs rather than on a volume, at up to 600 KB per message image. Railway bills volume at about $0.22 per GB per month, so this is cheap per gigabyte and grows with message volume rather than with user count. It is the first line that will move if the app gets real traffic.',
  },
];

// ---------------------------------------------------------------------------
// RECONCILED — what a human has actually seen on a bill.
// ---------------------------------------------------------------------------
// This is the ONLY billed-money figure in the file. Everything else on the
// dashboard is either an estimate from a meter or an arithmetic ceiling. Update
// `asOf` and the numbers together, from the vendor's billing page, by hand.
const RECONCILED = {
  asOf: '2026-08-20',
  lines: [
    {
      id: 'google-cloud',
      label: 'Google Cloud (Places, Vision, Gemini on one bill)',
      usdPerMonth: 9.00,
      note: 'Essentially all of it is Place Details Photos. Gemini has billed $0 to date on both callers.',
    },
  ],
  note: 'Read off the vendor billing pages by hand. Nothing in the app can verify this, so it is only as current as the date beside it.',
};

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

function finite(n) {
  return Number.isFinite(n) ? n : 0;
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(finite(n) * f) / f;
}

/**
 * Price a mixed token count.
 *
 * The ledgers in this repo record ONE number per call (usageMetadata's
 * totalTokenCount), so pricing it needs a split between input and output. That
 * split is passed in rather than assumed here, and every caller below derives
 * its share from something structural (a maxOutputTokens the code actually
 * sets, or the range services/birdieUsage.js documents for itself) rather than
 * inventing one.
 *
 * @param {number} tokens      total tokens, mixed
 * @param {number} outputShare fraction of them that are output, 0 to 1
 * @param {{inputPerMTok:number,outputPerMTok:number}} rate
 */
function priceTokens(tokens, outputShare, rate) {
  const total = Math.max(0, finite(tokens));
  const share = Math.min(1, Math.max(0, finite(outputShare)));
  const out = total * share;
  const inp = total - out;
  return (inp * finite(rate.inputPerMTok) + out * finite(rate.outputPerMTok)) / 1e6;
}

/** Price N calls of a per-1,000 SKU, ignoring the free allowance. */
function priceCalls(calls, perThousand) {
  return (Math.max(0, finite(calls)) * finite(perThousand)) / 1000;
}

/**
 * Price N calls of a per-1,000 SKU with its monthly free allowance applied.
 * `alreadyUsed` is how much of the free allowance this month is already gone.
 */
function priceCallsAfterFree(calls, perThousand, freePerMonth, alreadyUsed = 0) {
  const used = Math.max(0, finite(alreadyUsed));
  const freeLeft = Math.max(0, finite(freePerMonth) - used);
  const billable = Math.max(0, Math.max(0, finite(calls)) - freeLeft);
  return priceCalls(billable, perThousand);
}

/**
 * The Gemini rate for a model id, at a given date.
 * Unknown model ids return null rather than a guessed price: BIRDIE_MODEL and
 * ADVISOR_MODEL are raw env vars that can be set to anything from the Railway
 * dashboard, and a model this file has never heard of must read as "we cannot
 * price this", never as free.
 */
function geminiRate(modelId, onDate) {
  const m = Object.prototype.hasOwnProperty.call(RATES.gemini.models, modelId)
    ? RATES.gemini.models[modelId]
    : null;
  if (!m) return null;
  const day = typeof onDate === 'string' ? onDate : new Date().toISOString().slice(0, 10);
  if (m.laterFrom && day >= m.laterFrom) {
    return {
      inputPerMTok: m.laterInputPerMTok,
      outputPerMTok: m.laterOutputPerMTok,
      promotional: false,
      note: `List price, in effect since ${m.laterFrom}.`,
    };
  }
  if (m.laterFrom) {
    return {
      inputPerMTok: m.inputPerMTok,
      outputPerMTok: m.outputPerMTok,
      promotional: true,
      changesOn: m.laterFrom,
      laterInputPerMTok: m.laterInputPerMTok,
      laterOutputPerMTok: m.laterOutputPerMTok,
      note: `Promotional. Doubles on ${m.laterFrom}.`,
    };
  }
  return {
    inputPerMTok: m.inputPerMTok,
    outputPerMTok: m.outputPerMTok,
    promotional: false,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// OUTPUT SHARES — derived, not guessed.
// ---------------------------------------------------------------------------
// Roost's shares come straight out of the code: every advisor call passes a
// maxOutputTokens, and the system prompt length is fixed and readable, so the
// worst-case output fraction of one call is maxOutput / (promptTokens +
// maxOutput). The caller passes those two numbers in.
//
// Birdie has no maxOutputTokens anywhere, so no structural share exists.
// services/birdieUsage.js states the measured range for itself ("output is
// roughly 5-10% of the total") and this file uses the EXPENSIVE end of that
// range, because an estimate of a bill should not flatter itself.
const BIRDIE_OUTPUT_SHARE = 0.10;
const BIRDIE_OUTPUT_SHARE_LOW = 0.05;

function outputShareOf(promptTokens, maxOutputTokens) {
  const p = Math.max(0, finite(promptTokens));
  const o = Math.max(0, finite(maxOutputTokens));
  if (p + o === 0) return 0;
  return o / (p + o);
}

// ---------------------------------------------------------------------------
// OBSERVED — priced from counts, and ONLY from counts.
// ---------------------------------------------------------------------------

/**
 * Price what the meters actually counted.
 *
 * EVERY ARGUMENT IS A COUNT. Not a status object, not a limits block, not a
 * remaining figure. That is the wall described in the header: this function is
 * structurally incapable of rendering a ceiling as spend, because no ceiling is
 * in scope. Do not "helpfully" widen this signature to take a meter status
 * object; __tests__/costModel.test.js will fail you, and it should.
 *
 * A count this function was not given reads as `null` (unmeasured), never as 0.
 * Zero means the meter ran and counted nothing. Null means nobody counted.
 *
 * @param {object} counts
 * @param {number} counts.birdieTokensToday      birdieUsage geminiSpendStatus().globalUsed
 * @param {string} counts.birdieModel            BIRDIE_MODEL in force
 * @param {number} counts.advisorTokensToday     advisor_spend row for today
 * @param {number} counts.advisorTokensMonth     advisor_spend summed over this month
 * @param {string} counts.advisorModel           ADVISOR_MODEL in force
 * @param {number} counts.advisorPromptTokens    the phrasing system prompt, in tokens
 * @param {number} counts.advisorMaxOutputTokens the phrasing maxOutputTokens
 * @param {number} counts.placesCallsToday       placesBudgetStatus().globalUsed
 * @param {number} counts.placesPhotoCallsToday  the photo proxy's own day counter
 * @param {number} counts.visionCallsToday       visionBudgetStatus().globalUsed
 * @param {number} counts.weatherCallsToday      weatherBudgetStatus().dailyUsed
 * @param {number} counts.ticketmasterCallsToday routes/events.js day ledger
 * @param {number} counts.nightContextCallsToday nightContext's own day ledger
 * @param {number} counts.digestEmailsMonth      venue_digest_sends rows this month
 * @param {string} [counts.onDate]               YYYY-MM-DD, for rate selection
 */
function buildObserved(counts = {}) {
  const c = counts || {};
  const onDate = typeof c.onDate === 'string' ? c.onDate : new Date().toISOString().slice(0, 10);
  const num = (v) => (Number.isFinite(v) ? Math.max(0, v) : null);

  const lines = [];

  // ── Birdie (consumer Gemini) ──────────────────────────────────────────────
  {
    const tokens = num(c.birdieTokensToday);
    const rate = geminiRate(c.birdieModel, onDate);
    lines.push({
      id: 'gemini-birdie',
      label: `Birdie on ${c.birdieModel || 'an unset model'}`,
      unit: 'tokens today',
      count: tokens,
      // A model we cannot price reads as unpriced, not as free.
      usd: tokens === null || !rate ? null : round(priceTokens(tokens, BIRDIE_OUTPUT_SHARE, rate), 4),
      usdLow: tokens === null || !rate ? null : round(priceTokens(tokens, BIRDIE_OUTPUT_SHARE_LOW, rate), 4),
      window: 'today, this process only',
      durable: false,
      unpriceable: !rate,
      note: rate
        ? 'Counted in this container\'s memory, so it resets on every deploy and does not add up across restarts.'
        : 'No published rate on file for this model id, so the tokens cannot be priced.',
    });
  }

  // ── Roost (venue Gemini) ──────────────────────────────────────────────────
  {
    const rate = geminiRate(c.advisorModel, onDate);
    const share = outputShareOf(c.advisorPromptTokens, c.advisorMaxOutputTokens);
    const today = num(c.advisorTokensToday);
    const month = num(c.advisorTokensMonth);
    lines.push({
      id: 'gemini-roost-today',
      label: `Roost on ${c.advisorModel || 'an unset model'}, today`,
      unit: 'tokens today',
      count: today,
      usd: today === null || !rate ? null : round(priceTokens(today, share, rate), 4),
      window: 'today',
      durable: true,
      unpriceable: !rate,
      note: rate ? 'From the advisor_spend table, so it survives deploys.' : 'No published rate on file for this model id.',
    });
    lines.push({
      id: 'gemini-roost-month',
      label: `Roost on ${c.advisorModel || 'an unset model'}, month to date`,
      unit: 'tokens this month',
      count: month,
      usd: month === null || !rate ? null : round(priceTokens(month, share, rate), 4),
      window: 'month to date',
      durable: true,
      unpriceable: !rate,
      note: rate ? 'From the advisor_spend table.' : 'No published rate on file for this model id.',
    });
  }

  // ── Google Places ─────────────────────────────────────────────────────────
  // The shared ledger counts CALLS and does not record which SKU each one was,
  // so the non-photo remainder is priced as a BAND between the two SKUs it
  // could have been rather than as a single number nobody can defend.
  {
    const total = num(c.placesCallsToday);
    const photos = num(c.placesPhotoCallsToday);
    const other = total === null ? null : Math.max(0, total - (photos || 0));
    const sk = RATES.places.skus;
    lines.push({
      id: 'places-photos',
      label: 'Place Details Photos',
      unit: 'calls today',
      count: photos,
      usd: photos === null ? null : round(priceCalls(photos, sk.photos.perThousand), 4),
      window: 'today, this process only',
      durable: false,
      note: 'Before the 1,000 free photo requests a month. Historically this is where nearly the whole Google bill goes.',
    });
    lines.push({
      id: 'places-other',
      label: 'Text Search and Place Details',
      unit: 'calls today',
      count: other,
      // A band, low to high, because the meter did not record the SKU.
      usd: other === null ? null : round(priceCalls(other, sk.detailsEnterprise.perThousand), 4),
      usdHigh: other === null ? null : round(priceCalls(other, sk.textSearchEnterprise.perThousand), 4),
      window: 'today, this process only',
      durable: false,
      note: 'The shared Places ledger counts calls without recording the SKU, so this is a band: everything priced as Place Details at the low end, everything as Text Search at the high end.',
    });
  }

  // ── Cloud Vision ──────────────────────────────────────────────────────────
  {
    const calls = num(c.visionCallsToday);
    lines.push({
      id: 'vision',
      label: 'Cloud Vision SafeSearch',
      unit: 'images today',
      count: calls,
      usd: calls === null ? null : round(priceCalls(calls, RATES.vision.perThousand), 4),
      window: 'today, this process only',
      durable: false,
      note: 'Before the 1,000 free units a month.',
    });
  }

  // ── Free-tier upstreams ───────────────────────────────────────────────────
  // These are counted because a meter reading nothing is worth seeing, and
  // priced at zero because the volume is inside a published free allowance.
  // The number that matters on each line is the headroom, not the money.
  {
    const wx = num(c.weatherCallsToday);
    lines.push({
      id: 'weather',
      label: 'OpenWeatherMap',
      unit: 'calls today',
      count: wx,
      usd: wx === null ? null : 0,
      window: 'today, this process only',
      durable: false,
      freeTier: true,
      note: 'Free plan covers 1,000,000 calls a month. A maxed day every day of the month is about 29,000.',
    });

    const tmDay = num(c.ticketmasterCallsToday);
    const ncDay = num(c.nightContextCallsToday);
    const tm = tmDay === null && ncDay === null ? null : (tmDay || 0) + (ncDay || 0);
    lines.push({
      id: 'ticketmaster',
      label: 'Ticketmaster Discovery',
      unit: 'calls today',
      count: tm,
      usd: tm === null ? null : 0,
      window: 'today, this process only',
      durable: false,
      freeTier: true,
      note: 'Free public tier, 5,000 calls a day. Both ledgers together are capped at 2,200.',
    });

    const emails = num(c.digestEmailsMonth);
    lines.push({
      id: 'resend',
      label: 'Resend (venue digest)',
      unit: 'sends this month',
      count: emails,
      usd: emails === null ? null : 0,
      window: 'month to date',
      durable: true,
      freeTier: true,
      note: 'Free tier is 3,000 a month and 100 a day. Counted from venue_digest_sends, so transactional mail (verification, password reset) is not in this number.',
    });
  }

  const priced = lines.filter((l) => Number.isFinite(l.usd));
  const todayLines = priced.filter((l) => l.window !== 'month to date');
  const totalTodayLow = todayLines.reduce((s, l) => s + l.usd, 0);
  const totalTodayHigh = todayLines.reduce((s, l) => s + (Number.isFinite(l.usdHigh) ? l.usdHigh : l.usd), 0);

  return {
    kind: 'observed',
    onDate,
    lines,
    todayUsd: round(totalTodayLow, 4),
    todayUsdHigh: round(totalTodayHigh, 4),
    // How much of the picture is missing, said out loud rather than absorbed
    // into a total that looks complete.
    unmeasuredLines: lines.filter((l) => l.count === null).map((l) => l.id),
    unpriceableLines: lines.filter((l) => l.unpriceable).map((l) => l.id),
  };
}

// ---------------------------------------------------------------------------
// WORST CASE — from ceilings, and ONLY from ceilings.
// ---------------------------------------------------------------------------

/**
 * What a month would cost if every ceiling in the repo were hit every single
 * day. THIS IS NOT A BILL AND MUST NEVER BE PRESENTED AS ONE. It is the answer
 * to "how bad could this get before something stops it", which is the only
 * question a ceiling exists to answer.
 *
 * Every argument is a LIMIT. No meter reading is in scope, by design.
 *
 * @param {object} limits
 * @param {number} limits.birdieGlobalDailyTokens
 * @param {string} limits.birdieModel
 * @param {number} limits.advisorGlobalDailyTokens
 * @param {number} limits.advisorPerVenueDailyTokens
 * @param {string} limits.advisorModel
 * @param {number} limits.advisorPromptTokens
 * @param {number} limits.advisorMaxOutputTokens
 * @param {number} limits.placesGlobalDaily
 * @param {number} limits.visionGlobalDaily
 * @param {number} limits.weatherDaily
 * @param {number} limits.ticketmasterGlobalDaily
 * @param {string} [limits.onDate]
 */
function buildWorstCase(limits = {}) {
  const l = limits || {};
  const onDate = typeof l.onDate === 'string' ? l.onDate : new Date().toISOString().slice(0, 10);
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const monthly = (perDay) => (perDay === null ? null : round(perDay * DAYS_PER_MONTH, 2));

  const lines = [];

  {
    const cap = num(l.birdieGlobalDailyTokens);
    const rate = geminiRate(l.birdieModel, onDate);
    const perDay = cap === null || !rate ? null : priceTokens(cap, BIRDIE_OUTPUT_SHARE, rate);
    const perDayLow = cap === null || !rate ? null : priceTokens(cap, BIRDIE_OUTPUT_SHARE_LOW, rate);
    lines.push({
      id: 'gemini-birdie',
      label: `Birdie global token ceiling on ${l.birdieModel || 'an unset model'}`,
      ceiling: cap,
      ceilingUnit: 'tokens per day, process wide',
      perDayUsd: perDay === null ? null : round(perDay, 2),
      perMonthUsd: monthly(perDay),
      perMonthUsdLow: monthly(perDayLow),
      note: 'In-process, so a day with ten deploys hands out ten fresh allowances. It is a brake, not a cap.',
    });
  }

  {
    const cap = num(l.advisorGlobalDailyTokens);
    const rate = geminiRate(l.advisorModel, onDate);
    const share = outputShareOf(l.advisorPromptTokens, l.advisorMaxOutputTokens);
    const perDay = cap === null || !rate ? null : priceTokens(cap, share, rate);
    lines.push({
      id: 'gemini-roost',
      label: `Roost global token ceiling on ${l.advisorModel || 'an unset model'}`,
      ceiling: cap,
      ceilingUnit: 'tokens per day, all venues',
      perDayUsd: perDay === null ? null : round(perDay, 2),
      perMonthUsd: monthly(perDay),
      note: 'Postgres backed (migration 035), so this one survives deploys and replicas and really is a cap.',
    });
  }

  {
    const cap = num(l.placesGlobalDaily);
    const sk = RATES.places.skus;
    const lo = cap === null ? null : priceCalls(cap, sk.photos.perThousand);
    const hi = cap === null ? null : priceCalls(cap, sk.textSearchEnterprise.perThousand);
    lines.push({
      id: 'places',
      label: 'Google Places global call ceiling',
      ceiling: cap,
      ceilingUnit: 'calls per day, process wide',
      perDayUsd: lo === null ? null : round(lo, 2),
      perDayUsdHigh: hi === null ? null : round(hi, 2),
      perMonthUsd: monthly(lo),
      perMonthUsdHigh: monthly(hi),
      note: 'A band, because the ledger does not record the SKU. Low is every call a photo at $7 per 1,000, high is every call a Text Search at $35 per 1,000.',
    });
  }

  {
    const cap = num(l.visionGlobalDaily);
    const perDay = cap === null ? null : priceCalls(cap, RATES.vision.perThousand);
    lines.push({
      id: 'vision',
      label: 'Cloud Vision global call ceiling',
      ceiling: cap,
      ceilingUnit: 'images per day, process wide',
      perDayUsd: perDay === null ? null : round(perDay, 2),
      perMonthUsd: monthly(perDay),
      note: null,
    });
  }

  {
    lines.push({
      id: 'weather',
      label: 'OpenWeatherMap daily ceiling',
      ceiling: num(l.weatherDaily),
      ceilingUnit: 'calls per day',
      perDayUsd: 0,
      perMonthUsd: 0,
      note: 'Zero at any value this ceiling can take. The free plan covers 1,000,000 calls a month and this ceiling caps the month at about 29,000.',
    });
    lines.push({
      id: 'ticketmaster',
      label: 'Ticketmaster daily ceiling',
      ceiling: num(l.ticketmasterGlobalDaily),
      ceilingUnit: 'calls per day',
      perDayUsd: 0,
      perMonthUsd: 0,
      note: 'Zero. The free public tier is 5,000 calls a day.',
    });
  }

  const priced = lines.filter((x) => Number.isFinite(x.perMonthUsd));
  return {
    kind: 'worstCase',
    onDate,
    lines,
    perMonthUsd: round(priced.reduce((s, x) => s + x.perMonthUsd, 0), 2),
    perMonthUsdHigh: round(
      priced.reduce((s, x) => s + (Number.isFinite(x.perMonthUsdHigh) ? x.perMonthUsdHigh : x.perMonthUsd), 0),
      2
    ),
    disclaimer: 'Every figure here is what a ceiling permits, not what anything has spent. Nothing has ever reached one of these.',
  };
}

// ---------------------------------------------------------------------------
// FIXED COSTS
// ---------------------------------------------------------------------------

function buildFixed() {
  const monthly = FIXED_MONTHLY.reduce((s, e) => s + e.usd, 0);
  const annual = FIXED_ANNUAL.reduce((s, e) => s + e.usd, 0);
  const oneTime = ONE_TIME.reduce((s, e) => s + e.usd, 0);
  const unverified = [...FIXED_MONTHLY, ...FIXED_ANNUAL].filter((e) => !e.verified).map((e) => e.id);
  return {
    kind: 'fixed',
    monthly: FIXED_MONTHLY,
    annual: FIXED_ANNUAL,
    oneTime: ONE_TIME,
    monthlyUsd: round(monthly),
    annualUsd: round(annual),
    oneTimeUsd: round(oneTime),
    // What leaves the account every month once the annual bills are spread.
    effectiveMonthlyUsd: round(monthly + annual / 12),
    unverifiedLines: unverified,
  };
}

// ---------------------------------------------------------------------------
// PER-VENUE UNIT ECONOMICS
// ---------------------------------------------------------------------------

/**
 * What one paying venue costs to serve, and what that leaves at the sale price.
 *
 * THE CEILING THAT ACTUALLY BINDS. Roost has three per-venue meters, all three
 * charged against the same row, and they do not bind in the order the product
 * copy implies. The daily token cap is smaller than what 50 phrased answers
 * would cost on their own: a phrased answer carries the whole phrasing system
 * prompt, so only about a sixth of the 50 the answer cap permits will fit
 * inside the token cap. The money ceiling for one venue is therefore the TOKEN
 * cap, and the token cap is what is priced here. Pricing the 50-answer cap
 * instead would overstate a venue by roughly three times.
 *
 * The exact per-call sizes are deliberately not written down in this comment.
 * They are the system prompt lengths and the maxOutputTokens values in
 * services/advisorPrompt.js, services/advisorPhrasing.js and
 * services/advisorFreeText.js, all of which move when a prompt is edited, and a
 * number copied here would be stale the first time one of them changed. The
 * caller passes them in and this function recomputes.
 *
 * @param {object} args
 * @param {number} args.priceUsd            what a venue pays per month
 * @param {number} args.perVenueDailyTokens the per-venue daily token cap
 * @param {string} args.advisorModel
 * @param {number} args.advisorPromptTokens        the phrasing system prompt
 * @param {number} args.advisorMaxOutputTokens     the phrasing maxOutputTokens
 * @param {number} [args.advisorAdvicePromptTokens]    the advice system prompt
 * @param {number} [args.advisorAdviceMaxOutputTokens] the advice maxOutputTokens
 * @param {number} [args.observedTokensMonth] real tokens one venue spent this
 *        month, from advisor_venue_spend. Null when nothing has been measured.
 * @param {string} [args.onDate]
 */
function buildVenueUnitEconomics(args = {}) {
  const a = args || {};
  const onDate = typeof a.onDate === 'string' ? a.onDate : new Date().toISOString().slice(0, 10);
  const price = Number.isFinite(a.priceUsd) && a.priceUsd > 0 ? a.priceUsd : null;
  const rate = geminiRate(a.advisorModel, onDate);
  const cap = Number.isFinite(a.perVenueDailyTokens) && a.perVenueDailyTokens > 0 ? a.perVenueDailyTokens : null;

  // The output share is not one number here: a chip answer, a classifier pass
  // and an advice answer each set a different maxOutputTokens against a
  // different system prompt, and output bills at five times input. So the band
  // runs from a pure-input floor to the DEAREST call shape the advisor can
  // make, and both ends are derived from constants the code actually passes to
  // the API rather than from a guess about the mix.
  //
  // The dearest shape is the one with the highest output fraction. Today that
  // is the advice answer (a short system prompt against 400 output tokens),
  // not the chip answer (a long system prompt against 512). Pricing the whole
  // cap at the chip's share would understate a venue that only ever types.
  const shareChip = outputShareOf(a.advisorPromptTokens, a.advisorMaxOutputTokens);
  const shareAdvice = outputShareOf(a.advisorAdvicePromptTokens, a.advisorAdviceMaxOutputTokens);
  const shareHigh = Math.max(shareChip, shareAdvice);

  const perMonth = (share) => {
    if (cap === null || !rate) return null;
    return round(priceTokens(cap, share, rate) * DAYS_PER_MONTH, 2);
  };

  // The low end of the band uses a pure-input call (share 0), which is the
  // floor no mix can go below. The high end uses the phrasing call's own share.
  const ceilingMonthlyLow = perMonth(0);
  const ceilingMonthlyHigh = perMonth(shareHigh);

  // Same arithmetic at the post-promotion rate card, because Roost's entire
  // variable cost doubles on that date and a margin that only holds until
  // January is not a margin anyone should plan on.
  const later = geminiRate(a.advisorModel, '2099-01-01');
  const laterCeilingMonthlyHigh =
    cap === null || !later ? null : round(priceTokens(cap, shareHigh, later) * DAYS_PER_MONTH, 2);

  const observedTokens = Number.isFinite(a.observedTokensMonth) && a.observedTokensMonth >= 0
    ? a.observedTokensMonth
    : null;
  const observedMonthlyUsd =
    observedTokens === null || !rate ? null : round(priceTokens(observedTokens, shareHigh, rate), 4);

  const margin = (cost) => {
    if (price === null || cost === null) return null;
    return round(((price - cost) / price) * 100, 1);
  };

  return {
    kind: 'venueUnitEconomics',
    onDate,
    priceUsd: price,
    model: a.advisorModel || null,
    rate: rate || null,
    perVenueDailyTokens: cap,
    // Worst case: this venue hits its own token cap every day of the month.
    ceilingMonthlyUsdLow: ceilingMonthlyLow,
    ceilingMonthlyUsdHigh: ceilingMonthlyHigh,
    ceilingMarginPct: margin(ceilingMonthlyHigh),
    // The same, after the promotional Gemini price ends.
    laterCeilingMonthlyUsd: laterCeilingMonthlyHigh,
    laterCeilingMarginPct: margin(laterCeilingMonthlyHigh),
    laterFrom: rate && rate.changesOn ? rate.changesOn : null,
    // Observed: what a venue has actually spent. Null until one has.
    observedTokensMonth: observedTokens,
    observedMonthlyUsd,
    observedMarginPct: margin(observedMonthlyUsd),
    note:
      'Gemini is the only per-venue cost that scales with use. Weather, Ticketmaster and the Monday digest are inside free tiers at any venue count this reaches, and the Places ledger is shared across the whole product rather than attributable to one venue.',
  };
}

module.exports = {
  RATES,
  FIXED_MONTHLY,
  FIXED_ANNUAL,
  ONE_TIME,
  WATCHLIST,
  RECONCILED,
  DAYS_PER_MONTH,
  BIRDIE_OUTPUT_SHARE,
  BIRDIE_OUTPUT_SHARE_LOW,
  geminiRate,
  outputShareOf,
  priceTokens,
  priceCalls,
  priceCallsAfterFree,
  buildObserved,
  buildWorstCase,
  buildFixed,
  buildVenueUnitEconomics,
};
