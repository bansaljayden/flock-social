#!/usr/bin/env python3
"""Flux, one box: the enclosure as a solid model.

    python flux_cad.py            # every file in step/, stl/, svg/, dxf/
    python flux_cad.py --check    # only the clash check

Built with build123d on OpenCascade, the kernel FreeCAD uses, so the parts
are true solids with real fillets, and the STEP files open in Fusion 360,
Onshape, SolidWorks or FreeCAD as editable bodies. step/flux-assembly.step is
the whole box with every part inside it, named and coloured.

THE FRAME, as the box stands on the table facing you:
    X  across, left to right,   0 .. BOX_W
    Y  depth, front to back,    0 = the front face
    Z  height,                  0 = the table
All dimensions in millimetres. Every number is named here once; a measurement
that turns out wrong is a one-line change and a re-run. Values off a drawing
say where they came from. Values that are still guesses say MEASURE.
"""

import argparse
import math
import sys
from pathlib import Path

from build123d import (Align, Axis, Box, Color, Compound, Cylinder, Location, Part, Plane, Pos,
                       RectangleRounded, Rectangle, Rot, Circle, SlotOverall, Sketch, Text,
                       extrude, fillet, chamfer, export_step, export_stl, export_gltf, ExportDXF,
                       Unit, Mode)

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / 'flux-assets'
FONT_WORDMARK = ASSETS / 'Flock-Fraunces-Wordmark-Black.ttf'
FONT_LABEL = ASSETS / 'Flock-Hanken-Grotesk-Medium.ttf'


def flat_font(path):
    """The font with its overlapping outlines merged.

    The brand's fonts keep the overlapping contours a variable font is built
    from. A renderer fills those by the nonzero rule and nobody notices, but a
    solid modeller turns each contour into its own face: the G came out as an
    invalid face and dropped, and the hole in an A or an R came out as a second
    face sitting on top of the letter, which the laser would have engraved
    solid. fontTools merges the overlaps first, into a copy in the temp folder.
    """
    import tempfile
    from fontTools.ttLib import TTFont
    from fontTools.ttLib.removeOverlaps import removeOverlaps
    out = Path(tempfile.gettempdir()) / 'flux-fonts' / Path(path).name
    if not out.exists() or out.stat().st_mtime < Path(path).stat().st_mtime:
        out.parent.mkdir(parents=True, exist_ok=True)
        font = TTFont(str(path))
        removeOverlaps(font)
        font.save(str(out))
    return str(out)

# ===========================================================================
# MEASURED, from datasheets, drawings and labels.
# ===========================================================================

# The screen: Lebula/ROADOM 7 inch 1024x600 HDMI, landscape, 162 x 119
# measured against its own lit area (154.21 x 85.92 by spec, in the board's
# plane). Four mounting ears at its corners.
screen_outer_w = 162.0
screen_outer_h = 119.0
screen_hole_dx = 149.0
screen_hole_dy = 113.0
screen_active_w = 154.2        # the lit area is NOT centred: 3.8 at each side,
screen_active_h = 85.9         # 14.4 above the picture and 17.4 below it
screen_border_l = 3.8
screen_border_b = 17.4
# On its back along its LEFT edge as you face it: the "5V+Touch" micro-USB,
# opening sideways out of that edge, and the flat HDMI ribbon socket at the
# bottom. Read off the maker's photograph of the back.
screen_touch_z = 38.0          # MEASURE: board bottom to the touch port's centre
screen_touch_in = 2.0          # MEASURE: its mouth, in from the edge
screen_fpc_x = 12.0            # MEASURE: the ribbon socket, in from the left edge
screen_fpc_z0 = 8.0            # MEASURE: and up from the bottom
screen_fpc_z1 = 23.0
glass_below = 10.0             # MEASURE: board bottom to the glass's lower edge
glass_above = 10.0             # MEASURE: glass's upper edge to the board top

# The battery: Anker Prime 20K 200W, A1336: 126.9 x 54.6 x 49.6 (Anker). It
# stands on its dock-contact end; its three ports face up.
batt_len = 126.9
batt_wid = 54.6
batt_thk = 49.6

# Raspberry Pi 5 (drawing RP-008347). Its own frame: X from the microSD end,
# Y from the edge with the USB-C and both micro HDMI. Seen from its parts side
# with that edge at the bottom, the 40 pins run along the top and the USB and
# Ethernet are at the right: the board's ordinary picture, and how it sits.
pi_w = 85.0
pi_d = 56.0
pi_pcb = 1.4
pi_under = 1.9
pi_hole_inset = 3.5
pi_hole_dx = 58.0
pi_hole_dy = 49.0
cooler_h = 12.5                # Raspberry Pi Active Cooler, to its fan screws
# Waveshare SIM7600G-H 4G HAT on 17 mm standoffs and a long-pin stacking
# header: over an Active Cooler a HAT needs 15 mm or more, and this one has a
# regulator and its SIM holder underneath. Its pins come through on top.
hat_gap = 17.0
hat_w = 65.0
hat_pcb = 1.6
hat_parts_h = 3.0
hat_pins_h = 6.0
jumper_h = 22.5                # a jumper's housing on one of those pins, and its bend

