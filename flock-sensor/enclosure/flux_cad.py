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

# The screen: ROADOM 7 inch 1024x600 HDMI (board Z3-7), landscape. Its
# listing gives 6.5 x 4.8 in, 0.5 in deep; the 7 inch 1024x600 panel on it is
# the common 164.9 wide one with a 154.21 x 85.92 lit area. The board is 107
# tall with an ear 7.8 above and below; the holes are scaled off the maker's
# photo of its back (the HDMI socket's 15 mm shell as the ruler), within a
# couple of millimetres of the near-identical board Waveshare publishes
# (7inch HDMI LCD (C): 164.9 x 124.27, holes 156.9 x 114.96). An earlier
# 162 x 119 with holes 149 x 113, read against the lit area alone, was wrong.
screen_outer_w = 164.9
screen_outer_h = 122.7
screen_hole_dx = 157.6         # CHECK with a ruler, hole centre to hole centre, before the body
screen_hole_dy = 115.5
screen_active_w = 154.2        # the lit area: centred side to side on the panel,
screen_active_h = 85.9         # and a little lower than centre top to bottom
screen_border_l = 5.35
screen_border_b = 19.9
# On its back along its LEFT edge as you face it: the "5V+Touch" micro-USB,
# opening sideways out of that edge, and the flat HDMI ribbon socket at the
# bottom. Read off the maker's photograph of the back.
screen_touch_z = 47.3          # board bottom (the ears) to the "5V+Touch" port: 39.5 up the PCB, off the maker's photo
screen_touch_in = 2.0          # MEASURE: its mouth, in from the edge
screen_fpc_x = 12.0            # MEASURE: the ribbon socket, in from the left edge
screen_fpc_z0 = 16.0           # and up from the bottom: beside the HDMI socket, 25.8 up
screen_fpc_z1 = 34.0
glass_below = 11.3             # board bottom to the glass's lower edge: the ear, and half of 107 less 100
glass_above = 11.3             # glass's upper edge to the board top

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
# The counter counts by watching the floor: it learns how far away each of its
# 64 zones is when the doorway is empty and sees a person as a patch nearer
# than that. Looking straight out of the front, it saw the floor in 9 zones of
# 64 and flickered in the rest. So it sits tilted inside the box and looks out
# of a small angled chin at the bottom front corner: 50 degrees down from
# straight ahead, which with the wall arm's 15 makes 65, the floor from about
# 0.2 m to 2.4 m out from a box mounted 2.2 m up.
tof_tilt = 50.0
tof_chin_h = 9.0               # how far up the front the chin's facet reaches
tof_chin_w = 30.0              # its width
tof_chin_t = 5.2               # solid from the facet to the sensor's window face

# PCB Artists I2C decibel meter PRO: 19.05 x 26.67; the microphone hears
# through a hole in the board's bare back at (9.525, 11.09) from its corner.
dbm_w = 19.05
dbm_h = 26.67
dbm_port = (9.525, 11.09)
dbm_stack = 22.0               # board, connector, plug, and the wires' bend

# The table camera: Arducam 16MP IMX519 USB 3.0, autofocus, the kind with no
# microphone (Arducam B0471; Amazon B0CXTBXS1L). Arducam's spec table: a
# 34 x 34 board, 78 degrees across the diagonal, 65 side to side and 51 up and
# down, a USB-C socket (USB 3.2 Gen 1). It ships on a back cover with a tripod
# adapter: both come off, and the bare board sits in a cradle that holds it by
# its edges, so its mounting holes, which Arducam does not publish, are never
# needed. Everything else about the board is a guess until it is in hand.
cam_board = 34.0               # the board, square: Arducam's figure
cam_pcb = 1.6                  # MEASURE: the board's thickness
cam_lens_at = (17.0, 17.0)     # MEASURE: the lens's centre from the board's left and bottom edges, seen from the front
cam_lens_body = 8.5            # MEASURE: the autofocus lens module's square outline
cam_lens_h = 6.0               # MEASURE: the board's front face to the front of the lens
cam_aperture = 3.5             # MEASURE: the lens's clear glass, where its view starts
cam_front_parts = 1.0          # MEASURE: the tallest part on the board's front, round the lens
cam_back_parts = 3.2           # MEASURE: the tallest part on its back (the USB-C socket's own height)
cam_margin = 1.5               # MEASURE: the bare strip round the board's edge, front and back, that the cradle may touch
cam_usb_at = (17.0, 17.0)      # MEASURE: the USB-C socket's centre on the back, from the left and bottom edges seen from the front
cam_half_h = 32.5              # half its 65 degrees side to side
cam_half_v = 25.5              # half its 51 degrees up and down
usbc_ra = (12.5, 7.0, 14.0)    # a right-angle USB-C plug's body: across, up, and out from the board, its cable turning right

# The lens cover's servo: MG90S, metal gears (Amazon B0BWJ41FZB). Tower Pro's
# drawing: a 22.5 x 12 body, tabs 32.5 across, 21 from its base to the tabs,
# 35.5 to the top of the spline; sellers list 22.8 x 12.2 x 28.5 to the top of
# the gear boss. Its three wires (brown GND, red 5 V, orange signal) leave the
# end away from the shaft, low down.
srv_len = 22.8                 # its body, end to end
srv_wid = 12.2                 # and across
srv_case_h = 22.7              # MEASURE: base to the top of the case, under the gear boss
srv_boss_h = 28.5              # base to the top of the gear boss
srv_tab_span = 32.5            # the tabs, end to end
srv_tab_top = 21.0             # base to the tabs' top face (the drawing's 21)
srv_tab_t = 2.5                # MEASURE: the tabs' thickness
srv_hole_dx = 27.5             # MEASURE: the tabs' two screw holes, centre to centre (the common micro servo figure)
srv_shaft_in = 6.0             # MEASURE: the shaft's centre in from the body's near end
horn_reach = 9.0               # the one-arm horn from its kit, cut down to reach 9 from the shaft
horn_arm = (4.0, 1.6)          # MEASURE: the horn arm's width and thickness
horn_hub = (7.0, 3.5)          # MEASURE: the horn hub's diameter, and the horn's depth on the spline

