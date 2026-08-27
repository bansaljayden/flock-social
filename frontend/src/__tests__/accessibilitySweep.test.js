/**
 * ACCESSIBILITY SWEEP — the first pass over the app for screen reader,
 * keyboard, contrast and focus, on the screens people actually use.
 *
 * What it pins, and the defect behind each:
 *
 *   1. THE VENUE SEARCH ROW ANNOUNCED AS "REPORT". Every result in the
 *      Discover search dropdown is a rich row: photo, name, rating, distance,
 *      address. It carried aria-label="Report", copy-pasted from the DM
 *      moderation button, and an aria-label REPLACES the content it wraps, so
 *      a screen reader read four identical "Report, button" rows and the venue
 *      names were unreachable. The label is gone; the row names itself.
 *
 *   2. THE TOAST WAS NOT A LIVE REGION IN PRACTICE. It carried role="status"
 *      on the node that `toast &&` creates and destroys with the message, so
 *      every announcement was an element INSERTION rather than a change inside
 *      a region the accessibility tree already knew. VoiceOver, the screen
 *      reader this app ships to, routinely says nothing in that case. Worse,
 *      `const Toast = () =>` lives in the component body, so React re-created
 *      the node on every render and no attribute on it could ever be stable.
 *      The region is now a wrapper in App's own returned tree, which keeps one
 *      DOM node for the session; toasts mutate into it.
 *
 *   3. THE KEYBOARD FOCUS RING WAS INVISIBLE IN DARK MODE. It was a hardcoded
 *      steel navy drawn on navy: 2.49:1 on --bg-primary, 2.04:1 on a card and
 *      1.61:1 on --bg-hover, against the 3:1 WCAG 1.4.11 asks of a focus
 *      indicator. A keyboard user in dark mode could not see where they were.
 *      Both themes now resolve --focus-ring.
 *
 *   4. ACCENT HUES USED AS TEXT. #EF4444 measures 3.76:1 on a white card and
 *      #F59E0B measures 2.15:1, and nearly every inline validation message in
 *      the app was 12px `colors.red`. The palettes gained redText/amberText/
 *      foodText for type, and the saturated keys stay for dots, chips, borders
 *      and bars. `ink` vs `color` on the noise labels is that same split.
 *
 *   5. FORM CONTROLS WITH NO ACCESSIBLE NAME. Display Name, Username and Email
 *      on the profile edit screen had a visible <label> with no htmlFor, no id,
 *      no aria-label and no placeholder, so all three announced as bare "edit
 *      text". Fixed with htmlFor/id, not aria-label, because the visible words
 *      are already the right name.
 *
 *   6. PAYWALLSHEET HAD NO WAY OUT. No role, no label, no focus move, no
 *      Escape, and no close control at all: the only dismissal was a click on
 *      a backdrop div. On a keyboard or with VoiceOver the sheet could not be
 *      left.
 *
 * Source-scanning rather than rendering, matching iconAndAlertSweep.test.js
 * and the rest of this directory: every fact under test is a call-site choice
 * inside a 24,000-line monolith, and jsdom would happily render a control with
 * no name at all.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and about 2,000 lines of what
// this file scans went with it. Nothing asserted below changed. The app source
// is simply in two files, so both are read, in the order they used to be one.
// The flock chat screen left App.js in the same sweep, on the same day
// (screens/ChatDetail.js), and the message list, the composer, the reaction
// row and the report entry went with it. The one-to-one DM thread followed on
// 2026-08-27 (screens/DmDetail.js), carrying the DM composer, the DM vote panel
// and the DM report entry. Same treatment: nothing asserted below changed, the
// app source is simply in more files now, and all of them are read in the order
// they used to be one.
// Three more pieces left App.js on 2026-08-26, in the remount fix: the Edit
// Profile form, the New Message sheet and the confirm-your-email sheet. Each
// was declared inside FlockAppInner's render and mounted as an element, which
// rebuilt its component type on every render and remounted it. Item 5 above is
// about the labels on the Edit Profile form, and that form is one of them, so
// the three files are read here too. Nothing asserted below changed.
// The profile and settings screen (the You tab) left App.js on 2026-08-27 for
// screens/ProfileSettings.js, carrying the safety, blocked-accounts, interests,
// payment and notification rows and their labels. Read here for the same reason.
const app = read('App.js') + read('screens/ChatDetail.js') + read('screens/DmDetail.js') + read('screens/VenueDashboard.js') + read('screens/AddFriends.js')
  + read('screens/ProfileSettings.js')
  + read('components/EditProfileForm.js') + read('components/NewDmModal.js') + read('components/VerifyEmailSheet.js');
const css = read('index.css');
const paywall = read('components/PaywallSheet.js');
const birdieBird = read('components/ui/BirdieBird.js');

// ── Relative luminance / contrast, so the ratios in this file are measured
// rather than remembered. Same formula as WCAG 2.x 1.4.3.
const luminance = (hex) => {
  const c = hex.replace('#', '');
  const channel = (i) => {
    const v = parseInt(c.substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};
const contrast = (fg, bg) => {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

// The surfaces text actually lands on, per theme.
const LIGHT_SURFACES = ['#ffffff', '#f1ede0', '#e8e0d5'];
const DARK_SURFACES = ['#0f172a', '#1e293b', '#1e3a5c'];

describe('the venue search dropdown names its rows', () => {
  it('no row carries the moderation button\'s label', () => {
    // The row is built inside `venueResults.filter(...).slice(0, 4).map(`.
    const rows = app.slice(app.indexOf('venueResults.filter'));
    const row = rows.slice(0, rows.indexOf('key={venue.place_id}') + 400);
    expect(row).not.toMatch(/aria-label="Report"/);
  });

  it('the one real Report button still has its label', () => {
    // Deleting the wrong one would be the obvious way to "fix" this test.
    expect(app).toMatch(/aria-label="Report" className="hit44"[\s\S]{0,160}?setModerationTarget/);
  });
});

describe('the toast is a live region that outlives its message', () => {
  it('the region is a wrapper in the app tree, not the toast node', () => {
    expect(app).toMatch(
      /<div role="status" aria-live=\{toast && toast\.type === 'error' \? 'assertive' : 'polite'\}>\s*<Toast \/>\s*<\/div>/
    );
  });

  it('the toast node itself declares no competing region', () => {
    // Two nested live regions announce twice. The node is created and
    // destroyed with its text, which is exactly what must not be the region.
    const toast = app.slice(app.indexOf('const Toast = () => toast && ('));
    const openingTag = toast.slice(0, toast.indexOf('willChange'));
    expect(openingTag).not.toMatch(/role=/);
    expect(openingTag).not.toMatch(/aria-live=/);
  });

  it('an error toast still has a real exit', () => {
    // Errors never auto-dismiss, so the Dismiss button is the only way out.
    expect(app).toMatch(/aria-label="Dismiss"[\s\S]{0,200}?onClick=\{closeToast\}/);
  });
});

describe('the keyboard focus ring is visible in both themes', () => {
  it('the ring is a token, not a literal', () => {
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--focus-ring\);/);
  });

  it('both themes define --focus-ring', () => {
    const light = css.match(/--focus-ring: rgba\((\d+),(\d+),(\d+),[\d.]+\);/g) || [];
    expect(light.length).toBe(2); // :root and [data-theme="dark"]
  });

  it('each theme\'s ring clears 3:1 on every surface it is drawn on', () => {
    // WCAG 1.4.11: a focus indicator is non-text contrast.
    const lightRing = '#2d5a87';
    const darkRing = '#f1ede0';
    expect(css).toContain('--focus-ring: rgba(45,90,135,0.9)');   // #2d5a87
    expect(css).toContain('--focus-ring: rgba(241,237,224,0.9)'); // #f1ede0
    LIGHT_SURFACES.forEach((bg) => {
      expect(contrast(lightRing, bg)).toBeGreaterThanOrEqual(3);
    });
    DARK_SURFACES.forEach((bg) => {
      expect(contrast(darkRing, bg)).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('accent hues used as text clear the text floor', () => {
  const LIGHT_TEXT = { redText: '#b91c1c', amberText: '#92400e', foodText: '#9a3412' };
  const DARK_TEXT = { redText: '#fca5a5', amberText: '#fbbf24', foodText: '#fb923c' };

  it('the light palette defines the text variants', () => {
    Object.entries(LIGHT_TEXT).forEach(([key, hex]) => {
      expect(app).toMatch(new RegExp(`${key}: '${hex}'`));
    });
  });

  it('the dark palette defines them too', () => {
    Object.entries(DARK_TEXT).forEach(([key, hex]) => {
      expect(app).toMatch(new RegExp(`${key}: '${hex}'`));
    });
  });

  it('every text variant clears 4.5:1 on every surface of its theme', () => {
    Object.values(LIGHT_TEXT).forEach((hex) => {
      LIGHT_SURFACES.forEach((bg) => expect(contrast(hex, bg)).toBeGreaterThanOrEqual(4.5));
    });
    Object.values(DARK_TEXT).forEach((hex) => {
      DARK_SURFACES.forEach((bg) => expect(contrast(hex, bg)).toBeGreaterThanOrEqual(4.5));
    });
  });

  it('the saturated hues they replaced would have failed, which is why they exist', () => {
    // Guards against someone "simplifying" the palette back to one key.
    expect(contrast('#EF4444', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#F59E0B', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#F97316', '#ffffff')).toBeLessThan(4.5);
  });

  it('no bare accent hue is used as a text colour any more', () => {
    // `color: colors.red` survives ONLY inside the { color, ink } objects,
    // where it paints a dot and `ink` paints the word beside it.
    ['red', 'amber', 'food'].forEach((key) => {
      const uses = app.match(new RegExp(`(?<![A-Za-z])color: colors\\.${key}(?![A-Za-z])`, 'g')) || [];
      const paired = app.match(new RegExp(`color: colors\\.${key}, ink: colors\\.${key}Text`, 'g')) || [];
      expect(uses.length).toBe(paired.length);
    });
  });

  it('the noise readouts paint the dot and the word separately', () => {
    expect(app).toMatch(/color: noiseLabel\.ink/);
    expect(app).toMatch(/backgroundColor: noiseLabel\.color/);
  });
});

describe('form controls have a real accessible name', () => {
  // These three had a visible label with no htmlFor, no id, no aria-label and
  // no placeholder, so each announced as an unnamed "edit text".
  const PAIRS = [
    ['profile-name-input', 'Display Name *'],
    ['profile-email-input', 'Email *'],
    ['contact-relationship', 'Relationship (optional)'],
    ['venue-info-name', 'Venue Name'],
    ['venue-info-address', 'Address'],
    ['venue-info-phone', 'Phone'],
    ['promo-time-slot', 'Time Slot'],
    ['promo-days-active', 'Days Active'],
  ];

  PAIRS.forEach(([id, text]) => {
    it(`"${text}" is wired to its control by htmlFor/id`, () => {
      expect(app).toMatch(new RegExp(`htmlFor="${id}"[^>]*>${text.replace(/[*()]/g, '\\$&')}</label>`));
      expect(app).toMatch(new RegExp(`id="${id}"`));
    });
  });

  it('the flock name field is named by its visible label, not over it', () => {
    // It carried BOTH <label>What's the plan?</label> and aria-label="Flock
    // name". The aria-label wins, so the spoken name and the printed one
    // disagreed and voice control could not match the visible words
    // (WCAG 2.5.3 Label in Name).
    expect(app).toMatch(/htmlFor="flock-name-input"/);
    expect(app).not.toMatch(/<SearchInputLocal aria-label="Flock name"/);
    // The error wiring it already had must survive.
    expect(app).toMatch(/aria-invalid=\{flockNameError \? 'true' : undefined\}/);
    expect(app).toMatch(/aria-describedby=\{flockNameError \? 'flock-name-error' : undefined\}/);
  });

  it('repeated hours rows do not all announce the same word', () => {
    ['Days for hours row', 'Opening time for hours row', 'Closing time for hours row', 'Delete hours row']
      .forEach((label) => expect(app).toContain(`${label} \${index + 1}`));
  });
});

describe('icon-only controls on the hot paths are named', () => {
  // A sample across the screens a user cannot avoid: flock chat, DM, Birdie,
  // Discover, the calendar and the profile.
  const HANDLERS = [
    ['setShowNewDmModal(true)', 'New message'],
    ['handleAcceptFlockInvite(f.id)', 'Accept invite'],
    ['handleDeclineFlockInvite(f.id)', 'Decline invite'],
    ['onClick={sendAiMessage}', 'Send'],
    ['shareImageToChat(selectedFlockId)', 'Send photo'],
    ['setShowFlockMenu(!showFlockMenu)', 'More options'],
    ['setShowPicModal(true)', 'Change your profile photo'],
    ['setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))', 'Previous month'],
    ['setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))', 'Next month'],
  ];

  HANDLERS.forEach(([handler, label]) => {
    it(`the control that runs ${handler.slice(0, 34)} announces "${label}"`, () => {
      const at = app.indexOf(handler);
      expect(at).toBeGreaterThan(-1);
      // Walk back to the opening <button and confirm the label rides on it.
      const opening = app.lastIndexOf('<button', at);
      expect(app.slice(opening, at)).toContain(`aria-label="${label}"`);
    });
  });

  // The nine cases above are a hand-written list, and a hand-written list is
  // exactly as good as whoever last edited it. It named Birdie's Send button
  // and not the flock chat one, so `onClick={sendChatMessage}` could lose its
  // aria-label with all 1,666 assertions still green. This derives the set
  // instead of naming it.
  //
  // The rule is deliberately narrow so it has no false positives: a <button>
  // whose ENTIRE child is one Icons.* call renders a glyph and nothing else,
  // so its accessible name can only come from an attribute. Buttons that mix
  // an icon with text are not in scope here; they name themselves.
  const iconOnlyButtons = (() => {
    const BACKSLASH = String.fromCharCode(92);
    // Find the '>' that closes an opening <button tag, skipping any '>' that
    // is inside a JSX expression (`(e) => ...`) or a string.
    const openTagEnd = (s, i) => {
      let depth = 0;
      for (let j = i + '<button'.length; j < s.length; j += 1) {
        const c = s[j];
        if (c === '{') { depth += 1; continue; }
        if (c === '}') { depth -= 1; continue; }
        if (c === "'" || c === '"' || c === '`') {
          const quote = c;
          j += 1;
          while (j < s.length) {
            if (s[j] === BACKSLASH) { j += 2; continue; }
            if (s[j] === quote) break;
            j += 1;
          }
          continue;
        }
        if (c === '>' && depth === 0) return j;
      }
      return -1;
    };
    const found = [];
    let i = 0;
    while ((i = app.indexOf('<button', i)) !== -1) {
      const end = openTagEnd(app, i);
      if (end === -1) { i += '<button'.length; break; }
      const attrs = app.slice(i, end);
      const close = app.indexOf('</button>', end);
      const inner = close === -1 ? '' : app.slice(end + 1, close);
      const line = app.slice(0, i).split('\n').length;
      i = end + 1;
      // One Icons.* call, alone, allowing one level of nested parens for
      // arguments like `colors.navy` or a ternary.
      if (!/^\s*\{Icons\.\w+\((?:[^()]|\([^()]*\))*\)\}\s*$/.test(inner)) continue;
      found.push({ line, attrs: attrs.replace(/\s+/g, ' ') });
    }
    return found;
  })();

  it('the scan finds the icon-only buttons rather than an empty set', () => {
    // Without this, every assertion below passes on a scan that matched
    // nothing, which is how a sweep survives the code moving out from under
    // it. 90 at the time of writing across App.js and the three screens.
    expect(iconOnlyButtons.length).toBeGreaterThan(70);
  });

  it('every button whose only child is an icon carries a name', () => {
    const unnamed = iconOnlyButtons
      .filter((b) => !/aria-label|aria-labelledby/.test(b.attrs))
      .map((b) => `line ${b.line}: ${b.attrs.slice(0, 140)}`);
    expect(unnamed).toEqual([]);
  });

  it('the three "Features" toggles keep a name when they collapse to an X', () => {
    // Each renders the word "Features" when closed and a bare Icons.x when
    // open, so the name vanished exactly when the control mattered.
    ['chatNavOpen', 'dmNavOpen', 'discoverNavOpen'].forEach((state) => {
      expect(app).toContain(`aria-label="Features" aria-expanded={${state}}`);
    });
  });

  it('state toggles say which state they are in', () => {
    expect(app).toMatch(/aria-label=\{isPinned \? 'Unpin' : 'Pin'\} aria-pressed=\{isPinned\}/);
    expect(app).toMatch(/aria-pressed=\{sharingLocationForFlock === flock\.id\}/);
  });

  it('emoji reaction buttons do not rely on the glyph as their name', () => {
    // A lone emoji is announced inconsistently and sometimes not at all.
    expect(app).toContain('aria-label={`React with ${r}`}');
    expect(app).toContain('aria-label={`React with ${emoji}`}');
  });

  it('labels copy-pasted from other controls are gone', () => {
    // The cash pool stepper wore the map zoom buttons' labels, and the venue
    // detail CTA said "Back" while printing "Add to Flock".
    // The two cash-pool stepper labels that used to be asserted here left
    // with the DM cash pool itself (2026-08-27): the pool was client-only
    // theater with no backend, so the whole control came out rather than
    // keep claiming a feature that did not exist.
    expect(app).not.toMatch(/aria-label="Zoom out" className="hit44 glass-btn/);
    expect(app).not.toMatch(/aria-label="Back" onClick=\{\(e\) => \{ confirmClick\(e\);/);
  });

  it('"Close" is not used for controls that clear or remove', () => {
    expect(app).not.toMatch(/aria-label="Close"[^>]*setDmChatSearch\(''\)/);
    expect(app).not.toMatch(/aria-label="Close"[^>]*setFlockFriends\(prev/);
    expect(app).toMatch(/aria-label=\{`Remove \$\{f\.name\}`\}/);
  });
});

describe('controls that open the paywall are reachable by keyboard', () => {
  it('the forecast teasers are buttons, not clickable spans', () => {
    const spans = app.match(/<span onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(!venueOwnerView\) setPaywallTrigger/g) || [];
    expect(spans.length).toBe(0);
    const buttons = app.match(/<button type="button" onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(!venueOwnerView\) setPaywallTrigger/g) || [];
    expect(buttons.length).toBe(3);
  });
});

describe('PaywallSheet can be left without a pointer', () => {
  it('announces itself as a modal dialog', () => {
    expect(paywall).toMatch(/role="dialog"/);
    expect(paywall).toMatch(/aria-modal="true"/);
    expect(paywall).toMatch(/aria-label="Flock Pro"/);
  });

  it('Escape closes it, but never mid-purchase', () => {
    expect(paywall).toMatch(/if \(e\.key !== 'Escape'\) return;/);
    expect(paywall).toMatch(/e\.stopImmediatePropagation\(\);/);
    expect(paywall).toMatch(/if \(!busy && !restoring\) onClose\?\.\(\);/);
  });

  it('focus moves into the sheet when it opens', () => {
    expect(paywall).toMatch(/sheetRef\.current\?\.querySelector\('button'\)/);
    expect(paywall).toMatch(/ref=\{sheetRef\}/);
  });

  it('has a real close control, not just a backdrop and a drag handle', () => {
    expect(paywall).toMatch(/aria-label="Close"/);
    // The handle is paint: it must not pretend to be the exit.
    expect(paywall).toMatch(/<div aria-hidden="true" style=\{\{ width: '38px', height: '4px'/);
  });
});

describe('states that arrive on their own announce themselves', () => {
  it('BirdNote takes an opt-in role so error states can be regions', () => {
    expect(birdieBird).toMatch(/^\s*role,$/m);
    expect((birdieBird.match(/<div role=\{role\}/g) || []).length).toBe(2);
  });

  it('the three BirdNote error states use it', () => {
    ['pastFlocksError', 'flockInviteFriendsError', 'blockedError'].forEach((state) => {
      expect(app).toMatch(new RegExp(`role="alert"\\s*\\n\\s*title=\\{${state}\\}`));
    });
  });

  it('a chat send that times out is announced, not just drawn', () => {
    // The failure lands eight seconds later with no keypress behind it.
    const wraps = app.match(/<div role="alert">\s*\{\/\* role="alert" on a wrapper/g) || [];
    expect(wraps.length).toBe(2); // flock chat and DM
    expect(app).toMatch(/role="alert"[\s\S]{0,700}?retryFailedDm/);
    expect(app).toMatch(/role="alert"[\s\S]{0,700}?retryFailedMessage/);
  });

  it('a saved profile says so', () => {
    expect(app).toMatch(/<div role="status"[^>]*>\{editSuccess\}<\/div>/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECOND PASS, 2026-08-26: THINGS THAT ARE INVISIBLE AND STILL IN THE TREE.

   Everything above this line is about what a control is CALLED. This block is
   about whether a control is THERE, which turned out to be the larger problem
   and the one no amount of aria-label work fixes.

   Four defects, all of the same shape: a surface hides itself with a property
   that stops paint and does nothing to focus.

     A. THREE HEADER NAVS COLLAPSE BY ANIMATING TO ZERO WIDTH. The flock chat,
        the DM thread and Discover each hide a group of controls behind a
        "Features" pill by putting `maxWidth: 0` and `overflow: hidden` on
        their container. That paints nothing, and it leaves every button
        inside focusable and readable. Tab out of the flock chat's back arrow
        landed on "Vote on a venue", "Invite friends", "Search messages" and
        "Group cash pool", four controls zero pixels wide, before it reached
        anything on screen.

     B. DISCOVER'S LIVE EVENTS PANEL PARKS OFF THE RIGHT EDGE. Closed, it sits
        at `translateX(100%)` behind `pointerEvents: 'none'` and a negative
        z-index. Those stop a finger. Tab walked into its back arrow and its
        "Search events" box anyway, both of them past the right edge of the
        phone, and focusing them scrolled the whole app sideways.

     C. THE TWO TYPING INDICATORS FADE TO `opacity: 0` AND KEEP THEIR TEXT.
        A quiet chat still carried "Someone" and a bubble in the accessibility
        tree at the bottom of the message list.

     D. SEVEN OVERLAYS HAD NO DIALOG BEHAVIOUR AT ALL, the venue detail card
        among them, which is the busiest overlay in the product. No focus
        move, no Escape, no trap: the card covered the screen and Tab walked
        around the map underneath it.

   THE FIX IS `visibility`, AND THE OPEN STATE MUST BE `undefined`.
   `visibility` is the one property that takes a subtree out of the tab order
   and out of the accessibility tree while leaving layout alone. It also
   INHERITS, and an explicit `visible` on a child BEATS a `hidden` ancestor.
   The first version of this fix wrote `'visible'` for the open state, and
   because the whole Discover screen is held at `visibility: hidden` while
   another tab is on screen, that put three Discover buttons into the tab
   order of every other screen in the app. Hence the test below that allows
   exactly one explicit open state in the codebase: the screen container that
   has no hidden ancestor to fight with.

   ON COMMENTS. Every scan below reads a comment-stripped copy of the source,
   built from @babel/parser's own comment ranges rather than from a regex.
   This file's prose quotes those style properties several times; a scan that
   cannot tell code from comment would read this very paragraph as a
   violation, or worse, as a pass.

   ON EMPTY RESULTS. Each derived scan asserts a floor on how much it found
   before it asserts anything about the contents. A scan that matches nothing
   returns an empty array, and an empty array passes every "none of these are
   broken" assertion ever written.
   ═══════════════════════════════════════════════════════════════════════════ */

