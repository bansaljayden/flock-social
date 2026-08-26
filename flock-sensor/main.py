#!/usr/bin/env python3
"""
Flock venue sensor — runs on a Raspberry Pi at a venue entrance.

Reads three signals and POSTs them to the backend on a fixed cadence:
  - IR break-beam count  — doorway crossings since the last snapshot
  - Thermal headcount    — heat-cluster count from an MLX90640 (a count, never an image)
  - Ambient noise level  — RMS level from a MAX4466 mic via an MCP3008 ADC

WHAT LEAVES THE DEVICE
    Three integers and a timestamp. Nothing else. The thermal frame is reduced
    to a cluster count in memory and discarded; the audio samples are reduced
    to one RMS number and discarded. No image, no audio, no MAC address, no
    Bluetooth or wifi probe, no identifier of any person is captured, stored
    or transmitted. This device counts. It cannot identify anyone, and it must
    never be extended to.

DESIGN CONSTRAINTS
    This box lives in a bar, on a stranger's wifi, with nobody to reboot it.
    So: every loop is crash-proof, every network failure backs off instead of
    hammering, readings are buffered with their real timestamps across an
    outage, and no failure mode requires someone to drive to the venue.

    The device is also physically accessible to strangers, so it is treated as
    untrusted: its API key can be stolen, and the backend clamps and bounds
    everything it claims. See backend/routes/sensors.js.

Run `python3 main.py --selftest` to check an installation without waiting.
"""

import argparse
import errno
import json
import logging
import math
import os
import random
import signal
import sys
import threading
import time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests

VERSION = '1.2.0'

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Paths. The systemd unit sets all three explicitly; these defaults are what
# someone gets when they run the script by hand to debug a unit. Preferring the
# installed location means `python3 /opt/flock-sensor/main.py --selftest` works
# with no environment set up, on a Pi whose login user is not called `pi`.
INSTALLED_CONFIG = Path('/etc/flock-sensor/flock_sensor.env')
_INSTALLED = INSTALLED_CONFIG.exists()

CONFIG_PATH = Path(os.environ.get('FLOCK_CONFIG')
                   or (INSTALLED_CONFIG if _INSTALLED else '/home/pi/flock_sensor.env'))
LOG_PATH = Path(os.environ.get('FLOCK_LOG')
                or ('/var/log/flock-sensor/flock_sensor.log' if _INSTALLED
                    else '/home/pi/flock_sensor.log'))
BUFFER_PATH = Path(os.environ.get('FLOCK_BUFFER')
                   or ('/var/lib/flock-sensor/buffer.json' if _INSTALLED
                       else '/home/pi/flock_buffer.json'))

DEFAULTS = {
    'FLOCK_API_KEY': '',
    'FLOCK_API_URL': 'https://flock-app-production.up.railway.app/api/sensors/data',
    'SENSOR_DEVICE_ID': '',
    'PUSH_INTERVAL_SECONDS': '30',
    'DISPLAY_ENABLED': 'auto',
    # Thermal: a pixel counts as "warm" at this many °C, but see THERMAL_MARGIN_C.
    'THERMAL_THRESHOLD_C': '28.0',
    # ...and always at least this far above the frame's own median, so a hot
    # room in August does not turn the whole grid into one giant "person".
    'THERMAL_MARGIN_C': '3.0',
    'THERMAL_MIN_CLUSTER': '4',
    # Noise calibration. Out of the box these are nominal and the reported
    # figure is a relative loudness index, NOT calibrated dB SPL. See the
    # calibration section of README.md.
    'NOISE_REF_COUNTS': '1.0',
    'NOISE_DB_OFFSET': '50.0',
    # Allow a plaintext http:// endpoint. Off by default: the API key travels
    # in a header over the venue's wifi, and http would broadcast it.
    'ALLOW_INSECURE_URL': 'false',
}


