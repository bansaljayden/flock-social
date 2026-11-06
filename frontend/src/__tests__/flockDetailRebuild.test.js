/**
 * FLOCK DETAIL REBUILD — the 2026-08 redesign of the flock detail screen,
 * locked shut.
 *
 * What shipped, each item a thing a later edit can silently unwind:
 *
 *   1. THE TILE PAIR DIED. Chat / Change Venue were two equal icon-in-a-
 *      rounded-square tiles (the exact banned card-grid tell, DESIGN-STANDARD A14),
 *      each drawn with a hand-rolled inline <svg>. Chat's primary action is
 *      the Open Chat pill; the venue action is now one quiet row.
 *
 *   2. THE DETAILS LIST IS GONE (2026-11-06). Created by / When / Status were
 *      three rows of colored 32px icon chips with uppercase micro eyebrows,
 *      then a ruled label/value list, and every row repeated a fact the
 *      header already printed. The host and the status are the header's, the
 *      time is the header's pill (the host's way into the time editor), and
 *      what the list held that nothing else did, Lock it in and its sentence,
 *      is a ruled step at the end of the sheet. planScreenFactsOnce.test.js
 *      renders the screen and counts each fact.
 *
 *   3. THE BRAND BIRDS LANDED. The warm bird sits beside the roster when the
 *      only accepted person is the viewer; cobalt Birdie marks the genuine
 *      no-venue-yet empty state. Both are BirdieStill (no rAF loop) at photo
 *      sizes, never below the 40px smudge floor.
 *
 *   4. THE MOMENTUM METER IS GONE (2026-11-06). Its stage word read "Ready"
 *      beside a "Planning" badge, and its signals ("Venue set", "Time set",
 *      "4 voted") each said again what the venue card, the time pill and the
 *      votes list say. Its one fact found nowhere else, how many of the
 *      people asked are going, is the Going row's "3 of 5".
 *
 *   5. THE HEADER SPEAKS THE SYSTEM. The back control draws Icons.arrowLeft
 *      instead of a raw arrow character, and both icon-only header buttons
 *      carry accessible names.
 *
 * Source-scanning, not rendering, for the same reason as every other screen
 * suite here: each fact under test is a call-site choice, and jsdom would
 * happily render a raw glyph or an icon chip. The screen left App.js on
 * 2026-09-01 for screens/FlockDetail.js, so that file is what is read now.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const DETAIL = fs.readFileSync(
  path.join(__dirname, '..', 'screens', 'FlockDetail.js'),
  'utf8'
);
const ICONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'ui', 'Icons.js'),
  'utf8'
);

/** The flock detail screen. It used to be sliced out of App.js between its
 *  declaration and the next screen's comment, and the end marker rotted
 *  twice as screens left the file around it. The screen is its own file
 *  now, screens/FlockDetail.js, which holds nothing but this screen, so
 *  the region is that file from its export declaration down. */
function region() {
  const start = DETAIL.indexOf('export default function FlockDetail(');
  expect(start).toBeGreaterThan(-1);
  return DETAIL.slice(start);
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

  it('Open Chat is a pill, not the full-width bar', () => {
    const cta = R.slice(R.indexOf('── Bottom CTA ──'));
    expect(cta).toContain("minHeight: '44px', padding: '0 20px'");
    expect(cta).toContain("display: 'inline-flex'");
    expect(codeOnly(cta)).not.toContain("width: '100%'");
    // The scroll area keeps the pill's height clear under the last row.
    expect(R).toContain("paddingBottom: '84px'");
  });
});

