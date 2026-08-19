# How Flock Makes Money — plain English

Written 2026-08-11. Backed by 2024–2026 industry data (RevenueCat State of Subscription
Apps, Apple, Google, Snapchat+, BeReal, Gas). This is the honest version, not the hype version.

> **Reconciled 2026-08-14.** `PAYWALL-DECISION.md` is the newer, sourced, and
> **authoritative** memo on consumer-paywall timing; where this file and that
> one differ, that one wins. It agrees with the conclusion below (venue B2B
> first, consumer sub later) and sharpens it into four measurable trigger
> conditions. Two things here have changed since 2026-08-11:
>
> - **Reason 2 below is out of date on the legal point.** The Apple Developer
>   under-18 status is no longer a blocker on the Apple side: the account is
>   held by an adult (`PAYWALL-DECISION.md`, 2026-08-14 correction). It is
>   still a blocker on the Stripe/venue side, where no account exists yet. What
>   remains true is the *product* point: teen purchases route through a parent's
>   card and Ask to Buy, so a $24.99 annual charge is an "ask a parent" conversation.
> - **Venue prices are decided and FINAL as of 2026-08-14: $35/mo Premium and
>   $75/mo Pro.** `VENUE-BILLING.md` carries the decision; these are the numbers
>   the app has always displayed, and the decision resolved the old conflict in
>   the app's favor (an earlier draft of this banner pointed the other way).
>   The venue-count math below is recomputed at the real prices: clearing
>   $1,000/month takes 14 venues all on Pro ($75 x 14 = $1,050), 29 all on
>   Premium ($35 x 29 = $1,015), or about 19 at an even mix ($55 x 19 = $1,045).
>   The old "roughly ten venues" framing came from the superseded higher-price
>   proposal and understates the count at the decided prices.

> **Fact-checked again 2026-08-18, the day this repo was published under
> PolyForm Noncommercial 1.0.0 and strangers could start reading it.** Every
> price, meter, route and flag below was re-read against the code that day.
> Four things were wrong and are corrected inline: the RevenueCat "$1,000 a
> month" statistic is a **first-year** figure, not a two-year one; the
> annual-churn line now uses the sourced 25% renewal rate instead of an
> invented ~70%; the venue tier that the unbuilt ad features hang off is
> called **Pro**, not "Boost" (that name died with the superseded higher-price
> proposal); and both kill switches are still off, so *nothing is metered and
> no tier is enforced today*. **Nobody has ever been charged on either path.**

---

## The 30-second answer

**Your idea:** let people see the AI "how busy is this venue / best time to go" forecast
10 times a month for free; after that they pay **$25/year** to keep seeing it.

**Does it make money?** The plumbing is built, though nothing is purchasable yet — the Paid
Applications agreement is unsigned, no App Store Connect products exist, and `PAYWALL_ENABLED`
is unset (`PAYWALL.md` §1, `APP-STORE-SUBMISSION.md`). Even once all of that is done, as the
*only* way you make money, it will make roughly **$0 until Flock has tens of thousands of
users**, for three honest reasons:

1. **You're selling something Google gives away.** Google Maps shows "Popular Times" and
   live busyness for free on almost every bar. If the free version is two taps away, people
   won't pay for yours unless yours is *obviously* better.
2. **Your users are 15–22 and mostly can't do a $25 annual charge alone.** In a family
   group the organizer's card pays, Ask to Buy can be switched on at any time, and the
   charge shows on a parent's receipt either way, so $25 upfront is an "ask a parent"
   conversation. A small **monthly** price fits a gift-card balance; a big annual one
   doesn't. (This is about the *buyer*, not about who owns the developer account —
   that is settled, see the banner above.)
3. **The math needs users you don't have yet.** See below — even the optimistic version needs
   ~14,000 monthly active users to net ~$1,000/month. Flock has ~0 today. **The paywall isn't
   the bottleneck — getting users is.**

**So what do we do?** Keep the paywall built and **dark** — it is the right *plumbing*, and
"ship it" here means ship the code, not flip `PAYWALL_ENABLED`. **The money you can actually
make right now is on the venue side** — you already built the venue-owner dashboard. Fourteen
bars on the $75 Pro tier clears your $1k/month goal (about 19 at an even $35 Premium / $75 Pro
mix — see the banner above for the arithmetic), with *zero* consumer users required, and it
makes the app *better* for users (deals) instead of worse (paywalls). Two honest asterisks on
that sentence, both spelled out below: there is **no way to charge a venue yet** (no Stripe
code exists), and the features that separate $75 Pro from $35 Premium are **not built**, so the
sellable product today is Premium.