def _parse_config_text(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        v = v.strip()
        # Tolerate `KEY=value  # trailing comment` and surrounding quotes, so a
        # reasonable-looking config file cannot brick a device.
        if v[:1] in ('"', "'") and v[-1:] == v[:1] and len(v) >= 2:
            v = v[1:-1]
        out[k.strip()] = v
    return out


def load_config():
    cfg = dict(DEFAULTS)
    try:
        if CONFIG_PATH.exists():
            cfg.update(_parse_config_text(CONFIG_PATH.read_text()))
    except Exception as e:
        print(f'Failed to read config {CONFIG_PATH}: {e}', file=sys.stderr)
    # Env vars override the file (useful for systemd).
    for k in list(cfg):
        if k in os.environ and os.environ[k]:
            cfg[k] = os.environ[k]
    return cfg


CONFIG = load_config()


def _cfg_number(key, cast, low, high, fallback):
    """Read a numeric setting without ever letting a typo kill the process.

    A device that refuses to boot because someone wrote `PUSH_INTERVAL=30s` is
    a device someone has to drive to the venue to fix.
    """
    raw = CONFIG.get(key, DEFAULTS.get(key, ''))
    try:
        value = cast(str(raw).strip())
    except (TypeError, ValueError):
        print(f'Config {key}={raw!r} is not a number; using {fallback}', file=sys.stderr)
        return fallback
    if value < low or value > high:
        print(f'Config {key}={value} out of range [{low}, {high}]; using {fallback}', file=sys.stderr)
        return fallback
    return value


PUSH_INTERVAL = _cfg_number('PUSH_INTERVAL_SECONDS', int, 10, 3600, 30)
THERMAL_THRESHOLD_C = _cfg_number('THERMAL_THRESHOLD_C', float, 0.0, 100.0, 28.0)
THERMAL_MARGIN_C = _cfg_number('THERMAL_MARGIN_C', float, 0.0, 50.0, 3.0)
THERMAL_MIN_CLUSTER = _cfg_number('THERMAL_MIN_CLUSTER', int, 1, 768, 4)
NOISE_REF_COUNTS = _cfg_number('NOISE_REF_COUNTS', float, 1e-6, 1024.0, 1.0)
NOISE_DB_OFFSET = _cfg_number('NOISE_DB_OFFSET', float, -100.0, 200.0, 50.0)

# Ceilings mirrored from backend/routes/sensors.js. Sending a value the server
# will reject only wastes a retry, so clamp here too.
MAX_IR_PER_READING = 10000
MAX_THERMAL = 1000
MAX_NOISE_DB = 140.0

# Buffering. 240 entries at a 30s cadence is ~2 hours of outage. The cap is
# what stops a month-long backend outage from filling the SD card.
MAX_BUFFER_ENTRIES = 240
# Sent oldest-first, a few per cycle. Draining 240 payloads in one burst would
# block the loop for minutes and arrive at the backend as a spike.
MAX_FLUSH_PER_CYCLE = 12
# Network backoff, in multiples of the push interval, capped so a device
# recovers within a quarter hour of the backend coming back.
MAX_BACKOFF_SECONDS = 900
# A misconfigured key must not retry every 30s for a week. It still retries
# eventually, so re-provisioning a key never needs a site visit.
AUTH_BACKOFF_START = 120
AUTH_BACKOFF_MAX = 1800
# 429 is not an outage. It means the backend is spacing out rows that would
# move the venue's live figure (MIN_LIVE_GAP_SECONDS in routes/sensors.js), and
# the right answer is a short pause, not the network backoff. Answering it with
# the network backoff is what stopped a device catching up after an outage; the
# whole story is in Pusher.flush.
RATE_LIMIT_STATUS = 429
RATE_LIMIT_RETRY_MIN = 2.0

# A sensor that stops answering must not keep reporting the last number it read.
# thermal_loop reads every 2s and noise_loop every 5s, so these are generous
# multiples: a handful of failed reads never zeroes a working signal, but a bus
# that has locked up stops being reported as a live crowd.
THERMAL_STALE_AFTER = 90
NOISE_STALE_AFTER = 60

# Any wall-clock time before this means NTP has not run yet (a Pi has no
# real-time clock, so it boots somewhere in the past).
CLOCK_SANE_EPOCH = 1735689600  # 2025-01-01T00:00:00Z

HTTP_TIMEOUT = (10, 20)  # (connect, read)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger('flock_sensor')
logger.setLevel(logging.INFO)
try:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _handler = RotatingFileHandler(str(LOG_PATH), maxBytes=5 * 1024 * 1024, backupCount=3)
except Exception:
    _handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))
logger.addHandler(_handler)
# Also to journald when running under systemd, so `journalctl -u flock-sensor`
# works even if the log file cannot be written (full or read-only disk).
if os.environ.get('JOURNAL_STREAM'):
    _console = logging.StreamHandler(sys.stdout)
    _console.setFormatter(logging.Formatter('[%(levelname)s] %(message)s'))
    logger.addHandler(_console)

_throttle = {}


def log_throttled(key, level, message, every_seconds=300):
    """Log once, then at most once per `every_seconds` for the same key.

    A sensor that dies at 9pm would otherwise write the same warning every two
    seconds until someone notices.
    """
    now = time.monotonic()
    last = _throttle.get(key, 0.0)
    if now - last < every_seconds:
        return
    _throttle[key] = now
    logger.log(level, message)


def clock_is_sane():
    return time.time() >= CLOCK_SANE_EPOCH


def iso_utc(epoch_seconds):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(epoch_seconds)) + \
        f'.{int((epoch_seconds % 1) * 1000):03d}Z'


# ---------------------------------------------------------------------------
# Display detection
# ---------------------------------------------------------------------------

def display_should_run():
    raw = (CONFIG.get('DISPLAY_ENABLED') or 'auto').strip().lower()
    if raw in ('true', '1', 'yes', 'on'):
        return True
    if raw in ('false', '0', 'no', 'off'):
        return False
    return os.path.exists('/dev/fb0') or os.path.exists('/dev/fb1')


DISPLAY_ON = display_should_run()


# ---------------------------------------------------------------------------
# Shared state (thread-safe via _lock)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_state = {
    'ir_count': 0,                          # Doorway crossings since last snapshot
    'thermal': 0,                           # Latest snapshot
    'thermal_at': None,                     # Monotonic mark of the last GOOD read
    'noise_db': 0.0,                        # Rolling 30s average
    'noise_at': None,                       # Monotonic mark of the last GOOD read
    'noise_window': deque(maxlen=6),        # 6 samples x 5s = 30s
    'last_push_history': deque(maxlen=12),  # For the optional display chart
}
_stop = threading.Event()


def _fresh(value, taken_at, max_age, name):
    """Return a latched reading only while it is still current, else 0.

    `thermal` and `noise_db` are the last value their loop managed to read and
    nothing ever cleared them. A sensor that answered fine at 9pm and whose I2C
    bus locked up at 11pm therefore went on reporting 11pm's headcount every 30
    seconds until someone power-cycled the Pi: an ordinary hardware failure,
    indistinguishable at the backend from a live reading, showing a packed room
    on the venue card hours after the room emptied. Nothing downstream could
    catch it either, because the rows kept arriving with fresh timestamps.

    Reporting 0 is the same honest degradation the device already applies to a
    sensor that fails at startup ("will report 0 headcount"). The IR beam has
    never had this problem: its counter resets into every payload, so a dead
    beam reports 0 by construction.
    """
    if taken_at is not None and time.monotonic() - taken_at <= max_age:
        return value
    if value:
        log_throttled(f'stale_{name}', logging.WARNING,
                      f'{name} has not read successfully for over {max_age}s. '
                      f'Reporting 0 rather than the last value it returned ({value}).')
    return 0


