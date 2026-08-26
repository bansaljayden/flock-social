# Flock

**Plans die in the group chat. Flock is where they happen.**

Flock is a social planning app for going out with friends: start a flock,
invite your people, vote on where to go, match budgets privately, split the
bill, and get home safe. Free for users; the business is on the venue side.

- **Web:** https://www.flockcorp.com (live since 2026-08-12; the old
  `flock-app-w65m.vercel.app` still resolves)
- **iOS:** Capacitor build, App Store submission in progress (App ID 6781442127)
- **1st place, PA DECA States**

## Why it exists

Group plans rarely die because people don't want to go. They die because
deciding is annoying. Groups don't pick anyone's favorite venue; they pick the
one nobody vetoes, and a group chat has no mechanism for that. Flock is the
mechanism: RSVP in one tap, throw venues in, vote, lock it in.

Money is the other silent killer. Nobody wants to type "that's too expensive"
in front of six people. In Flock, everyone enters what they can spend
privately and the group only ever sees a rounded ceiling. Individual amounts
are never shown to anyone, including the flock's creator. This is a hard
product invariant (see below, including what it does not cover).

## What ships today

| Area | What's real |
|---|---|
| Planning | Flocks, invites, RSVP, venue voting, group chat with venue cards, plans calendar |
| Money | Anonymous budget matching (aggregate ceiling only), bill splitting with Venmo and Cash App deep links, Zelle by instructions (it has no shared URL scheme to open) |
| Crowd intelligence | Own ML model live in production (see below), with a rule-based fallback engine |
| Birdie | AI assistant for venue ideas ("somewhere quiet and cheap nearby") |
| Safety | Live location inside a flock (off by default, never background), one-tap SOS to trusted contacts, report + block, account deletion in-app (with re-authentication) |
| Venues | Venue dashboard: profile, promotions, events, reviews with owner reply, incoming-flocks demand feed. Tier is enforced server-side; nobody has been charged |
| Social | Friends (codes + search), DMs, post-hangout feedback |
| Accounts | Email + Google + Sign in with Apple (iOS only), DOB age gate at 13, email verification, disposable-domain blocking |

**Not built yet**, so nothing in this repo or on the site sells it: Stripe or
venue billing of any kind (tier enforcement is real, charging is not),
promoted placement in vote lists, slow-night push offers, paywall funnel
analytics, and any story UI. Stories are a settled decision (2026-08-14): the
backend routes exist and are tested, no story surface will ship, and the
client has zero callers by design.

Blocking used to be listed here as one-way. It is not any more: a Blocked-accounts
screen with a working unblock shipped on 2026-08-14, so report, block and unblock
are all real.

## The crowd model

Flock runs its own trained model, not a wrapper around someone else's busyness
chart. `backend/services/mlPredictor.js` serves an XGBoost model (ONNX,
**v2.6.0 "Starling"**, trained 2026-08-18) with **106 features**: time patterns,
weather, nearby events, holiday/holiday-eve calendars, venue category and
popularity, per-venue baselines, and user feedback. It predicts a *delta* from
each venue's popular-times baseline, clamped to ±30 points, rather than an
absolute busyness figure.

Trained on **1,934,988 venue-hour observations across 30 cities**, with a
separate **395,464-row holdout** (Barcelona, Miami, Tokyo), validated
leave-one-city-out.

One model, three populations. Which one gets quoted decides whether the number
means anything at all:

| Population | Rows | MAE | R² | Within 10 |
|---|---|---|---|---|
| Every training row | 1,934,988 | 6.89 | 0.653 | 85.1% |
| **Realtime rows — what production actually scores** | **369,076** | **27.54** | **0.127** | **22.8%** |
| Weekly snapshots (diagnostic only) | 1,565,912 | 2.02 | 0.986 | 99.8% |

Those three rows are the same model. The first looks four times better than the
second purely because 81% of the corpus is weekly popular-times snapshots, and
on those rows the label is zero *by construction* — the model is asked to
predict that a venue matches its own baseline, which it does almost perfectly
and which proves nothing. Averaging them together produces a number that is
arithmetically correct and completely misleading. `model_metadata.json` labels
that row `"close to a tautology on that majority"` in the artifact itself, and
the ship gate refuses to score against it.

What the model is actually measured on is the realtime slice, and it is measured
against what it replaced rather than against nothing. Predicting how full a specific bar
will be at 9pm on a specific Friday is a genuinely open problem, and the yardstick
says so: the popular-times baseline this model starts from — the strongest freely
available signal for the question — scores **R² −0.075** on those rows, which is
worse than always guessing the average. That is the bar. Two generations of the
model have moved it:

