// Applies PiDev's security settings to an existing OpenACP instance.
//
// Verified against @openacp/cli 2026.518.2 source:
//  - instance dir = <workspace>/.openacp ; workspace base = parent of it
//  - config.json: workspace.allowExternalWorkspaces, runMode, autoStart, defaultAgent
//  - plugins/data/@openacp/security/settings.json: allowedUserIds, maxConcurrentSessions, sessionTimeoutMinutes
//  - plugins/data/@openacp/tunnel/settings.json: enabled
// Re-verify these keys after every OpenACP upgrade (scripts/doctor.sh does).
import fs from 'node:fs';
import path from 'node:path';

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
 * @param {{ workspaceRoot: string, allowedUserIds: string[], maxConcurrentTasks: number }} cfg
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ changes: string[] }}
 */
export function applyOpenacpSettings(cfg, { dryRun = false } = {}) {
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
  if (conf.defaultAgent !== 'claude') changes.push('config.json: defaultAgent -> claude');
  conf.defaultAgent = 'claude';
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

  if (!dryRun) {
    backup(configFile, stamp); backup(secFile, stamp);
    writeJsonAtomic(configFile, conf);
    writeJsonAtomic(secFile, sec);
    if (tun) { backup(tunFile, stamp); writeJsonAtomic(tunFile, tun); }
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  return { changes };
}
