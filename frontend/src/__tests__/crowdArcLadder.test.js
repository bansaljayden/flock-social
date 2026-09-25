/**
 * THE DIAL'S ARC IS COLOURED BY THE SAME LADDER AS EVERY OTHER CROWD SURFACE.
 *
 * crowdArcFor (src/lib/crowd.js, the chat venue card's dial) carried its own
 * cut points and turned red above 69, so a Busy 75 drew a red arc while App.js
 * crowdBandFor, the site and the server keep Busy (70-84) amber and red for
 * Packed at 85 and up. The arc now reads its colour off crowdLabelFor, and this
 * pins it to the word at every score and to App.js's bands at every score.
 */
const fs = require('fs');
const path = require('path');
const { crowdArcFor, crowdLabelFor } = require('../lib/crowd');

const GREEN = '#4ADE80';
const AMBER = '#FBBF24';
const RED = '#F87171';
const BAND_OF_ARC = { [GREEN]: 'green', [AMBER]: 'amber', [RED]: 'red' };

// App.js's own band function, read as source because App.js cannot be imported
// into a test without mounting the app. weekAheadChartLayout.test.js reads the
// same definition the same way.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const bandSource = APP.match(/const crowdBandFor = \(score\) => \{[\s\S]*?\n\};/);
// eslint-disable-next-line no-new-func
const appCrowdBandFor = bandSource ? new Function(`${bandSource[0]}\nreturn crowdBandFor;`)() : null;

test('Busy is amber on the arc and only Packed is red', () => {
  expect(crowdArcFor(69)).toBe(AMBER);
  expect(crowdArcFor(70)).toBe(AMBER);
  expect(crowdArcFor(75)).toBe(AMBER);
  expect(crowdArcFor(84)).toBe(AMBER);
  expect(crowdArcFor(85)).toBe(RED);
  expect(crowdArcFor(100)).toBe(RED);
  expect(crowdArcFor(39)).toBe(GREEN);
  expect(crowdArcFor(40)).toBe(AMBER);
  expect(crowdArcFor(0)).toBe(GREEN);
});

test('the arc changes colour only where the word changes', () => {
  for (let s = 1; s <= 100; s += 1) {
    const colourMoved = crowdArcFor(s) !== crowdArcFor(s - 1);
    const wordMoved = crowdLabelFor(s) !== crowdLabelFor(s - 1);
    if (colourMoved) expect(wordMoved).toBe(true);
  }
});

test('the arc and App.js crowdBandFor draw the same band at every score', () => {
  expect(appCrowdBandFor).toEqual(expect.any(Function));
  for (let s = 0; s <= 100; s += 1) {
    expect(`${s}: ${BAND_OF_ARC[crowdArcFor(s)]}`).toBe(`${s}: ${appCrowdBandFor(s)}`);
  }
  for (const s of [NaN, null, undefined, Infinity]) {
    expect(crowdArcFor(s)).toBeNull();
    expect(appCrowdBandFor(s)).toBeNull();
  }
});

test('the arc carries no cut points of its own', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'crowd.js'), 'utf8').replace(/\r\n/g, '\n');
  const arc = lib.match(/export const crowdArcFor = \(score\) => \{[\s\S]*?\n\};/);
  expect(arc).not.toBeNull();
  expect(arc[0]).toMatch(/crowdLabelFor\(score\)/);
  expect(arc[0]).not.toMatch(/score\s*[<>]=?\s*\d/);
});
