/**
 * ROOST ASKS BEFORE THE FIRST TYPED QUESTION GOES TO GOOGLE'S GEMINI.
 *
 * App Store Guideline 5.1.2(i): personal data goes to a third-party AI only with
 * explicit permission. A typed question goes to Gemini with the venue's name,
 * numbers and the details the owner filled in, so until the owner says yes the
 * composer is replaced by a question that names the provider and every kind of
 * data a typed question carries. The server refuses typed questions without the
 * yes on its own (backend/__tests__/advisorFreeText.test.js) and records it at
 * /api/ai/roost-consent (backend/__tests__/roostConsent.test.js).
 *
 * What is pinned here:
 *   - with no yes on record, the card is drawn in the composer's place, names
 *     Google's Gemini and what is sent, and the chips still work;
 *   - Allow records the answer and brings the box; Turn off takes it back;
 *   - Not now leaves one line that brings the question back;
 *   - a server refusal for a stale yes brings the card back and the words
 *     back into the box, with nothing added to the thread;
 *   - a yes already on record shows the box straight away;
 *   - the dashboard passes the two api calls, which go to /api/ai/roost-consent.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=roostConsentCard
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

const VenueAdvisorChat = require('../components/VenueAdvisorChat').default;
const { clearAdvisorThread } = require('../components/VenueAdvisorChat');

const QUESTIONS = (aiConsent) => ({
  name: 'Roost',
  freeText: true,
  aiConsent,
  lead: [{ id: 'peak_hours', label: 'When do we peak this week?' }],
  groups: [],
});
const GROUNDED = { mode: 'phrased', intentId: 'peak_hours', text: 'Friday around 9 PM.', sources: [] };

const mount = (props = {}) => render(React.createElement(VenueAdvisorChat, {
  fetchQuestions: async () => QUESTIONS(false),
  ask: jest.fn(async () => GROUNDED),
  askQuestion: jest.fn(async () => GROUNDED),
  grantConsent: jest.fn(async () => ({ consented: true, consentedAt: '2026-10-18T12:00:00.000Z' })),
  withdrawConsent: jest.fn(async () => ({ consented: false, consentedAt: null })),
  colors: { navy: '#0d2847' },
  ...props,
}));

const box = () => screen.queryByRole('textbox', { name: /ask roost a question/i });
const card = () => screen.queryByRole('group', { name: /before roost answers typed questions/i });

beforeEach(() => clearAdvisorThread());

describe('with no yes on record', () => {
  it('draws the question in the composer\'s place, naming Google\'s Gemini and what a typed question sends', async () => {
    mount();
    await waitFor(() => expect(card()).not.toBeNull());
    expect(box()).toBeNull();
    const text = card().textContent;
    expect(text).toMatch(/Google's Gemini/);
    expect(text).toMatch(/your question, your venue's name and numbers, and the venue details you filled in, including your notes/);
    expect(text).toMatch(/Your name and your email are not sent/);
    expect(text).toMatch(/can be wrong/);
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(text).not.toMatch(/—/);
  });

  it('leaves the suggested questions working', async () => {
    const ask = jest.fn(async () => GROUNDED);
    mount({ ask });
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'When do we peak this week?' }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith('peak_hours'));
  });

  it('Allow records the answer and brings the box; Turn off takes it back', async () => {
    const grantConsent = jest.fn(async () => ({ consented: true, consentedAt: '2026-10-18T12:00:00.000Z' }));
    const withdrawConsent = jest.fn(async () => ({ consented: false, consentedAt: null }));
    mount({ grantConsent, withdrawConsent });
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(box()).not.toBeNull());
    expect(grantConsent).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
    expect(screen.getByText(/Typed questions go to Google's Gemini/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(withdrawConsent).toHaveBeenCalledTimes(1);
    expect(box()).toBeNull();
  });

  it('a failed save says so and keeps the question up', async () => {
    mount({ grantConsent: jest.fn(async () => { throw new Error('offline'); }) });
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That did not save. Try again.'));
    expect(box()).toBeNull();
  });

  it('Not now leaves one line that brings the question back', async () => {
    mount();
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(card()).toBeNull();
    expect(box()).toBeNull();
    expect(screen.getByText(/Typed questions are off until you say yes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask a typed question' }));
    expect(card()).not.toBeNull();
  });
});

describe('with a yes on record', () => {
  it('shows the box straight away', async () => {
    mount({ fetchQuestions: async () => QUESTIONS(true) });
    await waitFor(() => expect(box()).not.toBeNull());
    expect(card()).toBeNull();
  });

  it('a server refusal for a stale yes brings the question back, and the words back into the box', async () => {
    const askQuestion = jest.fn(async () => {
      throw Object.assign(new Error("Roost needs your OK before it sends a typed question to Google's Gemini."), {
        status: 403, data: { code: 'ROOST_CONSENT_REQUIRED' },
      });
    });
    const grantConsent = jest.fn(async () => ({ consented: true, consentedAt: '2026-10-18T12:00:00.000Z' }));
    mount({ fetchQuestions: async () => QUESTIONS(true), askQuestion, grantConsent });
    await waitFor(() => expect(box()).not.toBeNull());
    fireEvent.change(box(), { target: { value: 'how do I fill a slow tuesday?' } });
    fireEvent.click(screen.getByRole('button', { name: /send your question/i }));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.queryByText('how do I fill a slow tuesday?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(box()).not.toBeNull());
    expect(box().value).toBe('how do I fill a slow tuesday?');
  });
});

describe('the wiring', () => {
  it('the dashboard passes both calls, and they go to /api/ai/roost-consent', () => {
    const dash = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');
    expect(dash).toMatch(/grantConsent=\{grantRoostConsent\} withdrawConsent=\{withdrawRoostConsent\}/);
    const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
    expect(api).toMatch(/export async function grantRoostConsent\(\) \{\s*return request\('\/api\/ai\/roost-consent', \{ method: 'POST' \}\);/);
    expect(api).toMatch(/export async function withdrawRoostConsent\(\) \{\s*return request\('\/api\/ai\/roost-consent', \{ method: 'DELETE' \}\);/);
  });
});
