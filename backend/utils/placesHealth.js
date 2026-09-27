// ---------------------------------------------------------------------------
// PLACES HEALTH — the alarm for an outage nobody is paying for
// ---------------------------------------------------------------------------
// utils/placesBudget.js watches what Flock SPENDS on Google Places. It cannot
// see the failure this file exists for, because that failure costs nothing:
// Google refuses every call, the budget counter barely moves, and the money
// watch stays quiet all the way through a total outage.
//
// WHAT ACTUALLY HAPPENED (2026-09-01 to 2026-09-05). Google Places answered
// HTTP 429 for five days. Venue pins and photos were dead the entire time. The
// only thing that noticed was a human, by eye, on day five. Railway's log had
// been printing
//
//     [PublicDemo] Places search failed: HTTP 429
//
// over and over for the whole outage. Every console.error in the app is a line
// nobody reads until somebody already suspects a problem, so the information
// existed from hour one and reached a person on day five.
//
// ---------------------------------------------------------------------------
// WHY THIS IS FREE, AND WHY THE OBVIOUS OBJECTION IS WRONG
// ---------------------------------------------------------------------------
// The tempting fix is an active probe: call Places on a timer and alert when
// the call fails. It works, and it costs about $1/month at one call a day,
// which was the version proposed first and correctly rejected.
//
// The objection to a passive counter goes: Flock has almost no traffic, so
// "no successful Places calls today" cannot be told apart from "nobody opened
// the app", and a passive watcher would sleep through the outage.
//
// That objection conflates two states that are in fact distinct:
//
//   * ZERO calls attempted        -> nobody used it. Silence is CORRECT.
//   * Calls attempted, all failed -> outage. ALARM.
//
// The second state needs no traffic of our own to detect. It needs only that
// SOMEBODY touched Places, and the moment anybody does, the detector arms
// itself. During the September outage the log above proves the demo path was
// being called throughout, so this counter would have crossed its threshold on
// day one and mailed once. The five silent days were not a shortage of signal.
// They were a shortage of counting.
//
// A window in which literally nothing calls Places is a window in which the
// outage is also not hurting anyone, and the first person through the door
// arms the alarm. That is the honest trade, and it is why this file buys
// nothing from Google.
//
// ---------------------------------------------------------------------------
// IN-MEMORY, with the same caveat utils/placesBudget.js prints
// ---------------------------------------------------------------------------
//   * State lives in this process's heap, so a Railway deploy or crash resets
//     it. A deploy mid-outage clears the streak and the next few failures
//     rebuild it. Since the alarm speaks once per UTC day, the cost of a reset
//     is at most a delayed alert, never a missed outage that is still ongoing.
//   * It divides by the instance count. At numReplicas: 1 that is exact; the
//     deployment notes say why a second instance needs Redis first.
//   * Every mutation here is synchronous, and Node runs one turn at a time, so
//     two concurrent requests cannot interleave inside the counter.
//
// IT REPORTS, IT NEVER REFUSES. Nothing in this file can make a call fail, gate
// a request, or throw into a caller. record() is wrapped by its callers' own
// try/catch discipline and does nothing that can throw in the first place. A
// watchdog that can break the thing it watches is worse than no watchdog, which
// is the rule the money watch in server.js already states.

// A single failure is a blip: one timeout, one transient 5xx, one aborted
// request on a slow night. An outage is a RUN of them with no success in
// between. Three is the smallest number that cannot be one bad packet, and at
// Flock's request rate it is still reached within seconds of a real outage.
const FAILURE_STREAK_ALARM = 3;

// Ring buffer of recent failure reasons, so the alert can say WHAT broke
// rather than only that something did. Small on purpose: this is a hint for
// the person reading the alert, not a log.
const MAX_REASONS = 5;

// ---------------------------------------------------------------------------
// TWO LEGS, BECAUSE GOOGLE METERS PHOTOS SEPARATELY.
// ---------------------------------------------------------------------------
// Place Photos has its own per-day quota on the Google project, apart from
// search and details, and it was one of the four clamped by hand on
// 2026-08-21. So photos can be refused while every search succeeds. On one
// shared streak that outage is invisible twice over: the photo proxy never
// recorded anything, and even if it had, the search calls still working
// between its failures would reset the count every time. The photo proxy
// (routes/venueSearch.js) records to the 'photos' leg; everything else is the
// 'search' leg, which is what the top level of placesHealthStatus() has always
// described.
const LEGS = ['search', 'photos'];

function freshLeg() {
  return {
    consecutiveFailures: 0,
    totalOk: 0,
    totalFailed: 0,
    lastOkAt: null,
    lastFailAt: null,
    // The moment the CURRENT unbroken run of failures began. Null whenever the
    // streak is zero. This is the "since" in the alert sentence, and it is the
    // number that turns "Places is failing" into "Places has been failing for
    // four hours", which is the difference between a shrug and an action.
    failingSince: null,
    reasons: [],
  };
}

const legs = { search: freshLeg(), photos: freshLeg() };

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Record the outcome of one Google Places call.
 *
 * Call it at the point the outcome is already known — every call site in this
 * codebase that talks to Places already logs its own failure, so this goes
 * beside that console.error rather than anywhere new.
 *
 * @param {boolean} ok   true if Google answered usefully
 * @param {string} [reason] short tag for a failure ('HTTP 429', 'unreachable',
 *                          'error body', 'malformed body'). Ignored when ok.
 * @param {object} [opts] { leg: 'photos' } for the photo proxy; anything else
 *                        is the search leg.
 */
