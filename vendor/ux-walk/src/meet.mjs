// Names from Google Meet's live captions: the ux-walk Chrome extension (extension/) logs each caption block with its
// speaker into <walk>/meet.jsonl (through bin/uxw-meet-host). A transcriber numbers voices; Meet knows who they are.
import fs from 'node:fs';
import path from 'node:path';

// Caption events in a chapter's time range (epoch ms).
export function readMeet(sessionDir, startMs, endMs) {
  let text = '';
  try { text = fs.readFileSync(path.join(sessionDir, 'meet.jsonl'), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.kind === 'caption' && e.name && !e.timingUncertain && e.t >= startMs - 5000 && e.t <= endMs + 5000);
}

// A caption block is updated in place as the words come: one span per block, from its first sighting to its last
// update, in seconds from the chapter start. Captions trail speech by about a second, so spans shift back by LAG.
const LAG = 1.2;
export function captionSpans(events, startMs) {
  const blocks = new Map();
  for (const e of events) {
    const k = e.id ?? `${e.name}:${e.t}`;
    const b = blocks.get(k) || { name: e.name, first: e.t, last: e.t, localSpeaker: e.localSpeaker === true };
    b.first = Math.min(b.first, e.t); b.last = Math.max(b.last, e.t);
    blocks.set(k, b);
  }
  return [...blocks.values()].map((b) => ({ name: b.name, localSpeaker: b.localSpeaker, start: (b.first - startMs) / 1000 - LAG - 1, end: (b.last - startMs) / 1000 - LAG + 0.3 }));
}

// cues: [{ start, end, speaker }] with the transcriber's raw labels. Each label takes the name whose caption spans
// overlap its speech the most, when that name holds at least 40% of the label's overlap. Meet calls the local user
// "You": that is `me`.
export function namesFromMeet(cues, spans, me) {
  const score = new Map();
  const scopes = new Map();
  for (const c of cues) {
    if (!c.speaker) continue;
    const scope = `${c.source || ''}:${c.jobId || ''}`;
    if (!scopes.has(c.speaker)) scopes.set(c.speaker, new Set());
    scopes.get(c.speaker).add(scope);
    for (const s of spans) {
      const o = Math.min(c.end, s.end) - Math.max(c.start, s.start);
      if (o <= 0) continue;
      const name = s.localSpeaker || /^you$/i.test(s.name.trim()) ? me : s.name.trim();
      if (!name) continue;
      const m = score.get(c.speaker) || new Map();
      m.set(name, (m.get(name) || 0) + o);
      score.set(c.speaker, m);
    }
  }
  const out = {};
  for (const [label, m] of score) {
    if (scopes.get(label).size > 1) continue;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const sorted = [...m].sort((a, b) => b[1] - a[1]), [name, best] = sorted[0], second = sorted[1]?.[1] || 0;
    if (best >= 0.35 && total > 0 && best / total >= 0.65 && (best - second) / total >= 0.25) out[label] = name;
  }
  return out;
}
