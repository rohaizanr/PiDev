# PiDev Agent

PiDev is a personal AI developer that runs all the time on a Raspberry Pi. You message a private Telegram group from your phone or Mac. **Claude Code** then works on registered project folders on the Pi: it reads code, edits files, runs tests, and installs dependencies. It asks for your approval before anything risky.

PiDev does not build its own bot or coding engine. It combines:

| Layer | Component |
|---|---|
| Telegram UI, sessions, streaming, approval buttons | [OpenACP](https://docs.openacp.ai) (`@openacp/cli`, verified against 2026.518.2) |
| Coding agent | Claude Code via OpenACP's `claude` ACP agent (`@agentclientprotocol/claude-agent-acp`) |
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

## Two machines

| | Mac (development) | Raspberry Pi (production) |
|---|---|---|
| This repo | Edit, `npm run check` | Deployed copy (`~/pidev-agent`) |
| OpenACP / bot | **Never run here** | `pidev-agent.service` |
| Claude Code | Used to develop PiDev | Separate install + separate login |
| Secrets | None | `~/pidev-agent/.env` (0600), OpenACP instance (0700) |

Commands are labelled **[MAC]** or **[PI]**.

## Prerequisites

- Raspberry Pi with **64-bit** Raspberry Pi OS (Debian 12+/aarch64). Claude Code does not support 32-bit ARM. 4 GB+ RAM is recommended (Claude Code documents 4 GB+).
- Node.js 22 LTS on the Pi (OpenACP needs ≥ 20; the Claude Code npm package needs ≥ 22), plus git.
- Optional but recommended: `bubblewrap` and `socat` for Claude Code's bash sandbox.
- A Claude Pro/Max/Team/Enterprise or Console account.
- SSH key access from the Mac to the Pi, with a host alias in `~/.ssh/config`.

## Quick setup

Full details: [docs/INSTALLATION.md](docs/INSTALLATION.md).

```bash
# [MAC] check and copy to the Pi (dry run first, then --apply)
npm run check
PIDEV_PI_SSH_HOST=pidev-pi scripts/deploy.sh
PIDEV_PI_SSH_HOST=pidev-pi scripts/deploy.sh --apply

# [PI]
cd ~/pidev-agent
scripts/install.sh                 # checks platform, installs OpenACP + Claude Code (no sudo)
scripts/configure.sh               # token, chat id, owner id, workspace root (silent input, .env 0600)
claude auth login                  # log in as the Pi service user
openacp onboard --dir "$HOME/projects"   # choose Telegram + claude
scripts/post-onboard.sh            # lock down OpenACP, install agent + PiDev plugin
bin/pidev.js projects add myapp "$HOME/projects/myapp"
scripts/install-system.sh          # sudo: managed Claude policy + systemd unit
scripts/start.sh --foreground      # smoke test from Telegram, Ctrl-C
scripts/start.sh --enable          # start at boot
```

## Connect Telegram

1. In @BotFather, run `/newbot` and keep the token for `configure.sh`. **Never paste it into a chat.**
2. In @BotFather, run `/setjoingroups`, pick your bot, choose **Disable** *after* you have added it to your group. This stops anyone else adding the bot to their groups.
3. Create a new group with only yourself and the bot. Enable **Topics** in the group settings. Make the bot an admin with *Manage Topics*, *Send Messages* and *Delete Messages*.
4. Get your numeric user ID (for example from @userinfobot) and the group's chat ID (starts with `-100`; `openacp onboard` can detect it).

## Register a project

```bash
# [PI] the folder must already exist under PIDEV_WORKSPACE_ROOT; PiDev never clones, moves or deletes it
bin/pidev.js projects add dpersona "$HOME/projects/dpersona" --description "Persona app"
bin/pidev.js projects list
```

The service reads the registry on every command and every tool call, so you don't need to restart it.

## Using it in Telegram

| You send | What happens |
|---|---|
| `/pidev` | PiDev help, safety rules and health summary |
| `/projects` | Lists the enabled registered projects |
| `/project dpersona` | Checks the project and replies with the exact `/new claude /home/…/dpersona` command |
| `/new claude <path>` (copy from the reply) | OpenACP opens a new topic with a Claude session in that project |
| *any text in that topic* | A task for Claude in that project |
| `/where` (in a session topic) | Shows the session's project and canonical path |
| `/cancel`, `/sessions`, `/resume`, `/status`, `/help` | Native OpenACP commands |
| `/clear` | Native OpenACP command (Assistant topic only). Resets the conversation and never deletes files |

**Not provided in the MVP:**
- `/new <name>` (create a workspace) and `/clone`: create or clone the folder over SSH, then run `projects add`.
- OpenACP's own `/new` with a *name*: it creates `<root>/<name>`, but that folder isn't registered, so the guard blocks every tool there.

## Approvals

Claude Code asks before risky actions. OpenACP shows **Allow / Reject** buttons in the topic, and unanswered requests are auto-denied after 10 minutes.

| Category | Behaviour |
|---|---|
| Read files, `git status/diff/log`, edit files, `npm test`, `npm run lint/build/typecheck` inside the project | Allowed |
| `npm/pnpm/yarn install`, `git commit/push/reset/clean`, `rm`, `npx`, `curl`, `docker`, `gh`, network transfers, paths outside the project | **Asks you** |
| `sudo`, force-push, permission bypass, `.env`/keys/credentials, system admin commands, reverse shells, tunnels, other folders | **Always blocked** |

Do not use OpenACP's `/enable_bypass` or `/dangerous`. PiDev's managed policy sets `disableBypassPermissionsMode`, so these have no effect.

## Service commands

```bash
# [PI]
scripts/start.sh | scripts/stop.sh | scripts/status.sh | scripts/doctor.sh | scripts/backup.sh
journalctl -u pidev-agent -f | bin/pidev.js redact
```

## Security limitations and data flow

- **Cloud model.** Code and command output that Claude reads are sent to Anthropic, the configured AI provider. Don't register repositories you aren't allowed to send there.
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
