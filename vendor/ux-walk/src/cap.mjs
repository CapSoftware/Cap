// Cap owns media capture/editing. ux-walk owns chapters, observations and evidence.
// Call the installed, version-matched CLI; do not vendor Cap's recorder or upload implicitly.
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const exec = promisify(execFile);
// Measured without progress, not in total: a 37 minute 60fps walk took 9 minutes, so a total
// limit of 15 minutes would kill a walk of about an hour however healthy its export was.
const EXPORT_STALL_MS = 15 * 60 * 1000;
const EXPORT_STALL_TICKS = 12;
const EXPORT_KILL_GRACE_MS = 5000;
const MAX_EVENT_LINE_CHARS = 1024 * 1024;
const MAX_ERROR_CHARS = 800;
export function capBinary(explicit = process.env.UXW_CAP_BINARY) {
  if (explicit) return explicit;
  return ['/Applications/Cap.app', path.join(os.homedir(), 'Applications/Cap.app')]
    .map((p) => path.join(p, 'Contents/MacOS/cap-cli')).find((p) => fs.existsSync(p)) || 'cap';
}

const capFailure = (e) => e?.error || e?.type === 'Error' || e?.type === 'error' ? `Cap: ${e.error || 'operation failed'}` : null;

export function parseCapJson(stdout) {
  const text = String(stdout).trim();
  if (!text) throw new Error('Cap returned no JSON');
  let result;
  try { result = [JSON.parse(text)]; }
  catch { result = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  for (const e of result) if (capFailure(e)) throw new Error(capFailure(e));
  return result;
}

export class CapClient {
  constructor({ binary, run = exec, start = spawn, exportStallMs = EXPORT_STALL_MS } = {}) { Object.assign(this, { binary: capBinary(binary), run, start, exportStallMs }); }
  async events(args, timeout = 30000) {
    let result;
    try { result = await this.run(this.binary, [...args, '--json'], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }); }
    catch (e) {
      if (e.stdout) { try { parseCapJson(e.stdout); } catch (detail) { throw detail; } }
      throw new Error(`Cap ${args.slice(0, 2).join(' ')} failed: ${e.code === 'ENOENT' ? 'install Cap Desktop from https://cap.so/download first' : e.killed ? 'timed out' : (e.stderr || e.message).trim().slice(0, 800)}`);
    }
    return parseCapJson(result.stdout);
  }
  async json(args, timeout) { return (await this.events(args, timeout)).at(-1); }
  // Export writes one Progress line per frame, so buffering its stdout fails on long recordings.
  // Keep only the verdict and read each line as it arrives. Resolves with the Completed event.
  exportEvents(args) {
    const label = `Cap ${args.slice(0, 2).join(' ')}`;
    return new Promise((resolve, reject) => {
      let child, partial = '', skipping = false, unreadable = 0, stderr = '', completed = null, failure = null;
      let rendered = -1, total = null, idleTicks = 0, stalled = false, escalation = null, watchdog = null;
      const finish = (settle, value) => { clearInterval(watchdog); clearTimeout(escalation); settle(value); };
      const consume = (line) => {
        if (!line.trim()) return;
        let e;
        try { e = JSON.parse(line); } catch { unreadable += 1; return; }
        if (e?.type === 'Progress') {
          const count = Number(e.rendered_count);
          if (count <= rendered) return; // A repeated count is not progress.
          if (Number.isFinite(count)) rendered = count;
          if (Number.isFinite(Number(e.total_frames))) total = Number(e.total_frames);
          idleTicks = 0;
          return;
        }
        idleTicks = 0;
        failure ??= capFailure(e);
        if (e?.type === 'Completed') completed = e;
      };
      try { child = this.start(this.binary, [...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { reject(new Error(`${label} failed: ${e.message}`)); return; }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        let start = 0;
        for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
          if (!skipping) consume(partial + chunk.slice(start, end));
          partial = ''; skipping = false; start = end + 1;
        }
        if (skipping) return;
        partial += chunk.slice(start);
        if (partial.length > MAX_EVENT_LINE_CHARS) { partial = ''; skipping = true; unreadable += 1; }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-MAX_ERROR_CHARS); });
      // Ticks, not a deadline: a Mac asleep mid-export has made no progress to measure.
      watchdog = setInterval(() => {
        if (++idleTicks < EXPORT_STALL_TICKS) return;
        clearInterval(watchdog); stalled = true; child.kill('SIGTERM');
        escalation = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }, Math.min(EXPORT_KILL_GRACE_MS, this.exportStallMs));
      }, this.exportStallMs / EXPORT_STALL_TICKS);
      child.on('error', (e) => finish(reject, new Error(`${label} failed: ${e.code === 'ENOENT' ? 'install Cap Desktop from https://cap.so/download first' : e.message}`)));
      child.on('close', (code, signal) => {
        // Only a clean exit can have written a whole last line; anything else may be cut off.
        if (partial && !skipping && code === 0) consume(partial);
        const at = rendered < 0 ? 'before the first frame' : `at frame ${rendered}${total == null ? '' : ` of ${total}`}`;
        const unread = unreadable ? ` ${unreadable} output line${unreadable === 1 ? ' was' : 's were'} unreadable.` : '';
        if (failure) finish(reject, new Error(failure));
        else if (stalled) finish(reject, new Error(`${label} failed: timed out after ${Math.round(this.exportStallMs / 60000)} minutes without progress ${at}`));
        else if (code !== 0) finish(reject, new Error(`${label} failed: ${stderr.trim() || `exited with ${signal || `code ${code}`}`} (${at}).${unread}`));
        else finish(resolve, completed);
      });
    });
  }
  async localOnly() {
    const store = await this.json(['automations', 'list']);
    if (!Array.isArray(store.rules)) throw new Error('Cap automation schema is unsupported; local-only capture cannot be verified');
    if (store.rules.some((r) => r.enabled !== false)) throw new Error('Disable enabled Cap automations before recording with ux-walk (they can upload, run commands or delete recordings). ux-walk has not changed them.');
  }
  async ready() {
    const doctor = await this.json(['doctor']);
    if (doctor.schemaVersion !== 2) throw new Error(`Unsupported Cap CLI schema ${doctor.schemaVersion}; expected 2`);
    if (!doctor.captureReady) throw new Error('Cap is not ready to capture; run ux-walk cap doctor and check Screen Recording permission');
    await this.localOnly();
    return doctor;
  }
  async inspect(project) {
    const validation = await this.json(['project', 'validate', project]);
    if (!validation.valid) throw new Error(`Cap project is incomplete or invalid: ${JSON.stringify(validation.problems || validation.missing || [])}`);
    return this.json(['project', 'inspect', project]);
  }
  async export(project, output) {
    if (fs.existsSync(output)) throw new Error(`Refusing to replace an existing export: ${output}`);
    const completed = await this.exportEvents(['export', project, '--output', output, '--format', 'mp4', '--quality', 'web']);
    if (!completed || path.resolve(completed.path || '') !== path.resolve(output) || !fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('Cap export did not produce the requested MP4');
    const { stdout } = await this.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output], { encoding: 'utf8', timeout: 30000 });
    const probe = JSON.parse(stdout), durationS = Number(probe.format?.duration);
    if (!(durationS > 0) || !probe.streams?.some((s) => s.codec_type === 'video')) throw new Error('Cap export has no playable video');
    await this.run('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 });
    return { durationS };
  }
}

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`Cap source contains a symlink: ${e.name}`);
    if (e.isDirectory()) return filesIn(file);
    if (!e.isFile()) throw new Error(`Unsupported Cap source entry: ${e.name}`);
    return [file];
  });
}
export function checkCapProject(project) {
  if (!project.endsWith('.cap') || !fs.statSync(project).isDirectory() || fs.lstatSync(project).isSymbolicLink()) throw new Error('Expected a .cap project directory');
  const files = filesIn(project);
  const meta = JSON.parse(fs.readFileSync(path.join(project, 'recording-meta.json'), 'utf8'));
  if (meta.status?.status && meta.status.status !== 'Complete') throw new Error(`Cap project is ${meta.status.status}; finish or recover it in Cap before importing/editing`);
  const relative = (value) => {
    if (typeof value !== 'string' || path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) throw new Error('Cap media must use relative paths inside its project');
  };
  const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (['path', 'image_path', 'imagePath', 'cursor', 'keyboard'].includes(k) && typeof v === 'string') relative(v); else walk(v); } };
  walk(meta);
  return { files, meta };
}

