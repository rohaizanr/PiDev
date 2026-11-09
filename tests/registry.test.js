import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, findByName, findByDirectory, addProject, isPathInsideProject, validateEntry } from '../src/registry.js';
import { makeWorkspace } from './helpers.js';

// 4. registry accepts a valid project
test('valid projects load with canonical paths', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const { projects, errors } = loadRegistry(ws.registryFile, { workspaceRoot: ws.root });
  assert.deepEqual(errors, []);
  assert.deepEqual(projects.map((p) => p.name), ['alpha', 'beta']);
  assert.equal(findByName(projects, 'alpha').canonicalPath, path.join(ws.root, 'alpha'));
});

// 5. unknown project rejected
test('unknown, disabled and malformed names are rejected', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const data = JSON.parse(fs.readFileSync(ws.registryFile, 'utf8'));
  data.projects[1].enabled = false;
  fs.writeFileSync(ws.registryFile, JSON.stringify(data));
  const { projects } = loadRegistry(ws.registryFile, { workspaceRoot: ws.root });
  assert.equal(findByName(projects, 'gamma'), null);
  assert.equal(findByName(projects, 'beta'), null, 'disabled');
  assert.equal(findByName(projects, '../alpha'), null);
  assert.equal(findByName(projects, 'ALPHA').name, 'alpha', 'case-insensitive lookup of a valid slug');
});

// 6. path traversal rejected
test('path traversal is rejected', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const r = validateEntry({ name: 'trav', path: ws.root + '/alpha/../../outside' }, { workspaceRoot: ws.root });
  assert.match(r.error, /\.\./);
  const { projects } = loadRegistry(ws.registryFile, { workspaceRoot: ws.root });
  const alpha = findByName(projects, 'alpha');
  assert.equal(isPathInsideProject('../beta/x', alpha.canonicalPath, alpha), false);
  assert.equal(isPathInsideProject('src/../../../outside/secret.txt', alpha.canonicalPath, alpha), false);
  assert.equal(isPathInsideProject('src/new-file.js', alpha.canonicalPath, alpha), true);
  assert.equal(validateEntry({ name: 'root', path: ws.root }, { workspaceRoot: ws.root }).error.includes('workspace root itself'), true);
  assert.match(validateEntry({ name: 'out', path: ws.outside }, { workspaceRoot: ws.root }).error, /outside the workspace root/);
});

// 7. symlink escape rejected
test('symlink escapes are rejected unless the exact canonical target is opted in', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const r = validateEntry({ name: 'evil', path: path.join(ws.root, 'evil') }, { workspaceRoot: ws.root });
  assert.match(r.error, /symlink escape/);
  const optIn = validateEntry({ name: 'evil', path: path.join(ws.root, 'evil'), allowExternalTarget: true, canonicalPath: ws.outside }, { workspaceRoot: ws.root });
  assert.equal(optIn.error, undefined);
  const wrong = validateEntry({ name: 'evil', path: path.join(ws.root, 'evil'), allowExternalTarget: true, canonicalPath: '/tmp' }, { workspaceRoot: ws.root });
  assert.match(wrong.error, /outside the workspace root/);

  const { projects } = loadRegistry(ws.registryFile, { workspaceRoot: ws.root });
  const alpha = findByName(projects, 'alpha');
  assert.equal(isPathInsideProject('link-out/secret.txt', alpha.canonicalPath, alpha), false, 'symlink inside project pointing out');
  assert.equal(findByDirectory(projects, path.join(ws.root, 'alpha', 'link-out')), null, 'cwd via symlink');
});

test('nested and duplicate projects are rejected', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const data = JSON.parse(fs.readFileSync(ws.registryFile, 'utf8'));
  data.projects.push({ name: 'alpha-src', path: path.join(ws.root, 'alpha', 'src') }, { name: 'alpha', path: path.join(ws.root, 'beta') });
  fs.writeFileSync(ws.registryFile, JSON.stringify(data));
  const { projects, errors } = loadRegistry(ws.registryFile, { workspaceRoot: ws.root });
  assert.equal(projects.length, 2);
  assert.ok(errors.some((e) => e.includes('nested')));
  assert.ok(errors.some((e) => e.includes('duplicate')));
});

test('addProject registers safely and refuses escapes', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  fs.mkdirSync(path.join(ws.root, 'gamma'));
  const p = addProject(ws.registryFile, { name: 'gamma', path: path.join(ws.root, 'gamma') }, { workspaceRoot: ws.root });
  assert.equal(p.name, 'gamma');
  assert.throws(() => addProject(ws.registryFile, { name: 'evil', path: path.join(ws.root, 'evil') }, { workspaceRoot: ws.root }), /symlink escape/);
  assert.throws(() => addProject(ws.registryFile, { name: 'gamma', path: path.join(ws.root, 'gamma') }, { workspaceRoot: ws.root }), /already registered/);
  assert.equal(fs.statSync(ws.registryFile).mode & 0o777, 0o600);
});

test('a missing registry yields no projects (fail closed)', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const r = loadRegistry(path.join(ws.base, 'nope.json'), { workspaceRoot: ws.root });
  assert.deepEqual(r.projects, []);
  assert.equal(r.errors.length, 1);
});
