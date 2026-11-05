// Beads: `bd` on PATH (it finds its own server; never pass it a host). The target is a folder: bd runs there and
// files into that repo's project.
import fs from 'node:fs';
import path from 'node:path';
import { expand } from '../config.mjs';
import { run } from './util.mjs';

const TYPES = { bug: 'bug', error: 'bug', ask: 'feature', action: 'task', decision: 'task', note: 'task', question: 'task' };

export default {
  id: 'beads',
  name: 'Beads',
  env: null,
  keychainItem: () => null,
  keyUrl: null,
  needsKey: false,
  targetKind: 'folder',
  targetProblem: (t) => (t && fs.existsSync(path.resolve(expand(String(t)))) ? null : `beads target must be an existing folder (got "${t || ''}")`),
  async check() {
    try { await run('bd', ['--help'], { timeoutMs: 15000 }); return { ok: true }; }
    catch (e) { return { ok: false, problem: e.code === 'ENOENT' ? 'bd is not installed (not on PATH)' : `bd: ${e.message}` }; }
  },
  // Folders bd could run in: every project's source folder (and the configured sourceRoot).
  async listTargets(cfg) {
    const { listProjects } = await import('../projects.mjs');
    const dirs = [cfg.sourceRoot, ...listProjects(cfg).map((p) => p.sourceRoot)].filter(Boolean).map((d) => path.resolve(expand(d)));
    return [...new Set(dirs)].filter((d) => fs.existsSync(d)).map((d) => ({ id: d, name: path.basename(d) }));
  },
  async create(cfg, target, issue, { signal } = {}) {
    const cwd = path.resolve(expand(String(target || '')));
    if (!target || !fs.existsSync(cwd)) throw new Error(`beads target must be an existing folder (got "${target || ''}")`);
    const args = ['create', '--title', issue.title, '-t', TYPES[issue.type] || 'task', '-p', String(issue.priority ?? 2), '--body-file', '-', '--json'];
    if (issue.labels?.length) args.push('-l', issue.labels.join(','));
    const { stdout } = await run('bd', args, { cwd, input: issue.body, signal });
    let j = null;
    try { j = JSON.parse(stdout); } catch {}
    const id = (Array.isArray(j) ? j[0] : j)?.id || (/\b([a-z][\w-]*-[a-z0-9]+(?:\.\d+)*)\b/i.exec(stdout) || [])[1];
    if (!id) throw new Error(`bd create printed no issue id: ${stdout.trim().slice(0, 200)}`);
    return { ref: id, url: null };
  },
};
