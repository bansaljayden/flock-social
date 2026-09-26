// Flock Flux base unit, parametric.
//
// The box that sits on the table: the 7 inch screen in its front, the Pi 5 on
// its back wall, the battery in a tray on its floor. Six flat panels are laser
// cut; everything that holds them together or holds something inside them is
// 3D printed.
//
// Open in OpenSCAD (openscad.org, free). Set `part`, press F6, export: STL for
// a printed part, or set `flat = true` on a panel and export DXF or SVG for the
// laser. Every dimension is a named variable, so a wrong measurement is a
// one-line fix and a re-export, not a redesign. Ready-made files for every
// part are in stl/, dxf/ and svg/ beside this file.
//
// ---------------------------------------------------------------------------
// PRINT THESE FIRST. Do not cut or print a whole box yet.
//
//   this file:              part = "screen_fit_test"   about an hour
//   flux-sensor-head.scad:  part = "head_fit_test"     about twenty minutes
//
// The first says whether the screen's four screws line up and the window shows
// the whole picture; the second whether the camera and the doorway counter fit
// behind their openings. Get both right in cheap plastic before any acrylic is
// cut.
// ---------------------------------------------------------------------------

part = "screen_fit_test";
// Printed: screen_fit_test | corner_block (8) | screen_spacer (4) | pi_spacer (4)
//          | battery_tray | cable_grommet
// Cut:     front | back | top | bottom | side (2)
// Engrave: front_engrave, the wordmark, always flat
// Look:    assembled | inside | front_face
// Check:   clash
//
// `clash` renders every pair of parts that must not touch, intersected. It
// should render nothing at all; OpenSCAD then says the top level object is
// empty. Anything it does draw is two parts in the same place.

// true: the panel flattened to the one outline and set of holes a laser wants.
flat = false;

// ===========================================================================
// THE FRAME. Every part below is placed in this one frame, as the box stands
// on the table facing you.
//
//   X  across, left to right,       0 .. box_w
//   Y  depth, front to back,        0 = the screen's face, box_d = the back
//   Z  height,                      0 = the table
//
// The sensor head's first version placed features on one set of axes while its
// body was built on another, and nothing in the text showed it. So every panel
// here is built in this frame first and only flattened for the laser at the
// end, which means a hole cannot be in one place on the drawing and another in
// the box.
// ===========================================================================

// ===========================================================================
// MEASURED, from datasheets and labels. Trust these.
// ===========================================================================

// Raspberry Pi 5, from its mechanical drawing: board 85 x 56, four M2.5 holes
// on a 58 x 49 grid. The grid is NOT centred on the board. The holes are
// 3.5 mm in from the end opposite the USB and Ethernet ports and from both long
// edges, so the far pair sits 23.5 mm from the port end. The first version of
// this file centred the grid, which put every hole 10 mm from its screw.
pi_w            = 85.0;
pi_d            = 56.0;
pi_hole_inset   = 3.5;
pi_hole_dx      = 58.0;
pi_hole_dy      = 49.0;

// THE SCREEN IS NOT THE PART THIS FILE FIRST ASSUMED. It was written for a
// Raspberry Pi Touch Display 2, a 720x1280 portrait DSI panel, because that is
// what an early build plan named. The panel in hand is a Lebula/ROADOM 7 inch
// 1024x600 HDMI touchscreen: landscape, and a carrier board rather than a bare
// panel, carrying two speakers, five buttons and a Pi Zero mounting outline.
//
// HOW THESE WERE MEASURED, and why the first attempt was wrong by 11%. The board
// was photographed beside a US one dollar note, 155.956 x 66.294 mm on every
// note printed. Scaling against the note gave 180 x 127, which was committed and
// was wrong: the note lay flat on the desk while the board sat above it on the
// LCD's own thickness, so the board was nearer the lens and photographed bigger.
// The lit area is 154.21 x 85.92 by spec and lies in the SAME plane as the
// board, so the board was scaled against that instead. A scale reference has to
// lie in the plane being measured.
screen_outer_w  = 162.0;   // across
screen_outer_h  = 119.0;   // up
screen_thick    = 12.0;    // MEASURE: front of the glass to the back of the board's parts
screen_slack    = 3.0;     // what is left of the doubt, in the fit test's rebate

