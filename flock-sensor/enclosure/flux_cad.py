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
                       RectangleRounded, Rectangle, Rot, Circle, SlotOverall, Sketch, Text, Sphere,
                       HexLocations, Vector, extrude, fillet, chamfer, export_step, export_stl,
                       export_gltf, ExportDXF, Unit, Mode)

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
# Waveshare SIM7600G-H 4G HAT on 18 mm standoffs and a long-pin stacking
# header: over an Active Cooler a HAT needs 15 mm or more, and this one has a
# regulator and its SIM holder underneath. Its pins come through on top. At
# 17 mm the makers' own models put its SIM holder half a millimetre into the
# cooler's fan screws; 18 leaves a millimetre.
hat_gap = 18.0
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
corner_r = 12.0                # the box's corners as you face it
edge_front = 4.0               # the body's front edge, rounded: soft, not a box
edge_back = 1.2                # and its back edge
inner_r = corner_r - wall      # inside, following the outside, so the wall is even all round
batt_pad = 3.5                 # the battery stands on a pad, its corner clear of the inside curve
batt_room = 1.5                # spare round the battery front to back and side to side: Anker's
                               # figures are nominal, and a power bank is never a millimetre bigger
                               # than its box says by accident, but often half of one
backer = 1.6                   # the printed plate behind the front sheet's strip
side_room = 6.5                # beside the screen, each side: the touch plug on the left
cable_gap = 4.0                # behind the screen: the touch cable and the video ribbon
strip_h = 48.0                 # the strip under the screen, base included
pill = (68.0, 17.0)            # the sensor window under the screen, a cream pill
lip = 1.6                      # the front's thickness in front of the screen's glass
screen_border = 2.5            # the screen's own black glass showing round its picture
logo_depth = 0.8               # the wordmark, pressed in and filled cream
pocket_gap = 0.2               # round each acrylic piece in its pocket

insert_dia = 4.2               # the brass M3 x 4 inserts, 4.2 across
insert_depth = 5.0
screw_dia = 3.4                # M3 clearance
pi_screw_dia = 2.7             # M2.5 clearance
pi_spacer = 5.0                # back sheet to the Pi's board
m2_pilot = 1.7                 # M2 screws cut their own thread in these
post_len = 9.0                 # the back's corner posts

led_dia = 3.1                  # a 3 mm LED pushes in and stops on its rim. Test-cut first.
wordmark = 'Flux'
wordmark_size = 7.5

# The ports on the back, each a panel-mount extension to the part inside.
chg_hole = 12.2                # CHARGE: Adafruit #6069 USB-C round panel mount, M12 thread
chg_body = (12.0, 30.0)        # across, and how far it reaches in with its bend
usb_cut = (26.5, 12.3)         # USB: Adafruit #4055 snap-in USB-A extension, its cutout
usb_body = (18.6, 13.0, 36.0)  # its body behind the panel: across, up, deep
lan_cut = (16.5, 14.0)         # ETHERNET: panel-mount RJ45 extension, the jack's face
lan_ear_dx = 30.0              # its two screw ears, centre to centre
lan_body = (20.0, 18.0, 32.0)  # MEASURE when in hand: across, up, deep

# The power board between the battery and the Pi: 52Pi's "RPi5 PD Power"
# (EP-0225). A Pi 5 wants 5 V at 5 A and a power bank's own 5 V stops at 3 A,
# which leaves the Pi's USB ports on a trickle; this asks the battery for 15 V
# over USB-C PD and gives the Pi 5.15 V at 5 A through its USB-C, which the
# Pi reads as a full supply. The board is the Pi's size with the Pi's four
# holes, and stands on the four M2.5 x 18 brass pillars it comes with.
# 52Pi's drawing: 87 x 57 over its connectors.
pd_pcb = (85.0, 56.0, 1.6)
pd_pillar = 18.0
pd_parts_h = 4.0               # most of its parts; the capacitor and the jacks stand taller
pd_out_u = 12.6                # MEASURE: its OUTPUT USB-C, on the bottom edge, from the left
pd_in_v = 24.4                 # MEASURE: its INPUT USB-C, on the right edge, up from the bottom

mount_nut_af = 11.4            # a 1/4"-20 hex nut, across its flats, with clearance
mount_nut_th = 5.8
mount_boss = 20.0
# The arm bought for the wall: CAMVATE's 1/4"-20 mini ball head on a post
# (sold as a pair, 24007), 120 mm tall in all, measured off CAMVATE's
# drawing: an oval foot 50 x 28 x 5 with two screw holes, a 13.3 mm post, the
# ball head (a 23 mm body with a wing knob, and a slot that lets it tilt 90
# degrees), a 22 mm knurled wheel, and a 1/4"-20 screw about 7.3 mm proud of
# the wheel. Rated 2 kg; the box is about 1.4. On the wall the post stands
# out level and the head tilts up through its slot, so the screw stands
# about 90 mm off the wall: far enough for the box to sit on it by the nut
# in its base, its back about 40 mm clear of the wall.
# The nut sits 1 mm above the base's outside so that short screw takes all
# of it; 4 mm up, where it first was, the screw caught well under half.
mount_floor = 1.0
arm_screw = 7.3                # MEASURE: the screw past the knurled wheel; the nut's depth assumes it
arm_wheel = (22.0, 4.6)        # diameter, thickness
arm_ball = 8.5                 # radius; its centre 15.7 under the wheel
arm_head = (23.0, 23.3)        # the ball head's body: diameter, length
arm_post = (13.3, 65.0)        # diameter, length
arm_foot = (50.0, 28.0, 5.0)
arm_tilt = 15.0                # how far the box looks down at the door, on the wall

