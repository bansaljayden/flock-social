/**
 * THE PLAN'S MILESTONES AND ITS REFUSALS ARE FELT, NOT ONLY SEEN.
 *
 * A vote tap buzzed and nothing bigger did: locking a plan in, joining one,
 * sending a budget and the host's slide to complete reaching the point where
 * letting go ends the night all passed without a sound in the hand. And when
 * the server refused a vote or a lock-in, the screen quietly put the old state
 * back with a toast, and the hand that had just felt the vote land was told
 * nothing. services/haptics.js gains warning(), iOS's error notification, for
 * exactly that case, and hapticRefused(), which the catches call so the buzz
 * comes only with a rollback the person can see and never for an expired
 * session.
 *
 * Sections:
 *   1. the service, run against a mocked plugin;
 *   2. the slide to complete, rendered and dragged;
 *   3. where App.js and the chat call each verb, read off the parsed source so
 *      a call moved out of its catch, or ahead of its await, goes red.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test planHaptics --watchAll=false
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react';

const mockPlugin = {
  impact: jest.fn(() => Promise.resolve()),
  notification: jest.fn(() => Promise.resolve()),
};
jest.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: (...a) => mockPlugin.impact(...a),
    notification: (...a) => mockPlugin.notification(...a),
  },
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));
/* The real service, with a spy on each verb so the rendered screen below can
   be counted while every call still goes through to the plugin above. */
jest.mock('../services/haptics', () => {
  const actual = jest.requireActual('../services/haptics');
  return {
    hapticTap: jest.fn(actual.hapticTap),
    hapticSuccess: jest.fn(actual.hapticSuccess),
    hapticWarning: jest.fn(actual.hapticWarning),
    hapticRefused: jest.fn(actual.hapticRefused),
    hapticAlarm: jest.fn(actual.hapticAlarm),
  };
});
const haptics = require('../services/haptics');
const FlockDetail = require('../screens/FlockDetail').default;

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// CRA runs jest with resetMocks, which strips every implementation before
// each test, so the plugin's promises and the pass-through are put back here.
beforeEach(() => {
  mockPlugin.impact.mockImplementation(() => Promise.resolve());
  mockPlugin.notification.mockImplementation(() => Promise.resolve());
  const actual = jest.requireActual('../services/haptics');
  Object.keys(haptics).forEach((verb) => haptics[verb].mockImplementation(actual[verb]));
});

describe('services/haptics, run', () => {
  test('warning() is the error notification, not another impact', async () => {
    haptics.hapticWarning();
    await flush();
    expect(mockPlugin.notification).toHaveBeenCalledWith({ type: 'ERROR' });
    expect(mockPlugin.impact).not.toHaveBeenCalled();
  });

  test('the impacts keep their weights', async () => {
    haptics.hapticTap();
    haptics.hapticSuccess();
    haptics.hapticAlarm();
    await flush();
    expect(mockPlugin.impact.mock.calls.map((c) => c[0].style)).toEqual(['LIGHT', 'MEDIUM', 'HEAVY']);
  });

  test('a plugin that refuses is swallowed, never thrown at the action it decorates', async () => {
    mockPlugin.notification.mockImplementationOnce(() => Promise.reject(new Error('no taptic engine')));
    expect(() => haptics.hapticWarning()).not.toThrow();
    await flush();
    expect(mockPlugin.notification).toHaveBeenCalledTimes(1);
  });

  test('a refusal that put the screen back buzzes the refusal', async () => {
    haptics.hapticRefused(new Error('Voting is closed'), true);
    await flush();
    expect(mockPlugin.notification).toHaveBeenCalledWith({ type: 'ERROR' });
  });

  test('a refusal with nothing moved back on screen is silent', async () => {
    haptics.hapticRefused(new Error('Voting is closed'), false);
    await flush();
    expect(mockPlugin.notification).not.toHaveBeenCalled();
  });

  test('an expired session is a sign-out, not a refusal, and is silent', async () => {
    const err = new Error('Your session ended. Sign in again.');
    err.sessionExpired = true;
    haptics.hapticRefused(err, true);
    await flush();
    expect(mockPlugin.notification).not.toHaveBeenCalled();
  });

  test('the vocabulary comments carry no em dash', () => {
    expect(read('services', 'haptics.js')).not.toMatch(/—/);
  });
});

