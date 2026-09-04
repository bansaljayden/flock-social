// The Plans tab and the events list, traced 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const create = read('screens/CreateScreen.js');
const events = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'events.js'), 'utf8');
const calendar = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'calendar.js'), 'utf8');

test('a failed plans read is said with a retry, not shown as an empty day', () => {
  expect(app).toMatch(/const loadCalendar = useCallback\(\(\) => \{/);
  expect(app).toMatch(/\.catch\(\(err\) => setCalendarError\(err\?\.message \|\| 'Your plans are not loading right now\.'\)\)/);
  expect(app).toMatch(/\) : \(calendarError \|\| flocksError\) \? \(/);
  expect(app).toMatch(/onClick=\{\(\) => \{ loadFlocks\(\); loadCalendar\(\); \}\}/);
});

test('events without location do not promise a search that does nothing', () => {
  expect(app).toMatch(/Turn location on for Flock to see what is on near you\./);
  expect(app).not.toMatch(/or search for an event by name/);
  expect(app).toMatch(/disabled=\{!userLocation\}\s*value=\{eventsSearchQuery\}/);
});

test('a Ticketmaster failure is the list failing, and an older answer cannot overwrite a newer one', () => {
  expect((events.match(/degraded: true/g) || []).length).toBe(6);
  expect(events).toMatch(/Events are not set up on this server yet\./);
  expect(app).toMatch(/const seq = \+\+featuredSeqRef\.current;/);
  expect(app).toMatch(/if \(data\?\.degraded\) \{\s*setFeaturedEvents\(null\);\s*setFeaturedEventsError\('Ticketmaster is not answering right now\.'\);/);
  expect(app).toMatch(/\.finally\(\(\) => \{ if \(seq === featuredSeqRef\.current\) setFeaturedEventsLoading\(false\); \}\);/);
});

test('the detail sheet says when the rest did not load, and keeps the distance', () => {
  expect(app).toMatch(/const \[eventDetailError, setEventDetailError\] = useState\(''\);/);
  expect(app).toMatch(/distance_miles: data\?\.event\?\.distance_miles \?\? prev\?\.distance_miles \?\? null/);
  expect(app).toMatch(/km away/);
  expect(app).not.toMatch(/miles away/);
});

test('the add form says what it needs, and the server names its limits', () => {
  expect(app).toMatch(/disabled=\{!newEventTitle\.trim\(\)\}/);
  expect(app).toMatch(/maxLength=\{120\} initialValue=\{newEventTitle\}/);
  expect(calendar).toMatch(/Keep the title under 120 characters/);
});

test('the weather reading is re-read after thirty minutes and does not pulse', () => {
  expect(app).toMatch(/if \(Date\.now\(\) - weatherFetchedRef\.current < 30 \* 60 \* 1000\) return;/);
  expect(app).not.toMatch(/animation: isLive \? 'pulse 2s ease-in-out infinite' : 'none'/);
});

test('prices print as money and a free event is a price', () => {
  expect(app).toMatch(/^const fmtMoney = \(n\) => \(Number\.isInteger\(n\) \? String\(n\) : Number\(n\)\.toFixed\(2\)\);/m);
  expect(app).toMatch(/event\.price_range\.min === 0 && !event\.price_range\.max \? 'Free'/);
  expect(events).toMatch(/if \(Number\.isFinite\(p\.min\) && Number\.isFinite\(p\.max\)\)/);
});

test('a flock started from an event keeps the event\'s instant and name', () => {
  expect(app).toMatch(/event_name: event\.name, event_date: event\.date \|\| null, event_time: event\.time \|\| null, event_datetime_utc: event\.datetime_utc \|\| null \}\);/);
  expect(create).toMatch(/const eventAt = fixedEventAt \|\| resolveEventTime\(flockDate, flockTime\);/);
  expect(create).toMatch(/const capturedEventTime = \(capturedFixedAt \|\| resolveEventTime\(flockDate, flockTime\)\)\.toISOString\(\);/);
  expect(create).toMatch(/The time comes from the event listing\./);
  expect(create).toMatch(/if \(eventName && !flockName\) setFlockName\(eventName\);/);
});
