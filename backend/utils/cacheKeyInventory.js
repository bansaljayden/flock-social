// ---------------------------------------------------------------------------
// EVERY IN-MEMORY CACHE AND EVERY SPEND COUNTER IN THE BACKEND, AND WHICH PART
// OF EACH KEY THE CALLER GETS TO PICK.
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS. Four security audit rounds each found the same shape of
// bug and each fix corrected the reported instance rather than the class. The
// round-4 report says it plainly:
//
//     "Rounds 2, 3 and 4 have each found a control whose key or whose
//      denominator the caller partly chooses, and each round's fix corrected
//      the reported instance rather than the class. I3-2's fix moved the
//      attacker from one caller-chosen key component to another, and I3-1's fix
//      budgeted one of two routes that answer the same question. A fifth round
//      would be better spent enumerating every cache key and every spend
//      counter in the repo against the 'which part of this can the caller pick'
//      test than re-reading the routes."
//
// This is that enumeration, and the rule behind it, which belongs in
// CONTRIBUTING.md verbatim:
//
//     A CACHE KEY OR A SPEND COUNTER IS A SECURITY CONTROL, AND IT IS ONLY AS
//     GOOD AS THE PART OF THE KEY THE CALLER CANNOT CHOOSE.
//
// The two questions to ask of any new entry, in this order:
//
//   1. WHICH PART OF THE KEY CAN THE CALLER PICK? If the answer is "all of it",
//      the cache is not a control at all — it is an optimisation the caller can
//      switch off at will, and something else has to be the control.
//   2. WHAT DOES A MISS COST? A miss that is free needs nothing. A miss that
//      spends money, a Postgres round trip, an email, a push notification or
//      milliseconds of the only thread needs a budget denominated in THAT, not
//      in requests. Raising the cache size is never the fix: no cache beats an
//      unbounded key space.
//
// Two failure modes fall out of question 2 and both are recorded per entry:
//   * AMPLIFICATION — the caller forces work by missing on purpose.
//   * EVICTION — the caller's misses push real users' entries out, so THEIR
//     next request pays too. A budget that refuses a miss must also refuse the
//     cache WRITE, or it only closes half of it.
//
// HOW TO ADD AN ENTRY. Add the row here in the same change that adds the map.
// __tests__/cacheKeyInventory.test.js fails the build if a module-scope
// `new Map(` or a `createUserBudget(` appears in the swept directories without
// a row, and fails it the other way too if a row here names something that no
// longer exists. Keep `verdict` honest: SAFE means you argued it, not that you
// did not look. The `why` line is what the next audit round checks instead of
// rediscovering.
//
// SCOPE. Module-scope state only. A `new Map()` inside a request handler dies
// with the request and is not a shared control; the scanner deliberately
// ignores indented declarations for that reason. Factory-internal maps (the one
// inside createUserBudget, the ones inside guest.js's counter factories) are
// listed below for completeness but are not scanned, since they are per-factory
// instances rather than module state.
//
// LAST FULL SWEEP: round 5 (this file's creation), reworked in round 23, which
// closed five of its OPEN rows: underageAttempts' clear(), weatherCache's cap,
// badge's missing shape gate / missing bound / missing caller dimension,
// venueCache's cap, and the unauthenticated-door dimension on the Places day
// counter. Entries marked
//   FIXED-THIS-ROUND  were closed in the same change.
//   OPEN              are live findings with an exploit written out; each names
//                     why it was not fixed here.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Entry
 * @property {string} file            path relative to backend/
 * @property {string} name            the identifier the map/budget is bound to
 * @property {'cache'|'counter'|'inflight'|'table'} kind
 * @property {string} key             what the key is built from
 * @property {string} callerControls  which part of that the caller picks
 * @property {string} protects        the scarce resource behind the miss
 * @property {string} denominator     what the counter counts
 * @property {string} bound           max entries and eviction order
 * @property {'SAFE'|'OPEN'|'FIXED-THIS-ROUND'} verdict
 * @property {string} why             one line the next round can check
 */