describe('the host\'s slide to complete', () => {
  const renderSlide = () => {
    const flock = {
      id: 7, name: 'Friday', status: 'confirmed', creatorId: 1, host: 'Me',
      members: [{ id: 1, name: 'Me', status: 'accepted' }], guests: [], votes: [],
      eventTime: '2026-01-01T20:00:00Z',
    };
    const slideRef = { current: null };
    const given = {
      authUser: { id: 1, name: 'Me' },
      getSelectedFlock: () => flock,
      selectedFlockId: 7,
      colors: {},
      styles: {},
      crowdPredictions: {},
      feedbackState: {},
      submittedFeedback: {},
      MOMENTUM_STAGES: [],
      momentumStageKey: () => 'planning',
      voteTotal: () => 0,
      resolveEventTime: (f) => (f && f.eventTime ? new Date(f.eventTime) : null),
      slideRef,
      slideFillRef: { current: null },
      slideThumbRef: { current: null },
      slidePctRef: { current: 0 },
      slidingRef: { current: false },
      slideStage: 'idle',
      setSlideStage: jest.fn(),
      markFlockCompleted: jest.fn(),
      DialogBehavior: () => null,
      MissingFlockPanel: () => null,
    };
    // Every other prop is a handler this test does not press.
    const props = new Proxy(given, { get: (t, k) => (k in t ? t[k] : () => {}), has: () => true });
    const utils = render(<FlockDetail {...props} />);
    const bar = utils.container.querySelector('[data-edge-swipe="off"]');
    bar.getBoundingClientRect = () => ({ left: 16, width: 358, top: 0, height: 44 });
    return { ...utils, bar, given };
  };

  test('one tick as the thumb crosses into armed, not one per move past it', () => {
    const { bar, given } = renderSlide();
    fireEvent.touchStart(bar, { touches: [{ clientX: 30, clientY: 20 }] });
    fireEvent.touchMove(bar, { touches: [{ clientX: 200, clientY: 20 }] });
    expect(haptics.hapticTap).not.toHaveBeenCalled();
    fireEvent.touchMove(bar, { touches: [{ clientX: 340, clientY: 20 }] });
    fireEvent.touchMove(bar, { touches: [{ clientX: 350, clientY: 20 }] });
    fireEvent.touchMove(bar, { touches: [{ clientX: 360, clientY: 20 }] });
    expect(haptics.hapticTap).toHaveBeenCalledTimes(1);
    // Back out and in again is a second crossing.
    fireEvent.touchMove(bar, { touches: [{ clientX: 150, clientY: 20 }] });
    fireEvent.touchMove(bar, { touches: [{ clientX: 355, clientY: 20 }] });
    expect(haptics.hapticTap).toHaveBeenCalledTimes(2);
    fireEvent.touchEnd(bar);
    expect(given.markFlockCompleted).toHaveBeenCalledWith(7);
  });
});

/* ── Where each verb is called ─────────────────────────────────────────── */

const PARSE = {
  sourceType: 'module',
  plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'],
};
const APP = read('App.js');
const APP_AST = parser.parse(APP, PARSE);

/** The haptic calls inside the top-level-in-FlockAppInner function `name`,
 *  each with where it sits: inside a .catch handler or not, and whether an
 *  `await` or the named call comes before it in the same function. */
function hapticCallsIn(ast, name) {
  let fnPath = null;
  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier' && p.node.id.name === name) { fnPath = p; p.stop(); }
    },
  });
  expect(fnPath).toBeTruthy();
  const calls = [];
  fnPath.traverse({
    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== 'Identifier' || !/^haptic[A-Z]/.test(callee.name)) return;
      const inCatch = !!p.findParent((q) => q.isCallExpression()
        && q.node.callee.type === 'MemberExpression'
        && q.node.callee.property.name === 'catch');
      const args = p.node.arguments.map((a) => APP.slice(a.start, a.end));
      calls.push({ verb: callee.name, inCatch, args, start: p.node.start });
    },
  });
  return { calls, src: APP.slice(fnPath.node.start, fnPath.node.end), start: fnPath.node.start };
}

