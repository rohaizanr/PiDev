# Implementation status

Last updated: 2026-11-09. ✅ = done and verified · 🟡 = implemented, not yet verified on the Pi · ⬜ = owner action pending.

## Discovery

- ✅ **Mac:** macOS 26.6.2, arm64 (Mac15,7), Node 22.23.4, npm 10.9.9, git 2.54.0. About 30 GB disk free. No `claude` CLI on PATH (Claude Code runs as the VS Code extension). OpenACP not installed, and deliberately not installed here.
- ✅ **SSH:** `~/.ssh/config` has one host, `192.168.0.252` (user `mjsr`). The connection **timed out** and the host isn't confirmed to be the Pi. **No Pi facts are verified.**
- ✅ **OpenACP 2026.518.2** (npm, Node ≥ 20, AGPL-3.0). Its source was inspected from the package tarball without installing it. Findings:
  - Telegram needs a forum supergroup, and updates from other chats are dropped.
  - Empty `allowedUserIds` means everyone is allowed.
  - `workspace.allowExternalWorkspaces` defaults to true and its check isn't realpath-based.
  - Plugin API: `registerCommand`, plus `registerMiddleware('message:incoming')` where returning `null` blocks.
  - The agent's environment is filtered.
  - There's a local API on 127.0.0.1:21420 with a bypass toggle.
- ✅ **`claude-agent-acp` 0.101.0** (tarball inspected): loads `user`, `project` and `local` settings plus managed settings, and honours `disableBypassPermissionsMode`.
- ✅ **Claude Code docs:**
  - x64/ARM64 only, with a linux-arm64 build; no 32-bit ARM.
  - Native installer recommended; the npm package needs Node 22+.
  - Linux managed settings path is `/etc/claude-code/managed-settings.json` plus `managed-settings.d/`.
  - The Linux sandbox needs bubblewrap and socat.

## Built (Mac)

- ✅ Project structure, `.gitignore`, `.env.example`, config examples
- ✅ `src/` modules: config validation (fail closed), auth policy, registry (realpath, traversal/symlink/nesting checks), guard policy, file-based write locks, redaction, managed-policy renderer, OpenACP lock-down
- ✅ `bin/pidev.js` CLI and `bin/pidev-guard.js` hook (exit 2 on deny, `ask` JSON, audit log)
- ✅ `plugin/`: OpenACP plugin (`/projects`, `/project`, `/where`, `/pidev`, fail-closed middleware)
- ✅ Scripts:
  - [PI]: install, configure, post-onboard, install-system, start, stop, status, doctor, backup
  - [MAC]: deploy (dry-run default, no `--delete`), remote-inspect
- ✅ systemd unit template with hardening
- ✅ Docs: README, ARCHITECTURE, SECURITY, INSTALLATION, OPERATIONS, TROUBLESHOOTING
- ✅ `npm run check` on the Mac: lint (syntax for all JS + `bash -n` for all scripts + secret scan) and **33/33 tests passing**. This covers the 10 required cases plus the guard process, plugin, policy and OpenACP lock-down.
- ✅ The deploy exclude list was verified with a local rsync dry run: `.env`, `state/`, `logs/` and `config/projects.json` are not copied.

## Pi (not performed: Pi unreachable)

- ⬜ Configure an SSH alias for the Pi and run `scripts/remote-inspect.sh`
- 🟡 `scripts/install.sh` (platform checks, OpenACP, Claude Code)
- ⬜ BotFather bot, private forum group, `/setjoingroups` disabled
- 🟡 `scripts/configure.sh`
- ⬜ `claude auth login` on the Pi
- ⬜ `openacp onboard --dir $PIDEV_WORKSPACE_ROOT` (check that `--dir` is honoured)
- 🟡 `scripts/post-onboard.sh`: lock-down, `agents install claude`, `plugin add`. The plugin has only been tested against a mock context, not inside a real OpenACP.
- 🟡 `scripts/install-system.sh`: managed policy + unit (`systemd-analyze verify`)
- ⬜ Claude `/status` shows managed settings. Bypass mode is unavailable. A repo-local hook does **not** run (`allowManagedHooksOnly`).
- ⬜ Sandbox works under systemd on arm64 (`failIfUnavailable=true`)
- ⬜ Foreground smoke test: `/pidev`, `/projects`, `/project`, `/new`, inspect, edit + test + diff, `npm install` approval, secret read blocked
- ⬜ Non-allowlisted account ignored (needs a second Telegram account; otherwise record as **not tested**)
- ⬜ `scripts/start.sh --enable`, controlled restart, and optionally a reboot test
- ⬜ `scripts/doctor.sh` all green

## Not in scope / deviations

- **Private 1:1 chat:** not possible with OpenACP. A private owner-only forum supergroup is used instead (see SECURITY.md).
- **`/new <name>` and `/clone`:** not implemented. Create or clone over SSH, then `pidev projects add`. OpenACP's native `/new <name>` creates an *unregistered* folder, where the guard blocks all tools.
- **`/project`:** replies with the native `/new claude <path>` command instead of creating the session itself, to avoid depending on undocumented OpenACP internals.
- **`/start`:** handled natively by OpenACP if at all; PiDev's help is `/pidev`.
- **Dedicated service account:** documented as the recommended migration. The initial setup uses the account that owns `~/pidev-agent`.
