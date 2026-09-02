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
// THE SAVING THAT IS REAL AND IS NOT A TIER CHANGE: TAKEN, in 7348c95
// (2026-08-20). Opening one venue's detail screen used to make TWO paid
// Enterprise Place Details calls for the same place id. frontend/src/App.js
// openVenueDetail fires getVenueDetails and getCrowdPrediction in one
// Promise.allSettled; the first was routes/venueSearch.js runPlaceDetails and
// the second routes/crowd.js fetchVenueFromGoogle, whose mask was a strict
// subset of the first's. They cached separately (5 min on place id; 10 min on
// place id + hour, so the second missed on every hour boundary) and charged the
// shared ledger twice.
//
// Both now read one raw Places response from services/placeDetailsCache.js and
// project the fields they need out of it. NO FIELD MASK CHANGED: the shared
// mask is venueSearch's old DETAILS_FIELD_MASK, the superset, so this carries
// none of the model risk above, which is exactly why it was available when the
// tier change was not. The key dropped the hour, because that hour protects the
// DERIVED PREDICTION (which really does change hour to hour) and never
// protected the Places payload, whose only request-time field is
// currentOpeningHours.openNow. The in-flight coalescing is the load-bearing
// half: the duplicate pair is SIMULTANEOUS, so a cache the leader has not
// filled yet cannot help the follower.
//
// WHAT IT DOES TO THE NUMBERS ON THIS PAGE. One venue-detail open costs ONE
// Place Details call instead of two, so the Place Details half of the
// `places-other` line below is halved at the source. Nothing here needed a
// constant changed, and that is a property worth stating rather than a
// coincidence: buildObserved reads the live ledger
// (placesBudgetStatus().globalUsed) and buildWorstCase reads the live ceiling,
// so both follow the real call volume down on their own. There is no hardcoded
// "calls per venue open" anywhere in this file, and routes/admin.js passes
// meter readings rather than assumptions, so the admin Costs panel needed no
// change either. The band it quotes is the same WIDTH and lower at both bounds.
// Measured on the real routers: two concurrent requests for one place id, one
// upstream call, one ledger unit (__tests__/placeDetailsSharedCache.test.js).
//
// The two were never alternatives, which is worth saying plainly: 50% of the
// calls beats 15% of the rate on the same SKU, and it does it without touching
// a trained column.
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

  // Ticketmaster Discovery. Free public tier, 5,000 calls a day.
  //
  // THERE ARE THREE LEDGERS, NOT TWO. This block said two — routes/events.js at
  // 2,000/day and services/nightContext.js at 200/day — and concluded "2,200
  // does". The third is services/mlPredictor.js EVENT_DAILY_BUDGET at
  // 1,500/day, which is where every crowd prediction's event enrichment is
  // charged: the card, the vote list, the alternatives list, the public demo,
  // the owner dashboard and the advisor all converge on it. It was the only one
  // of the three with no status reader, which is how a file whose whole purpose
  // is to be a complete inventory came to be short a whole ledger.
  //
  // The repo-wide ceiling is therefore 3,700 a day, not 2,200. That is still
  // inside the free tier, so the CONCLUSION survives and the arithmetic behind
  // it did not: 2,200 of 5,000 leaves 2,800 of headroom and 3,700 leaves 1,300,
  // which is the difference between "nowhere near" and "within one more
  // surface of it". A fourth ledger is now a decision rather than an accident.
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
//
// `kind` SPLITS THE BILL INTO THE TWO THINGS PEOPLE ACTUALLY MEAN BY IT.
//
//   'infrastructure' — a bill a user causes. Serving the product needs it, and
//                      it is the number that belongs beside a price when
//                      anybody asks what a customer costs or how many
//                      customers cover the running of this thing.
//   'tooling'        — a bill the DEVELOPER causes. Claude Max and Codex are
//                      real recurring money and they are counted, and no user
//                      has ever caused a dollar of either. They would keep
//                      arriving at zero users and stop arriving the day the
//                      writing stops, which is the opposite of how
//                      infrastructure behaves.
//
// The distinction was already in this file, in prose, in the note on the Claude
// Max line: "Development tooling, not app infrastructure. It is a real
// recurring bill so it is counted, but no user causes it." A sentence cannot
// be added up. Quoting the combined total as the cost of service overstates it
// by the whole tooling line, which is the largest single figure on the monthly
// list, so the split is a field now and the panel shows both figures rather
// than one that is wrong for both questions.

