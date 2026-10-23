"""The figure for one generated evening: a frame from it, the seats and tables
the box learned (TableLearner) over it, and where the seats really are.

Run with the flux-training venv, from flock-sensor:
  python training/table_learning_figure.py . <out.png> [seed] [minutes]
"""
import math
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import zoom

OUT = Path(sys.argv[2])
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 1
MINUTES = sys.argv[4] if len(sys.argv) > 4 else '240'
sys.argv = [sys.argv[0], sys.argv[1], '1', MINUTES, '10']
sys.path.insert(0, str(Path(sys.argv[1]) / 'training'))
import table_learning_eval as E  # noqa: E402

model = E.main.PeopleModel(E.main.PEOPLE_MODEL_PATH, E.main.THERMAL_MODEL_THRESHOLD)
if E.main.PEOPLE_FINE_MODEL_PATH.exists():
    model.fine = E.main.PeopleModel(E.main.PEOPLE_FINE_MODEL_PATH, E.main.THERMAL_MODEL_THRESHOLD)
learner, parties, frames, secs, exact, total = E.run(SEED, model)
learned = learner.tables()
print('learned', len(learned), 'tables;', E.score(learner, parties))

# A frame from the busiest moment of the evening, for the background.
rng = np.random.default_rng(SEED)
room = E.Room(SEED)
busiest = max(range(0, int(E.MINUTES) * 60, 60),
              key=lambda t: sum(len(s) for n, s, a, b in parties if a <= t < b))
people = []
for i, (n, sides, a, b) in enumerate(parties):
    if a <= busiest < b:
        for side in sides:
            x, z = E.seat_xz(n, side)
            dx, dz = E.SIDE[side]
            people.append(room.person((SEED * 1000 + i) * 10 + E.FOUR.index(side), x, z, math.atan2(-dz, -dx)))
frame = room.frame(people, rng)
points, _, _ = model.read_crowd(frame.reshape(-1).tolist())

SCALE = 10
big = zoom(frame, SCALE, order=3)
lo, hi = room.amb - 1.5, room.amb + 12.0
g = (np.clip((big - lo) / (hi - lo), 0, 1) ** 0.85 * 225 + 18).astype(np.uint8)
img = Image.fromarray(np.stack([g, g, g], axis=-1), 'RGB').convert('RGBA')
fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
font = ImageFont.truetype(str(fonts / 'seguisb.ttf'), 26)
small = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 22)

over = Image.new('RGBA', img.size, (0, 0, 0, 0))
d = ImageDraw.Draw(over)
for k, t in enumerate(learned):
    x0, y0, x1, y1 = (v * SCALE for v in t['box'])
    d.rectangle([x0, y0, x1, y1], outline=(56, 189, 248, 255), width=5)
    d.text((x0 + 6, y0 + 2), f'{k + 1}', font=font, fill=(56, 189, 248, 255))
    for x, y in t['seats']:
        d.ellipse([x * SCALE - 9, y * SCALE - 9, x * SCALE + 9, y * SCALE + 9],
                  outline=(56, 189, 248, 255), width=4)
for z in E.truth_zones():
    for x, y in z['seats']:
        d.line([x * SCALE - 7, y * SCALE - 7, x * SCALE + 7, y * SCALE + 7], fill=(250, 204, 21, 255), width=3)
        d.line([x * SCALE - 7, y * SCALE + 7, x * SCALE + 7, y * SCALE - 7], fill=(250, 204, 21, 255), width=3)
for x, y in points:
    d.ellipse([x * SCALE - 6, y * SCALE - 6, x * SCALE + 6, y * SCALE + 6], fill=(255, 255, 255, 255))
img = Image.alpha_composite(img, over)
d = ImageDraw.Draw(img)
key = [((56, 189, 248), 'learned table and its seats'), ((250, 204, 21), 'real seat (x)'),
       ((255, 255, 255), 'person Owl found in this frame')]
y = img.height - 34 * len(key) - 16
d.rectangle([12, y - 8, 470, img.height - 10], fill=(15, 23, 42, 220))
for col, text in key:
    d.rectangle([24, y + 6, 44, y + 22], fill=col + (255,))
    d.text((56, y), text, font=small, fill=(226, 232, 240, 255))
    y += 34
OUT.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(OUT, optimize=True)
print('wrote', OUT)
