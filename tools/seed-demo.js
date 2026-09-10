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

async function befriend(a, b) {
  const list = await api('GET', '/api/friends', a.token);
  const already = Array.isArray(list.data) ? list.data.some((f) => f.id === b.id)
    : Array.isArray(list.data && list.data.friends) ? list.data.friends.some((f) => f.id === b.id) : false;
  if (already) {
    console.log(`friends: ${a.name} and ${b.name} already friends`);
    return;
  }
  const req = await api('POST', '/api/friends/request', a.token, { user_id: b.id });
  console.log(`friends: request ${a.name} -> ${b.name}: ${req.status} ${JSON.stringify(req.data)}`);
  const acc = await api('POST', '/api/friends/accept', b.token, { user_id: a.id });
  console.log(`friends: accept by ${b.name}: ${acc.status} ${JSON.stringify(acc.data)}`);
  if (!acc.ok && !req.ok) {
    throw new Error('friendship could not be established');
  }
}

async function planAt(a, b, venue) {
  // A plan for later today at this venue, with B invited and joined. Reused
  // when it already exists on A's list.
  const mine = await api('GET', '/api/flocks', a.token);
  const flocks = Array.isArray(mine.data) ? mine.data : (mine.data && mine.data.flocks) || [];
  let flock = flocks.find((f) => f.venue_id === venue.id && f.status !== 'cancelled');
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
  return flock;
}

async function review(user, venue, text) {
  const r = await api('POST', '/api/venue-dashboard/submit-review', user.token, {
    googlePlaceId: venue.id,
    rating: 5,
    text,
  });
  console.log(`review: ${user.name} on ${venue.name}: ${r.status} ${r.ok ? '' : JSON.stringify(r.data)}`);
  return r.ok;
}

async function venueSide(b) {
  const promos = await api('GET', '/api/venue-dashboard/promotions', b.token);
  const plist = Array.isArray(promos.data) ? promos.data : (promos.data && promos.data.promotions) || [];
  if (plist.length === 0) {
    const r = await api('POST', '/api/venue-dashboard/promotions', b.token, {
      title: 'Happy hour, two-for-one drafts',
      description: 'Every draft on the board, buy one get one, before the dinner rush.',
      timeSlot: '5 PM to 7 PM',
      days: 'Tuesday to Thursday',
    });
    console.log(`venue: promotion: ${r.status} ${r.ok ? '' : JSON.stringify(r.data)}`);
  } else {
    console.log(`venue: ${plist.length} promotion(s) already there`);
  }
  const events = await api('GET', '/api/venue-dashboard/events', b.token);
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

  await befriend(a, b);

  let reviews = 0;
  for (let i = 0; i < VENUES.length; i += 1) {
    const venue = VENUES[i];
    await planAt(a, b, venue);
    if (await review(a, venue, REVIEWS.A[i])) reviews += 1;
    if (await review(b, venue, REVIEWS.B[i])) reviews += 1;
  }
  await venueSide(b);
  console.log(`seed-demo: done, ${reviews} review(s) written or refreshed`);
})().catch((e) => {
  console.error(`seed-demo: ${e.message}`);
  process.exit(1);
});