# ===========================================================================
# STILL TO MEASURE
# ===========================================================================

screen_thick = 14.5           # front of the glass to the back of its HDMI socket: 12.7 listed, plus the socket
screen_glass_depth = 6.4       # front of the glass to the front of the ears (the PCB): the panel stack
plate = 3.175                  # the acrylic: Craftiff 1/8 in cast

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
pill = (76.0, 20.0)            # the sensor window under the screen, a cream pill: the eye, the light, the table camera
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
lan_ear_dx = 27.0              # its two screw ears, centre to centre: 27 on the common
                               # Cat6 screw-ear extensions' own drawings (27.5 on Adafruit #909)
lan_body = (21.0, 21.0, 32.0)  # iGreely's drawing: 21 across, square; deep, a similar jack's 28 and room

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
pd_out_u = 10.8                # its OUTPUT USB-C, on the bottom edge, from the left: 52Pi's scaled photo
pd_in_v = 21.0                 # its INPUT USB-C, on the right edge, up from the bottom: the same

# The table camera's cradle and its lens cover. The cover is a flap inside the
# box, between the front and the lens: from outside nobody can reach it, pry
# it or tape it open, and the front shows only a dark window. The flap turns
# on a pin in line with the servo's shaft, but the servo does not hold it: its
# horn pushes a peg on the flap open and leaves it alone on the way back, and
# a small spring pulls the flap shut against a stop. A slack servo, or one
# with no power or no signal, leaves the lens covered.
cam_clear = 0.3                # round the board in its cradle
bay_wall = 1.8                 # the cradle's walls
cam_lip = 1.2                  # the ledges the board's front rests on, over its bare edge
clamp_t = 1.6                  # the printed clamp that holds the board in from behind, two M2 screws
cam_grow = 0.5                 # the window, each side, past the camera's exact view
flap_t = 1.2                   # the flap's thickness
flap_blade = (12.0, 11.0)      # the part over the lens: 2 mm past its view each side at the flap
flap_tail = 6.0                # the spring's hole, out from the pin
flap_open = 45.0               # how far the flap turns open: enough to clear the whole view
horn_shut = 135.0              # the horn's angle at 1000 us, from straight right, anticlockwise seen from the front;
                               # 2000 us turns it 90 degrees clockwise. Its first 45 are slack: it only meets the flap's peg after that
spring_len = 12.0              # the spring, hook to hook, at rest with the flap shut: 3 mm across, about 10 mm of coil.
                               # Open, it stretches to 16.3
spring_front = 3.5             # room for it between the front and the flap

mount_nut_af = 11.4            # a 1/4"-20 hex nut, across its flats, with clearance
mount_nut_th = 5.8
mount_boss = 16.0               # round the nut: 1.4 of wall at its corners, and clear of the lens cover's servo
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
arm_screw = 6.3                # past the knurled wheel, scaled off CAMVATE's photo. Any length from 4 mm holds: past the nut there is nothing for 57 mm
arm_wheel = (24.5, 4.6)        # diameter, thickness
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
# The counter, in its own frame: the centre of its sensor's face at TOF_S,
# looking along TOF_N. It sits right of the wordmark, so the chin stays clear
# of the letters.
_t = math.radians(tof_tilt)
TOF_N = (0.0, -math.cos(_t), -math.sin(_t))
CHIN_D = tof_chin_h * math.tan(_t)          # how far back under the base the facet reaches
_off = tof_chin_t + 0.3
# Far right of the strip: its leads run back and up from the chin, and the
# table camera's cradle and servo fill the middle.
TOF_S = (BOX_W / 2 + 60.0, CHIN_D / 2 - _off * TOF_N[1], tof_chin_h / 2 - _off * TOF_N[2])
TOF_LOC = Pos(*TOF_S) * Rot(tof_tilt, 0, 0)
TOF_C = (TOF_S[0], TOF_S[2])
# The two eyes, mirrored about the middle of the pill: the heat camera on the
# left and the table camera on the right, level with each other and looking
# the same way, so they see the same room 37 mm apart. The light sits between
# them, where it reads as the box's own, and where anyone looking at the
# camera's window also sees whether the box is on.
PILL_C = (BOX_W / 2, EYE[1])
LED_POS = PILL_C
CAM_C = (BOX_W - EYE[0], EYE[1])           # the table camera's lens, (x, z)
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
# cannot go. Clear of the camera's plug in front, the 4G board's behind, and
# the lens cover's servo to its right.
MOUNT_C = (BOX_W / 2 - 3.0, LAY_Y0 + 7.9)

CORNER_IN = wall + 4.5
# The lower left one moves in past the battery, which stands in that corner.
BACK_HOLES = [(CORNER_IN, BOX_H - CORNER_IN), (BOX_W - CORNER_IN, BOX_H - CORNER_IN),
              (BATT_X1 + batt_room + 4.6, CORNER_IN), (BOX_W - CORNER_IN, CORNER_IN)]