// Four mounting holes in small tabs at the corners, read off the same
// photograph. The fit test settles them before anything is cut.
screen_hole_dx  = 149.0;
screen_hole_dy  = 113.0;
screen_hole_dia = 3.4;     // M3 clearance

// The lit area and where it sits on the board. IT IS NOT CENTRED: about 4 mm
// of border at each side, but 14 above the picture and 17 below it.
screen_active_w = 154.2;
screen_active_h = 85.9;
screen_border_l = 3.8;     // board's left edge to the lit area
screen_border_b = 17.4;    // board's bottom edge to the lit area
screen_border_t = 14.4;    // kept explicit so the asymmetry is not lost again

// Anker Prime 20K 200W, model A1336, read off the unit's own label: 124 x 53 x
// 48. One of the 53 x 48 ends carries five pogo contacts for Anker's charging
// dock, which the spec page does not mention. That end has to stay clear.
batt_len        = 124.0;
batt_wid        = 53.0;
batt_ht         = 48.0;

// ===========================================================================
// STILL TO MEASURE. Calipers, with the part in hand.
// ===========================================================================

// How far the glass stands in front of the board's mounting tabs. The glass
// rests against the back of the front panel and four printed spacers of this
// length hold the tabs. Err long: a spacer 1 mm too long leaves the glass 1 mm
// behind the window, which nobody sees; one too short lets the screws bend the
// board against the glass.
screen_glass_depth = 5.5;  // MEASURE

// The Pi 5 with its cooler and the 4G HAT on top, from the back of the board to
// the front of the tallest part. RESERVED from the spec route, not measured:
// about 18 mm for a Pi 5 to the top of its ports, 11 mm of HAT spacing, and the
// HAT and cooler for the rest. Two attempts to measure it from photographs
// failed. `clash` shows how much room there is if it turns out bigger.
pi_stack_h      = 55.0;    // MEASURE

// The acrylic. Sheet sold as "1/8 inch" is usually 3.0 mm and sometimes 3.175.
// Measure the sheet you are given. This box is forgiving of it: the panels butt
// together and printed blocks hold them, so a tenth of a millimetre either way
// is a hairline at an edge, not a joint that will not close.
sheet           = 3.0;     // MEASURE

// ===========================================================================
// DESIGN CHOICES. These are yours to change.
// ===========================================================================

// The locked 9 x 7 x 3.5 inches. The 162 x 119 board leaves 67 mm spare across
// and 59 mm up, which is room for the bezel and then some.
box_w           = 228.6;
box_h           = 177.8;
box_d           = 88.9;

// Fasteners: M3 everywhere except the Pi, which takes M2.5.
screw_dia       = 3.4;     // M3 clearance
insert_dia      = 4.2;     // M3 heat-set insert, the same as the head uses
insert_depth    = 7.0;
pi_screw_dia    = 2.7;     // M2.5 clearance
nut_af          = 5.6;     // M3 nut across the flats, with clearance

// The corner blocks. One at each inner corner, taking a screw from each of the
// three panels that meet there. Holes centred on each face and 7 deep, which
// is less than the 7.9 mm it would take for two of them to meet inside.
block           = 20.0;

// The strip under the screen reads the way a monitor's does: the wordmark
// under the window's left edge, engraved, and the two lights under its right.
//
// Two lights, and why only two. Every light on a box has to mean something a
// person can act on, and the screen already says the rest.
//   POWER  green, solid.        The battery is alive.
//   LINK   amber, blinks.       The head is talking and readings are going out.
led_dia         = 3.2;     // 3 mm LED, press fit and a dot of glue behind
led_gap         = 14.0;
led_z           = 15.0;    // up from the table, in the strip below the board

// The wordmark is in the brand's own face, the one the panel's numbers use,
// loaded from flux-assets/ so the engraving and the screen cannot drift apart.
wordmark        = "Flux";
wordmark_size   = 8.5;     // OpenSCAD's text size; the tallest letter, the l, comes out 9 mm