/** @type {Entry[]} */
const INVENTORY = [
  // ── routes/auth.js ────────────────────────────────────────────────────────
  {
    file: 'routes/auth.js', name: 'loginFailures', kind: 'counter',
    key: 'canonicalEmail(req.body.email)',
    callerControls: 'all of it — unauthenticated body field, canonicalised',
    protects: 'bcrypt CPU + the users lookup, i.e. credential stuffing on one account',
    denominator: 'failed logins (10 / 15 min)',
    bound: '20k keys, low-water 18k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Key space is unbounded but eviction is count-ordered, so displacing a victim\'s locked entry costs ~20k addresses that have each already failed 10 times, through a 10/min per-IP limiter.',
  },
  {
    file: 'routes/auth.js', name: 'oauthTokensUsed', kind: 'counter',
    key: 'ID tokens: sha256 over 11 length-prefixed parts (provider + canonical JWT signature + 9 verified claims). Google access tokens: sha256 of the opaque bearer string, which has exactly one spelling',
    callerControls: 'an ID token entry: nothing, every component is covered by the provider RS256 signature and read after verification. An access token entry: the string, but only one Google accepted at tokeninfo seconds earlier',
    protects: 'OAuth credential replay into a fresh session with a fresh iat (sudo mode)',
    denominator: 'successful sign-ins per unique verified credential',
    bound: '20k keys, soonest-to-expire-first, TTL exp+5min clamped to [60s, 70min]',
    verdict: 'SAFE',
    why: 'Fully provider-derived; flooding it costs 20k real credentials Google or Apple will actually validate, and fresh junk always expires later than the entry it would need to displace. (Round 4 R4-A1 is about WHEN the entry is written, not the key.) Round 5 R5-H2 added the Google access-token branch to it: that branch took no claim at all, so one captured access token minted an unbounded run of sessions each carrying a fresh iat, which is the whole sudo-mode proof for an OAuth account.',
  },
  {
    file: 'routes/auth.js', name: 'oauthNonces', kind: 'counter',
    key: 'the nonce itself, crypto.randomBytes(24)',
    callerControls: 'nothing — server-minted; a caller can only look one up',
    protects: 'in-flight OAuth sign-ins',
    denominator: 'outstanding server-issued nonces',
    bound: '20k keys, soonest-to-expire-first, 10 min TTL',
    verdict: 'SAFE',
    why: '192 bits of server randomness; a caller cannot choose a key, only miss on one.',
  },
  {
    file: 'routes/auth.js', name: 'underageAttempts', kind: 'counter',
    key: "'email:' or 'ip:' + HMAC(pepper, '<label>:' + identity). Three labels, two classes: 'underage:email:<canonicalEmail>' (a PROVED address) and 'underage:email+ip:<canonicalEmail>NUL<req.ip>' (an ASSERTED one) both sit in the 'email:' class; 'underage:ip:<req.ip>' is the 'ip:' class. The class is in plaintext ahead of the digest so eviction can segment on it; the identity is not",
    callerControls: 'the address on an ASSERTED entry, but that entry is scoped to their own source IP. A PROVED entry is address-only and needs a completed sign-in or a provider signature to write',
    protects: 'the COPPA age gate — stops a refused under-13 retrying with a new birthday',
    denominator: 'distinct refused identities (presence + expiry, not a count)',
    bound: '20k keys total, split into two independently-budgeted classes: email 18k/low-water 16.2k, ip 2k/low-water 1k; expire-then-longest-remaining-first WITHIN a class, never across',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Round 23 removed the last surviving wholesale clear() here: 20,001 refused signups with distinct emails wiped every remembered under-13 refusal, IP blocks included, so the age gate on a 13+ service was resettable on demand by an unauthenticated caller. Round 5 (A5-2) then falsified HALF of what round 23 claimed for the replacement. Its eviction sorted one undivided map by longest remaining lifetime and claimed that every write a flooder makes expires LATER than the block they aim at, so the flood evicts itself. TRUE for a single source address (600,000 refusals never reached the victim). FALSE with rotating addresses: one refusal writes TWO entries, and the 15-minute IP entry sorts to the immune end of the shared ordering, so every pass spent its whole budget on email entries while only half that many arrived. The auditor evicted a victim 24-hour email block in 18,009 requests. FIXED by giving the two classes independent budgets: neither can spend a deletion on the other, and within a class every TTL is identical, so longest-remaining-first IS newest-first and a flood is always ahead of anything that predates it in its own eviction order. WHAT IT NOW GUARANTEES, pinned by __tests__/underageFloodSegmentation.test.js at the auditor own scale and past it: no flood, at any address-rotation rate, evicts an entry older than itself, in either class. WHAT IT DOES NOT GUARANTEE, which is the residual and not the finding: a flood holding a class at its ceiling crowds out refusals recorded DURING the flood, because those are the newest entries. That is inherent to a bounded in-heap map, and the fix for it is moving this map to Postgres or Redis rather than another ordering. ROUND 5 (R5-H1) then found the OTHER problem with the email half, which no eviction ordering could have fixed: POST /api/auth/signup wrote a 24-hour block against an address that is nothing but a string in an unauthenticated body, so one request denied any chosen person an account on all three doors, renewably, with no self-service escape. The memory is now split by whether the address was PROVED (a completed sign-in, or a provider-vouched token — a stranger cannot seed one) or merely ASSERTED (scoped to the source IP, so it bites the caller who typed it and nobody else). Residual: an attacker sharing a NAT with their victim can still pin that victim address from that NAT for 24 hours, which is narrower than the 15-minute IP block they could already impose on everyone there.',
  },

  // ── routes/badge.js ───────────────────────────────────────────────────────
  {
    file: 'routes/badge.js', name: 'cache', kind: 'cache',
    key: 'req.params.placeId, now gated by utils/places.js isPlaceIdShaped before anything reads it',
    callerControls: 'all of it, and UNAUTHENTICATED — but only within PLACE_ID_RE',
    protects: 'a paid Google Place Details call, a weather call and an ML prediction, plus one unauthenticated Postgres query per miss',
    denominator: 'cached SVGs; the spend leg is allowGlobalPlacesCall(1) per miss, now under allowBadgeMiss (120/IP/hr, 600/day)',
    bound: 'BADGE_CACHE_MAX 500, low-water 450, expire-then-oldest-first with delete-before-set',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Three things were missing and all three are in now. (1) It was the one paid Places surface with no isPlaceIdShaped check, so any 300-char string bought an unauthenticated Postgres lookup; the shape gate refuses those for free and answers 404, the same answer an unknown venue already gets, so it is not a new oracle. (2) The map had no maxEntries and no sweep at all — the verified-venue set bounded it in practice, which is an argument about the data rather than a bound in the code; it now has the house eviction, and delete-before-set so a refreshed badge is not treated as the oldest. (3) It was the only unauthenticated Places door with NO caller dimension whatsoever, so allowBadgeMiss adds a per-IP hourly gate on the MISS (hits stay free) plus a BADGE_DAILY sub-ceiling pinned BELOW GLOBAL_DAILY.',
  },

  {
    file: 'routes/badge.js', name: 'badgeIpHits', kind: 'counter',
    key: 'req.ip',
    callerControls: 'nothing but the source address',
    protects: 'the badge MISS path — one unauthenticated Postgres query plus a paid Place Details call, on a door with no account to charge',
    denominator: 'badge cache MISSES per address per rolling hour (120), under a 600/UTC-day badge leg',
    bound: '5k addresses, expire-then-least-consumed-first, low-water 4.5k',
    verdict: 'SAFE',
    why: 'Added this round because the badge was the only unauthenticated Places door with no caller dimension at all. Cache hits are free and never counted, so an embed on a busy venue page serves its whole audience off one entry; only the metered miss can be flooded. Least-consumed eviction means a spray of fresh addresses deletes its own one-hit entries before any spent counter, and BADGE_DAILY(600) is pinned by a test below UNAUTH_DAILY(1800), the aggregate ceiling on every door with no account, so the badge can never spend more than a third of the unauthenticated share and never touches the authenticated reserve at all (M5-1).',
  },

  // ── routes/budget.js ──────────────────────────────────────────────────────
  {
    file: 'routes/budget.js', name: 'reminderCooldowns', kind: 'counter',
    key: '`remind:${flockId}`',
    callerControls: 'nothing usable — flockId is bounded by INT4_MAX and the caller must already be a member',
    protects: 'push fan-out to flock members + the members JOIN users query',
    denominator: 'reminder sends per flock (1 / 5 min)',
    bound: '10k entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'Key space is the flocks the authenticated caller actually belongs to, and the cooldown is claimed before the work so a failure still burns the window.',
  },

  // ── routes/checkin.js ─────────────────────────────────────────────────────
  {
    file: 'routes/checkin.js', name: 'tapCache', kind: 'counter',
    key: '`u:${userId}|${placeId}` or `ip:${ip}|${placeId}`',
    callerControls: 'the placeId half (deliberately unvalidated against known venues)',
    protects: 'duplicate checkin rows + the socket fan-out — the concurrency half only',
    denominator: 'last tap timestamp per (identity, place), 30 min window',
    bound: '10k entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'Oldest-first IS the attacker-favourable order here, but the entry an attacker evicts buys exactly one extra check-in row, and tapBudget / anonTapBudget is the real ceiling. The miss is not free (it reaches the INSERT), which is what caps it.',
  },
  {
    file: 'routes/checkin.js', name: 'anonTapBudget', kind: 'counter',
    key: 'String(req.ip)',
    callerControls: 'nothing but the source address',
    protects: 'unbounded checkins rows from anonymous taps',
    denominator: 'anonymous taps per IP per hour (60)',
    bound: '5k IPs, expire-then-least-consumed-first',
    verdict: 'SAFE',
    why: 'IP-keyed so a fresh lane costs a real address, least-consumed eviction means displacing a spent counter costs a flood of IPs that have each already spent an hour, and refundAnonTap stops a DB blip from charging.',
  },
  {
    file: 'routes/checkin.js', name: 'tapBudget', kind: 'counter',
    key: "createUserBudget name:'venue-checkin' — authenticated user id (15/hr, 50/day)",
    callerControls: 'nothing',
    protects: 'checkin rows + attendance marking',
    denominator: 'taps',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Account-keyed; a fresh lane costs a fresh account.',
  },

  // ── routes/crowd.js ───────────────────────────────────────────────────────
  {
    file: 'routes/crowd.js', name: 'crowdCache', kind: 'cache',
    key: '`full:${placeId}:${localHour}:${localDay}` and `alt:${placeId}:...`',
    callerControls: 'placeId (shape-checked by isPlaceIdShaped) and hour/day (parsed then clamped 0-23 / 0-6 BEFORE keying)',
    protects: 'paid Google Places calls (1 for /:placeId, 2 for /alternatives) + ML CPU',
    denominator: 'cached predictions; the spend meter is allowPlacesSearch (30/user/hr)',
    bound: '200 entries shared by both prefixes, expire-then-oldest-first, 10 min TTL',
    verdict: 'SAFE',
    why: 'Per-venue key space is 2 x 24 x 7 = 336 and the venue half is shape-checked, so the key cannot be walked; every miss is charged to the caller\'s own 30/hr Places budget before the call.',
  },

  // ── routes/events.js ──────────────────────────────────────────────────────
  {
    file: 'routes/events.js', name: 'eventCache', kind: 'cache',
    key: 'three prefixes over coarseLoc(toFixed(1)) | searchQuery(slice 40) | radius | category, or a TM_EVENT_ID-matched id',
    callerControls: 'all components, but every one is coarsened, sorted or length-capped first',
    protects: 'paid Ticketmaster calls',
    denominator: 'cached answers AND negative answers (90s negative TTL so one 429 cannot blank a metro)',
    bound: '100 entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'Coarsening bounds the key space, and a miss is metered before the call by the 2000/day global leg plus tmUserBudget (20/hr, 200/day), so cache churn costs the churner their own allowance.',
  },
  {
    file: 'routes/events.js', name: 'inflight', kind: 'inflight',
    key: 'the same cacheKey values as eventCache',
    callerControls: 'same as eventCache',
    protects: 'N concurrent identical requests collapsing to one budget charge and one paid call',
    denominator: 'in-flight promises',
    bound: 'none, but deleted on settle so size <= concurrent request count',
    verdict: 'SAFE',
    why: 'Self-draining: an entry lives only for one upstream call, and creation is gated behind the circuit breaker and both budgets.',
  },
  {
    file: 'routes/events.js', name: 'tmUserBudget', kind: 'counter',
    key: "createUserBudget name:'ticketmaster' — authenticated user id (20/hr, 200/day)",
    callerControls: 'nothing',
    protects: 'paid Ticketmaster, under a 2000/day global leg',
    denominator: 'upstream calls (cost 2 when a query string is present)',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Account-keyed and charged before the call.',
  },

  // ── routes/flocks.js ──────────────────────────────────────────────────────
  {
    file: 'routes/flocks.js', name: 'lastInvitePush', kind: 'counter',
    key: '`${inv.user_id}|flock_invite`',
    callerControls: 'nothing — inv.user_id is DB-derived from rows the route already wrote',
    protects: 'push notifications to the recipient',
    denominator: 'one timestamp per recipient, 30s debounce',
    bound: '20k entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'DB-derived key, claim-before-send, and rolled back when nothing was actually delivered so an undeliverable recipient does not get free suppression.',
  },
  {
    file: 'routes/flocks.js', name: 'rsvpWindows', kind: 'counter',
    key: 'String(flockId) — the flock the joiner just joined',
    callerControls: 'nothing they do not already belong to: the route only reaches this after a membership row transitioned to accepted, so an id the caller cannot join never opens a window',
    protects: 'push notifications to the HOST of a filling flock',
    denominator: 'one open window per flock, first RSVP sent immediately and the rest collapsed into one digest 60s later',
    bound: '5000 windows, oldest closed first (each entry holds a live unrefed timer, so the ceiling bounds timers as well as memory)',
    verdict: 'SAFE',
    why: 'DB-derived key, and a miss makes the app QUIETER rather than louder: the failure mode of losing a window is one extra "X is going" push, never an unbounded fan-out. PER-PROCESS ON PURPOSE, and that is the difference from crowd_alert_sends (migration 007), which had to be durable because its miss RE-SENDS an alert every member already has on their lock screen. Here a second Railway instance splits the RSVPs between two windows, so a ten-person flock costs at most two digests instead of one, against nine before this existed; a Postgres claim row would be a write on every RSVP to save a notification that is already collapsed 80% of the way. If the RSVP rate ever justifies it, the durable version is the crowd_alert_sends shape and the key is the same flock id.',
  },
  {
    file: 'routes/flocks.js', name: 'inviteBudget', kind: 'counter',
    key: "createUserBudget name:'flock-invite' — authenticated user id (25/hr, 60/day)",
    callerControls: 'nothing',
    protects: 'invite spam + push fan-out',
    denominator: 'invites',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Charged before existence is consulted, so it is not an existence oracle either.',
  },

  // ── routes/availability.js ────────────────────────────────────────────────
  {
    file: 'routes/availability.js', name: 'lastPulsePushBySender', kind: 'counter',
    key: 'req.user.id — the authenticated user who just said they are free',
    callerControls: 'nothing: the key is the token subject, not anything in the body',
    protects: 'push notifications to every one of that user\'s friends',
    denominator: 'one "free tonight" push per sender per 6 hours',
    bound: '20k entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'Account-keyed and claimed before the fan-out, so toggling the pulse down/not/down cannot buzz a friends list twice. A miss costs one extra notification per friend, which is why it is per-process and not a Postgres claim row.',
  },
  {
    file: 'routes/availability.js', name: 'lastPulsePushByRecipient', kind: 'counter',
    key: 'friend_id — DB-derived from accepted friendships, never supplied by the caller',
    callerControls: 'nothing; a stranger cannot put themselves in a recipient list they are not a friend on',
    protects: 'the recipient\'s evening, against the fan-IN nobody else bounds',
    denominator: 'one "free tonight" push per RECIPIENT per hour, from anybody',
    bound: '20k entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'This is the ceiling that actually holds: the sender window bounds one person, this bounds the sum of thirty of them, so the first friend to go free buzzes you and the next nine do not. Claimed inside the filter, before the send, so a burst of simultaneous pulses cannot all pass.',
  },

  // ── routes/friends.js ─────────────────────────────────────────────────────
  {
    file: 'routes/friends.js', name: 'friendProbeBudget', kind: 'counter',
    key: "createUserBudget name:'friend-probe' — authenticated user id (20/hr, 60/day)",
    callerControls: 'nothing',
    protects: 'directory enumeration through friend requests + push notifications',
    denominator: 'probes at strangers (existing friendships are free)',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Account-keyed and charged on misses, which is where the enumeration signal lives.',
  },
  {
    file: 'routes/friends.js', name: 'contactSyncBudget', kind: 'counter',
    key: "createUserBudget name:'contact-sync' — authenticated user id (3/hr, 10/day)",
    callerControls: 'nothing',
    protects: 'bulk phone-number to identity resolution',
    denominator: 'sync calls of TWO OR MORE numbers, each after a 200-phone slice',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'The tightest budget in the repo, correctly: it is the highest-yield probe per request. Charged AFTER normalisation, so a batch with no resolvable number in it spends nothing, and on hits and misses alike.',
  },
  {
    file: 'routes/friends.js', name: 'phoneLookupBudget', kind: 'counter',
    key: "createUserBudget name:'phone-lookup' — authenticated user id (20/hr, 60/day)",
    callerControls: 'nothing',
    protects: 'single-number identity resolution ("add this person by their number", and a contact picked one at a time)',
    denominator: 'find-by-phone calls carrying exactly ONE resolvable number',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Split out of contact-sync because one number is the friend probe question asked with a phone number, and it carries the friend probe limits for that reason. It adds NO capacity to an enumerator: 60 single lookups a day is far under the 2,000 numbers a day the bulk lane already permits, so splitting a list into singles is strictly worse for the attacker than sending it as a list.',
  },

  // ── routes/moderation.js ──────────────────────────────────────────────────
  {
    file: 'routes/moderation.js', name: 'reportHourly', kind: 'counter',
    key: 'req.user.id',
    callerControls: 'nothing',
    protects: 'content_reports INSERTs + the moderator alert channel',
    denominator: 'reports per user per hour (10)',
    bound: 'expire-only sweep above 5k; no hard cap',
    verdict: 'SAFE',
    why: 'Key space is registered accounts and the sweep never resets a live counter; the missing hard cap is memory-only and costs an account per entry.',
  },
  {
    file: 'routes/moderation.js', name: 'blockProbeBudget', kind: 'counter',
    key: "createUserBudget name:'block-probe' - authenticated user id (60/hr, 150/day)",
    callerControls: 'nothing',
    protects: 'the user directory through POST /blocks/:userId, which answered "does account N exist" for free',
    denominator: 'blocks aimed at an account the caller has not already blocked (a re-block is free)',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Charged on hits and misses alike, and the exhausted answer is the same 404 body a missing row and a banned row get, so the refusal is not a new oracle. Limits sit above the friend probe on purpose: this is a safety control, and the worst legitimate hour is blocking every stranger in a 50-person link-joined flock.',
  },

  // ── routes/publicCrowd.js ─────────────────────────────────────────────────
  {
    file: 'routes/publicCrowd.js', name: 'ipHits', kind: 'counter',
    key: 'req.ip',
    callerControls: 'nothing but the source address',
    protects: 'paid Google Places + weather on the UNAUTHENTICATED marketing demo',
    denominator: 'requests per IP per hour (20), under a 600/day global leg',
    bound: '5k entries, expire-then-least-consumed-first',
    verdict: 'SAFE',
    why: 'Least-consumed eviction means a flood evicts its own one-hit entries before any spent counter.',
  },
  {
    file: 'routes/publicCrowd.js', name: 'cache', kind: 'cache',
    key: '`area:${lat}:${lng}:${q}:${localDay}:${localHour}` and `venue:${placeId}:${localDay}:${localHour}`',
    callerControls: 'all of it — free-text q (60 chars), coords, and a placeId validated only by isLength({min:1,max:200})',
    protects: 'paid Google Text Search / Place Details + weather',
    denominator: 'cache entries, 20/10 min TTL',
    bound: '500 entries, expire-then-soonest-to-expire-first',
    verdict: 'OPEN',
    why: 'Key space is effectively unbounded and a miss is a paid call, so the cache is not the control — the 20/IP/hr and 600/day counters are, and they hold today. Two residuals: ~30 source addresses spend the whole 600/day global and deny the demo for everyone, and placeId is the one paid Places surface here with no isPlaceIdShaped check, so a 200-char junk id mints a key and a wasted call. NOT FIXED HERE — outside this change\'s permitted files. Fix: add isPlaceIdShaped (free refusal, no charge), and give the global daily leg a per-IP sub-ceiling.',
  },

  // ── routes/safety.js ──────────────────────────────────────────────────────
  {
    file: 'routes/safety.js', name: 'testEmailLog', kind: 'counter',
    key: 'req.user.id',
    callerControls: 'nothing',
    protects: 'outbound Resend email to the account\'s own address',
    denominator: '1 send / 10 min and 3 / 24h per user',
    bound: 'expire-only sweep above 5k',
    verdict: 'SAFE',
    why: 'Account-keyed, and charged AFTER the mailable-address gate so an unmailable account cannot self-throttle.',
  },
  {
    file: 'routes/safety.js', name: 'contactWrites', kind: 'counter',
    key: 'req.user.id',
    callerControls: 'nothing',
    protects: 'outbound Resend mail to ARBITRARY third-party addresses — the relay lever',
    denominator: 'successful contact writes per user per hour (20); deletes not counted',
    bound: '5k keys, expire-then-hard-oldest-first',
    verdict: 'SAFE',
    why: 'Account-keyed, hard-bounded, and charged where the write lands rather than on arrival.',
  },
  {
    file: 'routes/safety.js', name: 'shareCooldowns', kind: 'counter',
    key: 'req.user.id',
    callerControls: 'nothing',
    protects: 'outbound Resend mail to up to 5 trusted contacts per share',
    denominator: 'last-send timestamp, 10 min cooldown',
    bound: '5k keys, expire-then-hard-oldest-insertion-first',
    verdict: 'SAFE',
    why: 'Account-keyed with a refund when no contact was mailable; the oldest-insertion order could evict a heavy sharer early under a 5k-account flood, worth at most one extra share for that user.',
  },
  {
    file: 'routes/safety.js', name: 'cancelWrites', kind: 'counter',
    key: 'req.user.id',
    callerControls: 'nothing',
    protects: 'outbound Resend mail to the trusted contacts who already received an alert',
    denominator: 'stand-down attempts per user per 15 min (3), refunded when none was delivered',
    bound: '5k keys, expire-then-hard-oldest-insertion-first',
    verdict: 'SAFE',
    why: 'Account-keyed, and it cannot reach an address that has not already been mailed an alert: the route refuses unless a delivered alert exists inside the 6h window, and it mails only contacts whose row predates that alert. This is the one meter on the SOS path that is allowed to refuse, because a refused stand-down leaves somebody worried where a refused alert can leave somebody alone.',
  },

  // ── routes/users.js ───────────────────────────────────────────────────────
  {
    file: 'routes/users.js', name: 'cardProbeBudget', kind: 'counter',
    key: "createUserBudget name:'card-probe' — authenticated user id (120/hr, 400/day)",
    callerControls: 'nothing',
    protects: 'the user directory — GET /:id/card answers "who is behind this id"',
    denominator: 'card opens at somebody else (self is free)',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Charged before the query and folded into the existing 404, so the refusal is not a new oracle; round 4 attacked this on body, status, headers, query count and timing and it held.',
  },
  {
    file: 'routes/users.js', name: 'searchProbeBudget', kind: 'counter',
    key: "createUserBudget name:'search-probe' — authenticated user id (90/hr, 300/day)",
    callerControls: 'nothing',
    protects: 'the SAME directory through the other door — GET /search, plus the only leading-wildcard ILIKE in the backend (an unindexable sequential scan of users on the 20-connection primary pool)',
    denominator: 'searches, charged per REQUEST not per row',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'FIXED-THIS-ROUND',
    why: 'R4-I1. Refusal is 200 {users: []}, byte-identical to an ordinary no-matches answer, so it is not a new oracle. Unlike /card the query does NOT run on refusal, because here the query is the metered resource rather than a PK seek.',
  },

  // ── routes/venueDashboard.js ──────────────────────────────────────────────
  {
    file: 'routes/venueDashboard.js', name: 'recentPromotionViews', kind: 'counter',
    key: '`${userId}:${promotionId}`',
    callerControls: 'nothing — both halves are DB-minted integers',
    protects: 'UPDATE venue_promotions.views, i.e. analytics the venue is billed on',
    denominator: 'distinct (user, promotion) view marks per 30 min',
    bound: '20k entries, expire-then-hard-oldest-first',
    verdict: 'SAFE',
    why: 'Neither half can be forged into another user\'s key; the caller only chooses which promotion ids come back, via a shape-validated placeId.',
  },
  {
    file: 'routes/venueDashboard.js', name: 'intelCache', kind: 'cache',
    key: '`intel:${ctx.google_place_id}` / `strip:${ctx.google_place_id}`',
    callerControls: 'indirectly — the owner can relink their own listing',
    protects: 'paid Google Place Details + weather + ML CPU',
    denominator: 'cache entries, 60 min TTL',
    bound: '500 entries, expire-then-hard-oldest-first',
    verdict: 'SAFE',
    why: 'Two keys per venue profile, gated behind requirePremium plus a verified claim, and a relink flood is bounded by the shared Places budget.',
  },

  // ── routes/venueSearch.js ─────────────────────────────────────────────────
  {
    file: 'routes/venueSearch.js', name: 'photoIpHits', kind: 'counter',
    key: 'req.ip',
    callerControls: 'nothing but the source address',
    protects: 'paid Places /media calls on the UNAUTHENTICATED photo proxy',
    denominator: 'cache MISSES per IP per hour (100), under a derived daily brake',
    bound: '5k entries, expire-then-least-consumed-first',
    verdict: 'SAFE',
    why: 'Least-consumed eviction; a flood self-evicts before any real counter. THIS ROW NO LONGER CARRIES THE MONEY. It used to be half of a control that was also trying to be a budget: 300 requests/IP/hour under a PUBLIC_PHOTO_BUDGET of 1500/day, both in heap. 1500 a day is 45,656 a month, which is $311 a month at $7.00 per 1,000, and both counters were destroyed by every deploy, so the day ceiling was reached by re-buying the SAME photos after a restart rather than by real demand, and when it bound, a real person saw a venue card with no picture. The invoice ceiling moved to services/photoStore.js: a real count of billable fetches in Postgres, derived from ONE annual dollar figure, surviving deploys and shared across instances. What is left here is purely an abuse rate, on cache MISSES only, tightened from 300 to 100 because it now sits under a few hundred fetches a day rather than 1500.',
  },
  {
    file: 'routes/venueSearch.js', name: 'photoCache', kind: 'cache',
    key: 'sha256(`${photoRef}|${maxWidth}`)',
    callerControls: 'photoRef, but structurally bounded by PHOTO_REF_RE; maxWidth is snapped to exactly two values; the key is then hashed, so it is 64 bytes whatever arrives',
    protects: 'paid Google metadata call + CDN bytes, and HEAP (it stores raw image buffers)',
    denominator: 'cached BYTES, 30d TTL, only status-200 responses cached',
    bound: '32MB total, 2MB per entry, expire-then-least-recently-used to a 90% low-water mark',
    verdict: 'SAFE',
    why: 'Round 26 applied the fix this row prescribed. The cap was 500 ENTRIES against a full image buffer apiece, so the bytes were unbounded, and single-key eviction let a churn of valid refs push hot photos out one at a time. It is now a byte budget with a per-entry ceiling, a hit re-inserts its key so eviction is least-recently-used rather than FIFO, and eviction runs to a low-water mark so a full cache does not pay the expired-entry scan on every insert. The same round fixed the COST half nobody had filed: the TTL was 1 HOUR on bytes that are immutable by construction: a photo resource name is a handle for one specific photo and Google mints a new name rather than swapping the bytes behind an old one: so a venue card on screen across a day was re-bought roughly 24 times. AND THE LARGER HALF NEITHER ROUND CAUGHT: this map is HEAP, so every Railway deploy threw the whole cache away and re-bought all of it (fifteen deploys in one night on 2026-08-19), which is what was actually reaching the daily cap. It is now L1 in front of a durable L2 in Postgres (services/photoStore.js, migration 046), so a deploy costs nothing. TTL is 30 consecutive calendar days: the Places terms grant that window to latitude and longitude specifically (Maps Service Specific Terms 14.3) and grant photo bytes no caching window at all, so 30 days is the longest window the Places section names for anything rather than an allowance anyone has for this. The clauses are quoted in the photoStore.js header. The key is hashed because the Place Photos reference says a photo NAME cannot be cached. Pinned by __tests__/photoCacheCost.test.js.',
  },
  // ── services/photoStore.js ────────────────────────────────────────────────
  // The durable half of the photo proxy. The CACHE and the LEDGER are Postgres
  // tables (migration 046) and so are deliberately absent from this file, which
  // sweeps module-scope heap structures; the only heap thing here is a log
  // throttle, and it is in the inventory because it is keyed and unbounded-
  // looking, not because it protects money.
  {
    file: 'services/photoStore.js', name: 'lastLoggedAt', kind: 'counter',
    key: "a fixed reason string: 'day-80' | 'day-burst' | 'month-budget'",
    callerControls: 'nothing at all',
    protects: 'the log, not a resource: it keeps a budget refusal to one line an hour instead of one line per refused photo for the rest of the day',
    denominator: 'wall-clock hours per reason',
    bound: 'three keys, by construction',
    verdict: 'SAFE',
    why: 'The key space is a closed set of literals written in this file. No caller input reaches it, so it cannot grow, and nothing is refused on the strength of it, because throttling the log never throttles a request. It is listed because a keyed Map that protects an operator signal is exactly the kind of thing the four audit rounds found unlisted, and because the signal itself matters: a budget that is being reached is information Jayden needs to act on, so the throttle exists to keep that line readable rather than to hide it.',
  },
  {
    file: 'routes/venueSearch.js', name: 'inflight', kind: 'inflight',
    key: '`search:${normalizedQuery}|${coords}` (the `detail:${placeId}` half moved to services/placeDetailsCache.js)',
    callerControls: 'the query text (NFKC-normalised, whitespace-collapsed, lowercased, 80 chars)',
    protects: 'deduplicates concurrent paid Google calls — only the leader charges',
    denominator: 'in-flight promises',
    bound: 'none, deleted on settle',
    verdict: 'SAFE',
    why: 'Self-draining; workers never reject so the cleanup cannot leak.',
  },
  {
    file: 'routes/venueSearch.js', name: 'photoInflight', kind: 'inflight',
    key: 'the same sha256(`${photoRef}|${maxWidth}`)',
    callerControls: 'same as photoCache',
    protects: 'same, and now also the L2 database read: the flight wraps the Postgres lookup as well as the Google call, so N concurrent viewers of one uncached photo are one round trip',
    denominator: 'in-flight promises',
    bound: 'none, deleted on settle',
    verdict: 'SAFE',
    why: 'Self-draining; followers ride free, which is the intended "charge what you spend" reading.',
  },
  {
    file: 'routes/venueSearch.js', name: 'venueCache', kind: 'cache',
    key: '`search:${normalized}|${lat2dp,lng2dp}` (the `detail:${placeId}` half moved to services/placeDetailsCache.js on 2026-08-20, so the duplicate Place Details call the venue detail screen was making could be collapsed onto one shared payload)',
    callerControls: 'the ~80-char free-text query',
    protects: 'paid Places Text Search + Place Details',
    denominator: 'cache entries, 5 min TTL',
    bound: 'VENUE_CACHE_MAX 750, low-water 675, expire-then-oldest-first with delete-before-set',
    verdict: 'FIXED-THIS-ROUND',
    why: 'The key and the eviction ORDER were always fine; the CAP was the weak number — 200 entries against an 80-char free-text key space meant a few hundred unique queries flushed the SHARED cache, and every flushed entry is a fresh paid call the next user makes. Every write here is one allowPlacesSearch unit, so an account\'s writes ARE its Places allowance, which makes the ceiling pinnable as an inequality: PER_USER_HOURLY(30) x 24 = 720 < VENUE_CACHE_MAX(750). One account spending every unit it has, around the clock, still cannot evict the shared working set. Same shape as EVENT_USER_DAILY(400) < EVENT_CACHE_MAX(500), and the test reads PER_USER_HOURLY from placesBudget rather than retyping 30. The 24 is the pessimistic reading (the 5-minute TTL means the real figure is 30) because a TTL is a freshness decision somebody will change.',
  },

  // ── routes/waitlist.js ────────────────────────────────────────────────────
  {
    file: 'routes/waitlist.js', name: 'ipHourly', kind: 'counter',
    key: 'req.ip',
    callerControls: 'nothing but the source address',
    protects: 'the one unauthenticated WRITE in the product: a waitlist INSERT + a Resend confirmation',
    denominator: 'requests per IP per hour (3); a separate 500/day global leg on mail only',
    bound: 'expire-only sweep above 5k; no hard cap',
    verdict: 'SAFE',
    why: 'No forgeable key and the two budgets are correctly separated so the mail ceiling cannot refuse a signup; the missing hard cap is memory-only and counters stay correct.',
  },

  // ── routes/revenuecat.js, utils/sanitize.js — not caches ──────────────────
  {
    file: 'routes/revenuecat.js', name: 'PREMIUM_BY_EVENT', kind: 'table',
    key: 'a file-local literal event-name table',
    callerControls: 'nothing — it is never written at runtime',
    protects: 'n/a',
    denominator: 'n/a',
    bound: 'fixed at module load',
    verdict: 'SAFE',
    why: 'A static lookup table, not a cache: written once at module load, never at runtime, so no key is caller-chosen and there is no miss. Listed so the scanner does not report it as unenumerated.',
  },
  {
    file: 'utils/sanitize.js', name: 'RAW_TEXT_END', kind: 'table',
    key: 'a file-local literal tag table',
    callerControls: 'nothing — never written at runtime',
    protects: 'n/a',
    denominator: 'n/a',
    bound: 'fixed at module load',
    verdict: 'SAFE',
    why: 'A static lookup table, not a cache: it is written once at module load and never at runtime, so there is no key for a caller to choose and no miss to pay for.',
  },

  // ── services/advisorPhrasing.js ──────────────────────────────────────────
  {
    file: 'services/advisorPhrasing.js', name: 'advisorVenueSpend', kind: 'counter',
    key: 'accountKey(req.user.id) + UTC day, behind authenticate AND requireVenueTier(pro)',
    callerControls: 'not the key — the VALUE magnitude only weakly, via which intent chip they tap (the server builds the whole prompt; there is no free-text field)',
    protects: 'paid Gemini for advisor phrasing (50 answers + 150k tokens per venue per day)',
    denominator: 'phrased ANSWERS and TOKENS, charged before the call, never refunded',
    bound: '5k / 4.5k, evict-least-consumed-by-tokens before insert',
    verdict: 'SAFE',
    why: 'Account-keyed, server-sized payloads, and the money leg is not even here: the global daily token wall is the Postgres row advisor_spend (migration 035), which survives deploys and instances, closing the "a brake, not a cap" gap birdieUsage documents in its own global figure.',
  },

  // ── services/birdieUsage.js ───────────────────────────────────────────────
  {
    file: 'services/birdieUsage.js', name: 'userRateLimits', kind: 'counter',
    key: 'accountKey(req.user.id) + UTC day',
    callerControls: 'nothing',
    protects: 'the Birdie turn budget, and indirectly paid Gemini',
    denominator: 'conversation turns (150/day premium, 10 free, 15/min)',
    bound: '20k / 18k, evict-least-consumed before insert',
    verdict: 'SAFE',
    why: 'Account-keyed with a server clock; no caller-varied component.',
  },
  {
    file: 'services/birdieUsage.js', name: 'geminiUserSpend', kind: 'counter',
    key: 'accountKey(req.user.id); global leg on UTC day',
    callerControls: 'not the key — but the VALUE magnitude, via prompt length',
    protects: 'paid Gemini, which is billed per token',
    denominator: 'TOKENS — 1M/user/hr, 4M/user/day, 30M/day global',
    bound: '20k / 18k, least-consumed, evict before insert',
    verdict: 'SAFE',
    why: 'The rare counter denominated in the thing that is actually billed rather than in requests; a longer prompt only ever spends more, and it is charged before the call and settled up on usageMetadata.',
  },

  // ── services/emailService.js ──────────────────────────────────────────────
  {
    file: 'services/emailService.js', name: 'recipientCounts', kind: 'counter',
    key: 'the CATEGORY + the recipient address, lowercased, + a rolling 24h window',
    callerControls: 'the address, on exactly one path: an unauthenticated waitlist signup names its own recipient. Every other sender resolves the address from a database row (the venue owner, the account being verified, a trusted contact, an admin). The category is never caller data: every call site passes a literal.',
    protects: 'Resend, which bills per send, and the sending domain reputation a runaway loop burns',
    denominator: 'messages of one category to one address (300 per 24h), charged before the provider is called. The emergency category is counted and NOT capped.',
    bound: '5k entries, expired-first sweep',
    verdict: 'SAFE',
    why: 'It is a BACKSTOP, not the control: every caller already has its own throttle (waitlist 3/IP/hr + 500/day, moderation 40/hr, reset debounced hourly, digest one marker per venue per week), and this exists to bound the loop that spans two of them or the caller added later with none. Naming your own address only ever spends YOUR OWN allowance, so the one caller-chosen key is a self-denial-of-service and nothing else. TWO CORRECTIONS, round 27. This row used to read "60 per 24h" and justify it with "the busiest legitimate recipient is a moderation address at 40/hr", which is 960 a day: the backstop was an order of magnitude BELOW the ceiling of the caller it was written to back up, so it was cutting the operator inbox off at message sixty-one and dropping every content report, child-safety alert and venue verification claim after it. And this row claimed the ceiling was set so that "it cannot silently swallow an SOS", which was not true of the code: the emergency category bypassed the suppression list and did not bypass this counter, so an SOS alert and, worse, the stand-down that tells a parent it is over, were both eatable by a marketing loop-breaker. Emergency is now uncapped (bounded instead by the five-minute per-user cooldown routes/safety.js holds in Postgres, which survives a deploy as this map does not) and reported when it crosses the number every other category stops at. The key now carries the category, so a flood of one kind of mail to an address can never be the reason a password reset to that same address is refused.',
  },

  {
    file: 'services/emailService.js', name: 'alarmSaid', kind: 'cache',
    key: 'the alarm condition, which for two of the five conditions carries the recipient address, -> the UTC day it last spoke',
    callerControls: 'the address half of the locked-out and emergency-loop keys, on the same single unauthenticated path as recipientCounts (a waitlist signup names its own recipient)',
    protects: 'the reader. It is a dedupe on an ALARM, so a miss costs a repeated log line and a repeated Sentry message, never a send and never a refusal',
    denominator: 'not a counter. One entry per condition, holding a date string',
    bound: '2k entries, stale-first sweep (entries whose day is not today); never cleared wholesale',
    verdict: 'SAFE',
    why: 'This is the only map in this file that cannot refuse anything. Nothing reads it to decide whether a message goes out; it decides whether the log has already said this today, so the worst an attacker gets by flooding distinct keys is an alarm repeated, which is the direction that makes a problem MORE visible rather than less. It is swept stale-first rather than cleared for the rule rather than for the risk. Added in round 27 with the alarm itself: every caller in this codebase fails soft on a mail failure, correctly and independently, and the sum of that was a product where an expired Resend key meant no account could be created, no password could be recovered and no parent was told their child raised an alarm, with nothing on any screen looking wrong and nobody told.',
  },

  // ── services/emailSuppression.js ──────────────────────────────────────────
  {
    file: 'services/emailSuppression.js', name: 'cache', kind: 'cache',
    key: 'the recipient address, lowercased and trimmed',
    callerControls: 'the address, on the same single path as above (a waitlist signup)',
    protects: 'a Postgres round trip per outbound message — the digest sweep asks once per venue in a loop, and the SOS path asks while somebody is in trouble',
    denominator: 'n/a — a read cache, 5 minute TTL',
    bound: '5k entries, expired-first sweep then clear',
    verdict: 'SAFE',
    why: 'A MISS here is a database read, not money and not a security decision, and both outcomes are cached (a null means "checked, not suppressed") so a chosen address cannot be used to force repeated reads. Poisoning it is not possible from outside: the only writer is suppress(), which deletes the key rather than seeding it. Staleness costs at most one more send inside the TTL, in the safe direction.',
  },

  // ── services/forecastUsage.js ─────────────────────────────────────────────
  {
    file: 'services/forecastUsage.js', name: 'usage', kind: 'counter',
    key: 'accountKey(req.user.id) + calendar month',
    callerControls: 'nothing',
    protects: 'nothing upstream — it is the Flock Pro paywall meter for AI forecasts',
    denominator: 'forecast views (10 free per calendar month)',
    bound: 'NO size ceiling; an hourly interval drops previous-month entries',
    verdict: 'SAFE',
    why: 'One entry per authenticated account per month, so growth costs an account each; the only map here with no maxEntries, and it is a paywall meter rather than a security control.',
  },

  // ── services/mlPredictor.js ───────────────────────────────────────────────
  {
    file: 'services/mlPredictor.js', name: 'eventCache', kind: 'cache',
    key: '`${lat.toFixed(3)},${lng.toFixed(3)},${utcHourSlot}`',
    callerControls: 'lat/lng and the timestamp, but routes/crowd.js pre-buckets both coordinates to 2dp (~1.1 km)',
    protects: 'paid Ticketmaster',
    denominator: 'upstream calls; 1500/day global, 200/hr + 400/day per account',
    bound: 'boundedSet at EVENT_CACHE_MAX = 500, delete-then-set, oldest-first',
    verdict: 'SAFE',
    why: 'Rests on the PINNED inequality EVENT_USER_DAILY(400) < EVENT_CACHE_MAX(500): one account cannot write enough entries to flush what everybody else cached. It depends on crowd.js keeping its 2dp bucketing, which a test pins.',
  },
  {
    file: 'services/mlPredictor.js', name: 'eventInflight', kind: 'inflight',
    key: 'the same eventCache key',
    callerControls: 'same',
    protects: 'collapses 20 concurrent batch misses into 1 paid call and 1 charge',
    denominator: 'in-flight promises',
    bound: 'none, deleted in a finally',
    verdict: 'SAFE',
    why: 'Bounded by concurrency; an entry cannot outlive one fetch.',
  },
  {
    file: 'services/mlPredictor.js', name: 'baselineCache', kind: 'cache',
    key: '`${placeId}_${dayOfWeek}_${hour}`',
    callerControls: 'the whole placeId — POST /api/crowd/batch passes v.place_id.slice(0, 256) with NO shape check; mlPredictor now re-imposes utils/places.js isPlaceIdShaped at the lookup instead',
    protects: 'a Postgres ml_venue_baselines lookup on the 20-connection primary pool',
    denominator: 'uncached DB lookups — 1500/hr, 5000/day per account',
    bound: 'boundedSet at PREDICTOR_CACHE_MAX = 2000, 24h TTL',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Found by this round\'s sweep, never reported: 20 venues a request x 3 place-keyed caches was up to 60 forced round trips per request, unmetered, at 3000 req/15min. Now gated by allowVenueLookup — a free shape refusal (a non-shaped id cannot match a row) plus a charged per-account budget, both in front of the query so a refused caller neither queries nor writes.',
  },
  {
    file: 'services/mlPredictor.js', name: 'baselineMissCache', kind: 'cache',
    key: '`${placeId}_${dayOfWeek}_${hour}` — the same key as baselineCache',
    callerControls: 'the whole placeId, same 256-char batch field as baselineCache; '
      + 'the entry is only ever written on a path that already refused or failed',
    protects: 'nothing — it stores no upstream answer, only WHICH of the three '
      + 'reasons getBaseline returned 0, so predictBusyness can tag the refusal '
      + 'as a corpus gap, a budget refusal or a query error instead of reporting '
      + 'all three to the coverage counter as `rule_engine_no_baseline`',
    denominator: 'not a spend surface; it rides alongside the lookups baselineCache meters',
    bound: 'boundedSet at PREDICTOR_CACHE_MAX = 2000, and read behind the same '
      + 'BASELINE_CACHE_TTL so a reason can never outlive the lookup it explains',
    verdict: 'SAFE',
    why: 'A short string per slot, on the same key and the same ceiling as the '
      + 'cache it shadows, so it cannot grow faster than baselineCache does. It '
      + 'is deliberately NOT a field on the baselineCache entry: the refused path '
      + 'must not write a baselineCache entry at all, or an account that cannot '
      + 'query could evict a real venue\'s number.',
  },
  {
    file: 'services/mlPredictor.js', name: 'feedbackCache', kind: 'cache',
    key: 'placeId',
    callerControls: 'all of it, same 256-char batch field',
    protects: 'a Postgres venue_feedback aggregate',
    denominator: 'uncached DB lookups — shares the 1500/hr, 5000/day venue-lookup budget',
    bound: 'boundedSet at 2000, 1h TTL',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Same finding, same gate. Refusal returns the documented noFeedback, which is what a query error already returns.',
  },
  {
    file: 'services/mlPredictor.js', name: 'neighborCache', kind: 'cache',
    key: '`${lat.toFixed(3)}_${lng.toFixed(3)}` — coordinates only',
    callerControls: 'ALL of it. This is the whole point of R4-I2: round 3 removed place_id from the key and what replaced it is just as much the caller\'s number (~648M reachable buckets at crowd.js\'s 2dp rounding).',
    protects: 'a bounding-box RANGE SCAN over ml_venues JOIN ml_venue_baselines on the primary pool',
    denominator: 'uncached ~1 km buckets — 120/hr, 400/day per account',
    bound: 'boundedSet at 2000, 24h TTL',
    verdict: 'FIXED-THIS-ROUND',
    why: 'R4-I2. No part of the key is server-derived, so the cache cannot be the control. In-flight coalescing makes the legitimate 20-venue batch one scan; a per-account budget on MISSES bounds the walk at ~2 scans/min instead of ~4,000. A refused miss writes no entry, which closes the eviction-churn half too. The self-subtraction arithmetic (parity with prepare_features.py add_neighbor_features) is untouched.',
  },
  {
    file: 'services/mlPredictor.js', name: 'selfBaselineCache', kind: 'cache',
    key: 'placeId',
    callerControls: 'all of it, same 256-char batch field',
    protects: 'a Postgres ml_venues JOIN ml_venue_baselines index seek',
    denominator: 'uncached DB lookups — shares the venue-lookup budget',
    bound: 'boundedSet at 2000, 24h TTL',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Same finding, same gate. Refusal returns null, so nothing is subtracted and the neighbour count is one too high rather than wrong in the model\'s favour — the failure direction the file already documents.',
  },
  {
    file: 'services/mlPredictor.js', name: 'neighborInflight', kind: 'inflight',
    key: 'the same neighborCache bucket key',
    callerControls: 'same',
    protects: 'collapses 20 concurrent callers on one bucket into 1 range scan and 1 charge',
    denominator: 'in-flight promises',
    bound: 'none, deleted in a finally',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Added with the R4-I2 fix. Bounded by concurrency; a rejection cannot leave a poisoned key.',
  },
  {
    file: 'services/mlPredictor.js', name: 'eventUserBudget', kind: 'counter',
    key: "createUserBudget name:'crowd-events' — authenticated user id (200/hr, 400/day)",
    callerControls: 'nothing',
    protects: 'paid Ticketmaster',
    denominator: 'upstream calls, charged only on cache misses',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Global ceiling read first, per-account charge second, global increment last, so a globally-refused call never eats a caller unit.',
  },
  {
    file: 'services/mlPredictor.js', name: 'venueLookupBudget', kind: 'counter',
    key: "createUserBudget name:'crowd-venue-lookup' — authenticated user id (1500/hr, 5000/day)",
    callerControls: 'nothing',
    protects: 'the three place-keyed Postgres lookups above',
    denominator: 'uncached DB lookups (a cold venue costs 3)',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Deliberately loose because the unit is a cheap indexed lookup rather than a paid call: the ceiling is set where a real session cannot reach it, and all three refusals degrade to a documented value rather than an error.',
  },
  {
    file: 'services/mlPredictor.js', name: 'neighborUserBudget', kind: 'counter',
    key: "createUserBudget name:'crowd-neighbors' — authenticated user id (120/hr, 400/day)",
    callerControls: 'nothing',
    protects: 'the neighbour range scan',
    denominator: 'uncached ~1 km buckets',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'FIXED-THIS-ROUND',
    why: 'The unit is a bucket, not a request and not a venue, so a batch of 20 venues in one metro costs single digits after coalescing.',
  },

  // ── services/placeDetailsCache.js ─────────────────────────────────────────
  {
    file: 'services/placeDetailsCache.js', name: 'detailsCache', kind: 'cache',
    key: 'placeId, and nothing else',
    callerControls: 'the place id, shape-checked by utils/places.js isPlaceIdShaped ([A-Za-z0-9_-]{6,128}) at every route that reaches this',
    protects: 'the paid Enterprise Place Details SKU, $20 per 1,000 against a 1,000-call monthly free allowance',
    denominator: 'cache entries, 10 min TTL',
    bound: 'PLACE_DETAILS_CACHE_MAX 500, low-water 450, expire-then-oldest-first with delete-before-set',
    verdict: 'FIXED-THIS-ROUND',
    why: 'This map is why the venue detail screen costs ONE Place Details call instead of two. routes/venueSearch.js /details and routes/crowd.js were each buying the same payload for the same place id in the same tick (App.js openVenueDetail fires both in one Promise.allSettled), with the crowd mask a strict subset of the details mask, from two caches that could not see each other. The KEY drops the hour that routes/crowd.js carries on its own full:placeId:localHour:localDay entries: that hour protects the DERIVED PREDICTION, which really does change hour to hour, and never protected the Places payload, which does not — so the old key re-bought an identical response on every hour boundary. The CAP is sized the way VENUE_CACHE_MAX is, against what one account can mint: every write is behind one allowPlacesSearch unit and PER_USER_HOURLY is 30 against a 10-minute TTL, so a single account can hold at most 30 live entries against a ceiling of 500. One caller cannot evict the shared working set. The TTL is bounded by currentOpeningHours.openNow, the only field Google computes at request time; everything else in the payload is immutable or moves over days.',
  },
  {
    file: 'services/placeDetailsCache.js', name: 'detailsInflight', kind: 'inflight',
    key: 'the same placeId',
    callerControls: 'same as detailsCache',
    protects: 'the same paid call, for the CONCURRENT case the cache cannot reach',
    denominator: 'in-flight promises',
    bound: 'none, deleted on settle',
    verdict: 'FIXED-THIS-ROUND',
    why: 'The load-bearing half. The two duplicate requests are simultaneous, so the second one looks at a cache the first has not filled yet — deduplication has to happen on the FLIGHT. The leader charges utils/placesBudget.js and calls Google; every follower rides the same promise for nothing, which is the round-18 reading of "charge what you spend". Self-draining: the worker never rejects, so the cleanup .then() cannot leak, and a FAILED fetch is never written to the cache, so a bad minute is not pinned for a whole TTL.',
  },

  // ── services/pushHelper.js ────────────────────────────────────────────────
  {
    file: 'services/pushHelper.js', name: 'lastPushSent', kind: 'counter',
    key: '`${userId}|${type}|${scope}` where scope is f<flockId> or u<senderId>',
    callerControls: 'the flock/sender half, but only ids the route already authorised',
    protects: 'FCM/APNs sends + the delivery visibility query',
    denominator: 'pushes sent, 30s debounce',
    bound: 'no ceiling; a 5-minute interval drops entries older than 2x the window',
    verdict: 'SAFE',
    why: 'Key space is (recipient x fixed type x one flock or actor the caller already belongs to) and entries live at most 60s, so it cannot be grown.',
  },

  // ── services/weatherService.js ────────────────────────────────────────────
  {
    file: 'services/weatherService.js', name: 'weatherCache', kind: 'cache',
    key: '`${lat.toFixed(2)},${lon.toFixed(2)}`',
    callerControls: 'ALL of it on GET /api/weather, which passes the caller\'s lat/lon straight through',
    protects: 'OpenWeatherMap (free tier, a real 1000/day quota)',
    denominator: 'cache entries; misses charge allowWeatherFetch',
    bound: 'MAX_CACHE_ENTRIES 1000, 30 min TTL, expire-then-oldest-first',
    verdict: 'FIXED-THIS-ROUND',
    why: 'Was R4-I2\'s shape on a different map: ~6.5e8 reachable keys at 0.01 degrees against a 100-entry cache, so about three requests\' worth of fresh coordinates evicted every entry and every other consumer\'s crowd score lost its weather. Bucketing was the first move and it is NOT sufficient on its own: the key was already on the 2dp (~1.1 km) grid publicCrowd and the crowd batch route use, and 2dp still leaves 6.5e8 buckets — coarsening further would buy key space with accuracy the ML feature vector is trained on. What bucketing DID fix is that the rounding is now single-sourced (bucketCoord) instead of three independent toFixed(2) sites, so the key and the coordinate actually sent upstream cannot drift apart. The control is the CAP: every write here follows a charged allowWeatherFetch unit, so the pin WX_DAILY(950) < MAX_CACHE_ENTRIES(1000) means a whole UTC day of paid calls cannot evict one unexpired entry. Same shape as EVENT_USER_DAILY < EVENT_CACHE_MAX.',
  },
  {
    file: 'services/weatherService.js', name: 'wxUserHits', kind: 'counter',
    key: 'Number(userId), refused unless a positive integer',
    callerControls: 'nothing',
    protects: 'OpenWeatherMap',
    denominator: 'upstream fetches (40/rolling hour); global legs 55/min and 950/UTC day',
    bound: '20k / 18k, prune-then-least-consumed-first',
    verdict: 'SAFE',
    why: 'The key is sound; the weakness is COVERAGE, not the key — the crowd, publicCrowd and dashboard call sites pass no userId, so the two global legs carry them with no caller dimension.',
  },
  {
    file: 'services/weatherService.js', name: 'inFlight', kind: 'inflight',
    key: 'the same coordinate string',
    callerControls: 'same as weatherCache',
    protects: 'dedupes concurrent upstream calls',
    denominator: 'in-flight promises',
    bound: 'none, deleted in a finally with an identity check',
    verdict: 'SAFE',
    why: 'Self-draining and bounded by concurrency.',
  },

  // ── utils/ ────────────────────────────────────────────────────────────────
  {
    file: 'utils/blocks.js', name: 'blockCache', kind: 'cache',
    key: 'pairKey(a, b) — the two ids, sorted',
    callerControls: 'half of it: sockets/handlers.js passes (user.id, receiverId) with receiverId straight off the socket payload',
    protects: 'one indexed Postgres user_blocks UNION query',
    denominator: 'cached pair decisions, 30s TTL',
    bound: '5000 entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'The key space is every (me, arbitrary id) pair and 5000 entries flush easily, but the miss is a single indexed lookup on an int pair and the whole surface sits behind the per-USER socket token buckets, which survive reconnect. Amplification is bounded by those buckets; the eviction half costs a real user one extra indexed query. Re-check this if blockCache is ever read from a REST route with a looser limiter.',
  },
  {
    file: 'utils/relationships.js', name: 'relationshipCache', kind: 'cache',
    key: 'relationshipKey(a, b) — the two ids, sorted, both already validated as positive integers',
    callerControls: 'half of it: sockets/handlers.js passes (user.id, receiverId) with receiverId straight off the socket payload, exactly like blockCache above',
    protects: 'one Postgres query, two indexed EXISTS scans over friendships and direct_messages',
    denominator: 'cached connected/not-connected answers, 30s TTL',
    bound: '5000 entries, expire-then-oldest-first',
    verdict: 'SAFE',
    why: 'The twin of blockCache and read at the same call sites, so the same reasoning applies: the key space is every (me, arbitrary id) pair, but a miss is two indexed lookups and every reader sits behind the per-USER socket token buckets, which survive a reconnect. Unreadable ids never reach the cache at all — they are refused before the key is built, so the round 20 defect in utils/blocks.js has no counterpart here. It is a positive cache for a gate whose OTHER half (blocks) is checked first and separately, so a stale entry can only delay a new relationship starting, never keep one alive past a block.',
  },
  {
    file: 'utils/places.js', name: 'knownVenueCache', kind: 'cache',
    key: 'placeId, pre-gated by PLACE_ID_RE',
    callerControls: 'all of it, including from the UNAUTHENTICATED NFC tap',
    protects: 'a 3-way EXISTS over venue_profiles / sensor_devices / ml_venues',
    denominator: 'cached known/unknown answers, 5 min TTL; failures are not cached',
    bound: '5000 entries; expire, then drop known!==true entries oldest-first, then anything',
    verdict: 'SAFE',
    why: 'The negatives-first eviction is the mitigation that makes this work: a spray of fabricated ids evicts its OWN junk before any real venue, so the shared cache cannot be flushed by the attack that fills it. The residual is one indexed query per sprayed id, bounded by anonTapAllowed. This is the pattern the other place-keyed caches should copy.',
  },
  {
    file: 'utils/placesBudget.js', name: 'userHits', kind: 'counter',
    key: 'keyOf(userId) — positive integers only',
    callerControls: 'nothing; cost is a literal at every call site and assertCost throws otherwise',
    protects: 'paid Google Places',
    denominator: 'paid calls (30 per rolling hour per account)',
    bound: '20k / 18k, prune-then-least-consumed-first',
    verdict: 'SAFE',
    why: 'Account-keyed, charged before the call, never clear()ed.',
  },
  {
    file: 'utils/placesBudget.js', name: 'dayCount (global)', kind: 'counter',
    key: 'the UTC date only — no caller dimension at all',
    callerControls: 'nothing about the key; everything about how fast it is spent',
    protects: 'paid Google Places, ~the invoice ceiling (3000/UTC day)',
    denominator: 'paid calls',
    bound: 'reset on UTC date change or process restart',
    verdict: 'OPEN',
    why: 'The file calls this "THE REMAINING HOLE". Round 23 closed the half that could be closed and states plainly why the other half cannot be. A per-ACCOUNT ceiling is not available on a door with no account, so the honest dimension is the source address, and all three unauthenticated doors carry one AND a daily sub-ceiling: publicCrowd 20/IP/hr under 600/day, the photo proxy 300/IP/hr under 1500/day (the leg was 4000 — above the 3000 it was meant to be under, so it never bound), and badge 120/IP/hr under 600/day. Round 5 (M5-1) corrected what those three numbers actually buy: 600 + 1500 + 600 = 2700 is 90% of 3000, which left the authenticated product 300 calls a day, reachable with about 40 addresses — an improvement on the pre-delta state, but not the "cannot starve the signed in product" the commit message claimed. The guarantee now comes from unauthDayCount below rather than from an inequality between three constants in three route files. STILL OPEN, and only for the reason the file gives itself: the counter is in heap, so it resets on every deploy and divides by the instance count, which makes it a brake rather than a cap no matter how well the doors are dimensioned. Fix: move dayCount to Postgres (single row, INSERT ... ON CONFLICT DO UPDATE ... RETURNING), keeping the in-memory counter in front of it as a cheap first gate.',
  },
  {
    file: 'utils/placesBudget.js', name: 'unauthDayCount (global)', kind: 'counter',
    key: 'the UTC date only — no caller dimension, deliberately',
    callerControls: 'nothing about the key; everything about how fast it is spent, from any number of addresses',
    protects: 'the AUTHENTICATED slice of the paid Google Places day — GLOBAL_DAILY minus UNAUTH_DAILY = 1200 calls the signed-in product cannot be flooded out of',
    denominator: 'paid calls made through allowGlobalPlacesCall, which is the only entry point a caller with no account has',
    bound: 'UNAUTH_DAILY = 1800 of GLOBAL_DAILY = 3000; reset on UTC date change or process restart',
    verdict: 'OPEN',
    why: 'Added round 5 for M5-1. Per-door sub-ceilings bound each door but not their SUM, and three constants living in three route files is an invariant maintained by hand — a fourth unauthenticated door added later inherits nothing. This counter is the invariant instead: every door with no account charges it, so the reserve holds however many doors there are and however many addresses they come from. 1800 rather than 1500 because the largest per-door sub-ceiling is the photo proxy at 1500 and a sub-ceiling above the ceiling it sits under never binds, which was round 23 own finding about PUBLIC_PHOTO_BUDGET at 4000; 1800 is the smallest round number that keeps every per-door limit strictly binding, so it is the largest reserve available. OPEN for the same single reason as dayCount above and not for a second one: it is in heap, so it resets on every deploy and divides by the instance count. Fix: it moves to Postgres in the same row as dayCount (a units_unauth column on places_spend), charged in the same INSERT ... ON CONFLICT DO UPDATE ... RETURNING round trip.',
  },
  {
    file: 'utils/visionBudget.js', name: 'dayCount (global)', kind: 'counter',
    key: 'the UTC date only',
    callerControls: 'nothing about the key',
    protects: 'paid Google Cloud Vision SafeSearch ($0.0015/image)',
    denominator: 'billed images (2000/UTC day = $3.00)',
    bound: 'reset on UTC date change',
    verdict: 'OPEN',
    why: 'Round 4 R4-I3, a documented residual rather than an oversight: fail-closed means ~34 cooperating accounts (2000/60) turn off every image upload until 00:00 UTC for about three dollars. Failing open would be worse — it would convert a spend cap into a moderation bypass anyone could buy. Round 23 asked the per-IP question that was asked of the Places leg and answered NO, with the reason: there is no unauthenticated Vision door. allowVisionCall has exactly one caller, utils/moderation.js moderateImage, and its callers are routes/messages.js, routes/stories.js, routes/users.js and sockets/handlers.js — every one of them behind authenticate or a verified socket, every one passing req.user.id, all four under the account-keyed imageSpendLimiter (10/min, mounted once globally so alternating doors cannot buy their sum). A per-IP budget here would be a control with nothing to control: it would refuse nobody the account budget does not already refuse, and adding it would make the row LOOK closed while changing nothing, which is the failure this whole inventory exists to prevent. STILL OPEN, and what is missing is still not a different policy but an alarm. Fix: emit a real alert (Sentry, or the moderation alert channel) when the global leg crosses 80%, rather than a throttled console.error nobody reads, so the denial is noticed on the day it happens instead of through user reports.',
  },
  {
    file: 'utils/visionBudget.js', name: 'userBudget', kind: 'counter',
    key: "createUserBudget name:'vision-safesearch' — authenticated user id (30/hr, 60/day)",
    callerControls: 'nothing; a supplied-but-malformed id is refused, not shared into one bucket',
    protects: 'paid Cloud Vision',
    denominator: 'billed images',
    bound: 'probeBudget: 20k, least-consumed-first',
    verdict: 'SAFE',
    why: 'Order is global-read, user-charge, global-increment, so a globally-refused call never eats a caller unit; VISION_USER_DAILY < VISION_GLOBAL_DAILY is pinned by a test.',
  },
  {
    file: 'utils/probeBudget.js', name: 'entries (factory-internal)', kind: 'counter',
    key: 'keyOf(userId) — positive integers only, per createUserBudget instance',
    callerControls: 'nothing',
    protects: 'whatever the instance is wired to',
    denominator: 'per-instance',
    bound: 'maxEntries 20k, evict to 90%, LEAST-CONSUMED-first',
    verdict: 'SAFE',
    why: 'The shared mechanism every budget above uses. Least-consumed eviction is the load-bearing choice: an attacker spends their allowance and only then floods, so an oldest-first policy would delete exactly the counter they wanted gone.',
  },

  // ── sockets/handlers.js ───────────────────────────────────────────────────
  {
    file: 'sockets/handlers.js', name: 'roomUsers', kind: 'cache',
    key: 'String(flockId) from asId(), inner key socket.id',
    callerControls: 'the flock id, but asId normalises it and a membership query gates the join',
    protects: 'presence memory + broadcast payload size + one membership SELECT per join',
    denominator: 'distinct (flock, socket) presence entries',
    bound: 'no global cap, but 8 sockets/user x 50 rooms/connection, and empty rooms are deleted',
    verdict: 'SAFE',
    why: 'Bounded by real membership and by three composing caps; repeated joins overwrite because the inner key is the socket id.',
  },
  {
    file: 'sockets/handlers.js', name: 'socketBuckets', kind: 'counter',
    key: 'socket.id + event name',
    callerControls: 'socket.id indirectly — a reconnect mints a fresh one, so this bucket IS resettable',
    protects: 'per-connection burst ceiling on every DB write, push and paid Vision call',
    denominator: 'events per socket per window',
    bound: 'deleted wholesale on disconnect',
    verdict: 'SAFE',
    why: 'Exploitable ALONE and correctly backstopped: allowEvent charges this AND userBuckets with an explicit note that && short-circuiting is forbidden, so a free socket id cannot mint a fresh allowance.',
  },
  {
    file: 'sockets/handlers.js', name: 'userBuckets', kind: 'counter',
    key: 'socket.user.id + event name',
    callerControls: 'nothing',
    protects: 'the same resources, across every connection and IP the account holds',
    denominator: 'events per account per window, at 2x the per-socket limit',
    bound: 'expire-only sweep above 5k; deliberately SURVIVES disconnect',
    verdict: 'SAFE',
    why: 'This is the real ceiling — IP rotation and socket churn both fail against it, and outliving the last connection is deliberate and commented.',
  },
  {
    file: 'sockets/handlers.js', name: 'userSockets', kind: 'cache',
    key: 'userId -> Set<socketId>',
    callerControls: 'nothing',
    protects: 'fan-out amplification, and how many rate buckets one account can hold',
    denominator: 'concurrent live sockets per account (8)',
    bound: 'hard cap, evict-oldest-and-disconnect, entry deleted when the set empties',
    verdict: 'SAFE',
    why: 'Hard-capped and self-cleaning; evicting rather than refusing is the right UX direction and does not weaken the cap.',
  },
  {
    file: 'sockets/handlers.js', name: 'relayedNotifications', kind: 'counter',
    key: '`${kind}|${from}|${to}`',
    callerControls: 'the `to` half — the attacker picks who to friend-request',
    protects: 'duplicate push/toast delivery, i.e. notification spam',
    denominator: 'distinct (kind, from, to) triples per 10 min',
    bound: '20k entries; expire, and if still full REFUSE rather than evict (fail-closed)',
    verdict: 'SAFE',
    why: 'The global cap fails globally, which would be a product-wide outage — but RELAY_NEW_KEYS_PER_USER (60/10min, charged only for keys about to be CREATED and riding on userBuckets so a reconnect cannot reset it) puts 20k slots ~334 cooperating accounts away.',
  },

  // ── server.js ─────────────────────────────────────────────────────────────
  {
    file: 'server.js', name: 'moneyWatchSaid', kind: 'counter',
    key: "'<leg>:<level>' — eight fixed strings, four legs x two levels, all literals in this file",
    callerControls: 'nothing. No request path writes to it; only the 15-minute watchdog timer does',
    protects: 'the reader. It is what stops a ceiling that stays exhausted for eight hours raising thirty-two identical alerts',
    denominator: 'one alert per leg per level per UTC day (per calendar month for the photo leg, whose ceiling is a month)',
    bound: 'eight entries, structurally — the key space is the cross product of two literal lists, so it cannot grow',
    verdict: 'SAFE',
    why: 'The only map in the repo whose key space is closed by construction rather than by an eviction policy, because nothing outside this file can produce a key. It holds day strings, not counts, so an entry going stale costs one repeated alert rather than a lost budget; and it is deliberately NOT reset on a deploy the way the counters it watches are — a fresh process starts with an empty map and a zeroed budget, which is the consistent pair.',
  },

  {
    file: 'server.js', name: 'socketConnections', kind: 'counter',
    key: 'socketClientIp(socket) — the LAST X-Forwarded-For hop',
    callerControls: 'nothing — prepended attacker hops are ignored',
    protects: 'WebSocket handshake flood: JWT verify + a token_version DB read',
    denominator: 'new connections per IP per 60s (10)',
    bound: 'expire-only sweep above 10k',
    verdict: 'SAFE',
    why: 'The last hop is what the platform appended, so a client-supplied prefix cannot move the key; rejections are counted before being recorded so a tripped client recovers within the minute.',
  },
  {
    file: 'routes/ai.js', name: 'birdieSearchCache', kind: 'cache',
    key: 'normalised query text + location rounded to 2 decimals (about 1 km)',
    callerControls: 'all of it: the model emits the query and the location from the user turn',
    protects: 'nothing on its own; it is an optimisation in front of the paid Text Search call. The control is allowPlacesSearch, which every MISS still passes through, and a HIT is free so it spends no allowance',
    denominator: 'n/a (not a counter)',
    bound: '500 keys, low-water 450, oldest-first, 5 min TTL',
    verdict: 'SAFE',
    why: 'The caller picks the whole key, so this is an optimisation and not a control, and it is written so that it does not have to be one. A caller who defeats it by varying the query or the coordinates only buys a MISS, and every miss still passes through allowPlacesSearch exactly as it did before the cache existed, so the paid call is metered by the same per-user allowance either way. A HIT is served before that gate on purpose, because it makes no upstream call and spends nothing. The cache therefore cannot be used to spend more than the gate allows, only to spend less (2026-09-01).',
  },
  {
    file: 'routes/ai.js', name: 'birdieSearchInflight', kind: 'cache',
    key: 'same key as birdieSearchCache',
    callerControls: 'all of it',
    protects: 'coalesces identical concurrent misses into one upstream call; entries live only for the duration of one fetch and are deleted in a finally',
    denominator: 'n/a (not a counter)',
    bound: 'one entry per in-flight distinct key; cleared on settle, so it cannot grow past concurrency',
    verdict: 'SAFE',
    why: 'An entry exists only while one upstream fetch for that key is in flight and is deleted in a finally on every exit path, so the map is bounded by concurrent distinct misses rather than by anything the caller can accumulate, and a rejected fetch cannot leave a poisoned promise behind for the next caller to join. A caller who joins an in-flight request gets the same answer the first caller gets, which is the answer Google gave for that exact key.',
  },
];

