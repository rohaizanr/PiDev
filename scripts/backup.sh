#!/usr/bin/env bash
# [PI] Back up PiDev configuration + state and the OpenACP instance.
# The archive CONTAINS SECRETS (.env, OpenACP plugin settings): it is written
# with mode 0600 into backups/ (git-ignored, excluded from deploys).
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root
load_env

umask 077
mkdir -p "$PIDEV_HOME/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$PIDEV_HOME/backups/pidev-$STAMP.tar.gz"
ITEMS=()
for p in "$PIDEV_HOME/.env" "$PIDEV_HOME/config/projects.json" "$PIDEV_HOME/state"; do [[ -e "$p" ]] && ITEMS+=("$p"); done
INST="$PIDEV_WORKSPACE_ROOT/.openacp"
[[ -d "$INST" ]] && ITEMS+=("$INST")
[[ -f /etc/systemd/system/$SERVICE_NAME ]] && ITEMS+=("/etc/systemd/system/$SERVICE_NAME")
[[ -f /etc/claude-code/managed-settings.d/50-pidev.json ]] && ITEMS+=("/etc/claude-code/managed-settings.d/50-pidev.json")
(( ${#ITEMS[@]} )) || die "Nothing to back up."
tar --exclude='*/logs/*' --exclude='*/cache/*' --exclude='*/node_modules/*' -czf "$OUT" "${ITEMS[@]}" 2>/dev/null
chmod 600 "$OUT"
say "Backup written: $OUT ($(du -h "$OUT" | cut -f1)) — contains secrets, keep it private."
# Keep the 10 most recent backups.
ls -1t "$PIDEV_HOME"/backups/pidev-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
