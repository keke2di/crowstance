#!/usr/bin/env bash
# crowstance server setup (Ubuntu 22.04 / 24.04+). Run as root ON THE SERVER from the uploaded code;
# deploy/deploy.sh --setup [--shared] does that for you. Safe to re-run.
#
# Settings come from env vars, from the uploaded secrets file ($SECRETS_FILE, shredded after use), or from
# /etc/crowstance/setup.env (saved by the previous run). Secrets still missing are prompted for:
#   SHARED=1          the server also runs other things (see below)
#   TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_ID, CROWBOT_API_KEY, ANTHROPIC_API_KEY (optional), TZ
#   CROW_HIDE_PATHS   extra paths the agent must never see, e.g. "/var/www /srv/myapp"
#   CROW_CPU_QUOTA, CROW_MEMORY_MAX   override the resource caps, e.g. 200% / 6G
#   ADMIN_USER        dedicated mode: sudo user that replaces root SSH logins (default: admin)
#   OPENCODE_VERSION (default 1.18.34), NODE_MAJOR (default 24)
#
# Shared mode changes nothing server-wide: no package upgrades or service restarts, no firewall, SSH,
# timezone or swap changes, and it brings its own Node.js. The assistant is capped at half the CPU cores
# and ~40% of RAM at low priority, can't see other users' files, and can't connect to other local services.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

ETC=/etc/crowstance
APP=/opt/crowstance/app
NODE_DIR=/opt/crowstance/node
BIN_DIR=/opt/crowstance/bin
AGENT=crow-agent
AGENT_HOME=/home/crow-agent
GW=crow-gateway
BACKUP=crow-backup
SETUP_ENV=$ETC/setup.env
SECRETS_FILE=/root/.crowstance-secrets.env
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- settings: given now > secrets file > previous run > defaults ---------------------------------
declare -A given=()
for k in SHARED TZ CROW_HIDE_PATHS CROW_CPU_QUOTA CROW_MEMORY_MAX CROW_FENCE_PUBLIC_PORTS ADMIN_USER OPENCODE_VERSION NODE_MAJOR; do
  if [ -n "${!k:-}" ]; then given[$k]="${!k}"; fi
done
# shellcheck disable=SC1090
if [ -f "$SETUP_ENV" ]; then . "$SETUP_ENV"; fi
# shellcheck disable=SC1090
if [ -f "$SECRETS_FILE" ]; then set -a; . "$SECRETS_FILE"; set +a; fi
for k in "${!given[@]}"; do printf -v "$k" '%s' "${given[$k]}"; done
SHARED="${SHARED:-0}"
ADMIN_USER="${ADMIN_USER:-admin}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.34}"
NODE_MAJOR="${NODE_MAJOR:-24}"

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
rand() { openssl rand -hex 24; }
to_mb() { case "$1" in *[Gg]) echo $(( ${1%[Gg]} * 1024 )) ;; *[Mm]) echo "${1%[Mm]}" ;; *) echo "$1" ;; esac; }
port_free() { ! ss -Htln "sport = :$1" | grep -q .; }
pick_port() { local p="$1"; while ! port_free "$p"; do p=$((p + 1)); done; echo "$p"; }

if [ "$SHARED" = 1 ]; then echo "Shared mode: nothing server-wide will be changed."; fi

step "Packages (only what's missing)"
apt-get update -q
NEED="git curl ca-certificates jq ripgrep unzip xz-utils build-essential python3 python3-venv python3-pip sqlite3 rsync openssl iptables iproute2 sudo"
missing=""
for p in $NEED; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
# shellcheck disable=SC2086
if [ -n "$missing" ]; then apt-get install -yq --no-upgrade $missing; fi
if [ "$SHARED" != 1 ]; then
  step "Dedicated server: updates, firewall tools, timezone, swap"
  apt-get upgrade -yq
  apt-get install -yq ufw fail2ban unattended-upgrades
  dpkg-reconfigure -f noninteractive unattended-upgrades
  if [ -n "${TZ:-}" ]; then timedatectl set-timezone "$TZ"; fi
  if ! swapon --show | grep -q .; then
    fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

