/**
 * PAST FLOCKS + PERSON BIO — the 2026-08 history/rerun/bio drop, locked shut.
 *
 * What shipped, each item a thing a later edit can silently unwind:
 *
 *   1. BIO ON THE OWN-PROFILE EDIT SCREEN. A textarea capped at 200 with a
 *      live counter, saved through the existing profile save, optimistic with
 *      rollback on error. The hardcoded fake bio ("Love exploring new
 *      places!") that no server ever saw is gone for good.
 *
 *   2. BIO ON THE PERSON CARD. Opening someone's sheet lazily fetches
 *      GET /api/users/:id/card; loading draws one quiet skeleton line; a
 *      missing bio (404 = blocked either way, or a backend without the route)
 *      renders NOTHING extra — never an error, never a toast.
 *
 *   3. PAST FLOCKS + "DO IT AGAIN". A Past screen lists completed/cancelled
 *      flocks from GET /api/flocks/history with skeleton loading, an inline
 *      retry on failure (a failed load must never read as "nothing here
 *      yet"), and a rerun that lands in the new flock's chat exactly the way
 *      flock creation does.
 *
 * Source-scanning, not rendering, for the same reason as every other App.js
 * suite here: each fact under test is a call-site choice in a 16,500-line
 * monolith.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const API = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'api.js'),
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

function region(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  const end = APP.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return APP.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// The service wrappers — thin, and shaped exactly like the backend contract
// ═══════════════════════════════════════════════════════════════════════════

describe('api.js wrappers', () => {
  it('getUserCard hits GET /api/users/:id/card', () => {
    expect(API).toContain('export async function getUserCard(id)');
    expect(API).toContain('`/api/users/${id}/card`');
  });

  it('getFlockHistory hits GET /api/flocks/history', () => {
    expect(API).toContain('export async function getFlockHistory()');
    expect(API).toContain("request('/api/flocks/history')");
  });

  it('rerunFlock POSTs /api/flocks/:id/rerun with the same event_time field createFlock sends', () => {
    const at = API.indexOf('export async function rerunFlock');
    expect(at).toBeGreaterThan(-1);
    const fn = API.slice(at, API.indexOf('\n}', at));
    expect(fn).toContain('`/api/flocks/${id}/rerun`');
    expect(fn).toContain("method: 'POST'");
    expect(fn).toContain('event_time');
  });

  it('updateProfile carries the bio field on the existing PUT', () => {
    const at = API.indexOf('export async function updateProfile');
    const fn = API.slice(at, API.indexOf('\n}', at));
    expect(fn).toContain('bio');
    expect(fn).toContain("'/api/users/profile'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Own bio on the edit-profile screen
// ═══════════════════════════════════════════════════════════════════════════

describe('own bio editing', () => {
  // The form left App.js on 2026-08-26. It was declared inside ProfileScreen,
  // which is declared inside FlockAppInner, and mounted as an element, so
  // React rebuilt its component type on every render of the shell and threw
  // away the DOM holding whatever had been typed, this textarea included. It
  // is components/EditProfileForm.js now, so the whole file is the region.
  const form = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'EditProfileForm.js'),
    'utf8'
  );
  const formCode = codeOnly(form);

  it('the form is still mounted from App.js, so this file is not scanning dead code', () => {
    expect(APP).toContain('<EditProfileForm {...editProfileFormProps} />');
  });

  it('the fabricated placeholder bio is gone from the whole app', () => {
    expect(APP).not.toContain('Love exploring new places!');
  });

  it('profileBio is real state seeded from the account, with a setter', () => {
    expect(APP).toContain("const [profileBio, setProfileBio] = useState(authUser?.bio || '')");
  });

  it('the form has a bio textarea capped at 200 with a live counter', () => {
    expect(formCode).toContain('<textarea');
    expect(formCode).toContain('maxLength={200}');
    expect(formCode).toContain('{editBio.length}/200');
    // Belt and braces past maxLength: paste is sliced too.
    expect(formCode).toContain('.slice(0, 200)');
  });

  it('the bio rides the existing save, optimistically, and rolls back on error', () => {
    const save = codeOnly(form.slice(form.indexOf('const handleSaveProfile')));
    // Optimistic write happens BEFORE the await...
    const optimisticAt = save.indexOf('setProfileBio(trimmedBio)');
    const awaitAt = save.indexOf('await updateProfile(payload)');
    expect(optimisticAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(optimisticAt);
    // ...the payload carries it...
    expect(save).toContain('bio: trimmedBio');
    // ...and the catch puts the old value back.
    expect(save).toContain('setProfileBio(prevBio)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Bio on the person card
// ═══════════════════════════════════════════════════════════════════════════

describe('person card bio', () => {
  const open = region('const openUserProfile = useCallback', 'const closeUserProfile');
  const openCode = codeOnly(open);
  const sheet = region('{/* Person card', '{/* Flock Pro paywall');

  it('opening the card lazily fetches the user card', () => {
    expect(openCode).toContain('getUserCard(person.id)');
  });

  it('a failed or missing card renders nothing extra: no toast, no error state', () => {
    // The catch resolves to bio null and NOTHING else — a missing bio is not
    // something to apologize for, and a block must not announce itself.
    expect(openCode).not.toContain('showToast');
    expect(openCode).toContain('bio: null');
  });

  it('a slow answer for the last person cannot land on the next one', () => {
    // Both settle paths check the reply is still for the open sheet.
    const guards = openCode.match(/String\(prev\.forId\) !== String\(person\.id\)/g) || [];
    expect(guards.length).toBe(2);
  });

  it('the sheet draws a skeleton line while loading and clamps the bio to 4 lines', () => {
    expect(sheet).toContain("userProfileCard.status === 'loading'");
    expect(sheet).toContain('className="skeleton"');
    expect(sheet).toContain('WebkitLineClamp: 4');
    // Muted, wrapping copy under the name — not a heading.
    expect(sheet).toContain("color: 'var(--text-secondary)'");
  });

  it('the bio renders only when it is for the person on screen', () => {
    const clamped = sheet.slice(0, sheet.indexOf('WebkitLineClamp'));
    expect(clamped).toContain('String(userProfileCard.forId) === String(userProfileTarget.id)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Past flocks + Do it again
// ═══════════════════════════════════════════════════════════════════════════

describe('past flocks screen', () => {
  const screen = region('const PastFlocksScreen = () =>', '// CREATE SCREEN');
  const screenCode = codeOnly(screen);
  const loader = region('const [pastFlocks, setPastFlocks] = useState(null)', 'const handleRerunFlock');
  const rerun = region('const handleRerunFlock = useCallback', '// Load trusted contacts on mount');
  const rerunCode = codeOnly(rerun);

  it('the screen is wired into the boundaried switch', () => {
    expect(APP).toContain("if (currentScreen === 'pastFlocks') return PastFlocksScreen();");
  });

  it('Home links to it from the list header and from the empty state', () => {
    const links = APP.match(/setCurrentScreen\('pastFlocks'\)/g) || [];
    expect(links.length).toBeGreaterThanOrEqual(2);
  });

  it('loading is a skeleton, not a spinner and not the empty state', () => {
    expect(screenCode).toContain('<ListSkeleton label="Loading past flocks"');
  });

  it('a failed load shows an inline retry, never the empty state', () => {
    // The retry button re-runs the loader...
    expect(screenCode).toContain('onClick={loadPastFlocks}');
    expect(screen).toContain('Try again');
    // ...and the empty sentence is triple-gated: no error, and a fetch that
    // actually landed (pastFlocks starts null until one does).
    const emptyGate = screenCode.slice(0, screenCode.indexOf('Nothing here yet'));
    expect(emptyGate).toContain('!pastFlocksError && pastFlocks && pastFlocks.length === 0');
    expect(codeOnly(loader)).toContain('useState(null)');
  });

  it('the real empty state names itself, and carries a bird', () => {
    // This used to read "one quiet sentence, no illustration" and pinned the
    // absence of any mark. Jayden, TestFlight build 26: "Birds on empty and
    // error states. Yes. It should be everywhere." So the sentence became a
    // BirdNote. What is still pinned is the part that mattered: this state
    // says plainly that there is nothing here, rather than looking like a
    // load that has not finished.
    expect(screen).toContain('Nothing here yet');
    expect(screen).toContain('A flock lands here once its night has been and gone.');
    // Still not the full-bleed EmptyMark flock, which belongs to the Nest and
    // the inbox. A history with nothing in it is a smaller moment than those.
    expect(screenCode).not.toContain('<EmptyMark');
    const around = screenCode.slice(0, screenCode.indexOf('Nothing here yet') + 400);
    expect(around).toContain('<BirdNote');
  });

  it('a failed refresh does not delete the list already on screen', () => {
    // The list render is gated on data only, never on the error flag.
    expect(screenCode).toContain('{pastFlocks && pastFlocks.length > 0 && (');
  });

  it('rows reuse the overlapping avatar-stack pattern and the shared date format', () => {
    expect(screenCode).toContain(".slice(0, 4)");
    expect(screenCode).toContain("marginLeft: j > 0 ? '-6px' : 0");
    expect(screenCode).toContain("{ month: 'short', day: 'numeric' }");
  });

  it('Do it again shows a pending state and blocks double-taps', () => {
    expect(screenCode).toContain("busy ? 'Starting…' : 'Do it again'");
    expect(screenCode).toContain('disabled={busy}');
    expect(rerunCode).toContain('if (rerunningFlockId) return');
  });

  it('a rerun lands in the new chat exactly the way flock creation does', () => {
    expect(rerunCode).toContain('newlyCreatedFlockRef.current = f.id');
    expect(rerunCode).toContain('setFlocks(prev => [...prev, newFlock])');
    expect(rerunCode).toContain('setSelectedFlockId(f.id)');
    expect(rerunCode).toContain("setCurrentScreen('chatDetail')");
  });

  it('the rerun never asks for a time that has already happened', () => {
    // The old event_time rolls forward a week at a time until it is ahead.
    expect(rerunCode).toContain('next.setDate(next.getDate() + 7)');
  });

  it('no em dashes in any of the new user-visible copy', () => {
    for (const src of [screenCode, rerunCode]) {
      const strings = src.match(/'[^'\n]*'|"[^"\n]*"/g) || [];
      for (const s of strings) expect(s).not.toContain('—');
    }
  });
});
