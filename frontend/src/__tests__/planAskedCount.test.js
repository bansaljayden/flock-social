/**
 * THE GOING ROW'S "OF N" IS ONE NUMBER, WHICHEVER LOADER FILLED THE ROSTER.
 *
 * The plan screen counted everyone asked off flock.members, and App.js fills
 * that array two ways: the plan screen's own read keeps every status, and
 * refreshFlockRoster keeps accepted members only. One plan read "Going (3 of
 * 5)" from the Nest, "Going (3)" when opened from its chat or after a block on
 * the plan screen, and "Going (3 of 4)" with a guest who had said out. Both
 * loaders now keep askedIds from the same server answer (lib/planAsked.js),
 * and the count is read from that.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false planAskedCount
 */

const fs = require('fs');
const path = require('path');
const { askedMemberIds, askedCount } = require('../lib/planAsked');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

// What GET /api/flocks/:id sends for one plan: Ava hosts, Jo and Sam said yes,
// Priya has not answered, Leo said no.
const SERVER_MEMBERS = [
  { id: 9, name: 'Ava Stone', status: 'accepted' },
  { id: 11, name: 'Jo Park', status: 'accepted' },
  { id: 12, name: 'Sam Lee', status: 'accepted' },
  { id: 13, name: 'Priya Shah', status: 'invited' },
  { id: 14, name: 'Leo Martin', status: 'declined' },
];
const NO_BLOCKS = new Set();

// The two shapes App.js leaves on the flock for that one answer.
const detailShape = (blocked = NO_BLOCKS, guests = []) => ({
  members: SERVER_MEMBERS.filter((m) => !blocked.has(String(m.id))),
  guests,
  askedIds: askedMemberIds(SERVER_MEMBERS, blocked),
});
const refreshShape = (blocked = NO_BLOCKS, guests = []) => ({
  members: SERVER_MEMBERS.filter((m) => m.status === 'accepted' && !blocked.has(String(m.id))),
  guests,
  askedIds: askedMemberIds(SERVER_MEMBERS, blocked),
});

describe('the count', () => {
  test('is the same for both loaders\' shapes of one answer', () => {
    expect(askedCount(detailShape())).toBe(5);
    expect(askedCount(refreshShape())).toBe(5);
  });

  test('counts every guest, in or out, in both shapes', () => {
    const guests = [
      { id: 'guest:1', guestId: 1, name: 'Casey', status: 'accepted', isGuest: true },
      { id: 'guest:2', guestId: 2, name: 'Riley', status: 'declined', isGuest: true },
    ];
    expect(askedCount(detailShape(NO_BLOCKS, guests))).toBe(7);
    expect(askedCount(refreshShape(NO_BLOCKS, guests))).toBe(7);
  });

  test('leaves out a member this reader has blocked, in both shapes', () => {
    const blocked = new Set(['13']);
    expect(askedMemberIds(SERVER_MEMBERS, blocked)).toEqual(['9', '11', '12', '14']);
    expect(askedCount(detailShape(blocked))).toBe(4);
    expect(askedCount(refreshShape(blocked))).toBe(4);
  });

  test('counts a member who accepts live once, and a newcomer by link as one more', () => {
    // The accept event appends the joiner to flock.members when the array
    // does not already hold them (App.js onFlockInviteResponded).
    const priyaJoins = (f) => ({ ...f, members: [...f.members, { id: 13, name: 'Priya Shah', status: 'accepted' }] });
    expect(askedCount(priyaJoins(refreshShape()))).toBe(5);
    const newcomer = (f) => ({ ...f, members: [...f.members, { id: 30, name: 'Cal Ortiz', status: 'accepted' }] });
    expect(askedCount(newcomer(refreshShape()))).toBe(6);
    expect(askedCount(newcomer(detailShape()))).toBe(6);
  });

  test('a flock neither loader has read counts the roster it has', () => {
    expect(askedCount({ members: SERVER_MEMBERS, guests: [{ id: 'guest:1' }] })).toBe(6);
    expect(askedCount({ members: ['Ava', 'Jo'] })).toBe(2);
    expect(askedCount(null)).toBe(0);
  });
});

// The accept event, lifted from App.js and run against a plan as the plan
// screen's loader leaves it: Priya's row is already there, as 'invited'.
describe('a member who accepts live, on the plan screen', () => {
  const start = app.indexOf('    const unsubResponse = onFlockInviteResponded((data) => {');
  const end = app.indexOf('    return () => { unsubInvite(); unsubResponse(); };', start);
  const src = app.slice(start, end);

  const accept = (flocks, data) => {
    let state = flocks;
    let handler = null;
    const setFlocks = (next) => { state = typeof next === 'function' ? next(state) : next; };
    // eslint-disable-next-line no-new-func
    new Function('onFlockInviteResponded', 'setFlocks', `${src}\nreturn unsubResponse;`)(
      (fn) => { handler = fn; return () => {}; }, setFlocks,
    );
    handler(data);
    return state;
  };

  test('turns their invited row accepted, so their face and the count come up', () => {
    const plan = { id: 41, ...detailShape(), memberCount: 3 };
    const [after] = accept([plan], { flockId: 41, userId: 13, userName: 'Priya Shah', action: 'accepted' });
    expect(after.members.find((m) => m.id === 13).status).toBe('accepted');
    expect(after.members.filter((m) => m.status === 'accepted')).toHaveLength(4);
    expect(after.members).toHaveLength(5);
    expect(askedCount(after)).toBe(5);
    expect(after.memberCount).toBe(4);
  });

  test('appends them where the chat\'s loader left the accepted only', () => {
    const plan = { id: 41, ...refreshShape(), memberCount: 3 };
    const [after] = accept([plan], { flockId: 41, userId: 13, userName: 'Priya Shah', action: 'accepted' });
    expect(after.members.map((m) => m.id)).toEqual([9, 11, 12, 13]);
    expect(askedCount(after)).toBe(5);
  });
});

describe('App.js keeps askedIds', () => {
  test('both roster loaders store it from the server\'s members and the block list', () => {
    expect(app).toMatch(/import \{ askedMemberIds \} from '\.\/lib\/planAsked';/);
    const stores = app.match(/askedIds: askedMemberIds\(data\.members, blockedIdsRef\.current\)/g) || [];
    expect(stores).toHaveLength(2);
    // One in refreshFlockRoster, one in the plan screen's own read.
    const refresh = app.slice(app.indexOf('const refreshFlockRoster = useCallback('), app.indexOf("const historyReadAtRef = useRef({});"));
    expect(refresh).toContain('askedIds: askedMemberIds(data.members, blockedIdsRef.current)');
    const detail = app.slice(app.indexOf('// Fetch flock members + momentum when opening flock detail overview'), app.indexOf('// Listen for real-time messages via WebSocket'));
    expect(detail).toContain('askedIds: askedMemberIds(data.members, blockedIdsRef.current)');
  });

  test('the list refresh carries it, and a leaver and a block take the person off it', () => {
    expect(app).toContain('askedIds: old.askedIds !== undefined ? old.askedIds : f.askedIds,');
    expect(app).toMatch(/askedIds: Array\.isArray\(f\.askedIds\) \? f\.askedIds\.filter\(a => a !== String\(data\.userId\)\) : f\.askedIds,/);
    expect(app).toMatch(/const askedIds = Array\.isArray\(f\.askedIds\) \? f\.askedIds\.filter\(a => a !== id\) : null;/);
  });
});
