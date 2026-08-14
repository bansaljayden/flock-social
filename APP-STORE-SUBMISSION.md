# App Store submission answers

Written 2026-08-14, against the build TestFlight accepted that day. This is the
transcription sheet for submission day: every App Store Connect question whose
answer is forced by what the app actually does, answered here once, with the
reasoning attached so a future change knows when an answer expires. As of the
same day this document also carries the listing copy (section 6), the privacy
nutrition labels (section 7), and the screenshot plan (section 8); the
screenshot IMAGE FILES are produced separately under
`frontend/public/screenshots/appstore/`.

Sources, read 2026-08-14:
- Metadata field limits (promo 170 chars, description 4000 chars, keywords
  100 bytes, review notes 4000 bytes, what's-new 4000 chars):
  https://developer.apple.com/help/app-store-connect/reference/platform-version-information/
- Name and subtitle limits (name 2-30 chars, subtitle max 30 chars):
  https://developer.apple.com/help/app-store-connect/reference/app-information/app-information
- App privacy details taxonomy (data types, linkage, tracking definition):
  https://developer.apple.com/app-store/app-privacy-details/
- Age rating values and definitions:
  https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/
- The 2025 rating overhaul (new 13+/16+/18+ tiers, 12+/17+ removed):
  https://developer.apple.com/news/?id=ks775ehf
- The social media questions added to the questionnaire (July 2026):
  https://developer.apple.com/news/?id=tlur8uvi
- Export compliance:
  https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations

---

## 1. Export compliance: already answered in the binary

`ITSAppUsesNonExemptEncryption` is `false` in
`frontend/ios/App/App/Info.plist`, so App Store Connect never asks the
per-upload encryption question for this app. Nothing to click on submission
day.

Why `false` is the truthful answer, verified against the bundle 2026-08-14:

- The app's only cryptography is standard TLS the OS provides. The web layer
  talks HTTPS and WSS through WKWebView's stack; the native plugins (Sign in
  with Apple, Firebase Messaging, RevenueCat) use OS frameworks that do the
  same. Apple's exemption covers exactly this: encryption limited to standard
  protocols and OS-provided crypto.
- No crypto library exists in `frontend/package.json` dependencies. No file
  under `frontend/src` calls WebCrypto or any cipher API. The single lockfile
  match, `crypto-random-string`, is react-scripts build tooling and never
  ships in the bundle.
- All of Flock's real cryptography (bcrypt password hashing, HMAC digests,
  JWT signing) runs on the Railway backend. Export compliance is about the
  binary Apple distributes, and none of that code is in it.

**France:** the French declaration obligation attaches only to apps using
non-exempt encryption. With this key `false` there is no French paperwork,
no `ITSEncryptionExportComplianceCode`, and no document upload. If App Store
Connect ever shows an encryption question anyway, the answers that match this
binary are: uses encryption YES (HTTPS is encryption), qualifies for
exemption YES, standard algorithms only.

**When this flips:** the day the app bundles its own encryption (an E2E chat
layer, a crypto dependency, a custom cipher). The plist key changes, the
per-build question returns, France gets re-answered, and US self-classification
becomes a real question to check with BIS guidance rather than a footnote.
`frontend/src/__tests__/iosShellConfigMatchesCode.test.js` pins the premise:
CI fails the moment a crypto dependency or a WebCrypto call appears, so the
flip cannot happen silently.

---

## 2. Age rating questionnaire: the answers Flock's features force

The questionnaire changed in 2025: tiers are now 4+, 9+, 13+, 16+, 18+ (12+
and 17+ no longer exist), and since July 2026 it includes social media
capability questions that become mandatory for new submissions in September
2026. Flock is being submitted after both changes, so this is the only
questionnaire that exists for it. Answer it once, from this table.

### Capabilities section

| Question | Answer | Why |
|---|---|---|
| User-generated content | **YES** | Chat messages, photos, venue reviews, profiles. All UGC by Apple's definition. Minimum 4+ on its own. |
| Messaging and chat | **YES** | Group flock chat and DMs, text and photos. Minimum 4+ on its own. |
| Social media | **YES** | Apple's definition: interaction with UGC "through a social feed or similar discovery method," explicitly including reacting, commenting, and "making user-generated content more visible through a social feed, community, search, or other sharing and discovery tools." Venue reviews are public UGC surfaced through venue search and profiles, with owner replies; emoji reactions sit on chat. This forces **13+**, which is the app's own enforced floor (`MIN_AGE = 13`), so answering YES costs nothing and answering NO risks reclassification. |
| Social media disabled for under 13 | **NO** | This option requires calling Apple's Declared Age Range API. Flock does not; it excludes under-13 entirely at signup with a DOB gate. The app does not need this option because no under-13 user exists to disable anything for. |
| Unrestricted web access | **NO** | The WKWebView loads only the bundled app. External links open in the system browser, outside the app. Answering YES would force 16+ for a capability the app does not have. |
| Advertising | **NO** | No ad SDK, no paid placements. Venue promotions exist as venue-authored content, but nothing is a paid ad today (`VENUE_BILLING_ENABLED` is unset and no billing code exists). Revisit this answer if venue billing ever ships promoted placement. |

