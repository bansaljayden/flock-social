# cfdns

The flockcorp.com DNS records on Cloudflare, from the command line: list them,
add or remove one, and check the token. Plain Node 18 or later, no packages.
It talks to Cloudflare's v4 API with a token that reaches the flockcorp.com
zone only.

Until a token is added, DNS records are changed in the Cloudflare dashboard in
the browser that is already signed in.

## Commands

    node tools/cfdns/cfdns.mjs verify
    node tools/cfdns/cfdns.mjs list [--type MX] [--name receipts]
    node tools/cfdns/cfdns.mjs add --type MX --name receipts --content route1.mx.cloudflare.net --priority 10 --yes
    node tools/cfdns/cfdns.mjs remove <record id> --yes

- `--name` is relative to the zone (`receipts`), the full name
  (`receipts.flockcorp.com`), or `@` for flockcorp.com itself. `list` prints
  each record's id, which `remove` takes.
- `add` writes A, AAAA, CNAME, MX and TXT records. MX needs `--priority`.
  `--ttl` is `auto` (the default) or 60 to 86400 seconds. `--proxied
  true|false` is for A, AAAA and CNAME, and defaults to false. A record that is
  already there is left as it is.
- `add` and `remove` print the exact call and stop without `--yes`;
  `--dry-run` prints it and exits 0.
- Live records refuse both unless `--i-know-this-is-live` is given too: every
  record at flockcorp.com itself (the site, and the MX records route1, route2
  and route3.mx.cloudflare.net that carry the domain's mail), at
  www.flockcorp.com and at api.flockcorp.com. `list` marks them LIVE.
- `verify` checks that the token is active, reaches flockcorp.com and no other
  zone, and can read its DNS records. Cloudflare's token check does not list
  permissions, so DNS Edit shows on the first `add` or `remove`.

Exit codes: 0 done, 1 an API call failed, 2 usage or configuration, such as a
missing token file, 3 refused before any write (a live record without
`--i-know-this-is-live`, or a failed check), 4 not confirmed (add `--yes`).

## If a token is ever added

One time, about three minutes:

1. Sign in at dash.cloudflare.com and open My Profile > API Tokens
   (dash.cloudflare.com/profile/api-tokens).
2. Create Token. Next to "Edit zone DNS", click Use template.
3. Permissions: keep Zone | DNS | Edit. Click + Add more and set the new row
   to Zone | Zone | Read, which lets the tool find the zone by name.
4. Zone Resources: Include | Specific zone | flockcorp.com.
5. Continue to summary, then Create Token. Copy the token; Cloudflare shows it
   only once.
6. On the PC, open Notepad and paste the token, with nothing else on the line.
7. File > Save as. In the address bar at the top, type
   `%USERPROFILE%\.secrets\flock` and press Enter.
8. File name: `cloudflare-dns-token`. Save.
9. Check it: `node tools/cfdns/cfdns.mjs verify` ends with "Ready".

`--token-file <file>` or `CF_DNS_TOKEN` can stand in for the file. The tool
never prints the token. To cancel it, delete it on the same API Tokens page.

## Tests

    node --test tools/cfdns/cfdns.test.mjs

Offline: a fake Cloudflare answers every call.
