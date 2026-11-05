// "ux-walk import": a video made outside ux-walk (an iPhone screen recording with the mic on, a QuickTime
// recording) or a voice memo becomes a normal one-chapter recording: the same folder layout, session.json and
// chapter.json the recorder writes, then the same processing (audio, shots, transcript, timeline) and brief.
// There is no click log, so the timeline is speech and screenshots only.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveGlossaries } from './glossary.mjs';
import { chapterName, sessionName } from './naming.mjs';
import { CapClient, capManifest, checkCapProject, copyCapProject } from './cap.mjs';
import { writeReport } from './report.mjs';

const run = promisify(execFile);

export const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;
export const AUDIO_EXT = /\.(m4a|mp3|wav|aac)$/i;
const SANE = Date.UTC(2000, 0, 1); // container dates before this are a blank field (1904, 1970)

// --start: epoch ms, epoch seconds, or anything Date.parse reads (ISO; no zone = local time).
export function parseStart(v) {
  const s = String(v ?? '').trim();
  if (/^\d{12,14}$/.test(s)) return Number(s);
  if (/^\d{9,11}$/.test(s)) return Number(s) * 1000;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`--start: not a time: "${v}" (use an ISO time like 2026-10-22T10:57 or epoch ms)`);
  return ms;
}

// An iPhone screen recording (ReplayKit) is named RPReplay_Final<epoch seconds>: the moment it was saved, so its end.
export function replayEndMs(name) {
  const m = /RPReplay_Final(\d{9,11})/i.exec(path.basename(String(name || '')));
  return m ? Number(m[1]) * 1000 : null;
}

const when = (v) => { const ms = Date.parse(String(v || '')); return Number.isFinite(ms) && ms > SANE ? ms : null; };

// When the recording started, and where that came from. In order: --start; the Photos creation date a file
// AirDropped or exported from Photos carries (the start); an iPhone screen recording's end (its name, or its
// creation_time, which ReplayKit sets when it saves) minus its length; the QuickTime creationdate tag (the start,
// on camera and QuickTime recordings); the container's creation_time; the file's modified time minus its length.
export function resolveStart({ start, photosMs, name, replayKit, creationTime, quicktimeDate, mtimeMs, durationS = 0 }) {
  const len = Math.round((Number(durationS) || 0) * 1000);
  if (start != null && start !== '') return { ms: parseStart(start), from: '--start' };
  if (Number.isFinite(photosMs) && photosMs > SANE) return { ms: photosMs, from: 'Photos creation date' };
  const replayEnd = replayEndMs(name) ?? (replayKit ? when(creationTime) : null);
  if (replayEnd) return { ms: replayEnd - len, from: 'iPhone screen recording end minus its length' };
  if (when(quicktimeDate)) return { ms: when(quicktimeDate), from: 'QuickTime creationdate' };
  if (when(creationTime)) return { ms: when(creationTime), from: 'creation_time' };
  if (Number.isFinite(mtimeMs)) return { ms: mtimeMs - len, from: 'file modified time minus its length' };
  throw new Error('no start time: pass --start <iso|epoch-ms>');
}

// The device, for the brief: a ReplayKit file is an iPhone; any other portrait video is most likely a phone.
export function deviceOf({ name, replayKit, width, height, audioOnly }) {
  if (audioOnly) return null;
  if (replayKit || replayEndMs(name)) return 'iPhone';
  return height > width ? 'phone' : null;
}

// session.json and chapter.json in the recorder's shapes (src/record.mjs), plus kind "import" (or "diatribe": a
// ramble that becomes notes and action items) and the source.
// brief: true/false when --brief/--no-brief was given (the recording's own switch); absent otherwise.
export function importRecords({ outDir, topic, ask, startMs, durationS, speakers, glossaries, source, kind = 'import', project = null, brief }) {
  const dir = path.join(outDir, sessionName(topic, new Date(startMs)));
  const name = kind === 'diatribe' ? 'diatribe' : source.audioOnly ? 'voice memo' : 'screen recording';
  const cdir = chapterName(1, name);
  const endMs = startMs + Math.round(durationS * 1000);
  const session = { topic, url: null, kind, source, dir, startedAt: new Date(startMs).toISOString(), speakers, glossaries, project, ...(typeof brief === 'boolean' ? { brief } : {}),
    chapters: [{ n: 1, name, dir: cdir, startMs, endMs, status: 'processing' }], ...(ask && ask.trim() ? { ask: ask.trim() } : {}) };
  const chapter = { n: 1, name, topic, url: null, kind, source, startMs, endMs, speakers, glossaries, project, ...(typeof brief === 'boolean' ? { brief } : {}),
    ...(source.audioOnly ? { video: 'audio.m4a' } : {}) };
  return { dir, chapterDir: path.join(dir, cdir), session, chapter };
}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:format_tags:stream=codec_type,codec_name,width,height', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && s.width);
  const a = streams.find((s) => s.codec_type === 'audio');
  const tags = j.format?.tags || {};
  return { durationS: Number(j.format?.duration) || 0, formatName: j.format?.format_name || '', video: v || null, audio: a || null,
    creationTime: tags.creation_time || null, quicktimeDate: tags['com.apple.quicktime.creationdate'] || null };
}

