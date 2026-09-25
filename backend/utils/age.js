// Age computation for the server-side age gate (C4). Extracted so the under-13
// boundary logic is unit-testable (node --test). `now` is injectable for
// deterministic tests; production passes the default.
const MIN_AGE = 13;

// A date of birth is a CALENDAR date, not an instant. It used to be read with
// `new Date(dob)`, and that is wrong for the string form every caller in
// routes/auth.js actually passes: `new Date('2013-06-16')` is parsed as UTC
// midnight, while getFullYear/getMonth/getDate read it back in the SERVER's
// local zone. West of UTC that lands on June 15, so the account's birthday
// arrives a day early and a 12-year-old is 13 for a day. It is invisible on
// Railway only because Railway runs UTC — a TZ env var, or anyone running the
// gate locally, silently changes who gets in. So parse the calendar fields out
// of the string instead of going through an instant at all.
//
// Only the two shapes routes/auth.js can produce are accepted (its ISO_DATE_RE
// shape check, and express-validator's isISO8601 on /signup): YYYY-MM-DD, with
// an optional time part that is ignored. Anything else — a millisecond number,
// an array, a bare year, 'yesterday' — is null, which every caller already
// treats as "no usable date of birth" and answers with needsDob. That is the
// same fail-closed direction the routes chose, one layer lower down: isISO8601
// accepts '2000' and 'new Date' happily parsed it, and the value then reached a
// DATE column that does not, which is a 500 on a sign-in.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

// { y, m, d } with m 1-12, or null. Rejects dates that do not exist
// (2013-02-30), which `new Date` would have rolled forward into March.
//
// A Date passed as a DATE OF BIRTH is read with the LOCAL getters, and that is
// right rather than an oversight: node-postgres turns a DATE column into a
// Date at local midnight (pg-types builds it with `new Date(y, m, d)`), so the
// local fields are the calendar date that was stored, in any zone. "Today" is
// a different kind of value, an instant, and is read by todayParts below.
function calendarParts(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
  }
  if (typeof value !== 'string') return null;
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(2000, mo - 1, d);
  if (probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  // February 29 exists only in a leap year.
  if (mo === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return null;
  return { y, m: mo, d };
}

// TODAY IS THE UTC CALENDAR DATE OF `now`. It was read with the local getters,
// so the same instant was a different "today" on a server whose TZ differs:
// at 21:00 in New York it is already tomorrow in UTC, and a child whose 13th
// birthday is tomorrow was 12 there and 13 on Railway, which runs UTC. The age
// gate is the server's decision alone (routes/auth.js), so it must not move
// with an environment variable. UTC is the zone production has always used,
// so on Railway nothing changes. A 'YYYY-MM-DD' string is already a calendar
// date and is read as one.
function todayParts(now) {
  if (typeof now === 'string') return calendarParts(now);
  const t = now instanceof Date ? now : new Date(now);
  if (isNaN(t.getTime())) return null;
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// Whole years between `dob` and `now`, or null when there is no usable date of
// birth. The date of birth is a calendar date and today is the UTC date of
// `now`, so the result does not depend on the server's timezone.
function ageFromDob(dob, now = new Date()) {
  if (!dob) return null;
  const b = calendarParts(dob);
  if (!b) return null;
  const ref = todayParts(now);
  if (!ref) return null;
  let age = ref.y - b.y;
  if (ref.m < b.m || (ref.m === b.m && ref.d < b.d)) age -= 1;
  return age;
}

module.exports = { ageFromDob, MIN_AGE };
