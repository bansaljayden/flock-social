/**
 * THE PLAN SCREEN SAYS EACH FACT ONCE (2026-11-06).
 *
 * screens/FlockDetail.js printed the host twice ("Hosted by" in the header,
 * "Created by" in Details), the time three times (a header pill, the momentum
 * meter's "Time set", the Details "When" row), the status twice (the header's
 * "Planning" and the Details row's "Still Planning"), and the meter's stage
 * word "Ready" beside that "Planning" badge, saying the opposite of it. The
 * head count rode on the header line and on the Going row as well.
 *
 * Each fact has one home now: the host and the status in the header, the time
 * in the header's pill (which is also the host's way into the time editor),
 * the head count on the Going row, out of everyone asked when some have not
 * said yes. Nothing a person could do on the screen went with the rows: every
 * control is asserted here by the name a screen reader gives it.
 *
 * Rendered for real, from the screen's own parameter list, the way
 * staticMapUrl.test.js and endedPlanAsks.test.js render it. The clock is
 * pinned, so the plan's time and every "is the night over" gate read the same
 * on any day this runs.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false planScreenFactsOnce
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent } = require('@testing-library/react');

jest.mock('../components/ui/MapsChooser', () => ({
  __esModule: true,
  default: () => null,
  openMapsChooser: jest.fn(() => true),
  closeMapsChooser: jest.fn(),
}));
jest.mock('../services/api', () => ({
  __esModule: true,
  submitVenueFeedback: jest.fn(),
  getTableSummaries: jest.fn(() => Promise.resolve({})),
  getTableSummary: jest.fn(() => Promise.resolve(null)),
  isLoggedIn: jest.fn(() => false),
}));

const { localeDateTime } = require('../lib/localeFormat');
const FlockDetail = require('../screens/FlockDetail').default;

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const DETAIL_SRC = read('screens', 'FlockDetail.js');

const PARAMS = (() => {
  const from = DETAIL_SRC.indexOf('export default function FlockDetail({');
  const to = DETAIL_SRC.indexOf('}) {', from);
  return DETAIL_SRC.slice(from, to).split('\n').slice(1).map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean).flatMap((l) => l.split(',')).map((w) => w.trim()).filter(Boolean);
})();

// Tuesday 3 November 2026, noon local, and the plan two days on at 8 PM.
const NOW = new Date(2026, 10, 3, 12, 0, 0);
const AT = new Date(2026, 10, 5, 20, 0, 0);
const WHEN = localeDateTime(AT, [], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const HOST = { id: 9, name: 'Ava Stone', status: 'accepted' };
const plan = (extra = {}) => ({
  id: 41,
  name: 'Friday Crew',
  host: 'Ava Stone',
  creatorId: 9,
  status: 'planning',
  venue: 'Copper Finch',
  venueId: 'ChIJcopperFinch01',
  venueAddress: '125 E 3rd St',
  venueLat: 40.61,
  venueLng: -75.37,
  eventTime: AT.toISOString(),
  time: 'Thu 8:00 PM',
  members: [
    HOST,
    { id: 11, name: 'Jo Park', status: 'accepted' },
    { id: 12, name: 'Sam Lee', status: 'accepted' },
    { id: 13, name: 'Priya Shah', status: 'invited' },
    { id: 14, name: 'Leo Martin', status: 'declined' },
  ],
  guests: [],
  votes: [
    { venue: 'Copper Finch', place_id: 'ChIJcopperFinch01', voters: ['Jo Park', 'Sam Lee'] },
  ],
  // What the server sends for this plan: every signal met, so the retired
  // meter would have read "Ready" beside the "Planning" badge.
  momentum: { score: 80, stage: 'locked_in', accepted: 3, totalMembers: 5, responded: 4, hasVenue: true, hasTime: true, uniqueVoters: 2 },
  ...extra,
});

const props = (flock, over = {}) => {
  const p = {};
  for (const name of PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: () => null,
    MissingFlockPanel: () => null,
    authUser: { id: 9 },
    checkinSaving: false,
    colors: {},
    confirmingPlan: false,
    crowdPredictions: {},
    feedbackState: { crowdLevel: null, priceWorth: null, rating: null },
    feedbackSubmitting: false,
    getSelectedFlock: () => flock,
    recapSharing: false,
    rerunningFlockId: null,
    // App.js resolves a chip to an instant; every chip lands on the plan's
    // own day here, which is all the editor's opening needs.
    resolveEventTime: () => new Date(AT),
    rosterError: null,
    savingEventTime: false,
    showTimeEditor: false,
    slideFillRef: { current: null },
    slidePctRef: { current: 0 },
    slideRef: { current: null },
    slideStage: 'idle',
    slideThumbRef: { current: null },
    slidingRef: { current: false },
    styles: { card: {} },
    submittedFeedback: new Set(),
    timeEditDay: 'Tonight',
    timeEditHour: '9 PM',
    voteTotal: (v) => (v.voters || []).length,
  }, over);
};

const occurrences = (text, needle) => text.split(needle).length - 1;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

describe('the host, on a plan still being made', () => {
  test('the parameter list was read, and the meter\'s two props are not in it', () => {
    expect(PARAMS).toContain('colors');
    expect(PARAMS).not.toContain('MOMENTUM_STAGES');
    expect(PARAMS).not.toContain('momentumStageKey');
  });

  test('each fact is on screen once', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan())));
    const text = container.textContent;
    // The host: the header line, and no Created by row.
    expect(occurrences(text, 'Ava Stone')).toBe(1);
    expect(screen.getByText('Hosted by Ava Stone')).toBeInTheDocument();
    expect(text).not.toContain('Created by');
    // The time, in full, once. Not the short form the list carries either.
    expect(occurrences(text, WHEN)).toBe(1);
    expect(text).not.toContain('Thu 8:00 PM');
    // The status: the badge's word, once, and nothing beside it saying more.
    expect(occurrences(text, 'Planning')).toBe(1);
    for (const gone of ['Still Planning', 'Ready', 'Momentum', 'RSVPs', 'Venue set', 'Time set', 'voted']) {
      expect(text).not.toContain(gone);
    }
    // The head count: the Going row, out of the five asked, and not the header.
    expect(screen.getByRole('heading', { name: 'Going (3 of 5)' })).toBeInTheDocument();
    expect(text).not.toMatch(/\d+ going/);
    // The venue: its card.
    expect(screen.getByRole('heading', { name: 'Copper Finch' })).toBeInTheDocument();
  });

  test('the time pill is the host\'s way into the editor, on the plan\'s own hour', () => {
    const p = props(plan());
    render(React.createElement(FlockDetail, p));
    const pill = screen.getByRole('button', { name: `Change the time, ${WHEN}` });
    expect(pill.className).toContain('hit44');
    fireEvent.click(pill);
    expect(p.setTimeEditHour).toHaveBeenCalledWith('8 PM');
    expect(p.setTimeEditDay).toHaveBeenCalledTimes(1);
    expect(p.setShowTimeEditor).toHaveBeenCalledWith(true);
  });

  test('a plan with no time yet offers to set one', () => {
    const p = props(plan({ eventTime: null, time: 'TBD' }));
    render(React.createElement(FlockDetail, p));
    fireEvent.click(screen.getByRole('button', { name: 'Set a time' }));
    expect(p.setTimeEditHour).toHaveBeenCalledWith('9 PM');
    expect(p.setTimeEditDay).toHaveBeenCalledWith('Tonight');
    expect(p.setShowTimeEditor).toHaveBeenCalledWith(true);
  });

  test('every control the screen had is still there', () => {
    const p = props(plan());
    render(React.createElement(FlockDetail, p));
    for (const name of ['Back to your plans', 'Details', 'Directions', 'Invite', 'Open chat']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /^Change the venue/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Copper Finch/, pressed: false })).toBeInTheDocument();
    // Lock it in, with its sentence before the tap.
    expect(screen.getByText('Locking it in tells everyone the plan is on, and the done step appears afterwards.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lock it in' }));
    expect(p.confirmFlockPlan).toHaveBeenCalledWith(41);
    // One Open Chat, and it opens the chat.
    expect(screen.getAllByRole('button', { name: /Open chat/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(p.setCurrentScreen).toHaveBeenCalledWith('chatDetail');
  });

  test('with no venue the lock-in step says what it needs and offers no button', () => {
    render(React.createElement(FlockDetail, props(plan({ venue: 'TBD', venueId: null }))));
    expect(screen.getByText('Pick a venue and you can lock the plan in.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();
  });
});

describe('everyone else', () => {
  const member = { authUser: { id: 11 } };

  test('reads the time once, and has no editor and no lock-in step', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan(), member)));
    expect(occurrences(container.textContent, WHEN)).toBe(1);
    expect(screen.queryByRole('button', { name: /Change the time/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();
    expect(container.textContent).not.toContain('Locking it in');
    expect(screen.getByRole('button', { name: /^Vote on venues/ })).toBeInTheDocument();
  });

  test('a plan with no time says so, in the words the chat header uses', () => {
    render(React.createElement(FlockDetail, props(plan({ eventTime: null, time: 'TBD' }), member)));
    expect(screen.getByText('Time still open')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set a time' })).toBeNull();
  });

  test('when everyone asked is going, the count is just the count', () => {
    const flock = plan({ members: [HOST, { id: 11, name: 'Jo Park', status: 'accepted' }] });
    render(React.createElement(FlockDetail, props(flock, member)));
    expect(screen.getByRole('heading', { name: 'Going (2)' })).toBeInTheDocument();
  });

  test('a guest who answered the link is asked and going like anyone', () => {
    const flock = plan({ guests: [{ id: 'g-1', guestId: 1, name: 'Casey', status: 'accepted', isGuest: true }, { id: 'g-2', guestId: 2, name: 'Riley', status: 'out', isGuest: true }] });
    render(React.createElement(FlockDetail, props(flock, member)));
    expect(screen.getByRole('heading', { name: 'Going (4 of 7)' })).toBeInTheDocument();
  });

  // refreshFlockRoster leaves accepted members only in flock.members, and it
  // runs while this screen is open (a block, the night-of window, a host
  // handoff) and fills the roster when the plan is opened from its chat. Both
  // loaders keep askedIds (lib/planAsked.js), so the count does not move.
  test('the count is the same whichever App.js loader filled the roster', () => {
    const full = plan();
    const askedIds = full.members.map((m) => String(m.id));
    const acceptedOnly = full.members.filter((m) => m.status === 'accepted');
    const { unmount } = render(React.createElement(FlockDetail, props(plan({ askedIds }), member)));
    expect(screen.getByRole('heading', { name: 'Going (3 of 5)' })).toBeInTheDocument();
    unmount();
    const r = render(React.createElement(FlockDetail, props(plan({ members: acceptedOnly, askedIds }), member)));
    expect(screen.getByRole('heading', { name: 'Going (3 of 5)' })).toBeInTheDocument();
    r.unmount();
    const out = [{ id: 'g-2', guestId: 2, name: 'Riley', status: 'declined', isGuest: true }];
    render(React.createElement(FlockDetail, props(plan({ members: acceptedOnly, askedIds, guests: out }), member)));
    expect(screen.getByRole('heading', { name: 'Going (3 of 6)' })).toBeInTheDocument();
  });

  test('a member who said no was asked, so the host reads one of two', () => {
    render(React.createElement(FlockDetail, props(plan({ members: [HOST, { id: 11, name: 'Bea Cole', status: 'declined' }] }))));
    expect(screen.getByRole('heading', { name: 'Going (1 of 2)' })).toBeInTheDocument();
  });
});

describe('a plan that has ended', () => {
  test('a cancelled plan says Cancelled once, never Done, and its time cannot move', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan({ status: 'cancelled' }))));
    const text = container.textContent;
    expect(occurrences(text, 'Cancelled')).toBe(1);
    expect(text).not.toContain('Done');
    expect(occurrences(text, WHEN)).toBe(1);
    expect(screen.queryByRole('button', { name: /Change the time/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();
  });

  test('an ended plan that never had a time draws no time at all', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan({ status: 'cancelled', eventTime: null, time: 'TBD' }))));
    expect(container.textContent).not.toContain('Time still open');
    expect(screen.queryByRole('button', { name: 'Set a time' })).toBeNull();
  });
});

describe('the header keeps its focus ring visible on navy', () => {
  test('both header controls draw the near-white ring', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan())));
    expect(screen.getByRole('button', { name: 'Back to your plans' }).classList.contains('plan-head-control')).toBe(true);
    expect(screen.getByRole('button', { name: `Change the time, ${WHEN}` }).classList.contains('plan-head-control')).toBe(true);
    expect(container.querySelectorAll('.plan-head-control')).toHaveLength(2);
    // jsdom has no :focus-visible, so the rule itself is pinned.
    expect(read('index.css')).toMatch(/\.plan-head-control:focus-visible\s*\{\s*outline-color:\s*rgba\(255,255,255,0\.9\);\s*\}/);
  });
});
