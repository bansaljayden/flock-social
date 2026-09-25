/*
 * THE LOCATION CHASE BEHIND AN SOS THAT WENT OUT WITHOUT A FIX.
 *
 * Pressed indoors, an SOS goes out after a few seconds with no position, and
 * the app keeps asking the phone for one for up to 45 seconds more. When a fix
 * lands it is posted as a second alert, and the server lets that one through
 * its sixty second floor because the first alert had no location
 * (routes/safety.js, isLocationFollowUp).
 *
 * THE DEFECT THIS FILE EXISTS FOR. Standing the alert down did not end the
 * chase. Somebody who pressed SOS by mistake, tapped "Tell them I'm OK" and
 * put the phone away was still being tracked, and when the fix arrived the
 * app posted it: a new emergency email and a new flock alarm with a map, after
 * every contact and every flockmate had just been told they were OK.
 *
 * So the chase is a small object with three operations, and it lives outside
 * App.js so a test can drive it:
 *
 *   start(alertId, handlers)  begins a chase for that alert. Any chase already
 *                             running is superseded: a fresh press starts over
 *                             rather than stacking.
 *   cancel()                  ends the chase. A fix that lands afterwards is
 *                             dropped, and nothing is sent. This is what the
 *                             stand-down calls first.
 *   settled()                 resolves once a follow-up already on the wire has
 *                             been answered. A request cannot be recalled, so
 *                             the stand-down waits for it and goes out second,
 *                             which puts that follow-up's recipients inside the
 *                             stand-down rather than after it.
 *
 * Every chase carries the id of the alert it follows (followUpTo), and the
 * server refuses a follow-up to an alert that has been withdrawn, from this
 * phone or any other. That refusal comes back as { withdrawn: true } and is
 * handed to onWithdrawn, not reported as a failure.
 *
 * A generation number is what makes cancel() work while the chase is sitting
 * inside a 45 second wait on the phone, where there is no timer to clear and
 * no request to abort: every step checks that its generation is still the
 * current one before it does anything a person would see.
 */
export function createSosFollowUp(getPosition, send) {
  let generation = 0;
  let inFlight = null;

  const cancel = () => {
    generation += 1;
  };

  const start = (alertId, handlers = {}) => {
    generation += 1;
    const mine = generation;
    const current = () => mine === generation;
    // The phone is asked straight away, in this tick, as it always was.
    let position;
    try {
      position = Promise.resolve(getPosition());
    } catch (_) {
      position = Promise.resolve(null);
    }
    return position
      .then((fix) => {
        const coords = fix && fix.coords;
        if (!coords || !current()) return undefined;
        const run = Promise.resolve()
          .then(() => send({
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy,
            includeLocation: true,
            ...(alertId != null ? { followUpTo: alertId } : {}),
          }))
          .then(
            (data) => {
              if (current() && handlers.onSent) handlers.onSent(data);
            },
            (err) => {
              if (!current()) return;
              if (err && err.data && err.data.withdrawn === true) {
                if (handlers.onWithdrawn) handlers.onWithdrawn(err);
              } else if (handlers.onFailed) {
                handlers.onFailed(err);
              }
            },
          )
          // A handler that throws must not leave settled() rejecting, or the
          // stand-down waiting on it would report its own failure instead.
          .catch(() => {});
        inFlight = run;
        return run.then(() => {
          if (inFlight === run) inFlight = null;
        });
      }, () => undefined);
  };

  const settled = () => inFlight || Promise.resolve();

  return { start, cancel, settled };
}