### In-app controls section

Select what exists, nothing more:

- **Parental controls: NO.** None exist.
- **Age assurance: NO.** The DOB gate is self-declared, not the Declared Age
  Range API or verification. Claiming assurance Apple can test for is how
  reviews go sideways. The DOB gate still matters; it just is not this
  checkbox.
- Report, block, and takedown all exist (Guideline 1.2 machinery) but the
  controls question is about restricting content access, not moderation.

### Content sections (developer-provided content, not UGC)

| Topic | Answer | Why |
|---|---|---|
| Violence (cartoon, realistic, weapons) | None | Nothing in the app depicts any. |
| Sexual content / nudity / mature themes | None | Same. |
| Profanity / crude humor | None | The app's own copy has none. User chat is covered by the UGC answer, not here. |
| Horror / fear themes | None | Same. |
| Alcohol, tobacco, drug use or references | **Infrequent** | Venue discovery surfaces bars and nightlife through Google Places, and the app coordinates outings to them. The app never depicts use, but "references" is the honest reading. Infrequent forces 13+, which is already the floor. |
| Simulated gambling / gambling / loot boxes | None | Nothing chance-based exists. |
| Contests | None | None exist. |
| Medical or wellness topics | None | The SOS feature is a location share to trusted contacts, not medical or treatment information. |

### Result

**Calculated rating: 13+**, driven by the Social Media capability and the
infrequent alcohol references, both of which independently force it. This is
exactly right for the product: the enforced signup floor is 13, the target
is 15 to 22, and TASKS.md A5 already expects "13+/16+/18+, not 17+".

Two consequences of the Social Media YES, both fine:

- Flock lands in the Social Media category for parental Time Allowances
  regardless of its chosen App Store category. Accurate.
- The product page shows a "Social Media" content descriptor. Also accurate,
  whatever the positioning copy says about not being a feed.

The questionnaire's Additional Information step offers an optional Age
Suitability URL and an override to a HIGHER tier only. Leave both alone.

---

## 3. Privacy manifests and required-reason APIs: nothing to add, and why

Current state, verified in the repo 2026-08-14:

- There is **no app-level `PrivacyInfo.xcprivacy`**, and none is needed. The
  app target's only native code is `AppDelegate.swift`, which touches no
  required-reason API (no UserDefaults, no file timestamps, no boot time, no
  disk space, no active keyboard).
- **Capacitor 8.4.0 ships its own manifest** inside the framework
  (`node_modules/@capacitor/ios/Capacitor/Capacitor/PrivacyInfo.xcprivacy`)
  declaring zero accessed API types, zero collected data, tracking false.
  Capacitor core no longer uses UserDefaults, so the empty declaration is
  truthful.
- The SDKs that DO use required-reason APIs arrive through SwiftPM at build
  time (firebase-ios-sdk behind `@capacitor-firebase/*`, purchases-ios behind
  `@revenuecat/purchases-capacitor`) and each ships its own signed manifest.
  Apple's ITMS-91053 machinery checks those at upload. Today's accepted
  TestFlight build is the proof the current set passes.
- `@capacitor-community/apple-sign-in` wraps AuthenticationServices only. No
  required-reason API, no manifest needed.

**When this changes:** adding `@capacitor/preferences` (UserDefaults) or
`@capacitor/filesystem` (file timestamps) is the classic trigger. At that
point the app needs its own `PrivacyInfo.xcprivacy` in
`frontend/ios/App/App/` with the matching reason codes (CA92.1 for
UserDefaults is the usual one), added in the same commit as the plugin.

Privacy **nutrition labels** are a separate thing: they live in App Store
Connect, not in the repo, and are Jayden's to fill (TASKS.md A5, including
PostHog usage data). The honest inputs: location, photos, chat content, DOB,
email, name, payment handles, PostHog analytics, no tracking across apps (no
ATT, and the test file pins that AppTrackingTransparency is not linked).

---

## 4. Info.plist key audit: nothing deprecated, nothing missing

Every key the plist carries was checked against current requirements on
2026-08-14. All standard, none deprecated, none newly conditional:
`CFBundle*` identity keys, `LSRequiresIPhoneOS`, `UILaunchStoryboardName`
(required, present), `UIMainStoryboardFile` (UIKit lifecycle without scenes
is still fully supported), `UIRequiredDeviceCapabilities` arm64,
`UISupportedInterfaceOrientations`, `UIViewControllerBasedStatusBarAppearance`,
the three purpose strings, `LSApplicationQueriesSchemes`,
`ITSAppUsesNonExemptEncryption`, and the `CAPACITOR_DEBUG` passthrough.

