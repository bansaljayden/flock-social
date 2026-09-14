#!/usr/bin/env python3
"""Tests for the venue sensor's pure logic.

    cd flock-sensor && python3 -m unittest -v test_main.py

Standard library only, so this runs on a Pi, on a laptop, and in CI without
installing anything. The hardware loops are not covered here (they need the
hardware); everything that decides what number is sent, when, and whether a
failure can wedge the device is.

Each test name is the failure it prevents.
"""

import array
import ctypes
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

# main.py resolves its paths at import time, so redirect them first: a test run
# must never touch a real device's config, log or buffer.
_TMP = tempfile.mkdtemp(prefix='flock-sensor-test-')
os.environ['FLOCK_CONFIG'] = str(Path(_TMP) / 'config.env')
os.environ['FLOCK_LOG'] = str(Path(_TMP) / 'sensor.log')
os.environ['FLOCK_BUFFER'] = str(Path(_TMP) / 'buffer.json')

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main  # noqa: E402


class ConfigParsing(unittest.TestCase):
    def test_a_trailing_comment_or_quotes_do_not_become_part_of_the_value(self):
        # `FLOCK_API_KEY="abc"` used to send the quotes as part of the key, and
        # the device then failed to authenticate with no useful error.
        parsed = main._parse_config_text(
            '# comment line\n'
            'FLOCK_API_KEY="abc123"\n'
            "SENSOR_DEVICE_ID='sensor_007'\n"
            '\n'
            'PUSH_INTERVAL_SECONDS = 45 \n'
            'NOT_A_SETTING\n'
        )
        self.assertEqual(parsed['FLOCK_API_KEY'], 'abc123')
        self.assertEqual(parsed['SENSOR_DEVICE_ID'], 'sensor_007')
        self.assertEqual(parsed['PUSH_INTERVAL_SECONDS'], '45')
        self.assertNotIn('NOT_A_SETTING', parsed)

    def test_a_typo_in_a_numeric_setting_does_not_stop_the_device_booting(self):
        # int('30s') raised at import, systemd gave up after five fast restarts,
        # and the sensor was then dead until someone drove to the venue.
        original = dict(main.CONFIG)
        try:
            main.CONFIG['PUSH_INTERVAL_SECONDS'] = '30 seconds'
            self.assertEqual(main._cfg_number('PUSH_INTERVAL_SECONDS', int, 10, 3600, 30), 30)
            main.CONFIG['PUSH_INTERVAL_SECONDS'] = '1'   # below the floor
            self.assertEqual(main._cfg_number('PUSH_INTERVAL_SECONDS', int, 10, 3600, 30), 30)
            main.CONFIG['PUSH_INTERVAL_SECONDS'] = '45'
            self.assertEqual(main._cfg_number('PUSH_INTERVAL_SECONDS', int, 10, 3600, 30), 45)
        finally:
            main.CONFIG.clear()
            main.CONFIG.update(original)


class EndpointSafety(unittest.TestCase):
    def test_a_plaintext_endpoint_is_refused_because_the_key_travels_in_a_header(self):
        original = main.CONFIG.get('ALLOW_INSECURE_URL')
        try:
            main.CONFIG['ALLOW_INSECURE_URL'] = 'false'
            ok, note = main.url_is_acceptable('http://example.com/api/sensors/data')
            self.assertFalse(ok)
            self.assertIn('plaintext', note)

            ok, _ = main.url_is_acceptable('https://example.com/api/sensors/data')
            self.assertTrue(ok)

            main.CONFIG['ALLOW_INSECURE_URL'] = 'true'
            ok, note = main.url_is_acceptable('http://localhost:3001/api/sensors/data')
            self.assertTrue(ok)
            self.assertTrue(note, 'an insecure endpoint must still warn')
        finally:
            main.CONFIG['ALLOW_INSECURE_URL'] = original

    def test_a_nonsense_scheme_is_refused(self):
        ok, _ = main.url_is_acceptable('ftp://example.com/x')
        self.assertFalse(ok)


class V4L2Plumbing(unittest.TestCase):
    """The ioctl numbers, which are the one part of this that cannot be debugged.

    V4L2 encodes the size of the argument struct into the request number, so a
    struct that is one byte off does not produce a subtly wrong frame. It
    produces ENOTTY, a camera that never opens, and a unit that reports 0
    headcount forever with a log line about an inappropriate ioctl. Nobody has
    run this on a board, so the sizes are pinned against the kernel's
    documented ones here instead.
    """

    def test_the_request_numbers_match_the_kernels(self):
        for name, expected in (('_VIDIOC_QUERYCAP', 0x80685600),
                               ('_VIDIOC_S_FMT', 0xC0D05605),
                               ('_VIDIOC_REQBUFS', 0xC0145608),
                               ('_VIDIOC_STREAMON', 0x40045612),
                               ('_VIDIOC_STREAMOFF', 0x40045613)):
            actual = getattr(main, name) & 0xFFFFFFFF
            self.assertEqual(actual, expected, f'{name} is {actual:#x}')

    def test_v4l2_format_carries_the_alignment_the_kernel_gives_it(self):
        # struct v4l2_format holds a union containing struct v4l2_window, which
        # holds pointers, so the union is pointer-aligned and the struct is 208
        # bytes on a 64-bit kernel rather than the 204 its visible fields add
        # up to. Getting this wrong is exactly how VIDIOC_S_FMT returns ENOTTY.
        expected = 208 if ctypes.sizeof(ctypes.c_void_p) == 8 else 204
        self.assertEqual(ctypes.sizeof(main._v4l2_format), expected)

    @unittest.skipUnless(ctypes.sizeof(ctypes.c_long) == ctypes.sizeof(ctypes.c_void_p),
                         'long and pointer differ in width here (Windows LLP64); '
                         'no Linux target does that, so there is no kernel size '
                         'to compare against')
    def test_v4l2_buffer_is_the_size_the_kernel_expects(self):
        # 88 on a 64-bit Pi OS, 68 on a 32-bit one. Both come from struct
        # v4l2_buffer holding a struct timeval and a union with a pointer in
        # it, so the size follows the platform's long and pointer width rather
        # than the visible fields.
        expected = 88 if ctypes.sizeof(ctypes.c_long) == 8 else 68
        self.assertEqual(ctypes.sizeof(main._v4l2_buffer), expected)

    def test_the_pixel_format_asked_for_is_raw_temperatures(self):
        # 'Y16 ', 16 bits per pixel. The same camera's other node is 8-bit AGC
        # greyscale, which is a picture, and the privacy policy says this
        # device does not make pictures.
        self.assertEqual(main._V4L2_PIX_FMT_Y16,
                         int.from_bytes(b'Y16 ', 'little'))


class ThermalFrames(unittest.TestCase):
    """The Lepton frame path: raw bytes in, temperatures out, junk rejected."""

    def test_radiometric_centikelvin_becomes_degrees_celsius(self):
        raw = array.array('H', [29315, 30715, 27315]).tobytes()
        celsius = main.raw_y16_to_celsius(raw)
        self.assertEqual(len(celsius), 3)
        self.assertAlmostEqual(celsius[0], 20.0, places=2)
        self.assertAlmostEqual(celsius[1], 34.0, places=2)
        self.assertAlmostEqual(celsius[2], 0.0, places=2)

    def test_the_flat_field_shutter_is_not_mistaken_for_an_empty_room(self):
        # The Lepton closes an internal shutter every few minutes to recalibrate.
        # That frame is one uniform surface. Counted, it says nobody is here, and
        # at a 30s push cadence it can be the reading a push actually sends.
        self.assertTrue(main.is_shutter_frame([25.0] * 400))
        self.assertTrue(main.is_shutter_frame([]))
        self.assertFalse(main.is_shutter_frame([20.0] * 399 + [34.0]))

    def test_a_camera_that_is_not_radiometric_is_refused_rather_than_counted(self):
        # A Lepton not in TLinear mode still opens, still streams, and still
        # hands over 19,200 numbers. They are AGC counts. Thresholding them at
        # 28.0 produces something that looks like a headcount and is not one.
        self.assertTrue(main.is_plausible_frame([21.0] * 100))
        self.assertFalse(main.is_plausible_frame([2000.0] * 100))   # raw counts
        self.assertFalse(main.is_plausible_frame([-273.0] * 100))   # raw zeros
        self.assertFalse(main.is_plausible_frame([]))

    def test_binning_averages_and_shrinks_the_grid(self):
        frame = [0.0, 2.0, 10.0, 10.0,
                 4.0, 6.0, 10.0, 10.0]
        cells, rows, cols = main.bin_frame(frame, 2, 4, 2)
        self.assertEqual((rows, cols), (1, 2))
        self.assertEqual(cells, [3.0, 10.0])

    def test_binning_of_one_leaves_the_frame_alone(self):
        cells, rows, cols = main.bin_frame([1.0, 2.0, 3.0, 4.0], 2, 2, 1)
        self.assertEqual((cells, rows, cols), ([1.0, 2.0, 3.0, 4.0], 2, 2))


