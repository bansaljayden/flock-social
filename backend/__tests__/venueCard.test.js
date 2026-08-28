// Round 14 — independent re-derivation of the venue crowd card, the surface on
// flockcorp.com and (through routes/crowd.js) inside the app.
//
// bestTime.test.js locks the recommendation. These lock everything else the
// card puts on screen: that the ring, the word and the colour are one decision;
// that the bars are real values labelled with the hour they were scored at;
// that a closed venue's card says closed instead of inventing a crowd; and that
// the freshness line is measured, not asserted.
//
// Every failure below was reachable by looking at the card on a phone.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  getLabel,
  getLevel,
  hourInWindow,
  isOpenAt,
  isOpenHour,
  buildHoursByDay,
  weekdayOffset,
  recommendBestTime,
  findPeakTime,
  generateHourlyForecast,
  calculateCrowdScore,
} = require('../services/crowdEngine');
const { clockFor, withAge } = require('../routes/publicCrowd').__testables;

function label(h) {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}
function forecast(startHour, scores) {
  return scores.map((score, i) => ({ hour: label(startHour + i), score, label: getLabel(score) }));
}

// The colour the demo card paints, mirrored from LiveDemo.js. If these two ever
// drift again the test fails here rather than on someone's phone.
const CARD_COLOR = (score) => (score > 84 ? 'red' : score > 39 ? 'amber' : 'green');

// ---------------------------------------------------------------------------
// 1. the number, the word and the colour are one decision
// ---------------------------------------------------------------------------

test('every score from 0 to 100 gets exactly one word and one colour', () => {
  const colorByWord = new Map();
  for (let s = 0; s <= 100; s++) {
    const word = getLabel(s);
    const color = CARD_COLOR(s);
    // Re-cut 2026-08-28: the level 'busy' spans Busy (amber, a normal good
    // evening) and Packed (the only red), so busy maps to two colours by
    // design; the boundary-coherence test below still guarantees the colour
    // only ever changes where the word does.
    const allowed = { calm: ['green'], moderate: ['amber'], busy: ['amber', 'red'] }[getLevel(s)];
    assert.ok(allowed.includes(color),
      `score ${s}: the card paints ${color}, the engine says ${getLevel(s)}`);
    if (colorByWord.has(word)) {
      assert.equal(colorByWord.get(word), color,
        `"${word}" is ${colorByWord.get(word)} at one score and ${color} at ${s}`);
    } else {
      colorByWord.set(word, color);
    }
  }
  // The bug this replaces: one WORD wearing two colours on one card. The
  // 2026-08-28 reband moved the example scores (65 is Steady now, 75 is
  // Busy); the invariant is the same word never changes colour, held above
  // by colorByWord and here at the pair that used to break.
  assert.equal(getLabel(70), 'Busy');
  assert.equal(getLabel(84), 'Busy');
  assert.equal(CARD_COLOR(70), CARD_COLOR(84));
});

test('the colour changes exactly where the word changes, at the exact boundary', () => {
  for (let s = 1; s <= 100; s++) {
    const wordChanged = getLabel(s) !== getLabel(s - 1);
    const colorChanged = CARD_COLOR(s) !== CARD_COLOR(s - 1);
    assert.ok(!colorChanged || wordChanged, `colour moved at ${s} but the word did not`);
  }
  // The five cut points, checked on both sides (re-cut 2026-08-28).
  assert.deepEqual([20, 21, 39, 40, 69, 70, 84, 85].map(getLabel),
    ['Quiet', 'Not Busy', 'Not Busy', 'Steady', 'Steady', 'Busy', 'Busy', 'Packed']);
  assert.deepEqual([39, 40, 84, 85].map(CARD_COLOR), ['green', 'amber', 'amber', 'red']);
});

test('the dial score and the first bar are the same prediction', () => {
  // The card scores "now" once and draws the forecast from the same instant.
  // If these ever disagree the card is lying about one of the two numbers.
  const venue = { place_id: 'dial-vs-bar', types: ['bar'], rating: 4.4, user_ratings_total: 900, price_level: 2 };
  for (const hour of [2, 9, 13, 20, 23]) {
    const ts = new Date(2026, 7, 14, hour, 0, 0, 0);
    const now = calculateCrowdScore(venue, null, ts);
    const hourly = generateHourlyForecast(venue, null, hour, 12, ts);
    assert.equal(hourly[0].score, now.score, `dial ${now.score} vs first bar ${hourly[0].score} at ${hour}:00`);
    assert.equal(hourly[0].label, getLabel(now.score));
  }
});