// ---------------------------------------------------------------------------
// THE RATE LIMITERS, AS DATA RATHER THAN AS A COMMENT
// ---------------------------------------------------------------------------
//
// WHY THIS IS NOW A LIST INSTEAD OF PROSE. Until this change the
// express-rate-limit limiters in server.js were described here in a comment
// block, on the grounds that they are library state rather than a Map this repo
// declares. The comment named five limiters. server.js had TEN, and had had ten
// for some time: advisorLimiter, advisorQuestionLimiter, venueDashboardLimiter,
// venueProfileLimiter and digestOptOutLimiter all landed after the comment was
// written and none of them changed it, because nothing could fail when they
// did not.
//
// That is precisely the failure this whole file exists to prevent, arrived at
// through the one door it left open. INVENTORY is enforced by a scanner
// (__tests__/cacheKeyInventory.test.js); the limiter block was enforced by
// remembering. So the limiters get the same treatment the Maps got: rows, and a
// build that fails without them (__tests__/rateLimiterInventory.test.js).
//
// WHAT THE TEST CHECKS, which is more than presence:
//   1. every `rateLimit({...})` in server.js has a row here;
//   2. every row's windowMs, max and user-visible message MATCH the literals in
//      server.js, so a ceiling cannot move without the row moving with it;
//   3. every `app.use('/api/...')` mount in server.js either names a limiter
//      listed here, or is named in UNLIMITED_MOUNTS below with a reason. A
//      route cannot land with no ceiling and no argument for having none;
//   4. the backstop's ceiling is >= the sum of every other limiter's
//      15-minute-equivalent allowance, which is what makes it a backstop rather
//      than a new, tighter limit nobody derived.
//
// THE THREE QUESTIONS EACH ROW ANSWERS, which are the limiter twins of the two
// INVENTORY asks:
//   * WHAT DOES IT KEY ON, and can the caller mint a fresh bucket? An address
//     is rotatable and is shared by everyone behind one NAT. An account is not
//     rotatable but does not exist yet at the signup and login doors.
//   * WHAT DOES THE CALLER SEE, and does that sentence describe THIS window? A
//     429 that names a wait shorter than the real one is worse than a bare
//     refusal: the user retries on its advice, is refused again, and concludes
//     the feature is broken rather than rationed.
//   * WHAT DOES IT ACTUALLY PROTECT? A request ceiling in front of a per-token
//     or per-call money meter is a brake, not a cap, and the two are not
//     substitutes.
//
// ONE SYSTEMIC WEAKNESS ACROSS EVERY IP-KEYED LIMITER, carried from round 4
// R4-A3: express-rate-limit@7 keys on the FULL req.ip with no IPv6 subnet
// grouping, so a single /64 voids every per-IP control at once. It is latent
// only because the production API host publishes no AAAA record — a fact
// nothing in this repo asserts on. If an AAAA record ever appears, or a custom
// api. domain is pointed at the service with one, every `keyKind: 'ip'` row
// below silently becomes a no-op.
//
// A SECOND ONE, TRUE OF ALL TEN: express-rate-limit uses its MemoryStore, so
// every counter here lives in this process's heap. It resets on every deploy
// and divides by the instance count — the same caveat utils/placesBudget.js and
// utils/probeBudget.js carry, and the reason CLAUDE.md says a second Railway
// instance needs `rate-limit-redis` before it needs anything else.
//
// A THIRD: every limiter below is REPLACED BY A PASS-THROUGH when
// NODE_ENV === 'development'. That is deliberate and it fails safe (an unset
// NODE_ENV leaves them on), but it means nothing about these ceilings is
// exercised by simply running the app locally. They are exercised by
// __tests__/rateLimiterInventory.test.js and __tests__/imageSpendLimits.test.js
// and nowhere else.

