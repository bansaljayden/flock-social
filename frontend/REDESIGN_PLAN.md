# Flock Front-End Redesign — Ultra Plan (EXECUTED 2026-07-18)

**Thesis:** Make the whole app feel like the login screen. Flat editorial minimalism.
Cream + navy only. Typography does the work. Zero glow, zero glass, zero teal.
Grounded in a 6-agent line-level audit of App.js (~14.3k lines) + the CSS layer (2026-07-18).

## New design rules
- **Accent:** steel navy `#2d5a87` light / `#6d9ac3` dark. (Token swap DONE — colorsLight/colorsDark `teal:` retargeted; 116 refs covered.)
- **Primary buttons:** flat. `background: var(--text-primary)` → navy w/ white text (light), cream w/ navy text (dark) — the login Sign In everywhere.
- **Cards:** solid fill + 1px hairline + whisper shadow `0 1px 2px rgba(30,41,59,0.04)`.
- **Kill:** backdrop-filter blur, inset shadow stacks, decorative gradients (~25), teal/purple glows, orbs, birdie-grid, shimmer, rotated card stack (pending call), dead shadcn block, App.css boilerplate.
- **Keep:** semantic colors (green/amber/red crowd, red SOS, green online), photo scrims, Satoshi, film grain, reduced-motion, focus ring (recolored navy), tabular-nums, auth screens untouched.

## Phases
1. **CSS foundation (index.css):** glass system → flat spec; shadow tokens → whisper; focus ring navy `rgba(45,90,135,0.9)`; delete orbs (371-460), shimmer (463-513, 576-585, 636-639, 654-669), shadcn block (592-634); nav-shadow → hairline `0 -1px 0 var(--border-color)`; flock-stack overrides opaque. Delete App.css (verify unused).
2. **Color sweep (App.js):** hardcoded teal at 342, 358, 931, 4964, 5084, 5163-5172, 6450, 6454, 7047, 8269, 9035, 9056, 9117-9126, 9832, 10346, 12602, 12781, 13890, 14221, 14290 → steel navy solid / navy tints; delete teal glow shadows. **Bug fix:** quiet-crowd bars 7146 + 7213-14 → semantic green `#22C55E` (teal was the "quiet" signal). Purple decorative (Birdie: 4292, 5509, 5564, 5590, 5676, 5717, 5784, 9496) → navy. NIGHT badge 5935-36, 10193-94 → navy.
3. **De-glass components (App.js):** sent bubble 8494/8498 gradient → solid navy (align to DM bubble 5350 = already correct); Start-a-flock 6050-6078 flat; Add-friends 6084-6117 flat, no blur; tab bar 4055-56 blur → solid+hairline; SOS FAB 4246/4250 + modal 4357 → solid red; Birdie FAB 4288-4310 flat; chat header 8153 blur → solid; gradientButton def 1194-1205 → flat navy; profile header 10126, hero CTAs 12794/12808, ~26 heavy shadows (5869, 10234, 12358, 6732, 6644, 4336, 8527, 8894, 8656-58, 8498, 9732, 10146, 13034, 13870, 12698…) → ≤0.05.
4. **Flock cards stack → flat list (pending call):** delete rotation 6127/6142-44, overlap 6147-49, glass classes 6132; gap list modeled on "Needs your attention" 6016-6048; delete index.css 341-346 + 642-651.
5. **Verify + ship:** dev+prod compile per phase; screenshot login; user eyeballs authed screens on localhost; commit per phase; push on approval.

## Open judgment calls (user to decide)
1. **Flock cards:** flatten to list (recommended) vs keep de-glassed stack?
2. **Purple:** kill all (recommended — true 2-color brand) vs keep Pro-tier/concert-category purple as semantic?
3. **SOS:** flat solid red (recommended) vs keep one deliberate red glow?

## Status — COMPLETE (5 commits, local, not pushed)
- 18a7b2c redesign(1/5) CSS foundation — refined glass, flat tokens, navy accent
- 9ae9dbe redesign(2/5) color sweep — teal & purple → steel navy (semantic kept)
- 2007d64 redesign(3/5) component flattening — 143 gradient/glow/shadow edits
- b8566fe redesign(4/5) flock cards — rotated stack → flat list
- (5/5)   verification + docs (this commit)
Amendments during execution: all buttons keep REFINED glass (user call);
shadcn HSL block kept — load-bearing for the prod CSS optimizer (bisected).
