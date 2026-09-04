/**
 * The moderation SURFACES: the admin console, the user-facing report/block
 * sheet, and the venue portal's front door.
 *
 *   src/website/ModerationDashboard.js
 *   src/components/ModerationSheet.js
 *   src/components/auth/VenueLoginScreen.js
 *   src/components/ui/Icons.js   (the `ban` glyph only)
 *
 * WHY THESE THREE ARE ONE TEST FILE
 * They are the whole of Apple Guideline 1.2 as a user and a reviewer meet it:
 * the sheet is where a report is filed, the console is where it is actioned,
 * and the venue portal is the third front door into the same binary. The
 * console in particular is reachable in production by exactly ONE account
 * (ADMIN_USER_IDS names one id and was confirmed set on Railway 2026-08-18;
 * this comment said it was unset, which was true when it was written), and it
 * has no in-app entry on iOS at all, which means it has had far less real use
 * than the rest of the app and cannot be checked by hand.
 * Everything below therefore has to be checked mechanically.
 *
 * WHAT IT COVERS, and why each part is shaped the way it is
 *
 *   1. THE iOS FOCUS ZOOM, MEASURED. iOS Safari and every iOS WKWebView — the
 *      launch target, since this ships as a Capacitor shell — zoom the entire
 *      viewport when the user focuses an input, select or textarea whose
 *      computed font-size is under 16px. The report sheet's details box was
 *      13px. The assertion reads the size off the RENDERED control rather than
 *      off the source, and a second sweep walks every input/textarea/select in
 *      all three files so the next one cannot be added under 16px either.
 *
 *      Two non-fixes are pinned as non-fixes: public/index.html must keep a
 *      viewport with no `maximum-scale` and no `user-scalable=no` (modern iOS
 *      ignores them and they fail WCAG 1.4.4 where they are honoured), and
 *      touch-action: manipulation is not a fix for this at all.
 *
 *   2. HORIZONTAL OVERFLOW AT 320px, ARITHMETIC RATHER THAN LAYOUT. jsdom does
 *      no layout, so the console's style object is lifted out of the source and
 *      the width of the counts row is computed from it, including the fact that
 *      nothing in this app resets box-sizing.
 *
 *   3. THE TWO READS ARE INDEPENDENT. The console fetches the queue and the
 *      audit log separately, and used to fail them together in both directions.
 *      Rendered against a stubbed fetch, not scanned.
 *
 *   4. REFRESH IS NOT LOAD. A refresh used to replace the queue with the word
 *      "Loading…", taking the moderator's place in a 200-row list and every
 *      image and body they had opened with it.
 *
 *   5. THE ACTION ROW. Pins the fix made earlier today — every button is gated
 *      on what the SERVER can honour, never on the report still being open —
 *      so the one-action-per-report bug cannot come back by accident.
 *
 *   6. THE ICON SYSTEM. All three files used hand-rolled inline SVG, drawn to
 *      whatever geometry the author felt like that day rather than the one
 *      components/ui/Icons.js is built on. The `ban` glyph added for the Block
 *      control is checked against the system's own rules by computing them,
 *      not by matching the string it was drawn with.
 *
 *   7. DRIFT. NOUNS in the sheet is diffed against VALID_CONTENT_TYPES in
 *      backend/routes/moderation.js. This repo has shipped "a route widened a
 *      set of values and the thing behind it did not" three separate times
 *      (migrations 003, 016 and 017 each undo an instance), and venue_event was
 *      a fourth, mild one: a reported venue event read "Report this content".
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor, act } = require('@testing-library/react');

// ───────────────────────────────────────────────────────────────────────────
// services/api opens PostHog and a fetch wrapper on import. The three surfaces
// need four names off it and nothing else.
//
// Plain functions, not jest.fn(): react-scripts sets resetMocks: true, which
// strips the implementation off every jest mock before each test, so a jest.fn()
// factory returns undefined from the second test on.
// ───────────────────────────────────────────────────────────────────────────
jest.mock('../services/api', () => ({
  BASE_URL: 'https://api.test',
  getToken: () => 'test-token',
  reportContent: () => Promise.resolve({ message: 'ok' }),
  blockUser: () => Promise.resolve({ message: 'ok' }),
}));

// eslint-disable-next-line import/no-dynamic-require, global-require
const ModerationDashboard = require('../website/ModerationDashboard').default;
// eslint-disable-next-line global-require
const ModerationSheet = require('../components/ModerationSheet').default;
// eslint-disable-next-line global-require
const Icons = require('../components/ui/Icons').default;

const SRC = path.join(__dirname, '..');
// Normalised to LF: these files are CRLF on disk, and a multi-line assertion
// written with \n would pass on a checkout with one convention and fail on the
// other, which is a failure that says nothing about the code.
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const CONSOLE_FILE = path.join(SRC, 'website', 'ModerationDashboard.js');
const SHEET_FILE = path.join(SRC, 'components', 'ModerationSheet.js');
const VENUE_FILE = path.join(SRC, 'components', 'auth', 'VenueLoginScreen.js');
const SHELL_FILE = path.join(SRC, 'components', 'auth', 'AuthShell.js');
const INDEX_HTML = path.join(SRC, '..', 'public', 'index.html');
const MODERATION_ROUTE = path.join(SRC, '..', '..', 'backend', 'routes', 'moderation.js');

const consoleSrc = read(CONSOLE_FILE);
const sheetSrc = read(SHEET_FILE);
const venueSrc = read(VENUE_FILE);

const OWNED = [
  ['ModerationDashboard.js', consoleSrc],
  ['ModerationSheet.js', sheetSrc],
  ['VenueLoginScreen.js', venueSrc],
];

/**
 * Pull `const <name> = …;` out of a source file, from a module-scope
 * declaration (column 0) to the semicolon that closes it. Strings, template
 * literals and both comment styles are skipped so a `;` or a brace inside one
 * cannot end the scan early — every declaration read here carries long prose
 * comments with apostrophes and braces in them.
 *
 * Same helper as contentTakedownWiring.test.js, for the same reason: these
 * modules cannot be imported for their internals, so the internals are lifted
 * out by name and evaluated.
 */
