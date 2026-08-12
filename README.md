# Flock

**Plans die in the group chat. Flock is where they happen.**

Flock is a social planning app for going out with friends: start a flock,
invite your people, vote on where to go, match budgets privately, split the
bill, and get home safe. Free for users; the business is on the venue side.

- **Web:** https://flock-app-w65m.vercel.app (moving to https://flockcorp.com)
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
v2.2.1) with 95 features: time patterns, weather, nearby events, venue
category and popularity, per-venue baselines, and user feedback.

- Trained on **3.5M venue-hour observations across 31 cities**, validated
  leave-one-city-out.
- On fully held-out cities: **R² 0.752** vs 0.620 for the popular-times
  baseline it starts from, **MAE 5.16**, **89.1% of predictions within 15
  points** (metrics recorded in `backend/scripts/ml/models/model_metadata.json`).
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
| `SUBMIT-CHECKLIST.md` | App Store submission: assets, ordered steps, privacy labels |
| `DOMAIN.md` | flockcorp.com DNS cutover runbook |
| `codemagic.yaml` | iOS CI: build, sign, auto-increment, TestFlight |

## Running it

```bash
# backend (needs DATABASE_URL, JWT_SECRET, GOOGLE_PLACES_API_KEY, ... in .env)
cd backend && npm install && npm start

# frontend
cd frontend && npm install && npm start
```

Backend tests: `cd backend && node --test`

---

Built by Jayden Bansal, Bethlehem PA.
