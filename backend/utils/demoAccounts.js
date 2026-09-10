// Demo accounts: the two persistent review accounts the recording workflow
// stages before it films (tools/seed-demo.js). Their plans, votes and reviews
// are real rows, because the recording has to show a lived-in account, but a
// five-star review that a script wrote about a real bar must not shape what
// anyone else sees. DEMO_USER_IDS lists those accounts; a review by one of
// them is left out of every list and every average unless the viewer is one
// of them too, which is exactly the case the recording needs.
//
// Unset, the list is empty and nothing changes. The ids are parsed to
// integers before they reach a query and nothing else is interpolated.

function demoUserIds() {
  const raw = process.env.DEMO_USER_IDS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// A SQL fragment for a query that reads venue_reviews aliased `vr`: empty
// when there are no demo accounts or the viewer is one; otherwise it removes
// their rows. `viewerId` may be null for a read with no viewer (a digest).
function hideDemoReviews(viewerId) {
  const ids = demoUserIds();
  if (ids.length === 0) return '';
  if (viewerId != null && ids.includes(Number(viewerId))) return '';
  return `AND vr.user_id <> ALL(ARRAY[${ids.join(',')}]::int[])`;
}

module.exports = { demoUserIds, hideDemoReviews };