def pi_model():
    """The board this is running on, or '' off a Pi. Never raises."""
    try:
        return Path('/proc/device-tree/model').read_text().strip('\x00').strip()
    except Exception:
        return ''


# ---------------------------------------------------------------------------
# IR break-beam (GPIO 17, falling edge, 500ms debounce)
#
# This counts BEAM BREAKS, which means doorway crossings in either direction.
# It is not an entry count and must not be presented as one.
# ---------------------------------------------------------------------------

def init_ir():
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(17, GPIO.IN, pull_up_down=GPIO.PUD_UP)

        last_trigger = [0.0]

        def on_break(channel):
            now = time.monotonic()
            if now - last_trigger[0] < 0.5:
                return
            last_trigger[0] = now
            with _lock:
                # Bounded so a stuck or noisy beam cannot grow this without
                # limit between snapshots.
                if _state['ir_count'] < MAX_IR_PER_READING:
                    _state['ir_count'] += 1

        GPIO.add_event_detect(17, GPIO.FALLING, callback=on_break, bouncetime=200)
        logger.info('IR break-beam initialized on GPIO 17')
        return True
    except Exception as e:
        logger.error(f'IR init failed (will report 0 crossings): {e}')
        # The Pi 5 moved GPIO behind the RP1 southbridge and the original
        # RPi.GPIO cannot drive it at all, so on the board this project's own
        # demo-unit build plan specifies, the doorway counter fails at startup
        # with a message about a peripheral base address that tells an installer
        # nothing. Name the fix instead. `rpi-lgpio` provides the same RPi.GPIO
        # API on top of lgpio and needs no code change here.
        model = pi_model()
        if model.startswith('Raspberry Pi 5'):
            logger.error(f'This is a "{model}". RPi.GPIO does not support Pi 5 GPIO. '
                         'Install the drop-in replacement instead: '
                         'sudo pip3 install --break-system-packages rpi-lgpio '
                         '(uninstall RPi.GPIO first, they cannot both be present).')
        return False


# ---------------------------------------------------------------------------
# Thermal — MLX90640 over I2C
# Connected-component labeling on a 24x32 grid, 4-connectivity.
# A cluster of >= THERMAL_MIN_CLUSTER warm pixels counts as one person.
#
# The frame never leaves this function. It is not stored and not transmitted;
# only the resulting integer is.
# ---------------------------------------------------------------------------

_thermal_sensor = None


def init_thermal():
    global _thermal_sensor
    try:
        import board
        import busio
        import adafruit_mlx90640
        i2c = busio.I2C(board.SCL, board.SDA, frequency=800000)
        _thermal_sensor = adafruit_mlx90640.MLX90640(i2c)
        _thermal_sensor.refresh_rate = adafruit_mlx90640.RefreshRate.REFRESH_2_HZ
        logger.info('MLX90640 thermal sensor initialized')
        return True
    except Exception as e:
        logger.error(f'MLX90640 init failed (will report 0 headcount): {e}')
        _thermal_sensor = None
        return False


def _median(values):
    ordered = sorted(values)
    n = len(ordered)
    if n == 0:
        return 0.0
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def count_thermal_clusters(frame_768, threshold_c=None, min_cluster=None,
                           margin_c=None):
    """Flood-fill on a 24x32 grid (4-connectivity). Returns a cluster count.

    The threshold floats above the frame's own median. With a fixed 28°C
    threshold, a bar at 29°C ambient — a packed bar in summer, exactly when
    the number matters most — marked every pixel warm and collapsed the whole
    room into a single cluster, reporting "1 person".
    """
    rows, cols = 24, 32
    if len(frame_768) < rows * cols:
        return 0
    threshold_c = THERMAL_THRESHOLD_C if threshold_c is None else threshold_c
    min_cluster = THERMAL_MIN_CLUSTER if min_cluster is None else min_cluster
    margin_c = THERMAL_MARGIN_C if margin_c is None else margin_c

    ambient = _median(frame_768[:rows * cols])
    cutoff = max(threshold_c, ambient + margin_c)

    grid = [[frame_768[r * cols + c] >= cutoff for c in range(cols)] for r in range(rows)]
    visited = [[False] * cols for _ in range(rows)]
    count = 0
    for r0 in range(rows):
        for c0 in range(cols):
            if not grid[r0][c0] or visited[r0][c0]:
                continue
            stack = [(r0, c0)]
            size = 0
            while stack:
                r, c = stack.pop()
                if r < 0 or r >= rows or c < 0 or c >= cols or visited[r][c] or not grid[r][c]:
                    continue
                visited[r][c] = True
                size += 1
                stack.append((r + 1, c)); stack.append((r - 1, c))
                stack.append((r, c + 1)); stack.append((r, c - 1))
            if size >= min_cluster:
                count += 1
                if count >= MAX_THERMAL:
                    return MAX_THERMAL
    return count


def thermal_loop():
    frame = [0.0] * 768
    while not _stop.is_set():
        try:
            _thermal_sensor.getFrame(frame)
            n = count_thermal_clusters(frame)
            with _lock:
                _state['thermal'] = max(0, min(MAX_THERMAL, int(n)))
                _state['thermal_at'] = time.monotonic()
        except Exception as e:
            log_throttled('thermal_read', logging.WARNING, f'Thermal read error: {e}')
        _stop.wait(2)


# ---------------------------------------------------------------------------
# Noise — MAX4466 mic via MCP3008 ADC channel 0 over SPI
#
# 100ms of samples are reduced to one RMS figure and thrown away. No audio is
# recorded, buffered to disk, or transmitted; speech cannot be recovered from
# a single loudness number taken every five seconds.
# ---------------------------------------------------------------------------

_spi = None


def init_noise():
    global _spi
    try:
        import spidev
        _spi = spidev.SpiDev()
        _spi.open(0, 0)
        _spi.max_speed_hz = 1_000_000
        logger.info('MCP3008 noise sensor initialized (CH0)')
        return True
    except Exception as e:
        logger.error(f'MCP3008 init failed (will report 0 dB): {e}')
        _spi = None
        return False


