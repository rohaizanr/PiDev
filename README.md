# PiDev Agent

PiDev is a personal AI developer that runs all the time on a Raspberry Pi. You message a private Telegram group from your phone or computer. **Claude Code** then works on registered project folders on the Pi: it reads code, edits files, runs tests, and installs dependencies. It asks for your approval before anything risky.

PiDev does not build its own bot or coding engine. It combines:

| Layer | Component |
|---|---|
| Telegram UI, sessions, streaming, approval buttons | [OpenACP](https://docs.openacp.ai) (`@openacp/cli`, verified against 2026.518.2) |
| Coding agent | Selected by `LLM_PROVIDER`: **Claude Code** (`claude`, default and guarded), or Codex (`openai`) / Gemini CLI (`gemini`), which are unguarded |
| Project registry, workspace boundary, write locks, extra deny rules | **PiDev** (this repo: about 1,000 lines of dependency-free Node.js) |
| Supervision | systemd (`pidev-agent.service`) |

```text
Telegram (private forum group: you + bot)
        │  long polling (no inbound port)
        ▼
OpenACP ── chatId filter ── allowedUserIds ── PiDev plugin (fail-closed allowlist, /projects /project /where /pidev)
        │  ACP
        ▼
Claude Code ── managed policy (root-owned): bypass disabled, deny/ask rules, sandbox
        │  every tool call
        ▼
PiDev guard hook ── registered project only · no secrets · no sudo/force-push · one writer per project
        ▼
~/projects/<registered project>   (git, npm, tests, files)
```

> **Telegram constraint:** OpenACP's Telegram adapter only works in a **forum supergroup with Topics**. It does not support a 1:1 private chat. PiDev uses a *private* supergroup that contains only you and the bot. OpenACP ignores every other chat (verified in its source). PiDev and OpenACP both require your numeric user ID. Each task gets its own topic. See [docs/SECURITY.md](docs/SECURITY.md#telegram).

## Everything runs on the Pi

You need only the Raspberry Pi and Telegram. You install, configure, run and update PiDev directly on the Pi, using its own keyboard or SSH from any device. The browser logins can be finished on your phone. No second computer is required.

## Prerequisites

- Raspberry Pi with **64-bit** Raspberry Pi OS (Debian 12+/aarch64). Claude Code does not support 32-bit ARM. 4 GB+ RAM is recommended (Claude Code documents 4 GB+).
- Node.js 22 LTS on the Pi (OpenACP needs ≥ 20; the Claude Code npm package needs ≥ 22), plus git.
- Recommended: `bubblewrap` and `socat` for Claude Code's bash sandbox. Install them with `sudo apt install -y git curl bubblewrap socat`.
- A model account for the provider you choose: a Claude subscription **or** an Anthropic Console API key (default), an OpenAI key or ChatGPT login, or a Gemini key or Google login.
- Telegram on your phone or desktop.
- The PiDev repository reachable from the Pi (`git clone`), or the folder copied over.

## Quick setup (on the Pi)

Full details: [docs/INSTALLATION.md](docs/INSTALLATION.md).

```bash
sudo apt update && sudo apt install -y git curl bubblewrap socat   # and Node.js 22 LTS
git clone https://github.com/rohaizanr/PiDev.git ~/pidev-agent
cd ~/pidev-agent
scripts/setup.sh          # guided, resumable: preflight → install → configure → onboard → lock-down → login → projects → system → smoke test → enable
```

`scripts/setup.sh --status` shows progress, and `--step <name>` re-runs a single step. Every step is also its own script:

| Step | Script |
|---|---|
| Pre-flight check (read-only) | `scripts/preflight.sh` |
| Self-test | `npm run check` |
| Install OpenACP + Claude Code (no sudo) | `scripts/install.sh` |
| Secrets, allowlist, workspace, LLM provider | `scripts/configure.sh` |
| OpenACP wizard | `openacp onboard --dir <workspace root>` |
| Lock down OpenACP, install agent + plugin | `scripts/post-onboard.sh` |
| Model login (if no API key) | `claude auth login` / `codex` / `openacp agents run gemini` |
| Register a project | `bin/pidev.js projects add <name> <path>` |
| Managed policy + systemd unit (sudo) | `scripts/install-system.sh` |
| Smoke test / enable | `scripts/start.sh --foreground` / `scripts/start.sh --enable` |

## LLM provider and authentication

Set the provider in `.env` with `scripts/configure.sh`:

```dotenv
LLM_PROVIDER=claude        # claude | openai | gemini
LLM_MODEL=                 # optional, e.g. claude-opus-5-5 / sonnet, gemini-2.5-pro
LLM_API_KEY=               # optional; empty = use the agent's own login
PIDEV_ALLOW_UNGUARDED_PROVIDER=false   # must be true for openai/gemini
```

| `LLM_PROVIDER` | Agent run by OpenACP | How `LLM_API_KEY` is delivered | How `LLM_MODEL` is applied | PiDev guard |
|---|---|---|---|---|
| `claude` (default) | Claude Code | Claude Code `apiKeyHelper` runs `bin/pidev-apikey.js`, so the key is **not** in the agent's environment | managed policy `model` | **Active** |
| `openai` | Codex CLI (`codex-acp`) | `OPENAI_API_KEY` in OpenACP `agents.json` (0600) | manually, in `~/.codex/config.toml` | **Not active** |
| `gemini` | Gemini CLI | `GEMINI_API_KEY` in OpenACP `agents.json` (0600) | `GEMINI_MODEL` in `agents.json` | **Not active** |

Billing and data flow:
- A Claude API key bills per token to your Anthropic Console account. Leaving it empty uses your subscription login (`claude auth login`).
- Your code goes to whichever vendor you pick.

**Why OpenAI and Gemini are "unguarded":** Claude Code only runs Claude models, so these providers use a *different* coding agent. PiDev's per-tool guard and managed policy are Claude Code features, so they don't run there. That covers the workspace boundary, secret blocks, `sudo`/force-push bans and write locks. PiDev refuses to start such a provider unless you set `PIDEV_ALLOW_UNGUARDED_PROVIDER=true`.

To switch provider, model or key on the Pi:

```bash
scripts/configure.sh && scripts/post-onboard.sh && scripts/install-system.sh && sudo systemctl restart pidev-agent
```

## Connect Telegram

1. In @BotFather, run `/newbot` and keep the token for `configure.sh`. **Never paste it into a chat.**
2. In @BotFather, run `/setjoingroups`, pick your bot, choose **Disable** *after* you have added it to your group. This stops anyone else adding the bot to their groups.
3. Create a new group with only yourself and the bot. Enable **Topics** in the group settings. Make the bot an admin with *Manage Topics*, *Send Messages* and *Delete Messages*.
4. Get your numeric user ID (for example from @userinfobot) and the group's chat ID (starts with `-100`; `openacp onboard` can detect it).

## Register a project

```bash
# the folder must already exist under PIDEV_WORKSPACE_ROOT; PiDev never clones, moves or deletes it
bin/pidev.js projects add dpersona "$HOME/projects/dpersona" --description "Persona app"
bin/pidev.js projects list
```

The service reads the registry on every command and every tool call, so you don't need to restart it.

## Using it in Telegram

| You send | What happens |
|---|---|
| `/pidev` | PiDev help, safety rules and health summary |
| `/projects` | Lists the enabled registered projects |
| `/project dpersona` | Checks the project and replies with the exact `/new <agent> /home/…/dpersona` command (`claude`, `codex` or `gemini`) |
| `/new <agent> <path>` (copy from the reply) | OpenACP opens a new topic with an agent session in that project |
| *any text in that topic* | A task for the agent in that project |
| `/where` (in a session topic) | Shows the session's project and canonical path |
| `/cancel`, `/sessions`, `/resume`, `/status`, `/help` | Native OpenACP commands |
| `/clear` | Native OpenACP command (Assistant topic only). Resets the conversation and never deletes files |

**Not provided in the MVP:**
- `/new <name>` (create a workspace) and `/clone`: create or clone the folder over SSH, then run `projects add`.
- OpenACP's own `/new` with a *name*: it creates `<root>/<name>`, but that folder isn't registered, so the guard blocks every tool there.

## Approvals

The table below applies to the **claude** provider. With openai or gemini, only that agent's own approval behaviour applies.

Claude Code asks before risky actions. OpenACP shows **Allow / Reject** buttons in the topic, and unanswered requests are auto-denied after 10 minutes.

| Category | Behaviour |
|---|---|
| Read files, `git status/diff/log`, edit files, `npm test`, `npm run lint/build/typecheck` inside the project | Allowed |
| `npm/pnpm/yarn install`, `git commit/push/reset/clean`, `rm`, `npx`, `curl`, `docker`, `gh`, network transfers, paths outside the project | **Asks you** |
| `sudo`, force-push, permission bypass, `.env`/keys/credentials, system admin commands, reverse shells, tunnels, other folders | **Always blocked** |

Do not use OpenACP's `/enable_bypass` or `/dangerous`. PiDev's managed policy sets `disableBypassPermissionsMode`, so these have no effect.

## Service commands

```bash
scripts/start.sh | scripts/stop.sh | scripts/status.sh | scripts/doctor.sh | scripts/backup.sh
scripts/update.sh          # backup → git pull --ff-only → checks → re-apply → restart
journalctl -u pidev-agent -f | bin/pidev.js redact
```

## Security limitations and data flow

- **Cloud model.** Code and command output the agent reads are sent to the selected provider (Anthropic, OpenAI or Google). Don't register repositories you aren't allowed to send there.
- **Non-Claude providers run without the PiDev guard.** See the section above.
- **Shell rules are not a sandbox.** Command patterns are best-effort. The strong boundaries are:
  - the dedicated non-root OS user;
  - systemd's read-only filesystem, apart from the workspace and state folders;
  - root-owned Claude Code managed settings;
  - the guard hook;
  - the bubblewrap sandbox, if it is installed.
- **Repositories are untrusted input.** Repo-defined hooks and MCP servers are disabled. Install scripts always need your approval.
- Details: [docs/SECURITY.md](docs/SECURITY.md).

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Installation](docs/INSTALLATION.md) · [Security](docs/SECURITY.md) · [Operations](docs/OPERATIONS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Implementation status](docs/IMPLEMENTATION-STATUS.md)
