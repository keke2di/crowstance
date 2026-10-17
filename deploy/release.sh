#!/usr/bin/env bash
# Shared release-layout helpers for crowstance atomic deployments.
#
# Source this file from update.sh / setup.sh / doctor.sh. It can also be run
# directly for small maintenance operations (verify, activate, recover, ...).
#
# Layout (all overridable for tests):
#   CROW_RELEASES/<id>/        immutable release tree (root-owned)
#   CROW_APP -> releases/<id>  atomic "current" pointer (symlink)
#   CROW_STAGING/              uploaded archives / extracted staging
#   CROW_STATE/known-good      release id last verified healthy
#   CROW_STATE/pending         in-flight update (new=/previous=), if any
#
# The active tree is only ever changed by replacing the symlink atomically
# (create a temp symlink, then rename it over the old one). The live release
# directory itself is never mutated.
set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }

crow_app() { printf '%s' "${CROW_APP:-/opt/crowstance/app}"; }
crow_releases() { printf '%s' "${CROW_RELEASES:-$(dirname "$(crow_app)")/releases}"; }
crow_state() { printf '%s' "${CROW_STATE:-$(dirname "$(crow_app)")/state}"; }
crow_staging() { printf '%s' "${CROW_STAGING:-$(dirname "$(crow_app)")/staging}"; }

release_path() { printf '%s/%s' "$(crow_releases)" "$1"; }

release_current_id() {
  local app; app="$(crow_app)"
  if [ -L "$app" ]; then basename "$(readlink -f "$app")"; fi
}

# Newest release directory other than $1. Release ids are timestamp-prefixed,
# so a reverse lexical sort is a reverse chronological sort. The last
# health-verified release wins so a failed build never becomes "previous".
release_previous_id() {
  local exclude="${1:-}" id dir good
  dir="$(crow_releases)"
  good="$(release_known_good)"
  if [ -n "$good" ] && [ "$good" != "$exclude" ] && [ -d "$dir/$good" ]; then
    printf '%s' "$good"
    return 0
  fi
  [ -d "$dir" ] || return 0
  for id in $(ls -1 "$dir" 2>/dev/null | sort -r); do
    [ "$id" = "$exclude" ] && continue
    [ -d "$dir/$id" ] && { printf '%s' "$id"; return 0; }
  done
}

release_known_good() {
  local f; f="$(crow_state)/known-good"
  if [ -f "$f" ]; then head -n1 "$f"; fi
}

release_has_pending() { [ -f "$(crow_state)/pending" ]; }

# Verify an uploaded archive against its sha256 manifest before extracting it.
release_verify() {
  local archive="$1" manifest="$2" expected
  [ -f "$archive" ] || die "missing uploaded archive: $archive"
  [ -f "$manifest" ] || die "missing checksum manifest: $manifest"
  expected="$(basename "$archive")"
  # The manifest must describe exactly the archive we are about to install.
  if ! awk '{ name=$2; sub(/^\*/, "", name); if (name == "'"$expected"'") found=1 } END { exit !found }' "$manifest"; then
    die "checksum manifest does not describe $expected"
  fi
  if ! (cd "$(dirname "$archive")" && sha256sum -c --quiet "$manifest"); then
    die "checksum verification failed for $expected; refusing to install"
  fi
}

# Build an immutable release from a staged tree. Never touches the live pointer.
release_build() {
  local src="$1" id="$2" dest
  [ -d "$src" ] || die "missing staged upload: $src"
  [ -f "$src/package.json" ] || die "staged upload has no package.json"
  dest="$(release_path "$id")"
  if [ -e "$dest" ]; then die "release already exists: $dest"; fi
  mkdir -p "$dest"
  # Operator overlays and runtime data are never shipped inside a release.
  rsync -a --delete \
    --exclude node_modules \
    --exclude .env \
    --exclude deploy/secrets.env \
    --exclude data \
    "$src/" "$dest/"
  chown -R root:root "$dest"
  find "$dest" -type d -exec chmod 755 {} +
  find "$dest" -type f -exec chmod 644 {} +
  if [ -d "$dest/deploy" ]; then find "$dest/deploy" -maxdepth 1 -name '*.sh' -exec chmod +x {} +; fi
  if [ -d "$dest/home/scripts" ]; then find "$dest/home/scripts" -maxdepth 1 -name '*.sh' -exec chmod +x {} +; fi
}

# Copy operator overlays (.env, deploy/secrets.env) from the currently active
# release into the new one when the upload did not provide them. Overlays are
# never overwritten by an upload.
release_preserve_overlays() {
  local id="$1" from="${2:-}" dest prevdir f
  dest="$(release_path "$id")"
  [ -n "$from" ] || from="$(release_current_id)"
  [ -n "$from" ] || return 0
  prevdir="$(release_path "$from")"
  [ -d "$prevdir" ] || return 0
  for f in .env deploy/secrets.env; do
    if [ -e "$prevdir/$f" ] && [ ! -e "$dest/$f" ]; then
      mkdir -p "$dest/$(dirname "$f")"
      cp -a "$prevdir/$f" "$dest/$f"
    fi
  done
}

release_install_deps() {
  local id="$1" dest
  dest="$(release_path "$id")"
  if [ ! -d "$dest/node_modules" ]; then
    # This runs as root, so no dependency install script gets to run (better-sqlite3 ships prebuilt binaries).
    npm ci --prefix "$dest" --omit=dev --no-audit --no-fund --ignore-scripts
  fi
}

