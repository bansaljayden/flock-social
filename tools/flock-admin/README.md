# flock-admin

Flock's admin routes from a terminal. The admin dashboard needs a browser where
an admin is signed in. This tool needs an **admin access key** instead: a key
minted once from that browser and kept in a file on this computer. With it, a
script here can read the money hub, keep the expense list, send the waitlist
launch email and read the other admin surfaces, with nobody at the browser.

Plain Node 18 or later, no packages to install. Run it from the repository root:

```
node tools/flock-admin/admin.mjs status
```

## Minting a key

A key lasts 90 days unless you ask for fewer (or more, up to 180). Minting takes
a sign-in from the last 15 minutes, so a session that has been open for days
cannot mint one. Each way below starts the same:

1. Open https://www.flockcorp.com/app and sign in with the admin account. If it
   was already signed in, sign out and back in.
2. Open the browser's developer console on that tab (F12, then Console).

### Way 1: with this tool (the key is never shown)

3. In the console, copy the session token to the clipboard. This prints nothing:

   ```js
   copy(localStorage.getItem('flockToken'))
   ```

4. In PowerShell, from the repository root:

   ```powershell
   Get-Clipboard | node tools/flock-admin/admin.mjs mint --name "PC tools" --days 90 --yes
   Set-Clipboard -Value ' '
   ```

   The tool sends the token to `POST /api/admin/keys`, writes the key it gets
   back to the key file, and prints only the key's number, name and expiry. The
   second line clears the clipboard.

### Way 2: from the console alone

3. Paste this into the console. It mints the key and saves it as a download
   named `flock-admin-key`; the key is not printed:

   ```js
   (async () => {
     const r = await fetch('https://api.flockcorp.com/api/admin/keys', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('flockToken')}` },
       body: JSON.stringify({ name: 'PC tools', days: 90 }),
     });
     const j = await r.json();
     if (!r.ok) return console.log(j.error);
     const a = document.createElement('a');
     a.href = URL.createObjectURL(new Blob([`${j.key}\n`], { type: 'application/octet-stream' }));
     a.download = 'flock-admin-key';
     a.click();
     console.log(`Minted key ${j.id} "${j.name}", expires ${j.expiresAt}. Saved to Downloads as flock-admin-key.`);
   })();
   ```

4. Move the download into place. This checks it is a key, writes the key file
   and deletes the download:

   ```powershell
   node tools/flock-admin/admin.mjs key save "$HOME\Downloads\flock-admin-key"
   ```

The API shows a key once, in the answer that mints it. The server keeps only its
SHA-256 hash, so a lost key cannot be recovered: revoke it and mint another.

## Where the key lives

`%USERPROFILE%\.secrets\flock\flock-admin-key` on Windows
(`~/.secrets/flock/flock-admin-key` elsewhere), one line holding the key. The
tool writes it owner-only on macOS and Linux; on Windows it takes your profile
folder's permissions. The tool also
takes the key from the `FLOCK_ADMIN_KEY` environment variable, and a different
file from `FLOCK_ADMIN_KEY_FILE`. Never commit the key or paste it into a
tracked file: it starts `flk_admin_`, and the repository's secret scan refuses a
push that carries one, in any commit.

## Commands

Reading:

```
node tools/flock-admin/admin.mjs status            # who the key acts as, and when it expires
node tools/flock-admin/admin.mjs money             # the month's four figures and what needs you
node tools/flock-admin/admin.mjs expenses list     # every bill on the expense list
node tools/flock-admin/admin.mjs get /api/admin/costs
```

`money` prints the same figures and lines as the dashboard's Overview: both read
`frontend/src/lib/moneyHubSummary.js`. `get` reads `/api/admin` paths only and
prints the JSON.

Writing. Every write needs `--yes`. Without it, the tool says what it would do,
sends nothing that changes anything, and exits 3:

```
node tools/flock-admin/admin.mjs expenses stop 12 --yes
node tools/flock-admin/admin.mjs expenses add --vendor "Example Host" --product "Pro plan" --amount 20 --kind infrastructure --cadence monthly --renews 2026-12-16 --yes
node tools/flock-admin/admin.mjs waitlist announce --dry-run     # how many are waiting
node tools/flock-admin/admin.mjs waitlist announce --yes         # one batch of up to 100
node tools/flock-admin/admin.mjs waitlist announce --yes --all   # batch after batch until nobody is left
```

`expenses add` takes `--product`, `--category`, `--currency`, `--last-charged`,
`--renews`, `--ends` (dates as YYYY-MM-DD), `--note`, `--replaces-line`, and the
flags `--verified`, `--credit` and `--stopped`. `--json` prints the API's answer
as JSON for any command. `--api http://127.0.0.1:5000` points the tool at a
local server; it sends the key only to https, or to plain http on this machine,
and never follows a redirect.

