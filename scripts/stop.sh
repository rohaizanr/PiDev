#!/usr/bin/env bash
# [PI] Stop PiDev gracefully (SIGTERM, 30 s timeout). --disable also removes it from boot.
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root
sudo systemctl stop "$SERVICE_NAME"
[[ "${1:-}" == "--disable" ]] && sudo systemctl disable "$SERVICE_NAME"
systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