// The Pi on the back wall, above the battery, its ports edge up so the HDMI
// and power plugs go into open space instead of into the battery, and its USB
// end towards the cable slot.
pi_spacer       = 8.0;     // back wall to the back of the board
pi_z0           = 64.0;    // table to the board's lower edge

// The battery tray.
tray_clear      = 1.0;
tray_wall       = 2.4;
tray_floor      = 2.5;
tray_side_h     = 16.0;    // the two long walls
tray_end_h      = 6.0;     // the ends stay low, clear of the dock contacts
tray_ear        = 10.0;    // screw ears beyond each end
strap_w         = 27.0;    // slot for a 25 mm hook-and-loop strap
strap_t         = 3.5;

// Where the head's cables and the charging cable come in: one slot in the back
// wall, closed by a printed plate with a notch the cables pass through.
cable_x         = box_w - 40.0;
cable_z         = 72.0;
cable_slot_w    = 30.0;    // passes a USB-A or an RJ45 plug
cable_slot_h    = 16.0;
grommet_w       = 64.0;
grommet_h       = 32.0;
grommet_t       = 3.0;
grommet_dx      = 26.0;    // screw either side of centre
notch_w         = 22.0;
notch_h         = 8.0;

$fn = 48;

use <../flux-assets/Flock-Fraunces-Wordmark-Black.ttf>

// ===========================================================================
// Derived. Nothing below here is a setting.
// ===========================================================================

in_x0 = sheet;          in_x1 = box_w - sheet;
in_y0 = sheet;          in_y1 = box_d - sheet;
in_z0 = sheet;          in_z1 = box_h - sheet;

// Every corner screw is this far in from both edges of its panel.
corner_in = sheet + block / 2;

// The screen: the board centred on the front, the window where the lit area
// actually falls on it, 1 mm inside the lit area so no black border shows.
screen_x0 = (box_w - screen_outer_w) / 2;
screen_z0 = (box_h - screen_outer_h) / 2;
win_x0    = screen_x0 + screen_border_l + 1.0;
win_z0    = screen_z0 + screen_border_b + 1.0;
win_w     = screen_active_w - 2.0;
win_h     = screen_active_h - 2.0;
// The right light's edge on the window's right edge.
led_x     = [win_x0 + win_w - led_dia / 2 - led_gap, win_x0 + win_w - led_dia / 2];
screen_holes = [for (sx = [-1, 1], sz = [-1, 1])
                [box_w / 2 + sx * screen_hole_dx / 2, box_h / 2 + sz * screen_hole_dy / 2]];

// The Pi, centred across the back wall. Its board's back face is pi_spacer in
// front of the wall, and the stack stands forward of that.
pi_x0      = (box_w - pi_w) / 2;          // the end away from the USB ports
pi_back_y  = in_y1 - pi_spacer;
pi_holes   = [for (hx = [0, pi_hole_dx], hz = [0, pi_hole_dy])
              [pi_x0 + pi_hole_inset + hx, pi_z0 + pi_hole_inset + hz]];

// The tray, centred across the floor, 1 mm in front of the back wall.
tray_in_w  = batt_len + 2 * tray_clear;
tray_in_d  = batt_wid + 2 * tray_clear;
tray_out_w = tray_in_w + 2 * tray_wall;
tray_out_d = tray_in_d + 2 * tray_wall;
tray_x0    = (box_w - tray_out_w) / 2;
tray_y0    = in_y1 - 1.0 - tray_out_d;
tray_holes = [for (ex = [tray_x0 - tray_ear / 2, tray_x0 + tray_out_w + tray_ear / 2],
                   ey = [tray_y0 + 12, tray_y0 + tray_out_d - 12]) [ex, ey]];

// ===========================================================================
// Helpers
// ===========================================================================

// A hole through the whole box along one axis, at a point in the other two.
// Each panel subtracts only from itself, so a hole that runs on through the box
// touches nothing else.
module thru_y(x, z, d) translate([x, -1, z]) rotate([-90, 0, 0]) cylinder(h = box_d + 2, d = d);
module thru_z(x, y, d) translate([x, y, -1]) cylinder(h = box_h + 2, d = d);
module thru_x(y, z, d) translate([-1, y, z]) rotate([0, 90, 0]) cylinder(h = box_w + 2, d = d);

