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
