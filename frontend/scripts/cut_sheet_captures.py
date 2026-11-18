"""Cut the home page's budget and bill captures down to their sheets.

Each 780 x 1688 capture is the app's blurred chat with a sheet over its lower
part, so on the page it was a phone-sized dark block with the subject in its
bottom half. The home page shows only the sheet (2026-11-06): the cut starts
CROPS[name] percent of the way down, on the sheet's own top edge, its first
whole row (rows 610 and 750 of the -v3 captures, the rig's sheetRow for each
frame; its grabber and rounded corners are in the cut, and the page draws
the corners), keeps the full width, and is written as <name>-sheet@2x.webp
(780 wide) and <name>-sheet-480w.webp (480 wide). The script checks that the
cut row is the sheet and the row above it is not, measured past the corner's
curve.

The percentages are the `crop` on each shot in src/website/landingAnnotations.js,
which maps the measured note boxes into the cut, and annotatedShot.test.js
checks the files against them. Run it again after the rig retakes either
capture:

    python frontend/scripts/cut_sheet_captures.py
"""
import os
import sys

from PIL import Image

SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'screenshots')
CROPS = {'budget-dark-v3': 36.14, 'bill-split-dark-v3': 44.43}
SHEET = (31, 42, 61)  # the sheet's fill in the dark theme

for name, crop in CROPS.items():
    src = Image.open(os.path.join(SHOTS, f'{name}@2x.webp')).convert('RGB')
    w, h = src.size
    if (w, h) != (780, 1688):
        sys.exit(f'{name}@2x.webp is {w} x {h}, not the 780 x 1688 the crops are measured on')
    top = round(h * crop / 100)
    near = lambda px: sum(abs(a - b) for a, b in zip(px, SHEET)) <= 10
    if not near(src.getpixel((60, top))) or near(src.getpixel((60, top - 1))):
        sys.exit(f'{name}: row {top} is not the top edge of the sheet; measure it again')
    sheet = src.crop((0, top, w, h))
    sheet.save(os.path.join(SHOTS, f'{name}-sheet@2x.webp'), 'WEBP', quality=82, method=6)
    small = sheet.resize((480, round(sheet.size[1] * 480 / w)), Image.LANCZOS)
    small.save(os.path.join(SHOTS, f'{name}-sheet-480w.webp'), 'WEBP', quality=82, method=6)
    print(f'{name}: cut at {crop}%, {sheet.size[0]} x {sheet.size[1]} and {small.size[0]} x {small.size[1]}')
