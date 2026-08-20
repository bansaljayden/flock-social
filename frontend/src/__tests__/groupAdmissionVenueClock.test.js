/**
 * GROUP ADMISSION READS THE VENUE'S CLOCK, AND THE HOUR ON SCREEN.
 *
 * `getGroupAdmission` is the party-size verdict on the venue sheet: pick 1-7+,
 * get "Walk right in" / "Should be fine" / "Might wait briefly" / "Expect a
 * wait" / "Call ahead recommended". It is time-aware — weekend evenings, the
 * dinner rush, and the late-bar window all raise the pressure on a group.
 *
 * It used to read that time off `new Date()`: THE PHONE. That is the exact bug
 * class the rest of this codebase spent three passes killing (migration 023,
 * crowdEngine.venueLocalNow, the ML_BASELINE_AXIS_VERIFIED work, and the
 * decision that a bar in LA shows LA's night). A user in California opening a
 * Philadelphia bar at 10 PM Friday is asking about 1 AM Saturday there; the old
 * code answered for Friday evening and charged the group weekend-peak pressure
 * on a room that had already emptied.
 *
 * What this suite pins:
 *   1. THE VENUE'S CLOCK DECIDES. Across a real timezone gap the verdict
 *      follows the venue's hour and weekday, and the device clock cannot move
 *      it — the same inputs give the same answer whatever the phone says.
 *   2. THE HOUR ON SCREEN DECIDES. The verdict is computed for the hour whose
 *      score was handed in, not for "now", so a forecast strip showing a
 *      different bar gets that bar's answer.
 *   3. NO CLOCK, NO VERDICT. There is no device-clock fallback to regress to.
 *   4. BRANCH ORDER. A venue typed both `bar` and `night_club` is read as a
 *      bar, which is what the same card's score curve and wait estimate already
 *      read it as. A room typed `night_club` alone is unchanged.
 *   5. SOURCE PIN: the function body never touches the device clock again.
 *
 * Source-scanning, like every other App.js suite here.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test groupAdmissionVenueClock --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// Pull the function declaration out of App.js and evaluate it on its own.
// App.js cannot be imported (it is the whole app), and the point of the suite
// is the function's arithmetic, so we lift just the declaration. Brace matching
// skips strings and comments so a `{` inside either cannot end the body early.
// ───────────────────────────────────────────────────────────────────────────
function extractFunction(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start === -1) throw new Error(`extractFunction: no module-scope \`function ${name}(\` in source`);
  let i = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`extractFunction: unterminated body for ${name}`);
}

const SRC = extractFunction(APP, 'getGroupAdmission');
// eslint-disable-next-line no-new-func
const getGroupAdmission = new Function(`${SRC}\nreturn getGroupAdmission;`)();

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

// ───────────────────────────────────────────────────────────────────────────
// Fixtures. Review counts are pinned because sizeFactor is derived from them.
// ───────────────────────────────────────────────────────────────────────────
const BAR = { types: ['bar'], user_ratings_total: 0 };
const BAR_AND_CLUB = { types: ['bar', 'night_club'], user_ratings_total: 0 };
const CLUB_ONLY = { types: ['night_club'], user_ratings_total: 0 };
const RESTAURANT = { types: ['restaurant'], user_ratings_total: 0 };

// The venueLocalNow arithmetic the server ships as `venueClock` (crowdEngine.js
// venueLocalNow → routes/crowd.js `venueClock`). Reproduced here only to build
// the scenario honestly; the client is handed the result, it does not compute it.
const venueClockFor = (utcOffsetMinutes, instant) => {
  const shifted = new Date(instant.getTime() + utcOffsetMinutes * 60000);
  return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
};

// Friday 2026-08-21, 22:00 Pacific — which is Saturday 01:00 in Philadelphia.
const INSTANT = new Date(Date.UTC(2026, 7, 22, 5, 0, 0));
const PACIFIC = -420;      // PDT
const EASTERN = -240;      // EDT

describe('1. the venue is on its own clock', () => {
  test('a Californian reading a Philadelphia bar gets Philadelphia\'s hour', () => {
    const phone = venueClockFor(PACIFIC, INSTANT);
    const venue = venueClockFor(EASTERN, INSTANT);

    // The scenario is real: the phone says Friday 10 PM, the bar says Saturday 1 AM.
    expect(phone).toEqual({ hour: 22, day: 5 });
    expect(venue).toEqual({ hour: 1, day: 6 });

    const onThePhone = getGroupAdmission(50, 5, BAR, phone);
    const atTheVenue = getGroupAdmission(50, 5, BAR, venue);

    // Friday 10 PM is peak weekend-bar pressure. Saturday 1 AM is not.
    expect(onThePhone.text).toBe('Expect a wait');
    expect(atTheVenue.text).toBe('Might wait briefly');
    expect(atTheVenue.text).not.toBe(onThePhone.text);
  });

  test('the device clock cannot move the answer', () => {
    const venue = venueClockFor(EASTERN, INSTANT);
    const answers = [
      new Date(Date.UTC(2026, 7, 22, 5, 0, 0)),   // the real instant
      new Date(Date.UTC(2026, 0, 5, 14, 0, 0)),   // a Monday lunchtime
      new Date(Date.UTC(2026, 11, 25, 3, 0, 0)),  // Christmas, small hours
    ].map((sysTime) => {
      jest.useFakeTimers().setSystemTime(sysTime);
      try {
        return getGroupAdmission(50, 5, BAR, venue).text;
      } finally {
        jest.useRealTimers();
      }
    });

    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe('Might wait briefly');
  });

  test('an out-of-range hour or weekday is normalised, not trusted raw', () => {
    const venue = venueClockFor(EASTERN, INSTANT);
    expect(getGroupAdmission(50, 5, BAR, { hour: venue.hour + 24, day: venue.day + 7 }).text)
      .toBe(getGroupAdmission(50, 5, BAR, venue).text);
    expect(getGroupAdmission(50, 5, BAR, { hour: -23, day: -1 }).text)
      .toBe(getGroupAdmission(50, 5, BAR, { hour: 1, day: 6 }).text);
  });
});

describe('2. the verdict is for the hour on screen', () => {
  test('the same score at a different hour is a different verdict', () => {
    // One venue, one Saturday, one crowd score — only the hour moves.
    const afternoon = getGroupAdmission(50, 5, BAR, { hour: 15, day: 6 });
    const lateNight = getGroupAdmission(50, 5, BAR, { hour: 22, day: 6 });

    expect(afternoon.text).toBe('Might wait briefly');
    expect(lateNight.text).toBe('Expect a wait');
  });

  test('table venues move on the dinner rush, not the bar window', () => {
    // Tuesday: no weekend pressure either way, so this isolates the branch.
    const lateAfternoon = getGroupAdmission(57, 4, RESTAURANT, { hour: 15, day: 2 });
    const dinner = getGroupAdmission(57, 4, RESTAURANT, { hour: 19, day: 2 });

    expect(lateAfternoon.text).toBe('Might wait briefly');
    expect(dinner.text).toBe('Expect a wait');
  });
});

describe('3. no clock, no verdict', () => {
  test.each([
    ['omitted', undefined],
    ['null', null],
    ['hour missing', { day: 6 }],
    ['day missing', { hour: 1 }],
    ['hour NaN', { hour: NaN, day: 6 }],
    ['hour a string', { hour: '1', day: 6 }],
  ])('%s → null rather than a guess', (_label, clock) => {
    expect(getGroupAdmission(50, 5, BAR, clock)).toBeNull();
  });

  test('a missing crowd score still returns null, and 0 is still a score', () => {
    expect(getGroupAdmission(null, 5, BAR, { hour: 1, day: 6 })).toBeNull();
    expect(getGroupAdmission(undefined, 5, BAR, { hour: 1, day: 6 })).toBeNull();
    expect(getGroupAdmission(0, 5, BAR, { hour: 1, day: 6 })).not.toBeNull();
  });
});

describe('4. branch order: bar beats nightclub', () => {
  const CLOCK = { hour: 20, day: 2 }; // Tuesday 8 PM — no weekend or late-bar multiplier

  test('a venue typed both bar and night_club is read as a bar', () => {
    // perPersonImpact 1.5 (bar) vs 1.2 (entertainment) lands these in different
    // bands at the same score, which is the whole point: the old order gave this
    // venue a nightclub reading while the same card's genHourly curve and
    // getWait estimate both read it as a bar.
    expect(getGroupAdmission(55, 6, BAR_AND_CLUB, CLOCK).text).toBe('Expect a wait');
    expect(getGroupAdmission(55, 6, BAR, CLOCK).text).toBe('Expect a wait');
  });

  test('a room typed night_club alone is unchanged', () => {
    expect(getGroupAdmission(55, 6, CLUB_ONLY, CLOCK).text).toBe('Might wait briefly');
  });

  test('the bar branch is declared before the entertainment branch', () => {
    const code = stripComments(SRC);
    const barBranch = code.indexOf("'sports_bar'");
    const entertainmentBranch = code.indexOf("'trampoline_park'");
    expect(barBranch).toBeGreaterThan(-1);
    expect(entertainmentBranch).toBeGreaterThan(-1);
    expect(barBranch).toBeLessThan(entertainmentBranch);
  });

  test('open-capacity venues are still short-circuited ahead of everything', () => {
    // Reordering the chain must not have broken the branches above it.
    expect(getGroupAdmission(95, 7, { types: ['park'], user_ratings_total: 0 }, { hour: 20, day: 6 }).text)
      .toBe('No issues for groups');
    expect(getGroupAdmission(95, 7, { types: ['movie_theater'], user_ratings_total: 0 }, { hour: 20, day: 6 }).text)
      .toBe('Book ahead for group');
  });
});

describe('5. source pins', () => {
  test('the function body never reads the device clock', () => {
    const code = stripComments(SRC);
    expect(code).not.toMatch(/new\s+Date\s*\(/);
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/getTimezoneOffset/);
  });

  test('it takes a clock argument', () => {
    expect(SRC).toMatch(/^function getGroupAdmission\(crowdScore, partySize, venue, clock\)/m);
  });

  test('every call site hands it the venue clock, never the phone', () => {
    const code = stripComments(APP);
    const calls = code.match(/getGroupAdmission\([^)]*\)/g) || [];
    // The declaration plus exactly one call.
    expect(calls.length).toBe(2);
    expect(calls).toContain('getGroupAdmission(score, partySize, activeVenue, { hour: nowHour, day: nowDay })');
  });

  test('nowHour and nowDay are the venue clock, not the device clock', () => {
    const code = stripComments(APP);
    // The chart already resolved this: cd.venueClock when the server could
    // resolve the venue's offset, the caller's clock only where the server
    // itself fell back. If this ever stops being true the verdict silently
    // goes back on the phone.
    expect(code).toMatch(/const vClock = cd\?\.venueClock\?\.local \? cd\.venueClock : null;/);
    expect(code).toMatch(/const nowHour = vClock \? vClock\.hour : deviceHour;/);
    expect(code).toMatch(/const nowDay = vClock \? vClock\.day : new Date\(\)\.getDay\(\);/);
  });
});