| On the same 67,249 holdout rows | MAE | R² | Within 10 |
|---|---|---|---|
| Popular-times baseline alone | 31.48 | −0.075 | 19.2% |
| v2.5.0-starling (previous) | 30.77 | −0.043 | 19.3% |
| **v2.6.0-starling (serving)** | **29.42** | **+0.040** | **20.7%** |

Crossing zero is the part that matters: v2.6 is the first version whose
predictions carry more information than the mean of the data. Both margins are
small and both are real, measured on identical rows with identical features.

Getting that measurement right was most of the work. Three things had to be
true before the number meant anything:

- **The ship gate scores only the realtime slice.** It is structurally incapable
  of reporting the 85% figure, because that figure is dominated by rows whose
  answer is zero by definition.
- **The floor is re-derived every run** from the incumbent's own measured
  within-10 on the same rows. It was a hardcoded 29.2% until that constant was
  traced back to a measurement taken *before* the clock-axis bug was fixed,
  which made it a number no honest model could ever clear.
- **The corpus was on the wrong clock.** Category peaks were landing at lunchtime
  because 3,454,955 weekly rows were stored six hours off local time. Fixing it moved
  restaurant, bar and nightclub peaks into 17:00–23:00 — 53 of 91 categories,
  up from 2 — and only then did the weights get retrained on a corrected axis.

`backend/scripts/ml/MODEL-METRICS.md` carries the full measurement, including
the per-city breakdown and what the gate refused along the way.

- Every number above is read from
  `backend/scripts/ml/models/model_metadata.json`. Quote it, not this table —
  and re-run the incumbent on the same holdout before claiming an improvement,
  because the baselines have matured over time and old figures are not
  comparable.
- Venues the model doesn't know yet (no baseline, no popular-times signal)
  are answered by the rule engine in `crowdEngine.js` instead of guessing.

> **The trained model is not in this repository.** `crowd_model.onnx` (11.4 MB)
> and `model_metadata.json` are Flock's own artifacts, built from Flock's own
> collected data, and they are not published. Everything that produced them is
> here: the collection scripts in `backend/scripts/ml/`, the training pipeline
> in `backend/scripts/ml/train/`, and the runbook in
> `backend/scripts/ml/RETRAIN.md`. See `backend/scripts/ml/models/README.md` for
> how to train your own from your own data.
>
> With no artifact on disk, `mlPredictor.js` logs
> `Model files not found — using rule engine` once at boot and every prediction
> is answered by `crowdEngine.js`, tagged `predictionMethod: 'rule_engine'`. That
> is a designed path, not a crash, but it does mean a clone of this repo serves
> the rule engine and not the model. The ML test suites in `backend/__tests__/`
> read the artifacts directly and will fail without them.

The difference from busyness charts elsewhere: those measure who already
showed up. Flock's venue votes also capture which venues groups are
*considering* right now, which is the signal the venue side of the business
is built on (see `MONEY-MODEL.md` and `VENUE-BILLING.md`).

## Stack

React 19 (CRA) on Vercel · Node + Express on Railway · PostgreSQL ·
Socket.io · JWT auth (email, Google, Sign in with Apple) · Capacitor 8 for iOS ·
MapLibre GL for every map, on MapTiler tiles with a keyless Carto fallback
(no Google Maps SDK, no Maps key) ·
RevenueCat + Apple IAP (consumer, dormant behind a flag) · Google Places, Google
Cloud Vision (image moderation), Gemini (Birdie), OpenWeatherMap, Ticketmaster,
Resend, FCM + APNs · PostHog, Sentry (dormant, DSN unset).
Type: Fraunces (display) + Hanken Grotesk (body), self-hosted from
`frontend/src/fonts/`.

```
flock-app/
├── frontend/          # React app + marketing site (frontend/src/website)
│   └── ios/           # Capacitor iOS shell (built by Codemagic → TestFlight)
├── backend/           # Express API + Socket.io + ML predictor
│   └── scripts/ml/    # Data collection + training pipeline (trained model not distributed)
├── flock-sensor/      # Raspberry Pi occupancy sensor pipeline (proven, hardware pending)
└── tools/             # publish-public.sh (the public mirror) + the ASC upload helper
```

An abandoned React Native port lived in `mobile/` until 2026-08-18 and was
removed. Capacitor has been the launch path since 2026-06-17, and the RN tree
was never carried forward with the app after that.

## Hard invariants (do not break)

