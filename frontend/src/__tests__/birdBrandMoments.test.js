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
 *   3. The bird marks GENUINE-empty, never an error dressed as empty. The
 *      venue dashboard just relearned (venueListErrors) that a failed read is
 *      not an empty list; parking the mascot on the failure branch would be
 *      the same lie with a friendlier face.
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

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
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

describe('the bird marks genuine-empty, never an error dressed as empty', () => {
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

  test('reviews: the true-empty gets the bird, the failed read does not', () => {
    expect(
      before('No reviews yet. Reviews from Flock users will appear here.</p>')
    ).toContain('BirdieStill');
    // "Ratings unavailable right now." is the failed-read branch. Nothing
    // between the guard that selects it and its copy may mount a bird.
    const failedBranch = APP.slice(
      APP.indexOf('venueListErrors.reviews ? ('),
      APP.indexOf('Ratings unavailable right now.')
    );
    expect(failedBranch.length).toBeGreaterThan(0);
    expect(failedBranch).not.toContain('BirdieStill');
  });

  test('the error banners themselves stay bird-free', () => {
    // Each banner runs from its sentence to its own Try again button. That
    // slice IS the banner; the genuine-empty (and its bird) sits after it.
    for (const banner of [
      "We couldn't load your promotions",
      "We couldn't load the flocks heading your way",
      "We couldn't load your events",
      "We couldn't load your reviews",
    ]) {
      const i = APP.indexOf(banner);
      expect(i).toBeGreaterThan(-1);
      const j = APP.indexOf('Try again', i);
      expect(j).toBeGreaterThan(i);
      expect(APP.slice(i, j)).not.toContain('BirdieStill');
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
    const stills = APP.match(/<BirdieStill\b[^>]*>/g) || [];
    expect(stills.length).toBeGreaterThan(0);
    for (const tag of stills) {
      const m = tag.match(/size=\{(\d+)\}/);
      // A BirdieStill with no size prop defaults to 96, which passes.
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
