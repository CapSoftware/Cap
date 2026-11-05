// Projects: a name, a glossary, a tracker and target, a source folder and context notes, in
// <configDir>/projects/<id>.json. A recording names its project in session.json (and chapter.json) "project"; the
// config key "project" is the default for new recordings.
//   { version: 1, id, name, glossary: name|path|null, tracker: { provider, target, targetName } | null,
//     sourceRoot: path|null, briefNotes: path|null, url: url|null }
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, expand } from './config.mjs';
import { glossaryPath } from './glossary.mjs';
import { trackerIds } from './trackers/index.mjs';

export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELDS = new Set(['version', 'id', 'name', 'glossary', 'tracker', 'sourceRoot', 'briefNotes', 'url']);
const TRACKER_FIELDS = new Set(['provider', 'target', 'targetName']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const projectsDir = (cfg = {}) => path.join(cfg.configDir || CONFIG_DIR, 'projects');
export const projectFile = (cfg, id) => path.join(projectsDir(cfg), `${id}.json`);

const optString = (p, k) => {
  const v = p[k];
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`project.${k}: must be a string or null`);
  return v.trim() || null;
};

// A normalized copy, or throws saying which field is wrong.
export function validateProject(p) {
  if (!isObj(p)) throw new Error('project: must be a JSON object');
  for (const k of Object.keys(p)) if (!FIELDS.has(k)) throw new Error(`project.${k}: unknown field`);
  if (p.version !== 1) throw new Error('project.version: must be 1');
  if (typeof p.id !== 'string' || !PROJECT_ID.test(p.id)) throw new Error('project.id: must be a slug (lowercase letters, digits, -)');
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('project.name: must be a non-empty string');
  let tracker = null;
  if (p.tracker != null) {
    if (!isObj(p.tracker)) throw new Error('project.tracker: must be an object or null');
    for (const k of Object.keys(p.tracker)) if (!TRACKER_FIELDS.has(k)) throw new Error(`project.tracker.${k}: unknown field`);
    const provider = p.tracker.provider ?? null;
    if (provider !== null && !trackerIds().includes(provider)) throw new Error(`project.tracker.provider: must be one of ${trackerIds().join(', ')} or null`);
    const target = optString(p.tracker, 'target'), targetName = optString(p.tracker, 'targetName');
    if (provider && !target) throw new Error('project.tracker.target: required when a provider is set');
    tracker = provider ? { provider, target, targetName: targetName || target } : null;
  }
  const url = optString(p, 'url');
  if (url) { try { new URL(url); } catch { throw new Error('project.url: must be a URL'); } }
  return { version: 1, id: p.id, name: p.name.trim(), glossary: optString(p, 'glossary'), tracker, sourceRoot: optString(p, 'sourceRoot'), briefNotes: optString(p, 'briefNotes'), url };
}

// null when there is no such project; throws when its file is invalid.
export function readProject(cfg, id) {
  if (!id || !PROJECT_ID.test(String(id))) return null;
  let text;
  try { text = fs.readFileSync(projectFile(cfg, id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const f = projectFile(cfg, id);
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${f}: not JSON (${e.message})`); }
  let p;
  try { p = validateProject(j); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  if (p.id !== id) throw new Error(`${f}: project.id "${p.id}" does not match the file name`);
  return p;
}

// Valid projects, by name. Invalid files are skipped; onProblem({ file, error }) hears about each.
export function listProjects(cfg, { onProblem = () => {} } = {}) {
  const dir = projectsDir(cfg);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try { const p = readProject(cfg, f.slice(0, -5)); if (p) out.push(p); else onProblem({ file: path.join(dir, f), error: 'not a project id' }); }
    catch (e) { onProblem({ file: path.join(dir, f), error: e.message }); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Validated, written atomically; returns what was written.
export function saveProject(cfg, p) {
  const out = validateProject(p);
  fs.mkdirSync(projectsDir(cfg), { recursive: true });
  const f = projectFile(cfg, out.id), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, f);
  return out;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// The recording's project (session.json "project"), or null: none named, or its file is gone or invalid.
// Recordings from before projects have no "project" and get null (never the config default).
export function sessionProject(sessionDir, cfg = {}) {
  const id = readJson(path.join(sessionDir, 'session.json'))?.project;
  if (!id) return null;
  try { return readProject(cfg, id); } catch { return null; }
}

// The settings one recording runs with: the project's source folder, notes and url win over config, its glossary
// is added to the config's, and cfg.project names it. No project: cfg unchanged (project null).
export function withProject(cfg, project) {
  if (!project) return { ...cfg, project: null };
  return {
    ...cfg,
    project: project.id,
    glossary: [cfg.glossary, project.glossary].filter(Boolean).join(','),
    ...(project.sourceRoot ? { sourceRoot: expand(project.sourceRoot) } : {}),
    ...(project.briefNotes ? { briefNotes: project.briefNotes } : {}),
    ...(project.url ? { url: project.url } : {}),
  };
}

// The project a new recording uses: --project <id>, else config "project". Throws on an unknown explicit id;
// a stale config default only warns (recording must not fail on it).
export function projectFor(cfg, flag, { warn = (m) => console.error(m) } = {}) {
  const id = flag || cfg.project || '';
  if (!id) return null;
  const p = readProject(cfg, id);
  if (p) return p;
  const msg = `no project "${id}" in ${projectsDir(cfg)} (ux-walk projects lists them)`;
  if (flag) throw new Error(msg);
  warn(`${msg}; recording without a project`);
  return null;
}

// Puts an existing recording in a project: session.json and every chapter.json get "project", and the project's
// glossary joins their glossaries (so reprocessing uses it).
export function assignProject(sessionDir, project) {
  const save = (f, o) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(tmp, f); };
  const g = project?.glossary ? glossaryPath(project.glossary) : null;
  const update = (o) => {
    o.project = project?.id ?? null;
    if (g && fs.existsSync(g)) o.glossaries = [...new Set([...(o.glossaries || []), g])];
    return o;
  };
  const sf = path.join(sessionDir, 'session.json');
  const s = readJson(sf);
  if (!s) throw new Error(`not a recording: ${sessionDir} (no session.json)`);
  save(sf, update(s));
  for (const c of s.chapters || []) {
    const cf = path.join(sessionDir, c.dir, 'chapter.json');
    const ch = readJson(cf);
    if (ch) save(cf, update(ch));
  }
}
