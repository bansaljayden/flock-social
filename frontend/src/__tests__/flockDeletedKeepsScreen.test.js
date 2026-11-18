/**
 * A PLAN DELETED ELSEWHERE MOVES YOU ONLY IF YOU ARE LOOKING AT IT.
 *
 * App.js's flock_deleted handler sent the app to the plans list whenever the
 * deleted plan was selectedFlockId. That id is not cleared when you leave a
 * plan's chat by its back arrow (ChatDetail's leaveToList) or the tab bar, so
 * a plan you had looked at earlier and since left, deleted while you were in
 * a DM, threw you out of the DM, and the open-thread reset dropped what you
 * were writing there. Now the screen moves only from the plan's chat or the
 * plan screen; anywhere else the stale selection is cleared and the toast
 * still says what happened.
 *
 * This runs the handler as App.js writes it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test flockDeletedKeepsScreen --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

function deletedHandler(env) {
  const head = 'onFlockDeleted((data) => {';
  const at = APP.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('\n    });', at);
  const fn = APP.slice(at + 'onFlockDeleted('.length, end + '\n    }'.length);
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return ${fn};`)(...names.map((n) => env[n]));
}

function run(currentScreen, selectedFlockId = 7) {
  const env = {
    currentScreen,
    selectedFlockId,
    setFlocks: jest.fn(),
    setPendingFlockInvites: jest.fn(),
    setFlockMemberLocations: jest.fn(),
    withoutFlockPins: (x) => x,
    setCurrentScreen: jest.fn(),
    setSelectedFlockId: jest.fn(),
    showToast: jest.fn(),
  };
  deletedHandler(env)({ flockId: 7, flockName: 'Saturday', deletedBy: 'Ana' });
  return env;
}

test('from the plan\'s own chat or plan screen, back to the list', () => {
  for (const where of ['chatDetail', 'detail']) {
    const env = run(where);
    expect(env.setCurrentScreen).toHaveBeenCalledWith('main');
    expect(env.setSelectedFlockId).toHaveBeenCalledWith(null);
    expect(env.showToast).toHaveBeenCalledWith('Saturday was deleted by Ana');
  }
});

test('in a DM, or anywhere else, the screen stays put and only the stale selection goes', () => {
  for (const where of ['dmDetail', 'main', 'venueDashboard']) {
    const env = run(where);
    expect(env.setCurrentScreen).not.toHaveBeenCalled();
    expect(env.setSelectedFlockId).toHaveBeenCalledWith(null);
    expect(env.showToast).toHaveBeenCalledWith('Saturday was deleted by Ana');
  }
});

test('another plan\'s deletion touches neither', () => {
  const env = run('chatDetail', 3);
  expect(env.setCurrentScreen).not.toHaveBeenCalled();
  expect(env.setSelectedFlockId).not.toHaveBeenCalled();
});