function extractDeclaration(source, name) {
  const start = source.search(new RegExp(`^const ${name} = `, 'm'));
  if (start === -1) throw new Error(`extractDeclaration: no module-scope \`const ${name} =\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`extractDeclaration: unterminated declaration for ${name}`);
}

const evalDeclaration = (source, name) => {
  // eslint-disable-next-line no-new-func
  return new Function(`${extractDeclaration(source, name)}\nreturn ${name};`)();
};

// ───────────────────────────────────────────────────────────────────────────
// A stubbed fetch for the admin router. adminFetch does res.json().catch(...),
// so a response only needs { ok, status, json }.
// ───────────────────────────────────────────────────────────────────────────
const REPORTS = '/api/admin/reports';
const ACTIONS = '/api/admin/moderation-actions';
// Both the unverified list and a decision PUT sit under this prefix, and the
// longest-match lookup above resolves the specific one a test registers.
const VENUES = '/api/admin/venues';

let routes;
let calls;

const respond = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: () => Promise.resolve(body),
});

const aReport = (over = {}) => ({
  id: 1,
  status: 'open',
  reason: 'harassment',
  content_type: 'flock_message',
  content_id: 55,
  reported_user_id: 9,
  reported_user_name: 'Sam',
  reported_user_banned: false,
  reporter_name: 'Rae',
  created_at: '2026-08-14T10:00:00Z',
  details: '',
  content_excerpt: 'the reported words',
  content_excerpt_clipped: false,
  content_has_image: false,
  content_image_url: null,
  content_image_deferred: false,
  content_created_at: '2026-08-14T09:00:00Z',
  content_is_hidden: false,
  content_missing: false,
  ...over,
});

const queueBody = (reports, counts) => ({
  reports,
  counts: counts || [
    { status: 'open', count: reports.filter((r) => r.status === 'open').length },
    { status: 'resolved', count: 0 },
    { status: 'dismissed', count: 0 },
  ],
});

beforeEach(() => {
  calls = [];
  routes = {};
  global.fetch = (url, options) => {
    const p = String(url).replace('https://api.test', '');
    // A PUT lands on /api/admin/reports/:id, which must not be mistaken for the
    // queue read. Longest match first.
    const key = routes[p] ? p : Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => p.startsWith(k));
    calls.push({ path: p, method: (options && options.method) || 'GET', body: options && options.body });
    const handler = key ? routes[key] : null;
    if (!handler) return Promise.resolve(respond({ error: `no stub for ${p}` }, { ok: false, status: 404 }));
    return Promise.resolve(handler(p, options));
  };
  // jsdom implements neither, and the console calls both.
  // The console reads THREE lists on mount: the queue, the audit log and the
  // unverified venue claims. A default stub for the third so every test written
  // before it existed still describes a console whose other two reads worked;
  // any test that cares overrides this key.
  routes[VENUES] = () => respond({ venues: [] });
  window.confirm = () => true;
  window.alert = () => {};
});

const renderConsole = async () => {
  const view = render(React.createElement(ModerationDashboard));
  // The first paint is "Loading…"; wait for the first read to settle.
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return view;
};

const countCalls = (prefix, method) =>
  calls.filter((c) => c.path.startsWith(prefix) && (!method || c.method === method)).length;

// ═══════════════════════════════════════════════════════════════════════════
// 1. The iOS focus zoom
// ═══════════════════════════════════════════════════════════════════════════
describe('iOS focus zoom: no focusable control renders under 16px', () => {
  /**
   * Every `<input>`, `<textarea>` and `<select>` element in a source file, as
   * raw text from the tag name to the `>` that closes the opening tag. A naive
   * /<textarea[^>]*>/ cannot be used: the handlers inside carry arrow functions,
   * so `>` appears well before the tag ends. Brace depth and quotes are tracked
   * for the same reason extractDeclaration tracks them.
   */
  function focusableTags(source) {
    const found = [];
    const re = /<(input|textarea|select)\b/g;
    let m = re.exec(source);
    while (m) {
      let i = m.index + m[0].length;
      let depth = 0;
      let quote = null;
      while (i < source.length) {
        const ch = source[i];
        if (quote) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
        } else if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        else if (ch === '>' && depth === 0) break;
        i += 1;
      }
      found.push({ tag: m[1], text: source.slice(m.index, i + 1) });
      m = re.exec(source);
    }
    return found;
  }

  test('the parser finds the controls it is meant to police', () => {
    // A silent zero here would make every assertion below vacuously true, which
    // is the failure mode of every "grep for the bad thing" test.
    expect(focusableTags(sheetSrc).map((t) => t.tag)).toEqual(['textarea']);
    expect(focusableTags(venueSrc).filter((t) => t.tag === 'input').length).toBeGreaterThanOrEqual(4);
    // The console has exactly two controls: the per-report audit-reason input
    // and the per-claim one on a venue verification card. BOTH take their
    // font-size from S.reasonInput rather than inline in the tag, so the
    // inline sweep below cannot see either; the 16px floor for that one style
    // is asserted by name in section 2, where S is already evaluated.
    expect(focusableTags(consoleSrc).map((t) => t.tag)).toEqual(['input', 'input']);
  });

  test.each(OWNED)('%s declares no inline font-size below 16px on a focusable control', (name, source) => {
    for (const el of focusableTags(source)) {
      const m = /fontSize:\s*'([\d.]+)px'/.exec(el.text);
      if (!m) continue;
      expect({ file: name, tag: el.tag, fontSize: Number(m[1]) })
        .toEqual(expect.objectContaining({ fontSize: expect.any(Number) }));
      expect(Number(m[1])).toBeGreaterThanOrEqual(16);
    }
  });

  test('the report sheet details box renders at 16px, read off the element', () => {
    render(React.createElement(ModerationSheet, {
      target: { userId: 3, userName: 'Sam', contentType: 'flock_message', contentId: 9 },
      onClose: () => {},
      showToast: () => {},
    }));
    fireEvent.click(screen.getByRole('button', { name: /^Report this message$/ }));
    const box = screen.getByLabelText('Add details (optional)');
    expect(box.tagName).toBe('TEXTAREA');
    // 13px here is what "it zooms in and ruins it" was: iOS scales the whole
    // viewport on focus below 16.
    expect(parseFloat(box.style.fontSize)).toBeGreaterThanOrEqual(16);
  });

  test('the venue portal fields inherit 16px from .auth-field, not from a local style', () => {
    // VenueLoginScreen carries no inline font-size on any input; all four are
    // className="auth-field". jsdom resolves no cascade, so the rule itself is
    // the thing under test, in the file that owns it.
    const shell = read(SHELL_FILE);
    // Closed on `\n}` rather than the first `}`: AUTH_CSS is a template literal
    // and its declarations carry ${AUTH.cream} interpolations, whose closing
    // brace would end a lazy match three lines above the font-size.
    const rule = /\.auth-field\s*\{([\s\S]*?)\n\}/.exec(shell);
    expect(rule).not.toBeNull();
    const size = /font-size:\s*([\d.]+)px/.exec(rule[1]);
    expect(size).not.toBeNull();
    expect(Number(size[1])).toBeGreaterThanOrEqual(16);
    // And every field on the venue screen really does use that class.
    const inputs = venueSrc.match(/<input\b[\s\S]*?className="auth-field"/g) || [];
    expect(inputs.length).toBeGreaterThanOrEqual(4);
  });

  test('the fix is not attempted on the viewport, which is an accessibility failure of its own', () => {
    const html = read(INDEX_HTML);
    const meta = /<meta name="viewport" content="([^"]+)"/.exec(html);
    expect(meta).not.toBeNull();
    expect(meta[1]).toContain('width=device-width');
    // Modern iOS ignores both, and where they are honoured they block pinch
    // zoom, which is WCAG 1.4.4. The 16px rule above is the whole fix.
    expect(meta[1]).not.toMatch(/maximum-scale/);
    expect(meta[1]).not.toMatch(/user-scalable/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Horizontal overflow at a 320px viewport
// ═══════════════════════════════════════════════════════════════════════════
describe('the console fits a 320px viewport', () => {
  const S = evalDeclaration(consoleSrc, 'S');

  // 320px device, minus the wrapper's 20px of padding on each side.
  const CONTENT = 320 - 40;
  const num = (v) => (typeof v === 'number' ? v : parseFloat(v));

  test('the page wrapper is border-box, so max-width + padding is not 920px', () => {
    // There is no `* { box-sizing: border-box }` anywhere in src/ — checked.
    // Content-box, a maxWidth of 880 plus 40px of padding is a 920px element,
    // which scrolls sideways on any viewport between 880 and 920.
    expect(S.wrap.boxSizing).toBe('border-box');
    expect(num(S.wrap.maxWidth)).toBeLessThanOrEqual(880);
  });

  test('the counts row wraps, and one badge fits the column on its own', () => {
    expect(S.counts.flexWrap).toBe('wrap');

    const [, padX] = String(S.badge.padding).split(/\s+/).map(parseFloat);
    const border = 2; // 1px each side, from `border: '1px solid …'`
    const badgeWidth = S.badge.boxSizing === 'border-box'
      ? num(S.badge.minWidth)
      : num(S.badge.minWidth) + 2 * padX + border;

    // Wrapping only helps if a single badge fits. Four of these at 126px each
    // plus three 12px gaps was 540px inside a 280px column: ~260px of overflow
    // on the header of the moderation console.
    expect(badgeWidth).toBeLessThanOrEqual(CONTENT);
  });

  test('the card header wraps rather than pushing the status off the right edge', () => {
    expect(S.cardTop.flexWrap).toBe('wrap');
    // The action row already wrapped; keep it that way.
    expect(S.actions.flexWrap).toBe('wrap');
  });

  test('nothing declares a fixed pixel width wider than the 320px column', () => {
    for (const [key, rule] of Object.entries(S)) {
      if (!rule || typeof rule !== 'object') continue;
      if (rule.width === undefined || typeof rule.width !== 'number') continue;
      // A fixed width is only allowed alongside a maxWidth that releases it.
      expect({ key, width: rule.width, maxWidth: rule.maxWidth }).toEqual(
        expect.objectContaining({ maxWidth: '100%' })
      );
      // …and border-box, or the border pushes it past the cap it just accepted.
      expect(rule.boxSizing).toBe('border-box');
    }
  });

  test('the reported body cannot be widened by an unbroken 5,000-character string', () => {
    expect(S.excerpt.overflowWrap).toBe('anywhere');
    expect(S.type.overflowWrap).toBe('anywhere');
    // The stored audit reason is up to 1000 characters of free text, rendered
    // back into the log; same rule.
    expect(S.logReason.overflowWrap).toBe('anywhere');
  });

  test('the audit-reason input renders at 16px, the iOS focus-zoom floor', () => {
    // The one focusable control the console owns (section 1 counts it). Its
    // size lives in S rather than inline, so the inline sweep cannot police it.
    expect(num(S.reasonInput.fontSize)).toBeGreaterThanOrEqual(16);
    // …and it cannot widen the card: full-width inside a border-box.
    expect(S.reasonInput.boxSizing).toBe('border-box');
    expect(S.reasonInput.maxWidth).toBe('100%');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The queue read and the audit-log read are independent
// ═══════════════════════════════════════════════════════════════════════════
describe('two lists, two verdicts', () => {
  test('an audit-log failure never prints "the queue could not be loaded" over a queue that loaded', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ error: 'Failed to fetch audit log' }, { ok: false, status: 500 });

    await renderConsole();

    // The queue genuinely IS clear. Saying otherwise is the one sentence on
    // this screen that must never be wrong in either direction.
    expect(await screen.findByText('Queue is clear.')).toBeInTheDocument();
    expect(screen.queryByText(/queue could not be loaded/i)).toBeNull();
    expect(screen.getByText('The audit log could not be loaded.')).toBeInTheDocument();
  });

  test('a queue failure does not stop the audit log from being read at all', async () => {
    routes[REPORTS] = () => respond({ error: 'Failed to fetch reports' }, { ok: false, status: 500 });
    routes[ACTIONS] = () => respond({
      actions: [{ id: 4, action: 'user_banned', target_user_name: 'Sam', moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z' }],
    });

    await renderConsole();

    // Chained inside one try, the second fetch never happened and the screen
    // then reported the audit log as having failed — about a request it never
    // made.
    expect(countCalls(ACTIONS)).toBe(1);
    expect(screen.getByText('user banned', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('The audit log could not be loaded.')).toBeNull();
    expect(screen.getByText(/queue could not be loaded/i)).toBeInTheDocument();
  });

  test('the audit log says when it is only showing the last 200 actions', async () => {
    // moderation_actions is the compliance record. A log that silently stops at
    // 200 and looks complete is worse than one that says where it stops.
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, action: 'content_hidden', content_type: 'dm', content_id: i + 1,
      moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z',
    }));
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: many });

    await renderConsole();
    expect(screen.getByText(/last 200 actions/)).toBeInTheDocument();
  }, 30000);

  test('a malformed 200 is a failure, not an empty queue', async () => {
    routes[REPORTS] = () => respond({ reports: 'not an array' });
    routes[ACTIONS] = () => respond({ actions: [] });

    await renderConsole();

    expect(screen.queryByText('Queue is clear.')).toBeNull();
    expect(screen.getByText(/does not understand/i)).toBeInTheDocument();
    // …and the audit log is still allowed to be honestly empty.
    expect(screen.getByText('No actions yet.')).toBeInTheDocument();
  });

  test('a 403 gets the sign-in hint; an unrelated failure does not', async () => {
    routes[REPORTS] = () => respond({ error: 'Admin access required' }, { ok: false, status: 403 });
    routes[ACTIONS] = () => respond({ error: 'Failed to fetch audit log' }, { ok: false, status: 500 });

    await renderConsole();

    expect(screen.getByText(/Sign in to the app at flockcorp\.com\/app as the admin account/)).toBeInTheDocument();
    // Exactly one banner carries it: the one that actually saw a 403.
    expect(screen.getAllByText(/Sign in to the app at flockcorp\.com\/app as the admin account/)).toHaveLength(1);
  });

  test('the signed-out arrival gets the hint too, not just the 403', async () => {
    // The likeliest way to reach this page is a browser that has never had the
    // Flock app open, which is middleware/auth.js answering 401 "No token
    // provided". The hint used to match on 403 alone, so the arrival that most
    // needed the next step was the one that never got it.
    for (const msg of ['No token provided', 'Token expired', 'Session expired, please sign in again', 'Invalid token']) {
      routes[REPORTS] = () => respond({ error: msg }, { ok: false, status: 401 });
      routes[ACTIONS] = () => respond({ error: msg }, { ok: false, status: 401 });
      const view = await renderConsole();
      expect(screen.getAllByText(/Sign in to the app at flockcorp\.com\/app as the admin account/)).toHaveLength(1);
      view.unmount();
    }
  });

  test('a failure that has nothing to do with signing in is not answered with "sign in"', async () => {
    routes[REPORTS] = () => respond({ error: 'Failed to fetch reports' }, { ok: false, status: 500 });
    routes[ACTIONS] = () => respond({ error: 'Failed to fetch audit log' }, { ok: false, status: 500 });
    await renderConsole();
    expect(screen.queryByText(/Sign in to the app at flockcorp\.com\/app as the admin account/)).toBeNull();
  });

  test('one failure that takes out both reads is stated once, not keyed twice', async () => {
    // An offline tab, a dropped VPN and a CORS refusal all fail BOTH reads with
    // the identical message. Two banners keyed on the same string is a React key
    // collision on the error path of a moderation console, and the sentence is
    // about the network rather than about either list, so it belongs once.
    const dead = () => { throw new TypeError('Failed to fetch'); };
    routes[REPORTS] = dead;
    routes[ACTIONS] = dead;
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});

    await renderConsole();

    // The browser's own words no longer reach the moderator: a TypeError from
    // fetch is mapped to a sentence (2026-09-04). Still exactly one banner.
    expect(screen.getAllByText('The console could not reach the server. Check your connection and press Refresh.')).toHaveLength(1);
    expect(warn.mock.calls.some((c) => /same key|duplicate key/i.test(String(c[0])))).toBe(false);
    warn.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Refreshing is not loading
// ═══════════════════════════════════════════════════════════════════════════
describe('refresh keeps the queue on screen', () => {
  test('the rows and the opened evidence survive a refresh in flight', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ content_excerpt: 'the reported words' })]));
    routes[ACTIONS] = () => respond({ actions: [] });

    await renderConsole();
    expect(screen.getByText('the reported words')).toBeInTheDocument();

    // Hold the refresh open.
    let release;
    routes[REPORTS] = () => new Promise((resolve) => { release = () => resolve(respond(queueBody([aReport()]))); });

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    // setLoading(true) on a refresh replaced all of this with the word
    // "Loading…", so a moderator lost their place in a 200-row list and every
    // image and body they had opened from it.
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('the reported words')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refreshing…/ })).toBeDisabled();

    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByRole('button', { name: /Refresh$/ })).toBeEnabled());
  });

  test('a failed refresh keeps the counts and says they are stale', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()], [{ status: 'open', count: 7 }]));
    routes[ACTIONS] = () => respond({ actions: [] });

    await renderConsole();
    expect(screen.getByText('7')).toBeInTheDocument();

    routes[REPORTS] = () => respond({ error: 'Failed to fetch reports' }, { ok: false, status: 500 });
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    await screen.findByText(/These numbers are from the last load that worked/);
    // The number is still on screen — it just no longer claims to be current.
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('the reported words')).toBeInTheDocument();
  });

  test('a refresh that works clears the banner it put up', async () => {
    routes[REPORTS] = () => respond({ error: 'Failed to fetch reports' }, { ok: false, status: 500 });
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.getByText('Failed to fetch reports')).toBeInTheDocument();

    routes[REPORTS] = () => respond(queueBody([aReport()]));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    // An error that outlives the condition it described is the same lie as an
    // empty state that outlives a failed load, pointing the other way.
    await waitFor(() => expect(screen.queryByText('Failed to fetch reports')).toBeNull());
    await waitFor(() => expect(screen.queryByText(/last load that worked/)).toBeNull());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4b. The reported evidence
// ═══════════════════════════════════════════════════════════════════════════
describe('the opened evidence', () => {
  const withImage = aReport({
    content_has_image: true,
    content_image_url: 'https://cdn.example.test/reported.jpg',
    content_image_deferred: false,
  });

  const openTheImage = async () => {
    routes[REPORTS] = () => respond(queueBody([withImage]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Show image' }));
    return screen.getByAltText('Reported flock message');
  };

  test('a hosted image is fetched without telling its host who is looking', async () => {
    // content_image_url is a string the reported user chose. Without this, the
    // browser sends the admin console's URL in a Referer header to whoever is
    // hosting it — which tells the person being moderated that a moderator is
    // reading their report, and from where.
    const img = await openTheImage();
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  test('evidence for a report that leaves the queue is dropped, not parked', async () => {
    await openTheImage();
    expect(screen.getByAltText('Reported flock message')).toBeInTheDocument();

    // The row rotates out of the 200-row window…
    routes[REPORTS] = () => respond(queueBody([]));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText('Queue is clear.');

    // …and comes back. Unpruned, the image state survived by report id and the
    // picture would paint again unasked — reported UGC, sometimes posted by a
    // minor, held in memory for the life of the tab on a response the server
    // marks no-store.
    routes[REPORTS] = () => respond(queueBody([withImage]));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    await screen.findByRole('button', { name: 'Show image' });
    expect(screen.queryByAltText('Reported flock message')).toBeNull();
  });

  test('graphic UGC never appears unannounced', async () => {
    routes[REPORTS] = () => respond(queueBody([withImage]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    // Click-to-open, whether or not the payload already carried the url.
    expect(screen.queryByAltText('Reported flock message')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show image' })).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The action row
// ═══════════════════════════════════════════════════════════════════════════
describe('every action the server can still honour is on the card', () => {
  const onlyReport = (over) => {
    routes[REPORTS] = () => respond(queueBody([aReport(over)]));
    routes[ACTIONS] = () => respond({ actions: [] });
  };

  test('a RESOLVED report still offers hide and ban', async () => {
    // The bug this pins: every action resolves the report, and the whole row was
    // gated on the report being open, so banning an account made the Hide
    // button vanish with the content still live.
    onlyReport({ status: 'resolved', content_is_hidden: false, reported_user_banned: false });
    await renderConsole();

    expect(screen.getByRole('button', { name: 'Hide content' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ban user' })).toBeInTheDocument();
    // Dismissing something already finished changes nothing but the word on the
    // row, so that one IS status-gated, deliberately.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  test('un-hiding is reachable after the report is closed', async () => {
    // A mistaken takedown is discovered once the report is already resolved.
    onlyReport({ status: 'resolved', content_is_hidden: true });
    await renderConsole();

    expect(screen.getByRole('button', { name: 'Restore content' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide content' })).toBeNull();
  });

  test('a profile report offers no takedown, because the server refuses one', async () => {
    // TAKEDOWN_TARGETS in backend/routes/admin.js has no 'profile' entry: there
    // is no row to hide. A button that can only produce a refusal is worse than
    // no button on the screen where takedowns happen.
    onlyReport({ content_type: 'profile', content_id: null, content_is_hidden: false });
    await renderConsole();

    expect(screen.queryByRole('button', { name: 'Hide content' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore content' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ban user' })).toBeInTheDocument();
  });

  test('…and still offers none if a profile report ever arrives carrying a content id', async () => {
    // Belt to the absent content_id above. content_reports has no path that
    // writes one for a profile report today, so the two gates are separate
    // claims: "there is nothing to hide" and "the server has no takedown for
    // this type". HIDEABLE.profile is the second, and it must hold on its own.
    // (backend/__tests__/moderationConsoleContract.test.js pins the same value
    // against TAKEDOWN_TARGETS; this pins what the screen does with it.)
    onlyReport({ content_type: 'profile', content_id: 77, content_is_hidden: false });
    await renderConsole();

    expect(screen.queryByRole('button', { name: 'Hide content' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore content' })).toBeNull();
  });

  test('content that is gone offers no takedown and says why', async () => {
    onlyReport({ content_missing: true });
    await renderConsole();

    expect(screen.queryByRole('button', { name: 'Hide content' })).toBeNull();
    expect(screen.getByText('That content no longer exists. Dismiss the report.')).toBeInTheDocument();
  });

  test('a report naming no user offers no ban', async () => {
    onlyReport({ reported_user_id: null, reported_user_name: null, content_type: 'guest_rsvp' });
    await renderConsole();

    expect(screen.queryByRole('button', { name: 'Ban user' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unban user' })).toBeNull();
  });

  test('a refused action re-reads the queue instead of leaving the dead button up', async () => {
    onlyReport({});
    await renderConsole();
    const before = countCalls(REPORTS, 'GET');

    routes[REPORTS] = (p, options) => {
      if (options && options.method === 'PUT') {
        return respond({ error: 'That content no longer exists. Dismiss the report instead.' }, { ok: false, status: 404 });
      }
      return respond(queueBody([aReport({ content_missing: true })]));
    };

    fireEvent.click(screen.getByRole('button', { name: 'Hide content' }));

    // The refusal is news about the world, not just about the click: the card
    // has to re-gate itself or it keeps offering a takedown that cannot run.
    await waitFor(() => expect(countCalls(REPORTS, 'GET')).toBe(before + 1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Hide content' })).toBeNull());
  });

  test('an unparseable timestamp never renders as "Invalid Date"', async () => {
    onlyReport({ created_at: 'not-a-timestamp', content_created_at: null });
    await renderConsole();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  test('a truncated queue is stated AND navigable: hasMore renders a working Load more', async () => {
    // The guarded property this test used to pin was "the 200-row cap is
    // stated". The cap is now a window the server reports the edge of
    // (hasMore) and the console can extend, so the pin moved with it: the
    // truncation must still be STATED (counts are of the whole table) and must
    // now also be NAVIGABLE. The old harm — the oldest open reports silently
    // falling off — is closed on the server by the oldest-unhandled-first
    // ordering, which the new backend test file pins.
    const many = Array.from({ length: 200 }, (_, i) => aReport({ id: i + 1, content_id: i + 1 }));
    routes[REPORTS] = (p) => {
      if (/limit=400/.test(p)) {
        const more = Array.from({ length: 201 }, (_, i) => aReport({ id: i + 1, content_id: i + 1 }));
        return respond({ ...queueBody(more, [{ status: 'open', count: 250 }]), hasMore: false });
      }
      return respond({ ...queueBody(many, [{ status: 'open', count: 250 }]), hasMore: true });
    };
    routes[ACTIONS] = () => respond({ actions: [] });

    await renderConsole();
    expect(screen.getByText(/counts above are of the whole table/)).toBeInTheDocument();

    // The console pages by growing its window, not by appending an offset
    // fetch: the next ask must carry limit=400 and REPLACE the list.
    fireEvent.click(screen.getByRole('button', { name: /Load 200 more/ }));
    await waitFor(() => expect(calls.some((c) => /limit=400/.test(c.path))).toBe(true));

    // The server said that was everything; the button and the notice go away.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Load 200 more/ })).toBeNull());
    expect(screen.queryByText(/counts above are of the whole table/)).toBeNull();
  }, 60000);

  test('a queue that fits sends no hasMore and shows no Load more', async () => {
    onlyReport({});
    await renderConsole();
    expect(screen.queryByRole('button', { name: /Load 200 more/ })).toBeNull();
  });

  test('a failed Load more is its own error, never the queue banner, and the rows stay up', async () => {
    const many = Array.from({ length: 200 }, (_, i) => aReport({ id: i + 1, content_id: i + 1 }));
    routes[REPORTS] = (p) => {
      if (/limit=400/.test(p)) return respond({ error: 'Failed to fetch reports' }, { ok: false, status: 500 });
      return respond({ ...queueBody(many, [{ status: 'open', count: 250 }]), hasMore: true });
    };
    routes[ACTIONS] = () => respond({ actions: [] });

    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: /Load 200 more/ }));

    await screen.findAllByText('Failed to fetch reports');
    // The rows already on screen are not the thing that failed.
    expect(screen.queryByText(/These numbers are from the last load that worked/)).toBeNull();
    // And the button is still there to try again.
    expect(screen.getByRole('button', { name: /Load 200 more/ })).toBeInTheDocument();
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5b. The reason loop: typed on the card, sent with the action, read in the log
// ═══════════════════════════════════════════════════════════════════════════
describe('the audit reason travels from the card to the log', () => {
  const onlyReport = (over) => {
    routes[REPORTS] = () => respond(queueBody([aReport(over)]));
    routes[ACTIONS] = () => respond({ actions: [] });
  };

  test('a typed reason rides in the PUT body; an empty one is omitted, not sent as ""', async () => {
    onlyReport({});
    await renderConsole();

    const puts = [];
    routes[REPORTS] = (p, options) => {
      if (options && options.method === 'PUT') {
        puts.push(JSON.parse(options.body));
        return respond({ message: 'Action applied', status: 'resolved', action: 'user_banned' });
      }
      return respond(queueBody([aReport()]));
    };

    fireEvent.change(screen.getByLabelText('Reason for actions on this report'), { target: { value: '  repeat offender, second report  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban user' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    // Trimmed: the server stores what it is sent verbatim.
    expect(puts[0]).toEqual({ action: 'ban', reason: 'repeat offender, second report' });

    // The background reload the action triggers has to settle (the buttons are
    // disabled while it is in flight) before the next action can be clicked.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled());

    // No reason typed -> no reason key at all. The route treats undefined and
    // null as absent, but an empty string would be stored as a moderator who
    // wrote nothing on purpose.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ action: 'dismiss' });
  });

  test('the input cannot compose a reason the server would refuse', () => {
    // PUT /api/admin/reports/:id refuses reason.length > 1000. The cap is read
    // from the console source so it cannot drift silently.
    const m = /maxLength=\{(\d+)\}/.exec(consoleSrc);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeLessThanOrEqual(1000);
  });

  test('the log renders stored reasons, and names the new 020 actions properly', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({
      actions: [
        { id: 1, action: 'user_banned', target_user_name: 'Sam', moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z', reason: 'threats in DMs' },
        { id: 2, action: 'tier_changed', content_type: 'venue_profile', content_id: 7, moderator_name: 'Jay', created_at: '2026-08-14T11:01:00Z', reason: 'tier free -> premium: hand-sold, 6mo comp' },
        { id: 3, action: 'venue_verified', content_type: 'venue_profile', content_id: 7, moderator_name: 'Jay', created_at: '2026-08-14T11:02:00Z' },
      ],
    });

    await renderConsole();

    // The moderator's stored words are on the row, verbatim.
    expect(screen.getByText('threats in DMs')).toBeInTheDocument();
    // The transition text migration 020's routes store in reason renders too.
    expect(screen.getByText('tier free -> premium: hand-sold, 6mo comp')).toBeInTheDocument();
    // Friendly labels for the new action types, not replace(/_/g, ' ').
    expect(screen.getByText('Venue tier changed')).toBeInTheDocument();
    expect(screen.getByText('Venue verified')).toBeInTheDocument();
    // And the audit-only content type has a label, not the raw column value.
    expect(screen.queryByText(/venue_profile/)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5c. The evidence-access toggle
// ═══════════════════════════════════════════════════════════════════════════
describe('the audit log can show evidence access, clearly marked', () => {
  test('the toggle asks the server by name and re-reads only the log', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = (p) => {
      if (/include_evidence=true/.test(p)) {
        return respond({
          actions: [
            { id: 1, action: 'content_hidden', content_type: 'dm', content_id: 9, moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z' },
            { id: 2, action: 'evidence_viewed', content_type: 'dm', content_id: 9, moderator_name: 'Jay', created_at: '2026-08-14T10:59:00Z', reason: 'full text' },
          ],
        });
      }
      return respond({ actions: [{ id: 1, action: 'content_hidden', content_type: 'dm', content_id: 9, moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z' }] });
    };

    await renderConsole();
    // Default: decisions only, and no access rows were requested.
    expect(calls.filter((c) => /include_evidence=true/.test(c.path))).toHaveLength(0);
    expect(screen.queryByText('Evidence viewed')).toBeNull();

    const queueReads = countCalls(REPORTS, 'GET');
    fireEvent.click(screen.getByRole('button', { name: 'Show evidence access' }));

    // The access row arrives, labelled and marked as reading rather than
    // deciding, with the server's 'image' / 'full text' reason folded into a
    // sentence instead of rendered like a moderator's own words.
    expect(await screen.findByText('Evidence viewed')).toBeInTheDocument();
    expect(screen.getByText('ACCESS')).toBeInTheDocument();
    expect(screen.getByText('Opened the full text.')).toBeInTheDocument();
    expect(screen.getByText(/records of reading, not decisions/)).toBeInTheDocument();
    // The decision is still there beside it…
    expect(screen.getByText('Content hidden')).toBeInTheDocument();
    // …and the queue was not re-fetched to show it.
    expect(countCalls(REPORTS, 'GET')).toBe(queueReads);

    // Toggling back drops the access rows and the explainer.
    fireEvent.click(screen.getByRole('button', { name: 'Hide evidence access' }));
    await waitFor(() => expect(screen.queryByText('Evidence viewed')).toBeNull());
    expect(screen.queryByText(/records of reading, not decisions/)).toBeNull();
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// 6. The icon system
// ═══════════════════════════════════════════════════════════════════════════
describe('icons come from components/ui/Icons.js', () => {
  test.each(OWNED)('%s hand-rolls no <svg> of its own', (name, source) => {
    // Comments talk ABOUT the old glyphs; the code must not contain them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/<svg\b/);
    expect(code).not.toMatch(/strokeLinecap="round"/);
  });

  test.each(OWNED)('%s imports the icon system', (name, source) => {
    expect(source).toMatch(/import Icons from '.*ui\/Icons'/);
  });

  test('the report sheet uses the two system glyphs, not local ones', () => {
    expect(sheetSrc).toContain('Icons.flag');
    expect(sheetSrc).toContain('Icons.ban');
    expect(sheetSrc).not.toContain('FlagIcon');
    expect(sheetSrc).not.toContain('BlockIcon');
  });

  test('both sheet glyphs render as system icons and are decorative', () => {
    render(React.createElement(ModerationSheet, {
      target: { userId: 3, userName: 'Sam', contentType: 'dm', contentId: 9 },
      onClose: () => {},
      showToast: () => {},
    }));
    const dialog = screen.getByRole('dialog');
    const svgs = dialog.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    for (const el of svgs) {
      expect(el.getAttribute('class')).toContain('flock-icon');
      // The geometry contract: round caps, round joins (the 2026-08
      // modernization — butt/miter was the set's 2015 tell). A glyph carrying
      // different caps beside these reads as a different product.
      expect(el.getAttribute('stroke-linecap')).toBe('round');
      expect(el.getAttribute('stroke-linejoin')).toBe('round');
      // Each sits beside its own text label, so it must not be announced.
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.getAttribute('aria-label')).toBeNull();
    }
    // …and the labels really are there for a screen reader to read instead.
    expect(screen.getByRole('button', { name: /^Report this message$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Block Sam$/ })).toBeInTheDocument();
  });

  test('the venue password checklist uses system glyphs for both states', () => {
    expect(venueSrc).toContain('Icons.check');
    expect(venueSrc).toContain('Icons.minus');
    // The set has no bare circle, and the two circles it does have say the
    // wrong thing: alertCircle reads as an error against a rule the user has
    // simply not reached yet.
    expect(venueSrc).not.toContain('Icons.alertCircle');
  });

  describe('Icons.ban, the glyph added for the Block control', () => {
    // Nothing in the set said "this person cannot reach you": shield is the SOS
    // mark, lock reads as private, x reads as close, minus reads as remove.
    const parts = () => {
      const { container } = render(React.createElement('div', null, Icons.ban('currentColor', 18)));
      return {
        circles: [...container.querySelectorAll('circle')],
        paths: [...container.querySelectorAll('path')].map((p) => p.getAttribute('d')),
      };
    };

    test('it exists and is a closed ring plus one straight bar', () => {
      expect(typeof Icons.ban).toBe('function');
      const { circles, paths } = parts();
      // A full circle struck by a bar is the international prohibition sign.
      // The ring used to carry the set's 30deg signature gap; the 2026-08
      // geometry retired the open-container signature and the ring closed
      // with it, drawn as a real <circle> at r=9.
      expect(circles).toHaveLength(1);
      expect(circles[0].getAttribute('cx')).toBe('12');
      expect(circles[0].getAttribute('cy')).toBe('12');
      expect(circles[0].getAttribute('r')).toBe('9');
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/^M[\d.]+ [\d.]+ [\d.]+ [\d.]+$/); // one segment, no curve
    });

    test('the bar is a true 45 degree chord with both ends on the ring', () => {
      const { paths } = parts();
      const [x1, y1, x2, y2] = paths[0].replace('M', '').split(/\s+/).map(Number);
      const r = (x, y) => Math.hypot(x - 12, y - 12);
      // Straight segments in this set default to exactly 0 / 45 / 90 degrees.
      expect(Math.abs(Math.abs(x2 - x1) - Math.abs(y2 - y1))).toBeLessThan(0.01);
      // Both ends land on the ring's own radius, whole-unit per the system —
      // a chord that stops short of the ring reads as a minus inside a circle.
      expect(r(x1, y1)).toBeCloseTo(9, 1);
      expect(r(x2, y2)).toBeCloseTo(9, 1);
    });

    test('the bar runs upper-left to lower-right, the prohibition orientation', () => {
      // Replaces the retired ring-gap test: the 30deg gap that test protected
      // the bar from no longer exists (the ring is closed), but the diagonal
      // it forced is still the one that matters — upper-left to lower-right is
      // how the real prohibition sign draws its slash, and the mirrored
      // diagonal reads as a struck-through zero.
      const { paths } = parts();
      const [x1, y1, x2, y2] = paths[0].replace('M', '').split(/\s+/).map(Number);
      const [sx, sy, ex, ey] = x1 < x2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1];
      expect(sx).toBeLessThan(12);
      expect(sy).toBeLessThan(12);
      expect(ex).toBeGreaterThan(12);
      expect(ey).toBeGreaterThan(12);
    });

    test('it obeys the shared geometry and is decorative unless labelled', () => {
      const { container } = render(React.createElement('div', null, Icons.ban('#EF4444', 17)));
      const svg = container.querySelector('svg');
      expect(svg.getAttribute('stroke-linecap')).toBe('round');
      expect(svg.getAttribute('stroke-linejoin')).toBe('round');
      expect(svg.getAttribute('aria-hidden')).toBe('true');

      const labelled = render(React.createElement('div', null, Icons.ban('#EF4444', 17, 'Block this account')));
      const el = labelled.container.querySelector('svg');
      expect(el.getAttribute('role')).toBe('img');
      expect(el.getAttribute('aria-label')).toBe('Block this account');
      expect(el.getAttribute('aria-hidden')).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Drift between the sheet and the server
// ═══════════════════════════════════════════════════════════════════════════
describe('the sheet names every content type the server accepts', () => {
  const VALID_CONTENT_TYPES = (() => {
    const src = read(MODERATION_ROUTE);
    const m = /const VALID_CONTENT_TYPES = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    const types = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
    expect(types.length).toBeGreaterThanOrEqual(7);
    return types;
  })();

  test('NOUNS has an entry for each one', () => {
    const NOUNS = evalDeclaration(sheetSrc, 'NOUNS');
    for (const type of VALID_CONTENT_TYPES) {
      // Missing, the button says "Report this content" over a named thing — the
      // same route-widened-and-the-thing-behind-it-did-not shape as migrations
      // 003, 016 and 017, in its mildest form. venue_event was the instance.
      expect(Object.prototype.hasOwnProperty.call(NOUNS, type)).toBe(true);
      expect(typeof NOUNS[type]).toBe('string');
      expect(NOUNS[type].length).toBeGreaterThan(0);
    }
  });

  test('and no entry the server would reject', () => {
    const NOUNS = evalDeclaration(sheetSrc, 'NOUNS');
    for (const type of Object.keys(NOUNS)) {
      expect(VALID_CONTENT_TYPES).toContain(type);
    }
  });

  test('the reasons offered are exactly the ones the server accepts', () => {
    const src = read(MODERATION_ROUTE);
    const m = /const VALID_REASONS = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    const serverReasons = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]).sort();
    const REASONS = evalDeclaration(sheetSrc, 'REASONS');
    expect(REASONS.map((r) => r.value).sort()).toEqual(serverReasons);
  });

  test('the details box cannot exceed the length the server will store', () => {
    const src = read(MODERATION_ROUTE);
    const cap = /isLength\(\{\s*max:\s*(\d+)\s*\}\)/.exec(src);
    expect(cap).not.toBeNull();
    const local = /maxLength=\{(\d+)\}/.exec(sheetSrc);
    expect(local).not.toBeNull();
    expect(Number(local[1])).toBeLessThanOrEqual(Number(cap[1]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CARD'S MEMORY, THE CHILD-SAFETY NOTICE, AND THE MIDDLE RUNG
//
// Three gaps found by walking a report from the tap that files it to the click
// that closes it, rather than by reading the file:
//
//   * the card carried no record at all, so a moderator could not tell a first
//     complaint from an eleventh, could not see that nine other people were
//     waiting on the same message, and could not see that a colleague had
//     already handled the report they were looking at;
//   * a report under 'sexual' rendered exactly like a spam report, beside the
//     buttons MODERATION-LEGAL.md section 4 step 2 says not to press until the
//     evidence is preserved;
//   * the only account-level outcomes were "leave it alone" and "banned
//     forever", on an app whose floor is 13.
//
// The server halves are pinned in backend/__tests__/adminQueueContextAndWarning.
// ═══════════════════════════════════════════════════════════════════════════
describe('the card carries the account record', () => {
  test('a crowd reporting one message is stated, and hiding it is said to close the rest', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ content_open_reports: 10 })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.getByText(/10 people/)).toBeInTheDocument();
    expect(screen.getByText(/Hiding it closes the rest/)).toBeInTheDocument();
  });

  test('one report about a piece of content says nothing about a crowd', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ content_open_reports: 1 })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.queryByText(/have reported this same/)).toBeNull();
  });

  test('prior reports and what was decided last time both render', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({
      user_total_reports: 4,
      user_last_action: 'user_warned',
      user_last_action_at: '2026-08-01T10:00:00Z',
    })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.getByText(/4 earlier reports against this account/)).toBeInTheDocument();
    expect(screen.getByText(/Last time we warned them/)).toBeInTheDocument();
  });

  test('a handled report names who handled it, so two moderators do not redo one report', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({
      status: 'resolved',
      handled_by_name: 'Jo',
      resolved_at: '2026-08-20T10:00:00Z',
    })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.getByText(/Already handled by Jo/)).toBeInTheDocument();
  });

  test('a server that sends none of those columns prints no record at all', async () => {
    // Not a confident "0 earlier reports" for something it never measured.
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.queryByText(/earlier report/)).toBeNull();
    expect(screen.queryByText(/Already handled by/)).toBeNull();
  });
});

describe('a child-safety report does not look like a spam report', () => {
  test('the flag and the preserve-first notice both render, and name the runbook', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ reason: 'sexual', child_safety: true })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.getByText('CHILD SAFETY')).toBeInTheDocument();
    expect(screen.getByText(/Preserve the evidence before you act/)).toBeInTheDocument();
    expect(screen.getByText(/MODERATION-LEGAL/)).toBeInTheDocument();
  });

  test('a minor on either side of the report is said out loud, and no birthday is', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({
      reason: 'sexual', child_safety: true, reported_user_is_minor: true, reporter_is_minor: false,
    })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.getByText('The reported account is under 18.')).toBeInTheDocument();
  });

  test('an ordinary report carries neither', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ reason: 'spam', child_safety: false })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.queryByText('CHILD SAFETY')).toBeNull();
    expect(screen.queryByText(/Preserve the evidence/)).toBeNull();
  });

  test('a server too old to send the flag still marks the one reason that carries the duty', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ reason: 'sexual' })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.getByText('CHILD SAFETY')).toBeInTheDocument();
  });
});

describe('warn is a real action with a real delivery', () => {
  test('the button is offered, and it sends the action the server understands', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes['/api/admin/reports/1'] = () => respond({ message: 'Action applied', action: 'user_warned', alsoResolved: 0 });
    await renderConsole();
    fireEvent.click(screen.getByText('Warn user'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(put.body).action).toBe('warn');
  });

  test('a banned account is not offered a warning, because a ban has already said more', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ reported_user_banned: true })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.queryByText('Warn user')).toBeNull();
    expect(screen.getByText('Unban user')).toBeInTheDocument();
  });

  test('a report naming no user offers no warning', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport({ reported_user_id: null, reported_user_name: null })]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();
    expect(screen.queryByText('Warn user')).toBeNull();
  });
});

describe('a takedown says what it closed', () => {
  test('the reports that vanished on the refresh are accounted for', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes['/api/admin/reports/1'] = () => respond({ message: 'Action applied', action: 'content_hidden', alsoResolved: 9 });
    await renderConsole();
    fireEvent.click(screen.getByText('Hide content'));
    await waitFor(() => expect(screen.getByText(/9 other reports about the same content were closed with it/)).toBeInTheDocument());
  });

  test('a takedown that closed nothing else says nothing', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes['/api/admin/reports/1'] = () => respond({ message: 'Action applied', action: 'content_hidden', alsoResolved: 0 });
    await renderConsole();
    fireEvent.click(screen.getByText('Hide content'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(screen.queryByText(/other reports about the same content/)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. VENUE VERIFICATION, which had a backend and no screen at all
// ════════════════════════════════════════════════════════════════════════════
//
// GET /api/admin/venues/unverified and PUT /api/admin/venues/:id/verify have
// existed since migration 020, migration 047 gave the owner a button that asks,
// and until now NO FRONTEND CALLED EITHER ROUTE. The only notice of a request
// was an operator email telling somebody to run the PUT by hand.
//
// The two assertions that matter most here are the ones about lying: a decline
// must send verified:false explicitly (the route defaults an absent key to
// TRUE, so a decline that forgot would grant the badge it meant to withhold),
// and a failed read must never render as "no venue claims are waiting".

const aClaim = (over = {}) => ({
  id: 7,
  user_id: 42,
  business_name: 'The Bird Bar',
  location: '12 Main St',
  google_place_id: 'ChIJplace',
  created_at: '2026-08-01T10:00:00Z',
  verification_requested_at: '2026-08-20T10:00:00Z',
  email: 'owner@bird.example',
  ...over,
});

describe('the venue verification queue is on the screen that decides it', () => {
  test('a requested claim renders with what the admin has to check', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes[VENUES] = () => respond({ venues: [aClaim()] });
    await renderConsole();
    expect(screen.getByText('The Bird Bar')).toBeInTheDocument();
    expect(screen.getByText('REQUESTED')).toBeInTheDocument();
    // The address, the owner account and the place id are the whole of the
    // ownership check, and none of them is derivable from the others.
    expect(screen.getByText(/12 Main St/)).toBeInTheDocument();
    expect(screen.getByText(/owner@bird\.example/)).toBeInTheDocument();
    expect(screen.getByText(/ChIJplace/)).toBeInTheDocument();
  });

  test('a waiting claim is counted in the header, so nobody has to scroll to find out', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes[VENUES] = () => respond({ venues: [aClaim()] });
    await renderConsole();
    expect(screen.getByText('Venues waiting')).toBeInTheDocument();
  });

  test('no waiting claim means no badge, rather than a permanent zero', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes[VENUES] = () => respond({ venues: [] });
    await renderConsole();
    expect(screen.queryByText('Venues waiting')).toBeNull();
  });

  test('Verify PUTs verified:true to that claim', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes['/api/admin/venues/unverified'] = () => respond({ venues: [aClaim()] });
    routes['/api/admin/venues/7/verify'] = () => respond({ id: 7, business_name: 'The Bird Bar', verified: true });
    await renderConsole();
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.path).toBe('/api/admin/venues/7/verify');
    expect(JSON.parse(put.body)).toEqual({ verified: true });
  });

  test('Decline sends verified:false EXPLICITLY, because an absent key verifies', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes['/api/admin/venues/unverified'] = () => respond({ venues: [aClaim()] });
    routes['/api/admin/venues/7/verify'] = () => respond({ id: 7, business_name: 'The Bird Bar', verified: false });
    await renderConsole();
    fireEvent.click(screen.getByText('Decline'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT').body).verified).toBe(false);
  });

  test('a typed reason rides with the decision into the audit log', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes['/api/admin/venues/unverified'] = () => respond({ venues: [aClaim()] });
    routes['/api/admin/venues/7/verify'] = () => respond({ id: 7, business_name: 'The Bird Bar', verified: true });
    await renderConsole();
    fireEvent.change(screen.getByLabelText('Reason for the decision on The Bird Bar'), {
      target: { value: '  called the landline  ' },
    });
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT').body))
      .toEqual({ verified: true, reason: 'called the landline' });
  });

  test('a refusal is shown on the claim it is about, not thrown away in an alert', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes['/api/admin/venues/unverified'] = () => respond({ venues: [aClaim()] });
    routes['/api/admin/venues/7/verify'] = () => respond(
      { error: 'Another account (user 12) is already the verified owner of Google place ChIJplace. Un-verify that claim first.' },
      { ok: false, status: 409 },
    );
    await renderConsole();
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByText(/already the verified owner of Google place/)).toBeInTheDocument());
  });

  test('a failed venue read never renders as "no venue claims are waiting"', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes[VENUES] = () => respond({ error: 'Failed to load venues' }, { ok: false, status: 500 });
    await renderConsole();
    expect(screen.queryByText('No venue claims are waiting.')).toBeNull();
    expect(screen.getByText('The venue queue could not be loaded, so this is not a count of anything.')).toBeInTheDocument();
    // And the queue read, which worked, still says what it found.
    expect(screen.getByText('Queue is clear.')).toBeInTheDocument();
  });

  test('a malformed 200 is a failure, not an empty queue', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes[VENUES] = () => respond({ venues: 'not an array' });
    await renderConsole();
    expect(screen.queryByText('No venue claims are waiting.')).toBeNull();
  });

  test('a claim with no Google listing is offered no Verify button', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes[VENUES] = () => respond({ venues: [aClaim({ google_place_id: null, verification_requested_at: null })] });
    await renderConsole();
    // Collapsed with the rest of the unasked claims, and still no button once open.
    fireEvent.click(screen.getByText(/Show 1 claim nobody has asked about/));
    expect(screen.getByText('The Bird Bar')).toBeInTheDocument();
    expect(screen.queryByText('Verify')).toBeNull();
    expect(screen.getByText(/nothing to check ownership against/)).toBeInTheDocument();
  });

  test('a claim nobody asked about is collapsed and cannot be declined', async () => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions: [] });
    routes[VENUES] = () => respond({ venues: [aClaim({ verification_requested_at: null })] });
    await renderConsole();
    expect(screen.getByText('Nobody has asked to be verified.')).toBeInTheDocument();
    expect(screen.queryByText('The Bird Bar')).toBeNull();
    fireEvent.click(screen.getByText(/Show 1 claim nobody has asked about/));
    expect(screen.getByText('The Bird Bar')).toBeInTheDocument();
    // Verify is a decision an admin can make unprompted. Decline is an answer
    // to a request, and there is no request to answer.
    expect(screen.getByText('Verify')).toBeInTheDocument();
    expect(screen.queryByText('Decline')).toBeNull();
  });

  test('the console never asks the server for more claims than the route will send', () => {
    const routeSrc = read(path.join(SRC, '..', '..', 'backend', 'routes', 'admin.js'));
    const listQuery = routeSrc.slice(routeSrc.indexOf("router.get('/venues/unverified'"));
    const serverLimit = /LIMIT (\d+)/.exec(listQuery);
    expect(serverLimit).not.toBeNull();
    const consoleLimit = /^const VENUE_LIST_LIMIT = (\d+);/m.exec(consoleSrc);
    expect(consoleLimit).not.toBeNull();
    expect(Number(consoleLimit[1])).toBe(Number(serverLimit[1]));
  });
});
