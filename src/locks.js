// Per-project write locks: one writing session per project at a time.
// File-based so it works across the separate guard-hook processes.
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class LockStore {
  /** @param {string} dir @param {{ ttlMs?: number, now?: () => number }} [opts] */
  constructor(dir, { ttlMs = 30 * 60_000, now = Date.now } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  #file(project) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project)) throw new Error('invalid project name for lock');
    return path.join(this.dir, `${project}.lock.json`);
  }

  #read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  #write(file, data) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /**
   * Acquire or refresh the write lock for `project` on behalf of `sessionId`.
   * @returns {{ ok: true } | { ok: false, holder: string, ageMs: number }}
   */
  acquire(project, sessionId) {
    if (!SAFE_ID.test(String(sessionId))) return { ok: false, holder: 'unknown', ageMs: 0 };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.#file(project);
    const now = this.now();
    const record = { sessionId, updatedAt: now };
    try {
      const fd = fs.openSync(file, 'wx', 0o600); // atomic create
      fs.writeSync(fd, JSON.stringify(record));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const cur = this.#read(file);
    const age = cur ? now - Number(cur.updatedAt) : Infinity;
    if (!cur || cur.sessionId === sessionId || !(age < this.ttlMs)) {
      this.#write(file, record);
      // Re-read to detect a racing writer.
      const after = this.#read(file);
      if (after && after.sessionId === sessionId) return { ok: true };
      return { ok: false, holder: after?.sessionId ?? 'unknown', ageMs: 0 };
    }
    return { ok: false, holder: cur.sessionId, ageMs: age };
  }

  /** Release every lock held by sessionId. */
  releaseSession(sessionId) {
    let released = 0;
    if (!fs.existsSync(this.dir)) return 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.lock.json')) continue;
      const file = path.join(this.dir, f);
      const cur = this.#read(file);
      if (cur && cur.sessionId === sessionId) { fs.rmSync(file, { force: true }); released++; }
    }
    return released;
  }

  /** @returns {{ project: string, sessionId: string, ageMs: number, stale: boolean }[]} */
  list() {
    if (!fs.existsSync(this.dir)) return [];
    const now = this.now();
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.lock.json'))
      .map((f) => {
        const cur = this.#read(path.join(this.dir, f)) ?? {};
        const ageMs = now - Number(cur.updatedAt ?? 0);
        return { project: f.replace(/\.lock\.json$/, ''), sessionId: String(cur.sessionId ?? '?'), ageMs, stale: !(ageMs < this.ttlMs) };
      });
  }
}
