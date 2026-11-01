// A recording session: browser + window capture + chapter commands typed while recording.
// Each finished chapter is processed in the background (audio, screenshots, transcript, timeline)
// while the next one records.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createEvidence } from './evidence.mjs';
import { safeUrl } from './network.mjs';
import { writeReport } from './report.mjs';
import { openBrowser } from './browser.mjs';
import { HELPER, ScreenCapture, WindowCapture, createCaptureHealth } from './capture.mjs';
import { CapSessionCapture } from './cap-session.mjs';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR, ROOT } from './config.mjs';
import { resolveGlossaries, listGlossaries } from './glossary.mjs';
import { askSpeakers } from './speakers.mjs';
import { createAsker } from './ask.mjs';
import { emit, readCommands, createIpcAsker } from './ipc.mjs';
import { transcriberProblem } from './transcribe.mjs';
import { isRisky, label, writeKind, writeLabel } from './timeline.mjs';
import { chapterName, handoffLine, pad, createSessionDir } from './naming.mjs';
import { assertCompanionAvailable, CompanionSession, durableCompanionJson, startCompanionServer } from './companion.mjs';

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
// At most three terminal lines per message.
const fit = (s) => { const w = ((process.stdout.columns || 120) - 2) * 3; return s.length > w ? s.slice(0, w - 1) + '…' : s; };

// Each end-of-walk question skips itself after this long with no key pressed.
const ENDING_TIMEOUT_S = Number(process.env.UXW_ASK_TIMEOUT_S) || 15;
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

export const HELP_KEYS = `  + <Name>   someone joined: add a speaker from now on
  n [name]   start the next chapter (the one just finished is processed in the background)
  m <note>   drop a marker into the timeline
  p          pause / resume (a pause ends the chapter; resume starts a new one)
  s          status
  q          stop and finish (Ctrl+C or closing the last browser tab does the same)
From any app (the terminal too): Option+Shift+N next chapter, Option+Shift+M marker, Option+Shift+P
pause/resume (Ctrl+Option+N / M / P also work). In the browser, hold Option+Shift: click pins a note, drag
draws a box (drag it to move, corners to resize). Without Option+Shift every click and key goes to the app.`;

// "+ Clay" / "+Clay" / "+ Clay, Brianne": names joining mid-walk. null when the line is not one.
export const joinNames = (line) => { const m = /^\+\s*(.+)$/.exec(line.trim()); return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : null; };
export { handoffLine };
export function writeHandoff(dir, line) {
  const f = path.join(dir, 'index.md');
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch {}
  text = text.split('\n').filter((l) => !l.startsWith('For agents: ')).join('\n').trimEnd();
  fs.writeFileSync(f, `${text}${text ? '\n\n' : ''}For agents: \`${line}\`\n`);
}
const copy = (text) => spawnSync('pbcopy', { input: text }).status === 0;

// The walk's prompt goes to a fresh Claude Code session in a new cmux workspace, opened in the source repo
// (config "agent": "cmux"; "agentModel" picks the model, default opus). Called once the chapters are processed.
// Returns null when it opened, else why not.
const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
export function openInCmux(dir, line, cfg, name) {
  const bin = [process.env.UXW_CMUX, '/Applications/cmux.app/Contents/Resources/bin/cmux'].find((p) => p && fs.existsSync(p)) || 'cmux';
  const cwd = String(cfg.sourceRoot || '~').replace(/^~(?=\/|$)/, os.homedir());
  const prompt = path.join(dir, 'agent-prompt.txt');
  fs.writeFileSync(prompt, line + '\n');
  const cmd = `claude --dangerously-skip-permissions --model ${shq(cfg.agentModel || 'opus')} "$(cat ${shq(prompt)})"`;
  const r = spawnSync(bin, ['new-workspace', '--name', `walk: ${name}`.slice(0, 60), '--cwd', cwd, '--command', cmd, '--focus', 'true'], { encoding: 'utf8', timeout: 15000 });
  if (r.error) return r.error.code === 'ENOENT' ? 'cmux is not installed' : r.error.message;
  return r.status === 0 ? null : (r.stderr || r.stdout || `cmux exited ${r.status}`).trim();
}

