# Brand typography

What the two typefaces are, which one does which job, and how to get them into
a tool that is not a browser. Written 2026-09-05 while building the DECA pitch
deck cover, because the same questions came up three times in one evening.

## The two faces, and the one rule

| | Face | Where it is used |
|---|---|---|
| Display | **Fraunces** | Headings, and nothing else |
| Body | **Hanken Grotesk** | Everything else |

Both are self-hosted as variable fonts in `frontend/src/fonts/`, wired up in
`index.css` as `--font-display` and `--font-body`.

The rule the product already follows, stated plainly: **serif for the thing you
read first, grotesk for everything you read after.**

That is not a preference, it is a count. `var(--font-display)` appears in 34
places across the app and every one of them is an `h1`, `h2`, `h3`, or a single
large initial standing in for a heading — the Nest greeting, a venue name, the
Birdie header, the calendar month, the flock tile initials, every empty-state
headline. Everything else inherits Hanken Grotesk from the universal selector
in `index.css`, so body copy, buttons, labels, inputs and the tab bar are the
grotesk by default and the serif is opted into per heading.

**Apply the same rule to slides.** Fraunces for slide titles and the one hero
number on a slide. Hanken Grotesk for bullets, labels, sources, axis labels and
financial tables. A cover can be all serif because every line on a cover is a
headline. A break-even slide cannot, because it is mostly small text, and
Fraunces at 18pt in a table is where a serif stops looking expensive and starts
being hard to read.

## Optical size, which is the part people miss

Fraunces has an **optical size axis** as well as a weight axis, and it changes
the drawing, not just the scale.

- `opsz 144` is the **display** cut: dramatic thick-to-thin contrast. Looks
  expensive large. Its hairlines fall below one pixel when the glyph is
  rasterised small, so the letters go wispy and then fill in.
- `opsz 24` is the **text** cut: far less contrast, drawn to survive small.

This was diagnosed by rendering the wordmark at 300, 128, 64, 44 and 32 pixels
rather than comparing three versions at one large size. At 430px all the
settings look fine, which is why the first comparison could not be decided; at
44px only the text cut holds its shape.

**The logo wordmark uses `opsz 24, wght 900`.** Weight alone does not fix it,
because the heavy weight still thins those same strokes at display optical size.

## Getting them into Canva, Keynote, Slides or Word

Do not upload the raw `*-var.woff2` files. Every one of those tools accepts a
variable font and then exposes only its **default instance**, with no way to
reach the rest of the range, and the defaults here are wrong:

| Font | Default instance | Why that is wrong |
|---|---|---|
| Fraunces | `opsz 9, wght 900` | Heaviest weight on the *small-text* drawing. The opposite of a display cut. |
| Hanken Grotesk | `wght 400` | Fine, but you get only that one weight. |

Generate static cuts instead:

```bash
python tools/brand/make-font-cuts.py        # writes brand-fonts/ at the repo root
```

Six files, each one fixed weight, each renamed so it appears as its own family
in a font menu:

| File | Use it for |
|---|---|
| `Flock-Fraunces-Display-SemiBold.ttf` | Slide titles, section headings |
| `Flock-Fraunces-Display-Bold.ttf` | A title that needs punch, the one hero number |
| `Flock-Fraunces-Wordmark-Black.ttf` | The logo wordmark, and only that |
| `Flock-Hanken-Grotesk-Regular.ttf` | Body copy, bullets, sources, table cells |
| `Flock-Hanken-Grotesk-Medium.ttf` | Labels, small headings, captions |
| `Flock-Hanken-Grotesk-Bold.ttf` | Emphasis inside body copy |

`brand-fonts/` is gitignored. The variable woff2 files are the tracked source;
these are derived and regenerating takes a second.

**Canva, step by step.** Font upload needs Canva Pro.

1. Run the script above. Open `brand-fonts/` at the repo root.
2. In Canva, left sidebar, **Brand**. If you have more than one Brand Kit, open
   the one this deck uses.
3. Scroll to **Brand fonts**, then **Upload a font**.
4. Select all six `.ttf` files at once. Canva asks you to confirm you have the
   right to use them: you do, both faces are SIL Open Font License.
5. Wait for all six to finish. They appear grouped under three family names:
   Flock Fraunces Display, Flock Fraunces Wordmark, Flock Hanken Grotesk.
6. In the deck, select some text, open the font dropdown, and the three
   families are at the top of the list under your brand fonts.
7. Set the deck's defaults: title text to Flock Fraunces Display SemiBold, body
   text to Flock Hanken Grotesk Regular.

**If upload is not available**, Canva carries **HK Grotesk** in its own font
list. Hanken Grotesk *is* HK Grotesk — same designers, Hanken Design Co, and
the Google Fonts release is the updated version of that family. It is a correct
fallback, not an approximation. Fraunces is also in Canva's list.

If for some reason neither is reachable, the closest substitutes for Hanken
Grotesk are **Figtree** first, then **Manrope**, then **DM Sans**. Do not
substitute Poppins for body text: it is much rounder and wider, so it will not
match the site and it gets tiring in paragraphs.

## Licensing

Both faces are SIL Open Font License. Cutting static instances, embedding them
in a deck and uploading them to a design tool are all inside the licence. The
licence file travels with the font; do not sell the fonts themselves.

## Related

- `frontend/src/fonts/` — the variable sources, and the only tracked copies
- `frontend/src/index.css` — where `--font-display` and `--font-body` are set
- `tools/brand/make-font-cuts.py` — the generator, with the reasoning in its header
- `DESIGN-STANDARD.md` — the wider design and copy standard these choices sit inside
