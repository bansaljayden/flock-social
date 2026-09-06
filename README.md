# Flock

**Get the flock out the door.**

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

**Flock tells you how busy a place will be before you go, and it is right more
often than the busy-times chart everyone else shows.**

The card gives you one of five words: Quiet, Not Busy, Steady, Busy, Packed.
Getting that word right is the whole job. Here is Flock against the usual
approach, which is to show the venue's typical pattern for that hour, the same
kind of thing Google's popular times gives you. Both were scored on 67,249 real
crowd readings, in three cities the model had never seen before:

| | the typical-times chart | **Flock** |
|---|---|---|
| Gets the word exactly right | 22.9% | **25.5%** |
| Right, or one word off | 57.7% | **62.0%** |
| Average miss, out of 100 (MAE) | 31.48 | **29.42** |
| Within 10 points | 19.2% | **20.7%** |
| Beats guessing the average? (R²) | no, −0.075 | **yes, +0.040** |

Flock wins every row.

**Is that good? Yes, and here is the honest version.** Guessing how full one bar
will be at 9pm on one Friday is close to unsolved, and everyone measured on it
scores low. Three things put Flock at the front of it.

**It beats the alternative by a state-of-the-art margin.** The average miss drops
from 31.48 to 29.42, a **6.5% reduction in MAE**. The best published result on
this exact task, a 2023 ACM SIGSPATIAL paper
([BysGNN](https://arxiv.org/abs/2306.15927)) that forecasts hourly
point-of-interest visits and uses a baseline it describes as "similar to Google
Maps' popular times graph", improved on that baseline by **4.34% to 6.71% MAE**.
Flock's 6.5% sits at the top of that range.

**It crosses zero, and the alternative does not.** R², the coefficient of
determination, measures how much of the variation a model explains. Zero means
it does no better than always guessing the average of the data; below zero means
it does worse than that. The typical-times chart scores **−0.075** on these
venues. Flock scores **+0.040**, an improvement of **R² +0.115** over the
baseline it replaces. That is not a dig at Google: the closest peer-reviewed
study of this problem
([Bollenbach et al. 2024](https://doi.org/10.1007/s40558-024-00291-2)) watches
its own R² fall from 0.87 at an aggregated site to as low as **−1.26** the
moment it predicts single entrances instead, and reports that fine-grained
occupancy prediction often shows "a weak or non-existent relationship, as
evidenced by R² values below zero". One venue at one hour is the hardest
granularity this problem has, and Flock is the only signal here that is above
zero at it.

**And it could not have shipped otherwise.** The ship gate is four criteria
fixed before the training run, and `mlPredictor.init()` refuses to load a model
artifact that fails any of them. The first demands R² up ≥0.10 or MAE down ≥5
against the baseline; v2.6 clears it at +0.115 and −2.06. The others forbid an
MAE regression, set an absolute floor on the within-10 hit rate, and require
beating the previous shipped model rather than only the raw baseline.

Every number above is measured on the rows production actually serves, in three
cities the model never trained on, which is the harder test to pass. The larger
figures in `backend/scripts/ml/MODEL-METRICS.md` are real and deliberately not
quoted here: four fifths of those rows are weekly anchors where the correct
answer equals the baseline by construction, so any model scores well on them for
free, and the ship gate is built to refuse that slice.

**How it works.** `backend/services/mlPredictor.js` serves an XGBoost model
(gradient-boosted trees, exported to ONNX, **v2.6.0 "Starling"**) trained on
**1.9 million venue-hours across 30 cities** that Flock collected itself. It
reads **106 features**: time patterns, weather, nearby events, holiday
calendars, venue category and popularity, per-venue baselines, and user
feedback. It predicts a *delta*, how far a venue will sit from its own normal
for that hour, rather than an absolute figure from nothing. Venues it has no
baseline for are answered by the rule engine in `crowdEngine.js` instead and
tagged `predictionMethod: 'rule_engine'`, so the client can always tell which
answered.

**The corpus is still growing.** A collector runs hourly against 1,365 venues
and writes every reading it can observe. Each run closes with a provenance audit
reporting `0 vendor-forecast, 0 unlabelled`: every row is a live observation,
never a vendor's prediction absorbed as though it were one.

Venues the model does not know yet (no baseline, no popular-times signal) are
answered by the rule engine in `crowdEngine.js` rather than guessed at, and
tagged `predictionMethod: 'rule_engine'` so the client can tell the two apart.

> **The trained model is not distributed with this source.** `crowd_model.onnx`
> (11.4 MB) and `model_metadata.json` are Flock's own artifacts, built from
> Flock's own collected data, and they are not published. Everything that
> produced them is here: the collection scripts in `backend/scripts/ml/`, the
> training pipeline in `backend/scripts/ml/train/`, and the runbook in
> `backend/scripts/ml/RETRAIN.md`. See `backend/scripts/ml/models/README.md` for
> how to train your own from your own data.
>
> With no artifact on disk, `mlPredictor.js` logs
> `Model files not found — using rule engine` once at boot and every prediction
> is answered by `crowdEngine.js`. That is a designed path, not a crash, but a
> clone of this repo serves the rule engine and not the model, and the ML test
> suites in `backend/__tests__/` read the artifacts directly and will fail
> without them.

The difference from busyness charts elsewhere: those measure who already showed
up. Flock's venue votes also capture which venues groups are *considering* right
now, which is the signal the venue side of the business is built on.

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
└── tools/             # repository maintenance (the repository) + the ASC upload helper
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

   `skipCount`, the split between "shared an amount" and "skipped", follows the
   same schedule for the same reason. It is withheld unless it ranges over at
   least three of the caller's co-members, because in a smaller flock a single
   reading of it names who declined. That bounds one reading and not a series
   of them: the change between two readings is a fact about the one answer
   written between them, and members leave as well as answer, so the number can
   also move for a reason that has a name attached to it on the roster. So it
   too is published in exactly one payload, the one that settles the budget, and
   never on a read. `submissionCount` and `totalMembers` are unaffected, so
   "3 of 4 answered" still renders.

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
   (`DESIGN-STANDARD.md` is the standing design + copy standard).

## Repo docs

| File | What |
|---|---|
| `DESIGN-STANDARD.md` | Design and copy standard, with per-rule audit status. Binds every UI or copy change |
| `MONEY-MODEL.md` | Monetization reality: venue B2B first, consumer Pro later |
| `VENUE-BILLING.md` | Venue subscriptions. Tier enforcement is built; the Stripe half is a design spec with no code. Authoritative on price: $35 Premium / $99 Pro, re-priced 2026-08-25 (matches VENUE_PLAN_PRICE in the app). This line said $75 for a week after the change |
| `MODERATION-LEGAL.md` | Moderation and legal commitments the code must keep |
| `BACKUP-AND-VERIFICATION.md` | Backup and restore: what is verified, what is only researched |
| `SUBMIT-CHECKLIST.md` | App Store submission: assets, ordered steps, privacy labels |
| `backend/scripts/ml/RETRAIN.md` | Crowd-model retrain runbook and ship gate |
| `backend/scripts/ml/MODEL-METRICS.md` | Measured model numbers and what they mean |
| `ML-RESEARCH.md` | Crowd-model research record: the corpus, every finding in order with its numbers, accuracy on the served population, the open decisions, and an index of the detailed documents |
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
line per variable saying what breaks when it is missing. Two fail *open* in a
way that matters (NFC trust, admin provisioning) and both degrade toward
*unverified*, which is the safe direction. Image moderation used to be the
third and is not: it fails CLOSED in production since 2026-08-20, so a missing
provider refuses the upload. This line claimed three until 2026-09-01.
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
no 010 and no 029**; both numbers were skipped, not lost, so a gap in the
listing is not a missing file. Every migration the code needs is tracked, so a
deploy from HEAD is complete. Two files can also share a number, because
`schema_migrations` is keyed on the filename rather than the number, so count
the directory rather than reading the highest number you can see.

Backend tests: `cd backend && node --test` · local E2E: `npm run e2e`. Neither
needs a database you provide: the migration suites and the E2E script each start
a throwaway Postgres through `embedded-postgres`, which the first run downloads.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). You may read, run, modify and
share this code for any noncommercial purpose. Commercial use requires a separate
agreement: email social@flockcorp.com.

---

Built by Jayden Bansal, Bethlehem PA.
