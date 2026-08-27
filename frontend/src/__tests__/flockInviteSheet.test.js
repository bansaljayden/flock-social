/**
 * THE INVITE SHEET, AND THE TWO SILENT FAILURES AROUND IT.
 *
 * Jayden, on what he expected the sheet to do: "you can go to your friend's
 * list and just pick them". You could not. Opening Invite Friends showed no
 * list at all. An empty search box returned an empty array, and the only
 * default content was "Available tonight", which is the availability pulses,
 * so a user with eight friends and nobody who had posted a pulse opened the
 * sheet, saw nothing, and had to type a name from memory. GET /api/friends had
 * been returning the whole accepted, block-filtered list the entire time.
 *
 * What is pinned here, each one a thing a later edit can quietly undo:
 *
 *   1. THE LIST EXISTS. The sheet fetches the friends list when it opens and
 *      renders it under "Your friends" whenever the search box is empty, with
 *      "Available tonight" kept as its own group above it.
 *
 *   2. TYPING FILTERS, IT DOES NOT REFETCH. The search handler reads the array
 *      already in hand. It used to call getFriends on a 300ms debounce after
 *      every keystroke.
 *
 *   3. A FAILED LOAD IS NOT AN EMPTY LIST. `catch { setFlockInviteResults([]) }`
 *      made a dead network indistinguishable from no match, and the sheet said
 *      "No friends by that name". The failure now has its own card and a retry,
 *      the same shape pastFlocks already uses.
 *
 *   4. ZERO FRIENDS GETS THE RIGHT ADVICE. Someone with no friends was told to
 *      "try a shorter piece of the name". They are pointed at the share-link
 *      button directly above instead.
 *
 *   5. THE ALREADY-A-MEMBER FILTER IS REAL. It read flock.members, which the
 *      chat screen fills with accepted members only. The roster is fetched when
 *      the sheet opens and every status counts.
 *
 *   6. THE TOAST REPORTS THE SERVER'S COUNT. POST /:id/invite answers 200 with
 *      { invited, throttled, full } on a partial success. The toast read the
 *      length of the local selection, so five picked with two left in the
 *      budget still said "Invited 5 friends!".
 *
 *   7. THE INVITE-LINK SIGNUP NO LONGER FAILS IN SILENCE. A password signup is
 *      unverified, the join sits behind requireVerified, and the refusal landed
 *      the new user on an empty home screen with nothing said.
 *
 *   8. THE SHARE SHEET REACHES MOBILE SAFARI. The gate also required the
 *      Capacitor shell, which is not where a texted invite is shared from.
 *
 * Source-scanning, not rendering, for the same reason as every other App.js
 * suite here: each fact under test is a call-site choice in a 23,000-line
 * monolith.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

// The flock chat screen left App.js on 2026-08-26: it lives in
// screens/ChatDetail.js now, and the message list, the composer, the reaction
// row and the report entry went with it. Nothing asserted below changed. The
// app source is simply in two files, so both are read, in the order they used
// to be one.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');
const HANDOFF = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'inviteHandoff.js'),
  'utf8'
);

/** Comments dropped, so prose naming a pattern cannot pass a test the code
 *  did not earn. */
