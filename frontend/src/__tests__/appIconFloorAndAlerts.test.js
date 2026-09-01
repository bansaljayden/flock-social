/**
 * ICON FLOOR + DESTRUCTIVE-FLOW ALERTS — the 2026-08 App.js handoff fixes,
 * locked shut.
 *
 * Three things shipped together and each is a thing an edit can silently
 * reintroduce:
 *
 *   1. TWO HAND-ROLLED STAR RATINGS never went through the icon system. The
 *      create-screen one reused id="halfStar" on every instance (duplicate DOM
 *      ids) and was five aria-hidden glyphs a screen reader skipped entirely;
 *      the post-hangout feedback one was five rating BUTTONS with no names and
 *      no pressed state. Both now draw Icons.star / Icons.starFilled and are
 *      announced.
 *
 *   2. ~20 ICON CALLS SAT BELOW THE 12px LEGIBILITY FLOOR (as small as 9px —
 *      a ballot-box glyph whose interior check is invisible at that size).
 *      The floor is asserted here for EVERY sized call in App.js, so the next
 *      sub-12 call fails the day it lands, not the next audit.
 *
 *   3. THE deleteNeedsReauth PANEL answers a server 403 in the account
 *      DELETION flow and was shown but never announced, while its deleteError
 *      sibling had role="alert". Both now converge on the auth screens'
 *      AuthError pattern: role="alert" + tabIndex -1 + programmatic focus.
 *
 * Source-scanning, not rendering: every fact under test is a call-site CHOICE
 * in a 16,500-line monolith, and jsdom would happily render a 9px icon.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

// The flock chat screen left App.js on 2026-08-26: it lives in
// screens/ChatDetail.js now, and the message list, the composer, the reaction
// row and the report entry went with it. Nothing asserted below changed. The
// app source is simply in two files, so both are read, in the order they used
// to be one.
// The profile and settings screen (the You tab) left App.js on 2026-08-27 for
// screens/ProfileSettings.js, carrying its sized icon calls, so it is read too.
// The flock plan detail screen left on 2026-09-01 for screens/FlockDetail.js,
// carrying its own sized icon calls, so it is read too.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'AddFriends.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'FlockDetail.js'), 'utf8');

/** Comment lines dropped, so prose naming a retired pattern cannot fail the
 *  test the fix was written to pass (same exclusion, and same reason, as
 *  socketRoomRejoin.test.js). */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

/** Every Icons.<name>(...) call with its arguments, paren-balanced. A plain
 *  regex cannot read the size argument past a colour like
 *  'var(--accent-purple-text)', which is exactly how the 9px calls hid from
 *  the first sweep. */
