// ---------------------------------------------------------------------------
// Owner busy reports: the venue's own 0-100 "we are at X% right now".
//
// The one place that decides whether an owner's reading is live, whether it is
// allowed to replace the published number, and what the payload must say about
// it. routes/crowd.js applies this to the card, the batch list and the
// alternatives list; routes/venueDashboard.js owns the write path. Neither
// re-derives any rule here.
//
// PRECEDENCE, decided 2026-08-19 (VENUE-ADVISOR.md + the board):
//
//   verified user reports (>= 3 reporters)  >  owner report  >  model  >  rule engine
//
// The owner can see the whole room, so while the reading is fresh it beats a
// holdout statistic — that is the same argument crowdEngine.js already makes
// for putting three verified reporters above the model, one step stronger.
// But it is an ASSERTION by the party with the most to gain from it, so the
// moment three real people in the building say otherwise, the people win: the
// published number stays the existing capped user-report blend
// (crowdEngine.buildCalibrationAdjustment, untouched) and the owner's figure
// travels beside it as information, never as the number.
//
// WHY THE OVERRIDE IS FREE AT EVERY TIER. A paid tier that buys influence over
// a number consumers rely on is the LendEDU shape (FTC 2020: ratings sold as
// measurements). What keeps this a disclosure instead of an advertisement is
// exactly three properties, and all of them are enforced here or in the write
// path, none in a pricing table: the reading is labelled with its source on
// every surface (the category-derived attribution from utils/venueLabel.js,
// "the cafe says" / "the club says" / "the venue says"), it expires on its
// own, and real user reports outrank it. Do not gate the write path by plan,
// ever.
//
// WHY 90 MINUTES. The reading is an observation of the room, and rooms turn
// over: the corpus's own hour-to-hour deltas say a bar's occupancy is no longer
// within one band of itself two hours on. Ninety minutes is long enough that an
// owner who sets it at open does not have to babysit it through a rush, short
// enough that "set at 8pm, forgot, still showing at close" cannot happen. The
// owner never has to turn it off — forgetting is the normal case and the
// design assumes it (VENUE-ADVISOR.md). Enforced twice: in the SQL below
// (INTERVAL '90 minutes', so the row never leaves the database) and in
// liveOwnerReport (so a caller holding a stale row cannot publish it).
// __tests__/ownerBusyReports.test.js pins the SQL interval to the constant.
// ---------------------------------------------------------------------------
const pool = require('../config/database');
const crowdEngine = require('./crowdEngine');
const venueLabel = require('../utils/venueLabel');

const OWNER_REPORT_TTL_MINUTES = 90;
const OWNER_REPORT_TTL_MS = OWNER_REPORT_TTL_MINUTES * 60 * 1000;

// A live owner reading and >= MIN_CALIBRATION_REPORTERS verified user reports
// disagreeing by more than this many points is a divergence: the row is
// stamped diverged=true. One band plus the tie margin — the owner saying
// "packed" about a room three people just called moderate, not a rounding
// disagreement about the same crowd.
const OWNER_DIVERGENCE_POINTS = 25;

// Strikes: this many diverged rows inside the window and the venue's override
// is suppressed entirely — users see the prediction again until strikes age
// out. Repeated divergence from the people actually in the room has to cost
// the venue the thing it was gaming. Three matches every other floor in this
// product (calibration reporters, budget ceiling): one diverged reading is a
// misjudged glance at the room, three inside a month is a pattern.
const OWNER_DIVERGENCE_STRIKES = 3;
const OWNER_STRIKE_WINDOW_DAYS = 30;

// The payload vocabulary. 'owner_report' joins the confidenceBasis set
// (crowdEngine.describePredictionSupport: user_reports | model_holdout |
// model_unverified_axis | category_pattern) so every published number carries
// one of exactly five sources.
const OWNER_BASIS = 'owner_report';

