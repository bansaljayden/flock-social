#!/usr/bin/env python3
"""
Flock venue sensor — runs on a Raspberry Pi at a venue entrance.

Reads three signals every push interval and POSTs to the backend:
  - IR break-beam count (cumulative since last push) — counts entries
  - Thermal headcount (snapshot) — heat-cluster count from MLX90640
  - Ambient noise dB (rolling 30s avg) — RMS from MAX4466 mic via MCP3008

Resilient by design: any sensor that fails to initialize is treated as
"reports zero" instead of crashing. The script keeps the device "alive"
on the backend (via last_seen_at) even if every sensor is broken.
"""

import json
import logging
import math
import os
import signal
import sys
import threading
import time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_PATH = Path(os.environ.get('FLOCK_CONFIG', '/home/pi/flock_sensor.env'))
LOG_PATH = Path(os.environ.get('FLOCK_LOG', '/home/pi/flock_sensor.log'))
BUFFER_PATH = Path(os.environ.get('FLOCK_BUFFER', '/home/pi/flock_buffer.json'))


def load_config():
    cfg = {
        'FLOCK_API_KEY': '',
        'FLOCK_API_URL': 'https://flock-app-production.up.railway.app/api/sensors/data',
        'SENSOR_DEVICE_ID': 'sensor_unknown',
        'PUSH_INTERVAL_SECONDS': '30',
        'DISPLAY_ENABLED': 'auto',
    }
    try:
        if CONFIG_PATH.exists():
            for line in CONFIG_PATH.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip()
    except Exception as e:
        print(f'Failed to read config {CONFIG_PATH}: {e}', file=sys.stderr)
    # Env vars override file (useful for systemd)
    for k in cfg:
        if k in os.environ and os.environ[k]:
            cfg[k] = os.environ[k]
    return cfg


CONFIG = load_config()
PUSH_INTERVAL = max(5, int(CONFIG.get('PUSH_INTERVAL_SECONDS', '30')))


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger('flock_sensor')
logger.setLevel(logging.INFO)
try:
    handler = RotatingFileHandler(str(LOG_PATH), maxBytes=10 * 1024 * 1024, backupCount=3)
except Exception:
    handler = logging.StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))
logger.addHandler(handler)


# ---------------------------------------------------------------------------
# Display detection
# ---------------------------------------------------------------------------

def display_should_run():
    raw = (CONFIG.get('DISPLAY_ENABLED') or 'auto').lower()
    if raw == 'true':
        return True
    if raw == 'false':
        return False
    return os.path.exists('/dev/fb0') or os.path.exists('/dev/fb1')


DISPLAY_ON = display_should_run()


# ---------------------------------------------------------------------------
# Shared state (thread-safe via _lock)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_state = {
    'ir_count': 0,                 # Cumulative since last push
    'thermal': 0,                  # Latest snapshot
    'noise_db': 0.0,               # Rolling 30s average
    'noise_window': deque(maxlen=6),  # 6 samples × 5s = 30s
    'last_push_history': deque(maxlen=12),  # For optional display chart
}


# ---------------------------------------------------------------------------
# IR break-beam (GPIO 17, falling edge, 500ms debounce)
# ---------------------------------------------------------------------------

def init_ir():
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(17, GPIO.IN, pull_up_down=GPIO.PUD_UP)

        last_trigger = [0.0]

        def on_break(channel):
            now = time.time()
            if now - last_trigger[0] < 0.5:
                return
            last_trigger[0] = now
            with _lock:
                _state['ir_count'] += 1

        GPIO.add_event_detect(17, GPIO.FALLING, callback=on_break, bouncetime=200)
        logger.info('IR break-beam initialized on GPIO 17')
        return True
    except Exception as e:
        logger.error(f'IR init failed (sensor will report 0): {e}')
        return False


# ---------------------------------------------------------------------------
# Thermal — MLX90640 over I2C
# Connected-component labeling on a 24x32 grid, 4-connectivity.
# Cluster ≥ 4 hot pixels (>28°C) = one person.
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
        logger.error(f'MLX90640 init failed (sensor will report 0): {e}')
        _thermal_sensor = None
        return False


