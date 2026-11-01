// Process one chapter (or a recording from the old shell tool): audio, screenshots, transcript, timelines.
// Safe to rerun; finished steps are skipped unless forced.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROVIDERS, transcribe, transcribeSplit } from './transcribe.mjs';
import { guessVoices, readSplit, splitNames } from './speakers.mjs';
import { callSpan, clipPath, readCalled, readClip, saveCalled, stripPrefix, writeClipInfo } from './rollcall.mjs';
import { captionSpans, namesFromMeet, readMeet } from './meet.mjs';
import { runBrief } from './brief.mjs';
import { glossaryTerms, nameFixer, readGlossaries, resolveGlossaries, screenNames } from './glossary.mjs';
import { ROOT, expand } from './config.mjs';
import { topicSections } from './sections.mjs';
import { callLoudness, nameByCall } from './voices.mjs';
import { buildTimeline, glossaryRules, listShots, parseSrt, readActions, renderTimeline, screenSections, shotTimes } from './timeline.mjs';

const run = promisify(execFile);

// The ux-walk commit that built a timeline, so an output from older code shows it.
let VERSION;
export function toolVersion() {
  if (VERSION === undefined) {
    try {
      const sha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'src', 'bin', 'prompts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      VERSION = sha + (dirty ? '+dirty' : '');
    } catch { VERSION = null; }
  }
  return VERSION;
}

