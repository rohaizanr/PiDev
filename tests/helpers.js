import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Build a disposable workspace: root/{alpha,beta}, an outside dir, and a symlink escape. */
export function makeWorkspace() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pidev-test-')));
  const root = path.join(base, 'projects');
  const outside = path.join(base, 'outside');
  for (const d of [root, outside, path.join(root, 'alpha', 'src'), path.join(root, 'beta')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'README.md'), '# alpha\n');
  fs.writeFileSync(path.join(root, 'alpha', '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x\n');
  fs.symlinkSync(outside, path.join(root, 'evil'));
  fs.symlinkSync(outside, path.join(root, 'alpha', 'link-out'));
  const registryFile = path.join(base, 'projects.json');
  const registry = {
    version: 1,
    projects: [
      { name: 'alpha', path: path.join(root, 'alpha'), enabled: true, description: 'Alpha app' },
      { name: 'beta', path: path.join(root, 'beta'), enabled: true },
    ],
  };
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  return { base, root, outside, registryFile, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export const GOOD_ENV = (root) => ({
  OPENACP_TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn',
  OPENACP_TELEGRAM_CHAT_ID: '-1001234567890',
  PIDEV_ALLOWED_USER_IDS: '111111111',
  PIDEV_WORKSPACE_ROOT: root,
  PIDEV_MAX_CONCURRENT_TASKS: '1',
});
