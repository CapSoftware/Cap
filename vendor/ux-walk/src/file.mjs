// `ux-walk file`: the chosen items of a recording become issues in its project's tracker (or one named), and each
// is linked in ledger.json with a typed ref { ref, url, tracker }. Items that already have a ref are skipped, so
// running it twice files nothing twice.
import path from 'node:path';
import { link, mergedItems } from './ledger.mjs';
import { sessionProject } from './projects.mjs';
import { getTracker, issueFor } from './trackers/index.mjs';

// Filed when nothing is chosen: a diatribe's action items, a walk's bugs and asks. Never decisions, notes or
// questions unless asked for by --types or --keys.
export const DEFAULT_TYPES = { diatribe: ['action'], walk: ['bug', 'ask'] };
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);

// { items: [{ item, chapter }], skipped: [{ key, id, title, refs }] }: what would be filed, and what is already linked.
export function selectItems(merged, { keys, all = false, types } = {}) {
  const wantKeys = list(keys).map((k) => k.toLowerCase()), wantTypes = list(types);
  const picked = [], skipped = [];
  const found = new Set();
  for (const c of merged.chapters) {
    for (const i of c.items) {
      if (i.deleted) continue;
      const k = [i.key, i.id].filter(Boolean).map((x) => x.toLowerCase());
      const byKey = wantKeys.length ? k.some((x) => wantKeys.includes(x)) : false;
      if (byKey) k.forEach((x) => found.add(x));
      const chosen = wantKeys.length ? byKey
        : all ? (!wantTypes.length || wantTypes.includes(i.type))
        : (wantTypes.length ? wantTypes : DEFAULT_TYPES[c.kind === 'diatribe' ? 'diatribe' : 'walk']).includes(i.type);
      if (!chosen) continue;
      if (i.refs?.length) skipped.push({ key: i.key, id: i.id, title: i.title, refs: i.refs });
      else picked.push({ item: i, chapter: c });
    }
  }
  const missing = wantKeys.filter((k) => !found.has(k));
  if (missing.length) throw new Error(`no item ${missing.join(', ')} in ${path.basename(merged.session)} (deleted items are never filed; ux-walk items lists keys)`);
  return { items: picked, skipped };
}

// The tracker and target to file through: explicit ones win, else the recording's project.
export function fileTarget(sessionDir, cfg, { tracker, target } = {}) {
  const project = sessionProject(sessionDir, cfg);
  const provider = tracker || project?.tracker?.provider;
  if (!provider) throw new Error(`${path.basename(sessionDir)} has no project with a tracker: give --tracker <${['beads', 'github', 'linear'].join('|')}> --target <target>, or put it in a project (ux-walk projects)`);
  const plugin = getTracker(provider);
  const t = target || (project?.tracker?.provider === provider ? project.tracker.target : null);
  if (!t) throw new Error(`no target for ${plugin.name}: give --target (ux-walk trackers targets ${provider})`);
  const problem = plugin.targetProblem?.(t);
  if (problem) throw new Error(problem);
  return { plugin, target: t, targetName: target ? target : project?.tracker?.targetName || t, project };
}

// Files the selection; per-item failures are reported and the rest continue. With dryRun nothing is created.
// Returns { session, tracker, target, targetName, dryRun, filed: [...], skipped: [...], failed: [...] }.
export async function fileItems(sessionDir, cfg, { keys, all, types, tracker, target, dryRun = false, signal } = {}) {
  const dest = fileTarget(sessionDir, cfg, { tracker, target });
  const merged = mergedItems(sessionDir);
  const { items, skipped } = selectItems(merged, { keys, all, types });
  const out = { session: sessionDir, tracker: dest.plugin.id, target: dest.target, targetName: dest.targetName, dryRun: !!dryRun, filed: [], skipped, failed: [] };
  for (const { item, chapter } of items) {
    const issue = issueFor(item, { session: sessionDir, chapter });
    const base = { key: item.key, id: item.id, type: item.type, title: item.title };
    if (dryRun) { out.filed.push({ ...base, issue }); continue; }
    try {
      const r = await dest.plugin.create(cfg, dest.target, issue, { signal });
      link(sessionDir, item.key, r.ref, '', { tracker: dest.plugin.id, url: r.url || undefined });
      out.filed.push({ ...base, ref: r.ref, url: r.url || null, tracker: dest.plugin.id });
    } catch (e) {
      out.failed.push({ ...base, error: e.message });
      if (signal?.aborted) break;
    }
  }
  return out;
}
