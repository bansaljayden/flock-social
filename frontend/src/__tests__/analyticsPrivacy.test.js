// ---------------------------------------------------------------------------
// Analytics privacy: the youngest permitted user is 13, so the PostHog config
// is minimize-by-default and every value is locked here. If one of these
// fails, the commit being tested WIDENED collection on minors: that needs a
// deliberate decision and a privacy policy re-read, not a test edit.
//
// Three layers:
//   1. The exported config object holds the pinned values, and every option
//      name really exists in the installed SDK (a typo'd option is silently
//      ignored by posthog-js, which would fail open).
//   2. before_send provably strips URL-borne bearer tokens (guest invite
//      /i/<token>, password reset ?token= and #token=) and asks ingestion to
//      skip GeoIP, against the real event shapes.
//   3. The real posthog-js, initialized with the shipped config, writes no
//      cookie and starts no session recording.
// Plus a sweep: every capture call site in src/ goes through api.js, and no
// call site sends a property that could carry PII.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

// index.js boots the whole page router at import time. The render is not
// under test here, so react-dom is stubbed BEFORE the import runs.
jest.mock('react-dom/client', () => ({
  createRoot: () => ({ render: () => {} }),
}));

const SRC = path.resolve(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

let scrubUrlTokens;
let POSTHOG_PRIVACY_CONFIG;
let isLocalAnalyticsOrigin;

beforeAll(() => {
  // Neither analytics SDK may lazy-load during the module boot below.
  delete process.env.REACT_APP_POSTHOG_KEY;
  delete process.env.REACT_APP_SENTRY_DSN;
  ({ scrubUrlTokens, POSTHOG_PRIVACY_CONFIG, isLocalAnalyticsOrigin } = require('../index'));
});

describe('scrubUrlTokens', () => {
  test('guest invite path tokens are replaced', () => {
    expect(scrubUrlTokens('https://flockcorp.com/i/aB3_x-9Zq')).toBe('https://flockcorp.com/i/:token');
    expect(scrubUrlTokens('/i/abc123 then /i/def456')).toBe('/i/:token then /i/:token');
  });

  test('password reset tokens are scrubbed from fragment, query, and later params', () => {
    const tok = 'a'.repeat(32) + '.QmFzZTY0dXJsVmVyaWZpZXJfLTAxMjM';
    expect(scrubUrlTokens(`https://flockcorp.com/reset-password#token=${tok}`))
      .toBe('https://flockcorp.com/reset-password#token=redacted');
    expect(scrubUrlTokens(`https://flockcorp.com/reset-password?token=${tok}`))
      .toBe('https://flockcorp.com/reset-password?token=redacted');
    expect(scrubUrlTokens(`https://flockcorp.com/reset-password?utm_source=mail&token=${tok}&x=1`))
      .toBe('https://flockcorp.com/reset-password?utm_source=mail&token=redacted&x=1');
    expect(scrubUrlTokens('/reset-password#TOKEN=AbC')).toBe('/reset-password#TOKEN=redacted');
  });

  test('innocent strings and non-strings pass through unchanged', () => {
    expect(scrubUrlTokens('https://flockcorp.com/privacy?tab=1')).toBe('https://flockcorp.com/privacy?tab=1');
    expect(scrubUrlTokens('/invite and ?tokens=2 stay')).toBe('/invite and ?tokens=2 stay');
    expect(scrubUrlTokens(42)).toBe(42);
    expect(scrubUrlTokens(null)).toBe(null);
    expect(scrubUrlTokens(undefined)).toBe(undefined);
  });
});

describe('POSTHOG_PRIVACY_CONFIG is pinned to minimum collection', () => {
  test('the locked values', () => {
    const c = POSTHOG_PRIVACY_CONFIG;
    expect(c.autocapture).toBe(false);
    expect(c.disable_session_recording).toBe(true);
    expect(c.capture_heatmaps).toBe(false);
    expect(c.capture_dead_clicks).toBe(false);
    expect(c.capture_exceptions).toBe(false);
    expect(c.disable_surveys).toBe(true);
    expect(c.person_profiles).toBe('identified_only');
    expect(c.persistence).toBe('localStorage'); // no cookie mode: see PrivacyPolicy.js
    expect(c.respect_dnt).toBe(true);
    expect(c.mask_personal_data_properties).toBe(true);
    expect(c.custom_personal_data_properties).toContain('token');
    expect(typeof c.before_send).toBe('function');
  });

  test('every option name exists in the installed SDK, so none can be a silently ignored typo', () => {
    // Ask Node where the package is rather than hand-building a path into
    // node_modules. The hardcoded '../node_modules/@posthog/types/dist/...'
    // this replaces assumed one hoisting outcome: it is correct here and throws
    // a bare ENOENT wherever npm hoists the package to the repo root instead,
    // under pnpm or Yarn PnP, or after any release that moves dist/. That is a
    // test that fails on the machine rather than on the code, and its message
    // names a file path instead of the problem.
    //
    // The walk up from the resolved entry point is what survives a dist/ move.
    // A miss throws with what to do about it, and is deliberately NOT a skip:
    // skipping would mean these option names stop being checked against the SDK
    // at all, which is the one thing this test is for.
    const typesFile = (() => {
      let dir = path.dirname(require.resolve('@posthog/types'));
      for (let i = 0; i < 4; i += 1) {
        const candidate = path.join(dir, 'posthog-config.d.ts');
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
      }
      throw new Error(
        'posthog-config.d.ts is not next to the resolved @posthog/types entry point. '
        + 'The package moved its declaration files. Find the new location and update '
        + 'this lookup; do not delete the test, or a mistyped privacy option becomes '
        + 'silently ignored again.'
      );
    })();
    const types = fs.readFileSync(typesFile, 'utf8');
    for (const key of Object.keys(POSTHOG_PRIVACY_CONFIG)) {
      expect({ key, declared: new RegExp(`^\\s*${key}\\??:`, 'm').test(types) })
        .toEqual({ key, declared: true });
    }
  });

  test('init is handed exactly this object, not a drifted copy', () => {
    const index = readSrc('index.js');
    expect(index).toMatch(/posthog\.init\(process\.env\.REACT_APP_POSTHOG_KEY,\s*POSTHOG_PRIVACY_CONFIG\)/);
    // One init in the codebase; api.js only reaches for the singleton.
    expect(index.match(/posthog\.init\(/g)).toHaveLength(1);
  });
});

describe('before_send', () => {
  const send = (event) => POSTHOG_PRIVACY_CONFIG.before_send(event);

  test('scrubs tokens from every string property, including ones added by future SDK versions', () => {
    const event = {
      event: '$pageview',
      properties: {
        $current_url: 'https://flockcorp.com/i/secretguest',
        $pathname: '/i/secretguest',
        $referrer: 'https://flockcorp.com/reset-password?token=abc.def',
        $session_entry_url: 'https://flockcorp.com/reset-password#token=abc.def',
        $set_once: { $initial_current_url: 'https://flockcorp.com/i/firsttouch' },
        list: ['https://flockcorp.com/i/inarray'],
        count: 3,
      },
      $set: { last_url: 'https://flockcorp.com/i/insetblock' },
      $set_once: { first_url: 'https://flockcorp.com/reset-password?token=xyz' },
    };
    const out = send(event);
    expect(out.properties.$current_url).toBe('https://flockcorp.com/i/:token');
    expect(out.properties.$pathname).toBe('/i/:token');
    expect(out.properties.$referrer).toBe('https://flockcorp.com/reset-password?token=redacted');
    expect(out.properties.$session_entry_url).toBe('https://flockcorp.com/reset-password#token=redacted');
    expect(out.properties.$set_once.$initial_current_url).toBe('https://flockcorp.com/i/:token');
    expect(out.properties.list[0]).toBe('https://flockcorp.com/i/:token');
    expect(out.properties.count).toBe(3);
    expect(out.$set.last_url).toBe('https://flockcorp.com/i/:token');
    expect(out.$set_once.first_url).toBe('https://flockcorp.com/reset-password?token=redacted');
    expect(JSON.stringify(out)).not.toMatch(/secretguest|firsttouch|inarray|insetblock|abc\.def|token=xyz/);
  });

  test('asks ingestion to skip GeoIP so no location is derived from the IP', () => {
    const out = send({ event: 'signup', properties: { method: 'email' } });
    expect(out.properties.$geoip_disable).toBe(true);
  });

  test('never drops or breaks an event it was not built for', () => {
    expect(send(null)).toBe(null);
    expect(send({ event: 'bare' })).toEqual({ event: 'bare' });
    const cyclic = { event: 'deep', properties: {} };
    cyclic.properties.self = cyclic.properties; // depth cap must hold
    expect(() => send(cyclic)).not.toThrow();
  });
});

describe('the real SDK honors the shipped config', () => {
  test('init writes no cookie, keeps state in localStorage, and starts no recording', () => {
    const posthog = require('posthog-js').default;
    const instance = posthog.init(
      'phc_analytics_privacy_test',
      {
        ...POSTHOG_PRIVACY_CONFIG,
        // Test-only network hygiene. None of these touch the behaviors under
        // assertion (persistence, recording); the appended before_send drops
        // every event after the shipped one has run.
        advanced_disable_flags: true,
        disable_external_dependency_loading: true,
        disable_compression: true,
        before_send: [POSTHOG_PRIVACY_CONFIG.before_send, () => null],
      },
      'analytics_privacy_test'
    );
    expect(instance).toBeTruthy();

    // 'localStorage' must be a value THIS SDK version accepts: an invalid
    // string would fall back to cookie-backed persistence and this cookie
    // assertion is what catches that.
    expect(instance.config.persistence).toBe('localStorage');
    expect(document.cookie).not.toMatch(/ph_/);
    const phKeys = Object.keys(window.localStorage).filter((k) => k.startsWith('ph_'));
    expect(phKeys.length).toBeGreaterThan(0);

    expect(instance.config.disable_session_recording).toBe(true);
    expect(instance.sessionRecordingStarted()).toBe(false);
  });
});

describe('capture-site sweep: what leaves the device is a short, named list', () => {
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.jsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  test('posthog.capture and posthog.identify appear only in services/api.js', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (file.includes('__tests__')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/posthog\.(capture|identify)\(/.test(text)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([path.join('services', 'api.js')]);
  });

  test('identify sends the numeric account id and nothing else', () => {
    const api = readSrc('services', 'api.js');
    expect(api).toMatch(/posthog\.identify\(String\(user\.id\)\)/);
    // No person-properties argument: name and email stay out of PostHog.
    expect(api).not.toMatch(/posthog\.identify\([^)]*,\s*\{/);
  });

  // Every capture goes through track(event, props) with a LITERAL props object,
  // which is not a style preference: it is what makes the sweep below able to
  // read the keys at all. track(event, someVariable) would not match this
  // pattern and would leave the file silently.
  const trackCalls = () => {
    const api = readSrc('services', 'api.js');
    return [...api.matchAll(/\btrack\(\s*'([^']+)'\s*(?:,\s*\{([^}]*)\})?\s*\)/g)];
  };

  // Reads a key off each comma-separated segment whether it is written
  // `key: value` or as an ES6 shorthand `key`. The earlier version required
  // the colon, so a shorthand property was not checked by anything. A value
  // containing a top-level comma can contribute a spurious name here, which
  // makes the check stricter rather than weaker.
  const propKeys = (props) => (props
    ? props.split(',').map((seg) => (seg.match(/^\s*([A-Za-z_$][\w$]*)/) || [])[1]).filter(Boolean)
    : []);

  test('no tracked property key could carry message text, coordinates, or DOB', () => {
    const calls = trackCalls();
    expect(calls.length).toBeGreaterThan(0);
    const banned = /message|text|content|body|\blat\b|\blng\b|\blon\b|coord|location|geo|dob|birth|age|email|phone|name|address|token|password|secret|\bip\b/i;
    for (const [, eventName, props] of calls) {
      for (const key of propKeys(props)) {
        expect({ eventName, key, banned: banned.test(key) })
          .toEqual({ eventName, key, banned: false });
      }
    }
  });

  // The vocabulary is pinned, not merely reviewed. A capture that appears
  // without landing in this list is a widening of what leaves a 13-year-old's
  // phone, and it should cost a deliberate edit here rather than sliding in
  // with the feature that wanted it. Removing a name is fine; adding one is
  // the decision.
  test('the event vocabulary is exactly this list', () => {
    const names = [...new Set(trackCalls().map(([, name]) => name))].sort();
    expect(names).toEqual([
      'app_opened',          // did anyone come back, and on which shell
      'attendance_marked',   // did the people who said yes turn up
      'auth_screen_viewed',  // arrival at the sign-up / sign-in form, the pre-auth denominator
      'birdie_message',      // is the assistant used, and how deep
      'budget_submitted',    // is budget matching used or skipped
      'crowd_feedback',      // is the crowd report submitted
      'dm_sent',
      'email_verified',      // the verification wall: coming down, or the link failing
      'flock_created',
      'flock_message_sent',
      'flock_rerun',
      'flock_rsvp',          // does an invited person ever answer
      'flock_status_set',    // does a plan reach confirmed, or die in planning
      'invite_handoff_started', // did the guest who answered go make an account
      'invite_link_created',
      'invite_link_joined',
      'invite_link_opened',  // was the link the product spreads through opened
      'invite_sent',         // people added to a plan that already existed
      'login',
      'login_failed',        // locked out, or uninterested
      'nfc_tap',
      'nfc_tap_action',
      'push_opened',         // did a notification tap open the app, and to what
      'roost_question_asked',      // is the B2B advisor used, and does it answer
      'screen_viewed',       // the denominator: who ARRIVED where a step happens
      'signup',
      'signup_failed',       // the drop between the form and the account
      'venue_profile_created',     // does an owner who starts onboarding finish
      'venue_verification_requested',
      'venue_vote_cast',     // does the mechanic the product is named for run
    ]);
  });

  // The age gate is the one refusal that must produce no event. See the long
  // note above signup() in services/api.js: PostHog merges a device's
  // anonymous history into whoever eventually signs up on it, so an "underage"
  // marker would attach permanently to a real minor's profile.
  test('a 403 auth refusal is not recorded, and neither is a needsDob re-prompt', () => {
    const api = readSrc('services', 'api.js');
    expect(api).toMatch(/function authFailureIsRecordable\(err\) \{[\s\S]*?err\.status !== 403/);
    expect(api).toMatch(/function authFailureIsRecordable\(err\) \{[\s\S]*?needsDob\) return false;/);
    // Every auth failure capture is gated on it, none of them fires bare.
    const gated = [...api.matchAll(/track\('(signup_failed|login_failed)'/g)];
    expect(gated.length).toBe(5);
    for (const m of gated) {
      const line = api.slice(api.lastIndexOf('\n', m.index), m.index);
      expect({ event: m[1], gated: /authFailureIsRecordable\(err\)\)\s*$/.test(line) })
        .toEqual({ event: m[1], gated: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A dev server is not a user. frontend/.env carries a live key, so every
// `npm start` reported into the production project: 1,526 of 1,794 pageviews
// came from a localhost origin and 244 from www.flockcorp.com.
//
// The two cases that matter most here are the ones that LOOK local and are
// not. iOS serves from capacitor://localhost and Android from
// https://localhost, and losing either would be a worse bug than the one this
// closes, because the native app is the launch surface.
// ---------------------------------------------------------------------------
describe('isLocalAnalyticsOrigin', () => {
  const at = (protocol, hostname, bridge = false) =>
    isLocalAnalyticsOrigin({ protocol, hostname }, bridge);

  test('a browser dev server is local, on every port and every loopback spelling', () => {
    expect(at('http:', 'localhost')).toBe(true);
    expect(at('http:', '127.0.0.1')).toBe(true);
    expect(at('http:', '0.0.0.0')).toBe(true);
    expect(at('http:', '[::1]')).toBe(true);
    expect(at('https:', 'localhost')).toBe(true); // serve -s build over TLS
    expect(at('http:', 'Jaydens-MacBook.local')).toBe(true);
  });

  test('production and the native shells are not', () => {
    expect(at('https:', 'www.flockcorp.com')).toBe(false);
    expect(at('https:', 'flock-app-w65m.vercel.app')).toBe(false);
    // iOS: capacitor://localhost. The protocol is the whole signal.
    expect(at('capacitor:', 'localhost')).toBe(false);
    // Android: https://localhost, identical to a dev server but for the bridge.
    expect(at('https:', 'localhost', true)).toBe(false);
    expect(at('http:', 'localhost', true)).toBe(false);
  });

  test('a hostname that merely contains localhost is production', () => {
    expect(at('https:', 'localhost.flockcorp.com')).toBe(false);
    expect(at('https:', 'notlocalhost')).toBe(false);
  });

  test('a missing or hostile location never throws and never blocks reporting', () => {
    expect(isLocalAnalyticsOrigin(null, false)).toBe(false);
    expect(isLocalAnalyticsOrigin({}, false)).toBe(false);
    expect(isLocalAnalyticsOrigin({ protocol: 'http:', get hostname() { throw new Error('x'); } }, false)).toBe(false);
  });

  test('init is gated on it, and the local build can still opt back in', () => {
    const index = readSrc('index.js');
    expect(index).toMatch(/const analyticsEnabled = [\s\S]*?isLocalAnalyticsOrigin\(window\.location, !!window\.Capacitor\)/);
    expect(index).toMatch(/REACT_APP_POSTHOG_ALLOW_LOCAL === 'true'/);
    expect(index).toMatch(/if \(analyticsEnabled\) \{\s*\n\s*import\('posthog-js'\)/);
  });
});

// ---------------------------------------------------------------------------
// THE CHAT EVENTS MUST STAY ON THE TRANSPORT THAT CARRIES THE MESSAGES.
//
// api.js's sendMessage and sendDM are the HTTP FALLBACK. App.js emits over the
// websocket first and only reaches them in the `else` of that emit's own
// return value, so a capture that lives only inside those two functions counts
// socket outages and calls the result message volume. That is what shipped,
// and it is invisible from api.js alone: the file looks fully instrumented.
//
// analyticsEvents.test.js proves the two trackers behave. This proves App.js
// still CALLS them, on the branch that matters, which is the half that a
// refactor of the send path would quietly drop.
//
// Comments are stripped first. This repository has had five separate source
// scans pass on the paragraph explaining the code instead of the code, one of
// them written the same minute as the code it was guarding.
// ---------------------------------------------------------------------------
describe('App.js reports a message on the socket path, not only on the fallback', () => {
  const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  let app;
  beforeAll(() => {
    app = codeOnly(readSrc('App.js'));
  });

  test('the scan is reading the real send paths, so its silence would mean something', () => {
    // Trap 4: an empty result is indistinguishable from a broken scanner. If
    // these anchors ever stop matching, the assertions below would pass on
    // nothing, so the anchors are asserted before anything is concluded from
    // them. Both are the exact branch that decides the transport.
    expect(app.match(/if \(sentOverSocket\) \{/g)).toHaveLength(1);
    expect(app.match(/if \(dmSentOverSocket\) \{/g)).toHaveLength(1);
    // And the comment stripper did not eat the file.
    expect(app.length).toBeGreaterThan(400000);
  });

  test('each socket branch opens with its tracker, exactly once', () => {
    // Adjacency rather than a slice: a slice between two anchors hands back the
    // rest of the file the day one anchor moves, and every assertion then
    // passes on text from somewhere else entirely.
    expect(app).toMatch(/if \(sentOverSocket\) \{\s*trackFlockMessageSent\(/);
    expect(app).toMatch(/if \(dmSentOverSocket\) \{\s*trackDmSent\(/);

    // Once each. Two calls on one send is a double count, which is worse than
    // the undercount this replaced, because it looks plausible.
    expect(app.match(/trackFlockMessageSent\(/g)).toHaveLength(1);
    expect(app.match(/trackDmSent\(/g)).toHaveLength(1);
  });

  test('the guest page reports its own funnel through api.js and never the SDK', () => {
    const guest = codeOnly(readSrc('website', 'GuestInvite.js'));
    // The page must not import the REST client at module scope: it is the most
    // expensive blank screen in the product and api.js may not sit in the queue
    // ahead of the plan a stranger is waiting for.
    expect(guest).not.toMatch(/^import .*services\/api/m);
    expect(guest).toMatch(/import\('\.\.\/services\/api'\)/);
    for (const call of ['trackGuestRsvp', 'trackGuestVenueVote', 'trackInviteHandoffStarted']) {
      expect({ call, called: guest.includes(`api.${call}(`) }).toEqual({ call, called: true });
    }
  });
});
