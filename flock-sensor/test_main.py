#!/usr/bin/env python3
"""Tests for the venue sensor's pure logic.

    cd flock-sensor && python3 -m unittest -v test_main.py

Standard library only, so this runs on a Pi, on a laptop, and in CI without
installing anything. The hardware loops are not covered here (they need the
hardware); everything that decides what number is sent, when, and whether a
failure can wedge the device is.

Each test name is the failure it prevents.
"""

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


class ThermalCounting(unittest.TestCase):
    @staticmethod
    def frame(ambient, blobs=()):
        grid = [ambient] * 768
        for (r0, c0, h, w, temp) in blobs:
            for r in range(r0, r0 + h):
                for c in range(c0, c0 + w):
                    grid[r * 32 + c] = temp
        return grid

    def test_two_people_in_a_cool_room_count_as_two(self):
        f = self.frame(20.0, [(2, 2, 3, 3, 34.0), (12, 20, 3, 3, 34.0)])
        self.assertEqual(main.count_thermal_clusters(f), 2)

    def test_a_packed_bar_in_august_does_not_report_one_person(self):
        # With a fixed 28C threshold, a room at 29C marked every pixel warm, the
        # flood fill joined the whole grid into a single cluster, and the venue
        # reported a headcount of 1 at exactly the moment the number mattered.
        f = self.frame(29.0, [(2, 2, 3, 3, 35.0), (12, 20, 3, 3, 35.0), (18, 5, 3, 3, 35.0)])
        self.assertEqual(main.count_thermal_clusters(f), 3)

    def test_an_empty_room_reports_nobody(self):
        self.assertEqual(main.count_thermal_clusters(self.frame(21.0)), 0)
        self.assertEqual(main.count_thermal_clusters(self.frame(31.0)), 0)

    def test_a_speck_of_noise_is_not_a_person(self):
        f = self.frame(20.0, [(5, 5, 1, 2, 40.0)])  # 2 pixels, below min_cluster
        self.assertEqual(main.count_thermal_clusters(f), 0)

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
            main._state['noise_db'] = 64.4

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
            'cv2', 'picamera', 'picamera2', 'PIL',        # images
            'wave', 'sounddevice', 'pyaudio', 'audioop',  # audio capture
            'scapy', 'pyshark', 'getmac', 'netifaces',    # network identifiers
            'bluetooth', 'bleak', 'pybluez',              # BLE identifiers
        }
        self.assertEqual(imported & banned, set(),
                         'this device counts; it must never be able to identify anyone')

    def test_no_shell_out_to_a_tool_that_would_collect_identifiers(self):
        source = Path(__file__).resolve().parent.joinpath('main.py').read_text(encoding='utf-8')
        for tool in ('arp -a', 'iw dev', 'iwlist', 'hcitool', 'tcpdump', 'airodump'):
            self.assertNotIn(tool, source)


if __name__ == '__main__':
    unittest.main()