Keys that newer platform rules make people ask about, and why none apply:

- **iPadOS multitasking / windowing rules: not applicable.**
  `TARGETED_DEVICE_FAMILY = 1`, iPhone only.
- **`UIDesignRequiresCompatibility`** (the Liquid Glass opt-out): not set,
  correctly. The UI is a webview; system chrome exposure is minimal, and the
  opt-out is a temporary crutch Apple retires anyway.
- **Privacy manifest keys** (`NSPrivacyAccessedAPITypes` etc.) never belong
  in Info.plist; they live in `.xcprivacy` files. See section 3.
- No `CFBundleURLTypes`, no associated domains, no `UIBackgroundModes`, no
  ATS keys: all deliberate absences, each documented in the plist itself and
  pinned by `iosShellConfigMatchesCode.test.js`.

---

## 5. Submission-day checklist (the human one-liners)

Everything an agent could answer is answered above. What remains:

1. **Transcribe section 2 into the age rating questionnaire.** It should
   calculate 13+. If it calculates anything else, an answer was mistyped.
2. **Confirm no encryption question appears at submission.** It should not;
   the plist answers it. If one appears anyway, answer per section 1.
3. **Fill privacy nutrition labels**: transcribe section 7 below. (It
   supersedes the one-paragraph sketch at the end of section 3.)
4. **Listing copy**: transcribe section 6 below, verbatim. **Screenshots**:
   upload per the plan in section 8 once the image files exist.
5. **App Review notes**: transcribe from section 6.10 ONLY after the two
   preconditions listed there are met (`ADMIN_USER_IDS` set, reviewer
   password re-seeded). Do not tell reviewers the moderation console works
   until the variable is set.

---

## 6. Listing copy: every field, counted, ready to paste

Written 2026-08-14 against the shipping build and SLOP-AUDIT.md. Rules this
copy was written under: no em dashes anywhere (there are none below, so a
straight copy-paste cannot introduce one), no feature that is not in the
shipping build, no invented numbers, no superlatives, no "free forever"
promise. Every character count was computed programmatically, not estimated.
Guideline 2.3.7 (metadata must describe the app accurately) is the standard
each claim below was checked against; the evidence file for each claim is
listed in 6.11.

This section supersedes SUBMISSION.md section 3, which predates the crowd
model, Birdie, guest invites, and the em-dash ban (its draft description
contains two em dashes; do not paste from it).

### 6.1 App name (limit 30 characters)

> Flock

**5 characters.** "Flock" is a contested name on the App Store, and App Store
Connect enforces name uniqueness at reservation time, so this may simply be
unavailable. The subtitle carries the disambiguation either way. If the bare
name is taken, the fallback is:

> Flock: Plan Nights Out

**22 characters.** If the fallback is used, swap the subtitle for the
alternate in 6.2 so the two do not say the same thing twice (duplicated words
also waste keyword index space).

### 6.2 Subtitle (limit 30 characters)

> Plan nights out with friends

**28 characters.** Says what the app is in one line, no superlatives.
Alternate, for use only with the fallback name above:

> Vote, match budgets, go

**23 characters.** All three verbs name shipped surfaces (venue voting,
anonymous budget matching, the confirmed plan).

### 6.3 Keyword field (limit 100 bytes)

> hangout,group,vote,rsvp,split the bill,crowd,busy,venues,where to go,weekend,meet up,decide,invite

**98 characters / 98 bytes.** Construction rules applied:

- Comma-separated, no space after commas (spaces count against the limit).
- Nothing duplicated from the name ("flock") or subtitle ("plan", "nights",
  "out", "friends") because name and subtitle are already indexed.
- No competitor names, no trademarked terms (no "venmo"/"zelle" even though
  the app links to them), no "free" (pricing terms in metadata are a 2.3.7
  flag, and it was excluded by instruction anyway), no category word ("app").
- Every term maps to something the app does: hangout/meet up/weekend
  (coordinating outings), group (flocks), vote + rsvp + decide + invite
  (voting, RSVPs, invite links), split the bill (bill splitting), crowd +
  busy (crowd forecasts), venues + where to go (venue search, the "plan
  night out with friends / where to go" query class that llms.txt and the
  marketing pages already answer for engines).

### 6.4 Description (limit 4,000 characters)

**2,140 characters.** Paste between the rules:

---PASTE START---
Plans die in the group chat. Thirty messages, no decision, and the night quietly falls apart. Flock is the app where the decision actually gets made.

Start a flock and invite your friends. Everyone RSVPs, suggests venues, and votes. The group picks the place together, so no single person has to be the decider.

