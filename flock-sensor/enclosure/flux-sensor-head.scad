// Flock Flux sensor head, parametric.
//
// The part that goes on the venue's wall. A wedge-faced black box on a ball
// mount, with the thermal camera looking out of the angled lower face at the
// doorway below it. No screen and no battery: those are in the base unit, on a
// table or in a back room, joined by one USB cable. A 20,000 mAh battery and a
// seven inch screen do not belong on a ceiling.
//
// Open in OpenSCAD (free, openscad.org). Set `part`, press F6, export STL.
//
// This one IS printable on a school printer. The whole head is under 90 mm in
// every direction, so it fits any bed, and unlike the big flat panels it is a
// shape a printer makes well.

part = "shell";
// shell | back_plate | lens_ring | assembled

// ===========================================================================
// The look
//
// A plain extruded box reads as a project box. What makes the reference image
// read as a product is three things, and all three are cheap here: the angled
// lower face, chamfers on every edge so no corner is sharp, and nothing
// protruding except the one cable.
// ===========================================================================

head_w      = 84.0;   // across
head_h      = 74.0;   // tall
head_d      = 66.0;   // front to back

// The angled face. This is the one that looks at the doorway, and it is the
// whole reason for the shape: a flat-fronted box on a wall points at the
// opposite wall, so it either gets tilted hard on its mount or it sees nothing
// useful. Building the tilt into the body means the mount only has to trim it.
wedge       = 30.0;   // how far up the front face the angle starts
top_chamfer = 8.0;    // the smaller cut along the top front edge
edge_cham   = 2.5;    // the chamfer on every other edge

wall        = 3.0;

// ===========================================================================
// What goes inside
// ===========================================================================

// PureThermal 3, 25.8 x 28.9 from the October 2022 datasheet.
pt3_w       = 25.8;
pt3_h       = 28.9;
pt3_hole_dx = 20.0;   // MEASURE: the datasheet gives this only as a drawing
pt3_hole_dy = 23.0;   // MEASURE
lens_dia    = 11.0;   // MEASURE: the barrel that has to see out

// VL53L8CX time-of-flight counter, on the Pololu #3419 carrier.
tof_w       = 18.0;
tof_h       = 13.0;
tof_win     = 8.0;    // the window it looks through

mic_port    = 3.0;    // the pinhole the microphone hears through

// THE MICROPHONE LIVES HERE, not in the base, and its converter comes with it.
//
// The obvious build puts the MAX4466 in the head and runs its analog output
// down the cable to the converter next to the Pi. Do not. Analog audio over
// three metres of cable beside a 4G modem picks up everything, and this build
// already has a noise problem of exactly that kind: the microphone's usable
// window is about 27 dB against a venue's 45, and the part's own noise is
// under one count, so the floor is all wiring.
//
// So the MCP3008 goes in here too, wired to the microphone with centimetres
// of trace, and what leaves the head is SPI: digital, and indifferent to the
// noise that was eating the analog. Six conductors for SPI and four more for
// the counter's I2C fit one Cat6 run, twisted pairs included.

screw_dia   = 3.4;    // clearance for M3
insert_dia  = 4.2;    // for an M3 heat-set insert

// The mount. A quarter-inch twenty thread is the tripod standard, which means
// the ball joint is a $12 part off a shelf rather than something printed, and a
// printed ball joint is exactly the part that creeps and droops over a night.
mount_thread_dia = 6.8;   // tapping size for 1/4"-20
mount_boss_dia   = 18.0;
mount_boss_h     = 9.0;

cable_dia   = 9.0;    // the one cable out of the back

$fn = 64;

// ===========================================================================
// The body
// ===========================================================================

// Side view, looking at the left face. X runs back to front, Y runs bottom to
// top. Everything about the shape lives in these six points.
module profile() {
    polygon([
        [0,                  0],
        [head_d - wedge,     0],
        [head_d,             wedge],
        [head_d,             head_h - top_chamfer],
        [head_d - top_chamfer, head_h],
        [0,                  head_h],
    ]);
}

// The profile extruded across, then chamfered on every edge at once by hulling
// the full-width body against a slightly shrunken, slightly narrower copy.
// Cheaper than minkowski and it renders in about a second instead of a minute.
module body() {
    hull() {
        translate([0, 0, 0])
            rotate([90, 0, 90]) linear_extrude(head_w) profile();
        translate([edge_cham, 0, 0])
            rotate([90, 0, 90]) linear_extrude(head_w - 2 * edge_cham)
                offset(r = -edge_cham) profile();
    }
}

