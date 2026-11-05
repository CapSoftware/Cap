import fs from 'node:fs';
import path from 'node:path';
// Folder names and the hand-off line, shared by the recorder and `ux-walk import` so both make the same layout:
// <outDir>/<YYYY-MM-DD-HHMM>-<topic>/<NN>-<chapter>/.
export const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
export const pad = (n) => String(n).padStart(2, '0');
// Local time, to the minute.
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
export const sessionName = (topic, d = new Date()) => `${stamp(d)}-${slug(topic) || 'walk'}`;
export const chapterName = (n, name) => `${pad(n)}-${slug(name) || 'part'}`;
// The one line Jackson pastes into Claude Code to hand the walk to agents. A diatribe with no ask: file its actions.
export const DIATRIBE_ASK = 'turn the action items into beads (or issues)';
export const handoffLine = (dir, ask, { kind } = {}) => {
  const a = ask && ask.trim() ? ask : kind === 'diatribe' ? DIATRIBE_ASK : '';
  return `/ux-walk ${dir}${a ? ` ${a.replace(/\s+/g, ' ').trim()}` : ''}`;
};
// Said to the agent after the line (agent-prompt.txt): the user's edits to the items win over the brief.
export const handoffContext = (dir) => `Work from \`ux-walk items ${dir} --json\` (not items.json alone): it applies the user's edits. ` +
  'Edited fields are authoritative; never file an item marked "deleted": true; items with "origin": "user" were added by the user and are ' +
  `first-class. Link what you file with \`ux-walk link ${dir} <key> <ref>\`.`;

// Reserve atomically; a same-minute restart must never overwrite a previous session/video.
export function createSessionDir(outDir, topic, date = new Date()) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = sessionName(topic, date);
  for (let n = 1; ; n++) {
    const dir = path.join(outDir, n === 1 ? base : `${base}-${n}`);
    try { fs.mkdirSync(dir); return dir; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
