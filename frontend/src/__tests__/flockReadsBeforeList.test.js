/**
 * A PLAN OPENED FROM A NOTIFICATION ON A COLD START KEEPS WHAT ITS READS SAID.
 *
 * The app is closed and Sam taps "Jo: we're at the bar" from the Friday plan.
 * The push router opens the chat at once, while GET /api/flocks is still in
 * flight, so `flocks` is empty. The chat's own three reads (history, roster,
 * tally) go out beside the list read, and each writes into the plan's row
 * with a map over the rows held. A map over an empty list does nothing, so any
 * of them that answered before the list was thrown away; the row then arrived
 * from the list with no messages, members or votes, and nothing read again.
 * The chat said "Nothing here yet" over a live conversation, the nudge said
 * nobody had picked a place, and the plan screen said "Loading members..."
 * for good.
 *
 * Each read that finds no row now says so (noteRowlessRead), and the ones that
 * did are run again as soon as the list brings the row (rereadRowlessFlock,
 * from a layout effect on the list), for the plan still on screen only: the
 * history skeleton and the plan screen's retry count belong to the screen, so
 * a plan left before its row landed is read by whatever opens it next.
 * App.js cannot be imported, so the screen
 * entry effect, the plan screen's effect, the three real loaders and the new
 * pieces are lifted out by source and run against one state, the way
 * chatEchoOrderAndRetraction.test.js runs the loaders.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern flockReadsBeforeList
 */

const fs = require('fs');
const path = require('path');
const { liftReaders } = require('../services/flockReaders');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

/* Brace-matched source from a start index to the `;` that ends it, or to the
   close of the first block, skipping strings and comments. */
function scan(source, start, { untilBlockEnd = false } = {}) {
  let i = untilBlockEnd ? source.indexOf('{', start) : source.indexOf('=', start) + 1;
  const open = i;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (untilBlockEnd && depth === 0) return source.slice(open, i + 1);
    } else if (!untilBlockEnd && ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error('scan: unterminated source');
}

/** A module-scope `const <name> = ...;` out of App.js. */
function declaration(name) {
  const start = APP.search(new RegExp(`^const ${name} = `, 'm'));
  if (start === -1) throw new Error(`no module-scope \`const ${name} =\` in App.js`);
  return scan(APP, start);
}

/** A `const <name> = useCallback(...);` declared inside the component. */
function callback(name) {
  const start = APP.indexOf(`  const ${name} = useCallback(`);
  if (start === -1) throw new Error(`no \`${name} = useCallback(\` in App.js`);
  return scan(APP, start);
}

/** The body of the effect whose source starts with `opener`. */
function effectBody(opener) {
  const start = APP.indexOf(opener);
  if (start === -1) throw new Error(`effect moved: ${opener}`);
  return scan(APP, start, { untilBlockEnd: true });
}

