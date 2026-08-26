# Does the frontend suite notice?

Measured 2026-08-26 against `9221f0a` + tonight's screen extractions. Every other
frontend audit asked whether the code was right. This one asks whether 1,666
passing assertions across 65 suites would go red if it were not.

The method was to break the code on purpose. 100 mutation runs, 59 distinct
hand-written defects introduced into frontend source one at a time, each run
against **all 1,666 assertions** (the whole suite takes 16 seconds, so there was
no reason to run a subset), then reverted with `git status` checked clean between
every one.

**22 of 58 real defects survived the entire suite.** One more was an equivalent
mutant and is excluded. The survivors are not spread evenly, which is the useful
part: two areas account for eighteen of them.

> **Follow-up, same day.** The five defects this report deliberately left alive,
> with reasons, are now all closed. The reasons are still worth reading, because
> two of them turned out to be wrong about how hard the fix was. See
> "Changed in the follow-up pass" at the bottom, and the struck-through lines in
> sections 1 and 2 and in the source-scanning section.

---

## Where the next hour goes

### 1. `services/contacts.js` had no test at all. FIXED.

240 lines. It is the privacy boundary for the user's address book and the iOS
permission gate, and **no test file imported it.** Eleven defects planted, eight of
them passed:

| defect planted | result |
|---|---|
| never fire the iOS permission dialog | green |
| let a denial through and read the book anyway | green |
| treat iOS 18 limited access as a refusal | green |
| send every number undeduped | green |
| remove the 3-batch ceiling, upload the whole book | green |
| turn a 429 back into a hard failure | green |
| stop reporting `throttled` for an oversized book | green |
| read a dismissed picker as a denial | green |

The three that were caught were caught by *greps over the file's text* from
`contactDiscoverySurface.test.js`, which reads the service as a string. That file
also carried the line "Pinned in `services/contacts.js` by its own suite too."
There is no such suite. The comment was wrong.

**Fixed.** `contactDiscoverySurface.test.js` now ends with 16 tests that run the
service against a stand-in `@capacitor-community/contacts` plugin. All eleven
defects above now go red, plus three more (three numbers per contact instead of
two, mobile-first ranking reversed, a rejected permission dialog swallowed as
granted). The comment now points at the block that actually does the pinning.

~~**Still open here:** the web Contacts Picker path~~ **Closed 2026-08-26.**
Nine more executed tests run the `navigator.contacts.select` branch on a
plain-web window with a stand-in picker. The one this block was written about:
the Picker API rejects with a **TypeError** when the sheet is closed with
nothing chosen, and reading that as a denial shows the permission-refused state
to somebody who refused nothing, on a platform where there is no stored
permission to repair. Eight defects verified red: the TypeError read as a
denial, every failure read as a cancellation, an empty selection accepted as a
successful read, the projection widened past `tel`, the two-numbers-per-card
ceiling dropped, dedupe dropped, the web branch asking the native plugin for a
stored state, and picker detection removed.

### 2. The flock chat send path had no test either. PARTLY FIXED.

The most-used control in the product. Eleven defects planted, ten of them passed:

| defect planted | result |
|---|---|
| `sentOverSocket` gated on `connected` alone, not the emit's return value | green |
| a lost echo never marks the bubble failed | green |
| the typing latch is not reset after a send | green |
| the temp bubble adopts any id the reply carried | green |
| a refused send is silent again | green |
| an empty composer sends | green |
| the retry drops `venue_data` | green |
| the invite sheet fires with nothing selected | green, **red since 2026-08-26** |
| an invite failure is swallowed | green, **red since 2026-08-26** |
| the send button loses `disabled={!chatInputHasText}` | green, **red since 2026-08-26** |
| the failed bubble loses its tap-to-retry | **red** |

The first one is the worst: that expression is the difference between a lost
message and a double-posted one, and its own comment explains exactly that.

**Partly fixed.** `chatSurface.test.js` gained six tests covering the first
seven rows. They are **source pins, not proofs**. `transmitFlockMessage` is a
`useCallback` closed over eight refs inside a 20,000-line component, so it cannot
be lifted out the way `isServerId` and `prependOlder` already are, and reaching
it for real means rendering the whole app. A pin refuses the specific edit that
removes the property; it does not establish the property. Every one was verified
by making the edit and watching it go red.

