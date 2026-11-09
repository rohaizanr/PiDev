# Architecture

## Components

| Component | Role | Owner |
|---|---|---|
| Telegram private forum supergroup | Your UI. One topic per agent session. | You |
| OpenACP (`@openacp/cli`) | Telegram adapter (grammY, long polling), sessions, streaming, permission buttons, ACP client | Upstream |
| `claude` ACP agent (`@agentclientprotocol/claude-agent-acp`) | Runs Claude Code through the Claude Agent SDK. Loads user, project, local and **managed** settings. | Upstream |
| Claude Code managed policy `/etc/claude-code/managed-settings.d/50-pidev.json` | Root-owned permission rules: bypass disabled, guard hook, sandbox | PiDev (rendered by `src/policy.js`) |
| `bin/pidev-guard.js` (+ `src/guard.js`) | `PreToolUse`/`SessionEnd` hook. Enforces the registry boundary, secret denies, shell deny/ask rules and per-project write locks. | PiDev |
| `plugin/` (`@pidev/openacp-plugin`) | OpenACP plugin: `/projects`, `/project`, `/where`, `/pidev`, and a fail-closed allowlist middleware | PiDev |
| `bin/pidev.js` | Operator CLI: validate, status, projects, render policy, apply OpenACP lock-down, locks, redact | PiDev |
| `config/projects.json` | Project registry (the only folders the agent may work in) | You |
| `pidev-agent.service` | systemd supervision and hardening | PiDev template |

PiDev has **no runtime npm dependencies**. It uses only Node built-ins, so nothing native has to be built on the Pi.

## Request flow

1. You send `/project dpersona`. The PiDev plugin checks the registry: name → canonical path, enabled, inside the root, no symlink escape. It replies with `/new claude <canonical path>`.
2. You send that `/new` command. OpenACP's `resolveWorkspace()` accepts it because the path is inside its workspace base, `<PIDEV_WORKSPACE_ROOT>`, and `allowExternalWorkspaces=false`. OpenACP then creates a topic and a Claude session whose working directory is that path.
3. You describe a task in the topic. OpenACP sends it over ACP to Claude Code.
4. For **every** tool call, Claude Code first runs the PiDev guard hook from managed settings:
   - It denies if the session's working directory (realpath) is not inside an enabled registered project.
   - It denies file paths that leave the project after realpath, secret files, and writes to `.git/`, `.claude/` or `.mcp.json`.
   - For shell commands it denies, asks, or passes based on the rules in `src/guard.js`.
   - Before any write, it takes the per-project write lock (`state/locks/<project>.lock.json`).
5. Claude Code then applies its own permission rules (managed `allow`/`ask`/`deny`, with deny winning). "ask" becomes an Allow/Reject button in Telegram through OpenACP.
6. When the session ends, the `SessionEnd` hook releases its locks. Idle locks also expire after `PIDEV_LOCK_TTL_MINUTES`.

## Why each PiDev piece exists (gaps verified in OpenACP 2026.518.2 source)

| Gap in OpenACP | PiDev mitigation |
|---|---|
| `security.allowedUserIds` empty means everyone is allowed | `pidev validate` refuses an empty list and `apply openacp` writes it. The PiDev plugin middleware drops everyone when the list is empty. |
| `/new <absolute path>` is allowed anywhere by default (`allowExternalWorkspaces: true`) | `apply openacp` sets it to false, and the instance lives at `<root>/.openacp` so the base equals the root. |
| `resolveWorkspace` uses `path.resolve` (no realpath), so symlinks can escape; `/new <name>` creates `<root>/<name>` | The guard does a realpath check against the **registry**. Unregistered folders get every tool denied. |
| No project registry or `/projects` command | PiDev plugin commands plus `config/projects.json` |
| Local API (`127.0.0.1:21420`, `openacp api bypass`) could be driven from the agent shell | The guard denies `openacp …` and port 21420. Managed policy denies reading `<root>/.openacp/**` (where the API secret is). Bypass mode is disabled in managed settings. |
| No per-project write exclusivity | Guard write locks, plus `maxConcurrentSessions = PIDEV_MAX_CONCURRENT_TASKS` (default 1) |

## Where state lives (on the Pi)

| Path | Contents | Mode |
|---|---|---|
| `~/pidev-agent/.env` | Bot token, chat ID, owner IDs, workspace root | 0600 |
| `~/pidev-agent/config/projects.json` | Registry | 0600 |
| `~/pidev-agent/state/locks/` | Write locks | 0700 |
| `~/pidev-agent/logs/guard.log` | Guard deny/ask audit trail (redacted, rotated at 1 MB, no prompts or source) | 0700 dir |
| `<root>/.openacp/` | OpenACP instance: config, plugin settings (includes bot token), sessions, logs | 0700 |
| `~/.openacp/` | OpenACP shared store (agents, cache) | user |
| `~/.claude/` | Claude Code login (`.credentials.json`, 0600) and session transcripts | user |
| journald `pidev-agent` | Service output | system |

## Replaceability

The coding engine is reached only through ACP. Another ACP agent could be configured in OpenACP, but the PiDev guard is a *Claude Code* hook, so a different engine would need its own boundary. PiDev deliberately does not switch engines silently.
