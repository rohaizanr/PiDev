#!/usr/bin/env node
// Claude Code hook entry point (PreToolUse + SessionEnd). Fail closed:
// any error => exit 2 (block) with a short reason on stderr.
import fs from 'node:fs';
import path from 'node:path';
import { PIDEV_HOME, loadEnv } from '../src/config.js';
import { loadRegistry } from '../src/registry.js';
import { LockStore } from '../src/locks.js';
import { decide } from '../src/guard.js';
import { redact, secretValuesFromEnv } from '../src/redact.js';

const MAX_LOG_BYTES = 1_000_000;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function audit(env, entry) {
  try {
    const dir = path.join(PIDEV_HOME, 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'guard.log');
    try { if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* none yet */ }
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), ...entry }), secretValuesFromEnv(env));
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
  } catch { /* auditing must never break the decision */ }
}

function block(reason) {
  process.stderr.write(reason + '\n');
  process.exit(2);
}

let env = {};
try {
  env = loadEnv();
  const raw = readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { block('PiDev guard: unreadable hook input; refusing (fail closed).'); }
  const event = input.hook_event_name ?? 'PreToolUse';
  const ttlMs = Number(env.PIDEV_LOCK_TTL_MINUTES || 30) * 60_000;
  const locks = new LockStore(path.join(PIDEV_HOME, 'state', 'locks'), { ttlMs });

  if (event === 'SessionEnd') {
    const n = locks.releaseSession(String(input.session_id ?? ''));
    audit(env, { event, session: String(input.session_id ?? '').slice(0, 12), released: n });
    process.exit(0);
  }
  if (event !== 'PreToolUse') process.exit(0);

  const registryFile = path.join(PIDEV_HOME, 'config', 'projects.json');
  const { projects } = loadRegistry(registryFile, { workspaceRoot: env.PIDEV_WORKSPACE_ROOT, pidevHome: PIDEV_HOME });
  const result = decide(input, { projects, locks });

  const base = { event, session: String(input.session_id ?? '').slice(0, 12), project: result.project ?? null, tool: input.tool_name, decision: result.decision };
  if (result.decision === 'deny') {
    audit(env, { ...base, reason: result.reason, command: typeof input.tool_input?.command === 'string' ? input.tool_input.command.slice(0, 200) : undefined });
    block(result.reason);
  }
  if (result.decision === 'ask') {
    audit(env, { ...base, reason: result.reason, command: typeof input.tool_input?.command === 'string' ? input.tool_input.command.slice(0, 200) : undefined });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: result.reason },
    }));
    process.exit(0);
  }
  process.exit(0);
} catch (e) {
  audit(env, { event: 'error', error: String(e?.message ?? e).slice(0, 200) });
  block('PiDev guard: internal error; refusing (fail closed). See logs/guard.log.');
}
