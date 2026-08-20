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
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

const VenueAdvisorChat = require('../components/VenueAdvisorChat').default;
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

    // And it is the last interactive thing in the card.
    const controls = Array.from(container.querySelectorAll('input, button'));
    expect(controls[controls.length - 1].getAttribute('type')).toBe('submit');
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
    const strings = SRC.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
    const offenders = strings.filter((s) => s.includes('—'));
    expect(offenders).toEqual([]);
  });

  test('no marketing vocabulary anywhere in the file', () => {
    expect(SRC).not.toMatch(/seamless|effortless|unlock deeper|supercharge|elevate your/i);
  });
});
