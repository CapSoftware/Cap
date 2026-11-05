// "ux-walk brief": Claude reads a processed chapter (timelines + screenshots) and writes brief.md:
// the notes, asks, decisions and bugs in it, each with an id (C1-04), time, route, quote, screenshot
// and what was clicked; then errors, and questions for the person who recorded. items.json holds the
// same items parsed, for `ux-walk link/status/search`. Uses the Claude Code CLI (claude -p) with
// read-only tools, confined to the chapter folder. Long chapters are briefed per section and merged.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expand, ROOT } from './config.mjs';

const SPLIT_S = 25 * 60; // chapters longer than this are briefed per section (when it has sections)
const PART_S = 10 * 60; // sections are grouped into parts of at least this long
const PART_BYTES = 40000; // ...or this much timeline, so each run can read all of its slice
const PARALLEL = 3;

const pad = (n) => String(n).padStart(2, '0');
const clock = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;

// A chapter's kind ('diatribe', 'import', 'call', 'video'), else its session's: an app that records natively may set either.
export function chapterKind(dir, meta = readJson(path.join(dir, 'chapter.json'))) {
  return meta.kind || readJson(path.join(path.dirname(dir), 'session.json')).kind || null;
}
// A diatribe (someone thinking out loud) gets organized notes and action items; everything else, the walkthrough brief.
export const promptFile = (kind) => path.join(ROOT, 'prompts', kind === 'diatribe' ? 'notes.md' : 'brief.md');

export async function runBrief(dir, cfg, { log = () => {} } = {}) {
  const timeline = path.join(dir, 'timeline-short.md');
  if (!fs.existsSync(timeline)) throw new Error(`no timeline in ${dir}; run: ux-walk process ${dir}`);
  const meta = readJson(path.join(dir, 'chapter.json'));
  const sum = readJson(path.join(dir, 'summary.json'));
  const n = meta.n || 1;
  const kind = chapterKind(dir, meta);
  const title = [meta.topic, meta.name].filter(Boolean).join(' / ') || path.basename(dir);
  const speakers = [...new Set([].concat(meta.speakers || [], Object.values(meta.speakerMap || {})))];
  const first = speakers[0] || cfg.me || 'the speaker';
  // Project-specific notes (what the product is, its audiences, house rules) go in a local file.
  const notesFile = expand(cfg.briefNotes || '');
  const notes = notesFile && fs.existsSync(notesFile) ? `\n\nNotes about this product from the person recording:\n${fs.readFileSync(notesFile, 'utf8').trim()}\n` : '';
  const base = fs.readFileSync(promptFile(kind), 'utf8').replaceAll('{N}', String(n)).replaceAll('{FIRST_SPEAKER}', first) + notes + importNote(meta) +
    `\n\nChapter number: ${n}\nChapter title: ${title}\nSpeakers: ${speakers.join(', ') || 'unknown'}\n`;
  const run = (extra = '') => runClaude(base + extra, { cwd: dir, model: cfg.briefModel || 'sonnet', tools: 'Read,Glob,Grep', addDir: path.dirname(dir) }).then(cut);

  const dur = sum.durationS || (meta.endMs && meta.startMs ? (meta.endMs - meta.startMs) / 1000 : 0);
  const parts = dur > SPLIT_S && fs.existsSync(path.join(dir, 'sections.json')) ? splitTimeline(fs.readFileSync(timeline, 'utf8'), dur) : [];
  let briefs;
  if (parts.length > 1) {
    // One run per stretch of sections, up to three at once; each reads only its own slice.
    const pdir = path.join(dir, 'brief-parts');
    fs.mkdirSync(pdir, { recursive: true });
    log(`brief in ${parts.length} parts (${parts.map((p) => `${clock(p.from)}-${clock(p.to)}`).join(', ')})`);
    briefs = await pool(parts, PARALLEL, async (p, i) => {
      const rel = `brief-parts/${pad(i + 1)}-timeline-short.md`;
      fs.writeFileSync(path.join(dir, rel), p.text);
      const out = await run(`\nThis run covers only ${clock(p.from)} to ${clock(p.to)} of the chapter (${p.titles.join('; ')}). ` +
        `Read \`${rel}\` in place of \`timeline-short.md\`: it holds just that stretch. Look in timeline.md only between those times. ` +
        'Other runs cover the rest of the chapter, so leave out anything outside this stretch. Number ids from 01 as usual; they are renumbered when the parts are merged.\n');
      fs.writeFileSync(path.join(pdir, `${pad(i + 1)}-brief.md`), out);
      return { ...parseBrief(out), range: `${clock(p.from)}-${clock(p.to)}`, titles: p.titles };
    });
  } else {
    briefs = [parseBrief(await run())];
  }
  let merged = mergeBriefs(briefs, { n, title, first, kind });
  // Parts cannot see each other: one cheap text-only pass finds items raised again in a later part.
  if (briefs.length > 1 && merged.items.length > 1) {
    const fold = await findRepeats(merged.items.filter((i) => i.type !== 'error'), cfg).catch((e) => { log(`repeat check skipped: ${e.message}`); return []; });
    if (fold.length) { log(`folded ${fold.length} repeated item(s): ${fold.map(([k, d]) => `${d} into ${k}`).join(', ')}`); merged = mergeBriefs(briefs, { n, title, first, fold, kind }); }
  }
  const file = path.join(dir, 'brief.md');
  fs.writeFileSync(file, merged.text);
  let agentItems = [];
  try { agentItems = JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8')).items.filter((i) => i.source === 'agent'); } catch {}
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ chapter: n, title, ...(kind === 'diatribe' ? { kind } : {}), generatedAt: new Date().toISOString(), parts: briefs.length, items: withKeys([...merged.items, ...agentItems], n), decisions: merged.decisions, questions: merged.questions }, null, 2) + '\n');
  if (merged.dropped) log(`dropped ${merged.dropped} "screenshot not opened" line(s)`);
  return file;
}

