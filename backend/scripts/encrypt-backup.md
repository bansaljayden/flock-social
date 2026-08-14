# Encrypting and restoring a Flock dump

Operator card. Commands only. The reasoning behind every choice here is in
`BACKUP-AND-VERIFICATION.md` in the repo root.

`scripts/dump-db.js` writes a plaintext `.sql` file containing bcrypt password
hashes, `users.apple_refresh_token`, `device_tokens.token`,
`sensor_devices.api_key`, payment handles and dates of birth. That file is
credential material. It gets encrypted, then the plaintext gets destroyed.

Everything below runs in **Git Bash** on Windows with no installs. `gpg` 2.4.x
ships with Git for Windows.

---

## Take a backup

```bash
cd backend
node scripts/dump-db.js
# -> backend/backups/flock-YYYYMMDDHHMMSS.sql

STAMP=$(ls -t backups/*.sql | head -1 | sed 's/.*flock-//; s/\.sql//')
gzip -9 "backups/flock-$STAMP.sql"          # -> flock-$STAMP.sql.gz, removes the .sql

node scripts/verify-backup.js "backups/flock-$STAMP.sql.gz"
# Must end with VERDICT: PASS. This restores the dump into a throwaway
# embedded Postgres and checks row counts, migrations, foreign keys,
# sequences and invariants. It takes seconds on a small dump, minutes on the
# full corpus. A dump that FAILS must not be encrypted or uploaded — take a
# fresh dump and verify that instead. Encrypting a broken file just locks
# the breakage behind the passphrase.

gpg --symmetric --cipher-algo AES256 \
    --s2k-digest-algo SHA512 --s2k-count 65011712 \
    -o "backups/flock-$STAMP.sql.gz.gpg" \
       "backups/flock-$STAMP.sql.gz"

sha256sum "backups/flock-$STAMP.sql.gz.gpg" > "backups/flock-$STAMP.sql.gz.gpg.sha256"
rm -f "backups/flock-$STAMP.sql.gz"          # destroy the plaintext
```

You will be prompted for the passphrase twice. Never pass it with
`--passphrase` or `--passphrase-file`: that puts it in shell history and on
disk.

Only `flock-$STAMP.sql.gz.gpg` and its `.sha256` leave this machine.

---

## Verify the ciphertext (run every time, takes seconds)

These check the ENCRYPTED artifact — that it arrived intact, decrypts, and is
a whole gzip. The restore-verify above already proved the contents; these
prove the encryption step and any transfer did not damage them. To re-verify
an old backup end to end, decrypt to a temp file, run
`node scripts/verify-backup.js` on it, then destroy the plaintext. The
quarterly keep-forever corpus archive must pass that full verify before it is
kept.

Decrypts to a pipe. Never writes plaintext to disk.

```bash
F=backups/flock-$STAMP.sql.gz.gpg

sha256sum -c "$F.sha256"                     # file arrived intact
gpg -d "$F" 2>/dev/null | gzip -t            # decrypts AND the gzip is whole
gpg -d "$F" 2>/dev/null | gzip -dc | tail -1 # must print: COMMIT;
gpg -d "$F" 2>/dev/null | gzip -dc | grep -c '^INSERT INTO'
```

All four must pass. `COMMIT;` on the last line is the proof the dump was not
truncated mid-write.

---

## Restore

Needs `psql`. If it is missing:
`winget install PostgreSQL.PostgreSQL.17` (match your Railway major version),
then add `C:\Program Files\PostgreSQL\17\bin` to PATH.

```bash
gpg -d "backups/flock-$STAMP.sql.gz.gpg" 2>/dev/null | gzip -dc > /tmp/restore.sql

psql "$TARGET_DATABASE_URL" -f database/schema.sql
node db/migrate.js                            # with DATABASE_URL=$TARGET_DATABASE_URL
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/restore.sql

shred -u /tmp/restore.sql 2>/dev/null || rm -f /tmp/restore.sql
```

`ON_ERROR_STOP=1` is not optional. Without it psql prints errors and keeps
going, and you end up with a half-restored database that looks like a success.

---

## Passphrase

Generate it on the machine, never in a chat window, never in an AI transcript:

```bash
node -e 'const c=require("crypto"),A="23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
console.log([...Array(5)].map(()=>Array.from(c.randomBytes(5),b=>A[b%32]).join("")).join("-"))'
```

125 bits. No characters that are ambiguous in handwriting.

Write it on paper in two physical locations. It does **not** go in this repo,
in OneDrive, in `.env`, or in any file on the machine that holds the backups.

Losing this passphrase destroys the ML corpus permanently. See the memo.
