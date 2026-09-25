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

test('a guest\'s vote survives becoming a member, as ONE vote, and open clients re-tally', () => {
  // The copy used to be INSERT ... ON CONFLICT DO NOTHING on (flock, user,
  // venue), so a member who already held a vote for another venue came out
  // holding two. Both join paths now carry it through carryGuestVote (the
  // newer pick is the vote, under the flockvote: lock), and re-tally either
  // way, because the guest vote left the guest ledger whether or not it moved.
  const shared = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'utils', 'guestRsvp.js'), 'utf8');
  expect(shared).toMatch(/async function carryGuestVote\(run, flockId, userId, guestRsvpIds\)/);
  expect(shared).toMatch(/pg_advisory_xact_lock\(hashtext\('flockvote:' \|\| \$1::text \|\| ':' \|\| \$2::text\)\)/);
  expect(shared).toMatch(/DELETE FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2 AND venue_name <> \$3/);
  expect(guest).not.toMatch(/ON CONFLICT DO NOTHING\s+RETURNING venue_name/);
  expect((guest.match(/carryGuestVote\(\s*\(q, p\) => (client|retireClient)\.query\(q, p\), link\.flock_id, req\.user\.id,/g) || []).length).toBe(2);
  expect(guest).toMatch(/if \(res\.locals\.carriedVote\) \{\s*await broadcastGuestVote\(io, link\.flock_id, res\.locals\.carriedVote\.venueName\);/);
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

// The link does what a member can do (2026-09-16): the budget and the night-of
// question, in the same words the chat uses and on the same wire.

test('the link and the chat ask the budget in the same words', () => {
  for (const line of [
    "What's your budget tonight?",
    'Group budget: up to',
    'It takes three amounts before Flock can show one',
    'This is anonymous. No one sees your answer.',
  ]) {
    expect({ line, inChat: chat.includes(line) }).toEqual({ line, inChat: true });
    expect({ line, onLink: guestPage.includes(line) }).toEqual({ line, onLink: true });
  }
});

test('a guest\'s own state travels as a POST body, never a query string', () => {
  expect(guest).toMatch(/router\.post\('\/:token\/me',/);
  expect(guestPage).toMatch(/\/me`, \{\s*method: 'POST',\s*headers: \{ 'Content-Type': 'application\/json' \},\s*body: JSON\.stringify\(\{ guestToken \}\)/);
  expect(guestPage).not.toMatch(/\/me\?/);
});

test('the public preview never carries a ceiling, and the page reads one only off the guest\'s own channel', () => {
  const start = guest.indexOf('async function guestBudgetSummary(');
  const end = guest.indexOf('// GET /api/guest/:token', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const summary = guest.slice(start, end);
  expect(summary).toMatch(/submissionCount:/);
  expect(summary).not.toMatch(/ceiling/);
  // On the page: the ceiling is never read off the preview's block, and it
  // is set from exactly two replies keyed on the guest's token (the /me merge
  // and the guest's own answer) plus the reset when the identity is dropped.
  expect(guestPage).not.toMatch(/budget\.ceiling/);
  expect(guestPage).toMatch(/const band = Number\(me\.ceiling\);/);
  expect(guestPage).toMatch(/const band = Number\(body\.ceiling\);/);
  expect((guestPage.match(/setCeiling\(/g) || []).length).toBe(3);
});

test('the refusal codes the page reads are the ones the server sends', () => {
  for (const code of ['NOT_IN', 'BUDGET_LOCKED', 'NOT_OPEN']) {
    expect({ code, sent: guest.includes(`code: '${code}'`) }).toEqual({ code, sent: true });
    expect({ code, read: guestPage.includes(`body.code === '${code}'`) }).toEqual({ code, read: true });
  }
});

test('an old server\'s preview is not asked for what it cannot answer', () => {
  // Both keys are always on a preview from a server that has /me; the page
  // treats their absence the way it treats an absent roster or `full`.
  expect(guest).toMatch(/reconfirm: reconfirm && reconfirm\.open \? reconfirm : null,/);
  expect(guestPage).toMatch(/const serverHasMe = !!\(data && typeof data === 'object' && \('budget' in data \|\| 'reconfirm' in data\)\);/);
  expect(guestPage).toMatch(/if \(phase !== 'ready' \|\| !serverHasMe\) return undefined;/);
});
