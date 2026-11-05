// Glossary suggestions: after a chapter is processed (and briefed), the names the transcript got wrong go to
// <session>/glossary-suggestions.json for the user to accept or reject. A glossary is only ever written on accept.
//   { "version": 1, "suggestions": [{ "term", "wrongs": [], "source": "fixer"|"screen"|"brief",
//     "evidence": { "chapter", "when", "said" }|null, "status": "pending"|"accepted"|"rejected" }] }
// Three sources: the screen-name fixer's corrections, names on screen that the speakers used and that look like
// product terms, and the brief's own "## Glossary suggestions" lines.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_GLOSSARY, glossaryPath, readGlossaries } from './glossary.mjs';
import { sessionProject } from './projects.mjs';

export const SUGGESTIONS_FILE = 'glossary-suggestions.json';
const SOURCES = new Set(['fixer', 'screen', 'brief']);
const pad = (n) => String(n).padStart(2, '0');
export const clock = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
const low = (s) => String(s).trim().toLowerCase();
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Chapters are processed in parallel while recording; one writer at a time per session.
function withLock(dir, fn) {
  const lock = path.join(dir, `.${SUGGESTIONS_FILE}.lock`);
  const until = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > until) throw new Error(`glossary suggestions are locked (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

// The session folder a chapter belongs to (an old single-recording folder is its own session).
export const sessionOf = (chapterDir) => (fs.existsSync(path.join(path.dirname(chapterDir), 'session.json')) ? path.dirname(chapterDir) : chapterDir);

export function readSuggestions(sessionDir) {
  const j = readJson(path.join(sessionDir, SUGGESTIONS_FILE));
  return { version: 1, suggestions: Array.isArray(j?.suggestions) ? j.suggestions.filter((s) => s && typeof s.term === 'string') : [] };
}
const save = (sessionDir, data) => writeAtomic(path.join(sessionDir, SUGGESTIONS_FILE), JSON.stringify({ version: 1, suggestions: data.suggestions }, null, 2) + '\n');

// The glossaries a recording uses: the default one, the session's and chapters' frozen lists, and its project's.
export function activeGlossaries(sessionDir, cfg = {}) {
  const s = readJson(path.join(sessionDir, 'session.json')) || {};
  const files = [DEFAULT_GLOSSARY, ...(s.glossaries || [])];
  for (const c of s.chapters || []) files.push(...(readJson(path.join(sessionDir, c.dir || '', 'chapter.json'))?.glossaries || []));
  const p = sessionProject(sessionDir, cfg);
  if (p?.glossary) files.push(glossaryPath(p.glossary));
  return [...new Set(files)];
}

// Where accepted terms go: --to, else the project's glossary, else the session's first named glossary, else the default.
export function acceptTarget(sessionDir, cfg = {}, to = null) {
  if (to) return glossaryPath(to);
  const p = sessionProject(sessionDir, cfg);
  if (p?.glossary) return glossaryPath(p.glossary);
  const s = readJson(path.join(sessionDir, 'session.json')) || {};
  const named = (s.glossaries || []).find((f) => path.resolve(f) !== path.resolve(DEFAULT_GLOSSARY));
  return named || DEFAULT_GLOSSARY;
}

// "Right: wrong, wrong" lines (a list bullet or backticks around them are fine). Used for the brief's section.
export function parseGlossaryLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').replace(/`/g, '').trim();
    const m = /^([^:#][^:]*):(.+)$/.exec(l);
    if (!m) continue;
    const term = m[1].replace(/\*\*/g, '').trim();
    const wrongs = m[2].split(',').map((w) => w.replace(/\s*\(.*\)\s*$/, '').replace(/^["“']|["”'.]$/g, '').trim()).filter(Boolean);
    if (!term || term.length > 40 || /^(none|right|example)\b/i.test(term) || !wrongs.length || wrongs.some((w) => w.length > 40)) continue;
    out.push({ term, wrongs });
  }
  return out;
}

// From the name fixer's run over a chapter: events [{ from, to, start, heard }] in transcript order.
export function fixerSuggestions(events, chapter) {
  const by = new Map();
  for (const e of events) {
    const k = low(e.to);
    if (!by.has(k)) by.set(k, { term: e.to, wrongs: [], source: 'fixer', evidence: { chapter, when: clock(e.start), said: String(e.heard).slice(0, 200) } });
    const s = by.get(k);
    if (!s.wrongs.some((w) => low(w) === low(e.from))) s.wrongs.push(e.from);
  }
  return [...by.values()];
}

// Names on screen that the speakers said, and that read like product terms: an inner capital ("PagerDuty")
// said once, or any name shown 10+ times and said twice. Never people already named as speakers; at most 8.
export function screenSuggestions(names, cues, { chapter, exclude = [] } = {}) {
  const skip = new Set(exclude.map(low));
  const out = [];
  for (const { name, n } of names) {
    if (skip.has(low(name))) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const said = cues.filter((c) => c.text.match(re));
    const times = said.reduce((k, c) => k + c.text.match(re).length, 0);
    const product = /[a-z][A-Z]/.test(name);
    if (!(product && times >= 1) && !(n >= 10 && times >= 2)) continue;
    out.push({ term: name, wrongs: [], source: 'screen', evidence: { chapter, when: clock(said[0].start), said: said[0].text.slice(0, 200) }, said: times });
  }
  return out.sort((a, b) => b.said - a.said).slice(0, 8).map(({ said, ...s }) => s);
}

// Add new suggestions to the session's file. Known glossary spellings and wrongs are dropped; a term already
// suggested keeps its status (accepted and rejected terms are never reopened) and a pending one gains the new wrongs.
// glossaries: more files to check besides the session's own (a chapter processed with --glossary).
export function mergeSuggestions(sessionDir, list, { cfg = {}, glossaries = [] } = {}) {
  if (!list.length) return readSuggestions(sessionDir);
  const known = readGlossaries([...new Set([...activeGlossaries(sessionDir, cfg), ...glossaries])]);
  const rights = new Map(known.map((g) => [low(g.right), g]));
  const knownWrongs = new Set(known.flatMap((g) => [low(g.right), ...g.wrongs.map(low)]));
  return withLock(sessionDir, () => {
    const data = readSuggestions(sessionDir);
    const at = new Map(data.suggestions.map((s) => [low(s.term), s]));
    let changed = false;
    for (const s of list) {
      if (!s?.term || !SOURCES.has(s.source)) continue;
      const k = low(s.term);
      const wrongs = [...new Map((s.wrongs || []).filter((w) => w && low(w) !== k && !knownWrongs.has(low(w))).map((w) => [low(w), w])).values()];
      if (rights.has(k) && !wrongs.length) continue; // already in a glossary, nothing new heard
      if (!rights.has(k) && (s.wrongs || []).length && !wrongs.length) continue; // every wrong is fixed by a glossary already
      const old = at.get(k);
      if (!old) {
        const fresh = { term: s.term, wrongs, source: s.source, evidence: s.evidence || null, status: 'pending' };
        data.suggestions.push(fresh); at.set(k, fresh); changed = true;
      } else if (old.status === 'pending') {
        for (const w of wrongs) if (!old.wrongs.some((x) => low(x) === low(w))) { old.wrongs.push(w); changed = true; }
        if (!old.evidence && s.evidence) { old.evidence = s.evidence; changed = true; }
      }
    }
    if (changed) save(sessionDir, data);
    return data;
  });
}

const pickTerms = (data, terms) => {
  const want = terms.map(low);
  const missing = want.filter((k) => !data.suggestions.some((s) => low(s.term) === k));
  if (missing.length) throw new Error(`no suggestion ${missing.map((k) => terms.find((t) => low(t) === k)).map((t) => `"${t}"`).join(', ')}`);
  return data.suggestions.filter((s) => want.includes(low(s.term)));
};

// Write the terms into the target glossary: wrongs merge into an existing "Right:" line, else a new line goes at
// the end; a named glossary that does not exist yet is created. terms: a list, or 'all' (every pending one).
export function acceptSuggestions(sessionDir, terms, { cfg = {}, to = null } = {}) {
  const target = acceptTarget(sessionDir, cfg, to);
  return withLock(sessionDir, () => {
    const data = readSuggestions(sessionDir);
    const chosen = terms === 'all' ? data.suggestions.filter((s) => s.status === 'pending') : pickTerms(data, [].concat(terms));
    if (chosen.length) {
      const lines = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\n+$/, '').split('\n')
        : ['# Names the transcript gets wrong. One per line: Right spelling: wrong one, wrong two'];
      for (const s of chosen) {
        const i = lines.findIndex((l) => { const g = readLine(l); return g && low(g.right) === low(s.term); });
        if (i < 0) { lines.push(s.wrongs.length ? `${s.term}: ${s.wrongs.join(', ')}` : s.term); continue; }
        const g = readLine(lines[i]);
        const add = s.wrongs.filter((w) => !g.wrongs.some((x) => low(x) === low(w)));
        if (add.length) lines[i] = `${g.right}: ${[...g.wrongs, ...add].join(', ')}`;
      }
      writeAtomic(target, lines.join('\n') + '\n');
      for (const s of chosen) s.status = 'accepted';
      save(sessionDir, data);
    }
    return { target, accepted: chosen.map((s) => s.term), suggestions: data.suggestions };
  });
}

export function rejectSuggestions(sessionDir, terms) {
  return withLock(sessionDir, () => {
    const data = readSuggestions(sessionDir);
    const chosen = pickTerms(data, [].concat(terms));
    for (const s of chosen) s.status = 'rejected';
    if (chosen.length) save(sessionDir, data);
    return { rejected: chosen.map((s) => s.term), suggestions: data.suggestions };
  });
}

// One glossary line, read the way readGlossaries reads it (null for comments and blanks).
function readLine(line) {
  const m = line.match(/^\s*([^#:][^:]*):(.*)$/) || line.match(/^\s*([^#\s][^#]*?)\s*$/);
  return m ? { right: m[1].trim(), wrongs: (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean) } : null;
}
