#!/usr/bin/env bash
# Refresh the public mirror at github.com/bansaljayden/flock-social from this repo.
#
# WHY THIS EXISTS, AND WHY IT IS NOT A `git push` TO A SECOND REMOTE.
#
# The public repository is this repository with a set of paths erased from every
# commit that ever contained them -- the trained model, the old .env files, the
# Android debug keystore, and 56 MB of App Store screenshots. Erasing a path from
# history rewrites every commit after it, so the public history is a different
# chain of hashes from this one. There is no shared ancestor to push against.
#
# git-filter-repo is deterministic: the same input commits filtered with the same
# path list always produce the same output hashes. So re-running this after new
# work lands regenerates the identical hashes for every old commit and appends
# the new ones, and the push is an ordinary fast-forward. That property is the
# whole design, and it is why the path list below must not be edited casually --
# changing it renumbers the entire public history and turns every future push
# into a force-push.
#
# Nothing here touches the working repository. The filter runs on a throwaway
# copy under a temp directory, which is deleted on exit.
#
# Usage:  bash tools/publish/publish-public.sh          # push
#         bash tools/publish/publish-public.sh --dry-run  # build and report only

set -euo pipefail

# HTTPS, not SSH. This machine has no key pair at all: ssh -T git@github.com
# answers "Permission denied (publickey)" and ~/.ssh holds no public key, so the
# SSH form failed every time it was run and printed its error into a terminal
# nobody was reading. The private remote is HTTPS for the same reason, and gh
# has already configured git's credential helper to authenticate that way.
PUBLIC_REMOTE="https://github.com/bansaljayden/flock-social.git"
REDACTIONS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redactions.txt"
PUBLIC_REMOTE_HTTPS="https://github.com/bansaljayden/flock-social.git"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Paths erased from all history. Adding to this list is a history rewrite; see above.
STRIP=(
  --path backend/scripts/ml/models/crowd_model.onnx
  --path backend/scripts/ml/models/model_metadata.json
  --path backend/.env
  --path frontend/.env.production
  --path mobile/android/app/debug.keystore
  --path frontend/public/birdie/flap-src.png
  --path frontend/public/birdie/birdie-idle.mp4
  --path-glob 'frontend/public/screenshots/appstore/*'
  # Private strategy docs (2026-08-19; Jayden chose to keep existing history as-is).
  # These were never committed anywhere; filtering them is a no-op on existing
  # hashes and exists purely so an accidental future commit cannot mirror.
  #
  # THIS LIST MUST TRACK THE PRIVATE BLOCK OF .gitignore. It is the second half
  # of a two-lock design: .gitignore stops the commit, this stops the mirror if
  # the commit happens anyway (a `git add -f`, a rewritten .gitignore, a merge).
  # A doc in .gitignore and absent here has one lock, not two -- and on
  # 2026-08-20 nine of them were in exactly that state, including all five
  # SECURITY-AUDIT-*.md, which .gitignore's own comment describes as
  # "step-by-step exploitation notes against production". Every path added here
  # has zero commits touching it, so filter-repo rewrites nothing and no public
  # hash moves; that is what makes closing the gap free.
  # redactions.txt names the very secrets it exists to remove, so it is the one
  # file in this repository that must never reach the mirror. It stays tracked
  # privately, because a fresh clone with no redactions file would silently skip
  # the redaction step and the guard would have nothing to check.
  --path tools/publish/redactions.txt
  --path PUBLIC-REPO-AUDIT.md
  --path VENUE-ADVISOR.md
  --path PAYMENTS-ROUTING.md
  --path MODEL-EPOCH-FINDING.md
  --path APPLE-2.1-REPLY.md
  --path OSS-SECRET-SCAN.md
  --path OSS-READINESS.md
  --path VENUE-TOS-DRAFT.md
  --path MAP-VISIBILITY-DECISION.md
  --path PRO-VS-PREMIUM.md
  --path ROOST-OWNER-INPUT.md
  --path PITCH.md
  --path PITCH-CRAFT.md
  --path VENUE-PRICING.md
  --path CONSUMER-VALUE-CASE.md
  --path PRESHIP-SWEEP.md
  --path-glob 'ADVISOR-*.md'
  --path-glob 'SECURITY-AUDIT-*.md'
  --path-glob 'VIDEO-NOTES-*.md'
  --path-glob 'REVIEW-ROUND*.md'
  --path-glob 'flock-walkthrough-*.mp4'
)