~~The three invite/composer rows are still green.~~ **Closed 2026-08-26, and the
render harness was not the bigger job it looked like.** The screen that left
`App.js` has 146 props and **not one hook**: no `useState`, no `useEffect`, no
`useRef`. It is a pure function of its props, so it mounts on its own against a
hand-built props object with no `App.js` anywhere near it, and the two button
facts stopped being source pins:

- **The send button.** `disabled={!chatInputHasText}` is now proved by
  dispatching the click and asserting `sendChatMessage` was not called. What
  ships without that attribute is not a missing affordance: `opacity` and
  `cursor` are separate expressions on the same element, so the button still
  *looks* unavailable and posts an empty message on every tap. The opposite
  defect is covered too, since `disabled` hard-coded true would otherwise pass.
- **The invite sheet.** The send button is not in the document with nothing
  selected, its label carries the count that was actually picked, and a send
  already in flight cannot be fired twice.

`handleSendFlockInvites` is genuinely unreachable from the screen, because it is
a `useCallback` in `FlockAppInner` that arrives as a prop. It is not pinned
either. Its **body is lifted out of `App.js` as source text and executed**
against stand-in collaborators, which is `extractDeclaration` extended to a
closure by naming the free variables and passing them in. The guard runs, so
deleting it lets a real call reach a real spy; the catch runs, so a rejected
invite either reaches `showToast` or it does not. What the lift does not prove
is that `App.js` passes those particular collaborators. It is anchored on the
opening line and on the exact dependency array, so a change to either throws by
name instead of testing a stale copy, and that was verified both ways.

New harness file: `chatComposerAndInviteSheet.test.js`, 14 tests, seven defects
verified red plus three that break the harness loudly on purpose.

### 3. Two api.js timeout facts were asserted by tests that could not see them. FIXED.

- `UPLOAD_TIMEOUT_MS` cut from 90s to 15s stayed green. The test named "an upload
  that trickles is bounded too, **on its own longer leash**" only ever proved the
  upload timed out, never that the leash was longer than the default. The real
  regression is every photo on a weak connection getting cut off at 15 seconds.
- Deleting the rearm on the line after `fetch` resolves stayed green. The
  "arrives in pieces" test sends its first chunk 25ms in, so the original
  deadline still covers it; the rearm only matters when time-to-first-byte eats
  most of the window, which on bad signal is the normal case.

**Fixed** in `offlineAndPoorNetwork.test.js`: the upload test now asserts it has
*not* settled at 30s and *has* by 95s, and a new test gives the headers 200ms of
a 300ms window and then streams the body, which fails without the rearm.

### 4. The accessibility sweep's icon-button list was hand-written. FIXED.

`accessibilitySweep.test.js` named nine icon-only controls "across the screens a
user cannot avoid: flock chat, DM, Birdie…". It named Birdie's Send button and
not the flock chat one. `onClick={sendChatMessage}` could lose its `aria-label`
with all 1,666 green. So could the DM send button.

**Fixed.** The set is now derived: every `<button>` whose entire child is a
single `Icons.*(…)` call must carry `aria-label` or `aria-labelledby`. 90 such
buttons exist and all 90 are named, so the rule ships at zero false positives,
and a vacuity guard fails if the scan ever finds fewer than 70. Verified against
three defects (flock send, DM send, `aria-label` swapped for `title`).

### 5. The signup screen's second tap. FIXED.

Deleting `document.getElementById(fieldId)?.focus()` from `handleSubmit` stayed
green. `AuthError` moves focus to itself only when its text *changes*, so from
the second tap of Create account onward that `focus()` is the only thing that
moves. Its removal restores a primary button that silently does nothing, which
is the `$dead_click` cluster the whole file exists for. Now covered by a test
that submits twice and asserts focus lands on the Name field the second time.

---

## The source-scanning question, answered

61 of 65 suites read source files as text. 34 read `App.js`. That style fails in
one specific way: it silently observes less when the code moves, and tonight
about 3,600 lines moved into `frontend/src/screens/`.

