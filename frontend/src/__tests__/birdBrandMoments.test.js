/**
 * BIRD BRAND MOMENTS — the photoreal mascots are the brand identity now
 * (Jayden, 2026-08-14: "just use the new ones that we made... the warm one
 * and the cobalt one"), and this file locks the rules that placement pass
 * followed so a later edit cannot silently unwind them:
 *
 *   1. A still bird is a COMPOSITE. The body file's own head is deliberately
 *      soft (the sharp turning head normally sits over it), so a bare body
 *      <img> is a blurry-faced bird at any size. BirdieStill must render the
 *      head layer over the body, both through <picture> with a WebP source
 *      and the PNG kept as the fallback, inside a wrapper whose box is
 *      reserved before the photos arrive.
 *
 *   2. Still means STILL. BirdieStill must cost nothing: no window listeners,
 *      no observers, no rAF. The animated BirdieBird stays where it is — the
 *      Birdie AI chat surface — and nowhere else in App.js, because the
 *      dashboards are work tools and the rAF loop is a per-instance cost.
 *
 *   3. RETIRED 2026-08-25, and replaced, not deleted. The rule used to be
 *      "the bird marks genuine-empty, never an error". Jayden, reviewing
 *      TestFlight build 26: "Birds on empty and error states. Yes. It should
 *      be everywhere." So errors get birds now.
 *
 *      What that rule was protecting is still protected, and it is the half
 *      worth keeping: a failed read is not an empty list, and no bird may
 *      make it look like one. So the successor rule is about WORDS, not
 *      about the bird. An error state's copy must still say the read failed,
 *      and its retry must still be there. The venue dashboard's four banners
 *      are the case that taught this: each one keeps its verbatim sentence
 *      and its Try again, and the bird now sits beside them.
 *
 *      The one thing that must never happen is the reason the old rule
 *      existed: an error rendered with empty-state copy. That is tested
 *      below by pinning the sentences themselves, which is a stronger check
 *      than counting mascots ever was.
 *
 *   4. Both birds, on purpose. Cobalt where the subject is Flock users, warm
 *      where it is the owner's or the flock's own space. If one of them drops
 *      to zero uses, the mix Jayden asked for twice is gone.
 *
 *   5. Never a tiny functional glyph. Below ~40px the photograph is a smudge;
 *      that register belongs to Icons.birdie.
 *
 * Source-scanning wherever the thing under test is a call-site CHOICE, and a
 * real render where the thing under test is what BirdieStill actually mounts.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');
const {
  BirdieStill,
  BIRDIE,
  WARM_BIRD,
} = require('../components/ui/BirdieBird');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and about 2,000 lines of what
// this file scans went with it. Nothing asserted below changed. The app source
// is simply in two files, so both are read, in the order they used to be one.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');
const BIRD_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'ui', 'BirdieBird.js'),
  'utf8'
);
const PUBLIC_BIRDIE = path.join(__dirname, '..', '..', 'public', 'birdie');

/** The stretch of APP starting at `anchor`, `span` characters long.
 *  Anchors must be JSX-unique: the venueListErrors comment block quotes the
 *  empty-state COPY verbatim, so bare copy strings can resolve to a comment.
 *  Anchoring on `...</p>` forms keeps the match in the markup. */
function after(anchor, span = 700) {
  const i = APP.indexOf(anchor);
  expect(i).toBeGreaterThan(-1);
  return APP.slice(i, i + span);
}

/** The stretch of APP ending at `anchor`, `span` characters long. */
function before(anchor, span = 900) {
  const i = APP.indexOf(anchor);
  expect(i).toBeGreaterThan(-1);
  return APP.slice(Math.max(0, i - span), i);
}