function iconCalls(src) {
  const out = [];
  const re = /Icons\.([A-Za-z]+)\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < src.length) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    const args = src.slice(re.lastIndex, i - 1);
    // Split on top-level commas only.
    const parts = [];
    let d = 0;
    let cur = '';
    for (const c of args) {
      if ('([{'.includes(c)) d += 1;
      else if (')]}'.includes(c)) d -= 1;
      if (c === ',' && d === 0) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    parts.push(cur.trim());
    out.push({
      name: m[1],
      size: parts[1],
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

describe('the 12px icon legibility floor holds across every call in App.js', () => {
  const sized = iconCalls(APP).filter((c) => /^\d+$/.test(c.size || ''));

  it('reads a plausible number of sized calls out of the source', () => {
    // ~300 icon calls ship today; if this collapses the scanner broke, and a
    // broken scanner asserting nothing must not look like a pass.
    expect(sized.length).toBeGreaterThan(150);
  });

  it('no icon is drawn below 12px', () => {
    // 21 calls sat below the floor on 2026-08-14, the smallest at 9px inside
    // the flock-list status chip. Failure prints every offender with its line.
    const tooSmall = sized.filter((c) => Number(c.size) < 12);
    expect(tooSmall).toEqual([]);
  });
});

describe('no hand-rolled star rating survives outside the icon system', () => {
  it('the two inline-SVG star drawings are gone from the code', () => {
    const code = codeOnly(APP);
    // The create-screen path ('M12 2l3.09...') and the feedback polygon
    // ('12 2 15.09...') shared these opening coordinates; nothing else does.
    expect(code).not.toContain('M12 2l3.09');
    expect(code).not.toContain('points="12 2 15.09');
    // The gradient id that duplicated across instances.
    expect(code).not.toContain('id="halfStar"');
  });

  it('the create-screen StarRating is the labelled system row', () => {
    const i = APP.indexOf('const StarRating = ({ rating })');
    expect(i).toBeGreaterThan(-1);
    const fn = APP.slice(i, i + 700);
    expect(fn).toMatch(/role="img" aria-label=\{`\$\{rating\} out of 5 stars`\}/);
    expect(fn).toMatch(/Icons\.starFilled\(colors\.amber, 12\)/);
    // Empty stars on the readable token, not colors.disabled (1.2:1, the
    // invisible-empty-star defect the review lists already fixed).
    expect(fn).toMatch(/Icons\.star\('var\(--star-empty\)', 12\)/);
  });

  it('the post-hangout feedback stars are named, pressed, system-drawn inputs', () => {
    const i = APP.indexOf('Rate it (optional)');
    expect(i).toBeGreaterThan(-1);
    const block = APP.slice(i, i + 1400);
    // Each button names its number: five buttons all reading "Rate" give a
    // screen reader nothing to pick between.
    expect(block).toMatch(/aria-label=\{`Rate \$\{star\} star\$\{star === 1 \? '' : 's'\}`\}/);
    expect(block).toMatch(/aria-pressed=\{feedbackState\.rating === star\}/);
    expect(block).toMatch(/Icons\.starFilled\(colors\.amber, 22\)/);
    // An INPUT's empty star must read as an outline to aim at, so it uses
    // --text-tertiary like the venue review form, not --star-empty.
    expect(block).toMatch(/Icons\.star\('var\(--text-tertiary\)', 22\)/);
    expect(block).not.toContain('<svg');
  });

  it('the map card rating leads with a star, not the party popper', () => {
    // Icons.party sat where every other rating chip draws starFilled; a
    // popper next to "4.6" says nothing about what the number is.
    const i = APP.indexOf('activeVenue.stars != null');
    expect(i).toBeGreaterThan(-1);
    expect(codeOnly(APP.slice(i, i + 700))).toMatch(/Icons\.starFilled\(/);
    expect(codeOnly(APP.slice(i, i + 700))).not.toMatch(/Icons\.party\(/);
  });
});

describe('the delete-account refusals are announced and take focus', () => {
  // The dialog body: from the heading to the action row.
  const dialog = APP.slice(
    APP.indexOf('Delete your account?'),
    APP.indexOf('{deletingAccount ? ', APP.indexOf('Delete your account?'))
  );

  it('the reauth panel is an alert, focusable, and wired to the shared ref', () => {
    // This panel answers a server 403 in a DESTRUCTIVE flow. Without the role
    // a screen-reader user heard the Delete button go dead and nothing else.
    expect(dialog).toMatch(
      /\{deleteNeedsReauth && \([\s\S]{0,200}?<div role="alert" tabIndex=\{-1\} ref=\{deleteAlertRef\}/
    );
  });

  it('the error line carries the same contract', () => {
    expect(dialog).toMatch(
      /\{deleteError && !deleteNeedsReauth && \([\s\S]{0,100}?<p role="alert" tabIndex=\{-1\} ref=\{deleteAlertRef\}/
    );
  });

  it('focus moves to whichever refusal renders, the AuthError pattern', () => {
    // Same doctrine as components/auth/AuthShell.js AuthError: role="alert"
    // announces, focus() lands the keyboard user on the message (and scrolls
    // it into view). The effect must watch BOTH states or one refusal
    // announces and the other strands the user on a disabled button.
    const i = APP.indexOf('const deleteAlertRef = useRef(null)');
    expect(i).toBeGreaterThan(-1);
    const effect = APP.slice(i, i + 500);
    expect(effect).toMatch(
      /if \(\(deleteError \|\| deleteNeedsReauth\) && deleteAlertRef\.current\) deleteAlertRef\.current\.focus\(\)/
    );
    expect(effect).toMatch(/\[deleteError, deleteNeedsReauth\]/);
  });
});

describe('small affordance fixes in the swept regions', () => {
  it('the budget bar discloses forward with chevronRight, not arrowLeft', () => {
    // The row opens a sheet; a LEFT-pointing arrow at its right edge promised
    // back-navigation on a forward control.
    const i = APP.indexOf('aria-label="Open group cash pool"');
    expect(i).toBeGreaterThan(-1);
    // The window runs to the row's own closing brace (the Ghost Mode card
    // that follows it), so the chevron at the row's far edge is inside it.
    const end = APP.indexOf('Ghost Mode Card', i);
    expect(end).toBeGreaterThan(i);
    const row = codeOnly(APP.slice(i, end));
    expect(row).toMatch(/Icons\.chevronRight\(/);
    expect(row).not.toMatch(/Icons\.arrowLeft\(/);
  });

  it('photo-less search cards say the crowd label once, not twice', () => {
    // The photo-less chip prints "{label} {score}%"; the clock line printed
    // the same label again three words later on the same row.
    const i = APP.indexOf('{crowdLabel && (venue.photo_url || crowdScore == null) && (');
    expect(i).toBeGreaterThan(-1);
  });
});