// A rounded slot, centred on (x, z), through the back wall.
module slot_y(x, z, w, h) {
    r = h / 2;
    hull() for (dx = [-(w / 2 - r), w / 2 - r]) thru_y(x + dx, z, 2 * r);
}
module slot_z(x, y, w, h) {
    r = h / 2;
    hull() for (dx = [-(w / 2 - r), w / 2 - r]) thru_z(x + dx, y, 2 * r);
}

// The world-to-panel transform for the laser: `a` is right and `b` up as you
// look at the panel's outside face, `t` points out of it, and `o` is where the
// panel's inside face meets a = 0, b = 0.
function to_local(o, a, b, t) = [
    [a[0], a[1], a[2], -(a * o)],
    [b[0], b[1], b[2], -(b * o)],
    [t[0], t[1], t[2], -(t * o)],
    [0, 0, 0, 1]];

module flatten(m) projection(cut = true) translate([0, 0, -sheet / 2]) multmatrix(m) children();

// ===========================================================================
// The fit test. Print this first. It is unchanged from the file's first
// release so that a copy already printed still answers the same question.
// ===========================================================================

fit_wall = 4.0;
fit_corner_r = 6.0;

module rounded_plate(w, h, t, r) {
    hull() for (x = [r, w - r], y = [r, h - r])
        translate([x, y, 0]) cylinder(h = t, r = r);
}

module screen_fit_test() {
    m = 24;
    w = screen_outer_w + 2 * m;
    h = screen_outer_h + 2 * m;
    ow = screen_active_w - 2;
    oh = screen_active_h - 2;
    difference() {
        rounded_plate(w, h, fit_wall, fit_corner_r);
        translate([(w - ow) / 2, (h - oh) / 2, -1]) cube([ow, oh, fit_wall + 2]);
        // A shallow rebate the board drops into, cut to the upper end of the
        // measurement, so a board 5 mm bigger than the photograph said still
        // drops in. A test piece that is too tight teaches nothing except
        // that it is too tight.
        translate([(w - screen_outer_w - screen_slack) / 2,
                   (h - screen_outer_h - screen_slack) / 2,
                   fit_wall - 1.6])
            cube([screen_outer_w + screen_slack, screen_outer_h + screen_slack, 2]);
        for (dx = [-screen_hole_dx / 2, screen_hole_dx / 2],
             dy = [-screen_hole_dy / 2, screen_hole_dy / 2])
            translate([w / 2 + dx, h / 2 + dy, -1])
                cylinder(h = fit_wall + 2, d = screen_hole_dia);
    }
}

// ===========================================================================
// Printed parts, each drawn the way it prints.
// ===========================================================================

// A 20 mm cube with an insert hole centred in each of three faces that meet at
// one corner. Symmetric about that corner's diagonal, so one file makes all
// eight: its mirror image is itself.
module corner_block() {
    difference() {
        cube(block);
        translate([-1, block / 2, block / 2]) rotate([0, 90, 0])
            cylinder(h = insert_depth + 1, d = insert_dia);
        translate([block / 2, -1, block / 2]) rotate([-90, 0, 0])
            cylinder(h = insert_depth + 1, d = insert_dia);
        translate([block / 2, block / 2, -1])
            cylinder(h = insert_depth + 1, d = insert_dia);
    }
}

module screen_spacer() {
    difference() {
        cylinder(h = screen_glass_depth, d = 7.0);
        translate([0, 0, -1]) cylinder(h = screen_glass_depth + 2, d = screw_dia);
    }
}

module pi_spacer() {
    difference() {
        cylinder(h = pi_spacer, d = 6.0);
        translate([0, 0, -1]) cylinder(h = pi_spacer + 2, d = pi_screw_dia);
    }
}

