#!/usr/bin/env python
"""
make-font-cuts.py — flatten the brand's variable fonts into static files.

WHY THIS EXISTS. Flock's two typefaces are shipped to the browser as VARIABLE
fonts (frontend/src/fonts/*-var.woff2), which is right for the web: one file
carries every weight and the CSS asks for the one it wants. It is wrong for
every tool that is not a browser. Canva, Keynote, Google Slides and Word all
accept a variable font and then expose only its DEFAULT instance, with no way
to reach the rest of the range.

That default is actively misleading here. Fraunces defaults to weight 900 at
optical size 9, i.e. the HEAVIEST weight drawn for SMALL text. Upload the raw
file to Canva and every heading comes out in a fixed, chunky cut that is the
opposite of the display setting the brand actually uses, and nothing in the UI
explains why.

So this script writes one file per setting we actually use, renames each so it
appears as its own family in a font menu, and leaves the web build untouched.

    python tools/brand/make-font-cuts.py [--out DIR]

Output defaults to `brand-fonts/` at the repo root, which is gitignored: these
are derived artefacts, and the variable sources are the thing under version
control. Both faces are SIL Open Font License, so cutting instances and using
them in a deck is squarely within the licence; the licence travels with them.

Requires fontTools with brotli (`pip install fonttools brotli`), which is what
lets it read the woff2 sources directly rather than needing a separate download.
"""

import argparse
import os
import sys

try:
    from fontTools import ttLib
    from fontTools.varLib import instancer
except ImportError:  # pragma: no cover - a dependency message, not logic
    sys.exit("fontTools is required:  pip install fonttools brotli")

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(REPO, "frontend", "src", "fonts")

# Each cut names the job it does, not the numbers behind it, because the file
# name is what shows up in a font menu six months from now.
#
# The optical-size axis is the one that matters and the one people miss.
# Fraunces at opsz 144 is drawn for display: dramatic thick-to-thin strokes
# that look expensive large and lose their hairlines small. At opsz 24 it is
# drawn for text, with far less contrast, which is what survives at wordmark
# and favicon sizes. Same typeface either way.
CUTS = [
    ("Fraunces-var.woff2", {"opsz": 144, "wght": 600},
     "Flock Fraunces Display", "SemiBold", "slide titles, section headings"),
    ("Fraunces-var.woff2", {"opsz": 144, "wght": 800},
     "Flock Fraunces Display", "Bold", "a title that needs punch, the one hero number"),
    ("Fraunces-var.woff2", {"opsz": 24, "wght": 900},
     "Flock Fraunces Wordmark", "Black", "the logo wordmark, and only that"),
    ("HankenGrotesk-var.woff2", {"wght": 400},
     "Flock Hanken Grotesk", "Regular", "body copy, bullets, sources, table cells"),
    ("HankenGrotesk-var.woff2", {"wght": 500},
     "Flock Hanken Grotesk", "Medium", "labels, small headings, captions"),
    ("HankenGrotesk-var.woff2", {"wght": 700},
     "Flock Hanken Grotesk", "Bold", "emphasis inside body copy"),
]


def rename(font, family, style):
    """Give the instance its own family name.

    Without this every cut claims to be "Fraunces" and a font menu shows six
    entries with one name, or silently keeps whichever it loaded first.
    IDs 1/2 are the classic family/subfamily, 16/17 the typographic pair that
    modern applications prefer; both are set so old and new tools agree.
    """
    name = font["name"]
    full = f"{family} {style}"
    postscript = f"{family.replace(' ', '')}-{style.replace(' ', '')}"
    for nid, value in ((1, family), (2, style), (4, full), (6, postscript),
                       (16, family), (17, style)):
        for record in list(name.names):
            if record.nameID == nid:
                name.setName(value, nid, record.platformID, record.platEncID, record.langID)
        name.setName(value, nid, 3, 1, 0x409)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, "brand-fonts"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    for src, axes, family, style, purpose in CUTS:
        path = os.path.join(SRC, src)
        if not os.path.exists(path):
            sys.exit(f"missing source font: {path}")
        font = ttLib.TTFont(path)
        available = {a.axisTag for a in font["fvar"].axes}
        # The web build subsets the axes it ships. Asking for one that was
        # subsetted out raises, so pin only what this file actually carries.
        pinned = {k: v for k, v in axes.items() if k in available}
        dropped = set(axes) - set(pinned)
        font = instancer.instantiateVariableFont(font, pinned, inplace=False,
                                                 updateFontNames=False)
        rename(font, family, style)
        out_name = f"{family.replace(' ', '-')}-{style}.ttf"
        font.flavor = None  # write a plain TTF; woff2 is for browsers, not font menus
        font.save(os.path.join(args.out, out_name))
        note = f"  (axes not in this build, skipped: {sorted(dropped)})" if dropped else ""
        print(f"{out_name:44} {purpose}{note}")

    print(f"\n{len(CUTS)} files in {args.out}")
    print("Upload these to Canva: Brand > Brand Kit > Fonts > Upload a font.")


if __name__ == "__main__":
    main()
