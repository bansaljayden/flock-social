#!/usr/bin/env python3
"""Export every part of the enclosure from flux_cad.py.

    python export.py                # needs build123d (see README, Exporting)
    python export.py --no-preview   # skip the pictures

Writes step/ (the solid model: the whole box as an assembly, and each made
part), stl/ (the 3D printed parts), svg/ and dxf/ (the laser-cut sheets) and
preview/ (the pictures in the README), and checks as it goes that every part
is one valid solid and that nothing inside the box collides. The files it
writes are committed, so nobody needs build123d to build the box.

The SVGs follow the convention school laser software expects: a red hairline
is a cut and a black fill is an engraving, at the sheet's exact size in
millimetres. Text and curves are written as fine straight segments, so every
program reads them the same way.

This module imports build123d only inside main(), so the tests can read its
lists and helpers without it.
"""

import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (part name in flux_cad, output name). Every printed part, in the order to print them.
PRINTED = [
    ('screen_fit_test', 'flux-1-screen_fit_test'),
    ('strip_fit_test', 'flux-2-strip_fit_test'),
    ('sleeve', 'flux-3-sleeve'),
    ('pi_spacer', 'flux-4-pi_spacer'),
    ('sensor_pill', 'flux-5-sensor_pill'),
    ('logo_inlay', 'flux-6-logo_inlay'),
]

# (sheet, cut sketch, engraving sketch). Every laser-cut sheet.
PANELS = [
    ('front', 'front_cut_sketch', 'front_engrave_sketch'),
    ('back', 'back_cut_sketch', 'back_engrave_sketch'),
]

TITLES = {
    'front': 'sensor pill, if cut from navy acrylic rather than printed, seen from the front',
    'back': 'back sheet, seen from behind',
}

# A fixed timestamp, so an unchanged model writes an unchanged STEP file.
STEP_STAMP = datetime.datetime(2026, 10, 7, 0, 0, 0)

FACET = re.compile(
    r'facet normal\s+(\S+)\s+(\S+)\s+(\S+)\s+outer loop\s+'
    r'vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+'
    r'vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+endloop\s+endfacet')


def canonical_stl(path):
    """Rewrite an ASCII STL with its triangles in one fixed order.

    A mesher can write the same solid with its triangles in a different order
    on different runs, and then a real change cannot be told from a reshuffle.
    Each triangle is rotated to start at its smallest corner, which keeps its
    winding and so which way it faces, and the triangles are then sorted.
    Coordinates are rounded to a micrometre. Same solid, same bytes.
    """
    facets = []
    for f in FACET.findall(path.read_text()):
        normal = tuple(f'{float(v):.6f}' for v in f[0:3])
        corners = [tuple(f'{float(v):.4f}' for v in f[i:i + 3]) for i in (3, 6, 9)]
        key = [tuple(float(c) for c in v) for v in corners]
        start = key.index(min(key))
        corners = corners[start:] + corners[:start]
        key = key[start:] + key[:start]
        facets.append((key, normal, corners))
    facets.sort(key=lambda item: item[0])
    lines = ['solid flux']
    for _, normal, corners in facets:
        lines.append(f'  facet normal {" ".join(normal)}')
        lines.append('    outer loop')
        lines.extend(f'      vertex {" ".join(v)}' for v in corners)
        lines.append('    endloop')
        lines.append('  endfacet')
    lines.append('endsolid flux')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    return len(facets)


def fmt(v):
    s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def wire_path(wire, step=0.05):
    """One closed wire as SVG path data: straight edges exactly, curves as fine
    segments. y is flipped, since an SVG's y runs down the page."""
    pts = []
    for edge in wire.order_edges():
        if edge.geom_type.name == 'LINE':
            seg = [edge.position_at(0), edge.position_at(1)]
        else:
            n = max(8, int(edge.length / step))
            seg = [edge.position_at(i / n) for i in range(n + 1)]
        if pts and (seg[0] - pts[-1]).length > 1e-3 and (seg[-1] - pts[-1]).length < 1e-3:
            seg = seg[::-1]
        pts.extend(seg if not pts else seg[1:])
    d = f'M{fmt(pts[0].X)} {fmt(-pts[0].Y)}'
    d += ''.join(f'L{fmt(p.X)} {fmt(-p.Y)}' for p in pts[1:])
    return d + 'Z'


def sketch_path(sketch):
    return ''.join(wire_path(w) for face in sketch.faces() for w in [face.outer_wire()] + list(face.inner_wires()))


