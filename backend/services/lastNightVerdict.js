// ---------------------------------------------------------------------------
// THE LAST DAY VERDICT — "how did we just do", answered.
//
// WHY THIS FILE EXISTS.
//
// Roost was, until this landed, eleven twelfths a forecasting product, and
// forecasting is the least asked thing operators ask a tool that already holds
// their data. Toast published prompt level usage from 125,000+ locations for
// Q1 2026: the daily briefing was the most frequently USED prompt, the third
// most used named its comparison basis outright ("variances from yesterday and
// the same day last week"), and explicit forecasting came in at ONE PERCENT,
// the smallest category they measured, across a population that had a native
// forecasting surface sitting right there. ROOST-OWNER-INPUT.md carries the
// full citation and the ranking it produced. The compressed finding:
//
//   operators do not want a forecast, they want a verdict on whether last
//   night was normal.
//
// This module is that verdict. It is deliberately the ONE Roost surface that
// is not corpus gated, because it is built from things the venue itself
// produced: its own slider readings (migration 031), the serve log of what
// Flock actually published (032, narrowed to trusted rows by 038), the
// recorded conditions of that day (034), and the venue's own recent history
// for the same weekday. A venue that our corpus has never heard of gets a real
// answer here the first week it uses the slider, and that is the point.
//
// WHAT IT IS NOT.
//
//   * NOT a cause. ADVISOR-WHY-LAYER.md section 0, rule 2, binds every
//     sentence in this file: state covariation or fact, never causation. The
//     banned verbs are enforced at construction by assertNoCausation below, so
//     a causal sentence throws in the suite instead of shipping. "It rained
//     from 8 to 11 and there were no listed events within a mile" is a legal
//     sentence. "That is why you were slow" is not, and cannot be built here.
//   * NOT a model output. The model is never a why driver (its features
//     correlate 0.9638 with the raw Google baseline and its top signal is a
//     collection epoch artifact, MODEL-EPOCH-FINDING.md). What Flock PUBLISHED
//     is a fact about Flock, and appears as exactly that.
//   * NOT arithmetic on somebody else's numbers. Every figure below is the
//     venue's own reading, our own serve log, or a recorded condition. No
//     cohort sentence exists here: that needs five reporting venues in one
//     city and category, and it fires never today (why layer, D5).
//
// THE REFUSAL IS HALF THE PRODUCT. A venue with no reading for the day gets
// told exactly that, plus what one slider move would have bought them. That
// refusal is the honest argument for the slider, and it is the whole reason
// the chip is offered to venues with no history rather than hidden from them.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const advisorFacts = require('./advisorFacts');

// shortDate: every date this file prints is a calendar day out of the
// database, and an owner reading their own verdict sees 'Aug 17' everywhere
// else on the screen. Borrowed from advisorFacts rather than re-implemented so
// the two card families cannot format the same day two ways.
const { makeFact, makeRefusal, externalText, tzOffsetMinutes, shortDate, EVENT_RADIUS_KM } = advisorFacts;