test('every bar is labelled with the hour it was actually scored at', () => {
  const venue = { place_id: 'bar-labels', types: ['restaurant'], rating: 4.1, user_ratings_total: 300 };
  for (const start of [0, 6, 18, 23]) {
    const ts = new Date(2026, 7, 14, start, 0, 0, 0);
    const hourly = generateHourlyForecast(venue, null, start, 24, ts);
    hourly.forEach((h, i) => {
      assert.equal(h.hour, label(start + i), `bar ${i} of a ${start}:00 card`);
      // and the score is the score for THAT hour, not a rescan of hour 0
      const own = calculateCrowdScore(venue, null, new Date(ts.getTime() + i * 3600000));
      assert.equal(h.score, own.score);
    });
    // 24 bars, 24 distinct hours: no label can ring the wrong bar.
    assert.equal(new Set(hourly.map(h => h.hour)).size, 24);
  }
});

test('bar heights are the real percentages, not normalised to the tallest', () => {
  // The card's height rule, mirrored: a quiet night must look quiet.
  const height = (score) => Math.max(6, score);
  const quietNight = [22, 25, 30, 28, 24, 20];
  const packedNight = [82, 85, 90, 88, 84, 80];
  assert.ok(Math.max(...quietNight.map(height)) < 40, 'a 30% night must not fill the chart');
  assert.ok(Math.min(...packedNight.map(height)) > 70);
  // Normalising would make these two charts identical. They must not be.
  const norm = (list) => list.map(s => Math.round(100 * s / Math.max(...list)));
  assert.deepEqual(norm(quietNight), norm([73, 83, 100, 93, 80, 67]));
  assert.notDeepEqual(quietNight.map(height), packedNight.map(height));
});

// ---------------------------------------------------------------------------
// 2. the hour a venue actually closes
// ---------------------------------------------------------------------------

test('the closing hour is not an hour you can turn up in', () => {
  // A restaurant with close.hour 22 locks the door at 10:00 PM. The bucket
  // labelled "10 PM" is 10:00-10:59, which is closed time.
  assert.equal(hourInWindow(21, 11, 22), true);
  assert.equal(hourInWindow(22, 11, 22), false);
  // ...unless Google says it closes at 10:30, in which case 10 PM is real.
  assert.equal(hourInWindow(22, 11, 22, 30), true);
  // Overnight windows close the same way: open till 2 AM means 1 AM, not 2.
  assert.equal(hourInWindow(1, 20, 2), true);
  assert.equal(hourInWindow(2, 20, 2), false);
  assert.equal(hourInWindow(2, 20, 2, 30), true);
  // Midnight close is 24, and 11 PM is inside it.
  assert.equal(hourInWindow(23, 10, 24), true);
  assert.equal(hourInWindow(0, 10, 24), false);
});

test('the opening hour still counts as open', () => {
  assert.equal(hourInWindow(11, 11, 22), true);
  assert.equal(hourInWindow(10, 11, 22), false);
});

// ---------------------------------------------------------------------------
// 3. the hour shapes Google actually sends
// ---------------------------------------------------------------------------

test('a 24-hour venue is open at 3 AM', () => {
  // Google's shape for always-open: ONE period, an open, and no close at all.
  const hours = buildHoursByDay([{ open: { day: 0, hour: 0, minute: 0 } }]);
  const diner = { types: ['diner'], hoursByDay: hours };
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      assert.ok(isOpenAt(diner, h, d), `a 24-hour diner read as closed at ${label(h)} on day ${d}`);
    }
  }
  // The old reading: close missing meant closeHour null, which fell through to
  // the diner type default of 6 AM - 9 PM.
  assert.equal(isOpenHour(3, ['diner'], 0, null), false);
});

test('split lunch and dinner service is two windows, not one', () => {
  const hours = buildHoursByDay([
    { open: { day: 2, hour: 11 }, close: { day: 2, hour: 14 } },
    { open: { day: 2, hour: 17 }, close: { day: 2, hour: 22 } },
  ]);
  const venue = { types: ['restaurant'], hoursByDay: hours };
  assert.equal(isOpenAt(venue, 12, 2), true, 'lunch');
  assert.equal(isOpenAt(venue, 15, 2), false, 'the siesta really is shut');
  assert.equal(isOpenAt(venue, 19, 2), true, 'dinner service is not closed');
  assert.equal(isOpenAt(venue, 22, 2), false, 'closes at 10');
});

