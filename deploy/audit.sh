#!/usr/bin/env bash
# Read-only look at a server before installing crowstance on it. Changes nothing.
# Usage: deploy/deploy.sh root@<ip> --audit   (or on the server: sudo bash audit.sh)
set -uo pipefail
h() { printf '\n== %s\n' "$*"; }

h "System"
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null
echo "${PRETTY_NAME:-unknown OS} · kernel $(uname -r) · $(uname -m) · systemd $(systemctl --version | awk 'NR==1 {print $2}')"
echo "cgroup filesystem: $(stat -fc %T /sys/fs/cgroup)  (cgroup2fs = resource caps supported)"
echo "CPUs: $(nproc) · load: $(cut -d' ' -f1-3 /proc/loadavg) · uptime: $(uptime -p)"
free -h | sed -n '1,3p'
df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null

h "Running services"
systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}'

h "Listening TCP ports"
ss -Htlnp | awk '{ proc = $6; sub(/^users:\(\("/, "", proc); sub(/".*/, "", proc); print $4, proc }' | sort -u

h "Docker"
if command -v docker >/dev/null; then docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null || echo "(installed, daemon not reachable)"; else echo "not installed"; fi

h "Runtimes and web servers"
for c in node npm pm2 bun deno python3 php java nginx apache2 caddy; do
  if command -v "$c" >/dev/null; then printf '%-8s %s\n' "$c" "$("$c" --version 2>&1 | head -1)"; fi
done

h "Firewall"
if command -v ufw >/dev/null; then ufw status verbose 2>/dev/null | head -25; else echo "ufw not installed"; fi
echo "iptables rules: $(iptables -S 2>/dev/null | wc -l) · nftables tables: $(nft list tables 2>/dev/null | wc -l)"

h "SSH"
sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication) ' || echo "(sshd -T unavailable)"

h "Users with a login shell"
awk -F: '$7 ~ /(bash|sh|zsh|fish)$/ { print $1, $6 }' /etc/passwd

h "App/data directories (candidates for CROW_HIDE_PATHS)"
ls -d /var/www/* /srv/* /opt/* /home/* /var/lib/docker/volumes 2>/dev/null | grep -v crowstance || true

h "Scheduled jobs"
ls /etc/cron.d 2>/dev/null
for u in $(cut -d: -f1 /etc/passwd); do
  if crontab -l -u "$u" 2>/dev/null | grep -v '^#' | grep -q .; then echo "crontab: $u"; fi
done
systemctl list-timers --no-legend --plain 2>/dev/null | awk '{print $(NF-1)}' | grep -v '^$' | head -20

h "Automatic updates and restarts"
echo "unattended-upgrades: $(systemctl is-enabled unattended-upgrades 2>/dev/null || echo 'not installed')"
grep -h '^\$nrconf{restart}' /etc/needrestart/needrestart.conf /etc/needrestart/conf.d/* 2>/dev/null || echo "needrestart: default settings"

h "crowstance"
if id crow-agent >/dev/null 2>&1; then echo "already installed (crow-agent exists)"; else echo "not installed yet"; fi
for p in 4096 7801; do
  if ss -Htln "sport = :$p" | grep -q .; then echo "port $p: in use (setup will pick another)"; else echo "port $p: free"; fi
done