# The table camera, front to back: the flap just behind the front with the
# spring in front of it, the servo's horn behind the flap, then the lens and
# its board. The board stands just behind the screen's back plane, because
# its top edge rises above the strip, behind the screen's lowest few
# millimetres.
CAM_Y0 = SCREEN_Y1 + 0.5 + cam_front_parts     # the board's front face
CAM_Y1 = CAM_Y0 + cam_pcb                       # its back face
CAM_LENS_Y = CAM_Y0 - cam_lens_h                # the front of the lens, where its view starts
CAM_X0 = CAM_C[0] - cam_lens_at[0]
CAM_Z0 = CAM_C[1] - cam_lens_at[1]
CAM_USB = (CAM_X0 + cam_usb_at[0], CAM_Z0 + cam_usb_at[1])
BAY_X0, BAY_X1 = CAM_X0 - cam_clear, CAM_X0 + cam_board + cam_clear
BAY_Z0 = CAM_Z0 - cam_clear
BAY_TOP = SCREEN_Z0 - 0.8                       # the cradle stops under the screen, which drops in past it
BAY_Y1 = CAM_Y1 - 0.1                           # the walls' back, a hair in front of the board's, so the clamp pinches it
SPRING_Y = FRONT_Y + spring_front / 2           # the spring's middle
FLAP_Y0 = FRONT_Y + spring_front
FLAP_Y1 = FLAP_Y0 + flap_t
HORN_Y0 = FLAP_Y1 + 0.6
HORN_Y1 = HORN_Y0 + horn_hub[1]                 # the top of the servo's gear boss
LIP_Y0 = HORN_Y0 + horn_arm[1] + 0.3            # the cradle's floor and ledges start behind the horn
SRV_YB = HORN_Y1 + srv_boss_h                   # the servo's base, its back end here
# The servo lies on its side on the floor under the cradle, its shaft forward,
# as far right as the part under the 4G board's lower edge (49.7 along it)
# lets its back end come.
SRV_X0 = PI_X0 + 49.7 - 0.4 - srv_len
SRV_Z0 = IN_Z0 + 0.8
SRV_AXIS = (SRV_X0 + srv_shaft_in, SRV_Z0 + srv_wid / 2)
SRV_TAB_Y0 = SRV_YB - srv_tab_top               # the tabs' front face, on two posts
SRV_HOLES = [(SRV_X0 + srv_len / 2 + s * srv_hole_dx / 2, SRV_AXIS[1]) for s in (-1, 1)]
FLAP_R = math.dist(CAM_C, SRV_AXIS)             # the pin to the middle of the lens
FLAP_A = math.degrees(math.atan2(CAM_C[1] - SRV_AXIS[1], CAM_C[0] - SRV_AXIS[0]))
# The peg the horn pushes: where the horn's side meets it 45 degrees after it
# starts, so the flap turns the last 45 of the horn's 90.
_contact = math.degrees(math.asin((horn_arm[0] / 2 + 1.2) / 6.0))
PEG_ANGLE = horn_shut - (90.0 - flap_open) - _contact
SPRING_POST = (SRV_AXIS[0] + flap_tail, SRV_AXIS[1] + spring_len)
# The stop, against the left side of the flap's arm 15 mm up it.
STOP_PIN = (SRV_AXIS[0] + 15 * math.cos(math.radians(FLAP_A)) - 3.5 * math.sin(math.radians(FLAP_A)),
            SRV_AXIS[1] + 15 * math.sin(math.radians(FLAP_A)) + 3.5 * math.cos(math.radians(FLAP_A)))
# The cradle's clamp screws, at its two bottom corners, outside the servo.
CLAMP_HOLES = [(BAY_X0 - 2.8, BAY_Z0 - 0.8), (BAY_X1 + 2.8, BAY_Z0 - 0.8)]
# Opening, the flap's corner passes through the cradle's right wall: a slot
# in the wall lets it, up to where the arc its far corner draws crosses it.
RW_HIGH = SRV_AXIS[1] + math.sqrt((FLAP_R + flap_blade[1] / 2) ** 2 + (flap_blade[0] / 2) ** 2
                                  - (BAY_X1 - SRV_AXIS[0]) ** 2) + 1.5


def cone(width, half_deg, depth):
    """The opening that clears a sensor's view at `depth` in front of it."""
    return width + 2 * depth * math.tan(math.radians(half_deg)) + 1.0


def cam_window(depth, grow=cam_grow):
    """The table camera's view, across and up, at `depth` in front of its lens."""
    return (cam_aperture + 2 * depth * math.tan(math.radians(cam_half_h)) + 2 * grow,
            cam_aperture + 2 * depth * math.tan(math.radians(cam_half_v)) + 2 * grow)


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


def turn(axis, deg):
    """A turn about a line front to back through axis (x, z), anticlockwise
    as seen from the front by `deg`."""
    ax, az = axis
    return Pos(ax, 0, az) * Rot(0, -deg, 0) * Pos(-ax, 0, -az)


