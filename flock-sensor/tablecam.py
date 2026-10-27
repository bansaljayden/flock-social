"""The table camera: a colour camera that looks only where the heat camera
says nobody is, and only at tables.

Flux sees people with heat alone. This camera exists for three things heat
cannot do: find where the tables are in an empty room, count the chairs at
each, and tell whether a table a party has left still has dishes on it. It
is off unless TABLE_CAMERA=1, and every rule below is enforced here, in
code, and pinned by test_tablecam.py:

1. The heat camera is the gate. A room look happens only when the heat
   camera's latest reading, under GATE_FRESH_S old, has nobody in view at
   all. A table check happens only when nobody is inside that table's zone
   or within TABLE_RING thermal pixels of it. No gate, no picture: the
   shutter stays shut and the camera is never asked for a frame.
2. Crop first. A table check asks the camera for that table's rectangle
   only. A camera that cannot crop at the source hands over its frame and
   the crop is taken before anything else touches it; the rest is dropped.
3. Black out the warm. Every pixel the heat camera reads as warm (WARM_C
   over the room) is painted black in the colour picture before any
   detector sees it, so even someone the gate missed is a black shape.
4. Drop on a person. If the detector still finds a person, the picture is
   dropped, nothing about it is kept, and that table (or the room look)
   waits PERSON_BACKOFF_S before the next try.
5. Nothing is kept. Pictures live in local variables for the length of one
   check and are never written, shown or sent. What comes out is a yes or
   no for dishes, or table outlines and chair counts for the zones file.
6. A shutter covers the lens except during a check, opened by peek() and
   shut in a finally, so it shuts even when the check fails.
"""
import json
import math
import os
import subprocess
import time
from pathlib import Path

import numpy as np

GATE_FRESH_S = 3.0          # the heat reading a look is gated on may be this old
TABLE_RING = 9.0            # thermal pixels around a zone that must be empty too
WARM_C = 2.5                # this much over the room's median is warm: blacked out
PERSON_BACKOFF_S = 120.0    # after a person was found anyway, wait this long
CROP_GROW = 0.15            # a table check's crop, grown by this share each side
SCORE = 0.4                 # detector score that counts
WARM_SHARE_DISHES = 0.02    # this much of a table crop blacked out: something warm is on it
TABLE_CLASSES = ('dining table',)
CHAIR_CLASSES = ('chair',)
DISH_CLASSES = ('cup', 'bowl', 'wine glass', 'bottle', 'fork', 'knife', 'spoon', 'plate')
PERSON_CLASSES = ('person',)
THERMAL_COLS, THERMAL_ROWS = 160, 120


# ---------------------------------------------------------------------------
# Lining the two cameras up (F7)
# ---------------------------------------------------------------------------

