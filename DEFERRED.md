# Deferred work, parked 2026-08-15

Jayden's call: the crowd model is today's goal and everything below waits.
Nothing here is lost, and nothing here is a mystery. Each item says what is
wrong, how bad it is, and what closing it takes, so the next session can pick
any line and start.

Priority order within this file is roughly the order to close them in.

## 1. Birdie cost caps, never swept

`backend/routes/ai.js` is the one route no audit has covered. The client
re-sends the whole conversation on every call, and nothing has been verified to
cap conversation length or message size before that reaches Gemini, so an
unbounded resent thread is an unbounded token bill. The Birdie limiter in
server.js is 30 per minute per IP, which bounds call COUNT and not call SIZE.

Also unverified there: exactly what user data reaches Gemini (the privacy
policy promises an age BRACKET and never the birthday, and that claim is
currently unpinned by any test), and whether hostile text inside a venue name
or a user message can redirect Birdie or poison the venue cards its answers are
parsed into.

Closing it: one fix agent owning `routes/ai.js` plus a new test file. Caps
before the upstream call, a pinned payload trace, injection cases, and a clean
degrade on a Gemini 429 or timeout.

## 2. The App.js async sweep, half done

Per-screen crash boundaries shipped (`56d43a8`), so one screen's render crash
no longer white-screens the app. The other half of that job never happened: the
audit of every `await` and `.then()` in a user-triggered handler that has no
catch path, so a failed API call surfaces as a rendered error state instead of
an unhandled rejection. The agent doing it died on the usage limit mid-read.

Closing it: a fix agent owning `App.js`, grep-driven, converting naked async
paths into handled ones. Smallest diffs, no refactor. Reproduce the worst three
in tests first.

## 3. Three tuning calls that are Jayden's, not an agent's

Each is a judgment about what the product should claim, so no agent should
decide it alone:

- **The heuristic fallback can publish confidence 86 while the trained model
  publishes 84.** A cold-start guess can out-claim the model. Fixing it means
  retuning the confidence ladder, which is a product decision about honesty.
- **`hour >= 22 && hour <= 24`** in the Mexican and fast-food late-night
  branches never binds at 24, because hours run 0 to 23. If midnight was
  intended it needs `|| hour === 0`.
- **A venue typed both bar and nightclub** gets bar scoring and bar wait times
  but nightclub capacity, because branch order differs per function. Pinned
  as-is so a future change is deliberate rather than accidental.

## 4. Webhook event ordering

RevenueCat retries deliveries and applies them in arrival order, so a retried
`INITIAL_PURCHASE` can land after the `EXPIRATION` that superseded it and leave
an account premium. Documented in `routes/revenuecat.js` with the exact
statement to write. Needs a `users.premium_event_at` watermark column, so a
migration plus a decision, and it only matters once renewal volume makes a
reordered delivery likely rather than merely possible.

## 5. NFC tap replay, unfixable in software

A captured tap URL replayed by a second account verifies. Every tap of one tag
is byte-identical, so single-use-per-payload would mean one verified check-in
per venue ever, and there is no timestamp in the payload to window. The real
fixes are per-venue secret rotation with re-cut tags, or NTAG 424 DNA tags with
hardware counters. Recorded in `routes/checkin.js`; what bounds it today is
pinned (one row per account per half hour, 15 per hour across venues, revoked
and banned sessions recording as a null user).

## 6. Smaller open items

- **Global sheets and inline overlays sit outside the per-screen boundaries.**
  They are built during the parent's render, so only a refactor of the component
  body could contain them. The root boundary still catches them, so the failure
  mode is a recoverable card rather than a white screen.
- **The frontend consumes none of the new crowd honesty fields.** `supported`,
  `confidenceBasis` and `confidenceMeans` ship in the payload and nothing reads
  them. The hedged label reaches users automatically; the rest is inert until a
  consumer exists.
- **Desktop payment handoff race.** A blank tab from an unknown scheme reads as
  a successful handoff and suppresses the fallback prompt. Bill splitting is a
  phone flow, and the new anchor improves middle-click and long-press.
- **`ml_training_data` has no unique constraint.** This one belongs to the ML
  work and is only listed here so it is not lost: it is deferred purely to keep
  two agents from colliding on migration numbers, and it should be closed as
  part of the retrain, not after it.

## 7. Human steps, only Jayden can do these

- Set `REVENUECAT_WEBHOOK_SECRET` to at least 16 characters
  (`openssl rand -hex 32`) BEFORE ever setting `PAYWALL_ENABLED`. The route
  refuses shorter values as unconfigured, which is deliberate.
- App Store Connect: select the build, answer Content Rights, then Submit.
- The TestFlight device pass on a real phone.
- Google Search Console verification token, whenever the web side matters.
