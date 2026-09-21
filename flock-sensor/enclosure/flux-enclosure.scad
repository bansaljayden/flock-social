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
// 1024x600 HDMI touchscreen: landscape, and a carrier board rather than a bare
// panel, carrying two speakers, five buttons and a Pi Zero mounting outline.
// The PCB is what the box has to swallow, not the LCD.
//
// HOW THESE WERE MEASURED, and why the first attempt was wrong by 11%.
//
// The board was photographed beside a US one dollar note, which is
// 155.956 x 66.294 mm on every note printed. Scaling against the note gave
// 180 x 127 and that number was committed. It is wrong. The note lay flat on
// the desk while the board sat above it on the LCD's own thickness, so the
// board was nearer the lens and photographed bigger. Close in, that is worth
// about a tenth.
//
// The fix was to stop using the note. The lit area is 154.21 x 85.92 by spec,
// it lies in the SAME PLANE as the board, and a photograph of the screen
// switched on measures its aspect at 1.787 against the spec's 1.795, which is
// 0.4% and confirms both the spec and the reading. Scaled against the lit area
// instead, the board lands within 3 mm of the published generic 7 inch panel,
// which the inflated numbers did not.
//
// The lesson generalises: a scale reference has to lie in the plane being
// measured, or it is measuring a different plane.
screen_outer_w  = 162.0;   // long edge, horizontal
screen_outer_h  = 119.0;   // short edge, vertical
screen_thick    = 12.0;    // MEASURE: board plus the LCD behind it
screen_slack    = 3.0;     // what is left of the doubt

// Four mounting holes in small tabs at the corners, outside the LCD. Read off
// the same photograph, so carrying the same few millimetres; the fit test
// settles them before anything is cut.
screen_hole_dx  = 149.0;
screen_hole_dy  = 113.0;
screen_hole_dia = 3.4;     // M3 clearance, MEASURE

// The lit area, and where it sits. 1024x600 on a 7 inch diagonal is
// 154.21 x 85.92, every vendor publishes exactly that, and the photograph
// agrees to within half a percent.
//
// IT IS NOT CENTRED, which is the part worth knowing. The borders measure
// about 4 mm at each side but 14 mm above the picture and 17 mm below it, so
// a window cut on the board's centre line sits about 1.5 mm high. Small, and
// exactly the kind of small that reads as sloppy on a finished panel.
screen_active_w = 154.2;
screen_active_h = 85.9;
screen_border_l = 3.8;     // board's left edge to the lit area
screen_border_b = 17.4;    // board's bottom edge to the lit area
screen_border_t = 14.4;    // kept explicit so the asymmetry is not lost again

// Anker Prime 20K 200W, model A1336 read off the unit's own label:
// 124 x 53 x 48.
//
// One of the 53 x 48 end faces carries five pogo contacts for Anker's
// charging dock, which the spec page does not mention. That face has to stay
// clear, or the battery can only be charged by opening the box, and nobody is
// doing that between rounds at a competition.
batt_w          = 124.0;
batt_h          = 53.0;
batt_d          = 48.0;
batt_contacts_face = "bottom";   // where the five dock pins look

// The Pi 5 with its heatsink and the 4G HAT on top. RESERVED, not measured.
//
// Two attempts failed and both failed the same way. A dollar note stood on
// edge beside the stack ran out of frame, so its length was unknown. Scaling
// off the GPIO header should have worked instead, since those pins are 2.54 mm
// apart by definition, but the photograph is too soft to resolve them: the
// gaps between detected pins came out between 10 and 20 pixels when every one
// of them is the same distance.
//
// An autocorrelation over that strip answered 14 px with harmonics at 28 and
// 42, which looks clean and is not. A periodic signal that is not actually
// resolved still autocorrelates, and the harmonics follow from the assumed
// period rather than confirming it. Comparing against the length of a 20 pin
// row is what caught it.
//
// So this is a reservation from the spec route: about 18 mm for a Pi 5 to the
// top of its ports, 11 mm of standard HAT spacing, and the HAT's own parts and
// heatsink for the rest. The box is 88.9 mm deep, so a wrong guess costs
// nothing here. Confirm at assembly.
pi_stack_h      = 55.0;

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
// 162 x 119 board with 67 mm spare across and 59 mm up, which is room for the
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
    // Centre the BOARD in the panel, then put the window where the lit area
    // actually falls on it. Centring the window instead would push the board
    // 1.5 mm low and take the mounting tabs off their holes.
    bx = (box_w - screen_outer_w) / 2;
    by = (box_h - screen_outer_h) / 2;
    translate([bx + screen_border_l + overlap,
               by + screen_border_b + overlap, -1])
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
        // The four corner holes. The point of printing this is to hold the
        // real board against it and see whether the screws line up, so a test
        // piece without them tests half the fit.
        for (dx = [-screen_hole_dx / 2, screen_hole_dx / 2],
             dy = [-screen_hole_dy / 2, screen_hole_dy / 2])
            translate([w / 2 + dx, h / 2 + dy, -1])
                cylinder(h = wall + 2, d = screen_hole_dia);
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

// The two indicators. Deliberately two and not five: every light on a box has
// to mean something a person can act on, and the screen already says
// everything else.
//
//   POWER  green, solid.        The battery is alive.
//   LINK   amber, blinks.       The head is talking and readings are going out.
//
// LINK is the one that earns its place. A sensor whose cable has come out
// looks exactly like a sensor in an empty room, which is the confusion this
// whole project keeps running into, and a light that stops blinking is the
// cheapest possible answer to it.
led_dia         = 3.2;    // 3 mm LED, press fit
led_gap         = 14.0;   // between the two
led_y           = 15.0;   // up from the bottom edge, in the strip below the board

module front_panel() {
    difference() {
        rounded_plate(box_w, box_h, wall, corner_r);
        screen_opening(wall);
        // Below the screen, centred, in the 29 mm of panel the board leaves.
        // No thermal lens and no microphone on this box: both moved to the
        // sensor head when the device split in two, and a second set of holes
        // here would be holes into an empty space.
        for (dx = [-led_gap / 2, led_gap / 2])
            translate([box_w / 2 + dx, led_y, -1])
                cylinder(h = wall + 2, d = led_dia);
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
        // The head's cable, in on the same side as the charging port so all
        // the wiring lives at one end and the other three faces stay clean.
        translate([box_w - 62, 28, -1]) cylinder(h = wall + 2, d = 10.0);
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