const FIXED_MONTHLY = [
  {
    id: 'railway',
    label: 'Railway (backend and Postgres)',
    usd: 20.00,
    verified: true,
    kind: 'infrastructure',
    checked: '2026-08-20',
    source: 'https://railway.com/pricing',
    note: 'Matches Railway Pro at $20/month, which includes $20 of usage credits. Compute and volume draw down that credit before anything is billed on top.',
  },
  {
    id: 'claude-max',
    label: 'Claude Max',
    usd: 125.00,
    verified: true,
    kind: 'tooling',
    checked: '2026-08-20',
    source: null,
    note: 'Development tooling, not app infrastructure. It is a real recurring bill so it is counted, but no user causes it.',
  },
  {
    id: 'codex',
    label: 'Codex',
    usd: 20.00,
    verified: true,
    kind: 'tooling',
    checked: '2026-08-20',
    source: null,
    note: 'Development tooling, same as above.',
  },
  {
    id: 'besttime-subscription',
    label: 'BestTime.app Pro, Package 100',
    usd: 119.00,
    verified: true,
    kind: 'infrastructure',
    checked: '2026-09-01',
    source: null,
    note: 'Live recurring cost since 2026-09-01, when collection restarted after a 106-day freeze. Package 100 is a fixed allowance rather than metered: by-id, live and query calls are unlimited on venues already admitted, and the monthly cap governs NEW admissions only. Jayden committed to roughly five months, so this line is expected through early 2027 and is cancelled by him, not by a code change. The nightly puller is a Railway cron on the BESTTIME service running scripts/ml/collectRealtime.js at 02:00 UTC.',
  },
  {
    id: 'sportsdb',
    label: 'TheSportsDB Single Developer',
    usd: 9.00,
    verified: true,
    kind: 'infrastructure',
    checked: '2026-09-01',
    source: null,
    note: 'Dedicated key, commercial use permitted. Bought monthly rather than at the $90 annual rate because only a three-month test was committed. Feeds scripts/ml/collectSportsSchedules.js, which is a monthly chore rather than a cron.',
  },
  {
    id: 'vercel',
    label: 'Vercel (web hosting)',
    usd: 0,
    verified: false,
    kind: 'infrastructure',
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
    kind: 'infrastructure',
    checked: '2026-08-20',
    source: 'https://developer.apple.com/support/enrollment/',
    note: 'Also covers APNs, which has no separate price.',
  },
  {
    id: 'domain',
    label: 'flockcorp.com',
    usd: 12.00,
    verified: false,
    kind: 'infrastructure',
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
    kind: 'infrastructure',
    checked: '2026-08-20',
    source: null,
    note: 'The original 2026 corpus purchase, spent and finished. That key did die and this ONE_TIME line genuinely cannot grow, but the sentence that used to end it here, that the corpus is frozen, stopped being true on 2026-09-01: a new key on a $119/month Package 100 subscription restarted nightly collection, and that cost is a FIXED_MONTHLY line rather than an extension of this one.',
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
  asOf: '2026-09-01',
  lines: [
    {
      id: 'google-cloud',
      label: 'Google Cloud (Places, Vision, Gemini on one bill)',
      usdPerMonth: 31.19,
      note: 'Jayden paid $31.19 on 2026-09-01, the first FULL billing cycle anyone has read off an invoice. The $9.00 that stood here from 2026-08-20 was a mid-month snapshot taken on day 20, so it was never a monthly figure and this line should not be read as a 3.5x increase. Essentially all of it is still Place Details Photos, and the size is what the photo budget is configured to allow: PHOTO_BUDGET_USD_PER_YEAR in services/photoStore.js defaults to $300, which is $25.00 a month of paid fetches on top of Google\'s 1,000 free, so a month that spends its photo allowance lands near $25 before Text Search, Place Details and Vision are added. $31.19 sits inside that envelope rather than outside it. Gemini has billed $0 to date on both callers. To lower it, lower the budget: this is a configured ceiling being used, not a leak.',
    },
  ],
  note: 'Read off the vendor billing pages by hand. Nothing in the app can verify this, so it is only as current as the date beside it.',
};

// ---------------------------------------------------------------------------
// GOOGLE QUOTA CAPS. Vendor-side ceilings, set by hand in the Cloud console.
// ---------------------------------------------------------------------------
// Set on 2026-08-20 on the Places API (New) service, alongside a billing budget
// named "Flock API spend cap" that alerts at 50%, 90% and 100% of $33 a month.
//
// These are NOT the same kind of ceiling as the ones in buildWorstCase(). Those
// are limits this repo enforces on itself and can raise with a deploy. These are
// enforced by Google, they refuse the call rather than degrading it, and only a
// human with console access can move them. That makes hitting one a real
// failure mode with a user-visible shape: a venue card with no picture, a
// search that finds nothing, an owner dashboard with no competitors.
//
// The arithmetic below is why the four numbers look arbitrary. Priced at the
// rate card, run every day of an average month, then with each SKU's own 1,000
// free requests a month taken off, the four together land at about $33, which
// is the budget. So the quotas ARE the budget, expressed per day per SKU.
// buildGoogleQuotas() recomputes that rather than restating it, so if a quota
// or a rate is edited the agreement is rechecked instead of going quietly
// stale.
const GOOGLE_QUOTAS = {
  checked: '2026-08-20',
  project: 'project-87561d09-85ef-4d7d-a04',
  console: 'https://console.cloud.google.com/apis/api/places.googleapis.com/quotas',
  budget: {
    name: 'Flock API spend cap',
    usdPerMonth: 33,
    alertsAtPct: [50, 90, 100],
    note: 'A budget alert is a notification, not a switch. It emails at each threshold and stops nothing. The per-day quotas are what actually refuse a call.',
  },
  perDay: [
    { id: 'photos', sku: 'photos', perDay: 152, observedLineId: 'places-photos' },
    { id: 'detailsEnterprise', sku: 'detailsEnterprise', perDay: 38, observedLineId: null },
    { id: 'textSearchEnterprise', sku: 'textSearchEnterprise', perDay: 37, observedLineId: null },
    { id: 'nearbySearchEnterprise', sku: 'nearbySearchEnterprise', perDay: 10, observedLineId: null },
  ],
};

// ---------------------------------------------------------------------------
// THE INVENTORY. Every outside thing Flock depends on, including the free ones.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS SEPARATELY FROM EVERYTHING ABOVE. The blocks above answer
// "what does this cost". They are organised by how far a number can be
// trusted, so a vendor that charges nothing appears in whichever of them
// happens to mention it, and several vendors appeared in none of them at all:
// PostHog, Sentry, RevenueCat, push, Google Sign-In and Sign in with Apple were
// all in the rate card and on no screen. This block answers a different
// question, and it is the one Jayden asked: what do I actually depend on. A
// dependency that costs $0 is still a dependency, still an account somebody can
// lock, still a terms of service, and a zero is a fact worth printing rather
// than a reason to leave a row out.
//
// IT CARRIES NO NUMBERS OF ITS OWN, ON PURPOSE. Every entry is a JOIN KEY, not
// a copy. `pricing` points at RATES, `observedLineId` at a line buildObserved()
// produced, `fixedId` at a line in FIXED_MONTHLY / FIXED_ANNUAL / ONE_TIME,
// `watchlistId` at a WATCHLIST entry. The panel resolves them. So there is
// exactly one copy of every price and every sentence, and this list cannot
// drift from the arithmetic the way a hand-typed expense array does. That has
// already happened once here: frontend/src/App.js held its own vendor array and
// it was five vendors out of date.
//
// `configuredEnv` names the environment variables that switch a dependency on.
// buildDependencies() reports only whether they are PRESENT, never their
// values, which turns "is this even wired up" from an assumption into a reading
// taken from the running process.
//
// A dependency with no meter carries `usageNote` and reads as "not measured".
// It must never read as 0. Those are different facts, and this repo has already
// confused them once: the photo meter lived in memory, read zero after every
// deploy, and under-reported the largest line on the Google bill for as long as
// it did that.
const DEPENDENCIES = [
  // -- Metered. Somebody charges per unit, or would if the volume grew. ------
  {
    id: 'gemini-birdie',
    label: 'Google Gemini, Birdie',
    what: 'The chat assistant in the consumer app.',
    where: 'backend/routes/ai.js',
    group: 'metered',
    pricing: { type: 'gemini', model: 'birdie' },
    configuredEnv: ['GEMINI_API_KEY'],
    observedLineId: 'gemini-birdie',
    usageNote: null,
    note: 'The model id is BIRDIE_MODEL, switchable from Railway without a deploy, so what a token costs can change without any ceiling changing.',
  },
  {
    id: 'gemini-roost',
    label: 'Google Gemini, Roost',
    what: 'The venue advisor: the chips an owner taps and the free-text answers.',
    where: 'backend/services/advisorPhrasing.js and backend/services/advisorFreeText.js',
    group: 'metered',
    pricing: { type: 'gemini', model: 'roost' },
    configuredEnv: ['GEMINI_API_KEY'],
    observedLineId: 'gemini-roost-month',
    usageNote: null,
    note: 'The only per-venue cost that grows with use. Counted in Postgres, so it survives deploys.',
  },
  {
    id: 'places-photos',
    label: 'Google Place Photos',
    what: 'Every venue picture in the app.',
    where: 'backend/services/photoStore.js',
    group: 'metered',
    pricing: { type: 'places', sku: 'photos' },
    configuredEnv: ['GOOGLE_PLACES_API_KEY'],
    observedLineId: 'places-photos-month',
    usageNote: null,
    note: 'Historically almost the whole Google bill. A bought photo is cached for thirty days in Postgres, so this counts venues photographed rather than cards viewed.',
  },
  {
    id: 'places-text-search',
    label: 'Google Places Text Search',
    what: 'Venue search, and every screen that turns a name into a place.',
    where: 'backend/routes/venueSearch.js',
    group: 'metered',
    pricing: { type: 'places', sku: 'textSearchEnterprise' },
    configuredEnv: ['GOOGLE_PLACES_API_KEY'],
    observedLineId: null,
    usageNote: 'The shared Places ledger counts calls without recording which SKU each one was, so this SKU on its own is not measured. The combined non-photo figure is the Text Search and Place Details line in the meter list.',
    note: 'Bills at the Enterprise rate because the field mask asks for rating, review count, price level and opening hours. Three of those four are trained model inputs, so dropping them to reach the cheaper tier is a retrain, not a billing change.',
  },
  {
    id: 'places-details',
    label: 'Google Place Details',
    what: 'The venue detail card and the crowd card, which share one response.',
    where: 'backend/services/placeDetailsCache.js',
    group: 'metered',
    pricing: { type: 'places', sku: 'detailsEnterprise' },
    configuredEnv: ['GOOGLE_PLACES_API_KEY'],
    observedLineId: null,
    usageNote: 'Same shared ledger, same reason. Not measured per SKU.',
    note: 'Opening one venue cost two of these until 2026-08-20. It costs one now.',
  },
  {
    id: 'places-nearby',
    label: 'Google Places Nearby Search',
    what: 'The competitor set on the venue owner dashboard.',
    where: 'backend/routes/venueDashboard.js',
    group: 'metered',
    pricing: { type: 'places', sku: 'nearbySearchEnterprise' },
    configuredEnv: ['GOOGLE_PLACES_API_KEY'],
    observedLineId: null,
    usageNote: 'Same shared ledger, same reason. Not measured per SKU.',
    note: 'Its own SKU with its own free allowance, not a Text Search, though it prices the same.',
  },
  {
    id: 'vision',
    label: 'Google Cloud Vision SafeSearch',
    what: 'Screens every image before it is stored. An upload that cannot be screened is refused.',
    where: 'backend/utils/moderation.js',
    group: 'metered',
    pricing: { type: 'vision' },
    configuredEnv: ['VISION_API_KEY', 'GOOGLE_VISION_API_KEY'],
    observedLineId: 'vision',
    usageNote: null,
    statusKey: 'vision',
    finding: 'Checked on 2026-08-20: the Cloud Vision API was NOT enabled on Google project project-87561d09-85ef-4d7d-a04, the project that holds the Places and Gemini keys. If VISION_API_KEY belongs to that project then every screen has been failing and every image upload has been refused, and the $0 beside this row is the sound of nothing working. The provider reading above is the live answer and beats this note. If it says refusing, enable the Vision API on whichever project the key belongs to.',
    note: 'A safety control before it is a cost. If the Vision API is not enabled on the project the key belongs to, the call fails, the upload is refused, and the bill is $0 because nothing was ever answered. A $0 here can mean "nobody uploaded" or "nothing works", so the panel probes the provider instead of reading the meter.',
  },
  {
    id: 'maptiler',
    label: 'MapTiler',
    what: 'The map on Discover, including the only satellite layer the app has.',
    where: 'frontend/src/App.js',
    group: 'metered',
    pricing: { type: 'unknown', rateGroup: 'maptiler' },
    configuredEnv: null,
    configuredNote: 'REACT_APP_MAPTILER_KEY is a build-time variable set on Vercel and Codemagic, so the backend cannot see whether it is set.',
    observedLineId: null,
    watchlistId: 'maptiler-satellite',
    usageNote: 'Map loads are not counted anywhere in this repo. Nothing here can say how many of the free plan sessions are left.',
    unknownCost: true,
    unknownAction: 'Open the MapTiler dashboard and read the session count. That is the only place the number exists.',
  },
  {
    id: 'carto',
    label: 'CARTO basemaps',
    what: 'The light and dark map tiles, used whenever no MapTiler key is set.',
    where: 'frontend/src/App.js',
    group: 'metered',
    pricing: { type: 'unknown' },
    configuredEnv: null,
    configuredNote: 'Unkeyed. There is no account and nothing to configure.',
    observedLineId: null,
    watchlistId: 'carto-basemaps',
    usageNote: 'Tiles are pulled straight from the browser and counted nowhere.',
    unknownCost: true,
    unknownAction: 'There is no dashboard to read, because there is no account. The exposure here is the attribution terms rather than a bill.',
    source: 'https://carto.com/basemaps',
    checked: '2026-08-20',
  },

  // -- Fixed. The bill arrives whether anybody opens the app or not. ---------
  {
    id: 'railway',
    label: 'Railway',
    what: 'Runs the backend and the Postgres database.',
    where: 'the whole server',
    group: 'fixed',
    fixedId: 'railway',
    configuredEnv: ['DATABASE_URL'],
    observedLineId: null,
    usageNote: 'Compute and storage draw down the $20 of included credit before anything bills on top. This panel cannot see that meter. The Railway usage page can.',
  },
  {
    id: 'postgres-images',
    label: 'Postgres storage for uploaded images',
    what: 'Message, story and profile images are stored as base64 rows rather than as files.',
    where: 'users.profile_image_url, messages.image_url, stories.image_url',
    group: 'fixed',
    watchlistId: 'postgres-images',
    configuredEnv: null,
    observedLineId: null,
    usageNote: 'Nothing counts the bytes. This grows with message volume, not with user count.',
    unknownCost: true,
    unknownAction: 'Read the volume size on the Railway dashboard. It sits inside the Railway line above until it does not.',
  },
  {
    id: 'postgres-wal-archive',
    label: 'Postgres WAL archive',
    what: 'Continuous backup of the database, written by pgBackRest to object storage.',
    where: 'the Railway Postgres service, the WAL_ARCHIVE_ variables',
    group: 'fixed',
    configuredEnv: null,
    configuredNote: 'Set on the Postgres service rather than the app service, so the app cannot read it.',
    observedLineId: null,
    usageNote: 'Nothing in this repo set it up and nothing here can size it.',
    unknownCost: true,
    unknownAction: 'The endpoint comes from the Railway Postgres template, not from anything in this repo, and no separate invoice for it is known. Check the Railway usage page before assuming it is free.',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    what: 'Hosts flockcorp.com and the web build of the app.',
    where: 'the marketing site and the web app',
    group: 'fixed',
    fixedId: 'vercel',
    configuredEnv: null,
    observedLineId: null,
    usageNote: 'Bandwidth and build minutes are not read from here.',
  },
  {
    id: 'claude-max',
    label: 'Claude Max',
    what: 'Development tooling. No user causes this one.',
    where: 'not in the product',
    group: 'fixed',
    fixedId: 'claude-max',
    configuredEnv: null,
    observedLineId: null,
    usageNote: null,
  },
  {
    id: 'codex',
    label: 'Codex',
    what: 'Development tooling, same as above.',
    where: 'not in the product',
    group: 'fixed',
    fixedId: 'codex',
    configuredEnv: null,
    observedLineId: null,
    usageNote: null,
  },
  {
    id: 'apple-developer',
    label: 'Apple Developer Program',
    what: 'The App Store account. Also what makes Sign in with Apple and push work.',
    where: 'the App Store listing',
    group: 'fixed',
    fixedId: 'apple-developer',
    configuredEnv: ['APPLE_TEAM_ID'],
    observedLineId: null,
    usageNote: null,
  },
  {
    id: 'domain',
    label: 'flockcorp.com',
    what: 'The domain, and the email routing on it.',
    where: 'every public URL',
    group: 'fixed',
    fixedId: 'domain',
    configuredEnv: null,
    observedLineId: null,
    usageNote: null,
  },
  {
    id: 'besttime-corpus',
    label: 'BestTime training data',
    what: 'The original corpus the crowd model was trained on. Bought once, spent, finished. Collection since 2026-09-01 runs on a new key and a separate recurring line.',
    where: 'backend/scripts/ml/',
    group: 'fixed',
    fixedId: 'besttime-corpus',
    configuredEnv: null,
    observedLineId: null,
    usageNote: null,
  },
  {
    id: 'sportsdb',
    label: 'TheSportsDB Single Developer',
    what: 'Game schedules for the sports features, five Philadelphia professional teams plus two college football programs.',
    where: 'backend/scripts/ml/collectSportsSchedules.js',
    group: 'fixed',
    fixedId: 'sportsdb',
    configuredEnv: ['SPORTSDB_API_KEY'],
    observedLineId: null,
    usageNote: 'Flat tier, run as a monthly chore rather than a cron, so usage does not move the bill.',
  },

  // -- Free or unused. Every one is $0, and every one says why. --------------
  {
    id: 'weather',
    label: 'OpenWeatherMap',
    what: 'Current conditions and the forecast behind the crowd prediction.',
    where: 'backend/services/weatherService.js',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'weather' },
    configuredEnv: ['WEATHER_API_KEY'],
    observedLineId: 'weather',
    usageNote: null,
    costsNothingBecause: 'Inside the free plan. It covers 1,000,000 calls a month and the repo ceiling caps a fully maxed month near 29,000.',
  },
  {
    id: 'ticketmaster',
    label: 'Ticketmaster Discovery',
    what: 'Nearby events, which the crowd model reads as a feature.',
    where: 'backend/routes/events.js, backend/services/mlPredictor.js and backend/services/nightContext.js',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'ticketmaster' },
    configuredEnv: ['TICKETMASTER_API_KEY'],
    observedLineId: 'ticketmaster',
    usageNote: null,
    costsNothingBecause: 'Free public tier at 5,000 calls a day. The three ledgers together are capped at 3,700.',
  },
  {
    id: 'resend',
    label: 'Resend',
    what: 'Email. Verification, password reset, and the Monday venue digest.',
    where: 'backend/services/emailService.js',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'resend' },
    configuredEnv: ['RESEND_API_KEY'],
    observedLineId: 'resend',
    usageNote: 'Only the digest is counted. Transactional mail is not in that number.',
    costsNothingBecause: 'The free tier is 3,000 a month and 100 a day, and the digest is one email per venue per week.',
  },
  {
    // TWO HALVES, ONE OF WHICH THIS PROCESS CANNOT SEE.
    //
    // The product analytics half runs in the browser off REACT_APP_POSTHOG_KEY,
    // a Vercel build variable. It is live and it is the only half sending
    // anything. The Birdie token-trace half runs here off POSTHOG_API_KEY, and
    // that is the name below, so `configured` on this row answers a question
    // about Birdie observability and says nothing at all about whether the app
    // is reporting. The row used to describe both halves as running and name
    // only the server variable, which read as "analytics is off" on a panel
    // whose whole purpose is to stop a number being asserted without a meter
    // behind it.
    //
    // MEASURED against the PostHog project on 2026-08-25: 4,000-odd events in
    // the entire history of the project, and not one $ai_generation or
    // $ai_span among them. routes/ai.js builds no client without
    // POSTHOG_API_KEY, so the traces this row was written to price have never
    // existed. The cost consequence is nil either way, well inside the free
    // tier. The consequence that matters is that Birdie's token count and
    // latency, the numbers behind the largest variable cost in the product,
    // are not being recorded anywhere.
    id: 'posthog',
    label: 'PostHog',
    what: 'Product analytics in the app. The Birdie token traces are written and send nothing.',
    where: 'frontend/src/services/api.js for the app events, backend/routes/ai.js for the traces',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'posthog' },
    configuredEnv: ['POSTHOG_API_KEY'],
    configuredNote: 'POSTHOG_API_KEY is the Birdie trace leg only. The app events ride REACT_APP_POSTHOG_KEY, which is set at build time on Vercel and is not visible from this process, so this line can never report on them.',
    observedLineId: null,
    // This sentence carries the whole correction, because the panel only
    // prints configuredNote when configuredEnv is null (App.js depConfigured).
    // With a name to read, the line below will say 'Not configured,
    // POSTHOG_API_KEY is unset on the server', which is true of the trace leg
    // and false of the app, and the note that explains the difference is where
    // it will actually be read.
    usageNote: 'Event volume is counted by PostHog and by nothing in this repo. The configured line below reads POSTHOG_API_KEY, which is the Birdie trace leg only: the app events ride REACT_APP_POSTHOG_KEY, a Vercel build variable this process cannot see. No $ai_generation event has ever reached the project, so no token trace is in that volume.',
    costsNothingBecause: 'Free below 1,000,000 events a month, and Flock has roughly no users.',
    unknownAction: 'The event count is on the PostHog billing page if you want to see how much of that allowance is gone. Setting POSTHOG_API_KEY on the Railway service is what starts the Birdie token traces; routes/ai.js already sends metrics only, with no conversation content.',
  },
  {
    id: 'sentry',
    label: 'Sentry',
    what: 'Crash and error reporting. Wired up and switched off.',
    where: 'backend/instrument.js',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'sentry' },
    configuredEnv: ['SENTRY_DSN'],
    observedLineId: null,
    usageNote: 'Nothing to measure while nothing is being sent.',
    costsNothingBecause: 'Unused. With no DSN, instrument.js never calls Sentry.init, so not even the free tier is being consumed. The configured reading beside this row comes from the running process rather than from an assumption.',
  },
  {
    id: 'revenuecat',
    label: 'RevenueCat',
    what: 'Would run the consumer subscription. The paywall has never been switched on.',
    where: 'the paywall, behind PAYWALL_ENABLED',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'revenuecat' },
    configuredEnv: ['REVENUECAT_WEBHOOK_SECRET'],
    observedLineId: null,
    usageNote: 'Tracked revenue is $0 because nothing has ever been sold.',
    costsNothingBecause: 'Free below $2,500 of monthly tracked revenue, then 1% of it.',
  },
  {
    id: 'push',
    label: 'Push notifications',
    what: 'Firebase Cloud Messaging, which relays to APNs on iOS.',
    where: 'backend/services/firebaseService.js',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'push' },
    configuredEnv: ['FIREBASE_SERVICE_ACCOUNT'],
    observedLineId: null,
    usageNote: 'Sends are not counted here.',
    costsNothingBecause: 'FCM is listed at no cost on both Firebase plans. APNs has no published price at all and is covered by the Developer Program, which is a conclusion drawn from an absence rather than from a quoted zero.',
  },
  {
    id: 'google-sign-in',
    label: 'Google Sign-In',
    what: 'One of the three ways into an account.',
    where: 'backend/routes/auth.js and the web client',
    group: 'free',
    pricing: { type: 'free' },
    configuredEnv: ['GOOGLE_CLIENT_ID'],
    observedLineId: null,
    usageNote: null,
    costsNothingBecause: 'Google Identity Services publishes no price for sign-in.',
    source: 'https://developers.google.com/identity/gsi/web/guides/overview',
    checked: '2026-08-20',
  },
  {
    id: 'apple-sign-in',
    label: 'Sign in with Apple',
    what: 'Required by App Store rules wherever another social login exists.',
    where: 'backend/services/appleAuth.js',
    group: 'free',
    pricing: { type: 'free' },
    configuredEnv: ['APPLE_CLIENT_ID'],
    observedLineId: null,
    usageNote: null,
    costsNothingBecause: 'Included with the Apple Developer Program, which is already on the fixed list.',
    source: 'https://developer.apple.com/sign-in-with-apple/',
    checked: '2026-08-20',
  },
  {
    id: 'dicebear',
    label: 'DiceBear',
    what: 'The default avatar for an account with no photo.',
    where: 'frontend/src/App.js',
    group: 'free',
    pricing: { type: 'free' },
    configuredEnv: null,
    configuredNote: 'Unkeyed.',
    observedLineId: null,
    watchlistId: 'dicebear',
    usageNote: 'Requests go straight from the browser and are counted nowhere.',
    costsNothingBecause: 'Free hosted tier, no account, no key.',
    source: 'https://www.dicebear.com/',
    checked: '2026-08-20',
  },
  {
    id: 'venmo-cashapp',
    label: 'Venmo and Cash App',
    what: 'The bill split hands the phone a payment link. Flock never touches the money.',
    where: 'frontend/src/App.js',
    group: 'free',
    pricing: { type: 'free' },
    configuredEnv: null,
    configuredNote: 'Deep links only. There is no API and no account.',
    observedLineId: null,
    usageNote: null,
    costsNothingBecause: 'There is no integration to charge for. Flock builds a URL and opens it.',
    source: 'https://venmo.com/',
    checked: '2026-08-20',
  },
  {
    id: 'apple-commission',
    label: 'App Store commission',
    what: 'Not a cost today. It is what a subscription is worth when one is finally sold.',
    where: 'in-app purchase, unbuilt',
    group: 'free',
    pricing: { type: 'free', rateGroup: 'stores' },
    configuredEnv: null,
    observedLineId: null,
    usageNote: null,
    costsNothingBecause: 'Nothing is purchasable. 30% standard, 15% under the Small Business Program and after year one on a subscription.',
  },
  {
    id: 'codemagic',
    label: 'Codemagic',
    what: 'Builds the iOS app.',
    where: 'codemagic.yaml',
    group: 'free',
    pricing: { type: 'unknown' },
    configuredEnv: null,
    configuredNote: 'Configured in the Codemagic dashboard, not in this repo.',
    observedLineId: null,
    watchlistId: 'codemagic',
    usageNote: 'Builds are not counted here.',
    costsNothingBecause: 'There is no trigger block, so nothing runs it on a schedule. It bills per build, and only when a build is started by hand.',
    unknownCost: true,
    unknownAction: 'What a build costs depends on the plan. Check the Codemagic billing page if the build count ever climbs.',
  },
  {
    id: 'github-actions',
    label: 'GitHub Actions',
    what: 'Runs the gitleaks secret scan on every push.',
    where: '.github/workflows/gitleaks.yml',
    group: 'free',
    pricing: { type: 'free' },
    configuredEnv: null,
    observedLineId: null,
    watchlistId: 'github-actions',
    usageNote: null,
    costsNothingBecause: 'Free on public repositories, and this one is public.',
  },
  {
    id: 'seatgeek',
    label: 'SeatGeek',
    what: 'A second event source for the offline training scripts.',
    where: 'backend/scripts/ml/eventService.js',
    group: 'free',
    pricing: { type: 'free' },
    configuredEnv: ['SEATGEEK_CLIENT_ID'],
    observedLineId: null,
    watchlistId: 'seatgeek',
    usageNote: null,
    costsNothingBecause: 'No server code reads the key and nothing schedules the scripts, so it generates no calls.',
    source: 'https://platform.seatgeek.com/',
    checked: '2026-08-20',
  },
  {
    id: 'besttime-subscription',
    label: 'BestTime.app Pro, Package 100',
    what: 'The live subscription feeding nightly collection. A fixed allowance rather than a meter, so the monthly cap governs new venue admissions and ordinary by-id, live and query calls on admitted venues are unlimited.',
    where: 'backend/scripts/ml/collectRealtime.js, run by the Railway BESTTIME cron at 02:00 UTC',
    group: 'fixed',
    fixedId: 'besttime-subscription',
    configuredEnv: ['BESTTIME_API_KEY'],
    observedLineId: null,
    usageNote: 'Not metered, so no meter can estimate it. The bill is the tier price until the tier changes.',
  },
];