const parser = require('@babel/parser');

/** The same source, with every comment blanked out. */
const stripComments = (src) => {
  const ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  const chars = src.split('');
  (ast.comments || []).forEach((c) => {
    for (let i = c.start; i < c.end; i += 1) chars[i] = ' ';
  });
  return chars.join('');
};

const APP_FILES = [
  'App.js', 'screens/ChatDetail.js', 'screens/DmDetail.js', 'screens/VenueDashboard.js', 'screens/AddFriends.js',
  'screens/ProfileSettings.js',
  'components/EditProfileForm.js', 'components/NewDmModal.js', 'components/VerifyEmailSheet.js',
];
const code = APP_FILES.map((f) => stripComments(read(f))).join('\n');

/** The `style={{ ... }}` object an offset sits inside. */
const styleAround = (s, i) => {
  const start = s.lastIndexOf('style={{', i);
  if (start === -1) return null;
  const end = s.indexOf('}}', i);
  if (end === -1) return null;
  return s.slice(start, end + 2);
};

describe('a container that hides its contents hides them from the keyboard too', () => {
  // Every style that clips its children and fades them out: the three header
  // navs and the two typing indicators. Derived, not listed, so a fourth one
  // added tomorrow is held to the same rule on the day it is written.
  const collapsers = (() => {
    const found = [];
    const re = /overflow: 'hidden'[^\n]*?opacity: (\w+) \? 1 : 0/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const style = styleAround(code, m.index);
      if (!style) continue;
      found.push({ state: m[1], style });
    }
    return found;
  })();

  it('the scan finds the collapsing containers rather than an empty set', () => {
    // Five when this was written: chatNavOpen, dmNavOpen, discoverNavOpen and
    // the two typing indicators. Without this floor every assertion below
    // passes on nothing the moment the pattern is written differently.
    expect(collapsers.length).toBeGreaterThanOrEqual(5);
    expect(collapsers.map((c) => c.state).sort())
      .toEqual(['chatNavOpen', 'discoverNavOpen', 'dmIsTyping', 'dmNavOpen', 'isTyping']);
  });

  it('each one toggles visibility on the same state it fades on', () => {
    const missing = collapsers
      .filter((c) => !c.style.includes(`visibility: ${c.state} ? undefined : 'hidden'`))
      .map((c) => `${c.state}: ${c.style.replace(/\s+/g, ' ').slice(0, 150)}`);
    expect(missing).toEqual([]);
  });

  it('the collapse still animates, so the fix did not just delete the transition', () => {
    // A `visibility` change is not animatable, so it is delayed out and
    // instant in. Without the delay the group vanishes before it has slid.
    collapsers.forEach((c) => {
      expect(c.style).toMatch(
        new RegExp(`visibility 0s linear \\$\\{${c.state} \\? '0s' : '[0-9.]+s'\\}`),
      );
    });
  });

  it('the open state is `undefined` everywhere but the one place it cannot be', () => {
    // `visibility` inherits and an explicit open state on a child overrides a
    // hidden ancestor. The ONE legitimate use is the Discover screen's own
    // container, which is a child of the app shell with nothing above it
    // holding it hidden. Every other toggle must leave the property unset so
    // the ancestor wins.
    const explicit = code.match(/visibility: \w+ \? 'visible'/g) || [];
    expect(explicit).toEqual(["visibility: isExploreVisible ? 'visible'"]);
  });
});