class ThermalCounting(unittest.TestCase):
    ROWS, COLS = main.THERMAL_ROWS, main.THERMAL_COLS

    @classmethod
    def frame(cls, ambient, blobs=()):
        grid = [ambient] * (cls.ROWS * cls.COLS)
        for (r0, c0, h, w, temp) in blobs:
            for r in range(r0, r0 + h):
                for c in range(c0, c0 + w):
                    grid[r * cls.COLS + c] = temp
        return grid

    @staticmethod
    def person(r0, c0, temp=34.0):
        """A warm blob the size a person plausibly is on THIS sensor.

        Twenty by sixteen raw pixels. At the bench-set bin of 4 that lands on
        exactly 12 analysis cells, which is exactly THERMAL_MIN_CLUSTER, so
        these fixtures sit ON the threshold rather than safely above it. That
        is deliberate and pinned below: raise the minimum by one and every
        count in this class drops to zero, which is the warning you want.
        The 24x32 version of these tests used a 3x3 blob; on a 160x120 grid a
        3x3 blob is a speck, and that difference is the whole reason
        THERMAL_MIN_CLUSTER had to move.

        The size is derived from lens geometry, not measured against a body.
        See count_thermal_clusters for what the bench did measure.
        """
        return (r0, c0, 20, 16, temp)

    def test_two_people_in_a_cool_room_count_as_two(self):
        f = self.frame(20.0, [self.person(10, 10), self.person(70, 100)])
        self.assertEqual(main.count_thermal_clusters(f), 2)

    def test_a_packed_bar_in_august_does_not_report_one_person(self):
        # With a fixed 28C threshold, a room at 29C marked every pixel warm, the
        # flood fill joined the whole grid into a single cluster, and the venue
        # reported a headcount of 1 at exactly the moment the number mattered.
        f = self.frame(29.0, [self.person(10, 10, 35.0), self.person(70, 100, 35.0),
                              self.person(70, 10, 35.0)])
        self.assertEqual(main.count_thermal_clusters(f), 3)

    def test_an_empty_room_reports_nobody(self):
        self.assertEqual(main.count_thermal_clusters(self.frame(21.0)), 0)
        self.assertEqual(main.count_thermal_clusters(self.frame(31.0)), 0)

    def test_a_speck_of_noise_is_not_a_person(self):
        # One binned cell. On the coarse sensor four warm pixels were a
        # plausible person; here they are the sensor's own noise floor.
        f = self.frame(20.0, [(4, 4, 2, 2, 40.0)])
        self.assertEqual(main.count_thermal_clusters(f), 0)

    def test_a_single_hot_pixel_is_averaged_away_before_it_can_be_counted(self):
        f = self.frame(20.0, [(11, 11, 1, 1, 60.0)])
        self.assertEqual(main.count_thermal_clusters(f), 0)

    def test_the_minimum_cluster_size_was_moved_off_the_coarse_sensors_value(self):
        # A 24x32 grid and a 160x120 grid cannot share a minimum blob size. If
        # this is ever back at 4, the device is counting noise as a crowd.
        self.assertGreater(main.THERMAL_MIN_CLUSTER, 4)

    def test_the_bench_pair_is_still_the_bench_pair(self):
        # These two are one setting in two variables. 12 cells is 48 raw pixels
        # at bin 2 and 192 at bin 4, so moving either one silently redefines the
        # other, and the 2026-09-06 bench only measured the pair (4, 12).
        # Changing either means re-deriving both. See README.md, Calibration.
        self.assertEqual((main.THERMAL_BIN, main.THERMAL_MIN_CLUSTER), (4, 12),
                         'the thermal pair moved off the only combination anyone has measured')

    def test_a_fragmenting_silhouette_is_one_person_at_the_default_bin(self):
        # The bench, made executable: a bare head over a covered torso with a
        # cool band between them. At bin 2 the band survives pooling and the
        # person is counted twice, which is what a real body did at 3 ft. At
        # bin 4 the band is averaged out and the count is 1.
        f = self.frame(20.0, [(20, 20, 8, 16, 34.0), (29, 20, 20, 16, 34.0)])
        self.assertEqual(main.count_thermal_clusters(f, bin_size=2), 2,
                         'bin 2 no longer fragments, so this fixture stopped reproducing the bench')
        self.assertEqual(main.count_thermal_clusters(f), 1,
                         'the default bin fragments one person into several again')

    def test_a_partly_cropped_body_is_not_counted(self):
        # The other half of the same bench: at 8 to 10 ft a full silhouette
        # counts every time and a partial one at the frame edge does not. An
        # eighth of the person fixture clears 12 cells at bin 2 and does not at
        # bin 4, which is the 4x threshold shift in one assertion. Whether real
        # doorway crossings are fully in frame is a mounting question, not a
        # software one.
        f = self.frame(20.0, [(20, 20, 8, 8, 34.0)])
        self.assertEqual(main.count_thermal_clusters(f, bin_size=2), 1)
        self.assertEqual(main.count_thermal_clusters(f), 0,
                         'a partial crop counts as a person, so the area threshold has softened')

    def test_two_warm_regions_touching_at_a_corner_are_one_cluster(self):
        # Eight-connectivity, where the coarse sensor used four. At this
        # resolution one person can break into pieces that touch diagonally
        # (bare head, covered torso), and four-connectivity would report them
        # as two people. UNVERIFIED against a real body: this pins the
        # algorithm behaviour, not its accuracy.
        #
        # The blobs moved when the default bin went 2 -> 4. They used to touch
        # only on the 80x60 grid: at 40x30 the half-warm cells that joined them
        # average below the cutoff and the same fixture reads 2. That is the bin
        # change doing its job rather than a bug, and it is worth knowing that
        # coarser pooling pulls regions apart as well as pushing them together.
        # These coordinates touch diagonally on both grids, so the assertion
        # below is about connectivity at either bin.
        f = self.frame(20.0, [(10, 10, 20, 16, 34.0), (28, 24, 20, 16, 34.0)])
        self.assertEqual(main.count_thermal_clusters(f, bin_size=2), 1)
        self.assertEqual(main.count_thermal_clusters(f), 1)

    def test_a_short_frame_returns_zero_rather_than_raising(self):
        self.assertEqual(main.count_thermal_clusters([25.0] * 10), 0)


class NoiseLevel(unittest.TestCase):
    def test_silence_and_a_deafening_room_both_land_inside_the_bounds_the_backend_accepts(self):
        self.assertEqual(main.compute_noise_db([]), 0.0)
        self.assertGreaterEqual(main.compute_noise_db([0] * 100), 0.0)
        loud = main.compute_noise_db([511] * 100)
        self.assertLessEqual(loud, main.MAX_NOISE_DB)
        self.assertGreater(loud, main.compute_noise_db([2] * 100))


class Snapshots(unittest.TestCase):
    def setUp(self):
        with main._lock:
            main._state['ir_count'] = 7
            main._state['thermal'] = 3
            main._state['thermal_at'] = time.monotonic()
            main._state['noise_db'] = 64.4
            main._state['noise_at'] = time.monotonic()

    def test_crossings_are_handed_to_exactly_one_payload(self):
        # The counter resets at snapshot, not on a successful POST. Resetting on
        # success meant a payload waiting in the buffer had its crossings counted
        # again by the next snapshot, and the backend sums them.
        first = main.snapshot()
        second = main.snapshot()
        self.assertEqual(first['ir_beam_count'], 7)
        self.assertEqual(second['ir_beam_count'], 0)

    def test_a_reading_carries_when_it_was_taken(self):
        payload = main.snapshot()
        self.assertIn('recorded_at', payload)
        self.assertTrue(payload['recorded_at'].endswith('Z'))

    def test_the_device_id_is_sent_so_a_pi_flashed_with_the_wrong_venue_key_is_caught(self):
        original = main.CONFIG.get('SENSOR_DEVICE_ID')
        try:
            main.CONFIG['SENSOR_DEVICE_ID'] = 'sensor_042'
            self.assertEqual(main.snapshot()['device_id'], 'sensor_042')
            main.CONFIG['SENSOR_DEVICE_ID'] = ''
            self.assertNotIn('device_id', main.snapshot())
        finally:
            main.CONFIG['SENSOR_DEVICE_ID'] = original

    def test_a_reading_taken_before_ntp_gets_its_real_time_once_the_clock_is_set(self):
        # A Pi has no real-time clock. Readings taken in the boot window used to
        # be filed at whatever time they happened to arrive, hours later.
        taken = {'ir_beam_count': 1, 'thermal_headcount': 1, 'noise_db': 5.0,
                 '_mono': time.monotonic() - 120}
        resolved = main._resolve_timestamp(dict(taken))
        self.assertIn('recorded_at', resolved)
        self.assertNotIn('_mono', resolved)
        # ~2 minutes ago, not now.
        age = time.time() - time.mktime(time.strptime(resolved['recorded_at'][:19],
                                                      '%Y-%m-%dT%H:%M:%S'))
        # mktime reads local time; only the magnitude matters here.
        self.assertLess(abs((age % 3600) - 120), 10)

    def test_an_already_dated_reading_is_left_alone(self):
        item = {'recorded_at': '2026-01-01T00:00:00.000Z', '_mono': time.monotonic()}
        resolved = main._resolve_timestamp(dict(item))
        self.assertEqual(resolved['recorded_at'], '2026-01-01T00:00:00.000Z')


class SensorFreshness(unittest.TestCase):
    """A sensor that stops answering must stop being reported.

    `thermal` and `noise_db` are latched values, so before this the last number
    a failing sensor managed to read was posted every 30 seconds forever. A bus
    that locks up at 11pm is ordinary hardware behaviour, and it showed on the
    venue card as a packed room at 4am, with nothing downstream able to tell the
    difference because the rows kept arriving with fresh timestamps.
    """

    def setUp(self):
        main._throttle.clear()
        with main._lock:
            main._state['ir_count'] = 0
            main._state['thermal'] = 12
            main._state['thermal_at'] = time.monotonic()
            main._state['noise_db'] = 71.5
            main._state['noise_at'] = time.monotonic()

    def test_a_reading_taken_just_now_is_sent_as_it_is(self):
        payload = main.snapshot()
        self.assertEqual(payload['thermal_headcount'], 12)
        self.assertEqual(payload['noise_db'], 71.5)

    def test_a_thermal_camera_that_stopped_answering_reports_zero_not_its_last_headcount(self):
        with main._lock:
            main._state['thermal_at'] = time.monotonic() - main.THERMAL_STALE_AFTER - 1
        payload = main.snapshot()
        self.assertEqual(payload['thermal_headcount'], 0)
        self.assertEqual(payload['noise_db'], 71.5, 'one dead sensor must not zero the others')

    def test_a_mic_that_stopped_answering_reports_zero_not_its_last_level(self):
        with main._lock:
            main._state['noise_at'] = time.monotonic() - main.NOISE_STALE_AFTER - 1
        payload = main.snapshot()
        self.assertEqual(payload['noise_db'], 0.0)
        self.assertEqual(payload['thermal_headcount'], 12)

    def test_a_few_failed_reads_do_not_zero_a_working_sensor(self):
        # thermal_loop reads every 2s and noise_loop every 5s. A sensor that
        # missed a handful of reads is still a working sensor, and zeroing it
        # would invent an empty room in the middle of a busy night.
        with main._lock:
            main._state['thermal_at'] = time.monotonic() - 10
            main._state['noise_at'] = time.monotonic() - 20
        payload = main.snapshot()
        self.assertEqual(payload['thermal_headcount'], 12)
        self.assertEqual(payload['noise_db'], 71.5)

    def test_a_sensor_that_never_initialized_reports_zero_rather_than_a_stale_default(self):
        with main._lock:
            main._state['thermal'] = 0
            main._state['thermal_at'] = None
            main._state['noise_db'] = 0.0
            main._state['noise_at'] = None
        payload = main.snapshot()
        self.assertEqual(payload['thermal_headcount'], 0)
        self.assertEqual(payload['noise_db'], 0.0)

    def test_the_crossing_count_is_never_suppressed_by_a_staleness_rule(self):
        # The IR counter resets into every payload, so a dead beam already
        # reports 0 by construction. Applying a freshness rule to it would
        # discard real crossings.
        with main._lock:
            main._state['ir_count'] = 9
            main._state['thermal_at'] = time.monotonic() - 10_000
            main._state['noise_at'] = time.monotonic() - 10_000
        self.assertEqual(main.snapshot()['ir_beam_count'], 9)


