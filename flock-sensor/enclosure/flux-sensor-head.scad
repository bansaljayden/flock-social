// Flock Flux sensor head, parametric.
//
// The part that goes on the venue's wall. A wedge-faced box on a ball mount,
// with the thermal camera and the doorway counter looking out of the angled
// lower face at the floor in front of the door. No screen and no battery: those
// live in the base unit, joined to this by one cable run.
//
// Open in OpenSCAD (openscad.org, free). Set `part`, press F6, export STL.
// Everything here fits any school printer bed; the largest piece is 84 mm.
//
// PRINT head_fit_test FIRST. It is the angled wall laid flat with every hole
// and guide in it: twenty minutes, a few grams, and it answers whether the
// camera and the counter actually fit before four hours go into the shell.

part = "head_fit_test";
// head_fit_test | shell | back_plate | lens_ring | assembled

// ===========================================================================
// THE FRAME. Every feature below is placed in this one frame.
//
//   X  across the unit,  0 .. head_w
//   Y  depth,            0 = the back, against the wall;  head_d = the front
//   Z  height,           0 = the bottom;  head_h = the top
//
// The first version of this file placed its features as (depth, height,
// across) while the body was built as (across, depth, height). Rendered, the
// shell had no top or front wall, its screw bosses floated outside it as a
// separate solid, and the camera, counter and cable holes came out of the wrong
// faces. None of that was visible in the text, which is why every part is now
// rendered before it is committed.
// ===========================================================================

head_w      = 84.0;
head_h      = 74.0;
head_d      = 66.0;
wedge       = 30.0;   // the angled face rises this far up the front
top_chamfer = 8.0;
edge_cham   = 2.0;    // the chamfer on every edge
wall        = 3.0;

// ===========================================================================
// What goes inside
// ===========================================================================

// PureThermal 3 with the Lepton on it. The board outline is the datasheet's;
// how far the Lepton stands off the board is not published.
pt3_w         = 25.8;   // across
pt3_h         = 28.9;   // along the slope
lepton_stand  = 8.5;    // MEASURE: board surface to the front of the lens
lens_dia      = 11.0;   // MEASURE: the barrel that pokes through

// Pololu #3419 VL53L8CX carrier, from Pololu's drawing (14 Feb 2024): a
// 12.7 x 22.9 board, the sensor at its centre, and two 2.18 mm holes for M2
// screws, both 2.5 mm in from one long edge and 2.5 mm from each end.
tof_board_w   = 12.7;
tof_board_h   = 22.9;
tof_hole_in   = 2.5;
tof_part_h    = 1.8;    // tallest part on the sensor side of the board

// Sound for the microphone, and the one status light.
mic_port      = 3.0;
led_dia       = 3.2;

// Fields of view, which size the openings. A straight hole the size of the
// lens clips the edge of the view: the camera sees its own rim as a cold ring,
// and the counter sees the rim as something a few millimetres away, which is a
// person standing in the doorway forever. Both openings therefore widen
// outward to clear the half-angle across the diagonal.
lepton_half_diag = 35.5;  // Lepton 3.5: 57 across, about 71 on the diagonal
tof_half_diag    = 32.5;  // VL53L8CX: 45 x 45, 65 on the diagonal
tof_window       = 7.0;   // opening at the inner face, over the sensor
fov_margin       = 1.0;   // extra radius so tolerance never clips the view

screw_dia   = 3.4;        // clearance for M3
insert_dia  = 4.2;        // M3 heat-set insert
boss_len    = 9.0;

// The mount. A 1/4"-20 thread is the tripod standard, so the ball joint is an
// off-the-shelf part rather than a printed one that creeps overnight. The
// thread is a captured steel nut: a thread cut into plastic strips the first
// time the mount is over-tightened.
mount_nut_af    = 11.4;   // across the flats, with clearance
mount_nut_th    = 5.8;
mount_clear_dia = 7.0;
mount_boss_dia  = 22.0;
mount_boss_h    = 10.0;

// One opening for the cables, sized to pass a USB plug on its way out.
cable_slot_w = 14.0;
cable_slot_h = 9.0;

$fn = 64;

// ===========================================================================
// The shape
// ===========================================================================

// Side view: (depth, height). Everything about the silhouette is these points.
module profile() {
    polygon([
        [0,                    0],
        [head_d - wedge,       0],
        [head_d,               wedge],
        [head_d,               head_h - top_chamfer],
        [head_d - top_chamfer, head_h],
        [0,                    head_h],
    ]);
}

// The profile with its own corners chamfered too, so no edge anywhere is sharp.
module profile_c() {
    offset(delta = edge_cham, chamfer = true) offset(delta = -edge_cham) profile();
}