describe('the parked events panel is hidden, not merely un-clickable', () => {
  it('the closed panel leaves the tab order', () => {
    const at = code.indexOf('zIndex: showEventsView ? 45 : -1');
    expect(at).toBeGreaterThan(-1);
    const style = styleAround(code, at);
    expect(style).toContain("pointerEvents: showEventsView ? 'auto' : 'none'");
    expect(style).toContain("visibility: showEventsView ? undefined : 'hidden'");
  });

  it('it can still be left with a key while it is open', () => {
    // Conditional on purpose: the wrapper is mounted for the whole session,
    // so an unconditional marker would grab focus at app start.
    expect(code).toContain('{showEventsView && <DialogBehavior modal={false}');
  });
});

describe('every overlay that covers the app manages focus', () => {
  // A full-bleed positioned container at a stacking level that puts it over
  // the product, holding something focusable. Derived rather than listed: the
  // seven that were missing had all been added after the last hand-written
  // list was.
  const OFFLINE_GATE = "zIndex: 99999, backgroundColor: '#16283d'";
  const overlays = (() => {
    const re = /style=\{\{ ?position: '(?:fixed|absolute)',[^\n]*?(?:inset: 0|top: 0, left: 0, right: 0, bottom: 0)[^\n]*/g;
    const found = [];
    let m;
    while ((m = re.exec(code)) !== null) {
      const head = m[0];
      const zi = /zIndex: ([^,}]+)/.exec(head);
      const ziText = zi ? zi[1].trim() : '';
      const ziNum = Number(ziText);
      // A stateful z-index is an overlay that opens and closes. A literal one
      // below 40 is paint: a gradient scrim, a photo wash, a focus ring.
      if (!(ziText.includes('?') || (Number.isFinite(ziNum) && ziNum >= 40))) continue;
      // A childless <div ... /> is a dismiss scrim. It has an onClick and
      // nothing to focus, and wrapping it in a dialog would be wrong.
      const tail = code.slice(m.index + head.length - 20, m.index + head.length + 8);
      if (/\}\}\s*\/>/.test(tail)) continue;
      const body = code.slice(m.index, m.index + 3200);
      if (!/<button|<input|<textarea|<a href|<SearchInputLocal/.test(body)) continue;
      found.push({
        head: head.replace(/\s+/g, ' ').slice(0, 130),
        hasDialog: /<DialogBehavior/.test(code.slice(Math.max(0, m.index - 400), m.index + 3200)),
        isOfflineGate: head.includes(OFFLINE_GATE),
      });
    }
    return found;
  })();

  it('the scan finds the overlays rather than an empty set', () => {
    // 37 when this was written. The number moves; the floor is here so a
    // refactor of how overlays are declared shows up as a failure rather than
    // as a silently empty scan.
    expect(overlays.length).toBeGreaterThanOrEqual(30);
  });

  it('each one carries a DialogBehavior, or is the offline gate', () => {
    // OfflineGate is the single exception and it is not an overlay: it
    // REPLACES the app when the network is gone. There is nothing behind it
    // to trap focus away from and nothing to return focus to.
    const missing = overlays.filter((o) => !o.hasDialog && !o.isOfflineGate).map((o) => o.head);
    expect(missing).toEqual([]);
  });

  it('the offline gate really is in the set, so the exception is not a dead branch', () => {
    expect(overlays.filter((o) => o.isOfflineGate).length).toBe(1);
  });

  it('the seven added in this pass are named, so a revert is loud', () => {
    [
      'onClose={closeVenueDetail}',                        // the venue detail card
      'onClose={() => setEventDetail(null)}',              // the event detail screen
      "label={editingContact ? 'Edit contact' : 'Add trusted contact'}",
      'label="Crop photo"',
      'label="Send this photo"',
      'label="Share this venue"',
      'modal={false} onClose={() => setShowSearchResults(false)}',
    ].forEach((anchor) => expect(code).toContain(anchor));
  });
});

