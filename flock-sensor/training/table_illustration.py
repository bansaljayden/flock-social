"""What Flux sees at the tables, from the ceiling: one generated thermal
frame (no real person), looking straight down through the wide 95 degree
lens at four tables, with Owl's people found in it and each table's zone,
seats and state drawn on by the box's own TableTracker.

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
from scipy.ndimage import gaussian_filter, zoom

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
HFOV = 95.0                                   # the Lepton 3.1R
F_WIDE = (COLS / 2) / math.tan(math.radians(HFOV / 2))
CEILING = 3.0
rng = np.random.default_rng(7)
amb = 22.5


def project(x, y, h):
    """Floor position (x across, y into the room) at height h, seen straight
    down from the ceiling: frame pixels, and metres from the lens."""
    dz = CEILING - h
    return COLS / 2 + F_WIDE * x / dz, ROWS / 2 - F_WIDE * y / dz, dz


def canvas(x, y, h):
    u, v, dz = project(x, y, h)
    return u * SS, v * SS, dz


def px_per_m(dz):
    """Canvas pixels per metre at dz metres from the lens."""
    return F_WIDE * SS / dz


H, W = ROWS * SS, COLS * SS
t = np.full((H, W), amb - 0.3, dtype=np.float32)
low = gaussian_filter(rng.normal(0, 1, (H // 8, W // 8)).astype(np.float32), 2)
t += np.kron(low, np.ones((8, 8), dtype=np.float32)) * 0.3
c = synth.Canvas(t)


def rect_at(x, y, h, w, d, temp):
    cx, cy, dz = canvas(x, y, h)
    s = px_per_m(dz)
    c.paint(synth.rect(cx, cy, w * s, d * s, corner=0.03 * s), temp)


def disc_at(x, y, h, r, temp):
    cx, cy, dz = canvas(x, y, h)
    s = px_per_m(dz)
    c.paint(synth.ellipse(cx, cy, r * s, r * s), temp)


class _Facing:
    """The generator's random numbers, except the one that turns a person
    seen from above: that is set, so shoulders run along the table's edge."""

    def __init__(self, rng, angle):
        self._rng, self._angle = rng, angle

    def uniform(self, low=0.0, high=1.0, size=None):
        if size is None and low == 0 and high == math.pi:
            return self._angle
        return self._rng.uniform(low, high, size)

    def __getattr__(self, name):
        return getattr(self._rng, name)


def diner(x, y, facing, pid, standing=False):
    """Someone seen from above, drawn by synth as Owl learned people under a
    ceiling camera: shoulders round a head, at the right size for this lens,
    turned to face `facing` (radians, 0 = +x, in room axes)."""
    h = 1.65 if standing else 1.2
    cx, cy, dz = canvas(x, y, h)
    # Canvas y runs down the image, so a facing in room axes flips; the
    # shoulders run across it.
    shoulders = (-facing + math.pi / 2) % math.pi
    # synth sizes a person with the 57 deg lens's focal length; give it the
    # distance that makes the size right for the 95 deg one.
    synth.person(c, _Facing(rng, shoulders), amb, dz * synth.F_PX / F_WIDE, cx, cy, pid,
                 overhead=True, child=False, shirtless=False, coat=False)


def warm_seat(x, y):
    cx, cy, dz = canvas(x, y, 0.45)
    synth.contact_heat(c, rng, amb, cx, cy, px_per_m(dz), parts=('seat',), age=300)


CHAIR = 0.6
SIDE = {'n': (0, CHAIR), 's': (0, -CHAIR), 'w': (-CHAIR, 0), 'e': (CHAIR, 0)}
TABLES = {
    1: {'at': (-1.1, 0.6), 'size': (0.8, 0.8), 'chairs': 'nswe', 'state': 's',
        'label': 'Seated', 'clock': '18:04', 'who': 'nswe'},
    2: {'at': (1.1, 0.6), 'size': (0.8, 0.8), 'chairs': 'nswe', 'state': 'w',
        'label': 'Needs a server', 'clock': '7:12', 'who': 'we'},
    3: {'at': (-1.25, -0.95), 'size': (0.7, 0.6), 'chairs': 'we', 'state': 'c',
        'label': 'Needs clearing', 'time': '3 min', 'who': ''},
    4: {'at': (1.25, -0.95), 'size': (0.7, 0.6), 'chairs': 'we', 'state': 'f',
        'label': 'Free', 'time': '25 min', 'who': ''},
}
SERVER = (0.0, -0.65)

# Chairs and tables first (a little cooler than the air, as furniture often
# reads), then what is on them, then people.
for n, tb in TABLES.items():
    tx, ty = tb['at']
    for side in tb['chairs']:
        dx, dy = SIDE[side]
        rect_at(tx + dx, ty + dy, 0.45, 0.42, 0.42, amb - 0.5)
    rect_at(tx, ty, 0.75, tb['size'][0], tb['size'][1], amb - 0.8)