VOTE ON WHERE TO GO
Anyone in the flock can suggest a spot from real venue search. Everyone votes. The winner is the plan.

SEE HOW BUSY IT IS BEFORE YOU LEAVE
Flock runs its own crowd model, trained on 2,070,239 venue-hour observations across 31 cities. It reads 106 signals, including the hour, the weather, nearby events, and how that specific place usually runs, and gives you an hour-by-hour forecast with a best time to arrive.

MATCH BUDGETS WITHOUT THE AWKWARD PART
Everyone privately types what they can spend. No one's number is ever shown to the group. Flock only reveals a ceiling that works for everyone, and only after at least three people have submitted.

SPLIT THE BILL AFTER
Enter the total once. Flock splits it across the group, builds Venmo and Cash App payment links, and walks you through Zelle.

ASK BIRDIE
Birdie is the in-app assistant. Ask "where's poppin rn" and it answers with real venues near you, using the same crowd numbers as the rest of the app.

KEEP EVERYONE IN THE LOOP
Group chat and DMs live next to the plan, so the vote, the RSVPs, and the confirmed plan stay in one place. Friends without Flock can still RSVP and vote through an invite link. No account needed.

GET THERE AND BACK
Share live location with your flock while a plan is running. It is off by default, only you can turn it on, and you can stop it any time. One tap on SOS emails your current location to your trusted contacts. There is no background tracking.

Flock is free to use, with no card required, and everything above is included.

Flock is for ages 13 and up. You can report or block anyone from any message or profile, and our Community Guidelines apply to everything posted.

Privacy policy: https://www.flockcorp.com/privacy
Terms: https://www.flockcorp.com/terms
Support: https://www.flockcorp.com/support
---PASTE END---

What is deliberately NOT in it: stories (server-only by decision, no UI will
ever ship), venue events/promotions surfaces, the paywall or "Pro" (dormant),
NFC check-in (niche), reliability scores (works, but explaining it costs more
than it earns), "venues pay" (no venue has ever paid; no billing code exists),
and any Zelle "link" (backend/routes/billing.js builds Zelle with
`deepLink: null` and written instructions; "walks you through" is the honest
verb).

### 6.5 Promotional text (limit 170 characters)

> Where a group actually picks the place, the time, and the budget. Vote on venues, see how busy it is before you leave, and split the bill after. Free to use.

**157 characters.** Editable without a new build; safe default for launch.

### 6.6 What's New for 1.0 (limit 4,000 characters)

> This is Flock's first release. Start a flock and invite your friends, vote on where to go, match budgets privately, check the crowd forecast, and split the bill after the night.

**177 characters.** Version 1.0 release notes are shown but rarely read;
this restates the product truthfully and nothing else.

### 6.7 URLs

| Field | Value |
|---|---|
| Support URL | https://www.flockcorp.com/support |
| Marketing URL | https://www.flockcorp.com |
| Privacy Policy URL | https://www.flockcorp.com/privacy |

`www` is canonical (the apex 308-redirects to it, DOMAIN.md); file the `www`
form so Apple's link checker never follows a redirect. All three resolve as
of 2026-08-14 and are real, populated pages (SLOP-AUDIT H7/H11).

### 6.8 Copyright

> 2026 Flock Corp.

**16 characters.** App Store Connect prepends the © symbol; do not type one.
Matches the site footer (`PrivacyPolicy.js`: "© {year} Flock Corp.").

### 6.9 Category (Jayden's call, recommendation recorded)

**Recommended: primary Social Networking, secondary Lifestyle.** The site's
JSON-LD already declares `applicationCategory:
"SocialNetworkingApplication"` (`frontend/public/index.html`), and the age
questionnaire's Social Media YES already places the app in Apple's social
bucket for Screen Time purposes regardless of category, so Social Networking
is the consistent choice. Lifestyle is defensible as primary if Jayden wants
lighter competition; nothing else in this package changes if he flips them.

### 6.10 App Review notes (limit 4,000 bytes)

**Two preconditions. Do NOT paste these notes until both are true:**

1. **`ADMIN_USER_IDS` is set on Railway and verified.** The notes below say
   reports go to a moderation console our team reviews. As of 2026-08-14
   that variable is unset, no account holds `role='admin'`, and
   `/admin/moderation` is unreachable, so the sentence is a lie until the
   variable is set, the service redeployed, and the console confirmed to
   load (SUBMIT-CHECKLIST 0b). This is the single cheapest way to turn an
   approval into a Guideline 1.2 rejection, or worse, an approval built on
   a false statement to Apple.
2. **The reviewer password is re-seeded and private.** The repo default
   (`ReviewPass123` in `backend/scripts/seed-review-account.js`) is public
   in the repository. Run the seeder against production with
   `SEED_REVIEW_CONFIRM=1` and `SEED_REVIEWER_PASSWORD` set to a fresh
   value, then fill the placeholder. The script also re-seeds the buddy
   account, the "Friday Night Out" flock, and the reportable messages the
   notes reference, and it un-bans the reviewer account if a previous
   review run banned it.

