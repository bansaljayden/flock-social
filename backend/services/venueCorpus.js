// ---------------------------------------------------------------------------
// CORPUS MEMBERSHIP — is this claimed venue in the data the model runs on?
//
// THE QUESTION, and why it has to be answered at claim time.
//
// services/mlPredictor.js getBaseline reads ml_venue_baselines BY
// google_place_id. When there is no row for that id the model does not degrade,
// it REFUSES (services/crowdEngine.js, case 3: "the model refused to run — no
// ml_venue_baselines row for this venue"). So corpus membership is not a
// quality gradient, it is a switch: a venue in the corpus can be shown a
// prediction, and a venue outside it can be shown nothing model-backed, ever,
// no matter which tier it pays for.
//
// The single real venue_profiles row in production is NOT in ml_venues. That is
// the modal case for a new claim, not an edge case, and it is why this check
// belongs at the moment the place_id is captured rather than in a dashboard tab
// that discovers the emptiness after the owner has already been sold a plan.
//
// THREE ANSWERS, not two, because "we have collected this venue" and "we have a
// curve for this venue" are different facts and only the second one lets the
// model speak:
//
//   'baselines'  ml_venue_baselines has rows. 168 is a full week of local
//                hours; fewer is partial coverage, which is why the row count
//                is stored beside the status instead of being thrown away.
//   'venue_only' In ml_venues with no baseline rows. Collected, not modelled.
//                A retrain can move this venue to 'baselines' without anybody
//                touching the profile, which is why the answer has a timestamp
//                and gets rechecked rather than being written once at signup.
//   'absent'     In neither. Nothing model-backed may be shown or sold.
//
// FAILS SOFT, DELIBERATELY. A database blip returns null and the caller leaves
// the stored answer alone, because the alternative is a transient error
// demoting a real corpus venue to 'absent' and taking its intelligence away
// until somebody notices. The absence of an answer is 'unknown' (a NULL column
// on a profile that has never been checked), and the READ side must treat
// 'unknown' as 'absent' — never as permission.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { isPlaceIdShaped } = require('../utils/places');

// A full week of local hours, 7 days x 24. Used only to describe coverage; a
// venue with fewer rows is still 'baselines' because the predictor asks for one
// (day, hour) at a time and a partial curve answers some of them.
const FULL_BASELINE_ROWS = 168;

// How long a stored answer is trusted before the next read refreshes it.
// A day, because the thing that changes it is a retrain (scripts/ml/RETRAIN.md),
// which is an operator-run batch job measured in days and not in minutes.
const CORPUS_TTL_MS = 24 * 60 * 60 * 1000;

const STATUSES = ['baselines', 'venue_only', 'absent', 'unknown'];

/**
 * Look up corpus membership for a place id.
 *
 * @param {string} placeId
 * @returns {Promise<{status: string, baselineRows: number}|null>} null when the
 *          lookup could not be made, which the caller must treat as "keep what
 *          you already stored", NOT as 'absent'.
 */
async function checkCorpusMembership(placeId) {
  // Shape first, same predicate the rest of the app gates on. An unshaped id
  // cannot be in either table, and asking is a query spent on a certainty.
  if (!isPlaceIdShaped(placeId)) return { status: 'absent', baselineRows: 0 };

  try {
    const { rows } = await pool.query(
      `SELECT
         EXISTS (SELECT 1 FROM ml_venues WHERE google_place_id = $1) AS in_venues,
         (SELECT COUNT(*)::int FROM ml_venue_baselines WHERE google_place_id = $1) AS baseline_rows`,
      [placeId]
    );
    const row = rows[0] || {};
    const baselineRows = Number(row.baseline_rows) || 0;
    const status = baselineRows > 0 ? 'baselines' : (row.in_venues === true ? 'venue_only' : 'absent');
    return { status, baselineRows };
  } catch (err) {
    console.error('Corpus membership check failed:', err.message);
    return null;
  }
}

/**
 * True when this profile may be shown or sold model-backed intelligence.
 *
 * The whole point of storing the status is that this is a field read and not a
 * prediction attempt. 'unknown' and NULL both answer false: never treat the
 * absence of an answer as permission.
 */
function hasModelBackedData(profile) {
  return !!profile && profile.corpus_status === 'baselines' && Number(profile.corpus_baseline_rows) > 0;
}

/**
 * One sentence, for the dashboard and the end of onboarding, saying exactly
 * what we have. No hedging and no promises about what we might collect later.
 */
function corpusSummary(profile) {
  const rows = Number(profile?.corpus_baseline_rows) || 0;
  switch (profile?.corpus_status) {
    case 'baselines':
      return rows >= FULL_BASELINE_ROWS
        ? 'We have a full week of crowd history for this venue.'
        : `We have crowd history for ${rows} of the ${FULL_BASELINE_ROWS} hours in a week here.`;
    case 'venue_only':
      return 'This venue is in our collection list but has no crowd history yet, so there is nothing to predict from.';
    case 'absent':
      return 'We have no crowd history for this venue. Your dashboard will show what happens in Flock, not a model forecast.';
    default:
      return 'We have not checked what crowd history we hold for this venue yet.';
  }
}

module.exports = {
  checkCorpusMembership,
  hasModelBackedData,
  corpusSummary,
  CORPUS_TTL_MS,
  FULL_BASELINE_ROWS,
  STATUSES,
};
