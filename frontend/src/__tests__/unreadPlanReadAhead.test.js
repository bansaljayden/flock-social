/**
 * One unread plan, read ahead on idle after the plan list lands.
 *
 * The list arrives with every thread empty and already knows which plans have
 * something unread, so opening the app because a plan has new messages and
 * tapping straight in drew a skeleton that waited on a history read (about
 * 190 ms of a 500 ms first open, measured on the local stack). The most recent
 * plan with unread messages and no thread held is now read on idle, so that
 * open paints from memory. This runs the lifted read-ahead against stand-ins
 * and pins the rules that keep it honest: one plan, never over a read that is
 * already out, never on a metered connection or while hidden, never touching
 * the open chat's loading or error state or the unread badge, and never
 * putting back what an unsend or a block took away while it was out.
 */
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// From `start` to the `;` that closes the statement, skipping strings and
// comments so a bracket inside prose cannot end the scan.
function statementFrom(source, start, firstBracket = '=') {
  let i = source.indexOf(firstBracket, start) + (firstBracket === '=' ? 1 : 0);
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); continue; }
    if (ch === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error('statementFrom: unterminated');
}
const moduleConst = (name) => {
  const at = app.search(new RegExp(`^const ${name} = `, 'm'));
  if (at === -1) throw new Error(`no module-scope const ${name}`);
  return statementFrom(app, at);
};

// The module-scope helpers the read-ahead calls, lifted as they are.
const HELPERS = [
  'SERVER_ID_MAX', 'isServerId', 'sameSend', 'echoMatches', 'sendLandedAs', 'landedSends',
  'orderByServerId', 'retractedSince', 'retractedIdsIn', 'saidByAny', 'withoutBlockedQuote',
  'dropRetracted', 'dropRetractedPins', 'DM_PAGE_SIZE', 'pageAgainstHeld', 'mergeHistory', 'mapFlockRow',
  'onMeteredConnection',
];
// eslint-disable-next-line no-new-func
const H = new Function('navigator', `${HELPERS.map(moduleConst).join('\n')}\nreturn { ${HELPERS.join(', ')} };`);

const ME = 1;
const AT = '2026-09-25T20:00:00Z';
const wireRow = (id, text, senderId = 2) => ({ id, flock_id: 7, sender_id: senderId, sender_name: 'Bo', message_text: text, message_type: 'text', created_at: AT });
const plan = (id, over = {}) => ({ id, name: `Plan ${id}`, memberStatus: 'accepted', unread: 0, messages: [], ...over });

function readAhead({ flocks, order = flocks.map((f) => f.id), connection = null, visibility = 'visible', readAt = {}, idle = true }) {
  const helpers = H(connection ? { connection } : {});
  const state = { flocks, reads: [], idles: [], timeouts: [], untouched: true };
  const answers = new Map();
  const historyReadAtRef = { current: { ...readAt } };
  const historyReadSeqRef = { current: {} };
  const retractionsRef = { current: { seq: 0, log: [] } };
  const scope = {
    useCallback: (fn) => fn,
    onMeteredConnection: helpers.onMeteredConnection,
    document: { visibilityState: visibility },
    window: idle ? { requestIdleCallback: (fn, opts) => state.idles.push({ fn, opts }) } : {},
    setTimeout: (fn, ms) => state.timeouts.push({ fn, ms }),
    flocksRef: { get current() { return state.flocks; } },
    historyReadAtRef,
    historyReadSeqRef,
    retractionsRef,
    getMessages: (id) => new Promise((resolve, reject) => { state.reads.push(id); answers.set(id, { resolve, reject }); }),
    mapFlockRow: helpers.mapFlockRow,
    meRef: { current: { id: ME } },
    retractedSince: helpers.retractedSince,
    retractedIdsIn: helpers.retractedIdsIn,
    dropRetractedPins: helpers.dropRetractedPins,
    mergeHistory: helpers.mergeHistory,
    setFlocks: (next) => { state.flocks = typeof next === 'function' ? next(state.flocks) : next; },
    // The open chat's own state. The read-ahead must never reach these.
    setMessagesLoading: () => { state.untouched = false; },
    setMessagesError: () => { state.untouched = false; },
  };
  const at = app.indexOf('const prefetchUnreadThread = useCallback(');
  expect(at).toBeGreaterThan(-1);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(scope), `${statementFrom(app, at)}\nreturn prefetchUnreadThread;`)(...Object.values(scope));
  fn(order);
  const runIdle = () => state.idles.splice(0).forEach(({ fn: go }) => go());
  return { state, answers, historyReadAtRef, historyReadSeqRef, retractionsRef, runIdle };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('which plan is read ahead', () => {
  test('the first plan in the list order with unread messages and no thread held, and only that one', async () => {
    const r = readAhead({ flocks: [plan(1), plan(2, { unread: 3 }), plan(3, { unread: 9 })] });
    expect(r.state.reads).toEqual([]);
    expect(r.state.idles).toHaveLength(1);
    expect(r.state.idles[0].opts).toEqual({ timeout: 4000 });
    r.runIdle();
    expect(r.state.reads).toEqual([2]);
  });

  test('a plan whose thread is already held is passed over', () => {
    const r = readAhead({ flocks: [plan(2, { unread: 3, messages: [{ id: 50 }] }), plan(3, { unread: 1 })] });
    r.runIdle();
    expect(r.state.reads).toEqual([3]);
  });

  test('nothing unread, nothing read', () => {
    const r = readAhead({ flocks: [plan(1), plan(2)] });
    r.runIdle();
    expect(r.state.reads).toEqual([]);
  });

  test('a read of that plan already out (the person opened it) is the one that counts', () => {
    const r = readAhead({ flocks: [plan(2, { unread: 3 })], readAt: { 'flock:2': Date.now() } });
    r.runIdle();
    expect(r.state.reads).toEqual([]);
  });

  test('the plan is chosen when the browser is idle, from the list as it stands then', () => {
    const r = readAhead({ flocks: [plan(2, { unread: 3 }), plan(3, { unread: 1 })] });
    // Opened and read before idle came round.
    r.state.flocks = [plan(2, { unread: 0, messages: [{ id: 60 }] }), plan(3, { unread: 1 })];
    r.runIdle();
    expect(r.state.reads).toEqual([3]);
  });
});

