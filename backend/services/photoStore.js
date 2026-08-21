// ---------------------------------------------------------------------------
// The durable half of the Places photo proxy: the cache that survives a deploy,
// and the spend ledger that is denominated in dollars instead of in requests.
//
// WHAT WAS WRONG. routes/venueSearch.js kept both of these in this process's
// heap: `const photoCache = new Map()` and a module-scope day counter. A
// Railway deploy destroys both. On 2026-08-19 this service deployed roughly
// fifteen times in one night, and each deploy threw away every photo that had
// already been bought and re-bought them all from Google. The daily cap was
// then reached by the SAME venues being purchased over and over, and when it
// bound, a real person looking at a venue card saw no picture of the venue.
// That is the failure this module exists to remove: the cache is the spend
// control, and a cache that cannot survive a restart is not one.
//
// TWO THINGS LIVE HERE AND THEY ARE THE SAME DECISION. The bytes have to be
// shared and durable so a photo is bought once. The ledger has to be shared and
// durable so the ceiling means something across deploys and across instances.
// Neither is satisfiable in memory, both are satisfiable in the Postgres that
// is already in every request path, so both are here. Migration 046 carries the
// schema and the reasoning for the table shapes.
//
// ---------------------------------------------------------------------------
// WHAT GOOGLE'S TERMS ACTUALLY SAY ABOUT CACHING THIS, read on 2026-08-20.
// ---------------------------------------------------------------------------
// The comment this file replaces said "the Google Maps Platform terms permit
// temporarily caching Places content for up to 30 days". That sentence is not
// in the terms, and __tests__/photoCacheCost.test.js was asserting against it.
// The real text, quoted:
//
//   Google Maps Platform Terms of Service, 3.2.3(b) (No Caching):
//     "Customer will not cache Google Maps Content except as expressly
//      permitted under the Maps Service Specific Terms."
//     https://cloud.google.com/maps-platform/terms
//
//   Maps Service Specific Terms, 14.3 (Places API (Legacy and New), Caching):
//     "Customer may temporarily cache latitude and longitude values from the
//      Places API for up to 30 consecutive calendar days, after which Customer
//      must delete the cached latitude and longitude values."
//     https://cloud.google.com/maps-platform/terms/maps-service-terms
//
//   Place Photos (New) reference:
//     "Caution: You cannot cache a photo name. Also, the name can expire."
//     https://developers.google.com/maps/documentation/places/web-service/place-photos
//
// So: 30 consecutive calendar days is a real number in the real terms, and the
// content it is granted for is latitude and longitude, not photo bytes. There
// is no clause anywhere that expressly permits caching a Places photo. Read
// strictly, 3.2.3(b) forbids the seven-day cache this repo has been running for
// months as firmly as it forbids a thirty-day one, so the choice here is not
// between a compliant TTL and a non-compliant one.
//
// WHAT THIS MODULE DOES ABOUT THAT, stated plainly rather than papered over:
//   * The TTL is 30 consecutive calendar days, the longest window the Places
//     section of the Service Specific Terms contemplates for any Places
//     content. Expiry is ENFORCED by a real DELETE and not only by a read-time
//     check, so nothing outlives the window on disk.
//   * The photo NAME is never written down, because that is the one thing the
//     documentation refuses by name. The stored key is
//     sha256(`<name>|<maxWidthPx>`): it identifies a row for a caller that
//     already holds the name and cannot return the name to anyone who does not.
//   * Nothing derived from the photo is stored, republished, or resold; the
//     bytes are served to the same surface that would have received them from
//     Google, through the same proxy, with the same attribution.
//
// If Google ever objects, the fix is one constant (PHOTO_CACHE_TTL_MS) and one
// pruner run, which is why the number is here and not spread across three files.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const pool = require('../config/database');
const { RATES, DAYS_PER_MONTH } = require('./costModel');

const PHOTO_SKU = RATES.places.skus.photos;