**1,706 characters (< 4,000 bytes).** Paste between the rules, filling the
one placeholder:

---PASTE START---
Demo account (already seeded on the production server):
  Email: review@flockcorp.com
  Password: [SET BY JAYDEN. Run backend/scripts/seed-review-account.js with SEED_REVIEWER_PASSWORD set, then paste the password here. Do not ship the repo default.]

The account opens onto a flock named "Friday Night Out" with another member (Sam Buddy), chat messages, and one direct message, so every flow below can be exercised immediately.

How to test the UGC moderation flows (Guideline 1.2):
1. Report a message: open the flock chat, tap any message from Sam Buddy, then tap the red flag icon in the actions row and choose a reason.
2. Block a user: open the direct message from Sam Buddy, open the conversation menu, and choose Block. Blocking is mutual and immediate. Unblocking is in the Profile tab, under Blocked accounts.
3. Reports go to our moderation console, where our team reviews and actions them. The same console powers content takedowns and account bans.

Account deletion (Guideline 5.1.1(v)): Profile > Delete account, confirmed with the account password. Also available on the web at https://www.flockcorp.com/delete-account.

Sign in with Apple is offered alongside Google sign-in on the native login and signup screens.

Permissions: location, camera, photos, and notifications are all optional. Every feature that needs one asks at the moment of use, and the app works with all of them declined. Location is when-in-use only; there is no background location.

Purchases: none. This build sells nothing, shows no paywall, and every feature is included.

The app requires an account because all content is a private group's coordination data. The demo account above is the intended review path.
---PASTE END---

Wording verified against the code: the report gesture is a TAP (tapping a
message reveals the actions row with the flag icon; `App.js`
`setModerationTarget` call sites, `ModerationSheet.js`). Do not say
"long-press"; the stale long-press wording in ModerationSheet's header
comment is a comment, not the behavior, and SUBMISSION.md section 2 already
flags it. "Blocked accounts" screen shipped 2026-08-14 (App.js
`handleUnblock`).

### 6.11 Claim-to-evidence map for the description

