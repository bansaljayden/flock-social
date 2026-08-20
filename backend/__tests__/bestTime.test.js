// "Best time to go" on the live demo told a visitor at 8:49 PM to go at 4 PM,
// and told them "Now is good" next to a red 86% / Very Busy dial. These lock
// both doors: the recommendation only ever points forward, it only ever agrees
// with the score printed beside it, and it reads the venue's clock rather than
// whatever hour the server happens to be in.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  recommendBestTime,
  findBestTime,
  findPeakTime,
  venueLocalNow,
  getLabel,
} = require('../services/crowdEngine');

// --- helpers ---------------------------------------------------------------

function label(h) {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

function parseLabel(text) {
  const m = String(text).match(/(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[2].toUpperCase();
  if (ampm === 'AM' && h === 12) h = 0;
  else if (ampm === 'PM' && h !== 12) h += 12;
  return h;
}

// A forecast in the shape predictHourlyForecast returns: hour labels running
// forward from startHour, scores supplied by the test.
function forecast(startHour, scores) {
  return scores.map((score, i) => ({ hour: label(startHour + i), score, label: getLabel(score) }));
}

// Score every hour of the day, dead in the afternoon and packed at night.
// This is the shape that produced the bug: 4 PM is the quietest hour of the
// day, and it is behind you by 8:49 PM.
function typicalNight() {
  const byHour = {
    6: 10, 7: 15, 8: 20, 9: 22, 10: 25, 11: 45, 12: 60, 13: 55,
    14: 20, 15: 12, 16: 5, 17: 25, 18: 60, 19: 78, 20: 86, 21: 62,
    22: 40, 23: 35, 0: 20, 1: 15, 2: 10, 3: 8, 4: 6, 5: 6,
  };
  return byHour;
}

const RESTAURANT = { types: ['restaurant'], openHour: 11, closeHour: 23 };

// --- 1. a past hour is never recommended -----------------------------------

test('the quietest hour of the day is not recommended once it has passed', () => {
  const byHour = typicalNight();
  // The array the routes used to build: 24 hours starting at 6 AM, scanned
  // with no idea what time it is.
  const fullDay = forecast(6, Array.from({ length: 24 }, (_, i) => byHour[(6 + i) % 24]));

  const at2pm = recommendBestTime(fullDay, RESTAURANT, null, null, true, { currentHour: 14, currentScore: 20 });
  assert.equal(at2pm.hourLabel, '4 PM', '4 PM is still ahead at 2 PM, so it is fair game');

  const at849pm = recommendBestTime(fullDay, RESTAURANT, null, null, true, { currentHour: 20, currentScore: 86 });
  assert.notEqual(at849pm.hourLabel, '4 PM', 'the 8:49 PM bug: an hour that already happened');
  assert.equal(at849pm.text.includes('4 PM'), false);
});

test('every recommended hour is strictly in the future, at every hour of the day', () => {
  const byHour = typicalNight();
  const fullDay = forecast(6, Array.from({ length: 24 }, (_, i) => byHour[(6 + i) % 24]));

  for (let now = 0; now < 24; now++) {
    const rec = recommendBestTime(fullDay, RESTAURANT, null, null, null, {
      currentHour: now,
      currentScore: byHour[now],
    });
    if (rec.hourLabel == null) continue; // the answer was "now" or "no window"
    const named = parseLabel(rec.hourLabel);
    const hoursAway = (named - now + 24) % 24;
    assert.ok(hoursAway > 0, `at ${label(now)} it recommended ${rec.text}, which is not ahead`);
  }
});

test('a forward window can only ever name hours it actually contains', () => {
  // What the routes build now: 24 hours starting at the venue's current hour.
  const byHour = typicalNight();
  const fullDay = forecast(20, Array.from({ length: 24 }, (_, i) => byHour[(20 + i) % 24]));
  const rec = recommendBestTime(fullDay, RESTAURANT, null, null, true, { currentHour: 20, currentScore: 86 });
  // ROUND 14 CORRECTION. This test used to assert '11 PM', on the reasoning
  // that "10 PM and 11 PM are what is left before close". That reasoning was
  // wrong: RESTAURANT has closeHour 23, so the doors lock at 11:00 PM and the
  // hour bucket labelled "11 PM" (11:00-11:59) is closed time. Sending someone
  // to a restaurant at its closing time is the same class of mistake as sending
  // them backwards in time. 10 PM (40) is the last hour you can actually eat.
  assert.equal(rec.hourLabel, '10 PM');
  assert.equal(rec.dayOffset, 0);
  assert.equal(rec.text, '10 PM');
});

test('the closing hour comes back only when the venue really closes past it', () => {
  const byHour = typicalNight();
  const fullDay = forecast(20, Array.from({ length: 24 }, (_, i) => byHour[(20 + i) % 24]));
  // Same venue, but Google says it closes at 11:30 PM. Now the 11 PM bucket is
  // an hour you can genuinely turn up in, so it is fair game again.
  const halfPast = { types: ['restaurant'], openHour: 11, closeHour: 23, closeMinute: 30 };
  const rec = recommendBestTime(fullDay, halfPast, null, null, true, { currentHour: 20, currentScore: 86 });
  assert.equal(rec.hourLabel, '11 PM');
});

// --- 2. a very busy venue never gets an enthusiastic recommendation ---------

test('86% and Very Busy is never sold as "Now is good"', () => {
  // The packed-night card: every hour left is jammed, so "now" really is the
  // least bad hour. The copy has to say that out loud.
  const packed = forecast(20, [86, 88, 90, 84, 82, 85, 87, 83]);
  const rec = recommendBestTime(packed, { types: ['bar'], openHour: 16, closeHour: 2 }, null, null, true, {
    currentHour: 20,
    currentScore: 86,
  });

  assert.equal(getLabel(86), 'Very Busy');
  assert.equal(rec.hourLabel, null, 'nothing ahead is meaningfully quieter');
  assert.match(rec.text, /^Packed now/);
  assert.doesNotMatch(rec.text, /good/i);
});

test('no busy score ever produces enthusiastic copy, whatever the forecast', () => {
  const shapes = [
    [90, 91, 92, 89, 93, 88, 90, 94],   // uniformly packed
    [75, 74, 78, 76, 73, 77, 79, 72],   // uniformly busy
    [95, 95, 95, 95, 95, 95, 95, 95],   // pinned
  ];
  for (const scores of shapes) {
    for (const current of [65, 72, 81, 86, 95]) {
      const rec = recommendBestTime(forecast(20, scores), { types: ['bar'], openHour: 16, closeHour: 2 },
        null, null, true, { currentHour: 20, currentScore: current });
      if (rec.hourLabel != null) continue; // it sent them to a quieter hour, fine
      assert.doesNotMatch(rec.text, /good/i,
        `score ${current} with ${scores.join(',')} produced "${rec.text}"`);
      assert.ok(getLabel(current) === 'Busy' || getLabel(current) === 'Very Busy');
    }
  }
});

test('the recommendation follows the score the card renders, not the first forecast entry', () => {
  // The exact contradiction from the screenshot. The 6 AM entry is quiet, the
  // venue is at 86% right now. Reading entry 0 as "now" is what produced
  // "Now is good" beside a red dial.
  const byHour = typicalNight();
  const fullDay = forecast(6, Array.from({ length: 24 }, (_, i) => byHour[(6 + i) % 24]));
  assert.equal(fullDay[0].score, 10, 'entry 0 is 6 AM and it is dead quiet');

  const rec = recommendBestTime(fullDay, { types: ['bar'], openHour: 16, closeHour: 2 }, null, null, true, {
    currentHour: 20,
    currentScore: 86,
  });
  assert.doesNotMatch(rec.text, /Now is good/);
});

test('a quiet venue still gets a plain "Now is good"', () => {
  const quiet = forecast(20, [18, 30, 40, 45, 50, 42, 38, 35]);
  const rec = recommendBestTime(quiet, { types: ['bar'], openHour: 16, closeHour: 2 }, null, null, true, {
    currentHour: 20,
    currentScore: 18,
  });
  assert.equal(rec.text, 'Now is good');
});

// --- 3. venue-local time, not server time ----------------------------------

test('venueLocalNow reads the venue clock off Google\'s UTC offset', () => {
  const instant = new Date('2026-08-13T02:30:00Z');

  const la = venueLocalNow(-420, instant);       // UTC-7
  const london = venueLocalNow(60, instant);     // UTC+1
  const tokyo = venueLocalNow(540, instant);     // UTC+9

  assert.equal(la.hour, 19, 'still last night in Los Angeles');
  assert.equal(london.hour, 3);
  assert.equal(tokyo.hour, 11);
  // LA has not rolled over to the next day yet, London and Tokyo have.
  assert.equal((la.day + 1) % 7, london.day);
  assert.equal(london.day, tokyo.day);
  assert.equal(venueLocalNow(null, instant), null);
  assert.equal(venueLocalNow(undefined, instant), null);
  assert.equal(venueLocalNow('nonsense', instant), null);
});

test('the same venue gets a different answer for a visitor clock and a venue clock', () => {
  const byHour = typicalNight();
  const fullDay = forecast(6, Array.from({ length: 24 }, (_, i) => byHour[(6 + i) % 24]));
  const instant = new Date('2026-08-13T02:30:00Z');

  // A Los Angeles venue at 7:30 PM local, seen by a visitor whose own clock
  // (and the UTC server's) already says 2:30 AM the next day.
  const venueHour = venueLocalNow(-420, instant).hour;
  const visitorHour = 2;
  assert.equal(venueHour, 19);

  const byVenueClock = recommendBestTime(fullDay, RESTAURANT, null, null, true, {
    currentHour: venueHour, currentScore: byHour[venueHour],
  });
  const byVisitorClock = recommendBestTime(fullDay, RESTAURANT, null, null, true, {
    currentHour: visitorHour, currentScore: byHour[visitorHour],
  });

  assert.notDeepEqual(byVenueClock, byVisitorClock);
  // The venue's own clock keeps the answer inside tonight's remaining service.
  assert.ok(['10 PM', '11 PM'].includes(byVenueClock.hourLabel), `got ${byVenueClock.text}`);
});

test('nothing in the recommendation reads the process clock', () => {
  // If server time leaked in, only one of these 24 calls could be right.
  const byHour = typicalNight();
  const fullDay = forecast(6, Array.from({ length: 24 }, (_, i) => byHour[(6 + i) % 24]));
  const results = new Map();
  for (let now = 0; now < 24; now++) {
    results.set(now, recommendBestTime(fullDay, RESTAURANT, null, null, null, {
      currentHour: now, currentScore: byHour[now],
    }).text);
  }
  // Called twice, same inputs, same answers: no hidden clock, no drift.
  for (let now = 0; now < 24; now++) {
    const again = recommendBestTime(fullDay, RESTAURANT, null, null, null, {
      currentHour: now, currentScore: byHour[now],
    }).text;
    assert.equal(again, results.get(now));
  }
  assert.ok(new Set(results.values()).size > 1, 'the hour has to actually change the answer');
});

// --- closed, closing, and tomorrow -----------------------------------------

test('a closed venue is never told "now"', () => {
  const byHour = typicalNight();
  const fullDay = forecast(6, Array.from({ length: 24 }, (_, i) => byHour[(6 + i) % 24]));
  const rec = recommendBestTime(fullDay, RESTAURANT, null, null, false, { currentHour: 9, currentScore: 22 });
  assert.ok(rec.hourLabel, `expected an hour, got "${rec.text}"`);
  assert.doesNotMatch(rec.text, /Now/);
});

test('when the night is done it names the day, not a bare hour', () => {
  // 10 PM at a restaurant that closes at 10. Nothing open is left today.
  const byHour = typicalNight();
  const fullDay = forecast(22, Array.from({ length: 24 }, (_, i) => byHour[(22 + i) % 24]));
  const venue = { types: ['restaurant'], openHour: 11, closeHour: 22 };
  const rec = recommendBestTime(fullDay, venue, null, null, true, { currentHour: 22, currentScore: 75 });
  assert.equal(rec.dayOffset, 1);
  assert.match(rec.text, /^Tomorrow /);
  assert.equal(rec.text, `Tomorrow ${rec.hourLabel}`);
});

test('the small hours are the same night out, not "tomorrow"', () => {
  // 9 PM Saturday at a club that runs to 3 AM. 2 AM is tonight to anyone
  // standing in the line, so it must not come back as "Tomorrow 2 AM".
  const club = { types: ['night_club'], openHour: 21, closeHour: 3 };
  // 9 PM, 10 PM, 11 PM, then midnight onward. 2 AM is the quiet one.
  const fullDay = forecast(21, [98, 90, 93, 60, 50, 20, 95, 95, 95, 95, 95, 95]);
  const rec = recommendBestTime(fullDay, club, null, null, true, { currentHour: 21, currentScore: 98 });
  assert.equal(rec.hourLabel, '2 AM');
  assert.equal(rec.dayOffset, 0, 'same night, so the chart can still highlight the bar');
  assert.equal(rec.text, '2 AM');
});

test('a morning card still calls the following night tomorrow', () => {
  // The same 1 AM hour seen at 9 AM really is another day, and says so.
  const lateOnly = { types: ['bar'], openHour: 0, closeHour: 2 };
  const fullDay = forecast(9, Array.from({ length: 24 }, (_, i) => (((9 + i) % 24) === 1 ? 10 : 70)));
  const rec = recommendBestTime(fullDay, lateOnly, null, null, false, { currentHour: 9, currentScore: 5 });
  assert.equal(rec.hourLabel, '1 AM');
  assert.equal(rec.dayOffset, 1);
  assert.equal(rec.text, 'Tomorrow 1 AM');
});

test('a quiet venue about to close says so instead of naming an hour', () => {
  const closing = forecast(22, [30, 28]);
  const venue = { types: ['restaurant'], openHour: 11, closeHour: 22 };
  const rec = recommendBestTime(closing, venue, null, null, true, { currentHour: 22, currentScore: 30 });
  assert.equal(rec.text, 'Now, they close soon');
});

test('no open hour left and no reason to stay says exactly that', () => {
  const closing = forecast(22, [75, 70]);
  const venue = { types: ['restaurant'], openHour: 11, closeHour: 22 };
  const rec = recommendBestTime(closing, venue, null, null, true, { currentHour: 22, currentScore: 75 });
  assert.equal(rec.text, 'No good window left today');
  assert.equal(rec.hourLabel, null);
});

test('the peak window is never handed back as the best time', () => {
  const fullDay = forecast(20, [50, 95, 96, 40, 38, 36, 30, 28]);
  // Peak sits at indexes 1-2 (9 PM, 10 PM).
  const peak = findPeakTime(fullDay, { types: ['bar'], openHour: 16, closeHour: 6 });
  const rec = recommendBestTime(fullDay, { types: ['bar'], openHour: 16, closeHour: 6 },
    peak.startIdx, peak.endIdx, true, { currentHour: 20, currentScore: 50 });
  assert.ok(!['9 PM', '10 PM'].includes(rec.hourLabel), `recommended the peak: ${rec.text}`);
});

test('peak after midnight uses the same day convention as the best-time line', () => {
  // ROUND 14 CORRECTION. This test used to assert 'Tomorrow 1 AM'. That is the
  // opposite of what recommendBestTime does with the same hour: at 8 PM it
  // calls 1 AM tonight, because the hours before 5 AM belong to the night
  // before. The two lines sit inches apart on one card, so the card was
  // printing "Peak: Tomorrow 1 AM" above "Best time to go: 2 AM" for the same
  // night. One convention, shared by both.
  const fullDay = forecast(20, [40, 45, 50, 55, 60, 95, 70, 65]); // peak at 1 AM
  const peak = findPeakTime(fullDay, { types: ['bar'], openHour: 16, closeHour: 6 });
  assert.equal(peak.text, '1 AM');

  // Seen from a morning card it really is another day, and still says so.
  const morning = forecast(9, Array.from({ length: 20 }, (_, i) => (((9 + i) % 24) === 1 ? 95 : 20)));
  const late = findPeakTime(morning, { types: ['bar'], openHour: 16, closeHour: 6 });
  assert.equal(late.text, 'Tomorrow 1 AM');
});

// --- the wrapper the routes still call -------------------------------------

test('findBestTime returns the same sentence recommendBestTime decided on', () => {
  const fullDay = forecast(20, [86, 88, 90, 84, 82, 85, 87, 83]);
  const venue = { types: ['bar'], openHour: 16, closeHour: 2 };
  const opts = { currentHour: 20, currentScore: 86 };
  assert.equal(
    findBestTime(fullDay, venue, null, null, true, opts),
    recommendBestTime(fullDay, venue, null, null, true, opts).text
  );
});

test('an empty forecast never invents an hour', () => {
  assert.equal(findBestTime([], RESTAURANT, null, null, true, { currentHour: 20, currentScore: 50 }),
    'No good window left today');
  assert.equal(findBestTime(null, RESTAURANT, null, null, true, { currentHour: 20, currentScore: 50 }),
    'No good window left today');
});

test('no recommendation copy uses an em dash', () => {
  const byHour = typicalNight();
  const fullDay = forecast(6, Array.from({ length: 24 }, (_, i) => byHour[(6 + i) % 24]));
  for (let now = 0; now < 24; now++) {
    for (const score of [10, 45, 65, 86, 99]) {
      for (const isOpen of [true, false, null]) {
        const text = findBestTime(fullDay, RESTAURANT, null, null, isOpen, { currentHour: now, currentScore: score });
        assert.doesNotMatch(text, /[—–]/, `em dash in "${text}"`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// LEVEL STAYS THE MODEL, SHAPE BECOMES THE BASELINE (2026-08-20)
//
// scripts/ml/HOUR-RANKING-EVAL.md measured the two claims separately. On the
// published 0-100 LEVEL the model beats Google's popular-times curve (MAE
// 29.42 vs 31.48, within-10 20.7% vs 19.2%). On ORDERING two hours inside one
// venue-night it does not: 62.7% against the curve's 63.1%, with a venue-block
// bootstrap of the difference at -0.49pp, CI95 [-0.88, -0.12].
//
// So the number on the dial stays the model's and every "which hour is better"
// decision moved onto `baselineScore`, the smoothed popular-times anchor
// mlPredictor already adds its delta to. These tests pin that split: the copy
// must keep reading the model's level while the ranking reads the curve, and
// neither may quietly take the other's job.
// ---------------------------------------------------------------------------

const { HOUR_ORDERING_MIN_GAP, TIE_MARGIN, NO_QUIET_HOUR } = require('../services/crowdEngine');

// Same shape mlPredictor.predictHourlyForecast returns: a model score AND the
// baseline the delta was added to, per hour.
function dualForecast(startHour, entries) {
  return entries.map(([score, baselineScore], i) => ({
    hour: label(startHour + i),
    score,
    baselineScore,
    label: getLabel(score),
    predictionMethod: 'ml',
  }));
}

const OPEN_ALL_EVENING = { types: ['bar'], openHour: 16, closeHour: 2 };

test('the two noise floors are different numbers and neither is the other', () => {
  // TIE_MARGIN is derived from the model's LEVEL error; HOUR_ORDERING_MIN_GAP
  // is derived from the measured ORDERING coin-flip band. Collapsing them back
  // into one constant is the defect this change fixed.
  assert.equal(HOUR_ORDERING_MIN_GAP, 10,
    'the measured coin-flip band: under 10 true points, ordering is 53% for both predictors');
  assert.notEqual(HOUR_ORDERING_MIN_GAP, TIE_MARGIN);
});

test('hours are ordered by the baseline curve, not by the model score', () => {
  // 10 PM is the quietest hour on the MODEL and the busiest on the CURVE.
  // Before this change the card sent you to 10 PM. The curve is the predictor
  // measured to order hours better, so 11 PM is the answer.
  const fullDay = dualForecast(20, [
    [80, 80], // 8 PM  = now
    [70, 75], // 9 PM
    [40, 90], // 10 PM: model says dead, the curve says packed
    [65, 50], // 11 PM: the curve's quietest
  ]);
  const rec = recommendBestTime(fullDay, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 80 });
  assert.equal(rec.orderingBasis, 'baseline');
  assert.equal(rec.hourLabel, '11 PM');
});

test('a claim inside the measured coin-flip band is not made at all', () => {
  const venue = OPEN_ALL_EVENING;
  // 9 points of separation on the curve: inside the band where ordering was
  // measured at 53%, which is a coin flip. The card must not name an hour.
  const tooClose = dualForecast(20, [[70, 70], [66, 63], [64, 61]]);
  const hedged = recommendBestTime(tooClose, venue, null, null, true,
    { currentHour: 20, currentScore: 70 });
  assert.equal(hedged.hourLabel, null, 'nothing may be named inside the band');
  // and what it says instead is chosen from the LEVEL, which is 70 here.
  assert.equal(hedged.text, "Now, but it's busy");

  // 11 points: outside the band, and the claim is allowed.
  const clear = dualForecast(20, [[70, 70], [66, 63], [64, 59]]);
  const named = recommendBestTime(clear, venue, null, null, true,
    { currentHour: 20, currentScore: 70 });
  assert.equal(named.hourLabel, '10 PM');

  // And the boundary is where the constant says it is, not a point either side.
  const exactly = dualForecast(20, [[70, 70], [64, 70 - HOUR_ORDERING_MIN_GAP]]);
  assert.equal(
    recommendBestTime(exactly, venue, null, null, true, { currentHour: 20, currentScore: 70 }).hourLabel,
    null,
    'the gap must be strictly larger than the floor, not equal to it');
});

test('the old 5-point margin no longer licenses a recommendation', () => {
  // Exactly the case the previous rule shipped and the measurement calls a
  // coin flip: a 6-point gap. It cleared TIE_MARGIN; it does not clear the
  // ordering floor.
  const six = dualForecast(20, [[70, 70], [64, 64]]);
  const rec = recommendBestTime(six, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 70 });
  assert.ok(6 > TIE_MARGIN, 'this gap really did clear the old margin');
  assert.equal(rec.hourLabel, null);
});

test('the words about NOW still come from the model score the card prints', () => {
  // The curve is flat, so no hour is named. What is said instead has to be
  // chosen from the published level, which is the half the model wins: a venue
  // at 92 cannot be described as a good time to show up.
  const flat = dualForecast(20, [[92, 70], [90, 68], [91, 69]]);
  const packed = recommendBestTime(flat, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 92 });
  assert.equal(packed.hourLabel, null);
  assert.equal(packed.text, 'Packed now, and it stays that way');

  // Same curve, quiet dial: the level decides the sentence, the curve decided
  // that there was no hour worth naming.
  const quiet = recommendBestTime(flat, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 22 });
  assert.equal(quiet.text, 'Now is good');
});

test('user reports move the level and never the shape', () => {
  // Three verified reporters push the published score from 60 to 85. That is a
  // LEVEL correction and it changes the sentence. It must not change which
  // hour is quietest, because a report about right now says nothing about
  // Google's curve at 11 PM.
  const evening = dualForecast(20, [[60, 60], [58, 55], [50, 40]]);
  const before = recommendBestTime(evening, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 60 });
  const after = recommendBestTime(evening, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 85 });
  assert.equal(before.hourLabel, '10 PM');
  assert.equal(after.hourLabel, '10 PM', "the named hour is the curve's, not the report's");
});

test('one rule-engine hour puts the whole night back on model ordering', () => {
  // A mixed strip must not be ranked half on one number and half on another:
  // that is a third predictor nobody measured. The all-or-nothing rule sends
  // the entire candidate set back to model scores.
  const mixed = dualForecast(20, [[80, 80], [70, 75], [40, 90], [65, 50]]);
  mixed[2] = { ...mixed[2], baselineScore: null, predictionMethod: 'rule_engine_no_baseline' };
  const rec = recommendBestTime(mixed, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 80 });
  assert.equal(rec.orderingBasis, 'model');
  assert.equal(rec.hourLabel, '10 PM', 'on model scores 10 PM is the quietest hour');
});

test('a forecast with no baseline anywhere behaves as it always did', () => {
  // Every existing caller and every test above hands in score-only entries.
  // They must keep getting the model ordering, now hedged at the measured
  // floor rather than the level margin.
  const plain = forecast(20, [70, 68, 45, 66]);
  const rec = recommendBestTime(plain, OPEN_ALL_EVENING, null, null, true,
    { currentHour: 20, currentScore: 70 });
  assert.equal(rec.orderingBasis, 'model');
  assert.equal(rec.hourLabel, '10 PM');
});

test('a closed venue with no hour worth naming says so instead of picking one', () => {
  // Shut now, so "now" can never be the answer and there is no current hour to
  // measure against. The hedge lands on the spread of the shortlist instead.
  const flatEvening = dualForecast(14, [
    [30, 30], [32, 33], [31, 31], [33, 34], [30, 32], [31, 33],
  ]);
  const shut = recommendBestTime(flatEvening, OPEN_ALL_EVENING, null, null, false,
    { currentHour: 14, currentDay: 3, currentScore: 30 });
  assert.equal(shut.hourLabel, null);
  assert.equal(shut.text, NO_QUIET_HOUR);
  assert.doesNotMatch(shut.text, /[—–]/);

  // Give one hour a real trough and it is named again.
  const withTrough = dualForecast(14, [
    [30, 30], [32, 33], [31, 31], [33, 34], [30, 32], [31, 18],
  ]);
  const named = recommendBestTime(withTrough, OPEN_ALL_EVENING, null, null, false,
    { currentHour: 14, currentDay: 3, currentScore: 30 });
  assert.equal(named.hourLabel, '7 PM');
});

test('a shortlist of one is named whatever its spread, because it is not a ranking', () => {
  const venue = { types: ['restaurant'], openHour: 19, closeHour: 20 };
  const one = dualForecast(14, [[30, 30], [40, 41], [41, 42], [42, 43], [40, 41], [39, 40]]);
  const rec = recommendBestTime(one, venue, null, null, false,
    { currentHour: 14, currentDay: 3, currentScore: 30 });
  assert.ok(rec.hourLabel, 'the only open hour ahead is an answer, not a comparison');
});

test('the peak window is chosen on the same axis the ranking uses', () => {
  // If the peak came off model scores while the ranking came off the curve,
  // recommendBestTime would be excluding hours its own ordering never called
  // busy. 10 PM is the model's peak; 8 PM is the curve's.
  const evening = dualForecast(19, [
    [40, 45], // 7 PM
    [50, 92], // 8 PM: the curve's peak
    [60, 50], // 9 PM
    [95, 55], // 10 PM: the model's peak
  ]);
  const peak = findPeakTime(evening, OPEN_ALL_EVENING);
  assert.equal(peak.text, '8 PM');

  // Score-only entries keep the old behaviour.
  const plain = forecast(19, [40, 50, 60, 95]);
  assert.equal(findPeakTime(plain, OPEN_ALL_EVENING).text, '10 PM');
});

test('the best-time line never names an hour the peak window covers', () => {
  // The exclusion and the ranking now read one number, so this holds on the
  // curve the same way it held on the model.
  const evening = dualForecast(19, [[40, 45], [50, 92], [60, 90], [95, 55]]);
  const peak = findPeakTime(evening, OPEN_ALL_EVENING);
  const rec = recommendBestTime(evening, OPEN_ALL_EVENING, peak.startIdx, peak.endIdx, true,
    { currentHour: 19, currentScore: 40 });
  for (let i = peak.startIdx; i <= peak.endIdx; i++) {
    assert.notEqual(rec.hourLabel, evening[i].hour);
  }
});
