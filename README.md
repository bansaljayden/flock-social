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
| Crowd intelligence | Each venue's own weekly curve, moved by its newest live readings (see below). Flock's own trained model (XGBoost v2.6.0, run in-process as ONNX) is ship-gated and serves again only when a retrain beats that. A rule engine covers venues with no baseline yet, and the response says which one answered |
| Birdie | AI assistant for venue ideas ("somewhere quiet and cheap nearby") |
| Venue sensor | Flux: a Raspberry Pi with a thermal camera, a doorway counter and a microphone. Counts people on the device with Owl, Flock's own trained vision model (see below), and sends counts only |
| Safety | Live location inside a flock (off by default, never background), two-tap SOS to trusted contacts, report + block, account deletion in-app (with re-authentication) |
| Venues | Venue dashboard on two plans. Free: profile, deals, events, reviews with owner reply, the incoming-flocks demand feed and the live busyness report. Roost: the venue's own forecast, the strip against nearby venues, the weekly summary, and Roost's cards and answers. The plan gate is server-side and switched off, and no venue has been charged |
| Social | Friends (codes + search), DMs, post-hangout feedback |
| Accounts | Email + Google + Sign in with Apple (iOS only), email verification, disposable-domain blocking. The website's sign-up asks a date of birth and the server refuses anyone under 13; the iPhone app asks for none and relies on the App Store's 13+ rating |

**Built and switched off:** billing. Roost, the venue plan, is sold through
Stripe checkout on flockcorp.com, and Flock Pro, the optional consumer
subscription, through Apple in the app and Stripe on the web. Both stay off
until their switches are set (`VENUE_BILLING_ENABLED`, `PAYWALL_ENABLED`), so
today every account outside a short review list gets the Pro limits and every
venue gets everything Roost has. `MONEY-MODEL.md` has the prices and what each
plan changes.

**Not built yet**, so nothing in this repo or on the site sells it:
promoted placement in vote lists, slow-night push offers, and any story UI.
Stories are a settled decision (2026-08-14): the backend routes exist and are
tested, no story surface will ship, and the client has zero callers by design.

Blocking used to be listed here as one-way. It is not any more: a Blocked-accounts
screen with a working unblock shipped on 2026-08-14, so report, block and unblock
are all real.

## The crowd model

Every venue card in Flock answers one question: how busy will it be when you
get there? The answer is a number from 0 to 100 and one of five words: Quiet,
Not Busy, Steady, Busy, Packed. Getting that word right is the whole job.

Map apps usually answer with a popular-times chart, the venue's typical level
for that weekday and hour. Flock starts from the same weekly pattern and
corrects it with the venue's own live readings. A collector reads the venues it
tracks in Philadelphia and the Lehigh Valley every hour, and those readings
build the corpus every future model learns from.

**Over a month of live readings, Flock named the exact crowd level 54.9% of the
time. The popular-times chart, scored on the same readings, managed 30.2%.** The
test ran from 9 September to 8 October 2026 and covered 119,939 live readings at
1,754 venues. Both were measured against a commercial provider's live busyness
estimates, and the weights served during the test were fitted on earlier days,
so none of these readings informed them.

| 119,939 live readings, 9 Sep to 8 Oct 2026 | popular-times chart | **Flock** |
|---|---|---|
| Names the exact crowd level | 30.2% | **54.9%** |
| Right, or one level off | 64.8% | **78.4%** |
| Within 10 points | 30.9% | **55.2%** |
| Average miss, out of 100 (MAE) | 26.40 | **18.00** |
| Average miss, in crowd levels | 1.155 | **0.772** |

That is a 31.8% smaller average miss, and the lead held on every day of the
week, Friday and Saturday included.

**The freshest reading is where the gain comes from.** On the 48.3% of readings
where the venue had also been read in the hour before, the served number named
the exact level 77.0% of the time and landed within one level 88.6% of the time.
Since 13 October production has used that finding as its rule: when the venue
was read in the past hour, the card shows that reading as it stands, and
otherwise it shows the curve plus the venue's offset, how far its recent live
readings have run above or below it.

The pre-registered retrain, set for early November, will test whether a trained
model can beat that number, under a decision rule fixed before its data existed.

### How the served number is built

Production runs `CROWD_SERVE_MODE=curve_offset` with `CROWD_NOWCAST_ENABLED=true`.
The base is the venue's own weekly curve plus 0.85 times its trailing offset: the
median gap between its newest live readings and that curve, counted only from
readings taken before the hour being scored. The nowcast then serves a reading
from the hour before at full weight (`NOWCAST_WEIGHTS` in
`backend/services/mlPredictor.js`). During the month above it also carried a
reading two hours old at 0.85 and one three hours old at 0.25. On the month's
14,778 two-hour readings that weight cost 2.73 points of MAE against the curve
plus offset alone, and the three-hour weight was a wash, so both went to zero on
13 October. On the same month the new rule scores about the same as the old one
(54.7% exact, MAE 17.68), but it was chosen on those readings, so they are no
test of it; the pre-registered retrain scores it next.