describe('BirdieStill is a true composite (the blurry-face landmine)', () => {
  test('renders the head layer over the body, for both birds', () => {
    for (const bird of [BIRDIE, WARM_BIRD]) {
      const { container, unmount } = render(
        React.createElement(BirdieStill, { size: 84, bird })
      );
      const imgs = [...container.querySelectorAll('img')];
      const srcs = imgs.map((img) => img.getAttribute('src'));
      // Body AND head. The body alone is the known-bad state: its head is
      // deliberately soft so the sharp head can composite over it.
      expect(srcs).toContain(`${bird.body}-400.png`);
      expect(srcs).toContain(`${bird.head}-400.png`);
      // Head must paint over the body: later in document order, same box.
      expect(srcs.indexOf(`${bird.head}-400.png`)).toBeGreaterThan(
        srcs.indexOf(`${bird.body}-400.png`)
      );
      unmount();
    }
  });

  test('serves WebP through <picture> with the PNG kept as fallback', () => {
    const { container } = render(React.createElement(BirdieStill, {}));
    const sources = [...container.querySelectorAll('picture > source')];
    expect(sources.length).toBe(2);
    for (const source of sources) {
      expect(source.getAttribute('type')).toBe('image/webp');
      // 1x and 2x, same pairing as everything else that draws these photos.
      expect(source.getAttribute('srcset')).toMatch(/-400\.webp 1x, .*\.webp 2x/);
    }
    for (const img of container.querySelectorAll('picture > img')) {
      expect(img.getAttribute('srcset')).toMatch(/-400\.png 1x, .*\.png 2x/);
      // Decorative: the copy beside the bird carries the meaning.
      expect(img.getAttribute('alt')).toBe('');
    }
  });

  test('reserves its box before the photos arrive (no layout shift)', () => {
    const { container } = render(
      React.createElement(BirdieStill, { size: 84 })
    );
    const wrap = container.firstChild;
    expect(wrap.style.width).toBe('84px');
    expect(wrap.style.height).toBe('84px');
    expect(wrap.getAttribute('aria-hidden')).toBe('true');
  });

  test('every file the <picture> pairs can choose actually exists', () => {
    // <picture> falls back to the <img> when the browser cannot decode the
    // source's TYPE, never when the chosen URL 404s — a missing .webp is a
    // broken bird, not a quiet downgrade to the PNG. Four files per stem.
    for (const bird of [BIRDIE, WARM_BIRD]) {
      for (const stem of [bird.body, bird.head]) {
        const base = path.basename(stem);
        for (const suffix of ['-400.png', '.png', '-400.webp', '.webp']) {
          const file = path.join(PUBLIC_BIRDIE, `${base}${suffix}`);
          expect(fs.existsSync(file)).toBe(true);
        }
      }
    }
  });
});

describe('BirdieStill costs nothing at rest', () => {
  test('mounts no listeners, observers, or animation frames', () => {
    const addWindow = jest.spyOn(window, 'addEventListener');
    const raf = jest.spyOn(window, 'requestAnimationFrame');
    const io = jest.fn();
    const origIO = global.IntersectionObserver;
    global.IntersectionObserver = io;
    try {
      const { unmount } = render(React.createElement(BirdieStill, {}));
      const listened = addWindow.mock.calls.map((c) => c[0]);
      expect(listened).not.toContain('pointermove');
      expect(listened).not.toContain('pointerdown');
      expect(listened).not.toContain('scroll');
      expect(raf).not.toHaveBeenCalled();
      expect(io).not.toHaveBeenCalled();
      unmount();
    } finally {
      global.IntersectionObserver = origIO;
      addWindow.mockRestore();
      raf.mockRestore();
    }
  });

  test('the animated BirdieBird stays confined to the Birdie chat surface', () => {
    // Two mounts: the empty-state Birdie and the behind-the-thread whisper,
    // both inside the AI panel. A third mount is a rAF loop someone put on a
    // screen that was told to take the still image.
    const mounts = APP.match(/<BirdieBird\b/g) || [];
    expect(mounts.length).toBe(2);
  });
});

