#!/usr/bin/env bash
# Guided PiDev installation, run entirely on the Raspberry Pi.
#
#   scripts/setup.sh                 run every step that is not done yet (asks before each)
#   scripts/setup.sh --status        show which steps are done
#   scripts/setup.sh --step <name>   run (or re-run) a single step
#   scripts/setup.sh --from <name>   run from <name> onward, even if already done
#   scripts/setup.sh --reset         forget progress (changes nothing else)
#
# Progress is recorded in state/setup-progress, so you can stop at any point
# (Ctrl-C or "q") and resume later. Each step is also a standalone script.
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root

STEPS=(preflight check install configure onboard post-onboard auth project system smoke enable)
declare -A DESC=(
  [preflight]="Check hardware, 64-bit OS, Node.js, git, network, conflicts (read-only)"
  [check]="Run PiDev's own lint + tests on this Pi (npm run check)"
  [install]="Install OpenACP and Claude Code for $(id -un) (no sudo)"
  [configure]="Enter bot token, group ID, your Telegram ID, workspace, LLM provider/model/key"
  [onboard]="OpenACP onboarding wizard (Telegram + agent) for the workspace"
  [post-onboard]="Lock down OpenACP, install the coding agent and the PiDev plugin"
  [auth]="Log the coding agent in (skipped when LLM_API_KEY is set)"
  [project]="Register your first project(s) (optionally create a disposable test repo)"
  [system]="sudo: install the root-owned Claude policy + systemd unit (not enabled)"
  [smoke]="Foreground test from Telegram (/pidev, /projects, /project, a small task)"
  [enable]="Enable and start pidev-agent at boot, then run the doctor"
)

PROGRESS="$PIDEV_HOME/state/setup-progress"
mkdir -p "$PIDEV_HOME/state"; chmod 700 "$PIDEV_HOME/state"
touch "$PROGRESS"; chmod 600 "$PROGRESS"

is_done()   { grep -qx "$1" <(cut -d' ' -f1 "$PROGRESS"); }
mark_done() { grep -v "^$1 " "$PROGRESS" > "$PROGRESS.tmp" || true; echo "$1 $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$PROGRESS.tmp"; mv "$PROGRESS.tmp" "$PROGRESS"; }
valid_step() { local s; for s in "${STEPS[@]}"; do [[ "$s" == "$1" ]] && return 0; done; return 1; }
root() { env_get PIDEV_WORKSPACE_ROOT; }

show_status() {
  say "PiDev setup progress ($PIDEV_HOME)"
  local i=1 s
  for s in "${STEPS[@]}"; do
    if is_done "$s"; then printf '  %2d. \033[32m✔\033[0m %-13s %s\n' $i "$s" "$(grep "^$s " "$PROGRESS" | cut -d' ' -f2)"
    else printf '  %2d. \033[2m·\033[0m %-13s %s\n' $i "$s" "${DESC[$s]}"; fi
    i=$((i+1))
  done
}

# ---------------------------------------------------------------------------
step_preflight() { "$PIDEV_HOME/scripts/preflight.sh"; }

step_check() { (cd "$PIDEV_HOME" && npm run --silent check); }

step_install() { "$PIDEV_HOME/scripts/install.sh"; }

step_configure() { "$PIDEV_HOME/scripts/configure.sh"; }

step_onboard() {
  local r; r="$(root)"; [[ -n "$r" ]] || die "Run the configure step first."
  if [[ -f "$r/.openacp/config.json" ]]; then
    say "An OpenACP instance already exists at $r/.openacp."
    confirm "Re-run the OpenACP onboarding wizard anyway?" || return 0
  fi
  cat <<EOF
In the OpenACP wizard:
  • Channel: Telegram — use the SAME bot token and your private forum group
  • Agent: claude (post-onboard installs/selects the one matching LLM_PROVIDER)
  • Auto-start: NO (systemd handles it)    • Tunnel: NO
EOF
  confirm "Start the wizard now?" || return 1
  openacp onboard --dir "$r"
}

step_post-onboard() { "$PIDEV_HOME/scripts/post-onboard.sh"; }

step_auth() {
  local prov key r; prov="$(env_get LLM_PROVIDER)"; prov="${prov:-claude}"; key="$(env_get LLM_API_KEY)"; r="$(root)"
  if [[ -n "$key" ]]; then
    say "LLM_API_KEY is set for $prov — no interactive login needed."
    [[ "$prov" == claude ]] && { node "$PIDEV_HOME/bin/pidev-apikey.js" >/dev/null && say "Key helper OK (key not shown)." || die "bin/pidev-apikey.js failed; re-run the configure step."; }
    return 0
  fi
  echo "On a headless Pi: copy the login URL shown, open it on your phone or any browser, then paste the code back here."
  case "$prov" in
    claude)
      if claude auth status >/dev/null 2>&1; then say "Claude Code is already logged in."; return 0; fi
      claude auth login && claude auth status >/dev/null;;
    openai) confirm "Run 'codex' now and choose \"Sign in with ChatGPT\" (exit Codex afterwards)?" && codex;;
    gemini) confirm "Run the Gemini CLI login now (choose \"Sign in with Google\", then exit)?" && openacp agents run gemini --dir "$r";;
    *) die "Unknown LLM_PROVIDER '$prov'";;
  esac
}

