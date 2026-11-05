// Deterministic local report: no transcription, model calls, or remote resources.
import fs from 'node:fs';
import path from 'node:path';
import { withKeys } from './brief.mjs';
import { emptyEdits, overlay, readEdits } from './edits.mjs';
const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pretty = (v) => `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
const rows = (values) => values.map((v) => `<td>${v}</td>`).join('');
const missing = (text) => `<span class="missing">${esc(text)}</span>`;
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const timestamp = (v) => v == null || !Number.isFinite(new Date(v).getTime()) ? 'Unavailable' : new Date(v).toISOString();
const qualified = (source, id) => source.id ? `${source.id}::${id}` : String(id ?? '');

// Resolve against the owning session, including realpath: a symlink cannot import unrelated evidence.
function localFile(root, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return { error: 'Missing evidence' };
  const absolute = path.resolve(root, file);
  try {
    const canonical = fs.realpathSync(absolute);
    if (!within(fs.realpathSync(root), canonical)) return { error: 'Unsafe evidence' };
    if (!fs.statSync(canonical).isFile()) return { error: 'Missing evidence' };
    return { absolute: canonical };
  } catch { return { error: within(root, absolute) ? 'Missing evidence' : 'Unsafe evidence' }; }
}
function link(source, file, label, outputDir) {
  const resolved = localFile(source.dir, file);
  if (resolved.error) return missing(`${resolved.error}: ${label || file || 'Unavailable'}`);
  const relative = path.relative(outputDir, resolved.absolute);
  return `<a href="${esc(relative.split(path.sep).map(encodeURIComponent).join('/'))}">${esc(label || file)}</a>`;
}
function loadSource(dir, id = '') {
  const absolute = path.resolve(dir);
  const source = { dir: fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute, id, session: {}, actions: [], checkpoints: new Map(), findings: [], ledger: {}, problems: [] };
  const sessionFile = localFile(source.dir, 'session.json');
  if (sessionFile.error) { source.problems.push(`Missing session: ${id || dir}`); return source; }
  source.session = read(sessionFile.absolute, null);
  if (!source.session || typeof source.session !== 'object') { source.session = {}; source.problems.push(`Unreadable session: ${id || dir}`); return source; }
  const actionsFile = localFile(source.dir, 'actions.jsonl');
  if (actionsFile.error) source.problems.push(`Missing actions: ${id || dir}; evidence and timing coverage unverified`);
  else fs.readFileSync(actionsFile.absolute, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { const e = JSON.parse(line); if (!e || typeof e !== 'object') throw new Error(); source.actions.push(e); }
    catch { source.problems.push(`Unreadable action: ${id || dir} line ${i + 1}; coverage unverified`); }
  });
  for (const e of source.actions.filter((e) => e.ev === 'checkpoint' || (e.ev === 'tab-observation' && e.kind === 'checkpoint'))) {
    if (source.checkpoints.has(e.evidenceId)) throw new Error(`Duplicate evidence ID in ${id || dir}: ${e.evidenceId}`);
    source.checkpoints.set(e.evidenceId, e);
  }
  source.ledger = read(localFile(source.dir, 'ledger.json').absolute, {}) || {};
  const ids = new Set(), inventories = [];
  for (const c of source.session.chapters || []) {
    if (typeof c?.dir !== 'string') { source.problems.push(`Invalid chapter directory in ${id || dir}; finding coverage unverified`); continue; }
    const file = localFile(source.dir, path.join(c.dir, 'items.json'));
    const inventory = read(file.absolute, null);
    if (!Array.isArray(inventory?.items)) { source.problems.push(`Finding inventory unavailable: ${id || dir}/${c.dir}; no findings pass inferred`); continue; }
    for (const f of inventory.items) {
      if (ids.has(f.id)) throw new Error(`Duplicate finding ID in ${id || dir}: ${f.id}`);
      ids.add(f.id);
    }
    inventories.push({ n: c.n, items: withKeys(inventory.items, inventory.chapter || c.n || 1) });
  }
  // The user's edits (edits.json) apply; items they deleted are left out, items they added are findings too.
  let edits = emptyEdits();
  const editsFile = localFile(source.dir, 'edits.json');
  if (!editsFile.error) { try { edits = readEdits(source.dir); } catch (e) { source.problems.push(`Unreadable edits: ${id || dir}; generated items shown unedited (${e.message})`); } }
  for (const c of overlay(inventories, edits).chapters) for (const f of c.items) if (!f.deleted) source.findings.push({ ...f, id: f.id || f.key, source });
  return source;
}
function loadReport(dir) {
  const file = path.join(dir, 'report.json');
  if (!fs.existsSync(file)) return { sources: [loadSource(dir)], manifest: null };
  const manifest = read(file, null);
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.segments) || !manifest.segments.length || (manifest.findings != null && !Array.isArray(manifest.findings))) throw new Error('Invalid report manifest: expected version 1 and nonempty segments');
  const ids = new Set(['report']), directories = new Set();
  const sources = manifest.segments.map((s) => {
    if (!s || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s.id) || typeof s.dir !== 'string' || !s.dir) throw new Error('Invalid report manifest segment: id and dir required (id report is reserved)');
    if (ids.has(s.id)) throw new Error(`Duplicate segment ID: ${s.id}`); ids.add(s.id);
    const absolute = path.resolve(dir, s.dir), canonical = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    if (directories.has(canonical)) throw new Error(`Duplicate source session: ${s.dir}`); directories.add(canonical);
    return loadSource(absolute, s.id);
  });
  const findingIds = new Set();
  for (const f of manifest.findings || []) {
    if (!f || typeof f.id !== 'string' || !f.id || findingIds.has(f.id)) throw new Error('Invalid or duplicate report manifest finding ID');
    findingIds.add(f.id);
  }
  return { sources, manifest };
}
function evidence(refs, source, sources, outputDir) {
  if (!Array.isArray(refs)) return missing('Invalid evidence references');
  return refs.map((ref) => {
    let owner = source, id = ref;
    if (ref && typeof ref === 'object') {
      owner = sources.find((s) => s.id === ref.session);
      if (!owner) return missing(`Missing source session: ${ref.session}`);
      if (typeof ref.path === 'string' && ref.id == null) return link(owner, ref.path, qualified(owner, ref.path), outputDir);
      id = ref.id;
    }
    const e = owner?.checkpoints?.get(id), label = owner ? qualified(owner, id) : String(id);
    if (!e) return missing(`Missing evidence: ${label}`);
    const files = [['path', label], ['cropPath', `${label} crop`], ['textPath', `${label} ${e.textSource || 'selected-tab visible'} text`], ['metadataPath', `${label} metadata`]];
    const required = new Set(e.ev === 'checkpoint' ? ['path', 'metadataPath'] : ['textPath', 'metadataPath']);
    const available = files.filter(([key]) => e[key] || required.has(key)).map(([key, name]) => link(owner, e[key], name, outputDir));
    return available.length ? available.join(' · ') : missing(`Missing evidence files: ${label}`);
  }).join('<br>');
}
function captureWarning(source) {
  const { session, actions } = source, errors = actions.filter((e) => e.ev === 'capture-error');
  return session.capture?.status === 'interrupted' || errors.length
    ? `<aside role="alert" class="capture-warning"><strong>${esc(source.id ? `${source.id}: ` : '')}Recording interrupted — capture coverage is incomplete.</strong><p>${esc(session.capture?.error || errors.at(-1)?.text || 'Native recording failed')}</p><p>Capture end reason: ${esc(session.capture?.endReason || 'Unavailable')}. Saved checkpoints may still be usable; this report does not establish uninterrupted video capture.</p></aside>` : '';
}
// First/last native boundary facts only; no synthetic joining or replacement of raw timestamps.
function bounds(source) {
  const { session } = source, starts = (session.chapters || []).map((c) => c.startMs).filter(Number.isFinite);
  const failure = (session.capture?.boundaries || []).find((e) => ['stream-failed', 'start-failed'].includes(e.helperEvent?.phase))?.helperEvent;
  const nativeFailure = failure?.callbackAt ?? failure?.epochMs;
  const errors = (session.capture?.errors || []).map((e) => e.t).filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : session.capture?.startedAt;
  const end = session.capture?.status === 'interrupted'
    ? (nativeFailure ?? (errors.length ? Math.min(...errors) : session.capture.interruptedAt))
    : session.capture?.endedAt;
  return { start, end };
}
function segmentSummary(sources, manifest, dir) {
  if (!manifest) return '';
  return `<h2>Recording segments and gaps</h2><p>Combined evidence from separate sessions; not a continuous recording. Clean continuations do not repair interrupted video or establish missing workflow, console, network or DOM coverage. Gaps below use saved chapter first-frame / capture boundary wall clocks, not a claim of exact media coverage.</p><table><tr><th>Session</th><th>Capture status / boundaries</th><th>Gap from previous segment</th><th>Coverage / diagnostics</th></tr>${sources.map((s, i) => {
    const b = bounds(s), previous = i ? bounds(sources[i - 1]) : null;
    const delta = previous && Number.isFinite(previous.end) && Number.isFinite(b.start) ? b.start - previous.end : null;
    const gap = !i ? 'First listed segment' : delta == null ? 'Unknown; missing boundary timestamps' : delta >= 0 ? `${delta} ms without native recording between saved boundaries` : `${-delta} ms overlap or out-of-order segments; continuity unverified`;
    return `<tr>${rows([`${esc(s.id)}<br>${link(s, 'session.json', 'Source session', dir)}`, `${esc(s.session.capture?.status || 'unverified')}<br>${esc(timestamp(b.start))} → ${esc(timestamp(b.end))}`, esc(gap), pretty(s.session.coverage || { coverage: 'Not recorded' }) + pretty(s.session.capture || { capture: 'Not recorded' }) + s.problems.map(missing).join('<br>')])}</tr>`;
  }).join('')}</table><h2>Combined coverage supplied by report author</h2>${pretty(manifest.coverage || { coverage: 'Not supplied; source limits still apply' })}`;
}
function renderSource(source, sources, outputDir) {
  const { session, actions, checkpoints } = source;
  const q = (id) => qualified(source, id), local = (f, label) => link(source, f, label, outputDir), refs = (r) => evidence(r, source, sources, outputDir);
  const segment = bounds(source);
  const stepCoverage = (step) => {
    const notes = [];
    if (Number.isFinite(step.startedAt) && Number.isFinite(segment.start) && step.startedAt < segment.start) notes.push(`${segment.start - step.startedAt} ms before this segment; earlier native coverage unverified`);
    if (Number.isFinite(step.lastObservedAt) && Number.isFinite(segment.end) && step.lastObservedAt > segment.end) notes.push(`${step.lastObservedAt - segment.end} ms after this segment; later native coverage unverified`);
    return notes.length ? notes.join('; ') : 'Native coverage of the full action not independently verified';
  };
  const steps = new Map();
  for (const e of actions.filter((e) => e.ev === 'step')) steps.set(e.stepId, { ...steps.get(e.stepId), ...e });
  const tabObservations = actions.filter((e) => e.ev === 'tab-observation');
  const mediaState = read(localFile(source.dir, 'media/cap-session.json').absolute, {});
  return `${source.id ? `<h2>Session ${esc(source.id)} — ${esc(session.topic)}</h2>` : ''}<p>Started ${esc(session.startedAt)}. Readiness is declared by the driver, never inferred from network idle or Event Timing.</p>
