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
import hashlib
import io
import json
import os
import re
import struct
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

    def test_the_thermal_pair_is_the_derived_pair(self):
        # These two are one setting in two variables: min_cluster counts bin
        # cells, so moving either one silently redefines the other. The bin is
        # the 2026-09-06 bench's 4, which merges a person's head and torso into
        # one region. The minimum was then re-derived from 12, a whole body, to
        # 6, a head at venue range, because 12 counted nobody who was partly
        # out of frame. The reasoning is written out at THERMAL_MIN_CLUSTER.
        # Moving either again means re-deriving both.
        self.assertEqual((main.THERMAL_BIN, main.THERMAL_MIN_CLUSTER), (4, 6),
                         'the thermal pair moved off the derived combination')

    def test_a_head_on_its_own_now_counts(self):
        # The case the old whole-body minimum missed: one warm head-sized patch,
        # the rest of the person out of shot or behind something.
        f = self.frame(20.0, [(40, 60, 12, 10, 34.0)])
        self.assertEqual(main.count_thermal_clusters(f), 1)

    def test_a_small_person_is_still_not_noise(self):
        # Lowering the minimum must not lower it into the sensor's own floor.
        raw = main.THERMAL_MIN_CLUSTER * main.THERMAL_BIN * main.THERMAL_BIN
        self.assertGreaterEqual(raw, 2 * main._MIN_SANE_THRESHOLD_PIXELS)

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
            # The fallback is whatever pair is current, not a literal: pinning
            # it here as (4, 12) outlived the minimum being re-derived to 6.
            self.assertEqual((binned, minimum), (main._MEASURED_BIN, main._MEASURED_MIN_CLUSTER))
            self.assertIn('counts nobody', complaint)

    def test_a_coarse_bin_is_allowed_when_the_minimum_comes_down_with_it(self):
        # The product is what matters, not the bin. 8 x 6^2 is 288 pixels, inside
        # the band, so that pair is a legitimate choice and is left alone.
        self.assertEqual(main.validated_thermal_pair(6, 8), (6, 8, None))

    def test_a_threshold_inside_the_noise_is_refused(self):
        binned, minimum, complaint = main.validated_thermal_pair(1, 12)
        self.assertEqual((binned, minimum), (main._MEASURED_BIN, main._MEASURED_MIN_CLUSTER))
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
    def __init__(self, size=(1, 1), *_flags):
        self.size = size
        self.blits = 0

    def fill(self, _colour):
        pass

    def blit(self, _what, _where):
        self.blits += 1

    def get_width(self):
        return self.size[0]

    def get_height(self):
        return self.size[1]


class _FakeFont:
    def __init__(self, *_a, **_k):
        pass

    def render(self, text, _aa, _colour):
        return _FakeSurface((max(1, len(text)) * 10, 20))

    def get_height(self):
        return 20