class Buffering(unittest.TestCase):
    def setUp(self):
        main._pending = []
        main._buffer_on_disk = False
        if main.BUFFER_PATH.exists():
            main.BUFFER_PATH.unlink()

    def test_a_power_cut_mid_write_cannot_leave_an_unreadable_queue(self):
        # The write is temp file + rename, so the buffer file is either the old
        # contents or the new ones, never a truncated half.
        main._pending = [{'ir_beam_count': 1, 'thermal_headcount': 2, 'noise_db': 3.0}]
        main.persist_buffer()
        self.assertTrue(main.BUFFER_PATH.exists())
        self.assertEqual(json.loads(main.BUFFER_PATH.read_text()), main._pending)
        self.assertFalse(main.BUFFER_PATH.with_suffix('.json.tmp').exists())

    def test_a_corrupt_buffer_file_is_discarded_instead_of_killing_the_push_thread(self):
        # A non-list buffer used to reach `buf.append(...)`, raise, and kill the
        # push thread silently: the process stayed up, systemd saw a healthy
        # service, and the venue quietly stopped reporting.
        main.BUFFER_PATH.write_text('{"not": "a list"')
        self.assertEqual(main.load_buffer(), [])
        main.BUFFER_PATH.write_text('{"not": "a list"}')
        self.assertEqual(main.load_buffer(), [])

    def test_malformed_entries_are_dropped_and_good_ones_survive(self):
        main.BUFFER_PATH.write_text(json.dumps([
            {'ir_beam_count': 1, 'thermal_headcount': 2, 'noise_db': 3.0,
             'recorded_at': '2026-08-14T20:00:00.000Z'},
            {'ir_beam_count': 'lots', 'thermal_headcount': 2, 'noise_db': 3.0,
             'recorded_at': '2026-08-14T20:00:30.000Z'},
            'not even a dict',
            {'ir_beam_count': 4, 'thermal_headcount': 5, 'noise_db': 6.5,
             'recorded_at': '2026-08-14T20:01:00.000Z'},
        ]))
        loaded = main.load_buffer()
        self.assertEqual(len(loaded), 2)
        self.assertEqual(loaded[1]['ir_beam_count'], 4)

    def test_an_undated_reading_recovered_from_disk_is_dropped_rather_than_filed_on_arrival(self):
        # Its real age is unknowable after a reboot. Sending it would have a Pi
        # that sat powered off for three days dump a stale queue into the
        # current hour and invent a crowd that was never there.
        main.BUFFER_PATH.write_text(json.dumps([
            {'ir_beam_count': 9, 'thermal_headcount': 9, 'noise_db': 9.0},
        ]))
        self.assertEqual(main.load_buffer(), [])

    def test_a_pre_ntp_reading_is_given_its_real_time_before_it_goes_to_disk(self):
        # While the process is alive the monotonic mark still means something;
        # after a reboot it does not, so the conversion has to happen here.
        main._pending = [{'ir_beam_count': 2, 'thermal_headcount': 2, 'noise_db': 2.0,
                          '_mono': time.monotonic() - 60}]
        main.persist_buffer()
        written = json.loads(main.BUFFER_PATH.read_text())
        self.assertIn('recorded_at', written[0])
        self.assertNotIn('_mono', written[0])
        # The in-memory copy is untouched, so the live queue still knows.
        self.assertIn('_mono', main._pending[0])

    def test_the_queue_is_only_mirrored_to_disk_while_something_is_waiting(self):
        # Rewriting 240 entries to the SD card every 30 seconds forever is how
        # an appliance wears out its card. The happy path writes nothing.
        main._pending = []
        main.persist_buffer()
        self.assertFalse(main.BUFFER_PATH.exists())

    def test_the_disk_copy_is_cleared_once_the_queue_drains(self):
        main._pending = [{'ir_beam_count': 1, 'thermal_headcount': 1, 'noise_db': 1.0}]
        main.persist_buffer()
        self.assertTrue(main.BUFFER_PATH.exists())
        main._pending = []
        main.persist_buffer()
        self.assertFalse(main.BUFFER_PATH.exists())


class Delivery(unittest.TestCase):
    def setUp(self):
        main._pending = []
        main._buffer_on_disk = False
        main._throttle.clear()
        if main.BUFFER_PATH.exists():
            main.BUFFER_PATH.unlink()
        self._real_post = main._post
        self.sent = []

    def tearDown(self):
        main._post = self._real_post

    def stub(self, responder):
        def fake(payload):
            self.sent.append(payload)
            return responder(payload, len(self.sent))
        main._post = fake

    def queue(self, n):
        main._pending = [{'ir_beam_count': i, 'thermal_headcount': i, 'noise_db': 1.0,
                          'recorded_at': f'2026-08-14T20:{i:02d}:00.000Z'} for i in range(n)]

    def test_readings_go_out_oldest_first_so_the_time_series_stays_in_order(self):
        self.stub(lambda p, n: (201, ''))
        self.queue(5)
        main.Pusher().flush()
        self.assertEqual([p['ir_beam_count'] for p in self.sent], [0, 1, 2, 3, 4])
        self.assertEqual(main._pending, [])

    def test_a_long_outage_drains_a_few_at_a_time_rather_than_as_one_burst(self):
        # Draining 240 payloads in one cycle blocked the loop for minutes and
        # arrived at the backend as a spike.
        self.stub(lambda p, n: (201, ''))
        self.queue(100)
        main.Pusher().flush()
        self.assertEqual(len(self.sent), main.MAX_FLUSH_PER_CYCLE)
        self.assertEqual(len(main._pending), 100 - main.MAX_FLUSH_PER_CYCLE)

    def test_a_backend_outage_backs_off_instead_of_retrying_every_thirty_seconds(self):
        self.stub(lambda p, n: (503, 'upstream down'))
        self.queue(3)
        pusher = main.Pusher()
        pusher.flush()
        # The reading is kept, and the next attempt is pushed into the future.
        self.assertEqual(len(main._pending), 3)
        self.assertGreater(pusher.next_attempt, time.monotonic())
        first_delay = pusher.next_attempt - time.monotonic()
        pusher.next_attempt = 0
        pusher.flush()
        self.assertGreater(pusher.next_attempt - time.monotonic(), first_delay)

    def test_the_backoff_is_capped_so_a_device_recovers_without_a_site_visit(self):
        pusher = main.Pusher()
        for _ in range(50):
            pusher._schedule_retry()
        self.assertLessEqual(pusher.next_attempt - time.monotonic(), main.MAX_BACKOFF_SECONDS * 1.2)

    def test_no_reply_at_all_is_treated_as_retryable(self):
        self.stub(lambda p, n: (0, 'connection refused'))
        self.queue(2)
        pusher = main.Pusher()
        pusher.flush()
        self.assertEqual(len(main._pending), 2)
        self.assertGreater(pusher.next_attempt, time.monotonic())

    def test_a_reading_the_backend_will_never_accept_is_dropped_instead_of_retried_forever(self):
        # A 400 used to be buffered like any other failure, so one poisoned
        # payload was re-sent every 30 seconds until someone drove to the venue.
        self.stub(lambda p, n: (400, 'noise_db must be 0-140'))
        self.queue(3)
        main.Pusher().flush()
        self.assertEqual(main._pending, [])

    def test_dropping_readings_is_not_reported_or_treated_as_successful_delivery(self):
        # Counting a drop as a delivery cleared the backoff and logged
        # "Delivered 3 readings" when the backend had received nothing.
        self.stub(lambda p, n: (400, 'rejected'))
        self.queue(3)
        pusher = main.Pusher()
        pusher._schedule_retry()
        pusher.next_attempt = 0
        pusher.failures = 4
        pusher.flush()
        self.assertEqual(main._pending, [])
        self.assertEqual(pusher.failures, 4, 'a drop must not look like recovery')

    def test_a_wrong_key_backs_off_hard_but_keeps_the_readings_and_still_retries(self):
        # Rotating a key must never require a site visit, a device with a bad
        # key must never become a flood, and the readings taken while the key
        # was wrong must still arrive once someone fixes it.
        self.stub(lambda p, n: (401, 'Invalid API key'))
        self.queue(3)
        pusher = main.Pusher()
        pusher.flush()
        self.assertEqual(len(self.sent), 1, 'it must not walk the whole queue against a bad key')
        self.assertEqual(len(main._pending), 3, 'good readings must not be thrown away')
        delay = pusher.next_attempt - time.monotonic()
        self.assertGreaterEqual(delay, main.AUTH_BACKOFF_START * 0.8)
        self.assertLessEqual(delay, main.AUTH_BACKOFF_MAX * 1.2)

    def test_a_fixed_key_delivers_everything_taken_while_it_was_wrong(self):
        self.stub(lambda p, n: (401, 'Invalid API key'))
        self.queue(3)
        pusher = main.Pusher()
        pusher.flush()
        self.stub(lambda p, n: (201, ''))
        pusher.next_attempt = 0
        pusher.flush()
        self.assertEqual(main._pending, [])

    def test_the_device_refuses_to_put_its_key_on_the_venue_wifi_in_the_clear(self):
        # Logging "REFUSING TO SEND" and then sending anyway is worse than not
        # checking at all. The refusal has to happen at the socket.
        original = dict(main.CONFIG)
        try:
            main.CONFIG['FLOCK_API_URL'] = 'http://someone-elses-box.local/api/sensors/data'
            main.CONFIG['ALLOW_INSECURE_URL'] = 'false'
            code, reason = main._post({'ir_beam_count': 0, 'thermal_headcount': 0,
                                       'noise_db': 0.0})
            self.assertEqual(code, main.REFUSED_LOCALLY)
            self.assertIn('plaintext', reason)
        finally:
            main.CONFIG.clear()
            main.CONFIG.update(original)

    def test_a_refusal_to_send_keeps_the_readings_and_backs_off(self):
        original = dict(main.CONFIG)
        try:
            main.CONFIG['FLOCK_API_URL'] = 'http://nope/api/sensors/data'
            main.CONFIG['ALLOW_INSECURE_URL'] = 'false'
            self.queue(3)
            pusher = main.Pusher()
            pusher.flush()
            self.assertEqual(len(main._pending), 3)
            self.assertGreater(pusher.next_attempt, time.monotonic())
        finally:
            main.CONFIG.clear()
            main.CONFIG.update(original)

    def test_the_backoff_exponent_cannot_run_away_after_days_of_failure(self):
        pusher = main.Pusher()
        for _ in range(5000):
            pusher._schedule_retry(auth_error=True)
        self.assertLessEqual(pusher.auth_failures, 32)
        self.assertLessEqual(pusher.next_attempt - time.monotonic(), main.AUTH_BACKOFF_MAX * 1.2)

    def test_recovery_clears_the_backoff(self):
        pusher = main.Pusher()
        pusher._schedule_retry()
        self.assertGreater(pusher.next_attempt, time.monotonic())
        self.stub(lambda p, n: (201, ''))
        self.queue(1)
        pusher.next_attempt = 0
        pusher.flush()
        self.assertEqual(pusher.failures, 0)
        self.assertEqual(pusher.next_attempt, 0.0)

    def test_being_told_to_slow_down_is_a_short_pause_not_a_fifteen_minute_outage(self):
        # 429 used to fall into the generic retryable branch and buy the network
        # backoff. The backend rate-limits rows inside its 15-minute live window
        # to one every MIN_LIVE_GAP_SECONDS, so a device draining a buffer hit
        # one within seconds and then slept for minutes while still taking two
        # new readings a minute. Past a backlog of about fifteen minutes it took
        # in more than it delivered, drifted to the 240-entry cap, and started
        # dropping readings, and the venue's live figure never came back.
        self.stub(lambda p, n: (429, '{"error":"too fast","retry_after_seconds":2}'))
        self.queue(5)
        pusher = main.Pusher()
        pusher.flush()
        delay = pusher.next_attempt - time.monotonic()
        self.assertGreater(delay, 0)
        self.assertLessEqual(delay, main.PUSH_INTERVAL * 1.2,
                             'a slow-down must never cost more than one normal cadence')
        self.assertEqual(len(main._pending), 5, 'nothing is thrown away')
        self.assertEqual(pusher.failures, 0, 'a 429 is not evidence the backend is down')

    def test_a_slow_down_that_keeps_coming_still_backs_off_but_never_past_one_cadence(self):
        pusher = main.Pusher()
        for _ in range(50):
            pusher._schedule_rate_limit_retry(2)
        delay = pusher.next_attempt - time.monotonic()
        self.assertGreaterEqual(delay, main.RATE_LIMIT_RETRY_MIN * 0.8)
        self.assertLessEqual(delay, main.PUSH_INTERVAL * 1.2)

    def test_a_retry_after_the_backend_did_not_send_falls_back_to_the_floor(self):
        self.assertIsNone(main._retry_after_seconds('not json at all'))
        self.assertIsNone(main._retry_after_seconds('{"error":"too fast"}'))
        self.assertIsNone(main._retry_after_seconds('{"retry_after_seconds":"soon"}'))
        self.assertIsNone(main._retry_after_seconds('{"retry_after_seconds":-4}'))
        self.assertIsNone(main._retry_after_seconds('{"retry_after_seconds":99999}'),
                          'a hostile or broken value must not park the device for a day')
        self.assertEqual(main._retry_after_seconds('{"retry_after_seconds":5}'), 5.0)

    def test_a_cycle_that_delivered_readings_does_not_escalate_the_backoff(self):
        # The exponent measures how long the backend has been unreachable. A
        # cycle that delivered eleven readings and failed on the twelfth is not
        # evidence of that, and counting it as such is the other half of why a
        # device draining a buffer never caught up: the delay climbed on every
        # cycle however much work the cycle had done.
        self.stub(lambda p, n: (201, '') if n <= 3 else (503, 'upstream down'))
        self.queue(10)
        pusher = main.Pusher()
        pusher.failures = 6
        pusher.flush()
        self.assertEqual(len(main._pending), 7, 'three went out')
        self.assertEqual(pusher.failures, 1, 'progress resets the exponent')
        self.assertLessEqual(pusher.next_attempt - time.monotonic(), main.PUSH_INTERVAL * 2 * 1.2)

    def test_a_buffer_drain_that_is_throttled_at_the_live_window_still_finishes(self):
        # The whole failure, end to end: everything older than the live window
        # is accepted, the newest rows are throttled. The queue has to empty.
        live_window = 15
        state = {'accepted': 0}

        def responder(payload, n):
            # Stand in for the backend: the last few readings are the ones
            # inside the window it rate-limits, and it lets one through per
            # attempt.
            remaining = len(main._pending)
            if remaining <= live_window and state['accepted'] % 2 == 1:
                state['accepted'] += 1
                return 429, '{"retry_after_seconds":2}'
            state['accepted'] += 1
            return 201, ''

        self.stub(responder)
        self.queue(60)
        pusher = main.Pusher()
        scheduled_wait = 0.0
        for _ in range(200):
            if not main._pending:
                break
            pusher.flush()
            scheduled_wait += max(0.0, pusher.next_attempt - time.monotonic())
            pusher.next_attempt = 0  # stand in for that wait elapsing

        self.assertEqual(main._pending, [], 'the queue must drain, not stall short of the end')
        # The delay each throttled row costs is what decides whether a device
        # catches up or falls further behind. Every 429 used to buy a network
        # backoff that doubled to fifteen minutes, so this total ran to hours
        # while the device kept taking two readings a minute.
        self.assertLess(scheduled_wait, 15 * main.PUSH_INTERVAL,
                        'a throttled drain must cost minutes, not hours')

    def test_an_outage_longer_than_the_buffer_drops_the_oldest_readings_not_the_newest(self):
        self.stub(lambda p, n: (503, 'down'))
        pusher = main.Pusher()
        for _ in range(main.MAX_BUFFER_ENTRIES + 20):
            pusher.cycle()
        self.assertEqual(len(main._pending), main.MAX_BUFFER_ENTRIES)

    def test_a_cycle_never_raises_however_badly_the_post_misbehaves(self):
        # The push thread must not be able to die. It is the only thing keeping
        # a venue reporting, and nothing outside would notice it had gone.
        def explode(payload):
            raise RuntimeError('requests exploded in a way nobody predicted')
        main._post = explode
        self.queue(2)
        pusher = main.Pusher()
        try:
            pusher.cycle()
        except Exception as e:  # pragma: no cover
            self.fail(f'cycle raised {e!r}')

    def test_a_readonly_disk_does_not_stop_the_device_reporting(self):
        import builtins
        main._pending = [{'ir_beam_count': 1, 'thermal_headcount': 1, 'noise_db': 1.0}]

        def boom(*a, **k):
            raise OSError(28, 'No space left on device')

        real_open = builtins.open
        builtins.open = boom
        try:
            main.persist_buffer()  # must not raise
        finally:
            builtins.open = real_open
        self.assertEqual(len(main._pending), 1, 'the queue stays in memory')


