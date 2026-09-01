/**
 * ICON AND ALERT SWEEP — the follow-up pass after appIconFloorAndAlerts.test.js.
 *
 * That first pass converted the two hand-rolled star RATING WIDGETS and raised
 * 21 icon calls to the 12px floor. This sweep caught what it missed:
 *
 *   1. THREE RAW STAR GLYPHS (the ★ character) still rendered ratings outside
 *      the icon system: the MapLibre marker label (an innerHTML string JSX
 *      cannot reach) and the two "Popular Chains Nearby" venue rows. The map
 *      label now draws starSvgString() from components/ui/Icons.js, which is
 *      built from the same STAR_D geometry as Icons.star / Icons.starFilled;
 *      the venue rows draw Icons.starFilled directly.
 *
 *   2. ONE HAND-ROLLED 11px INLINE SVG survived in the DM header's "sharing
 *      location" status: a Lucide-teardrop map pin that matched neither the
 *      system's pin drawing nor the 12px floor. It is now Icons.mapPin at 12.
 *
 *   3. The deleteNeedsReauth panel's role="alert" contract (fixed in the first
 *      pass) is re-pinned here so this suite stands alone.
 *
 * Source-scanning, not rendering, for the same reason as the first pass: every
 * fact under test is a call-site choice in a 16,500-line monolith, and jsdom
 * would happily render a raw ★ or a 9px icon.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

// Six screens left App.js for src/screens/: the flock chat and the venue
// dashboard and Add Friends on 2026-08-26, the one-to-one DM thread and the
// profile and settings screen on 2026-08-27, and the flock plan detail
// screen on 2026-09-01. The message lists, the composers,
// the reaction rows, the report entries, the DM vote panel and the whole You-tab
// settings list went with them. Nothing asserted below changed. The app source
// is simply in several files now, so all of them are read, in the order they
// used to be one.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'AddFriends.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'FlockDetail.js'), 'utf8');
const ICONS = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'ui', 'Icons.js'),
  'utf8'
);

/** Comment lines dropped, so prose naming a retired pattern cannot fail the
 *  test the fix was written to pass. */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

/** Every Icons.<name>(...) call with its arguments, paren-balanced, because a
 *  plain regex cannot read a size past a colour like 'var(--star-empty)'. */
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

describe('no raw star glyph renders a rating anywhere in App.js', () => {
  it('the star characters are gone from the source entirely', () => {
    // ★ in an innerHTML string, ☆ or ⭐ anywhere: a glyph star inherits the
    // label font, ignores the icon system's geometry, and is invisible to the
    // starFilled swap animation. Comments included on purpose; there is no
    // reason for the character to exist in this file at all.
    for (const glyph of ['★', '☆', '⭐', '✮', '✭', '✩']) {
      expect(APP).not.toContain(glyph);
    }
  });

  it('the MapLibre marker label draws the system star string', () => {
    const i = APP.indexOf("label.className = 'mlb-marker-label'");
    expect(i).toBeGreaterThan(-1);
    const block = codeOnly(APP.slice(i, i + 700));
    expect(block).toContain('starSvgString(12)');
    // And the import actually reaches it.
    expect(APP).toContain("import Icons, { starSvgString } from './components/ui/Icons'");
  });

  it('starSvgString is the same drawing as Icons.star, not a second star', () => {
    // One STAR_D, three consumers: star, starFilled, and the string form. If
    // the helper ever stops referencing STAR_D it has forked the geometry.
    const i = ICONS.indexOf('const starSvgString');
    expect(i).toBeGreaterThan(-1);
    const helper = ICONS.slice(i, i + 700);
    expect(helper).toContain('${STAR_D}');
    // Modernized geometry standard: round caps and joins, size-derived stroke.
    expect(helper).toContain('stroke-linecap="round"');
    expect(helper).toContain('stroke-linejoin="round"');
    expect(helper).toContain('${sw(size)}');
    // Decorative in the label, like every icon beside a printed number.
    expect(helper).toContain('aria-hidden="true"');
    expect(ICONS).toMatch(/export \{[^}]*starSvgString[^}]*\}/);
  });

  it('the Popular Chains rows draw starFilled beside the number', () => {
    // Two identical rows (flock chat + DM chat). Each used to append "4.2★"
    // as text; each must now call the system icon.
    const rows = APP.match(/\{venue\.type \|\| venue\.category\}\{venue\.stars \? [^\n]*/g) || [];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row).toContain("Icons.starFilled('currentColor', 12)");
    }
  });
});

describe('the 12px floor holds for every icon in App.js, JSX or hand-written', () => {
  it('no Icons.* call asks for a size below 12', () => {
    const sized = iconCalls(APP).filter((c) => /^\d+$/.test(c.size || ''));
    // If the scanner collapses, a no-op pass must not look like a green one.
    expect(sized.length).toBeGreaterThan(150);
    expect(sized.filter((c) => Number(c.size) < 12)).toEqual([]);
  });

  it('no inline <svg> icon is drawn below 12px either', () => {
    // The DM header's "sharing location" pin hid from the Icons.* sweep by
    // being a hand-rolled 11px svg. Inline svgs are icons too.
    const offenders = [];
    const re = /<svg[^>]*?(?:width|height)=\{?["']?(\d+)["']?\}?/g;
    let m;
    while ((m = re.exec(APP))) {
      if (Number(m[1]) < 12) {
        offenders.push({ size: m[1], line: APP.slice(0, m.index).split('\n').length });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the sharing-location status uses the system pin, not a teardrop', () => {
    const i = APP.indexOf('sharing location</span>');
    expect(i).toBeGreaterThan(-1);
    const row = APP.slice(Math.max(0, i - 600), i);
    expect(row).toContain("Icons.mapPin('#34d399', 12)");
    expect(row).not.toContain('<svg');
  });
});

describe('the deleteNeedsReauth refusal is announced', () => {
  it('the panel carries role="alert" with focus wiring', () => {
    // A destructive-flow 403 answer: without the role a screen-reader user
    // heard the Delete button go dead and nothing else. role="alert" is an
    // implicit aria-live="assertive" region, so no separate aria-live needed.
    expect(APP).toMatch(
      /\{deleteNeedsReauth && \([\s\S]{0,200}?<div role="alert" tabIndex=\{-1\} ref=\{deleteAlertRef\}/
    );
  });

  it('its deleteError sibling keeps the same contract', () => {
    expect(APP).toMatch(
      /\{deleteError && !deleteNeedsReauth && \([\s\S]{0,100}?<p role="alert" tabIndex=\{-1\} ref=\{deleteAlertRef\}/
    );
  });
});