def count_thermal_clusters(frame_768, threshold_c=28.0, min_cluster=4):
    """Flood-fill on a 24x32 grid (4-connectivity). Returns cluster count."""
    rows, cols = 24, 32
    grid = [[frame_768[r * cols + c] >= threshold_c for c in range(cols)] for r in range(rows)]
    visited = [[False] * cols for _ in range(rows)]
    count = 0
    for r0 in range(rows):
        for c0 in range(cols):
            if not grid[r0][c0] or visited[r0][c0]:
                continue
            # BFS
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
    return count


def thermal_loop():
    if _thermal_sensor is None:
        return
    frame = [0.0] * 768
    while True:
        try:
            _thermal_sensor.getFrame(frame)
            n = count_thermal_clusters(frame)
            with _lock:
                _state['thermal'] = n
        except Exception as e:
            logger.warning(f'Thermal read error: {e}')
        time.sleep(2)


# ---------------------------------------------------------------------------
# Noise — MAX4466 mic via MCP3008 ADC channel 0 over SPI
# 1 kHz × 100ms RMS → dB. Sample every 5s, rolling-avg over last 6 readings.
# ---------------------------------------------------------------------------

_spi = None
NOISE_REF = 1.0  # ADC counts at "0 dB" — calibrate per deployment


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
        logger.error(f'MCP3008 init failed (sensor will report 0): {e}')
        _spi = None
        return False


def _read_mcp3008_ch0():
    # Returns 10-bit value 0..1023
    resp = _spi.xfer2([1, (8 + 0) << 4, 0])
    return ((resp[1] & 3) << 8) + resp[2]


def noise_loop():
    if _spi is None:
        return
    while True:
        try:
            samples = []
            t_end = time.time() + 0.1
            # Aim for ~1 kHz over 100ms
            while time.time() < t_end:
                samples.append(_read_mcp3008_ch0() - 512)  # center around 0
                time.sleep(0.001)
            if samples:
                rms = math.sqrt(sum(s * s for s in samples) / len(samples))
                db = 20 * math.log10(max(rms, 1e-6) / NOISE_REF) if NOISE_REF > 0 else 0.0
                # Clamp into a reasonable bracket
                db = max(0.0, min(140.0, db + 50.0))  # +50 offset so quiet rooms aren't negative
                with _lock:
                    _state['noise_window'].append(db)
                    if _state['noise_window']:
                        _state['noise_db'] = sum(_state['noise_window']) / len(_state['noise_window'])
        except Exception as e:
            logger.warning(f'Noise read error: {e}')
        time.sleep(5)


# ---------------------------------------------------------------------------
# Push to backend (with offline buffering)
# ---------------------------------------------------------------------------

def _read_buffer():
    try:
        if BUFFER_PATH.exists():
            return json.loads(BUFFER_PATH.read_text())
    except Exception:
        pass
    return []


def _write_buffer(items):
    try:
        BUFFER_PATH.write_text(json.dumps(items))
    except Exception as e:
        logger.warning(f'Failed to write buffer: {e}')


def _post(payload):
    try:
        r = requests.post(
            CONFIG['FLOCK_API_URL'],
            json=payload,
            headers={
                'Content-Type': 'application/json',
                'x-api-key': CONFIG['FLOCK_API_KEY'],
            },
            timeout=15,
        )
        return r.status_code, r.text
    except Exception as e:
        return 0, str(e)


