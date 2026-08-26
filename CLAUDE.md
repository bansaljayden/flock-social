<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

## Two repositories

`bansaljayden/Flock-app-` is private and is the one that matters. Railway builds
from it, the trained model is tracked in it, and every push goes here first.

`bansaljayden/flock-social` is public. It is this repository with the model, the
old `.env` files, the Android debug keystore, and the App Store screenshots
erased from every commit that ever held them. It exists to be read -- by anyone
evaluating the project, including college admissions -- so its value is the
commit history: 864 commits from 2026-01-18 onward, dates and authorship
preserved exactly.

**Keep the public one current.** After pushing work to `origin/main`, refresh the
mirror:

```bash
bash tools/publish/publish-public.sh            # or --dry-run to inspect first
```

Read the header comment in that script before changing anything in it. The short
version: the public history is generated deterministically from this one, which
is the only reason an ordinary fast-forward push works. Editing the strip list
renumbers all 864 public commits and turns every future sync into a force-push.

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
- Roughly 38 files hold `new Map()` state: spend ledgers, caches, cooldowns, AI
  budgets. Each instance gets its own copy, so the Gemini and Vision spend caps
  multiply by the instance count. Those are the controls that stop a runaway
  bill.

A related fact that is true today at one instance: **every deploy wipes rate
limits, forecast meters, Birdie meters and in-memory spend budgets**, because
they live in process memory. Some ledgers are already in Postgres
(`geminiSpendLedger`, `photoSpendLedger`); the rest are not.

What a second instance would require, in order: a Redis adapter for Socket.io,
`rate-limit-redis` for the limiters, and moving the remaining spend ledgers into
Postgres alongside the two that are already there.
