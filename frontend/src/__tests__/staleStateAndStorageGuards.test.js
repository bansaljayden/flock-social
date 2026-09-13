/**
 * SEVEN READ-ONLY AUDIT FINDINGS, 2026-09-10, PINNED.
 *
 *   1. The map card could show another venue's crowd read. `crowdData` is one
 *      state shared by the detail modal and the card; open pin B, search, tap
 *      result A, close the modal: B's card drew A's score and chart. Every
 *      write now carries `forPlaceId` and the card reads only its own. A read
 *      whose score is not a finite number draws the no-estimate state, not
 *      "NaN%".
 *   2. A bill settle or undo answering after the chat was left threw inside
 *      the updater (billSheetOwedFigures renders that one).
 *   3. resolveVenuePhoto called .startsWith on a photo_url that was an object.
 *   4. flock_pinned and flock_order were trusted to be arrays; a stored object
 *      made .includes and .indexOf throw on every boot until storage cleared.
 *   5. loadMoneyState wrote whichever flock answered last on a chat-to-chat
 *      jump. It now carries the sequence guard openVenueDetail uses.
 *   6. EditProfileForm read data.user.name off a 200 with no user row and
 *      printed the raw TypeError.
 *   7. Bare localStorage on the boot path throws in Safari with all cookies
 *      blocked and on a full quota, before the error boundary exists. The
 *      listed sites read through lib/storage.js.
 *
 * Rendered where it is cheap (the storage helper, the sign-in check, the edit
 * profile form). Source-scanned where the site lives inside App.js, the same
 * way the other App.js suites in this folder work.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test staleStateAndStorageGuards --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  updateProfile: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));

const api = require('../services/api');
const { lsGet, lsSet, lsRemove } = require('../lib/storage');
const EditProfileForm = require('../components/EditProfileForm').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/* Comments dropped so prose about a fix cannot pass for the fix; CRLF
   normalised first because this tree checks out with \r\n. */
function codeOnly(src) {
  return src
    .replace(/\r\n/g, '\n')
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
  return src.slice(start, end + endMarker.length);
}

const APP = codeOnly(read('App.js'));
// The card a map pin opens left App.js on 2026-09-13 for
// components/venue/ConsumerVenueCard.js. The two checks below are about the
// card, so they read that file, and every negative among them reads both: a
// write that forgets its place tag must not become sayable by moving one file
// across.
const CARD = codeOnly(read('components', 'venue', 'ConsumerVenueCard.js'));
const APP_AND_CARD = `${APP}\n${CARD}`;
const CHAT = codeOnly(read('screens', 'ChatDetail.js'));
const FLOCK_DETAIL = codeOnly(read('screens', 'FlockDetail.js'));
const ONBOARDING = codeOnly(read('screens', 'VenueOnboarding.js'));
const API_SRC = codeOnly(read('services', 'api.js'));

const throwingStorage = () => {
  const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
  return [
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(boom),
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(boom),
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom),
  ];
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// 7. The storage helper, and the boot-path sites routed through it
// ---------------------------------------------------------------------------

