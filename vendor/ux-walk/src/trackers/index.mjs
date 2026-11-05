// Issue trackers are plugins, like transcribers: one file each, looked up by id. A plugin is
//   { id, name, env, keychainItem(cfg), keyUrl, needsKey, targetKind, targetProblem(target) -> string|null,
//     async check(cfg) -> { ok, problem? }, async listTargets(cfg) -> [{ id, name }],
//     async create(cfg, target, issue, { signal }) -> { ref, url } }
// with issue = { title, body, type, priority (0 urgent .. 4 trivial, or null), labels: [] }.
// Add one: write the file and list it in PLUGINS.
import path from 'node:path';
import { keyPresent, storeKey } from '../keys.mjs';
import beads from './beads.mjs';
import github from './github.mjs';
import linear from './linear.mjs';

const PLUGINS = [beads, github, linear];
export const TRACKERS = Object.freeze(Object.fromEntries(PLUGINS.map((p) => [p.id, p])));
export const trackerIds = () => Object.keys(TRACKERS);

export function getTracker(id) {
  const t = Object.hasOwn(TRACKERS, id) ? TRACKERS[id] : null;
  if (!t) throw new Error(`unknown tracker "${id}" (use ${trackerIds().join(', ')})`);
  return t;
}

export const trackerKeyPresent = (cfg, id) => { const t = getTracker(id); return !!t.keychainItem(cfg) && keyPresent(t, cfg); };
export const storeTrackerKey = (cfg, id, secret) => storeKey(getTracker(id), cfg, secret);

// Every plugin with its check result: what `ux-walk trackers --json` prints.
export async function trackerStatus(cfg) {
  return Promise.all(PLUGINS.map(async (t) => {
    let c;
    try { c = await t.check(cfg); } catch (e) { c = { ok: false, problem: e.message }; }
    return { id: t.id, name: t.name, needsKey: t.needsKey, env: t.env, keychainItem: t.keychainItem(cfg), keyUrl: t.keyUrl, targetKind: t.targetKind,
      keyPresent: t.keychainItem(cfg) ? keyPresent(t, cfg) : false, ok: !!c.ok, ...(c.problem ? { problem: c.problem } : {}), ...(c.via ? { via: c.via } : {}) };
  }));
}

// "Linear (Engineering)": how the handoff names a project's tracker and target.
export function trackerLabel(tracker) {
  if (!tracker?.provider) return null;
  const t = Object.hasOwn(TRACKERS, tracker.provider) ? TRACKERS[tracker.provider] : null;
  const name = t ? (t.id === 'github' ? 'GitHub' : t.id === 'beads' ? 'beads' : t.name) : tracker.provider;
  const where = tracker.targetName || tracker.target;
  return where ? `${name} (${where})` : name;
}

// An item's free-text priority ("high: blocks checkout", "P1") as 0 urgent .. 4 trivial, null when unsaid.
export function priorityLevel(text) {
  const s = String(text || '').toLowerCase();
  const p = /\bp([0-4])\b/.exec(s);
  if (p) return Number(p[1]);
  if (/\b(urgent|critical|blocker|blocking|asap)\b/.test(s)) return 0;
  if (/\bhigh\b/.test(s)) return 1;
  if (/\b(medium|normal|moderate)\b/.test(s)) return 2;
  if (/\blow\b/.test(s)) return 3;
  if (/\b(trivial|nice to have|someday)\b/.test(s)) return 4;
  return null;
}

// A merged item (ledger.mergedItems) as an issue: the quote, when, screen, owner, due, the user's note and where the
// recording lives, so whoever picks it up can open the evidence.
export function issueFor(item, { session, chapter } = {}) {
  const lines = [];
  if (item.said) lines.push(`> ${String(item.said).replace(/\n/g, '\n> ')}`, '');
  const ch = chapter ? `chapter ${chapter.n}${chapter.name ? ` "${chapter.name}"` : ''}` : item.chapter ? `chapter ${item.chapter}` : '';
  if (item.when || ch) lines.push(`- When: ${[item.when, ch].filter(Boolean).join(', ')}`);
  if (item.route) lines.push(`- Page: ${item.route}`);
  if (item.shot) lines.push(`- Screen: ${chapter?.dir ? path.join(chapter.dir, item.shot) : item.shot}`);
  if (item.owner) lines.push(`- Owner: ${item.owner}`);
  if (item.due) lines.push(`- Due: ${item.due}`);
  if (item.priority) lines.push(`- Priority: ${item.priority}`);
  if (item.userNote) lines.push('', `Note: ${item.userNote}`);
  lines.push('', `From the ux-walk recording ${session} (item ${item.key}${item.id ? `, ${item.id}` : ''}).`);
  return { title: item.title, body: lines.join('\n'), type: item.type, priority: priorityLevel(item.priority), labels: ['ux-walk', item.type].filter(Boolean) };
}
