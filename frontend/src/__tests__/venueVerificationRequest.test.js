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
 * un-requested state renders the button, and the pending state does NOT. A
 * button in the pending state would be the same dead end rebuilt, because
 * pressing it cannot change anything the owner can see. Since 2026-09-02
 * that button lives only on the dashboard (renderVerificationAsk); the Roost
 * card's own copy of it was dormant after 2026-09-01 and has been deleted.
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
const { render, screen } = require('@testing-library/react');

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

const unverifiedPayload = (reason) => ({ available: false, unverified: true, reason, cards: [] });

const mount = (props = {}) => render(
  React.createElement(VenueInsightCards, {
    fetchCards: () => Promise.resolve(unverifiedPayload(UNREQUESTED_REASON)),
    colors: { navy: '#1B2A4A', red: '#EF4444' },
    now: new Date(2026, 7, 21, 20, 0, 0),
    ...props,
  })
);

// 2026-09-02. This block used to mount the card WITH a handler and pin a
// button contract (button only while un-requested, server sentences verbatim,
// error left pressable). The dashboard stopped passing that handler on
// 2026-09-01 and nothing else ever did, so the path was dead code and has been
// deleted from the card. What is left to pin is that the card still says the
// server's reason, in every unavailable state, and never grows a button back.
describe('Roost card: the reason line, and no button', () => {
  test('an unverified venue reads the server reason verbatim, with nothing to press', async () => {
    mount();
    expect(await screen.findByText(UNREQUESTED_REASON)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a pending request reads the pending sentence, with nothing to press', async () => {
    mount({ fetchCards: () => Promise.resolve(unverifiedPayload(PENDING_REASON)) });
    expect(await screen.findByText(PENDING_REASON)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('an unavailable state that is not the unverified one reads its reason too', async () => {
    mount({
      fetchCards: () => Promise.resolve({ available: false, reason: 'Link your Google listing in Edit Profile to see advisor cards', cards: [] }),
    });
    expect(await screen.findByText(/Link your Google listing/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('the card takes no verification props and keeps no verification state', () => {
    // The whole path (prop, state, callback, button) is gone, not just unwired.
    expect(CARDS_SRC).not.toContain('onRequestVerification');
    expect(CARDS_SRC).not.toContain('verificationStatus');
    expect(CARDS_SRC).not.toMatch(/verifyNote|verifyBusy|verifyError/);
    expect(CARDS_SRC).not.toContain('Request verification');
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

  // 2026-09-01. This test used to pin the opposite: "both surfaces press the
  // same handler, so one request settles both cards". They did, and that was
  // the defect. On the Analytics tab a premium unverified owner saw "Request
  // verification" on the intel card and again on the Roost card a scroll
  // below, and Jayden's TestFlight complaint was precisely that the screen
  // said it too many times. The intel card keeps the button; the Roost card
  // has no handler prop at all as of 2026-09-02, and the dashboard no longer
  // receives `requestVerificationNow` from App.js since nothing there read it.
  test('one surface presses the handler on Analytics: the Roost card cannot duplicate it', () => {
    expect(APP_SRC).not.toContain('onRequestVerification=');
    expect(APP_SRC).toContain('onClick={handleRequestVerification}');
    const dash = fs.readFileSync(path.join(SRC_DIR, 'screens', 'VenueDashboard.js'), 'utf8');
    expect(dash).not.toContain('requestVerificationNow');
  });

  // AUDIT 2026-08-26. The button above shipped inside the `venueIntel` card,
  // which renders under `venueTab === 'analytics' && can.analytics`, and
  // `can.analytics` is premium-or-pro. Every venue holds `free` on the day it
  // claims, which is the only day a verification is worth requesting, so the
  // owner who needed the button never saw it: they got the server's "Request
  // verification and we confirm you own this venue by hand" sentence on the
  // live-number card above a padlock, with nothing to press. That is the
  // TestFlight dead end this whole file exists about, rebuilt one tier down.
  // These pin the control to surfaces no tier gates.
  const DASH_SRC = fs.readFileSync(path.join(SRC_DIR, 'screens', 'VenueDashboard.js'), 'utf8');

  test('one helper renders the ask, and more than one surface calls it', () => {
    expect(DASH_SRC).toContain('const renderVerificationAsk = ()');
    const callSites = DASH_SRC.match(/renderVerificationAsk\(\)/g) || [];
    // The definition is not a call site; three or more real ones means the
    // control cannot be lost again by locking a single tab.
    expect(callSites.length).toBeGreaterThanOrEqual(3);
  });

  test('the settings tab carries it, because no tier gates settings', () => {
    const settings = DASH_SRC.slice(DASH_SRC.indexOf("venueTab === 'settings'"));
    expect(settings.slice(0, 3000)).toContain('{renderVerificationAsk()}');
  });

  test('the analytics copy of it appears only where the intel card is locked away', () => {
    // Both reads come from the same `can` object, so the two copies of the
    // button can never be on the tab at once.
    expect(DASH_SRC).toContain('venueBusyNow.unverified && !can.analytics && renderVerificationAsk()');
  });

  test('an unverified venue is not offered a reply the server refuses', () => {
    // POST /api/venue-dashboard/reviews/:id/reply answers 403 for an unverified
    // claim, because a reply is published as the business. The tab used to
    // render the button on every review anyway, so the only outcome available
    // to an unverified owner was composing a reply and being refused.
    expect(DASH_SRC).toContain('{!review.replied && venueIsVerified && replyingToReview !== review.id && (');
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
