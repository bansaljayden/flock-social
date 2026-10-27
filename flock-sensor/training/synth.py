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
from scipy.ndimage import gaussian_filter, map_coordinates, uniform_filter

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
# Contact heat (2026-10-21), off by default. Where somebody sat or leaned, fabric and wood keep their heat for
# minutes. owl-4.9's warm seat is one flat rectangle at one temperature; a real one is shaped like the contact
# (thighs and seat, a back against the backrest, forearms along a table edge), warmest where the contact was
# firmest, and cools toward the room by Newton's law, its thin edges first (contact_heat). Off, nothing new is drawn
# and every random draw is the one owl-4.9's generator made, so its frames are byte for byte the same. scene_full's
# `contact` argument overrides this default per call: train.py --contact-heat passes it for freshly drawn training
# frames and bank.py --contact-heat for a bank, while held-out frames keep the default. Real thermal video showed
# the need (a seat left warm read as a second person); that footage is a sealed test, so no number here is tuned
# to it.
CONTACT_HEAT = False


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


def _union(*shapes):
    """Several masks as one: (x0, y0, coverage) over their joint bounding box, the most of each pixel's coverage."""
    shapes = [s for s in shapes if s is not None]
    if not shapes:
        return None
    x0, y0 = min(s[0] for s in shapes), min(s[1] for s in shapes)
    x1 = max(s[0] + s[2].shape[1] for s in shapes)
    y1 = max(s[1] + s[2].shape[0] for s in shapes)
    m = np.zeros((y1 - y0, x1 - x0), dtype=np.float32)
    for sx, sy, sm in shapes:
        h, w = sm.shape
        view = m[sy - y0:sy - y0 + h, sx - x0:sx - x0 + w]
        np.maximum(view, sm, out=view)
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
    elif shirtless if shirtless is not None else rng.random() < 0.12:
        # No shirt, or a vest: the torso reads as skin, as warm as a face.
        # A real unit missed a bare torso filling its view because every
        # person it had learned from wore clothes cooler than skin.
        cloth = skin - rng.uniform(0.3, 1.8)
    # Hair insulates: a crown reads 3 to 10C over the room, short hair warmer.
    hair = min(skin - 0.5, amb + rng.uniform(3.0, 10.0))
    pants = amb + (skin - amb) * rng.uniform(0.15, 0.55)
    head_rx, head_ry = 0.083 * s * rng.uniform(0.9, 1.1), 0.115 * s * rng.uniform(0.9, 1.1)
    view = view or rng.choice(['front', 'back', 'side'], p=[0.5, 0.3, 0.2])
    pose = pose or rng.choice(['stand', 'sit', 'walk', 'lie'], p=[0.41, 0.32, 0.17, 0.10])

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