# The stand: a cream wedge the box leans back on, like a desk display. One
# 1/4"-20 screw up through it into the box's mount nut holds them together;
# without it the box stands upright on its own or goes on the wall mount.
tilt = 12.0                    # degrees the box leans back on the stand
stand_w = 130.0                # narrower than the box, so the box floats over it
stand_back = 5.0               # its height under the box's back edge
stand_inset = 6.0              # how far it stands back from the box's front face
stand_seat = 5.5               # from the screw head's seat up to the box's base
stand_screw_len = 15.9         # 1/4"-20 x 5/8": through 5.5 of stand, the base and all of the nut

# ===========================================================================
# DERIVED. Nothing below here is a setting.
# ===========================================================================

IN_W = screen_outer_w + 2 * side_room
BOX_W = IN_W + 2 * wall
BOX_H = strip_h + screen_outer_h + 2.0 + wall
IN_X0, IN_X1 = wall, BOX_W - wall
IN_Z0, IN_Z1 = wall, BOX_H - wall

SL_Y0 = lip                                # the screen's glass, just behind the front's lip
FRONT_Y = plate + backer                   # back face of the strip's backer
SCREEN_Y1 = SL_Y0 + screen_thick           # back of the screen
LAY_Y0 = SCREEN_Y1 + cable_gap             # the layer behind the screen starts here
BATT_Y1 = LAY_Y0 + batt_thk
SL_Y1 = BATT_Y1 + batt_room                # the sleeve's back
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

# The sensors in the pill, centred as a group: the eye, the counter, the light.
EYE_X = BOX_W / 2 - 18.5
PT3_X0 = EYE_X - pt3_w / 2
PT3_Z0 = IN_Z0 + usbc_plug_room
EYE = (EYE_X, PT3_Z0 + pt3_h - pt3_lepton_top)
PT3_FACE = FRONT_Y + 0.5 + lepton_h        # the PT3 board's Lepton side
TOF_C = (EYE[0] + 26.5, EYE[1])
TOF_FACE = FRONT_Y + 0.3 + tof_sensor_h    # the counter board's sensor side
LED_POS = (TOF_C[0] + 16.5, EYE[1])
PILL_C = (BOX_W / 2, EYE[1])
# The front's opening: the picture, and a thin border of the screen's own glass.
OPENING = (SCREEN_X0 + screen_border_l - screen_border, SCREEN_Z0 + screen_border_b - screen_border,
           screen_active_w + 2 * screen_border, screen_active_h + 2 * screen_border)
# The wordmark, low in the strip under the pill.
LOGO_C = (BOX_W / 2, (IN_Z0 + PILL_C[1] - pill[1] / 2) / 2 + 1.0)

BATT_X0 = IN_X0 + batt_pad
BATT_X1 = BATT_X0 + batt_wid
BATT_Z0 = IN_Z0 + batt_pad
BATT_Z1 = BATT_Z0 + batt_len

PI_X0 = IN_X1 - 24.5 - pi_w
PI_ZBOT = IN_Z0 + 13.5
PI_BACK = SL_Y1 - pi_spacer
PI_FRONT = PI_BACK - pi_pcb
PI_HOLES = [(PI_X0 + pi_hole_inset + hx, PI_ZBOT + pi_hole_inset + hy)
            for hx in (0, pi_hole_dx) for hy in (0, pi_hole_dy)]

# Forward on the right wall, so the power board's input plug passes behind it.
DBM_C = (SL_Y1 - 39.5, PI_ZBOT + pi_d + 12.0 + dbm_h / 2)   # (y, z) of its centre, on the right wall
# The port panel, high on the back, clear of the power board and the Pi.
IO_Z = IN_Z1 - 21.0
CHG_POS = (106.0, IO_Z)
USB_POS = (129.0, IO_Z)
LAN_POS = (156.0, IO_Z)
# The power board on the back sheet over the Pi: high enough that the
# right-angle plug under its output clears the Pi's header, and under the
# port panel. Its parts face forward.
PD_X0 = PI_X0
PD_Z0 = PI_ZBOT + pi_d + 7.0
PD_Y1 = SL_Y1 - pd_pillar                  # its back face, on the pillars
PD_Y0 = PD_Y1 - pd_pcb[2]                  # its front face
PD_HOLES = [(PD_X0 + pi_hole_inset + hx, PD_Z0 + pi_hole_inset + hy)
            for hx in (0, pi_hole_dx) for hy in (0, pi_hole_dy)]
PD_OUT = (PD_X0 + pd_out_u, PD_Y0 - 1.7, PD_Z0)            # opening down
PD_IN = (PD_X0 + pd_pcb[0], PD_Y0 - 1.7, PD_Z0 + pd_in_v)  # opening right
# As near the box's balance point as the base allows: the battery's weight
# pulls it left, and the battery's own footprint is the one place a boss
# cannot go. Clear of the camera's plug in front and the 4G board's behind.
MOUNT_C = (88.0, LAY_Y0 + 7.9)

CORNER_IN = wall + 4.5
# The lower left one moves in past the battery, which stands in that corner.
BACK_HOLES = [(CORNER_IN, BOX_H - CORNER_IN), (BOX_W - CORNER_IN, BOX_H - CORNER_IN),
              (BATT_X1 + batt_room + 4.6, CORNER_IN), (BOX_W - CORNER_IN, CORNER_IN)]


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

def screen_opening():
    x, z, w, h = OPENING
    return Pos(x + w / 2, z + h / 2) * RectangleRounded(w, h, 2.5)


def pill_outline(grow=0.0):
    return Pos(*PILL_C) * RectangleRounded(pill[0] + 2 * grow, pill[1] + 2 * grow, pill[1] / 2 + grow - 0.01)


