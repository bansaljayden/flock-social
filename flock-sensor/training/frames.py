"""Thermal training frames on disk: one session per file, one frame per line.

A session file is JSON lines. The first line describes the session: the room,
when, the camera's size and why it was recorded. Every line after it is one
frame: its temperatures as hundredths of a degree Celsius, 16-bit little-endian,
zlib-compressed and base64-encoded, with the seconds since the session began.

Standard library only, so the recorder runs on the Pi with nothing installed,
and the trainer on the PC reads the same files with the same code.
"""

import array
import base64
import json
import sys
import zlib

FORMAT = 'flux-thermal-frames'
VERSION = 1


def encode_frame(celsius):
    """One frame of temperatures, as the text stored for it."""
    a = array.array('h', (max(-32768, min(32767, int(round(t * 100)))) for t in celsius))
    if sys.byteorder != 'little':
        a.byteswap()
    return base64.b64encode(zlib.compress(a.tobytes(), 6)).decode('ascii')


def decode_frame(text):
    """The temperatures back, in degrees Celsius, to the hundredth."""
    a = array.array('h')
    a.frombytes(zlib.decompress(base64.b64decode(text)))
    if sys.byteorder != 'little':
        a.byteswap()
    return [v / 100.0 for v in a]


def read_session(path):
    """(header, [(seconds, celsius), ...]) from one session file."""
    with open(path, encoding='utf-8') as f:
        header = json.loads(f.readline())
        if header.get('format') != FORMAT:
            raise ValueError(f'{path} is not a {FORMAT} file')
        if header.get('version') != VERSION:
            raise ValueError(f'{path} is version {header.get("version")}, expected {VERSION}')
        frames = []
        for line in f:
            line = line.strip()
            if line:
                record = json.loads(line)
                frames.append((record['t'], decode_frame(record['c'])))
    return header, frames
