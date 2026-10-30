/**
 * LOADING IS A SKELETON, NOT A SPINNER AND NOT A SENTENCE.
 *
 * Each surface below used to wait behind a ring, a "Loading..." line or a
 * shape that was not its own. Each now draws grey shapes in the size of what is
 * coming, from components/ui/Skeleton.js, with one spoken status for screen
 * readers, and no invented data: no numbers, names or map pins. These tests
 * render each one in its loading state and check three things: the skeleton is
 * there, the status is said in words, and no spinner or "Loading..." text is.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonScreens
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import {
  SkeletonBar,
  SkeletonRow,
  SkeletonStatus,
  FlockCardSkeleton,
  FlockListSkeleton,
  RosterSkeleton,
  EventCardSkeleton,
  NestSkeleton,
} from '../components/ui/Skeleton';
import PastFlocksScreen from '../screens/PastFlocksScreen';

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
// jsdom drops any inline value written with var(), so the theme tokens are
// checked in the source, and the rendered DOM is checked for everything else.
const SKELETON_SRC = read('components', 'ui', 'Skeleton.js');
const sourceOf = (name) => {
  const start = SKELETON_SRC.indexOf(`export function ${name}(`);
  const next = SKELETON_SRC.indexOf('\nexport function ', start + 1);
  return SKELETON_SRC.slice(start, next === -1 ? undefined : next);
};
// Comments out, so a sentence quoted in a comment cannot pass for code.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

/** No ring spinner, no "Loading..." or "Searching..." in what was drawn. */
function expectNoSpinnerOrLoadingText(container) {
  const spinning = Array.from(container.querySelectorAll('*')).filter((el) => /spin\b/.test(el.style.animation || ''));
  expect(spinning).toEqual([]);
  expect(container.textContent).not.toMatch(/Loading\.\.\.|Loading…|Searching\.\.\.|Finding venues near you\.\.\./);
}

/** Every drawn shape is hidden from assistive tech; the status carries the words. */
function expectShapesHidden(container) {
  for (const el of container.querySelectorAll('.skeleton')) {
    expect(el.closest('[aria-hidden="true"]')).not.toBeNull();
  }
}

describe('the parts', () => {
  test('a bar is a .skeleton span drawn as a block, aria-hidden, in the size it was given', () => {
    const { container } = render(<SkeletonBar width={28} height={20} radius={5} />);
    const bar = container.firstChild;
    expect(bar.tagName).toBe('SPAN');
    expect(bar.className).toBe('skeleton');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.style.display).toBe('block');
    expect(bar.style.width).toBe('28px');
    expect(bar.style.height).toBe('20px');
    expect(bar.style.borderRadius).toBe('5px');
  });

  test('the dark tone adds .skeleton-dark', () => {
    const { container } = render(<SkeletonBar dark />);
    expect(container.firstChild.className).toBe('skeleton skeleton-dark');
  });

  test('a card row is ListSkeleton\'s bordered card; a bare row drops the border and the fill', () => {
    const { container: card } = render(<SkeletonRow thumb={44} round />);
    expect(card.firstChild.style.padding).toBe('12px');
    expect(card.firstChild.style.borderRadius).toBe('14px');
    const thumb = card.querySelector('.skeleton');
    expect(thumb.style.width).toBe('44px');
    expect(thumb.style.borderRadius).toBe('50%');
    const { container: bare } = render(<SkeletonRow bare thumb={40} round lines={['50%']} />);
    expect(bare.firstChild.style.padding).toBe('10px 8px');
    expect(bare.querySelectorAll('.skeleton')).toHaveLength(2);
    expect(sourceOf('SkeletonRow')).toContain("...(bare ? null : { border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)' })");
  });

  test('the status says its sentence in a real text node and marks the region busy', () => {
    render(<SkeletonStatus label="Loading your flocks"><SkeletonBar /></SkeletonStatus>);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading your flocks');
    expect(status.className).toBe('sr-only');
    expect(status.parentElement.getAttribute('aria-busy')).toBe('true');
  });
});

