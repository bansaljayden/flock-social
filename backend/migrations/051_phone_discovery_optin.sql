-- 051: contact discovery becomes opt-in, and stops matching on raw digits.
--
-- WHAT WAS TRUE BEFORE THIS FILE. POST /api/friends/find-by-phone resolved an
-- uploaded contact list against users.phone directly, with
-- `REGEXP_REPLACE(phone, '\D', '', 'g') SIMILAR TO '%(...)'`. Two things follow
-- from that and both are fixed here rather than in the route alone:
--
--   1. EVERY user with a number on file was discoverable by anybody holding it.
--      Nobody agreed to that. A number given to Flock so an account can be
--      recovered, or because a profile form asked for one, is not consent to be
--      found by every person who has it in their address book. `phone_discoverable`
--      makes that a decision the user makes, defaulting to FALSE, which means
--      no existing account becomes discoverable because this migration ran.
--
--   2. The comparison was a suffix match over a full scan of `users`. A
--      seven-digit fragment matched every number ending in those digits across
--      a thousand area codes, so one address-book slot covered a thousand
--      numbers. `phone_hash` replaces the scan with an equality lookup on a
--      canonical whole number.
--
-- WHY THE HASH IS NOT COMPUTED HERE. It is an HMAC keyed on a secret the
-- application holds (CONTACT_DISCOVERY_SECRET, falling back to JWT_SECRET), and
-- that key is deliberately not reachable from SQL. There is therefore NO
-- backfill, and none is wanted: `phone_discoverable` defaults FALSE, so the
-- only rows that ever need a digest are the rows whose owner has opted in, and
-- the digest is written at that moment (PUT /api/users/phone-discovery) or when
-- an opted-in user changes their number (PUT /api/users/profile). Turning
-- discovery back off NULLs the column again. The result is that the database
-- holds a phone digest only for people who asked to be findable by phone.
--
-- REPLAY SAFETY. Every statement is IF NOT EXISTS and none of them rewrites a
-- row: `ADD COLUMN ... BOOLEAN NOT NULL DEFAULT FALSE` is metadata-only on
-- PostgreSQL 11 and later. __tests__/migrationBootSafety.test.js replays this
-- file over populated data and asserts nothing moves.

-- The keyed digest of the owner's number in canonical E.164 form. Written by
-- the application, never by SQL. NULL means "not discoverable by phone", which
-- is also the default state of every existing row.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_hash TEXT;

-- The consent flag itself. Read as a hard gate by the discovery query: a row
-- with a digest but a FALSE flag is not findable.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_discoverable BOOLEAN NOT NULL DEFAULT FALSE;

-- When the user last turned it on. Kept because "we can show you when you
-- agreed to this" is the only defensible answer to a parent or a regulator
-- asking when a 13-year-old made their number searchable, and because it is one
-- timestamp rather than a log of lookups.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_discoverable_at TIMESTAMPTZ;

-- Partial, on both halves of the WHERE the lookup actually runs. The index
-- therefore contains rows for opted-in users only: it is not merely a lookup
-- aid, it is the whole set of people this feature can return, and it is small
-- for the same reason.
CREATE INDEX IF NOT EXISTS idx_users_phone_hash_discoverable
  ON users (phone_hash)
  WHERE phone_discoverable AND phone_hash IS NOT NULL;
