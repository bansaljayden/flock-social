#!/usr/bin/env python3
"""Record thermal frames to teach the sensor what a person looks like.

    sudo systemctl stop flock-sensor
    python3 record.py --room kitchen --consent --note "two people, a mug"
    sudo systemctl start flock-sensor

A development tool, for places you control and people who have agreed. It is
deliberately not part of the sensor: setup.sh does not install it, so a venue
unit never has it, and main.py itself keeps no frame. Everything this writes is
a thermal image of whoever is in view, so it asks for --consent every time.

Frames go to ~/flux-training/<room>/, one file per session. Copy them to the
PC for labelling and training, then delete them from the Pi.
"""

import argparse
import datetime
import getpass
import json
import re
import socket
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from frames import FORMAT, VERSION, encode_frame  # noqa: E402

CONSENT = """\
This records thermal images of everyone in front of the camera.

Only record:
  - in a place you control, never at a venue;
  - people who have signed the consent sheet (a parent signs for anyone under 18);
  - with nothing private in view: no bedrooms or bathrooms while in use.

Then run it again with --consent.
"""


def slug(text):
    """A room name safe to use as a folder name."""
    s = re.sub(r'[^a-z0-9]+', '-', text.strip().lower()).strip('-')
    return s or 'room'


def parse_args(argv):
    ap = argparse.ArgumentParser(description='Record thermal frames for training.')
    ap.add_argument('--room', required=True,
                    help='where this is: kitchen, living-room, garage. Each room is '
                         'kept apart so the model can be tested on one it never saw.')
    ap.add_argument('--consent', action='store_true',
                    help='everyone in view has signed the consent sheet, and this is not a venue')
    ap.add_argument('--minutes', type=float, default=5.0, help='how long to record (5)')
    ap.add_argument('--every', type=float, default=1.0,
                    help='seconds between frames (1). Frames closer together are near copies.')
    ap.add_argument('--note', default='', help='what is in view, for your own records')
    ap.add_argument('--out', default=str(Path.home() / 'flux-training'),
                    help='where to write (~/flux-training)')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.consent:
        print(CONSENT)
        return 2

    import main as sensor  # the sensor's own camera code and counter

    room = slug(args.room)
    folder = Path(args.out).expanduser() / room
    folder.mkdir(parents=True, exist_ok=True)
    session = datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + room
    path = folder / f'{session}.frames'

    camera = sensor.ThermalCamera(sensor.THERMAL_DEVICE)
    try:
        camera.open()
    except Exception as e:
        print(f'Cannot open the thermal camera on {sensor.THERMAL_DEVICE}: {e}')
        print('If the sensor service is running it holds the camera:')
        print('  sudo systemctl stop flock-sensor')
        return 1

    header = {
        'format': FORMAT, 'version': VERSION, 'session': session, 'room': room,
        'note': args.note, 'started': datetime.datetime.now().astimezone().isoformat(),
        'device': socket.gethostname(), 'cols': camera.cols, 'rows': camera.rows,
        'every_seconds': args.every, 'recorder': 'flock-sensor/training/record.py',
    }
    print(f'Recording {args.minutes:g} minutes in "{room}" to {path}')
    print('Ctrl+C stops early. Move around: near, far, sitting, standing, in')
    print('pairs, and bring the things that fool it today (a hand close up, a')
    print('mug, a laptop). Some frames with nobody in them matter too.')
    print('')
    count = 0
    started = time.monotonic()
    deadline = started + args.minutes * 60
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(header) + '\n')
        try:
            while time.monotonic() < deadline:
                tick = time.monotonic()
                frame = camera.read_frame()
                if frame is None or not sensor.is_plausible_frame(frame):
                    print('  (no usable frame)')
                    continue
                f.write(json.dumps({'t': round(tick - started, 2),
                                    'c': encode_frame(frame)}) + '\n')
                f.flush()
                count += 1
                print(f'  {count:4d}  {tick - started:6.1f}s   counter says '
                      f'{sensor.count_thermal_clusters(frame)}   room '
                      f'{sensor._median(frame):4.1f}C   warmest {max(frame):4.1f}C')
                wait = args.every - (time.monotonic() - tick)
                if wait > 0:
                    time.sleep(wait)
        except KeyboardInterrupt:
            print('')
        finally:
            camera.close()
    print(f'{count} frames saved to {path}')
    if count:
        print('Copy them to the PC, from a terminal on the PC:')
        print(f'  scp -r {getpass.getuser()}@{socket.gethostname()}:~/flux-training .')
    return 0


if __name__ == '__main__':
    sys.exit(main())
