// The core loop as host and member, traced 2026-09-04. Source contracts for
// the parts the older suites do not pin.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const chat = read('screens/ChatDetail.js');
const detail = read('screens/FlockDetail.js');
const create = read('screens/CreateScreen.js');
const flocks = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'flocks.js'), 'utf8');
const aasa = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'apple-app-site-association.js'), 'utf8');

test('a tie at the top is a tie, not "Leading" with a flame', () => {
  expect(chat).toMatch(/const isTiedTop = !isAssigned && count > 0 && count === topCount && sortedVotes\.filter\(x => voteTotal\(x\) === topCount\)\.length > 1;/);
  expect(chat).toMatch(/const isLeading = !isAssigned && idx === 0 && count > 0 && !isTiedTop;/);
  expect(chat).toMatch(/\{isLeading \? 'Leading' : 'Tied'\}<\/span>/);
});

test('the vote row is not a button with a button inside it', () => {
  expect(chat).toMatch(/<div role="button" tabIndex=\{0\} aria-pressed=\{isMyVote\} key=\{v\.venue\}/);
  expect(chat).not.toMatch(/<button key=\{v\.venue\}/);
});

test('the chat says when the plan is and where the plan screen is', () => {
  expect(chat).toMatch(/aria-label="Open the plan"/);
  expect(chat).toMatch(/onClick=\{\(\) => \{ leaveChatScreen\(\); setCurrentScreen\('detail'\); \}\}/);
  expect(chat).toMatch(/\{flock\.time && flock\.time !== 'TBD' \? flock\.time : 'Time still open'\} · \{flock\.status === 'confirmed' \? 'Locked in'/);
});

test('a lock or a move is said to the members who did not make it', () => {
  const i = app.indexOf('const unsub = onFlockUpdated((data) => {');
  const handler = app.slice(i, i + 1800);
  expect(handler).toMatch(/const before = flocksRef\.current\.find\(f => f\.id === data\.flockId\);/);
  expect(handler).toMatch(/if \(data\.status === 'confirmed' && before\.status !== 'confirmed'\)/);
  expect(handler).toMatch(/moved to \$\{formatEventTime\(data\.event_time\)\}/);
});

test('one write confirms, and the local status follows the server\'s answer', () => {
  const i = app.indexOf('const updateFlockVenue = useCallback');
  const fn = app.slice(i, app.indexOf('const openAttendanceSheet', i));
  expect(fn).toMatch(/const confirming = venue\.status === 'confirmed';/);
  expect(fn).toMatch(/status: confirming \? 'confirmed' : undefined/);
  expect(fn).toMatch(/if \(confirming\) showToast\('Locked in\. Everyone in the flock has been told\.'\);/);
  expect(fn).toMatch(/status: saved\.status === 'planning' \? 'voting' : \(saved\.status \|\| f\.status\),/);
});

test('a roster that could not be read says so, and the done step still opens the sheet', () => {
  expect(app).toMatch(/const \[rosterError, setRosterError\] = useState\(false\);/);
  expect(app).toMatch(/\.catch\(\(\) => setRosterError\(true\)\);\s*loadFlockVotes\(selectedFlockId\);/);
  expect(detail).toMatch(/Couldn't load who's going\./);
  expect(detail).toMatch(/onClick=\{retryRoster\}/);
  expect(app).toMatch(/showToast\('Marked done\. Open the plan again to mark who showed up\.'\);/);
});

test('a member picking on Discover suggests; only the creator sets the venue', () => {
  expect(app).toMatch(/const pickerIsCreator = !picked \|\| String\(picked\.creatorId\) === String\(meRef\.current\?\.id\);/);
  expect(app).toMatch(/shareVenueToChat\(pickingVenueForFlockId, pickedVenue\);/);
  expect(app).toMatch(/'Suggest to flock' : 'Add to Flock'/);
});

test('the create screen caps invitees at the server\'s ceiling and counts what the server kept', () => {
  expect(create).toMatch(/disabled=\{flockFriends\.length >= 25\}/);
  expect(create).toMatch(/25 invited, the most at once\. Add more from the chat\./);
  expect(create).toMatch(/const acceptedInvites = Array\.isArray\(f\.invited_user_ids\) \? f\.invited_user_ids\.length : invitedIds\.length;/);
  expect(create).toMatch(/Invited \$\{acceptedInvites\} of \$\{invitedIds\.length\}\. The rest can join from the invite link\./);
});

test('the invite helper\'s live card says when, where and how many', () => {
  const i = flocks.indexOf('async function inviteUsersToFlock(');
  const helper = flocks.slice(i, i + 20000);
  expect(helper).toMatch(/SELECT f\.event_time, f\.venue_name,/);
  expect(helper).toMatch(/eventTime,\s*venueName,\s*goingCount,\s*\}\);/);
});

test('the invite link is claimed and routed', () => {
  expect(aasa).toMatch(/\{ '\/': '\/i\/\*', comment: 'invite link; routed by intentFromUrl and redeemed by inviteHandoff' \}/);
  expect(aasa).not.toMatch(/'\/i\/\*', exclude: true/);
  expect(app).toMatch(/\} else if \(intent\.screen === 'invite' && intent\.token\) \{[\s\S]{0,400}rememberInvite\(intent\.token\);\s*loadFlocks\(\);/);
});
