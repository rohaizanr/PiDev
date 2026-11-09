# shellcheck shell=bash
# Common helpers for PiDev scripts. Source, don't execute.
set -euo pipefail

PIDEV_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PIDEV_HOME
SERVICE_NAME="pidev-agent.service"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARN\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

require_pi_host() {
  [[ "$(uname -s)" == "Linux" ]] || die "This is a [PI] script. You are on $(uname -s). Run it on the Raspberry Pi (e.g. ssh <pi> '$0')."
}
require_mac_host() {
  [[ "$(uname -s)" == "Darwin" ]] || die "This is a [MAC] script meant for the development machine."
}
require_not_root() {
  [[ "$(id -u)" -ne 0 ]] || die "Do not run PiDev as root. Run as the non-root service account."
}

confirm() { # confirm "question" -> returns 0 on yes
  local ans
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# Load .env into the environment without printing anything.
load_env() {
  local f="$PIDEV_HOME/.env"
  [[ -f "$f" ]] || die "$f not found. Run scripts/configure.sh first."
  local mode
  mode="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")"
  [[ "$mode" == "600" ]] || die "$f must be mode 600 (is $mode). Fix: chmod 600 '$f'"
  set -a
  # shellcheck disable=SC1090
  source "$f"
  set +a
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

openacp_bin() { command -v openacp 2>/dev/null || true; }

pidev() { node "$PIDEV_HOME/bin/pidev.js" "$@"; }
