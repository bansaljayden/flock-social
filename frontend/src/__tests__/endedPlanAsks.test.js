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
//   A LOCKED-IN PLAN ASKS HOW IT WAS AN HOUR AFTER ITS TIME, not only once it
//   is completed. Most hosts never slide "done", so most plans are completed
//   by the sweep 12 hours after their time, which is when routes/feedback.js
//   used to stop verifying a member's report. The card used to appear just
//   after the answer stopped counting. lib/planNight.js decides the hour.
//   The Nest asks later, the morning after (nestAsksHowItWas, built on the same
//   function), because it is the screen every open lands on. Since 2026-11-06
//   the answer of a member who had said yes by an hour after the plan began
//   counts until noon the day after the plan, venue time, and the thanks after
//   the window says when it shut; the Nest stops asking at that same moment.
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

describe('a locked-in plan whose night is over', () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  test('asks how it was an hour after its time, before anyone slides done', () => {
    const lastNight = endedFlock('confirmed', { eventTime: hoursAgo(2) });
    for (const viewer of [HOST, MEMBER]) {
      render(React.createElement(FlockDetail, detailProps(lastNight, { authUser: { id: viewer } })));
      expect(screen.getByText('How was The Vault?')).toBeInTheDocument();
      cleanup();
    }
  });

  test('is not asked while the night is still on, or before it starts', () => {
    for (const eventTime of [hoursAgo(0.5), hoursAgo(-3)]) {
      render(React.createElement(FlockDetail, detailProps(endedFlock('confirmed', { eventTime }))));
      expect(screen.queryByText('How was The Vault?')).toBeNull();
      cleanup();
    }
  });

  test('is not asked of a plan nobody locked in, whose night may not have happened', () => {
    render(React.createElement(FlockDetail, detailProps(endedFlock('voting', { eventTime: hoursAgo(2) }))));
    expect(screen.queryByText('How was The Vault?')).toBeNull();
  });

  test('is asked once: an answered or skipped plan stays answered', () => {
    const lastNight = endedFlock('confirmed', { eventTime: hoursAgo(2) });
    render(React.createElement(FlockDetail, detailProps(lastNight, { submittedFeedback: new Set([lastNight.id]) })));
    expect(screen.queryByText('How was The Vault?')).toBeNull();
  });

  test('still leaves attendance to the done step, which the server takes only once completed', () => {
    render(React.createElement(FlockDetail, detailProps(endedFlock('confirmed', { eventTime: hoursAgo(2) }))));
    expect(screen.queryByText('Who showed up?')).toBeNull();
    expect(screen.getByText('Night done? Slide to complete')).toBeInTheDocument();
  });
});

describe('a plan called off while its card is open', () => {
  // The card is drawn from the plan as this screen last loaded it. When the
  // plan is cancelled in between, POST /api/feedback answers 409 with
  // PLAN_CANCELLED. Submitting again cannot succeed, so the card is put away
  // with the server's own sentence instead of staying up behind an error.
  const { submitVenueFeedback } = require('../services/api');
  const { fireEvent, waitFor } = require('@testing-library/react');
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const answered = { crowdLevel: 'moderate', priceWorth: null, rating: null };

  function refusal(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    err.status = 409;
    return err;
  }

  test('puts the card away and says why, without an error toast', async () => {
    submitVenueFeedback.mockReset();
    submitVenueFeedback.mockRejectedValue(
      refusal('That plan was called off, so there is no night to report on.', 'PLAN_CANCELLED'));
    const props = detailProps(endedFlock('confirmed', { eventTime: hoursAgo(2) }), { feedbackState: answered });
    render(React.createElement(FlockDetail, props));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(props.setFeedbackSubmitting).toHaveBeenLastCalledWith(false));
    expect(props.rememberFeedbackDone).toHaveBeenCalledWith(41);
    expect(props.setFeedbackState).toHaveBeenCalledWith({ crowdLevel: null, priceWorth: null, rating: null });
    expect(props.showToast).toHaveBeenCalledTimes(1);
    expect(props.showToast.mock.calls[0]).toEqual(['That plan was called off, so there is no night to report on.']);
  });

  test('any other failure keeps the card up to try again, with an error toast', async () => {
    submitVenueFeedback.mockReset();
    submitVenueFeedback.mockRejectedValue(refusal('Too many reports in a short time. Try again later.'));
    const props = detailProps(endedFlock('confirmed', { eventTime: hoursAgo(2) }), { feedbackState: answered });
    render(React.createElement(FlockDetail, props));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(props.setFeedbackSubmitting).toHaveBeenLastCalledWith(false));
    expect(props.rememberFeedbackDone).not.toHaveBeenCalled();
    expect(props.showToast).toHaveBeenCalledWith('Too many reports in a short time. Try again later.', 'error');
  });
});