class Privacy(unittest.TestCase):
    def test_only_counts_leave_the_device(self):
        # If this test ever needs updating, the privacy policy needs updating
        # in the same change. Nothing that can identify a person may appear here.
        main.CONFIG['SENSOR_DEVICE_ID'] = 'sensor_001'
        payload = main.snapshot()
        self.assertEqual(
            set(payload) - {'recorded_at', '_mono'},
            {'ir_beam_count', 'thermal_headcount', 'noise_db', 'device_id'},
        )
        for value in payload.values():
            self.assertIsInstance(value, (int, float, str))

    def test_the_source_imports_nothing_that_could_identify_a_person(self):
        # Checked against the imports the module actually has, not against the
        # prose around them, so rewording a comment cannot break this and adding
        # a real capability cannot slip past it.
        import ast
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(a.name.split('.')[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split('.')[0])

        banned = {
            'cv2', 'picamera', 'picamera2', 'PIL', 'imageio',  # images
            'wave', 'sounddevice', 'pyaudio', 'audioop',       # audio capture
            'scapy', 'pyshark', 'getmac', 'netifaces',         # network identifiers
            'bluetooth', 'bleak', 'pybluez',                   # BLE identifiers
        }
        self.assertEqual(imported & banned, set(),
                         'this device counts; it must never be able to identify anyone')

    def test_nothing_can_write_a_thermal_frame_anywhere(self):
        # This matters more than it used to. A 24x32 frame was a handful of warm
        # blobs; a 160x120 frame is a recognisable scene, and the privacy policy
        # promises one is never stored. The frame path reaches V4L2 directly for
        # exactly this reason: no capture library means no encoder to reach for.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        for primitive in ('.tofile(', 'imwrite', 'imsave', 'fromarray',
                          'pickle.dump', 'np.save', 'VideoWriter'):
            self.assertNotIn(primitive, source,
                             'a thermal frame must never reach a file')

    def test_no_shell_out_to_a_tool_that_would_collect_identifiers(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        for tool in ('arp -a', 'iw dev', 'iwlist', 'hcitool', 'tcpdump', 'airodump'):
            self.assertNotIn(tool, source)


class ServiceConfinement(unittest.TestCase):
    """The unit file, which nothing tested.

    This box is the only part of Flock that sits physically in a room full of
    strangers, on wifi nobody controls, and the one file on it that matters is
    the config: it holds the venue's device key and the URL the readings are
    pushed to. It is owned by the service user so the service can read it, which
    also meant the service could REWRITE it. A process that got a shell here
    could repoint FLOCK_API_URL at its own collector and hand it the key.

    ProtectSystem=full closes that and costs nothing: it makes /usr, /boot and
    /etc read-only and does not touch /dev at any level, so every sensor the
    unit's own comment lists still works. It had been refused along with
    ProtectSystem=strict, which is a different setting and genuinely would break
    this service, because strict also makes /var read-only and the buffer and
    the log both live there.
    """

    @staticmethod
    def unit():
        return Path(__file__).resolve().parent.joinpath('flock-sensor.service').read_text(encoding='utf-8')

    def directives(self):
        out = {}
        for line in self.unit().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            out.setdefault(k.strip(), []).append(v.strip())
        return out

    def test_etc_is_read_only_to_the_service(self):
        self.assertEqual(self.directives().get('ProtectSystem'), ['full'],
                         'the config holding the device key is writable by the process that reads it')

    def test_it_does_not_reach_for_strict_which_would_break_the_buffer(self):
        # /var/lib and /var/log are both written. strict would make them
        # read-only and the sensor would look healthy while buffering nothing.
        self.assertNotIn('strict', self.directives().get('ProtectSystem', []))

    def test_systemd_creates_the_two_directories_the_code_writes(self):
        # setup.sh creates neither directory, so these two directives are the
        # only reason an installed device can persist its buffer or its log at
        # all. They also grant write access, which is why no ReadWritePaths is
        # needed alongside them.
        #
        # Pinned because losing them is silent: save_buffer() treats a failed
        # write as "keep the queue in memory" and logs one throttled line, so a
        # buffer whose whole job is surviving a wifi drop would stop surviving a
        # power cut and nothing on the device would say so.
        d = self.directives()
        self.assertEqual(d.get('StateDirectory'), ['flock-sensor'],
                         'nothing creates /var/lib/flock-sensor, so the offline buffer cannot persist')
        self.assertEqual(d.get('LogsDirectory'), ['flock-sensor'],
                         'nothing creates /var/log/flock-sensor')

    def test_the_declared_directories_are_the_ones_the_code_actually_uses(self):
        # systemd derives the paths from the unit's names. If main.py ever moves
        # its buffer or log somewhere else, the unit would be creating two
        # directories nobody writes to and the real path would be unwritable.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertIn('/var/lib/flock-sensor', source,
                      'StateDirectory=flock-sensor creates /var/lib/flock-sensor and main.py no longer uses it')
        self.assertIn('/var/log/flock-sensor', source,
                      'LogsDirectory=flock-sensor creates /var/log/flock-sensor and main.py no longer uses it')

    def test_the_buffer_directory_is_created_outside_systemd_too(self):
        # An installed device is covered by StateDirectory above. This is for a
        # developer run, a manual invocation, or a device started outside the
        # unit, where nothing has made the directory. The log path has always
        # done this; the buffer path did not.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertIn('BUFFER_PATH.parent.mkdir(parents=True, exist_ok=True)', source,
                      'the buffer directory is only created by systemd again, so any other launch loses the buffer')

    def test_the_device_nodes_the_comment_promises_are_still_reachable(self):
        # ProtectSystem never touches /dev, and PrivateDevices / DevicePolicy
        # would. Their absence is the thing keeping the sensors readable.
        d = self.directives()
        self.assertNotIn('PrivateDevices', d)
        self.assertNotIn('DevicePolicy', d)

    def test_it_does_not_run_as_root(self):
        self.assertEqual(self.directives().get('User'), ['pi'])
        self.assertEqual(self.directives().get('NoNewPrivileges'), ['yes'])


