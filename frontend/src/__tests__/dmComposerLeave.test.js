/**
 * NO EXIT FROM THE DM THREAD CAN SKIP THE CLEAR.
 *
 * The DM half of the guard chatComposerAndInviteSheet.test.js holds over the
 * flock chat, and the half c7563c6 never shipped. The composer ref and its
 * armed flag are App-level state shared across every thread, so a draft left
 * behind by ANY exit from DmDetail rides into the next conversation anybody
 * opens: the input remounts visually empty, Send is still armed, and one tap
 * sends the abandoned draft, written for one person, to another person.
 *
 * Found by the 2026-08-27 chat audit: the back arrow cleared everything and
 * the other five exits (Map, Change, Add a Venue, a venue card's View
 * Details, Delete Conversation) cleared nothing. The same walk that keeps the
 * flock side shut now keeps this side shut: every function that navigates
 * away from the screen must call leaveDmScreen(), and leaveDmScreen() must
 * really clear the shared composer. An AST walk, not a regex, because a
 * comment naming setCurrentScreen is a comment and a call is a call.
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const SCREEN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8',
);

const SCREEN_AST = parser.parse(SCREEN_SOURCE, {
  sourceType: 'module',
  plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'],
});

const NAVIGATION_CALLS = new Set(['setCurrentScreen', 'setCurrentTab']);
const CLEAR_CALL = 'leaveDmScreen';

const { navigatingFunctions, clearingFunctions } = (() => {
  const navigating = new Map();
  const clearing = new Set();
  traverse(SCREEN_AST, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== 'Identifier') return;
      const fn = p.getFunctionParent();
      if (!fn) return;
      if (NAVIGATION_CALLS.has(callee.name)) {
        const rec = navigating.get(fn.node) || { line: p.node.loc.start.line, calls: [] };
        rec.calls.push(callee.name);
        navigating.set(fn.node, rec);
      } else if (callee.name === CLEAR_CALL) {
        clearing.add(fn.node);
      }
    },
  });
  return { navigatingFunctions: navigating, clearingFunctions: clearing };
})();

const clearCallsMade = (() => {
  let found = null;
  traverse(SCREEN_AST, {
    VariableDeclarator(p) {
      if (p.node.id.type !== 'Identifier' || p.node.id.name !== CLEAR_CALL) return;
      const calls = [];
      p.traverse({
        CallExpression(c) {
          if (c.node.callee.type === 'Identifier') {
            calls.push({ name: c.node.callee.name, args: c.node.arguments });
          }
        },
      });
      found = calls;
    },
  });
  if (!found) throw new Error(CLEAR_CALL + ' is gone from DmDetail.js, and it is what every exit calls');
  return found;
})();

describe('no exit from the DM thread can skip the clear', () => {
  test('the walk found the exits it is meant to be checking', () => {
    // Vacuity guard: a scan that matches nothing passes every assertion under
    // it in silence. Six distinct handlers navigate away as of 2026-08-27
    // (back, Map, two venue-pick buttons, View Details, Delete). Losing an
    // exit later is fine; losing the ability to see them is not.
    expect(navigatingFunctions.size).toBeGreaterThanOrEqual(6);
    expect(clearingFunctions.size).toBeGreaterThanOrEqual(6);
  });

  test('every handler that navigates also clears', () => {
    const leaking = [...navigatingFunctions.entries()]
      .filter(([fnNode]) => !clearingFunctions.has(fnNode))
      .map(([, rec]) => 'DmDetail.js:' + rec.line + ' calls ' + rec.calls.join(' and ') + ' without ' + CLEAR_CALL + '()');
    expect(leaking).toEqual([]);
  });

  test('and the thing they all call really does clear the shared composer', () => {
    const setInput = clearCallsMade.find((c) => c.name === 'setChatInput');
    expect(setInput).toBeTruthy();
    expect(setInput.args).toHaveLength(1);
    expect(setInput.args[0].type).toBe('StringLiteral');
    // Anything but the empty string leaves chatInputHasText armed, which is
    // the half of the defect that sends the draft to the wrong person.
    expect(setInput.args[0].value).toBe('');
    expect(clearCallsMade.map((c) => c.name)).toEqual(
      expect.arrayContaining(['setChatInput', 'setDmReplyingTo', 'setDmChatSearch']),
    );
  });

  test('leaving also ends a live location share, whatever door was used', () => {
    // The back arrow used to be the ONLY exit that stopped the GPS emit loop;
    // leaving through Map or a venue card kept streaming a fix every ten
    // seconds with no indicator anywhere else in the app.
    expect(clearCallsMade.map((c) => c.name)).toEqual(
      expect.arrayContaining(['dmStopSharingLocation', 'setDmSharingLocation']),
    );
  });
});

describe('the DM header stopped claiming online unconditionally', () => {
  test('the three-state connection read exists and feeds the header', () => {
    // 9d87b73 fixed the hardcoded "online" on the flock header only; the DM
    // screen was extracted with the old literal frozen in. Same states, same
    // words, same sampling.
    expect(SCREEN_SOURCE).toMatch(/const readConnection = \(\) => \{/);
    expect(SCREEN_SOURCE).toMatch(/connectionState === 'online' \? 'online' : connectionState === 'offline' \? 'offline' : 'reconnecting\.\.\.'/);
    // The unconditional literal is gone: no bare >online< span outside the
    // ternary above.
    const bare = SCREEN_SOURCE.match(/>online</g) || [];
    expect(bare.length).toBeLessThanOrEqual(1);
  });
});

describe('the DM cash pool theater is gone', () => {
  test('no pool UI, no Pay button that moves no money', () => {
    // Component state with no backend: the progress bar and Paid status lived
    // on one phone and died on reload, and "Pay $20" posted "I paid" as fact
    // while moving nothing. SLOP rule 5: never claim a feature that does not
    // exist. The flock bill split is the real, server-backed feature.
    expect(SCREEN_SOURCE).not.toMatch(/dmCashPool/);
    expect(SCREEN_SOURCE).not.toMatch(/Split the bill/);
    expect(SCREEN_SOURCE).not.toMatch(/to the pool!/);
  });
});