When the live feed goes quiet, the nowcast has no reading from the hour before
to serve, and the card shows the curve plus the offset. The offset keeps working
through the silence: it is the median gap between the curve and the venue's
newest 20 readings from the 28 days before the hour shown
(`trailingOffsetBefore`), so each reading ages
out on its own clock and the offset rests on fewer, older readings as the
silence goes on. Once fewer than two remain, 28 days after the venue's last
reading at the latest, the card shows the weekly curve alone. An earlier version
also dropped every offset seven days after the last collector run that wrote a
live reading; replayed over 28 earlier outages, that cost 3.75 points of exact
level on days 7 to 13 of a silence, so it was removed.

The labels are relative: the provider scales each venue's busyness from 0 to 100
within that venue, and the readings do not count people. The exact level leads
the table because within one level is easy to reach on these labels. Real
venue-hours bunch up at Quiet and Packed, so a constant answer of Not Busy lands
within one level 75.2% of the time while naming the exact level only 14.8% of
the time.

The arithmetic went live on 26 September, after a first test of three days
(4,183 readings, 6 to 8 September); the month above holds 29 times as many
readings. The measurements are recorded in `backend/scripts/ml/MODEL-METRICS.md`
and `backend/services/servedAccuracy.json`, and they reproduce with
`backend/scripts/ml/train/bandEval.js`.

A venue with no weekly curve yet is answered by the rule engine in
`crowdEngine.js` and tagged `predictionMethod: 'rule_engine'`, so every response
names the engine behind it and no rule-engine answer is ever presented as a
model output.

### The trained model

**Flock's own trained model beats the popular-times chart on every measure the
card is scored on.** It served the card until 26 September. Here it is against
the chart on 67,249 realtime crowd readings from the spring, the kind of reading
the card is judged against, in three cities the model never trained on (Miami,
Tokyo, Barcelona):

| 67,249 readings in three held-out cities | popular-times chart | **Flock's model** |
|---|---|---|
| Names the exact crowd level | 22.9% | **25.5%** |
| Right, or one level off | 57.7% | **62.0%** |
| Within 10 points | 19.2% | **20.7%** |
| Average miss, out of 100 (MAE) | 31.48 | **29.42** |
| Better than always guessing the average (R²) | no, −0.075 | **yes, +0.040** |

The model wins every row.