class ClockAndDrainRepairs(unittest.TestCase):
    """The 2026-08-27 audit fixes: a fast clock self-repairs instead of losing
    every reading forever, a failed pre-NTP send keeps its monotonic mark, and
    a 429's short wait is honoured inside the cycle instead of waiting out the
    push interval."""

    def setUp(self):
        main._pending = []
        main._buffer_on_disk = False
        main._throttle.clear()
        if main.BUFFER_PATH.exists():
            main.BUFFER_PATH.unlink()
        self._real_post = main._post
        self.sent = []

    def tearDown(self):
        main._post = self._real_post

    def stub(self, responder):
        def fake(payload):
            self.sent.append(dict(payload))
            return responder(payload, len(self.sent))
        main._post = fake

    def test_a_clock_running_fast_strips_the_stamp_and_delivers_instead_of_losing_everything(self):
        # clock_is_sane() only checks the past, so a clock set ahead passes it
        # and stamps every snapshot in the future. The server 400s each one,
        # and 400 used to mean drop: every reading, forever, until a human
        # fixed the clock. The server's own words are the detection.
        def responder(p, n):
            if 'recorded_at' in p:
                return 400, '{"error":"recorded_at is in the future; check the device clock"}'
            return 201, ''
        self.stub(responder)
        main._pending = [{'ir_beam_count': 3, 'thermal_headcount': 1, 'noise_db': 1.0,
                          'recorded_at': '2099-01-01T00:00:00.000Z'}]
        main.Pusher().flush()
        self.assertEqual(main._pending, [], 'the reading delivered instead of being dropped')
        self.assertEqual(len(self.sent), 2, 'one dated refusal, then one undated delivery')
        self.assertNotIn('recorded_at', self.sent[1])

    def test_any_other_400_still_drops_the_one_reading(self):
        self.stub(lambda p, n: (400, '{"error":"noise_db is not a number"}'))
        main._pending = [{'ir_beam_count': 0, 'thermal_headcount': 0, 'noise_db': 1.0,
                          'recorded_at': '2026-08-14T20:00:00.000Z'}]
        main.Pusher().flush()
        self.assertEqual(main._pending, [])
        self.assertEqual(len(self.sent), 1, 'no resend for a genuinely bad payload')

    def test_a_failed_pre_ntp_send_keeps_its_monotonic_mark_for_the_next_attempt(self):
        # The mark is what lets a reading taken before NTP be filed at its real
        # time once the clock lands. Popping it on a send that then FAILED cost
        # the reading its true time forever; now the queued entry keeps it and
        # only the wire copy goes bare.
        self.stub(lambda p, n: (503, 'down'))
        real_sane = main.clock_is_sane
        main.clock_is_sane = lambda: False
        try:
            main._pending = [{'ir_beam_count': 1, 'thermal_headcount': 0, 'noise_db': 1.0,
                              '_mono': time.monotonic() - 60}]
            main.Pusher().flush()
            self.assertIn('_mono', main._pending[0], 'the mark survives a failed attempt')
            self.assertNotIn('_mono', self.sent[0], 'but never goes over the wire')
        finally:
            main.clock_is_sane = real_sane

    def test_a_throttled_drain_finishes_inside_the_cycle_not_across_fifteen(self):
        # The backend's 429 asks for about two seconds. Scheduling that retry
        # and then not running it until the next push interval made a fifteen
        # minute backlog take fifteen to twenty minutes to drain; honouring the
        # wait in-cycle makes it about a minute at production spacing, and
        # milliseconds at this test's spacing.
        real_min, real_interval = main.RATE_LIMIT_RETRY_MIN, main.PUSH_INTERVAL
        main.RATE_LIMIT_RETRY_MIN, main.PUSH_INTERVAL = 0.01, 5
        try:
            def responder(p, n):
                # Every third call throttled, like rows landing inside the live
                # window during a real drain.
                if n % 3 == 0:
                    return 429, '{"error":"too fast","retry_after_seconds":0}'
                return 201, ''
            self.stub(responder)
            main._pending = [{'ir_beam_count': i, 'thermal_headcount': 0, 'noise_db': 1.0,
                              'recorded_at': f'2026-08-14T20:{i:02d}:00.000Z'} for i in range(20)]
            start = time.monotonic()
            main.Pusher().cycle()
            elapsed = time.monotonic() - start
            self.assertEqual(len(main._pending), 0, 'the whole backlog drained in one cycle')
            self.assertLess(elapsed, 3.0, 'on the short waits, not on push intervals')
        finally:
            main.RATE_LIMIT_RETRY_MIN, main.PUSH_INTERVAL = real_min, real_interval

    def test_a_real_failure_ends_the_in_cycle_drain_instead_of_pinning_the_thread(self):
        # The drain loop is for rate limiting only. The moment the backend
        # looks DOWN rather than busy, the cycle must end and hand the wait to
        # the normal backoff, or an outage during a drain would spin here.
        real_min, real_interval = main.RATE_LIMIT_RETRY_MIN, main.PUSH_INTERVAL
        main.RATE_LIMIT_RETRY_MIN, main.PUSH_INTERVAL = 0.01, 5
        try:
            def responder(p, n):
                if n == 1:
                    return 429, '{"error":"too fast","retry_after_seconds":0}'
                return 503, 'down'
            self.stub(responder)
            main._pending = [{'ir_beam_count': i, 'thermal_headcount': 0, 'noise_db': 1.0,
                              'recorded_at': f'2026-08-14T20:{i:02d}:00.000Z'} for i in range(5)]
            start = time.monotonic()
            main.Pusher().cycle()
            elapsed = time.monotonic() - start
            self.assertGreater(len(main._pending), 0, 'the queue is kept for the backoff path')
            self.assertLess(elapsed, 2.0, 'the 503 ended the drain loop promptly')
        finally:
            main.RATE_LIMIT_RETRY_MIN, main.PUSH_INTERVAL = real_min, real_interval


class InstallerConfigOwnership(unittest.TestCase):
    """The 2026-09-06 bench: the config directory, not only the file in it.

    setup.sh made /etc/flock-sensor root:root 0750 and chowned just the file
    inside. Without the traverse bit the service user cannot open its own 0600
    config, so a correctly provisioned device reports a missing API key and the
    only clue is that running the same command as root works.
    """

    @staticmethod
    def installer():
        return Path(__file__).resolve().parent.joinpath('setup.sh').read_text(encoding='utf-8')

    def test_the_config_directory_is_owned_by_the_service_group(self):
        self.assertIn('chown root:"${SERVICE_GROUP}" "${CONFIG_DIR}"', self.installer(),
                      'the service user cannot traverse /etc/flock-sensor and reports a missing config')

    def test_the_config_file_is_chowned_as_well(self):
        # Owning the directory buys nothing on its own: the file is 0600, so it
        # has to belong to the service user for the traverse bit to lead anywhere.
        self.assertIn('chown "${SERVICE_USER}:${SERVICE_GROUP}" "${CONFIG_FILE}"', self.installer(),
                      'the config file is 0600 and no longer owned by the account that reads it')

    def test_the_directory_is_not_world_readable(self):
        # 0750, not 0755. The group is the service group after the chown above,
        # so widening this hands the device key to every account on the box.
        self.assertIn('chmod 0750 "${CONFIG_DIR}"', self.installer())


class CalibrationRecommendation(unittest.TestCase):
    """--calibrate turns two measurements into a threshold, or refuses to.

    All of this is pure, which is deliberate: the arithmetic that decides what
    a venue's occupancy means should not be the part that can only be checked
    by standing in a doorway.
    """

    def test_the_regions_the_counter_keeps_are_the_regions_it_was_given(self):
        # count_thermal_clusters and thermal_region_sizes run one flood fill
        # between them now. If they ever disagree, --calibrate would recommend
        # a threshold for a picture of the room the serving path never sees.
        f = ThermalCounting.frame(20.0, [ThermalCounting.person(10, 10),
                                         ThermalCounting.person(70, 100),
                                         (4, 4, 4, 4, 40.0)])
        sizes = main.thermal_region_sizes(f)
        self.assertEqual(main.count_thermal_clusters(f),
                         sum(1 for s in sizes if s >= main.THERMAL_MIN_CLUSTER))
        self.assertGreater(len(sizes), main.count_thermal_clusters(f),
                           'the unfiltered list dropped the small regions, which is the '
                           'one thing calibration needs it for')

    def test_it_lands_between_the_noise_and_the_person(self):
        rec, _ = main.recommend_min_cluster([1, 2, 3], [40, 60, 55])
        self.assertEqual(rec, 11)

    def test_it_refuses_when_a_person_is_smaller_than_the_room_noise(self):
        # The important failure. There is no number that fixes this, and saying
        # so is more use than picking one: the camera is too far from the door.
        rec, note = main.recommend_min_cluster([20], [15, 30])
        self.assertIsNone(rec)
        self.assertIn('Move the camera closer', note)

    def test_it_refuses_below_the_noise_floor_even_in_a_quiet_room(self):
        # Twenty seconds of a quiet room is not evidence that the room is quiet
        # on a Friday night, so a measured-quiet window cannot buy a threshold
        # down where sensor noise lives.
        rec, _ = main.recommend_min_cluster([1], [5, 9])
        self.assertIsNone(rec)

    def test_it_never_recommends_the_value_that_counts_noise_as_a_crowd(self):
        rec, _ = main.recommend_min_cluster([1], [7, 8])
        self.assertGreaterEqual(rec, main.NOISE_FLOOR_MIN_CLUSTER)
        self.assertGreater(rec, 4)

    def test_it_never_recommends_a_threshold_that_drops_the_person_it_measured(self):
        rec, _ = main.recommend_min_cluster([30], [32, 40])
        self.assertLess(rec, 32)

    def test_no_person_frames_is_not_a_recommendation(self):
        rec, note = main.recommend_min_cluster([1, 2], [])
        self.assertIsNone(rec)
        self.assertIn('no frames', note)

    def test_the_weakest_frame_decides_and_not_the_average(self):
        # A person who reads 40 once and 12 the rest of the time is a person the
        # count loses most of the time. Averaging hides exactly that.
        weak, _ = main.recommend_min_cluster([2], [12, 40, 38])
        strong, _ = main.recommend_min_cluster([2], [38, 40, 38])
        self.assertLess(weak, strong)