// Newest live reading per place id, strike-suppressed venues excluded IN THE
// READ so no caller can forget the rule. The NOT EXISTS aggregates the
// venue's diverged rows inside the strike window; HAVING without GROUP BY is
// one row when the count clears the bar, zero rows otherwise.
//
// VERIFICATION IS RE-CHECKED HERE, AT SERVE TIME (the JOIN to
// venue_profiles), and that is not a duplicate of the write path's check.
// routes/venueDashboard.js refuses an unverified owner a 403 at POST, which
// settles the question at ONE INSTANT — but verification is REVOCABLE, and
// revoking it is the entire remedy for a fraudulent claim: routes/admin.js
// flips venue_profiles.verified, and migration 002's partial unique index
// exists precisely because two accounts can claim one place id and only one of
// them is real. Until this clause, a claim revoked at 9:01 left that account's
// number on the card, the vote list and the alternatives list until 10:30, on
// every user's screen, labelled with the venue's own attribution. Ninety
// minutes is the exact window an admin taking the number down cannot close.
//
// Both halves of the claim are matched — the same account AND the same place
// id. Matching the place id alone would let ANY verified profile keep a
// revoked owner's readings alive, which is the two-claims case turned inside
// out.
//
// IN THE READ rather than in the callers, for the reason the strike clause is:
// routes/crowd.js applies this override on the card, the batch list, the
// alternatives list and the Birdie answer, and a rule that lives in four
// callers is a rule three of them will eventually be missing. The rows are not
// deleted or retracted by this — an unverified venue's readings stay in the
// table as labelled observations for the training export (migration 031's
// rule). They simply stop being the number.
//
// Both INTERVAL literals are pinned to their constants by
// __tests__/ownerBusyReports.test.js — change either in the same edit or the
// suite names the drift.
//
// `diverged` is in the projection deliberately, and it is load-bearing rather
// than informational: applyOwnerReport guards markDiverged on
// `ownerRow.diverged !== true`, and with the column absent that guard read
// `undefined !== true` — always true. A reading that had already been struck
// but was still inside its 90 minutes therefore fired one fire-and-forget
// UPDATE per SERVE: every card view, every row of every /batch (twenty venues
// a request) and every alternatives neighbour, by every user, for the rest of
// its life. The SQL's own `AND diverged = false` made each write a no-op,
// which is exactly why nothing ever surfaced it. Projecting the column turns
// the guard back on.
const LIVE_OWNER_REPORTS_SQL = `
  SELECT DISTINCT ON (r.google_place_id)
         r.id, r.google_place_id, r.busy_percent, r.created_at, r.diverged,
         -- The owner's OWN word for their room, carried on the row that is
         -- already being read, so the consumer surfaces get the same first
         -- link of the attribution chain the dashboard has (routes/
         -- venueDashboard.js attributionCategory). Before this the card, the
         -- vote list and the alternatives list could only infer the noun from
         -- Google's types, so a venue Google types thinly fell back to the
         -- generic word on the card while its own dashboard printed the
         -- specific one: the two-surfaces-disagree shape, in the one field
         -- whose entire job is being exactly right about whose claim the
         -- number is.
         -- Free: the join below replaces an EXISTS over the same row.
         vp.category AS profile_category
    FROM venue_owner_reports r
    JOIN venue_profiles vp
      ON vp.user_id = r.venue_user_id
     AND vp.google_place_id = r.google_place_id
     AND vp.verified = true
   WHERE r.google_place_id = ANY($1::text[])
     AND r.retracted = false
     AND r.created_at > NOW() - INTERVAL '90 minutes'
     AND NOT EXISTS (
           SELECT 1 FROM venue_owner_reports s
            WHERE s.google_place_id = r.google_place_id
              AND s.diverged = true
              AND s.created_at > NOW() - INTERVAL '30 days'
           HAVING COUNT(*) >= ${OWNER_DIVERGENCE_STRIKES}
         )
   ORDER BY r.google_place_id, r.created_at DESC`;