describe('the flock card, on the Nest and on Past flocks', () => {
  test('the Nest card: radius 14, 14 by 16 padding, name and venue lines, the 76x20 pill, three overlapping 24px faces and the 64x20 time pill', () => {
    const { container } = render(<FlockCardSkeleton />);
    const card = container.firstChild;
    expect(card.style.borderRadius).toBe('14px');
    expect(card.style.padding).toBe('14px 16px');
    const bars = Array.from(card.querySelectorAll('.skeleton'));
    expect(bars.map((b) => `${b.style.width}x${b.style.height}`)).toEqual([
      '55%x18px', '40%x12px', '76pxx20px', '24pxx24px', '24pxx24px', '24pxx24px', '64pxx20px',
    ]);
    const faces = bars.filter((b) => b.style.borderRadius === '50%');
    expect(faces.map((f) => f.style.marginLeft)).toEqual(['0px', '-6px', '-6px']);
    // No thumbnail: nothing square and big, which is what ListSkeleton drew.
    expect(bars.some((b) => b.style.width === '46px')).toBe(false);
  });

  test('the Past flocks row swaps the time pill for the date pill and the Do it again button', () => {
    const { container } = render(<FlockCardSkeleton past />);
    const sizes = Array.from(container.querySelectorAll('.skeleton')).map((b) => `${b.style.width}x${b.style.height}`);
    expect(sizes).toContain('52pxx20px');
    expect(sizes).toContain('92pxx32px');
    expect(sizes).not.toContain('64pxx20px');
  });

  test('a list of them sits in the list\'s own 10px column under one status', () => {
    const { container } = render(<FlockListSkeleton label="Loading your flocks" />);
    expect(screen.getByRole('status').textContent).toBe('Loading your flocks');
    expect(container.firstChild.style.gap).toBe('10px');
    expect(container.firstChild.children).toHaveLength(4); // the status line and three cards
    expectShapesHidden(container);
  });
});

describe('the roster and the event card', () => {
  test('the Going row: four 44px faces over 36x10 name bars', () => {
    const { container } = render(<RosterSkeleton />);
    const faces = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.borderRadius === '50%');
    expect(faces).toHaveLength(4);
    faces.forEach((f) => expect(f.style.width).toBe('44px'));
    const names = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '36px');
    expect(names).toHaveLength(4);
    expect(screen.getByRole('status').textContent).toBe('Loading who is going');
  });

  test('the event card: radius 16, the 132px header, three pills and the 34px buttons', () => {
    const { container } = render(<EventCardSkeleton />);
    expect(container.firstChild.style.borderRadius).toBe('16px');
    const bars = Array.from(container.querySelectorAll('.skeleton'));
    expect(bars[0].style.height).toBe('132px');
    expect(bars.filter((b) => b.style.height === '34px')).toHaveLength(2);
    expectShapesHidden(container);
  });
});

describe('the Nest, before anything is known', () => {
  const originalMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    document.documentElement.removeAttribute('data-theme');
  });

  const phone = () => { window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} }); };

  test('on a phone it fills the screen in the theme\'s own colours, with its safe areas', () => {
    phone();
    const { container } = render(<NestSkeleton />);
    const root = container.firstChild;
    expect(root.getAttribute('data-nest-skeleton')).toBe('phone');
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(root.style.position).toBe('fixed');
    expect(screen.getByRole('status').textContent).toBe('Loading Flock.');
    // The old splash was a fixed navy gradient. This one is the theme's own
    // ground, the safe areas and the tab bar's tokens.
    expect(container.innerHTML).not.toMatch(/#1a3a5c|#2d5a87|linear-gradient/);
    const src = sourceOf('NestSkeleton');
    expect(src).toContain("backgroundColor: 'var(--bg-primary)'");
    expect(src).toContain("height: 'var(--safe-top)'");
    expect(src).toContain("padding: '10px 8px calc(12px + var(--safe-bottom))'");
    expect(src).toContain("backgroundColor: 'var(--bg-nav)'");
  });

  test('it draws HomeScreen\'s pieces: the 36px avatar, the 56px Tonight control, the 52px Start a flock, three flock cards and five tabs', () => {
    phone();
    const { container } = render(<NestSkeleton />);
    const bars = Array.from(container.querySelectorAll('.skeleton'));
    expect(bars.some((b) => b.style.width === '36px' && b.style.borderRadius === '50%')).toBe(true);
    expect(bars.some((b) => b.style.height === '56px' && b.style.borderRadius === '14px')).toBe(true);
    expect(bars.some((b) => b.style.height === '52px' && b.style.borderRadius === '14px')).toBe(true);
    // Three cards' status pills, and the five 22px tab icons.
    expect(bars.filter((b) => b.style.width === '76px' && b.style.height === '20px')).toHaveLength(3);
    expect(bars.filter((b) => b.style.width === '22px' && b.style.height === '22px')).toHaveLength(5);
    expectShapesHidden(container);
    expectNoSpinnerOrLoadingText(container);
  });

  test('in a wide browser it sits in the same 375px frame the app draws there', () => {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    const { container } = render(<NestSkeleton />);
    expect(container.firstChild.getAttribute('data-nest-skeleton')).toBe('frame');
    const frame = container.firstChild.children[1];
    expect(frame.style.width).toBe('375px');
    expect(frame.style.maxHeight).toBe('812px');
    expect(frame.style.borderRadius).toBe('44px');
  });
});

