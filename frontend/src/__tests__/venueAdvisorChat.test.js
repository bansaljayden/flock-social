/**
 * ROOST, THE TYPED HALF — VenueAdvisorChat.js
 *
 * WHY THIS FILE EXISTS. Free text shipped on 2026-08-20 behind two flags that
 * both defaulted OFF. With them off the server omitted `freeText` from
 * GET /questions, and this component's only response to that was to render no
 * field at all. So a built, tested, documented feature reached the person who
 * asked for it as an ABSENCE: no box, no explanation, nothing to notice was
 * missing. His words were "Where is that anywhere?"
 *
 * Everything below is a guard against that specific shape of failure coming
 * back. The load-bearing one is the second describe: THE FIELD RENDERS EVEN
 * WHEN THE SERVER SAYS NO. A graceful decline the owner can read is a decline;
 * a graceful decline they cannot see is a bug.
 *
 * What this suite pins:
 *   1. The field is always drawn, in every state that renders the card.
 *   2. It is the LAST thing in the card, below the suggested chips, because
 *      chips are shortcuts past the way in and not the way in.
 *   3. Typing reaches askQuestion and the answer lands in the thread.
 *   4. The answer modes are told apart on screen: grounded carries its
 *      sources, advice carries its marker, a refusal carries neither and never
 *      an upsell, and small talk (a greeting answered in kind) reads in the
 *      normal answer ink rather than the refusal's quieter one.
 *   5. The product name is said ONCE per screen. VenueInsightCards titles the
 *      surface; this block is titled for what it is.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venueAdvisorChat --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { act, cleanup, render, screen, fireEvent, waitFor } = require('@testing-library/react');

const VenueAdvisorChat = require('../components/VenueAdvisorChat').default;
const { clearAdvisorThread } = require('../components/VenueAdvisorChat');
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'VenueAdvisorChat.js'), 'utf8');
const CARDS_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'VenueInsightCards.js'), 'utf8');

const QUESTIONS = (freeText = true) => ({
  name: 'Roost',
  freeText,
  lead: [
    { id: 'tonight_outlook', label: 'How does today look?' },
    { id: 'peak_hours', label: 'When do we peak this week?' },
  ],
  groups: [
    { id: 'your_room', label: 'Your room', questions: [{ id: 'capacity_math', label: 'What does busy mean in people?' }] },
  ],
});

const GROUNDED = {
  mode: 'phrased',
  intentId: 'peak_hours',
  text: 'The forecast projects your busiest stretch on Friday around 9 PM.',
  sources: [{ id: 'peak_2026-08-21', source: 'model_holdout', asOf: '2026-08-20' }],
};
const ADVICE = {
  mode: 'advice',
  intentId: 'quiet_nights',
  text: 'Discounting a quiet day is the common answer and it is usually the wrong one.',
  sources: [],
};
const REFUSAL = {
  mode: 'refusal',
  text: 'That one is outside what Roost does. We do not report another business’s numbers.',
  sources: [],
};
// What POST /question returns for "hello" since 2026-09-02: its own mode, so
// the chat does not draw a greeting in refusal ink.
const SMALL_TALK = {
  mode: 'small_talk',
  text: "Hello, good to see you. Ask about your venue's numbers or how to run the room, and we will take it from there.",
  sources: [],
};

const mount = (props = {}) => render(React.createElement(VenueAdvisorChat, {
  fetchQuestions: async () => QUESTIONS(true),
  ask: async () => GROUNDED,
  askQuestion: async () => GROUNDED,
  colors: { navy: '#0d2847' },
  ...props,
}));

const field = () => screen.getByRole('textbox', { name: /ask roost a question/i });
const send = () => screen.getByRole('button', { name: /send your question/i });

// The thread outlives a remount on purpose (the dashboard unmounts this card
// on every tab switch), so it also outlives a test unless it is told not to.
beforeEach(() => clearAdvisorThread());

describe('Roost chat: the field is the surface', () => {
  test('a text input renders on the ready card, and it is what the owner sees last', async () => {
    const { container } = mount();
    const input = await waitFor(field);
    expect(input).toBeTruthy();
    expect(input).not.toBeDisabled();

    // Below the chips. Chips are starting points ABOVE the field, never a
    // replacement for it: the whole complaint was that they were the only way in.
    const chip = screen.getByRole('button', { name: 'How does today look?' });
    expect(chip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // And it is the last interactive thing in the card. `textarea` is in the
    // selector because the composer became one when it learned to grow with a
    // long question; without it this assertion would silently stop covering
    // the box it was written about.
    const controls = Array.from(container.querySelectorAll('input, textarea, button'));
    expect(controls[controls.length - 1].getAttribute('type')).toBe('submit');
    expect(controls[controls.length - 2]).toBe(input);
  });

  test('the box is a textarea that grows, not a one-line pill', async () => {
    mount();
    const input = await waitFor(field);
    expect(input.tagName).toBe('TEXTAREA');
    // A phone keyboard draws its return key as Send, so the button and the key
    // do the same thing without either platform being told about the other.
    expect(input.getAttribute('enterKeyHint')).toBe('send');
    // Comfortable, not a hairline. The pill it replaced was nine pixels of
    // padding around a single line.
    expect(parseInt(input.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });

  test('the placeholder invites BOTH kinds of question, not just the numbers', async () => {
    mount();
    const input = await waitFor(field);
    const placeholder = input.getAttribute('placeholder');
    expect(placeholder).toMatch(/numbers/i);
    expect(placeholder).toMatch(/room/i);
  });

  test('the send control is dead while the box is empty and live once it is not', async () => {
    mount();
    const input = await waitFor(field);
    const send = screen.getByRole('button', { name: /send your question/i });
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: 'how do I make Tuesdays better' } });
    expect(send).not.toBeDisabled();
    // Whitespace is not a question.
    fireEvent.change(input, { target: { value: '   ' } });
    expect(send).toBeDisabled();
  });

  test('the box stops at the length the server stops at, and says so as it fills', async () => {
    mount();
    const input = await waitFor(field);
    expect(Number(input.getAttribute('maxLength'))).toBe(280);
    expect(screen.queryByText(/characters left/i)).toBeNull();
    fireEvent.change(input, { target: { value: 'x'.repeat(270) } });
    expect(screen.getByText(/10 characters left/i)).toBeTruthy();
  });
});

describe('Roost chat: a decline the owner can read', () => {
  test('with freeText false the field is STILL drawn, disabled, with the reason beside it', async () => {
    mount({ fetchQuestions: async () => QUESTIONS(false) });
    const input = await waitFor(field);
    // The regression this whole file exists to catch: the field must never be
    // the thing that disappears.
    expect(input).toBeTruthy();
    expect(input).toBeDisabled();
    expect(screen.getByText(/typed questions are off/i)).toBeTruthy();
    // And the chips, which do still work, are pointed at.
    expect(screen.getByText(/suggested questions above still work/i)).toBeTruthy();
  });

  test('the decline never sells anything', async () => {
    mount({ fetchQuestions: async () => QUESTIONS(false) });
    await waitFor(field);
    expect(screen.queryByText(/upgrade|pro plan|subscription|per month/i)).toBeNull();
  });
});

describe('Roost chat: a typed question becomes an answer', () => {
  test('submitting calls askQuestion with the typed text and threads the reply', async () => {
    const asked = [];
    mount({ askQuestion: async (q) => { asked.push(q); return GROUNDED; } });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: '  how busy will Friday be  ' } });
    fireEvent.click(screen.getByRole('button', { name: /send your question/i }));

    expect(asked).toEqual(['how busy will Friday be']);
    // The question is echoed, the box is cleared, and the answer lands.
    expect(screen.getByText('how busy will Friday be')).toBeTruthy();
    expect(input.value).toBe('');
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());
  });

  test('while it is thinking the owner is told the truth about which door it came in by', async () => {
    let release;
    mount({ askQuestion: () => new Promise((r) => { release = () => r(GROUNDED); }) });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'how do I fill Tuesdays' } });
    fireEvent.click(screen.getByRole('button', { name: /send your question/i }));

    // A typed question has not been routed yet, so promising to read their
    // numbers would be a small lie told several times a day.
    expect(screen.getByText(/working on it/i)).toBeTruthy();
    expect(screen.queryByText(/reading your numbers/i)).toBeNull();
    release();
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());
  });

  test('a chip still says it is reading their numbers, because a chip already is', async () => {
    let release;
    mount({ ask: () => new Promise((r) => { release = () => r(GROUNDED); }) });
    await waitFor(field);
    fireEvent.click(screen.getByRole('button', { name: 'When do we peak this week?' }));
    expect(screen.getByText(/reading your numbers/i)).toBeTruthy();
    release();
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());
  });
});

describe('Roost chat: the three answers are told apart', () => {
  const askWith = async (answer) => {
    mount({ askQuestion: async () => answer });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'a question' } });
    fireEvent.click(screen.getByRole('button', { name: /send your question/i }));
    await waitFor(() => expect(screen.getByText(answer.text)).toBeTruthy());
  };

  test('a grounded answer names its sources and carries no advice marker', async () => {
    await askWith(GROUNDED);
    expect(screen.getByText(/From model estimate\./i)).toBeTruthy();
    expect(screen.queryByText(/general advice/i)).toBeNull();
  });

  test('an advice answer is marked as advice and inset behind a rule', async () => {
    await askWith(ADVICE);
    const marker = screen.getByText(/general advice, not from your data/i);
    expect(marker).toBeTruthy();
    // Colour alone would not do it: the two answers are the same ink on
    // purpose, because advice is a different KIND of answer, not a lesser one.
    const body = marker.parentElement;
    expect(body.style.borderLeftWidth).toBe('2px');
    expect(body.style.borderLeftStyle).toBe('solid');
    expect(body.style.paddingLeft).toBe('10px');
  });

  test('a grounded answer carries no rule, so the inset means one thing only', async () => {
    await askWith(GROUNDED);
    const line = screen.getByText(GROUNDED.text).parentElement;
    expect(line.style.borderLeftWidth).not.toBe('2px');
  });

  test('a refusal carries no source line, no marker, and no upsell', async () => {
    await askWith(REFUSAL);
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.queryByText(/general advice/i)).toBeNull();
    expect(screen.queryByText(/upgrade|pro plan|subscription/i)).toBeNull();
  });

  // data-ink, not style.color: jsdom drops an inline colour that is a custom
  // property, so the attribute is the only rendered trace of which ink it is.
  test('a refusal is drawn in the quieter ink, and a grounded answer in the primary one', async () => {
    await askWith(REFUSAL);
    expect(screen.getByText(REFUSAL.text).getAttribute('data-ink')).toBe('quiet');
    cleanup();
    clearAdvisorThread();
    await askWith(GROUNDED);
    expect(screen.getByText(GROUNDED.text).getAttribute('data-ink')).toBe('answer');
    // And the only thing that picks the quiet ink is the refusal mode.
    expect(SRC).toContain("quiet={turn.answer.mode === 'refusal'}");
  });

  // 2026-09-02. "Hello, good to see you" came back as mode 'refusal' and was
  // drawn in refusal ink, so a warm line read as a decline. Small talk has
  // its own mode now and takes the same ink as a real answer.
  test('small talk reads in the normal answer ink, with no source line, no marker, and no rule', async () => {
    await askWith(SMALL_TALK);
    const line = screen.getByText(SMALL_TALK.text);
    expect(line.getAttribute('data-ink')).toBe('answer');
    expect(line.parentElement.style.borderLeftWidth).not.toBe('2px');
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.queryByText(/general advice/i)).toBeNull();
    expect(screen.queryByText(/upgrade|pro plan|subscription/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IT HAS TO READ AS A CHAT, NOT AS A FORM.
//
// Jayden looked at the shipped card and said the input "should be a bit more
// clean, like you actually should be typing it, like how you would type to
// ChatGPT or Claude." Everything below pins the parts of that which are
// behaviour rather than taste: the turns accumulate, they survive the tab
// strip that unmounts the card, the chips get out of the way once a
// conversation exists, and the keyboard does what a keyboard does.
// ---------------------------------------------------------------------------
describe('Roost chat: it accumulates into a conversation', () => {
  const askOnce = async (input, text) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(send());
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
    // And wait for the turn to actually finish, so the next assertion is not
    // racing a promise that will resolve into an unmounted tree.
    await waitFor(() => expect(screen.queryByText(/working on it/i)).toBeNull());
  };

  test('a second question does not replace the first: both turns stay on screen', async () => {
    let n = 0;
    mount({ askQuestion: async () => ({ ...GROUNDED, text: `answer number ${++n}` }) });
    const input = await waitFor(field);

    await askOnce(input, 'question one');
    await waitFor(() => expect(screen.getByText('answer number 1')).toBeTruthy());
    await askOnce(input, 'question two');
    await waitFor(() => expect(screen.getByText('answer number 2')).toBeTruthy());
    await askOnce(input, 'question three');
    await waitFor(() => expect(screen.getByText('answer number 3')).toBeTruthy());

    // All three exchanges, in order, still readable.
    for (const t of ['question one', 'answer number 1', 'question two', 'answer number 2', 'question three', 'answer number 3']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    const first = screen.getByText('question one');
    const last = screen.getByText('answer number 3');
    expect(first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('the thread survives the card being unmounted and mounted again', async () => {
    // The venue dashboard throws this card away on every tab switch, and
    // Roost's own cards send the owner to the Settings tab by name. A
    // conversation that does not come back is a form that clears itself.
    const first = mount();
    const input = await waitFor(field);
    await askOnce(input, 'does the thread survive');
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());
    first.unmount();

    mount();
    await waitFor(field);
    expect(screen.getByText('does the thread survive')).toBeTruthy();
    expect(screen.getByText(GROUNDED.text)).toBeTruthy();
  });

  test('a different sign-in does not inherit the last one\'s conversation', async () => {
    // Parallel agents have already put two accounts through one browser on this
    // machine. A held thread is one venue's own numbers, so it is keyed to the
    // token that fetched it and a new token starts empty.
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    const first = mount();
    const input = await waitFor(field);
    await askOnce(input, 'my private numbers');
    first.unmount();

    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    mount();
    await waitFor(field);
    expect(screen.queryByText('my private numbers')).toBeNull();
    window.localStorage.removeItem('flockToken');
  });

  // A MOUNTED CARD IS NOT A SAFE PLACE TO REMEMBER WHO YOU ARE.
  //
  // Round 26 keyed the held thread to the token and stopped a NEW MOUNT from
  // inheriting the last account's conversation. It left the live card alone,
  // and the live card is where the account actually changes: `flockToken` is
  // one shared localStorage key, so a second tab signing in overwrites it under
  // this realm and an in-app sign-in does the same without unmounting anything.
  // The card went on drawing owner one's revenue, footfall and staffing answers,
  // sent owner one's next question with owner two's token (services/api.js reads
  // the token on every request, at call time), and appended owner two's answer
  // to owner one's live thread. The four tests below are that whole path.
  test('a token that changes UNDER a live card empties the screen and sends nothing under the new one', async () => {
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    const asked = [];
    const live = mount({ askQuestion: async (q) => { asked.push(q); return GROUNDED; } });
    const input = await waitFor(field);
    await askOnce(input, 'owner one private numbers');
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());

    // The in-app case: this tab did the writing, so the browser dispatches no
    // storage event to it. Nothing unmounts and nothing is notified.
    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    // The next thing owner one does is type, and typing is a render. Round 28
    // made a render one of the ways this card re-reads the key, so the switch
    // is caught here rather than up to one tick of the interval later. The card
    // drops the thread and goes back to loading, this time for owner two, so
    // the field below is a NEW field and the stale handle is not asked about.
    fireEvent.change(input, { target: { value: 'one more turn' } });
    await waitFor(() => expect(screen.queryByText('owner one private numbers')).toBeNull());
    const reloaded = await waitFor(field);
    fireEvent.click(send());

    // The question never leaves, because it would leave under owner two's
    // token. Owner one's conversation is off the screen, not merely out of the
    // hand-off store, and the box owner one was typing into is empty.
    expect(asked).toEqual(['owner one private numbers']);
    expect(screen.queryByText(GROUNDED.text)).toBeNull();
    expect(screen.queryByText('one more turn')).toBeNull();
    expect(reloaded.value).toBe('');
    live.unmount();

    // And owner two's own mount inherits nothing either.
    mount();
    await waitFor(field);
    expect(screen.queryByText('owner one private numbers')).toBeNull();
    expect(screen.queryByText('one more turn')).toBeNull();
    window.localStorage.removeItem('flockToken');
  });

  test('another tab signing in reaches this one, and takes the thread with it', async () => {
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    mount();
    const input = await waitFor(field);
    await askOnce(input, 'owner one private numbers');
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());

    // What a browser actually delivers to THIS tab when another one writes the
    // shared key. jsdom does not raise it for us, and neither does a real
    // browser for a write this document made itself, which is why the component
    // listens for it AND re-reads the key on its own.
    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    fireEvent(window, new StorageEvent('storage', { key: 'flockToken', newValue: 'token-for-owner-two' }));

    await waitFor(() => expect(screen.queryByText('owner one private numbers')).toBeNull());
    expect(screen.queryByText(GROUNDED.text)).toBeNull();
    // Still a working card. It just belongs to owner two now, and it is owner
    // two's own card: the switch re-runs the load, so this is waited for rather
    // than read off the screen the instant the thread went.
    expect(await waitFor(field)).toBeTruthy();
    window.localStorage.removeItem('flockToken');
  });

  test('an answer authorised by the account that has just been replaced is dropped, not appended', async () => {
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    let release;
    const PRIVATE = 'Owner one took 14,200 across the last four Fridays.';
    mount({ askQuestion: () => new Promise((r) => { release = () => r({ ...GROUNDED, text: PRIVATE }); }) });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'what did we take last month' } });
    fireEvent.click(send());
    expect(screen.getByText(/working on it/i)).toBeTruthy();

    // The switch lands while the request is still in the air. The reply was
    // authorised by owner one and is about owner one's takings, so it belongs
    // to nobody who is signed in by the time it arrives.
    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    fireEvent(window, new StorageEvent('storage', { key: 'flockToken', newValue: 'token-for-owner-two' }));
    // Inside act, because the drop this is testing IS a state update: the
    // resolving promise is what discards the answer and the thread with it.
    await act(async () => { release(); });

    await waitFor(() => expect(screen.queryByText(/working on it/i)).toBeNull());
    expect(screen.queryByText(PRIVATE)).toBeNull();
    expect(screen.queryByText('what did we take last month')).toBeNull();
    window.localStorage.removeItem('flockToken');
  });

  test('a storage event for any other key leaves the conversation where it is', async () => {
    // The legitimate case has to keep working: one owner, one session, a theme
    // written from another tab. A watcher that clears on every storage event
    // would throw away a conversation because somebody flipped dark mode.
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    mount();
    const input = await waitFor(field);
    await askOnce(input, 'still the same owner');
    window.localStorage.setItem('flock-theme', 'dark');
    fireEvent(window, new StorageEvent('storage', { key: 'flock-theme', newValue: 'dark' }));

    expect(screen.getByText('still the same owner')).toBeTruthy();
    expect(screen.getByText(GROUNDED.text)).toBeTruthy();
    window.localStorage.removeItem('flock-theme');
    window.localStorage.removeItem('flockToken');
  });

  // ROUND 28. THE ROUND 27 FIX WAS INCOMPLETE, AND IN ONE PLACE DESTRUCTIVE.
  //
  // Two adversarial reviews ran the component above in jsdom and found the same
  // two holes from opposite ends.
  //
  // The first is a stale request reaching forward in time. The handler that
  // discarded a response from a replaced session also called forgetOwner from
  // inside that response, so owner one's late answer wiped owner two's live
  // pending turn, owner two's half typed follow up, and (by releasing the busy
  // flag under a request that was still in flight) owner two's own answer.
  // Measured before the fix: B question on screen false, B draft empty, B
  // answer on screen false, requests issued while the first was in flight 2.
  //
  // The second is that the identity change dropped the thread and kept the
  // card. GET /questions answers FOR AN ACCOUNT, so the chip list it returns is
  // a statement about which of that venue's data classes are populated, and
  // freeText is that account's entitlement. Measured before the fix:
  // fetchQuestions calls since the switch 0, owner one's chip still on screen
  // for owner two true, owner one's free text composer still rendered true. The
  // mirror case cost a paying customer more: an owner one locked out with a 403
  // left owner two reading owner one's locked card until something remounted it.
  const deferred = () => {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    return { promise, settle: (v) => settle(v) };
  };

  test('a late answer from the replaced account discards itself and leaves the new owner alone', async () => {
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    const OWNER_ONE_ANSWER = 'Owner one took 14,200 across the last four Fridays.';
    const typed = [];
    const chips = [];
    const ownerOneRequest = deferred();
    const ownerTwoRequest = deferred();
    const live = mount({
      askQuestion: (q) => { typed.push(q); return ownerOneRequest.promise; },
      ask: (id) => { chips.push(id); return ownerTwoRequest.promise; },
    });
    let input = await waitFor(field);

    // Owner one asks. The request is in the air and stays there.
    fireEvent.change(input, { target: { value: 'what did we take last month' } });
    fireEvent.click(send());
    expect(typed).toEqual(['what did we take last month']);

    // Owner two signs in. The card correctly drops owner one's thread here,
    // which is round 27 working, and reloads the surface, which is the next
    // test down.
    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    fireEvent(window, new StorageEvent('storage', { key: 'flockToken', newValue: 'token-for-owner-two' }));
    input = await waitFor(field);

    // Owner two now has a conversation of their own going: a follow up half
    // typed in the box, and a chip question waiting on the server.
    fireEvent.change(input, { target: { value: 'and how about tomorrow' } });
    fireEvent.click(screen.getByRole('button', { name: 'How does today look?' }));
    expect(chips).toEqual(['tonight_outlook']);
    expect(screen.getByText('How does today look?')).toBeTruthy();

    // And owner one's request finally lands, long after it stopped being
    // anyone's. It is not owner two's to draw, and it is not owner two's to
    // delete either.
    await act(async () => { ownerOneRequest.settle({ ...GROUNDED, text: OWNER_ONE_ANSWER }); });

    expect(screen.queryByText(OWNER_ONE_ANSWER)).toBeNull();
    expect(screen.queryByText('what did we take last month')).toBeNull();
    // The pending line, not the chip label: a chip with the same words is on
    // screen too whenever the load has not been re-run, and it would answer
    // this assertion for the wrong reason. Only a live turn is thinking.
    expect(screen.getByText(/reading your numbers/i)).toBeTruthy();
    expect(screen.getByText('How does today look?')).toBeTruthy();
    expect(field().value).toBe('and how about tomorrow');

    // The card is still busy on owner two's own request, so the late arrival
    // cannot open the door to a second one going out behind the first. The
    // chips are queried rather than demanded because where they sit depends on
    // whether owner two's thread survived, which is the thing under test.
    const opener = screen.queryByRole('button', { name: /suggested questions/i });
    if (opener) fireEvent.click(opener);
    const chip = screen.queryByRole('button', { name: 'How does today look?' });
    if (chip && chip.tagName === 'BUTTON') fireEvent.click(chip);
    expect(chips).toEqual(['tonight_outlook']);

    // Owner two's own answer reaches owner two.
    await act(async () => { ownerTwoRequest.settle(GROUNDED); });
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());
    live.unmount();
    window.localStorage.removeItem('flockToken');
  });

  test('a change of account re-runs the whole load, not only the thread', async () => {
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    // A real chip, from the real server vocabulary. It is only ever offered to
    // a venue whose corpus can answer it, which is why handing it to somebody
    // else says something about the first venue's data.
    const OWNER_ONE_CHIP = 'Was it just us, or was everyone slow?';
    const OWNER_TWO_CHIP = 'How busy were we on Saturday?';
    const loads = [];
    const fetchQuestions = async () => {
      loads.push(window.localStorage.getItem('flockToken'));
      if (loads.length === 1) {
        return { name: 'Roost', freeText: true, lead: [{ id: 'slow_night', label: OWNER_ONE_CHIP }], groups: [] };
      }
      return { name: 'Roost', freeText: false, lead: [{ id: 'saturday', label: OWNER_TWO_CHIP }], groups: [] };
    };
    mount({ fetchQuestions });
    await waitFor(() => expect(screen.getByRole('button', { name: OWNER_ONE_CHIP })).toBeTruthy());
    expect(field()).not.toBeDisabled();

    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    fireEvent(window, new StorageEvent('storage', { key: 'flockToken', newValue: 'token-for-owner-two' }));

    await waitFor(() => expect(screen.getByRole('button', { name: OWNER_TWO_CHIP })).toBeTruthy());
    expect(loads.length).toBe(2);
    expect(loads[1]).toBe('token-for-owner-two');
    expect(screen.queryByRole('button', { name: OWNER_ONE_CHIP })).toBeNull();
    // The entitlement went with it. Owner two's server said no to typed
    // questions, so owner two gets the quiet box and the reason, not owner
    // one's working one.
    expect(field()).toBeDisabled();
    expect(screen.getByText(/typed questions are off for now/i)).toBeTruthy();
    window.localStorage.removeItem('flockToken');
  });

  test('an owner locked out with a 403 does not lock out the account that replaces them', async () => {
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    const LOCKED = 'Roost is part of the Pro plan.';
    let call = 0;
    const fetchQuestions = async () => {
      call += 1;
      if (call === 1) {
        const err = new Error('locked');
        err.status = 403;
        err.data = { error: LOCKED };
        throw err;
      }
      return QUESTIONS(true);
    };
    mount({ fetchQuestions });
    await waitFor(() => expect(screen.getByText(LOCKED)).toBeTruthy());

    // The paying customer signs in on the same handset. Inheriting the last
    // account's 403 would lock them out of something they bought, with no way
    // back short of a remount.
    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    fireEvent(window, new StorageEvent('storage', { key: 'flockToken', newValue: 'token-for-owner-two' }));

    const input = await waitFor(field);
    expect(input).not.toBeDisabled();
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(call).toBe(2);
    window.localStorage.removeItem('flockToken');
  });

  test('a re-render is enough to notice the switch, without waiting for the tick', async () => {
    // WHAT THIS CLOSES. A storage event is never delivered to the document that
    // did the writing, which is the whole reason an interval is in there, and
    // an interval means a window: at two seconds owner one's answers were
    // measured still on screen at 1999ms and gone at 2001ms. An in-app sign-in
    // re-renders the tree that owns this card, so reading the key on every
    // commit catches that case in the same frame for one string read, and the
    // interval is left to cover a sign-in that re-renders nothing here.
    window.localStorage.setItem('flockToken', 'token-for-owner-one');
    const element = () => React.createElement(VenueAdvisorChat, {
      fetchQuestions: async () => QUESTIONS(true),
      ask: async () => GROUNDED,
      askQuestion: async () => GROUNDED,
      colors: { navy: '#0d2847' },
    });
    const live = render(element());
    const input = await waitFor(field);
    await askOnce(input, 'owner one private numbers');
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());

    // No storage event and no timer. Only the render the app performs when its
    // own auth state changes.
    window.localStorage.setItem('flockToken', 'token-for-owner-two');
    await act(async () => { live.rerender(element()); });

    expect(screen.queryByText('owner one private numbers')).toBeNull();
    expect(screen.queryByText(GROUNDED.text)).toBeNull();
    window.localStorage.removeItem('flockToken');
  });

  test('the interval behind it is well under the two seconds it used to be', () => {
    const ms = parseInt(SRC.match(/const IDENTITY_POLL_MS = (\d+);/)[1], 10);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(500);
    // The per-commit read is the cheap half and has no dependency array on
    // purpose. If it grows one, it stops being a per-commit read.
    expect(SRC).toMatch(/useEffect\(\(\) => \{ checkOwner\(\); \}\);/);
  });

  test('a realm whose storage cannot be read is not the same identity as a signed out one', () => {
    // SPECULATIVE, AND JUDGED. Returning the signed-out key from the catch
    // meant that in a realm where localStorage throws, every account would
    // collapse to one key and the check above would be inert. It is not
    // reachable today: services/api.js reads the same key with a bare getItem
    // and no try/catch, so a realm that throws on read cannot authorise a
    // request in the first place, and there is no state with a live token that
    // this cannot see. The two are told apart anyway, because it costs one
    // constant, and because the day api.js grows a try/catch is not the day
    // anyone will remember this.
    const noSession = SRC.match(/const NO_SESSION = '([^']+)';/)[1];
    const unreadable = SRC.match(/const UNREADABLE_SESSION = '([^']+)';/)[1];
    expect(unreadable).not.toBe(noSession);
    expect(SRC).toMatch(/catch \(e\) \{\s*return UNREADABLE_SESSION;\s*\}/);
  });

  test('the owner’s words are on their own side, the answer is not', async () => {
    mount();
    const input = await waitFor(field);
    await askOnce(input, 'whose words are these');
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());

    const asked = screen.getByText('whose words are these');
    // A bubble in their colour, pushed to their edge. Nothing else in the card
    // is right aligned, so the shape says who is speaking.
    expect(asked.parentElement.style.justifyContent).toBe('flex-end');
    expect(asked.style.backgroundColor).toBeTruthy();
    // The answer runs plain and full width beneath it, the way a chat that has
    // to print citations under an answer does it.
    const answered = screen.getByText(GROUNDED.text);
    expect(answered.style.backgroundColor).toBeFalsy();
  });

  test('the thinking line is in the thread, never a word on the button', async () => {
    let release;
    mount({ askQuestion: () => new Promise((r) => { release = () => r(GROUNDED); }) });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'where does the wait show' } });
    fireEvent.click(send());

    const asked = screen.getByText('where does the wait show');
    const thinking = screen.getByText(/working on it/i);
    // Below the question it belongs to, and it is where the answer will land.
    expect(asked.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The send control says nothing at all; it is an arrow.
    expect(send().textContent.trim()).toBe('');
    release();
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());
  });
});

describe('Roost chat: the chips start you off and then get out of the way', () => {
  test('with nothing asked yet the chips are the offer, and so is the explainer', async () => {
    mount();
    await waitFor(field);
    expect(screen.getByRole('button', { name: 'How does today look?' })).toBeTruthy();
    expect(screen.getByText(/name their sources and dates/i)).toBeTruthy();
  });

  test('once a conversation exists the chips fold behind one line, and the explainer stops repeating', async () => {
    mount();
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'a first question' } });
    fireEvent.click(send());
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());

    // Not deleted. They are how a venue with no corpus finds out what CAN be
    // answered, so they stay one press away, still above the composer.
    expect(screen.queryByRole('button', { name: 'How does today look?' })).toBeNull();
    const opener = screen.getByRole('button', { name: /suggested questions/i });
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(opener);
    const chip = screen.getByRole('button', { name: 'How does today look?' });
    expect(chip.compareDocumentPosition(field()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The honesty paragraph was a first-run line, not a standing notice.
    expect(screen.queryByText(/name their sources and dates/i)).toBeNull();
  });
});

describe('Roost chat: the keyboard behaves like a keyboard', () => {
  test('Enter sends', async () => {
    const asked = [];
    mount({ askQuestion: async (q) => { asked.push(q); return GROUNDED; } });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'sent with the return key' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(asked).toEqual(['sent with the return key']);
    expect(input.value).toBe('');
  });

  test('Shift and Enter do not send, so a long question can have a line in it', async () => {
    const asked = [];
    mount({ askQuestion: async (q) => { asked.push(q); return GROUNDED; } });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'still writing' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(asked).toEqual([]);
    expect(input.value).toBe('still writing');
  });

  test('an empty box sends nothing, whichever way it is pressed', async () => {
    const asked = [];
    mount({ askQuestion: async (q) => { asked.push(q); return GROUNDED; } });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BIRDIE IS IN THE ROOM.
//
// Jayden, TestFlight build 26 (2026-08-21): "have Birdie pop out when it's
// talking so that it feels interactive. Like you're not just talking to a
// blank wall. And then still have Birdie as the background. It should feel
// like a regular chat." The component shipped that on 2026-08-25 and nothing
// here pinned it, so a refactor could have quietly put the blank wall back.
//
// Three placements: the greeter before a word is said, the avatar beside every
// answer, and the whisper behind the scrollback. The pin that matters on THIS
// surface, which is paid and fact-gated, is the refusal one: the bird moves
// only while an answer is in flight, and a declined question gets the same
// bird, in the same place, holding the same still pose as a grounded answer.
// He is company, never a claim about what the server knows.
// ---------------------------------------------------------------------------
describe('Roost chat: Birdie is in the room', () => {
  const CSS = fs.readFileSync(path.resolve(__dirname, '..', 'index.css'), 'utf8');
  const heads = (root) => Array.from(root.querySelectorAll('img[src$="birdie-head-400.png"]'));
  const avatars = (root) => Array.from(root.querySelectorAll('[data-roost="avatar"]'));

  const askAndWait = async (answer) => {
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'a question' } });
    fireEvent.click(send());
    await waitFor(() => expect(screen.getByText(answer.text)).toBeTruthy());
  };

  test('before a word is said Birdie greets, and nothing sits behind an empty thread', async () => {
    const { container } = mount();
    await waitFor(field);
    const greeter = container.querySelector('[data-roost="greeter"]');
    expect(greeter).not.toBeNull();
    // One composite bird (head over body), big enough to be a photograph.
    expect(heads(greeter).length).toBe(1);
    const wrap = heads(greeter)[0].closest('div[aria-hidden="true"]');
    expect(parseInt(wrap.style.width, 10)).toBeGreaterThanOrEqual(64);
    expect(container.querySelector('[data-roost="whisper"]')).toBeNull();
    expect(avatars(container).length).toBe(0);
  });

  test('once the conversation starts the greeter steps aside and the whisper stands behind the thread', async () => {
    const { container } = mount();
    await askAndWait(GROUNDED);
    expect(container.querySelector('[data-roost="greeter"]')).toBeNull();
    const whisper = container.querySelector('[data-roost="whisper"]');
    expect(whisper).not.toBeNull();
    expect(heads(whisper).length).toBe(1);
    // Decoration, and only decoration: hidden from the tree, not pressable,
    // and clipped to the frame so it can never grow the card.
    expect(whisper.getAttribute('aria-hidden')).toBe('true');
    expect(whisper.style.pointerEvents).toBe('none');
    expect(whisper.style.overflow).toBe('hidden');
    // Behind the thread, not inside it: he is fixed to the frame and the
    // turns scroll past him, so the answer text must not be his descendant.
    expect(whisper.contains(screen.getByText(GROUNDED.text))).toBe(false);
  });

  test('every answer has Birdie standing beside it, level with its first line', async () => {
    let n = 0;
    const { container } = mount({ askQuestion: async () => ({ ...GROUNDED, text: `answer number ${++n}` }) });
    const input = await waitFor(field);
    for (const q of ['one', 'two']) {
      fireEvent.change(input, { target: { value: q } });
      fireEvent.click(send());
      await waitFor(() => expect(screen.getByText(`answer number ${n}`)).toBeTruthy());
    }
    const stands = avatars(container);
    expect(stands.length).toBe(2);
    for (const [i, stand] of stands.entries()) {
      expect(heads(stand).length).toBe(1);
      // Left of the words, in the same row, and ahead of them in the tree.
      const answer = screen.getByText(`answer number ${i + 1}`);
      expect(stand.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(stand.parentElement.contains(answer)).toBe(true);
      expect(stand.parentElement.style.alignItems).toBe('flex-start');
    }
  });

  test('he pops in and bobs only while the answer is in flight, and holds still once it lands', async () => {
    let release;
    const { container } = mount({ askQuestion: () => new Promise((r) => { release = () => r(GROUNDED); }) });
    const input = await waitFor(field);
    fireEvent.change(input, { target: { value: 'is anyone there' } });
    fireEvent.click(send());

    // In flight: he is already standing where the answer will land.
    const stand = avatars(container)[0];
    expect(stand).toBeTruthy();
    expect(stand.classList.contains('roost-pop')).toBe(true);
    expect(stand.querySelector('.roost-bob')).not.toBeNull();
    expect(screen.getByText(/working on it/i)).toBeTruthy();

    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByText(GROUNDED.text)).toBeTruthy());
    // Landed: same bird, same place, no motion left on him.
    const same = avatars(container)[0];
    expect(same).toBe(stand);
    expect(same.classList.contains('roost-pop')).toBe(false);
    expect(same.querySelector('.roost-bob')).toBeNull();
  });

  test('a refusal and a greeting get the same bird, in the same place, holding the same still pose', async () => {
    const { container, unmount } = mount({ askQuestion: async () => GROUNDED });
    await askAndWait(GROUNDED);
    const grounded = avatars(container)[0];
    const groundedSize = grounded.querySelector('div[aria-hidden="true"]').style.width;
    unmount();
    clearAdvisorThread();

    // 2026-09-02: small talk is a third mode and is held to the same bird rule.
    for (const answer of [REFUSAL, SMALL_TALK]) {
      const second = mount({ askQuestion: async () => answer });
      // eslint-disable-next-line no-await-in-loop
      await askAndWait(answer);
      const refused = avatars(second.container)[0];
      expect(refused).toBeTruthy();
      expect(refused.querySelector('div[aria-hidden="true"]').style.width).toBe(groundedSize);
      expect(refused.classList.contains('roost-pop')).toBe(false);
      expect(refused.querySelector('.roost-bob')).toBeNull();
      second.unmount();
      clearAdvisorThread();
    }
    // Nothing about him is allowed to read the answer. The only class switch
    // in the avatar is on `pending`, never on the mode.
    const avatarBlock = SRC.slice(SRC.indexOf('data-roost="avatar"') - 400, SRC.indexOf('data-roost="avatar"') + 400);
    expect(avatarBlock).toContain("className={pending ? 'roost-pop' : undefined}");
    expect(avatarBlock).toContain("className={pending ? 'roost-bob' : undefined}");
    expect(avatarBlock).not.toMatch(/answer\.mode|refusal|advice|small_talk/);
  });

  test('the motion is CSS the reduced-motion rule already collapses, and the still bird only', () => {
    expect(CSS).toContain('@keyframes roostPop');
    expect(CSS).toContain('@keyframes roostBob');
    expect(CSS).toMatch(/\.roost-pop \{ animation: roostPop/);
    expect(CSS).toMatch(/\.roost-bob \{ animation: roostBob/);
    // The global rule: one iteration at effectively zero duration, for every
    // element, which turns the pop into the photograph and stops the bob.
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\*, \*::before, \*::after \{[\s\S]*?animation-duration: 0\.001ms !important;[\s\S]*?animation-iteration-count: 1 !important;/);
    // Still photographs. The rAF bird stays on Birdie's own consumer surface
    // (birdBrandMoments.test.js rule 2); this is a work tool.
    expect(SRC).not.toMatch(/<BirdieBird\b/);
    expect(SRC).toMatch(/import \{ BirdieStill, BirdNote \} from '\.\/ui\/BirdieBird';/);
    // And no avatar below the size where the photograph turns to a smudge.
    expect(parseInt(SRC.match(/const AVATAR_SIZE = (\d+);/)[1], 10)).toBeGreaterThanOrEqual(40);
  });

  test('the composer Jayden verified is unchanged: grows to 132, Enter sends, Shift+Enter breaks', async () => {
    mount();
    const input = await waitFor(field);
    expect(parseInt(SRC.match(/const COMPOSER_MAX_HEIGHT = (\d+);/)[1], 10)).toBe(132);
    expect(input.style.maxHeight).toBe('132px');
    expect(input.style.minHeight).toBe('44px');
    // Enter and Shift+Enter are pinned in their own describe above; this only
    // confirms the box they act on is the same one the bird was added around.
    expect(input.tagName).toBe('TEXTAREA');
  });
});

describe('Roost chat: SLOP pins on the source itself', () => {
  test('the product name is said once per screen: the cards title the surface, this block does not', () => {
    // Both constants still exist, so a rename is still one line each.
    expect(SRC).toMatch(/const ADVISOR_NAME = 'Roost';/);
    expect(CARDS_SRC).toMatch(/const FEATURE_NAME = 'Roost';/);
    // But the chat card's own heading is what the block IS, not the brand.
    expect(SRC).toMatch(/const BLOCK_TITLE = '[^']+';/);
    expect(SRC).not.toMatch(/const BLOCK_TITLE = 'Roost'/);
  });

  test('the ready card heads itself with the block title, not the product name', async () => {
    mount();
    await waitFor(field);
    const title = SRC.match(/const BLOCK_TITLE = '([^']+)';/)[1];
    expect(screen.getByText(title)).toBeTruthy();
  });

  test('no em dash in any owner-visible string (SLOP-AUDIT rule A2)', () => {
    // COMMENTS COME OUT FIRST, and that is the whole difference between this
    // test measuring the rule and measuring punctuation. SLOP-AUDIT A2 bans
    // the em dash from copy and says so in as many words: "Comments are not
    // copy. Count the strings, not the characters." The scanner below cannot
    // tell an apostrophe from a quote, so a prose comment about somebody
    // else's thread reads as a string literal opening at that apostrophe and
    // closing at the next one, and any em dash between them fails a file
    // whose copy is clean. That is exactly what happened: this test went red
    // on a security comment in restoreThread and stayed red, which trains the
    // next person to ignore it. Strip `//` lines and `/* */` blocks, then
    // scan what is left, which is the only part an owner can read.
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const strings = code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
    const offenders = strings.filter((s) => s.includes('—'));
    expect(offenders).toEqual([]);
  });

  test('no marketing vocabulary anywhere in the file', () => {
    expect(SRC).not.toMatch(/seamless|effortless|unlock deeper|supercharge|elevate your/i);
  });
});