// Map of place id -> raw row. NEVER throws: the owner override is an
// enrichment of a number that already exists, so a failed read degrades to
// the prediction, exactly like the calibration reads in routes/crowd.js.
async function getLiveOwnerReports(placeIds) {
  const ids = (Array.isArray(placeIds) ? placeIds : [placeIds]).filter(
    (id) => typeof id === 'string' && id.length > 0
  );
  if (ids.length === 0) return {};
  try {
    const { rows } = await pool.query(LIVE_OWNER_REPORTS_SQL, [ids]);
    const byPlace = {};
    for (const row of rows) byPlace[row.google_place_id] = row;
    return byPlace;
  } catch (err) {
    console.error('[OwnerReports] live-report read failed, serving predictions:', err.message);
    return {};
  }
}

// Belt-and-braces liveness over a row the SQL already filtered — the same
// two-layer rule crowdEngine.usableCalibrationReports keeps, and for the same
// reason: it makes this safe to call with a row from ANY source (a test, a
// cache, a future caller that forgot the predicate), and a forgotten predicate
// then degrades to a stricter check instead of to publishing a stale number.
function liveOwnerReport(row, nowMs) {
  if (!row || typeof row !== 'object') return null;
  const percent = Number(row.busy_percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  if (row.retracted === true) return null;
  const at = row.created_at instanceof Date
    ? row.created_at.getTime()
    : Date.parse(row.created_at);
  if (!Number.isFinite(at)) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (now - at >= OWNER_REPORT_TTL_MS) return null;
  return {
    percent: Math.round(percent),
    reportedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + OWNER_REPORT_TTL_MS).toISOString(),
  };
}

// Does a live owner reading disagree with what the verified reporters said?
// The blended payload does not carry the reporters' own average, but it
// carries enough to recover it: calibration.predictionDrift is
// round(avgFeedbackScore - rawEngineScore) (crowdEngine.js), so the reporters'
// consensus is rawEngineScore + drift to within a point.
function ownerDivergesFromReports(result, percent) {
  const cal = result?.calibration;
  if (!cal?.feedbackUsed) return false;
  const engine = Number(result.rawEngineScore);
  const drift = Number(cal.predictionDrift);
  if (!Number.isFinite(engine) || !Number.isFinite(drift)) return false;
  return Math.abs(percent - (engine + drift)) > OWNER_DIVERGENCE_POINTS;
}

// ---------------------------------------------------------------------------
// SECURITY ROUND 25 (adversarial): WHICH reporters may cost a venue a strike.
//
// The rule everything about this feature is documented against — migration
// 031, the header above, VENUE-ADVISOR.md — is "three or more verified user
// reporters CONTRADICTED A LIVE OWNER READING". The check above is not that.
// `calibration` is built by crowdEngine.buildCalibrationAdjustment over the
// rows routes/crowd.js selects, and that SELECT is
// `(day_of_week, hour) IN (three slots) AND created_at > NOW() - 28 days`.
// So the "reporters" the owner was being measured against were a rolling
// 28-DAY AVERAGE of that venue-hour, not people in the building. Two things
// followed, and they point in opposite directions:
//
//   * THE HONEST OWNER IS PUNISHED FOR BEING RIGHT. The slider exists for the
//     night when history is wrong and the operator can see the room — a game
//     night, a one-off act, a holiday. That is precisely the night the reading
//     sits more than 25 points off the venue's own 28-day mean at that hour,
//     so it is stamped. Three such nights in 30 days and the override is
//     suppressed for a month: the feature switches itself off exactly when it
//     is worth anything.
//   * IT IS A REMOTE, DURABLE GRIEFING PRIMITIVE. Three verified accounts file
//     one low report each in a couple of (dow, hour) cells. Those rows stay in
//     the window for 28 days, so they are the standing "contradiction" for
//     EVERY owner reading in those cells. Three strikes suppresses the venue's
//     override, and because the training export excludes `diverged = true`
//     rows at source (scripts/ml/train/ownerLabelExport.js), the same three
//     accounts also delete that venue's training labels. Refreshed monthly, it
//     never expires. Nobody has to be near the building.
//
// So the strike now needs CONTEMPORANEOUS evidence: verified reports filed at
// or after the moment the owner posted the reading, i.e. while it was the
// number on screen. That is the sentence the docs already make. The 28-day
// blend keeps its OTHER job untouched — deciding precedence, which number
// ships — because that is a question about the best estimate, not about
// punishing anyone.
//
// Callers hand in the raw rows they already fetched (`options.feedbackRows`).
// A caller with none supplies none and NO STRIKE IS STAMPED: the cache-hit
// card path holds a cached payload with no rows behind it, and under-stamping
// is the safe direction for the only punitive mechanism in this file.
// ---------------------------------------------------------------------------
function reportRowTime(row) {
  const raw = row?.created_at;
  if (raw instanceof Date) return raw.getTime();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : NaN;
}

