#!/usr/bin/env node
// PiDev operator CLI. Never prints secret values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PIDEV_HOME, loadEnv, validateConfig } from '../src/config.js';
import { loadRegistry, addProject, findByName } from '../src/registry.js';
import { LockStore } from '../src/locks.js';
import { renderClaudePolicy } from '../src/policy.js';
import { applyOpenacpSettings } from '../src/openacp.js';
import { redact, secretValuesFromEnv } from '../src/redact.js';

const REGISTRY = path.join(PIDEV_HOME, 'config', 'projects.json');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const env = loadEnv();
const secrets = secretValuesFromEnv(env);
const out = (s) => process.stdout.write(redact(s, secrets) + '\n');
const err = (s) => process.stderr.write(redact(s, secrets) + '\n');

function ctx() {
  return { workspaceRoot: env.PIDEV_WORKSPACE_ROOT, pidevHome: PIDEV_HOME };
}

const USAGE = `pidev — PiDev Agent operator CLI

  pidev validate [--no-telegram]         Validate .env / environment (fails closed)
  pidev status [--json]                  Config summary, projects, locks (no secrets)
  pidev projects list                    List registered projects and problems
  pidev projects add <name> <abs-path> [--description TEXT] [--trusted] [--disabled]
  pidev projects check <name>            Validate one project
  pidev render claude-policy [--sandbox on|off]   Print Claude Code managed-settings JSON
  pidev apply openacp [--dry-run]        Apply allowlist/workspace lock-down + LLM provider to the OpenACP instance
  pidev provider                         Show the configured LLM provider, agent and auth mode (no secrets)
  pidev locks [--release <session-id>]   Show or release project write locks
  pidev redact                           Redact secrets from stdin (for log excerpts)
`;

