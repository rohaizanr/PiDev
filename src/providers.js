// LLM provider -> OpenACP coding agent mapping.
//
// Claude Code only talks to Claude models, so choosing OpenAI or Gemini means
// running a DIFFERENT coding agent (Codex / Gemini CLI) through OpenACP.
// PiDev's per-tool guard and managed policy are Claude Code features, so only
// the `claude` provider is "guarded". The others require an explicit
// PIDEV_ALLOW_UNGUARDED_PROVIDER=true.
//
// Agent names, key env vars and dependencies verified against
// @openacp/cli 2026.518.2 (REGISTRY_AGENT_ALIASES, AGENT_SETUP, registry snapshot).

export const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    label: 'Anthropic Claude (Claude Code)',
    agent: 'claude',                 // OpenACP alias of registry id "claude-acp"
    guarded: true,                   // PiDev guard hook + managed policy apply
    keyEnv: 'ANTHROPIC_API_KEY',     // informational: PiDev delivers the key via apiKeyHelper, NOT env
    keyDelivery: 'apiKeyHelper',
    keyRe: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    keyHint: 'an Anthropic Console key starting with "sk-ant-"',
    modelDelivery: 'managed-policy', // Claude Code `model` setting
    modelEnv: null,
    modelRe: /^(claude-[a-z0-9.-]+|opus|sonnet|haiku|opusplan|default|best)(\[1m\])?$/i,
    modelHint: 'a Claude model ID (e.g. claude-opus-5-5) or alias (opus, sonnet, haiku)',
    loginHint: 'claude auth login',
    cliDependency: { command: 'claude', install: 'scripts/install.sh (native installer) or npm install -g @anthropic-ai/claude-code' },
  }),
  openai: Object.freeze({
    label: 'OpenAI (Codex CLI via codex-acp)',
    agent: 'codex',                  // alias of registry id "codex-acp" (linux-aarch64 binary available)
    guarded: false,
    keyEnv: 'OPENAI_API_KEY',
    keyDelivery: 'agent-env',        // written to <instance>/agents.json installed.codex.env
    keyRe: /^sk-[A-Za-z0-9_-]{20,}$/,
    keyHint: 'an OpenAI key starting with "sk-"',
    modelDelivery: 'manual',         // not applied automatically (codex-acp model flag unverified)
    modelEnv: null,
    modelRe: /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/,
    modelHint: 'an OpenAI model ID; set it in ~/.codex/config.toml (model = "...")',
    loginHint: 'codex  (choose "Sign in with ChatGPT")',
    cliDependency: { command: 'codex', install: 'npm install -g @openai/codex' },
  }),
  gemini: Object.freeze({
    label: 'Google Gemini (Gemini CLI)',
    agent: 'gemini',                 // registry id "gemini" (npx @google/gemini-cli --acp)
    guarded: false,
    keyEnv: 'GEMINI_API_KEY',
    keyDelivery: 'agent-env',        // written to <instance>/agents.json installed.gemini.env
    keyRe: /^AIza[0-9A-Za-z_-]{30,}$/,
    keyHint: 'a Google AI Studio key starting with "AIza"',
    modelDelivery: 'agent-env',
    modelEnv: 'GEMINI_MODEL',
    modelRe: /^gemini-[a-z0-9.-]+$/i,
    modelHint: 'a Gemini model ID starting with "gemini-"',
    loginHint: 'openacp agents run gemini --dir "$PIDEV_WORKSPACE_ROOT"  (Sign in with Google)',
    cliDependency: null,
  }),
});

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

/** @returns {typeof PROVIDERS[keyof typeof PROVIDERS] | null} */
export function getProvider(name) {
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
}

/** Env vars PiDev manages inside OpenACP agent entries (removed from non-selected agents). */
export function managedAgentEnvKeys() {
  const out = {};
  for (const p of Object.values(PROVIDERS)) {
    out[p.agent] = [p.keyEnv, p.modelEnv].filter(Boolean);
  }
  return out;
}

/**
 * Describe how the selected provider authenticates (never includes the key).
 * @param {string} name
 * @param {boolean} hasKey
 */
export function authMode(name, hasKey) {
  const p = getProvider(name);
  if (!p) return 'unknown provider';
  if (!hasKey) return `${p.agent} login (${p.loginHint})`;
  return p.keyDelivery === 'apiKeyHelper' ? 'API key via Claude Code apiKeyHelper (not in agent environment)' : `API key via OpenACP agent env (${p.keyEnv})`;
}
