# Flock — App Store + Google Play Submission Guide

> **Doc status (audited 2026-08-13): partly superseded.** `SUBMIT-CHECKLIST.md`
> is the current, maintained submission runbook — follow that one for ordered
> steps and privacy labels. This file is kept for the store-listing copy in
> section 3, which is still good. Sections 1, 2 and 5 have been corrected here;
> anything referencing `mobile/` or `eas build` describes the **abandoned React
> Native port**, not the shipping app (Capacitor in `frontend/`, built by
> Codemagic).

Status as of this branch (`submission-readiness`, since merged to `main`): all **compliance code** is done
(UGC moderation, terms gate, age gate, account deletion + Apple revocation,
privacy fixes, legal docs, free-v1.0). What remains is assets, store-side config,
and the builds — most of which only you can do. This doc has the copy-paste
content + the exact env/checklist.

---

## 1. Pre-submit env config (set in dashboards — never commit)

> Full, verified variable list with per-variable failure modes:
> **`backend/.env.example`** and **`frontend/.env.example`**. The summary below
> is only the submission-critical subset.

**Railway (backend):**
- `VISION_API_KEY` — Google Cloud Vision SafeSearch key; enables image moderation.
  (**`OPENMODERATOR_API_KEY` is dead** — OpenModerator's hosted service was shut
  down and no code reads that name. See `backend/utils/moderation.js:63`.)
- `IMAGE_MODERATION_REQUIRED=true` — makes image moderation **fail-closed** in prod.
  Without it, an unconfigured or erroring provider ALLOWS every upload.
- `ADMIN_USER_IDS` — comma-separated user ids promoted to admin on boot
  (`server.js:319`). **Without this no admin account exists**, so submitted
  reports can never be actioned — the thing Guideline 1.2 requires.
- `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (.p8 contents), `APPLE_CLIENT_ID`
  — enables Sign in with Apple token revocation on account deletion (Apple 5.1.1(v)).
- `APPLE_BUNDLE_ID=com.flockcorp.flock` — Apple identity-token audience check.
- (v1.1 only) `REVENUECAT_WEBHOOK_SECRET` — when the paywall turns on.

**Frontend (Vercel + the Codemagic `flock_web` env group):** `REACT_APP_POSTHOG_KEY`.
There is no `src/services/posthog.js` — PostHog is initialised inline at
`frontend/src/index.js:58` and used via `frontend/src/services/api.js:13`.
Unset ⇒ `posthog-js` is never even imported and analytics is fully off.
**Set ⇒ PostHog runs and calls `identify()` with the user's numeric account id**
(`services/api.js:29`), so the privacy labels in section 4 must declare analytics.
Do not describe the app as collecting no analytics.

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

Use **`backend/scripts/seed-review-account.js`** — it already creates
`review@flockcorp.com` plus a buddy to block and a flock with reportable
messages. (`backend/seeds/demo-data.js` is the separate general demo seeder; it
requires `SEED_REAL_USER_PASSWORD` and throws without it.)

**App Review notes (paste, fill the login):**
> Demo account: review@flockcorp.com / <password>.
> UGC moderation: **tap** any message → Report (choose a reason) or Block.
> Blocking is mutual. Account deletion: Profile → Delete account (also at
> flockcorp.com/delete-account). Moderation is actioned by our team
> via an admin console; reports trigger alerts and are handled promptly.

> **The gesture is a TAP, not a long-press.** Telling a reviewer to long-press
> sends them looking for a gesture the app does not implement, and "I could not
> find the reporting mechanism" is a Guideline 1.2 rejection. Verify against
> `frontend/src/components/ModerationSheet.js` before submitting. (The stale
> "long-press" wording still sits in that file's header comment, line 7.)

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

**Support URL:** https://flockcorp.com/support
**Privacy Policy URL:** https://flockcorp.com/privacy
**Terms (custom EULA) URL:** https://flockcorp.com/terms

(flockcorp.com went live 2026-08-12 — see `DOMAIN.md`. The apex 308-redirects to
`www`. The old `flock-app-w65m.vercel.app` URLs still resolve but should not be
what you file with Apple.)

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

> Superseded in part — `SUBMIT-CHECKLIST.md` holds the current ordered list.
> The three struck items below described the abandoned React Native path.

- [x] ~~Drop 5 Satoshi `.otf` files into `mobile/src/assets/fonts/`~~ — **obsolete twice over.**
      `mobile/` is not the launch path, and Satoshi was deliberately removed
      2026-08-12 (`frontend/src/index.css:8`, SLOP-AUDIT A15). The shipping type is
      Fraunces + Hanken Grotesk, self-hosted in `frontend/src/fonts/`.
- [ ] Generate a 1024² app icon + splash; drop into `frontend/ios/App/App/Assets.xcassets`.
- [ ] Generate 5+ screenshots per platform.
- [ ] Apple: build via **Codemagic** (`codemagic.yaml`) → TestFlight. Not `eas build`.
- [ ] Google: Android is **not** currently built by any configured pipeline —
      decide whether Play is still in scope before planning around it.
- [ ] Fill age rating, nutrition labels / Data Safety form, apply custom EULA, file Google's CSAE child-safety declaration (name safety@flockcorp.com as contact).
- [ ] Set the env vars in section 1, then submit.
