-- 095: the Flux sensor's occupancy estimate, stored with each reading.
--
-- ASCII only, like 065, 082, 091-094: the embedded server the boot-safety
-- suite runs is WIN1252.
--
-- WHY. A reading used to carry two people numbers that answer different
-- questions: ir_beam_count is doorway crossings in the interval and
-- thermal_headcount is the warm bodies one camera can see. Neither is how many
-- people are inside. Newer devices work that out on the device, combining the
-- doorway in/out count with the thermal count, and send it with a plausible
-- range around it and, when enough people arrived in the last hour to say, how
-- long a visitor typically stays (Little's law: average occupancy over arrival
-- rate). Without columns for them routes/sensors.js would have to drop them.
--
-- WHO WRITES IT. routes/sensors.js INGEST_SQL, bounded there: occupancy and
-- its band 0-5000, dwell_minutes 1-1440. A band that arrives out of order is
-- stored as NULL rather than refused, because a refused reading is one the
-- device drops forever.
--
-- WHO READS IT. GET /api/sensors/:placeId/current and /history, and through
-- them the venue card and the owner dashboard, which prefer occupancy over
-- thermal_headcount when a row has it.
--
-- ADDITIVE. Nullable columns with no default are catalog changes: no rewrite,
-- no scan, and every existing row reads NULL, which is the truth for them (the
-- devices that wrote them never sent an estimate). A replay is a no-op.
-- @requires column venue_sensor_data.occupancy
-- @requires column venue_sensor_data.occupancy_low
-- @requires column venue_sensor_data.occupancy_high
-- @requires column venue_sensor_data.dwell_minutes

ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS occupancy INTEGER;
ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS occupancy_low INTEGER;
ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS occupancy_high INTEGER;
ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS dwell_minutes INTEGER;
