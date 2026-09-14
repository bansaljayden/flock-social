#!/usr/bin/env python3
"""
Flock venue sensor. Runs on a Raspberry Pi at a venue entrance.

Reads three signals and POSTs them to the backend on a fixed cadence:
  - IR break-beam count: doorway crossings since the last snapshot
  - Thermal headcount: heat-cluster count from a FLIR Lepton (a count, never an image)
  - Ambient noise level: RMS level from a MAX4466 mic via an MCP3008 ADC

WHAT LEAVES THE DEVICE
    Three integers and a timestamp. Nothing else. The thermal frame is reduced
    to a cluster count in memory and discarded; the audio samples are reduced
    to one RMS number and discarded. No image, no audio, no MAC address, no
    Bluetooth or wifi probe, no identifier of any person is captured, stored
    or transmitted. This device counts. It cannot identify anyone, and it must
    never be extended to.

    The thermal camera is a 160x120 Lepton, which is twenty-five times the
    detail of the 24x32 part this program used to read, so that promise is
    doing more work than it was. There is no image library on the box: the
    frames arrive as raw temperatures through V4L2 and nothing here can encode,
    display or save one.

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
import array
import ctypes
import errno
import json
import logging
import math
import mmap
import os
import random
import select
import signal
import sys
import threading
import textwrap
import time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests

# Linux only, and only the V4L2 thermal path needs them. Imported defensively
# so the test suite still runs on a developer machine that is not a Pi, which
# is the only machine any of this has ever run on.
try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

VERSION = '1.10.0'

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
    # The live thermal view on the demo unit's touchscreen: tap the panel and
    # see what the camera sees. 1 is on, and it only ever does anything on a
    # unit that has a screen, which means a demo unit. A venue box is headless.
    # See README.md, The thermal view, before turning this on anywhere else:
    # drawing the picture means holding a real thermal frame in memory, and the
    # privacy policy's promise about venue sensors rests on that not happening.
    'THERMAL_VIEW': '1',
    # The V4L2 node the Lepton's USB breakout came up on. /dev/video0 on a Pi
    # with nothing else plugged in; `v4l2-ctl --list-devices` says for certain.
    'THERMAL_DEVICE': '/dev/video0',
    # Thermal: a pixel counts as "warm" at this many °C, but see THERMAL_MARGIN_C.
    'THERMAL_THRESHOLD_C': '28.0',
    # ...and always at least this far above the frame's own median, so a hot
    # room in August does not turn the whole grid into one giant "person".
    'THERMAL_MARGIN_C': '3.0',
    # Pixels are mean-pooled into bin x bin cells before counting, so the two
    # settings below are coupled: THERMAL_MIN_CLUSTER counts CELLS in that
    # binned grid, not raw pixels. At bin 4 the grid is 40x30, one cell is
    # sixteen pixels, and 12 cells is 192 of the sensor's 19,200.
    #
    # 4, not the 2 this shipped with. Bench 2026-09-06, PureThermal 3 and a
    # Lepton 3.5 indoors, room median about 20C: at bin 2 one standing person
    # at roughly 3 ft fragmented into 3 clusters, at bin 4 the same person
    # reads 1. That is the bare-head-against-covered-torso failure predicted
    # in count_thermal_clusters, seen for real.
    'THERMAL_BIN': '4',
    # 12 was derived from lens geometry at bin 2, where it meant 48 raw
    # pixels. At bin 4 the same 12 means 192, so it now encodes a body-sized
    # warm region rather than a head, and the bench above is what says that
    # is the right thing for it to encode. See count_thermal_clusters and
    # README.md, Calibration.
    'THERMAL_MIN_CLUSTER': '12',
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
THERMAL_DEVICE = (CONFIG.get('THERMAL_DEVICE') or DEFAULTS['THERMAL_DEVICE']).strip()
THERMAL_THRESHOLD_C = _cfg_number('THERMAL_THRESHOLD_C', float, 0.0, 100.0, 28.0)
THERMAL_MARGIN_C = _cfg_number('THERMAL_MARGIN_C', float, 0.0, 50.0, 3.0)
THERMAL_BIN = _cfg_number('THERMAL_BIN', int, 1, 8, 4)
THERMAL_MIN_CLUSTER = _cfg_number('THERMAL_MIN_CLUSTER', int, 1, 19200, 12)
THERMAL_VIEW = _cfg_number('THERMAL_VIEW', int, 0, 1, 1)

# The bench measured the pair (4, 12) and nothing else, and the two settings are
# not independent: a cell is bin x bin pixels, so the SAME 12 means 48 raw pixels
# at bin 2 and 768 at bin 8. Each is range-checked on its own above, which is not
# enough. Two combinations reachable from a config file silently count nobody,
# ever, with no error and no log line, and the README used to walk installers
# straight into one of them: its troubleshooting row for "one person counted as
# two or three" said to raise THERMAL_BIN, and at bin 6, 7 or 8 the shipped
# minimum of 12 is more area than a whole person occupies.
#
# The band below is in raw pixels, which is the physical quantity, and is
# anchored on the two numbers there is evidence for: 192 raw pixels is the
# measured working threshold, and a person is at least the 320-pixel blob these
# tests are built from. Outside the band the pair is refused rather than clamped,
# because a threshold nobody measured is not an improvement on the one somebody
# did.
_MEASURED_BIN, _MEASURED_MIN_CLUSTER = 4, 12
_NOMINAL_PERSON_PIXELS = 320
_MIN_SANE_THRESHOLD_PIXELS = 48


def validated_thermal_pair(bin_size, min_cluster):
    """Return (bin, min_cluster, complaint); complaint is None when the pair is sane.

    Pure, so the arithmetic that can switch a venue's sensor off gets checked
    without a camera.
    """
    raw = min_cluster * bin_size * bin_size
    if raw > _NOMINAL_PERSON_PIXELS:
        return (_MEASURED_BIN, _MEASURED_MIN_CLUSTER,
                f'THERMAL_BIN={bin_size} with THERMAL_MIN_CLUSTER={min_cluster} needs '
                f'{raw} warm pixels before it counts anybody, and a person is about '
                f'{_NOMINAL_PERSON_PIXELS}. That pair counts nobody, ever. Falling back '
                f'to the measured {_MEASURED_BIN}/{_MEASURED_MIN_CLUSTER}. For a coarser '
                f'bin, bring THERMAL_MIN_CLUSTER down with it: min_cluster times bin '
                f'squared is the number to keep near 192.')
    if raw < _MIN_SANE_THRESHOLD_PIXELS:
        return (_MEASURED_BIN, _MEASURED_MIN_CLUSTER,
                f'THERMAL_BIN={bin_size} with THERMAL_MIN_CLUSTER={min_cluster} counts '
                f'anything over {raw} warm pixels as a person, which is inside this '
                f'sensor own noise. Falling back to the measured '
                f'{_MEASURED_BIN}/{_MEASURED_MIN_CLUSTER}.')
    return bin_size, min_cluster, None


THERMAL_BIN, THERMAL_MIN_CLUSTER, _pair_complaint = validated_thermal_pair(
    THERMAL_BIN, THERMAL_MIN_CLUSTER)
NOISE_REF_COUNTS = _cfg_number('NOISE_REF_COUNTS', float, 1e-6, 1024.0, 1.0)
NOISE_DB_OFFSET = _cfg_number('NOISE_DB_OFFSET', float, -100.0, 200.0, 50.0)

# Ceilings mirrored from backend/routes/sensors.js. Sending a value the server
# will reject only wastes a retry, so clamp here too. The ceilings are the
# server's to change, not this program's; they are right for either thermal
# sensor this project has specified.
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

# Both halves are required, and the display half is the one that matters: a
# venue unit has no screen, so it never retains a frame no matter what its
# config says. The setting exists so a demo unit can be turned into a venue
# unit by editing one line rather than by trusting that nobody plugs a panel in.
THERMAL_VIEW_ON = bool(DISPLAY_ON and THERMAL_VIEW)


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
    # The most recent thermal frame, and ONLY when THERMAL_VIEW_ON. On any unit
    # without a screen this stays None for the life of the process, which is
    # what keeps 'the grid is reduced to a count and thrown away' literally true
    # of a venue sensor. It is never written to disk and never transmitted; the
    # push payload is three integers and cannot carry it.
    'thermal_frame': None,
    'thermal_frame_at': None,
}
_stop = threading.Event()


def _fresh(value, taken_at, max_age, name):
    """Return a latched reading only while it is still current, else 0.

    `thermal` and `noise_db` are the last value their loop managed to read and
    nothing ever cleared them. A sensor that answered fine at 9pm and stopped
    answering at 11pm (a camera dropping off the USB bus, a wedged SPI bus)
    therefore went on reporting 11pm's headcount every 30 seconds until someone
    power-cycled the Pi: an ordinary hardware failure,
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
# Thermal: FLIR Lepton 3.5, 160x120, over USB
#
# The Lepton sits on a PureThermal breakout, which presents it to Linux as a
# USB Video Class device (/dev/video0 on a Pi with nothing else plugged in).
# In radiometric TLinear mode every pixel is an absolute temperature in
# centikelvin, so one frame is 19,200 sixteen-bit temperature readings.
#
# It is read here through raw V4L2 ioctls. No OpenCV, no PIL, no picamera:
# there is nothing on this box that can encode, compress, display or save a
# picture. The bytes become a list of temperatures, the temperatures become
# one integer, and the frame is dropped. That is a promise the published
# privacy policy makes on this code's behalf, and it is a bigger promise than
# it was: 19,200 readings is twenty-five times what the sensor this file used
# to drive produced, and a frame kept from this one would be recognisably a
# scene. Nothing here keeps one.
#
# THE COUNTING MATHS WAS TUNED FOR THE COARSE SENSOR AND HAS NOT BEEN
# RE-MEASURED ON THIS ONE. Read the calibration note on
# count_thermal_clusters before trusting a headcount out of it.
# ---------------------------------------------------------------------------

# Sensor geometry. These two names are read by
# frontend/src/__tests__/legalPagesMatchCode.test.js, which pins the privacy
# policy's "160 by 120 grid" and "19,200 temperature readings" to them, so
# swapping the sensor turns that test red on the same commit.
THERMAL_COLS, THERMAL_ROWS = 160, 120
THERMAL_PIXELS = THERMAL_COLS * THERMAL_ROWS

# Radiometric Y16 is centikelvin.
_CENTIKELVIN = 0.01
_KELVIN_ZERO_C = 273.15

