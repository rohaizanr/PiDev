# Installation (everything on the Raspberry Pi)

No other computer is needed. Every command runs on the Pi, either on its own keyboard and screen or over SSH from any device. The two browser logins (Claude/OpenAI/Google and Telegram's BotFather) can be finished on your phone.

🖐 marks a step only you can do (an account, a login, or a Telegram action).

## Quick path

```bash
sudo apt update && sudo apt install -y git curl bubblewrap socat     # plus Node.js 22, see step 2
git clone https://github.com/rohaizanr/PiDev.git ~/pidev-agent
cd ~/pidev-agent
scripts/setup.sh
```

`setup.sh` walks through steps 4–15 below in order. It asks before each step and records progress in `state/setup-progress`. Stop at any time (`q` or Ctrl-C) and resume with `scripts/setup.sh`. Other options:
- `scripts/setup.sh --status`
- `--step <name>` to (re)run one step
- `--from <name>` to re-run from a step onward

Every step is also a standalone script, listed below.

## 1. Prepare the Pi 🖐

- **OS:** use **Raspberry Pi OS (64-bit)**, Debian 12 "bookworm" or newer, flashed with Raspberry Pi Imager. In Imager's settings, create your user, set Wi-Fi if needed, and optionally enable SSH. Claude Code supports x64/ARM64 only; 32-bit ARM (`armv7l`) is **not** supported.
- **Hardware:** a Pi 4 or 5 with 4 GB+ RAM is recommended (Claude Code documents 4 GB+). Use a good SD card or SSD with 5 GB+ free.
- **User:** log in as your normal non-root user. To isolate PiDev from your other files, use a dedicated user instead (see [SECURITY.md](SECURITY.md#migrating-to-a-dedicated-account-recommended)): `sudo adduser pidev && sudo usermod -aG sudo pidev`, then log in as `pidev`.
- **Swap (4 GB models):** if `free -h` shows little or no swap, set `CONF_SWAPSIZE=2048` in `/etc/dphys-swapfile`, then run `sudo dphys-swapfile setup && sudo dphys-swapfile swapon` (Raspberry Pi OS).

## 2. Base packages 🖐

PiDev never runs `apt` itself. Install these yourself:

```bash
sudo apt update
sudo apt install -y git curl bubblewrap socat    # bubblewrap + socat enable Claude Code's bash sandbox
node --version                                   # need v22.x (minimum v20)
```

If Node is missing or older than 22, install Node.js 22 LTS by following the official instructions of **one** of:
- NodeSource (adds an apt repository);
- nvm (per user, no sudo).

Don't use the much older `nodejs` package from the default Debian repositories.

## 3. Get PiDev 🖐

```bash
git clone https://github.com/rohaizanr/PiDev.git ~/pidev-agent
cd ~/pidev-agent
```

For a **private** repository, give the Pi read-only access with either:
- **A deploy key:** `ssh-keygen -t ed25519 -f ~/.ssh/pidev_deploy -N ""`, add `~/.ssh/pidev_deploy.pub` as a *read-only* deploy key on the repository, and clone over SSH (point `~/.ssh/config` at that key for your git host).
- **A fine-grained, read-only HTTPS token**, used when git asks for a password.

`~/.ssh` is hidden from the running PiDev service, so the agent never sees this key.

**Without git**, copy the folder by any means (USB stick, a downloaded archive) to `~/pidev-agent`. `scripts/update.sh` then won't work, and updates are manual (see [OPERATIONS.md](OPERATIONS.md#updates)).

## 4. Pre-flight check: `preflight`

```bash
scripts/preflight.sh
```

Read-only. It checks:
- your user (not root);
- model and architecture (64-bit);
- OS, RAM, swap and disk;
- systemd, git, curl, Node and npm;
- bubblewrap and socat;
- sudo rights;
- HTTPS to `api.telegram.org` and `registry.npmjs.org`;
- already-running OpenACP processes or units.

Fix every **BLOCK** before continuing.

## 5. PiDev self-test: `check`

```bash
npm run check     # lint + tests; PiDev has no dependencies to install
```

## 6. User-level install: `install`

```bash
scripts/install.sh
```

What it does:
- Re-runs the pre-flight check.
- If the global npm prefix isn't writable, sets up a user-local one (`~/.npm-global`). It never uses `sudo npm`.
- Installs OpenACP with `npm install -g @openacp/cli`.
- If Claude Code is missing, downloads Anthropic's native installer to a temp file and shows its SHA-256. It asks you to review the file before running it, and never pipes it into bash. `npm install -g @anthropic-ai/claude-code` is offered as the fallback.
- Creates `state/`, `logs/` and `backups/` (0700) and an empty `config/projects.json`.

Open a new shell (or `source ~/.profile`) if it added a new PATH entry.

## 7. Telegram bot and private group 🖐 (phone is fine)

1. In Telegram, open **@BotFather**, run `/newbot` and keep the token. You'll type it into the Pi in the next step. **Never paste it into a chat.**
2. Create a new group containing **only you and the bot**. In the group settings, enable **Topics**. Promote the bot to admin with *Manage Topics*, *Send Messages* and *Delete Messages*.
3. In @BotFather, run `/setjoingroups`, pick the bot and choose **Disable**, so nobody else can add it to their groups.
4. Get your numeric user ID from **@userinfobot**. The group ID starts with `-100`; the OpenACP wizard in step 9 can detect it.

## 8. Configure: `configure`

```bash
scripts/configure.sh
```

It asks for:
- the bot token (silent input);
- the group ID (`-100…`);
- your numeric Telegram user ID(s);
- the workspace root (default `~/projects`; created if missing);
- max concurrent sessions;
- `LLM_PROVIDER` (`claude` / `openai` / `gemini`), `LLM_MODEL` (optional) and `LLM_API_KEY` (optional, silent).

Everything is written to `.env` (0600) and then validated. Values are never echoed. Choosing `openai` or `gemini` asks you to confirm they are **unguarded** (see [SECURITY.md](SECURITY.md#llm-providers-and-api-keys)).

## 9. OpenACP onboarding: `onboard` 🖐

```bash
openacp onboard --dir "$(grep ^PIDEV_WORKSPACE_ROOT= .env | cut -d= -f2-)"
```

In the wizard:
- choose **Telegram**, enter the same bot token, and select your private group;
- choose **claude** as the agent (step 10 installs and selects the agent matching `LLM_PROVIDER` anyway);
- **no** auto-start (systemd runs PiDev);
- **no** tunnel.

The instance is created at `<workspace root>/.openacp`.

> Verify while doing this: OpenACP 2026.518.2 lists `--dir` under "Workspace Flags" in `openacp --help`. If the wizard asks for a workspace path instead, give it the workspace root.

## 10. Lock down OpenACP: `post-onboard`

```bash
scripts/post-onboard.sh
```

Steps:
1. Checks that the installed OpenACP still contains the settings PiDev relies on.
2. Takes a backup.
3. Installs the agent for your provider (`openacp agents install claude|codex|gemini`). For `openai` it offers to install the Codex CLI.
4. Previews, then applies:
   - `allowedUserIds` = your IDs
   - `allowExternalWorkspaces=false`
   - session limit
   - `runMode=foreground`
   - `autoStart=false`
   - tunnel off
   - default agent, and the provider key/model in `agents.json`
5. Runs `openacp plugin add ~/pidev-agent/plugin` and `openacp doctor --dry-run`.

## 11. Model login: `auth` 🖐 (skipped if `LLM_API_KEY` is set)

| Provider | Command on the Pi | Then |
|---|---|---|
| claude | `claude auth login` | Copy the URL it prints (press `c`), open it on your phone, approve, paste the code back |
| openai | `codex` | Choose "Sign in with ChatGPT" and follow the URL/code flow; exit Codex |
| gemini | `openacp agents run gemini --dir <workspace root>` | Choose "Sign in with Google"; exit |

Notes:
- With `LLM_API_KEY` set for `claude`, the key reaches Claude Code through `apiKeyHelper` (`bin/pidev-apikey.js`) and no login is needed.
- Don't put `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` in `.env` directly: OpenACP doesn't pass them to the agent.
- Check with `bin/pidev.js provider` (never prints the key).

## 12. Register projects: `project`

```bash
# optional disposable test repo (setup.sh offers to create it):
mkdir -p ~/projects/pidev-sandbox && cd ~/projects/pidev-sandbox \
  && git init && npm init -y && npm pkg set scripts.test="echo ok" && cd ~/pidev-agent
bin/pidev.js projects add pidev-sandbox ~/projects/pidev-sandbox --description "disposable test repo" --trusted
bin/pidev.js projects add dpersona ~/projects/dpersona
bin/pidev.js projects list
```

Projects must already exist inside the workspace root. PiDev never clones, moves or deletes them.

## 13. System files (sudo): `system`

```bash
scripts/install-system.sh
```

- Installs `/etc/claude-code/managed-settings.d/50-pidev.json`, root-owned so the agent can't change it.
  - The sandbox is on only if `bwrap` and `socat` are present.
  - For `claude` the policy also includes `apiKeyHelper` (when a key is set) and `model` (when `LLM_MODEL` is set).
- Installs `/etc/systemd/system/pidev-agent.service` and runs `daemon-reload`.
- If either file already exists and differs, it shows a diff and asks first.
- It does **not** enable the service.

## 14. Smoke test: `smoke`

```bash
scripts/start.sh --foreground
```

In your Telegram group, send these and check the results:

| Send | Expect |
|---|---|
| `/pidev` | help, with "Health: config OK" and your provider |
| `/projects` | your projects |
| `/project pidev-sandbox` | a `/new <agent> …` command; send it |
| `Show git status, create hello.txt containing hi, run npm test and show the diff` | works in the sandbox repo |
| `Run npm install` | an **approval** button (claude provider); approve it |
| `Print the contents of ~/.ssh/config` | refused |

From a second Telegram account (if you have one), check that messages are ignored. Otherwise record it as *not tested*. Press Ctrl-C when done.

## 15. Enable: `enable`

```bash
scripts/start.sh --enable      # start now and at every boot
scripts/doctor.sh              # all required checks should pass
```

Optionally confirm it comes back after `sudo reboot`.

## Developing PiDev on another computer (optional)

None of this is needed to run PiDev. If you prefer to edit the code elsewhere:
1. Commit and push to your repository from that computer.
2. On the Pi, run `scripts/update.sh` (backup → `git pull --ff-only` → checks → re-apply → restart).
3. Never run OpenACP with the same bot token on two machines. Telegram allows only one poller per token.