describe('DialogBehavior hands focus back to something that can take it', () => {
  const dialog = code.slice(
    code.indexOf('const FOCUSABLE_SELECTOR'),
    code.indexOf('SOS LOCATION TIMING'),
  );

  it('the slice under test is the helper and not an empty string', () => {
    expect(dialog.length).toBeGreaterThan(2000);
    expect(dialog).toContain('const DialogBehavior = ');
  });

  it('focusability is judged on computed visibility, not on the box', () => {
    // This is the bug the whole section exists for. An element under a hidden
    // ancestor keeps its width, its height and its client rects. A box-only
    // test therefore calls it focusable, `.focus()` on it is a silent no-op,
    // and focus is left on the document body.
    expect(dialog).toMatch(/const isFocusable = /);
    expect(dialog).toMatch(/cs\.visibility === 'hidden'/);
    expect(dialog).toMatch(/cs\.display === 'none'/);
  });

  it('the Tab trap uses the same test as the focus restore', () => {
    // Two different answers to "can this take focus" is how a trap ends up
    // cycling onto a control nobody can reach.
    expect(dialog).toMatch(/\.filter\(\(el\) => isFocusable\(el\) \|\| el === document\.activeElement\)/);
  });

  it('a restore onto the document body is refused rather than counted as success', () => {
    expect(dialog).toMatch(/if \(!restoreTo \|\| restoreTo === document\.body\) return;/);
  });

  it('when the opener has hidden itself, focus goes to what replaced it', () => {
    // "Vote on a venue" collapses the header nav on its way to opening the
    // sheet, so by the time the sheet closes the opener is inside a hidden
    // group. The walk finds the nearest ancestor still on screen and focuses
    // the first control in it, which is the Features pill standing where the
    // opener was.
    expect(dialog).toMatch(/let hop = restoreTo\.parentElement;/);
    expect(dialog).toMatch(/const near = Array\.from\(hop\.querySelectorAll\(FOCUSABLE_SELECTOR\)\)\.find\(isFocusable\);/);
  });

  it('the element that last held focus is remembered before the browser drops it', () => {
    // A control that hides itself is blurred by the browser during the same
    // commit that opens the sheet, so `document.activeElement` is already the
    // document body by the time the effect runs.
    expect(code).toMatch(/let lastFocusedElement = null;/);
    expect(code).toMatch(/document\.addEventListener\('focusin'/);
    expect(dialog).toMatch(/lastFocusedElement && !node\.contains\(lastFocusedElement\)/);
  });

  it('the cleanup still calls it, so the helper is not orphaned', () => {
    expect(dialog).toMatch(/restoreFocusTo\(restoreTo\);/);
  });
});

describe('reduce motion reaches the animations CSS cannot see', () => {
  it('the CSS half is still there', () => {
    // Collapses every CSS animation and transition in the app. It is the half
    // that has been right all along, and it reaches none of framer-motion.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{/);
    expect(css).toMatch(/animation-duration: 0\.001ms !important;/);
    expect(css).toMatch(/transition-duration: 0\.01ms !important;/);
  });

  it('framer-motion is told to follow the OS setting', () => {
    // framer-motion writes inline styles frame by frame from JavaScript, so
    // no CSS animation and no CSS transition exists for the media query above
    // to shorten. Without this the Discover venue card still slides and
    // scales in on delays past a second for somebody who asked it not to.
    // The import is the lean one: `m` plus LazyMotion with domAnimation, not
    // the full `motion` component, so a regression back to the heavy bundle
    // fails this line as well as the wrapper assertion below.
    expect(code).toMatch(/import \{ m, AnimatePresence, MotionConfig, LazyMotion, domAnimation \} from 'framer-motion';/);
    expect(code).toMatch(/<MotionConfig reducedMotion="user">/);
  });

  it('the m component is loaded through LazyMotion with only domAnimation', () => {
    // The full `motion` component bundles drag, pan, layout and every gesture
    // into the boot chunk. This app animates opacity and transform on mount
    // and exit and nothing else, so it ships `m` with the domAnimation feature
    // set instead. `strict` makes a stray `motion` component throw rather than
    // silently pulling the full set back in, which is what defends the saving.
    expect(code).toMatch(/<LazyMotion features=\{domAnimation\} strict>/);
    expect(code).not.toMatch(/import \{[^}]*\bmotion\b[^}]*\} from 'framer-motion'/);
  });

  it('it wraps the app rather than one screen', () => {
    // A provider below the root reaches only what is under it, and motion
    // components are added in this file all the time.
    const providers = code.slice(code.indexOf('const FlockAppWithProviders'));
    const block = providers.slice(0, providers.indexOf('export default'));
    expect(block).toMatch(/<MotionConfig reducedMotion="user">[\s\S]*<FlockApp \/>[\s\S]*<\/MotionConfig>/);
  });

  it('it is "user", not "always" or "never"', () => {
    // "always" would strip motion from people who never asked, and "never"
    // is the bug. There must be exactly one declaration and it follows the OS.
    const all = code.match(/reducedMotion="\w+"/g) || [];
    expect(all).toEqual(['reducedMotion="user"']);
  });
});
