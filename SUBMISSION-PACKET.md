# Flock — Paste-Ready Submission Answers

Accurate from the code + privacy policy. Fill the bracketed blanks. Pair with
`SUBMISSION.md` (assets/env/builds) and `STAGING.md` (verify before prod).

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
| Crash data | No | (Sentry dormant — DSN unset) |
**Data NOT collected:** browsing history, search history, purchases, financial info, health, sensitive info. **Not sold. Not shared for advertising.**

### Account deletion
- Deletion method: **Available in app** (Profile → Delete account) — Apple 5.1.1(v).
- (Also a public URL — see Play section.)

### Sign in with Apple
- Offered: **Yes** (parity with Google). Deletion revokes Apple tokens server-side.

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
   details, tap "Submit report". A "Report received" toast confirms it.

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

Age gate: first launch asks date of birth; under-13 is blocked (also enforced
server-side at signup).

Account deletion: Profile -> Delete account (immediate; revokes Sign in with
Apple tokens). Also at https://flock-app-w65m.vercel.app/delete-account.

Terms/EULA with zero-tolerance language: https://flock-app-w65m.vercel.app/terms
```

### Export compliance
- Uses encryption: **Yes**, but only **standard HTTPS/TLS** → qualifies for the
  exemption. Answer: "Your app uses encryption limited to standard/exempt
  algorithms" → **Exempt** (no CCATS / no ERN needed). Add
  `ITSAppUsesNonExemptEncryption = false` to Info.plist to skip the prompt.

### Custom EULA
- Apply the custom EULA (License Agreement field) pointing to / pasting:
  https://flock-app-w65m.vercel.app/terms (zero-tolerance language present).

---

## B. GOOGLE PLAY CONSOLE (Android)

### Store listing
- Title: **Flock** · Short desc + full desc: see `SUBMISSION.md` §3.
- Category: **Social** · Email: support@flockcorp.com
- Privacy Policy: https://flock-app-w65m.vercel.app/privacy

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
  **https://flock-app-w65m.vercel.app/delete-account** (enter this URL here).

### Content rating (IARC questionnaire)
- Category: **Social / Communication**
- Does the app let users interact/communicate (chat, share)? **Yes**
- Share user-generated content? **Yes**
- Share user location with other users? **Yes** (opt-in, in-flock only)
- Violence / sexual / gambling / drugs / controlled substances? **No**
→ expected rating: **Teen / 13+** (with the social-interaction disclosures).

### Target audience & content
- Target age: **13+** (not "Designed for Families").
- Neutral age screen present: **Yes** (blocks under-13).

### Child Safety Standards (CSAE) self-certification — REQUIRED for Social apps
- Published CSAE standards URL: **https://flock-app-w65m.vercel.app/guidelines**
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
- Public web URL: **https://flock-app-w65m.vercel.app/delete-account**.

---

## C. Pre-submit gate (both stores)
- [ ] `VISION_API_KEY` + `IMAGE_MODERATION_REQUIRED=true` set on the backend.
      (Not `OPENMODERATOR_API_KEY`. That name is dead: `backend/utils/moderation.js`
      reads `VISION_API_KEY`, falling back to `GOOGLE_VISION_API_KEY`, and calls the
      Google Cloud Vision SafeSearch endpoint. Setting the old name leaves
      `IMAGE_PROVIDER_CONFIGURED` false. `STAGING.md` and `SUBMISSION.md` still
      carry the dead name and need the same correction.)
- [ ] `APPLE_*` revocation keys set (so deletion revokes Apple tokens).
- [ ] Demo account seeded on the backend the build points at.
- [ ] Re-run `/app-store-review` on `mobile/` → zero blockers.
- [ ] Walk the on-device checklist in `STAGING.md` §6 → all green.

> Describe image moderation as **NSFW pre-screening + reporting + prompt
> takedown**, never as "CSAM detection."
