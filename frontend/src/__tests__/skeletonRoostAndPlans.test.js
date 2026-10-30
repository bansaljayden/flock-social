/**
 * ROOST'S CARD AND THE PRO SHEET'S PLANS, WHILE THEY LOAD.
 *
 * Roost's card waited behind two flat grey bars in --border-light that never
 * moved and that no screen reader heard as a wait. The Pro sheet said "Loading
 * plans..." alone where the two plan cards and the button go, on the web and
 * in the app. Both draw the global skeleton now, the sheet in planCard's and
 * the button's own sizes and with no price in them.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonRoostAndPlans
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
// Plain functions that never answer, so each sheet stays in its loading state;
// not jest.fn, because the suite resets mock implementations between tests.
jest.mock('../services/api', () => ({
  getEntitlements: () => new Promise(() => {}),
  getProStatus: () => new Promise(() => {}),
  startProCheckout: () => new Promise(() => {}),
  trackPaywallShown: () => {},
  trackPurchaseCompleted: () => {},
}));
jest.mock('../services/purchases', () => ({
  isPurchasesAvailable: () => true,
  getProOffering: () => new Promise(() => {}),
  introEligibleProducts: () => new Promise(() => {}),
  purchase: () => new Promise(() => {}),
  restore: () => new Promise(() => {}),
}));

// eslint-disable-next-line import/first
import PaywallSheet from '../components/PaywallSheet';
// eslint-disable-next-line import/first
import VenueAdvisorChat, { clearAdvisorThread } from '../components/VenueAdvisorChat';

afterEach(() => { delete window.Capacitor; });

// aria-busy on the shapes alone, and the spoken line beside them: a line
// inside a busy subtree may be held back, and these subtrees are unmounted
// rather than turned not-busy (components/ui/Skeleton.js SkeletonStatus).
const expectLineBesideBusyShapes = (container) => {
  const status = screen.getByRole('status');
  expect(status.closest('[aria-busy="true"]')).toBeNull();
  const shapes = Array.from(container.querySelectorAll('.skeleton'));
  expect(shapes.length).toBeGreaterThan(0);
  for (const s of shapes) expect(s.closest('[aria-busy="true"]')).not.toBeNull();
};

describe('Roost\'s card', () => {
  beforeEach(() => clearAdvisorThread());

  test('waits as its name line and a line under it, in the global skeleton, and says so', () => {
    const { container } = render(<VenueAdvisorChat fetchQuestions={() => new Promise(() => {})} ask={async () => ({})} askQuestion={async () => ({})} colors={{ navy: '#0d2847' }} />);
    const bars = Array.from(container.querySelectorAll('.skeleton'));
    expect(bars.map((b) => `${b.style.width}x${b.style.height}`)).toEqual(['90pxx14px', '70%x12px']);
    expect(screen.getByRole('status').textContent).toBe('Loading Roost');
    // The card is not busy itself; its two bars are, with the line beside them.
    expect(container.firstChild.hasAttribute('aria-busy')).toBe(false);
    expectLineBesideBusyShapes(container);
    // The two flat bars are gone.
    expect(container.innerHTML).not.toContain('var(--border-light)');
  });
});

describe('the Pro sheet\'s plans', () => {
  const expectPlanSkeleton = (container) => {
    expect(screen.getByRole('status').textContent).toBe('Loading plans');
    const cards = Array.from(container.querySelectorAll('div')).filter((d) => d.style.height === '92px' && d.style.borderRadius === '14px');
    expect(cards).toHaveLength(2);
    const cta = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.height === '49px' && b.style.borderRadius === '14px');
    expect(cta).toHaveLength(1);
    // No price, no sentence standing in for the plans.
    expect(container.textContent).not.toMatch(/\$|Loading plans…|Loading plans\.\.\./);
    expectLineBesideBusyShapes(container);
  };

  test('on the web, while the plans come from the server', () => {
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    expectPlanSkeleton(container);
  });

  test('in the app, while the App Store offering comes back', () => {
    window.Capacitor = { isNativePlatform: () => true };
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    expectPlanSkeleton(container);
  });
});
