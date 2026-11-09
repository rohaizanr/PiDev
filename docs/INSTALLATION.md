# Installation

> **Status:** the Pi has **not been inspected yet**. During development the only configured SSH host, `192.168.0.252` (user `mjsr`), timed out on port 22. Nothing confirmed it is the Pi. The steps below therefore check the platform as they run instead of assuming it.

Legend: **[MAC]** = development Mac · **[PI]** = run on the Raspberry Pi as the service account · 🖐 = manual step only you can do.

## 0. Mac development prerequisites [MAC]

Verified on this Mac: macOS 26.6.2 arm64, Node v22.23.4, npm 10.9.9, git 2.54.

```bash
cd ~/Codes/ai-gen/pidev
npm run check          # lint + 33 tests, no dependencies to install
```

Do **not** install or run OpenACP on the Mac. It would start a second Telegram poller.

## 1. SSH access to the Pi 🖐 [MAC]

Add a host alias to `~/.ssh/config`. Use your real values; PiDev never guesses them.

```sshconfig
Host pidev-pi
  HostName <pi-hostname-or-ip>
  User <pi-user>
  IdentityFile ~/.ssh/id_ed25519
```

```bash
ssh pidev-pi true && PIDEV_PI_SSH_HOST=pidev-pi scripts/remote-inspect.sh   # read-only
```

Check the output:
- **Architecture:** `aarch64` and 64-bit userland are required. Claude Code supports x64/ARM64 only, and its npm platform list has no `linux-arm`/armv7. If you see `armv7l`, reinstall 64-bit Raspberry Pi OS.
- **OS:** Debian 12 or later (Claude Code documents Debian 10+ / Ubuntu 20.04+).
- **RAM:** 4 GB+ recommended.

## 2. Pi base packages 🖐 [PI]

PiDev never runs `apt` itself. Install these yourself:

```bash
sudo apt update
sudo apt install -y git curl bubblewrap socat     # bubblewrap+socat enable Claude Code's bash sandbox
# Node.js 22 LTS (if `node --version` < 22), e.g. via NodeSource or nvm — follow their official instructions.
```

## 3. Deploy the source [MAC]

```bash
PIDEV_PI_SSH_HOST=pidev-pi scripts/deploy.sh          # dry run: shows destination + file list
PIDEV_PI_SSH_HOST=pidev-pi scripts/deploy.sh --apply  # backs up an existing install, asks, copies
```

The default destination is `~/pidev-agent` on the Pi (`PIDEV_PI_APP_DIR` overrides it). The deploy uses rsync without `--delete` and skips secrets, state, logs, `node_modules` and the registry. The repo has no git remote yet, so Git-based deploys are not set up. Once you add a remote, you can `git clone`/`git pull` on the Pi instead.

## 4. User-level install [PI]

```bash
cd ~/pidev-agent
scripts/install.sh
```

What it does:
- Checks the architecture, OS, RAM, Node (≥ 20) and git.
- Sets up a user-local npm prefix if the global one isn't writable. It never uses `sudo npm`.
- Installs OpenACP with `npm install -g @openacp/cli`.
- If Claude Code is missing, downloads Anthropic's native installer to a temp file, shows its SHA-256 and asks you to review it before running. It never pipes it into bash. npm install is the fallback.
- Creates `state/`, `logs/` and `backups/` (0700) and an empty `config/projects.json`.

## 5. Telegram bot and group 🖐

1. In @BotFather, run `/newbot` and keep the token (paste it only into `configure.sh`).
2. Create a group containing **only you and the bot**. Turn on Topics. Promote the bot to admin with Manage Topics, Send Messages and Delete Messages.
3. In @BotFather, run `/setjoingroups` and choose **Disable**.
4. Note your numeric user ID (@userinfobot) and the group ID (`-100…`).

## 6. Configure secrets [PI]

```bash
scripts/configure.sh    # silent token entry; writes .env (0600); runs `pidev validate`
```

## 7. Model authentication [PI]

`configure.sh` asked for `LLM_PROVIDER`, `LLM_MODEL` and `LLM_API_KEY`. Pick one route:

