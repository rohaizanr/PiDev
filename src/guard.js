// PiDev guard: Claude Code PreToolUse policy.
//
// Runs as a hook configured in root-owned Claude Code *managed settings*, so
// the agent cannot edit or disable it. It never grants permission: it only
// returns "deny" (hard block), "ask" (force a Telegram approval prompt) or
// "pass" (let Claude Code's normal permission rules decide).
//
// IMPORTANT: shell-command pattern checks are best-effort and are NOT a
// sandbox. They are one layer on top of: OS user permissions, the workspace
// registry, Claude Code permission prompts, and (where available) the Claude
// Code bash sandbox.
import os from 'node:os';
import path from 'node:path';
import { findByDirectory, canonicalizeTarget } from './registry.js';
import { isInside } from './config.js';

const FILE_TOOLS = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  NotebookRead: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
};
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ---- Secret / protected path detection -------------------------------------
const SAFE_ENV_EXAMPLES = /^\.env\.(example|sample|template|dist)$/i;
const SECRET_BASENAME = [
  /^\.env$/i, /^\.env\..+/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^\.git-credentials$/i, /^\.credentials\.json$/i,
  /^credentials(\.json)?$/i, /^oauth_creds\.json$/i, /^agents\.json$/i, /^secrets?\.(json|ya?ml|toml)$/i, /^\.htpasswd$/i, /^api-secret$/i,
];
const SECRET_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.openacp', '.kube', '.docker', '.password-store', '.config/gcloud', '.codex', '.gemini']);
// Paths inside a project that must not be *written* (code-execution / policy escalation vectors).
const WRITE_PROTECTED_SEGMENTS = new Set(['.git', '.claude', '.husky']);
const WRITE_PROTECTED_BASENAMES = new Set(['.mcp.json', '.gitmodules']);

export function isSecretPath(p) {
  const base = path.basename(p);
  if (SAFE_ENV_EXAMPLES.test(base)) return false;
  if (SECRET_BASENAME.some((re) => re.test(base))) return true;
  const segs = p.split(/[\\/]+/);
  return segs.some((s) => SECRET_SEGMENTS.has(s));
}

function isWriteProtected(canonical, project) {
  const rel = path.relative(project.canonicalPath, canonical);
  const segs = rel.split(path.sep);
  return segs.some((s) => WRITE_PROTECTED_SEGMENTS.has(s)) || WRITE_PROTECTED_BASENAMES.has(path.basename(canonical));
}

// ---- Shell command policy ---------------------------------------------------
// Command position: start of input, after a shell separator / quote / subshell,
// or after a wrapper such as env, nohup, xargs, timeout.
const SEP = String.raw`(?:^|[;&|(\x60'"\n]|\$\(|\b(?:env|nohup|time|exec|command|nice|xargs|timeout|watch|then|do|else|bash\s+-c|sh\s+-c)\s+(?:-\S+\s+)*(?:[A-Za-z_]\w*=\S*\s+)*)\s*`;

