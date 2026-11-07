/**
 * THE NEST SAYS A THING ONCE, AS A FACT (2026-11-06).
 *
 * Two lines a newcomer or a worried person reads on the Nest:
 *
 *   - A list that failed to load. The note said "Nothing has been cancelled.
 *     This is the list failing to load, not the list being empty.": three
 *     clauses spent on what the screen was not, the "not X, it's Y" turn that
 *     reads as generated. Now the title is the read's own sentence (why, when
 *     it is known) and the body is the one fact a person fears, said once.
 *   - "No flocks yet", over a body that used the brand word without saying it
 *     means a plan with friends. The body now says so first, in the same
 *     breath as how to start one.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestPlainWords --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const HOME = APP.slice(APP.indexOf('const HomeScreen = () => {'), APP.indexOf('// The past flocks screen was declared here'));

test('a list that did not load says the plans are still there, once, with Try again', () => {
  const note = HOME.slice(HOME.indexOf('{!flocksLoading && flocksError && ('), HOME.indexOf('{/* NOTHING ON YET.'));
  expect(note).toContain('title={flocksError}');
  expect(note).toContain('body="Your plans are still there."');
  expect(note).toContain('>Try again</button>');
  expect(note).not.toMatch(/not the list|failing to load|Nothing has been cancelled/);
  // The title's own default is a plain sentence too.
  expect(APP).toContain("setFlocksError(userMessage(err, 'Your flocks are not loading right now.'));");
});

test('a newcomer is told what a flock is before being asked to start one', () => {
  expect(HOME).toContain("'A flock is a plan with your friends. Start one and drop the invite link in the group chat. Nobody needs the app to see the plan and vote.'");
  // The title keeps the brand word; the body defines it.
  expect(HOME).toContain("'No flocks yet'");
});
