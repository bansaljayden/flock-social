// ---------------------------------------------------------------------------
// AN INVITE CARD WHILE ITS JOIN IS OUT.
//
// The check mark did nothing visible until the server answered, which on a
// bar's network is long enough for a second tap. App.js now holds the id of the
// join in flight (acceptingInviteId, see handleAcceptFlockInvite, whose own
// behaviour is run in nestCardTruth) and this screen draws it: the tapped card
// says "Joining…" where the tap landed, and no invite button on the list takes
// a tap until the join answers, because the join is about to open a chat.
//
// Rendered for real, from the screen's own parameter list, the same way
// endedPlanAsks renders the plan screen.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test inviteJoinPending --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, cleanup, within } = require('@testing-library/react');

const ChatListScreen = require('../screens/ChatListScreen').default;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatListScreen.js'), 'utf8').replace(/\r\n/g, '\n');

const PARAMS = (() => {
  const start = SRC.indexOf('export default function ChatListScreen({');
  const end = SRC.indexOf('}) {', start);
  return SRC.slice(start, end)
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .flatMap((l) => l.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
})();

const invite = (id, name) => ({
  id, name, host: 'Ava', hostId: 3, memberStatus: 'invited', memberCount: 3,
  time: 'Fri, 9:00 PM', venue: 'The Vault',
});

function listProps(over = {}) {
  const props = {};
  for (const name of PARAMS) props[name] = jest.fn();
  Object.assign(props, {
    EmptyMark: () => null,
    ListSkeleton: () => null,
    SearchInputLocal: () => null,
    BottomNav: () => null,
    SafetyButton: () => null,
    messagePreview: () => '',
    conversationStamp: () => '',
    flockTileInitial: (n) => (n || '?')[0],
    flockTileSwatch: () => '#000000',
    chatListSearchRef: { current: null },
    chatSearch: '',
    colors: {},
    acceptingInviteId: null,
    declinedFlockInvites: [],
    directMessages: [],
    dmsError: '',
    dmsLoading: false,
    editingFlockList: false,
    feedScroll: { chat: { ref: { current: null }, onScroll: () => {} } },
    flockOrder: [],
    flocks: [],
    flocksError: '',
    flocksLoading: false,
    getRelativeTime: () => '',
    highlightedInviteId: null,
    pendingFlockInvites: [invite(41, 'Budget night'), invite(42, 'Karaoke')],
    pinnedFlockIds: [],
    showChatSearch: false,
    styles: { card: {} },
  }, over);
  return props;
}

const cardOf = (name) => screen.getByText(name).closest('[style]').parentElement;

afterEach(cleanup);

test('the parameter list was read, and it takes the join in flight', () => {
  expect(PARAMS.length).toBeGreaterThan(30);
  expect(PARAMS).toContain('acceptingInviteId');
  expect(PARAMS).toContain('pendingFlockInvites');
});

test('with nothing in flight, both invites can be answered', () => {
  const p = listProps();
  render(React.createElement(ChatListScreen, p));
  const accepts = screen.getAllByRole('button', { name: 'Accept invite' });
  const declines = screen.getAllByRole('button', { name: 'Decline invite' });
  expect(accepts).toHaveLength(2);
  for (const b of [...accepts, ...declines]) expect(b).not.toBeDisabled();
  fireEvent.click(accepts[0]);
  expect(p.handleAcceptFlockInvite).toHaveBeenCalledWith(41);
  expect(screen.queryByText('Joining…')).toBeNull();
});

test('the tapped card says it is joining, in place of its details', () => {
  render(React.createElement(ChatListScreen, listProps({ acceptingInviteId: 41 })));
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Joining…');
  // On the card that was tapped, not the other one.
  expect(cardOf('Budget night')).toContainElement(status);
  expect(within(cardOf('Karaoke')).queryByText('Joining…')).toBeNull();
  expect(within(cardOf('Karaoke')).getByText(/Fri, 9:00 PM/)).toBeInTheDocument();
});

test('no invite button takes a tap while a join is out', () => {
  const p = listProps({ acceptingInviteId: 41 });
  render(React.createElement(ChatListScreen, p));
  const buttons = [
    ...screen.getAllByRole('button', { name: 'Accept invite' }),
    ...screen.getAllByRole('button', { name: 'Decline invite' }),
  ];
  expect(buttons).toHaveLength(4);
  for (const b of buttons) {
    expect(b).toBeDisabled();
    fireEvent.click(b);
  }
  expect(p.handleAcceptFlockInvite).not.toHaveBeenCalled();
  expect(p.handleDeclineFlockInvite).not.toHaveBeenCalled();
});

test('a declined plan being re-joined says so, and the others wait', () => {
  const declined = [
    { id: 51, name: 'Bowling', host: 'Ava', memberStatus: 'declined' },
    { id: 52, name: 'Brunch', host: 'Ava', memberStatus: 'declined' },
  ];
  const p = listProps({ pendingFlockInvites: [], declinedFlockInvites: declined, acceptingInviteId: 51 });
  render(React.createElement(ChatListScreen, p));
  const joining = screen.getByRole('button', { name: 'Joining Bowling' });
  expect(joining).toHaveTextContent('Joining…');
  expect(joining).toBeDisabled();
  const other = screen.getByRole('button', { name: 'Join Brunch' });
  expect(other).toBeDisabled();
  fireEvent.click(other);
  expect(p.handleRejoinDeclinedFlock).not.toHaveBeenCalled();
});

test('App.js hands the screen the join in flight', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  const i = APP.indexOf('const chatListScreenProps = {');
  const block = APP.slice(i, APP.indexOf('};', i));
  expect(block).toMatch(/\n\s+acceptingInviteId,\n/);
});
