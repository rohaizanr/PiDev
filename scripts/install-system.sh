#!/usr/bin/env bash
# Run on the Raspberry Pi as the service account (uses sudo for 2 files).
# 1. /etc/claude-code/managed-settings.d/50-pidev.json  (root-owned Claude Code policy)
# 2. /etc/systemd/system/pidev-agent.service            (not enabled here)
# Shows a diff and asks before replacing anything that already exists.
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root
load_env
pidev validate >/dev/null || die "Configuration invalid. Run scripts/configure.sh."

NODE_BIN="$(command -v node)"
OPENACP="$(openacp_bin)"; [[ -n "$OPENACP" ]] || die "openacp not on PATH."
OPENACP="$(readlink -f "$OPENACP")"
# openacp is a node script; keep its shebang resolution working under systemd.
SERVICE_PATH="$(dirname "$NODE_BIN"):$(dirname "$(command -v claude 2>/dev/null || echo /usr/bin/true)"):$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

SANDBOX=off
if command -v bwrap >/dev/null && command -v socat >/dev/null; then SANDBOX=on; fi
say "Claude Code bash sandbox: $SANDBOX (requires bubblewrap + socat)"
[[ "$SANDBOX" == on ]] || warn "Without the sandbox, shell commands are confined only by the guard hook, permission prompts and OS permissions. Install: sudo apt install bubblewrap socat — then re-run."

install_file() { # install_file <src> <dest> <mode>
  local src="$1" dest="$2" mode="$3"
  if sudo test -e "$dest"; then
    if sudo cmp -s "$src" "$dest"; then say "$dest unchanged."; return 0; fi
    warn "$dest already exists and differs:"
    sudo diff -u "$dest" "$src" || true
    confirm "Replace $dest (a backup copy will be kept)?" || { warn "Skipped $dest"; return 1; }
    sudo cp -p "$dest" "$dest.bak-$(date +%Y%m%d%H%M%S)"
  fi
  sudo install -o root -g root -m "$mode" "$src" "$dest"
  say "Installed $dest"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---- Managed Claude Code policy --------------------------------------------
pidev render claude-policy --sandbox "$SANDBOX" > "$TMP/50-pidev.json"
echo "Managed Claude Code policy to install (root-owned; the agent cannot change it):"
sed -n '1,40p' "$TMP/50-pidev.json"; echo "  ... ($(wc -l < "$TMP/50-pidev.json") lines total)"
if [[ -e /etc/claude-code/managed-settings.json ]]; then
  warn "An existing /etc/claude-code/managed-settings.json is present. PiDev uses a drop-in and does not modify it, but review it for conflicting rules."
fi
confirm "Install the policy to /etc/claude-code/managed-settings.d/50-pidev.json?" || die "Aborted."
sudo install -d -o root -g root -m 755 /etc/claude-code /etc/claude-code/managed-settings.d
install_file "$TMP/50-pidev.json" /etc/claude-code/managed-settings.d/50-pidev.json 644 || true

# ---- systemd unit ------------------------------------------------------------
UNIT_DEST="/etc/systemd/system/$SERVICE_NAME"
sed -e "s#@USER@#$(id -un)#g" -e "s#@GROUP@#$(id -gn)#g" -e "s#@HOME@#$HOME#g" \
    -e "s#@PIDEV_HOME@#$PIDEV_HOME#g" -e "s#@WORKSPACE_ROOT@#$PIDEV_WORKSPACE_ROOT#g" \
    -e "s#@NODE_BIN@#$NODE_BIN#g" -e "s#@OPENACP_BIN@#$OPENACP#g" -e "s#@PATH@#$SERVICE_PATH#g" \
    "$PIDEV_HOME/systemd/pidev-agent.service.in" > "$TMP/$SERVICE_NAME"
grep -q '@[A-Z_]*@' "$TMP/$SERVICE_NAME" && die "Unrendered placeholder in unit file."
if systemctl list-unit-files --no-legend | awk '{print $1}' | grep -qx "openacp.service"; then
  warn "An OpenACP user/system unit exists. Two pollers on one bot token conflict. Disable it: systemctl --user disable --now openacp"
fi
if command -v systemd-analyze >/dev/null; then
  cp "$TMP/$SERVICE_NAME" "$TMP/check.service"
  systemd-analyze verify "$TMP/check.service" 2>&1 | grep -v 'check.service' || true
fi
install_file "$TMP/$SERVICE_NAME" "$UNIT_DEST" 644 && sudo systemctl daemon-reload

say "Installed but NOT enabled. Next:"
echo "  scripts/start.sh --foreground   # smoke test from Telegram, Ctrl-C to stop"
echo "  scripts/start.sh --enable       # enable at boot and start"
