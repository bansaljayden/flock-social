/**
 * WHERE A CHAT THREAD LANDS WHEN AN ANSWER ARRIVES (2026-11-03).
 *
 * Two threads print long answers under a short question: Birdie's panel
 * (components/birdie/BirdiePanel.js) and Roost's Ask a question card on the
 * venue dashboard (components/VenueAdvisorChat.js). Both pinned to their end
 * on every change, so an answer taller than the thread arrived with its first
 * line already scrolled out of view above. Filming the LionCage demo caught
 * both: Birdie's answer hidden above four venue cards, and Roost's "Thursday
 * came in 20 points above..." cut under the top edge of the card.
 *
 * Both now land the same way, and these two reads of the laid-out thread are
 * the part they share. Each surface still decides for itself what counts as a
 * question, an answer and a reopen, because the two keep their turns in
 * different shapes.
 */

// Within this of the end, the reader is reading the end, not away from it.
export const THREAD_END_SLACK_PX = 48;

// Where `box` scrolls to put `row`'s top `gap` px below the box's top edge, or
// null when there is no row or when pinned to the end its top would still be
// in view (an answer that fits keeps landing at the end, as before). Read off
// the laid-out rows rather than counted, so everything drawn under the answer
// (Birdie's venue cards, Roost's follow-up chips) counts toward its height.
export function landingTop(box, row, gap = 0) {
  if (!box || !row) return null;
  const top = box.scrollTop + (row.getBoundingClientRect().top - box.getBoundingClientRect().top) - gap;
  const endTop = box.scrollHeight - box.clientHeight;
  return top < endTop - 1 ? Math.max(0, top) : null;
}

// Whether the reader is further from the end than the slack: scrolled away to
// read something on purpose, so an answer arriving now leaves them there.
export function awayFromEnd(box, slack = THREAD_END_SLACK_PX) {
  return box.scrollHeight - box.scrollTop - box.clientHeight > slack;
}
