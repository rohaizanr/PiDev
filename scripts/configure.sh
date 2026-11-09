#!/usr/bin/env bash
# [PI — run on the Raspberry Pi as the service account]
# Interactive, silent configuration. Writes $PIDEV_HOME/.env with mode 0600.
# Secret values are never echoed, logged, or passed on a command line.
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root

ENV_FILE="$PIDEV_HOME/.env"
umask 077

get_existing() { # get_existing KEY -> prints current value (internal use only)
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}

say "PiDev configuration ($ENV_FILE)"
echo "Values in [brackets] are kept if you press Enter. Secrets are read silently."
echo

cur_token="$(get_existing OPENACP_TELEGRAM_BOT_TOKEN)"
read -r -s -p "Telegram bot token from @BotFather ${cur_token:+[keep existing]}: " token; echo
token="${token:-$cur_token}"
[[ -n "$token" ]] || die "A bot token is required."

cur_chat="$(get_existing OPENACP_TELEGRAM_CHAT_ID)"
read -r -p "Private forum supergroup chat ID (starts with -100) [${cur_chat}]: " chat
chat="${chat:-$cur_chat}"

cur_ids="$(get_existing PIDEV_ALLOWED_USER_IDS)"
read -r -p "Your numeric Telegram user ID(s), comma-separated [${cur_ids}]: " ids
ids="${ids:-$cur_ids}"

cur_root="$(get_existing PIDEV_WORKSPACE_ROOT)"
default_root="${cur_root:-$HOME/projects}"
read -r -p "Workspace root for agent projects [${default_root}]: " root
root="${root:-$default_root}"
[[ "$root" = /* ]] || die "Workspace root must be an absolute path."
if [[ ! -d "$root" ]]; then
  confirm "Create $root ?" && mkdir -p "$root" || die "Workspace root does not exist."
fi

cur_max="$(get_existing PIDEV_MAX_CONCURRENT_TASKS)"
read -r -p "Max concurrent agent sessions [${cur_max:-1}]: " maxt
maxt="${maxt:-${cur_max:-1}}"

tmp="$(mktemp "$PIDEV_HOME/.env.XXXXXX")"
{
  echo "# Written by scripts/configure.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Mode 0600. Never commit."
  echo "OPENACP_TELEGRAM_BOT_TOKEN=$token"
  echo "OPENACP_TELEGRAM_CHAT_ID=$chat"
  echo "OPENACP_TUNNEL_ENABLED=false"
  echo "OPENACP_LOG_LEVEL=info"
  echo "PIDEV_ALLOWED_USER_IDS=$ids"
  echo "PIDEV_WORKSPACE_ROOT=$root"
  echo "PIDEV_MAX_CONCURRENT_TASKS=$maxt"
  echo "PIDEV_LOCK_TTL_MINUTES=30"
  echo "PIDEV_APPROVAL_MODE=strict"
} > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
unset token
chmod 700 "$PIDEV_HOME/state" "$PIDEV_HOME/logs" 2>/dev/null || true

say "Saved. Validating (values are not shown):"
if pidev validate; then
  say "Configuration valid."
else
  die "Configuration invalid — fix the errors above and re-run scripts/configure.sh."
fi
