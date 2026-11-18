// ---------------------------------------------------------------------------
// THE "HOW WAS IT?" ANSWERS BELONG TO THE PLAN THEY WERE PICKED ON.
//
// App.js holds one feedback draft for every plan screen. Answers picked on one
// plan's card and left there were drawn on the next plan's card, and Submit
// there filed them under that plan's id: a crowd report about a night the
// person may not have rated at all. Skip put the card away and left the
// answers standing for the next one. The draft now carries its plan's id and
// reads as empty on any other plan, and Skip empties it.
//
// Rendered for real from FlockDetail's own parameter list, the way
// endedPlanAsks.test.js does it.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test feedbackDraftPerPlan --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, cleanup, fireEvent } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  submitVenueFeedback: jest.fn(),
}));

const FlockDetail = require('../screens/FlockDetail').default;
const { submitVenueFeedback } = require('../services/api');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'FlockDetail.js'), 'utf8').replace(/\r\n/g, '\n');

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

const EMPTY = { crowdLevel: null, priceWorth: null, rating: null };

function detailProps(flock, over = {}) {
  const props = {};
  for (const name of PARAMS) props[name] = jest.fn();
  Object.assign(props, {
    DialogBehavior: () => null,
    MissingFlockPanel: () => null,
    MOMENTUM_STAGES: [],
    authUser: { id: 2 },
    checkinSaving: false,
    colors: {},
    confirmingPlan: false,
    crowdPredictions: {},
    feedbackState: EMPTY,
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

const plan = (id, venue) => ({
  id,
  name: `Plan ${id}`,
  host: 'Ava',
  creatorId: 9,
  status: 'completed',
  venue,
  venueId: `place-${id}`,
  eventTime: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
  time: 'Last night',
  members: [{ id: 2, name: 'Ben', status: 'accepted', attendance: 'attended' }],
  guests: [],
  votes: [],
});

const FRIDAY = plan(41, 'The Vault');
const SATURDAY = plan(52, 'Juniper Bowl');
// Answers picked on Friday's card, then left there.
const FRIDAYS_ANSWERS = { flockId: 41, crowdLevel: 3, priceWorth: false, rating: 2 };

afterEach(cleanup);

test('another plan\'s answers are not drawn on this card, and Submit cannot send them', () => {
  submitVenueFeedback.mockReset();
  const props = detailProps(SATURDAY, { feedbackState: FRIDAYS_ANSWERS });
  render(React.createElement(FlockDetail, props));
  expect(screen.getByText('How was Juniper Bowl?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Rate 2 stars' })).toHaveAttribute('aria-pressed', 'false');
  const submit = screen.getByRole('button', { name: 'Submit' });
  expect(submit).toBeDisabled();
  fireEvent.click(submit);
  expect(submitVenueFeedback).not.toHaveBeenCalled();
});

test('the plan\'s own answers are still its own', () => {
  render(React.createElement(FlockDetail, detailProps(FRIDAY, { feedbackState: FRIDAYS_ANSWERS })));
  expect(screen.getByRole('button', { name: 'Rate 2 stars' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Submit' })).not.toBeDisabled();
});

test('a pick on this card starts from this plan\'s answers, not the last plan\'s', () => {
  const props = detailProps(SATURDAY, { feedbackState: FRIDAYS_ANSWERS });
  render(React.createElement(FlockDetail, props));
  fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
  const update = props.setFeedbackState.mock.calls[0][0];
  expect(update(FRIDAYS_ANSWERS)).toEqual({ flockId: 52, crowdLevel: null, priceWorth: null, rating: 4 });
});

test('Skip empties the draft as well as putting the card away', () => {
  const props = detailProps(FRIDAY, { feedbackState: FRIDAYS_ANSWERS });
  render(React.createElement(FlockDetail, props));
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  expect(props.rememberFeedbackDone).toHaveBeenCalledWith(41);
  const calls = props.setFeedbackState.mock.calls.map(([arg]) => (typeof arg === 'function' ? arg(FRIDAYS_ANSWERS) : arg));
  expect(calls).toContainEqual(EMPTY);
});
