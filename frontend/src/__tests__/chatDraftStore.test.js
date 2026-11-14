/**
 * A KEYSTROKE RE-RENDERS THE CHAT BOX, NOT THE CHAT SCREEN (2026-11-14).
 *
 * Typing in a flock chat or a DM lagged on the phone because the box's text
 * was state at the top of the screen, so every character re-rendered the whole
 * screen. The text now lives in lib/draftStore.js and only ChatInputBar
 * subscribes to it. This holds the store, the bar reading it, a parent that
 * writes to it on every change without rendering again, and both screens
 * wired to it with no draft state of their own.
 *
 *   cd frontend && CI=true npx react-scripts test chatDraftStore --watchAll=false
 */
jest.mock('../services/haptics', () => ({ hapticTap: jest.fn() }));

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, act } = require('@testing-library/react');

const ChatInputBar = require('../components/chat/ChatInputBar').default;
const { createDraftStore } = require('../lib/draftStore');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

let rafSpy;
beforeEach(() => {
  rafSpy = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
});
afterEach(() => rafSpy.mockRestore());

test('the store holds text, tells its listeners once per change and never for a repeat', () => {
  const store = createDraftStore('hi');
  const heard = jest.fn();
  const stop = store.subscribe(heard);
  expect(store.get()).toBe('hi');
  store.set('hi');
  expect(heard).not.toHaveBeenCalled();
  store.set('hi there');
  expect(store.get()).toBe('hi there');
  expect(heard).toHaveBeenCalledTimes(1);
  store.set(undefined);
  expect(store.get()).toBe('');
  stop();
  store.set('gone');
  expect(heard).toHaveBeenCalledTimes(2);
});

test('typing renders the box and not the screen that holds it', () => {
  const store = createDraftStore('');
  let screenRenders = 0;
  function Screen() {
    screenRenders += 1;
    return React.createElement(ChatInputBar, {
      variant: 'flock',
      threadName: 'Friday',
      draftStore: store,
      onChange: (next) => store.set(next),
    });
  }
  render(React.createElement(Screen));
  const field = screen.getByRole('textbox');
  for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
    fireEvent.change(field, { target: { value: text } });
  }
  expect(field.value).toBe('hello');
  expect(screenRenders).toBe(1);
  // A write from the screen's side (a send clearing the box) reaches the field.
  act(() => store.set(''));
  expect(field.value).toBe('');
  expect(screenRenders).toBe(1);
});

test('a bar with no store still shows its value prop', () => {
  render(React.createElement(ChatInputBar, { variant: 'dm', threadName: 'Maya', value: 'kept' }));
  expect(screen.getByRole('textbox').value).toBe('kept');
});

test('both chat screens hand the bar a store and keep no draft state', () => {
  const chat = read('screens/ChatDetail.js');
  const dm = read('screens/DmDetail.js');
  expect(chat).toMatch(/draftStore=\{draftStoreRef\.current\}/);
  expect(dm).toMatch(/draftStore=\{dmDraftStoreRef\.current\}/);
  expect(chat).not.toMatch(/const \[draft, setDraft\]/);
  expect(dm).not.toMatch(/const \[dmDraft, setDmDraft\]/);
  expect(chat).not.toMatch(/value=\{draft\}/);
  expect(dm).not.toMatch(/value=\{dmDraft\}/);
});
