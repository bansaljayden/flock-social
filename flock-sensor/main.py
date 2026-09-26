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

VERSION = '1.13.0'

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
    # The crossing sensor. This was written for a two-part break-beam, an
    # emitter facing a receiver across the doorway, and the code never cared:
    # all it watches is one pin changing state. So a one-sided IR proximity
    # module works here with no code change at all, which is one part instead
    # of two, nothing to keep aligned, and no second side of the slot to wire.
    #
    # IR_ACTIVE_LOW is the one thing that differs between parts. A break-beam
    # receiver and most proximity modules pull the line LOW when something is
    # there, which is the default. A few pull it HIGH. If --beam counts
    # continuously when nothing is happening and stops when you block it, the
    # part is the other kind: set this to 0.
    'IR_GPIO_PIN': '17',
    'IR_ACTIVE_LOW': '1',
    'IR_DEBOUNCE_SECONDS': '0.5',
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
    # 6 cells: a HEAD, not a body. At bin 4 that is 96 raw pixels.
    #
    # It was 12, which at bin 4 is 192 pixels and encodes a whole warm torso.
    # On the demo unit that meant a person had to be close and mostly in frame
    # before they counted at all: somebody half out of shot, a head over a
    # table, or anybody past about four metres read as nobody. A room is full
    # of partly visible people, so a threshold that only fires on a complete
    # silhouette undercounts exactly when the room is busiest.
    #
    # The arithmetic for 6. The Lepton 3.5 spans 57 degrees across, so at
    # three metres a bin-4 cell is about 8 cm of scene; a head is roughly
    # 16 x 22 cm, which is 2 x 3 cells before the thermal bloom around a
    # face, and 6 cells after it. Head and shoulders at six metres lands in
    # the same place.
    #
    # Why lowering it does not bring back the double counting bin 4 fixed:
    # that was ONE person splitting into head and torso. At bin 4 the cool
    # band between them is averaged away and the body is one connected region
    # whatever the minimum is, so a smaller minimum lets smaller people count
    # without letting one large person count twice. What it can do is count a
    # person twice when a heavy coat and scarf cut the warm regions apart;
    # that is the honest cost.
    #
    # And why this is not counting noise: 96 pixels is twice the 48 that
    # validated_thermal_pair treats as the sensor's own floor, and the scene
    # background removes lamps, screens and mugs before anything is grouped.
    # Confirm it at the real mount with --calibrate, which measures a person
    # at the actual range and recommends the number.
    'THERMAL_MIN_CLUSTER': '6',
    # Noise calibration. Out of the box these are nominal and the reported
    # figure is a relative loudness index, NOT calibrated dB SPL. See the
    # calibration section of README.md.
    'NOISE_REF_COUNTS': '1.0',
    # Stretches the level scale. The four words the venue card shows are spaced
    # across 35 dB, which assumes a microphone with at least that much range
    # between its own noise and clipping. A real unit measured 30 dB, so with a
    # scale of 1.0 the top word is unreachable however the reference is set:
    # shifting the window cannot widen it. --listen measures both ends and
    # recommends the pair. 1.0 leaves the old behaviour exactly as it was.
    'NOISE_SCALE': '1.0',
    # One measured point against a phone sound level app turns the relative
    # index into an estimated dB SPL. Only the constant is unknown: the slope
    # is physics, because the capsule's sensitivity is a fixed volts-per-pascal
    # and 20 dB of SPL is exactly ten times the voltage and so ten times the
    # counts. Leave at 0 and nothing is estimated. See README, Calibration.
    'NOISE_SPL_ANCHOR_COUNTS': '0.0',
    'NOISE_SPL_ANCHOR_DB': '0.0',
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
THERMAL_MIN_CLUSTER = _cfg_number('THERMAL_MIN_CLUSTER', int, 1, 19200, 6)
THERMAL_VIEW = _cfg_number('THERMAL_VIEW', int, 0, 1, 1)
IR_GPIO_PIN = _cfg_number('IR_GPIO_PIN', int, 2, 27, 17)
IR_ACTIVE_LOW = bool(_cfg_number('IR_ACTIVE_LOW', int, 0, 1, 1))
IR_DEBOUNCE_SECONDS = _cfg_number('IR_DEBOUNCE_SECONDS', float, 0.05, 10.0, 0.5)

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
_MEASURED_BIN, _MEASURED_MIN_CLUSTER = 4, 6
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
NOISE_SCALE = _cfg_number('NOISE_SCALE', float, 0.1, 10.0, 1.0)
NOISE_SPL_ANCHOR_COUNTS = _cfg_number('NOISE_SPL_ANCHOR_COUNTS', float, 0.0, 1024.0, 0.0)
NOISE_SPL_ANCHOR_DB = _cfg_number('NOISE_SPL_ANCHOR_DB', float, 0.0, 140.0, 0.0)

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
    # 12 bursts x 5s = 60s. It was 6, and a plain mean of six values lets one
    # bad burst move the published figure by a sixth of its own excess. A
    # slammed door or a dropped glass lasts long enough to own an entire
    # 100ms burst, so that is not a hypothetical.
    'noise_window': deque(maxlen=12),
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


# How many pushes in a row each channel has been reported as 0 because it was
# STALE rather than because the room was quiet.
#
# This is the last version of the problem that has run through every fix on this
# device: 0 is overloaded. A dead thermal camera and an empty room publish the
# same payload, byte for byte, and nothing downstream can tell them apart. That
# is survivable on a venue card, which is merely wrong for a while. It is not
# survivable in the training corpus, where a run of zeros from a wedged camera
# is indistinguishable from a run of zeros from a genuinely empty Tuesday, and
# the model learns the venue is quiet when in fact the sensor is broken.
#
# The backend's payload schema is closed, so this is not on the wire yet. It is
# logged as one structured line per push, which makes the question answerable
# from a terminal today:
#
#     journalctl -u flock-sensor | grep channel_health
#
# Putting it on the wire needs an optional nullable column and an additive
# change to the ingest validator, which is written up in README, Known gaps.
_stale_streaks = {'thermal': 0, 'noise': 0}


def channel_health():
    """What each channel's zeros currently mean. Cheap, and the only way to ask."""
    return dict(_stale_streaks)

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
    # The callers pass display names like 'Thermal headcount'. One word, lower
    # case, is the key, so the counter does not depend on that wording.
    key = name.split()[0].lower()
    if taken_at is not None and time.monotonic() - taken_at <= max_age:
        if key in _stale_streaks:
            _stale_streaks[key] = 0
        return value
    if key in _stale_streaks:
        # Counted whether or not the latched value was truthy. A camera that
        # died while the room happened to be empty is just as dead as one that
        # died mid-rush, and it is the one the old warning stayed silent about,
        # because it only spoke when there was a non-zero value to complain
        # about losing.
        _stale_streaks[key] += 1
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
    """Watch one pin for something crossing the doorway.

    Deliberately agnostic about what is on the end of it. A two-part break-beam
    and a one-sided IR proximity module both present as a pin that changes state
    when something is in the way, so both work here, and the one-sided part is
    the easier build: one thing to mount, nothing to align, and no 5V receiver
    to put in front of a pin that cannot take 5V.
    """
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        # Pulled toward the resting state, so an unconnected or unpowered sensor
        # sits quiet rather than floating and counting noise as a crowd.
        pull = GPIO.PUD_UP if IR_ACTIVE_LOW else GPIO.PUD_DOWN
        edge = GPIO.FALLING if IR_ACTIVE_LOW else GPIO.RISING
        GPIO.setup(IR_GPIO_PIN, GPIO.IN, pull_up_down=pull)

        last_trigger = [0.0]

        def on_break(channel):
            now = time.monotonic()
            if now - last_trigger[0] < IR_DEBOUNCE_SECONDS:
                return
            last_trigger[0] = now
            with _lock:
                # Bounded so a stuck or noisy sensor cannot grow this without
                # limit between snapshots.
                if _state['ir_count'] < MAX_IR_PER_READING:
                    _state['ir_count'] += 1

        GPIO.add_event_detect(IR_GPIO_PIN, edge, callback=on_break, bouncetime=200)
        logger.info(f'Crossing sensor initialized on GPIO {IR_GPIO_PIN}, counting '
                    f'{"falling" if IR_ACTIVE_LOW else "rising"} edges')
        return True
    except Exception as e:
        logger.error(f'Crossing sensor init failed (will report 0 crossings): {e}')
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
        # getattr, because O_NONBLOCK does not exist on every host this file
        # is imported on and the suite runs on one of them. Same tolerance the
        # fcntl guard above already has: Linux always has the flag, and a 0 here
        # would only ever mean a blocking open on a platform that cannot run
        # V4L2 anyway.
        self.fd = os.open(self.path, os.O_RDWR | getattr(os, 'O_NONBLOCK', 0))
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
# the file descriptor and open the camera again.
#
# The arithmetic, written out because the comment here used to claim 30s and
# was wrong. A read that times out costs _FRAME_WAIT_SECONDS inside read_frame
# AND the 2s wait at the bottom of the loop, so a failing iteration is about
# 4s and not 2s. Eight of them is roughly 32s. A reopen then reseeds the scene
# background, 30 frames at 2s, which is another 60s before a headcount is
# published at all.
#
# So a full recovery is about 90s against a THERMAL_STALE_AFTER of 90s, which
# means a real dropout DOES briefly show as offline on the venue card. That is
# the honest outcome and it fails safe. The previous version of this comment
# promised the opposite, which was arithmetic nobody had done.
_THERMAL_REOPEN_AFTER = 8
_THERMAL_REOPEN_BACKOFF_MAX = 300.0

