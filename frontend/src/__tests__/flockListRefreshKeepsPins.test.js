/**
 * A PLAN-LIST REFRESH KEEPS WHAT THE OPEN CHAT READ.
 *
 * GET /api/flocks answers with list rows, which carry no pins and no read
 * receipt roster: both come from the history read (GET /:id/messages). The
 * list is re-read on every reconnect, the ordinary background-and-return
 * path, and its merge in loadFlocks carries what the detail reads added
 * (guests, momentum, the reconfirm window) but dropped `pins` and `readers`.
 * So an open chat lost its pinned bar and every "Opened" receipt until the
 * next history read.
 *
 * This runs the merge as App.js writes it, lifted out of loadFlocks.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test flockListRefreshKeepsPins --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

function loadFlocksMerge() {
  const head = 'setFlocks(prev => fresh.map((f) => {';
  const at = APP.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('\n        }));', at);
  expect(end).toBeGreaterThan(at);
  const body = APP.slice(at + 'setFlocks(prev => '.length, end + '\n        })'.length);
  // eslint-disable-next-line no-new-func
  return new Function('prev', 'fresh', `return ${body};`);
}

const PINS = [{ id: 41, text: 'meet at the side door' }];
const READERS = [{ userId: 6, name: 'Ana', lastDeliveredMessageId: 41, lastOpenedMessageId: 41 }];

test('the pins and the receipt roster the history read put on a plan survive a list refresh', () => {
  const merge = loadFlocksMerge();
  const held = [{ id: 1, name: 'Saturday', members: [], votes: [], messages: [{ id: 41 }], pins: PINS, readers: READERS }];
  const listRow = { id: 1, name: 'Saturday', members: [], votes: [], messages: [] };
  const [out] = merge(held, [listRow]);
  expect(out.pins).toBe(PINS);
  expect(out.readers).toBe(READERS);
});

test('a plan this session never read the history of comes through without either', () => {
  const merge = loadFlocksMerge();
  const held = [{ id: 1, name: 'Saturday', members: [], votes: [], messages: [] }];
  const [out] = merge(held, [{ id: 1, name: 'Saturday', members: [], votes: [], messages: [] }]);
  expect(out.pins).toBeUndefined();
  expect(out.readers).toBeUndefined();
});
