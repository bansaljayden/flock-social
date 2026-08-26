/**
 * Two controls that could not succeed on an iPhone, and the configuration that
 * decides whether one of them ever will.
 *
 * WHAT THIS COVERS
 *   1. The Pay button. App.js used to be `if (m.deepLink) window.open(...)`,
 *      with `webLink` reached only when `deepLink` was NULL. On iOS a custom
 *      scheme no installed app claims fails SILENTLY inside
 *      UIApplication.open: no error, no exception, no callback. A payer
 *      without Venmo tapped Pay and got nothing at all, and this is money.
 *      `attemptPaymentHandoff` replaces it with a race, and the race has two
 *      failure directions that both matter: never firing the fallback (the old
 *      bug), and firing it after the wallet app DID open (dropping somebody on
 *      venmo.com while Venmo is on screen). Both are asserted.
 *   2. The Zelle path, which is the reason "every method has a link" was never
 *      a safe assumption. backend/routes/billing.js builds Zelle with
 *      `deepLink: null, webLink: null` and prose instructions, and those
 *      instructions were handed to showToast and then overwritten by the very
 *      next showToast call in the same synchronous block, so the one method
 *      that is nothing BUT instructions displayed none of them.
 *   3. The cross-file invariant behind both: every shape billing.js pushes into
 *      `methods` has to be one the client can actually act on. A fourth method
 *      with three nulls would render a row that does nothing when tapped.
 *   4. Deep links. services/pushNavigation.js registered `appUrlOpen` from
 *      inside a dynamic import, which resolves long after iOS delivers the URL
 *      on a COLD start, so a launch from a link was dropped on the floor.
 *      getLaunchUrl closes that window; the de-duplication is asserted in both
 *      orders because either call can land first.
 *   5. Info.plist's missing CFBundleURLTypes, as an invariant rather than a
 *      comment. It is absent exactly while nothing in the product builds a
 *      flock-scheme URL. The day something does, this fails and names the file
 *      that has to change with it.
 *   6. The venue owner dashboard and the in-app admin dashboard. Same shapes,
 *      different screen: a tier gate that matched a feature by its marketing
 *      NAME and silently failed closed for the venues paying for it; a Live
 *      Sensor panel wired to a place id that was only ever set for venues with
 *      an incomplete profile; a Research tab printing zeros for a read nobody
 *      had made; three notification switches for sends that do not exist; a
 *      profit card whose background was hardcoded light under theme-token text;
 *      and state living inside a component that remounts on every parent
 *      render. The contrast one is computed from the tokens rather than
 *      asserted as a string.
 *
 * A NOTE ON HOW THESE SCAN. Everything that reads App.js reads it RAW. An
 * earlier version stripped comments first, which is the obvious way to stop a
 * `not.toMatch` passing on prose, and it is not safe here: a whole-file
 * stripper has to track string literals, and one apostrophe in ordinary JSX
 * prose between tags looks exactly like the start of one. The desync is silent
 * and it moves assertions in whichever direction it happens to land. So the
 * comments in App.js describe the code they replaced instead of quoting it,
 * and these scans need no stripper at all.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 * App.js cannot be imported here (it is the whole app, and pulls maplibre and a
 * QR scanner), so its module-scope helpers are lifted out by name and
 * evaluated, the same technique birdieWindowAndDemoLock.test.js uses.
 * services/pushNavigation.js IS imported for real, under a fake
 * \@capacitor/app, so part 4 exercises the module rather than its source.
 */

const fs = require('fs');
const path = require('path');

// ───────────────────────────────────────────────────────────────────────────
// A fake @capacitor/app. Plain functions, not jest.fn(): react-scripts sets
// resetMocks: true, which strips the implementation off every jest mock before
// each test, so a jest.fn() here returns undefined from the second test on.
// The name has to start with "mock" or jest's hoisting refuses the reference.
// ───────────────────────────────────────────────────────────────────────────
const mockCap = {
  listeners: new Map(),
  launchUrl: null,
  deferLaunch: false,
  resolveLaunch: null,
  addListenerCalls: 0,
  reset() {
    this.listeners = new Map();
    this.launchUrl = null;
    this.deferLaunch = false;
    this.resolveLaunch = null;
    this.addListenerCalls = 0;
  },
  fire(name, payload) {
    for (const cb of this.listeners.get(name) || []) cb(payload);
  },
};

jest.mock('@capacitor/app', () => ({
  App: {
    addListener: (name, cb) => {
      mockCap.addListenerCalls += 1;
      if (!mockCap.listeners.has(name)) mockCap.listeners.set(name, new Set());
      mockCap.listeners.get(name).add(cb);
      return Promise.resolve({ remove: () => {} });
    },
    getLaunchUrl: () => {
      if (mockCap.deferLaunch) {
        return new Promise((resolve) => { mockCap.resolveLaunch = resolve; });
      }
      return Promise.resolve(mockCap.launchUrl ? { url: mockCap.launchUrl } : undefined);
    },
  },
}));

jest.mock('@capacitor-firebase/messaging', () => ({
  FirebaseMessaging: { addListener: () => Promise.resolve({ remove: () => {} }) },
}));

const REPO = path.resolve(__dirname, '..', '..', '..');
// Normalised to LF: these files are CRLF on disk, and a multi-line assertion
// written with \n would pass on one checkout convention and fail on the other.
const readSource = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and about 2,000 lines of what
// this file scans went with it. Nothing asserted below changed. The app source
// is simply in two files, so both are read, in the order they used to be one.
const appSource = readSource('frontend', 'src', 'App.js')
  + readSource('frontend', 'src', 'screens', 'VenueDashboard.js');
const pushNavSource = readSource('frontend', 'src', 'services', 'pushNavigation.js');
const billingSource = readSource('backend', 'routes', 'billing.js');
const infoPlist = readSource('frontend', 'ios', 'App', 'App', 'Info.plist');
const entitlements = readSource('frontend', 'ios', 'App', 'App', 'App.entitlements');

// ───────────────────────────────────────────────────────────────────────────
// Source readers, lifted from birdieWindowAndDemoLock.test.js. The
// declarations being extracted carry long prose comments with apostrophes,
// braces and semicolons in them, so a naive brace count is not enough.
// ───────────────────────────────────────────────────────────────────────────
function skipInert(source, i) {
  const ch = source[i];
  const next = source[i + 1];
  if (ch === '/' && next === '/') {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end;
  }
  if (ch === '/' && next === '*') {
    const end = source.indexOf('*/', i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1;
    while (j < source.length) {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === ch) return j + 1;
      j += 1;
    }
    return source.length;
  }
  return i;
}

function extractDeclaration(source, name) {
  const start = source.search(new RegExp(`^const ${name} = `, 'm'));
  if (start === -1) throw new Error(`extractDeclaration: no module-scope \`const ${name} =\` in App.js`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const skipped = skipInert(source, i);
    if (skipped !== i) { i = skipped; continue; }
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`extractDeclaration: unterminated declaration for ${name}`);
}

function extractFunction(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start === -1) throw new Error(`extractFunction: no module-scope \`function ${name}(\` in App.js`);

  // Walk the PARAMETER LIST to its closing paren first. A default value that is
  // an object literal (`options = {}`) puts a brace before the body, and
  // stopping at the first `{` would extract a signature and no body at all.
  let i = source.indexOf('(', start);
  let parens = 0;
  for (; i < source.length; i += 1) {
    const skipped = skipInert(source, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) { i += 1; break; }
    }
  }
  i = source.indexOf('{', i);
  if (i === -1) throw new Error(`extractFunction: no body for ${name}`);
  let depth = 0;
  while (i < source.length) {
    const skipped = skipInert(source, i);
    if (skipped !== i) { i = skipped; continue; }
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    i += 1;
  }
  throw new Error(`extractFunction: unterminated body for ${name}`);
}

