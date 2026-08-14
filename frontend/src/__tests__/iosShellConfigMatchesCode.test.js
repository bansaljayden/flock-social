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
const iosConfigJson = read(...IOS_APP, 'capacitor.config.json');
const iosConfigXml = read(...IOS_APP, 'config.xml');
const capConfigTs = read('frontend', 'capacitor.config.ts');
const pbxproj = read('frontend', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const codemagic = read('codemagic.yaml');

const app = read('frontend', 'src', 'App.js');
const billing = read('backend', 'routes', 'billing.js');
const firebaseService = read('backend', 'services', 'firebaseService.js');
const appDelegate = read(...IOS_APP, 'AppDelegate.swift');
const pkg = JSON.parse(read('frontend', 'package.json'));

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
  test.each([
    ['Info.plist', infoPlist],
    ['App.entitlements', entitlements],
    ['config.xml', iosConfigXml],
  ])('%s parses as XML', (name, xml) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const error = doc.querySelector('parsererror');
    expect(error && error.textContent).toBeFalsy();
  });

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

  test('config.xml is balanced and capacitor.config.json is valid JSON', () => {
    expect(iosConfigXml).toMatch(/<widget[\s\S]*<\/widget>\s*$/);
    expect(() => JSON.parse(iosConfigJson)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 1. Purpose strings. The routed finding: these promised "stories".
// ---------------------------------------------------------------------------
describe('every NS*UsageDescription is one the app actually needs', () => {
  const usageKeys = () => plistKeys(infoPlist).filter((k) => /UsageDescription$/.test(k));

  test('the plist declares exactly the three permissions the client exercises', () => {
    // Adding a fourth is not forbidden, it just has to be justified by code and
    // added to this list in the same change.
    expect(usageKeys().sort()).toEqual([
      'NSCameraUsageDescription',
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

    // The four pickers the string describes: profile picture, flock chat, DM,
    // venue logo. If this count changes, re-read the string.
    expect(picks).toBe(4);
    for (const handler of [
      'handlePhotoUpload',
      'handleChatImageSelect',
      'handleDmImageSelect',
      'handleVenueLogoUpload',
    ]) {
      expect(app).toContain(handler);
    }
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
      // Both reach the profile picture and the venue logo, so both say so.
      expect(s).toMatch(/profile/i);
      expect(s).toMatch(/venue/i);
    }
    expect(camera).toMatch(/scan/i);
  });

  test('the camera string covers the file inputs too, not just getUserMedia', () => {
    // On iOS the "Take Photo" option in a file-input action sheet is offered by
    // the system, so the camera is reachable from every picker even though no
    // line of client code mentions it. A camera string that described only the
    // in-app viewfinder would under-describe the permission.
    const pickerHandlers = ['handlePhotoUpload', 'handleVenueLogoUpload'];
    for (const handler of pickerHandlers) expect(app).toContain(handler);
    // Neither picker pins itself to the library with capture=, so both can open
    // the camera.
    expect(app).not.toMatch(/accept="image\/\*"\s+capture=/);

    const camera = plistString(infoPlist, 'NSCameraUsageDescription');
    expect(camera).toMatch(/profile/i);
    expect(camera).toMatch(/venue/i);
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

  test('no contacts string: contact sync is the web Contacts Picker, not EventKit', () => {
    // navigator.contacts is a web API and never triggers the native prompt. The
    // client also knows it does not exist in WKWebView and says so.
    expect(app).toMatch(/navigator\.contacts\.select\(/);
    expect(Object.keys(pkg.dependencies)).not.toContain('@capacitor-community/contacts');
    expect(hasKey(infoPlist, 'NSContactsUsageDescription')).toBe(false);
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

  test('associated domains are not entitled, because they cannot be signed yet', () => {
    // The capability is not on the App ID and no apple-app-site-association is
    // served, so adding this key fails the archive rather than enabling
    // universal links. Tracked as a human step, not a code change.
    expect(hasKey(entitlements, 'com.apple.developer.associated-domains')).toBe(false);
    expect(hasKey(infoPlist, 'CFBundleURLTypes')).toBe(false);
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

  test('the Cordova whitelist in config.xml grants nothing', () => {
    // <access origin="*"/> is stock Capacitor template boilerplate and is not
    // an ATS exception. It only reads as one to somebody skimming the file.
    expect(iosConfigXml).toMatch(/<access origin="\*" \/>/);
    expect(iosConfigXml).toMatch(/Capacitor does not\s*\n?\s*implement the whitelist plugin/);
  });
});

// ---------------------------------------------------------------------------
// 6. The three Capacitor configs, which is the drift shape this repo produces.
// ---------------------------------------------------------------------------
describe('capacitor.config.ts and the copy under ios/ agree', () => {
  const json = JSON.parse(iosConfigJson);

  // The bundled copy wins at runtime, so a stale one would silently override
  // the source of truth. `npx cap sync ios` regenerates it in CI, which means
  // drift here is invisible until someone reads both files.
  test.each([
    ['appId', json.appId],
    ['appName', json.appName],
    ['webDir', json.webDir],
  ])('%s matches', (key, value) => {
    expect(value).toBeTruthy();
    expect(capConfigTs).toMatch(new RegExp(`${key}:\\s*'${esc(value)}'`));
  });

  test('the ios block matches', () => {
    expect(json.ios.scrollEnabled).toBe(false);
    expect(capConfigTs).toMatch(/scrollEnabled:\s*false/);

    expect(json.ios.backgroundColor).toBe('#0b1a2e');
    expect(capConfigTs).toMatch(/backgroundColor:\s*'#0b1a2e'/);
  });

  test('the experimental SwiftPM package options match', () => {
    const opts = json.experimental.ios.spm.packageOptions;
    expect(Object.keys(opts).sort()).toEqual(['@capacitor-firebase/app', '@capacitor-firebase/messaging']);
    for (const name of Object.keys(opts)) {
      expect(opts[name].symlink).toBe(true);
      expect(capConfigTs).toContain(`'${name}'`);
    }
  });

  test('the generated packageClassList covers every Capacitor plugin dependency', () => {
    // Each native plugin package contributes exactly one plugin class. A
    // missing entry means the plugin is not registered and its JS calls reject
    // at runtime; an extra entry fails the SwiftPM build.
    const PLUGIN_CLASSES = {
      '@capacitor-community/apple-sign-in': 'SignInWithApple',
      '@capacitor-firebase/app': 'FirebaseAppPlugin',
      '@capacitor-firebase/messaging': 'FirebaseMessagingPlugin',
      '@capacitor/app': 'AppPlugin',
      '@revenuecat/purchases-capacitor': 'PurchasesPlugin',
    };
    // Everything in package.json that is a Capacitor plugin, less the three
    // packages that are the runtime itself rather than plugins.
    const NOT_PLUGINS = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios'];
    const installed = Object.keys(pkg.dependencies).filter(
      (d) => /^@capacitor(-community|-firebase)?\//.test(d) || /-capacitor$/.test(d)
    ).filter((d) => !NOT_PLUGINS.includes(d));

    expect(installed.sort()).toEqual(Object.keys(PLUGIN_CLASSES).sort());
    expect([...json.packageClassList].sort()).toEqual(
      Object.values(PLUGIN_CLASSES).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Identity, version handling and deployment target, against codemagic.yaml.
// ---------------------------------------------------------------------------
describe('bundle identity and versioning agree across every file that states them', () => {
  const BUNDLE_ID = 'com.flockcorp.flock';

  test('the bundle id is the same in all four places it appears', () => {
    expect(JSON.parse(iosConfigJson).appId).toBe(BUNDLE_ID);
    expect(capConfigTs).toContain(`appId: '${BUNDLE_ID}'`);
    expect(pbxproj).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`);
    expect(codemagic).toContain(`BUNDLE_ID: "${BUNDLE_ID}"`);
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

  test('the version in config.xml is inert and does not pretend otherwise', () => {
    // Cordova would use this attribute; Capacitor does not. It disagrees with
    // MARKETING_VERSION today, which is only safe while it is documented.
    expect(iosConfigXml).toMatch(/version="1\.0\.0"/);
    expect(iosConfigXml).toMatch(/NOT the app version/);
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
