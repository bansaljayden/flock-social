/**
 * THE BACK HALF OF THE PRODUCT, AND THE THINGS THAT WERE INVENTED TO COVER FOR
 * ITS ABSENCE.
 *
 * A first end-to-end walkthrough of Flock in 2026-08 found that everything
 * after "pick a venue" was unreachable, and that three separate screens filled
 * the resulting silence with something that was not true. Six findings, all six
 * pinned here:
 *
 *   1. THE PLAN COULD NEVER BE CONFIRMED. The button labelled Confirm called
 *      saveFlockVenue, which sends venue fields and no status, so every flock
 *      ever created stayed at 'planning'. isConfirmed was permanently false,
 *      the slide-to-complete bar never rendered, attendance was unreachable, no
 *      reliability score was ever written, and GET /api/flocks/history returned
 *      [] forever. Confirm now confirms. The database half of the same chain is
 *      walked for real in backend/__tests__/flockLifecycle.test.js.
 *
 *   2. A DENIED LOCATION MADE THE APP DECIDE YOU LIVED IN BETHLEHEM, PA. Every
 *      geolocation failure loaded venues around 40.5798,-75.2932 and wrote
 *      those coordinates to localStorage, so the blue dot, the search bias and
 *      every distance label were computed from a town the user had never been
 *      to. Silently.
 *
 *   3. ANY VENUE-SEARCH FAILURE FILLED THE MAP WITH EIGHT INVENTED VENUES,
 *      with invented ratings and review counts, nothing marking them as
 *      fallbacks, and the screen blaming the user's spelling.
 *
 *   4. ONE FRIEND OPENED A DM INSTEAD OF CREATING A FLOCK, silently, from a
 *      button that said Create Flock, wiping five filled-in fields on the way.
 *      The DM is wanted; the silence and the data loss are the defect.
 *
 *   5. THE THREE-AMOUNT BUDGET RULE WAS ONLY EVER STATED BY A 400, reachable
 *      by pressing a button that looked ready.
 *
 *   6. SKIPPING A BUDGET LOCKED YOU OUT OF EVER ENTERING ONE, because the form
 *      needs !userSubmitted and the Change link needed a truthy amount, and a
 *      skip stores null. The server accepted an amount after a skip the whole
 *      time.
 *
 * Source-scanning, not rendering, like every other App.js suite here: each fact
 * under test is a call-site choice inside a 22,000-line monolith.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

// The flock chat screen left App.js on 2026-08-26: it lives in
// screens/ChatDetail.js now, and the message list, the composer, the reaction
// row and the report entry went with it. Nothing asserted below changed. The
// app source is simply in two files, so both are read, in the order they used
// to be one.
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8')
  // The flock plan detail screen followed on 2026-09-01: the Lock it in
  // control, the attendance-owed derivation and the vote rows live in
  // screens/FlockDetail.js now. It is appended last so every marker pair
  // above still spans what it spanned when the source was one file.
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'FlockDetail.js'), 'utf8')
  // The create screen followed on the same day: the one-friend read-back, the
  // handleCreate path and the footer that names the direct message live in
  // screens/CreateScreen.js now. Appended after FlockDetail for the same
  // reason FlockDetail was appended after ChatDetail, so no marker pair above
  // spans a boundary it did not span when the source was one file.
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'CreateScreen.js'), 'utf8');
const API_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'api.js'),
  'utf8'
);

/** Comments dropped, so prose describing a fix cannot pass for the fix. */
function codeOnly(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const APP = codeOnly(APP_SRC);
const API = codeOnly(API_SRC);

function region(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The plan can be confirmed
// ═══════════════════════════════════════════════════════════════════════════

describe('confirming a plan', () => {
  test('something in the app finally calls setFlockStatus with confirmed', () => {
    // The single most consequential line in the drop. Before it, the only
    // writer of 'confirmed' anywhere was the select_venue socket handler, and
    // grep for select_venue across frontend/src returned nothing.
    expect(APP).toMatch(/setFlockStatus\(flockId, 'confirmed'\)/);
    expect(APP).not.toMatch(/select_venue/);
  });

  test('saveFlockVenue can carry the confirmation, so confirming is one call and one push', () => {
    // Two PUTs (venue, then status) sent every member two lock-screen pushes
    // seconds apart; the server skips the "Plan updated" push when the same
    // request confirms (2026-09-04).
    const fn = region(API, 'export async function saveFlockVenue', '\n}');
    expect(fn).toMatch(/venue_name/);
    expect(fn).toMatch(/status: venue\.status,/);
    // PUT /api/flocks/:id is one route for both, and the status enum is
    // validated on the client so a typo costs no round trip.
    expect(API).toMatch(/FLOCK_STATUSES = \['planning', 'confirmed', 'completed', 'cancelled'\]/);
  });

  test('the Confirm button saves the venue and the confirmation in one write, with the row\'s own place id', () => {
    const handler = region(APP, 'const handleConfirmVenue = ', 'const assignedVenue');
    expect(handler).toMatch(/updateFlockVenue\(selectedFlockId/);
    // One PUT: a venue the server refuses is a plan that is not confirmed
    // either, since the same request carries both.
    expect(handler).toMatch(/status: 'confirmed',/);
    expect(handler).not.toMatch(/confirmFlockPlan\(/);
    // The row's place id first, then the chat's venue card, then the pins: a
    // name lookup in the nearby pins lost the id for anything voted from a
    // shared card, and the plan lost Details, Directions and Check In.
    expect(handler).toMatch(/place_id: rowPlaceId \|\| card\?\.place_id \|\| pin\?\.place_id \|\| null,/);
  });

  test('a venue write that fails reports false rather than resolving quietly', () => {
    const fn = region(APP, 'const updateFlockVenue = useCallback', 'const openAttendanceSheet');
    expect(fn).toMatch(/return Promise\.resolve\(true\)/);
    expect(fn).toMatch(/return false;/);
  });

  test('confirming rolls back and speaks up when the server refuses', () => {
    const fn = region(APP, 'const confirmFlockPlan = useCallback', 'const openAttendanceSheet');
    expect(fn).toMatch(/previousStatus/);
    expect(fn).toMatch(/sessionExpired/);
    expect(fn).toMatch(/'error'/);
    // Already-locked plans are not re-locked, so a double tap is not two PUTs.
    expect(fn).toMatch(/previousStatus === 'confirmed'/);
  });

  test('the host can lock a plan in from the plan screen, not only from the vote panel', () => {
    // The vote panel's Confirm was hidden on the ASSIGNED venue, so a host who
    // picked a venue any other way had no confirm control in the product at
    // all. Creator only, because PUT /api/flocks/:id is.
    expect(APP).toMatch(/isCreator && !isConfirmed && !isCompleted && hasVenue/);
    expect(APP_SRC).toMatch(/Lock it in/);
    expect(APP).toMatch(/confirmFlockPlan\(flock\.id\)/);
  });

  test('the vote panel offers confirm until the plan is locked, including on the assigned venue', () => {
    expect(APP).toMatch(/const planLocked = flock\.status === 'confirmed' \|\| flock\.status === 'completed'/);
    expect(APP).toMatch(/isCreator && !planLocked &&/);
  });

  test('a completed flock can still have its attendance marked', () => {
    // The sweep can complete a night the host never slid, and attendance is
    // the only thing that writes anybody a reliability score, so a completed
    // flock with an unmarked roster has to keep a door open.
    expect(APP).toMatch(/const openAttendanceSheet = useCallback/);
    expect(APP).toMatch(/const attendanceOwed = isCompleted &&/);
    expect(APP).toMatch(/attendance: m\.attendance \|\| 'unmarked'/);
    expect(APP_SRC).toMatch(/Who showed up\?/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Location
// ═══════════════════════════════════════════════════════════════════════════

describe('a location the app does not have', () => {
  test('no code path loads venues at the old default city', () => {
    // The whole finding in one assertion: those coordinates must not appear as
    // an argument to anything, because loadVenuesAtLocation writes whatever it
    // is given to localStorage and every distance on screen is measured from
    // there afterwards.
    expect(APP).not.toMatch(/40\.5798/);
    expect(APP).not.toMatch(/-75\.2932/);
  });

  test('a denied permission says so instead of inventing an answer', () => {
    const fn = region(APP, 'const requestUserLocation = useCallback', '}, [loadVenuesAtLocation]);');
    expect(fn).toMatch(/setLocationError\(/);
    // PERMISSION_DENIED is code 1, and it gets different words from a timeout:
    // "turn it on in Settings" is useless advice to somebody who already did.
    expect(fn).toMatch(/err\.code === 1/);
    expect(fn).not.toMatch(/loadVenuesAtLocation\(\d/);
  });

  test('the map opens on a wide view when nothing knows where the user is', () => {
    expect(APP).toMatch(/UNKNOWN_LOCATION_VIEW/);
    expect(APP).toMatch(/zoom: located \? DEFAULT_ZOOM : UNKNOWN_LOCATION_VIEW\.zoom/);
  });

  test('the reason the map is empty is on the screen, with a way to retry', () => {
    expect(APP).toMatch(/locationError \|\| venueLoadError/);
    expect(APP_SRC).toMatch(/Try again/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Venues that do not exist
// ═══════════════════════════════════════════════════════════════════════════

describe('a venue search that fails', () => {
  test('the eight invented venues are gone from the source entirely', () => {
    // Not merely unreferenced: a hardcoded list of real-sounding bars with
    // invented ratings and review counts is fabricated data sitting one edit
    // away from being rendered again (SLOP-AUDIT H13).
    expect(APP_SRC).not.toMatch(/seedVenues/);
    expect(APP).not.toMatch(/seed_1/);
    expect(APP).not.toMatch(/Bookstore Speakeasy/);
  });

  test('a failed nearby load says what failed and shows no pins', () => {
    const fn = region(APP, 'const loadVenuesAtLocation = useCallback', 'const requestUserLocation');
    expect(fn).toMatch(/setAllVenues\(\[\]\)/);
    expect(fn).toMatch(/setVenueLoadError\(err\?\.message/);
    expect(fn).toMatch(/setVenueLoadError\(''\)/);
  });

  test('a failed search is not reported as a search that found nothing', () => {
    const fn = region(APP, 'setVenueSearching(true);', '}, [enhanceQuery, venuesToMapPins');
    expect(fn).toMatch(/setVenueLoadError\(err\?\.message/);
    // The old copy survives, but only for a genuinely empty result.
    expect(APP).toMatch(/venueResults\.length === 0 && !venueLoadError/);
    expect(APP).toMatch(/venueResults\.length === 0 && venueLoadError/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. One friend
// ═══════════════════════════════════════════════════════════════════════════

describe('picking exactly one person', () => {
  test('the screen names the direct message and the person before the tap', () => {
    expect(APP).toMatch(/const dmTarget = flockFriends\.length === 1 && flockFriends\[0\]\?\.id/);
    expect(APP_SRC).toMatch(/One person is a message, not a flock\./);
    // The footer read-back used to say "You and 1 more" about a DM.
    expect(APP).toMatch(/dmTarget \? `Just \$\{dmTarget\.name\}`/);
  });

  test('the button stops claiming it will create a flock', () => {
    expect(APP).toMatch(/Message \{dmFirstName \|\| dmTarget\.name\}/);
  });

  test('nothing the user typed is thrown away on the way to the DM', () => {
    const fn = region(APP, 'const invitedFriends = flockFriends.filter', 'setIsLoading(true);');
    expect(fn).toMatch(/startNewDmWithUser/);
    // Five setters used to fire here: name, friends, budget, ghost mode and the
    // chosen venue, with no toast and no undo.
    expect(fn).not.toMatch(/setFlockName\(''\)/);
    expect(fn).not.toMatch(/setSelectedVenueForCreate\(null\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 & 6. Budgets
// ═══════════════════════════════════════════════════════════════════════════

describe('the group budget', () => {
  test('the rule for when a number appears is stated before the first submission', () => {
    // It is a privacy floor, not a quota. Two parts, and the screen has to say
    // both: the group number is built from the lowest amount, so publishing it
    // over one or two answers publishes somebody's budget, and publishing it
    // before everyone has answered means it MOVES when the last person answers,
    // which names that person as the one with the least money. Until this was
    // written down the only place either rule was ever stated was a 400 from
    // the lock route, after the tap.
    expect(APP_SRC).toMatch(
      /One group number appears after everyone has answered, and only if at least three people shared an amount/
    );
    expect(APP_SRC).toMatch(/it does not change after that/);
  });

  test('a flock too small to reach three is told so, not left waiting', () => {
    expect(APP_SRC).toMatch(/No group number for a flock this size/);
    expect(APP_SRC).toMatch(/No group number in a flock this size/);
    expect(APP).not.toMatch(/Waiting for budgets/);
    expect(APP).not.toMatch(/Waiting for more responses to set group budget/);
  });

  test('Lock Budget appears only when locking can actually succeed', () => {
    // isReady is the server's own condition for the lock route (three
    // non-skipped amounts), so this is the same rule rather than a second copy
    // of it that can drift.
    const gate = APP.indexOf('{budgetStatus?.isReady && (');
    expect(gate).toBeGreaterThan(-1);
    const gated = APP.slice(gate, APP.indexOf('</button>', gate));
    expect(gated).toMatch(/lockBudget\(selectedFlockId\)/);
    expect(gated).toMatch(/Lock Budget/);
  });

  test('skipping is not a one-way door', () => {
    // A skip stores null, so the old `userAmount &&` guard hid the only way
    // back at the same moment the form disappeared.
    expect(APP).toMatch(/budgetStatus\?\.userAmount != null/);
    expect(APP).toMatch(/budgetStatus\?\.userAmount == null && budgetStatus\?\.userSubmitted/);
    expect(APP_SRC).toMatch(/Set an amount/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// House rules
// ═══════════════════════════════════════════════════════════════════════════

test('none of the copy this drop added carries an em dash', () => {
  // SLOP-AUDIT A2/H18, the single most repeated regression in the repo. Scoped
  // to the regions this drop wrote rather than to the whole file, because a
  // regex cannot tell a string from an apostrophe inside a comment and a
  // whole-file count is famous for measuring the wrong thing (SLOP-AUDIT A2:
  // "count the strings, not the characters").
  const regions = [
    ['const confirmFlockPlan = useCallback', 'const openAttendanceSheet'],
    ['const dmTarget = flockFriends.length === 1', 'const handleCreate = async'],
    ['const handleConfirmVenue = ', 'const assignedVenue'],
    ["What's your budget tonight?", 'Budget disabled'],
  ];
  for (const [from, to] of regions) {
    const start = APP_SRC.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    const end = APP_SRC.indexOf(to, start + from.length);
    const slice = APP_SRC.slice(start, end > start ? end : start + 6000);
    expect([from, slice.includes('—')]).toEqual([from, false]);
  }
});
