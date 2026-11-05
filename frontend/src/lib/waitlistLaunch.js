// THE WAITLIST LAUNCH EMAIL, SENT FROM THE ADMIN DASHBOARD.
//
// POST /api/admin/waitlist/announce (backend/routes/admin.js) mails up to 100
// people a call and answers with what happened in that batch. It marks each
// person before it mails them, so nobody gets the email twice: not from two
// calls that overlap, not from a call this device stopped waiting for while
// the server finished it, not from a reload in the middle. It does one batch
// per call, so something has to keep calling until nobody is left. This is
// that loop, and the one place a run is kept.
//
// THE LOOP STOPS on the first of these, and the finished run says which:
//   done       nobody is left (remaining 0, or a call that took nobody);
//   provider   the server stopped early (stopped_early): the mail service
//              left several sends in a row unanswered, which looks like an
//              outage, so the server stopped taking people;
//   refused    a call moved nobody along: everyone it took was turned down
//              and handed back for a later try (failed equal to batch). The
//              next call would take exactly those people again and hear the
//              same answer, so going on would never end. A daily sending limit
//              that is used up looks like this;
//   cap        a ceiling on calls, a backstop well past what the count taken
//              at the start needs;
//   link       409: the email's button would not open the App Store listing;
//   forbidden  403: the server does not take this account as an admin;
//   lost       the request timed out or the connection dropped, so this
//              device cannot know how that batch went. The server finishes it
//              on its own;
//   server     a 5xx, during a batch or before it;
//   error      anything else (an expired session, a 429), in its own words.
// An error is never retried here. services/api.js sends a write exactly once,
// and a batch this device gave up on may still be sending on the server.
//
// ONE RUN AT A TIME FOR THE WHOLE PAGE. The run is kept here rather than in
// the card's state because the card unmounts on a tab switch and the loop has
// to carry on: a card mounted again reads the same run, shows its progress and
// keeps its button off. startWaitlistLaunch refuses while a run is going and
// marks the run as going before its first await, so a second tap that lands
// before React repaints starts nothing.

import { userMessage } from '../services/api';

// The server's batch size (WAITLIST_ANNOUNCE_BATCH in backend/routes/admin.js),
// used here only to size the backstop.
export const WAITLIST_BATCH = 100;
// Calls allowed past the ones the starting count needs: room for people who
// join the list during the run and for batches the mail service partly turned
// down, whose people come round again in the next call.
const SPARE_CALLS = 5;

const IDLE = Object.freeze({ phase: 'idle', id: 0 });
let current = IDLE;
let lastId = 0;
const listeners = new Set();

function publish(next) {
  current = Object.freeze(next);
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch (e) { /* a listener's failure is its own */ }
  }
  return current;
}

// For React.useSyncExternalStore: the same object until the run changes.
export function subscribeWaitlistLaunch(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function readWaitlistLaunch() {
  return current;
}

const whole = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

function stopFor(err) {
  if (err && err.status === 409) return 'link';
  if (err && err.status === 403) return 'forbidden';
  if (err && (err.isTimeout || err.isNetworkError)) return 'lost';
  if (err && Number.isInteger(err.status) && err.status >= 500) return 'server';
  return 'error';
}

// Starts a run. `send` makes one call (sendWaitlistLaunchBatch); `expected` is
// the waiting count the card showed. Returns a promise that settles with the
// finished run and never rejects, or null when a run is already going.
export function startWaitlistLaunch({ send, expected }) {
  if (current.phase === 'running') return null;
  lastId += 1;
  const maxCalls = Math.ceil(Math.max(whole(expected), 1) / WAITLIST_BATCH) + SPARE_CALLS;
  let now = publish({
    phase: 'running',
    id: lastId,
    calls: 0,
    sent: 0,
    suppressed: 0,
    unknown: 0,
    unknownIds: [],
    // How many the latest batch had turned down. Each of them is handed back
    // and comes round again in the next call, so adding them up across calls
    // would count one person once per try.
    failedLast: 0,
    // Who is still waiting, as of the latest answer. Unknown until one lands.
    remaining: null,
    stop: null,
    errorText: null,
  });
  const finish = (stop, extra) => publish({ ...now, ...extra, phase: 'finished', stop });
  const loop = async () => {
    for (;;) {
      let r;
      try {
        // One call at a time, on purpose: each waits for the last.
        // eslint-disable-next-line no-await-in-loop
        r = await send();
      } catch (err) {
        return finish(stopFor(err), { errorText: userMessage(err, null) });
      }
      if (!r || typeof r !== 'object' || r.dry_run !== false) return finish('error');
      const batch = whole(r.batch);
      const failed = whole(r.failed);
      now = {
        ...now,
        calls: now.calls + 1,
        sent: now.sent + whole(r.sent),
        suppressed: now.suppressed + whole(r.suppressed),
        unknown: now.unknown + whole(r.unknown),
        unknownIds: now.unknownIds.concat(Array.isArray(r.unknown_ids) ? r.unknown_ids.filter((id) => Number.isInteger(id)) : []),
        failedLast: failed,
        remaining: Number.isInteger(r.remaining) && r.remaining >= 0 ? r.remaining : now.remaining,
      };
      if (r.stopped_early === true) return finish('provider');
      if (now.remaining === 0 || batch === 0) return finish('done');
      if (batch - failed <= 0) return finish('refused');
      if (now.calls >= maxCalls) return finish('cap');
      now = publish(now);
    }
  };
  return loop().catch(() => finish('error'));
}

// Tests only: back to no run at all.
export function resetWaitlistLaunchForTests() {
  current = IDLE;
}