# Re-render the systemd units from whichever release is active now (e.g. after a rollback), so the
# installed units never point at helpers that the active release doesn't ship.
release_render_units() {
  local app
  app="$(crow_app)"
  if [ -x "$app/deploy/install-units.sh" ]; then
    env CROW_APP="$app" "$app/deploy/install-units.sh" || echo "release: WARNING could not re-render units from $app" >&2
  fi
}

# Delete old releases: keep the active one, the known-good one and the newest $1 (default 3).
release_prune() {
  local keep="${1:-${CROW_KEEP_RELEASES:-3}}" dir cur good id n=0
  dir="$(crow_releases)"
  [ -d "$dir" ] || return 0
  cur="$(release_current_id)"
  good="$(release_known_good)"
  for id in $(ls -1t "$dir" 2>/dev/null); do
    [ -d "$dir/$id" ] || continue
    n=$((n + 1))
    if [ "$id" = "$cur" ] || [ "$id" = "$good" ] || [ "$n" -le "$keep" ]; then continue; fi
    rm -rf "${dir:?}/$id"
  done
}

# Atomic pointer switch. Uses a temp symlink plus `mv -T` (rename) so readers
# always see either the old or the new release, never a missing/partial link.
release_activate() {
  local id="$1" target app tmp
  target="$(release_path "$id")"
  app="$(crow_app)"
  [ -d "$target" ] || die "release does not exist: $target"
  mkdir -p "$(dirname "$app")"
  tmp="$app.tmp.$$"
  rm -f "$tmp"
  ln -s "$target" "$tmp"
  if [ -d "$app" ] && [ ! -L "$app" ]; then
    rm -f "$tmp"
    die "$app is a real directory (legacy in-place tree); migrate it before switching"
  fi
  mv -Tf "$tmp" "$app"
}

release_mark_good() {
  local id="$1" f
  mkdir -p "$(crow_state)"
  f="$(crow_state)/known-good"
  printf '%s\n' "$id" > "$f.tmp.$$"
  mv -Tf "$f.tmp.$$" "$f"
}

release_pending_write() { # new-id previous-id
  local f
  mkdir -p "$(crow_state)"
  f="$(crow_state)/pending"
  printf 'new=%s\nprevious=%s\n' "$1" "${2:-}" > "$f.tmp.$$"
  mv -Tf "$f.tmp.$$" "$f"
}

release_pending_clear() { rm -f "$(crow_state)/pending"; }

release_pending_field() { # new|previous
  local f; f="$(crow_state)/pending"
  [ -f "$f" ] || return 0
  sed -n "s/^$1=//p" "$f" | head -n1
}

# If a previous update was interrupted, make the host consistent again:
# adopt a healthy pending release, otherwise roll back to the known-good one.
# `health_cmd` is a shell snippet (defaults to the health-check helper).
release_recover() {
  release_has_pending || return 0
  local new prev cur
  new="$(release_pending_field new)"
  prev="$(release_pending_field previous)"
  cur="$(release_current_id)"
  echo "release: recovering interrupted update (pending=$new current=$cur previous=$prev)" >&2
  if [ "$cur" = "$new" ] && [ -n "$new" ]; then
    if ( release_health_check ); then
      release_mark_good "$new"
      echo "release: pending release $new is healthy; adopting it" >&2
    elif [ -n "$prev" ] && [ -d "$(release_path "$prev")" ]; then
      release_activate "$prev"
      release_render_units
      systemctl restart crowstance-gateway >/dev/null 2>&1 || true
      echo "release: pending release $new was unhealthy; rolled back to $prev" >&2
    fi
  fi
  release_pending_clear
}

release_health_check() {
  if [ -n "${CROW_HEALTH_CMD:-}" ]; then
    bash -c "$CROW_HEALTH_CMD"
    return $?
  fi
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/health-check.sh"
}

# Block until the services are genuinely ready, up to CROW_HEALTH_TIMEOUT.
release_wait_healthy() {
  local timeout="${CROW_HEALTH_TIMEOUT:-60}" interval="${CROW_HEALTH_INTERVAL:-2}" out
  local deadline=$(( $(date +%s) + timeout ))
  while :; do
    # Misses are expected while the services restart; only the final result is worth showing.
    if out="$(release_health_check 2>&1)"; then printf '%s\n' "$out"; return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then printf '%s\n' "$out" >&2; return 1; fi
    sleep "$interval"
  done
}

# --- direct CLI ---------------------------------------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  cmd="${1:-}"
  shift || true
  case "$cmd" in
    current-id) release_current_id ;;
    previous-id) release_previous_id "${1:-}" ;;
    known-good) release_known_good ;;
    activate) release_activate "${1:?usage: release.sh activate <id>}" ;;
    mark-good) release_mark_good "${1:?usage: release.sh mark-good <id>}" ;;
    verify) release_verify "${1:?usage: release.sh verify <archive> <manifest>}" "${2:?}" ;;
    recover) release_recover ;;
    has-pending) release_has_pending && echo yes || echo no ;;
    *) echo "usage: release.sh {current-id|previous-id [exclude]|known-good|activate <id>|mark-good <id>|verify <archive> <manifest>|recover|has-pending}" >&2; exit 2 ;;
  esac
fi
