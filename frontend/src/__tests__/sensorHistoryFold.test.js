/**
 * A live sensor reading is folded into the hourly history the way the server
 * builds it: door counts SUMMED, everything else AVERAGED over the readings
 * (venue audit 2026-10-03). Both venue screens used to replace the hour's
 * bucket with the one reading, so the owner's "Today's Door Count" fell from
 * 412 to 184 on the next reading and came back on a refresh.
 * FRONTEND test (jest via react-scripts).
 */
import { foldSensorReading, sameHour } from '../lib/sensorHistory';

const HOUR = new Date(2026, 9, 3, 21, 0, 0).toISOString();
const at = (min) => new Date(2026, 9, 3, 21, min, 0).toISOString();

test('a reading in the same hour adds its door count and moves the averages', () => {
  const history = [{ recorded_at: HOUR, sample_count: 3, ir_beam_count: 412, thermal_headcount: 40, noise_db: 70, occupancy: 60 }];
  const next = foldSensorReading(history, { recorded_at: at(40), ir_beam_count: 12, thermal_headcount: 44, noise_db: 74, occupancy: null }, 48);
  expect(next).toHaveLength(1);
  expect(next[0].ir_beam_count).toBe(424);
  expect(next[0].sample_count).toBe(4);
  expect(next[0].thermal_headcount).toBe(41); // (40*3 + 44) / 4
  expect(next[0].noise_db).toBe(71);
  expect(next[0].occupancy).toBe(60); // a missing reading keeps the average
});

// The history sends each hour's exact [sum, non-null count] per averaged
// figure, and the fold works from those (review 2026-10-03).
test('a steady change is not rounded away one reading at a time', () => {
  // 60 readings averaging 100, then 60 readings of 120: the server says 110.
  let history = [{ recorded_at: HOUR, sample_count: 60, thermal_headcount: 100, totals: { thermal_headcount: [6000, 60] } }];
  for (let i = 0; i < 60; i += 1) history = foldSensorReading(history, { recorded_at: at(30), thermal_headcount: 120 }, 48);
  expect(history[0].thermal_headcount).toBe(110);
  expect(history[0].totals.thermal_headcount).toEqual([13200, 120]);
});

test('readings with no value for a figure do not dilute its average', () => {
  // 59 readings without a dwell time and one of 10; a reading of 30 makes 20,
  // as Postgres's null-skipping AVG does.
  const history = [{ recorded_at: HOUR, sample_count: 60, dwell_minutes: 10, totals: { dwell_minutes: [10, 1] } }];
  const next = foldSensorReading(history, { recorded_at: at(30), dwell_minutes: 30 }, 48);
  expect(next[0].dwell_minutes).toBe(20);
  expect(next[0].sample_count).toBe(61);
});

test('an hour with no value yet for a figure starts from the first one', () => {
  const history = [{ recorded_at: HOUR, sample_count: 5, noise_db: null, totals: { noise_db: [null, 0] } }];
  const next = foldSensorReading(history, { recorded_at: at(30), noise_db: '72.50' }, 48);
  expect(next[0].noise_db).toBe(72.5);
  expect(next[0].totals.noise_db).toEqual([72.5, 1]);
});

test('a reading in a new hour opens a bucket of one, and the list stays capped', () => {
  const history = Array.from({ length: 48 }, (_, i) => ({ recorded_at: new Date(2026, 9, 1, i).toISOString(), sample_count: 1, ir_beam_count: 1 }));
  const next = foldSensorReading(history, { recorded_at: at(5), ir_beam_count: 7, thermal_headcount: 10 }, 48);
  expect(next).toHaveLength(48);
  expect(next[47]).toMatchObject({ sample_count: 1, ir_beam_count: 7, thermal_headcount: 10 });
});

test('an empty history and a bad timestamp start a new bucket rather than corrupt one', () => {
  expect(foldSensorReading([], { recorded_at: at(1), ir_beam_count: 3 }, 48)).toHaveLength(1);
  expect(sameHour('nope', at(1))).toBe(false);
});

test('both venue screens fold the reading instead of replacing the bucket', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
  expect(app).toContain('setSensorHistory(prev => foldSensorReading(prev, payload, 48));');
  expect(app).toContain('setOwnerSensorHistory(prev => foldSensorReading(prev, payload, 72));');
});

test('a numeric string from the history endpoint takes part in the average', () => {
  // noise_db is a Postgres numeric, which node-pg hands over as a string.
  const history = [{ recorded_at: HOUR, sample_count: 3, ir_beam_count: 10, noise_db: '70.00' }];
  const next = foldSensorReading(history, { recorded_at: at(30), ir_beam_count: 2, noise_db: 74 }, 48);
  expect(next[0].noise_db).toBe(71);
  expect(next[0].ir_beam_count).toBe(12);
});