// ─── The threshold, and why it is not smaller ────────────────────────────────
//
// A verdict needs a line, and the line has to survive being said out loud,
// because the failure mode is a product telling an owner they had a bad night
// when what actually happened is that they eyeballed the room three points
// differently than they did last week.
//
// TWO TERMS. A day has to clear BOTH before it is called anything.
//
// 1. A FIXED FLOOR OF 15 POINTS. Not chosen here: it is the D1 firing gate
//    ADVISOR-WHY-LAYER.md section 3 already publishes ("the night is > 15
//    points off their median"), copied rather than re derived so the document
//    and the code cannot drift apart. What makes 15 the right size is what the
//    instrument is: a person estimating how full a room looks, on a 0 to 100
//    scale, typed once or twice in a day, with nothing calibrating it. Flock
//    has never measured how precisely an owner can do that, so the honest
//    posture is a wide floor. For scale on the other side of the ledger,
//    MODEL-EPOCH-FINDING measured rain moving our prediction 0.46 points and a
//    40,000 person event moving it 0.54. A surface that calls a 5 point move a
//    bad day is claiming a resolution nothing in this system has demonstrated.
//
// 2. THE VENUE'S OWN SPREAD. A venue whose Fridays already swing 30 points
//    around their middle has not had an unusual Friday when one lands 20
//    points off it. So the second term is the median absolute deviation of the
//    comparison days themselves: the typical distance between one of those
//    days and their middle. Median rather than mean, because at three to eight
//    days one buyout or one fire alarm sets a standard deviation alight and
//    moves a median barely at all.
//
// threshold = max(15, MAD of the comparison days), and a day is called only
// when it sits STRICTLY further from the baseline than that. A steady venue is
// never graded tighter than 15; a swingy one is graded on its own swing.
// Everything inside the line is ORDINARY, which is a real answer and the one
// most days have coming.
const VERDICT_FLOOR_POINTS = 15;

// How many prior same weekday readings before that comparison is allowed to be
// the baseline. Three is the why layer's own D1 gate. Under three, "your
// Fridays" is one Friday and an opinion.
const MIN_WEEKDAY_DAYS = 3;

// The fallback baseline pools every weekday together, which is a weaker
// question (a Tuesday and a Saturday are not the same room), so it needs more
// days behind it before it may carry a verdict.
const MIN_TRAILING_DAYS = 5;

// How far back the two baselines look. Nine weeks so that eight prior same
// weekday slots are reachable; 28 days for the pooled trailing typical, which
// is the window the why layer uses for a venue's own recent normal.
const HISTORY_WEEKS = 9;
const TRAILING_DAYS = 28;

// The events snapshot job fetches an 8 day forward window per city per day
// (services/nightContext.js), so a night is covered if a successful run landed
// within the 8 days before it. Anything earlier is "we were not watching",
// never "nothing was on": Ticketmaster's Discovery API drops past events, so a
// night nobody snapshotted is a night whose listings are gone from the world.
const EVENT_SNAPSHOT_LOOKBACK_DAYS = 8;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hour12(h) {
  const n = ((Number(h) % 24) + 24) % 24;
  const period = n >= 12 ? 'PM' : 'AM';
  const display = n === 0 ? 12 : n > 12 ? n - 12 : n;
  return `${display} ${period}`;
}

// ─── The causation fence ─────────────────────────────────────────────────────
//
// ADVISOR-WHY-LAYER section 0 names the banned verbs; this is the half a
// machine can enforce. It runs over the words WE wrote and never over a
// vendor's (an event titled "Because The Internet" must not be able to blank a
// venue's card, the same availability reasoning advisorFacts.externalText
// carries). The `say` tagged template below is what keeps those apart: the
// literal chunks are ours and are checked, the interpolated slots are numbers
// and sanitised vendor strings and are not.
const CAUSAL_PHRASES = [
  'because', 'due to', 'caused', 'causes', 'causing', 'explains', 'explained by',
  'thanks to', 'that is why', 'which is why', 'the reason', 'led to', 'leads to',
  'resulted in', 'results in', 'blame', 'responsible for', 'on account of',
  'as a result', 'drove your', 'drove the', 'hurt your', 'helped your',
];

function assertNoCausation(text, where) {
  const lower = String(text).toLowerCase();
  for (const phrase of CAUSAL_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(`last day verdict copy claims a cause (${where}): contains "${phrase}"`);
    }
  }
}

/**
 * Tagged template for every owner-visible sentence this module emits. The
 * literal parts are our copy and get both fences (causation and SLOP-AUDIT);
 * the slots are numbers and already-sanitised vendor text and get neither.
 */
function say(strings, ...slots) {
  const ourWords = strings.join(' ');
  assertNoCausation(ourWords, 'verdict copy');
  advisorFacts.assertCleanCopy(ourWords, 'verdict copy');
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < slots.length) out += String(slots[i]);
  });
  return out.replace(/\s+/g, ' ').trim();
}