def contact_heat(c, rng, amb, x, y, s, oid=-1, parts=('seat',), age=None):
    """Heat a body left on furniture, painted at (x, y) for things s canvas px per metre away.

    parts: any of 'seat' (two thighs and the seat behind them: a level surface, so foreshortened seen from a wall),
    'back' (where a back rested on a backrest, above the seat), 'cushion' (a pillow held against the body, then put
    down) and 'edge' (forearms along a table edge). All parts share one sitting. The surface was warmed 60 to 90% of
    the way from the room to skin, most under the firmest contact, then cooled toward the room for `age` seconds (0
    to 6 minutes unless given) by Newton's law, with a time constant of 1 to 4 minutes on fabric and 30 s to 2 minutes
    on a hard edge. A thin, lightly pressed rim stores less heat and loses it faster, so an older mark is smaller as
    well as fainter. The heat adds to whatever the surface was and never takes it past skin temperature. Pixels
    still 0.6C or more over the surface belong to oid, the warm seat; a fainter mark and any edge mark get no label.
    """
    # Skin as person() draws it: a forehead reads 33.4C at 22C air and follows the room.
    skin = min(36.5, 33.4 + 0.14 * (amb - 22.0) + rng.normal(0, 0.8))
    rise = (skin - amb) * rng.uniform(0.6, 0.9)      # below zero only in a room warmer than skin
    hard = parts == ('edge',)
    tau = rng.uniform(30.0, 120.0) if hard else rng.uniform(60.0, 240.0)
    age = rng.uniform(0.0, 360.0) if age is None else float(age)
    fore = rng.uniform(0.35, 0.7)                     # how much of a level surface a camera above it sees
    ang = rng.normal(0, 0.15)
    shapes, weight = [], []
    for part in parts:
        if part == 'seat':
            gap = 0.055 * s
            for side in (-1, 1):
                shapes.append(ellipse(x + side * gap, y, 0.075 * s, 0.17 * s * fore, ang))
                weight.append(0.85)
            shapes.append(ellipse(x, y - 0.12 * s * fore, 0.17 * s, 0.1 * s * fore, ang))
            weight.append(1.0)
        elif part == 'back':
            # Upright, so seen whole: the upper back, over the seat's rear edge.
            shapes.append(ellipse(x, y - 0.12 * s * fore - 0.3 * s, 0.14 * s, 0.17 * s, ang))
            weight.append(rng.uniform(0.4, 0.7))      # through clothing, a lighter contact
        elif part == 'cushion':
            shapes.append(ellipse(x, y, 0.2 * s, 0.12 * s, rng.normal(0, 0.3)))
            weight.append(rng.uniform(0.6, 1.0))
        elif part == 'edge':
            half = rng.uniform(0.12, 0.2) * s
            a = rng.normal(0, 0.12)
            shapes.append(capsule(x - half * math.cos(a), y - half * math.sin(a),
                                  x + half * math.cos(a), y + half * math.sin(a), 0.03 * s))
            weight.append(rng.uniform(0.5, 0.9))
    kept = [(sh, wt) for sh, wt in zip(shapes, weight) if sh is not None]
    shape = _union(*[sh for sh, _ in kept])
    if shape is None:
        return
    x0, y0, m = shape
    strength = np.zeros_like(m)
    for (sx, sy, sm), wt in kept:
        h, w = sm.shape
        view = strength[sy - y0:sy - y0 + h, sx - x0:sx - x0 + w]
        np.maximum(view, sm * wt, out=view)
    # How firm the contact was: 1 in the middle of the firmest part, falling to 0 at the rim.
    core = gaussian_filter(strength, max(1.0, 0.04 * s))
    core = np.clip((core / max(float(core.max()), 1e-6) - 0.4) / 0.6, 0.0, 1.0)
    # Newton's law at every pixel, with less heat stored and a shorter time constant where the contact was light.
    dt = rise * (0.55 + 0.45 * core) * np.exp(-age / (tau * (0.35 + 0.65 * core)))
    h, w = m.shape
    region = c.t[y0:y0 + h, x0:x0 + w]
    lo, hi = min(amb, skin), max(amb, skin)
    field = np.clip(region + dt, np.minimum(region, lo), np.maximum(region, hi)).astype(np.float32)
    c.paint((x0, y0, m), None, field=field)
    if not hard and oid >= 0:
        own = c.owner[y0:y0 + h, x0:x0 + w]
        own[(m > 0.5) & (dt * m >= 0.6)] = oid


def distractor(c, rng, amb, oid=-1, kind=None, contact=None):
    """Draw one thing that is warm and is not a person. Returns its class
    name (see CLASSES), or None for a patch of sun, which is background.
    contact: a warm seat drawn as contact heat (None: CONTACT_HEAT)."""
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
        if CONTACT_HEAT if contact is None else contact:
            # Shaped like the contact and cooling, not a flat card (see CONTACT_HEAT).
            parts = (('seat', 'back'), ('seat',), ('cushion',))[int(rng.integers(3))]
            contact_heat(c, rng, amb, x, y, s, oid, parts=parts)
        else:
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


