#!/usr/bin/env bash
# Update PiDev in place on the Raspberry Pi from its git remote.
#   scripts/update.sh            fetch, show incoming commits, ask, then update
#   scripts/update.sh --check    only show whether an update is available
# Steps: backup -> git pull --ff-only -> npm run check -> re-apply OpenACP settings
#        -> re-render system files if changed -> restart the service.
# Never discards local changes: refuses to run with a dirty working tree.
source "$(dirname "$0")/lib.sh"
require_pi_host
require_not_root
cd "$PIDEV_HOME"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$PIDEV_HOME is not a git clone. Install with 'git clone' (docs/INSTALLATION.md) to use update.sh."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || die "Branch '$BRANCH' has no upstream. Set one: git branch --set-upstream-to origin/$BRANCH"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  git status --short --untracked-files=no
  die "Local modifications to tracked files. Commit or stash them yourself first; update.sh never discards changes."
fi

say "Fetching $UPSTREAM"
git fetch --quiet
BEHIND="$(git rev-list --count "HEAD..$UPSTREAM")"
AHEAD="$(git rev-list --count "$UPSTREAM..HEAD")"
if (( BEHIND == 0 )); then say "Already up to date ($(git rev-parse --short HEAD))."; exit 0; fi
(( AHEAD == 0 )) || die "Local branch has $AHEAD commit(s) not on $UPSTREAM; resolve manually (no automatic merge/rebase)."
say "$BEHIND new commit(s):"
git log --oneline "HEAD..$UPSTREAM" | head -30
[[ "${1:-}" == "--check" ]] && exit 0

CHANGED="$(git diff --name-only "HEAD..$UPSTREAM")"
echo "$CHANGED" | sed 's/^/  changed: /' | head -40
confirm "Update to $(git rev-parse --short "$UPSTREAM")?" || die "Aborted."

if [[ -f .env ]]; then "$PIDEV_HOME/scripts/backup.sh"; fi
OLD="$(git rev-parse HEAD)"
git merge --ff-only --quiet "$UPSTREAM"
say "Now at $(git rev-parse --short HEAD)"

if ! npm run --silent check; then
  warn "Checks failed on the new version. Rolling back to $(git rev-parse --short "$OLD")."
  git reset --quiet --hard "$OLD"   # safe: tree was clean before the update
  die "Update aborted; previous version restored. Report the failing check."
fi

if [[ -f .env && -n "$(env_get PIDEV_WORKSPACE_ROOT)" && -f "$(env_get PIDEV_WORKSPACE_ROOT)/.openacp/config.json" ]]; then
  load_env
  say "Re-applying OpenACP lock-down"
  pidev apply openacp
fi

if echo "$CHANGED" | grep -qE '^(src/policy\.js|src/providers\.js|systemd/|scripts/install-system\.sh)'; then
  warn "Policy or service template changed — re-rendering system files (sudo, shows a diff first)."
  "$PIDEV_HOME/scripts/install-system.sh"
fi
if echo "$CHANGED" | grep -q '^plugin/'; then
  say "Plugin changed — the restart below normally picks it up; if /pidev shows old behaviour, re-run scripts/post-onboard.sh."
fi

if systemctl is-active --quiet "$SERVICE_NAME"; then
  say "Restarting $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  sleep 3
  systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
fi
say "Update complete. Run scripts/doctor.sh to confirm."
