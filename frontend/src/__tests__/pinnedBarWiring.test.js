/**
 * PINNED MESSAGES, the client half (migration 068).
 *
 * PinnedMessageBar was built, tested and exported and nothing imported it,
 * because the table it reads did not exist. Its own header said "migration 066
 * adds the pinned_messages table"; 066 became the flock reply and nothing
 * tracked that the table had never been written, so the plan drifted from the
 * code and the drift was invisible.
 *
 * Shared pins: anyone in the thread can pin, up to three, and everyone sees
 * them. The interesting client-side questions all come from "shared" - the
 * list can change under you while you are looking at it.
 */

const React = require('react');
const { render, screen } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const appSrc = read('App.js');
const chatDetailSrc = read('screens', 'ChatDetail.js');
const apiSrc = read('services', 'api.js');
const socketSrc = read('services', 'socket.js');
const PinnedMessageBar = require('../components/chat/sheets/PinnedMessageBar').default;

describe('the list is the server\'s answer, never assembled here', () => {
  test('both actions return the WHOLE list and it replaces what was held', () => {
    /* The server is the only thing that knows what this reader is allowed to
       see: a pin whose message was posted by somebody they blocked is filtered
       out of their copy. A client splicing one row into a list it already had
       would be deciding that for itself. */
    expect(apiSrc).toMatch(/export async function pinFlockMessage/);
    expect(apiSrc).toMatch(/export async function unpinFlockMessage/);
    expect(appSrc).toMatch(/const applyPins = useCallback\(\(flockId, pins\) =>/);
    expect(appSrc).toMatch(/applyPins\(flockId, await apiPinFlockMessage\(flockId, messageId\)\)/);
    expect(appSrc).toMatch(/applyPins\(flockId, await apiUnpinFlockMessage\(flockId, messageId\)\)/);
  });

  test('the live event carries the whole list too, per member', () => {
    // There is no "pin added" event, for the same reason.
    expect(socketSrc).toMatch(/export function onFlockPinsChanged/);
    expect(socketSrc).toMatch(/register\('flock_pins_changed', callback\)/);
    expect(appSrc).toMatch(/const unsubPins = onFlockPinsChanged\(/);
    expect(appSrc).toMatch(/unsubPins\(\);/);
  });

  test('a pin event that changes nothing does not re-render an open thread', () => {
    const listener = appSrc.slice(
      appSrc.indexOf('const unsubPins = onFlockPinsChanged('),
      appSrc.indexOf('return () => { unsubDelivered();')
    );
    expect(listener).toMatch(/return touched \? next : prev;/);
    expect(listener).toMatch(/before\.every\(\(p, i\) => String\(p\.id\) === String\(pins\[i\]\.id\)\)/);
  });

  test('the pins ride with the history read rather than a second round trip', () => {
    expect(appSrc).toMatch(/const pins = Array\.isArray\(data\.pins\) \? data\.pins : \[\];/);
    expect(appSrc).toMatch(/readers, pins \};/);
  });
});

describe('the list can change under you', () => {
  test('the active index is CLAMPED, not trusted', () => {
    /* Somebody else unpinning the one you were looking at is the ordinary case
       on a shared surface, and an index left pointing past the end would draw
       nothing while the bar still held its 32px. */
    expect(chatDetailSrc).toMatch(/activeIndex=\{Math\.min\(pinIndex, pinnedForBar\.length - 1\)\}/);
  });

  test('the index lives in the screen, not in the bar', () => {
    // A pin can be removed by somebody else while the bar is open and only the
    // shell sees that socket event; and this screen remounts on every trip out
    // to a venue and back, so state inside the bar would reset to the first pin.
    expect(chatDetailSrc).toMatch(/const \[pinIndex, setPinIndex\] = React\.useState\(0\);/);
    expect(chatDetailSrc).toMatch(/onActiveIndexChange=\{setPinIndex\}/);
  });

  test('the bar is not drawn at all when there is nothing pinned', () => {
    expect(chatDetailSrc).toMatch(/\{pinnedForBar\.length > 0 && \(/);
  });
});

describe('the preview and the jump', () => {
  test('the preview is built here, with the helper the stream uses', () => {
    // A pinned photo or venue card has no text, and messagePreview is what
    // turns that into "Photo" instead of a blank line.
    expect(chatDetailSrc).toMatch(/preview: messagePreview\(\{ text: p\.text, message_type: p\.messageType, hadContent: true \}\)/);
  });

  test('a pin pointing past the loaded page says so instead of doing nothing', () => {
    /* Three pins live for the whole night and the stream pages, so the row is
       often simply not mounted. A tap that does nothing, on a control whose
       only job is "take me there", reads as broken. */
    const jump = chatDetailSrc.slice(
      chatDetailSrc.indexOf('const jumpToMessage = (messageId) => {'),
      chatDetailSrc.indexOf('const nudgeKey =')
    );
    expect(jump).toMatch(/data-message-id="\$\{id\}"/);
    expect(jump).toMatch(/showToast\('That message is further back in the chat\.'\)/);
    // No smooth scroll: nothing in this rebuild slides.
    expect(jump).toMatch(/scrollIntoView\(\{ block: 'center' \}\)/);
    expect(jump).not.toMatch(/behavior: 'smooth'/);
  });
});

describe('the control', () => {
  test('one button, and its label says which way the tap goes', () => {
    expect(chatDetailSrc).toMatch(/aria-label=\{alreadyPinned \? 'Unpin message' : 'Pin message'\}/);
    expect(chatDetailSrc).toMatch(/if \(alreadyPinned\) unpinMessage\(flock\.id, actionsMessage\.id\);/);
    expect(chatDetailSrc).toMatch(/else pinMessage\(flock\.id, actionsMessage\.id\);/);
  });

  test('it is offered only on a message the server has actually stored', () => {
    // A temp id is Date.now(), which is above int4; there is nothing to pin.
    const branch = chatDetailSrc.slice(chatDetailSrc.indexOf('PIN, and only on a row the server'), chatDetailSrc.indexOf('View photo full size'));
    expect(branch).toMatch(/typeof actionsMessage\.id === 'number' && actionsMessage\.id <= 2147483647/);
  });
});

describe('the bar itself', () => {
  const pins = [
    { id: 1, preview: 'Venmo @maya' },
    { id: 2, preview: 'Door code 4417' },
  ];

  test('it draws the active pin', () => {
    render(React.createElement(PinnedMessageBar, {
      pins, activeIndex: 0, onActiveIndexChange: () => {}, onJump: () => {}, onUnpin: () => {},
    }));
    expect(screen.getByText(/Venmo @maya/)).toBeInTheDocument();
  });

  test('nothing pinned renders nothing', () => {
    const { container } = render(React.createElement(PinnedMessageBar, { pins: [] }));
    expect(container).toBeEmptyDOMElement();
  });

  test('the position is spoken, not only drawn as dots', () => {
    /* Three 5px dots four pixels apart cannot each carry a 44pt target without
       the targets overlapping, and a screen reader gains nothing from three
       unlabelled positions. The main button's own label carries "2 of 3". */
    render(React.createElement(PinnedMessageBar, {
      pins, activeIndex: 1, onActiveIndexChange: () => {}, onJump: () => {}, onUnpin: () => {},
    }));
    expect(screen.getByLabelText(/2 of 2/)).toBeInTheDocument();
  });
});