def cam_view(length, grow=0.0, back=0.0):
    """The table camera's view: a rectangular pyramid from its lens out of the
    front, `length` long, `grow` wider each side than its exact view. `back`
    starts it that far behind the lens front, at the same size."""
    from build123d import loft
    y0 = CAM_LENS_Y + back
    w0, h0 = cam_window(0, grow)
    w1, h1 = cam_window(length, grow)
    near = Plane(origin=(CAM_C[0], y0, CAM_C[1]), x_dir=(1, 0, 0), z_dir=(0, -1, 0)) * Rectangle(w0, h0)
    mid = Plane(origin=(CAM_C[0], CAM_LENS_Y, CAM_C[1]), x_dir=(1, 0, 0), z_dir=(0, -1, 0)) * Rectangle(w0, h0)
    far = Plane(origin=(CAM_C[0], CAM_LENS_Y - length, CAM_C[1]), x_dir=(1, 0, 0), z_dir=(0, -1, 0)) * Rectangle(w1, h1)
    view = loft([mid, far])
    if back > 0:
        view += loft([near, mid])
    return view


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

    # The camera's four posts, M2 screws from behind. Each sinks half a
    # millimetre into the backer so they print as one.
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = EYE[0] + sx * pt3_hole_dx / 2, PT3_Z0 + pt3_h / 2 + sz * pt3_hole_dy / 2
            body += cyl_y(x, FRONT_Y - 0.5, z, 4.6, PT3_FACE - FRONT_Y + 0.5)

    # The counter's chin: the bottom front corner filled solid a little wider
    # than the chin, then scooped back to a facet square to its view, its two
    # ends rounded into the corner so it reads as a shaped window and never
    # opens into the box.
    body += outer & (TOF_LOC * span(-tof_chin_w / 2 - 2.0, tof_chin_w / 2 + 2.0, -_off - 80, -0.3, -80, 80))
    scoop = Plane(origin=(0, 0, -80), x_dir=(1, 0, 0), z_dir=(0, 0, 1)) * \
        Pos(0, -_off - 40) * RectangleRounded(tof_chin_w, 80, 5.0)
    body -= TOF_LOC * extrude(scoop, amount=160)
    # Its two posts, square to the board, M2 screws from behind.
    for sx in (-1, 1):
        body += TOF_LOC * cyl_y(sx * tof_hole_dx / 2, -0.8, tof_hole_off, 4.0, 0.8 + tof_sensor_h)

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

    body += table_camera_bay()

    # --- cuts ---
    for x, z in SCREEN_HOLES:
        body -= cyl_y(x, EAR_Y0 - insert_depth, z, insert_dia, insert_depth + 0.01)
    for x, z in BACK_HOLES:
        body -= cyl_y(x, SL_Y1 - insert_depth - 2, z, insert_dia, insert_depth + 2.01)
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = EYE[0] + sx * pt3_hole_dx / 2, PT3_Z0 + pt3_h / 2 + sz * pt3_hole_dy / 2
            body -= cyl_y(x, FRONT_Y + 0.2, z, m2_pilot, 20)
    for sx in (-1, 1):
        body -= TOF_LOC * cyl_y(sx * tof_hole_dx / 2, -_off + 1.0, tof_hole_off, m2_pilot, 20)

    # The eye, the counter's window and the light, through the ledge behind
    # the pill, the same size as the pill's own holes so the eye looks
    # straight into the dark.
    body -= cyl_y(EYE[0], plate - 1, EYE[1], eye_dia(), backer + 2)
    body -= tof_view_cut()
    body -= cyl_y(LED_POS[0], plate - 1, LED_POS[1], 4.2, backer + 2)
    # The table camera's window, its view and half a millimetre, from the lens
    # out; and a notch in the cradle's left wall for the light's wires.
    body -= cam_view(CAM_LENS_Y + 1, cam_grow)
    body -= span(BAY_X0 - bay_wall - 0.5, BAY_X0 + cam_lip + 0.1, FRONT_Y - 1, LIP_Y0 + 1.5,
                 LED_POS[1] - 2.8, LED_POS[1] + 2.8)
    # Pilot holes: the clamp's two screws and the servo's two, all M2 from behind.
    for x, z in CLAMP_HOLES:
        body -= cyl_y(x, BAY_Y1 - 8, z, m2_pilot, 8.01)
    for x, z in SRV_HOLES:
        body -= cyl_y(x, SRV_TAB_Y0 - 8, z, m2_pilot, 8.01)

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


def table_camera_bay():
    """The table camera's cradle and the flap's posts, part of the body.

    The board drops in from behind onto three ledges (left, right and under
    it) that touch only its bare edge, between two walls and on a floor that
    locate it to 0.3 mm, and a printed clamp screwed on behind presses it onto
    them. Every wall runs front to back, so the body still prints face down
    with no supports: the slot the flap swings through in the right wall is
    bridged over at its top, and the floor starts behind the horn, bridged
    between the two walls."""
    wl = span(BAY_X0 - bay_wall, BAY_X0, FRONT_Y - 0.5, BAY_Y1, BAY_Z0 - bay_wall, BAY_TOP)
    wr = span(BAY_X1, BAY_X1 + bay_wall, FRONT_Y - 0.5, BAY_Y1, BAY_Z0 - bay_wall, BAY_TOP)
    floor = span(BAY_X0 - bay_wall, BAY_X1 + bay_wall, LIP_Y0, BAY_Y1, BAY_Z0 - bay_wall, BAY_Z0)
    ledges = (span(BAY_X0 - 0.1, BAY_X0 + cam_lip, LIP_Y0, CAM_Y0, BAY_Z0 - 0.1, BAY_TOP) +
              span(BAY_X1 - cam_lip, BAY_X1 + 0.1, LIP_Y0, CAM_Y0, BAY_Z0 - 0.1, BAY_TOP) +
              span(BAY_X0 - 0.1, BAY_X1 + 0.1, LIP_Y0, CAM_Y0, BAY_Z0 - 0.1, BAY_Z0 + cam_lip))
    part = wl + wr + floor + ledges
    for x, z in CLAMP_HOLES:
        part += cyl_y(x, FRONT_Y - 0.5, z, 4.6, BAY_Y1 - FRONT_Y + 0.5)
    # The slot the flap swings through, in the right wall and its clamp boss.
    part -= span(BAY_X1 - 1, CLAMP_HOLES[1][0] + 3.3, FLAP_Y0 - 0.5, FLAP_Y1 + 0.5, BAY_Z0 - bay_wall - 4, RW_HIGH)
    # The servo's two posts, to the front faces of its tabs.
    for x, z in SRV_HOLES:
        part += cyl_y(x, FRONT_Y - 0.5, z, 4.0, SRV_TAB_Y0 - FRONT_Y + 0.5)
    # The flap's pin, in line with the servo's shaft and stopping short of its
    # horn; the stop the flap's arm rests on, shut; the spring's post, capped.
    part += cyl_y(SRV_AXIS[0], FRONT_Y - 0.5, SRV_AXIS[1], 3.0, FLAP_Y1 + 0.3 - FRONT_Y + 0.5)
    part += cyl_y(STOP_PIN[0], FRONT_Y - 0.5, STOP_PIN[1], 2.4, FLAP_Y1 + 0.3 - FRONT_Y + 0.5)
    part += cyl_y(SPRING_POST[0], FRONT_Y - 0.5, SPRING_POST[1], 2.0, FLAP_Y0 - 0.3 - FRONT_Y + 0.5)
    part += cyl_y(SPRING_POST[0], FLAP_Y0 - 1.0, SPRING_POST[1], 3.6, 0.7)
    return part


