/**
 * BIRDIE ASKS ONCE, BEFORE ANYTHING GOES TO GOOGLE'S GEMINI.
 *
 * App Store Guideline 5.1.2(i) asks for explicit permission before personal
 * data is shared with a third-party AI. Birdie used to carry one line saying it
 * is built on Gemini, and a single tap on a suggestion chip sent the person's
 * messages, first name, area and plans with no question asked.
 *
 * What is pinned here:
 *   1. The panel itself (rendered): until the account has a recorded yes, it
 *      shows the question, names the provider and what is sent, and offers no
 *      chip, shortcut or box that could send anything. Allow and Not now do
 *      exactly one thing each.
 *   2. App.js: the one function every send goes through returns before
 *      sendAiChat without a yes, the send button's state includes it, and a
 *      403 BIRDIE_CONSENT_REQUIRED from the server puts the question back.
 *   3. The client calls: Allow is POST /api/ai/consent, withdraw is DELETE,
 *      and every Birdie turn says this client asks (consentFlow: 'ask'),
 *      which is what makes the server hold it to the recorded answer.
 *   4. Settings: the switch that takes the answer back exists, under Safety
 *      and privacy, and flips through the same function the panel uses. Its
 *      paragraph says a yes to an earlier version of the question, which did
 *      not name the time zone, leaves the zone out until the switch goes off
 *      and on again.
 *
 * The server half (the route refuses a client that asks and has no yes on
 * record, and serves a build installed before the question exactly as
 * before) is backend/__tests__/birdieConsent.test.js.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import BirdiePanel from '../components/birdie/BirdiePanel';

// BirdieBird runs a rAF loop behind an IntersectionObserver, which jsdom does
// not have. What he looks like is not what this file is about.
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, WARM_BIRD: {} };
});

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const CHIP = 'Pick a spot for tonight';

// Every prop BirdiePanel takes, the way FlockAppInner builds them. Fresh
// jest.fn()s per call, because react-scripts resets mock implementations
// between tests.
function panelProps(overrides = {}) {
  return {
    AI_CHAT_MAX_MESSAGES: 24,
    AI_CHAT_MAX_MESSAGE_CHARS: 4000,
    DialogBehavior: () => null,
    aiChatEndRef: React.createRef(),
    aiInputHasText: false,
    aiInputHasTextRef: { current: false },
    aiInputRef: React.createRef(),
    aiInputValueRef: { current: '' },
    aiMemoryCut: 0,
    aiMessages: [],
    aiMsgCountRef: { current: 0 },
    aiRemaining: null,
    aiResetsAt: null,
    aiShareVenue: null,
    aiSuggestedQuestions: [
      { text: CHIP, icon: () => null },
      { text: 'When should we head out?', icon: () => null },
    ],
    aiTyping: false,
    answerBirdieConsent: jest.fn(() => Promise.resolve(true)),
    birdieActionBusy: false,
    birdieConsentBusy: false,
    birdieConsentError: '',
    birdieConsented: false,
    birdieCorner: 'bottom-right',
    canSendAi: false,
    closeAiChat: jest.fn(),
    colors: { navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1e3a5c' },
    confirmBirdieDraft: jest.fn(),
    confirmBirdieVoteStage: jest.fn(),
    entitlements: {},
    fabDockBottom: '90px',
    fillAiInput: jest.fn(),
    flocks: [],
    formatEventTime: (t) => String(t),
    isAiFullscreen: false,
    isAiPanel: true,
    isDark: false,
    isPro: false,
    loadTrustedContacts: jest.fn(),
    memberCountLabel: () => '',
    openExternal: jest.fn(),
    openVenueDetail: jest.fn(),
    outOfChirps: false,
    sendAiMessage: jest.fn(),
    setAiInputHasText: jest.fn(),
    setAiShareVenue: jest.fn(),
    setCurrentScreen: jest.fn(),
    setCurrentTab: jest.fn(),
    setPaywallTrigger: jest.fn(),
    setProfileScreen: jest.fn(),
    setSelectedFlockId: jest.fn(),
    setSelectedVenueForCreate: jest.fn(),
    startNewAiChat: jest.fn(),
    toggleAiFullscreen: jest.fn(),
    transmitFlockMessage: jest.fn(),
    ...overrides,
  };
}

describe('the panel before the account has said yes', () => {
  test('it asks, names Google\'s Gemini, and says what is sent', () => {
    render(<BirdiePanel {...panelProps()} />);
    expect(screen.getByRole('group', { name: 'Before Birdie answers' })).toBeInTheDocument();
    const text = screen.getByRole('group').textContent;
    expect(text).toMatch(/Google's Gemini/);
    // 'your time zone' since every turn carries it, so Birdie knows the date
    // and reads "Friday at 8" on this person's clock (backend routes/ai.js,
    // WHOSE CLOCK BIRDIE PLANS ON).
    for (const kind of ['your messages to Birdie', 'your first name', 'your age range', 'your time zone', 'what you have open in Flock', 'rounded to about a kilometer', "your friends' names"]) {
      expect(text).toContain(kind);
    }
    expect(text).toMatch(/Your email, your exact location and your chats with friends are not sent/);
    // House copy rule: no em dash in anything a user reads.
    expect(text).not.toMatch(/—/);
  });

  test('there is nothing to tap that could send: no chips, no shortcuts, no box, no send button', () => {
    // Even with words waiting in the box (a server refusal puts them back),
    // and even with canSendAi lit, nothing that sends is on screen.
    const props = panelProps({ aiInputHasText: true, canSendAi: true, aiInputValueRef: { current: 'where to tonight' } });
    render(<BirdiePanel {...props} />);
    expect(screen.queryByText(CHIP)).toBeNull();
    for (const shortcut of ['Search', 'Crowds', 'My Flocks']) {
      expect(screen.queryByRole('button', { name: shortcut })).toBeNull();
    }
    expect(screen.queryByLabelText('Ask me anything')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    for (const button of screen.getAllByRole('button')) {
      if (['Allow', 'Not now'].includes(button.textContent)) continue;
      fireEvent.click(button);
    }
    expect(props.sendAiMessage).not.toHaveBeenCalled();
    expect(props.fillAiInput).not.toHaveBeenCalled();
  });

  test('the words waiting in the box come back with it after Allow', () => {
    const props = panelProps({ aiInputValueRef: { current: 'where to tonight' } });
    const { rerender } = render(<BirdiePanel {...props} />);
    rerender(<BirdiePanel {...props} birdieConsented />);
    expect(screen.getByLabelText('Ask me anything')).toHaveValue('where to tonight');
  });

  test('Allow records the answer and does nothing else', () => {
    const props = panelProps();
    render(<BirdiePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(props.answerBirdieConsent).toHaveBeenCalledTimes(1);
    expect(props.answerBirdieConsent).toHaveBeenCalledWith(true);
    expect(props.sendAiMessage).not.toHaveBeenCalled();
    expect(props.fillAiInput).not.toHaveBeenCalled();
  });

  test('Not now closes Birdie and records nothing', () => {
    const props = panelProps();
    render(<BirdiePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(props.closeAiChat).toHaveBeenCalledTimes(1);
    expect(props.answerBirdieConsent).not.toHaveBeenCalled();
    expect(props.sendAiMessage).not.toHaveBeenCalled();
  });

  test('while the answer is saving, neither button can be pressed twice', () => {
    render(<BirdiePanel {...panelProps({ birdieConsentBusy: true })} />);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled();
  });

  test('a failed save says so where the question is', () => {
    render(<BirdiePanel {...panelProps({ birdieConsentError: 'That did not save. Try again.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('That did not save. Try again.');
  });

  test('the full list is one tap away, on the privacy policy', () => {
    const props = panelProps();
    render(<BirdiePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'What Birdie sends, in full' }));
    expect(props.openExternal).toHaveBeenCalledWith('https://www.flockcorp.com/privacy#ai');
  });

  test('a thread already on screen gives way to the question, and its chips go with it', () => {
    // Consent withdrawn from Settings (or on another device) while a thread
    // sat in memory: the thread is not the place to keep asking from.
    render(<BirdiePanel {...panelProps({ aiMessages: [{ role: 'user', text: 'where to' }, { role: 'assistant', text: 'oakwood' }] })} />);
    expect(screen.getByRole('group', { name: 'Before Birdie answers' })).toBeInTheDocument();
    expect(screen.queryByText('oakwood')).toBeNull();
    expect(screen.queryByText(CHIP)).toBeNull();
  });
});

describe('the panel once the account has said yes', () => {
  test('no question, and the chips and the box are back', () => {
    const props = panelProps({ birdieConsented: true });
    render(<BirdiePanel {...props} />);
    expect(screen.queryByRole('group', { name: 'Before Birdie answers' })).toBeNull();
    expect(screen.getByLabelText('Ask me anything')).toBeInTheDocument();
    fireEvent.click(screen.getByText(CHIP));
    expect(props.fillAiInput).toHaveBeenCalledWith(CHIP, { send: true });
  });
});

describe('App.js: every send path checks the answer first', () => {
  const app = read('App.js');
  const sendAiMessage = app.slice(
    app.indexOf('const sendAiMessage = useCallback(async () => {'),
    app.indexOf('const fillAiInput = useCallback('),
  );

  test('the answer is the server\'s, read off the account', () => {
    expect(app).toContain('const birdieConsented = !!authUser?.birdie_ai_consent_at;');
    expect(app).toMatch(/onUserPatch\(\{ birdie_ai_consent_at: data\?\.consentedAt \|\| null \}\)/);
  });

  test('sendAiMessage returns before touching the thread or sendAiChat without a yes', () => {
    const guard = sendAiMessage.indexOf('if (!birdieConsentedRef.current) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sendAiMessage.indexOf('setAiMessages('));
    expect(guard).toBeLessThan(sendAiMessage.indexOf('sendAiChat('));
    expect(guard).toBeLessThan(sendAiMessage.indexOf('aiSendingRef.current = true'));
  });

  test('a server refusal takes the question back out and asks again', () => {
    const branch = sendAiMessage.slice(sendAiMessage.indexOf("err?.code === 'BIRDIE_CONSENT_REQUIRED'"));
    expect(branch.length).toBeGreaterThan(0);
    const body = branch.slice(0, branch.indexOf('} else if'));
    expect(body).toContain('setAiMessages(prev => prev.filter(m => m !== userEntry));');
    expect(body).toContain('aiInputValueRef.current = userMessage;');
    expect(body).toContain('onUserPatch({ birdie_ai_consent_at: null })');
  });

  test('both surfaces receive the same answer and the same function', () => {
    for (const obj of ['birdiePanelProps', 'profileSettingsProps']) {
      const start = app.indexOf(`const ${obj} = {`);
      const block = app.slice(start, app.indexOf('};', start));
      for (const name of ['answerBirdieConsent,', 'birdieConsented,', 'birdieConsentBusy,', 'birdieConsentError,']) {
        expect(block).toContain(name);
      }
    }
  });
});

describe('the client calls', () => {
  const api = jest.requireActual('../services/api');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const answer = (body) => jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }));

  test('Allow is POST /api/ai/consent', async () => {
    global.fetch = answer({ consented: true, consentedAt: '2026-09-27T12:00:00.000Z' });
    const data = await api.grantBirdieConsent();
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/ai\/consent$/);
    expect(init.method).toBe('POST');
    expect(data.consentedAt).toBe('2026-09-27T12:00:00.000Z');
  });

  // The server reads the zone every turn sends only on a yes to a question
  // that names it (backend migration 122), and this build's question does, so
  // Allow says so. Without it the yes reads as one to the earlier question.
  test('Allow says it answered the question that names the time zone', async () => {
    global.fetch = answer({ consented: true, consentedAt: '2026-10-06T12:00:00.000Z' });
    await api.grantBirdieConsent();
    const [, init] = global.fetch.mock.calls[0];
    expect(api.BIRDIE_CONSENT_COPY).toBe(2);
    expect(JSON.parse(init.body)).toEqual({ copy: 2 });
  });

  test('withdraw is DELETE /api/ai/consent', async () => {
    global.fetch = answer({ consented: false, consentedAt: null });
    await api.withdrawBirdieConsent();
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/ai\/consent$/);
    expect(init.method).toBe('DELETE');
  });

  // The server serves a turn with no flag the way it served every turn before
  // the question existed, because that is what builds 38 and 44 send. This
  // client shows the question, so every turn it sends has to say so, in both
  // builds, or its own question becomes the only check.
  test.each([
    ['the web build', undefined],
    ['the App Store build', 'off'],
  ])('every Birdie turn from %s says this client asks', async (_name, purchases) => {
    const before = process.env.REACT_APP_PURCHASES;
    if (purchases === undefined) delete process.env.REACT_APP_PURCHASES;
    else process.env.REACT_APP_PURCHASES = purchases;
    try {
      global.fetch = answer({ text: 'go at 9', venues: [] });
      await api.sendAiChat([{ role: 'user', text: 'hi' }], null, null);
      await api.sendAiChat([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'go at 9' }, { role: 'user', text: 'and after' }], { lat: 1, lng: 2 }, { screen: 'home' });
      const turns = global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/ai/chat'));
      expect(turns).toHaveLength(2);
      for (const [, init] of turns) expect(JSON.parse(init.body).consentFlow).toBe('ask');
    } finally {
      if (before === undefined) delete process.env.REACT_APP_PURCHASES;
      else process.env.REACT_APP_PURCHASES = before;
    }
  });

  // Birdie was never told the date or the zone, so "Friday at 8" became 4 PM
  // Eastern on the card (backend routes/ai.js, WHOSE CLOCK BIRDIE PLANS ON).
  // Every turn now carries the device's own zone, and a runtime that cannot
  // answer sends none rather than a guess; the server then tells Birdie the
  // zone is unknown.
  const chatBody = () => {
    const call = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/ai/chat'));
    return JSON.parse(call[1].body);
  };

  test("every Birdie turn carries the device's time zone", async () => {
    global.fetch = answer({ text: 'go at 9', venues: [] });
    await api.sendAiChat([{ role: 'user', text: 'friday at 8?' }], null, null);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(typeof zone).toBe('string');
    expect(chatBody().timeZone).toBe(zone);
  });

  test.each([
    ['answers with no zone', () => ({ resolvedOptions: () => ({}) })],
    ['answers with something too long to be one', () => ({ resolvedOptions: () => ({ timeZone: 'x'.repeat(65) }) })],
    ['throws', () => { throw new RangeError('no zone'); }],
  ])('a runtime that %s sends no zone, and the turn still goes', async (_name, impl) => {
    global.fetch = answer({ text: 'go at 9', venues: [] });
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(impl);
    try {
      await api.sendAiChat([{ role: 'user', text: 'friday at 8?' }], null, null);
    } finally {
      spy.mockRestore();
    }
    expect('timeZone' in chatBody()).toBe(false);
    expect(chatBody().consentFlow).toBe('ask');
  });
});

describe('Settings: the answer can be taken back', () => {
  const settings = read('screens', 'ProfileSettings.js');

  test('a row under Safety and privacy leads to it, showing the current answer', () => {
    const group = settings.slice(settings.indexOf("g: 'Safety and privacy'"), settings.indexOf("g: 'Safety and privacy'") + 1500);
    expect(group).toContain("{ l: 'Birdie and Google Gemini', s: 'birdieai', icon: Icons.messageSquare, v: birdieConsented ? 'On' : 'Off' }");
    expect(read('App.js')).toContain("birdieai: 'Birdie and Google Gemini',");
  });

  test('the switch flips through the function the panel uses', () => {
    expect(settings).toContain('<Toggle label="Let Birdie use Google\'s Gemini" on={birdieConsented} onChange={() => { if (!birdieConsentBusy) answerBirdieConsent(!birdieConsented); }} />');
  });

  test('the screen behind it lists what is sent the way the panel does, and says when the time zone goes', () => {
    // Every account with a yes reads this, a yes given to the question before
    // it named the time zone included, and the server leaves the zone out for
    // that one (backend routes/ai.js, WHICH QUESTION A YES ANSWERED). It also
    // leaves it out when the device reports no zone, whatever the yes: the
    // zone it reads is only ever the one the turn sent (userZone), which is
    // the condition the privacy policy states too.
    expect(settings).toContain("it sends Google your messages to Birdie, your first name, your age range, and what you have open in Flock. It also sends your time zone with the date and time it is there, but only when your device reports its time zone. A yes to an earlier version of Birdie's question, which did not name them, keeps them out until you turn this off and on again.");
  });

  test('off and on again is a yes to the question that names the zone', () => {
    // What "turn this off and on again" rests on. Off withdraws, and the server
    // clears the question with the time; on is a fresh yes, sent with the
    // number of this build's question, which names the zone (the client calls
    // above pin both requests; backend birdieConsentCopyRealDb.test.js pins
    // what the server records for each).
    const app = read('App.js');
    const start = app.indexOf('const answerBirdieConsent = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const answer = app.slice(start, app.indexOf('}, [onUserPatch]);', start));
    expect(answer).toContain('const data = allow ? await grantBirdieConsent() : await withdrawBirdieConsent();');
    expect(settings).toContain('answerBirdieConsent(!birdieConsented)');
    const api = read('services', 'api.js');
    expect(api).toContain('export const BIRDIE_CONSENT_COPY = 2;');
    expect(api).toContain("return request('/api/ai/consent', { method: 'POST', body: JSON.stringify({ copy: BIRDIE_CONSENT_COPY }) });");
  });
});