# A frame whose entire spread is under this is the shutter, not the room. The
# Lepton runs a flat field correction every few minutes and closes an internal
# shutter over the sensor to do it. That frame is one uniform surface, it would
# count zero people, and at a 30 second push cadence it can easily be the most
# recent reading when a push happens. Skipped, rather than latched as an empty
# room.
FFC_FLAT_SPREAD_C = 0.5

# A radiometric frame of a room lands somewhere in this range. Outside it the
# camera is almost certainly not in TLinear mode, in which case the pixel
# values are not temperatures at all and no threshold over them means anything.
# Reporting 0 and saying why beats reporting a number derived from AGC counts.
PLAUSIBLE_MEDIAN_C = (-20.0, 60.0)

# --- V4L2, by hand -------------------------------------------------------
# Deliberately not through a capture library. Every Python package that reads a
# UVC device brings an image pipeline with it (cv2, PIL, numpy image IO), and
# an image pipeline on this device is the one thing the privacy policy says is
# not here. These are the eight ioctls needed to stream Y16 and nothing else.

_V4L2_BUF_TYPE_VIDEO_CAPTURE = 1
_V4L2_MEMORY_MMAP = 1
_V4L2_CAP_VIDEO_CAPTURE = 0x00000001
_V4L2_CAP_STREAMING = 0x04000000
# 'Y16 ': 16-bit greyscale, which for a radiometric Lepton is a temperature per
# pixel. Not a colour format and not a compressed one.
_V4L2_PIX_FMT_Y16 = 0x20363159

_u8 = ctypes.c_uint8
_u32 = ctypes.c_uint32


class _v4l2_capability(ctypes.Structure):
    _fields_ = [('driver', ctypes.c_char * 16), ('card', ctypes.c_char * 32),
                ('bus_info', ctypes.c_char * 32), ('version', _u32),
                ('capabilities', _u32), ('device_caps', _u32),
                ('reserved', _u32 * 3)]


class _v4l2_pix_format(ctypes.Structure):
    _fields_ = [('width', _u32), ('height', _u32), ('pixelformat', _u32),
                ('field', _u32), ('bytesperline', _u32), ('sizeimage', _u32),
                ('colorspace', _u32), ('priv', _u32), ('flags', _u32),
                ('ycbcr_enc', _u32), ('quantization', _u32), ('xfer_func', _u32)]


class _v4l2_format_union(ctypes.Union):
    # `_align` is not a field the kernel has and it is not decoration. The real
    # union carries struct v4l2_window, which holds two pointers, so on a
    # 64-bit kernel the union is 8-byte aligned and sizeof(struct v4l2_format)
    # is 208 rather than 204. The ioctl request number encodes that size, so
    # getting it wrong does not produce a subtly wrong frame, it produces
    # ENOTTY on VIDIOC_S_FMT and a camera that never opens. A pointer member
    # reproduces the alignment on both 32- and 64-bit, which is why the size
    # is asserted in test_main.py rather than trusted.
    _fields_ = [('pix', _v4l2_pix_format), ('raw_data', _u8 * 200),
                ('_align', ctypes.c_void_p)]


class _v4l2_format(ctypes.Structure):
    _fields_ = [('type', _u32), ('fmt', _v4l2_format_union)]


class _v4l2_requestbuffers(ctypes.Structure):
    _fields_ = [('count', _u32), ('type', _u32), ('memory', _u32),
                ('capabilities', _u32), ('flags', _u8), ('reserved', _u8 * 3)]


class _timeval(ctypes.Structure):
    _fields_ = [('tv_sec', ctypes.c_long), ('tv_usec', ctypes.c_long)]


class _v4l2_timecode(ctypes.Structure):
    _fields_ = [('type', _u32), ('flags', _u32), ('frames', _u8),
                ('seconds', _u8), ('minutes', _u8), ('hours', _u8),
                ('userbits', _u8 * 4)]


class _v4l2_buffer_m(ctypes.Union):
    _fields_ = [('offset', _u32), ('userptr', ctypes.c_ulong),
                ('planes', ctypes.c_void_p), ('fd', ctypes.c_int32)]


class _v4l2_buffer(ctypes.Structure):
    _fields_ = [('index', _u32), ('type', _u32), ('bytesused', _u32),
                ('flags', _u32), ('field', _u32), ('timestamp', _timeval),
                ('timecode', _v4l2_timecode), ('sequence', _u32),
                ('memory', _u32), ('m', _v4l2_buffer_m), ('length', _u32),
                ('reserved2', _u32), ('request_fd', ctypes.c_int32)]


def _ioc(direction, nr, size):
    """Encode an ioctl request number the way <asm/ioctl.h> does.

    Returned signed when it does not fit a positive 32-bit int, because
    fcntl.ioctl wants a C int and every V4L2 read/write ioctl has the top bit
    set.
    """
    op = (direction << 30) | (size << 16) | (ord('V') << 8) | nr
    return op - (1 << 32) if op >= (1 << 31) else op


_VIDIOC_QUERYCAP = _ioc(2, 0, ctypes.sizeof(_v4l2_capability))
_VIDIOC_S_FMT = _ioc(3, 5, ctypes.sizeof(_v4l2_format))
_VIDIOC_REQBUFS = _ioc(3, 8, ctypes.sizeof(_v4l2_requestbuffers))
_VIDIOC_QUERYBUF = _ioc(3, 9, ctypes.sizeof(_v4l2_buffer))
_VIDIOC_QBUF = _ioc(3, 15, ctypes.sizeof(_v4l2_buffer))
_VIDIOC_DQBUF = _ioc(3, 17, ctypes.sizeof(_v4l2_buffer))
_VIDIOC_STREAMON = _ioc(1, 18, ctypes.sizeof(ctypes.c_int))
_VIDIOC_STREAMOFF = _ioc(1, 19, ctypes.sizeof(ctypes.c_int))

# uvcvideo sets this on a buffer whose frame lost USB packets, which is
# ordinary on a bus carrying a Lepton. The buffer is reused, so the missing
# region still holds the PREVIOUS frame's bytes and bytesused is often full
# size: a torn frame that is half now and half two seconds ago looks
# perfectly plausible to every other check in this file.
_V4L2_BUF_FLAG_ERROR = 0x00000040

_BUFFER_COUNT = 4
_FRAME_WAIT_SECONDS = 2.0


class ThermalCamera:
    """Y16 frames off a V4L2 node, as a list of degrees Celsius.

    UNVERIFIED ON HARDWARE. Every ioctl below is written from the V4L2 and
    Lepton documentation and has never been issued to a real PureThermal
    board. The thing it is most likely to have wrong is the pixel format: some
    PureThermal firmware exposes two nodes, one raw Y16 and one 8-bit AGC
    greyscale, and the AGC one will open, stream, and produce numbers that are
    not temperatures. is_plausible_frame() is the guard against quietly
    counting people out of those.
    """

    def __init__(self, path, cols=THERMAL_COLS, rows=THERMAL_ROWS):
        self.path = path
        self.cols = cols
        self.rows = rows
        self.fd = None
        self.buffers = []
        self.streaming = False
        self.frame_bytes = cols * rows * 2

    def open(self):
        if fcntl is None:
            raise OSError('V4L2 needs Linux; this host has no fcntl')
        # O_NONBLOCK matters more than it looks. After a UVC disconnect the
        # driver can report the fd readable and then never return from DQBUF
        # (raspberrypi/linux#1211), which on a blocking fd hangs the thermal
        # thread forever with no exception and no log line. Non-blocking turns
        # that into the EAGAIN this code already handles.
        self.fd = os.open(self.path, os.O_RDWR | os.O_NONBLOCK)
        try:
            self._configure()
        except Exception:
            # Every raise below used to leave the fd open. A raw fd is an int
            # with no finalizer, so it held the V4L2 node for the life of the
            # process and the next open of the same camera got EBUSY. That was
            # survivable while init ran exactly once. It is not survivable now
            # that thermal_loop re-opens after a dropout.
            self.close()
            raise

    def _configure(self):

        cap = _v4l2_capability()
        fcntl.ioctl(self.fd, _VIDIOC_QUERYCAP, cap)
        caps = cap.device_caps or cap.capabilities
        if not caps & _V4L2_CAP_VIDEO_CAPTURE:
            raise OSError(f'{self.path} is not a video capture device')
        if not caps & _V4L2_CAP_STREAMING:
            raise OSError(f'{self.path} does not support streaming I/O')

        fmt = _v4l2_format()
        fmt.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
        fmt.fmt.pix.width = self.cols
        fmt.fmt.pix.height = self.rows
        fmt.fmt.pix.pixelformat = _V4L2_PIX_FMT_Y16
        fmt.fmt.pix.field = 1  # V4L2_FIELD_NONE
        fcntl.ioctl(self.fd, _VIDIOC_S_FMT, fmt)
        # V4L2 is allowed to answer with something other than what was asked
        # for, and a silent substitution here is how you end up counting heat
        # clusters in a colour image. Refuse it instead.
        if fmt.fmt.pix.pixelformat != _V4L2_PIX_FMT_Y16:
            raise OSError('camera would not give a raw Y16 stream; this node is '
                          'probably the 8-bit AGC one rather than the radiometric one')
        # The counter never passes rows/cols, so it always reinterprets the
        # buffer as THERMAL_ROWS x THERMAL_COLS whatever the driver returned.
        # Accepting a substitution here therefore does not adapt anything, it
        # just reads the buffer at the wrong stride while every plausibility
        # check still passes. Two real ways this happens: a 160x122 telemetry
        # descriptor (the PureThermal advertises both, and asking for 160x120
        # is what keeps telemetry off), and a board carrying an 80x60 Lepton
        # 2.5 instead of a 3.5, which used to report 0 forever with the
        # freshness clock still green and not one line in the log.
        if (int(fmt.fmt.pix.width), int(fmt.fmt.pix.height)) != (self.cols, self.rows):
            raise OSError(
                f'camera gave {fmt.fmt.pix.width}x{fmt.fmt.pix.height}, not '
                f'{self.cols}x{self.rows}. 160x122 is the telemetry descriptor; '
                f'80x60 is a Lepton 2.5, which this program cannot count from. '
                f'Run `v4l2-ctl -d {self.path} --list-formats-ext`.')
        self.frame_bytes = self.cols * self.rows * 2

        req = _v4l2_requestbuffers()
        req.count = _BUFFER_COUNT
        req.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
        req.memory = _V4L2_MEMORY_MMAP
        fcntl.ioctl(self.fd, _VIDIOC_REQBUFS, req)
        if req.count < 1:
            raise OSError('driver would not allocate any capture buffers')

        for index in range(req.count):
            buf = _v4l2_buffer()
            buf.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
            buf.memory = _V4L2_MEMORY_MMAP
            buf.index = index
            fcntl.ioctl(self.fd, _VIDIOC_QUERYBUF, buf)
            region = mmap.mmap(self.fd, buf.length, mmap.MAP_SHARED,
                               mmap.PROT_READ | mmap.PROT_WRITE,
                               offset=buf.m.offset)
            self.buffers.append(region)
            fcntl.ioctl(self.fd, _VIDIOC_QBUF, buf)

        arg = ctypes.c_int(_V4L2_BUF_TYPE_VIDEO_CAPTURE)
        fcntl.ioctl(self.fd, _VIDIOC_STREAMON, arg)
        self.streaming = True
        return self

    def read_frame(self):
        """Newest available frame as Celsius, or None if none arrived in time.

        Drains to the newest rather than taking the head of the queue. This
        loop reads once every couple of seconds against a camera producing
        about nine frames a second, so the oldest queued buffer is always
        seconds stale, and a stale frame latched as "in view now" is the exact
        failure _fresh() exists to stop.
        """
        newest = None
        deadline = time.monotonic() + _FRAME_WAIT_SECONDS
        while True:
            timeout = 0.0 if newest is not None else max(0.0, deadline - time.monotonic())
            ready, _, _ = select.select([self.fd], [], [], timeout)
            if not ready:
                break
            buf = _v4l2_buffer()
            buf.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
            buf.memory = _V4L2_MEMORY_MMAP
            try:
                fcntl.ioctl(self.fd, _VIDIOC_DQBUF, buf)
            except OSError as e:
                if e.errno == errno.EAGAIN:
                    break
                raise
            try:
                # bytesused 0 used to fall through `or self.frame_bytes` and get
                # copied as a full frame, handing back whatever was already in
                # that mmap region: the previous frame latched as current, or
                # zeros. V4L2 reports exactly that on a dropped isochronous
                # frame. Neither is a reading.
                used = int(buf.bytesused)
                torn = bool(int(buf.flags) & _V4L2_BUF_FLAG_ERROR)
                if not torn and used >= self.frame_bytes:
                    newest = bytes(self.buffers[buf.index][:self.frame_bytes])
            finally:
                # Always give the buffer back. Leaking one starves the queue and
                # the camera stops delivering after four reads.
                fcntl.ioctl(self.fd, _VIDIOC_QBUF, buf)
        if newest is None:
            return None
        return raw_y16_to_celsius(newest)

    def close(self):
        try:
            if self.streaming and self.fd is not None:
                arg = ctypes.c_int(_V4L2_BUF_TYPE_VIDEO_CAPTURE)
                fcntl.ioctl(self.fd, _VIDIOC_STREAMOFF, arg)
        except Exception:
            pass
        self.streaming = False
        for region in self.buffers:
            try:
                region.close()
            except Exception:
                pass
        self.buffers = []
        if self.fd is not None:
            try:
                os.close(self.fd)
            except Exception:
                pass
            self.fd = None