const HELPERS = [
  'SERVER_ID_MAX', 'isServerId', 'sameSend', 'newClientId', 'echoMatches', 'newestServerId',
  'sendLandedAs', 'landedSends', 'orderByServerId', 'retractedSince', 'retractedIdsIn',
  'saidByAny', 'withoutBlockedQuote', 'dropRetracted', 'dropRetractedPins', 'noteRetraction',
  'DM_PAGE_SIZE', 'heldServerIds', 'pageAgainstHeld', 'heldBeforeDrop', 'mergeHistory',
  'sameContentId', 'applyTakedownToFlocks', 'mapFlockRow', 'mapDmRow', 'messagePreview',
  'FAILED_MSG_KEY', 'readFailedStore', 'writeFailedStore', 'readFailedFlockMessages',
  'writeFailedFlockMessages', 'persistFailedFlockMessage', 'removeFailedFlockMessage',
  'normalizeVotes', 'guestRsvpId',
];
const H = (() => {
  const chunk = HELPERS.map(declaration).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${chunk}\nreturn { ${HELPERS.join(', ')} };`)();
})();

function run(src, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), src)(...Object.values(scope));
}

const ME = { id: 3, name: 'Sam' };
const AT = '2026-09-26T21:00:00Z';
const PLAN = 7;

/* The row loadFlocks builds for a plan: no messages, members or votes, which
   the chat reads on entry. */
const listRow = () => ({ id: PLAN, name: 'Friday', messages: [], members: [], votes: [], pins: [] });

/**
 * One FlockAppInner, as far as these reads go: `flocks` and a setter that
 * behaves like useState's, the refs the loaders close over, and every request
 * held open until the test answers it (requests.<kind>[n]).
 */
function app({ flocks = [], screen = 'chatDetail' } = {}) {
  // `screen` and `selected` are what is on screen now; a test moves them to
  // walk away before the list lands. `spinner` is every write of the chat's
  // history skeleton flag, which is the chat screen's, whatever plan it shows.
  const state = { flocks, rosterAttempt: 0, rosterError: false, screen, selected: PLAN, spinner: [] };
  const requests = { messages: [], roster: [], votes: [] };
  const hold = (kind) => () => new Promise((resolve, reject) => { requests[kind].push({ resolve, reject }); });
  const setFlocks = (next) => { state.flocks = typeof next === 'function' ? next(state.flocks) : next; };
  const flocksRef = { get current() { return state.flocks; } };
  const votesLoadedRef = { current: new Set() };
  const rowlessReadsRef = { current: new Map() };
  const meRef = { current: ME };
  const noop = () => {};

  const loadFlockMessages = run(`${callback('loadFlockMessages')}\nreturn loadFlockMessages;`, {
    useCallback: (fn) => fn,
    historyReadAtRef: { current: {} },
    historyReadSeqRef: { current: {} },
    retractionsRef: { current: { seq: 0, log: [] } },
    setMessagesLoading: (v) => state.spinner.push(v),
    setMessagesError: noop,
    getMessages: hold('messages'),
    mapFlockRow: H.mapFlockRow,
    meRef,
    retractedSince: H.retractedSince,
    readFailedFlockMessages: H.readFailedFlockMessages,
    flocksRef,
    heldServerIds: H.heldServerIds,
    pageAgainstHeld: H.pageAgainstHeld,
    isServerId: H.isServerId,
    landedSends: H.landedSends,
    writeFailedFlockMessages: H.writeFailedFlockMessages,
    setFlockAtTop: noop,
    retractedIdsIn: H.retractedIdsIn,
    dropRetractedPins: H.dropRetractedPins,
    setFlocks,
    mergeHistory: H.mergeHistory,
    liftReaders,
    sendFlockAck: noop,
  });
  const refreshFlockRoster = run(`${callback('refreshFlockRoster')}\nreturn refreshFlockRoster;`, {
    useCallback: (fn) => fn,
    getFlock: hold('roster'),
    blockedIdsRef: { current: new Set() },
    guestRsvpId: H.guestRsvpId,
    setFlocks,
  });
  const loadFlockVotes = run(`${callback('loadFlockVotes')}\nreturn loadFlockVotes;`, {
    useCallback: (fn) => fn,
    setVotesLoadingFor: noop,
    getFlockVotes: hold('votes'),
    votesLoadedRef,
    setVotesError: noop,
    setFlocks,
    normalizeVotes: H.normalizeVotes,
    meRef,
  });
  const noteRowlessRead = run(`${callback('noteRowlessRead')}\nreturn noteRowlessRead;`, {
    useCallback: (fn) => fn,
    flocksRef,
    rowlessReadsRef,
    votesLoadedRef,
  });
  const setRosterAttempt = (next) => { state.rosterAttempt = typeof next === 'function' ? next(state.rosterAttempt) : next; };
  // Built for the render the list lands in, as React hands out a new one
  // whenever the screen or the plan on it changes.
  const rereadRowlessFlock = () => run(`${callback('rereadRowlessFlock')}\nreturn rereadRowlessFlock;`, {
    useCallback: (fn) => fn,
    rowlessReadsRef,
    refreshFlockRoster,
    loadFlockVotes,
    loadFlockMessages,
    setRosterAttempt,
    selectedFlockId: state.selected,
    currentScreen: state.screen,
  });

  const chatEntry = effectBody("  useEffect(() => {\n    if (currentScreen === 'chatDetail' && selectedFlockId) {");
  const planEntry = effectBody("  useEffect(() => {\n    if (currentScreen === 'detail' && selectedFlockId) {");
  const rowArrival = effectBody('  React.useLayoutEffect(() => {\n    if (rowlessReadsRef.current.size === 0) return;');

  return {
    state,
    requests,
    votesLoadedRef,
    rowlessReadsRef,
    /** The screen entry effect, as React runs it when the screen opens. */
    open() {
      if (screen === 'chatDetail') {
        run(chatEntry, {
          currentScreen: 'chatDetail',
          selectedFlockId: PLAN,
          prevFlockIdRef: { current: null },
          sharingLocationRef: { current: null },
          leaveFlock: noop,
          joinFlock: noop,
          refreshFlockRoster,
          loadFlockVotes,
          newlyCreatedFlockRef: { current: null },
          loadFlockMessages,
          loadMoneyState: noop,
          noteRowlessRead,
          moneyStateSeqRef: { current: 0 },
          setBudgetStatus: noop,
          setBillSplit: noop,
          setShowChatPool: noop,
          setShowCreateBill: noop,
        });
      } else {
        run(planEntry, {
          currentScreen: 'detail',
          selectedFlockId: PLAN,
          setRosterError: (v) => { state.rosterError = v; },
          getFlock: hold('roster'),
          blockedIdsRef: { current: new Set() },
          guestRsvpId: H.guestRsvpId,
          setFlocks,
          noteRowlessRead,
          loadFlockVotes,
        });
      }
    },
    /** GET /api/flocks answering, and the layout effect that runs on it. */
    listLands() {
      setFlocks((prev) => (prev.some((f) => f.id === PLAN) ? prev : [...prev, listRow()]));
      run(rowArrival, { rowlessReadsRef, flocks: state.flocks, rereadRowlessFlock: rereadRowlessFlock() });
    },
    row: () => state.flocks.find((f) => f.id === PLAN),
  };
}

/** Let every settled promise run its handlers. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// What the server has for Friday.
const HISTORY = { messages: [{ id: 41, flock_id: PLAN, sender_id: 5, sender_name: 'Jo', message_text: "we're at the bar", message_type: 'text', created_at: AT }], readers: [], pins: [] };
const ROSTER = { members: [{ id: 5, name: 'Jo', status: 'accepted' }, { id: 3, name: 'Sam', status: 'accepted' }], guests: [], flock: { member_count: 2, event_time: AT }, momentum: { accepted: 2 } };
const TALLY = { votes: [{ venue_name: 'The Owl', venue_id: 'p1', voters: [{ id: 5, name: 'Jo' }], guest_count: 0 }] };

function answerAll(requests, n) {
  requests.messages[n].resolve(HISTORY);
  requests.roster[n].resolve(ROSTER);
  requests.votes[n].resolve(TALLY);
}

afterAll(() => localStorage.clear());

describe('the chat opened before the list has the plan', () => {
  test('its history, roster and tally arrive once the row does', async () => {
    const a = app();
    a.open();
    // The plan's reads answer first. Nothing to write into yet.
    answerAll(a.requests, 0);
    await settle();
    expect(a.state.flocks).toEqual([]);
    expect([...a.rowlessReadsRef.current.get(PLAN)].sort()).toEqual(['messages', 'roster', 'votes']);
    // The tally had nowhere to land, so it does not count as read: the chat's
    // "Nobody has picked a place yet" waits.
    expect(a.votesLoadedRef.current.has(PLAN)).toBe(false);

    // Then the list, with the row as loadFlocks builds it: empty.
    a.listLands();
    expect(a.requests.messages).toHaveLength(2);
    expect(a.requests.roster).toHaveLength(2);
    expect(a.requests.votes).toHaveLength(2);
    answerAll(a.requests, 1);
    await settle();

    const row = a.row();
    expect(row.messages.map((m) => m.text)).toEqual(["we're at the bar"]);
    expect(row.members.map((m) => m.name)).toEqual(['Jo', 'Sam']);
    expect(row.votes.map((v) => v.venue)).toEqual(['The Owl']);
    expect(a.votesLoadedRef.current.has(PLAN)).toBe(true);
    expect(a.rowlessReadsRef.current.size).toBe(0);
  });

  test('only the reads that lost their answer go out again', async () => {
    const a = app();
    a.open();
    // History answers first; the list lands; the other two answer after it.
    a.requests.messages[0].resolve(HISTORY);
    await settle();
    a.listLands();
    a.requests.roster[0].resolve(ROSTER);
    a.requests.votes[0].resolve(TALLY);
    await settle();
    expect(a.requests.messages).toHaveLength(2);
    expect(a.requests.roster).toHaveLength(1);
    expect(a.requests.votes).toHaveLength(1);
    a.requests.messages[1].resolve(HISTORY);
    await settle();
    expect(a.row().messages.map((m) => m.text)).toEqual(["we're at the bar"]);
    expect(a.row().members).toHaveLength(2);
    expect(a.votesLoadedRef.current.has(PLAN)).toBe(true);
  });

  test('a plan the list already has reads once, as it always did', async () => {
    const a = app({ flocks: [listRow()] });
    a.open();
    answerAll(a.requests, 0);
    await settle();
    expect(a.rowlessReadsRef.current.size).toBe(0);
    a.listLands();
    expect(a.requests.messages).toHaveLength(1);
    expect(a.requests.roster).toHaveLength(1);
    expect(a.requests.votes).toHaveLength(1);
    expect(a.row().messages).toHaveLength(1);
  });
});

describe('the plan screen opened before the list has the plan', () => {
  test('its roster read runs again through the retry count once the row arrives', async () => {
    const a = app({ screen: 'detail' });
    a.open();
    a.requests.roster[0].resolve(ROSTER);
    a.requests.votes[0].resolve(TALLY);
    await settle();
    expect([...a.rowlessReadsRef.current.get(PLAN)].sort()).toEqual(['plan', 'votes']);

    a.listLands();
    // The plan screen's effect lists rosterAttempt, so this is it running again.
    expect(a.state.rosterAttempt).toBe(1);
    a.open();
    a.requests.roster[1].resolve(ROSTER);
    a.requests.votes.forEach((r) => r.resolve(TALLY));
    await settle();
    expect(a.row().members.map((m) => m.name)).toEqual(['Jo', 'Sam']);
    expect(a.row().votes.map((v) => v.venue)).toEqual(['The Owl']);
  });
});

describe('a row that lands after the person has moved on', () => {
  // The notes are the plan's, but the history skeleton and the plan screen's
  // retry count belong to whatever screen is up. A late row used to re-read
  // with both, so it flashed a skeleton over another chat, or re-ran the plan
  // screen's read for another plan.
  test('another chat opened meanwhile gets no skeleton, and the plan left is not read', async () => {
    const a = app();
    a.open();
    answerAll(a.requests, 0);
    await settle();
    expect(a.state.spinner).toEqual([true, false]);

    // A second notification: Saturday's chat is on screen now.
    a.state.selected = 8;
    a.listLands();
    await settle();
    expect(a.requests.messages).toHaveLength(1);
    expect(a.requests.roster).toHaveLength(1);
    expect(a.requests.votes).toHaveLength(1);
    expect(a.state.spinner).toEqual([true, false]);
    // Friday's notes go: the chat that opens Friday next reads all of it.
    expect(a.rowlessReadsRef.current.size).toBe(0);
  });

  test('back on the Nest, nothing is read', async () => {
    const a = app();
    a.open();
    answerAll(a.requests, 0);
    await settle();
    a.state.screen = 'main';
    a.listLands();
    await settle();
    expect(a.requests.messages).toHaveLength(1);
    expect(a.requests.roster).toHaveLength(1);
    expect(a.requests.votes).toHaveLength(1);
    expect(a.rowlessReadsRef.current.size).toBe(0);
  });

  test("another plan's screen is not re-run by this plan's retry count", async () => {
    const a = app({ screen: 'detail' });
    a.open();
    a.requests.roster[0].resolve(ROSTER);
    a.requests.votes[0].resolve(TALLY);
    await settle();
    a.state.selected = 8;
    a.listLands();
    expect(a.state.rosterAttempt).toBe(0);
    expect(a.requests.votes).toHaveLength(1);
  });

  test("the same plan's screen, reached from its chat, gets its roster and tally and no skeleton", async () => {
    const a = app();
    a.open();
    answerAll(a.requests, 0);
    await settle();
    a.state.screen = 'detail';
    a.listLands();
    // The history is the chat's, and the chat reads it again on the way back.
    expect(a.requests.messages).toHaveLength(1);
    expect(a.requests.roster).toHaveLength(2);
    expect(a.requests.votes).toHaveLength(2);
    a.requests.roster[1].resolve(ROSTER);
    a.requests.votes[1].resolve(TALLY);
    await settle();
    expect(a.state.spinner).toEqual([true, false]);
    expect(a.row().members.map((m) => m.name)).toEqual(['Jo', 'Sam']);
    expect(a.row().votes.map((v) => v.venue)).toEqual(['The Owl']);
  });

  test('the chat still on the plan shows its skeleton for the re-read, as it does on entry', async () => {
    const a = app();
    a.open();
    answerAll(a.requests, 0);
    await settle();
    a.listLands();
    answerAll(a.requests, 1);
    await settle();
    expect(a.state.spinner).toEqual([true, false, true, false]);
  });
});

describe('the wiring', () => {
  test('the entry effects note each read, and the plan screen re-runs on its retry count', () => {
    const chat = effectBody("  useEffect(() => {\n    if (currentScreen === 'chatDetail' && selectedFlockId) {");
    expect(chat).toMatch(/refreshFlockRoster\(enteredId\)\.then\(\(\) => noteRowlessRead\(enteredId, 'roster'\)\);/);
    expect(chat).toMatch(/loadFlockVotes\(enteredId\)\.then\(\(\) => noteRowlessRead\(enteredId, 'votes'\)\);/);
    expect(chat).toMatch(/loadFlockMessages\(enteredId, \{ showSpinner: true \}\)\.then\(\(\) => noteRowlessRead\(enteredId, 'messages'\)\);/);
    expect(APP).toMatch(/noteRowlessRead\(selectedFlockId, 'plan'\);\n\s+\}\)\n\s+\.catch\(\(\) => setRosterError\(true\)\);/);
    expect(APP).toMatch(/\}, \[currentScreen, selectedFlockId, loadFlockVotes, rosterAttempt, noteRowlessRead\]\);/);
  });

  test('the re-read runs from a layout effect on the list, before the empty state can paint', () => {
    expect(APP).toMatch(/React\.useLayoutEffect\(\(\) => \{\n\s+if \(rowlessReadsRef\.current\.size === 0\) return;[\s\S]{0,260}\}, \[flocks, rereadRowlessFlock\]\);/);
  });
});
