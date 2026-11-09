#!/usr/bin/env bash
# Run on the Raspberry Pi as the service account, after `openacp onboard`.
# Locks down the OpenACP instance and installs the PiDev plugin + Claude agent.
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root
load_env

OPENACP="$(openacp_bin)"; [[ -n "$OPENACP" ]] || die "openacp not on PATH."
INST="$PIDEV_WORKSPACE_ROOT/.openacp"
[[ -f "$INST/config.json" ]] || die "No OpenACP instance at $INST. Run: openacp onboard --dir \"$PIDEV_WORKSPACE_ROOT\""

say "Checking that this OpenACP version still has the settings PiDev relies on"
OA_DIST="$(dirname "$(readlink -f "$OPENACP")")"
for key in allowExternalWorkspaces allowedUserIds 'chatId !== this.telegramConfig.chatId'; do
  grep -rqF -- "$key" "$OA_DIST" || die "OpenACP no longer contains '$key'. Re-verify PiDev against this OpenACP version before continuing."
done

say "Backing up the OpenACP instance first"
"$PIDEV_HOME/scripts/backup.sh"

PROVIDER="${LLM_PROVIDER:-claude}"
case "$PROVIDER" in
  claude) AGENT=claude; CLI=claude; CLI_INSTALL="scripts/install.sh (native installer) or npm install -g @anthropic-ai/claude-code";;
  openai) AGENT=codex;  CLI=codex;  CLI_INSTALL="npm install -g @openai/codex";;
  gemini) AGENT=gemini; CLI="";     CLI_INSTALL="";;
  *) die "Unknown LLM_PROVIDER '$PROVIDER'";;
esac
say "LLM provider: $PROVIDER -> OpenACP agent '$AGENT'"
pidev provider || die "Provider configuration invalid (scripts/configure.sh)."

if [[ -n "$CLI" ]] && ! command -v "$CLI" >/dev/null; then
  warn "The $AGENT agent needs the '$CLI' CLI, which is not installed."
  if [[ "$PROVIDER" == openai ]] && confirm "Install it now with: $CLI_INSTALL ?"; then
    npm install -g @openai/codex
  else
    die "Install it first: $CLI_INSTALL"
  fi
fi

say "Installing the '$AGENT' agent adapter into OpenACP"
"$OPENACP" agents install "$AGENT" --dir "$PIDEV_WORKSPACE_ROOT" || warn "agents install failed — see docs/TROUBLESHOOTING.md (ACP/agent startup)."

say "Applying PiDev lock-down + provider to OpenACP (allowlist, no external workspaces, foreground, tunnel off, default agent, key/model)"
pidev apply openacp --dry-run
confirm "Apply these changes?" || die "Aborted."
pidev apply openacp
chmod 700 "$INST"
[[ -f "$INST/agents.json" ]] && chmod 600 "$INST/agents.json"

say "Installing the PiDev plugin into OpenACP"
"$OPENACP" plugin add "$PIDEV_HOME/plugin" --dir "$PIDEV_WORKSPACE_ROOT" || die "plugin install failed."

say "OpenACP doctor (check only)"
"$OPENACP" doctor --dry-run --dir "$PIDEV_WORKSPACE_ROOT" || warn "openacp doctor reported problems (see above)."

if [[ -z "${LLM_API_KEY:-}" ]]; then
  case "$PROVIDER" in
    claude) say "No LLM_API_KEY: log in once with: claude auth login";;
    openai) say "No LLM_API_KEY: log in once with: codex  (Sign in with ChatGPT)";;
    gemini) say "No LLM_API_KEY: log in once with: openacp agents run gemini --dir \"$PIDEV_WORKSPACE_ROOT\"";;
  esac
fi
say "Done. Next: scripts/install-system.sh (re-run it after changing provider, model or key)"
