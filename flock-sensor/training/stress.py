"""Stress test: every hard situation, built on purpose, scored on its own.

    python stress.py path/to/people.onnx [frames_per_case]

The held-out score says how a model does on average; this says where it
breaks. Each case builds one kind of hard scene many times over and reports
how often the model gets the people count exactly right, next to the old
heat-cluster rule. A case well under the rest is a hole to fix, in the
training frames first.

Counts go through main.py's own PeopleModel, so the numbers are what a unit
would do. Needs numpy, scipy and onnxruntime on the development machine.
"""

import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import synth  # noqa: E402

W, H = synth.W, synth.H


def finish(c, rng):
    """The camera's optics and electronics, as synth.scene_full applies them."""
    t = c.t.reshape(synth.ROWS, synth.SS, synth.COLS, synth.SS).mean(axis=(1, 3))
    t = gaussian_filter(t, rng.uniform(0.5, 1.0))
    for sigma, most in ((0.8, 0.3), (2.5, 0.4), (8.0, 0.5)):
        n = gaussian_filter(rng.normal(0, 1, t.shape).astype(np.float32), sigma)
        t += n / max(float(n.std()), 1e-6) * rng.uniform(0, most)
    t += rng.normal(0, 0.05, t.shape) + rng.normal(0, 1.5)
    return t.astype(np.float32)


def room(rng, hot=None):
    c, amb, horizon = synth.room(rng)
    if hot is not None:
        c.t += hot - amb
        amb = hot
    return c, amb, horizon


def person_at(c, rng, amb, d, xf, yf, pid=0, **kw):
    return synth.person(c, rng, amb, d, xf * W, yf * H, pid, **kw)


# Each case: (name, true people count, builder(rng) -> canvas)
def case_empty(rng):
    return room(rng)[0]


def case_one_standing(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(1.5, 4), rng.uniform(.3, .7), rng.uniform(.25, .4), pose='stand')
    return c


def case_far(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(6, 8), rng.uniform(.2, .8), rng.uniform(.3, .4), pose='stand')
    return c


def case_child(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(1.5, 4), rng.uniform(.3, .7), rng.uniform(.35, .5), child=True)
    return c


def case_coat(rng):
    c, amb, _ = room(rng, hot=rng.uniform(12, 18))
    person_at(c, rng, amb, rng.uniform(1.5, 4), rng.uniform(.3, .7), rng.uniform(.25, .4), coat=True)
    return c


def case_shirtless_close(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(0.3, 0.6), rng.uniform(.35, .65), rng.uniform(-.4, -.1),
              shirtless=True)
    return c


def case_face_close(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(0.4, 0.8), rng.uniform(.3, .7), rng.uniform(.2, .45))
    return c


def case_sitting(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(1.5, 4), rng.uniform(.3, .7), rng.uniform(.3, .45), pose='sit')
    return c


def case_behind_table(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(1.5, 3.5), .5, rng.uniform(.3, .4), pose='sit')
    c.paint(synth.rect(W / 2, H * rng.uniform(.62, .75), W * .8, H * .35), amb + rng.normal(0, .5),
            owner=synth.OCCLUDER)
    return c


def case_lying(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(1.5, 4), rng.uniform(.25, .75), rng.uniform(.5, .8), pose='lie')
    return c


def case_edge(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(1.5, 3), rng.choice([0.02, 0.98]), rng.uniform(.25, .4))
    return c


def case_two_close(rng):
    c, amb, _ = room(rng)
    d = rng.uniform(1.5, 4)
    s = synth.F_PX * synth.SS / d
    x = rng.uniform(.35, .55) * W
    y = rng.uniform(.25, .4) * H
    synth.person(c, rng, amb, d, x, y, 0)
    synth.person(c, rng, amb, d, x + rng.uniform(.3, .42) * s, y, 1)
    return c


def case_three_group(rng):
    c, amb, _ = room(rng)
    d = rng.uniform(2, 4)
    s = synth.F_PX * synth.SS / d
    x = rng.uniform(.3, .45) * W
    y = rng.uniform(.25, .4) * H
    for i in range(3):
        synth.person(c, rng, amb, d * rng.uniform(.95, 1.05), x + i * rng.uniform(.3, .45) * s,
                     y + rng.normal(0, .03) * s, i)
    return c


def case_crowd(rng, n=10):
    c, amb, _ = room(rng)
    ppl = sorted([(rng.uniform(2, 7), rng.uniform(.08, .92), 0) for _ in range(n)], key=lambda p: -p[0])
    for i, (d, xf, _) in enumerate(ppl):
        person_at(c, rng, amb, d, xf, .2 + (7 - d) / 5 * .25, pid=i)
    return c


def case_hot_room(rng):
    c, amb, _ = room(rng, hot=rng.uniform(31, 34))
    person_at(c, rng, amb, rng.uniform(1.5, 4), rng.uniform(.3, .7), rng.uniform(.25, .4))
    return c