// Distinct verified reporters whose report lands inside the owner reading's
// own live window. Deduped per account for the same reason
// crowdEngine.usableCalibrationReports dedupes: one person filing six reports
// is one person, and a Sybil floor of three that counts rows instead of
// accounts is not a floor. An unattributable row (user_id null) counts once
// on its own, never as a reporter that can be multiplied.
function contemporaneousReports(feedbackRows, ownerRow, nowMs) {
  const from = reportRowTime(ownerRow);
  if (!Number.isFinite(from)) return [];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const until = from + OWNER_REPORT_TTL_MS;
  const byReporter = new Map();
  const unattributed = [];
  for (const row of feedbackRows || []) {
    if (!row || typeof row !== 'object') continue;
    const score = crowdEngine.CROWD_LEVEL_TO_SCORE[row.crowd_level];
    if (score === undefined) continue;
    const at = reportRowTime(row);
    // A row with no readable timestamp cannot be shown to be contemporaneous,
    // so it is not. Same direction as everything else here.
    if (!Number.isFinite(at) || at < from || at > Math.min(until, now)) continue;
    if (row.user_id == null) { unattributed.push(score); continue; }
    byReporter.set(String(row.user_id), score);
  }
  return [...byReporter.values(), ...unattributed];
}

// The strike test itself: enough contemporaneous reporters, and their own
// consensus more than OWNER_DIVERGENCE_POINTS from what the owner asserted.
// The magnitude comes from those reporters directly rather than from the
// engine-plus-drift reconstruction above, because here we actually hold the
// rows and do not have to infer their average back out of a blend.
function strikeableDivergence(feedbackRows, ownerRow, percent, nowMs) {
  const scores = contemporaneousReports(feedbackRows, ownerRow, nowMs);
  if (scores.length < crowdEngine.MIN_CALIBRATION_REPORTERS) return false;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.abs(percent - mean) > OWNER_DIVERGENCE_POINTS;
}

// Stamp a strike. Fire-and-forget from the serve path — a divergence is
// bookkeeping about the OWNER, and the user's response must not wait on it or
// fail with it.
function markDiverged(reportId) {
  pool
    .query('UPDATE venue_owner_reports SET diverged = true WHERE id = $1 AND diverged = false', [reportId])
    .catch((err) => console.error('[OwnerReports] divergence stamp failed:', err.message));
}

