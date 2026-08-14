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

> The local E2E harness (`backend/scripts/e2e-local.js`, run with `npm run e2e`)
> already proved the backend logic and prints its own `E2E: N passed, M failed`
> line. **Do not quote a fixed pass count from this doc; read the harness output.**
> (This paragraph used to say "34 assertions today", which was already wrong by
> 2026-08-14: the file now has ~80 `check(...)` calls. Which is exactly why the
> rule above exists.) One of those checks is literally "fresh database built from
> migrations alone", which is what retired the manual schema step in §2. Staging
> proves the *device* half + the deploy path.

## 1. Stand up a Railway staging service
- In Railway, create a **second service/environment** off the same repo, deployed
  from whatever branch you are testing (NOT `main`).
  > The original text named `submission-readiness`. That branch was merged into
  > `main` long ago; the current branch is `main`. Substitute your own feature
  > branch. As of 2026-08-14 the Railway project `trustworthy-spirit` has exactly
  > one environment (`production`) and one app service (`Flock-app-`), so **no
  > staging service exists yet** — this whole runbook is still unexecuted.
- Add a **separate Postgres** to it (a throwaway DB — never point staging at the
  prod database).

## 2. Bootstrap the staging DB

> **Updated 2026-08-14: step 1 is no longer required.**
> `backend/migrations/000_bootstrap.sql` is now **tracked in git** (committed in
> `66b0614`) and contains the core `CREATE TABLE`s, all `IF NOT EXISTS`. So the
> migration runner is self-bootstrapping: a fresh, empty database is fully built
> by migrations alone. The old two-step instruction (apply `schema.sql` by hand
> first) was written when that file was untracked and did not deploy.

Just deploy the branch. `backend/db/migrate.js`, called from `server.js`, runs
every file in `backend/migrations/` in order **before** the port opens, inside a
`pg_advisory_lock`, recording what it applied in `schema_migrations`. A failure
logs `FATAL: migration failed` and exits 1, so you never get a half-migrated
service answering requests.

If you prefer to apply the base schema explicitly anyway, `npm run db:init` does
exactly that (`psql "$DATABASE_URL" -f database/schema.sql`). It is optional and
idempotent.

> ⚠️ **One migration is currently untracked: `015_password_reset.sql`**, along with
> `frontend/src/components/auth/PasswordReset.js` and the password-reset test,
> while `backend/routes/auth.js` sits modified-uncommitted. A staging service
> deployed from HEAD will **not** have `password_resets` / `password_reset_requests`,
> so forgot-password will 500 there. Commit the migration in the same commit as
> the route, or do not test that flow on staging yet.

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

> ⚠️ **Two guards added since this was written (verified 2026-08-14).** The
> command above will **refuse to run** against a non-localhost database unless you
> also set `SEED_REVIEW_CONFIRM=1`, because it upserts over any existing row with
> those addresses. And `ReviewPass123` is only the script's default: set
> `SEED_REVIEWER_PASSWORD` (and `SEED_BUDDY_PASSWORD`) to override it, because the
> default is published in this repo. So the real staging invocation is:
> ```
> cd backend && DATABASE_URL="$STAGING_DATABASE_URL" SEED_REVIEW_CONFIRM=1 \
>   SEED_REVIEWER_PASSWORD='...' SEED_BUDDY_PASSWORD='...' node scripts/seed-review-account.js
> ```

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
- [ ] Sign Up → **date-of-birth field**; enter a < 13 DOB → blocked client-side and
      again server-side; enter a 20yo DOB → in. (Corrected 2026-08-14: there is no
      neutral first-launch age screen. The gate is a field on the Sign Up form.)
- [ ] Signup → the consent line **"Creating an account means you agree to the
      Terms, Privacy Policy and Community Guidelines"** renders under Create Account
      and above the Google and Apple buttons; all three links open the real pages.
      (Corrected 2026-08-14: it is a **sentence with links, not a checkbox**. The
      backend stamps `terms_accepted_at` on every signup path regardless.)
- [ ] Create a flock, send a message; send `you piece of shit` → **rejected**.
- [ ] As the buddy, **report** a message (**tap** the message to open the
      report/block sheet — it is NOT a long-press) → pick a reason → confirmation.
- [ ] **Block** the buddy → their DMs rejected, their messages vanish from the flock;
      then Settings → **Blocked accounts** → **Unblock** → they reappear.
      (The unblock screen shipped 2026-08-14. Before that there was no way to lift
      a block from inside the app, so any older copy of this checklist that asked
      you to unblock was describing something that did not exist.)
- [ ] Log in as admin on web `/<staging>/admin/moderation` → see the report → **Hide** (message gone) / **Ban** (buddy locked out next request).
      ⚠️ This needs `ADMIN_USER_IDS` set on the staging service (comma-separated
      user ids, promoted to `role='admin'` on every boot). It is **not** set on
      production either as of 2026-08-14, and it fails silently — no admin, no
      console, no error. Set it in both places.
- [ ] Profile → **Delete account** → confirm; sign back in → fresh account (Apple reviewers test this exactly).
- [ ] `/<staging>/terms`, `/guidelines`, `/delete-account`, `/privacy`, `/support` all render.

## 7. Only then → prod
Once the checklist passes on staging, merge your branch → `main`.
Railway auto-deploys prod; prod already has the core tables and gets the new
columns on boot (idempotent). Then proceed with the store submission steps in
**`SUBMIT-CHECKLIST.md`** — that is the current, maintained submission doc.
(`SUBMISSION.md` is the older draft and is partly superseded.)
