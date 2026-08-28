// ---------------------------------------------------------------------------
// Crowd Intelligence Engine — rule-based multi-factor scoring
// Sources: Google Places + OpenWeatherMap + time patterns
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// THE LADDER, RE-CUT 2026-08-28 with the qmap arming. The 0-100 is
// venue-relative (100 = this venue's own weekly peak, the Google and BestTime
// semantic, never percent-full), and under the calibrated distribution a
// score of 70+ is a normal 1-in-4-open-hours event, not an alarm. The old
// cuts ran one notch hot: red fired at 61+, about 35% of open hours. Now the
// middle is wide and level (Steady, 40-69), Busy starts at 70 (BestTime's own
// busy convention, fires 22-25% of open hours), and Packed with the only red
// is reserved for 85+, a real 6-9% event. Mirrored in
// frontend/src/App.js crowdLabelFor and website/LiveDemo.js; a surface that
// cuts elsewhere is a bug.
function getLabel(score) {
  if (score <= 20) return 'Quiet';
  if (score <= 39) return 'Not Busy';
  if (score <= 69) return 'Steady';
  if (score <= 84) return 'Busy';
  return 'Packed';
}

// ---------------------------------------------------------------------------
// WHAT IS ACTUALLY BEHIND THE NUMBER — and what the card may therefore claim.
//
// Written after a user reported a well-known dinner restaurant reading ~20% at
// 6 PM. The investigation is in __tests__/dinnerPeakAccuracy.test.js; the short
// version is that the crowd card has, until now, published EVERY answer in the
// same shape — a precise percentage, a flat assertion ("Very Busy") and a
// confidence figure — regardless of whether anything about that venue had ever
// been observed. Three completely different things arrive here looking
// identical:
//
//   1. THE TRAINED MODEL RAN. services/mlPredictor.js published
//      metadata.training_metrics.within_15 as `confidence`, which is a figure
//      somebody actually measured on a holdout. That claim is earned.
//   2. VERIFIED USERS REPORTED THIS VENUE AT THIS HOUR. Three or more
//      presence-verified reports in the same weekly bucket (see
//      MIN_CALIBRATION_REPORTERS) is a real observation of this building.
//   3. NOTHING. The model refused to run (no ml_venue_baselines row for this
//      place — true for every venue outside the 34-city training corpus, which
//      is nearly every venue a real user searches) and nobody has reported it.
//      What answered is calculateCrowdScore below: a HAND-WRITTEN CURVE FOR THE
//      VENUE'S CATEGORY, amplified by review count. It is a statement about
//      what sushi restaurants are usually like at 6 PM on a Friday. It is not,
//      and cannot be, a statement about this restaurant tonight.
//
// Case 3 is not a bug in itself — a category prior is a reasonable thing to
// show when there is nothing better. Publishing it as though it were case 1 IS
// the bug, and it is the one that costs trust: a person who knows the place
// reads a confident wrong percentage and concludes the whole feature is fake.
//
// So the rule is: an answer may only claim as much as its evidence supports.
// `basis` travels with the prediction from the moment it is made
// (services/mlPredictor.js sets it) and every crowd payload publishes it.
// ---------------------------------------------------------------------------

// The rule engine's confidence ladder starts here, and this is the ONLY rung on
// it that is not "how much metadata did Google give us". Review count, rating
// precision, type count, price level and even a live weather reading all say
// something about how well DESCRIBED a venue is; none of them is an observation
// of how full it is. So when the number came from the category curve and
// nothing else, the honest ceiling on what it may claim is exactly this rung —
// the one the ladder itself labels "time/day always available".
//
// Deliberately the same literal the ladder starts from (calculateCrowdScore
// reads this constant), so the two cannot drift apart.
const TIME_ONLY_CONFIDENCE = 20;

// Bands are assertions; this turns one into a description of the typical case,
// which is what a category curve actually knows. "Very Busy" -> "Usually very
// busy". Lower-cased so it reads like something a person would say rather than
// a UI enum with a word bolted on front (SLOP-AUDIT rule 4).
function hedgeLabel(label) {
  if (typeof label !== 'string' || !label) return label;
  return `Usually ${label.toLowerCase()}`;
}

// The one place that decides what a prediction is allowed to claim.
//
//   predictionMethod — as set by services/mlPredictor.js: 'ml' when the trained
//     model produced the number, 'rule_engine*' for any of the honest refusals
//     (no model on disk, ship gate failed, no baseline, no climatology,
//     inference threw).
//   verifiedReports — how many distinct verified reporters
//     buildCalibrationAdjustment actually blended in. Below
//     MIN_CALIBRATION_REPORTERS it is 0 influence and therefore 0 evidence.
//
// Returns the basis, whether the answer may be stated as fact, and the ceiling
// (null = no cap; the model's confidence is a measured figure and stands).
// ---------------------------------------------------------------------------
// IS THE MODEL'S ANCHOR ON A CLOCK ANYBODY CAN VOUCH FOR? SINCE 2026-08-18,
// YES. THE CORPUS, THE BASELINES AND NOW THE WEIGHTS ARE ALL ON THE VENUE'S
// OWN CLOCK.
//
// The history, kept because the bug took three layers to kill. Weekly rows
// were stored on BestTime's day_raw array index, whose day starts at 06:00, so
// a 6 PM lookup read the venue's overnight number. That is the packed
// restaurant reading 20% at dinner.
//
//   Layer 1, the collectors: both now write and declare hour_axis
//     'venue_local'.
//   Layer 2, the data: migration 023_backfill_ml_weekly_local_hours.sql moved
//     every weekly row onto the venue-local axis and rebuilt
//     ml_venue_baselines. Verified in production 2026-08-16: 3,454,955 weekly
//     rows on 'venue_local', zero left on the BestTime index. Because the
//     model is `label_type: 'delta'` (mlPredictor returns baseline + clamp(
//     delta, ±30)), corrected baselines removed most of the served symptom on
//     their own.
//   Layer 3, the weights: v2.6.0-starling, trained on the corrected corpus and
//     exported 2026-08-18. This is what makes the flag true. The proof is in
//     the artifact rather than in a claim: category peaks in local 17:00-23:00
//     went from 2 of 91 to 53 of 91, and lunchtime peaks from 35 of 91 to 9.
//     Friday bar 15:00 -> 21:00, restaurant 14:00 -> 19:00, nightclub 17:00 ->
//     23:00. Every one moved about six hours, which is the offset itself.
//     Pinned by __tests__/dinnerPeakAccuracy.test.js, whose PART 3 now asserts
//     the peaks are already evening peaks AND that adding the old six hours
//     makes them worse, so a stale artifact fails.
//
// WHAT FLIPPING THIS DOES. It does not change a single score. It stops the
// payload hedging: `describePredictionSupport` can return basis
// 'model_holdout' with supported: true, so an ML answer states its band as
// fact instead of "Usually busy", and confidenceMeans becomes
// 'measured_accuracy'.
//
// WHAT IT DOES NOT LICENSE. The confidence integer is still
// training_metrics_by_population.realtime_served.within_15, which is 33.3%,
// NOT the blended 87.3% that mixes in weekly rows whose label equals the
// baseline by construction. mlPredictor already publishes the served figure.
// Do not "improve" this by pointing it at the blended number.
//
// TURN THIS BACK TO false if the served artifact is ever rolled back to a
// pre-2026-08-18 model, because then the weights are on the old axis again.
const ML_BASELINE_AXIS_VERIFIED = true;

// ORDER MATTERS, and it is not the order you would guess. Verified reporters
// are checked BEFORE the model, and that stayed true when the axis flag flipped
// on 2026-08-18.
//
// The original reason was that the model's weights predated the axis fix, so
// three people who were actually in the building were the better evidence. That
// reason is gone. The ordering is not, because the second reason outlived it:
// putting the model first silently downgrades exactly the venues that DO have
// real reports. `model_holdout` is a claim about accuracy across a holdout;
// `user_reports` is an observation of THIS building at THIS hour. When both are
// available the observation is the stronger thing to stand on, and the venues
// with reports are the one part of this system that works end to end.
//
// Both branches now return supported: true, so the user-visible label is the
// same either way. What changes is `basis`, which is what an operator reads to
// know WHY a number was trusted. Reporting 'model_holdout' for a venue three
// people just walked out of would be the less true of two true answers.
function describePredictionSupport(predictionMethod, verifiedReports) {
  const reports = Number.isFinite(verifiedReports) ? verifiedReports : 0;
  if (reports >= MIN_CALIBRATION_REPORTERS) {
    // Somebody was in the building and said so. The number is still mostly the
    // engine's (the blend weight is capped — see MAX_SINGLE_REPORT_LEVERAGE),
    // but it is no longer an unobserved guess about this venue.
    return { basis: 'user_reports', supported: true, confidenceMeans: 'input_completeness' };
  }
  if (predictionMethod === 'ml' && ML_BASELINE_AXIS_VERIFIED) {
    // v2.6.0-starling onward: trained on the corrected corpus, so
    // training_metrics_by_population.realtime_served.within_15 describes the
    // rows this card is drawn from. That is a measurement, and it may say so.
    return { basis: 'model_holdout', supported: true, confidenceMeans: 'measured_accuracy' };
  }
  if (predictionMethod === 'ml') {
    // Only reachable if the flag is turned back off, which means the served
    // artifact was rolled back to a pre-2026-08-18 model whose weights sit on
    // the old axis. Kept so that rollback degrades to honesty automatically.
    return { basis: 'model_unverified_axis', supported: false, confidenceMeans: 'input_completeness' };
  }
  return { basis: 'category_pattern', supported: false, confidenceMeans: 'input_completeness' };
}

// WHY `confidence` IS NOT LOWERED HERE, only explained.
//
// The obvious move is to cap it. It would be wrong twice over. First, a cap is
// a NUMBER, and inventing a number to sit next to a number I have just argued
// nobody measured is the same mistake one level up. Second — and this is the
// substantive half — the field is not an accuracy figure to begin with, on
// either path: on the rule path it is calculateCrowdScore's ladder, which
// counts how richly GOOGLE describes a venue (review count, rating precision,
// type count, price level, weather) and reaches 95 without one observation of
// how full the room has ever been; on the model path it is a hit rate measured
// on a holdout, which is a real measurement but of the MODEL, not of this
// venue's room. Capping it would leave a smaller unqualified number, which is
// not more honest, just quieter.
//
// So `confidenceMeans` ships beside it and says which of the two it is. That
// distinction did NOT go away when ML_BASELINE_AXIS_VERIFIED flipped true with
// v2.6.0-starling; the flip only settled which value the ML path gets. The
// model path now reports 'measured_accuracy' and the number means what its name
// implies — but only for the metric mlPredictor actually publishes,
// training_metrics_by_population.realtime_served.within_15 (33.3%). The blended
// 87.3% over all training rows is still not this number and still must not
// become it: that population is mostly weekly rows whose label equals the
// baseline by construction, so its hit rate measures the corpus rather than
// the model. The rule path is unchanged and still reports
// 'input_completeness'.
// (TIME_ONLY_CONFIDENCE, the one rung of that ladder that is not metadata
// richness, is exported for whoever does want to derive a real ceiling later.)
//
// What this function still does is keep the field inside its contract: an
// integer in 0..100 whatever the engine, the stub or the boost hands it.
function publishedConfidence(engineConfidence, _support, feedbackBoost = 0) {
  const raw = Number(engineConfidence);
  const base = Number.isFinite(raw) ? raw : 0;
  const boost = Number.isFinite(Number(feedbackBoost)) ? Number(feedbackBoost) : 0;
  return Math.max(0, Math.min(100, Math.round(base + boost)));
}

// The label a payload should print, given the support behind it.
function publishedLabel(score, support) {
  const label = getLabel(score);
  return support.supported ? label : hedgeLabel(label);
}

