// ---------------------------------------------------------------------------
// THE REBUILT CHAT COMPOSER, MOUNTED AND DRIVEN.
//
// WHAT THIS COVERS
// `components/chat/ChatInputBar.js`, the composer that replaces the two inline
// input rows in `screens/ChatDetail.js` and `screens/DmDetail.js`. Each of
// these is a thing a person would notice within a second of using the chat:
//
//   1. the field starts one line tall, grows with the text, and stops at five
//   2. Enter sends, Shift with Enter makes a newline
//   3. there is NO send control until there is something to send
//   4. the placeholder says "Send a chat" in a DM and names the flock in a flock
//   5. every icon-only control carries an aria-label and the 44pt hit class
//   6. the banner above the field is independent of whether the field is off,
//      and its live region is in the tree before the sentence arrives
//   7. one send path: one haptic, one onSend, from the key and from the button
//   8. the caret colour goes on as a custom property and never inline
//
// It also covers `hooks/useKeyboardComposer.js`, the other half of this
// composer: the bar rides the keyboard and that hook is what moves it. Section
// 9 pins the two things a mounted-and-unmounted hook has to get right, the
// state it opens into and the state it leaves behind.
//
// WHY THE TWO GLOBALS ARE STUBBED
// jsdom does not lay text out, so `scrollHeight` on a textarea is always 0 and
// the growth measurement has nothing to measure. The stub below gives it the
// one thing it needs: a height that is a function of the number of lines, at
// the same 20px line height and 20px of vertical padding the real pill uses.
// `requestAnimationFrame` is made synchronous for the same reason the component
// uses it at all: the measurement is deliberately one frame late, and a test
// should not have to wait a frame to read a number the browser already knows.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test chatInputBar --watchAll=false
// ---------------------------------------------------------------------------

// The haptic is a bridge call, so it is stubbed rather than exercised. What is
// being pinned is that exactly one fires per send and none fires for a send
// that could not happen, which is settled decision 7 in CHAT-REBUILD-PLAN.md.
jest.mock('../services/haptics', () => ({ hapticTap: jest.fn() }));

const React = require('react');
const { render, screen, fireEvent, renderHook, act } = require('@testing-library/react');

const ChatInputBar = require('../components/chat/ChatInputBar').default;
const {
  default: useKeyboardComposer,
  KEYBOARD_SHOW_MS,
} = require('../hooks/useKeyboardComposer');
const { hapticTap } = require('../services/haptics');

const LINE_H = 20;
const PADDING = 20;

let scrollHeightSpy;
let rafSpy;
let cafSpy;

beforeAll(() => {
  scrollHeightSpy = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    'scrollHeight'
  );
  Object.defineProperty(window.HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      const lines = String(this.value || '').split('\n').length;
      return lines * LINE_H + PADDING;
    },
  });
  rafSpy = jest.spyOn(window, 'requestAnimationFrame');
  cafSpy = jest.spyOn(window, 'cancelAnimationFrame');
});

// react-scripts turns on jest's `resetMocks`, which strips every mock
// IMPLEMENTATION before each test while leaving the spy in place. So the two
// frame functions are re-implemented here and not in beforeAll: set there, they
// were wiped before the first test ran, `requestAnimationFrame` returned
// undefined without ever calling back, and the growth assertions read the
// height React had written from the style prop instead of the one the component
// measured. Five of them were green on nothing.
beforeEach(() => {
  rafSpy.mockImplementation((cb) => {
    cb(0);
    return 1;
  });
  cafSpy.mockImplementation(() => {});
  hapticTap.mockClear();
});

afterAll(() => {
  delete window.HTMLTextAreaElement.prototype.scrollHeight;
  if (scrollHeightSpy) {
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', scrollHeightSpy);
  }
  rafSpy.mockRestore();
  cafSpy.mockRestore();
});

const baseProps = (over = {}) => ({
  variant: 'dm',
  threadName: 'Maya',
  value: '',
  onChange: jest.fn(),
  onSend: jest.fn(),
  onCamera: jest.fn(),
  onLibrary: jest.fn(),
  onPlus: jest.fn(),
  ...over,
});

const mount = (over) => {
  const props = baseProps(over);
  const view = render(React.createElement(ChatInputBar, props));
  return { props, view };
};

