// ---------------------------------------------------------------------------
// The iOS shell configuration must describe the app that actually exists.
//
// Info.plist, App.entitlements and the Capacitor configs are the files App
// Review reads, and nothing in the normal development loop ever proves them
// wrong: the web build is green whether or not a purpose string promises a
// feature that was deleted, and a permission nobody uses costs nothing until a
// reviewer asks about it.
//
// So these are not grep-for-a-phrase tests. Each one reads the file that
// DECIDES the behaviour (App.js for what opens the camera, routes/billing.js
// for which payment app is launched, services/firebaseService.js for what an
// APNs payload contains) and fails when the configuration and that file
// disagree. The failure then arrives on the commit that changes the behaviour,
// instead of arriving as a rejection.
//
// Both directions are defects and both are asserted:
//   - a capability declared that no code uses  -> remove the declaration
//   - a capability code needs that is undeclared -> add it, or the feature
//     fails silently on device
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const IOS_APP = ['frontend', 'ios', 'App', 'App'];

const infoPlist = read(...IOS_APP, 'Info.plist');
const entitlements = read(...IOS_APP, 'App.entitlements');

const capConfigTs = read('frontend', 'capacitor.config.ts');
const pbxproj = read('frontend', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const codemagic = read('codemagic.yaml');

// The flock chat screen left App.js on 2026-08-26: it lives in
// screens/ChatDetail.js now, and the message list, the composer, the reaction
// row and the report entry went with it. Nothing asserted below changed. The
// app source is simply in two files, so both are read, in the order they used
// to be one.
const app = read('frontend', 'src', 'App.js')
  + read('frontend', 'src', 'screens', 'ChatDetail.js');
// The only file that touches the address book. The contacts purpose string is
// asserted against THIS rather than against App.js, because App.js calls it and
// this is where the permission is actually requested.
const contactsService = read('frontend', 'src', 'services', 'contacts.js');
const billing = read('backend', 'routes', 'billing.js');
const firebaseService = read('backend', 'services', 'firebaseService.js');
const appDelegate = read(...IOS_APP, 'AppDelegate.swift');
const pkg = JSON.parse(read('frontend', 'package.json'));

// ---------------------------------------------------------------------------
// Two of the files under ios/ are GENERATED, not tracked.
//
// `npx cap sync ios` writes ios/App/App/capacitor.config.json and
// ios/App/App/config.xml, and frontend/ios/.gitignore excludes both on purpose
// under its own "Generated Config files" heading. They are present on a machine
// that has run a sync and absent in every fresh clone, including this
// repository's CI checkout. Reading them at module scope used to throw ENOENT
// and take the whole suite down with it, which is how a file that passed 61
// other suites came back red the first time it ran anywhere but one laptop.
//
// The checks they feed are real and they stay: the bundled copy is what the
// WebView reads at runtime, so a stale one silently overrides
// capacitor.config.ts and nothing else in the build would notice. What must
// never happen is those checks passing on a checkout that cannot perform them.
// So every assertion that needs a generated file is registered as an EXPLICIT
// SKIP when it is missing, carrying the reason in its own name, and the
// assertions that can be made from tracked files (capacitor.config.ts,
// project.pbxproj, codemagic.yaml, package.json) are split out so they run
// either way.
// ---------------------------------------------------------------------------
const GENERATED_JSON = path.join(REPO, ...IOS_APP, 'capacitor.config.json');
const GENERATED_XML = path.join(REPO, ...IOS_APP, 'config.xml');
const hasGeneratedConfig = fs.existsSync(GENERATED_JSON) && fs.existsSync(GENERATED_XML);
const generatedConfig = () => JSON.parse(fs.readFileSync(GENERATED_JSON, 'utf8'));
const generatedXml = () => fs.readFileSync(GENERATED_XML, 'utf8');
const NEEDS_SYNC = 'SKIPPED, ios/App/App/capacitor.config.json and'
  + ' ios/App/App/config.xml are absent: `npx cap sync ios` generates them and'
  + ' gitignore excludes them, so they cannot exist in a fresh clone. Run the'
  + ' sync to make this check run';
/** Name decorator: a skipped check says in the report what did not run, and why. */
const g = (name) => (hasGeneratedConfig ? name : `${name} [${NEEDS_SYNC}]`);
const testGenerated = hasGeneratedConfig ? test : test.skip;

if (!hasGeneratedConfig) {
  // eslint-disable-next-line no-console
  console.warn(
    `[iosShellConfig] ${NEEDS_SYNC}. The generated-config drift checks did NOT run.`
  );
}

// The SVG/XLink XML namespaces are URIs that identify a vocabulary; no
// implementation ever resolves them. They are the only http:// strings in the
// client, and counting them as network loads would make the scheme and ATS
// assertions below wrong in a confusing direction.
const XML_NAMESPACE = /https?:\/\/www\.w3\.org\/[^'"`\s>]*/g;
const withoutXmlns = app.replace(XML_NAMESPACE, '');

// --- tiny plist reader -----------------------------------------------------
// Enough of the format for these assertions, and deliberately comment-blind:
// every one of these files carries long explanatory comments, and a test that
// matched inside a comment would pass on prose instead of on configuration.
const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

const plistKeys = (xml) =>
  [...stripComments(xml).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);

// Entitlement keys are reverse-DNS, so the dots have to be escaped or the
// pattern quietly matches a key it was not asked about.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The <string> immediately following <key>name</key>, or null. */
const plistString = (xml, name) => {
  const m = stripComments(xml).match(
    new RegExp(`<key>${esc(name)}</key>\\s*<string>([\\s\\S]*?)</string>`)
  );
  return m ? m[1] : null;
};

/** The <string> members of the <array> immediately following <key>name</key>. */
const plistArray = (xml, name) => {
  const m = stripComments(xml).match(
    new RegExp(`<key>${esc(name)}</key>\\s*<array>([\\s\\S]*?)</array>`)
  );
  if (!m) return null;
  return [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((s) => s[1]);
};

const hasKey = (xml, name) => plistKeys(xml).includes(name);

// ---------------------------------------------------------------------------
// 0. The files have to parse at all.
// ---------------------------------------------------------------------------
describe('the shell config files are well formed', () => {
  // These four files are the ones nothing else in the repo parses. A malformed
  // one fails the Codemagic archive 20 minutes into a cloud build with an error
  // that does not name the file, so it is worth catching here.
  //
  // This is a REAL parse, not a tag count. It is here because writing the
  // comments above these keys broke App.entitlements exactly once: an XML
  // comment may not contain a double hyphen, and the explanation of a CLI flag
  // spelled with two of them is silently illegal XML.
  const parses = (xml) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const error = doc.querySelector('parsererror');
    expect(error && error.textContent).toBeFalsy();
  };

  test.each([
    ['Info.plist', infoPlist],
    ['App.entitlements', entitlements],
  ])('%s parses as XML', (name, xml) => parses(xml));

  testGenerated(g('the generated config.xml parses as XML'), () => parses(generatedXml()));

  test.each([
    ['Info.plist', infoPlist],
    ['App.entitlements', entitlements],
  ])('%s is a balanced plist with no duplicate keys', (name, xml) => {
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toMatch(/<plist version="1\.0">[\s\S]*<\/plist>\s*$/);

    const body = stripComments(xml);
    const count = (re) => (body.match(re) || []).length;
    expect(count(/<dict>/g)).toBe(count(/<\/dict>/g));
    expect(count(/<array>/g)).toBe(count(/<\/array>/g));
    expect(count(/<key>/g)).toBe(count(/<\/key>/g));
    expect(count(/<string>/g)).toBe(count(/<\/string>/g));

    // A duplicate key is legal XML and silently wins or loses depending on the
    // parser, which is the worst possible failure mode for an entitlement.
    const keys = plistKeys(xml);
    expect(keys).toHaveLength(new Set(keys).size);
  });

  testGenerated(g('the generated config.xml is balanced'), () => {
    expect(generatedXml()).toMatch(/<widget[\s\S]*<\/widget>\s*$/);
  });

  testGenerated(g('the generated capacitor.config.json is valid JSON'), () => {
    expect(() => generatedConfig()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 1. Purpose strings. The routed finding: these promised "stories".
// ---------------------------------------------------------------------------
describe('every NS*UsageDescription is one the app actually needs', () => {
  const usageKeys = () => plistKeys(infoPlist).filter((k) => /UsageDescription$/.test(k));

  test('the plist declares exactly the four permissions the client exercises', () => {
    // Adding a fifth is not forbidden, it just has to be justified by code and
    // added to this list in the same change.
    expect(usageKeys().sort()).toEqual([
      'NSCameraUsageDescription',
      'NSContactsUsageDescription',
      'NSLocationWhenInUseUsageDescription',
      'NSPhotoLibraryUsageDescription',
    ]);
  });

  test('a camera string is present exactly while something opens the camera', () => {
    // Two independent call sites, both getUserMedia inside the web view.
    const viewfinder = /navigator\.mediaDevices\.getUserMedia\(/.test(app);
    const qrScanner = /new Html5Qrcode\(/.test(app) && /startQrScanner/.test(app);
    const opensCamera = viewfinder || qrScanner;

    expect(opensCamera).toBe(hasKey(infoPlist, 'NSCameraUsageDescription'));
    // Both are expected to be live today; if one is deleted, the string below
    // has to stop describing it.
    expect(viewfinder).toBe(true);
    expect(qrScanner).toBe(true);
  });

  test('a photo library string is present exactly while an image file input exists', () => {
    const picks = (app.match(/type="file" accept="image\/\*"/g) || []).length;
    expect(picks > 0).toBe(hasKey(infoPlist, 'NSPhotoLibraryUsageDescription'));

    // The three pickers the string describes: profile picture, flock chat, DM.
    // If this count changes, re-read the string. The venue logo used to be the
    // fourth, and is deliberately not anymore: the server only stores our own
    // Places-proxy photo URLs, so the logo is picked from the linked Google
    // listing's photos (openVenueLogoPicker) and never touches the library.
    expect(picks).toBe(3);
    for (const handler of [
      'handlePhotoUpload',
      'handleChatImageSelect',
      'handleDmImageSelect',
    ]) {
      expect(app).toContain(handler);
    }
    expect(app).not.toContain('handleVenueLogoUpload');
  });

  test('a location string is present exactly while the client reads location', () => {
    const readsLocation = /navigator\.geolocation\.(getCurrentPosition|watchPosition)\(/.test(app);
    expect(readsLocation).toBe(hasKey(infoPlist, 'NSLocationWhenInUseUsageDescription'));
  });

  test('no purpose string promises stories while the client has no story surface', () => {
    // Same condition legalPagesMatchCode.test.js uses for the policy pages. The
    // permission prompt was the last place the claim survived, so it gets the
    // same guard. If a story UI ships, update the strings, do not delete this.
    expect(app).not.toMatch(/\bgetStories\b/);
    expect(app).not.toMatch(/\bcreateStory\b|\bpostStory\b|\bdeleteStory\b/);

    for (const key of usageKeys()) {
      expect(plistString(infoPlist, key)).not.toMatch(/\bstor(y|ies)\b/i);
    }
  });

  test('each purpose string names a specific use, in a sentence a user reads', () => {
    for (const key of usageKeys()) {
      const s = plistString(infoPlist, key);
      expect(s).not.toBeNull();

      // Apple rejects strings that restate the permission without saying what
      // the app does with it. Length is the crude proxy; the checks under it
      // are the real ones.
      expect(s.length).toBeGreaterThan(60);
      expect(s.startsWith('Flock')).toBe(true);
      expect(s.trim().endsWith('.')).toBe(true);

      // SLOP-AUDIT: no em dashes in user-visible copy, and a permission prompt
      // is about as user-visible as text gets.
      expect(s).not.toMatch(/[—–]/);

      // Vague boilerplate Apple calls out by name.
      expect(s).not.toMatch(/to (provide|improve|enhance) (a |your )?(better )?(user )?experience/i);
      expect(s).not.toMatch(/\bfor app functionality\b|\bis required\b|\bneeds access\b/i);
    }
  });

  test('the camera and photo strings name only surfaces that exist', () => {
    const camera = plistString(infoPlist, 'NSCameraUsageDescription');
    const photos = plistString(infoPlist, 'NSPhotoLibraryUsageDescription');

    // Every noun these strings use has to be a real surface.
    expect(app).toContain("openCameraViewfinder('flock')");
    expect(app).toContain("openCameraViewfinder('dm')");
    // The scanner decodes straight into a friend request, which is what lets
    // the camera string say "to add them".
    expect(app).toMatch(/parsed\.type === 'flock_friend'[\s\S]{0,600}addFriendByCode\(/);

    for (const s of [camera, photos]) {
      expect(s).toMatch(/flock chat/i);
      expect(s).toMatch(/direct message/i);
      // Both reach the profile picture, so both say so.
      expect(s).toMatch(/profile/i);
      // Neither reaches the venue logo anymore: it is picked from the linked
      // Google listing's photos, not the camera or the library, so a string
      // that still said "venue picture" would describe a surface that does
      // not exist.
      expect(s).not.toMatch(/venue/i);
    }
    expect(camera).toMatch(/scan/i);
  });

  test('the camera string covers the file inputs too, not just getUserMedia', () => {
    // On iOS the "Take Photo" option in a file-input action sheet is offered by
    // the system, so the camera is reachable from every picker even though no
    // line of client code mentions it. A camera string that described only the
    // in-app viewfinder would under-describe the permission.
    const pickerHandlers = ['handlePhotoUpload'];
    for (const handler of pickerHandlers) expect(app).toContain(handler);
    // No picker pins itself to the library with capture=, so every one can
    // open the camera.
    expect(app).not.toMatch(/accept="image\/\*"\s+capture=/);

    const camera = plistString(infoPlist, 'NSCameraUsageDescription');
    expect(camera).toMatch(/profile/i);
  });
});

describe('the permissions that are absent are absent for a reason', () => {
  test('no microphone string: every getUserMedia call asks for audio: false', () => {
    const calls = [...app.matchAll(/navigator\.mediaDevices\.getUserMedia\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) expect(args).toMatch(/audio:\s*false/);
    expect(hasKey(infoPlist, 'NSMicrophoneUsageDescription')).toBe(false);
  });

  test('no photo-library-add string: nothing writes an image back to the library', () => {
    expect(app).not.toMatch(/download=|\bsaveAs\b|Media\.savePhoto|savePicture/);
    expect(hasKey(infoPlist, 'NSPhotoLibraryAddUsageDescription')).toBe(false);
  });

  test('the contacts string is present exactly while native code reads contacts', () => {
    // This test used to assert the OPPOSITE, and it was right to: contact sync
    // was `navigator.contacts.select`, a web API that does not exist in
    // WKWebView and never triggers a native prompt, so a contacts string would
    // have described a permission nothing could use. What changed is that the
    // native read now exists (services/contacts.js), and with it the reason
    // the string does.
    //
    // Both directions, the way the rest of this file works. The plugin, the
    // call site and the purpose string are one decision and have to move
    // together.
    const declaresPlugin = Object.keys(pkg.dependencies).includes('@capacitor-community/contacts');
    const readsContacts = /Contacts\.getContacts\(/.test(contactsService)
      && /Contacts\.requestPermissions\(/.test(contactsService);
    expect(declaresPlugin).toBe(true);
    expect(readsContacts).toBe(true);
    expect(hasKey(infoPlist, 'NSContactsUsageDescription')).toBe(declaresPlugin && readsContacts);
  });

  test('the contacts string promises phone numbers only, and the projection keeps that promise', () => {
    // The string tells the user nothing but phone numbers leaves the phone.
    // That is only true because of ONE line, so that line is what is asserted
    // rather than the sentence describing it: a projection that grew a `name:
    // true` would turn the prompt into a false statement, silently.
    const projections = [...contactsService.matchAll(/getContacts\(\{\s*projection:\s*\{([^}]*)\}/g)];
    expect(projections.length).toBeGreaterThan(0);
    for (const [, fields] of projections) {
      expect(fields).toMatch(/phones:\s*true/);
      for (const forbidden of ['name', 'emails', 'image', 'note', 'postalAddresses', 'organization', 'birthday', 'urls']) {
        expect(fields).not.toMatch(new RegExp(`${forbidden}\s*:\s*true`));
      }
    }
    const contacts = plistString(infoPlist, 'NSContactsUsageDescription');
    expect(contacts).toMatch(/phone number/i);
    expect(contacts).toMatch(/not stored/i);
  });

  test('nothing writes to the address book, so there is no write path to describe', () => {
    // createContact and deleteContact are on the plugin and are not called. If
    // one ever is, iOS wants the same key but the sentence above stops being
    // true, and this is where that lands.
    expect(contactsService).not.toMatch(/Contacts\.createContact\(|Contacts\.deleteContact\(/);
  });

  test('the contacts prompt cannot fire on launch', () => {
    // iOS asks once per install. Spending that prompt at cold start, the way
    // the notification prompt already is, means a permanent denial from people
    // who had no reason yet to say yes. requestPermissions therefore lives
    // behind readContactPhoneNumbers, which is exported for a tap handler to
    // call, and nothing in this module runs it at import time.
    const topLevelCall = /^\s*(await\s+)?(Contacts\.requestPermissions|readContactPhoneNumbers|syncContacts)\(/m;
    expect(topLevelCall.test(contactsService)).toBe(false);
    expect(contactsService).toMatch(/export async function readContactPhoneNumbers\(/);
  });

  test('no always-location string, and no plugin that could request it', () => {
    // An always-authorization string with no always API is what produced the
    // ITMS-90683 rejection this file used to carry.
    expect(Object.keys(pkg.dependencies)).not.toContain('@capacitor/geolocation');
    expect(hasKey(infoPlist, 'NSLocationAlwaysAndWhenInUseUsageDescription')).toBe(false);
    expect(hasKey(infoPlist, 'NSLocationAlwaysUsageDescription')).toBe(false);
  });

  test('no calendar or NFC string: both features are plain HTTP, not native frameworks', () => {
    // getCalendarEvents / getNfcCheckin are REST calls in services/api.js, and
    // NFC check-in is a tag that opens a URL. Neither touches EventKit or
    // CoreNFC, so neither needs a purpose string.
    expect(Object.keys(pkg.dependencies).join(' ')).not.toMatch(/calendar|nfc/i);
    expect(hasKey(infoPlist, 'NSCalendarsUsageDescription')).toBe(false);
    expect(hasKey(infoPlist, 'NFCReaderUsageDescription')).toBe(false);
  });

  test('no tracking string: nothing links the AppTrackingTransparency framework', () => {
    expect(pbxproj).not.toMatch(/AppTrackingTransparency/);
    expect(hasKey(infoPlist, 'NSUserTrackingUsageDescription')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. LSApplicationQueriesSchemes, against the code that builds the URLs.
// ---------------------------------------------------------------------------
describe('the queried URL schemes are exactly the ones the app can open', () => {
  // routes/billing.js is the only place in the product that produces a custom
  // scheme; App.js only ever builds https URLs.
  const builtSchemes = () =>
    [...billing.matchAll(/deepLink:\s*`([a-z][a-z0-9+.-]*):\/\//gi)].map((m) => m[1].toLowerCase());

  test('the plist lists every scheme billing.js builds, and nothing else', () => {
    const declared = plistArray(infoPlist, 'LSApplicationQueriesSchemes');
    expect(declared).not.toBeNull();
    expect([...new Set(declared)].sort()).toEqual([...new Set(builtSchemes())].sort());
  });

  test('the set is venmo and cashapp, and Zelle is deliberately not in it', () => {
    expect([...new Set(builtSchemes())].sort()).toEqual(['cashapp', 'venmo']);

    // Zelle has no shared scheme: it lives inside each bank's own app, so the
    // route ships written instructions instead of a link. A `zelle` entry here
    // would be a declaration for a URL that is never constructed.
    expect(billing).toMatch(/method:\s*'zelle'[\s\S]{0,200}deepLink:\s*null/);
    expect(plistArray(infoPlist, 'LSApplicationQueriesSchemes')).not.toContain('zelle');
  });

  test('App.js itself introduces no custom scheme of its own', () => {
    // If it ever does, that scheme needs to join the array above. The XML
    // namespace on every inline <svg> is a bare identifier that is never
    // fetched, so it is dropped before the scan rather than counted as an
    // http:// load (which would also read as an ATS problem, and is not one).
    const literals = [...withoutXmlns.matchAll(/['"`]([a-z][a-z0-9+.-]*):\/\//gi)]
      .map((m) => m[1].toLowerCase());
    expect([...new Set(literals)].sort()).toEqual(['https']);
  });
});

// ---------------------------------------------------------------------------
// 3. Background modes, against the payload the backend actually sends.
// ---------------------------------------------------------------------------
describe('background modes trace to real push behaviour', () => {
  test('no remote-notification mode while every push is an alert push', () => {
    // The mode is only earned by a push that wakes the app, which means
    // content-available in the aps payload. The service sends alert pushes
    // only, so declaring the mode would be an unused capability.
    expect(firebaseService).toMatch(/'apns-push-type':\s*'alert'/);
    expect(firebaseService).not.toMatch(/content-available|contentAvailable/);

    const modes = plistArray(infoPlist, 'UIBackgroundModes') || [];
    expect(modes).not.toContain('remote-notification');
    expect(hasKey(infoPlist, 'UIBackgroundModes')).toBe(false);
  });

  test('no location background mode, and the app never asks to run in the background', () => {
    const modes = plistArray(infoPlist, 'UIBackgroundModes') || [];
    expect(modes).toEqual([]);
  });

  test('alert push still has everything it needs: the entitlement and the token bridge', () => {
    // Removing the background mode must not be mistaken for removing push.
    expect(plistString(entitlements, 'aps-environment')).toBe('production');
    expect(appDelegate).toMatch(/didRegisterForRemoteNotificationsWithDeviceToken/);
    expect(appDelegate).toMatch(/capacitorDidRegisterForRemoteNotifications/);
    expect(Object.keys(pkg.dependencies)).toContain('@capacitor-firebase/messaging');
  });
});

// ---------------------------------------------------------------------------
// 4. Entitlements versus what is actually provisioned.
// ---------------------------------------------------------------------------
describe('entitlements match the shipping code and the signing pipeline', () => {
  test('Sign in with Apple is entitled exactly while the button ships', () => {
    const buttonShips =
      /import AppleSignInButton/.test(read('frontend', 'src', 'components', 'auth', 'LoginScreen.js')) &&
      /<AppleSignInButton/.test(read('frontend', 'src', 'components', 'auth', 'LoginScreen.js'));

    expect(buttonShips).toBe(hasKey(entitlements, 'com.apple.developer.applesignin'));
    // Guideline 4.8: it is required wherever Google sign-in is offered, so the
    // entitlement is not the thing to delete when signing fails.
    expect(buttonShips).toBe(true);
    expect(plistArray(entitlements, 'com.apple.developer.applesignin')).toEqual(['Default']);
  });

  test('aps-environment matches the profile type Codemagic fetches', () => {
    // production is correct for an App Store distribution profile and wrong for
    // a development one, so the two have to be read together.
    expect(codemagic).toMatch(/--type IOS_APP_STORE/);
    expect(plistString(entitlements, 'aps-environment')).toBe('production');
  });

  test('every associated domain entitled is one the deployment actually answers for', () => {
    // This test used to pin the key ABSENT, because neither half of the switch
    // existed. Both halves landed in 9fab8a9 and the assertion has to follow
    // the behaviour, not outlive it. An entitlement is still only half of a
    // capability: iOS fetches /.well-known/apple-app-site-association from the
    // exact host the link names and does NOT follow a redirect, so a domain
    // entitled here that the deployment does not answer for directly is a link
    // that opens Safari and no error anywhere.
    const domains = [...entitlements.matchAll(/<string>applinks:([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(hasKey(entitlements, 'com.apple.developer.associated-domains')).toBe(true);
    expect(domains.sort()).toEqual(['flockcorp.com', 'www.flockcorp.com']);

    // The other half, in this repo: the file exists and the path Apple fetches
    // is rewritten to it. A rewrite that stops matching is invisible on device.
    expect(fs.existsSync(path.join(REPO, 'frontend', 'api', 'apple-app-site-association.js'))).toBe(true);
    const vercel = JSON.parse(read('frontend', 'vercel.json'));
    expect(vercel.rewrites).toContainEqual({
      source: '/.well-known/apple-app-site-association',
      destination: '/api/apple-app-site-association',
    });

    // The association names TEAM.bundleid, so a bundle id change has to reach
    // this file too or the association matches no app that exists.
    expect(read('frontend', 'api', 'apple-app-site-association.js'))
      .toContain('${teamId}.com.flockcorp.flock');
  });

  test('the only URL scheme declared is the one Google Sign-In hands back', () => {
    // CFBundleURLTypes used to be absent, and the absence was the assertion.
    // It is present now for exactly one reason: GoogleSignIn completes the
    // native flow by redirecting to the REVERSED form of the app's iOS OAuth
    // client id, so without that scheme the sheet opens and never returns —
    // which is the dead-button defect useGoogleAuth.js exists to fix.
    //
    // What is still pinned is the shape. An app-owned `flock://` scheme would
    // be a declared entry point nothing in the repo emits (see the plist's own
    // comment), so the array must stay at one member, and that member must be
    // a reversed Google client id.
    expect(hasKey(infoPlist, 'CFBundleURLTypes')).toBe(true);
    const schemes = plistArray(infoPlist, 'CFBundleURLSchemes');
    expect(schemes).toEqual([expect.stringMatching(/^com\.googleusercontent\.apps\./)]);
    expect(stripComments(infoPlist)).not.toMatch(/<string>flock<\/string>/);

    // The native button reads the UNreversed id from this env var, and hides
    // itself when the var is missing, so the two are one setting in two files.
    expect(read('frontend', 'src', 'components', 'auth', 'useGoogleAuth.js'))
      .toContain('REACT_APP_GOOGLE_IOS_CLIENT_ID');
  });

  test('the project signs with this entitlements file in both configurations', () => {
    const refs = (pbxproj.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g) || []).length;
    expect(refs).toBe(2); // Debug and Release
  });
});

// ---------------------------------------------------------------------------
// 5. App Transport Security.
// ---------------------------------------------------------------------------
describe('App Transport Security has no exceptions to justify', () => {
  test('no ATS key at all, and in particular no blanket arbitrary loads', () => {
    expect(hasKey(infoPlist, 'NSAppTransportSecurity')).toBe(false);
    expect(stripComments(infoPlist)).not.toMatch(/NSAllowsArbitraryLoads/);
  });

  testGenerated(g('the Cordova whitelist in the generated config.xml grants nothing'), () => {
    // <access origin="*"/> is stock Capacitor template boilerplate and is not
    // an ATS exception. It only reads as one to somebody skimming the file.
    const xml = generatedXml();
    expect(xml).toMatch(/<access origin="\*" \/>/);
    expect(xml).toMatch(/Capacitor does not\s*\n?\s*implement the whitelist plugin/);
  });
});

// ---------------------------------------------------------------------------
// 6. The three Capacitor configs, which is the drift shape this repo produces.
// ---------------------------------------------------------------------------
// Each native plugin package contributes exactly one plugin class. A missing
// entry means the plugin is not registered and its JS calls reject at runtime;
// an extra entry fails the SwiftPM build. The left side is tracked
// (package.json), the right side is only observable in the generated config,
// which is why the two halves are asserted separately below.
const PLUGIN_CLASSES = {
  '@capacitor-community/apple-sign-in': 'SignInWithApple',
  '@capacitor-community/contacts': 'ContactsPlugin',
  '@capacitor-firebase/app': 'FirebaseAppPlugin',
  '@capacitor-firebase/messaging': 'FirebaseMessagingPlugin',
  '@capacitor/app': 'AppPlugin',
  '@capgo/capacitor-social-login': 'SocialLoginPlugin',
  '@revenuecat/purchases-capacitor': 'PurchasesPlugin',
};

describe('capacitor.config.ts and the copy under ios/ agree', () => {
  // The bundled copy wins at runtime, so a stale one would silently override
  // the source of truth. `npx cap sync ios` regenerates it, which means drift
  // here is invisible until someone reads both files.
  testGenerated.each(['appId', 'appName', 'webDir'])(
    g('%s matches'),
    (key) => {
      const value = generatedConfig()[key];
      expect(value).toBeTruthy();
      expect(capConfigTs).toMatch(new RegExp(`${key}:\\s*'${esc(value)}'`));
    }
  );

  testGenerated(g('the ios block matches'), () => {
    const json = generatedConfig();
    expect(json.ios.scrollEnabled).toBe(false);
    expect(json.ios.backgroundColor).toBe('#0b1a2e');
  });

  // The same two values, read from the file that IS tracked. This half runs in
  // a fresh clone, so a change to capacitor.config.ts that contradicts what the
  // native shell needs is still caught without a sync.
  test('capacitor.config.ts still declares the ios block the shell depends on', () => {
    expect(capConfigTs).toMatch(/scrollEnabled:\s*false/);
    expect(capConfigTs).toMatch(/backgroundColor:\s*'#0b1a2e'/);
  });

  testGenerated(g('the experimental SwiftPM package options match'), () => {
    const opts = generatedConfig().experimental.ios.spm.packageOptions;
    expect(Object.keys(opts).sort()).toEqual(['@capacitor-firebase/app', '@capacitor-firebase/messaging']);
    for (const name of Object.keys(opts)) {
      expect(opts[name].symlink).toBe(true);
      expect(capConfigTs).toContain(`'${name}'`);
    }
  });

  test('SocialLogin bundles Google only', () => {
    // This block is not cosmetic: the plugin's own sync hook reads it and
    // comments the unwanted SDKs out of its Package.swift. Leaving facebook on
    // would link the Facebook SDK (and its AppTrackingTransparency code) into
    // the binary, which contradicts the written answer given to App Review
    // that this app does no cross-app tracking and shows no ATT prompt.
    expect(capConfigTs).toMatch(/SocialLogin:\s*\{[\s\S]*?facebook:\s*false/);
    expect(hasKey(infoPlist, 'NSUserTrackingUsageDescription')).toBe(false);
  });

  testGenerated(g('the bundled copy says SocialLogin bundles Google only too'), () => {
    expect(generatedConfig().plugins.SocialLogin.providers).toEqual({
      google: true, facebook: false, apple: false, twitter: false,
    });
  });

  test('every Capacitor plugin dependency has a declared plugin class', () => {
    // Everything in package.json that is a Capacitor plugin, less the three
    // packages that are the runtime itself rather than plugins. @capgo is here
    // because a plugin scope that the filter does not know about is invisible
    // to this test in the one direction that matters: it would ship a native
    // plugin nobody asserted anything about.
    const NOT_PLUGINS = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios'];
    const installed = Object.keys(pkg.dependencies).filter(
      (d) => /^@(capacitor(-community|-firebase)?|capgo)\//.test(d) || /-capacitor$/.test(d)
    ).filter((d) => !NOT_PLUGINS.includes(d));

    expect(installed.sort()).toEqual(Object.keys(PLUGIN_CLASSES).sort());
  });

  testGenerated(g('the generated packageClassList covers every plugin dependency'), () => {
    expect([...generatedConfig().packageClassList].sort()).toEqual(
      Object.values(PLUGIN_CLASSES).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Identity, version handling and deployment target, against codemagic.yaml.
// ---------------------------------------------------------------------------
describe('bundle identity and versioning agree across every file that states them', () => {
  const BUNDLE_ID = 'com.flockcorp.flock';

  test('the bundle id is the same in the three tracked places it appears', () => {
    expect(capConfigTs).toContain(`appId: '${BUNDLE_ID}'`);
    expect(pbxproj).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`);
    expect(codemagic).toContain(`BUNDLE_ID: "${BUNDLE_ID}"`);
  });

  testGenerated(g('the generated ios copy carries the same bundle id'), () => {
    expect(generatedConfig().appId).toBe(BUNDLE_ID);
  });

  test('Info.plist takes version and build number from the build settings', () => {
    // Hardcoding either here is the classic way to ship a build number App
    // Store Connect has already seen; codemagic.yaml rewrites the pbxproj.
    expect(plistString(infoPlist, 'CFBundleShortVersionString')).toBe('$(MARKETING_VERSION)');
    expect(plistString(infoPlist, 'CFBundleVersion')).toBe('$(CURRENT_PROJECT_VERSION)');
    expect(pbxproj).toMatch(/MARKETING_VERSION = [\d.]+;/);
    expect(pbxproj).toMatch(/CURRENT_PROJECT_VERSION = \d+;/);
    expect(codemagic).toMatch(/CURRENT_PROJECT_VERSION = \$NEXT/);
  });

  testGenerated(g('the version in the generated config.xml is inert and does not pretend otherwise'), () => {
    // Cordova would use this attribute; Capacitor does not. It disagrees with
    // MARKETING_VERSION today, which is only safe while it is documented.
    const xml = generatedXml();
    expect(xml).toMatch(/version="1\.0\.0"/);
    expect(xml).toMatch(/NOT the app version/);
  });

  test('codemagic archives the project, scheme and entitlements that exist here', () => {
    expect(codemagic).toContain('XCODE_PROJECT: "ios/App/App.xcodeproj"');
    expect(codemagic).toContain('XCODE_SCHEME: "App"');
    expect(pbxproj).toContain('INFOPLIST_FILE = App/Info.plist;');
    expect(fs.existsSync(path.join(REPO, 'frontend', 'ios', 'App', 'App.xcodeproj'))).toBe(true);
  });

  test('the deployment target is one Capacitor 8 supports', () => {
    const targets = [...new Set((pbxproj.match(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g) || []))];
    expect(targets).toHaveLength(1); // one value across every configuration
    const version = Number(targets[0].match(/([\d.]+)/)[1]);
    expect(version).toBeGreaterThanOrEqual(14);
  });
});

// ---------------------------------------------------------------------------
// 8. Presentation claims the app has to be able to honour.
// ---------------------------------------------------------------------------
describe('the declared device and orientation support is real', () => {
  test('portrait only, because every screen is a single portrait column', () => {
    expect(plistArray(infoPlist, 'UISupportedInterfaceOrientations')).toEqual([
      'UIInterfaceOrientationPortrait',
    ]);
    // Declaring iPad would put the app in front of a reviewer on a device the
    // layout has never been built for.
    expect(pbxproj).toMatch(/TARGETED_DEVICE_FAMILY = 1;/);
    expect(pbxproj).not.toMatch(/TARGETED_DEVICE_FAMILY = "1,2";/);
  });

  test('export compliance is declared, so it is not asked on every upload', () => {
    expect(stripComments(infoPlist)).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });

  test('the export exemption is earned: nothing shipped performs its own crypto', () => {
    // ITSAppUsesNonExemptEncryption=false rests on one claim: the app's only
    // cryptography is standard TLS supplied by the OS (WKWebView for the web
    // layer, OS frameworks for the plugins). Two ways that claim silently
    // rots, both checked here so the failure lands on the commit that adds
    // the crypto instead of in an export review:
    //   1. a crypto library joins the runtime dependencies, or
    //   2. source starts calling WebCrypto or a cipher API directly.
    // If either fires legitimately, the fix is NOT to loosen this test: flip
    // the plist key, re-answer the export questions (France included), and
    // update APP-STORE-SUBMISSION.md in the same change.
    const CRYPTO_DEP =
      /crypto|cipher|sodium|forge|sjcl|nacl|jsencrypt|openpgp|aes-js|bcrypt|argon2/i;
    for (const dep of Object.keys(pkg.dependencies)) {
      expect(dep).not.toMatch(CRYPTO_DEP);
    }

    // Every shipped source file. Tests are excluded because they may spell
    // the very patterns they hunt (this file does).
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\.\w+$/.test(entry.name)) {
          files.push(p);
        }
      }
    };
    walk(path.join(REPO, 'frontend', 'src'));
    expect(files.length).toBeGreaterThan(30); // the walk found the real tree

    const CRYPTO_CALL =
      /crypto\.subtle|CryptoJS|createCipher|createDecipher|createSign\(|\bpbkdf2\b|\bscrypt\b/;
    for (const f of files) {
      // Object form so a failure names the file instead of printing "true".
      expect({ file: path.relative(REPO, f), callsCrypto: CRYPTO_CALL.test(fs.readFileSync(f, 'utf8')) })
        .toEqual({ file: path.relative(REPO, f), callsCrypto: false });
    }
  });

  test('both storyboards the plist names actually exist', () => {
    // A storyboard named here and missing from the bundle is a launch crash,
    // and the first thing a reviewer would see.
    const dir = path.join(REPO, 'frontend', 'ios', 'App', 'App', 'Base.lproj');
    for (const key of ['UILaunchStoryboardName', 'UIMainStoryboardFile']) {
      const name = plistString(infoPlist, key);
      expect(name).toBeTruthy();
      expect(fs.existsSync(path.join(dir, `${name}.storyboard`))).toBe(true);
    }
  });

  test('the shipped WebView is not inspectable', () => {
    // Capacitor turns on Web Inspector when the CAPACITOR_DEBUG info key reads
    // exactly the string "true" (CapacitorBridge.swift). The plist forwards a
    // build setting, and that setting is deliberately never defined, so it
    // expands to an empty string and the release build stays closed.
    expect(plistString(infoPlist, 'CAPACITOR_DEBUG')).toBe('$(CAPACITOR_DEBUG)');
    expect(pbxproj).not.toMatch(/CAPACITOR_DEBUG\s*=\s*(true|YES)/i);
  });
});

// ---------------------------------------------------------------------------
// 9. The pipeline has to fail where it used to fail silently.
//
// Every check below pins a guard added to codemagic.yaml on 2026-08-26, and
// each one exists because the failure it catches is invisible from a green
// build. A test on a CI file looks like belt and braces until somebody deletes
// a step to make a red build go away, which is exactly the moment the step was
// earning its keep.
// ---------------------------------------------------------------------------
describe('the build stops on the failures that used to ship green', () => {
  const signingCheck = () => {
    const step = codemagic.split(/^ {6}- name: /m).find((s) => /App\.entitlements/.test(s.split('\n')[0]));
    return step || '';
  };

  const plistStep = () => {
    const step = codemagic.split(/^ {6}- name: /m).find((s) => /GoogleService-Info\.plist/.test(s.split('\n')[0]));
    return step || '';
  };

  test('the archive is not the first thing that reads the fetched profile', () => {
    // Enabling a capability on the App ID invalidates every existing
    // provisioning profile. When the profile the build signs with predates the
    // capability, xcodebuild fails roughly twenty minutes in with "provisioning
    // profile does not match the entitlements file", inside a log that names an
    // entitlement and not the step that produced the profile. The check has to
    // sit between fetch-signing-files and build-ipa, in that order, or it is
    // reading a profile the archive will not use.
    const order = ['fetch-signing-files', 'App.entitlements', 'build-ipa'];
    let at = -1;
    for (const marker of order) {
      const next = codemagic.indexOf(marker, at + 1);
      expect({ marker, found: next > at }).toEqual({ marker, found: true });
      at = next;
    }
  });

  test('the entitlement list is read from App.entitlements, not typed into the yaml', () => {
    // A hardcoded list is a list that stops being true the next time this app
    // declares a capability, and it stops being true silently.
    const step = signingCheck();
    expect(step).toContain('ios/App/App/App.entitlements');
    expect(step).toMatch(/security cms -D/);
    expect(step).toMatch(/application-identifier/);
    expect(step).toMatch(/exit 1/);
    // The message a red build shows has to name the entitlement AND say what to
    // do, because the wrong fix (deleting the key) turns a build failure into a
    // Guideline 4.8 rejection.
    expect(step).toMatch(/SIGNING CHECK FAILED/);
    expect(step).toMatch(/DO NOT delete the entitlement/);
    // No key name appears in anything the shell EXECUTES: the check must not
    // know which entitlements exist. Comments and the failure message are
    // allowed to name them, because prose that explains a stop is not a list
    // the stop depends on.
    const executable = step
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && !/^\s*echo\b/.test(l))
      .join('\n');
    for (const key of plistKeys(entitlements)) {
      expect({ key, hardcodedInYaml: executable.includes(key) }).toEqual({ key, hardcodedInYaml: false });
    }
  });

  test('a build with no push configuration stops instead of shipping to TestFlight', () => {
    // The placeholder GoogleService-Info.plist archives, signs, installs and
    // runs. Push is dead on every device and the only signal was one WARNING
    // line in a green build's log. This workflow publishes to TestFlight
    // unconditionally, so "green" meant real testers on a build whose
    // notifications did nothing.
    expect(codemagic).toMatch(/submit_to_testflight:\s*true/);
    expect(codemagic).toContain('PUSH CHECK FAILED');
    expect(codemagic).toContain('ALLOW_PUSHLESS_BUILD');
    // The placeholder still exists, but only behind the explicit override.
    const placeholderAt = codemagic.indexOf('invalid-placeholder');
    const overrideAt = codemagic.indexOf('ALLOW_PUSHLESS_BUILD');
    expect(placeholderAt).toBeGreaterThan(overrideAt);
  });

  test('a decoded push plist is checked for the bundle id it belongs to', () => {
    // A plist for another Firebase iOS app decodes perfectly, lints perfectly,
    // and registers APNs tokens that are accepted and never delivered to.
    expect(codemagic).toMatch(/plutil -lint/);
    expect(codemagic).toMatch(/Print :BUNDLE_ID/);
    expect(codemagic).toMatch(/PLIST_BUNDLE" != "\$BUNDLE_ID/);
  });

  test('the push plist is checked for the Firebase PROJECT, not only the app', () => {
    // The bundle id says the plist belongs to an app called com.flockcorp.flock.
    // It does not say which Firebase project that app lives in, and one bundle
    // id can be registered in several: a staging project beside a production one
    // is the ordinary reason for two. A plist from the wrong project decodes,
    // lints and carries the right bundle id, so the check above passes it. The
    // device then registers its FCM token in that project, APNs accepts it, and
    // firebaseService.js sends from whichever project FIREBASE_SERVICE_ACCOUNT
    // belongs to. Nothing is delivered and nothing reports a failure, which is
    // the same shape as the wrong-app case the bundle check was written for.
    expect(codemagic).toMatch(/Print :PROJECT_ID/);
    expect(codemagic).toMatch(/PLIST_PROJECT" != "\$REACT_APP_FIREBASE_PROJECT_ID/);
    // Only when the web variable is actually set. The REACT_APP_FIREBASE_* six
    // are optional, and an absent one is not evidence of a mismatch.
    expect(codemagic).toMatch(/-z "\$\{REACT_APP_FIREBASE_PROJECT_ID:-\}"/);
  });

  test('a build where that comparison never ran does not print a line that says it did', () => {
    // The check above is conditional, and a conditional check has to say when it
    // did not run. Driven against the real script with the variable unset and a
    // staging plist installed, the step used to print the identical green line a
    // passing build prints: "verified for com.flockcorp.flock, Firebase project
    // 'flock-staging'. PUSH IS ON IN THIS BUILD." Nothing in it said whether
    // anything had agreed with that name. A skipped check that reads as a passed
    // one is the same invisible failure the whole step exists to end, moved into
    // the build log.
    //
    // Absent is still not a failure: the six web variables are optional and the
    // build has to be buildable without them. What changes is the sentence.
    const step = plistStep();
    expect(step).toMatch(/PROJECT_VERDICT=/);
    expect(step).toMatch(/WHICH NOTHING HERE CHECKED/);
    // Both branches feed the same line, so the closing message can never claim
    // more than the branch that produced it.
    expect(step).toMatch(/Firebase \$PROJECT_VERDICT\. PUSH IS ON IN THIS BUILD/);
    expect(step).not.toMatch(/Firebase project '\$PLIST_PROJECT'\. PUSH IS ON/);
  });

  test('the override that skips push cannot be tripped by a loose truthy value', () => {
    // Exact string, so TRUE, 1, yes and on all leave the stop armed. This is the
    // one variable in the group whose job is to let a broken build through.
    expect(codemagic).toMatch(/"\$\{ALLOW_PUSHLESS_BUILD:-\}" != "true"/);
  });

  test('every installed profile for this bundle id is checked, not the first one found', () => {
    // Saving a capability invalidates the profile that already existed, and
    // fetch-signing-files installs what App Store Connect holds, so the case
    // this whole step exists for is the case that leaves TWO on disk. The loop
    // used to `break` at the first match, which made the verdict depend on the
    // sort order of two UUID filenames while `xcode-project use-profiles` picks
    // by its own rule. Driven against the real script with a good profile
    // sorting ahead of a stale one, the check passed and the stale profile was
    // still installed.
    const step = signingCheck();
    expect(step).not.toMatch(/MATCH="\$p";\s*break/);
    // Every match is counted and every match is judged, and the failure names
    // how many of how many, because "delete the profile named above" is only
    // actionable when the stale one was actually printed.
    expect(step).toMatch(/FOUND=\$\(\(FOUND \+ 1\)\)/);
    expect(step).toMatch(/STALE=\$\(\(STALE \+ 1\)\)/);
    expect(step).toMatch(/\[ "\$STALE" -gt 0 \]/);
    expect(step).toMatch(/\[ "\$FOUND" -eq 0 \]/);
  });

  test('a profile is not called good because the list of entitlements to check was empty', () => {
    // The same defect as the one above, one level down. The per-profile loop
    // asks one question per entitlement in App.entitlements, so an EMPTY
    // entitlements file makes it ask nothing, and a loop that runs zero times
    // reports success. Driven against the real script with an empty
    // App.entitlements and a stale profile planted beside a good one: exit 0,
    // and "All 2 installed profiles for com.flockcorp.flock carry every
    // entitlement this app declares", which is technically true and worth
    // nothing.
    //
    // Reachable two ways, and the first is the one this step's own failure text
    // tells people not to do: emptying the file to make the check pass. The
    // second is the iOS project being regenerated over it.
    const step = signingCheck();
    expect(step).toMatch(/\[ -z "\$WANTED" \]/);
    // And it stops the build rather than warning, because a warning here is the
    // green build with dead push that this whole block of checks exists to end.
    const guardAt = step.indexOf('[ -z "$WANTED" ]');
    const loopAt = step.indexOf('for p in "$PROFILE_DIR"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(loopAt);
    expect(step.slice(guardAt, loopAt)).toMatch(/exit 1/);
  });
});

// ---------------------------------------------------------------------------
// 10. The build environment the iOS shell needs has to be written down.
//
// CRA inlines REACT_APP_* at build time, so a variable missing from the
// Codemagic `flock_web` group is not an error anywhere: the bundle compiles,
// the archive signs, the app runs, and one feature is simply absent. The only
// defence is that the list of variables is complete in the file codemagic.yaml
// points whoever fills that group at.
// ---------------------------------------------------------------------------
describe('every REACT_APP_ variable the shell reads is documented', () => {
  const envExample = read('frontend', '.env.example');

  const shippedSources = () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\.\w+$/.test(entry.name)) files.push(p);
      }
    };
    walk(path.join(REPO, 'frontend', 'src'));
    return files;
  };

  test('frontend/.env.example names every variable src actually reads', () => {
    // REACT_APP_GOOGLE_IOS_CLIENT_ID was read by useGoogleAuth.js and absent
    // from this file, while codemagic.yaml told the person filling the env
    // group to "add the REACT_APP_* lines listed in frontend/.env.example".
    // Following that instruction produced a green iOS build with no Google
    // sign-in button and no error anywhere.
    const used = new Set();
    for (const f of shippedSources()) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/process\.env\.(REACT_APP_[A-Z0-9_]+)/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(5); // the scan found the real tree

    const undocumented = [...used].filter((v) => !new RegExp(`^${v}=`, 'm').test(envExample)).sort();
    expect(undocumented).toEqual([]);
  });

  test('codemagic still points at that file rather than repeating the list', () => {
    expect(codemagic).toContain('frontend/.env.example');
  });
});
