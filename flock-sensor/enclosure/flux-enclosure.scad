// Flock Flux enclosure, parametric.
//
// Open in OpenSCAD (free, openscad.org). Change `part` at the top, press F6,
// then File > Export > STL for a 3D printer, or Export > DXF/SVG for a laser
// cutter. Every dimension is a named variable, so a wrong measurement is a
// one-line fix and a re-print, not a redesign.
//
// ---------------------------------------------------------------------------
// PRINT THESE TWO FIRST. Do not print a whole box yet.
//
//   part = "screen_fit_test"   about an hour, a few grams
//   part = "slot_fit_test"     about twenty minutes
//
// They are the two fits that decide everything else: whether the screen sits
// flush in its cutout, and whether a hand passes cleanly through the slot with
// the sensor seeing it. Get those right in cheap plastic before anything else
// is printed and long before any acrylic is cut.
// ---------------------------------------------------------------------------

part = "screen_fit_test";
// screen_fit_test | slot_fit_test | front | back | top | bottom | side | assembled

// The big panels are 228 mm across, which is wider than most school 3D printer
// beds, and printed plastic shows its layer lines from a metre away. So the flat
// panels get laser cut from acrylic and only the small brackets and mounts get
// printed. Set this true, render the panel you want, and export DXF or SVG for
// the cutter. Leave it false for STL.
flat = false;

// ===========================================================================
// MEASURED, from datasheets. Trust these.
// ===========================================================================

// Raspberry Pi 5. Board 85 x 56, four M2.5 holes on a 58 x 49 grid, each 3.5 mm
// in from the board edges.
pi_w            = 85.0;
pi_d            = 56.0;
pi_hole_dx      = 58.0;
pi_hole_dy      = 49.0;
pi_hole_inset   = 3.5;
pi_hole_dia     = 2.7;   // clearance for M2.5

// Raspberry Pi Touch Display 2, 7 inch. 720x1280 native, so its long axis is
// the portrait axis.
screen_outer_w  = 120.24;  // short edge
screen_outer_h  = 189.32;  // long edge
screen_thick    = 14.50;

// Anker Prime 20K 200W, 124 x 53 x 48 from Anker's own spec page. Add a
// couple of millimetres of slack if the unit has a rubber sleeve on it.
batt_w          = 124.0;
batt_h          = 53.0;
batt_d          = 48.0;

// The glass's ACTIVE area, inside the black border. The cutout is sized to this
// and not to the module's outer size, or the border shows through.
//
// These are the published 155 x 88, and they check out independently: a 7 inch
// diagonal at the panel's 9:16 ratio is 87.2 x 155.0, so the spec and the
// geometry agree. Worth stating because the first pass at this file guessed
// 99 x 165 from the outer size, which would have cut an opening wider than the
// glass behind it and shown the frame on all four sides.
//
// The module is 120.24 x 189.32 overall, so the screen's own frame is about
// 16 mm on each side and 17 mm top and bottom. That is a wide border already,
// which is why the panel's own bezel below is kept modest.
screen_active_w = 88.0;
screen_active_h = 155.0;

// PureThermal 3 carrier: 25.8 x 28.9 from the October 2022 datasheet.
pt3_w           = 25.8;
pt3_h           = 28.9;

// ===========================================================================
// STILL UNKNOWN. Both are in the datasheet's dimension drawing, which is a
// picture rather than text, and both are small enough to check against the
// printed slot_fit_test piece rather than measured in advance.
// ===========================================================================

pt3_hole_dx     = 20.0;    // MEASURE
pt3_hole_dy     = 23.0;    // MEASURE

// The lens barrel that has to see out of the front face.
lens_dia        = 11.0;    // MEASURE

// ===========================================================================
// DESIGN CHOICES. These are yours to change.
// ===========================================================================

// THE ONE THAT MATTERS. Portrait is what display_loop draws for (720x1280) and
// what the code is written and tested against.
//
// The locked 9 x 7 inch box CANNOT hold this screen in portrait: it is 11.5 mm
// short before any bezel at all. So either the box gets taller, which is what
// portrait = true does below, or the screen turns landscape and the display
// code has to be rewritten for 1280x720. Taller box is the cheaper of the two.
portrait        = true;

box_w           = 228.6;                      // 9 inch, unchanged
box_h           = portrait ? 221.0 : 177.8;   // 8.70 inch portrait, 7 inch landscape
box_d           = 88.9;                       // 3.5 inch

wall            = 4.0;    // 3 mm acrylic later; 4 mm prints stronger
bezel           = 16.0;   // border of material around the visible screen
corner_r        = 6.0;    // rounded corners, front face only

// The hand-pass slot through the top. Recessed so nothing protrudes.
slot_w          = 127.0;  // 5 inch
slot_d          = 38.0;   // 1.5 inch
slot_from_front = 22.0;   // how far back from the front face

// Screw bosses that hold the panels together.
boss_dia        = 9.0;
boss_hole       = 2.7;

$fn = 48;

// ===========================================================================
// Helpers
// ===========================================================================

module rounded_plate(w, h, t, r) {
    hull() for (x = [r, w - r], y = [r, h - r])
        translate([x, y, 0]) cylinder(h = t, r = r);
}

module pi_hole_pattern(depth) {
    ox = (pi_w - pi_hole_dx) / 2;
    oy = (pi_d - pi_hole_dy) / 2;
    for (x = [ox, ox + pi_hole_dx], y = [oy, oy + pi_hole_dy])
        translate([x, y, -1]) cylinder(h = depth + 2, d = pi_hole_dia);
}

