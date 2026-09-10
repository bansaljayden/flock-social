// Demo accounts: the two persistent review accounts the recording workflow
// stages before it films (tools/seed-demo.js). Their plans, votes and reviews
// are real rows, because the recording has to show a lived-in account, but a
// five-star review that a script wrote about a real bar must not shape what
// anyone else sees. DEMO_USER_IDS lists those accounts; a review by one of
// them is left out of every list and every average unless the viewer is one
// of them too, which is exactly the case the recording needs.
//
// Unset, the list is empty and nothing changes. A token counts only if it is
// a whole decimal number that fits a Postgres int4; "7.5" or "12junk" are
// dropped rather than rounded into somebody else's id, and nothing but those
// integers is ever interpolated.

const INT4_MAX = 2147483647;

function demoUserIds() {
  const raw = process.env.DEMO_USER_IDS;
  if (!raw) return [];
  const ids = [];
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (!/^\d{1,10}$/.test(t)) continue;
    const n = Number(t);
    if (n >= 1 && n <= INT4_MAX && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

// A SQL fragment for a query over venue_reviews aliased `vr`: empty when
// there are no demo accounts or the viewer is one; otherwise it removes their
// rows. `viewerId` may be null for a read with no viewer (a digest).
function hideDemoReviews(viewerId) {
  const ids = demoUserIds();
  if (ids.length === 0) return '';
  if (viewerId != null && ids.includes(Number(viewerId))) return '';
  return `AND vr.user_id <> ALL(ARRAY[${ids.join(',')}]::int[])`;
}

module.exports = { demoUserIds, hideDemoReviews, INT4_MAX };
