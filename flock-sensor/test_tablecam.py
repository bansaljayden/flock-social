"""The table camera's rules, each pinned. See tablecam.py's docstring.

    python -m unittest test_tablecam
"""
import ast
import json
import math
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np

import tablecam as tc

HERE = Path(__file__).resolve().parent
W, H = 800, 600
ROOM = 22.0


def thermal(warm=()):
    """A room at ROOM with warm patches: (u0, v0, u1, v1) in thermal pixels at 33 C."""
    t = np.full((tc.THERMAL_ROWS, tc.THERMAL_COLS), ROOM, dtype=np.float32)
    for u0, v0, u1, v1 in warm:
        t[v0:v1, u0:u1] = 33.0
    return t.ravel().tolist()


def mapping():
    # The colour picture is 5x the thermal one, same aim: thermal (u, v) is camera (5u, 5v).
    return tc.Mapping([[5, 0, 0], [0, 5, 0], [0, 0, 1]])


class Recorder(tc.Detector):
    """A detector that remembers what it was shown and answers as told."""

    def __init__(self, answer=()):
        self.answer = list(answer)
        self.seen = []

    def detect(self, image):
        self.seen.append(image.copy())
        return list(self.answer)


class CountingShutter(tc.Shutter):
    def __init__(self):
        self.opened = 0
        self.open_while_capturing = []

    def open(self):
        self.opened += 1
        self.is_open = True


class WatchedCamera(tc.StandInCamera):
    def __init__(self, image, shutter, **kw):
        super().__init__(image, **kw)
        self.shutter = shutter

    def capture(self, region=None):
        self.shutter.open_while_capturing.append(self.shutter.is_open)
        return super().capture(region)


def camera(answer=(), crops=False, picture=None):
    picture = np.full((H, W, 3), 200, dtype=np.uint8) if picture is None else picture
    shutter = CountingShutter()
    source = WatchedCamera(picture, shutter, crops_at_source=crops)
    det = Recorder(answer)
    return tc.TableCamera(source, det, mapping(), shutter=shutter), source, det, shutter


ZONE = (40.0, 40.0, 60.0, 60.0)       # thermal pixels; camera 200..300 each way


class TheHeatCameraIsTheGate(unittest.TestCase):

    def test_no_room_look_with_anyone_in_view(self):
        cam, source, det, shutter = camera()
        self.assertIsNone(cam.look_room([(10.0, 10.0)], thermal(), 0.5, now=0))
        self.assertEqual(source.captures, [])
        self.assertEqual(shutter.opened, 0)

    def test_no_look_on_a_stale_reading(self):
        cam, source, det, shutter = camera()
        self.assertIsNone(cam.look_room([], thermal(), tc.GATE_FRESH_S + 0.1, now=0))
        self.assertIsNone(cam.check_table(1, ZONE, [], thermal(), None, now=0))
        self.assertEqual(source.captures, [])

    def test_no_table_check_with_someone_at_or_near_the_table(self):
        cam, source, det, shutter = camera()
        for point in ((50.0, 50.0), (40.0 - tc.TABLE_RING + 1, 50.0)):
            self.assertIsNone(cam.check_table(1, ZONE, [point], thermal(), 0.5, now=0))
        self.assertEqual(source.captures, [])
        self.assertEqual(shutter.opened, 0)

    def test_someone_elsewhere_does_not_stop_a_table_check(self):
        cam, source, det, shutter = camera()
        self.assertEqual(cam.check_table(1, ZONE, [(140.0, 100.0)], thermal(), 0.5, now=0), 'clear')


class TheShutter(unittest.TestCase):

    def test_open_only_while_the_picture_is_taken(self):
        cam, source, det, shutter = camera()
        cam.check_table(1, ZONE, [], thermal(), 0.5, now=0)
        self.assertEqual(shutter.open_while_capturing, [True])
        self.assertFalse(shutter.is_open)

    def test_shut_even_when_the_camera_fails(self):
        class Broken(tc.StandInCamera):
            def capture(self, region=None):
                raise OSError('unplugged')
        shutter = CountingShutter()
        cam = tc.TableCamera(Broken(np.zeros((H, W, 3), np.uint8)), Recorder(), mapping(), shutter=shutter)
        with self.assertRaises(OSError):
            cam.check_table(1, ZONE, [], thermal(), 0.5, now=0)
        self.assertFalse(shutter.is_open)


