// ---------------------------------------------------------------------------
// What an unverified venue owner is told, written ONCE.
//
// Three surfaces on one screen used to serve the same sentence for this
// condition ("Verify your venue to unlock this. We check ownership before
// turning on forecasts."), and the sentence was an instruction with no path:
// nothing anywhere started a verification (TestFlight, 2026-08-21). The path
// exists now, POST /api/venue-profile/request-verification, so the copy names
// it, and it says a different thing once the request is in, because telling an
// owner to request what they have already requested is the same dead end
// wearing a nicer sentence.
//
// The split is decided by venue_profiles.verification_requested_at, which
// migration 047 adds and the request route sets. Callers hand this module the
// profile (or venue-context) row they already hold; a row read before the
// column existed, or a caller that never selected it, reads as "not requested",
// which is the direction that still offers a path rather than claiming
// progress nobody made.
//
// DESIGN-STANDARD rules apply to every string here: no em dashes, no class words,
// and no promise the code does not keep. In particular no turnaround time is
// promised, because verification is one person checking by hand and nothing
// enforces a clock on it.
// ---------------------------------------------------------------------------

// THE FORECAST PAIR IS FOR ROOST SURFACES ONLY. "Forecasts turn on once that
// clears" is true for a venue that holds Roost (every venue while
// VENUE_BILLING_ENABLED is off), and false for a free venue once it is on: that
// venue verifies and still gets no forecast. So unverifiedReason is served only
// behind requirePro (the forecast, the strip and the weekly summary in
// routes/venueDashboard.js, and every route in routes/advisor.js), where a free
// venue is refused by the plan before it can read this. A surface every plan
// reaches uses the live-number pair below.
// __tests__/venueVerificationRequest.test.js holds the routes to that.
const REASON_NOT_REQUESTED = 'Not verified yet. Request verification and we confirm you own this venue by hand. Forecasts turn on once that clears.';
const REASON_PENDING = 'Verification requested. We confirm ownership by hand, and forecasts turn on once that clears. Nothing more is needed from you.';

/**
 * The sentence served wherever a Roost feature is withheld for lack of
 * verification (see the note above for why only there).
 * @param {object|null} profile  a venue_profiles row (or ctx carrying
 *                               verification_requested_at)
 */
function unverifiedReason(profile) {
  return profile && profile.verification_requested_at ? REASON_PENDING : REASON_NOT_REQUESTED;
}

// The live number gets its own pair, on its write (the 403) and on its read
// (GET /busy-now, the card every plan sees): the withheld thing there is the
// live number, not a forecast, and it is free on every plan, so this pair is
// true for every venue whatever it pays.
const LIVE_NUMBER_NOT_REQUESTED = 'Setting a live number needs a verified venue. Request verification and we confirm ownership by hand.';
const LIVE_NUMBER_PENDING = 'Your verification request is in. We confirm ownership by hand, and setting a live number turns on once that clears.';

function liveNumberRefusal(profile) {
  return profile && profile.verification_requested_at ? LIVE_NUMBER_PENDING : LIVE_NUMBER_NOT_REQUESTED;
}

// Every user-visible string this module can emit, for the standing design review.
function __copyStrings() {
  return [REASON_NOT_REQUESTED, REASON_PENDING, LIVE_NUMBER_NOT_REQUESTED, LIVE_NUMBER_PENDING];
}

module.exports = {
  unverifiedReason,
  liveNumberRefusal,
  REASON_NOT_REQUESTED,
  REASON_PENDING,
  LIVE_NUMBER_NOT_REQUESTED,
  LIVE_NUMBER_PENDING,
  __copyStrings,
};