describe('the thanks says whether the answer counts, and when the window shut', () => {
  // routes/feedback.js counts the answer of a member who had said yes by an
  // hour after the plan began until noon the day after it on the venue's
  // clock, and on a later answer from that member returns plan_window_closed
  // with the moment it shut (plan_report_closes_at).
  const { submitVenueFeedback } = require('../services/api');
  const { fireEvent, waitFor } = require('@testing-library/react');
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const answered = { crowdLevel: 3, priceWorth: null, rating: null };

  async function submitWith(answer) {
    submitVenueFeedback.mockReset();
    submitVenueFeedback.mockResolvedValue(answer);
    const props = detailProps(endedFlock('completed', { eventTime: hoursAgo(20) }), {
      authUser: { id: MEMBER },
      feedbackState: answered,
    });
    render(React.createElement(FlockDetail, props));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(props.setFeedbackSubmitting).toHaveBeenLastCalledWith(false));
    expect(props.rememberFeedbackDone).toHaveBeenCalledWith(41);
    expect(props.showToast).toHaveBeenCalledTimes(1);
    return props.showToast.mock.calls[0];
  }

  test('a counted answer is thanked as one', async () => {
    const toast = await submitWith({ verified: true, plan_window_closed: false });
    expect(toast).toEqual(['Thanks. Real reports sharpen the forecast for everyone.']);
  });

  test('an answer after the window names the moment it shut', async () => {
    // Noon today on this machine's clock, built from local fields so the words
    // do not depend on the zone the suite runs in.
    const now = new Date();
    const noonToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const toast = await submitWith({
      verified: false,
      plan_window_closed: true,
      plan_report_closes_at: noonToday.toISOString(),
    });
    expect(toast).toEqual(['Thanks. Reports on this plan counted until noon today; this one is noted.']);
  });

  test('an answer that does not count for another reason keeps the general sentence', async () => {
    for (const answer of [
      { verified: false },
      { verified: false, plan_window_closed: false, plan_report_closes_at: hoursAgo(-1) },
      { verified: false, plan_window_closed: true, plan_report_closes_at: 'not a time' },
    ]) {
      const toast = await submitWith(answer);
      expect(toast).toEqual(['Thanks. Reports from a night here with your flock go into the forecast; this one is noted.']);
      cleanup();
    }
  });
});

