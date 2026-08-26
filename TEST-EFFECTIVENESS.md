# How much would the backend tests notice?

2026-08-26. Every other audit in this repo asks whether the code is right. This one
asks whether the tests would go red if it were not.

**Method.** 42 hand written defects were introduced one at a time into backend
source, the suite that claims to cover each one was re-run, and the edit was
reverted. 4 further edits were pure renames and comment rewordings, applied as
controls: those must NOT go red. Every survivor was then re-run against the entire
4,676 test suite before being recorded as a survivor. 11 more edits were applied
afterwards to prove the assertions written to close the gaps actually fail when the
code is broken. 57 edits in total, all reverted, `git status` clean between each.

**Result: 36 of 42 killed, 6 survived.** All 4 controls survived, which is the
right answer: nothing in the sampled area breaks on a rename.

**What this licenses and what it does not.** 42 mutations against roughly 4,676
assertions is a sample of well under one percent, and it was not random. It was
aimed at eight named controls chosen because a failure in them is expensive:
authentication and token revocation, the budget ceiling publication rules, block
and ban filtering, the guest surface's field withholding, the SOS emergency bypass,
the rate limiters, the migration runner, and moderator takedowns. Within those, the
mutations were chosen to model plausible edits: a dropped `OR` term, a `>=` that
became `>`, a threshold measured over the wrong population, a check moved after the
write. A high kill rate here is evidence about those eight controls and about
nothing else. It says nothing about the ML pipeline, the advisor, billing, push
delivery, or the sockets, none of which were touched.

**And there is a reason the score is this high.** `__tests__/mutationGaps.test.js`
records that somebody already ran 400 single-token edits over `routes/billing.js`,
`routes/auth.js` and the calibration half of `services/crowdEngine.js`, and
`safetyPathAudit.test.js` has a whole section headed "the gaps a mutation pass
found in the tests above". This sample deliberately avoided those files. The
survivors it did find cluster almost entirely in the two areas no sweep has ever
touched: `db/migrate.js` and the block predicates.

---

## Where to spend the next hour

1. **`db/migrate.js` has never been mutation tested and 3 of 7 mutations lived
   through it.** One of them is the whole point of the file. Details below.
2. **The suite is flaky on Windows, and the flake looks exactly like a real
   failure.** Measured today: 2 of 3 full `node --test` runs came back with one
   failing "test", both times `migrationSearchPath.test.js`, both times
   `EPERM ... rm` from `embedded-postgres` failing to delete its temp directory in
   an `after` hook. Three mutation runs went red the same way, blamed on
   `mlExportColumnGrowth`, `mlCorpusDedupe` and `feedbackBackfillMigration`, and
   none of the three reproduced when the named file was re-run. One full suite run
   hung indefinitely and had to be killed. Run on its own,
   `migrationSearchPath.test.js` passed 4 times out of 4, so this is contention:
   `node --test` runs files in parallel and the embedded Postgres suites fight over
   shutdown and the Windows file locks that follow it. It costs twice, because a
   red run gets dismissed as noise and a mutation that survived gets recorded as
   caught. It is the single thing most worth fixing before anyone tries this again
   with a tool, which would run thousands of these.
3. The three block and budget gaps below are already closed. The migration ones are
   not.

---

## The six survivors

### 1. `isBlockedBetween` only had to look one way. FIXED.

Deleting `OR (blocker_id = $2 AND blocked_id = $1)` from `utils/blocks.js` left all
4,676 tests green. What that ships is A blocks B, A stops reaching B, and B keeps
reaching A through DMs, invites, pushes and every other caller, which is the exact
control Apple 1.2 is tested on, in the file whose own header calls itself "the
single source of truth for that enforcement".

