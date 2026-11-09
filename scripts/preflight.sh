#!/usr/bin/env bash
# Run on the Raspberry Pi. Read-only pre-installation check: hardware, OS,
# required tools and conflicting services. Changes nothing.
#   scripts/preflight.sh          human-readable report, exit 1 on blockers
#   scripts/preflight.sh --quiet  only blockers/warnings (used by install.sh / setup.sh)
source "$(dirname "$0")/lib.sh"
require_pi_host
set +e
QUIET=0; [[ "${1:-}" == "--quiet" ]] && QUIET=1
BLOCK=0
ok()    { (( QUIET )) || printf '  \033[32mok\033[0m    %s\n' "$*"; }
warnp() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
block() { printf '  \033[31mBLOCK\033[0m %s\n' "$*"; BLOCK=1; }

(( QUIET )) || say "Pre-flight check ($(id -un)@$(hostname))"

# ---- identity ----------------------------------------------------------------
[[ "$(id -u)" -ne 0 ]] && ok "non-root user $(id -un) (home $HOME)" || block "running as root — use your normal (or a dedicated) non-root account"

# ---- hardware / OS -----------------------------------------------------------
[[ -r /proc/device-tree/model ]] && ok "model: $(tr -d '\0' </proc/device-tree/model)"
ARCH="$(uname -m)"; BITS="$(getconf LONG_BIT 2>/dev/null || echo ?)"
case "$ARCH" in
  aarch64|arm64) [[ "$BITS" == 64 ]] && ok "architecture $ARCH, 64-bit userland" || block "64-bit kernel but $BITS-bit userland — install 64-bit Raspberry Pi OS";;
  x86_64) ok "architecture x86_64 (not a Pi, but supported)";;
  armv7l|armv6l) block "architecture $ARCH (32-bit ARM) is not supported by Claude Code — reflash with Raspberry Pi OS (64-bit)";;
  *) block "unsupported architecture $ARCH";;
esac
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  ok "OS: ${PRETTY_NAME:-unknown}"
  if [[ "${ID:-}" == debian || "${ID:-}" == raspbian || "${ID_LIKE:-}" == *debian* ]]; then
    [[ "${VERSION_ID:-0}" -ge 11 ]] 2>/dev/null || warnp "Debian ${VERSION_ID:-?} is old; Debian 12 (bookworm) or newer is recommended"
  fi
fi
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( MEM_MB >= 3500 )); then ok "RAM ${MEM_MB} MB"; else warnp "RAM ${MEM_MB} MB — Claude Code documents 4 GB+; keep 1 concurrent session and enable swap"; fi
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
(( SWAP_MB > 0 )) && ok "swap ${SWAP_MB} MB" || warnp "no swap configured (recommended on 4 GB models)"
FREE_GB=$(df -Pk "$HOME" | awk 'NR==2{print int($4/1048576)}')
(( FREE_GB >= 5 )) && ok "disk free in \$HOME: ${FREE_GB} GB" || warnp "only ${FREE_GB} GB free in \$HOME (5 GB+ recommended)"

# ---- tools ---------------------------------------------------------------------
command -v systemctl >/dev/null && ok "systemd present" || block "systemd not found"
command -v git >/dev/null && ok "$(git --version)" || block "git missing — sudo apt install -y git"
command -v curl >/dev/null && ok "curl present" || block "curl missing — sudo apt install -y curl"
NM=$(node_major)
if (( NM >= 22 )); then ok "node $(node --version)"
elif (( NM >= 20 )); then warnp "node $(node --version): OK for OpenACP; Node 22 LTS recommended (Claude Code npm package needs 22+)"
else block "Node.js 20+ required (found: $(node --version 2>/dev/null || echo none)) — install Node 22 LTS (docs/INSTALLATION.md step 2)"; fi
command -v npm >/dev/null && ok "npm $(npm --version)" || block "npm missing (comes with Node.js)"
if command -v bwrap >/dev/null && command -v socat >/dev/null; then ok "bubblewrap + socat (Claude Code sandbox available)"
else warnp "bubblewrap/socat missing — sudo apt install -y bubblewrap socat (strongly recommended)"; fi
if command -v sudo >/dev/null && id -nG | grep -qwE 'sudo|wheel'; then ok "user can use sudo (needed once, for install-system.sh)"
else warnp "$(id -un) is not in the sudo group — an administrator must run scripts/install-system.sh steps"; fi

# ---- network --------------------------------------------------------------------
if curl -fsS -m 8 -o /dev/null https://api.telegram.org; then ok "outbound HTTPS to api.telegram.org"
else
  code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.telegram.org)
  [[ "$code" =~ ^[2-4][0-9][0-9]$ ]] && ok "outbound HTTPS to api.telegram.org (HTTP $code)" || block "cannot reach api.telegram.org over HTTPS"
fi
curl -s -m 8 -o /dev/null https://registry.npmjs.org && ok "outbound HTTPS to registry.npmjs.org" || block "cannot reach registry.npmjs.org"

# ---- conflicts --------------------------------------------------------------------
if pgrep -f 'openacp.*(start|--daemon-child)' >/dev/null; then warnp "an OpenACP process is already running (pid $(pgrep -f 'openacp.*(start|--daemon-child)' | tr '\n' ' ')) — only one poller per bot token"; else ok "no running OpenACP process"; fi
systemctl --user is-enabled openacp >/dev/null 2>&1 && warnp "OpenACP user autostart unit is enabled — PiDev uses its own systemd unit; disable with: systemctl --user disable --now openacp"
[[ -e /etc/systemd/system/$SERVICE_NAME ]] && ok "$SERVICE_NAME already installed (will be diffed, not overwritten blindly)"
if command -v ss >/dev/null && ss -ltn | awk 'NR>1{print $4}' | grep -qE '(:|\])21420$'; then warnp "TCP port 21420 (OpenACP local API) already in use"; fi

echo
if (( BLOCK )); then say "Pre-flight: BLOCKERS found — fix the items marked BLOCK first."; exit 1; fi
(( QUIET )) || say "Pre-flight: OK (warnings, if any, are recommendations)."
exit 0
