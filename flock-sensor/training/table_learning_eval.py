"""Does the box learn the right tables from Owl's real output?

Generates whole evenings in a dining room as the box sees it from the ceiling
above the door (Lepton 3.5, 57 degrees, aimed 30 degrees down): eight tables
in three rows, parties that arrive, stay and leave, and staff walking between
the tables. Every frame is drawn with synth.py (no real person), counted by
Owl exactly as main.py runs it, and fed to main.TableLearner and
main.TableTracker. Then the learned tables are compared with the real ones,
and each table's count with the number really sitting there.

Run with the flux-training venv, from flock-sensor:
  python training/table_learning_eval.py . [evenings] [minutes] [seconds per frame]
"""
import json
import math
import os
import random
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates

SENSOR = Path(sys.argv[1])
EVENINGS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
MINUTES = int(sys.argv[3]) if len(sys.argv) > 3 else 240
EVERY = float(sys.argv[4]) if len(sys.argv) > 4 else 10.0
sys.path.insert(0, str(SENSOR / 'training'))
import synth  # noqa: E402

tmp = tempfile.mkdtemp(prefix='flux-tables-eval-')
for k, v in (('FLOCK_CONFIG', 'c.env'), ('FLOCK_LOG', 's.log'), ('FLOCK_BUFFER', 'b.json'),
             ('FLOCK_TABLES', 't.json')):
    os.environ[k] = str(Path(tmp) / v)
sys.path.insert(0, str(SENSOR))
import main  # noqa: E402

COLS, ROWS, SS = synth.COLS, synth.ROWS, synth.SS
H, W = ROWS * SS, COLS * SS
F = synth.F_PX
CAM_H, PITCH = 3.0, math.radians(30.0)
CHAIR = 0.6
SIDE = {'far': (0, CHAIR), 'near': (0, -CHAIR), 'left': (-CHAIR, 0), 'right': (CHAIR, 0)}
FOUR = ('far', 'near', 'left', 'right')
TABLES = {1: (-1.1, 3.1), 2: (1.15, 3.1), 3: (-2.0, 5.3), 4: (0.0, 5.4), 5: (2.0, 5.3),
          6: (-2.8, 7.7), 7: (0.0, 7.9), 8: (2.8, 7.7)}


def project(x, h, z):
    dy = h - CAM_H
    yc = dy * math.cos(PITCH) + z * math.sin(PITCH)
    zc = -dy * math.sin(PITCH) + z * math.cos(PITCH)
    return COLS / 2 + F * x / zc, ROWS / 2 - F * yc / zc, zc


def seat_xz(n, side):
    tx, tz = TABLES[n]
    dx, dz = SIDE[side]
    return tx + dx * 0.85, tz + dz * 0.85


def evening(seed):
    """Parties per table: (table, sides, first second, last second)."""
    rng = random.Random(seed)
    parties = []
    for n in TABLES:
        t = rng.uniform(0, 40) * 60
        while t < MINUTES * 60:
            stay = rng.uniform(35, 90) * 60
            size = rng.choice([1, 2, 2, 2, 3, 4, 4])
            sides = tuple(rng.sample(FOUR, size))
            parties.append((n, sides, t, min(MINUTES * 60, t + stay)))
            t += stay + rng.uniform(4, 25) * 60
    return parties