def flap_sketch():
    """The flap, shut, drawn in (x, z): its hub on the pin, the arm up to the
    blade over the lens, and the tail the spring pulls."""
    ax, az = SRV_AXIS
    sk = Pos(ax, az) * Circle(3.4)
    sk += Pos((ax + CAM_C[0]) / 2, (az + CAM_C[1]) / 2) * Rot(0, 0, FLAP_A) * Rectangle(FLAP_R, 4.0)
    sk += Pos(*CAM_C) * RectangleRounded(flap_blade[0], flap_blade[1], 2.5)
    sk += Pos(ax + flap_tail / 2, az) * SlotOverall(flap_tail + 3.5, 3.5)
    sk -= Pos(ax, az) * Circle(1.7)
    sk -= Pos(ax + flap_tail, az) * Circle(0.7)
    return sk


def lens_flap(open_deg=0.0):
    """The flap, turned `open_deg` clockwise (seen from the front) from shut,
    with the peg the horn pushes standing out of its back."""
    a = math.radians(PEG_ANGLE)
    peg = cyl_y(SRV_AXIS[0] + 6.0 * math.cos(a), FLAP_Y1 - 0.2, SRV_AXIS[1] + 6.0 * math.sin(a), 2.4,
                HORN_Y0 + horn_arm[1] - 0.2 - FLAP_Y1 + 0.2)
    return turn(SRV_AXIS, -open_deg) * (slab(flap_sketch(), FLAP_Y0, FLAP_Y1) + peg)


def servo_horn(deg=horn_shut):
    """The servo's one-arm horn at `deg`, anticlockwise from straight right."""
    ax, az = SRV_AXIS
    reach = horn_reach - horn_arm[0] / 2
    arm = Pos(ax, az) * Rot(0, 0, deg) * Pos(reach / 2, 0) * SlotOverall(reach + horn_arm[0], horn_arm[0])
    return slab(arm, HORN_Y0, HORN_Y0 + horn_arm[1]) + cyl_y(ax, HORN_Y0, az, horn_hub[0], horn_hub[1])


def horn_at(open_deg):
    """Where the horn stands when the flap is `open_deg` open."""
    return horn_shut - (90.0 - flap_open) - open_deg


def flap_spring(open_deg=0.0):
    """The spring, from the flap's tail to its post, in front of the flap."""
    a = math.radians(-open_deg)
    tail = (SRV_AXIS[0] + flap_tail * math.cos(a), SPRING_Y, SRV_AXIS[1] + flap_tail * math.sin(a))
    return tube([tail, (SPRING_POST[0], SPRING_Y, SPRING_POST[1])], 3.0)


def servo_body():
    """The MG90S lying on its side, shaft forward: its case, the tabs on the
    two posts, the gear boss and the spline the horn presses onto."""
    x0, z0 = SRV_X0, SRV_Z0
    case = span(x0, x0 + srv_len, SRV_YB - srv_case_h, SRV_YB, z0, z0 + srv_wid)
    cx = x0 + srv_len / 2
    tabs = span(cx - srv_tab_span / 2, cx + srv_tab_span / 2, SRV_TAB_Y0, SRV_TAB_Y0 + srv_tab_t, z0, z0 + srv_wid)
    for x, z in SRV_HOLES:
        tabs -= cyl_y(x, SRV_TAB_Y0 - 1, z, 2.0, srv_tab_t + 2)
    boss = cyl_y(SRV_AXIS[0], HORN_Y1, SRV_AXIS[1], srv_wid, SRV_YB - srv_case_h - HORN_Y1)
    spline = cyl_y(SRV_AXIS[0], HORN_Y1 - 3.0, SRV_AXIS[1], 4.8, 3.0)
    return case + tabs + boss + spline


def table_camera_body():
    """The Arducam board: the board, the lens module on its front, the parts
    round the lens, and the parts and USB-C socket on its back."""
    x0, z0, m = CAM_X0, CAM_Z0, cam_margin
    board = span(x0, x0 + cam_board, CAM_Y0, CAM_Y1, z0, z0 + cam_board)
    lens = span(CAM_C[0] - cam_lens_body / 2, CAM_C[0] + cam_lens_body / 2, CAM_LENS_Y, CAM_Y0,
                CAM_C[1] - cam_lens_body / 2, CAM_C[1] + cam_lens_body / 2)
    front = span(x0 + m, x0 + cam_board - m, CAM_Y0 - cam_front_parts, CAM_Y0, z0 + m, z0 + cam_board - m)
    back = span(x0 + m + 0.2, x0 + cam_board - m - 0.2, CAM_Y1, CAM_Y1 + cam_back_parts,
                z0 + m + 0.2, z0 + cam_board - m - 0.2)
    return board + lens + front + back


def table_camera_plug():
    """A right-angle USB-C plug in the board's socket, its cable turning right."""
    ux, uz = CAM_USB
    return span(ux - usbc_ra[0] / 2, ux + usbc_ra[0] / 2, CAM_Y1 + 0.6, CAM_Y1 + usbc_ra[2],
                uz - usbc_ra[1] / 2, uz + usbc_ra[1] / 2)