const DEPENDENCIES_CHECKED = '2026-08-20';

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
 * @param {number} counts.placesPhotoCallsToday  places_photo_spend, today
 * @param {number} counts.placesPhotoCallsMonth  places_photo_spend, this month
 * @param {object} counts.placesPhotoBudget      photoSpendStatus().limits, or null
 * @param {number} counts.visionCallsToday       visionBudgetStatus().globalUsed
 * @param {number} counts.weatherCallsToday      weatherBudgetStatus().dailyUsed
 * @param {number} counts.ticketmasterCallsToday routes/events.js day ledger
 * @param {number} counts.nightContextCallsToday nightContext's own day ledger
 * @param {number} counts.crowdEventCallsToday   mlPredictor's event day ledger
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
    const photosMonth = num(c.placesPhotoCallsMonth);
    const photoBudget = c.placesPhotoBudget || null;
    const other = total === null ? null : Math.max(0, total - (photos || 0));
    const sk = RATES.places.skus;
    lines.push({
      id: 'places-photos',
      label: 'Place Details Photos',
      unit: 'photos bought today',
      count: photos,
      // The free tier is a MONTHLY allowance, so a day cannot say how much of it
      // is left. Today's line is priced gross and the month's line below is the
      // one that applies the free tier, rather than both guessing.
      usd: photos === null ? null : round(priceCalls(photos, sk.photos.perThousand), 4),
      window: 'today',
      durable: true,
      note: photoBudget
        ? `From places_photo_spend, so it survives deploys and is shared across instances. Counts photos BOUGHT from Google; cache hits are free and never counted. Priced gross here: the free tier is monthly and is applied on the month line. Daily brake ${photoBudget.burstPerDay}.`
        : 'From places_photo_spend, so it survives deploys. Counts photos BOUGHT from Google; cache hits are free and never counted.',
    });
    // The line that is actually denominated in the budget Jayden set. Google
    // bills Place Photos per calendar month with the first 1,000 free, so the
    // month is the period the money question is asked in, and the free tier is
    // subtracted here rather than pretended away.
    lines.push({
      id: 'places-photos-month',
      label: 'Place Details Photos, month to date',
      unit: 'photos bought this month',
      count: photosMonth,
      usd: photosMonth === null
        ? null
        : round(
          priceCallsAfterFree(photosMonth, sk.photos.perThousand, sk.photos.freePerMonth),
          4
        ),
      window: 'month to date',
      durable: true,
      budget: photoBudget,
      note: photoBudget
        ? `After the ${sk.photos.freePerMonth} free photo requests a month. The ceiling is ${photoBudget.fetchesPerMonth} photos a month, which is the $${photoBudget.budgetUsdPerYear} a year budget in services/photoStore.js. Reaching it does not blank photos that are already cached; it stops NEW venues being bought until the 1st, and it means the budget wants raising.`
        : `After the ${sk.photos.freePerMonth} free photo requests a month.`,
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
      note: 'The shared Places ledger counts calls without recording the SKU, so this is a band: everything priced as Place Details at the low end, everything as Text Search at the high end. Since 2026-08-20 the Place Details half of this counts ONE call per venue-detail open rather than two — services/placeDetailsCache.js gives the detail card and the crowd card one shared payload — so the count itself is lower; the band is derived from it and needed no adjustment.',
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
    // The third ledger. Summed with the other two rather than given its own
    // line, because they are one vendor on one free tier and the number that
    // matters is what the whole repo asked Ticketmaster for today.
    const ceDay = num(c.crowdEventCallsToday);
    const tm = tmDay === null && ncDay === null && ceDay === null
      ? null
      : (tmDay || 0) + (ncDay || 0) + (ceDay || 0);
    lines.push({
      id: 'ticketmaster',
      label: 'Ticketmaster Discovery',
      unit: 'calls today',
      count: tm,
      usd: tm === null ? null : 0,
      window: 'today, this process only',
      durable: false,
      freeTier: true,
      note: 'Free public tier, 5,000 calls a day. All three ledgers together are capped at 3,700: routes/events.js at 2,000, services/mlPredictor.js at 1,500, services/nightContext.js at 200.',
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
 * @param {number} [limits.advisorAdvicePromptTokens]    the advice system prompt
 * @param {number} [limits.advisorAdviceMaxOutputTokens] the advice maxOutputTokens
 * @param {number} limits.placesGlobalDaily
 * @param {number} limits.visionGlobalDaily
 * @param {number} limits.weatherDaily
 * @param {number} limits.ticketmasterGlobalDaily  routes/events.js
 * @param {number} limits.crowdEventGlobalDaily    services/mlPredictor.js
 * @param {number} limits.nightContextGlobalDaily  services/nightContext.js
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
    // THE DEAREST CALL SHAPE, not the commonest — the same max()
    // buildVenueUnitEconomics takes, and for the same reason, because this
    // global cap can be drained entirely by free-text advice. Advice runs a
    // system prompt less than half the length of the phrasing one against the
    // same 4,096-token output ceiling, so its output fraction is roughly 0.50
    // against the chip's 0.31, and output bills at five times input. Pricing
    // the whole ceiling at the chip's share understated this line, which is the
    // one line in the file whose entire job is to say how bad it could get. A
    // caller that passes no advice pair gets the chip share, unchanged.
    const share = Math.max(
      outputShareOf(l.advisorPromptTokens, l.advisorMaxOutputTokens),
      outputShareOf(l.advisorAdvicePromptTokens, l.advisorAdviceMaxOutputTokens)
    );
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
      // THE SUM OF ALL THREE, because a worst case that names one of them is
      // not a worst case. This line read 2,000 while the repo could spend
      // 3,700, so the one figure on the panel that exists to answer "how bad
      // could this get" was understating it by the largest of the three
      // ledgers. A ceiling nobody passes stays null rather than becoming a
      // smaller number that looks complete.
      ceiling: [l.ticketmasterGlobalDaily, l.crowdEventGlobalDaily, l.nightContextGlobalDaily]
        .map(num).reduce((a, b) => (a === null && b === null ? null : (a || 0) + (b || 0)), null),
      ceilingUnit: 'calls per day, all three ledgers',
      perDayUsd: 0,
      perMonthUsd: 0,
      note: 'Zero. The free public tier is 5,000 calls a day, and the three ledgers together are capped at 3,700.',
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
  // ONE_TIME is scanned for the verified flag too. Every line on it is
  // verified today so this changes no number, and it is here because the
  // promise this block makes to the panel is "an unverified figure says so".
  // A list left out of the scan breaks that promise silently the first time
  // somebody adds an unverified one-time purchase to it.
  const all = [...FIXED_MONTHLY, ...FIXED_ANNUAL, ...ONE_TIME];
  const unverified = all.filter((e) => !e.verified).map((e) => e.id);
  // HOW MUCH of the total is unverified, not merely how many lines are. Those
  // are different sizes of problem and the panel could only say the second
  // one: two unverified lines worth $0 and $12 read identically to two worth
  // $0 and $125.
  const unverifiedMonthly = FIXED_MONTHLY.filter((e) => !e.verified).reduce((s, e) => s + e.usd, 0);
  const unverifiedAnnual = FIXED_ANNUAL.filter((e) => !e.verified).reduce((s, e) => s + e.usd, 0);
  // The oldest and newest dates a human last looked at any of these. Staleness
  // is a property of the whole hand-maintained block rather than of one row,
  // and computing it here means the panel states it instead of asking a reader
  // to compare eight dates by eye.
  const checked = all.map((e) => e.checked).filter((d) => typeof d === 'string').sort();

  // THE SPLIT. Recurring money a user causes, against recurring money the
  // developer causes. Each is expressed the one way it can be compared with
  // the other and with a price: dollars a month, with the annual bills already
  // spread. A line with no `kind` counts as infrastructure, because the safe
  // default for an unclassified bill is the number that is quoted as the cost
  // of service, so forgetting the field overstates that figure rather than
  // hiding a bill from it.
  const perMonthOf = (list, months) => list.reduce((s, e) => s + e.usd / months, 0);
  const isTooling = (e) => e.kind === 'tooling';
  const infraMonthly =
    perMonthOf(FIXED_MONTHLY.filter((e) => !isTooling(e)), 1)
    + perMonthOf(FIXED_ANNUAL.filter((e) => !isTooling(e)), 12);
  const toolingMonthly =
    perMonthOf(FIXED_MONTHLY.filter(isTooling), 1)
    + perMonthOf(FIXED_ANNUAL.filter(isTooling), 12);

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
    // THE SPLIT, published. These two were computed above and then left out of
    // this object, so the panel could never show them. Infrastructure is the
    // figure to quote as the cost of serving a venue; tooling is a real bill
    // that no user causes. Together they equal effectiveMonthlyUsd.
    infrastructureMonthlyUsd: round(infraMonthly),
    toolingMonthlyUsd: round(toolingMonthly),
    // The annual half of that on its own, so a panel showing the spread does
    // not have to divide by twelve in a template.
    annualPerMonthUsd: round(annual / 12),
    unverifiedLines: unverified,
    unverifiedMonthlyUsd: round(unverifiedMonthly),
    unverifiedAnnualUsd: round(unverifiedAnnual),
    oldestChecked: checked[0] || null,
    newestChecked: checked[checked.length - 1] || null,
  };
}

// ---------------------------------------------------------------------------
// GOOGLE QUOTA CAPS, PRICED
// ---------------------------------------------------------------------------

/**
 * What the Google-side quota caps permit, priced at the rate card.
 *
 * CEILINGS ONLY, exactly like buildWorstCase(): no meter reading is in scope
 * and none is passed. The panel puts an observed count NEXT to a quota, never
 * inside it, so the two can be compared without either becoming the other.
 *
 * The one argument is ANOTHER CEILING, which is why it is allowed here: the
 * repo has its own daily photo brake in services/photoStore.js, and the two
 * limits now overlap. Whichever is smaller is the one that actually refuses,
 * and reading a limit off the wrong side of that comparison is how a service
 * comes to be capped a third of the way below where its owner thinks it is.
 *
 * @param {object} [limits]
 * @param {number} [limits.photoBurstPerDay] photoStore PHOTO_FETCH_BURST_PER_DAY
 */
function buildGoogleQuotas(limits = {}) {
  const repoPhotoBrake = Number.isFinite(limits.photoBurstPerDay) && limits.photoBurstPerDay > 0
    ? limits.photoBurstPerDay
    : null;
  const lines = GOOGLE_QUOTAS.perDay.map((q) => {
    const sku = RATES.places.skus[q.sku];
    const callsPerMonth = q.perDay * DAYS_PER_MONTH;
    return {
      id: q.id,
      label: sku.label,
      perDay: q.perDay,
      perThousandUsd: sku.perThousand,
      freePerMonth: sku.freePerMonth,
      callsPerMonth: Math.round(callsPerMonth),
      perMonthUsdGross: round(priceCalls(callsPerMonth, sku.perThousand)),
      perMonthUsdAfterFree: round(
        priceCallsAfterFree(callsPerMonth, sku.perThousand, sku.freePerMonth)
      ),
      observedLineId: q.observedLineId,
      // Only the photo SKU has a second daily limit to lose to.
      repoDailyBrake: q.id === 'photos' ? repoPhotoBrake : null,
      bindingDaily: q.id === 'photos' && repoPhotoBrake !== null
        ? (repoPhotoBrake <= q.perDay ? 'repo' : 'google')
        : (q.id === 'photos' ? null : 'google'),
    };
  });
  const afterFree = round(lines.reduce((s, l) => s + l.perMonthUsdAfterFree, 0));
  const gross = round(lines.reduce((s, l) => s + l.perMonthUsdGross, 0));
  const budget = GOOGLE_QUOTAS.budget.usdPerMonth;
  return {
    kind: 'googleQuotas',
    checked: GOOGLE_QUOTAS.checked,
    project: GOOGLE_QUOTAS.project,
    console: GOOGLE_QUOTAS.console,
    budget: GOOGLE_QUOTAS.budget,
    lines,
    perMonthUsdGross: gross,
    perMonthUsdAfterFree: afterFree,
    // Do the four quotas still add up to the budget they were derived from? A
    // rate change or a hand-edited quota breaks that agreement silently
    // otherwise, and the panel would go on implying a cap it no longer has.
    agreesWithBudget: Math.abs(afterFree - budget) <= budget * 0.05,
    note: 'Every quota spent every day of an average month, priced at the rate card, with each free allowance taken off. A ceiling, not a bill.',
  };
}

// ---------------------------------------------------------------------------
// THE INVENTORY, RESOLVED
// ---------------------------------------------------------------------------

/** The published free allowance of a rate-card group, in words. */
function freeTierTextFor(groupName) {
  const g = groupName ? RATES[groupName] : null;
  if (!g) return null;
  const n = (x) => Number(x).toLocaleString('en-US');
  switch (groupName) {
    case 'weather':
      return `${n(g.freePerMonth)} calls a month, ${n(g.freePerMinute)} a minute`;
    case 'ticketmaster':
      return `${n(g.freePerDay)} calls a day`;
    case 'resend':
      return `${n(g.freePerMonth)} emails a month and ${n(g.freePerDay)} a day. The next tier is $${g.nextTierUsd.toFixed(2)} a month for ${n(g.nextTierIncluded)}`;
    case 'posthog':
      return `${n(g.freeEventsPerMonth)} events a month, then $${g.perEventOverFree} each`;
    case 'sentry':
      return `${n(g.freeErrorsPerMonth)} errors a month. The next tier is $${g.nextTierUsd.toFixed(2)} a month`;
    case 'revenuecat':
      return `$${n(g.freeMonthlyTrackedRevenueUsd)} of monthly tracked revenue, then ${g.percentOverFree}% of it`;
    case 'maptiler':
      return `${n(g.freeSessionsPerMonth)} map sessions and ${n(g.freeApiRequestsPerMonth)} API requests a month. The next tier is $${g.nextTierUsd.toFixed(2)} a month and it bills overages automatically`;
    case 'push':
      return 'No charge published on either leg';
    default:
      return null;
  }
}

const RATE_GROUP_OF_PRICING_TYPE = { gemini: 'gemini', places: 'places', vision: 'vision' };

/**
 * Resolve the dependency inventory against the rate card and the environment.
 *
 * The only inputs are CONFIGURATION: which Gemini model each caller is set to,
 * and which environment variable names exist. Neither is a meter and neither is
 * a ceiling, so this builder sits outside the observed / worst-case wall rather
 * than straddling it. It returns join keys and prices; the counts come from
 * buildObserved() and are joined by the panel.
 *
 * ENV VARS ARE READ FOR PRESENCE ONLY. A name is returned, a value never is.
 * This whole payload goes over the wire to an admin browser.
 *
 * @param {object} ctx
 * @param {string} [ctx.birdieModel]  BIRDIE_MODEL in force
 * @param {string} [ctx.advisorModel] ADVISOR_MODEL in force
 * @param {string} [ctx.onDate]       YYYY-MM-DD, for rate selection
 */
function buildDependencies(ctx = {}) {
  const onDate = typeof ctx.onDate === 'string' ? ctx.onDate : new Date().toISOString().slice(0, 10);
  const present = (name) => {
    const v = process.env[name];
    return typeof v === 'string' && v.trim() !== '';
  };

  const entries = DEPENDENCIES.map((d) => {
    const p = d.pricing || null;
    const groupName = (p && (p.rateGroup || RATE_GROUP_OF_PRICING_TYPE[p.type])) || null;
    const g = groupName ? RATES[groupName] : null;

    let unitPrice = null;
    let freeTier = freeTierTextFor(groupName);
    let unpriceable = false;
    let model = null;

    if (p && p.type === 'gemini') {
      model = p.model === 'birdie'
        ? (ctx.birdieModel || null)
        : p.model === 'roost' ? (ctx.advisorModel || null) : p.model;
      const r = model ? geminiRate(model, onDate) : null;
      if (r) {
        unitPrice = `$${r.inputPerMTok.toFixed(2)} per million input tokens, $${r.outputPerMTok.toFixed(2)} per million output`;
        if (r.promotional && r.changesOn) {
          unitPrice += `. Promotional, and it doubles on ${r.changesOn}`;
        }
        freeTier = 'The Gemini API has a free tier. The reconciled Google bill records $0 from Gemini on both callers to date.';
      } else {
        // A model id this file has never heard of must read as unpriced, never
        // as free. BIRDIE_MODEL and ADVISOR_MODEL are switchable from Railway.
        unpriceable = true;
      }
    } else if (p && p.type === 'places') {
      const sku = RATES.places.skus[p.sku];
      unitPrice = `$${sku.perThousand.toFixed(2)} per 1,000 requests`;
      freeTier = `The first ${Number(sku.freePerMonth).toLocaleString('en-US')} requests of this SKU each month`;
    } else if (p && p.type === 'vision') {
      unitPrice = `$${RATES.vision.perThousand.toFixed(2)} per 1,000 images`;
      freeTier = `The first ${Number(RATES.vision.freePerMonth).toLocaleString('en-US')} images each month`;
    }

    const envNames = Array.isArray(d.configuredEnv) ? d.configuredEnv : null;
    const found = envNames ? envNames.filter(present) : [];

    return {
      id: d.id,
      label: d.label,
      what: d.what,
      where: d.where,
      group: d.group,
      unitPrice,
      freeTier,
      unpriceable,
      model,
      unknownCost: !!d.unknownCost,
      unknownAction: d.unknownAction || null,
      costsNothingBecause: d.costsNothingBecause || null,
      usageNote: d.usageNote || null,
      note: d.note || null,
      // Join keys. The panel resolves each against the block that owns it, so
      // no price and no sentence exists twice in this payload.
      observedLineId: d.observedLineId || null,
      fixedId: d.fixedId || null,
      watchlistId: d.watchlistId || null,
      statusKey: d.statusKey || null,
      finding: d.finding || null,
      // Configuration, read from the running process. null means this process
      // has no way to see it, which is not the same as it being unset.
      configured: envNames === null ? null : found.length > 0,
      configuredVia: found.length > 0 ? found[0] : null,
      configuredEnv: envNames,
      configuredNote: d.configuredNote || null,
      source: d.source || (g ? g.source : null),
      checked: d.checked || (g ? g.checked : null),
    };
  });

  const inGroup = (id) => entries.filter((e) => e.group === id);
  return {
    kind: 'dependencies',
    checked: DEPENDENCIES_CHECKED,
    onDate,
    groups: [
      {
        id: 'metered',
        label: 'Metered APIs',
        short: 'metered',
        note: 'Charged per call or per token. These are the only lines that can grow a bill on their own.',
        entries: inGroup('metered'),
      },
      {
        id: 'fixed',
        label: 'Fixed bills',
        short: 'fixed',
        note: 'These arrive whether anybody opens the app or not.',
        entries: inGroup('fixed'),
      },
      {
        id: 'free',
        label: 'Free or unused',
        short: 'free or unused',
        note: 'Every row here is $0 today, and every row says which kind of $0 it is.',
        entries: inGroup('free'),
      },
    ],
    total: entries.length,
    unknownCostIds: entries.filter((e) => e.unknownCost).map((e) => e.id),
    unmeteredIds: entries.filter((e) => !e.observedLineId).map((e) => e.id),
    note: 'Everything Flock reaches outside itself, including the free things. A dependency that costs nothing is still an account somebody can lock.',
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
  // is the advice answer, not the chip answer: the two now carry the SAME
  // 4,096-token output ceiling (both were raised on 2026-08-20, because a
  // thinking model spends the ceiling before it writes a word), and the advice
  // system prompt is less than half the length of the phrasing one, so advice
  // runs at roughly a 0.50 output fraction against the chip's 0.31. Pricing the
  // whole cap at the chip's share would understate a venue that only ever
  // types. Do not restate either number here as a constant; both move when a
  // prompt is edited and the caller passes them in for exactly that reason.
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
  GOOGLE_QUOTAS,
  DEPENDENCIES,
  DEPENDENCIES_CHECKED,
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
  buildGoogleQuotas,
  buildDependencies,
  freeTierTextFor,
};
