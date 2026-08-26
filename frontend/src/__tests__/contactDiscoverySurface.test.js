// ---------------------------------------------------------------------------
// Contact discovery: the screen has to keep the promises the rest of the system
// makes for it.
//
// Three of the invariants below cannot fail a build or a render test, because
// each one is a sentence rather than a behaviour, and a wrong sentence compiles
// exactly as well as a right one:
//
//   - iOS asks for the address book ONCE PER INSTALL. A denial stands until the
//     person walks into Settings. So the explanation has to come before the
//     system dialog, which means nothing outside the button handler may reach
//     the contacts service. A prompt moved into an effect would still pass
//     every other test in this suite and would burn the one ask.
//   - POST /api/friends/find-by-phone deliberately never says WHICH uploaded
//     number produced which person. A UI that showed the contact's own name
//     beside the Flock name would rebuild the enumeration oracle that refusal
//     exists to remove, and it would do it in the render layer where no backend
//     test is looking.
//   - Somebody who has a Flock account and has not opted in to phone discovery
//     is not "not on Flock". The server cannot tell those two apart on purpose,
//     so no copy on this screen is allowed to.
//
// The fourth pins the privacy policy and the settings control to the same
// words, because a policy that names a switch nobody can find under that name
// is not one anybody can act on.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const app = read('frontend', 'src', 'App.js');
// The Add Friends screen, and with it the whole Contacts tab, left App.js for
// screens/AddFriends.js. The handlers behind it did not move, so this file now
// reads two sources: each assertion points at whichever one holds the line it
// is about, and every negative assertion reads BOTH, so nothing this suite used
// to forbid became sayable by moving it one file across.
const screen = read('frontend', 'src', 'screens', 'AddFriends.js');
const both = `${app}\n${screen}`;
const api = read('frontend', 'src', 'services', 'api.js');
const contactsService = read('frontend', 'src', 'services', 'contacts.js');
const privacy = read('frontend', 'src', 'website', 'PrivacyPolicy.js');