const [cmd, sub] = args;
try {
  switch (cmd) {
    case 'validate': {
      const v = validateConfig(env, { requireTelegram: !flag('--no-telegram') });
      for (const [k, val] of Object.entries(v.summary)) out(`  ${k.padEnd(28)} ${val}`);
      v.warnings.forEach((w) => out(`WARN  ${w}`));
      v.errors.forEach((e) => err(`ERROR ${e}`));
      out(v.ok ? 'Configuration OK' : 'Configuration INVALID — the bot must not be started.');
      process.exit(v.ok ? 0 : 1);
    }
    case 'status': {
      const v = validateConfig(env);
      const { projects, errors } = loadRegistry(REGISTRY, ctx());
      const locks = new LockStore(path.join(PIDEV_HOME, 'state', 'locks'), { ttlMs: Number(env.PIDEV_LOCK_TTL_MINUTES || 30) * 60_000 }).list();
      const status = {
        config: v.ok ? 'ok' : 'invalid',
        configErrors: v.errors,
        settings: v.summary,
        projects: projects.map((p) => ({ name: p.name, enabled: p.enabled, path: p.canonicalPath })),
        registryProblems: errors,
        locks,
      };
      if (flag('--json')) out(JSON.stringify(status, null, 2));
      else {
        out(`Config: ${status.config}`);
        status.configErrors.forEach((e) => out(`  - ${e}`));
        out(`Projects (${projects.length}):`);
        projects.forEach((p) => out(`  ${p.enabled ? '●' : '○'} ${p.name.padEnd(20)} ${p.canonicalPath}`));
        errors.forEach((e) => out(`  ! ${e}`));
        out(`Write locks: ${locks.length ? '' : 'none'}`);
        locks.forEach((l) => out(`  ${l.project} held by ${l.sessionId.slice(0, 12)} (${Math.round(l.ageMs / 60000)} min${l.stale ? ', stale' : ''})`));
      }
      process.exit(0);
    }
    case 'projects': {
      if (sub === 'list') {
        const { projects, errors } = loadRegistry(REGISTRY, ctx());
        if (!projects.length) out('No valid projects registered.');
        projects.forEach((p) => out(`${p.enabled ? 'enabled ' : 'disabled'} ${p.name.padEnd(20)} ${p.canonicalPath}${p.description ? '  — ' + p.description : ''}`));
        errors.forEach((e) => err(`problem: ${e}`));
        process.exit(errors.length ? 1 : 0);
      }
      if (sub === 'add') {
        const [, , name, p] = args;
        if (!name || !p) throw new Error('usage: pidev projects add <name> <absolute-path>');
        if (!fs.existsSync(REGISTRY)) {
          fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
          fs.writeFileSync(REGISTRY, JSON.stringify({ version: 1, projects: [] }, null, 2) + '\n', { mode: 0o600 });
        }
        const proj = addProject(REGISTRY, { name, path: p, description: opt('--description') ?? '', trusted: flag('--trusted'), enabled: !flag('--disabled') }, ctx());
        out(`Registered ${proj.name} -> ${proj.canonicalPath}`);
        out(`In Telegram: /project ${proj.name}`);
        process.exit(0);
      }
      if (sub === 'check') {
        const { projects, errors } = loadRegistry(REGISTRY, ctx());
        const p = findByName(projects, args[2]);
        if (!p) { err(`Unknown or disabled project: ${args[2]}`); errors.forEach((e) => err(`  ${e}`)); process.exit(1); }
        out(`${p.name}: OK -> ${p.canonicalPath}`);
        process.exit(0);
      }
      break;
    }
    case 'render': {
      if (sub !== 'claude-policy') break;
      const v = validateConfig(env, { requireTelegram: false });
      if (!v.config.workspaceRoot) throw new Error('PIDEV_WORKSPACE_ROOT invalid: ' + v.errors.join('; '));
      const sandbox = (opt('--sandbox') ?? 'on') === 'on';
      const isClaude = v.config.provider === 'claude';
      out(JSON.stringify(renderClaudePolicy({
        pidevHome: PIDEV_HOME, nodePath: process.execPath, workspaceRoot: v.config.workspaceRoot, home: os.homedir(), sandbox,
        apiKeyHelper: isClaude && v.config.hasApiKey,
        model: isClaude ? v.config.model : null,
      }), null, 2));
      process.exit(0);
    }
    case 'apply': {
      if (sub !== 'openacp') break;
      const v = validateConfig(env);
      if (!v.ok) { v.errors.forEach((e) => err(`ERROR ${e}`)); process.exit(1); }
      v.warnings.forEach((w) => err(`WARN  ${w}`));
      const { changes } = applyOpenacpSettings(v.config, { dryRun: flag('--dry-run'), apiKey: (env.LLM_API_KEY ?? '').trim() });
      out(changes.length ? changes.map((c) => `${flag('--dry-run') ? 'would change' : 'changed'}: ${c}`).join('\n') : 'OpenACP settings already compliant.');
      process.exit(0);
    }
    case 'provider': {
      const v = validateConfig(env, { requireTelegram: false });
      for (const k of ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY', 'AUTH']) out(`  ${k.padEnd(14)} ${v.summary[k]}`);
      v.warnings.forEach((w) => out(`WARN  ${w}`));
      const provErrors = v.errors.filter((e) => /LLM_|PROVIDER/.test(e));
      provErrors.forEach((e) => err(`ERROR ${e}`));
      process.exit(v.config.provider && provErrors.length === 0 ? 0 : 1);
    }
    case 'locks': {
      const store = new LockStore(path.join(PIDEV_HOME, 'state', 'locks'), { ttlMs: Number(env.PIDEV_LOCK_TTL_MINUTES || 30) * 60_000 });
      const rel = opt('--release');
      if (rel) { out(`Released ${store.releaseSession(rel)} lock(s).`); process.exit(0); }
      const l = store.list();
      out(l.length ? l.map((x) => `${x.project}\t${x.sessionId}\t${Math.round(x.ageMs / 60000)}min${x.stale ? '\tstale' : ''}`).join('\n') : 'No locks.');
      process.exit(0);
    }
    case 'redact': {
      const input = fs.readFileSync(0, 'utf8');
      process.stdout.write(redact(input, secrets));
      process.exit(0);
    }
    default:
      out(USAGE);
      process.exit(cmd ? 1 : 0);
  }
  out(USAGE);
  process.exit(1);
} catch (e) {
  err(`Error: ${e.message}`);
  process.exit(1);
}