class Mapping:
    """Thermal pixels (u, v) to camera pixels (x, y) and back, by a 3 x 3
    homography. factory() is the starting point for two cameras side by side
    and aimed together; fit() refines it from matched points, such as a hot
    mug on a table seen by both."""

    def __init__(self, h):
        self.h = np.asarray(h, dtype=np.float64).reshape(3, 3)
        self.inv = np.linalg.inv(self.h)

    @classmethod
    def factory(cls, cam_w, cam_h, cam_hfov, cam_vfov, th_hfov=57.0, th_vfov=44.3,
                cols=THERMAL_COLS, rows=THERMAL_ROWS):
        """Same aim, lenses side by side: the thermal view sits in the middle
        of the camera's, scaled by the ratio of the lenses' focal lengths."""
        f_th_x = (cols / 2) / math.tan(math.radians(th_hfov / 2))
        f_th_y = (rows / 2) / math.tan(math.radians(th_vfov / 2))
        f_cam_x = (cam_w / 2) / math.tan(math.radians(cam_hfov / 2))
        f_cam_y = (cam_h / 2) / math.tan(math.radians(cam_vfov / 2))
        sx, sy = f_cam_x / f_th_x, f_cam_y / f_th_y
        h = [[sx, 0, cam_w / 2 - sx * cols / 2],
             [0, sy, cam_h / 2 - sy * rows / 2],
             [0, 0, 1]]
        return cls(h)

    @classmethod
    def fit(cls, pairs):
        """Least-squares homography from at least four ((u, v), (x, y))
        pairs, by the direct linear transform."""
        if len(pairs) < 4:
            raise ValueError('need at least four matched points')
        rows = []
        for (u, v), (x, y) in pairs:
            rows.append([-u, -v, -1, 0, 0, 0, u * x, v * x, x])
            rows.append([0, 0, 0, -u, -v, -1, u * y, v * y, y])
        _, _, vt = np.linalg.svd(np.asarray(rows, dtype=np.float64))
        h = vt[-1].reshape(3, 3)
        return cls(h / h[2, 2])

    @staticmethod
    def _apply(m, x, y):
        p = m @ np.array([x, y, 1.0])
        return float(p[0] / p[2]), float(p[1] / p[2])

    def to_camera(self, u, v):
        return self._apply(self.h, u, v)

    def to_thermal(self, x, y):
        return self._apply(self.inv, x, y)

    def box_to_camera(self, box):
        x0, y0, x1, y1 = box
        pts = [self.to_camera(a, b) for a, b in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
        return (min(p[0] for p in pts), min(p[1] for p in pts),
                max(p[0] for p in pts), max(p[1] for p in pts))

    def box_to_thermal(self, box):
        x0, y0, x1, y1 = box
        pts = [self.to_thermal(a, b) for a, b in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
        return (min(p[0] for p in pts), min(p[1] for p in pts),
                max(p[0] for p in pts), max(p[1] for p in pts))

    def to_json(self):
        return {'homography': self.h.tolist()}

    @classmethod
    def from_json(cls, data):
        return cls(data['homography'])


# ---------------------------------------------------------------------------
# The parts that touch hardware, as interfaces
# ---------------------------------------------------------------------------

class Shutter:
    """A flap over the lens. The real one is a spring-closed flap a servo
    opens; the default does nothing and says so."""

    is_open = False

    def open(self):
        self.is_open = True

    def close(self):
        self.is_open = False


class ServoShutter(Shutter):
    """The printed flap: a micro servo (MG90S) on one GPIO turns it open for a
    look and back shut after, then its signal stops, the servo goes slack and
    the flap's spring holds it shut. A servo that loses power or signal leaves
    the lens covered.

    gpio is the RPi.GPIO API (rpi-lgpio on a Pi 5); tests pass a stand-in."""

    HZ = 50

    def __init__(self, pin, gpio=None, open_us=2000, shut_us=1000, settle_s=0.35):
        if gpio is None:
            import RPi.GPIO as gpio
        self.gpio, self.pin = gpio, int(pin)
        self.open_us, self.shut_us, self.settle_s = open_us, shut_us, settle_s
        gpio.setwarnings(False)
        gpio.setmode(gpio.BCM)
        gpio.setup(self.pin, gpio.OUT, initial=gpio.LOW)
        self.pwm = None

    def _duty(self, us):
        return 100.0 * us / (1_000_000 / self.HZ)

    def open(self):
        self.pwm = self.gpio.PWM(self.pin, self.HZ)
        self.pwm.start(self._duty(self.open_us))
        time.sleep(self.settle_s)
        self.is_open = True

    def close(self):
        try:
            if self.pwm is None:
                self.pwm = self.gpio.PWM(self.pin, self.HZ)
                self.pwm.start(self._duty(self.shut_us))
            else:
                self.pwm.ChangeDutyCycle(self._duty(self.shut_us))
            time.sleep(self.settle_s)
        finally:
            if self.pwm is not None:
                self.pwm.stop()
                self.pwm = None
            self.gpio.output(self.pin, self.gpio.LOW)
            self.is_open = False


class CameraSource:
    """Where colour frames come from. capture(region) returns an RGB uint8
    array; region is (x0, y0, x1, y1) in camera pixels or None for the whole
    view. A source that can crop at the camera sets crops_at_source."""

    width = 0
    height = 0
    crops_at_source = False

    def capture(self, region=None):
        raise NotImplementedError


class StandInCamera(CameraSource):
    """A fixed picture in place of a camera, for tests and for working on the
    software before the camera is fitted."""

    def __init__(self, image, crops_at_source=False):
        self._image = np.asarray(image, dtype=np.uint8)
        self.height, self.width = self._image.shape[:2]
        self.crops_at_source = crops_at_source
        self.captures = []

    def capture(self, region=None):
        self.captures.append(region)
        if region is not None and self.crops_at_source:
            x0, y0, x1, y1 = _int_box(region, self.width, self.height)
            return self._image[y0:y1, x0:x1].copy()
        return self._image.copy()


class UvcCamera(CameraSource):
    """The Arducam IMX519 USB camera (UVC). One frame per call, decoded by
    ffmpeg straight into memory through a pipe, so no file is written at any
    step, and cropped inside ffmpeg, so a table check's picture never holds
    more than that table by the time it reaches this program.

    Unverified on the camera itself: written to the UVC and ffmpeg
    documentation before the camera was bought. When it is plugged in, run
    `v4l2-ctl --list-formats-ext -d DEVICE` to confirm the MJPEG size here,
    then one look on a bench with TABLE_CAMERA=1."""

    crops_at_source = True

    def __init__(self, device, width=4656, height=3496, fmt='mjpeg', warmup=5, run=None):
        self.device, self.width, self.height, self.fmt = device, int(width), int(height), fmt
        self.warmup = int(warmup)    # frames skipped while exposure and focus settle
        self._run = run or (lambda args: subprocess.run(args, capture_output=True, timeout=60))

    def command(self, region=None):
        """The ffmpeg call, and the size of the frame it returns."""
        w, h = self.width, self.height
        filters = [f'select=gte(n\\,{self.warmup})'] if self.warmup else []
        if region is not None:
            x0, y0, x1, y1 = _int_box(region, self.width, self.height)
            w, h = max(2, (x1 - x0) // 2 * 2), max(2, (y1 - y0) // 2 * 2)
            filters.append(f'crop={w}:{h}:{x0}:{y0}')
        args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'v4l2',
                '-input_format', self.fmt, '-video_size', f'{self.width}x{self.height}',
                '-i', self.device]
        if filters:
            args += ['-vf', ','.join(filters)]
        args += ['-frames:v', '1', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
        return args, w, h

    def capture(self, region=None):
        args, w, h = self.command(region)
        done = self._run(args)
        if done.returncode != 0:
            raise OSError(f'ffmpeg could not read {self.device}: {done.stderr[-300:]!r}')
        if len(done.stdout) != w * h * 3:
            raise OSError(f'{self.device} gave {len(done.stdout)} bytes for a {w}x{h} frame')
        return np.frombuffer(done.stdout, dtype=np.uint8).reshape(h, w, 3).copy()


class Detector:
    """Finds things in a picture: [(label, score, x0, y0, x1, y1)]."""

    def detect(self, image):
        raise NotImplementedError


class OnnxDetector(Detector):
    """RT-DETRv2-R50 (Apache-2.0, COCO-trained), exported to ONNX, run with
    onnxruntime and numpy only."""

    SIZE = 640

    def __init__(self, model_path, classes_path, threads=4):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        self.session = ort.InferenceSession(str(model_path), so, providers=['CPUExecutionProvider'])
        self.classes = json.loads(Path(classes_path).read_text(encoding='utf-8'))['classes']

    @classmethod
    def _resize(cls, image):
        h, w = image.shape[:2]
        ys = (np.arange(cls.SIZE) + 0.5) * h / cls.SIZE - 0.5
        xs = (np.arange(cls.SIZE) + 0.5) * w / cls.SIZE - 0.5
        y0 = np.clip(np.floor(ys).astype(int), 0, h - 1)
        x0 = np.clip(np.floor(xs).astype(int), 0, w - 1)
        y1, x1 = np.clip(y0 + 1, 0, h - 1), np.clip(x0 + 1, 0, w - 1)
        wy = np.clip(ys - y0, 0, 1)[:, None, None]
        wx = np.clip(xs - x0, 0, 1)[None, :, None]
        a = image.astype(np.float32)
        top = a[y0][:, x0] * (1 - wx) + a[y0][:, x1] * wx
        bottom = a[y1][:, x0] * (1 - wx) + a[y1][:, x1] * wx
        return top * (1 - wy) + bottom * wy

    def detect(self, image):
        h, w = image.shape[:2]
        x = self._resize(image) / 255.0
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)
        logits, boxes = self.session.run(None, {self.session.get_inputs()[0].name: x})
        prob = 1.0 / (1.0 + np.exp(-logits[0]))
        out = []
        q, c = np.nonzero(prob >= SCORE)
        for qi, ci in zip(q, c):
            cx, cy, bw, bh = boxes[0][qi]
            out.append((self.classes[int(ci)], float(prob[qi, ci]),
                        float((cx - bw / 2) * w), float((cy - bh / 2) * h),
                        float((cx + bw / 2) * w), float((cy + bh / 2) * h)))
        return sorted(out, key=lambda d: -d[1])


# ---------------------------------------------------------------------------
# The rules
# ---------------------------------------------------------------------------

def _int_box(box, width, height):
    x0, y0, x1, y1 = box
    return (max(0, int(math.floor(x0))), max(0, int(math.floor(y0))),
            min(width, int(math.ceil(x1))), min(height, int(math.ceil(y1))))


def room_clear(points, reading_age):
    """The whole view may be looked at: a fresh reading with nobody in it."""
    return reading_age is not None and reading_age <= GATE_FRESH_S and not points


def table_clear(points, box, reading_age):
    """One table may be looked at: a fresh reading with nobody in its zone
    or within TABLE_RING thermal pixels of it."""
    if reading_age is None or reading_age > GATE_FRESH_S:
        return False
    x0, y0, x1, y1 = box
    return not any(x0 - TABLE_RING <= x < x1 + TABLE_RING and y0 - TABLE_RING <= y < y1 + TABLE_RING
                   for x, y in points)


def warm_mask(frame):
    """Thermal pixels warmer than the room by WARM_C, grown by one pixel."""
    t = np.asarray(frame, dtype=np.float32).reshape(THERMAL_ROWS, THERMAL_COLS)
    warm = t >= float(np.median(t)) + WARM_C
    grown = warm.copy()
    grown[1:, :] |= warm[:-1, :]
    grown[:-1, :] |= warm[1:, :]
    grown[:, 1:] |= warm[:, :-1]
    grown[:, :-1] |= warm[:, 1:]
    return grown


def black_out(image, frame, mapping, origin=(0, 0)):
    """Paint every warm thermal pixel black in `image`, a picture whose top
    left corner is `origin` in camera pixels. Returns the share blacked."""
    h, w = image.shape[:2]
    ox, oy = origin
    vs, us = np.nonzero(warm_mask(frame))
    painted = np.zeros((h, w), dtype=bool)
    for v, u in zip(vs, us):
        x0, y0, x1, y1 = mapping.box_to_camera((u, v, u + 1, v + 1))
        bx0, by0, bx1, by1 = _int_box((x0 - ox, y0 - oy, x1 - ox, y1 - oy), w, h)
        if bx1 > bx0 and by1 > by0:
            painted[by0:by1, bx0:bx1] = True
    image[painted] = 0
    return float(painted.mean()) if painted.size else 0.0


def _iou(a, b):
    ix = max(0.0, min(a[4], b[4]) - max(a[2], b[2]))
    iy = max(0.0, min(a[5], b[5]) - max(a[3], b[3]))
    inter = ix * iy
    union = (a[4] - a[2]) * (a[5] - a[3]) + (b[4] - b[2]) * (b[5] - b[3]) - inter
    return inter / union if union > 0 else 0.0


def _best_of_overlaps(found, threshold=0.45):
    """One box per thing: of boxes overlapping more than `threshold`, the
    highest-scoring one."""
    kept = []
    for d in sorted(found, key=lambda d: -d[1]):
        if all(_iou(d, k) < threshold for k in kept):
            kept.append(d)
    return kept


def _centre_in(d, box, grow=0.0):
    x0, y0, x1, y1 = box
    gx, gy = (x1 - x0) * grow, (y1 - y0) * grow
    cx, cy = (d[2] + d[4]) / 2, (d[3] + d[5]) / 2
    return x0 - gx <= cx <= x1 + gx and y0 - gy <= cy <= y1 + gy


class TableCamera:
    """One camera, its shutter, its detector, and the mapping to the heat
    camera, with every rule in the module docstring applied to every look."""

    def __init__(self, source, detector, mapping, shutter=None, clock=None):
        self.source = source
        self.detector = detector
        self.mapping = mapping
        self.shutter = shutter or Shutter()
        self.clock = clock
        self.backoff = {}           # 'room' or a table number -> no look before this time
        self.dropped = 0

    def _peek(self, region):
        """Open the shutter, take one picture, shut it whatever happens."""
        self.shutter.open()
        try:
            return self.source.capture(region)
        finally:
            self.shutter.close()

    def _crop_first(self, picture, region):
        if region is None or self.source.crops_at_source:
            return picture
        x0, y0, x1, y1 = _int_box(region, picture.shape[1], picture.shape[0])
        return picture[y0:y1, x0:x1].copy()

    def _person(self, found, key, now):
        if any(d[0] in PERSON_CLASSES and d[1] >= SCORE for d in found):
            self.backoff[key] = now + PERSON_BACKOFF_S
            self.dropped += 1
            return True
        return False

    def look_room(self, points, frame, reading_age, now):
        """F4 and F5: the tables in an empty room and the chairs at each, as
        [{'box': thermal box, 'chairs': n}], or None when the look was not
        allowed or was dropped."""
        if now < self.backoff.get('room', -1.0) or not room_clear(points, reading_age):
            return None
        picture = self._peek(None)
        try:
            black_out(picture, frame, self.mapping)
            found = self.detector.detect(picture)
        finally:
            del picture
        if self._person(found, 'room', now):
            return None
        tables = _best_of_overlaps([d for d in found if d[0] in TABLE_CLASSES and d[1] >= SCORE])
        chairs = _best_of_overlaps([d for d in found if d[0] in CHAIR_CLASSES and d[1] >= SCORE])
        out = []
        for t in tables:
            box = t[2:6]
            n = sum(1 for c in chairs if _centre_in(c, box, grow=0.6))
            thermal = self.mapping.box_to_thermal(box)
            thermal = (max(0.0, thermal[0]), max(0.0, thermal[1]),
                       min(float(THERMAL_COLS), thermal[2]), min(float(THERMAL_ROWS), thermal[3]))
            if thermal[2] - thermal[0] >= 2 and thermal[3] - thermal[1] >= 2:
                out.append({'box': tuple(round(v, 1) for v in thermal), 'chairs': max(1, min(30, n)) if n else None})
        return out

    def check_table(self, n, box, points, frame, reading_age, now):
        """F6: 'dishes', 'clear', or None when the look was not allowed or
        was dropped. box is the table's zone in thermal pixels."""
        if now < self.backoff.get(n, -1.0) or not table_clear(points, box, reading_age):
            return None
        x0, y0, x1, y1 = self.mapping.box_to_camera(box)
        gx, gy = (x1 - x0) * CROP_GROW, (y1 - y0) * CROP_GROW
        region = (x0 - gx, y0 - gy, x1 + gx, y1 + gy)
        picture = self._crop_first(self._peek(region), region)
        try:
            ix0, iy0 = _int_box(region, self.source.width or 10 ** 6, self.source.height or 10 ** 6)[:2]
            warm = black_out(picture, frame, self.mapping, origin=(ix0, iy0))
            found = self.detector.detect(picture)
        finally:
            del picture
        if self._person(found, n, now):
            return None
        if warm >= WARM_SHARE_DISHES:
            return 'dishes'
        if any(d[0] in DISH_CLASSES and d[1] >= SCORE for d in found):
            return 'dishes'
        return 'clear'


def _home(point, tables):
    """The index of the table a seat spot belongs to, or None."""
    x, y = point
    best = None
    for t in tables:
        x0, y0, x1, y1 = t['box']
        gx, gy = (x1 - x0) * 0.5, (y1 - y0) * 0.5
        if x0 - gx <= x <= x1 + gx and y0 - gy <= y <= y1 + gy:
            d = (x - (x0 + x1) / 2) ** 2 + (y - (y0 + y1) / 2) ** 2
            if best is None or d < best[0]:
                best = (d, t['_i'])
    return None if best is None else best[1]


def write_zones(path, tables, previous=(), number_start=1, number_max=200, seats=()):
    """Write what a room look found as the zones file, marked as the
    camera's. A table that overlaps an earlier one keeps its number. seats
    are the seat spots the heat learned (thermal pixels): each goes to the
    table whose box, grown by half, holds it nearest its middle, so heads
    stacked between rows are told apart by seat, as with learned zones."""
    out, used = [], set()

    def overlap(a, b):
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = ix * iy
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / union if union > 0 else 0.0

    tables = [dict(t, _i=i) for i, t in enumerate(tables)]
    for t in tables:
        best = max(((overlap(t['box'], tuple(p['box'])), p['n']) for p in previous
                    if p['n'] not in used), default=(0.0, None))
        n = best[1] if best[0] >= 0.2 else None
        if n is not None:
            used.add(n)
        out.append(dict(t, n=n))
    free = (k for k in range(number_start, number_max + 1) if k not in used)
    rows = []
    for t in out:
        n = t['n'] if t['n'] is not None else next(free, None)
        if n is None:
            continue
        x0, y0, x1, y1 = t['box']
        row = {'n': n, 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1}
        mine = [list(p) for p in seats if _home(p, tables) is t['_i']]
        if mine:
            row['seats'] = mine
        if t.get('chairs'):
            row['chairs'] = t['chairs']
        rows.append(row)
    body = {'source': 'camera', 'tables': sorted(rows, key=lambda r: r['n'])}
    path = Path(path)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(body), encoding='utf-8')
    os.replace(tmp, path)
    return body