def _read_mcp3008_ch0():
    # Returns a 10-bit value, 0..1023
    resp = _spi.xfer2([1, (8 + 0) << 4, 0])
    return ((resp[1] & 3) << 8) + resp[2]


def compute_noise_db(samples, ref_counts=None, offset=None):
    """RMS of centred ADC counts, expressed on a log scale."""
    if not samples:
        return 0.0
    ref_counts = NOISE_REF_COUNTS if ref_counts is None else ref_counts
    offset = NOISE_DB_OFFSET if offset is None else offset
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    db = 20 * math.log10(max(rms, 1e-6) / max(ref_counts, 1e-6)) + offset
    return max(0.0, min(MAX_NOISE_DB, db))


def noise_loop():
    while not _stop.is_set():
        try:
            samples = []
            t_end = time.monotonic() + 0.1
            while time.monotonic() < t_end:
                samples.append(_read_mcp3008_ch0() - 512)  # centre around 0
                time.sleep(0.001)
            if samples:
                db = compute_noise_db(samples)
                with _lock:
                    _state['noise_window'].append(db)
                    _state['noise_db'] = sum(_state['noise_window']) / len(_state['noise_window'])
                    _state['noise_at'] = time.monotonic()
        except Exception as e:
            log_throttled('noise_read', logging.WARNING, f'Noise read error: {e}')
        _stop.wait(5)


# ---------------------------------------------------------------------------
# Buffering
#
# The queue lives in memory and is mirrored to disk only while it is non-empty,
# so the happy path never writes to the SD card. Writes are atomic (temp file +
# rename), because a power cut mid-write used to leave unparseable JSON that
# was then silently discarded whole.
# ---------------------------------------------------------------------------

_pending = []
_buffer_on_disk = False


def _valid_entry(item):
    if not isinstance(item, dict):
        return False
    for key in ('ir_beam_count', 'thermal_headcount'):
        if not isinstance(item.get(key), int) or isinstance(item.get(key), bool):
            return False
    if not isinstance(item.get('noise_db'), (int, float)) or isinstance(item.get('noise_db'), bool):
        return False
    if 'recorded_at' in item and not isinstance(item['recorded_at'], str):
        return False
    return True


def load_buffer():
    """Read the on-disk queue. Anything unparseable or malformed is dropped."""
    global _buffer_on_disk
    try:
        if not BUFFER_PATH.exists():
            return []
        raw = json.loads(BUFFER_PATH.read_text())
    except Exception as e:
        logger.error(f'Buffer file unreadable, starting empty: {e}')
        try:
            BUFFER_PATH.unlink()
        except Exception:
            pass
        return []
    if not isinstance(raw, list):
        logger.error('Buffer file was not a list, discarding it')
        return []
    _buffer_on_disk = True
    items = []
    for item in raw:
        if not _valid_entry(item):
            continue
        # A monotonic mark is meaningless across a reboot, and an undated
        # reading recovered from disk has an unknowable age. Sending it would
        # get it filed on arrival, so a Pi that sat powered off for three days
        # would dump a stale queue into the current hour and invent a crowd.
        item.pop('_mono', None)
        if not item.get('recorded_at'):
            continue
        items.append(item)
    if len(items) != len(raw):
        logger.warning(f'Dropped {len(raw) - len(items)} unusable buffered entries')
    return items[-MAX_BUFFER_ENTRIES:]


def persist_buffer():
    """Mirror the in-memory queue to disk, atomically. Never raises."""
    global _buffer_on_disk
    try:
        if not _pending:
            if _buffer_on_disk:
                try:
                    BUFFER_PATH.unlink()
                except FileNotFoundError:
                    pass
                _buffer_on_disk = False
            return
        # list() first: the push thread pops from _pending while the shutdown
        # handler can call this from the main thread, and iterating a list that
        # is shrinking under you skips entries.
        payload = [dict(item) for item in list(_pending)]
        # Give pre-NTP readings their real time before they go to disk, while
        # the monotonic mark still means something. After a reboot it does not.
        payload = [_resolve_timestamp(item) for item in payload]
        # A per-caller temp name, so those same two threads cannot land on each
        # other's half-written file.
        tmp = BUFFER_PATH.with_suffix(f'{BUFFER_PATH.suffix}.{os.getpid()}.{threading.get_ident()}.tmp')
        try:
            with open(tmp, 'w') as fh:
                json.dump(payload, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, BUFFER_PATH)
        except BaseException:
            # Leave no orphan temp file on a device nobody visits, then let the
            # handlers below decide what the failure means.
            try:
                tmp.unlink()
            except Exception:
                pass
            raise
        _buffer_on_disk = True
    except OSError as e:
        if e.errno in (errno.ENOSPC, errno.EDQUOT, errno.EROFS):
            # A full or read-only disk must not stop the device reporting. We
            # keep the queue in memory (already capped) and carry on.
            log_throttled('buffer_disk', logging.ERROR,
                          f'Cannot persist buffer ({e.strerror}); keeping it in memory only')
        else:
            log_throttled('buffer_write', logging.ERROR, f'Failed to write buffer: {e}')
    except Exception as e:
        log_throttled('buffer_write', logging.ERROR, f'Failed to write buffer: {e}')


# ---------------------------------------------------------------------------
# Push to backend
# ---------------------------------------------------------------------------

_session = None

# Statuses that will never succeed on retry. Buffering these forever is how a
# device ends up retrying a poisoned payload every 30s until someone drives out.
FATAL_PAYLOAD_STATUSES = {400, 413, 422}
# Statuses that mean the device is misconfigured rather than the payload. The
# reading is kept and retried on a long backoff, so fixing a key never needs a
# site visit and nothing taken in the meantime is thrown away.
CONFIG_ERROR_STATUSES = {401, 403, 404, 410}
# Not an HTTP status: the device refused to send at all (an http:// endpoint
# would put the key on the venue wifi in the clear). Treated as a config error.
REFUSED_LOCALLY = -1