export function copyCapProject(source, destination) {
  checkCapProject(source);
  if (fs.existsSync(destination)) throw new Error(`Cap destination already exists: ${destination}`);
  if (path.resolve(destination).startsWith(path.resolve(source) + path.sep)) throw new Error('Cap copy must be outside its source project');
  try { execFileSync('cp', ['-cR', source, destination], { stdio: 'ignore' }); }
  catch { fs.rmSync(destination, { recursive: true, force: true }); fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false }); }
}

export function prepareCapEdit(project) {
  checkCapProject(project);
  const edits = path.join(path.dirname(project), 'edits'); fs.mkdirSync(edits, { recursive: true });
  const draft = path.join(edits, `${randomUUID()}.cap`);
  copyCapProject(project, draft);
  return draft;
}

// Source media stays in a native .cap project, including its camera/audio offsets and cursor files.
// This manifest describes the derivative; it never claims the export's clock is a first-frame clock.
export async function capManifest(project, output, info, timing = null) {
  const { files, meta } = checkCapProject(project);
  const assets = [];
  for (const file of files) {
    const hash = createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    assets.push({ path: path.relative(path.dirname(output), file), bytes: fs.statSync(file).size, sha256: hash.digest('hex') });
  }
  const manifest = { schemaVersion: 1, backend: 'cap', project: path.relative(path.dirname(output), project),
    derivative: { path: path.basename(output), durationS: info.durationS }, timing,
    nativeMetadata: meta, assets, sharing: 'local; no upload requested' };
  fs.writeFileSync(path.join(path.dirname(output), 'media.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export class CapCapture {
  constructor({ windowId, screenId, camera, mic, systemAudio = false, fps = 30, attachId, client = new CapClient(), onEvent = () => {} }) {
    if ((windowId == null) === (screenId == null)) throw new Error('Cap needs exactly one --window-id or --screen-id from ux-walk cap targets');
    // Cap 0.6.1 window video captured overlapping applications in the live oracle. Its still
    // screenshot is isolated, so a successful PNG cannot establish video isolation. Keep the
    // proven native WindowCapture path until Cap's video path passes that oracle.
    if (windowId != null) throw new Error('Cap window video is not isolated in the tested release. Use --capture window for a window, or explicitly select a Cap --screen-id for whole-screen capture.');
    if (attachId && (camera || mic || systemAudio)) throw new Error('Attaching does not change Cap devices; omit camera, mic and system-audio options');
    Object.assign(this, { windowId, screenId, camera, mic, systemAudio, fps, attachId, client, onEvent });
    this.ownsRecording = !attachId;
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }
  async start(file) {
    await this.client.ready();
    const targets = await this.client.json(['targets']);
    const list = this.windowId != null ? targets.windows : targets.screens;
    const id = String(this.windowId ?? this.screenId);
    const target = list?.find((t) => String(t.id) === id);
    if (!target) throw new Error(`Cap target ${id} is unavailable; select it again (no fallback)`);
    if (this.camera && !targets.cameras?.some((c) => c.deviceId === this.camera)) throw new Error('Cap camera is unavailable');
    if (this.mic && !targets.mics?.some((m) => m.name === this.mic)) throw new Error('Cap microphone needs its exact name from ux-walk cap targets');
    this.file = file; this.project = path.join(path.dirname(file), 'source.cap');
    if (this.attachId) {
      const rows = await this.client.json(['record', 'status']);
      const row = rows.find((r) => r.recordingId === this.attachId);
      if (!row || row.status !== 'recording' || !row.alive) throw new Error('Cap session is not recording; use ux-walk cap sessions to select a live CLI session');
      if (!Number.isFinite(row.startedAt) || row.startedAt <= 0) throw new Error('Cap session has no usable start clock');
      this.project = path.resolve(row.path); this.recordingId = row.recordingId;
      this.mediaRecording = true;
      this.timing = { source: 'cap-detached-session-clock', exactFirstFrame: false, sourceEpochMs: row.startedAt * 1000, resolutionMs: 1000, attachedAt: Date.now() };
      this.onEvent({ ev: 'ready', backend: 'cap', title: target.name, timing: this.timing });
      this.stopping = false; this.monitor = setInterval(() => this.checkStatus(), 3000); this.monitor.unref();
      return { startMs: this.timing.attachedAt };
    }
    if (fs.existsSync(this.project)) throw new Error(`Cap project already exists: ${this.project}`);
    const requestedAt = Date.now();
    let started;
    try {
      started = (await this.client.events(['record', 'start', this.windowId != null ? '--window' : '--screen', id, '--mode', 'studio', '--path', this.project, '--fps', String(this.fps),
        ...(this.camera ? ['--camera', this.camera] : []), ...(this.mic ? ['--mic', this.mic] : []), ...(this.systemAudio ? ['--system-audio'] : []), '--detach'], 60000)).find((e) => e.type === 'started');
      if (!started?.recordingId || path.resolve(started.path || '') !== this.project) throw new Error('Cap did not acknowledge the requested project');
    } catch (e) {
      // A detached child can survive a timed-out parent. Stop only our explicit project, retain recovery files.
      try { await this.client.events(['record', 'stop', '--path', this.project], 45000); } catch (cleanup) { e.message += `; cleanup: ${cleanup.message}. Check Cap record status for ${this.project}`; }
      throw e;
    }
    this.recordingId = started.recordingId;
    this.mediaRecording = true;
    this.timing = { source: 'cap-start-acknowledgement', exactFirstFrame: false, requestedAt, acknowledgedAt: Date.now() };
    this.timing.sourceEpochMs = this.timing.acknowledgedAt;
    this.onEvent({ ev: 'ready', backend: 'cap', windowId: this.windowId, title: target.name, width: target.bounds?.width || target.physicalSize?.width, height: target.bounds?.height || target.physicalSize?.height, timing: this.timing });
    this.stopping = false;
    this.monitor = setInterval(() => this.checkStatus(), 3000); this.monitor.unref();
    return { startMs: this.timing.acknowledgedAt };
  }
  async checkStatus() {
    if (this.checking || this.stopping) return;
    this.checking = true;
    try {
      const rows = await this.client.json(['record', 'status']);
      if (this.stopping) return;
      const row = rows.find((r) => r.recordingId === this.recordingId);
      if (!this.ownsRecording && row?.status === 'stopped') {
        this.mediaRecording = false; clearInterval(this.monitor);
        this.onEvent({ ev: 'media-stopped' }); this.onEvent({ ev: 'warn', message: 'Cap recording ended; logging can finish independently.' }); return;
      }
      if (!row || row.status !== 'recording' || !row.alive) throw new Error(row?.error || 'Cap recording stopped unexpectedly');
    } catch (e) {
      if (!this.stopping) { clearInterval(this.monitor); this.onEvent({ ev: 'error', message: e.message }); this.resolveDone(1); }
    } finally { this.checking = false; }
  }
  async snapshot(file, { crop, timeoutMs = 10000 } = {}) {
    if (!this.recordingId || this.stopping) throw new Error('Cap capture is not running');
    if (fs.existsSync(file) || (crop && fs.existsSync(crop.path))) throw new Error('Checkpoint destination already exists');
    await this.client.localOnly();
    const captureStartedAt = Date.now();
    const image = await this.client.json(['screenshot', this.windowId != null ? '--window' : '--screen', String(this.windowId ?? this.screenId), '--path', file], Math.min(30000, Math.max(100, Number(timeoutMs) || 10000)));
    const capturedAt = Date.now();
    if (path.resolve(image.path || '') !== path.resolve(file)) throw new Error('Cap returned a different screenshot destination');
    const bytes = fs.readFileSync(file);
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Cap did not save a PNG checkpoint');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (crop) {
      if (!['x', 'y', 'width', 'height'].every((k) => Number.isInteger(crop[k])) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > width || crop.y + crop.height > height) throw new Error('Crop must fit inside the Cap screenshot in integer pixels');
      await this.client.run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, '-frames:v', '1', '-update', '1', '-n', crop.path], { encoding: 'utf8', timeout: 10000 });
    }
    return { captureStartedAt, capturedAt, width, height };
  }
  async finish() {
    if (!this.recordingId) return null;
    this.stopping = true; clearInterval(this.monitor);
    const endMs = Date.now();
    if (!this.ownsRecording) { this.recordingId = null; return { endMs, pending: true }; }
    const stopped = (await this.client.events(['record', 'stop', '--id', this.recordingId], 45000)).find((e) => e.type === 'stopped');
    if (!stopped?.recordingMetaExists) throw new Error(`Cap did not finalize ${this.project}; source files retained`);
    this.mediaRecording = false;
    this.recordingId = null;
    await this.client.inspect(this.project);
    const info = await this.client.export(this.project, this.file);
    await capManifest(this.project, this.file, info, this.timing);
    return { path: this.file, durationS: info.durationS, endMs, media: 'media.json', timing: this.timing, sourceProject: 'source.cap' };
  }
  failed(error) { this.onEvent({ ev: 'error', message: error.message }); this.resolveDone(1); throw error; }
  async rotate(file) { try { const finished = await this.finish(); return { finished, ...(await this.start(file)) }; } catch (e) { return this.failed(e); } }
  async pause() { try { return await this.finish(); } catch (e) { return this.failed(e); } }
  async resume(file) { try { return await this.start(file); } catch (e) { return this.failed(e); } }
  async stop() { try { return await this.finish(); } finally { this.resolveDone(0); } }
}
