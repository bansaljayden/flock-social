/**
 * ONE DM THREAD'S PINNED VENUE AND TALLY NEVER SHOW IN ANOTHER.
 *
 * Alex opens the DM with Alice, who has Joe's Bar pinned, backs out, and opens
 * the DM with Bob. The pin and the vote tally are single slots in App.js with
 * no conversation on them, and nothing emptied them when a different thread
 * opened. So Bob's header showed Joe's Bar until his own read answered, and
 * for the whole visit when that read failed; a slow answer for Alice landing
 * after Bob's thread opened wrote her pin over his. The DM vote panel puts
 * the pinned place at the top of its list, so one tap sent a vote for Alice's
 * venue into the chat with Bob, and told him its name.
 *
 * The screen's reads go through readDmVenueSlots now, which empties both
 * slots when the thread opening is not the one they hold, and drops a pin
 * answer a later read has overtaken; loadDmVenueVotes drops an overtaken
 * tally the same way, and a failed pin or unpin puts the old pin back only
 * into the thread it came from. Lifted out of App.js by source and run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern dmVenueSlotsThreadSwitch
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

/* `const <name> = useCallback(...);` inside the component, brace-matched to
   the `;` that ends it, skipping strings and comments. */
function callback(name) {
  const start = APP.indexOf(`  const ${name} = useCallback(`);
  if (start === -1) throw new Error(`no \`${name} = useCallback(\` in App.js`);
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
  throw new Error(`unterminated declaration for ${name}`);
}
function run(src, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), src)(...Object.values(scope));
}

const ALICE = 21;
const BOB = 34;
const JOES = { venue_name: "Joe's Bar", venue_address: '1 Main St', venue_id: 'p-joes', venue_rating: 4.4, venue_photo_url: null };
const OWL = { venue_name: 'The Owl', venue_address: '9 Elm St', venue_id: 'p-owl', venue_rating: 4.1, venue_photo_url: null };
const tally = (name) => ({ votes: [{ venue_name: name, vote_count: 1, voters: ['Alex'] }] });

/**
 * The two slots and the screen's reads over them. Every request waits for
 * the test: pins[dmId][n] and votes[dmId][n] are { resolve, reject }.
 */
