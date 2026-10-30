/**
 * A NOTIFICATION TAP ON A COLD START OPENS ON THE SCREEN IT NAMES, AND THE
 * PLAN'S GOING ROW WAITS IN ITS OWN SHAPE.
 *
 * The tap routes straight to the chat, the plan or the DM, which has nothing
 * to draw until the plan list (or the DM list) answers. MissingFlockPanel and
 * MissingDmPanel filled that wait with a 104px Birdie over "Opening your plan"
 * or "Opening your messages"; they now draw OpeningScreenSkeleton, the opening
 * screen's own header and body. The plan screen's roster said "Loading
 * members..." while it waited; it draws RosterSkeleton.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonColdStart
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import { OpeningScreenSkeleton } from '../App';
import FlockDetail from '../screens/FlockDetail';

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const APP = read('App.js');

const COLORS = { navyBg: '#1e293b' };

function expectNoSpinnerOrLoadingText(container) {
  const spinning = Array.from(container.querySelectorAll('*')).filter((el) => /spin\b/.test(el.style.animation || ''));
  expect(spinning).toEqual([]);
  expect(container.textContent).not.toMatch(/Loading\.\.\.|Loading members/);
}

describe('the opening screens', () => {
  test('a plan\'s chat: the navy header with a way back, the name and state as dark bars, and the bubbles', () => {
    const onBack = jest.fn();
    const { container } = render(<OpeningScreenSkeleton kind="chat" label="Opening your plan" colors={COLORS} onBack={onBack} />);
    expect(screen.getByRole('status', { name: 'Opening your plan' })).toBeTruthy();
    const dark = container.querySelectorAll('.skeleton.skeleton-dark');
    // Name, state line, menu button.
    expect(dark).toHaveLength(3);
    // ChatSkeleton's four bubble rows: a face and a bubble each.
    expect(container.querySelectorAll('.skeleton:not(.skeleton-dark)')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    // No bird and no heading pretending to be the screen.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expectNoSpinnerOrLoadingText(container);
  });

  test('a conversation: the face beside the name, one line, and the bubbles', () => {
    const { container } = render(<OpeningScreenSkeleton kind="dm" label="Opening your messages" colors={COLORS} onBack={() => {}} />);
    expect(screen.getByRole('status', { name: 'Opening your messages' })).toBeTruthy();
    const dark = Array.from(container.querySelectorAll('.skeleton.skeleton-dark'));
    expect(dark.filter((b) => b.style.borderRadius === '50%').map((b) => b.style.width)).toEqual(['34px', '34px']);
    expect(dark).toHaveLength(3);
    expectNoSpinnerOrLoadingText(container);
  });

  test('a plan: the plan screen\'s header, its two pills, and the Going row', () => {
    const onBack = jest.fn();
    const { container } = render(<OpeningScreenSkeleton kind="plan" label="Opening your plan" colors={COLORS} onBack={onBack} />);
    expect(screen.getByRole('status').textContent).toBe('Opening your plan');
    const dark = Array.from(container.querySelectorAll('.skeleton.skeleton-dark'));
    expect(dark.filter((b) => b.style.height === '24px' && b.style.borderRadius === '20px')).toHaveLength(2);
    const faces = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '44px' && b.style.borderRadius === '50%');
    expect(faces).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Back to your plans' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expectNoSpinnerOrLoadingText(container);
  });
});

describe('the panels that draw them', () => {
  test('MissingFlockPanel opens as the screen the tap routed to, and keeps one identity while it waits', () => {
    const start = APP.indexOf('const MissingFlockPanel = useCallback(() => (flocksLoading ? (');
    expect(start).toBeGreaterThan(-1);
    const end = APP.indexOf('[flocksLoading, currentScreen, colors]);', start);
    expect(end).toBeGreaterThan(start);
    const panel = APP.slice(start, end);
    expect(panel).toContain("kind={currentScreen === 'detail' ? 'plan' : 'chat'}");
    expect(panel).toContain('onBack={() => { setCurrentScreen(\'main\'); setSelectedFlockId(null); }}');
    expect(panel).not.toContain('Opening your plan</h2>');
  });

  test('MissingDmPanel is still called, not mounted, and draws the DM opening while the list loads', () => {
    expect(APP).toMatch(/const MissingDmPanel = \(\) => \(dmsLoading \? \(\s*<OpeningScreenSkeleton\s+kind="dm"\s+label="Opening your messages"/);
    expect(APP).toMatch(/if \(!selectedDm\) return MissingDmPanel\(\);/);
    expect(APP).not.toContain('Opening your messages</h2>');
  });
});

describe("the plan screen's Going row", () => {
  const paramsOf = (src, start, end) => {
    const from = src.indexOf(start);
    const to = src.indexOf(end, from);
    return src.slice(from, to).split('\n').slice(1)
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      .flatMap((l) => l.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const PARAMS = paramsOf(read('screens', 'FlockDetail.js'), 'export default function FlockDetail({', '}) {');
  const plan = (extra = {}) => ({
    id: 41, name: 'Friday', host: 'Ava', creatorId: 9, status: 'voting', venue: 'TBD', members: [], guests: [], votes: [], ...extra,
  });
  const props = (flock, over = {}) => {
    const p = {};
    for (const name of PARAMS) p[name] = jest.fn();
    return Object.assign(p, {
      DialogBehavior: () => null,
      MissingFlockPanel: () => null,
      MOMENTUM_STAGES: [],
      authUser: { id: 9 },
      checkinSaving: false,
      colors: {},
      crowdPredictions: {},
      feedbackState: { crowdLevel: null, priceWorth: null, rating: null },
      feedbackSubmitting: false,
      getSelectedFlock: () => flock,
      recapSharing: false,
      rerunningFlockId: null,
      rosterError: null,
      showTimeEditor: false,
      slideFillRef: { current: null },
      slidePctRef: { current: 0 },
      slideRef: { current: null },
      slideStage: 'idle',
      slideThumbRef: { current: null },
      slidingRef: { current: false },
      styles: { card: {} },
      submittedFeedback: new Set(),
      timeEditDay: 'Tonight',
      timeEditHour: '9 PM',
      voteTotal: () => 0,
    }, over);
  };

  test('the parameter list was read', () => {
    expect(PARAMS).toContain('rosterError');
    expect(PARAMS.length).toBeGreaterThan(50);
  });

  test('while the roster is on the wire: four faces over name bars, no "Loading members..."', () => {
    const { container } = render(<FlockDetail {...props(plan())} />);
    expect(screen.getByText('Loading who is going')).toBeTruthy();
    const faces = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '44px' && b.style.borderRadius === '50%');
    expect(faces).toHaveLength(4);
    expect(Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '36px' && b.style.height === '10px')).toHaveLength(4);
    expect(screen.queryByText(/Just you so far/)).toBeNull();
    expectNoSpinnerOrLoadingText(container);
  });

  test('a roster that failed says so with its retry, not a skeleton', () => {
    const { container } = render(<FlockDetail {...props(plan(), { rosterError: true })} />);
    expect(screen.getByText("Couldn't load who's going.")).toBeTruthy();
    expect(screen.queryByText('Loading who is going')).toBeNull();
    expect(Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '44px')).toHaveLength(0);
  });

  test('a roster that landed draws the faces and no skeleton', () => {
    render(<FlockDetail {...props(plan({ members: [{ id: 9, name: 'Ava', status: 'accepted' }, { id: 10, name: 'Sam Lee', status: 'accepted' }] }))} />);
    expect(screen.getByText('Sam')).toBeTruthy();
    expect(screen.queryByText('Loading who is going')).toBeNull();
  });
});
