import fs from 'node:fs';
import path from 'node:path';
import { sessionProject } from './projects.mjs';
import { trackerLabel } from './trackers/index.mjs';
// Folder names and the hand-off line, shared by the recorder and `ux-walk import` so both make the same layout:
// <outDir>/<YYYY-MM-DD-HHMM>-<topic>/<NN>-<chapter>/.
export const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
export const pad = (n) => String(n).padStart(2, '0');
// Local time, to the minute.
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
export const sessionName = (topic, d = new Date()) => `${stamp(d)}-${slug(topic) || 'walk'}`;
export const chapterName = (n, name) => `${pad(n)}-${slug(name) || 'part'}`;
// The one line Jackson pastes into Claude Code to hand the walk to agents. A diatribe with no ask: file its actions,
// in the project's tracker when the recording has one (`ux-walk file` does it and records the links).
export const DIATRIBE_ASK = 'turn the action items into beads (or issues)';
export const trackerAsk = (dir, project) => {
  const where = trackerLabel(project?.tracker);
  return where ? `file the action items in ${where} with \`ux-walk file ${dir}\`` : DIATRIBE_ASK;
};
export const defaultAsk = (dir, { kind, project } = {}) => (kind === 'diatribe' ? trackerAsk(dir, project) : '');
export const handoffLine = (dir, ask, { kind, project } = {}) => {
  const a = ask && ask.trim() ? ask : defaultAsk(dir, { kind, project });
  return `/ux-walk ${dir}${a ? ` ${a.replace(/\s+/g, ' ').trim()}` : ''}`;
};
// Said to the agent after the line (agent-prompt.txt): the user's edits to the items win over the brief; a project's
// tracker is where filed items go.
export const handoffContext = (dir, { project } = {}) => {
  const where = trackerLabel(project?.tracker);
  return `Work from \`ux-walk items ${dir} --json\` (not items.json alone): it applies the user's edits. ` +
    'Edited fields are authoritative; never file an item marked "deleted": true; items with "origin": "user" were added by the user and are ' +
    (where
      ? `first-class. This recording's project "${project.name}" files to ${where}: file items with \`ux-walk file ${dir} --keys <key,...>\` ` +
        '(it skips items already linked and records each issue in the ledger); link anything filed another way with ' +
        `\`ux-walk link ${dir} <key> <ref>\`.`
      : `first-class. Link what you file with \`ux-walk link ${dir} <key> <ref>\`.`);
};

// For the desktop bridge and `ux-walk handoff`: the paste-ready line, the context, and where items get filed.
export function handoffAsk(sessionDir, cfg = {}) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8')); } catch {}
  const project = sessionProject(sessionDir, cfg);
  const ask = s.ask && s.ask.trim() ? s.ask.trim() : defaultAsk(sessionDir, { kind: s.kind, project });
  return {
    session: sessionDir, kind: s.kind || null, ask, line: handoffLine(sessionDir, s.ask, { kind: s.kind, project }), context: handoffContext(sessionDir, { project }),
    project: project ? { id: project.id, name: project.name } : null,
    tracker: project?.tracker ? { ...project.tracker, label: trackerLabel(project.tracker), fileCommand: `ux-walk file ${sessionDir}` } : null,
  };
}

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
