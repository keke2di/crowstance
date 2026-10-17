#!/usr/bin/env bash
# Run from your machine (Git Bash on Windows is fine):
#   deploy/deploy.sh root@<ip> --audit                 read-only look at the server; changes nothing
#   deploy/deploy.sh root@<ip> --setup [--shared]      first install (--shared: the server also runs other things)
#   deploy/deploy.sh <user>@<ip> [--restart-opencode]  ship an update
#   ... uncommitted changes are refused unless you add --allow-dirty
#
# Updates are uploaded as a checksummed archive and installed as an immutable
# release; the server flips an atomic symlink and rolls back if health fails.
# Every release carries VERSION (the commit it was built from) and source.bundle
# (that commit's git history), so the running version can always be found in git.
set -euo pipefail
usage() { echo "usage: deploy/deploy.sh user@host [--audit | --setup [--shared]] [--restart-opencode] [--allow-dirty]" >&2; exit 2; }
TARGET="${1:-}"
[ -n "$TARGET" ] || usage
shift
MODE=update
SHARED=""
RESTART_OC=""
ALLOW_DIRTY=""
for arg in "$@"; do
  case "$arg" in
    --audit) MODE=audit ;;
    --setup) MODE=setup ;;
    --shared) SHARED=1 ;;
    --restart-opencode) RESTART_OC="--restart-opencode" ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) usage ;;
  esac
done

cd "$(dirname "$0")/.."
SUDO="sudo"
if [[ "$TARGET" == root@* ]]; then SUDO=""; fi
APP=/opt/crowstance/app
STAGING=/opt/crowstance/staging

if [ "$MODE" = audit ]; then
  ssh "$TARGET" "$SUDO bash -s" < deploy/audit.sh
  exit
fi

# The live version should always be a commit you can find in git.
GIT=""
DIRTY=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then GIT=1; fi
if [ -n "$GIT" ] && [ -n "$(git status --porcelain)" ]; then DIRTY=1; fi
if [ -n "$DIRTY" ] && [ -z "$ALLOW_DIRTY" ]; then
  echo "deploy: there are uncommitted changes; commit them first (or pass --allow-dirty)" >&2
  exit 1
fi

# Build a release archive and its checksum manifest locally. The archive is named as it will be on
# the server, because the server only accepts a manifest that names the archive it installs.
ID="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo manual)${DIRTY:+-dirty}"
ARCHIVE="$ID.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
EXTRA=(VERSION)
if [ -n "$GIT" ]; then
  {
    echo "release: $ID"
    echo "commit: $(git rev-parse HEAD)"
    echo "subject: $(git log -1 --format=%s)"
    echo "committed: $(git log -1 --format=%cI)"
    echo "branch: $(git branch --show-current)"
    if [ -n "$DIRTY" ]; then echo "note: shipped with uncommitted changes on top of this commit"; fi
  } > "$TMP/VERSION"
  git bundle create --quiet "$TMP/source.bundle" HEAD
  EXTRA+=(source.bundle)
else
  printf 'release: %s\ncommit: unknown (not deployed from a git checkout)\n' "$ID" > "$TMP/VERSION"
fi
tar czf "$TMP/$ARCHIVE" \
  --exclude=./node_modules --exclude=./data --exclude=./.env --exclude=./.git --exclude=./deploy/secrets.env \
  . -C "$TMP" "${EXTRA[@]}"
( cd "$TMP" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256" && sha256sum -c --quiet "$ARCHIVE.sha256" )

echo "Uploading release $ID to $TARGET:$STAGING ..."
ssh "$TARGET" "$SUDO mkdir -p $STAGING"
ssh "$TARGET" "$SUDO tee $STAGING/$ARCHIVE >/dev/null" < "$TMP/$ARCHIVE"
ssh "$TARGET" "$SUDO tee $STAGING/$ARCHIVE.sha256 >/dev/null" < "$TMP/$ARCHIVE.sha256"

if [ "$MODE" = setup ]; then
  if [ -f deploy/secrets.env ]; then
    echo "Uploading deploy/secrets.env (setup shreds it after use) ..."
    ssh "$TARGET" "umask 077 && $SUDO tee /root/.crowstance-secrets.env >/dev/null" < deploy/secrets.env
  fi
  ssh "$TARGET" "cd $STAGING && $SUDO sha256sum -c --quiet $ARCHIVE.sha256 && $SUDO mkdir -p $ID && $SUDO tar xzf $ARCHIVE -C $ID"
  ssh -t "$TARGET" "$SUDO env ${SHARED:+SHARED=1} CROW_RELEASE_ID=$ID bash $STAGING/$ID/deploy/setup.sh && $SUDO rm -rf $STAGING/$ID"
else
  ssh "$TARGET" "$SUDO bash $APP/deploy/update.sh --id $ID --archive $STAGING/$ARCHIVE --manifest $STAGING/$ARCHIVE.sha256 $RESTART_OC"
fi