# PureThermal 3 with the Lepton 3.5 (GroupGets drawing Rev 2): 25.8 wide, 28.9
# tall, four M2 holes on a 20.7 x 23.9 grid. USB-C on the Lepton side, middle
# of the bottom edge; the Lepton's centre 7.6 below the top edge.
pt3_w = 25.8
pt3_h = 28.9
pt3_hole_dx = 20.7
pt3_hole_dy = 23.9
pt3_lepton_top = 7.6
lepton_h = 7.14                # the Lepton in its socket, above the board
lepton_body = (11.8, 12.7)     # its outline
lepton_lens = 6.0              # MEASURE: the lens opening on its face
lepton_half = 35.5             # half its 71 degree diagonal view
pt3_back_h = 2.55              # the tallest part on the board's back
usbc_plug_room = 11.0          # a right-angle USB-C plug under its bottom edge

# Pololu #3419, the VL53L8CX doorway counter: 22.86 x 12.7, laid on its side,
# sensor at the centre, two M2 holes 17.78 apart. Pins out the back.
tof_w = 22.86
tof_h = 12.7
tof_hole_dx = 17.78
tof_hole_off = 3.75            # the holes' line, off the board's centre line
tof_sensor = (6.4, 3.0)
tof_sensor_h = 1.75
tof_half = 32.5                # half its 65 degree diagonal view

# PCB Artists I2C decibel meter PRO: 19.05 x 26.67; the microphone hears
# through a hole in the board's bare back at (9.525, 11.09) from its corner.
dbm_w = 19.05
dbm_h = 26.67
dbm_port = (9.525, 11.09)
dbm_stack = 22.0               # board, connector, plug, and the wires' bend

# ===========================================================================
# STILL TO MEASURE
# ===========================================================================

screen_thick = 12.0            # MEASURE: front of the glass to the back of its speakers
screen_glass_depth = 5.5       # MEASURE: front of the glass to the front of the ears
plate = 3.0                    # MEASURE: the acrylic sheet

# ===========================================================================
# DESIGN CHOICES
# ===========================================================================

wall = 2.5                     # the printed sleeve
corner_r = 6.0                 # the box's corners as you face it
inner_r = 1.5                  # inside, kept tight so a part can stand in a corner
reveal = 0.8                   # the chamfer on the sleeve's rims: a shadow line at each sheet
backer = 1.6                   # the printed plate behind the front sheet's strip
side_room = 6.5                # beside the screen, each side: the touch plug on the left
cable_gap = 4.0                # behind the screen: the touch cable and the video ribbon
strip_h = 43.0                 # the strip under the screen, base included

insert_dia = 4.2               # the brass M3 x 4 inserts, 4.2 across
insert_depth = 5.0
screw_dia = 3.4                # M3 clearance
pi_screw_dia = 2.7             # M2.5 clearance
pi_spacer = 5.0                # back sheet to the Pi's board
m2_pilot = 1.7                 # M2 screws cut their own thread in these
post_len = 9.0                 # the back's corner posts

led_dia = 3.1                  # a 3 mm LED pushes in and stops on its rim. Test-cut first.
wordmark = 'Flux'
wordmark_size = 8.0

chg_hole = 12.2                # Adafruit #6069 USB-C round panel mount, M12 thread
chg_body = (12.0, 30.0)        # across, and how far it reaches in with its bend

# The power converter between the battery and the Pi: a Pi 5 wants 5 V at
# 5 A and a power bank's 5 V stops at 3 A, so this asks the battery for more
# over USB-C PD and steps it down. A block until the part is in hand.
conv_size = (26.0, 40.0, 55.0)  # MEASURE: across, front to back, up

mount_nut_af = 11.4            # a 1/4"-20 hex nut, across its flats, with clearance
mount_nut_th = 5.8
mount_boss = 20.0

# ===========================================================================
# DERIVED. Nothing below here is a setting.
# ===========================================================================

IN_W = screen_outer_w + 2 * side_room
BOX_W = IN_W + 2 * wall
BOX_H = strip_h + screen_outer_h + 2.0 + wall
IN_X0, IN_X1 = wall, BOX_W - wall
IN_Z0, IN_Z1 = wall, BOX_H - wall

SL_Y0 = plate                              # the sleeve's front
FRONT_Y = SL_Y0 + backer                   # back face of the strip's backer
SCREEN_Y1 = SL_Y0 + screen_thick           # back of the screen
LAY_Y0 = SCREEN_Y1 + cable_gap             # the layer behind the screen starts here
BATT_Y1 = LAY_Y0 + batt_thk
SL_Y1 = BATT_Y1 + 0.6                      # the sleeve's back
BOX_D = SL_Y1 + plate

SCREEN_X0 = (BOX_W - screen_outer_w) / 2
SCREEN_Z0 = strip_h
EAR_Y0 = SL_Y0 + screen_glass_depth
WIN_X0 = SCREEN_X0 + screen_border_l + 1.0
WIN_Z0 = SCREEN_Z0 + screen_border_b + 1.0
WIN_W = screen_active_w - 2.0
WIN_H = screen_active_h - 2.0
SCREEN_HOLES = [(BOX_W / 2 + sx * screen_hole_dx / 2, SCREEN_Z0 + screen_outer_h / 2 + sz * screen_hole_dy / 2)
                for sx in (-1, 1) for sz in (-1, 1)]

