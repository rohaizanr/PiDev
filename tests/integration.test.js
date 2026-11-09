import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact, describeSecret } from '../src/redact.js';
import { renderClaudePolicy } from '../src/policy.js';
import { applyOpenacpSettings } from '../src/openacp.js';
import { makeWorkspace, GOOD_ENV } from './helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = GOOD_ENV('/x').OPENACP_TELEGRAM_BOT_TOKEN;

/** A throwaway PIDEV_HOME containing copies of bin/ src/ plugin/ and a test .env + registry. */
function makeHome(t, ws, envOverrides = {}) {
  const home = path.join(ws.base, 'pidev-home');
  for (const d of ['bin', 'src', 'plugin']) fs.cpSync(path.join(REPO, d), path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'package.json'), fs.readFileSync(path.join(REPO, 'package.json')));
  fs.mkdirSync(path.join(home, 'config'));
  fs.copyFileSync(ws.registryFile, path.join(home, 'config', 'projects.json'));
  const env = { ...GOOD_ENV(ws.root), ...envOverrides };
  fs.writeFileSync(path.join(home, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return home;
}

function cleanEnv() {
  const e = { PATH: process.env.PATH, HOME: process.env.HOME };
  return e;
}

// 10. secrets redacted from status output and logs
test('redaction removes tokens, keys and known secret values', () => {
  const s = `token=${TOKEN} key=sk-ant-api03-abcdefghijklmnop Authorization: Bearer abc.def.ghi123456789 custom=hunter2-secret`;
  const r = redact(s, ['hunter2-secret']);
  assert.ok(!r.includes(TOKEN));
  assert.ok(!r.includes('sk-ant-api03'));
  assert.ok(!r.includes('abc.def.ghi123456789'));
  assert.ok(!r.includes('hunter2-secret'));
  assert.equal(describeSecret(TOKEN), `set (${TOKEN.length} chars)`);
});

test('pidev status / validate never print the bot token', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const home = makeHome(t, ws);
  for (const args of [['status'], ['status', '--json'], ['validate']]) {
    const r = spawnSync(process.execPath, [path.join(home, 'bin', 'pidev.js'), ...args], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN), `token leaked in ${args.join(' ')}`);
    assert.ok(!(r.stdout + r.stderr).includes('AAFakeToken'));
  }
  const red = spawnSync(process.execPath, [path.join(home, 'bin', 'pidev.js'), 'redact'], { input: `log line ${TOKEN}\n`, encoding: 'utf8', env: cleanEnv() });
  assert.ok(!red.stdout.includes(TOKEN));
});

test('pidev validate fails closed without owner ids', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const home = makeHome(t, ws, { PIDEV_ALLOWED_USER_IDS: '' });
  const r = spawnSync(process.execPath, [path.join(home, 'bin', 'pidev.js'), 'validate'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fails closed/);
});

test('guard hook process: exit 2 on deny, ask JSON on ask, audit log has no secrets', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const home = makeHome(t, ws);
  const guard = path.join(home, 'bin', 'pidev-guard.js');
  const alpha = path.join(ws.root, 'alpha');
  const hook = (input) => spawnSync(process.execPath, [guard], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: alpha, ...input }), encoding: 'utf8', env: cleanEnv() });

  const pass = hook({ tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  assert.equal(pass.status, 0); assert.equal(pass.stdout, '');

  const deny = hook({ tool_name: 'Bash', tool_input: { command: `sudo echo ${TOKEN}` } });
  assert.equal(deny.status, 2); assert.match(deny.stderr, /privilege escalation/);

  const ask = hook({ tool_name: 'Bash', tool_input: { command: 'npm install' } });
  assert.equal(ask.status, 0);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask');

  const outside = hook({ tool_name: 'Read', tool_input: { file_path: 'x' }, cwd: ws.outside });
  assert.equal(outside.status, 2);

  const garbage = spawnSync(process.execPath, [guard], { input: 'not json', encoding: 'utf8', env: cleanEnv() });
  assert.equal(garbage.status, 2, 'fail closed on bad input');

  // lock then SessionEnd releases it
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: 'a.js' } }).status, 0);
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: 'a.js' }, session_id: 's2' }).status, 2);
  spawnSync(process.execPath, [guard], { input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: alpha }), encoding: 'utf8', env: cleanEnv() });
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: 'a.js' }, session_id: 's2' }).status, 0);

  const log = fs.readFileSync(path.join(home, 'logs', 'guard.log'), 'utf8');
  assert.ok(log.includes('"decision":"deny"'));
  assert.ok(!log.includes(TOKEN), 'token redacted from audit log');
});