_thermal_camera = None


def raw_y16_to_celsius(raw):
    """Radiometric centikelvin, little endian, to a flat list of Celsius."""
    values = array.array('H')
    values.frombytes(raw)
    if sys.byteorder == 'big':
        values.byteswap()
    return [v * _CENTIKELVIN - _KELVIN_ZERO_C for v in values]


def _set_thermal_camera(camera):
    global _thermal_camera
    _thermal_camera = camera


def init_thermal():
    """Open the thermal camera, replacing any camera already open.

    Called at boot and again by thermal_loop after a run of failed reads. The
    close is what makes the second case safe: this used to assign over
    _thermal_camera without closing it, so re-initing a live camera left the
    old fd streaming, the new REQBUFS returned EBUSY, the except set
    _thermal_camera to None, and a camera that was working was then off for
    the rest of the deployment.
    """
    global _thermal_camera
    if _thermal_camera is not None:
        try:
            _thermal_camera.close()
        except Exception:
            pass
        _thermal_camera = None
    try:
        camera = ThermalCamera(THERMAL_DEVICE)
        camera.open()
        _thermal_camera = camera
        logger.info(f'Lepton thermal camera initialized on {THERMAL_DEVICE} '
                    f'({camera.cols}x{camera.rows}, raw Y16)')
        return True
    except Exception as e:
        logger.error(f'Lepton init failed on {THERMAL_DEVICE} '
                     f'(will report 0 headcount): {e}')
        if not os.path.exists(THERMAL_DEVICE):
            logger.error(f'{THERMAL_DEVICE} does not exist. Check the USB cable to the '
                         'PureThermal board, run `v4l2-ctl --list-devices`, and set '
                         'THERMAL_DEVICE in the config if the camera came up on a '
                         'different node.')
        _thermal_camera = None
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


def bin_frame(frame, rows, cols, bin_size):
    """Mean-pool a frame into (rows//bin) x (cols//bin) cells.

    Two reasons, neither cosmetic. The Lepton's per-pixel noise is visible at
    this resolution, and one noisy pixel beside a warm body either bridges two
    people into one cluster or splits one into two. And a flood fill over
    19,200 cells in Python is twenty-five times the work it was over 768, on a
    loop that also has to stay responsive.
    """
    if bin_size <= 1:
        return list(frame[:rows * cols]), rows, cols
    out_rows = rows // bin_size
    out_cols = cols // bin_size
    divisor = float(bin_size * bin_size)
    cells = []
    for r in range(out_rows):
        base = r * bin_size
        for c in range(out_cols):
            start = c * bin_size
            total = 0.0
            for dr in range(bin_size):
                row_offset = (base + dr) * cols + start
                for dc in range(bin_size):
                    total += frame[row_offset + dc]
            cells.append(total / divisor)
    return cells, out_rows, out_cols


def is_shutter_frame(frame, spread_c=FFC_FLAT_SPREAD_C):
    """True when the frame is one flat surface, i.e. the FFC shutter.

    KNOWN WEAK, and deliberately left alone. max minus min is an extreme-value
    statistic over 19,200 pixels, and at the datasheet's sub-50 mK NEdT the
    expected range of pure noise on a flat scene is already around 0.4C, so a
    0.5C test is sitting close to its own noise floor and two stuck pixels
    defeat it. The obvious repair, trimming to the 1st and 99th percentile,
    was tried and reverted: 1% of this frame is 192 pixels, which is the size
    of a person at the far end of the range this sensor works at, so the
    trimmed version discards a distant body as a flat frame. Dropping a real
    reading is worse than occasionally counting a shutter, so this stays as it
    is until somebody measures a real FFC on a real unit.

    Worth knowing what this is and is not for. The Lepton's FFC most likely
    shows up as a GAP in the stream rather than a flat frame: the shutter takes
    about 0.9s, the part emits discard packets while it has no new frame, and
    _FRAME_WAIT_SECONDS is longer than that, so read_frame simply waits. This
    guard is cheap insurance for the case where a flat frame does arrive. It is
    also why thermal_loop now asks whether the numbers are temperatures at all
    BEFORE it asks whether they are flat: an all-zero frame is flat too.
    """
    if not frame:
        return True
    return (max(frame) - min(frame)) < spread_c


def is_plausible_frame(frame):
    """True when these numbers can be room temperatures at all.

    A Lepton that is not in radiometric TLinear mode still opens, still
    streams, and still hands over 19,200 sixteen-bit numbers. They are AGC
    counts, and thresholding them at 28.0 produces something that looks like a
    headcount and means nothing.
    """
    if not frame:
        return False
    low, high = PLAUSIBLE_MEDIAN_C
    return low <= _median(frame) <= high


# Which point in the frame stands for "the room".
#
# This was the median, and the median is the room only while the room is mostly
# not people. Past about half the frame covered, the median IS a body, the cutoff
# climbs above body temperature, and the count collapses to 0. Measured on the
# real counter with 24 separated bodies: correct up to 40% coverage, then 0 at
# 60% and 0 at 70%. A packed entrance therefore published the same number as an
# empty one, at the exact moment the number is worth something.
#
# The 20th percentile is the room's cool background whether the frame is empty or
# full. Checked against every scene that could be constructed, including a hot
# 30C day and a cold draft patch across a third of the frame: it agrees with the
# median everywhere the median was right, and it counts 24 of 24 where the median
# counted 0. Lower is not better; at the 10th percentile the cutoff drops far
# enough that bodies merge and 24 reads as 6.
_AMBIENT_PERCENTILE = 0.20


def _ambient(cells):
    """The background temperature of the scene, robust to the scene being full."""
    if not cells:
        return 0.0
    ordered = sorted(cells)
    return ordered[min(len(ordered) - 1, int(len(ordered) * _AMBIENT_PERCENTILE))]

# ---------------------------------------------------------------------------
# Scene background
#
# A radiator, a kitchen pass, a heat lamp, a television, an espresso machine or
# a sunlit patch of floor is warm in every single frame. A per-frame estimate of
# the room cannot see it, because the object is in every frame that estimate is
# built from, so it adds a constant +1 or +2 to that venue's headcount forever,
# including a locked venue at 4am. For the crowd model that is worse than it
# looks on the card: a constant offset is learned as a property of the venue and
# validation never sees it.
#
# The fix is per-cell and over time rather than per-frame and over space. What is
# modelled is the RESIDUAL, cell minus the frame's own background estimate, which
# makes it immune to slow ambient drift and to the offset step the Lepton leaves
# behind after every flat field correction.
#
# Two properties make this safe to have on by default on a device nobody has run
# for a full shift:
#
#   1. It can only ever SUBTRACT a detection. The warm test is the old cutoff
#      AND the residual test, so the worst this can do is miss somebody. It
#      cannot invent a person, which is the error this project treats as the
#      unacceptable one.
#   2. It reports nothing at all while seeding, so the first minute cannot
#      publish a number built on a half-learned scene. _fresh already knows how
#      to say "no reading" honestly.
#
# Seeding takes the per-cell MINIMUM residual rather than the mean: somebody who
# walks through during the seed window never enters the background, while a
# radiator that is hot for the whole minute does. Somebody who stands perfectly
# still for the entire seed does get burned in, and that is a real failure; it
# self-corrects over roughly one time constant once they move.
#
# PRIVACY, and this needs a human decision rather than a green test suite. The
# published policy says the thermal grid is reduced to a count and thrown away.
# This holds 1,200 numbers in RAM: a 4x4-pooled, low-pass-filtered, residual
# representation of a static scene. It is never written to disk, never
# transmitted, and at that pooling it is not a recognisable image of anything,
# and the raw 19,200-pixel frame this program already holds transiently is
# strictly more revealing than it. The wording still deserves a read before the
# first venue install. The test that pins the policy parses imports, so it will
# not fire on this either way, which is exactly why it is written down here.
_BG_SEED_FRAMES = 30
_BG_ALPHA = 0.002
_BG_STILL_DIVISOR = 20
_BG_DELTA_C = 1.5


