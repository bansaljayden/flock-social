/**
 * FLOCK DETAIL REBUILD — the 2026-08 redesign of the flock detail screen,
 * locked shut.
 *
 * What shipped, each item a thing a later edit can silently unwind:
 *
 *   1. THE TILE PAIR DIED. Chat / Change Venue were two equal icon-in-a-
 *      rounded-square tiles (the exact banned card-grid tell, SLOP-AUDIT A14),
 *      each drawn with a hand-rolled inline <svg>. Chat's primary action is
 *      the Open Chat bar; the venue action is now one quiet row.
 *
 *   2. THE DETAILS LIST IS RULED. Created by / When / Status were three rows
 *      of colored 32px icon chips with uppercase micro eyebrows. They are now
 *      a label/value list divided by hairline rules, no chips, no eyebrows.
 *
 *   3. THE BRAND BIRDS LANDED. The warm bird sits beside the roster when the
 *      only accepted person is the viewer; cobalt Birdie marks the genuine
 *      no-venue-yet empty state. Both are BirdieStill (no rAF loop) at photo
 *      sizes, never below the 40px smudge floor.
 *
 *   4. THE MOMENTUM METER CARRIES TWO CHANNELS. Unreached segments are hollow
 *      outlines rather than a dimmer fill, met/unmet signals differ by glyph
 *      (check vs open ring) as well as color, the stage label reads in white
 *      instead of the stage color, and the bar names its stage to assistive
 *      tech.
 *
 *   5. THE HEADER SPEAKS THE SYSTEM. The back control draws Icons.arrowLeft
 *      instead of a raw arrow character, and both icon-only header buttons
 *      carry accessible names.
 *
 * Source-scanning, not rendering, for the same reason as every other App.js
 * suite here: each fact under test is a call-site choice in a 16,500-line
 * monolith, and jsdom would happily render a raw glyph or an icon chip.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const ICONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'ui', 'Icons.js'),
  'utf8'
);

/** The flock detail screen, from its declaration to the next screen's. The
 *  profile screen used to be the next one, and its "// PROFILE SCREEN" comment
 *  was the end marker. The profile and settings screen left App.js on 2026-08-27
 *  for screens/ProfileSettings.js, so the venue dashboard is the next screen in
 *  the file now and its comment is the marker. */
