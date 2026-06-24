# Flock — App Store + Google Play Submission Guide

Status as of this branch (`submission-readiness`): all **compliance code** is done
(UGC moderation, terms gate, age gate, account deletion + Apple revocation,
privacy fixes, legal docs, free-v1.0). What remains is assets, store-side config,
and the builds — most of which only you can do. This doc has the copy-paste
content + the exact env/checklist.

---

## 1. Pre-submit env config (set in dashboards — never commit)

**Railway (backend):**
- `OPENMODERATOR_API_KEY` — free key from OpenModerator; enables image moderation.
- `IMAGE_MODERATION_REQUIRED=true` — makes image moderation **fail-closed** in prod.
- `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (.p8 contents), `APPLE_CLIENT_ID`
  — enables Sign in with Apple token revocation on account deletion (Apple 5.1.1(v)).
- `APPLE_BUNDLE_ID=com.flockcorp.flock` — Apple identity-token audience check.
- (v1.1 only) `REVENUECAT_WEBHOOK_SECRET` — when the paywall turns on.

**Mobile (`src/services/posthog.js`):** set the PostHog project key before TestFlight
(currently empty → analytics disabled, which is a safe default).

> **Image moderation wording (important):** describe it to reviewers and in docs as
> **NSFW image pre-screening + user reporting + prompt takedown** — NOT "CSAM
> detection." The model screens nudity/sexual imagery; CSAE is handled by the
> zero-tolerance policy + reporting + NCMEC escalation, not an automated detector.

---

## 2. Reviewer demo account (seed it — an empty app fails review)

Apple/Google reviewers test the report/block/delete flows. Provide a demo account
in App Review notes that is **pre-populated** with:
- 2+ flocks with some chat messages,
- a friend you can block,
- a message you can report.

`backend/seeds/demo-data.js` exists — extend/run it to seed a `review@flockcorp.com`
account with the above, and put the credentials in App Review notes.

**App Review notes (paste, fill the login):**
> Demo account: review@flockcorp.com / <password>.
> UGC moderation: long-press any message → Report (choose a reason) or Block.
> Blocking is mutual. Account deletion: Profile → Delete account (also at
> flock-app-w65m.vercel.app/delete-account). Moderation is actioned by our team
> via an admin console; reports trigger alerts and are handled promptly.

---

## 3. Store listing copy

**Name:** Flock
**Subtitle / short description:** Plan nights out with friends, in fewer messages.

**Description:**
> Flock turns the chaos of group-chat planning into one clean flow: start a flock,
> invite friends, vote on where to go, match budgets privately, and lock it in.
> See how busy a spot is before you go with live crowd forecasts, split the bill,
> and keep everyone in sync — all in one place.
>
> • Start a flock and invite your group
> • Vote on venues and pick a time
> • Private budget matching — no one sees your number
> • Live crowd levels + best-time-to-go forecasts
> • Group chat + DMs, bill splitting, and safety check-ins
>
> Flock is free. Be kind — Flock has zero tolerance for objectionable content and
> abusive users; report or block anyone, anytime.

**Keywords:** plans, friends, group, night out, hangout, coordinate, venues, RSVP,
split bill, crowd

**Support URL:** https://flock-app-w65m.vercel.app/support
**Privacy Policy URL:** https://flock-app-w65m.vercel.app/privacy
**Terms (custom EULA) URL:** https://flock-app-w65m.vercel.app/terms

---

## 4. Privacy labels / Data Safety (map to actual permissions)

Collected & linked to the user: **email** (account), **name**, **photos** (profile/
chat), **approximate + precise location** (only when sharing in an active flock or
SOS; not background), **user content** (messages), **device tokens** (push).
Diagnostics: **pseudonymous product analytics** (PostHog — no IDFA, no PII, no
cross-app tracking → `NSPrivacyTracking=false` is accurate; no ATT prompt).
Not sold. Not shared for advertising. Deletable in-app + via the web URL.

---

## 5. Remaining YOU steps
- [ ] Drop 5 Satoshi `.otf` files into `mobile/src/assets/fonts/`, run `npx react-native-asset` (config is ready).
- [ ] Generate a 1024² app icon + splash; drop into iOS `AppIcon.appiconset` + Android `mipmap-*`.
- [ ] Generate 5+ screenshots per platform.
- [ ] Apple: finish membership purchase → `eas build -p ios --profile production` → TestFlight.
- [ ] Google: Android-device verification (Play Console app) → `eas build -p android --profile production` → 14-day closed test (12 testers).
- [ ] Fill age rating, nutrition labels / Data Safety form, apply custom EULA, file Google's CSAE child-safety declaration (name safety@flockcorp.com as contact).
- [ ] Set the env vars in section 1, then submit.