class Room:
    """The room's fixed heat and each person's own look, so a diner looks the
    same from one frame to the next."""

    def __init__(self, seed):
        rng = np.random.default_rng(seed)
        self.amb = 22.5
        t = np.full((H, W), self.amb - 0.3, dtype=np.float32)
        low = gaussian_filter(rng.normal(0, 1, (H // 8, W // 8)).astype(np.float32), 2)
        t += np.kron(low, np.ones((8, 8), dtype=np.float32)) * 0.3
        self.base = t
        self.furniture = synth.Canvas(t.copy())
        for n, (tx, tz) in TABLES.items():
            for side in FOUR:
                dx, dz = SIDE[side]
                self._flat(self.furniture, tx + dx, tz + dz, 0.45, 0.42, 0.42, self.amb - 0.5)
            self._flat(self.furniture, tx, tz, 0.75, 0.8, 0.8, self.amb - 0.8)
        self.cache = {}

    def _flat(self, c, x, z, h, w, d, temp):
        pts = [tuple(v * SS for v in project(x + dx, h, z + dz)[:2])
               for dx, dz in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        x0, y0 = int(max(0, min(xs))), int(max(0, min(ys)))
        x1, y1 = int(min(W, max(xs) + 1)), int(min(H, max(ys) + 1))
        if x1 <= x0 or y1 <= y0:
            return
        gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        inside = np.zeros(gx.shape, dtype=bool)
        for i in range(4):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % 4]
            inside ^= ((ay > gy) != (by > gy)) & (gx < (bx - ax) * (gy - ay) / ((by - ay) or 1e-9) + ax)
        c.paint((x0, y0, gaussian_filter(inside.astype(np.float32), 0.6)), temp)

    def person(self, key, x, z, facing, standing=False):
        """A person's heat, drawn once per look and pose and moved into place."""
        h = 1.65 if standing else 1.2
        u, v, zc = project(x, h, z)
        hx, hy = u * SS, v * SS
        down = math.atan2(CAM_H - h, math.hypot(x, z))
        toward = math.cos(facing - math.pi / 2)
        view = 'front' if toward < -0.5 else 'back' if toward > 0.5 else 'side'
        scratch = synth.Canvas(np.full((H, W), self.amb, dtype=np.float32))
        rng = np.random.default_rng(key)
        synth.person(scratch, rng, self.amb, zc, hx, hy, 1, view=view,
                     pose='stand' if standing else 'sit', child=False, shirtless=False, coat=False)
        k = math.cos(down)
        rows, cols = np.mgrid[0:H, 0:W].astype(np.float32)
        body = map_coordinates(scratch.t, [hy + (rows - hy) / k, cols], order=1, mode='constant', cval=self.amb)
        mask = np.clip(np.abs(body - self.amb) / 0.3, 0, 1)
        return body, mask

    def frame(self, people, rng):
        t = self.furniture.t.copy()
        for body, mask in people:
            t = t * (1 - mask) + body * mask
        f = t.reshape(ROWS, SS, COLS, SS).mean(axis=(1, 3))
        f = gaussian_filter(f, 0.8)
        f += rng.normal(0, 0.05, (ROWS, COLS))
        n = gaussian_filter(rng.normal(0, 1, (ROWS, COLS)).astype(np.float32), 2.5)
        f += n / max(float(n.std()), 1e-6) * 0.15
        return np.round(f * 100) / 100


def truth_zones():
    zones = []
    for n in TABLES:
        seats = [project(*seat_xz(n, s)[:1], 1.2, seat_xz(n, s)[1])[:2] for s in FOUR]
        zones.append({'n': n, 'seats': seats})
    return zones


def run(seed, model):
    rng = np.random.default_rng(seed)
    prng = random.Random(seed + 1)
    room = Room(seed)
    parties = evening(seed)
    learner = main.TableLearner()
    zones = []
    for z in truth_zones():
        xs = [p[0] for p in z['seats']]
        ys = [p[1] for p in z['seats']]
        zones.append({'n': z['n'], 'seats': z['seats'],
                      'box': (min(xs) - 5, min(ys) - 5, max(xs) + 5, max(ys) + 5)})
    tracker = main.TableTracker(zones)
    looks = {}
    exact = total = 0
    started = time.time()
    t = 0.0
    frames = 0
    while t < MINUTES * 60:
        people, truth_at = [], {n: 0 for n in TABLES}
        for i, (n, sides, a, b) in enumerate(parties):
            if a <= t < b:
                for side in sides:
                    x, z = seat_xz(n, side)
                    key = (seed * 1000 + i) * 10 + FOUR.index(side)
                    if key not in looks:
                        dx, dz = SIDE[side]
                        looks[key] = room.person(key, x, z, math.atan2(-dz, -dx))
                    people.append(looks[key])
                    truth_at[n] += 1
        # Two staff walk loops between the rows, and stop at a table now and then.
        for s in range(2):
            phase = (t / 240.0 + s * 0.5) % 1.0
            x = -3.0 + 6.0 * abs(2 * phase - 1)
            z = 4.2 if s == 0 else 6.6
            key = 900000 + s * 1000 + int(t // 20)
            people.append(room.person(key, x, z, -math.pi / 2, standing=True))
        frame = room.frame(people, rng)
        points, _, _ = model.read_crowd(frame.reshape(-1).tolist())
        learner.observe(t, points)
        tracker.update(t, points)
        if t >= 60:
            for n, p, state, age in tracker.view(t):
                total += 1
                exact += p == truth_at[n]
        t += EVERY
        frames += 1
    learner.observe(MINUTES * 60 + 61, [])
    return learner, parties, frames, time.time() - started, exact, total


def score(learner, parties):
    truth = {z['n']: z['seats'] for z in truth_zones()}
    used = {n: set() for n in TABLES}
    for n, sides, a, b in parties:
        if b - a >= 15 * 60:
            used[n].update(FOUR.index(s) for s in sides)
    learned = learner.tables()

    def owner(p):
        best = min(((math.hypot(p[0] - s[0], p[1] - s[1]), n) for n, seats in truth.items() for s in seats))
        return best[1] if best[0] <= 6.0 else None

    found, merged, split, stray = 0, 0, 0, 0
    claimed = {}
    for t in learned:
        owners = {owner(p) for p in t['seats']}
        real = owners - {None}
        if not real:
            stray += 1
            continue
        if len(real) > 1:
            merged += 1
        for n in real:
            claimed.setdefault(n, []).append(t)
    for n in TABLES:
        if n in claimed:
            found += 1
            if len(claimed[n]) > 1:
                split += 1
    seat_hits = seat_total = 0
    for n, idx in used.items():
        for i in idx:
            seat_total += 1
            sx, sy = truth[n][i]
            if any(math.hypot(sx - x, sy - y) <= 6.0 for t in learned for x, y in t['seats']):
                seat_hits += 1
    return {'tables_real': len(TABLES), 'tables_used': sum(1 for n in used if used[n]),
            'tables_learned': len(learned), 'tables_found': found,
            'merged': merged, 'split': split, 'stray': stray,
            'seats_used': seat_total, 'seats_found': seat_hits}


if __name__ == '__main__':
    model = main.PeopleModel(main.PEOPLE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
    if main.PEOPLE_FINE_MODEL_PATH.exists():
        model.fine = main.PeopleModel(main.PEOPLE_FINE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
    results = []
    for seed in range(1, EVENINGS + 1):
        learner, parties, frames, secs, exact, total = run(seed, model)
        r = score(learner, parties)
        r.update(seed=seed, parties=len(parties), frames=frames, seconds=round(secs),
                 table_frames=total, table_frames_exact=exact)
        results.append(r)
        print(json.dumps(r), flush=True)
    print('TOTAL', json.dumps({k: sum(r[k] for r in results) for k in results[0] if k != 'seed'}))