class ThermalPairValidation(unittest.TestCase):
    """A config file can switch the headcount off, and used to do it in silence.

    THERMAL_BIN and THERMAL_MIN_CLUSTER are one physical setting held in two
    variables, and the README's own troubleshooting advice, "one person counted
    as two or three, raise THERMAL_BIN", walked installers into the pair that
    counts nobody.
    """

    def test_the_measured_pair_passes_untouched(self):
        self.assertEqual(main.validated_thermal_pair(4, 12), (4, 12, None))

    def test_the_shipped_minimum_at_a_coarse_bin_is_refused(self):
        # bin 6, 7 and 8 with min_cluster 12 need 432, 588 and 768 warm pixels
        # and a person is about 320. Checked against the real counter before this
        # guard existed: all three returned 0 for two person-sized bodies.
        for b in (6, 7, 8):
            binned, minimum, complaint = main.validated_thermal_pair(b, 12)
            self.assertEqual((binned, minimum), (4, 12))
            self.assertIn('counts nobody', complaint)

    def test_a_coarse_bin_is_allowed_when_the_minimum_comes_down_with_it(self):
        # The product is what matters, not the bin. 8 x 6^2 is 288 pixels, inside
        # the band, so that pair is a legitimate choice and is left alone.
        self.assertEqual(main.validated_thermal_pair(6, 8), (6, 8, None))

    def test_a_threshold_inside_the_noise_is_refused(self):
        binned, minimum, complaint = main.validated_thermal_pair(1, 12)
        self.assertEqual((binned, minimum), (4, 12))
        self.assertIn('noise', complaint)

    def test_the_running_configuration_is_a_pair_that_counts_people(self):
        # Belt and braces on the module's live values, whatever a config file
        # said, since these are what actually decide what a venue sees.
        raw = main.THERMAL_MIN_CLUSTER * main.THERMAL_BIN ** 2
        self.assertLessEqual(raw, main._NOMINAL_PERSON_PIXELS)
        self.assertGreaterEqual(raw, main._MIN_SANE_THRESHOLD_PIXELS)
class MarginRecommendation(unittest.TestCase):
    """The cutoff has two arms and only one of them ever runs in a normal room.

    cutoff = max(THERMAL_THRESHOLD_C, median + margin). At the shipped 28.0 and
    3.0 the fixed arm wins below 25C ambient, which is most rooms, so the
    number a venue sees rests on an absolute temperature from a part the
    datasheet allows +/-7C of error on at room-temperature scenes. These pin
    the tool that measures the way out of that.
    """

    def test_it_lands_between_the_room_and_the_person(self):
        rec, _ = main.recommend_margin_c([1.2, 1.5], [9.0, 11.0], 26.0)
        self.assertEqual(rec, 5.2)

    def test_it_says_when_the_fixed_floor_makes_the_measurement_decorative(self):
        # The bench room was 20.1C. Any margin measured there is overridden by
        # THERMAL_THRESHOLD_C=28.0, and saying so is the whole point.
        rec, note = main.recommend_margin_c([1.5], [9.0], 20.1, threshold_c=28.0)
        self.assertIsNotNone(rec)
        self.assertIn('overrides it', note)

    def test_it_says_when_the_margin_is_the_arm_that_decides(self):
        _, note = main.recommend_margin_c([1.2], [9.0], 26.0, threshold_c=28.0)
        self.assertIn('actually deciding', note)

    def test_a_warm_object_in_frame_is_refused_not_tuned_around(self):
        rec, note = main.recommend_margin_c([8.0], [6.0, 9.0], 22.0)
        self.assertIsNone(rec)
        self.assertIn('No margin separates them', note)

    def test_no_person_frames_is_not_a_recommendation(self):
        rec, _ = main.recommend_margin_c([1.0], [], 22.0)
        self.assertIsNone(rec)
class CrowdedRoomCounting(unittest.TestCase):
    """Past half the frame the room used to read as empty.

    The cutoff is anchored on an estimate of the background, and the median
    stops being the background once most of the frame is people. Measured on the
    real counter before the fix: 24 separated bodies counted correctly to 40%
    coverage and then returned 0 at 60% and 70%, which is the same number an
    empty room publishes.
    """

    R, C = main.THERMAL_ROWS, main.THERMAL_COLS

    @classmethod
    def crowd(cls, n, ambient, h=20, w=16, temp=34.0):
        g = [ambient] * (cls.R * cls.C)
        made = 0
        for r in range(0, cls.R, 28):
            for c in range(0, cls.C, 28):
                if made >= n:
                    break
                for rr in range(r, min(r + h, cls.R)):
                    for cc in range(c, min(c + w, cls.C)):
                        g[rr * cls.C + cc] = temp
                made += 1
            if made >= n:
                break
        return g

    def test_a_room_that_is_mostly_people_is_not_an_empty_room(self):
        self.assertEqual(main.count_thermal_clusters(self.crowd(24, 24.0, h=24, w=20)), 24)
        self.assertEqual(main.count_thermal_clusters(self.crowd(24, 26.0, h=26, w=24)), 24)

    def test_the_sparse_cases_still_read_the_same(self):
        for n in (1, 4, 12):
            self.assertEqual(main.count_thermal_clusters(self.crowd(n, 20.0)), n)

    def test_an_empty_room_is_still_empty_at_any_temperature(self):
        for ambient in (14.0, 20.0, 30.0):
            self.assertEqual(main.count_thermal_clusters([ambient] * (self.R * self.C)), 0)

    def test_a_cold_draft_across_the_frame_invents_nobody(self):
        # The risk of anchoring low: a cold patch drags the estimate under the
        # true background and the cutoff follows it down.
        g = [20.0] * (self.R * self.C)
        for r in range(0, 40):
            for c in range(0, 60):
                g[r * self.C + c] = 8.0
        self.assertEqual(main.count_thermal_clusters(g), 0)

    def test_the_ambient_estimate_is_the_background_not_a_body(self):
        full = self.crowd(24, 26.0, h=26, w=24)
        cells, _, _ = main.bin_frame(full, self.R, self.C, main.THERMAL_BIN)
        # The property that matters is not a particular number, it is that the
        # estimate plus the margin still lands under a body. Once it does not,
        # nothing in the frame clears the cutoff and a full room reads as empty.
        self.assertLess(main._ambient(cells) + main.THERMAL_MARGIN_C, 34.0,
                        'the background estimate has been captured by the bodies again')
class SceneBackgroundCounting(unittest.TestCase):
    """A radiator is warm in every frame, so a per-frame estimate cannot see it.

    Every number in this class was measured against the real counter, and the
    numbers are the argument for the feature: a warm fixture in view is a
    permanent +1 on that venue's headcount, at 4am on a locked venue included,
    and the crowd model learns it as a property of the venue.
    """

    R, C = main.THERMAL_ROWS, main.THERMAL_COLS

    @classmethod
    def room(cls, ambient=20.0, fixture=True, people=0):
        g = [ambient] * (cls.R * cls.C)
        if fixture:
            # A radiator: 40x60 raw pixels at 32C, in frame forever.
            for r in range(70, 110):
                for c in range(4, 64):
                    g[r * cls.C + c] = 32.0
        made = 0
        for r in range(0, 60, 28):
            for c in range(0, cls.C, 28):
                if made >= people:
                    break
                for rr in range(r, r + 20):
                    for cc in range(c, c + 16):
                        g[rr * cls.C + cc] = 34.0
                made += 1
            if made >= people:
                break
        return g

    @classmethod
    def seeded(cls, people=0):
        scene = main.SceneBackground()
        for _ in range(main._BG_SEED_FRAMES + 5):
            main.count_people(cls.room(people=people), scene)
        return scene

    def test_the_fixture_is_a_person_without_the_background(self):
        # The thing being fixed, pinned so nobody removes the fix and wonders.
        self.assertEqual(main.count_thermal_clusters(self.room(people=0)), 1)
        self.assertEqual(main.count_thermal_clusters(self.room(people=3)), 4)

    def test_the_fixture_is_nobody_once_the_scene_is_learned(self):
        scene = self.seeded()
        self.assertEqual(main.count_people(self.room(people=0), scene), 0)
        self.assertEqual(main.count_people(self.room(people=1), scene), 1)
        self.assertEqual(main.count_people(self.room(people=3), scene), 3)

    def test_while_it_is_seeding_it_says_nothing_rather_than_zero(self):
        # None and 0 are different claims. The loop leaves the freshness clock
        # alone for None, so the device reports "no reading" and not "empty".
        self.assertIsNone(main.count_people(self.room(), main.SceneBackground()))

    def test_a_motionless_person_is_not_absorbed_into_the_room(self):
        # The classic failure of background subtraction, and the reason
        # foreground cells learn at alpha/20. Two hours at a 2s cadence.
        scene = self.seeded()
        for _ in range(3600):
            main.count_people(self.room(people=1), scene)
        self.assertEqual(main.count_people(self.room(people=1), scene), 1,
                         'somebody who stood still was absorbed into the background')

    def test_seeding_with_somebody_in_frame_costs_a_blind_spot_that_heals(self):
        # The documented cost. Somebody perfectly still for the whole seed window
        # is learned as furniture, and the spot recovers within a few minutes of
        # the room actually being empty.
        scene = self.seeded(people=1)
        self.assertEqual(main.count_people(self.room(people=1), scene), 0)
        for _ in range(150):
            main.count_people(self.room(people=0), scene)
        self.assertEqual(main.count_people(self.room(people=1), scene), 1,
                         'the blind spot from a bad seed never healed')

    def test_the_mask_can_only_take_people_away_never_invent_them(self):
        # The safety property that makes this sane to run unattended. Whatever
        # the background has learned, a masked count can never exceed the
        # unmasked one, so a broken model loses a person rather than conjuring
        # one, and an invented person is the error this project refuses.
        scene = self.seeded()
        for people in (0, 1, 3):
            frame = self.room(people=people)
            cells, _, _ = main.bin_frame(frame, self.R, self.C, main.THERMAL_BIN)
            masked = main.count_thermal_clusters(
                frame, mask=scene.mask(cells, main._ambient(cells)))
            self.assertLessEqual(masked, main.count_thermal_clusters(frame))
