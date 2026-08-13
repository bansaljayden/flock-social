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
| Safety | Live location inside a flock (off by default, never background), one-tap SOS to trusted contacts, report + block, account deletion in-app |
| Venues | Venue dashboard: profile, promotions, events, reviews with owner reply, incoming-flocks demand feed |
| Social | Friends (codes + search), DMs, stories, post-hangout feedback |

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

The difference from busyness charts elsewhere: those measure who already
showed up. Flock's venue votes also capture which venues groups are
*considering* right now, which is the signal the venue side of the business
is built on (see `MONEY-MODEL.md` and `VENUE-BILLING.md`).

## Stack

React 19 (CRA) on Vercel · Node + Express on Railway · PostgreSQL ·
Socket.io · JWT auth · Capacitor 8 for iOS · RevenueCat + Apple IAP (consumer,
dormant behind a flag) · Google Places, OpenWeatherMap, Ticketmaster, Resend,
FCM. Type: Fraunces (display) + Hanken Grotesk (body), self-hosted.

```
flock-app/
├── frontend/          # React app + marketing site (frontend/src/website)
│   └── ios/           # Capacitor iOS shell (built by Codemagic → TestFlight)
├── backend/           # Express API + Socket.io + ML predictor
│   └── scripts/ml/    # Training pipeline + committed ONNX model artifacts
├── flock-sensor/      # Raspberry Pi occupancy sensor pipeline (proven, hardware pending)
└── mobile/            # React Native port (not the launch path)
```

## Hard invariants (do not break)

1. Individual budget amounts never leave the server. Clients only ever see
   `{ ceiling, submissionCount, isReady, skipCount }`.
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
| `VENUE-BILLING.md` | Stripe plan for venue subscriptions (designed, not built) |
| `PAYWALL.md` | Consumer Flock Pro runbook (built, dormant behind `PAYWALL_ENABLED`) |
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
psql "$DATABASE_URL" -f database/schema.sql   # base tables; migrations run on boot
npm start

# frontend
cd frontend && cp .env.example .env
npm install && npm start
```

Both `.env.example` files list every variable the code actually reads, with a
line per variable saying what breaks when it is missing. Several fail *open*
(image moderation, admin provisioning) — read those before deploying.

The base tables live in `backend/database/schema.sql`; the numbered files in
`backend/migrations/` only ALTER them, so a fresh database needs the schema
applied once first. `npm run db:init` does exactly that.

Backend tests: `cd backend && node --test` · local E2E: `npm run e2e`

---

Built by Jayden Bansal, Bethlehem PA.
