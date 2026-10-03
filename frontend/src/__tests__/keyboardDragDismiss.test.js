/**
 * Dragging down from the newest message puts the keyboard away, in a thread
 * long enough to scroll (app audit 2026-10-03). The check used to read "at the
 * bottom" on the move, after the drag had already scrolled the list off it, so
 * it passed only on threads too short to scroll. It reads where the list was
 * when the finger came down. FRONTEND test (jest via react-scripts): the real
 * hook, driven with touch events.
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import useKeyboardComposer from '../hooks/useKeyboardComposer';

function Harness({ onReady }) {
  const kb = useKeyboardComposer();
  React.useEffect(() => { onReady(kb); });
  return null;
}

function setup({ scrollTop }) {
  let kb = null;
  render(<Harness onReady={(k) => { kb = k; }} />);
  const list = document.createElement('div');
  Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 600, configurable: true });
  list.scrollTop = scrollTop;
  const input = document.createElement('textarea');
  document.body.appendChild(input);
  const blur = jest.spyOn(input, 'blur');
  act(() => { kb.registerList(list); kb.registerInput(input); });
  const touch = (type, y) => kb.dismissOnDrag({ type, touches: type === 'touchend' ? [] : [{ clientY: y }], changedTouches: [{ clientY: y }] });
  return { list, blur, touch };
}

test('a drag down that starts at the newest message dismisses, even though it scrolls the list', () => {
  const { list, blur, touch } = setup({ scrollTop: 1400 }); // at the bottom
  expect(touch('touchstart', 300)).toBe(false);
  list.scrollTop = 1370; // the drag scrolls toward older messages as it goes
  expect(touch('touchmove', 320)).toBe(false); // not past the threshold yet
  list.scrollTop = 1340;
  expect(touch('touchmove', 340)).toBe(true);
  expect(blur).toHaveBeenCalledTimes(1);
});

test('a drag that starts up in the history only scrolls', () => {
  const { blur, touch } = setup({ scrollTop: 400 });
  touch('touchstart', 300);
  expect(touch('touchmove', 400)).toBe(false);
  expect(blur).not.toHaveBeenCalled();
});

test('one dismissal per drag, and a new touch starts over', () => {
  const { blur, touch } = setup({ scrollTop: 1400 });
  touch('touchstart', 300);
  expect(touch('touchmove', 340)).toBe(true);
  expect(touch('touchmove', 380)).toBe(false);
  touch('touchend', 380);
  expect(blur).toHaveBeenCalledTimes(1);
});
