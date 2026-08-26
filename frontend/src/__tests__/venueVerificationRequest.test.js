/**
 * THE VERIFICATION REQUEST — the way out of a dead end.
 *
 * WHY THIS FILE EXISTS. Jayden found it on TestFlight, 2026-08-21: the venue
 * dashboard told an owner to verify their venue in three separate places and
 * nothing anywhere started a verification. The admin half had existed since
 * migration 020; the owner half did not exist at all. A paying Pro owner was
 * being instructed to do something the product gave them no way to do.
 *
 * The pin that matters, and the one the backend handoff asked for: the
 * un-requested card renders the button, and the pending card does NOT. A
 * button in the pending state would be the same dead end rebuilt, because
 * pressing it cannot change anything the owner can see.
 *
 * The second rule this guards is the copy one. The server owns every sentence
 * here (`reason`, `message`, `error`) and each is state-aware; the UI prints
 * them verbatim rather than paraphrasing them into marketing voice, and
 * nothing anywhere promises a turnaround time, because verification is one
 * person checking by hand and no clock is enforced.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venueVerificationRequest --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

const VenueInsightCards = require('../components/VenueInsightCards').default;

const SRC_DIR = path.resolve(__dirname, '..');
// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and about 2,000 lines of what
// this file scans went with it. Nothing asserted below changed. The app source
// is simply in two files, so both are read, in the order they used to be one.
const APP_SRC = fs.readFileSync(path.join(SRC_DIR, 'App.js'), 'utf8')
  + fs.readFileSync(path.join(SRC_DIR, 'screens', 'VenueDashboard.js'), 'utf8');
const API_SRC = fs.readFileSync(path.join(SRC_DIR, 'services', 'api.js'), 'utf8');
const CARDS_SRC = fs.readFileSync(path.join(SRC_DIR, 'components', 'VenueInsightCards.js'), 'utf8');

// The server's own sentences, copied from backend/utils/verificationCopy.js and
// routes/venueProfile.js. If these drift, the copy pin below is what notices.
const UNREQUESTED_REASON = 'Not verified yet. Request verification and we confirm you own this venue by hand. Forecasts turn on once that clears.';
const PENDING_REASON = 'Verification requested. We confirm ownership by hand, and forecasts turn on once that clears. Nothing more is needed from you.';
const RECEIVED_MESSAGE = 'Request received. We confirm ownership by hand, and verified features turn on once that clears.';
const NO_LISTING_ERROR = 'Link your Google listing in Edit Profile first. Verification confirms you own a specific listed place, and this profile does not name one yet.';

const unverifiedPayload = (reason) => ({ available: false, unverified: true, reason, cards: [] });

const mount = (props = {}) => render(
  React.createElement(VenueInsightCards, {
    fetchCards: () => Promise.resolve(unverifiedPayload(UNREQUESTED_REASON)),
    colors: { navy: '#1B2A4A', red: '#EF4444' },
    onRequestVerification: () => Promise.resolve(RECEIVED_MESSAGE),
    now: new Date(2026, 7, 21, 20, 0, 0),
    ...props,
  })
);

describe('Roost card: the request button', () => {
  test('an unverified venue gets the button, under the server reason verbatim', async () => {
    mount({ verificationStatus: 'unverified' });
    expect(await screen.findByText(UNREQUESTED_REASON)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request verification' })).toBeInTheDocument();
  });

  test('a pending request gets NO button, only the pending sentence', async () => {
    mount({
      fetchCards: () => Promise.resolve(unverifiedPayload(PENDING_REASON)),
      verificationStatus: 'pending',
    });
    expect(await screen.findByText(PENDING_REASON)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request verification' })).toBeNull();
  });

  test('an unavailable state that is not the unverified one gets no button either', async () => {
    mount({
      fetchCards: () => Promise.resolve({ available: false, reason: 'Link your Google listing in Edit Profile to see advisor cards', cards: [] }),
      verificationStatus: 'unverified',
    });
    expect(await screen.findByText(/Link your Google listing/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request verification' })).toBeNull();
  });

  test('pressing it calls the handler once and prints the server message in place of the reason', async () => {
    let calls = 0;
    mount({
      verificationStatus: 'unverified',
      onRequestVerification: () => { calls += 1; return Promise.resolve(RECEIVED_MESSAGE); },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Request verification' }));
    expect(await screen.findByText(RECEIVED_MESSAGE)).toBeInTheDocument();
    expect(calls).toBe(1);
    // The button is gone: the state it exists to reach has been reached.
    expect(screen.queryByRole('button', { name: 'Request verification' })).toBeNull();
    // The sentence it replaced is no longer telling the owner to request.
    expect(screen.queryByText(UNREQUESTED_REASON)).toBeNull();
  });

  test('a failure shows the server error text inline and leaves the button pressable', async () => {
    const err = new Error(NO_LISTING_ERROR);
    err.status = 400;
    mount({
      verificationStatus: 'unverified',
      onRequestVerification: () => Promise.reject(err),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Request verification' }));
    expect(await screen.findByText(NO_LISTING_ERROR)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Request verification' })).not.toBeDisabled();
    });
  });
});

describe('The wiring behind the button', () => {
  test('api.js POSTs the owner request to the route the server serves', () => {
    expect(API_SRC).toMatch(/export async function requestVenueVerification\(\)/);
    expect(API_SRC).toMatch(/'\/api\/venue-profile\/request-verification',\s*\{\s*method:\s*'POST'\s*\}/);
  });

  test('App.js keeps the un-requested headline and adds the pending one', () => {
    expect(APP_SRC).toContain('"Your venue isn\'t verified yet"');
    expect(APP_SRC).toContain("'Verification requested'");
    expect(APP_SRC).toContain("venueProfile?.verification_status === 'pending'");
  });

  test('App.js gates its button on the request not already being in', () => {
    const button = APP_SRC.match(/\{venueIntel\.unverified && !venueVerificationPending[\s\S]{0,900}?Request verification/);
    expect(button).not.toBeNull();
  });

  test('both surfaces press the same handler, so one request settles both cards', () => {
    expect(APP_SRC).toContain('onRequestVerification={requestVerificationNow}');
    expect(APP_SRC).toContain('onClick={handleRequestVerification}');
    expect(CARDS_SRC).toContain('onClick={requestVerification}');
  });

  test('the label is exactly Request verification, and no turnaround time is promised', () => {
    for (const src of [APP_SRC, CARDS_SRC]) {
      // No "within N days" / "in 24 hours" style promise anywhere near the flow.
      expect(src).not.toMatch(/within \d+\s*(business\s*)?(hours?|days?)/i);
      expect(src).not.toMatch(/\d+\s*[-–]?\s*\d*\s*business days/i);
    }
    // No em dash in what either file renders.
    expect(CARDS_SRC.includes('—')).toBe(false);
  });
});
