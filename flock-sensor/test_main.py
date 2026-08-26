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

        Twenty by sixteen raw pixels, which at the default bin of 2 is 80
        analysis cells. The 24x32 version of these tests used a 3x3 blob;
        on a 160x120 grid a 3x3 blob is a speck, and that difference is the
        whole reason THERMAL_MIN_CLUSTER had to move.

        The size is derived from lens geometry, not measured against a body.
        See count_thermal_clusters.
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

    def test_two_warm_regions_touching_at_a_corner_are_one_cluster(self):
        # Eight-connectivity, where the coarse sensor used four. At this
        # resolution one person can break into pieces that touch diagonally
        # (bare head, covered torso), and four-connectivity would report them
        # as two people. UNVERIFIED against a real body: this pins the
        # algorithm's behaviour, not its accuracy.
        f = self.frame(20.0, [(10, 10, 20, 16, 34.0), (30, 26, 20, 16, 34.0)])
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


if __name__ == '__main__':
    unittest.main()
