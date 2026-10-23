"""What Flux sees at the tables: one generated thermal frame (no real
person) from the box on the ceiling above the door, looking down across the
dining room through its Lepton 3.5 (57 degrees). Owl's people are found in
it, the box's own TableTracker puts each at a table, and each table is drawn
in the Tables tab's colours, with the same eight tables as the tab's demo.

Run with the flux-training venv, from flock-sensor:
  python training/table_illustration.py . <out.png>
"""
import math
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter, map_coordinates, zoom

SENSOR = Path(sys.argv[1])
OUT = Path(sys.argv[2])
sys.path.insert(0, str(SENSOR / 'training'))
import synth  # noqa: E402

tmp = tempfile.mkdtemp(prefix='flux-tables-')
for k, v in (('FLOCK_CONFIG', 'c.env'), ('FLOCK_LOG', 's.log'), ('FLOCK_BUFFER', 'b.json'),
             ('FLOCK_TABLES', 't.json')):
    os.environ[k] = str(Path(tmp) / v)
sys.path.insert(0, str(SENSOR))
import main  # noqa: E402

COLS, ROWS, SS = synth.COLS, synth.ROWS, synth.SS
F_WIDE = synth.F_PX                           # the Lepton 3.5's 57 degrees
CAM_H, PITCH = 3.0, math.radians(30.0)       # ceiling above the door, looking into the room
rng = np.random.default_rng(5)
amb = 22.5


def project(x, h, z):
    """Room position (x across, h up, z into the room from the door wall) to
    frame pixels and depth along the lens's axis."""
    dy = h - CAM_H
    yc = dy * math.cos(PITCH) + z * math.sin(PITCH)
    zc = -dy * math.sin(PITCH) + z * math.cos(PITCH)
    return COLS / 2 + F_WIDE * x / zc, ROWS / 2 - F_WIDE * yc / zc, zc


def canvas(x, h, z):
    u, v, zc = project(x, h, z)
    return u * SS, v * SS, zc


