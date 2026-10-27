"""Tests for synth's dining room (2026-10-27): the box over a restaurant's door, and the optional posture targets.

    python -m unittest flock-sensor/training/test_dining.py      (numpy and scipy; the Owl test also onnxruntime)
    python flock-sensor/training/test_dining.py measure 200        Owl's finding rate on 200 dining frames

The Owl test runs models/people.onnx through main.PeopleModel exactly as the box does and reports what it finds. That
is a measurement, not a gate: owl-4.9 never saw a frame from this angle.
"""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SENSOR = HERE.parent
sys.path.insert(0, str(HERE))
import synth  # noqa: E402
from test_contact_heat import GOLDEN as GOLDEN_FRAMES, scene_hash  # noqa: E402

# synth.targets(objects) on synth.scene_full(np.random.default_rng(seed)) for seeds 0 to 5, at stride 4 and at
# stride 2 with person_sigma_px=5, recorded from synth.py at e663cb31, before the posture flag existed. With the flag
# off (the default) targets must still return exactly these arrays.
GOLDEN_TARGETS = {
    (0, 4): "6b51a9369794e6658f8a042b8f8fe1e480ad40b55b34fbea6af49a89fa59491a",
    (0, 2): "f49f08fe36241e3c298cdc60b69eb3cf5cd4fe23ef6c048b87353f3de79c1194",
    (1, 4): "f0c8ed7a2b070dbf287d5c406a72b82a284de8df49bfec1ff3a5b7d429f73310",
    (1, 2): "7514f3c5155ecd28e3ce25b0b9beb9d4ddca254b8c704e40e1d941f5dd5c8152",
    (2, 4): "6cf474062eb32548e14ddfbc4dcca529bf1a6eff8e8b1fb5875a28ef55280e69",
    (2, 2): "a6cf7fc148e778d39fe0dd8b7d226adbcfe359dc6f75a964cc0f21ce89ef9c76",
    (3, 4): "fe0a0135404579ca9c6708eaec5e8f4e792da8a09426793da97500f9e92a3464",
    (3, 2): "214b232976d7f59fa766d622834eed4fa322596f093eb27faab89718e92b4ea0",
    (4, 4): "56d65beac1fca231425a9cd5e5e2bd02f60bed74786ad76fbd6a7216d0d127a9",
    (4, 2): "e6f2276e9148931f116bde6f158336e61ca109b1a42cd5f8e83848ceb3606863",
    (5, 4): "9d8c2e1a444af68d411e396fb2a8296505492ecc423ee32bff987a2265b3ec52",
    (5, 2): "e09bd9ca9678afc59719941b595f22c64e1462508c70af7a652ab4f9275b866d",
}
DINING_SEEDS = range(300, 340)


def targets_hash(arrays):
    return hashlib.sha256(b''.join(np.asarray(a).tobytes() for a in arrays)).hexdigest()


def dining(seed, **kw):
    detail = {}
    t, objects = synth.scene_dining(np.random.default_rng(seed), detail=detail, **kw)
    return t, objects, detail


class PostureFlagOff(unittest.TestCase):
    def test_targets_are_byte_for_byte_what_they_were(self):
        for (seed, stride), h in GOLDEN_TARGETS.items():
            _, objects = synth.scene_full(np.random.default_rng(seed))
            soft = 5.0 if stride == 2 else None
            out = synth.targets(objects, stride=stride, person_sigma_px=soft)
            self.assertEqual(len(out), 3)
            self.assertEqual(targets_hash(out), h, f'seed {seed} stride {stride}')
            self.assertEqual(targets_hash(synth.targets(objects, stride=stride, person_sigma_px=soft,
                                                        posture=False)), h)

    def test_scene_full_still_draws_owl49s_frames(self):
        for seed, h in GOLDEN_FRAMES.items():
            self.assertEqual(scene_hash(seed), h)
            self.assertEqual(scene_hash(seed, dining=False), h)

    def test_off_a_posture_label_changes_nothing(self):
        for seed in DINING_SEEDS[:10]:
            _, objects, _ = dining(seed)
            bare = [{k: v for k, v in o.items() if k not in ('pose', 'posture')} for o in objects]
            self.assertEqual(targets_hash(synth.targets(objects)), targets_hash(synth.targets(bare)))