class CropFirst(unittest.TestCase):

    def test_the_detector_only_ever_sees_the_table(self):
        for crops in (True, False):
            with self.subTest(crops_at_source=crops):
                cam, source, det, shutter = camera(crops=crops)
                cam.check_table(1, ZONE, [], thermal(), 0.5, now=0)
                seen = det.seen[0]
                # The zone is 100 x 100 camera pixels, grown 15% each side.
                self.assertEqual(seen.shape[:2], (130, 130))

    def test_a_camera_that_can_crop_is_asked_for_the_table_only(self):
        cam, source, det, shutter = camera(crops=True)
        cam.check_table(1, ZONE, [], thermal(), 0.5, now=0)
        x0, y0, x1, y1 = source.captures[0]
        self.assertAlmostEqual(x0, 185.0)
        self.assertAlmostEqual(x1, 315.0)


class BlackOutTheWarm(unittest.TestCase):

    def test_warm_areas_are_black_before_the_detector_looks(self):
        cam, source, det, shutter = camera()
        # Someone warm in the corner of the room look's view.
        cam.look_room([], thermal(warm=[(100, 80, 110, 100)]), 0.5, now=0)
        seen = det.seen[0]
        self.assertTrue((seen[400:500, 500:550] == 0).all())
        self.assertTrue((seen[100:150, 100:150] == 200).all())

    def test_warm_things_on_a_table_count_as_dishes(self):
        # A hot plate the detector cannot see, because it is blacked out,
        # still means the table is not clear.
        cam, source, det, shutter = camera()
        result = cam.check_table(1, ZONE, [], thermal(warm=[(48, 48, 52, 52)]), 0.5, now=0)
        self.assertEqual(result, 'dishes')


class DropOnAPerson(unittest.TestCase):

    def test_a_person_drops_the_look_and_backs_off(self):
        person = [('person', 0.9, 210, 210, 260, 290)]
        cam, source, det, shutter = camera(answer=person)
        self.assertIsNone(cam.check_table(1, ZONE, [], thermal(), 0.5, now=0))
        self.assertEqual(cam.dropped, 1)
        # No second look at that table until the back-off ends.
        self.assertIsNone(cam.check_table(1, ZONE, [], thermal(), 0.5, now=60))
        self.assertEqual(len(source.captures), 1)
        det.answer = []
        self.assertEqual(cam.check_table(1, ZONE, [], thermal(), 0.5, now=tc.PERSON_BACKOFF_S + 1), 'clear')

    def test_a_person_in_a_room_look_writes_no_tables(self):
        cam, source, det, shutter = camera(answer=[('person', 0.8, 0, 0, 50, 120),
                                                   ('dining table', 0.9, 200, 200, 300, 300)])
        self.assertIsNone(cam.look_room([], thermal(), 0.5, now=0))


class DishCheck(unittest.TestCase):

    def test_something_left_on_the_table_needs_clearing(self):
        cam, source, det, shutter = camera(answer=[('cup', 0.7, 40, 40, 60, 60)])
        self.assertEqual(cam.check_table(1, ZONE, [], thermal(), 0.5, now=0), 'dishes')

    def test_an_empty_table_is_clear(self):
        cam, source, det, shutter = camera(answer=[('dining table', 0.9, 10, 10, 120, 120)])
        self.assertEqual(cam.check_table(1, ZONE, [], thermal(), 0.5, now=0), 'clear')

    def test_a_faint_guess_is_not_a_dish(self):
        cam, source, det, shutter = camera(answer=[('cup', tc.SCORE - 0.05, 40, 40, 60, 60)])
        self.assertEqual(cam.check_table(1, ZONE, [], thermal(), 0.5, now=0), 'clear')


