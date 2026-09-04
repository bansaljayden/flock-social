// A read that failed is never rendered as a thing that is empty. From a
// sweep of the swallowed catches in App.js, 2026-09-04.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const chat = read('screens/ChatDetail.js');
const profile = read('screens/ProfileSettings.js');

test('a vote tally that could not be read says so, with a retry', () => {
  expect(app).toMatch(/const \[votesError, setVotesError\] = useState\(''\);/);
  expect(app).toMatch(/\.catch\(\(err\) => setVotesError\(err\?\.message \|\| 'The votes are not loading right now\.'\)\);/);
  expect(app).toMatch(/setVotesError\(''\);/);
  expect(chat).toMatch(/\) : votesError \? \(/);
  expect(chat).toMatch(/Nobody's vote has been lost\. This is the tally failing to load\./);
  expect(chat).toMatch(/onClick=\{\(\) => loadFlockVotes\(selectedFlockId\)\}/);
});

test('a streak that was never read is a dash, not a zero', () => {
  expect(app).toMatch(/const \[streak, setStreak\] = useState\(null\);/);
  expect(app).toMatch(/setStreak\(typeof d\.streak === 'number' \? d\.streak : null\);/);
  expect(profile).toMatch(/\{ l: 'Streak', v: streak \?\? '\\u2013', hasIcon: streak != null \}/);
});

test('a flocks list that failed to load is a dash on the profile too', () => {
  expect(profile).toMatch(/\{ l: 'Flocks', v: flocksError \? '\\u2013' : flocks\.length \}/);
  expect(profile).toMatch(/^  flocksError,$/m);
  expect(app).toMatch(/^\s+flocksError,$/m);
});