class _FakeSurface:
    def __init__(self, size=(1, 1)):
        self.size = size
        self.blits = 0

    def fill(self, _colour):
        pass

    def blit(self, _what, _where):
        self.blits += 1


class _FakeFont:
    def render(self, text, _aa, _colour):
        return _FakeSurface((len(text), 1))


class _FakePygame:
    """Just enough pygame to run draw_thermal_view on a machine without one.

    It also records every call, which is how the no-file-written assertion below
    is made: if a future version of the view ever reaches for image.save, this
    stub is where it shows up.
    """

    MOUSEBUTTONDOWN = 1025
    FINGERDOWN = 1792
    QUIT = 256

    def __init__(self):
        self.calls = []
        self.image = self._Image(self)
        self.transform = self._Transform(self)
        self.draw = self._Draw(self)

    class _Image:
        def __init__(self, outer):
            self.outer = outer

        def frombuffer(self, buf, size, fmt):
            self.outer.calls.append(('frombuffer', len(buf), size, fmt))
            return _FakeSurface(size)

        def save(self, *a, **k):
            self.outer.calls.append(('save',) + a)
            raise AssertionError('the thermal view wrote an image to disk')

    class _Transform:
        def __init__(self, outer):
            self.outer = outer

        def smoothscale(self, surf, size):
            self.outer.calls.append(('smoothscale', size))
            return _FakeSurface(size)

        def scale(self, surf, size):
            self.outer.calls.append(('scale', size))
            return _FakeSurface(size)

    class _Draw:
        def __init__(self, outer):
            self.outer = outer

        def rect(self, *a, **k):
            self.outer.calls.append(('rect',))


