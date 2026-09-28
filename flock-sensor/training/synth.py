"""Synthetic thermal frames, as the Lepton 3.5 on this sensor would see them.

The people counter learns what a person looks like from frames where the
answer is known. Recording people for that is slow and puts images of real
people on disk, so the first model learns from scenes built here instead: a
room at some temperature, people at every distance and pose, and the things
that fool a threshold, drawn through this camera's optics and noise. Every
person carries one label point, so the model is told exactly how many there
are and where.

What makes a frame here look like the camera's, and not like a drawing:

  * The geometry is the Lepton 3.5's: 160x120 pixels across 57 degrees, so a
    head at 3 m is about 8 pixels wide and a hand at 30 cm is about 45.
  * Temperatures are radiometric Celsius, the same numbers main.py counts
    from: skin 31 to 35, clothing somewhere between the room and the skin,
    hair cooler than a face, a hot mug far hotter than any person.
  * Edges are soft (drawn at twice the resolution and averaged down, then
    blurred by the lens), and the frame carries sensor noise, a little fixed
    pattern, vignetting, and the several degrees of absolute error an
    uncalibrated Lepton has.

What gets a label: every person whose head is in view, at the head's centre,
and every person whose head is out of view but whose body clearly is, at the
centre of what shows. What does not: a hand or an arm reaching in from outside
the frame, pets, mugs, laptops, heaters, lamps, warm seats and reflections.

numpy and scipy only. This runs on the development machine, never on the Pi.
"""

import math

import numpy as np
from scipy.ndimage import gaussian_filter, uniform_filter

COLS, ROWS = 160, 120
HFOV_DEG = 57.0
F_PX = (COLS / 2) / math.tan(math.radians(HFOV_DEG / 2))   # about 147 px
SS = 2                                                       # supersampling
# Owner id for anything drawn in front of people that is not a person: a hand
# at the lens or a mug held up hides whoever is behind it.
OCCLUDER = 1 << 20

# What owl-2 names. Index 0 is what the sensor counts; everything else is
# named on the screen so it is plain why it was not counted.
CLASSES = ('person', 'hand', 'pet', 'hot drink', 'food', 'laptop', 'screen',
           'heater', 'lamp', 'warm seat')
_KIND_CLASS = {'mug': 'hot drink', 'plate': 'food', 'laptop': 'laptop',
               'screen': 'screen', 'radiator': 'heater', 'vent': 'heater',
               'lamp': 'lamp', 'pet': 'pet', 'seat': 'warm seat', 'sun': None,
               'footprints': None}
# Owner ids for objects start here, clear of any person id.
OBJECT_ID0 = 10000
W, H = COLS * SS, ROWS * SS


# ---------------------------------------------------------------------------
# Drawing on the supersampled canvas. Every shape returns a coverage mask over
# its own bounding box, 0..1, so painting is a blend: things drawn later are
# nearer and cover what is behind them.
# ---------------------------------------------------------------------------

def _box(cx, cy, rx, ry):
    x0 = max(0, int(math.floor(cx - rx)) - 1)
    x1 = min(W, int(math.ceil(cx + rx)) + 2)
    y0 = max(0, int(math.floor(cy - ry)) - 1)
    y1 = min(H, int(math.ceil(cy + ry)) + 2)
    if x0 >= x1 or y0 >= y1:
        return None
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    return x0, y0, xs + 0.5, ys + 0.5


def ellipse(cx, cy, rx, ry, angle=0.0):
    b = _box(cx, cy, max(rx, ry), max(rx, ry))
    if b is None or rx <= 0 or ry <= 0:
        return None
    x0, y0, xs, ys = b
    c, s = math.cos(angle), math.sin(angle)
    dx, dy = xs - cx, ys - cy
    u = (dx * c + dy * s) / rx
    v = (-dx * s + dy * c) / ry
    d = np.sqrt(u * u + v * v)
    # One canvas pixel of soft edge, whatever the size.
    edge = 1.0 / max(1.0, min(rx, ry))
    m = np.clip((1.0 - d) / edge + 0.5, 0.0, 1.0)
    return x0, y0, m


def capsule(x1, y1, x2, y2, r):
    """A limb, a finger, a table leg: a segment with round ends."""
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = math.hypot(x2 - x1, y2 - y1) / 2 + r
    b = _box(cx, cy, half, half)
    if b is None or r <= 0:
        return None
    x0, y0, xs, ys = b
    vx, vy = x2 - x1, y2 - y1
    L2 = vx * vx + vy * vy
    if L2 < 1e-6:
        t = np.zeros_like(xs)
    else:
        t = np.clip(((xs - x1) * vx + (ys - y1) * vy) / L2, 0.0, 1.0)
    px, py = x1 + t * vx, y1 + t * vy
    d = np.sqrt((xs - px) ** 2 + (ys - py) ** 2)
    m = np.clip(r - d + 0.5, 0.0, 1.0)
    return x0, y0, m