const field = () => screen.getByRole('textbox');

/* ── 1. growth, and the five-line ceiling ───────────────────────────────── */

describe('the field grows with the text and stops at five lines', () => {
  test('one line of text is one line tall', () => {
    mount({ value: 'sounds good' });
    expect(field().style.height).toBe('40px');
    expect(field().style.overflowY).toBe('hidden');
  });

  test('an empty field is still one line tall, never zero', () => {
    mount({ value: '' });
    expect(field().style.height).toBe('40px');
  });

  test('three lines grow the pill', () => {
    mount({ value: 'one\ntwo\nthree' });
    expect(field().style.height).toBe('80px');
    expect(field().style.overflowY).toBe('hidden');
  });

  test('five lines is the ceiling', () => {
    mount({ value: 'a\nb\nc\nd\ne' });
    expect(field().style.height).toBe('120px');
    expect(field().style.overflowY).toBe('hidden');
  });

  test('past five lines the box stops growing and the text scrolls inside it', () => {
    mount({ value: 'a\nb\nc\nd\ne\nf\ng\nh' });
    expect(field().style.height).toBe('120px');
    expect(field().style.overflowY).toBe('auto');
  });

  test('the height follows the text back down again', () => {
    const props = baseProps({ value: 'a\nb\nc\nd\ne\nf' });
    const { rerender } = render(React.createElement(ChatInputBar, props));
    expect(field().style.height).toBe('120px');
    rerender(React.createElement(ChatInputBar, { ...props, value: 'a' }));
    expect(field().style.height).toBe('40px');
    expect(field().style.overflowY).toBe('hidden');
  });
});

/* ── 2. Enter sends, Shift with Enter does not ──────────────────────────── */