def clamp_sketch():
    """The clamp, in (x, z): a frame over the board's bare edge with an
    opening for its back parts and the plug, and two ears for its screws."""
    m = cam_margin
    sk = Pos((BAY_X0 + BAY_X1) / 2, (BAY_Z0 + CAM_Z0 + cam_board + cam_clear) / 2) * \
        RectangleRounded(BAY_X1 - BAY_X0, CAM_Z0 + cam_board + cam_clear - BAY_Z0, 1.5)
    for x, z in CLAMP_HOLES:
        sk += Pos(x, z) * Circle(2.6)
        sk += Pos((x + (BAY_X0 + 2 if x < CAM_C[0] else BAY_X1 - 2)) / 2, z + 1.4) * \
            Rectangle(abs((BAY_X0 + 2 if x < CAM_C[0] else BAY_X1 - 2) - x), 2.8)
    sk -= Pos(CAM_X0 + cam_board / 2, CAM_Z0 + cam_board / 2) * RectangleRounded(cam_board - 2 * m, cam_board - 2 * m, 1.0)
    for x, z in CLAMP_HOLES:
        sk -= Pos(x, z) * Circle(1.2)
    return sk


def camera_clamp():
    return slab(clamp_sketch(), CAM_Y1, CAM_Y1 + clamp_t)


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
    """The sensor pill: the eye, the light, and the table camera's window,
    its view at the pill's face and half a millimetre. The counter looks out
    of the chin."""
    sk = pill_outline()
    sk -= Pos(*EYE) * Circle(eye_dia() / 2)
    sk -= Pos(*LED_POS) * Circle(led_dia / 2)
    sk -= Pos(*CAM_C) * RectangleRounded(*cam_window(CAM_LENS_Y), 1.0)
    return sk


def front_cut_sketch():
    """What the laser cuts for the front, if the pill is cut rather than printed."""
    return pill_cut_sketch()


def logo_sketch():
    return Pos(*LOGO_C) * Text(wordmark, font_size=wordmark_size * 1.38, font_path=flat_font(FONT_WORDMARK),
                               align=(Align.CENTER, Align.CENTER))


def eye_dia():
    return cone(lepton_lens, lepton_half, 0.5 + backer + plate) + 0.5


def tof_view_cut(length=None, half=None):
    """The counter's view, from the sensor out. Short and at the diagonal's
    angle, it is the window cut through the chin; long and at the true 22.5
    degrees each way, it is what nothing outside the box may stand in."""
    sk = Plane(origin=(0, -0.3, 0), x_dir=(1, 0, 0), z_dir=(0, -1, 0)) * \
        RectangleRounded(tof_sensor[0] + 2.0, tof_sensor[1] + 2.0, 1.0)
    return TOF_LOC * extrude(sk, amount=_off + 1.5 if length is None else length,
                             taper=-(tof_half if half is None else half))


