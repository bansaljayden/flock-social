/**
 * The line over "Hey, {name}" on the Nest: "Friday evening".
 *
 * It replaced a greeting that spun through six lines every three seconds
 * ("What's the move?", "Ready to flock up?" and four more) on a slot-machine
 * animation. Motion that starts by itself pulls the eye whether or not there
 * is anything to see, and on the first screen of the app there was not: the
 * line said nothing that changed. This one says the day and the part of it,
 * and changes only when that does (lib/nestTime.js dayLine and useNow).
 *
 * Its own component so that its once-a-minute look at the clock re-renders
 * this line alone, never the app around it.
 */
import React from 'react';
import { dayLine, useNow } from '../../lib/nestTime';

export default function NestDayLine() {
  const line = useNow(60000, dayLine);
  return (
    <p style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.3 }}>
      {line}
    </p>
  );
}