class RoomLook(unittest.TestCase):

    def test_tables_and_their_chairs_in_thermal_pixels(self):
        found = [('dining table', 0.9, 200, 200, 300, 300),
                 ('chair', 0.8, 160, 220, 200, 280), ('chair', 0.8, 300, 220, 340, 280),
                 ('chair', 0.8, 600, 500, 640, 560),
                 ('dining table', 0.85, 500, 100, 600, 180)]
        cam, source, det, shutter = camera(answer=found)
        tables = cam.look_room([], thermal(), 0.5, now=0)
        self.assertEqual(len(tables), 2)
        first = next(t for t in tables if t['box'][0] < 50)
        self.assertEqual(first['box'], (40.0, 40.0, 60.0, 60.0))
        self.assertEqual(first['chairs'], 2)
        second = next(t for t in tables if t['box'][0] > 50)
        self.assertIsNone(second['chairs'])

    def test_the_zones_file_keeps_numbers_and_says_where_it_came_from(self):
        path = Path(tempfile.mkdtemp()) / 'tables.json'
        previous = [{'n': 7, 'box': (39.0, 41.0, 61.0, 59.0)}]
        body = tc.write_zones(path, [{'box': (40.0, 40.0, 60.0, 60.0), 'chairs': 4},
                                     {'box': (100.0, 20.0, 120.0, 36.0), 'chairs': None}],
                              previous, number_start=12)
        self.assertEqual(body['source'], 'camera')
        self.assertEqual([t['n'] for t in body['tables']], [7, 12])
        self.assertEqual(body['tables'][0]['chairs'], 4)
        self.assertNotIn('chairs', body['tables'][1])
        self.assertEqual(json.loads(path.read_text(encoding='utf-8')), body)


class LiningUp(unittest.TestCase):

    def test_factory_puts_the_middles_together(self):
        m = tc.Mapping.factory(4656, 3496, 65.0, 51.0)
        x, y = m.to_camera(80, 60)
        self.assertAlmostEqual(x, 2328, places=6)
        self.assertAlmostEqual(y, 1748, places=6)
        u, v = m.to_thermal(x, y)
        self.assertAlmostEqual(u, 80, places=6)

    def test_fit_recovers_a_mapping_from_matched_points(self):
        true = tc.Mapping([[28.0, 0.6, 140.0], [-0.4, 29.0, 90.0], [0.0004, 0.0002, 1.0]])
        pairs = [((u, v), true.to_camera(u, v)) for u, v in
                 ((10, 10), (150, 12), (20, 110), (140, 100), (80, 60), (60, 30))]
        fitted = tc.Mapping.fit(pairs)
        for u, v in ((30, 90), (120, 20)):
            a, b = fitted.to_camera(u, v), true.to_camera(u, v)
            self.assertLess(math.hypot(a[0] - b[0], a[1] - b[1]), 1e-6)
        self.assertEqual(tc.Mapping.from_json(fitted.to_json()).to_camera(5, 5), fitted.to_camera(5, 5))


class NothingIsKept(unittest.TestCase):

    def test_no_picture_outlives_a_check(self):
        cam, source, det, shutter = camera(answer=[('cup', 0.7, 40, 40, 60, 60)])
        cam.check_table(1, ZONE, [], thermal(), 0.5, now=0)
        cam.look_room([], thermal(), 0.5, now=1)
        for name, value in vars(cam).items():
            self.assertNotIsInstance(value, np.ndarray, name)

    def test_the_module_cannot_write_a_picture(self):
        source = (HERE / 'tablecam.py').read_text(encoding='utf-8')
        for primitive in ('.save(', 'imwrite', 'imencode', 'tofile', 'np.save', 'pickle',
                          'VideoWriter', 'requests', 'urllib', 'socket'):
            self.assertNotIn(primitive, source, primitive)
        # The only file it writes is the zones file, which holds numbers.
        tree = ast.parse(source)
        writers = [n for n in ast.walk(tree)
                   if isinstance(n, ast.Attribute) and n.attr in ('write_text', 'write_bytes', 'write')]
        self.assertEqual(len(writers), 1)