def tof_sight():
    """The counter's real view, 3 m of it."""
    return tof_view_cut(3000, 22.5)


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
    m = 8                      # a frame around the screen, small enough for any bed
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
    pill's pocket, the heat camera's posts, the light's hole, the table
    camera's window and cradle with the flap's pin, stop and spring post and
    the servo's two posts, and the counter's chin with its two posts."""
    piece = whole & span(PILL_C[0] - pill[0] / 2 - 8, TOF_S[0] + tof_chin_w / 2 + 2,
                         0, max(PT3_FACE + 1, CHIN_D + 6, SRV_TAB_Y0), 0, BAY_TOP)
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
    return TOF_LOC * (span(-tof_w / 2, tof_w / 2, tof_sensor_h, tof_sensor_h + 1.6, -tof_h / 2, tof_h / 2) +
                      span(-tof_sensor[0] / 2, tof_sensor[0] / 2, 0, tof_sensor_h,
                           -tof_sensor[1] / 2, tof_sensor[1] / 2))


TOF_LEADS = tof_sensor_h + 1.6 + 6 + jumper_h - 4      # the leads' far end, behind the sensor


def tof_point(lx, ly, lz):
    """A point given in the counter's own frame, in the box's."""
    v = (TOF_LOC * Pos(lx, ly, lz)).position
    return (v.X, v.Y, v.Z)


def counter_leads():
    return TOF_LOC * span(-tof_w / 2, tof_w / 2, tof_sensor_h + 1.6, TOF_LEADS, -tof_h / 2, tof_h / 2)


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
# The 4G antenna: a stick-on LTE strip, 95 x 14 on its own drawing, standing
# on end inside the right wall behind the sound meter, its u.FL lead off the
# bottom end. x, y0, y1, z0, z1.
ANTENNA = (IN_X1 - 0.1, DBM_C[0] + dbm_w / 2 + 2.1, DBM_C[0] + dbm_w / 2 + 16.1, 11.0, 106.0)

CABLES = {
    # name: (diameter, kind, points)
    # The Pi 5 has four USB-A ports and the box has five things for them. The
    # table camera takes a blue USB 3 port (the pair next to the Ethernet); the
    # heat camera takes the one the back's USB port had, over the servo and
    # behind the door counter's leads, and the back's USB port is left with
    # its lead coiled, unplugged.
    'Cable: heat camera to Pi USB': (4.0, 'data', [
        (EYE[0], PT3_FACE - 2, IN_Z0 + 4), (EYE[0], 24, IN_Z0 + 4), (EYE[0] + 4, 28, 14),
        (88, 26, 19), (132, 26, 19), (136, 39.5, 19), (166, 46, 20), (174, 50, 40), (174, 52, 60),
        (_usb_port('upper', True)[0] + 14, _usb_port('upper', True)[1], _usb_port('upper', True)[2]),
        _usb_port('upper', True)]),
    'Cable: table camera to Pi USB 3': (4.0, 'data', [
        (CAM_USB[0] + usbc_ra[0] / 2, CAM_Y1 + 10, CAM_USB[1]), (CAM_USB[0] + usbc_ra[0] / 2 + 6, CAM_Y1 + 10, CAM_USB[1]),
        (124, 30, 37), (138, 33, 42), (160, 40, 44), (172, 44, 45),
        (_usb_port('lower', True)[0] + 14, _usb_port('lower', True)[1], 45),
        _usb_port('lower', True)]),
    # The servo's three wires, from the end of its case away from the shaft,
    # up past the door counter's leads to the Pi's header: red to pin 4 (5 V),
    # brown to pin 14 (GND), orange to pin 16 (GPIO 23). TABLE_SHUTTER_GPIO=23.
    'Cable: lens cover servo to Pi pins': (2.0, 'light', [
        (SRV_X0 + srv_len, SRV_YB - 3, SRV_AXIS[1]), (SRV_X0 + srv_len + 4, SRV_YB - 3.5, SRV_AXIS[1]),
        (133, 34, 20), (133, 33, 40), (120, 33, 56), (_pin(16)[0], 33, 62), _pin(16)]),
    'Cable: screen touch to Pi USB': (4.0, 'data', [
        (IN_X0 + 2.5, SCREEN_Y1 - 1, SCREEN_Z0 + screen_touch_z), (IN_X0 + 2.5, SCREEN_Y1 + 2, SCREEN_Z0 + screen_touch_z),
        (150, SCREEN_Y1 + 2, SCREEN_Z0 + screen_touch_z), (170, 18, 78), (172, 48, 70),
        (_usb_port('upper', False)[0] + 14, _usb_port('upper', False)[1], _usb_port('upper', False)[2]),
        _usb_port('upper', False)]),
    'Cable: 4G modem to Pi USB': (4.0, 'data', [
        HAT_USB, (HAT_USB[0], HAT_USB[1], IN_Z0 + 3), (100, 45.0, IN_Z0 + 3), (150, 45.0, IN_Z0 + 3),
        (168, 46, 14), (174, 50, 36), (_usb_port('lower', False)[0] + 14, _usb_port('lower', False)[1], 45),
        _usb_port('lower', False)]),
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
        _pin(3), (_pin(3)[0], 34, 60), (TOF_C[0], 34, 44), tof_point(0, TOF_LEADS + 3, 0),
        tof_point(0, TOF_LEADS - 2, 0)]),
    'Cable: Qwiic to sound meter': (2.0, 'i2c', [
        _pin(5), (_pin(5)[0] + 2, 30, 78), (140, 30, 84), (IN_X1 - dbm_stack - 1, DBM_C[0], DBM_C[1])]),
    'Cable: counter select': (1.6, 'light', [
        _pin(22), (_pin(22)[0], 30, 58), (TOF_C[0] + 4, 34, 44), tof_point(4, TOF_LEADS + 3, 0),
        tof_point(4, TOF_LEADS - 2, 0)]),
    'Cable: LINK light': (1.6, 'light', [
        _pin(18), (_pin(18)[0], 30, 62), (BAY_X0 - bay_wall - 3.4, 24, 50), (BAY_X0 - bay_wall - 3.4, 14, 40),
        (BAY_X0 - bay_wall - 3.4, LIP_Y0 + 0.5, LED_POS[1]), (LED_POS[0], FRONT_Y + 6, LED_POS[1])]),
    'Cable: 4G antenna lead': (1.4, 'antenna', [
        HAT_MAIN, (HAT_MAIN[0], 40, 18), (138, 36, 18), (ANTENNA[0] - 2.5, (ANTENNA[1] + ANTENNA[2]) / 2, ANTENNA[3] + 4)]),
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
    return span(x - 1.2, x, y0, y1, z0, z1)


def hard_parts(sl, back):
    """Everything solid a cable or the stand's screw must not pass through."""
    return {'sleeve': sl, 'back sheet': back, 'screen': screen_body(), 'battery': battery_body(),
            'Pi': pi_board() + pi_ports(), 'cooler': cooler_body(), '4G board': hat_body(),
            'camera': camera_body(), 'counter': counter_body(), 'sound meter': meter_body(),
            'PD board': pd_board(), 'charging port': charge_jack(), 'USB port': usb_jack(),
            'Ethernet port': lan_jack(), 'mount nut': mount_nut(), 'antenna': antenna_body(),
            'table camera': table_camera_body(), 'camera clamp': camera_clamp(), 'servo': servo_body(),
            'lens flap': lens_flap()}


def screw_report(hard):
    """The stand's screw must reach through the whole nut, and what sticks
    out above the nut must touch nothing: no part, no cable. The arm's
    short screw must take at least four of the nut's threads (1.27 mm each),
    which holds a 1.4 kg box many times over."""
    nut_top = mount_floor + mount_nut_th
    tip = -stand_seat + stand_screw_len
    if tip < nut_top - 0.01:
        return [f'the stand screw stops {nut_top - tip:.1f} mm short of the top of the nut']
    if arm_screw - mount_floor < 4 * 1.27:
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
    # The counter looks down past the stand's front edge; the edge is scooped
    # where its view would graze it.
    return part - box_to_world() * (way + tof_view_cut(200, 22.5 + 3))


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


def cam_sight():
    """The table camera's real view, 3 m of it."""
    return cam_view(3000)


def eye_sight():
    """The heat camera's view, its 71 degree diagonal as a cone, 3 m of it."""
    sk = Plane(origin=(EYE[0], FRONT_Y + 0.5, EYE[1]), x_dir=(1, 0, 0), z_dir=(0, -1, 0)) * Circle(lepton_lens / 2)
    return extrude(sk, amount=3000, taper=-lepton_half)


def sight_report(sl, back, front=None):
    """Nothing may stand in the counter's view, the heat camera's or the table
    camera's: not the box, not the stand on a table, not the arm or the wall,
    and not the lens cover once it is open."""
    parts = _arm_parts()
    found = []
    others = [('box', sl), ('back sheet', back), ('stand', stand_in_box_frame()),
              ('arm', parts['black']), ('wall', parts['wall'])]
    if front is not None:
        others.append(('sensor pill', front))
    views = (('doorway counter', tof_sight(), others),
             ('heat camera', eye_sight(), others),
             ('table camera', cam_sight(), others + [('open lens cover', lens_flap(flap_open)),
                                                     ('servo horn', servo_horn(horn_at(flap_open)))]))
    for vname, view, things in views:
        for name, part in things:
            common = view & part
            if common and sum(s_.volume for s_ in common.solids()) > 0.01:
                found.append(f'the {name} is in the {vname}\'s view')
    return found


