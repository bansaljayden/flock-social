/**
 * THE FRIENDS WHO ARE OUT TONIGHT (lib/pulse.js friendsDownLine and
 * mergePlanFriends), under the Nest's Out tonight? control.
 *
 * What it must never do: name a friend who said Not, show a friend's note,
 * read an answer that has expired, ask anyone to go out after midnight, or
 * overwrite the people already picked for a plan in progress.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestFriendsLine --watchAll=false
 */
import { friendsDownLine, mergePlanFriends } from '../lib/pulse';

const FRI_712 = new Date(2026, 10, 6, 19, 12);
const LATER = new Date(2026, 10, 7, 4, 0).toISOString();
const GONE = new Date(2026, 10, 6, 19, 0).toISOString();
const pulse = (id, name, status, extra = {}) => ({ id, name, status, expires_at: LATER, note: null, profile_image_url: null, ...extra });

describe('friendsDownLine', () => {
  test('one, two, and more than two down', () => {
    expect(friendsDownLine([pulse(1, 'Sam Ortiz', 'down')], FRI_712).text).toBe('Sam is down tonight');
    expect(friendsDownLine([pulse(1, 'Sam', 'down'), pulse(2, 'Leo', 'down')], FRI_712).text).toBe('Sam and Leo are down tonight');
    expect(friendsDownLine([pulse(1, 'Sam', 'down'), pulse(2, 'Leo', 'down'), pulse(3, 'Ana', 'down'), pulse(4, 'Bo', 'down')], FRI_712).text)
      .toBe('Sam, Leo and 2 more are down tonight');
  });

  test('a maybe is added as a maybe', () => {
    expect(friendsDownLine([pulse(1, 'Sam', 'down'), pulse(2, 'Priya', 'maybe')], FRI_712).text).toBe('Sam is down tonight, Priya said maybe');
    expect(friendsDownLine([pulse(2, 'Priya', 'maybe')], FRI_712).text).toBe('Priya said maybe');
  });

  test('Not is never read: not named, not drawn, not counted', () => {
    const line = friendsDownLine([pulse(1, 'Sam', 'down'), pulse(5, 'Kai', 'not')], FRI_712);
    expect(line.text).not.toMatch(/Kai/);
    expect(line.people.map((p) => p.id)).toEqual([1]);
    expect(friendsDownLine([pulse(5, 'Kai', 'not')], FRI_712)).toBeNull();
  });

  test('an answer that has cleared is not on', () => {
    expect(friendsDownLine([pulse(1, 'Sam', 'down', { expires_at: GONE })], FRI_712)).toBeNull();
  });

  test('a friend\'s note is never part of it', () => {
    const line = friendsDownLine([pulse(1, 'Sam', 'down', { note: 'at the library till 9' })], FRI_712);
    expect(JSON.stringify(line)).not.toMatch(/library/);
  });

  test('quiet from midnight to 4 AM', () => {
    const list = [pulse(1, 'Sam', 'down', { expires_at: new Date(2026, 10, 7, 9, 0).toISOString() })];
    expect(friendsDownLine(list, new Date(2026, 10, 7, 0, 0))).toBeNull();
    expect(friendsDownLine(list, new Date(2026, 10, 7, 3, 59))).toBeNull();
    expect(friendsDownLine(list, new Date(2026, 10, 7, 4, 0))).not.toBeNull();
  });

  test('the button names one friend, or says them', () => {
    expect(friendsDownLine([pulse(1, 'Sam', 'down')], FRI_712).planLabel).toBe('Plan with Sam');
    expect(friendsDownLine([pulse(1, 'Sam', 'down'), pulse(2, 'Priya', 'maybe')], FRI_712).planLabel).toBe('Plan with them');
  });
});

describe('mergePlanFriends', () => {
  test('keeps who is already picked and adds the rest by id', () => {
    const prev = [{ id: 1, name: 'Sam', email: 's@x' }];
    const out = mergePlanFriends(prev, [{ id: 1, name: 'Sam' }, { id: 2, name: 'Leo' }]);
    expect(out.map((f) => f.id)).toEqual([1, 2]);
    // The draft's own entry is untouched, email and all.
    expect(out[0]).toBe(prev[0]);
  });

  test('never past the create screen\'s 25', () => {
    const prev = Array.from({ length: 24 }, (_, i) => ({ id: i }));
    expect(mergePlanFriends(prev, [{ id: 100 }, { id: 101 }])).toHaveLength(25);
  });
});
