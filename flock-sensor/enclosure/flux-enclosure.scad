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

// THE SCREEN IS NOT THE PART THIS FILE FIRST ASSUMED. It was written for a
// Raspberry Pi Touch Display 2, a 720x1280 portrait DSI panel, because that is
// what an early build plan named. The panel in hand is a Lebula/ROADOM 7 inch
// 1024x600 HDMI touchscreen: landscape, and not a bare panel at all. It is a
// carrier board with two speakers, five buttons and a Raspberry Pi Zero
// mounting outline on the back, so the PCB is noticeably larger than the 7 inch
// LCD bonded to it, and the PCB is what a box has to swallow.
//
// Measured photogrammetrically: the board was photographed beside a US one
// dollar note, which is 155.956 x 66.294 mm on every note ever printed and is
// therefore a better ruler than most rulers. Scaling the board against the
// note's two edges gives 178.1 x 125.6 and 182.6 x 128.8; the 2.5% spread
// between them is the camera's perspective and the note's creases, so the
// honest reading is 180 x 127 with about 5 mm of doubt either way.
//
// That doubt is why screen_slack exists and why the fit test comes first. Do
// not cut acrylic against these numbers.
screen_outer_w  = 180.0;   // long edge, horizontal: the PCB, not the LCD
screen_outer_h  = 127.0;   // short edge, vertical
screen_thick    = 12.0;    // MEASURE: board plus the LCD behind it
screen_slack    = 5.0;     // the measurement's own uncertainty

// Anker Prime 20K 200W, model A1336 confirmed off the unit's own label:
// 124 x 53 x 48.
//
// One of the 53 x 48 end faces carries five pogo contacts for Anker's charging
// dock. That face has to stay clear, or the battery can only be charged by
// opening the box, which is not a thing anyone will do between rounds at a
// competition. batt_contacts_face says which way it points so the panel with
// the hatch in it can follow.
batt_w          = 124.0;
batt_h          = 53.0;
batt_d          = 48.0;
batt_contacts_face = "bottom";   // where the five dock pins look

// The lit area of the LCD. 1024x600 on a 7 inch diagonal works out to
// 154.2 x 86.0, and the panel vendors publish exactly that, so the size is
// settled.
//
// WHERE it sits on the 180 x 127 board is NOT settled, and that is the number
// that decides whether the window looks centred or looks like a mistake. The
// board is wider than the LCD by about 26 mm and taller by about 41 mm, and
// none of that margin is symmetric: the buttons run down one side and the
// speakers along the bottom. Waiting on the face-up photo.
screen_active_w = 154.2;   // horizontal, landscape
screen_active_h = 86.0;    // vertical
screen_active_offset_x = 0;   // MEASURE: from the board's left edge
screen_active_offset_y = 0;   // MEASURE: from the board's bottom edge

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

// The portrait question is CLOSED, and it closed itself. The panel is
// 1024x600, which is landscape, so the 11.5 mm shortfall that was going to
// force the box to 8.75 inches tall never existed: it came from the DSI panel
// this file was first written against. The locked 9 x 7 inch box holds a
// 180 x 127 board with 48 mm spare across and 50 mm up, which is room for the
// bezel and then some.
//
// main.py now reads its layout from whatever the framebuffer reports and lays
// the three readings out in columns when the panel is wider than it is tall,
// so nothing in the code depends on this either way. There is no `portrait`
// variable any more: screen_outer_w and screen_active_w mean horizontal and
// the _h pair mean vertical, full stop. The flag survived one edit after the
// panel changed and by then it was swapping the axes the wrong way round.
box_w           = 228.6;   // 9 inch
box_h           = 177.8;   // 7 inch, back to the original lock
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
    w = screen_active_w - 2 * overlap;
    h = screen_active_h - 2 * overlap;
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
    w = screen_outer_w + 2 * m;
    h = screen_outer_h + 2 * m;
    ow = screen_active_w - 2;
    oh = screen_active_h - 2;
    difference() {
        rounded_plate(w, h, wall, corner_r);
        translate([(w - ow) / 2, (h - oh) / 2, -1]) cube([ow, oh, wall + 2]);
        // A shallow rebate the module drops into, so it sits flush.
        // Cut to the upper end of the measurement, so a board that turns out
        // to be 5 mm bigger than the photo said still drops in. A test piece
        // that is too tight teaches nothing except that it is too tight.
        translate([(w - screen_outer_w - screen_slack) / 2,
                   (h - screen_outer_h - screen_slack) / 2,
                   wall - 1.6])
            cube([screen_outer_w + screen_slack,
                  screen_outer_h + screen_slack, 2]);
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
        cube([screen_outer_w,
              screen_outer_h, screen_thick]);
}
