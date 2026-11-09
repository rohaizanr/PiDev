# Implementation status

Last updated: 2026-11-10. ✅ = done and verified · 🟡 = implemented, not yet verified on the Pi · ⬜ = owner action pending.

## Discovery

- ✅ Code was written and unit-tested on a development machine (macOS arm64, Node 22). That machine is **not** needed to install or run PiDev.
- ✅ **No Pi facts are verified yet.** No Raspberry Pi has been inspected; `scripts/preflight.sh` checks the hardware and OS at install time.
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

## Built

- ✅ Project structure, `.gitignore`, `.env.example`, config examples
- ✅ `src/` modules: config validation (fail closed), auth policy, registry (realpath, traversal/symlink/nesting checks), guard policy, file-based write locks, redaction, managed-policy renderer, OpenACP lock-down
- ✅ `bin/pidev.js` CLI and `bin/pidev-guard.js` hook (exit 2 on deny, `ask` JSON, audit log)
- ✅ `plugin/`: OpenACP plugin (`/projects`, `/project`, `/where`, `/pidev`, fail-closed middleware)
- ✅ Scripts (all run on the Pi): setup (guided, resumable), preflight, install, configure, post-onboard, install-system, start, stop, status, doctor, backup, update
- ✅ systemd unit template with hardening
- ✅ Docs: README, ARCHITECTURE, SECURITY, INSTALLATION, OPERATIONS, TROUBLESHOOTING
- ✅ `npm run check`: lint (syntax for all JS + `bash -n` for all scripts + a secret scan of committed files) and tests passing on the development machine. This covers the 10 required cases plus the guard process, plugin, policy, OpenACP lock-down and providers.

## LLM provider selection (added 2026-11-10)

- ✅ `.env`: `LLM_PROVIDER` (claude|openai|gemini), `LLM_MODEL`, `LLM_API_KEY`, `PIDEV_ALLOW_UNGUARDED_PROVIDER`
- ✅ `src/providers.js` maps provider → OpenACP agent `claude` / `codex` / `gemini`. Verified in OpenACP 2026.518.2: `REGISTRY_AGENT_ALIASES`, `AGENT_SETUP` key env names, a linux-aarch64 `codex-acp` binary, Gemini via `npx @google/gemini-cli --acp`.
- ✅ **Claude API key:** `apiKeyHelper` → `bin/pidev-apikey.js`, rendered into the managed policy. The key is never in the agent's environment.
- ✅ **openai/gemini:** key and model written to `<instance>/agents.json` `installed.<agent>.env` (agent store schema verified), with PiDev-managed variables removed from non-selected agents.
- ✅ Fail-closed: openai/gemini refused unless `PIDEV_ALLOW_UNGUARDED_PROVIDER=true`. Warnings in `/project`, `/pidev` and `doctor.sh`.
- ✅ Guard additions: denies `pidev-apikey`/`pidev-guard`, `$…_API_KEY` expansion, `/proc/*/environ`; secret paths `~/.codex`, `~/.gemini`, `agents.json`, `oauth_creds.json`. Managed policy denies `Read(//proc/**)`.
- ✅ Redaction for OpenAI (`sk-…`, `sk-proj-…`) and Google (`AIza…`) keys
- ✅ Scripts: `configure.sh` (provider menu, silent key), `post-onboard.sh` (installs the matching agent and Codex CLI), `doctor.sh` (per-provider auth checks)
- ✅ 11 new tests; **44/44 passing**, lint OK
- ⬜ Pi: Claude Code honours `apiKeyHelper` when launched by `claude-agent-acp` (check that a session works with `LLM_API_KEY` set and no `claude auth login`)
- ⬜ Pi: Codex picks up `OPENAI_API_KEY` from agent env; Gemini picks up `GEMINI_API_KEY`/`GEMINI_MODEL`
- ⬜ Pi: how Codex and Gemini surface approval requests over ACP (unverified)
- ⬜ Future: guard-equivalent policies for Codex (sandbox/approval config) and Gemini CLI, which would remove the "unguarded" status

## Pi-only setup (added 2026-11-10)

- ✅ No second computer needed. `deploy.sh` and `remote-inspect.sh` were removed; the code is obtained with `git clone` on the Pi (tarball/USB as a fallback).
- ✅ `scripts/setup.sh`: guided, resumable installer (`--status`, `--step`, `--from`, `--reset`). Progress is kept in `state/setup-progress`.
- ✅ `scripts/preflight.sh`: local read-only checks (64-bit, RAM/swap/disk, Node, git, bubblewrap, sudo, outbound HTTPS, conflicts). Reused by `install.sh`.
- ✅ `scripts/update.sh`: backup → `git merge --ff-only` → `npm run check` (rolls back on failure) → re-apply → re-render system files if changed → restart. Refuses to run with local modifications.
- ✅ Lint secret scan skips the real `.env`, so `npm run check` works on a configured Pi (verified with a fake token).
- ✅ Docs rewritten as a single-machine flow (README, INSTALLATION, OPERATIONS, SECURITY, TROUBLESHOOTING); Mac-only settings removed from `.env.example`.
- ⬜ Host the repository (e.g. a private GitHub repo) so `git clone` works on the Pi
- 🟡 `setup.sh`, `preflight.sh` and `update.sh` have passed `bash -n` and review, but have not been run on a Pi

## Pi (not performed yet)

- ⬜ Flash Raspberry Pi OS (64-bit), install base packages + Node 22, `git clone`, `scripts/setup.sh`
- 🟡 `scripts/install.sh` (platform checks, OpenACP, Claude Code)
- ⬜ BotFather bot, private forum group, `/setjoingroups` disabled
- 🟡 `scripts/configure.sh`
- ⬜ Model auth on the Pi: `LLM_API_KEY`, or `claude auth login` / `codex` / Gemini sign-in
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
- **`/new <name>` and `/clone`:** not implemented. Create or clone the folder in a shell on the Pi, then `pidev projects add`. OpenACP's native `/new <name>` creates an *unregistered* folder, where the guard blocks all tools.
- **`/project`:** replies with the native `/new claude <path>` command instead of creating the session itself, to avoid depending on undocumented OpenACP internals.
- **`/start`:** handled natively by OpenACP if at all; PiDev's help is `/pidev`.
- **Dedicated service account:** documented as the recommended migration. The initial setup uses the account that owns `~/pidev-agent`.
