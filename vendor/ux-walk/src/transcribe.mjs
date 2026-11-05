// Transcribers behind one setting (config "transcriber"): each writes transcript.srt next to the audio with
// "Speaker N:" labels, so the timeline code does not care which one ran.
//   elevenlabs  ElevenLabs Scribe: one upload, diarized words back in the same call (about $0.27 an hour)
//   assemblyai  AssemblyAI Universal: upload, submit, poll (about $0.28 an hour)
//   descript    a private Descript project per chapter (src/descript.mjs)
// Keys: env (ELEVENLABS_API_KEY, ASSEMBLYAI_API_KEY, DESCRIPT_API_TOKEN), else the login Keychain item named in
// config, stored by `ux-walk setup` or the menu bar app's Settings.
import fs from 'node:fs';
import path from 'node:path';
import * as descript from './descript.mjs';
import { keyFor, keyPresent } from './keys.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PROVIDERS = {
  elevenlabs: { name: 'ElevenLabs', env: 'ELEVENLABS_API_KEY', item: (cfg) => cfg.elevenlabsKeychainItem, keyUrl: 'https://elevenlabs.io/app/settings/api-keys' },
  assemblyai: { name: 'AssemblyAI', env: 'ASSEMBLYAI_API_KEY', item: (cfg) => cfg.assemblyaiKeychainItem, keyUrl: 'https://www.assemblyai.com/dashboard/api-keys' },
  descript: { name: 'Descript', env: 'DESCRIPT_API_TOKEN', item: (cfg) => cfg.descriptKeychainItem, keyUrl: 'Descript > Settings > API' },
};
for (const p of Object.values(PROVIDERS)) p.keychainItem = p.item;

export function providerKey(cfg, id = cfg.transcriber) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown transcriber "${id}" (use ${Object.keys(PROVIDERS).join(', ')} or none)`);
  return keyFor(p, cfg);
}

export function providerKeyPresent(cfg, id = cfg.transcriber) {
  const p = PROVIDERS[id];
  return !!p && keyPresent(p, cfg);
}

// Before recording: say now, not after the walk, when the chapters would get no transcript. null when fine.
export function transcriberProblem(cfg) {
  if (cfg.transcriber === 'none') return null;
  try { providerKey(cfg); return null; } catch (e) { return e.message; }
}

// Name hints from the glossaries: terms the providers accept (short phrases, no brackets).
const hints = (terms, maxWords) => [...new Set((terms || []).map((t) => t.replace(/[<>{}[\]\\]/g, '').trim()))]
  .filter((t) => t && t.length < 50 && t.split(/\s+/).length <= maxWords).slice(0, 1000);

const ts = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// Words [{ text, start, end, speaker }] (seconds; speaker any stable id) -> SRT, numbering voices in order of
// first speech ("Speaker 1", "Speaker 2"). A cue ends at a voice change, a pause over 1 s, a sentence end
// once 4 s long, or at 10 s.
export function wordsToSrt(words, firstVoices = []) {
  const order = [...firstVoices];
  const cues = [];
  let cur = null;
  for (const w of words) {
    if (!w.text?.trim() || w.start == null) continue;
    if (w.speaker != null && !order.includes(w.speaker)) order.push(w.speaker);
    if (cur && (w.speaker !== cur.speaker || w.start - cur.end > 1 || cur.end - cur.start >= 10)) { cues.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end ?? w.start, speaker: w.speaker, text: w.text.trim() };
    else { cur.text += ' ' + w.text.trim(); cur.end = w.end ?? w.start; }
    if (/[.?!]["')]*$/.test(w.text.trim()) && cur.end - cur.start >= 4) { cues.push(cur); cur = null; }
  }
  if (cur) cues.push(cur);
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.speaker != null ? `Speaker ${order.indexOf(c.speaker) + 1}: ` : ''}${c.text}\n`).join('\n');
}

