// When a free limit comes back, in the reader's own clock.
//
// Both meters count in UTC: Birdie's messages by UTC day
// (backend/services/birdieUsage.js) and crowd levels by UTC calendar month
// (backend/services/forecastUsage.js). So the true reset is the next UTC
// midnight, or the next first of the month at UTC midnight, which is the
// evening before across the US. Saying "tomorrow" or "on the 1st" would be
// wrong by several hours for most readers, so these name the local time.

// "at 8:00 PM" when that is still today here, else "tomorrow at 8:00 PM".
// resetsAt, when the server sent one (the 429 that closed Birdie's box), wins.
export function birdieBackText(resetsAt, now = new Date()) {
  const at = resetsAt ? new Date(resetsAt)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  if (!Number.isFinite(at.getTime())) return 'tomorrow';
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? `at ${time}` : `tomorrow at ${time}`;
}

// "on Sep 30 at 8:00 PM": the start of the next UTC month, in local time.
export function forecastBackText(now = new Date()) {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const date = at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `on ${date} at ${time}`;
}