// A recording made outside ux-walk (`ux-walk import`): no click log, so the timeline has speech and screenshots
// only. Said once here so the brief does not raise the missing NAV lines on every item.
export function importNote(meta) {
  if (meta.kind !== 'import') return '';
  const s = meta.source || {};
  const what = s.audioOnly ? 'a voice memo (audio only)'
    : `a screen recording made on ${s.device === 'iPhone' ? 'an iPhone' : s.device === 'phone' ? 'a phone' : 'a device'} outside ux-walk${s.device ? ' (a phone-sized screen, portrait or landscape)' : ''}`;
  return `\n\nThis chapter was imported: it is ${what}${s.file ? ` (\`${s.file}\`)` : ''}. There is no click log, so the timeline has ` +
    `speech (SAY)${s.audioOnly ? '' : ' and screenshots'} only: no NAV, CONTEXT, clicks, keys, writes, errors or page text. That is expected; ` +
    'never raise it as an item, a question or a reason for lower confidence, and never write "no NAV line", "page path unknown" or "nothing recorded". ' +
    (s.audioOnly
      ? 'There are no screenshots: leave out the Screen line. '
      : 'Take the screen and the org from the screenshots (the nearest shot before and after each SAY line) and from the speech. ') +
    'Write the When line as `{mm:ss} on {the screen as the app names it, e.g. "Call schedule, by shift"} · org: {org, when shown or said}` ' +
    'with no backticks around the screen name. Leave out the Did and Source lines. Under Errors write "None." (nothing was logged).\n';
}

export async function findRepeats(items, cfg) {
  const list = items.map((i) => `${i.id} · ${i.type} · ${i.when || ''} · ${i.title} · ${(i.said || '').slice(0, 160)}`).join('\n');
  const out = await runClaude(`Below are items from one recorded product walkthrough, briefed in separate parts, so the same ask or bug can appear twice.
List the pairs that are the same ask, bug or decision (the same change would settle both). Not pairs that are merely related.
Reply with JSON only: [["<earlier id>", "<later id>"], ...] or [].

${list}
`, { cwd: ROOT, model: cfg.sectionsModel || 'haiku' });
  const j = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1) || '[]');
  const num = (id) => Number(String(id).split('-')[1]);
  return j.filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => (num(a) < num(b) ? [a, b] : [b, a]));
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
// The model sometimes narrates before the brief ("Writing the brief now..."); keep the brief only.
const cut = (out) => { const at = out.search(/^# Brief/m); return (at > 0 ? out.slice(at) : out).trim() + '\n'; };

async function pool(list, max, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(max, list.length) }, async () => {
    for (let i; (i = next++) < list.length;) out[i] = await fn(list[i], i);
  }));
  return out;
}

// Group the timeline's "## mm:ss title" sections into parts of at least PART_S; a short tail joins
// the part before it. Each part gets the timeline header plus its own sections.
export function splitTimeline(text, dur) {
  const lines = text.split('\n');
  const heads = lines.map((l, i) => { const m = /^## (\d+):(\d\d) (.*)/.exec(l); return m && { i, t: +m[1] * 60 + +m[2], title: m[3].trim() }; }).filter(Boolean);
  if (heads.length < 2) return [];
  const header = lines.slice(0, heads[0].i).join('\n');
  const secs = heads.map((h, k) => ({ ...h, end: heads[k + 1]?.t ?? dur, body: lines.slice(h.i, heads[k + 1]?.i ?? lines.length).join('\n') }));
  const parts = [];
  let cur = null;
  for (const s of secs) {
    if (!cur) parts.push(cur = { from: s.t, to: s.end, titles: [], bodies: [] });
    cur.to = s.end; cur.titles.push(s.title); cur.bodies.push(s.body);
    cur.size = (cur.size || 0) + s.body.length;
    if (cur.to - cur.from >= PART_S || cur.size >= PART_BYTES) cur = null;
  }
  const last = parts.at(-1);
  if (parts.length > 1 && last.to - last.from < PART_S / 2) {
    const prev = parts.at(-2);
    prev.to = last.to; prev.titles.push(...last.titles); prev.bodies.push(...last.bodies); parts.pop();
  }
  return parts.map((p) => ({ from: p.from, to: p.to, titles: p.titles, text: `${header}\n${p.bodies.join('\n')}\n` }));
}

const ID = /\bC\d+-Q?\d+\b/g;
const NONE = /^(none|nothing|n\/a|-)\.?$/i;
const LEAK = /not (been )?opened|(did ?n[o']t|could ?n[o']t|cannot|can't|unable to) (open|view|see) (it|the (screenshot|shot|image|crop))|without opening/i;

// brief.md -> { title, summary, items, decisions, errors, questions }. Tolerant of missing ids.
export function parseBrief(text) {
  const out = { title: '', summary: '', notes: '', items: [], decisions: [], errors: [], questions: [] };
  const blocks = text.split(/^(?=## )/m);
  const head = blocks.shift() || '';
  out.title = (/^# Brief:?\s*(.*)$/m.exec(head) || [])[1] || '';
  out.summary = head.replace(/^# .*$/m, '').trim();
  for (const b of blocks) {
    const name = b.slice(3, b.indexOf('\n') < 0 ? undefined : b.indexOf('\n')).trim().toLowerCase();
    const body = b.slice(b.indexOf('\n') + 1);
    if (name.startsWith('items')) {
      for (const it of body.split(/^(?=### )/m).filter((x) => x.startsWith('### '))) out.items.push(parseItem(it));
    } else if (name.startsWith('notes')) {
      out.notes = body.trim();
    } else if (name.startsWith('decision')) {
      out.decisions.push(...listLines(body).filter((l) => !NONE.test(l)));
    } else if (name.startsWith('error')) {
      for (const l of listLines(body)) {
        if (NONE.test(l)) continue;
        const m = /^(C\d+-\d+)?\s*(?:·\s*)?(.*)$/s.exec(l);
        out.errors.push({ id: m[1] || null, rest: m[2].trim() });
      }
    } else if (name.startsWith('question') || name.startsWith('not sure')) {
      for (const l of body.split('\n')) {
        const m = /^\s*(?:\d+\.|-)\s+(C\d+-Q\d+)?\s*(?:\((\d+:\d\d)\))?\s*[:·-]?\s*(.+)$/.exec(l);
        if (m && !NONE.test(m[3].trim())) out.questions.push({ id: m[1] || null, when: m[2] || (/\b(\d+:\d\d)\b/.exec(m[3]) || [])[1] || null, text: m[3].trim() });
      }
    }
  }
  return out;
}

// "- " list entries; a continuation line (indented, not a new entry) joins the one before it.
function listLines(body) {
  const out = [];
  for (const l of body.split('\n')) {
    if (/^- /.test(l)) out.push(l.slice(2).trim());
    else if (l.trim() && out.length && /^\s/.test(l)) out[out.length - 1] += ' ' + l.trim();
  }
  return out;
}

function parseItem(block) {
  const [h, ...rest] = block.split('\n');
  const m = /^###\s+(C\d+-\d+)?\s*(?:\(note #(\d+)\))?\s*[:·-]?\s*(.*)$/.exec(h.trim());
  const fields = [];
  for (const l of rest) {
    const f = /^- \*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(l);
    if (f) fields.push({ key: f[1].trim(), value: f[2].trim() });
    else if (l.trim() && fields.length && !/^#/.test(l)) fields.at(-1).value += ' ' + l.trim();
  }
  const it = { id: m[1] || null, note: null, title: m[3].trim(), fields };
  it.note = m[2] ? Number(m[2]) : Number((/note #(\d+)/i.exec(field(it, 'note')) || [])[1]) || null;
  return it;
}

// Item fields agents and the ledger use, from the parsed block.
const field = (it, k) => it.fields.find((f) => f.key.toLowerCase() === k)?.value || '';
const TYPES = /\b(bug|ask|decision|question|error)\b/i, DIATRIBE_TYPES = /\b(action|decision|note|question)\b/i;
function itemFacts(it, kind) {
  const g = (k) => field(it, k);
  const diatribe = kind === 'diatribe';
  const when = g('when'), screen = g('screen'), said = g('said');
  const shot = (/`((?:notes|shots)\/[^`]+)`/.exec(g('note')) || /`((?:notes|shots)\/[^`]+)`/.exec(screen || g('shot')) || [])[1] || null;
  const type = ((diatribe ? DIATRIBE_TYPES : TYPES).exec(g('type')) || [])[1]?.toLowerCase() || (diatribe ? 'note' : 'bug');
  const owner = g('owner'), due = g('due');
  return {
    id: it.id, note: it.note, type, title: it.title,
    when: (/\b(\d+:\d\d)\b/.exec(when) || [])[1] || null,
    route: (/`([^`]+)`/.exec(when) || [])[1] || null,
    org: (/org:\s*([^·`]+?)\s*$/.exec(when) || [])[1] || null,
    priority: g('priority') || null,
    confidence: (/\b(high|medium|low)\b/i.exec(g('confidence')) || [])[1]?.toLowerCase() || null,
    shot,
    source: g('source') || null,
    said: said && !NONE.test(said) ? said : null,
    // Only a diatribe's items carry these, so a walk's items.json is as it was.
    ...(diatribe && owner && !NONE.test(owner) ? { owner } : {}),
    ...(diatribe && due && !NONE.test(due) ? { due } : {}),
  };
}

// A short id for an item that survives a re-brief and renumbering: chapter, time and quote (else title).
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const itemKey = (n, it) => crypto.createHash('sha1').update(`${n}|${it.when || ''}|${norm(it.said) || norm(it.title)}`).digest('hex').slice(0, 10);
// Every item gets a key (an existing one is kept); two items with the same basis get -2, -3 in order.
export function withKeys(items, n) {
  const seen = new Set();
  return items.map((i) => {
    const base = i.key || itemKey(n, i);
    let key = base;
    for (let k = 2; seen.has(key); k++) key = `${base}-${k}`;
    seen.add(key);
    return i.key === key ? i : { ...i, key };
  });
}

// Order: notes (by number), spoken asks (a diatribe's actions), decisions, spoken bugs (or questions and notes),
// unspoken problems. Stable within a group.
const rank = (f) => (f.note ? 0 : !f.said ? 4 : f.type === 'ask' || f.type === 'action' ? 1 : f.type === 'decision' ? 2 : 3);

// Merge one or more parsed briefs into one brief.md with continuous ids, and the items.json lists.
// fold: [[keep, drop], ...] in the ids an earlier call gave; the dropped item's speech joins the kept one.
export function mergeBriefs(briefs, { n, title, first, fold = [], kind = null }) {
  const diatribe = kind === 'diatribe';
  let dropped = 0;
  const all = [];
  briefs.forEach((b, p) => b.items.forEach((it, k) => {
    it.fields = it.fields.flatMap((f) => {
      if (!LEAK.test(f.value)) return [f];
      dropped++;
      // Keep the path (agents can open it) without the claim that nobody looked.
      if (/^screen$/i.test(f.key)) { const shot = /`((?:notes|shots)\/[^`]+)`/.exec(f.value); return shot ? [{ key: 'Shot', value: `\`${shot[1]}\`` }] : []; }
      const v = f.value.split(/(?<=[.;])\s+/).filter((x) => !LEAK.test(x)).join(' ').trim();
      return v ? [{ ...f, value: v }] : [];
    });
    all.push({ it, p, k, f: itemFacts(it, kind) });
  }));
  all.sort((a, b) => rank(a.f) - rank(b.f) || (a.f.note && b.f.note ? a.f.note - b.f.note : 0) || a.p - b.p || a.k - b.k);
  const maps = briefs.map(() => new Map());
  const pre = new Map(all.map((a, i) => [`C${n}-${pad(i + 1)}`, a]));
  for (const [k, d] of fold) {
    let keep = pre.get(k);
    const drop = pre.get(d);
    while (keep?.gone) keep = keep.gone; // A into B, then B into C: all land on the first one
    if (!keep || !drop || keep === drop || drop.gone) continue;
    drop.gone = keep;
    const said = drop.it.fields.find((f) => /^said$/i.test(f.key));
    const at = drop.f.when ? ` (again at ${drop.f.when})` : '';
    const mine = keep.it.fields.find((f) => /^said$/i.test(f.key));
    if (said && mine) mine.value += `; ${said.value}${at}`;
    else if (said) keep.it.fields.push({ key: 'Said', value: said.value + at });
  }
  let seq = 0, q = 0;
  const nextId = () => `C${n}-${pad(++seq)}`;
  const kept = all.filter((a) => !a.gone);
  for (const a of kept) { const id = nextId(); if (a.it.id) maps[a.p].set(a.it.id, id); a.id = id; }
  for (const a of all) if (a.gone && a.it.id) maps[a.p].set(a.it.id, a.gone.id);
  const errors = briefs.flatMap((b, p) => b.errors.map((e) => { const id = nextId(); if (e.id) maps[p].set(e.id, id); return { ...e, p, id }; }));
  const questions = briefs.flatMap((b, p) => b.questions.map((x) => { const id = `C${n}-Q${++q}`; if (x.id) maps[p].set(x.id, id); return { ...x, p, id, n: q }; }));
  const re = (p, s) => s.replace(ID, (m) => maps[p].get(m) ?? m);
  const decisions = briefs.flatMap((b, p) => b.decisions.map((d) => re(p, d)));

  const summary = briefs.length === 1 ? re(0, briefs[0].summary)
    : briefs.map((b) => `- ${b.range} (${b.titles.join('; ')}): ${b.summary.replace(/\s+/g, ' ')}`).join('\n');
  const L = [`# Brief: ${title}`, '', summary, ''];
  // A diatribe's organized notes, by topic (per part when it was briefed in parts).
  if (diatribe) {
    const notes = briefs.map((b, p) => b.notes && (briefs.length > 1 ? `**${b.range}**\n\n` : '') + re(p, b.notes)).filter(Boolean);
    L.push('## Notes', '', notes.length ? notes.join('\n\n') : 'None.', '');
  }
  L.push('## Items', '');
  if (!kept.length) L.push('None.', '');
  for (const a of kept) {
    L.push(`### ${a.id}${a.f.note ? ` (note #${a.f.note})` : ''} ${a.it.title}`);
    for (const f of a.it.fields) L.push(`- **${f.key}:** ${re(a.p, f.value)}`);
    L.push('');
  }
  L.push('## Decisions', '', ...(decisions.length ? decisions.map((d) => `- ${d}`) : ['None.']), '');
  if (!diatribe || errors.length) L.push('## Errors', '', ...(errors.length ? errors.map((e) => `- ${e.id} · ${re(e.p, e.rest)}`) : ['None.']), '');
  L.push(`## Questions for ${first}`, '', ...(questions.length ? questions.map((x) => `${x.n}. ${x.id}${x.when ? ` (${x.when})` : ''} ${re(x.p, x.text).replace(/^\(\d+:\d\d\)\s*/, '')}`) : ['None.']), '');

  const items = [
    ...kept.map((a) => ({ ...itemFacts(a.it, kind), id: a.id })),
    ...errors.map((e) => ({ id: e.id, note: null, type: 'error', title: e.rest.replace(/^\d+:\d\d\s*·\s*/, '').replace(/^on `[^`]*`\s*·\s*/, '').slice(0, 160), when: (/\b(\d+:\d\d)\b/.exec(e.rest) || [])[1] || null, route: (/`([^`]+)`/.exec(e.rest) || [])[1] || null, priority: null, confidence: null, shot: null })),
  ];
  return {
    text: L.join('\n').replace(/\n{3,}/g, '\n\n'),
    items,
    decisions,
    questions: questions.map((x) => ({ id: x.id, n: x.n, when: x.when, text: x.text.replace(/^\(\d+:\d\d\)\s*/, '') })),
    dropped,
  };
}

// claude -p with read-only tools (or none), no settings, MCP or session saved. Resolves to stdout.
export function runClaude(prompt, { cwd, model, tools = '', addDir }) {
  const args = ['-p', '--model', model, '--output-format', 'text',
    ...(tools ? ['--allowedTools', tools] : []), ...(addDir ? ['--add-dir', addDir] : []), '--disallowedTools', `Bash,Edit,Write,WebFetch,WebSearch${tools ? '' : ',Read,Glob,Grep'}`,
    '--setting-sources', 'local', '--strict-mcp-config', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { e += d; });
    p.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? 'the claude CLI is not installed (https://claude.com/claude-code)' : err.message)));
    p.on('exit', (code) => (code === 0 && o.trim() ? resolve(o) : reject(new Error(`claude exited ${code}: ${(e || o).trim().slice(0, 300)}`))));
    p.stdin.end(prompt);
  });
}
