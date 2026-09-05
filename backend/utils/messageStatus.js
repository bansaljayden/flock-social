// ---------------------------------------------------------------------------
// READ RECEIPTS — the one place that turns stored state into the word the
// client draws.
// ---------------------------------------------------------------------------
//
// frontend/src/components/chat/StatusLine.js is the contract, and it is
// deliberately unforgiving: it renders 'sending', 'sent', 'delivered',
// 'opened' and 'failed' and NOTHING for anything else, because "an unknown or
// missing status renders nothing at all rather than falling back to 'Sent'".
// Two of those five never reach the server ('sending' and 'failed' are the
// client's own knowledge of a send still in flight). This module owns the
// other three and answers `null` for every case it cannot back, which the
// client draws as an empty live region rather than as a claim.
//
// WHY BOTH SHAPES LIVE IN ONE FILE. A DM stores its receipts on the message
// row (one recipient, two timestamps) and a flock stores a watermark per
// member (many recipients, one row each). Those are different tables answering
// the same question, and the answer has to be identical or the same person
// reading the same ladder in two threads sees two different products. Both
// transports (routes/messages.js and sockets/handlers.js) import from here
// rather than spelling the ladder twice, which is the same rule the image
// constants in sockets/handlers.js already follow.
//
// DELIVERY IS NOT READING. Nothing in this file infers one from the other in
// the direction that would lie. It DOES infer the safe direction: a message
// somebody opened was necessarily delivered, so `opened` outranks `delivered`
// and the write paths keep the columns consistent with that.

/** The five words StatusLine knows. Exported so a test can pin the set. */
const CLIENT_STATUSES = ['sending', 'sent', 'delivered', 'opened', 'failed'];

/** The three this file may ever produce. */
const SERVER_STATUSES = ['sent', 'delivered', 'opened'];

/**
 * "Opened by Sam and two others" needs the name a person is called, not their
 * full record. StatusLine's own nameList joins whatever it is given, so the
 * trimming happens here where the row is.
 *
 * Defensive about the shape because users.name is free text: a null, a number
 * out of a bad join, or a string of spaces all become null rather than an
 * empty entry in a list the client then renders as ", and".
 */
function firstName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

/**
 * The status of one DM, from the viewer's side.
 *
 * Returns null for a message the viewer did not send: a receipt belongs to the
 * sender and to nobody else, and putting one on an incoming row would tell the
 * recipient about their own reading habits in a field the sender's UI owns.
 */
function dmStatusFor(row, viewerId) {
  if (!row || viewerId == null) return null;
  if (Number(row.sender_id) !== Number(viewerId)) return null;
  if (row.opened_at) return 'opened';
  if (row.delivered_at) return 'delivered';
  // The row exists, so it was stored. That is exactly what 'sent' claims.
  return 'sent';
}

/**
 * Attach `status` to every row of a DM page. Mutates in place, the same way
 * routes/messages.js already attaches `reactions` and `reply_to`.
 */
function attachDmStatus(rows, viewerId) {
  if (!Array.isArray(rows)) return rows;
  for (const row of rows) {
    const status = dmStatusFor(row, viewerId);
    if (status) row.status = status;
  }
  return rows;
}

/**
 * Normalise the roster a flock history read hands to the group ladder.
 *
 * Input is whatever the roster query returned; output is the shape the two
 * functions below rely on, with the watermarks coerced to numbers because
 * node-postgres hands INTEGER back as a number but a fake, a JSON round trip
 * or a COALESCE through a NUMERIC would not, and `'12' >= 9` is false.
 *
 * ALREADY FILTERED WHEN IT GETS HERE. The caller runs the roster query with
 * the viewer's invisible set (utils/blocks.js getInvisibleUserIds, which
 * covers blocks in EITHER direction and banned accounts), because a blocked or
 * banned member must not appear in an "Opened by" list. That filter belongs in
 * SQL next to the query and not in here — this function cannot tell a roster
 * that was filtered from one that was not, so it never pretends to.
 */
function flockRoster(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    userId: Number(r.user_id ?? r.userId),
    name: r.name ?? null,
    lastDeliveredMessageId: Number(r.last_delivered_message_id ?? r.lastDeliveredMessageId ?? 0) || 0,
    lastOpenedMessageId: Number(r.last_opened_message_id ?? r.lastOpenedMessageId ?? 0) || 0,
  })).filter((r) => Number.isInteger(r.userId) && r.userId > 0);
}

/**
 * The status of one flock message, plus who opened it.
 *
 * A member has opened message m when their watermark reaches m.id. This is a
 * comparison over a roster that is already in memory, so a page of fifty
 * messages costs fifty passes over a list bounded by the flock's size and not
 * one extra query — which is the whole reason the group side stores a
 * watermark instead of a row per reader.
 *
 * ANY reader, not every reader, makes it 'opened'. That is what the word means
 * in a group and what StatusLine renders: "Opened by 3", expanding to the
 * names. Requiring all of them would leave a message sitting on "Delivered"
 * because one member never opens the app, which tells the sender nothing.
 */
function flockStatusFor(messageId, roster) {
  const id = Number(messageId);
  if (!Number.isFinite(id)) return { status: null, openedBy: [] };
  const list = Array.isArray(roster) ? roster : [];

  const openers = list.filter((m) => m.lastOpenedMessageId >= id);
  if (openers.length > 0) {
    // The count and the names are the SAME array on the client, so they can
    // never disagree — StatusLine says so in its own comment. Names that
    // cannot be read are dropped, and dropping one would make the two
    // disagree, so the count comes off the filtered list rather than off
    // `openers.length`.
    const openedBy = openers.map((m) => firstName(m.name)).filter(Boolean);
    return { status: 'opened', openedBy };
  }
  if (list.some((m) => m.lastDeliveredMessageId >= id)) {
    return { status: 'delivered', openedBy: [] };
  }
  return { status: 'sent', openedBy: [] };
}

/**
 * Attach `status` and `openedBy` to the viewer's OWN rows on a flock page.
 *
 * Only own rows, for the same reason as the DM twin, and with one extra
 * consequence worth stating: a fifty-row page in a busy flock is mostly other
 * people's messages, so this also keeps the payload from carrying a name list
 * per row that nothing will draw.
 */
function attachFlockStatus(rows, viewerId, roster) {
  if (!Array.isArray(rows)) return rows;
  const list = flockRoster(roster);
  for (const row of rows) {
    if (Number(row.sender_id) !== Number(viewerId)) continue;
    const { status, openedBy } = flockStatusFor(row.id, list);
    if (!status) continue;
    row.status = status;
    // Only when there is something to draw. StatusLine treats an empty
    // openedBy on an 'opened' row as plain "Opened", which is right for a DM
    // and would be a dropped fact in a group, so the two never share a shape
    // by accident: a group with openers always carries the list.
    if (openedBy.length > 0) row.openedBy = openedBy;
  }
  return rows;
}

module.exports = {
  CLIENT_STATUSES,
  SERVER_STATUSES,
  firstName,
  dmStatusFor,
  attachDmStatus,
  flockRoster,
  flockStatusFor,
  attachFlockStatus,
};
