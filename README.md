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
privately and the group only ever sees the ceiling. Individual amounts are
never shown to anyone, including the flock's creator. This is a hard product
invariant (see below).

## What ships today

| Area | What's real |
|---|---|
| Planning | Flocks, invites, RSVP, venue voting, group chat with venue cards, plans calendar |
| Money | Anonymous budget matching (aggregate ceiling only), bill splitting with Venmo / Cash App / Zelle deep links |
| Crowd intelligence | Own ML model live in production (see below), with a rule-based fallback engine |
| Birdie | AI assistant for venue ideas ("somewhere quiet and cheap nearby") |
| Safety | Live location inside a flock (off by default, never background), one-tap SOS to trusted contacts, report + block, account deletion in-app (with re-authentication) |
| Venues | Venue dashboard: profile, promotions, events, reviews with owner reply, incoming-flocks demand feed. Tier is enforced server-side; nobody has been charged |
| Social | Friends (codes + search), DMs, post-hangout feedback |
| Accounts | Email + Google + Sign in with Apple (iOS only), DOB age gate at 13, email verification, disposable-domain blocking |

One honest caveat on that table, verified 2026-08-14:

- **Stories are not user-facing yet.** The backend is now complete — `GET`, `POST`
  and `DELETE` on `/api/stories` — but the client never calls it: `getStories()` is
  the only wrapper in `frontend/src/services/api.js` and it has **zero callers**,
  and there is no story UI in the app. So the feature exists over HTTP and not in
  the product. The Social row used to list stories outright, which was wrong.
  This one is actively changing; the backend grew from 88 to 450 lines on
  2026-08-14. (The iOS camera and photo permission strings promise stories too —
  see `SUBMIT-CHECKLIST.md` §D5.)

Blocking used to be listed here as one-way. It is not any more: a Blocked-accounts
screen with a working unblock shipped on 2026-08-14, so report, block and unblock
are all real.

## The crowd model

Flock runs its own trained model, not a wrapper around someone else's busyness
chart. `backend/services/mlPredictor.js` serves an XGBoost model (ONNX,
**v2.5.0 "Starling"**, trained 2026-08-12) with **106 features**: time patterns,
weather, nearby events, holiday/holiday-eve calendars, venue category and
popularity, per-venue baselines, and user feedback.

- Trained on **2.07M venue-hour observations across 31 cities**
  (plus a 419K-row holdout), validated leave-one-city-out.
- Leave-one-city-out CV: **R² 0.766** vs **0.672** for the popular-times
  baseline it starts from, **MAE 6.50**, **83.6% of predictions within 15
  points**.
- Held-out cities (Barcelona, Miami, Tokyo): **R² 0.837**, **MAE 5.81**,
  **85.1% within 15 points**, vs an 0.790 / 6.09 baseline.
- Every number above is read from
  `backend/scripts/ml/models/model_metadata.json`. Quote it, not this table —
  and re-run the incumbent on the same holdout before claiming an improvement,
  because the baselines have matured over time and old figures are not
  comparable.
- Venues the model doesn't know yet (no baseline, no popular-times signal)
  are answered by the rule engine in `crowdEngine.js` instead of guessing.

> ⚠️ **`crowd_model.onnx` is tracked in git and does deploy — but `.gitignore`
> line 48 names it anyway.** The rule is inert only because the file was committed
> before it existed, and `.gitignore` never applies to already-tracked paths
> (confirmed 2026-08-14: `git ls-files` lists both the 11 MB `.onnx` and
> `model_metadata.json`). It is a live trap. If anyone ever runs
> `git rm --cached` on it, or the file is re-added in a fresh clone, the rule
> activates and the model silently stops shipping — after which production serves
> the rule engine forever, announced by nothing but one `console.log` in
> `mlPredictor.js`. **Delete line 48 or negate it**, so the file's intent and
> git's behavior agree.

The difference from busyness charts elsewhere: those measure who already
showed up. Flock's venue votes also capture which venues groups are
*considering* right now, which is the signal the venue side of the business
is built on (see `MONEY-MODEL.md` and `VENUE-BILLING.md`).