**Kind 3, a test that passes by observing less than it claims to.** The mutuality of
`getInvisibleUserIds` IS pinned (`rosterBlocks.test.js` asserts both legs of its
UNION, and dropping one killed the mutant instantly). The pair check never was. Nine
test files mock this query, and every one of them dispatches on the prefix
`FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)`, which a
one-directional query still contains. The whole mock ecosystem is prefix matched and
therefore blind to any predicate removed from the end of a WHERE clause.

**Closed** in `__tests__/safetyPathAudit.test.js` with a symmetry assertion rather
than a text match: swapping the two bind placeholders must leave the set of OR terms
unchanged. Verified against three edits. Dropping either direction goes red;
reordering and reflowing the two terms stays green.

### 2. `storyVisibilitySql` had lost its only real assertion. FIXED.

Same mutation on the story visibility predicate in `utils/relationships.js`, same
result: 4,676 green.

**Kind 3 again, and this time it is the `takedownAudience` failure from tonight
repeated exactly.** `moderationReach.test.js` has a test called "the helper
reproduces routes/stories.js byte for byte". It reads:

```js
if (STORIES_SRC.includes('storyVisibilitySql')) { ...; return; }
```

`routes/stories.js` has since adopted the helper, so that branch is now always
taken, and the byte comparison it was written for is dead code. What is left runs
two `assert.match` calls against the CALL SITE and nothing at all against what the
helper emits. Measured, by running the old file against the mutants: three separate
defects lived through it. The reverse block direction, the forward block direction,
and flipping the helper's `excludeHidden` default to `false`, which silently stops
the story feed filtering moderator takedowns.

**Closed** by making the adopted branch assert the properties the byte comparison
used to assert, against the helper's own output, plus the same swap based symmetry
check on the block clause, also added to the two report gate tests that were making
do with `assert.match(gate, /FROM user_blocks b/)`. That regex is satisfied by a
one-directional clause. Verified: all four defects now go red, a reorder stays
green.

### 3. The budget skip count floor was never evaluated at its boundary. FIXED.

`publishableSkipCount` withholds the skip and share split unless the caller has at
least three CO-MEMBERS, `(totalMembers - 1) >= 3`. Changing it to
`totalMembers >= 3` left the suite green.

**Kind 4, genuinely uncovered.** Round 23 made the split publishable only in the one
payload that settles the budget, and every published case in
`abuseBudgetAnonymity.test.js` uses a four member flock, where the answer does not
depend on the `- 1`. The three member cases are all reads, and reads withhold
unconditionally. So the one scenario that can reach the boundary, a three member
flock where all three submit amounts and the third answer settles it, was never
written. Under the mutation that payload publishes `skipCount: 0`, which tells a
caller who knows their own answer that both of the other two shared an amount. That
is precisely the leak the code's own comment describes.

**Closed** with `ABUSE H4` in `abuseBudgetAnonymity.test.js`. Verified against both
directions of the off by one. The existing `HELD` test already caught the
over-strict direction, so the boundary is now bracketed from both sides.

### 4. The migration runner will record a swallowed failure as applied. OPEN.

Deleting `await assertRequirementsMet(client, file, reqs)` from the default
transaction branch of `db/migrate.js` left the suite green.

**Kind 4.** That single line is the reason the whole `@requires` mechanism exists.
The file's header spends forty lines on it: 032 and 038 wrapped their `ALTER TABLE`
in `EXCEPTION WHEN others THEN NULL`, a lock timeout was swallowed, the file was
recorded as applied with its columns absent, and nothing ever retries a migration
the runner believes is done. There are three tests around this and none of them
covers it. `a lock timeout during 032 fails the boot` covers a file that RAISES.
`a database already mismarked` covers the HEAL, which has its own copy of the check
and still had it after the mutation. `neither 032 nor 038 may go back to catching
others` is a scan of the migration source text, not of the runner.

So the property "a file that returns without delivering is not recorded" is proven
for the repair path and unproven for the first application, which is the path that
produced the incident.

