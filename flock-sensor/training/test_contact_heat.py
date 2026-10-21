"""Tests for synth's contact heat (2026-10-21): seats, cushions and table edges left warm by a body.

    python -m unittest flock-sensor/training/test_contact_heat.py   (needs numpy and scipy)
"""
import hashlib
import json
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stress  # noqa: E402
import synth  # noqa: E402

# synth.scene_full(np.random.default_rng(seed)) for seeds 0 to 11, recorded from synth.py at b4a5083c, before contact
# heat existed. With CONTACT_HEAT off the generator must still draw exactly these frames: owl-4.9's.
GOLDEN = {
    0: "932fc47753d19789b6969dab92943598f2c270c05555c8386213013e39471eb6",
    1: "2f0e2aa0ab82129507b78b6edd23d9a214f86288dbb0a8ef20651756d1637524",
    2: "8acd1410859b9968814d622c9c61ca9a99060149257377317a7f60d743c7884d",
    3: "868e384ec00839c85afc8439d5ad20baad060c40f219ee51410dd8d569bf1f80",
    4: "8d705659d5985a8eefa4a676139521e91d80ce9920440f81534682e89e8c8270",
    5: "c0cd6cd425c21e9c4823c825e72593a5c1db4b75d463326da7e019297b0504f4",
    6: "a1bcc67ada321ca92432305418e1643709ac33c9dc58da18962e4907cfba4a05",
    7: "42a44859fecb916cbf557442fdf23c1120223d8cca4bd702649c7c55d55d9002",
    8: "79079592392096802069333316d35f05c948bb6ea7c69662831cc397003265d4",
    9: "2a897bd0ec651650fac9e5275c302f7d365c87960341e06dd5539e71267f2473",
    10: "fe649d02247fc72cac208d4bef3cf1d12645f9e8e36f6391ddd0365b40ddd28e",
    11: "0800ed160289392fa142c24f71139d8e5d4714234ba04e34971f839bbc962062",
}
AMB = 22.0


def scene_hash(seed):
    t, objects = synth.scene_full(np.random.default_rng(seed))
    return hashlib.sha256(t.tobytes() + json.dumps(objects, sort_keys=True).encode()).hexdigest()


def imprint(age, parts=('seat',), seed=3, oid=12345):
    c = synth.Canvas(np.full((synth.H, synth.W), AMB, np.float32))
    s = synth.F_PX * synth.SS / 2.0
    synth.contact_heat(c, np.random.default_rng(seed), AMB, synth.W / 2, synth.H / 2, s, oid, parts=parts, age=age)
    return c


class ContactHeat(unittest.TestCase):
    def setUp(self):
        synth.CONTACT_HEAT = False

    def tearDown(self):
        synth.CONTACT_HEAT = False

    def test_off_by_default_and_the_owl49_generator_unchanged(self):
        self.assertFalse(synth.CONTACT_HEAT)
        for seed, h in GOLDEN.items():
            self.assertEqual(scene_hash(seed), h, f"seed {seed} drew a different frame with contact heat off")

    def test_a_fresh_mark_is_several_degrees_warm_never_past_skin(self):
        c = imprint(5.0)
        self.assertGreater(float(c.t.max()) - AMB, 4.0)
        self.assertLessEqual(float(c.t.max()), 34.5)
        self.assertGreaterEqual(float(c.t.min()), AMB - 0.3 - 0.5)  # the room, less the mark's sensor-like grain

    def test_warmest_where_the_contact_was(self):
        c = imprint(20.0, parts=('cushion',))
        cy, cx = synth.H // 2, synth.W // 2
        centre = float(c.t[cy - 2:cy + 3, cx - 2:cx + 3].mean())
        warm = c.t > AMB + 0.5
        ys, xs = np.nonzero(warm)
        rim = [float(c.t[y, x]) for y, x in zip(ys, xs)
               if np.hypot(y - cy, x - cx) > 0.8 * max(np.hypot(ys - cy, xs - cx).max(), 1)]
        self.assertGreater(centre, float(np.mean(rim)) + 0.5)

    def test_it_cools_and_spreads_with_age(self):
        fresh, old = imprint(5.0), imprint(300.0)
        self.assertGreater(float(fresh.t.max()), float(old.t.max()) + 1.0)
        self.assertGreaterEqual(int((old.t > AMB + 0.2).sum()), int((fresh.t > fresh.t.max() - 0.5).sum()))

    def test_a_seat_is_named_and_an_edge_mark_is_not(self):
        self.assertTrue((imprint(10.0, parts=('seat', 'back')).owner == 12345).any())
        self.assertFalse((imprint(10.0, parts=('edge',)).owner == 12345).any())

    def test_on_it_draws_warm_seats_and_never_counts_one(self):
        synth.CONTACT_HEAT = True
        frames, named = 240, 0
        for seed in range(frames):
            t, objects = synth.scene_full(np.random.default_rng(10_000 + seed))
            self.assertTrue(all(o['cls'] in synth.CLASSES for o in objects))
            named += any(o['cls'] == 'warm seat' for o in objects)
        self.assertGreater(named / frames, 0.08)

    def test_on_is_still_reproducible_and_differs_from_off(self):
        synth.CONTACT_HEAT = True
        self.assertEqual(scene_hash(5), scene_hash(5))
        self.assertTrue(any(scene_hash(seed) != h for seed, h in GOLDEN.items()))

    def test_stress_cases_sit_apart_from_the_recorded_ones(self):
        self.assertEqual(len(stress.CASES), 41)
        self.assertEqual([truth for _, truth, _ in stress.CONTACT_CASES], [0, 1])
        names = {name for name, _, _ in stress.CASES}
        for name, _, build in stress.CONTACT_CASES:
            self.assertNotIn(name, names)
            c = build(np.random.default_rng(1))
            self.assertIsInstance(c, synth.Canvas)
            self.assertGreater(float(c.t.max()), float(np.median(c.t)) + 2.0)


if __name__ == '__main__':
    unittest.main()
