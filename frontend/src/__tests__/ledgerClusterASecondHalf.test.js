/**
 * LEDGER CLUSTER A, SECOND HALF (tools/e2e/FINDINGS.md rows A1, A5, A6, A9, A10,
 * A11). These are wired deep inside App.js and two extracted components, so the
 * assertions read the compiled source, the same way locationToggleIsReal and
 * honestSendAndSearchCopy do, because "does this door still do the right thing"
 * is only answerable at source level for a 20,000 line component.
 *
 * The one rule these files have learned the hard way: strip comments FIRST.
 * App.js is full of prose that quotes the very strings being checked, and a scan
 * that cannot tell code from a comment reports whatever the comment says. Five
 * guards in this repository have died to that. Every read below goes through
 * codeOnly, and the stripper itself is tested, and every file is checked to be
 * non-empty so a bad path cannot pass every "does not contain" in silence.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test ledgerClusterASecondHalf --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const readRaw = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Comments dropped, string literals kept, so prose cannot pass or fail a scan. */
function codeOnly(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')     // /* block comments */
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line)) // whole-line // comments
    .join('\n');
}

const APP = codeOnly(readRaw('App.js'));
const CHAT = codeOnly(readRaw('screens', 'ChatDetail.js'));
// The DM thread left App.js for screens/DmDetail.js on 2026-08-27; the DM
// reaction pill A1 fixed went with it, so the A1 assertions read this now.
const DM = codeOnly(readRaw('screens', 'DmDetail.js'));
const ADD_FRIENDS = codeOnly(readRaw('screens', 'AddFriends.js'));
const NEW_DM = codeOnly(readRaw('components', 'NewDmModal.js'));
const EDIT_PROFILE = codeOnly(readRaw('components', 'EditProfileForm.js'));

/** Anchored slice with a size floor, so a moved anchor is a red test not a
 *  green one that quietly reads half the file or nothing at all. */
function between(src, from, to, min = 40, max = 4000) {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  const out = src.slice(a, b);
  expect(out.length).toBeGreaterThanOrEqual(min);
  expect(out.length).toBeLessThan(max);
  return out;
}

describe('the comment stripper and the reads are real', () => {
  it('drops a line comment, a block comment and a JSX comment, keeps a string', () => {
    const out = codeOnly([
      "// setDmSearchError('this is a comment')",
      "/* setBootUnreachable(true) in prose */",
      "{/* groupReactions in a jsx comment */}",
      "const kept = 'Location is still off.';",
    ].join('\n'));
    expect(out).not.toMatch(/comment|prose/);
    expect(out).toContain("'Location is still off.'");
  });

  it('every file read is a real file, not an empty string', () => {
    [['App.js', APP], ['ChatDetail.js', CHAT], ['DmDetail.js', DM],
      ['AddFriends.js', ADD_FRIENDS], ['NewDmModal.js', NEW_DM],
      ['EditProfileForm.js', EDIT_PROFILE],
    ].forEach(([name, src]) => {
      expect(`${name}:${src.length > 2000}`).toBe(`${name}:true`);
    });
  });
});

// A1 -------------------------------------------------------------------------
describe('A1: a DM reaction can be taken back after a reload', () => {
  it('the DM reaction pill groups with the shared helper, not a bespoke reduce', () => {
    // groupReactions keeps who left each reaction; the old inline reduce keyed
    // on emoji alone and threw the user_id away, so after a reload the pill knew
    // it existed but not that it was yours.
    expect(DM).toMatch(/import \{ groupReactions \} from '\.\/ChatDetail'/);
    expect(DM).toContain('groupReactions(m.reactions)');
  });

  it('ownership is compared as a string, because the two read paths disagree on type', () => {
    // REST history hands user_id back as a number, the live socket as a string.
    // The block that decides whether a DM reaction is yours must coerce both.
    const block = between(DM, 'groupReactions(m.reactions).map((g)', 'dmRemoveReact(m.id', 120, 1200);
    expect(block).toContain('String(id) === String(authUser?.id)');
    // And the strict, un-coerced comparison that broke reload is gone.
    expect(block).not.toMatch(/r\.user_id === authUser\?\.id/);
  });

  it('groupReactions is still exported from where App.js imports it', () => {
    expect(CHAT).toMatch(/export function groupReactions/);
  });
});