test('OpenACP plugin: fail-closed middleware and project commands', async (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const home = makeHome(t, ws);
  const prev = process.env.PIDEV_HOME;
  process.env.PIDEV_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.PIDEV_HOME; else process.env.PIDEV_HOME = prev; });

  const { default: plugin } = await import(path.join(home, 'plugin', 'index.js'));
  const commands = {}; let middleware;
  const sessions = { 's-alpha': { workingDirectory: path.join(ws.root, 'alpha') }, 's-root': { workingDirectory: ws.root } };
  const ctx = {
    log: { info() {}, warn() {}, error() {} },
    registerCommand: (d) => { commands[d.name] = d; },
    registerMiddleware: (hook, o) => { assert.equal(hook, 'message:incoming'); middleware = o.handler; },
    sessions: { getSession: (id) => sessions[id] },
  };
  await plugin.setup(ctx);
  assert.deepEqual(Object.keys(commands).sort(), ['pidev', 'project', 'projects', 'where']);

  const next = async () => 'passed';
  assert.equal(await middleware({ userId: '111111111', channelId: 'telegram' }, next), 'passed');
  assert.equal(await middleware({ userId: '999', channelId: 'telegram' }, next), null);
  assert.equal(await middleware({ userId: undefined }, next), null);

  const owner = { userId: '111111111', channelId: 'telegram', sessionId: null };
  assert.match((await commands.projects.handler({ ...owner, raw: '' })).text, /alpha — Alpha app[\s\S]*beta/);
  assert.match((await commands.project.handler({ ...owner, raw: 'alpha' })).text, new RegExp(`/new claude ${path.join(ws.root, 'alpha').replace(/[/.]/g, '\\$&')}`));
  assert.match((await commands.project.handler({ ...owner, raw: 'nope' })).text, /Unknown or disabled/);
  assert.match((await commands.project.handler({ ...owner, raw: '../../etc' })).text, /Unknown or disabled/);
  assert.match((await commands.where.handler({ ...owner, sessionId: 's-alpha' })).text, /Project: alpha/);
  assert.match((await commands.where.handler({ ...owner, sessionId: 's-root' })).text, /NOT a registered project/);
  assert.equal(await commands.projects.handler({ userId: '999', raw: '' }), undefined, 'strangers get no reply');
  const help = (await commands.pidev.handler({ ...owner, raw: '' })).text;
  assert.match(help, /Health: config OK/);
  assert.ok(!help.includes(TOKEN));
});

test('plugin blocks everything when PiDev cannot load', async (t) => {
  const prev = process.env.PIDEV_HOME;
  delete process.env.PIDEV_HOME;
  t.after(() => { if (prev !== undefined) process.env.PIDEV_HOME = prev; });
  const { default: plugin } = await import(path.join(REPO, 'plugin', 'index.js') + '?noenv');
  let mw; const cmds = [];
  await plugin.setup({ log: { info() {}, warn() {}, error() {} }, registerMiddleware: (h, o) => { mw = o.handler; }, registerCommand: (d) => cmds.push(d) });
  assert.equal(await mw({ userId: '111111111' }, async () => 'passed'), null);
  assert.equal(cmds.length, 0);
});

test('managed Claude Code policy: bypass disabled, guard hook wired, secrets denied', () => {
  const p = renderClaudePolicy({ pidevHome: '/home/u/pidev-agent', nodePath: '/usr/bin/node', workspaceRoot: '/home/u/projects', home: '/home/u', sandbox: true });
  assert.equal(p.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(p.permissions.defaultMode, 'default');
  assert.equal(p.allowManagedHooksOnly, true);
  assert.equal(p.hooks.PreToolUse[0].hooks[0].command, '/usr/bin/node /home/u/pidev-agent/bin/pidev-guard.js');
  assert.ok(p.permissions.deny.includes('Read(//home/u/projects/.openacp/**)'));
  assert.ok(p.permissions.deny.includes('Bash(sudo *)'));
  assert.ok(p.permissions.ask.includes('Bash(npm install)'));
  assert.equal(p.sandbox.autoAllowBashIfSandboxed, false);
  assert.ok(!JSON.stringify(p).includes('bypassPermissions"'), 'never sets bypass mode');
  assert.throws(() => renderClaudePolicy({ pidevHome: 'rel', nodePath: '/n', workspaceRoot: '/w', home: '/h' }));
});

test('applyOpenacpSettings locks down an OpenACP instance and refuses empty allowlists', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const inst = path.join(ws.root, '.openacp');
  fs.mkdirSync(path.join(inst, 'plugins', 'data', '@openacp', 'security'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'plugins', 'data', '@openacp', 'tunnel'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'config.json'), JSON.stringify({ defaultAgent: 'claude', runMode: 'daemon', workspace: { allowExternalWorkspaces: true } }));
  fs.writeFileSync(path.join(inst, 'plugins', 'data', '@openacp', 'security', 'settings.json'), JSON.stringify({ allowedUserIds: [], maxConcurrentSessions: 20 }));
  fs.writeFileSync(path.join(inst, 'plugins', 'data', '@openacp', 'tunnel', 'settings.json'), JSON.stringify({ enabled: true }));
  const cfg = { workspaceRoot: ws.root, allowedUserIds: ['111111111'], maxConcurrentTasks: 1 };

  const dry = applyOpenacpSettings(cfg, { dryRun: true });
  assert.ok(dry.changes.length >= 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst, 'config.json'), 'utf8')).runMode, 'daemon', 'dry run writes nothing');

  applyOpenacpSettings(cfg);
  const conf = JSON.parse(fs.readFileSync(path.join(inst, 'config.json'), 'utf8'));
  const sec = JSON.parse(fs.readFileSync(path.join(inst, 'plugins', 'data', '@openacp', 'security', 'settings.json'), 'utf8'));
  const tun = JSON.parse(fs.readFileSync(path.join(inst, 'plugins', 'data', '@openacp', 'tunnel', 'settings.json'), 'utf8'));
  assert.equal(conf.workspace.allowExternalWorkspaces, false);
  assert.equal(conf.runMode, 'foreground');
  assert.deepEqual(sec.allowedUserIds, ['111111111']);
  assert.equal(sec.maxConcurrentSessions, 1);
  assert.equal(tun.enabled, false);
  assert.equal(applyOpenacpSettings(cfg).changes.length, 0, 'idempotent');
  assert.throws(() => applyOpenacpSettings({ ...cfg, allowedUserIds: [] }), /allow everyone/);
});