def laser_svg(cut, engrave, title):
    bb = cut.bounding_box()
    x0, y0, w, h = bb.min.X, -bb.max.Y, bb.max.X - bb.min.X, bb.max.Y - bb.min.Y
    parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(w)}mm" height="{fmt(h)}mm" '
        f'viewBox="{fmt(x0)} {fmt(y0)} {fmt(w)} {fmt(h)}">',
        f'<title>Flux, {title}. Red hairline: cut. Black: engrave. Millimetres.</title>',
    ]
    if engrave is not None:
        parts.append(f'<path d="{sketch_path(engrave)}" fill="#000000" stroke="none" fill-rule="evenodd"/>')
    parts.append(f'<path d="{sketch_path(cut)}" fill="none" stroke="#FF0000" stroke-width="0.025"/>')
    parts.append('</svg>')
    return '\n'.join(parts) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--no-preview', action='store_true', help='skip the pictures')
    args = ap.parse_args()

    sys.path.insert(0, str(HERE))
    import flux_cad as cad
    from build123d import ExportDXF, export_step, export_stl, export_gltf
    from build123d.exporters import ColorIndex

    for folder in ('step', 'stl', 'dxf', 'svg', 'preview'):
        (HERE / folder).mkdir(exist_ok=True)

    print(f'box {cad.BOX_W:.1f} x {cad.BOX_H:.1f} x {cad.BOX_D:.1f} mm')
    sleeve = cad.sleeve()
    front, back = cad.sensor_pill(), cad.back_sheet()
    made = {
        'sleeve': sleeve,
        'screen_fit_test': cad.screen_fit_test(),
        'strip_fit_test': cad.strip_fit_test(sleeve),
        'pi_spacer': cad.pi_spacer_part(),
        # Both print face down, the face that shows on the bed.
        'sensor_pill': cad.Rot(90, 0, 0) * front,
        'logo_inlay': cad.Rot(90, 0, 0) * cad.logo_inlay(),
    }
    # The wordmark is one solid per letter; everything else must be one piece.
    pieces = {'logo_inlay': len(cad.wordmark)}
    for name, part in list(made.items()) + [('sensor pill', front), ('back sheet', back)]:
        if len(part.solids()) != pieces.get(name, 1) or not part.is_valid:
            sys.exit(f'{name} is not {pieces.get(name, 1)} valid solid(s) ({len(part.solids())} solids)')

    found = cad.clash_report(sleeve, front, back)
    if found:
        for a, b, vol, bb in found:
            print(f'  CLASH {a} x {b}: {vol:.2f} mm3 at x {bb.min.X:.1f}..{bb.max.X:.1f} '
                  f'y {bb.min.Y:.1f}..{bb.max.Y:.1f} z {bb.min.Z:.1f}..{bb.max.Z:.1f}')
        sys.exit(f'{len(found)} pair(s) collide inside the box')
    print('clash check: nothing overlaps')

    for name, out in PRINTED:
        path = HERE / 'stl' / f'{out}.stl'
        export_stl(made[name], path, tolerance=0.01, angular_tolerance=0.1, ascii_format=True)
        print(f'stl/{out}.stl  {canonical_stl(path)} triangles')

    for sheet, cut_name, engrave_name in PANELS:
        cut, engrave = getattr(cad, cut_name)(), getattr(cad, engrave_name)()
        (HERE / 'svg' / f'flux-{sheet}.svg').write_text(
            laser_svg(cut, engrave, TITLES[sheet]), encoding='utf-8', newline='\n')
        dxf = ExportDXF()
        dxf.add_layer('CUT', color=ColorIndex.RED)
        dxf.add_layer('ENGRAVE', color=ColorIndex.BLACK)
        dxf.add_shape(cut, layer='CUT')
        if engrave is not None:
            dxf.add_shape(engrave, layer='ENGRAVE')
        dxf.write(HERE / 'dxf' / f'flux-{sheet}.dxf')
        print(f'svg/flux-{sheet}.svg  dxf/flux-{sheet}.dxf')

    # Each made part on its own first: once a part is inside the assembly it
    # belongs to it, and OpenCascade will not write it out alone.
    for name, part in (('sleeve', sleeve), ('sensor-pill', front), ('back-sheet', back)):
        export_step(part, HERE / 'step' / f'flux-{name}.step', timestamp=STEP_STAMP)
    whole = cad.assembly(sleeve, front, back)
    export_step(whole, HERE / 'step' / 'flux-assembly.step', timestamp=STEP_STAMP)
    print('step/flux-assembly.step and each made part')
    export_gltf(whole, HERE / 'preview' / 'flux-assembly.glb', binary=True,
                linear_deflection=0.05, angular_deflection=0.2)
    print('preview/flux-assembly.glb')

    # The viewer states the box's size; keep it the model's.
    viewer = HERE / 'viewer' / 'index.html'
    size = f'{cad.BOX_W:g} &times; {cad.BOX_H:g} &times; {cad.BOX_D:g} mm'
    page = re.sub(r'<p class="dims">[^<]*</p>', f'<p class="dims">{size}, one box</p>', viewer.read_text(encoding='utf-8'))
    page = re.sub(r'const BOX = \{[^}]*\};', f'const BOX = {{ w: {cad.BOX_W:g}, h: {cad.BOX_H:g}, d: {cad.BOX_D:g} }};', page)
    viewer.write_text(page, encoding='utf-8', newline='\n')

    if not args.no_preview:
        r = subprocess.run(['node', str(HERE / 'viewer' / 'render.cjs')], cwd=HERE)
        if r.returncode:
            sys.exit('the pictures failed; see above')


if __name__ == '__main__':
    main()