function dmSlots() {
  const state = { pin: null, votes: [], votesError: '', toasts: [] };
  const pins = {};
  const votes = {};
  const hold = (store) => (dmId) => new Promise((resolve, reject) => {
    (store[dmId] = store[dmId] || []).push({ resolve, reject });
  });
  const set = (key) => (next) => { state[key] = typeof next === 'function' ? next(state[key]) : next; };
  const dmVenueSlotsForRef = { current: null };
  const loadDmVenueVotes = run(`${callback('loadDmVenueVotes')}\nreturn loadDmVenueVotes;`, {
    useCallback: (fn) => fn,
    dmVotesReadSeqRef: { current: 0 },
    setDmVenueVotesError: set('votesError'),
    getDmVenueVotes: hold(votes),
    setDmVenueVotes: set('votes'),
  });
  const open = run(`${callback('readDmVenueSlots')}\nreturn readDmVenueSlots;`, {
    useCallback: (fn) => fn,
    dmVenueSlotsForRef,
    setDmPinnedVenue: set('pin'),
    setDmVenueVotes: set('votes'),
    loadDmVenueVotes,
    dmPinReadSeqRef: { current: 0 },
    getDmPinnedVenue: hold(pins),
    resolveVenuePhoto: (u) => u || null,
  });
  // The unpin as the strip's menu calls it, built over the pin on screen now.
  const unpin = (userId, request) => run(`${callback('unpinDmVenueNow')}\nreturn unpinDmVenueNow;`, {
    useCallback: (fn) => fn,
    dmPinnedVenue: state.pin,
    setDmPinnedVenue: set('pin'),
    apiUnpinDmVenue: () => request,
    dmVenueSlotsForRef,
    showToast: (m) => state.toasts.push(m),
  })(userId);
  return { state, pins, votes, open, unpin };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const pinName = (s) => (s.state.pin ? s.state.pin.name : null);
const tallied = (s) => s.state.votes.map((v) => v.venue_name);

describe("opening Bob's thread after Alice's", () => {
  test("starts with no pin and no tally, not Alice's, while Bob's reads are out", async () => {
    const s = dmSlots();
    s.open(ALICE);
    s.pins[ALICE][0].resolve({ venue: JOES });
    s.votes[ALICE][0].resolve(tally("Joe's Bar"));
    await settle();
    expect(pinName(s)).toBe("Joe's Bar");

    s.open(BOB);
    expect(pinName(s)).toBeNull();
    expect(tallied(s)).toEqual([]);
  });

  test("a failed pin read leaves Bob's strip empty, not holding Alice's place", async () => {
    const s = dmSlots();
    s.open(ALICE);
    s.pins[ALICE][0].resolve({ venue: JOES });
    await settle();
    s.open(BOB);
    s.pins[BOB][0].reject(new Error('The request timed out.'));
    await settle();
    expect(pinName(s)).toBeNull();
  });

  test("Alice's answers landing after Bob's thread opened are dropped", async () => {
    const s = dmSlots();
    s.open(ALICE);
    s.open(BOB);
    // Alice's reads were slow and answer now, after Bob's went out.
    s.pins[ALICE][0].resolve({ venue: JOES });
    s.votes[ALICE][0].resolve(tally("Joe's Bar"));
    await settle();
    expect(pinName(s)).toBeNull();
    expect(tallied(s)).toEqual([]);
    // Bob's own answers are drawn.
    s.pins[BOB][0].resolve({ venue: OWL });
    s.votes[BOB][0].resolve(tally('The Owl'));
    await settle();
    expect(pinName(s)).toBe('The Owl');
    expect(tallied(s)).toEqual(['The Owl']);
  });

  test("a failed tally read for Alice, after Bob's opened, says nothing in Bob's thread", async () => {
    const s = dmSlots();
    s.open(ALICE);
    s.open(BOB);
    s.votes[BOB][0].resolve(tally('The Owl'));
    await settle();
    s.votes[ALICE][0].reject(new Error('The request timed out.'));
    await settle();
    expect(tallied(s)).toEqual(['The Owl']);
    expect(s.state.votesError).toBe('');
  });
});

describe('coming back to the same thread', () => {
  test('keeps what it shows until its own reads answer', async () => {
    const s = dmSlots();
    s.open(ALICE);
    s.pins[ALICE][0].resolve({ venue: JOES });
    await settle();
    // Back from Discover, where a new place was pinned optimistically.
    s.state.pin = { name: 'The Owl' };
    s.open(ALICE);
    expect(pinName(s)).toBe('The Owl');
    s.pins[ALICE][1].resolve({ venue: OWL });
    await settle();
    expect(pinName(s)).toBe('The Owl');
  });
});

describe('a failed unpin', () => {
  test("puts Alice's pin back in Alice's thread", async () => {
    const s = dmSlots();
    s.open(ALICE);
    s.pins[ALICE][0].resolve({ venue: JOES });
    await settle();
    let refuse;
    const done = s.unpin(ALICE, new Promise((_, reject) => { refuse = reject; }));
    expect(pinName(s)).toBeNull();
    refuse(new Error('That did not unpin.'));
    await done;
    expect(pinName(s)).toBe("Joe's Bar");
  });

  test("but not into Bob's, when a notification opened his thread while the request was out", async () => {
    const s = dmSlots();
    s.open(ALICE);
    s.pins[ALICE][0].resolve({ venue: JOES });
    await settle();
    let refuse;
    const done = s.unpin(ALICE, new Promise((_, reject) => { refuse = reject; }));
    s.open(BOB);
    refuse(new Error('That did not unpin.'));
    await done;
    expect(pinName(s)).toBeNull();
    // The failure is still said.
    expect(s.state.toasts).toEqual(['That did not unpin.']);
  });
});

test('the DM screen reads its pin and tally through readDmVenueSlots', () => {
  const effect = APP.slice(APP.indexOf('  // Load messages when opening a DM conversation'), APP.indexOf('  // ── OPENED, the DM twin'));
  expect(effect).toMatch(/readDmVenueSlots\(selectedDmId\);/);
  expect(effect).not.toMatch(/getDmPinnedVenue\(/);
  expect(effect).toMatch(/\}, \[currentScreen, selectedDmId, loadDmMessages, readDmVenueSlots\]\);/);
});