async function elevenlabs(audio, { key, terms, cfg, log, signal }) {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(audio, { type: path.extname(audio).toLowerCase() === '.wav' ? 'audio/wav' : 'audio/mp4' }), path.basename(audio));
  form.append('model_id', cfg.elevenlabsModel || 'scribe_v2');
  form.append('diarize', 'true');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  form.append('language_code', cfg.language || 'en');
  for (const t of hints(terms, 5)) form.append('keyterms', t);
  log(`uploading to ElevenLabs (${(fs.statSync(audio).size / 1e6).toFixed(1)} MB)`);
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal });
  const text = await r.text();
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${text.slice(0, 300)}`);
  const res = JSON.parse(text);
  return (res.words || []).filter((w) => w.type === 'word').map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker_id }));
}

async function assemblyai(audio, { key, terms, cfg, log, signal }) {
  const API = 'https://api.assemblyai.com/v2';
  const call = async (method, url, body, type = 'application/json') => {
    const r = await fetch(url, { method, headers: { authorization: key, 'content-type': type }, body, ...(body instanceof fs.ReadStream ? { duplex: 'half' } : {}), signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`AssemblyAI ${method} ${url.replace(API, '')} -> ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  log(`uploading to AssemblyAI (${(fs.statSync(audio).size / 1e6).toFixed(1)} MB)`);
  const { upload_url } = await call('POST', `${API}/upload`, fs.createReadStream(audio), 'application/octet-stream');
  const kt = hints(terms, 6);
  const job = await call('POST', `${API}/transcript`, JSON.stringify({
    audio_url: upload_url, speech_models: [cfg.assemblyaiModel || 'universal-3-5-pro', 'universal-2'], speaker_labels: true, language_code: cfg.language || 'en',
    ...(kt.length ? { keyterms_prompt: kt } : {}),
  }));
  for (let i = 0; i < 720; i++) {
    const st = await call('GET', `${API}/transcript/${job.id}`);
    if (st.status === 'completed') return (st.words || []).map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000, speaker: w.speaker }));
    if (st.status === 'error') throw new Error(`AssemblyAI: ${st.error}`);
    await sleep(5000);
  }
  throw new Error(`AssemblyAI job ${job.id} still running after an hour`);
}

async function words(audio, cfg, { terms, log, retry = true, signal }) {
  const id = cfg.transcriber;
  const key = providerKey(cfg, id);
  const fn = id === 'elevenlabs' ? elevenlabs : assemblyai;
  if (!retry) return fn(audio, { key, terms, cfg, log, signal });
  // One retry: a dropped connection on a long upload is the usual failure.
  try { return await fn(audio, { key, terms, cfg, log, signal }); }
  catch (e) {
    if (/\b4\d\d:/.test(e.message)) throw e; // a bad key or request fails the same way twice
    log(`${PROVIDERS[id].name} failed (${e.message}); retrying once`);
    await sleep(5000);
    return fn(audio, { key, terms, cfg, log, signal });
  }
}

export async function transcribeWords(audio, cfg, { terms = [], log = console.log, signal } = {}) {
  if (cfg.transcriber === 'none') return [];
  if (!['elevenlabs', 'assemblyai'].includes(cfg.transcriber)) throw new Error('Live word transcription is supported by ElevenLabs and AssemblyAI only');
  return words(audio, cfg, { terms, log, retry: false, signal });
}

// Writes transcript.srt next to the audio and returns its path.
export async function transcribe(audio, cfg, { terms = [], projectName, log = console.log } = {}) {
  const id = cfg.transcriber;
  if (id === 'descript') return descript.transcribe(audio, { token: providerKey(cfg, id), projectName, log });
  const w = await words(audio, cfg, { terms, log });
  if (!w.length) throw new Error(`${PROVIDERS[id].name} returned no words`);
  const out = path.join(path.dirname(audio), 'transcript.srt');
  fs.writeFileSync(out, wordsToSrt(w));
  fs.writeFileSync(path.join(path.dirname(audio), 'transcriber'), `${id}\n`);
  fs.rmSync(path.join(path.dirname(audio), 'transcript.json'), { force: true });
  return out;
}

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, '');