${source.problems.map(missing).join('<br>')}
${session.cap ? `<h2>Cap recording and logging</h2><p>${session.cap.pendingMedia ? 'Log finished; Cap is still recording. Video is pending. Reconcile after its owner finishes the recording.' : mediaState.status === 'logging' ? 'Logging is in progress. Cap records continuously, including during logging pauses.' : session.cap.mediaError ? `Media is incomplete: ${esc(session.cap.mediaError)}` : 'Logging finished; the continuous source and chapter derivatives are retained locally.'}</p><p>Recording ${esc(session.cap.recordingId)}. ${session.cap.ownsRecording ? 'This logger owned the recording.' : 'Attached recording; ending logging did not stop Cap.'} Source alignment is approximate.</p><p>${local('media/cap-session.json', 'Logging ranges and clock')}${localFile(source.dir, 'media/video.mp4').absolute ? ` · ${local('media/video.mp4', 'Full video')} · ${local('media/media.json', 'Source manifest')}` : ''}</p>` : ''}
<h2>Coverage</h2>${pretty(session.coverage || { coverage: 'Not recorded' })}
<p>${local('actions.jsonl', 'Actions and request metadata')} · ${local('session.json', 'Session')} · ${local('ledger.json', 'Ledger')}</p>
<h2>Physical native capture and CSS viewport</h2><p>Native window bounds are in display points; saved PNG dimensions are pixels. Supplied CSS viewport dimensions describe browser layout and may exceed the physical window. They do not prove full-viewport native capture. Text and PNG are separate observations, not an atomic snapshot. Missing geometry is unverified.</p>
<table><tr><th>Checkpoint</th><th>Physical native window</th><th>Saved image</th><th>Browser viewport / provenance</th></tr>${[...checkpoints.values()].filter((e) => e.ev === 'checkpoint').map((e) => `<tr>${rows([esc(q(e.evidenceId)), esc(e.bounds?.target ? `${e.bounds.target.width} × ${e.bounds.target.height} points; ${JSON.stringify(e.bounds)}` : 'Not recorded'), esc(e.width && e.height ? `${e.width} × ${e.height} pixels` : 'Not recorded'), esc(e.context?.viewport ? `${e.context.viewport.width} × ${e.context.viewport.height} CSS pixels / ${e.contextSource || 'unverified'}` : 'Not recorded')])}</tr>`).join('')}</table>
${tabObservations.length || actions.some((e) => e.ev === 'tab-binding') ? `<h2>Selected-tab extension evidence</h2><p>Collection is limited to the explicitly selected tab's visible text and clicks. Form values and marked private regions are excluded by the observer. No complete DOM, console, network or iframe coverage is established. The selected browser tab and native video window have not been automatically mapped to each other.</p><table><tr><th>Observed / tab</th><th>Kind / target</th><th>Context</th><th>Evidence</th></tr>${tabObservations.map((e) => `<tr>${rows([esc(`${timestamp(e.observedAt)} / ${e.tabId}`), esc(e.kind === 'click' ? `click ${e.element?.name || e.element?.tag || ''}` : `visible text${e.truncated ? ' (truncated)' : ''}`), esc(JSON.stringify(e.context)), e.evidenceId ? refs([e.evidenceId]) : esc(JSON.stringify(e.point || {}))])}</tr>`).join('')}</table><p>Selection lifecycle: ${actions.filter((e) => e.ev === 'tab-binding').map((e) => esc(`${e.phase} tab ${e.tabId}${e.reason ? `: ${e.reason}` : ''}`)).join(' · ')}</p>` : ''}
<h2>Steps</h2><table><tr><th>Step / persona</th><th>Last state / timing source</th><th>First feedback ms</th><th>Ready ms</th><th>Observation</th><th>Native action coverage</th></tr>${[...steps.values()].map((s) => `<tr>${rows([esc(`${q(s.stepId)}: ${s.name} / ${s.persona || ''}`), esc(`${s.phase} / ${s.timingSource || 'recorder-clock'}`), esc(s.firstFeedbackMs ?? 'Not recorded'), esc(s.readyMs ?? 'Not recorded'), esc(s.text || ''), esc(stepCoverage(s))])}</tr>`).join('')}</table><details><summary>Raw step phases and timing provenance</summary>${actions.filter((e) => e.ev === 'step').map(pretty).join('')}</details>
<h2>Checkpoints</h2>${[...checkpoints.values()].map((e) => `<p>${esc(q(e.evidenceId))} · ${esc(timestamp(e.capturedAt ?? e.observedAt))} · ${esc(e.stepId ? q(e.stepId) : '')} · ${esc(e.persona || '')}<br>${refs([e.evidenceId])}<br>Context: ${esc(JSON.stringify(e.context))}; context ${esc(e.contextSource)}, text ${esc(e.textSource)}${e.textObservedAt != null ? `, observed ${esc(timestamp(e.textObservedAt))}` : ', observation time unavailable'}. Text and PNG are separate observations, not an atomic snapshot.</p>`).join('')}
<h2>Network completion metadata</h2><p>All captured completion records are listed. Explicit wait_ms requests are labeled intentional long polls. Passive recording does not collect requests automatically.</p><table><tr><th>ID / step / source</th><th>Method / URL path</th><th>Status / failure</th><th>Duration ms</th><th>Long poll</th></tr>${actions.filter((e) => e.ev === 'network').map((e) => `<tr>${rows([esc(`${q(e.requestId)} / ${e.stepId ? q(e.stepId) : ''} / ${e.source}`), esc(`${e.method} ${e.url}${e.pagination ? ` ${JSON.stringify(e.pagination)}` : ''}`), esc(e.failure || e.status), esc(e.durationMs), esc(e.intentionalLongPoll ? `yes, wait_ms=${e.waitMs}` : 'no')])}</tr>`).join('')}</table>
<h2>Console, observations and native capture diagnostics</h2>${actions.filter((e) => ['console', 'pageerror', 'observation', 'evidence-error', 'capture-error', 'capture-boundary'].includes(e.ev)).map(pretty).join('')}`;
}
export function writeReport(dir) {
  // Relative hrefs must use the physical file location, even when Finder opens another directory alias.
  dir = fs.realpathSync(path.resolve(dir));
  const { sources, manifest } = loadReport(dir), topic = manifest?.topic || sources[0].session.topic || 'Walk';
  const findings = [...sources.flatMap((s) => s.findings), ...(manifest?.findings || []).map((f) => ({ ...f, source: { id: 'report', ledger: {} } }))];
  const verdictOrder = { fail: 0, 'not-tested': 1, pass: 2 };
  const severity = (f) => Number(/^P([0-4])/i.exec(f.severity || f.priority || '')?.[1] ?? 9);
  findings.sort((a, b) => ((verdictOrder[a.verdict] ?? 1) - (verdictOrder[b.verdict] ?? 1)) || severity(a) - severity(b) || qualified(a.source, a.id).localeCompare(qualified(b.source, b.id)));
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(topic)} — evidence</title>
<style>body{font:14px system-ui;margin:32px;max-width:1400px;color:#18232f}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccd2d8;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f4f7}pre{white-space:pre-wrap;overflow-wrap:anywhere}.capture-warning{border:2px solid #a12727;background:#fff1f1;padding:16px;margin:16px 0}.missing{color:#9f2222}a{color:#1559a5}</style>
<h1>${esc(topic)} — evidence report</h1><p>Rebuilt from saved records; source sessions are unchanged.</p>
${sources.map(captureWarning).join('')}
<aside><strong>Physical capture differs from CSS layout.</strong> Native bounds are display points and PNG dimensions are pixels; supplied CSS viewport dimensions may exceed the recorded physical window. Full CSS viewport coverage is unverified. See each session's geometry table below.</aside>
${segmentSummary(sources, manifest, dir)}
<h2>Findings</h2><table><tr><th>Finding</th><th>Verdict / severity / persona</th><th>Expected</th><th>Observed</th><th>Evidence / refs</th></tr>${findings.map((f) => `<tr>${rows([esc(`${qualified(f.source, f.id)}: ${f.title}`), esc(`${f.verdict || 'not-tested'} / ${f.severity || f.priority || ''} / ${f.persona || ''}`), esc(f.expected || ''), esc(f.observed || f.said || ''), evidence(f.evidence || [], f.source, sources, dir) + (f.source.ledger[f.key] || f.source.ledger[f.id] || []).map((l) => `<p>${esc(l.ref)} ${esc(l.note || '')}</p>`).join('')])}</tr>`).join('')}</table>
${sources.map((s) => renderSource(s, sources, dir)).join('')}
</html>`;
  const out = path.join(dir, 'report.html'); fs.writeFileSync(out, html); return out;
}
