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
 *   4. The three answer modes are told apart on screen: grounded carries its
 *      sources, advice carries its marker, a refusal carries neither and never
 *      an upsell.
 *   5. The product name is said ONCE per screen. VenueInsightCards titles the
 *      surface; this block is titled for what it is.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venueAdvisorChat --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { act, render, screen, fireEvent, waitFor } = require('@testing-library/react');

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
    fireEvent.change(input, { target: { value: 'one more turn' } });
    fireEvent.click(send());

    // The question never leaves, because it would leave under owner two's
    // token. Owner one's conversation is off the screen, not merely out of the
    // hand-off store, and the box owner one was typing into is empty.
    expect(asked).toEqual(['owner one private numbers']);
    await waitFor(() => expect(screen.queryByText('owner one private numbers')).toBeNull());
    expect(screen.queryByText(GROUNDED.text)).toBeNull();
    expect(screen.queryByText('one more turn')).toBeNull();
    expect(input.value).toBe('');
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
    // Still a working card. It just belongs to owner two now.
    expect(field()).toBeTruthy();
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