def api_url():
    return CONFIG.get('FLOCK_API_URL', DEFAULTS['FLOCK_API_URL']).strip()


def url_is_acceptable(url):
    if url.startswith('https://'):
        return True, ''
    allow = str(CONFIG.get('ALLOW_INSECURE_URL', 'false')).strip().lower() in ('true', '1', 'yes')
    if url.startswith('http://') and allow:
        return True, 'FLOCK_API_URL is plaintext http and ALLOW_INSECURE_URL is set'
    if url.startswith('http://'):
        return False, ('FLOCK_API_URL is plaintext http — the API key would travel in the '
                       'clear over the venue wifi. Use https, or set ALLOW_INSECURE_URL=true '
                       'if this is a local test backend.')
    return False, f'FLOCK_API_URL must start with https:// (got {url[:40]!r})'


def get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({
            'Content-Type': 'application/json',
            'User-Agent': f'flock-sensor/{VERSION}',
        })
    return _session


def _post(payload):
    """POST one reading. Returns (status_code, short_body). 0 means no reply.

    The API key is set per-request and never logged, and redirects are refused:
    following one would forward the key to whatever host the redirect names.
    """
    url = api_url()
    ok, reason = url_is_acceptable(url)
    if not ok:
        # Refuse for real, not just in the log. Posting anyway would put the
        # device key on the venue's wifi in the clear, which is exactly what
        # the check exists to prevent.
        return -1, reason
    try:
        r = get_session().post(
            url,
            json=payload,
            headers={'x-api-key': CONFIG.get('FLOCK_API_KEY', '')},
            timeout=HTTP_TIMEOUT,
            allow_redirects=False,
        )
        return r.status_code, (r.text or '')[:200]
    except requests.exceptions.RequestException as e:
        return 0, str(e)[:200]
    except Exception as e:
        return 0, str(e)[:200]


def _retry_after_seconds(body):
    """How long the backend asked us to wait, if it said.

    Read out of the JSON body rather than the header so the transport shape
    here stays a plain (status, body) pair. routes/sensors.js sends both.
    """
    try:
        data = json.loads(body)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    value = data.get('retry_after_seconds')
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value <= 0 or value > 3600:
        return None
    return float(value)


def snapshot():
    """Take a reading and hand its IR crossings to exactly one payload.

    The counter resets here, not on a successful POST, so a payload waiting in
    the buffer can never have its crossings counted a second time by the next
    snapshot — the backend sums ir_beam_count across payloads.

    The other two signals are latched values, so each is checked for freshness
    before it is sent. See _fresh().
    """
    with _lock:
        ir = int(_state['ir_count'])
        thermal = int(_state['thermal'])
        thermal_at = _state['thermal_at']
        noise = float(_state['noise_db'])
        noise_at = _state['noise_at']
        _state['ir_count'] = 0

    # Outside the lock: _fresh may write a log line, and the sensor threads
    # should never be blocked behind a disk write.
    payload = {
        'ir_beam_count': ir,
        'thermal_headcount': int(_fresh(thermal, thermal_at, THERMAL_STALE_AFTER,
                                        'Thermal headcount')),
        'noise_db': round(float(_fresh(noise, noise_at, NOISE_STALE_AFTER,
                                       'Noise level')), 2),
    }

    device_id = CONFIG.get('SENSOR_DEVICE_ID', '').strip()
    if device_id:
        # The backend rejects a mismatch. That turns "this Pi was flashed with
        # the wrong venue's key" from a silent, permanent misattribution of one
        # bar's crowd to another into an immediate, visible error.
        payload['device_id'] = device_id[:100]

    if clock_is_sane():
        payload['recorded_at'] = iso_utc(time.time())
    else:
        # No NTP yet. Remember when this happened on the monotonic clock so the
        # real time can be reconstructed once the clock is set.
        payload['_mono'] = time.monotonic()
    return payload


def _resolve_timestamp(item):
    """Fill in recorded_at for a reading taken before the clock was set."""
    mono = item.pop('_mono', None)
    if 'recorded_at' in item or mono is None:
        return item
    if clock_is_sane():
        item['recorded_at'] = iso_utc(time.time() - (time.monotonic() - mono))
    # Still no valid clock: send it undated and let the backend stamp arrival.
    return item


