# Flock — Paste-Ready Submission Answers

Accurate from the code + privacy policy, **re-verified 2026-08-14**. Fill the
bracketed blanks. Pair with `SUBMIT-CHECKLIST.md` (the current, maintained
submission doc), `SUBMISSION.md` (older assets/env/builds draft) and `STAGING.md`
(verify before prod).

> **Where this file and `SUBMIT-CHECKLIST.md` disagree, the checklist wins.** Its
> privacy-label table is the fuller, code-verified one; the shorter table below is
> kept because it is laid out for the Play Console as well, but it omits Device ID,
> Date of Birth and payment handles. Transcribe from the checklist.
>
> **URLs updated 2026-08-14.** flockcorp.com went live 2026-08-12 (`DOMAIN.md`),
> `www` is canonical and the apex 308-redirects to it. Every
> `flock-app-w65m.vercel.app` URL below has been replaced. The old host still
> resolves, but a `*.vercel.app` URL in a store listing is the exact tell
> `SLOP-AUDIT.md` §H1 says to remove.

---

## A. APP STORE CONNECT (iOS)

### App information
- **Name:** Flock
- **Subtitle:** Plan nights out with friends
- **Primary category:** Social Networking  · **Secondary:** Lifestyle
- **Bundle ID:** com.flockcorp.flock · **SKU:** flock-ios-001

### Age rating (questionnaire → expect 16+)
Apple retired 12+ and 17+. The bands are **4+ / 9+ / 13+ / 16+ / 18+**, and the
questionnaire computes the number, you don't pick it. Flock has user chat that
is not moderated in real time, so answer honestly; that lands at **16+**:
- Made for Kids: **No**
- Unrestricted web access: **No**
- User-generated content / in-app chat: **Yes**, and describe the moderation
  (report + block, mutual blocking, server-side review)
- **Alcohol, tobacco, or drug references: Infrequent/Mild.** The app is built
  around nights out and bars, so "None" is not accurate. It never depicts
  drinking and sells nothing, so it is not Frequent/Intense.