/**
 * @typedef {object} Limiter
 * @property {string} name        the binding in server.js
 * @property {number} windowMs    must equal the literal in server.js
 * @property {number} max         must equal the literal in server.js
 * @property {'ip'|'account'} keyKind
 * @property {string} key         how the bucket is derived
 * @property {string} message     the user-visible string, verbatim
 * @property {string[]} mounts    every path server.js mounts it on
 * @property {string} protects    the scarce thing behind it
 * @property {'SAFE'|'OPEN'} verdict
 * @property {string} why         one line the next round can check
 */

/** @type {Limiter[]} */
const LIMITERS = [
  {
    name: 'globalBackstopLimiter',
    windowMs: 15 * 60 * 1000,
    max: 8500,
    keyKind: 'account',
    key: 'billedImageKey — `user:<jwt.verify\'d id>` when a valid bearer token is present, `addr:<req.ip>` otherwise',
    message: 'Too many requests, please try again later',
    mounts: ['(app-wide, the FIRST middleware on the app: ahead of cors and ahead of the body parsers)'],
    protects: 'the process itself, and specifically the four surfaces that had NO ceiling of any kind',
    verdict: 'SAFE',
    why: 'Before this existed there was no app-wide ceiling: apiLimiter is one shared instance across ~25 routers (so those DO share one 3000/15min bucket), but /api/revenuecat, /api/email-events, GET /api/health and EVERY unmatched path that falls through to the 404 handler were mounted with no limiter at all, and a caller could spend each per-route ceiling in full and then flood 404s without limit. The number is DERIVED, not chosen: the sum of every other limiter\'s 15-minute-equivalent allowance is 8,403 (apiLimiter 3000 + venueSearch 1800 + venueDashboard 1800 + venueProfile 450 + ai 450 + advisor 300 + digestOptOut 300 + authLimiter 150 + imageSpend 150 + advisorQuestion 3) and 8500 is that rounded up to the next hundred, so by construction it cannot refuse a caller every per-route limiter would have allowed. __tests__/rateLimiterInventory.test.js recomputes that sum and fails if a new limiter pushes it past this number. One correction to that word by construction, measured 2026-08-26: the MemoryStore in express-rate-limit 7.5.1 starts each KEY window at that key first hit, so these ten windows are not aligned with each other or with this one, and a caller bursting at every seam can fit sixteen one-minute windows and two whole apiLimiter windows into one fifteen-minute window here — about 11,800 rather than 8,403. The number is deliberately left at 8,500 anyway: the only caller who reaches that is sustaining thirteen requests a second across every surface of the app at once, and being wrong in that direction costs them a 429 saying try again. It keys on the ACCOUNT where there is one for billedImageKey\'s reason, which also means a NAT full of signed-in users gets a bucket each rather than one to fight over; unauthenticated callers land in `addr:` and are bounded far tighter by apiLimiter first, so this can never be the limiter that bites them. It is mounted AHEAD of express.json, which no other limiter is: a refusal here is the only one in the file that stops the body being read. It is also mounted ahead of cors(), and that was WRONG for the first nine hours of its life: cors does not fall through, it ANSWERS, so a preflight (204, preflightContinue defaults to false) and, far worse, any request carrying an Origin the allowlist does not hold (next(new Error) with the CORS refusal message, straight to the error handlers at the bottom of server.js) both skipped this limiter entirely. That Error carries no status, so Sentry.setupExpressErrorHandler captures it: one request header on any URL, unauthenticated, bought an unbounded stream of Sentry events, which is strictly worse than the unrouted-404 hole this limiter was written to close. The single exemption is skip(): a preflight from an ALLOWED origin, because it carries no Authorization header and therefore keys to addr:, and counting those would put a whole bar of Capacitor clients into one bucket for a request cors answers without reading a body. A preflight cors is about to refuse is not exempt.',
  },
  {
    name: 'apiLimiter',
    windowMs: 15 * 60 * 1000,
    max: 3000,
    keyKind: 'ip',
    key: 'req.ip (express-rate-limit default)',
    message: 'Too many requests, please try again later',
    mounts: [
      '/api/flocks', '/api/guest', '/api/badge', '/api/sensors', '/api/checkin',
      '/api/waitlist', '/api/public', '/api/users', '/api', '/api/stories',
      '/api/friends', '/api/safety', '/api/crowd', '/api/feedback', '/api/weather',
      '/api/budget', '/api/billing', '/api/events', '/api/entitlements',
      '/api/notifications', '/api/admin', '/api/availability', '/api/calendar',
    ],
    protects: 'a flood valve on the whole authenticated product; not a spend control, every paid surface behind it carries its own in-route budget',
    verdict: 'SAFE',
    why: 'ONE rateLimit instance mounted on every path above, so all of them share a single 3000/15min bucket per address rather than getting one each — worth stating because the opposite reading (a bucket per mount) is the natural one and would make this 23 x 3000. 200 requests a minute is generous for a chat and feed client and is deliberately not the money ceiling: utils/placesBudget.js, utils/visionBudget.js and services/birdieUsage.js are. The dimension is the weak part rather than the number: one school or one bar behind a NAT shares this bucket, which is why every authenticated meter added since keys on the account instead.',
  },
  {
    name: 'authLimiter',
    windowMs: 60 * 1000,
    max: 10,
    keyKind: 'ip',
    key: 'req.ip (express-rate-limit default)',
    message: 'Too many login attempts, please try again later',
    mounts: ['/api/auth'],
    protects: 'the pure-JS bcrypt compare, which is denominated in milliseconds of the only thread, and the signup/login/reset doors generally',
    verdict: 'SAFE',
    why: 'The address is the CORRECT dimension here and the only one available: there is no authenticated identity at a login, a signup or a password reset, so an account key would be a key the caller mints for free. Round 4 R4-A2: this is the only bound on the bcrypt compare. The NAT cost is real and accepted — ten sign-ins a minute for a whole school is tight — and is the reason routes/auth.js layers per-address AND per-canonical-email counters underneath rather than leaning on this alone.',
  },
  {
    name: 'venueSearchLimiter',
    windowMs: 60 * 1000,
    max: 120,
    keyKind: 'ip',
    key: 'req.ip (express-rate-limit default)',
    message: 'Too many venue searches, please try again later',
    mounts: ['/api/venues'],
    protects: 'request volume in front of the unauthenticated photo proxy; NOT the money',
    verdict: 'SAFE',
    why: 'The money ceilings on this router are photoIpHits, the durable dollar budget in services/photoStore.js and the global Places leg — not this. Address-keyed because the photo proxy takes no auth, which is the one honest reason for an IP key on this router; the authenticated halves of it (text search, details) charge allowPlacesSearch on the account underneath.',
  },
  {
    name: 'imageSpendLimiter',
    windowMs: 60 * 1000,
    max: 10,
    keyKind: 'account',
    key: 'billedImageKey — a jwt.verify\'d user id, falling back to req.ip only for a request about to be 401\'d',
    message: 'Slow down a moment.',
    mounts: ['(app-wide, conditional on carriesBilledImage)'],
    protects: 'a PAID Google Cloud Vision SafeSearch call per image, plus the row and the fan-out',
    verdict: 'SAFE',
    why: 'Verified rather than decoded, so a forged token cannot mint a bucket, and mounted ONCE globally rather than per route so alternating between the four image doors cannot buy their sum. Same numbers as the socket\'s send_image bucket, pinned across both files by __tests__/imageSpendLimits.test.js. The message is one of the few in the app whose wording matches its window: a 60-second window really is a moment.',
  },
  {
    name: 'aiLimiter',
    windowMs: 60 * 1000,
    max: 30,
    keyKind: 'account',
    key: 'billedAccountKey (= billedImageKey)',
    message: 'Too many AI requests, please slow down',
    mounts: ['/api/ai'],
    protects: 'reaching the Birdie router at all; the invoice is bounded by the token ledger, not by this',
    verdict: 'SAFE',
    why: 'It bounds REQUESTS and Gemini is billed per TOKEN, so this is the cheap early brake and services/birdieUsage.js geminiUserSpend is the cap denominated in money. Neither replaces the other and the pair is the house pattern. Account-keyed for billedImageKey\'s reason.',
  },
  {
    name: 'advisorLimiter',
    windowMs: 60 * 1000,
    max: 20,
    keyKind: 'account',
    key: 'billedAccountKey (= billedImageKey)',
    message: 'Too many advisor requests, please slow down',
    mounts: ['/api/venue/advisor'],
    protects: 'Postgres and latency: one GET /cards walks seven days of ML event lookups and forecasts plus three aggregates',
    verdict: 'SAFE',
    why: 'Roost is more expensive per request than Birdie and sat on the general 3000/15min limiter until this was written, which allowed three thousand of those in a quarter of an hour from one account. The vendor meters and the token ledgers bound the money; nothing bounded the database, which is what this is for.',
  },
  {
    name: 'advisorQuestionLimiter',
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyKind: 'account',
    key: 'billedAccountKey (= billedImageKey)',
    message: 'That is a lot of questions in one hour. Give it a little while and ask again.',
    mounts: ['/api/venue/advisor/question'],
    protects: 'at least two model calls per typed question, over a prompt carrying the owner\'s own words',
    verdict: 'SAFE',
    why: 'The ONE advisor path the caller shapes, so it gets an HOUR window rather than a minute: advisorLimiter\'s 20 a minute is 1,200 an hour and a question is a thought. Mounted at a longer path than advisorLimiter and therefore charged IN ADDITION to it, tighter one first, which is the right precedence. Its sentence names the hour, which is more than most 429s in this codebase do — see the handoff list in the round-24 report. It sits UNDER the per-venue daily cap in migration 039 rather than replacing it: this one is per process and a restart clears it, the Postgres one is not.',
  },
  {
    name: 'venueDashboardLimiter',
    windowMs: 60 * 1000,
    max: 120,
    keyKind: 'account',
    key: 'billedAccountKey (= billedImageKey)',
    message: 'Too many dashboard requests, please slow down',
    mounts: ['/api/venue-dashboard'],
    protects: 'four fourteen-day aggregate scans per /this-week, a DISTINCT ON plus a correlated NOT EXISTS per /busy-now, a per-call vote join per /incoming-flocks',
    verdict: 'SAFE',
    why: 'These landed on the general limiter, which is an ADDRESS meter sized for consumer chat and feed traffic, in front of routes that are analytics. Account-keyed because both routers are authenticated and an address meter on an authenticated route is a meter IP rotation defeats.',
  },
  {
    name: 'venueProfileLimiter',
    windowMs: 60 * 1000,
    max: 30,
    keyKind: 'account',
    key: 'billedAccountKey (= billedImageKey)',
    message: 'Too many profile requests, please slow down',
    mounts: ['/api/venue-profile'],
    protects: 'an EXISTS plus a COUNT(*) over ml_venue_baselines on every save',
    verdict: 'SAFE',
    why: 'Same reasoning as venueDashboardLimiter, sized for a profile saved by hand rather than a dashboard opening a dozen panels at once.',
  },
  {
    name: 'digestOptOutLimiter',
    windowMs: 60 * 1000,
    max: 20,
    keyKind: 'ip',
    key: 'req.ip (express-rate-limit default)',
    message: 'Too many requests, please try again later',
    mounts: ['/api/venue-digest', '/api/unsubscribe'],
    protects: 'an open unauthenticated endpoint being used as free load',
    verdict: 'SAFE',
    why: 'The two unsubscribe surfaces are the venue and waitlist doors with NO login, so the address is all there is to key on. Both authorise on an HMAC that is not guessable, so this is not a brute-force gate — and one instance across both mounts, so they share the bucket. NOTE the interaction with RFC 8058 one-click POST: Gmail and Apple Mail send those from THEIR egress addresses, not the reader\'s, so a large send could in principle put many unrelated unsubscribes into one bucket. At this list size it cannot; if the list ever grows, this is the row to revisit and the evidence that settles it is the source addresses in the Railway access log for a Monday send.',
  },
];