describe('lib/storage answers a blocked storage with a value, never a throw', () => {
  it('passes through when storage works', () => {
    expect(lsSet('k', 'v')).toBe(true);
    expect(lsGet('k')).toBe('v');
    expect(lsRemove('k')).toBe(true);
    expect(lsGet('k')).toBeNull();
  });

  it('returns null and false when every call throws', () => {
    throwingStorage();
    expect(() => lsGet('k')).not.toThrow();
    expect(lsGet('k')).toBeNull();
    expect(lsSet('k', 'v')).toBe(false);
    expect(lsRemove('k')).toBe(false);
  });

  it('the sign-in check at boot reads as signed out, not as a crash', () => {
    jest.isolateModules(() => {
      const realApi = jest.requireActual('../services/api');
      throwingStorage();
      expect(() => realApi.isLoggedIn()).not.toThrow();
      expect(realApi.isLoggedIn()).toBe(false);
    });
  });

  it('every listed boot-path site in App.js goes through the helper', () => {
    expect(APP).toContain("import { lsGet, lsSet } from './lib/storage';");
    expect(APP).toContain("lsGet('flock_map_type') === 'hybrid'");
    const userMode = region(APP, 'const [userMode, setUserMode] = useState(() => {', '});');
    expect(userMode).toContain("const saved = lsGet('flockUserMode');");
    expect(userMode).toContain("lsSet('flockUserMode', 'user');");
    expect(userMode).not.toContain('localStorage.');
    expect(APP).toContain("useState(() => lsGet('flock_location_enabled') !== 'false')");
    const userLocation = region(APP, 'const [userLocation, setUserLocation] = useState(() => {', '});');
    expect(userLocation).toContain("if (lsGet('flock_location_enabled') === 'false') return null;");
    expect(userLocation).toContain("const savedLat = lsGet('flock_user_lat');");
    expect(userLocation).toContain("const savedLng = lsGet('flock_user_lng');");
    expect(userLocation).not.toContain('localStorage.');
    expect(APP).toContain("lsSet('flock_pinned', JSON.stringify(pinnedFlockIds));");
    expect(APP).toContain("lsSet('flock_order', JSON.stringify(flockOrder));");
    expect(APP).toContain("lsSet('flock_interests', JSON.stringify(userInterests));");
  });

  it('the token read, the check-in read, the banner dismissal and the claim flag do too', () => {
    expect(API_SRC).toMatch(/function getToken\(\) \{\s*return lsGet\('flockToken'\);\s*\}/);
    expect(FLOCK_DETAIL).toContain("parseInt(lsGet('flock_checkin_' + flock.venueId) || '0', 10)");
    expect(FLOCK_DETAIL).not.toContain("localStorage.getItem('flock_checkin_'");
    expect(CHAT).toContain("lsSet('flock_loc_dismissed', JSON.stringify(next))");
    expect(CHAT).not.toContain("localStorage.setItem('flock_loc_dismissed'");
    // The claim is saved on the server before this line; the screen change
    // that follows must not depend on a write that can throw.
    const claim = region(ONBOARDING, 'created = await createVenueProfile(venueOnboardingData);', "setCurrentScreen('venueDashboard');");
    expect(claim).toContain("lsSet('flockVenueOnboardingComplete', 'true');");
    expect(claim).not.toContain("localStorage.setItem('flockVenueOnboardingComplete'");
  });
});

// ---------------------------------------------------------------------------
// 1. Crowd data is read by the card only when it is the card's venue
// ---------------------------------------------------------------------------

describe('the map card reads only its own crowd data', () => {
  it('every crowdData write is null, a restored snapshot, or tagged with its place id', () => {
    const writes = APP_AND_CARD.match(/setCrowdData\(([^;]*)\);/g) || [];
    expect(writes.length).toBeGreaterThanOrEqual(8);
    writes.forEach((w) => {
      const ok = w === 'setCrowdData(null);'
        || w === 'setCrowdData(prev.crowdData);'
        || w.includes('forPlaceId:');
      expect({ write: w, ok }).toEqual({ write: w, ok: true });
    });
    expect(APP).toContain('setCrowdData(crowd ? { ...crowd, forPlaceId: placeId } : null);');
    expect(APP).toContain('setCrowdData(data ? { ...data, forPlaceId: pid } : null);');
    expect(APP).toContain('setCrowdData(data ? { ...data, forPlaceId: venueDetailPlaceId } : null)');
  });

  it('the card gates the shared state on its own place id and treats a non-finite score as no estimate', () => {
    const card = region(CARD, 'const cdTagged = crowdData && crowdData.forPlaceId === activeVenue.place_id ? crowdData : null;', 'const score = cd ? cd.score : (activeVenue.crowd || 0);');
    expect(card).toContain('const cd = cdTagged && Number.isFinite(cdTagged.score) ? cdTagged : null;');
    expect(card).toContain('const noEstimate = crowdFetchFailed || (!!cdTagged && !cd);');
    expect(APP_AND_CARD).not.toContain('const cd = crowdData;');
    // The dial's no-estimate branch and the sentence beside it both key off it.
    expect(CARD).toContain(') : (!cd && noEstimate) ? (');
    expect(CARD).toContain('{noEstimate && !isClosed ? (');
    expect(APP_AND_CARD).not.toContain(') : (!cd && crowdFetchFailed) ? (');
  });
});

