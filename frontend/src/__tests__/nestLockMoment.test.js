/**
 * THE LOCK-IN MOMENT (lib/nestHero.js takeLockMoment, components/nest/
 * NestHero.js): once per plan per device, never on a plan still voting, and
 * once a session even where the browser refuses storage.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestLockMoment --watchAll=false
 */
import React from 'react';
import { render } from '@testing-library/react';

const memoryStore = () => {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); return true; }, m };
};

describe('takeLockMoment', () => {
  test('plays once for a plan, and remembers it under nest.lockSeen.<id>', () => {
    jest.isolateModules(() => {
      const { takeLockMoment, lockSeenKey } = require('../lib/nestHero');
      const store = memoryStore();
      expect(takeLockMoment(5, store)).toBe(true);
      expect(takeLockMoment(5, store)).toBe(false);
      expect(store.m.get(lockSeenKey(5))).toBe('1');
      expect(lockSeenKey(5)).toBe('nest.lockSeen.5');
      expect(takeLockMoment(6, store)).toBe(true);
    });
  });

  test('a device that has seen it does not see it again after a restart', () => {
    const store = memoryStore();
    jest.isolateModules(() => { expect(require('../lib/nestHero').takeLockMoment(9, store)).toBe(true); });
    jest.isolateModules(() => { expect(require('../lib/nestHero').takeLockMoment(9, store)).toBe(false); });
  });

  test('storage that refuses every read and write still plays it only once a session', () => {
    jest.isolateModules(() => {
      const { takeLockMoment } = require('../lib/nestHero');
      const refusing = { get: () => null, set: () => false };
      expect(takeLockMoment(3, refusing)).toBe(true);
      expect(takeLockMoment(3, refusing)).toBe(false);
    });
  });
});

describe('the hero card', () => {
  const props = (over = {}) => ({
    flock: { id: Math.floor(Math.random() * 1e9), name: 'Trivia Night' },
    when: 'Tonight at 8:33 PM',
    status: { key: 'locked', label: 'Locked in' },
    place: 'The Copper Finch',
    faces: [],
    total: 3,
    names: 'You and 2 more',
    action: null,
    onOpen: () => {},
    onAction: () => {},
    ...over,
  });

  beforeEach(() => { try { localStorage.clear(); } catch (_) { /* jsdom has it */ } });

  test('a locked-in plan buzzes once and settles its name, however often the page renders', () => {
    const NestHero = require('../components/nest/NestHero').default;
    const onLockMoment = jest.fn();
    const p = props({ onLockMoment });
    const { rerender, container } = render(<NestHero {...p} />);
    rerender(<NestHero {...p} />);
    rerender(<NestHero {...p} />);
    expect(onLockMoment).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.nest-lock-settle')).not.toBeNull();
    expect(container.querySelector('.nest-lock-fade')).not.toBeNull();
    expect(localStorage.getItem(`nest.lockSeen.${p.flock.id}`)).toBe('1');
  });

  test('a plan still voting has no moment', () => {
    const NestHero = require('../components/nest/NestHero').default;
    const onLockMoment = jest.fn();
    const { container } = render(<NestHero {...props({ onLockMoment, status: { key: 'voting', label: 'Still voting' } })} />);
    expect(onLockMoment).not.toHaveBeenCalled();
    expect(container.querySelector('.nest-lock-settle')).toBeNull();
  });

  test('the moment is the --ease-out curve, and under Reduce Motion only the fade', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toContain('.nest-lock-fade { animation: nestLockFade 200ms var(--ease-out) both; }');
    expect(css).toContain('.nest-lock-settle { animation: nestLockSettle 300ms var(--ease-out) both; }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.nest-lock-fade \{ animation-duration: 200ms !important; \}\s*\.nest-lock-settle \{ animation-name: nestLockFade !important; animation-duration: 200ms !important; \}/);
  });

  test('App.js hands it the success buzz', () => {
    const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
    expect(app).toContain('onLockMoment={hapticSuccess}');
  });
});