// ---------------------------------------------------------------------------
// THE BUDGET. One number. Everything else is derived from it.
// ---------------------------------------------------------------------------
// Jayden's instruction, verbatim: "make sure it's rate limited to the point
// where I'm not paying thousands a year, make sure the max I'd pay per year
// would be like a hundred bucks per year, and that's regardless of how many
// users I'll have", then raised to three hundred within the same conversation.
// It has changed twice already, so it is ONE constant with the arithmetic
// written beside it and every other figure computed, rather than three numbers
// that can drift apart.
//
//   PHOTO_BUDGET_USD_PER_YEAR = 300
//     / 12                       = $25.00 a month
//     / $7.00 per 1,000          = 3,571 PAID fetches a month
//     + 1,000 free per month     = 4,571 fetches a month
//     / 30.4375 days             = about 150 a day at an even pace
//
// For retuning later, when ads are paying for it:
//     $100/yr -> 2,190 fetches/mo (~72/day)
//     $300/yr -> 4,571 fetches/mo (~150/day)   <- shipped
//     $500/yr -> 6,952 fetches/mo (~228/day)
//
// FOR SCALE, the ceiling this replaces: PUBLIC_PHOTO_BUDGET was 1,500 fetches a
// DAY, which is 45,656 a month, which is $311 a month or $3,738 a year. It was
// never a budget. It was a blast radius.
//
// AND THE REASON THIS IS NOT IN TENSION WITH "PHOTOS ALWAYS SHOW": the ledger
// counts photos BOUGHT, not photos SHOWN. A cache hit, in memory or from
// places_photo_cache, never reaches this ledger, and after the change the
// cache no longer forgets everything on deploy, so the spend scales with
// DISTINCT VENUES PHOTOGRAPHED PER MONTH and not with users, sessions or page
// views. 4,571 distinct venues a month is far more than this product touches.
const PHOTO_BUDGET_USD_PER_YEAR = (() => {
  const raw = Number(process.env.PHOTO_BUDGET_USD_PER_YEAR);
  // A misconfigured env var must not silently become a bigger bill or a dark
  // product. Anything that is not a positive finite number falls back to the
  // shipped figure.
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
})();

const PHOTO_BUDGET_USD_PER_MONTH = PHOTO_BUDGET_USD_PER_YEAR / 12;
// The free tier is accounted for explicitly rather than pretended away: Google
// gives 1,000 Place Details Photos requests a month at no charge, so the budget
// buys paid fetches ON TOP of those, and a month that stays under 1,000 costs
// nothing at all.
const PHOTO_FREE_FETCHES_PER_MONTH = PHOTO_SKU.freePerMonth;
const PHOTO_PAID_FETCHES_PER_MONTH = Math.floor(
  (PHOTO_BUDGET_USD_PER_MONTH / PHOTO_SKU.perThousand) * 1000
);
const PHOTO_FETCH_BUDGET_MONTH = PHOTO_FREE_FETCHES_PER_MONTH + PHOTO_PAID_FETCHES_PER_MONTH;

// A DAILY BRAKE, not a second budget. Without one, a bad hour on the 1st spends
// the whole month and every venue nobody has looked at yet is pictureless until
// the 1st of the next month, which is a far worse "no photo" than a few hours
// of throttling. Three times the even pace, so a genuinely busy day is not
// touched and a runaway one is contained. Derived, so raising the annual figure
// raises this with it.
const PHOTO_DAY_BURST_MULTIPLE = 3;
const PHOTO_FETCH_BURST_PER_DAY = Math.ceil(
  (PHOTO_FETCH_BUDGET_MONTH / DAYS_PER_MONTH) * PHOTO_DAY_BURST_MULTIPLE
);

// 30 consecutive calendar days. See the terms block at the top of this file for
// where that number comes from and what it does and does not cover.
const PHOTO_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
// sha256 of `<photo resource name>|<maxWidthPx>`. Two properties matter: the
// photo name is not recoverable from what is stored (the documentation refuses
// caching a photo name in terms), and the primary key is 64 bytes instead of the
// up-to-2KB a real resource name can reach.
function photoCacheKey(photoRef, maxWidth) {
  return crypto.createHash('sha256').update(`${photoRef}|${maxWidth}`).digest('hex');
}

// ---------------------------------------------------------------------------
// The stored bytes
// ---------------------------------------------------------------------------

/**
 * Read one cached photo, or null. A row past the TTL reads as a miss AND is
 * left for the pruner: expiry is a terms obligation, so it is enforced on the
 * read path and on a timer, not on one of them.
 *
 * Never throws. A database that cannot answer is a cache MISS, which costs a
 * Google call; it is not a failure of the request.
 */