def shutter_report(sl):
    """The lens cover, shut and on its way open. Shut, it covers the whole of
    the camera's view where it crosses it. Turning, at every step of the way
    and with the horn wherever it is then, neither the flap, the horn nor the
    spring may touch the body or any part (the flap's pin, the spring's post
    and the horn's own spline aside), and the horn only meets the flap's peg
    in the second half of its travel."""
    found = []
    crossing = cam_view(CAM_LENS_Y - FLAP_Y0) & span(0, BOX_W, FLAP_Y0 + 0.05, FLAP_Y1 - 0.05, 0, BOX_H)
    left = crossing - lens_flap(0)
    if left and sum(s.volume for s in left.solids()) > 0.001:
        found.append('shut, the lens cover leaves part of the camera\'s view open')
    others = {'table camera': table_camera_body(), 'camera clamp': camera_clamp(), 'servo': servo_body(),
              'heat camera': camera_body(), 'door counter': counter_body(), 'light': led_body(),
              'counter leads': counter_leads()}
    steps = [(0.0, horn_shut), (0.0, horn_shut - 22.5)] + \
        [(f, horn_at(f)) for f in (0.0, flap_open / 4, flap_open / 2, 3 * flap_open / 4, flap_open)]
    for f, h in steps:
        flap, horn, spring = lens_flap(f), servo_horn(h), flap_spring(f)
        for pname, p, skip in (('lens cover', flap, ()), ('servo horn', horn, ('servo',)),
                               ('flap spring', spring, ())):
            for oname, o in [('body', sl)] + list(others.items()):
                if oname in skip or (pname == 'flap spring' and oname == 'body'):
                    continue
                common = p & o
                if common and sum(s.volume for s in common.solids()) > 0.01:
                    found.append(f'{f:.0f} degrees open, the {pname} touches the {oname}')
        if h > horn_at(0) + 0.5:
            common = flap & horn
            if common and sum(s.volume for s in common.solids()) > 0.01:
                found.append(f'the horn meets the flap at {h:.0f} degrees, before its slack is taken up')
    # The spring may rest on its post, but not run through the body anywhere else.
    for f in (0.0, flap_open):
        common = flap_spring(f) & (sl - cyl_y(SPRING_POST[0], FRONT_Y - 1, SPRING_POST[1], 4.0, 10))
        if common and sum(s.volume for s in common.solids()) > 0.01:
            found.append(f'{f:.0f} degrees open, the flap spring touches the body')
    return found


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
    'light': led_body, 'mount nut': mount_nut, 'antenna': antenna_body,
    'touch plug': touch_plug, 'touch cable': touch_cable, 'video ribbon': video_ribbon,
    'table camera': table_camera_body, 'table camera plug': table_camera_plug, 'camera clamp': camera_clamp,
    'servo': servo_body, 'servo horn': servo_horn, 'lens flap': lens_flap, 'flap spring': flap_spring,
}
# What each part is meant to touch: what it is fixed to or plugged into.
ALLOWED = {
    frozenset(p) for p in [
        ('sleeve', 'camera'), ('sleeve', 'counter'), ('sleeve', 'sound meter'), ('sleeve', 'light'),
        ('sleeve', 'mount nut'), ('sleeve', 'touch plug'), ('sleeve', 'video ribbon'), ('sleeve', 'antenna'),
        ('back sheet', 'PD board'),
        ('back sheet', 'charging port'), ('sleeve', 'charging port'),
        ('back sheet', 'USB port'), ('back sheet', 'Ethernet port'),
        ('camera', 'camera plug'), ('counter', 'counter leads'),
        ('Pi', 'cooler'), ('Pi', 'jumpers'), ('Pi', 'Pi lower plugs'), ('Pi', 'Pi USB plugs'),
        ('cooler', '4G board'), ('4G board', 'jumpers'), ('4G board', 'Pi lower plugs'),
        ('jumpers', 'Pi lower plugs'), ('battery', 'battery plugs'),
        ('screen', 'touch plug'), ('screen', 'video ribbon'), ('screen', 'touch cable'),
        ('touch plug', 'touch cable'),
        ('sleeve', 'table camera'), ('sleeve', 'camera clamp'), ('table camera', 'camera clamp'),
        ('table camera', 'table camera plug'), ('sleeve', 'servo'), ('servo', 'servo horn'),
        ('sleeve', 'flap spring'), ('lens flap', 'flap spring'),
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
        labelled(antenna_body(), '4G antenna strip', Color(0.6, 0.62, 0.66)),
        labelled(table_camera_body(), 'Arducam IMX519 table camera', Color(0.05, 0.25, 0.18)),
        labelled(camera_clamp(), 'Camera clamp (printed, navy)', NAVY),
        labelled(lens_flap(), 'Lens cover flap (printed, navy)', NAVY),
        labelled(flap_spring(), 'Lens cover spring', Color(0.75, 0.76, 0.78)),
        labelled(servo_body(), 'MG90S lens cover servo', Color(0.1, 0.1, 0.12)),
        labelled(servo_horn(), 'Servo horn', Color(0.93, 0.93, 0.9)),
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
    for problem in sight_report(sl, back, front):
        sys.exit(problem)
    print('view check: nothing stands in the doorway counter\'s, the heat camera\'s or the table camera\'s view, '
          'on a table or on the wall')
    for problem in shutter_report(sl):
        sys.exit(problem)
    print('cover check: shut, the flap covers the table camera\'s whole view; opening, it touches nothing')
    if args.check:
        return

    # (written by export.py from here, which owns the file layout)
    return sl, front, back


if __name__ == '__main__':
    main()