def sleeve():
    # The body: a solid with soft front and back edges, then hollowed. Its
    # front is a 4.6 mm face. Over the screen it thins to a 1.6 mm lip, the
    # screen pressed up behind it, its opening showing the picture and a thin
    # border of the screen's own glass. Under it, a pocket for the sensor pill
    # and the wordmark pressed in.
    body = slab(face_outline(), 0, SL_Y1)
    front_edges = [e for e in body.edges() if abs(e.center().Y) < 1e-3]
    back_edges = [e for e in body.edges() if abs(e.center().Y - SL_Y1) < 1e-3]
    body = fillet(front_edges, edge_front)
    body = fillet([e for e in body.edges() if abs(e.center().Y - SL_Y1) < 1e-3], edge_back)
    outer = body
    body -= slab(face_outline(wall, inner_r), FRONT_Y, SL_Y1 + 1)
    body -= span(SCREEN_X0 - 0.5, SCREEN_X0 + screen_outer_w + 0.5, SL_Y0, FRONT_Y + 1,
                 SCREEN_Z0 - 0.5, SCREEN_Z0 + screen_outer_h + 0.5)
    body -= slab(screen_opening(), -1, SL_Y0 + 0.01)
    body -= slab(pill_outline(pocket_gap), -1, plate)
    body -= slab(logo_sketch(), -1, logo_depth)

    # The camera's four posts and the counter's two, M2 screws from behind.
    # Each sinks half a millimetre into the backer so they print as one.
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = EYE[0] + sx * pt3_hole_dx / 2, PT3_Z0 + pt3_h / 2 + sz * pt3_hole_dy / 2
            body += cyl_y(x, FRONT_Y - 0.5, z, 4.6, PT3_FACE - FRONT_Y + 0.5)
    for s in (-1, 1):
        x, z = TOF_C[0] + s * tof_hole_dx / 2, TOF_C[1] + tof_hole_off
        body += cyl_y(x, FRONT_Y - 0.5, z, 4.0, TOF_FACE - FRONT_Y + 0.5)

    # The screen's four posts, from the lip back to its ears, ribbed to the
    # top wall or down into the strip.
    for x, z in SCREEN_HOLES:
        body += cyl_y(x, SL_Y0 - 0.5, z, 8.0, EAR_Y0 - SL_Y0 + 0.5)
        if z > BOX_H / 2:
            body += span(x - 1.5, x + 1.5, SL_Y0 - 0.5, EAR_Y0, z, IN_Z1 + 0.5)
        else:
            body += span(x - 1.5, x + 1.5, SL_Y0 - 0.5, EAR_Y0, SCREEN_Z0 - 2.0, z)

    # The back's four posts, filled to the walls they sit against.
    for x, z in BACK_HOLES:
        body += cyl_y(x, SL_Y1 - post_len, z, 9.0, post_len)
        # A web to the nearer floor or roof; the rounded corners hold the rest.
        body += span(x - 4.5, x + 4.5, SL_Y1 - post_len, SL_Y1, z, IN_Z0 - 0.5 if z < BOX_H / 2 else IN_Z1 + 0.5)

    # A wall the battery stands against, so it cannot lean into the Pi, and
    # the pad it stands on.
    body += span(BATT_X1 + batt_room, BATT_X1 + batt_room + 1.6, LAY_Y0 + 6, SL_Y1 - post_len - 1, IN_Z0 - 0.5, IN_Z0 + 70)
    body += span(BATT_X0 + 2, BATT_X1 - 2, LAY_Y0 + 2, BATT_Y1 - 2, IN_Z0 - 0.5, BATT_Z0)

    # The sound meter's frame on the right wall.
    fy, fz = DBM_C
    frame = span(IN_X1 - 2.0, IN_X1 + 0.5, fy - dbm_w / 2 - 1.6, fy + dbm_w / 2 + 1.6,
                 fz - dbm_h / 2 - 1.6, fz + dbm_h / 2 + 1.6)
    frame -= span(IN_X1 - 2.1, IN_X1 + 0.1, fy - dbm_w / 2 - 0.2, fy + dbm_w / 2 + 0.2,
                  fz - dbm_h / 2 - 0.2, fz + dbm_h / 2 + 0.2)
    body += frame

    # The mount's boss, a 1/4"-20 nut dropped in from inside.
    body += cyl_z(MOUNT_C[0], MOUNT_C[1], 0, mount_boss, mount_floor + mount_nut_th + 1.0)

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

    # The eye, the counter's window and the light, through the ledge behind
    # the pill, the same size as the pill's own holes so the eye looks
    # straight into the dark.
    body -= cyl_y(EYE[0], plate - 1, EYE[1], eye_dia(), backer + 2)
    tw, th = tof_window()
    body -= slab(Pos(*TOF_C) * RectangleRounded(tw, th, min(tw, th) / 2 - 0.01), plate - 1, FRONT_Y + 1)
    body -= cyl_y(LED_POS[0], plate - 1, LED_POS[1], 4.2, backer + 2)

    # The meter hears the room through the right wall.
    body -= cyl_x(IN_X1 - 1, fy - dbm_w / 2 + dbm_port[0], fz - dbm_h / 2 + dbm_port[1], 2.5, wall + 2)

    # The mount: the bolt's hole up through the base, and the nut's pocket.
    body -= cyl_z(MOUNT_C[0], MOUNT_C[1], -1, 6.8, 20)
    nut = extrude(Plane.XY.offset(mount_floor) * Pos(*MOUNT_C) * RegularHex(mount_nut_af), amount=20)
    body -= nut

    # No vents in the body: the top, the sides and the front stay clean, and
    # the air goes in low and out high through dot grilles in the back sheet.
    # Nothing added inside may show outside: trim to the rounded outline.
    return body & outer


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

def pill_cut_sketch():
    """The sensor pill: the eye, the counter's window, the light."""
    sk = pill_outline()
    sk -= Pos(*EYE) * Circle(eye_dia() / 2)
    tw, th = tof_window()
    sk -= Pos(*TOF_C) * RectangleRounded(tw, th, min(tw, th) / 2 - 0.01)
    sk -= Pos(*LED_POS) * Circle(led_dia / 2)
    return sk


def front_cut_sketch():
    """What the laser cuts for the front, if the pill is cut rather than printed."""
    return pill_cut_sketch()