// Prints as it sits, floor down.
// Local frame: x along the battery, y across it, z up, origin at the outer
// corner of the floor under the left end wall.
module battery_tray() {
    difference() {
        union() {
            // Floor, with an ear beyond each end for the screws.
            translate([-tray_ear, 0, 0]) cube([tray_out_w + 2 * tray_ear, tray_out_d, tray_floor]);
            // The two long walls.
            for (y = [0, tray_out_d - tray_wall])
                translate([0, y, 0]) cube([tray_out_w, tray_wall, tray_side_h]);
            // The two low ends.
            for (x = [0, tray_out_w - tray_wall])
                translate([x, 0, 0]) cube([tray_wall, tray_out_d, tray_end_h]);
        }
        // The strap goes through both long walls at mid-length and over the top.
        for (y = [-1, tray_out_d - tray_wall - 1])
            translate([(tray_out_w - strap_w) / 2, y, tray_floor + 3])
                cube([strap_w, tray_wall + 2, strap_t]);
        // Screw holes in the ears. Screws come up through the floor panel and
        // the nuts sit on the ears, clear of the battery.
        for (ex = [-tray_ear / 2, tray_out_w + tray_ear / 2],
             ey = [12, tray_out_d - 12]) {
            translate([ex, ey, -1]) cylinder(h = tray_floor + 2, d = screw_dia);
        }
    }
}

// The plate over the cable slot, outside the back wall. Local frame: x across,
// y up, the notch where the cables pass.
module cable_grommet() {
    r = 4.0;
    difference() {
        hull() for (x = [r, grommet_w - r], y = [r, grommet_h - r])
            translate([x, y, 0]) cylinder(h = grommet_t, r = r);
        // The notch, open at the bottom edge, so the plate slides on over
        // cables that already have their plugs in.
        translate([grommet_w / 2, grommet_h / 2, -1]) hull() {
            for (dx = [-(notch_w / 2 - notch_h / 2), notch_w / 2 - notch_h / 2])
                translate([dx, 0, 0]) cylinder(h = grommet_t + 2, d = notch_h);
        }
        translate([grommet_w / 2 - notch_h / 2, -1, -1])
            cube([notch_h, grommet_h / 2 + 1, grommet_t + 2]);
        for (dx = [-grommet_dx, grommet_dx])
            translate([grommet_w / 2 + dx, grommet_h / 2, -1])
                cylinder(h = grommet_t + 2, d = screw_dia);
    }
}

// ===========================================================================
// Panels, built in the box's own frame.
//
// Butt joints. The front and back are the full 228.6 x 177.8; the top and
// bottom sit between them; the sides sit inside all four. So the front shows
// one unbroken face, the top shows the front and back edges only at its ends,
// and each side is framed by the edges around it.
// ===========================================================================

module corner_holes_y() for (x = [corner_in, box_w - corner_in], z = [corner_in, box_h - corner_in]) thru_y(x, z, screw_dia);
module corner_holes_z() for (x = [corner_in, box_w - corner_in], y = [corner_in, box_d - corner_in]) thru_z(x, y, screw_dia);
module corner_holes_x() for (y = [corner_in, box_d - corner_in], z = [corner_in, box_h - corner_in]) thru_x(y, z, screw_dia);

module front_panel() {
    difference() {
        cube([box_w, sheet, box_h]);
        translate([win_x0, -1, win_z0]) cube([win_w, sheet + 2, win_h]);
        for (h = screen_holes) thru_y(h[0], h[1], screw_dia);
        for (x = led_x) thru_y(x, led_z, led_dia);
        corner_holes_y();
    }
}

module back_panel() {
    difference() {
        translate([0, box_d - sheet, 0]) cube([box_w, sheet, box_h]);
        corner_holes_y();
        for (h = pi_holes) thru_y(h[0], h[1], pi_screw_dia);
        // The cable slot and the plate's two screws.
        slot_y(cable_x, cable_z, cable_slot_w, cable_slot_h);
        for (dx = [-grommet_dx, grommet_dx]) thru_y(cable_x + dx, cable_z, screw_dia);
        // Exhaust, above the Pi where its heat rises to: five slots.
        for (i = [0 : 4]) slot_y(box_w / 2, pi_z0 + pi_d + 16 + i * 7, 70, 4);
    }
}