PT3_X0 = BOX_W / 2 - pt3_w / 2
PT3_Z0 = IN_Z0 + usbc_plug_room
EYE = (BOX_W / 2, PT3_Z0 + pt3_h - pt3_lepton_top)
PT3_FACE = FRONT_Y + 0.5 + lepton_h        # the PT3 board's Lepton side
TOF_C = (EYE[0] + 32.0, EYE[1])
TOF_FACE = FRONT_Y + 0.3 + tof_sensor_h    # the counter board's sensor side
LED_POS = (SCREEN_X0 + screen_outer_w + side_room / 2, EYE[1])

BATT_X0 = IN_X0 + 2.0
BATT_X1 = BATT_X0 + batt_wid
BATT_Z1 = IN_Z0 + batt_len

PI_X0 = IN_X1 - 28.5 - pi_w
PI_ZBOT = IN_Z0 + 13.5
PI_BACK = SL_Y1 - pi_spacer
PI_FRONT = PI_BACK - pi_pcb
PI_HOLES = [(PI_X0 + pi_hole_inset + hx, PI_ZBOT + pi_hole_inset + hy)
            for hx in (0, pi_hole_dx) for hy in (0, pi_hole_dy)]

DBM_C = (SL_Y1 - 34.0, PI_ZBOT + pi_d + 12.0 + dbm_h / 2)   # (y, z) of its centre, on the right wall
CHG_POS = (PI_X0 + 60.0, IN_Z1 - 14.0)
CONV_X0 = PI_X0 + 2.0
CONV_Z0 = PI_ZBOT + pi_d + 22.0
MOUNT_C = (72.0, LAY_Y0 + 7.0)    # under the balance point, in front of the modem plug

CORNER_IN = wall + 4.5
# The lower left one moves in past the battery, which stands in that corner.
BACK_HOLES = [(CORNER_IN, BOX_H - CORNER_IN), (BOX_W - CORNER_IN, BOX_H - CORNER_IN),
              (BATT_X1 + 5.2, CORNER_IN), (BOX_W - CORNER_IN, CORNER_IN)]


def cone(width, half_deg, depth):
    """The opening that clears a sensor's view at `depth` in front of it."""
    return width + 2 * depth * math.tan(math.radians(half_deg)) + 1.0


# ===========================================================================
# Helpers. Everything is placed in the box's frame directly.
# ===========================================================================

def span(x0, x1, y0, y1, z0, z1):
    return Pos(min(x0, x1), min(y0, y1), min(z0, z1)) * Box(
        abs(x1 - x0), abs(y1 - y0), abs(z1 - z0), align=(Align.MIN, Align.MIN, Align.MIN))


def cyl_y(x, y0, z, d, length):
    """A cylinder along +Y from y0."""
    return Pos(x, y0, z) * Rot(-90, 0, 0) * Cylinder(d / 2, length, align=(Align.CENTER, Align.CENTER, Align.MIN))


def cyl_x(x0, y, z, d, length):
    return Pos(x0, y, z) * Rot(0, 90, 0) * Cylinder(d / 2, length, align=(Align.CENTER, Align.CENTER, Align.MIN))


def cyl_z(x, y, z0, d, length):
    return Pos(x, y, z0) * Cylinder(d / 2, length, align=(Align.CENTER, Align.CENTER, Align.MIN))


def xz_plane(y, flip=False):
    """A plane whose local x is the box's X (or -X seen from behind) and local
    y is the box's Z, at depth y. Its normal points toward the front (-Y), or
    toward the back when flipped."""
    if flip:
        return Plane(origin=(BOX_W, y, 0), x_dir=(-1, 0, 0), z_dir=(0, 1, 0))
    return Plane(origin=(0, y, 0), x_dir=(1, 0, 0), z_dir=(0, -1, 0))


def slab(sketch, y0, y1, flip=False):
    """Extrude a sketch drawn in (x, z) to fill y0 .. y1."""
    if flip:
        return extrude(xz_plane(y0, flip=True) * sketch, amount=y1 - y0)
    return extrude(xz_plane(y1) * sketch, amount=y1 - y0)


def face_outline(inset=0.0, r=None):
    rr = corner_r - inset if r is None else r
    return Pos(BOX_W / 2, BOX_H / 2) * RectangleRounded(BOX_W - 2 * inset, BOX_H - 2 * inset, max(0.05, rr))


def pi_box(X0, X1, Y0, Y1, H0, H1):
    """A box in the Pi's own frame: X along the board, Y up from its bottom
    (USB-C) edge, H out of its parts side toward the screen."""
    return span(PI_X0 + X0, PI_X0 + X1, PI_FRONT - H0, PI_FRONT - H1, PI_ZBOT + Y0, PI_ZBOT + Y1)


# ===========================================================================
# THE SLEEVE: one printed part, the four sides with every post and frame.
# Prints standing on its front rim, no supports: every post and rib runs front
# to back, straight up off the bed.
# ===========================================================================