describe('the details list is gone, and Lock it in is a step of its own', () => {
  const lock = R.slice(R.indexOf('LOCK IT IN, which is what is left of the Details list'), R.indexOf('── When editor ──'));

  it('no label/value row repeats the header', () => {
    expect(R_CODE).not.toContain('Details</h4>');
    for (const label of ['Created by', 'When', 'Status']) {
      expect(R_CODE).not.toContain(`>${label}</span>`);
    }
    expect(R_CODE).not.toContain('Still Planning');
  });

  it('the lock-in step is the host\'s, on a plan still being made, with its sentence first', () => {
    expect(lock).toContain('{isCreator && !isConfirmed && !isCompleted && (');
    expect(lock).toContain("'Locking it in tells everyone the plan is on, and the done step appears afterwards.'");
    expect(lock).toContain("'Pick a venue and you can lock the plan in.'");
    expect(lock).toMatch(/\{hasVenue && \(\s*\n\s*<button className="hit44 glass-btn glass-primary" disabled=\{confirmingPlan\}/);
    expect(lock).toContain("{confirmingPlan ? 'Locking...' : 'Lock it in'}");
  });

  it('carries no uppercase micro eyebrows', () => {
    expect(codeOnly(lock)).not.toContain("textTransform: 'uppercase'");
  });

  it('the time control moved to the header pill, creator-gated, at tap size', () => {
    expect(R).toContain('const canEditTime = isCreator && !isCompleted;');
    expect(R).toMatch(/\{canEditTime \? \(\s*\n\s*<button type="button" className="hit44 plan-head-control" onClick=\{openTimeEditor\}/);
    expect(R).toContain("{whenText ? <><span className=\"sr-only\">Change the time, </span>{whenText}</> : 'Set a time'}");
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

describe('the momentum meter is gone', () => {
  it('draws no meter, no stage word and no repeated signal', () => {
    expect(R_CODE).not.toContain('MOMENTUM_STAGES');
    expect(R_CODE).not.toContain('momentumStageKey');
    expect(R_CODE).not.toContain('flock.momentum');
    for (const word of ['Momentum', "'Venue set'", "'Time set'", 'RSVPs', ' voted']) {
      expect(R_CODE).not.toContain(word);
    }
  });
});

describe('the header speaks the icon system and names its controls', () => {
  const header = R.slice(0, R.indexOf('Slide to complete bar'));

  it('back is Icons.arrowLeft, not a raw arrow character', () => {
    expect(header).toContain("Icons.arrowLeft('white', 16)");
    expect(R_CODE).not.toContain('←');
  });

  it('the icon-only header button has an accessible name', () => {
    expect(header).toContain('aria-label="Back to your plans"');
    // The add-to-calendar button left 2026-08-27: it wrote a manual row to
    // the in-app Plans calendar where the flock is already auto-derived, so
    // tapping it doubled the entry, and it never reached the device calendar
    // users actually meant. Device-calendar export is on the design list.
    expect(header).not.toContain('aria-label="Add to your calendar"');
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
    // A 72px thumbnail beside the name since 2026-11-06 (googlePhotoCredit
    // .test.js says why); the button holds the same box.
    expect(R).toMatch(/<img src=\{flock\.venuePhoto\}[^>]*width="72" height="72"/);
    expect(R).toMatch(/className="plan-venue-photo"[^>]*width: '72px', height: '72px'/);
  });

  it('vote selection survives dark mode and announces itself', () => {
    // navyBg === --bg-tertiary in dark, so a navyBg pill would render the
    // voted and unvoted states identically there.
    const votes = R.slice(R.indexOf('Venue votes</h4>'), R.indexOf('LOCK IT IN, which is what is left of the Details list'));
    expect(votes).toContain('backgroundColor: isMyVote ? colors.navyMidBg');
    // The row is a button only while the plan is open. A completed or
    // cancelled one renders the same tally as static rows, because the server
    // refuses a vote on either and a control that cannot succeed does not
    // belong on screen. So the toggle semantics are asserted on the props the
    // button branch carries, not on the element unconditionally.
    expect(votes).toContain("'aria-pressed': isMyVote");
    expect(votes).toContain("const VoteRow = isCompleted ? 'div' : 'button'");
    expect(votes).toMatch(/isMyVote && Icons\.check\(colors\.steel, 12\)/);
  });

  it('no em dash reaches user-visible copy in the screen', () => {
    expect(R_CODE).not.toContain('—');
  });

  it('going, votes and the lock-in step share one ruled sheet with full-bleed rules', () => {
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
