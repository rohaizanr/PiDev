// Zero-dependency lint: syntax-check every JS file and every shell script,
// and refuse obviously committed secrets.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const skip = new Set(['node_modules', '.git', 'state', 'logs', 'backups', '.openacp']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  if (/\.(m?js)$/.test(f)) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { failed++; console.error(`syntax: ${f}\n${r.stderr}`); }
  }
  if (f.endsWith('.sh')) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    if (r.status !== 0) { failed++; console.error(`bash -n: ${f}\n${r.stderr}`); }
  }
  // Secret scan covers committed files only: the real .env and the local registry are
  // git-ignored and legitimately contain secrets/paths on the Pi.
  const base = path.basename(f);
  const ignoredLocal = (base.startsWith('.env') && base !== '.env.example') || f === path.join(root, 'config', 'projects.json');
  if (!ignoredLocal && (/\.(js|mjs|sh|json|md|service|example|template|in)$/.test(f) || base === '.env.example')) {
    const text = fs.readFileSync(f, 'utf8');
    const hit = /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b|sk-ant-(api|oat)\d{2}-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(text);
    if (hit && !f.includes(`${path.sep}tests${path.sep}`)) { failed++; console.error(`possible secret in ${path.relative(root, f)}`); }
  }
}
console.log(failed ? `lint: ${failed} problem(s)` : `lint: ${files.length} files OK`);
process.exit(failed ? 1 : 0);
