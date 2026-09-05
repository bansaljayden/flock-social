// Safety and friends, traced 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const sheet = read('components/safety/EmergencySheet.js');
const profile = read('screens/ProfileSettings.js');
const addFriends = read('screens/AddFriends.js');
const safety = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'safety.js'), 'utf8');
const friends = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'friends.js'), 'utf8');

test('a live share follows the person instead of re-sending one frozen fix', () => {
  expect(app).toMatch(/const sharingAnywhere = !!sharingLocationForFlock \|\| !!dmSharingLocation;/);
  expect(app).toMatch(/const id = watchPosition\(\s*\(pos\) => setUserLocation\(\{ lat: pos\.coords\.latitude, lng: pos\.coords\.longitude \}\),/);
  expect(app).toMatch(/return \(\) => \{ if \(id != null\) clearWatch\(id\); \};\s*\}, \[sharingAnywhere\]\);/);
  // A DM share always takes a fresh fix; the old early return could broadcast
  // a coordinate restored from a previous session.
  expect(app).not.toMatch(/if \(userLocation\) \{ setDmSharingLocation\(dmId\); return; \}/);
});

test('the flock alarm says whether the trusted contacts were actually reached', () => {
  expect(safety).toMatch(/async function alertFlockMembers\(io, user, coords, contactsAlerted\) \{/);
  expect(safety).toMatch(/\.\.\.\(typeof contactsAlerted === 'number' \? \{ contactsAlerted \} : \{\}\),/);
  expect(safety).toMatch(/alertFlockMembers\(req\.app\.get\('io'\), req\.user, coords, emailsSent\)/);
  expect(app).toMatch(/\{safetyAlert\.contactsAlerted === 0/);
  // And the number reaches state from both transports (safety audit
  // 2026-09-05: the branch was pinned, the plumbing was not, and the sentence
  // said the adults were handled when nobody was reached).
  expect(app).toMatch(/\.\.\.\(Number\.isFinite\(Number\(data\.contactsAlerted\)\) \? \{ contactsAlerted: Number\(data\.contactsAlerted\) \} : \{\}\),/);
  expect(app).toMatch(/\.\.\.\(Number\.isFinite\(intent\.contactsAlerted\) \? \{ contactsAlerted: intent\.contactsAlerted \} : \{\}\),/);
  const nav = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushNavigation.js'), 'utf8');
  expect(nav).toMatch(/const contactsAlerted = data\.contactsAlerted != null \? Number\(data\.contactsAlerted\) : NaN;/);
  expect(nav).toMatch(/\.\.\.\(Number\.isFinite\(contactsAlerted\) \? \{ contactsAlerted \} : \{\}\),/);
  // An unknown count says nothing rather than claiming the emails went.
  expect(app).toMatch(/: safetyAlert\.contactsAlerted > 0\s*\? ' Their trusted contacts have already been emailed\.'\s*: ''\}/);
  expect(app).toMatch(/We could not reach any of their trusted contacts, so you may be the only person who knows\./);
});

test('sharing an exact location is armed, like the alert above it', () => {
  expect(sheet).toMatch(/const \[shareArmed, setShareArmed\] = useState\(false\);/);
  expect(sheet).toMatch(/if \(!shareArmed\) \{ setShareArmed\(true\); return; \}/);
  expect(sheet).toMatch(/shareArmed \? 'Tap again to send your location' : 'Share Location'/);
});

test('the safety card promises the channel and the location the code has', () => {
  expect(profile).toMatch(/Trusted contacts get an email when you press SOS\. It includes your location if your phone has a fix at the time, and Flock keeps trying for one just after\./);
  expect(profile).not.toMatch(/They'll get a message with your location\./);
});

test('a number the server could not read is not a number nobody has', () => {
  expect(app).toMatch(/if \(data && data\.checked === 0\) \{/);
  expect(app).toMatch(/We could not read that as a phone number\. Try it with the area code\./);
});

test('an address book with no readable numbers says that, not "0 numbers"', () => {
  expect(addFriends).toMatch(/\{contactsResult\.total === 0/);
  expect(addFriends).toMatch(/None of your contacts have a phone number Flock can check\. Add someone by their number below\./);
});

test('requests that arrived while the app was closed are loaded at boot', () => {
  expect(app).toMatch(/getPendingRequests\(\)\.then\(rows => setPendingRequests\(/);
});

test('the friend count moves when a request is accepted', () => {
  const i = app.indexOf('const handleAcceptFriendRequest = useCallback');
  const fn = app.slice(i, i + 1200);
  expect(fn).toMatch(/getUserStats\(\)\.then\(d => \{ if \(typeof d\?\.friendCount === 'number'\) setFriendCount\(d\.friendCount\); \}\)/);
});

test('clearing the name search clears its error and its queued request', () => {
  expect(addFriends).toMatch(/aria-label="Clear search" className="hit44" onClick=\{\(\) => handleAddFriendsSearch\(''\)\}/);
});

test('shared flocks are not rendered as mutual friends', () => {
  expect(friends).toMatch(/COUNT\(fm2\.flock_id\) AS shared_flocks/);
  expect(friends).toMatch(/ORDER BY shared_flocks DESC/);
  expect(addFriends).toMatch(/\$\{user\.shared_flocks\} plan\$\{parseInt\(user\.shared_flocks\) !== 1 \? 's' : ''\} together/);
});

test('a declined request still reads as pending to the person who sent it', () => {
  expect(friends).toMatch(/WHERE f\.requester_id = \$1 AND f\.status IN \('pending', 'declined'\)/);
});


test('the location follow-up is sent the moment a fix lands, and a 502 alarm can still be stood down', () => {
  // The client sat on the fix for the rest of a 65 s gap that the server had
  // stopped requiring, so the map arrived over a minute late and, past the
  // follow-up window, labelled as a move. And a 502 (no email landed) is an
  // alarm the flock still heard, so the stand-down band is offered.
  expect(app).not.toMatch(/SOS_FOLLOW_UP_GAP_MS/);
  expect(app).toMatch(/getSosPosition\(SOS_FOLLOW_UP_FIX_MS, 0\)\.then\(async \(\{ coords \}\) => \{/);
  expect(app).toMatch(/if \(err\?\.status === 502\) rememberSosAlert\(Date\.now\(\)\);/);
});