def logo_sketch():
    return Pos(*LOGO_C) * Text(wordmark, font_size=wordmark_size * 1.38, font_path=flat_font(FONT_WORDMARK),
                               align=(Align.CENTER, Align.CENTER))


def eye_dia():
    return cone(lepton_lens, lepton_half, 0.5 + backer + plate) + 0.5


def tof_window():
    return (cone(tof_sensor[0], tof_half, 0.3 + backer + plate), cone(tof_sensor[1], tof_half, 0.3 + backer + plate))


def front_engrave_sketch():
    """Nothing is engraved on the pill."""
    return None


def back_cut_sketch():
    """Seen from behind: a = BOX_W - x, b = z."""
    def a(x):
        return BOX_W - x
    sk = face_outline()
    for x, z in BACK_HOLES:
        sk -= Pos(a(x), z) * Circle(screw_dia / 2)
    for x, z in PI_HOLES:
        sk -= Pos(a(x), z) * Circle(pi_screw_dia / 2)
    for x, z in PD_HOLES:
        sk -= Pos(a(x), z) * Circle(pi_screw_dia / 2)
    sk -= Pos(a(CHG_POS[0]), CHG_POS[1]) * Circle(chg_hole / 2)
    sk -= Pos(a(USB_POS[0]), USB_POS[1]) * RectangleRounded(usb_cut[0], usb_cut[1], 1.0)
    sk -= Pos(a(LAN_POS[0]), LAN_POS[1]) * RectangleRounded(lan_cut[0], lan_cut[1], 0.8)
    for s in (-1, 1):
        sk -= Pos(a(LAN_POS[0] + s * lan_ear_dx / 2), LAN_POS[1]) * Circle(1.6)
    # Air: in low behind the Pi's board, out high over it. Two fields of
    # 2.6 mm holes on a hex grid, the look of a speaker cloth, not a radio's slots.
    for cx, cz, nx, nz in ((PI_X0 + 34.0, PI_ZBOT + 25.0, 10, 8), (PI_X0 + 42.5, 112.0, 16, 7)):
        dots = [loc * Circle(1.3) for loc in HexLocations(2.4, nx, nz)]
        sk -= Pos(a(cx), cz) * sum(dots[1:], dots[0])
    return sk


def back_engrave_sketch():
    def label(txt, pos):
        return Pos(BOX_W - pos[0], pos[1] + 12.5) * Text(
            txt, font_size=3.0 * 1.38, font_path=flat_font(FONT_LABEL), align=(Align.CENTER, Align.CENTER))
    label = label('CHARGE', CHG_POS) + label('USB', USB_POS) + label('ETHERNET', LAN_POS)
    mark = Pos(BOX_W - (PI_X0 + pi_w / 2), PI_ZBOT + pi_d + 10) * Text(
        'Flux', font_size=7 * 1.38, font_path=flat_font(FONT_WORDMARK), align=(Align.CENTER, Align.CENTER))
    return label + mark


def logo_inlay():
    """The wordmark as its own part, filling its 0.8 mm pocket: printed in cream
    on a multi-colour printer, or painted in with a cream paint pen instead."""
    return slab(logo_sketch(), 0, logo_depth)


def sensor_pill():
    return slab(pill_cut_sketch(), 0, plate)


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
    """The strip, cut out of the sleeve, laid on its front to print: the
    pill's pocket, the camera's and the counter's posts, the light's hole."""
    piece = whole & span(PILL_C[0] - pill[0] / 2 - 8, PILL_C[0] + pill[0] / 2 + 8, 0, PT3_FACE + 1,
                         IN_Z0, strip_h - 3.3)
    return Rot(90, 0, 0) * piece


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
    b = span(BATT_X0, BATT_X1, LAY_Y0, BATT_Y1, BATT_Z0, BATT_Z1)
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
    # The four USB-A: camera, touch, modem, and the back's USB port. Below
    # them the Ethernet, through a right-angle RJ45 adapter to the back's port.
    return pi_box(88.0, 108.0, 21.5, 54.6, -1.0, 17.0) + pi_box(88.0, 106.0, 1.0, 19.5, -1.0, 15.0)


def meter_body():
    fy, fz = DBM_C
    return span(IN_X1 - dbm_stack, IN_X1 - 0.8, fy - dbm_w / 2, fy + dbm_w / 2, fz - dbm_h / 2, fz + dbm_h / 2)


def pd_board():
    """52Pi's RPi5 PD Power board on its four pillars: the board, its low
    parts, and the ones that stand taller (the capacitor, the DC jack, the
    two USB-C and the white 4-pin header)."""
    x0, z0 = PD_X0, PD_Z0
    w, h, _ = pd_pcb
    front = PD_Y0
    part = span(x0, x0 + w, front, PD_Y1, z0, z0 + h)
    part += span(x0 + 4, x0 + w - 4, front - pd_parts_h, front, z0 + 4, z0 + h - 4)
    part += cyl_y(x0 + 44.0, front - 10.0, z0 + 38.0, 8.0, 10.0)
    part += span(x0 + w - 12, x0 + w + 1.5, front - 11, front, z0 + 4, z0 + 14)
    part += span(x0 + w - 7.5, x0 + w + 1.0, front - 3.4, front, z0 + pd_in_v - 4.5, z0 + pd_in_v + 4.5)
    part += span(x0 + pd_out_u - 4.5, x0 + pd_out_u + 4.5, front - 3.4, front, z0 - 1.0, z0 + 7.5)
    part += span(x0 + w - 9, x0 + w - 1, front - 8, front, z0 + 30, z0 + 50)
    for px, pz in PD_HOLES:
        part += cyl_y(px, PD_Y1, pz, 5.5, pd_pillar)
    return part


def usb_jack():
    x, z = USB_POS
    w, h, d = usb_body
    return span(x - w / 2, x + w / 2, SL_Y1 - d, SL_Y1, z - h / 2, z + h / 2)


