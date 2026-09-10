#!/usr/bin/env node
/**
 * Stage the demonstration accounts so the recording opens on a lived-in
 * account instead of empty states: the two review accounts are friends, each
 * has reviewed the venues the Discover flow taps first, and the venue account
 * has a promotion and an event on its dashboard.
 *
 * Everything goes through the public API as the accounts themselves, exactly
 * as a person would do it in the app, and every step is idempotent: a second
 * run finds the friendship, the reviews (the review route is an upsert), the
 * promotion and the event already there and changes nothing.
 *
 * Env: REVIEW_EMAIL_A, REVIEW_EMAIL_B, REVIEW_PASSWORD (the same group the
 * recording workflow already checks), API_URL (default https://api.flockcorp.com).
 *
 * REVIEWS ARE WRITTEN ONLY WHEN THEY STAY PRIVATE. A five-star line this script
 * puts on a real bar is a scripted opinion, and it must not reach real users'
 * ratings. So before any review the script asks /api/auth/me whether both
 * accounts are configured demo accounts (DEMO_USER_IDS on the server, which
 * keeps their reviews out of everyone else's lists and averages). If they are
 * not, it stages the friendship, the plans, the votes, the promotion and the
 * event, and skips every review, unless DEMO_REVIEWS_PUBLIC=1 is set in the
 * workflow's environment as an explicit decision to publish them anyway.
 * Prints what it did; exits 0 on success, 1 on the first hard failure. The
 * caller decides whether that fails a build.
 *
 * The review route requires presence: an accepted membership in a flock at
 * that venue, with at least two accepted members, dated within the last 30
 * days or the next 12 hours. So for each venue A makes a plan for later
 * today, invites B, B joins, and then both review. Those plans are real plans
 * on the accounts, and they are the same three venues the list shows first.
 */
const API = (process.env.API_URL || 'https://api.flockcorp.com').replace(/\/$/, '');

const VENUES = [
  { id: 'ChIJo8Mj5DrGxokRzOysJp3HPrw', name: "Monk's Cafe", address: '264 S 16th St, Philadelphia, PA 19102, USA', plan: "Drinks at Monk's" },
  { id: 'ChIJCQH7WCnGxokRv0FaySC6Tqs', name: 'Down Home Diner', address: 'Reading Terminal Market, 51 N 12th St, Philadelphia, PA 19107, USA', plan: 'Breakfast at Down Home' },
  { id: 'ChIJCQbEvTDGxokRneVcOpxMXDI', name: 'The Dandelion', address: '124 S 18th St, Philadelphia, PA 19103, USA', plan: 'Dinner at The Dandelion' },
];

const REVIEWS = {
  A: [
    'Went with four friends on a Thursday. Belgian beer list is the real deal and the mussels came out fast.',
    'Counter seats, huge pancakes, and the line moves. Best breakfast in the market.',
    'Cozy and loud in a good way. Get the fries. We stayed two hours longer than planned.',
  ],
  B: [
    'Packed by nine on a weekend but worth the wait. Ask for the back room.',
    'Cash only, so plan for it. Scrapple and eggs for the group, nobody complained.',
    'Great for a group of six. The burger is the move.',
  ],
};

// For venues found on the live list, past the three above. Generic on
// purpose: they must read true of any bar or restaurant in the city.
const MORE_REVIEWS = {
  A: [
    'Six of us on a Friday and they found us a table in ten minutes. Good pours, easy to hear each other.',
    'Came for one drink after work and stayed for dinner. The staff never rushed us.',
    'Split everything across the group and nobody grumbled. Solid spot for a first meetup.',
    'Loud, warm, and quick. Exactly what a Thursday needs.',
    'The kind of place where the plan survives. We will be back with more people.',
    'Big group, one bill, no drama. The kitchen kept up.',
    'Sat outside, watched the block go by, ordered too many fries. Worth it.',
  ],
  B: [
    'Good energy without being a scene. Ask for a booth in the back.',
    'Went on a weeknight and it was steady, not slammed. Happy hour is the move.',
    'Friendly bar, fair prices, plenty of room for eight of us.',
    'Reliable. That is rarer than it sounds.',
    'Great for a group that cannot decide. Long menu, fast kitchen.',
    'Got there at nine and it was filling up. Go early or get a reservation.',
    'The one place everyone in the chat agreed on. Says a lot.',
  ],
};

