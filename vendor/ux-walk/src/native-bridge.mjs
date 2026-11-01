// Meet and selected-tab evidence share one host. Only the live recorder chooses destination paths.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeUrl } from './network.mjs';
import { COMPANION_PROTOCOL, processAlive, requestCompanion } from './companion.mjs';
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const need = (ok, message) => { if (!ok) throw new Error(message); };
const short = (v, n = 200) => typeof v === 'string' ? v.slice(0, n) : '';
export const recordingId = (a) => a ? `${a.pid}:${a.startedAt}` : null;
export function createNativeBridge({ configDir, clock = Date.now, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } }) {
  const active = () => {
    const a = read(path.join(configDir, 'active.json'));
    return a && Number.isInteger(a.pid) && a.pid > 0 && typeof a.dir === 'string' && typeof a.startedAt === 'string' && isAlive(a.pid) ? a : null;
  };
  const append = (a, event) => fs.appendFileSync(path.join(a.dir, 'actions.jsonl'), JSON.stringify({ t: clock(), source: 'chrome-extension', ...event }) + '\n');
  const writable = (a) => {
    need(a, 'Start a ux-walk recording first.');
    const s = read(path.join(a.dir, 'session.json'));
    need(s && !s.endedAt && !s.error && s.capture?.status === 'recording' && s.chapters?.at(-1)?.status === 'recording', 'The recorder must be ready and recording, not paused or finishing.');
  };
  const bound = (a, m) => {
    if (m.type === 'tab-stop') need(a, 'The recording ended.');
    else writable(a);
    need(m.recordingId === recordingId(a), 'Recording changed; select this tab again.');
    const b = read(path.join(a.dir, 'browser-target.json'));
    need(b && !b.endedAt && b.recordingId === m.recordingId && b.bindingId === m.bindingId && b.clientId === m.clientId && b.tabId === m.tabId, 'This tab is not selected for this recording.');
    return b;
  };
  const context = (d, b) => {
    const u = new URL(d.url), v = d.viewport || {};
    need(['http:', 'https:'].includes(u.protocol) && u.origin === b.origin, 'Page origin changed; select the tab again.');
    need([v.width, v.height].every((n) => Number.isFinite(n) && n > 0 && n <= 50000), 'Invalid viewport.');
    return { url: safeUrl(u.href), title: short(d.title), viewport: { width: v.width, height: v.height },
      ...(Number.isFinite(d.devicePixelRatio) ? { devicePixelRatio: d.devicePixelRatio } : {}), ...(Number.isFinite(d.zoom) ? { zoom: d.zoom } : {}) };
  };
  return { handle(m) {
    const a = active();
    if (String(m.type).startsWith('companion-')) {
      const reply = async () => {
        const file = path.join(configDir, 'companion-session.json');
        let owner;
        try {
          const info = fs.lstatSync(file);
          need(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && (process.getuid == null || info.uid === process.getuid()), 'Companion owner descriptor is not private.');
          owner = read(file);
          need(owner?.protocolVersion === COMPANION_PROTOCOL && /^[a-f0-9]{64}$/.test(owner.token) && owner.host === '127.0.0.1' && Number.isSafeInteger(owner.port) && owner.port >= 20000 && owner.port < 40000, 'Invalid companion owner descriptor.');
          if (!processAlive(owner.pid) || !processAlive(owner.recorderPid)) owner = null;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        need(!owner || !a || recordingId(a) === owner.recordingId, 'Two recording owners are active. Stop one before attaching the companion.');
        if (!owner) {
          need(m.type === 'companion-hello', 'Start a current Cap UX or ux-walk recording first.');
          return { type: 'status', protocolVersion: COMPANION_PROTOCOL, state: a ? 'legacy' : 'idle', recording: false, roles: {} };
        }
        return requestCompanion(owner, m);
      };
      return reply().then(result => result.type === 'status' ? { ...result, requestId: m.requestId } : { type: 'companion-result', requestId: m.requestId, ok: true, result }).catch(error => ({ type: 'companion-result', requestId: m.requestId, ok: false, error: error.message }));
    }
    if (m.type === 'hello') {
      const b = a ? read(path.join(a.dir, 'browser-target.json')) : null;
      return { type: 'status', ...(m.requestId ? { requestId: m.requestId } : {}), recording: !!a, dir: a?.dir || null, recordingId: recordingId(a),
        ...(b && !b.endedAt && b.clientId === m.clientId && b.recordingId === recordingId(a) ? { target: b } : {}) };
    }
    if (['participants', 'debug', 'event'].includes(m.type)) return;
    if (!String(m.type).startsWith('tab-')) return;
    const ok = (result) => ({ type: 'tab-result', requestId: m.requestId, ok: true, result });
    try {
      need(typeof m.requestId === 'string' && m.requestId.length > 0 && m.requestId.length <= 100, 'requestId required.');
      need(typeof m.clientId === 'string' && m.clientId.length >= 16 && m.clientId.length <= 100 && Number.isInteger(m.tabId) && m.tabId >= 0, 'Invalid tab identity.');
      if (m.type === 'tab-start') {
        writable(a); need(m.recordingId === recordingId(a), 'Recording changed; select this tab again.');
        const u = new URL(m.url); need(['http:', 'https:'].includes(u.protocol), 'Only HTTP/HTTPS test tabs can be selected.');
        const file = path.join(a.dir, 'browser-target.json'), old = read(file);
        need(!old || old.endedAt, 'A tab is already selected. Stop its collection first.');
        const b = { recordingId: m.recordingId, bindingId: randomUUID(), clientId: m.clientId, tabId: m.tabId, windowId: m.windowId,
          origin: u.origin, url: safeUrl(u.href), title: short(m.title), startedAt: clock(), videoMapping: 'Not verified; selected tab and native video window are independent targets.' };
        fs.writeFileSync(file, JSON.stringify(b, null, 2)); append(a, { ev: 'tab-binding', phase: 'start', ...b }); return ok(b);
      }
      const b = bound(a, m);
      if (m.type === 'tab-stop') {
        const ended = { ...b, endedAt: clock(), reason: short(m.reason || 'Stopped by user') };
        fs.writeFileSync(path.join(a.dir, 'browser-target.json'), JSON.stringify(ended, null, 2)); append(a, { ev: 'tab-binding', phase: 'stop', ...ended }); return ok(ended);
      }
      const d = m.data || {}, at = d.observedAt;
      need(Number.isFinite(at) && at >= Date.parse(a.startedAt) && at <= clock() + 1000, 'Invalid observation time.');
      const meta = context(d.context || {}, b);
      const base = { ev: 'tab-observation', bindingId: b.bindingId, tabId: b.tabId, observedAt: at, context: meta };
      if (m.type === 'tab-checkpoint') {
        need(typeof d.text === 'string' && d.text.length <= 64000, 'Visible text must be at most 64000 characters.');
        const notes = path.join(a.dir, 'notes'); fs.mkdirSync(notes, { recursive: true });
        const stem = `tab-${randomUUID()}`, textPath = path.join(notes, `${stem}.txt`), metadataPath = path.join(notes, `${stem}.json`);
        const e = { ...base, kind: 'checkpoint', evidenceId: stem, textPath, metadataPath, truncated: !!d.truncated,
          coverage: 'Selected-tab visible text and clicks only. No screenshot, complete DOM, network, console, or iframe coverage.' };
        fs.writeFileSync(textPath, d.text); fs.writeFileSync(metadataPath, JSON.stringify(e, null, 2)); append(a, e); return ok(e);
      }
      need(m.type === 'tab-event' && d.kind === 'click', 'Unsupported tab observation.');
      const el = d.element || {}, p = d.point || {};
      append(a, { ...base, kind: 'click', element: { tag: short(el.tag, 30), role: short(el.role, 30), name: short(el.name, 160), testid: short(el.testid, 100) },
        ...(Number.isFinite(p.x) && Number.isFinite(p.y) ? { point: { x: p.x, y: p.y, coordinates: 'CSS viewport' } } : {}) }); return ok({ saved: true });
    } catch (error) { return { type: 'tab-result', requestId: m.requestId, ok: false, error: error.message }; }
  } };
}
