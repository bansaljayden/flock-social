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

PUBLIC_REMOTE="git@github.com:bansaljayden/flock-social.git"
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