function recordPlacesResult(ok, reason, opts) {
  const state = legs[opts && LEGS.includes(opts.leg) ? opts.leg : 'search'];
  const now = Date.now();
  if (ok) {
    state.consecutiveFailures = 0;
    state.failingSince = null;
    state.totalOk += 1;
    state.lastOkAt = now;
    return;
  }
  state.consecutiveFailures += 1;
  state.totalFailed += 1;
  state.lastFailAt = now;
  if (state.failingSince === null) state.failingSince = now;
  if (reason) {
    // Newest first, deduped: an outage repeats one reason thousands of times
    // and a list of five identical strings tells the reader nothing.
    state.reasons = [reason, ...state.reasons.filter((r) => r !== reason)].slice(0, MAX_REASONS);
  }
}

/**
 * Is this Place Details failure Google saying the place id names nothing?
 *
 * GOOGLE ANSWERING "NO SUCH PLACE" IS GOOGLE WORKING. Place ids retire: a venue
 * closes, moves or is merged, and a flock that saved it weeks ago still holds
 * the old id. Asking about it gets NOT_FOUND, which is a precise, healthy
 * answer, and routes/publicCrowd.js already records it as one. Counted as a
 * failure, one tap on a stale saved venue was three recorded failures in a row
 * (the crowd card's request is retried twice on a 502), which is
 * FAILURE_STREAK_ALARM at Flock's traffic, and the operator was mailed "Google
 * Places is down" while it was up.
 *
 * AN ID THAT DOES NOT DECODE IS THE SAME ANSWER, BUT ONLY WHEN GOOGLE SAYS SO.
 * A place id that was never real (Birdie's model can invent one, and a
 * truncated id is another) comes back 400 INVALID_ARGUMENT rather than
 * NOT_FOUND, and three of those in a row mailed "Places is down" just the same.
 * But Google also answers a dead or wrong API key with 400 INVALID_ARGUMENT
 * ("API key not valid"), and a key problem is one of the outages this alarm
 * exists to report. So INVALID_ARGUMENT counts here only when its message names
 * a place id and no ErrorInfo detail names an API key reason (API_KEY_INVALID,
 * API_KEY_EXPIRED). Every other INVALID_ARGUMENT keeps counting as a failure,
 * and so would this one if Google ever reworded it: the miss is the old
 * behaviour, never a silenced outage.
 *
 * @param {number} httpStatus the HTTP status the answer came with (0 if unknown)
 * @param {object} error      Google's `error` object from the body
 * @returns {boolean}
 */
function isPlaceNotFoundAnswer(httpStatus, error) {
  if (!error || typeof error !== 'object') return false;
  if (error.status === 'NOT_FOUND') return true;
  if (Number(error.code) === 404 || httpStatus === 404) return true;
  return isUnusablePlaceIdAnswer(error);
}

// "Not a valid Place ID", "The provided Place ID is no longer valid": Google's
// wording names the id. "API key not valid" does not, and neither does a field
// mask complaint about "places.id" (the "s" sits where "id" would have to be).
const NAMES_PLACE_ID_RE = /\bplace[\s_]?ids?\b/i;

function namesApiKeyProblem(error) {
  const details = Array.isArray(error.details) ? error.details : [];
  return details.some((d) => d && typeof d === 'object'
    && typeof d.reason === 'string' && d.reason.startsWith('API_KEY_'));
}

function isUnusablePlaceIdAnswer(error) {
  if (error.status !== 'INVALID_ARGUMENT') return false;
  if (namesApiKeyProblem(error)) return false;
  return NAMES_PLACE_ID_RE.test(String(error.message || ''));
}

function legStatus(state, now) {
  return {
    day: utcDay(now),
    consecutiveFailures: state.consecutiveFailures,
    threshold: FAILURE_STREAK_ALARM,
    unhealthy: state.consecutiveFailures >= FAILURE_STREAK_ALARM,
    totalOk: state.totalOk,
    totalFailed: state.totalFailed,
    lastOkAt: state.lastOkAt,
    lastFailAt: state.lastFailAt,
    failingSince: state.failingSince,
    failingForMs: state.failingSince === null ? 0 : now - state.failingSince,
    reasons: [...state.reasons],
  };
}

/**
 * Non-consuming read, shaped like placesBudgetStatus() and visionBudgetStatus()
 * so server.js's money watch can treat it as one more leg.
 *
 * The top level is the search leg, as it always was; `photos` is the photo
 * proxy's leg in the same shape.
 *
 * `day` is present for the same reason those two carry one: sayOnceToday()
 * treats a missing day as "already spoke today" and would silence the leg
 * forever. See its comment in server.js.
 */
function placesHealthStatus(now = Date.now()) {
  return { ...legStatus(legs.search, now), photos: legStatus(legs.photos, now) };
}

/** Test seam. Mirrors __resetPlacesBudget() in utils/placesBudget.js. */
function __resetPlacesHealth() {
  legs.search = freshLeg();
  legs.photos = freshLeg();
}

module.exports = {
  recordPlacesResult,
  isPlaceNotFoundAnswer,
  placesHealthStatus,
  __resetPlacesHealth,
  FAILURE_STREAK_ALARM,
};
