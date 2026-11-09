#!/usr/bin/env bash
# Run on the Raspberry Pi as the non-root service account (setup.sh step "install").
# User-level installation: verifies the platform, installs OpenACP and Claude
# Code for THIS user (no sudo), prepares directories. System-level steps
# (managed Claude policy + systemd unit) are in scripts/install-system.sh.
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root

say "PiDev install (user level) in $PIDEV_HOME as $(id -un)"

# ---- Platform checks (shared with scripts/preflight.sh) ----------------------
"$PIDEV_HOME/scripts/preflight.sh" --quiet || die "Pre-flight blockers found (see above). Fix them and re-run."
NODE_MAJ=$(node_major)

# ---- npm global prefix without sudo -----------------------------------------
NPM_PREFIX="$(npm config get prefix)"
if [[ ! -w "$NPM_PREFIX/lib" && ! -w "$NPM_PREFIX" ]]; then
  warn "npm global prefix $NPM_PREFIX is not writable by $(id -un) (PiDev never uses sudo npm)."
  if confirm "Set a user-local npm prefix at ~/.npm-global (adds it to ~/.profile PATH)?"; then
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"
    grep -q 'npm-global/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.profile"
    export PATH="$HOME/.npm-global/bin:$PATH"
  else
    die "Cannot install OpenACP globally without a writable npm prefix."
  fi
fi

# ---- OpenACP -----------------------------------------------------------------
if [[ -z "$(openacp_bin)" ]]; then
  say "Installing OpenACP (npm install -g @openacp/cli)"
  npm install -g @openacp/cli
else
  say "OpenACP already installed: $(openacp --version 2>/dev/null | head -1)"
fi
[[ -n "$(openacp_bin)" ]] || die "openacp not on PATH after install. Open a new shell (PATH) and re-run."

# ---- Claude Code -------------------------------------------------------------
if command -v claude >/dev/null; then
  say "Claude Code already installed: $(claude --version 2>/dev/null | head -1)"
else
  say "Claude Code not found. Anthropic's recommended method is the native installer."
  echo "PiDev will NOT pipe a remote script into bash. It downloads it for you to inspect first."
  TMP="$(mktemp -d)"
  curl -fsSL https://claude.ai/install.sh -o "$TMP/claude-install.sh"
  echo "Downloaded to: $TMP/claude-install.sh"
  echo "SHA-256:       $(sha256sum "$TMP/claude-install.sh" | cut -d' ' -f1)"
  echo "Review it now, e.g.:  less $TMP/claude-install.sh"
  if confirm "Have you reviewed it and want to run it (installs to your user account, no sudo)?"; then
    bash "$TMP/claude-install.sh"
  elif (( NODE_MAJ >= 22 )) && confirm "Install via npm instead (npm install -g @anthropic-ai/claude-code)?"; then
    npm install -g @anthropic-ai/claude-code
  else
    warn "Claude Code not installed. Install it later, then re-run this script."
  fi
fi

# ---- Directories and permissions --------------------------------------------
mkdir -p "$PIDEV_HOME/state/locks" "$PIDEV_HOME/logs" "$PIDEV_HOME/config" "$PIDEV_HOME/backups"
chmod 700 "$PIDEV_HOME/state" "$PIDEV_HOME/logs" "$PIDEV_HOME/backups"
[[ -f "$PIDEV_HOME/config/projects.json" ]] || { cp "$PIDEV_HOME/config/projects.example.json" "$PIDEV_HOME/config/projects.json"; node -e '
  const f=process.argv[1]; const d=JSON.parse(require("fs").readFileSync(f)); d.projects=[]; require("fs").writeFileSync(f, JSON.stringify(d,null,2)+"\n");' "$PIDEV_HOME/config/projects.json"; chmod 600 "$PIDEV_HOME/config/projects.json"; say "Created empty config/projects.json"; }
[[ -f "$PIDEV_HOME/.env" ]] && chmod 600 "$PIDEV_HOME/.env"

# ---- Sandbox prerequisites (Claude Code bash sandbox on Linux) --------------
if command -v bwrap >/dev/null && command -v socat >/dev/null; then
  say "bubblewrap + socat present (Claude Code sandbox can be enabled)."
else
  warn "bubblewrap/socat missing: the Claude Code bash sandbox cannot run. Install with: sudo apt install bubblewrap socat"
fi

say "User-level install done. Continue with: scripts/setup.sh   (or see docs/INSTALLATION.md)"
