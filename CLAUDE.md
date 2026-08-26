<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

## Two repositories

`bansaljayden/Flock-app-` is private and is the one that matters. Railway builds
from it, the trained model is tracked in it, and every push goes here first.

`bansaljayden/flock-social` is public. It is this repository with the model, the
old `.env` files, the Android debug keystore, and the App Store screenshots
erased from every commit that ever held them. It exists to be read, by anyone
evaluating the project, so its value is the commit
history: the full timeline from 2026-01-18 onward, dates and authorship
preserved exactly.

**The mirror is not the one this section used to describe, and publishing is no
longer routine.** Two things happened after that instruction was written, and
both change what you should do:

- **2026-08-20.** Jayden decided the code stays private until he says otherwise.
  `.github/workflows/publish-public.yml` was cut down to `workflow_dispatch`, so
  no push republishes anything. That is still how the workflow is configured.
- **2026-08-25.** The mirror was rebuilt from scratch. The old one was deleted
  and a fresh public repository was published in its place, so the history a
  reader sees today is not the history any earlier note describes. The reason,
  and the gate that now exists because of it, are written out in the header of
  `tools/publish/publish-public.sh`. Read that before publishing anything.

So: **do not run the publish script as a routine follow-up to a push.**
Republishing is now a deliberate act, taken when Jayden asks for it, and the
person taking it reads the script's header comment first.

```bash
bash tools/publish/publish-public.sh --dry-run   # build and report, push nothing
```

There are now three gates, in this order, and each exists because the one above
it is not enough. The strip list removes whole PATHS from all history.
`tools/publish/redactions.txt` removes LITERALS from inside files that have to
stay. `tools/publish/scan-secrets.py` refuses the push over anything
credential-shaped that nobody listed, across every blob in every commit. The
first two can only ever remove something already known; the third is the only
one that can catch a secret nobody had written down. It costs about twenty
seconds and it is not optional.

The public history is generated deterministically from this one, which is the
only reason an ordinary fast-forward push works. Editing the strip list or the
redactions file renumbers the entire public history and turns every future sync
into a force-push. **Never quote a commit count from memory.** This section
carried a fixed figure long after it stopped being true, and the rebuild moved
it again. Count them when you need the number.

Never push the model, a real `.env`, or anything under
`backend/scripts/ml/models/` to the public repository. The script enforces this
and refuses to push if it finds any of them, but the enforcement is a backstop,
not a licence to be careless.

## This application runs on exactly one server, and nothing enforces that

Railway is set to `numReplicas: 1` (verified 2026-08-26). **Do not raise it, and
do not add a second instance, without doing the work listed below first.** The
failure mode is silent, intermittent, and would be extremely hard to diagnose
from a bug report.

Socket.io runs on the default in-memory adapter. There is no
`@socket.io/redis-adapter` and no Redis anywhere in the project. The moment a
second instance exists:

- A user connected to instance 1 never receives an event emitted from instance
  2. Chat half works. Votes, budget updates and live location are delivered to
  some members and not others, differently on every request.
- `express-rate-limit` uses its MemoryStore, so every limit silently becomes N
  times the number it says.
- 43 non-test files under `backend/` hold `new Map()` state: spend ledgers,
  caches, cooldowns, AI budgets. Each instance gets its own copy, so the Gemini
  and Vision spend caps multiply by the instance count. Those are the controls
  that stop a runaway bill. That count was 38 when this was written and is 43 on
  2026-08-26, which is the point: it only ever goes up, so recount it rather
  than quoting this line.

A related fact that is true today at one instance: **every deploy wipes rate
limits, forecast meters, Birdie meters and in-memory spend budgets**, because
they live in process memory. Some ledgers are already in Postgres
(`geminiSpendLedger`, `photoSpendLedger`); the rest are not.

What a second instance would require, in order: a Redis adapter for Socket.io,
`rate-limit-redis` for the limiters, and moving the remaining spend ledgers into
Postgres alongside the two that are already there.