1. **Other people's** budget amounts never leave the server. A client only ever
   sees the aggregate `{ ceiling, submissionCount, totalMembers, isReady,
   skipCount }`, plus the amount that caller submitted themselves. `ceiling` is
   withheld entirely until at least three non-skipped submissions exist, it is
   **published once and never changes**, and what it publishes is a **band**,
   not the raw minimum: rounded down to the
   nearest $10 at $50 and up, the nearest $5 from $5 to $50, the nearest $1 from
   $1 to $5, and a flat $0.01 below a dollar (never $0, which the client reads
   as "no ceiling yet"). It only ever rounds down, so every venue under the
   published ceiling is still inside everyone's real budget.

   "Published once" is the second half of the rule and it is load-bearing.
   The ceiling is a minimum, so it only moves when a new minimum arrives, and a
   number that moves is a number anyone watching can attribute: three people
   submit, a ceiling appears, the fourth person submits and it drops, and every
   member has just been told which of them has the least money. So no ceiling
   is published while the budget is open. It is published at the moment the
   budget settles, which is the last member answering (submitting or skipping)
   or the creator locking it, and after that the budget is closed and a further
   submission is refused rather than moving the number. `flocks.budget_ceiling`
   holds the published number and nothing else writes it. All five readers of
   that column apply the same gate: `GET /api/budget/:id`, the flock list, the
   flock detail, the flock update, and the ghost commit in `routes/billing.js`.

   What this does not do: the ceiling is the minimum of the submitted amounts,
   so participants who compare notes can narrow down what a remaining
   participant submitted. Two people who both submit a deliberately high amount
   learn that the published band contains the third person's number. A
   submission threshold cannot prevent that, because colluding participants
   already know their own amounts and can subtract them out. Banding is what
   limits the result to a range instead of an exact figure. Flock is built for
   small groups of friends, and the ceiling is the one number the group is
   meant to share.
2. No secrets in the repo, ever. All keys live in the Vercel / Railway /
   Codemagic dashboards. A gitleaks pre-commit hook enforces this, and a
   GitHub Actions job re-scans the whole history on every push.
3. Server-side enforcement behind every client gate. Frontend gating is UX,
   not security.
4. Nothing on any marketing surface may claim a feature that doesn't ship
   (`SLOP-AUDIT.md` is the standing design + copy standard).

## Repo docs

| File | What |
|---|---|
| `SLOP-AUDIT.md` | Design and copy standard, with per-rule audit status. Binds every UI or copy change |
| `MONEY-MODEL.md` | Monetization reality: venue B2B first, consumer Pro later |
| `VENUE-BILLING.md` | Venue subscriptions. Tier enforcement is built; the Stripe half is a design spec with no code. Authoritative on price: $35 Premium / $75 Pro, FINAL as of 2026-08-14 (matches the app) |
| `MODERATION-LEGAL.md` | Moderation and legal commitments the code must keep |
| `BACKUP-AND-VERIFICATION.md` | Backup and restore: what is verified, what is only researched |
| `SUBMIT-CHECKLIST.md` | App Store submission: assets, ordered steps, privacy labels |
| `backend/scripts/ml/RETRAIN.md` | Crowd-model retrain runbook and ship gate |
| `backend/scripts/ml/MODEL-METRICS.md` | Measured model numbers and what they mean |
| `codemagic.yaml` | iOS CI: build, sign, auto-increment, TestFlight |
| `LICENSE` / `CONTRIBUTING.md` | PolyForm Noncommercial 1.0.0, and how contributions are accepted under it |

Internal working notes (submission packets, decision memos, session docs) are
kept out of the repo on purpose.

## Running it

```bash
# backend
cd backend && cp .env.example .env   # then fill it in — see the notes in that file
npm install
npm start                            # migrations run on boot, before the port opens

# frontend
cd frontend && cp .env.example .env
npm install && npm start
```

Both `.env.example` files carry the variables you need to boot it, with a
line per variable saying what breaks when it is missing. Three fail *open*
(image moderation, NFC trust, admin provisioning) — read those before deploying.
They are not an exhaustive index of `process.env`: a handful of tuning knobs,
platform-injected values and destructive-operation guards are read by the code
without appearing there.

`backend/db/migrate.js` runs every file in `backend/migrations/` in filename
order before `server.listen()`, inside an advisory lock, recording what it applied
in `schema_migrations`; a failure exits the process rather than serving a
half-migrated schema. `migrations/000_bootstrap.sql` carries the core
`CREATE TABLE`s, so **a fresh database boots from migrations alone** — no manual
schema step. `backend/database/schema.sql` is the same content kept separately —
the base shape, for reading — and `npm run db:init` applies just that. It is not
a substitute for the migrations: it has not moved since the bootstrap was cut,
so everything 001 onward adds is missing from it.

Migrations are numbered from 000 upward in `backend/migrations/`. **There is
no 010**; the number was skipped, not lost. Every migration the code needs is
tracked, so a deploy from HEAD is complete.

Backend tests: `cd backend && node --test` · local E2E: `npm run e2e`. Neither
needs a database you provide: the migration suites and the E2E script each start
a throwaway Postgres through `embedded-postgres`, which the first run downloads.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). You may read, run, modify and
share this code for any noncommercial purpose. Commercial use requires a separate
agreement: email social@flockcorp.com.

---

Built by Jayden Bansal, Bethlehem PA.
