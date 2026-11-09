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
  if (/\.(js|mjs|sh|json|md|service|example|template)$/.test(f) || path.basename(f).startsWith('.env')) {
    const text = fs.readFileSync(f, 'utf8');
    const hit = /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b|sk-ant-(api|oat)\d{2}-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(text);
    if (hit && !f.includes(`${path.sep}tests${path.sep}`)) { failed++; console.error(`possible secret in ${path.relative(root, f)}`); }
  }
}
if (path.basename(root) && fs.existsSync(path.join(root, '.env'))) console.warn('note: a local .env exists in the source tree; it is git-ignored and excluded from deploys.');
console.log(failed ? `lint: ${failed} problem(s)` : `lint: ${files.length} files OK`);
process.exit(failed ? 1 : 0);
