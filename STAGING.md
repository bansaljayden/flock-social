# Flock — Staging Setup & Verification (do this before prod)

> **Doc status (audited 2026-08-13).** This runbook was written for the
> `submission-readiness` branch and the React Native app in `mobile/`. Both are
> superseded: `submission-readiness` is already merged into `main`, and the iOS
> launch path is the **Capacitor** app in `frontend/`, built by Codemagic (see
> `codemagic.yaml`). Sections 1–4 and 6–7 still apply if you stand up a staging
> service; **section 5 is dead** — read the note there before following it.

Goal: prove a branch works against a real deployed backend + a real device —
WITHOUT touching prod. Only merge to `main` after the checklist below passes on
staging.

> The local E2E harness (`backend/scripts/e2e-local.js`) already proved the
> backend logic — it runs 34 assertions today and prints its own
> `E2E: N passed, M failed` line. Do not quote a fixed pass count from this doc;
> read the harness output. Staging proves the *device* half + the deploy path.

## 1. Stand up a Railway staging service
- In Railway, create a **second service/environment** off the same repo, deployed
  from the `submission-readiness` branch (NOT `main`).
- Add a **separate Postgres** to it (a throwaway DB — never point staging at the
  prod database).

## 2. Bootstrap the staging DB (order matters!)
The harness proved migrations alone do NOT bootstrap a fresh DB — they only ADD
to existing core tables. So:
1. Apply the base schema first: run `backend/database/schema.sql` against the
   staging DB once (Railway's psql console, or `psql "$STAGING_DATABASE_URL" -f backend/database/schema.sql`).
2. Then deploy the branch — the migration runner (`backend/db/migrate.js`, called
   from `server.js`) adds the new columns/tables (moderation, age, etc.)
   idempotently on boot.

> **Check this before you follow step 1.** `backend/migrations/000_bootstrap.sql`
> now exists and contains the core `CREATE TABLE`s, which would make migrations
> self-bootstrapping and step 1 unnecessary. As of this audit that file is
> **untracked in git**, so it does not deploy and step 1 is still required.
> Once it is committed, a fresh DB boots from migrations alone — delete step 1
> at that point.

## 3. Staging env vars (Railway dashboard — never commit)
- `DATABASE_URL` = staging Postgres
- `JWT_SECRET` = any staging secret
- `NODE_ENV=production` (or staging), plus `GOOGLE_PLACES_API_KEY`, `RESEND_API_KEY`, etc. as needed for the features you'll test
- For image moderation testing: `VISION_API_KEY` + `IMAGE_MODERATION_REQUIRED=true`
  (Google Cloud Vision SafeSearch. **`OPENMODERATOR_API_KEY` is dead** — that
  hosted service was shut down and no code reads that name any more; see
  `backend/utils/moderation.js:63`. Full variable list: `backend/.env.example`.)
- For Apple-deletion testing: `APPLE_TEAM_ID` (998W73654F), `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (.p8), `APPLE_CLIENT_ID=com.flockcorp.flock`, `APPLE_BUNDLE_ID=com.flockcorp.flock`

## 4. Seed the reviewer/demo account (also your manual test fixture)
Against the **staging** DATABASE_URL:
```
cd backend && DATABASE_URL="$STAGING_DATABASE_URL" node scripts/seed-review-account.js
```
Creates `review@flockcorp.com / ReviewPass123` + a `buddy` to block + a flock with
reportable messages. (Verified to run by the E2E harness.)

## 5. Point a build at staging

> **SUPERSEDED.** The old instructions here edited `mobile/src/config/env.js` and
> ran `eas build`. `mobile/` is the abandoned React Native port and is **not the
> launch path** — do not build it.

The shipping client is the Capacitor app in `frontend/`. It reads the backend URL
from `REACT_APP_API_URL` at **build** time (`frontend/src/services/api.js:1`,
which falls back to the prod Railway URL when unset). So:

- **Web staging:** set `REACT_APP_API_URL=https://<staging>.up.railway.app` on a
  Vercel preview deployment.
- **iOS staging:** set the same var in the Codemagic `flock_web` env group for a
  throwaway build (`codemagic.yaml`), then ship it to TestFlight.

Because CRA inlines the value at build time, changing it requires a **rebuild**,
not just a redeploy.

## 6. Walk the checklist on the device (mirrors the E2E harness)
- [ ] First launch → **age gate**; enter a < 13 DOB → blocked; restart, enter 20yo → in.
- [ ] Signup → **terms checkbox required** (can't continue unchecked); links open /terms + /guidelines.
- [ ] Create a flock, send a message; send `you piece of shit` → **rejected**.
- [ ] As the buddy, **report** a message (**tap** the message to open the
      report/block sheet — it is NOT a long-press) → pick a reason → confirmation.
- [ ] **Block** the buddy → their DMs rejected, their messages vanish from the flock; **unblock** → reappear.
- [ ] Log in as admin on web `/<staging>/admin/moderation` → see the report → **Hide** (message gone) / **Ban** (buddy locked out next request).
- [ ] Profile → **Delete account** → confirm; sign back in → fresh account (Apple reviewers test this exactly).
- [ ] `/<staging>/terms`, `/guidelines`, `/delete-account`, `/privacy`, `/support` all render.

## 7. Only then → prod
Once the checklist passes on staging, merge your branch → `main`.
Railway auto-deploys prod; prod already has the core tables and gets the new
columns on boot (idempotent). Then proceed with the store submission steps in
**`SUBMIT-CHECKLIST.md`** — that is the current, maintained submission doc.
(`SUBMISSION.md` is the older draft and is partly superseded.)