def scene_full(rng, contact=None, dining=False):
    """One frame and everything in it.

    Returns (celsius [ROWS, COLS] float32, objects), each object a dict with
    'cls' (a name from CLASSES), 'x', 'y' (its point, in frame pixels) and
    'box' (x0, y0, x1, y1, the part of it that shows). A person's point is the
    head, the thing that is counted; anything else's is the middle of what
    shows of it. contact: draw contact heat (None: CONTACT_HEAT).
    dining: a restaurant seen from the ceiling above the door instead (scene_dining). Off, nothing here changes.
    """
    if dining:
        return scene_dining(rng)
    contact = CONTACT_HEAT if contact is None else bool(contact)
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
    if not overhead and rng.random() < 0.12:
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
        cls = distractor(c, rng, amb, oid, contact=contact)
        next_id[0] += 1
        if cls is not None:
            things[oid] = cls

    # Behind first: distractors on the floor and tables go in among them.
    order = sorted(placed, key=lambda p: -p[0])
    for _ in range(int(rng.integers(0, 5))):
        add_distractor()
    # Contact heat (contact only): the seat somebody just got up from, beside them, or the seats the room's last people
    # left warm, and forearms' heat along a table edge. Drawn before the people, so a person standing in front of the
    # seat they left covers it. The seat is placed from the head between a seated neighbour's seat level (0.7 m down)
    # and a chair's beside somebody standing (1.1 m), since nobody's pose is drawn yet. A warm seat is named, never
    # counted; an edge mark gets no label at all.
    if contact and not overhead:
        if n == 0 and rng.random() < 0.35:
            for _ in range(int(rng.integers(1, 3))):
                sd = rng.uniform(1.0, 5.0)
                contact_heat(c, rng, amb, rng.uniform(0.1, 0.9) * W, rng.uniform(0.45, 0.95) * H, F_PX * SS / sd,
                             new_id('warm seat'),
                             parts=(('seat', 'back'), ('seat',), ('cushion',))[int(rng.integers(3))])
        elif n and rng.random() < 0.25:
            pd, phx, phy, _ = placed[int(rng.integers(len(placed)))]
            ps = F_PX * SS / pd
            contact_heat(c, rng, amb, phx + rng.choice([-1, 1]) * rng.uniform(0.35, 0.7) * ps,
                         phy + rng.uniform(0.7, 1.1) * ps, ps, new_id('warm seat'),
                         parts=(('seat', 'back'), ('seat',))[int(rng.integers(2))], age=rng.uniform(0.0, 90.0))
        if rng.random() < 0.15:
            ed = rng.uniform(1.0, 4.0)
            contact_heat(c, rng, amb, rng.uniform(0.15, 0.85) * W, rng.uniform(0.5, 0.9) * H, F_PX * SS / ed,
                         parts=('edge',))
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
        visible = _crooked(c, visible, rng.normal(0, 4.0))
    t = _sensor(c.t, rng)
    return t, _labels(c, visible, things)


def _crooked(c, visible, angle):
    """Turn the canvas by angle degrees, and the label points with it."""
    from scipy.ndimage import rotate
    c.t = rotate(c.t, angle, reshape=False, order=1, mode='nearest')
    c.owner = rotate(c.owner, angle, reshape=False, order=0, mode='constant', cval=-1)
    rad = np.radians(-angle)
    ca, sa = np.cos(rad), np.sin(rad)
    turned = []
    for pid, (hx, hy, hr), torso in visible:
        dx, dy = hx - W / 2, hy - H / 2
        turned.append((pid, (W / 2 + dx * ca - dy * sa, H / 2 + dx * sa + dy * ca, hr), torso))
    return turned


def _sensor(canvas_t, rng):
    """The supersampled canvas down to the camera's resolution, then its optics and its electronics."""
    t = canvas_t.reshape(ROWS, SS, COLS, SS).mean(axis=(1, 3))
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
    return t.astype(np.float32)


def _labels(c, visible, things, poses=None):
    """Labels from what is actually visible in the final frame. poses, {pid: pose} (scene_dining only), adds each
    person's 'pose' and 'posture' (see POSTURE_OF); without it a person's label is exactly as it always was."""
    objects = []
    own = c.owner.reshape(ROWS, SS, COLS, SS)

    def box_of(mask):
        ys, xs = np.nonzero(mask)
        return (float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)), len(xs)

    def person_label(pid, x, y, box):
        o = {'cls': 'person', 'x': x, 'y': y, 'box': box}
        if poses is not None and pid in poses:
            o['pose'] = poses[pid]
            o['posture'] = POSTURE_OF[poses[pid]]
        return o

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
                objects.append(person_label(pid, fx, fy, box))
                continue
        # Head out of view or hidden: count the body if a good part of it shows.
        area_px = ((tx1 - tx0) / SS) * ((ty1 - ty0) / SS)
        if shown > max(12, 0.25 * area_px):
            ys, xs = np.nonzero(mask)
            objects.append(person_label(pid, float(xs.mean()), float(ys.mean()), box))
    for oid, cls in things.items():
        mask = (own == oid).any(axis=(1, 3))
        if mask.sum() < 3:
            continue
        box, _ = box_of(mask)
        objects.append({'cls': cls, 'x': (box[0] + box[2]) / 2, 'y': (box[1] + box[3]) / 2,
                        'box': box})
    return objects