// Extrude a (depth, height) shape across X from x0 to x1, in the world frame.
// rotate([90, 0, 90]) sends the extrusion's (a, b, c) to world (c, a, b).
module across(x0, x1) {
    translate([x0, 0, 0]) rotate([90, 0, 90]) linear_extrude(x1 - x0) children();
}

module body() {
    // The side edges chamfered by hulling a full-width copy of the inset
    // profile against a narrowed copy of the full one. (The first version
    // hulled a shape against something wholly inside it, which is a no-op,
    // so the chamfer it claimed did not exist.)
    hull() {
        across(edge_cham, head_w - edge_cham) profile_c();
        across(0, head_w) offset(delta = -edge_cham) profile_c();
    }
}

// The hollow. Open at the back, which the back plate closes.
module cavity() {
    across(wall, head_w - wall) union() {
        offset(delta = -wall) profile_c();
        translate([-1, wall]) square([wall + 2, head_h - 2 * wall]);
    }
}

// ---------------------------------------------------------------------------
// The angled face. Features on it are placed in a local frame:
//   u  across (world X), 0 at the centre line
//   v  along the slope, 0 at the middle of the face, positive going up
//   n  inward, along the face's inward normal
// ---------------------------------------------------------------------------
_k = 1 / sqrt(2);
face_mid_y = head_d - wedge / 2;
face_mid_z = wedge / 2;

module on_face(n0 = 0) {
    // Origin on the OUTER face (n0 = 0) or offset inward from it.
    multmatrix([[1, 0,   0,  head_w / 2],
                [0, _k, -_k, face_mid_y - n0 * _k],
                [0, _k,  _k, face_mid_z + n0 * _k],
                [0, 0,   0,  1]]) children();
}

// An opening through the angled wall, widening outward to clear a view cone.
module view_opening(inner_d, half_angle) {
    grow = 2 * (wall + 2) * tan(half_angle) + 2 * fov_margin;
    // n runs inward, so the cone's wide end (d1) is the outside one.
    translate([0, 0, -1]) cylinder(h = wall + 2, d1 = inner_d + grow, d2 = inner_d);
}

cam_u = 0;
tof_u = 27;
led_u = -27;

module face_openings() {
    on_face() {
        translate([cam_u, 0, 0]) view_opening(lens_dia, lepton_half_diag);
        translate([tof_u, 0, 0]) view_opening(tof_window, tof_half_diag);
        translate([led_u, 0, -1]) cylinder(h = wall + 2, d = led_dia);
    }
}

// Guides that hold the camera square behind its opening. Tall enough to catch
// the board's edges wherever the Lepton's stand-off puts it, and they do not
// depend on the board's mounting holes, which GroupGets does not publish.
rail_t = 1.6;
rail_clear = 0.4;
module camera_rails() {
    on_face(wall) for (s = [-1, 1])
        translate([cam_u + s * (pt3_w / 2 + rail_clear + rail_t / 2) - rail_t / 2,
                   -pt3_h / 2, 0])
            cube([rail_t, pt3_h, lepton_stand + 3]);
}