// Round 14: the word and the colour were computed from different cut points —
// getLabel breaks at 20/40/60/80, every UI recomputed its colour at 40/70. A
// venue at 65 printed "Busy" in amber and one at 75 printed "Busy" in red: same
// word, two colours, from the same card component. The colour bands are derived
// from the label bands here so a band can never be edited in one place only.
//   green  = Quiet / Not Busy   (0-40)
//   amber  = Moderate           (41-60)
//   red    = Busy / Very Busy   (61-100)
// Any surface that shows a crowd colour should use these boundaries.
function getLevel(score) {
  // Derived from the label bands (re-cut 2026-08-28 with the ladder above):
  // calm = Quiet and Not Busy, moderate = Steady, busy = Busy and Packed.
  const s = Number.isFinite(score) ? score : 0;
  if (s <= 39) return 'calm';
  if (s <= 69) return 'moderate';
  return 'busy';
}

function isWeekend(day) {
  return day === 5 || day === 6; // Fri or Sat
}

// Both primitives tolerate a non-array `types`. Routes sanitize the shape
// (routes/crowd.js filters to string arrays), but this engine is also the
// cold-start fallback called with venue objects from several shapes, and a
// string or object here used to THROW from inside scoring (`types.some is not
// a function`) — a crashed prediction where the worst acceptable outcome is a
// less-informed one. Not an array = no type information, same as absent.
function isIndoor(types) {
  if (!Array.isArray(types) || !types.length) return true;
  return types.some(t => ['restaurant', 'bar', 'night_club', 'cafe', 'movie_theater', 'bowling_alley', 'shopping_mall', 'juice_shop', 'diner', 'american_restaurant', 'fast_food_restaurant', 'gym', 'fitness_center', 'library', 'museum', 'steak_house', 'seafood_restaurant', 'sushi_restaurant', 'italian_restaurant', 'mexican_restaurant', 'indian_restaurant', 'chinese_restaurant', 'japanese_restaurant', 'korean_restaurant', 'thai_restaurant', 'vietnamese_restaurant', 'french_restaurant', 'mediterranean_restaurant', 'pizza_restaurant', 'hamburger_restaurant', 'ice_cream_shop', 'bakery', 'dessert_shop', 'ramen_restaurant', 'barbecue_restaurant'].includes(t));
}

function hasType(types, ...targets) {
  if (!Array.isArray(types)) return false;
  return targets.some(t => types.includes(t));
}

// Google returns granular types — map them to behavioral categories
function isCafeLike(types) {
  return hasType(types, 'cafe', 'juice_shop', 'smoothie_shop', 'juice_bar', 'tea_house', 'coffee_shop');
}

function isDinerLike(types) {
  return hasType(types, 'diner', 'breakfast_restaurant', 'brunch_restaurant');
}

function isFastFoodLike(types) {
  return hasType(types, 'fast_food_restaurant', 'meal_takeaway', 'hamburger_restaurant');
}

function isSteakhouseLike(types) {
  return hasType(types, 'steak_house', 'barbecue_restaurant');
}

function isFineDining(types, priceLevel) {
  return (priceLevel >= 3 && hasType(types, 'restaurant', 'steak_house', 'seafood_restaurant', 'french_restaurant', 'italian_restaurant', 'japanese_restaurant', 'mediterranean_restaurant'));
}

function isBrunchSpot(types) {
  return hasType(types, 'brunch_restaurant', 'breakfast_restaurant') || isDinerLike(types);
}

function isSushiLike(types) {
  return hasType(types, 'sushi_restaurant', 'japanese_restaurant');
}

function isSeafoodLike(types) {
  return hasType(types, 'seafood_restaurant');
}

function isPizzaLike(types) {
  return hasType(types, 'pizza_restaurant');
}

function isMexicanLike(types) {
  return hasType(types, 'mexican_restaurant', 'taco_shop');
}

function isAsianLike(types) {
  return hasType(types, 'chinese_restaurant', 'korean_restaurant', 'thai_restaurant', 'vietnamese_restaurant', 'ramen_restaurant', 'indian_restaurant');
}

function isDessertLike(types) {
  return hasType(types, 'ice_cream_shop', 'bakery', 'dessert_shop', 'dessert_restaurant');
}

function isBarLike(types) {
  return hasType(types, 'bar', 'wine_bar', 'cocktail_bar', 'sports_bar', 'pub', 'brewery', 'beer_garden');
}

function isSportsBar(types) {
  return hasType(types, 'sports_bar');
}

function isBreweryLike(types) {
  return hasType(types, 'brewery', 'beer_garden');
}

function formatHour(h) {
  const hour24 = ((h % 24) + 24) % 24;
  if (hour24 === 0) return '12 AM';
  if (hour24 < 12) return `${hour24} AM`;
  if (hour24 === 12) return '12 PM';
  return `${hour24 - 12} PM`;
}

// ---------------------------------------------------------------------------
// Popularity tiers — defines how strongly review count amplifies everything
// ---------------------------------------------------------------------------

function getPopularityTier(reviewCount) {
  if (!reviewCount || reviewCount <= 0) return { tier: 'unknown', base: 0, multiplier: 1.0 };
  if (reviewCount >= 10000) return { tier: 'landmark', base: 22, multiplier: 1.45 };
  if (reviewCount >= 5000) return { tier: 'destination', base: 20, multiplier: 1.35 };
  if (reviewCount >= 2000) return { tier: 'very_popular', base: 17, multiplier: 1.25 };
  if (reviewCount >= 1000) return { tier: 'popular', base: 14, multiplier: 1.18 };
  if (reviewCount >= 500) return { tier: 'well_known', base: 11, multiplier: 1.12 };
  if (reviewCount >= 200) return { tier: 'established', base: 8, multiplier: 1.06 };
  if (reviewCount >= 100) return { tier: 'moderate', base: 5, multiplier: 1.0 };
  if (reviewCount >= 50) return { tier: 'small', base: 3, multiplier: 0.95 };
  return { tier: 'new', base: 1, multiplier: 0.9 };
}

// ---------------------------------------------------------------------------
// Scoring factors
// ---------------------------------------------------------------------------

function getTimeFactor(dayOfWeek, hour) {
  // Friday (5) or Saturday (6)
  if (dayOfWeek === 5 || dayOfWeek === 6) {
    if (hour >= 21 && hour <= 23) return 30;
    if (hour >= 18 && hour <= 20) return 28;
    if (hour >= 12 && hour <= 14) return 18;
    if (hour >= 9 && hour <= 11) return 8;
    if (hour >= 0 && hour <= 5) return 3;
    return 12;
  }

  // Thursday (4)
  if (dayOfWeek === 4) {
    if (hour >= 21 && hour <= 23) return 24;
    if (hour >= 18 && hour <= 20) return 22;
    return 10;
  }

  // Sunday (0)
  if (dayOfWeek === 0) {
    if (hour >= 10 && hour <= 13) return 20;
    if (hour >= 18 && hour <= 20) return 15;
    return 5;
  }

  // Mon-Wed (1-3)
  if (hour >= 11 && hour <= 13) return 15;
  if (hour >= 18 && hour <= 20) return 18;
  if (hour >= 21 && hour <= 23) return 10;
  if (hour >= 14 && hour <= 17) return 3;
  if (hour >= 6 && hour <= 10) return 5;
  return 2;
}

function getRatingFactor(rating) {
  // Coerce first, then gate on finiteness. `!rating` alone let a non-numeric
  // string through ("abc" is truthy), and ("abc" - 3.0) * 6 is NaN — which
  // survived every Math.min/Math.max/Math.round downstream and shipped a card
  // whose score was NaN and whose label was "Very Busy" (NaN fails every <=
  // comparison in getLabel, so the final return wins). A rating we cannot read
  // is no rating: 0, the same answer a missing rating gets. Numeric strings
  // ("4.5", a DECIMAL column read back as text) still count, as before.
  const r = Number(rating);
  if (!r || !Number.isFinite(r)) return 0;
  // Continuous: 3.0 → 0, 4.0 → 6, 4.5 → 9, 5.0 → 12
  return Math.min(12, Math.max(0, Math.round((r - 3.0) * 6)));
}

// ---------------------------------------------------------------------------
// Venue-type × time × price interaction — this is where realism lives
// Returns a modifier that stacks on top of the base time factor
// Popular venues get these bonuses AMPLIFIED by their popularity multiplier
// ---------------------------------------------------------------------------

