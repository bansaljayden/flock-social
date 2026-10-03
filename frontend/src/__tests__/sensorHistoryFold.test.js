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