# Table 1: four people with hot drinks.
tx, ty = TABLES[1]['at']
disc_at(tx - 0.12, ty + 0.12, 0.76, 0.04, amb + 25.0)
disc_at(tx + 0.14, ty - 0.1, 0.76, 0.04, amb + 22.0)
# Table 2: two people, nothing on the table yet.
# Table 3: they have gone. Their seats are still a little warm.
tx, ty = TABLES[3]['at']
for side in 'we':
    dx, dy = SIDE[side]
    warm_seat(tx + dx, ty + dy)

for n, tb in TABLES.items():
    tx, ty = tb['at']
    for side in tb['who']:
        dx, dy = SIDE[side]
        # Seated, the head is a little in from the chair, toward the table.
        diner(tx + dx * 0.85, ty + dy * 0.85, math.atan2(-dy, -dx), 10 * n + 'nswe'.index(side))
diner(*SERVER, math.pi / 2, 99, standing=True)

# Down to the camera's resolution, then its optics and electronics, as
# synth.scene_full() finishes a frame (fixed amounts, not drawn at random).
frame = c.t.reshape(ROWS, SS, COLS, SS).mean(axis=(1, 3))
frame = gaussian_filter(frame, 0.8)
yy, xx = np.mgrid[0:ROWS, 0:COLS].astype(np.float32)
frame += 0.25 * (((xx - COLS / 2) / (COLS / 2)) ** 2 + ((yy - ROWS / 2) / (ROWS / 2)) ** 2)
frame += rng.normal(0, 0.05, (ROWS, COLS))
for sigma, amount in ((0.8, 0.12), (2.5, 0.2), (8.0, 0.25)):
    n = gaussian_filter(rng.normal(0, 1, (ROWS, COLS)).astype(np.float32), sigma)
    frame += n / max(float(n.std()), 1e-6) * amount
frame = np.round(frame * 100) / 100

# Owl, exactly as the box runs it.
model = main.PeopleModel(main.PEOPLE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
if main.PEOPLE_FINE_MODEL_PATH.exists():
    model.fine = main.PeopleModel(main.PEOPLE_FINE_MODEL_PATH, main.THERMAL_MODEL_THRESHOLD)
people, things, count = model.read_crowd(frame.reshape(-1).tolist())
print('Owl found', len(people), 'people at', [(round(x, 1), round(y, 1)) for x, y in people])

# Each table's zone and seats, as the zones file would hold them.
zone_list = []
for n, tb in TABLES.items():
    tx, ty = tb['at']
    seats = [project(tx + SIDE[s][0] * 0.85, ty + SIDE[s][1] * 0.85, 1.2)[:2] for s in tb['chairs']]
    w, dd = tb['size']
    edge = [project(tx + dx, ty + dy, 0.75)[:2] for dx in (-w / 2, w / 2) for dy in (-dd / 2, dd / 2)]
    us = [p[0] for p in seats + edge]
    vs = [p[1] for p in seats + edge]
    pad = 6.0
    zone_list.append({'n': n, 'box': (max(0.0, min(us) - pad), max(0.0, min(vs) - pad),
                                       min(COLS - 0.01, max(us) + pad), min(ROWS - 0.01, max(vs) + pad)),
                      'seats': tuple(seats)})
zones = {z['n']: z['box'] for z in zone_list}

# The box's own code decides which table each person is at.
tracker = main.TableTracker(zone_list)
tracker.update(0.0, people)
at_table = {n: p for n, p, s, a in tracker.view(0.0)}
print('people per table', at_table)
su, sv, _ = project(SERVER[0], SERVER[1], 1.65)
assert not any(x0 <= su < x1 and y0 <= sv < y1 for x0, y0, x1, y1 in zones.values()), 'server inside a zone'

# A black-to-white heat palette through red and orange, then up to 1600 x 1200.
SCALE = 10
big = zoom(frame, SCALE, order=3)
lo, hi = amb - 1.5, amb + 13.0
k = np.clip((big - lo) / (hi - lo), 0, 1)
stops = np.array([[0.00, 10, 8, 8], [0.22, 58, 14, 12], [0.42, 140, 28, 18], [0.60, 214, 72, 22],
                  [0.76, 245, 140, 30], [0.90, 252, 212, 92], [1.00, 255, 250, 232]], dtype=np.float32)
rgb = np.stack([np.interp(k, stops[:, 0], stops[:, i]) for i in (1, 2, 3)], axis=-1).astype(np.uint8)
img = Image.fromarray(rgb, 'RGB').convert('RGBA')

fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
bold = ImageFont.truetype(str(fonts / 'seguisb.ttf'), 30)
small = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 24)
tiny = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 22)
# The Tables tab's four looks, so the picture and the dashboard read as one
# system: free green, seated red with its timer, needs a server solid amber,
# needs clearing pale yellow with a dashed edge.
COLOR = {'f': (34, 197, 94), 's': (239, 68, 68), 'w': (245, 158, 11), 'c': (253, 230, 138)}
WORDS = {'f': 'Free', 's': 'Seated', 'w': 'Needs a server', 'c': 'Needs clearing'}