step "Private Node.js $NODE_MAJOR, OpenCode $OPENCODE_VERSION and gh in /opt/crowstance"
case "$(uname -m)" in
  x86_64) ARCH=x64; GH_ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64; GH_ARCH=arm64 ;;
  *) echo "unsupported CPU: $(uname -m)"; exit 1 ;;
esac
NODE_BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
SUMS="$(curl -fsSL "$NODE_BASE/SHASUMS256.txt")"
NODE_TAR="$(awk -v s="-linux-$ARCH.tar.xz" '{ if (substr($2, length($2) - length(s) + 1) == s) print $2 }' <<<"$SUMS" | head -1)"
if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null || true)" != "$(cut -d- -f2 <<<"$NODE_TAR")" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "$NODE_BASE/$NODE_TAR" -o "$tmp/$NODE_TAR"
  (cd "$tmp" && grep " $NODE_TAR\$" <<<"$SUMS" | sha256sum -c --quiet -)
  rm -rf "$NODE_DIR.new" && mkdir -p "$NODE_DIR.new"
  tar -xJf "$tmp/$NODE_TAR" -C "$NODE_DIR.new" --strip-components=1
  rm -rf "$NODE_DIR" && mv "$NODE_DIR.new" "$NODE_DIR" && rm -rf "$tmp"
fi
export PATH="$BIN_DIR:$NODE_DIR/bin:$PATH"
if [ "$(opencode --version 2>/dev/null || true)" != "$OPENCODE_VERSION" ]; then
  npm install -g --no-fund --no-audit "opencode-ai@$OPENCODE_VERSION"
fi
mkdir -p "$BIN_DIR"
if [ ! -x "$BIN_DIR/gh" ]; then
  GH_VER="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | sed 's/^v//')"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/cli/cli/releases/download/v$GH_VER/gh_${GH_VER}_linux_${GH_ARCH}.tar.gz" | tar -xz -C "$tmp"
  install -m 755 "$tmp/gh_${GH_VER}_linux_${GH_ARCH}/bin/gh" "$BIN_DIR/gh"
  rm -rf "$tmp"
fi

