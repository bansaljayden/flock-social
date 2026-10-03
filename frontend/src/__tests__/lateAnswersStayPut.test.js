/**
 * An answer is for what it was asked about (app audit 2026-10-03). Open a
 * photo or an event's details, close it, open another, and the first read's
 * late answer used to land in the second overlay: the wrong photo in the
 * viewer, the wrong event merged into the card, and its finally taking the
 * second card's spinner down. FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test.each([
  ['screens/ChatDetail.js', 'getFlockMessageImage(flock.id, m.id)'],
  ['screens/DmDetail.js', 'getDmMessageImage(m.id)'],
])('%s: the photo viewer takes only its own message\'s answer', (file, call) => {
  const src = read(file);
  const start = src.indexOf('setImageViewer({ loading: true, id: m.id });');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, start + 600);
  expect(body).toContain(call);
  expect((body.match(/prev && prev\.loading && prev\.id === m\.id \?/g) || []).length).toBe(2);
  expect(src).not.toMatch(/prev && prev\.loading \? \{ src: d\.image \}/);
});

test('event details: only the newest read writes the card, its error or its spinner', () => {
  const src = read('screens/ExploreScreen.js');
  expect(src).toContain('const eventDetailAskRef = React.useRef(0);');
  const start = src.indexOf('const ask = eventDetailAskRef.current + 1;');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, start + 1800);
  expect(body).toContain('const current = () => eventDetailAskRef.current === ask;');
  expect(body).toMatch(/\.then\(data => \{ if \(current\(\)\) setEventDetail\(/);
  expect(body).toMatch(/\.catch\(\(err\) => \{ if \(current\(\)\) setEventDetailError\(/);
  expect(body).toMatch(/\.finally\(\(\) => \{ if \(current\(\)\) setEventDetailLoading\(false\); \}\);/);
});