// Two posts for the counter's board, from Pololu's hole positions, standing
// just proud of the tallest part on the sensor side so the sensor sits close
// behind its opening. Pilot holes for M2 thread-forming screws.
module tof_posts() {
    post_h = tof_part_h + 0.7;
    hu = tof_u + tof_board_w / 2 - tof_hole_in;
    hv = tof_board_h / 2 - tof_hole_in;
    on_face(wall) for (s = [-1, 1])
        translate([hu, s * hv, 0]) difference() {
            cylinder(h = post_h, d = 4.6);
            translate([0, 0, -0.1]) cylinder(h = post_h + 1, d = 1.6);
        }
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

// Where the back plate's four screws go, as (x, z) on the back rim. Each boss
// overlaps the walls it sits against by a millimetre, so it prints as part of
// the shell rather than as a separate post.
boss_r = (insert_dia + 4) / 2;
boss_c = wall + boss_r - 1;
function back_screw_points() = [
    [boss_c, boss_c], [head_w - boss_c, boss_c],
    [boss_c, head_h - boss_c], [head_w - boss_c, head_h - boss_c],
];

module shell() {
    difference() {
        union() {
            difference() {
                body();
                cavity();
            }
            for (p = back_screw_points())
                translate([p[0], 0, p[1]]) rotate([-90, 0, 0])
                    cylinder(h = boss_len, r = boss_r);
            camera_rails();
            tof_posts();
        }

        face_openings();

        // Inserts for the back plate, from the back, stopping a millimetre
        // short of the boss's end so the insert has a floor to seat against.
        for (p = back_screw_points())
            translate([p[0], -1, p[1]]) rotate([-90, 0, 0])
                cylinder(h = boss_len, d = insert_dia);

        // The microphone hears through the underside, well away from the
        // camera so the Lepton's shutter click does not land in it.
        translate([head_w / 2 + 22, 20, -1]) cylinder(h = wall + 2, d = mic_port);

        // Vents along the underside, out of sight from anybody standing below.
        for (i = [0 : 4])
            translate([14 + i * 6, 8, -1]) cube([2.4, 22, wall + 2]);
    }
}

// ---------------------------------------------------------------------------
// The back plate, in its own frame, lying flat the way it prints:
//   x across, y up the unit (world Z), z through the plate; z = 0 is the face
//   against the wall and the mount boss rises on the inside.
// ---------------------------------------------------------------------------
bp_t = wall;

module back_plate() {
    difference() {
        union() {
            // The plate, its corners chamfered to follow the shell's outline.
            linear_extrude(bp_t) offset(delta = edge_cham, chamfer = true)
                offset(delta = -edge_cham) square([head_w, head_h]);
            translate([head_w / 2, head_h / 2, bp_t])
                cylinder(h = mount_boss_h, d = mount_boss_dia);
        }
        // Clearance for the mount's screw, all the way through.
        translate([head_w / 2, head_h / 2, -1])
            cylinder(h = bp_t + mount_boss_h + 2, d = mount_clear_dia);
        // The hex pocket opens on the inside, so the shell traps the nut and
        // tightening the mount pulls the nut into the boss, not out of it.
        translate([head_w / 2, head_h / 2, bp_t + mount_boss_h - mount_nut_th])
            cylinder(h = mount_nut_th + 1, d = mount_nut_af / cos(30), $fn = 6);
        for (p = back_screw_points())
            translate([p[0], p[1], -1]) cylinder(h = bp_t + 2, d = screw_dia);
        // The cable slot, low and central: a stadium, as the hull of its two
        // round ends. (Rounding a 14 x 9 rectangle by shrinking it 4.5 mm and
        // growing it back erased it entirely, since the 9 mm side went to
        // nothing first. The render showed a plate with no slot in it.)
        translate([head_w / 2, 14, -1]) linear_extrude(bp_t + 2) hull()
            for (s = [-1, 1])
                translate([s * (cable_slot_w - cable_slot_h) / 2, 0])
                    circle(d = cable_slot_h);
    }
}

// ---------------------------------------------------------------------------
// The fit test: the angled wall laid flat, with every opening and guide on it.
// ---------------------------------------------------------------------------
module head_fit_test() {
    slope = wedge * sqrt(2);
    // Flatten: undo on_face's rotation so the coupon prints on its outer face.
    difference() {
        union() {
            translate([-head_w / 2, -slope / 2, 0]) cube([head_w, slope, wall]);
            // The rails and posts, standing on the inner face (z = wall).
            for (s = [-1, 1])
                translate([cam_u + s * (pt3_w / 2 + rail_clear + rail_t / 2) - rail_t / 2,
                           -pt3_h / 2, wall])
                    cube([rail_t, pt3_h, lepton_stand + 3]);
            post_h = tof_part_h + 0.7;
            hu = tof_u + tof_board_w / 2 - tof_hole_in;
            hv = tof_board_h / 2 - tof_hole_in;
            for (s = [-1, 1])
                translate([hu, s * hv, wall]) difference() {
                    cylinder(h = post_h, d = 4.6);
                    translate([0, 0, -0.1]) cylinder(h = post_h + 1, d = 1.6);
                }
        }
        translate([cam_u, 0, 0]) view_opening(lens_dia, lepton_half_diag);
        translate([tof_u, 0, 0]) view_opening(tof_window, tof_half_diag);
        translate([led_u, 0, -1]) cylinder(h = wall + 2, d = led_dia);
    }
}

// A ring that sits in the camera opening and hides the printed edge.
module lens_ring() {
    difference() {
        cylinder(h = 2.4, d = lens_dia + 8);
        translate([0, 0, -1]) cylinder(h = 5, d = lens_dia);
    }
}

// ===========================================================================

if      (part == "head_fit_test") head_fit_test();
else if (part == "shell")         shell();
else if (part == "back_plate")    back_plate();
else if (part == "lens_ring")     lens_ring();
else {
    color("#20242b") shell();
    // The plate in the world frame: its z becomes world Y, offset so its inner
    // face meets the shell's back rim at y = 0; its y becomes world Z.
    color("#3a414c") multmatrix([[1, 0, 0, 0],
                                 [0, 0, 1, -bp_t],
                                 [0, 1, 0, 0],
                                 [0, 0, 0, 1]]) back_plate();
}