// ─── The arithmetic ──────────────────────────────────────────────────────────

function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Median absolute deviation: the typical distance from the middle. */
function medianAbsoluteDeviation(values, mid) {
  const centre = mid === undefined ? median(values) : mid;
  if (centre === null) return null;
  return median(values.map((v) => Math.abs(v - centre)));
}

/**
 * The verdict itself, pure and exported so the suite can grade it directly.
 *
 * @param {number} reading   the day's highest owner reading
 * @param {number[]} baselineDays  the comparison days' highest readings
 * @returns {{verdict:'above'|'below'|'ordinary', baseline:number, delta:number,
 *            threshold:number, spread:number, n:number}|null}
 */
function callTheDay(reading, baselineDays) {
  const days = (Array.isArray(baselineDays) ? baselineDays : []).filter((v) => Number.isFinite(v));
  if (!Number.isFinite(reading) || !days.length) return null;
  const baseline = median(days);
  const spread = medianAbsoluteDeviation(days, baseline) || 0;
  // Both terms, and the wider one wins. Rounded because every number that
  // reaches an owner on this surface is a whole point on a 0 to 100 slider.
  const threshold = Math.max(VERDICT_FLOOR_POINTS, Math.round(spread));
  const delta = Math.round(reading - Math.round(baseline));
  const verdict = Math.abs(delta) > threshold ? (delta > 0 ? 'above' : 'below') : 'ordinary';
  return { verdict, baseline: Math.round(baseline), delta, threshold, spread: Math.round(spread), n: days.length };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The venue's own reading history, one entry per venue-local day. Day level,
 * not hour level, on purpose: the slider is capped at 48 posts a day and the
 * realistic count is one or two, so an hourly baseline would be a single
 * reading wearing a distribution. MAX is the day's HIGHEST reading, and every
 * sentence below says so.
 */
async function readingHistory(placeId, tz) {
  const { rows } = await pool.query(
    `SELECT (created_at AT TIME ZONE $2)::date AS day,
            MAX(busy_percent)::int AS peak_reading,
            COUNT(*)::int AS readings,
            bool_or(diverged) AS diverged
       FROM venue_owner_reports
      WHERE google_place_id = $1 AND retracted = false
        AND created_at >= NOW() - INTERVAL '${HISTORY_WEEKS} weeks'
      GROUP BY 1 ORDER BY 1 DESC`,
    [placeId, tz]
  );
  return rows
    .map((r) => ({
      date: String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day).slice(0, 10),
      peak: Number(r.peak_reading),
      readings: Number(r.readings),
      diverged: r.diverged === true,
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.peak));
}

/**
 * What Flock PUBLISHED that day, TRUSTED ROWS ONLY.
 *
 * `source = 'detail'` is an allowlist, the same one routes/feedback.js spells
 * out and migration 038 wrote the column for. POST /api/crowd/batch scores
 * venues out of a client assembled body (rating, review count and
 * utcOffsetMinutes included), so a caller can post a real bar at a 4am offset,
 * have the server publish ~5 and record it, and then read that number back
 * here as "what Flock told people". 'detail_client_clock' is the detail card
 * scored on the CALLER's clock when Google gave us no offset, which is the same
 * problem one step smaller. NULL is every row written before 038 and is refused
 * by construction, because NULL = 'detail' is NULL and never true.
 *
 * The cost of the allowlist is coverage, and it is worth paying: a verdict is a
 * comparison, and a comparison against a number an attacker chose is worse than
 * no comparison at all.
 */
async function servedHistory(placeId, tz) {
  const { rows } = await pool.query(
    `SELECT (served_at AT TIME ZONE $2)::date AS day,
            COUNT(*)::int AS serves,
            ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY score))::int AS median_score
       FROM served_predictions
      WHERE venue_place_id = $1
        AND served_at >= NOW() - INTERVAL '${HISTORY_WEEKS} weeks'
        AND source = 'detail'
      GROUP BY 1 ORDER BY 1 DESC`,
    [placeId, tz]
  );
  return rows
    .map((r) => ({
      date: String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day).slice(0, 10),
      serves: Number(r.serves),
      medianScore: r.median_score != null ? Number(r.median_score) : null,
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

/** Recorded city weather for that day (migration 034). Empty means we were not watching. */
async function recordedWeather(placeId, date) {
  const { rows } = await pool.query(
    `SELECT nc.hour, nc.temp, nc.conditions, nc.is_raining
       FROM night_context nc
       JOIN ml_venues v ON v.city = nc.city
      WHERE v.google_place_id = $1 AND nc.night = $2
      ORDER BY nc.hour ASC`,
    [placeId, date]
  );
  return rows.map((r) => ({
    hour: Number(r.hour),
    temp: r.temp != null ? Number(r.temp) : null,
    conditions: r.conditions,
    raining: r.is_raining === true,
  }));
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Listed events near the venue that day, plus whether we were watching at all. */
async function recordedEvents(placeId, date, lat, lng) {
  const watched = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM night_context_runs r
         JOIN ml_venues v ON v.city = r.city
        WHERE v.google_place_id = $1 AND r.kind = 'events' AND r.ok = true
          AND r.night BETWEEN $2::date - $3::int AND $2::date
     ) AS watched`,
    [placeId, date, EVENT_SNAPSHOT_LOOKBACK_DAYS]
  );
  if (!watched.rows[0] || watched.rows[0].watched !== true) return { watched: false, events: [] };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { watched: true, events: [] };

  // Bounding box in SQL, exact distance in JS: the split mlPredictor's
  // neighbour path already uses, so the index does the cheap work.
  const { rows } = await pool.query(
    `SELECT name, event_type, venue_lat, venue_lng
       FROM ml_events
      WHERE event_date = $1
        AND venue_lat BETWEEN $2::numeric - 0.015 AND $2::numeric + 0.015
        AND venue_lng BETWEEN $3::numeric - 0.02 AND $3::numeric + 0.02`,
    [date, lat, lng]
  );
  const events = rows
    .map((r) => ({
      name: externalText(r.name),
      type: externalText(r.event_type, { max: 24 }),
      km: haversineKm(lat, lng, Number(r.venue_lat), Number(r.venue_lng)),
    }))
    .filter((e) => Number.isFinite(e.km) && e.km <= EVENT_RADIUS_KM)
    .sort((a, b) => a.km - b.km);
  return { watched: true, events };
}

// ─── The refusal, which is the argument for the slider ───────────────────────
//
// Written at length on purpose. This is the screen most venues see first, it
// is the only place in Roost where the missing data is something the owner can
// supply in one tap, and ROOST-OWNER-INPUT section 3 is blunt about the fill
// rates to expect: standing configuration gets filled once, per occurrence
// context mostly does not (Yext, 2.4 million locations: 80% keep standing
// hours, 8.6% set a holiday). So this makes the case once, states exactly what
// one reading buys, and does not nag. No streak, no badge, no completion
// meter, and it never appears beside weather and events dressed as an answer:
// when there is no reading, this refusal is the WHOLE output, because a
// conditions report about a day nobody measured is the shape the why layer
// bans outright.
function noReadingRefusal({ weekday, date, everPosted }) {
  return makeRefusal({
    id: `refuse_no_reading_${date}`,
    reason: say`You did not post a reading on ${weekday} ${shortDate(date)}, so there is no measurement of your room that day for us to grade. We can see what Flock published and what the weather did, and neither of those is a reading of how full you were.`,
    whatWouldUnlock: everPosted
      ? say`One move of the busy slider at your busiest hour. A single reading puts that day next to what Flock published for you, and next to your own recent ${weekday}s, which is the only baseline in Flock that is yours rather than your category's.`
      : say`One move of the busy slider at your busiest hour. The first reading gets compared against what Flock published for you that day. After three more ${weekday}s it also gets compared against your own ${weekday}s, and that is a baseline no vendor curve can give you.`,
  });
}

// ─── The builder ─────────────────────────────────────────────────────────────

/**
 * Card 0 / intent `last_night_verdict`: how the venue's most recent complete
 * day went, against its own numbers.
 *
 * Order of output is the why layer's composition rule, strongest first: the
 * measurement of the day, the baseline it is being judged against, the verdict,
 * what Flock published, then conditions LAST and clearly labelled as
 * conditions. Not corpus gated, deliberately.
 */
async function buildLastDayVerdict(ctx, { now = new Date() } = {}) {
  const p = ctx.profile;
  const tz = (ctx.mlVenue && ctx.mlVenue.timezone) || 'UTC';
  const lat = ctx.mlVenue && ctx.mlVenue.latitude != null ? Number(ctx.mlVenue.latitude) : NaN;
  const lng = ctx.mlVenue && ctx.mlVenue.longitude != null ? Number(ctx.mlVenue.longitude) : NaN;

  // The venue's own yesterday. The most recent COMPLETE day on its wall clock,
  // so a 1am read of the dashboard still grades the day that just ended rather
  // than the one that has barely started.
  const offset = tzOffsetMinutes(tz, now);
  const shifted = new Date(now.getTime() + (offset === null ? 0 : offset) * 60000);
  const lastDay = new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - 1
  ));
  const date = lastDay.toISOString().slice(0, 10);
  const dow = lastDay.getUTCDay();
  const weekday = WEEKDAY_NAMES[dow];

  let history = [];
  try {
    history = await readingHistory(p.google_place_id, tz);
  } catch (err) {
    console.error('[LastDayVerdict] reading history unavailable:', err.message);
    return [makeRefusal({
      id: `refuse_verdict_unavailable_${date}`,
      reason: say`We could not read your own reading history just now, so there is nothing to compare ${weekday} against.`,
      whatWouldUnlock: say`This one is on us and it is usually short lived. Nothing is missing on your side.`,
    })];
  }

  const today = history.find((h) => h.date === date) || null;
  if (!today) {
    return [noReadingRefusal({ weekday, date, everPosted: history.length > 0 })];
  }

  const out = [];

  // 1. The measurement of the day. The owner's own testimony, restated.
  out.push(makeFact({
    id: `owner_reading_${date}`,
    value: { date, weekday, peakReading: today.peak, readings: today.readings, diverged: today.diverged },
    source: 'owner_report',
    asOf: date,
    label: say`Your highest reading on ${weekday} ${shortDate(date)} was ${today.peak}, from ${today.readings} ${today.readings === 1 ? 'reading' : 'readings'}.`,
    note: today.diverged
      ? say`A reading that day was flagged as diverging from what people in the room reported, so it is the softer of the two numbers.`
      : undefined,
  }));

  // 2. The baseline. Same weekday first (a Friday against Fridays), the pooled
  //    trailing typical only as a fallback, and each one names its own n and
  //    window so the sentence can be checked.
  const priors = history.filter((h) => h.date !== date);
  const sameWeekday = priors.filter((h) => new Date(`${h.date}T12:00:00Z`).getUTCDay() === dow);
  const cutoff = new Date(lastDay.getTime() - TRAILING_DAYS * 86400000).toISOString().slice(0, 10);
  const trailing = priors.filter((h) => h.date >= cutoff);

  let baselineKind = null;
  let baselineDays = [];
  let baselineFactId = null;

  if (sameWeekday.length >= MIN_WEEKDAY_DAYS) {
    baselineKind = 'same_weekday';
    baselineDays = sameWeekday.map((h) => h.peak);
    baselineFactId = `owner_weekday_baseline_${date}`;
    const mid = Math.round(median(baselineDays));
    out.push(makeFact({
      id: baselineFactId,
      value: {
        weekday, days: sameWeekday.length, middleReading: mid,
        lowest: Math.min(...baselineDays), highest: Math.max(...baselineDays),
        windowWeeks: HISTORY_WEEKS,
      },
      source: 'owner_report',
      asOf: date,
      label: say`Your ${sameWeekday.length} other ${weekday}s in the last ${HISTORY_WEEKS} weeks had a middle highest reading of ${mid}, running from ${Math.min(...baselineDays)} to ${Math.max(...baselineDays)}. Your own numbers, on your own ${weekday}s.`,
    }));
  } else if (trailing.length >= MIN_TRAILING_DAYS) {
    baselineKind = 'trailing_typical';
    baselineDays = trailing.map((h) => h.peak);
    baselineFactId = `owner_trailing_baseline_${date}`;
    const mid = Math.round(median(baselineDays));
    out.push(makeFact({
      id: baselineFactId,
      value: {
        days: trailing.length, middleReading: mid,
        lowest: Math.min(...baselineDays), highest: Math.max(...baselineDays),
        windowDays: TRAILING_DAYS,
      },
      source: 'owner_report',
      asOf: date,
      label: say`Across the ${trailing.length} days you posted a reading on in the last ${TRAILING_DAYS}, your middle highest reading was ${mid}, running from ${Math.min(...baselineDays)} to ${Math.max(...baselineDays)}. That pools every weekday together, so it is a rougher yardstick than your own ${weekday}s would be.`,
    }));
  }

  // The second yardstick, when the weekday one is already carrying the verdict.
  // The owner gets both: how the day sat against the same weekday, and how it
  // sat against their recent run of days generally. It is stated, never scored:
  // one day cannot have two verdicts, and the same-weekday comparison is the
  // better question, so this line is context under it rather than a rival.
  if (baselineKind === 'same_weekday' && trailing.length >= MIN_TRAILING_DAYS) {
    const pooled = trailing.map((h) => h.peak);
    const mid = Math.round(median(pooled));
    const gap = Math.abs(Math.round(today.peak - mid));
    out.push(makeFact({
      id: `owner_trailing_baseline_${date}`,
      value: { days: trailing.length, middleReading: mid, windowDays: TRAILING_DAYS, gap },
      source: 'owner_report',
      asOf: date,
      label: gap === 0
        ? say`Against all ${trailing.length} days you posted on in the last ${TRAILING_DAYS}, not just ${weekday}s, the middle was ${mid}, which is exactly where this day landed.`
        : say`Against all ${trailing.length} days you posted on in the last ${TRAILING_DAYS}, not just ${weekday}s, the middle was ${mid}, so this day sat ${gap} ${gap === 1 ? 'point' : 'points'} ${today.peak > mid ? 'over' : 'under'} that. A rougher yardstick, kept here as a second look rather than a second verdict.`,
    }));
  }

  // 3. The verdict, or an honest statement that there is not yet a baseline to
  //    give one against. Arithmetic, naming the facts it was computed from.
  const call = baselineKind ? callTheDay(today.peak, baselineDays) : null;
  if (!call) {
    out.push(makeRefusal({
      id: `refuse_no_baseline_${date}`,
      reason: say`We have your reading for ${weekday}, but not enough of your own history to say whether it was normal. That needs ${MIN_WEEKDAY_DAYS} earlier ${weekday}s, or ${MIN_TRAILING_DAYS} days of readings in the last ${TRAILING_DAYS}.`,
      whatWouldUnlock: say`More slider readings, on the days you already work. There is no shortcut through our corpus for this one: a verdict on your ${weekday} can only be built from your ${weekday}s.`,
    }));
  } else {
    const gap = Math.abs(call.delta);
    const dir = call.delta > 0 ? 'above' : 'below';
    const basis = baselineKind === 'same_weekday'
      ? say`your own ${weekday}s`
      : say`the days you have been posting on`;
    let sentence;
    if (call.verdict === 'ordinary') {
      sentence = gap === 0
        ? say`${weekday} landed level with ${basis} (middle ${call.baseline}, across ${call.n} days). That is an ordinary ${weekday} by your own numbers.`
        : say`${weekday} came in ${gap} ${gap === 1 ? 'point' : 'points'} ${dir} ${basis} (middle ${call.baseline}, across ${call.n} days). We call a day unusual only past ${call.threshold} points, so this reads as an ordinary ${weekday}.`;
    } else {
      sentence = say`${weekday} came in ${gap} points ${dir} ${basis} (middle ${call.baseline}, across ${call.n} days). That clears the ${call.threshold} point mark we need before calling a day anything, so by your own numbers it was ${dir === 'above' ? 'a busier' : 'a quieter'} ${weekday} than usual.`;
    }
    out.push(makeFact({
      id: `last_day_verdict_${date}`,
      value: {
        date, weekday, verdict: call.verdict, reading: today.peak,
        baseline: call.baseline, baselineKind, comparisonDays: call.n,
        delta: call.delta, threshold: call.threshold, spread: call.spread,
        floorPoints: VERDICT_FLOOR_POINTS,
      },
      source: 'arithmetic',
      from: [`owner_reading_${date}`, baselineFactId],
      asOf: date,
      label: sentence,
      note: say`The ${call.threshold} point mark is the wider of a fixed ${VERDICT_FLOOR_POINTS} points and how far your own comparison days typically sit from their middle. Anything inside it is ordinary, which is most days.`,
    }));
  }

  // 4. What Flock published that day. A fact about Flock, never about the room,
  //    and only from serve rows whose inputs were ours.
  let served = [];
  try {
    served = await servedHistory(p.google_place_id, tz);
  } catch (err) {
    console.error('[LastDayVerdict] serve log unavailable:', err.message);
  }
  const servedToday = served.find((s) => s.date === date) || null;
  if (servedToday && servedToday.medianScore != null) {
    out.push(makeFact({
      id: `served_trusted_${date}`,
      value: { date, serves: servedToday.serves, medianScore: servedToday.medianScore },
      source: 'served_prediction',
      asOf: date,
      note: 'What Flock served to people who looked at your venue, not a measurement of your room. Counted from the venue card only, which is the one path where we chose every input.',
      label: say`Flock showed a middle estimate of ${servedToday.medianScore} for your venue that day, across ${servedToday.serves} ${servedToday.serves === 1 ? 'view' : 'views'}.`,
    }));
    const gap = Math.round(servedToday.medianScore - today.peak);
    out.push(makeFact({
      id: `served_vs_reading_${date}`,
      value: { date, servedMedian: servedToday.medianScore, yourPeak: today.peak, gap },
      source: 'arithmetic',
      from: [`served_trusted_${date}`, `owner_reading_${date}`],
      asOf: date,
      label: gap === 0
        ? say`What we published and what you read landed on the same number that day.`
        : say`What we published sat ${Math.abs(gap)} ${Math.abs(gap) === 1 ? 'point' : 'points'} ${gap > 0 ? 'above' : 'below'} your own highest reading. That is the distance between our estimate and your reading, and it says nothing on its own about which of the two the room agreed with.`,
    }));
  } else {
    out.push(makeRefusal({
      id: `refuse_no_served_${date}`,
      reason: say`Nobody opened your venue card in Flock on ${weekday}, so we published no estimate to compare your reading against.`,
      whatWouldUnlock: say`This fills in on its own as people look at your venue. Nothing is missing on your side.`,
    }));
  }

  // 5. Conditions, last and labelled. Stated, never blamed: this whole block is
  //    differencing, and it appears only because step 1 established that the day
  //    was actually measured (why layer section 2, composition rule).
  let weather = [];
  try {
    weather = await recordedWeather(p.google_place_id, date);
  } catch (err) {
    console.error('[LastDayVerdict] recorded weather unavailable:', err.message);
  }
  if (weather.length) {
    const rainHours = weather.filter((w) => w.raining).map((w) => w.hour);
    const temps = weather.map((w) => w.temp).filter((t) => Number.isFinite(t));
    // Built as its own sentence and interpolated with a space in the template:
    // `say` collapses and trims whitespace, so a leading space would be eaten.
    const tempSentence = temps.length
      ? say`Temperatures ran ${Math.round(Math.min(...temps))} F to ${Math.round(Math.max(...temps))} F.`
      : '';
    out.push(makeFact({
      id: `weather_recorded_${date}`,
      value: {
        date,
        rainHours,
        lowF: temps.length ? Math.round(Math.min(...temps)) : null,
        highF: temps.length ? Math.round(Math.max(...temps)) : null,
        hoursRecorded: weather.length,
      },
      source: 'weather',
      asOf: date,
      note: 'Context only. Weather is never offered as the explanation of a number.',
      label: rainHours.length
        ? say`It rained in your city from ${hour12(Math.min(...rainHours))} to ${hour12(Math.max(...rainHours) + 1)} that day. ${tempSentence}`
        : say`No rain was recorded in your city that day. ${tempSentence}`,
    }));
  } else {
    out.push(makeRefusal({
      id: `refuse_no_weather_${date}`,
      reason: say`We were not recording city weather on ${shortDate(date)}, so we cannot say what it did.`,
      whatWouldUnlock: say`Nothing on your side. We record conditions hourly from the day we start watching a city, and we cannot go back for the ones before that.`,
    }));
  }

  let street = { watched: false, events: [] };
  try {
    street = await recordedEvents(p.google_place_id, date, lat, lng);
  } catch (err) {
    console.error('[LastDayVerdict] event snapshot unavailable:', err.message);
  }
  if (!street.watched) {
    out.push(makeRefusal({
      id: `refuse_no_event_snapshot_${date}`,
      reason: say`We were not snapshotting event listings for your city on ${shortDate(date)}, so we cannot tell you what was on near you.`,
      whatWouldUnlock: say`Nothing on your side. Ticketmaster drops past events, so days before we started watching stay blank and every day from here on is covered.`,
    }));
  } else if (street.events.length) {
    const nearest = street.events[0];
    const km = Math.round(nearest.km * 10) / 10;
    out.push(makeFact({
      id: `event_recorded_${date}`,
      value: {
        date, listedEvents: street.events.length,
        nearestName: nearest.name || 'Listed event',
        nearestType: nearest.type, nearestDistanceKm: km,
      },
      source: 'events',
      asOf: date,
      note: 'A ticketed listing near you. Whether a day with an event on feeds your room or drains it is not something we can measure yet.',
      label: street.events.length === 1
        ? say`One ticketed event was listed within about a kilometer of you that day, ${nearest.name || 'an unnamed listing'}, about ${km} km away.`
        : say`${street.events.length} ticketed events were listed within about a kilometer of you that day. The nearest was ${nearest.name || 'an unnamed listing'}, about ${km} km away.`,
    }));
  } else {
    out.push(makeFact({
      id: `no_listed_events_${date}`,
      value: { date, listedEventsWithinRadius: 0, radiusKm: EVENT_RADIUS_KM },
      source: 'events',
      asOf: date,
      label: say`No ticketed events were listed within about a kilometer of you that day. That covers Ticketmaster listings only, not everything happening on your street.`,
    }));
  }

  return out;
}

module.exports = {
  buildLastDayVerdict,
  // The arithmetic and the fences, exported for the standing test.
  callTheDay,
  median,
  medianAbsoluteDeviation,
  assertNoCausation,
  CAUSAL_PHRASES,
  VERDICT_FLOOR_POINTS,
  MIN_WEEKDAY_DAYS,
  MIN_TRAILING_DAYS,
  HISTORY_WEEKS,
  TRAILING_DAYS,
  noReadingRefusal,
};