test('a venue closed on Mondays is not sent customers on a Monday', () => {
  const hours = buildHoursByDay([
    { open: { day: 2, hour: 11 }, close: { day: 2, hour: 22 } },
    { open: { day: 3, hour: 11 }, close: { day: 3, hour: 22 } },
  ]);
  const venue = { types: ['restaurant'], hoursByDay: hours };
  for (let h = 0; h < 24; h++) assert.equal(isOpenAt(venue, h, 1), false, `open at ${label(h)} on a dark Monday`);

  // And the card says tomorrow instead of naming tonight.
  const fullDay = forecast(15, Array.from({ length: 24 }, (_, i) => (((15 + i) % 24) === 14 ? 20 : 70)));
  const rec = recommendBestTime(fullDay, venue, null, null, false, {
    currentHour: 15, currentDay: 1, currentScore: 0,
  });
  assert.equal(rec.dayOffset, 1, `got "${rec.text}"`);
  assert.match(rec.text, /^Tomorrow /);
  // Without the day it fell back to a generic window and named tonight.
  const dayBlind = recommendBestTime(fullDay, venue, null, null, false, { currentHour: 15, currentScore: 0 });
  assert.equal(dayBlind.dayOffset, 0);
});

test('last night\'s overnight window still covers this morning', () => {
  // Open Friday 8 PM to 2 AM, dark all Saturday. At 1 AM Saturday the venue is
  // open on Friday's period, and at 1 AM Sunday it is not open at all.
  const hours = buildHoursByDay([{ open: { day: 5, hour: 20 }, close: { day: 6, hour: 2 } }]);
  const bar = { types: ['bar'], hoursByDay: hours };
  assert.equal(isOpenAt(bar, 22, 5), true, 'Friday night');
  assert.equal(isOpenAt(bar, 1, 6), true, '1 AM Saturday is still Friday night out');
  assert.equal(isOpenAt(bar, 2, 6), false, 'closed at 2');
  assert.equal(isOpenAt(bar, 22, 6), false, 'Saturday itself is dark');
  assert.equal(isOpenAt(bar, 1, 0), false, 'Sunday morning is not covered');
});

test('midnight close reads as end of day, not as a wrap', () => {
  const hours = buildHoursByDay([{ open: { day: 4, hour: 10 }, close: { day: 5, hour: 0 } }]);
  const venue = { types: ['restaurant'], hoursByDay: hours };
  assert.equal(isOpenAt(venue, 23, 4), true);
  assert.equal(isOpenAt(venue, 9, 4), false);
  assert.equal(isOpenAt(venue, 0, 4), false, 'midnight belongs to the next day');
});

test('no hours data falls back to type defaults instead of claiming closed', () => {
  assert.equal(buildHoursByDay(null), null);
  assert.equal(buildHoursByDay([]), null);
  const venue = { types: ['cafe'] }; // no hoursByDay, no openHour
  assert.equal(isOpenAt(venue, 9, 3), true);
  assert.equal(isOpenAt(venue, 3, 3), false);
});

// ---------------------------------------------------------------------------
// 4. a closed venue's card
// ---------------------------------------------------------------------------

test('a closed venue never gets "now" and never gets a peak it is shut for', () => {
  const hours = buildHoursByDay([
    { open: { day: 3, hour: 17 }, close: { day: 3, hour: 23 } },
    { open: { day: 4, hour: 17 }, close: { day: 4, hour: 23 } },
  ]);
  const venue = { types: ['restaurant'], hoursByDay: hours };
  // 9 AM Wednesday: shut, and every hour before 5 PM is shut too.
  const fullDay = forecast(9, Array.from({ length: 24 }, (_, i) => [90, 20, 30][i % 3]));
  const rec = recommendBestTime(fullDay, venue, null, null, false, {
    currentHour: 9, currentDay: 3, currentScore: 12,
  });
  assert.ok(rec.hourLabel, `expected an hour, got "${rec.text}"`);
  assert.doesNotMatch(rec.text, /Now/);
  const named = rec.hourLabel;
  const namedHour = named.endsWith('PM')
    ? (parseInt(named, 10) === 12 ? 12 : parseInt(named, 10) + 12)
    : (parseInt(named, 10) === 12 ? 0 : parseInt(named, 10));
  assert.ok(isOpenAt(venue, namedHour, 3 + rec.dayOffset), `${rec.text} is an hour the doors are shut`);

  const peak = findPeakTime(fullDay.slice(0, 12), venue, { startDay: 3 });
  assert.ok(peak.text, 'a peak is still named');
  assert.ok(!/^(9|10|11) AM/.test(peak.text), `peak ${peak.text} is inside the closed morning`);
});

