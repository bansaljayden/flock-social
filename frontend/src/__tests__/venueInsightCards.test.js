/**
 * ROOST, THE ADVISOR'S T0 SURFACE — VenueInsightCards.js
 *
 * Fixtures mirror what routes/advisor.js actually serves (verified against
 * services/advisorFacts.js 2026-08-19): facts are { id, value, source, asOf,
 * label, note? }, refusals are { id, status: 'refused', reason,
 * whatWouldUnlock } living INSIDE the facts array, and the envelope is
 * { available, cards, generatedAt }.
 *
 * What this suite pins:
 *   1. NOTHING INVENTED. Labels print verbatim; every fact row carries its
 *      source in plain words and its date; non-date asOf strings (the frozen
 *      corpus line, "owner-set ...") render verbatim rather than being
 *      squeezed through Date.parse into a precision they do not have.
 *   2. REFUSAL IS A FIRST-CLASS STATE with no upsell and no button.
 *   3. The week scrubber, the daypart-aware lead card, and the optimistic
 *      slider reflection actually respond to input.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venueInsightCards --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor, within } = require('@testing-library/react');

const VenueInsightCards = require('../components/VenueInsightCards').default;
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'VenueInsightCards.js'), 'utf8');

// A fixed clock: Aug 19 2026, 9:00 PM local. Every fixture date hangs off it.
const NOW = new Date(2026, 7, 19, 21, 0, 0);
const MORNING = new Date(2026, 7, 19, 7, 30, 0);
const NOON = new Date(2026, 7, 19, 12, 0, 0);

const D = (n) => `2026-08-${String(n).padStart(2, '0')}`;
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const wd = (n) => WD[new Date(2026, 7, n).getDay()];

const peakFact = (n, hour, score) => ({
  id: `peak_${D(n)}`,
  value: { date: D(n), weekday: wd(n), peakHour: hour, peakScore: score },
  source: 'model_holdout',
  asOf: '2026-08-19T20:00:00Z',
  predictionMethod: 'ml',
  label: `${wd(n)} projects busiest around ${hour - 12} PM, at ${score} on our 0 to 100 index. This is an estimate, not a promise of foot traffic.`,
});

const PAYLOAD = {
  available: true,
  generatedAt: '2026-08-19T20:00:00Z',
  cards: [
    {
      id: 'week_ahead',
      title: 'Week ahead',
      status: 'ok',
      facts: [
        peakFact(19, 21, 64),
        peakFact(20, 22, 41),
        {
          id: `refuse_peak_${D(21)}`,
          status: 'refused',
          reason: `${wd(21)} was scored by category rules, not by the model, so the number would be the same for every venue like yours. We do not present that as your forecast.`,
          whatWouldUnlock: 'A model scored evening for this venue. The baseline curve exists, so this is usually transient.',
        },
        peakFact(22, 22, 78),
        peakFact(23, 20, 52),
        peakFact(24, 20, 33),
        peakFact(25, 21, 45),
      ],
    },
    {
      id: 'around_you',
      title: 'Around you this week',
      status: 'ok',
      facts: [
        {
          id: `event_${D(19)}`,
          value: { date: D(19), weekday: wd(19), name: 'Stadium show', distanceKm: 0.4 },
          source: 'events',
          asOf: '2026-08-19T20:00:00Z',
          note: 'A ticketed listing near you. Whether an event night feeds your room or drains it is not something we can measure yet.',
          label: `${wd(19)}: a listed event about 0.4 km away, Stadium show.`,
        },
        {
          id: `weather_${D(21)}`,
          value: { date: D(21), weekday: wd(21), conditions: 'light rain', middayTempF: 74 },
          source: 'weather',
          asOf: '2026-08-19T20:00:00Z',
          label: `${wd(21)} ${D(21)}: light rain, around 74 F midday.`,
        },
      ],
    },
    {
      id: 'listing_read_back',
      title: 'Your listing, read back',
      status: 'ok',
      facts: [
        {
          id: 'intake_kitchen_last_order',
          value: '21:00',
          source: 'intake',
          asOf: 'owner-set 2026-08-18',
          label: 'You told us the kitchen takes last orders at 21:00.',
        },
        {
          id: 'google_baseline_busy_nights',
          value: { nights: ['Friday', 'Saturday'] },
          source: 'google_baseline',
          asOf: '2026-05-18 (corpus frozen, collected spring 2026)',
          label: "Your Google profile's strongest evenings in the spring 2026 corpus: Friday, Saturday.",
        },
        {
          id: 'prompt_capacity',
          status: 'refused',
          reason: 'You have not told us your capacity.',
          whatWouldUnlock: 'Add it in venue settings and the 0 to 100 index turns into people.',
        },
      ],
    },
    {
      id: 'readings_vs_estimates',
      title: 'What you said vs what we estimated',
      status: 'ok',
      facts: [
        {
          id: `owner_reading_${D(18)}`,
          value: { date: D(18), peakReading: 70, readings: 2 },
          source: 'owner_report',
          asOf: D(18),
          label: `Your highest reading on ${D(18)} was 70, from 2 readings. Your own numbers, read back.`,
        },
        {
          id: 'refuse_no_served_predictions',
          status: 'refused',
          reason: 'Flock has not served predictions for your venue in the last 7 days.',
          whatWouldUnlock: 'Users looking at your venue. Serves are logged the moment they happen.',
        },
      ],
    },
  ],
};

const ok = () => Promise.resolve(PAYLOAD);
const mount = (props = {}) => render(React.createElement(VenueInsightCards, { fetchCards: ok, now: NOW, ...props }));

beforeEach(() => {
  window.localStorage.clear();
});

describe('Roost: served facts render verbatim with their provenance', () => {
  test('labels, sources, and dates come through untouched', async () => {
    mount();
    expect(await screen.findByText('Roost')).toBeInTheDocument();
    expect(screen.getByText('You told us the kitchen takes last orders at 21:00.')).toBeInTheDocument();
    // Owner-asserted facts say so in plain words, with the owner's own
    // non-date asOf phrase kept verbatim.
    expect(screen.getByText('you told us, owner-set 2026-08-18.')).toBeInTheDocument();
    // The frozen corpus keeps its parenthetical; Date.parse never sees it.
    expect(screen.getByText("Google's pattern, 2026-05-18 (corpus frozen, collected spring 2026).")).toBeInTheDocument();
    // Model facts carry the estimate chip with a real formatted date.
    expect(screen.getAllByText(/our estimate, as of Aug 19\./).length).toBeGreaterThan(0);
    // Event facts keep their hedging note.
    expect(screen.getAllByText(/Whether an event night feeds your room or drains it/).length).toBeGreaterThan(0);
  });

  test('refusals show the reason and the path, with no upsell and no button', async () => {
    mount();
    expect(await screen.findByText('You have not told us your capacity.')).toBeInTheDocument();
    expect(screen.getByText(/Add it in venue settings/)).toBeInTheDocument();
    expect(screen.getByText(/Flock has not served predictions/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/upgrade/i);
    // The only buttons on a served screen are the day chips and the
    // first-run dismissal. None of them sells anything.
    for (const b of document.querySelectorAll('button')) {
      expect(b.textContent).not.toMatch(/upgrade|plan|pro|premium/i);
    }
  });
});

describe('Roost: the week scrubber', () => {
  test('renders a chip per day, defaults to today, and swaps the panel on tap', async () => {
    mount();
    await screen.findByText('Week ahead');
    const group = screen.getByRole('group', { name: 'Pick a day' });
    const chips = within(group).getAllByRole('button');
    expect(chips.length).toBe(7);

    // Today is selected by default and today's forecast shows.
    const pressed = chips.filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(pressed.length).toBe(1);
    expect(pressed[0].textContent).toContain('19');
    expect(screen.getAllByText(peakFact(19, 21, 64).label).length).toBeGreaterThan(0);
    // Other days' forecasts are not on screen yet.
    expect(screen.queryByText(peakFact(23, 20, 52).label)).toBeNull();

    // Tap the 23rd: its forecast appears, today's leaves the scrubber panel.
    fireEvent.click(chips.find((c) => c.textContent.includes('23')));
    expect(screen.getByText(peakFact(23, 20, 52).label)).toBeInTheDocument();
    const nowPressed = within(group).getAllByRole('button').filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(nowPressed.length).toBe(1);
    expect(nowPressed[0].textContent).toContain('23');
  });

  test('a refused day is selectable and shows the refusal as its content', async () => {
    mount();
    await screen.findByText('Week ahead');
    const group = screen.getByRole('group', { name: 'Pick a day' });
    const chip21 = within(group).getAllByRole('button').find((c) => c.textContent.includes('21'));
    // Before selection the weather line exists once, in the Around-you card.
    expect(screen.getAllByText(/light rain, around 74 F midday/).length).toBe(1);
    fireEvent.click(chip21);
    // The refusal is the day's honest content.
    expect(screen.getByText(/scored by category rules/)).toBeInTheDocument();
    // And that day's known context joins it: the weather line now also
    // renders inside the scrubber panel.
    expect(screen.getAllByText(/light rain, around 74 F midday/).length).toBe(2);
  });
});

describe('Roost: the daypart-aware lead card', () => {
  test('an evening with no listed hours leads with Tonight', async () => {
    mount({ now: NOW });
    expect(await screen.findByRole('heading', { name: 'Tonight' })).toBeInTheDocument();
  });

  test('a morning venue open by its listed hours leads with This morning', async () => {
    mount({ now: MORNING, operatingHours: [{ days: 'daily', open: '6am', close: '2pm' }] });
    expect(await screen.findByRole('heading', { name: 'This morning' })).toBeInTheDocument();
  });

  test('midday reads Today', async () => {
    mount({ now: NOON, operatingHours: [{ days: 'daily', open: '6am', close: '2pm' }] });
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });

  test('a venue closed by its own listed hours leads with its next opening', async () => {
    // A lunch spot at 9 PM: closed now, next open tomorrow morning.
    mount({ now: NOW, operatingHours: [{ days: 'Mon-Fri', open: '7am', close: '2 PM' }] });
    expect(await screen.findByRole('heading', { name: 'When you open next' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Next up: ${wd(20)}\\.`))).toBeInTheDocument();
    // And it leads with that day's outlook, not tonight's.
    expect(screen.getAllByText(peakFact(20, 22, 41).label).length).toBeGreaterThan(0);
  });

  test('unparseable hours make no open or closed claims', async () => {
    mount({ now: NOW, operatingHours: [{ days: 'ask us', open: 'varies', close: 'late' }] });
    expect(await screen.findByRole('heading', { name: 'Tonight' })).toBeInTheDocument();
    expect(screen.queryByText(/Closed right now/)).toBeNull();
  });
});

describe('Roost: the slider reflects instantly', () => {
  test('a new live reading appears the moment the prop lands', async () => {
    const view = mount({ liveReading: null });
    await screen.findByText('Roost');
    expect(screen.queryByText(/Users currently see/)).toBeNull();

    view.rerender(React.createElement(VenueInsightCards, {
      fetchCards: ok, now: NOW, liveReading: { percent: 62, expiresAt: '2026-08-20T02:30:00Z' },
    }));
    const rows = await screen.findAllByText('Users currently see 62% full, set by you.');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getAllByText('your reading, live now.').length).toBe(rows.length);
  });
});

describe('Roost: the first-run note', () => {
  test('explains refusals once, then stays dismissed', async () => {
    const view = mount();
    expect(await screen.findByText(/instead of guessing/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Got it'));
    expect(screen.queryByText(/instead of guessing/)).toBeNull();
    expect(window.localStorage.getItem('flock_advisor_refusal_note_seen')).toBe('1');

    view.unmount();
    mount();
    await screen.findByText('Roost');
    expect(screen.queryByText(/instead of guessing/)).toBeNull();
  });
});

describe('Roost: envelope and failure states', () => {
  test('an unavailable envelope shows the server reason as a designed answer', async () => {
    mount({ fetchCards: () => Promise.resolve({ available: false, reason: 'Link your Google listing in Edit Profile to see advisor cards', cards: [] }) });
    expect(await screen.findByText(/Link your Google listing/)).toBeInTheDocument();
  });

  test('a network failure gets a retry that actually retries', async () => {
    let calls = 0;
    const fetchCards = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('boom')) : ok();
    };
    mount({ fetchCards });
    fireEvent.click(await screen.findByText('Try again'));
    expect(await screen.findByText('Week ahead')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  test('a 403 repeats the server tier line instead of guessing', async () => {
    const err = new Error('forbidden');
    err.status = 403;
    err.data = { error: 'The advisor is part of the Pro plan.' };
    mount({ fetchCards: () => Promise.reject(err) });
    expect(await screen.findByText('The advisor is part of the Pro plan.')).toBeInTheDocument();
  });

  test('an empty cards array renders nothing rather than an apology', async () => {
    const { container } = mount({ fetchCards: () => Promise.resolve({ available: true, cards: [] }) });
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  test('no fetchCards means no render at all', () => {
    const { container } = render(React.createElement(VenueInsightCards, {}));
    expect(container.firstChild).toBeNull();
  });

  test('a locked card names its plan quietly, without a button', async () => {
    const payload = {
      available: true,
      cards: [
        PAYLOAD.cards[0],
        { id: 'around_you', title: 'Around you this week', status: 'locked', facts: [], requiredTier: 'premium', code: 'UPGRADE_REQUIRED' },
      ],
    };
    mount({ fetchCards: () => Promise.resolve(payload) });
    expect(await screen.findByText('Part of the Premium plan.')).toBeInTheDocument();
  });
});

describe('Roost: SLOP pins on the source itself', () => {
  test('no em dash anywhere in the file, and no literal en dash either', () => {
    // SLOP-AUDIT A2/H18. The dash-normalizing regex uses escape sequences so
    // even the character class carries no literal dash.
    expect(SRC).not.toContain(String.fromCharCode(0x2014));
    expect(SRC).not.toContain(String.fromCharCode(0x2013));
  });

  test('the component ships no digits of its own copy', () => {
    // Every number on screen must come from a fact object or a prop. JSX
    // text segments (what can reach the screen outside an expression) may
    // not contain digits.
    const segments = (SRC.match(/>(?:[^<>{}]*)</g) || [])
      .map((s) => s.slice(1, -1))
      // A ">" also ends comparison operators in plain JS, so drop anything
      // that reads as code rather than a text node.
      .filter((s) => s.trim() && !/[;()=&|]/.test(s));
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s).not.toMatch(/\d/);
    }
  });

  test('no invented-benchmark or upsell vocabulary', () => {
    expect(SRC).not.toMatch(/\dx more/i);
    expect(SRC).not.toMatch(/venues like you/i);
    expect(SRC).not.toMatch(/coming soon/i);
    expect(SRC).not.toMatch(/upgrade to (see|unlock)/i);
    expect(SRC).not.toMatch(/unlock deeper/i);
    expect(SRC).not.toMatch(/seamless|effortless/i);
  });

  test('the feature name lives behind one constant', () => {
    expect(SRC).toContain("const FEATURE_NAME = 'Roost';");
    // The word appears once in the constant and nowhere else in copy, so a
    // rename stays a one-line change.
    expect(SRC.match(/'Roost'/g).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE VERDICT LEADS THE STACK.
//
// "How did we just do" is the most asked question in the operator category and
// explicit forecasting is the least asked (Toast prompt telemetry across
// 125,000+ locations, ROOST-OWNER-INPUT.md), so the verdict on yesterday
// renders above the week-ahead forecast rather than falling through to the
// generic tail this file keeps for cards it has never met.
// ---------------------------------------------------------------------------
describe('Roost: the verdict card leads', () => {
  const verdictCard = {
    id: 'last_night_verdict',
    title: 'Yesterday, against your own numbers',
    status: 'ok',
    facts: [{
      id: 'last_day_verdict_2026-08-18',
      value: { verdict: 'below' },
      source: 'arithmetic',
      asOf: D(18),
      label: 'Tuesday came in 39 points below your own Tuesdays (middle 59, across 4 days).',
    }],
  };

  test('it renders before the week ahead, not after every other card', async () => {
    const payload = { ...PAYLOAD, cards: [...PAYLOAD.cards, verdictCard] };
    const { container } = mount({ fetchCards: () => Promise.resolve(payload) });
    await screen.findByText('Yesterday, against your own numbers');
    const text = container.textContent;
    expect(text.indexOf('Yesterday, against your own numbers'))
      .toBeLessThan(text.indexOf('Week ahead'));
  });

  test('with no reading yesterday the refusal is the card, with no button', async () => {
    const refused = {
      id: 'last_night_verdict',
      title: 'Yesterday, against your own numbers',
      status: 'refused',
      facts: [{
        id: 'refuse_no_reading_2026-08-18',
        status: 'refused',
        reason: 'You did not post a reading on Tuesday 2026-08-18, so there is no measurement of your room that day for us to grade.',
        whatWouldUnlock: 'One move of the busy slider at your busiest hour.',
      }],
    };
    const payload = { ...PAYLOAD, cards: [refused] };
    const { container } = mount({ fetchCards: () => Promise.resolve(payload) });
    await screen.findByText('Yesterday, against your own numbers');
    expect(screen.getByText(/One move of the busy slider/)).toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /upgrade|unlock/i })).toBeNull();
  });
});
