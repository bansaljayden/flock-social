/**
 * THE LOCATION CHASE AND THE STAND-DOWN, DRIVEN.
 *
 * An SOS pressed indoors goes out with no position, and the app keeps asking
 * the phone for a fix for up to 45 seconds, then posts it as a second alert.
 * Standing the alert down used to leave that chase running, so a fix that
 * landed after "Tell them I'm OK" went out as a new emergency email and a new
 * flock alarm with a map, to everybody who had just been told the person was
 * fine.
 *
 * services/sosFollowUp.js is the chase. These tests drive it with a phone and
 * a server made of promises the test settles by hand, which is the only way to
 * put a stand-down exactly inside the 45 second wait or exactly while the
 * follow-up is on the wire. The server half of the same guarantee (a
 * follow-up naming a withdrawn alert is refused) is
 * backend/__tests__/sosStandDownEndsTheChase.test.js, on a real Postgres.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false sosFollowUpChase
 */
import { createSosFollowUp } from '../services/sosFollowUp';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const FIX = { coords: { latitude: 40.7128, longitude: -74.006, accuracy: 35 } };

// A phone whose next fix arrives when the test says so.
function phone() {
  const waits = [];
  const getPosition = jest.fn(() => {
    const d = deferred();
    waits.push(d);
    return d.promise;
  });
  return { getPosition, land: (i, fix = FIX) => waits[i].resolve(fix) };
}

function handlers() {
  return { onSent: jest.fn(), onWithdrawn: jest.fn(), onFailed: jest.fn() };
}

describe('the stand-down ends the chase', () => {
  it('a fix that lands after the stand-down sends nothing', async () => {
    const p = phone();
    const send = jest.fn(async () => ({ contactsAlerted: 1 }));
    const chase = createSosFollowUp(p.getPosition, send);
    const h = handlers();

    chase.start(42, h);
    await flush();
    expect(p.getPosition).toHaveBeenCalledTimes(1); // waiting on the phone

    chase.cancel(); // "Tell them I'm OK"
    p.land(0); // the fix arrives 20 seconds later anyway
    await flush();

    expect(send).not.toHaveBeenCalled();
    expect(h.onSent).not.toHaveBeenCalled();
    expect(h.onFailed).not.toHaveBeenCalled();
  });

  it('with nothing to wait for, settled() resolves at once', async () => {
    const chase = createSosFollowUp(phone().getPosition, jest.fn());
    let done = false;
    chase.settled().then(() => { done = true; });
    await flush();
    expect(done).toBe(true);
  });

  it('a follow-up already on the wire lands BEFORE the stand-down, and is not announced after it', async () => {
    // A request cannot be recalled. The stand-down waits for it, so the
    // server counts it among the alerts it withdraws instead of receiving it
    // after the all-clear.
    const p = phone();
    const wire = deferred();
    const server = [];
    const send = jest.fn((body) => { server.push({ kind: 'follow-up', body }); return wire.promise; });
    const chase = createSosFollowUp(p.getPosition, send);
    const h = handlers();

    chase.start(42, h);
    p.land(0);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    // The stand-down, as App.js runs it: end the chase, wait, then send.
    const standDown = (async () => {
      chase.cancel();
      await chase.settled();
      server.push({ kind: 'stand-down' });
    })();
    await flush();
    expect(server.map((e) => e.kind)).toEqual(['follow-up']); // still waiting

    wire.resolve({ contactsAlerted: 1 });
    await standDown;
    expect(server.map((e) => e.kind)).toEqual(['follow-up', 'stand-down']);
    // The person has said they are OK; "your location has been sent" would be
    // the wrong last word, and the band must not be re-armed by it.
    expect(h.onSent).not.toHaveBeenCalled();
  });
});

describe('the chase itself', () => {
  it('posts the fix the moment it lands, naming the alert it follows', async () => {
    const p = phone();
    const send = jest.fn(async () => ({ contactsAlerted: 2, alertId: 43 }));
    const chase = createSosFollowUp(p.getPosition, send);
    const h = handlers();

    chase.start(42, h);
    p.land(0);
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      latitude: 40.7128, longitude: -74.006, accuracy: 35, includeLocation: true, followUpTo: 42,
    });
    expect(h.onSent).toHaveBeenCalledWith({ contactsAlerted: 2, alertId: 43 });
  });

  it('an alert id the server did not send is left off, rather than sent as nothing', async () => {
    // An older server answered without alertId. The follow-up then goes out
    // untagged, which that server always accepted.
    const p = phone();
    const send = jest.fn(async () => ({}));
    const chase = createSosFollowUp(p.getPosition, send);
    chase.start(undefined, handlers());
    p.land(0);
    await flush();
    expect(send.mock.calls[0][0]).not.toHaveProperty('followUpTo');
  });

  it('no fix, nothing sent', async () => {
    const p = phone();
    const send = jest.fn();
    const chase = createSosFollowUp(p.getPosition, send);
    chase.start(42, handlers());
    p.land(0, { coords: null, denied: false });
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('a fresh press supersedes a chase that is still waiting', async () => {
    const p = phone();
    const send = jest.fn(async () => ({ contactsAlerted: 1 }));
    const chase = createSosFollowUp(p.getPosition, send);

    chase.start(1, handlers());
    chase.start(2, handlers());
    p.land(0); // the first press's fix, late
    await flush();
    expect(send).not.toHaveBeenCalled();

    p.land(1);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].followUpTo).toBe(2);
  });

  it('the server refusing a withdrawn alert is reported as that, not as a failed send', async () => {
    // Stood down from another phone: the server answers { withdrawn: true }
    // and sends nothing. That is not "could not send your location".
    const p = phone();
    const refusal = Object.assign(new Error('You said you are OK'), { status: 409, data: { withdrawn: true } });
    const send = jest.fn(async () => { throw refusal; });
    const chase = createSosFollowUp(p.getPosition, send);
    const h = handlers();
    chase.start(42, h);
    p.land(0);
    await flush();
    expect(h.onWithdrawn).toHaveBeenCalledWith(refusal);
    expect(h.onFailed).not.toHaveBeenCalled();
  });

  it('an ordinary failure is reported as one', async () => {
    const p = phone();
    const failure = Object.assign(new Error('offline'), { isNetworkError: true });
    const send = jest.fn(async () => { throw failure; });
    const chase = createSosFollowUp(p.getPosition, send);
    const h = handlers();
    chase.start(42, h);
    p.land(0);
    await flush();
    expect(h.onFailed).toHaveBeenCalledWith(failure);
    expect(h.onWithdrawn).not.toHaveBeenCalled();
  });

  it('settled() never rejects, even when a handler throws', async () => {
    // The stand-down awaits it; a rejection there would report the stand-down
    // itself as failed.
    const p = phone();
    const send = jest.fn(async () => ({ contactsAlerted: 1 }));
    const chase = createSosFollowUp(p.getPosition, send);
    chase.start(42, { onSent: () => { throw new Error('toast blew up'); } });
    p.land(0);
    await flush();
    await expect(chase.settled()).resolves.toBeUndefined();
  });
});