Exit codes: 0 done, 1 the API refused or failed, 2 the command line was wrong,
3 a write that was not confirmed with `--yes`.

## Revoking a key

- On the dashboard: Admin dashboard, Overview, **Access keys**, then Revoke and
  Revoke for good. The list shows each key's name, when it was made, when it
  expires, when and from where it was last used, and its last few uses.
- From this tool: `node tools/flock-admin/admin.mjs revoke --yes` revokes the key
  it holds and deletes the key file.
- A key also stops on its own at its expiry, and the moment its account signs
  out everywhere, changes or resets its password, stops being an admin or is
  banned. Deleting the account deletes its keys.

## What a key can reach

A key acts as the admin who minted it, on this list of admin routes and nothing
else (`ADMIN_KEY_ROUTES` in `backend/middleware/adminKeys.js`):

| Route | For |
| --- | --- |
| `GET /api/admin/whoami` | who the key acts as, and when it expires |
| `GET /api/admin/money` | the money hub |
| `GET /api/admin/costs`, `POST /api/admin/costs/reconciled` | the cost panel, and a vendor bill recorded against it |
| `GET /api/admin/expenses`, `GET /api/admin/expenses/export` | the expense list, and its CSV |
| `POST /api/admin/expenses`, `POST /api/admin/expenses/import` | a bill added, or the whole list pasted |
| `PUT /api/admin/expenses/:id`, `DELETE /api/admin/expenses/:id` | a bill edited or stopped, or removed when entered by mistake |
| `POST /api/admin/waitlist/announce` | the waitlist launch email, and its dry run |
| `GET /api/admin/analytics` | the Research tab |
| `GET /api/admin/reports`, `GET /api/admin/moderation-actions`, `GET /api/admin/venues/unverified` | the moderation queue, its audit log and the verification queue, to read |
| `DELETE /api/admin/keys/:id` | the key revoking itself, and no other key |

## What a key cannot do

- Mint a key or list keys. Minting takes a person signed in.
- Make a moderation decision (`PUT /api/admin/reports/:id`): bans and unbans end
  or restore an account's sessions, and they stay with a person.
- Open reported content or photos (`/api/admin/reports/:id/content`, `/image`).
- Verify a venue or change its tier, or mint an NFC tag signature.
- Change a password, an email address, a session or a role, or delete an
  account: none of those routes is an admin route, and every route outside the
  admin routes answers a key with 403.
- Act as its owner anywhere in the app: plans, chats, friends, the profile. A
  key cannot open the live connection (socket) either.
- Reach an admin route added later, until someone adds it to the list. Every
  admin route is on one of the two lists in `backend/middleware/adminKeys.js`,
  and a test fails until a new one is.

## What is logged

Every use of a key is written to the `admin_key_uses` table (migration 135): the
method, the path (never the query string), the answer's status, the time and
the address it came from. A use that reaches a route is written before the
route runs, so a use that cannot be logged does not happen. A refused use
(expired, revoked, ended, or a route a key may not reach) is written with the
reason. The dashboard's Access keys list shows the last few uses of each key.