def lan_jack():
    x, z = LAN_POS
    w, h, d = lan_body
    return span(x - w / 2, x + w / 2, SL_Y1 - d, SL_Y1, z - h / 2, z + h / 2)


def charge_jack():
    x, z = CHG_POS
    return span(x - chg_body[0] / 2, x + chg_body[0] / 2, SL_Y1 - chg_body[1], SL_Y1, z - chg_body[0] / 2, z + chg_body[0] / 2)


def led_body():
    return cyl_y(LED_POS[0], FRONT_Y - 1.5, LED_POS[1], 3.8, 7)


def mount_nut():
    return extrude(Plane.XY.offset(mount_floor) * Pos(*MOUNT_C) * RegularHex(mount_nut_af - 0.4), amount=mount_nut_th)


# ===========================================================================
# THE CABLES. Every connection, routed where it runs: a tube along the path,
# from the plug at one end to the plug at the other. Points are (x, y, z) in
# the box's frame; the routes keep to the gaps the layout leaves for them.
# ===========================================================================

def _usb_port(stack, front):
    """The mouth of one of the Pi's USB-A ports: lower or upper pair, the port
    nearer the board or the one in front of it."""
    z = PI_ZBOT + (29.0 if stack == 'lower' else 47.0)
    y = PI_FRONT - (4.2 if not front else 11.6)
    return (PI_X0 + 88.0, y, z)


def _pin(n):
    """Where a jumper leaves pin n of the 40, on top of the 4G HAT."""
    col = (n - 1) // 2
    inner = n % 2 == 1
    return (PI_X0 + 8.4 + col * 2.54, PI_FRONT - hat_gap - hat_pcb - hat_pins_h - 2,
            PI_ZBOT + (51.23 if inner else 53.77))


HAT_USB = (PI_X0 + 11.8, PI_FRONT - hat_gap - hat_pcb - 1.5, PI_ZBOT - 12.0)
PI_USBC = (PI_X0 + 11.2, PI_FRONT + 1.0, PI_ZBOT - 12.0)
PI_HDMI = (PI_X0 + 25.8, PI_FRONT - 1.7, PI_ZBOT - 10.0)
PI_LAN = (PI_X0 + 88.0, PI_FRONT - 7.0, PI_ZBOT + 10.2)
HAT_MAIN = (PI_X0 + 24.6, PI_FRONT - hat_gap - hat_pcb - 1.0, PI_ZBOT + 3.6)
BATT_PORTS = ((BATT_X0 + 18, BATT_Y1 - 26, BATT_Z1 + 8), (BATT_X0 + 34, BATT_Y1 - 26, BATT_Z1 + 8))
ANTENNA = (IN_X1 - 0.4, 24.0, 52.0, 8.0, 30.0)   # x, y0, y1, z0, z1: stuck inside the right wall

CABLES = {
    # name: (diameter, kind, points)
    'Cable: camera to Pi USB': (4.0, 'data', [
        (EYE[0], PT3_FACE - 2, IN_Z0 + 4), (EYE[0], 24, IN_Z0 + 4), (EYE[0] + 4, 28, 14),
        (150, 28, 14), (171, 30, 26), (172, 40, 40), (_usb_port('lower', True)[0] + 14, _usb_port('lower', True)[1], 45),
        _usb_port('lower', True)]),
    'Cable: screen touch to Pi USB': (4.0, 'data', [
        (IN_X0 + 2.5, SCREEN_Y1 - 1, SCREEN_Z0 + screen_touch_z), (IN_X0 + 2.5, SCREEN_Y1 + 2, SCREEN_Z0 + screen_touch_z),
        (150, SCREEN_Y1 + 2, SCREEN_Z0 + screen_touch_z), (170, 18, 78), (172, 48, 70),
        (_usb_port('upper', False)[0] + 14, _usb_port('upper', False)[1], _usb_port('upper', False)[2]),
        _usb_port('upper', False)]),
    'Cable: 4G modem to Pi USB': (4.0, 'data', [
        HAT_USB, (HAT_USB[0], HAT_USB[1], IN_Z0 + 3), (100, 41.5, IN_Z0 + 3), (150, 41.5, IN_Z0 + 3),
        (168, 44, 14), (174, 50, 36), (_usb_port('lower', False)[0] + 14, _usb_port('lower', False)[1], 45),
        _usb_port('lower', False)]),
    'Cable: back USB port to Pi USB': (4.0, 'data', [
        (USB_POS[0], SL_Y1 - usb_body[2], USB_POS[1]), (USB_POS[0], SL_Y1 - usb_body[2] - 6, USB_POS[1]),
        (USB_POS[0], 24, USB_POS[1] - 10),
        (142, 30, 120), (144, 32, 90), (150, 34, 78), (168, 46, 76),
        (_usb_port('upper', True)[0] + 14, _usb_port('upper', True)[1], _usb_port('upper', True)[2]),
        _usb_port('upper', True)]),
    'Cable: back Ethernet port to Pi Ethernet': (5.0, 'data', [
        (LAN_POS[0], SL_Y1 - lan_body[2], LAN_POS[1]), (LAN_POS[0], SL_Y1 - lan_body[2] - 6, LAN_POS[1]),
        (LAN_POS[0] - 4, 28, LAN_POS[1] - 12),
        (150, 34, 118), (150, 32, 80), (174, 56, 74), (175, 57, 40), (PI_LAN[0] + 16, PI_LAN[1], PI_LAN[2]), PI_LAN]),
    'Cable: back CHARGE port to battery': (4.5, 'power', [
        (CHG_POS[0], SL_Y1 - chg_body[1], CHG_POS[1]), (CHG_POS[0], SL_Y1 - chg_body[1] - 6, CHG_POS[1]),
        (CHG_POS[0] - 6, 30, CHG_POS[1] + 8),
        (75, 38, 160), (BATT_PORTS[1][0] + 4, BATT_PORTS[1][1], 160), BATT_PORTS[1]]),
    # Up out of the battery, over the port panel, down the right side behind
    # the meter, and into the board's input from the right.
    'Cable: battery to PD board': (4.5, 'power', [
        BATT_PORTS[0], (BATT_PORTS[0][0], BATT_PORTS[0][1], 158), (40, 30, 164), (160, 30, 164),
        (172, 36, 150), (172, PD_IN[1], 114), (PD_IN[0] + 14, PD_IN[1], PD_IN[2]), PD_IN]),
    # Right-angle plugs at both ends: off the board's output, left over the
    # top of the Pi, down behind the end of the battery's wall (the gap beside
    # it is narrower than the cable), and under the Pi into its USB-C.
    'Cable: PD board to Pi USB-C': (4.5, 'power', [
        PD_OUT, (PD_OUT[0], PD_OUT[1], PD_OUT[2] - 3.5), (PI_X0 - 1.5, 54, PD_OUT[2] - 3.5),
        (PI_X0 - 2.1, 61, PI_ZBOT + pi_d), (PI_X0 - 2.1, 61, PI_ZBOT), (PI_X0 + 6, 56, 11),
        (PI_USBC[0] - 3, PI_USBC[1] - 3, 9), PI_USBC]),
    'Cable: screen video ribbon to Pi HDMI': (2.0, 'ribbon', [
        (SCREEN_X0 + screen_fpc_x + 4, SCREEN_Y1 + 1, SCREEN_Z0 + 15), (PI_X0 - 2, SCREEN_Y1 + 1.5, SCREEN_Z0 + 15),
        (PI_X0 - 2, 18.6, 46), (PI_X0 - 2, 26, 30), (PI_X0 - 2, 30, 13), (PI_X0 + 4, 50, 12),
        (PI_HDMI[0], 54, PI_HDMI[2]), PI_HDMI]),
    'Cable: Qwiic to door counter': (2.0, 'i2c', [
        _pin(3), (_pin(3)[0], 30, 60), (TOF_C[0], 31, TOF_C[1] + tof_h / 2 + 4), (TOF_C[0], 30, TOF_C[1] + 2)]),
    'Cable: Qwiic to sound meter': (2.0, 'i2c', [
        _pin(5), (_pin(5)[0] + 2, 30, 78), (140, 30, 84), (IN_X1 - dbm_stack - 1, DBM_C[0], DBM_C[1])]),
    'Cable: LINK light': (1.6, 'light', [
        _pin(18), (_pin(18)[0], 26, 58), (LED_POS[0], 20, LED_POS[1] + 8), (LED_POS[0], FRONT_Y + 6, LED_POS[1])]),
    'Cable: 4G antenna lead': (1.4, 'antenna', [
        HAT_MAIN, (HAT_MAIN[0], 36, 14), (140, 30, 14), (ANTENNA[0] - 2, 34, 14)]),
}