# ---------------------------------------------------------------------------
# A dining room, from the ceiling above the door (2026-10-27, opt-in)
#
# Nothing above calls this unless asked, so owl-4.9's generator is untouched: scene_full(rng, dining=True) or
# scene_dining(rng) draws one. The box hangs over the door about 3 m up with its Lepton 3.5 aimed 25 to 35 degrees
# down across the room, where table_learning_eval.py and table_illustration.py placed it: rows of tables from 1.5 to
# 13 m, diners seated at them (faces on the far side of a table, backs on the near side, profiles between), servers
# standing and walking in the aisles or stopped at a table, plates and cups on the tables, warm seats where a party
# just left, and empty tables. People are drawn by person() as a wall camera sees them, then shortened top to bottom
# by the cosine of how steeply the box looks down on them, the squash those two scripts use. Every person's label
# carries a pose ('sit', 'stand' or 'walk') and a posture ('sit' or 'stand', POSTURE_OF), which
# targets(posture=True) turns into a second map.
# ---------------------------------------------------------------------------

POSTURES = ('sit', 'stand')
POSTURE_OF = {'sit': 'sit', 'stand': 'stand', 'walk': 'stand'}
# Head heights above the floor, metres: a seated adult's head is near 1.2 m, a standing adult's near 1.7 m.
SEATED_HEAD_M = (1.12, 1.32)
STANDING_HEAD_M = (1.55, 1.85)
TABLE_TOP_M = 0.75
SEAT_M = 0.45
# Unit vectors (x, z) from a table's centre toward each side's chair: far is deeper into the room than the table.
DINING_SIDES = {'far': (0.0, 1.0), 'near': (0.0, -1.0), 'left': (-1.0, 0.0), 'right': (1.0, 0.0)}


class Mount:
    """Where the box hangs: cam_h metres up, its lens pitched `pitch` radians below level. Room coordinates: x
    across, h up from the floor, z into the room from the door wall, the camera at x = 0, z = 0. The projection is
    table_learning_eval.project's with the height and pitch as parameters. A crooked mount is drawn afterwards, as
    scene_full draws one."""

    def __init__(self, cam_h=3.0, pitch=math.radians(30.0)):
        self.cam_h, self.pitch = float(cam_h), float(pitch)
        self.cp, self.sp = math.cos(self.pitch), math.sin(self.pitch)

    def project(self, x, h, z):
        """(u, v) in frame pixels, and the depth along the lens's axis in metres."""
        dy = h - self.cam_h
        yc = dy * self.cp + z * self.sp
        zc = -dy * self.sp + z * self.cp
        return COLS / 2 + F_PX * x / zc, ROWS / 2 - F_PX * yc / zc, zc

    def canvas(self, x, h, z):
        u, v, zc = self.project(x, h, z)
        return u * SS, v * SS, zc

    def down(self, x, h, z):
        """How far below level the box looks to see (x, h, z), radians."""
        return math.atan2(self.cam_h - h, math.hypot(x, z))

    def half_width(self, z):
        """Roughly half the floor's width in view at depth z, metres."""
        return z * math.tan(math.radians(HFOV_DEG / 2)) / self.cp