async function readStoredPhoto(cacheKey) {
  try {
    const r = await pool.query(
      `SELECT content_type, bytes, fetched_at
         FROM places_photo_cache
        WHERE cache_key = $1
          AND fetched_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
      [cacheKey, PHOTO_CACHE_TTL_MS]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      buffer: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes),
      contentType: row.content_type,
      ts: new Date(row.fetched_at).getTime(),
    };
  } catch (err) {
    console.error('[Photo Store] read failed, treating as a miss:', err.message);
    return null;
  }
}

/**
 * Write one photo through to Postgres. Fire and forget from the route's point
 * of view: the bytes are already on their way to the browser and a failed write
 * only costs a future re-fetch, so it is logged and swallowed rather than turned
 * into a 500 on a request that succeeded.
 */
async function writeStoredPhoto(cacheKey, { buffer, contentType }) {
  try {
    await pool.query(
      `INSERT INTO places_photo_cache (cache_key, content_type, bytes, byte_len, fetched_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (cache_key) DO UPDATE
         SET content_type = EXCLUDED.content_type,
             bytes        = EXCLUDED.bytes,
             byte_len     = EXCLUDED.byte_len,
             fetched_at   = NOW()`,
      [cacheKey, contentType, buffer, buffer.length]
    );
    return true;
  } catch (err) {
    console.error('[Photo Store] write failed, the photo will be re-bought later:', err.message);
    return false;
  }
}

/**
 * Delete everything past the TTL. Called on boot and hourly from server.js.
 * The WHERE is what keeps this past config/database.js's unconditional-DELETE
 * guard, and it is also the point: this is an expiry, never a flush.
 */
async function prunePhotoStore() {
  try {
    const r = await pool.query(
      `DELETE FROM places_photo_cache
        WHERE fetched_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
      [PHOTO_CACHE_TTL_MS]
    );
    if (r.rowCount > 0) console.log(`[Photo Store] expired ${r.rowCount} cached photos`);
    return r.rowCount;
  } catch (err) {
    console.error('[Photo Store] prune failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------
// One statement, and it is EXACT rather than approximately exact, which is the
// whole reason it looks like this.
//
// Every charge in a given UTC day contends on that day's row, so the ON CONFLICT
// DO UPDATE serialises them: Postgres re-reads the latest committed version of
// the conflicting row under its lock before evaluating the DO UPDATE's WHERE, so
// `s.fetches` there is the true current count and not a stale snapshot. The
// month is then that locked value plus the sum of the PRIOR days of the month,
// and prior days are immutable because nothing ever writes a date but today's.
// So both ceilings are checked against numbers that cannot move underneath them,
// and the table can never hold more than the budget allows. There is no
// read-then-act window to lose a race in.
//
// A refusal returns zero rows and charges nothing. All-or-nothing, the same rule
// utils/placesBudget.js states: a partial charge would leave a caller believing
// it may proceed.
const CHARGE_SQL = `
  INSERT INTO places_photo_spend AS s (day, fetches, updated_at)
  SELECT d.day, 1, NOW()
    FROM (SELECT (NOW() AT TIME ZONE 'utc')::date AS day) d
   WHERE (SELECT COALESCE(SUM(p.fetches), 0)
            FROM places_photo_spend p
           WHERE p.day >= DATE_TRUNC('month', d.day)::date
             AND p.day <  d.day) < $1
  ON CONFLICT (day) DO UPDATE
     SET fetches = s.fetches + 1, updated_at = NOW()
   WHERE s.fetches < $2
     AND s.fetches + (SELECT COALESCE(SUM(p.fetches), 0)
                        FROM places_photo_spend p
                       WHERE p.day >= DATE_TRUNC('month', s.day)::date
                         AND p.day <  s.day) < $1
  RETURNING s.fetches`;

// The ceiling being reached is INFORMATION, not an error to swallow, but it is
// also reached once per request until midnight, so the log is throttled to one
// line per hour per reason rather than one per refused photo.
const lastLoggedAt = new Map();
function logOncePerHour(reason, line) {
  const now = Date.now();
  const prev = lastLoggedAt.get(reason) || 0;
  if (now - prev < 60 * 60 * 1000) return;
  lastLoggedAt.set(reason, now);
  console.warn(line);
}

/**
 * Charge one billable Google photo fetch, or refuse.
 *
 * Charge BEFORE the fetch: Google bills a request it received even when we
 * abort it on a timeout, so charging on success undercounts exactly when things
 * are going wrong.
 *
 * FAILS CLOSED. If the ledger cannot be reached, the answer is no. This is a
 * spending control and the alternative is an unmetered Google bill during
 * precisely the incident nobody is watching. It costs less than it looks like:
 * every cached photo still serves without ever consulting this, and a Postgres
 * that cannot answer is a Postgres in which the rest of the app is already down.
 *
 * @returns {Promise<{allowed: boolean, dayFetches: number|null, reason: string|null}>}
 */
async function chargePhotoFetch() {
  let r;
  try {
    r = await pool.query(CHARGE_SQL, [PHOTO_FETCH_BUDGET_MONTH, PHOTO_FETCH_BURST_PER_DAY]);
  } catch (err) {
    console.error('[Photo Budget] ledger unavailable, refusing the fetch:', err.message);
    return { allowed: false, dayFetches: null, reason: 'ledger-unavailable' };
  }

  if (r.rows.length > 0) {
    const dayFetches = Number(r.rows[0].fetches);
    // Say something while it is still possible to act on it. Eighty percent of
    // a month's budget is a number Jayden can decide to raise; a hard stop on
    // the 22nd is one he can only find out about from a blank card.
    if (dayFetches >= Math.floor(PHOTO_FETCH_BURST_PER_DAY * 0.8)) {
      logOncePerHour(
        'day-80',
        `[Photo Budget] ${dayFetches} photo fetches today against a daily brake of `
        + `${PHOTO_FETCH_BURST_PER_DAY}. The brake is 3x the even pace for a `
        + `$${PHOTO_BUDGET_USD_PER_YEAR}/year budget; raise PHOTO_BUDGET_USD_PER_YEAR if this is real traffic.`
      );
    }
    return { allowed: true, dayFetches, reason: null };
  }

  // Refused. Which ceiling it was is worth knowing, so read (non-consuming) and
  // say. A read that itself fails must not turn a clean refusal into a throw.
  let status = null;
  try {
    status = await photoSpendStatus();
  } catch { /* the refusal stands either way */ }

  const monthBound = status && status.monthUsed >= PHOTO_FETCH_BUDGET_MONTH;
  const reason = monthBound ? 'month-budget' : 'day-burst';
  logOncePerHour(
    reason,
    monthBound
      ? `[Photo Budget] MONTH CEILING REACHED. ${status.monthUsed} photo fetches bought this `
        + `month against a ceiling of ${PHOTO_FETCH_BUDGET_MONTH}, which is the `
        + `$${PHOTO_BUDGET_USD_PER_YEAR}/year budget. Already-cached photos keep serving; a venue `
        + `nobody has viewed this month will have no picture until the 1st. Raise `
        + `PHOTO_BUDGET_USD_PER_YEAR to buy more.`
      : `[Photo Budget] DAILY BRAKE REACHED at ${PHOTO_FETCH_BURST_PER_DAY} fetches. `
        + `Cached photos keep serving; new venues resume at 00:00 UTC. This brake exists so one `
        + `day cannot spend the month, so hitting it repeatedly means the annual budget is too low.`
  );
  return { allowed: false, dayFetches: status ? status.dayUsed : null, reason };
}

/**
 * Non-consuming read for the admin cost panel and for tests. Never gate on this
 * and then call Google: read-then-act is not the same thing as chargePhotoFetch's
 * single atomic statement.
 */
async function photoSpendStatus() {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(fetches) FILTER (
         WHERE day >= DATE_TRUNC('month', (NOW() AT TIME ZONE 'utc')::date)::date
       ), 0)::int AS month_used,
       COALESCE(SUM(fetches) FILTER (
         WHERE day = (NOW() AT TIME ZONE 'utc')::date
       ), 0)::int AS day_used
     FROM places_photo_spend`
  );
  const row = r.rows[0] || {};
  const monthUsed = Number(row.month_used) || 0;
  const dayUsed = Number(row.day_used) || 0;
  return {
    monthUsed,
    dayUsed,
    monthRemaining: Math.max(0, PHOTO_FETCH_BUDGET_MONTH - monthUsed),
    dayRemaining: Math.max(0, PHOTO_FETCH_BURST_PER_DAY - dayUsed),
    // What the month has actually cost, with the free tier taken off the top
    // rather than assumed away.
    monthBillable: Math.max(0, monthUsed - PHOTO_FREE_FETCHES_PER_MONTH),
    monthUsd:
      (Math.max(0, monthUsed - PHOTO_FREE_FETCHES_PER_MONTH) * PHOTO_SKU.perThousand) / 1000,
    limits: {
      budgetUsdPerYear: PHOTO_BUDGET_USD_PER_YEAR,
      budgetUsdPerMonth: PHOTO_BUDGET_USD_PER_MONTH,
      fetchesPerMonth: PHOTO_FETCH_BUDGET_MONTH,
      freePerMonth: PHOTO_FREE_FETCHES_PER_MONTH,
      paidPerMonth: PHOTO_PAID_FETCHES_PER_MONTH,
      burstPerDay: PHOTO_FETCH_BURST_PER_DAY,
    },
    // The opposite of the caveat utils/placesBudget.js has to print: this one is
    // in Postgres, so it survives deploys and is shared across instances.
    inMemory: false,
  };
}

module.exports = {
  PHOTO_BUDGET_USD_PER_YEAR,
  PHOTO_BUDGET_USD_PER_MONTH,
  PHOTO_FREE_FETCHES_PER_MONTH,
  PHOTO_PAID_FETCHES_PER_MONTH,
  PHOTO_FETCH_BUDGET_MONTH,
  PHOTO_FETCH_BURST_PER_DAY,
  PHOTO_DAY_BURST_MULTIPLE,
  PHOTO_CACHE_TTL_MS,
  photoCacheKey,
  readStoredPhoto,
  writeStoredPhoto,
  prunePhotoStore,
  chargePhotoFetch,
  photoSpendStatus,
  __test: { CHARGE_SQL },
};