def rect(cx, cy, w, h, angle=0.0, corner=0.0):
    """A rotated rectangle with rounded corners."""
    half = math.hypot(w, h) / 2
    b = _box(cx, cy, half, half)
    if b is None or w <= 0 or h <= 0:
        return None
    x0, y0, xs, ys = b
    c, s = math.cos(angle), math.sin(angle)
    dx, dy = xs - cx, ys - cy
    u = np.abs(dx * c + dy * s) - (w / 2 - corner)
    v = np.abs(-dx * s + dy * c) - (h / 2 - corner)
    outside = np.sqrt(np.maximum(u, 0) ** 2 + np.maximum(v, 0) ** 2)
    inside = np.minimum(np.maximum(u, v), 0)
    d = outside + inside - corner
    m = np.clip(0.5 - d, 0.0, 1.0)
    return x0, y0, m


class Canvas:
    def __init__(self, base):
        self.t = base.astype(np.float32)
        # Which object owns each pixel, for deciding what is actually visible.
        self.owner = np.full((H, W), -1, dtype=np.int32)

    def paint(self, shape, temp, owner=-1, field=None):
        """Blend a shape in at a temperature, or a field of temperatures."""
        if shape is None:
            return
        x0, y0, m = shape
        h, w = m.shape
        region = self.t[y0:y0 + h, x0:x0 + w]
        value = temp if field is None else field
        region[...] = region * (1.0 - m) + value * m
        if owner >= 0:
            o = self.owner[y0:y0 + h, x0:x0 + w]
            o[m > 0.5] = owner


# ---------------------------------------------------------------------------
# The room
# ---------------------------------------------------------------------------