class Pusher:
    """Owns the send schedule. Snapshot cadence and transmit cadence are
    deliberately separate: during an outage the device keeps sampling on time
    and only the delivery attempts slow down, so the time series survives."""

    def __init__(self):
        self.failures = 0
        self.auth_failures = 0
        self.rate_limits = 0
        self.next_attempt = 0.0  # monotonic

    def _schedule_rate_limit_retry(self, retry_after=None):
        """Wait the short interval a 429 actually calls for.

        Bounded at both ends on purpose. The floor is the backend's own spacing
        rule, so this can never become a hammer. The ceiling is one push
        interval, so a device being told to slow down never ends up slower than
        a device that was never told anything.
        """
        self.rate_limits = min(self.rate_limits + 1, 20)
        base = RATE_LIMIT_RETRY_MIN if retry_after is None else max(RATE_LIMIT_RETRY_MIN, retry_after)
        delay = min(base * (2 ** (self.rate_limits - 1)), float(PUSH_INTERVAL))
        delay *= random.uniform(0.85, 1.15)
        self.next_attempt = time.monotonic() + delay

    def _schedule_retry(self, auth_error=False):
        # The counters are capped as well as the delay: a device that has been
        # failing for a week would otherwise be computing 2**20000 every cycle.
        if auth_error:
            self.auth_failures = min(self.auth_failures + 1, 20)
            delay = min(AUTH_BACKOFF_START * (2 ** (self.auth_failures - 1)), AUTH_BACKOFF_MAX)
        else:
            self.failures = min(self.failures + 1, 20)
            delay = min(PUSH_INTERVAL * (2 ** self.failures), MAX_BACKOFF_SECONDS)
        delay *= random.uniform(0.85, 1.15)  # jitter, so a fleet never syncs up
        self.next_attempt = time.monotonic() + delay
        log_throttled('backoff', logging.WARNING,
                      f'Backing off {int(delay)}s before the next delivery attempt',
                      every_seconds=60)

    def _succeed(self):
        if self.failures or self.auth_failures:
            logger.info('Backend reachable again')
        self.failures = 0
        self.auth_failures = 0
        self.rate_limits = 0
        self.next_attempt = 0.0

    def flush(self):
        """Send buffered readings oldest-first. Returns True if all went out."""
        global _pending
        if time.monotonic() < self.next_attempt:
            return False

        # `handled` paces the cycle; `delivered` is what actually reached the
        # backend. Counting a dropped reading as a delivery would clear the
        # backoff and log "Delivered 12 readings" when nothing arrived.
        handled = 0
        delivered = 0
        while _pending and handled < MAX_FLUSH_PER_CYCLE:
            item = _resolve_timestamp(_pending[0])
            try:
                code, body = _post(item)
            except Exception as e:
                # _post already swallows requests' own errors; this is the
                # backstop for anything it does not anticipate. Delivery must
                # never be able to take down the only thread keeping the venue
                # reporting.
                code, body = 0, f'unexpected delivery error: {e}'

            if 200 <= code < 300:
                _pending.pop(0)
                handled += 1
                delivered += 1
                with _lock:
                    _state['last_push_history'].append(item.get('thermal_headcount', 0))
                continue

            if code in FATAL_PAYLOAD_STATUSES:
                # The server will never accept this reading. Dropping one bad
                # reading is right; retrying it forever is not.
                logger.error(f'Backend rejected a reading permanently (status {code}): {body}')
                _pending.pop(0)
                handled += 1
                continue

            if code == RATE_LIMIT_STATUS:
                # NOT an outage, and treating it as one is what stopped a device
                # ever catching up after one.
                #
                # The backend rate-limits rows that would move the venue's live
                # figure to one every MIN_LIVE_GAP_SECONDS, and its own note says
                # this costs "about a minute of extra drain". That arithmetic
                # assumed the device would wait about two seconds. It did not: a
                # 429 landed in the generic retryable branch below and bought the
                # network backoff, which escalates to fifteen minutes. So a Pi
                # draining a buffer delivered a handful of readings, hit the
                # first row inside the live window, and slept, while taking two
                # new readings a minute. Past a backlog of about fifteen minutes
                # the queue took in more than it could deliver, drifted until it
                # hit the 240-entry cap, and started dropping readings, and the
                # venue's Live Occupancy card never came back without someone
                # power-cycling the Pi. That is the one failure this whole file
                # is written to make impossible.
                if delivered:
                    self._succeed()
                log_throttled('rate_limited', logging.INFO,
                              f'Backend asked for slower delivery ({delivered} delivered '
                              f'this cycle, {len(_pending)} still queued): {body}',
                              every_seconds=300)
                self._schedule_rate_limit_retry(_retry_after_seconds(body))
                return False

            if code == REFUSED_LOCALLY or code in CONFIG_ERROR_STATUSES:
                # The device is misconfigured, not the reading. Keep the queue:
                # once someone fixes the key or the URL, everything taken in the
                # meantime still delivers. Back off hard so a wrong key is never
                # a flood, but keep retrying so a fix never needs a site visit.
                if delivered:
                    self._succeed()
                log_throttled('config_error', logging.ERROR,
                              f'Backend refused this device (status {code}): {body}. '
                              'Check FLOCK_API_KEY / FLOCK_API_URL and that the device is active.',
                              every_seconds=300)
                self._schedule_retry(auth_error=True)
                return False

            # 5xx, or no reply at all: retryable. Leave it at the head of the
            # queue and try again later.
            #
            # Readings that DID go out this cycle reset the backoff first. The
            # exponent is meant to measure how long the backend has been
            # unreachable, and a cycle that delivered eleven readings and failed
            # on the twelfth is not evidence of that. Without this the delay
            # climbed on every cycle that ended in any failure, however much
            # work the cycle had done, until a device making steady progress was
            # waiting the fifteen-minute cap between attempts.
            if delivered:
                self._succeed()
            log_throttled('push_fail', logging.ERROR,
                          f'Delivery failed (status {code}): {body}', every_seconds=120)
            self._schedule_retry()
            return False

        if delivered:
            self._succeed()
            logger.info(f'Delivered {delivered} reading(s); {len(_pending)} still queued')
        return not _pending

    def cycle(self):
        """One snapshot plus a delivery attempt. Never raises."""
        global _pending
        before = len(_pending)
        _pending.append(snapshot())
        if len(_pending) > MAX_BUFFER_ENTRIES:
            dropped = len(_pending) - MAX_BUFFER_ENTRIES
            _pending = _pending[-MAX_BUFFER_ENTRIES:]
            log_throttled('buffer_full', logging.WARNING,
                          f'Buffer full; dropped the {dropped} oldest reading(s)')
        self.flush()
        # Persist only when something is actually waiting, or when the disk copy
        # needs clearing. In normal operation this writes nothing at all.
        if _pending or before or _buffer_on_disk:
            persist_buffer()


def push_loop():
    pusher = Pusher()
    while not _stop.is_set():
        # Jitter the cadence so a fleet of devices never lands together.
        _stop.wait(PUSH_INTERVAL * random.uniform(0.95, 1.05))
        if _stop.is_set():
            break
        try:
            pusher.cycle()
        except Exception as e:
            # This thread must not be able to die. Before, a malformed buffer
            # file killed it silently: the process stayed up, systemd saw a
            # healthy service, and the venue quietly stopped reporting.
            logger.exception(f'Push cycle failed, continuing: {e}')
            time.sleep(5)


