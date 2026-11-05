# cm

Codemagic builds from the command line: start one, follow it to its end, and
read its artifacts and the recent builds. Plain Node 18 or later, no packages.
It talks to Codemagic's v3 REST API (`https://codemagic.io/api/v3`) with a
personal API token.

Until a token is added, builds are started and followed on codemagic.io in the
browser that is already signed in.

## Commands

Read only:

    node tools/codemagic/cm.mjs apps
    node tools/codemagic/cm.mjs recent [--limit 5]
    node tools/codemagic/cm.mjs status <build id>
    node tools/codemagic/cm.mjs wait <build id> [--every 30] [--timeout 120]
    node tools/codemagic/cm.mjs artifacts <build id> [--download] [--out <folder>]

The write:

    node tools/codemagic/cm.mjs start --branch main --workflow ios-capacitor --yes

- A build id is the last part of the build page's address (24 characters).
- `start` checks the workflow against `codemagic.yaml` (its display name, such
  as "Flock iOS (Capacitor)", works too) and refuses while a build of the same
  workflow and branch is still running, unless `--even-if-running`. Without
  `--yes` it prints the exact call and stops; `--dry-run` prints it and exits
  0. Each build spends Mac build minutes.
- `wait` checks every `--every` seconds until the build ends, then prints its
  number, status and duration. It never cancels anything.
- `artifacts --download` saves the files into `--out` (default
  `codemagic-<build id>`) and will not overwrite a file that is already there.
  A download carries the token only when its address is on codemagic.io.
- The app is `--app <id>`, else `CODEMAGIC_APP_ID`, else the one app the token
  can see. `apps` lists the ids.

Exit codes: 0 done, 1 an API call failed, 2 usage or configuration, such as a
missing token file, 3 refused before the write, 4 not confirmed (add `--yes`),
5 `wait`: the build ended without finishing (failed, canceled, timeout or
skipped), 6 `wait`: still running when `--timeout` ran out.

## If a token is ever added

One time, about two minutes:

1. Sign in at codemagic.io.
2. Go to Account settings, then API token. (Older layout: Personal Account >
   Settings > Integrations > Codemagic API.)
3. Click Show and copy the token.
4. On the PC, open Notepad and paste the token, with nothing else on the line.
5. File > Save as. In the address bar at the top, type
   `%USERPROFILE%\.secrets\flock` and press Enter.
6. File name: `codemagic-token`. Save.
7. Check it: `node tools/codemagic/cm.mjs apps`

`--token-file <file>` or `CODEMAGIC_TOKEN` can stand in for the file. The tool
never prints the token. The token can do whatever the Codemagic login can; to
cancel it, Account settings > API token > Revoke.

## Tests

    node --test tools/codemagic/cm.test.mjs

Offline: a fake Codemagic answers every call, and `wait` runs on a fake clock.
