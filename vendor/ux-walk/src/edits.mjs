// The user's changes to the generated items (the desktop editor's Save): <session>/edits.json, beside ledger.json.
// Processing and re-briefs never write it. Edits are keyed by item key (items.json `key`), so they survive a
// re-brief that renumbers the ids; an edit whose key is gone is an orphan, kept and shown, never dropped.
//   { version: 1, updatedAt, items: { <key>: { title?, type?, priority?, owner?, due?, note?, deleted? } },
//     added: [{ key, chapter, title, type, priority, owner, due, note }], order?: [keys] }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TYPES = ['action', 'decision', 'note', 'question', 'ask', 'bug', 'error'];
const FIELDS = new Set(['title', 'type', 'priority', 'owner', 'due', 'note', 'deleted']);
const ADDED = new Set([...FIELDS, 'key', 'chapter']);
const TOP = new Set(['version', 'updatedAt', 'items', 'added', 'order']);
const KEY = /^[A-Za-z0-9][\w.-]{0,63}$/;

export const editsFile = (session) => path.join(session, 'edits.json');
export const emptyEdits = () => ({ version: 1, updatedAt: null, items: {}, added: [] });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function checkFields(o, allowed, at) {
  if (!isObj(o)) throw new Error(`${at}: must be an object`);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new Error(`${at}.${k}: unknown field`);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'title') { if (typeof v !== 'string' || !v.trim()) throw new Error(`${at}.title: must be a non-empty string`); out.title = v.trim(); }
    else if (k === 'type') { if (!TYPES.includes(v)) throw new Error(`${at}.type: must be one of ${TYPES.join(', ')}`); out.type = v; }
    else if (k === 'deleted') { if (typeof v !== 'boolean') throw new Error(`${at}.deleted: must be true or false`); out.deleted = v; }
    else if (k === 'chapter') { if (!Number.isInteger(v) || v < 1) throw new Error(`${at}.chapter: must be a chapter number`); out.chapter = v; }
    else if (k === 'key') { if (typeof v !== 'string' || !KEY.test(v)) throw new Error(`${at}.key: must be a short id (letters, digits, - _ .)`); out.key = v; }
    else { if (v !== null && typeof v !== 'string') throw new Error(`${at}.${k}: must be a string or null`); out[k] = v === null ? null : v.trim() || null; }
  }
  return out;
}

// A normalized copy, or throws saying which field is wrong. User-added items with no key get one.
export function validateEdits(e) {
  if (!isObj(e)) throw new Error('edits: must be a JSON object');
  for (const k of Object.keys(e)) if (!TOP.has(k)) throw new Error(`edits.${k}: unknown field`);
  if (e.version !== 1) throw new Error('edits.version: must be 1');
  if (e.updatedAt != null && typeof e.updatedAt !== 'string') throw new Error('edits.updatedAt: must be a string');
  const items = {};
  if (e.items != null && !isObj(e.items)) throw new Error('edits.items: must be an object keyed by item key');
  for (const [k, v] of Object.entries(e.items || {})) {
    if (!KEY.test(k)) throw new Error(`edits.items: bad key "${k}"`);
    items[k] = checkFields(v, FIELDS, `edits.items["${k}"]`);
  }
  if (e.added != null && !Array.isArray(e.added)) throw new Error('edits.added: must be a list');
  const seen = new Set(Object.keys(items));
  const added = (e.added || []).map((a, i) => {
    const at = `edits.added[${i}]`;
    const x = checkFields(a, ADDED, at);
    if (!x.title) throw new Error(`${at}.title: required`);
    if (!x.chapter) throw new Error(`${at}.chapter: required`);
    x.key ||= `u${crypto.randomBytes(5).toString('hex')}`;
    if (seen.has(x.key)) throw new Error(`${at}.key: "${x.key}" is used twice`);
    seen.add(x.key);
    return x;
  });
  if (e.order != null && (!Array.isArray(e.order) || e.order.some((k) => typeof k !== 'string'))) throw new Error('edits.order: must be a list of keys');
  return { version: 1, updatedAt: e.updatedAt ?? null, items, added, ...(e.order ? { order: [...new Set(e.order)] } : {}) };
}

// The session's edits (empty when there are none). Throws when edits.json is unreadable or invalid.
export function readEdits(session) {
  let text;
  try { text = fs.readFileSync(editsFile(session), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return emptyEdits(); throw e; }
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${editsFile(session)}: not JSON (${e.message})`); }
  try { return validateEdits(j); } catch (e) { throw new Error(`${editsFile(session)}: ${e.message}`); }
}

// Replaces edits.json (atomic) with the validated edits; returns what was written.
export function saveEdits(session, edits) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(session, 'session.json'), 'utf8')); } catch { throw new Error(`not a recording: ${session} (no session.json)`); }
  const out = validateEdits(edits);
  const known = new Set((s.chapters || []).map((c) => c.n));
  for (const a of out.added) if (known.size && !known.has(a.chapter)) throw new Error(`edits.added: no chapter ${a.chapter} in ${path.basename(session)}`);
  out.updatedAt = new Date().toISOString();
  const file = editsFile(session), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return out;
}

// Generated items (per chapter, each with a key) with the edits applied, the user's own items added, and the
// edits whose key no longer exists. Pure: chapters is [{ n, kind?, items, ... }].
export function overlay(chapters, edits = emptyEdits()) {
  const used = new Set();
  const pos = new Map((edits.order || []).map((k, i) => [k, i]));
  const out = chapters.map((c) => {
    const gen = (c.items || []).map((it) => {
      const e = edits.items[it.key];
      if (e) used.add(it.key);
      return apply({ ...it, chapter: c.n, origin: it.source === 'agent' ? 'agent' : 'brief', owner: it.owner ?? null, due: it.due ?? null, userNote: null, edited: false, deleted: false }, e);
    });
    const mine = edits.added.filter((a) => a.chapter === c.n).map((a) => {
      used.add(a.key);
      return { id: null, key: a.key, chapter: c.n, note: null, type: a.type || (c.kind === 'diatribe' ? 'action' : 'ask'), title: a.title, when: null, route: null, org: null,
        priority: a.priority ?? null, confidence: null, shot: null, source: 'user', said: null, origin: 'user', owner: a.owner ?? null, due: a.due ?? null, userNote: a.note ?? null, edited: false, deleted: !!a.deleted };
    });
    const items = [...gen, ...mine].map((it, i) => ({ it, i })).sort((a, b) => (pos.get(a.it.key) ?? Infinity) - (pos.get(b.it.key) ?? Infinity) || a.i - b.i).map((x) => x.it);
    return { ...c, items };
  });
  const orphans = [
    ...Object.entries(edits.items).filter(([k]) => !used.has(k)).map(([key, edit]) => ({ key, edit })),
    ...edits.added.filter((a) => !used.has(a.key)).map((a) => ({ key: a.key, added: a })),
  ];
  return { chapters: out, orphans };
}

function apply(it, e) {
  if (!e) return it;
  for (const k of ['title', 'type', 'priority', 'owner', 'due']) if (k in e) it[k] = e[k];
  if ('note' in e) it.userNote = e.note;
  it.edited = Object.keys(e).some((k) => k !== 'deleted');
  it.deleted = !!e.deleted;
  return it;
}

// What an agent may file: everything not deleted.
export const handoffItems = (merged) => merged.chapters.flatMap((c) => c.items.filter((i) => !i.deleted));