// Where the angled face sits, and which way it points. Everything mounted on
// that face is placed through this, so the face can be re-angled by changing
// `wedge` alone and the lens follows it.
wedge_angle  = atan(wedge / wedge);            // 45 by construction
wedge_mid_x  = head_d - wedge / 2;
wedge_mid_y  = wedge / 2;

module through_wedge(d, extra = 0) {
    translate([wedge_mid_x, wedge_mid_y, head_w / 2])
        rotate([90, 0, 0]) rotate([0, 90 - wedge_angle, 0])
            translate([0, 0, -20]) cylinder(h = 40 + extra, d = d);
}

module shell() {
    difference() {
        body();

        // Hollow it, leaving `wall` everywhere.
        translate([wall, wall, wall])
            rotate([90, 0, 90]) linear_extrude(head_w - 2 * wall)
                offset(r = -wall) profile();

        // The thermal camera, out of the angled face.
        through_wedge(lens_dia);

        // The doorway counter, beside it on the same face, so both sensors see
        // the same patch of floor and a disagreement between them means
        // something rather than meaning they were aimed differently.
        translate([0, 0, 22]) through_wedge(tof_win);

        // A single indicator beside the lens: alive, and dim enough not to be
        // a light source in a dark venue. One light, because the only thing
        // anybody standing under this can act on is whether it is running.
        translate([0, 0, -20]) through_wedge(3.2);

        // The microphone, on the underside and well away from the lens, so the
        // camera's shutter click does not land straight in it.
        translate([head_d - wedge - 14, -1, head_w / 2])
            cylinder(h = wall + 2, d = mic_port);

        // The cable, out of the back low down where a wall hides it.
        translate([-1, 14, head_w / 2]) rotate([0, 90, 0])
            cylinder(h = wall + 2, d = cable_dia);

        // Vents along the underside. Out of sight from anyone standing below,
        // which is the whole point of putting them there rather than on a face.
        for (i = [0 : 4])
            translate([12 + i * 8, -1, head_w / 2 - 14])
                cube([3, wall + 2, 28]);

        // Screw holes for the back plate.
        back_screw_holes(screw_dia);
    }

    // Bosses the back plate screws into.
    difference() {
        for (p = back_screw_points())
            translate([wall, p[0], p[1]]) rotate([0, 90, 0])
                cylinder(h = 7, d = insert_dia + 3.4);
        back_screw_holes(insert_dia);
    }
}

function back_screw_points() = [
    [10, 12], [10, head_w - 12],
    [head_h - 10, 12], [head_h - 10, head_w - 12],
];

module back_screw_holes(d) {
    for (p = back_screw_points())
        translate([-1, p[0], p[1]]) rotate([0, 90, 0])
            cylinder(h = 14, d = d);
}

// ===========================================================================
// The back plate, which carries the mount
// ===========================================================================

module back_plate() {
    difference() {
        union() {
            // The plate itself, chamfered to match the body it closes.
            hull() {
                linear_extrude(wall) offset(r = -edge_cham)
                    square([head_h, head_w]);
                translate([0, 0, -edge_cham])
                    linear_extrude(0.01) offset(r = -edge_cham * 2)
                        square([head_h, head_w]);
            }
            // The boss the ball mount threads into.
            translate([head_h / 2, head_w / 2, wall])
                cylinder(h = mount_boss_h, d = mount_boss_dia);
        }

        // 1/4"-20, tapped by hand with a tap, or a threaded insert pressed in.
        translate([head_h / 2, head_w / 2, wall - 1])
            cylinder(h = mount_boss_h + 2, d = mount_thread_dia);

        for (p = back_screw_points())
            translate([p[0], p[1], -1]) cylinder(h = wall + 2, d = screw_dia);

        translate([14, head_w / 2, -1]) cylinder(h = wall + 2, d = cable_dia);
    }
}

// A thin ring that sits in the lens hole and hides the printed edge. Small,
// fast, and it is the difference between a hole in a box and a lens.
module lens_ring() {
    difference() {
        cylinder(h = 3, d = lens_dia + 7);
        translate([0, 0, -1]) cylinder(h = 5, d = lens_dia);
        translate([0, 0, 2]) cylinder(h = 2, d1 = lens_dia, d2 = lens_dia + 4);
    }
}

// ===========================================================================

if      (part == "shell")      shell();
else if (part == "back_plate") back_plate();
else if (part == "lens_ring")  lens_ring();
else {
    color("#1a1a1a") shell();
    color("#2a2a2a") translate([0, 0, 0]) rotate([0, -90, 0])
        translate([0, 0, 0]) back_plate();
}
