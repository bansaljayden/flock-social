# How Flock Makes Money — plain English

Written 2026-08-11. Backed by 2024–2026 industry data (RevenueCat State of Subscription
Apps, Apple, Google, Snapchat+, BeReal, Gas). This is the honest version, not the hype version.

---

## The 30-second answer

**Your idea:** let people see the AI "how busy is this venue / best time to go" forecast
10 times a month for free; after that they pay **$25/year** to keep seeing it.

**Does it make money?** The plumbing is built and it *can* charge people — but as the
*only* way you make money, it will make roughly **$0 until Flock has tens of thousands of
users**, for three honest reasons:

1. **You're selling something Google gives away.** Google Maps shows "Popular Times" and
   live busyness for free on almost every bar. If the free version is two taps away, people
   won't pay for yours unless yours is *obviously* better.
2. **Your users are 15–22 and mostly can't do a $25 annual charge alone.** Under-18 Apple
   accounts need a parent to approve every purchase, and $25 upfront is an "ask a parent"
   conversation. A small **monthly** price fits a gift-card balance; a big annual one doesn't.
3. **The math needs users you don't have yet.** See below — even the optimistic version needs
   ~14,000 monthly active users to net ~$1,000/month. Flock has ~0 today. **The paywall isn't
   the bottleneck — getting users is.**

**So what do we do?** Ship the paywall (it's done and it's the right *plumbing*), but treat it
as a nudge, not the business. **The money you can actually make right now is on the venue side**
— you already built the venue-owner dashboard. Ten bars paying ~$99/month ≈ your $1k/month
goal, with *zero* consumer users required, and it makes the app *better* for users (deals)
instead of worse (paywalls).

---

## The funnel math (why 5-figure users is the real number)

At **$25/yr**, Apple takes 15% (Small Business Program, under $1M/yr) → you net **~$21/sub/yr ≈ $1.77/sub/month**.

| You want (net) | Paying subs needed | If 4% of users pay | If 2% pay | Realistic (~0.5–1%)* |
|---|---|---|---|---|
| **$1,000 / month** | ~565 | ~14,000 users | ~28,000 users | **~56,000–113,000 users** |
| **$5,000 / month** | ~2,825 | ~71,000 users | ~141,000 users | ~283,000–565,000 users |

\* Why under 1% is the honest number: the "2–4% pay" benchmark is for people who actually hit
the paywall. Only heavy forecast-users (>10/month) ever see your wall — maybe 10–25% of users —
and only a few percent of *those* pay, on a teen base with payment friction. Multiply it out and
it's well under 1% of all users. On top of that, ~70% of annual subscribers don't renew year two,
so you have to re-win most of those 565 subs every single year just to stay flat.

Industry reality check: only **17% of new subscription apps ever reach $1,000/month** within two
years (RevenueCat, 2024–2026).

---

## What the evidence says about each piece

- **Metering one feature is weak; bundles win.** Snapchat+ (15M+ subscribers at $3.99/mo) sells a
  *pile* of small perks — badges, customization, early features — not one metered lookup. A wall on
  forecasts alone gives someone exactly one reason to pay, and that reason has a free substitute.
- **$25/yr as a number is fine; annual-upfront for teens is the problem.** Snapchat+ is $3.99/mo **or**
  $29.99/yr — lead with **monthly** for a 15–22 audience. Gift-card balances and parental approval
  make a small monthly charge far easier to complete than $25 in one hit.
- **Gen Z *does* pay for social apps** (about 23% of young Gen Z pay for at least one) — but for
  **status and identity**, not utility meters. Dating apps meter utility to Gen Z and are shrinking.
- **Crowd forecast is a great retention feature and a fine perk inside Pro — a weak sole paywall.**
  It becomes defensible only if it's something Google can't do: *"3 of your friends' groups are
  headed there tonight"* / *"best time for YOUR group given everyone's votes."* That uses Flock's
  real private data (plans + votes), which Google will never have.

---

## The plan we're shipping (and what to do next)

**Now — Flock Pro (built, dormant behind a kill switch):**
- **$3.99/month** (lead with this) or **$24.99/year** with a 7-day free trial — mirrors Snapchat+.
- Free limits that *nudge* toward Pro (not a single wall):
  - **AI crowd forecast: 10 views/month free**, then Pro (your idea — kept as the nudge).
  - **Birdie AI: 10 messages/day free**, unlimited with Pro.
  - Proactive "go now / it's about to peak" venue alerts → Pro.
  - Pro badge / flair.
- Everything core stays free (plans, chat, voting, SOS) — required for a social app to grow.
- Nothing charges anyone until you flip `PAYWALL_ENABLED=true`. Full setup in `PAYWALL.md`.
- **Honest expectation: ~$0 until users are in the 5 figures.** Ship it to exercise the Apple
  billing pipe and to have it ready — not because it pays the bills yet.

**Next — where the real near-term money is, ranked:**
1. **Venue B2B (already half-built).** Sell bars/clubs promoted placement in the vote list,
   "slow-night" push offers to nearby groups, and analytics ("40 groups considered you Friday").
   ~10 venues at ~$99/mo ≈ $1k/mo with *zero* consumer scale needed. This is the BeReal lesson:
   Gen-Z social apps monetize the *business* side, not user subscriptions.
2. **Referral-gated Pro, right now.** "Out of forecasts — invite 3 friends for a free month, or
   subscribe." At ~0 users, turning the wall into *distribution* is worth more than $1.77/mo.
3. **Grow "Flock Pro" into a status bundle later** (post ~1,000 users): plan themes, group
   superlatives/stats, priority polls — Snapchat+ playbook — with unlimited forecasts as one perk.

**Bottom line:** the subscription is good plumbing and a fine long-term perk bundle, but it is not
a pre-launch revenue engine. Put the energy into (1) getting users and (2) the venue dashboard —
that's the only path here that can pay before the app has scale.