module top_panel() {
    difference() {
        translate([0, sheet, box_h - sheet]) cube([box_w, box_d - 2 * sheet, sheet]);
        corner_holes_z();
    }
}

module bottom_panel() {
    difference() {
        translate([0, sheet, 0]) cube([box_w, box_d - 2 * sheet, sheet]);
        corner_holes_z();
        for (h = tray_holes) thru_z(h[0], h[1], screw_dia);
        // Intake, in front of the tray and under the screen: two slots. Stick
        // four rubber feet under the corners so air can reach them.
        for (i = [0 : 1]) slot_z(box_w / 2, tray_y0 - 5 - i * 7, 100, 4);
    }
}

module side_panel(right = false) {
    difference() {
        translate([right ? box_w - sheet : 0, sheet, sheet])
            cube([sheet, box_d - 2 * sheet, box_h - 2 * sheet]);
        corner_holes_x();
    }
}

// The wordmark, in the front panel's flat frame: left edge on the window's
// left edge, centred on the lights' height. Engraved, not cut.
module wordmark_2d()
    // Less the F's left side bearing, so the ink rather than the glyph's box
    // starts on the window's left edge.
    translate([win_x0 - 0.06 * wordmark_size, led_z])
        text(wordmark, size = wordmark_size, font = "Flock Fraunces Wordmark:style=Black",
             halign = "left", valign = "center");

// Each panel's outside face as you look at it, for the laser.
m_front  = to_local([0, sheet, 0],                     [1, 0, 0],  [0, 0, 1], [0, -1, 0]);
m_back   = to_local([box_w, box_d - sheet, 0],         [-1, 0, 0], [0, 0, 1], [0, 1, 0]);
m_top    = to_local([0, sheet, box_h - sheet],         [1, 0, 0],  [0, 1, 0], [0, 0, 1]);
m_bottom = to_local([box_w, sheet, sheet],             [-1, 0, 0], [0, 1, 0], [0, 0, -1]);
m_side   = to_local([box_w - sheet, sheet, sheet],     [0, 1, 0],  [0, 0, 1], [1, 0, 0]);

// ===========================================================================
// Where everything sits, for the preview and the clash check.
// ===========================================================================

module place_blocks() {
    for (i = [0, 1], j = [0, 1], k = [0, 1])
        translate([i ? in_x1 : in_x0, j ? in_y1 : in_y0, k ? in_z1 : in_z0])
            // mirror(), not a negative scale: CGAL drops a union of blocks
            // flipped by scale([-1, 1, 1]) without a word, and the clash check
            // then passed with no corner blocks in it at all.
            mirror([i, 0, 0]) mirror([0, j, 0]) mirror([0, 0, k]) corner_block();
}

module place_tray() translate([tray_x0, tray_y0, in_z0]) battery_tray();

module battery_body()
    translate([tray_x0 + tray_wall + tray_clear, tray_y0 + tray_wall + tray_clear, in_z0 + tray_floor])
        cube([batt_len, batt_wid, batt_ht]);

// The screen module, glass against the back of the front panel.
module screen_body()
    translate([screen_x0, in_y0, screen_z0]) cube([screen_outer_w, screen_thick, screen_outer_h]);

// The Pi stack, plus the room its plugs need: power and HDMI out of the top
// edge, USB and Ethernet out of the end towards the cable slot.
module pi_body() {
    translate([pi_x0, pi_back_y - pi_stack_h, pi_z0]) cube([pi_w, pi_stack_h, pi_d]);
}
module pi_plug_room() {
    translate([pi_x0, pi_back_y - 20, pi_z0 + pi_d]) cube([50, 18, 30]);
    translate([pi_x0 + pi_w, pi_back_y - 20, pi_z0]) cube([35, 18, pi_d]);
}

module led_bodies()
    for (x = led_x)
        translate([x, in_y0, led_z]) rotate([-90, 0, 0]) cylinder(h = 9, d = 5.8);

module place_screen_spacers()
    for (h = screen_holes) translate([h[0], in_y0, h[1]]) rotate([-90, 0, 0]) screen_spacer();

