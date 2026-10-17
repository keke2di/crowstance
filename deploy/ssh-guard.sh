#!/usr/bin/env bash
# Refuse SSH hardening that could lock an operator out of the machine.
#
# Called by setup.sh right before it disables root/password logins. It checks
# that a usable, sudo-capable admin account with a real authorized key exists
# and that public-key authentication is enabled in the effective sshd config.
# It only reads files, so it is safe to run and easy to test without root.
#
#   ssh-guard.sh --admin-user admin --authorized-keys /home/admin/.ssh/authorized_keys \
#                [--passwd FILE] [--group FILE] [--sudoers-file FILE] [--sshd-config FILE]
set -euo pipefail

ADMIN_USER=""
AUTHORIZED_KEYS=""
PASSWD_FILE="${CROW_PASSWD_FILE:-/etc/passwd}"
GROUP_FILE="${CROW_GROUP_FILE:-/etc/group}"
SUDOERS_FILE="${CROW_SUDOERS_FILE:-/etc/sudoers}"
SSHD_T_FILE="${CROW_SSHD_T_FILE:-}"
SUDO_GROUPS="${CROW_SUDO_GROUPS:-sudo wheel}"

usage() { echo "usage: ssh-guard.sh --admin-user U --authorized-keys PATH [--passwd F] [--group F] [--sudoers-file F] [--sshd-config F]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --admin-user) ADMIN_USER="${2:?}"; shift 2 ;;
    --authorized-keys) AUTHORIZED_KEYS="${2:?}"; shift 2 ;;
    --passwd) PASSWD_FILE="${2:?}"; shift 2 ;;
    --group) GROUP_FILE="${2:?}"; shift 2 ;;
    --sudoers-file) SUDOERS_FILE="${2:?}"; shift 2 ;;
    --sshd-config) SSHD_T_FILE="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done
[ -n "$ADMIN_USER" ] || usage
[ -n "$AUTHORIZED_KEYS" ] || usage

# If no explicit effective config was supplied, derive it from the live sshd.
SSHD_T_TMP=""
if [ -z "$SSHD_T_FILE" ] && command -v sshd >/dev/null 2>&1; then
  SSHD_T_TMP="$(mktemp)"
  if ! sshd -T > "$SSHD_T_TMP" 2>/dev/null; then SSHD_T_TMP=""; fi
  SSHD_T_FILE="$SSHD_T_TMP"
fi
cleanup() { [ -n "$SSHD_T_TMP" ] && rm -f "$SSHD_T_TMP"; return 0; }
trap cleanup EXIT

refuse() { echo "ssh-guard: refusing to disable root/password SSH logins: $*" >&2; exit 1; }

[ "$ADMIN_USER" != "root" ] || refuse "the admin user must not be root"
[ -f "$PASSWD_FILE" ] || refuse "cannot read $PASSWD_FILE"

entry="$(awk -F: -v u="$ADMIN_USER" '$1==u{print; exit}' "$PASSWD_FILE")"
[ -n "$entry" ] || refuse "admin user '$ADMIN_USER' does not exist"
shell="$(printf '%s' "$entry" | cut -d: -f7)"
case "$shell" in ""|*/nologin|*/false) refuse "admin user '$ADMIN_USER' has no login shell ($shell)" ;; esac

# A real, non-comment public key must be present for the admin account.
[ -f "$AUTHORIZED_KEYS" ] || refuse "no authorized_keys for '$ADMIN_USER' at $AUTHORIZED_KEYS"
if ! grep -vE '^[[:space:]]*(#|$)' "$AUTHORIZED_KEYS" | grep -q .; then
  refuse "'$ADMIN_USER' has no usable SSH public key"
fi

# The admin account must be able to escalate, or we are removing the only way in.
gid="$(printf '%s' "$entry" | cut -d: -f4)"
groups="$(awk -F: -v u="$ADMIN_USER" -v g="$gid" '
  $3==g { print $1 }
  { n=split($4, m, ","); for (i=1;i<=n;i++) if (m[i]==u) print $1 }
' "$GROUP_FILE" 2>/dev/null | sort -u)"
sudo_capable=0
for g in $groups; do
  for s in $SUDO_GROUPS; do
    [ "$g" = "$s" ] && sudo_capable=1
  done
done
if [ "$sudo_capable" != 1 ] && [ -f "$SUDOERS_FILE" ]; then
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if grep -Eq "^[[:space:]]*%?${name}([[:space:]]|,|$)" "$SUDOERS_FILE"; then sudo_capable=1; fi
  done <<EOF
$ADMIN_USER
$groups
EOF
fi
[ "$sudo_capable" = 1 ] || refuse "'$ADMIN_USER' is not in a sudo group and has no sudoers entry"

# Effective sshd config must still allow public-key auth.
if [ -n "$SSHD_T_FILE" ]; then
  [ -f "$SSHD_T_FILE" ] || refuse "cannot read sshd config: $SSHD_T_FILE"
  pubkey="$(awk 'tolower($1)=="pubkeyauthentication"{print tolower($2)}' "$SSHD_T_FILE" | tail -n1)"
  [ "$pubkey" != "no" ] || refuse "PubkeyAuthentication is disabled in the effective sshd config"
fi

echo "ssh-guard: '$ADMIN_USER' has a usable key and sudo access; hardening is safe"