// ---------------------------------------------------------------------------
// The override itself. Takes a fully-assembled crowd payload (card row, batch
// row or alternatives row — anything carrying score/label/calibration) and the
// raw owner row for its place id, returns the payload that may actually ship.
//
// Three outcomes:
//   no live reading            -> payload unchanged, no ownerReport field.
//   live, >= 3 reporters       -> users win. Number and basis untouched (the
//                                 existing capped blend IS the answer); the
//                                 owner's figure rides along, applied: false,
//                                 so a client can still show "{the venue} says
//                                 N" as information beside the number. A
//                                 reading that diverges from the reporters is
//                                 stamped.
//   live, < 3 reporters        -> the reading replaces the published number,
//                                 labelled: basis 'owner_report', supported
//                                 true (an operator looking at their own room
//                                 is not a guess to hedge), and the ownerReport
//                                 block says who asserted it and until when.
//
// Applied at SEND TIME, after the crowd cache, never before it — the cache
// stores the model's answer, so expiry falls back on its own the moment the
// TTL passes and a fresh reading shows inside one request, whatever the
// cache's own 10-minute clock says. Nothing owner-asserted is ever cached.
//
// `waitEstimate` and `capacity.current` are re-derived from the owner's
// number when the payload carries them: "95% full" above "No wait" is the
// two-surfaces-disagree bug in one card. venueTypes/priceLevel ride on the
// card payload for exactly this recompute (see routes/crowd.js).
// ---------------------------------------------------------------------------
function applyOwnerReport(result, ownerRow, options = {}) {
  if (!result || typeof result !== 'object') return result;
  const live = liveOwnerReport(ownerRow, options.now);
  if (!live) return result;

  // The attribution, computed HERE and nowhere else: "the {venue-type} says"
  // from utils/venueLabel.js — the cafe says, the club says — with "the
  // venue says" when the category is unknown. Clients render these fields and
  // never hardcode the words — __tests__/venueLabel.test.js greps the repo to
  // keep it that way.
  //
  // The chain, most specific first, matching routes/venueDashboard.js
  // attributionCategory so the owner's dashboard and the consumer card cannot
  // caption the same reading with two different words: the caller's category
  // when it passed one, then venue_profiles.category carried on the row the
  // read already joined (profile_category — the owner's own word for their
  // room), then the Google types the payload already ships for the
  // wait/capacity recompute. Each step returns null rather than guessing, so
  // an unresolved chain ends at "the venue says", which is always true.
  const category = venueLabel.normalizeCategory(options.category)
    || venueLabel.normalizeCategory(ownerRow.profile_category)
    || venueLabel.categoryFromTypes(options.venueTypes || result.venueTypes);
  const noun = venueLabel.venueNoun(category);
  const attribution = venueLabel.ownerAttribution(category);

  // Alternatives rows carry no calibration block (they publish no confidence
  // either — see the note in routes/crowd.js), so the caller may hand the
  // reporter count in explicitly. Either way, below the floor it is 0 evidence.
  const reporters = Number.isFinite(options.reporters)
    ? options.reporters
    : (result.calibration?.feedbackUsed ? Number(result.calibration.reportCount) || 0 : 0);
  if (reporters >= crowdEngine.MIN_CALIBRATION_REPORTERS) {
    // Precedence (users win) is decided by the 28-day blend above. The STRIKE
    // is decided only by reporters who were in the room while this reading was
    // the published number — see strikeableDivergence. A caller that hands in
    // no rows stamps nothing.
    if (ownerRow.id != null
        && ownerRow.diverged !== true
        && ownerDivergesFromReports(result, live.percent)
        && strikeableDivergence(options.feedbackRows, ownerRow, live.percent, options.now)) {
      markDiverged(ownerRow.id);
    }
    return {
      ...result,
      ownerReport: { ...live, applied: false, outrankedBy: 'user_reports', noun, attribution },
    };
  }

  const out = {
    ...result,
    score: live.percent,
    // An operator's statement about their own room is stated as fact, not
    // hedged into "Usually busy" — the hedge is for category priors.
    label: crowdEngine.publishedLabel(live.percent, { supported: true }),
    confidenceBasis: OWNER_BASIS,
    confidenceMeans: 'owner_asserted',
    supported: true,
    ownerReport: { ...live, applied: true, noun, attribution },
  };
  if (result.waitEstimate !== undefined) {
    out.waitEstimate = crowdEngine.estimateWait(live.percent, result.venueTypes || [], result.priceLevel ?? null);
  }
  if (result.capacity && Number.isFinite(Number(result.capacity.max))) {
    const max = Number(result.capacity.max);
    out.capacity = { current: Math.round((max * live.percent) / 100), max };
  }
  return out;
}

module.exports = {
  getLiveOwnerReports,
  liveOwnerReport,
  applyOwnerReport,
  ownerDivergesFromReports,
  contemporaneousReports,
  strikeableDivergence,
  markDiverged,
  OWNER_REPORT_TTL_MINUTES,
  OWNER_REPORT_TTL_MS,
  OWNER_DIVERGENCE_POINTS,
  OWNER_DIVERGENCE_STRIKES,
  OWNER_STRIKE_WINDOW_DAYS,
  OWNER_BASIS,
  LIVE_OWNER_REPORTS_SQL,
};