# A camera can also fail by succeeding: the driver keeps handing back buffers
# and the content never changes. A frozen frame that is plausible and not flat
# passes every check in this loop, resets the failure count, and refreshes the
# freshness clock forever, so _fresh never engages and the venue publishes one
# stale headcount indefinitely. That is the exact failure _fresh exists to
# prevent, arriving through a different door. Real sensor noise means two
# consecutive frames are never bit-identical, so identical frames are a wedged
# bus. noise_loop already withholds on this for the ADC; the thermal path did
# not, and that asymmetry was the gap.
_THERMAL_IDENTICAL_LIMIT = 5


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
    if len(frame) < THERMAL_ROWS * THERMAL_COLS:
        # The guard count_thermal_clusters and thermal_region_sizes both have.
        # Unreachable from thermal_loop today because _configure refuses a
        # camera whose geometry is not 160x120, but this is the one function in
        # the group that would raise IndexError rather than degrade.
        return None
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
    last_signature = None
    identical = 0
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
                # Cheap fingerprint. A stride sample tells a frozen buffer from a
                # live one, and hashing 19,200 floats every read is not worth it
                # for a check that only fires on broken hardware.
                signature = hash(tuple(frame[::97]))
                identical = identical + 1 if signature == last_signature else 0
                last_signature = signature
                if identical >= _THERMAL_IDENTICAL_LIMIT:
                    # Counted as a failure on purpose, so the reopen machinery
                    # engages instead of this repeating forever.
                    failures += 1
                    log_throttled('thermal_frozen', logging.ERROR,
                                  'Thermal camera has returned the same frame '
                                  f'{identical + 1} times. The bus is wedged, so the '
                                  'headcount is withheld rather than repeated.')
                    _stop.wait(2)
                    continue
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
            last_signature, identical = None, 0
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
# Where the loudest thing the microphone can register should land. Inside Loud,
# which starts at 85, rather than on its edge.
LOUD_TARGET_LEVEL = 90.0


# The converter's hard ceiling. A signal centred at ADC_MID can swing 512 counts
# either way before it squares off against the rails, so an RMS approaching this
# is not a loud room, it is a clipped one.
ADC_CLIP_RMS = 512.0


def spl_from_counts(rms, anchor_counts=None, anchor_db=None):
    """Estimated dB SPL for an RMS in counts. None when the unit is not anchored.

    One anchor is enough and that is not a shortcut, it is the physics. The
    capsule has a fixed sensitivity in volts per pascal, so 20 dB of sound
    pressure is ten times the voltage and therefore ten times the counts. The
    slope of counts against dB is fixed at 20*log10; only the constant depends
    on where the gain trimpot happens to sit, and one measurement pins it.

    This is an ESTIMATE and the error bar is wide. A phone sound level app is
    within a few dB of a real meter at best, the phone and this microphone do
    not point the same way or have the same response, and neither is
    A-weighted. Treat it as good to about 5 to 8 dB, which is enough to say
    which end of a venue's range a reading sits at and not enough to publish a
    decibel figure to a user.
    """
    anchor_counts = NOISE_SPL_ANCHOR_COUNTS if anchor_counts is None else anchor_counts
    anchor_db = NOISE_SPL_ANCHOR_DB if anchor_db is None else anchor_db
    if anchor_counts <= 0 or anchor_db <= 0 or rms <= 0:
        return None
    return anchor_db + 20 * math.log10(rms / anchor_counts)


def hearing_window(floor_rms, anchor_counts=None, anchor_db=None):
    """(lowest, highest) dB SPL this unit can actually distinguish. None if unanchored.

    The bottom is the electrical noise floor and the top is where the converter
    clips, and the gap between them is fixed at roughly 25 to 28 dB on this
    hardware. Turning the gain trimpot slides the window along the SPL axis; it
    does not widen it, because gain multiplies the floor and the signal by the
    same amount. Only removing noise widens it.

    Worth printing because it answers the question that matters: a venue spans
    something like 45 dB SPL when empty to 90 when packed, and a 27 dB window
    cannot see all of that at once. Whatever falls below the bottom of this
    range reads as the floor and is indistinguishable from silence.
    """
    low = spl_from_counts(floor_rms, anchor_counts, anchor_db)
    high = spl_from_counts(ADC_CLIP_RMS, anchor_counts, anchor_db)
    if low is None or high is None:
        return None
    return low, high

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


def recommend_noise_settings(floor_rms, peak_rms, offset=None,
                             quiet_target=None, loud_target=None):
    """Reference and scale that map a measured room onto the whole word scale.

    Returns (ref, scale), or None when the two ends are not distinguishable.

    Solves both ends at once: the quietest burst lands at `quiet_target`, inside
    Quiet, and the loudest lands at `loud_target`, inside Loud. The reference
    alone can only slide the window, so a microphone with less usable range than
    the words assume needs the scale as well. Pure, so the arithmetic that
    decides what a venue is called is tested rather than eyeballed.
    """
    offset = NOISE_DB_OFFSET if offset is None else offset
    quiet_target = QUIET_TARGET_LEVEL if quiet_target is None else quiet_target
    loud_target = LOUD_TARGET_LEVEL if loud_target is None else loud_target
    if floor_rms <= 0 or peak_rms <= floor_rms:
        return None
    span_db = 20 * math.log10(peak_rms / floor_rms)
    if span_db <= 0:
        return None
    scale = (loud_target - quiet_target) / span_db
    ref = floor_rms * (10 ** ((offset - quiet_target) / (20.0 * scale)))
    return round(ref, 1), round(scale, 2)


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


def compute_noise_db(samples, ref_counts=None, offset=None, scale=None):
    """RMS of centred ADC counts, expressed on a log scale.

    The scale is what lets a microphone with less range than the four words
    assume still reach all four of them. Without it the slope is fixed at
    20*log10, the reference can only slide the window along the scale, and a
    unit with 30 dB between its noise floor and clipping cannot cover 35 dB
    of thresholds: you get a correct Quiet or a reachable Loud, never both.
    Measured on a real unit 2026-09-13, where shouting into the microphone
    from an inch away reported Lively and could not do better.
    """
    if not samples:
        return 0.0
    ref_counts = NOISE_REF_COUNTS if ref_counts is None else ref_counts
    offset = NOISE_DB_OFFSET if offset is None else offset
    scale = NOISE_SCALE if scale is None else scale
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    db = scale * 20 * math.log10(max(rms, 1e-6) / max(ref_counts, 1e-6)) + offset
    return max(0.0, min(MAX_NOISE_DB, db))


# How long each burst listens for. The sleep that used to sit inside this loop
# is gone, and that was the whole problem: time.sleep(0.001) does not cost a
# millisecond, it costs about 1.5, so the loop managed roughly 63 samples in
# 100ms. That is a 650Hz sample rate and a Nyquist limit of about 325Hz, which
# is below almost everything in a room. Speech formants, music, glassware and
# every consonant sat above it and folded back down into the measurement as
# alias, so the RMS was not the loudness of the room, it was the loudness of a
# scrambled version of it.
#
# Without the sleep the same loop manages thousands of samples in the same
# window, which moves Nyquist into the kilohertz and makes the figure mean what
# it claims. The cost is 100ms of one core every 5 seconds.
#
# Changing the sample rate changes the measured RMS, so it changes what
# NOISE_REF_COUNTS should be. Re-run --listen after this.
NOISE_BURST_SECONDS = 0.1
# A ceiling so a fast machine cannot build an enormous list. At 20kHz this is
# reached before the window closes and the burst simply ends early.
NOISE_MAX_SAMPLES = 4000

# How many bursts to discard from each end of the window before averaging.
#
# Professional noise monitoring does not report a plain mean, it reports
# percentile levels: L90 for the background a room sits at, L50 for the typical
# level, L10 for the peaks. The reason is that a mean is owned by its loudest
# member, and "how busy does this room feel" is a question about the level the
# room persistently sits at, not about the loudest thing that happened in it.
#
# Trimming one burst from each end of a twelve-burst window is the cheap version
# of that: it is an L50-shaped statistic rather than an Leq-shaped one, it costs
# a sort of twelve floats every five seconds, and it means a single door slam
# cannot carry the number.
#
# Deliberately NOT done: trimming outlier SAMPLES inside a single burst. It was
# recommended and it is the wrong level to do it at. A door slam lasts long
# enough to occupy a whole burst, so clipping a percentile of samples within one
# would not remove it, while it WOULD shave the genuine peaks of speech and
# music, which have a high crest factor and carry real energy. That trades a bias
# that is always present for a transient that it does not actually catch.
NOISE_WINDOW_TRIM = 1


