"""Rebuild the website's copies of the Flux model and renders.

    python frontend/scripts/flux_assets.py

Reads flock-sensor/enclosure/preview/ (export.py and viewer/render.cjs write
it) and writes frontend/public/sensor/, so a re-export of the case reaches the
/flux page with one run of this file. Nothing in preview/ is changed.

The folder is sensor/, not flux/: a folder named like a page makes a static
server answer /flux with the folder instead of the app (ResearchPage.js has
the same note for papers/).

The model: the exported glTF carries texture coordinates for textures it does
not have, splits every face into its own primitive (about 1,700 draw calls)
and stores floats. The wall arm, its screw and the wall are dropped first:
the page's slider never shows the box on the wall (the arm render does).
glTF-Transform then drops the unused attributes, joins each named part into
one primitive (the part names are kept, the page names a part when it is
tapped), and quantizes positions and normals with KHR_mesh_quantization,
which GLTFLoader reads without a decoder. Meshopt or Draco would be smaller,
but both decode in WebAssembly and the site's Content-Security-Policy does
not allow it. The result is gzipped and the page unpacks it with the
browser's own DecompressionStream, because Pages does not compress .glb.

The renders: WebP and AVIF at 1x and 2x of the width the page shows them at.
Needs Pillow with AVIF (Pillow 11+) and Node for npx.
"""
from pathlib import Path
import gzip
import json
import shutil
import struct
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "flock-sensor" / "enclosure" / "preview"
OUT = ROOT / "frontend" / "public" / "sensor"
GLTF_TRANSFORM = "@gltf-transform/cli@4.1.1"

# Parts that only exist for the wall-mounted pictures.
WALL_ONLY = {"CAMVATE wall arm (24007)", "Arm screw and stem", "Wall (for scale)"}

# name -> width in CSS pixels on the page (1x); 2x is written too, capped at
# the render's own width. The step renders are the slider's stand-ins where
# the 3D does not run: the exploded view, steps 2 to 7, then the box.
RENDERS = {
    "flux-assembled": 700,
    "flux-exploded": 1100,
    "flux-inside": 520,
    "flux-back": 520,
    "flux-arm": 520,
    "flux-below": 520,
    **{f"flux-step{i}": 700 for i in range(2, 8)},
}


def npx(*args):
    cmd = ["npx", "-y", GLTF_TRANSFORM, *args]
    subprocess.run(cmd, check=True, shell=sys.platform == "win32")


def strip_meshes(src, dst, names):
    """Copy a GLB with the named nodes (and everything under them) left
    without meshes; prune then drops the geometry nothing uses."""
    data = src.read_bytes()
    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + json_len])
    rest = data[20 + json_len:]
    nodes = gltf["nodes"]
    todo = [i for i, n in enumerate(nodes) if n.get("name") in names]
    while todo:
        node = nodes[todo.pop()]
        node.pop("mesh", None)
        todo.extend(node.get("children", []))
    body = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    body += b" " * (-len(body) % 4)
    head = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(body) + len(rest))
    dst.write_bytes(head + struct.pack("<I4s", len(body), b"JSON") + body + rest)


def model():
    src = SRC / "flux-assembly.glb"
    out = OUT / "flux-assembly.glb.gz"
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        strip_meshes(src, t / "a.glb", WALL_ONLY)
        npx("prune", str(t / "a.glb"), str(t / "b.glb"), "--keep-attributes", "false")
        npx("weld", str(t / "b.glb"), str(t / "c.glb"))
        npx("join", str(t / "c.glb"), str(t / "d.glb"), "--keep-meshes", "true", "--keep-named", "true")
        npx("quantize", str(t / "d.glb"), str(t / "e.glb"))
        glb = (t / "e.glb").read_bytes()
    out.write_bytes(gzip.compress(glb, compresslevel=9, mtime=0))
    old = OUT / "flux-assembly.glb"
    if old.exists():
        old.unlink()
    print(f"model: {src.stat().st_size // 1024} KB -> {len(glb) // 1024} KB, "
          f"{out.stat().st_size // 1024} KB gzipped")


