#!/usr/bin/env bash
# [MAC] Read-only inspection of the Pi over SSH. Changes nothing.
#   PIDEV_PI_SSH_HOST=<alias> scripts/remote-inspect.sh
source "$(dirname "$0")/lib.sh"
require_mac_host
HOST="${PIDEV_PI_SSH_HOST:-}"
[[ -n "$HOST" ]] || die "Set PIDEV_PI_SSH_HOST to your Pi's SSH alias."
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" 'bash -s' <<'REMOTE'
echo "user=$(id -un) uid=$(id -u) home=$HOME"
[ -r /proc/device-tree/model ] && echo "model=$(tr -d '\0' </proc/device-tree/model)"
. /etc/os-release 2>/dev/null && echo "os=$PRETTY_NAME"
echo "kernel/arch=$(uname -srm)  userland bits=$(getconf LONG_BIT)"
free -h | sed -n 1,2p; df -h "$HOME" | tail -1
for c in node npm git claude openacp systemctl bwrap socat; do printf '%-10s ' "$c"; command -v $c >/dev/null && ($c --version 2>/dev/null | head -1 || echo present) || echo "not found"; done
for p in ~/.claude ~/.openacp ~/pidev-agent ~/projects /etc/claude-code /etc/systemd/system/pidev-agent.service; do [ -e "$p" ] && echo "exists: $p"; done
echo "--- running services matching openacp/pidev/claude:"
systemctl list-units --type=service --no-legend 2>/dev/null | grep -Ei 'openacp|pidev|claude' || echo "(none)"
systemctl --user list-units --type=service --no-legend 2>/dev/null | grep -Ei 'openacp|pidev' || true
echo "--- listening TCP ports:"
ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | sort -u
REMOTE
