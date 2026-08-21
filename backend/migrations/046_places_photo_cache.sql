-- @requires table places_photo_cache
-- @requires table places_photo_spend
--
-- 046: the Places photo cache and its spend ledger, both in Postgres, because
-- the in-memory versions were the reason the Google invoice was what it was.
--
-- THE DEFECT THIS FIXES. routes/venueSearch.js held every proxied Places photo
-- in `const photoCache = new Map()` and every photo charge in a module-scope
-- integer. Both live in one container's heap, so both are destroyed by every
-- deploy, every crash and every Railway restart. On 2026-08-19 this service
-- deployed roughly fifteen times in one night; each deploy threw away every
-- photo the cache had already been billed for and re-bought them all from
-- Google at $7.00 per 1,000 (services/costModel.js RATES.places.skus.photos).
-- The daily cap looked like it was protecting the budget. It was actually
-- being approached by the SAME venues being purchased over and over, and when
-- it bound, a real user saw a venue card with no picture on it.
--
-- Deploys are not the only reason. Two Railway instances are two heaps, so an
-- in-memory cache halves its own hit rate and an in-memory counter doubles its
-- own ceiling, silently, with nothing in the logs to say either happened.
--
-- ---------------------------------------------------------------------------
-- places_photo_cache
-- ---------------------------------------------------------------------------
-- WHY POSTGRES AND NOT A DISK CACHE ON A RAILWAY VOLUME. A volume is attached
-- to one service instance: it does survive a deploy, but it is not shared, so
-- the second instance re-buys everything the first one already paid for, and
-- the cache silently stops being a spend control at exactly the moment traffic
-- justifies scaling out. Postgres is one copy for every instance, it is in the
-- backup that already runs, and the spend ledger below HAS to be there anyway
-- for the same "must be shared and must survive a restart" reason. Putting the
-- bytes beside the ledger adds a table, not a dependency.
--
-- THE KEY IS A HASH, NOT THE PHOTO NAME, and that is not a micro-optimisation.
-- Google's Place Photos documentation says in terms: "You cannot cache a photo
-- name. Also, the name can expire." So the name is never written down here.
-- What is stored is sha256(`<photo resource name>|<maxWidthPx>`), a fixed
-- 64-character key that identifies the row for a caller who already holds the
-- name, and that cannot hand the name back to anyone who does not. It also
-- keeps the primary key 64 bytes instead of the up-to-2KB a real resource name
-- can reach, which is the difference between an index that fits in memory and
-- one that does not.
--
-- BYTEA, and the size of it. A 400px Places photo is around 40 KB, so every row
-- is TOASTed and stored out of line, which is the right shape: the row itself
-- stays tiny and the bytes are only read when the row is actually selected.
-- routes/venueSearch.js refuses to store anything over MAX_SINGLE_PHOTO_BYTES,
-- so a pathological upstream response cannot land here as a 100 MB row.
--
-- HOW BIG THIS TABLE CAN GET, exactly: the spend ledger below caps how many
-- photos may be BOUGHT in a month, and a photo can only be inserted here by
-- being bought, so the table is bounded by the budget rather than by traffic.
-- At the shipped $300/year ceiling that is about 4,571 fetches a month, and the
-- 30-day TTL means at most two months of them are ever present at once. Call
-- it 9,200 rows at ~40 KB, under 400 MB, and that is the WORST case in which
-- every single fetch all year is a distinct new venue.
CREATE TABLE IF NOT EXISTS places_photo_cache (
  cache_key    TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BYTEA NOT NULL,
  byte_len     INTEGER NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The pruner deletes by age and nothing else reads this column, so one index on
-- it is the whole access pattern that is not the primary key. Deleting expired
-- rows is a TERMS obligation, not housekeeping: caching Places content is
-- permitted only temporarily, so a row that has outlived its window has to go
-- whether or not the disk is under pressure.
CREATE INDEX IF NOT EXISTS idx_places_photo_cache_fetched_at
  ON places_photo_cache(fetched_at);

-- ---------------------------------------------------------------------------
-- places_photo_spend
-- ---------------------------------------------------------------------------
-- ONE ROW PER UTC DAY, and the month is the SUM of them. Google bills Place
-- Photos per calendar month with the first 1,000 requests free, so the month is
-- the period the money question is actually asked in; the per-day grain is kept
-- because "what did we spend on the 14th" is the first thing anybody asks when
-- an invoice looks wrong, and a single running total cannot answer it.
--
-- A ROW HERE IS A BILLABLE GOOGLE FETCH, NOT A REQUEST. Cache hits, in memory
-- or from places_photo_cache, never touch this table. Requests coalesced onto
-- one in-flight fetch charge once between them. That is the whole design: the
-- ledger counts distinct photos bought, so it scales with venues, not users.
--
-- Charged BEFORE the fetch, for the reason utils/placesBudget.js gives: Google
-- bills a request it received even if we abort it on timeout, so charging on
-- success undercounts precisely when things are going wrong.
CREATE TABLE IF NOT EXISTS places_photo_spend (
  day        DATE PRIMARY KEY,
  fetches    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