def dashed(draw, box, color, width, dash=22, gap=14):
    x0, y0, x1, y1 = box
    for (ax, ay), (bx_, by_) in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)),
                                 ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        length = math.hypot(bx_ - ax, by_ - ay)
        pos = 0.0
        while pos < length:
            end = min(length, pos + dash)
            draw.line([(ax + (bx_ - ax) * pos / length, ay + (by_ - ay) * pos / length),
                       (ax + (bx_ - ax) * end / length, ay + (by_ - ay) * end / length)],
                      fill=color, width=width)
            pos = end + gap


over = Image.new('RGBA', img.size, (0, 0, 0, 0))
d = ImageDraw.Draw(over)
for n, (x0, y0, x1, y1) in zones.items():
    state = TABLES[n]['state']
    col = COLOR[state]
    box = [x0 * SCALE, y0 * SCALE, x1 * SCALE, y1 * SCALE]
    d.rounded_rectangle(box, radius=18, fill=col + (46 if state == 'w' else 30,))
    if state == 'c':
        dashed(d, box, col + (255,), 5)
    else:
        d.rounded_rectangle(box, radius=18, outline=col + (255,), width=7 if state == 'w' else 5)
img = Image.alpha_composite(img, over)
over = Image.new('RGBA', img.size, (0, 0, 0, 0))
d = ImageDraw.Draw(over)
# The tables, outlined. Heat barely shows a table; the box knows where each
# one is from its zones file.
for n, tb in TABLES.items():
    tx, ty = tb['at']
    w, dd = tb['size']
    a = project(tx - w / 2, ty + dd / 2, 0.75)
    b = project(tx + w / 2, ty - dd / 2, 0.75)
    d.rounded_rectangle([a[0] * SCALE, a[1] * SCALE, b[0] * SCALE, b[1] * SCALE], radius=10,
                        outline=(255, 255, 255, 190), width=4)
dots = []
for x, y in people:
    cx, cy = x * SCALE, y * SCALE
    dots.append((cx, cy))
    d.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], fill=(255, 255, 255, 255), outline=(15, 23, 42, 255), width=4)
img = Image.alpha_composite(img, over)

d = ImageDraw.Draw(img)
big_font = ImageFont.truetype(str(fonts / 'seguisb.ttf'), 30)
for n in sorted(zones):
    x0, y0, x1, y1 = (v * SCALE for v in zones[n])
    tb = TABLES[n]
    state = tb['state']
    col = COLOR[state]
    here = at_table[n]
    people_txt = f"{here} {'person' if here == 1 else 'people'}"
    head = f"Table {n}  {WORDS[state]}"
    if state in ('s', 'w'):
        head += f"  {tb['clock']}"
    if state == 'f':
        sub = f"Free for {tb['time']}"
    elif state == 's':
        sub = people_txt
    elif state == 'w':
        sub = f"{people_txt}, nobody has stopped by yet"
    else:
        sub = f"Waiting to be cleared {tb['time']}"
    w = max(d.textlength(head, font=big_font) + 40, d.textlength(sub, font=small) + 34)
    h = 84
    bx = min(max(8, (x0 + x1) / 2 - w / 2), img.width - w - 8)
    by = y0 - h - 10 if n in (1, 2) else y1 + 10
    box = [bx, by, bx + w, by + h]
    if state == 'w':
        # Solid amber, as the card is: it is the one asking for someone.
        d.rounded_rectangle(box, radius=12, fill=col + (255,), outline=(124, 45, 18, 255), width=3)
        ink, sub_ink = (28, 25, 23, 255), (41, 37, 36, 255)
    else:
        d.rounded_rectangle(box, radius=12, fill=(15, 23, 42, 236))
        if state == 'c':
            dashed(d, box, col + (255,), 3, dash=14, gap=9)
        else:
            d.rounded_rectangle(box, radius=12, outline=col + (255,), width=3)
        ink, sub_ink = (255, 255, 255, 255), (203, 213, 225, 255)
    d.text((bx + 18, by + 8), head, font=big_font, fill=ink)
    d.text((bx + 18, by + 48), sub, font=small, fill=sub_ink)

lines = ['Made from generated heat, no real people.', 'White dots are the people Owl found.']
nw = max(d.textlength(t_, font=tiny) for t_ in lines)
nx = img.width / 2 - (nw + 28) / 2
d.rounded_rectangle([nx, img.height - 84, nx + nw + 28, img.height - 14], radius=10, fill=(15, 23, 42, 220))
for i, t_ in enumerate(lines):
    d.text((nx + 14, img.height - 79 + i * 30), t_, font=tiny, fill=(226, 232, 240, 255))

OUT.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(OUT, optimize=True)
print('wrote', OUT, img.size)
