/**
 * A NEW DM THREAD WITH NOTHING STORED IN IT YET SURVIVES A LIST REFRESH.
 *
 * Priya taps Message on a friend in Add Friends. startNewDmWithUser adds a row
 * only this device knows about and opens it. She switches to Photos to find a
 * picture and comes back. On iOS the socket is released while the app is
 * hidden, so the return is a reconnect, and the reconnect re-reads the
 * conversation list. GET /api/dm lists a pair only once it has a stored
 * message, and the loader rebuilt the list from that answer alone, so the new
 * thread was dropped: the open screen turned into "This conversation is not
 * here", and a first message or photo that had failed to send, which lives in
 * that row and nowhere else, was gone with it.
 *
 * The row startNewDmWithUser makes is marked, and the loader keeps a marked row
 * its answer leaves out while it is the thread last opened or holds a message,
 * unless it was deleted here or its person was blocked after it was started.
 * loadDmConversations and startNewDmWithUser are lifted out of App.js by
 * source and run, the way chatEchoOrderAndRetraction.test.js runs the loader.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern dmNewThreadSurvivesRefresh
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

/* Source from a start index to the `;` that ends it at depth zero, skipping
   strings and comments. */
function toStatementEnd(start) {
  let i = APP.indexOf('=', start) + 1;
  let depth = 0;
  while (i < APP.length) {
    const ch = APP[i];
    const next = APP[i + 1];
    if (ch === '/' && next === '/') { i = APP.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = APP.indexOf('*/', i + 2); i = end === -1 ? APP.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < APP.length) {
        if (APP[i] === '\\') { i += 2; continue; }
        if (APP[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return APP.slice(start, i + 1);
    i += 1;
  }
  throw new Error('unterminated declaration');
}
const declaration = (name) => {
  const start = APP.search(new RegExp(`^const ${name} = `, 'm'));
  if (start === -1) throw new Error(`no module-scope \`const ${name} =\` in App.js`);
  return toStatementEnd(start);
};
const callback = (name) => {
  const start = APP.indexOf(`  const ${name} = useCallback(`);
  if (start === -1) throw new Error(`no \`${name} = useCallback(\` in App.js`);
  return toStatementEnd(start);
};
function run(src, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), src)(...Object.values(scope));
}

const H = (() => {
  const names = ['retractedSince', 'noteRetraction'];
  // eslint-disable-next-line no-new-func
  return new Function(`${names.map(declaration).join('\n')}\nreturn { ${names.join(', ')} };`)();
})();

const AT = '2026-09-26T20:00:00Z';
// A conversation as GET /api/dm lists it.
const conv = (userId, name, over = {}) => ({
  userId, name, image: null, lastMessage: 'hi', lastMessageTime: AT, lastMessageIsYou: false, unread: 0, ...over,
});

/**
 * The DM list as FlockAppInner holds it, with the two callbacks that write it.
 * Every list read waits for the test to answer it: reads[n].
 */
function dmList({ threads = [], deleted = [] } = {}) {
  const state = { threads, deleted, selected: null, screen: 'main' };
  const reads = [];
  const noop = () => {};
  const retractionsRef = { current: { seq: 0, log: [] } };
  const set = (key) => (next) => { state[key] = typeof next === 'function' ? next(state[key]) : next; };
  const load = run(`${callback('loadDmConversations')}\nreturn loadDmConversations;`, {
    useCallback: (fn) => fn,
    dmListReadSeqRef: { current: 0 },
    setDmsLoading: noop,
    setDmsError: noop,
    getDMConversations: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
    deletedDmUserIdsRef: { get current() { return state.deleted; } },
    setDeletedDmUserIds: set('deleted'),
    setDirectMessages: set('threads'),
    retractionsRef,
    retractedSince: H.retractedSince,
    // The thread last opened, as the render before the answer left it.
    selectedDmIdRef: { get current() { return state.selected; } },
  });
  const start = (user) => run(`${callback('startNewDmWithUser')}\nreturn startNewDmWithUser;`, {
    useCallback: (fn) => fn,
    retractionsRef,
    directMessages: state.threads,
    deletedDmUserIds: state.deleted,
    sendFriendRequest: () => Promise.resolve(),
    showToast: noop,
    setDeletedDmUserIds: set('deleted'),
    setDirectMessages: set('threads'),
    setSelectedDmId: set('selected'),
    setShowNewDmModal: noop,
    setDmSearchText: noop,
    setDmModalResults: noop,
    setCurrentScreen: set('screen'),
  })(user);
  const block = (userId) => H.noteRetraction(retractionsRef, { senderId: String(userId) });
  return { state, reads, load, start, block };
}

const listed = (list) => list.state.threads.map((d) => d.userId);
const RIA = { id: 8, name: 'Ria', profile_image_url: 'https://img.test/ria.jpg' };

afterAll(() => localStorage.clear());

describe('a thread started on this device and not stored yet', () => {
  test('is still there, and still open, after the reconnect re-reads the list', async () => {
    const list = dmList({ threads: [{ ...conv(5, 'Bo'), messages: [] }] });
    list.start(RIA);
    expect(list.state.selected).toBe(8);
    expect(list.state.screen).toBe('dmDetail');
    const started = list.state.threads.find((d) => d.userId === 8);

    // Back from Photos: the socket reconnects and the list is read again. The
    // server has nothing stored between these two, so it does not list them.
    const read = list.load();
    list.reads[0].resolve({ conversations: [conv(5, 'Bo')] });
    await read;

    expect(listed(list)).toEqual([8, 5]);
    // The very row, name and photo included: not rebuilt as "Unknown" by a
    // history read with no message from Ria to take them from.
    expect(list.state.threads[0]).toBe(started);
    expect(list.state.threads[0].name).toBe('Ria');
  });

  test('keeps a first message that failed to send, the only copy there is of it', async () => {
    const failed = { id: 1758920000123, text: 'here is the pic', sender: 'You', failed: true };
    const list = dmList({ threads: [{ userId: 8, name: 'Ria', image: null, messages: [failed], lastMessage: null, unread: 0, localOnly: true }] });
    const read = list.load();
    list.reads[0].resolve({ conversations: [] });
    await read;
    expect(list.state.threads[0].messages).toEqual([failed]);
  });

  test('is taken from the server the first time the server lists it, and treated as any other thread after', async () => {
    const list = dmList();
    list.start(RIA);
    const first = list.load();
    list.reads[0].resolve({ conversations: [conv(8, 'Ria', { lastMessage: 'here is the pic', lastMessageIsYou: true })] });
    await first;
    expect(listed(list)).toEqual([8]);
    expect(list.state.threads[0].localOnly).toBeUndefined();
    expect(list.state.threads[0].lastMessage).toBe('here is the pic');

    // Listed once, it is the server's to drop: an account deleted since is
    // not held on to.
    const second = list.load();
    list.reads[1].resolve({ conversations: [] });
    await second;
    expect(listed(list)).toEqual([]);
  });

  test('is not kept once it has been deleted here', async () => {
    const list = dmList();
    list.start(RIA);
    list.state.deleted = [8];
    const read = list.load();
    list.reads[0].resolve({ conversations: [] });
    await read;
    expect(listed(list)).toEqual([]);
  });

  test('is not kept once its person has been blocked, in either direction', async () => {
    const list = dmList();
    list.start(RIA);
    list.block(8);
    const read = list.load();
    list.reads[0].resolve({ conversations: [] });
    await read;
    expect(listed(list)).toEqual([]);
  });

  test('started after an unblock in the same session, it is kept, and a block after it still ends it', async () => {
    const list = dmList();
    // Blocked earlier in the session, unblocked from Settings (an unblock
    // logs nothing), and messaged again.
    list.block(8);
    list.start(RIA);
    const first = list.load();
    list.reads[0].resolve({ conversations: [] });
    await first;
    expect(listed(list)).toEqual([8]);

    list.block(8);
    const second = list.load();
    list.reads[1].resolve({ conversations: [] });
    await second;
    expect(listed(list)).toEqual([]);
  });

  test('left empty for another conversation, it goes on the next refresh, as it always did', async () => {
    // Message tapped on Ria, then on Bo, and nothing written to Ria. Kept, an
    // empty Ria thread sat in the Messages list until the app restarted.
    const list = dmList({ threads: [{ ...conv(5, 'Bo'), messages: [] }] });
    list.start(RIA);
    list.state.selected = 5;
    list.state.screen = 'dmDetail';
    const read = list.load();
    list.reads[0].resolve({ conversations: [conv(5, 'Bo')] });
    await read;
    expect(listed(list)).toEqual([5]);
  });

  test('empty, and a venue page away from its screen, it is still there to come back to', async () => {
    const list = dmList();
    list.start(RIA);
    // A venue card opened from the thread: another screen, the same thread.
    list.state.screen = 'venueDetail';
    const read = list.load();
    list.reads[0].resolve({ conversations: [] });
    await read;
    expect(listed(list)).toEqual([8]);
  });

  test('left for another conversation, it is kept while it holds a message that has not gone', async () => {
    const sending = { id: 'c-1', text: 'hey, it is Priya', sender: 'You', pending: true };
    const list = dmList({ threads: [{ userId: 8, name: 'Ria', image: null, messages: [sending], lastMessage: null, unread: 0, localOnly: true, startedAt: 0 }] });
    list.state.selected = 5;
    const read = list.load();
    list.reads[0].resolve({ conversations: [] });
    await read;
    expect(listed(list)).toEqual([8]);
    expect(list.state.threads[0].messages).toEqual([sending]);
  });
});

describe('the rest of the list is the server answer, as before', () => {
  test('a thread the server listed before and does not list now goes', async () => {
    const list = dmList({ threads: [{ ...conv(9, 'Cy'), messages: [{ id: 40, text: 'see you' }] }, { ...conv(5, 'Bo'), messages: [] }] });
    const read = list.load();
    list.reads[0].resolve({ conversations: [conv(5, 'Bo')] });
    await read;
    expect(listed(list)).toEqual([5]);
  });
});
