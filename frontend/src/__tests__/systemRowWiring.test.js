/**
 * SYSTEM ROWS, the client half (migration 067).
 *
 * components/chat/cards/SystemRow.js has been built, tested and exported since
 * the chat module was written, and its own header says the events it draws
 * "are not in the stream at all". groupRows.js already collapses consecutive
 * system rows into one ownerless run and MessageGroup already routes them
 * through renderCard. Every piece was in place except two: a row could not be
 * stored, because the CHECK on messages.message_type has allowed exactly three
 * values since the bootstrap schema, and no screen had a branch to draw one.
 *
 * This pins the branch, and the one decision in it that is easy to get wrong
 * in a way nothing catches: what an UNKNOWN kind does.
 */

const React = require('react');
const { render, screen } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const appSrc = read('App.js');
const chatDetailSrc = read('screens', 'ChatDetail.js');
const groupRowsSrc = read('components', 'chat', 'groupRows.js');

const SystemRow = require('../components/chat/cards/SystemRow').default;

describe('the row reaches the screen', () => {
  test('mapFlockRow carries system_kind', () => {
    // Without it every system row arrives as an unrecognised kind and draws
    // nothing, which looks exactly like the feature not being wired at all.
    expect(appSrc).toMatch(/system_kind: m\.system_kind \|\| null,/);
  });

  test('ChatDetail has a branch for system rows, and it comes before the card branches', () => {
    const at = chatDetailSrc.indexOf("if (m.message_type === 'system')");
    const bill = chatDetailSrc.indexOf('if (m.id === BILL_ROW_ID)');
    expect(at).toBeGreaterThan(-1);
    expect(bill).toBeGreaterThan(-1);
    expect(at).toBeLessThan(bill);
  });

  test('an unknown kind draws NOTHING rather than a broken row', () => {
    /* This is the reason messages.system_kind carries no CHECK constraint. A
       server rolled forward before its clients is the normal order of a
       deploy, so an older build WILL meet a kind it has not heard of. Falling
       through to null costs that reader one missing line; anything else puts a
       half-rendered row, or a crash, in the middle of a thread. */
    const branch = chatDetailSrc.slice(
      chatDetailSrc.indexOf("if (m.message_type === 'system')"),
      chatDetailSrc.indexOf('if (m.id === BILL_ROW_ID)')
    );
    expect(branch).toMatch(/return null;/);
    // And the fall-through must be inside the system branch, not after it, or
    // an unknown system row would drop through to the venue-card branch.
    expect(branch.indexOf('return null;')).toBeGreaterThan(branch.indexOf("m.system_kind === 'venue_set'"));
  });

  test('the module note points at the migration that actually shipped', () => {
    // groupRows said "migration 066, W4"; 066 became the flock reply and system
    // rows landed in 067. A stale number sends the next reader to the wrong file.
    expect(groupRowsSrc).toMatch(/migration 067/);
    expect(groupRowsSrc).not.toMatch(/migration 066, W4/);
  });
});

describe('SystemRow draws the sentence the screen assembles', () => {
  test('venue_set reads as a sentence with the venue accented', () => {
    render(
      React.createElement(SystemRow, {
        kind: 'venue_set',
        parts: [{ text: 'Maya set the venue: ' }, { text: 'Kome', accent: true }],
      })
    );
    // The row is one line of text to a reader, however many pieces built it.
    expect(screen.getByText(/Maya set the venue:/)).toBeInTheDocument();
    expect(screen.getByText('Kome')).toBeInTheDocument();
  });

  test('the accented piece is the value that changed, and it is marked as such', () => {
    // jsdom drops a var() colour off an inline style, so data-accent is the
    // only thing that can prove the venue and not the prefix is the accented
    // piece. SystemRow exposes it for exactly this reason.
    const { container } = render(
      React.createElement(SystemRow, {
        kind: 'venue_set',
        parts: [{ text: 'Maya set the venue: ' }, { text: 'Kome', accent: true }],
      })
    );
    const accented = container.querySelectorAll('[data-accent="true"]');
    expect(accented).toHaveLength(1);
    expect(accented[0].textContent).toBe('Kome');
  });

  test('a row with nothing in it renders nothing at all', () => {
    /* An empty grey line is worse than no line: the reader has to work out
       what it was meant to say.

       EMPTY, NOT BLANK. pieceText keeps any string of length > 0, so a piece
       of pure whitespace WOULD draw an invisible row that still takes vertical
       space. That case is closed on the server instead: writeSystemMessage
       trims the value and refuses to insert, so a whitespace-only row never
       exists to be rendered. Asserting the trim here would be asserting a
       behaviour this component does not have and does not need. */
    const { container } = render(
      React.createElement(SystemRow, { kind: 'venue_set', parts: [{ text: '' }] })
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the sentence is assembled on the client, never sent as prose', () => {
  test('the wording lives in ChatDetail, not in anything from the server', () => {
    /* SystemRow's documented contract is that it receives pieces and decides
       itself which piece is accented. A server sending "Maya set the venue:
       Kome" as a finished string would be choosing the wording, the casing and
       the accent for a component built not to receive them, and would make the
       copy un-editable without a data migration. */
    expect(chatDetailSrc).toMatch(/set the venue: /);
    expect(chatDetailSrc).toMatch(/\{ text: m\.text, accent: true \}/);
  });

  test('the actor reads as "You" on your own action', () => {
    // mapFlockRow already resolves the sender to 'You' for the viewer's own
    // rows, so the branch reuses that rather than re-deriving it from ids.
    expect(chatDetailSrc).toMatch(/m\.sender === 'You' \? 'You' : m\.sender/);
  });
});
