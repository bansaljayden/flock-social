"""Tests for score_sealed.py (OWL-RECORDING-PROTOCOL.md section 14.8), on a fake batch of generated
frames and made-up counts. Nothing here reads a sealed file.

    python -m unittest flock-sensor/training/test_score_sealed.py   (needs numpy and onnxruntime)
"""
import csv
import datetime
import hashlib
import json
import os
import random
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import score_sealed as ss  # noqa: E402
from frames import FORMAT, VERSION, encode_frame  # noqa: E402

MODELS = HERE.parent / 'models'
COLS, ROWS = 160, 120
T0 = 1793000000.0   # a fixed phone-clock start, in epoch seconds


def frame(people=(), palm=False, flat=False):
    """A generated room: a 22 C gradient, warm 8 x 12 bodies at the given (x, y), a palm over the
    lens (everything about 33 C), or the flat shutter frame."""
    if flat:
        return [22.0] * (COLS * ROWS)
    f = []
    for y in range(ROWS):
        for x in range(COLS):
            f.append((33.0 if palm else 22.0) + 0.02 * x + 0.01 * y)
    for px, py in people:
        for y in range(max(0, py), min(ROWS, py + 12)):
            for x in range(max(0, px), min(COLS, px + 8)):
                f[y * COLS + x] = 34.0
    return f