module place_pi_spacers()
    for (h = pi_holes) translate([h[0], in_y1, h[1]]) rotate([90, 0, 0]) pi_spacer();

module place_grommet()
    translate([cable_x + grommet_w / 2, box_d, cable_z - grommet_h / 2])
        rotate([90, 0, 180]) cable_grommet();

module panels() {
    front_panel(); back_panel(); top_panel(); bottom_panel();
    side_panel(false); side_panel(true);
}

module assembled() {
    color([0.15, 0.15, 0.17]) panels();
    color("white") place_blocks();
    color("white") place_tray();
    color("white") place_screen_spacers();
    color("white") place_pi_spacers();
    color("white") place_grommet();
    color("orange", 0.6) battery_body();
    // Dark glass: the panel is off in a render, and a see-through screen
    // reads as a hole.
    color([0.04, 0.06, 0.09]) screen_body();
    color("green", 0.6) pi_body();
    color("lightgreen", 0.3) pi_plug_room();
    color("yellow") led_bodies();
    // The engraving, a hair proud of the front so the preview shows it.
    color("white") translate([0, -0.01, 0]) rotate([90, 0, 0]) linear_extrude(0.2) wordmark_2d();
}

// The box with its front and top off, for seeing where things went.
module inside() {
    color([0.2, 0.2, 0.23]) { back_panel(); bottom_panel(); side_panel(false); side_panel(true); }
    color([0.9, 0.9, 0.9]) { place_blocks(); place_tray(); place_screen_spacers(); place_pi_spacers(); place_grommet(); }
    color("orange") battery_body();
    color("steelblue") screen_body();
    color("seagreen") pi_body();
    color("yellow") led_bodies();
}

// The front panel alone, engraving and all, as it faces a judge.
module front_face() {
    color([0.12, 0.12, 0.14]) front_panel();
    color([0.85, 0.85, 0.85]) translate([0, -0.01, 0]) rotate([90, 0, 0]) linear_extrude(0.2) wordmark_2d();
}

// Every pair that must not overlap. Empty is the pass.
module clash() {
    // What lives inside, against everything else inside.
    intersection() { screen_body(); union() { pi_body(); pi_plug_room(); battery_body(); place_tray(); place_blocks(); led_bodies(); } }
    intersection() { union() { pi_body(); pi_plug_room(); } union() { battery_body(); place_tray(); place_blocks(); led_bodies(); place_screen_spacers(); } }
    intersection() { battery_body(); union() { place_blocks(); led_bodies(); place_pi_spacers(); place_screen_spacers(); } }
    intersection() { place_tray(); union() { place_blocks(); led_bodies(); place_pi_spacers(); } }
    // And nothing inside may pass through a panel.
    // The screen and the tray are meant to touch their panels, so they are
    // lifted clear by a hair here: touching is right, overlapping is not.
    intersection() { panels(); union() { translate([0, 0.05, 0]) screen_body(); pi_body(); pi_plug_room(); battery_body(); translate([0, 0, 0.05]) place_tray(); } }
}

// ===========================================================================

module render_part() {
    if      (part == "screen_fit_test") screen_fit_test();
    else if (part == "corner_block")    corner_block();
    else if (part == "screen_spacer")   screen_spacer();
    else if (part == "pi_spacer")       pi_spacer();
    else if (part == "battery_tray")    battery_tray();
    else if (part == "cable_grommet")   cable_grommet();
    else if (part == "front")  { if (flat) flatten(m_front)  front_panel();  else front_panel(); }
    else if (part == "front_engrave") wordmark_2d();
    else if (part == "back")   { if (flat) flatten(m_back)   back_panel();   else back_panel(); }
    else if (part == "top")    { if (flat) flatten(m_top)    top_panel();    else top_panel(); }
    else if (part == "bottom") { if (flat) flatten(m_bottom) bottom_panel(); else bottom_panel(); }
    else if (part == "side")   { if (flat) flatten(m_side)   side_panel(true); else side_panel(true); }
    else if (part == "assembled") assembled();
    else if (part == "inside")    inside();
    else if (part == "front_face") front_face();
    else if (part == "clash")     clash();
}

render_part();
