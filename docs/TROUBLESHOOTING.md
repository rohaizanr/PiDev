# Troubleshooting

Start with `scripts/doctor.sh` and `scripts/status.sh` on the Pi.

## Telegram

| Symptom | Check |
|---|---|
| Bot never answers | `scripts/status.sh`. Is the service active? Does `journalctl` show `409 Conflict`? That means another process is polling the same token: stop `openacp` on other machines (including the Mac!), `systemctl --user disable --now openacp`, and check for stray `openacp` processes. |
| Answers nothing to you, but logs show "dropped message from unauthorised user" | Your ID isn't in `PIDEV_ALLOWED_USER_IDS`, or you used a username. Re-run `configure.sh`, then `post-onboard.sh`, then restart. |
| "Chat must be a group" / forum errors in `openacp doctor` | The group needs **Topics** enabled and the bot as admin with *Manage Topics*. The chat ID must be the `-100…` supergroup ID. |
| Works in foreground, not as a service | `journalctl -u pidev-agent -n 100`. Look for PATH problems (`openacp`/`claude` not found) and re-run `install-system.sh`, which re-renders PATH. Or a missing `ReadWritePaths` entry: "EROFS"/"read-only file system". |
| Slow or missing updates, `429 Too Many Requests` | Telegram rate limit. OpenACP queues and retries. Lower verbosity with `/outputmode low`. |
| Network outage | Nothing to do. Long polling resumes on its own, and systemd restarts OpenACP if it exits. |

## Claude Code

| Symptom | Fix |
|---|---|
| "not logged in" / auth errors in session | Run `claude auth login` as the **service user** (not root, not the Mac). Check with `claude auth status >/dev/null && echo ok`. |
| Works for you in SSH but not in the service | The service HOME must be the same user's home. Check `systemctl show -p User pidev-agent`. |
| `blockWritesOutsideWorkingDirectories` unknown | Claude Code is older than v2.1.314. Run `claude update`. |
| Bypass or "auto" mode missing in OpenACP menus | Intended. Managed policy disables them. |

## ACP / agent startup

| Symptom | Fix |
|---|---|
| `/new` says the agent is not installed | `openacp agents install claude --dir "$PIDEV_WORKSPACE_ROOT"` |
| Session starts, then every tool is denied with "not inside a registered, enabled project" | You started `/new` without a path, with a *name*, or with an unregistered folder. Use `/project <name>` and copy its `/new` command. |
| "Workspace path … is outside base directory" | Intended (`allowExternalWorkspaces=false`). The project must live under `PIDEV_WORKSPACE_ROOT`. |
| Plugin commands missing (`/projects`) | `openacp plugins --dir …`, then re-run `post-onboard.sh`. The service needs `Environment=PIDEV_HOME=…` (set by the unit). If PiDev can't load, the plugin blocks **all** messages (fail closed). Check the logs for "PiDev plugin failed to load". |

## Platform

| Symptom | Fix |
|---|---|
| `install.sh`: "32-bit ARM is NOT supported" | Install 64-bit Raspberry Pi OS. Claude Code has no armv7 build. |
| "Node.js >= 20 required" | Install Node 22 LTS. Check `node --version` in the *service's* PATH too. |
| `EACCES` on `npm install -g` | Accept the user-local npm prefix offered by `install.sh`. Never use `sudo npm`. |

## Permissions and paths

| Symptom | Fix |
|---|---|
| `.env must be mode 600` | `chmod 600 ~/pidev-agent/.env` |
| `projects add` → "symlink escape" | The folder resolves outside the root. Move the project into the root, or opt in explicitly (see `config/projects.example.json`). |
| `projects add` → "overlaps" | Projects can't be nested. Register the outer **or** the inner folder, not both. |
| Agent says "project is busy" | Another session holds the write lock. Finish or `/cancel` it, or run `bin/pidev.js locks --release <id>`. |
| A legitimate command is blocked | Check `logs/guard.log` for the rule. If it's a false positive, adjust `SHELL_DENY`/`SHELL_ASK` in `src/guard.js` on the Mac, add a test, deploy. Don't weaken managed settings on the Pi by hand. |

## Service

```bash
systemd-analyze verify /etc/systemd/system/pidev-agent.service
systemctl status pidev-agent; journalctl -u pidev-agent -b --no-pager | bin/pidev.js redact | tail -50
```

If the start limit is hit (10 restarts in 10 min), fix the cause, then run `sudo systemctl reset-failed pidev-agent`.

If the sandbox fails to start under systemd while `failIfUnavailable=true`:
1. Check `bwrap --version`.
2. Check that unprivileged user namespaces are enabled (`sysctl kernel.unprivileged_userns_clone`, if that key exists).
3. As a temporary measure, re-run `install-system.sh` after removing bubblewrap. This renders the policy with the sandbox off. It weakens the boundary (see [SECURITY.md](SECURITY.md#known-limitations)).