# ---------------------------------------------------------------------------
# Display loop (optional, demo unit only)
# ---------------------------------------------------------------------------

def display_loop():
    try:
        os.environ.setdefault('SDL_VIDEODRIVER', 'fbcon' if os.path.exists('/dev/fb0') else 'dummy')
        import pygame
        pygame.init()
        screen = pygame.display.set_mode((800, 480), pygame.FULLSCREEN if os.path.exists('/dev/fb0') else 0)
        pygame.mouse.set_visible(False)
        font_big = pygame.font.Font(None, 96)
        font_med = pygame.font.Font(None, 48)
        font_sm = pygame.font.Font(None, 28)

        NAVY = (30, 41, 59)
        CREAM = (241, 237, 224)
        GREEN = (16, 185, 129)
        AMBER = (245, 158, 11)
        ORANGE = (249, 115, 22)
        RED = (239, 68, 68)

        while not _stop.is_set():
            with _lock:
                ir = int(_state['ir_count'])
                therm = int(_state['thermal'])
                therm_at = _state['thermal_at']
                db = float(_state['noise_db'])
                noise_at = _state['noise_at']
                history = list(_state['last_push_history'])

            # Match what is actually being sent. A frozen number on the screen
            # while the backend is being sent 0 is the worst of both, and on the
            # demo unit it is a number a judge is looking at.
            now_mono = time.monotonic()
            therm_live = therm_at is not None and now_mono - therm_at <= THERMAL_STALE_AFTER
            noise_live = noise_at is not None and now_mono - noise_at <= NOISE_STALE_AFTER

            screen.fill(NAVY)
            top = pygame.Surface((800, 50)); top.fill((20, 28, 40)); screen.blit(top, (0, 0))
            screen.blit(font_sm.render('FLOCK VENUE SENSOR', True, CREAM), (20, 14))

            col_w = 800 // 3
            # Beam breaks since the last snapshot — crossings in either
            # direction, over at most one push interval. It was labelled
            # "Entered Today", which this number has never been.
            screen.blit(font_sm.render('Doorway crossings', True, (160, 170, 180)), (20, 80))
            screen.blit(font_big.render(str(ir), True, CREAM), (20, 120))
            screen.blit(font_sm.render('since last update', True, (110, 120, 130)), (20, 205))

            screen.blit(font_sm.render('In view now', True, (160, 170, 180)), (col_w + 20, 80))
            screen.blit(font_big.render(f'~{therm}' if therm_live else '--', True, CREAM),
                        (col_w + 20, 120))
            if not therm_live:
                screen.blit(font_sm.render('thermal offline', True, RED), (col_w + 20, 205))

            screen.blit(font_sm.render('Noise', True, (160, 170, 180)), (col_w * 2 + 20, 80))
            if noise_live:
                label = 'Quiet' if db < 50 else 'Moderate' if db < 70 else 'Lively' if db < 85 else 'Loud'
                color = GREEN if db < 50 else AMBER if db < 70 else ORANGE if db < 85 else RED
                # "level", never "dB": nobody has calibrated this against a sound
                # level meter, so it is a relative loudness index. See README.
                screen.blit(font_med.render(label, True, color), (col_w * 2 + 20, 120))
                screen.blit(font_sm.render(f'level {int(db)}', True, (160, 170, 180)), (col_w * 2 + 20, 175))
            else:
                screen.blit(font_med.render('--', True, CREAM), (col_w * 2 + 20, 120))
                screen.blit(font_sm.render('mic offline', True, RED), (col_w * 2 + 20, 175))

            if history:
                base_y = 460
                chart_h = 200
                bar_w = 60
                gap = 6
                chart_x = (800 - (bar_w + gap) * len(history)) // 2
                max_h = max(history) or 1
                for i, v in enumerate(history):
                    h = int((v / max_h) * chart_h) if max_h else 0
                    pygame.draw.rect(screen, CREAM, (chart_x + i * (bar_w + gap), base_y - h, bar_w, h))

            pygame.display.flip()
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return
            # A quarter second, not two. The demo unit's one hero moment is a
            # hand through the IR slot and the counter ticking, and a two-second
            # redraw put up to two seconds between the hand and the tick, which
            # in front of judges reads as the thing not working. Redrawing four
            # times a second costs nothing on a Pi that is otherwise idle.
            _stop.wait(0.25)
    except Exception as e:
        logger.error(f'Display loop stopped (continuing headless): {e}')


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------

