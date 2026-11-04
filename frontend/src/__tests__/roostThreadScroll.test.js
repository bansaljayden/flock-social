/**
 * WHERE ROOST'S THREAD LANDS WHEN AN ANSWER ARRIVES (2026-11-03).
 *
 * Filming the LionCage demo, the answer to "How did we do yesterday?" was
 * taller than the Ask a question card's scrollback, and the card, which pinned
 * its thread to the end on every change, cut the answer's first line
 * ("Thursday came in 20 points above...") under its top edge.
 * components/VenueAdvisorChat.js now lands an answer taller than the
 * scrollback with its first line at the top, still pins one that fits to the
 * end, pins the owner's own question to the end, and never moves for an answer
 * when the owner scrolled away on purpose. The geometry is lib/threadLanding.js,
 * the same one Birdie's panel lands with (birdieThreadScroll.test.js).
 *
 * jsdom lays nothing out, and the card lands in a layout effect, before paint,
 * so the fake layout has to be in place during the render itself: each test
 * gives the scrollback a viewport, a content height and a top for every
 * answer row (`L` below) through the prototype's own getters, which read it
 * at the moment the card measures.
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import VenueAdvisorChat, { clearAdvisorThread } from '../components/VenueAdvisorChat';
import { landingTop, awayFromEnd } from '../lib/threadLanding';

const QUESTIONS = {
  name: 'Roost',
  freeText: true,
  lead: [
    { id: 'yesterday_recap', label: 'How did we do yesterday?' },
    { id: 'money_move', label: 'What is our best money move this week?' },
  ],
  groups: [],
};

const TALL = {
  mode: 'phrased',
  text: 'Thursday came in 20 points above your usual Thursday.\n• The rush started an hour early, at 6 PM.\n• It held past 10 PM.\n• Friday looks the same.',
  sources: [{ id: 'yesterday', source: 'owner_report', asOf: '2026-10-30' }],
  followUps: [{ kind: 'intent', id: 'money_move' }],
};
const SHORT = { mode: 'phrased', text: 'Friday is your busiest night this week.', sources: [] };

// The layout the card measures: the scrollback is `viewport` tall at viewport
// top 100 with `content` px of turns in it, and rows[i] is where answer row i
// starts in that content. Rows report their position relative to the current
// scroll, the way a browser would.
let L;
const thread = (container) => container.querySelector('[data-roost="thread"]');
const isThread = (el) => !!el && typeof el.getAttribute === 'function' && el.getAttribute('data-roost') === 'thread';
const rect = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 360, width: 360, x: 0, y: top });

beforeEach(() => {
  clearAdvisorThread();
  L = { viewport: 340, content: 0, rows: [] };
  jest.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
    return isThread(this) ? L.viewport : 0;
  });
  jest.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
    return isThread(this) ? L.content : 0;
  });
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
    if (isThread(this)) return rect(100, L.viewport);
    if (this.hasAttribute('data-roost-answer')) {
      const box = this.closest('[data-roost="thread"]');
      const i = Array.from(box.querySelectorAll('[data-roost-answer]')).indexOf(this);
      return rect(100 + L.rows[i] - box.scrollTop, 40);
    }
    return rect(0, 0);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  clearAdvisorThread();
});

// One question at a time, its answer released by hand. The first question is
// a chip; once a conversation exists the chips fold away behind one line, so
// later ones are typed, the way an owner asks a follow-up.
function mountCard() {
  let release = null;
  const pending = () => new Promise((resolve) => { release = resolve; });
  const utils = render(<VenueAdvisorChat fetchQuestions={async () => QUESTIONS} ask={jest.fn(pending)} askQuestion={jest.fn(pending)} colors={{ navy: '#0d2847' }} />);
  const answer = async (payload) => { await act(async () => { release(payload); }); };
  const type = (text) => {
    fireEvent.change(screen.getByRole('textbox', { name: /ask roost a question/i }), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /send your question/i }));
  };
  return { ...utils, answer, type };
}
const chip = (name) => screen.getByRole('button', { name });

test('the owner\'s question pins the thread to its end, Birdie standing where the answer will land', async () => {
  const { container, answer, type } = mountCard();
  await waitFor(() => chip('How did we do yesterday?'));
  L = { viewport: 340, content: 120, rows: [56] };
  fireEvent.click(chip('How did we do yesterday?'));
  const box = thread(container);
  expect(box.scrollTop).toBe(120);

  // With a thread already there, the next question still goes to the end.
  L = { viewport: 340, content: 300, rows: [56] };
  await answer(SHORT);
  L = { viewport: 340, content: 620, rows: [56, 520] };
  type('What is our best money move this week?');
  expect(box.scrollTop).toBe(620);
});

test('an answer taller than the scrollback lands with its first line at the top, not its last line', async () => {
  const { container, answer } = mountCard();
  await waitFor(() => chip('How did we do yesterday?'));
  L = { viewport: 340, content: 120, rows: [56] };
  fireEvent.click(chip('How did we do yesterday?'));
  const box = thread(container);

  L = { viewport: 340, content: 900, rows: [56] };
  await answer(TALL);
  expect(screen.getByText('Thursday came in 20 points above your usual Thursday.')).toBeTruthy();
  // The answer row starts at 56; it keeps the 10 px it has under its question,
  // so the first line sits just under the top edge instead of above it.
  expect(box.scrollTop).toBe(46);
});

test('an answer that fits still pins to the end, short thread or long', async () => {
  const { container, answer, type } = mountCard();
  await waitFor(() => chip('How did we do yesterday?'));
  L = { viewport: 340, content: 120, rows: [56] };
  fireEvent.click(chip('How did we do yesterday?'));
  const box = thread(container);
  L = { viewport: 340, content: 300, rows: [56] };
  await answer(SHORT);
  expect(box.scrollTop).toBe(300);

  // A long thread whose newest answer fits under the fold: the end, as before.
  L = { viewport: 340, content: 1040, rows: [56, 960] };
  type('What is our best money move this week?');
  L = { viewport: 340, content: 1200, rows: [56, 960] };
  await answer(SHORT);
  expect(box.scrollTop).toBe(1200);
});

test('the view never moves for an answer once the owner has scrolled away on purpose', async () => {
  const { container, answer, type } = mountCard();
  await waitFor(() => chip('How did we do yesterday?'));
  L = { viewport: 340, content: 120, rows: [56] };
  fireEvent.click(chip('How did we do yesterday?'));
  const box = thread(container);
  L = { viewport: 340, content: 300, rows: [56] };
  await answer(SHORT);

  // While the next answer is on its way, the owner scrolls up to reread.
  L = { viewport: 340, content: 700, rows: [56, 660] };
  type('What is our best money move this week?');
  box.scrollTop = 0;
  fireEvent.scroll(box);
  L = { viewport: 340, content: 1300, rows: [56, 660] };
  await answer(TALL);
  expect(box.scrollTop).toBe(0);

  // Their next question brings them back down.
  L = { viewport: 340, content: 1380, rows: [56, 660, 1340] };
  type('And last Friday?');
  expect(box.scrollTop).toBe(1380);
});

test('coming back to the tab lands on the last answer\'s first line, not the top of the conversation', async () => {
  const first = mountCard();
  await waitFor(() => chip('How did we do yesterday?'));
  L = { viewport: 340, content: 120, rows: [56] };
  fireEvent.click(chip('How did we do yesterday?'));
  L = { viewport: 340, content: 900, rows: [56] };
  await first.answer(TALL);
  // The dashboard unmounts the card on every tab switch; the thread survives.
  first.unmount();

  const again = mountCard();
  await waitFor(() => expect(screen.getByText('Thursday came in 20 points above your usual Thursday.')).toBeTruthy());
  expect(thread(again.container).scrollTop).toBe(46);
});

test('a short restored thread comes back pinned to its end', async () => {
  const first = mountCard();
  await waitFor(() => chip('How did we do yesterday?'));
  L = { viewport: 340, content: 120, rows: [56] };
  fireEvent.click(chip('How did we do yesterday?'));
  L = { viewport: 340, content: 300, rows: [56] };
  await first.answer(SHORT);
  first.unmount();

  const again = mountCard();
  await waitFor(() => expect(screen.getByText(SHORT.text)).toBeTruthy());
  expect(thread(again.container).scrollTop).toBe(300);
});

describe('lib/threadLanding.js, the geometry both threads land with', () => {
  const box = ({ scrollTop = 0, viewport, content }) => ({
    scrollTop,
    clientHeight: viewport,
    scrollHeight: content,
    getBoundingClientRect: () => rect(100, viewport),
  });
  const row = (b, top) => ({ getBoundingClientRect: () => rect(100 + top - b.scrollTop, 40) });

  test('a row whose top would be out of view at the end lands at that top, less the gap', () => {
    const b = box({ scrollTop: 0, viewport: 340, content: 900 });
    expect(landingTop(b, row(b, 56), 10)).toBe(46);
    // Wherever the thread happens to be scrolled, the answer is the same.
    const scrolled = box({ scrollTop: 400, viewport: 340, content: 900 });
    expect(landingTop(scrolled, row(scrolled, 56), 10)).toBe(46);
  });

  test('a row that is in view at the end, or no row at all, means pin to the end', () => {
    const b = box({ viewport: 340, content: 900 });
    expect(landingTop(b, row(b, 700), 10)).toBeNull();
    expect(landingTop(b, null, 10)).toBeNull();
    expect(landingTop(box({ viewport: 340, content: 200 }), row(b, 20), 10)).toBeNull();
  });

  test('never above the top of the thread', () => {
    const b = box({ viewport: 340, content: 900 });
    expect(landingTop(b, row(b, 4), 10)).toBe(0);
  });

  test('away from the end means further than the slack', () => {
    expect(awayFromEnd(box({ scrollTop: 560, viewport: 340, content: 900 }))).toBe(false);
    expect(awayFromEnd(box({ scrollTop: 520, viewport: 340, content: 900 }))).toBe(false);
    expect(awayFromEnd(box({ scrollTop: 500, viewport: 340, content: 900 }))).toBe(true);
    expect(awayFromEnd(box({ scrollTop: 0, viewport: 340, content: 900 }))).toBe(true);
  });
});
