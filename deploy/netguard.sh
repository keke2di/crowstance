#!/usr/bin/env bash
# Keep the agent (crow-agent) away from selected other services on this machine. The enforced policy
# currently covers discovered TCP listeners on IPv4/IPv6 loopback and Docker bridge egress. It does not
# cover UDP listeners, UNIX sockets, arbitrary interfaces, or ports opened after a refresh. DNS, the
# gateway's HQ port and internet egress stay reachable. Other users' traffic is never touched.
# Usage (root): netguard.sh apply | remove | status
set -euo pipefail
AGENT=crow-agent
CHAIN=CROWSTANCE
ACTION="${1:-apply}"

uid="$(id -u "$AGENT")"
HQ_PORT="$(grep -E '^HQ_PORT=' /etc/crowstance/opencode.env 2>/dev/null | cut -d= -f2- || true)"
HQ_PORT="${HQ_PORT:-7801}"
# Public web ports stay reachable through the server's public address (anyone on the internet can reach
# them anyway; this lets monitors check sites hosted here), but not through localhost, which apps may trust.
PUBLIC_PORTS="$(grep -E '^CROW_FENCE_PUBLIC_PORTS=' /etc/crowstance/setup.env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
PUBLIC_PORTS="${PUBLIC_PORTS:-80 443}"

# Listening TCP ports whose socket isn't owned by the agent (`ss -e` omits uid for root-owned sockets).
other_ports() {
  ss -Htlne | awk -v uid="$uid" '{
    port = $4; sub(/.*:/, "", port)
    owner = "0"; if (match($0, /uid:[0-9]+/)) owner = substr($0, RSTART + 4, RLENGTH - 4)
    if (owner != uid) print port
  }' | sort -un
}

tables() { for t in iptables ip6tables; do command -v "$t" >/dev/null && echo "$t"; done; }

apply() {
  local ports t p
  ports="$(other_ports)"
  for t in $(tables); do
    # Build the new rule set in a side chain, then swap it in, so there's no unprotected gap.
    $t -w -N "${CHAIN}_NEW" 2>/dev/null || $t -w -F "${CHAIN}_NEW"
    $t -w -A "${CHAIN}_NEW" -p udp --dport 53 -j RETURN
    $t -w -A "${CHAIN}_NEW" -p tcp --dport 53 -j RETURN
    $t -w -A "${CHAIN}_NEW" -o lo -p tcp --dport "$HQ_PORT" -j RETURN
    local loopback=127.0.0.0/8
    [ "$t" = ip6tables ] && loopback=::1/128
    for p in $ports; do
      if [ "$p" = "$HQ_PORT" ] || [ "$p" = 53 ]; then continue; fi
      if [[ " $PUBLIC_PORTS " == *" $p "* ]]; then
        $t -w -A "${CHAIN}_NEW" -o lo -d "$loopback" -p tcp --dport "$p" -j REJECT --reject-with tcp-reset
      else
        $t -w -A "${CHAIN}_NEW" -o lo -p tcp --dport "$p" -j REJECT --reject-with tcp-reset
      fi
    done
    $t -w -A "${CHAIN}_NEW" -o docker0 -j REJECT
    $t -w -A "${CHAIN}_NEW" -o br-+ -j REJECT
    $t -w -I OUTPUT 1 -m owner --uid-owner "$uid" -j "${CHAIN}_NEW"
    while $t -w -D OUTPUT -m owner --uid-owner "$uid" -j "$CHAIN" 2>/dev/null; do :; done
    if $t -w -n -L "$CHAIN" >/dev/null 2>&1; then $t -w -F "$CHAIN" && $t -w -X "$CHAIN"; fi
    $t -w -E "${CHAIN}_NEW" "$CHAIN"
  done
}

remove() {
  local t c
  for t in $(tables); do
    for c in "$CHAIN" "${CHAIN}_NEW"; do
      while $t -w -D OUTPUT -m owner --uid-owner "$uid" -j "$c" 2>/dev/null; do :; done
      if $t -w -n -L "$c" >/dev/null 2>&1; then $t -w -F "$c" && $t -w -X "$c"; fi
    done
  done
}

case "$ACTION" in
  apply) apply ;;
  remove) remove ;;
  status) for t in $(tables); do echo "== $t"; $t -w -S "$CHAIN" 2>/dev/null || echo "(not active)"; done ;;
  *) echo "usage: $0 apply|remove|status" >&2; exit 2 ;;
esac