def room(rng):
    """Background: walls and floor near the room's temperature, with the slow
    gradients, furniture and windows every real room has."""
    # Up to 34C: a packed summer room, where a person is barely warmer than
    # the air and a threshold sees nothing at all.
    amb = rng.uniform(12.0, 34.0)
    if rng.random() < 0.2:
        # Hot rooms again, on purpose: the stress test found them a hole
        # (47% on owl-3), and a packed summer bar is when the count matters.
        amb = rng.uniform(29.0, 34.0)
    t = np.full((H, W), amb, dtype=np.float32)
    # Floor and wall at slightly different temperatures, split at a horizon.
    horizon = rng.uniform(0.1, 0.7) * H
    floor_delta = rng.normal(0.0, 0.8)
    yy = np.arange(H, dtype=np.float32)[:, None]
    t += np.where(yy > horizon, floor_delta, 0.0)
    # Slow gradients: warm ceiling, cold outside wall, a radiator's plume.
    gx, gy = rng.normal(0, 0.8, size=2)
    xx = np.linspace(-1, 1, W, dtype=np.float32)[None, :]
    t += gx * xx + gy * np.linspace(-1, 1, H, dtype=np.float32)[:, None]
    low = gaussian_filter(rng.normal(0, 1, (H // 8, W // 8)).astype(np.float32), 2)
    t += np.kron(low, np.ones((8, 8), dtype=np.float32)) * rng.uniform(0.1, 0.6)
    c = Canvas(t)
    # Furniture: tables and shelves at or just off the room's temperature.
    for _ in range(rng.integers(0, 5)):
        c.paint(rect(rng.uniform(0, W), rng.uniform(horizon, H) if rng.random() < 0.7 else rng.uniform(0, H),
                     rng.uniform(20, 140), rng.uniform(10, 60), angle=rng.normal(0, 0.1),
                     corner=rng.uniform(0, 4)),
                amb + rng.normal(-0.3, 0.8))
    # Windows: colder or warmer than the room, depending on the weather.
    if rng.random() < 0.35:
        c.paint(rect(rng.uniform(0, W), rng.uniform(0, horizon), rng.uniform(30, 120),
                     rng.uniform(30, 90)), amb + rng.choice([-1, 1]) * rng.uniform(1.5, 6.0))
    return c, amb, horizon


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------

def _clothing(rng, amb, skin):
    """Clothing surface, as a share of the way from the room to the skin.

    Measured indoors at 22C: a T-shirt outfit reads 29.5C, spring and autumn
    layers 26.9C, a winter outfit 25.1C, which is 0.6 to 0.75 of the way to
    skin for a T-shirt, 0.4 to 0.55 for a sweater, 0.25 to 0.4 for a jacket.
    """
    k = rng.choice([rng.uniform(0.6, 0.75), rng.uniform(0.4, 0.55), rng.uniform(0.25, 0.4)],
                   p=[0.45, 0.35, 0.2])
    return amb + (skin - amb) * k


def person(c, rng, amb, d, hx, hy, pid, view=None, pose=None, overhead=False,
           child=None, shirtless=None, coat=None):
    """Draw one person with the head centre at (hx, hy) canvas pixels, at d
    metres. Returns the head's canvas position and radius, and the torso box,
    so the label can be decided from what is actually visible. child,
    shirtless and coat force those looks (the stress test uses them); left
    None, each happens at random."""
    s = F_PX * SS / d                      # canvas px per metre
    if child if child is not None else rng.random() < 0.12:
        s *= rng.uniform(0.6, 0.8)          # a child
    # Skin follows the room: a forehead reads 33.4C at 22C air and moves
    # 0.14C for every degree of room, measured. Drawn at random before, so a
    # hot room had people no warmer than in a cool one.
    skin = min(36.5, 33.4 + 0.14 * (amb - 22.0) + rng.normal(0, 0.8))
    cloth = _clothing(rng, amb, skin)
    if coat if coat is not None else rng.random() < 0.08:
        # A winter coat reads barely above the room.
        cloth = amb + (skin - amb) * rng.uniform(0.05, 0.2)
    elif shirtless if shirtless is not None else rng.random() < 0.2:
        # No shirt, or a vest: the torso reads as skin, as warm as a face.
        # A real unit missed a bare torso filling its view because every
        # person it had learned from wore clothes cooler than skin.
        cloth = skin - rng.uniform(0.3, 1.8)
    # Hair insulates: a crown reads 3 to 10C over the room, short hair warmer.
    hair = min(skin - 0.5, amb + rng.uniform(3.0, 10.0))
    pants = amb + (skin - amb) * rng.uniform(0.15, 0.55)
    head_rx, head_ry = 0.083 * s * rng.uniform(0.9, 1.1), 0.115 * s * rng.uniform(0.9, 1.1)
    view = view or rng.choice(['front', 'back', 'side'], p=[0.5, 0.3, 0.2])
    pose = pose or rng.choice(['stand', 'sit', 'walk', 'lie'], p=[0.38, 0.30, 0.16, 0.16])

    if pose == 'lie' and not overhead:
        # Lying on a sofa or the floor: the body runs sideways from the head.
        # Nobody lying down appeared in training before, and a long flat warm
        # shape was as likely to read as a heater or a seat as as a person.
        way = rng.choice([-1, 1])
        tilt = rng.normal(0, 0.15)
        body = 0.55 * s * rng.uniform(0.9, 1.1)
        bx = hx + way * (0.13 * s + body / 2) * math.cos(tilt)
        by = hy + (0.13 * s + body / 2) * math.sin(tilt) + 0.03 * s
        leg_x = bx + way * (body / 2 + 0.4 * s) * math.cos(tilt)
        leg_y = by + (body / 2 + 0.4 * s) * math.sin(tilt)
        c.paint(capsule(bx, by, leg_x, leg_y, 0.07 * s), pants, owner=pid)
        c.paint(rect(bx, by, body, 0.3 * s, angle=tilt, corner=0.06 * s), cloth, owner=pid)
        c.paint(ellipse(hx, hy, head_ry, head_rx, tilt), skin - rng.uniform(0.3, 1.5), owner=pid)
        c.paint(ellipse(hx - way * head_ry * 0.4, hy, head_ry * 0.5, head_rx * 1.02, tilt),
                hair, owner=pid)
        x0, x1 = sorted((hx, leg_x))
        return (hx, hy, max(head_rx, head_ry)), (x0, min(hy, leg_y) - 0.15 * s, x1, max(hy, leg_y) + 0.15 * s)

    if overhead:
        # Looking down from a ceiling: shoulders around a head.
        sh_w, sh_h = 0.24 * s, 0.13 * s
        ang = rng.uniform(0, math.pi)
        c.paint(ellipse(hx, hy, sh_w, sh_h, ang), cloth, owner=pid)
        for side in (-1, 1):
            ax = hx + side * math.cos(ang) * sh_w * 0.95
            ay = hy + side * math.sin(ang) * sh_w * 0.95
            c.paint(ellipse(ax, ay, 0.05 * s, 0.05 * s), skin - rng.uniform(0, 2), owner=pid)
        top = hair if rng.random() < 0.85 else skin - rng.uniform(0, 1.5)
        c.paint(ellipse(hx, hy, 0.09 * s, 0.1 * s, ang), top, owner=pid)
        return (hx, hy, 0.1 * s), (hx - sh_w, hy - sh_w, hx + sh_w, hy + sh_w)

    width = 1.0 if view != 'side' else 0.6
    neck_y = hy + head_ry * 0.95
    torso_w = 0.40 * s * width * rng.uniform(0.85, 1.15)
    torso_h = 0.55 * s * rng.uniform(0.9, 1.1)
    torso_cy = neck_y + torso_h / 2 + 0.04 * s
    lean = rng.normal(0, 0.06)
    # Legs first: they are behind the torso and often under a table.
    if pose == 'sit':
        leg_len = 0.35 * s
        for side in (-1, 1):
            x = hx + side * torso_w * 0.22
            c.paint(capsule(x, torso_cy + torso_h / 2, x + side * 0.03 * s,
                            torso_cy + torso_h / 2 + leg_len, 0.065 * s), pants, owner=pid)
    else:
        leg_len = 0.85 * s
        spread = 0.08 * s if pose == 'walk' else 0.03 * s
        for side in (-1, 1):
            x = hx + side * torso_w * 0.2
            c.paint(capsule(x, torso_cy + torso_h / 2 - 0.05 * s, x + side * spread,
                            torso_cy + torso_h / 2 + leg_len, 0.065 * s), pants, owner=pid)
    c.paint(rect(hx + lean * s, torso_cy, torso_w, torso_h, angle=lean,
                 corner=0.08 * s), cloth, owner=pid)
    # Arms: down by the sides, or one bent holding a drink.
    for side in (-1, 1):
        shoulder_x = hx + side * torso_w * 0.45
        shoulder_y = neck_y + 0.06 * s
        if rng.random() < 0.25:
            ex, ey = shoulder_x + side * 0.08 * s, shoulder_y + 0.28 * s
            hx2, hy2 = shoulder_x - side * 0.05 * s, shoulder_y + 0.18 * s
            c.paint(capsule(shoulder_x, shoulder_y, ex, ey, 0.045 * s), cloth, owner=pid)
            c.paint(capsule(ex, ey, hx2, hy2, 0.04 * s), cloth, owner=pid)
            c.paint(ellipse(hx2, hy2, 0.045 * s, 0.05 * s), skin - rng.uniform(0.5, 2.5), owner=pid)
            if rng.random() < 0.6:
                c.paint(rect(hx2, hy2 - 0.05 * s, 0.07 * s, 0.1 * s, corner=0.01 * s),
                        rng.uniform(40, 65), owner=pid)
        else:
            end_x = shoulder_x + side * 0.05 * s
            end_y = shoulder_y + 0.55 * s
            c.paint(capsule(shoulder_x, shoulder_y, end_x, end_y, 0.045 * s), cloth, owner=pid)
            c.paint(ellipse(end_x, end_y + 0.04 * s, 0.045 * s, 0.055 * s),
                    skin - rng.uniform(0.5, 3.0), owner=pid)
    # Neck and head, with hair cooler than a face and a face warmest at its
    # centre. From behind the head is mostly hair.
    c.paint(capsule(hx, hy, hx, neck_y + 0.05 * s, 0.05 * s), skin - rng.uniform(0, 1.0), owner=pid)
    if view == 'back':
        c.paint(ellipse(hx, hy, head_rx, head_ry), hair, owner=pid)
    else:
        c.paint(ellipse(hx, hy, head_rx, head_ry), skin - rng.uniform(0.3, 1.5), owner=pid)
        c.paint(ellipse(hx, hy + head_ry * 0.15, head_rx * 0.7, head_ry * 0.65), skin, owner=pid)
        # Hair or a hat over the top of the head.
        hair_cover = rng.uniform(0.2, 0.6)
        c.paint(ellipse(hx, hy - head_ry * (1 - hair_cover), head_rx * 1.02, head_ry * hair_cover),
                hair, owner=pid)
        if rng.random() < 0.15:
            # A hat or a hood leaves only the face warm.
            hat = amb + (skin - amb) * rng.uniform(0.1, 0.35)
            c.paint(ellipse(hx, hy - head_ry * 0.45, head_rx * 1.15, head_ry * 0.7), hat, owner=pid)
    torso_box = (hx - torso_w / 2, neck_y, hx + torso_w / 2, torso_cy + torso_h / 2)
    return (hx, hy, max(head_rx, head_ry)), torso_box


# ---------------------------------------------------------------------------
# The things a threshold counts as people
# ---------------------------------------------------------------------------

def hand_near_lens(c, rng, amb, oid=OCCLUDER):
    """A hand held up close to the camera: the reason fingers counted twice."""
    d = rng.uniform(0.15, 0.6)
    s = F_PX * SS / d
    skin = rng.uniform(30.0, 34.5)
    cx, cy = rng.uniform(0.2, 0.8) * W, rng.uniform(0.2, 0.9) * H
    ang = rng.normal(0, 0.5)
    palm_w, palm_h = 0.085 * s, 0.1 * s
    ca, sa = math.cos(ang), math.sin(ang)
    # The forearm runs off the nearest edge of the frame.
    edge = rng.choice(['bottom', 'left', 'right'])
    ex, ey = {'bottom': (cx, H + 50), 'left': (-50, cy + 20), 'right': (W + 50, cy + 20)}[edge]
    c.paint(capsule(cx, cy, ex, ey, 0.035 * s), skin - rng.uniform(0.5, 3.0), owner=oid)
    c.paint(rect(cx, cy, palm_w, palm_h, angle=ang, corner=0.02 * s), skin, owner=oid)
    fist = rng.random() < 0.2
    spread = rng.uniform(0.02, 0.18)
    for i in range(4):
        off = (i - 1.5) * palm_w * 0.26
        fa = ang + (i - 1.5) * spread
        length = (0.0 if fist else rng.uniform(0.06, 0.085)) * s
        bx = cx + off * ca - (palm_h / 2) * sa * -1 * 0
        by = cy - palm_h / 2
        tx = bx + math.sin(fa) * length
        ty = by - math.cos(fa) * length
        c.paint(capsule(bx + off * 0, by, tx, ty, 0.0095 * s), skin - rng.uniform(0.5, 3.5))
        if not fist:
            # Fingers are drawn from the palm's top edge, fanned by `spread`.
            c.paint(capsule(cx + off, cy - palm_h / 2, cx + off + math.sin(fa) * length,
                            cy - palm_h / 2 - math.cos(fa) * length, 0.0095 * s),
                    skin - rng.uniform(0.5, 3.5), owner=oid)
    side = rng.choice([-1, 1])
    c.paint(capsule(cx + side * palm_w * 0.5, cy, cx + side * palm_w * 0.95,
                    cy - palm_h * 0.45, 0.011 * s), skin - rng.uniform(0.3, 2.5), owner=oid)


def distractor(c, rng, amb, oid=-1, kind=None):
    """Draw one thing that is warm and is not a person. Returns its class
    name (see CLASSES), or None for a patch of sun, which is background."""
    kind = kind or rng.choice(['mug', 'laptop', 'screen', 'radiator', 'lamp', 'pet',
                       'seat', 'plate', 'sun', 'vent', 'footprints'],
                      p=[0.16, 0.13, 0.08, 0.08, 0.06, 0.11, 0.1, 0.08, 0.09, 0.05, 0.06])
    d = rng.uniform(0.5, 6.0)
    if _KIND_CLASS[kind] is None:
        oid = -1

    def paint(shape, temp):
        c.paint(shape, temp, owner=oid)

    s = F_PX * SS / d
    x, y = rng.uniform(0, W), rng.uniform(0.15, 1.0) * H
    if kind == 'mug':
        t = rng.uniform(42, 70)
        paint(rect(x, y, 0.08 * s, 0.1 * s, corner=0.01 * s), t)
        paint(capsule(x + 0.05 * s, y - 0.02 * s, x + 0.05 * s, y + 0.02 * s, 0.012 * s), t - 8)
    elif kind == 'laptop':
        paint(rect(x, y, 0.33 * s, 0.22 * s, angle=rng.normal(0, 0.3), corner=0.01 * s),
                amb + rng.uniform(4, 14))
    elif kind == 'screen':
        # A monitor or a television is not a flat warm card: the backlight
        # runs hotter along one edge, the electronics make a hot patch, the
        # bezel reads cooler, and it stands on something. Tried in a real
        # room, owl-3 took one for a person now and then.
        sw, sh = rng.uniform(0.45, 1.3) * s, rng.uniform(0.28, 0.75) * s
        base = amb + rng.uniform(2.5, 11)
        paint(rect(x, y, sw * 1.04, sh * 1.06, corner=0.01 * s), amb + rng.uniform(0.5, 3))
        ang = rng.uniform(0, 2 * np.pi)
        box = rect(x, y, sw, sh)
        if box is not None:
            x0, y0, m = box
            hh, ww = m.shape
            gy, gx = np.mgrid[0:hh, 0:ww].astype(np.float32)
            ramp = (np.cos(ang) * (gx / max(ww, 1) - 0.5) + np.sin(ang) * (gy / max(hh, 1) - 0.5))
            field = base + ramp * rng.uniform(0, 5) + rng.normal(0, 0.15, m.shape)
            c.paint(box, None, owner=oid, field=field.astype(np.float32))
        spot = rng.uniform(-0.3, 0.3, 2)
        paint(ellipse(x + spot[0] * sw, y + spot[1] * sh, 0.12 * sw, 0.15 * sh),
              base + rng.uniform(1, 5))
        if rng.random() < 0.7:
            paint(rect(x, y + sh * 0.62, 0.06 * s, 0.25 * sh), amb + rng.uniform(0, 2))
            paint(rect(x, y + sh * 0.75, 0.3 * sw, 0.04 * s), amb + rng.uniform(0, 2))
    elif kind == 'radiator':
        w, h = rng.uniform(0.6, 1.2) * s, rng.uniform(0.4, 0.7) * s
        t = rng.uniform(35, 60)
        for i in range(int(rng.integers(5, 12))):
            paint(rect(x - w / 2 + (i + 0.5) * w / 10, y, w / 14, h, corner=w / 40), t)
    elif kind == 'lamp':
        t = rng.uniform(55, 120)
        paint(ellipse(x, y, 0.06 * s, 0.06 * s), amb + (t - amb) * 0.25)
        paint(ellipse(x, y, 0.03 * s, 0.03 * s), t)
    elif kind == 'pet':
        # Fur reads near the room (a short coat about 5C over it, a long one
        # 2.5C), but eyes and ears run 35 to 38C: a dog or cat is a cool body
        # with a few hot points, which is nothing like a person.
        fur = amb + rng.choice([rng.uniform(3.5, 6.5), rng.uniform(1.5, 4.0)])
        big = rng.uniform(0.6, 1.3)
        paint(ellipse(x, y, 0.25 * s * big, 0.12 * s * big, rng.normal(0, 0.2)), fur)
        hx = x + rng.choice([-1, 1]) * 0.27 * s * big
        paint(ellipse(hx, y - 0.08 * s * big, 0.08 * s * big, 0.07 * s * big), fur + rng.uniform(0.5, 2.5))
        for side in (-1, 1):
            for fb in (-1, 1):
                lx = x + fb * 0.15 * s * big
                paint(capsule(lx + side * 0.02 * s, y + 0.05 * s * big, lx, y + 0.22 * s * big,
                                0.025 * s * big), fur - rng.uniform(0, 2))
        hot = rng.uniform(35.0, 38.0)
        paint(ellipse(hx - 0.02 * s * big, y - 0.1 * s * big, 0.014 * s * big, 0.014 * s * big), hot)
        paint(ellipse(hx + 0.02 * s * big, y - 0.1 * s * big, 0.014 * s * big, 0.014 * s * big), hot)
        paint(ellipse(hx, y - 0.15 * s * big, 0.02 * s * big, 0.03 * s * big), hot - rng.uniform(0, 2))
    elif kind == 'seat':
        # Just left: 4 to 8C over the room on fabric, fading over minutes.
        paint(rect(x, y, 0.42 * s, 0.4 * s, corner=0.05 * s),
              amb + rng.uniform(4.0, 8.0) * rng.uniform(0.2, 1.0))
    elif kind == 'plate':
        paint(ellipse(x, y, 0.13 * s, 0.05 * s), rng.uniform(38, 60))
    elif kind == 'sun':
        paint(rect(x, y, rng.uniform(40, 160), rng.uniform(20, 90), angle=rng.normal(0, 0.4)),
                amb + rng.uniform(3, 14))
    elif kind == 'vent':
        paint(rect(x, y * 0.4, 0.3 * s, 0.15 * s), amb + rng.uniform(6, 20))
    elif kind == 'footprints':
        # Where somebody walked a minute ago: small foot-shaped patches a few
        # degrees over the floor, fading. owl-3 counted them as people 78% of
        # the time in the stress test; they are nothing, and get no label.
        for _ in range(int(rng.integers(2, 9))):
            paint(ellipse(rng.uniform(0.1, 0.9) * W, rng.uniform(0.55, 0.98) * H,
                          rng.uniform(4, 9), rng.uniform(7, 14), rng.normal(0, 0.4)),
                  amb + rng.uniform(1.0, 5.0))
    return _KIND_CLASS[kind]


# ---------------------------------------------------------------------------
# A whole frame
# ---------------------------------------------------------------------------

def _people_count(rng):
    r = rng.random()
    if r < 0.14:
        return 0
    if r < 0.38:
        return 1
    if r < 0.56:
        return 2
    if r < 0.76:
        return int(rng.integers(3, 6))
    if r < 0.9:
        return int(rng.integers(6, 13))
    return int(rng.integers(13, 26))


def scene_full(rng):
    """One frame and everything in it.

    Returns (celsius [ROWS, COLS] float32, objects), each object a dict with
    'cls' (a name from CLASSES), 'x', 'y' (its point, in frame pixels) and
    'box' (x0, y0, x1, y1, the part of it that shows). A person's point is the
    head, the thing that is counted; anything else's is the middle of what
    shows of it.
    """
    c, amb, horizon = room(rng)
    overhead = rng.random() < 0.2
    n = _people_count(rng)
    placed = []
    for pid in range(n):
        d = rng.uniform(0.8, 7.0) if not overhead else rng.uniform(1.8, 3.5)
        # Farther people stand higher in a wall-mounted view.
        if overhead:
            hx, hy = rng.uniform(-0.05, 1.05) * W, rng.uniform(-0.05, 1.05) * H
        else:
            depth = (d - 0.8) / 6.2
            hx = rng.uniform(-0.08, 1.08) * W
            hy = (horizon - 0.05 * H) + (1 - depth) * rng.uniform(0.0, 0.55) * H - 0.15 * H
            hy = float(np.clip(hy + rng.normal(0, 0.08 * H), -0.15 * H, 1.1 * H))
        placed.append((d, hx, hy, pid))
    # Somebody right in front of the camera, head and shoulders filling it: the
    # person standing at the screen looking at their own count.
    if not overhead and rng.random() < 0.15:
        placed.append((rng.uniform(0.35, 0.8), rng.uniform(0.2, 0.8) * W,
                       rng.uniform(0.1, 0.55) * H, n))
        n += 1
    # A body filling the frame with the head above it, out of view: somebody
    # standing right at the sensor. Still a person; the body carries the label.
    if not overhead and rng.random() < 0.22:
        placed.append((rng.uniform(0.3, 0.7), rng.uniform(0.25, 0.75) * W,
                       rng.uniform(-0.45, -0.05) * H, n))
        n += 1
    # One person standing behind another, partly hidden: the stress test
    # found owl-3 counted two as one 41% of the time.
    if n >= 2 and not overhead and rng.random() < 0.4:
        i, j = rng.choice(n, 2, replace=False)
        di, xi, yi, pi = placed[i]
        placed[j] = (di + rng.uniform(1.0, 3.0), xi + rng.normal(0, 0.03) * W,
                     yi - rng.uniform(0.02, 0.08) * H, placed[j][3])
    # Pairs close together: move some people next to another.
    if n >= 2 and rng.random() < 0.35:
        for _ in range(int(rng.integers(1, max(2, n // 2 + 1)))):
            i, j = rng.choice(n, 2, replace=False)
            di, xi, yi, pi = placed[i]
            s = F_PX * SS / di
            placed[j] = (di * rng.uniform(0.95, 1.05),
                         xi + rng.choice([-1, 1]) * rng.uniform(0.32, 0.55) * s,
                         yi + rng.normal(0, 0.05) * s, placed[j][3])

    things = {}          # owner id -> class name
    next_id = [OBJECT_ID0]

    def new_id(cls):
        oid = next_id[0]
        next_id[0] += 1
        if cls is not None:
            things[oid] = cls
        return oid

    def add_distractor():
        oid = next_id[0]
        cls = distractor(c, rng, amb, oid)
        next_id[0] += 1
        if cls is not None:
            things[oid] = cls

    # Behind first: distractors on the floor and tables go in among them.
    order = sorted(placed, key=lambda p: -p[0])
    for _ in range(int(rng.integers(0, 5))):
        add_distractor()
    visible = []
    for d, hx, hy, pid in order:
        head, torso = person(c, rng, amb, d, hx, hy, pid, overhead=overhead)
        visible.append((pid, head, torso))
    if rng.random() < 0.15:
        for _ in range(int(rng.integers(1, 3))):
            hand_near_lens(c, rng, amb, new_id('hand'))
    if rng.random() < 0.2:
        add_distractor()
    # A table or a bar in front of people: it hides whoever is behind it, so
    # it takes their pixels, and what shows of them decides their label.
    if n and not overhead and rng.random() < 0.3:
        for _ in range(int(rng.integers(1, 3))):
            ty = rng.uniform(0.45, 0.95) * H
            c.paint(rect(rng.uniform(0, W), ty, rng.uniform(80, 300), rng.uniform(25, 70),
                         corner=3), amb + rng.normal(-0.3, 0.6), owner=OCCLUDER)
    # A reflection in a window or a glossy wall: shaped like a person, a few
    # degrees warm, and not a person. Nobody gets a label for it.
    if rng.random() < 0.12:
        gx, gy = rng.uniform(0.1, 0.9) * W, rng.uniform(0.15, 0.6) * H
        gs = F_PX * SS / rng.uniform(1.5, 5.0)
        ghost = amb + rng.uniform(1.0, 4.0)
        c.paint(rect(gx, gy + 0.35 * gs, 0.36 * gs, 0.5 * gs, corner=0.06 * gs), ghost - 0.5)
        c.paint(ellipse(gx, gy, 0.08 * gs, 0.11 * gs), ghost)

    # A camera mounted a little crooked.
    if rng.random() < 0.3:
        from scipy.ndimage import rotate
        angle = rng.normal(0, 4.0)
        c.t = rotate(c.t, angle, reshape=False, order=1, mode='nearest')
        c.owner = rotate(c.owner, angle, reshape=False, order=0, mode='constant', cval=-1)
        # The label points turn with the picture.
        rad = np.radians(-angle)
        ca, sa = np.cos(rad), np.sin(rad)
        turned = []
        for pid, (hx, hy, hr), torso in visible:
            dx, dy = hx - W / 2, hy - H / 2
            turned.append((pid, (W / 2 + dx * ca - dy * sa, H / 2 + dx * sa + dy * ca, hr), torso))
        visible = turned

    # Down to the camera's resolution, then its optics and its electronics.
    t = c.t.reshape(ROWS, SS, COLS, SS).mean(axis=(1, 3))
    t = gaussian_filter(t, rng.uniform(0.5, 1.15))
    yy, xx = np.mgrid[0:ROWS, 0:COLS].astype(np.float32)
    rr = ((xx - COLS / 2) / (COLS / 2)) ** 2 + ((yy - ROWS / 2) / (ROWS / 2)) ** 2
    t += rng.normal(0, 0.5) * rr                                   # vignetting
    t += rng.normal(0, 1, (ROWS, 1)).astype(np.float32) * rng.uniform(0, 0.04)
    t += rng.normal(0, 1, (1, COLS)).astype(np.float32) * rng.uniform(0, 0.04)
    t += rng.normal(0, rng.uniform(0.02, 0.08), (ROWS, COLS))      # temporal noise
    t += rng.normal(0, 1.8)                                        # absolute error
    # Gain: an uncalibrated unit, or a surface that is not a perfect emitter,
    # reads warm things a little hotter or cooler than they are.
    med = float(np.median(t))
    t = med + (t - med) * rng.uniform(0.85, 1.15)
    if rng.random() < 0.2:
        # Column stripes, which a Lepton shows between flat field corrections.
        t += rng.normal(0, 0.12, (1, COLS)).astype(np.float32)
    # Real footage is never flat colour. Graded against real frames, owl-2
    # (trained on flat shapes) read the texture of a real room, of hair and of
    # clothing as more people. Blotches at three scales, from pixel grain to
    # patches of floor, each with its own strength.
    for sigma, most in ((0.8, 0.35), (2.5, 0.6), (8.0, 0.8)):
        n = gaussian_filter(rng.normal(0, 1, (ROWS, COLS)).astype(np.float32), sigma)
        t += n / max(float(n.std()), 1e-6) * rng.uniform(0, most)
    if rng.random() < 0.15:
        # A coarser sensor, or a far-off scene: detail lost into blocks and
        # smoothed back up, the way low-resolution thermal footage looks.
        from scipy.ndimage import zoom
        f = int(rng.integers(2, 6))
        small = t[:ROWS - ROWS % f, :COLS - COLS % f].reshape(ROWS // f, f, COLS // f, f).mean(axis=(1, 3))
        t = zoom(small, (ROWS / small.shape[0], COLS / small.shape[1]), order=1)[:ROWS, :COLS]
    if rng.random() < 0.1:
        # A few dead or stuck pixels.
        for _ in range(int(rng.integers(1, 6))):
            t[rng.integers(0, ROWS), rng.integers(0, COLS)] = rng.choice([-10.0, 80.0])
    t = np.round(t * 100) / 100

    # Labels from what is actually visible in the final frame.
    objects = []
    own = c.owner.reshape(ROWS, SS, COLS, SS)

    def box_of(mask):
        ys, xs = np.nonzero(mask)
        return (float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)), len(xs)

    for pid, (hx, hy, hr), (tx0, ty0, tx1, ty1) in visible:
        mask = (own == pid).any(axis=(1, 3))
        if not mask.any():
            continue
        box, shown = box_of(mask)
        fx, fy = hx / SS, hy / SS
        head_in = 0 <= fx < COLS and 0 <= fy < ROWS
        if head_in:
            # The head has to show, not just be behind somebody else.
            r = max(1.0, hr / SS * 0.6)
            y0, y1 = int(max(0, fy - r)), int(min(ROWS, fy + r + 1))
            x0, x1 = int(max(0, fx - r)), int(min(COLS, fx + r + 1))
            if mask[y0:y1, x0:x1].mean() > 0.3:
                objects.append({'cls': 'person', 'x': fx, 'y': fy, 'box': box})
                continue
        # Head out of view or hidden: count the body if a good part of it shows.
        area_px = ((tx1 - tx0) / SS) * ((ty1 - ty0) / SS)
        if shown > max(12, 0.25 * area_px):
            ys, xs = np.nonzero(mask)
            objects.append({'cls': 'person', 'x': float(xs.mean()), 'y': float(ys.mean()),
                            'box': box})
    for oid, cls in things.items():
        mask = (own == oid).any(axis=(1, 3))
        if mask.sum() < 3:
            continue
        box, _ = box_of(mask)
        objects.append({'cls': cls, 'x': (box[0] + box[2]) / 2, 'y': (box[1] + box[3]) / 2,
                        'box': box})
    return t.astype(np.float32), objects


def scene(rng):
    """One frame: (celsius [ROWS, COLS] float32, [(x, y), ...] per person)."""
    t, objects = scene_full(rng)
    return t, [(o['x'], o['y']) for o in objects if o['cls'] == 'person']


def model_input(celsius):
    """The two channels the model sees: absolute and relative to the room.

    Absolute, so a 60C mug can never be a person; relative, so the several
    degrees an uncalibrated Lepton reads high or low do not move a person out
    of range. Shared with main.py's version, which must match it exactly.
    """
    t = np.asarray(celsius, dtype=np.float32).reshape(ROWS, COLS)
    med = np.median(t)
    a = np.clip((t - 30.0) / 8.0, -3.0, 5.0)
    r = np.clip((t - med) / 4.0, -3.0, 8.0)
    return np.stack([a, r]).astype(np.float32)


def heatmap(points, stride=4, sigma=1.1):
    """Training target: a peak of 1 at each person, on the model's 30x40 grid."""
    gh, gw = ROWS // stride, COLS // stride
    hm = np.zeros((gh, gw), dtype=np.float32)
    ys, xs = np.mgrid[0:gh, 0:gw].astype(np.float32)
    for x, y in points:
        cx, cy = x / stride - 0.5, y / stride - 0.5
        g = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * sigma * sigma))
        hm = np.maximum(hm, g)
        ix, iy = int(round(cx)), int(round(cy))
        if 0 <= ix < gw and 0 <= iy < gh:
            hm[iy, ix] = 1.0
    return hm


def density(objects, stride=4, sigma=1.5):
    """Density target: every person adds a Gaussian that sums to one, so the
    map's total is the number of people, wherever their heads are."""
    gh, gw = ROWS // stride, COLS // stride
    out = np.zeros((1, gh, gw), dtype=np.float32)
    ys, xs = np.mgrid[0:gh, 0:gw].astype(np.float32)
    for o in objects:
        if o['cls'] != 'person':
            continue
        cx, cy = o['x'] / stride - 0.5, o['y'] / stride - 0.5
        g = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * sigma * sigma))
        total = float(g.sum())
        if total > 1e-6:
            # Normalised to one whatever is cut off at the frame's edge: a
            # person half out of view is still one person.
            out[0] += g / total
    return out


def targets(objects, stride=4, person_sigma_px=None):
    """Training targets for owl-2 on the model's 30x40 grid.

    heat [len(CLASSES), 30, 40]: a Gaussian peak of 1 at each object's point,
    wider for bigger things, whose middle is less exactly placed.
    ltrb [4, 30, 40] and mask [30, 40]: at each object's peak cell, the
    distance from the point to the left, top, right and bottom of its box, in
    grid cells, which is how a box is drawn round a person whose point is the
    head and not the middle.
    """
    gh, gw = ROWS // stride, COLS // stride
    heat = np.zeros((len(CLASSES), gh, gw), dtype=np.float32)
    ltrb = np.zeros((4, gh, gw), dtype=np.float32)
    mask = np.zeros((gh, gw), dtype=np.float32)
    ys, xs = np.mgrid[0:gh, 0:gw].astype(np.float32)
    for o in objects:
        k = CLASSES.index(o['cls'])
        x0, y0, x1, y1 = o['box']
        cx, cy = o['x'] / stride - 0.5, o['y'] / stride - 0.5
        size = min(x1 - x0, y1 - y0) / stride
        sigma = max(1.1, size / 6.0) if k else 1.1
        if k == 0 and person_sigma_px:
            # A head whose place was estimated from a body box, not marked:
            # the peak is spread over the pixels it could be in.
            sigma = max(sigma, person_sigma_px / stride)
        g = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * sigma * sigma))
        heat[k] = np.maximum(heat[k], g)
        ix, iy = int(round(cx)), int(round(cy))
        if 0 <= ix < gw and 0 <= iy < gh:
            heat[k, iy, ix] = 1.0
            px, py = (ix + 0.5) * stride, (iy + 0.5) * stride
            ltrb[:, iy, ix] = [max(0.0, px - x0), max(0.0, py - y0),
                               max(0.0, x1 - px), max(0.0, y1 - py)]
            ltrb[:, iy, ix] /= stride
            mask[iy, ix] = 1.0
    return heat, ltrb, mask