describe('where each verb is called', () => {
  test('locking a plan in buzzes as it lands, and a refusal buzzes the refusal', () => {
    const { calls, src, start } = hapticCallsIn(APP_AST, 'confirmFlockPlan');
    expect(calls.map((c) => [c.verb, c.inCatch])).toEqual([['hapticSuccess', false], ['hapticRefused', true]]);
    // Rolled back only when there was a status on screen to put back, the
    // same test that guards the rollback line.
    expect(calls[1].args).toEqual(['err', '!!previousStatus']);
    expect(src).toMatch(/if \(previousStatus\) setFlocks\(/);
    // After the optimistic status write, before the network call.
    const success = calls[0].start - start;
    expect(src.indexOf("status: 'confirmed'")).toBeLessThan(success);
    expect(src.indexOf('setFlockStatus(')).toBeGreaterThan(success);
    // The refusal rides with the rollback.
    const rollback = src.indexOf('status: previousStatus');
    expect(rollback).toBeGreaterThan(-1);
    expect(rollback).toBeLessThan(calls[1].start - start);
  });

  test('the chat\'s vote sheet locks in through the venue save, and gets the same pair', () => {
    const { calls, src } = hapticCallsIn(APP_AST, 'updateFlockVenue');
    expect(calls.map((c) => [c.verb, c.inCatch])).toEqual([['hapticSuccess', false], ['hapticRefused', true]]);
    expect(APP).toMatch(/if \(lockingIn\) \{\s*setFlocks\(prev => prev\.map\(f => f\.id === flockId \? \{ \.\.\.f, status: 'confirmed' \} : f\)\);\s*hapticSuccess\(\);/);
    // A refused venue save that was not a lock-in, or a lock-in on a plan
    // that was not on screen, puts back no status, so it does not buzz.
    expect(calls[1].args).toEqual(['err', 'lockingIn && !!previous']);
    expect(src).toMatch(/if \(previous\) setFlocks\(/);
  });

  test('a refused vote buzzes the refusal only when the tallies go back', () => {
    const { calls, src } = hapticCallsIn(APP_AST, 'updateFlockVotes');
    expect(calls.map((c) => [c.verb, c.inCatch])).toEqual([['hapticTap', false], ['hapticRefused', true]]);
    expect(calls[1].args).toEqual(['err', '!!previousVotes']);
    // The flag is the same test that guards the rollback, so the buzz and the
    // tiles moving back cannot disagree.
    expect(src).toMatch(/if \(previousVotes\) setFlocks\(prev => prev\.map\(f => f\.id === flockId \? \{ \.\.\.f, votes: previousVotes \} : f\)\);/);
  });

  test('App.js never calls the bare refusal buzz, only the guarded one', () => {
    expect(APP).not.toMatch(/\bhapticWarning\b/);
  });

  test.each(['handleAcceptFlockInvite', 'handleRejoinDeclinedFlock'])(
    '%s buzzes once the server has said yes, never before',
    (name) => {
      const { calls, src, start } = hapticCallsIn(APP_AST, name);
      expect(calls.map((c) => [c.verb, c.inCatch])).toEqual([['hapticSuccess', false]]);
      const awaitAt = src.indexOf('await acceptFlockInvite(');
      expect(awaitAt).toBeGreaterThan(-1);
      expect(awaitAt).toBeLessThan(calls[0].start - start);
      // And not from inside the catch block, where a refusal lands.
      expect(src.slice(src.indexOf('} catch'), src.length)).not.toMatch(/hapticSuccess\(\)/);
    },
  );

  test('a budget buzzes after submitBudget resolves, in the same try as the toast', () => {
    const chat = read('screens', 'ChatDetail.js');
    expect(chat).toMatch(/import \{ hapticSuccess \} from '\.\.\/services\/haptics';/);
    expect(chat).toMatch(/const data = await submitBudget\(selectedFlockId, \{ amount: amt, skipped: false \}\);[\s\S]{0,900}hapticSuccess\(\);\s*showToast\('Budget submitted'\);/);
  });
});