def selftest():
    """Check an installation end to end and say exactly what is wrong.

    Exits 0 only if the device can actually deliver a reading.
    """
    print(f'flock-sensor {VERSION} self test')
    print(f'  board            : {pi_model() or "not a Raspberry Pi"}')
    print(f'  config file      : {CONFIG_PATH} ({"found" if CONFIG_PATH.exists() else "MISSING"})')
    print(f'  device id        : {CONFIG.get("SENSOR_DEVICE_ID") or "(not set)"}')
    print(f'  api url          : {api_url()}')
    key = CONFIG.get('FLOCK_API_KEY', '')
    print(f'  api key          : {"set (" + str(len(key)) + " chars)" if key else "MISSING"}')
    print(f'  push interval    : {PUSH_INTERVAL}s')
    print(f'  clock            : {"synced" if clock_is_sane() else "NOT SET (waiting on NTP)"}')
    print(f'  display          : {"on" if DISPLAY_ON else "headless"}')
    print(f'  buffered readings: {len(load_buffer())}')

    problems = []
    if not key:
        problems.append('FLOCK_API_KEY is not set. Ask for this venue\'s device key.')
    ok, note = url_is_acceptable(api_url())
    if not ok:
        problems.append(note)
    elif note:
        print(f'  warning          : {note}')
    if not clock_is_sane():
        # Worth failing on: with an unset clock the TLS handshake fails with
        # "certificate is not yet valid", which is a far worse error to hand an
        # installer than this sentence.
        problems.append('System clock is not set yet. Connect the Pi to the venue wifi, '
                        'wait about a minute for NTP, and run this again. '
                        '(`timedatectl` shows whether time sync is on.)')

    print('\n  hardware:')
    print('    (if the service is running, it already holds the I2C/SPI/GPIO')
    print('     devices and these may read as NOT DETECTED. Stop it first with')
    print('     `sudo systemctl stop flock-sensor` for a true hardware check.)')
    print(f'    IR break-beam  : {"ok" if init_ir() else "NOT DETECTED (reports 0)"}')
    print(f'    thermal camera : {"ok" if init_thermal() else "NOT DETECTED (reports 0)"}')
    print(f'    noise mic      : {"ok" if init_noise() else "NOT DETECTED (reports 0)"}')

    if problems:
        print('\nFAILED:')
        for p in problems:
            print(f'  - {p}')
        return 1

    # dry_run: the backend authenticates and validates this exactly as it would
    # a real push, and stores nothing. A self test must never write a fake
    # "0 people" reading into a venue's live occupancy or the model's training
    # data, and this is run every time anyone touches a unit.
    print('\n  checking credentials against the backend (nothing is stored)...')
    code, body = _post({'ir_beam_count': 0, 'thermal_headcount': 0, 'noise_db': 0.0,
                        'dry_run': True,
                        **({'device_id': CONFIG['SENSOR_DEVICE_ID'].strip()}
                           if CONFIG.get('SENSOR_DEVICE_ID', '').strip() else {})})
    if 200 <= code < 300:
        print(f'    accepted (HTTP {code}). This device is working.')
        return 0
    if code == REFUSED_LOCALLY:
        print(f'    refused before sending: {body}')
    elif code == 0:
        print(f'    no reply: {body}')
        print('    The Pi cannot reach the backend. Check wifi and any venue firewall '
              '(outbound HTTPS on port 443 must be allowed).')
    elif code in CONFIG_ERROR_STATUSES:
        print(f'    refused (HTTP {code}): {body}')
        print('    The key is wrong, the device is deactivated, or the URL is wrong.')
    else:
        print(f'    rejected (HTTP {code}): {body}')
    return 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _install_signal_handlers():
    def shutdown(*_):
        logger.info('Received shutdown signal, exiting')
        _stop.set()
        # Readings taken since the last successful delivery are worth keeping
        # across a reboot.
        try:
            persist_buffer()
        except Exception:
            pass
        try:
            import RPi.GPIO as GPIO
            GPIO.cleanup()
        except Exception:
            pass
        os._exit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):
            pass


def main():
    global _pending

    logger.info(f'=== Flock sensor {VERSION} starting ===')
    logger.info(f"Device ID: {CONFIG.get('SENSOR_DEVICE_ID') or '(not set)'}")
    logger.info(f'API URL: {api_url()}')
    logger.info(f'Push interval: {PUSH_INTERVAL}s')
    logger.info(f'Display: {"on" if DISPLAY_ON else "headless"}')
    # Never log the key itself, only whether one exists.
    if not CONFIG.get('FLOCK_API_KEY'):
        logger.error('FLOCK_API_KEY is empty — every push will be refused. '
                     'Set it in the config file and restart. Run `main.py --selftest` to check.')

    ok, note = url_is_acceptable(api_url())
    if not ok:
        # Refusing to start would be worse: systemd gives up after a few fast
        # restarts and the device is then dead until someone visits. Stay up,
        # keep buffering, and keep saying loudly what is wrong.
        logger.error(f'REFUSING TO SEND: {note}')
    elif note:
        logger.warning(note)

    # Load the queue BEFORE arming the shutdown handler. load_buffer() marks the
    # file as present, so a SIGTERM landing between that mark and the assignment
    # below would have the handler persist an empty queue and delete the file we
    # were in the middle of recovering.
    _pending = load_buffer()
    if _pending:
        logger.info(f'Recovered {len(_pending)} buffered reading(s) from disk')

    _install_signal_handlers()

    ir_ok = init_ir()
    thermal_ok = init_thermal()
    noise_ok = init_noise()
    logger.info(f'Init summary: IR={ir_ok} thermal={thermal_ok} noise={noise_ok}')
    if not (ir_ok or thermal_ok or noise_ok):
        logger.error('No sensor initialized. The device will report zeros but stay '
                     'online so it can be diagnosed remotely.')

    if thermal_ok:
        threading.Thread(target=thermal_loop, daemon=True, name='thermal').start()
    if noise_ok:
        threading.Thread(target=noise_loop, daemon=True, name='noise').start()

    push_thread = threading.Thread(target=push_loop, daemon=True, name='push')
    push_thread.start()

    if DISPLAY_ON:
        # pygame wants the main thread. If it stops, fall through to the
        # keep-alive below rather than returning — main() returning exits 0,
        # and systemd does not restart a clean exit, so a pygame crash used to
        # silently take the whole sensor offline until someone visited.
        display_loop()

    # Watchdog. If the push thread is somehow gone, exit non-zero so systemd
    # restarts the service. Sitting here alive but mute is the one failure that
    # needs a human at the venue.
    while not _stop.is_set():
        _stop.wait(60)
        if not push_thread.is_alive():
            logger.error('Push thread is gone; exiting so systemd restarts the service')
            os._exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Flock venue occupancy sensor')
    parser.add_argument('--selftest', action='store_true',
                        help='check this installation and exit')
    parser.add_argument('--version', action='version', version=f'flock-sensor {VERSION}')
    args = parser.parse_args()
    if args.selftest:
        sys.exit(selftest())
    main()
