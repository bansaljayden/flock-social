# How Flock makes money

Flock is free to use. Planning, chat, voting, budget matching, bill splitting
and SOS cost nothing on any plan, because a social app that charges for the
social part does not grow. Money comes from two optional plans, one for people
and one for venues. Both are built. Both are switched off, and this file
explains why and what would switch them on.

Industry figures below come from RevenueCat's State of Subscription Apps, Apple,
Google and the published numbers of comparable apps (Snapchat+, BeReal, Gas).

## The two plans

**Flock Pro, for people.** Flock Pro costs $3.99 a month or $29.99 a year, with
no free trial. It is sold through Apple in the iOS app (RevenueCat) and through
Stripe on flockcorp.com/pro. Once the paywall is on, it changes three things:

| | Free account | Flock Pro |
|---|---|---|
| Birdie, the in-app assistant | 10 messages a day | 150 messages a day |
| Crowd levels and forecasts | 30 different venues a month | No venue limit |
| A heads-up push before a planned venue gets packed | No | Yes |

The limits live in `backend/services/birdieUsage.js` (`FREE_DAILY_LIMIT`,
`PREMIUM_DAILY_LIMIT`) and `backend/services/forecastUsage.js`
(`FREE_MONTHLY_FORECASTS`). The venue meter covers the live crowd level as well
as the forecast: a free account sees both for 30 different venues each calendar
month, and a venue it has already opened that month stays open. Both meters are
stored in Postgres (`usage_meters`, migration 075), so a deploy does not reset
them. A new account with a confirmed email gets the Pro limits for its first
week, once per person (`backend/services/entitlements.js`).

**Roost, for venues.** A venue account is free: the claimed listing, replies to
reviews, the live 0 to 100 busyness report, deals, events, and the feed of
groups that have the venue in their plans. Roost is the paid plan. Roost costs
$99 a month or $990 a year per location, with a 14-day free trial that needs a
card, bought on flockcorp.com through Stripe by a verified venue. It adds what
Flock can tell an owner about their own room: the venue's forecast by the hour
and a week out, the strip against the venues around it, the weekly summary,
Roost's cards and answers, and a Monday digest by email. Paying never changes
what a Flock user sees: no placement, ranking or label is for sale.

**Both are switched off today.** `PAYWALL_ENABLED` is unset, so every account
gets 150 Birdie messages a day and crowd levels for every venue, apart from a
short review list of named test accounts that meets the real limits
(`PAYWALL_PREVIEW_USER_IDS`).
`VENUE_BILLING_ENABLED` is unset, so every venue gets everything Roost has and
no venue has been charged. A venue account created before September 25, 2026
is emailed at least 30 days before Roost can charge it anything (Terms 9.6).

## Why venues first

The consumer plan, as the only way to make money, earns roughly nothing until
Flock has tens of thousands of users, for three reasons.

1. **Google gives the core feature away.** Google Maps shows popular times and
   live busyness for almost every bar. People will not pay for Flock's version
   unless it is obviously better, and the free one is two taps away.
2. **Most of the audience cannot pay alone.** Users are 15 to 22. A teen's
   purchase runs through a parent's card, Family Sharing or Ask to Buy, so a
   yearly charge becomes an "ask a parent" conversation. A small monthly price
   fits a gift-card balance far better, which is why the monthly plan leads.
3. **The arithmetic needs users Flock does not have yet** (next section).

Venues are a better first customer. A bar that sees which groups are
considering it, and how busy it will be on Friday, can make money from that
this week, with no consumer scale required. Eleven venues on Roost clear
$1,000 a month: $99 x 11 = $1,089, before Stripe's fees, where ten fall just
short at $990. The honest caveat is that venue value still depends on groups
using Flock in the venue's own city. Venue billing does not escape the
no-users problem; it only needs users in one city instead of everywhere.

## The consumer arithmetic

Apple's Small Business Program takes 15% (enrolment is a step in the App Store
setup; at the standard 30% every figure below roughly doubles). The yearly plan
then nets about $25.49 per subscriber, or $2.12 a month. The monthly plan nets
about $3.39 a month.

| Net per month | Yearly subscribers needed | Users needed if 2% pay | If 0.5% to 1% pay |
|---|---|---|---|
| $1,000 | about 471 | about 24,000 | about 47,000 to 94,000 |
| $5,000 | about 2,354 | about 118,000 | about 235,000 to 471,000 |

Why under 1% is the realistic column: the "2 to 4% of users pay" benchmark
counts people who reach a paywall. Only frequent planners will open more than
30 venues in a month, and only a few percent of those will pay, on a teen base
with payment friction. Renewal makes it harder: annual renewal in the Social and
Lifestyle category runs about 25% (RevenueCat renewal benchmarks), so roughly
three quarters of yearly subscribers have to be won again each year just to
stay flat. Only 17.2% of subscription apps reach $1,000 a month in their first
year (RevenueCat, State of Subscription Apps 2024).

## What the evidence says about the consumer plan

- **One metered feature is a weak reason to pay; bundles do better.**
  Snapchat+ sells many small perks, not one metered lookup. It passed 25
  million subscribers by February 2026, is still a small share of Snap's
  revenue, and launched in Snap's eleventh year.
- **Lead with monthly for this audience.** Snapchat+ is $3.99 a month or
  $29.99 a year, and Flock Pro mirrors that.
- **There is no published survey of what 13 to 17 year olds spend on app
  subscriptions.** The widely quoted "23% of Gen Z pay for a social app"
  counts ages 18 to 25, legal adults with their own cards, so it is not a teen
  number. Where young people do pay for social apps, they pay for status and
  identity rather than utility meters.
- **The crowd forecast is a strong retention feature and a fair perk, but a
  weak paywall on its own.** It becomes worth paying for when it uses what
  only Flock has: "three of your friends' groups are headed there tonight", or
  the best time for this group given everyone's votes. That is Flock's own
  plan and vote data, which Google does not have.

## What switches each plan on

Flock Pro turns on with `PAYWALL_ENABLED=true`, and only after the purchase
path works end to end in the shipping iOS build: the App Store products, the
RevenueCat offering, `REVENUECAT_WEBHOOK_SECRET` (without it the webhook
refuses every event, so no purchase could ever grant Pro) and, on the web, the
Stripe checkout. The paywall funnel is instrumented, so the first weeks will
show whether anyone reaches a limit before anything else is decided.

Roost turns on with `VENUE_BILLING_ENABLED=true`, which starts checkout and
plan enforcement together. The first charge should go to a venue that asked
to keep Roost, and the notice promise above applies to every venue account
that existed before the price did.

## Later

- **A status bundle for Flock Pro**, once there are around a thousand users:
  plan themes, group stats, priority polls, with the unmetered forecast as one
  perk among several. None of it is built.
- **Invite friends for a free month** is an idea, not a plan, and nothing
  builds it. It would turn the limit into distribution, but it is still a
  limit, so it waits until the funnel shows people reaching one.

**Bottom line:** both plans are good plumbing and neither pays the bills
before Flock has users. The work that matters now is getting users and making
the venue dashboard worth $99 to one bar in one city.