## Stack

React 19 (CRA) on Vercel · Node + Express on Railway · PostgreSQL ·
Socket.io · JWT auth (email, Google, Sign in with Apple) · Capacitor 8 for iOS ·
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
│   └── scripts/ml/    # Training pipeline + committed ONNX model artifacts (see warning)
├── flock-sensor/      # Raspberry Pi occupancy sensor pipeline (proven, hardware pending)
└── mobile/            # React Native port (not the launch path)
```

## Hard invariants (do not break)

1. **Other people's** budget amounts never leave the server. A client only ever
   sees the aggregate `{ ceiling, submissionCount, isReady, skipCount }`, plus
   the amount that caller submitted themselves. `ceiling` is withheld entirely
   until at least three non-skipped submissions exist, so a two-person flock
   cannot be used to read one person's number by subtraction.
2. No secrets in the repo, ever. All keys live in the Vercel / Railway /
   Codemagic dashboards. A gitleaks pre-commit hook enforces this.
3. Server-side enforcement behind every client gate. Frontend gating is UX,
   not security.
4. Nothing on any marketing surface may claim a feature that doesn't ship
   (`SLOP-AUDIT.md` is the standing design + copy standard).

## Repo docs

| File | What |
|---|---|
| `SLOP-AUDIT.md` | Design/copy standard + per-rule audit status |
| `MONEY-MODEL.md` | Monetization reality: venue B2B first, consumer Pro later |
| `PAYWALL-DECISION.md` | **The current decision memo on when to charge anyone.** Sourced; supersedes the timing language in `PAYWALL.md` and `MONEY-MODEL.md` |
| `VENUE-BILLING.md` | Venue subscriptions. Tier enforcement is built; the Stripe half is a design spec with no code. Authoritative on price: $35 Premium / $75 Pro, FINAL as of 2026-08-14 (matches the app) |
| `PAYWALL.md` | Consumer Flock Pro operator runbook. The client, webhook and kill switch are built and dormant; **none of the runbook's dashboard steps have been executed** |
| `BACKUP-AND-VERIFICATION.md` | Backup/restore research memo, not a runbook |
| `SUBMIT-CHECKLIST.md` | App Store submission: assets, ordered steps, privacy labels — **the current submission doc** |
| `SUBMISSION-PACKET.md` · `TESTFLIGHT_TEST_INFO.md` | Paste-ready store metadata + TestFlight reviewer notes |
| `SUBMISSION.md` · `STAGING.md` · `ADVERSARIAL-REVIEW.md` | Older compliance-era docs. Partly superseded — each carries a status banner |
| `DOMAIN.md` | flockcorp.com DNS cutover runbook (done 2026-08-12) |
| `PRODUCT.md` | Nav model + design intent |
| `PUSH-SETUP.md` | FCM / APNs console steps |
| `backend/scripts/ml/RETRAIN.md` | Crowd-model retrain runbook + ship gate |
| `codemagic.yaml` | iOS CI: build, sign, auto-increment, TestFlight |

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

Both `.env.example` files list every variable the code actually reads, with a
line per variable saying what breaks when it is missing. Several fail *open*
(image moderation, NFC trust, admin provisioning) — read those before deploying.

`backend/db/migrate.js` runs every file in `backend/migrations/` in filename
order before `server.listen()`, inside an advisory lock, recording what it applied
in `schema_migrations`; a failure exits the process rather than serving a
half-migrated schema. `migrations/000_bootstrap.sql` carries the core
`CREATE TABLE`s, so **a fresh database boots from migrations alone** — no manual
schema step. `backend/database/schema.sql` is the same content kept separately,
and `npm run db:init` applies it directly if you want it explicit.

Migrations run 000 through 018 and are still being added (017 and 018 landed on
2026-08-14). **There is no 010** — the number was skipped, not lost. As of
2026-08-14 `015_password_reset.sql` is untracked in git along with the
password-reset UI, so a deploy from HEAD does not have that feature.

Backend tests: `cd backend && node --test` · local E2E: `npm run e2e`

---

Built by Jayden Bansal, Bethlehem PA.
