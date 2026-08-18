/**
 * The app origin's Content-Security-Policy, and the hosts it has to keep letting
 * through.
 *
 * WHY THIS FILE EXISTS
 *
 * `frontend/vercel.json` used to send exactly one CSP directive for
 * www.flockcorp.com: `frame-ancestors 'self'`. No `script-src`, no
 * `object-src`, no `base-uri`. Meanwhile the API origin got a full helmet
 * policy. So the origin with no HTML sinks was hardened and the origin that
 * hosts the entire React tree, the session token, the chat history and every
 * `innerHTML` / `setHTML` sink in the app had no script policy at all. That is
 * M-1 in SECURITY-AUDIT-upload-xss.md: it creates no injection by itself, it
 * removes the containment for every injection the escaping in App.js is
 * currently holding shut.
 *
 * The policy shipped now is ENFORCING, not Report-Only, and `script-src` has
 * neither `'unsafe-inline'` nor `'unsafe-eval'`. That is only possible because
 * CRA 5 does not inline a runtime chunk: the built `index.html` carries one
 * `<script src="/static/js/main.*.js">` and one `application/ld+json` data
 * block, and a data block is never executed so CSP never checks it. If a
 * future change puts a real inline `<script>` in `public/index.html` or in
 * either serverless function, the page breaks in production and not here, so
 * both are asserted below.
 *
 * THE HOST LIST IS DERIVED FROM THE SOURCE, NOT TYPED OUT TWICE.
 * A CSP is a second copy of "what does this app talk to", and second copies
 * rot. Every host asserted below is read back out of the file that actually
 * requests it (api.js, index.js, App.js, firebase-messaging-sw.js), so adding
 * a new tile host or analytics host without adding it to the policy fails
 * here instead of failing as a blank map in production.
 *
 * THE ONE THAT IS NOT OBVIOUS: https://www.gstatic.com in script-src.
 * `public/firebase-messaging-sw.js` calls `importScripts()` on two
 * gstatic-hosted Firebase bundles. A service worker is governed by the CSP on
 * ITS OWN response, and that response is served by the `/(.*)` rule below, so
 * dropping gstatic from `script-src` does not merely lose a script tag on a
 * page: the worker fails to evaluate, `serviceWorker.register()` rejects, and
 * web push silently stops registering anyone. Verified in a real browser
 * against the built bundle: with gstatic present the worker activates, with it
 * removed registration throws "ServiceWorker script evaluation failed".
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(FRONTEND, ...p), 'utf8');

const VERCEL = JSON.parse(read('vercel.json'));
const GLOBAL_RULE = VERCEL.headers.find((h) => h.source === '/(.*)');
const HEADERS = GLOBAL_RULE.headers;
const CSP = (HEADERS.find((h) => h.key === 'Content-Security-Policy') || {}).value || '';

// "script-src 'self' https://x" -> ["'self'", "https://x"]
const directive = (name) => {
  const found = CSP.split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(name + ' '));
  return found ? found.split(/\s+/).slice(1) : null;
};

// CSP host matching, enough of it for the sources this app uses: exact host,
// or a leading `*.` wildcard that covers one or more leading labels.
const allows = (sources, url) => {
  const { protocol, host } = new URL(url);
  return (sources || []).some((src) => {
    if (!src.includes('://')) return false;
    const s = new URL(src.replace('wss://', 'https://').replace('*.', 'wildcard.'));
    if (s.protocol !== protocol.replace('wss:', 'https:')) return false;
    if (!src.includes('*.')) return s.host === host;
    const suffix = src.split('*.')[1];
    return host === suffix || host.endsWith('.' + suffix);
  });
};

describe('app origin CSP (vercel.json)', () => {
  it('sends an enforcing Content-Security-Policy on every path', () => {
    expect(GLOBAL_RULE).toBeTruthy();
    expect(CSP).not.toBe('');
    // Report-Only would log violations and block nothing. If this policy ever
    // has to be relaxed to Report-Only to unbreak a release, that is a
    // deliberate act and this assertion is where it gets argued.
    expect(HEADERS.some((h) => h.key === 'Content-Security-Policy-Report-Only')).toBe(false);
  });

  it('has a script-src, and it allows neither inline script nor eval', () => {
    const script = directive('script-src');
    expect(script).toBeTruthy();
    expect(script).toContain("'self'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('keeps the directives that were already there and the ones that close the classic escapes', () => {
    // frame-ancestors was the whole policy before. Losing it while adding the
    // rest would be a straight downgrade for clickjacking.
    expect(directive('frame-ancestors')).toEqual(["'self'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'none'"]);
    expect(directive('form-action')).toEqual(["'self'"]);
    expect(directive('default-src')).toContain("'self'");
  });

  it("allows inline style, because React and the two serverless pages need it", () => {
    // Not a concession worth fighting: App.js styles nearly everything with
    // style objects, index.css ships :root custom properties, and both
    // api/*.js pages inline a <style> block. 'unsafe-inline' on style-src does
    // not give an attacker script execution; on script-src it would.
    expect(directive('style-src')).toContain("'unsafe-inline'");
  });

  it('lets MapLibre build its worker from a blob', () => {
    // maplibre-gl creates its worker from a blob: URL. Without this the map
    // never draws and the failure is a blank rectangle, not an error anyone
    // reads.
    expect(directive('worker-src')).toContain('blob:');
    expect(directive('img-src')).toContain('blob:');
    expect(directive('img-src')).toContain('data:');
  });
});

describe('CSP covers the hosts the code actually talks to', () => {
  const API = read('src', 'services', 'api.js');
  const INDEX = read('src', 'index.js');
  const APP = read('src', 'App.js');
  const SW = read('public', 'firebase-messaging-sw.js');

  const firstUrl = (src, re) => {
    const m = src.match(re);
    return m && m[0];
  };

  it('connect-src covers the API origin, over https and over the socket', () => {
    // The default in api.js is what ships whenever REACT_APP_API_URL is unset,
    // and it is the value the deployed build uses today. socket.js reuses
    // BASE_URL, so the wss:// form of the same host has to be allowed too.
    const base = firstUrl(API, /https:\/\/flock-app-production\.up\.railway\.app/);
    expect(base).toBeTruthy();
    const connect = directive('connect-src');
    expect(allows(connect, base)).toBe(true);
    expect(allows(connect, base.replace('https://', 'wss://'))).toBe(true);
    // Venue photos and uploaded avatars are served from the same origin.
    expect(allows(directive('img-src'), base)).toBe(true);
  });

  it('covers PostHog on both of its hosts', () => {
    // posthog-js does not only POST events to api_host. It loads
    // /array/<token>/config.js and /static/*.js as SCRIPT TAGS from the assets
    // host (us.i.posthog.com -> us-assets.i.posthog.com), which is a
    // script-src decision, not a connect-src one. Confirmed in the browser:
    // both requests fire on first paint of the landing page.
    const apiHost = firstUrl(INDEX, /https:\/\/us\.i\.posthog\.com/);
    expect(apiHost).toBeTruthy();
    expect(allows(directive('connect-src'), apiHost)).toBe(true);
    expect(allows(directive('script-src'), 'https://us-assets.i.posthog.com')).toBe(true);
    expect(allows(directive('connect-src'), 'https://us-assets.i.posthog.com')).toBe(true);
  });

  it('covers every map host App.js and LiveDemo.js name', () => {
    const DEMO = read('src', 'website', 'LiveDemo.js');
    const hosts = new Set();
    for (const src of [APP, DEMO]) {
      for (const m of src.match(/https:\/\/[a-z0-9.-]+\.(?:com|net|org)/g) || []) {
        if (/maptiler|cartocdn|arcgisonline/.test(m)) hosts.add(m);
      }
    }
    // If this is empty the regex above stopped matching and the rest of the
    // assertion would pass vacuously.
    expect(hosts.size).toBeGreaterThanOrEqual(3);
    for (const host of hosts) {
      // Style JSON, tile JSON, vector tiles and glyph PBFs are all fetches.
      expect([host, allows(directive('connect-src'), host)]).toEqual([host, true]);
      // Sprites and raster tiles are images.
      expect([host, allows(directive('img-src'), host)]).toEqual([host, true]);
    }
  });

  it('covers the avatar host App.js builds URLs against', () => {
    const dicebear = firstUrl(APP, /https:\/\/api\.dicebear\.com/);
    expect(dicebear).toBeTruthy();
    expect(allows(directive('img-src'), dicebear)).toBe(true);
  });

  it('covers Google sign-in and the gstatic bundles the push worker imports', () => {
    // @react-oauth/google injects https://accounts.google.com/gsi/client.
    expect(read('package.json')).toContain('@react-oauth/google');
    expect(allows(directive('script-src'), 'https://accounts.google.com')).toBe(true);
    expect(allows(directive('frame-src'), 'https://accounts.google.com')).toBe(true);

    // The service worker's importScripts hosts. See the header of this file:
    // this one is load-bearing for web push, not for a page script.
    const imported = SW.match(/importScripts\('(https:\/\/[^']+)'\)/g) || [];
    expect(imported.length).toBeGreaterThan(0);
    for (const line of imported) {
      const url = line.match(/'(https:\/\/[^']+)'/)[1];
      expect([url, allows(directive('script-src'), url)]).toEqual([url, true]);
    }

    // Firebase installations / FCM registration, and Google's token endpoints.
    expect(allows(directive('connect-src'), 'https://fcmregistrations.googleapis.com')).toBe(true);
    expect(allows(directive('connect-src'), 'https://firebaseinstallations.googleapis.com')).toBe(true);
  });

  it('covers Sentry, which is dark today and would otherwise fail on the day a DSN is set', () => {
    expect(INDEX).toContain('REACT_APP_SENTRY_DSN');
    expect(allows(directive('connect-src'), 'https://o1.ingest.us.sentry.io')).toBe(true);
  });
});

describe('nothing in the shipped HTML needs an inline script', () => {
  // script-src has no 'unsafe-inline', so an executable inline <script>
  // anywhere in a served document is a blank page in production. JSON-LD is
  // fine: a script element with a non-JavaScript type is a data block, is
  // never executed, and is never checked against script-src.
  const executableInline = (html) =>
    (html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).filter(
      (tag) => !/type\s*=\s*["'][^"']*(ld\+json|application\/json)["']/.test(tag)
    );

  it('public/index.html carries only the JSON-LD data block inline', () => {
    expect(executableInline(read('public', 'index.html'))).toEqual([]);
  });

  it('neither serverless page emits an inline script', () => {
    // These two functions render raw HTML strings and are covered by the same
    // /(.*) header rule, so the constraint is identical. Checked as source
    // text rather than by running them.
    for (const fn of ['invite-preview.js', 'marketing-page.js']) {
      const src = read('api', fn);
      const tags = (src.match(/<script[^>]*>/g) || []).filter(
        (tag) => !/ld\+json/.test(tag)
      );
      expect([fn, tags]).toEqual([fn, []]);
    }
  });
});

describe('invite-preview.js documents the CURRENT write path (I-2)', () => {
  const SRC = read('api', 'invite-preview.js');
  // The claims live in a wrapped block comment, so a sentence can straddle a
  // line break and a `// ` prefix. Strip the prefixes and collapse the
  // whitespace, then assert against prose instead of against one line wrap.
  const PROSE = SRC.replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');

  it('no longer claims PUT /:id stores flock names raw', () => {
    // The comment used to say, in a maintainer's own words, that renaming a
    // flock stored markup unfiltered. backend/routes/flocks.js applies
    // freeText on the rename path now, matching create, so that sentence was a
    // disclosure of a hole that is closed, sitting in a file about to be
    // published.
    expect(PROSE).not.toMatch(/PUT \/:id \(update\) validators do not/);
    expect(PROSE).not.toMatch(/RENAME a flock to markup and it is stored raw/);
    expect(PROSE).not.toMatch(/only thing standing between a renamed flock/);
    expect(PROSE).not.toMatch(/is NOT stripped on write on every path/);
  });

  it('says the strip is on both routes and that the escaping is defence in depth', () => {
    expect(PROSE).toMatch(/freeText/);
    expect(PROSE).toMatch(/PUT \/:id/);
    expect(PROSE).toMatch(/defence in depth/i);
  });

  it('still escapes regardless, which is the thing the comment must not talk anyone out of', () => {
    // The comment is documentation; this is the behaviour. esc() must still be
    // applied, and the token still shape-checked, whatever the database does.
    expect(SRC).toMatch(/function esc\s*\(/);
    expect(SRC).toMatch(/\[A-Za-z0-9\]\{8,20\}/);
  });
});
