#!/usr/bin/env bash
# [MAC] Copy PiDev source to the Pi with rsync. DRY RUN by default.
#   scripts/deploy.sh            show what would be copied (no changes)
#   scripts/deploy.sh --apply    copy for real
# Never uses --delete. Never copies .env, secrets, state, logs, backups,
# node_modules or OpenACP data. Native deps are installed on the Pi, not here.
source "$(dirname "$0")/lib.sh"
require_mac_host

HOST="${PIDEV_PI_SSH_HOST:-}"
DEST_DIR="${PIDEV_PI_APP_DIR:-pidev-agent}"
[[ -n "$HOST" ]] || die "Set PIDEV_PI_SSH_HOST to an SSH host alias from ~/.ssh/config (e.g. PIDEV_PI_SSH_HOST=pidev-pi scripts/deploy.sh)."
[[ "$DEST_DIR" != "/" && "$DEST_DIR" != "" && "$DEST_DIR" != "~" ]] || die "Refusing unsafe destination '$DEST_DIR'."

say "Running local checks first"
(cd "$PIDEV_HOME" && npm run --silent check) || die "Local checks failed; not deploying."

say "Checking SSH reachability of '$HOST' (BatchMode, no password prompts)"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true || die "Cannot reach '$HOST' over SSH. Configure ~/.ssh/config and key auth, then retry."
REMOTE_INFO="$(ssh -o BatchMode=yes "$HOST" 'echo "$(id -un)|$HOME|$(uname -sm)"')"
IFS='|' read -r R_USER R_HOME R_SYS <<<"$REMOTE_INFO"
[[ "$R_USER" != root ]] || die "Remote user is root. Use the non-root service account."
[[ "$DEST_DIR" = /* ]] && R_DEST="$DEST_DIR" || R_DEST="$R_HOME/$DEST_DIR"
say "Destination: $R_USER@$HOST:$R_DEST  ($R_SYS)"

EXCLUDES=(--include '.env.example' --exclude '.git/' --exclude '.env' --exclude '.env.*'
  --exclude '/state/' --exclude '/logs/' --exclude '/backups/' --exclude 'node_modules/'
  --exclude '.openacp/' --exclude '/config/projects.json' --exclude '/config/pidev.json'
  --exclude '*.pem' --exclude '*.key' --exclude 'id_*' --exclude '.DS_Store' --exclude '.vscode/' --exclude '.claude/')

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

if (( APPLY )); then
  ssh -o BatchMode=yes "$HOST" "test -d '$R_DEST'" && {
    say "Existing installation found — backing it up on the Pi first"
    ssh -o BatchMode=yes "$HOST" "cd '$R_DEST' && if [ -x scripts/backup.sh ] && [ -f .env ]; then scripts/backup.sh; else tar -czf \"\$HOME/pidev-agent-src-\$(date +%Y%m%d%H%M%S).tar.gz\" --exclude=.env --exclude=state --exclude=logs --exclude=backups . ; fi" || die "Remote backup failed; not deploying."
  }
  confirm "Copy to $R_USER@$HOST:$R_DEST now?" || die "Aborted."
fi

DRY=--dry-run; (( APPLY )) && DRY=--itemize-changes
rsync -az --itemize-changes "$DRY" "${EXCLUDES[@]}" "$PIDEV_HOME/" "$HOST:$R_DEST/"

if (( ! APPLY )); then
  say "Dry run only. Re-run with --apply to copy."
else
  say "Copied. On the Pi:  cd '$R_DEST' && npm test && scripts/doctor.sh"
  say "If the service is running, restart it to pick up changes: scripts/stop.sh && scripts/start.sh"
fi