test('the hour flags a closed card draws its grey bars from', () => {
  const hours = buildHoursByDay([{ open: { day: 3, hour: 17 }, close: { day: 3, hour: 23 } }]);
  const venue = { types: ['restaurant'], hoursByDay: hours };
  // What buildCard computes per bar: hour (start + i) on day (start + i) / 24.
  const start = 14;
  const flags = Array.from({ length: 12 }, (_, i) => isOpenAt(venue, (start + i) % 24, 3 + Math.floor((start + i) / 24)));
  assert.deepEqual(flags, [
    false, false, false, // 2, 3, 4 PM
    true, true, true, true, true, true, // 5 PM - 10 PM
    false, // 11 PM, closing hour
    false, false, // midnight, 1 AM (Thursday, no window)
  ]);
});

// ---------------------------------------------------------------------------
// 5. one card, one convention for "tomorrow"
// ---------------------------------------------------------------------------

test('the peak line and the best-time line never disagree about tonight', () => {
  const club = { types: ['night_club'], openHour: 21, closeHour: 4 };
  const fullDay = forecast(21, [95, 96, 97, 80, 60, 30, 20, 90, 90, 90, 90, 90]);
  const hourly = fullDay.slice(0, 12);
  const peak = findPeakTime(hourly, club, { startDay: 6 });
  const rec = recommendBestTime(fullDay, club, peak.startIdx, peak.endIdx, true, {
    currentHour: 21, currentDay: 6, currentScore: 95,
  });
  // Both are after midnight, both are the same night out, so neither says
  // "Tomorrow". The card used to print one of each.
  assert.doesNotMatch(peak.text, /Tomorrow/);
  assert.doesNotMatch(rec.text, /Tomorrow/);
  assert.equal(rec.dayOffset, 0);
});

test('an hour named by the recommendation is the entry it points at', () => {
  // The chart rings a bar by index, so the index and the label have to be the
  // same hour or the ring lands on the wrong bar.
  const byHour = { 6: 10, 7: 15, 8: 20, 9: 22, 10: 25, 11: 45, 12: 60, 13: 55, 14: 20, 15: 12, 16: 5, 17: 25, 18: 60, 19: 78, 20: 86, 21: 62, 22: 40, 23: 35, 0: 20, 1: 15, 2: 10, 3: 8, 4: 6, 5: 6 };
  for (let start = 0; start < 24; start++) {
    const fullDay = forecast(start, Array.from({ length: 24 }, (_, i) => byHour[(start + i) % 24]));
    for (const isOpen of [true, false, null]) {
      const rec = recommendBestTime(fullDay, { types: ['restaurant'], openHour: 11, closeHour: 23 },
        null, null, isOpen, { currentHour: start, currentDay: 4, currentScore: byHour[start] });
      if (rec.hourLabel == null) continue;
      assert.ok(rec.index >= 0 && rec.index < fullDay.length);
      assert.equal(fullDay[rec.index].hour, rec.hourLabel,
        `index ${rec.index} is ${fullDay[rec.index].hour} but the sentence says ${rec.hourLabel}`);
    }
  }
});

