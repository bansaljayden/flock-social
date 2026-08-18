/**
 * SECURITY FIXING PASS (round 1) — two regressions pinned.
 *
 *   1. STORED-XSS AT THE LIVE-MAP POPUP SINK (SECURITY-AUDIT-upload-xss.md, MEDIUM).
 *      App.js builds the flock-member popup HTML with `${loc.name}` and a
 *      `${initial}` derived from it, then hands the string to MapLibre
 *      `Popup.setHTML()` — an innerHTML sink. The venue label ~40 lines above
 *      strips `<>`; this popup escaped NOTHING. `loc.name` is the sender's
 *      stored users.name, fanned to every flock member over the location_update
 *      socket. It is latent today only because every write path to users.name
 *      runs stripHtml; the sink must be safe on its own. Fix: an escapeHtml
 *      helper applied to loc.name and the initial at the sink.
 *
 *   2. PASSWORD-RESET TOKEN IN POSTHOG $current_url (SECURITY-AUDIT-auth.md, INFO).
 *      The reset email lands on /reset-password#token=<token>. posthog-js builds
 *      $current_url from window.location.href BEFORE PasswordReset.js strips the
 *      fragment, so a live single-use reset token could ride out in a pageview.
 *      index.js's before_send + scrubUrlTokens redact `#token=`/`?token=`; this
 *      test pins that a reset token in $current_url never leaves verbatim.
 *
 * Source-scanning App.js, like every other App.js suite here.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

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
// 1. Live-map member popup escapes user-derived values at the innerHTML sink
// ═══════════════════════════════════════════════════════════════════════════

describe('map member popup: user-derived HTML is escaped at the setHTML sink', () => {
  it('an escapeHtml helper exists and escapes all five HTML-significant chars', () => {
    // Extract the shipped helper's source and run it — a real behavioral check,
    // not just a grep, so the escaping is proven to neutralize a payload.
    const src = region('const escapeHtml =', '\n\n');
    // eslint-disable-next-line no-new-func
    const escapeHtml = new Function(`${src}; return escapeHtml;`)();

    const payload = '<img src=x onerror=alert(1)>';
    const out = escapeHtml(payload);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toBe('&lt;img src=x onerror=alert(1)&gt;');

    expect(escapeHtml('"a"&\'b\'')).toBe('&quot;a&quot;&amp;&#39;b&#39;');
    // & is escaped first so an escaped angle bracket is not double-encoded.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('the popup interpolates loc.name only through escapeHtml, never raw', () => {
    // The whole member-marker builder: initial derivation through Popup.setHTML.
    const builder = codeOnly(region('Object.entries(flockMemberLocations).forEach', '.setPopup(popup)'));
    // The vulnerable raw interpolation is gone...
    expect(builder).not.toContain('${loc.name}');
    // ...replaced by the escaped form.
    expect(builder).toContain('${escapeHtml(loc.name)}');
    // The avatar initial (derived from loc.name) is escaped at its source too,
    // which also covers the SVG marker <text> that reuses it.
    expect(builder).toContain('escapeHtml((loc.name || \'?\')[0].toUpperCase())');
  });

  it('the popup HTML for a scripted name contains no live markup', () => {
    // End-to-end at the sink: reconstruct exactly the interpolation the builder
    // performs for a hostile name and prove the payload is inert.
    const src = region('const escapeHtml =', '\n\n');
    // eslint-disable-next-line no-new-func
    const escapeHtml = new Function(`${src}; return escapeHtml;`)();
    const loc = { name: '<img src=x onerror=alert(1)>' };
    const nameCell = `<div style="...">${escapeHtml(loc.name)}</div>`;
    expect(nameCell).not.toMatch(/<img/i);
    expect(nameCell).toContain('&lt;img');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A reset token in $current_url is redacted before PostHog sends it
// ═══════════════════════════════════════════════════════════════════════════

describe('reset token never reaches PostHog via $current_url', () => {
  let POSTHOG_PRIVACY_CONFIG;

  beforeAll(() => {
    // index.js lazy-loads posthog-js/sentry only when the env keys exist; keep
    // them unset so importing the module boots nothing.
    delete process.env.REACT_APP_POSTHOG_KEY;
    delete process.env.REACT_APP_SENTRY_DSN;
    jest.doMock('react-dom/client', () => ({ createRoot: () => ({ render: () => {} }) }));
    ({ POSTHOG_PRIVACY_CONFIG } = require('../index'));
  });

  it('before_send (which every capture runs through) strips the fragment token', () => {
    const token = 'a'.repeat(43) + '.QmFzZTY0dXJsVmVyaWZpZXI';
    // The exact URL the reset email lands on (emailService.js): fragment form.
    const resetUrl = `https://flockcorp.com/reset-password#token=${token}`;

    // Mock the capture surface: PostHog invokes before_send on the event it is
    // about to send. Assert the token is absent from what would leave.
    const captured = [];
    const capture = (event) => {
      const out = POSTHOG_PRIVACY_CONFIG.before_send(event);
      if (out) captured.push(out);
    };

    capture({
      event: '$pageview',
      properties: {
        $current_url: resetUrl,
        $pathname: '/reset-password',
        // Later SDK versions add sibling URL props; the recursive scrub covers them.
        $session_entry_url: resetUrl,
      },
    });

    const sent = captured[0];
    expect(sent.properties.$current_url).toBe('https://flockcorp.com/reset-password#token=redacted');
    expect(sent.properties.$session_entry_url).toBe('https://flockcorp.com/reset-password#token=redacted');
    // The live token appears nowhere in the serialized payload.
    expect(JSON.stringify(sent)).not.toContain(token);
  });
});
