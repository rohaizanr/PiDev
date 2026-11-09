// Renders the Claude Code managed-settings drop-in that PiDev installs on the
// Pi at /etc/claude-code/managed-settings.d/50-pidev.json (root-owned, so the
// agent cannot modify it). Managed settings take precedence over user/project
// settings and their deny rules always win.
import path from 'node:path';

/** Claude Code absolute-path rule prefix: "//abs/path". */
const abs = (p) => '/' + path.resolve(p);

const PM = ['npm', 'pnpm', 'yarn'];
const SCRIPTS = ['test', 'lint', 'build', 'typecheck', 'check', 'format:check'];

/**
 * @param {{ pidevHome: string, nodePath: string, workspaceRoot: string, home: string, sandbox: boolean,
 *            apiKeyHelper?: boolean, model?: string|null }} o
 *   apiKeyHelper: render `apiKeyHelper` (LLM_PROVIDER=claude with LLM_API_KEY set)
 *   model: Claude model to pin (LLM_PROVIDER=claude with LLM_MODEL set)
 */
export function renderClaudePolicy({ pidevHome, nodePath, workspaceRoot, home, sandbox, apiKeyHelper = false, model = null }) {
  for (const [k, v] of Object.entries({ pidevHome, nodePath, workspaceRoot, home })) {
    if (!v || !path.isAbsolute(v)) throw new Error(`${k} must be an absolute path`);
  }
  const instanceDir = path.join(workspaceRoot, '.openacp');
  const guard = `${quote(nodePath)} ${quote(path.join(pidevHome, 'bin', 'pidev-guard.js'))}`;

  const allow = [
    'Read(./**)',
    'Edit(./**)',
    'Bash(git status)', 'Bash(git status *)', 'Bash(git diff)', 'Bash(git diff *)',
    'Bash(git log *)', 'Bash(git show *)', 'Bash(git branch)', 'Bash(git branch --list *)',
    'Bash(ls)', 'Bash(ls *)', 'Bash(pwd)',
  ];
  for (const pm of PM) {
    allow.push(`Bash(${pm} test)`, `Bash(${pm} test *)`);
    for (const s of SCRIPTS) allow.push(`Bash(${pm} run ${s})`, `Bash(${pm} run ${s} *)`);
  }

  const ask = [
    'Bash(git commit *)', 'Bash(git push *)', 'Bash(git push)', 'Bash(git reset *)', 'Bash(git clean *)',
    'Bash(git stash *)', 'Bash(git rebase *)', 'Bash(git merge *)', 'Bash(git checkout -- *)', 'Bash(git restore *)',
    'Bash(rm *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(ssh *)', 'Bash(scp *)', 'Bash(rsync *)',
    'Bash(npx *)', 'Bash(docker *)', 'Bash(gh *)', 'WebFetch',
  ];
  for (const pm of PM) {
    for (const sub of ['install', 'i', 'ci', 'add', 'remove', 'uninstall', 'update', 'upgrade', 'publish', 'link']) {
      ask.push(`Bash(${pm} ${sub})`, `Bash(${pm} ${sub} *)`);
    }
  }

  const deny = [
    'Bash(sudo *)', 'Bash(su *)', 'Bash(doas *)', 'Bash(pkexec *)',
    'Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git push --force-with-lease *)',
    'Bash(openacp *)', 'Bash(systemctl *)', 'Bash(apt *)', 'Bash(apt-get *)',
    'Read(**/.env)', 'Read(**/.env.local)', 'Read(**/.env.production)', 'Read(**/.env.development)',
    'Edit(**/.env)', 'Edit(**/.env.*)',
    'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/.npmrc)', 'Read(**/.netrc)', 'Read(**/.git-credentials)',
    'Edit(**/.git/**)', 'Edit(**/.claude/**)', 'Edit(**/.mcp.json)',
    'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.gnupg/**)', 'Read(~/.config/gcloud/**)',
    'Read(~/.claude/.credentials.json)', 'Edit(~/.claude/**)',
    'Edit(~/.bashrc)', 'Edit(~/.profile)', 'Edit(~/.bash_profile)', 'Edit(~/.zshrc)', 'Edit(~/.ssh/**)',
    `Read(${abs(instanceDir)}/**)`, `Edit(${abs(instanceDir)}/**)`,
    `Read(${abs(pidevHome)}/.env)`, `Edit(${abs(pidevHome)}/**)`,
    'Read(~/.codex/**)', 'Read(~/.gemini/**)', 'Read(//proc/**)',
  ];

  const denyReadPaths = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud', '~/.claude/.credentials.json', '~/.codex', '~/.gemini', instanceDir, path.join(pidevHome, '.env')];

  const policy = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: {
      defaultMode: 'default',
      disableBypassPermissionsMode: 'disable',
      disableAutoMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      allow,
      ask,
      deny,
    },
    // Repository-provided hooks and MCP servers are untrusted (prompt-injection / code-execution vectors).
    allowManagedHooksOnly: true,
    enableAllProjectMcpServers: false,
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guard, timeout: 15 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: guard, timeout: 15 }] }],
    },
    sandbox: {
      enabled: Boolean(sandbox),
      failIfUnavailable: Boolean(sandbox),
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: { denyRead: denyReadPaths },
      network: {
        allowedDomains: ['registry.npmjs.org', 'registry.yarnpkg.com', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com'],
      },
    },
  };
  if (apiKeyHelper) {
    // Claude Code runs this to obtain the API key; the key is never placed in
    // the agent's environment (OpenACP would not pass it through anyway).
    policy.apiKeyHelper = `${quote(nodePath)} ${quote(path.join(pidevHome, 'bin', 'pidev-apikey.js'))}`;
  }
  if (model) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,99}$/.test(model)) throw new Error('invalid model name');
    policy.model = model;
  }
  return policy;
}

function quote(p) {
  return /^[A-Za-z0-9_./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
