#!/usr/bin/env bash
# [PI] Diagnostics. Read-only. Prints no secret values.
source "$(dirname "$0")/lib.sh"
require_pi_host
set +e
FAIL=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
note() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }

say "Identity / platform"
[[ "$(id -u)" -ne 0 ]] && ok "running as non-root user $(id -un)" || bad "running as root"
ARCH="$(uname -m)"; [[ "$ARCH" == aarch64 || "$ARCH" == x86_64 ]] && ok "arch $ARCH" || bad "arch $ARCH not supported by Claude Code"
[[ -r /etc/os-release ]] && { . /etc/os-release; ok "OS ${PRETTY_NAME:-?}"; }
[[ -r /proc/device-tree/model ]] && ok "model $(tr -d '\0' </proc/device-tree/model)"
ok "RAM $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo) MB, disk free $(df -h "$PIDEV_HOME" | awk 'NR==2{print $4}')"

say "Tooling"
NM=$(node_major); (( NM >= 20 )) && ok "node $(node --version)" || bad "node >= 20 required (found $(node --version 2>/dev/null || echo none))"
command -v git >/dev/null && ok "$(git --version)" || bad "git missing"
if [[ -n "$(openacp_bin)" ]]; then ok "openacp $(openacp --version 2>/dev/null | head -1)"; else bad "openacp not on PATH"; fi
if command -v claude >/dev/null; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
  if claude auth status >/dev/null 2>&1; then ok "claude authenticated (details not shown)"; else bad "claude not authenticated — run: claude auth login"; fi
else bad "claude not installed"; fi
command -v bwrap >/dev/null && command -v socat >/dev/null && ok "bubblewrap + socat (sandbox available)" || note "bubblewrap/socat missing — Claude Code bash sandbox disabled"

say "PiDev configuration"
if [[ -f "$PIDEV_HOME/.env" ]]; then
  m="$(stat -c '%a' "$PIDEV_HOME/.env")"; [[ "$m" == 600 ]] && ok ".env mode 600" || bad ".env mode $m (expected 600)"
  load_env
  pidev validate >/dev/null 2>&1 && ok "pidev validate" || { bad "pidev validate failed:"; pidev validate 2>&1 | sed 's/^/       /'; }
  pidev projects list >/dev/null 2>&1 && ok "project registry valid ($(pidev projects list 2>/dev/null | grep -c '^enabled') enabled)" || note "registry problems: run 'pidev projects list'"
else bad ".env missing — run scripts/configure.sh"; fi
for d in state logs; do m="$(stat -c '%a' "$PIDEV_HOME/$d" 2>/dev/null)"; [[ "$m" == 700 ]] && ok "$d/ mode 700" || note "$d/ mode ${m:-missing} (expected 700)"; done

say "OpenACP instance"
if [[ -n "${PIDEV_WORKSPACE_ROOT:-}" && -f "$PIDEV_WORKSPACE_ROOT/.openacp/config.json" ]]; then
  INST="$PIDEV_WORKSPACE_ROOT/.openacp"
  node -e 'const c=require(process.argv[1]); process.exit(c.workspace && c.workspace.allowExternalWorkspaces===false?0:1)' "$INST/config.json" && ok "allowExternalWorkspaces=false" || bad "allowExternalWorkspaces is not false — run scripts/post-onboard.sh"
  SEC="$INST/plugins/data/@openacp/security/settings.json"
  node -e 'const s=require(process.argv[1]); process.exit((s.allowedUserIds||[]).length>0?0:1)' "$SEC" 2>/dev/null && ok "OpenACP allowedUserIds non-empty" || bad "OpenACP allowedUserIds EMPTY (OpenACP would allow everyone) — run scripts/post-onboard.sh"
  grep -rq '@pidev/openacp-plugin' "$INST/plugins.json" "$INST/plugins" 2>/dev/null && ok "PiDev plugin registered" || bad "PiDev plugin not installed — run scripts/post-onboard.sh"
  "$(openacp_bin)" doctor --dry-run --dir "$PIDEV_WORKSPACE_ROOT" >/dev/null 2>&1 && ok "openacp doctor" || note "openacp doctor reports issues: openacp doctor --dry-run --dir \"$PIDEV_WORKSPACE_ROOT\""
else bad "OpenACP instance not initialised — openacp onboard --dir \"\$PIDEV_WORKSPACE_ROOT\""; fi

say "Claude Code managed policy"
POL=/etc/claude-code/managed-settings.d/50-pidev.json
if [[ -f "$POL" ]]; then
  [[ "$(stat -c '%U' "$POL")" == root ]] && ok "policy root-owned" || bad "policy not root-owned"
  SB=off; command -v bwrap >/dev/null && command -v socat >/dev/null && SB=on
  if diff -q <(pidev render claude-policy --sandbox "$SB" 2>/dev/null) "$POL" >/dev/null; then ok "policy up to date"; else note "policy differs from current render — re-run scripts/install-system.sh"; fi
else bad "managed policy missing — run scripts/install-system.sh"; fi

say "Service"
if systemctl list-unit-files --no-legend | awk '{print $1}' | grep -qx "$SERVICE_NAME"; then
  ok "$SERVICE_NAME installed ($(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null), $(systemctl is-active "$SERVICE_NAME" 2>/dev/null))"
  U="$(systemctl show -p User --value "$SERVICE_NAME")"; [[ -n "$U" && "$U" != root ]] && ok "service user $U" || bad "service user '${U:-root}'"
else note "$SERVICE_NAME not installed"; fi
N=$(pgrep -fc 'openacp.*(start|--daemon-child)' 2>/dev/null || echo 0)
(( N <= 1 )) && ok "OpenACP processes: $N" || bad "$N OpenACP processes — duplicate pollers on one bot token"
if command -v ss >/dev/null; then
  PUB=$(ss -ltnp 2>/dev/null | grep -E 'node|openacp' | awk '{print $4}' | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)
  [[ -z "$PUB" ]] && ok "no OpenACP/node port bound on a public interface" || bad "public listener(s): $PUB"
fi

echo
(( FAIL == 0 )) && say "Doctor: all required checks passed." || { say "Doctor: problems found (see FAIL above)."; exit 1; }
