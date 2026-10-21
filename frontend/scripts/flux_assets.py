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


def renders():
    for name, width in RENDERS.items():
        im = Image.open(SRC / f"{name}.png").convert("RGB")
        for scale in (1, 2):
            w = min(width * scale, im.width)
            h = round(im.height * w / im.width)
            sized = im.resize((w, h), Image.LANCZOS)
            suffix = "" if scale == 1 else "@2x"
            sized.save(OUT / f"{name}{suffix}.webp", quality=82, method=6)
            sized.save(OUT / f"{name}{suffix}.avif", quality=60)
    print(f"renders: {len(RENDERS)} images, WebP and AVIF at 1x and 2x")


if __name__ == "__main__":
    # --src <dir> reads the export from another folder, for a branch that does
    # not have the latest flock-sensor/ yet.
    if "--src" in sys.argv:
        SRC = Path(sys.argv[sys.argv.index("--src") + 1])
    OUT.mkdir(parents=True, exist_ok=True)
    model()
    renders()