function evaluate(chunks, names) {
  // eslint-disable-next-line no-new-func
  return new Function(`${chunks.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

const APP_CONSTS = ['PAYMENT_HANDOFF_MS', 'paymentRoutes', 'paymentWebHost'];
const APP_FUNCS = ['attemptPaymentHandoff'];
const {
  PAYMENT_HANDOFF_MS,
  paymentRoutes,
  paymentWebHost,
  attemptPaymentHandoff,
} = evaluate(
  [
    ...APP_CONSTS.map((n) => extractDeclaration(appSource, n)),
    ...APP_FUNCS.map((n) => extractFunction(appSource, n)),
  ],
  [...APP_CONSTS, ...APP_FUNCS]
);

// ───────────────────────────────────────────────────────────────────────────
// A fake window/document pair. The real question is a race between an OS event
// and a timer, so both sides have to be driven by hand.
// ───────────────────────────────────────────────────────────────────────────
function harness() {
  const opened = [];
  const winListeners = new Map();
  const docListeners = new Map();
  const timers = [];

  const add = (bag) => (type, fn) => {
    if (!bag.has(type)) bag.set(type, new Set());
    bag.get(type).add(fn);
  };
  const drop = (bag) => (type, fn) => {
    const set = bag.get(type);
    if (set) set.delete(fn);
  };

  const win = {
    open: (url, target) => { opened.push({ url, target }); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.live = false; },
    addEventListener: add(winListeners),
    removeEventListener: drop(winListeners),
  };
  const doc = {
    visibilityState: 'visible',
    addEventListener: add(docListeners),
    removeEventListener: drop(docListeners),
  };

  return {
    win,
    doc,
    opened,
    timers,
    /** Every listener still attached, across both targets. */
    liveListeners: () => {
      let n = 0;
      for (const bag of [winListeners, docListeners]) {
        for (const set of bag.values()) n += set.size;
      }
      return n;
    },
    /** Deliver an event the way the browser would. */
    fireWin: (type) => { for (const fn of [...(winListeners.get(type) || [])]) fn({ type }); },
    fireDoc: (type) => { for (const fn of [...(docListeners.get(type) || [])]) fn({ type }); },
    /** Let every armed timer expire. */
    runTimers: () => {
      for (const t of timers) {
        if (!t.live) continue;
        t.live = false;
        t.fn();
      }
    },
    /**
     * Run a timer callback that clearTimeout could not stop. This is not a
     * contrivance: clearTimeout cannot un-queue a callback the event loop has
     * already dispatched, so a handoff detected in the last few milliseconds of
     * the window really can be followed by the timer running anyway.
     */
    forceTimer: (i = 0) => { timers[i].fn(); },
    liveTimers: () => timers.filter((t) => t.live).length,
  };
}

// The two shapes billing.js actually builds for a wallet, with the scheme split
// so this file never has to spell a custom scheme literal.
const SCHEME = (name) => `${name}:${'//'}pay?amount=12.50`;
const VENMO = { method: 'venmo', label: 'Venmo', handle: '@ben', deepLink: SCHEME('venmo'), webLink: 'https://venmo.com/ben?txn=pay' };
const CASHAPP = { method: 'cashapp', label: 'Cash App', handle: '$ben', deepLink: SCHEME('cashapp'), webLink: 'https://cash.app/$ben/12.5' };
const ZELLE = { method: 'zelle', label: 'Zelle', handle: 'ben@example.com', deepLink: null, webLink: null, instructions: 'Open your banking app and send $12.50 to ben@example.com via Zelle' };

function run(method, overrides = {}) {
  const h = harness();
  const noHandoff = [];
  const instructions = [];
  const cancel = attemptPaymentHandoff(method, {
    win: h.win,
    doc: h.doc,
    onNoHandoff: (r) => noHandoff.push(r),
    onInstructions: (r) => instructions.push(r),
    ...overrides,
  });
  return { h, cancel, noHandoff, instructions };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. paymentRoutes — what one `methods` element can actually do
// ═══════════════════════════════════════════════════════════════════════════
describe('paymentRoutes', () => {
  test('a wallet method carries both an app route and a web route', () => {
    for (const m of [VENMO, CASHAPP]) {
      const r = paymentRoutes(m);
      expect(r.appUrl).toBe(m.deepLink);
      expect(r.webUrl).toBe(m.webLink);
      expect(r.instructions).toBeNull();
      expect(r.actionable).toBe(true);
    }
  });

  test('Zelle is actionable on its instructions alone, with neither link', () => {
    // The route builds this shape on purpose: Zelle lives inside each bank's
    // own app and has no shared scheme to open.
    const r = paymentRoutes(ZELLE);
    expect(r.appUrl).toBeNull();
    expect(r.webUrl).toBeNull();
    expect(r.instructions).toBe(ZELLE.instructions);
    expect(r.actionable).toBe(true);
  });

  test('a method with nothing to open is not actionable', () => {
    for (const m of [
      {},
      null,
      undefined,
      { method: 'venmo', deepLink: null, webLink: null },
      { method: 'venmo', deepLink: '', webLink: '   ', instructions: '' },
      { method: 'venmo', deepLink: 42, webLink: {}, instructions: [] },
    ]) {
      expect(paymentRoutes(m).actionable).toBe(false);
    }
  });

  test('whitespace is not a link', () => {
    const r = paymentRoutes({ deepLink: '  ', webLink: '  https://venmo.com/ben  ' });
    expect(r.appUrl).toBeNull();
    expect(r.webUrl).toBe('https://venmo.com/ben');
  });
});

describe('paymentWebHost', () => {
  test('names the site the web route goes to, without the www', () => {
    expect(paymentWebHost('https://venmo.com/ben?txn=pay')).toBe('venmo.com');
    expect(paymentWebHost('https://www.venmo.com/ben')).toBe('venmo.com');
    expect(paymentWebHost('https://cash.app/$ben/12.5')).toBe('cash.app');
  });

  test('anything unparseable has no name to show, and says so', () => {
    for (const bad of [null, undefined, '', 'venmo.com/ben', 42, {}]) {
      expect(paymentWebHost(bad)).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. attemptPaymentHandoff — the race
// ═══════════════════════════════════════════════════════════════════════════
describe('attemptPaymentHandoff opens the wallet app', () => {
  test('the deep link is opened once, inside the tap', () => {
    const { h } = run(VENMO);
    expect(h.opened).toEqual([{ url: VENMO.deepLink, target: '_blank' }]);
  });

  test('the timer is armed at the constant, not at a number invented here', () => {
    expect(PAYMENT_HANDOFF_MS).toBe(1500);
    const { h } = run(VENMO);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(PAYMENT_HANDOFF_MS);
  });

  test('the web link is never opened up front, only the app one', () => {
    const { h } = run(VENMO);
    expect(h.opened.map((o) => o.url)).not.toContain(VENMO.webLink);
  });
});

describe('the fallback fires when, and only when, the wallet app did not open', () => {
  test('nothing happens on the phone, so the payer is offered the web route', () => {
    const { h, noHandoff } = run(VENMO);
    h.runTimers();
    expect(noHandoff).toHaveLength(1);
    expect(noHandoff[0].webUrl).toBe(VENMO.webLink);
    expect(noHandoff[0].appUrl).toBe(VENMO.deepLink);
  });

  test('the app went to the background, so the fallback is suppressed', () => {
    // This is the second bug, not the absence of the first: bouncing somebody
    // to venmo.com after Venmo itself came to the foreground.
    const { h, noHandoff } = run(VENMO);
    h.doc.visibilityState = 'hidden';
    h.fireDoc('visibilitychange');
    h.runTimers();
    expect(noHandoff).toEqual([]);
  });

  test('pagehide alone suppresses it too', () => {
    const { h, noHandoff } = run(VENMO);
    h.fireWin('pagehide');
    h.runTimers();
    expect(noHandoff).toEqual([]);
  });

  test('a hidden document at timer time suppresses it even if every event was missed', () => {
    // The independent guard. A listener that never ran, or a timer that fires
    // late on resume, must not be able to produce a false "it did not open".
    const { h, noHandoff } = run(VENMO);
    h.doc.visibilityState = 'hidden';
    h.runTimers();
    expect(noHandoff).toEqual([]);
  });

  test('the visible edge of visibilitychange does NOT suppress it', () => {
    // visibilitychange fires on the way back as well. Treating the return edge
    // as a handoff would silently restore the original bug.
    const { h, noHandoff } = run(VENMO);
    h.fireDoc('visibilitychange');           // visibilityState is still 'visible'
    h.runTimers();
    expect(noHandoff).toHaveLength(1);
  });

  test('a window blur does NOT suppress it', () => {
    // In WKWebView the window blurs when a native input takes focus and when
    // the keyboard opens, with the app still fully on screen. Racing on blur
    // would recreate exactly the silent failure this function exists to fix.
    const { h, noHandoff } = run(VENMO);
    h.fireWin('blur');
    h.runTimers();
    expect(noHandoff).toHaveLength(1);
  });

  test('coming BACK from the wallet app before the timer still suppresses it', () => {
    // The case the document-state guard alone cannot see, and the reason the
    // listeners are not redundant with it. Tap Pay, Venmo opens, the payer
    // changes their mind and is back inside Flock a second later. At timer time
    // the document reads 'visible' again, and without the event having been
    // recorded the payer would be told Venmo did not open, right after using it.
    const { h, noHandoff } = run(VENMO);
    h.doc.visibilityState = 'hidden';
    h.fireDoc('visibilitychange');
    h.doc.visibilityState = 'visible';
    h.runTimers();
    expect(noHandoff).toEqual([]);
  });

  test('a timer that clearTimeout could not stop still fires nothing', () => {
    // clearTimeout cannot un-queue a callback the event loop already
    // dispatched, so the handoff detected at the very end of the window is
    // followed by the timer running regardless. `settled` is what makes that
    // harmless.
    const { h, noHandoff } = run(VENMO);
    h.fireWin('pagehide');
    h.forceTimer();
    expect(noHandoff).toEqual([]);
  });

  test('the fallback fires at most once, however many signals arrive', () => {
    const { h, noHandoff } = run(VENMO);
    h.runTimers();
    h.forceTimer();
    h.fireWin('pagehide');
    h.forceTimer();
    expect(noHandoff).toHaveLength(1);
  });

  test('a wallet with no web route still reports the failure', () => {
    // Nothing to open, but the payer still has to be told, rather than getting
    // a tap that did nothing.
    const { h, noHandoff } = run({ ...VENMO, webLink: null });
    h.runTimers();
    expect(noHandoff).toHaveLength(1);
    expect(noHandoff[0].webUrl).toBeNull();
  });

  test('every listener and timer is released on both outcomes', () => {
    const fired = run(VENMO);
    fired.h.runTimers();
    expect(fired.h.liveListeners()).toBe(0);
    expect(fired.h.liveTimers()).toBe(0);

    const suppressed = run(VENMO);
    suppressed.h.fireWin('pagehide');
    expect(suppressed.h.liveListeners()).toBe(0);
    expect(suppressed.h.liveTimers()).toBe(0);
  });

  test('cancelling disarms the race, and nothing can fire afterwards', () => {
    const { h, cancel, noHandoff } = run(VENMO);
    cancel();
    expect(h.liveListeners()).toBe(0);
    h.runTimers();
    h.fireWin('pagehide');
    expect(noHandoff).toEqual([]);
  });

  test('an explicit timeout is honoured', () => {
    const { h } = run(VENMO, { timeoutMs: 40 });
    expect(h.timers[0].ms).toBe(40);
  });
});

describe('methods with no app to hand off to', () => {
  test('Zelle shows its instructions and races nothing', () => {
    const { h, instructions, noHandoff } = run(ZELLE);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].instructions).toBe(ZELLE.instructions);
    expect(h.opened).toEqual([]);      // there is no URL to open
    expect(h.timers).toHaveLength(0);  // and nothing to wait for
    expect(h.liveListeners()).toBe(0);
    expect(noHandoff).toEqual([]);
  });

  test('a web-only method opens the web link inside the tap, with no race', () => {
    const { h, noHandoff, instructions } = run({ ...VENMO, deepLink: null });
    expect(h.opened).toEqual([{ url: VENMO.webLink, target: '_blank' }]);
    expect(h.timers).toHaveLength(0);
    expect(noHandoff).toEqual([]);
    expect(instructions).toEqual([]);
  });

  test('a method with nothing at all does nothing, quietly and without throwing', () => {
    const { h, noHandoff, instructions } = run({ method: 'venmo', deepLink: null, webLink: null });
    expect(h.opened).toEqual([]);
    expect(h.timers).toHaveLength(0);
    expect(noHandoff).toEqual([]);
    expect(instructions).toEqual([]);
  });

  test('a missing window is survivable, not a throw inside an onClick', () => {
    expect(() => attemptPaymentHandoff(VENMO, { win: null, doc: null })).not.toThrow();
    expect(() => attemptPaymentHandoff(VENMO, { win: {}, doc: null })).not.toThrow();
  });

  test('a window with no timer or listener API still opens the deep link', () => {
    // Degrade to the old behaviour rather than losing the primary route.
    const opened = [];
    expect(() => attemptPaymentHandoff(VENMO, {
      win: { open: (u) => opened.push(u) },
      doc: null,
    })).not.toThrow();
    expect(opened).toEqual([VENMO.deepLink]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The cross-file invariant: billing.js versus the client
// ═══════════════════════════════════════════════════════════════════════════
describe('every method backend/routes/billing.js builds is one the client can act on', () => {
  // Each `methods.push({ ... })` block in the payment-links route, reduced to
  // the three fields the client branches on. Read out of the route rather than
  // written down here, so a fourth method has to pass the same test.
  const blocks = [...billingSource.matchAll(/methods\.push\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1]);

  const synthesise = (block) => ({
    method: (block.match(/method:\s*'([a-z]+)'/) || [])[1],
    deepLink: /deepLink:\s*null/.test(block) ? null : 'scheme:' + '//pay',
    webLink: /webLink:\s*null/.test(block) ? null : 'https://example.com/pay',
    instructions: /instructions:\s*[`'"]/.test(block) ? 'Do the thing' : undefined,
  });

  test('the route builds exactly the three methods this client knows about', () => {
    expect(blocks.length).toBe(3);
    expect(blocks.map((b) => synthesise(b).method).sort()).toEqual(['cashapp', 'venmo', 'zelle']);
  });

  test('none of them is a row that would do nothing when tapped', () => {
    for (const block of blocks) {
      const m = synthesise(block);
      expect(paymentRoutes(m).actionable).toBe(true);
    }
  });

  test('exactly one of them has no app to open, and it is the one with instructions', () => {
    const withoutApp = blocks.map(synthesise).filter((m) => !paymentRoutes(m).appUrl);
    expect(withoutApp.map((m) => m.method)).toEqual(['zelle']);
    expect(paymentRoutes(withoutApp[0]).instructions).toBeTruthy();
    // And the route still says so in the shape the plist comment relies on.
    expect(billingSource).toMatch(/method:\s*'zelle'[\s\S]{0,200}deepLink:\s*null/);
  });

  test('both wallet methods carry a web route, which is what the fallback needs', () => {
    // A wallet whose webLink went away would leave the fallback with nothing to
    // offer, which is the old bug wearing a sheet.
    const wallets = blocks.map(synthesise).filter((m) => paymentRoutes(m).appUrl);
    expect(wallets).toHaveLength(2);
    for (const m of wallets) expect(paymentRoutes(m).webUrl).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The wiring in App.js
// ═══════════════════════════════════════════════════════════════════════════
describe('both Pay entry points go through the one handoff', () => {
  // Raw source, like the venue-dashboard block further down and for the same
  // reason: a whole-file comment stripper cannot be trusted on JSX, because one
  // apostrophe in ordinary prose between tags reads as the start of a string to
  // any scanner that is not a real parser and silently desyncs everything after
  // it. The App.js comments in this region were written to DESCRIBE the line
  // they replaced rather than to quote it, which is what makes a raw scan the
  // stronger check instead of the weaker one.
  const appCode = appSource;
  const count = (re) => (appCode.match(re) || []).length;

  test('no call site opens a deep link straight out of a method again', () => {
    expect(appCode).not.toMatch(/window\.open\(\s*\w+\.deepLink/);
    expect(appCode).not.toMatch(/window\.open\(\s*\w+\.webLink/);
    // The old shape in full: a deepLink test with a webLink branch reachable
    // only when it was null.
    expect(appCode).not.toMatch(/if\s*\(\s*\w+\.deepLink\s*\)/);
  });

  test('the single-method button and the picker share one entry point', () => {
    // One definition plus exactly two call sites.
    expect(count(/const startPaymentHandoff = useCallback/g)).toBe(1);
    expect(count(/startPaymentHandoff\(/g)).toBe(2);
    // And that entry point is the only thing that arms the race.
    expect(count(/attemptPaymentHandoff\(/g)).toBe(2); // the definition and its one caller
  });

  test('unactionable methods are filtered before anything is offered', () => {
    expect(appSource).toMatch(/paymentRoutes\(m\)\.actionable/);
  });

  test('the fallback sheet exists and is what onNoHandoff reaches', () => {
    expect(appSource).toMatch(/const \[paymentFallback, setPaymentFallback\] = useState\(null\)/);
    expect(appSource).toMatch(/onNoHandoff:\s*\(\)\s*=>\s*raise\('no-handoff'\)/);
    expect(appSource).toMatch(/onInstructions:\s*\(\)\s*=>\s*raise\('instructions'\)/);
    expect(appSource).toMatch(/\{paymentFallback && \(\(\) => \{/);
  });

  test('opening a wallet still never settles the debt on its own', () => {
    // Round 4 of an earlier audit: auto-settling here recorded cancelled
    // payments as paid. The handoff must not have acquired a settle call.
    const handoff = appSource.slice(
      appSource.indexOf('const startPaymentHandoff = useCallback'),
      appSource.indexOf('const startPaymentHandoff = useCallback') + 1600
    );
    expect(handoff).not.toMatch(/settleShare\(/);
    expect(handoff).toMatch(/Mark as paid/);
  });

  test('the race is disarmed when the component goes away', () => {
    // Its callbacks set state, so a pending timer outliving the tree is a
    // setState on an unmounted component at best. This is the UNMOUNT effect
    // specifically; matching the call anywhere also matched the one inside
    // startPaymentHandoff, which is a different job.
    expect(appCode).toMatch(
      /useEffect\(\(\) => \(\) => \{\s*if \(paymentHandoffRef\.current\) \{\s*paymentHandoffRef\.current\(\);/
    );
  });

  test('starting a second handoff disarms the first', () => {
    // Two races in flight means two sheets, and the stale one describes a
    // method the payer already moved on from.
    expect(count(/paymentHandoffRef\.current\(\);/g)).toBe(2); // the new-tap one and the unmount one
    const body = appCode.slice(appCode.indexOf('const startPaymentHandoff = useCallback'));
    expect(body.slice(0, body.indexOf('const routes = paymentRoutes(method);')))
      .toMatch(/paymentHandoffRef\.current\(\);/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Deep links: services/pushNavigation.js, imported for real
// ═══════════════════════════════════════════════════════════════════════════
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('intentFromUrl', () => {
  const { intentFromUrl } = require('../services/pushNavigation');

  test('the query form the backend emits still resolves', () => {
    // backend/services/firebaseService.js deepLinkPath builds exactly these.
    expect(intentFromUrl('/?flock=12')).toEqual({ screen: 'flock', flockId: 12, type: 'link' });
    expect(intentFromUrl('/?dm=45')).toEqual({ screen: 'dm', userId: 45, type: 'link' });
    expect(intentFromUrl('/?tab=you')).toEqual({ screen: 'friends', tab: 'profile', type: 'link' });
  });

  test('the path form a universal link would use resolves', () => {
    expect(intentFromUrl('https://www.flockcorp.com/f/12')).toEqual({ screen: 'flock', flockId: 12, type: 'link' });
    expect(intentFromUrl('https://www.flockcorp.com/dm/45')).toEqual({ screen: 'dm', userId: 45, type: 'link' });
  });

  test('a custom scheme folds its host back into the path', () => {
    // Whatever scheme is declared, the parser only cares that it is not http,
    // so there is no scheme string here that could drift from Info.plist.
    expect(intentFromUrl('flock:' + '//flock/12')).toEqual({ screen: 'flock', flockId: 12, type: 'link' });
    expect(intentFromUrl('flock:' + '//dm/45')).toEqual({ screen: 'dm', userId: 45, type: 'link' });
  });

  test('an invite link resolves to NOTHING, and that gap is now LIVE', () => {
    // https://www.flockcorp.com/i/<token> is the link the product spreads
    // through, and it is the one form intentFromUrl does not parse. There is
    // also no screen in App.js that redeems an invite token.
    //
    // This comment used to say turning on associated domains without both
    // would be worse than leaving them off. Associated domains went on in
    // 9fab8a9 and the association file claims `/i/*`, so that is no longer a
    // warning about the future: on a phone with the app installed, an invite
    // link is handed to the app today and the app has nowhere to put it. The
    // assertion below is what is TRUE, not what is wanted. It has to be
    // REPLACED by an invite-redemption route, not deleted around.
    expect(intentFromUrl('https://www.flockcorp.com/i/abc123')).toBeNull();
  });

  test('junk is null rather than a throw on the notification path', () => {
    for (const bad of [null, undefined, '', 'not a url', '/f/abc', '/dm/abc', '/?flock=-1', '/?dm=x']) {
      expect(intentFromUrl(bad)).toBeNull();
    }
  });

  test('id zero is not an id, on every form of the link', () => {
    // \\d+ matches "0" and Number('0') is a perfectly well formed number that no
    // row can ever have. The PATH branches used Number() while the query
    // branches used the shared id check, so the same link answered two
    // different things depending on which form it arrived in.
    for (const zero of ['/f/0', '/flock/0', '/dm/0', '/?flock=0', '/?dm=0']) {
      expect(intentFromUrl(zero)).toBeNull();
    }
  });
});

describe('a cold start from a link is routed instead of dropped', () => {
  let nav;

  beforeEach(() => {
    jest.resetModules();
    mockCap.reset();
    window.Capacitor = { isNativePlatform: () => true };
    // eslint-disable-next-line global-require
    nav = require('../services/pushNavigation');
  });

  afterEach(() => {
    delete window.Capacitor;
  });

  const collect = () => {
    const seen = [];
    nav.onPushNavigate((intent) => seen.push(intent));
    return seen;
  };

  test('the URL the app was LAUNCHED with produces an intent', async () => {
    // appUrlOpen only reaches a listener that is already attached, and this one
    // is attached from inside a dynamic import. On a cold start iOS delivered
    // the URL long before that, so the tap used to open the app on whatever
    // screen it last had.
    mockCap.launchUrl = 'https://www.flockcorp.com/f/12';
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    expect(seen).toEqual([{ screen: 'flock', flockId: 12, type: 'link' }]);
  });

  test('a launch with no URL produces nothing', async () => {
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    expect(seen).toEqual([]);
  });

  test('the same URL arriving twice is one tap, not two navigations', async () => {
    mockCap.launchUrl = 'https://www.flockcorp.com/f/12';
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    mockCap.fire('appUrlOpen', { url: 'https://www.flockcorp.com/f/12' });
    await flush();
    expect(seen).toHaveLength(1);
  });

  test('a different URL afterwards IS a second navigation', async () => {
    mockCap.launchUrl = 'https://www.flockcorp.com/f/12';
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    mockCap.fire('appUrlOpen', { url: 'https://www.flockcorp.com/dm/45' });
    await flush();
    expect(seen).toEqual([
      { screen: 'flock', flockId: 12, type: 'link' },
      { screen: 'dm', userId: 45, type: 'link' },
    ]);
  });

  test('the warm path still works on its own, with no launch URL at all', async () => {
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    mockCap.fire('appUrlOpen', { url: 'https://www.flockcorp.com/f/12' });
    await flush();
    expect(seen).toEqual([{ screen: 'flock', flockId: 12, type: 'link' }]);
  });

  test('the de-duplication works in the other order too', async () => {
    // Either call can land first: the listener can fire before the getLaunchUrl
    // round trip returns, or after it.
    mockCap.deferLaunch = true;
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    mockCap.fire('appUrlOpen', { url: 'https://www.flockcorp.com/f/12' });
    await flush();
    mockCap.resolveLaunch({ url: 'https://www.flockcorp.com/f/12' });
    await flush();
    expect(seen).toHaveLength(1);
  });

  test('an appUrlOpen with no url is ignored rather than routed as junk', async () => {
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    mockCap.fire('appUrlOpen', {});
    mockCap.fire('appUrlOpen', { url: '' });
    await flush();
    expect(seen).toEqual([]);
  });

  test('an empty appUrlOpen does not cancel the launch URL behind it', async () => {
    // "an event arrived" is not the same fact as "a link arrived". A urlless
    // event that counted as the live path working would swallow the cold-start
    // link it raced, and the tap would land on the wrong screen.
    mockCap.deferLaunch = true;
    const seen = collect();
    nav.startPushNavigation();
    await flush();
    mockCap.fire('appUrlOpen', {});
    await flush();
    mockCap.resolveLaunch({ url: 'https://www.flockcorp.com/f/12' });
    await flush();
    expect(seen).toEqual([{ screen: 'flock', flockId: 12, type: 'link' }]);
  });
});

describe('the web build asks the native plugin nothing', () => {
  test('no @capacitor/app listener is attached outside the native shell', async () => {
    jest.resetModules();
    mockCap.reset();
    delete window.Capacitor;
    // eslint-disable-next-line global-require
    const nav = require('../services/pushNavigation');
    nav.startPushNavigation();
    await flush();
    expect(mockCap.addListenerCalls).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Info.plist: the absent custom scheme, as an invariant instead of a comment
// ═══════════════════════════════════════════════════════════════════════════
describe('the iOS URL entry points are declared exactly when something produces them', () => {
  const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');
  const hasKey = (xml, name) => stripComments(xml).includes(`<key>${name}</key>`);

  // Everything in the product that could construct a URL, minus the abandoned
  // React Native port under mobile/ (a different bundle that is not the launch
  // path) and the tests.
  const SOURCE_FILES = [
    ['frontend', 'src', 'App.js'],
    ['frontend', 'src', 'index.js'],
    ['frontend', 'src', 'services', 'pushNavigation.js'],
    ['frontend', 'src', 'services', 'api.js'],
    ['frontend', 'src', 'services', 'firebase.js'],
    ['backend', 'services', 'firebaseService.js'],
    ['backend', 'services', 'emailService.js'],
    ['backend', 'routes', 'flocks.js'],
    ['backend', 'routes', 'checkin.js'],
  ];

  /** Quoted scheme literals only: a scheme named in a COMMENT builds nothing. */
  const quotedSchemes = (src) =>
    [...src.replace(/https?:\/\/www\.w3\.org\/[^'"`\s>]*/g, '').matchAll(/['"`]([a-z][a-z0-9+.-]*):\/\//gi)]
      .map((m) => m[1].toLowerCase());

  test('nothing in the product builds a flock-scheme URL', () => {
    for (const file of SOURCE_FILES) {
      expect(quotedSchemes(readSource(...file))).not.toContain('flock');
    }
  });

  test('so no APP-OWNED scheme is declared, and the day that changes this says so', () => {
    // Not an oversight and not blocked by Apple: an app-owned scheme needs no
    // portal capability and no server file. It is out because it would declare
    // an entry point that no push, no email, no invite link and no web page
    // ever hands out, which is the "declared capability nothing uses" defect
    // the rest of the iOS shell config is checked against. If the assertion
    // above ever fails, add the scheme in the SAME change as the producer.
    //
    // CFBundleURLTypes itself is no longer empty, and that is not this rule
    // being relaxed. Its one member is `com.googleusercontent.apps.…`, the
    // callback GoogleSignIn redirects to at the end of the native sign-in
    // added in useGoogleAuth.js — a URL the SDK both produces and consumes,
    // which is precisely the producer this test asks for. Nothing else may
    // join it without one.
    const schemes = [...stripComments(infoPlist)
      .matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g)]
      .flatMap((m) => [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((s) => s[1]));
    expect(schemes).toEqual([expect.stringMatching(/^com\.googleusercontent\.apps\./)]);
  });

  test('associated domains are entitled and served, both halves or neither', () => {
    // This test used to pin the key ABSENT: the entitlement only signs once the
    // Associated Domains capability is on App ID com.flockcorp.flock AND an
    // apple-app-site-association file is served from flockcorp.com, and neither
    // was true. Both are true as of 9fab8a9, so the assertion follows.
    //
    // The two halves fail together on purpose. An entitlement with nothing
    // serving the association file is a deep link that silently never fires;
    // an association file no build claims is a file nobody fetches.
    expect(hasKey(entitlements, 'com.apple.developer.associated-domains')).toBe(true);
    expect(fs.existsSync(path.join(REPO, 'frontend', 'api', 'apple-app-site-association.js'))).toBe(true);
    expect(JSON.parse(readSource('frontend', 'vercel.json')).rewrites).toContainEqual({
      source: '/.well-known/apple-app-site-association',
      destination: '/api/apple-app-site-association',
    });

    // Both hosts, because iOS does not follow a redirect when it fetches the
    // association file: whichever host the link names has to answer directly,
    // so apex-only or www-only half works and reports nothing.
    const domains = [...entitlements.matchAll(/<string>applinks:([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(domains.sort()).toEqual(['flockcorp.com', 'www.flockcorp.com']);
  });

  test('the plist still records both reasons where the next reader will look', () => {
    // These comments are the only place the decision is written down, and a
    // silently absent key reads as an oversight.
    expect(infoPlist).toMatch(/CFBundleURLTypes/);
    expect(infoPlist).toMatch(/apple-app-site-association/);
  });

  test('the wallet schemes the plist queries are still the ones billing.js builds', () => {
    // iosShellConfigMatchesCode.test.js owns this pairing; asserted here too
    // because the payment fix is the reason anyone reads that array.
    const declared = stripComments(infoPlist)
      .match(/<key>LSApplicationQueriesSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
    const listed = [...declared.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort();
    const built = [...new Set(
      [...billingSource.matchAll(/deepLink:\s*`([a-z][a-z0-9+.-]*):\/\//gi)].map((m) => m[1].toLowerCase())
    )].sort();
    expect(listed).toEqual(built);
  });
});

describe('pushNavigation asks for the launch URL at all', () => {
  test('getLaunchUrl is wired, not just the live listener', () => {
    expect(pushNavSource).toMatch(/getLaunchUrl/);
    expect(pushNavSource).toMatch(/appUrlOpen/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The venue dashboard and the in-app admin dashboard
//
// Neither screen can be mounted here: both live deep inside a 17k-line
// component that pulls maplibre and a QR scanner. So these are SOURCE
// assertions, against the RAW source rather than a comment-stripped copy.
//
// That is deliberate, and it is the second thing this file learned the hard
// way. A whole-file comment stripper cannot be trusted on JSX: a lone
// apostrophe in ordinary prose between tags reads as the start of a string
// literal to any scanner that is not a real parser, and everything up to the
// next apostrophe is then treated as inert. That desync is silent, and it
// pushes a `not.toMatch` in whichever direction the desync happens to land.
// So nothing here depends on stripping, and the comments in App.js were
// written to describe the code they replaced rather than to quote it, which
// is what makes an assertion against raw source mean something.
const appCount = (re) => (appSource.match(re) || []).length;

// Where RevenueScreen is really declared. Anchored to the start of the line
// rather than found with indexOf, because the comment that EXPLAINS the
// remounting problem sits above the state it moved, and a substring search
// finds the explanation before the declaration. Same trap as the comment
// stripper above: prose that quotes code is the thing these scans trip on.
const REVENUE_SCREEN_AT = appSource.search(/^ {2}const RevenueScreen = \(\) => \{/m);

describe('the tier gate cannot be broken by rewording a feature', () => {
  test('nothing looks a feature up by its marketing name any more', () => {
    // The bug: four call sites passed 'Post deals'; the premium list spells it
    // 'Post deals and specials'. .includes() missed, the helper fell through to
    // its closing `return true`, and a venue PAYING for Premium found
    // Post-a-Deal greyed out under a "Premium Feature" overlay. A typo in a
    // gate could not throw, and the safe-looking default was "locked".
    expect(appSource).not.toMatch(/isFeatureLocked/);
    expect(appSource).not.toMatch(/features\.(free|premium|pro)\.includes/);
  });

  test('the lists are still only upgrade-sheet copy', () => {
    // They may be reworded freely; that is the point of not branching on them.
    expect(appSource).toMatch(/'Post deals and specials'/);
    expect(appSource).toMatch(/features\.premium\.map/);
  });

  test('all four Post-a-Deal controls read the tier flag', () => {
    // Named individually rather than counted. A count is satisfied by the
    // wrong four: `!can.postDeals` also appears on the Promotions tab, so
    // inverting one of these and leaving that one standing kept the total up
    // while the overlay covered the card for exactly the venues allowed to use
    // it.
    expect(appSource).toMatch(/aria-label="Deal description"[\s\S]{0,600}disabled=\{!can\.postDeals\}/);
    expect(appSource).toMatch(/setDealTimeSlot\(slot\)[\s\S]{0,900}disabled=\{!can\.postDeals\}/);
    expect(appSource).toMatch(/disabled=\{!can\.postDeals \|\| !dealDescription\.trim\(\)\}/);
  });

  test('the locked overlay covers the card when the plan does NOT include it', () => {
    // Inverted, this greys Post-a-Deal out for Premium and Pro and leaves it
    // open on Free, which is the original bug with the sign flipped.
    expect(appSource).toMatch(/\{!can\.postDeals && <div style=\{\{ position: 'absolute', inset: 0, backgroundColor: 'var\(--locked-overlay\)'/);
    expect(appSource).not.toMatch(/\{can\.postDeals && <div style=\{\{ position: 'absolute', inset: 0, backgroundColor: 'var\(--locked-overlay\)'/);
  });

  test('the Promotions tab gates the same way round', () => {
    expect(appSource).toMatch(/venueTab === 'promotions' && !can\.postDeals &&/);
    expect(appSource).toMatch(/venueTab === 'promotions' && can\.postDeals &&/);
  });

  test('and that flag actually includes Premium, which was the whole complaint', () => {
    expect(appSource).toMatch(/postDeals:\s*venueTier === 'premium' \|\| venueTier === 'pro'/);
  });
});

describe('the Live Sensor panel is asked for on every venue, not just half of them', () => {
  const hydration = appSource.slice(
    appSource.indexOf('getVenueProfile().then'),
    appSource.indexOf('const needsGoogleData')
  );

  test('the place id is resolved in the unconditional profile hydration', () => {
    // It used to be set inside `if (needsGoogleData && p.business_name)`, where
    // needsGoogleData is `!p.phone || !hoursValid`. A venue with a phone number
    // and valid hours therefore never set it, never fetched sensor data, never
    // joined the venue socket room, and the Live Sensor card silently did not
    // render. The hardware worked; the dashboard never asked. It appeared only
    // for venues with an INCOMPLETE profile, the inverse of the intent.
    expect(hydration).toBeTruthy();
    expect(hydration).toMatch(/const savedPlaceId = p\.google_place_id \|\| venueOnboardingData\.googlePlaceId;/);
    expect(hydration).toMatch(/if \(savedPlaceId\) setOwnerVenuePlaceId\(savedPlaceId\);/);
  });

  test('a corrected place id repoints the panel', () => {
    // The saved id can turn out to be a different venue; the resolved one is
    // then the only id whose readings belong to this owner.
    expect(appSource).toMatch(/if \(resolvedPlaceId && resolvedPlaceId !== savedPlaceId\) setOwnerVenuePlaceId\(resolvedPlaceId\);/);
  });

  test('the sensor effect still keys on it', () => {
    expect(appSource).toMatch(/const pid = ownerVenuePlaceId;/);
    expect(appSource).toMatch(/joinVenueRoom\(pid\)/);
  });
});

describe('the admin Research tab never prints an unmeasured zero', () => {
  test('the tab reads on entry instead of rendering whatever null degrades to', () => {
    expect(appSource).toMatch(/adminTab !== 'research' \|\| researchAskedRef\.current/);
    expect(appSource).toMatch(/fetchResearchLive\(true\)/);
  });

  test('the guard is a ref, so a failed read does not retry forever', () => {
    // The obvious `if (!researchLiveData)` version loops: the failure leaves
    // the data null and the loading flag flips back, so the effect re-runs.
    expect(appSource).toMatch(/researchAskedRef\.current = true;/);
    expect(appSource).not.toMatch(/if \(!researchLiveData\) fetchResearchLive/);
  });

  test('the zero fallbacks are gone, all of them', () => {
    expect(appSource).not.toMatch(/researchLiveData \|\| \{\}/);
    for (const field of [
      'totalFlocks', 'completionRate', 'avgGroupSize',
      'budgetAdoptionRate', 'avgTimeToConfirmation', 'totalUsers', 'newUsersThisWeek',
    ]) {
      expect(appSource).not.toMatch(new RegExp(`data\\.${field} \\|\\| 0`));
    }
  });

  test('a failed read is its own state, distinct from a reading of zero', () => {
    expect(appSource).toMatch(/const \[researchError, setResearchError\] = useState\(false\)/);
    expect(appSource).toMatch(/setResearchError\(true\);/);
    // And it clears the stale numbers rather than leaving them under a
    // "Live data" label.
    expect(appSource).toMatch(/setResearchError\(true\);[\s\S]{0,80}|setResearchLiveData\(null\);[\s\S]{0,80}setResearchError\(true\)/);
  });

  test('nothing renders the cards until something was actually read', () => {
    expect(appSource).toMatch(/if \(!data\) \{/);
  });

  test('a field the response omitted says so rather than showing a zero', () => {
    expect(appSource).toMatch(/const has = \(v\) => typeof v === 'number' && Number\.isFinite\(v\);/);
    expect(appSource).toMatch(/'No data'/);
  });

  test('the mode toggle is one control, so the two directions cannot drift', () => {
    expect(appCount(/const modeToggle = \(/g)).toBe(1);
    expect(appCount(/\{modeToggle\}/g)).toBe(2); // the empty state and the loaded state
  });

  test('the research state survives the screen it is rendered on', () => {
    // RevenueScreen is redeclared on every render of FlockAppInner and mounted
    // as <RevenueScreen />, so React remounts the whole subtree whenever
    // anything unrelated out here changes state. Anything the research panel
    // needs to remember has to live OUTSIDE it or it is reset by a toast.
    const inner = appSource.slice(appSource.indexOf('const FlockAppInner ='), REVENUE_SCREEN_AT);
    for (const decl of [
      'const [researchLiveData, setResearchLiveData] = useState(null)',
      'const [researchLoading, setResearchLoading] = useState(false)',
      'const [researchError, setResearchError] = useState(false)',
      'const researchAskedRef = useRef(false)',
    ]) {
      expect(inner).toContain(decl);
    }
  });
});

describe('the revenue simulator does not reset itself mid-edit', () => {
  // Same defect as above, on the six number fields next to it: they were
  // useState INSIDE RevenueScreen, so a toast or a socket event out in
  // FlockAppInner remounted the subtree and snapped every field back to its
  // pitch-deck default. The adminTab line had already been moved for exactly
  // this reason, with a comment saying so.
  const SIM_FIELDS = ['numVenues', 'subscriptionPrice', 'eventsPerVenue', 'avgSpend', 'takeRate', 'operatingCosts'];

  test('RevenueScreen is still the remounting kind, so this still matters', () => {
    // If this ever stops being true the hoist is merely harmless, but until
    // then it is load-bearing.
    expect(appSource).toMatch(/^ {2}const RevenueScreen = \(\) => \{/m);
    expect(appSource).toMatch(/<RevenueScreen \/>/);
  });

  test.each(SIM_FIELDS)('%s is declared outside the remounting subtree', (name) => {
    const declAt = appSource.indexOf(`const [${name}, set`);
    expect(declAt).toBeGreaterThan(-1);
    expect(declAt).toBeLessThan(REVENUE_SCREEN_AT);
  });

  test.each(SIM_FIELDS)('%s is declared exactly once', (name) => {
    expect(appCount(new RegExp(`const \\[${name}, set`, 'g'))).toBe(1);
  });
});

describe('no switch is offered for an owner notification that cannot be sent', () => {
  test('the venue notifications panel is gone, and so is its state', () => {
    // backend/routes/venueProfile.js carries the audit: notification_prefs is
    // written by this dashboard and read NOWHERE, because none of the three
    // sends exists. Every push call in the backend addresses a flock member, a
    // DM recipient, a flock creator or an admin, never a venue owner;
    // venueDashboard.js inserts a review and notifies nobody; emailService.js
    // has no digest, no template and no scheduler. That comment names this file
    // as the place to fix it. Three controls for a feature that was never
    // built, on a screen a venue pays $35/mo for.
    expect(appSource).not.toMatch(/venueNotifications/);
    expect(appSource).not.toMatch(/notificationPrefs/);
    expect(appSource).not.toMatch(/toggleVenueNotification/);
  });

  test('and the promise itself is off the screen', () => {
    expect(appSource).not.toMatch(/Get notified when a flock books/);
    expect(appSource).not.toMatch(/Performance summary emails/);
    expect(appSource).not.toMatch(/Alerts for customer reviews/);
  });

  test('the backend claim this rests on is still true', () => {
    // If an owner-addressed send ever ships, this fails and the panel comes
    // back with it. `pushIfOffline(io, share.userId, ...)` style calls all take
    // a user id that is a flock participant; a venue owner notification would
    // have to read venue_profiles.user_id next to a push call.
    const venueDash = readSource('backend', 'routes', 'venueDashboard.js');
    expect(venueDash).not.toMatch(/pushIfOffline|pushAlways|pushIfOfflineDebounced/);
  });
});

describe('the two hoisted venue modals behave like dialogs', () => {
  const componentBody = (name) => {
    const start = appSource.indexOf(`const ${name} = React.memo(`);
    expect(start).toBeGreaterThan(-1);
    return appSource.slice(start, appSource.indexOf('\n});', start));
  };

  test.each(['PromoModal', 'EventModal'])(
    '%s renders DialogBehavior, so Escape closes and Tab stays inside',
    (name) => {
      // The Upgrade sheet and the Hours modal on the same screen already do
      // this; these two were the only dashboard modals that did not, so Tab
      // walked straight out into the dashboard behind them.
      expect(componentBody(name)).toMatch(/<DialogBehavior onClose=\{onCancel\}/);
    }
  );

  test('neither hand-rolls the dialog attributes instead', () => {
    // DialogBehavior writes role and aria-modal onto its parent, so a second
    // hand-written pair would be two sources of truth.
    for (const name of ['PromoModal', 'EventModal']) {
      expect(componentBody(name)).not.toMatch(/role="dialog"/);
    }
  });

  test('every field in them is a token-driven size, which the control floor reaches', () => {
    // index.css re-scopes --t-body/--t-label/--t-meta/--t-micro to 16px ON
    // input, textarea, select. A custom property resolves against the ELEMENT,
    // so an inline `fontSize: 'var(--t-label)'` on an input reads the input's
    // own 16px, not :root's 13px. A LITERAL inline px would beat that rule, so
    // what matters is that these stay tokens.
    for (const name of ['PromoModal', 'EventModal']) {
      const body = componentBody(name);
      expect(body).toMatch(/fontSize: 'var\(--t-label\)'/);
      expect(body).not.toMatch(/fontSize: '\d+px'/);
    }
  });
});

describe('the profit card is readable in both themes', () => {
  const css = readSource('frontend', 'src', 'index.css');

  test('its background is the token the text colour is designed against', () => {
    // It was a hardcoded light gradient (#d1fae5 to #a7f3d0, or the red pair)
    // under text that uses the accent TOKENS, which flip to #34d399 and
    // #fca5a5 in dark mode. Light mint on light mint, about 1.7:1, on the one
    // card whose entire job is a single number.
    expect(appSource).not.toMatch(/#d1fae5, #a7f3d0/);
    expect(appSource).not.toMatch(/#fee2e2, #fecaca/);
    expect(appSource).toMatch(
      /isProfitable \? 'var\(--accent-green-bg\)' : 'var\(--accent-red-bg\)'/
    );
  });

  // Real contrast, computed from the tokens, in both themes.
  const hex = (h) => {
    const s = h.replace('#', '');
    const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  };
  const parseColor = (v) => {
    const m = String(v).trim().match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
    }
    return { rgb: hex(v), a: 1 };
  };
  const over = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg.rgb[i] * (1 - fg.a));
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  /** A token's value inside the given selector block of index.css. */
  /**
   * A token's value under `selector`. index.css declares :root THREE times
   * (safe-area vars, the light palette, and one more further down), so taking
   * the first block that matches the selector finds a block with no colours in
   * it at all and every lookup answers null. Every matching block is scanned,
   * last declaration wins, which is what the cascade does.
   */
  const tokenIn = (selector, name) => {
    let found = null;
    let from = 0;
    for (;;) {
      const at = css.indexOf(selector, from);
      if (at === -1) break;
      const start = at + selector.length;
      const end = css.indexOf('}', start);
      const body = css.slice(start, end === -1 ? css.length : end);
      const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+?)\\s*(?:;|/\\*)`));
      if (m) found = m[1].trim();
      from = at + selector.length;
    }
    return found;
  };

  test('the token lookup found real values, not nulls it then ignored', () => {
    // Guard on the helper itself: a null would make every ratio below throw or,
    // worse, quietly compare black against black.
    for (const sel of [':root {', '[data-theme="dark"] {']) {
      for (const t of ['--bg-card-solid', '--accent-green-bg', '--accent-green-text', '--accent-red-bg', '--accent-red-text']) {
        expect(tokenIn(sel, t)).toBeTruthy();
      }
    }
  });

  test.each([
    ['light', ':root {'],
    ['dark', '[data-theme="dark"] {'],
  ])('the green pair clears 4.5:1 in %s mode', (mode, selector) => {
    const card = parseColor(tokenIn(selector, '--bg-card-solid'));
    const bg = parseColor(tokenIn(selector, '--accent-green-bg'));
    const text = parseColor(tokenIn(selector, '--accent-green-text'));
    // The accent background can be translucent, so it is composited over the
    // card the way the browser paints it.
    expect(ratio(over(text, { rgb: over(bg, card), a: 1 }), over(bg, card))).toBeGreaterThanOrEqual(4.5);
  });

  test.each([
    ['light', ':root {'],
    ['dark', '[data-theme="dark"] {'],
  ])('the red pair clears 4.5:1 in %s mode', (mode, selector) => {
    const card = parseColor(tokenIn(selector, '--bg-card-solid'));
    const bg = parseColor(tokenIn(selector, '--accent-red-bg'));
    const text = parseColor(tokenIn(selector, '--accent-red-text'));
    expect(ratio(over(text, { rgb: over(bg, card), a: 1 }), over(bg, card))).toBeGreaterThanOrEqual(4.5);
  });

  test('the old hardcoded pair really was the failure this replaces', () => {
    // Guards the test itself: if #a7f3d0 under #34d399 were fine, the fix
    // above would be cosmetic and this file would be asserting nothing.
    const bad = ratio(hex('#34d399'), hex('#a7f3d0'));
    expect(bad).toBeLessThan(2);
  });
});

describe('list keys on the venue dashboard', () => {
  test('the star rows carry one', () => {
    // `[1,2,3,4,5].map(s => Icons.starFilled(...))` returns a bare span with no
    // key, so every render of the Reviews tab warned.
    expect(appSource).not.toMatch(/\[1, 2, 3, 4, 5\]\.map\(\w+ => \w+ <=[^\n]*\? Icons\./);
    // 3 became 4 on 2026-08-14: the create-screen StarRating joined the icon
    // system (it was a hand-rolled inline SVG before, invisible to both
    // patterns here) and uses the same keyed-Fragment row as the other three.
    expect(appCount(/\[1, 2, 3, 4, 5\]\.map\(\w+ => <React\.Fragment key=\{\w+\}>/g)).toBe(4);
  });

  test('the operating-hours rows do not key on a value the editor can duplicate', () => {
    // "+ Add Hours" appends { days: '', open: '', close: '' }, so two added
    // rows both keyed on the empty string.
    expect(appSource).not.toMatch(/key=\{slot\.days\}/);
    expect(appSource).toMatch(/setOperatingHours\(\[\.\.\.operatingHours, \{ days: '', open: '', close: '' \}\]\)/);
  });
});

describe('unreachable and hand-drawn leftovers', () => {
  test('the Replied badge that could never render is gone', () => {
    // `replied` and `reply` are both derived from r.venue_reply, so
    // `replied && !reply` is false for every row that can exist.
    expect(appSource).not.toMatch(/review\.replied && !review\.reply/);
    expect(appSource).toMatch(/replied: !!r\.venue_reply/);
    expect(appSource).toMatch(/reply: r\.venue_reply \|\| null/);
  });

  test('the locked-feature padlock comes from the icon set', () => {
    expect(appSource).toMatch(/Icons\.lock\(requiredTier === 'pro' \? '#2d5a87' : 'var\(--accent-amber-text\)', 32\)/);
    // The hand-drawn one used rounded caps and rx="2", a different drawing
    // language from every other mark in the app.
    expect(appSource).not.toMatch(/<rect x="3" y="11" width="18" height="11" rx="2"/);
  });

  test('both locked states on the Analytics tab use the same mark', () => {
    expect(appSource).toMatch(/Icons\.lock\(colors\.textTertiary, 24\)/);
    expect(appSource).not.toMatch(/Icons\.shield\(colors\.textTertiary, 24\)/);
  });

  test('Icons.lock is a real export, not a name this file hoped for', () => {
    const icons = readSource('frontend', 'src', 'components', 'ui', 'Icons.js');
    expect(icons).toMatch(/^\s{2}lock: make\(/m);
  });
});

describe('the moderation console has a way in', () => {
  test('the admin dashboard names it', () => {
    expect(appSource).toMatch(/\/admin\/moderation/);
  });

  test('the web build gets a real link, opened away from the app', () => {
    expect(appSource).toMatch(/href="\/admin\/moderation" target="_blank" rel="noopener noreferrer"/);
  });

  test('the native shell is told where it is instead of given a control that dies', () => {
    // capacitor://localhost and https://www.flockcorp.com are different
    // origins, and the console reads its bearer token from localStorage on
    // whatever origin it loads on. Handing the https URL to Safari lands on a
    // console with no token and no signed-out state, where every request 401s.
    // Navigating the WebView in place does authenticate, but the console has
    // no link back and index.js reads the URL once at boot, so the admin is
    // stranded.
    // The branch itself, not just the text inside it. Disabling the branch
    // leaves the prose in the file and hands the native shell the link, which
    // is the failure this split exists to prevent.
    expect(appSource).toMatch(/const isNative = typeof window !== 'undefined' && window\.Capacitor\?\.isNativePlatform\?\.\(\) === true;/);
    expect(appSource).toMatch(/if \(isNative\) \{[\s\S]{0,900}flockcorp\.com\/admin\/moderation/);
    expect(appSource).not.toMatch(/if \(false\) \{[\s\S]{0,900}flockcorp\.com\/admin\/moderation/);
  });

  test('and that path is a route the bundle actually serves', () => {
    const indexJs = readSource('frontend', 'src', 'index.js');
    expect(indexJs).toMatch(/p === '\/admin\/moderation'/);
  });

  test('the console still reads its token from storage, which is why the split exists', () => {
    const console_ = readSource('frontend', 'src', 'website', 'ModerationDashboard.js');
    expect(console_).toMatch(/getToken\(\)/);
    const api = readSource('frontend', 'src', 'services', 'api.js');
    expect(api).toMatch(/localStorage\.getItem\('flockToken'\)/);
  });
});
