/**
 * THE NUDGE, and the four gates that stop it being a banner.
 *
 * NudgeRow was built, tested and exported and nothing imported it. It replaces
 * the 40pt momentum meter pinned under the chat header, and the thing that
 * makes it a nudge rather than the banner it replaces is entirely in the
 * PARENT: when it fires, when it does not, and whether sending it away sticks.
 * The component draws a nudge somebody else has already decided to show.
 *
 * So this file is mostly about the gates. A prompt that fires on a healthy
 * plan, or comes back after being dismissed, is the banner again with extra
 * steps.
 */

const React = require('react');
const { render, screen, fireEvent } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const chatDetailSrc = read('screens', 'ChatDetail.js');
const NudgeRow = require('../components/chat/cards/NudgeRow').default;

/** The whole nudge condition, as written. */
const condition = (() => {
  const at = chatDetailSrc.indexOf('const nudgeForCard = (');
  expect(at).toBeGreaterThan(-1);
  return chatDetailSrc.slice(at, chatDetailSrc.indexOf('const sourceRowById', at));
})();

describe('the gates', () => {
  test('it fires only when the plan is stuck at step one', () => {
    // No venue suggested at all is the failure the whole product is about.
    expect(condition).toMatch(/pollVoteRows\.length === 0/);
  });

  test('it does not greet an empty thread', () => {
    // A flock nobody has spoken in is not stuck, it is new.
    expect(condition).toMatch(/\(flock\.messages \|\| \[\]\)\.length > 0/);
  });

  test('it does not interrupt somebody mid-sentence', () => {
    // What it is asking for may be about to happen anyway.
    expect(condition).toMatch(/&& !isTyping/);
  });

  test('it stops once the plan is settled, one way or the other', () => {
    for (const status of ['confirmed', 'completed', 'cancelled']) {
      expect(condition).toMatch(new RegExp(`flock\\.status !== '${status}'`));
    }
  });

  test('it does not come back once sent away', () => {
    expect(condition).toMatch(/&& !nudgeIsDismissed\(nudgeKey\)/);
  });
});

describe('dismissal', () => {
  test('it is remembered across reloads, not just for the session', () => {
    // State alone makes the dismissal immediate; storage is what stops the row
    // returning on the next load, which is the difference between a nudge and
    // the banner it replaces.
    expect(chatDetailSrc).toMatch(/localStorage\.setItem\(`flock_nudge_\$\{key\}`, '1'\)/);
    expect(chatDetailSrc).toMatch(/localStorage\.getItem\(`flock_nudge_\$\{key\}`\) === '1'/);
  });

  test('storage that throws reads as NOT dismissed', () => {
    /* localStorage can throw outright in a private window or with site data
       blocked. Failing toward "show it again" is the safe direction: a small
       annoyance, rather than the app silently swallowing a prompt it had no
       way to know was still wanted. */
    const reader = chatDetailSrc.slice(
      chatDetailSrc.indexOf('const nudgeIsDismissed = React.useCallback'),
      chatDetailSrc.indexOf('}, [nudgeDismissed]);')
    );
    expect(reader).toMatch(/catch \(err\) \{\s*\n\s*return false;/);
  });

  test('the key is scoped to the flock, so one dismissal is not all of them', () => {
    expect(chatDetailSrc).toMatch(/const nudgeKey = `\$\{flock\.id\}:no_venue`;/);
  });

  test('ACTING does not dismiss', () => {
    /* The nudge's condition is that nobody has picked a place. Voting clears
       it on its own, and opening the sheet without voting leaves it true.
       Dismissing on the way in would hide a prompt whose reason had not gone
       away, which is the same lie as a banner that cannot be closed. */
    const branch = chatDetailSrc.slice(
      chatDetailSrc.indexOf('if (m.id === NUDGE_ROW_ID)'),
      chatDetailSrc.indexOf('if (m.id === POLL_ROW_ID)')
    );
    expect(branch).toMatch(/onAction=\{\(\) => setShowVotePanel\(true\)\}/);
    expect(branch).toMatch(/onDismiss=\{\(\) => dismissNudge\(nudgeForCard\.key\)\}/);
    // The tell: onAction must not call dismissNudge.
    const onAction = branch.slice(branch.indexOf('onAction='), branch.indexOf('onDismiss='));
    expect(onAction).not.toMatch(/dismissNudge/);
  });
});

describe('where it sits', () => {
  test('it lands on the end, with no anchor', () => {
    // The other two synthetic rows describe a moment in the scrollback. This
    // one describes the state of the plan right now.
    expect(chatDetailSrc).toMatch(/spliceByTime\(streamRows, \{ id: NUDGE_ROW_ID, message_type: 'system' \}, NaN\)/);
  });

  test('it passes the server-authored gate like the other synthetic rows', () => {
    expect(chatDetailSrc).toMatch(/\{ id: NUDGE_ROW_ID, message_type: 'system' \}/);
    expect(chatDetailSrc).toMatch(/if \(m\.message_type === 'system' && m\.system_kind\) \{/);
  });

  test('it is dropped while a search is open, like the others', () => {
    const block = chatDetailSrc.slice(
      chatDetailSrc.indexOf('if (!searchActive) {'),
      chatDetailSrc.indexOf('// A venue card is the one message shape')
    );
    expect(block).toMatch(/NUDGE_ROW_ID/);
  });
});

describe('the row itself', () => {
  test('it draws the sentence and one action', () => {
    render(React.createElement(NudgeRow, {
      text: 'Nobody has picked a place yet.',
      actionLabel: 'Open the vote',
      onAction: () => {},
      onDismiss: () => {},
    }));
    expect(screen.getByText('Nobody has picked a place yet.')).toBeInTheDocument();
    expect(screen.getByText('Open the vote')).toBeInTheDocument();
  });

  test('the action fires', () => {
    const onAction = jest.fn();
    render(React.createElement(NudgeRow, {
      text: 'Nobody has picked a place yet.',
      actionLabel: 'Open the vote',
      onAction,
      onDismiss: () => {},
    }));
    fireEvent.click(screen.getByText('Open the vote'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test('no text, no nudge', () => {
    // A bird and a chip with nothing between them is a control that has not
    // said what it is for.
    const { container } = render(React.createElement(NudgeRow, {
      text: '   ', actionLabel: 'Open the vote', onAction: () => {}, onDismiss: () => {},
    }));
    expect(container).toBeEmptyDOMElement();
  });

  test('with no onDismiss it offers NEITHER way out, rather than one that lies', () => {
    /* The X used to draw unconditionally, so a parent passing no handler
       shipped a button that did nothing, and the swipe still entered the
       leaving state: an invisible strip in the middle of the stream still
       swallowing taps and holding two focusable controls. */
    const { container } = render(React.createElement(NudgeRow, {
      text: 'Nobody has picked a place yet.', actionLabel: 'Open the vote', onAction: () => {},
    }));
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.queryByLabelText(/dismiss/i)).not.toBeInTheDocument();
  });
});