FILTER_REPO="$(python -c 'import git_filter_repo,os;print(git_filter_repo.__file__)' 2>/dev/null || true)"
if [ -z "$FILTER_REPO" ]; then
  echo "git-filter-repo is not installed.  pip install git-filter-repo" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> copying $SRC (the copy is what gets cut, never the original)"
git clone --no-local --no-hardlinks --quiet "$SRC" "$WORK/mirror"
cd "$WORK/mirror"

BEFORE_COMMITS="$(git rev-list --count HEAD)"

echo "==> erasing published-excluded paths from all history"
# --prune-empty=never keeps commits that contained ONLY stripped files. They
# become empty commits rather than disappearing, so the commit count and the
# contribution timeline match the private repo exactly. That is deliberate:
# this repo doubles as a record of how long the project has been worked on.
python "$FILTER_REPO" --force --invert-paths --prune-empty=never "${STRIP[@]}" >/dev/null

# ---------------------------------------------------------------------------
# REDACT SECRETS THAT LIVE INSIDE FILES THE REPO LEGITIMATELY KEEPS.
# ---------------------------------------------------------------------------
# The strip list above removes whole PATHS. It cannot help when the secret is a
# string inside a file that belongs in the repository, and on 2026-08-25 that
# is exactly what happened: a real password sat in three
# public commits inside backend/seeds/demo-data.js as the password for a real
# account. gitleaks was green throughout and structurally could not catch it,
# because a dictionary word inside bcrypt.hash() has no key-shaped signature.
#
# Every literal listed in redactions.txt is replaced across ALL history. Adding
# a line here renumbers every public hash, which is why this file and the strip
# list are both append-with-care, but a leaked credential is worth a force
# push and a rewritten public history.
if [ -s "$REDACTIONS" ]; then
  echo "==> redacting in-file secrets from all history"
  python "$FILTER_REPO" --force --replace-text "$REDACTIONS" >/dev/null

  # Prove it. Every literal on the left of ==> must appear in ZERO blobs across
  # every commit, not merely in the current tree. A surviving literal is a
  # refusal, because the whole point of this step is that the push is the last
  # moment anything can be caught.
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    literal="${line%%==>*}"
    [ -z "$literal" ] && continue
    # Pickaxe, not git grep over every rev: passing 995 commit ids as argv
    # overflows the command line and the script exits 126 before it can refuse.
    # -S counts occurrences per commit, so a literal that never exists anywhere
    # produces no commits at all.
    hits="$(git log --all --oneline -S"$literal" -- . 2>/dev/null | wc -l)"
    if [ "$hits" != "0" ]; then
      echo "REFUSING TO PUSH: redaction literal still present in $hits blob(s)" >&2
      exit 1
    fi
  done < "$REDACTIONS"
  echo "    redaction verified: every literal absent from all history"
fi

AFTER_COMMITS="$(git rev-list --count HEAD)"
SIZE="$(git count-objects -vH | awk '/size-pack/{print $2, $3}')"

echo "==> verifying nothing excluded survived"
FAIL=0
for p in backend/scripts/ml/models/crowd_model.onnx backend/scripts/ml/models/model_metadata.json \
         backend/.env frontend/.env.production mobile/android/app/debug.keystore; do
  n="$(git log --all --oneline -- "$p" | wc -l | tr -d ' ')"
  if [ "$n" != "0" ]; then echo "    LEAK: $p still in $n commits" >&2; FAIL=1; fi
done
n="$(git log --all --oneline -- 'frontend/public/screenshots/appstore' | wc -l | tr -d ' ')"
[ "$n" = "0" ] || { echo "    LEAK: appstore screenshots still in $n commits" >&2; FAIL=1; }
[ "$FAIL" = "0" ] || { echo "REFUSING TO PUSH" >&2; exit 1; }

echo "    commits: $BEFORE_COMMITS -> $AFTER_COMMITS      size: $SIZE"

if [ "$DRY_RUN" = "1" ]; then
  echo "==> dry run, not pushing"
  exit 0
fi

echo "==> pushing to $PUBLIC_REMOTE_HTTPS"
git remote add public "$PUBLIC_REMOTE_HTTPS"
# Plain push, not --force. If this is rejected as non-fast-forward, the strip
# list changed and the whole public history was renumbered. Do not reach for
# --force without understanding why: it breaks every existing clone and every
# permalink anyone has to the public repo.
git push public HEAD:main
echo "==> done"
