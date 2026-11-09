// Applies PiDev's security settings to an existing OpenACP instance.
//
// Verified against @openacp/cli 2026.518.2 source:
//  - instance dir = <workspace>/.openacp ; workspace base = parent of it
//  - config.json: workspace.allowExternalWorkspaces, runMode, autoStart, defaultAgent
//  - plugins/data/@openacp/security/settings.json: allowedUserIds, maxConcurrentSessions, sessionTimeoutMinutes
//  - plugins/data/@openacp/tunnel/settings.json: enabled
//  - agents.json: { version, installed: { <alias>: { command, args, env: Record<string,string>, ... } } }
// Re-verify these keys after every OpenACP upgrade (scripts/doctor.sh does).
import fs from 'node:fs';
import path from 'node:path';
import { getProvider, managedAgentEnvKeys } from './providers.js';

export function instanceDir(workspaceRoot) {
  return path.join(workspaceRoot, '.openacp');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.pidev-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function backup(file, stamp) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${stamp}`);
}

/**
 * @param {{ workspaceRoot: string, allowedUserIds: string[], maxConcurrentTasks: number,
 *           provider?: string|null, model?: string|null }} cfg
 * @param {{ dryRun?: boolean, apiKey?: string }} [opts] apiKey is only written for agent-env providers
 * @returns {{ changes: string[] }}
 */
export function applyOpenacpSettings(cfg, { dryRun = false, apiKey = '' } = {}) {
  const provider = getProvider(cfg.provider ?? 'claude');
  if (!provider) throw new Error('unknown LLM provider');
  if (!cfg.allowedUserIds?.length) throw new Error('refusing to apply: no allowed user IDs (OpenACP would allow everyone)');
  const dir = instanceDir(cfg.workspaceRoot);
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) {
    throw new Error(`OpenACP instance not initialised at ${dir}. Run the OpenACP setup first (see docs/INSTALLATION.md, step "OpenACP onboarding").`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const changes = [];

  const conf = readJson(configFile);
  conf.workspace = conf.workspace ?? {};
  if (conf.workspace.allowExternalWorkspaces !== false) changes.push('config.json: workspace.allowExternalWorkspaces -> false');
  conf.workspace.allowExternalWorkspaces = false;
  if (conf.defaultAgent !== provider.agent) changes.push(`config.json: defaultAgent -> ${provider.agent}`);
  conf.defaultAgent = provider.agent;
  if (conf.runMode !== 'foreground') changes.push('config.json: runMode -> foreground (systemd supervises)');
  conf.runMode = 'foreground';
  if (conf.autoStart !== false) changes.push('config.json: autoStart -> false (systemd unit instead of OpenACP user unit)');
  conf.autoStart = false;

  const secFile = path.join(dir, 'plugins', 'data', '@openacp', 'security', 'settings.json');
  const sec = fs.existsSync(secFile) ? readJson(secFile) : {};
  const ids = [...cfg.allowedUserIds].map(String);
  if (JSON.stringify(sec.allowedUserIds ?? []) !== JSON.stringify(ids)) changes.push(`security: allowedUserIds -> ${ids.length} id(s)`);
  sec.allowedUserIds = ids;
  if (sec.maxConcurrentSessions !== cfg.maxConcurrentTasks) changes.push(`security: maxConcurrentSessions -> ${cfg.maxConcurrentTasks}`);
  sec.maxConcurrentSessions = cfg.maxConcurrentTasks;
  sec.sessionTimeoutMinutes = sec.sessionTimeoutMinutes ?? 60;

  const tunFile = path.join(dir, 'plugins', 'data', '@openacp', 'tunnel', 'settings.json');
  const tun = fs.existsSync(tunFile) ? readJson(tunFile) : null;
  if (tun && tun.enabled !== false) { tun.enabled = false; changes.push('tunnel: enabled -> false'); }

  // ---- agents.json: provider key/model for the selected agent only -------------
  const agentsFile = path.join(dir, 'agents.json');
  const store = fs.existsSync(agentsFile) ? readJson(agentsFile) : { version: 1, installed: {} };
  const installed = store.installed ?? {};
  const selected = installed[provider.agent];
  if (!selected) {
    throw new Error(`OpenACP agent "${provider.agent}" is not installed. Run: openacp agents install ${provider.agent} --dir "${cfg.workspaceRoot}"`);
  }
  let agentsChanged = false;
  // Remove PiDev-managed variables from every agent, then set them on the selected one.
  for (const [agent, keys] of Object.entries(managedAgentEnvKeys())) {
    const entry = installed[agent];
    if (!entry?.env) continue;
    for (const k of keys) {
      if (k in entry.env && !(agent === provider.agent && provider.keyDelivery === 'agent-env' && (k === provider.keyEnv || k === provider.modelEnv))) {
        delete entry.env[k]; agentsChanged = true; changes.push(`agents.json: removed ${k} from ${agent}`);
      }
    }
  }
  selected.env = selected.env ?? {};
  if (provider.keyDelivery === 'agent-env') {
    if (apiKey) {
      if (selected.env[provider.keyEnv] !== apiKey) { selected.env[provider.keyEnv] = apiKey; agentsChanged = true; changes.push(`agents.json: set ${provider.keyEnv} for ${provider.agent} (value not shown)`); }
    } else if (provider.keyEnv in selected.env) {
      delete selected.env[provider.keyEnv]; agentsChanged = true; changes.push(`agents.json: removed ${provider.keyEnv} from ${provider.agent} (using agent login)`);
    }
  }
  if (provider.modelEnv) {
    if (cfg.model) {
      if (selected.env[provider.modelEnv] !== cfg.model) { selected.env[provider.modelEnv] = cfg.model; agentsChanged = true; changes.push(`agents.json: ${provider.modelEnv}=${cfg.model} for ${provider.agent}`); }
    } else if (provider.modelEnv in selected.env) {
      delete selected.env[provider.modelEnv]; agentsChanged = true; changes.push(`agents.json: removed ${provider.modelEnv} (agent default model)`);
    }
  }

  if (!dryRun) {
    if (agentsChanged) { backup(agentsFile, stamp); writeJsonAtomic(agentsFile, store); }
    backup(configFile, stamp); backup(secFile, stamp);
    writeJsonAtomic(configFile, conf);
    writeJsonAtomic(secFile, sec);
    if (tun) { backup(tunFile, stamp); writeJsonAtomic(tunFile, tun); }
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  return { changes };
}
