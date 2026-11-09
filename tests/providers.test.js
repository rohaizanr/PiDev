import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.js';
import { redact } from '../src/redact.js';
import { renderClaudePolicy } from '../src/policy.js';
import { applyOpenacpSettings } from '../src/openacp.js';
import { decide } from '../src/guard.js';
import { loadRegistry } from '../src/registry.js';
import { PROVIDERS, getProvider } from '../src/providers.js';
import { makeWorkspace, GOOD_ENV } from './helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fake, correctly-shaped keys (not real credentials).
const KEYS = {
  claude: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE_test',
  openai: 'sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKE_test',
  gemini: 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE_tst',
};

test('provider table maps to OpenACP agents and only claude is guarded', () => {
  assert.equal(getProvider('claude').agent, 'claude');
  assert.equal(getProvider('openai').agent, 'codex');
  assert.equal(getProvider('gemini').agent, 'gemini');
  assert.equal(getProvider('mistral'), null);
  assert.equal(getProvider('__proto__'), null);
  assert.deepEqual(Object.entries(PROVIDERS).filter(([, p]) => p.guarded).map(([n]) => n), ['claude']);
});

test('claude is the default provider and works with login or API key', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const login = validateConfig(GOOD_ENV(ws.root));
  assert.equal(login.ok, true, login.errors.join('\n'));
  assert.equal(login.config.provider, 'claude');
  assert.equal(login.config.hasApiKey, false);
  const keyed = validateConfig({ ...GOOD_ENV(ws.root), LLM_API_KEY: KEYS.claude, LLM_MODEL: 'claude-opus-5-5' });
  assert.equal(keyed.ok, true, keyed.errors.join('\n'));
  assert.match(keyed.summary.AUTH, /apiKeyHelper/);
  assert.ok(!JSON.stringify(keyed).includes(KEYS.claude), 'key never in validation output');
});

test('unguarded providers fail closed unless explicitly allowed', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  for (const p of ['openai', 'gemini']) {
    const v = validateConfig({ ...GOOD_ENV(ws.root), LLM_PROVIDER: p, LLM_API_KEY: KEYS[p] });
    assert.equal(v.ok, false, p);
    assert.ok(v.errors.some((e) => e.includes('PIDEV_ALLOW_UNGUARDED_PROVIDER')), p);
    const ok = validateConfig({ ...GOOD_ENV(ws.root), LLM_PROVIDER: p, LLM_API_KEY: KEYS[p], PIDEV_ALLOW_UNGUARDED_PROVIDER: 'true' });
    assert.equal(ok.ok, true, ok.errors.join('\n'));
    assert.equal(ok.config.guarded, false);
    assert.ok(ok.warnings.some((w) => w.includes('Unguarded provider')));
  }
});

test('invalid provider, wrong-provider keys and bad model names are rejected without echoing keys', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  assert.equal(validateConfig({ ...GOOD_ENV(ws.root), LLM_PROVIDER: 'mistral' }).ok, false);
  const wrong = validateConfig({ ...GOOD_ENV(ws.root), LLM_PROVIDER: 'claude', LLM_API_KEY: KEYS.openai });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.some((e) => e.includes('looks like a openai key')));
  const antForOpenai = validateConfig({ ...GOOD_ENV(ws.root), LLM_PROVIDER: 'openai', PIDEV_ALLOW_UNGUARDED_PROVIDER: 'true', LLM_API_KEY: KEYS.claude });
  assert.equal(antForOpenai.ok, false);
  const gemWrong = validateConfig({ ...GOOD_ENV(ws.root), LLM_PROVIDER: 'gemini', PIDEV_ALLOW_UNGUARDED_PROVIDER: 'true', LLM_API_KEY: 'not-a-key-123456789012345' });
  assert.equal(gemWrong.ok, false);
  for (const v of [wrong, antForOpenai, gemWrong]) assert.ok(!JSON.stringify(v).match(/sk-ant-api03-FAKE|sk-proj-FAKE|not-a-key-1234/));
  assert.equal(validateConfig({ ...GOOD_ENV(ws.root), LLM_MODEL: 'opus; rm -rf /' }).ok, false);
  const odd = validateConfig({ ...GOOD_ENV(ws.root), LLM_MODEL: 'gpt-5' });
  assert.equal(odd.ok, true);
  assert.ok(odd.warnings.some((w) => w.includes('does not look like')));
});