// The Photos library's facts on a file AirDropped or exported from Photos (extended attributes): its creation
// date (a binary plist holding one date: the start of the recording) and the app that made it.
export const plistDate = (printed) => {
  // plutil -p prints a date as "2026-10-22 17:57:19 +0000".
  const m = /(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/.exec(String(printed || ''));
  const ms = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
function photosFacts(file) {
  const attr = (name) => { try { return execFileSync('xattr', ['-px', name, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\s+/g, ''); } catch { return null; } };
  let photosMs = null;
  const hex = attr('com.apple.assetsd.customCreationDate');
  if (hex) { try { photosMs = plistDate(execFileSync('plutil', ['-p', '-'], { input: Buffer.from(hex, 'hex'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })); } catch {} }
  const creator = attr('com.apple.assetsd.creatorBundleID');
  return { photosMs, replayKit: !!creator && Buffer.from(creator, 'hex').toString('latin1').includes('com.apple.replayd') };
}

// A clone on APFS (instant, no extra space); a plain copy elsewhere.
function cloneOrCopy(src, dst) {
  try { execFileSync('cp', ['-c', src, dst], { stdio: 'ignore' }); return 'cloned'; } catch {}
  fs.copyFileSync(src, dst);
  return 'copied';
}
// Can ffmpeg decode a frame of it (the shots step needs that)?
async function decodes(file) {
  try { await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-']); return true; } catch { return false; }
}

// The video (or voice memo) into the chapter folder, as cheaply as works: a clone, else a remux, else a re-encode.
export async function placeMedia(src, chapterDir, info, log = () => {}) {
  if (!info.video) {
    const dst = path.join(chapterDir, 'audio.m4a');
    if (/mp4|mov|m4a/.test(info.formatName) && /^(aac|alac)$/.test(info.audio?.codec_name || '')) return `${cloneOrCopy(src, dst)} the audio`;
    log('converting the audio to AAC');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '96k', dst]);
    return 'converted the audio to AAC';
  }
  const dst = path.join(chapterDir, 'video.mp4');
  if (await decodes(src)) return `${cloneOrCopy(src, dst)} the video`;
  log('ffmpeg cannot read it as it is; remuxing to MP4');
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', dst]);
    if (await decodes(dst)) return 'remuxed the video to MP4';
  } catch {}
  log('remux did not help; re-encoding (H.264)');
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', dst]);
  return 're-encoded the video (H.264)';
}

const saveJson = (f, o) => { const tmp = `${f}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, f); };

// Returns { dir, chapterDir, session, summary, brief } once processed.
export async function importRecording(file, cfg, { topic, ask, start, brief, glossary, kind = 'import', log = console.log } = {}) {
  if (file.endsWith('.cap')) return importCapRecording(file, cfg, { topic, ask, start, brief, glossary, kind, log });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`no such file: ${file}`);
  if (!VIDEO_EXT.test(file) && !AUDIO_EXT.test(file)) throw new Error(`not a video or voice memo: ${path.basename(file)} (.mp4, .mov, .m4v, .m4a, .mp3, .wav, .aac)`);
  const info = await probe(file).catch((e) => { throw new Error(`ffprobe cannot read ${path.basename(file)}: ${e.message.split('\n')[0]}`); });
  if (!info.video && !info.audio) throw new Error(`${path.basename(file)} has no video or audio`);
  const audioOnly = !info.video;
  const { photosMs, replayKit } = photosFacts(file);
  const startAt = resolveStart({ start, photosMs, name: file, replayKit, creationTime: info.creationTime, quicktimeDate: info.quicktimeDate, mtimeMs: fs.statSync(file).mtimeMs, durationS: info.durationS });
  const source = { file: path.basename(file), path: file, startFrom: startAt.from, audioOnly,
    device: deviceOf({ name: file, replayKit, width: info.video?.width, height: info.video?.height, audioOnly }),
    ...(info.video ? { width: info.video.width, height: info.video.height, codec: info.video.codec_name } : {}), durationS: Math.round(info.durationS * 10) / 10 };
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const speakers = list(cfg.speakers).length ? list(cfg.speakers) : [cfg.me].filter(Boolean);
  const glossaries = resolveGlossaries([cfg.glossary, glossary].filter(Boolean).join(','));
  const words = (topic || '').trim() || (kind === 'diatribe' ? 'diatribe' : audioOnly ? 'voice memo' : 'screen recording');
  const r = importRecords({ outDir: cfg.outDir, topic: words, ask, startMs: startAt.ms, durationS: info.durationS, speakers, glossaries, source, kind, project: cfg.project || null, brief });
  if (fs.existsSync(r.dir)) throw new Error(`already there: ${r.dir} (rerun its processing with: ux-walk process ${r.dir})`);
  log(`Start ${new Date(startAt.ms).toLocaleString()} (from the ${startAt.from}); ${Math.round(info.durationS)} s${source.device ? ` from ${source.device === 'iPhone' ? 'an iPhone' : 'a phone'}` : ''}${audioOnly ? ', audio only' : ` ${info.video.width}x${info.video.height} ${info.video.codec_name}`}`);
  fs.mkdirSync(r.chapterDir, { recursive: true });
  try {
    log(`${await placeMedia(file, r.chapterDir, info, log)} into ${r.chapterDir}`);
  } catch (e) { fs.rmSync(r.dir, { recursive: true, force: true }); throw e; }
  saveJson(path.join(r.dir, 'session.json'), r.session);
  saveJson(path.join(r.chapterDir, 'chapter.json'), r.chapter);
  return finishImport(r, cfg, { brief, log });
}

export async function importCapRecording(file, cfg, { topic, ask, start, brief, glossary, kind = 'import', log = console.log, client = new CapClient() } = {}) {
  checkCapProject(file);
  const inspection = await client.inspect(file);
  if (path.resolve(cfg.outDir) === path.resolve(file) || path.resolve(cfg.outDir).startsWith(path.resolve(file) + path.sep)) throw new Error('Import output must be outside the source Cap project');
  fs.mkdirSync(cfg.outDir, { recursive: true });
  // The released CLI may omit durationSeconds. Export a copied project first: the actual MP4 is
  // authoritative, including any edits, and the original project is never rendered into or changed.
  const stage = fs.mkdtempSync(path.join(cfg.outDir, '.cap-import-'));
  const project = path.join(stage, 'source.cap'), output = path.join(stage, 'video.mp4');
  let r;
  try {
    log('Copying the native Cap project; the original remains unchanged');
    copyCapProject(file, project);
    const info = await client.export(project, output);
    if (!(info.durationS > 0)) throw new Error('Cap export has no positive duration');
    const startAt = resolveStart({ start, mtimeMs: fs.statSync(path.join(file, 'recording-meta.json')).mtimeMs, durationS: info.durationS });
    const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const source = { backend: 'cap', file: path.basename(file), path: file, project: 'source.cap', audioOnly: false, startFrom: startAt.from,
      timing: 'imported project; wall-clock alignment unknown unless --start is supplied; edited export time is not source time' };
    r = importRecords({ outDir: cfg.outDir, topic: topic?.trim() || inspection.name || 'Cap recording', ask, startMs: startAt.ms, durationS: info.durationS,
      speakers: list(cfg.speakers).length ? list(cfg.speakers) : [cfg.me].filter(Boolean), glossaries: resolveGlossaries([cfg.glossary, glossary].filter(Boolean).join(',')), source, kind, project: cfg.project || null, brief });
    await capManifest(project, output, info, { source: startAt.from, exactFirstFrame: false, imported: true });
    fs.mkdirSync(r.dir); // atomic reservation: never overwrite an existing import
    fs.renameSync(stage, r.chapterDir);
    Object.assign(r.chapter, { sourceProject: 'source.cap', media: 'media.json' });
    saveJson(path.join(r.dir, 'session.json'), r.session);
    saveJson(path.join(r.chapterDir, 'chapter.json'), r.chapter);
  } catch (e) {
    throw new Error(`${e.message}; import files retained for recovery at ${fs.existsSync(stage) ? stage : r?.dir}`);
  }
  return finishImport(r, cfg, { brief, log });
}

async function finishImport(r, cfg, { brief, log }) {
  if (cfg.evidenceOnly) {
    r.session.chapters[0].status = 'evidence';
    r.session.coverage = { window: 'imported video; no live UI verification', dom: 'not captured', network: 'not captured', console: 'not captured' };
    saveJson(path.join(r.dir, 'session.json'), r.session);
    writeReport(r.dir);
    return { dir: r.dir, chapterDir: r.chapterDir, session: r.session, summary: null, brief: null };
  }
  const { processChapter, writeIndex } = await import('./process.mjs');
  const row = r.session.chapters[0];
  let summary = null;
  try {
    // An import is briefed unless the caller said no.
    summary = await processChapter(r.chapterDir, cfg, { brief: brief ?? true, log });
    row.status = summary?.transcriptError ? 'no transcript' : 'ready';
  } catch (e) { row.status = 'failed'; saveJson(path.join(r.dir, 'session.json'), r.session); throw e; }
  saveJson(path.join(r.dir, 'session.json'), r.session);
  writeIndex(r.dir);
  const briefFile = path.join(r.chapterDir, 'brief.md');
  return { dir: r.dir, chapterDir: r.chapterDir, session: r.session, summary, brief: fs.existsSync(briefFile) ? briefFile : null };
}