/** Hard deny. [regex, reason] */
export const SHELL_DENY = [
  [/\b(sudo|doas|pkexec|runuser)\b/, 'privilege escalation (sudo) is never allowed for the agent'],
  [new RegExp(`${SEP}su(\\s|$)`), 'privilege escalation (su) is never allowed for the agent'],
  [/--dangerously-skip-permissions|--permission-mode[ =]bypassPermissions|bypassPermissions/i, 'permission bypass is never allowed'],
  [new RegExp(`${SEP}openacp(\\s|$)`), 'the agent may not drive OpenACP (its local API can toggle bypass mode)'],
  [/\b(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):21420\b/, 'access to the OpenACP local API is not allowed'],
  [/\/proc\/[^\s'"]*\/(environ|mem|maps|cmdline|fd)\b/, 'reading other processes\' environment or memory is not allowed'],
  [/pidev-(apikey|guard)\b|apiKeyHelper/, 'the agent may not run PiDev credential or policy helpers'],
  [/(\$\{?|\bprintenv\s+)(LLM_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENACP_TELEGRAM_BOT_TOKEN)\b/, 'the agent may not read provider API keys or bot tokens'],
  [/\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+[^\s]+)/, 'force push is never allowed'],
  [/\bgit\s+(filter-branch|filter-repo)\b/, 'history rewriting is not allowed'],
  [/\bgit\s+push\b[^;&|]*\s(--delete\b|-d\b|:[^\s]+)/, 'deleting remote branches requires a separate admin workflow'],
  [/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'piping remote scripts into a shell is not allowed'],
  [new RegExp(`${SEP}(systemctl|service|journalctl\\s+--vacuum|ufw|iptables|ip6tables|nft|firewall-cmd|raspi-config|visudo|useradd|usermod|userdel|groupadd|passwd|chpasswd|chsh|mount|umount|mkfs(\\.\\w+)?|fdisk|parted|shutdown|reboot|poweroff|halt|init|apt|apt-get|dpkg|snap|rpi-update|rpi-eeprom-update)(\\s|$)`), 'system administration commands are not allowed for the agent'],
  [/\bdd\b[^;&|]*\bof=\/dev\//, 'writing to block devices is not allowed'],
  [/(\/etc\/ssh|authorized_keys|sshd_config|\/etc\/sudoers)/, 'changing SSH or sudo configuration is not allowed'],
  [/\b(nc|ncat|netcat)\b[^;&|]*\s-[a-zA-Z]*[le]\b|\bsocat\b[^;&|]*\b(exec|system|tcp-listen)\b|\bbash\s+-i\b[^;&|]*\/dev\/tcp|\/dev\/(tcp|udp)\//i, 'opening a shell/listener on the network is not allowed'],
  [/\b(ngrok|cloudflared|localtunnel|lt\s+--port|tailscale\s+funnel)\b/, 'exposing services publicly is not allowed'],
  [/\bchmod\b[^;&|]*\s(-R\s+)?[0-7]*777\s+(\/|~)/, 'broad permission changes on host paths are not allowed'],
  [/\b(printenv|env)\b[^;&|]*\|\s*(curl|wget|nc)\b/, 'exfiltrating the environment is not allowed'],
  [new RegExp(`${SEP}history(\\s|$)|_history\\b`), 'reading shell history is not allowed'],
];

/** Requires explicit owner approval in Telegram. [regex, reason] */
export const SHELL_ASK = [
  [/\bgit\s+(commit|push|merge|rebase|reset|clean|stash|checkout\s+--|restore|cherry-pick|revert|tag|branch\s+-[dD]|remote\s+(add|set-url|remove))\b/, 'git operation that records, publishes or discards work'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|rm|uninstall|update|upgrade|up|link|dedupe|prune)\b/, 'dependency installation runs package lifecycle scripts'],
  [/\b(npm|pnpm|yarn|bun)\s+[^;&|]*(\s-g\b|\s--global\b)/, 'global package install'],
  [/\b(npm|pnpm|yarn)\s+(publish|unpublish|deprecate|dist-tag|owner|token|login|adduser)\b/, 'publishing / registry account operation'],
  [/\b(npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx)\b/, 'downloads and executes a package'],
  [/\b(pip3?|pipx|uv|poetry|gem|cargo|go)\s+(install|add|get)\b/, 'dependency installation'],
  [/\b(curl|wget|scp|rsync|sftp|ftp|ssh)\b/, 'network transfer'],
  [/\b(gh|glab|vercel|netlify|firebase|fly|flyctl|heroku|aws|gcloud|az|terraform|pulumi|kubectl|helm|docker|podman)\b/, 'remote resource / deployment tooling'],
  [/\b(prisma\s+migrate\s+deploy|db:migrate|migrate\s+deploy|knex\s+migrate)\b/, 'database migration'],
  [/\b(kill|pkill|killall)\b/, 'terminating processes'],
  [/\bcrontab\b/, 'scheduled task changes'],
  [new RegExp(`${SEP}rm\\s`), 'deleting files'],
  [/(^|[^<>&0-9])>\s*\/(?!dev\/(null|stdout|stderr)\b)/, 'writing to an absolute path'],
];

// Read-only commands that don't need the project write lock.
const READONLY_CMD = /^\s*(git\s+(status|diff|log|show|branch|rev-parse|remote\s+-v|ls-files|blame)|ls|pwd|cat|head|tail|wc|grep|rg|find|tree|file|stat|du|echo|which|node\s+--version|npm\s+(ls|outdated|view|--version)|(npm|pnpm|yarn)\s+(test|run\s+(test|lint|typecheck|check)))\b[^;&|<>`$]*$/;

const SAFE_ABS_PREFIXES = ['/dev/null', '/dev/stdout', '/dev/stderr', '/tmp', '/usr/bin', '/bin', '/usr/local/bin', '/usr/share', '/usr/lib', '/usr/include', '/proc/cpuinfo', '/proc/meminfo'];

/** rm with recursive flag on broad / unresolved targets => deny. */
function broadRm(cmd) {
  const segs = cmd.split(/[;&|]+/);
  for (const seg of segs) {
    const toks = seg.trim().split(/\s+/);
    const i = toks.findIndex((t) => t === 'rm' || t.endsWith('/rm'));
    if (i < 0) continue;
    const args = toks.slice(i + 1);
    const flags = args.filter((a) => a.startsWith('-'));
    const recursive = flags.some((f) => f === '--recursive' || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)));
    const targets = args.filter((a) => !a.startsWith('-'));
    if (!recursive) continue;
    for (const t of targets) {
      const u = t.replace(/^['"]|['"]$/g, '');
      if (/^(\/|~|\$HOME|\$\{HOME\}|\.|\.\.|\*|\.\/\*|\.\.\/.*|\/\*)\/?\*?$/.test(u) || u.startsWith('/') || u.startsWith('~') || u.includes('..') || u.includes('$') || u.includes('`')) {
        return `recursive delete of a broad or unresolved path (${u.slice(0, 40)})`;
      }
    }
  }
  return null;
}