step_project() {
  local r; r="$(root)"; [[ -n "$r" ]] || die "Run the configure step first."
  pidev projects list 2>/dev/null || true
  if confirm "Create a disposable test repo $r/pidev-sandbox (git init + package.json with a passing test) and register it?"; then
    if [[ -e "$r/pidev-sandbox" ]]; then warn "$r/pidev-sandbox already exists — not touching it."
    else
      mkdir -p "$r/pidev-sandbox"
      ( cd "$r/pidev-sandbox" && git init -q && npm init -y >/dev/null && npm pkg set scripts.test="echo ok" && printf '# pidev sandbox\nDisposable repo for PiDev smoke tests.\n' > README.md )
    fi
    pidev projects check pidev-sandbox >/dev/null 2>&1 || pidev projects add pidev-sandbox "$r/pidev-sandbox" --description "Disposable test repo" --trusted
  fi
  local name dir
  echo "Existing folders in $r that are not registered:"
  for dir in "$r"/*/; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    pidev projects list 2>/dev/null | grep -q " ${dir%/}\( \|$\)" && continue
    echo "  - $name"
  done
  while confirm "Register another existing project folder?"; do
    read -r -p "  Project name (lowercase, a-z 0-9 - _): " name
    read -r -p "  Absolute path [$r/$name]: " dir
    dir="${dir:-$r/$name}"
    pidev projects add "$name" "$dir" || warn "Not registered (see message above)."
  done
  pidev projects list
}

step_system() { "$PIDEV_HOME/scripts/install-system.sh"; }

step_smoke() {
  cat <<'EOF'
Foreground smoke test. When "PiDev plugin ready" appears in the log, in your Telegram group send:
  1. /pidev                       -> help + "Health: config OK"
  2. /projects                    -> your projects
  3. /project pidev-sandbox       -> a "/new <agent> <path>" command; send it
  4. In the new topic: "Show git status, create hello.txt containing hi, run npm test and show the diff"
  5. "Run npm install"            -> approval buttons appear (claude provider)
  6. "Print the contents of ~/.ssh/config"  -> refused
Press Ctrl-C here when done.
EOF
  confirm "Start the foreground test now?" || return 1
  trap 'echo; say "Foreground test stopped."' INT
  "$PIDEV_HOME/scripts/start.sh" --foreground || true
  trap - INT
  confirm "Did all the checks above behave as expected?" || { warn "See docs/TROUBLESHOOTING.md, fix, then: scripts/setup.sh --step smoke"; return 1; }
}

step_enable() {
  "$PIDEV_HOME/scripts/start.sh" --enable
  "$PIDEV_HOME/scripts/doctor.sh" || warn "Doctor reported problems (see above)."
}

run_step() {
  local s="$1"
  echo
  say "Step: $s — ${DESC[$s]}"
  if "step_$s"; then mark_done "$s"; say "✔ $s done"; return 0; fi
  warn "Step '$s' did not complete. Fix the issue and resume with: scripts/setup.sh"
  return 1
}

# ---------------------------------------------------------------------------
case "${1:-}" in
  --status) show_status; exit 0;;
  --reset)  confirm "Forget setup progress? (nothing else is changed)" && : > "$PROGRESS"; show_status; exit 0;;
  --step)   valid_step "${2:-}" || die "Unknown step '${2:-}'. Steps: ${STEPS[*]}"; run_step "$2"; exit $?;;
  --from)   valid_step "${2:-}" || die "Unknown step '${2:-}'. Steps: ${STEPS[*]}"; FROM="$2";;
  "") FROM="";;
  -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
  *) die "Unknown option $1 (see --help)";;
esac

show_status
started=0
for s in "${STEPS[@]}"; do
  [[ -n "$FROM" && "$s" == "$FROM" ]] && started=1
  if [[ -n "$FROM" ]]; then (( started )) || continue
  elif is_done "$s"; then continue; fi
  echo
  read -r -p "Next: $s — ${DESC[$s]}. [R]un / [s]kip / [q]uit? " ans
  case "${ans:-r}" in
    r|R) run_step "$s" || exit 1;;
    s|S) warn "Skipped $s (run later with: scripts/setup.sh --step $s)";;
    *) say "Stopped. Resume any time with: scripts/setup.sh"; exit 0;;
  esac
done
echo
show_status
say "Setup finished. Daily use: README.md → 'Using it in Telegram'. Operations: docs/OPERATIONS.md"
