/**
 * TWO THINGS THE NEST TAB SAID THAT WERE NOT TRUE.
 *
 *   1. "NEEDS YOUR VOTE" NEVER CLEARED. The card at the top of the home screen
 *      is addressed to the person reading it, it names one flock, and tapping
 *      it opens that flock. Its whole content is a claim about YOU. It was
 *      built from `flocks.filter(f => f.status === 'voting')`, which is a
 *      claim about the FLOCK, so somebody who had voted an hour ago was still
 *      being told their vote was needed, and would be for as long as the vote
 *      stayed open. `tools/e2e/venue.spec.js` drove it: vote in the panel, go
 *      back to Nest, the demand is still there.
 *
 *   2. ACCEPTING AN INVITE PROMOTED A PREVIEW INTO THE REAL LIST.
 *      `GET /api/flocks` collapses a flock you have only been invited to down
 *      to a name, a venue, a time and two counts. That is deliberate: a
 *      membership row is not acceptance, and an invitee is not shown the
 *      inside of a plan. `handleAcceptFlockInvite` took that trimmed object and
 *      spread it into `flocks` with memberStatus flipped, so the accepted
 *      flock had `budgetEnabled: false`, no ghost mode, no coordinates and no
 *      budget context. A budget flock showed "Split the Bill" where the budget
 *      form belongs until the next full reload, which is exactly the screen a
 *      lot of people accept an invite in order to reach.
 *
 * WHY THESE ARE EXECUTED RATHER THAN PINNED. Both fixes are one expression
 * each, and one expression is the easiest thing in the world to pin in a shape
 * that a rewrite quietly escapes. So the vote predicate and the accept handler
 * are both LIFTED out of `App.js` as source text and RUN against stand in
 * collaborators, which is the move `chatSurface` and `contentTakedownWiring`
 * already use here. Deleting either fix lets a real call reach a real
 * assertion.
 *
 * Every free name a lifted body reads is supplied by name, so a body that
 * starts reading something this file does not hand it is a ReferenceError
 * rather than a silent undefined that passes.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestCardTruth --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

/**
 * Balanced-delimiter scan from the first `=` after `start`, stopping at the
 * `;` that closes the declaration. Skips comments and string literals, so a
 * brace inside either cannot end the lift early.
 */
function liftFrom(source, start) {
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
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
  throw new Error('liftFrom: unterminated declaration');
}

/** Lift a module-scope `const <name> = ...;` out of App.js. */
function liftModuleConst(name) {
  const marker = `\nconst ${name} = `;
  const at = APP.indexOf(marker);
  if (at === -1) throw new Error(`liftModuleConst: no module-scope const ${name}`);
  return liftFrom(APP, at + 1);
}

/** Lift a `const <name> = useCallback(...)` declared inside a component. */
function liftCallback(name) {
  const marker = `  const ${name} = useCallback(`;
  const at = APP.indexOf(marker);
  if (at === -1) throw new Error(`liftCallback: no ${name} = useCallback( in App.js`);
  return liftFrom(APP, at);
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. Has this reader voted
   ═══════════════════════════════════════════════════════════════════════════ */

const hasCastMyVote = (() => {
  const source = liftModuleConst('hasCastMyVote');
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn hasCastMyVote;`)();
})();

describe('the question the home card should have been asking', () => {
  it('the lift found a real function, not an empty slice', () => {
    // The trap: a marker that misses returns nothing, and every case below
    // then tests undefined against undefined and passes.
    expect(typeof hasCastMyVote).toBe('function');
    expect(liftModuleConst('hasCastMyVote').length).toBeGreaterThan(60);
  });

  it('says yes when the reader is in a voters list', () => {
    // normalizeVotes rewrites the caller's own name to the literal 'You', on
    // both surfaces that show tallies. This reads the same marker.
    expect(hasCastMyVote({ votes: [{ venue: 'Corvid Coffee', voters: ['You'] }] })).toBe(true);
    expect(hasCastMyVote({
      votes: [
        { venue: 'The Wren Room', voters: ['Bravo'] },
        { venue: 'Corvid Coffee', voters: ['Charlie', 'You'] },
      ],
    })).toBe(true);
  });

  it('says no when other people have voted and the reader has not', () => {
    expect(hasCastMyVote({
      votes: [
        { venue: 'The Wren Room', voters: ['Bravo'] },
        { venue: 'Corvid Coffee', voters: ['Charlie'] },
      ],
    })).toBe(false);
  });

  it('says no for a flock whose tallies have not been fetched', () => {
    // `votes: []` is every flock on a cold boot. "Not voted" is the honest
    // answer there: nothing on the client knows otherwise yet.
    expect(hasCastMyVote({ votes: [] })).toBe(false);
    expect(hasCastMyVote({})).toBe(false);
    expect(hasCastMyVote(null)).toBe(false);
  });

  it('does not throw on a row with no voters array', () => {
    // Guest-only tallies come back with no member voters at all.
    expect(hasCastMyVote({ votes: [{ venue: 'Corvid Coffee', guestCount: 3 }] })).toBe(false);
  });

  it('is not fooled by somebody actually called You', () => {
    // The marker is exact, so a name that merely contains it is a different
    // person. `voters` holds display names, and "Youssef" is one.
    expect(hasCastMyVote({ votes: [{ venue: 'Corvid Coffee', voters: ['Youssef'] }] })).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   1b. Which vote is the reader's, when a flockmate has the same name
   ═══════════════════════════════════════════════════════════════════════════ */

const normalizeVotes = (() => {
  const source = liftModuleConst('normalizeVotes');
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn normalizeVotes;`)();
})();