// The visible opening. Slightly smaller than the active area on every side so
// the panel overlaps the glass edge and no black border shows through.
module screen_opening(t) {
    overlap = 1.0;
    w = (portrait ? screen_active_w : screen_active_h) - 2 * overlap;
    h = (portrait ? screen_active_h : screen_active_w) - 2 * overlap;
    translate([(box_w - w) / 2, (box_h - h) / 2, -1])
        cube([w, h, t + 2]);
}

// ===========================================================================
// Test pieces. Print these two first.
// ===========================================================================

// A frame just big enough to hold the screen, so the cutout and the standoffs
// can be checked against the real part for the cost of an hour of filament.
module screen_fit_test() {
    m = 24;  // margin of material around the module
    w = (portrait ? screen_outer_w : screen_outer_h) + 2 * m;
    h = (portrait ? screen_outer_h : screen_outer_w) + 2 * m;
    ow = (portrait ? screen_active_w : screen_active_h) - 2;
    oh = (portrait ? screen_active_h : screen_active_w) - 2;
    difference() {
        rounded_plate(w, h, wall, corner_r);
        translate([(w - ow) / 2, (h - oh) / 2, -1]) cube([ow, oh, wall + 2]);
        // A shallow rebate the module drops into, so it sits flush.
        translate([(w - (portrait ? screen_outer_w : screen_outer_h)) / 2,
                   (h - (portrait ? screen_outer_h : screen_outer_w)) / 2,
                   wall - 1.6])
            cube([portrait ? screen_outer_w : screen_outer_h,
                  portrait ? screen_outer_h : screen_outer_w, 2]);
    }
}

// The slot, a hand's width of it, with the sensor mount beside it. Checks two
// things at once: that a hand passes without catching, and that the sensor
// looks across the gap at the right height.
module slot_fit_test() {
    w = slot_w + 40;
    h = slot_d + 40;
    difference() {
        cube([w, h, wall]);
        translate([20, 20, -1]) cube([slot_w, slot_d, wall + 2]);
        // Crossing sensor, mounted on the long wall looking across the slot.
        translate([w / 2, 12, wall / 2]) rotate([-90, 0, 0])
            cylinder(h = 20, d = 5.2);
        // Two M2.5 holes to bolt the sensor board down beside it.
        for (dx = [-10, 10])
            translate([w / 2 + dx, 8, -1]) cylinder(h = wall + 2, d = pi_hole_dia);
    }
}

// ===========================================================================
// Panels
// ===========================================================================

module front_panel() {
    difference() {
        rounded_plate(box_w, box_h, wall, corner_r);
        screen_opening(wall);
        // Thermal lens, low on the front face, below the screen.
        translate([box_w / 2, bezel + 6, -1]) cylinder(h = wall + 2, d = lens_dia);
        // Microphone pinhole, well away from the lens.
        translate([box_w / 2 + 40, bezel + 6, -1]) cylinder(h = wall + 2, d = 3.0);
    }
}

module top_panel() {
    difference() {
        cube([box_w, box_d, wall]);
        translate([(box_w - slot_w) / 2, slot_from_front, -1])
            cube([slot_w, slot_d, wall + 2]);
    }
}

module back_panel() {
    difference() {
        cube([box_w, box_h, wall]);
        // USB-C charging port, the only cable a judge ever sees.
        translate([box_w - 40, 30, -1]) cube([10, 5, wall + 2]);
        // Status LED beside it.
        translate([box_w - 22, 32, -1]) cylinder(h = wall + 2, d = 3.2);
        // Vents. The Pi 5 and the modem both make heat in a sealed box.
        for (x = [0 : 12 : 90], y = [0 : 12 : 60])
            translate([40 + x, box_h - 110 + y, -1]) cylinder(h = wall + 2, d = 5);
    }
}

module bottom_panel() {
    difference() {
        cube([box_w, box_d, wall]);
        // Pi mounting holes, offset so its ports face the back.
        translate([(box_w - pi_w) / 2, 14, 0]) pi_hole_pattern(wall);
        for (x = [0 : 12 : 60])
            translate([box_w / 2 - 30 + x, box_d - 18, -1]) cylinder(h = wall + 2, d = 5);
    }
}

module side_panel() {
    cube([box_d, box_h, wall]);
}

// ===========================================================================

module render_part() {
    if      (part == "screen_fit_test") screen_fit_test();
    else if (part == "slot_fit_test")   slot_fit_test();
    else if (part == "front")           front_panel();
    else if (part == "back")            back_panel();
    else if (part == "top")             top_panel();
    else if (part == "bottom")          bottom_panel();
    else if (part == "side")            side_panel();
}

if (part != "assembled") {
    // projection() flattens the panel to the single outline and set of holes a
    // cutter wants. Every panel here is a flat plate, so nothing is lost.
    if (flat) projection(cut = false) render_part();
    else render_part();
}
else {
    color("white", 0.35) {
        translate([0, 0, box_d - wall]) front_panel();
        rotate([90, 0, 0]) translate([0, 0, -wall]) bottom_panel();
        translate([0, box_h, 0]) rotate([90, 0, 0]) top_panel();
        rotate([0, -90, 0]) translate([0, 0, -wall]) side_panel();
        translate([box_w, 0, 0]) rotate([0, -90, 0]) side_panel();
    }
    // The three things that have to fit inside, to scale.
    color("green", 0.5) translate([(box_w - pi_w) / 2, 14, 6]) cube([pi_w, pi_d, 20]);
    color("orange", 0.5) translate([12, box_h - batt_h - 12, 6]) cube([batt_w, batt_h, batt_d]);
    color("blue", 0.3) translate([(box_w - screen_outer_w) / 2,
                                  (box_h - screen_outer_h) / 2,
                                  box_d - wall - screen_thick])
        cube([portrait ? screen_outer_w : screen_outer_h,
              portrait ? screen_outer_h : screen_outer_w, screen_thick]);
}
