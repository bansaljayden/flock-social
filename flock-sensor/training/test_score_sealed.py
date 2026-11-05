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
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import score_sealed as ss  # noqa: E402
from frames import FORMAT, VERSION, encode_frame  # noqa: E402

MODELS = HERE.parent / 'models'
# The three models the recording grades (OWL-RECORDING-PROTOCOL.md section 11): each one's files and
# main.py at the commit that shipped it, and the settings that main.py ships.
FROZEN = {'owl-4.9': ('f5920f6f', (0.4, 5)), 'owl-5': ('e7f5da3d', (0.35, 4)), 'owl-5.1': ('1e92ebfd', (0.35, 6))}
ON_FLUX = 'owl-5.1'
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


def git_file(commit, path, dest):
    dest.write_bytes(subprocess.run(['git', '-C', str(HERE), 'show', f'{commit}:{path}'],
                                    capture_output=True, check=True).stdout)


def freeze_text(models, settings=None, on_flux=ON_FLUX, scorer=None, extra=()):
    """A FREEZE.txt in section 11's shape, one block per model; `settings` overrides a model's, and
    `extra` lines (another model's block) go after the three."""
    lines = ['Frozen at: test', f'On Flux:      {on_flux}',
             'Models:       three, graded together; one block each:']
    for name, (commit, shipped) in FROZEN.items():
        if name not in models:
            continue
        th, ca = (settings or {}).get(name, shipped)
        lines += [f'  Name:         {name}',
                  f"  Model:        people.onnx       sha256 {sha(models[name] / 'people.onnx')}",
                  f"  Crowd model:  people-fine.onnx  sha256 {sha(models[name] / 'people-fine.onnx')}",
                  f'  Decoder:      flock-sensor/main.py at the commit that shipped it {commit} (VERSION test)',
                  f'  Settings:     THERMAL_MODEL_THRESHOLD={th}, CROWD_AT={ca}, main.py\'s shipped defaults']
    lines += list(extra)
    lines.append(f'Scorer:       flock-sensor/training/score_sealed.py at commit test, sha256 {scorer or sha(ss.__file__)}')
    return '\n'.join(lines) + '\n'


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
        self.unsealed, self.sums, self.out = (self.tmp / d for d in ('unsealed', 'sums', 'out'))
        for d in (self.unsealed, self.sums):
            d.mkdir()
        self.models = {}
        for name, (commit, _) in FROZEN.items():
            d = self.tmp / 'models' / name
            d.mkdir(parents=True)
            for m in ('people.onnx', 'people-fine.onnx'):
                git_file(commit, f'flock-sensor/models/{m}', d / m)
            self.models[name] = d
        self.freeze = self.tmp / 'FREEZE.txt'
        self.freeze.write_text(freeze_text(self.models), encoding='utf-8')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def batch(self, **kw):
        for name in ('s1', 's2'):
            folder = make_session(self.unsealed, name, **kw)
            seal_listing(self.sums, folder)

    def run_scorer(self, *extra, models=None):
        args = []
        for name, d in (self.models if models is None else models).items():
            args += ['--models', f'{name}={d}']
        return ss.main(['--unsealed', str(self.unsealed), '--sums', str(self.sums), '--freeze', str(self.freeze),
                        *args, '--out', str(self.out), *extra])

    def unshipped(self, chosen=(0.3, 3), frozen=None, winner=None):
        """owl-5.2 beside the three: owl-5.1's files under its own name, decoded by owl-5.1's main.py at
        the setting a choice file beside FREEZE.txt chose. `frozen` is the setting FREEZE.txt writes
        (the chosen one if None); `winner` overrides the choice file's winner."""
        d = self.tmp / 'models' / 'owl-5.2'
        d.mkdir(parents=True, exist_ok=True)
        for m in ('people.onnx', 'people-fine.onnx'):
            shutil.copy(self.models['owl-5.1'] / m, d / m)
        th, ca = chosen
        if winner is None:
            winner = {'run': 'test', 'model_sha256': sha(d / 'people.onnx'), 'helper': 'test',
                      'fine_sha256': sha(d / 'people-fine.onnx'), 'threshold': th, 'threshold_text': str(th),
                      'crowd_at': ca}
        choice = self.tmp / 'owl52_choice.json'
        choice.write_text(json.dumps({'winner': winner}), encoding='utf-8')
        fth, fca = frozen or chosen
        block = ['  Name:         owl-5.2',
                 f"  Model:        people.onnx       sha256 {sha(d / 'people.onnx')}",
                 f"  Crowd model:  people-fine.onnx  sha256 {sha(d / 'people-fine.onnx')}",
                 f"  Decoder:      flock-sensor/main.py at commit {FROZEN['owl-5.1'][0]} (owl-5.1's shipping commit)",
                 f'  Settings:     THERMAL_MODEL_THRESHOLD={fth}, CROWD_AT={fca}, from owl52_choice.json sha256 '
                 f'{sha(choice)} (not shipped defaults)']
        self.freeze.write_text(freeze_text(self.models, extra=block), encoding='utf-8')
        return dict(self.models, **{'owl-5.2': d}), choice

    def owls(self):
        """Every frozen model, each decoded by the main.py that shipped it."""
        mods = {name: ss.decoder(commit)[0] for name, (commit, _) in FROZEN.items()}
        return {name: ss.load_owl(self.models[name], mods[name]) for name in FROZEN}, mods

    def score(self, folder, steps):
        owls, mods = self.owls()
        return ss.score_session(folder, owls, steps, ON_FLUX, mods[ON_FLUX])

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
        items, clock = self.score(folder, steps)
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
        items, clock = self.score(folder, steps)
        self.assertTrue(clock['clock_uncertain'])
        self.assertGreater(steps['clock_uncertain_moving_dropped'], 0)
        self.assertTrue(items)
        self.assertTrue(all(it['scene'] not in ss.MOVING_SCENES for it in items))

    def test_owl_count_equals_the_sensors(self):
        folder = make_session(self.unsealed, 'owl')
        steps = dict.fromkeys(('beeps', 'late_counts_dropped', 'no_count_from_A', 'clock_uncertain_moving_dropped',
                               'no_frame', 'kept'), 0)
        items, _ = self.score(folder, steps)
        from frames import read_session
        _, frames = read_session(next(folder.glob('*.frames')))
        self.assertTrue(items)
        for name, (commit, (th, ca)) in FROZEN.items():
            main = ss.decoder(commit)[0]
            fresh = main.PeopleModel(self.models[name] / 'people.onnx', th)
            fresh.fine = main.PeopleModel(self.models[name] / 'people-fine.onnx', th)
            fresh.CROWD_AT = ca
            for it in items:
                c = frames[it['frame']][1]
                self.assertEqual(it[f'owl:{name}'], fresh.read_crowd(c)[2], name)
        flux = ss.decoder(FROZEN[ON_FLUX][0])[0]
        for it in items:
            c = frames[it['frame']][1]
            self.assertEqual(it['owl'], it[f'owl:{ON_FLUX}'])
            self.assertEqual(it['rule'], flux.count_thermal_clusters(c))

    def test_each_model_is_scored_at_the_settings_its_main_py_ships(self):
        for name, (commit, shipped) in FROZEN.items():
            main = ss.decoder(commit)[0]
            self.assertEqual(ss.shipped_settings(main), shipped, name)
            self.assertEqual(ss.load_owl(self.models[name], main).CROWD_AT, shipped[1], name)
        self.assertEqual(ss.shipped_settings(ss.sensor()), FROZEN[ON_FLUX][1])

    def test_settings_unlike_the_commits_stop_it(self):
        self.batch()
        self.freeze.write_text(freeze_text(self.models, settings={'owl-5': (0.35, 5)}), encoding='utf-8')
        self.assertEqual(self.run_scorer(), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_models_must_be_exactly_the_frozen_ones(self):
        self.batch()
        some = {k: v for k, v in self.models.items() if k != 'owl-5'}
        self.assertEqual(self.run_scorer(models=some), 2)
        self.assertEqual(self.run_scorer(models=dict(self.models, extra=self.models['owl-5'])), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_a_models_files_are_checked_against_its_own_block(self):
        self.batch()
        swapped = dict(self.models, **{'owl-5': self.models['owl-5.1'], 'owl-5.1': self.models['owl-5']})
        self.assertEqual(self.run_scorer(models=swapped), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_an_unshipped_model_is_scored_at_its_choice_files_setting(self):
        self.batch()
        models, _ = self.unshipped(chosen=(0.3, 3))
        self.assertEqual(self.run_scorer(models=models), 0)
        report = json.loads((self.out / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['on_flux'], ON_FLUX)
        self.assertEqual(report['models']['owl-5.2']['settings'], {'THERMAL_MODEL_THRESHOLD': 0.3, 'CROWD_AT': 3})
        self.assertIn('owl52_choice.json', report['models']['owl-5.2']['settings_from'])
        self.assertIn('shipped defaults', report['models']['owl-5.1']['settings_from'])
        self.assertEqual(report['bars'], report['models'][ON_FLUX]['bars'])
        main = ss.decoder(FROZEN['owl-5.1'][0])[0]
        fresh = main.PeopleModel(models['owl-5.2'] / 'people.onnx', 0.3)
        fresh.fine = main.PeopleModel(models['owl-5.2'] / 'people-fine.onnx', 0.3)
        fresh.CROWD_AT = 3
        from frames import read_session
        frames = {s: read_session(next((self.unsealed / s).glob('*.frames')))[1] for s in ('s1', 's2')}
        with open(self.out / 'items.csv', encoding='utf-8') as f:
            rows = list(csv.DictReader(f))
        self.assertTrue(rows)
        for r in rows:
            c = frames[r['session']][int(r['frame'])][1]
            self.assertEqual(int(r['owl:owl-5.2']), fresh.read_crowd(c)[2])

    def test_a_changed_choice_file_stops_it(self):
        self.batch()
        models, choice = self.unshipped()
        choice.write_text(choice.read_text(encoding='utf-8') + ' ', encoding='utf-8')
        self.assertEqual(self.run_scorer(models=models), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_settings_unlike_the_choice_stop_it(self):
        self.batch()
        models, _ = self.unshipped(chosen=(0.3, 3), frozen=(0.3, 4))
        self.assertEqual(self.run_scorer(models=models), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_model_files_unlike_the_choice_stop_it(self):
        self.batch()
        d = self.models['owl-4.9']
        winner = {'run': 'test', 'model_sha256': sha(d / 'people.onnx'), 'helper': 'test',
                  'fine_sha256': sha(self.models['owl-5.1'] / 'people-fine.onnx'), 'threshold': 0.3,
                  'threshold_text': '0.3', 'crowd_at': 3}
        models, _ = self.unshipped(winner=winner)
        self.assertEqual(self.run_scorer(models=models), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_a_choice_with_no_winner_stops_it(self):
        self.batch()
        models, choice = self.unshipped()
        choice.write_text(json.dumps({'winner': None}), encoding='utf-8')
        text = self.freeze.read_text(encoding='utf-8')
        old = next(line for line in text.splitlines() if 'owl52_choice.json sha256' in line)
        self.freeze.write_text(text.replace(old, old.rsplit('sha256', 1)[0] + f'sha256 {sha(choice)} (not shipped defaults)'),
                               encoding='utf-8')
        self.assertEqual(self.run_scorer(models=models), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

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
        self.assertEqual(report['on_flux'], ON_FLUX)
        self.assertEqual(list(report['models']), list(FROZEN))
        self.assertEqual(report['bars'], report['models'][ON_FLUX]['bars'])
        for name, (_, (th, ca)) in FROZEN.items():
            self.assertEqual(report['models'][name]['settings'], {'THERMAL_MODEL_THRESHOLD': th, 'CROWD_AT': ca})
        with open(self.out / 'items.csv', encoding='utf-8') as f:
            header = next(csv.reader(f))
        self.assertTrue(all(f'owl:{n}' in header for n in FROZEN), header)

    def test_late_beep_is_dropped_in_a_full_run(self):
        folder = make_session(self.unsealed, 'late', late_beep=120)
        steps = dict.fromkeys(('beeps', 'late_counts_dropped', 'no_count_from_A', 'clock_uncertain_moving_dropped',
                               'no_frame', 'kept'), 0)
        self.score(folder, steps)
        self.assertEqual(steps['late_counts_dropped'], 2)   # counters A and B were both late on that beep
        self.assertEqual(steps['no_count_from_A'], 1)


if __name__ == '__main__':
    unittest.main()
