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
# heat existed. With contact heat off the generator must still draw exactly these frames: owl-4.9's.
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
OID = 12345


def scene_hash(seed, **kw):
    t, objects = synth.scene_full(np.random.default_rng(seed), **kw)
    return hashlib.sha256(t.tobytes() + json.dumps(objects, sort_keys=True).encode()).hexdigest()


def imprint(age, parts=('seat',), seed=3, amb=AMB):
    """One mark on a flat wall at amb, 2 m away, in the middle of the canvas."""
    c = synth.Canvas(np.full((synth.H, synth.W), amb, np.float32))
    s = synth.F_PX * synth.SS / 2.0
    synth.contact_heat(c, np.random.default_rng(seed), amb, synth.W / 2, synth.H / 2, s, OID, parts=parts, age=age)
    return c


def half_peak_area(c, amb=AMB):
    rise = c.t - amb
    return int((rise >= 0.5 * float(rise.max())).sum())


class ContactHeat(unittest.TestCase):
    def setUp(self):
        synth.CONTACT_HEAT = False

    def tearDown(self):
        synth.CONTACT_HEAT = False

    def test_off_by_default_and_the_owl49_generator_unchanged(self):
        self.assertFalse(synth.CONTACT_HEAT)
        for seed, h in GOLDEN.items():
            self.assertEqual(scene_hash(seed), h, f"seed {seed} drew a different frame with contact heat off")
        for seed in (0, 7):
            self.assertEqual(scene_hash(seed, contact=False), GOLDEN[seed])

    def test_a_fresh_mark_is_several_degrees_warm_never_past_skin(self):
        c = imprint(5.0)
        self.assertGreater(float(c.t.max()) - AMB, 4.0)
        self.assertLessEqual(float(c.t.max()), 36.5)            # synth's ceiling for skin
        self.assertGreaterEqual(float(c.t.min()), AMB - 1e-4)   # heat is added, nothing cooled

    def test_in_a_warm_room_it_is_still_warm_and_still_under_skin(self):
        c = imprint(5.0, amb=30.0)
        self.assertGreater(float(c.t.max()), 31.0)
        self.assertLessEqual(float(c.t.max()), 36.5)

    def test_warmest_where_the_contact_was(self):
        c = imprint(20.0, parts=('cushion',))
        cy, cx = synth.H // 2, synth.W // 2
        centre = float(c.t[cy - 2:cy + 3, cx - 2:cx + 3].mean())
        ys, xs = np.nonzero(c.t > AMB + 0.5)
        r = np.hypot(ys - cy, xs - cx)
        rim = c.t[ys[r > 0.8 * r.max()], xs[r > 0.8 * r.max()]]
        self.assertGreater(centre, float(rim.mean()) + 0.5)

    def test_it_cools_and_its_rim_fades_first(self):
        fresh, old = imprint(5.0), imprint(150.0)
        self.assertGreater(float(fresh.t.max()), float(old.t.max()) + 1.0)
        # The share of the mark within half its own peak shrinks: the lightly pressed rim cools faster.
        self.assertLess(half_peak_area(old), 0.8 * half_peak_area(fresh))

    def test_a_seat_is_named_and_an_edge_or_faded_mark_is_not(self):
        self.assertTrue((imprint(10.0, parts=('seat', 'back')).owner == OID).any())
        self.assertFalse((imprint(10.0, parts=('edge',)).owner == OID).any())
        self.assertFalse((imprint(3000.0, parts=('seat',)).owner == OID).any())

    def test_on_it_draws_warm_seats_and_never_counts_one(self):
        frames, named = 240, 0
        for seed in range(frames):
            t, objects = synth.scene_full(np.random.default_rng(10_000 + seed), contact=True)
            self.assertTrue(all(o['cls'] in synth.CLASSES for o in objects))
            named += any(o['cls'] == 'warm seat' for o in objects)
        self.assertGreater(named / frames, 0.08)

    def test_on_is_reproducible_and_the_module_default_does_the_same(self):
        on = scene_hash(5, contact=True)
        self.assertEqual(scene_hash(5, contact=True), on)
        self.assertTrue(any(scene_hash(seed, contact=True) != h for seed, h in GOLDEN.items()))
        synth.CONTACT_HEAT = True
        self.assertEqual(scene_hash(5), on)

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