def _polygon(points):
    """A filled polygon in canvas pixels, as (x0, y0, coverage), its edge softened like the other shapes."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x0, y0 = int(max(0, math.floor(min(xs)))), int(max(0, math.floor(min(ys))))
    x1, y1 = int(min(W, math.ceil(max(xs)) + 1)), int(min(H, math.ceil(max(ys)) + 1))
    if x1 <= x0 or y1 <= y0:
        return None
    gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    inside = np.zeros(gx.shape, dtype=bool)
    n = len(points)
    for i in range(n):
        ax, ay = points[i]
        bx, by = points[(i + 1) % n]
        inside ^= ((ay > gy) != (by > gy)) & (gx < (bx - ax) * (gy - ay) / ((by - ay) or 1e-9) + ax)
    return x0, y0, gaussian_filter(inside.astype(np.float32), 0.6)


def _level_rect(mount, x, z, h, w, d):
    """A level rectangle w across and d deep, centred on (x, z) at height h: a table top, a seat."""
    return _polygon([mount.canvas(x + dx, h, z + dz)[:2]
                     for dx, dz in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))])


def _level_disc(mount, x, z, h, r):
    """A level disc, a plate or a cup, which the box sees as an ellipse."""
    return _polygon([mount.canvas(x + r * math.cos(a), h, z + r * math.sin(a))[:2]
                     for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)])


def _dining_person(c, rng, amb, mount, x, z, pose, facing, pid):
    """One person at floor position (x, z): pose 'sit' (in a chair), 'stand' or 'walk', facing the direction
    `facing` (radians in the x, z plane). Drawn by person() on a scratch canvas, shortened top to bottom about the
    head by cos(how steeply the box looks down), and laid over c with its owner. Returns person()'s head and torso
    box, the torso shortened the same way, and the head's height in metres."""
    h = rng.uniform(*(SEATED_HEAD_M if pose == 'sit' else STANDING_HEAD_M))
    hx, hy, zc = mount.canvas(x, h, z)
    # Which side of them the box sees: their face when they face the door, their back when they face away.
    toward = math.cos(facing - math.atan2(-z, -x))
    view = 'front' if toward > 0.5 else 'back' if toward < -0.5 else 'side'
    scratch = Canvas(np.full((H, W), amb, dtype=np.float32))
    head, (tx0, ty0, tx1, ty1) = person(scratch, rng, amb, zc, hx, hy, pid, view=view, pose=pose,
                                        child=bool(rng.random() < 0.05), shirtless=False,
                                        coat=bool(rng.random() < 0.06))
    k = math.cos(mount.down(x, h, z))
    torso = (tx0, hy + (ty0 - hy) * k, tx1, hy + (ty1 - hy) * k)
    seat_v = None
    if pose == 'sit':
        # person() hangs a seated body's legs straight down, which from above reads as somebody standing. Seen from
        # the ceiling a diner ends at the chair: below it is the chair and the floor, and the thighs run level
        # toward the table, drawn here first so the body covers where they meet it. Seen from behind, the body
        # hides them.
        seat_v = mount.canvas(x, SEAT_M + 0.05, z)[1]
        torso = (torso[0], torso[1], torso[2], min(torso[3], seat_v))
        if view != 'back':
            skin = min(36.5, 33.4 + 0.14 * (amb - 22.0))
            pants = amb + (skin - amb) * rng.uniform(0.15, 0.55)
            reach = rng.uniform(0.35, 0.45)
            ax, ay, azc = mount.canvas(x, SEAT_M + 0.08, z)
            bx, by, _ = mount.canvas(x + reach * math.cos(facing), SEAT_M + 0.08, z + reach * math.sin(facing))
            c.paint(_union(*[capsule(ax + side * 0.07 * F_PX * SS / azc, ay, bx + side * 0.07 * F_PX * SS / azc, by,
                                     0.065 * F_PX * SS / azc) for side in (-1, 1)]), pants, owner=pid)
    own = scratch.owner == pid
    ys, xs = np.nonzero(own)
    if not len(ys):
        return head, torso, h
    r0 = int(max(0, math.floor(hy + (ys.min() - 1 - hy) * k)))
    r1 = int(min(H, math.ceil(hy + (ys.max() + 2 - hy) * k) + 1))
    if seat_v is not None:
        r1 = int(min(r1, max(r0 + 1, math.ceil(seat_v))))
    c0, c1 = int(max(0, xs.min() - 1)), int(min(W, xs.max() + 2))
    if r1 <= r0 or c1 <= c0:
        return head, torso, h
    rows, cols = np.mgrid[r0:r1, c0:c1].astype(np.float32)
    src = [hy + (rows - hy) / k, cols]
    body = map_coordinates(scratch.t, src, order=1, mode='constant', cval=amb).astype(np.float32)
    alpha = map_coordinates(own.astype(np.float32), src, order=1, mode='constant', cval=0.0)
    alpha = np.clip(gaussian_filter(alpha, 0.5), 0.0, 1.0).astype(np.float32)
    c.paint((c0, r0, alpha), None, owner=pid, field=body)
    return head, torso, h


