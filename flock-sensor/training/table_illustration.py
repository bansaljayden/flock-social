"""What Flux sees at the tables: one generated thermal frame (no real person),
Owl's people found in it, and each table's zone and state drawn on.

Run with the flux-training venv:
  python training/table_illustration.py . <out.png>   (from flock-sensor)
"""
import math
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter, zoom

SENSOR = Path(sys.argv[1])
OUT = Path(sys.argv[2])
sys.path.insert(0, str(SENSOR / 'training'))
import synth  # noqa: E402

tmp = tempfile.mkdtemp(prefix='flux-sees-')
for k, v in (('FLOCK_CONFIG', 'c.env'), ('FLOCK_LOG', 's.log'), ('FLOCK_BUFFER', 'b.json'),
             ('FLOCK_TABLES', 't.json')):
    os.environ[k] = str(Path(tmp) / v)
sys.path.insert(0, str(SENSOR))
import main  # noqa: E402

COLS, ROWS, SS, F_PX = synth.COLS, synth.ROWS, synth.SS, synth.F_PX
CAM_H, PITCH = 3.0, math.radians(30.0)    # on the ceiling above the door, 30 deg down
rng = np.random.default_rng(23)
amb = 22.5


def project(x, h, z):
    """World (x across, h up, z out into the room) to frame pixels and depth."""
    dy = h - CAM_H
    yc = dy * math.cos(PITCH) + z * math.sin(PITCH)
    zc = -dy * math.sin(PITCH) + z * math.cos(PITCH)
    return COLS / 2 + F_PX * x / zc, ROWS / 2 - F_PX * yc / zc, zc


def canvas_xy(x, h, z):
    u, v, zc = project(x, h, z)
    return u * SS, v * SS, zc


