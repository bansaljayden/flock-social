-- @noTransaction
-- 125: the two stamps collectWeekly --order=stalest was missing. Every
-- ml_venues row that holds weekly rows says when the newest of them landed
-- (last_collected_at), and a by-name lookup that went out and got no answer
-- is recorded on its venue (besttime_name_unanswered_at, new).
-- scripts/ml/collectWeekly.js reads both off the venue row.
--
-- ASCII only, like 122 and 123: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY, THE BACKFILL. --order=stalest puts a venue in line by the latest of
-- its stamps, oldest first, and a venue with none comes first of all
-- (ORDER_BY_STALEST in collectWeekly.js). The order reads the venue row and
-- not ml_training_data, because a per-venue MAX(collected_at) subquery was
-- answered by walking idx_ml_training_collected backward past every newer
-- row, once per venue. collectWeekly and the harvest stamp last_collected_at
-- when weekly rows land. scripts/ml/discoverBestTime.js wrote weekly rows and
-- stamped nothing, so a venue it found today, holding a full fresh week, was
-- put ahead of venues whose curves were a month old in every by-id refresh.
-- The script stamps the column now. This fills it in for the venues it left
-- without one, from the newest weekly row each holds.
--
-- ONLY WHERE THE STAMP IS NULL. A venue whose stamp is older than its newest
-- weekly row (stamped by collectWeekly, refreshed later by discoverBestTime)
-- keeps it: that venue is refreshed early, never ahead of a curve older than
-- its stamp, and its next refresh moves the stamp. A venue with no weekly
-- row keeps its NULL, which is what puts a venue with no curve first.
--
-- CHEAP ON THE REAL TABLE. ml_training_data is about 3.5M rows. The newest
-- weekly row is taken with one GROUP BY over the rows of the venues whose
-- stamp is NULL, which the planner answers with a single pass over the table
-- or, when few venues qualify, with idx_ml_training_venue lookups for those
-- venues alone. The GROUP BY is load-bearing: an ungrouped MAX(collected_at)
-- per venue can be planned as the backward walk above, a grouped one cannot.
-- Measured on embedded Postgres against a synthetic table of 3.5M rows
-- (621 MB: 20,000 venues with a week each, 140,000 live rows, 17,000 NULL
-- stamps of which 2,000 held a week): one sequential pass, 0.63 s, all 2,000
-- stamped at their newest row. With 50 to stamp and no other NULL it took
-- the index path, 9 ms.
--
-- WHY, besttime_name_unanswered_at. A by-name lookup spends one of the
-- plan's 100 new-venue admissions a month, and --skip-attempted, which picks
-- the venues an admission run asks, selects besttime_attempted_at IS NULL.
-- So collectWeekly leaves that column NULL when a by-name lookup gets no
-- answer (a 503, a 429, a timeout, a dropped connection), and the venue
-- stays on offer for its admission. It also left the venue with no other
-- stamp, so under --order=stalest --limit=N a venue that drew a 503 every
-- time came first in every run and the venues behind it were never asked.
-- This column is the stamp for that case: --order=stalest reads it,
-- --skip-attempted does not. stampFailedAsk in collectWeekly.js writes it,
-- for a venue asked by name, on any failure short of a key-level one; a
-- timeout is stamped like the rest, and that function says why.
--
-- ADDITIVE. A nullable column with no default is a catalog change: no
-- rewrite, no scan, and every row reads NULL, which is true of all of them,
-- since no unanswered lookup was recorded before the column existed.
--
-- @noTransaction so the ALTER commits on its own: ACCESS EXCLUSIVE on
-- ml_venues for a catalog change, then released, and the backfill after it
-- takes row locks only. In one transaction that lock would be held through
-- the backfill, or, with the ALTER last, taken as an upgrade a concurrent
-- writer could deadlock against. Each statement is safe to run again, so a
-- boot that dies between them replays the file whole.
--
-- A REPLAY MOVES NOTHING. The column is already there, and after the first
-- run no venue holds a weekly row and a NULL stamp, so the UPDATE matches
-- nothing (the same pass, 0.53 s on that table, writing no row). A restore
-- from a dump taken before this file brings those NULLs back; this UPDATE,
-- run again by hand, fills them and touches nothing else.
-- @requires column ml_venues.besttime_name_unanswered_at

ALTER TABLE ml_venues ADD COLUMN IF NOT EXISTS besttime_name_unanswered_at TIMESTAMPTZ;

UPDATE ml_venues v
   SET last_collected_at = w.newest
  FROM (SELECT t.venue_id, MAX(t.collected_at) AS newest
          FROM ml_training_data t
         WHERE t.collection_mode = 'weekly'
           AND t.collected_at IS NOT NULL
           AND t.venue_id IN (SELECT n.id FROM ml_venues n WHERE n.last_collected_at IS NULL)
         GROUP BY t.venue_id) w
 WHERE v.id = w.venue_id
   AND v.last_collected_at IS NULL;
