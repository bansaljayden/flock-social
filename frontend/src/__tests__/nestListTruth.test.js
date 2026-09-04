// The Nest shows what is so. From the Nest trace of 2026-09-04. Source
// contracts.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const profile = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');

test('a reload keeps the members, votes and messages this session already read', () => {
  expect(app).toMatch(/const fresh = mapped\.filter\(f => f\.memberStatus === 'accepted'\);\s*setFlocks\(prev => fresh\.map\(\(f\) => \{/);
  expect(app).toMatch(/votes: old\.votes && old\.votes\.length \? old\.votes : f\.votes,/);
});

test('card times are dated past this week, on load and on update', () => {
  expect(app).toMatch(/time: formatEventTime\(f\.event_time\),/);
  expect(app).toMatch(/time: data\.event_time \? formatEventTime\(data\.event_time\) : f\.time,/);
  expect(app).not.toMatch(/time: f\.event_time \? new Date\(f\.event_time\)\.toLocaleString/);
});

test('the Nest counts, gates and lists one live, sorted array', () => {
  const home = app.slice(app.indexOf('const HomeScreen = () => {'), app.indexOf('const HomeScreen = () => {') + 30000);
  expect(home).toMatch(/const liveFlocks = flocks\s*\.filter\(f => f\.status !== 'completed' && f\.status !== 'cancelled'\)/);
  expect(home).toMatch(/>\{liveFlocks\.length\}<\/span> \{liveFlocks\.length === 1 \? 'flock' : 'flocks'\}/);
  expect(home).toMatch(/\{\(flocksLoading \|\| liveFlocks\.length > 0\) && \(<>/);
  expect(home).toMatch(/!flocksLoading && !flocksError && liveFlocks\.length === 0 && \(/);
  expect(home).toMatch(/\{liveFlocks\.map\(\(f, idx\) => \{/);
  expect(home).toMatch(/\{flocks\.length > 0 \? 'Nothing coming up' : 'No flocks yet'\}/);
  expect(home).toMatch(/\{f\.timePassed \? 'Time passed' : f\.status === 'voting' \? 'Needs Votes'/);
  expect(home).toMatch(/const needsAction = liveFlocks\.filter\(f => f\.status === 'voting' && !f\.timePassed && votesLoadedRef/);
});

test('a waiting invite is said on the badge and on the Nest, with when, where and who', () => {
  // The badge adds invites into one number, because the tab is one place to
  // go. The spoken label does not: it names them separately, so nobody is told
  // there is an unread message when what is waiting is an invitation.
  expect(app).toMatch(/const messagesTabInvites = pendingFlockInvites\.length;/);
  expect(app).toMatch(/const messagesTabUnread = messagesTabUnreadMessages \+ messagesTabInvites;/);
  expect(app).toMatch(/messagesTabInvites === 1 \? 'invite' : 'invites'/);
  expect(app).toMatch(/`Messages, \$\{messagesTabParts\.join\(' and '\)\}`/);
  expect(app).toMatch(/\? '1 invite waiting' : `\$\{pendingFlockInvites\.length\} invites waiting`/);
  expect(app).toMatch(/\{f\.time && f\.time !== 'TBD' \? f\.time : 'Time still open'\} · \{f\.venue && f\.venue !== 'TBD' \? f\.venue : 'Venue still open'\} · \{f\.memberCount \|\| 1\} going/);
  expect(app).toMatch(/time: data\.eventTime \? formatEventTime\(data\.eventTime\) : 'TBD',/);
  expect(app).toMatch(/status: invite\.status \|\| 'voting' \}\]\);/);
});

test('a friend count that was never read is not zero', () => {
  expect(app).toMatch(/const \[friendCount, setFriendCount\] = useState\(null\);/);
  expect(app).toMatch(/\{typeof friendCount === 'number' && \(<>/);
  expect(profile).toMatch(/\{ l: 'Friends', v: friendCount \?\? '\\u2013' \}/);
});
