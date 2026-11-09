# Security

PiDev lets a cloud AI model run commands and edit files on your Pi. Treat it as privileged remote access protected by several layers of defence. No single layer is a complete sandbox.

## Threat model

| Threat | Main controls |
|---|---|
| A stranger messages the bot | OpenACP ignores every chat except the configured `chatId`. OpenACP `allowedUserIds`. The PiDev plugin middleware is fail-closed and gives no reply. BotFather `/setjoingroups` disabled. |
| The bot token leaks | `.env` 0600, never on command lines, redacted in logs. OpenACP filters the agent's environment (the agent never sees `OPENACP_*`). Rotate in BotFather if leaked (see OPERATIONS). |
| The agent wanders outside the selected project | Registry and guard realpath checks. OpenACP `allowExternalWorkspaces=false`. Claude `blockReads/WritesOutsideWorkingDirectories`. systemd `ProtectSystem=strict` with a short `ReadWritePaths` list. |
| Prompt injection from repository content | Repo hooks disabled (`allowManagedHooksOnly`). Project MCP servers not auto-enabled. Writes to `.claude/`, `.git/` and `.mcp.json` denied. Install/commit/push/network always ask. The owner's policy is root-owned. |
| Secret exfiltration | Guard and managed deny rules for `.env*`, keys, `.ssh`, `.aws`, `.npmrc`, `.netrc`, Claude credentials and the OpenACP instance. systemd `InaccessiblePaths` for `~/.ssh`, `~/.aws`, `~/.gnupg`. Sandbox `denyRead`. Network tools need approval. |
| Privilege escalation | Non-root service user. `NoNewPrivileges`, empty capability set, `RestrictSUIDSGID`. Guard and managed policy deny `sudo`/`su`. No sudoers changes. |
| Permission bypass | `disableBypassPermissionsMode: "disable"` and `disableAutoMode: "disable"` in managed settings. The guard denies `--dangerously-skip-permissions`, `openacp …` and the OpenACP API port. |
| Destructive git or remote operations | Force-push, remote branch deletion and history rewrites are denied. Commit, push, reset, clean and stash ask. |
| Two sessions editing the same repo | Guard write lock per project. Max concurrent sessions defaults to 1. |
| Resource exhaustion | `MemoryMax=80%`, `TasksMax=512`, one session by default |

## Telegram

- **Owner identity:** numeric user IDs only, never usernames. Configured in `PIDEV_ALLOWED_USER_IDS`. An empty list means nobody: `pidev validate` fails and the service won't start (`ExecStartPre`).
- **Chat:** OpenACP requires a forum supergroup (verified: setup and doctor reject other chat types). It drops every update whose chat ID isn't the configured one; source: `this.bot.use(... if (chatId !== this.telegramConfig.chatId) return;)`. This also covers other groups, private chats, channels and inline queries.
  - **Deviation from the "private 1:1 chat" requirement.** PiDev uses a private supergroup that contains only you and the bot. Don't add anyone else. Anyone in the group can see the bot's output and press approval buttons. The buttons are not separately user-checked, which is why the group must stay owner-only.
- **Unauthorised users:** PiDev's middleware runs with priority 0 and drops their messages silently. OpenACP's own security plugin, if reached, replies with a generic "Access denied".
- **Polling:** OpenACP uses grammY long polling. No webhook is configured and no inbound port is opened.

## Service user

- Runs as the non-root account that owns `~/pidev-agent`. The **dedicated-account migration** below is recommended.
- systemd hardening is in [systemd/pidev-agent.service.in](../systemd/pidev-agent.service.in):
  - The whole filesystem is read-only, except the workspace root, PiDev's `state/` and `logs/`, `~/.claude`, `~/.openacp` and the npm/cache folders.
  - `~/.ssh`, `~/.aws` and `~/.gnupg` are inaccessible.
- `config/projects.json` and `.env` are read-only to the service, so the agent cannot register projects or change the allowlist.

### Migrating to a dedicated account (recommended)

Use this if your login user also owns other projects or SSH keys:

1. `sudo adduser --disabled-password pidev`
2. Copy the PiDev source (not secrets) into `/home/pidev/pidev-agent`.
3. As `pidev`, run `install.sh` and `configure.sh`, then `claude auth login` (a **new** login; never copy `~/.claude/.credentials.json`), then `openacp onboard`, `post-onboard.sh` and `install-system.sh`.
4. Move or clone the projects into `/home/pidev/projects`.
5. Stop and disable the old service.

## Workspace boundary

- Only folders in `config/projects.json` count. Each entry is realpath'd and must lie inside `PIDEV_WORKSPACE_ROOT`.
- Rejected entries: entries that equal the root, are nested inside another project, sit inside the PiDev app folder (unless `allowPidevSelf`), or contain `.openacp`, `.ssh` or `.claude`.
- A symlink that resolves outside the root is rejected unless you set `allowExternalTarget: true` **and** `canonicalPath` to the exact target.
- For every tool call, the guard resolves the target's realpath (including not-yet-existing files, via the deepest existing parent) and requires it to be inside the session's project.

## Secrets

- Pi-only: `.env` (0600, written by `configure.sh` with `read -s`), the OpenACP instance folder (0700), and the Claude login in `~/.claude`.
- The Mac repo never holds production secrets. `deploy.sh` excludes `.env*` (apart from `.env.example`), state, logs, backups, `config/projects.json` and keys.
- `bin/pidev.js` output, the guard audit log and `scripts/status.sh` log excerpts all pass through `src/redact.js`.

## Approval policy

See [the README table](../README.md#approvals). Sources:
- managed rules: `src/policy.js`
- guard rules: `SHELL_DENY` and `SHELL_ASK` in `src/guard.js`

The guard never *grants* permission. It only denies, asks, or defers to Claude Code.

## Known limitations

1. **Shell pattern matching is best-effort.** A determined model could hide a command, for example through an interpreter one-liner or encoded strings. Without the bubblewrap sandbox, Bash commands can write anywhere the service user can, within systemd's `ReadWritePaths` (which include the whole workspace root, so other projects too). Install `bubblewrap` and `socat` so the policy is rendered with `sandbox.enabled=true` and `failIfUnavailable=true`. Sandbox support on Linux arm64 is not stated in Anthropic's docs: verify it on your Pi with `/sandbox` or the doctor.
2. **Approval buttons are visible to the whole group.** Keep the group owner-only.
3. **OpenACP state contains the bot token** (`<root>/.openacp/plugins/data/@openacp/telegram/settings.json`, because OpenACP persists env overrides). The instance sits inside the workspace root, which is the price of `allowExternalWorkspaces=false`. Access from the agent is blocked by managed deny rules, the guard (`.openacp` segment), sandbox `denyRead`, and the guard ban on `openacp`.
4. **The guard is Claude-specific.** Switching OpenACP to another agent removes the hook layer.
5. **Untested on real hardware** until you complete the steps in [IMPLEMENTATION-STATUS](IMPLEMENTATION-STATUS.md).
6. **Unverified managed-settings keys.** `allowManagedHooksOnly` and `enableAllProjectMcpServers` come from the Claude Code settings reference, but the doc pages fetched during development were truncated. After installing, run `/status` in a Claude session on the Pi and check that "Enterprise managed settings (file)" is listed. Then check that a repo-local hook does not run.
7. **The agent can read non-secret files of the service user** that are inside the workspace root. Keep unrelated material out of it.
