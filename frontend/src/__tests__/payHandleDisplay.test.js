/**
 * THE PAY SURFACE — one plain link to their handle, or a bird saying there
 * isn't one.
 *
 * Jayden, 2026-08-14: "when you go to pay it should show a link to their Venmo
 * that's all if they have it if they don't add a bird icon and say that they
 * don't simple".
 *
 * WHAT THIS LOCKS
 *
 *   1. THE CHIPS ARE GONE. Each method used to render a 40px rounded square
 *      filled with that wallet's brand GRADIENT, holding one letter (V, $, Z).
 *      Two banned patterns in one control: the icon-in-rounded-square card
 *      formula (SLOP-AUDIT A14) and a blue gradient (H2, and §M's "purple
 *      gradient" tell). Both are asserted absent from the pay region
 *      specifically, not from the file, so a legitimate gradient elsewhere
 *      cannot mask a regression here and vice versa.
 *
 *   2. A HANDLE RENDERS A REAL LINK, CARRYING THE AUDITED HREF. Not a div with
 *      an onClick and not a button dressed as a link: an <a href> whose value
 *      is paymentRoutes(m).webUrl, the same web route the fallback sheet
 *      offers. paymentRoutes is lifted out of App.js and evaluated here, so
 *      "the audited href" is proved rather than asserted by name.
 *
 *   3. THE CLICK STILL GOES THROUGH THE AUDITED RACE. The href is the honest
 *      destination and the last-resort fallback; the handler is the better
 *      route (deep link first, fallback sheet when the phone does nothing).
 *      startPaymentHandoff is still the only thing that arms it, and the two
 *      call sites are both inside this sheet. paymentHandoffAndDeepLinks
 *      counts them globally; this file says WHERE they are.
 *
 *   4. NO HANDLE MEANS A BIRD AND ONE SENTENCE, AND NO CONTROL AT ALL. The
 *      app cannot make somebody add a handle, so the empty state does not
 *      offer that or anything else. It is a decorative BirdieStill with its
 *      box reserved, plus one plain sentence, and nothing tappable inside it.
 *
 *   5. TAPPING "SETTLE UP" NO LONGER MARKS THE DEBT PAID BY ITSELF. The old
 *      zero-handle branch called settleShare on the spot, which recorded a
 *      payment nobody made. Same class as auto-settling on a handoff, which
 *      round 4 of the earlier audit already removed from startPaymentHandoff.
 *
 *   6. AN EMPTY-STRING HANDLE IS NOT A HANDLE, on both sides. The route's
 *      truthiness guards keep '' out of `methods` entirely (so this sheet sees
 *      the no-handle state, correctly), and the sheet still refuses to print a
 *      handle line with nothing readable in it.
 *
 * HOW IT SCANS. App.js cannot be imported (it is the whole app and pulls
 * maplibre and a QR scanner), so the pay region is read out of the source
 * between two JSX-unique anchors and asserted against, the same technique
 * paymentHandoffAndDeepLinks.test.js and birdBrandMoments.test.js use. The
 * region is read RAW, for the reason that file records: a whole-file comment
 * stripper cannot be trusted on JSX, because one apostrophe in ordinary prose
 * between tags reads as the start of a string literal. So the region's own
 * comments describe the pattern they replaced instead of quoting it, and the
 * banned-string assertions below can be made against raw source.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');
const { BirdieStill } = require('../components/ui/BirdieBird');

const REPO = path.resolve(__dirname, '..', '..', '..');
// Normalised to LF: these files are CRLF on disk, and a multi-line assertion
// written with \n would pass on one checkout convention and fail on the other.
const readSource = (...p) =>
  fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');

// The flock chat screen left App.js on 2026-08-26: it lives in
// screens/ChatDetail.js now, and the message list, the composer, the reaction
// row and the report entry went with it. Nothing asserted below changed. The
// app source is simply in two files, so both are read, in the order they used
// to be one.
const APP = readSource('frontend', 'src', 'App.js')
  + readSource('frontend', 'src', 'screens', 'ChatDetail.js');
const BILLING = readSource('backend', 'routes', 'billing.js');

// ───────────────────────────────────────────────────────────────────────────
// The region under test: the pay sheet, from its own comment header to the
// start of the fallback sheet that follows it.
// ───────────────────────────────────────────────────────────────────────────
const REGION_START = '{/* THE PAY SURFACE.';
const REGION_END = '{/* The wallet app never came to the foreground';

const slice = (from, to) => {
  const a = APP.indexOf(from);
  const b = APP.indexOf(to, a + 1);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return APP.slice(a, b);
};

const PAY_SHEET = slice(REGION_START, REGION_END);

// The Settle Up handler, from the control that owns it to its own catch.
const SETTLE_UP = slice(
  'const result = await getPaymentLinks(selectedFlockId);',
  'Could not load payment links.'
);

// The empty state inside the sheet: the bird and its sentence.
const EMPTY_STATE = (() => {
  const a = PAY_SHEET.indexOf('<BirdieStill');
  expect(a).toBeGreaterThan(-1);
  const b = PAY_SHEET.indexOf('</div>', a);
  return PAY_SHEET.slice(a, b);
})();

const count = (src, re) => (src.match(re) || []).length;

// ───────────────────────────────────────────────────────────────────────────
// paymentRoutes, lifted out of App.js and evaluated, so "the audited href" is
// a value this file can check rather than a variable name it trusts. Same
// extraction as paymentHandoffAndDeepLinks.test.js.
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
  expect(start).toBeGreaterThan(-1);
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
  throw new Error(`unterminated declaration for ${name}`);
}

// eslint-disable-next-line no-new-func
const { paymentRoutes } = new Function(
  `${extractDeclaration(APP, 'paymentRoutes')}\nreturn { paymentRoutes };`
)();

// The two shapes billing.js builds for a wallet, and the one it builds for
// Zelle. Split so this file never spells a custom scheme literal.
const SCHEME = (name) => `${name}:${'//'}pay?amount=12.50`;
const VENMO = { method: 'venmo', label: 'Venmo', handle: '@ben', deepLink: SCHEME('venmo'), webLink: 'https://venmo.com/ben?txn=pay' };
const CASHAPP = { method: 'cashapp', label: 'Cash App', handle: '$ben', deepLink: SCHEME('cashapp'), webLink: 'https://cash.app/$ben/12.5' };
const ZELLE = { method: 'zelle', label: 'Zelle', handle: 'ben@example.com', deepLink: null, webLink: null, instructions: 'Open your banking app and send $12.50 to ben@example.com via Zelle' };

// ═══════════════════════════════════════════════════════════════════════════
// 1. The banned chip is gone
// ═══════════════════════════════════════════════════════════════════════════
describe('the brand-gradient letter chips are gone from the pay rows', () => {
  test('no gradient of any kind is painted in the pay sheet', () => {
    // The three that were here: #3D95CE to #008CFF, #00C244 to #00D64B, and
    // #6C1CD3 to #8A2BE2. Asserted as the CSS function rather than as those
    // hexes, so a differently-coloured gradient cannot pass.
    expect(PAY_SHEET).not.toMatch(/linear-gradient/);
    expect(PAY_SHEET).not.toMatch(/radial-gradient/);
    expect(PAY_SHEET).not.toMatch(/conic-gradient/);
  });

  test('none of the retired brand hexes survived anywhere in App.js', () => {
    for (const hex of ['#3D95CE', '#008CFF', '#00C244', '#00D64B', '#6C1CD3', '#8A2BE2']) {
      expect(APP).not.toContain(hex);
    }
  });

  test('no icon-in-rounded-square box is drawn in the pay sheet', () => {
    // The formula SLOP-AUDIT A14 names: a fixed square with a corner radius,
    // holding a glyph. Matched as the shape rather than as the literal 40px,
    // so shrinking it to 36 is not a way through.
    expect(PAY_SHEET).not.toMatch(/width: '\d+px', height: '\d+px', borderRadius: '\d+px'/);
  });

  test('no method is represented by a bare letter glyph', () => {
    // `m.method === 'venmo' ? 'V' : m.method === 'cashapp' ? '$' : 'Z'`.
    expect(PAY_SHEET).not.toMatch(/\?\s*'V'\s*:/);
    expect(PAY_SHEET).not.toMatch(/:\s*'Z'\s*\}/);
    expect(PAY_SHEET).not.toMatch(/m\.method === '(venmo|cashapp|zelle)'/);
  });

  test('the rows are not a stack of identical tiles', () => {
    // Equal-weight chips were bordered, radiused cards. What replaced them is
    // a ruled list with the first handle leading.
    expect(PAY_SHEET).not.toMatch(/border: '1px solid var\(--border-default\)'/);
    expect(PAY_SHEET).toMatch(/const lead = i === 0;/);
    expect(PAY_SHEET).toMatch(/borderTop: lead \? 'none' : '1px solid var\(--divider\)'/);
    expect(PAY_SHEET).toMatch(/fontSize: lead \? 'var\(--t-body\)' : 'var\(--t-label\)'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A saved handle renders a real link, carrying the audited href
// ═══════════════════════════════════════════════════════════════════════════
describe('a payee with a handle gets a plain link to it', () => {
  test('the wallet row is an anchor, not a div or a button, and it is the only href here', () => {
    expect(PAY_SHEET).toMatch(/<a\n\s+className="hit44"/);
    expect(count(PAY_SHEET, /href=\{/g)).toBe(1);
    expect(PAY_SHEET).toMatch(/href=\{r\.webUrl\}/);
    expect(PAY_SHEET).toMatch(/target="_blank"\n\s+rel="noopener noreferrer"/);
  });

  test('the value bound to that href IS the audited web route', () => {
    // `r` is `paymentRoutes(m)` in the row, so this is the real derivation
    // rather than a name this test hoped meant the right thing.
    expect(PAY_SHEET).toMatch(/const r = paymentRoutes\(m\);/);
    for (const m of [VENMO, CASHAPP]) {
      expect(paymentRoutes(m).webUrl).toBe(m.webLink);
    }
  });

  test('the link is named in words, with the handle shown beside it', () => {
    expect(PAY_SHEET).toMatch(/`Pay on \$\{m\.label\}`/);
    expect(PAY_SHEET).toMatch(/\{handle\}/);
    // billing.js is what supplies those words, and it still supplies them.
    expect(BILLING).toMatch(/label: 'Venmo'/);
    expect(BILLING).toMatch(/label: 'Cash App'/);
  });

  test('a method with no destination is a button, never an anchor with a dead href', () => {
    // Zelle. deepLink and webLink are null on purpose, so there is nothing to
    // put in an href; it opens the instructions sheet instead.
    expect(paymentRoutes(ZELLE).webUrl).toBeNull();
    expect(paymentRoutes(ZELLE).actionable).toBe(true);
    expect(PAY_SHEET).toMatch(/return r\.webUrl \? \(/);
    expect(PAY_SHEET).toMatch(/<button className="hit44" type="button" key=\{m\.method\}/);
    expect(PAY_SHEET).toMatch(/`Pay with \$\{m\.label\}`/);
    // And it is not underlined, because an underline that opens no page is a
    // link that lies about where it goes.
    expect(PAY_SHEET).toMatch(/textDecoration: r\.webUrl \? 'underline' : 'none'/);
  });

  test('the glyph beside each row tells the truth about what it does', () => {
    expect(PAY_SHEET).toMatch(
      /r\.webUrl \? Icons\.externalLink\('var\(--text-tertiary\)', 16\) : Icons\.chevronRight\('var\(--text-tertiary\)', 16\)/
    );
  });

  test('every sized icon in the pay sheet clears the 12px legibility floor', () => {
    // Paren-aware to one level of nesting: a bare [^)]* cannot read past the
    // closing paren of a colour like 'var(--text-tertiary)', which is exactly
    // how the sub-12px calls hid from the first sweep in appIconFloorAndAlerts.
    const sizes = [...PAY_SHEET.matchAll(/Icons\.[A-Za-z]+\((?:[^()]|\([^()]*\))*?,\s*(\d+)\)/g)]
      .map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The audited handoff machinery is untouched, and this sheet is where it
//    is reached from
// ═══════════════════════════════════════════════════════════════════════════
describe('the link behaviour is the audited one, unchanged', () => {
  test('both call sites of the handoff live in this sheet', () => {
    // paymentHandoffAndDeepLinks pins the count across the file; this pins
    // that both of them are the two rows above, which is what stops a third
    // surface growing its own copy of the open-the-deep-link line.
    expect(count(APP, /startPaymentHandoff\(/g)).toBe(2);
    expect(count(PAY_SHEET, /startPaymentHandoff\(m, paymentOptions\);/g)).toBe(2);
  });

  test('the anchor suppresses its own navigation so the deep link goes first', () => {
    // Without this the browser follows the href AND the handler opens the
    // wallet, which is two payments' worth of surface for one tap.
    expect(PAY_SHEET).toMatch(/e\.preventDefault\(\);\n\s+startPaymentHandoff\(m, paymentOptions\);/);
  });

  test('nothing here opens a link out of a raw method again', () => {
    expect(PAY_SHEET).not.toMatch(/window\.open\(/);
    expect(PAY_SHEET).not.toMatch(/\.deepLink/);
    expect(PAY_SHEET).not.toMatch(/\.webLink/);
  });

  test('the fallback sheet that catches a failed handoff is still there', () => {
    expect(APP).toMatch(/\{paymentFallback && \(\(\) => \{/);
    expect(APP).toMatch(/onNoHandoff:\s*\(\)\s*=>\s*raise\('no-handoff'\)/);
    expect(APP).toMatch(/onInstructions:\s*\(\)\s*=>\s*raise\('instructions'\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. No handle: a bird, one sentence, and nothing to tap
// ═══════════════════════════════════════════════════════════════════════════
describe('a payee with nothing saved gets a bird and a plain sentence', () => {
  test('the sentence says the true thing, names the three services, and stops', () => {
    expect(PAY_SHEET).toContain(
      '`${payee} has not added a Venmo, Cash App, or Zelle handle.`'
    );
    // A response with no name to interpolate still reads as English.
    expect(PAY_SHEET).toContain(
      "'They have not added a Venmo, Cash App, or Zelle handle.'"
    );
    expect(PAY_SHEET).toMatch(/\{noHandleLine\}/);
  });

  test('the three services named are the three the backend can build', () => {
    // Naming a fourth would be a feature claim; naming two would hide one.
    const built = [...BILLING.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    for (const label of ['Venmo', 'Cash App', 'Zelle']) {
      expect(built).toContain(label);
      expect(PAY_SHEET).toContain(label);
    }
  });

  test('it invents no action, offers no control, and has nothing tappable in it', () => {
    // There is no way to make somebody add a handle from here, so the empty
    // state does not imply one. Nothing in it is a button, a link, or a
    // handler, which is what stops it becoming the dead control it replaced.
    expect(EMPTY_STATE).not.toMatch(/onClick/);
    expect(EMPTY_STATE).not.toMatch(/<button/);
    expect(EMPTY_STATE).not.toMatch(/<a[\s>]/);
    expect(EMPTY_STATE).not.toMatch(/href/);
    expect(EMPTY_STATE).not.toMatch(/cursor: 'pointer'/);
    // And it does not tell the payee's friend to go ask them, or promise a
    // reminder the app has no send for.
    for (const invented of ['Remind', 'remind', 'Ask ', 'Invite', 'Add a handle', 'coming soon']) {
      expect(EMPTY_STATE).not.toContain(invented);
    }
  });

  test('the bird is the still one, above the glyph floor, box reserved', () => {
    expect(EMPTY_STATE).toMatch(/<BirdieStill size=\{64\}/);
    // birdBrandMoments bans a still bird below 40px: the photograph is a
    // smudge down there and that register belongs to Icons.birdie.
    const size = Number(EMPTY_STATE.match(/<BirdieStill size=\{(\d+)\}/)[1]);
    expect(size).toBeGreaterThanOrEqual(40);
    // The animated one is a rAF loop per instance and belongs to the Birdie
    // chat surface only.
    expect(PAY_SHEET).not.toMatch(/<BirdieBird\b/);
  });

  test('that bird really is decorative and really does reserve its box', () => {
    // Rendered for real, at the size the sheet asks for: the sentence beside
    // it carries the meaning, so the images must be alt="" under an
    // aria-hidden wrapper, and the wrapper must be sized before the photos
    // land or the sheet jumps as they arrive.
    const { container } = render(React.createElement(BirdieStill, { size: 64 }));
    const wrap = container.firstChild;
    expect(wrap.getAttribute('aria-hidden')).toBe('true');
    expect(wrap.style.width).toBe('64px');
    expect(wrap.style.height).toBe('64px');
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) expect(img.getAttribute('alt')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Everything about the money is unchanged
// ═══════════════════════════════════════════════════════════════════════════
describe('the sheet still says who, how much, and what for', () => {
  test('the amount and the note survive both states', () => {
    // They are printed above the branch, so an empty-handle payee is still
    // told what they owe.
    const header = PAY_SHEET.slice(0, PAY_SHEET.indexOf('methods.length > 0'));
    expect(header).toContain('${Number(paymentOptions.amount || 0).toFixed(2)}');
    expect(header).toContain('{paymentOptions.note}');
    expect(header).toMatch(/Pay \{payee \|\| 'them'\}<\/h3>/);
  });

  test('the sheet is still a dialog, closable, and inset for the home indicator', () => {
    expect(PAY_SHEET).toMatch(/<DialogBehavior onClose=\{close\} label=\{`Pay \$\{payee \|\| 'them'\}`\}/);
    expect(PAY_SHEET).toMatch(/paddingBottom: 'calc\(20px \+ var\(--safe-bottom\)\)'/);
    expect(PAY_SHEET).toMatch(/>Close<\/button>/);
  });

  test('nothing in the pay sheet uses an em dash', () => {
    // SLOP-AUDIT A2/H18, the standing #1 regression risk on new copy.
    const copyOnly = PAY_SHEET
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
      .join('\n');
    expect(copyOnly).not.toContain('—');
  });

  test('the row is laid out so a long handle cannot push the sheet sideways', () => {
    // 320px is the floor the whole app is checked at (SLOP-AUDIT H19), and a
    // Cash App cashtag can be 50 characters.
    expect(PAY_SHEET).toMatch(/overflowWrap: 'anywhere'/);
    expect(PAY_SHEET).toMatch(/minWidth: 0/);
    expect(PAY_SHEET).toMatch(/flexShrink: 0/);
    expect(count(PAY_SHEET, /boxSizing: 'border-box'/g)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Settle Up: one surface, and no payment recorded that nobody made
// ═══════════════════════════════════════════════════════════════════════════
describe('tapping Settle Up opens the sheet instead of settling anything', () => {
  test('the handler no longer marks the debt paid by itself', () => {
    // The old zero-handle branch called settleShare here, so a payee with no
    // handles turned "Settle Up" into "record this as paid", with no payment
    // and no confirmation.
    expect(SETTLE_UP).not.toMatch(/settleShare\(/);
    expect(SETTLE_UP).not.toMatch(/Marked as settled/);
  });

  test('it opens the one sheet for every payee, however many handles they saved', () => {
    expect(SETTLE_UP).toMatch(/setPaymentOptions\(\{ \.\.\.result, methods \}\);/);
    expect(SETTLE_UP).toMatch(/setShowPaymentPicker\(true\);/);
    expect(count(SETTLE_UP, /setShowPaymentPicker\(true\)/g)).toBe(1);
  });

  test('methods that could do nothing when tapped are still filtered out first', () => {
    expect(SETTLE_UP).toMatch(/\.filter\(\(m\) => paymentRoutes\(m\)\.actionable\)/);
    expect(paymentRoutes({ method: 'venmo', deepLink: null, webLink: null }).actionable).toBe(false);
  });

  test('a failed lookup still never counts as a payment', () => {
    expect(APP).toContain('Could not load payment links. Use "Mark as Paid" after paying.');
  });

  test('marking it paid by hand is still there, as a deliberate separate tap', () => {
    expect(APP).toContain('Mark as Paid (cash or other)');
    const manual = APP.slice(APP.indexOf('Mark as Paid (cash or other)') - 1400, APP.indexOf('Mark as Paid (cash or other)'));
    expect(manual).toMatch(/await settleShare\(selectedFlockId\);/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. An empty-string handle, on both sides of the wire
// ═══════════════════════════════════════════════════════════════════════════
describe('a saved-but-empty handle is not a handle', () => {
  test('the route never builds a method for one', () => {
    // '' is falsy, so these guards are what keep an empty column out of
    // `methods` and put this sheet into its no-handle state instead of
    // rendering "Pay on Venmo" pointing at nobody.
    for (const column of ['venmo_username', 'cashapp_cashtag', 'zelle_identifier']) {
      expect(BILLING).toMatch(new RegExp(`if \\(payer\\.${column}\\) \\{`));
    }
  });

  test('and the sheet refuses to print a handle line with nothing readable in it', () => {
    expect(PAY_SHEET).toMatch(/const readableHandle = \(h\) => \{/);
    expect(PAY_SHEET).toMatch(/return \/\[a-zA-Z0-9\]\/\.test\(t\) \? t : null;/);
    expect(PAY_SHEET).toMatch(/const handle = readableHandle\(m\.handle\);/);
    // The row survives it: the label still names the wallet, so the link is
    // never a naked chevron.
    expect(PAY_SHEET).toMatch(/\{handle && \(/);
  });

  test('and the one field that could store whitespace now trims it', () => {
    // Venmo and Cash App strip whitespace through their character filter
    // already; the Zelle field took anything, and '   ' is truthy to the
    // route, which would build a method whose handle names nobody.
    expect(APP).toMatch(
      /aria-label="Zelle email or phone number"[\s\S]{0,220}transform=\{\(v\) => v\.trim\(\)\.slice\(0, 255\)\}/
    );
    expect(APP).toMatch(/aria-label="Venmo username"[\s\S]{0,220}replace\(\/\[\^a-zA-Z0-9_-\]\/g, ''\)/);
  });

  test('a payee whose name is blank still gets a grammatical sentence', () => {
    expect(PAY_SHEET).toMatch(
      /typeof paymentOptions\.payTo === 'string' && paymentOptions\.payTo\.trim\(\)/
    );
  });
});
