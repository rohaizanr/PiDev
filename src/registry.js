// Project registry: the ONLY directories a PiDev agent session may work in.
import fs from 'node:fs';
import path from 'node:path';
import { isInside, safeRealpath } from './config.js';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate one raw entry. Returns { project } or { error }.
 * @param {any} entry
 * @param {{ workspaceRoot: string, pidevHome?: string }} ctx workspaceRoot must be canonical
 */
export function validateEntry(entry, { workspaceRoot, pidevHome }) {
  if (!entry || typeof entry !== 'object') return { error: 'entry is not an object' };
  const { name, path: rawPath } = entry;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { error: `invalid project name ${JSON.stringify(name)} (lowercase letters, digits, - and _; max 64)` };
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) return { error: `${name}: path must be absolute` };
  if (rawPath.split(/[\\/]+/).includes('..')) return { error: `${name}: path must not contain ".." segments` };
  if (!workspaceRoot) return { error: `${name}: workspace root is not configured` };

  const canonical = safeRealpath(rawPath);
  if (!canonical) return { error: `${name}: path does not exist` };
  let st;
  try { st = fs.statSync(canonical); } catch { return { error: `${name}: cannot stat path` }; }
  if (!st.isDirectory()) return { error: `${name}: path is not a directory` };

  const allowExternal = entry.allowExternalTarget === true;
  const insideRoot = isInside(canonical, workspaceRoot) && canonical !== workspaceRoot;
  if (canonical === workspaceRoot) return { error: `${name}: the workspace root itself cannot be a project` };
  if (!insideRoot) {
    // Symlink (or explicit path) leading outside the root: only if the owner
    // explicitly opted in AND recorded the exact canonical target.
    if (!(allowExternal && entry.canonicalPath === canonical)) {
      return { error: `${name}: resolves outside the workspace root (symlink escape or external path). To allow, set "allowExternalTarget": true and "canonicalPath": "${canonical}".` };
    }
  }
  const segs = canonical.split(path.sep);
  if (segs.includes('.openacp') || segs.includes('.ssh') || segs.includes('.claude')) return { error: `${name}: path points into a protected directory` };
  if (pidevHome && isInside(canonical, pidevHome) && entry.allowPidevSelf !== true) {
    return { error: `${name}: refers to the PiDev application directory; set "allowPidevSelf": true to register it explicitly` };
  }
  return {
    project: {
      name,
      path: rawPath,
      canonicalPath: canonical,
      enabled: entry.enabled !== false,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 200) : '',
      repoUrl: typeof entry.repoUrl === 'string' ? entry.repoUrl : '',
      trusted: entry.trusted === true,
    },
  };
}

/**
 * Load and validate the registry. Invalid entries are excluded (fail closed per entry).
 * @returns {{ projects: object[], errors: string[] }}
 */
export function loadRegistry(file, { workspaceRoot, pidevHome } = {}) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { projects: [], errors: [`cannot read registry ${file}: ${e.code ?? e.message}`] };
  }
  const root = workspaceRoot ? safeRealpath(workspaceRoot) : null;
  if (!root) return { projects: [], errors: ['workspace root does not exist or is not configured'] };
  const list = Array.isArray(data?.projects) ? data.projects : [];
  if (!Array.isArray(data?.projects)) errors.push('registry has no "projects" array');
  const projects = [];
  const seen = new Set();
  for (const entry of list) {
    const r = validateEntry(entry, { workspaceRoot: root, pidevHome });
    if (r.error) { errors.push(r.error); continue; }
    const p = r.project;
    if (seen.has(p.name)) { errors.push(`${p.name}: duplicate project name`); continue; }
    const overlap = projects.find((q) => isInside(p.canonicalPath, q.canonicalPath) || isInside(q.canonicalPath, p.canonicalPath));
    if (overlap) { errors.push(`${p.name}: overlaps with project ${overlap.name}; projects must not be nested`); continue; }
    seen.add(p.name);
    projects.push(p);
  }
  return { projects, errors };
}

/** Look up an enabled project by name. Unknown/disabled => null. */
export function findByName(projects, name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().toLowerCase();
  if (!NAME_RE.test(n)) return null;
  return projects.find((p) => p.name === n && p.enabled) ?? null;
}

/** Which enabled project (if any) contains this directory, after canonicalisation. */
export function findByDirectory(projects, dir) {
  const real = safeRealpath(dir);
  if (!real) return null;
  return projects.find((p) => p.enabled && isInside(real, p.canonicalPath)) ?? null;
}

/**
 * Canonicalise a (possibly not-yet-existing) target path: realpath of the
 * deepest existing ancestor + the remaining segments. Resolves `..` and
 * symlinks in every existing component.
 */
export function canonicalizeTarget(target, baseDir) {
  const abs = path.resolve(baseDir, target);
  let cur = abs;
  const rest = [];
  while (true) {
    const real = safeRealpath(cur);
    if (real) return path.join(real, ...rest.reverse());
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/** Is target (relative to baseDir) inside the project after canonicalisation? */
export function isPathInsideProject(target, baseDir, project) {
  return isInside(canonicalizeTarget(target, baseDir), project.canonicalPath);
}

/**
 * Add a project entry to a registry file (creating it if needed). Validates
 * first; never touches the project directory itself.
 */
export function addProject(file, entry, ctx) {
  const root = safeRealpath(ctx.workspaceRoot);
  const r = validateEntry(entry, { workspaceRoot: root, pidevHome: ctx.pidevHome });
  if (r.error) throw new Error(r.error);
  let data = { version: 1, projects: [] };
  if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.projects)) data.projects = [];
  if (data.projects.some((p) => p.name === entry.name)) throw new Error(`project ${entry.name} already registered`);
  const { projects: existing } = loadRegistry(file, ctx);
  const overlap = existing.find((q) => isInside(r.project.canonicalPath, q.canonicalPath) || isInside(q.canonicalPath, r.project.canonicalPath));
  if (overlap) throw new Error(`overlaps with project ${overlap.name}`);
  data.projects.push({
    name: entry.name,
    path: r.project.canonicalPath,
    enabled: entry.enabled !== false,
    description: entry.description ?? '',
    repoUrl: entry.repoUrl ?? '',
    trusted: entry.trusted === true,
  });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return r.project;
}