test('legacy provider env vars produce a warning', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const v = validateConfig({ ...GOOD_ENV(ws.root), ANTHROPIC_API_KEY: KEYS.claude });
  assert.ok(v.warnings.some((w) => w.includes('ANTHROPIC_API_KEY is set but is not used')));
});

test('redaction covers Anthropic, OpenAI and Google keys', () => {
  const r = redact(`a=${KEYS.claude} b=${KEYS.openai} c=${KEYS.gemini} d=sk-abcdefghijklmnopqrstuvwx`);
  for (const k of Object.values(KEYS)) assert.ok(!r.includes(k));
  assert.ok(!r.includes('sk-abcdefghijklmnopqrstuvwx'));
});

test('managed policy: apiKeyHelper and model only when requested', () => {
  const base = { pidevHome: '/home/u/pidev-agent', nodePath: '/usr/bin/node', workspaceRoot: '/home/u/projects', home: '/home/u', sandbox: true };
  const plain = renderClaudePolicy(base);
  assert.equal(plain.apiKeyHelper, undefined);
  assert.equal(plain.model, undefined);
  const keyed = renderClaudePolicy({ ...base, apiKeyHelper: true, model: 'claude-opus-5-5' });
  assert.equal(keyed.apiKeyHelper, '/usr/bin/node /home/u/pidev-agent/bin/pidev-apikey.js');
  assert.equal(keyed.model, 'claude-opus-5-5');
  assert.ok(keyed.permissions.deny.includes('Read(//proc/**)'));
  assert.throws(() => renderClaudePolicy({ ...base, model: 'x"; evil' }));
});

test('guard blocks the agent from touching keys, helpers and /proc environ', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const { projects } = loadRegistry(ws.registryFile, { workspaceRoot: ws.root });
  const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: path.join(ws.root, 'alpha'), session_id: 's' }, { projects }).decision;
  for (const c of ['node ~/pidev-agent/bin/pidev-apikey.js', 'echo $LLM_API_KEY', 'echo $ANTHROPIC_API_KEY', 'cat /proc/1234/environ', "tr '\\0' '\\n' < /proc/$PPID/environ", 'cat ~/.codex/auth.json', 'cat ~/.gemini/oauth_creds.json']) {
    assert.equal(run(c), 'deny', c);
  }
  assert.equal(run('npm test'), 'pass');
  assert.equal(run('grep -rn OPENAI_API_KEY src'), 'pass', 'searching code for env var names is fine');
  assert.equal(run('printenv OPENACP_TELEGRAM_BOT_TOKEN'), 'deny');
});

test('apply openacp: default agent and agents.json env per provider', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const inst = path.join(ws.root, '.openacp');
  fs.mkdirSync(path.join(inst, 'plugins', 'data', '@openacp', 'security'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'config.json'), JSON.stringify({ defaultAgent: 'claude' }));
  const agentsFile = path.join(inst, 'agents.json');
  const installed = {
    claude: { command: 'claude-agent-acp', env: { ANTHROPIC_API_KEY: 'sk-ant-stale-leftover-key-123456789' } },
    codex: { command: 'codex-acp', env: {} },
    gemini: { command: 'npx', env: { OTHER: 'keep' } },
  };
  fs.writeFileSync(agentsFile, JSON.stringify({ version: 1, installed }));
  const base = { workspaceRoot: ws.root, allowedUserIds: ['111111111'], maxConcurrentTasks: 1 };
  const read = () => JSON.parse(fs.readFileSync(agentsFile, 'utf8')).installed;
  const conf = () => JSON.parse(fs.readFileSync(path.join(inst, 'config.json'), 'utf8'));

  // gemini with key + model
  const r1 = applyOpenacpSettings({ ...base, provider: 'gemini', model: 'gemini-2.5-pro' }, { apiKey: KEYS.gemini });
  assert.equal(conf().defaultAgent, 'gemini');
  assert.equal(read().gemini.env.GEMINI_API_KEY, KEYS.gemini);
  assert.equal(read().gemini.env.GEMINI_MODEL, 'gemini-2.5-pro');
  assert.equal(read().gemini.env.OTHER, 'keep', 'unrelated env preserved');
  assert.equal(read().claude.env.ANTHROPIC_API_KEY, undefined, 'stale claude key removed');
  assert.ok(!r1.changes.join('\n').includes(KEYS.gemini), 'change log never contains the key');
  assert.equal(fs.statSync(agentsFile).mode & 0o777, 0o600);

  // switch to openai: gemini key/model removed, codex key set
  applyOpenacpSettings({ ...base, provider: 'openai' }, { apiKey: KEYS.openai });
  assert.equal(conf().defaultAgent, 'codex');
  assert.equal(read().codex.env.OPENAI_API_KEY, KEYS.openai);
  assert.equal(read().gemini.env.GEMINI_API_KEY, undefined);
  assert.equal(read().gemini.env.GEMINI_MODEL, undefined);

  // switch to claude with a key: key is NOT written to agent env (apiKeyHelper instead)
  applyOpenacpSettings({ ...base, provider: 'claude' }, { apiKey: KEYS.claude });
  assert.equal(conf().defaultAgent, 'claude');
  assert.equal(read().claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(read().codex.env.OPENAI_API_KEY, undefined);
  assert.equal(applyOpenacpSettings({ ...base, provider: 'claude' }, { apiKey: KEYS.claude }).changes.length, 0, 'idempotent');

  // agent not installed
  delete installed.codex;
  fs.writeFileSync(agentsFile, JSON.stringify({ version: 1, installed }));
  assert.throws(() => applyOpenacpSettings({ ...base, provider: 'openai' }, { apiKey: KEYS.openai }), /agents install codex/);
});

