#!/usr/bin/env python3
"""Check the box against the manufacturers' own 3D models.

    python verify_vendor.py --vendor /path/to/vendor

flux_cad.py checks its parts as outlines drawn from datasheets. This places
the makers' STEP files where those outlines are (Raspberry Pi's Pi 5,
Waveshare's 4G HAT, GroupGets' PureThermal 3, Teledyne FLIR's Lepton 3.5 with
its field of view, Pololu's VL53L8CX carrier, and a model of the Active
Cooler) and checks every solid in them against the printed body, both acrylic
pieces, the screen, the battery and each other. It also checks that the
camera's and the counter's views come out of the box without touching it, and
that the boards' own mounting holes land on the posts drawn for them.

The vendor files are not in this repository: most come with no licence to
redistribute. The folder holds the files at the paths listed in VENDOR below.
"""

import argparse
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

VENDOR = {
    'pi5': 'rpi5/rpi-5b_no_graphics.step',
    'hat': 'waveshare-sim7600g-h-4g-hat/SIM7600X-4G-HAT_3d.stp',
    'cooler': 'rpi-active-cooler/RaspberryPi_ActiveCooler_printables858776.step',
    'pt3': 'purethermal3/PT3.step',
    'lepton': 'flir-lepton35/Lepton 3.5, Socket 10502821001, 57 Deg HFOV 9 Hz Export.STEP',
    'tof': 'pololu-3419-vl53l8cx/vl53l8cx-carrier-model.step',
}

