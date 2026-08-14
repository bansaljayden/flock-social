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

beforeAll(() => {
  // Neither analytics SDK may lazy-load during the module boot below.
  delete process.env.REACT_APP_POSTHOG_KEY;
  delete process.env.REACT_APP_SENTRY_DSN;
  ({ scrubUrlTokens, POSTHOG_PRIVACY_CONFIG } = require('../index'));
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
    const typesFile = path.resolve(
      SRC, '..', 'node_modules', '@posthog', 'types', 'dist', 'posthog-config.d.ts'
    );
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

  test('no tracked property key could carry message text, coordinates, or DOB', () => {
    const api = readSrc('services', 'api.js');
    // Every capture goes through track(event, props); pull each literal props
    // object and check its keys against the names PII arrives under.
    const calls = [...api.matchAll(/\btrack\(\s*'([^']+)'\s*(?:,\s*\{([^}]*)\})?\s*\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    const banned = /message|text|content|body|\blat\b|\blng\b|\blon\b|coord|location|geo|dob|birth|age|email|phone|name|address|token|password|secret|\bip\b/i;
    for (const [, eventName, props] of calls) {
      const keys = props
        ? [...props.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1])
        : [];
      for (const key of keys) {
        expect({ eventName, key, banned: banned.test(key) })
          .toEqual({ eventName, key, banned: false });
      }
    }
  });
});
