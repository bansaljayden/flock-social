/**
 * A MEMBER WHO LEAVES TAKES THEIR VOTE OUT OF THE TALLY ON SCREEN.
 *
 * The server stopped counting a leaver's vote long ago (collectVoteRows in
 * backend/routes/venues.js joins accepted members), but App.js's
 * flock_member_left handler took them off the roster, the previews and the
 * receipts and left the tally it held alone. Their vote stayed counted, and
 * their name stayed among the voters, until the next votes read. The handler
 * now reads the plan's votes again, through loadFlockVotes, when the plan
 * holds a tally to correct.
 *
 * The handler is lifted out of App.js by source and run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test memberLeftVotesReread --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

function memberLeftHandler(env) {
  const head = 'const unsub = onFlockMemberLeft((data) => {';
  const at = APP.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('\n    });', at);
  const fn = APP.slice(at + 'const unsub = onFlockMemberLeft('.length, end + '\n    }'.length);
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return ${fn};`)(...names.map((n) => env[n]));
}

function run(plans, data) {
  let state = plans;
  const env = {
    flocksRef: { current: plans },
    departedSeatsRef: { current: new Set() },
    setFlocks: (next) => { state = typeof next === 'function' ? next(state) : next; },
    setFlockMemberLocations: jest.fn(),
    withoutPersonPin: (x) => x,
    loadFlockVotes: jest.fn(() => Promise.resolve()),
  };
  memberLeftHandler(env)(data);
  return { env, state };
}

const voted = {
  id: 4,
  members: [{ id: 6, name: 'Ana' }, { id: 7, name: 'Bo' }],
  memberCount: 2,
  votes: [{ name: 'The Vault', votes: 2, voters: ['Ana', 'Bo'] }],
};

test('a leave in a plan with a tally on screen reads that plan\'s votes again', () => {
  const { env, state } = run([voted], { flockId: 4, userId: 7 });
  expect(env.loadFlockVotes).toHaveBeenCalledWith(4);
  // The rest of the handler still does what it did.
  expect(state[0].members.map((m) => m.id)).toEqual([6]);
});

test('a plan with no tally held has nothing to correct and is not read', () => {
  const { env } = run([{ ...voted, votes: [] }], { flockId: 4, userId: 7 });
  expect(env.loadFlockVotes).not.toHaveBeenCalled();
});
