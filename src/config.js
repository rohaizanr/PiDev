// PiDev configuration loading and validation. Fails closed; never echoes secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllowedUserIds } from './auth.js';
import { describeSecret } from './redact.js';
import { getProvider, PROVIDER_NAMES, PROVIDERS, authMode } from './providers.js';

export const PIDEV_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal dotenv parser (KEY=VALUE, # comments, optional quotes). No expansion. */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf(' #');
      if (hash >= 0) v = v.slice(0, hash);
      v = v.trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Load env: process.env wins over the .env file (systemd EnvironmentFile
 * already populates process.env in production).
 */
export function loadEnv({ home = PIDEV_HOME, env = process.env } = {}) {
  const file = path.join(home, '.env');
  let fromFile = {};
  if (fs.existsSync(file)) fromFile = parseDotenv(fs.readFileSync(file, 'utf8'));
  return { ...fromFile, ...pickDefined(env) };
}

function pickDefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));
}

const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

/**
 * Validate configuration. Returns { ok, errors, warnings, config, summary }.
 * Messages never contain secret values.
 * @param {Record<string,string|undefined>} env
 * @param {{ requireTelegram?: boolean, checkFs?: boolean }} [opts]
 */
export function validateConfig(env, { requireTelegram = true, checkFs = true } = {}) {
  const errors = [];
  const warnings = [];

  const token = env.OPENACP_TELEGRAM_BOT_TOKEN ?? '';
  if (requireTelegram) {
    if (!token) errors.push('OPENACP_TELEGRAM_BOT_TOKEN is missing. Run scripts/configure.sh on the Pi.');
    else if (!TOKEN_RE.test(token)) errors.push('OPENACP_TELEGRAM_BOT_TOKEN does not look like a BotFather token (expected "<digits>:<secret>"). Value not shown.');
  }

  const chatRaw = env.OPENACP_TELEGRAM_CHAT_ID ?? '';
  let chatId = null;
  if (requireTelegram) {
    if (!chatRaw) errors.push('OPENACP_TELEGRAM_CHAT_ID is missing (numeric ID of your private forum supergroup, starts with -100).');
    else if (!/^-100\d{5,}$/.test(chatRaw)) errors.push('OPENACP_TELEGRAM_CHAT_ID must be a supergroup ID starting with -100. OpenACP only works in a forum supergroup.');
    else chatId = Number(chatRaw);
  }

  const ids = parseAllowedUserIds(env.PIDEV_ALLOWED_USER_IDS);
  if (ids.invalid.length) errors.push(`PIDEV_ALLOWED_USER_IDS contains non-numeric entries (${ids.invalid.length}). Use numeric Telegram user IDs, not usernames.`);
  if (ids.valid.length === 0) errors.push('PIDEV_ALLOWED_USER_IDS is empty. PiDev fails closed: nobody can use the bot until at least one numeric owner ID is set.');

  const root = env.PIDEV_WORKSPACE_ROOT ?? '';
  let workspaceRoot = null;
  if (!root) errors.push('PIDEV_WORKSPACE_ROOT is missing (absolute path on the Pi, e.g. $HOME/projects).');
  else if (!path.isAbsolute(root)) errors.push('PIDEV_WORKSPACE_ROOT must be an absolute path.');
  else if (checkFs) {
    try {
      workspaceRoot = fs.realpathSync(root);
      if (!fs.statSync(workspaceRoot).isDirectory()) errors.push('PIDEV_WORKSPACE_ROOT is not a directory.');
      if (['/', '/home', '/root', '/etc', '/usr'].includes(workspaceRoot)) errors.push(`PIDEV_WORKSPACE_ROOT may not be ${workspaceRoot}.`);
      if (process.env.HOME && workspaceRoot === safeRealpath(process.env.HOME)) errors.push('PIDEV_WORKSPACE_ROOT may not be your home directory itself; use a subdirectory such as ~/projects.');
      if (isInside(workspaceRoot, PIDEV_HOME) || isInside(PIDEV_HOME, workspaceRoot)) errors.push('PIDEV_WORKSPACE_ROOT and the PiDev application directory must not contain each other.');
    } catch {
      errors.push('PIDEV_WORKSPACE_ROOT does not exist. Create it first (mkdir -p).');
    }
  } else workspaceRoot = path.resolve(root);

  const maxTasks = intOr(env.PIDEV_MAX_CONCURRENT_TASKS, 1);
  if (maxTasks < 1 || maxTasks > 8) errors.push('PIDEV_MAX_CONCURRENT_TASKS must be between 1 and 8.');
  const lockTtl = intOr(env.PIDEV_LOCK_TTL_MINUTES, 30);
  if (lockTtl < 1 || lockTtl > 24 * 60) errors.push('PIDEV_LOCK_TTL_MINUTES must be between 1 and 1440.');

  const mode = env.PIDEV_APPROVAL_MODE ?? 'strict';
  if (mode !== 'strict') errors.push('PIDEV_APPROVAL_MODE only supports "strict".');

  if ((env.OPENACP_TUNNEL_ENABLED ?? 'false') !== 'false') warnings.push('OPENACP_TUNNEL_ENABLED is not "false"; public tunnels are out of scope for the MVP.');

  // ---- LLM provider ----------------------------------------------------------
  const providerName = (env.LLM_PROVIDER || 'claude').trim().toLowerCase();
  const provider = getProvider(providerName);
  const model = (env.LLM_MODEL ?? '').trim();
  const apiKey = (env.LLM_API_KEY ?? '').trim();
  const allowUnguarded = env.PIDEV_ALLOW_UNGUARDED_PROVIDER === 'true';
  if (!provider) {
    errors.push(`LLM_PROVIDER must be one of: ${PROVIDER_NAMES.join(', ')}.`);
  } else {
    if (model) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,99}$/.test(model)) errors.push('LLM_MODEL contains invalid characters.');
      else if (!provider.modelRe.test(model)) warnings.push(`LLM_MODEL "${model}" does not look like ${provider.modelHint}. It will be used as-is.`);
      if (provider.modelDelivery === 'manual') warnings.push(`LLM_MODEL is not applied automatically for ${providerName}: ${provider.modelHint}.`);
    }
    if (apiKey) {
      if (!provider.keyRe.test(apiKey)) {
        const other = Object.entries(PROVIDERS).find(([n, p]) => n !== providerName && p.keyRe.test(apiKey));
        errors.push(`LLM_API_KEY does not look like ${provider.keyHint}${other ? ` (it looks like a ${other[0]} key — check LLM_PROVIDER)` : ''}. Value not shown.`);
      }
      if (providerName === 'openai' && /^sk-ant-/.test(apiKey)) errors.push('LLM_API_KEY is an Anthropic key but LLM_PROVIDER=openai. Value not shown.');
    }
    if (!provider.guarded && !allowUnguarded) {
      errors.push(`LLM_PROVIDER=${providerName} runs the ${provider.agent} agent, which PiDev's per-tool guard and managed policy do NOT protect (they are Claude Code features). Set PIDEV_ALLOW_UNGUARDED_PROVIDER=true to accept that, or use LLM_PROVIDER=claude. See docs/SECURITY.md.`);
    }
    if (!provider.guarded && allowUnguarded) warnings.push(`Unguarded provider: ${providerName} (${provider.agent}) runs without the PiDev guard hook; only OS/systemd limits and the agent's own approvals apply.`);
  }
  for (const legacy of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    if (env[legacy]) warnings.push(`${legacy} is set but is not used by PiDev (OpenACP does not pass it to the agent). Put the key in LLM_API_KEY instead and remove ${legacy}.`);
  }

  const config = {
    chatId,
    allowedUserIds: ids.valid,
    workspaceRoot,
    maxConcurrentTasks: maxTasks,
    lockTtlMinutes: lockTtl,
    approvalMode: mode,
    provider: provider ? providerName : null,
    agent: provider?.agent ?? null,
    guarded: provider?.guarded ?? false,
    model: model || null,
    hasApiKey: Boolean(apiKey),
  };
  const summary = {
    OPENACP_TELEGRAM_BOT_TOKEN: describeSecret(token),
    OPENACP_TELEGRAM_CHAT_ID: chatRaw ? 'set' : 'missing',
    PIDEV_ALLOWED_USER_IDS: `${ids.valid.length} id(s)`,
    PIDEV_WORKSPACE_ROOT: workspaceRoot ?? (root || 'missing'),
    PIDEV_MAX_CONCURRENT_TASKS: maxTasks,
    PIDEV_LOCK_TTL_MINUTES: lockTtl,
    PIDEV_APPROVAL_MODE: mode,
    LLM_PROVIDER: provider ? `${providerName} -> ${provider.agent} agent (${provider.guarded ? 'guarded' : 'UNGUARDED'})` : `invalid (${providerName.slice(0, 20)})`,
    LLM_MODEL: model || '(agent default)',
    LLM_API_KEY: apiKey ? describeSecret(apiKey) : 'not set (agent login)',
    AUTH: provider ? authMode(providerName, Boolean(apiKey)) : 'n/a',
  };
  return { ok: errors.length === 0, errors, warnings, config, summary };
}

function intOr(v, d) {
  if (v === undefined || v === '') return d;
  return /^-?\d+$/.test(String(v)) ? Number(v) : NaN;
}

export function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** True if child === parent or child is inside parent (both canonical). */
export function isInside(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