**Not closed, and the reason is worth knowing before someone tries.** `migrate()`
hardcodes `path.join(__dirname, '..', 'migrations')`, so testing this means writing
a probe migration into the real directory. `node --test` runs test FILES in
parallel, and four other suites call `migrate()` against that same directory, so a
probe file present for even a second breaks them. The cheap fix is to let
`migrate()` take a directory argument. That is a source change, so it is left as a
recommendation rather than made here.

### 5. The migration mode directive does not have to be on the first line. OPEN.

`migrationMode` reads `head.startsWith('-- @tolerant')`. Changing it to
`sql.includes('-- @tolerant')` left the suite green, because no file currently
mentions the directive anywhere but its head. Under that mutation, a migration whose
prose happens to quote the directive runs in tolerant mode, which swallows every
statement error. **Kind 4.** Lower severity than the one above and blocked by the
same missing seam.

### 6. Migration files are not proven to run in sorted order. OPEN, probably equivalent.

Removing `.sort()` from the `readdirSync` chain left the suite green. On NTFS
`readdirSync` already returns names in collation order, so this is very likely an
equivalent mutant on this machine and would not be on every filesystem. Recorded for
honesty rather than as a real gap. Do not spend the hour here.

---

## What held, and is therefore worth trusting

- **Authentication and token revocation: 10 of 10 killed.** Inverting the ban check,
  dropping the HS256 pin, dropping the `tv` claim at mint, dropping the socket
  handshake's version check, weakening `tokenVersionOf`, letting `requireVerified`
  wave through a missing `req.user`, removing duplicate slash collapsing from the
  unverified gate, ignoring the HTTP method on that gate, passing `false` to
  `disconnectSockets`, and widening `isUnverified` all went red, most of them
  against named tests that say what they are protecting.
- **Rate limiters: 6 of 6 killed**, including the `>=` to `>` off by one in
  `utils/probeBudget.js`, the day rollover wiping the rolling hourly history, the
  prune forgetting a live hour, the key accepting any finite number, removing the
  once per request charge from `apiLimiter`, and raising `authLimiter` from 10 to
  100.
- **SOS emergency bypass: 3 of 3 killed.** Removing the `EMERGENCY_CATEGORY`
  bypass, putting the ordinary ban enforcing `authenticate` back on `POST /alert`,
  and making the suppression lookup fail closed instead of open all go red against
  tests that name the reason.
- **Guest surface: 3 of 3 killed**, including publishing a full name instead of a
  first name, dropping the `is_hidden` filter from the roster, and an off by one on
  the `full` flag.
- **Budget ceiling: 4 of 5 killed.** Publishing the ceiling on every submission,
  rounding the band up instead of down, lowering the three amount floor to two, and
  letting departed members' amounts back into the MIN are all caught hard, several
  by more than twenty assertions each.
- **Ban and takedown filtering: 3 of 3 killed**, including an admin ban no longer
  dropping the banned account's live sockets.
- **The four no-op controls all stayed green.** Renaming a private helper, renaming
  a local, renaming a local inside the auth middleware, and rewording a comment
  break nothing. Whatever else is true of this suite, it is not pinning spellings in
  the areas sampled.

## What changed in the tests

| File | Change |
|---|---|
| `backend/__tests__/safetyPathAudit.test.js` | New test: the pair block probe is symmetric under a swap of its two bind placeholders. |
| `backend/__tests__/moderationReach.test.js` | The dead branch of the byte for byte test now asserts the helper's output. Two report gate tests gained the same symmetry check. New helpers `blockClause`, `orTerms`, `swapSides`, `assertMutualBlock`. |
| `backend/__tests__/abuseBudgetAnonymity.test.js` | New test `ABUSE H4`: a settling three member flock still withholds the skip and share split. |

Two new tests, four strengthened assertions, no new files. Every one was proved to
fail against the defect it exists for and to stay green against a pure reformat of
the same code. Suite after the change: 4,678 passing.