def tube(points, d):
    """A cable: straight runs between the points, rounded at every bend."""
    pts = [Vector(*q) for q in points]
    r = d / 2
    out = None
    for a, b in zip(pts, pts[1:]):
        v = b - a
        if v.length < 0.01:
            continue
        seg = Location(Plane(origin=a, z_dir=v)) * Cylinder(r, v.length, align=(Align.CENTER, Align.CENTER, Align.MIN))
        out = seg if out is None else out + seg
    for q in pts[1:-1]:
        out += Pos(q) * Sphere(r)
    return out


def cable_part(name):
    d, _, points = CABLES[name]
    return tube(points, d)


def antenna_body():
    x, y0, y1, z0, z1 = ANTENNA
    return span(x - 0.3, x, y0, y1, z0, z1)


def hard_parts(sl, back):
    """Everything solid a cable or the stand's screw must not pass through."""
    return {'sleeve': sl, 'back sheet': back, 'screen': screen_body(), 'battery': battery_body(),
            'Pi': pi_board() + pi_ports(), 'cooler': cooler_body(), '4G board': hat_body(),
            'camera': camera_body(), 'counter': counter_body(), 'sound meter': meter_body(),
            'PD board': pd_board(), 'charging port': charge_jack(), 'USB port': usb_jack(),
            'Ethernet port': lan_jack(), 'mount nut': mount_nut()}


def screw_report(hard):
    """The stand's screw must reach through the whole nut, and what sticks
    out above the nut must touch nothing: no part, no cable. The arm's
    short screw must take the whole nut too."""
    nut_top = mount_floor + mount_nut_th
    tip = -stand_seat + stand_screw_len
    if tip < nut_top - 0.01:
        return [f'the stand screw stops {nut_top - tip:.1f} mm short of the top of the nut']
    if arm_screw - mount_floor < mount_nut_th:
        return [f'the arm\'s {arm_screw} mm screw takes only {arm_screw - mount_floor:.1f} mm of the nut']
    above = cyl_z(MOUNT_C[0], MOUNT_C[1], nut_top + 0.01, 6.35, tip - nut_top)
    found = []
    others = dict(hard)
    others.update({n: cable_part(n) for n in CABLES})
    for name, part in others.items():
        common = above & part
        if common and sum(s.volume for s in common.solids()) > 0.01:
            found.append(f'the stand screw\'s tip touches {name}')
    return found


def cable_report(hard):
    """Cables are flexible, so they may touch each other and the room left for
    plugs, but not pass through anything solid. Each is checked without its
    last 5 mm at either end, where it is plugged in."""
    found = []
    for name, (d, _, points) in CABLES.items():
        pts = [Vector(*q) for q in points]
        a, b = pts[0], pts[-1]
        pts[0] = a + (pts[1] - a).normalized() * min(5.0, (pts[1] - a).length * 0.5)
        pts[-1] = b + (pts[-2] - b).normalized() * min(5.0, (pts[-2] - b).length * 0.5)
        body = tube([(q.X, q.Y, q.Z) for q in pts], d * 0.9)
        for hname, h in hard.items():
            common = body & h
            vol = sum(s.volume for s in common.solids()) if common else 0.0
            if vol > 0.05:
                found.append((name, hname, vol, common.bounding_box()))
    return found


