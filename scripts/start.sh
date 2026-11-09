#!/usr/bin/env bash
# [PI] Start PiDev.
#   scripts/start.sh               start the systemd service
#   scripts/start.sh --enable      enable at boot and start
#   scripts/start.sh --foreground  run OpenACP in this terminal (smoke test; service must be stopped)
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root
load_env
pidev validate || die "Refusing to start: configuration invalid."

case "${1:-}" in
  --foreground)
    if systemctl is-active --quiet "$SERVICE_NAME"; then die "$SERVICE_NAME is running. Stop it first (scripts/stop.sh) — two pollers on one token conflict."; fi
    if pgrep -u "$(id -u)" -f 'openacp.*(start|--daemon-child)' >/dev/null; then die "Another OpenACP process is running for this user. Stop it first: openacp stop --dir \"$PIDEV_WORKSPACE_ROOT\""; fi
    say "Foreground smoke test. In Telegram (your private forum group) send: /pidev, /projects, /project <name>. Ctrl-C to stop."
    export PIDEV_HOME
    cd "$PIDEV_WORKSPACE_ROOT"
    exec "$(openacp_bin)" start --foreground --dir "$PIDEV_WORKSPACE_ROOT"
    ;;
  --enable)
    sudo systemctl enable --now "$SERVICE_NAME"
    ;;
  "")
    sudo systemctl start "$SERVICE_NAME"
    ;;
  *) die "unknown option $1";;
esac
sleep 2
systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