class DiningScene(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frames = [dining(seed) for seed in DINING_SEEDS]

    def people(self):
        for t, objects, detail in self.frames:
            yield t, [o for o in objects if o['cls'] == 'person'], detail

    def test_reproducible_and_reachable_from_scene_full(self):
        t1, o1, _ = dining(7)
        t2, o2 = synth.scene_full(np.random.default_rng(7), dining=True)
        self.assertTrue(np.array_equal(t1, t2))
        self.assertEqual(json.dumps(o1, sort_keys=True), json.dumps(o2, sort_keys=True))

    def test_frames_are_camera_frames(self):
        for t, objects, _ in self.frames:
            self.assertEqual(t.shape, (synth.ROWS, synth.COLS))
            self.assertEqual(t.dtype, np.float32)
            self.assertTrue(np.isfinite(t).all())
            self.assertTrue(all(o['cls'] in synth.CLASSES for o in objects))

    def test_rooms_have_diners_servers_and_empty_tables(self):
        sit = stand = empty = left = 0
        for _, persons, detail in self.people():
            sit += sum(o['posture'] == 'sit' for o in persons)
            stand += sum(o['posture'] == 'stand' for o in persons)
            empty += sum(tb['state'] == 'empty' for tb in detail['tables'])
            left += sum(tb['state'] == 'left' for tb in detail['tables'])
        self.assertGreater(sit, 3 * len(self.frames))
        self.assertGreater(stand, len(self.frames) // 2)
        self.assertGreater(sit, stand)
        self.assertGreater(empty, 0)
        self.assertGreater(left, 0)
        named = {o['cls'] for _, objects, _ in self.frames for o in objects}
        self.assertTrue({'person', 'food', 'hot drink', 'warm seat'} <= named)

    def test_tables_run_from_one_and_a_half_to_thirteen_metres(self):
        for _, _, detail in self.frames:
            zs = [tb['z'] for tb in detail['tables']]
            self.assertGreaterEqual(min(zs), 1.5 - 0.5)
            self.assertLessEqual(max(zs), 13.0 + 0.5)
            m = detail['mount']
            self.assertTrue(2.7 <= m.cam_h <= 3.3)
            self.assertTrue(np.radians(25) <= m.pitch <= np.radians(35))

    def test_every_point_is_inside_the_frame(self):
        for _, objects, _ in self.frames:
            for o in objects:
                self.assertTrue(0 <= o['x'] < synth.COLS and 0 <= o['y'] < synth.ROWS, o)
                x0, y0, x1, y1 = o['box']
                self.assertTrue(0 <= x0 < x1 <= synth.COLS and 0 <= y0 < y1 <= synth.ROWS, o)

    def test_people_are_warmer_than_the_room(self):
        # main.py's own check: the warmest pixel near a person is at least 1 C over the frame's 10th percentile.
        warm = total = 0
        for t, persons, _ in self.people():
            room = float(np.percentile(t, 10))
            for o in persons:
                x, y = int(o['x']), int(o['y'])
                patch = t[max(0, y - 2):y + 3, max(0, x - 2):x + 3]
                total += 1
                warm += float(patch.max()) >= room + 1.0
        self.assertGreater(total, 100)
        self.assertGreater(warm / total, 0.95)

    def test_every_person_has_a_posture_that_matches_the_pose(self):
        for _, persons, detail in self.people():
            for o in persons:
                self.assertIn(o['pose'], synth.POSTURE_OF)
                self.assertEqual(o['posture'], synth.POSTURE_OF[o['pose']])
                self.assertIn(o['posture'], synth.POSTURES)
            for _, _, _, h, pose in detail['people']:
                lo, hi = synth.SEATED_HEAD_M if pose == 'sit' else synth.STANDING_HEAD_M
                self.assertTrue(lo <= h <= hi, (pose, h))

    def test_each_label_sits_where_its_person_was_drawn(self):
        # Every head label lands near the projection of a drawn head of the same posture (a crooked mount turns
        # the frame up to a few degrees, so nearby, not exact).
        agree = total = 0
        for _, persons, detail in self.people():
            m = detail['mount']
            drawn = [(m.project(x, h, z)[:2], synth.POSTURE_OF[pose]) for _, x, z, h, pose in detail['people']]
            for o in persons:
                (u, v), posture = min(drawn, key=lambda d: (d[0][0] - o['x']) ** 2 + (d[0][1] - o['y']) ** 2)
                if (u - o['x']) ** 2 + (v - o['y']) ** 2 > 36:
                    continue            # labelled at the body: the head was hidden or out of view
                total += 1
                agree += posture == o['posture']
        self.assertGreater(total, 100)
        self.assertGreater(agree / total, 0.95)

    def test_seated_diners_are_shorter_in_the_frame_than_people_standing_as_far_away(self):
        ratio = {'sit': [], 'stand': []}
        for _, persons, detail in self.people():
            m = detail['mount']
            for o in persons:
                x0, y0, x1, y1 = o['box']
                if y0 <= 0 or y1 >= synth.ROWS:
                    continue
                # The box's height over the pixels a metre spans at that depth, from the label's own row.
                cands = [(abs(m.project(x, h, z)[0] - o['x']) + abs(m.project(x, h, z)[1] - o['y']), z, x, h)
                         for _, x, z, h, _ in detail['people']]
                err, z, x, h = min(cands)
                if err > 3:
                    continue
                ratio[o['posture']].append((y1 - y0) / (synth.F_PX / m.project(x, h, z)[2]))
        self.assertGreater(len(ratio['sit']), 50)
        self.assertGreater(len(ratio['stand']), 10)
        self.assertLess(np.median(ratio['sit']), np.median(ratio['stand']))


class PostureTargets(unittest.TestCase):
    def test_on_each_person_peaks_on_their_posture_map(self):
        for seed in DINING_SEEDS[:15]:
            _, objects, _ = dining(seed)
            heat, ltrb, mask, post, known = synth.targets(objects, posture=True)
            self.assertEqual(post.shape, (len(synth.POSTURES), synth.ROWS // 4, synth.COLS // 4))
            self.assertEqual(post.dtype, np.float32)
            self.assertEqual(float(known), 1.0)
            # The same arrays as with the flag off, plus the new ones.
            for a, b in zip((heat, ltrb, mask), synth.targets(objects)):
                self.assertTrue(np.array_equal(a, b))
            # Each posture map is the people map restricted to that posture's people.
            for i, name in enumerate(synth.POSTURES):
                only = [o for o in objects if o['cls'] == 'person' and o['posture'] == name]
                self.assertTrue(np.array_equal(post[i], synth.targets(only)[0][0]))
            self.assertTrue((np.maximum(post[0], post[1]) <= heat[0] + 1e-7).all())

    def test_a_person_without_a_posture_marks_the_frame_unlabelled(self):
        seen = 0
        for seed in range(6):
            _, objects = synth.scene_full(np.random.default_rng(seed))
            heat, _, _, post, known = synth.targets(objects, posture=True)
            if any(o['cls'] == 'person' for o in objects):
                seen += 1
                self.assertEqual(float(known), 0.0)
            self.assertFalse(post.any())
        self.assertGreater(seen, 0)
        _, _, _, post, known = synth.targets([], posture=True)
        self.assertEqual(float(known), 1.0)          # nobody there: nothing is unlabelled
        self.assertFalse(post.any())

    def test_the_fine_grid_works_too(self):
        _, objects, _ = dining(301)
        heat, _, _, post, _ = synth.targets(objects, stride=2, posture=True)
        self.assertEqual(post.shape, (2, synth.ROWS // 2, synth.COLS // 2))
        self.assertEqual(heat.shape[1:], post.shape[1:])


# ---------------------------------------------------------------------------
# Owl on dining frames, end to end, as the box runs it
# ---------------------------------------------------------------------------

def load_owl():
    tmp = tempfile.mkdtemp(prefix='flux-dining-test-')
    for k, v in (('FLOCK_CONFIG', 'c.env'), ('FLOCK_LOG', 's.log'), ('FLOCK_BUFFER', 'b.json'),
                 ('FLOCK_TABLES', 't.json')):
        os.environ.setdefault(k, str(Path(tmp) / v))
    sys.path.insert(0, str(SENSOR))
    import main
    model = main.PeopleModel(main.PEOPLE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
    if main.PEOPLE_FINE_MODEL_PATH.exists():
        model.fine = main.PeopleModel(main.PEOPLE_FINE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
    return main, model


def match(found, persons, reach=5.0):
    """Greedy nearest matching of Owl's points to labelled people within `reach` pixels. Returns the matched
    labels' indices and the number of Owl's points left over."""
    pairs = sorted(((fx - o['x']) ** 2 + (fy - o['y']) ** 2, i, j)
                   for i, (fx, fy) in enumerate(found) for j, o in enumerate(persons))
    used_f, used_p = set(), set()
    for d2, i, j in pairs:
        if d2 > reach * reach:
            break
        if i in used_f or j in used_p:
            continue
        used_f.add(i)
        used_p.add(j)
    return used_p, len(found) - len(used_f)


def measure(model, seeds):
    """Owl on dining frames: per posture, labelled and found, Owl's extra points, and exact counts."""
    tally = {'frames': 0, 'sit': 0, 'sit_found': 0, 'stand': 0, 'stand_found': 0, 'owl_points': 0,
             'unmatched_points': 0, 'exact_count': 0, 'labelled_people': 0, 'owl_count': 0}
    for seed in seeds:
        t, objects, _ = dining(seed)
        persons = [o for o in objects if o['cls'] == 'person']
        found, _, count = model.read_crowd(t.reshape(-1).tolist())
        hit, extra = match(found, persons)
        tally['frames'] += 1
        tally['owl_points'] += len(found)
        tally['owl_count'] += count
        tally['labelled_people'] += len(persons)
        tally['unmatched_points'] += extra
        tally['exact_count'] += count == len(persons)
        for j, o in enumerate(persons):
            tally[o['posture']] += 1
            tally[o['posture'] + '_found'] += j in hit
    return tally


def report(tally):
    return (f"{tally['frames']} dining frames: Owl found {tally['sit_found']} of {tally['sit']} seated people "
            f"({100.0 * tally['sit_found'] / max(1, tally['sit']):.1f}%) and {tally['stand_found']} of "
            f"{tally['stand']} standing ({100.0 * tally['stand_found'] / max(1, tally['stand']):.1f}%); "
            f"{tally['unmatched_points']} of its {tally['owl_points']} points matched nobody; count exact on "
            f"{tally['exact_count']} frames; counted {tally['owl_count']} against {tally['labelled_people']} labelled")


class OwlOnDiningFrames(unittest.TestCase):
    def test_owl_reads_dining_frames_end_to_end(self):
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            self.skipTest('onnxruntime is not installed (use the flux-training venv)')
        main, model = load_owl()
        self.assertTrue(main.PEOPLE_MODEL_PATH.exists())
        tally = measure(model, range(900, 908))
        self.assertEqual(tally['frames'], 8)
        self.assertGreater(tally['sit'], 0)
        # A measurement, not a gate: printed for the record, whatever it is.
        print('\n' + report(tally))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'measure':
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 200
        _, owl = load_owl()
        t = measure(owl, range(10_000, 10_000 + n))
        print(report(t))
        print(json.dumps(t))
    else:
        unittest.main()