**The repointing done tonight holds.** Six defects planted *inside the moved
screens* were checked against the suites that claim them:

| planted in a moved screen | caught |
|---|---|
| an icon drawn below the 12px floor (`AddFriends.js`) | yes |
| the web Contacts Picker called (`AddFriends.js`) | yes |
| a new tab opened with a bare target (`ChatDetail.js`) | yes |
| a raw star glyph back in the source (`VenueDashboard.js`) | yes |
| a raw-interpolating map popup (`VenueDashboard.js`) | yes |
| **an em dash in user-visible copy (`ChatDetail.js`)** | **no, until 2026-08-26. Yes now** |

And the scans cannot silently shrink: cutting the screen reads back out of
`iconAndAlertSweep`, `appIconFloorAndAlerts`, `birdBrandMoments`,
`accessibilitySweep`, `chatSurface` and `contactDiscoverySurface` turns each of
them red. That is because each has at least one **positive** assertion anchored
in the screen file. A positive assertion anchors a scan. That is the whole
mechanism, and it is worth stating as a rule: *a suite whose assertions about a
file are all negative cannot tell that file from an empty string.*

`externalLinksAndCoordinatePrivacy` does the strongest version of this: it walks
`src/` rather than naming files, so it is move-proof by construction. It is the
pattern to copy.

~~**The em dash is the one real gap.**~~ **Closed 2026-08-26.** SLOP-AUDIT calls
A2 "the #1 regression risk on any new copy," and there was no app-wide guard:
every check was scoped to about eight pinned regions (`handleSendFlockInvites`,
the pay sheet, the two error boundaries, a settings row), and an em dash
anywhere outside them passed.

`copyEmDashSweep.test.js` now walks all 46 non-test `.js` files under
`frontend/src`, parses each with `@babel/parser`, and reads **StringLiteral,
TemplateElement and JSXText and nothing else**. That is what tells copy from a
comment: a comment is not any of those node types, so it is excluded by
construction rather than by a pattern somebody has to keep correct. A regex over
lines cannot make that distinction, and the distinction is the whole problem,
because there are well over a hundred em dashes in `frontend/src` and every one
of them is a comment. A character count would be red the day it shipped and stay
red, which is a check people learn to scroll past.

**What it found: zero.** Not one em dash in a user-visible string anywhere in
the app today, so the pinned-region checks happened to be sufficient and no copy
needed rewriting. The value is entirely in the next one. Three things it does
not flag, each measured rather than guessed: test NAMES in the colocated
`src/services/flockWriteContract.test.js`, CSS comments inside the `<style>`
template in `App.js`, and the four strings whose entire value is a single em
dash used as the empty-cell glyph in the admin-only moderation console, which
SLOP-AUDIT A2 itself counted and passed. The last allowance is exactly one
character wide, so a spaced dash between two words is still caught.

Vacuity, since a broadened sweep fails by inspecting less rather than by
inspecting wrong: the walk must find 40+ files, the parse must inspect 25,000+
strings (36,124 today), a file that fails to parse is a hard failure and never a
skip, and real copy from six named files must appear in what was collected.
Verified against ten mutations: an em dash in a string literal, in JSX text, in a
template chunk, in `<style>` CSS outside a comment, and as a spaced dash all go
red; an em dash added to a source comment stays green; and emptying the walk,
narrowing it to one file, or breaking a file's syntax each turn the guards red.

---

## What is genuinely strong

Worth saying, because the survivors above are not the whole picture.

- **The auth screens.** 15 defects, 13 red. Reordered validation, deleted
  `noValidate`, deleted the email shape check, downgraded `autocomplete`, dropped
  `role="alert"`, dropped `tabIndex`, dropped `aria-pressed`, dropped the eye
  toggle's name, removed a `htmlFor`, accepted an impossible date of birth. All
  caught, by tests that **render and interact** rather than grep.
- **`services/api.js` offline and retry.** 12 defects, 10 red. Flipping
  `navigator.onLine === false`, making writes retryable, retrying timeouts,
  removing an `await`, dropping `err.isOffline`, removing the hard-deadline
  clamp, surfacing an abort as a connection error: all caught.
