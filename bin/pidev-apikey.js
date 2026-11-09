#!/usr/bin/env node
// Claude Code `apiKeyHelper` for PiDev (configured in the root-owned managed
// policy). Prints the Anthropic API key from PiDev's .env to stdout and
// nothing else, so the key never has to live in the agent's environment where
// shell commands could read it. Errors never include the key.
import { loadEnv } from '../src/config.js';
import { PROVIDERS } from '../src/providers.js';

const env = loadEnv();
const fail = (msg) => { process.stderr.write(`pidev-apikey: ${msg}\n`); process.exit(1); };

if ((env.LLM_PROVIDER || 'claude').trim().toLowerCase() !== 'claude') fail('LLM_PROVIDER is not "claude"; refusing to hand out a key.');
const key = (env.LLM_API_KEY ?? '').trim();
if (!key) fail('LLM_API_KEY is not set (use `claude auth login` instead, or run scripts/configure.sh).');
if (!PROVIDERS.claude.keyRe.test(key)) fail('LLM_API_KEY does not look like an Anthropic key.');
process.stdout.write(key);
