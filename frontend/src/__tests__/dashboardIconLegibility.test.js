/**
 * DASHBOARD ICON LEGIBILITY — the four icon defects that shipped to the venue
 * and admin dashboards, locked shut.
 *
 * WHY THIS FILE EXISTS. Jayden reported the venue and admin dashboard icons as
 * "outdated and bad" twice. An earlier audit answered the wrong question: it
 * checked that the icons came FROM components/ui/Icons.js and reported 26 of 26
 * did. They did. The complaint was about the drawings and the choices, and a
 * grep cannot see either. What follows are the specific, checkable failures
 * found by rendering the whole set and looking at it. Each one is a thing a
 * future edit can silently reintroduce, which is the only reason it is a test.
 *
 * WHAT THIS FILE CANNOT DO. It cannot tell you an icon reads as a gift rather
 * than a shopping bag; that took eyes on a contact sheet. Every assertion here
 * is a proxy for something that was judged visually, and each one names the
 * judgement it stands in for so a failure is actionable rather than mysterious.
 *
 * Source-scanning, not rendering, wherever the thing under test is a CHOICE
 * made at a call site — jsdom would happily render two identical icons and
 * report success, because two identical icons are not a rendering error.
 */

const fs = require('fs');
const path = require('path');
const Icons = require('../components/ui/Icons').default;
const { sw } = require('../components/ui/Icons');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const ICONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'ui', 'Icons.js'),
  'utf8'
);

/** Pull a `const <name> = [ ... ];` array literal out of App.js by name. */
function tabArray(name) {
  const start = APP.indexOf(`const ${name} = [`);
  expect(start).toBeGreaterThan(-1);
  const open = APP.indexOf('[', start);
  const close = APP.indexOf('];', open);
  return APP.slice(open + 1, close);
}

/** The `icon: Icons.foo` entries of a tab array, in order. */
function tabIconNames(name) {
  return [...tabArray(name).matchAll(/icon:\s*Icons\.([A-Za-z]+)/g)].map((m) => m[1]);
}

describe('stroke weight actually is size-independent', () => {
  /**
   * Icons.js's header claims stroke width is derived from render size "so
   * optical weight is comparable at 10px and at 40px". Under the old five-band
   * sw() that claim was false and measurably so: the size-to-stroke ratio ran
   * 9.3:1 at 14px and 12.8:1 at 32px, a 38% spread, and it was NOT monotonic —
   * 14px came out heavier than 12px. On screen that is why a 24 or 32px icon
   * looked hairline next to a 14px one in the dashboard headers.
   *
   * If someone reintroduces bands, this goes red with the offending ratio.
   */
  /**
   * Read the sizes out of App.js rather than hardcoding them, so this stays
   * true as call sites move, and so adding a size the clamps bite at (say a
   * 64px hero icon) surfaces here instead of silently breaking the invariant.
   * Icons.js's own per-glyph defaults are folded in for the calls that pass no
   * size at all.
   */
  const SIZES_IN_USE = [
    ...new Set([
      ...[...APP.matchAll(/Icons\.[A-Za-z]+\([^()]*?,\s*(\d+)\s*(?:,[^()]*)?\)/g)].map((m) =>
        Number(m[1])
      ),
      ...[...ICONS_SRC.matchAll(/size:\s*(\d+)/g)].map((m) => Number(m[1])),
    ]),
  ].sort((a, b) => a - b);

  it('reads a plausible set of sizes out of the source', () => {
    expect(SIZES_IN_USE.length).toBeGreaterThan(5);
    expect(Math.min(...SIZES_IN_USE)).toBeGreaterThanOrEqual(10);
    expect(SIZES_IN_USE).toContain(14);
    expect(SIZES_IN_USE).toContain(18);
  });

  it('holds one size:stroke ratio across every size the app calls', () => {
    // 10px is excluded on purpose: sw() clamps at a 1px floor there, because a
    // sub-1px stroke stops resolving into a visible line. That clamp is a
    // deliberate exception and is asserted separately below. Nothing else is
    // excluded — the 4.5 ceiling deliberately does not engage until 47px, which
    // is clear of 40, the largest size any call site in App.js asks for. If
    // this fails naming a size at the top of the range, the ceiling has started
    // biting a size the app actually draws, and the ceiling is what to move.
    const ratios = SIZES_IN_USE.filter((s) => s > 10).map((s) => ({
      size: s,
      stroke: sw(s),
      ratio: Number((s / sw(s)).toFixed(3)),
    }));
    const values = ratios.map((r) => r.ratio);
    const spread = Number((Math.max(...values) / Math.min(...values)).toFixed(4));

    // 1.5% is the headroom for rounding sw() to 2dp. The five hard bands this
    // replaced scored 1.38 here. Failure prints every size so the offender is
    // named rather than inferred.
    expect({ spread, ratios }).toEqual({ spread: expect.any(Number), ratios });
    expect(spread).toBeLessThan(1.015);
  });

  it('is monotonic — a bigger icon never gets a thinner stroke', () => {
    // The old bands were not: 14px landed in the 1.5 band and 12px in the 1.25
    // band, so 14px rendered RELATIVELY heavier than 12px.
    const steps = SIZES_IN_USE.map((s) => ({ size: s, stroke: sw(s) }));
    const sorted = [...steps].sort((a, b) => a.stroke - b.stroke);
    expect(steps).toEqual(sorted);
  });

  it('clamps to a 1px floor and a 4.5px ceiling', () => {
    expect(sw(4)).toBe(1);
    expect(sw(10)).toBe(1);
    expect(sw(200)).toBe(4.5);
    // The ceiling must stay clear of every size the app draws, or the ratio
    // invariant above is only true in the middle of the range.
    expect(Math.max(...SIZES_IN_USE) / 10.5).toBeLessThan(4.5);
  });
});