# The room: near the air's temperature, a little floor/wall difference and
# slow blotches, the way synth.room() builds one, at a restaurant's 22.5C.
H, W = ROWS * SS, COLS * SS
t = np.full((H, W), amb, dtype=np.float32)
horizon = project(0, 0.0, 13.0)[1] * SS
yy = np.arange(H, dtype=np.float32)[:, None]
t += np.where(yy > horizon, -0.4, 0.3)
low = gaussian_filter(rng.normal(0, 1, (H // 8, W // 8)).astype(np.float32), 2)
t += np.kron(low, np.ones((8, 8), dtype=np.float32)) * 0.35
c = synth.Canvas(t)


def polygon_shape(points):
    """A filled polygon as synth's (x0, y0, mask) shape, canvas pixels."""
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


def table_top(tx, tz, half=0.4, temp=None):
    corners = [canvas_xy(tx + dx, 0.75, tz + dz)[:2]
               for dx, dz in ((-half, -half), (half, -half), (half, half), (-half, half))]
    c.paint(polygon_shape(corners), amb + 0.25 if temp is None else temp)


def seated(tx, tz, side, pid, view):
    """A diner on one side of a table: 'far' faces the camera, 'near' has
    their back to it, 'left'/'right' sit at the ends."""
    off = {'far': (0, 0.62), 'near': (0, -0.62), 'left': (-0.62, 0), 'right': (0.62, 0)}[side]
    hx, hy, zc = canvas_xy(tx + off[0], 1.2, tz + off[1])
    synth.person(c, rng, amb, zc, hx, hy, pid, view=view, pose='sit',
                 child=False, shirtless=False, coat=False)


def plate(tx, tz, dx, dz, temp, r=0.12):
    cx, cy, zc = canvas_xy(tx + dx, 0.76, tz + dz)
    s = F_PX * SS / zc
    _, v_top, _ = canvas_xy(tx + dx, 0.76, tz + dz + r)
    _, v_bot, _ = canvas_xy(tx + dx, 0.76, tz + dz - r)
    c.paint(synth.ellipse(cx, cy, r * s, max(1.0, abs(v_bot - v_top) / 2)), temp)


def warm_seat(tx, tz, side):
    off = {'left': (-0.62, 0), 'right': (0.62, 0), 'far': (0, 0.62), 'near': (0, -0.62)}[side]
    cx, cy, zc = canvas_xy(tx + off[0], 0.45, tz + off[1])
    synth.contact_heat(c, rng, amb, cx, cy, F_PX * SS / zc, parts=('seat',), age=420)


# Six tables in three rows, staggered the way a dining room is, so a table
# behind sits between two in front. Far row first, so nearer things are
# painted over farther ones.
TABLES = {
    1: {'at': (-2.7, 7.6), 'state': 'c', 'label': 'Needs clearing', 'time': '3 min', 'row': 'far'},
    2: {'at': (0.0, 7.8), 'state': 'f', 'label': 'Free', 'time': '25 min', 'row': 'far'},
    3: {'at': (2.7, 7.6), 'state': 's', 'label': 'Seated', 'time': '41 min', 'row': 'far'},
    4: {'at': (-1.55, 4.6), 'state': 's', 'label': 'Seated', 'time': '12 min', 'row': 'mid'},
    5: {'at': (1.55, 4.7), 'state': 'w', 'label': 'Waiting', 'time': '7 min', 'row': 'mid', 'place': 'left'},
    6: {'at': (1.0, 2.7), 'state': 'f', 'label': 'Free', 'time': '6 min', 'row': 'near'},
}
SERVER = (0.0, 3.3)

# Table 1: the party has gone. Seats a little warm still, plates near the
# room's temperature.
tx, tz = TABLES[1]['at']
warm_seat(tx, tz, 'left')
warm_seat(tx, tz, 'right')
table_top(tx, tz)
plate(tx, tz, -0.18, -0.05, amb + 2.5)
plate(tx, tz, 0.20, 0.08, amb + 2.0)

# Table 2: nobody, nothing.
table_top(*TABLES[2]['at'])

# Table 3: four people, a long dinner.
tx, tz = TABLES[3]['at']
seated(tx, tz, 'far', 30, 'front')
seated(tx, tz, 'left', 31, 'side')
seated(tx, tz, 'right', 32, 'side')
table_top(tx, tz)
seated(tx, tz, 'near', 33, 'back')

# Table 4: two people, one each side, a hot drink between them.
tx, tz = TABLES[4]['at']
seated(tx, tz, 'left', 40, 'side')
seated(tx, tz, 'right', 41, 'side')
table_top(tx, tz)
plate(tx, tz, 0.05, 0.05, amb + 20.0, r=0.045)

# Table 5: three people, seated a while, nobody has been over.
tx, tz = TABLES[5]['at']
seated(tx, tz, 'far', 50, 'front')
seated(tx, tz, 'left', 51, 'side')
table_top(tx, tz)
seated(tx, tz, 'near', 52, 'back')

# A server crossing between the tables, standing, at none of them.
hx, hy, zc = canvas_xy(SERVER[0], 1.65, SERVER[1])
synth.person(c, rng, amb, zc, hx, hy, 60, view='side', pose='stand',
             child=False, shirtless=False, coat=False)

# Table 6: free, nearest the door.
table_top(*TABLES[6]['at'])

# Down to the camera's resolution, then its optics and electronics, as
# synth.scene_full() finishes a frame (fixed amounts, not drawn at random).
frame = c.t.reshape(ROWS, SS, COLS, SS).mean(axis=(1, 3))
frame = gaussian_filter(frame, 0.8)
yy, xx = np.mgrid[0:ROWS, 0:COLS].astype(np.float32)
frame += 0.25 * (((xx - COLS / 2) / (COLS / 2)) ** 2 + ((yy - ROWS / 2) / (ROWS / 2)) ** 2)
frame += rng.normal(0, 0.05, (ROWS, COLS))
for sigma, amount in ((0.8, 0.15), (2.5, 0.25), (8.0, 0.3)):
    n = gaussian_filter(rng.normal(0, 1, (ROWS, COLS)).astype(np.float32), sigma)
    frame += n / max(float(n.std()), 1e-6) * amount
frame = np.round(frame * 100) / 100

# Owl, exactly as the box runs it.
model = main.PeopleModel(main.PEOPLE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
if main.PEOPLE_FINE_MODEL_PATH.exists():
    model.fine = main.PeopleModel(main.PEOPLE_FINE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
people, things, count = model.read_crowd(frame.reshape(-1).tolist())
print('Owl found', count, 'people at', [(round(x, 1), round(y, 1)) for x, y in people])

# Each table's zone and seats, as the zones file would hold them: a seat is
# where the head of someone in that chair lands; the zone is the table and
# its seated heads.
SIDES = {'far': (0, 0.62), 'near': (0, -0.62), 'left': (-0.62, 0), 'right': (0.62, 0)}
zone_list = []
for n, tb in TABLES.items():
    tx, tz = tb['at']
    seats = [project(tx + dx, 1.2, tz + dz)[:2] for dx, dz in SIDES.values()]
    top = [project(tx + dx, 0.75, tz + dz)[:2] for dx in (-0.4, 0.4) for dz in (-0.4, 0.4)]
    us = [p[0] for p in seats + top]
    vs = [p[1] for p in seats + top]
    pad = 2.5
    zone_list.append({'n': n, 'box': (max(0.0, min(us) - pad), max(0.0, min(vs) - pad),
                                       min(COLS - 0.01, max(us) + pad), min(ROWS - 0.01, max(vs) + pad)),
                      'seats': tuple(seats)})
zones = {z['n']: z['box'] for z in zone_list}

# The box's own code decides which table each person is at.
tracker = main.TableTracker(zone_list)
tracker.update(0.0, people)
at_table = {n: p for n, p, s, a in tracker.view(0.0)}
print('people per table', at_table)
su, sv, _ = project(SERVER[0], 1.65, SERVER[1])
assert not any(x0 <= su < x1 and y0 <= sv < y1 for x0, y0, x1, y1 in zones.values()), 'server inside a zone'

# A black-to-white heat palette through red and orange (no blue or purple),
# then up to 1600 x 1200.
SCALE = 10
big = zoom(frame, SCALE, order=3)
lo, hi = amb - 1.0, amb + 13.0
k = np.clip((big - lo) / (hi - lo), 0, 1)
stops = np.array([[0.00, 10, 8, 8], [0.22, 58, 14, 12], [0.42, 140, 28, 18], [0.60, 214, 72, 22],
                  [0.76, 245, 140, 30], [0.90, 252, 212, 92], [1.00, 255, 250, 232]], dtype=np.float32)
rgb = np.stack([np.interp(k, stops[:, 0], stops[:, i]) for i in (1, 2, 3)], axis=-1).astype(np.uint8)
img = Image.fromarray(rgb, 'RGB').convert('RGBA')

fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
bold = ImageFont.truetype(str(fonts / 'seguisb.ttf'), 28)
small = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 23)
tiny = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 22)
COLOR = {'f': (34, 197, 94), 's': (239, 68, 68), 'w': (249, 115, 22), 'c': (234, 179, 8)}

over = Image.new('RGBA', img.size, (0, 0, 0, 0))
d = ImageDraw.Draw(over)
# The tables themselves, faintly: heat cannot see a table, so this is only
# to show where they stand.
for n, tb in TABLES.items():
    tx, tz = tb['at']
    corners = [project(tx + dx, 0.75, tz + dz)[:2] for dx, dz in ((-0.4, -0.4), (0.4, -0.4), (0.4, 0.4), (-0.4, 0.4))]
    d.polygon([(u * SCALE, v * SCALE) for u, v in corners], outline=(255, 255, 255, 90), width=2)
for n, (x0, y0, x1, y1) in zones.items():
    col = COLOR[TABLES[n]['state']]
    d.rounded_rectangle([x0 * SCALE, y0 * SCALE, x1 * SCALE, y1 * SCALE], radius=12,
                        fill=col + (34,), outline=col + (255,), width=4)
dots = []
for x, y in people:
    cx, cy = x * SCALE, y * SCALE
    dots.append((cx, cy))
    d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=(255, 255, 255, 255), outline=(15, 23, 42, 255), width=4)
img = Image.alpha_composite(img, over)

d = ImageDraw.Draw(img)
placed = []


def clear(box):
    bx0, by0, bx1, by1 = box
    if bx0 < 6 or by0 < 6 or bx1 > img.width - 6 or by1 > img.height - 70:
        return False
    for cx, cy in dots:
        if bx0 - 16 <= cx <= bx1 + 16 and by0 - 16 <= cy <= by1 + 16:
            return False
    for px0, py0, px1, py1 in placed:
        if bx0 < px1 + 8 and px0 < bx1 + 8 and by0 < py1 + 8 and py0 < by1 + 8:
            return False
    return True


for n in sorted(zones):
    x0, y0, x1, y1 = (v * SCALE for v in zones[n])
    tb = TABLES[n]
    col = COLOR[tb['state']]
    here = at_table[n]
    head = f"Table {n}  {tb['label']}"
    sub = {'f': f"empty for {tb['time']}",
           's': f"{here} {'person' if here == 1 else 'people'} for {tb['time']}",
           'w': f"{here} people for {tb['time']}, no one has come over",
           'c': f"party left {tb['time']} ago"}[tb['state']]
    w = max(d.textlength(head, font=bold) + 54, d.textlength(sub, font=small) + 34)
    h = 78
    mid = (x0 + x1) / 2
    above, below = (mid - w / 2, y0 - h - 8), (mid - w / 2, y1 + 8)
    inside = [(x1 - w - 10, y1 - h - 10), (x0 + 10, y1 - h - 10), (x0 + 10, y0 + 10), (x1 - w - 10, y0 + 10)]
    first = {'far': [above, below], 'mid': [below, above], 'near': inside}[tb['row']]
    if tb.get('place') == 'left':
        first = [(x0 - w - 10, y0 + 8)] + first
    spots = first + [above, below] + inside + [(x0 - w - 8, y0), (x1 + 8, y0)]
    for bx, by in spots:
        bx = min(max(8, bx), img.width - w - 8)
        box = (bx, by, bx + w, by + h)
        if clear(box):
            break
    placed.append(box)
    bx, by = box[0], box[1]
    d.rounded_rectangle(box, radius=12, fill=(15, 23, 42, 236), outline=col + (255,), width=3)
    d.ellipse([bx + 15, by + 18, bx + 29, by + 32], fill=col + (255,))
    d.text((bx + 37, by + 7), head, font=bold, fill=(255, 255, 255, 255))
    d.text((bx + 16, by + 43), sub, font=small, fill=(203, 213, 225, 255))

note = 'An illustration made from generated heat, with no real people. White dots are the people Owl found.'
nw = d.textlength(note, font=tiny)
d.rounded_rectangle([14, img.height - 54, 14 + nw + 28, img.height - 14], radius=10, fill=(15, 23, 42, 220))
d.text((28, img.height - 49), note, font=tiny, fill=(226, 232, 240, 255))

OUT.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(OUT, optimize=True)
print('wrote', OUT, img.size)
