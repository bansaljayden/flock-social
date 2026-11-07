/**
 * WHAT START A FLOCK SAYS WHEN THE SERVER SEATS FEWER PEOPLE THAN WERE ASKED.
 *
 * POST /api/flocks answers { flock, invited_user_ids }: the flock row, and
 * beside it the ids that actually got a membership row. The server leaves out,
 * without saying which or why, a pair with a block between them, ids past the
 * hourly invite budget, and anyone who takes plan invites from friends only.
 * When that happens the creator is told "Invited 1 of 2. The rest can join
 * from the invite link." From 2026-09-04 the screen read the list off the
 * flock row, which never carries it, so the count always fell back to
 * everyone asked for and that sentence never showed; the source pin in
 * coreLoopTruth.test.js asserted the wrong line.
 *
 * So this renders the real CreateScreen with every prop it takes (read off its
 * own signature, the way invitesAndSuggestionsSettings.test.js reads
 * ProfileSettings), presses Create Flock against a createFlock that answers in
 * the server's own shape, and reads what the creator is told.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false createScreenInvitedCount
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, fireEvent, act, cleanup } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  createFlock: jest.fn(),
  createFlockInviteLink: jest.fn(),
  sendMessage: jest.fn(),
}));
jest.mock('../services/haptics', () => ({ hapticSuccess: jest.fn() }));
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote: Stub, WARM_BIRD: {} };
});

const api = require('../services/api');
const CreateScreen = require('../screens/CreateScreen').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const CREATE_SRC = read('..', 'screens', 'CreateScreen.js');
const FLOCKS_ROUTE_SRC = read('..', '..', '..', 'backend', 'routes', 'flocks.js');

// Every parameter CreateScreen takes, read off its own signature.
const PARAMS = (() => {
  const start = CREATE_SRC.indexOf('export default function CreateScreen({');
  const block = CREATE_SRC.slice(start, CREATE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();

const Stub = () => null;
const Toggle = ({ on, onChange, label }) => (
  React.createElement('button', { role: 'switch', 'aria-checked': !!on, 'aria-label': label, onClick: onChange })
);

// A form ready to send: a name and two people, so the button makes a flock
// (one person would open a direct message instead).
const ANA = { id: 2, name: 'Ana' };
const BEN = { id: 3, name: 'Ben' };
function props(overrides = {}) {
  const out = {};
  for (const name of PARAMS) {
    out[name] = /^(set|handle|show|start|persist|on[A-Z])/.test(name) ? jest.fn() : undefined;
  }
  return {
    ...out,
    DialogBehavior: Stub,
    ListSkeleton: Stub,
    SearchInputLocal: Stub,
    Toggle,
    formatEventTime: () => 'Fri 8:00 PM',
    isServerId: () => true,
    resolveEventTime: () => new Date('2026-11-06T20:00:00Z'),
    authUser: { id: 1, name: 'Ren' },
    colors: {},
    styles: {},
    emailConfirmLine: null,
    flockBudgetContext: 'dinner',
    flockCashPool: false,
    flockGhostMode: true,
    flockDate: 'today',
    flockTime: '20:00',
    flockFriends: [ANA, BEN],
    flockName: 'Friday',
    flockNameError: '',
    inviteResults: [],
    inviteSearch: '',
    inviteSearchError: '',
    inviteSearching: false,
    isLoading: false,
    needsEmailVerification: () => false,
    newlyCreatedFlockRef: { current: null },
    selectedVenueForCreate: null,
    suggestedUsers: [],
    ...overrides,
  };
}

const FLOCK = { id: 77, name: 'Friday', creator_id: 1, event_time: '2026-11-06T20:00:00Z' };
const PARTLY = /^Invited \d+ of \d+\. The rest can join from the invite link\.$/;

async function createWith(answer) {
  api.createFlock.mockResolvedValue(answer);
  api.createFlockInviteLink.mockResolvedValue({ url: 'https://flock.test/i/abc' });
  const p = props();
  render(React.createElement(CreateScreen, p));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create flock/ })); });
  expect(api.createFlock).toHaveBeenCalledTimes(1);
  expect(api.createFlock.mock.calls[0][0].invited_user_ids).toEqual([ANA.id, BEN.id]);
  return p;
}

const partlyToasts = (p) => p.showToast.mock.calls.map((c) => c[0]).filter((t) => PARTLY.test(t));

beforeEach(() => {
  jest.clearAllMocks();
});

test('the harness reads the whole signature, and the answer below is the server\'s own shape', () => {
  expect(PARAMS.length).toBeGreaterThan(40);
  expect(PARAMS).toEqual(expect.arrayContaining(['showToast', 'flockFriends', 'resolveEventTime', 'suggestedUsers']));
  expect(FLOCKS_ROUTE_SRC).toMatch(/res\.status\(201\)\.json\(\{ flock, invited_user_ids: invitedUids \}\);/);
});

test('a flock the server seats only partly says how many invites went out', async () => {
  const p = await createWith({ flock: FLOCK, invited_user_ids: [ANA.id] });
  expect(partlyToasts(p)).toEqual(['Invited 1 of 2. The rest can join from the invite link.']);
  // The plan is still made, and the made step is up.
  expect(p.setSelectedFlockId).toHaveBeenCalledWith(FLOCK.id);
  expect(screen.queryByRole('button', { name: /Create flock/ })).toBeNull();
});

test('a flock the server seats nobody on says 0 of 2', async () => {
  const p = await createWith({ flock: FLOCK, invited_user_ids: [] });
  expect(partlyToasts(p)).toEqual(['Invited 0 of 2. The rest can join from the invite link.']);
});

test('a flock that seats everyone asked says nothing about the rest', async () => {
  const p = await createWith({ flock: FLOCK, invited_user_ids: [ANA.id, BEN.id] });
  expect(partlyToasts(p)).toEqual([]);
  expect(p.setSelectedFlockId).toHaveBeenCalledWith(FLOCK.id);
});

test('an answer without the list claims nobody was left out, and the plan is still made', async () => {
  // The last one carries a list on the flock row, where the old line looked;
  // that is not the server's echo, and it is not read.
  for (const answer of [{ flock: FLOCK }, { flock: FLOCK, invited_user_ids: null }, { flock: { ...FLOCK, invited_user_ids: [ANA.id] } }]) {
    jest.clearAllMocks();
    // eslint-disable-next-line no-await-in-loop
    const p = await createWith(answer);
    expect(partlyToasts(p)).toEqual([]);
    expect(p.setSelectedFlockId).toHaveBeenCalledWith(FLOCK.id);
    cleanup();
  }
});