// Where each test id is defined in the app's repo (config sourceRoot, optional sourceGlobs, and
// sourceRef to read a branch such as origin/main instead of the checkout's files): one git
// grep per run for every test id prop and every kebab-prefixed template string, then matched here.
// An exact literal beats a template's static prefix ("call-chip-${id}" for call-chip-5b619d94:...);
// app code beats tests and stories. Returns (testid) => "path:line" or null.
const SOURCES = new Map();
export function sourceIndex(root, globs, ref) {
  root = expand(String(root || ''));
  if (!root) return null;
  const key = `${root}|${globs || ''}|${ref || ''}`;
  if (SOURCES.has(key)) return SOURCES.get(key);
  let out = '';
  try {
    const specs = (Array.isArray(globs) ? globs : String(globs || '').split(',')).map((g) => g.trim()).filter(Boolean).map((g) => (g.startsWith(':') ? g : `:(glob)${g}`));
    // Without globs: source files only (a whole repo with data dumps takes 20 s; src/** under 1 s).
    if (!specs.length) specs.push(...['tsx', 'ts', 'jsx', 'js', 'mjs', 'vue', 'svelte', 'html'].map((x) => `*.${x}`), ':!*.min.js');
    out = execFileSync('git', ['-C', root, 'grep', '-n', '-I', '-E', '-e', '[tT]est-?[iI]d', '-e', '`[a-z][a-z0-9-]*-\\$\\{', ...(ref ? [ref] : []), '--', ...specs],
      { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { out = e.stdout || ''; }
  const exact = new Map(), prefixes = [];
  const testish = (p) => /(^|\/)(__tests__|tests?|e2e|stories)\/|\.(test|spec|stories)\.|\.e2e\./.test(p);
  for (const line of out.split('\n')) {
    const m = (ref && line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line).match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, n, code] = m;
    const at = `${file}:${n}`, low = testish(file) ? 2 : 0;
    // data-testid=, testId=, removeTestId=, testIdPrefix=, 'data-testid': ; not a CSS selector ([data-testid="x"]).
    const km = code.match(/(?<![\w[-])[\w-]*[tT]est-?[iI]d\w*['"]?\s*[=:]/);
    const k = km ? km.index : -1;
    // On a test id line: the literals right after the prop (up to the next attribute); elsewhere a
    // template string's static start.
    const rest = k >= 0 ? code.slice(k).replace(/^[^=:]*[=:]/, '').split(/\s[\w-]+=/)[0] : code;
    for (const l of rest.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`?/g)) {
      const lit = l[1] ?? l[2] ?? l[3] ?? '';
      const tmpl = l[3] != null && lit.includes('${');
      if (!tmpl && k >= 0 && /^[A-Za-z0-9][\w:.-]*$/.test(lit)) { const p = exact.get(lit); if (!p || p.rank > low) exact.set(lit, { at, rank: low }); }
      else if (tmpl) {
        const pre = lit.slice(0, lit.indexOf('${'));
        if (pre.length >= (k >= 0 ? 4 : 8) && /^[A-Za-z0-9][\w:.-]*$/.test(pre)) prefixes.push({ pre, at, rank: low + (k >= 0 ? 0 : 1) });
      }
    }
  }
  const memo = new Map();
  const find = (id) => {
    if (!id) return null;
    if (memo.has(id)) return memo.get(id);
    const pre = prefixes.filter((p) => id.startsWith(p.pre)).sort((a, b) => (a.rank >= 2) - (b.rank >= 2) || b.pre.length - a.pre.length || a.rank - b.rank)[0];
    // A family named by a prop ("call-pager" -> "call-pager-next"): the longest literal it extends.
    const cut = id.split('-');
    let base = null, blen = 0;
    for (let i = cut.length - 1; i >= 2 && !base; i--) { base = exact.get(cut.slice(0, i).join('-')); blen = cut.slice(0, i).join('-').length + 1; }
    // The more specific of the two wins: a template's static start or the family's own name.
    const hit = exact.get(id)?.at || (pre && (!base || pre.pre.length >= blen) ? pre.at : base?.at) || null;
    memo.set(id, hit);
    return hit;
  };
  SOURCES.set(key, find);
  return find;
}

// Page-text snapshots taken during the chapter (and the one on screen when it began).
function chapterSnapshots(ch, endMs) {
  const d = path.join(path.dirname(ch.actionsFile), 'snapshots');
  if (!fs.existsSync(d)) return [];
  const all = fs.readdirSync(d).filter((f) => /^\d+\.yml$/.test(f)).map((f) => ({ t: Number(f.slice(0, -4)), f: path.join(d, f) })).sort((a, b) => a.t - b.t);
  const before = all.filter((x) => x.t < ch.startMs).at(-1);
  return [...(before ? [before] : []), ...all.filter((x) => x.t >= ch.startMs && x.t <= endMs)].map((x) => x.f);
}

// Why a chapter's timeline is out of date, or null: a glossary changed after it, or other code built it.
export function staleReason(dir, cfg = {}) {
  const tl = path.join(dir, 'timeline.md');
  if (!fs.existsSync(tl)) return null;
  const at = fs.statSync(tl).mtimeMs;
  let ch = {};
  try { ch = JSON.parse(fs.readFileSync(path.join(dir, 'chapter.json'), 'utf8')); } catch {}
  let files = [];
  try { files = ch.glossaries || resolveGlossaries(cfg.glossary); } catch {}
  const newer = files.find((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs > at);
  if (newer) return `glossary ${path.basename(newer)} changed after the timeline`;
  const v = toolVersion(), head = fs.readFileSync(tl, 'utf8').slice(0, 600).match(/built by ux-walk (\S+?)\./);
  if (v && !v.endsWith('+dirty') && head?.[1] !== v) return `built by ux-walk ${head?.[1] || 'an older version'}, now ${v}`;
  return null;
}

// Chapters under a session folder or the whole output folder whose timeline is stale.
export function staleChapters(root, cfg = {}) {
  const out = [];
  const visit = (d, depth) => {
    if (fs.existsSync(path.join(d, 'timeline.md'))) { const why = staleReason(d, cfg); if (why) out.push({ dir: d, why }); return; }
    if (depth > 2) return;
    for (const x of fs.readdirSync(d, { withFileTypes: true })) if (x.isDirectory() && !x.name.startsWith('.')) visit(path.join(d, x.name), depth + 1);
  };
  if (fs.existsSync(root)) visit(root, 0);
  return out;
}

// Chapter layout (new) or a single-recording folder from the shell version (old).
export function readChapter(dir) {
  const cj = path.join(dir, 'chapter.json');
  if (fs.existsSync(cj)) {
    const c = JSON.parse(fs.readFileSync(cj, 'utf8'));
    // An imported voice memo names its audio as the chapter's media ("video": "audio.m4a").
    return { ...c, dir, video: path.join(dir, c.video || 'video.mp4'), actionsFile: path.resolve(dir, c.actions || 'actions.jsonl') };
  }
  const start = path.join(dir, 'video-start-epoch-ms');
  if (!fs.existsSync(start)) throw new Error(`${dir} is not a ux-walk chapter (no chapter.json or video-start-epoch-ms)`);
  const video = ['video.mp4', 'screen.mp4'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  return { n: 1, name: path.basename(dir), dir, video, startMs: Number(fs.readFileSync(start, 'utf8')), endMs: null, actionsFile: path.join(dir, 'actions.jsonl') };
}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const audioTracks = (j.streams || []).filter((x) => x.codec_type === 'audio').length;
  return { dur: Number(j.format?.duration) || 0, hasAudio: audioTracks > 0, audioTracks, hasVideo: (j.streams || []).some((x) => x.codec_type === 'video') };
}

async function grabShots(video, times, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const queue = times.map((t, i) => ({ t, file: path.join(outDir, `${String(i + 1).padStart(4, '0')}-${String(Math.floor(t / 60)).padStart(2, '0')}m${(t % 60).toFixed(1).padStart(4, '0')}s.jpg`) }));
  const worker = async () => {
    for (let job; (job = queue.shift());) {
      if (fs.existsSync(job.file)) continue;
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', job.t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2', '-q:v', '5', job.file]).catch(() => {});
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

export async function processChapter(dir, cfg, { force = [], speakers, glossary, brief, quiet, transcriptOnly = false, media, log = console.log } = {}) {
  const ch = readChapter(dir);
  if (media != null) {
    if (!transcriptOnly) throw new Error('An alternate media input is only supported for transcript-only processing');
    ch.video = path.resolve(media);
  }
  const t0 = Date.now();
  // process.log (quiet) gets the time of each step, so a slow one shows.
  const step = (s) => log(`${quiet ? `[${new Date().toTimeString().slice(0, 8)}] ` : ''}[${ch.name}] ${s}`);
  const stale = staleReason(dir, cfg);
  if (stale) step(`rebuilding the timeline: ${stale}`);
  const has = (f) => fs.existsSync(path.join(dir, f)) && !force.includes(f);

  if (!ch.video) throw new Error(`no video in ${dir}`);
  const { dur, hasAudio, audioTracks, hasVideo } = await probe(ch.video);
  const endMs = ch.endMs || ch.startMs + dur * 1000;
  const actions = readActions(ch.actionsFile, ch.startMs, endMs);

  // 1. Audio for the transcriber.
  const audio = path.join(dir, 'audio.m4a');
  if (hasAudio && !has('audio.m4a')) {
    step('extracting audio');
    // Two tracks (microphone + call): the transcriber hears both, mixed at their own levels.
    await run('ffmpeg', audioTracks > 1
      ? ['-v', 'error', '-y', '-i', ch.video, '-filter_complex', '[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0[a]', '-map', '[a]', '-c:a', 'aac', '-b:a', '96k', audio]
      : ['-v', 'error', '-y', '-i', ch.video, '-vn', '-map', '0:a:0', '-c:a', 'copy', audio]);
  }

  // A call on its own track with speech on it: transcribe the mic and the call apart (ElevenLabs, AssemblyAI).
  const callDb = audioTracks > 1 ? await callLoudness(ch.video) : null;
  const callSpeech = !!callDb && callDb.filter((x) => x > -45).length / callDb.length >= 0.01;
  const splitTracks = callSpeech && cfg.splitTracks !== false && cfg.splitTracks !== 'false' && ['elevenlabs', 'assemblyai'].includes(cfg.transcriber);
  const micAudio = path.join(dir, 'audio-me.m4a'), callAudio = path.join(dir, 'audio-them.m4a');
  if (splitTracks && !has('transcript.srt')) {
    for (const [file, track] of [[micAudio, 0], [callAudio, 1]]) {
      if (!fs.existsSync(file)) await run('ffmpeg', ['-v', 'error', '-y', '-i', ch.video, '-map', `0:a:${track}`, '-vn', '-c:a', 'copy', file]);
    }
  }

  // 2. Screenshots and the transcript run side by side.
  const shotsDir = path.join(dir, 'shots');
  const shots = (async () => {
    if (transcriptOnly) return;
    if (force.includes('shots')) fs.rmSync(shotsDir, { recursive: true, force: true });
    if (fs.existsSync(shotsDir) && fs.readdirSync(shotsDir).length) return;
    if (!hasVideo) return; // a voice memo
    const times = shotTimes(actions, ch.startMs, dur);
    step(`grabbing ${times.length} screenshots`);
    await grabShots(ch.video, times, shotsDir);
  })();
  // Name hints for the transcriber: the glossaries' right spellings and the names on screen.
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);
  const files = glossary != null ? resolveGlossaries(glossary) : ch.glossaries || resolveGlossaries(cfg.glossary);
  const names = screenNames(chapterSnapshots(ch, endMs));
  const transcript = (async () => {
    if (has('transcript.srt')) return;
    if (cfg.transcriber === 'none' || !hasAudio) return;
    step(`transcribing (${PROVIDERS[cfg.transcriber]?.name || cfg.transcriber}${splitTracks ? ', mic and call apart' : ''})`);
    const session = path.basename(path.dirname(dir));
    if (splitTracks) return transcribeSplit(micAudio, callAudio, cfg, { terms: [...glossaryTerms(files), ...[...names].sort((x, y) => y.n - x.n).slice(0, 80).map((x) => x.name)], log: step });
    const opts = { terms: [...glossaryTerms(files), ...[...names].sort((x, y) => y.n - x.n).slice(0, 80).map((x) => x.name)], projectName: `${ch.topic ? session : ch.name} ${ch.n ? `ch${ch.n}` : ''}`.trim(), log: step };
    const walk = path.dirname(dir), people = list(ch.speakers ?? cfg.speakers), srt = path.join(dir, 'transcript.srt');
    const clip = ch.topic && ch.n > 1 && people.length > 1 ? readClip(walk) : null;
    if (!clip) {
      await transcribe(audio, cfg, opts);
      // Chapter 1: keep the roll call's audio (up to the end of the last name line) for the chapters after it.
      if (ch.topic && people.length > 1 && !readClip(walk) && fs.existsSync(srt)) {
        const { called, end } = callSpan(fs.readFileSync(srt, 'utf8'), people);
        if (Object.keys(called).length && end > 0) {
          await run('ffmpeg', ['-v', 'error', '-y', '-i', audio, '-t', (end + 0.5).toFixed(2), '-vn', '-c:a', 'aac', '-b:a', '96k', clipPath(walk)]).catch(() => {});
          if (fs.existsSync(clipPath(walk))) { writeClipInfo(walk, { chapter: ch.n, dur: (await probe(clipPath(walk))).dur, called }); step(`kept the roll call (${Object.values(called).join(', ')}) for later chapters`); }
        }
      }
      return;
    }
    // A later chapter: the roll call from chapter 1 goes in front, so the voices introduce themselves to the
    // transcriber again; its cues are cut back out afterwards and the times moved back.
    step('putting the roll call in front of the audio');
    const withClip = path.join(dir, 'audio-rollcall.m4a');
    const fmt = 'aresample=48000,aformat=channel_layouts=mono';
    await run('ffmpeg', ['-v', 'error', '-y', '-i', clipPath(walk), '-i', audio, '-filter_complex', `[0:a]${fmt}[a0];[1:a]${fmt}[a1];[a0][a1]concat=n=2:v=0:a=1[a]`, '-map', '[a]', '-c:a', 'aac', '-b:a', '96k', withClip]);
    const clipDur = (await probe(clipPath(walk))).dur;
    await transcribe(withClip, cfg, opts);
    const full = fs.readFileSync(srt, 'utf8');
    saveCalled(dir, callSpan(full, people).called);
    fs.writeFileSync(srt, stripPrefix(full, clipDur));
    fs.rmSync(withClip, { force: true });
  })();
  const [s1, s2] = await Promise.allSettled([shots, transcript]);
  if (s1.status === 'rejected') step(`screenshots failed: ${s1.reason.message}`);
  const transcriptError = s2.status === 'rejected' ? s2.reason : null;
  if (transcriptError) step(`transcript failed: ${transcriptError.message}`);
  if (transcriptOnly) return {
    transcript: fs.existsSync(path.join(dir, 'transcript.srt')),
    ...(transcriptError ? { transcriptError: transcriptError.message } : {}),
  };

  // 3. Timelines.
  const srtFile = path.join(dir, 'transcript.srt');
  // Speakers: names given now, else the confirmed map, else the names given when recording.
  let who = speakers ? list(speakers) : ch.speakerMap || list(ch.speakers ?? cfg.speakers);
  // Transcribed per track: the mic's first voice is you, whatever the order of first speech.
  const split = fs.existsSync(srtFile) ? readSplit(dir) : null;
  if (split?.split && Array.isArray(who) && !speakers) who = splitNames(fs.readFileSync(srtFile, 'utf8'), who, split, ch.sources);
  // The roll call carried over from chapter 1 (heard in the clip put in front of this chapter's audio).
  const carried = fs.existsSync(srtFile) && !speakers && !ch.speakerMap && Array.isArray(who) && !split?.split ? readCalled(dir) : null;
  if (carried) who = guessVoices(fs.readFileSync(srtFile, 'utf8'), who, null, ch.sources, carried);
  // A Meet call with the ux-walk extension: its captions say who each voice is. A confirmed map (speakerMap) still wins.
  let byMeet = false;
  const sourceQualified = Array.isArray(speakers) && speakers.length === 0;
  const meetEvents = fs.existsSync(srtFile) && (!speakers || sourceQualified) && !ch.speakerMap ? readMeet(path.dirname(dir), ch.startMs, endMs) : [];
  if (meetEvents.length) {
    const srtText = fs.readFileSync(srtFile, 'utf8');
    const names = list(ch.speakers ?? cfg.speakers);
    const fromMeet = namesFromMeet(parseSrt(srtText, [], {}), captionSpans(meetEvents, ch.startMs), names[0] || cfg.me);
    if (Object.keys(fromMeet).length) {
      who = { ...(sourceQualified ? {} : Array.isArray(who) ? guessVoices(srtText, names, split, ch.sources) : who), ...fromMeet };
      byMeet = true;
      step(`named ${Object.keys(fromMeet).length} voice(s) from Meet captions: ${Object.entries(fromMeet).map(([k, v]) => `${k} = ${v}`).join(', ')}`);
    }
  }
  const cues = fs.existsSync(srtFile) ? parseSrt(fs.readFileSync(srtFile, 'utf8'), glossaryRules(readGlossaries(files)), who) : [];
  // After the glossary: names the screen spells right and the transcript does not.
  if (cues.length && cfg.screenNames !== false && cfg.screenNames !== 'false') {
    const fix = nameFixer(names);
    for (const c of cues) c.text = fix(c.text);
    if (fix.log.size) {
      const list = [...fix.log].map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`);
      fs.appendFileSync(path.join(dir, 'process.log'), `[${new Date().toISOString()}] [${ch.name}] names from the screen (${names.length} on screen): ${list.join(', ')}\n`);
      step(`fixed ${[...fix.log.values()].reduce((a, b) => a + b, 0)} names from the screen (${fix.log.size} kinds; see process.log)`);
    }
  }
  // With a call track, the audio says who is on the call; it beats voice guessing.
  const people = Array.isArray(who) ? who : list(ch.speakers ?? cfg.speakers);
  const byCall = !split?.split && audioTracks > 1 && cues.length ? nameByCall(cues, callDb, people) : false;
  let appOrigin = /^https?:\/\//.test(ch.url || '') ? ch.url : null;
  if (!appOrigin) { const nav = actions.find((e) => e.ev === 'nav' && /^https?:/.test(e.url)); appOrigin = nav && new URL(nav.url).origin; }
  const rows = buildTimeline({ actions, startMs: ch.startMs, cues, shots: listShots(dir), appOrigin, ignoreWrites: cfg.ignoreWrites, ignoreConsole: cfg.ignoreConsole, chapterDir: dir,
    readRpcs: cfg.readRpcs, writeRpcs: cfg.writeRpcs, findSource: sourceIndex(cfg.sourceRoot, cfg.sourceGlobs, cfg.sourceRef), genericTestids: cfg.genericTestids });
  const version = toolVersion();
  const env = actions.find((e) => e.ev === 'env');
  const replays = [...(env ? [{ tool: 'Environment', link: `${env.ua}, window ${env.viewport} at ${env.dpr}x, ${env.lang}, ${env.tz}` }] : []), ...new Map(actions.filter((e) => e.ev === 'replay').map((e) => [e.tool, e])).values()];
  const title = `${ch.topic ? ch.topic + ' / ' : ''}${ch.n ? `chapter ${ch.n}: ` : ''}${ch.name}`;
  // Sections: from the screen always; from the conversation too on a long chapter (needs the claude CLI).
  const screen = screenSections(rows, dur);
  let sections = screen;
  if (cfg.sections === false || cfg.sections === 'false') sections = [];
  else if (cfg.sections === 'cached') {
    try { sections = JSON.parse(fs.readFileSync(path.join(dir, 'sections.json'), 'utf8')).sections; } catch {}
  }
  else if (cfg.sections !== 'screen' && dur >= (Number(cfg.sectionsMinS) || 360) && cues.length) {
    if (force.includes('sections.json')) fs.rmSync(path.join(dir, 'sections.json'), { force: true });
    const plain = renderTimeline(rows, { title, startMs: ch.startMs, short: true, replays });
    try { sections = await topicSections(dir, plain.text, screen, cfg, dur); } catch (e) { step(`sections from the screen only (${e.message.slice(0, 120)})`); }
  }
  const full = renderTimeline(rows, { title, startMs: ch.startMs, replays, sections, version });
  const short = renderTimeline(rows, { title, startMs: ch.startMs, short: true, replays, sections, version });
  fs.writeFileSync(path.join(dir, 'timeline.md'), full.text);
  fs.writeFileSync(path.join(dir, 'timeline-short.md'), short.text);
  const summary = {
    name: ch.name, n: ch.n, durationS: Math.round(dur), counts: full.counts,
    timelineLines: full.lines, shortLines: short.lines, shots: listShots(dir).length,
    transcript: fs.existsSync(srtFile), ...(transcriptError ? { transcriptError: transcriptError.message } : {}), processedS: Math.round((Date.now() - t0) / 1000),
    sections: sections.map((x) => ({ at: x.t, title: x.title })),
    voices: byMeet ? 'meet' : split?.split ? 'tracks' : byCall ? 'call' : 'diarization',
    ...(byMeet ? { speakerIdentity: 'Inferred from Meet caption overlap; names are unconfirmed and source/chunk labels remain separate' } : {}),
    toolVersion: version,
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeIndex(path.dirname(dir));

  const c = full.counts;
  const line = `${path.join(dir, 'timeline-short.md')}: ${short.lines} lines (full ${full.lines}); ` +
    `SAY ${c.SAY || 0}, NAV ${c.NAV || 0}, WRITE ${c.WRITE || 0}, RISK ${c.RISK || 0}, ERROR ${c.ERROR || 0}, shots ${summary.shots}`;
  if (!quiet) console.log(line); else step(line);
  // No transcript is not a failed chapter: the timeline is there without speech. The caller says so
  // (exit code 3 from "ux-walk process") and a rerun after setup adds the speech.
  if (transcriptError) return summary;
  // A chapter of a few seconds (a stray pause or next) is not worth a Claude brief.
  if ((brief ?? cfg.brief) && dur < 20) step('no brief: under 20 s');
  else if (brief ?? cfg.brief) {
    step('writing brief (Claude)');
    try { step(`brief: ${await runBrief(dir, cfg)}`); } catch (e) { step(`brief failed: ${e.message}`); }
  }
  return summary;
}

// index.md for a session folder: one row per chapter.
export function writeIndex(sessionDir) {
  const sj = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(sj)) return;
  const s = JSON.parse(fs.readFileSync(sj, 'utf8'));
  const rows = s.chapters.map((c) => {
    let sum = {};
    try { sum = JSON.parse(fs.readFileSync(path.join(sessionDir, c.dir, 'summary.json'), 'utf8')); } catch {}
    const d = sum.durationS != null ? `${Math.floor(sum.durationS / 60)}m${String(sum.durationS % 60).padStart(2, '0')}s` : '';
    const k = sum.counts || {};
    const status = sum.counts ? (sum.transcriptError ? 'no transcript' : 'ready') : c.status;
    return `| ${c.n} | ${c.name} | ${d} | ${status} | ${k.SAY || 0} / ${k.NAV || 0} / ${k.WRITE || 0} / ${k.RISK || 0} / ${k.ERROR || 0} | ${sum.counts ? `[short](${c.dir}/timeline-short.md) · [full](${c.dir}/timeline.md)` : ''} |`;
  });
  // Sections per chapter, so an agent can pick the part it needs before opening a timeline.
  const secs = s.chapters.flatMap((c) => {
    let sum = {};
    try { sum = JSON.parse(fs.readFileSync(path.join(sessionDir, c.dir, 'summary.json'), 'utf8')); } catch {}
    const l = sum.sections || [];
    return l.length > 1 ? [`- ${c.n} ${c.name}: ${l.map((x) => `${String(Math.floor(x.at / 60)).padStart(2, '0')}:${String(Math.floor(x.at % 60)).padStart(2, '0')} ${x.title}`).join(' · ')}`] : [];
  });
  const text = [`# ${s.topic || 'walkthrough'}`, '', `Started ${new Date(s.startedAt).toLocaleString()}.${s.url ? ` URL ${s.url}` : ''}${s.source ? ` Imported from ${s.source.file} (no click log).` : ''}`, '',
    `For agents: \`/ux-walk ${sessionDir}${s.ask ? ` ${s.ask}` : ''}\``, '',
    '| # | Chapter | Length | Status | SAY / NAV / WRITE / RISK / ERROR | Timeline |', '|---|---|---|---|---|---|', ...rows, '',
    ...(secs.length ? ['Sections (also `## mm:ss` headers in each timeline):', '', ...secs, ''] : [])].join('\n');
  const tmp = path.join(sessionDir, `.index.${process.pid}.md`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(sessionDir, 'index.md'));
}