| Claim | Evidence |
|---|---|
| Flocks, invites, RSVPs, votes | `backend/routes/flocks.js`, `venue_votes` table, working end-to-end list in `.claude/CLAUDE.md` |
| Real venue search | Google Places via `GOOGLE_PLACES_API_KEY` (set in prod) |
| 2,070,239 observations, 31 cities, 106 signals | `backend/scripts/ml/models/model_metadata.json`: `training_rows: 2070239`, `cv_method: GroupKFold(n_splits=31) leave-one-city-out`, `feature_count: 106`. Same numbers published in `frontend/public/llms.txt` |
| Hour-by-hour forecast, best time to arrive | `services/mlPredictor.js` + llms.txt "hour by hour read and a best time to arrive" |
| Budget privacy, ceiling after 3 submissions | Budget matching design decision in `.claude/CLAUDE.md` (client only ever receives `{ceiling, submissionCount, isReady, skipCount}`; ceiling withheld until 3 non-skipped submissions) |
| Venmo and Cash App links, Zelle instructions | `backend/routes/billing.js` (venmo://paycharge, cashapp://cash.app/pay, Zelle `deepLink: null`), `Info.plist` LSApplicationQueriesSchemes comment |
| Birdie, "where's poppin rn" | `backend/routes/ai.js` (Gemini), llms.txt Birdie entry uses the same example phrase |
| Guest RSVP with no account | `backend/routes/guest.js`, `guest_rsvps` table, `/i/:token` page |
| Live location off by default, stoppable, no background tracking | `Info.plist` NSLocationWhenInUseUsageDescription comment (no always-auth API reachable, no background mode), PrivacyPolicy.js Location section |
| SOS emails trusted contacts | `trusted_contacts` + `emergency_alerts` tables, PrivacyPolicy.js SOS bullet (email only) |
| Free, no card required | `PAYWALL_ENABLED` unset, no purchasable product in build; phrased as present state, no "forever" |
| Ages 13 and up | `backend/utils/age.js` MIN_AGE = 13; matches the 13+ age rating in section 2 |
| Report or block from any message or profile | `ModerationSheet.js`, `setModerationTarget` call sites across App.js |

Cross-checked 2026-08-14 against `frontend/public/llms.txt`, the privacy
policy (`PrivacyPolicy.js`), and the JSON-LD in
`frontend/public/index.html`: no claim above contradicts any of them. One
deliberate divergence: llms.txt says Flock "generates Venmo, Cash App, and
Zelle links"; the description says links for the first two and instructions
for Zelle, which is what the code does. The description is the more precise
of the two, not a contradiction.

---

## 7. Privacy nutrition labels: the exact selections, from code

Answered 2026-08-14 against Apple's App Privacy questionnaire
(developer.apple.com/app-store/app-privacy-details/) and the SHIPPING build:
`REACT_APP_SENTRY_DSN` unset, `PAYWALL_ENABLED` unset, and
`REACT_APP_POSTHOG_KEY` assumed SET in the release build (SUBMISSION.md
section 1 lists it as a required pre-submit variable for Vercel and the
Codemagic `flock_web` env group; if it is in fact absent from the Codemagic
group, PostHog never loads, and Usage Data plus the AN purpose on User ID
drop out of the grid; declaring them anyway is over-disclosure, not a lie,
so the grid stays safe either way).
Apple's definition of "collect" is transmitting data off the device and
retaining it longer than needed to service the request; several things below
are answered "not collected" on exactly that clause, with the evidence line
attached. "Linked to you" means associated with the account, which nearly
everything here is, because every API call is authenticated by user id.

### 7.1 The tracking question first

**"Do you or your third-party partners use data for tracking?" NO.**

- No ad SDK, no data broker, no cross-app identifier. The full third-party
  SDK list in the binary: Capacitor core (its own privacy manifest declares
  tracking false, section 3), Firebase Messaging (push only;
  `frontend/src/services/firebase.js` imports `firebase/app` +
  `firebase/messaging` and never `firebase/analytics`), Sign in with Apple
  (AuthenticationServices wrapper), RevenueCat (no tracking; receives only
  our numeric app_user_id, `services/purchases.js`), PostHog (first-party
  analytics, config pinned in `frontend/src/index.js`
  `POSTHOG_PRIVACY_CONFIG`: autocapture off, session recording off,
  respect_dnt true).
- No ATT prompt exists and none is needed;
  `frontend/src/__tests__/iosShellConfigMatchesCode.test.js` pins that
  AppTrackingTransparency is not linked (section 3).

### 7.2 Per-category selections

Transcribe this grid. Purposes used: **AF** = App Functionality, **AN** =
Analytics. No data type uses Third-Party Advertising, Developer's
Advertising, or Product Personalization. Nothing is used for Tracking.

| Apple data type | Collected? | Linked to you? | Purposes | Evidence |
|---|---|---|---|---|
| Contact Info: Name | YES | Linked | AF | `users.name`, signup form (`routes/auth.js`); display name shown to friends |
| Contact Info: Email Address | YES | Linked | AF | `users.email` + email verification (`migrations/011`), transactional email via Resend |
| Contact Info: Phone Number | YES | Linked | AF | Optional, user-added from profile; `users.phone`, matched by `routes/friends.js` find-by-phone; PrivacyPolicy "Phone number (optional)" |
| Contact Info: Physical Address | NO | | | Never asked for anywhere |
| Contact Info: Other User Contact Info | NO | | | Nothing beyond the above |
| Health & Fitness | NO | | | Nothing exists; SOS is a location share, not health data (section 2) |
| Financial Info: Payment Info | NO | | | No card, bank, or payment-card number is ever collected; money moves in Venmo/Cash App/Zelle, not Flock (PrivacyPolicy payment-handles bullet) |
| Financial Info: Credit Info | NO | | | |
| Financial Info: Other Financial Info | YES | Linked | AF | User-entered payment HANDLES (Venmo username, cashtag, Zelle id: `users` columns, migration 001), bill-split totals and shares (`bill_splits`, `bill_split_shares`), private budget submissions (`budget_submissions`; never shown individually to others) |
| Location: Precise Location | YES | Linked | AF | `NSLocationWhenInUseUsageDescription` (Info.plist); SOS stores coordinates with the account (`emergency_alerts`); live share is relayed, never stored; venue/weather/Birdie lookups are transient (PrivacyPolicy Location section). When-in-use only, no background mode |
| Location: Coarse Location | NO (covered by Precise) | | | Declaring both would be double-counting the same reads |
| Sensitive Info | NO | | | |
| Contacts | YES | Linked | AF | Trusted (emergency) contacts the user types in by hand: name, phone, email, relationship (`trusted_contacts` table; PrivacyPolicy "Trusted contacts"). NOT address-book access; see 7.3 |
| User Content: Emails or Text Messages | NO | | | In-app chat is declared under Other User Content; Flock never reads the user's email or SMS |
| User Content: Photos or Videos | YES | Linked | AF | Profile photos, chat images, venue logos (`NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription`, four upload paths listed in Info.plist comments); screened by Cloud Vision |
| User Content: Audio Data | NO | | | Every getUserMedia call passes `{audio: false}` (Info.plist camera comment); venue sensor loudness is venue hardware data containing no user identity (`routes/sensors.js`, PrivacyPolicy section 3) |
| User Content: Gameplay Content | NO | | | |
| User Content: Customer Support | NO | | | Support is an email address outside the app |
| User Content: Other User Content | YES | Linked | AF | Flock chat + DMs (`messages`, `direct_messages`), venue reviews (`venue_reviews`), availability status, calendar entries, crowd reports (PrivacyPolicy "You provide directly"). Birdie prompts are sent to Gemini to answer and are not stored server-side (`routes/ai.js` re-sends the whole conversation from the client each call; no INSERT) |
| Browsing History | NO | | | The app has no browser; unrestricted web access NO in section 2 |
| Search History | NO | | | Venue and people searches are serviced and not retained (`routes/venues.js` pass-through to Places; PrivacyPolicy: "We do not store those coordinates... or build a location history"); fails Apple's retention clause for "collect" |
| Identifiers: User ID | YES | Linked | AF, AN | Numeric account id; PostHog `identify()` with exactly that id (`services/api.js`), RevenueCat app_user_id contract (`services/purchases.js`) |
| Identifiers: Device ID | YES | Linked | AF | APNs/FCM push token stored per device against the account (`device_tokens` table, migrations 000/002); deleted on sign-out. No advertising identifier anywhere |
| Purchases | NO | | | Nothing can be bought: `PAYWALL_ENABLED` unset, no products live. Flips to YES (Purchase History, linked, AF) the day the paywall ships |
| Usage Data: Product Interaction | YES | Linked | AN | PostHog: pageviews + hand-written events only (`POSTHOG_PRIVACY_CONFIG` in `frontend/src/index.js`: autocapture false, session recording false, heatmaps/dead-clicks/exceptions false, persistence localStorage). Tied to account id, so Linked |
| Usage Data: Advertising Data | NO | | | No ads exist (section 2) |
| Usage Data: Other Usage Data | NO | | | |
| Diagnostics: Crash Data | NO | | | Sentry loads only if `REACT_APP_SENTRY_DSN` is set (`frontend/src/index.js` dynamic import) and it is unset in every deploy target today. See 7.4 |
| Diagnostics: Performance Data | NO | | | Same gate. `reportWebVitals()` measures locally and sends nothing (CRA default, no reporter passed) |
| Diagnostics: Other Diagnostic Data | NO | | | |
| Other Data | YES | Linked | AF | Date of birth, collected at signup for the 13+ age floor (`users.date_of_birth`, `backend/utils/age.js` MIN_AGE = 13). Never displayed; Birdie receives only an age BRACKET, never the birthday (PrivacyPolicy Gemini bullet) |

### 7.3 Things verified so the grid could say NO (or say it precisely)

- **Address-book contact sync is NOT collection, and on iOS it cannot even
  run.** Earlier notes claimed the sync "checks hashes"; the code says
  otherwise: `routes/friends.js` POST `/find-by-phone` receives RAW phone
  numbers (not hashes), runs a SELECT against `users.phone` (last-10-digit match, lines
  ~713 to 731), returns matches, and never INSERTs or logs the submitted
  list, so it fails Apple's retention clause for "collect". The privacy
  policy says exactly this ("We run the lookup and don't store those
  numbers"). Additionally the iOS build has no `NSContactsUsageDescription`
  (Info.plist) and WKWebView has no contacts API, so the Add Friends
  Contacts tab is a dead end on iOS (SLOP-AUDIT H5 / SUBMIT-CHECKLIST P1)
  and the endpoint is unreachable from the app being reviewed. The
  **Contacts YES** in the grid is carried entirely by hand-typed trusted
  contacts, which ARE stored.
- **Venue occupancy sensors send no user data.** `routes/sensors.js` ingests
  device-keyed counts (IR crossings, thermal cluster count, loudness); the
  only user reference in the file is `COUNT(DISTINCT user_id)` over
  `venue_checkins` for the "accounts checked in last hour" figure, which is
  an aggregate of a separate, user-initiated action. Sensor rows hold no
  identifiers (PrivacyPolicy section 3), so they do not appear in the labels
  at all. NFC check-ins themselves are user actions stored with the account
  and are covered under Other User Content / app functionality.
- **IP addresses.** Every request carries one; the server uses it for rate
  limiting and abuse detection and stores it only alongside
  email-verification records (deleted with the account), and the PostHog
  event request carries it to PostHog with GeoIP enrichment refused
  (`$geoip_disable` in `before_send`, `frontend/src/index.js`). Apple's
  questionnaire has no IP data type; security/anti-fraud processing of
  request metadata does not belong to any of the enumerated types, and the
  privacy policy discloses it in full. The one open human step: flip
  PostHog's project-level "Discard client IP data" toggle (dashboard, not
  code; the index.js comment documents this).
- **Firebase is Messaging only.** `services/firebase.js` imports
  `firebase/app` and `firebase/messaging`; `firebase/analytics` appears
  nowhere in `frontend/src`.
- **Live location is relayed, not stored.** Coordinates pass through the
  socket to flock members and are never written to the database
  (PrivacyPolicy live-share bullet), but they ARE off-device and going to
  other users via our server, so Precise Location stays YES regardless.

### 7.4 Label deltas: what changes these answers

| Trigger | Label change |
|---|---|
| `REACT_APP_SENTRY_DSN` gets set | Diagnostics: Crash Data + Performance Data become YES (AN/AF). The init scrubs URLs/tokens and sets no user identity, so "Not Linked" is defensible, but re-read the config that day before choosing |
| `PAYWALL_ENABLED` + RevenueCat products go live | Purchases: Purchase History becomes YES, Linked, AF |
| A story UI ships | It will not (decision recorded 2026-08-14: server-only forever). If that decision is ever reversed, no label change anyway; stories are already covered by User Content |
| Contact Picker / native contacts plugin added | Contacts answer must be rewritten; the find-by-phone flow becomes reachable on iOS |
| PostHog config loosened (autocapture, replay) | `analyticsPrivacy.test.js` fails first; Usage Data scope must be re-derived before shipping |

---

## 8. Screenshot plan (order and captions; pixels arrive separately)

The image pipeline delivers files to `frontend/public/screenshots/appstore/`.
Coordinate by convention: `NN-slug-light.png` and `NN-slug-dark.png`, one
pair per slot below (the app ships real dark mode, so both modes are
captured; upload the light set as the primary and the dark set only if
Apple's per-locale limit of 10 leaves room, light first). All captures are
the real shipping app, no mockups, no stock, no seeded fake metrics
(SLOP-AUDIT H3/H13).

Captions are optional overlay text for the screenshot frames. Rules applied:
plain sentences, describe what is on the screen, no aspirations, no em
dashes, no "seamless" class words. If the pipeline ships bare screenshots
with no caption frames, that is also fine; the captions below are then
unused rather than required.

| # | Files | Screen to show | Caption |
|---|---|---|---|
| 1 | `01-plan-light.png` / `01-plan-dark.png` | A confirmed flock: venue, time, who is in | The plan, decided: place, time, and who is in. |
| 2 | `02-vote-light.png` / `02-vote-dark.png` | Venue voting list mid-vote | Everyone suggests. Everyone votes. |
| 3 | `03-crowd-light.png` / `03-crowd-dark.png` | Venue page with the hour-by-hour crowd forecast | See how busy it is before you leave. |
| 4 | `04-budget-light.png` / `04-budget-dark.png` | Budget entry with the group ceiling revealed | Type your budget in private. The group only sees the ceiling. |
| 5 | `05-split-light.png` / `05-split-dark.png` | Bill split with per-person shares and pay buttons | Split the bill. Everyone sees their share. |
| 6 | `06-chat-light.png` / `06-chat-dark.png` | Flock chat with a venue card in the thread | The chat and the plan live in the same place. |
| 7 | `07-birdie-light.png` / `07-birdie-dark.png` | Birdie answering a "where's busy" question with venues | Ask Birdie what is busy right now. |
| 8 | `08-safety-light.png` / `08-safety-dark.png` | Safety screen: live share toggle + SOS | Live location for your flock, and one-tap SOS to trusted contacts. |

Story logic: the first three sell the decision (the product's whole point),
4 and 5 sell the money mechanics, 6 grounds it in the chat it replaces, 7
and 8 are the differentiators that reward a scroller who gets that far. If
the set must be 6, drop 7 and 8 last; never drop 1 to 3.

Screenshot content rules for whoever frames them: no em dashes in any
caption (checked above), no fake counts or seeded vanity metrics in the UI,
demo data must look like a real Friday plan, and nothing may show surfaces
that do not ship (stories, venue event listings, the paywall).

---

## 9. What only Jayden can do (updated for sections 6 to 8)

1. **Set `ADMIN_USER_IDS` on Railway and confirm `/admin/moderation` loads**
   BEFORE submitting the App Review notes (section 6.10 precondition 1).
2. **Re-seed the reviewer account with a private password** and fill the
   placeholder in 6.10 (precondition 2).
3. **Decide the category** (6.9): recommendation is Social Networking
   primary + Lifestyle secondary; either order is compliant.
4. **Reserve the app name in App Store Connect**: "Flock" first, fallback
   pair from 6.1/6.2 if the bare name is unavailable.
5. **Flip PostHog's "Discard client IP data" project toggle** (7.3, third
   bullet); a dashboard step no agent can reach.
6. **Verify `support@flockcorp.com` exists in Cloudflare Email Routing**
   before filing the support URL page that displays it (SLOP-AUDIT section
   B's unverified-mailbox warning).
