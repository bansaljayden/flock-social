/**
 * WHAT THE NEST OFFERS TO ASK BIRDIE (lib/birdieChips.js): two suggestions,
 * the plans' own questions first; when the first asks how busy a booked
 * place will be, the second asks for a spot, so picking a place is one tap
 * for a person with a plan tonight too; never two "Pick a spot" rows; only
 * the bill question from midnight to 4 AM; and nothing while the day's
 * messages are spent.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test birdieChips --watchAll=false
 */
import { birdieChips } from '../lib/birdieChips';

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);
const plain = (list) => list.map((s) => s.replace(/\u202f/g, ' '));
const plan = (id, when, extra = {}) => ({ id, name: `Plan ${id}`, status: 'voting', eventTime: when ? when.toISOString() : null, venue: 'TBD', venueId: null, ...extra });

test('a plan at a known place within 12 hours: how busy it will be then, and a spot for tonight', () => {
  // With a plan tonight there was one suggestion, the crowd question, and
  // asking for a spot meant tapping the field and typing (it was two taps on
  // the old disc's Pick a spot for tonight).
  const trivia = plan(1, at(6, 20, 33), { venue: 'The Copper Finch', venueId: 'p1', status: 'confirmed' });
  expect(plain(birdieChips({ liveFlocks: [trivia], now: at(6, 19, 12) }))).toEqual([
    'How busy is The Copper Finch at 8:33 PM?',
    'Pick a spot for tonight',
  ]);
});

test('after a crowd question, the spot asked for is a plan still choosing its place, when there is one', () => {
  const list = [plan(1, at(6, 21, 0), { venue: 'The Copper Finch', venueId: 'p1' }), plan(3, at(7, 19, 0))];
  expect(plain(birdieChips({ liveFlocks: list, now: at(6, 19, 12) }))).toEqual([
    'How busy is The Copper Finch at 9:00 PM?',
    'Pick a spot for Plan 3',
  ]);
});

test('the crowd question keeps its time and its PM on one line', () => {
  // "How busy is The Copper Finch at 11:33 / PM?" broke at 390 with PM alone.
  const late = plan(1, at(6, 23, 33), { venue: 'The Copper Finch', venueId: 'p1', status: 'confirmed' });
  const [q] = birdieChips({ liveFlocks: [late], now: at(6, 19, 12) });
  expect(q).toMatch(/11:33\u202fPM\?$/);
  expect(q).not.toMatch(/[0-9] (AM|PM)/);
});

test('beyond the 12 hours a crowd read reaches, no crowd question is offered', () => {
  const sunday = plan(2, at(8, 11, 0), { venue: 'Marigold Diner', venueId: 'p2' });
  const chips = birdieChips({ liveFlocks: [sunday], now: at(6, 19, 12) });
  expect(chips.some((c) => /How busy/.test(c))).toBe(false);
  expect(chips).toEqual(['Pick a spot for tonight', "Where's poppin rn?"]);
});

test('a plan with no place gets a spot picked for it, and never two Pick a spot rows', () => {
  expect(birdieChips({ liveFlocks: [plan(3, at(7, 19, 0))], now: at(6, 10, 0) })).toEqual(['Pick a spot for Plan 3', 'How do I split a bill?']);
});

test('a plan tonight with no crowd read: when to head out, then the next question', () => {
  const tonight = plan(4, at(6, 21, 0), { venue: 'Juniper Bowl', status: 'confirmed' });
  expect(birdieChips({ liveFlocks: [tonight], now: at(6, 19, 12) })).toEqual(['When should we head out?', "Where's poppin rn?"]);
});

test('first run, nothing on: the two evening questions', () => {
  expect(birdieChips({ liveFlocks: [], now: at(6, 19, 12) })).toEqual(['Pick a spot for tonight', "Where's poppin rn?"]);
  // In the morning there is no "rn" question yet.
  expect(birdieChips({ liveFlocks: [], now: at(6, 9, 0) })).toEqual(['Pick a spot for tonight', 'How do I split a bill?']);
});

test('from midnight to 4 AM, only the bill question', () => {
  const trivia = plan(1, at(7, 1, 30), { venue: 'The Copper Finch', venueId: 'p1', status: 'confirmed' });
  for (const now of [at(7, 0, 0), at(7, 0, 40), at(7, 3, 59)]) {
    expect(birdieChips({ liveFlocks: [trivia], now })).toEqual(['How do I split a bill?']);
    expect(birdieChips({ liveFlocks: [], now })).toEqual(['How do I split a bill?']);
  }
});

test('nothing while the day\'s messages are spent', () => {
  expect(birdieChips({ liveFlocks: [], now: at(6, 19, 12), outOfChirps: true })).toEqual([]);
});

test('never more than two', () => {
  const list = [plan(1, at(6, 21, 0), { venue: 'The Copper Finch', venueId: 'p1' }), plan(3, at(7, 19, 0)), plan(5, at(8, 19, 0))];
  expect(birdieChips({ liveFlocks: list, now: at(6, 19, 12) })).toHaveLength(2);
});

test('the Nest asks for them without a first-run switch', () => {
  const APP = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
  expect(APP).toContain('chips={birdieChips({ liveFlocks, now: nestNow, outOfChirps })}');
});