class TheUsbCamera(unittest.TestCase):

    def test_a_table_check_is_cropped_inside_ffmpeg_and_read_from_a_pipe(self):
        calls = []

        class Done:
            returncode, stderr = 0, b''
            stdout = bytes(400 * 300 * 3)

        cam = tc.UvcCamera('/dev/video2', run=lambda args: calls.append(args) or Done())
        picture = cam.capture((100, 200, 500, 500))
        self.assertEqual(picture.shape, (300, 400, 3))
        args = calls[0]
        self.assertIn('crop=400:300:100:200', args[args.index('-vf') + 1])
        self.assertEqual(args[-1], 'pipe:1')
        # Nothing in the call names a file to write.
        self.assertFalse(any(a.endswith(('.jpg', '.png', '.mp4', '.raw')) for a in args))

    def test_a_short_or_failed_read_is_an_error_not_a_picture(self):
        class Short:
            returncode, stderr, stdout = 0, b'', bytes(10)

        class Failed:
            returncode, stderr, stdout = 1, b'no such device', b''

        for done in (Short, Failed):
            with self.assertRaises(OSError):
                tc.UvcCamera('/dev/video2', run=lambda args: done()).capture()


class TheServoShutter(unittest.TestCase):

    def gpio(self):
        log = []

        class Pwm:
            def __init__(self, pin, hz):
                log.append(('pwm', pin, hz))

            def start(self, duty):
                log.append(('start', round(duty, 2)))

            def ChangeDutyCycle(self, duty):
                log.append(('duty', round(duty, 2)))

            def stop(self):
                log.append(('stop',))

        class Gpio:
            BCM, OUT, LOW = 'BCM', 'OUT', 0

            def setwarnings(self, flag): pass

            def setmode(self, mode): pass

            def setup(self, pin, mode, initial=0): log.append(('setup', pin))

            def output(self, pin, level): log.append(('out', pin, level))

            def PWM(self, pin, hz): return Pwm(pin, hz)

        return Gpio(), log

    def test_opens_for_a_look_and_goes_slack_shut_after(self):
        gpio, log = self.gpio()
        s = tc.ServoShutter(5, gpio=gpio, settle_s=0)
        s.open()
        self.assertTrue(s.is_open)
        s.close()
        self.assertFalse(s.is_open)
        self.assertEqual([e for e in log if e[0] in ('start', 'duty', 'stop', 'out')],
                         [('start', 10.0), ('duty', 5.0), ('stop',), ('out', 5, 0)])

    def test_a_table_check_through_the_servo_leaves_it_shut(self):
        gpio, log = self.gpio()
        shutter = tc.ServoShutter(5, gpio=gpio, settle_s=0)
        cam = tc.TableCamera(tc.StandInCamera(np.full((H, W, 3), 200, np.uint8)), Recorder(), mapping(),
                             shutter=shutter)
        cam.check_table(1, ZONE, [], thermal(), 0.5, now=0)
        self.assertFalse(shutter.is_open)
        self.assertEqual(log[-1], ('out', 5, 0))


@unittest.skipUnless(os.environ.get('TABLES_ONNX') and os.path.exists(os.environ.get('TABLES_ONNX', '')),
                     'set TABLES_ONNX (and TABLES_CLASSES) to the exported detector to run this')
class RealDetector(unittest.TestCase):
    """The real detector on a rendered empty dining room (fixtures/), drawn for
    this test with no real place or person in it."""

    def test_it_finds_the_tables_in_an_empty_room(self):
        from PIL import Image
        picture = np.asarray(Image.open(HERE / 'fixtures' / 'empty_room.png').convert('RGB'))
        det = tc.OnnxDetector(os.environ['TABLES_ONNX'], os.environ['TABLES_CLASSES'])
        found = det.detect(picture)
        tables = [d for d in found if d[0] == 'dining table']
        self.assertEqual(len(tc._best_of_overlaps([d for d in tables if d[1] >= tc.SCORE])), 8, tables)


if __name__ == '__main__':
    unittest.main()