# ===========================================================================
# THE STAND, in the box's frame: the box leans back `tilt` degrees on it.
# Drawn on the table first, a wedge under the box's base, and then carried
# into the box's frame so it travels with the box in the assembly.
# ===========================================================================

def stand_world_lift():
    """How high the box's front bottom edge sits on the stand."""
    return stand_back + BOX_D * math.sin(math.radians(tilt))


def box_to_world():
    """The box's frame to the table's, sitting on its stand."""
    return Pos(0, 0, stand_world_lift()) * Rot(-tilt, 0, 0)


def stand():
    t_ = math.radians(tilt)
    h = stand_world_lift()
    depth = BOX_D * math.cos(t_)
    x0 = (BOX_W - stand_w) / 2
    # On the table: a block, then the slope the box's base rests on cut off
    # its top, then its edges rounded.
    block = span(x0, x0 + stand_w, stand_inset, depth + 4.0, 0, h + 2)
    slope = Pos(0, 0, h) * Rot(-tilt, 0, 0) * span(-10, BOX_W + 10, -20, BOX_D + 40, 0, 40)
    part = block - slope
    vertical = [e for e in part.edges() if e.geom_type.name == 'LINE' and abs(e.tangent_at(0.5).Z) > 0.99]
    part = fillet(vertical, 8.0)
    # The screw's way up, drawn in the box's frame so it is square to the
    # box's base and lines up with the nut: a clearance hole, and a pocket
    # from underneath wide enough for a thumbscrew's head.
    x, y = MOUNT_C
    way = cyl_z(x, y, -60, 6.8, 60) + cyl_z(x, y, -80, 20.0, 80 - stand_seat)
    return part - box_to_world() * way


def stand_screw():
    """The 1/4"-20 x 5/8" screw up through the stand into the mount nut, in the box's frame."""
    x, y = MOUNT_C
    return cyl_z(x, y, -stand_seat - 6.35, 9.5, 6.35) + cyl_z(x, y, -stand_seat, 6.35, stand_screw_len)


BACK_FACE = SL_Y1 + plate          # the back sheet's outside


def _arm_parts():
    """The CAMVATE arm on the wall, holding the box by the nut in its base,
    the box tilted down `arm_tilt` at the door. In the box's frame: what
    holds the box (screw, wheel, stem, ball) is square to its base; the
    head's body, the post, the foot and the wall are turned back by the tilt
    about the ball, so that once the box is tilted they stand square to the
    floor and the post sticks straight out of the wall."""
    x, y = MOUNT_C
    wheel_d, wheel_t = arm_wheel
    bz = -(wheel_t + 15.7)                          # the ball's centre
    steel = cyl_z(x, y, 0, 6.35, arm_screw) + cyl_z(x, y, bz, 6.0, -bz - wheel_t + 0.5)
    wheel = cyl_z(x, y, -wheel_t, wheel_d, wheel_t)
    for i in range(36):                             # the knurling
        a = math.radians(i * 10)
        wheel -= cyl_z(x + wheel_d / 2 * math.cos(a), y + wheel_d / 2 * math.sin(a), -wheel_t - 0.1, 1.2, wheel_t + 0.2)
    ball = Pos(x, y, bz) * Sphere(arm_ball)
    # Level, back toward the wall: the head's collar and body (with the slot
    # the stem tilts up through), the wing knob, the post, the oval foot.
    hd, hl = arm_head
    post_d, post_l = arm_post
    head = cyl_y(x, y - 3.2, bz, 17.7, 3.4) + cyl_y(x, y + 0.2, bz, hd, hl)
    head -= Pos(x, y + 2.0, bz + hd / 2) * Box(7.0, 14.0, hd)
    knob = cyl_x(x + hd / 2 - 0.5, y + 12.0, bz, 5.0, 4.5) + Pos(x + hd / 2 + 9.5, y + 12.0, bz) * Box(11.0, 7.0, 23.0)
    post = cyl_y(x, y + 0.2 + hl - 0.5, bz, post_d, post_l + 1.0)
    foot_y = y + 0.2 + hl + post_l
    foot_plane = Plane(origin=(x, foot_y, bz), x_dir=(0, 0, 1), z_dir=(0, 1, 0))
    foot = extrude(foot_plane * SlotOverall(arm_foot[0], arm_foot[1]), amount=arm_foot[2])
    for s in (-1, 1):
        foot -= cyl_y(x, foot_y - 0.1, bz + s * 19.0, 4.5, arm_foot[2] + 0.2)
    wall_y = foot_y + arm_foot[2]
    wall = span(-60, BOX_W + 60, wall_y, wall_y + 14, -150, BOX_H + 90)
    turn = Pos(x, y, bz) * Rot(-arm_tilt, 0, 0) * Pos(-x, -y, -bz)
    level = turn * (head + knob + post + foot)
    return {'black': wheel + ball + level, 'level': level, 'steel': steel, 'wall': turn * wall}


def camera_arm():
    return _arm_parts()['black']


def camera_arm_steel():
    return _arm_parts()['steel']


def wall_part():
    return _arm_parts()['wall']


def arm_report(sl, back):
    """On the wall, tilted down at the door, the box must clear the arm's
    head, its post and the wall."""
    parts = _arm_parts()
    found = []
    for aname in ('level', 'wall'):
        for bname, b in (('sleeve', sl), ('back sheet', back)):
            common = parts[aname] & b
            if common and sum(s.volume for s in common.solids()) > 0.01:
                found.append(f'on the wall, the arm\'s {aname} part touches the {bname}')
    return found


def arm_world_lift():
    """How far the box is lifted so the wall's foot stands on the floor."""
    return -(Rot(arm_tilt, 0, 0) * wall_part()).bounding_box().min.Z


def stand_in_box_frame():
    return box_to_world().inverse() * stand()