// The Discover list is the search the app itself runs from the recording's
// fixed location, in the server's order; the row the recording taps is
// whichever comes first that night. Build 60 tapped a venue the three fixed
// ones did not cover, and its sheet still said "No reviews yet". So the top
// of that list, as it stands at staging time, is seeded too.
const DISCOVER_QUERY = 'popular restaurants cafes bars fast food';
const DISCOVER_LOCATION = '39.9526,-75.1652';
const DISCOVER_TOP = 10;

async function discoverTop(user) {
  const r = await api('GET', `/api/venues/search?query=${encodeURIComponent(DISCOVER_QUERY)}&location=${encodeURIComponent(DISCOVER_LOCATION)}`, user.token);
  const venues = (r.data && r.data.venues) || [];
  console.log(`discover: ${r.status}, ${venues.length} venue(s); top ${DISCOVER_TOP}: ${venues.slice(0, DISCOVER_TOP).map((v) => v.name).join(' | ')}`);
  return venues.slice(0, DISCOVER_TOP)
    .filter((v) => v.place_id && v.name)
    .map((v) => ({ id: v.place_id, name: v.name, address: v.formatted_address || v.address || '', plan: `Night out at ${v.name}` }));
}

function need(name) {
  // Trimmed, like the recording step trims the same three values before
  // handing them to Maestro: a secure variable pasted into Codemagic can carry
  // a trailing newline, and the login route compares the password byte for
  // byte. Build 57's staging log was one 401 for exactly that reason.
  const v = (process.env[name] || '').trim();
  if (!v) {
    console.error(`seed-demo: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

async function login(email, password) {
  const r = await api('POST', '/api/auth/login', null, { email, password });
  if (!r.ok || !r.data || !r.data.token) {
    throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  return { token: r.data.token, id: r.data.user.id, name: r.data.user.name };
}

async function unblockEachOther(a, b) {
  // The friend-request route answers a blocked pair with the same 404 it
  // gives a missing user, on purpose (no block oracle). Build 58's staging
  // log was exactly that 404 for two real accounts, and the review recording
  // has blocked B from A in its compliance shots for weeks. So each side
  // lists its blocks and lifts the one on the other before asking.
  for (const [x, y] of [[a, b], [b, a]]) {
    const list = await api('GET', '/api/blocks', x.token);
    if (!list.ok) throw new Error(`block list for ${x.name}: ${list.status}`);
    const blocked = (list.data && list.data.blocked) || [];
    if (blocked.some((u) => u.user_id === y.id)) {
      const r = await api('DELETE', `/api/blocks/${y.id}`, x.token);
      console.log(`blocks: ${x.name} had blocked ${y.name}; unblock: ${r.status}`);
    } else {
      console.log(`blocks: ${x.name} has no block on ${y.name} (${blocked.length} blocked in all)`);
    }
  }
}

// Both accounts must be configured demo accounts on the server, or the
// workflow must say in so many words that public scripted reviews are wanted.
async function reviewsMayBeWritten(a, b) {
  const flags = [];
  for (const u of [a, b]) {
    const me = await api('GET', '/api/auth/me', u.token);
    if (!me.ok) throw new Error(`/api/auth/me for ${u.name}: ${me.status}`);
    flags.push(Boolean(me.data && me.data.user && me.data.user.demo_account));
  }
  if (flags.every(Boolean)) {
    console.log('reviews: both accounts are configured demo accounts; their reviews stay out of other users\' view');
    return true;
  }
  if ((process.env.DEMO_REVIEWS_PUBLIC || '').trim() === '1') {
    console.log('reviews: DEMO_REVIEWS_PUBLIC=1, so scripted reviews are written even though real users will see them');
    return true;
  }
  console.log('reviews: SKIPPED. Neither DEMO_USER_IDS on the server names both accounts nor DEMO_REVIEWS_PUBLIC=1 is set,');
  console.log('reviews: so no scripted review is written where real users would count it. Friends, plans, votes, promotion and event still run.');
  return false;
}

async function befriend(a, b) {
  const list = await api('GET', '/api/friends', a.token);
  if (!list.ok) throw new Error(`friends list: ${list.status}`);
  const already = Array.isArray(list.data) ? list.data.some((f) => f.id === b.id)
    : Array.isArray(list.data && list.data.friends) ? list.data.friends.some((f) => f.id === b.id) : false;
  if (already) {
    console.log(`friends: ${a.name} and ${b.name} already friends`);
    return true;
  }
  const req = await api('POST', '/api/friends/request', a.token, { user_id: b.id });
  console.log(`friends: request ${a.name} -> ${b.name}: ${req.status} ${JSON.stringify(req.data)}`);
  if (req.ok && req.data && req.data.status === 'accepted') return true;
  const acc = await api('POST', '/api/friends/accept', b.token, { user_id: a.id });
  console.log(`friends: accept by ${b.name}: ${acc.status} ${JSON.stringify(acc.data)}`);
  if (!acc.ok) {
    // A request that went out but was never accepted is a pending row, not a
    // friendship: the invite sheet would still show nobody.
    console.log('friends: NOT established; the plans and reviews are still attempted, and the venue side does not depend on it');
    return false;
  }
  return true;
}

const HOUR = 3600 * 1000;
// The review route counts a plan dated within the last 30 days or the next
// 12 hours; the dashboard's incoming list wants one newer than 12 hours ago
// and less than 7 days out. Margins inside both edges.
const REVIEW_WINDOW = { pastMs: 29 * 24 * HOUR, futureMs: 11 * HOUR };
const INCOMING_WINDOW = { pastMs: 11 * HOUR, futureMs: 11 * HOUR };

async function planAt(a, b, venue, window = REVIEW_WINDOW) {
  // A plan for later today at this venue, with B invited and joined. Reused
  // only when it is THIS script's plan (same name, made by A, still open)
  // inside the caller's window; the recording's own "Friday night out" plans
  // and anything else on A's list are left alone. Build 59 reused a
  // recording plan dated two days out and both reviews came back
  // VISIT_REQUIRED; build 60 reused one from a fortnight before.
  // GET /api/flocks returns the newest 300; the demo account has a few dozen
  // plans, so the list is exhaustive in practice. If a matching plan ever fell
  // off it, the worst case is one more plan with the same name, and a join
  // that fails after a create leaves a one-person plan the next run reuses.
  const mine = await api('GET', '/api/flocks', a.token);
  if (!mine.ok) throw new Error(`flock list: ${mine.status}`);
  const flocks = Array.isArray(mine.data) ? mine.data : (mine.data && mine.data.flocks) || [];
  const now = Date.now();
  const inWindow = (f) => {
    const t = f.event_time ? Date.parse(f.event_time) : NaN;
    return Number.isFinite(t) && t > now - window.pastMs && t < now + window.futureMs;
  };
  const open = (f) => !f.status || f.status === 'planning' || f.status === 'confirmed';
  const madeByA = (f) => f.creator_id == null ? f.is_creator !== false : Number(f.creator_id) === a.id;
  let flock = flocks.find((f) => f.venue_id === venue.id && f.name === venue.plan && madeByA(f) && open(f) && inWindow(f));
  if (!flock) {
    const when = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const created = await api('POST', '/api/flocks', a.token, {
      name: venue.plan,
      venue_name: venue.name,
      venue_address: venue.address,
      venue_id: venue.id,
      event_time: when,
      invited_user_ids: [b.id],
    });
    if (!created.ok) {
      throw new Error(`create flock at ${venue.name}: ${created.status} ${JSON.stringify(created.data)}`);
    }
    flock = created.data.flock || created.data;
    console.log(`plan: created "${venue.plan}" (#${flock.id}) for ${when}`);
  } else {
    console.log(`plan: "${flock.name}" (#${flock.id}) already exists at ${venue.name}`);
    const inv = await api('POST', `/api/flocks/${flock.id}/invite`, a.token, { user_ids: [b.id], invited_user_ids: [b.id] });
    console.log(`plan: re-invite ${b.name}: ${inv.status}`);
  }
  const join = await api('POST', `/api/flocks/${flock.id}/join`, b.token);
  console.log(`plan: ${b.name} joins #${flock.id}: ${join.status} ${join.ok ? '' : JSON.stringify(join.data)}`);
  if (!join.ok) {
    // The review route needs two ACCEPTED members; without the join the
    // reviews below would fail one by one for a reason that sits here.
    throw new Error(`${b.name} could not join #${flock.id}: ${join.status} ${JSON.stringify(join.data)}`);
  }
  return flock;
}

// A small stable hash, so the same venue always draws the same line from a
// pool whatever position it holds in the search that night.
function pick(pool, key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

async function alreadyReviewed(user, venue) {
  // Walks every page (the public list is newest first, fifty a page, with a
  // `before` cursor), and a read that fails is an error rather than "absent":
  // absent is what leads to a write. A review a moderator hid is not listed
  // and would be upserted with identical text; the upsert does not touch
  // is_hidden, so it stays hidden.
  let before = '';
  for (let page = 0; page < 40; page += 1) {
    const q = `limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const r = await api('GET', `/api/venue-dashboard/public-reviews/${encodeURIComponent(venue.id)}?${q}`, user.token);
    if (!r.ok) throw new Error(`reviews of ${venue.name}: ${r.status}`);
    const list = (r.data && r.data.reviews) || [];
    if (list.some((x) => Number(x.user_id) === user.id)) return true;
    if (!r.data || !r.data.hasMore || !r.data.nextBefore) return false;
    before = r.data.nextBefore;
  }
  // Forty pages is two thousand reviews. Past that the answer is unknown, and
  // unknown must not become "absent", because absent is what leads to a write.
  throw new Error(`reviews of ${venue.name}: more than 2000, could not confirm ${user.name}'s`);
}

// Reviews first: a venue both accounts have already reviewed needs no plan,
// so a later run touches nothing there. Returns how many reviews stand, or
// null when reviews are not allowed: the plan is still made, because the
// plans are what make the Nest look lived in, and only the reviews wait.
async function stage(a, b, venue, textA, textB, reviewsAllowed) {
  if (!reviewsAllowed) {
    await planAt(a, b, venue);
    return null;
  }
  const haveA = await alreadyReviewed(a, venue);
  const haveB = await alreadyReviewed(b, venue);
  if (haveA && haveB) {
    console.log(`review: both already on ${venue.name}; nothing to stage`);
    return 2;
  }
  await planAt(a, b, venue);
  let n = 0;
  if (haveA || await review(a, venue, textA)) n += 1;
  if (haveB || await review(b, venue, textB)) n += 1;
  return n;
}

async function review(user, venue, text) {
  if (await alreadyReviewed(user, venue)) {
    console.log(`review: ${user.name} on ${venue.name}: already there, left as is`);
    return true;
  }
  const r = await api('POST', '/api/venue-dashboard/submit-review', user.token, {
    googlePlaceId: venue.id,
    rating: 5,
    text,
  });
  console.log(`review: ${user.name} on ${venue.name}: ${r.status} ${r.ok ? '' : JSON.stringify(r.data)}`);
  return r.ok;
}

async function ownVenue(a, b, reviewsAllowed) {
  const prof = await api('GET', '/api/venue-profile', b.token);
  const p = prof.data || {};
  const placeId = p.google_place_id;
  if (!prof.ok || !placeId) {
    console.log(`own venue: ${b.name} has no claimed place id (${prof.status}); skipped`);
    return;
  }
  const venue = {
    id: placeId,
    name: p.business_name || p.venue_name || p.name || 'the venue',
    address: p.address || p.venue_address || '',
    plan: `Drinks at ${p.business_name || p.venue_name || p.name || 'the venue'}`,
  };
  const flock = await planAt(a, b, venue, INCOMING_WINDOW);
  for (const u of [a, b]) {
    const v = await api('POST', `/api/flocks/${flock.id}/vote`, u.token, { venue_name: venue.name, venue_id: venue.id });
    console.log(`own venue: ${u.name} votes ${venue.name} in #${flock.id}: ${v.status} ${v.ok ? '' : JSON.stringify(v.data)}`);
    if (!v.ok) throw new Error(`${u.name}'s vote for ${venue.name} failed: ${v.status}`);
  }
  if (!reviewsAllowed) {
    console.log(`own venue: review of ${venue.name} skipped (see the reviews line above)`);
    return;
  }
  if (!(await review(a, venue, 'Went with a group of five on a weeknight. Good pours, fair prices, and the owner came by to check on us.'))) {
    throw new Error(`review of ${venue.name} failed`);
  }
}

async function venueSide(b) {
  const promos = await api('GET', '/api/venue-dashboard/promotions', b.token);
  if (!promos.ok) throw new Error(`promotions list: ${promos.status}`);
  const plist = Array.isArray(promos.data) ? promos.data : (promos.data && promos.data.promotions) || [];
  if (plist.length === 0) {
    const r = await api('POST', '/api/venue-dashboard/promotions', b.token, {
      title: 'Happy hour, two-for-one drafts',
      description: 'Every draft on the board, buy one get one, before the dinner rush.',
      timeSlot: '5 PM to 7 PM',
      days: 'Tuesday to Thursday',
    });
    console.log(`venue: promotion: ${r.status} ${r.ok ? '' : JSON.stringify(r.data)}`);
    if (!r.ok) throw new Error(`promotion: ${r.status}`);
  } else {
    console.log(`venue: ${plist.length} promotion(s) already there`);
  }
  const events = await api('GET', '/api/venue-dashboard/events', b.token);
  if (!events.ok) throw new Error(`events list: ${events.status}`);
  const elist = Array.isArray(events.data) ? events.data : (events.data && events.data.events) || [];
  if (elist.length === 0) {
    const d = new Date();
    d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7)); // next Thursday
    const r = await api('POST', '/api/venue-dashboard/events', b.token, {
      title: 'Trivia night',
      eventDate: d.toISOString().slice(0, 10),
      eventTime: '8 PM',
      capacity: 60,
    });
    console.log(`venue: event: ${r.status} ${r.ok ? '' : JSON.stringify(r.data)}`);
    if (!r.ok) throw new Error(`event: ${r.status}`);
  } else {
    console.log(`venue: ${elist.length} event(s) already there`);
  }
}

(async () => {
  const emailA = need('REVIEW_EMAIL_A');
  const emailB = need('REVIEW_EMAIL_B');
  const password = need('REVIEW_PASSWORD');
  console.log(`seed-demo: API ${API}`);
  const a = await login(emailA, password);
  const b = await login(emailB, password);
  console.log(`seed-demo: signed in as ${a.name} (#${a.id}) and ${b.name} (#${b.id})`);

  await unblockEachOther(a, b);
  const friends = await befriend(a, b);
  const reviewsAllowed = await reviewsMayBeWritten(a, b);

  let reviews = 0;
  let failures = friends ? 0 : 1;
  for (let i = 0; i < VENUES.length; i += 1) {
    const venue = VENUES[i];
    try {
      const n = await stage(a, b, venue, REVIEWS.A[i], REVIEWS.B[i], reviewsAllowed);
      if (n !== null) { reviews += n; failures += 2 - n; }
    } catch (e) {
      failures += 1;
      console.log(`plan: ${venue.name}: ${e.message}`);
    }
  }
  let top = [];
  try {
    top = await discoverTop(a);
  } catch (e) {
    failures += 1;
    console.log(`discover: ${e.message}`);
  }
  const fixed = new Set(VENUES.map((v) => v.id));
  for (const venue of top) {
    if (fixed.has(venue.id)) continue;
    try {
      const n = await stage(a, b, venue, pick(MORE_REVIEWS.A, venue.id), pick(MORE_REVIEWS.B, 'b:' + venue.id), reviewsAllowed);
      if (n !== null) { reviews += n; failures += 2 - n; }
    } catch (e) {
      failures += 1;
      console.log(`plan: ${venue.name}: ${e.message}`);
    }
  }
  // The venue account's own venue. Its dashboard lists incoming flocks by the
  // venue VOTES that name its place id (not by the flock's own venue), so A
  // makes a plan there, both vote for it, and A reviews it; the owner cannot
  // review their own venue, so B does not try.
  try {
    await ownVenue(a, b, reviewsAllowed);
  } catch (e) {
    failures += 1;
    console.log(`own venue: ${e.message}`);
  }
  // The venue side stands on its own: a promotion and an event show on the
  // dashboard whatever happened above.
  try {
    await venueSide(b);
  } catch (e) {
    failures += 1;
    console.log(`venue: ${e.message}`);
  }
  console.log(`seed-demo: done, ${reviews} review(s) written or refreshed, ${failures} part(s) failed`);
  if (failures > 0) process.exit(1);
})().catch((e) => {
  console.error(`seed-demo: ${e.message}`);
  process.exit(1);
});