describe('when nothing is read ahead at all', () => {
  test('on save-data', () => {
    const r = readAhead({ flocks: [plan(2, { unread: 3 })], connection: { saveData: true } });
    expect(r.state.idles).toEqual([]);
    expect(r.state.timeouts).toEqual([]);
  });

  test('on a 2g-class link', () => {
    const r = readAhead({ flocks: [plan(2, { unread: 3 })], connection: { effectiveType: 'slow-2g' } });
    expect(r.state.idles).toEqual([]);
  });

  test('while the app is hidden', () => {
    const r = readAhead({ flocks: [plan(2, { unread: 3 })], visibility: 'hidden' });
    r.runIdle();
    expect(r.state.reads).toEqual([]);
  });

  test('without requestIdleCallback it waits on a timer instead of reading at once', () => {
    const r = readAhead({ flocks: [plan(2, { unread: 3 })], idle: false });
    expect(r.state.reads).toEqual([]);
    expect(r.state.timeouts).toHaveLength(1);
    r.state.timeouts[0].fn();
    expect(r.state.reads).toEqual([2]);
  });
});

describe('what the answer does', () => {
  test('fills the thread, the roster and the pins, and leaves the badge and the open chat alone', async () => {
    const r = readAhead({ flocks: [plan(2, { unread: 2 })] });
    r.runIdle();
    expect(r.historyReadAtRef.current['flock:2']).toBeGreaterThan(0);
    r.answers.get(2).resolve({
      messages: [wireRow(40, 'are we still on'), wireRow(41, 'yes')],
      readers: [{ user_id: 2 }],
      pins: [{ id: 5, messageId: 40, text: 'are we still on', senderId: 2 }],
    });
    await flush();
    const got = r.state.flocks[0];
    expect(got.messages.map((m) => m.id)).toEqual([40, 41]);
    expect(got.readers).toEqual([{ user_id: 2 }]);
    expect(got.pins.map((p) => p.id)).toEqual([5]);
    expect(got.unread).toBe(2);
    expect(r.state.untouched).toBe(true);
  });

  test('a later read of the same plan overtakes it, and its answer changes nothing', async () => {
    const r = readAhead({ flocks: [plan(2, { unread: 2 })] });
    r.runIdle();
    // The person opened the chat meanwhile; its read took the next turn.
    r.historyReadSeqRef.current['flock:2'] += 1;
    r.answers.get(2).resolve({ messages: [wireRow(40, 'stale')] });
    await flush();
    expect(r.state.flocks[0].messages).toEqual([]);
  });

  test('an unsend that landed while it was out stays unsent', async () => {
    const r = readAhead({ flocks: [plan(2, { unread: 2 })] });
    r.runIdle();
    r.retractionsRef.current = { seq: 1, log: [{ seq: 1, kind: 'flock', messageId: 40 }] };
    r.answers.get(2).resolve({ messages: [wireRow(40, 'take this back'), wireRow(41, 'ok')], pins: [{ id: 5, messageId: 40, text: 'take this back', senderId: 2 }] });
    await flush();
    expect(r.state.flocks[0].messages.map((m) => m.id)).toEqual([41]);
    expect(r.state.flocks[0].pins).toEqual([]);
  });

  test('a miss is not counted as a read by the catch-up throttle, and says nothing', async () => {
    const r = readAhead({ flocks: [plan(2, { unread: 2 })] });
    r.runIdle();
    r.answers.get(2).reject(new Error('offline'));
    await flush();
    expect(r.historyReadAtRef.current['flock:2']).toBe(0);
    expect(r.state.flocks[0].messages).toEqual([]);
    expect(r.state.untouched).toBe(true);
  });
});

test('loadFlocks hands the list order over once the list is in state, after the invite step', () => {
  const at = app.indexOf('const loadFlocks = useCallback(');
  const body = statementFrom(app, at);
  const hand = body.indexOf('prefetchUnreadRef.current?.(fresh.map((f) => f.id));');
  expect(hand).toBeGreaterThan(-1);
  expect(hand).toBeGreaterThan(body.indexOf('openJoinedFlock(invite)'));
  expect(hand).toBeGreaterThan(body.indexOf('setFlocks('));
  // The ref is declared before loadFlocks and assigned where the read-ahead is
  // defined, beside the other history read.
  expect(app.indexOf('const prefetchUnreadRef = useRef(null);')).toBeLessThan(at);
  expect(app).toMatch(/prefetchUnreadRef\.current = prefetchUnreadThread;/);
});
