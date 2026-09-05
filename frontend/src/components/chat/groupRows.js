/**
 * groupRows: the flat message array, turned into runs.
 *
 * WHAT THIS REPLACES. `screens/ChatDetail.js` and `screens/DmDetail.js` both
 * map straight over their rows and draw one avatar, one name and one timestamp
 * per message, with `daySeparatorFor(rows, idx)` scanning backwards from every
 * index to decide whether to draw a divider. The new stream has no bubbles and
 * no per-message name, so the unit it draws is a RUN: one person's consecutive
 * messages under a single name label with a single coloured bar down their
 * left. This function is the only place that decides where a run starts, so
 * the two screens cannot drift apart.
 *
 * THE RULE, and it is deliberately narrow: a run breaks on a SENDER CHANGE or
 * a DAY BOUNDARY. Nothing else. Not a five minute gap, not an hour, not a
 * message type. The stream reads the way it does because a person who writes
 * four times over an evening is still one voice on the page, and a timer rule
 * chops that into strangers. The test file pins the hour-apart case for
 * exactly that reason.
 *
 * DAYS. A row with no `sentAt` inherits the previous dated row's day, so a
 * failed send or an old cached row can never invent a boundary. That is the
 * rule both screens already use, kept verbatim so dividers do not move when
 * the stream is swapped. The first dated row in a thread opens a day, so
 * history opens with its own date rather than sliding in unlabelled.
 *
 * SYSTEM ROWS. `message_type === 'system'` (migration 066, W4) belongs to
 * nobody, so consecutive system rows collapse into one run flagged `isSystem`,
 * with no sender and no bar, and MessageGroup draws those centred. This is
 * written now rather than later because a system row falling into a person's
 * run would put a plan event under their name in their colour, which is a
 * claim about who said it that the server never made.
 *
 * PURE. No React, no clock read except for the day LABEL, which has to know
 * what "today" means. That one read is a parameter so a test can pin it.
 */

/** Calendar day of an ISO instant, in the reader's own zone. Null when absent or unparseable. */
export function dayKeyOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Today / Yesterday / the weekday / the dated weekday. The same vocabulary the
 * two screens already print, so a thread reads the same after the swap. `now`
 * is a parameter so a test does not have to wait for midnight.
 */
export function dayLabelOf(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** A plan event, a join, an unsend trace. Belongs to the room, not to a person. */
export function isSystemRow(m) {
  return m != null && m.message_type === 'system';
}

/**
 * Who sent this, as a grouping key, for everyone who is not the viewer.
 *
 * `senderId` first, because it is the only stable identity: two members can
 * share a display name, and a rename mid thread must not split a run. The name
 * is the fallback for a row that carries no senderId at all, which is all an
 * older cached row or a guest row ever has.
 *
 * THE VIEWER'S OWN ROWS NEVER COME THROUGH HERE, and that is the whole reason
 * this function is separate from the caller. An optimistic send has no
 * senderId until the server answers, so keying it on identity would put
 * `name:You` next to `id:1` and break a run in half, drawing the viewer's own
 * name and a second coloured bar in the middle of their own paragraph. Every
 * own row is keyed on one constant instead, which is why `mine` is computed
 * BEFORE the key in groupRows and not after it.
 */
function senderKeyOf(m) {
  if (m.senderId != null && m.senderId !== '') return `id:${String(m.senderId)}`;
  return `name:${String(m.sender == null ? '' : m.sender)}`;
}

/**
 * @param {Array} messages the rows a screen already holds, oldest first
 * @param {Object} [options]
 * @param {string|number|null} [options.myId] the viewer's user id
 * @param {string} [options.ownName] what the viewer's own runs are called
 * @param {Date} [options.now] what "today" means, for the day label
 * @returns {Array<{senderId, senderName, isMine, isSystem, firstOfDay, dayLabel, messages}>}
 *
 * `firstOfDay` is the boolean the contract asks for. `dayLabel` carries the
 * words to print and is null unless `firstOfDay` is true, so the renderer never
 * has to ask a second question or reach for a clock of its own.
 */
export function groupRows(messages, options = {}) {
  const { myId = null, ownName = 'You', now } = options;
  const rows = Array.isArray(messages) ? messages : [];
  const runs = [];
  let lastDayKey = null;
  let current = null;

  for (const m of rows) {
    if (m == null) continue;

    const key = dayKeyOf(m.sentAt);
    let opensDay = false;
    if (key !== null) {
      if (lastDayKey === null || key !== lastDayKey) opensDay = true;
      lastDayKey = key;
    }

    const system = isSystemRow(m);
    const mine = !system && (
      m.sender === ownName ||
      (myId != null && m.senderId != null && String(m.senderId) === String(myId))
    );
    /* One key for every own row, in flight or settled. See senderKeyOf: an
       optimistic row has no senderId and a settled one does, and keying those
       two apart is what draws the viewer's name twice mid run. */
    const runKey = system ? 'system' : (mine ? 'me' : senderKeyOf(m));

    if (current === null || current.key !== runKey || opensDay) {
      current = {
        key: runKey,
        senderId: system ? null : (m.senderId == null ? null : m.senderId),
        senderName: system ? null : (mine ? ownName : (m.sender || 'Unknown')),
        isMine: mine,
        isSystem: system,
        firstOfDay: opensDay,
        dayLabel: opensDay ? dayLabelOf(m.sentAt, now || new Date()) : null,
        messages: [m],
      };
      runs.push(current);
    } else {
      current.messages.push(m);
    }
  }

  return runs;
}

export default groupRows;