describe('the Nest reads the same hour', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  const i = APP.indexOf('const HomeScreen = () => {');
  const home = APP.slice(i, i + 40000);

  // THE NEST ASKS THE MORNING AFTER (2026-11-06). The plan screen asks an
  // hour after a plan's time, for whoever opens it. The Nest is different: it
  // is what a person sees on every open, and from an hour in its biggest
  // button asked "How was The Copper Finch?" of a night the reader was most
  // likely still at. A night is judged by its peak and its end, so the Nest
  // leaves the peak alone and asks once the night has rolled over at 4 AM,
  // until the answer stops counting: lib/planNight.js nestAsksHowItWas, which
  // reads finished plans too, because the sweep completes a plan 12 hours
  // after its time and the live list lets it go at that moment.
  //
  // UNTIL NOON, NOT THE NEXT 4 AM (2026-11-07). The server counts a member's
  // answer until noon the day after the plan's night, or 12 hours after its
  // start when that is later (backend utils/planReportWindow.js). The Nest
  // asked until the following 4 AM, so for an 8:33 PM plan its row stood for
  // 16 hours over an answer the plan screen could only thank as "noted".
  const { nestAsksHowItWas } = require('../lib/planNight');
  const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);
  const trivia = (over = {}) => ({ id: 1, status: 'confirmed', venue: 'The Copper Finch', venueId: 'p1', eventTime: at(6, 20, 33).toISOString(), ...over });

  test.each([
    ['an hour in', at(6, 21, 33), false],
    ['at 12:40 AM, the same night', at(7, 0, 40), false],
    ['at 3:59 AM', at(7, 3, 59), false],
    ['at 4 AM, the morning after', at(7, 4, 0), true],
    ['at 11:59 AM, the last minute the answer counts', at(7, 11, 59), true],
    ['at noon, when the answer stops counting', at(7, 12, 0), false],
    ['the afternoon after', at(7, 15, 0), false],
    ['the next night after 4 AM', at(8, 4, 0), false],
  ])('a locked-in plan, %s: %s', (_, now, want) => {
    expect(nestAsksHowItWas(trivia(), now)).toBe(want);
  });

  test('a plan the sweep or the host has completed is still asked about the morning after', () => {
    expect(nestAsksHowItWas(trivia({ status: 'completed' }), at(7, 10, 0))).toBe(true);
    expect(nestAsksHowItWas(trivia({ status: 'completed' }), at(7, 12, 0))).toBe(false);
  });

  test('a plan after midnight keeps its 12 hours: a 1 AM plan is asked about until 1 PM', () => {
    // 1 AM Saturday is Friday's night, so its noon comes 11 hours in; the
    // server's 12-hour floor is the later of the two, and so is the Nest's.
    const late = trivia({ eventTime: at(7, 1, 0).toISOString() });
    expect(nestAsksHowItWas(late, at(7, 3, 59))).toBe(false);
    expect(nestAsksHowItWas(late, at(7, 4, 0))).toBe(true);
    expect(nestAsksHowItWas(late, at(7, 12, 30))).toBe(true);
    expect(nestAsksHowItWas(late, at(7, 13, 0))).toBe(false);
  });

  test('a daytime plan is asked about the next morning, until noon', () => {
    const brunch = trivia({ eventTime: at(7, 11, 0).toISOString() });
    expect(nestAsksHowItWas(brunch, at(7, 16, 0))).toBe(false);
    expect(nestAsksHowItWas(brunch, at(8, 4, 0))).toBe(true);
    expect(nestAsksHowItWas(brunch, at(8, 11, 59))).toBe(true);
    expect(nestAsksHowItWas(brunch, at(8, 12, 0))).toBe(false);
  });

  test('never a cancelled plan, a plan nobody locked in, or one with no place to rate', () => {
    expect(nestAsksHowItWas(trivia({ status: 'cancelled' }), at(7, 10, 0))).toBe(false);
    expect(nestAsksHowItWas(trivia({ status: 'voting' }), at(7, 10, 0))).toBe(false);
    expect(nestAsksHowItWas(trivia({ venueId: null }), at(7, 10, 0))).toBe(false);
    expect(nestAsksHowItWas(trivia({ venue: 'TBD' }), at(7, 10, 0))).toBe(false);
    expect(nestAsksHowItWas(trivia({ eventTime: null }), at(7, 10, 0))).toBe(false);
  });

  test('the Nest flags its plans from that rule, finished plans included, and never one already answered', () => {
    expect(APP).toMatch(/import \{ nestAsksHowItWas \} from '\.\/lib\/planNight';/);
    expect(home).toMatch(/askHowItWas: nestAsksHowItWas\(f\) && !submittedFeedback\.has\(f\.id\),/);
    expect(home).toMatch(/const nestRateList = flocks\.filter\(\(f\) => nestAsksHowItWas\(f, nestNow\) && !submittedFeedback\.has\(f\.id\)\)\.map\(\(f\) => \(\{ \.\.\.f, askHowItWas: true \}\)\);/);
    expect(home).toMatch(/howWasIt: nestRateList/);
  });

  // The chip is lib/nestHero.js planChip, the reader's own state.
  const { planChip } = require('../lib/nestHero');
  const { heroAction } = require('../lib/nestHero');

  test('its chip asks instead of saying Locked in', () => {
    const over = { id: 1, status: 'confirmed', askHowItWas: true, venue: 'Juniper Bowl' };
    expect(planChip(over).label).toBe('How was it?');
    expect(planChip({ ...over, askHowItWas: false }).label).toBe('Locked in');
    expect(home).toMatch(/chip: planChip\(f, \{/);
  });

  test('the hero never asks how it was; the row the morning after opens the plan screen', () => {
    expect(heroAction({ id: 1, status: 'confirmed', askHowItWas: true, venue: 'Juniper Bowl' }, [])).toBeNull();
    expect(home).toMatch(/if \(kind === 'vote' \|\| kind === 'how'\) \{ setCurrentScreen\('detail'\); return; \}/);
    expect(home).toMatch(/const openPlan = \(flockId\) => \{ setSelectedFlockId\(flockId\); setCurrentScreen\('detail'\); \};/);
    expect(home).toMatch(/onClick: \(\) => openPlan\(f\.id\),/);
  });
});
