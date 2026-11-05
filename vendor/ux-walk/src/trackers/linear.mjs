// Linear over GraphQL with a personal API key (LINEAR_API_KEY or Keychain "ux-walk-linear"). The target is a team
// id, or "<teamId>/<projectId>" for one of its projects.
import { keyFor } from '../keys.mjs';

const API = 'https://api.linear.app/graphql';
// Ours: 0 urgent .. 4 trivial, null none. Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
const PRIORITY = [1, 2, 3, 4, 4];

async function gql(cfg, query, variables = {}, signal) {
  const key = keyFor(plugin, cfg);
  const r = await globalThis.fetch(API, { method: 'POST', signal, headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error(`Linear ${r.status}: ${j.errors?.[0]?.message || r.statusText}`);
  return j.data;
}

const plugin = {
  id: 'linear',
  name: 'Linear',
  env: 'LINEAR_API_KEY',
  keychainItem: (cfg) => cfg.linearKeychainItem || 'ux-walk-linear',
  keyUrl: 'https://linear.app/settings/account/security (Personal API keys)',
  needsKey: true,
  targetKind: 'team',
  targetProblem: (t) => (/^[^/\s]+(\/[^/\s]+)?$/.test(String(t || '')) ? null : `linear target must be a team id or <teamId>/<projectId> (got "${t || ''}")`),
  async check(cfg) {
    try { await gql(cfg, '{ viewer { id } }'); return { ok: true }; }
    catch (e) { return { ok: false, problem: e.message }; }
  },
  async listTargets(cfg) {
    const d = await gql(cfg, '{ teams(first: 100) { nodes { id key name projects(first: 50) { nodes { id name } } } } }');
    return d.teams.nodes.flatMap((t) => [{ id: t.id, name: `${t.name} (${t.key})` },
      ...(t.projects?.nodes || []).map((p) => ({ id: `${t.id}/${p.id}`, name: `${t.name} / ${p.name}` }))]);
  },
  async create(cfg, target, issue, { signal } = {}) {
    const [teamId, projectId] = String(target || '').split('/');
    if (!teamId) throw new Error('linear target must be a team id (ux-walk trackers targets linear)');
    // Labels only when the team already has them (by name); Linear wants label ids.
    let labelIds = [];
    if (issue.labels?.length) {
      const d = await gql(cfg, 'query($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name } } } }', { id: teamId }, signal);
      const want = new Set(issue.labels.map((l) => l.toLowerCase()));
      labelIds = (d.team?.labels?.nodes || []).filter((l) => want.has(l.name.toLowerCase())).map((l) => l.id);
    }
    const input = { teamId, title: issue.title, description: issue.body, priority: issue.priority == null ? 0 : PRIORITY[issue.priority] ?? 0,
      ...(projectId ? { projectId } : {}), ...(labelIds.length ? { labelIds } : {}) };
    const d = await gql(cfg, 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }', { input }, signal);
    const i = d.issueCreate?.issue;
    if (!d.issueCreate?.success || !i) throw new Error('Linear did not create the issue');
    return { ref: i.identifier, url: i.url };
  },
};
export default plugin;
