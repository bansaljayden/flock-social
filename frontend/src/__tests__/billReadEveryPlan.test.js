// ---------------------------------------------------------------------------
// A POSTED BILL LOADS ON EVERY PLAN, WHATEVER STATE THE PLAN IS IN.
//
// loadMoneyState asked for the bill only when the flock it found in the list
// was confirmed, completed or locked, and set it to null otherwise. A plan
// with the budget off offers Split the Bill in any state and the server's
// /create never reads status, so a bill posted on a plan still being voted on
// never loaded for anybody who opened the chat afterwards. Bob got "You owe
// Alice $30.00", tapped it, and found no bill card, no pill and no Settle Up,
// while the leave route refused him with "settle your share first". The same
// happened on a plan cancelled after its bill, and on a cold start from a bill
// push, which opens the chat before GET /flocks answers, so the flock was not
// in the list for the check to find.
//
// loadMoneyState is a useCallback inside App.js, so it is lifted out as source
// text and run against stand-ins, the way chatEchoOrderAndRetraction lifts
// loadFlockMessages. flocksRef is handed in with the plan in it (or empty) so
// the old status gate, if it came back, would have what it read.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test billReadEveryPlan --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// A `const <name> = useCallback(...)` declared inside the component, up to its
// closing semicolon. Same walk as chatEchoOrderAndRetraction's liftCallback.
function liftCallback(source, name) {
  const marker = `  const ${name} = useCallback(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`liftCallback: no \`${name} = useCallback(\` in source`);
  let i = source.indexOf('=', start) + 1;
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
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`liftCallback: unterminated declaration for ${name}`);
}

const LOAD_SRC = liftCallback(appSource, 'loadMoneyState');

const notFound = () => Object.assign(new Error('No bill found for this flock'), { status: 404 });
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * One App.js worth of money state around a lifted loadMoneyState. getBillSplit
 * answers from `bills` by flock id (a 404 when there is none), unless a test
 * holds the answer back with `hold`.
 */
function harness({ flocks = [], bills = {}, billSplit = null, hold = false } = {}) {
  const state = { budgetStatus: null, billSplit, moneyError: '' };
  const setter = (key) => (next) => { state[key] = typeof next === 'function' ? next(state[key]) : next; };
  const pending = [];
  const getBillSplit = jest.fn((id) => {
    const answer = () => (bills[id] ? Promise.resolve({ bill: bills[id] }) : Promise.reject(notFound()));
    if (!hold) return answer();
    return new Promise((resolve, reject) => { pending.push(() => answer().then(resolve, reject)); });
  });
  const scope = {
    useCallback: (fn) => fn,
    moneyStateSeqRef: { current: 0 },
    flocksRef: { current: flocks },
    setMoneyError: setter('moneyError'),
    setBudgetStatus: setter('budgetStatus'),
    setBillSplit: setter('billSplit'),
    getBudgetStatus: jest.fn(() => Promise.resolve({ budgetEnabled: false })),
    getBillSplit,
  };
  // eslint-disable-next-line no-new-func
  const load = new Function(...Object.keys(scope), `${LOAD_SRC}\nreturn loadMoneyState;`)(...Object.values(scope));
  return { load, state, getBillSplit, release: () => pending.splice(0).forEach((go) => go()) };
}

const aliceBill = { id: 70, flockId: 5, hasPayer: true, paidBy: { id: 1, name: 'Alice' }, totalAmount: 120, shares: [] };

describe('the bill is read whatever the plan status says', () => {
  test.each(['voting', 'planning', 'cancelled', 'confirmed', 'completed'])(
    'a bill on a %s plan loads when the chat opens',
    async (status) => {
      const h = harness({ flocks: [{ id: 5, status }], bills: { 5: aliceBill } });
      h.load(5);
      await settle();
      expect(h.getBillSplit).toHaveBeenCalledWith(5);
      expect(h.state.billSplit).toBe(aliceBill);
      expect(h.state.moneyError).toBe('');
    },
  );

  test('a cold start from a bill push, before GET /flocks has answered, still loads it', async () => {
    // The push intent opens the chat with the flock list still empty.
    const h = harness({ flocks: [], bills: { 5: aliceBill } });
    h.load(5);
    await settle();
    expect(h.getBillSplit).toHaveBeenCalledWith(5);
    expect(h.state.billSplit).toBe(aliceBill);
  });

  test('a plan with no bill answers 404, which is "no bill" and not an error', async () => {
    const h = harness({ flocks: [{ id: 5, status: 'voting' }] });
    h.load(5);
    await settle();
    expect(h.state.billSplit).toBeNull();
    expect(h.state.moneyError).toBe('');
  });

  test('a refused read is said, not drawn as a plan with no bill', async () => {
    const h = harness({ flocks: [{ id: 5, status: 'voting' }] });
    h.getBillSplit.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('Server is down'), { status: 503 })));
    h.load(5);
    await settle();
    expect(h.state.billSplit).toBeNull();
    expect(h.state.moneyError).toBe('Server is down');
  });
});

describe('what shows while the read is in flight', () => {
  test('a chat-to-chat jump does not draw the last plan\'s bill here', () => {
    const other = { ...aliceBill, id: 71, flockId: 6 };
    const h = harness({ flocks: [{ id: 5, status: 'voting' }], bills: { 5: aliceBill }, billSplit: other, hold: true });
    h.load(5);
    expect(h.state.billSplit).toBeNull();
  });

  test('a re-read of the same plan keeps its bill up until the answer lands', async () => {
    const h = harness({ flocks: [{ id: 5, status: 'confirmed' }], bills: { 5: aliceBill }, billSplit: aliceBill, hold: true });
    h.load(5);
    expect(h.state.billSplit).toBe(aliceBill);
    h.release();
    await settle();
    expect(h.state.billSplit).toBe(aliceBill);
  });
});