describe('the reader\'s vote is found by who they are, not by their name', () => {
  // The vote POST reply and every new_vote event carry voter NAMES, and two
  // members can share one. The server marks the row that holds the reader's
  // own vote (`mine`); the name alone decided before, so the other Alex's
  // vote read as 'You'.
  const me = { id: 7, name: 'Alex' };

  it('the lift found a real function, not an empty slice', () => {
    expect(typeof normalizeVotes).toBe('function');
    expect(liftModuleConst('normalizeVotes').length).toBeGreaterThan(200);
  });

  it('another Alex voting is not the reader voting', () => {
    const votes = normalizeVotes([{ venue_name: 'Kome', voters: ['Alex'], mine: false }], me);
    expect(votes[0].voters).toEqual(['Alex']);
    expect(hasCastMyVote({ votes })).toBe(false);
  });

  it('the reader\'s own row says You, and only that row', () => {
    const votes = normalizeVotes([
      { venue_name: 'Kome', voters: ['Alex'], mine: false },
      { venue_name: 'Ramen', voters: ['Bo', 'Alex'], mine: true },
    ], me);
    expect(votes.map((v) => v.voters)).toEqual([['Alex'], ['Bo', 'You']]);
    expect(hasCastMyVote({ votes })).toBe(true);
  });

  it('two Alexes on the same row are You and Alex, not You twice', () => {
    const votes = normalizeVotes([{ venue_name: 'Kome', voters: ['Alex', 'Alex'], mine: true }], me);
    expect(votes[0].voters).toEqual(['You', 'Alex']);
  });

  it('the GET\'s id rows are still read by id', () => {
    const votes = normalizeVotes([{ venue_name: 'Kome', voters: [{ id: 8, name: 'Alex' }, { id: 7, name: 'Alex' }] }], me);
    expect(votes[0].voters).toEqual(['Alex', 'You']);
  });

  it('a payload from a server without the mark keeps the name reading it always had', () => {
    const votes = normalizeVotes([{ venue_name: 'Kome', voters: ['Alex'] }], me);
    expect(votes[0].voters).toEqual(['You']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The card is built from that question
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the home screen stops asking once the vote is cast', () => {
  /** The real predicate from App.js, run over fixtures.
   *
   *  LIFTED AS A PAIR. The question moved into its own helper when the flock
   *  list read started answering it: a flock whose tally has not been read
   *  this session now falls back to the list's own `iVoted` instead of staying
   *  silent for ever, which is what kept this card off the screen it lives on.
   *  The filter alone no longer runs, so both lines come across together. */
  const liftPredicate = () => {
    const from = APP.indexOf('const needsMyVote = (f) =>');
    expect(from).toBeGreaterThan(-1);
    const marker = 'const needsAction = liveFlocks.filter(';
    const at = APP.indexOf(marker, from);
    expect(at).toBeGreaterThan(from);
    const src = APP.slice(from, APP.indexOf(';', at) + 1);
    expect(src.length).toBeGreaterThan(marker.length);
    expect(src.length).toBeLessThan(700);
    return src;
  };
  const needsAction = (() => {
    const src = liftPredicate();
    // eslint-disable-next-line no-new-func
    const build = new Function('liveFlocks', 'hasCastMyVote', 'votesLoadedRef', `${src}\nreturn needsAction;`);
    return (flocks) => build(flocks, hasCastMyVote, { current: new Set(flocks.map((f) => f.id)) });
  })();

  test('a flock whose votes were never loaded this session is not accused', () => {
    // Cold boot seeds votes as [], so before this gate the card said
    // "Needs your vote" about plans the person voted in yesterday until
    // they happened to open one. An unloaded [] is not evidence.
    const src = liftPredicate();
    // eslint-disable-next-line no-new-func
    const build = new Function('liveFlocks', 'hasCastMyVote', 'votesLoadedRef', `${src}
return needsAction;`);
    const unloaded = build([{ id: 9, status: 'voting', votes: [] }], hasCastMyVote, { current: new Set() });
    expect(unloaded).toEqual([]);
  });

  const voting = (id, votes) => ({ id, name: `Flock ${id}`, status: 'voting', votes });

  it('a flock still waiting on this reader is on the card', () => {
    expect(needsAction([voting(1, [])]).map((f) => f.id)).toEqual([1]);
  });

  it('a flock this reader has voted in is not', () => {
    expect(needsAction([voting(1, [{ venue: 'Corvid Coffee', voters: ['You'] }])])).toEqual([]);
  });

  it('somebody else voting does not clear the demand', () => {
    // The old predicate could not tell these two cases apart, and this is the
    // one that proves it is not just counting votes.
    expect(needsAction([voting(1, [{ venue: 'Corvid Coffee', voters: ['Bravo'] }])]).map((f) => f.id))
      .toEqual([1]);
  });

  it('a confirmed flock is never on it, voted in or not', () => {
    const confirmed = { id: 2, name: 'Flock 2', status: 'confirmed', votes: [] };
    expect(needsAction([confirmed])).toEqual([]);
  });

  it('the count on the card is the count of flocks still waiting', () => {
    // The card reads "N other flocks need your vote too" off this length, so
    // a voted flock left in the list inflates a number in front of the user.
    const list = [
      voting(1, [{ venue: 'Corvid Coffee', voters: ['You'] }]),
      voting(2, []),
      voting(3, [{ venue: 'The Wren Room', voters: ['Bravo'] }]),
    ];
    expect(needsAction(list).map((f) => f.id)).toEqual([2, 3]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. Accepting an invite ends with the real row
   ═══════════════════════════════════════════════════════════════════════════ */

describe('joining from an invite card', () => {
  /**
   * Build the real handler with stand ins. `useCallback` is the identity, and
   * the returned harness reports everything the handler touched.
   */
  function buildAccept({ acceptRejects = null, invite, heldGuestTokens = [], acceptGate = null, loadGate = null } = {}) {
    const calls = {
      accepted: [], carried: [], identityAsked: [], toasts: [], loadFlocks: 0, verifyChecked: [], buzzes: 0,
      // Every value acceptingInviteId took, in order, and every navigation.
      accepting: [], selected: [], screens: [],
      // What the screen held at the moment the chat was asked to open.
      loadedBeforeOpen: [],
    };
    let flocks = [];
    let pending = invite ? [invite] : [];
    const refused = new Set();
    // Where the person is. The Messages tab by default, which is where the
    // invite cards live; a test moves it to model somebody tapping away.
    const joinNavRef = { current: { screen: 'main', tab: 'chat' } };
    const acceptingInviteRef = { current: null };
    const source = liftCallback('handleAcceptFlockInvite');
    // The navigation step is its own callback, lifted and run too, so the
    // "only if they are still here" rule is the real one and not a stand-in.
    const openSource = liftCallback('openChatAfterJoin');
    // eslint-disable-next-line no-new-func
    const openChatAfterJoin = new Function(
      'useCallback', 'joinNavRef', 'setSelectedFlockId', 'setCurrentScreen',
      `${openSource}\nreturn openChatAfterJoin;`
    )(
      (fn) => fn,
      joinNavRef,
      (id) => { calls.selected.push(id); calls.loadedBeforeOpen.push(calls.loadFlocks); },
      (s) => { calls.screens.push(s); },
    );
    // The accept carries the guest identities this device holds for the
    // signed-in person (services/inviteHandoff.js storedGuestTokens), read off
    // meRef, so both are handed in alongside the rest. refusedInvitesRef is
    // where a CANNOT_JOIN refusal is remembered for the session. The join
    // also buzzes once the server has said yes (services/haptics.js),
    // counted here.
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'useCallback', 'acceptFlockInvite', 'pendingFlockInvites', 'setPendingFlockInvites',
      'setFlocks', 'showToast', 'loadFlocks', 'needsEmailVerification', 'storedGuestTokens', 'meRef',
      'refusedInvitesRef',
      'hapticSuccess',
      'acceptingInviteRef', 'setAcceptingInviteId', 'joinNavRef', 'openChatAfterJoin',
      `${source}\nreturn handleAcceptFlockInvite;`
    );
    const handler = factory(
      (fn) => fn,
      (id, tokens) => {
        calls.accepted.push(id);
        calls.carried.push(tokens);
        if (acceptGate) return acceptGate.then(() => (acceptRejects ? Promise.reject(acceptRejects) : {}));
        return acceptRejects ? Promise.reject(acceptRejects) : Promise.resolve({});
      },
      pending,
      (fn) => { pending = typeof fn === 'function' ? fn(pending) : fn; },
      (fn) => { flocks = typeof fn === 'function' ? fn(flocks) : fn; },
      (message, type) => calls.toasts.push({ message, type }),
      () => {
        // loadFlocks resolves when the list has landed. The count moves when
        // it lands, not when it is asked, so "opened after the refetch" is
        // something this harness can tell apart from "opened after asking".
        const land = () => { calls.loadFlocks += 1; };
        return loadGate ? loadGate.then(land) : Promise.resolve().then(land);
      },
      (err, action) => { calls.verifyChecked.push(action); return false; },
      (opts) => { calls.identityAsked.push(opts); return heldGuestTokens; },
      { current: { id: 5, name: 'Sam Rivera' } },
      { current: refused },
      () => { calls.buzzes += 1; },
      acceptingInviteRef,
      (v) => { calls.accepting.push(v); },
      joinNavRef,
      openChatAfterJoin,
    );
    return {
      handler,
      calls,
      refused,
      joinNavRef,
      get flocks() { return flocks; },
      get pending() { return pending; },
    };
  }

  /** A promise and the function that settles it, to hold a request open. */
  function gate() {
    let open;
    const promise = new Promise((resolve) => { open = resolve; });
    return { promise, open };
  }

  /** What GET /api/flocks actually returns for a flock you were invited to. */
  const PREVIEW = {
    id: 41,
    name: 'Budget night',
    host: 'Alpha',
    memberStatus: 'invited',
    memberCount: 3,
    time: 'Fri, 9:00 PM',
    venue: 'TBD',
    // Everything below is what the route WITHHELD, and what the preview row
    // therefore defaulted to. This is the shape that used to be promoted.
    budgetEnabled: false,
    budgetContext: null,
    ghostModeEnabled: false,
    votes: [],
    messages: [],
  };

  it('the lift found the handler', () => {
    const source = liftCallback('handleAcceptFlockInvite');
    expect(source.length).toBeGreaterThan(300);
    expect(source).toContain('acceptFlockInvite(flockId, storedGuestTokens({ name: meRef.current?.name }))');
  });

  it('the accept carries the link answers this device holds for this person, so they are not counted twice', () => {
    // Somebody who answered the plan's share link by name and then accepted
    // the invite here stayed on the plan as a guest AND a member. The server
    // retires the guest row it is handed (POST /api/flocks/:id/join).
    const held = ['11111111-2222-4333-8444-555555555555'];
    const h = buildAccept({ invite: PREVIEW, heldGuestTokens: held });
    return h.handler(41).then(() => {
      expect(h.calls.identityAsked).toEqual([{ name: 'Sam Rivera' }]);
      expect(h.calls.carried).toEqual([held]);
    });
  });

  it('a successful join refetches the list, so the full row replaces the preview', () => {
    // THE FIX. Without this the trimmed preview IS the accepted flock until
    // something else reloads, and every field the route withheld reads as
    // absent rather than as unknown.
    const h = buildAccept({ invite: PREVIEW });
    return h.handler(41).then(() => {
      expect(h.calls.accepted).toEqual([41]);
      expect(h.calls.loadFlocks).toBe(1);
    });
  });

  it('the flock still appears the instant the tap lands', () => {
    // The refetch is a round trip. Dropping the optimistic insert would leave
    // the person looking at a success toast about a list that has not changed.
    const h = buildAccept({ invite: PREVIEW });
    return h.handler(41).then(() => {
      expect(h.flocks.map((f) => f.id)).toEqual([41]);
      expect(h.flocks[0].memberStatus).toBe('accepted');
      expect(h.pending).toEqual([]);
      expect(h.calls.toasts[0].message).toBe('Joined Budget night!');
      // And the hand feels it, once.
      expect(h.calls.buzzes).toBe(1);
    });
  });

  it('a refused join refetches nothing and says what happened', () => {
    // A refetch after a failure would paper over the refusal with a list that
    // looks unchanged for a reason nobody stated.
    const h = buildAccept({ invite: PREVIEW, acceptRejects: new Error('Flock is full') });
    return h.handler(41).then(() => {
      expect(h.calls.loadFlocks).toBe(0);
      expect(h.flocks).toEqual([]);
      expect(h.pending.map((f) => f.id)).toEqual([41]);
      expect(h.calls.toasts).toEqual([{ message: 'Flock is full', type: 'error' }]);
      // A join that did not happen does not buzz like one that did.
      expect(h.calls.buzzes).toBe(0);
    });
  });

  it('an unverified account is still sent to the verify sheet, not a toast', () => {
    // needsEmailVerification answers true and owns the message in that case.
    // This checks the handler still asks it before it words anything itself.
    const source = liftCallback('handleAcceptFlockInvite');
    expect(source).toContain("if (needsEmailVerification(err, 'join a flock')) return;");
  });

  /** What api.js throws for the server's refusal of a blocked pair. */
  const cannotJoin = () => Object.assign(new Error('You cannot join this plan.'), { status: 403, code: 'CANNOT_JOIN' });

  it('a plan somebody on it has a block with this account takes the card away, and says so', () => {
    // The card stayed, and every tap was refused with the same toast: the
    // membership row is still an invite, so nothing else would ever move it.
    const h = buildAccept({ invite: PREVIEW, acceptRejects: cannotJoin() });
    return h.handler(41).then(() => {
      expect(h.pending).toEqual([]);
      expect(h.flocks).toEqual([]);
      expect(h.calls.loadFlocks).toBe(0);
      expect(h.calls.toasts).toEqual([{ message: 'You cannot join this plan.', type: 'error' }]);
      // Remembered under this account, so the next load does not put it back.
      expect([...h.refused]).toEqual(['5:41']);
    });
  });

  it('any other 403 keeps the card: only the server\'s code means the plan is closed to this account', () => {
    const h = buildAccept({ invite: PREVIEW, acceptRejects: Object.assign(new Error('Nope'), { status: 403 }) });
    return h.handler(41).then(() => {
      expect(h.pending.map((f) => f.id)).toEqual([41]);
      expect(h.refused.size).toBe(0);
    });
  });

  it('a declined plan\'s Re-join is taken away on the same refusal', () => {
    let declined = [{ ...PREVIEW, memberStatus: 'declined' }];
    const refused = new Set();
    const toasts = [];
    // eslint-disable-next-line no-new-func
    const handler = new Function(
      'useCallback', 'acceptFlockInvite', 'declinedFlockInvites', 'setDeclinedFlockInvites',
      'setFlocks', 'showToast', 'loadFlocks', 'needsEmailVerification', 'storedGuestTokens', 'meRef',
      'refusedInvitesRef', 'acceptingInviteRef', 'setAcceptingInviteId', 'joinNavRef', 'openChatAfterJoin', 'hapticSuccess',
      `${liftCallback('handleRejoinDeclinedFlock')}\nreturn handleRejoinDeclinedFlock;`
    )(
      (fn) => fn,
      () => Promise.reject(cannotJoin()),
      declined,
      (fn) => { declined = typeof fn === 'function' ? fn(declined) : fn; },
      () => { throw new Error('nothing is added to the list on a refusal'); },
      (message, type) => toasts.push({ message, type }),
      () => { throw new Error('nothing is refetched on a refusal'); },
      () => false,
      () => [],
      { current: { id: 5, name: 'Sam Rivera' } },
      { current: refused },
      { current: null },
      () => {},
      { current: { screen: 'main', tab: 'chat' } },
      () => { throw new Error('a refused join opens nothing'); },
      () => { throw new Error('a refused join does not buzz success'); },
    );
    return handler(41).then(() => {
      expect(declined).toEqual([]);
      expect([...refused]).toEqual(['5:41']);
      expect(toasts).toEqual([{ message: 'You cannot join this plan.', type: 'error' }]);
    });
  });

  // A plan that is over has no way back in, so its Re-join could only be
  // refused: the declined list leaves it out, and a plan that ended after the
  // list loaded leaves on the server's 409 (app audit 2026-10-03).
  it('a declined plan that is over offers no Re-join', () => {
    const load = liftCallback('loadFlocks');
    expect(load).toMatch(/setDeclinedFlockInvites\(mapped\.filter\(f => f\.memberStatus === 'declined' && !f\.finished && f\.status !== 'completed' && f\.status !== 'cancelled' && !refused\(f\)\)\);/);
  });

  it('a Re-join refused because the plan ended takes the row away with the server\'s words', () => {
    let declined = [{ ...PREVIEW, memberStatus: 'declined' }];
    const toasts = [];
    // eslint-disable-next-line no-new-func
    const handler = new Function(
      'useCallback', 'acceptFlockInvite', 'declinedFlockInvites', 'setDeclinedFlockInvites',
      'setFlocks', 'showToast', 'loadFlocks', 'needsEmailVerification', 'storedGuestTokens', 'meRef',
      'refusedInvitesRef', 'acceptingInviteRef', 'setAcceptingInviteId', 'joinNavRef', 'openChatAfterJoin', 'hapticSuccess',
      `${liftCallback('handleRejoinDeclinedFlock')}\nreturn handleRejoinDeclinedFlock;`
    )(
      (fn) => fn,
      () => Promise.reject(Object.assign(new Error('This plan is finished and cannot be reopened'), { status: 409 })),
      declined,
      (fn) => { declined = typeof fn === 'function' ? fn(declined) : fn; },
      () => { throw new Error('nothing is added to the list on a refusal'); },
      (message, type) => toasts.push({ message, type }),
      () => { throw new Error('nothing is refetched on a refusal'); },
      () => false,
      () => [],
      { current: { id: 5, name: 'Sam Rivera' } },
      { current: new Set() },
      { current: null },
      () => {},
      { current: { screen: 'main', tab: 'chat' } },
      () => { throw new Error('a refused join opens nothing'); },
      () => { throw new Error('a refused join does not buzz success'); },
    );
    return handler(41).then(() => {
      expect(declined).toEqual([]);
      expect(toasts).toEqual([{ message: 'This plan is finished and cannot be reopened', type: undefined }]);
    });
  });

  it('the list load leaves out what this account was refused, keyed the way the handlers write it', () => {
    // The load is the one place the card could come back from, so it reads
    // the same `${account}:${plan}` key the two handlers add.
    const load = liftCallback('loadFlocks');
    expect(load).toContain('const refused = (f) => refusedInvitesRef.current.has(`${meRef.current?.id}:${f.id}`);');
    expect(load).toMatch(/setPendingFlockInvites\(mapped\.filter\(f => f\.memberStatus === 'invited' [^\n]*&& !refused\(f\)\)\);/);
    expect(load).toMatch(/setDeclinedFlockInvites\(mapped\.filter\(f => f\.memberStatus === 'declined' [^\n]*&& !refused\(f\)\)\);/);
    for (const name of ['handleAcceptFlockInvite', 'handleRejoinDeclinedFlock']) {
      expect(liftCallback(name)).toContain('refusedInvitesRef.current.add(`${meRef.current?.id}:${flockId}`);');
    }
  });

  // ── The tap answers at once, and the join ends inside the plan ──────────
  //
  // The check mark did nothing visible until the server replied, which invites
  // a second tap, and a join then left the person on the list to find the new
  // row before they could vote or answer the budget.

  it('the card is marked joining from the tap until the server answers, then cleared', async () => {
    const g = gate();
    const h = buildAccept({ invite: PREVIEW, acceptGate: g.promise });
    const done = h.handler(41);
    // Marked before the request has answered: this is the visible response.
    expect(h.calls.accepting).toEqual([41]);
    g.open();
    await done;
    expect(h.calls.accepting).toEqual([41, null]);
  });

  it('a second tap while the join is out sends nothing', async () => {
    const g = gate();
    const h = buildAccept({ invite: PREVIEW, acceptGate: g.promise });
    const first = h.handler(41);
    await h.handler(41);
    g.open();
    await first;
    expect(h.calls.accepted).toEqual([41]);
  });

  it('a successful join opens the plan\'s chat, after the full row has landed', async () => {
    const h = buildAccept({ invite: PREVIEW });
    await h.handler(41);
    expect(h.calls.selected).toEqual([41]);
    expect(h.calls.screens).toEqual(['chatDetail']);
    // The chat would otherwise draw the trimmed preview: a budget plan with
    // "Split the Bill" where the budget form belongs.
    expect(h.calls.loadedBeforeOpen).toEqual([1]);
  });

  it('somebody who tapped away while it joined is left where they went', async () => {
    const g = gate();
    const h = buildAccept({ invite: PREVIEW, loadGate: g.promise });
    const done = h.handler(41);
    h.joinNavRef.current = { screen: 'main', tab: 'home' };
    g.open();
    await done;
    expect(h.calls.screens).toEqual([]);
    // The join itself still happened and still said so.
    expect(h.calls.toasts[0].message).toBe('Joined Budget night!');
  });

  it('a refused join opens nothing, keeps the card, and lets the next tap through', async () => {
    const h = buildAccept({ invite: PREVIEW, acceptRejects: new Error('Flock is full') });
    await h.handler(41);
    expect(h.calls.screens).toEqual([]);
    expect(h.pending.map((f) => f.id)).toEqual([41]);
    expect(h.calls.accepting).toEqual([41, null]);
    await h.handler(41);
    expect(h.calls.accepted).toEqual([41, 41]);
  });

  it('a plan that closed in the meantime takes its card away and opens nothing', async () => {
    const closed = Object.assign(new Error('This plan is no longer open'), { status: 409 });
    const h = buildAccept({ invite: PREVIEW, acceptRejects: closed });
    await h.handler(41);
    expect(h.pending).toEqual([]);
    expect(h.calls.screens).toEqual([]);
    expect(h.calls.accepting).toEqual([41, null]);
  });

  it('re-joining a declined plan holds and lands the same way', () => {
    const source = liftCallback('handleRejoinDeclinedFlock');
    expect(source).toContain('if (acceptingInviteRef.current != null) return;');
    expect(source).toContain('setAcceptingInviteId(flockId);');
    expect(source).toMatch(/await loadFlocks\(\);\s+if \(from\) openChatAfterJoin\(flockId, from\);/);
    expect(source).toMatch(/finally \{\s+acceptingInviteRef\.current = null;\s+setAcceptingInviteId\(null\);/);
  });

  it('the invite LINK still opens through inviteHandoff, not through the card\'s callback', () => {
    // A local named openJoinedFlock inside the component would shadow the
    // import of the same name, so loadFlocks's `openJoinedFlock(invite)` for a
    // redeemed invite link would call the card's two-argument callback
    // instead. The build's unused-import warning is the only other thing that
    // notices, so nothing in App.js may declare that name.
    expect(APP).toMatch(/import \{[^}]*\bopenJoinedFlock\b[^}]*\} from '\.\/services\/inviteHandoff';/);
    expect(APP).not.toMatch(/const openJoinedFlock\b/);
    expect(APP).toMatch(/\n\s+openJoinedFlock\(invite\);/);
  });
});
