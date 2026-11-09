# Architecture

## Components

| Component | Role | Owner |
|---|---|---|
| Telegram private forum supergroup | Your UI. One topic per agent session. | You |
| OpenACP (`@openacp/cli`) | Telegram adapter (grammY, long polling), sessions, streaming, permission buttons, ACP client | Upstream |
| Coding agent, chosen by `LLM_PROVIDER` | `claude` (`@agentclientprotocol/claude-agent-acp`): runs Claude Code and loads user, project, local and **managed** settings. Or `codex` (`codex-acp`) / `gemini` (`@google/gemini-cli --acp`). | Upstream |
| `src/providers.js` | The single table mapping provider → OpenACP agent, key delivery, model delivery, key format, and whether it is guarded | PiDev |
| `bin/pidev-apikey.js` | Claude Code `apiKeyHelper`: prints `LLM_API_KEY` from `.env` so the key is never in the agent's environment | PiDev |
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
| `<root>/.openacp/agents.json` | Installed agents. For openai/gemini, also `OPENAI_API_KEY`/`GEMINI_API_KEY` | 0600 |
| `~/.codex/`, `~/.gemini/` | Codex / Gemini CLI login and config (if used) | user |
| journald `pidev-agent` | Service output | system |

## LLM providers

`LLM_PROVIDER` selects which ACP agent OpenACP runs. `pidev apply openacp` sets `defaultAgent` and writes the provider's key and model into that agent's `env` in `<root>/.openacp/agents.json`. It also removes PiDev-managed variables from every other agent. The OpenACP agent env schema was verified in 2026.518.2. Its `workspace.security.envWhitelist` is **not wired up yet** (there's a TODO in the source), so `ANTHROPIC_API_KEY` and friends in `.env` never reach the agent. That's why PiDev uses `LLM_API_KEY` with explicit delivery.

| Protection layer | claude | openai (Codex) | gemini (Gemini CLI) |
|---|---|---|---|
| OpenACP chat filter + user allowlist + PiDev plugin middleware | ✅ | ✅ | ✅ |
| OpenACP `allowExternalWorkspaces=false`, session limit | ✅ | ✅ | ✅ |
| systemd: non-root, read-only FS except workspace/state, `~/.ssh` inaccessible | ✅ | ✅ | ✅ |
| PiDev guard hook (registry boundary, secrets, deny/ask rules, write locks) | ✅ | ❌ | ❌ |
| Managed policy (bypass disabled, deny rules, repo hooks off, sandbox) | ✅ | ❌ | ❌ |
| Key kept out of the agent's environment | ✅ (`apiKeyHelper`) | ❌ (agent env) | ❌ (agent env) |
| Approval prompts | Claude Code + PiDev rules | Codex's own policy, via ACP (unverified) | Gemini CLI's own policy, via ACP (unverified) |

Bringing openai or gemini to parity means expressing PiDev's rules in Codex's sandbox/approval configuration and Gemini CLI's settings. That isn't done yet, so `PIDEV_ALLOW_UNGUARDED_PROVIDER=true` is required to run them.

## Replaceability

The coding engine is reached only through ACP, so OpenACP can run other agents. The PiDev guard is a *Claude Code* hook, though, so other engines need their own boundary. PiDev never switches engines silently: you choose the provider explicitly and acknowledge that it is unguarded.
