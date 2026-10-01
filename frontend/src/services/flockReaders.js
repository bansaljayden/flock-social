/**
 * THE RECEIPT ROSTER A HISTORY READ RETURNS, LIFTED ONTO WHAT THE APP HOLDS.
 *
 * GET /api/flocks/:id/messages answers with `readers`: every other accepted
 * member with their two watermarks. WHO is on that list is the server's call,
 * made against this viewer's blocks, so the list is taken as it comes and a
 * member it leaves out is gone here too. A client that kept a member the
 * answer dropped would be deciding for itself whether it may see them.
 *
 * What the answer can be behind on is the marks. The roster is read on the
 * server and then crosses the network, and a `flock_read` event can land in
 * that gap carrying a newer mark for somebody on it. Taking the answer's mark
 * over the one the app already holds would put that member back a step, and a
 * message they had opened would read "Delivered" until their next event.
 *
 * A mark only ever moves forward on the server (every UPDATE that writes one
 * carries a `<` predicate or a GREATEST), and the live handler in App.js
 * already refuses to move one back, so the higher of the two marks is a claim
 * the server has made. The one row that starts over is a member who left and
 * came back, at zero. The member-left event drops the old row from the
 * app, and when that event was missed (the socket was down through a leave
 * and a rejoin) the seat says so: the server sends each row's seatId, a new
 * membership has a new one, and marks are lifted only across the same seat.
 * A row the app holds without a seat (a live event added it, or an older
 * server sent it) is lifted as before.
 */
const mark = (v) => Number(v) || 0;

export function liftReaders(fresh, held) {
  const list = Array.isArray(fresh) ? fresh : [];
  const known = new Map();
  for (const r of Array.isArray(held) ? held : []) {
    const id = Number(r && r.userId);
    if (Number.isInteger(id) && id > 0) known.set(id, r);
  }
  if (known.size === 0) return list;
  return list.map((r) => {
    const had = known.get(Number(r && r.userId));
    if (!had) return r;
    if (r.seatId != null && had.seatId != null && Number(r.seatId) !== Number(had.seatId)) return r;
    const delivered = Math.max(mark(r.lastDeliveredMessageId), mark(had.lastDeliveredMessageId));
    const opened = Math.max(mark(r.lastOpenedMessageId), mark(had.lastOpenedMessageId));
    if (delivered === mark(r.lastDeliveredMessageId) && opened === mark(r.lastOpenedMessageId)) return r;
    return { ...r, lastDeliveredMessageId: delivered, lastOpenedMessageId: opened };
  });
}