class SceneBackground:
    """Per-cell residual background, learned over time and slowly forgotten."""

    def __init__(self, seed_frames=_BG_SEED_FRAMES, alpha=_BG_ALPHA,
                 delta_c=_BG_DELTA_C, still_divisor=_BG_STILL_DIVISOR):
        self.seed_frames = seed_frames
        self.alpha = alpha
        self.delta_c = delta_c
        self.still_divisor = still_divisor
        self.seen = 0
        self.bg = None

    @property
    def ready(self):
        return self.bg is not None and self.seen >= self.seed_frames

    def observe(self, cells, ambient, foreground=()):
        """Fold one frame in. `foreground` marks cells currently held to be people."""
        residual = [c - ambient for c in cells]
        if self.bg is None or len(self.bg) != len(residual):
            self.bg = list(residual)
            self.seen = 1
            return
        self.seen += 1
        if self.seen <= self.seed_frames:
            # Cold-biased seed: the quietest this cell has been so far.
            for i, r in enumerate(residual):
                if r < self.bg[i]:
                    self.bg[i] = r
            return
        fg = set(foreground)
        slow = self.alpha / float(self.still_divisor)
        for i, r in enumerate(residual):
            a = slow if i in fg else self.alpha
            self.bg[i] += a * (r - self.bg[i])

    def mask(self, cells, ambient):
        """Cells that are warmer than this scene usually is. None until seeded."""
        if not self.ready:
            return None
        return [(c - ambient) - b >= self.delta_c for c, b in zip(cells, self.bg)]

def count_thermal_clusters(frame, threshold_c=None, min_cluster=None,
                           margin_c=None, rows=None, cols=None, bin_size=None,
                           mask=None):
    """Flood fill over a binned thermal frame. Returns a cluster count.

    The threshold floats above the frame's own median. With a fixed 28C
    threshold, a bar at 29C ambient, which is a packed bar in summer and
    exactly when the number matters most, marked every pixel warm and
    collapsed the whole room
    into a single cluster, reporting "1 person". That reasoning is unchanged
    from the coarse sensor and matters more here, not less: a Lepton's absolute
    accuracy without a calibration target is several degrees, so the
    median-relative margin does nearly all the work and THERMAL_THRESHOLD_C is
    closer to a floor than a real decision.

    MEASURED ONCE, 2026-09-06, on a PureThermal 3 and a Lepton 3.5 indoors at
    a room median near 20C. Both halves of what that established matter:

      - Fragmentation is real, and THERMAL_BIN is the lever for it. A person
        whose torso is covered and whose head is bare does come apart at this
        resolution: at bin 2 one person at about 3 ft read as 3 clusters. At
        bin 4 the same person reads 1, and an empty room reads 0 at both.
        Bin 4 is the default now.
      - THERMAL_MIN_CLUSTER survived that change at 12 without retuning, and
        it no longer means what its derivation said. 12 cells is 48 raw
        pixels at bin 2 and 192 at bin 4. The lens arithmetic in README.md
        cannot get 192 pixels out of a head past about 2 m, and a whole
        standing body supplies it comfortably at 3 m, so the threshold now
        encodes a body-sized warm region rather than a head.

    That shows up as the one repeatable miss on the bench: at 8 to 10 ft a
    full silhouette counts every time and a partially cropped one at the edge
    of frame does not. This function counts warm AREA, and whether a person
    crossing a real doorway is fully in frame is a mounting-angle question,
    which is the thing to settle before a first venue install rather than
    after it.

    Still unmeasured: two people at once, and any distance past 10 ft. A count
    that has never seen two bodies is not yet a headcount.
    """
    rows = THERMAL_ROWS if rows is None else rows
    cols = THERMAL_COLS if cols is None else cols
    if len(frame) < rows * cols:
        return 0
    min_cluster = THERMAL_MIN_CLUSTER if min_cluster is None else min_cluster
    sizes = thermal_region_sizes(frame, threshold_c=threshold_c, margin_c=margin_c,
                                 rows=rows, cols=cols, bin_size=bin_size,
                                 mask=mask)
    return min(MAX_THERMAL, sum(1 for s in sizes if s >= min_cluster))


def thermal_region_sizes(frame, threshold_c=None, margin_c=None,
                         rows=None, cols=None, bin_size=None, mask=None):
    """Every connected warm region in the frame, as a list of cell counts.

    The same flood fill count_thermal_clusters runs, with the minimum-size
    filter left off. Nothing on the serving path wants this. --calibrate does,
    because the questions it asks are "how big is a person from here" and "how
    big does this room's noise get", and the filter throws both answers away.

    Split out rather than copied: two flood fills that were supposed to agree
    would eventually stop agreeing, and the one in the calibration path is the
    one nobody would notice had drifted.
    """
    rows = THERMAL_ROWS if rows is None else rows
    cols = THERMAL_COLS if cols is None else cols
    if len(frame) < rows * cols:
        return []
    threshold_c = THERMAL_THRESHOLD_C if threshold_c is None else threshold_c
    margin_c = THERMAL_MARGIN_C if margin_c is None else margin_c
    bin_size = THERMAL_BIN if bin_size is None else bin_size

    cells, rows, cols = bin_frame(frame, rows, cols, max(1, int(bin_size)))
    ambient = _ambient(cells)
    cutoff = max(threshold_c, ambient + margin_c)

    # The background mask can only take cells away, never add them: a cell
    # has to clear the cutoff AND be warmer than this scene usually is. So a
    # background model that has gone wrong loses a person; it cannot conjure
    # one, and that asymmetry is what makes it safe to run unattended.
    def _warm(i):
        return cells[i] >= cutoff and (mask is None or mask[i])

    grid = [[_warm(r * cols + c) for c in range(cols)] for r in range(rows)]
    visited = [[False] * cols for _ in range(rows)]
    sizes = []
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
                # Eight-connectivity, where the coarse sensor used four. At
                # 24x32 a diagonal gap between two warm pixels was almost
                # always two people. At this resolution it is almost always one
                # person with a cooler patch across them.
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        if dr or dc:
                            stack.append((r + dr, c + dc))
            sizes.append(size)
    return sizes


# After this many consecutive reads that produced nothing usable, stop trusting
# the file descriptor and open the camera again. At a 2s cadence that is about
# 30s of silence, comfortably longer than any FFC (0.9s) or frame timeout (2s),
# and shorter than the 90s staleness latch, so a camera that comes back is
# reporting again before the venue card has finished going quiet.
_THERMAL_REOPEN_AFTER = 15
_THERMAL_REOPEN_BACKOFF_MAX = 300.0


# One frame in roughly fifteen used to decide the label for a whole 30 second
# row, in the corpus the crowd model trains on. A single silhouette split, a
# frame taken as somebody crosses the edge of view, or the frame right after a
# flat field correction became that row's ground truth. The median of the window
# costs fifteen integers and rejects all three. It does not fix bias, only
# variance, and that is the point: it makes every other accuracy change
# measurable instead of drowned in single-frame noise.
_THERMAL_WINDOW = 15
_thermal_window = deque(maxlen=_THERMAL_WINDOW)

def count_people(frame, scene=None):
    """Cluster count for one frame, with the scene background folded in.

    Returns None while the background is still seeding, which is a different
    thing from 0 and is reported as one: the caller leaves the freshness clock
    alone, so the device says "no reading yet" rather than "nobody here".
    """
    if scene is None:
        return count_thermal_clusters(frame)
    cells, rows, cols = bin_frame(frame, THERMAL_ROWS, THERMAL_COLS, max(1, int(THERMAL_BIN)))
    ambient = _ambient(cells)
    cutoff = max(THERMAL_THRESHOLD_C, ambient + THERMAL_MARGIN_C)
    # Cells the old rule calls warm are the ones held to be people this frame, and
    # they are the ones the background must learn slowly rather than absorb.
    foreground = [i for i, c in enumerate(cells) if c >= cutoff]
    scene.observe(cells, ambient, foreground)
    if not scene.ready:
        return None
    return count_thermal_clusters(frame, mask=scene.mask(cells, ambient))

def thermal_loop():
    """Read the camera forever, and put it back when it falls off the bus.

    The recovery is the point of this function. A USB thermal camera on a Pi in
    a bar will drop at least once over months: GroupGets' own support threads
    carry "once it got upset it would never work again until the script was
    restarted", and the Pi kernel has an open issue where DQBUF never returns
    after a UVC disconnect. This loop used to catch the exception, log one line
    every five minutes, and retry the same dead file descriptor until somebody
    drove to the venue. Nothing downstream would have noticed either: the push
    keeps succeeding, so last_seen_at stays current and the fleet-status
    endpoint still says online, while the venue card shows an empty room for
    however many weeks it takes for a person to look.
    """
    failures = 0
    scene = SceneBackground()
    backoff = 0.0
    while not _stop.is_set():
        if _thermal_camera is None:
            # Either the camera was absent at boot, which used to mean this
            # thread never started at all and a late-enumerating camera was
            # written off for the life of the process, or a reopen is due.
            if init_thermal():
                logger.info('Thermal camera opened')
                failures, backoff = 0, 0.0
            else:
                backoff = min(_THERMAL_REOPEN_BACKOFF_MAX, max(5.0, backoff * 2))
                _stop.wait(backoff)
                continue
        try:
            frame = _thermal_camera.read_frame()
            if frame is None:
                failures += 1
                log_throttled('thermal_timeout', logging.WARNING,
                              'Thermal camera delivered no frame within '
                              f'{_FRAME_WAIT_SECONDS}s')
            elif not is_plausible_frame(frame):
                # Asked BEFORE flatness, and the order is the whole point. An
                # all-zero frame is 19,200 copies of -273.15C, which is flat, so
                # the old ordering filed a camera streaming nothing but zeros as
                # an FFC event: no log line, no freshness update, and the stale
                # warning never fired either because the count was already 0. A
                # camera in that state produced literally no output at all.
                failures += 1
                log_throttled('thermal_not_radiometric', logging.ERROR,
                              'Thermal frames are not room temperatures (median '
                              f'{_median(frame):.1f}C). The camera is probably not in '
                              'radiometric TLinear mode, or its TLinear resolution is '
                              '0.1 rather than 0.01. No headcount can be read from it. '
                              'Reporting 0. See README.md, Troubleshooting.')
            elif is_shutter_frame(frame):
                # Flat field correction, and these numbers ARE temperatures, so
                # this really is the shutter. Not a reading and not a failure
                # either, so the freshness clock is left alone and the failure
                # count is not advanced: an FFC lasts well under a second and
                # this loop comes back around in two.
                pass
            else:
                failures = 0
                backoff = 0.0
                n = count_people(frame, scene)
                if n is None:
                    # Still learning the room. Not a reading and not a
                    # failure, so the freshness clock is left alone.
                    log_throttled('thermal_seeding', logging.INFO,
                                  'Learning the scene background; no headcount '
                                  f'until about {_BG_SEED_FRAMES * 2}s after start')
                    _stop.wait(2)
                    continue
                _thermal_window.append(n)
                n = _median(list(_thermal_window))
                with _lock:
                    _state['thermal'] = max(0, min(MAX_THERMAL, int(n)))
                    _state['thermal_at'] = time.monotonic()
                    # Inside the lock with the count it belongs to, so the
                    # display cannot pair one frame with another frame's
                    # timestamp. Only ever set on a unit with a screen.
                    if THERMAL_VIEW_ON:
                        _state['thermal_frame'] = frame
                        _state['thermal_frame_at'] = time.monotonic()
        except Exception as e:
            failures += 1
            log_throttled('thermal_read', logging.WARNING, f'Thermal read error: {e}')
        if failures >= _THERMAL_REOPEN_AFTER:
            logger.warning('Thermal camera has produced nothing usable for '
                           f'{failures} reads; closing it and opening it again')
            try:
                _thermal_camera.close()
            except Exception:
                pass
            _set_thermal_camera(None)
            # A camera that went away and came back may be pointing at a
            # different scene, or the same one hours later. Relearn it.
            scene = SceneBackground()
            _thermal_window.clear()
            failures = 0
        _stop.wait(2)