PI_PCB_TOP = 1.31        # the Pi 5 file's board top, above its origin
HAT_TOP_IN_PI = None     # set from flux_cad's hat_gap: the HAT file's z = 0 is its board's top


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vendor', required=True, help='folder holding the vendor STEP files')
    args = ap.parse_args()
    root = Path(args.vendor)

    import flux_cad as c
    from build123d import Location, Pos, Rot, import_step, Cone, Compound

    def load(key):
        path = root / VENDOR[key]
        print(f'loading {path.name} ...', flush=True)
        return import_step(str(path))

    # Pi frame (X along the board from the microSD end, Y up from the USB-C
    # edge, Z out of the parts side) to the box: a quarter turn about X, which
    # is a rotation, not a mirror, so the Pi is the board it really is.
    def to_box_from_pi(shape, dz=0.0):
        return Pos(c.PI_X0, c.PI_BACK, c.PI_ZBOT) * Rot(90, 0, 0) * Pos(0, 0, dz) * shape

    placed = {}
    placed['Pi 5 (Raspberry Pi)'] = to_box_from_pi(load('pi5'))
    placed['4G HAT (Waveshare)'] = to_box_from_pi(load('hat'), PI_PCB_TOP + c.hat_gap + 1.6)
    # The community cooler model is Y-up; a quarter turn makes it Z-up, and it
    # sits on the SoC with its push pins in the Pi's two cooler holes.
    cooler = Pos(23.53, 24.41, 13.5) * Rot(90, 0, 0) * load('cooler')
    placed['Active Cooler'] = to_box_from_pi(cooler)

    # PureThermal 3: its origin is its lower left M2 hole, Lepton side +Z, USB
    # down. Seen from the front the Lepton faces you: a quarter turn about X
    # again, its board's Lepton face on PT3_FACE.
    hole0 = (c.EYE[0] - c.pt3_hole_dx / 2, c.PT3_Z0 + c.pt3_h / 2 - c.pt3_hole_dy / 2)
    pt3_face_z = 1.58
    pt3 = load('pt3')
    lepton_all = load('lepton')
    lep_solids = sorted(lepton_all.solids(), key=lambda s: s.volume)
    # The Lepton file carries its field of view as two long cone solids.
    lep_body = [s for s in lep_solids if s.bounding_box().size.Z < 10]
    lep_fov = [s for s in lep_solids if s.bounding_box().size.Z >= 10]
    lepton_on_pt3 = Pos(10.44, 18.78, 4.13)
    def to_box_from_pt3(shape):
        return Pos(hole0[0], c.PT3_FACE + pt3_face_z, hole0[1]) * Rot(90, 0, 0) * shape
    # Its file includes pins in the two rows of breakout holes. Flux uses only
    # the USB-C, so the board goes in without them; they would reach the battery.
    pt3 = Compound([s for s in pt3.solids() if s.bounding_box().min.Z > -3.0])
    placed['PureThermal 3 (GroupGets)'] = to_box_from_pt3(pt3)
    placed['Lepton 3.5 (Teledyne FLIR)'] = to_box_from_pt3(lepton_on_pt3 * Compound(lep_body))
    fov = to_box_from_pt3(lepton_on_pt3 * Compound(lep_fov)) if lep_fov else None

    # Pololu: origin at its corner, sensor side +Z, holes at (10.16, 2.54) and
    # (10.16, 20.32). Laid on its side with the holes' line above the sensor.
    tof = load('tof')
    # Its X goes up the box, its Y right to left, its sensor side to the front:
    # a quarter turn about X, then a quarter turn back about Y.
    placed['VL53L8CX carrier (Pololu)'] = Pos(c.TOF_C[0] + 11.43, c.TOF_FACE + 1.02, c.TOF_C[1] - 6.35) * \
        Rot(0, -90, 0) * Rot(90, 0, 0) * tof

    # The counter's own view: a cone from the sensor's face, 65 degrees across
    # the diagonal, starting as wide as the sensor, 40 mm long, which is well
    # past the front of the box.
    from build123d import Align
    half = math.radians(c.tof_half)
    tof_fov = Pos(c.TOF_C[0], c.TOF_FACE - c.tof_sensor_h, c.TOF_C[1]) * Rot(90, 0, 0) * \
        Cone(2.0, 40 * math.tan(half) + 2.0, 40, align=(Align.CENTER, Align.CENTER, Align.MIN))

    sl = c.sleeve()
    others = {
        'body (printed)': sl, 'sensor pill': c.sensor_pill(), 'wordmark': c.logo_inlay(),
        'back sheet': c.back_sheet(), 'screen': c.screen_body(), 'battery': c.battery_body(),
        'battery plugs': c.battery_plugs(), 'sound meter': c.meter_body(), 'PD board': c.pd_board(),
        'charging port': c.charge_jack(), 'USB port': c.usb_jack(), 'Ethernet port': c.lan_jack(),
        'mount nut': c.mount_nut(), 'light': c.led_body(),
    }
    # What a vendor part is meant to touch: the board it sits on.
    meant = {('Active Cooler', 'Pi 5 (Raspberry Pi)'), ('4G HAT (Waveshare)', 'Pi 5 (Raspberry Pi)'),
             ('Lepton 3.5 (Teledyne FLIR)', 'PureThermal 3 (GroupGets)'),
             ('PureThermal 3 (GroupGets)', 'body (printed)'), ('VL53L8CX carrier (Pololu)', 'body (printed)')}

    def overlap(a, b):
        ba, bb = a.bounding_box(), b.bounding_box()
        if (ba.min.X > bb.max.X or bb.min.X > ba.max.X or ba.min.Y > bb.max.Y or bb.min.Y > ba.max.Y
                or ba.min.Z > bb.max.Z or bb.min.Z > ba.max.Z):
            return 0.0, None
        vol, box = 0.0, None
        for s in a.solids():
            sb = s.bounding_box()
            if (sb.min.X > bb.max.X or bb.min.X > sb.max.X or sb.min.Y > bb.max.Y or bb.min.Y > sb.max.Y
                    or sb.min.Z > bb.max.Z or bb.min.Z > sb.max.Z):
                continue
            common = s & b
            v = sum(x.volume for x in common.solids()) if common else 0.0
            if v > 0.01:
                vol += v
                box = common.bounding_box()
        return vol, box

    problems = 0
    names = list(placed)
    print('\nvendor parts against the box and everything in it:')
    for i, na in enumerate(names):
        for target, shape in list(others.items()) + [(n, placed[n]) for n in names[i + 1:]]:
            if (na, target) in meant or (target, na) in meant:
                continue
            vol, box = overlap(placed[na], shape)
            if vol > 0.01:
                problems += 1
                print(f'  CLASH {na} x {target}: {vol:.2f} mm3 at x {box.min.X:.1f}..{box.max.X:.1f} '
                      f'y {box.min.Y:.1f}..{box.max.Y:.1f} z {box.min.Z:.1f}..{box.max.Z:.1f}')

    print('\nthe views out of the front:')
    for name, cone_shape in (('thermal camera', fov), ('doorway counter', tof_fov)):
        if cone_shape is None:
            print(f'  {name}: no field-of-view solid in its file')
            continue
        for target in ('body (printed)', 'sensor pill'):
            vol, box = overlap(cone_shape, others[target])
            if vol > 0.01:
                problems += 1
                print(f'  BLOCKED {name} by the {target}: {vol:.2f} mm3 at z {box.min.Z:.1f}..{box.max.Z:.1f}')
            else:
                print(f'  {name} clears the {target}')

    print('\nmounting holes on their posts:')
    def hole_centres(shape, dia_lo, dia_hi):
        out = []
        for e in shape.edges():
            if e.geom_type.name == 'CIRCLE' and dia_lo <= 2 * e.radius <= dia_hi:
                out.append(e.arc_center)
        return out
    for name, dia, posts in (
            ('PureThermal 3', (2.1, 2.3), [(c.EYE[0] + sx * c.pt3_hole_dx / 2, c.PT3_Z0 + c.pt3_h / 2 + sz * c.pt3_hole_dy / 2)
                                         for sx in (-1, 1) for sz in (-1, 1)]),
            ('VL53L8CX carrier', (2.1, 2.3), [(c.TOF_C[0] + s * c.tof_hole_dx / 2, c.TOF_C[1] + c.tof_hole_off) for s in (-1, 1)]),
            ('Pi 5', (2.6, 2.8), c.PI_HOLES)):
        shape = placed['PureThermal 3 (GroupGets)' if name == 'PureThermal 3' else
                       'VL53L8CX carrier (Pololu)' if name == 'VL53L8CX carrier' else 'Pi 5 (Raspberry Pi)']
        centres = hole_centres(shape, *dia)
        worst = 0.0
        for px, pz in posts:
            near = min((math.hypot(v.X - px, v.Z - pz) for v in centres), default=99.0)
            worst = max(worst, near)
        ok = worst < 0.35
        problems += 0 if ok else 1
        print(f'  {name}: {len(posts)} holes, furthest from its post {worst:.2f} mm {"ok" if ok else "OFF"}')

    print(f'\n{problems} problem(s)')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
