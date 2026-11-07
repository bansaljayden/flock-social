/**
 * WHAT THE NEST OFFERS TO ASK BIRDIE (lib/birdieChips.js): one suggestion for
 * a person with plans and two on a first run, the plans' own questions first,
 * only the bill question from midnight to 4 AM, and nothing while the day's
 * messages are spent.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test birdieChips --watchAll=false
 */
import { birdieChips } from '../lib/birdieChips';

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);
const plain = (list) => list.map((s) => s.replace(/\u202f/g, ' '));
const plan = (id, when, extra = {}) => ({ id, name: `Plan ${id}`, status: 'voting', eventTime: when ? when.toISOString() : null, venue: 'TBD', venueId: null, ...extra });

test('a plan at a known place within 12 hours: how busy it will be then', () => {
  const trivia = plan(1, at(6, 20, 33), { venue: 'The Copper Finch', venueId: 'p1', status: 'confirmed' });
  expect(plain(birdieChips({ liveFlocks: [trivia], now: at(6, 19, 12) }))).toEqual(['How busy is The Copper Finch at 8:33 PM?']);
  // Two on a first run is never the case with a plan, but the order holds.
  expect(plain(birdieChips({ liveFlocks: [trivia], now: at(6, 19, 12), firstRun: true }))).toEqual([
    'How busy is The Copper Finch at 8:33 PM?',
    'When should we head out?',
  ]);
});

test('beyond the 12 hours a crowd read reaches, no crowd question is offered', () => {
  const sunday = plan(2, at(8, 11, 0), { venue: 'Marigold Diner', venueId: 'p2' });
  const chips = birdieChips({ liveFlocks: [sunday], now: at(6, 19, 12), firstRun: true });
  expect(chips.some((c) => /How busy/.test(c))).toBe(false);
  expect(chips).toEqual(['Pick a spot for tonight', "Where's poppin rn?"]);
});

test('a plan with no place gets a spot picked for it', () => {
  expect(birdieChips({ liveFlocks: [plan(3, at(7, 19, 0))], now: at(6, 10, 0) })).toEqual(['Pick a spot for Plan 3']);
});

test('first run, nothing on: the two evening questions', () => {
  expect(birdieChips({ liveFlocks: [], now: at(6, 19, 12), firstRun: true })).toEqual(['Pick a spot for tonight', "Where's poppin rn?"]);
  // In the morning there is no "rn" question yet.
  expect(birdieChips({ liveFlocks: [], now: at(6, 9, 0), firstRun: true })).toEqual(['Pick a spot for tonight', 'How do I split a bill?']);
});

test('from midnight to 4 AM, only the bill question', () => {
  const trivia = plan(1, at(7, 1, 30), { venue: 'The Copper Finch', venueId: 'p1', status: 'confirmed' });
  for (const now of [at(7, 0, 0), at(7, 0, 40), at(7, 3, 59)]) {
    expect(birdieChips({ liveFlocks: [trivia], now, firstRun: true })).toEqual(['How do I split a bill?']);
    expect(birdieChips({ liveFlocks: [], now })).toEqual(['How do I split a bill?']);
  }
});

test('nothing while the day\'s messages are spent', () => {
  expect(birdieChips({ liveFlocks: [], now: at(6, 19, 12), outOfChirps: true, firstRun: true })).toEqual([]);
});

test('at most one for a person with plans', () => {
  const list = [plan(1, at(6, 21, 0), { venue: 'The Copper Finch', venueId: 'p1' }), plan(3, at(7, 19, 0))];
  expect(birdieChips({ liveFlocks: list, now: at(6, 19, 12) })).toHaveLength(1);
});
