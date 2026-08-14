# App Store submission answers

Written 2026-08-14, against the build TestFlight accepted that day. This is the
transcription sheet for submission day: every App Store Connect question whose
answer is forced by what the app actually does, answered here once, with the
reasoning attached so a future change knows when an answer expires. Screenshots
and listing copy are NOT here; they are TASKS.md A5 and they are Jayden's.

Sources, read 2026-08-14:
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
3. **Fill privacy nutrition labels** per section 3's last paragraph and
   TASKS.md A5.
4. **Screenshots and listing copy**: TASKS.md A5, unchanged, not duplicated
   here.
5. **App Review notes**: remember the `ADMIN_USER_IDS` contradiction in
   TASKS.md A3. Do not tell reviewers the moderation console works until the
   variable is set.