# ---------------------------------------------------------------------------
# Noise: MAX4466 mic via MCP3008 ADC channel 0 over SPI
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


# The MCP3008 channel the microphone is wired to, and a channel nothing is wired
# to. Reading both is how the health check below tells "the converter is running"
# apart from "the converter is echoing one broken wire eight times".
NOISE_CHANNEL = 0
ADC_SPARE_CHANNEL = 7
ADC_HEALTH_SAMPLES = 40

# A MAX4466 on 3.3V idles at half its supply, which lands near the middle of the
# converter's range. A resting figure far outside this band is not a quiet room,
# it is a microphone that is not reaching the chip.
ADC_MID = 512
ADC_RESTING_MIN = 120
ADC_RESTING_MAX = 900

# Where a silent room should land on the level scale. Inside Quiet, not on its
# edge, so an empty venue does not flicker between two words all night.
QUIET_TARGET_LEVEL = 40.0
# Quiet starts at 50 and Loud starts at 85, so the four words the venue card
# shows need this much range to all be reachable.
WORD_SCALE_SPAN_DB = 35.0


def recommend_noise_ref(floor_rms, offset=None, target=None):
    """Reference count that puts a room this quiet at `target` on the level scale.

    The level is 20*log10(rms/ref)+offset, so the reference is the rms that
    reads exactly `offset`. Shipping it at 1.0 means silence is measured against
    one count and a quiet room reports in the seventies, which the card calls
    Lively. Setting it to the measured floor is the obvious correction and is
    also wrong: that lands silence on the Quiet/Moderate boundary and an empty
    venue flickers between two words. This aims inside Quiet instead.

    Pure, so the arithmetic that decides what a venue is called is tested.
    """
    offset = NOISE_DB_OFFSET if offset is None else offset
    target = QUIET_TARGET_LEVEL if target is None else target
    if floor_rms <= 0:
        return None
    return round(floor_rms * (10 ** ((offset - target) / 20.0)), 1)


def _read_mcp3008(channel=NOISE_CHANNEL):
    """One 10-bit conversion, 0 to 1023, from any of the eight channels."""
    resp = _spi.xfer2([1, (8 + (int(channel) & 7)) << 4, 0])
    return ((resp[1] & 3) << 8) + resp[2]


def _read_mcp3008_ch0():
    return _read_mcp3008(NOISE_CHANNEL)


def sample_adc(channel=NOISE_CHANNEL, count=ADC_HEALTH_SAMPLES, gap=0.002):
    """A short burst from one channel. Empty list when the bus is not open."""
    if _spi is None:
        return []
    out = []
    for _ in range(count):
        out.append(_read_mcp3008(channel))
        time.sleep(gap)
    return out