step "Users: $AGENT (does the work) and $GW (talks to Telegram)"
id "$AGENT" >/dev/null 2>&1 || useradd --create-home --home-dir "$AGENT_HOME" --shell /bin/bash "$AGENT"
id "$GW" >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin "$GW"
id "$BACKUP" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/crowstance-backup --shell /usr/sbin/nologin "$BACKUP"
chmod 750 "$AGENT_HOME"
sudo -u "$AGENT" -H env PATH="$PATH" bash -c '
  git config --global user.name "Assistant"
  git config --global user.email "assistant@$(hostname)"
  git config --global init.defaultBranch main
  npm config set prefix "$HOME/.npm-global"
  mkdir -p "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/projects" "$HOME/.config/crowstance"
  mkdir -p -m 700 "$HOME/.ssh"
  [ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C "assistant@$(hostname)" -f "$HOME/.ssh/id_ed25519"
'

step "App code in $APP (immutable release + atomic pointer)"
mkdir -p /opt/crowstance "$(dirname "$APP")"
# shellcheck source=release.sh
. "$SRC_DIR/deploy/release.sh"
LEGACY_ID=""
if [ -e "$APP" ] && [ ! -L "$APP" ]; then
  LEGACY_ID="legacy-$(date -u +%Y%m%d%H%M%S)"
  echo "Adopting the existing in-place tree as release $LEGACY_ID"
  mkdir -p "$(crow_releases)"
  mv "$APP" "$(release_path "$LEGACY_ID")"
fi
RELEASE_ID="${CROW_RELEASE_ID:-$(date -u +%Y%m%d%H%M%S)}"
if [ "$SRC_DIR" != "$(release_path "$RELEASE_ID")" ]; then
  release_build "$SRC_DIR" "$RELEASE_ID"
fi
release_preserve_overlays "$RELEASE_ID" "$LEGACY_ID"
release_install_deps "$RELEASE_ID"
release_activate "$RELEASE_ID"
release_mark_good "$RELEASE_ID"
release_pending_clear
chmod 755 /opt/crowstance "$(crow_releases)"
# Code, templates and every root-executed helper are root-owned. Runtime users only need read access.
chown -R root:root "$(release_path "$RELEASE_ID")"
find "$(release_path "$RELEASE_ID")" -type d -exec chmod 755 {} +
find "$(release_path "$RELEASE_ID")" -type f -exec chmod 644 {} +
chmod +x "$(release_path "$RELEASE_ID")"/deploy/*.sh "$(release_path "$RELEASE_ID")"/home/scripts/*.sh

step "Assistant home ($AGENT_HOME/assistant)"
if [ ! -d "$AGENT_HOME/assistant" ]; then
  cp -a "$APP/home" "$AGENT_HOME/assistant"
  mkdir -p "$AGENT_HOME/assistant/scripts/monitors" "$AGENT_HOME/assistant/inbox"
  printf 'inbox/\nscripts/monitors/*.state\n' > "$AGENT_HOME/assistant/.gitignore"
  chown -R "$AGENT:$AGENT" "$AGENT_HOME/assistant"
  chmod +x "$AGENT_HOME/assistant/scripts/"*.sh
  sudo -u "$AGENT" -H bash -c "cd $AGENT_HOME/assistant && git init -q && git add -A && git commit -qm 'Initial memory'"
fi

install -d -o "$BACKUP" -g "$BACKUP" -m 700 /var/lib/crowstance-backup/export
install -d -o "$BACKUP" -g "$BACKUP" -m 700 /var/empty/crowstance-backup-hooks
# Encrypted state backups (SQLite + memory) run as root and keep the passphrase root-only.
install -d -o root -g root -m 700 /var/lib/crowstance-backup/state
if [ ! -s "$ETC/backup.key" ]; then
  umask 077
  head -c 48 /dev/urandom | base64 > "$ETC/backup.key"
fi
chown root:root "$ETC/backup.key"
chmod 600 "$ETC/backup.key"

step "Resource limits and ports"
CORES="$(nproc)"
MEM_MB="$(awk '/^MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
if [ "$SHARED" = 1 ]; then
  CPU_QUOTA="${CROW_CPU_QUOTA:-$(( (CORES + 1) / 2 * 100 ))%}"
  MEM_MAX_MB="$(to_mb "${CROW_MEMORY_MAX:-$(( MEM_MB * 40 / 100 ))M}")"
  CPU_WEIGHT=20 IO_WEIGHT=20 NICE=10 SWAP_MAX=512M
else
  CPU_QUOTA="${CROW_CPU_QUOTA:-$(( CORES * 100 ))%}"
  MEM_MAX_MB="$(to_mb "${CROW_MEMORY_MAX:-$(( MEM_MB * 85 / 100 ))M}")"
  CPU_WEIGHT=100 IO_WEIGHT=100 NICE=0 SWAP_MAX=infinity
fi
MEMORY_MAX="${MEM_MAX_MB}M"
TASKS_MAX=4096
OPENCODE_PORT="${OPENCODE_PORT:-$(pick_port 4096)}"
HQ_PORT="${HQ_PORT:-$(pick_port 7801)}"
echo "CPU: at most $CPU_QUOTA of $CORES cores (weight $CPU_WEIGHT) · RAM: at most $MEMORY_MAX of ${MEM_MB}M · ports: OpenCode $OPENCODE_PORT, hq $HQ_PORT"

mkdir -p "$ETC"
chmod 755 "$ETC"
install -m 600 /dev/null "$SETUP_ENV"
cat > "$SETUP_ENV" <<EOF
SHARED=$SHARED
TZ=${TZ:-}
CROW_HIDE_PATHS="${CROW_HIDE_PATHS:-}"
CROW_CPU_QUOTA=${CROW_CPU_QUOTA:-}
CROW_MEMORY_MAX=${CROW_MEMORY_MAX:-}
CROW_FENCE_PUBLIC_PORTS="${CROW_FENCE_PUBLIC_PORTS:-80 443}"
ADMIN_USER=$ADMIN_USER
OPENCODE_VERSION=$OPENCODE_VERSION
NODE_MAJOR=$NODE_MAJOR
OPENCODE_PORT=$OPENCODE_PORT
HQ_PORT=$HQ_PORT
CPU_QUOTA=$CPU_QUOTA
CPU_WEIGHT=$CPU_WEIGHT
IO_WEIGHT=$IO_WEIGHT
NICE=$NICE
MEMORY_MAX=$MEMORY_MAX
SWAP_MAX=$SWAP_MAX
TASKS_MAX=$TASKS_MAX
EOF

step "Secrets in $ETC"
ask() { # ask VAR "prompt" FILE — a provided value wins, else the existing one, else prompt (if interactive), else placeholder
  local var="$1" prompt="$2" file="$3" current value
  if [ -n "${!var:-}" ]; then printf '%s' "${!var}"; return; fi
  current="$(grep -E "^$var=" "$file" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$current" ] && [ "$current" != "CHANGE_ME" ]; then printf '%s' "$current"; return; fi
  if [ -t 0 ]; then read -r -p "$prompt: " value </dev/tty; printf '%s' "${value:-CHANGE_ME}"; else printf 'CHANGE_ME'; fi
}
keep() { grep -E "^$1=" "$2" 2>/dev/null | cut -d= -f2- || true; }

OC_ENV=$ETC/opencode.env
GW_ENV=$ETC/gateway.env
SERVER_PASSWORD="$(keep OPENCODE_SERVER_PASSWORD $OC_ENV)"; SERVER_PASSWORD="${SERVER_PASSWORD:-$(rand)}"
MCP_TOKEN="$(keep HQ_MCP_TOKEN $OC_ENV)"; MCP_TOKEN="${MCP_TOKEN:-$(rand)}"
NOTIFY_TOKEN="$(keep HQ_NOTIFY_TOKEN $GW_ENV)"; NOTIFY_TOKEN="${NOTIFY_TOKEN:-$(rand)}"
CROWBOT="$(ask CROWBOT_API_KEY 'crowbot account number (it is the API key)' $OC_ENV)"
ANTHROPIC="${ANTHROPIC_API_KEY:-$(keep ANTHROPIC_API_KEY $OC_ENV)}"
BOT_TOKEN="$(ask TELEGRAM_BOT_TOKEN 'Telegram bot token (from @BotFather)' $GW_ENV)"
OWNER_ID="$(ask OWNER_TELEGRAM_ID 'Your numeric Telegram user id (from @userinfobot)' $GW_ENV)"
ZONE="${TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)}"

cat > $OC_ENV <<EOF
CROWBOT_API_KEY=$CROWBOT
OPENCODE_SERVER_PASSWORD=$SERVER_PASSWORD
OPENCODE_PORT=$OPENCODE_PORT
HQ_PORT=$HQ_PORT
HQ_MCP_TOKEN=$MCP_TOKEN
OPENCODE_CONFIG=$APP/opencode/opencode.json
OPENCODE_ENABLE_EXA=1
ASSISTANT_HOME=$AGENT_HOME/assistant
PROJECTS_DIR=$AGENT_HOME/projects
TZ=$ZONE
EOF
if [ -n "$ANTHROPIC" ]; then echo "ANTHROPIC_API_KEY=$ANTHROPIC" >> $OC_ENV; fi
cat > $GW_ENV <<EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
OWNER_TELEGRAM_ID=$OWNER_ID
OPENCODE_URL=http://127.0.0.1:$OPENCODE_PORT
OPENCODE_SERVER_PASSWORD=$SERVER_PASSWORD
HQ_PORT=$HQ_PORT
HQ_MCP_TOKEN=$MCP_TOKEN
HQ_NOTIFY_TOKEN=$NOTIFY_TOKEN
CROWBOT_API_KEY=$CROWBOT
ASSISTANT_HOME=$AGENT_HOME/assistant
PROJECTS_DIR=$AGENT_HOME/projects
DATA_DIR=/var/lib/crowstance
TZ=$ZONE
QUIET_HOURS=23:00-08:00
MORNING_CHECKIN=08:30
DAILY_BUDGET_USD=20
MAX_WORKERS=3
EOF
# settings you added by hand survive re-runs if they live in gateway.env.local
if [ -f $ETC/gateway.env.local ]; then cat $ETC/gateway.env.local >> $GW_ENV; fi
# systemd reads these as root before starting the services, so no service user needs to read them.
chown root:root $OC_ENV $GW_ENV && chmod 600 $OC_ENV $GW_ENV
install -o $AGENT -g $AGENT -m 600 /dev/null $AGENT_HOME/.config/crowstance/notify.env
printf 'HQ_NOTIFY_URL=http://127.0.0.1:%s/notify\nHQ_NOTIFY_TOKEN=%s\n' "$HQ_PORT" "$NOTIFY_TOKEN" > $AGENT_HOME/.config/crowstance/notify.env
if [ -f "$SECRETS_FILE" ]; then shred -u "$SECRETS_FILE"; fi

step "Services"
"$APP/deploy/install-units.sh"
if grep -q CHANGE_ME $OC_ENV $GW_ENV; then
  echo "Some secrets are still CHANGE_ME: edit $OC_ENV and $GW_ENV, then run"
  echo "  systemctl restart crowstance-opencode crowstance-gateway"
else
  systemctl restart crowstance-opencode
  sleep 3
  systemctl restart crowstance-gateway
  systemctl start crowstance-backup.timer
fi

if [ "$SHARED" != 1 ]; then
  step "Dedicated server: firewall and SSH hardening"
  ufw allow OpenSSH >/dev/null
  ufw --force enable >/dev/null
  systemctl enable --now fail2ban >/dev/null
  if [ -s /root/.ssh/authorized_keys ]; then
    if ! id "$ADMIN_USER" >/dev/null 2>&1; then
      useradd --create-home --shell /bin/bash --groups sudo "$ADMIN_USER"
      install -d -o "$ADMIN_USER" -g "$ADMIN_USER" -m 700 "/home/$ADMIN_USER/.ssh"
      install -o "$ADMIN_USER" -g "$ADMIN_USER" -m 600 /root/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/authorized_keys"
      echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER" && chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"
    fi
    SSHD_DROPIN=/etc/ssh/sshd_config.d/99-crowstance.conf
    cat > "$SSHD_DROPIN" <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
    # Never disable root/password logins unless a real admin key + sudo path exists.
    if "$APP/deploy/ssh-guard.sh" --admin-user "$ADMIN_USER" --authorized-keys "/home/$ADMIN_USER/.ssh/authorized_keys"; then
      if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null; then
        echo "SSH: log in as $ADMIN_USER from now on (root and password logins are off)."
      else
        rm -f "$SSHD_DROPIN"
        echo "WARNING: could not reload sshd; SSH hardening was reverted to avoid a bad config."
      fi
    else
      rm -f "$SSHD_DROPIN"
      echo "WARNING: SSH hardening skipped to avoid locking you out. Give $ADMIN_USER a working key"
      echo "         and sudo access, then re-run setup."
    fi
  else
    echo "WARNING: /root/.ssh/authorized_keys is empty, so SSH hardening was skipped to avoid locking you out."
  fi
fi

step "Done"
echo "Agent's SSH public key (add it to GitHub as a deploy key if it should push somewhere):"
cat $AGENT_HOME/.ssh/id_ed25519.pub
echo
echo "Check everything:  sudo $APP/deploy/doctor.sh"
echo "Logs:              journalctl -u crowstance-gateway -u crowstance-opencode -f"
if [ "$SHARED" = 1 ]; then echo "Network fence:     sudo $APP/deploy/netguard.sh status"; fi
