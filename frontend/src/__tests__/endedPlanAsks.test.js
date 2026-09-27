// ---------------------------------------------------------------------------
// WHAT THE PLAN SCREEN ASKS ONCE A PLAN HAS ENDED, AND WHEN.
//
// Two asks live on screens/FlockDetail.js after a night: the host's "Who showed
// up?" banner, which opens the attendance sheet, and everyone's "How was
// {venue}?" card, which files a crowd report.
//
//   A CANCELLED PLAN GETS NEITHER. Both used to be gated on isCompleted, which
//   covers 'cancelled' too. POST /api/flocks/:id/attendance answers 400 for
//   anything but 'completed', so the host's banner could never be cleared, and
//   the report was a rating of a night that did not happen (the server now
//   refuses it with a 409). flockSweep cancels every plan nobody locked in, so
//   this was the most common way a plan ended.
//
// The screen is rendered for real, from its own parameter list, so a prop
// added to it arrives here as a function and cannot quietly take a falsy
// branch that makes a test pass for the wrong reason.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test endedPlanAsks --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, cleanup } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  submitVenueFeedback: jest.fn(),
}));

const FlockDetail = require('../screens/FlockDetail').default;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'FlockDetail.js'), 'utf8').replace(/\r\n/g, '\n');

// Every name in the component's destructured parameter list.
const PARAMS = (() => {
  const start = SRC.indexOf('export default function FlockDetail({');
  const end = SRC.indexOf('}) {', start);
  return SRC.slice(start, end)
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .flatMap((l) => l.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
})();

const HOST = 9;
const MEMBER = 2;

function detailProps(flock, over = {}) {
  const props = {};
  for (const name of PARAMS) props[name] = jest.fn();
  Object.assign(props, {
    DialogBehavior: () => null,
    MissingFlockPanel: () => null,
    MOMENTUM_STAGES: [],
    authUser: { id: HOST },
    checkinSaving: false,
    colors: {},
    confirmingPlan: false,
    crowdPredictions: {},
    feedbackState: { crowdLevel: null, priceWorth: null, rating: null },
    feedbackSubmitting: false,
    getSelectedFlock: () => flock,
    recapSharing: false,
    rerunningFlockId: null,
    rosterError: null,
    savingEventTime: false,
    selectedFlockId: flock.id,
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
    voteTotal: () => 0,
  }, over);
  return props;
}

// A plan whose night was last night, at a real venue, with a roster nobody
// has marked yet. Only the status changes between the cases below.
function endedFlock(status, extra = {}) {
  return {
    id: 41,
    name: 'Friday',
    host: 'Ava',
    creatorId: HOST,
    status,
    venue: 'The Vault',
    venueId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
    eventTime: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
    time: 'Last night',
    members: [
      { id: HOST, name: 'Ava', status: 'accepted', attendance: 'unmarked' },
      { id: MEMBER, name: 'Ben', status: 'accepted', attendance: 'unmarked' },
    ],
    guests: [],
    votes: [],
    ...extra,
  };
}

afterEach(cleanup);

test('the parameter list was read, so every prop below is a real one', () => {
  // A regression in the parser would hand the screen an empty props object and
  // every "is not shown" below would pass on nothing.
  expect(PARAMS.length).toBeGreaterThan(50);
  for (const name of ['getSelectedFlock', 'submittedFeedback', 'openAttendanceSheet', 'authUser']) {
    expect(PARAMS).toContain(name);
  }
});

describe('a completed plan', () => {
  test('asks the host who showed up, and asks how the venue was', () => {
    render(React.createElement(FlockDetail, detailProps(endedFlock('completed'))));
    expect(screen.getByText('Who showed up?')).toBeInTheDocument();
    expect(screen.getByText('How was The Vault?')).toBeInTheDocument();
  });

  test('asks a member how it was, and leaves attendance to the host', () => {
    render(React.createElement(FlockDetail, detailProps(endedFlock('completed'), { authUser: { id: MEMBER } })));
    expect(screen.queryByText('Who showed up?')).toBeNull();
    expect(screen.getByText('How was The Vault?')).toBeInTheDocument();
  });

  test('stops asking who showed up once everyone is marked', () => {
    const marked = endedFlock('completed', {
      members: [
        { id: HOST, name: 'Ava', status: 'accepted', attendance: 'attended' },
        { id: MEMBER, name: 'Ben', status: 'accepted', attendance: 'no_show' },
      ],
    });
    render(React.createElement(FlockDetail, detailProps(marked)));
    expect(screen.queryByText('Who showed up?')).toBeNull();
  });
});

describe('a cancelled plan', () => {
  test('never asks the host who showed up, because the server will not take the answer', () => {
    render(React.createElement(FlockDetail, detailProps(endedFlock('cancelled'))));
    expect(screen.queryByText('Who showed up?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark it' })).toBeNull();
  });

  test('never asks anyone to rate a night that did not happen', () => {
    for (const viewer of [HOST, MEMBER]) {
      render(React.createElement(FlockDetail, detailProps(endedFlock('cancelled'), { authUser: { id: viewer } })));
      expect(screen.queryByText('How was The Vault?')).toBeNull();
      cleanup();
    }
  });

  test('still reads as cancelled and still offers the same plan again', () => {
    render(React.createElement(FlockDetail, detailProps(endedFlock('cancelled'))));
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Do Friday again' })).toBeInTheDocument();
  });
});