function getVenueContextBonus(types, dayOfWeek, hour, priceLevel, reviews) {
  if (!types || !types.length) return 0;

  const weekend = isWeekend(dayOfWeek);
  const thursdayPlus = dayOfWeek >= 4 && dayOfWeek <= 6; // Thu-Sat
  const sunday = dayOfWeek === 0;
  let bonus = 0;

  // ─── STEAKHOUSES & BBQ ───
  // Popular steakhouses at 7-9 PM are almost always booked out
  if (isSteakhouseLike(types)) {
    if (hour >= 19 && hour <= 21 && weekend) bonus += 20;
    else if (hour >= 18 && hour <= 21 && thursdayPlus) bonus += 16;
    else if (hour >= 18 && hour <= 20) bonus += 12; // Even weekday dinners are solid
    else if (hour >= 12 && hour <= 13 && weekend) bonus += 8; // Weekend lunch
    else if (hour >= 12 && hour <= 13) bonus += 4; // Weekday lunch
    else if (hour >= 14 && hour <= 17) bonus += -10; // Dead afternoon
    else if (hour >= 22) bonus += -5; // Winding down
    else if (hour <= 11) bonus += -12; // Most aren't open

    // Expensive steakhouses are even more packed
    if (priceLevel >= 3 && hour >= 18 && hour <= 21) bonus += 8;
    return bonus;
  }

  // ─── FINE DINING (price 3-4, any cuisine) ───
  // These are reservation-heavy, packed at prime dinner, dead off-hours
  if (isFineDining(types, priceLevel)) {
    if (hour >= 19 && hour <= 21 && weekend) bonus += 22;
    else if (hour >= 18 && hour <= 21 && thursdayPlus) bonus += 18;
    else if (hour >= 18 && hour <= 20) bonus += 14; // Weekday dinner
    else if (hour >= 12 && hour <= 13) bonus += (weekend ? 6 : 8); // Weekday business lunch
    else if (hour >= 14 && hour <= 17) bonus += -12;
    else if (hour <= 11) bonus += -15;
    return bonus;
  }

  // ─── SUSHI RESTAURANTS ───
  // Prime dinner time 6:30-9, weekend is crazy for popular spots
  if (isSushiLike(types)) {
    if (hour >= 18 && hour <= 21 && weekend) bonus += 18;
    else if (hour >= 18 && hour <= 20 && thursdayPlus) bonus += 14;
    else if (hour >= 18 && hour <= 20) bonus += 10;
    else if (hour >= 12 && hour <= 13) bonus += 6; // Lunch specials
    else if (hour >= 14 && hour <= 17) bonus += -10;
    else if (hour <= 11) bonus += -12;
    // Expensive sushi = even busier at dinner
    if (priceLevel >= 3 && hour >= 18 && hour <= 21) bonus += 6;
    return bonus;
  }

  // ─── SEAFOOD ───
  // Weekend dinner is king, Friday especially
  if (isSeafoodLike(types)) {
    if (hour >= 18 && hour <= 21 && dayOfWeek === 5) bonus += 20; // Friday seafood
    else if (hour >= 18 && hour <= 21 && weekend) bonus += 18;
    else if (hour >= 18 && hour <= 20 && thursdayPlus) bonus += 14;
    else if (hour >= 18 && hour <= 20) bonus += 10;
    else if (hour >= 11 && hour <= 13 && sunday) bonus += 10; // Sunday brunch/lunch
    else if (hour >= 12 && hour <= 13) bonus += 5;
    else if (hour >= 14 && hour <= 17) bonus += -10;
    else if (hour <= 11) bonus += -12;
    return bonus;
  }

  // ─── MEXICAN / TACO ───
  // Happy hour 4-6 is a thing, dinner 7-9, late night on weekends
  if (isMexicanLike(types)) {
    if (hour >= 19 && hour <= 21 && weekend) bonus += 16;
    else if (hour >= 16 && hour <= 18 && thursdayPlus) bonus += 12; // Happy hour
    else if (hour >= 18 && hour <= 20) bonus += 10;
    // Late night mex. `hour <= 24` never fired: hours run 0 to 23, so the
    // bonus stopped at 23 and midnight fell through to the `hour <= 10`
    // penalty below, scoring a Friday midnight taqueria 18 points BELOW an
    // ordinary hour. Jayden's call 2026-08-26: midnight is late night, which
    // is what the comment always said. Weekday midnight is untouched and still
    // takes the early-hours penalty.
    else if ((hour >= 22 || hour === 0) && weekend) bonus += 8;
    else if (hour >= 11 && hour <= 13) bonus += 6; // Lunch
    else if (hour >= 14 && hour <= 15) bonus += -8;
    else if (hour <= 10) bonus += -10;
    // Cheap Mexican = packed at lunch
    if (priceLevel <= 1 && hour >= 11 && hour <= 13) bonus += 6;
    return bonus;
  }

  // ─── PIZZA ───
  // Dinner peak, late night on weekends, family lunch on weekends
  if (isPizzaLike(types)) {
    if (hour >= 18 && hour <= 20 && weekend) bonus += 14;
    else if (hour >= 21 && hour <= 23 && weekend) bonus += 10; // Late night pizza
    else if (hour >= 18 && hour <= 20) bonus += 10;
    else if (hour >= 11 && hour <= 13 && weekend) bonus += 8; // Family lunch
    else if (hour >= 11 && hour <= 13) bonus += 6;
    else if (hour >= 14 && hour <= 17) bonus += -6;
    else if (hour <= 10) bonus += -10;
    // Cheap pizza = always busy
    if (priceLevel <= 1 && hour >= 11 && hour <= 21) bonus += 4;
    return bonus;
  }

  // ─── ASIAN (Chinese, Korean, Thai, Vietnamese, Ramen, Indian) ───
  // Dinner is king, lunch specials draw crowds
  if (isAsianLike(types)) {
    if (hour >= 18 && hour <= 20 && weekend) bonus += 16;
    else if (hour >= 18 && hour <= 20) bonus += 12;
    else if (hour >= 11 && hour <= 13) bonus += (priceLevel <= 1 ? 10 : 6); // Cheap lunch = packed
    else if (hour >= 21 && hour <= 22 && weekend) bonus += 6;
    else if (hour >= 14 && hour <= 17) bonus += -8;
    else if (hour <= 10) bonus += -10;
    // Korean BBQ, hot pot — weekend dinner is an EVENT
    if (hasType(types, 'korean_restaurant') && hour >= 18 && hour <= 21 && weekend) bonus += 6;
    return bonus;
  }

  // ─── DESSERT / ICE CREAM / BAKERY ───
  // Afternoon and evening, weekends especially, weather dependent
  if (isDessertLike(types)) {
    if (hour >= 14 && hour <= 17 && weekend) bonus += 14;
    else if (hour >= 19 && hour <= 21 && weekend) bonus += 12;
    else if (hour >= 14 && hour <= 17) bonus += 8;
    else if (hour >= 19 && hour <= 21) bonus += 6;
    else if (hour >= 7 && hour <= 9 && hasType(types, 'bakery')) bonus += 8; // Morning bakery
    else if (hour >= 10 && hour <= 13) bonus += 3;
    else if (hour >= 22 || hour <= 6) bonus += -12;
    return bonus;
  }

  // ─── BRUNCH SPOTS / BREAKFAST ───
  // Sunday brunch is INSANE for popular spots, Saturday too
  if (isBrunchSpot(types)) {
    if (hour >= 9 && hour <= 12 && sunday) bonus += 20;
    else if (hour >= 9 && hour <= 12 && dayOfWeek === 6) bonus += 18;
    else if (hour >= 7 && hour <= 9 && !weekend) bonus += 12; // Weekday breakfast rush
    else if (hour >= 10 && hour <= 13 && weekend) bonus += 16;
    else if (hour >= 10 && hour <= 13) bonus += 8;
    else if (hour >= 14 && hour <= 16) bonus += -8;
    else if (hour >= 17 && hour <= 20) bonus += -5;
    else if (hour >= 21 || hour <= 6) bonus += -15;
    return bonus;
  }

  // ─── SPORTS BARS ───
  // Game nights (especially weekends), Thursday night football
  if (isSportsBar(types)) {
    if (hour >= 18 && hour <= 23 && weekend) bonus += 18;
    else if (hour >= 18 && hour <= 22 && dayOfWeek === 4) bonus += 16; // Thursday night
    else if (hour >= 12 && hour <= 16 && sunday) bonus += 14; // Sunday football
    else if (hour >= 18 && hour <= 22) bonus += 8;
    else if (hour >= 11 && hour <= 13) bonus += 4; // Lunch
    else if (hour >= 6 && hour <= 10) bonus += -12;
    return bonus;
  }

  // ─── BREWERIES & BEER GARDENS ───
  // Thu-Sat evening is prime, weekend afternoons are popular
  if (isBreweryLike(types)) {
    if (hour >= 17 && hour <= 21 && weekend) bonus += 16;
    else if (hour >= 14 && hour <= 16 && weekend) bonus += 12; // Weekend afternoon hangs
    else if (hour >= 17 && hour <= 21 && thursdayPlus) bonus += 14;
    else if (hour >= 17 && hour <= 20) bonus += 6;
    else if (hour >= 12 && hour <= 14) bonus += 3;
    else if (hour >= 22) bonus += -5;
    else if (hour <= 11) bonus += -12;
    return bonus;
  }

  // ─── BARS / NIGHTLIFE (generic) ───
  if (isBarLike(types)) {
    if (weekend && hour >= 22) bonus += 18;
    else if (weekend && hour >= 21) bonus += 15;
    else if (weekend && hour >= 18 && hour <= 20) bonus += 10;
    else if (thursdayPlus && hour >= 21) bonus += 14;
    else if (hour >= 22) bonus += 12;
    else if (hour >= 21) bonus += 10;
    else if (hour >= 17 && hour <= 20) bonus += 5; // Happy hour
    else if (hour >= 6 && hour <= 16) bonus += -12;
    else if (hour >= 0 && hour <= 5) bonus += -5;
    return bonus;
  }

  // ─── NIGHTCLUBS ───
  if (hasType(types, 'night_club')) {
    if (weekend && hour >= 23) bonus += 22;
    else if (weekend && hour >= 22) bonus += 20;
    else if (weekend && hour >= 21) bonus += 14;
    else if (thursdayPlus && hour >= 22) bonus += 16;
    else if (hour >= 22) bonus += 12;
    else if (hour >= 0 && hour <= 2) bonus += (weekend ? 18 : 8);
    else if (hour >= 3 && hour <= 17) bonus += -15;
    return bonus;
  }

  // ─── FAST FOOD ───
  // Lunch rush is massive, especially cheap popular ones
  if (isFastFoodLike(types)) {
    if (hour >= 11 && hour <= 13 && !weekend) bonus += 14; // Weekday lunch rush
    else if (hour >= 11 && hour <= 13 && weekend) bonus += 10;
    else if (hour >= 18 && hour <= 20) bonus += 8;
    // Late night drive-thru, same dead comparison and the same fix as the
    // late-night branch in the bar scorer above. Weekday midnight is untouched.
    else if ((hour >= 22 || hour === 0) && weekend) bonus += 6;
    else if (hour >= 7 && hour <= 9) bonus += 4; // Breakfast
    else if (hour >= 14 && hour <= 17) bonus += -6;
    else if (hour >= 21 && !weekend) bonus += -8;
    // Cheap + popular fast food = ALWAYS a line at peak
    if (priceLevel <= 1 && reviews >= 500 && hour >= 11 && hour <= 13) bonus += 6;
    return bonus;
  }

  // ─── CAFES / COFFEE SHOPS ───
  if (isCafeLike(types)) {
    if (hour >= 7 && hour <= 9 && !weekend) bonus += 14; // Weekday morning rush
    else if (hour >= 8 && hour <= 10 && weekend) bonus += 10; // Chill weekend morning
    else if (hour >= 10 && hour <= 12) bonus += 5;
    else if (hour >= 13 && hour <= 15) bonus += 2; // Afternoon work crowd
    else if (hour >= 16 && hour <= 17) bonus += -6;
    else if (hour >= 20) bonus += -15;
    else if (hour <= 6) bonus += -15;
    return bonus;
  }

  // ─── GENERIC RESTAURANTS (catch-all) ───
  if (hasType(types, 'restaurant')) {
    if (hour >= 18 && hour <= 20 && weekend) bonus += 16;
    else if (hour >= 18 && hour <= 20) bonus += 12;
    else if (hour >= 21 && hour <= 22 && weekend) bonus += 8;
    else if (hour >= 11 && hour <= 13 && weekend) bonus += 6;
    else if (hour >= 11 && hour <= 13) bonus += 4;
    else if (hour >= 14 && hour <= 17) bonus += -10;
    else if (hour >= 0 && hour <= 10) bonus += -10;

    // Expensive restaurants on weekend nights = packed
    if (priceLevel >= 3 && hour >= 18 && hour <= 21 && weekend) bonus += 10;
    // Expensive weekday lunch = business crowd
    else if (priceLevel >= 3 && hour >= 11 && hour <= 13 && !weekend) bonus += 6;
    // Cheap restaurants = steady all day, packed at peaks
    if (priceLevel <= 1 && hour >= 11 && hour <= 20) bonus += 4;
    return bonus;
  }

  // ─── MOVIE THEATERS ───
  if (hasType(types, 'movie_theater')) {
    if (weekend && hour >= 18 && hour <= 22) bonus += 14;
    if (weekend && hour >= 13 && hour <= 17) bonus += 8;
    if (hour >= 18 && hour <= 21) bonus += 6;
    if (hour >= 6 && hour <= 11) bonus += -12;
    return bonus;
  }

  // ─── SHOPPING MALLS ───
  if (hasType(types, 'shopping_mall')) {
    if (weekend && hour >= 12 && hour <= 17) bonus += 16;
    if (weekend && hour >= 10 && hour <= 11) bonus += 10;
    if (weekend && hour >= 18 && hour <= 20) bonus += 8;
    if (hour >= 12 && hour <= 14) bonus += 8;
    if (hour >= 15 && hour <= 17) bonus += 5;
    if (hour >= 21 || hour <= 9) bonus += -12;
    return bonus;
  }

  // ─── GYMS ───
  if (hasType(types, 'gym', 'fitness_center')) {
    if (hour >= 6 && hour <= 8 && !weekend) bonus += 12;
    if (hour >= 17 && hour <= 19 && !weekend) bonus += 15;
    if (hour >= 9 && hour <= 11 && weekend) bonus += 10;
    if (hour >= 12 && hour <= 14) bonus += 3;
    if (hour >= 22 || hour <= 5) bonus += -15;
    return bonus;
  }

  // ─── LIBRARIES & MUSEUMS ───
  if (hasType(types, 'library', 'museum')) {
    if (weekend && hour >= 11 && hour <= 15) bonus += 10;
    if (hour >= 11 && hour <= 14) bonus += 6;
    if (hour >= 18 || hour <= 8) bonus += -12;
    return bonus;
  }

  // ─── PARKS ───
  if (hasType(types, 'park')) {
    if (weekend && hour >= 10 && hour <= 16) bonus += 12;
    if (hour >= 10 && hour <= 16) bonus += 5;
    if (hour >= 20 || hour <= 6) bonus += -10;
    return bonus;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Price × popularity interaction
// Expensive + popular = destination dining = packed at peak
// Cheap + popular = everyone goes there = always busy
// Expensive + low reviews = exclusive/quiet
// ---------------------------------------------------------------------------

function getPricePopularityBonus(priceLevel, reviews, dayOfWeek, hour, types) {
  if (priceLevel == null || !reviews) return 0;

  const weekend = isWeekend(dayOfWeek);
  const dinnerTime = hour >= 18 && hour <= 21;
  const lunchTime = hour >= 11 && hour <= 13;
  let bonus = 0;

  // ─── HIGH-END (price 3-4) ───
  if (priceLevel >= 3) {
    if (reviews >= 2000 && dinnerTime && weekend) bonus += 12; // Destination + prime time
    else if (reviews >= 1000 && dinnerTime && weekend) bonus += 10;
    else if (reviews >= 500 && dinnerTime && weekend) bonus += 7;
    else if (reviews >= 2000 && dinnerTime) bonus += 8; // Weekday but popular
    else if (reviews >= 1000 && dinnerTime) bonus += 6;
    else if (reviews >= 500 && lunchTime && !weekend) bonus += 5; // Business lunch

    // Low reviews + expensive = exclusive, quieter
    if (reviews < 100 && dinnerTime) bonus += -5;
    if (reviews < 50) bonus += -8;
  }

  // ─── BUDGET (price 0-1) ───
  if (priceLevel <= 1) {
    // Cheap + very popular = always a line
    if (reviews >= 2000 && (dinnerTime || lunchTime)) bonus += 10;
    else if (reviews >= 1000 && (dinnerTime || lunchTime)) bonus += 8;
    else if (reviews >= 500 && lunchTime) bonus += 6; // Lunch rush at cheap spots
    else if (reviews >= 500 && dinnerTime) bonus += 5;

    // Cheap + late night + popular = college crowd
    if (reviews >= 500 && hour >= 22 && weekend) bonus += 6;
  }

  // ─── MID-RANGE (price 2) ───
  if (priceLevel === 2) {
    if (reviews >= 2000 && dinnerTime && weekend) bonus += 8;
    else if (reviews >= 1000 && dinnerTime) bonus += 5;
    else if (reviews >= 500 && lunchTime) bonus += 4;
  }

  return bonus;
}

// ---------------------------------------------------------------------------
// Weather factor
// ---------------------------------------------------------------------------

function getWeatherFactor(weather, types) {
  if (!weather) return 0;

  let modifier = 0;
  const indoor = isIndoor(types);

  if (weather.isRaining) {
    if (hasType(types, 'park')) modifier += -15;
    else if (indoor) modifier += 5;
    else modifier += -5;
  }

  if (weather.temp > 95 || weather.temp < 20) {
    modifier += indoor ? 5 : -10;
  } else if (weather.temp >= 65 && weather.temp <= 80 && !weather.isRaining) {
    modifier += 5;
    // Perfect weather boosts outdoor venues
    if (hasType(types, 'park', 'beer_garden')) modifier += 5;
  }

  if (weather.windSpeed > 25) {
    if (!indoor) modifier += -8;
  }

  // Hot weather boosts ice cream / dessert
  if (weather.temp > 85 && isDessertLike(types)) modifier += 8;

  return Math.max(-15, Math.min(15, modifier));
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

function calculateCrowdScore(venue, weather, timestamp) {
  // Accept Date, ISO string, or nothing — callers pass all three.
  const ts = timestamp instanceof Date ? timestamp : (timestamp ? new Date(timestamp) : new Date());
  const dayOfWeek = ts.getDay();
  const hour = ts.getHours();

  const types = venue.types || [];
  const reviews = venue.user_ratings_total || 0;
  const priceLevel = venue.price_level;

  // Get popularity tier — this determines both the base and the multiplier
  const pop = getPopularityTier(reviews);

  // Individual factors
  const time = getTimeFactor(dayOfWeek, hour);
  const rating = getRatingFactor(venue.rating);
  const venueContext = getVenueContextBonus(types, dayOfWeek, hour, priceLevel, reviews);
  const pricePopBonus = getPricePopularityBonus(priceLevel, reviews, dayOfWeek, hour, types);
  const weatherMod = getWeatherFactor(weather, types);

  // Combine: base is lower, but factors are more differentiated
  // Popularity multiplier amplifies the time-sensitive factors for popular venues
  const timeSensitiveFactors = venueContext + pricePopBonus;
  const amplifiedFactors = Math.round(timeSensitiveFactors * pop.multiplier);

  // No place_id-hash "variance" term here: a ±5 nudge derived from a hash is a
  // fabricated number shown on the dial, the map and owner analytics with no
  // basis in any real signal. Differentiation comes from the real inputs
  // (time, reviews/popularity, rating, venue-type context, weather).
  const rawScore = 8 + time + pop.base + rating + amplifiedFactors + weatherMod;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Confidence based on data quality.
  //
  // READ WHAT THIS LADDER ACTUALLY MEASURES before publishing it as an accuracy
  // figure: every rung below the first is "how much metadata did Google give
  // us", not "how often is this number right". A venue with 5,000 reviews, a
  // rating, three types, a price level and a live weather reading reaches 95
  // without a single observation of how full it has ever been. That is why
  // describePredictionSupport caps what this may claim down to
  // TIME_ONLY_CONFIDENCE — the one rung here that is not metadata richness —
  // whenever the trained model did not run and nobody has reported the venue.
  let confidence = TIME_ONLY_CONFIDENCE; // time/day always available

  // Review count is the strongest confidence signal
  if (reviews >= 5000) confidence += 30;
  else if (reviews >= 2000) confidence += 25;
  else if (reviews >= 1000) confidence += 20;
  else if (reviews >= 500) confidence += 16;
  else if (reviews >= 200) confidence += 12;
  else if (reviews >= 100) confidence += 8;
  else if (reviews >= 50) confidence += 5;
  else if (reviews > 0) confidence += 2;

  // Rating precision (more reviews = more reliable rating)
  if (venue.rating != null) {
    if (reviews >= 500) confidence += 10;
    else if (reviews >= 100) confidence += 6;
    else confidence += 3;
  }

  // Venue type helps scoring accuracy
  if (types.length >= 3) confidence += 8;
  else if (types.length > 0) confidence += 4;

  // Price level is a useful signal
  if (priceLevel != null) confidence += 3;

  // Weather data adds real-time accuracy
  if (weather) confidence += 15;

  confidence = Math.min(95, confidence);

  const dataSourcesUsed = ['google_places', 'time_patterns'];
  if (weather) dataSourcesUsed.push('weather');

  return {
    score,
    label: getLabel(score),
    confidence,
    factors: { time, popularity: pop.base, rating, venueContext: amplifiedFactors, weather: weatherMod },
    dataSourcesUsed,
  };
}

// ---------------------------------------------------------------------------
// Hourly forecast
// ---------------------------------------------------------------------------

function generateHourlyForecast(venue, weather, startHour, count, baseTimestamp) {
  const hours = count || 12;
  const start = startHour != null ? startHour : new Date().getHours();
  const forecast = [];

  // Use provided base timestamp (already timezone-adjusted) or create one
  const base = baseTimestamp ? new Date(baseTimestamp) : new Date();
  base.setHours(start, 0, 0, 0);

  for (let i = 0; i < hours; i++) {
    const ts = new Date(base.getTime() + i * 60 * 60 * 1000);

    const result = calculateCrowdScore(venue, weather, ts);
    forecast.push({
      hour: formatHour(start + i),
      score: result.score,
      label: result.label,
      // Skew fix (c), 2026-08-19: every hourly entry names the engine that
      // scored it. This function IS the rule engine, so the tag is constant --
      // it exists so a strip mixing sources is visible in the payload, and so
      // direct callers (services/crowdAlerts.js) ship the same shape
      // mlPredictor.predictHourlyForecast does.
      predictionMethod: 'rule_engine',
      // The ordering axis, and always null here: this function is the category
      // prior, and a category prior has no popular-times curve behind it. The
      // field is present rather than absent so orderingAxis sees an explicit
      // "no baseline" and falls the whole candidate set back to model scores,
      // instead of a missing key that could read as an unset one.
      baselineScore: null,
      // And the same treatment for the event lookup, constant for the same
      // reason: this function IS the rule engine, so no listing was ever
      // queried for any of these hours. Present rather than absent because a
      // missing field is read as an observed street, which is the inference
      // the pair exists to remove, and because
      // __tests__/heuristicFallback.test.js pins that a strip from here and a
      // strip from mlPredictor are the same shape key for key.
      eventsObserved: false,
      eventsUnavailableReason: 'not_attempted',
    });
  }

  return forecast;
}

// ---------------------------------------------------------------------------
// Capacity estimate
// ---------------------------------------------------------------------------

function estimateCapacity(venue, score) {
  const types = venue.types || [];
  const reviews = venue.user_ratings_total || 0;
  let max;

  // THE BAR FAMILY IS TESTED BEFORE night_club, and the order is the fix.
  //
  // Google types a lot of rooms both `bar` and `night_club`, and until
  // 2026-08-20 this function tested `night_club` first while the two other
  // functions that describe the same card tested bar first: the category bonus
  // in calculateCrowdScore (isBarLike, then night_club) and estimateWait
  // (isBarLike, then night_club). So one venue got a bar score and a bar wait
  // beside a NIGHTCLUB capacity -- 400 heads where the bar ladder says 200, a
  // published number that disagreed with the two numbers printed next to it.
  //
  // It is resolved the way the score and the wait already resolve it, and the
  // way frontend/src/App.js getGroupAdmission was resolved in 0cb8070: a room
  // carrying a bar tag is a bar. Sports bar and brewery keep their own rungs
  // because they are bar-family too and the scorer tests them in this same
  // order. A room typed `night_club` ALONE carries no bar tag, matches none of
  // the three branches above, and reaches the nightclub ladder unchanged.
  //
  // This is DEFERRED.md section 3's third bullet, now closed. It is NOT
  // mlPredictor.guessCategory, which tests night_club first on purpose: that
  // one feeds the model a trained category and has to match how the corpus was
  // labelled (cf820a9). The model's label and the rule engine's room can
  // legitimately differ; the three numbers on one card cannot.
  if (isSportsBar(types)) {
    max = reviews >= 2000 ? 250 : reviews >= 1000 ? 180 : reviews >= 500 ? 120 : 60;
  } else if (isBreweryLike(types)) {
    max = reviews >= 2000 ? 200 : reviews >= 1000 ? 150 : reviews >= 500 ? 100 : 50;
  } else if (isBarLike(types)) {
    max = reviews >= 1000 ? 200 : reviews >= 500 ? 120 : 60;
  } else if (hasType(types, 'night_club')) {
    max = reviews >= 2000 ? 400 : reviews >= 1000 ? 300 : reviews >= 500 ? 200 : 100;
  } else if (isSteakhouseLike(types)) {
    max = reviews >= 2000 ? 180 : reviews >= 1000 ? 120 : reviews >= 500 ? 80 : 50;
  } else if (isDinerLike(types)) {
    max = reviews >= 1000 ? 120 : reviews >= 500 ? 80 : reviews >= 100 ? 50 : 30;
  } else if (isFastFoodLike(types)) {
    max = reviews >= 2000 ? 150 : reviews >= 500 ? 100 : reviews >= 100 ? 60 : 35;
  } else if (hasType(types, 'restaurant')) {
    max = reviews >= 5000 ? 250 : reviews >= 2000 ? 200 : reviews >= 500 ? 120 : reviews >= 100 ? 60 : 40;
  } else if (isCafeLike(types)) {
    max = reviews >= 500 ? 80 : reviews >= 100 ? 40 : 25;
  } else if (isDessertLike(types)) {
    max = reviews >= 1000 ? 60 : reviews >= 500 ? 40 : 20;
  } else if (hasType(types, 'shopping_mall')) {
    max = reviews >= 5000 ? 2000 : reviews >= 2000 ? 1000 : reviews >= 500 ? 500 : 200;
  } else if (hasType(types, 'gym', 'fitness_center')) {
    max = reviews >= 1000 ? 200 : reviews >= 500 ? 120 : reviews >= 100 ? 60 : 30;
  } else if (hasType(types, 'library', 'museum')) {
    max = reviews >= 2000 ? 300 : reviews >= 500 ? 150 : reviews >= 100 ? 80 : 40;
  } else if (hasType(types, 'movie_theater')) {
    max = reviews >= 2000 ? 400 : reviews >= 500 ? 200 : 100;
  } else {
    max = reviews >= 1000 ? 150 : reviews >= 200 ? 80 : 40;
  }

  return { current: Math.round(max * score / 100), max };
}

// ---------------------------------------------------------------------------
// Wait estimate
// ---------------------------------------------------------------------------

function estimateWait(score, types, priceLevel) {
  // Steakhouses — reservation culture, long waits without one
  if (isSteakhouseLike(types)) {
    if (score < 40) return 'Walk-in OK';
    if (score <= 60) return '10-20 min';
    if (score <= 80) return '30-45 min';
    return '45+ min — reserve ahead';
  }

  // Fine dining — almost always need reservations at peak.
  // The priceLevel argument was accepted by this function but never forwarded,
  // so isFineDining saw undefined, `undefined >= 3` was false, and this branch
  // was unreachable: every fine-dining venue fell through to the generic
  // table-wait strings ("35+ min" instead of "Reservation needed"). Callers
  // (routes/crowd.js) have always passed venue.price_level here.
  if (isFineDining(types, priceLevel)) {
    if (score < 40) return 'Walk-in likely';
    if (score <= 60) return '15-25 min';
    if (score <= 80) return '30-60 min';
    return 'Reservation needed';
  }

  if (isBarLike(types)) {
    if (score < 50) return 'No wait';
    if (score <= 70) return '~5 min';
    if (score <= 85) return '5-10 min';
    return '10-15 min';
  }

  if (hasType(types, 'night_club')) {
    if (score < 40) return 'No wait';
    if (score <= 60) return '5-10 min';
    if (score <= 80) return '15-30 min';
    return '30-60 min';
  }

  // Cafes, juice shops, smoothie shops — quick service
  if (isCafeLike(types)) {
    if (score < 50) return 'No wait';
    if (score <= 70) return '~3 min';
    if (score <= 85) return '5-10 min';
    return '10-15 min';
  }

  // Fast food — quick turnover
  if (isFastFoodLike(types)) {
    if (score < 40) return 'No wait';
    if (score <= 60) return '~3 min';
    if (score <= 80) return '5-10 min';
    return '10-15 min';
  }

  // Diners — counter + table service, faster than fine dining
  if (isDinerLike(types)) {
    if (score < 40) return 'No wait';
    if (score <= 55) return '~5 min';
    if (score <= 70) return '5-15 min';
    if (score <= 85) return '15-25 min';
    return '25+ min';
  }

  // Dessert / ice cream — line based
  if (isDessertLike(types)) {
    if (score < 40) return 'No line';
    if (score <= 60) return '~3 min';
    if (score <= 80) return '5-10 min';
    return '10-20 min';
  }

  // Shopping malls — no real "wait", describe crowd level
  if (hasType(types, 'shopping_mall')) {
    if (score < 30) return 'Uncrowded';
    if (score <= 50) return 'Light crowds';
    if (score <= 70) return 'Moderate crowds';
    if (score <= 85) return 'Crowded';
    return 'Very crowded';
  }

  // Gyms — equipment wait
  if (hasType(types, 'gym', 'fitness_center')) {
    if (score < 40) return 'Equipment open';
    if (score <= 60) return 'Some equipment in use';
    if (score <= 80) return 'Most equipment busy';
    return 'Packed — expect waits';
  }

  // Libraries, museums — space availability
  if (hasType(types, 'library', 'museum')) {
    if (score < 40) return 'Plenty of space';
    if (score <= 60) return 'Some seats taken';
    if (score <= 80) return 'Getting full';
    return 'Very full';
  }

  // Movie theaters — ticket line
  if (hasType(types, 'movie_theater')) {
    if (score < 40) return 'No line';
    if (score <= 60) return 'Short line';
    if (score <= 80) return '10-15 min line';
    return '15-30 min line';
  }

  // Generic restaurants: table waits
  if (score < 40) return 'No wait';
  if (score <= 55) return '~5 min';
  if (score <= 70) return '10-20 min';
  if (score <= 85) return '20-35 min';
  return '35+ min';
}

// ---------------------------------------------------------------------------
// Best time — lowest score, excluding peak hours and closed hours
// ---------------------------------------------------------------------------

// Round 11: a venue open 10 PM to 3 AM arrives as openHour=22, closeHour=3, and
// the old `h >= openHour && h <= closeHour` test is false at EVERY hour, so
// bars and clubs (the core use case) were treated as closed all day and their
// best-time / peak results were garbage in both the public demo and the
// authenticated crowd cards. One helper does the wrap so no caller repeats it.
// closeHour 24 is midnight (the callers already map close.hour 0 to 24), which
// keeps a 10 AM - 12 AM day a normal, non-wrapping window.
// Round 14: the close side was inclusive, so a restaurant with close.hour 23
// counted 11 PM as open and "Best time to go: 11 PM" was printed for a place
// that locks the door at 11:00. The hour bucket labelled "11 PM" is 11:00-11:59,
// which is closed time. Close is exclusive now, EXCEPT when Google reports a
// closing minute past the hour (close 22:30 means the 10 PM bucket really is
// open), which is what closeMinute carries.
function beforeClose(hour, close, closeMinute) {
  if (close == null) return true;
  if (hour < close) return true;
  return hour === close && (closeMinute || 0) > 0;
}

function hourInWindow(h, openHour, closeHour, closeMinute) {
  const hour = ((h % 24) + 24) % 24;
  const open = ((openHour % 24) + 24) % 24;
  const close = closeHour === 24 ? 24 : ((closeHour % 24) + 24) % 24;
  if (close > open) return hour >= open && beforeClose(hour, close, closeMinute); // same-day window
  if (close === open) return true;                          // treat as open round the clock
  return hour >= open || beforeClose(hour, close, closeMinute); // wraps past midnight
}

// Round 14: hours are per weekday, and treating one day's window as every day's
// produced two visibly wrong cards:
//   - A place closed on Mondays showed "Closed" next to "Best time to go: 7 PM"
//     tonight, because the fallback used Tuesday's window (or a type default)
//     for a day the venue never opens.
//   - A place with split service (11-2, 5-10) had its whole dinner service
//     treated as closed, because only the FIRST period of the day was read.
// hoursByDay is { 0..6: [{ open, close, closeMinute }] } — an empty array means
// closed that whole day, and a missing map means "no hours data", which falls
// back to the old single-window / type-default behavior.
function windowsForDay(venue, day) {
  const map = venue && venue.hoursByDay;
  if (!map || day == null) return undefined;
  const key = ((Math.trunc(day) % 7) + 7) % 7;
  const list = map[key];
  return Array.isArray(list) ? list : undefined;
}

// Is this venue open at (day, hour) on its own wall clock? A window that wraps
// past midnight belongs to the day it OPENED on, so 1 AM Saturday is covered by
// Friday's 8 PM - 2 AM period, not by Saturday's.
function isOpenAt(venue, h, day) {
  const hour = ((Math.trunc(h) % 24) + 24) % 24;
  const today = windowsForDay(venue, day);
  if (today === undefined) {
    return isOpenHour(hour, venue?.types, venue?.openHour, venue?.closeHour, venue?.closeMinute);
  }
  for (const w of today) {
    const open = ((w.open % 24) + 24) % 24;
    const close = w.close === 24 ? 24 : ((w.close % 24) + 24) % 24;
    if (close === open) return true;                                  // round the clock
    if (close < open) { if (hour >= open) return true; continue; }     // pre-midnight half
    if (hour >= open && beforeClose(hour, close, w.closeMinute)) return true;
  }
  // Yesterday's overnight window spilling into this morning.
  const prev = windowsForDay(venue, (Math.trunc(day) - 1)) || [];
  for (const w of prev) {
    const open = ((w.open % 24) + 24) % 24;
    const close = w.close === 24 ? 24 : ((w.close % 24) + 24) % 24;
    if (close < open && beforeClose(hour, close, w.closeMinute)) return true;
  }
  return false;
}

// Google's `periods`, turned into one window list per weekday. Round 14 — three
// shapes that all used to read as "closed":
//   - Always-open places arrive as ONE period with an `open` and no `close`.
//     `close?.hour ?? null` left closeHour null, the engine fell through to a
//     type default, and a 24-hour diner was "closed" at 2 AM.
//   - Split service (11-2, then 5-10) arrives as two periods for one day, and
//     `periods.find()` took only the first, so the entire dinner service read
//     as closed and the card sent people to tomorrow's lunch.
//   - A day the venue never opens has no period at all, which fell back to a
//     type default: "Closed" printed next to "Best time to go: 7 PM".
// An empty array for a day means closed all day, which is a real answer and is
// why this returns a full 0-6 map rather than only the days Google listed.
function buildHoursByDay(periods) {
  if (!Array.isArray(periods) || !periods.length) return null;
  const byDay = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  let alwaysOpen = false;

  for (const pd of periods) {
    const day = pd?.open?.day;
    const open = pd?.open?.hour;
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!Number.isInteger(open)) continue;
    if (!pd.close) { alwaysOpen = true; continue; } // Google's "open 24 hours"
    let close = pd.close.hour;
    if (!Number.isInteger(close)) continue;
    const closeMinute = Number.isInteger(pd.close.minute) ? pd.close.minute : 0;
    // Midnight close is 24, not 0, so a 10 AM - 12 AM day stays a normal
    // window instead of looking like an overnight wrap.
    if (close === 0 && closeMinute === 0) close = 24;
    byDay[day].push({ open, close, closeMinute });
  }

  if (alwaysOpen) {
    for (let d = 0; d < 7; d++) byDay[d] = [{ open: 0, close: 24, closeMinute: 0 }];
  }
  return byDay;
}

function isOpenHour(h, types, openHour, closeHour, closeMinute) {
  // Use real hours from Google if available
  if (openHour != null && closeHour != null) return hourInWindow(h, openHour, closeHour, closeMinute);
  if (hasType(types, 'bar', 'night_club') || isBarLike(types)) return (h >= 16 || h <= 2);
  if (isDinerLike(types)) return (h >= 6 && h <= 21);
  if (isFastFoodLike(types)) return (h >= 6 && h <= 23);
  if (hasType(types, 'restaurant') || isSteakhouseLike(types) || isSushiLike(types) || isSeafoodLike(types)) return (h >= 11 && h <= 22);
  if (isCafeLike(types)) return (h >= 6 && h <= 21);
  if (isDessertLike(types)) return (h >= 10 && h <= 22);
  if (hasType(types, 'shopping_mall')) return (h >= 10 && h <= 21);
  if (hasType(types, 'gym', 'fitness_center')) return (h >= 5 && h <= 23);
  if (hasType(types, 'library', 'museum')) return (h >= 9 && h <= 18);
  if (hasType(types, 'park')) return (h >= 6 && h <= 21);
  return (h >= 8 && h <= 23);
}

// Round 13 — two bugs the live demo made obvious at 8:49 PM:
//
//   1. The recommendation could point BACKWARDS. Callers hand this function a
//      24-hour forecast that starts at 6 AM, and it scanned all 24 entries with
//      no idea what time it was, so at 8:49 PM the quietest hour of the whole
//      day (4 PM) won. Telling someone to go five hours ago is worse than
//      saying nothing. Every candidate now has to sit AFTER the venue's current
//      hour.
//
//   2. The recommendation contradicted the number beside it. "Now" used to mean
//      `hourlyForecast[0].score`, which on a 6 AM array is 6 AM, while the card's
//      dial came from a separate prediction at the real hour. A venue at 86% and
//      "Very Busy" got "Now is good" because 6 AM was quiet. The caller now
//      passes the same score it renders, so the headline, the label and the
//      recommendation are one decision.
//
// "Now" is always the VENUE's hour, supplied by the caller. Reading the process
// clock here would score a Philadelphia bar on Railway's UTC afternoon.

// THE LEVEL noise floor. Not the ordering one — see HOUR_ORDERING_MIN_GAP.
//
// This is the smallest difference in a PUBLISHED score this file treats as a
// real difference rather than model noise. It is derived from the shipped
// model's holdout error (scripts/ml/models/model_metadata.json: mae 5.81,
// rmse 12.85, within_5 76.1%, within_10 81.1%), sitting just under the mean
// absolute error so a gap smaller than it is inside the band that already
// contains three quarters of the model's predictions.
//
// Two things still stand on it, and neither is a claim about hour order:
// MAX_SINGLE_REPORT_LEVERAGE below (deliberately equal, so one stranger's tap
// cannot move a public number by more than the difference this file refuses to
// read as signal), and routes/venueDashboard.js's STRIP_ORDERING_MIN_GAP,
// which is one label band (20) plus this margin.
//
// It USED to be what recommendBestTime acted on, and that was the defect fixed
// on 2026-08-20. A level error band cannot license an ordering claim: how far
// off the printed number is says nothing about whether 9 PM outranks 8 PM.
// Re-derive it from the metadata if the model is retrained;
// __tests__/socketTakedownParity.test.js keeps it inside the reported band.
const TIE_MARGIN = 5;

// THE ORDERING noise floor, and the only one the best-time line may use.
//
// Measured, not argued: scripts/ml/HOUR-RANKING-EVAL.md, 35,052 hour pairs
// inside a venue-night on the v2.6.0-STARLING holdout gate slice. Ordering two
// hours whose TRUE separation is under 10 points is 53.2% right for the model
// and 53.8% for the popular-times baseline. That is a coin flip, and 21% of
// all pairs sit there. Above 20 points both predictors reach ~67%.
//
// So 10 is where a difference stops being a coin flip on the measurement that
// asked this exact question, and below it the honest answer is that the hours
// are the same. TIE_MARGIN (5) was never entitled to license this decision —
// it comes from the size of the LEVEL error, which is a different quantity.
//
// Re-derive by re-running scripts/ml/train/hour_ranking_eval.py and reading
// the gap-bucket table; do not re-derive it from model_metadata.json.
const HOUR_ORDERING_MIN_GAP = 10;

const NO_WINDOW_LEFT = 'No good window left today';
// Said when there ARE open hours ahead but nothing separates them by more than
// HOUR_ORDERING_MIN_GAP. Naming one of them would be naming noise.
const NO_QUIET_HOUR = 'No quiet hour stands out';

// ---------------------------------------------------------------------------
// WHICH NUMBER ORDERS THE HOURS — the 2026-08-20 serve change.
//
// The card publishes the MODEL's level: on the gate slice it beats the
// popular-times baseline on MAE (29.42 vs 31.48) and within-10 (20.7% vs
// 19.2%), so the 0-100 integer stays the model's and nothing here touches it.
//
// The SHAPE is a different question with a different answer. On within-night
// hour pairs the trained delta layer orders hours 62.7% right and the baseline
// curve alone orders the same pairs 63.1% right; a venue-block bootstrap of
// model minus baseline is -0.49pp, CI95 [-0.88, -0.12], negative in every gap
// bucket (HOUR-RANKING-EVAL.md sections 2 and 4). The delta layer is not
// merely useless for ordering hours, it is significantly slightly negative. So
// every "which hour is better" decision in this file ranks on the baseline
// curve, and the model keeps the number on the dial.
//
// Entries carry `baselineScore` when mlPredictor produced them (the SMOOTHED
// anchor the delta is added to — services/mlPredictor.js getBaseline, the same
// quantity the evaluation's baseline arm used, not the raw popular_times cell).
// The axis is chosen for the WHOLE candidate set at once and never mixed: half
// a ranking on one number and half on another is a third predictor nobody
// measured. Rule-engine hours have no baseline, so a set containing one falls
// back to model scores entirely, which is the old behaviour and is still what
// the hedge above protects.
function orderingAxis(entries) {
  const usable = Array.isArray(entries) && entries.length
    && entries.every(e => Number.isFinite(Number(e && e.baselineScore))
                          && Number(e.baselineScore) > 0);
  return {
    basis: usable ? 'baseline' : 'model',
    valueOf: usable
      ? (e) => Number(e.baselineScore)
      : (e) => Number(e && e.score),
  };
}

function dayOffsetForIndex(startHour, i) {
  return Math.floor((startHour + i) / 24);
}

// 1 AM after a 9 PM start is the same night out, not tomorrow. Bars and clubs
// are the core case here, and calling their quiet stretch "Tomorrow 2 AM" reads
// as a different evening. Same convention the model's astronomy features use:
// the hours before 5 AM belong to the night before. Round 14: shared, because
// the peak line and the best-time line have to agree about what "tomorrow"
// means when they sit on the same card.
function sameNightOffset(nowHour, hour, calendarOffset) {
  const evening = (((nowHour % 24) + 24) % 24) >= 18;
  const small = (((hour % 24) + 24) % 24) <= 5;
  return (calendarOffset === 1 && evening && small) ? 0 : calendarOffset;
}

function withDayPrefix(label, dayOffset) {
  if (dayOffset === 1) return `Tomorrow ${label}`;
  if (dayOffset > 1) return `In ${dayOffset} days, ${label}`;
  return label;
}

// The single place "go now" becomes words. It reads the same score the card
// puts on the dial, so a packed venue can never be sold as a good time to show
// up. No claim here reaches past the end of today.
function nowCopy(currentScore, rushAhead) {
  // Cuts follow the ladder (re-cut 2026-08-28): Packed talk starts where
  // Packed starts, busy talk where Busy starts. A Steady 65 is a normal
  // evening and may honestly be called good.
  if (currentScore > 84) return 'Packed now, and it stays that way';
  if (currentScore > 69) return "Now, but it's busy";
  if (rushAhead) return 'Now, before the rush';
  return 'Now is good';
}

// Structured answer: the copy plus which forecast entry it points at, so a
// chart can highlight the same hour the sentence names.
//
// LEVEL vs SHAPE, in one function. Every WORD about now ("Packed now", "Now is
// good") is chosen from `currentScore`, the model's published level, because
// that is the number measured to beat the baseline. Every DECISION about which
// hour outranks which is taken on the ordering axis above, because that is the
// question the baseline curve was measured to win. The two never swap jobs.
function recommendBestTime(hourlyForecast, venue, peakStartIdx, peakEndIdx, isOpen, options = {}) {
  const nothing = {
    text: NO_WINDOW_LEFT, hourLabel: null, index: -1, dayOffset: 0,
    orderingBasis: null, orderingMinGap: HOUR_ORDERING_MIN_GAP,
  };
  if (!hourlyForecast || !hourlyForecast.length) return nothing;

  const startHour = parseHourLabel(hourlyForecast[0].hour);
  // The venue's weekday, when the caller knows it. Without it every hour is
  // tested against one generic window, which is how a Monday-closed venue got
  // told to come at 7 PM tonight.
  const currentDay = options.currentDay != null
    ? ((Math.trunc(options.currentDay) % 7) + 7) % 7
    : null;
  const openAt = (h, calendarOffset) =>
    isOpenAt(venue, h, currentDay != null ? currentDay + calendarOffset : null);

  // Where the venue's current hour sits in this forecast.
  let nowIdx = 0;
  let nowHour = startHour;
  if (options.currentHour != null) {
    nowHour = ((Math.trunc(options.currentHour) % 24) + 24) % 24;
    nowIdx = -1;
    for (let i = 0; i < hourlyForecast.length; i++) {
      if ((startHour + i) % 24 === nowHour) { nowIdx = i; break; }
    }
  }

  // The score the card is showing. Falling back to the forecast entry keeps
  // older callers working, but it is the caller's job to keep these equal.
  const currentScore = options.currentScore != null
    ? options.currentScore
    : hourlyForecast[Math.max(0, nowIdx)].score;

  const nowDay = dayOffsetForIndex(startHour, Math.max(0, nowIdx));
  const openNow = isOpen != null ? isOpen : openAt(nowHour, 0);

  const nowEntry = hourlyForecast[Math.max(0, nowIdx)];

  const ahead = [];
  for (let i = nowIdx + 1; i < hourlyForecast.length; i++) {
    const h = parseHourLabel(hourlyForecast[i].hour);
    const calendarOffset = dayOffsetForIndex(startHour, i) - nowDay;
    if (!openAt(h, calendarOffset)) continue;
    ahead.push({
      index: i,
      score: hourlyForecast[i].score,
      baselineScore: hourlyForecast[i].baselineScore,
      label: hourlyForecast[i].hour,
      dayOffset: sameNightOffset(nowHour, h, calendarOffset),
      inPeak: peakStartIdx != null && i >= peakStartIdx && i <= peakEndIdx,
    });
  }

  // One axis for the whole decision, chosen over the hours it will actually
  // compare. When the venue is shut, "now" is neither a candidate nor a
  // comparison point, and including it would drag the whole decision back onto
  // model scores: a closed hour has no collected baseline, so it fails the
  // all-or-nothing test on its own and takes every open hour down with it.
  const axis = orderingAxis(openNow === false ? ahead : [nowEntry, ...ahead]);
  const rank = axis.valueOf;
  // What "now" is worth on the ordering axis. On the model fallback that is
  // the calibrated score the card prints, which is what this function has
  // always compared against; on the baseline axis it is this hour's point on
  // the curve, because a user report moves the LEVEL and cannot move Google's
  // shape.
  const nowRank = axis.basis === 'baseline' ? rank(nowEntry) : currentScore;

  const quietest = (list) => list.reduce((a, b) => (rank(b) < rank(a) ? b : a), list[0]);
  const openToday = ahead.filter(e => e.dayOffset === 0);
  const todayPicks = openToday.filter(e => !e.inPeak);
  const laterPicks = ahead.filter(e => e.dayOffset > 0 && !e.inPeak);
  const pick = (e) => ({
    text: withDayPrefix(e.label, e.dayOffset),
    hourLabel: e.label,
    index: e.index,
    dayOffset: e.dayOffset,
    orderingBasis: axis.basis,
    orderingMinGap: HOUR_ORDERING_MIN_GAP,
  });
  const stayPut = (rushAhead) => ({
    text: nowCopy(currentScore, rushAhead),
    hourLabel: null,
    index: Math.max(0, nowIdx),
    dayOffset: 0,
    orderingBasis: axis.basis,
    orderingMinGap: HOUR_ORDERING_MIN_GAP,
  });
  // Open hours exist but nothing separates them by more than the measured
  // coin-flip floor. Naming one would be naming noise, so the card says the
  // hours look alike instead of inventing a winner.
  const noStandout = () => ({
    text: NO_QUIET_HOUR,
    hourLabel: null,
    index: Math.max(0, nowIdx),
    dayOffset: 0,
    orderingBasis: axis.basis,
    orderingMinGap: HOUR_ORDERING_MIN_GAP,
  });

  // Naming the quietest of a shortlist when there is no "now" to measure
  // against. The hedge lands on the SPREAD instead: if the quietest and the
  // busiest candidate sit inside the floor, the shortlist has no winner and
  // the card says so. A shortlist of ONE is not an ordering claim at all, so
  // it is named whatever its spread.
  const nameQuietest = (pool) => {
    if (!pool.length) return nothing;
    const best = quietest(pool);
    if (pool.length === 1) return pick(best);
    const worst = pool.reduce((a, b) => (rank(b) > rank(a) ? b : a), pool[0]);
    if (rank(worst) - rank(best) < HOUR_ORDERING_MIN_GAP) return noStandout();
    return pick(best);
  };

  // Shut right now: "now" can never be the answer.
  if (openNow === false) {
    return nameQuietest(todayPicks.length ? todayPicks : laterPicks);
  }

  if (todayPicks.length) {
    const best = quietest(todayPicks);
    // The whole "go at 9 instead of now" claim, and the only place it is made.
    // It fires only when the ordering axis separates the two hours by more
    // than the measured floor; inside the floor the honest answer is that they
    // are the same hour, which is what nowCopy already says in level terms.
    if (rank(best) < nowRank - HOUR_ORDERING_MIN_GAP) return pick(best);
    return stayPut(false);
  }

  // Open hours are left today, but all of them are the peak. Going now beats
  // waiting for the rush, and the copy says which it is.
  if (openToday.length) return stayPut(true);

  // Open now and nothing open after this hour: it is this hour or another day.
  if (currentScore <= 60) {
    return {
      text: 'Now, they close soon', hourLabel: null, index: Math.max(0, nowIdx), dayOffset: 0,
      orderingBasis: axis.basis, orderingMinGap: HOUR_ORDERING_MIN_GAP,
    };
  }
  return nameQuietest(laterPicks);
}

function findBestTime(hourlyForecast, venue, peakStartIdx, peakEndIdx, isOpen, options) {
  return recommendBestTime(hourlyForecast, venue, peakStartIdx, peakEndIdx, isOpen, options).text;
}

// Google Places returns utcOffsetMinutes per place. Turn it into the venue's
// own wall clock, which is the only clock that makes "a time in the future"
// mean anything: Railway runs UTC, and a visitor in New York can be looking at
// a bar in Los Angeles. Returns null when the offset is missing so callers can
// fall back to whatever clock they do have.
//
// THE OFFSET HAS TO BE AN OFFSET (round 26). `Number.isFinite` is a check on
// the double and not on the meaning: `1e15` is finite, and shifting `now` by
// 1e15 minutes lands past the ECMAScript date range, so `shifted.getTime()` is
// NaN and this used to return `{ hour: NaN, day: NaN }`. Both callers treat a
// non-null return as a usable clock, so the NaN travelled into
// `scoreTime.setHours(NaN)` — an Invalid Date — and every feature derived from
// it came out NaN and was zero-filled into the vector. That is the round 15
// bug (`localHour: "abc"`) with a different door, and it was reachable from the
// request body through POST /api/crowd/batch's whitelist.
//
// Two guards, because they answer different questions. The RANGE check is the
// meaning: real zones run UTC-12:00 to UTC+14:00, and anything else is not an
// offset that a place has. The NaN check behind it is the arithmetic: it costs
// one comparison and it means this function cannot report a clock it does not
// have, whatever a future caller hands it. Callers already handle null by
// falling back to the clock they do have.
const MIN_UTC_OFFSET_MINUTES = -720;  // UTC-12:00
const MAX_UTC_OFFSET_MINUTES = 840;   // UTC+14:00

function venueLocalNow(utcOffsetMinutes, now) {
  if (utcOffsetMinutes == null) return null;
  const offset = Number(utcOffsetMinutes);
  if (!Number.isFinite(offset)) return null;
  if (offset < MIN_UTC_OFFSET_MINUTES || offset > MAX_UTC_OFFSET_MINUTES) return null;
  const base = now ? new Date(now) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  const shifted = new Date(base.getTime() + offset * 60000);
  if (Number.isNaN(shifted.getTime())) return null;
  return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
}

// Days to add to a date on weekday `fromDay` to reach the NEAREST date whose
// weekday is `toDay`. Round 14: three call sites wrote `toDay - fromDay` and
// treated a signed weekday difference as a number of days, so on a UTC Sunday a
// Saturday-evening venue in Los Angeles was scored SIX DAYS IN THE FUTURE
// (6 - 0 = +6) instead of yesterday. The weekday and the hour came out right,
// which is why nobody saw it, but the DATE drives the holiday, school-break and
// special-night features and the Ticketmaster query window, so every Saturday
// night the card west of UTC was scored against next week's events.
function weekdayOffset(fromDay, toDay) {
  const from = ((Math.trunc(fromDay) % 7) + 7) % 7;
  const to = ((Math.trunc(toDay) % 7) + 7) % 7;
  const diff = (to - from + 7) % 7;
  return diff > 3 ? diff - 7 : diff;
}

function parseHourLabel(label) {
  if (!label) return 12;
  const parts = label.match(/^(\d+)\s*(AM|PM)$/i);
  if (!parts) return 12;
  let h = parseInt(parts[1], 10);
  const ampm = parts[2].toUpperCase();
  if (ampm === 'AM' && h === 12) h = 0;
  else if (ampm === 'PM' && h !== 12) h += 12;
  return h;
}

// ---------------------------------------------------------------------------
// Peak time (busiest hour, range if consecutive tie)
// Returns { text, startIdx, endIdx } so bestTime can avoid peak
//
// "Which hour is busiest" is the same ordering question as "which hour is
// quietest", asked with the sign flipped, so it is answered on the same axis
// (orderingAxis: the baseline curve when every open hour has one). It has to
// be, for a reason beyond consistency: recommendBestTime EXCLUDES this window
// from its candidates, and a peak picked on one number while the ranking runs
// on another would delete hours the ranking never considered busy.
//
// No minimum-gap hedge here, deliberately. The best-time line asserts an
// ACTION ("go at 9 instead of now") and a flat curve makes that assertion
// worthless; the peak line answers "when is this place busiest", which has an
// answer even on a flat curve, and the number beside it already says how busy
// that is. If the peak line ever grows into advice, it needs the hedge too.
// ---------------------------------------------------------------------------

function findPeakTime(hourlyForecast, venue, options = {}) {
  if (!hourlyForecast || !hourlyForecast.length) return { text: '', startIdx: 0, endIdx: 0 };

  const types = venue?.types || [];
  const startHour = parseHourLabel(hourlyForecast[0].hour);
  const startDay = options.startDay != null
    ? ((Math.trunc(options.startDay) % 7) + 7) % 7
    : null;
  const openAt = (h, i) => isOpenAt(
    venue,
    h,
    startDay != null ? startDay + dayOffsetForIndex(startHour, i) : null
  );

  // The candidate set first, THEN the axis over it. Closed hours carry no
  // baseline (nothing was ever collected for a shut venue), so choosing the
  // axis over all 24 entries would fall back to model scores on every venue
  // that closes at all, which is every venue.
  const considered = [];
  for (let i = 0; i < hourlyForecast.length; i++) {
    const h = parseHourLabel(hourlyForecast[i].hour);
    if (types.length && !openAt(h, i)) continue;
    considered.push(hourlyForecast[i]);
  }
  const rank = orderingAxis(considered.length ? considered : hourlyForecast).valueOf;

  let maxScore = -1;
  let maxIndex = 0;

  for (let i = 0; i < hourlyForecast.length; i++) {
    const h = parseHourLabel(hourlyForecast[i].hour);
    if (types.length && !openAt(h, i)) continue;

    if (rank(hourlyForecast[i]) > maxScore) {
      maxScore = rank(hourlyForecast[i]);
      maxIndex = i;
    }
  }

  let endIndex = maxIndex;
  for (let i = maxIndex + 1; i < hourlyForecast.length; i++) {
    const h = parseHourLabel(hourlyForecast[i].hour);
    if (types.length && !openAt(h, i)) break;
    if (Math.abs(rank(hourlyForecast[i]) - maxScore) <= 3) {
      endIndex = i;
    } else {
      break;
    }
  }

  // Round 13: callers now hand this a forecast that starts at the venue's
  // current hour, so a peak can legitimately land after midnight. Say which day
  // rather than printing a bare "1 PM" that reads as one that already passed.
  //
  // Round 14: it has to say it the SAME way the best-time line does. The two
  // sit inches apart on the card, and the peak line called 1 AM "Tomorrow 1 AM"
  // while the best-time line called the same hour "2 AM", so one card carried
  // two conventions for the same night.
  const startLabel = withDayPrefix(
    hourlyForecast[maxIndex].hour,
    sameNightOffset(startHour, parseHourLabel(hourlyForecast[maxIndex].hour), dayOffsetForIndex(startHour, maxIndex))
  );
  let text;
  if (endIndex > maxIndex) {
    const endLabel = hourlyForecast[endIndex].hour;
    text = `${startLabel} - ${endLabel}`;
  } else {
    text = startLabel;
  }

  return { text, startIdx: maxIndex, endIdx: endIndex };
}

// ---------------------------------------------------------------------------
// Calibration — adjusts engine score using real user feedback
// ---------------------------------------------------------------------------

const CROWD_LEVEL_TO_SCORE = { 1: 20, 2: 50, 3: 80 };

// The widest two reports can disagree: level 1 (20) against level 3 (80). Every
// leverage number below is derived from this span, so changing the mapping
// changes the guard rails with it instead of leaving them stale.
const FEEDBACK_SCORE_SPAN = 80 - 20;

// ---------------------------------------------------------------------------
// How many DISTINCT reporters it takes before user feedback may move the
// public number at all, and why it is 3.
//
// Until this existed there was no floor: one report was enough, and because
// the weight at n=1 was 0.15 across a 0-100 range, a single person tapping
// "packed" could move a venue's public score by up to 12 points — enough to
// cross a label boundary and turn "Not Busy" into "Moderate" on every phone
// looking at that venue. That is a number the product asks people to trust,
// published on the strength of one tap.
//
// 3, specifically:
//   - The scale is coarse. crowd_level has three settings, so one report is a
//     60-point-wide opinion. Three is the first count at which one outlier is
//     outvoted by the other two rather than being the whole signal.
//   - It is the threshold this product already uses for "enough people said
//     something to publish it": the budget ceiling is withheld below 3
//     non-skipped submissions and ghost commit refuses to open below 3
//     (routes/budget.js, routes/billing.js). One rule, one number.
//   - It is what the anti-gaming story needs. Reports only reach this path
//     when venue_feedback.verified is true, and combined with the per-reporter
//     dedupe below, moving a venue's public score costs three separate
//     accounts reporting in the same weekly (day, hour) bucket rather than one
//     account tapping three times.
//
//     Be precise about what `verified` buys, because it is not uniform (see
//     VERIFIED_PRESENCE_SQL in routes/feedback.js). One of its two branches is
//     an HMAC-signed NFC tap at the venue inside three hours, which really is
//     physical presence. The other is accepted membership in a non-cancelled
//     flock that met at that venue within twelve hours and has at least two
//     accepted members — good evidence about real users, but self-assertable
//     by two cooperating accounts, since a flock's venue_id is client-supplied.
//     routes/feedback.js says so in as many words. So the honest statement of
//     the floor is "three accounts, and for the flock branch at least three
//     that accepted the same fabricated plan", NOT "three people who were
//     provably in the building". Do not restate it as the stronger claim; the
//     next person tuning this number should see the real cost of an attack.
//   - The cost of the floor is small and safe: below it the model's own answer
//     stands, which is the number every other surface already ships.
const MIN_CALIBRATION_REPORTERS = 3;

// The most any ONE report may move the published score, in points, ONCE
// calibration is live for that venue and hour.
//
// Deliberately equal to TIE_MARGIN above, which this file justifies from the
// shipped model's holdout error: a single stranger's tap must never move the
// public number by more than the difference the same file refuses to act on as
// noise. Enforced by construction — the blended weight is capped so
// that weight * (FEEDBACK_SCORE_SPAN / n) can never exceed it — so the bound
// survives someone retuning the ladder without re-deriving the arithmetic.
// (Kept as its own constant rather than referencing TIE_MARGIN, so tuning one
// level margin cannot silently retune what strangers can do to a score. Note
// that as of 2026-08-20 TIE_MARGIN no longer gates the best-time line at all —
// that decision moved to HOUR_ORDERING_MIN_GAP, which is a measured ORDERING
// floor and has nothing to do with this bound.)
//
// READ THE QUALIFIER. The bound is on the MARGINAL effect of a report among n
// reports, and it does not describe the step at the floor. Going from
// MIN_CALIBRATION_REPORTERS - 1 reporters to MIN_CALIBRATION_REPORTERS switches
// blending on at once, so the report that crosses the line moves the published
// number by weight * |feedbackScore - engine| — up to 0.25 * 80 = 20 points if
// three reporters unanimously contradict the model. That discontinuity is
// inherent to having a floor at all (some report is always the one that turns
// calibration on) and it is the deliberate trade: below the floor user feedback
// is worth nothing, above it the first three verified reporters are worth
// having. What keeps the step honest is the gate in FRONT of it, not this cap:
// venue_feedback.verified, and the per-account dedupe below that makes three
// reports three people rather than one person three times. Read what `verified`
// actually proves in the MIN_CALIBRATION_REPORTERS note above before leaning on
// it — one of its two branches is presence, the other is not. Do not restate
// this constant as "no user feedback can move a score by more than 5 points";
// that is not what it enforces.
const MAX_SINGLE_REPORT_LEVERAGE = 5;

// A report is evidence about how busy a place is, and that evidence goes stale.
// Four weeks is four observations of any given weekly (day, hour) slot: enough
// for a real venue to reach the floor, short enough that a bar that changed
// hands, changed its DJ night or lost its patio is not still being scored on
// last spring. It also puts a clock on influence — an account that reported
// once cannot keep steering that venue's slot forever.
//
// This is a backstop, not the primary control. The same window is enforced in
// SQL (`created_at > NOW() - INTERVAL '28 days'` on all three calibration
// reads), which is the cheaper place for it and the only place that stops the
// single-venue LIMIT 50 spending its budget on rows that were going to be
// discarded. Keep the two equal — __tests__/calibrationQueries.test.js compares
// this constant against the interval in each query.
const CALIBRATION_MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;

function calibrationRowTime(row) {
  const t = row.created_at;
  if (t == null) return null;
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// From raw feedback rows to the set of reports that may vote: recent, and one
// per account.
//
// ONE VOTE PER ACCOUNT. A single account that filed six reports for the same
// venue and hour used to arrive as six independent voices — which both cleared
// any sample floor by itself and pushed the blend weight up the ladder. Newest
// report per user_id wins; an account revising its own opinion is one opinion.
//
// THE ROW CARRIES user_id AND created_at. It did not always: routes/crowd.js
// selected `crowd_level, predicted_score` and nothing else, so both protections
// here degraded to "keep every row" in production while looking enforced in
// this file. All three calibration SELECTs now project `user_id, created_at`
// and bound the age in SQL with `created_at > NOW() - INTERVAL '28 days'`, and
// the single-venue read additionally collapses to `DISTINCT ON (user_id)
// ... ORDER BY user_id, created_at DESC` so its LIMIT 50 means fifty reporters
// rather than fifty rows one account can own.
// __tests__/calibrationQueries.test.js pins all of that, including that the
// SQL interval and CALIBRATION_MAX_AGE_MS stay the same window.
//
// So what runs below is a SECOND line of defence over rows that have already
// been deduped and aged in the database, not the only one. Keep it anyway: it
// is what makes buildCalibrationAdjustment safe to call with rows from any
// caller, and it is why a future query that forgets a predicate degrades to
// weaker filtering instead of to none.
//
// The one behaviour that is still a graceful degradation rather than a rule:
// a row with a NULL user_id cannot be attributed, so it is counted
// individually instead of being dropped. Nothing writes such a row today
// (venue_feedback.user_id is set from the authenticated caller and CASCADEs on
// delete), and on the single-venue path Postgres collapses NULLs together
// under DISTINCT ON. The batch and alternatives queries do not dedupe in SQL,
// so if a NULL-reporter row ever became writable it would count once per row
// there — worth a predicate in those two SELECTs at that point.
// Likewise a row whose created_at is unreadable is kept, because the SQL
// window has already excluded anything genuinely old.
function usableCalibrationReports(feedbackRows, nowMs) {
  const cutoff = nowMs - CALIBRATION_MAX_AGE_MS;
  const byReporter = new Map();
  const unattributed = [];

  for (const row of feedbackRows) {
    if (!row || typeof row !== 'object') continue;
    // An unrecognized crowd_level used to be scored as 50 — a "Moderate"
    // opinion nobody expressed, manufactured out of a bad row and then given a
    // vote. A row we cannot read is not evidence.
    const score = CROWD_LEVEL_TO_SCORE[row.crowd_level];
    if (score === undefined) continue;

    const at = calibrationRowTime(row);
    if (at != null && at < cutoff) continue;

    if (row.user_id == null) {
      unattributed.push({ score, at });
      continue;
    }
    const key = String(row.user_id);
    const prev = byReporter.get(key);
    // Newest wins. With no timestamps to compare, first seen wins, which is
    // the newest row on the single-venue path (ORDER BY created_at DESC).
    if (!prev || (at != null && (prev.at == null || at > prev.at))) {
      byReporter.set(key, { score, at });
    }
  }

  return [...byReporter.values(), ...unattributed];
}

function buildCalibrationAdjustment(feedbackRows, engineScore, options = {}) {
  const unchanged = (reportCount) => ({
    adjustedScore: engineScore,
    feedbackUsed: false,
    reportCount,
    minReports: MIN_CALIBRATION_REPORTERS,
  });

  if (!Array.isArray(feedbackRows) || feedbackRows.length === 0) return unchanged(0);
  // Numeric strings blend (a caller handing back a DECIMAL as text should not
  // silently disable calibration), but anything that is not a number at all is
  // handed straight back. Note what a bare Number() would do here: null and ''
  // both become 0, so a missing score would be blended as though the model had
  // said "empty", and NaN would be published as the number on the card.
  const engine = (typeof engineScore === 'number'
    || (typeof engineScore === 'string' && engineScore.trim() !== ''))
    ? Number(engineScore)
    : NaN;
  if (!Number.isFinite(engine)) return unchanged(0);

  const reports = usableCalibrationReports(
    feedbackRows,
    Number.isFinite(options.now) ? options.now : Date.now()
  );
  const n = reports.length;
  if (n < MIN_CALIBRATION_REPORTERS) return unchanged(n);

  let sum = 0;
  for (const r of reports) sum += r.score;
  const feedbackScore = sum / n;

  // Weight feedback more as reports accumulate...
  let ladderWeight;
  if (n <= 5) ladderWeight = 0.30;
  else if (n <= 10) ladderWeight = 0.50;
  else if (n <= 20) ladderWeight = 0.65;
  else ladderWeight = 0.75;

  // ...but never so much that one of those reporters is worth more than
  // MAX_SINGLE_REPORT_LEVERAGE points on their own. One reporter can move the
  // mean by at most FEEDBACK_SCORE_SPAN / n, and the blend passes weight * that
  // through to the published score, so this cap is the whole bound. It binds at
  // the floor (n = 3, where the ladder alone would allow 6 points) and goes
  // slack as real reports accumulate.
  const weight = Math.min(ladderWeight, (MAX_SINGLE_REPORT_LEVERAGE * n) / FEEDBACK_SCORE_SPAN);

  const adjustedScore = Math.max(0, Math.min(100, Math.round(
    engine * (1 - weight) + feedbackScore * weight
  )));

  return {
    adjustedScore,
    feedbackUsed: true,
    reportCount: n,
    minReports: MIN_CALIBRATION_REPORTERS,
    feedbackWeight: weight,
    avgFeedbackScore: Math.round(feedbackScore),
    predictionDrift: Math.round(feedbackScore - engine),
  };
}

// ---------------------------------------------------------------------------
// Quieter alternatives
// ---------------------------------------------------------------------------

function findQuieterAlternatives(venues, currentScore, weather, timestamp, limit) {
  const max = limit || 2;
  const scored = venues.map(v => {
    const result = calculateCrowdScore(v, weather, timestamp);
    return {
      placeId: v.place_id,
      name: v.name,
      score: result.score,
      label: result.label,
    };
  });

  return scored
    .filter(v => v.score < currentScore)
    .sort((a, b) => a.score - b.score)
    .slice(0, max);
}

module.exports = {
  calculateCrowdScore,
  generateHourlyForecast,
  estimateCapacity,
  estimateWait,
  findBestTime,
  // Round 13: same decision as findBestTime, but it also hands back WHICH
  // forecast entry it named so a chart can highlight that exact bar.
  recommendBestTime,
  findPeakTime,
  findQuieterAlternatives,
  buildCalibrationAdjustment,
  // The two noise floors, exported so nothing restates either from memory:
  // TIE_MARGIN is the LEVEL floor (what a stranger's report may move, and what
  // routes/venueDashboard.js builds STRIP_ORDERING_MIN_GAP from);
  // HOUR_ORDERING_MIN_GAP is the measured ORDERING floor the best-time line
  // hedges on, and the two are not interchangeable.
  TIE_MARGIN,
  HOUR_ORDERING_MIN_GAP,
  // The single definition of "which number ranks hours inside one venue-night".
  // Exported so anything that has to rank hours OUTSIDE this file uses the same
  // all-or-nothing axis choice instead of a second copy of the rule that could
  // drift from it. One such caller is still outstanding: the owner dashboard's
  // weekly evening peak (routes/venueDashboard.js, the `evening.reduce` in
  // GET /intelligence) still picks its peak hour off model scores. See section
  // 9.6 of scripts/ml/HOUR-RANKING-EVAL.md.
  orderingAxis,
  // The two sentences the best-time line prints when it refuses to name an
  // hour, exported so a test pins the strings this file actually ships.
  NO_WINDOW_LEFT,
  NO_QUIET_HOUR,
  // The calibration guard rails, exported so a route, a client string or a test
  // states the same numbers this file enforces instead of a second copy of them.
  MIN_CALIBRATION_REPORTERS,
  MAX_SINGLE_REPORT_LEVERAGE,
  CALIBRATION_MAX_AGE_MS,
  CROWD_LEVEL_TO_SCORE,
  getLabel,
  // Round 14: colour bands derived from the label bands, so "Busy" is never
  // amber on one card and red on the next.
  getLevel,
  // The evidence policy. One definition of what a crowd number may claim,
  // imported by every payload that publishes one, so a card, a list row and an
  // alternatives entry cannot disagree about whether the same answer is a
  // measurement or a category prior.
  describePredictionSupport,
  publishedConfidence,
  publishedLabel,
  hedgeLabel,
  TIME_ONLY_CONFIDENCE,
  // Exported so the retrain that fixes the corpus can flip one flag and see
  // every test that depends on it move together.
  ML_BASELINE_AXIS_VERIFIED,
  // Round 13: venue-local wall clock from Google's utcOffsetMinutes. The
  // server runs UTC and the visitor may be three time zones from the venue;
  // neither clock is the one the doors run on.
  venueLocalNow,
  // Round 26: the range that makes an offset an offset, exported so
  // routes/crowd.js bounds the body field against ONE definition rather than a
  // second copy of the same two numbers.
  MIN_UTC_OFFSET_MINUTES,
  MAX_UTC_OFFSET_MINUTES,
  // Round 11: exported so anything else that needs an open/closed check uses
  // the wrap-aware helper instead of re-deriving `h >= open && h <= close`.
  hourInWindow,
  isOpenHour,
  // Round 14: day-aware openness. hoursByDay knows Mondays are dark and that
  // 11 AM - 2 PM plus 5 - 10 PM is two windows, not one 11 AM - 2 PM day.
  isOpenAt,
  buildHoursByDay,
  weekdayOffset,
};
