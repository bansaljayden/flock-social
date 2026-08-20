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
const directiveOf = (policy, name) => {
  const found = policy.split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(name + ' '));
  return found ? found.split(/\s+/).slice(1) : null;
};
const directive = (name) => directiveOf(CSP, name);

// The SECOND copy of this policy: the <meta http-equiv> in public/index.html.
// It exists because the App Store build serves this bundle from
// capacitor://localhost and never sees a Vercel response header at all. Read
// out of the file rather than retyped, for the same reason the host list below
// is: two hand-maintained copies of a policy is one policy and one lie.
const HTML = read('public', 'index.html');
// The value is delimited by double quotes because it is full of the single
// quotes CSP keywords need ('self', 'none', 'unsafe-inline'), so the capture
// must not treat a single quote as a delimiter.
const META = (
  HTML.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]*)"/i) || []
)[1] || '';
const metaDirective = (name) => directiveOf(META, name);

// Directives a meta-delivered policy cannot express. Every browser ignores
// them in <meta>, so the header in vercel.json is the only place they can
// live, and asserting the meta copy against them would assert nothing.
const META_IGNORED = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'];

const namesIn = (policy) => policy.split(';')
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => d.split(/\s+/)[0]);

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
        if (/maptiler|cartocdn/.test(m)) hosts.add(m);
      }
    }
    // If this is empty the regex above stopped matching and the rest of the
    // assertion would pass vacuously.
    //
    // TWO, not three. It was three while App.js carried a keyless satellite
    // fallback to server.arcgisonline.com; that branch is gone (see the note on
    // SATELLITE_STYLE) and so is the CSP entry it needed, because Esri basemaps
    // are not free for commercial use and Flock has no Esri account. MapTiler
    // hybrid is the only satellite imagery the app is licensed to draw.
    expect(hosts.size).toBeGreaterThanOrEqual(2);
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

