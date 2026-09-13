// The Plans tab and the events list, traced 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const create = read('screens/CreateScreen.js');
// The event detail overlay left App.js on 2026-09-13 for
// components/EventDetailOverlay.js, lazily fetched. The three assertions below
// about the detail sheet are about that JSX, so they read it where it lives:
// two of them would otherwise have passed on prose in an App.js comment and on
// the event card's own fetch, which is a test that holds its shape while the
// thing it describes is gone.
const eventDetailOverlay = read('components/EventDetailOverlay.js');
// The Plans tab itself left App.js on 2026-09-13 for screens/CalendarScreen.js,
// lazily fetched. The loaders, the state and the error strings stayed in
// App.js; the month grid, the day's events, the failed-read card and the
// add-an-event form went with the screen, so the assertions about that JSX read
// it where it lives rather than against a file that no longer holds it.
const calendarScreen = read('screens/CalendarScreen.js');
// The Discover tab left App.js on 2026-09-13 for screens/ExploreScreen.js,
// lazily fetched. The events STATE, the sequence guard and fetchFeaturedEvents
// stayed in App.js; the Live Events drawer and the event cards inside it went
// with the screen, so the assertions about that JSX read it where it lives.
const exploreScreen = read('screens/ExploreScreen.js');
const events = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'events.js'), 'utf8');
const calendar = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'calendar.js'), 'utf8');

test('a failed plans read is said with a retry, not shown as an empty day', () => {
  expect(app).toMatch(/const loadCalendar = useCallback\(\(\) => \{/);
  expect(app).toMatch(/\.catch\(\(err\) => setCalendarError\(err\?\.message \|\| 'Your plans are not loading right now\.'\)\)/);
  expect(calendarScreen).toMatch(/\) : \(calendarError \|\| flocksError\) \? \(/);
  expect(calendarScreen).toMatch(/onClick=\{\(\) => \{ loadFlocks\(\); loadCalendar\(\); \}\}/);
});

test('events without location do not promise a search that does nothing', () => {
  expect(exploreScreen).toMatch(/Turn location on for Flock to see what is on near you\./);
  // Checked in BOTH files: the sentence moved, and the promise must not come
  // back in either the screen that draws the drawer or the file it left.
  expect(exploreScreen).not.toMatch(/or search for an event by name/);
  expect(app).not.toMatch(/or search for an event by name/);
  expect(exploreScreen).toMatch(/disabled=\{!userLocation\}\s*value=\{eventsSearchQuery\}/);
});

test('a Ticketmaster failure is the list failing, and an older answer cannot overwrite a newer one', () => {
  expect((events.match(/degraded: true/g) || []).length).toBe(6);
  expect(events).toMatch(/Events are not set up on this server yet\./);
  expect(app).toMatch(/const seq = \+\+featuredSeqRef\.current;/);
  expect(app).toMatch(/if \(data\?\.degraded\) \{\s*setFeaturedEvents\(null\);\s*setFeaturedEventsError\('Ticketmaster is not answering right now\.'\);/);
  expect(app).toMatch(/\.finally\(\(\) => \{ if \(seq === featuredSeqRef\.current\) setFeaturedEventsLoading\(false\); \}\);/);
});

test('the detail sheet says when the rest did not load, and keeps the distance', () => {
  // The state still lives in App.js; the sheet that reads it does not.
  expect(app).toMatch(/const \[eventDetailError, setEventDetailError\] = useState\(''\);/);
  expect(eventDetailOverlay).toMatch(/\{eventDetailError\}/);
  // The retry merge keeps a distance the detail call did not return. Pinned in
  // both places deliberately: the overlay's Try again and the card's own fetch
  // in App.js each do this merge, and a distance that survives one but not the
  // other is the bug this line is here for.
  // The card's own fetch went to the Discover screen with the events drawer;
  // the overlay's Try again is still the overlay's. Both are still pinned,
  // each against the file that now performs the merge.
  expect(exploreScreen).toMatch(/distance_miles: data\?\.event\?\.distance_miles \?\? prev\?\.distance_miles \?\? null/);
  expect(eventDetailOverlay).toMatch(/distance_miles: data\?\.event\?\.distance_miles \?\? prev\?\.distance_miles \?\? null/);
  expect(eventDetailOverlay).toMatch(/km away/);
  expect(eventDetailOverlay).not.toMatch(/miles away/);
  expect(app).not.toMatch(/miles away/);
  expect(exploreScreen).not.toMatch(/miles away/);
});

test('the add form says what it needs, and the server names its limits', () => {
  expect(calendarScreen).toMatch(/disabled=\{!newEventTitle\.trim\(\)\}/);
  expect(calendarScreen).toMatch(/maxLength=\{120\} initialValue=\{newEventTitle\}/);
  expect(calendar).toMatch(/Keep the title under 120 characters/);
});

test('the weather reading is re-read after thirty minutes and does not pulse', () => {
  expect(app).toMatch(/if \(Date\.now\(\) - weatherFetchedRef\.current < 30 \* 60 \* 1000\) return;/);
  // The LIVE badge that used to pulse is drawn by the Plans tab, so the
  // no-pulse half is read there. Kept on App.js as well: the effect and the
  // state are still here and the animation must not come back to either file.
  expect(calendarScreen).toMatch(/\{isLive \? 'LIVE' : 'FORECAST'\}/);
  expect(calendarScreen).not.toMatch(/animation: isLive \? 'pulse 2s ease-in-out infinite' : 'none'/);
  expect(app).not.toMatch(/animation: isLive \? 'pulse 2s ease-in-out infinite' : 'none'/);
});

test('prices print as money and a free event is a price', () => {
  // The helper is still App.js's and travels to the screen as a prop; the card
  // that prints a free event with it is the Discover screen's.
  expect(app).toMatch(/^const fmtMoney = \(n\) => \(Number\.isInteger\(n\) \? String\(n\) : Number\(n\)\.toFixed\(2\)\);/m);
  expect(exploreScreen).toMatch(/event\.price_range\.min === 0 && !event\.price_range\.max \? 'Free'/);
  expect(events).toMatch(/if \(Number\.isFinite\(p\.min\) && Number\.isFinite\(p\.max\)\)/);
});

test('a flock started from an event keeps the event\'s instant and name', () => {
  expect(exploreScreen).toMatch(/event_name: event\.name, event_date: event\.date \|\| null, event_time: event\.time \|\| null, event_datetime_utc: event\.datetime_utc \|\| null \}\);/);
  expect(create).toMatch(/const eventAt = fixedEventAt \|\| resolveEventTime\(flockDate, flockTime\);/);
  expect(create).toMatch(/const capturedEventTime = \(capturedFixedAt \|\| resolveEventTime\(flockDate, flockTime\)\)\.toISOString\(\);/);
  expect(create).toMatch(/The time comes from the event listing\./);
  expect(create).toMatch(/if \(eventName && !flockName\) setFlockName\(eventName\);/);
});
