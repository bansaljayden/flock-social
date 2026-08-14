# asc-upload

Pushes Flock's App Store listing metadata and screenshots to App Store Connect,
sourced entirely from `APP-STORE-SUBMISSION.md` (sections 6 and 8). Zero
dependencies: pure Node (`node:crypto` signs the ES256 JWT, global `fetch`
talks to the API).

## The one command

```
node tools/asc-upload/upload.mjs --key AuthKey_XXXXXXXXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>
```

`--key-id` and `--issuer` come from App Store Connect > Users and Access >
Integrations > App Store Connect API, on the same row as the downloaded `.p8`.
The key needs the App Manager or Admin role.

Run it with no arguments (or add `--dry-run` to a keyed run) for a full
offline rehearsal: it parses the doc, validates every field against Apple's
limits AND the doc's own computed counts, inventories the screenshot files,
and prints the exact API calls a live run would make. No network writes ever
happen in dry-run mode. With credentials plus `--dry-run` it also does
read-only discovery so the plan shows the exact PATCH-vs-POST decisions.

## What it pushes

- **appStoreVersion 1.0** (created if absent) + copyright (6.8)
- **en-US version localization**: description, keywords, promotional text,
  what's new, support URL, marketing URL (6.4 to 6.7)
- **en-US app info localization**: name, subtitle, privacy policy URL (6.1,
  6.2, 6.7)
- **Screenshots** from `frontend/public/screenshots/appstore/`
  (`NN-slug-{light|dark}.png`, section 8 plan): sets are created per display
  type (detected from PNG pixel size: 1290x2796 / 1320x2868 -> APP_IPHONE_67,
  1284x2778 / 1242x2688 -> APP_IPHONE_65), light uploads first in slot order,
  dark fills the remaining room up to Apple's 10-per-set cap. Missing files
  are listed and skipped; metadata still pushes. Re-running **replaces**
  existing screenshots (delete then re-upload), never duplicates.

Idempotent throughout: existing resources are PATCHed, never re-created.

## What it never touches

Privacy nutrition labels (doc section 7), the age rating questionnaire
(section 2), App Review notes (section 6.10, which has two preconditions),
category selection (6.9), and submission for review. The checklist for those
prints at the end of every run.

## Failure modes

- **401 Unauthorized**: the `--key-id` / `--issuer` pair does not match the
  `.p8` (or the key was revoked, or the system clock is skewed). Re-check all
  three against the same row of the API Keys page.
- **409 Conflict on name/subtitle**: the app name is not reserved for this
  app (or another app holds "Flock"). Reserve the name in the ASC UI first;
  doc 6.1/6.2 has the fallback pair (`Flock: Plan Nights Out` + `Vote, match
  budgets, go`). Apple's error is printed verbatim; the tool never retries a
  409.
- **403 Forbidden**: key role too low; needs App Manager or Admin.
- **Validation failure before any network call**: the doc's copy drifted from
  its recorded counts, a field exceeds an Apple limit, an em dash crept in, or
  a screenshot breaks the `NN-slug-{light|dark}.png` convention or is the
  wrong pixel size. The error names the section and the fix.
- **assetDeliveryState FAILED** after upload: the PNG did not meet Apple's
  requirements; fix the image and re-run (the failed shot is replaced).

## Tests

```
node --test tools/asc-upload/
```

29 tests, all offline: JWT shape against Apple's documented spec (ES256,
`kid` header, `iss`/`iat`/`exp`/`aud=appstoreconnect-v1`, 20-minute cap,
raw r||s signature), doc parsing against the real `APP-STORE-SUBMISSION.md`
(computed counts must equal the doc's own), mutation cases (broken
delimiters, oversized fields, bad display types, doc drift each fail naming
the fix), screenshot manifest handling, and plan idempotency (a second run
plans replace, not create).

API facts verified against Apple's documentation 2026-08-14:
`generating-tokens-for-api-requests`, `screenshotdisplaytype`,
`uploading-assets-to-app-store-connect`, and the
`appStoreVersionLocalization` / `appInfoLocalization` attribute schemas.