- **The vacuity guards that already exist.** `appIconFloorAndAlerts` asserts its
  scan found more than 150 sized icon calls before asserting anything about them.
  That is the right instinct and there should be more of it.

The pattern is clean: **suites that execute go red; suites that grep go red only
for the exact spelling they pinned.** Both classes exist here on purpose, and
the grep class is genuinely the only option for some of these facts. The failure
is not grepping. It is grepping and then believing the result covers a property.

---

## Scope, honestly

100 mutation runs. 59 distinct defects during the audit, plus 26 verification
runs on the assertions this session wrote or changed and 6 mutations of the test
files themselves. Against 1,666 assertions, that is a sample of roughly 3.5%.

The defects were **not random**. They were chosen to model mistakes a person
actually makes, concentrated in six areas named in advance: auth validation, the
invite sheet, chat send states, the contacts permission gate, the accessibility
sweeps, and offline/timeout behaviour in `services/api.js`.

**What this licenses:** the six areas above are measured, and the two zero-coverage
findings (`services/contacts.js`, the chat send path) are facts, not estimates.
a file with no importing test has no behavioural coverage regardless of sample
size.

**What it does not license:** any claim about the other ~59 suites. The venue
dashboard, the map, the moderation console, the marketing pages, the paywall, the
push surface and the legal pages were not mutation-tested at all. A 62% catch
rate in this sample is not the suite's catch rate; it is the catch rate of a
deliberately adversarial sample aimed at the places most likely to be weak, and
the two areas that dragged it down were areas with literally no test. Excluding
those two, 12 of 37 survived.

**One number to trust and one to distrust:** trust that the whole suite runs in
16 seconds, which is why every mutation could be run against all of it and why
the next person should do the same. Distrust "1,666 tests" as a measure of
anything, since 22 real defects walked through all of them.

---

## Changed in this pass

Five test files. No source files were changed: no mutation revealed a source
defect. Every assertion below was verified by breaking the code, watching it go
red, and reverting.

| file | added | verified against |
|---|---|---|
| `contactDiscoverySurface.test.js` | 16 executed tests for `services/contacts.js` | 11 defects, all now red |
| `chatSurface.test.js` | 6 pins on the send path | 7 defects, all now red |
| `offlineAndPoorNetwork.test.js` | upload leash both edges, TTFB rearm | 2 defects, both now red |
| `accessibilitySweep.test.js` | derived icon-only-button sweep + vacuity guard | 3 defects, all now red |
| `authScreensAccessibility.test.js` | the second tap moves focus to the field | 1 defect, now red |

1,691 tests across 65 suites, `CI=true npx react-scripts build` compiles with
zero warnings.

---

## Changed in the follow-up pass, 2026-08-26

The five survivors this report left open on purpose. All five are closed, and
again no source file was changed, because again no mutation revealed a source
defect. The em dash sweep was the reason to expect one and it found nothing:
there is not a single em dash in a user-visible string anywhere in the app.

| file | added | verified against |
|---|---|---|
| `copyEmDashSweep.test.js` (new) | app-wide AST sweep for A2 over all 46 source files | 10 mutations: 5 red, 1 green control, 4 vacuity guards red |
| `chatComposerAndInviteSheet.test.js` (new) | 14 tests: the screen rendered, plus `handleSendFlockInvites` lifted and executed | 7 defects red, 3 anchor breaks fail by name |
| `contactDiscoverySurface.test.js` | 9 executed tests for the web Contacts Picker path | 8 defects, all now red |

1,725 tests across 67 suites, `CI=true npx react-scripts build` compiles with
zero warnings.

**Two things worth carrying forward.** First, `screens/ChatDetail.js` has no
hooks, so it renders standalone: anything else in that 2,000-line screen can be
tested by mounting it rather than reading it, and the props factory in
`chatComposerAndInviteSheet.test.js` is the harness. Second, a closure inside
`FlockAppInner` can be executed after all, by slicing its body out of the source
and naming its free variables. That is weaker than mounting and much stronger
than a pin, and it applies to `transmitFlockMessage` and `sendChatMessage` next.
