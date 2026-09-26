-- 094: what BestTime's live answer says about itself, stored with each reading.
--
-- ASCII only, like 065, 082, 091, 092 and 093: the embedded server the
-- boot-safety suite runs is WIN1252.
--
-- WHY. The live call returns, beside the busyness, the hour the live value is
-- measured for (analysis.hour_start), whether the vendor has the venue open
-- (venue_info.venue_open, 'Open' or 'Closed') and the vendor's own clock at
-- the call (venue_info.venue_current_localtime). The collector read two of
-- them from keys that do not exist in the live response, so all three were
-- lost on every reading. The retrain plan (scripts/ml/RETRAIN.md) needs them:
-- live readings match the weekly curve of the hour BEFORE better than their
-- own hour's, and hour_start is what separates a vendor value that lags the
-- clock from a labelling problem; venue_open is what explains live readings
-- at slots whose curve says the venue is shut.
--
-- WHO WRITES IT. scripts/ml/collectRealtime.js, on every realtime row, NULL
-- wherever the answer did not carry a clean value. It declares the same three
-- columns itself (ADD COLUMN IF NOT EXISTS), because it deploys with the
-- BESTTIME collector and can run before the main service boots this file.
--
-- WHO READS IT. scripts/ml/train/export_training_data.js carries all three
-- into the CSV (columns 46-48). They are not model features: serving scores
-- hours no live call has been made for.
--
-- ADDITIVE. Nullable columns with no default are catalog changes: no rewrite,
-- no scan, and every existing row reads NULL, which is the truth for them. A
-- replay is a no-op.
-- @requires column ml_training_data.live_hour_start
-- @requires column ml_training_data.live_venue_open
-- @requires column ml_training_data.live_local_time

ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS live_hour_start SMALLINT;
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS live_venue_open BOOLEAN;
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS live_local_time VARCHAR(48);
