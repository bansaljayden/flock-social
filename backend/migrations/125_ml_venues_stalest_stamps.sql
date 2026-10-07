-- 125: every ml_venues row that holds weekly rows says when the newest of
-- them landed. scripts/ml/collectWeekly.js --order=stalest reads that stamp
-- off the venue row.
--
-- ASCII only, like 122 and 123: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. --order=stalest puts a venue in line by the later of
-- last_collected_at and besttime_attempted_at, oldest first, and a venue
-- with neither comes first of all (ORDER_BY_STALEST in collectWeekly.js).
-- The order reads the venue row and not ml_training_data, because a
-- per-venue MAX(collected_at) subquery was answered by walking
-- idx_ml_training_collected backward past every newer row, once per venue.
-- collectWeekly and the harvest stamp last_collected_at when weekly rows
-- land. scripts/ml/discoverBestTime.js wrote weekly rows and stamped
-- nothing, so a venue it found today, holding a full fresh week, was put
-- ahead of venues whose curves were a month old in every by-id refresh.
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
-- A REPLAY MOVES NOTHING. After the first run no venue holds a weekly row
-- and a NULL stamp, so the WHERE matches nothing (the same pass, 0.53 s on
-- that table, writing no row). A restore from a dump taken before this file
-- brings those NULLs back; this UPDATE, run again by hand, fills them and
-- touches nothing else.

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