// A5 -------------------------------------------------------------------------
describe('A5: a cold start that cannot reach the server does not fake a sign-out', () => {
  it('a non-auth boot failure raises the unreachable state instead of the login form', () => {
    // The 401/403 branch ends the session for real; everything else is a dead
    // wire with a live session, and must say so.
    expect(APP).toContain('setBootUnreachable(true)');
    // The auth-rejection branch clears it, so a real expiry still shows sign-in.
    expect(APP).toMatch(/setBootUnreachable\(false\)[\s\S]{0,120}endSession\(bootSessionCopy/);
  });

  it('the unreachable screen renders before the sign-in form and explains itself', () => {
    const screen = between(APP, '!authUser && bootUnreachable', 'if (!authUser) {', 200, 3000);
    expect(screen).toContain("Couldn't reach Flock");
    expect(screen).toMatch(/still signed in/i);
    // A way out, not a cul de sac.
    expect(screen).toContain('window.location.reload()');
  });
});

// A6 -------------------------------------------------------------------------
describe('A6: a failed flock message and its retry survive reopening the app', () => {
  it('failed sends are mirrored to localStorage under one key', () => {
    expect(APP).toContain("const FAILED_MSG_KEY = 'flock_failed_msgs'");
    expect(APP).toContain('const persistFailedFlockMessage =');
    expect(APP).toContain('const readFailedFlockMessages =');
    expect(APP).toContain('const removeFailedFlockMessage =');
  });

  it('both failure paths in the sender persist the bubble', () => {
    // The socket-echo timeout and the HTTP catch are the two ways a flock send
    // is marked failed; both must write it down or a reload loses one of them.
    const count = (APP.match(/persistFailedFlockMessage\(flockId,/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('history load rehydrates the failed sends and self-cleans ones that landed', () => {
    const loader = between(APP, 'const loadFlockMessages = useCallback', '.catch(() => {', 200, 3000);
    expect(loader).toContain('readFailedFlockMessages(flockId)');
    expect(loader).toContain('writeFailedFlockMessages(flockId, failed)');
    // The rehydrated failures ride through mergeHistory as local, unsettled rows.
    expect(loader).toContain('mergeHistory(localWithFailed, msgs');
  });

  it('retrying drops the old persisted copy so it cannot come back as a ghost', () => {
    const retry = between(APP, 'const retryFailedMessage = useCallback', 'transmitFlockMessage(flockId', 80, 1200);
    expect(retry).toContain('removeFailedFlockMessage(flockId, failedMsg.id)');
  });
});

// A9 / A10 -------------------------------------------------------------------
describe('A9 / A10: the Discover location controls answer the tap', () => {
  it('A9: a refused retry says something different from the first refusal', () => {
    // A denied permission answers in one frame, so a retry that sets the
    // identical sentence looks like nothing happened. The forceRefresh path
    // inside requestUserLocation gets its own words.
    const geo = between(APP, 'const requestUserLocation = useCallback', '[loadVenuesAtLocation]', 400, 4000);
    expect(geo).toContain('forceRefresh');
    expect(geo).toContain('Location is still off.');
  });

  it('A10: Turn on that the device refuses leaves a sentence, not silence', () => {
    // toggleLocation used to swallow the geolocation error with () => {}. The
    // enable branch now sets the banner the "Location services off" strip is
    // replaced by, so Turn on does not look like it worked over a blank map.
    const toggle = between(APP, 'const toggleLocation = useCallback', 'const weatherFetchedRef', 200, 2500);
    expect(toggle).toContain('setLocationError(err && err.code === 1');
    expect(toggle).toContain('Location is off on your device');
  });
});

// A11 ------------------------------------------------------------------------
describe('A11: a failed people search shows the error, not "No users found"', () => {
  const HANDLERS = ['handleInviteSearch', 'handleConnectSearch', 'handleAddFriendsSearch', 'handleDmSearch'];
  const SETTERS = ['setInviteSearchError', 'setConnectSearchError', 'setAddFriendsError', 'setDmSearchError'];

  it('all four search handlers catch the error and record it', () => {
    SETTERS.forEach((setter) => {
      // Set from the error, not to a constant: the venueLoadError pattern.
      expect(APP).toMatch(new RegExp(`${setter}\\(err\\?\\.message \\|\\|`));
    });
    // And each handler still swallows the results to empty, so the two states
    // (empty vs errored) are distinct rather than one masking the other.
    HANDLERS.forEach((h) => expect(APP).toContain(`const ${h} = useCallback`));
  });

  it('App.js renders the invite and connect errors and gates the empty state behind them', () => {
    expect(APP).toContain('{inviteSearchError}');
    expect(APP).toContain('{connectSearchError}');
    // The "Nobody by that name" / "No users found" empty states do not draw
    // over an error.
    expect(APP).toContain('!inviteSearchError && inviteSearch');
    expect(APP).toContain('!connectSearchError && connectSearch');
  });

  it('the Add Friends screen renders its error in place of "No users found"', () => {
    expect(ADD_FRIENDS).toContain('{addFriendsError}');
    expect(ADD_FRIENDS).toContain('!addFriendsError && addFriendsSearch');
  });

  it('the New Message sheet renders its error in place of "No users found"', () => {
    expect(NEW_DM).toContain('{dmSearchError}');
    expect(NEW_DM).toContain('!dmSearchError && usersToShow');
  });
});

// A8 -------------------------------------------------------------------------
describe('A8: the dead Username field is gone', () => {
  it('Edit Profile no longer draws a Username control or holds its state', () => {
    expect(EDIT_PROFILE).not.toContain('profile-handle-input');
    expect(EDIT_PROFILE).not.toContain('editHandle');
    expect(EDIT_PROFILE).not.toContain('setProfileHandle');
  });

  it('App.js keeps the read-only handle for display but no writable state behind it', () => {
    expect(APP).not.toContain('setProfileHandle');
    // Derived from the address, not React state that a removed field would set.
    expect(APP).toContain("const profileHandle = authUser?.email?.split('@')[0]");
  });
});
