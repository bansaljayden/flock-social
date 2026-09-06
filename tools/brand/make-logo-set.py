#!/usr/bin/env python
"""
make-logo-set.py — regenerate every Flock mark that carries the wordmark.

WHAT CHANGED AND WHY. The wordmark used to be set in a geometric sans. The
brand's display face is Fraunces, and the deck, the site and the app were
carrying two different voices for the same name, so the word FLOCK is now set
in Fraunces to match `--font-display`. The three birds are untouched: they are
lifted from the shipped artwork at full resolution, so this is a resetting of
the lettering rather than a redraw of the mark.

THE ONE SETTING THAT MATTERS. Fraunces has an optical-size axis that changes
the DRAWING, not the scale. At `opsz 144`, the display cut, the thick-to-thin
contrast is dramatic: it looks expensive large and its hairlines fall under one
pixel when rasterised small, so the letters go wispy and then fill in. This set
uses `opsz 24`, the text cut, at `wght 900`. That was settled by rendering the
mark at 300, 128, 64, 44 and 32 pixels rather than comparing candidates at one
large size, where every option looks fine and no decision is possible. Weight
alone does not fix it, because the heavy weight still thins those same strokes
at display optical size.

EACH FILE IS RENDERED AT ITS TARGET SIZE, never downscaled from a big one. A
hairline that survives a resample can still vanish when the glyph is actually
rasterised at 48 pixels, and the favicon is the size that decides whether the
mark works at all.

NOT TOUCHED: `appstore-icon-1024.png` and the iOS `AppIcon` beside it. Those
are a full-bleed cream square carrying the birds ALONE, with no lettering, so
there is nothing in them for a type change to affect. Leave them be; an app
icon is also the asset Apple caches hardest.

    python tools/brand/make-logo-set.py            # writes in place
    python tools/brand/make-logo-set.py --dry-run  # report only
    python tools/brand/make-logo-set.py --out DIR  # write elsewhere

Requires Pillow and fontTools. The face is read from the repo's own variable
woff2, so this needs no download and cannot drift from what the site serves.
"""

import argparse
import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PUBLIC = os.path.join(REPO, "frontend", "public")
FONT_SRC = os.path.join(REPO, "frontend", "src", "fonts", "Fraunces-var.woff2")

# Sampled from the shipped artwork rather than typed from a palette doc, so a
# regenerated file sits on exactly the same colours as the ones beside it.
CREAM = (243, 236, 220)
NAVY = (0, 40, 72)

# The geometry of the original 512px master, which everything else is a
# proportion of: the birds occupy this box, the wordmark sits below it.
BIRDS_BOX = (106, 88, 382, 281)     # left, top, right, bottom
WORDMARK_TOP = 296                  # top of the cap height

# LETTERING CHANGES WITH SIZE, and it has to.
#
# At logo size the word wants air: 74% of the disc with generous tracking,
# which is what stops a high-contrast serif reading cramped. Hold that same
# setting at favicon size and it fails, because the letters end up small and
# far apart and each stroke lands on roughly one pixel with a gap either side.
# Below 128px the word is set wider and tighter instead, which puts more ink
# into fewer, better-defined pixels. Verified by rendering at 48 and 64 rather
# than by shrinking a large one.
LETTERING = {
    "large": {"min_dia": 128, "width": 0.74, "tracking": 26},
    "small": {"min_dia": 0,   "width": 0.88, "tracking": 6},
}

# Every mark that carries the word. All of them are an opaque WHITE square with
# a cream disc inscribed edge to edge, which is the convention already in use:
# consumers clip to a circle when they want one, and the plate keeps the file
# safe on any background when they do not.
TARGETS = [
    ("flock-logo.png", 512),
    ("logo512.png", 512),
    ("logo192.png", 192),
    ("apple-touch-icon.png", 180),
    (os.path.join("marks", "logo-64.png"), 64),
]
FAVICON = ("favicon.ico", [48, 32, 16])


def load_font(size):
    """Fraunces, pinned to the cut that survives small sizes."""
    from fontTools import ttLib
    from fontTools.varLib import instancer
    font = ttLib.TTFont(FONT_SRC)
    axes = {a.axisTag for a in font["fvar"].axes}
    pinned = {k: v for k, v in {"opsz": 24, "wght": 900}.items() if k in axes}
    font = instancer.instantiateVariableFont(font, pinned, inplace=False,
                                             updateFontNames=False)
    buf = io.BytesIO()
    font.flavor = None
    font.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, size)


def tracked_width(draw, text, font, tracking):
    return sum(draw.textlength(c, font=font) for c in text) + tracking * (len(text) - 1)


def draw_tracked(draw, xy, text, font, fill, tracking):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking


def build(dia, source_birds):
    """One mark, rendered at its final size."""
    k = dia / 512.0
    img = Image.new("RGBA", (dia, dia), (255, 255, 255, 255))
    ImageDraw.Draw(img).ellipse((0, 0, dia - 1, dia - 1), fill=CREAM + (255,))

    bl, bt, br, bb = BIRDS_BOX
    birds = source_birds.resize((max(1, int((br - bl) * k)), max(1, int((bb - bt) * k))),
                                Image.LANCZOS)
    # The crop carries the master's opaque cream plate; key it out so the disc
    # shows through rather than a slightly different cream sitting on top.
    px = birds.load()
    for y in range(birds.height):
        for x in range(birds.width):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 0) if (r + g + b) > 480 else (r, g, b, a)
    img.paste(birds, (int(bl * k), int(bt * k)), birds)

    draw = ImageDraw.Draw(img)
    word = "FLOCK"
    rule = LETTERING["large"] if dia >= LETTERING["large"]["min_dia"] else LETTERING["small"]
    tracking = max(1, int(rule["tracking"] * k))
    target = dia * rule["width"]
    # Tracking is fixed first and the SIZE solved to hit the target width, so
    # opening the letters up can never push the word past the edge of the disc.
    size = max(6, int(120 * k))
    for _ in range(24):
        font = load_font(size)
        width = tracked_width(draw, word, font, tracking)
        if abs(width - target) <= 1.5:
            break
        size = max(6, int(size * target / width))
    font = load_font(size)
    width = tracked_width(draw, word, font, tracking)
    draw_tracked(draw, ((dia - width) / 2, int(WORDMARK_TOP * k)), word, font, NAVY, tracking)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=PUBLIC)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    master = os.path.join(PUBLIC, "flock-logo.png")
    if not os.path.exists(master):
        sys.exit(f"missing the source artwork: {master}")
    source_birds = Image.open(master).convert("RGBA").crop(BIRDS_BOX)

    for name, dia in TARGETS:
        path = os.path.join(args.out, name)
        print(f"{name:34} {dia}x{dia}" + ("  (dry run)" if args.dry_run else ""))
        if not args.dry_run:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            build(dia, source_birds).save(path)

    name, sizes = FAVICON
    path = os.path.join(args.out, name)
    print(f"{name:34} {', '.join(str(s) for s in sizes)}" + ("  (dry run)" if args.dry_run else ""))
    if not args.dry_run:
        # Each size drawn at its own scale, then packed into one ICO, so the
        # 16px entry is a 16px rendering rather than a shrunk 48.
        frames = [build(s, source_birds) for s in sizes]
        frames[0].save(path, format="ICO",
                       sizes=[(s, s) for s in sizes],
                       append_images=frames[1:])

    print("\nUntouched on purpose: appstore-icon-1024.png and the iOS AppIcon."
          "\nThey carry the birds alone, with no lettering.")


if __name__ == "__main__":
    main()
