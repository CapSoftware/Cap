// GitHub Issues. The gh CLI when it is logged in; else a token (GITHUB_TOKEN or Keychain "ux-walk-github") over REST.
// The target is owner/repo.
import { keyFor } from '../keys.mjs';
import { run } from './util.mjs';

const API = 'https://api.github.com';
const REPO = /^[\w.-]+\/[\w.-]+$/;

async function ghLoggedIn() {
  try { await run('gh', ['auth', 'status'], { timeoutMs: 15000 }); return true; } catch { return false; }
}

async function rest(token, method, url, body, signal) {
  const r = await globalThis.fetch(`${API}${url}`, { method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ux-walk', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${j.message || r.statusText}`);
  return j;
}

const plugin = {
  id: 'github',
  name: 'GitHub Issues',
  env: 'GITHUB_TOKEN',
  keychainItem: (cfg) => cfg.githubKeychainItem || 'ux-walk-github',
  keyUrl: 'https://github.com/settings/personal-access-tokens (Issues: read and write), or run gh auth login',
  needsKey: false, // gh's own login is enough; a token is the fallback
  targetKind: 'repo',
  targetProblem: (t) => (REPO.test(String(t || '')) ? null : `github target must be owner/repo (got "${t || ''}")`),
  async check(cfg) {
    if (await ghLoggedIn()) return { ok: true, via: 'gh' };
    try { const token = keyFor(plugin, cfg); await rest(token, 'GET', '/user'); return { ok: true, via: 'token' }; }
    catch (e) { return { ok: false, problem: `gh is not logged in (gh auth login), and ${e.message}` }; }
  },
  async listTargets(cfg) {
    if (await ghLoggedIn()) {
      const { stdout } = await run('gh', ['repo', 'list', '--json', 'nameWithOwner', '--limit', '200']);
      return JSON.parse(stdout).map((r) => ({ id: r.nameWithOwner, name: r.nameWithOwner }));
    }
    const token = keyFor(plugin, cfg);
    return (await rest(token, 'GET', '/user/repos?per_page=100&sort=pushed')).map((r) => ({ id: r.full_name, name: r.full_name }));
  },
  async create(cfg, target, issue, { signal } = {}) {
    if (!REPO.test(String(target || ''))) throw new Error(`github target must be owner/repo (got "${target || ''}")`);
    if (await ghLoggedIn()) {
      const base = ['issue', 'create', '-R', target, '--title', issue.title, '--body-file', '-'];
      const labelled = issue.labels?.length ? [...base, ...issue.labels.flatMap((l) => ['--label', l])] : base;
      let out;
      try { out = (await run('gh', labelled, { input: issue.body, signal })).stdout; }
      catch (e) {
        // gh refuses labels the repo does not have; file without them rather than not at all.
        if (labelled === base || !/label/i.test(e.message)) throw e;
        out = (await run('gh', base, { input: issue.body, signal })).stdout;
      }
      const url = (/https:\/\/\S+\/issues\/\d+/.exec(out) || [])[0];
      if (!url) throw new Error(`gh issue create printed no URL: ${out.trim().slice(0, 200)}`);
      return { ref: `${target}#${url.split('/').pop()}`, url };
    }
    const token = keyFor(plugin, cfg);
    const j = await rest(token, 'POST', `/repos/${target}/issues`, { title: issue.title, body: issue.body, labels: issue.labels || [] }, signal);
    return { ref: `${target}#${j.number}`, url: j.html_url };
  },
};
export default plugin;