def case_overhead(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(2, 3.5), rng.uniform(.2, .8), rng.uniform(.2, .8), overhead=True)
    return c


def distractor_case(kind):
    def build(rng):
        c, amb, _ = room(rng)
        synth.distractor(c, rng, amb, 99999, kind=kind)
        return c
    return build


def case_hand(rng):
    c, amb, _ = room(rng)
    synth.hand_near_lens(c, rng, amb, 99999)
    return c


def case_person_and_heater(rng):
    c, amb, _ = room(rng)
    synth.distractor(c, rng, amb, 99998, kind='radiator')
    person_at(c, rng, amb, rng.uniform(1.5, 3.5), rng.uniform(.3, .7), rng.uniform(.25, .4))
    return c


def case_person_with_drink(rng):
    c, amb, _ = room(rng)
    person_at(c, rng, amb, rng.uniform(1, 2.5), rng.uniform(.35, .65), rng.uniform(.25, .4))
    s = synth.F_PX * synth.SS / 1.5
    c.paint(synth.rect(rng.uniform(.3, .7) * W, rng.uniform(.55, .75) * H, .08 * s, .1 * s),
            rng.uniform(45, 65), owner=99997)
    return c


def case_reflection(rng):
    c, amb, _ = room(rng)
    gx, gy = rng.uniform(.2, .8) * W, rng.uniform(.25, .5) * H
    gs = synth.F_PX * synth.SS / rng.uniform(1.5, 4)
    ghost = amb + rng.uniform(1.5, 4)
    c.paint(synth.rect(gx, gy + .35 * gs, .36 * gs, .5 * gs, corner=.06 * gs), ghost - .5)
    c.paint(synth.ellipse(gx, gy, .08 * gs, .11 * gs), ghost)
    return c


CASES = [
    ('empty room', 0, case_empty),
    ('one standing', 1, case_one_standing),
    ('far across the room (6-8 m)', 1, case_far),
    ('child', 1, case_child),
    ('winter coat, cold room', 1, case_coat),
    ('shirtless torso at the sensor', 1, case_shirtless_close),
    ('face close to the sensor', 1, case_face_close),
    ('sitting', 1, case_sitting),
    ('behind a table', 1, case_behind_table),
    ('lying down', 1, case_lying),
    ('half out of view at the edge', 1, case_edge),
    ('two shoulder to shoulder', 2, case_two_close),
    ('group of three', 3, case_three_group),
    ('crowd of ten', 10, case_crowd),
    ('hot room (31-34 C)', 1, case_hot_room),
    ('from the ceiling', 1, case_overhead),
    ('person next to a heater', 1, case_person_and_heater),
    ('person with a hot drink', 1, case_person_with_drink),
    ('hand at the lens', 0, case_hand),
    ('hot mug', 0, distractor_case('mug')),
    ('plate of food', 0, distractor_case('plate')),
    ('laptop', 0, distractor_case('laptop')),
    ('monitor or TV', 0, distractor_case('screen')),
    ('radiator', 0, distractor_case('radiator')),
    ('lamp', 0, distractor_case('lamp')),
    ('dog or cat', 0, distractor_case('pet')),
    ('warm seat just left', 0, distractor_case('seat')),
    ('sun on the floor', 0, distractor_case('sun')),
    ('hot vent', 0, distractor_case('vent')),
    ('reflection in glass', 0, case_reflection),
]


def main(argv):
    import main as sensor
    model = sensor.PeopleModel(argv[0], sensor.THERMAL_MODEL_THRESHOLD)
    n = int(argv[1]) if len(argv) > 1 else 150
    rows = []
    for name, truth, build in CASES:
        rng = np.random.default_rng(abs(hash(name)) % (1 << 31))
        ok = near = rule_ok = 0
        for _ in range(n):
            t = finish(build(rng), rng)
            frame = t.ravel().tolist()
            said = len(model.read(frame)[0])
            ok += said == truth
            near += abs(said - truth) <= 1
            rule_ok += sensor.count_thermal_clusters(frame) == truth
        rows.append((ok / n, name, truth, rule_ok / n, near / n))
    print(f'{"case":36s} {"truth":>5s} {"owl":>6s} {"+-1":>6s} {"rule":>6s}')
    for score, name, truth, rule, near in rows:
        flag = '  <- hole' if score < 0.8 else ''
        print(f'{name:36s} {truth:5d} {score:6.0%} {near:6.0%} {rule:6.0%}{flag}')
    print(f'\nmean {np.mean([r[0] for r in rows]):.0%}, worst {min(rows)[1]} ({min(rows)[0]:.0%})')
    return 0


if __name__ == '__main__':
    args = sys.argv[1:]
    sys.argv = sys.argv[:1]
    sys.exit(main(args))