| Provider | With `LLM_API_KEY` (no login needed) | Without a key (🖐 log in once as the service user) |
|---|---|---|
| `claude` | Anthropic Console key `sk-ant-…`, served via `apiKeyHelper`. Bills per token. | `claude auth login` (opens a URL; on a headless Pi press "c" to copy it and paste the code back). Uses a Pro/Max/Team/Enterprise subscription. |
| `openai` | OpenAI key `sk-…`, written to OpenACP `agents.json` | `codex`, then "Sign in with ChatGPT" |
| `gemini` | Google AI Studio key `AIza…`, written to OpenACP `agents.json` | `openacp agents run gemini --dir "$PIDEV_WORKSPACE_ROOT"`, then "Sign in with Google" |

Notes:
- Never copy credentials from the Mac.
- Don't put `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` in `.env` directly: OpenACP doesn't pass them to the agent.
- `openai` and `gemini` are **unguarded** (see [SECURITY.md](SECURITY.md#llm-providers-and-api-keys)) and need `PIDEV_ALLOW_UNGUARDED_PROVIDER=true`. `configure.sh` asks you to confirm.
- `openai` needs the Codex CLI. `post-onboard.sh` offers `npm install -g @openai/codex`.

Check with `bin/pidev.js provider` (shows the provider, model and auth mode; never the key).

## 8. OpenACP onboarding 🖐 [PI]

```bash
source <(grep PIDEV_WORKSPACE_ROOT .env)   # or type the path
openacp onboard --dir "$PIDEV_WORKSPACE_ROOT"
```

In the wizard:
- choose **Telegram** and enter the same bot token and group;
- choose **claude** as the agent (`post-onboard.sh` installs and selects the agent that matches `LLM_PROVIDER` anyway);
- **do not** enable auto-start (systemd handles that);
- **do not** enable tunnels.

The instance is created at `$PIDEV_WORKSPACE_ROOT/.openacp`.

> Verify on the Pi: `openacp --help` lists `--dir` under "Workspace Flags" in 2026.518.2. If onboarding asks for a workspace path instead, give it `$PIDEV_WORKSPACE_ROOT`.

## 9. Lock down OpenACP and install the plugin [PI]

```bash
scripts/post-onboard.sh
```

Steps:
1. Checks that the installed OpenACP still contains the settings PiDev relies on.
2. Takes a backup.
3. Previews, then applies, `pidev apply openacp`:
   - `allowedUserIds` = your IDs
   - `allowExternalWorkspaces=false`
   - `maxConcurrentSessions` = `PIDEV_MAX_CONCURRENT_TASKS`
   - `runMode=foreground`
   - `autoStart=false`
   - tunnel off
4. Installs the agent for `LLM_PROVIDER` (`openacp agents install claude|codex|gemini`), applies the lock-down plus provider settings (default agent, key/model in `agents.json`), and runs `openacp plugin add ~/pidev-agent/plugin`.
5. Runs `openacp doctor --dry-run`.

## 10. Register projects [PI]

```bash
mkdir -p ~/projects/pidev-sandbox && cd ~/projects/pidev-sandbox && git init && npm init -y && npm pkg set scripts.test="echo ok" && cd ~/pidev-agent
bin/pidev.js projects add pidev-sandbox ~/projects/pidev-sandbox --description "disposable test repo" --trusted
bin/pidev.js projects add dpersona ~/projects/dpersona
```

## 11. System files (sudo) [PI]

```bash
scripts/install-system.sh
```

- Renders and installs `/etc/claude-code/managed-settings.d/50-pidev.json` (root-owned). The sandbox is on only if `bwrap` and `socat` are present. For `LLM_PROVIDER=claude` the policy also includes `apiKeyHelper` (when `LLM_API_KEY` is set) and `model` (when `LLM_MODEL` is set).
- Renders and installs `/etc/systemd/system/pidev-agent.service` and runs `daemon-reload`.
- If either file already exists and differs, it shows a diff and asks first.
- It does **not** enable the service.

## 12. Smoke test, then enable [PI]

```bash
scripts/start.sh --foreground
```

In Telegram, send these and check the results:

| Send | Expect |
|---|---|
| `/pidev` | help, with "Health: config OK" |
| `/projects` | your projects |
| `/project pidev-sandbox` | a `/new <agent> …` command (`claude`, `codex` or `gemini`) |
| that `/new` command | a new topic |
| `Show git status and list files` | Claude inspects the repo |
| `Create hello.txt containing hi, run npm test, show the diff` | edits pass; `npm test` passes |
| `Run npm install` | an **approval** button; approve; it runs in the sandbox folder |
| `Read ~/.ssh/config` | blocked |

From a second Telegram account (if you have one), check that messages are ignored. Then press Ctrl-C and run:

```bash
scripts/start.sh --enable
scripts/doctor.sh
```
