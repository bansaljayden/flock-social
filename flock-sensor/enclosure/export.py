#!/usr/bin/env python3
"""Export every part of the enclosure from the two .scad files.

    python3 export.py                     # OpenSCAD found on PATH or in $OPENSCAD
    python3 export.py --openscad /path/to/openscad

Writes stl/ (3D printed parts), dxf/ and svg/ (laser-cut panels) and
preview/ (renders for the README), and checks as it goes that every solid is
one closed piece and that nothing inside the base collides. Standard library
only. The files it writes are committed, so nobody needs OpenSCAD to build
the box; this is for whoever changes a number in a .scad file.

The SVGs follow the convention school laser software expects: a red hairline
is a cut and a black fill is an engraving, at the panel's exact size in
millimetres. OpenSCAD writes neither colours nor exact sizes (it rounds the
page to whole millimetres), so each SVG is rebuilt from OpenSCAD's own path
data rather than used as it comes out.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = HERE / 'flux-enclosure.scad'
HEAD = HERE / 'flux-sensor-head.scad'

# (file, part, output name). Every printed part, both files.
PRINTED = [
    (BASE, 'screen_fit_test', 'base-screen_fit_test'),
    (BASE, 'corner_block', 'base-corner_block'),
    (BASE, 'screen_spacer', 'base-screen_spacer'),
    (BASE, 'pi_spacer', 'base-pi_spacer'),
    (BASE, 'battery_tray', 'base-battery_tray'),
    (BASE, 'cable_grommet', 'base-cable_grommet'),
    (HEAD, 'head_fit_test', 'head-head_fit_test'),
    (HEAD, 'shell', 'head-shell'),
    (HEAD, 'back_plate', 'head-back_plate'),
    (HEAD, 'lens_ring', 'head-lens_ring'),
]

# (part, engraving part or None). Every laser-cut panel of the base.
PANELS = [
    ('front', 'front_engrave'),
    ('back', None),
    ('top', None),
    ('bottom', None),
    ('side', None),
]

TITLES = {
    'front': 'front panel',
    'back': 'back panel, seen from behind',
    'top': 'top panel',
    'bottom': 'bottom panel, seen from below',
    'side': 'side panel, cut two',
}


def find_openscad(given):
    for candidate in (given, os.environ.get('OPENSCAD'), shutil.which('openscad'),
                      shutil.which('openscad.com')):
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit('OpenSCAD not found. Pass --openscad /path/to/openscad or set $OPENSCAD.')


def run(openscad, scad, out, part, *extra, empty_is_pass=False):
    cmd = [openscad, '-o', str(out), '-D', f'part="{part}"', *extra, str(scad)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    log = result.stdout + result.stderr
    # OpenSCAD exits non-zero when there is nothing to write, which for the
    # clash check is the answer wanted.
    empty = 'Current top level object is empty' in log
    if 'ERROR' in log or (result.returncode != 0 and not (empty and empty_is_pass)):
        sys.exit(f'{scad.name} part={part} failed:\n{log}')
    return log


def solid_check(log, name):
    """One closed piece: CGAL counts the outside as a volume, so a single
    solid reports two."""
    simple = re.search(r'Simple:\s+(\w+)', log)
    volumes = re.search(r'Volumes:\s+(\d+)', log)
    if not simple or simple.group(1) != 'yes' or not volumes or volumes.group(1) != '2':
        sys.exit(f'{name} is not one closed solid:\n{log}')


def path_data(svg_text):
    m = re.search(r'<path d="([^"]+)"', svg_text)
    return m.group(1).strip() if m else ''


def extents(d):
    nums = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?(?:e-?\d+)?', d)]
    xs, ys = nums[0::2], nums[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def laser_svg(cut_d, engrave_d, title):
    x0, y0, x1, y1 = extents(cut_d)
    w, h = x1 - x0, y1 - y0
    fmt = lambda v: f'{v:.3f}'.rstrip('0').rstrip('.')
    parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(w)}mm" height="{fmt(h)}mm" '
        f'viewBox="{fmt(x0)} {fmt(y0)} {fmt(w)} {fmt(h)}">',
        f'<title>Flux base, {title}. Red hairline: cut. Black: engrave. Millimetres.</title>',
    ]
    if engrave_d:
        parts.append(f'<path d="{engrave_d}" fill="#000000" stroke="none"/>')
    parts.append(f'<path d="{cut_d}" fill="none" stroke="#FF0000" stroke-width="0.025"/>')
    parts.append('</svg>')
    return '\n'.join(parts) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--openscad')
    ap.add_argument('--no-preview', action='store_true', help='skip the PNG renders')
    args = ap.parse_args()
    openscad = find_openscad(args.openscad)

    for folder in ('stl', 'dxf', 'svg', 'preview'):
        (HERE / folder).mkdir(exist_ok=True)

    for scad, part, name in PRINTED:
        log = run(openscad, scad, HERE / 'stl' / f'{name}.stl', part)
        solid_check(log, name)
        print(f'stl/{name}.stl')

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for part, engrave in PANELS:
            log = run(openscad, BASE, tmp / f'{part}.stl', part)
            solid_check(log, part)
            run(openscad, BASE, HERE / 'dxf' / f'base-{part}.dxf', part, '-D', 'flat=true')
            run(openscad, BASE, tmp / f'{part}.svg', part, '-D', 'flat=true')
            cut_d = path_data((tmp / f'{part}.svg').read_text())
            engrave_d = ''
            if engrave:
                run(openscad, BASE, tmp / f'{engrave}.svg', engrave)
                engrave_d = path_data((tmp / f'{engrave}.svg').read_text())
            (HERE / 'svg' / f'base-{part}.svg').write_text(
                laser_svg(cut_d, engrave_d, TITLES[part]), encoding='utf-8', newline='\n')
            print(f'dxf/base-{part}.dxf  svg/base-{part}.svg')

        # Nothing inside the base may overlap: an empty result is the pass.
        log = run(openscad, BASE, tmp / 'clash.stl', 'clash', empty_is_pass=True)
        if 'Current top level object is empty' not in log:
            sys.exit(f'Parts collide inside the base:\n{log}')
        print('clash check: nothing overlaps')

    if not args.no_preview:
        views = [
            ('base-assembled', 'assembled', '-160,-330,260,114,44,89'),
            ('base-inside', 'inside', '-150,-260,330,114,44,80'),
            ('base-front', 'front_face', '114,-420,89,114,0,89'),
            ('head-assembled', None, None),
        ]
        for name, part, camera in views:
            if part is None:
                run(openscad, HEAD, HERE / 'preview' / f'{name}.png', 'assembled',
                    '--imgsize=1200,1000', '--viewall', '--autocenter', '--colorscheme=Tomorrow')
            else:
                run(openscad, BASE, HERE / 'preview' / f'{name}.png', part,
                    '--imgsize=1400,1000', f'--camera={camera}', '--projection=p',
                    '--colorscheme=Tomorrow')
            print(f'preview/{name}.png')


if __name__ == '__main__':
    main()