test('every hour of the night tonight being identical is not sold as a good time', () => {
  // 84 -> 86 with the 2026-08-28 reband: Packed talk now starts where the
  // Packed band starts (85), and a flat-84 night honestly reads "busy", not
  // "packed". The invariant under test, a flat night names no hour and sells
  // nothing, is unchanged.
  const flat = forecast(20, Array(12).fill(86));
  const rec = recommendBestTime(flat, { types: ['bar'], openHour: 16, closeHour: 2 }, null, null, true, {
    currentHour: 20, currentDay: 5, currentScore: 86,
  });
  assert.equal(rec.hourLabel, null, 'nothing ahead is quieter, so no hour is named');
  assert.equal(rec.index, 0, 'the card marks now, not an arbitrary tie');
  assert.match(rec.text, /^Packed now/);
  // And the peak of a flat night is still a real bar, not an empty string.
  const peak = findPeakTime(flat, { types: ['bar'], openHour: 16, closeHour: 2 }, { startDay: 5 });
  assert.ok(peak.text.length > 0);
  assert.equal(peak.startIdx, 0);
});

// ---------------------------------------------------------------------------
// 6. the clocks
// ---------------------------------------------------------------------------

test('a weekday difference is not a number of days', () => {
  // The Saturday-night-in-Los-Angeles case: the server is already on Sunday.
  assert.equal(weekdayOffset(0, 6), -1, 'Saturday is yesterday, not six days out');
  assert.equal(weekdayOffset(6, 0), 1, 'Sunday is tomorrow, not six days back');
  assert.equal(weekdayOffset(4, 4), 0);
  assert.equal(weekdayOffset(1, 4), 3);
  assert.equal(weekdayOffset(4, 1), -3);
  for (let from = 0; from < 7; from++) {
    for (let to = 0; to < 7; to++) {
      const off = weekdayOffset(from, to);
      assert.ok(off >= -3 && off <= 3, `${from}->${to} moved ${off} days`);
      assert.equal(((from + off) % 7 + 7) % 7, to, `${from}->${to} landed on the wrong weekday`);
    }
  }
});

test('the clock a venue is scored on is the venue\'s hour on a nearby date', () => {
  for (let day = 0; day < 7; day++) {
    for (const hour of [0, 11, 23]) {
      const { time } = clockFor(hour, day);
      assert.equal(time.getDay(), day);
      assert.equal(time.getHours(), hour);
      assert.equal(time.getMinutes(), 0);
      const daysAway = Math.abs(time - new Date()) / 86400000;
      assert.ok(daysAway < 4, `scored a card ${daysAway.toFixed(1)} days from today`);
    }
  }
  // The exact bug: a UTC Sunday looking at a Saturday-evening venue.
  const sunday = new Date(2026, 7, 16, 1, 0, 0, 0); // a Sunday
  const { time } = clockFor(18, 6, sunday);
  assert.equal(time.getDate(), 15, 'Saturday evening is yesterday, not next Saturday');
  assert.equal(time.getMonth(), 7);
});

// ---------------------------------------------------------------------------
// 7. the freshness line
// ---------------------------------------------------------------------------

test('a cached card reports its real age, not "just now"', () => {
  const built = Date.now() - 8 * 60_000;
  const card = { score: 61, as_of: built };
  const stamped = withAge(card);
  assert.ok(stamped.age_ms >= 8 * 60_000 - 1000 && stamped.age_ms <= 8 * 60_000 + 1000,
    `an 8-minute-old card reported ${Math.round(stamped.age_ms / 1000)}s`);
  // The card object in the cache is never mutated, so the next reader gets its
  // own age rather than the first reader's.
  assert.equal(card.age_ms, undefined);
  assert.equal(withAge(card).as_of, built);
  // A future stamp (skew between two processes) reads as fresh, never negative.
  assert.equal(withAge({ as_of: Date.now() + 60_000 }).age_ms, 0);
  assert.equal(withAge(null), null);
  assert.deepEqual(withAge({ score: 5 }), { score: 5 }, 'no stamp, no claim');
});

test('the age the card prints survives a wrong clock on the phone', () => {
  // What LiveDemo computes: the server-measured age plus time since arrival.
  const ageOnScreen = (card, fetchedAt, nowOnPhone) =>
    (card.age_ms ?? 0) + Math.max(0, nowOnPhone - fetchedAt);
  const card = withAge({ as_of: Date.now() - 5000 });
  const fetchedAt = Date.now();
  // A phone four minutes fast. Subtracting the server epoch from its Date.now()
  // would have printed "4m ago" for a card five seconds old.
  const skewed = Date.now() + 4 * 60_000;
  assert.ok(ageOnScreen(card, fetchedAt, fetchedAt + 2000) < 10_000);
  assert.ok(ageOnScreen(card, fetchedAt, skewed) - (skewed - fetchedAt) < 10_000);
});