def sleeve():
    body = slab(face_outline(), SL_Y0, SL_Y1) - slab(face_outline(wall, inner_r), SL_Y0, SL_Y1)

    # The shadow line at each rim, where a sheet meets the sleeve.
    def outer_rim(e):
        c = e.center()
        at_rim = abs(c.Y - SL_Y0) < 1e-3 or abs(c.Y - SL_Y1) < 1e-3
        return at_rim and (c.X < 2 or c.X > BOX_W - 2 or c.Z < 2 or c.Z > BOX_H - 2)
    body = chamfer([e for e in body.edges() if outer_rim(e)], reveal)

    # The backer: a plate behind the front sheet across the strip, and a 5 mm
    # rim around the screen. The front sheet's VHB tape goes on it.
    backer_sk = face_outline(wall - 0.01, inner_r) - Pos((SCREEN_X0 - side_room + 5 + SCREEN_X0 + screen_outer_w + side_room - 5) / 2,
                                                        (SCREEN_Z0 + 3.0 + IN_Z1 - 5) / 2) * Rectangle(
        screen_outer_w + 2 * side_room - 10, IN_Z1 - 5 - SCREEN_Z0 - 3.0)
    body += slab(backer_sk, SL_Y0, FRONT_Y)

    # The camera's four posts and the counter's two, M2 screws from behind.
    # Each sinks half a millimetre into the backer so they print as one.
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = EYE[0] + sx * pt3_hole_dx / 2, PT3_Z0 + pt3_h / 2 + sz * pt3_hole_dy / 2
            body += cyl_y(x, FRONT_Y - 0.5, z, 4.6, PT3_FACE - FRONT_Y + 0.5)
    for s in (-1, 1):
        x, z = TOF_C[0] + s * tof_hole_dx / 2, TOF_C[1] + tof_hole_off
        body += cyl_y(x, FRONT_Y - 0.5, z, 4.0, TOF_FACE - FRONT_Y + 0.5)

    # The screen's four posts, ribbed to the top wall or down into the strip.
    for x, z in SCREEN_HOLES:
        body += cyl_y(x, FRONT_Y - 0.5, z, 8.0, EAR_Y0 - FRONT_Y + 0.5)
        if z > BOX_H / 2:
            body += span(x - 1.5, x + 1.5, FRONT_Y - 0.5, EAR_Y0, z, IN_Z1 + 0.5)
        else:
            body += span(x - 1.5, x + 1.5, FRONT_Y - 0.5, EAR_Y0, SCREEN_Z0 - 2.0, z)

    # The back's four posts, filled to the walls they sit against.
    for x, z in BACK_HOLES:
        body += cyl_y(x, SL_Y1 - post_len, z, 9.0, post_len)
        if x < CORNER_IN + 1 or x > BOX_W - CORNER_IN - 1:
            body += span(x, IN_X0 - 0.5 if x < BOX_W / 2 else IN_X1 + 0.5, SL_Y1 - post_len, SL_Y1, z - 4.5, z + 4.5)
        body += span(x - 4.5, x + 4.5, SL_Y1 - post_len, SL_Y1, z, IN_Z0 - 0.5 if z < BOX_H / 2 else IN_Z1 + 0.5)

    # A wall the battery stands against, so it cannot lean into the Pi.
    body += span(BATT_X1 + 0.5, BATT_X1 + 2.1, LAY_Y0 + 6, SL_Y1 - post_len - 1, IN_Z0 - 0.5, IN_Z0 + 70)

    # The sound meter's frame on the right wall.
    fy, fz = DBM_C
    frame = span(IN_X1 - 2.0, IN_X1 + 0.5, fy - dbm_w / 2 - 1.6, fy + dbm_w / 2 + 1.6,
                 fz - dbm_h / 2 - 1.6, fz + dbm_h / 2 + 1.6)
    frame -= span(IN_X1 - 2.1, IN_X1 + 0.1, fy - dbm_w / 2 - 0.2, fy + dbm_w / 2 + 0.2,
                  fz - dbm_h / 2 - 0.2, fz + dbm_h / 2 + 0.2)
    body += frame

    # The mount's boss, a 1/4"-20 nut dropped in from inside.
    body += cyl_z(MOUNT_C[0], MOUNT_C[1], 0, mount_boss, IN_Z0 + mount_nut_th + 1.5)

    # --- cuts ---
    for x, z in SCREEN_HOLES:
        body -= cyl_y(x, EAR_Y0 - insert_depth, z, insert_dia, insert_depth + 0.01)
    for x, z in BACK_HOLES:
        body -= cyl_y(x, SL_Y1 - insert_depth - 2, z, insert_dia, insert_depth + 2.01)
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = EYE[0] + sx * pt3_hole_dx / 2, PT3_Z0 + pt3_h / 2 + sz * pt3_hole_dy / 2
            body -= cyl_y(x, FRONT_Y + 0.2, z, m2_pilot, 20)
    for s in (-1, 1):
        body -= cyl_y(TOF_C[0] + s * tof_hole_dx / 2, FRONT_Y + 0.2, TOF_C[1] + tof_hole_off, m2_pilot, 20)

    # The eye, the counter's window and the light through the backer.
    body -= cyl_y(EYE[0], SL_Y0 - 1, EYE[1], cone(lepton_lens, lepton_half, 0.5 + backer) + 1.0, backer + 2)
    tw = cone(tof_sensor[0], tof_half, 0.3 + backer)
    th = cone(tof_sensor[1], tof_half, 0.3 + backer)
    body -= slab(Pos(*TOF_C) * RectangleRounded(tw, th, min(tw, th) / 2 - 0.01), SL_Y0 - 1, FRONT_Y + 1)
    body -= cyl_y(LED_POS[0], SL_Y0 - 1, LED_POS[1], 4.2, backer + 2)

    # The meter hears the room through the right wall.
    body -= cyl_x(IN_X1 - 1, fy - dbm_w / 2 + dbm_port[0], fz - dbm_h / 2 + dbm_port[1], 2.5, wall + 2)

    # The mount: the bolt's hole up through the base, and the nut's pocket.
    body -= cyl_z(MOUNT_C[0], MOUNT_C[1], -1, 6.8, 20)
    nut = extrude(Plane.XY.offset(IN_Z0 + 1.5) * Pos(*MOUNT_C) * RegularHex(mount_nut_af), amount=20)
    body -= nut

    # Air: in through the base under the Pi, out through the top over it and
    # the right side above its USB plugs.
    for i in range(4):
        y = PI_BACK - 4 - i * 5
        body -= slab_z_slot(PI_X0 + pi_w / 2 + 6, y, 50, 2.6, -1, wall + 1)
    for i in range(5):
        y = SL_Y1 - 12 - i * 6
        body -= slab_z_slot(PI_X0 + pi_w / 2, y, 60, 2.6, BOX_H - wall - 1, BOX_H + 1)
    for i in range(4):
        y = SL_Y1 - 10 - i * 6
        body -= slot_x(IN_X1 - 1, y, PI_ZBOT + pi_d + 6, 24, 2.6, wall + 2)
    return body