---

## The funnel math (why 5-figure users is the real number)

At **$25/yr**, Apple takes 15% (Small Business Program, under $1M/yr — enrolling is step 1a in
`PAYWALL.md` and has not been done yet; at the standard 30% every number below halves) → you net
**~$21/sub/yr ≈ $1.77/sub/month**.

| You want (net) | Paying subs needed | If 4% of users pay | If 2% pay | Realistic (~0.5–1%)* |
|---|---|---|---|---|
| **$1,000 / month** | ~565 | ~14,000 users | ~28,000 users | **~56,000–113,000 users** |
| **$5,000 / month** | ~2,825 | ~71,000 users | ~141,000 users | ~283,000–565,000 users |

\* Why under 1% is the honest number: the "2–4% pay" benchmark is for people who actually hit
the paywall. Only heavy forecast-users (>10/month) ever see your wall — maybe 10–25% of users —
and only a few percent of *those* pay, on a teen base with payment friction. Multiply it out and
it's well under 1% of all users. On top of that, annual renewal in the Social/Lifestyle
category runs about **25%** (RevenueCat renewal-rate benchmarks, cited in
`PAYWALL-DECISION.md` §1), so roughly three quarters of those 565 subs have to be re-won every
single year just to stay flat.

Industry reality check: only **17.2% of subscription apps ever reach $1,000/month in their first
year** (RevenueCat, *State of Subscription Apps 2024*). This file used to say "within two years",
which is not what the report measures.

---

## What the evidence says about each piece