// ===========================================================================
// The iOS half. C3-1 / X3-1: the enforcing CSP was an HTTP response header
// from Vercel, and `webDir: 'build'` with no `server.url` means the Capacitor
// shell serves the bundle out of the app package over capacitor://localhost
// and never fetches that response. Same localStorage token, same
// innerHTML/setHTML sinks, same 13-year-old audience floor, no policy at all.
// A <meta http-equiv> is the only form that travels with the bundle.
//
// The trap this suite exists for: that tag applies on the WEB too, where the
// header also applies. Two policies on one document are BOTH enforced and the
// effective policy is their intersection, so a meta directive narrower than
// the header's silently narrows the live website - a blank map, a dead
// service worker, a white screen - and none of it shows up on iOS where the
// change was being tested.
// ===========================================================================
describe('the meta CSP that ships inside the iOS binary', () => {
  it('exists in public/index.html, so the policy travels with the bundle', () => {
    expect(META).not.toBe('');
    // Not Report-Only: <meta> cannot express Report-Only at all, so a policy
    // here is always enforcing. Stated so nobody tries.
    expect(HTML).not.toMatch(/http-equiv=["']Content-Security-Policy-Report-Only["']/i);
  });

  it('has a script-src, and it allows neither inline script nor eval', () => {
    const script = metaDirective('script-src');
    expect(script).toBeTruthy();
    expect(script).toContain("'self'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(metaDirective('object-src')).toEqual(["'none'"]);
    expect(metaDirective('base-uri')).toEqual(["'none'"]);
  });

  it('is not NARROWER than the header for any directive both define', () => {
    // The whole risk in one assertion. Both sides are read from source, so
    // adding a host to vercel.json and forgetting index.html fails here
    // instead of failing as a broken production website.
    const shared = namesIn(CSP).filter((n) => !META_IGNORED.includes(n));
    expect(shared.length).toBeGreaterThan(8);
    for (const name of shared) {
      const header = directiveOf(CSP, name) || [];
      const meta = metaDirective(name);
      // A directive the header defines and the meta omits is not "wider":
      // the meta's own default-src would govern it instead, which for
      // script-src/style-src/img-src and friends is narrower than the list
      // the header spells out. Require it to be present.
      expect([name, meta]).not.toEqual([name, null]);
      const missing = header.filter((src) => !meta.includes(src));
      expect([name, missing]).toEqual([name, []]);
    }
  });

  it('drops the directives a meta policy cannot carry, and the header still has them', () => {
    for (const name of META_IGNORED) {
      expect([name, metaDirective(name)]).toEqual([name, null]);
    }
    // frame-ancestors is the one of the four that is actually in use. It is
    // the reason the header is not redundant with this tag: dropping the
    // header would lose clickjacking protection on the web, and a native
    // WebView cannot be framed by anything, so nothing is lost on iOS.
    expect(directive('frame-ancestors')).toEqual(["'self'"]);
  });

  it('names the native origin explicitly rather than loosening a directive', () => {
    // On native, 'self' is capacitor://localhost. Spelling it out costs the
    // web nothing (no https page can match a capacitor: source) and keeps the
    // bundle loading if a WebKit build declines to match 'self' against a
    // custom scheme. The alternative - widening a directive with a wildcard
    // or a bare scheme-source like https: - would widen the WEB policy too.
    for (const name of ['default-src', 'script-src', 'connect-src', 'img-src']) {
      expect([name, metaDirective(name)]).toEqual([
        name, expect.arrayContaining(['capacitor://localhost']),
      ]);
    }
    // Nothing was widened to a bare scheme or a bare wildcard to get there.
    expect(META.split(/[\s;]+/)).not.toContain('https:');
    expect(META.split(/[\s;]+/)).not.toContain('*');
    expect(META).not.toContain("'unsafe-eval'");
  });

  it('keeps the native app talking to its backend, over https and over the socket', () => {
    // The iOS shell has no same-origin API: every request is the absolute
    // Railway URL, and the socket is the wss:// form of it. If connect-src
    // misses either, the app launches and then does nothing, which is the
    // failure mode a meta CSP produces instead of an error anyone reads.
    const APISRC = read('src', 'services', 'api.js');
    const base = (APISRC.match(/https:\/\/flock-app-production\.up\.railway\.app/) || [])[0];
    expect(base).toBeTruthy();
    const connect = metaDirective('connect-src');
    expect(allows(connect, base)).toBe(true);
    expect(allows(connect, base.replace('https://', 'wss://'))).toBe(true);
    expect(allows(metaDirective('img-src'), base)).toBe(true);
  });

  it('keeps MapLibre and the push worker alive on both origins', () => {
    // Same two entries as the header suite above, asserted again on the copy
    // that ships in the binary. worker-src blob: is the map; gstatic is
    // firebase-messaging-sw.js's importScripts, which is a web concern - and
    // it has to stay here anyway, because removing it would intersect it out
    // of the web policy.
    expect(metaDirective('worker-src')).toContain('blob:');
    expect(metaDirective('img-src')).toContain('blob:');
    expect(metaDirective('img-src')).toContain('data:');
    const SW = read('public', 'firebase-messaging-sw.js');
    const imported = SW.match(/importScripts\('(https:\/\/[^']+)'\)/g) || [];
    expect(imported.length).toBeGreaterThan(0);
    for (const line of imported) {
      const url = line.match(/'(https:\/\/[^']+)'/)[1];
      expect([url, allows(metaDirective('script-src'), url)]).toEqual([url, true]);
    }
  });

  it('is parsed before the subresources below it', () => {
    // A meta policy governs only what is parsed AFTER it. The icon and
    // manifest links are real subresource loads, so the tag has to come first.
    const at = HTML.search(/<meta\s+http-equiv=["']Content-Security-Policy["']/i);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(HTML.indexOf('rel="manifest"'));
    expect(at).toBeLessThan(HTML.indexOf('rel="icon"'));
  });
});
