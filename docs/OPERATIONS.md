# Operations

All commands run on the Raspberry Pi from `~/pidev-agent`.

## Service lifecycle

| Task | Command |
|---|---|
| Start / stop | `scripts/start.sh` · `scripts/stop.sh` |
| Restart | `sudo systemctl restart pidev-agent` |
| Enable at boot / disable | `scripts/start.sh --enable` · `scripts/stop.sh --disable` |
| Foreground debug run | `scripts/stop.sh && scripts/start.sh --foreground` |
| Status, guard decisions, redacted logs | `scripts/status.sh [lines]` |
| Full diagnostics | `scripts/doctor.sh` |
| Follow logs | `journalctl -u pidev-agent -f \| bin/pidev.js redact` |

Behaviour:
- systemd restarts the service on failure after 10 s, at most 10 times in 10 minutes. Stopping sends SIGTERM and allows 30 s.
- `ExecStartPre` runs `pidev validate`, so an invalid or fail-open configuration never starts.
- Network loss: grammY long polling retries on its own. If OpenACP exits, systemd restarts it.
- Only the systemd unit runs OpenACP (`runMode=foreground`, `autoStart=false`). `start.sh --foreground` refuses to run while the service is active, which prevents duplicate pollers.

## Health checks

- `/pidev` in Telegram shows config validity, the project count and the session limit.
- `bin/pidev.js status [--json]` shows config (redacted), projects and write locks.
- `openacp status --dir "$PIDEV_WORKSPACE_ROOT"` and `openacp api health --dir …` show OpenACP's view.

## Logs and retention

| Log | Where | Retention |
|---|---|---|
| Service stdout/stderr | journald (`pidev-agent`) | system journald policy, e.g. set `SystemMaxUse=200M` in `/etc/systemd/journald.conf` |
| OpenACP | `<root>/.openacp/logs/` | OpenACP `logging.maxFiles` (7) / `maxFileSize` (10m); session logs 30 days |
| Guard audit | `logs/guard.log` | rotated at 1 MB (keeps one `.1`). Deny/ask events only, redacted, commands truncated to 200 chars |

Full prompts and source code are not logged by PiDev.

## Projects

| Task | Command |
|---|---|
| Add | `bin/pidev.js projects add <name> <abs-path> [--description …] [--trusted]` (the folder must exist inside the root) |
| List / check | `bin/pidev.js projects list` · `bin/pidev.js projects check <name>` |
| Disable | edit `config/projects.json` and set `"enabled": false` (takes effect on the next tool call) |
| Remove | delete the entry from `config/projects.json`. The folder itself is never touched |

Write locks:
- See them with `bin/pidev.js locks`.
- Release a stuck lock with `bin/pidev.js locks --release <session-id>`, or wait for `PIDEV_LOCK_TTL_MINUTES`.

## Backup and restore

```bash
scripts/backup.sh     # -> backups/pidev-<stamp>.tar.gz (0600)
```

The archive contains `.env`, the registry, state, the OpenACP instance, the unit and the policy. **It contains secrets.**

To restore:

```bash
scripts/stop.sh
tar -xzf backups/pidev-<stamp>.tar.gz -C /
```

Then check ownership, run `scripts/doctor.sh` and start the service.

## Updates

**PiDev source (git clone)**

```bash
scripts/update.sh --check     # is there an update?
scripts/update.sh             # shows incoming commits, asks, then updates
```

`update.sh` runs these steps:
1. Refuses to run if tracked files have local changes.
2. Backs up.
3. `git merge --ff-only` from the upstream.
4. Runs `npm run check`, rolling back to the previous commit if it fails.
5. Re-applies the OpenACP lock-down.
6. Re-runs `install-system.sh` if the policy or unit template changed (it shows a diff first).
7. Restarts the service.

Then run `scripts/doctor.sh`.

**PiDev source (copied folder, no git):** run `scripts/backup.sh`, replace the code files but keep `.env`, `config/projects.json`, `state/`, `logs/` and `backups/`, then:

```bash
npm run check && scripts/post-onboard.sh && scripts/install-system.sh && sudo systemctl restart pidev-agent
```

**OpenACP**
1. `scripts/backup.sh`, then `openacp update` (or `npm install -g @openacp/cli@latest`).
2. Then `scripts/post-onboard.sh`. It re-checks the source markers PiDev depends on and re-applies the lock-down.
3. Read the OpenACP changelog for changes to the security, workspace or plugin APIs.

**Claude Code**
- The native install auto-updates. npm installs need `npm update -g @anthropic-ai/claude-code`.
- After a major update, run `scripts/doctor.sh` and repeat the smoke test.

## Changing LLM provider, model or key

```bash
scripts/configure.sh          # choose provider / model / key (key read silently; "-" removes it)
scripts/post-onboard.sh       # installs the agent, sets defaultAgent, writes agents.json env
scripts/install-system.sh     # re-renders the managed policy (apiKeyHelper / model for claude)
sudo systemctl restart pidev-agent
bin/pidev.js provider && scripts/doctor.sh
```

Effects:
- Existing sessions keep the agent they were started with. Start new ones with `/project <name>`.
- After switching away from openai/gemini or rotating their key, delete stale backups that may hold the old key: `rm "$PIDEV_WORKSPACE_ROOT"/.openacp/agents.json.bak-*`.

## Rotating secrets

- **Bot token:** in @BotFather, run `/revoke`, then `scripts/configure.sh` (enter the new token), then `sudo systemctl restart pidev-agent`. OpenACP persists the env override into its plugin settings on start.
- **Claude login:** `claude auth logout && claude auth login`.
- **LLM API key:** revoke it in the vendor console, then `scripts/configure.sh`.
  - claude: Claude Code re-runs the helper from time to time (its output is cached), so restart the service to apply the new key at once. No re-render is needed.
  - openai/gemini: also run `scripts/post-onboard.sh`, delete `agents.json.bak-*`, and restart.
- **Owner IDs:** `scripts/configure.sh`, then `scripts/post-onboard.sh` (re-applies `allowedUserIds`), then restart.