def RegularHex(across_flats):
    from build123d import RegularPolygon
    return RegularPolygon(across_flats / math.sqrt(3), 6, major_radius=True)


def slab_z_slot(x, y, length, width, z0, z1):
    """A rounded slot along X through a horizontal wall, from z0 to z1."""
    return extrude(Plane.XY.offset(z0) * Pos(x, y) * SlotOverall(length, width), amount=z1 - z0)


def slot_x(x0, y, z, length, width, depth):
    """A rounded slot along Z through the right wall, from x0 outward."""
    pl = Plane(origin=(x0, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    return extrude(pl * Pos(y, z) * Rot(0, 0, 90) * SlotOverall(length, width), amount=depth)


# ===========================================================================
# THE SHEETS, laser cut from 3 mm black acrylic. Each is drawn as the 2D shape
# the laser cuts, seen from outside, and only then given its thickness.
# ===========================================================================

def front_cut_sketch():
    sk = face_outline()
    sk -= Pos(WIN_X0 + WIN_W / 2, WIN_Z0 + WIN_H / 2) * Rectangle(WIN_W, WIN_H)
    sk -= Pos(*EYE) * Circle(eye_dia() / 2)
    tw, th = tof_window()
    sk -= Pos(*TOF_C) * RectangleRounded(tw, th, min(tw, th) / 2 - 0.01)
    sk -= Pos(*LED_POS) * Circle(led_dia / 2)
    return sk


def eye_dia():
    return cone(lepton_lens, lepton_half, 0.5 + backer + plate) + 0.5


def tof_window():
    return (cone(tof_sensor[0], tof_half, 0.3 + backer + plate), cone(tof_sensor[1], tof_half, 0.3 + backer + plate))


def front_engrave_sketch():
    return Pos(WIN_X0 - 0.06 * wordmark_size, EYE[1]) * Text(
        wordmark, font_size=wordmark_size * 1.38, font_path=flat_font(FONT_WORDMARK), align=(Align.MIN, Align.CENTER))


def back_cut_sketch():
    """Seen from behind: a = BOX_W - x, b = z."""
    def a(x):
        return BOX_W - x
    sk = face_outline()
    for x, z in BACK_HOLES:
        sk -= Pos(a(x), z) * Circle(screw_dia / 2)
    for x, z in PI_HOLES:
        sk -= Pos(a(x), z) * Circle(pi_screw_dia / 2)
    sk -= Pos(a(CHG_POS[0]), CHG_POS[1]) * Circle(chg_hole / 2)
    for i in range(6):
        sk -= Pos(a(PI_X0 + pi_w / 2), PI_ZBOT + 9 + i * 7.5) * SlotOverall(39, 3.0)
    return sk


def back_engrave_sketch():
    a = BOX_W - CHG_POS[0]
    label = Pos(a, CHG_POS[1] - chg_hole / 2 - 5) * Text(
        'CHARGE', font_size=3.2 * 1.38, font_path=flat_font(FONT_LABEL), align=(Align.CENTER, Align.CENTER))
    mark = Pos(BOX_W - (PI_X0 + pi_w / 2), PI_ZBOT + pi_d + 10) * Text(
        'Flux', font_size=7 * 1.38, font_path=flat_font(FONT_WORDMARK), align=(Align.CENTER, Align.CENTER))
    return label + mark


def front_sheet():
    return slab(front_cut_sketch(), 0, plate)


def back_sheet():
    return slab(back_cut_sketch(), SL_Y1, SL_Y1 + plate, flip=True)


def engraving(sketch, y, depth=0.2, flip=False):
    """The engraving as a thin solid on a sheet's outside face, for pictures."""
    if flip:
        return slab(sketch, y, y + depth, flip=True)
    return slab(sketch, y - depth, y)


# ===========================================================================
# PRINTED SMALL PARTS AND FIT TESTS
# ===========================================================================

def pi_spacer_part():
    return Cylinder(3.0, pi_spacer, align=(Align.CENTER, Align.CENTER, Align.MIN)) - \
        Cylinder(pi_screw_dia / 2, pi_spacer, align=(Align.CENTER, Align.CENTER, Align.MIN))


def screen_fit_test():
    m = 24
    w, h = screen_outer_w + 2 * m, screen_outer_h + 2 * m
    t = 4.0
    part = extrude(RectangleRounded(w, h, 6), amount=t)
    part -= extrude(Rectangle(screen_active_w - 2, screen_active_h - 2), amount=t)
    part -= Pos(0, 0, t - 1.6) * extrude(Rectangle(screen_outer_w + 3, screen_outer_h + 3), amount=2)
    for sx in (-1, 1):
        for sy in (-1, 1):
            part -= Pos(sx * screen_hole_dx / 2, sy * screen_hole_dy / 2, 0) * Cylinder(1.7, t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part


def strip_fit_test(whole):
    """The strip, cut out of the sleeve, laid on its front to print."""
    piece = whole & span(SCREEN_X0 + 6, LED_POS[0] + 6, SL_Y0, PT3_FACE + 1, IN_Z0, strip_h - 3.3)
    return Rot(90, 0, 0) * Pos(0, -SL_Y0, 0) * piece


# ===========================================================================
# WHAT GOES INSIDE. Each part is drawn to its datasheet's outline, with the
# room its plugs need, and named for what it is.
# ===========================================================================

def screen_body():
    glass = span(SCREEN_X0, SCREEN_X0 + screen_outer_w, SL_Y0, EAR_Y0,
                 SCREEN_Z0 + glass_below, SCREEN_Z0 + screen_outer_h - glass_above)
    board = span(SCREEN_X0, SCREEN_X0 + screen_outer_w, EAR_Y0, SCREEN_Y1, SCREEN_Z0, SCREEN_Z0 + screen_outer_h)
    for x, z in SCREEN_HOLES:
        board -= cyl_y(x, EAR_Y0 - 1, z, 3.2, 3)
    return glass + board


def touch_plug():
    return span(IN_X0 + 0.3, SCREEN_X0 + screen_touch_in, EAR_Y0, SCREEN_Y1 + 3,
                SCREEN_Z0 + screen_touch_z - 5, SCREEN_Z0 + screen_touch_z + 5)


def touch_cable():
    return span(IN_X0 + 0.3, PI_X0 + pi_w + 2, SCREEN_Y1 + 0.2, LAY_Y0 - 0.2,
                SCREEN_Z0 + screen_touch_z - 1.8, SCREEN_Z0 + screen_touch_z + 1.8)


def video_ribbon():
    return span(SCREEN_X0 + screen_fpc_x, PI_X0 + 40, SCREEN_Y1 + 0.2, SCREEN_Y1 + 1.2,
                SCREEN_Z0 + screen_fpc_z0, SCREEN_Z0 + screen_fpc_z1)


def camera_body():
    board = span(PT3_X0, PT3_X0 + pt3_w, PT3_FACE, PT3_FACE + 1.6 + pt3_back_h, PT3_Z0, PT3_Z0 + pt3_h)
    lepton = span(EYE[0] - lepton_body[1] / 2, EYE[0] + lepton_body[1] / 2, FRONT_Y + 0.5, PT3_FACE,
                  EYE[1] - lepton_body[0] / 2, EYE[1] + lepton_body[0] / 2)
    return board + lepton


def camera_plug():
    return span(EYE[0] - 6.5, EYE[0] + 6.5, PT3_FACE - 4.5, LAY_Y0 + 4, IN_Z0 + 0.3, PT3_Z0)


def counter_body():
    return span(TOF_C[0] - tof_w / 2, TOF_C[0] + tof_w / 2, TOF_FACE, TOF_FACE + 1.6,
                TOF_C[1] - tof_h / 2, TOF_C[1] + tof_h / 2) + \
        span(TOF_C[0] - tof_sensor[0] / 2, TOF_C[0] + tof_sensor[0] / 2, TOF_FACE - tof_sensor_h, TOF_FACE,
             TOF_C[1] - tof_sensor[1] / 2, TOF_C[1] + tof_sensor[1] / 2)


def counter_leads():
    return span(TOF_C[0] - tof_w / 2, TOF_C[0] + tof_w / 2, TOF_FACE + 1.6, TOF_FACE + 1.6 + 6 + jumper_h - 4,
                TOF_C[1] - tof_h / 2, TOF_C[1] + tof_h / 2)


def battery_body():
    b = span(BATT_X0, BATT_X1, LAY_Y0, BATT_Y1, IN_Z0, BATT_Z1)
    return fillet(b.edges().filter_by(Axis.Z), 4.0)


def battery_plugs():   # right-angle plugs out of its top end
    return span(BATT_X0 + 4, BATT_X1 - 4, LAY_Y0 + 4, BATT_Y1 - 4, BATT_Z1, BATT_Z1 + 21)


def pi_board():
    board = pi_box(0, pi_w, 0, pi_d, -pi_pcb, 0)
    board = fillet(board.edges().filter_by(Axis.Y), 2.9)
    for x, z in PI_HOLES:
        board -= cyl_y(x, PI_FRONT - 1, z, 2.7, pi_pcb + 2)
    # What stands off the board's back, within the spacers' 5 mm.
    return board + pi_box(2, pi_w - 2, 2, pi_d - 2, -pi_pcb - pi_under, -pi_pcb)


def pi_ports():
    return (pi_box(71.0, 87.9, 22.5, 35.6, 0, 15.8) + pi_box(71.0, 87.9, 40.5, 53.6, 0, 15.8) +
            pi_box(66.8, 88.0, 2.2, 18.2, 0, 13.9) + pi_box(7.0, 15.4, -1.3, 7.0, -1.0, 3.2) +
            pi_box(22.0, 43.0, -1.7, 6.0, 0, 3.4) + pi_box(7.13, 57.93, 50.0, 55.0, 0, 8.5))


def cooler_body():
    return pi_box(0.6, 64.0, 6.6, 49.0, 0, cooler_h)


def hat_body():
    return (pi_box(0, hat_w, 0, pi_d, hat_gap, hat_gap + hat_pcb + hat_parts_h) +
            pi_box(62.8, 65.4, 8.2, 46.7, hat_gap, hat_gap + hat_pcb + 8.5) +
            pi_box(49.7, 56.7, -2.8, 11.6, hat_gap, hat_gap + hat_pcb + 5.0) +
            pi_box(7.13, 57.93, 50.0, 55.0, hat_gap, hat_gap + hat_pcb + hat_pins_h))


def jumpers():
    return pi_box(7.0, 34.0, 48.5, 56.5, hat_gap + hat_pcb, hat_gap + hat_pcb + jumper_h)


def pi_low_plugs():
    return (pi_box(5.0, 17.4, -13.0, -1.3, -2.0, 9.0) + pi_box(18.0, 34.0, -13.0, -1.7, -1.0, 9.0) +
            pi_box(6.0, 18.0, -13.0, -1.5, hat_gap + hat_pcb - 3, hat_gap + hat_pcb + 7))


def pi_usb_plugs():
    return pi_box(88.0, 108.0, 21.5, 54.6, -1.0, 17.0)


def meter_body():
    fy, fz = DBM_C
    return span(IN_X1 - dbm_stack, IN_X1 - 0.8, fy - dbm_w / 2, fy + dbm_w / 2, fz - dbm_h / 2, fz + dbm_h / 2)


def converter_body():
    return span(CONV_X0, CONV_X0 + conv_size[0], LAY_Y0 + 1, LAY_Y0 + 1 + conv_size[1],
                CONV_Z0, CONV_Z0 + conv_size[2])


def charge_jack():
    x, z = CHG_POS
    return span(x - chg_body[0] / 2, x + chg_body[0] / 2, SL_Y1 - chg_body[1], SL_Y1, z - chg_body[0] / 2, z + chg_body[0] / 2)


def led_body():
    return cyl_y(LED_POS[0], FRONT_Y - 1.5, LED_POS[1], 3.8, 7)


def mount_nut():
    return extrude(Plane.XY.offset(IN_Z0 + 1.5) * Pos(*MOUNT_C) * RegularHex(mount_nut_af - 0.4), amount=mount_nut_th)


# ===========================================================================
# THE CLASH CHECK: every pair of parts that must not overlap, intersected.
# ===========================================================================

INSIDE = {
    'screen': screen_body, 'battery': battery_body, 'battery plugs': battery_plugs,
    'Pi': lambda: pi_board() + pi_ports(), 'cooler': cooler_body, '4G board': hat_body,
    'jumpers': jumpers, 'Pi lower plugs': pi_low_plugs, 'Pi USB plugs': pi_usb_plugs,
    'camera': camera_body, 'camera plug': camera_plug, 'counter': counter_body,
    'counter leads': counter_leads, 'sound meter': meter_body, 'converter': converter_body,
    'charging port': charge_jack, 'light': led_body, 'mount nut': mount_nut,
    'touch plug': touch_plug, 'touch cable': touch_cable, 'video ribbon': video_ribbon,
}
# What each part is meant to touch: what it is fixed to or plugged into.
ALLOWED = {
    frozenset(p) for p in [
        ('sleeve', 'camera'), ('sleeve', 'counter'), ('sleeve', 'sound meter'), ('sleeve', 'light'),
        ('sleeve', 'mount nut'), ('sleeve', 'touch plug'), ('sleeve', 'video ribbon'),
        ('back sheet', 'charging port'), ('sleeve', 'charging port'),
        ('camera', 'camera plug'), ('counter', 'counter leads'),
        ('Pi', 'cooler'), ('Pi', 'jumpers'), ('Pi', 'Pi lower plugs'), ('Pi', 'Pi USB plugs'),
        ('cooler', '4G board'), ('4G board', 'jumpers'), ('4G board', 'Pi lower plugs'),
        ('jumpers', 'Pi lower plugs'), ('battery', 'battery plugs'),
        ('screen', 'touch plug'), ('screen', 'video ribbon'), ('screen', 'touch cable'),
        ('touch plug', 'touch cable'),
    ]
}


def clash_report(sleeve_part, front, back):
    parts = {'sleeve': sleeve_part, 'front sheet': front, 'back sheet': back}
    parts.update({k: f() for k, f in INSIDE.items()})
    names = list(parts)
    found = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if frozenset((a, b)) in ALLOWED:
                continue
            common = parts[a] & parts[b]
            vol = sum(s.volume for s in common.solids()) if common else 0.0
            if vol > 0.01:
                bb = common.bounding_box()
                found.append((a, b, vol, bb))
    return found


# ===========================================================================
# THE ASSEMBLY, named and coloured, for the STEP file and the pictures.
# ===========================================================================

BLACK_ACRYLIC = Color(0.05, 0.05, 0.06)
BLACK_PLA = Color(0.11, 0.11, 0.12)


def labelled(shape, label, color):
    shape.label = label
    shape.color = color
    return shape


def brass_inserts():
    """The eight inserts, melted into the screen's posts and the back's."""
    parts = [cyl_y(x, EAR_Y0 - 4.0, z, insert_dia, 4.0) for x, z in SCREEN_HOLES]
    parts += [cyl_y(x, SL_Y1 - 4.0, z, insert_dia, 4.0) for x, z in BACK_HOLES]
    return sum(parts[1:], parts[0])


def assembly(sleeve_part, front, back):
    parts = [
        labelled(sleeve_part, 'Sleeve (printed)', BLACK_PLA),
        labelled(front, 'Front sheet (acrylic)', BLACK_ACRYLIC),
        labelled(back, 'Back sheet (acrylic)', BLACK_ACRYLIC),
        labelled(engraving(front_engrave_sketch(), 0.0), 'Front engraving', Color(0.8, 0.8, 0.82)),
        labelled(engraving(back_engrave_sketch(), SL_Y1 + plate, flip=True), 'Back engraving', Color(0.8, 0.8, 0.82)),
        labelled(screen_body(), '7 inch touchscreen', Color(0.02, 0.03, 0.05)),
        labelled(battery_body(), 'Anker A1336 battery', Color(0.85, 0.45, 0.1)),
        labelled(pi_board(), 'Raspberry Pi 5', Color(0.1, 0.45, 0.25)),
        labelled(pi_ports(), 'Pi 5 ports', Color(0.75, 0.75, 0.78)),
        labelled(cooler_body(), 'Active Cooler', Color(0.3, 0.3, 0.32)),
        labelled(hat_body(), 'SIM7600G-H 4G HAT', Color(0.15, 0.3, 0.6)),
        labelled(camera_body(), 'PureThermal 3 + Lepton 3.5', Color(0.6, 0.1, 0.15)),
        labelled(counter_body(), 'VL53L8CX door counter', Color(0.45, 0.3, 0.65)),
        labelled(meter_body(), 'Decibel meter', Color(0.1, 0.55, 0.55)),
        labelled(converter_body(), 'Power converter', Color(0.9, 0.4, 0.35)),
        labelled(charge_jack(), 'CHARGE port', Color(0.85, 0.85, 0.85)),
        labelled(led_body(), 'LINK light', Color(0.5, 0.95, 0.5)),
        labelled(mount_nut(), '1/4-20 mount nut', Color(0.7, 0.7, 0.72)),
        labelled(brass_inserts(), 'Brass M3 inserts (8)', Color(0.85, 0.66, 0.25)),
    ]
    return Compound(children=parts, label='Flux')


# ===========================================================================

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--check', action='store_true', help='only the clash check')
    args = ap.parse_args()

    print(f'box {BOX_W:.1f} x {BOX_H:.1f} x {BOX_D:.1f} mm')
    sl = sleeve()
    front, back = front_sheet(), back_sheet()
    for name, part in (('sleeve', sl), ('front sheet', front), ('back sheet', back)):
        if len(part.solids()) != 1 or not part.is_valid:
            sys.exit(f'{name} is not one valid solid ({len(part.solids())} solids)')
    found = clash_report(sl, front, back)
    for a, b, vol, bb in found:
        print(f'  CLASH {a} x {b}: {vol:.2f} mm3 at x {bb.min.X:.1f}..{bb.max.X:.1f} '
              f'y {bb.min.Y:.1f}..{bb.max.Y:.1f} z {bb.min.Z:.1f}..{bb.max.Z:.1f}')
    if found:
        sys.exit(f'{len(found)} pair(s) collide')
    print('clash check: nothing overlaps')
    if args.check:
        return

    # (written by export.py from here, which owns the file layout)
    return sl, front, back


if __name__ == '__main__':
    main()