describe('empty AND error states carry a bird', () => {
  test('promotions: bird rides the branch the error guard already suppresses', () => {
    const block = before('No promotions yet. Create your first one!');
    expect(block).toContain('venueListErrors.promotions ? null');
    expect(block).toContain('BirdieStill');
  });

  test('incoming flocks: same structure, cobalt bird', () => {
    const block = before('No incoming flocks yet</p>');
    expect(block).toContain(
      'venueListErrors.incomingFlocks || venueListErrors.incomingFlocksLocked'
    );
    expect(block).toContain('BirdieStill');
  });

  test('reviews: the true-empty gets the bird', () => {
    expect(
      before('No reviews yet. Reviews from Flock users will appear here.</p>')
    ).toContain('BirdieStill');
  });

  // This is the assertion that replaced "the error banners stay bird-free".
  // Each of the venue dashboard's four failed-read banners now renders a
  // BirdNote, and the bird is the part that changed; the words are the part
  // that must not.
  test('the four venue banners each render a bird', () => {
    for (const banner of [
      "We couldn't load your promotions",
      "We couldn't load the flocks heading your way",
      "We couldn't load your events",
      "We couldn't load your reviews",
    ]) {
      const i = APP.indexOf(banner);
      expect(i).toBeGreaterThan(-1);
      // The BirdNote opens above its own body copy.
      expect(APP.slice(Math.max(0, i - 500), i)).toContain('<BirdNote');
    }
  });

  test('every error state still says the read failed, and still offers a retry', () => {
    // The half of the retired rule that survives it. A bird beside a failure
    // is company; a bird INSTEAD of the sentence would be the lie.
    for (const banner of [
      "We couldn't load your promotions. Nothing has been deleted.",
      "We couldn't load the flocks heading your way.",
      "We couldn't load your events. Nothing has been deleted.",
      "We couldn't load your reviews. Nothing has been deleted.",
    ]) {
      const i = APP.indexOf(banner);
      expect(i).toBeGreaterThan(-1);
      const window = APP.slice(i, i + 700);
      expect(window).toContain('Try again');
    }
    // And the failed read must never borrow the empty state's words.
    const failedBranch = APP.slice(
      APP.indexOf('venueListErrors.reviews ? ('),
      APP.indexOf('Ratings unavailable right now.')
    );
    expect(failedBranch.length).toBeGreaterThan(0);
    expect(failedBranch).not.toContain('No reviews yet');
  });

  test('the states Jayden named by hand all have one', () => {
    // "The Reviews tab that failed to load, lists with nothing in them,
    // failed fetches, blocked-users-empty, no-friends, no-flocks,
    // no-search-results, and so on."
    const anchored = [
      ['blocked accounts, failed read', '{blockedError}'],
      ['blocked accounts, empty', 'You have not blocked anyone'],
      ['past flocks, failed read', '{pastFlocksError}'],
      ['past flocks, empty', 'A flock lands here once its night has been and gone.'],
      ['a person search that found nobody', 'No friends by that name'],
      ['a flock that no longer exists', "This plan isn't open anymore"],
    ];
    for (const [label, anchor] of anchored) {
      const i = APP.indexOf(anchor);
      expect([label, i]).not.toEqual([label, -1]);
      const around = APP.slice(Math.max(0, i - 700), i + 200);
      expect([label, /<BirdNote|<BirdieStill/.test(around)]).toEqual([label, true]);
    }
  });
});

describe('both birds, deliberately mixed, never as glyphs', () => {
  test('warm and cobalt each appear at least twice in App.js', () => {
    const stills = APP.match(/<BirdieStill\b[^>]*>/g) || [];
    const warm = stills.filter((s) => s.includes('WARM_BIRD'));
    const cobalt = stills.filter((s) => !s.includes('WARM_BIRD'));
    // "Have some of birdie, some of the cream one." Zero of either is the
    // accidental all-one-bird state this pass was told to avoid.
    expect(warm.length).toBeGreaterThanOrEqual(2);
    expect(cobalt.length).toBeGreaterThanOrEqual(2);
  });

  test('no still bird is rendered below 40px', () => {
    // BirdNote is counted too now that the error sweep uses it: it renders a
    // BirdieStill underneath, so a 24px BirdNote would be a smudge by another
    // route. (Its row layout floors at 48 on its own; this catches the stack.)
    const stills = APP.match(/<BirdieStill\b[^>]*>/g) || [];
    expect(stills.length).toBeGreaterThan(0);
    const notes = APP.match(/<BirdNote\b[\s\S]*?\/>/g) || [];
    expect(notes.length).toBeGreaterThan(0);
    for (const tag of [...stills, ...notes]) {
      const m = tag.match(/size=\{(\d+)\}/);
      // No size prop defaults to 96 on BirdieStill and 64 on BirdNote, and
      // both pass.
      if (m) expect(Number(m[1])).toBeGreaterThanOrEqual(40);
    }
  });

  test('the admin header leads with the mascot, not a briefcase', () => {
    expect(before('Admin Dashboard</h1>')).toContain('BirdieStill');
    expect(APP).not.toContain('Icons.briefcase');
  });
});

describe('busy states', () => {
  test("the logo uploader shows a spinner, not '…'", () => {
    const block = after('venueLogoUploading && (', 600);
    expect(block).not.toContain('…');
    expect(block).toContain('spin 0.8s linear infinite');
    expect(block).toContain('role="status"');
  });

  test("the 'spin' keyframe the ring spinners reference is actually defined", () => {
    // Four call sites animate with 'spin 0.8s'/'spin 1s'. Until 2026-08-14 no
    // stylesheet in src/ defined it, so every one of those rings sat frozen.
    expect(APP).toMatch(/animation: 'spin [\d.]+s linear infinite'/);
    expect(APP).toContain('@keyframes spin');
  });
});

describe('BirdieStill source hygiene', () => {
  test('BirdieStill is exported from BirdieBird.js and carries the landmine note', () => {
    expect(BIRD_SRC).toContain('export function BirdieStill');
    // The comment is load-bearing documentation: the next person who reaches
    // for the bare body PNG needs to hit the warning before the asset.
    expect(BIRD_SRC).toMatch(/BirdieStill[\s\S]{0,900}deliberately soft/);
  });
});