describe('no tab bar offers two tabs you cannot tell apart', () => {
  /**
   * THE BUG. The admin dashboard's three tabs were
   *   Revenue -> Icons.dollar, Money -> Icons.barChart, Research -> Icons.barChart
   * so two of three tabs carried the IDENTICAL glyph, and the two labels that
   * needed distinguishing most ("Revenue" and "Money") were near-synonyms. A
   * tab bar whose icons repeat is a tab bar with no icons.
   */
  it('admin tabs are three distinct glyphs', () => {
    const names = tabIconNames('adminTabs');
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it('venue tabs are six distinct glyphs', () => {
    // Six since the Map tab landed (2026-08-20); the count is here so a
    // seventh tab has to say what glyph it brings.
    const names = tabIconNames('venueTabs');
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
  });

  it('every tab glyph named actually exists in the set', () => {
    [...tabIconNames('adminTabs'), ...tabIconNames('venueTabs')].forEach((n) => {
      expect(typeof Icons[n]).toBe('function');
    });
  });

  it('the admin tab labels are not two words for the same thing', () => {
    const labels = [...tabArray('adminTabs').matchAll(/label:\s*'([^']+)'/g)].map(
      (m) => m[1].toLowerCase()
    );
    // "Revenue" and "Money" both shipped, on adjacent tabs, one of which is the
    // simulator and one the projections.
    expect(labels).not.toContain('money');
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('glyphs that collided with each other', () => {
  /**
   * `calendar` was an open-bottom box carrying THREE dots on one row. At the 14
   * and 16px the dashboard draws it at, three dots in a rounded container is an
   * ellipsis — the typing indicator — and `chat` was at the time also an
   * open-bottom box. The two were the same picture. Both containers have since
   * closed (2026-08 geometry), but the header rule is still what stops a boxed
   * row of dots reading as a speech bubble, and an ellipsis needs three dots,
   * so calendar carries two.
   */
  it('calendar carries a header rule', () => {
    const block = ICONS_SRC.slice(
      ICONS_SRC.indexOf('calendar: make('),
      ICONS_SRC.indexOf('/* --- birdie, and the rest --- */')
    );
    expect(block).toContain('M4 11 20 11');
  });

  it('calendar carries at most two dots, so it cannot read as an ellipsis', () => {
    const block = ICONS_SRC.slice(
      ICONS_SRC.indexOf('calendar: make('),
      ICONS_SRC.indexOf('/* --- birdie, and the rest --- */')
    );
    expect((block.match(/\{dot\(/g) || []).length).toBeLessThanOrEqual(2);
  });

  it('barChart stands on a baseline rather than floating as three tallies', () => {
    const block = ICONS_SRC.slice(
      ICONS_SRC.indexOf('barChart: make('),
      ICONS_SRC.indexOf('beer: MUG_ICON')
    );
    expect(block).toContain('M3 20 21 20');
  });

  it('dollar is a real S — two bowls and a full-height riser', () => {
    // Same guarded judgement as the pin this replaces: "reads as $ at 14px".
    // The old glyph delivered that with 0/90 bars whose spacing barely
    // survived (at 5 units apart it rendered as a double-dagger), and its own
    // comment conceded the honest limit: a $ that reads instantly needs the
    // curved bowls of a real S. The 2026-08 geometry allows curves where
    // identity needs them, and this glyph is the canonical case: two r=3.5
    // semicircular bowls making the S-motion, crossed by the riser. If the
    // bowls degrade back to bars or the riser stops spanning the glyph, the
    // double-dagger failure is on its way back.
    const block = ICONS_SRC.slice(
      ICONS_SRC.indexOf('dollar: make('),
      ICONS_SRC.indexOf('doorOpen: make(')
    );
    expect((block.match(/A3\.5 3\.5/g) || []).length).toBe(2);
    expect(block).toContain('M12 3 12 21');
  });
});

describe('the block mark is the system one', () => {
  /**
   * App.js carried a hand-rolled `blockGlyph`: round caps, a hardcoded 2px
   * stroke at every size, r=10 ring. Three departures from the system, on the
   * Blocked-accounts screen — the screen an App Review reviewer opens to check
   * Guideline 1.2. Icons.ban is that mark drawn to the system.
   */
  it('no local blockGlyph survives in App.js', () => {
    expect(APP).not.toMatch(/const blockGlyph\s*=/);
    expect(APP).not.toMatch(/\bblockGlyph\(/);
  });

  it('Icons.ban exists and is used where blockGlyph was', () => {
    expect(typeof Icons.ban).toBe('function');
    expect(APP).toMatch(/Icons\.ban\(/);
    expect(APP).toMatch(/icon:\s*Icons\.ban\b/);
  });
});

describe('rating stars are visible and are announced', () => {
  /**
   * Every star row in the app drew its EMPTY stars in colors.disabled
   * (#e5e7eb), which measures 1.2:1 on the white card they sit on. The unearned
   * stars were not dim, they were absent — so a 2-star review rendered as a
   * 2-star SCALE and looked like a perfect score. --star-empty is the token
   * that exists for exactly this and it holds in both themes.
   *
   * The rows were also five aria-hidden glyphs and nothing else, so a screen
   * reader reached a review and heard no rating at all.
   */
  it('no star row paints empty stars in colors.disabled', () => {
    expect(APP).not.toMatch(/Icons\.star\(colors\.disabled/);
  });

  it('every Icons.star / Icons.starFilled row sits in a labelled container', () => {
    const rows = [...APP.matchAll(/\[1, 2, 3, 4, 5\]\.map\(s =>[\s\S]{0,300}?<\/div>/g)];
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((m) => {
      const before = APP.slice(Math.max(0, m.index - 400), m.index);
      expect(before).toMatch(/aria-label=\{`\$\{[^}]+\} out of 5 stars`\}/);
    });
  });

  it('draws stars at 12px or larger', () => {
    const calls = [...APP.matchAll(/Icons\.(star|starFilled)\([^)]*?,\s*(\d+)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    const tooSmall = calls
      .map((m) => ({ glyph: m[1], size: Number(m[2]) }))
      .filter((c) => c.size < 12);
    expect(tooSmall).toEqual([]);
  });
});

describe('an icon that is the only content of a control has a name', () => {
  /**
   * The venue logo uploader was a <div onClick> whose entire affordance was a
   * 10px camera glyph, with its meaning in a `title` — a tooltip, which is not
   * an accessible name and does not exist on touch at all.
   */
  it('the venue logo control is a real button with an accessible name', () => {
    // (It opens the listing-photo picker now, not a file input, but the
    // accessibility requirement is the same.)
    const i = APP.indexOf('onClick={() => openVenueLogoPicker()}');
    expect(i).toBeGreaterThan(-1);
    const around = APP.slice(i - 400, i + 400);
    expect(around).toMatch(/<button/);
    expect(around).toMatch(/aria-label=\{venueLogoUrl \?/);
  });

  it('draws its camera badge at a size the glyph survives', () => {
    // camera's lens is an r=5 circle inside an 18-unit box. At 10px that is a
    // 4px ring with a 1px wall, i.e. a smudge.
    // The badge sits at the far end of the control's own subtree, so the
    // window runs from the click handler to the button's closing tag.
    const start = APP.indexOf('onClick={() => openVenueLogoPicker()}');
    expect(start).toBeGreaterThan(-1);
    const end = APP.indexOf('</button>', start);
    expect(end).toBeGreaterThan(start);
    const call = APP.slice(start, end).match(/Icons\.camera\('white',\s*(\d+)\)/);
    expect(call).not.toBeNull();
    expect(Number(call[1])).toBeGreaterThanOrEqual(12);
  });
});