class _FakePygame:
    """Just enough pygame to run draw_thermal_view on a machine without one.

    It also records every call, which is how the no-file-written assertion below
    is made: if a future version of the view ever reaches for image.save, this
    stub is where it shows up.
    """

    MOUSEBUTTONDOWN = 1025
    FINGERDOWN = 1792
    QUIT = 256
    SRCALPHA = 65536

    def __init__(self):
        self.calls = []
        self.image = self._Image(self)
        self.transform = self._Transform(self)
        self.draw = self._Draw(self)
        self.font = self._Font()

    class _Font:
        Font = _FakeFont

    def Surface(self, size, *flags):
        return _FakeSurface(size)

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

        def line(self, *a, **k):
            self.outer.calls.append(('line',))

        def lines(self, *a, **k):
            self.outer.calls.append(('lines',))

        def circle(self, *a, **k):
            self.outer.calls.append(('circle',))


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
        main.Panel(pg, screen, 1024, 600).thermal(self.frame(), 2, True)
        self.assertGreater(screen.blits, 3)
        self.assertTrue(any(c[0] == 'frombuffer' for c in pg.calls))

    def test_it_survives_having_no_frame_yet(self):
        # The first seconds after boot, and any venue unit that somehow has a
        # screen. Crashing here drops the whole display thread.
        pg = _FakePygame()
        screen = _FakeSurface()
        fonts = (_FakeFont(), _FakeFont(), _FakeFont())
        main.Panel(pg, screen, 1024, 600).thermal(None, 0, False)
        self.assertGreater(screen.blits, 0)

    def test_nothing_in_the_view_writes_an_image(self):
        pg = _FakePygame()
        main.Panel(pg, _FakeSurface((1024, 600)), 1024, 600).thermal(self.frame(), 1, True)
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
        #
        # Every screen is drawn inside one try, and a failure in any of them
        # falls back to home, which is the one screen that always works. That
        # is stronger than the version this replaced, which wrapped only the
        # thermal view.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        loop = source[source.index('def display_loop():'):]
        dispatch = loop.index("if view == 'thermal':")
        before = loop[max(0, dispatch - 200):dispatch]
        after = loop[dispatch:dispatch + 1400]
        self.assertIn('try:', before, 'the screen dispatch is not inside a try')
        self.assertIn('except Exception', after)
        self.assertIn("view = 'home'", after,
                      'a failing screen does not fall back to home')
        self.assertIn('ui.home(', after[after.index('except Exception'):],
                      'the fallback does not actually draw the home screen')
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
class SoundPressureEstimate(unittest.TestCase):
    """One anchor turns the index into an estimated dB SPL, and shows the limit.

    The slope is not a fitted parameter, it is the capsule's sensitivity: a
    fixed volts per pascal means 20 dB of sound pressure is ten times the
    voltage and therefore ten times the counts. So one measured point pins the
    whole curve, and the interesting output is not the estimate itself but the
    window: on this hardware the gap between the electrical noise floor and the
    converter clipping is about 25 to 30 dB, and a venue spans closer to 45.
    """

    ANCHOR_COUNTS, ANCHOR_DB = 150.0, 75.0

    def test_an_unanchored_unit_estimates_nothing(self):
        # Better than guessing. A unit nobody has measured cannot know where it
        # sits on an absolute scale, and saying so beats inventing a number.
        self.assertIsNone(main.spl_from_counts(100.0, 0.0, 0.0))
        self.assertIsNone(main.hearing_window(15.5, 0.0, 0.0))

    def test_the_anchor_point_returns_itself(self):
        got = main.spl_from_counts(self.ANCHOR_COUNTS, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        self.assertAlmostEqual(got, self.ANCHOR_DB, places=6)

    def test_ten_times_the_counts_is_twenty_more_decibels(self):
        # The physics the single anchor rests on. If this ever stops holding,
        # the one-point calibration is no longer valid.
        low = main.spl_from_counts(10.0, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        high = main.spl_from_counts(100.0, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        self.assertAlmostEqual(high - low, 20.0, places=6)

    def test_silence_has_no_decibel_value(self):
        self.assertIsNone(main.spl_from_counts(0.0, self.ANCHOR_COUNTS, self.ANCHOR_DB))
        self.assertIsNone(main.spl_from_counts(-5.0, self.ANCHOR_COUNTS, self.ANCHOR_DB))

    def test_the_measured_floor_puts_a_quiet_venue_below_hearing(self):
        # The finding that matters. At the floor this unit actually has, an
        # empty cafe at 45 to 55 dBA is under the bottom of the window and
        # reads as silence.
        low, high = main.hearing_window(15.5, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        self.assertGreater(low, 50.0)
        self.assertLess(high - low, 35.0)

    def test_removing_electrical_noise_is_what_widens_the_window(self):
        # Not the gain. Gain multiplies the floor and the signal by the same
        # amount, so it slides the window without widening it. This is the
        # whole argument for treating the noise floor as the blocker.
        narrow = main.hearing_window(15.5, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        wide = main.hearing_window(4.0, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        self.assertGreater(wide[1] - wide[0], narrow[1] - narrow[0] + 10.0)
        self.assertAlmostEqual(wide[1], narrow[1], places=6,
                               msg='the top of the window moved, so this is not a floor change')

    def test_the_top_of_the_window_is_where_the_converter_clips(self):
        _, high = main.hearing_window(15.5, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        at_clip = main.spl_from_counts(main.ADC_CLIP_RMS, self.ANCHOR_COUNTS, self.ANCHOR_DB)
        self.assertAlmostEqual(high, at_clip, places=6)

    def test_the_defaults_leave_it_switched_off(self):
        self.assertEqual(main.NOISE_SPL_ANCHOR_COUNTS, 0.0)
        self.assertEqual(main.NOISE_SPL_ANCHOR_DB, 0.0)


class NoiseSampleRate(unittest.TestCase):
    """How far apart the microphone's reads are taken.

    A 1ms sleep once held the loop to about 650 reads a second, and it was
    removed on the belief that the slow rate aliased the room into a scrambled
    RMS. Aliasing moves sound to other frequencies without changing the RMS of
    the samples, so the rate was never the problem. Reading back to back was:
    on the first unit, 2026-09-28, forty reads 2ms apart in a quiet room spread
    67 counts, about 15 rms, and back-to-back bursts in the same room seconds
    later read 41. The gap is a setting now, and --listen measures it.
    """

    def test_the_default_gap_is_the_spacing_that_measured_clean(self):
        self.assertEqual(main.DEFAULTS['NOISE_SAMPLE_GAP_US'], '1000')

    def test_the_burst_is_bounded_in_both_time_and_count(self):
        self.assertGreater(main.NOISE_BURST_SECONDS, 0.0)
        self.assertGreater(main.NOISE_MAX_SAMPLES, 500)

    def reads(self, gap_us, seconds=0.05):
        with mock.patch.object(main, '_read_mcp3008_ch0', return_value=512):
            return len(main.noise_burst(seconds=seconds, gap_us=gap_us))

    def test_a_gap_spaces_the_reads(self):
        # 50ms at 2ms apart is at most 25 reads, at 250us at most 200.
        self.assertLessEqual(self.reads(2000), 26)
        self.assertLessEqual(self.reads(250), 201)
        self.assertGreater(self.reads(0), 200)

    def test_the_calibration_reads_where_the_readings_stop_moving(self):
        # A steady podcast read 39 back to back, 63 at 250us, 72 at 1ms and 75
        # at 2ms: the calibration reads at 1ms, and so does a fresh unit.
        self.assertEqual(main.CALIBRATION_GAP_US, 1000.0)
        self.assertEqual(float(main.DEFAULTS['NOISE_SAMPLE_GAP_US']), main.CALIBRATION_GAP_US)

    def test_no_spacing_is_picked_by_how_quiet_it_reads(self):
        # Picking the quietest spacing picked the one that hid the voice.
        self.assertFalse(hasattr(main, 'pick_sample_gap'))

    def test_the_resting_offset_is_not_counted_as_sound(self):
        # The first unit rests at 518 against a midpoint of 512.
        raw = [a + 6.0 for a in [10.0, -10.0] * 50]
        self.assertAlmostEqual(main.burst_rms(raw), 10.0, places=6)
        about_the_midpoint = (sum(r * r for r in raw) / len(raw)) ** 0.5
        self.assertGreater(about_the_midpoint, 11.0)


class QuietIsKnown(unittest.TestCase):
    """A room with nothing in it flipped between Quiet and Moderate.

    Three things put it there, found on the first unit on 2026-09-28: a noise
    floor tripled by reading back to back (NoiseSampleRate), a scale set from
    the single quietest burst so the room's ordinary quiet sat at 47 against a
    line at 50, and a panel that led with one 100ms burst.
    """

    # The --listen run that showed it: a quiet room wandering 34 to 48, and
    # three claps.
    QUIET = [41.0, 38.7, 41.8, 43.3, 44.7, 34.0, 42.3, 38.5, 39.8, 46.0,
             40.2, 41.5, 41.0, 40.1, 48.1, 38.1, 38.6, 46.2, 39.7, 43.8] * 5
    RUN = QUIET + [121.8, 90.0, 125.2]

    def resting_level(self, floor, max_scale=None):
        ref, scale = main.recommend_noise_settings(floor, max(self.RUN), max_scale=max_scale)
        middle = sorted(self.QUIET)[len(self.QUIET) // 2]
        return main.compute_noise_db([middle], ref_counts=ref, scale=scale)

    def test_quiet_is_set_from_the_room_at_rest(self):
        floor = main.typical_quiet(self.RUN)
        self.assertGreater(floor, min(self.RUN) + 3)
        self.assertLess(self.resting_level(floor), 47.0)

    def test_setting_it_from_the_quietest_burst_put_the_room_on_the_line(self):
        # Uncapped, as it was then.
        self.assertGreater(self.resting_level(min(self.RUN), max_scale=10.0), 46.0)

    def test_a_run_with_nothing_loud_in_it_sets_no_scale(self):
        # 14.3 against 15.8 would have asked for a scale of 59.
        self.assertIsNone(main.recommend_noise_settings(14.3, 15.8))
        ref, scale = main.recommend_noise_settings(15.0, 125.0)
        self.assertLessEqual(scale, 10.0)

    def test_an_old_calibration_keeps_reading_the_way_it_was_measured(self):
        # 44.1 and 4.42 were written before the gap existed.
        self.assertTrue(main.calibration_predates_gap(44.1, 4.42, gap_was_set=False))
        self.assertFalse(main.calibration_predates_gap(25.7, 2.03, gap_was_set=True))
        # An uncalibrated unit has nothing to protect.
        self.assertFalse(main.calibration_predates_gap(1.0, 1.0, gap_was_set=False))

    def test_nothing_heard_sets_nothing(self):
        self.assertIsNone(main.typical_quiet([]))

    def test_the_word_holds_until_the_level_is_clearly_past_the_line(self):
        held, words = None, []
        for value in (45, 51, 52.9, 53.1, 48, 47.1, 46.9):
            held = main.held_noise_band(value, held)[0]
            words.append(held)
        self.assertEqual(words, ['Quiet', 'Quiet', 'Quiet', 'Moderate',
                                 'Moderate', 'Moderate', 'Quiet'])

    def test_a_real_jump_changes_the_word_at_once(self):
        self.assertEqual(main.held_noise_band(92.0, 'Quiet')[0], 'Loud')

    def test_a_held_word_keeps_its_own_colour(self):
        self.assertEqual(main.held_noise_band(51.0, 'Quiet'), main.noise_band(40.0))

    def test_one_burst_of_hiss_does_not_change_the_panel(self):
        self.assertEqual(main.live_level([40.0, 55.0, 40.0], 0.0), 40.0)

    def test_a_sound_lasting_a_second_shows_at_once(self):
        self.assertEqual(main.live_level([40.0, 95.0, 96.0], 0.0), 95.0)

    def test_no_bursts_falls_back_to_the_minute_figure(self):
        self.assertEqual(main.live_level([], 44.0), 44.0)

    def test_a_stretched_scale_does_not_make_a_still_room_look_busy(self):
        minute = [40.0, 44.0, 47.0, 41.0, 38.0, 45.0] * 20
        self.assertEqual(main.noise_insight(minute, scale=4.42)['character'], 'steady')
        self.assertEqual(main.noise_insight(minute, scale=1.0)['character'], 'changing')


class CalibrateByEar(unittest.TestCase):
    """--listen --write: quiet, then talking, then a clap.

    The free-running calibration set the scale from the loudest burst it
    heard. On the first unit that was a voice at 58 against a quiet room at 27,
    and it stretched the scale to 7.3, so every breath changed the word.
    """

    def run_it(self, quiet, talk, claps, write=True):
        phases = iter([[(r, False) for r in quiet], [(r, False) for r in talk], claps])
        cfg = Path(tempfile.mkdtemp()) / 'flock_sensor.env'
        cfg.write_text('DEVICE_ID=sensor_001\n')
        with mock.patch.object(main, '_collect_bursts', side_effect=lambda s: next(phases)), \
                mock.patch.object(main.time, 'sleep'), \
                mock.patch.object(main, 'CONFIG_PATH', cfg), \
                mock.patch.object(main, 'NOISE_SAMPLE_GAP_US', 250.0), \
                mock.patch('builtins.print'):
            code = main.calibrate_by_ear(write=write)
        return code, main._parse_config_text(cfg.read_text())

    def level(self, cfg, rms):
        return main.compute_noise_db([rms], ref_counts=float(cfg['NOISE_REF_COUNTS']),
                                     scale=float(cfg['NOISE_SCALE']))

    def test_quiet_reads_quiet_and_talking_reads_moderate(self):
        code, cfg = self.run_it([16.0] * 16, [45.0] * 16, [(150.0, True)])
        self.assertEqual(code, 0)
        self.assertAlmostEqual(self.level(cfg, 16.0), 40.0, delta=0.5)
        self.assertAlmostEqual(self.level(cfg, 45.0), 60.0, delta=0.5)
        # Calibrated at 1ms whatever the unit was set to, and written as such.
        self.assertEqual(cfg['NOISE_SAMPLE_GAP_US'], '1000')

    def test_the_run_that_asked_for_seven_is_held_at_the_cap(self):
        code, cfg = self.run_it([27.0] * 16, [45.0] * 16, [(58.6, False)])
        self.assertEqual(code, 0)
        self.assertEqual(float(cfg['NOISE_SCALE']), main.NOISE_MAX_SCALE)
        self.assertEqual(main.noise_band(self.level(cfg, 27.0))[0], 'Quiet')
        self.assertEqual(main.noise_band(self.level(cfg, 45.0))[0], 'Moderate')

    def test_a_voice_the_microphone_cannot_hear_writes_nothing(self):
        code, cfg = self.run_it([27.0] * 16, [28.0] * 16, [(40.0, False)])
        self.assertEqual(code, 1)
        self.assertNotIn('NOISE_SCALE', cfg)

    def test_the_pure_arithmetic(self):
        self.assertIsNone(main.recommend_from_talk(27.0, 30.0))
        self.assertIsNone(main.recommend_from_talk(0.0, 30.0))
        ref, scale = main.recommend_from_talk(16.0, 45.0)
        self.assertLess(scale, main.NOISE_MAX_SCALE)

    def test_the_meter_alone_writes_nothing(self):
        # Only the guided run writes; the free-running meter is for looking.
        body = NoiseCadence.body(NoiseCadence, 'listen')
        self.assertEqual(body.count('CONFIG_PATH.write_text'), 0)
        self.assertIn('return calibrate_by_ear()', body)


class NoiseWindowTrim(unittest.TestCase):
    """A slammed door owned a sixth of the published loudness.

    Professional noise monitoring reports percentile levels rather than a mean,
    because a mean is owned by its loudest member and how busy a room feels is a
    question about the level it persistently sits at. A burst is 100ms, which is
    long enough for one door slam to own it entirely.
    """

    def test_a_single_loud_burst_does_not_move_a_steady_room(self):
        steady = [45.0] * 11
        self.assertAlmostEqual(main.trimmed_mean(steady), 45.0, places=6)
        with_slam = steady + [95.0]
        self.assertAlmostEqual(main.trimmed_mean(with_slam), 45.0, places=6)
        plain = sum(with_slam) / len(with_slam)
        self.assertGreater(plain - main.trimmed_mean(with_slam), 3.0,
                           'the trim is not actually rejecting the transient')

    def test_a_genuinely_louder_room_still_reads_louder(self):
        # The trim must reject one outlier, not flatten a real change.
        quiet = main.trimmed_mean([45.0] * 12)
        busy = main.trimmed_mean([70.0] * 12)
        self.assertGreater(busy - quiet, 20.0)

    def test_it_falls_back_to_a_plain_mean_before_the_window_fills(self):
        # The first minute after a start or a camera reopen.
        self.assertAlmostEqual(main.trimmed_mean([40.0, 90.0]), 65.0, places=6)
        self.assertEqual(main.trimmed_mean([]), 0.0)

    def test_the_window_is_long_enough_to_have_something_to_trim(self):
        self.assertGreaterEqual(main._state['noise_window'].maxlen,
                                2 * main.NOISE_WINDOW_TRIM + 3)

    def test_the_loop_publishes_the_trimmed_figure_not_a_mean(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertIn("_state['noise_db'] = trimmed_mean(", source,
                      'the published loudness is a plain mean again')


class ChannelHealth(unittest.TestCase):
    """A dead sensor and an empty room published the same payload.

    The last version of the problem that ran through every fix on this device:
    0 is overloaded. On a venue card that is wrong for a while. In the training
    corpus it is worse, because a run of zeros from a wedged camera cannot be
    told from a run of zeros from a genuinely empty Tuesday, and the model
    learns the venue is quiet when the sensor is broken.
    """

    def setUp(self):
        for k in main._stale_streaks:
            main._stale_streaks[k] = 0

    tearDown = setUp

    def test_a_current_reading_leaves_the_streak_at_zero(self):
        main._fresh(5, time.monotonic(), 90, 'Thermal headcount')
        self.assertEqual(main.channel_health()['thermal'], 0)

    def test_a_stale_reading_is_counted(self):
        main._fresh(5, 0, 90, 'Thermal headcount')
        main._fresh(5, 0, 90, 'Thermal headcount')
        self.assertEqual(main.channel_health()['thermal'], 2)

    def test_a_sensor_that_dies_while_the_room_is_empty_is_still_counted(self):
        # The case the old warning stayed silent about: it only spoke when there
        # was a non-zero value to complain about losing, so a camera that failed
        # during a quiet hour failed invisibly.
        main._fresh(0, 0, 90, 'Thermal headcount')
        self.assertEqual(main.channel_health()['thermal'], 1)

    def test_recovery_clears_it(self):
        main._fresh(5, 0, 90, 'Thermal headcount')
        self.assertEqual(main.channel_health()['thermal'], 1)
        main._fresh(5, time.monotonic(), 90, 'Thermal headcount')
        self.assertEqual(main.channel_health()['thermal'], 0)

    def test_the_channels_are_counted_separately(self):
        main._fresh(5, 0, 90, 'Thermal headcount')
        self.assertEqual(main.channel_health()['noise'], 0)
        main._fresh(5.0, 0, 60, 'Noise level')
        self.assertEqual(main.channel_health()['noise'], 1)

    def test_the_key_does_not_depend_on_the_display_wording(self):
        # The callers pass display names. If somebody rewords one, the counter
        # must not silently stop counting that channel.
        main._fresh(5, 0, 90, 'Thermal headcount')
        main._fresh(5, 0, 90, 'Thermal something else entirely')
        self.assertEqual(main.channel_health()['thermal'], 2)

    def test_the_push_says_what_its_zeros_mean(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        self.assertIn('channel_health()', source)
        self.assertIn("log_throttled('channel_health'", source,
                      'a stale channel is invisible to an operator again')


class CrossingSensorWiring(unittest.TestCase):
    """The crossing sensor diagnoses its own wiring, because the microphone did not.

    An evening went on the microphone, and almost all of it went on not knowing
    which half of the problem to look at. Every way a crossing sensor can be
    wrong is visible in the pattern of one pin, so --beam names which one it is
    rather than leaving somebody to guess between a dead part, the wrong pin,
    and a part wired the other way up.
    """

    def test_a_pin_that_never_moves_is_not_wired(self):
        ok, why = main.diagnose_beam([True] * 200, active_low=True)
        self.assertFalse(ok)
        self.assertIn('never changed', why)

    def test_a_pin_stuck_blocked_names_the_polarity_setting(self):
        ok, why = main.diagnose_beam([False] * 200, active_low=True)
        self.assertFalse(ok)
        self.assertIn('IR_ACTIVE_LOW', why)

    def test_a_part_wired_the_other_way_up_is_caught_before_it_is_total(self):
        # The likely real-world version: mostly triggered, occasionally not. A
        # doorway is not blocked 90% of the time; a backwards part looks exactly
        # like that, and a check that only caught the 100% case would miss it.
        ok, why = main.diagnose_beam([False] * 180 + [True] * 20, active_low=True)
        self.assertFalse(ok)
        self.assertIn('IR_ACTIVE_LOW', why)

    def test_a_working_sensor_passes(self):
        ok, _ = main.diagnose_beam([True] * 170 + [False] * 30, active_low=True)
        self.assertTrue(ok)

    def test_it_reads_the_other_polarity_the_other_way(self):
        # The same samples mean the opposite thing for an active-high part.
        # Getting this backwards would have the tool confidently name the wrong
        # fault, which is worse than saying nothing.
        mostly_high = [True] * 180 + [False] * 20
        self.assertFalse(main.diagnose_beam(mostly_high, active_low=False)[0])
        self.assertTrue(main.diagnose_beam(mostly_high, active_low=True)[0])

    def test_no_samples_is_not_a_pass(self):
        self.assertFalse(main.diagnose_beam([])[0])

    def test_the_pin_and_polarity_are_configurable(self):
        # All three were hardcoded, which meant a part signalling the other way
        # round needed a code change before it would work at all.
        self.assertEqual(main.IR_GPIO_PIN, 17)
        self.assertTrue(main.IR_ACTIVE_LOW)
        self.assertGreater(main.IR_DEBOUNCE_SECONDS, 0.0)

    def test_init_reads_the_configured_pin_not_a_literal(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        idx = source.index('def init_ir():')
        window = source[idx:idx + 2200]
        self.assertIn('GPIO.setup(IR_GPIO_PIN', window,
                      'the crossing sensor pin is hardcoded again')
        self.assertIn('IR_ACTIVE_LOW', window)

    def test_the_resting_pull_follows_the_polarity(self):
        # An unpowered or unconnected sensor has to rest quiet. Pulled the wrong
        # way it floats at the triggered level and counts noise as a crowd.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        idx = source.index('def init_ir():')
        window = source[idx:idx + 2200]
        self.assertIn('GPIO.PUD_UP if IR_ACTIVE_LOW else GPIO.PUD_DOWN', window)
class PanelLayout(unittest.TestCase):
    """The layout is computed from the panel, because the panel changed.

    The code hardcoded 720x1280, a portrait DSI screen an early build plan
    named. The panel actually bought is a 7 inch 1024x600 HDMI screen. Three
    stacked blocks at the old sizes needed 912 pixels of height, so on the real
    panel the third ran off the bottom and the chart drew through the second,
    and none of that was visible from reading the code.
    """

    PANELS = [(1024, 600), (720, 1280), (800, 480), (480, 800)]

    def test_nothing_is_drawn_past_the_bottom_of_any_panel(self):
        for w, h in self.PANELS:
            m = main.display_metrics(w, h)
            self.assertLessEqual(m['block_top'] + m['block_h'], m['chart_top'],
                                 f'blocks reach the chart at {w}x{h}')
            self.assertLessEqual(m['chart_bottom'], h, f'chart past the edge at {w}x{h}')
            self.assertGreater(m['block_h'], 0, f'no room for a block at {w}x{h}')

    def test_the_three_readings_never_overlap(self):
        for w, h in self.PANELS:
            m = main.display_metrics(w, h)
            boxes = [main.block_origin(m, i) for i in range(3)]
            for a, b in zip(boxes, boxes[1:]):
                if m['columns']:
                    self.assertEqual(b[1], a[1], f'columns drifted vertically at {w}x{h}')
                    self.assertGreaterEqual(b[0] - a[0], m['block_w'],
                                            f'columns overlap at {w}x{h}')
                else:
                    self.assertEqual(b[0], a[0], f'rows drifted sideways at {w}x{h}')
                    self.assertGreaterEqual(b[1] - a[1], m['block_h'],
                                            f'rows overlap at {w}x{h}')

    def test_every_reading_stays_inside_the_panel(self):
        for w, h in self.PANELS:
            m = main.display_metrics(w, h)
            for i in range(3):
                x, y = main.block_origin(m, i)
                self.assertLessEqual(x + m['block_w'], w, f'block {i} past the right at {w}x{h}')
                self.assertLessEqual(y + m['block_h'], m['chart_top'] + 1,
                                     f'block {i} past the chart at {w}x{h}')

    def test_a_wide_panel_gets_columns_and_a_tall_one_gets_rows(self):
        # The whole reason both layouts exist. Three stacked blocks do not fit
        # 600 pixels of height, and three columns on a 480 wide portrait panel
        # give each number 150 pixels, which a three digit count overflows.
        self.assertTrue(main.display_metrics(1024, 600)['columns'])
        self.assertTrue(main.display_metrics(800, 480)['columns'])
        self.assertFalse(main.display_metrics(720, 1280)['columns'])
        self.assertFalse(main.display_metrics(480, 800)['columns'])

    def test_the_default_matches_the_panel_that_was_actually_bought(self):
        self.assertEqual((main.DISPLAY_W, main.DISPLAY_H), (1024, 600))

    def test_text_stays_readable_on_a_small_panel(self):
        # Scaling purely by height would make the captions 12 pixels tall on a
        # 480 pixel panel, which is unreadable from across a room, which is the
        # only distance this screen is ever read from.
        for w, h in self.PANELS:
            m = main.display_metrics(w, h)
            self.assertGreaterEqual(m['font_xs'], 18, f'caption too small at {w}x{h}')
            self.assertGreater(m['font_big'], m['font_med'], f'hierarchy inverted at {w}x{h}')
            self.assertGreater(m['font_med'], m['font_sm'], f'hierarchy inverted at {w}x{h}')


class ThermalImageFit(unittest.TestCase):
    """The hero screen has to fit the window it is drawn into."""

    def test_the_image_never_exceeds_the_space_it_is_given(self):
        for w, h in PanelLayout.PANELS:
            m = main.display_metrics(w, h)
            reserve = m['font_sm'] + m['font_med'] + m['font_xs'] * 2 + m['pad'] * 3
            iw, ih = main.thermal_image_box(w, h, 160, 120, m['pad'],
                                            m['header_h'], reserve)
            self.assertLessEqual(iw, w - 2 * m['pad'], f'image too wide at {w}x{h}')
            self.assertLessEqual(m['header_h'] + ih, h - reserve + 1,
                                 f'image overruns the text at {w}x{h}')

    def test_it_keeps_the_cameras_shape(self):
        # A stretched thermal image reads as a bug to anybody who has seen one,
        # and this is the screen the pitch turns on.
        for w, h in PanelLayout.PANELS:
            m = main.display_metrics(w, h)
            iw, ih = main.thermal_image_box(w, h, 160, 120, m['pad'], m['header_h'], 200)
            self.assertAlmostEqual(iw / float(ih), 160 / 120.0, delta=0.04,
                                   msg=f'aspect ratio lost at {w}x{h}')

    def test_the_old_bug_would_fail_this(self):
        # The previous code set the width to the panel width and derived the
        # height from it, with no check that the result fit. On the real panel
        # that asked for 714 pixels of height inside 600.
        m = main.display_metrics(1024, 600)
        naive_h = int((1024 - 2 * m['pad']) * 120 / 160.0)
        self.assertGreater(naive_h, 600, 'this test no longer reproduces the bug')
        _, ih = main.thermal_image_box(1024, 600, 160, 120, m['pad'], m['header_h'], 200)
        self.assertLess(ih, 600)
def _tof_frame(floor=2500, people=()):
    """An 8x8 frame of distances: empty floor, with heads punched into it.

    Each person is (row, col) and lights a 2x2 block, which is about what a
    shoulder span covers at doorway range.
    """
    f = [floor] * 64
    for (r, c) in people:
        for dr in (0, 1):
            for dc in (0, 1):
                rr, cc = r + dr, c + dc
                if 0 <= rr < 8 and 0 <= cc < 8:
                    f[rr * 8 + cc] = floor - 1000
    return f


class DoorwayCounting(unittest.TestCase):
    """Reading the grid, before anything is tracked through it."""

    def test_an_empty_doorway_has_nobody_in_it(self):
        self.assertEqual(main.tof_occupied(_tof_frame(), 2500), [])

    def test_a_failed_zone_is_empty_not_touching_the_lens(self):
        # The sensor reports an invalid measurement as 0. Read as a distance
        # that is a person pressed against the glass, which is the single most
        # expensive misreading available here: an unplugged sensor would count
        # a permanent crowd.
        f = _tof_frame()
        for i in range(0, 64, 7):
            f[i] = 0
        self.assertEqual(main.tof_occupied(f, 2500), [])

    def test_a_person_lights_a_cluster(self):
        occ = main.tof_occupied(_tof_frame(people=[(3, 3)]), 2500)
        self.assertEqual(len(occ), 4)
        self.assertEqual(len(main.tof_clusters(occ)), 1)

    def test_two_people_abreast_are_two_clusters(self):
        # The entire reason this part replaced a break beam. A beam counts this
        # once; the published figure for a single beam on pairs is about 85%.
        occ = main.tof_occupied(_tof_frame(people=[(3, 1), (3, 5)]), 2500)
        self.assertEqual(len(main.tof_clusters(occ)), 2)

    def test_two_people_touching_are_one_cluster_and_that_is_honest(self):
        # Shoulder to shoulder with no gap, this cannot separate them, and it
        # says so rather than inventing a split. Pretending otherwise is how a
        # counter gets tuned until it agrees with whatever was hoped for.
        occ = main.tof_occupied(_tof_frame(people=[(3, 3), (3, 4)]), 2500)
        self.assertEqual(len(main.tof_clusters(occ)), 1)

    def test_one_stray_zone_is_not_a_person(self):
        f = _tof_frame()
        f[27] = 1200
        self.assertEqual(main.tof_clusters(main.tof_occupied(f, 2500)), [])

    def test_a_diagonal_body_is_one_person(self):
        # Eight-connectivity, same as the thermal counter. Four-connectivity
        # splits somebody standing at an angle into two.
        occ = [0, 9, 18]
        self.assertEqual(len(main.tof_clusters(occ, min_cluster=3)), 1)


class DoorwayDirection(unittest.TestCase):
    """Which way somebody went, which a break beam cannot answer at all."""

    @staticmethod
    def walk(tracker, rows, col=3):
        for r in rows:
            occ = main.tof_occupied(_tof_frame(people=[(r, col)]), 2500)
            tracker.observe(main.tof_clusters(occ))

    def test_walking_one_way_counts_an_entry(self):
        t = main.CrossingTracker()
        self.walk(t, [0, 1, 2, 3, 4, 5, 6])
        self.assertEqual((t.entries, t.exits), (1, 0))

    def test_walking_the_other_way_counts_an_exit(self):
        t = main.CrossingTracker()
        self.walk(t, [6, 5, 4, 3, 2, 1, 0])
        self.assertEqual((t.entries, t.exits), (0, 1))

    def test_somebody_who_turns_back_is_not_counted(self):
        # Steps into the doorway, changes their mind, leaves the way they came.
        # A break beam counts that as two people. It is nobody.
        t = main.CrossingTracker()
        self.walk(t, [0, 1, 2, 2, 1, 0])
        self.assertEqual((t.entries, t.exits), (0, 0))
        self.assertEqual(t.net, 0)

    def test_two_people_abreast_count_as_two(self):
        t = main.CrossingTracker()
        for r in [0, 1, 2, 3, 4, 5, 6]:
            occ = main.tof_occupied(_tof_frame(people=[(r, 1), (r, 5)]), 2500)
            t.observe(main.tof_clusters(occ))
        self.assertEqual(t.entries, 2)

    def test_one_in_one_out_leaves_the_room_as_it_was(self):
        t = main.CrossingTracker()
        self.walk(t, [0, 1, 2, 3, 4, 5, 6], col=1)
        self.walk(t, [6, 5, 4, 3, 2, 1, 0], col=5)
        self.assertEqual((t.entries, t.exits), (1, 1))
        self.assertEqual(t.net, 0)

    def test_the_room_never_holds_a_negative_number_of_people(self):
        # A unit switched on mid-service sees people leave who it never saw
        # arrive. The count is a floor, not a truth, and a negative headcount
        # on a venue card would be worse than a low one.
        t = main.CrossingTracker()
        self.walk(t, [6, 5, 4, 3, 2, 1, 0])
        self.assertEqual(t.exits, 1)
        self.assertEqual(t.net, 0)

    def test_a_person_who_vanishes_does_not_haunt_the_doorway(self):
        t = main.CrossingTracker()
        self.walk(t, [0, 1, 2])
        for _ in range(main.TOF_TRACK_MISSES + 1):
            t.observe([])
        self.assertEqual(t.track_count, 0)

    def test_a_brief_occlusion_does_not_split_one_person_into_two(self):
        # Somebody passes behind somebody else for a frame or two. Dropping the
        # track there would count them again when they reappear.
        t = main.CrossingTracker()
        self.walk(t, [0, 1, 2])
        t.observe([])
        self.walk(t, [3, 4, 5, 6])
        self.assertEqual(t.entries, 1)

    def test_nobody_is_counted_for_standing_still_in_the_doorway(self):
        t = main.CrossingTracker()
        self.walk(t, [2] * 40)
        self.assertEqual((t.entries, t.exits), (0, 0))

    def test_the_threshold_and_cluster_floor_are_configurable(self):
        self.assertGreater(main.TOF_MARGIN_MM, 0)
        self.assertGreaterEqual(main.TOF_MIN_CLUSTER, 1)
        self.assertGreater(main.TOF_MAX_JUMP, 0)
class VideoDriverChoice(unittest.TestCase):
    """The panel never lit up, and this is why.

    The code asked SDL for the "fbcon" driver. That is an SDL 1.2 name; SDL2
    dropped it, and asking for a driver SDL2 does not have does not raise, it
    hangs inside set_mode. So the display thread stopped there forever, the log
    line that would have explained it never printed, and from outside the
    program looked like it simply stopped after pygame's banner.

    Every case below is about never asking for a driver that is not there.
    """

    def test_it_never_asks_for_an_sdl_1_driver(self):
        for env in ({}, {'DISPLAY': ':0'}, {'WAYLAND_DISPLAY': 'wayland-0'}):
            got = main.video_driver_candidates(env=env, has_dri=True)
            self.assertNotIn('fbcon', got)
            self.assertNotIn('directfb', got)

    def test_every_candidate_is_a_real_sdl2_driver(self):
        real = {'x11', 'wayland', 'kmsdrm', 'offscreen', 'dummy'}
        for env in ({}, {'DISPLAY': ':0'}, {'WAYLAND_DISPLAY': 'wayland-0'}):
            for d in main.video_driver_candidates(env=env, has_dri=True):
                self.assertIn(d, real, f'{d} is not an SDL2 video driver')

    def test_a_desktop_session_is_tried_before_the_hardware(self):
        # kmsdrm cannot take the screen from a running session, and a Pi
        # showing the desktop is the normal state of a unit somebody just
        # set up.
        got = main.video_driver_candidates(env={'DISPLAY': ':0'}, has_dri=True)
        self.assertEqual(got[0], 'x11')
        got = main.video_driver_candidates(env={'WAYLAND_DISPLAY': 'wl-0'},
                                           has_dri=True)
        self.assertEqual(got[0], 'wayland')

    def test_a_bare_console_goes_straight_to_the_hardware(self):
        got = main.video_driver_candidates(env={}, has_dri=True)
        self.assertEqual(got[0], 'kmsdrm')

    def test_dummy_is_always_the_last_resort(self):
        # Not for a picture. So that a display thread which cannot start is
        # unable to take the doorway counter down with it.
        for env in ({}, {'DISPLAY': ':0'}):
            for dri in (True, False):
                got = main.video_driver_candidates(env=env, has_dri=dri)
                self.assertEqual(got[-1], 'dummy')

    def test_no_graphics_hardware_still_yields_a_choice(self):
        got = main.video_driver_candidates(env={}, has_dri=False)
        self.assertEqual(got, ['dummy'])

    def test_an_explicit_setting_wins_outright(self):
        # So a unit with an unusual panel can be told what to do without a
        # code change, which is the whole reason the old line was wrong: it
        # hardcoded one answer and there was no way to override it.
        got = main.video_driver_candidates(env={'SDL_VIDEODRIVER': 'offscreen',
                                                'DISPLAY': ':0'}, has_dri=True)
        self.assertEqual(got, ['offscreen'])

    def test_the_panel_size_is_asked_for_not_assumed(self):
        # set_mode((0, 0), FULLSCREEN) returns the panel's own size. Naming a
        # size is how a remembered 720x1280 outlived the panel it belonged to.
        #
        # A REAL display is always asked for its own size. The configured size
        # is allowed in exactly one place, the placeholder driver, which has no
        # panel to ask and would otherwise invent SDL's own default.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        opener = source[source.index('def open_display('):source.index('def display_loop():')]
        real, placeholder = opener.split('# Nothing real.', 1)
        self.assertIn('set_mode((0, 0), pygame.FULLSCREEN)', real)
        self.assertNotIn('(DISPLAY_W, DISPLAY_H)', real,
                         'a real panel size is being asserted again instead of asked for')
        self.assertIn('(DISPLAY_W, DISPLAY_H)', placeholder)

    def test_a_dark_panel_does_not_stop_the_sensor(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        idx = source.index('def display_loop():')
        window = source[idx:idx + 2600]
        self.assertIn('if screen is None:', window)
        self.assertIn('return', window)
class PanelTapTargets(unittest.TestCase):
    """A card drawn in one place and hit-tested in another is a button that
    looks pressable and does nothing. Both come from home_cards, and these pin
    that the rectangles are sane on every panel shape."""

    SHAPES = [(1024, 600), (800, 480), (720, 1280), (480, 800)]

    def test_three_cards_every_time(self):
        for w, h in self.SHAPES:
            self.assertEqual(len(main.home_cards(w, h, main.display_metrics(w, h))), 3)

    def test_cards_never_overlap_and_stay_on_the_panel(self):
        for w, h in self.SHAPES:
            cards = main.home_cards(w, h, main.display_metrics(w, h))
            for (x, y, cw, ch) in cards:
                self.assertGreaterEqual(x, 0)
                self.assertGreaterEqual(y, 0)
                self.assertLessEqual(x + cw, w, f'card past the right edge at {w}x{h}')
                self.assertLessEqual(y + ch, h, f'card past the bottom at {w}x{h}')
            for a, b in zip(cards, cards[1:]):
                ax, ay, aw, ah = a
                bx, by, bw, bh = b
                apart = (ax + aw <= bx) or (ay + ah <= by)
                self.assertTrue(apart, f'cards overlap at {w}x{h}')

    def test_the_middle_of_each_card_hits_that_card(self):
        for w, h in self.SHAPES:
            cards = main.home_cards(w, h, main.display_metrics(w, h))
            for i, (x, y, cw, ch) in enumerate(cards):
                self.assertEqual(main.hit_card((x + cw // 2, y + ch // 2), cards), i)

    def test_a_tap_in_the_gutter_opens_nothing(self):
        # Opening the nearest card on a near miss feels helpful and is how a
        # pitch lands on the wrong screen in front of a judge.
        w, h = 1024, 600
        cards = main.home_cards(w, h, main.display_metrics(w, h))
        (x0, y0, w0, h0), (x1, _, _, _) = cards[0], cards[1]
        gutter_x = (x0 + w0 + x1) // 2
        self.assertIsNone(main.hit_card((gutter_x, y0 + h0 // 2), cards))

    def test_cards_are_big_enough_to_hit_with_a_finger(self):
        # Roughly 9 mm is the usual floor for a touch target; on a 7 inch
        # 1024x600 panel that is about 60 pixels.
        for w, h in self.SHAPES:
            for (_, _, cw, ch) in main.home_cards(w, h, main.display_metrics(w, h)):
                self.assertGreaterEqual(min(cw, ch), 60, f'card too small at {w}x{h}')

    def test_the_back_button_fits_inside_the_header(self):
        for w, h in self.SHAPES:
            m = main.display_metrics(w, h)
            x, y, bw, bh = main.back_button_rect(m)
            self.assertGreaterEqual(y, 0)
            self.assertLessEqual(y + bh, m['header_h'])
            self.assertGreaterEqual(bh, 36)

    def test_noise_bands_cover_the_whole_scale_in_order(self):
        words = [main.noise_band(v)[0] for v in (30, 49.9, 50, 69.9, 70, 84.9, 85, 110)]
        self.assertEqual(words, ['Quiet', 'Quiet', 'Moderate', 'Moderate',
                                 'Lively', 'Lively', 'Loud', 'Loud'])

    def test_every_screen_draws_on_a_machine_with_no_panel(self):
        pg = _FakePygame()
        ui = main.Panel(pg, _FakeSurface((1024, 600)), 1024, 600)
        ui.home(3, 2, True, 63.0, True, [1, 2, 3])
        ui.home(0, 0, False, 0.0, False, [])
        ui.door(4, [1, 2, 3])
        ui.door(0, [])
        ui.noise(66.0, True)
        for v in (50, 60, 70):
            ui.trace.append(v)
        ui.noise(66.0, True)
        ui.noise(0.0, False)
        ui.noise(71.0, True, average=64.0)
        ui.splash()
        self.assertFalse([c for c in pg.calls if c[0] == 'save'])
class DecibelAnchor(unittest.TestCase):
    """One phone reading turns the relative level into estimated decibels.

    Everything here is arithmetic, so it is checked without a microphone. The
    one property that matters most: the number, the word and the trace must be
    read on the SAME scale. The first draft took the word from the raw level and
    the number from the estimate, and the panel showed "Moderate" beside "37 dB".
    """

    def setUp(self):
        self._saved = (main.NOISE_SPL_ANCHOR_COUNTS, main.NOISE_SPL_ANCHOR_DB)

    def tearDown(self):
        main.NOISE_SPL_ANCHOR_COUNTS, main.NOISE_SPL_ANCHOR_DB = self._saved

    def anchor(self, counts, db):
        main.NOISE_SPL_ANCHOR_COUNTS, main.NOISE_SPL_ANCHOR_DB = counts, db

    def test_no_anchor_means_no_decibels(self):
        self.anchor(0.0, 0.0)
        self.assertIsNone(main.display_decibels(63.0))
        value, caption, basis = main.noise_reading(63.0)
        self.assertEqual(value, 'level 63')
        self.assertIn('not yet calibrated', caption)
        self.assertEqual(basis, 63.0)

    def test_the_anchor_point_reads_back_exactly(self):
        # Whatever level those counts produce must come back as the phone's
        # reading. If this drifts, every calibrated unit is off by the drift.
        counts = 20.0
        level = main.compute_noise_db([counts, -counts] * 50)
        self.anchor(counts, 62.0)
        self.assertAlmostEqual(main.display_decibels(level), 62.0, places=3)

    def test_ten_times_the_pressure_is_twenty_decibels(self):
        # The physics the one-point calibration rests on.
        self.anchor(20.0, 60.0)
        quiet = main.compute_noise_db([20.0, -20.0] * 50)
        loud = main.compute_noise_db([200.0, -200.0] * 50)
        self.assertAlmostEqual(main.display_decibels(loud) - main.display_decibels(quiet),
                               20.0, places=3)

    def test_the_word_is_read_on_the_same_scale_as_the_number(self):
        # 37 dB is quiet. The level that produces it must not be called
        # Moderate just because the raw index happens to sit in that band.
        self.anchor(150.0, 68.0)
        value, _, basis = main.noise_reading(63.0)
        self.assertTrue(value.endswith('dB'))
        spl = int(value.split()[0])
        self.assertEqual(main.noise_band(basis), main.noise_band(spl))
        self.assertEqual(main.noise_band(basis)[0], 'Quiet')

    def test_a_silent_reading_is_not_turned_into_decibels(self):
        self.anchor(20.0, 60.0)
        self.assertIsNone(main.display_decibels(0.0))

    def test_no_approximately_sign_reaches_the_screen(self):
        # The brand fonts are subsets and do not carry it; it draws as an
        # empty box. Checked 2026-09-26, and the reason the caption says
        # "estimated" in words.
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        panel = source[source.index('class Panel:'):source.index('def display_loop():')]
        self.assertNotIn('\u2248', panel)
        self.assertNotIn(chr(0x2248), panel)


class ConfigRewrite(unittest.TestCase):
    """--anchor --write edits the file that also holds the device's API key.

    So it is tested as a pure function first. Losing a line of that file is how
    a unit silently stops pushing.
    """

    SAMPLE = ('# Flock sensor\n'
              'FLOCK_API_KEY=secret-key-123\n'
              '#NOISE_SPL_ANCHOR_DB=0\n'
              'NOISE_SPL_ANCHOR_COUNTS=1.0\n'
              'THERMAL_BIN=4\n')

    def test_an_existing_key_is_replaced_in_place(self):
        out = main.set_config_keys(self.SAMPLE, {'NOISE_SPL_ANCHOR_COUNTS': '17.500'})
        self.assertIn('NOISE_SPL_ANCHOR_COUNTS=17.500', out)
        self.assertNotIn('NOISE_SPL_ANCHOR_COUNTS=1.0', out)
        self.assertEqual(out.count('NOISE_SPL_ANCHOR_COUNTS='), 1)

    def test_a_new_key_is_appended(self):
        out = main.set_config_keys(self.SAMPLE, {'NOISE_SPL_ANCHOR_DB': '62'})
        self.assertTrue(out.rstrip().endswith('NOISE_SPL_ANCHOR_DB=62'))

    def test_a_commented_key_keeps_its_comment(self):
        # The file documents itself in comments. Rewriting one would erase the
        # explanation of what the setting does.
        out = main.set_config_keys(self.SAMPLE, {'NOISE_SPL_ANCHOR_DB': '62'})
        self.assertIn('#NOISE_SPL_ANCHOR_DB=0', out)

    def test_the_api_key_and_everything_else_survive(self):
        out = main.set_config_keys(self.SAMPLE, {'NOISE_SPL_ANCHOR_COUNTS': '17.5',
                                                  'NOISE_SPL_ANCHOR_DB': '62'})
        for line in ('FLOCK_API_KEY=secret-key-123', 'THERMAL_BIN=4', '# Flock sensor'):
            self.assertIn(line, out)

    def test_an_empty_file_gets_just_the_new_keys(self):
        out = main.set_config_keys('', {'NOISE_SPL_ANCHOR_DB': '62'})
        self.assertEqual(out.strip(), 'NOISE_SPL_ANCHOR_DB=62')

    def test_the_anchor_refuses_a_reading_no_room_produces(self):
        # Checked before any hardware is touched, so this runs anywhere.
        self.assertEqual(main.anchor(5.0), 1)
        self.assertEqual(main.anchor(200.0), 1)


class DesktopDetection(unittest.TestCase):
    """Drawing on a Pi that shows the desktop, with nothing typed by hand."""

    def test_a_running_desktop_is_found_from_its_socket(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, 'wayland-0'), 'w').close()
            open(os.path.join(d, 'wayland-0.lock'), 'w').close()
            env = {'XDG_RUNTIME_DIR': d}
            self.assertEqual(main.wayland_socket(env), 'wayland-0')
            self.assertEqual(main.video_driver_candidates(env=env, has_dri=True)[0], 'wayland')

    def test_no_desktop_goes_to_the_hardware(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            env = {'XDG_RUNTIME_DIR': d}
            self.assertIsNone(main.wayland_socket(env))
            self.assertEqual(main.video_driver_candidates(env=env, has_dri=True)[0], 'kmsdrm')

    def test_a_missing_runtime_directory_is_not_an_error(self):
        self.assertIsNone(main.wayland_socket({'XDG_RUNTIME_DIR': '/no/such/dir/at/all'}))

    def test_the_service_can_reach_the_touchscreen(self):
        # Without input the panel draws and ignores every tap, which on a pitch
        # is indistinguishable from the unit being frozen.
        unit = Path(__file__).resolve().parent.joinpath('flock-sensor.service').read_text(encoding='utf-8')
        groups = [l for l in unit.splitlines() if l.startswith('SupplementaryGroups=')]
        self.assertEqual(len(groups), 1)
        for g in ('video', 'input', 'render'):
            self.assertIn(g, groups[0].split('=', 1)[1].split())

    def test_the_installer_ships_the_panel_assets(self):
        setup = Path(__file__).resolve().parent.joinpath('setup.sh').read_text(encoding='utf-8')
        self.assertIn('flux-assets', setup)

    def test_every_asset_the_panel_asks_for_is_in_the_repo(self):
        here = Path(__file__).resolve().parent / 'flux-assets'
        for name in (main.BRAND_DISPLAY, main.BRAND_WORDMARK, main.BRAND_LABEL,
                     main.BRAND_BODY, main.BRAND_MARK_BADGE, main.BRAND_MARK_BIRDS):
            self.assertTrue((here / name).exists(), f'{name} is missing from flux-assets')
class DisplayBootRace(unittest.TestCase):
    """At boot the desktop's socket appears seconds after the service starts.

    Opening a display once and giving up on failure left the panel dark for the
    whole run. These drive open_display with a fake clock and a fake SDL.
    """

    class _Display:
        def __init__(self, works_on):
            self.works_on = works_on
            self.tried = []

        def quit(self):
            pass

        def set_mode(self, size, flags=0):
            d = os.environ.get('SDL_VIDEODRIVER')
            self.tried.append(d)
            if d in self.works_on:
                return _FakeSurface((1024, 600))
            raise RuntimeError(f'{d} not available')

    class _SDL:
        FULLSCREEN = 1

        def __init__(self, works_on):
            self.display = DisplayBootRace._Display(works_on)

        def init(self):
            pass

    def test_a_display_that_appears_late_is_waited_for(self):
        rounds = {'n': 0}

        def candidates():
            rounds['n'] += 1
            # No desktop for the first two rounds, then it arrives.
            return ['kmsdrm', 'dummy'] if rounds['n'] < 3 else ['wayland', 'kmsdrm', 'dummy']

        sdl = self._SDL(works_on={'wayland'})
        screen, driver = main.open_display(sdl, candidates, wait=60, retry=0,
                                           sleep=lambda s: None)
        self.assertEqual(driver, 'wayland')
        self.assertIsNotNone(screen)

    def test_it_gives_up_on_a_real_display_eventually(self):
        sdl = self._SDL(works_on={'dummy'})
        screen, driver = main.open_display(sdl, lambda: ['kmsdrm', 'dummy'],
                                           wait=0, retry=0, sleep=lambda s: None)
        self.assertEqual(driver, 'dummy')

    def test_a_working_display_is_used_at_once(self):
        sdl = self._SDL(works_on={'kmsdrm'})
        naps = []
        screen, driver = main.open_display(sdl, lambda: ['kmsdrm', 'dummy'],
                                           wait=60, retry=5, sleep=naps.append)
        self.assertEqual(driver, 'kmsdrm')
        self.assertEqual(naps, [], 'it waited although the display was ready')

    def test_no_graphics_hardware_does_not_wait(self):
        # A venue unit with no panel at all has nothing to wait for, and must
        # not hold the display thread for the full wait on every boot.
        sdl = self._SDL(works_on={'dummy'})
        naps = []
        _, driver = main.open_display(sdl, lambda: ['dummy'], wait=60, retry=5,
                                      sleep=naps.append)
        self.assertEqual(driver, 'dummy')
        self.assertEqual(naps, [])
class TapHandling(unittest.TestCase):
    """One physical tap must produce one action."""

    def test_the_first_tap_is_taken(self):
        self.assertTrue(main.accept_tap(10.0, None))

    def test_the_echo_of_a_tap_is_dropped(self):
        # The mouse event SDL synthesises from a finger event, arriving a few
        # milliseconds after it. Acting on both opened a screen and shut it.
        self.assertFalse(main.accept_tap(10.004, 10.0))

    def test_a_synthesised_press_is_dropped_even_late(self):
        self.assertFalse(main.accept_tap(99.0, 10.0, synthesized=True))

    def test_a_second_deliberate_tap_is_taken(self):
        # Open a card, then tap Back a moment later: both must work.
        self.assertTrue(main.accept_tap(10.0 + main.TAP_DEBOUNCE_SECONDS + 0.01, 10.0))

    def test_the_window_is_shorter_than_a_person_can_tap_twice(self):
        # A deliberate double tap is roughly 0.3 to 0.5 s apart. Longer than
        # that and Back feels ignored.
        self.assertLessEqual(main.TAP_DEBOUNCE_SECONDS, 0.35)

    def test_the_loop_consults_it(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        loop = source[source.index('def display_loop():'):]
        self.assertIn('accept_tap(', loop)
def _vl53_frame(distances_mm, status=5, targets=1, head_id=0x0102, foot_id=None):
    """One 8x8 frame as the sensor would put it on the wire.

    Laid out the way ST's parser walks it: a 16-byte header carrying the frame
    id, the blocks this driver enables, and a footer whose id has to match the
    header's. Built in host order and swapped, because the sensor sends
    big-endian words.
    """
    size = main.vl53_output_config(main.VL53_RES_8X8)[1]
    host = bytearray(size)
    host[8], host[9] = head_id >> 8, head_id & 0xFF
    pos = [16]

    def block(bh, payload):
        struct.pack_into('<I', host, pos[0], bh)
        host[pos[0] + 4:pos[0] + 4 + len(payload)] = payload
        pos[0] += 4 + len(payload)

    def per_zone(v):
        return bytes(v if isinstance(v, (list, tuple)) else [v] * 64)

    block(0x54B400C0, bytes(12))                    # metadata
    block(0x54C00040, bytes(4))                     # common data
    block(0xDB840401, per_zone(targets))            # targets per zone
    block(0xDF440402, struct.pack('<64h', *[d * 4 for d in distances_mm]))
    block(0xE0840401, per_zone(status))             # target status
    foot = head_id if foot_id is None else foot_id
    host[size - 4], host[size - 3] = foot >> 8, foot & 0xFF
    return main.swap4(bytes(host))


class Vl53Framing(unittest.TestCase):
    """The byte-level rules every buffer to and from the sensor goes through."""

    def test_every_word_is_reversed(self):
        # ST's SwapBuffer. Getting this wrong garbles every buffer identically,
        # which is exactly the kind of wrong that looks like a dead sensor.
        self.assertEqual(main.swap4(bytes([1, 2, 3, 4, 5, 6, 7, 8])),
                         bytes([4, 3, 2, 1, 8, 7, 6, 5]))
        data = bytes(range(40))
        self.assertEqual(main.swap4(main.swap4(data)), data)

    def test_a_partial_word_is_a_bug_not_padding(self):
        with self.assertRaises(ValueError):
            main.swap4(bytes(6))

    def test_division_truncates_toward_zero_the_way_c_does(self):
        # Python's // floors, so -5 // 4 is -2 where ST's C gives -1. The
        # offset tables and every distance go through this.
        self.assertEqual(main._cdiv(-5, 4), -1)
        self.assertEqual(main._cdiv(5, 4), 1)
        self.assertEqual(main._cdiv(-8, 4), -2)
        self.assertEqual(main._cdiv(7, -2), -3)

    def test_the_trimmed_frame_is_320_bytes(self):
        # Worked through ST's start_ranging by hand: start 4, metadata 16,
        # common 8, targets 68, distance 132, status 68, plus 24. The firmware
        # reports its own figure back and start_ranging refuses a mismatch, so
        # this number is checked again by the part itself on the first boot.
        self.assertEqual(main.vl53_output_config(main.VL53_RES_8X8)[1], 320)

    def test_no_output_set_can_exceed_st_own_buffer(self):
        # VL53L8CX_MAX_RESULTS_SIZE with every output on and one target per
        # zone, from vl53l8cx_api.h.
        self.assertLessEqual(main.vl53_output_config(main.VL53_RES_8X8, 0xFFF)[1], 1452)

    def test_the_output_list_keeps_all_twelve_blocks(self):
        # The firmware is told about every block and which ones are on; a
        # shortened list would renumber the enable bits under it.
        output, _ = main.vl53_output_config(main.VL53_RES_8X8)
        self.assertEqual(len(output), 12)
        self.assertEqual(output[3], main.VL53_OUTPUT_BH[3], 'a disabled block was rewritten')
        for i in (5, 8, 10):
            self.assertEqual((output[i] >> 4) & 0xFFF, 64)

    def test_the_enable_mask_asks_for_exactly_the_blocks_parsed(self):
        mask = main.VL53_OUTPUT_ENABLE
        on = [i for i in range(12) if mask >> i & 1]
        self.assertEqual(on, [0, 1, 2, 5, 8, 10])
        self.assertEqual(main.VL53_OUTPUT_BH[5] >> 16, main.VL53_NB_TARGET_IDX)
        self.assertEqual(main.VL53_OUTPUT_BH[8] >> 16, main.VL53_DISTANCE_IDX)
        self.assertEqual(main.VL53_OUTPUT_BH[10] >> 16, main.VL53_STATUS_IDX)

    def test_distances_come_out_in_millimetres(self):
        d = [1000 + z for z in range(64)]
        self.assertEqual(main.vl53_parse_frame(_vl53_frame(d), 320), d)

    def test_a_zone_with_no_target_reads_nothing(self):
        targets = [1] * 64
        targets[10] = 0
        out = main.vl53_parse_frame(_vl53_frame([1500] * 64, targets=targets), 320)
        self.assertEqual(out[10], 0)
        self.assertEqual(out[11], 1500)

    def test_only_valid_statuses_count(self):
        status = [5] * 64
        status[0], status[1], status[2], status[3] = 9, 4, 6, 255
        out = main.vl53_parse_frame(_vl53_frame([1500] * 64, status=status), 320)
        self.assertEqual(out[:4], [1500, 0, 0, 0])

    def test_a_negative_distance_is_not_a_person_at_the_glass(self):
        d = [1500] * 64
        d[5] = -3
        out = main.vl53_parse_frame(_vl53_frame(d), 320)
        self.assertEqual(out[5], 0)

    def test_quarter_millimetres_truncate(self):
        host = [1500] * 64
        raw = bytearray(main.swap4(_vl53_frame(host)))
        # Distance block starts after header 16, metadata 16, common 8 and
        # targets 68: its payload is at 16 + 16 + 8 + 68 + 4.
        struct.pack_into('<h', raw, 16 + 16 + 8 + 68 + 4, 4003)
        out = main.vl53_parse_frame(main.swap4(bytes(raw)), 320)
        self.assertEqual(out[0], 1000)

    def test_a_torn_frame_is_dropped(self):
        # ST's check: the id at the head of the frame and at its foot differ
        # when the read straddled two frames.
        self.assertIsNone(main.vl53_parse_frame(
            _vl53_frame([1500] * 64, head_id=0x0102, foot_id=0x0103), 320))

    def test_a_frame_without_distances_is_dropped(self):
        raw = bytearray(main.swap4(_vl53_frame([1500] * 64)))
        struct.pack_into('<I', raw, 16 + 16 + 8 + 68, 0x12340402)   # not DISTANCE
        self.assertIsNone(main.vl53_parse_frame(main.swap4(bytes(raw)), 320))


class _FakeIoctl:
    """Stands in for fcntl on the I2C bus. Records every transaction the way
    the kernel receives it and fills read buffers with a counting pattern."""

    def __init__(self):
        self.transfers = []

    def ioctl(self, fd, request, arg):
        assert request == main._I2C_RDWR
        msgs = []
        for k in range(arg.nmsgs):
            m = arg.msgs[k]
            if m.flags & main._I2C_M_RD:
                for j in range(m.len):
                    m.buf[j] = j & 0xFF
                msgs.append((m.addr, m.flags, m.len, None))
            else:
                msgs.append((m.addr, m.flags, m.len, bytes(m.buf[:m.len])))
        self.transfers.append(msgs)
        return 0


class I2CPlumbing(unittest.TestCase):
    """The ctypes layer between the driver and /dev/i2c-1."""

    def bus(self):
        b = main.I2CBus.__new__(main.I2CBus)
        b.address, b.fd = 0x29, 3
        return b

    def test_the_kernel_constants(self):
        self.assertEqual(main._I2C_RDWR, 0x0707)
        self.assertEqual(main._I2C_M_RD, 0x0001)

    def test_the_structures_match_the_kernel_layout(self):
        if ctypes.sizeof(ctypes.c_void_p) != 8:
            self.skipTest('layout pinned for 64-bit, which is what a Pi 5 runs')
        self.assertEqual(ctypes.sizeof(main._I2cMsg), 16)
        self.assertEqual(main._I2cMsg.buf.offset, 8)
        self.assertEqual(ctypes.sizeof(main._I2cRdwr), 16)

    def test_a_long_write_is_split_and_every_piece_says_where_it_goes(self):
        fake = _FakeIoctl()
        payload = bytes(range(256)) * 20
        with mock.patch.object(main, 'fcntl', fake):
            self.bus().write(0x0000, payload)
        pieces = [t[0] for t in fake.transfers]
        self.assertEqual([p[2] for p in pieces], [2050, 2050, 1026])
        self.assertEqual([p[3][:2] for p in pieces], [b'\x00\x00', b'\x08\x00', b'\x10\x00'])
        self.assertEqual(b''.join(p[3][2:] for p in pieces), payload)

    def test_a_firmware_page_never_exceeds_the_kernel_limit(self):
        # i2c-dev refuses any message over 8192 bytes, and a page is 32768.
        fake = _FakeIoctl()
        with mock.patch.object(main, 'fcntl', fake):
            self.bus().write(0, bytes(0x8000))
        self.assertTrue(all(t[0][2] <= 8192 for t in fake.transfers))
        self.assertEqual(sum(t[0][2] - 2 for t in fake.transfers), 0x8000)

    def test_a_read_is_one_transaction_with_a_repeated_start(self):
        # The sensor loses the register address on a stop, so the address
        # write and the read must be one I2C_RDWR call, not two.
        fake = _FakeIoctl()
        with mock.patch.object(main, 'fcntl', fake):
            got = self.bus().read(0x2C04, 12)
        self.assertEqual(len(fake.transfers), 1)
        (w, r) = fake.transfers[0]
        self.assertEqual(w, (0x29, 0, 2, b'\x2c\x04'))
        self.assertEqual(r[:3], (0x29, main._I2C_M_RD, 12))
        self.assertEqual(got, bytes(range(12)))


class _FakeVl53:
    """A scripted VL53L8CX, at the level the driver talks to its bus.

    It answers the polls ST's start-up waits on, keeps the DCI settings the
    driver writes, hands back what it was asked for, and records every write
    in order. Knobs for each way a real part can fail.
    """

    def __init__(self, checksum=0x0C0B6C9E, frame_size=320, laser_fault=0,
                 mcu_status=0, boots=True):
        self.writes = []
        self.dci = {
            main.VL53_DCI_ZONE_CONFIG: bytes([4, 4, 0, 0, 8, 8, 0, 0]),
            main.VL53_DCI_DSS_CONFIG: bytes(16),
            main.VL53_DCI_FREQ_HZ: bytes(4),
            main.VL53_DCI_RANGING_MODE: bytes(8),
            main.VL53_DCI_TARGET_ORDER: bytes([2, 0, 0, 0]),
            0x5440: bytes(8) + struct.pack('<H', frame_size) + bytes(2),
            0xE0C4: bytes(6) + bytes([laser_fault, 0]),
        }
        self.checksum = checksum
        self.mcu_status = mcu_status
        self.go2 = 0x01 if boots else 0x00
        # 492 bytes of calibration, distinct everywhere, so a shift shows.
        self.nvm = bytes((i * 7 + 3) & 0xFF for i in range(main.VL53_NVM_SIZE))
        self.pending = b''
        self.ready = bytes([255, 5, 5, 0x10])
        self.frame = b''

    def write(self, reg, data):
        data = bytes(data)
        self.writes.append((reg, data))
        if reg == main.VL53_UI_CMD_END - 11 and len(data) == 12:
            index, size = (data[0] << 8) | data[1], (data[2] << 4) | (data[3] >> 4)
            payload = self.dci.get(index, bytes(size))[:size].ljust(size, b'\0')
            self.pending = main.swap4(bytes(4) + payload + bytes(8))
        elif reg == 0x2FD8:
            self.pending = self.nvm
        elif len(data) > 12 and reg + len(data) - 1 == main.VL53_UI_CMD_END:
            index, size = (data[0] << 8) | data[1], len(data) - 12
            self.dci[index] = main.swap4(data[4:4 + size])

    def read(self, reg, n):
        if reg == 0x06 and n == 1:
            return bytes([self.go2])
        if reg == 0x21 and n == 1:
            return bytes([0x04])
        if reg == main.VL53_UI_CMD_STATUS and n == 4:
            return bytes([2, 3, self.mcu_status, 0])
        if reg == 0x2FFC and n == 4:
            return struct.pack('>I', self.checksum)
        if reg == main.VL53_UI_CMD_START:
            return self.pending[:n].ljust(n, b'\0')
        if reg == 0 and n == 4:
            return self.ready
        if reg == 0 and n > 4:
            return self.frame[:n].ljust(n, b'\0')
        if reg == 0 and n == 1:
            return b'\xf0'
        if reg == 1 and n == 1:
            return b'\x0c'
        return bytes(n)


def _vl53_tables():
    return main.load_vl53_tables()


class Vl53StartUp(unittest.TestCase):
    """ST's start-up sequence, run against the scripted fake."""

    def device(self, **knobs):
        fake = _FakeVl53(**knobs)
        return fake, main.Vl53l8cx(fake, _vl53_tables(), sleep=lambda _s: None)

    def test_it_reaches_ranging_configured_for_a_doorway(self):
        fake, dev = self.device()
        dev.start(15)
        self.assertTrue(dev.ranging)
        self.assertEqual(dev.frame_size, 320)
        self.assertEqual(fake.dci[main.VL53_DCI_ZONE_CONFIG][:2], bytes([8, 8]))
        self.assertEqual(fake.dci[main.VL53_DCI_FREQ_HZ][1], 15)
        self.assertEqual(fake.dci[main.VL53_DCI_TARGET_ORDER][0], main.VL53_TARGET_ORDER_CLOSEST)
        mode = fake.dci[main.VL53_DCI_RANGING_MODE]
        self.assertEqual((mode[1], mode[3]), (1, 3), 'not continuous mode')
        self.assertEqual(fake.dci[main.VL53_DCI_SINGLE_RANGE], struct.pack('<I', 0))
        (enable,) = struct.unpack_from('<I', fake.dci[main.VL53_DCI_OUTPUT_ENABLES], 0)
        self.assertEqual(enable, main.VL53_OUTPUT_ENABLE)
        self.assertEqual(struct.unpack('<2I', fake.dci[main.VL53_DCI_OUTPUT_CONFIG]), (320, 13))
        self.assertIn((main.VL53_UI_CMD_END - 3, bytes([0x00, 0x03, 0x00, 0x00])), fake.writes,
                      'no start command sent')

    def test_the_boot_follows_st_line_by_line(self):
        # Transcribed from vl53l8cx_init in ST's vl53l8cx_api.c, independently
        # of main.py: every single-byte write from the software reboot to the
        # page select after the MCU boots, with the three firmware pages in
        # place. A reordered or dropped write here is a sensor that does not
        # start, and nothing on the bench says why.
        expected = [
            (0x7FFF, 0x00), (0x0009, 0x04), (0x000F, 0x40), (0x000A, 0x03),
            (0x000C, 0x01), (0x0101, 0x00), (0x0102, 0x00), (0x010A, 0x01),
            (0x4002, 0x01), (0x4002, 0x00), (0x010A, 0x03), (0x0103, 0x01),
            (0x000C, 0x00), (0x000F, 0x43), (0x000F, 0x40), (0x000A, 0x01),
            (0x7FFF, 0x00), (0x000E, 0x01), (0x7FFF, 0x02), (0x7FFF, 0x01),
            (0x0006, 0x01), (0x7FFF, 0x00), (0x000C, 0x01), (0x7FFF, 0x00),
            (0x0101, 0x00), (0x0102, 0x00), (0x010A, 0x01), (0x4002, 0x01),
            (0x4002, 0x00), (0x010A, 0x03), (0x0103, 0x01), (0x400F, 0x00),
            (0x021A, 0x43), (0x021A, 0x03), (0x021A, 0x01), (0x021A, 0x00),
            (0x0219, 0x00), (0x021B, 0x00), (0x7FFF, 0x00), (0x7FFF, 0x01),
            (0x7FFF, 0x09), ('page', 0x8000), (0x7FFF, 0x0A), ('page', 0x8000),
            (0x7FFF, 0x0B), ('page', 0x5000), (0x7FFF, 0x01), (0x7FFF, 0x01),
            (0x0006, 0x03), (0x7FFF, 0x00), (0x000C, 0x01), (0x7FFF, 0x00),
            (0x0114, 0x00), (0x0115, 0x00), (0x0116, 0x42), (0x0117, 0x00),
            (0x000B, 0x00), (0x000C, 0x00), (0x000B, 0x01), (0x7FFF, 0x02),
        ]
        fake, dev = self.device()
        dev.init()
        seen = []
        for reg, data in fake.writes:
            if reg == 0x2FD8:
                break
            seen.append((reg, data[0]) if len(data) == 1 else ('page', len(data)))
        self.assertEqual(seen, expected)

    def test_the_firmware_arrives_whole_and_in_order(self):
        fake, dev = self.device()
        dev.init()
        pages = [d for r, d in fake.writes if r == 0 and len(d) > 1]
        self.assertEqual(b''.join(pages), _vl53_tables()['firmware'])

    def test_a_damaged_load_stops_at_the_checksum(self):
        _, dev = self.device(checksum=0xDEADBEEF)
        with self.assertRaisesRegex(main.Vl53l8cxError, 'checksum'):
            dev.init()

    def test_a_sensor_that_never_boots_times_out_rather_than_hanging(self):
        _, dev = self.device(boots=False)
        with self.assertRaisesRegex(main.Vl53l8cxError, 'timed out'):
            dev.init()

    def test_an_mcu_error_is_raised_not_carried_forward(self):
        _, dev = self.device(mcu_status=0x80)
        with self.assertRaisesRegex(main.Vl53l8cxError, 'MCU error'):
            dev.init()

    def test_the_8x8_calibration_is_shifted_and_footed_as_st_does(self):
        fake, dev = self.device()
        dev.start(15)
        sent = [d for r, d in fake.writes if r == 0x2E18]
        self.assertEqual(len(sent), 2, 'offsets go once at 4x4 in init and once at 8x8')
        last = sent[-1]
        self.assertEqual(len(last), main.VL53_OFFSET_SIZE)
        self.assertEqual(last[:480], fake.nvm[8:488])
        self.assertEqual(last[480:], bytes([0x00, 0x00, 0x00, 0x0F, 0x03, 0x01, 0x01, 0xE4]))

    def test_the_4x4_calibration_averages_each_square_of_four(self):
        # Rebuilt by formula rather than by the loop main.py uses: in host
        # order the signal grid sits at 0x3C and the range grid at 0x140, and
        # each 4x4 cell is the C-truncated mean of a 2x2 block of the 8x8.
        host = bytearray(main.VL53_OFFSET_SIZE)
        sig = [100000 + 37 * k for k in range(64)]
        rng = [-(3 * k + 1) for k in range(64)]
        struct.pack_into('<64I', host, 0x3C, *sig)
        struct.pack_into('<64h', host, 0x140, *rng)
        fake, dev = self.device()
        fake.nvm = main.swap4(bytes(host)) + bytes(4)
        dev.init()
        first = [d for r, d in fake.writes if r == 0x2E18][0]
        # The written buffer is the processed one moved down by 8 bytes.
        got_sig = struct.unpack('<64I', main.swap4(first[0x3C - 8:0x3C - 8 + 256]))
        got_rng = struct.unpack('<64h', main.swap4(first[0x140 - 8:0x140 - 8 + 128]))
        for j in range(4):
            for i in range(4):
                a = 2 * i + 16 * j
                self.assertEqual(got_sig[i + 4 * j], (sig[a] + sig[a + 1] + sig[a + 8] + sig[a + 9]) // 4)
                total = rng[a] + rng[a + 1] + rng[a + 8] + rng[a + 9]
                self.assertEqual(got_rng[i + 4 * j], -((-total) // 4))
        self.assertEqual(got_sig[16:], (0,) * 48)
        self.assertEqual(got_rng[16:], (0,) * 48)

    def test_a_frame_size_the_firmware_disagrees_with_is_refused(self):
        _, dev = self.device(frame_size=1444)
        with self.assertRaisesRegex(main.Vl53l8cxError, '1444'):
            dev.start(15)

    def test_a_laser_safety_fault_is_refused(self):
        _, dev = self.device(laser_fault=1)
        with self.assertRaisesRegex(main.Vl53l8cxError, 'laser'):
            dev.start(15)

    def test_stopping_a_sensor_that_never_started_touches_nothing(self):
        fake, dev = self.device()
        dev.stop_ranging()
        self.assertEqual(fake.writes, [])

    def test_stop_hands_the_sensor_back(self):
        fake, dev = self.device()
        dev.start(15)
        fake.go2 = 0x81
        before = len(fake.writes)
        dev.stop_ranging()
        tail = [(r, d[0]) for r, d in fake.writes[before:]]
        self.assertEqual(tail[-5:], [(0x7FFF, 0x00), (0x14, 0x00), (0x15, 0x00),
                                     (0x09, 0x04), (0x7FFF, 0x02)])
        self.assertFalse(dev.ranging)

    def test_a_frame_is_ready_only_when_st_says_so(self):
        fake, dev = self.device()
        dev.start(15)
        fake.ready = bytes([3, 5, 5, 0x10])
        self.assertTrue(dev.data_ready())
        self.assertFalse(dev.data_ready(), 'the same frame twice')
        fake.ready = bytes([255, 5, 5, 0x10])
        self.assertFalse(dev.data_ready())
        fake.ready = bytes([4, 5, 0x42, 0x80])
        self.assertFalse(dev.data_ready())
        self.assertEqual(dev.fault, 0x42)

    def test_a_frame_is_read_and_parsed(self):
        fake, dev = self.device()
        dev.start(15)
        d = [900 + z for z in range(64)]
        fake.frame = _vl53_frame(d)
        self.assertEqual(dev.read_frame(), d)


class DoorwayBackground(unittest.TestCase):
    """The empty doorway, zone by zone."""

    @staticmethod
    def angled(near=1500, far=2900):
        # The head looks down at the doorway at an angle: the top row of its
        # view meets floor much further away than the bottom row.
        return [far - (far - near) * (z // 8) / 7.0 for z in range(64)]

    def seeded(self, floors, frames=None):
        bg = main.TofBackground(hz=15)
        for f in (frames or [floors] * main.TofBackground.SEED_FRAMES):
            bg.observe([int(v) for v in f])
        return bg

    def test_each_zone_learns_its_own_floor(self):
        floors = self.angled()
        bg = self.seeded(floors)
        self.assertTrue(bg.ready)
        for z in range(64):
            self.assertAlmostEqual(bg.floor[z], int(floors[z]), delta=1)

    def test_somebody_walking_through_while_it_learns_does_not_move_it(self):
        floors = [2500] * 64
        frames = [list(floors) for _ in range(main.TofBackground.SEED_FRAMES)]
        for f in frames[5:9]:
            for z in (27, 28, 35, 36):
                f[z] = 1400
        bg = self.seeded(floors, frames)
        self.assertEqual(bg.floor[27], 2500)

    def test_a_zone_that_never_answers_takes_the_edge_of_range(self):
        floors = [2500] * 64
        floors[0] = 0
        bg = self.seeded(floors)
        self.assertEqual(bg.floor[0], main.VL53_RANGE_MM)

    def test_a_person_does_not_drag_the_floor(self):
        bg = self.seeded([2500] * 64)
        for _ in range(30):
            bg.observe([1400] * 64)
        self.assertEqual(bg.floor[0], 2500)

    def test_slow_change_is_followed(self):
        bg = self.seeded([2500] * 64)
        for _ in range(400):
            bg.observe([2650] * 64)
        self.assertAlmostEqual(bg.floor[0], 2650, delta=5)

    def test_something_parked_in_the_doorway_joins_the_background_after_a_minute(self):
        bg = self.seeded([2500] * 64)
        parked = [2500] * 64
        parked[20] = 1200
        for _ in range(60 * 15 - 1):
            bg.observe(parked)
        self.assertIn(20, main.tof_occupied(parked, bg.floor))
        bg.observe(parked)
        self.assertNotIn(20, main.tof_occupied(parked, bg.floor))

    def test_an_angled_doorway_counts_one_walk_through_as_one(self):
        floors = self.angled()
        bg = self.seeded(floors)
        tracker = main.CrossingTracker()
        for r in range(0, 7):
            f = [int(v) for v in floors]
            for dr in (0, 1):
                for dc in (0, 1):
                    z = (r + dr) * 8 + 3 + dc
                    if r + dr < 8:
                        f[z] = int(floors[z]) - 900
            bg.observe(f)
            tracker.observe(main.tof_clusters(main.tof_occupied(f, bg.floor)))
        self.assertEqual((tracker.entries, tracker.exits), (1, 0))

    def test_one_floor_for_the_whole_grid_would_see_a_crowd_in_an_empty_doorway(self):
        # Why the background is per zone. The same empty angled doorway,
        # against the single floor a flat mount would use, lights every near
        # row as somebody standing there.
        floors = [int(v) for v in self.angled()]
        self.assertTrue(main.tof_clusters(main.tof_occupied(floors, max(floors))))
        self.assertEqual(main.tof_occupied(floors, self.seeded(floors).floor), [])


class DoorCounterInstall(unittest.TestCase):
    """What has to be true on disk for the counter to start at all."""

    HERE = Path(__file__).resolve().parent

    def test_the_firmware_files_are_the_ones_the_readme_names(self):
        # A checkout with line-ending conversion, a truncated copy, or a file
        # swapped for another driver version all load and then fail the
        # sensor's checksum in the field. They fail here first.
        readme = (self.HERE / 'vl53l8cx' / 'README.md').read_text(encoding='utf-8')
        rows = re.findall(r'\| `(vl53l8cx_[a-z_]+\.bin)` \| (\d+) \| `([0-9a-f]{64})`', readme)
        self.assertEqual(len(rows), 4)
        for name, size, digest in rows:
            data = (self.HERE / 'vl53l8cx' / name).read_bytes()
            self.assertEqual(len(data), int(size), name)
            self.assertEqual(hashlib.sha256(data).hexdigest(), digest, name)
        tables = main.load_vl53_tables()
        self.assertEqual(len(tables['firmware']), 0x15000)

    def test_the_licence_travels_with_the_firmware(self):
        # BSD 3-Clause lets the binaries be redistributed on condition that
        # the notice goes with them: the library's licence, and ST's own
        # notice from the file the tables were extracted from.
        licence = (self.HERE / 'vl53l8cx' / 'LICENSE').read_text(encoding='utf-8')
        self.assertIn('BSD 3-Clause License', licence)
        self.assertIn('Redistributions in binary form', licence)
        readme = (self.HERE / 'vl53l8cx' / 'README.md').read_text(encoding='utf-8')
        self.assertIn('Copyright (c) 2021 STMicroelectronics.', readme)

    def test_the_service_can_open_the_counters_bus(self):
        # /dev/i2c-1 belongs to group i2c. Without it the self test, run as
        # root, finds the counter, and the service never can.
        unit = (self.HERE / 'flock-sensor.service').read_text(encoding='utf-8')
        groups = re.search(r'^SupplementaryGroups=(.*)$', unit, re.M).group(1).split()
        self.assertIn('i2c', groups)

    def test_an_unset_number_is_not_reported_as_a_typo(self):
        original = dict(main.CONFIG)
        try:
            main.CONFIG['TOF_MARGIN_MM'] = ''
            with mock.patch('sys.stderr', new_callable=io.StringIO) as err:
                self.assertEqual(main._cfg_number('TOF_MARGIN_MM', int, 100, 1500, 300), 300)
            self.assertEqual(err.getvalue(), '')
        finally:
            main.CONFIG.clear()
            main.CONFIG.update(original)


class DoorScreen(unittest.TestCase):
    """The door screen says what the counter it has can actually tell."""

    def panel(self):
        return main.Panel(_FakePygame(), _FakeSurface((1024, 600)), 1024, 600)

    @staticmethod
    def drawn(ui):
        return {k[1] for k in ui._cache if isinstance(k, tuple) and len(k) == 3}

    def test_both_directions_when_the_counter_knows_them(self):
        ui = self.panel()
        ui.door(4, [1, 2, 3], 17, 9)
        seen = self.drawn(ui)
        self.assertIn('Came in', seen)
        self.assertIn('Went out', seen)
        self.assertIn('17', seen)
        self.assertIn('9', seen)

    def test_a_beam_is_not_credited_with_directions(self):
        ui = self.panel()
        ui.door(4, [1, 2, 3])
        seen = self.drawn(ui)
        self.assertNotIn('Came in', seen)
        self.assertIn('This sensor counts crossings, not which way they went.', seen)

    def test_no_counter_says_so_instead_of_showing_zero(self):
        ui = self.panel()
        ui.door(0, [], live=False)
        ui.home(0, 3, True, 60.0, True, [], door_live=False)
        seen = self.drawn(ui)
        self.assertIn('No doorway counter is answering.', seen)
        self.assertIn('counter offline', seen)
        self.assertIn('--', seen)

    def test_the_door_chart_is_its_own_data(self):
        # It once charted thermal headcounts under a doorway title.
        source = (Path(__file__).resolve().parent / 'main.py').read_text(encoding='utf-8')
        loop = source[source.index('def display_loop():'):]
        self.assertIn('ui.door(ir, door_history', loop)

    def test_the_door_chart_fills_without_a_network(self):
        # Recorded at the snapshot, so a demo unit with no wifi still draws it.
        with main._lock:
            main._state['door_history'].clear()
            main._state['ir_count'] = 5
        main.snapshot()
        with main._lock:
            self.assertEqual(list(main._state['door_history']), [5])
            main._state['door_history'].clear()


class InstallerHardwareAccess(unittest.TestCase):
    """What setup.sh does to the hardware and the unit it installs."""

    HERE = Path(__file__).resolve().parent

    def setup_text(self):
        return (self.HERE / 'setup.sh').read_text(encoding='utf-8')

    def test_the_installed_unit_keeps_every_group_the_repo_unit_asks_for(self):
        # setup.sh rewrites SupplementaryGroups with the groups this image
        # has. It took them from a list of its own, three long, so every
        # installed unit lost input and render while the repo's unit looked
        # right. The list must come from the unit file.
        setup = self.setup_text()
        self.assertNotRegex(setup, r'for grp in [a-z]', 'the installer has its own group list again')
        self.assertIn("sed -n 's/^SupplementaryGroups=//p'", setup)
        self.assertIn('for grp in ${WANTED_GROUPS}', setup)

    def test_i2c_is_turned_on(self):
        self.assertIn('raspi-config nonint do_i2c 0', self.setup_text())

    def test_the_installer_leaves_the_bus_at_its_safe_rate(self):
        # Fast mode would load the firmware in two seconds instead of eight,
        # and over the head's three metres of Cat6 it risks a bus that fails
        # the checksum on every start. The trade belongs to whoever knows the
        # cable, so the installer does not make it.
        self.assertNotIn('i2c_arm_baudrate=400000', self.setup_text())

    def test_the_counter_is_chosen_the_way_the_config_says(self):
        plan = main.door_plan
        self.assertEqual(plan('auto', True), 'tof')
        self.assertEqual(plan('auto', False), 'beam')
        # Told the counter is fitted, it runs the counter even when nothing
        # answered at boot, and keeps retrying, rather than falling back to a
        # beam the unit does not have and showing a live-looking zero.
        self.assertEqual(plan('tof', False), 'tof')
        self.assertEqual(plan('beam', True), 'beam')
        self.assertIsNone(plan('off', True))

    def test_the_counter_firmware_is_installed_where_main_looks(self):
        # main.py looks beside itself, /opt/flock-sensor/vl53l8cx.
        setup = self.setup_text()
        self.assertIn('"${INSTALL_DIR}/vl53l8cx/"', setup)
        self.assertEqual(Path(main.TOF_DIR).name, 'vl53l8cx')

    def test_the_firmware_is_marked_binary(self):
        attrs = (self.HERE / 'vl53l8cx' / '.gitattributes').read_text(encoding='utf-8')
        self.assertIn('*.bin binary', attrs)

    def test_the_files_the_pi_runs_have_unix_line_endings(self):
        # A CRLF setup.sh fails before its first command ("bad interpreter"),
        # and a CRLF unit file hands systemd a user name ending in a carriage
        # return. A Windows checkout produced exactly that until
        # flock-sensor/.gitattributes pinned LF.
        for name in ('setup.sh', 'flock-sensor.service', 'main.py', 'flock_sensor.env.example'):
            self.assertNotIn(b'\r\n', (self.HERE / name).read_bytes(), name)
        attrs = (self.HERE / '.gitattributes').read_text(encoding='utf-8')
        self.assertIn('eol=lf', attrs)


class EnclosureFiles(unittest.TestCase):
    """The committed laser, print and STEP files, against the model they came from.

    Nobody building the box runs the model; they take svg/ to a laser and stl/
    to a printer. So the files are what has to be right, and a number changed
    in flux_cad.py without a re-export is a box cut to the old drawing.
    """

    ENC = Path(__file__).resolve().parent / 'enclosure'

    def scad_number(self, name):
        # The model's settings, read as text: the tests do not need build123d.
        text = (self.ENC / 'flux_cad.py').read_text(encoding='utf-8')
        return float(re.search(rf'^{name}\s*=\s*([\d.]+)', text, re.M).group(1))

    def svg(self, part):
        return (self.ENC / 'svg' / f'flux-{part}.svg').read_text(encoding='utf-8')

    def box_size(self):
        # The box is the screen's width plus the room beside it and the walls,
        # and the strip under the screen plus the screen and the top wall.
        n = self.scad_number
        w = n('screen_outer_w') + 2 * n('side_room') + 2 * n('wall')
        h = n('strip_h') + n('screen_outer_h') + 2.0 + n('wall')
        return w, h

    def test_every_sheet_is_cut_to_the_size_the_drawing_says(self):
        # Both sheets cover the whole face of the sleeve, edge to edge.
        w, h = self.box_size()
        expected = {'front': (w, h), 'back': (w, h)}
        for part, (ew, eh) in expected.items():
            m = re.search(r'width="([\d.]+)mm" height="([\d.]+)mm"', self.svg(part))
            self.assertIsNotNone(m, part)
            self.assertAlmostEqual(float(m.group(1)), ew, delta=0.01, msg=part)
            self.assertAlmostEqual(float(m.group(2)), eh, delta=0.01, msg=part)

    def test_cuts_are_red_hairlines_and_the_wordmark_is_an_engraving(self):
        # The convention school laser software reads: red stroke cuts, black
        # fill engraves. A fill on a cut path would engrave the whole panel.
        for part in ('front', 'back'):
            svg = self.svg(part)
            self.assertIn('fill="none" stroke="#FF0000"', svg, part)
            self.assertIn('fill="#000000" stroke="none"', svg, part)

    def test_every_part_the_export_script_makes_is_committed(self):
        sys.path.insert(0, str(self.ENC))
        try:
            import export
        finally:
            sys.path.pop(0)
        for _, name in export.PRINTED:
            self.assertTrue((self.ENC / 'stl' / f'{name}.stl').exists(), name)
        for part, _, _ in export.PANELS:
            self.assertTrue((self.ENC / 'dxf' / f'flux-{part}.dxf').exists(), part)
            self.assertTrue((self.ENC / 'svg' / f'flux-{part}.svg').exists(), part)

    def test_the_step_assembly_names_every_part(self):
        # The STEP file is what opens in Fusion 360 or Onshape; every part in
        # it carries its name, so the tree there reads like the parts list.
        step = (self.ENC / 'step' / 'flux-assembly.step').read_text(encoding='utf-8', errors='replace')
        for name in ('Sleeve (printed)', 'Front sheet (acrylic)', 'Back sheet (acrylic)',
                     'Raspberry Pi 5', 'PureThermal 3 + Lepton 3.5', 'VL53L8CX door counter',
                     'Decibel meter', 'Anker A1336 battery', '7 inch touchscreen'):
            self.assertIn(name, step, name)
        for part in ('sleeve', 'front-sheet', 'back-sheet'):
            self.assertTrue((self.ENC / 'step' / f'flux-{part}.step').exists(), part)

    def test_the_stls_came_from_the_export_script(self):
        # It writes each solid's triangles in one fixed order. A file exported
        # by hand is in OpenSCAD's order of the day, which is how an unchanged
        # part turns into a four-thousand-line diff.
        sys.path.insert(0, str(self.ENC))
        try:
            import export
        finally:
            sys.path.pop(0)
        with tempfile.TemporaryDirectory() as tmp:
            for stl in sorted((self.ENC / 'stl').glob('*.stl')):
                copy = Path(tmp) / stl.name
                copy.write_bytes(stl.read_bytes())
                export.canonical_stl(copy)
                self.assertEqual(copy.read_bytes().replace(b'\r\n', b'\n'),
                                 stl.read_bytes().replace(b'\r\n', b'\n'), stl.name)


class StatusLights(unittest.TestCase):
    """POWER and LINK on the base."""

    def test_nothing_is_driven_until_a_pin_is_set(self):
        self.assertEqual(main.DEFAULTS['LED_POWER_GPIO'], '0')
        self.assertEqual(main.DEFAULTS['LED_LINK_GPIO'], '0')
        self.assertIsNone(main.led_pin_problem(0))

    def test_a_light_is_refused_a_pin_a_bus_already_uses(self):
        # An output driven under the counter's I2C or the microphone's SPI
        # takes that sensor down with it.
        for pin in (2, 3, 7, 8, 9, 10, 11):
            self.assertIsNotNone(main.led_pin_problem(pin), pin)
        self.assertIsNotNone(main.led_pin_problem(17, beam_pin=17))
        self.assertIsNone(main.led_pin_problem(23))
        self.assertIsNone(main.led_pin_problem(24, beam_pin=17))

    def test_link_is_dark_until_a_reading_has_gone_out(self):
        self.assertFalse(main.link_lit(100.0, None, True, push_interval=30))

    def test_link_is_dark_when_the_head_is_silent(self):
        self.assertFalse(main.link_lit(100.0, 95.0, False, push_interval=30))

    def test_link_is_dark_when_readings_stop_going_out(self):
        self.assertFalse(main.link_lit(200.0, 100.0, True, push_interval=30))

    def test_link_blinks_while_both_are_true(self):
        states = {main.link_lit(100.0 + t / 10.0, 99.0, True, push_interval=30)
                  for t in range(0, 20)}
        self.assertEqual(states, {True, False})


class Pi5GpioSwap(unittest.TestCase):
    """setup.sh on a Pi 5 has to leave rpi-lgpio as the RPi.GPIO Python imports."""

    def setup_text(self):
        return (Path(__file__).resolve().parent / 'setup.sh').read_text(encoding='utf-8')

    def test_the_old_library_is_removed_on_current_raspberry_pi_os(self):
        # Debian trixie refuses a plain pip uninstall of a system-wide package.
        # The refusal was sent to /dev/null, so the old RPi.GPIO stayed in
        # /usr/local and shadowed rpi-lgpio on every Pi 5 installed this way.
        self.assertIn('pip3 uninstall -y --break-system-packages RPi.GPIO', self.setup_text())

    def test_the_installer_checks_what_python_actually_imports(self):
        self.assertIn("'lgpio' not in inspect.getsource(G)", self.setup_text())


class ThermalCeiling(unittest.TestCase):
    """A person is warm, and not that warm."""

    R, C = main.THERMAL_ROWS, main.THERMAL_COLS

    def frame(self, blobs, ambient=21.0):
        g = [ambient] * (self.R * self.C)
        for (r0, c0, h, w, t) in blobs:
            for r in range(r0, r0 + h):
                for c in range(c0, c0 + w):
                    g[r * self.C + c] = t
        return g

    def test_a_hot_mug_is_not_a_person(self):
        # A mug of coffee bigger than a head in frame used to count as one.
        self.assertEqual(main.count_thermal_clusters(self.frame([(40, 60, 32, 28, 58.0)])), 0)

    def test_the_person_beside_it_still_counts(self):
        frame = self.frame([(40, 20, 32, 28, 58.0), (40, 100, 32, 24, 34.0)])
        self.assertEqual(main.count_thermal_clusters(frame), 1)

    def test_a_person_the_camera_reads_hot_still_counts(self):
        # Without a calibration target a Lepton can read several degrees high.
        self.assertEqual(main.count_thermal_clusters(self.frame([(40, 60, 32, 24, 41.0)])), 1)

    def test_calibration_still_sees_every_region(self):
        # --calibrate measures warm areas, hot ones included; only the count
        # applies the ceiling.
        sizes = main.thermal_region_sizes(self.frame([(40, 60, 32, 28, 58.0)]))
        self.assertEqual(len(sizes), 1)

    def test_the_ceiling_is_a_setting_with_a_sane_default(self):
        self.assertEqual(main.DEFAULTS['THERMAL_MAX_PERSON_C'], '45.0')
        self.assertEqual(main.THERMAL_MAX_PERSON_C, 45.0)


class NoiseCadence(unittest.TestCase):
    """The microphone listened for 0.1s in every 5, and a shout slipped between."""

    SRC = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')

    def body(self, name):
        start = self.SRC.index(f'def {name}(')
        end = self.SRC.index('\ndef ', start + 10)
        return self.SRC[start:end]

    def test_it_listens_at_least_twice_a_second(self):
        self.assertLessEqual(main.NOISE_BURST_EVERY, 0.5)

    def test_the_published_figure_still_spans_a_minute(self):
        span = main._state['noise_window'].maxlen * main.NOISE_BURST_EVERY
        self.assertEqual(span, 60)

    def test_one_sampler_for_the_loop_and_both_calibrations(self):
        # --listen and --anchor kept their own loops with a 1ms sleep, so what
        # they measured was not what the running sensor measured.
        for name in ('noise_loop', 'listen', '_median_burst_rms'):
            body = self.body(name)
            self.assertIn('noise_burst(', body, name)
            self.assertNotIn('time.sleep(0.001)', body, name)

    def test_a_minute_of_steady_room_ignores_a_few_seconds_of_shouting(self):
        # The typical level is what the venue card shows; the panel shows the
        # shout itself, live.
        window = [45.0] * 108 + [95.0] * 12
        self.assertAlmostEqual(main.trimmed_mean(window), 45.0, places=6)

    def test_a_room_that_really_got_louder_reads_louder(self):
        window = [45.0] * 60 + [75.0] * 60
        self.assertGreater(main.trimmed_mean(window), 55.0)


class AnchorAgainstHiss(unittest.TestCase):
    """A calibration taken over the microphone's own hiss shrinks every reading."""

    def test_a_sound_barely_above_the_hiss_is_refused(self):
        self.assertIsNotNone(main.anchor_problem(15.0, 20.0))

    def test_a_clear_sound_is_accepted(self):
        self.assertIsNone(main.anchor_problem(15.0, 60.0))

    def test_the_margin_is_ten_decibels(self):
        self.assertEqual(main.ANCHOR_MIN_SNR_DB, 10.0)
        self.assertIsNotNone(main.anchor_problem(10.0, 31.0))
        self.assertIsNone(main.anchor_problem(10.0, 32.0))


class TrainingRecorder(unittest.TestCase):
    """The recorder is a development tool; the sensor still keeps no frame."""

    HERE = Path(__file__).resolve().parent

    def load(self, name):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            f'training_{name}', self.HERE / 'training' / f'{name}.py')
        mod = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(self.HERE / 'training'))
        try:
            spec.loader.exec_module(mod)
        finally:
            sys.path.pop(0)
        return mod

    def test_a_frame_survives_the_round_trip_to_the_hundredth(self):
        frames = self.load('frames')
        frame = [20.0 + (i % 160) * 0.07 - (i // 160) * 0.013 for i in range(19200)]
        back = frames.decode_frame(frames.encode_frame(frame))
        self.assertEqual(len(back), 19200)
        # Rounded to the hundredth, so never more than half of one out.
        self.assertLessEqual(max(abs(a - b) for a, b in zip(frame, back)), 0.00501)

    def test_it_will_not_record_without_consent(self):
        record = self.load('record')
        with mock.patch.object(main, 'ThermalCamera',
                               side_effect=AssertionError('opened the camera')), \
                mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(record.main(['--room', 'kitchen']), 2)
        self.assertIn('--consent', out.getvalue())

    def test_the_installer_never_puts_it_on_a_unit(self):
        # A venue unit gets main.py, the panel assets and the counter firmware.
        setup = (self.HERE / 'setup.sh').read_text(encoding='utf-8')
        self.assertNotIn('training', setup)

    def test_the_sensor_itself_still_writes_no_frame(self):
        source = (self.HERE / 'main.py').read_text(encoding='utf-8')
        self.assertNotIn('encode_frame', source)
        self.assertNotIn('flux-training', source)

    def test_frames_can_never_be_committed(self):
        ignore = (self.HERE / '.gitignore').read_text(encoding='utf-8')
        self.assertIn('*.frames', ignore)


class PeopleCounterModel(unittest.TestCase):
    """The trained counter: loaded when it can be, the rule when it cannot."""

    HERE = Path(__file__).resolve().parent

    def test_no_model_file_means_the_rule(self):
        with mock.patch.object(main, 'PEOPLE_MODEL_PATH', self.HERE / 'no-such.onnx'):
            self.assertIsNone(main.load_people_model())

    def test_off_means_the_rule_even_with_a_model(self):
        with mock.patch.object(main, 'THERMAL_MODEL', 'off'):
            self.assertIsNone(main.load_people_model())

    def test_a_missing_library_means_the_rule_not_a_crash(self):
        with mock.patch.object(main, 'PEOPLE_MODEL_PATH', Path(__file__)), \
                mock.patch.object(main, 'PeopleModel', side_effect=ImportError('no onnxruntime')):
            self.assertIsNone(main.load_people_model())

    def test_the_installer_ships_the_model_and_its_runtime(self):
        setup = (self.HERE / 'setup.sh').read_text(encoding='utf-8')
        self.assertIn('python3-onnxruntime', setup)
        self.assertIn('/models/', setup)

    def _model(self, prob):
        try:
            import numpy as np
        except ImportError:
            self.skipTest('numpy not installed')
        m = main.PeopleModel.__new__(main.PeopleModel)
        m.np = np
        m.input = 'frame'
        m.threshold = 0.4
        m.session = mock.Mock()
        m.session.run.return_value = [np.asarray(prob, dtype=np.float32)[None, None]]
        return m, np

    def test_inputs_match_what_training_used(self):
        m, np = self._model([[0.0] * 40] * 30)
        sys.path.insert(0, str(self.HERE / 'training'))
        try:
            import synth
        except ImportError:
            self.skipTest('scipy not installed')
        finally:
            sys.path.pop(0)
        frame = [20.0 + (i % 160) * 0.1 + (i // 160) * 0.05 for i in range(19200)]
        np.testing.assert_allclose(m.inputs(frame)[0], synth.model_input(frame), atol=1e-6)

    def test_one_peak_per_person_and_bounds_hold(self):
        np = __import__('numpy')
        prob = np.zeros((30, 40))
        prob[10, 10] = 0.9          # a person
        prob[10, 11] = 0.8          # the same person's shoulder, not a peak
        prob[20, 30] = 0.9          # something at room temperature
        prob[5, 35] = 0.2           # not sure enough
        m, _ = self._model(prob)
        frame = np.full((120, 160), 21.0)
        frame[38:46, 38:46] = 33.0  # warm under the first peak only
        pts = m.points(frame.ravel().tolist())
        self.assertEqual(pts, [(42.0, 42.0)])

    def test_too_hot_to_be_a_person(self):
        np = __import__('numpy')
        prob = np.zeros((30, 40))
        prob[10, 10] = 0.9
        m, _ = self._model(prob)
        frame = np.full((120, 160), 21.0)
        frame[36:48, 36:48] = 62.0  # a mug the model mistook
        self.assertEqual(m.points(frame.ravel().tolist()), [])

    def test_the_shipped_model_counts_an_empty_room_as_nobody(self):
        path = self.HERE / 'models' / 'people.onnx'
        self.assertTrue(path.exists(), 'models/people.onnx is missing; setup.sh would ship the rule')
        try:
            model = main.PeopleModel(path, 0.4)
        except ImportError:
            self.skipTest('onnxruntime not installed')
        room = [21.0 + (i % 160) * 0.004 + ((i * 7919) % 13) * 0.01 for i in range(19200)]
        self.assertEqual(model.points(room), [])


class SmarterMicrophone(unittest.TestCase):
    """What minutes of loudness say, from loudness figures alone."""

    def test_a_burst_at_the_rails_is_clipped(self):
        quiet = [((i * 37) % 41) - 20 for i in range(2000)]
        shout = [(-510 if i % 2 else 508) for i in range(2000)]
        self.assertFalse(main.burst_clipped(quiet))
        self.assertTrue(main.burst_clipped(shout))
        self.assertFalse(main.burst_clipped([]))

    def test_steady_and_changing(self):
        steady = [70.0 + (i % 3) * 0.3 for i in range(120)]
        talk = [55.0 + (12.0 if (i // 3) % 2 else 0.0) for i in range(120)]
        self.assertEqual(main.noise_insight(steady)['character'], 'steady')
        self.assertEqual(main.noise_insight(talk)['character'], 'changing')
        # Too little to judge right after a start.
        self.assertIsNone(main.noise_insight(talk[:10])['character'])

    def test_how_easy_talking_is_needs_calibration(self):
        self.assertIsNone(main.noise_insight([60.0] * 120)['talk'])
        self.assertEqual(main.noise_insight([60.0] * 120, calibrated_db=55)['talk'], 'Easy to talk')
        self.assertEqual(main.noise_insight([60.0] * 120, calibrated_db=84)['talk'],
                         'Shouting to be heard')

    def test_a_still_microphone_with_people_in_view_is_flagged(self):
        flat = [41.0 + (i % 2) * 0.1 for i in range(600)]
        self.assertIsNotNone(main.noise_insight(flat, people=5)['deaf'])
        # An empty room is allowed to be still.
        self.assertIsNone(main.noise_insight(flat, people=0)['deaf'])
        self.assertIsNone(main.noise_insight(flat, people=None)['deaf'])
        # Not before five minutes of evidence.
        self.assertIsNone(main.noise_insight(flat[:300], people=5)['deaf'])

    def test_the_screen_line_puts_a_warning_first(self):
        line, tone = main.noise_insight_line({'character': 'steady', 'talk': None,
                                              'deaf': 'x'}, clipped=True)
        self.assertIn('unplugged', line)
        self.assertEqual(tone, main.BRAND_RED)
        line, _ = main.noise_insight_line({'character': 'changing', 'talk': 'Voices are raised',
                                           'deaf': None})
        self.assertEqual(line, 'Voices are raised. Rising and falling, like conversation.')
        self.assertIsNone(main.noise_insight_line(None)[0])

    def test_nothing_new_is_sent(self):
        # The insight is for the screen. The push payload is still the same
        # three numbers, which is what the privacy policy promises.
        with main._lock:
            main._state['noise_insight'] = {'character': 'changing', 'talk': None, 'deaf': None}
            main._state['noise_clipped_at'] = time.monotonic()
        payload = main.snapshot()
        self.assertEqual(set(payload) - {'recorded_at', '_mono', 'device_id'},
                         {'ir_beam_count', 'thermal_headcount', 'noise_db'})


class PeopleInside(unittest.TestCase):
    """The doorway and the camera, combined into one estimate with a range."""

    def test_in_minus_out_is_the_estimate(self):
        t = main.OccupancyTracker(empty_minutes=20)
        t.update(0, door_in=0, door_out=0, seen=0)
        e = t.update(30, door_in=10, door_out=3, seen=2)
        self.assertEqual(e['occupancy'], 7)
        self.assertLessEqual(e['low'], 7)
        self.assertGreaterEqual(e['high'], 7)

    def test_the_camera_is_a_floor(self):
        t = main.OccupancyTracker()
        t.update(0, door_in=0, door_out=0, seen=0)
        # The doorway missed people; the camera sees five.
        e = t.update(30, door_in=2, door_out=0, seen=5)
        self.assertEqual(e['occupancy'], 5)
        self.assertGreaterEqual(e['low'], 5)

    def test_more_out_than_in_never_goes_negative(self):
        t = main.OccupancyTracker()
        t.update(0, door_in=0, door_out=0, seen=0)
        self.assertEqual(t.update(30, door_in=1, door_out=4, seen=0)['occupancy'], 0)

    def test_the_range_widens_with_crossings(self):
        t = main.OccupancyTracker()
        t.update(0, door_in=0, door_out=0, seen=None)
        small = t.update(30, door_in=6, door_out=2, seen=None)
        big = t.update(60, door_in=406, door_out=398, seen=None)
        self.assertGreater(big['high'] - big['low'], small['high'] - small['low'])

    def test_a_still_empty_room_resets_the_drift(self):
        t = main.OccupancyTracker(empty_minutes=20)
        t.update(0, door_in=0, door_out=0, seen=0)
        # A night of counting leaves three people the doorway never saw leave.
        t.update(30, door_in=300, door_out=297, seen=0)
        self.assertEqual(t.update(60, door_in=300, door_out=297, seen=0)['occupancy'], 3)
        e = None
        for s in range(90, 60 * 22, 30):
            e = t.update(s, door_in=300, door_out=297, seen=0)
        self.assertEqual(e['occupancy'], 0)
        self.assertEqual(e['high'], 0)

    def test_someone_on_camera_stops_the_reset(self):
        t = main.OccupancyTracker(empty_minutes=20)
        t.update(0, door_in=0, door_out=0, seen=0)
        t.update(30, door_in=4, door_out=0, seen=1)
        for s in range(60, 60 * 30, 30):
            e = t.update(s, door_in=4, door_out=0, seen=1)
        self.assertEqual(e['occupancy'], 4)

    def test_without_a_doorway_counter_it_is_the_camera(self):
        t = main.OccupancyTracker()
        e = t.update(0, crossings=0, seen=10)
        self.assertEqual(e['occupancy'], 10)
        self.assertLess(e['low'], 10)
        self.assertIsNone(t.update(30, crossings=0, seen=None))

    def test_how_long_people_stay(self):
        # Twenty inside and ten arriving (and ten leaving) every ten minutes:
        # an hour's arrivals are 60, so each stays 20 / (1 per minute) = 20.
        t = main.OccupancyTracker()
        t.update(0, door_in=0, door_out=0, seen=20)
        e = None
        for k in range(1, 61):
            n = (k * 10) // 10
            e = t.update(k * 60, door_in=n, door_out=n, seen=None)
        self.assertIsNotNone(e['dwell_minutes'])
        self.assertAlmostEqual(e['dwell_minutes'], 20, delta=3)
        # Too early to say.
        self.assertIsNone(main.OccupancyTracker().update(0, door_in=0, door_out=0,
                                                         seen=3)['dwell_minutes'])

    def test_the_sentence_on_the_door_screen(self):
        self.assertIsNone(main.occupancy_line(None))
        self.assertEqual(main.occupancy_line({'occupancy': 4, 'low': 4, 'high': 4,
                                              'dwell_minutes': None}), '4 inside.')
        self.assertEqual(main.occupancy_line({'occupancy': 12, 'low': 10, 'high': 14,
                                              'dwell_minutes': 45}),
                         'About 12 inside, 10 to 14. People stay about 45 min.')

    def test_the_estimate_is_sent_as_counts(self):
        with mock.patch.object(main, '_occupancy', main.OccupancyTracker()):
            with main._lock:
                main._state['thermal'] = 6
                main._state['thermal_at'] = time.monotonic()
                main._state['door_source'] = 'tof'
                main._state['door_in'], main._state['door_out'] = 0, 0
            try:
                main.snapshot()
                with main._lock:
                    main._state['door_in'], main._state['door_out'] = 9, 1
                payload = main.snapshot()
            finally:
                with main._lock:
                    main._state['door_source'] = None
                    main._state['thermal_at'] = None
        # Six already inside when counting began, then nine in and one out.
        self.assertEqual(payload['occupancy'], 14)
        self.assertLessEqual(payload['occupancy_low'], 14)
        self.assertGreaterEqual(payload['occupancy_high'], 14)
        for key in ('occupancy', 'occupancy_low', 'occupancy_high'):
            self.assertIsInstance(payload[key], int)


class NamesKindsNeverWho(unittest.TestCase):
    """owl-2 names what is in a frame. It must never become surveillance:
    no telling one person from another, nothing that follows a person from
    frame to frame, and nothing but counts leaving the device."""

    HERE = Path(__file__).resolve().parent

    def _model(self, heat, ltrb):
        try:
            import numpy as np
        except ImportError:
            self.skipTest('numpy not installed')
        m = main.PeopleModel.__new__(main.PeopleModel)
        m.np = np
        m.input = 'frame'
        m.threshold = 0.4
        m.session = mock.Mock()
        m.session.run.return_value = [np.asarray(heat, dtype=np.float32)[None],
                                      np.asarray(ltrb, dtype=np.float32)[None]]
        return m, np

    def test_it_names_and_boxes_what_it_finds(self):
        np = __import__('numpy')
        heat = np.zeros((10, 30, 40))
        heat[0, 10, 10] = 0.9            # a person
        heat[1, 20, 30] = 0.8            # a hand
        ltrb = np.ones((4, 30, 40))
        m, _ = self._model(heat, ltrb)
        frame = np.full((120, 160), 21.0)
        frame[38:46, 38:46] = 33.0
        people, things = m.read(frame.ravel().tolist())
        self.assertEqual(people, [(42.0, 42.0)])
        labels = sorted(t['label'] for t in things)
        self.assertEqual(labels, ['hand', 'person'])
        person = [t for t in things if t['label'] == 'person'][0]
        self.assertEqual(person['box'], (38.0, 38.0, 46.0, 46.0))

    def test_a_hand_is_named_but_never_counted(self):
        np = __import__('numpy')
        heat = np.zeros((10, 30, 40))
        heat[1, 15, 20] = 0.95
        m, _ = self._model(heat, np.ones((4, 30, 40)))
        people, things = m.read([21.0] * 19200)
        self.assertEqual(people, [])
        self.assertEqual([t['label'] for t in things], ['hand'])

    def test_nothing_is_carried_from_one_frame_to_the_next(self):
        np = __import__('numpy')
        heat = np.zeros((10, 30, 40))
        heat[0, 10, 10] = 0.9
        m, _ = self._model(heat, np.ones((4, 30, 40)))
        before = set(vars(m))
        frame = np.full((120, 160), 21.0)
        frame[38:46, 38:46] = 33.0
        m.read(frame.ravel().tolist())
        m.read(frame.ravel().tolist())
        # No history, no ids, no memory of who was where.
        self.assertEqual(set(vars(m)), before)

    def test_no_identity_or_tracking_anywhere_in_the_sensor(self):
        source = (self.HERE / 'main.py').read_text(encoding='utf-8').lower()
        for word in ('track_id', 'person_id', 'reidentif', 're-identif', 'embedding',
                     'face_recogn', 'gait'):
            self.assertNotIn(word, source, f'{word!r} has no place in a counter')

    def test_the_names_and_boxes_stay_on_a_screen_unit(self):
        source = (self.HERE / 'main.py').read_text(encoding='utf-8')
        at = source.index("_state['thermal_things'] = things")
        self.assertIn('if THERMAL_VIEW_ON:', source[at - 400:at])

    def test_a_label_on_the_screen_is_a_kind_of_thing(self):
        for label in main.PeopleModel.CLASSES:
            self.assertNotIn(' ', label.replace('hot drink', 'x').replace('warm seat', 'x'))
        self.assertEqual(main.PeopleModel.CLASSES[0], 'person')


class CrowdSecondLook(unittest.TestCase):
    """The finer-grid model counts a crowd again, and only a crowd."""

    def _model(self, n, density=None):
        m = main.PeopleModel.__new__(main.PeopleModel)
        m.fine = None

        def read(frame, crowd=None):
            if crowd is not None and density is not None:
                crowd.append(density)
            return [(i, i) for i in range(n)], []
        m.read = mock.Mock(side_effect=read)
        return m

    def test_a_small_room_never_asks_the_fine_model(self):
        m = self._model(3, density=9.0)
        m.fine = self._model(9)
        people, _, count = m.read_crowd([0.0])
        self.assertEqual((len(people), count), (3, 3))
        m.fine.read.assert_not_called()

    def test_a_crowd_takes_the_higher_count(self):
        m = self._model(6)
        m.fine = self._model(9)
        self.assertEqual(m.read_crowd([0.0])[2], 9)
        m.fine = self._model(4)
        self.assertEqual(m.read_crowd([0.0])[2], 6)

    def test_the_density_total_counts_merged_heads(self):
        self.assertEqual(self._model(6, density=8.6).read_crowd([0.0])[2], 9)
        self.assertEqual(self._model(6, density=4.2).read_crowd([0.0])[2], 6)

    def test_without_the_fine_model_it_is_the_main_one(self):
        self.assertEqual(self._model(7).read_crowd([0.0])[2], 7)


if __name__ == '__main__':
    unittest.main()


class SoundMeterModule(unittest.TestCase):
    """The PCB Artists I2C decibel meter, which replaced the analog microphone.

    The analog path could not tell a quiet room from someone talking two feet
    away: its own electrical noise sat at the level of speech. The module
    measures A-weighted dB SPL on its own processor, and the Pi reads a byte.
    """

    def test_a_zero_after_power_up_is_no_reading_not_silence(self):
        self.assertIsNone(main.sound_meter_value(0))
        self.assertEqual(main.sound_meter_value(42), 42.0)
        self.assertIsNone(main.sound_meter_value(255))

    def test_the_meter_wins_when_it_answers(self):
        self.assertEqual(main.noise_plan('auto', True), 'meter')
        self.assertEqual(main.noise_plan('auto', False), 'mic')
        self.assertEqual(main.noise_plan('meter', False), 'meter')
        self.assertEqual(main.noise_plan('mic', True), 'mic')
        self.assertEqual(main.noise_plan('off', True), 'off')

    def test_it_reads_the_dba_register(self):
        class Bus:
            def __init__(self):
                self.asked = []

            def read(self, reg, n):
                self.asked.append((reg, n))
                return bytes([0x3A]) if reg == 0x00 else bytes([63])
        bus = Bus()
        meter = main.SoundMeter(bus)
        self.assertEqual(meter.version(), 0x3A)
        self.assertEqual(meter.read_dba(), 63.0)
        self.assertEqual(bus.asked, [(0x00, 1), (0x0A, 1)])

    def test_its_decibels_are_shown_as_decibels_without_calibration(self):
        with mock.patch.object(main, 'NOISE_IS_SPL', True):
            self.assertEqual(main.display_decibels(63.0), 63.0)
            value, caption, basis = main.noise_reading(63.0)
            self.assertEqual(value, '63 dB')
            self.assertEqual(caption, 'measured sound level')
            self.assertEqual(main.noise_band(basis)[0], 'Moderate')
            self.assertIsNone(main.display_decibels(0.0))

    def test_its_readings_are_not_divided_by_the_microphones_stretch(self):
        # A meter's minute of steady 60 to 62 dB is steady, whatever NOISE_SCALE
        # the old microphone left in the config.
        minute = [60.0, 61.0, 62.0] * 40
        with mock.patch.object(main, 'NOISE_SCALE', 4.4):
            self.assertEqual(main.noise_insight(minute, scale=1.0)['character'], 'steady')

    def test_the_meter_and_the_counter_answer_at_different_addresses(self):
        # They share one I2C bus and four wires.
        self.assertNotEqual(main.SOUND_METER_ADDR, main.TOF_I2C_ADDR)


class ThermalUpsideDown(unittest.TestCase):
    """A camera mounted upside down, turned back over without changing the grid."""

    def test_half_a_turn_is_the_picture_reversed(self):
        rows, cols = 3, 4
        frame = [r * 10 + c for r in range(rows) for c in range(cols)]
        turned = main.upright(frame, upside_down=True)
        # The bottom-right corner comes to the top left, and the grid keeps its shape.
        self.assertEqual(turned[0], frame[-1])
        self.assertEqual(turned[-1], frame[0])
        self.assertEqual(len(turned), len(frame))
        self.assertEqual(main.upright(turned, upside_down=True), frame)

    def test_off_by_default(self):
        self.assertEqual(main.DEFAULTS['THERMAL_UPSIDE_DOWN'], '0')
        frame = [1.0, 2.0, 3.0]
        self.assertIs(main.upright(frame, upside_down=False), frame)