def push_loop():
    while True:
        time.sleep(PUSH_INTERVAL)
        with _lock:
            payload = {
                'ir_beam_count': int(_state['ir_count']),
                'thermal_headcount': int(_state['thermal']),
                'noise_db': round(float(_state['noise_db']), 2),
            }
        # Try to flush any buffered payloads first
        buf = _read_buffer()
        if buf:
            new_buf = []
            for old in buf:
                code, _ = _post(old)
                if code != 201:
                    new_buf.append(old)
            _write_buffer(new_buf)
            if not new_buf and len(buf) > 0:
                logger.info(f'Flushed {len(buf)} buffered payloads')
        # Send the current snapshot
        code, body = _post(payload)
        if code == 201:
            with _lock:
                _state['ir_count'] = 0
                _state['last_push_history'].append(payload['thermal_headcount'])
            logger.info(f"PUSH ok ir={payload['ir_beam_count']} thermal={payload['thermal_headcount']} db={payload['noise_db']}")
        else:
            logger.error(f'PUSH failed status={code} body={body[:200]}')
            # Buffer current payload for later retry
            buf = _read_buffer()
            buf.append(payload)
            # Cap buffer at 200 entries (~1.5 hours @30s) so we don't fill the disk
            if len(buf) > 200:
                buf = buf[-200:]
            _write_buffer(buf)


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

        while True:
            with _lock:
                ir = int(_state['ir_count'])
                therm = int(_state['thermal'])
                db = float(_state['noise_db'])
                history = list(_state['last_push_history'])

            screen.fill(NAVY)
            # Top bar
            top = pygame.Surface((800, 50)); top.fill((20, 28, 40)); screen.blit(top, (0, 0))
            screen.blit(font_sm.render('FLOCK VENUE SENSOR', True, CREAM), (20, 14))

            # 3 columns
            col_w = 800 // 3
            # Entered Today (cumulative since last push)
            screen.blit(font_sm.render('Entered Today', True, (160, 170, 180)), (20, 80))
            screen.blit(font_big.render(str(ir), True, CREAM), (20, 120))
            # Currently Here
            screen.blit(font_sm.render('Currently Here', True, (160, 170, 180)), (col_w + 20, 80))
            screen.blit(font_big.render(f'~{therm}', True, CREAM), (col_w + 20, 120))
            # Noise
            screen.blit(font_sm.render('Noise', True, (160, 170, 180)), (col_w * 2 + 20, 80))
            label = 'Quiet' if db < 50 else 'Moderate' if db < 70 else 'Lively' if db < 85 else 'Loud'
            color = GREEN if db < 50 else AMBER if db < 70 else ORANGE if db < 85 else RED
            screen.blit(font_med.render(label, True, color), (col_w * 2 + 20, 120))
            screen.blit(font_sm.render(f'{int(db)} dB', True, (160, 170, 180)), (col_w * 2 + 20, 175))

            # Bottom bar chart of last 12 pushes
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
            time.sleep(2)
    except Exception as e:
        logger.error(f'Display loop crashed (continuing headless): {e}')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    logger.info('=== Flock sensor starting ===')
    logger.info(f"Device ID: {CONFIG['SENSOR_DEVICE_ID']}")
    logger.info(f"API URL: {CONFIG['FLOCK_API_URL']}")
    logger.info(f'Push interval: {PUSH_INTERVAL}s')
    logger.info(f'Display: {"on" if DISPLAY_ON else "headless"}')

    if not CONFIG.get('FLOCK_API_KEY'):
        logger.error('FLOCK_API_KEY is empty — backend will reject all pushes (continuing anyway)')

    ir_ok = init_ir()
    thermal_ok = init_thermal()
    noise_ok = init_noise()
    logger.info(f'Init summary: IR={ir_ok} thermal={thermal_ok} noise={noise_ok}')

    threads = []
    if thermal_ok:
        t = threading.Thread(target=thermal_loop, daemon=True); t.start(); threads.append(t)
    if noise_ok:
        t = threading.Thread(target=noise_loop, daemon=True); t.start(); threads.append(t)
    push_thread = threading.Thread(target=push_loop, daemon=True); push_thread.start()
    threads.append(push_thread)

    # Graceful shutdown
    def shutdown(*_):
        logger.info('Received shutdown signal, exiting')
        try:
            import RPi.GPIO as GPIO
            GPIO.cleanup()
        except Exception:
            pass
        sys.exit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    if DISPLAY_ON:
        # Display loop blocks the main thread (pygame needs the main thread on some setups)
        display_loop()
    else:
        # Headless: keep main thread alive
        while True:
            time.sleep(60)


if __name__ == '__main__':
    main()
