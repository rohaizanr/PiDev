#!/usr/bin/env bash
# Run on the Raspberry Pi. Service state, PiDev status, guard decisions and a redacted log excerpt.
#   scripts/status.sh [lines]   (default 40 journal lines)
source "$(dirname "$0")/lib.sh"
require_pi_host
LINES="${1:-40}"

say "Service"
systemctl --no-pager --lines=0 status "$SERVICE_NAME" 2>/dev/null || echo "  $SERVICE_NAME not installed or not running"
echo "  enabled at boot: $(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || echo no)"

say "PiDev"
pidev status || true

say "Recent guard decisions (deny/ask)"
tail -n 10 "$PIDEV_HOME/logs/guard.log" 2>/dev/null | pidev redact || echo "  none"

say "Last $LINES journal lines (redacted)"
journalctl -u "$SERVICE_NAME" -n "$LINES" --no-pager 2>/dev/null | pidev redact || echo "  (no journal access — add your user to the systemd-journal group or use sudo)"
