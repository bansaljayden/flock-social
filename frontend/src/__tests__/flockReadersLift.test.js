/**
 * THE HISTORY READ'S RECEIPT ROSTER, LIFTED RATHER THAN SWAPPED IN.
 *
 * The history read answers with the whole roster, and that answer decides who
 * is on it. A `flock_read` event can land while the answer is in flight, so
 * each member's two marks are taken as the higher of the answer's and the
 * app's, never lower. See services/flockReaders.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test flockReadersLift --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const { liftReaders } = require('../services/flockReaders');

const ana = (d, o) => ({ userId: 6, name: 'Ana', lastDeliveredMessageId: d, lastOpenedMessageId: o });
const bo = (d, o) => ({ userId: 7, name: 'Bo', lastDeliveredMessageId: d, lastOpenedMessageId: o });

test('an event that landed while the answer was in flight keeps its newer mark', () => {
  // Ana opened message 12 over the socket; the answer was read before that.
  const out = liftReaders([ana(12, 11)], [ana(12, 12)]);
  expect(out).toEqual([ana(12, 12)]);
});

test('the answer moves a mark forward when it is the newer one', () => {
  expect(liftReaders([ana(14, 13)], [ana(12, 11)])).toEqual([ana(14, 13)]);
});

test('each mark is lifted on its own', () => {
  expect(liftReaders([ana(15, 11)], [ana(12, 13)])).toEqual([ana(15, 13)]);
});

test('who is on the roster is the answer\'s call: a member it leaves out is gone', () => {
  // Bo was blocked since the app last read the roster; the answer omits him.
  const out = liftReaders([ana(12, 12)], [ana(12, 12), bo(12, 12)]);
  expect(out.map((r) => r.userId)).toEqual([6]);
});

test('a member new to the answer comes in as the answer has them', () => {
  expect(liftReaders([ana(12, 12), bo(3, 0)], [ana(12, 12)])).toEqual([ana(12, 12), bo(3, 0)]);
});

test('the answer\'s name is kept, and its row is reused when nothing moved', () => {
  const fresh = [{ ...ana(12, 12), name: 'Ana B.' }];
  const out = liftReaders(fresh, [ana(12, 11)]);
  expect(out[0]).toBe(fresh[0]);
});

test('nothing held, or nothing sent, is handled', () => {
  const fresh = [ana(1, 1)];
  expect(liftReaders(fresh, undefined)).toBe(fresh);
  expect(liftReaders(undefined, [ana(1, 1)])).toEqual([]);
  expect(liftReaders([ana(null, undefined)], [ana('4', '2')])).toEqual([ana(4, 2)]);
});

test('a member who leaves takes their receipts with them, so a rejoin starts from the new row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const at = src.indexOf('const unsub = onFlockMemberLeft((data) => {');
  expect(at).toBeGreaterThan(-1);
  const handler = src.slice(at, at + 1500);
  expect(handler).toMatch(/readers: Array\.isArray\(f\.readers\) \? f\.readers\.filter\(r => Number\(r\.userId\) !== Number\(data\.userId\)\) : f\.readers,/);
  // With the leaver gone from what the flock holds, the next answer's zero
  // stands: there is nothing left to lift it onto.
  expect(liftReaders([ana(0, 0)], [bo(5, 5)])).toEqual([ana(0, 0)]);
});

test('both history reads in App.js lift the roster onto the one the flock holds', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const uses = src.match(/readers: liftReaders\(readers, f\.readers\)/g) || [];
  expect(uses.length).toBe(2);
  expect(src).toMatch(/import \{ liftReaders \} from '\.\/services\/flockReaders';/);
});