class ThermalView(unittest.TestCase):
    """The demo unit's one hero screen, on code that has never met a framebuffer."""

    @staticmethod
    def frame(ambient=20.0, hand=33.0):
        g = [ambient] * (main.THERMAL_ROWS * main.THERMAL_COLS)
        for r in range(50, 70):
            for c in range(70, 90):
                g[r * main.THERMAL_COLS + c] = hand
        return g

    def test_the_palette_runs_cold_to_hot(self):
        p = main.THERMAL_PALETTE
        self.assertEqual(len(p), 256)
        self.assertTrue(all(len(step) == 3 for step in p))
        self.assertLess(sum(p[0]), sum(p[255]), 'the palette is not brighter at the hot end')

    def test_a_hand_lands_at_the_top_of_the_scale_and_the_room_at_the_bottom(self):
        f = self.frame()
        lo, hi = main.thermal_frame_span(f)
        rgb = main.thermal_frame_rgb(f, lo, hi)
        self.assertEqual(len(rgb), main.THERMAL_ROWS * main.THERMAL_COLS * 3)
        room = tuple(rgb[0:3])
        i = (60 * main.THERMAL_COLS + 80) * 3
        hand = tuple(rgb[i:i + 3])
        self.assertGreater(sum(hand), sum(room),
                           'the warm object is not brighter than the room')

    def test_a_nearly_uniform_room_is_not_amplified_into_drama(self):
        # Without the floor on the span, a room that is flat to a tenth of a
        # degree gets stretched across the whole palette and a judge is shown
        # sensor noise presented as structure.
        flat = [21.0] * (main.THERMAL_ROWS * main.THERMAL_COLS)
        lo, hi = main.thermal_frame_span(flat)
        self.assertGreaterEqual(hi - lo, 4.0)

    def test_one_stuck_pixel_does_not_wash_the_picture_out(self):
        f = self.frame()
        f[0] = 300.0
        lo, hi = main.thermal_frame_span(f)
        self.assertLess(hi, 100.0, 'the span is being set by a single outlier again')

    def test_out_of_range_temperatures_cannot_walk_off_the_palette(self):
        rgb = main.thermal_frame_rgb([-400.0, 500.0] * (main.THERMAL_ROWS * main.THERMAL_COLS // 2),
                                     20.0, 30.0)
        self.assertEqual(len(rgb), main.THERMAL_ROWS * main.THERMAL_COLS * 3)

    def test_the_view_draws_without_a_framebuffer(self):
        pg = _FakePygame()
        screen = _FakeSurface()
        fonts = (_FakeFont(), _FakeFont(), _FakeFont())
        main.draw_thermal_view(pg, screen, fonts, self.frame(), 2, True)
        self.assertGreater(screen.blits, 3)
        self.assertTrue(any(c[0] == 'frombuffer' for c in pg.calls))

    def test_it_survives_having_no_frame_yet(self):
        # The first seconds after boot, and any venue unit that somehow has a
        # screen. Crashing here drops the whole display thread.
        pg = _FakePygame()
        screen = _FakeSurface()
        fonts = (_FakeFont(), _FakeFont(), _FakeFont())
        main.draw_thermal_view(pg, screen, fonts, None, 0, False)
        self.assertGreater(screen.blits, 0)

    def test_nothing_in_the_view_writes_an_image(self):
        pg = _FakePygame()
        main.draw_thermal_view(pg, _FakeSurface(), (_FakeFont(), _FakeFont(), _FakeFont()),
                               self.frame(), 1, True)
        self.assertFalse([c for c in pg.calls if c[0] == 'save'],
                         'a frame reached image.save, which the privacy policy forbids')

    def test_the_view_cannot_be_on_without_a_screen(self):
        # The whole privacy argument rests on this: a venue sensor is headless,
        # so it retains no frame whatever its config file says.
        self.assertEqual(main.THERMAL_VIEW_ON, bool(main.DISPLAY_ON and main.THERMAL_VIEW))
        if not main.DISPLAY_ON:
            self.assertFalse(main.THERMAL_VIEW_ON)

    def test_a_headless_unit_holds_no_frame(self):
        self.assertIsNone(main._state['thermal_frame'])
class AdcHealth(unittest.TestCase):
    """The check that could not fail.

    init_noise opened the SPI bus and selftest printed "noise mic : ok" on the
    strength of it. A unit ran an entire evening that way while its converter
    returned 1023 on all eight channels, because VREF had no power and the
    digital ground was never connected. Every branch below is one of the things
    that were actually true of that board, and the reason strings name the wire
    to check, since from the outside the failures look identical.
    """

    def test_a_working_microphone_passes_and_says_what_it_measured(self):
        ok, why = main.adc_health([505, 512, 498, 530, 480, 516])
        self.assertTrue(ok)
        self.assertIn('idles at', why)

    def test_full_scale_on_every_sample_names_vref(self):
        ok, why = main.adc_health([1023] * 40)
        self.assertFalse(ok)
        self.assertIn('VREF', why)

    def test_zero_on_every_sample_names_the_grounds(self):
        ok, why = main.adc_health([0] * 40)
        self.assertFalse(ok)
        self.assertIn('DGND', why)

    def test_a_frozen_midscale_reading_is_still_a_failure(self):
        # The subtle one: 512 looks exactly like a healthy idle, and a real
        # microphone never sits perfectly still for forty samples.
        ok, why = main.adc_health([512] * 40)
        self.assertFalse(ok)
        self.assertIn('no variation', why)

    def test_identical_channels_mean_the_chip_is_not_selecting(self):
        same = [700, 701, 699, 702]
        ok, why = main.adc_health(same, same)
        self.assertFalse(ok)
        self.assertIn('CE0', why)

    def test_a_different_spare_channel_does_not_trip_it(self):
        ok, _ = main.adc_health([505, 512, 498, 530], [40, 44, 39, 41])
        self.assertTrue(ok)

    def test_an_idle_far_from_midscale_names_the_microphone(self):
        # What an unpowered MAX4466 looks like, or an OUT wire one row off.
        ok, why = main.adc_health([3, 8, 2, 11, 4, 9])
        self.assertFalse(ok)
        self.assertIn('OUT', why)

    def test_no_samples_is_not_a_pass(self):
        ok, _ = main.adc_health([])
        self.assertFalse(ok)

    def test_the_selftest_no_longer_calls_it_ok_just_for_opening_the_bus(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertNotIn('{"ok" if init_noise() else', source,
                         'the mic verdict is back to being decided by whether a bus opened')
        self.assertIn('healthy, why = adc_health(mic, spare)', source)

    def test_a_frozen_converter_does_not_publish_a_loudness(self):
        # compute_noise_db will happily turn a stuck reading into a plausible
        # number, so the loop has to withhold it rather than average it in.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertIn('if min(samples) == max(samples):', source,
                      'noise_loop publishes a confident level from a converter that stopped')
class NoiseReference(unittest.TestCase):
    """A silent room reported Lively, and the default is why.

    The level is 20*log10(rms/NOISE_REF_COUNTS)+NOISE_DB_OFFSET. Shipped, the
    reference is 1.0, so silence is measured against a single count. Measured on
    a real unit 2026-09-13: an empty room ran rms 15 to 25 and reported 76, which
    the venue card calls Lively, all night, with nobody in it.
    """

    MEASURED_FLOOR = 15.5     # quietest burst on a real unit in a silent room
    MEASURED_PEAK = 503.8     # loudest, speaking directly into the microphone

    def test_the_shipped_default_calls_a_silent_room_lively(self):
        # The bug, pinned. If this ever starts passing as Quiet, the default
        # changed and the rest of this class needs rereading.
        level = main.compute_noise_db([self.MEASURED_FLOOR], ref_counts=1.0, offset=50.0)
        self.assertGreater(level, 70.0)

    def test_the_recommendation_puts_a_quiet_room_inside_quiet(self):
        ref = main.recommend_noise_ref(self.MEASURED_FLOOR)
        level = main.compute_noise_db([self.MEASURED_FLOOR], ref_counts=ref)
        self.assertAlmostEqual(level, main.QUIET_TARGET_LEVEL, places=1)
        self.assertLess(level, 50.0, 'a silent room is not being called Quiet')

    def test_it_does_not_land_on_the_boundary(self):
        # Setting the reference to the floor is the obvious fix and it puts
        # silence at exactly 50, where the card flickers between two words.
        naive = main.compute_noise_db([self.MEASURED_FLOOR],
                                      ref_counts=self.MEASURED_FLOOR)
        self.assertAlmostEqual(naive, 50.0, places=1)
        chosen = main.compute_noise_db([self.MEASURED_FLOOR],
                                       ref_counts=main.recommend_noise_ref(self.MEASURED_FLOOR))
        self.assertLess(chosen, 45.0)

    def test_the_recommended_reference_keeps_loud_reachable_ordering(self):
        # With the recommendation applied, the measured room should still order
        # correctly: silence quietest, speech above it, peak highest.
        ref = main.recommend_noise_ref(self.MEASURED_FLOOR)
        quiet = main.compute_noise_db([self.MEASURED_FLOOR], ref_counts=ref)
        speech = main.compute_noise_db([100.0], ref_counts=ref)
        peak = main.compute_noise_db([self.MEASURED_PEAK], ref_counts=ref)
        self.assertLess(quiet, speech)
        self.assertLess(speech, peak)

    def test_a_silent_reading_is_not_a_reference(self):
        self.assertIsNone(main.recommend_noise_ref(0))
        self.assertIsNone(main.recommend_noise_ref(-1))

    def test_the_four_words_need_more_range_than_that_unit_had(self):
        # 30 dB measured against 35 dB of thresholds: the top word was
        # unreachable at that gain, which is a hardware screw and not a setting.
        import math
        span = 20 * math.log10(self.MEASURED_PEAK / self.MEASURED_FLOOR)
        self.assertLess(span, main.WORD_SCALE_SPAN_DB)
class NoiseScale(unittest.TestCase):
    """Shouting into the microphone reported Lively and could not do better.

    The level has a fixed slope, so the reference slides the scale and cannot
    stretch it. A unit with 30 dB between its own noise and clipping cannot
    cover the 35 dB the four words are spaced across: you get a correct Quiet or
    a reachable Loud, never both. Measured on a real unit 2026-09-13, where the
    ceiling worked out at about 70 however the reference was set.
    """

    FLOOR = 15.5
    PEAK = 500.0

    def test_without_a_scale_the_top_word_is_unreachable(self):
        # The bug, pinned with the real numbers. Loud starts at 85.
        ref = main.recommend_noise_ref(self.FLOOR)
        top = main.compute_noise_db([self.PEAK], ref_counts=ref, scale=1.0)
        self.assertLess(top, 85.0)

    def test_the_pair_reaches_both_ends(self):
        ref, scale = main.recommend_noise_settings(self.FLOOR, self.PEAK)
        quiet = main.compute_noise_db([self.FLOOR], ref_counts=ref, scale=scale)
        loud = main.compute_noise_db([self.PEAK], ref_counts=ref, scale=scale)
        self.assertAlmostEqual(quiet, main.QUIET_TARGET_LEVEL, places=0)
        self.assertAlmostEqual(loud, main.LOUD_TARGET_LEVEL, places=0)
        self.assertLess(quiet, 50.0, 'a silent room is not called Quiet')
        self.assertGreater(loud, 85.0, 'the loudest thing heard is not called Loud')

    def test_a_scale_of_one_is_exactly_the_old_behaviour(self):
        # The default must change nothing, or every unit already deployed moves.
        self.assertEqual(main.NOISE_SCALE, 1.0)
        plain = main.compute_noise_db([100.0], ref_counts=49.0, offset=50.0)
        scaled = main.compute_noise_db([100.0], ref_counts=49.0, offset=50.0, scale=1.0)
        self.assertEqual(plain, scaled)

    def test_it_refuses_rather_than_dividing_by_a_silent_room(self):
        # The crash the review found: listen() subtracted None from a float, in
        # exactly the 4am quiet venue the tool tells people to measure in.
        self.assertIsNone(main.recommend_noise_settings(0, 100))
        self.assertIsNone(main.recommend_noise_settings(-1, 100))

    def test_it_refuses_when_the_two_ends_are_the_same(self):
        # Nobody made any noise during the run, so there is no range to map.
        self.assertIsNone(main.recommend_noise_settings(20.0, 20.0))
        self.assertIsNone(main.recommend_noise_settings(20.0, 10.0))

    def test_the_ordering_survives_the_stretch(self):
        ref, scale = main.recommend_noise_settings(self.FLOOR, self.PEAK)
        levels = [main.compute_noise_db([r], ref_counts=ref, scale=scale)
                  for r in (self.FLOOR, 50.0, 150.0, self.PEAK)]
        self.assertEqual(levels, sorted(levels))


class FrozenThermalFrame(unittest.TestCase):
    """A camera can fail by succeeding, and that path had no guard.

    The driver keeps handing back buffers and the content never changes. A
    frozen frame that is plausible and not flat passes every check in
    thermal_loop, resets the failure count, and refreshes the freshness clock
    forever, so _fresh never engages and one stale headcount is published
    indefinitely. noise_loop already withheld on this for the ADC.
    """

    def test_the_loop_compares_frames_against_the_previous_one(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertIn('_THERMAL_IDENTICAL_LIMIT', source,
                      'a wedged camera can publish one stale headcount forever again')
        self.assertIn('signature = hash(tuple(frame[::97]))', source)

    def test_an_identical_frame_counts_as_a_failure_so_the_reopen_engages(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        idx = source.index('if identical >= _THERMAL_IDENTICAL_LIMIT:')
        window = source[idx:idx + 600]
        self.assertIn('failures += 1', window,
                      'a frozen camera never trips the reopen, so it stays frozen')
        self.assertIn('continue', window,
                      'a frozen frame still reaches the publish path')

    def test_the_limit_is_above_one_so_a_single_repeat_is_not_a_fault(self):
        self.assertGreater(main._THERMAL_IDENTICAL_LIMIT, 1)

    def test_the_recovery_budget_is_documented_honestly(self):
        # The comment used to claim recovery finishes inside the 90s staleness
        # latch. It does not: a timing-out read costs about 4s, not 2s, and the
        # background reseeds for another 60s afterwards.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertNotIn('shorter than the 90s staleness latch', source)
        detect = main._THERMAL_REOPEN_AFTER * 4
        reseed = main._BG_SEED_FRAMES * 2
        self.assertGreaterEqual(detect + reseed, main.THERMAL_STALE_AFTER,
                                'the arithmetic changed; re-read the comment on '
                                '_THERMAL_REOPEN_AFTER, it claims a gap is expected')


class DisplayFallback(unittest.TestCase):
    """A raise in the thermal view used to end the whole display thread."""

    def test_the_thermal_view_call_is_wrapped_on_its_own(self):
        # The outer handler around display_loop logs and RETURNS, so an
        # exception in the newest drawing code took the doorway counter down
        # with it, and nothing restarts that thread.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        idx = source.index("if view == 'thermal':")
        window = source[idx:idx + 1600]
        self.assertIn('try:', window)
        self.assertIn("view = 'stats'", window,
                      'a failing thermal view does not fall back to the stats screen')
class ThermalRecovery(unittest.TestCase):
    """The reopen path, which until now was covered by reading it carefully.

    A USB thermal camera in a bar drops at least once over months, and before
    2026-09-13 nothing in this program ever re-opened one. The fixes for that
    are the kind that rot silently, because the happy path never touches them,
    so they are driven here with a fake descriptor rather than trusted.
    """

    def setUp(self):
        self._camera = main._thermal_camera
        main._stop.clear()

    def tearDown(self):
        main._set_thermal_camera(self._camera)
        main._stop.clear()

    def test_open_does_not_leak_the_descriptor_when_configure_raises(self):
        # Every raise inside _configure used to leave the fd open. A raw fd is an
        # int with no finalizer, so it held the V4L2 node for the life of the
        # process and the next open got EBUSY. Survivable when init ran once;
        # not survivable now that the loop re-opens.
        camera = main.ThermalCamera('/dev/video-test')
        closed = []
        with mock.patch.object(main, 'fcntl', object()), \
             mock.patch.object(main.os, 'open', return_value=7), \
             mock.patch.object(camera, '_configure', side_effect=OSError('S_FMT refused')), \
             mock.patch.object(camera, 'close', side_effect=lambda: closed.append(True)):
            with self.assertRaises(OSError):
                camera.open()
        self.assertTrue(closed, 'open() leaked the file descriptor on a failed configure')

    def test_init_thermal_closes_the_camera_it_replaces(self):
        # The trap under the reopen fix: assigning over _thermal_camera without
        # closing it left the old fd streaming, the new REQBUFS returned EBUSY,
        # the except set the camera to None, and a working camera was then off
        # for the rest of the deployment.
        closed = []

        class Incumbent:
            cols, rows = main.THERMAL_COLS, main.THERMAL_ROWS

            def close(self):
                closed.append(True)

        main._set_thermal_camera(Incumbent())
        with mock.patch.object(main, 'ThermalCamera', side_effect=OSError('no camera')):
            self.assertFalse(main.init_thermal())
        self.assertTrue(closed, 'init_thermal replaced a live camera without closing it')
        self.assertIsNone(main._thermal_camera)

    def test_a_camera_that_never_delivers_gets_reopened(self):
        # The headline behaviour: reads that return None must eventually trip
        # the reopen rather than retrying the same dead descriptor forever.
        opens = []

        class Dead:
            def read_frame(self):
                return None

            def close(self):
                pass

        def fake_init():
            opens.append(True)
            main._set_thermal_camera(Dead())
            return True

        waits = []

        def bounded_wait(seconds):
            waits.append(seconds)
            # Hard cap so a regression hangs the suite for a moment rather than
            # forever, and stop once the reopen has had room to happen twice.
            if len(opens) >= 2 or len(waits) > 4 * main._THERMAL_REOPEN_AFTER + 20:
                main._stop.set()
            return False

        main._set_thermal_camera(Dead())
        with mock.patch.object(main, 'init_thermal', fake_init), \
             mock.patch.object(main._stop, 'wait', bounded_wait):
            main.thermal_loop()

        self.assertGreaterEqual(len(opens), 1,
                                'the loop retried a dead descriptor forever instead of reopening')

    def test_a_camera_absent_at_boot_is_retried_rather_than_written_off(self):
        # It used to be that init failing at boot meant the thread never started,
        # so a camera that enumerated late was gone for the life of the process.
        attempts = []

        def never_opens():
            attempts.append(True)
            return False

        waits = []

        def bounded_wait(seconds):
            waits.append(seconds)
            if len(attempts) >= 3 or len(waits) > 40:
                main._stop.set()
            return False

        main._set_thermal_camera(None)
        with mock.patch.object(main, 'init_thermal', never_opens), \
             mock.patch.object(main._stop, 'wait', bounded_wait):
            main.thermal_loop()

        self.assertGreaterEqual(len(attempts), 2,
                                'a camera missing at boot is only tried once')
        self.assertGreater(max(waits), 5.0,
                           'the reopen backoff does not grow, so a missing camera is '
                           'retried in a tight loop forever')
if __name__ == '__main__':
    unittest.main()
