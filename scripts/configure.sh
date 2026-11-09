#!/usr/bin/env bash
# Run on the Raspberry Pi as the service account.
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

# ---- LLM provider -------------------------------------------------------------
echo
echo "LLM provider:"
echo "  claude  Anthropic Claude via Claude Code   (PiDev guard + managed policy ACTIVE)"
echo "  openai  OpenAI via Codex CLI (codex-acp)   (PiDev guard NOT active)"
echo "  gemini  Google via Gemini CLI              (PiDev guard NOT active)"
cur_prov="$(get_existing LLM_PROVIDER)"
read -r -p "Provider [${cur_prov:-claude}]: " prov
prov="$(printf '%s' "${prov:-${cur_prov:-claude}}" | tr '[:upper:]' '[:lower:]')"
case "$prov" in claude|openai|gemini) ;; *) die "Unknown provider '$prov'.";; esac

allow_unguarded="false"
if [[ "$prov" != claude ]]; then
  warn "With '$prov', PiDev's per-tool guard (workspace boundary, secret blocks, sudo/force-push bans, write locks) does NOT run."
  warn "Only systemd/OS limits, OpenACP's allowlist and the agent's own approval prompts apply. See docs/SECURITY.md."
  confirm "Accept running an unguarded provider?" || die "Aborted. Use LLM_PROVIDER=claude for the guarded setup."
  allow_unguarded="true"
fi

cur_model="$(get_existing LLM_MODEL)"
read -r -p "Model (empty = agent default) [${cur_model}]: " model
model="${model:-$cur_model}"

cur_key="$(get_existing LLM_API_KEY)"
echo "API key for $prov. Leave empty to use the agent's own login instead (e.g. 'claude auth login')."
read -r -s -p "LLM API key ${cur_key:+[keep existing; type - to remove]}: " key; echo
if [[ "$key" == "-" ]]; then key=""; else key="${key:-$cur_key}"; fi

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
  echo "LLM_PROVIDER=$prov"
  echo "LLM_MODEL=$model"
  echo "LLM_API_KEY=$key"
  echo "PIDEV_ALLOW_UNGUARDED_PROVIDER=$allow_unguarded"
} > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
unset token key cur_key
chmod 700 "$PIDEV_HOME/state" "$PIDEV_HOME/logs" 2>/dev/null || true

say "Saved. Validating (values are not shown):"
if pidev validate; then
  say "Configuration valid."
  echo "If OpenACP is already set up, apply the provider change with:"
  echo "  scripts/post-onboard.sh && scripts/install-system.sh && sudo systemctl restart pidev-agent"
else
  die "Configuration invalid — fix the errors above and re-run scripts/configure.sh."
fi