// ---------------------------------------------------------------------------
// 2. Bill updaters after the chat was left (rendered in billSheetOwedFigures)
// ---------------------------------------------------------------------------

test('both bill updaters in ChatDetail hand a cleared bill straight back', () => {
  const guarded = CHAT.match(/setBillSplit\(prev => \{\s*if \(!prev\) return prev;/g) || [];
  expect(guarded).toHaveLength(2);
  expect(CHAT).not.toMatch(/setBillSplit\(prev => \(\{\s*\.\.\.prev,/);
});

// ---------------------------------------------------------------------------
// 3. A venue photo that is not a string
// ---------------------------------------------------------------------------

test('resolveVenuePhoto checks the type before calling a string method', () => {
  expect(APP).toContain("const resolveVenuePhoto = (u) => (typeof u === 'string' && u.startsWith('/api/') ? `${BASE_URL}${u}` : u || null);");
});

// ---------------------------------------------------------------------------
// 4. Stored ordering that is not an array
// ---------------------------------------------------------------------------

test('flock_pinned and flock_order fall back to [] on any non-array shape', () => {
  expect(APP).toContain("try { const v = JSON.parse(localStorage.getItem('flock_pinned') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }");
  expect(APP).toContain("try { const v = JSON.parse(localStorage.getItem('flock_order') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }");
});

// ---------------------------------------------------------------------------
// 5. The money state of the chat you are in, not the one you left
// ---------------------------------------------------------------------------

test('loadMoneyState drops a response that belongs to an earlier call', () => {
  expect(APP).toContain('const moneyStateSeqRef = useRef(0);');
  const fn = region(APP, 'const loadMoneyState = useCallback((flockId) => {', '}, []);');
  expect(fn).toContain('const seq = ++moneyStateSeqRef.current;');
  expect(fn).toContain('const current = () => seq === moneyStateSeqRef.current;');
  expect(fn).toContain('.then(data => { if (!current()) return; if (data.budgetEnabled) setBudgetStatus(data); else setBudgetStatus(null); })');
  expect(fn).toContain('.catch(() => { if (current()) setBudgetStatus(null); })');
  expect(fn).toContain('.then(data => { if (current()) setBillSplit(data.bill); })');
  expect(fn).toContain('.catch(() => { if (current()) setBillSplit(null); })');
  // Leaving the chat retires whatever is still in flight for it.
  const exit = region(APP, "} else if (currentScreen !== 'chatDetail' && prevFlockIdRef.current) {", 'setBillSplit(null);');
  expect(exit).toContain('moneyStateSeqRef.current += 1;');
});

// ---------------------------------------------------------------------------
// 6. A 200 with no user row
// ---------------------------------------------------------------------------

describe('edit profile on a 200 that carries no user', () => {
  const open = () => {
    const props = {
      authUser: { email: 'sam@example.com', sign_in_method: 'apple' },
      colors: { navy: '#000', navyBg: '#111', steel: '#222', red: '#f00', redText: '#c00', creamDark: '#eee' },
      styles: { input: {}, gradientButton: {} },
      confirmClick: jest.fn(),
      profileBio: '',
      profileName: 'Sam',
      profilePhone: '',
      profilePic: null,
      setCropImageSrc: jest.fn(),
      setCropOffset: jest.fn(),
      setCropZoom: jest.fn(),
      setProfileBio: jest.fn(),
      setProfileName: jest.fn(),
      setProfilePhone: jest.fn(),
      onUserUpdated: jest.fn(),
      setShowPicModal: jest.fn(),
    };
    return { ...render(React.createElement(EditProfileForm, props)), props };
  };

  it('says the profile did not come back, not a TypeError', async () => {
    api.updateProfile.mockResolvedValueOnce({});
    const { getByText, queryByText, props } = open();
    fireEvent.click(getByText('Save Changes'));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText('The profile did not come back from the server. Try again.')).toBeTruthy());
    expect(queryByText(/Cannot read properties/)).toBeNull();
    expect(queryByText('Profile updated successfully!')).toBeNull();
    expect(props.setProfileName).not.toHaveBeenCalled();
    expect(props.onUserUpdated).not.toHaveBeenCalled();
  });
});