function region() {
  const start = APP.indexOf('const FlockDetailScreen = () =>');
  const end = APP.indexOf('// VENUE DASHBOARD SCREEN', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return APP.slice(start, end);
}

/** Comments dropped entirely, block comments included, so prose naming a
 *  retired pattern (or the Open Chat bar) cannot fail or pass a test the
 *  code did not earn. */
function codeOnly(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const R = region();
const R_CODE = codeOnly(R);

describe('the banned tile pair is gone', () => {
  it('no hand-rolled inline <svg> survives in the screen', () => {
    // The two tiles each carried one. Icons come from the system now.
    expect(R_CODE).not.toContain('<svg');
  });

  it('no icon-in-a-rounded-square chip survives', () => {
    // The tile chips were 40px, the Details chips 32px, all borderRadius'd
    // squares holding a lone icon. Zero of either dimension pair remains.
    expect(R_CODE).not.toMatch(/width: '40px', height: '40px'/);
    expect(R_CODE).not.toMatch(/width: '32px', height: '32px'/);
  });

  it('the equal-tile grid is gone and the old tile copy with it', () => {
    expect(R_CODE).not.toContain('Start chatting');
    // The only 1fr 1fr grid left is the time editor's day chooser.
    const grids = R_CODE.match(/gridTemplateColumns: '1fr 1fr'/g) || [];
    expect(grids.length).toBe(1);
  });

  it('one venue action row remains, with all three role-honest labels', () => {
    expect(R).toContain("'Change the venue'");
    expect(R).toContain("'Pick a venue'");
    expect(R).toContain("'Vote on venues'");
    // Non-creators must keep the vote flow, not the creator-only picker.
    expect(R).toContain('setShowVotePanel(true)');
  });

  it('Open Chat stays the single chat affordance', () => {
    expect((R_CODE.match(/Open Chat/g) || []).length).toBe(1);
  });
});

describe('the details list is ruled, not chipped', () => {
  const details = R.slice(R.indexOf('Details</h4>'));

  it('keeps its three rows', () => {
    for (const label of ['Created by', 'When', 'Status']) {
      expect(details).toContain(`>${label}</span>`);
    }
  });

  it('rows divide with hairline rules', () => {
    expect(details).toContain("borderBottom: '1px solid var(--border-subtle)'");
  });

  it('carries no uppercase micro eyebrows', () => {
    expect(codeOnly(details)).not.toContain("textTransform: 'uppercase'");
  });

  it('the Set time control survives, creator-gated, at tap size', () => {
    expect(details).toContain('isCreator && !isCompleted');
    expect(details).toMatch(/className="hit44[^"]*"[^>]*onClick=\{\(\) => \{\s*\n\s*const when = flock\.eventTime/);
    expect(details).toContain("{flock.eventTime ? 'Change' : 'Set time'}");
  });

  it('status reads through an icon and words, never color alone', () => {
    expect(details).toContain("Icons.check('var(--accent-green-text)', 12)");
    expect(details).toContain("Icons.clock('var(--accent-amber-text)', 12)");
    expect(details).toContain("'Locked In' : 'Still Planning'");
  });
});

describe('the brand birds are in the flock screen, honestly placed', () => {
  it('the warm bird marks the just-you roster, and only the just-you roster', () => {
    const i = R.indexOf('{justYou && (');
    expect(i).toBeGreaterThan(-1);
    const block = R.slice(i, i + 600);
    expect(block).toContain('<BirdieStill bird={WARM_BIRD} size={54}');
    expect(block).toContain('Just you so far.');
  });

  it('justYou is derived from identity, not from count alone', () => {
    // A lone accepted member who is somebody else must not be told they are
    // "you". The guard compares the solo member's id to the signed-in user.
    expect(R).toMatch(/justYou = soloMember != null &&[\s\S]{0,200}String\(authUser\?\.id\)/);
  });

  it('cobalt Birdie marks the genuine no-venue empty state', () => {
    const i = R.indexOf('No venue yet</p>');
    expect(i).toBeGreaterThan(-1);
    expect(R.slice(Math.max(0, i - 700), i)).toContain('<BirdieStill size={56}');
  });

  it('every bird in the screen is a still at photo size', () => {
    // BirdieBird would mount a rAF loop on a work surface; below 40px the
    // photograph is a smudge that belongs to Icons.birdie instead.
    expect(R).not.toContain('<BirdieBird');
    const stills = R.match(/<BirdieStill\b[^>]*>/g) || [];
    expect(stills.length).toBe(2);
    for (const tag of stills) {
      const m = tag.match(/size=\{(\d+)\}/);
      expect(m).not.toBeNull();
      expect(Number(m[1])).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('the momentum meter carries more than color', () => {
  const meter = R.slice(R.indexOf('Momentum Meter'), R.indexOf('Slide to complete'));

  it('unreached segments are hollow outlines, not a dimmer fill', () => {
    expect(meter).toContain("boxShadow: i <= activeIdx ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,0.35)'");
    expect(meter).toContain("background: i <= activeIdx ? activeColor : 'transparent'");
  });

  it('met and unmet signals differ by glyph, check vs open ring', () => {
    expect(meter).toMatch(/sig\.met \? Icons\.check\(.*?, 12\) : Icons\.circle\(.*?, 12\)/);
  });

  it('the bar names its stage to assistive tech', () => {
    expect(meter).toMatch(/role="img" aria-label=\{`Momentum stage \$\{activeIdx \+ 1\} of \$\{stages\.length\}/);
  });

  it('the stage label reads in near-white, not the stage color', () => {
    // #94a3b8 (the Idea stage) measured borderline on the navy header; the
    // color channel lives in the bar, the words stay legible.
    expect(codeOnly(meter)).not.toContain('color: activeColor');
  });

  it('signal copy stays honest about what is missing', () => {
    expect(meter).toContain("'No venue yet'");
    expect(meter).toContain("'No time yet'");
  });
});

describe('the header speaks the icon system and names its controls', () => {
  const header = R.slice(0, R.indexOf('Momentum Meter'));

  it('back is Icons.arrowLeft, not a raw arrow character', () => {
    expect(header).toContain("Icons.arrowLeft('white', 16)");
    expect(R_CODE).not.toContain('←');
  });

  it('both icon-only header buttons have accessible names', () => {
    expect(header).toContain('aria-label="Back to your plans"');
    expect(header).toContain('aria-label="Add to your calendar"');
  });

  it('the status chip row wraps instead of overflowing at 320px', () => {
    expect(header).toMatch(/Status badge \*\/\}\s*\n\s*<div style=\{\{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' \}\}/);
  });
});

describe('theme parity and copy hygiene', () => {
  it('the venue photo no longer fades to hardcoded white', () => {
    // The old overlay faded into rgba(255,255,255,0.95): a white fog over a
    // dark-mode card. The photo now ends on its own clean edge.
    expect(R_CODE).not.toContain('rgba(255,255,255,0.95))');
  });

  it('the venue photo reserves its box before it loads', () => {
    expect(R).toMatch(/<img src=\{flock\.venuePhoto\}[^>]*width="375" height="170"/);
  });

  it('vote selection survives dark mode and announces itself', () => {
    // navyBg === --bg-tertiary in dark, so a navyBg pill would render the
    // voted and unvoted states identically there.
    const votes = R.slice(R.indexOf('Venue votes</h4>'), R.indexOf('Details</h4>'));
    expect(votes).toContain('backgroundColor: isMyVote ? colors.navyMidBg');
    expect(votes).toContain('aria-pressed={isMyVote}');
    expect(votes).toMatch(/isMyVote && Icons\.check\(colors\.steel, 12\)/);
  });

  it('no em dash reaches user-visible copy in the screen', () => {
    expect(R_CODE).not.toContain('—');
  });

  it('going, votes and details share one ruled sheet with full-bleed rules', () => {
    expect(R).toContain("padding: '2px 16px'");
    const rules = R.match(/height: '1px', background: 'var\(--border-default\)', margin: '0 -16px'/g) || [];
    expect(rules.length).toBe(2);
  });
});

describe('Icons.circle exists in the house geometry', () => {
  it('is a single closed ring on the system radius', () => {
    const i = ICONS_SRC.indexOf('circle: make(');
    expect(i).toBeGreaterThan(-1);
    expect(ICONS_SRC.slice(i, i + 120)).toContain('<circle cx="12" cy="12" r="9" />');
  });
});