def _dining_room(rng, mount):
    """The empty room: floor, and the back wall where the view reaches it, near the room's temperature, with the
    slow gradients and blotches room() gives. Returns (Canvas, amb, the back wall's depth in metres)."""
    amb = rng.uniform(17.0, 28.0)
    if rng.random() < 0.15:
        amb = rng.uniform(28.0, 32.0)        # a packed summer night, the air conditioning losing
    t = np.full((H, W), amb + rng.normal(-0.2, 0.4), dtype=np.float32)
    back = rng.uniform(11.0, 16.0)
    wall_v = mount.canvas(0.0, 0.0, back)[1]   # where the floor meets the back wall
    yy = np.arange(H, dtype=np.float32)[:, None]
    t += np.where(yy < wall_v, rng.normal(0.3, 0.6), 0.0).astype(np.float32)
    gx, gy = rng.normal(0, 0.6, size=2)
    t += gx * np.linspace(-1, 1, W, dtype=np.float32)[None, :] + gy * np.linspace(-1, 1, H, dtype=np.float32)[:, None]
    low = gaussian_filter(rng.normal(0, 1, (H // 8, W // 8)).astype(np.float32), 2)
    t += np.kron(low, np.ones((8, 8), dtype=np.float32)) * rng.uniform(0.1, 0.5)
    c = Canvas(t)
    if wall_v > 0 and rng.random() < 0.3:
        # A window in the back wall, colder or warmer than the room with the weather.
        c.paint(rect(rng.uniform(0.15, 0.85) * W, rng.uniform(0.2, 0.7) * wall_v, rng.uniform(30, 110),
                     rng.uniform(0.2, 0.6) * wall_v), amb + rng.choice([-1, 1]) * rng.uniform(1.5, 5.0))
    return c, amb, back


def _dining_tables(rng, mount, back):
    """Rows of tables from 1.5 m to 13 m (and short of the back wall), across the width in view and a little past
    it, inside the room's side walls. Each is a dict: x, z, w, d (metres), its chairs' sides, its state ('empty', 'seated', or 'left' by a party
    minutes ago) and the sides its party sat at."""
    tables = []
    z = rng.uniform(1.5, 2.6)
    far = min(13.0, back - 1.2)
    # A dining room 7 to 12 m wide, the door near the middle of one end: past a few metres in, its side walls and
    # not the lens's edges bound the rows.
    side = rng.uniform(3.5, 6.0)
    while z <= far:
        half = min(mount.half_width(z) + 0.6, side)
        step = rng.uniform(1.7, 2.6)
        x = -half + rng.uniform(0.0, step)
        while x < half:
            if rng.random() < 0.88:              # now and then a gap: an aisle, a pillar
                if rng.random() < 0.4:
                    w = d = rng.uniform(0.6, 0.72)
                    sides = ('far', 'near') if rng.random() < 0.7 else ('left', 'right')
                else:
                    w, d = rng.uniform(0.75, 0.95), rng.uniform(0.75, 0.9)
                    sides = ('far', 'near', 'left', 'right')
                tables.append({'x': x + rng.normal(0, 0.12), 'z': z + rng.normal(0, 0.12), 'w': w, 'd': d,
                               'sides': sides})
            x += step
        z += rng.uniform(1.7, 2.6)
    for tb in tables:
        r = rng.random()
        tb['state'] = 'empty' if r < 0.3 else 'seated' if r < 0.85 else 'left'
        n = len(tb['sides'])
        if tb['state'] == 'empty':
            tb['party'] = ()
        else:
            size = int(rng.integers(1, n + 1))
            tb['party'] = tuple(tb['sides'][i] for i in sorted(rng.choice(n, size, replace=False)))
    return tables


def scene_dining(rng, warm_seats=True, detail=None):
    """One frame of a restaurant's dining room, as the box over the door sees it.

    Returns (celsius [ROWS, COLS] float32, objects), labelled as scene_full labels: every person whose head shows
    at the head, any other whose body clearly shows at the middle of it, plates of hot food ('food'), hot drinks
    ('hot drink'), the seats a party just left ('warm seat'), a heat lamp at the pass ('lamp') and a radiator
    ('heater'). Each person also carries 'pose' and 'posture' (POSTURE_OF). warm_seats: draw the seats a party just
    left, as contact heat. detail, a dict or None: filled with the mount, the tables and every person drawn (pid, x,
    z, head height, pose), for tests and figures; it changes nothing that is drawn.
    """
    mount = Mount(rng.uniform(2.7, 3.3), math.radians(rng.uniform(25.0, 35.0)))
    c, amb, back = _dining_room(rng, mount)
    tables = _dining_tables(rng, mount, back)
    things = {}
    next_id = [OBJECT_ID0]

    def new_id(cls):
        oid = next_id[0]
        next_id[0] += 1
        if cls is not None:
            things[oid] = cls
        return oid

    # Everything is queued with its depth z and drawn far to near, so nearer things cover what is behind them: a
    # diner on the far side of a table is drawn before its top, one on the near side after it.
    jobs = []
    people = []                 # (pid, x, z, pose, facing)
    for tb in tables:
        tx, tz, w, d = tb['x'], tb['z'], tb['w'], tb['d']
        for side in tb['sides']:
            ux, uz = DINING_SIDES[side]
            off = (w if ux else d) / 2 + 0.22
            cx, cz = tx + ux * off, tz + uz * off
            chair = amb + rng.normal(-0.4, 0.3)
            jobs.append((cz + 0.06, lambda cx=cx, cz=cz, chair=chair:
                         c.paint(_level_rect(mount, cx, cz, SEAT_M, 0.42, 0.42), chair)))
            if tb['state'] == 'left' and side in tb['party'] and warm_seats:
                sx, sy, szc = mount.canvas(cx, SEAT_M, cz)
                parts = (('seat', 'back'), ('seat',))[int(rng.integers(2))]
                age = rng.uniform(0.0, 300.0)
                oid = new_id('warm seat')
                jobs.append((cz + 0.05, lambda sx=sx, sy=sy, szc=szc, parts=parts, age=age, oid=oid:
                             contact_heat(c, rng, amb, sx, sy, F_PX * SS / szc, oid, parts=parts, age=age)))
            if tb['state'] == 'seated' and side in tb['party']:
                # In the chair, leaning a little toward the table. Most face it; some turn. Now and then one is on
                # their feet at their own chair: getting up, or putting a coat on.
                px, pz = tx + ux * (off - 0.12), tz + uz * (off - 0.12)
                facing = math.atan2(-uz, -ux) + rng.normal(0, 0.35)
                pose = 'stand' if rng.random() < 0.05 else 'sit'
                people.append((len(people), px, pz, pose, facing))
        top = amb + rng.normal(-0.6, 0.4)
        jobs.append((tz, lambda tx=tx, tz=tz, w=w, d=d, top=top:
                     c.paint(_level_rect(mount, tx, tz, TABLE_TOP_M, w, d), top)))
        # On the table: a plate and maybe a cup before each diner, or plates going cold where a party left.
        for side in tb['party']:
            ux, uz = DINING_SIDES[side]
            reach = (w if ux else d) / 2 - 0.16
            bx, bz = tx + ux * reach + rng.normal(0, 0.05), tz + uz * reach + rng.normal(0, 0.05)
            if tb['state'] == 'seated' and rng.random() < 0.7:
                hot = rng.random() < 0.75
                temp = rng.uniform(38.0, 62.0) if hot else amb + rng.uniform(1.0, 6.0)
                oid = new_id('food') if hot else -1
                r = rng.uniform(0.1, 0.14)
                jobs.append((tz - 0.001, lambda bx=bx, bz=bz, temp=temp, oid=oid, r=r:
                             c.paint(_level_disc(mount, bx, bz, TABLE_TOP_M + 0.01, r), temp, owner=oid)))
            elif tb['state'] == 'left' and rng.random() < 0.5:
                temp = amb + rng.uniform(0.5, 5.0)
                jobs.append((tz - 0.001, lambda bx=bx, bz=bz, temp=temp:
                             c.paint(_level_disc(mount, bx, bz, TABLE_TOP_M + 0.01, 0.12), temp)))
            if tb['state'] != 'seated':
                continue
            qx, qz = bx + rng.choice([-1, 1]) * 0.15, bz + rng.normal(0, 0.05)
            if rng.random() < 0.35:
                temp = rng.uniform(45.0, 70.0)
                oid = new_id('hot drink')
                jobs.append((tz - 0.002, lambda qx=qx, qz=qz, temp=temp, oid=oid:
                             c.paint(_level_disc(mount, qx, qz, TABLE_TOP_M + 0.1, 0.04), temp, owner=oid)))
            elif rng.random() < 0.4:
                # A glass of ice water, cooler than the room. Not a thing the box names.
                temp = amb - rng.uniform(2.0, 8.0)
                jobs.append((tz - 0.002, lambda qx=qx, qz=qz, temp=temp:
                             c.paint(_level_disc(mount, qx, qz, TABLE_TOP_M + 0.08, 0.035), temp)))
    # People on their feet: in the aisles, walking or standing, and now and then stopped at an occupied table (a
    # server, or a friend dropping by), which is what TableTracker calls a visit.
    seated_tables = [tb for tb in tables if tb['state'] == 'seated']
    for _ in range(int(rng.integers(0, 5))):
        if seated_tables and rng.random() < 0.4:
            tb = seated_tables[int(rng.integers(len(seated_tables)))]
            free = [s for s in DINING_SIDES if s not in tb['party']] or list(DINING_SIDES)
            ux, uz = DINING_SIDES[free[int(rng.integers(len(free)))]]
            off = (tb['w'] if ux else tb['d']) / 2 + rng.uniform(0.35, 0.6)
            px, pz = tb['x'] + ux * off, tb['z'] + uz * off
            facing = math.atan2(-uz, -ux) + rng.normal(0, 0.3)
            pose = 'stand'
        else:
            pz = rng.uniform(1.2, min(12.5, back - 0.8))
            px = rng.uniform(-1.0, 1.0) * mount.half_width(pz)
            facing = rng.uniform(-math.pi, math.pi)
            pose = 'walk' if rng.random() < 0.6 else 'stand'
        people.append((len(people), px, pz, pose, facing))
    heads = {}
    for pid, px, pz, pose, facing in people:
        def draw(pid=pid, px=px, pz=pz, pose=pose, facing=facing):
            heads[pid] = _dining_person(c, rng, amb, mount, px, pz, pose, facing, pid)
        jobs.append((pz, draw))
    # On the back wall: a heat lamp over the pass now and then, a radiator.
    wall_v = mount.canvas(0.0, 0.0, back)[1]
    if wall_v > 8 and rng.random() < 0.15:
        lx, ly = rng.uniform(0.1, 0.9) * W, rng.uniform(0.2, 0.8) * wall_v
        t = rng.uniform(55.0, 120.0)
        oid = new_id('lamp')

        def lamp(lx=lx, ly=ly, t=t, oid=oid):
            c.paint(ellipse(lx, ly, 5.0, 3.0), amb + (t - amb) * 0.25, owner=oid)
            c.paint(ellipse(lx, ly, 2.5, 1.5), t, owner=oid)
        jobs.append((back, lamp))
    if wall_v > 8 and rng.random() < 0.15:
        rx, ry = rng.uniform(0.1, 0.9) * W, wall_v - rng.uniform(2.0, 6.0)
        t = rng.uniform(35.0, 60.0)
        oid = new_id('heater')

        def radiator(rx=rx, ry=ry, t=t, oid=oid):
            for i in range(8):
                c.paint(rect(rx - 12 + i * 3.0, ry, 1.6, 6.0), t, owner=oid)
        jobs.append((back, radiator))
    # Far first; ties keep the order they were queued in (sorted is stable).
    for i in sorted(range(len(jobs)), key=lambda i: -jobs[i][0]):
        jobs[i][1]()
    visible = [(pid, heads[pid][0], heads[pid][1]) for pid, *_ in people]
    if rng.random() < 0.3:
        visible = _crooked(c, visible, rng.normal(0, 2.0))
    t = _sensor(c.t, rng)
    objects = _labels(c, visible, things, poses={pid: pose for pid, _, _, pose, _ in people})
    if detail is not None:
        detail.update(mount=mount, amb=amb, back=back, tables=tables,
                      people=[(pid, px, pz, heads[pid][2], pose) for pid, px, pz, pose, _ in people])
    return t, objects


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


def targets(objects, stride=4, person_sigma_px=None, posture=False):
    """Training targets for owl-2 on the model's 30x40 grid.

    heat [len(CLASSES), 30, 40]: a Gaussian peak of 1 at each object's point,
    wider for bigger things, whose middle is less exactly placed.
    ltrb [4, 30, 40] and mask [30, 40]: at each object's peak cell, the
    distance from the point to the left, top, right and bottom of its box, in
    grid cells, which is how a box is drawn round a person whose point is the
    head and not the middle.

    posture (2026-10-27) is off by default, and off, the return is exactly what it always was. On, two more come
    back: post [len(POSTURES), 30, 40], each person's own peak (the same Gaussian as on the people map) on the map
    of their posture, sitting or standing; and post_known, a float32 scalar, 1 when every person in the frame has a
    posture label and 0 when any lacks one (a real frame, or scene_full's), so a loss grades the posture maps only
    where they are fully labelled. No model reads them yet; training/POSTURE-PLAN.md is the proposal.
    """
    gh, gw = ROWS // stride, COLS // stride
    heat = np.zeros((len(CLASSES), gh, gw), dtype=np.float32)
    ltrb = np.zeros((4, gh, gw), dtype=np.float32)
    mask = np.zeros((gh, gw), dtype=np.float32)
    if posture:
        post = np.zeros((len(POSTURES), gh, gw), dtype=np.float32)
        labelled = True
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
        if posture and k == 0:
            p = POSTURES.index(o['posture']) if o.get('posture') in POSTURES else None
            if p is None:
                labelled = False
            else:
                post[p] = np.maximum(post[p], g)
                if 0 <= ix < gw and 0 <= iy < gh:
                    post[p, iy, ix] = 1.0
        if 0 <= ix < gw and 0 <= iy < gh:
            heat[k, iy, ix] = 1.0
            px, py = (ix + 0.5) * stride, (iy + 0.5) * stride
            ltrb[:, iy, ix] = [max(0.0, px - x0), max(0.0, py - y0),
                               max(0.0, x1 - px), max(0.0, y1 - py)]
            ltrb[:, iy, ix] /= stride
            mask[iy, ix] = 1.0
    if not posture:
        return heat, ltrb, mask
    return heat, ltrb, mask, post, np.float32(1.0 if labelled else 0.0)