export async function record(cfg, { topic, url, app, title, windowId, display, bubbleWindow, callApp, kind, noBrowser, glossary, script, ipc, sources = null }) {
  if (cfg.capture === 'cap' && (!noBrowser || cfg.screenId == null || windowId != null)) throw new Error('Cap capture needs --no-browser and --screen-id (whole screen). Use --capture window for isolated windows; the tested Cap window video included overlapping apps.');
  if (cfg.capture === 'cap' && (app || display != null || bubbleWindow || callApp)) throw new Error('Cap uses explicit target/device IDs; --app, --display, --bubble-window and --call-app are not supported. System audio needs --system-audio.');
  if (cfg.attachCap && cfg.capture !== 'cap') throw new Error('--attach-cap requires --capture cap');
  if (cfg.capture === 'cap') url = null; // an external target is not the configured browser start URL
  if (noBrowser && !['window', 'cap'].includes(cfg.capture)) throw new Error('passive external recording requires --capture window or cap for exact targeting');
  if (windowId != null && !noBrowser) throw new Error('--window-id requires --no-browser so telemetry cannot refer to a different browser');
  if (windowId != null && (!/^\d+$/.test(String(windowId)) || Number(windowId) <= 0)) throw new Error('--window-id must be a positive numeric window ID');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  assertCompanionAvailable(CONFIG_DIR);
  const interactive = !ipc && process.stdin.isTTY && process.stdout.isTTY;
  // Before recording: who is talking, and which glossaries apply (when there is a choice).
  let speakers = String(cfg.speakers || '').split(',').map((x) => x.trim()).filter(Boolean);
  let glossaryRefs = [cfg.glossary, glossary].filter(Boolean).join(',');
  if (interactive && cfg.askSpeakers && !sources) {
    const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask.on('SIGINT', () => process.exit(130));
    const q = { question: (t) => new Promise((r) => ask.question(t, r)) };
    if (!speakers.length) speakers = await askSpeakers(q, cfg.me);
    const using = glossaryRefs.split(',').map((x) => x.trim());
    const named = listGlossaries().named.filter((n) => !using.includes(n));
    if (!glossary && named.length) {
      const a = await q.question(`Glossaries to add (${named.join(', ')}) [none]: `);
      if (a.trim()) glossaryRefs = [glossaryRefs, a.trim()].filter(Boolean).join(',');
    }
    ask.close();
  }
  if (!speakers.length) speakers = [cfg.me];
  const glossaries = resolveGlossaries(glossaryRefs);
  const dir = createSessionDir(cfg.outDir, topic);
  const session = { topic, url, mode: noBrowser ? 'passive-external' : 'recorder-owned-browser', evidenceOnly: !!cfg.evidenceOnly, ...(kind ? { kind } : {}), ...(sources ? { sources } : {}), dir, startedAt: new Date().toISOString(), speakers, glossaries, chapters: [] };
  // The app (--ipc) hears every change of state: a chapter starting or finishing, pause, notes, speakers.
  let sendState = () => {};
  const saveSession = () => { fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2)); sendState(); };
  saveSession();
  const activeFile = path.join(CONFIG_DIR, 'active.json');
  const log = fs.createWriteStream(path.join(dir, 'actions.jsonl'), { flags: 'a' });
  // Say now, not after the walk, when the chapters would get no transcript; the walk still records.
  const noTranscript = cfg.evidenceOnly ? null : transcriberProblem(cfg);
  if (noTranscript) {
    console.log(paint(33, `No transcript for this walk: ${noTranscript}. It records anyway; after setup, "ux-walk process ${dir}" adds the speech.`));
    if (ipc) emit({ ev: 'warn', kind: 'transcriber', text: noTranscript });
  }
  // A walk that dies before recording (Chrome or the capture would not start) leaves its reason behind.
  const died = (e) => { session.error = e.message; saveSession(); throw e; };
  let live = () => {};
  let evidence = null;
  const tally = { notes: 0, lastNote: 0, marks: 0 };
  const write = (o) => {
    const active = evidence?.activeStep();
    const e = { t: Date.now(), ...(['console', 'pageerror'].includes(o.ev) && active ? { stepId: active.stepId, persona: active.persona } : {}), ...o };
    if (cfg.evidenceOnly) {
      if (e.url) e.url = safeUrl(e.url);
      for (const k of ['reqBody', 'resBody', 'headers', 'postData']) delete e[k];
    }
    log.write(JSON.stringify(e) + '\n');
    if (e.ev === 'note' && !e.edit) { tally.notes++; tally.lastNote = Math.max(tally.lastNote, e.id || 0); }
    if (e.ev === 'mark') tally.marks++;
    if ((e.ev === 'note' && !e.edit) || e.ev === 'mark') sendState();
    live(e);
  };

  let browser = null;
  let onBrowserCommand = async () => '';
  if (!noBrowser) {
    browser = await openBrowser({ url, metadataOnly: cfg.evidenceOnly, networkContext: () => { const s = evidence?.activeStep(); return s ? { stepId: s.stepId, persona: s.persona } : {}; }, authFile: cfg.authFile, windowSize: cfg.windowSize, trace: cfg.trace, ignoreWrites: cfg.ignoreWrites, write, onCommand: (c) => onBrowserCommand(c), snapshotDir: () => path.join(dir, 'snapshots'), notesDir: () => path.join(dir, 'notes'), contextSelectors: cfg.contextSelectors, genericTestids: cfg.genericTestids }).catch(died);
  }

  const captureHealth = createCaptureHealth({ session, write, save: saveSession });
  let capture;
  if (cfg.capture === 'cap') {
    session.mediaBackend = 'cap';
    capture = new CapSessionCapture({ dir, attachId: cfg.attachCap, windowId, screenId: cfg.screenId, camera: cfg.evidenceOnly || cfg.attachCap ? undefined : cfg.camera, mic: cfg.evidenceOnly || cfg.noMic || cfg.attachCap ? undefined : cfg.mic,
      systemAudio: !cfg.evidenceOnly && !cfg.attachCap && !!cfg.systemAudio, fps: cfg.fps,
      onEvent: (e) => { captureHealth.event(e); if (e.ev === 'ready') { Object.assign(session.capture, { backend: 'cap', timing: e.timing }); session.capture.target.screenId = cfg.screenId; saveSession(); } if (e.ev === 'media-stopped') { if (session.cap) session.cap.recording = false; saveSession(); } },
    });
  } else if (cfg.capture === 'screen') {
    capture = new ScreenCapture({ screen: cfg.screen, mic: cfg.mic });
  } else {
    const pid = browser?.chromePid();
    if (browser && !pid) died(new Error('could not find the Chrome process to record; try --capture screen'));
    capture = new WindowCapture({
      ...(windowId != null ? { windowId } : display != null ? { display } : app ? { app, title } : { pid }), bubbleWindow, mic: cfg.mic, fps: cfg.fps, noMic: cfg.evidenceOnly || cfg.noMic, callAudio: !cfg.evidenceOnly && (cfg.callAudio || !!callApp),
      callApp: callApp || (cfg.callApp === 'system' ? null : cfg.callApp),
      onEvent: (e) => {
        if (captureHealth.event(e)) console.error(paint(31, `Capture error: ${session.capture.error}`));
        if (e.ev === 'ready') console.log(`Recording window: ${e.app} "${e.title}" ${e.width}x${e.height}`);
        if (e.ev === 'bubble') console.log('Camera bubble: drawn over the window wherever it overlaps it.');
        if (e.ev === 'mic') console.log(`Mic: ${e.name}`);
        if (e.ev === 'call') console.log(e.source === 'tap'
          ? `Call audio: ${e.app} only, on its own track, so people on the call are named apart from you.`
          : 'Call audio: recording what this Mac plays, so people on a call are named apart from you (headphones are fine).');
        if (e.ev === 'warn') console.log(paint(33, e.message));
      },
    });
  }

  let current = null; // the chapter being recorded
  let paused = false;
  let finishing = false;
  let companionEpoch = 0;
  const companionMetadata = {};
  const companion = new CompanionSession({
    recordingId: `${process.pid}:${session.startedAt}`, generation: randomUUID(), backend: 'standalone', mode: noBrowser ? 'external' : 'owned', metadata: companionMetadata,
    epoch: () => companionEpoch,
    state: () => finishing ? 'finishing' : paused ? 'paused' : current && session.capture?.status === 'recording' ? 'recording' : 'preparing',
    details: () => ({ audio: { scope: 'Configured standalone recording sources' } }),
    write: async event => {
      if (!noBrowser && event.companion.role === 'walkthrough' && event.ev === 'click') return true;
      await new Promise((resolve, reject) => log.write(`${JSON.stringify({ ...event, t: event.observedAt })}\n`, error => error ? reject(error) : resolve()));
      if (event.ev === 'meet-caption') {
        const file = path.join(dir, 'meet.jsonl');
        fs.appendFileSync(file, `${JSON.stringify({ t: event.observedAt, observedAt: event.observedAt, kind: 'caption', name: event.name, text: event.text, id: `${event.companion.bindingId}:${companionEpoch}:${event.captionId}`, meeting: event.companion.meeting, revision: event.revision, localSpeaker: event.localSpeaker, timingUncertain: event.timingUncertain, identity: event.identity })}\n`, { mode: 0o600 });
        const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      return true;
    },
    flush: async () => { await new Promise(resolve => log.write('', resolve)); fs.fsyncSync(log.fd); },
    persist: async () => durableCompanionJson(path.join(dir, 'companion.json'), companionMetadata),
  });
  let companionServer;
  try {
    companionServer = await startCompanionServer({ configDir: CONFIG_DIR, session: companion });
    durableCompanionJson(activeFile, { dir, pid: process.pid, startedAt: session.startedAt });
  } catch (error) {
    await companionServer?.close();
    await browser?.close().catch(() => {});
    await new Promise(resolve => log.end(resolve));
    died(error);
  }
  process.on('exit', () => { try { const active = JSON.parse(fs.readFileSync(activeFile, 'utf8')); if (active.pid === process.pid && active.dir === dir && active.startedAt === session.startedAt) fs.unlinkSync(activeFile); } catch {} });
  process.on('exit', companionServer.cleanup);
  setTimeout(() => {
    if (finishing || !companionMetadata.meet?.participantCount || companionMetadata.meet.lastCaptionAt) return;
    const text = 'No selected Meet captions yet: turn captions on in the attached Meet tab for speaker-name evidence.';
    console.log(paint(33, text)); if (ipc) emit({ ev: 'warn', kind: 'meet', text });
  }, 45000).unref();
  const jobs = new Set();
  const controlsHelp = () => capture.continuous
    ? `  n [name]   chapter marker (Cap keeps recording)\n  m <note>   timeline marker\n  p          pause/resume logging only; Cap keeps recording\n  s          status\n  detach     end logging; leave Cap recording\n  q          ${capture.ownsRecording ? 'stop this Cap recording and finish logging' : 'end attached logging; leave Cap recording'}`
    : HELP_KEYS;

  const newChapter = (name) => {
    const n = session.chapters.length + 1;
    name = name || `part ${n}`;
    const cdir = path.join(dir, chapterName(n, name));
    fs.mkdirSync(cdir, { recursive: true });
    return { n, name, dir: cdir, video: path.join(cdir, 'video.mp4') };
  };

  const begin = (ch, startMs) => {
    ch.startMs = startMs;
    current = ch;
    session.chapters.push({ n: ch.n, name: ch.name, dir: path.basename(ch.dir), startMs, status: 'recording' });
    saveSession();
    write({ ev: 'chapter', n: ch.n, name: ch.name });
  };

  // Close the chapter on disk and hand it to a background processor.
  const close = async (ch, finished, revisit = false) => {
    const endMs = finished?.endMs ?? (finished?.durationS ? ch.startMs + finished.durationS * 1000 : Date.now());
    const meta = revisit ? JSON.parse(fs.readFileSync(path.join(ch.dir, 'chapter.json'), 'utf8')) : { n: ch.n, name: ch.name, topic, url, ...(kind ? { kind } : {}), ...(sources ? { sources } : {}), startMs: ch.startMs, endMs, speakers: [...speakers], glossaries, actions: '../actions.jsonl',
      ...(capture.continuous ? { media: 'media.json', sourceProject: '../media/source.cap', timing: capture.state?.timing } : finished?.media ? { media: finished.media, sourceProject: finished.sourceProject, timing: finished.timing } : {}) };
    fs.writeFileSync(path.join(ch.dir, 'chapter.json'), JSON.stringify(meta, null, 2));
    const row = session.chapters.find((c) => c.n === ch.n);
    Object.assign(row, { endMs, status: 'processing' });
    saveSession();
    if (finished?.empty || endMs - ch.startMs < 1500) { row.status = 'empty'; saveSession(); return; }
    if (capture.continuous && !fs.existsSync(ch.video)) { row.status = 'waiting for media'; saveSession(); return; }
    if (cfg.evidenceOnly) { row.status = 'evidence'; saveSession(); return; }
    const job = spawn(process.execPath, [path.join(ROOT, 'bin', 'ux-walk'), 'process', ch.dir, '--quiet', ...(cfg.brief ? ['--brief'] : [])], {
      stdio: ['ignore', fs.openSync(path.join(ch.dir, 'process.log'), 'a'), fs.openSync(path.join(ch.dir, 'process.log'), 'a')],
    });
    jobs.add(job);
    job.on('exit', (code) => {
      jobs.delete(job);
      row.status = code === 0 ? 'ready' : code === 3 ? 'no transcript' : 'failed';
      saveSession();
      const msg = code === 0
        ? `chapter ${ch.n} "${ch.name}" ready: ${path.join(ch.dir, 'timeline-short.md')}`
        : code === 3
          ? `chapter ${ch.n} "${ch.name}" ready without a transcript (see ${path.join(ch.dir, 'process.log')}); after setup: ux-walk process ${ch.dir}`
          : `chapter ${ch.n} processing failed; see ${path.join(ch.dir, 'process.log')} and rerun: ux-walk process ${ch.dir}`;
      say(msg);
    });
  };

  let rl;
  // End of the walk: one asker (src/ask.mjs) for every question, so the terminal never drops back to
  // echoing keys while chapters finish; each question skips itself after ENDING_TIMEOUT_S.
  let asker = null;
  let inCommand = false;
  // Messages from background work redraw the prompt; inside a command the handler prompts once at the end.
  const say = (msg) => {
    if (asker) { asker.print(msg); return; } // the end-of-walk questions are open: print above them
    if (rl && process.stdout.isTTY && !inCommand) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
    console.log(msg);
    if (rl && !finishing && !inCommand) { rl.setPrompt(promptText()); rl.prompt(true); }
  };
  const traceFile = (ch) => path.join(ch.dir, 'trace.zip');
  if (ipc) sendState = () => emit({ ev: 'state', dir, recording: !!current, paused, finishing, mediaBackend: session.mediaBackend, continuousMedia: !!capture.continuous, capRecording: capture.raw?.mediaRecording, ownsRecording: capture.ownsRecording ?? true, chapter: current?.n ?? null, name: current?.name ?? null, startMs: current?.startMs ?? null,
    notes: tally.notes, marks: tally.marks, speakers, chapters: session.chapters.map((c) => ({ n: c.n, name: c.name, status: c.status, dir: path.join(dir, c.dir) })) });

  // What the browser is doing, as it happens: errors, failed loads, writes, risky clicks.
  const ignore = new RegExp(cfg.ignoreWrites, 'i');
  const noise = new RegExp(cfg.ignoreConsole, 'i');
  const seen = new Map();
  live = (e) => {
    const at = current ? mmss(e.t - current.startMs) : '--:--';
    let line = null;
    if (e.ev === 'console' || e.ev === 'pageerror') {
      const text = e.text.split('\n')[0];
      // The browser's own "Failed to load resource" repeats a WRITE/HTTP line that names the request.
      if (/^Failed to load resource/.test(text) || noise.test(e.text)) return;
      if (Date.now() - (seen.get(text) || 0) < 10000) return;
      seen.set(text, Date.now());
      line = e.level === 'warning' ? paint(33, `${at}  warn   ${text}`) : paint(31, `${at}  ERROR  ${text}`);
    } else if (e.ev === 'http') {
      if (noise.test(e.url)) return;
      line = paint(31, `${at}  HTTP   ${e.status} ${e.method} ${e.url.replace(/^https?:\/\/[^/]+/, '')}`);
    } else if (e.ev === 'write') {
      const kind = writeKind(e, ignore, { readRpcs: cfg.readRpcs, writeRpcs: cfg.writeRpcs });
      if (kind !== 'WRITE' && kind !== 'FAIL') return;
      const text = writeLabel(e, url);
      line = paint(kind === 'FAIL' || e.status === 0 || e.status >= 400 ? 31 : 32, `${at}  ${kind.padEnd(5)}  ${text}`);
    } else if (e.ev === 'click' && isRisky(e.el)) {
      line = paint(33, `${at}  RISK   [${label(e.el)}]`);
    } else if (e.ev === 'note') {
      line = paint(36, e.moved ? `${at}  NOTE   #${e.id} moved to ${label(e.el)}` : e.edit ? `${at}  NOTE   #${e.id} edited: "${e.text}"` : `${at}  NOTE   #${e.id} ${e.mode || 'pin'} on ${label(e.el)}${e.text ? ` — "${e.text}"` : ' (voice note)'}`);
    }
    if (line) say(fit(line));
  };

  // The prompt always shows where you are and what you can type.
  const keys = paint(2, 'n next · m mark · p pause · s status · q quit');
  const promptText = () => paused
    ? `${paint(33, capture.continuous ? 'logging paused · Cap recording' : 'paused')} ${paint(2, 'p resume · q quit')} › `
    : current ? `${paint(31, '●')} ch${current.n} ${mmss(Date.now() - current.startMs)} ${keys} › ` : 'ux-walk › ';
  const refreshPrompt = () => { if (rl && !finishing && !inCommand && rl.line === '') { rl.setPrompt(promptText()); if (tty) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); } rl.prompt(true); } };
  // One line: where you are, what you have left so far, what is still processing, who is talking.
  const status = () => {
    const rec = paused ? (capture.continuous ? 'logging paused; Cap recording' : 'paused') : current ? `chapter ${current.n} "${current.name}" ${mmss(Date.now() - current.startMs)}` : 'starting';
    const by = (st) => session.chapters.filter((c) => c.status === st).map((c) => c.n);
    const busy = by('processing'), ready = by('ready'), failed = by('failed');
    return [rec,
      `notes ${tally.notes}${tally.notes ? ` (last #${tally.lastNote})` : ''}`,
      `markers ${tally.marks}`,
      busy.length ? `processing ch${busy.join(', ch')}` : ready.length ? `${ready.length} ready` : '',
      failed.length ? `failed ch${failed.join(', ch')}` : '',
      `speakers ${speakers.join(', ')}`].filter(Boolean).join(' · ');
  };

  // The recorder shortcuts from any app (src: swift/uxw-capture.swift --hotkeys): the page alone hears them
  // only while the browser window is in front, and walkers press them while reading the terminal.
  // Also notes time spent in another app (the page cannot tell: Playwright keeps it "focused").
  // A --script run (the self-test) leaves them off unless UXW_HOTKEYS=1 or UXW_REAL_KEYS is set.
  let hot = null, awayAt = 0, awayApp = '';
  const startHotkeys = () => {
    if (cfg.evidenceOnly || process.env.UXW_NO_HOTKEYS || (script && !process.env.UXW_HOTKEYS && !process.env.UXW_REAL_KEYS) || !fs.existsSync(HELPER)) return;
    const chromePid = browser?.chromePid?.();
    hot = spawn(HELPER, ['--hotkeys'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let ok = false, err = '';
    hot.stderr.on('data', (d) => { err += d; });
    hot.on('error', () => {});
    hot.on('exit', () => { if (!ok && !finishing) say(paint(33, `Option+Shift+N / M / P work only in the browser window (the capture helper is old${err ? `: ${err.trim().slice(0, 80)}` : ''}); rebuild it: ${path.join(ROOT, 'install.sh')}`)); });
    readline.createInterface({ input: hot.stdout }).on('line', (l) => {
      let e; try { e = JSON.parse(l); } catch { return; }
      if (e.ev === 'hotkeys') ok = true;
      else if (e.ev === 'warn') say(paint(33, e.message));
      else if (e.ev === 'error') { ok = true; say(paint(33, `shortcuts: ${e.message}`)); }
      else if (e.ev === 'hotkey' && !finishing) runCommand(e.key === 'm' ? 'm marker' : e.key, 'hotkey');
      else if (e.ev === 'front' && chromePid) {
        if (e.pid !== chromePid) { if (!awayAt) { awayAt = Date.now(); awayApp = e.app; } }
        else if (awayAt) { const t = awayAt, ms = Date.now() - t; awayAt = 0; if (ms > 3000) write({ t, ev: 'away', s: Math.round(ms / 1000), app: awayApp }); }
      }
    });
  };

  // First chapter.
  const first = newChapter('part 1');
  begin(first, (await capture.start(first.video).catch((e) => { browser?.close().catch(() => {}); return died(e); })).startMs);
  if (capture.continuous) {
    session.cap = { recordingId: capture.state.recordingId, ownsRecording: capture.ownsRecording, mediaDir: 'media', timing: capture.state.timing };
    session.logging = { startedAt: first.startMs, pauseAffectsMedia: false };
  }
  saveSession();
  // The first words before this moment are not recorded: say when it starts, in the page too.
  console.log(paint(31, '● Recording now.'));
  const rollCue = speakers.length > 1 ? ` Say your names: ${speakers.join(', ')}.` : '';
  browser?.toast(kind === 'call' ? `● Recording now. Share this window in the call.${rollCue}` : `● Recording now.${rollCue}`);

  console.log(`Recording to ${dir}`);
  console.log(`Speakers: ${speakers.join(', ')}. Glossaries: ${glossaries.map((g) => (path.dirname(g) === CONFIG_DIR ? 'default' : path.basename(g, '.txt'))).join(', ') || 'none'}.${cfg.brief ? ' Briefs: on.' : ''}`);
  console.log(controlsHelp());
  if (capture.continuous) console.log(`Cap keeps recording between chapters and while logging is paused. ${capture.ownsRecording ? 'Stop ends this recording and logging.' : 'Stop ends logging only; the attached Cap recording is left running.'}`);
  if (speakers.length > 1) console.log(paint(2, `Say your names ("This is ${speakers[0]}", "This is ${speakers[1]}") now: the transcript names the voices from it, and a voice that did not say its name stays "Speaker N".`));

  evidence = createEvidence({ dir, session, chapter: () => current, capture, write, browser });
  if (cfg.attachCap) evidence.coverage.videoMapping = 'Not verified: the selected screenshot screen and attached Cap video are independent targets. Cap may already contain camera/audio from its own setup.';
  saveSession();
  if (ipc) emit({ ev: 'ready', dir, chromePid: browser?.chromePid?.() ?? null, coverage: evidence.coverage });

  const finish = async (why) => {
    if (finishing) return;
    finishing = true; companionEpoch++;
    rl?.close();
    try { hot?.stdin.end(); hot?.kill(); } catch {}
    if (ipc && !script && !cfg.evidenceOnly) asker = ipcAsker;
    else if (interactive && !script) asker = createAsker();
    console.log(`\nStopping (${why})...`);
    const finished = await capture.stop().catch((error) => { captureHealth.event({ ev: 'error', message: error.message }); return null; });
    if (capture.continuous) {
      session.cap.pendingMedia = finished?.pending === true; session.logging.endedAt = Date.now();
      if (!finished) session.cap.mediaError = session.capture.error || 'Cap media finalization failed';
      if (finished?.pending) session.coverage.video = 'Pending: attached Cap is still recording; reconcile after its owner finishes it.';
    }
    captureHealth.stop(why);
    const last = !paused ? current : null;
    current = null;
    if (browser) await browser.close(last ? traceFile(last) : undefined); // writes the last trace chunk
    if (last) await close(last, finished);
    if (capture.continuous && finished?.mediaReady) {
      for (const row of session.chapters.filter((c) => c.status === 'waiting for media')) {
        const ch = { ...row, dir: path.join(dir, row.dir), video: path.join(dir, row.dir, 'video.mp4') };
        await close(ch, { endMs: row.endMs }, true);
      }
    }
    if (cfg.evidenceOnly) {
      session.endedAt = new Date().toISOString(); saveSession();
      await new Promise((resolve) => log.end(resolve));
      const report = writeReport(dir);
      if (ipc) emit({ ev: 'done', ok: session.capture.status !== 'interrupted', pendingMedia: session.cap?.pendingMedia, ownsRecording: capture.ownsRecording ?? true, dir, report, capture: session.capture, coverage: session.coverage, chapters: session.chapters });
      process.exit(session.capture.status === 'interrupted' ? 1 : 0);
    }
    log.end();
    if (jobs.size) out(`Processing ${jobs.size} chapter(s): audio, screenshots, transcript, timeline...`);
    const processing = Promise.all([...jobs].map((j) => new Promise((r) => j.on('exit', r))));
    // While the chapters process: what should agents do with this walk? It becomes the paste-ready prompt.
    const ask = script ? (process.env.UXW_ASK || '') : asker ? await asker.ask(`What should agents do with this ${kind === 'call' ? 'call' : 'walk'}? (Enter to skip) `, { timeoutS: ENDING_TIMEOUT_S }) : '';
    if (ask.trim()) { session.ask = ask.trim(); saveSession(); }
    if (jobs.size) out(`Waiting for ${jobs.size} chapter(s) to finish processing...`);
    await processing;
    // No speaker popup: voices are named from the roll call. Fix a label any time with ux-walk speakers.
    if (speakers.length > 1) out(`Voices are named from the roll call; rename one any time with: ux-walk speakers ${dir}`);
    const line = handoffLine(dir, session.ask);
    writeHandoff(dir, line);
    // A --script run (the self-test) leaves the clipboard alone.
    const copied = !script && !process.env.UXW_NO_COPY && copy(line);
    out(`${copied ? 'Copied to the clipboard' : 'Paste into Claude Code'}: ${line}`);
    let agent = null;
    if (!script && cfg.agent === 'cmux') {
      const why = openInCmux(dir, line, cfg, topic);
      if (why) out(paint(33, `Could not open the agent in cmux (${why}); the prompt is on the clipboard.`));
      else { agent = 'cmux'; out('Opened a Claude Code session in cmux with the prompt.'); }
    }
    writeIndexHint();
    if (ipc) emit({ ev: 'done', ok: session.capture.status !== 'interrupted', pendingMedia: session.cap?.pendingMedia, ownsRecording: capture.ownsRecording ?? true, capture: session.capture, coverage: session.coverage, dir, handoff: line, copied, agent, chapters: session.chapters.map((c) => ({ n: c.n, name: c.name, status: c.status })) });
    asker?.close();
    process.exit(session.capture.status === 'interrupted' ? 1 : 0);
  };
  const out = (msg) => (asker ? asker.print(msg) : console.log(msg));
  const writeIndexHint = () => {
    const ready = session.chapters.filter((c) => c.status === 'ready').length;
    out(`Index: ${path.join(dir, 'index.md')} (${ready}/${session.chapters.length} chapters ready)`);
    out(`Done: ${dir}`);
  };

  // The app sends JSON commands on stdin; a terminal gets the prompt.
  const ipcAsker = ipc ? createIpcAsker() : null;
  if (ipc) readCommands({
    onEvidence: (m) => {
      const run = busy.then(async () => {
        if (finishing) throw new Error('recorder is finishing');
        if (paused && capture.continuous && m.cmd !== 'report') throw new Error('Logging is paused; Cap is still recording');
        if (m.cmd === 'report') await new Promise((resolve) => log.write('', resolve));
        try { return await evidence.run(m); }
        catch (error) { write({ ev: 'evidence-error', requestId: m.requestId, cmd: m.cmd, stepId: m.stepId, text: error.message, ...(error.details ? { details: error.details } : {}) }); throw error; }
      });
      busy = run.catch(() => {}); // A rejected command does not poison the next command.
      return run;
    },
    onCommand: (line) => runCommand(line, 'app'), onAnswer: (m) => ipcAsker.answer(m),
    onClose: () => { busy = busy.then(() => finish('app quit')); },
  });
  else {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: promptText() });
    rl.prompt();
    if (tty) setInterval(refreshPrompt, 1000).unref();
  }
  let busy = Promise.resolve();
  onBrowserCommand = (cmd) => (finishing ? Promise.resolve('') : runCommand(cmd, 'page'));
  // One command runner for the terminal and the shortcuts. Resolves to a short reply. A chapter, marker,
  // pause or speaker change also shows in the page as a toast (the page shows its own for its shortcuts).
  const runCommand = (line, from = 'terminal') => (busy = busy.then(async () => {
    inCommand = true;
    let reply = '';
    let failure = null;
    const tell = (msg) => { reply = String(msg).split('\n')[0]; say(msg); };
    const [cmd, ...rest] = line.trim().split(/\s+/);
      const arg = rest.join(' ');
      try {
        if (joinNames(line)?.length) {
          // Someone joined: a speaker for this chapter (its chapter.json is written when it closes) and every later one.
          const added = joinNames(line).filter((x) => !speakers.includes(x));
          speakers.push(...added);
          // Someone joining mid-walk is almost always joining the call.
          if (sources) sources.call.push(...added);
          (session.joined ||= []).push(...added.map((name) => ({ name, at: new Date().toISOString(), chapter: current?.n ?? null })));
          saveSession();
          if (added.length) write({ ev: 'mark', text: `${added.join(', ')} joined` });
          tell(added.length ? `speakers: ${speakers.join(', ')}` : `already a speaker: ${joinNames(line).join(', ')}`);
        } else if (!cmd) {
          // nothing
        } else if (cmd === 'n' || cmd === 'next') {
          if (paused) { tell('paused; p resumes into a new chapter'); return reply; }
          const prev = current, ch = newChapter(arg);
          const r = await capture.rotate(ch.video);
          begin(ch, r.startMs);
          if (browser) { await browser.saveTraceChunk(traceFile(prev)); await browser.startTraceChunk(); }
          tell(capture.continuous ? `chapter ${ch.n} "${ch.name}" marked; Cap recording continues` : `chapter ${ch.n} "${ch.name}" recording; processing chapter ${prev.n} "${prev.name}"`);
          await close(prev, r.finished);
          if (browser) browser.saveAuth();
        } else if (cmd === 'm' || cmd === 'mark') {
          write({ ev: 'mark', text: arg || 'mark' });
          if (browser) browser.snapshot('mark');
          tell(`marked at ${current ? mmss(Date.now() - current.startMs) : '--:--'}`);
        } else if (cmd === 'p' || cmd === 'pause') {
          if (!paused) {
            const finished = await capture.pause();
            const prev = current; current = null; paused = true; companionEpoch++;
            if (session.logging) session.logging.paused = true;
            write({ ev: 'pause' });
            if (browser) await browser.saveTraceChunk(traceFile(prev));
            await close(prev, finished);
            tell(capture.continuous ? 'Logging paused; Cap is still recording. p resumes logging.' : `paused; chapter ${prev.n} processing. p (or Option+Shift+P in the browser) resumes.`);
          } else {
            const ch = newChapter(arg || `part ${session.chapters.length + 1}`);
            if (browser) await browser.startTraceChunk();
            begin(ch, (await capture.resume(ch.video)).startMs);
            paused = false; companionEpoch++;
            if (session.logging) { session.logging.paused = false; saveSession(); }
            tell(`resumed: chapter ${ch.n} "${ch.name}"`);
          }
        } else if (cmd === 's' || cmd === 'status') {
          tell(status());
        } else if (cmd === 'q' || cmd === 'quit' || cmd === 'stop') {
          await finish('q');
        } else if (cmd === 'detach') {
          if (!capture.releaseOwnership) throw new Error('Detach is available only for Cap logging');
          capture.releaseOwnership(); session.cap.ownsRecording = false;
          await finish('detach');
        } else if (cmd === 'h' || cmd === '?' || cmd === 'help') {
          tell(controlsHelp());
        } else {
          throw new Error(`unknown command "${cmd}"`);
        }
      } catch (e) {
        failure = e.message;
        tell(`error: ${e.message}`);
      }
    inCommand = false;
    if (!finishing && rl) { rl.setPrompt(promptText()); rl.prompt(); }
    if (ipc && reply) emit({ ev: 'reply', text: reply });
    if (from !== 'page' && reply && browser && !finishing && (/^(n|next|m|mark|p|pause)$/.test(cmd || '') || joinNames(line)?.length)) browser.toast(reply);
    return failure ? { error: failure } : reply;
  }).finally(() => { inCommand = false; }));
  rl?.on('line', (line) => { runCommand(line); });
  startHotkeys();
  rl?.on('SIGINT', () => finish('Ctrl+C'));
  process.on('SIGINT', () => finish('Ctrl+C'));
  process.on('SIGTERM', () => finish('SIGTERM'));
  if (browser) {
    browser.browser.on('disconnected', () => finish('browser closed'));
    setInterval(() => { if (!finishing && browser && browser.context.pages().length === 0) finish('last tab closed'); }, 500).unref();
  }
  // --script: a module that drives the page and narrates, for demos and for testing ux-walk itself.
  //   export default async ({ page, cmd, say, sleep }) => { ... }   cmd('n checkout'), say('text')
  if (script && browser) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // UXW_SAY_VOICE picks the macOS voice (say -v '?' lists them); the system voice may not be English.
    const voice = process.env.UXW_SAY_VOICE || 'Samantha';
    // UXW_SILENT=1: no audio, just the time the sentence would take (about 175 words a minute).
    const speak = process.env.UXW_SILENT ? (text) => sleep(Math.round(text.split(/\s+/).length * 343))
      : (text) => new Promise((r) => spawn('say', ['-v', voice, '-r', '175', text], { stdio: 'ignore' }).on('exit', r));
    (async () => {
      const mod = await import(pathToFileURL(path.resolve(script)).href);
      await mod.default({ page: browser.context.pages()[0], cmd: runCommand, say: speak, sleep });
      await finish('script finished');
    })().catch((e) => { say(`script error: ${e.message}`); finish('script error'); });
  }
  if (capture instanceof WindowCapture || capture instanceof CapSessionCapture) capture.done.then((code) => {
    if (!finishing && code !== 0) finish(`capture ended (${code ?? 'signal'})`);
  });
}
