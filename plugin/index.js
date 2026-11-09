// PiDev plugin for OpenACP (plugin API verified against @openacp/cli 2026.518.2).
//
// Adds:
//   /projects        list enabled registered projects
//   /project <name>  validate a project and give the exact native /new command
//   /where           show the current session's project and canonical path
//   /pidev           PiDev help, safety rules and health summary
// and a MESSAGE_INCOMING middleware that drops every message from users not in
// PIDEV_ALLOWED_USER_IDS. Unlike OpenACP's own allowlist, an empty list means
// NOBODY (fail closed). Unauthorised users get no reply.
//
// Requires env PIDEV_HOME (set by the systemd unit) pointing at the PiDev app dir.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadPidev() {
  const home = process.env.PIDEV_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('PIDEV_HOME is not set to an absolute path');
  const imp = (rel) => import(pathToFileURL(path.join(home, rel)).href);
  const [config, registry, auth] = await Promise.all([imp('src/config.js'), imp('src/registry.js'), imp('src/auth.js')]);
  return { home, config, registry, auth };
}

const HELP = `PiDev — your Raspberry Pi developer agent

1. /projects — list registered projects
2. /project <name> — get the command that starts a session in that project
3. Send the /new command it gives you, then describe the task in the new topic.

Other useful native commands: /sessions, /resume, /cancel, /status, /help.

Safety rules
• Only registered projects are reachable; everything else is blocked by the PiDev guard.
• Commits, pushes, installs, deletions and network transfers ask for your approval (buttons).
• sudo, force-push, permission bypass and secret files are always blocked.
• Never paste tokens or keys into this chat.
• The safety rules above are enforced for the claude provider; other providers rely on their own approvals.`;

export default {
  name: '@pidev/openacp-plugin',
  version: '0.1.0',
  description: 'PiDev project registry commands and fail-closed owner allowlist',
  permissions: ['commands:register', 'middleware:register', 'kernel:access'],

  async setup(ctx) {
    let P;
    try {
      P = await loadPidev();
    } catch (e) {
      // Fail closed: if PiDev can't load, block all incoming messages.
      ctx.log.error(`PiDev plugin failed to load; blocking all messages: ${e.message}`);
      ctx.registerMiddleware('message:incoming', { priority: 0, handler: async () => null });
      return;
    }
    const env = () => P.config.loadEnv({ home: P.home });
    const allowed = () => P.auth.parseAllowedUserIds(env().PIDEV_ALLOWED_USER_IDS).valid;
    const registry = () => {
      const e = env();
      return P.registry.loadRegistry(path.join(P.home, 'config', 'projects.json'), { workspaceRoot: e.PIDEV_WORKSPACE_ROOT, pidevHome: P.home });
    };

    ctx.registerMiddleware('message:incoming', {
      priority: 0,
      handler: async (payload, next) => {
        if (!P.auth.isAuthorizedUser(payload?.userId, allowed())) {
          ctx.log.warn(`PiDev: dropped message from unauthorised user on ${payload?.channelId ?? '?'}`);
          return null; // silent drop: no diagnostics to strangers
        }
        return next();
      },
    });

    const guarded = (fn) => async (args) => {
      if (!P.auth.isAuthorizedUser(args.userId, allowed())) return; // silent
      try {
        return await fn(args);
      } catch (e) {
        ctx.log.error(`PiDev command error: ${e.message}`);
        return { type: 'text', text: 'PiDev: command failed. Check the logs on the Pi (scripts/status.sh).' };
      }
    };

    ctx.registerCommand({
      name: 'projects',
      description: 'List registered PiDev projects',
      category: 'plugin',
      handler: guarded(async () => {
        const { projects, errors } = registry();
        const enabled = projects.filter((p) => p.enabled);
        if (!enabled.length) return { type: 'text', text: `No projects registered.${errors.length ? ` (${errors.length} invalid entr${errors.length === 1 ? 'y' : 'ies'} — run "pidev projects list" on the Pi)` : ''}` };
        const lines = enabled.map((p) => `• ${p.name}${p.description ? ' — ' + p.description : ''}`);
        return { type: 'text', text: `Available projects:\n${lines.join('\n')}\n\nSelect one with /project <name>` };
      }),
    });

    ctx.registerCommand({
      name: 'project',
      description: 'Select a registered project (prints the /new command to start a session there)',
      usage: '<name>',
      category: 'plugin',
      handler: guarded(async (args) => {
        const name = String(args.raw ?? '').trim();
        if (!name) return { type: 'text', text: 'Usage: /project <name>. See /projects.' };
        const { projects } = registry();
        const p = P.registry.findByName(projects, name);
        if (!p) return { type: 'text', text: `Unknown or disabled project "${name.slice(0, 64)}". See /projects.` };
        const v = P.config.validateConfig(env(), { requireTelegram: false });
        const agent = v.config.agent ?? 'claude';
        const boundary = v.config.guarded
          ? 'Sessions in any other directory are blocked by the PiDev guard.'
          : `⚠ Provider ${v.config.provider} (${agent}) is NOT covered by the PiDev guard: only OS limits and the agent's own approvals apply.`;
        return {
          type: 'text',
          text: `Project ${p.name} ✔\nPath: ${p.canonicalPath}\n\nStart a session bound to it by sending:\n/new ${agent} ${p.canonicalPath}\n\nThen give your instructions in the new topic. ${boundary}`,
        };
      }),
    });

    ctx.registerCommand({
      name: 'where',
      description: "Show this session's project and canonical path",
      category: 'plugin',
      handler: guarded(async (args) => {
        if (!args.sessionId) return { type: 'text', text: 'No session in this topic. Use /project <name> to start one.' };
        const s = ctx.sessions?.getSession?.(args.sessionId);
        const wd = s?.workingDirectory;
        if (!wd) return { type: 'text', text: 'Could not determine the working directory of this session.' };
        const p = P.registry.findByDirectory(registry().projects, wd);
        return { type: 'text', text: p ? `Project: ${p.name}\nPath: ${p.canonicalPath}` : `This session's directory is NOT a registered project; all tools are blocked.\nDirectory: ${wd}` };
      }),
    });

    ctx.registerCommand({
      name: 'pidev',
      description: 'PiDev help, safety rules and health',
      category: 'plugin',
      handler: guarded(async () => {
        const v = P.config.validateConfig(env(), { requireTelegram: false });
        const { projects } = registry();
        const health = `\n\nHealth: config ${v.ok ? 'OK' : 'INVALID'} · ${projects.filter((p) => p.enabled).length} project(s) · max ${v.config.maxConcurrentTasks} concurrent session(s)`
          + `\nModel: ${v.summary.LLM_PROVIDER} · model ${v.summary.LLM_MODEL} · auth: ${v.config.hasApiKey ? 'API key' : 'agent login'}`
          + (v.config.guarded ? '' : '\n⚠ PiDev guard INACTIVE for this provider (see docs/SECURITY.md).');
        return { type: 'text', text: HELP + health };
      }),
    });

    ctx.log.info('PiDev plugin ready');
  },

  async teardown() {},
};