function codeOnly(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function region(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const SHEET = region(APP, '{/* Invite Friends Modal */}', '{/* Leave Flock Confirmation Modal */}');
const SHEET_CODE = codeOnly(SHEET);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The list exists
// ═══════════════════════════════════════════════════════════════════════════

describe('the friends list the sheet never had', () => {
  test('opening the sheet fetches the friends list', () => {
    const load = region(APP, 'const loadFlockInviteFriends', 'const handleFlockInviteSearch');
    expect(load).toContain('getFriends()');
    // Keyed to the sheet opening, not to a keystroke and not to app boot.
    expect(load).toMatch(/if \(!showFlockInviteModal\) return/);
    expect(load).toContain('loadFlockInviteFriends();');
  });

  test('the fetched list is held in its own state, null until a fetch lands', () => {
    expect(APP).toContain('const [flockInviteAllFriends, setFlockInviteAllFriends] = useState(null);');
    expect(APP).toContain("const [flockInviteFriendsError, setFlockInviteFriendsError] = useState('');");
  });

  test('an empty search box renders the friends list under "Your friends"', () => {
    expect(SHEET).toContain('>Your friends<');
    const emptyBox = region(
      SHEET,
      "flockInviteSearch.trim().length === 0 && (",
      '{/* Send button */}'
    );
    expect(emptyBox).toContain('flockInviteRest.map(renderFlockInviteRow)');
  });

  test('"Available tonight" survives as its own group above it', () => {
    expect(SHEET).toContain('>Available tonight<');
    const idxPulses = SHEET.indexOf('>Available tonight<');
    const idxRest = SHEET.indexOf('>Your friends<');
    expect(idxPulses).toBeGreaterThan(-1);
    expect(idxRest).toBeGreaterThan(idxPulses);
    expect(SHEET).toContain('flockInvitePulses.map(renderFlockInviteRow)');
  });

  test('nobody is listed under both headings', () => {
    const rest = region(APP, 'const flockInviteRest = useMemo', 'const flockInviteResults = useMemo');
    expect(rest).toContain('flockInvitePulses.map');
    expect(rest).toMatch(/shownAbove\.has/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Typing filters what is already in hand
// ═══════════════════════════════════════════════════════════════════════════

describe('search is a local filter, not a refetch per keystroke', () => {
  test('the search handler only records the query', () => {
    const handler = region(APP, 'const handleFlockInviteSearch = useCallback', '\n  }, []);');
    expect(handler).toContain('setFlockInviteSearch(val)');
    expect(handler).not.toContain('getFriends');
    expect(handler).not.toContain('setTimeout');
  });

  test('results are derived from the already-fetched array', () => {
    const results = region(APP, 'const flockInviteResults = useMemo', 'const renderFlockInviteRow');
    expect(results).toContain('flockInviteCandidates.filter');
    expect(results).toContain('.toLowerCase().includes(q)');
    expect(results).not.toContain('getFriends');
  });

  test('getFriends is not called on a debounce anywhere in the invite path', () => {
    const invite = region(APP, 'const loadFlockInviteFriends', 'const handleSendFlockInvites');
    expect(invite).not.toMatch(/setTimeout\([\s\S]{0,200}getFriends/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A failed load is not an empty list
// ═══════════════════════════════════════════════════════════════════════════

describe('a load that failed says so', () => {
  test('the catch records an error instead of an empty result set', () => {
    const load = region(APP, 'const loadFlockInviteFriends', 'const handleFlockInviteSearch');
    expect(load).toContain('setFlockInviteFriendsError(');
    expect(load).not.toMatch(/catch\s*\{\s*setFlockInvite\w*\(\[\]\)/);
  });

  test('the error card carries a retry that calls the loader again', () => {
    const failure = region(SHEET, 'flockInviteFriendsError && (', '{/* Typing');
    expect(failure).toContain('title={flockInviteFriendsError}');
    expect(failure).toContain('onClick={loadFlockInviteFriends}');
    expect(failure).toContain('Try again');
  });

  test('every list state waits on a fetch that landed, so a failure cannot draw an empty list', () => {
    // Both the search branch and the empty-box branch are gated on
    // flockInviteAllFriends being non-null AND no error standing.
    const gates = SHEET_CODE.match(/!flockInviteFriendsError && flockInviteAllFriends &&/g) || [];
    expect(gates.length).toBe(2);
  });

  test('"No friends by that name" can only be reached with a query typed', () => {
    const noMatch = SHEET.indexOf('No friends by that name');
    expect(noMatch).toBeGreaterThan(-1);
    const branch = SHEET.slice(
      SHEET.lastIndexOf('flockInviteSearch.trim().length > 0', noMatch),
      noMatch
    );
    expect(branch).toContain('flockInviteResults.length > 0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Zero friends gets advice that helps
// ═══════════════════════════════════════════════════════════════════════════

describe('somebody with no friends', () => {
  test('is pointed at the share link, not at their spelling', () => {
    const zero = region(SHEET, 'flockInviteAllFriends.length === 0 && (', 'flockInviteAllFriends.length > 0');
    expect(zero).toContain('share link above');
    expect(zero).not.toContain('shorter piece of the name');
  });

  test('the share-link button it points at is in the same sheet, above it', () => {
    const button = SHEET.indexOf('Share invite link (no account needed)');
    const zero = SHEET.indexOf('No friends on Flock yet');
    expect(button).toBeGreaterThan(-1);
    expect(zero).toBeGreaterThan(button);
  });

  test('a full friends list that is entirely in the flock says that instead', () => {
    expect(SHEET).toContain('Everyone is already here');
    const branch = region(SHEET, 'flockInviteAllFriends.length > 0 && flockInviteCandidates.length === 0', '/>');
    expect(branch).toContain('share link above');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The already-a-member filter is real
// ═══════════════════════════════════════════════════════════════════════════

describe('people already in the flock are not offered again', () => {
  test('the roster is fetched when the sheet opens, from whichever screen', () => {
    const effect = region(APP, 'if (!showFlockInviteModal) return', '}, [showFlockInviteModal');
    expect(effect).toContain('getFlock(selectedFlockId)');
    expect(effect).toContain('setFlockInviteMemberIds(');
  });

  test('every roster status counts, not accepted only', () => {
    const effect = region(APP, 'if (!showFlockInviteModal) return', '}, [showFlockInviteModal');
    expect(effect).toContain('(data.members || []).map(m => String(m.id))');
    expect(effect).not.toContain("status === 'accepted'");
  });

  test('the sheet no longer filters against flock.members', () => {
    expect(SHEET_CODE).not.toContain('flock?.members');
    expect(SHEET_CODE).not.toContain('flock.members');
  });

  test('candidates are the friends who are not on the roster', () => {
    const candidates = region(APP, 'const flockInviteCandidates = useMemo', 'const flockInvitePulses');
    expect(candidates).toContain('flockInviteMemberIds');
    expect(candidates).toContain('!onRoster.has(String(f.id))');
  });

  test('a roster fetch that fails degrades to one extra name, not to a broken sheet', () => {
    const effect = region(APP, 'if (!showFlockInviteModal) return', '}, [showFlockInviteModal');
    expect(effect).toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The toast reports the server's count
// ═══════════════════════════════════════════════════════════════════════════

describe('the success toast', () => {
  const send = region(APP, 'const handleSendFlockInvites = useCallback', '// Accept a flock invite');

  test('reads the response rather than the length of the local selection', () => {
    expect(send).toContain('const res = await inviteToFlock(');
    expect(send).toContain('res?.invited');
    expect(send).not.toContain('Invited ${flockInviteSelected.length}');
  });

  test('names the two partial-success flags the route sends back on a 200', () => {
    expect(send).toContain('res?.full');
    expect(send).toContain('res?.throttled');
  });

  test('a partial send says how many of how many', () => {
    expect(send).toContain('Invited ${sent} of ${asked}');
  });

  test('a partial send is not painted as a plain success', () => {
    expect(send).toMatch(/showToast\(note, sent >= asked \? 'success' : 'warning'\)/);
  });

  test('the copy carries no em dash and no exclamation mark', () => {
    const strings = send.match(/`Invited[^`]*`/g) || [];
    expect(strings.length).toBeGreaterThanOrEqual(4);
    for (const s of strings) {
      expect(s).not.toContain(String.fromCharCode(0x2014));
      expect(s).not.toContain('!');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The invite-link signup that used to fail in silence
// ═══════════════════════════════════════════════════════════════════════════

describe('a stranger who signs up from a texted invite', () => {
  const boot = region(APP, 'redeemPendingInvite()', '// ── Past flocks');

  test('the unverified refusal is told to the person, not swallowed', () => {
    expect(boot).toContain('invite.needsEmailVerification');
    expect(boot).toContain('setVerifyPrompt(');
  });

  test('the prompt names the flock when the stash carried its name', () => {
    expect(boot).toMatch(/invite\.flockName \? `join \$\{invite\.flockName\}` : 'join this flock'/);
  });

  test('the ordinary success path still opens the chat, and only in the else', () => {
    const branch = boot.indexOf('invite.needsEmailVerification');
    const open = boot.indexOf('openJoinedFlock(invite)');
    expect(open).toBeGreaterThan(branch);
    expect(boot.slice(branch, open)).toContain('} else if (invite) {');
  });

  test('VerifyEmailSheet reads as a sentence with that prompt in it', () => {
    // The sheet left App.js on 2026-08-26. It was declared inside
    // FlockAppInner's render and mounted as an element, so its component type
    // was rebuilt on every render and DialogBehavior grabbed focus again each
    // time. It is components/VerifyEmailSheet.js now, so the whole file is the
    // region rather than a slice between two neighbours in App.js.
    const sheet = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'VerifyEmailSheet.js'),
      'utf8'
    );
    expect(sheet).toContain('Open it and you can {verifyPrompt} right away.');
    expect(sheet).toContain('resendVerification');
    // Mounted from App.js with the props it now takes, so a file nothing
    // renders cannot pass the two assertions above.
    expect(APP).toContain('<VerifyEmailSheet {...verifyEmailSheetProps} />');
  });

  test('the stash is kept, so the next boot after they click the link finishes the join', () => {
    const redeem = region(HANDOFF, 'export async function redeemPendingInvite', 'export function openJoinedFlock');
    expect(redeem).toContain('const keep = unverified || (err && err.isNetworkError);');
    expect(redeem).toContain('if (!keep && (status === 404');
    expect(redeem).toContain('return { needsEmailVerification: true, flockName: saved.flockName || null };');
  });

  test('the refused object carries no flockId, so a caller that navigates on it goes nowhere', () => {
    const open = region(HANDOFF, 'export function openJoinedFlock', 'const inviteHandoff');
    expect(open).toContain('!Number.isInteger(result.flockId)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The share sheet reaches mobile Safari
// ═══════════════════════════════════════════════════════════════════════════

describe('sharing the invite link', () => {
  const share = region(SHEET, 'createFlockInviteLink(selectedFlockId)', 'setCopiedInviteUrl(url);');

  test('the gate is the feature check alone', () => {
    expect(share).toContain("typeof navigator.share === 'function'");
  });

  test('being inside the Capacitor shell is no longer required to share', () => {
    expect(codeOnly(share)).not.toContain('isNativePlatform');
  });

  test('a declined share sheet and a browser without one both still land somewhere', () => {
    expect(share).toContain("if (e?.name === 'AbortError') return;");
    expect(share).toContain('navigator.clipboard.writeText(url)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Copy
// ═══════════════════════════════════════════════════════════════════════════

describe('SLOP-AUDIT rules on the sheet copy', () => {
  test('no em dash in anything the sheet renders', () => {
    const rendered = SHEET.match(/(title|body)="[^"]*"/g) || [];
    expect(rendered.length).toBeGreaterThanOrEqual(6);
    for (const s of rendered) expect(s).not.toContain(String.fromCharCode(0x2014));
  });

  test('the sheet claims nothing the build does not do', () => {
    // The guest link genuinely needs no account (backend/routes/guest.js), and
    // that is the only capability claim on the sheet.
    expect(SHEET).toContain('Anyone who opens it can RSVP and vote without making an account.');
    expect(SHEET).not.toMatch(/coming soon/i);
  });
});