// A call recorded on two tracks (mic = the people at this Mac, call = the people on the call): each track is
// transcribed on its own (twice the minutes), so who is on which side comes from the track, not the voice.
// Without headphones the mic also hears the call: a mic word the call track has within a second is that echo
// and is dropped. Writes transcript.srt (mic voices numbered first) and transcript.json
// { split: true, mic: ["Speaker 1"], call: ["Speaker 2", ...] }.
export async function transcribeSplit(micAudio, callAudio, cfg, { terms = [], log = console.log } = {}) {
  const [mic, call] = await Promise.all([
    words(micAudio, cfg, { terms, log: (m) => log(`mic: ${m}`) }),
    words(callAudio, cfg, { terms, log: (m) => log(`call: ${m}`) }),
  ]);
  if (!mic.length && !call.length) throw new Error(`${PROVIDERS[cfg.transcriber].name} returned no words`);
  const dir = path.dirname(micAudio);
  // The raw words, so the merge can be tuned again without paying for another transcription.
  fs.writeFileSync(path.join(dir, 'words.json'), JSON.stringify({ mic, call }));
  const { srt, meta } = mergeSplit(mic, call);
  const out = path.join(dir, 'transcript.srt');
  fs.writeFileSync(out, srt);
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'transcriber'), `${cfg.transcriber} (split tracks)\n`);
  log(`transcribed the tracks apart: ${meta.mic.length} voice(s) at this Mac, ${meta.call.length} on the call${meta.echoDropped ? `, ${meta.echoDropped} echoed words dropped` : ''}`);
  return out;
}

// Mic and call words -> one SRT (mic voices numbered first) and its transcript.json.
// Echo: without headphones the mic hears the call too, and the mic's transcript words it slightly differently,
// so matching text alone leaves copies. While someone on the call is talking (a call word within 0.4 s), a mic
// word is kept only when it is the mic's main voice (you) and does not repeat a call word said within 1.5 s.
export function mergeSplit(mic, call) {
  const heard = new Map();
  for (const w of call) { const k = norm(w.text); if (k) (heard.get(k) || heard.set(k, []).get(k)).push(w.start); }
  const repeats = (w) => (heard.get(norm(w.text)) || []).some((t) => Math.abs(t - w.start) < 1.5);
  const callTimes = call.map((w) => [w.start - 0.4, (w.end ?? w.start) + 0.4]).sort((a, b) => a[0] - b[0]);
  const during = (w) => {
    const mid = (w.start + (w.end ?? w.start)) / 2;
    let lo = 0, hi = callTimes.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (callTimes[m][1] < mid) lo = m + 1; else if (callTimes[m][0] > mid) hi = m - 1; else return true; }
    return false;
  };
  const count = new Map();
  for (const w of mic) count.set(w.speaker, (count.get(w.speaker) || 0) + 1);
  const main = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const own = mic.filter((w) => !repeats(w) && (!during(w) || w.speaker === main));
  const tag = (list, side) => list.map((w) => ({ ...w, speaker: `${side}:${w.speaker ?? 0}` }));
  const all = [...tag(own, 'm'), ...tag(call, 'c')].sort((a, b) => a.start - b.start);
  // Voices numbered busiest first on each side: Speaker 1 is the mic's main voice (you).
  const words = new Map();
  for (const w of all) words.set(w.speaker, (words.get(w.speaker) || 0) + 1);
  const busiest = (side) => [...words].filter(([k]) => k.startsWith(side)).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const micVoices = busiest('m:'), callVoices = busiest('c:');
  const order = [...micVoices, ...callVoices];
  const label = (i) => `Speaker ${i + 1}`;
  return {
    srt: wordsToSrt(all, order),
    meta: {
      split: true, mic: micVoices.map((_, i) => label(i)), call: callVoices.map((_, i) => label(micVoices.length + i)),
      words: Object.fromEntries(order.map((k, i) => [label(i), words.get(k)])), echoDropped: mic.length - own.length,
    },
  };
}