describe('Enter sends and Shift with Enter makes a newline', () => {
  test('Enter with text sends', () => {
    const { props } = mount({ value: 'on my way' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  test('Shift with Enter does not send', () => {
    const { props } = mount({ value: 'on my way' });
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  test('Enter on an empty field sends nothing', () => {
    const { props } = mount({ value: '   ' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  test('the return key on the phone is labelled to agree with that', () => {
    mount({ value: 'hi' });
    expect(field().getAttribute('enterkeyhint')).toBe('send');
  });
});

/* ── 3. the send control exists only when there is something to send ────── */

describe('there is no send button until there is something to send', () => {
  test('an empty field shows the plus and no send control', () => {
    mount({ value: '' });
    expect(screen.queryByLabelText('Send message')).toBeNull();
    expect(screen.getByLabelText('More to send')).toBeTruthy();
  });

  test('whitespace alone is not something to send', () => {
    mount({ value: '   ' });
    expect(screen.queryByLabelText('Send message')).toBeNull();
  });

  test('one character turns the plus into send', () => {
    mount({ value: 'k' });
    expect(screen.getByLabelText('Send message')).toBeTruthy();
    expect(screen.queryByLabelText('More to send')).toBeNull();
  });

  test('a photo waiting to go arms send with no caption', () => {
    // The one exception to the empty-field rule, and it is deliberate: a
    // caption-free photo would otherwise have no way out of the preview bar.
    mount({ value: '', pendingImage: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(screen.getByLabelText('Send message')).toBeTruthy();
  });

  test('the send control is never rendered disabled', () => {
    mount({ value: 'ready' });
    expect(screen.getByLabelText('Send message').disabled).toBe(false);
  });

  test('a disabled composer shows the reason and no send control', () => {
    mount({
      value: 'hello',
      disabled: true,
      disabledReason: 'You cannot message this account. Unblock them in Settings to write again.',
    });
    expect(screen.queryByLabelText('Send message')).toBeNull();
    expect(
      screen.getByText('You cannot message this account. Unblock them in Settings to write again.')
    ).toBeTruthy();
  });
});

/* ── 4. the placeholder ─────────────────────────────────────────────────── */

describe('the placeholder says where you are', () => {
  test('a DM says "Send a chat"', () => {
    mount({ variant: 'dm', threadName: 'Maya' });
    expect(field().getAttribute('placeholder')).toBe('Send a chat');
  });

  test('a flock names the flock', () => {
    mount({ variant: 'flock', threadName: 'Friday at Kome' });
    expect(field().getAttribute('placeholder')).toBe('Message Friday at Kome');
  });

  test('a flock with no name yet falls back rather than printing "Message undefined"', () => {
    mount({ variant: 'flock', threadName: '' });
    expect(field().getAttribute('placeholder')).toBe('Send a chat');
  });
});

/* ── 5. the accessibility floor ─────────────────────────────────────────── */

describe('every icon-only control is labelled and finger sized', () => {
  const everything = {
    value: 'a caption',
    variant: 'flock',
    threadName: 'Friday at Kome',
    replyTo: { id: 4, sender: 'Maya', preview: 'is anyone driving' },
    pendingImage: 'data:image/png;base64,iVBORw0KGgo=',
    sharingLocation: true,
    locationLabel: 'Sharing for 42 min',
    imageError: 'The upload timed out.',
    onRetryImage: jest.fn(),
  };

  test('no button reaches the screen without a name', () => {
    mount(everything);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    const unnamed = buttons.filter(
      (b) => !b.getAttribute('aria-label') && !(b.textContent || '').trim()
    );
    expect(unnamed).toEqual([]);
  });

  test('every button carries the 44pt hit class', () => {
    mount(everything);
    const missing = screen
      .getAllByRole('button')
      .filter((b) => !b.className.split(/\s+/).includes('hit44'))
      .map((b) => b.getAttribute('aria-label') || b.textContent);
    expect(missing).toEqual([]);
  });

  test('the field is named for the conversation, not left to the placeholder', () => {
    mount({ variant: 'dm', threadName: 'Maya' });
    expect(field().getAttribute('aria-label')).toBe('Message Maya');
    expect(field().getAttribute('placeholder')).toBe('Send a chat');
  });

  test('the field stays at 16px so iOS does not zoom the screen on focus', () => {
    mount({ value: 'hi' });
    // The size lives on .chat-composer-field in chatInput.css, which jsdom
    // does not apply, so the class is what is asserted here. The computed
    // value is pinned app-wide by iosFocusZoomFontFloor.test.js.
    expect(field().className.split(/\s+/)).toContain('chat-composer-field');
  });

  test('the polite region is in the tree before there is anything to say', () => {
    // A region created together with its own first message is an element
    // insertion, and VoiceOver routinely says nothing about one. SLOP-AUDIT.md
    // section N. So the region is mounted empty and only its text changes.
    const props = baseProps({ disabledReason: '' });
    const { container, rerender } = render(React.createElement(ChatInputBar, props));

    const region = container.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('');

    rerender(React.createElement(ChatInputBar, {
      ...props,
      disabled: true,
      disabledReason: 'This flock ended. You can still read it.',
    }));

    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toBe('This flock ended. You can still read it.');
  });
});

/* ── 6. the banner does not depend on the field being off ───────────────── */

describe('a live field can still carry a banner', () => {
  // Settled decision 5 in CHAT-REBUILD-PLAN.md: the first message to someone
  // you are not connected to yet carries the friend request, so the field stays
  // live and the sentence sits above it. Gating the sentence on `disabled` made
  // that combination unreachable from the props.
  const notConnected = 'Not connected yet. Your first message goes with a friend request.';

  test('the sentence renders with the field still live', () => {
    mount({ value: 'hey, it is Sam', disabledReason: notConnected });
    expect(screen.getByText(notConnected)).toBeTruthy();
    expect(field().disabled).toBe(false);
    expect(screen.getByLabelText('Send message')).toBeTruthy();
  });

  test('and it still sends', () => {
    const { props } = mount({ value: 'hey, it is Sam', disabledReason: notConnected });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  test('a composer that is off with nothing to say draws no sentence', () => {
    const { view } = mount({ disabled: true, disabledReason: '' });
    expect(view.container.querySelector('[aria-live="polite"]').textContent).toBe('');
  });
});

/* ── 7. one send path ───────────────────────────────────────────────────── */

describe('sending is one path, and the haptic is on it', () => {
  test('the return key sends once and buzzes once', () => {
    const { props } = mount({ value: 'on my way' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  test('the send button sends once and buzzes once', () => {
    const { props } = mount({ value: 'on my way' });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  test('a send that cannot happen does not buzz', () => {
    const { props } = mount({ value: '   ' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(hapticTap).not.toHaveBeenCalled();
  });
});

/* ── 8. the caret ───────────────────────────────────────────────────────── */

describe('the caret colour is a custom property, not an inline caret-color', () => {
  // useKeyboardComposer hides this caret with a class for the length of every
  // keyboard slide, because iOS draws it outside the compositor and it does not
  // ride the transform. An inline `caret-color` would outrank that class and
  // the hiding would silently do nothing.
  test('the viewer colour arrives as --chat-caret', () => {
    mount({ value: 'hi', ownColor: 'rgb(224, 76, 90)' });
    expect(field().style.getPropertyValue('--chat-caret')).toBe('rgb(224, 76, 90)');
  });

  test('and nothing writes caret-color inline, with a colour or without one', () => {
    const coloured = mount({ value: 'hi', ownColor: 'rgb(224, 76, 90)' })
      .view.container.querySelector('textarea');
    expect(coloured.getAttribute('style')).not.toMatch(/caret-color/);

    const plain = mount({ value: 'hi' }).view.container.querySelector('textarea');
    expect(plain.getAttribute('style')).not.toMatch(/caret-color/);
    expect(plain.style.getPropertyValue('--chat-caret')).toBe('');
  });
});

/* ── the controls call what they say they call ──────────────────────────── */

describe('the buttons are wired to their props', () => {
  test('the camera opens the camera', () => {
    const { props } = mount({ value: '' });
    fireEvent.click(screen.getByLabelText('Take a photo'));
    expect(props.onCamera).toHaveBeenCalledTimes(1);
  });

  test('the library icon inside the pill opens the library', () => {
    const { props } = mount({ value: '' });
    fireEvent.click(screen.getByLabelText('Choose a photo from your library'));
    expect(props.onLibrary).toHaveBeenCalledTimes(1);
  });

  test('the library icon steps aside once there is text', () => {
    mount({ value: 'typing' });
    expect(screen.queryByLabelText('Choose a photo from your library')).toBeNull();
  });

  test('the plus opens the composer sheet', () => {
    const { props } = mount({ value: '' });
    fireEvent.click(screen.getByLabelText('More to send'));
    expect(props.onPlus).toHaveBeenCalledTimes(1);
  });

  test('typing reports the new value up, not a DOM event', () => {
    const { props } = mount({ value: '' });
    fireEvent.change(field(), { target: { value: 'yes' } });
    expect(props.onChange).toHaveBeenCalledWith('yes');
  });
});

/* ── 9. the keyboard dock: the state it opens into, and what it leaves ──── */

// `hooks/useKeyboardComposer.js`. Two facts about a chat screen make this
// section necessary. The chat opens with the keyboard ALREADY UP (settled
// decision 4 in CHAT-REBUILD-PLAN.md, and ChatInputBar's autoFocus produces
// it), so the first paint is the case that matters most and it is the one case
// no event covers: the rise is over before anything is listening. And the hook
// holds two viewport listeners, two bridge handles, a focusout listener and a
// 250ms timer, all of which have to be gone when the screen is.

const installViewport = (height) => {
  const bound = {};
  const vv = {
    height,
    offsetTop: 0,
    addEventListener: (type, fn) => { bound[type] = fn; },
    removeEventListener: (type, fn) => { if (bound[type] === fn) delete bound[type]; },
    bound,
  };
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: vv,
  });
  return vv;
};

// The Capacitor Keyboard plugin is not installed (decision 1 in the hook), so
// the device path is reached the way the hook reaches it on a real build:
// through `window.Capacitor.Plugins`.
const installKeyboardPlugin = () => {
  const on = {};
  const handles = [];
  const keyboard = {
    setResizeMode: jest.fn(() => Promise.resolve()),
    addListener: (name, fn) => {
      on[name] = fn;
      const handle = { remove: jest.fn() };
      handles.push(handle);
      return Promise.resolve(handle);
    },
    hide: jest.fn(() => Promise.resolve()),
  };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { Keyboard: keyboard } };
  return { keyboard, on, handles };
};

// The device path awaits four bridge calls before it is listening, and each is
// one microtask. Draining them by hand is what makes "the listener bound late"
// a thing a test can express.
const settleBridge = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

describe('the keyboard dock reads the state the chat opens into', () => {
  afterEach(() => {
    delete window.visualViewport;
    delete window.Capacitor;
  });

  test('a keyboard already up at mount is read on the first paint', () => {
    installViewport(window.innerHeight - 300);
    const { result } = renderHook(() => useKeyboardComposer());
    expect(result.current.keyboardHeight).toBe(300);
    expect(result.current.bottomInset).toBe(300);
  });

  test('a keyboard that is down at mount commits nothing', () => {
    installViewport(window.innerHeight);
    const { result } = renderHook(() => useKeyboardComposer());
    expect(result.current.bottomInset).toBe(0);
    expect(result.current.transitioning).toBe(false);
  });

  test('the plugin binds late, and the state is read the moment it does', async () => {
    // The exact hole: the rise happens while the four bridge calls are in
    // flight, so no listener hears it, and the viewport read at mount saw
    // nothing because the WebView was still resizing itself in step with it.
    const vv = installViewport(window.innerHeight);
    installKeyboardPlugin();
    const { result } = renderHook(() => useKeyboardComposer());
    expect(result.current.bottomInset).toBe(0);

    vv.height = window.innerHeight - 336;
    await settleBridge();

    expect(result.current.bottomInset).toBe(336);
  });

  test('a will-show naming the height that read already applied moves nothing twice', async () => {
    const vv = installViewport(window.innerHeight);
    const plugin = installKeyboardPlugin();
    const bar = document.createElement('div');
    const { result } = renderHook(() => useKeyboardComposer());
    act(() => { result.current.registerBar(bar); });

    vv.height = window.innerHeight - 336;
    await settleBridge();
    expect(result.current.bottomInset).toBe(336);

    act(() => { plugin.on.keyboardWillShow({ keyboardHeight: 336 }); });

    expect(result.current.bottomInset).toBe(336);
    expect(result.current.transitioning).toBe(false);
    expect(bar.style.transform).toBe('');
  });

  test('and a height that is genuinely different still moves', async () => {
    // The other side of that guard: the emoji keyboard changes height while
    // open and reports a second will-show, which has to run the whole slide.
    const vv = installViewport(window.innerHeight);
    const plugin = installKeyboardPlugin();
    const bar = document.createElement('div');
    const { result } = renderHook(() => useKeyboardComposer());
    act(() => { result.current.registerBar(bar); });

    vv.height = window.innerHeight - 336;
    await settleBridge();

    jest.useFakeTimers();
    try {
      act(() => { plugin.on.keyboardWillShow({ keyboardHeight: 420 }); });
      expect(result.current.transitioning).toBe(true);

      act(() => { jest.advanceTimersByTime(KEYBOARD_SHOW_MS); });
      expect(result.current.bottomInset).toBe(420);
      expect(result.current.transitioning).toBe(false);
      expect(bar.style.transform).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });

  test('unmount releases every listener, every handle and the pending timer', async () => {
    const vv = installViewport(window.innerHeight);
    const plugin = installKeyboardPlugin();
    const input = document.createElement('textarea');
    const removeInputListener = jest.spyOn(input, 'removeEventListener');

    const { result, unmount } = renderHook(() => useKeyboardComposer());
    act(() => { result.current.registerInput(input); });
    await settleBridge();

    expect(Object.keys(vv.bound).sort()).toEqual(['resize', 'scroll']);
    expect(plugin.handles).toHaveLength(2);

    jest.useFakeTimers();
    try {
      act(() => { plugin.on.keyboardWillShow({ keyboardHeight: 300 }); });
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      unmount();

      expect(jest.getTimerCount()).toBe(0);
      expect(vv.bound).toEqual({});
      plugin.handles.forEach((handle) => expect(handle.remove).toHaveBeenCalledTimes(1));
      // The whole app's keyboard depends on this one going back.
      expect(plugin.keyboard.setResizeMode).toHaveBeenLastCalledWith({ mode: 'native' });
      expect(removeInputListener).toHaveBeenCalledWith('focusout', expect.any(Function));
    } finally {
      jest.useRealTimers();
    }
  });
});
