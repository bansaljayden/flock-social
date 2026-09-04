// Crowd forecasting and everything that renders it, traced 2026-09-04.
// Source contracts.
//
// The standing rule this file defends: never present a number as something it
// is not. The 0-100 is venue-relative (100 is this venue's own weekly peak,
// the Google and BestTime semantic), never percent-full, and a category prior
// is not a reading.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const app = fs.readFileSync(path.join(REPO, 'frontend', 'src', 'App.js'), 'utf8');
const detail = fs.readFileSync(path.join(REPO, 'frontend', 'src', 'screens', 'FlockDetail.js'), 'utf8');
const alerts = fs.readFileSync(path.join(REPO, 'backend', 'services', 'crowdAlerts.js'), 'utf8');

test('the pre-peak push hedges, because the engine behind it is a category curve', () => {
  // crowdAlerts imports crowdEngine and never mlPredictor, so every crowd push
  // is the hand-written category curve, which crowdEngine itself marks
  // supported: false and which every screen hedges through publishedLabel.
  // The push said "will be packed" flatly, on a lock screen, about a venue
  // whose card one tap away would read "Steady 55" from the model.
  // The hedge is carried by the SENTENCE, not by the word. hedgeLabel builds a
  // noun phrase ("Usually packed"), which is right on a card label and wrong in
  // these slots: it produced "It's usually steady right now", which argues with
  // itself, and "expected to be usually busy", which is not English.
  expect(alerts).toMatch(/title: `\$\{name\} is usually packed then`/);
  expect(alerts).toMatch(/title: `\$\{name\} usually fills up before then`/);
  expect(alerts).toMatch(/title: `\$\{name\} usually peaks soon`/);
  expect(alerts).toMatch(/Places like it are usually \$\{soon\} around your flock time\./);
  expect(alerts).toMatch(/The busiest stretch usually starts around/);
  // Scoped: the comment above the fix names hedgeLabel to explain why it is the
  // wrong tool here.
  expect(alerts).not.toMatch(/hedgeLabel\(/);
  expect(alerts).not.toMatch(/hedgeLabel \} = require/);
  // Scoped to the template, because the comment above the fix quotes the old
  // words to explain what changed.
  expect(alerts).not.toMatch(/title: `\$\{name\} will be packed`/);
});

test('a crowd read that failed says so on the map path too', () => {
  // openVenueDetail set this flag and the map-marker effect did not, so a 429
  // on the Places budget left the dial and all twelve bars pulsing as skeletons
  // forever under a chip reading ESTIMATED, with no sentence and no retry.
  expect(app).toMatch(/if \(!cancelled\) setCrowdFetchFailed\(true\);/);
  // And cleared per venue, so a failure cannot caption the next one.
  expect((app.match(/setCrowdFetchFailed\(false\);/g) || []).length).toBe(2);
});

test('a venue with no reading is not the quietest place nearby', () => {
  // venuesToMapPins sets crowd to null on purpose. `v.crowd < score` coerces
  // null to 0, so every unscored venue passed "quieter than this" and sorted to
  // the front, each captioned "No reading yet".
  expect((app.match(/typeof v\.crowd === 'number' && typeof score === 'number' && v\.crowd < score/g) || []).length).toBe(1);
  expect(app).toMatch(/typeof score === 'number' && allVenues\.filter\(v => v\.id !== activeVenue\.id && v\.category === activeVenue\.category && typeof v\.crowd === 'number' && v\.crowd < score/);
  expect(app).not.toMatch(/v\.category === activeVenue\.category && v\.crowd < score/);
});

test('LIVE means the model produced the number, not that the reply is new', () => {
  // lastUpdated is stamped when the route BUILDS the payload, so it is seconds
  // old on every uncached request and the chip was green for every venue,
  // including one with no baseline whose number is the category curve. The card
  // then drew a pulsing LIVE eight rows above "An estimate from typical
  // patterns for this kind of place".
  expect(app).toMatch(/const method = String\(cd\.predictionMethod \|\| ''\);/);
  expect(app).toMatch(/if \(!method \|\| method\.startsWith\('rule_engine'\)\) return false;/);
});

test('the venue-relative index is never printed as a percentage', () => {
  // The sheet renders "Steady · 62". The list rendered "Steady 62%" for the
  // same venue, which reads as 62% full and is not what the number means.
  expect(app).toMatch(/`\$\{crowdLabel\} \$\{crowdScore\}`/);
  expect(app).not.toMatch(/\$\{crowdScore\}%/);
});

test('the reality check offers the words the ladder actually uses', () => {
  // The ladder was re-cut on 2026-08-28 and gained Packed. Somebody looking at
  // a card reading "Packed 91" tapped Rate the crowd and was offered
  // Quiet / Moderate / Very Busy: no option matched the word on their screen.
  expect(app).toMatch(/\{ level: 2, label: 'Steady' \}/);
  expect(app).toMatch(/\{ level: 3, label: 'Packed' \}/);
  expect(detail).toMatch(/\{ level: 2, label: 'Steady',/);
  expect(detail).toMatch(/\{ level: 3, label: 'Packed',/);
  // Only the words moved. `level` is what travels and what the training export
  // reads, so the stored data is untouched.
  expect(app).toMatch(/\{ level: 1, label: 'Quiet' \}/);
  expect(detail).toMatch(/\{ level: 1, label: 'Quiet',/);
});

test('a venue that set its own number says so in the nearby list', () => {
  // The nearby list applies the owner override to every row and RANKS by it,
  // and the cell printed a name, a dot and a label. So a venue whose owner had
  // set their own slider to 10 appeared as "Quiet", indistinguishable from a
  // Flock reading, recommended over the venue the person was looking at. It is
  // the surface where the conflict of interest is sharpest and the one place
  // the attribution was missing; services/ownerReports.js says the source is
  // labelled on every surface.
  expect(app).toMatch(/\{v\.confidenceBasis === 'owner_report' && \(/);
  expect(app).toMatch(/`The \$\{v\.ownerReport\?\.noun \|\| 'venue'\} says so`/);
});