def adc_health(mic_samples, spare_samples=None):
    """Is the converter running, or reporting a broken wire confidently?

    Returns (ok, reason). Pure, so every failure below is tested without a chip.

    Each case here was seen on a bench, and each reason names the wire to check,
    because from the outside these are indistinguishable: one unit spent an
    evening printing "noise mic : ok" while the converter returned 1023 on all
    eight channels, because the only thing that check did was open the SPI bus.
    Opening a bus proves a bus. It says nothing about the part on the end of it.
    """
    if not mic_samples:
        return False, 'no samples were read from the ADC'

    lo, hi = min(mic_samples), max(mic_samples)
    if lo == hi:
        if lo >= 1020:
            return False, (
                f'every sample reads {lo}, the top of the scale. The converter divides by '
                f'VREF, so a VREF sitting at zero pins every channel to full scale. Check '
                f'that VREF and VDD both reach 3.3V. They are the two pins at the notch '
                f'end of the chip.')
        if lo <= 3:
            return False, (
                f'every sample reads {lo}. The converter is not running. Check that AGND '
                f'and DGND both reach ground, and that CS reaches CE0.')
        return False, (
            f'every sample reads {lo}, with no variation at all. A live microphone jitters '
            f'by a count or two even in a silent room, so nothing is being converted.')

    if (spare_samples and len(spare_samples) == len(mic_samples)
            and list(spare_samples) == list(mic_samples)):
        return False, (
            'the microphone channel and an unconnected channel return byte-identical '
            'readings, so the chip is not selecting channels. Check that CS reaches CE0 '
            'and CLK reaches SCK.')

    mean = sum(mic_samples) / float(len(mic_samples))
    if not (ADC_RESTING_MIN <= mean <= ADC_RESTING_MAX):
        return False, (
            f'the microphone idles at {mean:.0f}, and a MAX4466 on 3.3V rests near '
            f'{ADC_MID}. Its OUT is probably not reaching the chip, or it has no power. '
            f'Check that OUT lands in the same row as the chip pin 1 corner, on the '
            f'opposite side of the board from the power pins, and that VCC is on 3.3V '
            f'rather than 5V.')

    return True, f'idles at {mean:.0f}, spread {hi - lo} counts'


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
                # A converter that has stopped converting returns the same count
                # every time, and compute_noise_db turns that into a perfectly
                # plausible loudness. Withholding the reading lets _fresh report
                # it honestly instead, the same way a camera that stops
                # answering is reported.
                if min(samples) == max(samples):
                    log_throttled('noise_frozen', logging.ERROR,
                                  f'ADC returned {min(samples) + 512} on every sample; '
                                  'the converter is not running, so the noise level is '
                                  'being withheld. Run main.py --selftest.')
                else:
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
        # An INSTALLED device is already covered: the unit declares
        # StateDirectory=flock-sensor, so systemd creates /var/lib/flock-sensor
        # with the right owner before this process starts. This line is for
        # every other way the file gets run, where nothing has made the
        # directory: a developer laptop, a manual invocation, a device started
        # outside systemd. Without it the write fails with ENOENT and lands in
        # the generic handler below, which keeps the queue in memory and writes
        # one throttled log line, so the buffer looks like it is working right
        # up until the process restarts. The log path has always done this.
        try:
            BUFFER_PATH.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Read-only or full disk. The handlers below already treat that as
            # "keep the queue in memory", so let the write fail and say so there
            # rather than growing a second copy of that decision here.
            pass
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
        return False, ('FLOCK_API_URL is plaintext http. The API key would travel in the '
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
    snapshot, because the backend sums ir_beam_count across payloads.

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
    """Fill in recorded_at for a reading taken before the clock was set.

    Returns the payload to SEND, which is not always the queued dict: while the
    clock is still untrusted, the monotonic mark stays on the queued entry and
    a sanitised copy goes out, so a delivery that fails now does not cost the
    reading its real time later. The first version popped the mark before
    knowing whether it could use it, so one failed pre-NTP delivery attempt per
    boot was enough to file that reading on arrival time forever.
    """
    if 'recorded_at' in item:
        item.pop('_mono', None)
        return item
    mono = item.get('_mono')
    if mono is None:
        return item
    if clock_is_sane():
        item.pop('_mono', None)
        item['recorded_at'] = iso_utc(time.time() - (time.monotonic() - mono))
        return item
    # Still no valid clock: send it undated and let the backend stamp arrival,
    # keeping the mark so a later attempt can still reconstruct the real time.
    send = dict(item)
    send.pop('_mono', None)
    return send


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
                # A clock running FAST is the one payload problem this device
                # can repair by itself, and dropping the reading would drop
                # every reading forever: clock_is_sane() only checks the past,
                # so a fast clock passes it and stamps every snapshot ahead,
                # and the server 400s each one. The server names the condition
                # in its own words ("recorded_at is in the future"), which is
                # the only clock reference this device has, so on those words:
                # strip the stamp and resend undated. The backend files the
                # reading on arrival, which for a live reading is within
                # seconds of the truth. Once stripped it cannot 400 for this
                # reason again, so this cannot loop.
                if 'recorded_at' in _pending[0] and 'recorded_at' in (body or '') and 'future' in (body or ''):
                    log_throttled('clock_ahead', logging.ERROR,
                                  'Backend says this clock is running fast; sending undated '
                                  'until it is fixed (readings are filed on arrival time)',
                                  every_seconds=300)
                    _pending[0].pop('recorded_at', None)
                    _pending[0].pop('_mono', None)
                    handled += 1
                    continue
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
        # A 429 asks for a couple of seconds, and until this loop existed the
        # answer was thirty: flush scheduled the short retry it was asked for
        # and nothing ran it until the next push interval, so the throttled
        # tail of a drain crawled out at one flush per cycle and the "about a
        # minute of extra drain" both sides document took fifteen to twenty.
        # Honour the short wait here, inside the cycle. Bounded twice over:
        # it runs only while the ONLY thing in the way is rate limiting (any
        # failure or auth error ends it, and _succeed zeroing the counter ends
        # it on a full drain), and never past one push interval of extra
        # waiting, so a misbehaving backend cannot pin this thread. _stop cuts
        # it instantly on shutdown.
        deadline = time.monotonic() + PUSH_INTERVAL
        while (_pending and not _stop.is_set()
               and self.rate_limits and not self.failures and not self.auth_failures
               and self.next_attempt and time.monotonic() < deadline):
            wait = self.next_attempt - time.monotonic()
            if wait > 0 and _stop.wait(min(wait, PUSH_INTERVAL)):
                break
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
#
# The panel is the 7 inch 720x1280 DSI screen the build plan specifies, mounted
# in PORTRAIT. That is the long axis vertical, so the three readings stack down
# the screen instead of sitting in three columns as they did on the 800x480
# landscape panel this used to assume.
#
# Portrait is a Raspberry Pi OS display setting, not something this program can
# impose: it asks the framebuffer for 720x1280 and draws into whatever it gets.
# If the panel comes up landscape, rotate it in the OS. UNVERIFIED: no panel
# has been attached to this code.
# ---------------------------------------------------------------------------

DISPLAY_W, DISPLAY_H = 720, 1280


# ---------------------------------------------------------------------------
# The thermal view (demo units only)
#
# Tap the panel and it shows what the camera is looking at. This exists for the
# pitch demo: a hand passed in front of the unit glows, which is the one moment
# that makes an invisible sensor legible to somebody watching.
#
# It is the only place in this program that turns a frame into a picture, and it
# is gated on THERMAL_VIEW_ON, which requires a physical screen. A venue sensor
# has no screen, retains no frame, and so keeps the published promise exactly.
# Both functions below are pure and take their input, so the whole conversion is
# tested without a camera or a framebuffer.
_THERMAL_RAMP = (
    (8, 12, 28),      # cold: near black, faintly blue
    (26, 40, 110),
    (70, 40, 150),
    (150, 44, 128),
    (216, 66, 74),    # warm: red
    (247, 140, 30),   # hot: orange
    (255, 214, 92),   # hotter: yellow
    (255, 255, 240),  # hottest: near white
)


def _thermal_palette():
    """256 RGB steps, interpolated through the ramp above. Built once."""
    out = []
    spans = len(_THERMAL_RAMP) - 1
    for i in range(256):
        pos = (i / 255.0) * spans
        lo = min(int(pos), spans - 1)
        f = pos - lo
        a, b = _THERMAL_RAMP[lo], _THERMAL_RAMP[lo + 1]
        out.append(bytes((int(a[0] + (b[0] - a[0]) * f),
                          int(a[1] + (b[1] - a[1]) * f),
                          int(a[2] + (b[2] - a[2]) * f))))
    return tuple(out)


THERMAL_PALETTE = _thermal_palette()


def thermal_frame_span(frame):
    """The (low, high) temperatures to stretch the palette across.

    Auto-ranged per frame off the 2nd and 98th percentile rather than min and
    max, so one stuck pixel cannot wash the whole picture out, and so a hand
    entering the frame visibly takes over the top of the scale. The floor on the
    span stops an empty room of nearly uniform temperature from being amplified
    into dramatic-looking noise, which would be a lie told to a judge.
    """
    if not frame:
        return 0.0, 1.0
    ordered = sorted(frame)
    n = len(ordered)
    lo = ordered[int(n * 0.02)]
    hi = ordered[min(n - 1, int(n * 0.98))]
    if hi - lo < 4.0:
        mid = (hi + lo) / 2.0
        lo, hi = mid - 2.0, mid + 2.0
    return lo, hi


def thermal_frame_rgb(frame, lo, hi):
    """The frame as raw RGB bytes, ready for pygame.image.frombuffer."""
    span = (hi - lo) or 1.0
    palette = THERMAL_PALETTE
    out = bytearray()
    for t in frame:
        i = int((t - lo) / span * 255.0)
        out += palette[0 if i < 0 else 255 if i > 255 else i]
    return bytes(out)

def draw_thermal_view(pygame, screen, fonts, frame, count, live):
    """Fill the panel with what the camera is looking at.

    Takes pygame as an argument rather than importing it, because this program
    has to run headless on a venue unit where pygame is not installed at all,
    and an import at module scope would make the whole file unloadable there.
    """
    font_med, font_sm, font_xs = fonts
    CREAM = (241, 237, 224)
    MUTED = (160, 170, 180)
    FAINT = (110, 120, 130)
    screen.fill((10, 14, 24))
    screen.blit(font_sm.render('WHAT THE SENSOR SEES', True, CREAM), (36, 24))

    if not frame:
        screen.blit(font_med.render('no frame yet', True, MUTED), (36, 300))
        screen.blit(font_xs.render('tap to go back', True, FAINT), (36, DISPLAY_H - 60))
        return

    lo, hi = thermal_frame_span(frame)
    surf = pygame.image.frombuffer(thermal_frame_rgb(frame, lo, hi),
                                   (THERMAL_COLS, THERMAL_ROWS), 'RGB')
    img_w = DISPLAY_W - 72
    img_h = int(img_w * THERMAL_ROWS / float(THERMAL_COLS))
    # smoothscale interpolates, which is what turns 160x120 into something that
    # reads as thermal imagery rather than a grid of squares. It refuses some
    # surface depths, so fall back rather than crash in front of a judge.
    try:
        surf = pygame.transform.smoothscale(surf, (img_w, img_h))
    except Exception:
        surf = pygame.transform.scale(surf, (img_w, img_h))
    top = 110
    screen.blit(surf, (36, top))
    pygame.draw.rect(screen, (54, 66, 84), (36, top, img_w, img_h), 2)

    y = top + img_h + 40
    screen.blit(font_sm.render('In view now', True, MUTED), (36, y))
    screen.blit(font_med.render(f'~{count}' if live else '--', True, CREAM), (36, y + 44))
    screen.blit(font_sm.render('Warmest point', True, MUTED), (360, y))
    screen.blit(font_med.render(f'{max(frame):.1f}C', True, CREAM), (360, y + 44))
    # Say what the picture is, on the picture. A thermal image of a room reads as
    # a camera to most people, and this is the one screen in the product where
    # that misreading is easy to make and worth heading off out loud.
    screen.blit(font_xs.render('Temperatures only. Nothing here is recorded or sent.',
                               True, FAINT), (36, y + 150))
    screen.blit(font_xs.render('tap to go back', True, FAINT), (36, DISPLAY_H - 60))

def display_loop():
    try:
        os.environ.setdefault('SDL_VIDEODRIVER', 'fbcon' if os.path.exists('/dev/fb0') else 'dummy')
        import pygame
        pygame.init()
        screen = pygame.display.set_mode(
            (DISPLAY_W, DISPLAY_H),
            pygame.FULLSCREEN if os.path.exists('/dev/fb0') else 0)
        pygame.mouse.set_visible(False)
        # Sized for a 7 inch panel read from across a room, not for a desktop.
        font_big = pygame.font.Font(None, 150)
        font_med = pygame.font.Font(None, 84)
        font_sm = pygame.font.Font(None, 40)
        font_xs = pygame.font.Font(None, 32)

        NAVY = (30, 41, 59)
        CREAM = (241, 237, 224)
        GREEN = (16, 185, 129)
        AMBER = (245, 158, 11)
        ORANGE = (249, 115, 22)
        RED = (239, 68, 68)
        MUTED = (160, 170, 180)
        FAINT = (110, 120, 130)
        RULE = (54, 66, 84)

        PAD = 36
        HEADER_H = 84
        # Three stacked panels, then the chart takes the rest.
        BLOCK_H = 268
        BLOCK_TOP = HEADER_H + 24

        # Which screen the panel is showing. Demo units only, always: a venue
        # box has no screen, so this loop never runs there.
        view = 'stats'
        while not _stop.is_set():
            with _lock:
                ir = int(_state['ir_count'])
                therm = int(_state['thermal'])
                therm_at = _state['thermal_at']
                db = float(_state['noise_db'])
                noise_at = _state['noise_at']
                frame = _state['thermal_frame'] if THERMAL_VIEW_ON else None
                history = list(_state['last_push_history'])

            # Match what is actually being sent. A frozen number on the screen
            # while the backend is being sent 0 is the worst of both, and on the
            # demo unit it is a number a judge is looking at.
            now_mono = time.monotonic()
            therm_live = therm_at is not None and now_mono - therm_at <= THERMAL_STALE_AFTER
            noise_live = noise_at is not None and now_mono - noise_at <= NOISE_STALE_AFTER

            screen.fill(NAVY)
            top = pygame.Surface((DISPLAY_W, HEADER_H))
            top.fill((20, 28, 40))
            screen.blit(top, (0, 0))
            screen.blit(font_sm.render('FLOCK VENUE SENSOR', True, CREAM), (PAD, 24))

            def rule(y):
                pygame.draw.line(screen, RULE, (PAD, y), (DISPLAY_W - PAD, y), 1)

            # Panel 1. Beam breaks since the last snapshot: crossings in either
            # direction, over at most one push interval. This was once labelled
            # "Entered Today", which the number has never been.
            y = BLOCK_TOP
            screen.blit(font_sm.render('Doorway crossings', True, MUTED), (PAD, y))
            screen.blit(font_big.render(str(ir), True, CREAM), (PAD, y + 52))
            screen.blit(font_xs.render('since last update', True, FAINT), (PAD, y + 200))
            rule(y + BLOCK_H - 24)

            # Panel 2.
            y = BLOCK_TOP + BLOCK_H
            screen.blit(font_sm.render('In view now', True, MUTED), (PAD, y))
            screen.blit(font_big.render(f'~{therm}' if therm_live else '--', True, CREAM),
                        (PAD, y + 52))
            if therm_live:
                screen.blit(font_xs.render('warm bodies, counted on the device', True, FAINT),
                            (PAD, y + 200))
            else:
                screen.blit(font_xs.render('thermal offline', True, RED), (PAD, y + 200))
            rule(y + BLOCK_H - 24)

            # Panel 3.
            y = BLOCK_TOP + BLOCK_H * 2
            screen.blit(font_sm.render('Noise', True, MUTED), (PAD, y))
            if noise_live:
                label = 'Quiet' if db < 50 else 'Moderate' if db < 70 else 'Lively' if db < 85 else 'Loud'
                color = GREEN if db < 50 else AMBER if db < 70 else ORANGE if db < 85 else RED
                # "level", never "dB": nobody has calibrated this against a sound
                # level meter, so it is a relative loudness index. See README.
                screen.blit(font_med.render(label, True, color), (PAD, y + 60))
                screen.blit(font_xs.render(f'level {int(db)}', True, FAINT), (PAD, y + 160))
            else:
                screen.blit(font_med.render('--', True, CREAM), (PAD, y + 60))
                screen.blit(font_xs.render('mic offline', True, RED), (PAD, y + 160))
            rule(y + BLOCK_H - 24)

            # Chart of recent pushed headcounts, along the bottom.
            if history:
                chart_bottom = DISPLAY_H - PAD - 40
                chart_h = 200
                screen.blit(font_xs.render('Last few readings', True, FAINT),
                            (PAD, chart_bottom + 12))
                usable = DISPLAY_W - PAD * 2
                slot = usable // max(len(history), 1)
                bar_w = max(8, slot - 8)
                max_h = max(history) or 1
                for i, v in enumerate(history):
                    h = int((v / max_h) * chart_h) if max_h else 0
                    pygame.draw.rect(screen, CREAM,
                                     (PAD + i * slot, chart_bottom - h, bar_w, h))

            if view == 'thermal':
                # Drawn over the stats rather than instead of them. The stats pass
                # is blits into an off-screen surface with no side effects and
                # costs about a millisecond at this size, and overdrawing keeps
                # this change from re-indenting sixty lines of working layout.
                draw_thermal_view(pygame, screen, (font_med, font_sm, font_xs),
                                  frame, therm, therm_live)
            pygame.display.flip()
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return
                # A DSI touch panel reports through the mouse events under SDL's
                # framebuffer driver on Raspberry Pi OS. FINGERDOWN is accepted too,
                # because which one arrives depends on the driver, and a pitch is a
                # bad place to discover you picked the wrong one.
                if THERMAL_VIEW_ON and event.type in (pygame.MOUSEBUTTONDOWN,
                                                      getattr(pygame, 'FINGERDOWN', -1)):
                    view = 'thermal' if view == 'stats' else 'stats'
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

# The smallest minimum this program will ever recommend, whatever a
# calibration window happens to measure. The 24x32 sensor's default of 4
# counted noise as a crowd on a 160x120 grid, test_main.py pins the minimum
# above 4, and a quiet twenty seconds is not evidence that a room is quiet at
# midnight on a Friday. Below this the honest answer is that the camera is
# mounted too far from where people cross.
NOISE_FLOOR_MIN_CLUSTER = 5
CALIBRATE_SECONDS = 20


def recommend_min_cluster(noise_regions, person_frame_maxes, current=None):
    """Pick a THERMAL_MIN_CLUSTER from measured noise and a measured person.

    Returns (recommended, note). `recommended` is None when no threshold can
    separate the two, which is a real answer and the more useful one: it means
    the camera is too far from where people actually cross, and that is a
    mounting decision rather than a number to tune.

    Pure, so it is tested without a camera. See README.md, Calibration.
    """
    current = THERMAL_MIN_CLUSTER if current is None else current
    noise_max = max(noise_regions) if noise_regions else 0
    if not person_frame_maxes:
        return None, 'no frames were captured with a person in view'
    # The person's WEAKEST frame over the window, not their average. A
    # threshold that only clears on their best frame drops them on the rest.
    person_min = min(person_frame_maxes)

    if person_min <= noise_max:
        return None, (
            f'a person reads {person_min} cells at worst from there and the empty room '
            f'reaches {noise_max}. Nothing separates those, so no setting fixes it. Move the '
            f'camera closer to where people cross, or angle it so a whole body fills more of '
            f'the frame.')
    if person_min <= NOISE_FLOOR_MIN_CLUSTER:
        return None, (
            f'a person reads {person_min} cells at worst from there, which is inside the '
            f'range where this sensor\'s own noise lives. The room measured quiet during '
            f'this window, and twenty seconds of quiet is not something to publish occupancy '
            f'on. Mount the camera closer.')

    # Geometric mean: these are areas, so the point halfway between them in
    # cells is not the point halfway between them in distance. This one is.
    rec = int(round(math.sqrt(max(noise_max, 1) * person_min)))
    rec = max(NOISE_FLOOR_MIN_CLUSTER, min(rec, person_min - 1))
    reach = math.sqrt(current / float(rec))
    return rec, (
        f'noise reaches {noise_max} cells, a person there never drops below {person_min}, '
        f'and {rec} sits between them. Against the current {current} that is about '
        f'{reach:.2f}x the range, because a silhouette shrinks with the square of distance.')


def recommend_margin_c(empty_above_median, person_above_median, room_median,
                       threshold_c=None):
    """Pick THERMAL_MARGIN_C, and say whether it will ever be the deciding arm.

    The cutoff is max(THERMAL_THRESHOLD_C, median + margin), so the fixed arm
    wins in every room cooler than threshold minus margin, which at the shipped
    28.0 and 3.0 is every room below 25C. That is most rooms, and it means the
    number a venue sees is decided by an absolute temperature read by a part
    whose own datasheet allows +/-7C of error at room-temperature scenes,
    uncalibrated, per unit, with a step across every flat field correction. A
    median-relative cutoff is immune to a constant offset of that kind. A fixed
    one is not. This function is how the margin stops being a guess.

    Pure, so it is tested without a camera.
    """
    threshold_c = THERMAL_THRESHOLD_C if threshold_c is None else threshold_c
    if not person_above_median:
        return None, 'no frames were captured with a person in view'
    noise_ceiling = max(empty_above_median) if empty_above_median else 0.0
    # A person's WEAKEST frame again, for the same reason as the cluster size.
    person_floor = min(person_above_median)
    if person_floor <= noise_ceiling:
        return None, (
            f'the warmest thing in the empty room sat {noise_ceiling:.1f}C above the '
            f'room median and a person only reached {person_floor:.1f}C above it. No '
            f'margin separates them. Something warm is in frame, or the camera is too '
            f'far from the crossing.')
    rec = round(max(1.0, (noise_ceiling + person_floor) / 2.0), 1)
    cutoff = room_median + rec
    if cutoff < threshold_c:
        return rec, (
            f'empty room reaches {noise_ceiling:.1f}C above median, a person reaches at '
            f'least {person_floor:.1f}C above it, so {rec:.1f}C sits between them. '
            f'WARNING: at this room median ({room_median:.1f}C) that puts the cutoff at '
            f'{cutoff:.1f}C, and THERMAL_THRESHOLD_C={threshold_c:.1f} overrides it. The '
            f'margin you just measured will never be the deciding arm here. Lower '
            f'THERMAL_THRESHOLD_C below {cutoff:.1f} or the measurement is decorative.')
    return rec, (
        f'empty room reaches {noise_ceiling:.1f}C above median, a person reaches at '
        f'least {person_floor:.1f}C above it, so {rec:.1f}C sits between them. At this '
        f'room median the cutoff is {cutoff:.1f}C, above THERMAL_THRESHOLD_C, so the '
        f'margin is the arm actually deciding.')

def _watch_regions(seconds, label):
    """Sample the camera. Returns (frames, regions, per_frame_max, above_median).

    `above_median` is the per-frame `max(frame) - median(frame)` in degrees,
    which is the quantity THERMAL_MARGIN_C is compared against. Collected here
    because the frame is already in hand and sorting it twice is cheaper than
    a second twenty-second window.
    """
    regions, frame_maxes, aboves, frames = [], [], [], 0
    medians = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        frame = _thermal_camera.read_frame()
        if frame is None:
            time.sleep(0.2)
            continue
        if not is_plausible_frame(frame):
            print('\n    NOT RADIOMETRIC. These numbers are not temperatures, so nothing '
                  'measured here would mean anything. See README.md, Troubleshooting.')
            return 0, [], [], [], 0.0
        sizes = thermal_region_sizes(frame)
        med = _median(frame)
        medians.append(med)
        aboves.append(max(frame) - med)
        regions.extend(sizes)
        frame_maxes.append(max(sizes) if sizes else 0)
        frames += 1
        print('.', end='', flush=True)
        time.sleep(0.4)
    print(f'  {frames} frames')
    if frames == 0:
        print(f'    the camera delivered no frames during the {label} window')
    return frames, regions, frame_maxes, aboves, (_median(medians) if medians else 0.0)


def calibrate(seconds=CALIBRATE_SECONDS):
    """Measure what a person is worth in cells AT THIS mounting position.

    THERMAL_MIN_CLUSTER's shipped default is one number from one bench in one
    room. What it should be depends on how far the camera is from the doorway
    and how warm the room runs, so this measures both ends of that with a human
    confirming which is which, and prints the setting.

    It deliberately does NOT adjust anything while the service runs. A
    threshold that moved on its own would have to decide "that faint thing is a
    distant person" or "that faint thing is noise" from identical evidence, and
    the version that lowers itself when it sees nothing converges on inventing
    people in an empty room. Occupancy that drifts for reasons nobody can
    reconstruct is also poison for the crowd model, which takes these readings
    as ground truth. So the adjustment happens once, at install, where somebody
    can see the room it is being fitted to.
    """
    print(f'flock-sensor {VERSION} thermal calibration')
    print(f'  bin {THERMAL_BIN}, threshold {THERMAL_THRESHOLD_C}C, '
          f'margin {THERMAL_MARGIN_C}C, current minimum {THERMAL_MIN_CLUSTER} cells')
    print('  Mount the camera where it is going to live before running this.')
    print('  Calibrating on a desk measures the desk.')
    if not init_thermal():
        print(f'\n  thermal camera NOT DETECTED at {THERMAL_DEVICE}.')
        print('  If the service is running it is holding the camera: '
              'sudo systemctl stop flock-sensor')
        return 1
    try:
        print('\n1. EMPTY the frame. Nobody in view, including you.')
        input('   Press Enter when the room is clear...')
        print('   watching', end='', flush=True)
        frames, noise, _, noise_above, _ = _watch_regions(seconds, 'empty room')
        if frames == 0:
            return 1
        print(f'   empty room: largest warm region {max(noise) if noise else 0} cells, '
              f'warmest point {max(noise_above):.1f}C above the room median')

        print('\n2. Stand at the FARTHEST point a person actually crosses.')
        print('   Not the middle of the room. The far edge of the doorway, where')
        print('   the count still has to work. Face the camera and stay still.')
        input('   Press Enter once you are there...')
        print('   watching', end='', flush=True)
        frames, _, person, person_above, room_median = _watch_regions(seconds, 'person')
        if frames == 0:
            return 1
        print(f'   person: {min(person)} cells at worst, {max(person)} at best, '
              f'{min(person_above):.1f}C above the median at worst')

        print('')
        size_rec, size_note = recommend_min_cluster(noise, person)
        if size_rec is None:
            print(f'NO SIZE THRESHOLD WORKS HERE: {size_note}')
        else:
            print(f'THERMAL_MIN_CLUSTER: {size_note}')

        margin_rec, margin_note = recommend_margin_c(noise_above, person_above, room_median)
        print('')
        if margin_rec is None:
            print(f'NO MARGIN WORKS HERE: {margin_note}')
        else:
            print(f'THERMAL_MARGIN_C: {margin_note}')

        if size_rec is None and margin_rec is None:
            return 1
        print(f'\n  Put these in {CONFIG_PATH} and restart the service:')
        if size_rec is not None:
            print(f'      THERMAL_MIN_CLUSTER={size_rec}')
        if margin_rec is not None:
            print(f'      THERMAL_MARGIN_C={margin_rec}')
        print('\n  Then walk the doorway again and watch the count. Two people at')
        print('  once is the check this cannot run for you.')
        return 0
    except (KeyboardInterrupt, EOFError):
        print('\n  cancelled, nothing was changed')
        return 1
    finally:
        _thermal_camera.close()
def listen(seconds=None):
    """Live level meter. What the microphone is hearing, right now.

    Built because a column of numbers does not tell a person whether the
    microphone works, and clapping at a device while watching a bar move does.
    It is also the only way to set the gain screw on the MAX4466 by eye: too
    high and the bar pins and the clip counter runs, too low and a conversation
    barely moves it.

    The figure is a RELATIVE level, not dB SPL. Nothing here has been held next
    to a sound level meter, so the number is honest about loud against quiet and
    means nothing in absolute terms. See README.md, Calibration.
    """
    if not init_noise():
        print('MCP3008 not detected. Check SPI is enabled and the wiring.')
        return 1

    mic = sample_adc(NOISE_CHANNEL)
    healthy, why = adc_health(mic, sample_adc(ADC_SPARE_CHANNEL))
    if not healthy:
        print('The converter is not returning anything usable:')
        for line in textwrap.wrap(why, 70):
            print(f'  {line}')
        return 1

    print(f'flock-sensor {VERSION} microphone level')
    print(f'  channel {NOISE_CHANNEL}, {why}')
    print('  relative level, NOT dB SPL. Ctrl+C to stop.')
    print('')
    deadline = None if seconds is None else time.monotonic() + seconds
    peak = 0.0
    floor = None
    try:
        while deadline is None or time.monotonic() < deadline:
            raw = []
            t_end = time.monotonic() + 0.12
            while time.monotonic() < t_end:
                raw.append(_read_mcp3008(NOISE_CHANNEL))
                time.sleep(0.001)
            if not raw:
                continue
            centred = [r - ADC_MID for r in raw]
            rms = math.sqrt(sum(c * c for c in centred) / len(centred))
            level = compute_noise_db(centred)
            peak = max(peak, rms)
            floor = rms if floor is None else min(floor, rms)
            # The same four words the venue card shows, from the same
            # thresholds, so what a person sees here is what a venue sees.
            word = ('Quiet' if level < 50 else 'Moderate' if level < 70
                    else 'Lively' if level < 85 else 'Loud')
            # Clipping is worth its own counter: it is the one fault the bar
            # cannot show, because a pinned reading looks like a loud room.
            clips = sum(1 for r in raw if r <= 1 or r >= 1022)
            filled = max(0, min(32, int(level / 100.0 * 32)))
            bar = '#' * filled + '.' * (32 - filled)
            flag = f'  CLIPPING x{clips}' if clips else ''
            print(f'  rms {rms:6.1f}   level {level:5.1f}  {word:<8} '
                  f'[{bar}]  peak {peak:6.1f}{flag}')
    except KeyboardInterrupt:
        print('')
    print(f'  loudest burst seen: rms {peak:.1f}')
    if floor is not None:
        print(f'  quietest burst seen: rms {floor:.1f}')
        span = 20 * math.log10(max(peak, 1e-6) / max(floor, 1e-6))
        print(f'  usable range: {span:.1f} dB between the two')

        # Pick a reference that puts a room this quiet at QUIET_TARGET_LEVEL,
        # which sits inside Quiet rather than on its boundary. Setting the
        # reference equal to the floor, which is the obvious thing to do, lands
        # silence at exactly the Quiet/Moderate threshold and makes the card
        # flicker between two words in an empty room.
        #
        # The shipped reference of 1.0 is the reason a silent room reads Lively:
        # the level is 20*log10(rms/ref)+offset, and measured against one count
        # every real reading is enormous.
        suggested = recommend_noise_ref(floor)
        now = compute_noise_db([floor])
        now_word = ('Quiet' if now < 50 else 'Moderate' if now < 70
                    else 'Lively' if now < 85 else 'Loud')
        print('')
        print(f'  At the current NOISE_REF_COUNTS={NOISE_REF_COUNTS}, a room this quiet '
              f'reports {now:.0f},')
        print(f'  which the app calls {now_word}.')
        if abs(suggested - NOISE_REF_COUNTS) > 0.5:
            print('')
            print(f'  RECOMMENDED: NOISE_REF_COUNTS={suggested}')
            print(f'  That puts a room this quiet at {QUIET_TARGET_LEVEL:.0f}, inside Quiet.')

        # The four words span 35 dB. A microphone whose whole range is narrower
        # than that can never reach the top word no matter how it is referenced,
        # and the fix is the gain screw, not the config file.
        if span < WORD_SCALE_SPAN_DB:
            print('')
            print(f'  NOTE: {span:.0f} dB of range, and Quiet through Loud needs '
                  f'{WORD_SCALE_SPAN_DB:.0f} dB.')
            print('  The top word is unreachable at this gain. Turn the screw on the')
            print('  MAX4466 anticlockwise until a clap stops showing CLIPPING, then')
            print('  run this again: the noise floor drops and the range widens.')
        print('')
        print('  Run this again in the quietest the venue ever gets before setting it.')
    if peak < 5:
        print('  Nothing ever moved. Talk directly at the microphone, and if it')
        print('  still does not move, turn the gain screw on the MAX4466 clockwise.')
    return 0


def selftest():
    """Check an installation end to end and say exactly what is wrong.

    Exits 0 only if the device can actually deliver a reading.
    """
    print(f'flock-sensor {VERSION} self test')
    if _pair_complaint:
        print(f'  CONFIG REFUSED   : {_pair_complaint}')
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
    print('    (if the service is running, it already holds the camera, SPI and')
    print('     GPIO devices and these may read as NOT DETECTED. Stop it first')
    print('     with `sudo systemctl stop flock-sensor` for a true check.)')
    print(f'    IR break-beam  : {"ok" if init_ir() else "NOT DETECTED (reports 0)"}')
    thermal_ok = init_thermal()
    print(f'    thermal camera : {"ok" if thermal_ok else "NOT DETECTED (reports 0)"}'
          f'  [{THERMAL_DEVICE}]')
    if thermal_ok:
        # Opening the node proves a camera is there. It does not prove the
        # numbers are temperatures, and a Lepton that is not in radiometric
        # TLinear mode streams happily and counts nonsense. Say which it is.
        frame = _thermal_camera.read_frame()
        if frame is None:
            print('                     opened, but delivered no frame')
        elif not is_plausible_frame(frame):
            print(f'                     NOT RADIOMETRIC: median reads '
                  f'{_median(frame):.1f}C, which is not a room. Headcount will '
                  f'be 0. See README.md, Troubleshooting.')
        else:
            print(f'                     radiometric, room median '
                  f'{_median(frame):.1f}C, {count_thermal_clusters(frame)} '
                  f'cluster(s) in view')
        _thermal_camera.close()
    # Opening the SPI bus proves a bus, not a converter. This line used to
    # print ok on the strength of that alone, and did so for an entire evening
    # on a unit whose ADC was returning 1023 on every channel.
    if not init_noise():
        print('    noise mic      : NOT DETECTED (reports 0)')
    else:
        mic = sample_adc(NOISE_CHANNEL)
        spare = sample_adc(ADC_SPARE_CHANNEL)
        healthy, why = adc_health(mic, spare)
        if healthy:
            print(f'    noise mic      : ok  ({why})')
        else:
            print('    noise mic      : READING NOTHING USEFUL')
            for line in textwrap.wrap(why, 62):
                print(f'                     {line}')

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
    if _pair_complaint:
        # Loud, because the alternative is a venue whose sensor is switched
        # off by its own config file and says nothing about it.
        logger.error(_pair_complaint)
    logger.info(f"Device ID: {CONFIG.get('SENSOR_DEVICE_ID') or '(not set)'}")
    logger.info(f'API URL: {api_url()}')
    logger.info(f'Push interval: {PUSH_INTERVAL}s')
    logger.info(f'Display: {"on" if DISPLAY_ON else "headless"}')
    # Never log the key itself, only whether one exists.
    if not CONFIG.get('FLOCK_API_KEY'):
        logger.error('FLOCK_API_KEY is empty. Every push will be refused. '
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

    # Started whatever init_thermal said. The loop opens the camera itself when
    # it does not have one, so a camera that is absent or slow to enumerate at
    # boot is picked up later rather than written off for the life of the
    # process. thermal_ok above now only decides what the log line says.
    threading.Thread(target=thermal_loop, daemon=True, name='thermal').start()
    if noise_ok:
        threading.Thread(target=noise_loop, daemon=True, name='noise').start()

    push_thread = threading.Thread(target=push_loop, daemon=True, name='push')
    push_thread.start()

    if DISPLAY_ON:
        # pygame wants the main thread. If it stops, fall through to the
        # keep-alive below rather than returning, because main() exits 0,
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
    parser.add_argument('--listen', action='store_true',
                        help='live microphone level meter; Ctrl+C to stop')
    parser.add_argument('--calibrate', action='store_true',
                        help='measure THERMAL_MIN_CLUSTER against this mounting position')
    parser.add_argument('--seconds', type=int, default=CALIBRATE_SECONDS,
                        help=f'seconds to watch per --calibrate stage (default {CALIBRATE_SECONDS})')
    parser.add_argument('--version', action='version', version=f'flock-sensor {VERSION}')
    args = parser.parse_args()
    if args.selftest:
        sys.exit(selftest())
    if args.listen:
        sys.exit(listen(args.seconds if args.seconds != CALIBRATE_SECONDS else None))
    if args.calibrate:
        sys.exit(calibrate(max(5, args.seconds)))
    main()