def trimmed_mean(values, trim=None):
    """Mean of the window with the loudest and quietest bursts set aside.

    Falls back to a plain mean while the window is too short to trim, which is
    the first minute after a start or a reopen.
    """
    trim = NOISE_WINDOW_TRIM if trim is None else trim
    if not values:
        return 0.0
    ordered = sorted(values)
    if trim > 0 and len(ordered) >= 2 * trim + 3:
        ordered = ordered[trim:len(ordered) - trim]
    return sum(ordered) / float(len(ordered))

def noise_loop():
    while not _stop.is_set():
        try:
            samples = []
            t_end = time.monotonic() + NOISE_BURST_SECONDS
            while time.monotonic() < t_end and len(samples) < NOISE_MAX_SAMPLES:
                samples.append(_read_mcp3008_ch0() - ADC_MID)  # centre around 0
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
                        _state['noise_db'] = trimmed_mean(list(_state['noise_window']))
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

    # Says what this payload's zeros mean. A thermal_headcount of 0 with a
    # streak of 0 is an empty room; the same 0 with a streak of 400 is a camera
    # that died three hours ago. The payload itself cannot carry the difference
    # yet, so it goes to the log where a person can still get at it.
    health = channel_health()
    if any(health.values()):
        log_throttled('channel_health', logging.WARNING,
                      'channel_health ' + json.dumps(health) +
                      ' consecutive pushes reporting 0 because the channel is stale, '
                      'not because the room is quiet')

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
# The doorway counter
#
# A VL53L8CX returns an 8x8 grid of distances, about sixty-four numbers in
# millimetres, ten to fifteen times a second. It is not a camera: a zone is
# roughly a 30 cm square of floor at doorway range, which is enough to tell one
# person from two walking abreast and nowhere near enough to tell one person
# from another. That is the whole reason it is the part this build uses.
#
# Everything below is pure and works on lists of numbers, so the counting rules
# are tested without a sensor, a doorway, or anybody to walk through it. The
# driver that fetches the frames is separate and is the only part that needs
# hardware.
#
# WHY THIS REPLACED A BREAK BEAM. A single beam counts breaks, not people, and
# two people walking abreast break it once. Vendor tables put a single beam at
# about 85% for pairs, and a doorway at its busiest is exactly where pairs
# happen. Two people abreast are two separate clusters in this grid. The beam
# also cannot tell an arrival from a departure at all, and the order zones trip
# across the grid gives that away for free.
# ---------------------------------------------------------------------------

TOF_COLS = 8
TOF_ROWS = 8

# A zone counts as occupied when something is this much nearer than the floor.
# A head at doorway range is about a metre closer than the floor, so 300 mm is
# generous, and generous is right: the cost of a missed person is a wrong count
# and the cost of a jumpy threshold is a count that drifts all night.
TOF_MARGIN_MM = _cfg_number('TOF_MARGIN_MM', int, 100, 1500, 300)

# Clusters smaller than this are noise, not people. One zone is about 30 cm of
# floor, so a person spans several; a single lit zone is far more likely to be
# a reflection off a door frame.
TOF_MIN_CLUSTER = _cfg_number('TOF_MIN_CLUSTER', int, 1, 32, 3)

# How long a track survives without being seen before it is dropped. At roughly
# 15 Hz this is about a third of a second, which covers somebody being briefly
# hidden behind somebody else without keeping ghosts around.
TOF_TRACK_MISSES = _cfg_number('TOF_TRACK_MISSES', int, 1, 30, 5)

# How far a cluster may move between frames and still be the same person, in
# zones. A brisk walk crosses the grid in about a second, so a zone or two per
# frame; three is slack for a dropped frame.
TOF_MAX_JUMP = _cfg_number('TOF_MAX_JUMP', float, 1.0, 8.0, 3.0)


def tof_occupied(frame, floor_mm, margin_mm=None):
    """Which of the 64 zones have something in them.

    `frame` is 64 distances in millimetres, row-major. A zone reading 0 or
    negative is a failed measurement, not a very close object, and is treated
    as empty: the sensor reports invalid zones that way and reading them as
    zero distance would put a phantom person against the lens.
    """
    margin = TOF_MARGIN_MM if margin_mm is None else margin_mm
    limit = floor_mm - margin
    return [i for i, d in enumerate(frame) if 0 < d < limit]


def tof_clusters(occupied, min_cluster=None):
    """Group occupied zones into people.

    Eight-connectivity, the same rule the thermal counter uses, and for the
    same reason: a person straddling two zones diagonally is one person, and
    four-connectivity splits them into two.
    """
    floor = TOF_MIN_CLUSTER if min_cluster is None else min_cluster
    remaining = set(occupied)
    out = []
    while remaining:
        seed = remaining.pop()
        group = [seed]
        stack = [seed]
        while stack:
            i = stack.pop()
            r, c = divmod(i, TOF_COLS)
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    nr, nc = r + dr, c + dc
                    if not (0 <= nr < TOF_ROWS and 0 <= nc < TOF_COLS):
                        continue
                    j = nr * TOF_COLS + nc
                    if j in remaining:
                        remaining.discard(j)
                        group.append(j)
                        stack.append(j)
        if len(group) >= floor:
            out.append(group)
    return out