**How that compares.** The average miss drops from 31.48 to 29.42, a **6.5%
reduction in MAE**, and it is earned from the venue's attributes, the calendar,
the weather and nearby events alone. The closest published system, a 2023 ACM
SIGSPATIAL graph model ([BysGNN](https://arxiv.org/abs/2306.15927)), forecasts
hourly visits from the previous 24 hours of visits at every venue in a city.
Against a historical-average baseline its authors liken to Google Maps' popular
times graph, its MAE is 40% to 54% lower across five cities, and against last
week's value at the same hour it is 14% to 19% lower. Flock's model reaches its
6.5% with no recent reading of the venue in its feature set. The hourly
collector now asks for that reading for the venues it can poll in Philadelphia
and the Lehigh Valley, served venues first, and stores it when the vendor has
one, which makes it the next input the model gets.

**It is above zero at a granularity where the field often falls below it.** R²,
the coefficient of determination, is positive when a model's predictions carry
more information than the mean of the data and negative when they carry less.
The popular-times chart scores **−0.075** on these venues. Flock's model scores
**+0.040**, a gain of **R² +0.115** over the baseline it replaces. The closest
peer-reviewed occupancy study
([Bollenbach et al. 2024](https://doi.org/10.1007/s40558-024-00291-2)) reports R²
near zero and often below it, down to **−1.26**, for single beach sections a day
or more ahead. One venue at one hour is the hardest granularity this problem
has, and Flock's model is above zero at it.

**Nothing ships without clearing the gate.** The ship gate is four criteria
fixed before the training run, scored on the served holdout population, and
`mlPredictor.init()` refuses to load an artifact that fails any of them: the
backend serves the rule engine instead and logs why. The criteria are R² up by
0.10 or MAE down by 5 against the popular-times baseline (v2.6.0: R² +0.115,
MAE −2.06), no MAE regression against that baseline, a within-10 hit rate at or
above the previous shipped model's, measured on the same rows in the same run
(20.7% against 19.3%), and no MAE regression against that model (29.42 against
30.77). Candidate and incumbent are scored on identical rows with identical
features, so the floor rises whenever the incumbent improves. Since late
September a second gate stands behind the first: the candidate and the number
production serves are replayed through the serving code on a 14-day window of
live readings held out of the candidate's training. The candidate loads only if
it beats the served number on within one level, gives up no more than a point to
it on within 10 or MAE, beats the popular-times chart, and keeps every city with
300 or more readings within 2 points.

**How it works.** In model mode (`CROWD_SERVE_MODE=model`),
`backend/services/mlPredictor.js` serves an XGBoost model (800 gradient-boosted
trees at depth 8, exported to ONNX and run in-process by `onnxruntime-node`,
**v2.6.0 "Starling"**). Production runs `curve_offset` today, and a retrain has
to beat the served number above before model mode serves again. The corpus is
Flock's own: **3.9 million rows across 34 cities**, collected by Flock's
pipeline. After holding out three whole cities and keeping the rows with a
usable baseline, that is **1.93 million training rows across 30 cities**. The
model reads **106 features**: time patterns, weather, nearby events, holiday
calendars, venue category and popularity, and the typical level for that kind
of venue and for its neighbors at that hour. It predicts a *delta*, how far a
venue will sit from its own typical value for that hour, and in model mode the
served score is the baseline plus that delta, clamped and clipped to 0 to 100.
Training runs on CPU with pinned threads and is **bit-reproducible**: given the
same data and seed, two runs produce identical predictions, so the artifact can
be regenerated by anyone holding the corpus.

**It transfers to cities it has never seen.** The train/holdout split is by
whole city, cross-validation is leave-one-city-out across the 30 training
cities, and no row-level split exists anywhere. The model beats the
popular-times chart in each held-out city, by 2.26 points of MAE in Miami, 2.21
in Barcelona and 1.72 in Tokyo. Those three cities have been the holdout since
March and every version from v2.2 on was gated on them, so they serve as a
validation set; the pre-registered retrain adds a time holdout.

**How collection works.** A collector runs on an hourly cron across the served
geography, Philadelphia and the Lehigh Valley. Each run asks the vendor about
the active venues open at that hour, served venues first within a fifty-minute
budget, and stores the live readings it gets back: a few thousand
provenance-verified readings a day over the month of the test. Every row it
writes records whether its label is a live reading or the vendor's forecast,
with the vendor's forecast for the same moment kept beside it, and each run
reads back what it wrote and refuses to exit clean if any row it committed is
unlabelled.

**Where the next gain comes from.** The binding input is evidence density: the
spring corpus holds about 25 realtime readings per venue across 168 weekly
slots, so the model reads a kind of venue on a Tuesday at 9pm better than it
reads one particular venue departing from its own pattern. The month-long test
points the same way: a venue's latest reading is worth more than any correction
to its curve, so how often a venue is read matters more than how long its
history is. The pre-registered retrain is the first on live rows that all carry
verified provenance with measured event and weather features, and an autumn
month in the climate table.

> **The trained model is not distributed with this source.** `crowd_model.onnx`
> and `model_metadata.json` are Flock's own artifacts, built from Flock's own
> collected data, and they are not published. Everything that produced them is
> here: the collection scripts in `backend/scripts/ml/`, the training pipeline
> in `backend/scripts/ml/train/`, and the runbook in
> `backend/scripts/ml/RETRAIN.md`. See `backend/scripts/ml/models/README.md` for
> how to train your own from your own data.
>
> With no artifact on disk, `mlPredictor.js` logs
> `Model files not found — using rule engine` once at boot and every prediction
> is answered by `crowdEngine.js`. That is a designed path: a clone of this repo
> serves the rule engine, and the ML test suites in `backend/__tests__/` read
> the artifacts directly and need them present to pass.

The difference from busyness charts elsewhere: those measure who already showed
up. Flock's venue votes also capture which venues groups are *considering* right
now, which is the signal the venue side of the business is built on.

## The sensor's people counter

**Flux, Flock's venue sensor, counts people with its own trained vision model,
Owl, running on the device. On real thermal footage it has never seen, it
counts a room exactly right up to ten times as often as the heat-threshold
method it replaced.**

Owl reads the 160 by 120 grid of temperatures from the sensor's thermal camera
and puts a point on every person and a box and a name on every other warm
thing: a hand at the lens, a pet, a hot drink, food, a laptop, a screen, a
heater, a lamp, a seat somebody just left. Only people are counted. Scored on
the held-out test splits of six real thermal datasets, footage it never
trained on, the first two from the very camera Flux uses:

| Real test set | the heat-threshold rule | **Owl** |
|---|---|---|
| **Flux's own camera** (FLIR Lepton 3.5, indoor rooms), 2,000 frames | 77.1% exact | **89.7% exact, 100% within one** |
| **Flux's own camera in a crowded classroom and lab**, rows of up to ten people half hidden behind the row in front, 1,375 frames, 4,882 people | 33.0% exact | **39.3% exact, 73.9% within one; rooms of six to ten within one 96% of the time** |
| Ceiling camera, 2,347 frames, 8,043 people | 9.2% exact | **92.9% exact, 99.7% within one** |
| Low-resolution rooms with hot laptops, 265 frames | 71.3% exact | **95.5% exact, 100% within one** |
| Wall-mounted meeting rooms, 813 frames, 1,061 people | 51.5% exact | **93.0% exact, 99.1% within one** |
| Side view, 2,151 frames, 3,872 people | 36.6% exact | **82.1% exact, 96.3% within one** |

The crowded rooms are the hardest test there is for a camera this small, and
the one Owl improved on most: before it trained on them it was off by almost
five people a frame there, and now by one. The Lepton 3.5 frames are from the
SDT dataset of the Computer Vision Lab at TU Wien (C. Pramerdorfer, J.
Strohmayer and M. Kampel, "SDT: A Synthetic Multi-Modal Dataset for Person
Detection and Pose Classification", IEEE ICIP 2020) and the Thermal Vision
dataset of IISER Bhopal (A. Samal and H. R. Lone, "Thermal vision: Pioneering
non-invasive temperature tracking in congested spaces", Smart Health 36, 2025),
both used to train and evaluate Owl with their authors' permission.

**It knows what is not a person.** The old rule counted warm regions, so a hand
held up to the lens was a person and spread fingers were two. A stress test
builds forty-one hard situations on purpose and scores each alone, averaging
95%: a hand at the lens, a hot mug, a monitor, a radiator, a pet, a reflection
in glass, warm footprints, a candle and an empty room each come out right 96 to
100% of the time, where the rule managed 8 to 85%.

**It runs on the sensor, in 16 ms.** 718,550 parameters, a CenterNet-style
network with a head map per kind of thing and a box head, exported to ONNX and
run by ONNX Runtime on one Raspberry Pi 5 core, fast enough to read every frame
the camera sends. When it sees a crowd, a second model counts the frame again
with a density head whose total does not fall when heads touch: in a crowd of
ten that doubles how often the count lands within one. It learns from millions of generated thermal frames drawn
with measured physics (skin follows the room, clothing sits a measured share of
the way from room to skin, fur is cool and eyes are hot) through this camera's
optics and noise, mixed with real frames from four commercially licensed public
datasets and two research datasets used with their authors' permission, and it
is chosen on real footage, never on its own drawings.

**It counts, and never watches.** Owl names kinds of things, never who anyone
is. Every frame is read on its own and forgotten, nothing about it follows a
person from one frame to the next, and what leaves the sensor is a handful of
counts. Tests in `flock-sensor/test_main.py` fail the build if any of that
stops being true.

> Like the crowd model, the trained artifact is Flock's own and not published.
> The generator, the network, the training and grading scripts are in
> `flock-sensor/training/`; with no model on disk the sensor counts with the
> heat-threshold rule and says so.

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
└── tools/             # deployment and App Store Connect helpers
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
| `VENUE-BILLING.md` | Venue subscriptions. Plan enforcement and Stripe billing are both built and switched off behind `VENUE_BILLING_ENABLED`. Authoritative on the venue price: a free venue account, and Roost at $99/month or $990/year per location with a 14-day trial (matches VENUE_PLAN_PRICE in the app and Terms 9.6) |
| `MODERATION-LEGAL.md` | Moderation and legal commitments the code must keep |
| `BACKUP-AND-VERIFICATION.md` | Backup and restore: what is verified, what is only researched |
| `SUBMIT-CHECKLIST.md` | App Store submission: assets, ordered steps, privacy labels |
| `backend/scripts/ml/RETRAIN.md` | Crowd-model retrain runbook and ship gate |
| `backend/scripts/ml/MODEL-METRICS.md` | Measured model numbers and what they mean |
| `codemagic.yaml` | iOS CI: build, sign, auto-increment, TestFlight |
| `LICENSE` / `CONTRIBUTING.md` | MIT License, and how contributions are accepted under it |

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

[MIT](LICENSE). Use it, change it, ship it, sell it; keep the copyright and
permission notice with any copy.

---

Built by Jayden Bansal, Bethlehem PA.
