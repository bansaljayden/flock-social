// The invite link, traced end to end 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const chat = read('screens/ChatDetail.js');
const guestPage = read('website/GuestInvite.js');
const guest = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'guest.js'), 'utf8');
const flocks = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'flocks.js'), 'utf8');

test('the rename door has the same duplicate-name lock as the create door', () => {
  expect(guest).toMatch(/if \(existing\.rows\[0\]\.name !== name\s*&& await nameInUse\(\(q, p\) => pool\.query\(q, p\), link\.flock_id, name\)\) \{/);
  // Both doors answer with the same sentence.
  expect((guest.match(/Someone already answered as that name\. Open the link on the device you used, or add a last initial\./g) || []).length).toBe(2);
});

test('a guest\'s vote survives becoming a member, and open clients re-tally', () => {
  expect(guest).toMatch(/INSERT INTO venue_votes \(flock_id, user_id, venue_name\)\s*SELECT \$1, \$2, gv\.venue_name FROM guest_votes gv WHERE gv\.guest_rsvp_id = \$3/);
  expect(guest).toMatch(/ON CONFLICT DO NOTHING/);
  expect(guest).toMatch(/if \(res\.locals\.promotedVenue\) \{\s*await broadcastGuestVote\(io, link\.flock_id, res\.locals\.promotedVenue\);/);
});

test('the guest page ranks by the same weighting members see', () => {
  expect(guest).toMatch(/async function guestTalliesWeighted\(flockId\) \{/);
  expect(guest).toMatch(/const cap = Math\.max\(membersCast\.rows\[0\]\?\.n \|\| 0, 1\);/);
  expect(guest).toMatch(/votes: v\.member_votes \+ Math\.min\(v\.guest_votes, cap\)/);
  expect((guest.match(/guestTalliesWeighted\(link\.flock_id\)/g) || []).length).toBe(2);
  expect(guest).not.toMatch(/[^d]guestTallies\(link\.flock_id\)/);
});

test('the invite URL uses the hardened base, not a preview domain', () => {
  expect(flocks).toMatch(/const \{ baseWebUrl \} = require\('\.\.\/services\/emailService'\);/);
  // inviteBase: baseWebUrl in production, and a local http origin honoured
  // outside it so a local deployment does not mint flockcorp.com links.
  expect(flocks).toMatch(/const base = inviteBase\(\);/);
  expect(flocks).toMatch(/function inviteBase\(\) \{/);
  expect(flocks).toMatch(/if \(process\.env\.NODE_ENV !== 'production' && \/\^https\?:/);
  expect(flocks).not.toMatch(/flock-app-w65m\.vercel\.app/);
});

test('a signed-out install says what the invite tap was for', () => {
  expect(app).toMatch(/const \[inviteNote, setInviteNote\] = useState\(\(\) => \(/);
  expect(app).toMatch(/Sign in and you will be taken straight into the plan you were invited to\./);
  expect(app).toMatch(/\(!authUser \? \(checkinNote \|\| inviteNote\) : ''\)/);
  expect(app).toMatch(/setCheckinNote\(''\); setInviteNote\(''\);/);
});

test('the host is told what the link grants and that it expires', () => {
  expect(chat).toMatch(/Copied\. Anyone with this link can see the plan, answer, vote, and join this flock\. It stops working two weeks from now or a week after the plan, whichever is later\./);
});

test('the two capacity bands no longer contradict each other', () => {
  expect(guestPage).toMatch(/\{guestsFull\s*\? ' It has taken as many guest answers as it can, too\. Ask them to add you from the app\.'/);
});

test('the guest page does not promise a revoke control the host does not have', () => {
  expect(guestPage).not.toMatch(/a host can switch one off/);
  expect(guestPage).not.toMatch(/They can make one from the plan in the app/);
  expect(guestPage).toMatch(/Ask whoever sent it to share the plan with you again\./);
});
