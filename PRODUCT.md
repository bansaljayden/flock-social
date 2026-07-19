# PRODUCT.md — Flock

> Strategic context for design work (impeccable format). Sourced from .claude/CLAUDE.md,
> frontend/DESIGN.md, and the 2026-07 redesign decisions. Visual system: frontend/DESIGN.md.

## Register
**Product.** App UI — design SERVES the product. Flock is a multi-step social
coordination tool (create flock → invite → RSVP → vote venues → match budgets →
confirm → go), not a marketing surface. The only brand-register surface in this
repo is `src/website/*` (landing page), which keeps its own separate (teal) styling.

## Users & Purpose
- **Who:** Gen Z, ages 15–22, planning nights out and hangouts with friends.
  On their phones (Capacitor-wrapped web app on iOS), often mid-conversation,
  often at night. Impatient with friction; allergic to corporate UI.
- **Job to be done:** replace the broken group-chat planning loop with structured
  coordination. Primary task per screen: Nest = "what's happening / start something";
  Discover = "where should we go" (live crowd intelligence); Plans = "when";
  Messages = coordination chat; You = identity/safety/settings.
- **Workflow context:** quick sessions, one-thumb use, real-time (sockets),
  interruptions constant. Speed-to-action beats information density.

## Brand Personality (3 words)
**Warm · Confident · Unfussy.** The login screen is the north star: dark navy +
cream, flat surfaces, typography does the work. Feels like a well-made physical
object, not a growth-hacked app.

## Anti-references (what Flock must never feel like)
- AI-slop SaaS: purple gradients, glow stacks, glassmorphism-as-decoration.
- Corporate event tools (Eventbrite/Meetup): forms-first, gray, bureaucratic.
- Casino-Gen-Z apps: neon, confetti, streak-pressure, loud gamification.
- The 2026 cream+teal default. (Teal was deliberately killed 2026-07.)

## Strategic design principles
1. **Semantic color is sacred.** Green/amber/red = crowd states, red = SOS,
   green = online. Never swept, never decorative. Status *chips* on Nest are
   deliberately tonal/neutral (user decision 2026-07-18) — icons carry the distinction.
2. **One accent:** steel navy (#2d5a87 / #6d9ac3 dark). No second accent, no purple.
3. **Glass is for buttons only** (refined: blur + hairline + one inner highlight).
   Cards and surfaces are flat with whisper shadows.
4. **Accessibility is non-negotiable:** WCAG AA text contrast, reduced-motion
   honored, 16px inputs, keyboard focus rings — all already implemented; keep them.
5. **Speed over spectacle:** entrance animation is subtle and single-run;
   nothing infinite except live-status pulses (semantic).

## Accessibility needs
Teen users on phones at night: AA contrast in both themes (dark is primary at
night via auto night-mode), large touch targets (≥44px), reduced-motion support,
no zoom-on-focus (16px inputs). Apple App Store review compliance required.