- Medical/Treatment, Gambling, Contests: **No**
- Violence, sexual content, profanity, horror, mature themes: **None** (the
  *app* doesn't publish it; UGC is reportable and moderated)

### App Privacy (Nutrition Labels) — Data collected
For each: **Linked to identity = Yes**, **Used for tracking = No** (no IDFA, pseudonymous analytics).
| Data type | Collected | Purpose |
|---|---|---|
| Email address | Yes | App functionality (account) |
| Name | Yes | App functionality (display name) |
| Phone number (optional) | Yes | App functionality (friend discovery, opt-in) |
| Photos (profile/chat) | Yes | App functionality |
| Coarse + Precise location | Yes | App functionality (in-flock sharing + SOS only; **not** background, **not** tracking) |
| User content (messages) | Yes | App functionality |
| Contacts (trusted contacts) | Yes | App functionality (safety/SOS) |
| Identifiers (user ID) | Yes | App functionality, Analytics |
| Usage data | Yes | Analytics (pseudonymous, PostHog) |
| Device ID (push token) | Yes | App functionality (APNs/FCM) |
| Date of Birth | Yes | App functionality — disclose under **"Other Data"** (Apple has no DOB type) |
| Payment handles (Venmo / Cash App / Zelle usernames) | Yes | App functionality — **"Other Financial Info"**, NOT "Payment Info" |
| Crash data | No | (Sentry dormant — DSN unset) |

**Data NOT collected:** browsing history, search history, purchases, **Financial
Info → Payment Info (card/bank details)**, health, sensitive info. **Not sold. Not
shared for advertising.**

> Corrected 2026-08-14. This list previously said "financial info" outright, which
> was wrong: the app stores Venmo / Cash App / Zelle **handles** so the bill-split
> screen can build payment deep links. Those are Apple's "Other Financial Info"
> and must be disclosed. What is genuinely not collected is card and bank details
> — Flock never sees them.

### Account deletion
- Deletion method: **Available in app** (Profile → Delete account) — Apple 5.1.1(v).
- Re-authentication is required and real: password accounts retype their password,
  OAuth accounts prove a live session, and wrong attempts are rate-limited.
- (Also a public URL — see Play section.)

### Sign in with Apple
- Offered: **Yes** (parity with Google), and it now genuinely ships — the button
  renders only inside the iOS app (`frontend/src/components/auth/AppleSignInButton.js`).
- ⚠️ **"Deletion revokes Apple tokens server-side" is code-true but not
  environment-true.** `backend/services/appleAuth.js` performs the revocation and
  is called from account deletion, but **no `APPLE_*` variable is set on Railway**
  as of 2026-08-14, so the revocation cannot run. Set them before submitting
  (`SUBMIT-CHECKLIST.md` §C0a) or this answer is false.

### App Review notes (paste, fill login)
```
Demo account: review@flockcorp.com / ReviewPass123
(Seed it on the backend first: backend/scripts/seed-review-account.js)

This account has a flock ("Friday Night Out") with sample messages and a
friend ("Sam Buddy") you can block.

UGC moderation. How to report a message, step by step (single TAP, there is
no long-press gesture in this app):

In a flock chat:
1. Open the flock "Friday Night Out" from the Nest tab, then open its Chat tab.
2. Single-tap the body of a message SOMEONE ELSE sent (a grey bubble on the
   left). Your own blue bubbles on the right do not offer Report.
3. A small row pops up directly under the bubble: four emoji, a reply arrow,
   then a red flag at the right end of the row.
4. Tap the red flag. The Report and Block sheet slides up from the bottom.
5. Tap "Report this message", pick one of the seven reasons, add optional
   details, and submit. The sheet then shows "Report sent" and offers to block
   the person as well. A "Report received. Our team will review it." toast
   confirms the report.

In a direct message:
1. Open the Chats tab, then open the conversation with "Sam Buddy".
2. Single-tap the body of a message Sam sent (grey bubble on the left).
3. The same row appears just below the bubble: four emoji, a reply arrow, then
   a red flag at the right end.
4. Tap the red flag, then follow steps 4 and 5 above.

Also available: the three-dot menu in the top right of any DM has "Report or
block <name>", which opens the same sheet for the person rather than one
message. Venue reviews have a flag next to each review.

Blocking: the same sheet has "Block <name>". Blocking is mutual. A blocked
user can't message or find you and you don't see their content, in both DMs
and group flocks.

We act on reports promptly via an admin console; reports trigger alerts.

Age gate: the Sign Up screen requires a date of birth; under-13 is blocked in
the client and re-checked server-side, which recomputes the age from the stored
date and is the source of truth.

Account deletion: Profile -> Delete account (immediate; revokes Sign in with
Apple tokens). Also at https://www.flockcorp.com/delete-account.

Terms/EULA with zero-tolerance language: https://www.flockcorp.com/terms
```

### Export compliance
- Uses encryption: **Yes**, but only **standard HTTPS/TLS** → qualifies for the
  exemption. Answer: "Your app uses encryption limited to standard/exempt
  algorithms" → **Exempt** (no CCATS / no ERN needed). Add
  `ITSAppUsesNonExemptEncryption = false` to Info.plist to skip the prompt.

### Custom EULA
- Apply the custom EULA (License Agreement field) pointing to / pasting:
  https://www.flockcorp.com/terms (zero-tolerance language present).

---

## B. GOOGLE PLAY CONSOLE (Android)

### Store listing
- Title: **Flock** · Short desc + full desc: see `SUBMISSION.md` §3.
- Category: **Social** · Email: support@flockcorp.com
- Privacy Policy: https://www.flockcorp.com/privacy

### Data safety form
For every type below: **Collected = Yes**, **Shared = No**, **Encrypted in
transit = Yes**, **User can request deletion = Yes**.
- Personal info: **Email, Name, Phone (optional)**
- Location: **Approximate + Precise** (purpose: App functionality; **not** background)
- Photos: **Yes** (App functionality)
- Messages: **Yes** (App functionality)
- Contacts: **Yes** (trusted contacts for safety)
- App activity / Analytics: **Yes** (pseudonymous)
- Device IDs: **Yes** (App functionality + Analytics; not for ads)
- Financial info / Health / Browsing: **No**
- "Is all data encrypted in transit?" **Yes**
- "Do you provide a way to request data deletion?" **Yes** — both in-app and at
  **https://www.flockcorp.com/delete-account** (enter this URL here).

### Content rating (IARC questionnaire)
- Category: **Social / Communication**
- Does the app let users interact/communicate (chat, share)? **Yes**
- Share user-generated content? **Yes**
- Share user location with other users? **Yes** (opt-in, in-flock only)
- Violence / sexual / gambling / drugs / controlled substances? **No**
→ expected rating: **Teen / 13+** (with the social-interaction disclosures).

### Target audience & content
- Target age: **13+** (not "Designed for Families").
- Age screen present: **Yes, on Sign Up** (date-of-birth field, blocks under-13,
  re-checked server-side).
  > Corrected 2026-08-14: this used to say "neutral age screen". There is **no**
  > neutral first-launch age screen before auth — the old React Native port had
  > one; the shipping Capacitor app does not. Do not describe one to a reviewer.
  > Building one is the complete fix for the Google-button gap in
  > `SUBMIT-CHECKLIST.md` §D2 and is a post-launch item.

### Child Safety Standards (CSAE) self-certification — REQUIRED for Social apps
- Published CSAE standards URL: **https://www.flockcorp.com/guidelines**
  (the Community Guidelines page has a CSAE zero-tolerance section).
- In-app reporting mechanism: **Yes** — tap a received text message in a flock
  chat or a DM to get a red flag, or use a DM's three-dot menu to report the
  person. Reports go to `/api/reports`; blocking is mutual. (Do not describe
  this as "on every message": image messages and venue cards have no per-item
  flag yet. See "Pending App.js changes" in `SUBMIT-CHECKLIST.md`.)
- CSAM handling self-cert: remove on actual knowledge, report to **NCMEC**.
- Child-safety point of contact: **safety@flockcorp.com**.
- File the declaration in Play Console → Policy → Child safety standards.

### Account deletion (User Data policy)
- In-app: Profile → Delete account.
- Public web URL: **https://www.flockcorp.com/delete-account**.

---

## C. Pre-submit gate (both stores)

Status re-checked against the live Railway production service 2026-08-14.

- [x] **`VISION_API_KEY` + `IMAGE_MODERATION_REQUIRED` are set on the backend.**
      Both present. Confirm the value of `IMAGE_MODERATION_REQUIRED` is literally
      `true` — anything else and `backend/utils/moderation.js` fails **open**,
      allowing unscreened images with only a console warning.
      (Not `OPENMODERATOR_API_KEY`. That name is dead: `backend/utils/moderation.js`
      reads `VISION_API_KEY`, falling back to `GOOGLE_VISION_API_KEY`, and calls the
      Google Cloud Vision SafeSearch endpoint. `STAGING.md` and `SUBMISSION.md`
      have since been corrected and no longer carry the dead name.)
- [ ] **`APPLE_*` revocation keys — CONFIRMED ABSENT.** None of `APPLE_TEAM_ID`,
      `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_CLIENT_ID`, `APPLE_BUNDLE_ID`
      exist on Railway. Blocking for 5.1.1(v). See `SUBMIT-CHECKLIST.md` §C0a.
- [ ] **`ADMIN_USER_IDS` — CONFIRMED ABSENT.** No account holds `role='admin'`, so
      the moderation console is unreachable and the review note "we act on reports
      promptly via an admin console" is not currently true. See §C0b.
- [ ] Demo account seeded on the backend the build points at.
      ⚠️ `backend/scripts/seed-review-account.js` refuses to run unless
      `DATABASE_URL` points at localhost, **or** `SEED_REVIEW_CONFIRM=1` is set.
      ⚠️ `ReviewPass123` above is the script's default and is published in this
      repo. Set `SEED_REVIEWER_PASSWORD` (and `SEED_BUDDY_PASSWORD`) to something
      else and paste **that** into the review notes, or you are handing App Review
      a credential anyone reading the repo already has.
- [ ] Re-run `/app-store-review` on **`frontend/`** → zero blockers.
      (This used to say `mobile/`. `mobile/` is the abandoned React Native port and
      is not the launch path; the shipping iOS binary is the Capacitor app in
      `frontend/`, built by `codemagic.yaml`.)
- [ ] Walk the on-device checklist in `STAGING.md` §6 → all green.
- [ ] Apply the two open items in `SUBMIT-CHECKLIST.md` → "Pending App.js changes"
      (P1 the Android/Chrome string and dead Contacts tab, P2 unreportable images
      and venue cards). Both re-verified as still open on 2026-08-14. P2 in
      particular is the "we were unable to locate the reporting mechanism" 1.2
      rejection, and it undercuts the reporting answers given above.

> Describe image moderation as **NSFW pre-screening + reporting + prompt
> takedown**, never as "CSAM detection."