describe('the boot paints, index.js then App.js', () => {
  test('App.js holds the Nest skeleton up while GET /me answers, and the navy "Loading..." card is gone', () => {
    const app = codeOnly(read('App.js'));
    const start = app.indexOf('if (authChecking) {');
    expect(start).toBeGreaterThan(-1);
    const block = app.slice(start, app.indexOf('if (!authUser && bootUnreachable)', start));
    expect(block).toContain('return <NestSkeleton label="Loading Flock." />;');
    expect(block).not.toMatch(/Loading\.\.\./);
    expect(block).not.toMatch(/linear-gradient/);
  });

  describe('index.js AppLoading', () => {
    let fallback;
    beforeAll(() => {
      window.history.pushState({}, '', '/app');
      let rendered = null;
      jest.doMock('react-dom/client', () => ({ createRoot: () => ({ render: (el) => { rendered = el; } }) }));
      delete process.env.REACT_APP_POSTHOG_KEY;
      delete process.env.REACT_APP_SENTRY_DSN;
      jest.isolateModules(() => { require('../index'); });
      // StrictMode > ErrorBoundary > Suspense, whose fallback is <AppLoading />.
      const boundary = React.Children.only(rendered.props.children);
      const suspense = React.Children.only(boundary.props.children);
      fallback = suspense.props.fallback;
    });
    afterAll(() => {
      jest.dontMock('react-dom/client');
      window.history.pushState({}, '', '/');
      localStorage.clear();
    });
    afterEach(() => localStorage.clear());

    test('with a session stored, it is the Nest skeleton App.js paints next', () => {
      localStorage.setItem('flockToken', 'stored');
      const { container } = render(fallback);
      expect(container.querySelector('[data-nest-skeleton]')).not.toBeNull();
      expect(screen.getByRole('status').textContent).toBe('Loading Flock.');
      expectNoSpinnerOrLoadingText(container);
    });

    test('with none, it is the sign-in screen\'s navy, which is also the launch screen\'s', () => {
      const { container } = render(fallback);
      expect(container.querySelector('[data-nest-skeleton]')).toBeNull();
      expect(container.firstChild.style.background).toBe('rgb(11, 26, 46)');
      expect(screen.getByRole('status').textContent).toBe('Loading Flock.');
    });
  });
});

describe('the Nest list and Past flocks', () => {
  test('the Nest waits with flock cards, not ListSkeleton\'s thumbnail rows', () => {
    const app = codeOnly(read('App.js'));
    expect(app).toContain('{flocksLoading && flocks.length === 0 && <FlockListSkeleton label="Loading your flocks" />}');
    expect(app).not.toContain('<ListSkeleton label="Loading your flocks"');
  });

  test('Past flocks, rendered while its first read is out', () => {
    const { container } = render(
      <PastFlocksScreen
        DialogBehavior={() => null}
        colors={{}}
        handleRerunFlock={() => {}}
        loadPastFlocks={() => {}}
        pastFlocks={null}
        pastFlocksError=""
        pastFlocksLoading
        rerunningFlockId={null}
        setCurrentScreen={() => {}}
        styles={{ card: {} }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading past flocks');
    const sizes = Array.from(container.querySelectorAll('.skeleton')).map((b) => `${b.style.width}x${b.style.height}`);
    expect(sizes.filter((s) => s === '92pxx32px')).toHaveLength(3);
    expect(screen.queryByText('Nothing here yet')).toBeNull();
    expectShapesHidden(container);
    expectNoSpinnerOrLoadingText(container);
  });
});
