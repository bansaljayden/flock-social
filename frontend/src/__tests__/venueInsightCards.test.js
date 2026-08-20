/**
 * ADVISOR T0 INSIGHT CARDS — VenueInsightCards.js
 *
 * The advisor's first shipped form is four deterministic cards under the
 * This-week panel (ADVISOR-PRODUCT-SHAPE.md sec 5). This suite pins the two
 * properties the component exists to guarantee:
 *
 *   1. NOTHING INVENTED. Every number and every sentence on screen comes out
 *      of a fact object the server sent, and each fact row carries its
 *      source and date. The component adds chrome, never content.
 *   2. REFUSAL IS A FIRST-CLASS STATE. Most venues have no corpus data, so
 *      the refused card is the one most owners will see. It renders with the
 *      same chrome as a served card, states what exists and what would
 *      change it, and contains no upsell and no button. "Upgrade to see the
 *      answer" when the answer does not exist at any tier is the dark
 *      pattern the product doc names.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venueInsightCards --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

const VenueInsightCards = require('../components/VenueInsightCards').default;
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'VenueInsightCards.js'), 'utf8');

const SERVED = {
  cards: [
    {
      id: 'week_ahead',
      title: 'Week ahead',
      status: 'ok',
      facts: [
        { text: 'Friday projects busiest, 9 to 11pm', value: 74, source: 'Flock crowd model v2.6', asOf: 'spring 2026' },
        { text: 'Saturday evening peak', value: 61, source: 'Flock crowd model v2.6', asOf: 'spring 2026' },
      ],
    },
    {
      id: 'around_you',
      title: 'Around you this week',
      status: 'ok',
      facts: [
        { text: 'Concert 400m away on Friday, 4,000 capacity', source: 'Ticketmaster', asOf: '2026-08-19T12:00:00Z' },
      ],
    },
    {
      id: 'said_vs_estimated',
      title: 'What you said vs what we estimated',
      status: 'refused',
      facts: [
        { text: 'You set 2 live numbers this week', value: 2, source: 'your own live numbers', asOf: '2026-08-19T12:00:00Z' },
      ],
      reason: 'Flock has no estimates for the same hours yet, so there is nothing honest to compare your readings against.',
      whatWouldUnlock: 'This fills in once your venue has a week of served forecasts alongside your readings.',
    },
    {
      id: 'listing_read_back',
      title: 'Your listing, read back',
      status: 'refused',
      facts: [],
      reason: 'Your intake form is empty, so there is nothing of yours to read back yet.',
      whatWouldUnlock: 'Complete the intake questions in Edit Profile and this card builds itself from your answers.',
    },
  ],
};

describe('VenueInsightCards: served cards', () => {
  test('renders every fact as sent, with its source and date', async () => {
    render(React.createElement(VenueInsightCards, { fetchCards: () => Promise.resolve(SERVED) }));

    expect(await screen.findByText('Week ahead')).toBeInTheDocument();
    expect(screen.getByText('Friday projects busiest, 9 to 11pm')).toBeInTheDocument();
    // The value arrives in a fact object and is printed verbatim.
    expect(screen.getByText('74')).toBeInTheDocument();
    // A non-ISO asOf ("spring 2026", the frozen corpus) renders verbatim:
    // an August product quoting a spring curve must say spring.
    expect(screen.getAllByText('From Flock crowd model v2.6, as of spring 2026.').length).toBe(2);
    // ISO timestamps render as short dates.
    expect(screen.getByText(/From Ticketmaster, as of Aug 19\./)).toBeInTheDocument();
  });

  test('an empty cards array renders nothing rather than an apology', async () => {
    const { container } = render(React.createElement(VenueInsightCards, { fetchCards: () => Promise.resolve({ cards: [] }) }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  test('no fetchCards means no render at all', () => {
    const { container } = render(React.createElement(VenueInsightCards, {}));
    expect(container.firstChild).toBeNull();
  });
});

describe('VenueInsightCards: refusal is the main state, not an error', () => {
  test('a refused card shows what exists, the reason, and the path, with no button', async () => {
    render(React.createElement(VenueInsightCards, { fetchCards: () => Promise.resolve(SERVED) }));

    // What exists renders first, exactly like a served fact.
    expect(await screen.findByText('You set 2 live numbers this week')).toBeInTheDocument();
    // Then the reason, in the server's plain words.
    expect(screen.getByText(/nothing honest to compare your readings against/)).toBeInTheDocument();
    // Then what would change it.
    expect(screen.getByText(/a week of served forecasts alongside your readings/)).toBeInTheDocument();
    // A refusal with zero facts still gets full card chrome, not a shame state.
    expect(screen.getByText('Your listing, read back')).toBeInTheDocument();
    expect(screen.getByText(/nothing of yours to read back yet/)).toBeInTheDocument();

    // No upsell inside a refusal: no buttons exist anywhere in the stack.
    expect(document.querySelectorAll('button').length).toBe(0);
    expect(document.body.textContent).not.toMatch(/upgrade/i);
  });
});

describe('VenueInsightCards: failure states', () => {
  test('a network failure gets a retry that actually retries', async () => {
    let calls = 0;
    const fetchCards = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(SERVED);
    };
    render(React.createElement(VenueInsightCards, { fetchCards }));

    const retry = await screen.findByText('Try again');
    fireEvent.click(retry);
    expect(await screen.findByText('Week ahead')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  test('a 403 repeats the server\'s tier line instead of guessing', async () => {
    const err = new Error('forbidden');
    err.status = 403;
    err.data = { error: 'The advisor is part of the Pro plan.' };
    render(React.createElement(VenueInsightCards, { fetchCards: () => Promise.reject(err) }));
    expect(await screen.findByText('The advisor is part of the Pro plan.')).toBeInTheDocument();
  });
});

describe('VenueInsightCards: SLOP pins on the source itself', () => {
  test('no em dash anywhere in the file', () => {
    // SLOP-AUDIT A2/H18. Copy or comment, this file carries none, so the pin
    // can be total instead of arguing about what is visible.
    expect(SRC).not.toContain('—');
  });

  test('the component ships no digits of its own', () => {
    // Every number on screen must come from a fact object. String literals
    // in the component may not contain digits (style values like '12px' are
    // in object literals, which this regex ignores by only scanning strings
    // rendered as copy: the quoted text inside JSX expressions).
    const copyStrings = SRC.match(/>(?:[^<>{}]*)</g) || [];
    for (const s of copyStrings) {
      expect(s).not.toMatch(/\d/);
    }
  });

  test('no invented-benchmark or upsell vocabulary', () => {
    expect(SRC).not.toMatch(/\dx more/i);
    expect(SRC).not.toMatch(/venues like you/i);
    expect(SRC).not.toMatch(/coming soon/i);
    expect(SRC).not.toMatch(/upgrade to (see|unlock)/i);
  });
});