def save_pair(im, name, width):
    for scale in (1, 2):
        w = min(width * scale, im.width)
        h = round(im.height * w / im.width)
        sized = im.resize((w, h), Image.LANCZOS)
        suffix = "" if scale == 1 else "@2x"
        sized.save(OUT / f"{name}{suffix}.webp", quality=82, method=6)
        sized.save(OUT / f"{name}{suffix}.avif", quality=60)


def hero():
    """The /flux hero: the assembled render cut to the box and its shadow, 4:3,
    so the box fills its plate. Found from the pixels, so a re-render with the
    same ground colour crops itself."""
    im = Image.open(SRC / "flux-assembled.png").convert("RGB")
    ground = im.getpixel((2, 2))
    mask = Image.new("L", im.size)
    px, mp = im.load(), mask.load()
    for y in range(0, im.height, 2):
        for x in range(0, im.width, 2):
            # The cream stand and the soft shadow sit only a few levels off
            # the ground, and the crop has to keep both.
            if max(abs(a - b) for a, b in zip(px[x, y], ground)) > 3:
                mp[x, y] = 255
    x0, y0, x1, y1 = mask.getbbox()
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w = max(x1 - x0, (y1 - y0) * 4 / 3) * 1.3
    w = min(w, im.width, im.height * 4 / 3)
    h = w * 3 / 4
    left = min(max(0, cx - w / 2), im.width - w)
    top = min(max(0, cy - h / 2), im.height - h)
    crop = im.crop((round(left), round(top), round(left + w), round(top + h)))
    save_pair(crop, "flux-hero", 560)
    print(f"hero: {crop.width}x{crop.height} from the assembled render")


def renders():
    for name, width in RENDERS.items():
        save_pair(Image.open(SRC / f"{name}.png").convert("RGB"), name, width)
    print(f"renders: {len(RENDERS)} images, WebP and AVIF at 1x and 2x")


# The /flux Tables section: a generated-heat picture of a dining room from
# the box over the door, and the venue dashboard's Tables tab with demo data.
# The tab shots are -v2 since the 2026-10-28 retake (photo header): a new name
# so Cloudflare's edge cannot keep serving the old picture under the old one.
# The PNGs live outside the repo (the tables work's images/ folder), so
#   python frontend/scripts/flux_assets.py --tables-only --tables-src <dir>
TABLES = {
    "flux-tables-illustration": 640,
    "flux-tables-room": 640,
    "tables-tab-desktop-v2": 1080,
    "tables-tab-phone-v2": 260,
}
TABLES_FILES = {
    "flux-tables-illustration": "flux-tables-illustration.png",
    "flux-tables-room": "flux-sees-tables-room.png",
    "tables-tab-desktop-v2": "tables-tab-desktop.png",
    "tables-tab-phone-v2": "tables-tab-phone.png",
}


def tables(src):
    for name, width in TABLES.items():
        save_pair(Image.open(src / TABLES_FILES[name]).convert("RGB"), name, width)
    print(f"tables: {len(TABLES)} images, WebP and AVIF at 1x and 2x")


if __name__ == "__main__":
    # --src <dir> reads the export from another folder, for a branch that does
    # not have the latest flock-sensor/ yet. --images-only skips the model.
    if "--src" in sys.argv:
        SRC = Path(sys.argv[sys.argv.index("--src") + 1])
    OUT.mkdir(parents=True, exist_ok=True)
    if "--tables-src" in sys.argv:
        tables(Path(sys.argv[sys.argv.index("--tables-src") + 1]))
    if "--tables-only" in sys.argv:
        sys.exit(0)
    if "--images-only" not in sys.argv:
        model()
    renders()
    hero()