test('pidev-apikey helper prints the claude key only, and fails closed otherwise', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const home = path.join(ws.base, 'home');
  for (const d of ['bin', 'src']) fs.cpSync(path.join(REPO, d), path.join(home, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(home, 'package.json'));
  const run = (envText) => {
    fs.writeFileSync(path.join(home, '.env'), envText, { mode: 0o600 });
    return spawnSync(process.execPath, [path.join(home, 'bin', 'pidev-apikey.js')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  };
  const ok = run(`LLM_PROVIDER=claude\nLLM_API_KEY=${KEYS.claude}\n`);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, KEYS.claude);
  const none = run('LLM_PROVIDER=claude\n');
  assert.equal(none.status, 1); assert.equal(none.stdout, '');
  const other = run(`LLM_PROVIDER=openai\nLLM_API_KEY=${KEYS.openai}\n`);
  assert.equal(other.status, 1); assert.equal(other.stdout, '');
  assert.ok(!other.stderr.includes(KEYS.openai));
  const bad = run('LLM_PROVIDER=claude\nLLM_API_KEY=garbage-value-not-a-key\n');
  assert.equal(bad.status, 1); assert.ok(!bad.stderr.includes('garbage-value'));
});

test('plugin /project uses the provider agent and warns when unguarded', async (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const home = path.join(ws.base, 'pidev-home');
  for (const d of ['bin', 'src', 'plugin']) fs.cpSync(path.join(REPO, d), path.join(home, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(home, 'package.json'));
  fs.mkdirSync(path.join(home, 'config'));
  fs.copyFileSync(ws.registryFile, path.join(home, 'config', 'projects.json'));
  const env = { ...GOOD_ENV(ws.root), LLM_PROVIDER: 'gemini', LLM_API_KEY: KEYS.gemini, PIDEV_ALLOW_UNGUARDED_PROVIDER: 'true' };
  fs.writeFileSync(path.join(home, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const prev = process.env.PIDEV_HOME;
  process.env.PIDEV_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.PIDEV_HOME; else process.env.PIDEV_HOME = prev; });
  const { default: plugin } = await import(path.join(home, 'plugin', 'index.js') + '?provider');
  const commands = {};
  await plugin.setup({ log: { info() {}, warn() {}, error() {} }, registerCommand: (d) => { commands[d.name] = d; }, registerMiddleware() {}, sessions: { getSession: () => undefined } });
  const owner = { userId: '111111111', channelId: 'telegram', sessionId: null };
  const reply = (await commands.project.handler({ ...owner, raw: 'alpha' })).text;
  assert.match(reply, /\/new gemini \//);
  assert.match(reply, /NOT covered by the PiDev guard/);
  const help = (await commands.pidev.handler({ ...owner, raw: '' })).text;
  assert.match(help, /gemini -> gemini agent \(UNGUARDED\)/);
  assert.match(help, /guard INACTIVE/);
  assert.ok(!help.includes(KEYS.gemini));
});