H, W = ROWS * SS, COLS * SS
t = np.full((H, W), amb - 0.3, dtype=np.float32)
low = gaussian_filter(rng.normal(0, 1, (H // 8, W // 8)).astype(np.float32), 2)
t += np.kron(low, np.ones((8, 8), dtype=np.float32)) * 0.3
# The back wall, a touch warmer than the floor, where the view reaches it.
far_wall_v = project(0, 1.5, 9.0)[1] * SS
t[: max(0, int(far_wall_v))] += 0.4
c = synth.Canvas(t)


def polygon_shape(points):
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
        cross = ((ay > gy) != (by > gy)) & (gx < (bx - ax) * (gy - ay) / ((by - ay) or 1e-9) + ax)
        inside ^= cross
    return x0, y0, gaussian_filter(inside.astype(np.float32), 0.6)


def flat(x, z, h, w, d, temp):
    corners = [canvas(x + dx, h, z + dz)[:2] for dx, dz in ((-w / 2, -d / 2), (w / 2, -d / 2),
                                                             (w / 2, d / 2), (-w / 2, d / 2))]
    c.paint(polygon_shape(corners), temp)


def disc(x, z, h, r, temp):
    pts = [canvas(x + r * math.cos(a), h, z + r * math.sin(a))[:2]
           for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)]
    c.paint(polygon_shape(pts), temp)


def person_at(x, z, facing, pid, standing=False):
    """A person as synth draws one for a camera on a wall, then shortened
    top to bottom for how steeply this box looks down on them."""
    h = 1.65 if standing else 1.2
    hx, hy, zc = canvas(x, h, z)
    down = math.atan2(CAM_H - h, math.hypot(x, z))
    toward = math.cos(facing - math.pi / 2)      # facing the door is -1
    view = 'front' if toward < -0.5 else 'back' if toward > 0.5 else 'side'
    scratch = synth.Canvas(np.full((H, W), amb, dtype=np.float32))
    # synth sizes people with the 57 deg lens's focal length; this distance
    # makes the size right for the 95 deg one.
    synth.person(scratch, rng, amb, zc * synth.F_PX / F_WIDE, hx, hy, pid, view=view,
                 pose='stand' if standing else 'sit', child=False, shirtless=False, coat=False)
    k = math.cos(down)
    rows, cols = np.mgrid[0:H, 0:W].astype(np.float32)
    src_rows = hy + (rows - hy) / k
    body = map_coordinates(scratch.t, [src_rows, cols], order=1, mode='constant', cval=amb)
    mask = np.clip(np.abs(body - amb) / 0.3, 0, 1)
    c.t = c.t * (1 - mask) + body * mask


def warm_seat(x, z):
    cx, cy, zc = canvas(x, 0.45, z)
    synth.contact_heat(c, rng, amb, cx, cy, F_WIDE * SS / zc, parts=('seat',), age=300)


CHAIR = 0.6
SIDE = {'far': (0, CHAIR), 'near': (0, -CHAIR), 'left': (-CHAIR, 0), 'right': (CHAIR, 0)}
FOUR = ('far', 'near', 'left', 'right')
# Eight tables, like the dashboard's demo. Far row first, so nearer things
# are painted over farther ones.
TABLES = {
    6: {'at': (-2.8, 7.7), 'chairs': FOUR, 'who': (), 'state': 'c', 'time': '2 min'},
    7: {'at': (0.0, 7.9), 'chairs': FOUR, 'who': ('far', 'left', 'right'), 'state': 's', 'clock': '9:33'},
    8: {'at': (2.8, 7.7), 'chairs': FOUR, 'who': (), 'state': 'f', 'time': '31 min'},
    3: {'at': (-2.0, 5.3), 'chairs': FOUR, 'who': ('far', 'right'), 'state': 'w', 'clock': '6:12'},
    4: {'at': (0.0, 5.4), 'chairs': FOUR, 'who': (), 'state': 'f', 'time': '3 min'},
    5: {'at': (2.0, 5.3), 'chairs': FOUR, 'who': ('far', 'left'), 'state': 's', 'clock': '21:40'},
    1: {'at': (-1.1, 3.1), 'chairs': FOUR, 'who': (), 'state': 'f', 'time': '14 min'},
    2: {'at': (1.15, 3.1), 'chairs': FOUR, 'who': FOUR, 'state': 's', 'clock': '48:17'},
}
SERVER = (-0.95, 6.55)

for n, tb in TABLES.items():
    tx, tz = tb['at']
    behind = [s for s in tb['who'] if s == 'far']
    front = [s for s in tb['who'] if s != 'far']
    for side in tb['chairs']:
        dx, dz = SIDE[side]
        flat(tx + dx, tz + dz, 0.45, 0.42, 0.42, amb - 0.5)
    if tb['state'] == 'c':
        for side in ('left', 'right'):
            dx, dz = SIDE[side]
            warm_seat(tx + dx, tz + dz)
    for side in behind:
        dx, dz = SIDE[side]
        person_at(tx + dx * 0.85, tz + dz * 0.85, math.atan2(-dz, -dx), 10 * n)
    flat(tx, tz, 0.75, 0.8, 0.8, amb - 0.8)
    if tb['who']:
        disc(tx + 0.12, tz - 0.1, 0.76, 0.05, amb + 24.0)        # a hot drink
    for side in front:
        dx, dz = SIDE[side]
        person_at(tx + dx * 0.85, tz + dz * 0.85, math.atan2(-dz, -dx), 10 * n + len(side))
    if n == 3:
        person_at(SERVER[0], SERVER[1], -math.pi / 2, 99, standing=True)

# Down to the camera's resolution, then its optics and electronics, as
# synth.scene_full() finishes a frame (fixed amounts, not drawn at random).
frame = c.t.reshape(ROWS, SS, COLS, SS).mean(axis=(1, 3))
frame = gaussian_filter(frame, 0.8)
yy, xx = np.mgrid[0:ROWS, 0:COLS].astype(np.float32)
frame += 0.25 * (((xx - COLS / 2) / (COLS / 2)) ** 2 + ((yy - ROWS / 2) / (ROWS / 2)) ** 2)
frame += rng.normal(0, 0.05, (ROWS, COLS))
for sigma, amount in ((0.8, 0.12), (2.5, 0.2), (8.0, 0.25)):
    n_ = gaussian_filter(rng.normal(0, 1, (ROWS, COLS)).astype(np.float32), sigma)
    frame += n_ / max(float(n_.std()), 1e-6) * amount
frame = np.round(frame * 100) / 100

# Owl, exactly as the box runs it.
model = main.PeopleModel(main.PEOPLE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
if main.PEOPLE_FINE_MODEL_PATH.exists():
    model.fine = main.PeopleModel(main.PEOPLE_FINE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
people, things, count = model.read_crowd(frame.reshape(-1).tolist())
print('Owl found', len(people), 'people at', [(round(x, 1), round(y, 1)) for x, y in people])

# Each table's zone and seats, as the zones file would hold them: a seat is
# where the head of someone in that chair lands.
zone_list = []
for n, tb in TABLES.items():
    tx, tz = tb['at']
    seats = [project(tx + SIDE[s][0] * 0.85, 1.2, tz + SIDE[s][1] * 0.85)[:2] for s in tb['chairs']]
    edge = [project(tx + dx, 0.75, tz + dz)[:2] for dx in (-0.4, 0.4) for dz in (-0.4, 0.4)]
    us = [p[0] for p in seats + edge]
    vs = [p[1] for p in seats + edge]
    pad = 3.0
    zone_list.append({'n': n, 'box': (max(0.0, min(us) - pad), max(0.0, min(vs) - pad),
                                       min(COLS - 0.01, max(us) + pad), min(ROWS - 0.01, max(vs) + pad)),
                      'seats': tuple(seats)})
tracker = main.TableTracker(zone_list)
tracker.update(0.0, people)
at_table = {n: p for n, p, s, a in tracker.view(0.0)}
print('people per table', at_table)
expected = {n: len(tb['who']) for n, tb in TABLES.items()}
print('drawn per table  ', expected)

# White-hot: warmer is brighter, as most heat cameras show it.
SCALE = 10
big = zoom(frame, SCALE, order=3)
lo, hi = amb - 1.5, amb + 12.0
g = (np.clip((big - lo) / (hi - lo), 0, 1) ** 0.85 * 225 + 18).astype(np.uint8)
img = Image.fromarray(np.stack([g, g, g], axis=-1), 'RGB').convert('RGBA')

fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
bold = ImageFont.truetype(str(fonts / 'seguisb.ttf'), 26)
small = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 21)
tiny = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 21)
# The Tables tab's four looks: free green, seated red with its timer, needs
# a server solid amber, needs clearing pale yellow with a dashed edge.
COLOR = {'f': (34, 197, 94), 's': (239, 68, 68), 'w': (245, 158, 11), 'c': (253, 230, 138)}
WORDS = {'f': 'Free', 's': 'Seated', 'w': 'Needs a server', 'c': 'Needs clearing'}


def dashed_poly(draw, pts, color, width, dash=18, gap=12):
    for i in range(len(pts)):
        (ax, ay), (bx_, by_) = pts[i], pts[(i + 1) % len(pts)]
        length = math.hypot(bx_ - ax, by_ - ay)
        pos = 0.0
        while pos < length:
            end = min(length, pos + dash)
            draw.line([(ax + (bx_ - ax) * pos / length, ay + (by_ - ay) * pos / length),
                       (ax + (bx_ - ax) * end / length, ay + (by_ - ay) * end / length)],
                      fill=color, width=width)
            pos = end + gap


def footprint(n):
    """The floor a table and its chairs take up, as the camera sees it."""
    tx, tz = TABLES[n]['at']
    r = CHAIR + 0.3
    return [tuple(v * SCALE for v in project(tx + dx, 0.0, tz + dz)[:2])
            for dx, dz in ((-r, -r), (r, -r), (r, r), (-r, r))]


over = Image.new('RGBA', img.size, (0, 0, 0, 0))
d = ImageDraw.Draw(over)
for n, tb in TABLES.items():
    d.polygon(footprint(n), fill=COLOR[tb['state']] + (60 if tb['state'] == 'w' else 42,))
img = Image.alpha_composite(img, over)
over = Image.new('RGBA', img.size, (0, 0, 0, 0))
d = ImageDraw.Draw(over)
for n, tb in TABLES.items():
    pts = footprint(n)
    col = COLOR[tb['state']]
    if tb['state'] == 'c':
        dashed_poly(d, pts, col + (255,), 5)
    else:
        d.polygon(pts, outline=col + (255,), width=6 if tb['state'] == 'w' else 4)
dots = []
for x, y in people:
    cx, cy = x * SCALE, y * SCALE
    dots.append((cx, cy))
    d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(255, 255, 255, 255), outline=(15, 23, 42, 255), width=4)
img = Image.alpha_composite(img, over)

d = ImageDraw.Draw(img)
lines = ['Made from generated heat, no real people.', 'White dots are the people Owl found.']
nw = max(d.textlength(t_, font=tiny) for t_ in lines)
note = (img.width / 2 - (nw + 28) / 2, img.height - 80, img.width / 2 + (nw + 28) / 2, img.height - 12)
placed = [note]


def clear(box):
    bx0, by0, bx1, by1 = box
    if bx0 < 6 or by0 < 6 or bx1 > img.width - 6 or by1 > img.height - 6:
        return False
    for cx, cy in dots:
        if bx0 - 14 <= cx <= bx1 + 14 and by0 - 14 <= cy <= by1 + 14:
            return False
    for px0, py0, px1, py1 in placed:
        if bx0 < px1 + 6 and px0 < bx1 + 6 and by0 < py1 + 6 and py0 < by1 + 6:
            return False
    return True


for n in sorted(TABLES):
    tb = TABLES[n]
    state = tb['state']
    col = COLOR[state]
    here = at_table[n]
    people_txt = f"{here} {'person' if here == 1 else 'people'}"
    head = f"Table {n}  {WORDS[state]}" + (f"  {tb['clock']}" if state in ('s', 'w') else '')
    if state == 'f':
        sub = f"Free for {tb['time']}"
    elif state == 's':
        sub = people_txt
    elif state == 'w':
        sub = f"{people_txt}, nobody by yet"
    else:
        sub = f"Waiting to be cleared {tb['time']}"
    w = max(d.textlength(head, font=bold) + 32, d.textlength(sub, font=small) + 32)
    h = 70
    pts = footprint(n)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    mid = (min(xs) + max(xs)) / 2
    spots = [(mid - w / 2, max(ys) + 6), (mid - w / 2, min(ys) - h - 6), (min(xs) - w - 6, min(ys)),
             (max(xs) + 6, min(ys)), (mid - w / 2, max(ys) + 6 + h), (mid - w / 2, min(ys) - 2 * h - 6)]
    box = None
    for bx, by in spots:
        bx = min(max(8, bx), img.width - w - 8)
        if clear((bx, by, bx + w, by + h)):
            box = (bx, by, bx + w, by + h)
            break
    if box is None:
        raise SystemExit(f'no room for the label of table {n}')
    placed.append(box)
    bx, by = box[0], box[1]
    if state == 'w':
        d.rounded_rectangle(box, radius=10, fill=col + (255,), outline=(124, 45, 18, 255), width=3)
        ink, sub_ink = (28, 25, 23, 255), (41, 37, 36, 255)
    else:
        d.rounded_rectangle(box, radius=10, fill=(15, 23, 42, 236))
        if state == 'c':
            dashed_poly(d, [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])],
                        col + (255,), 3, dash=12, gap=8)
        else:
            d.rounded_rectangle(box, radius=10, outline=col + (255,), width=3)
        ink, sub_ink = (255, 255, 255, 255), (203, 213, 225, 255)
    d.text((bx + 16, by + 6), head, font=bold, fill=ink)
    d.text((bx + 16, by + 39), sub, font=small, fill=sub_ink)

d.rounded_rectangle(note, radius=10, fill=(15, 23, 42, 225))
for i, t_ in enumerate(lines):
    d.text((note[0] + 14, note[1] + 6 + i * 29), t_, font=tiny, fill=(226, 232, 240, 255))

OUT.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(OUT, optimize=True)
print('wrote', OUT, img.size)
