/**
 * COMING UP: THE FLOCKS WITH A PLAN HERE, AND WHERE TO PUT THEM.
 *
 * The third section of the Tables tab. One row per flock from
 * GET .../tables/incoming: when, the party size, and whether the plan is
 * confirmed here or still deciding with this venue in the running (the
 * Events tab's words), then the table the server says could seat them: free
 * now, likely free by a time, should be free by now, may not be free in
 * time, or no table that fits yet. Party sizes and times only; the route
 * sends no names and this draws none.
 *
 * The server's window is the last 12 hours to 7 days ahead, so the list is
 * not tonight's: it is read in time order, each row leads with its day
 * ("Today 8:00 PM", "Earlier today 7:00 PM", "Sat 8:00 PM", and with the
 * date from six days out), and the line under the list says the window and
 * whose clock the times are on. An estimate of when a table is up is
 * printed only while it is ahead of the clock and on the plan's own day
 * (suggestionText in lib/venueTables.js).
 *
 * Read once a minute while the tab is open (App.js). The card exists only
 * when there is something on it: most nights at most venues no flock has a
 * plan here, so an empty list draws nothing rather than a card that says so,
 * and while the first read is out nothing is drawn either, since a skeleton
 * would promise a card that mostly never comes. A read that failed with
 * nothing before it is said in one line, like the hours chart, because an
 * absent card reads as "nobody is coming" when the truth is "not loaded";
 * one that failed after a list keeps the list, dimmed, with its age. Times
 * are on the venue's clock when the dashboard has its zone, else this
 * device's, and the line under the list says which.
 */
import React from 'react';
import TablesSection, { STALE_OPACITY, SectionLine, SectionNotice } from './TablesSection';
import { clockIn, clockWords, incomingRows, refreshLines } from '../../../lib/venueTables';

export default function TablesIncoming({ incoming, colors, now, timeZone }) {
  if (incoming === undefined) return null;
  if (incoming === null) {
    return (
      <TablesSection title="Coming up" colors={colors}>
        <SectionLine>Coming up couldn't load.</SectionLine>
      </TablesSection>
    );
  }
  const clock = clockIn(timeZone);
  const rows = incomingRows(incoming, clock, now);
  if (!rows.length) return null;
  const unrefreshed = incoming.unrefreshed === true && Number.isFinite(incoming.readAt);
  const lines = unrefreshed ? refreshLines(incoming.readAt, now, 'the last list') : null;
  return (
    <TablesSection title="Coming up" colors={colors}>
      {/* An owner new to the app has no reason to know the word, the same
          line the Events tab's card opens with. */}
      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 8px', lineHeight: 1.45 }}>
        A flock is a group of friends planning a night out in the Flock app. Each row is a party size and a time, never who.
      </p>
      {lines && <SectionNotice lines={lines} />}
      <ul aria-label="Coming up" data-testid="tables-incoming-live" style={{ listStyle: 'none', margin: 0, padding: 0, opacity: lines ? STALE_OPACITY : 1 }}>
        {rows.map((r, i) => (
          <li key={r.key} data-confirmed={r.confirmed ? 'true' : undefined} style={{ padding: '6px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)', minWidth: 0, overflowWrap: 'anywhere' }}>
            <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-primary)', margin: 0, lineHeight: 1.45 }}>{r.text}</p>
            <p data-testid="incoming-fit" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', lineHeight: 1.45 }}>{r.fit}</p>
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.45 }}>{`Plans from the last 12 hours to 7 days ahead. Times on ${clockWords(clock.venue)}.`}</p>
    </TablesSection>
  );
}