def people_at(t, n):
    rng = random.Random(int(t))
    return [(10 + 18 * (i % 8) + rng.randint(0, 3), 15 + 40 * (i // 8)) for i in range(n)]


def make_session(root, name, pi_offset=0.0, end_note_shift=0.0, minutes=8, late_beep=None):
    """A session folder: a .frames file on the Pi's clock (phone clock + pi_offset), and tallies from
    counters A and B on the phone clock. SYNC palms at 20 s and minutes*60 - 20 s; scene S1 from 40 s,
    S5 (moving) from the middle. Returns the session folder."""
    folder = Path(root) / name
    folder.mkdir(parents=True)
    n = int(minutes * 60)
    syncs = (20, n - 20)
    people_count = {}
    started = datetime.datetime.fromtimestamp(T0 + pi_offset).astimezone()
    with open(folder / f'{name}.frames', 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps({'format': FORMAT, 'version': VERSION, 'session': name, 'room': 'test',
                            'note': f'{name} S1 S5 P1', 'started': started.isoformat(), 'device': 'test',
                            'cols': COLS, 'rows': ROWS, 'every_seconds': 1, 'recorder': 'test'}) + '\n')
        for t in range(n):
            if any(s <= t < s + 3 for s in syncs):
                c = frame(palm=True)
            else:
                k = 1 + (t // 30) % 4
                people_count[t] = k
                c = frame(people_at(t, k))
            f.write(json.dumps({'t': float(t), 'c': encode_frame(c)}) + '\n')
    cols = ['seq', 'type', 'value', 'local_time', 'iso_time', 'epoch_ms', 'slot', 'scan_started', 'occlusion',
            'edge', 'zone', 'session', 'counter', 'note', 'voided']
    for role in ('A', 'B'):
        rows, seq = [], 0

        def add(t, type_, value='', note='', slot='', occ=''):
            nonlocal seq
            seq += 1
            d = datetime.datetime.fromtimestamp(T0 + t).astimezone()
            rows.append({'seq': seq, 'type': type_, 'value': value, 'local_time': d.strftime('%Y-%m-%d %H:%M:%S'),
                         'iso_time': d.isoformat(), 'epoch_ms': int(round((T0 + t) * 1000)), 'slot': slot,
                         'scan_started': '', 'occlusion': occ, 'edge': 0 if type_ == 'count' else '',
                         'zone': 'room', 'session': name, 'counter': f'{role}-TT', 'note': note, 'voided': 0})
        if role == 'A':
            add(syncs[0], 'note', note='SYNC')
            add(40, 'note', note='S1 start')
            add(41, 'note', note='seats 6')
            add(n // 2, 'note', note='S5 start')
            add(syncs[1] + end_note_shift, 'note', note='SYNC')
        for beep in range(60, n - 40, 30):
            slot = f'slot{beep:05d}'
            add(beep, 'reminder', slot=slot)
            # A late count is saved 27 s after its beep: past the 25 s rule, before the next beep
            # (a count saved at the next beep belongs to that beep).
            lag = 27 if late_beep == beep else 5
            add(beep + lag, 'count', value=people_count.get(beep + 1, 0), slot=slot, occ='0')
        rows.sort(key=lambda r: r['epoch_ms'])
        with open(folder / f'counts-{name}-{role}-TT-2026-10-24-1200.csv', 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
    return folder


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def seal_listing(sums, folder):
    """<session>.SHA256SUMS for the folder's files, plus a stand-in archive and its line."""
    lines = [f'{sha(p)}  {p.name}' for p in sorted(folder.iterdir())]
    arch = sums / f'{folder.name}.tar.gpg'
    arch.write_bytes(os.urandom(256))
    lines.append(f'{sha(arch)}  {arch.name}')
    (sums / f'{folder.name}.SHA256SUMS').write_text('\n'.join(lines) + '\n', encoding='utf-8')


@unittest.skipUnless((MODELS / 'people.onnx').exists() and (MODELS / 'people-fine.onnx').exists(),
                     'the Owl model files are not in flock-sensor/models')
class ScoreSealedTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='score-sealed-test-'))
        self.unsealed, self.sums, self.models, self.out = (self.tmp / d for d in ('unsealed', 'sums', 'models', 'out'))
        for d in (self.unsealed, self.sums, self.models):
            d.mkdir()
        for m in ('people.onnx', 'people-fine.onnx'):
            shutil.copy(MODELS / m, self.models / m)
        self.freeze = self.tmp / 'FREEZE.txt'
        self.freeze.write_text(
            f"Model:        people.onnx       sha256 {sha(self.models / 'people.onnx')}\n"
            f"Crowd model:  people-fine.onnx  sha256 {sha(self.models / 'people-fine.onnx')}\n"
            f"Scorer:       flock-sensor/training/score_sealed.py at commit test, sha256 {sha(ss.__file__)}\n",
            encoding='utf-8')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def batch(self, **kw):
        for name in ('s1', 's2'):
            folder = make_session(self.unsealed, name, **kw)
            seal_listing(self.sums, folder)

    def run_scorer(self, *extra):
        return ss.main(['--unsealed', str(self.unsealed), '--sums', str(self.sums), '--freeze', str(self.freeze),
                        '--models', str(self.models), '--out', str(self.out), *extra])

    def test_changed_byte_stops_it(self):
        self.batch()
        p = next((self.unsealed / 's1').glob('*.frames'))
        data = bytearray(p.read_bytes())
        data[200] ^= 1
        p.write_bytes(bytes(data))
        self.assertEqual(self.run_scorer(), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_extra_file_stops_it(self):
        self.batch()
        (self.unsealed / 's1' / 'extra.txt').write_text('x', encoding='utf-8')
        self.assertEqual(self.run_scorer(), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_frame_window(self):
        times, flat = [0.0, 10.0], [False, False]
        self.assertIsNone(ss.match_frame(times, flat, 8.8))   # 1.2 s from the nearest frame
        self.assertEqual(ss.match_frame(times, flat, 9.1), 1)

    def test_shutter_frame_passed_over(self):
        self.assertEqual(ss.match_frame([10.0, 10.5], [True, False], 10.0), 1)
        self.assertIsNone(ss.match_frame([10.0, 11.6], [True, False], 10.0))

    def test_late_count_dropped(self):
        rows = [{'type': 'reminder', 't': 100.0, 'slot': 'a'},
                {'type': 'count', 't': 130.0, 'value': '3', 'voided': '0', 'zone': 'room'},
                {'type': 'reminder', 't': 200.0, 'slot': 'b'},
                {'type': 'count', 't': 205.0, 'value': '2', 'voided': '0', 'zone': 'room'}]
        by_slot, late = ss.assign_counts(rows)
        self.assertEqual(late, 1)
        self.assertEqual(set(by_slot), {'b'})

    def test_clock_offset_found_and_corrected(self):
        folder = make_session(self.unsealed, 'off', pi_offset=3.0)
        steps = dict.fromkeys(('beeps', 'late_counts_dropped', 'no_count_from_A', 'clock_uncertain_moving_dropped',
                               'no_frame', 'kept'), 0)
        items, clock = ss.score_session(folder, ss.load_owl(self.models), steps)
        self.assertAlmostEqual(clock['mean_offset'], 3.0, delta=0.5)
        self.assertAlmostEqual(clock['correction'], clock['mean_offset'])
        self.assertFalse(clock['clock_uncertain'])
        self.assertTrue(items)
        for it in items:   # every item is the frame for its own beep: truth equals the generated count
            self.assertLessEqual(abs(it['frame_offset_s']), 1.0)

    def test_mismatched_offsets_drop_only_moving_scenes(self):
        folder = make_session(self.unsealed, 'mis', pi_offset=3.0, end_note_shift=2.5)
        steps = dict.fromkeys(('beeps', 'late_counts_dropped', 'no_count_from_A', 'clock_uncertain_moving_dropped',
                               'no_frame', 'kept'), 0)
        items, clock = ss.score_session(folder, ss.load_owl(self.models), steps)
        self.assertTrue(clock['clock_uncertain'])
        self.assertGreater(steps['clock_uncertain_moving_dropped'], 0)
        self.assertTrue(items)
        self.assertTrue(all(it['scene'] not in ss.MOVING_SCENES for it in items))

    def test_owl_count_equals_the_sensors(self):
        folder = make_session(self.unsealed, 'owl')
        steps = dict.fromkeys(('beeps', 'late_counts_dropped', 'no_count_from_A', 'clock_uncertain_moving_dropped',
                               'no_frame', 'kept'), 0)
        items, _ = ss.score_session(folder, ss.load_owl(self.models), steps)
        from frames import read_session
        _, frames = read_session(next(folder.glob('*.frames')))
        main = ss.sensor()
        fresh = main.PeopleModel(self.models / 'people.onnx', 0.4)
        fresh.fine = main.PeopleModel(self.models / 'people-fine.onnx', 0.4)
        for it in items:
            c = frames[it['frame']][1]
            self.assertEqual(it['owl'], fresh.read_crowd(c)[2])
            self.assertEqual(it['rule'], main.count_thermal_clusters(c))

    def test_second_run_refuses_without_a_reason(self):
        self.batch()
        self.assertEqual(self.run_scorer(), 0)
        first = (self.out / 'report.json').read_bytes()
        self.assertEqual(self.run_scorer(), 2)
        self.assertEqual(self.run_scorer('--rerun-reason', 'test: a scorer bug fixed'), 0)
        self.assertEqual((self.out / 'report.json').read_bytes(), first)
        reruns = list(self.out.glob('rerun-*/report.json'))
        self.assertEqual(len(reruns), 1)

    def test_outputs_are_text_only(self):
        self.batch()
        self.assertEqual(self.run_scorer(), 0)
        files = [p for p in self.out.rglob('*') if p.is_file()]
        self.assertTrue(files)
        self.assertTrue(all(p.suffix in {'.csv', '.md', '.json', '.lock'} for p in files), files)
        report = json.loads((self.out / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(set(report['bars']), {'B1', 'B2', 'B3', 'B4', 'B5'})
        self.assertGreater(report['steps']['kept'], 0)

    def test_late_beep_is_dropped_in_a_full_run(self):
        folder = make_session(self.unsealed, 'late', late_beep=120)
        steps = dict.fromkeys(('beeps', 'late_counts_dropped', 'no_count_from_A', 'clock_uncertain_moving_dropped',
                               'no_frame', 'kept'), 0)
        ss.score_session(folder, ss.load_owl(self.models), steps)
        self.assertEqual(steps['late_counts_dropped'], 2)   # counters A and B were both late on that beep
        self.assertEqual(steps['no_count_from_A'], 1)


if __name__ == '__main__':
    unittest.main()