// ---------------------------------------------------------------------------
// MOUNTS WITH NO LIMITER, AND WHY EACH ONE IS ALLOWED TO HAVE NONE
// ---------------------------------------------------------------------------
// __tests__/rateLimiterInventory.test.js fails if server.js mounts a path that
// neither names a limiter above nor appears here. The point is not that an
// unlimited mount is forbidden — two of these are signed webhooks whose senders
// we do not control and must not refuse — it is that "this one has no ceiling"
// has to be a decision somebody wrote down rather than a line nobody noticed.
//
// All four are now covered by globalBackstopLimiter, which is the whole reason
// it exists. Before it, each of these was genuinely unbounded.
const UNLIMITED_MOUNTS = [
  {
    path: '/api/revenuecat',
    why: 'RevenueCat\'s subscription webhook, authorised by a shared secret. Refusing it loses a purchase or an expiry event and RevenueCat\'s retry schedule is its own, so a per-address ceiling here would trade a billing-state bug for a load saving we do not need. The body ceiling is the scoped webhookJsonParser and the identity check is the shared secret; the backstop is the volume ceiling.',
  },
  {
    path: '/api/email-events',
    why: 'Resend\'s delivery webhook, Svix-signed over the RAW bytes. Same reasoning as RevenueCat: a refused bounce notification is a suppression list that silently stops being true. emailWebhookParser gives it the raw body it needs.',
  },
  {
    path: '/api/health',
    why: 'GET only, and defended by shape rather than by a counter: the answer is cached for HEALTH_CACHE_MS and concurrent misses share one in-flight probe, so however hard it is polled the database sees at most one SELECT 1 per 5 seconds. Railway polls it, so a limiter here could take a healthy instance out of rotation.',
  },
  {
    path: '(unmatched paths -> the 404 handler)',
    why: 'Not a mount at all, which is exactly why it was missed: anything matching no router falls through to the 404 handler, and until globalBackstopLimiter existed that path had no ceiling of any kind. It is cheap per request, but "cheap and unbounded" is the shape of every load problem this file catalogues.',
  },
];

/** Directories the standing scanner sweeps. Adding one here is enough. */
const SWEPT = ['routes', 'services', 'utils', 'sockets', 'middleware', 'config'];
const SWEPT_FILES = ['server.js'];

module.exports = { INVENTORY, LIMITERS, UNLIMITED_MOUNTS, SWEPT, SWEPT_FILES };