function shellSecretRef(cmd) {
  const toks = cmd.split(/[\s'"=<>|;&()]+/).filter(Boolean);
  return toks.find((t) => isSecretPath(t) && !/^-/.test(t)) ?? null;
}

function shellPathEscape(cmd, cwd, project) {
  if (/(^|[\s;&|])cd\s+(\/|~|\.\.|-)(\s|$|[;&|])/.test(cmd) || /(^|[\s;&|])cd\s*($|[;&|])/.test(cmd)) return 'changes directory outside the project';
  const toks = cmd.split(/[\s'"=<>|;&()]+/).filter(Boolean);
  for (const t of toks) {
    if (t.startsWith('/') || t.startsWith('~/') || t === '~' || t.includes('..')) {
      if (t.startsWith('/') && SAFE_ABS_PREFIXES.some((p) => t === p || t.startsWith(p + '/'))) continue;
      if (/^https?:|^git@|:\/\//.test(t)) continue;
      const expanded = t.startsWith('~') ? path.join(os.homedir(), t.slice(1)) : t;
      const canonical = canonicalizeTarget(expanded, cwd);
      if (!isInside(canonical, project.canonicalPath)) return `references a path outside the project (${t.slice(0, 60)})`;
    }
  }
  return null;
}

/**
 * Decide on one PreToolUse event.
 * @param {{ tool_name: string, tool_input?: any, cwd?: string, session_id?: string }} input
 * @param {{ projects: any[], locks?: import('./locks.js').LockStore }} ctx
 * @returns {{ decision: 'deny'|'ask'|'pass', reason?: string, project?: string }}
 */
export function decide(input, ctx) {
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input ?? {};
  const cwd = input?.cwd;
  if (!cwd || typeof cwd !== 'string') return { decision: 'deny', reason: 'PiDev: no working directory reported; refusing (fail closed).' };

  const project = findByDirectory(ctx.projects, cwd);
  if (!project) {
    return { decision: 'deny', reason: 'PiDev: this session is not inside a registered, enabled project. Ask the owner to pick one with /projects and start a session with /project <name>.' };
  }
  const realCwd = canonicalizeTarget(cwd, '/');
  const deny = (reason) => ({ decision: 'deny', reason: `PiDev policy: ${reason}.`, project: project.name });
  const ask = (reason) => ({ decision: 'ask', reason: `PiDev: owner approval required — ${reason}.`, project: project.name });

  // ---- file tools --------------------------------------------------------
  if (FILE_TOOLS[tool]) {
    for (const key of FILE_TOOLS[tool]) {
      const v = ti[key];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string') return deny(`invalid ${key}`);
      const target = v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v;
      const canonical = canonicalizeTarget(target, realCwd);
      if (!isInside(canonical, project.canonicalPath)) return deny(`${tool} outside the selected project "${project.name}" is not allowed`);
      if (isSecretPath(canonical) || isSecretPath(v)) return deny(`${tool} of secret/credential files is not allowed`);
      if (WRITE_TOOLS.has(tool) && isWriteProtected(canonical, project)) return deny(`writing to ${path.relative(project.canonicalPath, canonical)} (git internals / agent policy files) is not allowed`);
    }
    if (tool === 'Glob' && typeof ti.pattern === 'string') {
      const p = ti.pattern;
      if (p.startsWith('/') || p.startsWith('~') || p.split('/').includes('..')) {
        const prefix = p.split(/[*?{[]/)[0] || '/';
        const target = prefix.startsWith('~') ? path.join(os.homedir(), prefix.slice(1)) : prefix;
        if (!isInside(canonicalizeTarget(target, realCwd), project.canonicalPath)) return deny('Glob outside the selected project is not allowed');
      }
    }
    if (WRITE_TOOLS.has(tool)) {
      const lock = takeLock(ctx, project, input);
      if (lock) return lock;
    }
    return { decision: 'pass', project: project.name };
  }

  // ---- shell-like tools --------------------------------------------------
  if (typeof ti.command === 'string') {
    const cmd = ti.command;
    for (const [re, reason] of SHELL_DENY) if (re.test(cmd)) return deny(reason);
    const rm = broadRm(cmd);
    if (rm) return deny(rm);
    const secret = shellSecretRef(cmd);
    if (secret) return deny(`command references a secret/credential path (${path.basename(secret)})`);
    const escape = shellPathEscape(cmd, realCwd, project);
    if (escape) return ask(escape);
    if (!READONLY_CMD.test(cmd)) {
      const lock = takeLock(ctx, project, input);
      if (lock) return lock;
    }
    for (const [re, reason] of SHELL_ASK) if (re.test(cmd)) return ask(reason);
    return { decision: 'pass', project: project.name };
  }

  return { decision: 'pass', project: project.name };
}

function takeLock(ctx, project, input) {
  if (!ctx.locks) return null;
  const sid = String(input.session_id ?? '');
  const r = ctx.locks.acquire(project.name, sid);
  if (r.ok) return null;
  const mins = Math.round((r.ageMs ?? 0) / 60000);
  return { decision: 'deny', reason: `PiDev: project "${project.name}" is busy — another session is writing to it (last activity ${mins} min ago). Finish or /cancel that session first, then retry.`, project: project.name };
}