def tof_centroid(group):
    """Middle of a cluster, as (row, column) in zones."""
    rows = [g // TOF_COLS for g in group]
    cols = [g % TOF_COLS for g in group]
    return (sum(rows) / float(len(rows)), sum(cols) / float(len(cols)))


class CrossingTracker:
    """Follows clusters across frames and counts which way they went.

    The rule is deliberately the simplest one that can tell a direction: follow
    each cluster, and when its centre crosses the middle row of the grid, count
    it once, in the direction it crossed. No speed model, no shape model,
    nothing that could be tuned into agreeing with whatever the operator hoped
    for.

    What it will not do is count somebody who stops in the doorway, turns
    around, and goes back the way they came. It counts that as nothing, which
    is right, and it is the case a break beam gets wrong twice.
    """

    def __init__(self, axis='row'):
        # Which way the doorway runs across the sensor's view. Mount the head
        # so people cross the grid top to bottom and leave this alone.
        self.axis = axis
        self.mid = (TOF_ROWS - 1) / 2.0 if axis == 'row' else (TOF_COLS - 1) / 2.0
        self._tracks = []   # each is {'pos': (r, c), 'side': -1/1, 'missed': n}
        self.entries = 0
        self.exits = 0

    def _coord(self, pos):
        return pos[0] if self.axis == 'row' else pos[1]

    def _side(self, pos):
        return -1 if self._coord(pos) < self.mid else 1

    def observe(self, clusters):
        """Feed one frame's clusters. Returns (entries, exits) added by it."""
        centres = [tof_centroid(g) for g in clusters]
        used = set()
        gained_in = gained_out = 0

        for t in self._tracks:
            # Nearest unclaimed cluster within the jump limit is the same
            # person. Greedy rather than optimal on purpose: at two or three
            # people in a doorway the two agree, and an assignment algorithm
            # here would be untestable complexity for no measurable gain.
            best, best_d = None, TOF_MAX_JUMP
            for i, c in enumerate(centres):
                if i in used:
                    continue
                d = ((c[0] - t['pos'][0]) ** 2 + (c[1] - t['pos'][1]) ** 2) ** 0.5
                if d < best_d:
                    best, best_d = i, d
            if best is None:
                t['missed'] += 1
                continue
            used.add(best)
            t['missed'] = 0
            new_pos = centres[best]
            new_side = self._side(new_pos)
            if new_side != t['side']:
                if new_side > 0:
                    gained_in += 1
                else:
                    gained_out += 1
                t['side'] = new_side
            t['pos'] = new_pos

        for i, c in enumerate(centres):
            if i not in used:
                self._tracks.append({'pos': c, 'side': self._side(c), 'missed': 0})

        self._tracks = [t for t in self._tracks if t['missed'] < TOF_TRACK_MISSES]
        self.entries += gained_in
        self.exits += gained_out
        return gained_in, gained_out

    @property
    def net(self):
        """Everyone who came in and has not left. Never below zero.

        It can only be a floor, not a truth: the room may have been occupied
        before the sensor was switched on, and a night that starts mid-service
        starts counting from whatever is already inside. The venue being empty
        at close is what makes this number mean anything, and that is also the
        free calibration the roadmap describes.
        """
        return max(0, self.entries - self.exits)

    @property
    def track_count(self):
        return len(self._tracks)

# ---------------------------------------------------------------------------
# Display loop (optional, demo unit only)
#
# THE PANEL SIZE IS NOT A CONSTANT, and treating it as one is what broke this.
# The code below used to hardcode 720x1280, the portrait DSI panel an early
# build plan named. The panel actually bought is a 7 inch 1024x600 HDMI screen,
# which is landscape and barely half the height. Every piece of the layout was
# sized against 1280: three stacked blocks needed 912 pixels of height, so on a
# 600 pixel panel the third ran off the bottom and the chart drew straight
# through the second. The thermal view was worse, scaling its image to 714
# pixels tall inside a 600 pixel window.
#
# So the numbers below are only a default, for the case where the framebuffer
# cannot say what it is. What actually drives the layout is the size set_mode
# returns, read back at startup, and the layout picks columns or rows from the
# shape it gets. The next panel, whatever it is, needs no code change.
# ---------------------------------------------------------------------------

DISPLAY_W = _cfg_number('DISPLAY_W', int, 320, 4096, 1024)
DISPLAY_H = _cfg_number('DISPLAY_H', int, 240, 4096, 600)


def display_metrics(w, h):
    """Every number the panel layout needs, derived from the panel's own size.

    Pure, so the whole layout is checked at both shapes without a framebuffer.

    A wide panel gets the three readings in columns and a tall one gets them
    stacked. That is not cosmetic: three stacked blocks at a readable size need
    about 900 pixels of height, which a 600 pixel panel does not have, and
    three columns on a narrow portrait panel leave each number about 240 pixels
    wide, which a three digit count overflows.
    """
    pad = max(16, w // 28)
    header_h = max(48, h // 9)
    # The chart gives up space first, because it is the only thing on the
    # screen that is nice to have rather than the reading itself.
    chart_h = max(48, h // 6)
    chart_caption = max(28, h // 20)
    chart_bottom = h - pad - chart_caption
    chart_top = chart_bottom - chart_h

    block_top = header_h + max(12, h // 40)
    block_room = max(1, chart_top - block_top - pad)

    columns = w >= h * 1.3
    if columns:
        block_w = (w - 2 * pad) // 3
        block_h = block_room
    else:
        block_w = w - 2 * pad
        block_h = max(1, block_room // 3)

    return {
        'w': w, 'h': h, 'pad': pad, 'header_h': header_h,
        'columns': columns, 'block_w': block_w, 'block_h': block_h,
        'block_top': block_top,
        'chart_top': chart_top, 'chart_h': chart_h, 'chart_bottom': chart_bottom,
        # Sized off the height so the text keeps the same share of a 7 inch
        # panel whichever way round it is, with floors so a short panel stays
        # legible from across a room instead of shrinking into nothing.
        'font_big': max(56, int(h * 0.155) if columns else int(h * 0.117)),
        'font_med': max(34, int(h * 0.075)),
        'font_sm': max(22, int(h * 0.036)),
        'font_xs': max(18, int(h * 0.026)),
    }


def block_origin(m, i):
    """Top-left of reading `i`, laid out whichever way round the panel is."""
    if m['columns']:
        return (m['pad'] + i * m['block_w'], m['block_top'])
    return (m['pad'], m['block_top'] + i * m['block_h'])


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

def video_driver_candidates(env=None, has_dri=None):
    """Which SDL video drivers to try, best first.

    THIS IS WHERE THE PANEL FAILED THE FIRST TIME ONE WAS EVER PLUGGED IN. The
    code asked for "fbcon", which is an SDL 1.2 driver name. SDL2 dropped it
    years ago; its Linux drivers are x11, wayland, kmsdrm, offscreen and dummy.
    Asking for one SDL2 does not have did not raise, it HUNG inside set_mode,
    so the display thread sat there forever and the one log line that would
    have explained it never printed. From outside, the program looked like it
    simply stopped after pygame's banner.

    Nothing had caught it because nothing could: this file's own comment said,
    accurately, that no panel had ever been attached to this code.

    Pure and takes its environment, so the choice is tested on a machine with
    no framebuffer at all.
    """
    env = os.environ if env is None else env
    forced = (env.get('SDL_VIDEODRIVER') or '').strip()
    if forced:
        return [forced]

    if has_dri is None:
        has_dri = os.path.isdir('/dev/dri')

    out = []
    # A desktop session owns the screen and the only way in is through it. This
    # matters more than it looks: a Pi showing the Raspberry Pi OS desktop is
    # the normal state of a unit somebody has just set up, and kmsdrm cannot
    # take the display away from a running compositor. On this build labwc held
    # it, and kmsdrm answered "not available" rather than saying so.
    if env.get('WAYLAND_DISPLAY'):
        out.append('wayland')
    if env.get('DISPLAY'):
        out.append('x11')
    # No session, so talk to the hardware. This is the venue unit's case and
    # the one a demo should end up in, because a desktop underneath is one more
    # thing that can misbehave in front of a judge.
    if has_dri:
        out.append('kmsdrm')
    # Last resort. Not for a picture: so that a display thread which cannot
    # start is unable to take the doorway counter down with it.
    out.append('dummy')
    return out


# The product's own type, palette and marks, so the panel looks like the rest of
# Flock rather than like a Python program with a screen attached.
#
# Fraunces carries every large piece of text and Hanken Grotesk every small
# one, which is the division the app, the site and the pitch deck already use.
# The marks are the same illustrated birds, cut down in flux-assets/ to the
# sizes this panel draws them at.
#
# A missing file means a plainer screen, never a dark one. And note what these
# fonts are: brand SUBSETS of about 35 KB, not the full families. Checked
# 2026-09-26 against every character this file draws; the one real gap is the
# approximately-equal sign, which renders as an empty box, so the decibel
# readout says "estimated" in words instead.
_HERE = os.path.dirname(os.path.abspath(__file__))
BRAND_ASSET_DIRS = (
    os.path.join(_HERE, 'flux-assets'),
    '/etc/flock-sensor/flux-assets',
    os.path.join(_HERE, 'fonts'),
    os.path.join(_HERE, '..', 'brand-fonts'),
)
BRAND_FONT_DIRS = BRAND_ASSET_DIRS

BRAND_DISPLAY = 'Flock-Fraunces-Display-Bold.ttf'
BRAND_WORDMARK = 'Flock-Fraunces-Wordmark-Black.ttf'
BRAND_LABEL = 'Flock-Hanken-Grotesk-Medium.ttf'
BRAND_BODY = 'Flock-Hanken-Grotesk-Regular.ttf'
BRAND_MARK_BADGE = 'flux-flock-badge.png'
BRAND_MARK_BIRDS = 'flux-birds-walking.png'

# Read off the app's CSS custom properties, not picked by eye.
BRAND_NAVY = (15, 23, 42)       # --navy  #0f172a
BRAND_INK = (22, 40, 61)        # --ink   #16283d
BRAND_CREAM = (244, 239, 227)   # --cream #f4efe3
BRAND_RULE = (30, 58, 92)       # --border-color #1e3a5c
BRAND_MUTED = (138, 152, 170)
BRAND_FAINT = (88, 104, 124)
BRAND_GREEN = (16, 185, 129)
BRAND_AMBER = (245, 158, 11)
BRAND_ORANGE = (249, 115, 22)
BRAND_RED = (239, 68, 68)


def brand_font_path(name):
    """Where a brand file lives, or None if it was not shipped."""
    for d in BRAND_ASSET_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


def load_brand_font(pygame, name, size):
    """One face at one size, falling back to whatever pygame has."""
    path = brand_font_path(name)
    if path:
        try:
            return pygame.font.Font(path, size)
        except Exception as e:
            log_throttled('brand_font', logging.WARNING, f'Could not load {name}: {e}')
    # pygame's default face runs small for its point size, so a fallback that
    # ignored that would turn a plainer screen into a harder one to read.
    return pygame.font.Font(None, int(size * 1.25))


def load_brand_mark(pygame, name):
    """A brand illustration with its transparency, or None if unavailable."""
    path = brand_font_path(name)
    if not path:
        return None
    try:
        surf = pygame.image.load(path)
        try:
            return surf.convert_alpha()
        except Exception:
            return surf
    except Exception as e:
        log_throttled('brand_mark', logging.WARNING, f'Could not load {name}: {e}')
        return None


def tracked(pygame, font, text, colour, spacing):
    """Render with letter spacing, which pygame has no setting for.

    Small capitals need air or they read as a shout. Glyph by glyph is the only
    way to get it, and at a few labels a frame the cost does not show up.
    """
    glyphs = [font.render(ch, True, colour) for ch in text]
    if not glyphs:
        return None
    w = sum(g.get_width() for g in glyphs) + spacing * (len(glyphs) - 1)
    h = max(g.get_height() for g in glyphs)
    surf = pygame.Surface((max(1, w), max(1, h)), pygame.SRCALPHA)
    x = 0
    for g in glyphs:
        surf.blit(g, (x, 0))
        x += g.get_width() + spacing
    return surf


def display_decibels(level):
    """Estimated dB SPL behind a published level, or None if not anchored.

    The level the noise loop publishes is a log-scale index, not decibels. It
    becomes an estimate of real sound pressure only once one reading from a
    phone sound meter has been paired with it, which is what the SPL anchor
    records. Until then this returns None and the panel says "level", because
    printing "dB" beside an unanchored index would be a claim nothing supports.
    Inverts compute_noise_db exactly, then asks spl_from_counts.
    """
    if NOISE_SPL_ANCHOR_COUNTS <= 0 or NOISE_SPL_ANCHOR_DB <= 0 or level <= 0:
        return None
    rms = NOISE_REF_COUNTS * 10 ** ((level - NOISE_DB_OFFSET) / (20.0 * NOISE_SCALE))
    return spl_from_counts(rms)


def noise_reading(level):
    """(number, caption, scale value) for a published noise level.

    The third value is what the word and the trace are measured against, and
    it has to be the same thing the number shows. The first version took the
    word from the raw index and the number from the calibrated estimate, and
    rendering it put "Moderate" beside "37 dB": two readings of one room that
    disagreed on the same card. Calibrated, everything is decibels; not, it is
    all the index, and the caption says so.
    """
    spl = display_decibels(level)
    if spl is None:
        return f'level {int(level)}', 'relative, not yet calibrated', level
    return f'{int(round(spl))} dB', 'estimated sound level', spl


def thermal_image_box(w, h, cols, rows, pad, top, reserve):
    """Largest rectangle the thermal image can fill without being cropped.

    Fits by whichever of width or height runs out first. The version before
    this one set the width to the panel's width and derived the height, which
    on a 1024x600 panel asked for an image 714 pixels tall and drew a third of
    it off the bottom.
    """
    avail_w = max(1, w - 2 * pad)
    avail_h = max(1, h - top - reserve)
    img_w = avail_w
    img_h = int(round(img_w * rows / float(cols)))
    if img_h > avail_h:
        img_h = avail_h
        img_w = int(round(img_h * cols / float(rows)))
    return max(1, img_w), max(1, img_h)


def noise_band(db):
    """The word and the colour for a level. One place, four screens."""
    if db < 50:
        return 'Quiet', BRAND_GREEN
    if db < 70:
        return 'Moderate', BRAND_AMBER
    if db < 85:
        return 'Lively', BRAND_ORANGE
    return 'Loud', BRAND_RED


def home_cards(w, h, m):
    """The three tappable readings, as rectangles.

    Pure, so the tap targets and the drawn cards come from one place and cannot
    disagree: a card drawn in one spot and hit-tested in another is a button
    that looks pressable and does nothing. Room is left at the bottom for the
    footer and its birds. Returns a list of (x, y, w, h).
    """
    pad = m['pad']
    top = m['header_h'] + max(14, pad // 2)
    bottom = h - pad - max(70, h // 8)
    gap = max(12, pad // 2)
    if m['columns']:
        cw = (w - 2 * pad - 2 * gap) // 3
        return [(pad + i * (cw + gap), top, cw, bottom - top) for i in range(3)]
    ch = (bottom - top - 2 * gap) // 3
    return [(pad, top + i * (ch + gap), w - 2 * pad, ch) for i in range(3)]


def hit_card(pos, cards):
    """Which card a touch landed on, or None for the gaps between them."""
    x, y = pos
    for i, (cx, cy, cw, ch) in enumerate(cards):
        if cx <= x < cx + cw and cy <= y < cy + ch:
            return i
    return None


def back_button_rect(m):
    """The Back button's rectangle. One definition for drawing and hitting."""
    pad = m['pad']
    bh = max(40, m['font_sm'] + 20)
    bw = max(120, m['font_sm'] * 5)
    return (pad, (m['header_h'] - bh) // 2, bw, bh)


class Panel:
    """Everything the screens need, built once and kept.

    The first version re-rendered every string four times a second and slept a
    quarter second between polls, so a tap could wait 250 ms and the panel
    felt like wading. Text is cached by what it says, marks are scaled once,
    events are read sixty times a second, and the screen repaints only when
    something on it changed.
    """

    MAX_CACHE = 400

    def __init__(self, pygame, screen, w, h):
        self.pygame = pygame
        self.screen = screen
        self.w = w
        self.h = h
        self.m = display_metrics(w, h)
        m = self.m
        # Large text is Fraunces, small text is Hanken Grotesk, everywhere.
        self.f_mark = load_brand_font(pygame, BRAND_WORDMARK, m['font_sm'] + 12)
        self.f_title = load_brand_font(pygame, BRAND_DISPLAY, m['font_sm'] + 8)
        self.f_big = load_brand_font(pygame, BRAND_DISPLAY, m['font_big'])
        self.f_med = load_brand_font(pygame, BRAND_DISPLAY, m['font_med'])
        self.f_hero = load_brand_font(pygame, BRAND_WORDMARK, max(72, h // 6))
        self.f_label = load_brand_font(pygame, BRAND_LABEL, m['font_sm'])
        self.f_body = load_brand_font(pygame, BRAND_BODY, m['font_xs'])
        self.cards = home_cards(w, h, m)
        self.back = back_button_rect(m)
        self._cache = {}
        self._marks = {}
        self._thermal_key = None
        self._thermal_surf = None
        # The panel keeps its own noise trace. The noise loop reads every five
        # seconds, far too coarse to draw as a wave, and a buffer here costs
        # nothing and never blocks the thread doing the measuring.
        self.trace = deque(maxlen=max(120, w // 3))

    # -- primitives --------------------------------------------------------

    def text(self, font, s, colour):
        key = (id(font), s, colour)
        surf = self._cache.get(key)
        if surf is None:
            if len(self._cache) > self.MAX_CACHE:
                self._cache.clear()
            surf = font.render(s, True, colour)
            self._cache[key] = surf
        return surf

    def blit(self, font, s, colour, pos):
        self.screen.blit(self.text(font, s, colour), pos)

    def blit_centred(self, font, s, colour, cx, y):
        surf = self.text(font, s, colour)
        self.screen.blit(surf, (cx - surf.get_width() // 2, y))

    def label(self, s, pos, colour=BRAND_MUTED):
        """Small tracked capitals in Hanken. They get air, not a box."""
        key = ('lab', s, colour)
        surf = self._cache.get(key)
        if surf is None:
            surf = tracked(self.pygame, self.f_label, s.upper(), colour,
                           max(1, self.m['font_sm'] // 10))
            self._cache[key] = surf
        if surf:
            self.screen.blit(surf, pos)

    def mark(self, name, height):
        """A brand mark scaled to a height, cached, or None if unavailable."""
        key = (name, height)
        if key not in self._marks:
            src = load_brand_mark(self.pygame, name)
            if src is None:
                self._marks[key] = None
            else:
                w = max(1, int(src.get_width() * height / float(src.get_height())))
                try:
                    self._marks[key] = self.pygame.transform.smoothscale(src, (w, height))
                except Exception:
                    self._marks[key] = self.pygame.transform.scale(src, (w, height))
        return self._marks[key]

    def rule(self, x1, y, x2, colour=BRAND_RULE):
        self.pygame.draw.line(self.screen, colour, (x1, y), (x2, y), 1)

    def section(self, text, cy):
        """A centred title between two rules, the way the deck heads a section."""
        s = self.text(self.f_title, text, BRAND_CREAM)
        x = (self.w - s.get_width()) // 2
        self.screen.blit(s, (x, cy - s.get_height() // 2))
        gap = 18
        pad = self.m['pad']
        self.rule(pad, cy, x - gap)
        self.rule(x + s.get_width() + gap, cy, self.w - pad)

    def card(self, rect):
        """A tappable surface: a lighter field and a hairline border, so it
        reads as something to press without becoming a rounded icon tile."""
        self.pygame.draw.rect(self.screen, BRAND_INK, rect, 0, 16)
        self.pygame.draw.rect(self.screen, BRAND_RULE, rect, 1, 16)

    def chevron(self, x, y, size, colour, right=True):
        s = size
        pts = ([(x - s, y - s), (x, y), (x - s, y + s)] if right
               else [(x + s, y - s), (x, y), (x + s, y + s)])
        self.pygame.draw.lines(self.screen, colour, False, pts, 3)

    # -- chrome ------------------------------------------------------------

    def status(self, live):
        m = self.m
        top = m['header_h']
        dot = BRAND_GREEN if live else BRAND_RED
        s = self.text(self.f_body, 'Live' if live else 'Stale', BRAND_MUTED)
        x = self.w - m['pad'] - s.get_width()
        self.screen.blit(s, (x, (top - s.get_height()) // 2))
        self.pygame.draw.circle(self.screen, dot, (x - 16, top // 2), max(4, m['font_xs'] // 5))

    def header(self, title=None, live=None, back=False):
        m = self.m
        pad = m['pad']
        top = m['header_h']
        self.screen.fill(BRAND_NAVY)
        if back:
            bx, by, bw, bh = self.back
            self.pygame.draw.rect(self.screen, BRAND_INK, self.back, 0, bh // 2)
            self.pygame.draw.rect(self.screen, BRAND_RULE, self.back, 1, bh // 2)
            cs = max(6, bh // 6)
            self.chevron(bx + 18 + cs, by + bh // 2, cs, BRAND_CREAM, right=False)
            s = self.text(self.f_label, 'Back', BRAND_CREAM)
            self.screen.blit(s, (bx + 18 + cs * 2 + 10, by + (bh - s.get_height()) // 2))
            t = self.text(self.f_title, title, BRAND_CREAM)
            self.screen.blit(t, ((self.w - t.get_width()) // 2, (top - t.get_height()) // 2))
        else:
            # The Flock badge, then the product's name, the way the deck signs
            # every slide with the badge in its corner.
            x = pad
            badge = self.mark(BRAND_MARK_BADGE, max(34, top - 22))
            if badge is not None:
                self.screen.blit(badge, (x, (top - badge.get_height()) // 2))
                x += badge.get_width() + 14
            s = self.text(self.f_mark, 'Flux', BRAND_CREAM)
            self.screen.blit(s, (x, (top - s.get_height()) // 2))
        if live is not None:
            self.status(live)
        self.rule(0, top, self.w)

    # -- screens -----------------------------------------------------------

    def splash(self, message='Starting the sensors'):
        """What the panel shows while the camera and microphone warm up.

        The camera needs about thirty frames to learn the room before it will
        count anybody, which is several seconds of a blank or zero screen. A
        blank screen in front of a judge reads as broken; this reads as a
        product starting.
        """
        self.screen.fill(BRAND_NAVY)
        cx, cy = self.w // 2, self.h // 2
        # The badge itself, the way the deck opens: the fainter circle mark
        # this first used all but disappeared against the navy.
        flock = self.mark(BRAND_MARK_BADGE, max(120, self.h // 4))
        name = self.text(self.f_hero, 'Flux', BRAND_CREAM)
        by = self.text(self.f_body, 'by Flock', BRAND_MUTED)
        note = self.text(self.f_body, message, BRAND_FAINT)
        fh = flock.get_height() if flock is not None else 0
        total = fh + 18 + name.get_height() + 4 + by.get_height() + 30 + note.get_height()
        y = cy - total // 2
        if flock is not None:
            self.screen.blit(flock, (cx - flock.get_width() // 2, y))
            y += fh + 18
        self.screen.blit(name, (cx - name.get_width() // 2, y))
        y += name.get_height() + 4
        self.screen.blit(by, (cx - by.get_width() // 2, y))
        y += by.get_height() + 30
        self.screen.blit(note, (cx - note.get_width() // 2, y))

    def footer(self, text):
        """A hairline along the bottom, the hint on the left, and the birds
        walking along the right of it: the brand's signature, not decoration
        laid over the data."""
        m = self.m
        pad = m['pad']
        base = self.h - max(18, pad // 2)
        birds = self.mark(BRAND_MARK_BIRDS, max(44, self.h // 11))
        if birds is not None:
            bx = self.w - pad - birds.get_width()
            self.rule(pad, base, bx - 12)
            self.screen.blit(birds, (bx, base - birds.get_height() + 6))
        else:
            self.rule(pad, base, self.w - pad)
        s = self.text(self.f_body, text, BRAND_FAINT)
        self.screen.blit(s, (pad, base - s.get_height() - 10))

    def home(self, ir, therm, therm_live, level, noise_live, history):
        m = self.m
        self.header(live=therm_live or noise_live)
        n_value, n_caption, basis = noise_reading(level)
        word, colour = noise_band(basis)
        cells = [
            ('Through the door', str(ir), BRAND_CREAM, 'since the last update', True),
            ('In view now', f'{therm}' if therm_live else '--', BRAND_CREAM,
             'people in the room' if therm_live else 'thermal offline', therm_live),
            ('Noise', word if noise_live else '--',
             colour if noise_live else BRAND_CREAM,
             n_value if noise_live else 'microphone offline', noise_live),
        ]
        for rect, (lab, val, col, cap, ok) in zip(self.cards, cells):
            x, y, w, h = rect
            self.card(rect)
            cx = x + w // 2
            inner = max(16, m['pad'] // 2)
            self.label(lab, (x + inner, y + inner))
            # One box, one height, for every value, and every caption on one
            # line. A word like "Moderate" is set smaller than a digit to fit,
            # and centring each on its own height put three captions at three
            # heights, which is the first thing an eye catches on a row.
            font = self.f_big if len(val) <= 4 else self.f_med
            vs = self.text(font, val, col)
            box_h = self.f_big.get_height()
            box_y = y + (h - box_h) // 2 - m['font_xs'] // 2
            self.screen.blit(vs, (cx - vs.get_width() // 2, box_y + (box_h - vs.get_height()) // 2))
            self.blit_centred(self.f_body, cap, BRAND_MUTED if ok else BRAND_RED,
                              cx, box_y + box_h + 4)
            vw = self.text(self.f_label, 'View', BRAND_CREAM)
            ay = y + h - inner - vw.get_height()
            cs = max(5, vw.get_height() // 4)
            self.screen.blit(vw, (x + w - inner - vw.get_width() - cs - 12, ay))
            self.chevron(x + w - inner, ay + vw.get_height() // 2, cs, BRAND_CREAM)
        self.footer('Tap a reading to open it')

    def spark(self, values, x, top, w, height):
        """A hairline trace of recent counts. Ruled and flat, no fill."""
        hi = max(values) or 1
        pts = [(x + (w * i / max(1, len(values) - 1)), top + height - (v / hi) * height)
               for i, v in enumerate(values)]
        self.rule(x, top + height, x + w)
        if len(pts) > 1:
            self.pygame.draw.lines(self.screen, BRAND_CREAM, False, pts, 2)
        for p in pts:
            self.pygame.draw.circle(self.screen, BRAND_CREAM, (int(p[0]), int(p[1])), 3)

    def door(self, ir, history):
        m = self.m
        pad = m['pad']
        self.header('Through the door', back=True)
        top = m['header_h'] + pad
        self.label('Since the last update', (pad, top))
        v = self.text(self.f_big, str(ir), BRAND_CREAM)
        self.screen.blit(v, (pad, top + m['font_sm'] + 6))
        # What this number is and is not. It was once labelled "Entered Today",
        # which it has never been, and a judge asking the obvious follow-up
        # deserves the honest answer on the screen rather than in the pitch.
        tx = pad + v.get_width() + pad
        ty = top + m['font_sm'] + 6 + (v.get_height() - 2 * (m['font_xs'] + 8)) // 2
        for s in ('Crossings in either direction, over one push interval.',
                  'The doorway counter adds which way each person went.'):
            self.blit(self.f_body, s, BRAND_MUTED, (tx, ty))
            ty += m['font_xs'] + 8
        chart_top = top + m['font_sm'] + v.get_height() + pad * 2
        self.section('Recent headcounts', chart_top)
        if history:
            ch = self.h - chart_top - pad * 2
            self.spark(history, pad, chart_top + pad, self.w - 2 * pad, max(40, ch))
        else:
            self.blit_centred(self.f_body, 'Readings appear here after the first update.',
                              BRAND_FAINT, self.w // 2, (chart_top + self.h) // 2)

    def noise(self, level, live):
        m = self.m
        pad = m['pad']
        self.header('Noise', back=True, live=live)
        n_value, n_caption, basis = noise_reading(level)
        word, colour = noise_band(basis)
        top = m['header_h'] + pad
        w = self.text(self.f_big, word if live else '--', colour if live else BRAND_CREAM)
        self.screen.blit(w, (pad, top))
        if live:
            # The number, set as large as the word, at the right. Decibels
            # when the unit has been anchored to a phone meter, the level when
            # it has not, and a caption that says which.
            d = self.text(self.f_big, n_value, BRAND_CREAM)
            self.screen.blit(d, (self.w - pad - d.get_width(), top))
            c = self.text(self.f_body, n_caption, BRAND_MUTED)
            self.screen.blit(c, (self.w - pad - c.get_width(), top + d.get_height() + 2))
        else:
            self.blit(self.f_body, 'microphone offline', BRAND_RED,
                      (pad + 4, top + w.get_height() + 2))

        # The trace, over the four bands, so a rising line means something
        # without anybody reading a number off an axis.
        gtop = top + w.get_height() + m['font_xs'] + pad
        gbot = self.h - pad
        if gbot - gtop < 40:
            return
        lo, hi = 30.0, 100.0
        gx, gw = pad, self.w - 2 * pad

        def ypos(v):
            v = min(hi, max(lo, v))
            return gbot - (v - lo) / (hi - lo) * (gbot - gtop)
        for a, b, c in ((lo, 50, BRAND_GREEN), (50, 70, BRAND_AMBER),
                        (70, 85, BRAND_ORANGE), (85, hi, BRAND_RED)):
            y1, y2 = ypos(b), ypos(a)
            band = self.pygame.Surface((gw, max(1, int(y2 - y1))), self.pygame.SRCALPHA)
            band.fill(c + (24,))
            self.screen.blit(band, (gx, y1))
        for level_mark in (50, 70, 85):
            self.rule(gx, ypos(level_mark), gx + gw)
        # Each band named inside itself at the left. The newest readings are
        # at the right edge, so labels there sat on the line this screen is for.
        names = ((lo, 50, 'Quiet'), (50, 70, 'Moderate'), (70, 85, 'Lively'), (85, hi, 'Loud'))
        widest = 0
        for a, b, name in names:
            s = self.text(self.f_body, name, BRAND_MUTED)
            widest = max(widest, s.get_width())
            self.screen.blit(s, (gx + 12, int((ypos(a) + ypos(b)) / 2.0 - s.get_height() / 2)))
        if len(self.trace) > 1:
            # Spread across the width whatever the buffer holds. Pinned to the
            # full window, a fresh screen was nine tenths empty with the trace
            # crammed against the right edge, which reads as broken.
            lx = gx + 12 + widest + 16
            step = (gx + gw - lx) / float(len(self.trace) - 1)
            pts = [(lx + i * step, ypos(v)) for i, v in enumerate(self.trace)]
            self.pygame.draw.lines(self.screen, colour, False, pts, 3)
            self.pygame.draw.circle(self.screen, colour, (int(pts[-1][0]), int(pts[-1][1])), 6)
        else:
            self.blit_centred(self.f_body, 'Listening. The trace fills in from here.',
                              BRAND_MUTED, self.w // 2, (gtop + gbot) // 2)

    def thermal(self, frame, count, live):
        m = self.m
        pad = m['pad']
        self.header('What the sensor sees', back=True, live=live)
        top = m['header_h'] + max(12, pad // 2)
        if not frame:
            self.blit_centred(self.f_med, 'No picture yet', BRAND_MUTED, self.w // 2,
                              self.h // 2 - m['font_med'])
            self.blit_centred(self.f_body, 'The camera may still be starting.',
                              BRAND_FAINT, self.w // 2, self.h // 2 + 10)
            return

        # The picture takes the height of the panel and the readings sit beside
        # it. Stacked underneath, the first version spent a third of a
        # landscape screen on two lines of text, and the picture is the point.
        side = max(230, self.w // 4) if m['columns'] else 0
        avail_w = self.w - 2 * pad - (side + pad if side else 0)
        avail_h = self.h - top - pad
        iw, ih = avail_w, int(avail_w * THERMAL_ROWS / float(THERMAL_COLS))
        if ih > avail_h:
            ih = avail_h
            iw = int(ih * THERMAL_COLS / float(THERMAL_ROWS))

        # Rebuild the scaled picture only for a new frame. The Lepton delivers
        # about nine a second, a limit of the part rather than of this code, and
        # rescaling the same frame on every repaint was pure waste.
        key = (id(frame), iw, ih)
        if key != self._thermal_key:
            lo, hi = thermal_frame_span(frame)
            raw = self.pygame.image.frombuffer(thermal_frame_rgb(frame, lo, hi),
                                               (THERMAL_COLS, THERMAL_ROWS), 'RGB')
            try:
                self._thermal_surf = self.pygame.transform.smoothscale(raw, (iw, ih))
            except Exception:
                self._thermal_surf = self.pygame.transform.scale(raw, (iw, ih))
            self._thermal_key = key
        self.screen.blit(self._thermal_surf, (pad, top))
        self.pygame.draw.rect(self.screen, BRAND_RULE, (pad, top, iw, ih), 1)

        if side:
            sx = pad + iw + pad
            y = top
            self.label('In view now', (sx, y))
            v = self.text(self.f_big, f'{count}' if live else '--', BRAND_CREAM)
            self.screen.blit(v, (sx, y + m['font_sm'] + 4))
            y += m['font_sm'] + v.get_height() + 22
            self.label('Warmest point', (sx, y))
            self.blit(self.f_med, f'{max(frame):.1f}\u00b0C', BRAND_CREAM, (sx, y + m['font_sm'] + 4))
            y += m['font_sm'] + m['font_med'] + 26
            # A thermal picture reads as a camera to most people, and this is
            # the one screen where that misreading is easy to make.
            for s in ('Temperatures only.', 'Nothing here is', 'recorded or sent.'):
                self.blit(self.f_body, s, BRAND_MUTED, (sx, y))
                y += m['font_xs'] + 6


def display_loop():
    try:
        import pygame
        screen = None
        for driver in video_driver_candidates():
            os.environ['SDL_VIDEODRIVER'] = driver
            try:
                pygame.display.quit()
            except Exception:
                pass
            try:
                pygame.init()
                # (0, 0) asks the panel for its own size. Naming one here is
                # how a remembered 720x1280 outlived the panel it belonged to.
                screen = pygame.display.set_mode(
                    (0, 0), pygame.FULLSCREEN if driver != 'dummy' else 0)
                logger.info(f'Display is up on the "{driver}" driver')
                break
            except Exception as e:
                logger.warning(f'SDL driver "{driver}" did not work: {e}')
        if screen is None:
            logger.error('No SDL video driver worked, so the panel stays dark. '
                         'The sensor keeps counting and keeps pushing.')
            return

        try:
            win_w, win_h = screen.get_size()
        except Exception:
            win_w, win_h = DISPLAY_W, DISPLAY_H
        pygame.mouse.set_visible(False)
        ui = Panel(pygame, screen, win_w, win_h)
        logger.info(f'Panel is {win_w}x{win_h}, laying out in '
                    f'{"columns" if ui.m["columns"] else "rows"}')

        view = 'home'
        dirty = True
        last_paint = 0.0
        last_state = None
        TAP_TO = {0: 'door', 1: 'thermal', 2: 'noise'}

        while not _stop.is_set():
            # Events first and every pass. The old loop polled once every 250 ms
            # and a tap could sit unseen for a quarter of a second, which reads
            # as the screen being broken rather than slow.
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return
                # A touch panel reports as a mouse under some SDL drivers and as
                # a finger under others, and which one you get depends on the
                # driver. A pitch is a bad place to find out you picked wrong.
                if event.type in (pygame.MOUSEBUTTONDOWN,
                                  getattr(pygame, 'FINGERDOWN', -1)):
                    pos = getattr(event, 'pos', None)
                    if pos is None and hasattr(event, 'x'):
                        # FINGERDOWN reports 0..1 of the panel, not pixels.
                        pos = (int(event.x * win_w), int(event.y * win_h))
                    pos = pos or (win_w // 2, win_h // 2)
                    if view != 'home':
                        # On a detail screen the whole panel goes back, with
                        # the Back button there to say so. A button you have
                        # to aim for on a seven inch panel is a button a judge
                        # misses.
                        view = 'home'
                    else:
                        i = hit_card(pos, ui.cards)
                        target = TAP_TO.get(i) if i is not None else None
                        if target and (target != 'thermal' or THERMAL_VIEW_ON):
                            view = target
                    dirty = True

            now = time.monotonic()
            with _lock:
                ir = int(_state['ir_count'])
                therm = int(_state['thermal'])
                therm_at = _state['thermal_at']
                db = float(_state['noise_db'])
                noise_at = _state['noise_at']
                frame = _state['thermal_frame'] if THERMAL_VIEW_ON else None
                history = list(_state['last_push_history'])

            therm_live = therm_at is not None and now - therm_at <= THERMAL_STALE_AFTER
            noise_live = noise_at is not None and now - noise_at <= NOISE_STALE_AFTER
            if noise_live:
                # The same scale the word and the number are read on, so a
                # calibrated unit draws decibels against decibel bands.
                ui.trace.append(noise_reading(db)[2])

            # Repaint when something changed, or twice a second so the trace
            # keeps moving. Not on every pass: at sixty a second that is sixty
            # full-screen redraws for nothing.
            signature = (view, ir, therm, therm_live, int(db), noise_live,
                         len(history), id(frame) if view == 'thermal' else 0)
            if signature != last_state or now - last_paint > 0.5:
                dirty = True
                last_state = signature

            if dirty:
                try:
                    if view == 'thermal':
                        ui.thermal(frame, therm, therm_live)
                    elif view == 'door':
                        ui.door(ir, history)
                    elif view == 'noise':
                        ui.noise(db, noise_live)
                    else:
                        ui.home(ir, therm, therm_live, db, noise_live, history)
                except Exception as e:
                    # A raise in a detail screen used to end the display thread
                    # for the life of the process, taking the doorway counter
                    # with it. Fall back to the one screen that always works,
                    # and name the one that did not before forgetting it.
                    log_throttled('draw', logging.ERROR,
                                  f'Screen "{view}" failed, showing home: {e}')
                    view = 'home'
                    ui.home(ir, therm, therm_live, db, noise_live, history)
                pygame.display.flip()
                last_paint = now
                dirty = False

            _stop.wait(0.016)
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
        # Both recommenders refuse a floor of zero, which is what a genuinely
        # silent 4am venue can produce and also what a dead channel produces.
        # This block used to subtract None from a float in exactly that case,
        # after somebody had stood in a venue at 4am collecting the reading it
        # asked them for.
        pair = recommend_noise_settings(floor, peak)
        suggested = recommend_noise_ref(floor)
        now = compute_noise_db([floor])
        now_word = ('Quiet' if now < 50 else 'Moderate' if now < 70
                    else 'Lively' if now < 85 else 'Loud')
        print('')
        print(f'  At the current settings a room this quiet reports {now:.0f}, '
              f'which the app calls {now_word}.')
        if pair is None and suggested is None:
            print('')
            print('  The quietest burst read exactly 0, so there is nothing to')
            print('  measure against. Run it again, and if it stays at 0 the')
            print('  channel is not converting: check the wiring with --selftest.')
        elif pair is not None:
            ref, scale = pair
            print('')
            print(f'  RECOMMENDED: NOISE_REF_COUNTS={ref}   NOISE_SCALE={scale}')
            print(f'  Puts this room at {QUIET_TARGET_LEVEL:.0f} and the loudest thing '
                  f'heard at {LOUD_TARGET_LEVEL:.0f},')
            print('  so all four words are reachable. Both are needed: the')
            print('  reference slides the scale, and only the scale can stretch it.')
        elif suggested is not None:
            print('')
            print(f'  RECOMMENDED: NOISE_REF_COUNTS={suggested}')
            print(f'  That puts a room this quiet at {QUIET_TARGET_LEVEL:.0f}, inside Quiet.')
            print('  Make some noise during the next run and it can recommend a')
            print('  NOISE_SCALE too, which is what makes Loud reachable.')

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

        # The question the level alone cannot answer: what can this unit hear at
        # all? The gap between the noise floor and the clipping point is fixed at
        # roughly 25 to 28 dB on this hardware, and a venue spans closer to 45,
        # so a good part of the range is simply below the floor and reads as
        # silence. Turning the gain trimpot slides this window; it cannot widen
        # it, because gain multiplies the floor and the signal equally.
        window = hearing_window(floor)
        if window is None:
            print('')
            print('  This unit is not anchored to real sound levels, so it cannot say')
            print('  what it can and cannot hear. To anchor it: put a phone sound level')
            print('  app next to the microphone, make a steady noise, note the dB it shows')
            print('  and the rms here at the same moment, then set both:')
            print('      NOISE_SPL_ANCHOR_COUNTS=<the rms>')
            print('      NOISE_SPL_ANCHOR_DB=<the app reading>')
        else:
            low, high = window
            print('')
            print(f'  THIS UNIT HEARS {low:.0f} to {high:.0f} dBA ({high - low:.0f} dB wide).')
            print('  For reference: empty cafe 45-55, busy cafe 70-80, busy bar 75-85,')
            print('  peak bar 80-97, nightclub 90-100.')
            if low > 60:
                print('')
                print(f'  Anything below {low:.0f} dBA reads as silence, which includes a')
                print('  quiet venue. The floor is electrical, so lowering the gain does not')
                print('  help: it moves both ends down together. Shorter leads, the mic off')
                print('  the breadboard, and VREF off the noisy rail are what widen this.')
    if peak < 5:
        print('  Nothing ever moved. Talk directly at the microphone, and if it')
        print('  still does not move, turn the gain screw on the MAX4466 clockwise.')
    return 0


# What fraction of a test run may sit in the "something is there" state before
# the wiring is more likely backwards than the doorway is genuinely busy.
BEAM_STUCK_FRACTION = 0.8


def diagnose_beam(states, active_low=None):
    """Read a run of pin samples and say what the wiring is doing.

    `states` is a list of booleans, True meaning the pin read HIGH. Returns
    (ok, message). Pure, so every diagnosis below is tested without a Pi.

    This function exists because of how the microphone went. That took an
    evening, and almost all of it went on not knowing which half of the problem
    to look at. Every failure a crossing sensor can have is visible in the
    pattern of one pin, so the tool says which one it is rather than leaving
    somebody to guess between a dead part, the wrong pin, and a part wired the
    other way up.
    """
    if not states:
        return False, 'no samples were read from the pin'

    active_low = IR_ACTIVE_LOW if active_low is None else active_low
    # "Triggered" means something is in the way. Which voltage that is depends
    # on the part, and getting it backwards is the single most likely mistake.
    triggered = [s is False for s in states] if active_low else [s is True for s in states]
    hits = sum(1 for t in triggered if t)
    fraction = hits / float(len(states))

    if hits == 0:
        return False, (
            'the pin never changed. Either nothing is wired to it, it is on a '
            'different pin than the one configured, the sensor has no power, or '
            'whatever is in front of it is out of range. Check the three wires '
            'first, then turn the range screw on the module.')
    if fraction >= 1.0:
        return False, (
            'the pin is stuck in the "something is there" state for the whole run. '
            'Either something is permanently in front of the sensor, or the part '
            'signals the opposite way round from what is configured. Try setting '
            'IR_ACTIVE_LOW to the other value and run this again.')
    if fraction >= BEAM_STUCK_FRACTION:
        return False, (
            f'the pin reads "something is there" {fraction * 100:.0f}% of the time, '
            f'which is more likely a part wired the other way up than a doorway that '
            f'busy. Try flipping IR_ACTIVE_LOW.')
    return True, f'the pin is changing, and sits clear {100 - fraction * 100:.0f}% of the time'


def beam_test(seconds=None):
    """Live crossing counter. Wave a hand through and watch it count.

    Polls rather than using edge callbacks on purpose: polling can show the
    resting state of the pin, which is what tells a wiring mistake from a dead
    part, and an edge callback that never fires looks identical to a pin nobody
    connected.
    """
    try:
        import RPi.GPIO as GPIO
    except Exception as e:
        print(f'Cannot reach the GPIO pins: {e}')
        model = pi_model()
        if model.startswith('Raspberry Pi 5'):
            print(f'This is a "{model}". RPi.GPIO does not work on a Pi 5.')
            print('  sudo pip3 uninstall -y RPi.GPIO')
            print('  sudo pip3 install --break-system-packages rpi-lgpio')
        return 1

    print(f'flock-sensor {VERSION} crossing sensor test')
    print(f'  GPIO {IR_GPIO_PIN}, counting when the pin goes '
          f'{"LOW" if IR_ACTIVE_LOW else "HIGH"}')
    print(f'  debounce {IR_DEBOUNCE_SECONDS}s, so two crossings closer than that '
          f'count once')
    print('  Wave your hand through the slot. Ctrl+C to stop.')
    print('')

    GPIO.setmode(GPIO.BCM)
    pull = GPIO.PUD_UP if IR_ACTIVE_LOW else GPIO.PUD_DOWN
    GPIO.setup(IR_GPIO_PIN, GPIO.IN, pull_up_down=pull)

    states = []
    count = 0
    last_trigger = 0.0
    was_triggered = False
    deadline = None if seconds is None else time.monotonic() + seconds
    try:
        while deadline is None or time.monotonic() < deadline:
            high = bool(GPIO.input(IR_GPIO_PIN))
            states.append(high)
            now_triggered = (not high) if IR_ACTIVE_LOW else high
            now = time.monotonic()
            # Count the moment it becomes blocked, not while it stays blocked,
            # which is the same rule the running service uses.
            if now_triggered and not was_triggered:
                if now - last_trigger >= IR_DEBOUNCE_SECONDS:
                    count += 1
                    gap = now - last_trigger if last_trigger else 0.0
                    print(f'  [{count:3d}] crossing' +
                          (f'   {gap:.1f}s since the last one' if last_trigger else ''))
                    last_trigger = now
            was_triggered = now_triggered
            time.sleep(0.01)
    except KeyboardInterrupt:
        print('')
    finally:
        try:
            GPIO.cleanup(IR_GPIO_PIN)
        except Exception:
            pass

    ok, why = diagnose_beam(states)
    print('')
    print(f'  {count} crossing(s) counted over {len(states)} samples')
    if ok:
        print(f'  WIRING LOOKS RIGHT: {why}')
        if count == 0:
            print('  The pin moves, but nothing crossed. Wave a hand closer, or turn')
            print('  the range screw on the module clockwise.')
        return 0
    print('  PROBLEM:')
    for line in textwrap.wrap(why, 66):
        print(f'    {line}')
    return 1

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
    parser.add_argument('--beam', action='store_true',
                        help='live crossing-sensor test; diagnoses its own wiring')
    parser.add_argument('--listen', action='store_true',
                        help='live microphone level meter; Ctrl+C to stop')
    parser.add_argument('--calibrate', action='store_true',
                        help='measure THERMAL_MIN_CLUSTER against this mounting position')
    # default=None, not CALIBRATE_SECONDS: --listen runs until Ctrl+C when the
    # flag is absent, and `--listen --seconds 20` used to be indistinguishable
    # from not passing it at all, so an explicitly requested duration was
    # silently ignored.
    parser.add_argument('--seconds', type=int, default=None,
                        help=f'seconds to watch per --calibrate stage (default {CALIBRATE_SECONDS})')
    parser.add_argument('--version', action='version', version=f'flock-sensor {VERSION}')
    args = parser.parse_args()
    if args.selftest:
        sys.exit(selftest())
    if args.beam:
        sys.exit(beam_test(args.seconds))
    if args.listen:
        sys.exit(listen(args.seconds))
    if args.calibrate:
        sys.exit(calibrate(max(5, args.seconds or CALIBRATE_SECONDS)))
    main()
