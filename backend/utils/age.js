// Age computation for the server-side age gate (C4). Extracted so the under-13
// boundary logic is unit-testable (node --test). `now` is injectable for
// deterministic tests; production passes the default.
const MIN_AGE = 13;

function ageFromDob(dob, now = new Date()) {
  if (!dob) return null;
  const b = new Date(dob);
  if (isNaN(b.getTime())) return null;
  const ref = now instanceof Date ? now : new Date(now);
  let age = ref.getFullYear() - b.getFullYear();
  const m = ref.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < b.getDate())) age -= 1;
  return age;
}

module.exports = { ageFromDob, MIN_AGE };
