# Flock icons

`../Icons.js` is where every glyph is drawn. This folder holds the same
drawings as standalone SVG files, one per key (`nest.svg` is `Icons.nest`), so
they can be opened in a design tool or used where React does not run. Each file
is the glyph at 24 px: viewBox `0 0 24 24`, stroke 2.29, `currentColor`.

`src/__tests__/iconSvgFiles.test.js` fails when a file and `Icons.js` disagree.
After changing a glyph, rewrite the files from `frontend/`:

    WRITE_ICON_SVGS=1 CI=true npx react-scripts test iconSvgFiles --watchAll=false

## Rules

1. **Grid.** 24 x 24. Centrelines stay inside 2..22 and the stroke may overhang
   that by half its width. Ends and centres sit on half units, or quarter units
   where a glyph is centred by eye. Keylines: square 3.5..20.5, circle r 9 at
   12,12, wide 2.5..21.5, tall 14 x 18.
2. **One stroke.** `size / 10.5`: 2.29 px at 24, 1.90 at 20, 1.52 at 16, with a
   1 px floor and a 4.5 px ceiling, non-scaling, round caps and round joins. No
   hairline and no second weight. A glyph never sets its own stroke width.
3. **Geometry.** Straight segments run at 0, 45 or 90 degrees. Curves are
   circular arcs with whole or half radii, never ellipses. The few exceptions
   (the star, Birdie, the egg) are named in the `Icons.js` header.
4. **Corners** are sharp, softened only by the round join.
5. **Clear gaps.** Separate parts of a glyph stay 1.5 units apart, edge to edge
   (3 units where the gap has to survive at 12 px). Four stated exceptions:
   `helpCircle`'s question mark (its dot 1.1 from the hook and the ring, the
   hook 1.2 from the ring), the $ in `nestEgg` (1.1 from the shell, which is
   why it is drawn from 16 px up), `pro`'s two gulls (1.3 apart), and the
   binocular eyepieces, whose opening is 0.7 tall and fills in at 1x.
   `iconBirdSet.test.js` measures the set and holds each exception to its
   number; a new one needs a reason in the glyph's comment.
6. **Colour.** `currentColor` only: no gradient, no second tone, and no default
   colour on a new key. Each glyph clears 3:1 against the surface it sits on.
7. **Fill.** Outline is the default. The tabs have filled twins for the
   selected state (`nestFilled` and the rest). A filled glyph keeps its
   outline twin's silhouette and stroke, and punches its inner details out with
   fill-rule evenodd, so it needs no background colour. A cut is drawn a full
   stroke (2.29 units) wider than the gap it shows: half a stroke is eaten
   from each edge, so a 4-unit cut shows 1.71.
8. **Bird cues.** One per glyph, about a fifth of its ink at most, and it fails
   safe: take it away and the glyph still says its plain meaning. The cues come
   from a closed list: the birdhouse's entrance hole, binoculars, the beak, the
   egg, the pebble, the gull mark, a perched bird. No eyes except Birdie's, no
   faces, no feather texture, and never a whole bird in side profile.
9. **Plain where it counts.** Close, back, the chevrons, check, plus, search,
   the map pin, share, report, block and the emergency marks carry no bird.
   People reach for them without reading, so they match every other app.
10. **Accessibility.** `Icons.name(color, size, label)`. An icon is decorative
    by default (`aria-hidden`); given a label it becomes `role="img"` with that
    name, for an icon that is the only content of a control. Tabs keep their
    text labels, and a selected tab is never told apart by colour alone.

Check a new glyph at 12, 16, 20 and 24 px, at 1x, 2x and 3x, in both themes and
beside the glyphs it sits next to.

## The bird set

| Key | Used for | Drawing |
|---|---|---|
| `nest`, `nestFilled` | Nest tab | a birdhouse with its entrance hole |
| `discover`, `discoverFilled` | Discover tab | binoculars |
| `plans`, `plansFilled` | Plans tab | a calendar with one pebble marking the day |
| `messages`, `messagesFilled` | Messages tab; `chat` and `messageSquare` are the same drawing | a speech bubble whose tail is a beak, with two lines of text (carved out of the filled one) |
| `you`, `youFilled` | You tab; `user` is the same drawing | a bust with a neck gap, no bird on purpose |
| `startFlock` | Start a flock, 18 px and up (`plus` below that) | an egg with a plus |
| `nestEgg` | a flock's budget or cash pool, 16 px and up | an egg with a $ |
| `splitBill` | Split the bill | a receipt with a torn foot |
| `pro` | Flock Pro | two gulls climbing |
| `birdie` | Birdie, wherever the assistant is meant | the bird's head, the only eye in the set |

## Second pass (2026-11-07)

Drawn from Higgsfield concept sheets, then built by hand on the grid above.
The everyday controls (rule 9) did not change.

| Key | Drawing | Detail |
|---|---|---|
| `lock` | padlock | the keyhole is the entrance hole |
| `clock` | dial and two hands | the hands turn on a pebble |
| `image` | frame over hills | a gull where a stock picture puts a sun |
| `cocktail` | triangle glass | a pebble olive |
| `wine` | tall bowl on a stem | its own drawing (it was the cocktail glass) |
| `beer` | mug with a head of foam | its own drawing (it was the coffee mug) |
| `coffee` | cup with steam | its own drawing |
| `vote` | a ballot going into a box | the old drawing was a checkbox |
| `gamepad`, `cloud` | redrawn shapes | no bird; the old ones read as a box or a dome |

