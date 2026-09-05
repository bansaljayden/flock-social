/**
 * THE VENUE VOTE, AS A CARD IN THE STREAM.
 *
 * PollCard was built, tested and exported and nothing imported it. The vote
 * lived only in a bottom sheet, so the chat carried no trace of the decision
 * being made: scrolling back through a night showed what the group picked and
 * never when, or how close it was.
 *
 * The thing this file guards hardest is not the card. It is that the card and
 * the sheet run the SAME three actions. This screen already carries the scar
 * from the alternative, recorded on the flock send path: a venue card kept
 * "its own private copy of this whole function" and inherited none of its
 * fixes. Two surfaces casting a vote through two implementations is how they
 * come to print different tallies for the same night, in front of the group.
 */

const React = require('react');
const { render, screen } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const chatDetailSrc = read('screens', 'ChatDetail.js');
const PollCard = require('../components/chat/cards/PollCard').default;

describe('one implementation, two surfaces', () => {
  test('each vote action is declared exactly once', () => {
    /* The hoist is the whole point. If a second `const handleConfirmVenue`
       appears, somebody has given one surface its own copy and the two will
       drift, which is the failure this screen has already had once. */
    for (const fn of ['handleQuickVote', 'handleUnvote', 'handleConfirmVenue']) {
      const declarations = chatDetailSrc.match(new RegExp(`const ${fn} = `, 'g')) || [];
      expect([fn, declarations.length]).toEqual([fn, 1]);
    }
  });

  test('they are declared above renderCard, where both callers can reach them', () => {
    const hoisted = chatDetailSrc.indexOf('const flockVotesAll = flock.votes || [];');
    const renderCard = chatDetailSrc.indexOf('const renderCard = (m) => {');
    const sheet = chatDetailSrc.indexOf('{showVotePanel && (() => {');
    expect(hoisted).toBeGreaterThan(-1);
    expect(hoisted).toBeLessThan(renderCard);
    expect(renderCard).toBeLessThan(sheet);
  });

  test('the card locks the plan through the sheet\'s confirm, not its own write', () => {
    // handleConfirmVenue writes the venue and the status in ONE put, so
    // members get one push and a plan cannot end up confirmed at a venue the
    // server refused. A card calling updateFlockVenue directly would lose that.
    expect(chatDetailSrc).toMatch(/onLock=\{\(o\) => handleConfirmVenue\(/);
    const pollBranch = chatDetailSrc.slice(
      chatDetailSrc.indexOf('if (m.id === POLL_ROW_ID)'),
      chatDetailSrc.indexOf('if (m.id === BILL_ROW_ID)')
    );
    expect(pollBranch).not.toMatch(/updateFlockVenue\(/);
    expect(pollBranch).not.toMatch(/setFlockStatus\(/);
  });

  test('the sheet reads the hoisted vote list rather than its own', () => {
    expect(chatDetailSrc).toMatch(/const flockVotes = flockVotesAll;/);
  });
});

describe('the card reaches the stream', () => {
  test('a synthetic poll row is spliced in, and only when there is a vote', () => {
    expect(chatDetailSrc).toMatch(/const POLL_ROW_ID = 'poll-card';/);
    expect(chatDetailSrc).toMatch(/const pollForCard = pollVoteRows\.length > 0;/);
    expect(chatDetailSrc).toMatch(/if \(pollForCard\) \{/);
  });

  test('both synthetic rows are placed by ONE shared rule', () => {
    // The bill had this logic inline; a second private copy is how the two
    // would come to disagree about where a card belongs in the scrollback.
    const helpers = chatDetailSrc.match(/const spliceByTime = /g) || [];
    expect(helpers).toHaveLength(1);
    expect(chatDetailSrc).toMatch(/spliceByTime\(streamRows, \{ id: POLL_ROW_ID/);
    expect(chatDetailSrc).toMatch(/spliceByTime\(streamRows, \{ id: BILL_ROW_ID/);
  });

  test('neither synthetic row is drawn while a search is open', () => {
    // A search shows what matches. A card that ignored the query would be the
    // one thing on screen that is not a result.
    expect(chatDetailSrc).toMatch(/if \(!searchActive\) \{/);
  });

  test('the synthetic rows pass the server-authored gate', () => {
    /* THE GENERALISED FORM OF THE BILL CARD REGRESSION (3561d30). Both
       synthetic rows carry message_type 'system' so groupRows treats them as
       ownerless, and neither carries a system_kind because no server wrote
       them. The system branch must therefore gate on the KIND, or it swallows
       every local card in the stream and returns null for it. It swallowed the
       bill card exactly that way. */
    expect(chatDetailSrc).toMatch(/if \(m\.message_type === 'system' && m\.system_kind\) \{/);
    for (const id of ['POLL_ROW_ID', 'BILL_ROW_ID']) {
      expect(chatDetailSrc).toMatch(new RegExp(`\\{ id: ${id}, message_type: 'system' \\}`));
    }
  });
});

describe('the numbers', () => {
  test('the footer count is voters plus guests, not a vote total', () => {
    /* A guest voting from an invite link adds to a row's count without adding
       a name, so the row counts and the footer count are independent figures
       and PollCard is documented not to derive one from the other. This is the
       same arithmetic the sheet does. */
    const branch = chatDetailSrc.slice(
      chatDetailSrc.indexOf('if (m.id === POLL_ROW_ID)'),
      chatDetailSrc.indexOf('if (m.id === BILL_ROW_ID)')
    );
    expect(branch).toMatch(/new Set\(pollVoteRows\.flatMap\(\(v\) => v\.voters \|\| \[\]\)\)/);
    expect(branch).toMatch(/reduce\(\(sum, v\) => sum \+ \(v\.guestCount \|\| 0\), 0\)/);
    expect(branch).toMatch(/votedCount=\{voterNames\.size \+ guestVotes\}/);
  });

  test('a rating is passed only when the row really carries one', () => {
    const branch = chatDetailSrc.slice(
      chatDetailSrc.indexOf('if (m.id === POLL_ROW_ID)'),
      chatDetailSrc.indexOf('if (m.id === BILL_ROW_ID)')
    );
    // The card draws a star for a numeric rating and nothing otherwise, so a
    // guess here would put a figure on screen the server never sent.
    expect(branch).toMatch(/typeof v\.rating === 'number'/);
  });
});

describe('the card itself, rendered', () => {
  const options = [
    { id: 'p1', name: 'Kome', voteCount: 3, voted: true },
    { id: 'p2', name: 'The Bayou', voteCount: 1, voted: false },
  ];

  test('it shows the options and the footer tally', () => {
    render(React.createElement(PollCard, {
      title: 'Where are we going?', options, votedCount: 4, memberCount: 6,
    }));
    expect(screen.getByText('Kome')).toBeInTheDocument();
    expect(screen.getByText('The Bayou')).toBeInTheDocument();
    expect(screen.getByText('4 of 6 voted')).toBeInTheDocument();
  });

  test('a tally the parent has not loaded prints nothing, never "0 of 0"', () => {
    render(React.createElement(PollCard, { title: 'Where are we going?', options }));
    expect(screen.queryByText(/of .* voted/)).not.toBeInTheDocument();
  });

  test('a locked plan keeps the counts as the record', () => {
    render(React.createElement(PollCard, {
      title: 'Where are we going?', options, votedCount: 4, memberCount: 6, lockedName: 'Kome',
    }));
    // The venue is named as locked and the rows are still there to read.
    expect(screen.getByText('The Bayou')).toBeInTheDocument();
  });
});