- **Metering one feature is weak; bundles win.** Snapchat+ sells a *pile* of small perks — badges,
  customization, early features — not one metered lookup. A wall on forecasts alone gives someone
  exactly one reason to pay, and that reason has a free substitute.
  (Figure updated 2026-08-14: this said "15M+ subscribers". Snapchat+ passed **25M** as of
  Feb 2026 per the sourcing in `PAYWALL-DECISION.md` §2. It is still only ~13% of Snap's revenue,
  and it launched in Snap's *eleventh* year — which is the point being made here, not the count.)
- **$25/yr as a number is fine; annual-upfront for teens is the problem.** Snapchat+ is $3.99/mo **or**
  $29.99/yr — lead with **monthly** for a 15–22 audience. Gift-card balances and parental approval
  make a small monthly charge far easier to complete than $25 in one hit.
- ~~**Gen Z *does* pay for social apps** (about 23% of young Gen Z pay for at least one).~~
  **Retracted 2026-08-14.** `PAYWALL-DECISION.md` §2 traced that 23% to Bango, which defines Gen Z
  as **ages 18–25 — legal adults with their own cards**. It is not a teen number and must not be
  used as one. There is **no published survey of 13–17 year olds' app-subscription spending**; any
  teen willingness-to-pay estimate here is extrapolation. What survives from this bullet is the
  qualitative half, which the comparable-app evidence does support: where young people do pay for
  social apps, they pay for **status and identity**, not utility meters. Dating apps meter utility
  to Gen Z and are shrinking.
- **Crowd forecast is a great retention feature and a fine perk inside Pro — a weak sole paywall.**
  It becomes defensible only if it's something Google can't do: *"3 of your friends' groups are
  headed there tonight"* / *"best time for YOUR group given everyone's votes."* That uses Flock's
  real private data (plans + votes), which Google will never have.

---

## The plan we're shipping (and what to do next)

**Now — Flock Pro (built, dormant behind a kill switch):**
- **$3.99/month** (lead with this) or **$24.99/year** with a 7-day free trial — mirrors Snapchat+.
  (`PAYWALL-DECISION.md` §4 argues for $29.99/year instead; not yet decided.)
- Free limits that *nudge* toward Pro (not a single wall). What the code will meter **the day
  the flag flips** — re-read 2026-08-18, and with `PAYWALL_ENABLED` unset none of it is metered
  today, every user gets the unmetered behaviour:
  - **AI crowd forecast: 10 views/month free**, then Pro
    (`backend/services/forecastUsage.js`; the gate is `forecastAccess`/`gateForecast` in
    `backend/routes/crowd.js`, which returns unmetered access outright while the flag is off).
    The "how busy is it right now" score is never metered.
  - **Birdie AI: 10 messages/day free, 150/day with Pro** (`backend/services/birdieUsage.js`,
    `FREE_DAILY_LIMIT` / `PREMIUM_DAILY_LIMIT`). Not unlimited — the paywall sheet says
    "150 Birdie messages a day, up from 10", and it must keep matching the code.
  - Proactive "go now / it's about to peak" venue alerts → Pro
    (`backend/services/crowdAlerts.js`, which narrows the recipient query to
    `is_premium = true` only when the flag is on).
  - ~~Pro badge / flair.~~ **Cut.** It was listed on the paywall sheet but never rendered
    anywhere, so it was removed rather than shipped as a lie.
- Both meters are **in-memory and reset on every deploy**. Fine as a nudge, not fine once
  someone pays to remove a limit. Back them with a table before flipping the wall.
- Everything core stays free (plans, chat, voting, SOS) — required for a social app to grow.
- Nothing charges anyone today, and the flag is only the last step: the Paid Applications
  agreement has to be signed, the two products created in App Store Connect, RevenueCat's
  `default` offering wired up, `REVENUECAT_WEBHOOK_SECRET` set (without it the webhook fails
  closed with a 503 and no purchase can ever grant Pro), and only then
  `PAYWALL_ENABLED=true`. Full setup in `PAYWALL.md`; the *timing* rules are in
  `PAYWALL-DECISION.md`.
- **Honest expectation: ~$0 until users are in the 5 figures.** Ship it to exercise the Apple
  billing pipe and to have it ready — not because it pays the bills yet.

**Next — where the real near-term money is, ranked:**
1. **Venue B2B (partly built — read this carefully, it is less finished than it sounds).**
   What is **real and demoable today** (collection would be by hand — `POST
   /api/admin/venues/:userId/tier` in `backend/routes/admin.js` is the only way to grant a
   venue a tier, and nothing expires it): a claimed venue profile with logo, promotions CRUD,
   events CRUD, reviews with owner reply, and the `incoming-flocks` feed (a real query over
   `venue_votes` — the "40 groups considered you Friday" pitch), all server-side gated by
   tier in `backend/routes/venueDashboard.js`. That enforcement is real server-side code
   (`backend/services/venueEntitlements.js`, fails closed on an unknown tier), but it sits
   behind its own kill switch, `VENUE_BILLING_ENABLED`, which is unset — so today every
   claimed venue acts Pro and nothing is actually withheld. What is **not built**: promoted
   placement in vote lists and "slow-night" push offers do not exist in the code, and there is
   **no Stripe integration at all** (no checkout, no webhook, no `stripe` dependency) —
   `VENUE-BILLING.md` is a design document, not a deployed system. Those two missing features
   are the entire difference between $75 Pro and $35 Premium, so **do not sell the Pro tier**
   on them. ("Boost" was the name for this tier in the superseded higher-price proposal; the
   tiers are `premium` and `pro`.)
   Fourteen Pro venues, or about 19 at an even Premium/Pro mix, covers the ~$1k/mo goal
   with *zero* consumer scale needed (see `VENUE-BILLING.md` for the $35 / $75 tiers,
   FINAL as of 2026-08-14, and the banner above for the arithmetic). This is the BeReal lesson:
   Gen-Z social apps monetize the *business* side, not user subscriptions. The honest caveat
   from `PAYWALL-DECISION.md` §5: venue value depends on groups considering venues, so B2B
   does not escape the no-users problem either — it just needs users in one city.
2. **Referral-gated Pro.** "Out of forecasts — invite 3 friends for a free month, or
   subscribe." At ~0 users, turning the wall into *distribution* is worth more than $1.77/mo.
   > **Flagged as a conflict, 2026-08-14.** This is an idea, not a plan: it is not built (no
   > referral system exists in the code), and "right now" contradicts `PAYWALL-DECISION.md`,
   > which says keep the wall dark until the trigger conditions fire. A referral gate is still
   > a gate. If you want the distribution effect without taxing the growth loop, the memo's
   > cheaper move is to instrument the funnel first (`paywall_shown`, `meter_capped`) so you
   > can see whether anyone reaches the cap at all before deciding what to put behind it.
3. **Grow "Flock Pro" into a status bundle later** (post ~1,000 users): plan themes, group
   superlatives/stats, priority polls — Snapchat+ playbook — with unlimited forecasts as one perk.

**Bottom line:** the subscription is good plumbing and a fine long-term perk bundle, but it is not
a pre-launch revenue engine. Put the energy into (1) getting users and (2) the venue dashboard —
that's the only path here that can pay before the app has scale.