// The Contacts tab, on its own. Several assertions below are about what this
// screen may not render, and the rest of the app has legitimate uses of the
// same words on screens that have nothing to do with the address book.
const contactsTab = (() => {
  const start = screen.indexOf('{/* TAB: Contacts */}');
  const end = screen.indexOf('{BottomNav()}', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
})();

describe('the address book is reached through one service, on every platform', () => {
  test('App.js never calls the web Contacts Picker itself', () => {
    // navigator.contacts is the WEB Contacts Picker. It does not exist in
    // WKWebView, and testing for it was exactly what made the iOS answer always
    // "no" while the app shipped a contacts purpose string for a feature with
    // no UI. Matched as calls rather than as the bare name, so the comment in
    // App.js that explains this does not fail its own rule.
    expect(both).not.toMatch(/navigator\.contacts\s*\./);
    expect(both).not.toMatch(/'contacts' in navigator/);
    expect(both).not.toMatch(/ContactsManager/);
  });

  test('the tab is gated on the service, not on a hand-rolled platform check', () => {
    expect(app).toMatch(/from '\.\/services\/contacts'/);
    expect(app).toMatch(/useState\(contactsAvailable\)/);
    // The old helper answered false on native. If it comes back, so does the
    // dead end.
    expect(both).not.toMatch(/contactSyncAvailable/);
  });
});

describe('the permission prompt fires only after the screen that explains it', () => {
  test('syncContacts is called from exactly one place in App.js', () => {
    const calls = both.match(/\bsyncContacts\(/g) || [];
    expect(calls).toHaveLength(1);
  });

  test('that one call sits inside the button handler, not an effect', () => {
    const handler = app.slice(app.indexOf('const handleSyncContacts'));
    const body = handler.slice(0, handler.indexOf('\n  const handleLookupByNumber'));
    expect(body).toMatch(/await syncContacts\(findFriendsByPhone\)/);
    // Both of these are the shapes a prompt-on-mount would take.
    expect(both).not.toMatch(/useEffect\([^)]*handleSyncContacts/);
    expect(both).not.toMatch(/readContactPhoneNumbers/);
  });

  test('a dismissed picker produces no toast, and a denial is not a toast either', () => {
    const handler = app.slice(app.indexOf('const handleSyncContacts'));
    const body = handler.slice(0, handler.indexOf('\n  const handleLookupByNumber'));
    // 'cancelled' returns before anything is shown.
    expect(body).toMatch(/if \(err\?\.code === 'cancelled'\) return;/);
    // 'denied' sets the state the tab renders. A toast cannot tell somebody
    // where the Settings switch is, because it is gone before they look.
    expect(body).toMatch(/if \(err\?\.code === 'denied'\) \{ setContactsDenied\(true\); return; \}/);
    expect(body).toMatch(/if \(err\?\.code === 'unavailable'\)/);
  });

  test('the service still refuses to read the book at module load', () => {
    // Pinned by the executed block at the bottom of this file, which imports
    // the module and asserts the plugin was never touched by the import.
    expect(contactsService).toMatch(/export async function readContactPhoneNumbers\(/);
  });
});

describe('the four states of the Contacts tab', () => {
  test('the pre-prompt says what leaves the phone before anything does', () => {
    expect(screen).toContain('Find friends from your contacts');
    expect(screen).toContain(
      'Flock sends only phone numbers, checks them against people who chose to be findable, and keeps nothing. Names and everything else stay on your phone.'
    );
    expect(screen).toContain('Check my contacts');
  });

  test('the denied state points at Settings and does not ask again', () => {
    expect(screen).toContain(
      'Flock does not have permission to read your contacts. You can turn it on in Settings, under Flock, or add someone by their number below.'
    );
  });

  test('a match shows the Flock name only, never the contact card it came from', () => {
    expect(contactsTab).toContain('From your contacts');
    // Scoped to the tab, because trusted contacts (a different feature, on a
    // different screen) legitimately renders a contact_name of its own.
    expect(contactsTab).not.toMatch(/contact_name|contactName|matched_number|matchedNumber/);
    // The row is name and photo. Anything else about the person came from the
    // phone, not from the server.
    expect(contactsTab).toMatch(/\{user\.name\}/);
    expect(contactsTab).toMatch(/user\.profile_image_url/);
  });

  test('an empty result uses the counts and never claims to have checked everything', () => {
    // "No Flock users found" is a claim about every number on the phone, and a
    // throttled run only looked at some of them.
    expect(both).not.toContain('No Flock users found');
    expect(screen).toContain('numbers we checked are on Flock yet');
    expect(screen).toContain('and none of them are on Flock yet. Try the rest in an hour.');
  });
});

describe('the half that needs no permission', () => {
  test('one typed number is looked up through the same route', () => {
    expect(app).toMatch(/const handleLookupByNumber = useCallback/);
    expect(app).toMatch(/findFriendsByPhone\(\[value\]\)/);
  });

  test('an empty result does not call somebody who opted out "not on Flock"', () => {
    expect(screen).toContain(
      'Nobody on Flock has that number, or they have not turned on being found by it.'
    );
  });

  test('there is one invite control and it is not per contact', () => {
    const invites = both.match(/Invite a friend/g) || [];
    expect(invites).toHaveLength(1);
    expect(app).toMatch(/navigator\.share/);
    expect(app).toMatch(/sms:&body=/);
  });
});

describe('the switch that makes any of it possible', () => {
  test('the settings control carries the name the privacy policy gives it', () => {
    const NAME = 'Let friends find me by my phone number';
    expect(privacy).toContain(NAME);
    expect(app).toContain(NAME);
  });

  test('the row reads its real state rather than guessing from authUser', () => {
    // GET /api/auth/me does not select phone_discoverable, so a row drawn from
    // authUser would say Off for somebody who is findable.
    expect(api).toMatch(/export async function getUserProfile\(/);
    expect(app).toMatch(/setPhoneDiscoverable\(Boolean\(data\.user\?\.phone_discoverable\)\)/);
    expect(app).toMatch(/phoneDiscoverable === null \? null :/);
  });

  test('the toggle lands where the server put it, not where the tap aimed', () => {
    expect(api).toMatch(/export async function setPhoneDiscovery\(enabled\)/);
    expect(app).toMatch(/setPhoneDiscoverable\(Boolean\(data\.phone_discoverable\)\)/);
  });

  test('the number can actually be added, so the switch is reachable', () => {
    // Signup does not accept a phone. Edit Profile is the only door, and a
    // "add your number in Edit Profile" message pointing at a screen with no
    // phone field would be a dead end.
    expect(api).toMatch(/export async function updateProfile\(\{ name, email, phone,/);
    expect(app).toMatch(/id="profile-phone-input"/);
    expect(app).toMatch(/if \(editPhone\.trim\(\)\) payload\.phone = editPhone\.trim\(\);/);
  });
});

describe('the sensor cards report a band, not a measurement', () => {
  test('no decibel figure reaches a user-facing screen', () => {
    // No microphone in this project has been calibrated against a sound meter,
    // so the reading is a relative index and a dB suffix is a unit the build
    // cannot support. The word band is what it can honestly say.
    expect(both).not.toMatch(/noiseDb\.toFixed/);
    // Any re-added figure, whatever it is formatted from. The prose above and
    // in App.js quotes the old string, so the unit is matched where it would
    // land in output: straight after an interpolation or a quote.
    expect(both).not.toMatch(/[}'"]\s*dB\b/);
    // The bands themselves stay.
    expect(app).toContain("{ text: 'Quiet'");
    expect(app).toContain("{ text: 'Loud'");
  });
});

// ---------------------------------------------------------------------------
// The service itself, executed rather than read.
//
// Everything above this line greps source text, and a grep over this boundary
// is worth less than it looks. Measured 2026-08-26 by hand-mutating
// services/contacts.js one defect at a time and running all 1,666 assertions:
// never firing the iOS prompt, dropping the denial throw, treating iOS 18
// limited access as a refusal, sending every number undeduped, removing the
// batch ceiling and turning a 429 back into a hard failure ALL stayed green.
// The file is the privacy boundary for the address book and it had no
// behavioural test of any kind. These run it against a stand-in plugin.
// ---------------------------------------------------------------------------

const mockPlugin = {
  checkPermissions: jest.fn(),
  requestPermissions: jest.fn(),
  getContacts: jest.fn(),
};
jest.mock('@capacitor-community/contacts', () => ({ Contacts: mockPlugin }));

// eslint-disable-next-line global-require
const service = require('../services/contacts');

const asNative = () => { window.Capacitor = { isNativePlatform: () => true }; };
const asPlainWeb = () => { delete window.Capacitor; };

describe('services/contacts, run against a stand-in address book', () => {
  beforeEach(() => {
    mockPlugin.checkPermissions.mockReset();
    mockPlugin.requestPermissions.mockReset();
    mockPlugin.getContacts.mockReset();
    asNative();
  });
  afterEach(asPlainWeb);

  test('importing the module touches no mockPlugin method', () => {
    // The module-load rule, proven rather than described. `service` was
    // required at the top of this block and nothing has been called since.
    expect(mockPlugin.checkPermissions).not.toHaveBeenCalled();
    expect(mockPlugin.requestPermissions).not.toHaveBeenCalled();
    expect(mockPlugin.getContacts).not.toHaveBeenCalled();
  });

  test('an unasked device is asked, exactly once, and then read', async () => {
    // requestPermissions IS the iOS dialog. A version of this file that only
    // ever checked would leave a fresh install stuck on "denied" forever with
    // the user never having seen a prompt.
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'prompt' });
    mockPlugin.requestPermissions.mockResolvedValue({ contacts: 'granted' });
    mockPlugin.getContacts.mockResolvedValue({ contacts: [{ phones: [{ type: 'mobile', number: '555-000-1111' }] }] });

    const out = await service.readContactPhoneNumbers();
    expect(mockPlugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(out.permission).toBe('granted');
    expect(out.numbers).toEqual(['555-000-1111']);
  });

  test('an already-granted device is read without a second dialog', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'granted' });
    mockPlugin.getContacts.mockResolvedValue({ contacts: [{ phones: [{ type: 'mobile', number: '5550002222' }] }] });

    await service.readContactPhoneNumbers();
    expect(mockPlugin.requestPermissions).not.toHaveBeenCalled();
  });

  test('iOS 18 limited access is a success, not a refusal', async () => {
    // The person chose which contacts the app may see. Throwing here would
    // show them the "go to Settings" dead end after they had just said yes.
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'limited' });
    mockPlugin.getContacts.mockResolvedValue({ contacts: [{ phones: [{ type: 'mobile', number: '5550003333' }] }] });

    const out = await service.readContactPhoneNumbers();
    expect(out.permission).toBe('limited');
    expect(out.numbers).toEqual(['5550003333']);
  });

  test('a refusal throws code denied and never reaches the book', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'denied' });
    mockPlugin.getContacts.mockResolvedValue({ contacts: [{ phones: [{ type: 'mobile', number: '5550004444' }] }] });

    await expect(service.readContactPhoneNumbers()).rejects.toMatchObject({ code: 'denied' });
    expect(mockPlugin.getContacts).not.toHaveBeenCalled();
  });

  test('a prompt the person dismisses is a denial, not an unhandled throw', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'prompt' });
    mockPlugin.requestPermissions.mockRejectedValue(new Error('user dismissed'));

    await expect(service.readContactPhoneNumbers()).rejects.toMatchObject({ code: 'denied' });
    expect(mockPlugin.getContacts).not.toHaveBeenCalled();
  });

  test('the request asks for phone numbers and nothing else', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'granted' });
    mockPlugin.getContacts.mockResolvedValue({ contacts: [] });

    await service.readContactPhoneNumbers();
    const [[arg]] = mockPlugin.getContacts.mock.calls;
    expect(Object.keys(arg.projection).sort()).toEqual(['phones']);
    expect(arg.projection.phones).toBe(true);
  });

  test('two numbers per contact, mobile first, and no card field rides along', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'granted' });
    mockPlugin.getContacts.mockResolvedValue({
      contacts: [{
        name: 'Should Not Travel',
        phones: [
          { type: 'fax', number: '5551110000' },
          { type: 'work', number: '5551112222' },
          { type: 'mobile', number: '5551111111' },
          { type: 'home', number: '5551113333' },
        ],
      }],
    });

    const out = await service.readContactPhoneNumbers();
    expect(out.numbers).toEqual(['5551111111', '5551113333']);
    expect(JSON.stringify(out)).not.toMatch(/Should Not Travel/);
  });

  test('the same number in three punctuations leaves the phone once', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'granted' });
    mockPlugin.getContacts.mockResolvedValue({
      contacts: [
        { phones: [{ type: 'mobile', number: '(555) 111-2222' }] },
        { phones: [{ type: 'mobile', number: '555-111-2222' }] },
        { phones: [{ type: 'mobile', number: '+1 5551112222' }] },
        { phones: [{ type: 'mobile', number: '5559998888' }] },
      ],
    });

    const out = await service.readContactPhoneNumbers();
    expect(out.numbers).toHaveLength(2);
    expect(out.contactCount).toBe(4);
  });

  test('a desktop browser with no picker says so instead of throwing something else', async () => {
    asPlainWeb();
    await expect(service.readContactPhoneNumbers()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('syncContacts stops where the server said it would', () => {
  const book = (n) => ({
    contacts: Array.from({ length: n }, (_, i) => ({
      phones: [{ type: 'mobile', number: `555${String(1000000 + i)}` }],
    })),
  });

  beforeEach(() => {
    mockPlugin.checkPermissions.mockReset();
    mockPlugin.requestPermissions.mockReset();
    mockPlugin.getContacts.mockReset();
    asNative();
    mockPlugin.checkPermissions.mockResolvedValue({ contacts: 'granted' });
  });
  afterEach(asPlainWeb);

  test('a book bigger than the allowance is chunked and CAPPED, not sent whole', async () => {
    // Without the cap the fourth batch is a 429 the user pays for, and on a
    // large address book it is several of them.
    mockPlugin.getContacts.mockResolvedValue(book(service.CONTACT_BATCH_SIZE * 5));
    const lookup = jest.fn().mockResolvedValue({ users: [], checked: service.CONTACT_BATCH_SIZE });

    const out = await service.syncContacts(lookup);
    expect(lookup).toHaveBeenCalledTimes(service.MAX_BATCHES);
    lookup.mock.calls.forEach(([batch]) => expect(batch.length).toBeLessThanOrEqual(service.CONTACT_BATCH_SIZE));
    // And it must SAY it did not look at everything, or the empty state lies.
    expect(out.throttled).toBe(true);
    expect(out.total).toBe(service.CONTACT_BATCH_SIZE * 5);
  });

  test('a whole book that fits reports throttled false', async () => {
    mockPlugin.getContacts.mockResolvedValue(book(10));
    const lookup = jest.fn().mockResolvedValue({ users: [], checked: 10 });

    const out = await service.syncContacts(lookup);
    expect(out.throttled).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('a 429 mid-run keeps what the earlier batches found', async () => {
    mockPlugin.getContacts.mockResolvedValue(book(service.CONTACT_BATCH_SIZE * 3));
    const rate = Object.assign(new Error('slow down'), { status: 429 });
    const lookup = jest.fn()
      .mockResolvedValueOnce({ users: [{ id: 7, name: 'Sam' }], checked: service.CONTACT_BATCH_SIZE })
      .mockRejectedValueOnce(rate);

    const out = await service.syncContacts(lookup);
    expect(out.users).toEqual([{ id: 7, name: 'Sam' }]);
    expect(out.throttled).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('any other lookup failure is the caller problem it is, not a silent empty list', async () => {
    mockPlugin.getContacts.mockResolvedValue(book(5));
    const lookup = jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 500 }));

    await expect(service.syncContacts(lookup)).rejects.toMatchObject({ status: 500 });
  });

  test('the same person found in two batches is one row', async () => {
    mockPlugin.getContacts.mockResolvedValue(book(service.CONTACT_BATCH_SIZE * 2));
    const lookup = jest.fn().mockResolvedValue({ users: [{ id: 4, name: 'Ali' }], checked: 1 });

    const out = await service.syncContacts(lookup);
    expect(out.users).toEqual([{ id: 4, name: 'Ali' }]);
  });
});