# ===========================================================================
# THE CLASH CHECK: every pair of parts that must not overlap, intersected.
# ===========================================================================

INSIDE = {
    'screen': screen_body, 'battery': battery_body, 'battery plugs': battery_plugs,
    'Pi': lambda: pi_board() + pi_ports(), 'cooler': cooler_body, '4G board': hat_body,
    'jumpers': jumpers, 'Pi lower plugs': pi_low_plugs, 'Pi USB plugs': pi_usb_plugs,
    'camera': camera_body, 'camera plug': camera_plug, 'counter': counter_body,
    'counter leads': counter_leads, 'sound meter': meter_body, 'PD board': pd_board,
    'charging port': charge_jack, 'USB port': usb_jack, 'Ethernet port': lan_jack,
    'light': led_body, 'mount nut': mount_nut,
    'touch plug': touch_plug, 'touch cable': touch_cable, 'video ribbon': video_ribbon,
}
# What each part is meant to touch: what it is fixed to or plugged into.
ALLOWED = {
    frozenset(p) for p in [
        ('sleeve', 'camera'), ('sleeve', 'counter'), ('sleeve', 'sound meter'), ('sleeve', 'light'),
        ('sleeve', 'mount nut'), ('sleeve', 'touch plug'), ('sleeve', 'video ribbon'),
        ('back sheet', 'PD board'),
        ('back sheet', 'charging port'), ('sleeve', 'charging port'),
        ('back sheet', 'USB port'), ('back sheet', 'Ethernet port'),
        ('camera', 'camera plug'), ('counter', 'counter leads'),
        ('Pi', 'cooler'), ('Pi', 'jumpers'), ('Pi', 'Pi lower plugs'), ('Pi', 'Pi USB plugs'),
        ('cooler', '4G board'), ('4G board', 'jumpers'), ('4G board', 'Pi lower plugs'),
        ('jumpers', 'Pi lower plugs'), ('battery', 'battery plugs'),
        ('screen', 'touch plug'), ('screen', 'video ribbon'), ('screen', 'touch cable'),
        ('touch plug', 'touch cable'),
    ]
}


def clash_report(sleeve_part, front, back):
    parts = {'sleeve': sleeve_part, 'sensor pill': front, 'back sheet': back}
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
NAVY = Color(15 / 255, 23 / 255, 42 / 255)        # the brand's --navy, #0f172a
CABLE_COLOURS = {'data': Color(0.84, 0.85, 0.87), 'power': Color(0.88, 0.48, 0.25),
                 'ribbon': Color(0.79, 0.64, 0.15), 'i2c': Color(0.23, 0.51, 0.96),
                 'light': Color(0.13, 0.77, 0.37), 'antenna': Color(0.6, 0.62, 0.66)}
CREAM = Color(244 / 255, 239 / 255, 227 / 255)    # the brand's --cream, #f4efe3


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
        labelled(sleeve_part, 'Body (printed, navy)', NAVY),
        labelled(front, 'Sensor pill (cream)', CREAM),
        labelled(logo_inlay(), 'Flux wordmark (cream)', CREAM),
        labelled(back, 'Back sheet (navy)', NAVY),
        labelled(usb_jack(), 'USB port', Color(0.75, 0.75, 0.78)),
        labelled(lan_jack(), 'Ethernet port', Color(0.75, 0.75, 0.78)),
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
        labelled(pd_board(), 'RPi5 PD Power board (52Pi)', Color(0.08, 0.08, 0.09)),
        labelled(charge_jack(), 'CHARGE port', Color(0.85, 0.85, 0.85)),
        labelled(led_body(), 'LINK light', Color(0.5, 0.95, 0.5)),
        labelled(mount_nut(), '1/4-20 mount nut', Color(0.7, 0.7, 0.72)),
        labelled(brass_inserts(), 'Brass M3 inserts (8)', Color(0.85, 0.66, 0.25)),
        labelled(antenna_body(), '4G antenna (flexible)', Color(0.6, 0.62, 0.66)),
        labelled(stand_in_box_frame(), 'Stand (printed, cream)', CREAM),
        labelled(stand_screw(), 'Stand screw (1/4-20 x 5/8)', Color(0.66, 0.67, 0.7)),
        labelled(camera_arm(), 'CAMVATE wall arm (24007)', Color(0.07, 0.07, 0.08)),
        labelled(camera_arm_steel(), 'Arm screw and stem', Color(0.75, 0.76, 0.78)),
        labelled(wall_part(), 'Wall (for scale)', Color(0.92, 0.91, 0.89)),
    ] + [labelled(cable_part(n), n, CABLE_COLOURS[CABLES[n][1]]) for n in CABLES]
    return Compound(children=parts, label='Flux')


# ===========================================================================

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--check', action='store_true', help='only the clash check')
    args = ap.parse_args()

    print(f'box {BOX_W:.1f} x {BOX_H:.1f} x {BOX_D:.1f} mm')
    sl = sleeve()
    front, back = sensor_pill(), back_sheet()
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
    hard = hard_parts(sl, back)
    bad = cable_report(hard)
    for a, b, vol, bb in bad:
        print(f'  CABLE {a} through {b}: {vol:.2f} mm3 at x {bb.min.X:.1f}..{bb.max.X:.1f} '
              f'y {bb.min.Y:.1f}..{bb.max.Y:.1f} z {bb.min.Z:.1f}..{bb.max.Z:.1f}')
    if bad:
        sys.exit(f'{len(bad)} cable route(s) pass through a part')
    print('cable check: every cable clears every part')
    for problem in screw_report(hard):
        sys.exit(problem)
    print('stand check: the screw takes the whole nut and touches nothing past it')
    for problem in arm_report(sl, back):
        sys.exit(problem)
    print('wall check: tilted down on the arm, the box clears the arm and the wall')
    if args.check:
        return

    # (written by export.py from here, which owns the file layout)
    return sl, front, back


if __name__ == '__main__':
    main()
