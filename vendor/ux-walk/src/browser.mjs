import { watchNetwork, safeUrl } from './network.mjs';
// Headed Chrome through Playwright: a timestamped log of the user's clicks, keys, navigation,
// network writes and errors, plus an optional Playwright trace cut into one chunk per chapter.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './config.mjs';

const { chromium } = createRequire(ROOT + '/package.json')('playwright-core');

// Bodies of failed requests, for an agent to tell a real conflict from a stale call. Emails and
// secret-looking keys are redacted (a response's "code" is the error code, so it is kept there).
const EMAIL = /[^\s@"'<>,;:()=&]+@[^\s@"'<>,;:()]+\.[a-z]{2,}/gi;
export function redactBody(body, keys = /pass|token|secret|otp|code|key/i) {
  if (body == null || body === '') return undefined;
  let s = String(body);
  try {
    const walk = (v, k) => (k && keys.test(k) ? '[redacted]' : Array.isArray(v) ? v.map((x) => walk(x))
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]))
        : typeof v === 'string' ? v.replace(EMAIL, '[email]') : v);
    s = JSON.stringify(walk(JSON.parse(s)));
  } catch {
    s = s.replace(EMAIL, '[email]').replace(new RegExp(`((?:${keys.source})[\\w-]*=)[^&\\s]*`, 'gi'), '$1[redacted]');
  }
  return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
}
const RES_KEYS = /pass|token|secret|otp|key/i;

// Runs inside every page. Describes an element by what a person sees, not by its test id alone.
// config genericTestids: a list or "a,b".
export const genericList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);

export function pageHooks(opts = {}) {
  let host = null; // the annotate overlay's shadow host; never described, logged or counted
  const clean = (s, n = 100) => (s || '').trim().replace(/\s+/g, ' ').slice(0, n);
  // Wrapper test ids that name no feature (config genericTestids): skipped for the next one that does.
  const GENERIC = new Set(Array.isArray(opts.genericTestids) ? opts.genericTestids : []);
  const generic = (n) => GENERIC.has(n.getAttribute('data-testid'));
  const tidUp = (n) => { let a = n?.closest?.('[data-testid]'); while (a && generic(a)) a = a.parentElement?.closest('[data-testid]'); return a || null; };
  const INTERACTIVE = 'button,a,[role=button],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch],[role=gridcell],[role=link],input,select,textarea,label,summary';
  const desc = (el) => {
    if (!el || !el.closest || el === host) return null;
    const hit = el.closest(INTERACTIVE);
    // Not a control (a cell, chip, plain text): name what was under the pointer, not its wrapper.
    const t = hit || el;
    const isField = t.matches('input,textarea,select');
    let label = '';
    if (isField) {
      const byFor = t.id && document.querySelector(`label[for="${CSS.escape(t.id)}"]`);
      label = clean(byFor?.innerText || t.closest('label')?.innerText || t.getAttribute('aria-label') || t.placeholder || '', 60);
    }
    // The nearest test ids above the element: the component and the panel it sits in.
    // A generic wrapper is passed over; a click on the wrapper itself names the first real id inside it.
    const own = tidUp(t) || (t.matches('[data-testid]') && generic(t) ? [...t.querySelectorAll('[data-testid]')].find((n) => !generic(n)) : null);
    const panel = tidUp(own?.parentElement);
    const text = isField ? undefined : clean(t.innerText, hit ? 100 : 60);
    // A click on the empty part of a container reads as all its text ("Intern 1 Open Intern 2 Open ...").
    const area = !hit && !isField && clean(t.innerText, 400).length > 50;
    // Where it sits: the nearest labelled ancestor, and the row's first cell in a table or grid.
    let ctx;
    for (let a = t.parentElement, i = 0; a && i < 6 && !ctx; a = a.parentElement, i++) ctx = a.getAttribute('aria-label') || a.getAttribute('title') || undefined;
    const rowEl = t.closest('[role=row],tr');
    const first = rowEl && rowEl.querySelector('[role=rowheader],th,[role=gridcell],td');
    const row = first && !first.contains(t) ? clean(first.innerText, 40) : undefined;
    const on = ['aria-checked', 'aria-pressed', 'aria-selected'].some((k) => t.getAttribute(k) === 'true');
    return {
      tag: t.tagName?.toLowerCase(),
      role: t.getAttribute('role'),
      control: !!hit,
      testid: own?.getAttribute('data-testid') || null,
      region: panel?.getAttribute('data-testid') || undefined,
      aria: t.getAttribute('aria-label') || own?.getAttribute('aria-label') || null,
      title: t.getAttribute('title'),
      name: t.getAttribute('name'),
      type: isField ? t.type : undefined,
      label: label || undefined,
      // Never the value of a field; that is logged on change, redacted when secret.
      text: area ? undefined : text,
      area: area || undefined,
      ctx: clean(ctx, 60) || undefined,
      row: row || undefined,
      on: on || undefined,
      editable: isField || t.isContentEditable || undefined,
    };
  };
  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  const secret = (el) => el && (el.type === 'password' || /otp|code|token|secret|pass/i.test(`${el.autocomplete || ''} ${el.name || ''} ${el.id || ''}`));
  const send = (o) => { try { window.__uxw({ url: location.pathname + location.search, ...o }); } catch {} };
  // ---- Annotate: Option+Shift+click pins an element, Option+Shift+drag boxes an area; each becomes a numbered
  // note. All overlay UI lives in one shadow root. Its events are stopped at the window (capture,
  // registered before the app's listeners) and handled here, so the app never sees a key typed in a note.
  const isTop = window === window.top;
  const editable = (t) => !!t && (t.matches?.('input,textarea,select') || t.isContentEditable);
  const pickTarget = (el) => (el && el.closest ? el.closest(INTERACTIVE) || el : null);
  const pageAt = (x, y) => document.elementsFromPoint(x, y).find((n) => n !== host) || document.body;
  const labelOf = (el) => { const d = desc(el); return d ? d.testid || d.aria || d.text?.slice(0, 40) || d.label || d.tag : ''; };
  const STYLE = `:host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif}
.ol,.band,.nbox,.ring{position:fixed;pointer-events:none;border-radius:4px;display:none}
.ol{border:2px solid #4f46e5;background:rgba(79,70,229,.06)}
.ol span{position:absolute;left:-2px;top:-21px;background:#4f46e5;color:#fff;font-size:11px;line-height:15px;padding:2px 6px;border-radius:4px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
.ol.below span{top:auto;bottom:-21px}
.band,.nbox{border:1.5px dashed #4f46e5;background:rgba(79,70,229,.07)}.nbox{background:none;display:block;transition:opacity .4s}
.ring{border:1.5px solid rgba(79,70,229,.5)}
.badge{position:fixed;pointer-events:auto;cursor:pointer;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#4f46e5;color:#fff;font-size:11px;font-weight:600;line-height:20px;text-align:center;box-shadow:0 1px 3px rgba(15,23,42,.3);transition:opacity .4s}
.faded{opacity:.6}
.card{position:fixed;width:300px;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.14),0 1px 3px rgba(15,23,42,.08);padding:10px 12px;pointer-events:auto}
.hd{font-size:11px;color:#64748b;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hd b{color:#4f46e5;font-weight:600;margin-right:4px}
input{width:100%;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;font-size:13px;color:#0f172a;outline:none;background:#fff}
input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.15)}input::placeholder{color:#94a3b8}
.lnk{color:#4f46e5;cursor:pointer}
.clear{position:fixed;right:16px;bottom:16px;font-size:11px;display:none;pointer-events:auto;background:rgba(255,255,255,.9);padding:1px 6px;border-radius:4px;opacity:.75}
.nbox.edit{pointer-events:auto;cursor:move;border-style:solid;opacity:1}
.mv .nbox{pointer-events:auto;cursor:move}.mv .nbox .hdl{display:block}.mv .badge{cursor:grab}
.hdl{position:absolute;width:10px;height:10px;background:#fff;border:1.5px solid #4f46e5;border-radius:2px;display:none}
.nbox.edit .hdl{display:block}.hdl.nw{left:-6px;top:-6px;cursor:nwse-resize}.hdl.ne{right:-6px;top:-6px;cursor:nesw-resize}
.hdl.sw{left:-6px;bottom:-6px;cursor:nesw-resize}.hdl.se{right:-6px;bottom:-6px;cursor:nwse-resize}
.tip{font-size:11px;color:#94a3b8;margin-top:6px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(15,23,42,.92);color:#fff;font-size:13px;font-weight:500;line-height:1.4;padding:8px 14px;border-radius:8px;pointer-events:none}
.shot .card{opacity:0!important}.shot .ol,.shot .band,.shot .clear,.shot .toast,.shot .hdl{display:none!important}`;
  let wrap, outline, outlineLabel, band, clearLink;
  const mk = (tag, cls, text, act) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    if (act) n.dataset.act = act;
    return n;
  };
  const ensureHost = () => {
    if (!isTop || !document.documentElement) return null;
    if (host) { if (!host.isConnected) document.documentElement.appendChild(host); return host; }
    host = document.createElement('uxw-overlay');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;display:block';
    const root = host.attachShadow({ mode: 'open' });
    try { const sh = new CSSStyleSheet(); sh.replaceSync(STYLE); root.adoptedStyleSheets = [sh]; } catch { root.appendChild(mk('style', '', STYLE)); }
    wrap = mk('div');
    outline = mk('div', 'ol'); outlineLabel = mk('span'); outline.append(outlineLabel);
    band = mk('div', 'band');
    clearLink = mk('div', 'clear lnk', 'Clear pins', 'clear');
    clearLink.title = 'Remove the numbers from this page (the notes stay saved)';
    wrap.append(outline, band, clearLink);
    root.append(wrap);
    document.documentElement.appendChild(host);
    return host;
  };
  const toast = (msg) => {
    if (!msg || !ensureHost()) return;
    for (const old of wrap.querySelectorAll('.toast')) old.remove();
    const d = mk('div', 'toast', msg);
    wrap.append(d);
    setTimeout(() => d.remove(), 1600);
  };
  const place = (n, r) => Object.assign(n.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, display: 'block' });
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  // No mode: only a gesture made while Option+Shift is held annotates. altHeld (the outline) and gest
  // (a press that started with Option+Shift) are reset on blur, on a hidden tab and by any pointer
  // event without the keys, so a missed keyup can never leave the page swallowing clicks.
  let altHeld = false, ptr = { x: -1, y: -1 }, gest = null, swallowUntil = 0, boxDrag = null;
  const notes = []; // { id, mode, el, off, path, at, text, saved, badge, frame }
  let card = null; // { note, node, input, edit, orig, timer }
  function createNoteProducer() {
    const pending = new Set();
    let frozen = false, failure = null;
    return {
      frozen: () => frozen,
      track(promise) {
        const task = Promise.resolve(promise).then((value) => {
          if (value === false) throw new Error('Browser note did not acknowledge its send');
          return value;
        });
        pending.add(task);
        task.then(() => pending.delete(task), (error) => { failure ??= error; pending.delete(task); });
        return task;
      },
      async freeze() {
        frozen = true;
        const prefix = [...pending];
        await Promise.all(prefix);
        if (failure) throw failure;
        return true;
      },
      resume() { frozen = false; failure = null; return true; },
    };
  }
  const noteProducer = createNoteProducer();
  const sendNote = (payload) => {
    const task = noteProducer.track(Promise.resolve().then(() => {
      if (typeof window.__uxwNote !== 'function') throw new Error('Browser note binding is unavailable');
      return window.__uxwNote(payload);
    }));
    task.catch(() => {});
    return task;
  };
  window.__uxwFreezeNotes = () => noteProducer.freeze();
  window.__uxwResumeNotes = () => noteProducer.resume();

  // Option+Shift, not Option alone: onCall (and other apps) use Option+click themselves.
  const chord = (e) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
  const showOutline = () => {
    if (!outline) return;
    // While the keys are held, saved pins and boxes can be dragged (see startBox).
    wrap.classList.toggle('mv', altHeld && !gest);
    if (!altHeld || gest || boxDrag || ptr.x < 0) { outline.style.display = 'none'; return; }
    const t = pickTarget(pageAt(ptr.x, ptr.y));
    if (!t || t === document.body || t === document.documentElement) { outline.style.display = 'none'; return; }
    const r = rectOf(t);
    // A whole panel is not a pick; still pinnable, but an outline round the page is noise.
    if (r.w * r.h > innerWidth * innerHeight * 0.5) { outline.style.display = 'none'; return; }
    place(outline, r);
    outline.classList.toggle('below', r.y < 24);
    outlineLabel.textContent = labelOf(t);
  };
  const insideBox = (b) => {
    const out = [];
    for (const n of document.querySelectorAll('[data-testid]')) {
      if (generic(n)) continue;
      const q = n.getBoundingClientRect();
      if (!q.width || !q.height || q.left < b.x - 4 || q.top < b.y - 4 || q.right > b.x + b.w + 4 || q.bottom > b.y + b.h + 4) continue;
      if (n.checkVisibility && !n.checkVisibility()) continue;
      out.push({ testid: n.getAttribute('data-testid'), text: clean(n.innerText, 60) || undefined });
      if (out.length >= 15) break;
    }
    return out;
  };
  let raf = 0;
  const tick = () => {
    if (notes.some((n) => n.path !== location.pathname)) { if (card) saveCard(); clearPins(); }
    for (const n of notes) {
      const r = n.el.isConnected ? rectOf(n.el) : null;
      if (!r || (!r.w && !r.h)) { n.badge.style.display = 'none'; if (n.frame) n.frame.style.display = 'none'; continue; }
      const b = n.mode === 'box' ? { x: r.x + n.off.dx, y: r.y + n.off.dy, w: n.off.w, h: n.off.h } : r;
      n.rect = b;
      const open = card?.note === n || shooting === n;
      if (n.frame) { if (n.mode === 'box' || open) place(n.frame, b); else n.frame.style.display = 'none'; }
      // A pin sits where the pointer was (a wide paragraph's corner can be far from the word meant).
      const bx = n.mode === 'box' ? b.x - 10 : r.x + n.off.px - 10, by = n.mode === 'box' ? b.y - 10 : r.y + n.off.py - 24;
      Object.assign(n.badge.style, { left: `${Math.max(2, Math.min(innerWidth - 24, bx))}px`, top: `${Math.max(2, Math.min(innerHeight - 24, by))}px`, display: 'block' });
      const faded = !open && Date.now() - n.at > 4000;
      n.badge.classList.toggle('faded', faded);
      n.frame?.classList.toggle('faded', faded);
    }
    if (card?.note.rect) {
      const b = card.note.rect, w = 300, h = card.node.offsetHeight || 64;
      let x = b.x + b.w + 12;
      if (x + w > innerWidth - 8) x = b.x - w - 12;
      if (x < 8) x = Math.max(8, Math.min(innerWidth - w - 8, b.x));
      let y = x === b.x ? b.y + b.h + 12 : b.y;
      if (y + h > innerHeight - 8) y = Math.max(8, b.y - h - 12);
      Object.assign(card.node.style, { left: `${x}px`, top: `${Math.max(8, y)}px` });
    }
    if (clearLink) clearLink.style.display = notes.length ? 'block' : 'none';
  };
  const loop = () => {
    if (raf) return;
    const step = () => { raf = 0; tick(); if (notes.length || card) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  };
  const clearPins = () => {
    if (card) saveCard();
    for (const n of notes.splice(0)) { n.badge.remove(); n.frame?.remove(); }
    if (clearLink) clearLink.style.display = 'none';
  };
  const arm = () => { const c = card; clearTimeout(c.timer); c.timer = setTimeout(() => { if (card === c) saveCard(); }, 10000); };
  const openCard = (note, edit) => {
    if (card) saveCard();
    const node = mk('div', 'card'), hd = mk('div', 'hd'), input = mk('input');
    note.num = mk('b', '', `#${note.id ?? '…'}`);
    note.hdText = document.createTextNode(note.mode === 'box' ? `box around ${note.label}` : note.label);
    hd.append(note.num, note.hdText);
    input.placeholder = 'Note, or just say it. Enter saves, Esc drops';
    input.value = note.text || '';
    node.append(hd, input);
    // A new box can be moved and resized while its card is open.
    const movable = note.mode === 'box' && !edit;
    if (movable) { node.append(mk('div', 'tip', 'Drag the box to move it, a corner to resize it')); note.frame.classList.add('edit'); }
    wrap.append(node);
    card = { note, node, input, edit, orig: note.text || '', timer: 0 };
    tick();
    input.focus({ preventScroll: true });
    arm();
    loop();
  };
  const closeCard = () => {
    const c = card; card = null; clearTimeout(c.timer); c.node.remove();
    if (boxDrag) endBox();
    c.note.frame?.classList.remove('edit');
    return c;
  };
  const saveCard = () => {
    if (noteProducer.frozen()) return;
    if (!card) return;
    const c = closeCard(), n = c.note, text = c.input.value.trim();
    n.text = text; n.at = Date.now();
    if (!c.edit) { n.saved = true; if (n.id) sendSave(n); else n.later = 'save'; }
    else if (text !== c.orig) { sendNote({ op: 'save', id: n.id, text, edit: true, url: location.pathname + location.search }); toast(`#${n.id} updated`); }
  };
  const dropCard = () => {
    if (noteProducer.frozen()) return;
    if (!card) return;
    const c = closeCard(), n = c.note;
    if (c.edit) return; // Esc on an edit keeps the note as it was
    notes.splice(notes.indexOf(n), 1); n.badge.remove(); n.frame?.remove();
    if (n.id) sendDrop(n); else n.later = 'drop';
  };
  const sendSave = (n) => { const sent = sendNote({ op: 'save', id: n.id, text: n.text }); toast(`#${n.id} saved${n.text ? '' : ' (voice note)'}`); return sent; };
  const sendDrop = (n) => { const sent = sendNote({ op: 'drop', id: n.id }); toast(`#${n.id} dropped`); return sent; };
  let shooting = null; // the note being screenshotted: its outline shows, its number is known
  const rnd = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
  // Moving or resizing a note: the pointer is captured by the box or pin, so the page sees none of it.
  // A new box can be dragged while its card is open; any saved pin or box with Option+Shift held.
  let dragClickUntil = 0;
  const startBox = (e, act) => {
    if (e.button !== 0) return;
    const t = e.composedPath()[0];
    const n = notes.find((x) => x.badge === t.closest('.badge') || (x.frame && x.frame === t.closest('.nbox')));
    if (!n || !n.rect) return;
    const fresh = card?.note === n && !card.edit && n.mode === 'box';
    if (!fresh && !chord(e)) return;
    if (card && card.note !== n) saveCard();
    const r = n.el.isConnected ? rectOf(n.el) : { x: 0, y: 0 };
    const h = act === 'pin' ? (n.mode === 'pin' ? 'pin' : 'move') : act === 'move' ? 'move' : act.slice(3);
    boxDrag = { n, h, x0: e.clientX, y0: e.clientY, r0: { ...n.rect }, p0: { x: r.x + n.off.px, y: r.y + n.off.py }, moved: false };
    try { (act === 'pin' ? n.badge : n.frame).setPointerCapture(e.pointerId); } catch {}
    showOutline();
  };
  const moveBox = (e) => {
    const d = boxDrag, n = d.n, dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    if (d.h === 'pin') {
      const r = n.el.isConnected ? rectOf(n.el) : { x: 0, y: 0 };
      Object.assign(n.off, { px: d.p0.x + dx - r.x, py: d.p0.y + dy - r.y });
      tick();
      return;
    }
    let { x, y, w, h } = d.r0;
    if (d.h === 'move') { x += dx; y += dy; }
    else {
      let x1 = x + w, y1 = y + h;
      if (d.h.includes('w')) x += dx; else x1 += dx;
      if (d.h.includes('n')) y += dy; else y1 += dy;
      [x, x1] = [Math.min(x, x1), Math.max(x, x1)]; [y, y1] = [Math.min(y, y1), Math.max(y, y1)];
      w = Math.max(8, x1 - x); h = Math.max(8, y1 - y);
    }
    const r = n.el.isConnected ? rectOf(n.el) : { x: 0, y: 0 };
    Object.assign(n.off, { dx: x - r.x, dy: y - r.y, w, h });
    tick();
  };
  // The drag ended: anchor the note to what is under its new spot (a pin's point, a box's middle), and
  // screenshot it again.
  function endBox() {
    if (noteProducer.frozen()) { boxDrag = null; return; }
    const d = boxDrag; boxDrag = null;
    swallowUntil = Date.now() + 400; // the click that ends the drag is not the page's
    if (!d?.moved) return;
    dragClickUntil = Date.now() + 400; // nor does it open the pin for editing
    const n = d.n, isPin = d.h === 'pin';
    tick();
    const r0 = n.el.isConnected ? rectOf(n.el) : { x: 0, y: 0 };
    const b = n.rect, at = isPin ? { x: r0.x + n.off.px, y: r0.y + n.off.py } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const el = isPin ? pickTarget(pageAt(at.x, at.y)) : pageAt(at.x, at.y);
    if (el) {
      const r = rectOf(el);
      n.el = el; n.label = labelOf(el);
      n.off = isPin ? { ...n.off, px: at.x - r.x, py: at.y - r.y, dx: 0, dy: 0, w: r.w, h: r.h } : { ...n.off, dx: b.x - r.x, dy: b.y - r.y, w: b.w, h: b.h };
      if (n.hdText) n.hdText.textContent = isPin ? n.label : `box around ${n.label}`;
    }
    n.at = Date.now();
    tick();
    const box = isPin ? rectOf(n.el) : n.rect;
    const payload = { op: 'reshoot', mode: n.mode, el: desc(n.el), box: rnd(box), inside: n.mode === 'box' ? insideBox(box) : undefined, vw: innerWidth, vh: innerHeight, url: location.pathname + location.search };
    if (n.id) { sendNote({ ...payload, id: n.id }); if (n.saved) toast(`#${n.id} moved`); } else n.reshoot = payload;
    if (card?.note === n) card.input.focus({ preventScroll: true });
  }
  const newNote = (mode, el, box, at) => {
    if (noteProducer.frozen() || !el || !window.__uxwNote) return;
    if (card) saveCard();
    const r = rectOf(el), rect = box || r;
    const px = at ? at.x - r.x : r.w - 10, py = at ? at.y - r.y : 10;
    const note = { mode, el, label: labelOf(el), off: { dx: rect.x - r.x, dy: rect.y - r.y, w: rect.w, h: rect.h, px, py }, path: location.pathname, at: Date.now(), text: '', saved: false };
    note.badge = mk('div', 'badge', '·', 'pin');
    note.badge.title = 'Click to edit this note';
    note.frame = mk('div', mode === 'box' ? 'nbox' : 'ring', '', mode === 'box' ? 'move' : undefined);
    if (mode === 'box') for (const c of ['nw', 'ne', 'sw', 'se']) note.frame.append(mk('div', `hdl ${c}`, '', `rs-${c}`));
    wrap.append(note.frame, note.badge);
    notes.push(note);
    tick(); loop();
    const payload = { op: 'new', mode, el: desc(el), box: rnd(rect), inside: mode === 'box' ? insideBox(rect) : undefined, vw: innerWidth, vh: innerHeight, url: location.pathname + location.search };
    shooting = note;
    const creating = sendNote(payload).then(async (id) => {
      if (shooting === note) shooting = null;
      if (!id) throw new Error('no id');
      note.id = id; note.badge.textContent = String(id); if (note.num) note.num.textContent = `#${id}`;
      // Moved, saved or dropped before the number came back.
      if (note.draft && note.later !== 'drop') await sendDraft(note, true);
      if (note.reshoot && note.later !== 'drop') await sendNote({ ...note.reshoot, id });
      note.reshoot = null;
      if (note.later === 'save') await sendSave(note); else if (note.later === 'drop') await sendDrop(note);
    });
    noteProducer.track(creating).catch(() => {
      if (shooting === note) shooting = null;
      if (card?.note === note) closeCard();
      const i = notes.indexOf(note); if (i >= 0) notes.splice(i, 1); note.badge.remove(); note.frame.remove();
    });
    // The card opens at once (hidden while the screenshots are taken) so typing never reaches the app.
    openCard(note, false);
  };
  // For the recorder: hide the card (pins stay) while it screenshots; flush a note left open.
  window.__uxwShot = (on, id) => { if (on && shooting && id) shooting.badge.textContent = String(id); wrap?.classList.toggle('shot', !!on); tick();
    // Keep typing in the open note (hiding can move focus).
    if (!on && card && host.shadowRoot.activeElement !== card.input) card.input.focus({ preventScroll: true }); };
  window.__uxwOpenNote = () => (card && !card.edit ? { id: card.note.id, text: card.input.value.trim() } : null);
  window.__uxwTakeOpenNote = (ids) => {
    if (!card || card.edit || !ids.includes(card.note.id)) return null;
    const current = closeCard(), note = current.note;
    note.text = current.input.value.trim(); note.saved = true;
    return { id: note.id, text: note.text };
  };
  window.__uxwFinishNotes = (accepted) => {
    if (!card || card.edit) return;
    const saved = accepted.find((note) => note.id === card.note.id);
    if (!saved) return;
    const current = closeCard();
    current.note.text = saved.text; current.note.saved = true;
  };
  const sendDraft = (note, continuation = false) => {
    if ((!noteProducer.frozen() || continuation) && note.id && note.draft) return sendNote({ op: 'draft', id: note.id, ...note.draft });
    return Promise.resolve();
  };
  const draftCard = () => {
    if (noteProducer.frozen() || !card || card.edit) return;
    card.note.draft = { text: card.input.value.trim().slice(0, 2000), t: Date.now() };
    sendDraft(card.note);
  };
  const onUi = (e) => {
    if (noteProducer.frozen()) return;
    const t = e.composedPath()[0], act = t?.closest?.('[data-act]')?.dataset.act;
    const inCard = card && card.node.contains(t);
    if (boxDrag && /^(pointermove|pointerup|pointercancel|lostpointercapture)$/.test(e.type)) {
      if (e.type === 'pointermove') moveBox(e); else endBox();
      return;
    }
    if (e.type === 'keydown' && inCard) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveCard(); }
      else if (e.key === 'Escape') { e.preventDefault(); dropCard(); }
      else arm();
    } else if (e.type === 'input' && inCard) { draftCard(); arm(); }
    else if (e.type === 'mousedown' && act) e.preventDefault(); // box, pin and link clicks keep the note's (or the app's) focus
    else if (e.type === 'pointerdown' && (act === 'move' || act === 'pin' || act?.startsWith('rs-'))) { e.preventDefault(); startBox(e, act); }
    else if (e.type === 'click') {
      if (act === 'clear') clearPins();
      else if (act === 'pin') {
        const n = notes.find((x) => x.badge === t.closest('.badge'));
        if (n && card?.note === n) card.input.focus();
        else if (n?.saved && Date.now() >= dragClickUntil) openCard(n, true);
      }
    }
  };
  // Recorder shortcuts while the page has focus: Option+Shift+N / M / P (Ctrl+Option+N / M / P work too).
  // By e.code: Option+Shift+letter types a special character on a Mac. The app never sees these keys.
  // Usually the recorder's system-wide hot keys (uxw-capture --hotkeys) take them first; this is the fallback.
  window.__uxwToast = (msg) => { if (isTop) toast(String(msg || '')); };
  const HOT = { KeyN: 'n', KeyM: 'm marker', KeyP: 'p' };
  const isHot = (e) => !!HOT[e.code] && !e.metaKey && e.altKey && (e.shiftKey !== e.ctrlKey);
  function hotkey(e) {
    if (!isHot(e)) return false;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'keydown' && !e.repeat) Promise.resolve(window.__uxwCmd?.(HOT[e.code])).then(toast).catch(() => {});
    return true;
  }
  for (const type of ['keydown', 'keypress', 'keyup']) addEventListener(type, (e) => { if (type === 'keydown' || isHot(e)) hotkey(e); }, true);
  if (isTop) {
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'paste', 'copy', 'cut', 'focusin', 'focusout',
      'pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'pointerover', 'pointerout', 'gotpointercapture', 'lostpointercapture', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu', 'selectstart', 'dragstart']) {
      // A drag that ends over a pin is still the page's gesture.
      addEventListener(type, (e) => { if (host && e.target === host && !(gest && /^(pointer|mouse|click)/.test(type))) { onUi(e); e.stopImmediatePropagation(); } }, true);
    }
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const cancelGesture = () => { gest = null; if (band) band.style.display = 'none'; };
    const reset = () => { altHeld = false; cancelGesture(); if (boxDrag) endBox(); showOutline(); };
    addEventListener('keydown', (e) => {
      if (e.key === 'Alt' || e.key === 'Shift') { altHeld = chord(e); if (altHeld) ensureHost(); showOutline(); return; }
      if (altHeld && (e.ctrlKey || e.metaKey)) { altHeld = false; showOutline(); }
      if (e.key !== 'Escape') return;
      // Esc cancels a box being drawn, or drops the open note when focus left its card; otherwise it is the app's.
      if (gest) { swallow(e); cancelGesture(); showOutline(); }
      else if (card && !card.edit) { swallow(e); dropCard(); }
    }, true);
    addEventListener('keyup', (e) => { if (e.key === 'Alt' || e.key === 'Shift') { altHeld = chord(e); showOutline(); } }, true);
    addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
    addEventListener('pointermove', (e) => {
      ptr = { x: e.clientX, y: e.clientY };
      altHeld = chord(e);
      if (boxDrag) { swallow(e); if (e.buttons & 1) moveBox(e); else endBox(); return; }
      if (gest) {
        swallow(e);
        // The button came up outside the window: no gesture is left holding the page.
        if (!(e.buttons & 1)) { cancelGesture(); showOutline(); return; }
        const w = Math.abs(e.clientX - gest.x), h = Math.abs(e.clientY - gest.y);
        if (w + h > 6) place(band, { x: Math.min(gest.x, e.clientX), y: Math.min(gest.y, e.clientY), w, h });
        return;
      }
      if (altHeld || outline?.style.display === 'block') showOutline();
    }, true);
    addEventListener('pointerdown', (e) => {
      swallowUntil = 0; // a new press is never the last gesture's click
      if (boxDrag) endBox();
      cancelGesture(); // a stale gesture never outlives a new press
      altHeld = chord(e);
      if (card) saveCard(); // clicking away from an open note keeps it
      if (e.button !== 0 || !chord(e) || !ensureHost()) { showOutline(); return; }
      swallow(e);
      gest = { x: e.clientX, y: e.clientY, el: pickTarget(e.target) };
      showOutline();
    }, true);
    addEventListener('pointerup', (e) => {
      if (boxDrag) { swallow(e); endBox(); return; }
      if (!gest) return;
      swallow(e);
      const g = gest; gest = null; swallowUntil = Date.now() + 400;
      band.style.display = 'none';
      const w = Math.abs(e.clientX - g.x), h = Math.abs(e.clientY - g.y);
      if (Math.hypot(w, h) > 6) {
        const box = { x: Math.min(g.x, e.clientX), y: Math.min(g.y, e.clientY), w, h };
        newNote('box', pageAt(box.x + box.w / 2, box.y + box.h / 2), box);
      } else newNote('pin', g.el, null, g);
      showOutline();
    }, true);
    addEventListener('pointercancel', () => { cancelGesture(); if (boxDrag) endBox(); }, true);
    // Option+click on a link downloads it and Shift/Option+drag selects text: the gesture's mouse events stop here.
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick']) {
      addEventListener(type, (e) => {
        if (gest || boxDrag || Date.now() < swallowUntil || (e.button === 0 && chord(e))) { swallow(e); if (type === 'click') swallowUntil = 0; }
      }, true);
    }
    for (const type of ['selectstart', 'dragstart']) addEventListener(type, (e) => { if (gest || boxDrag || altHeld) e.preventDefault(); }, true);
    addEventListener('DOMContentLoaded', () => ensureHost());
    setInterval(() => { if (host && !host.isConnected) ensureHost(); }, 1000);
  }
  // Dead clicks: a click after which nothing changed for 1 s (no DOM change, no request, no navigation).
  let mutations = 0;
  const ours = (r) => r.target === host || r.addedNodes[0] === host || r.removedNodes[0] === host;
  const watchDom = () => new MutationObserver((l) => { mutations += l.filter((r) => !ours(r)).length; })
    .observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  if (document.documentElement) watchDom(); else addEventListener('DOMContentLoaded', watchDom);
  // Count requests with an observer: the resource-timing buffer stops growing at 250 entries.
  let reqCount = 0;
  try { new PerformanceObserver((l) => { reqCount += l.getEntries().length; }).observe({ type: 'resource' }); } catch {}
  // A request counts when it STARTS (a slow save is not a dead click).
  try {
    const f = window.fetch;
    window.fetch = function (...a) { reqCount++; return f.apply(this, a); };
    const send0 = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) { reqCount++; return send0.apply(this, a); };
  } catch {}
  const requests = () => reqCount;
  let scrolls = 0;
  addEventListener('scroll', () => { scrolls++; }, true);
  // Long animation frames: what kept the page busy, to explain slow interactions.
  const loafs = [];
  try {
    new PerformanceObserver((l) => {
      for (const f of l.getEntries()) { if (f.blockingDuration > 0) loafs.push(f); }
      if (loafs.length > 50) loafs.splice(0, loafs.length - 50);
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {}
  const culprit = (start, end) => {
    const scripts = loafs.filter((f) => f.startTime < end && f.startTime + f.duration > start).flatMap((f) => [...(f.scripts || [])]);
    const top = scripts.sort((a, b) => b.duration - a.duration)[0];
    if (!top) return undefined;
    const file = (top.sourceURL || '').split('/').pop().split('?')[0];
    return `${top.sourceFunctionName || top.invoker || 'script'}${file ? ` in ${file}` : ''} ${Math.round(top.duration)} ms`;
  };
  addEventListener('click', (e) => {
    const el = desc(e.target);
    send({ ev: 'click', x: e.clientX, y: e.clientY, el });
    if (e.target.closest?.('input,textarea,select,label,[contenteditable]')) return; // focusing a field is not dead
    // Only things that look clickable (a control, or a pointer cursor), as Sentry does.
    let looks = el?.control, cursor = '';
    try { cursor = getComputedStyle(e.target).cursor; looks = looks || cursor === 'pointer'; } catch {}
    if (!looks) return;
    // Clicking an option that is already on, or a drag handle, is expected to do nothing.
    if (el?.on || /grab|move/.test(cursor) || /^(move|drag)\b/i.test(el?.aria || '')) return;
    const m0 = mutations, r0 = requests(), u0 = location.href, s0 = scrolls;
    setTimeout(() => {
      if (mutations === m0 && requests() === r0 && location.href === u0 && scrolls === s0) send({ ev: 'deadclick', x: e.clientX, y: e.clientY, el });
    }, 1000);
  }, true);
  // Selected text: people highlight what they are talking about.
  let selTimer;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = String(getSelection() || '').trim().replace(/\s+/g, ' ');
      const a = getSelection()?.anchorNode;
      const node = a && (a.nodeType === 1 ? a : a.parentElement);
      // Focusing or editing a field selects its text; that is not someone pointing at words.
      const act = document.activeElement;
      const editing = act && (act.matches('input,textarea,select') || act.isContentEditable) || node?.closest?.('[contenteditable]');
      if (sel.length >= 2 && !editing && !node?.matches?.('input,textarea')) send({ ev: 'select', text: sel.slice(0, 200), el: desc(node) });
    }, 700);
  });
  // Slow interactions (what the user felt): Event Timing entries of 200 ms or more.
  try {
    new PerformanceObserver((list) => {
      for (const en of list.getEntries()) {
        if (en.interactionId && en.duration >= 200) send({ ev: 'slow', id: en.interactionId, ms: Math.round(en.duration), name: en.name, el: desc(en.target), busy: culprit(en.startTime, en.startTime + en.duration) });
      }
    }).observe({ type: 'event', durationThreshold: 104 });
  } catch {}
  // Full page loads.
  addEventListener('load', () => setTimeout(() => {
    const n = performance.getEntriesByType('navigation')[0];
    if (n) send({ ev: 'load', ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) });
    send({ ev: 'env', viewport: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, ua: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || navigator.userAgent.slice(0, 60),
      lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    // Link the app's own session replay when it has one.
    try { const fs = window.FS?.getCurrentSessionURL?.(true); if (fs) send({ ev: 'replay', tool: 'FullStory', link: fs }); } catch {}
    try { const ph = window.posthog?.get_session_replay_url?.({ withTimestamp: true }); if (ph) send({ ev: 'replay', tool: 'PostHog', link: ph }); } catch {}
  }, 0));
  // Time away from the browser window.
  let awayAt = 0;
  addEventListener('blur', () => { awayAt = Date.now(); });
  addEventListener('focus', () => { if (awayAt && Date.now() - awayAt > 3000) send({ ev: 'away', s: Math.round((Date.now() - awayAt) / 1000) }); awayAt = 0; });
  addEventListener('paste', (e) => { const t = e.clipboardData?.getData('text') || ''; send({ ev: 'paste', len: t.length, el: desc(e.target) }); }, true);
  addEventListener('contextmenu', (e) => send({ ev: 'rightclick', el: desc(e.target) }), true);
  addEventListener('keydown', (e) => {
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    // Shift alone with a printable key is just a capital letter, not a shortcut.
    const mod = ['Meta', 'Control', 'Alt', 'Shift'].filter((m) => e.getModifierState(m) && !(m === 'Shift' && e.key.length === 1));
    if (secret(e.target)) return;
    if (mod.length || e.key.length > 1) send({ ev: 'key', key: [...mod, e.key].join('+'), el: desc(e.target) });
    // App shortcuts ("press P to pin"); never while typing into a field.
    else if (!editable(e.target) && !editable(document.activeElement)) send({ ev: 'key', key: e.key, el: desc(e.target), single: true });
  }, true);
  addEventListener('change', (e) => {
    const t = e.target;
    const v = t.type === 'checkbox' || t.type === 'radio' ? String(t.checked) : String(t.value ?? '');
    const email = t.type === 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
    // A select's value is often an id; the option text is what the person chose.
    const option = t.tagName === 'SELECT' && !secret(t) ? clean([...t.selectedOptions].map((o) => o.text).join(', '), 120) : '';
    send({ ev: 'change', el: desc(t), value: secret(t) ? '[redacted]' : email ? '[email]' : v.slice(0, 120), ...(option ? { option: isEmail(option) ? '[email]' : option } : {}) });
  }, true);
  // A custom combobox or menu pick sends no change event: log the chosen item as one.
  addEventListener('click', (e) => {
    const o = e.target.closest?.('[role=option],[role=menuitemradio]');
    if (!o || o.getAttribute('aria-selected') === 'true' || o.getAttribute('aria-checked') === 'true' || o.getAttribute('aria-disabled') === 'true') return;
    const list = o.closest('[role=listbox],[role=menu]');
    const id = list?.id && CSS.escape(list.id);
    const trig = (id && document.querySelector(`[aria-controls="${id}"],[aria-owns="${id}"]`)) || document.querySelector('[role=combobox][aria-expanded=true],[aria-haspopup][aria-expanded=true]');
    const text = clean(o.innerText, 120);
    if (text) send({ ev: 'change', el: desc(trig || list || o), value: isEmail(text) ? '[email]' : text, option: isEmail(text) ? '[email]' : text, combobox: true });
  }, true);
  // Hover dwell: the pointer resting on something is often what "this" means in the narration.
  const HOVERABLE = `${INTERACTIVE},[title],td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader],[data-testid*=chip],[class*=chip],[aria-describedby]`;
  const hov = { el: null, since: 0, timer: 0, last: null, lastAt: 0 };
  const endHover = () => { clearTimeout(hov.timer); hov.el = null; };
  addEventListener('pointermove', (e) => {
    if (gest || boxDrag || altHeld || e.target === host) { endHover(); return; }
    const h = e.target.closest?.(HOVERABLE) || null;
    if (h === hov.el) return;
    endHover();
    if (!h) return;
    Object.assign(hov, { el: h, since: Date.now() });
    hov.timer = setTimeout(() => {
      const now = Date.now();
      if (hov.el !== h || h === hov.last || now - hov.lastAt < 2000) return;
      Object.assign(hov, { last: h, lastAt: now });
      lastInput = now; // what appears now answers the hover, it is not the app speaking up
      const el = desc(h);
      send({ ev: 'hover', el, ms: now - hov.since });
      // The browser's own title bubble is not in the DOM; the attribute is what it shows.
      const title = clean(h.getAttribute('title') || h.closest('[title]')?.getAttribute('title'), 200);
      if (title) send({ ev: 'tooltip', text: title, el, native: true });
    }, 1200);
  }, true);
  for (const t of ['pointerdown', 'keydown', 'wheel']) addEventListener(t, endHover, true);
  addEventListener('DOMContentLoaded', () => document.documentElement.addEventListener('mouseleave', endHover));
  // What the page says on its own: new sentences (a banner, a toast, a result), dialogs opening and
  // closing, and the main heading changing. Checked once the DOM settles. Text that appears within
  // 1.5 s of a click or key is the answer to it (sinceInput); later text is the app speaking up.
  // A fresh page counts as input: what it renders while loading is the page, not a message.
  let lastInput = Date.now();
  // change: a pick in a native select menu sends no pointer event into the page.
  for (const t of ['pointerdown', 'keydown', 'change']) addEventListener(t, () => { lastInput = Date.now(); }, true);
  const LIVE = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[role=alertdialog]';
  const DIALOG = '[role=dialog],[role=alertdialog],dialog[open]';
  const sentences = () => {
    const out = new Set();
    for (const l of (document.body?.innerText || '').split('\n')) {
      const s = l.trim().replace(/\s+/g, ' ');
      if (s.length >= 12 && s.length <= 300 && (s.match(/ /g) || []).length >= 2) out.add(s);
    }
    return out;
  };
  let prevText = null, prevLive = new Map(), prevView = null, openDialogs = new Map(), prevTips = new Set(), prevCtx = null, prevCtxPath = null;
  const CTX = opts.contextSelectors && typeof opts.contextSelectors === 'object' ? opts.contextSelectors : {};
  const ctxValue = (el) => (el.tagName === 'SELECT' ? [...el.selectedOptions].map((o) => o.text).join(', ')
    : el.matches('input,textarea') ? (secret(el) ? '' : el.value) : el.innerText);
  const dialogTitle = (d) => {
    const by = d.getAttribute('aria-labelledby');
    const t = d.getAttribute('aria-label') || (by && document.getElementById(by)?.innerText) || d.querySelector('h1,h2,h3,[class*=title]')?.innerText || d.innerText;
    return clean(t, 80);
  };
  const checkPage = () => {
    if (!document.body) return;
    const since = lastInput ? Date.now() - lastInput : 99999;
    const first = prevText === null;
    // Tooltips: their own event, and their words are not the app speaking up.
    const tipLines = new Set(), tips = new Set();
    for (const n of document.querySelectorAll('[role=tooltip]')) {
      if (!n.getClientRects().length) continue;
      const box = n.closest('[data-radix-popper-content-wrapper]') || n;
      for (const l of (box.innerText || '').split('\n')) { const x = l.trim().replace(/\s+/g, ' '); if (x) tipLines.add(x); }
      const t = clean(n.innerText, 200);
      if (!t || tips.has(t)) continue;
      tips.add(t);
      if (!prevTips.has(t)) {
        const trig = (n.id && document.querySelector(`[aria-describedby~="${CSS.escape(n.id)}"]`)) || hov.el || hov.last;
        send({ ev: 'tooltip', text: t, el: desc(trig) });
      }
    }
    prevTips = tips;
    // Who and where: the program, the person being viewed as (config contextSelectors).
    if (Object.keys(CTX).length) {
      const items = {};
      for (const [k, css] of Object.entries(CTX)) {
        let el = null;
        try { el = document.querySelector(css); } catch {}
        const v = el && clean(ctxValue(el), 120);
        if (v) items[k] = v;
      }
      const key = JSON.stringify(items), moved = location.pathname !== prevCtxPath;
      if ((key !== prevCtx && !(prevCtx === null && key === '{}')) || (moved && key !== '{}')) send({ ev: 'context', items });
      prevCtx = key; prevCtxPath = location.pathname;
    }
    // Typing into editable text would log what was typed; skip while it has focus.
    if (!document.activeElement?.isContentEditable) {
      const cur = sentences();
      for (const x of tipLines) cur.delete(x);
      if (prevText) {
        const added = [...cur].filter((x) => !prevText.has(x));
        // Many new lines at once is a new view, not a message.
        if (added.length && added.length <= 4) send({ ev: 'text', lines: added.map((x) => x.slice(0, 200)), sinceInput: since });
      }
      prevText = cur;
    }
    const live = new Map();
    for (const el of document.querySelectorAll(LIVE)) {
      if (el.closest('[role=tooltip]')) continue;
      const t = clean(el.innerText, 200);
      if (t) live.set(el, t);
      // "Loading..." is not news. Text in a visually hidden region is for screen readers; say so.
      if (!first && t && t.length >= 2 && prevLive.get(el) !== t && !/^(loading|saving|working)\W*$/i.test(t)) {
        let hidden = false;
        try { const r = el.getBoundingClientRect(); hidden = r.width <= 1 || r.height <= 1; } catch {}
        send({ ev: 'text', lines: [t], live: true, sinceInput: since, ...(hidden ? { srOnly: true } : {}) });
      }
    }
    prevLive = live;
    const now = new Map();
    for (const d of document.querySelectorAll(DIALOG)) {
      if (!d.getClientRects().length) continue;
      now.set(d, openDialogs.get(d) || dialogTitle(d));
      if (!openDialogs.has(d)) send({ ev: 'dialog', open: true, title: now.get(d) });
    }
    for (const [d, title] of openDialogs) if (!now.has(d)) send({ ev: 'dialog', open: false, title });
    openDialogs = now;
    const h = document.querySelector('main h1') || document.querySelector('h1');
    const view = clean(h?.innerText || document.title, 80);
    if (view && view !== prevView) { if (prevView != null) send({ ev: 'view', text: view }); prevView = view; }
  };
  let checkTimer, firstChange = 0;
  const scheduleCheck = () => {
    // Settle for 600 ms, but never wait more than 2 s while the page keeps changing.
    const now = Date.now();
    if (!firstChange) firstChange = now;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => { firstChange = 0; try { checkPage(); } catch {} }, now - firstChange > 2000 ? 0 : 600);
  };
  // Attributes too: dialogs and banners are often shown by a class or style change.
  const watchText = () => new MutationObserver((l) => { if (l.some((r) => !ours(r))) scheduleCheck(); }).observe(document.documentElement,
    { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'] });
  if (document.documentElement) watchText(); else addEventListener('DOMContentLoaded', watchText);
  // A baseline once the page has loaded, so the first message after it counts.
  addEventListener('DOMContentLoaded', () => setTimeout(scheduleCheck, 300));
  addEventListener('change', () => scheduleCheck(), true);
  addEventListener('dragstart', (e) => send({ ev: 'dragstart', el: desc(e.target) }), true);
  addEventListener('drop', (e) => send({ ev: 'drop', el: desc(e.target) }), true);
}

export async function openBrowser({ url, metadataOnly = false, networkContext, authFile, windowSize, trace, ignoreWrites, write, onCommand, snapshotDir, notesDir, contextSelectors, genericTestids, canCapturePage }) {
  const browser = await chromium.launch({
    channel: 'chrome', headless: false, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    args: [`--window-size=${windowSize}`],
  });
  const context = await browser.newContext({
    viewport: null, // the page follows the window size
    storageState: fs.existsSync(authFile) && fs.statSync(authFile).size ? authFile : undefined,
  });
  if (trace) await context.tracing.start({ screenshots: false, snapshots: true, title: 'ux-walk' });
  await context.exposeBinding('__uxw', ({ page }, o) => write(o, page));
  await context.exposeBinding('__uxwCmd', async (_src, cmd) => (onCommand ? onCommand(String(cmd)) : ''));
  // Annotations: the page asks for a number and screenshots at the gesture, then saves the text. A box
  // moved or resized while its card is open is screenshotted again ("reshoot") with its final box.
  // Calls run one at a time, so a save never lands before the reshoot sent ahead of it.
  let noteN = 0;
  const pending = new Map(); // id -> the note event, waiting for its text
  const rel = (f) => `${path.basename(notesDir())}/${path.basename(f)}`;
  const saveNote = async (id, text, writeNote = write) => {
    const note = pending.get(id);
    if (!note) return false;
    const { page, drafts: _drafts, ...event } = note;
    if (await writeNote({ ...event, text: String(text ?? '').slice(0, 2000) }, page) === false) return false;
    if (pending.get(id) === note) pending.delete(id);
    return true;
  };
  const shoot = async (p, id, o) => {
    if (canCapturePage && !(await canCapturePage(p))) throw new Error('This page is outside the recorded browser window');
    const nn = String(id).padStart(2, '0'), dir = notesDir();
    fs.mkdirSync(dir, { recursive: true });
    const shot = path.join(dir, `${nn}.png`), full = path.join(dir, `${nn}-full.png`);
    const b = o.box || { x: 0, y: 0, w: 1, h: 1 }, vw = o.vw || 1440, vh = o.vh || 900;
    const x0 = Math.max(0, b.x - 48), y0 = Math.max(0, b.y - 48);
    const clip = { x: x0, y: y0, width: Math.max(1, Math.min(vw, b.x + b.w + 48) - x0), height: Math.max(1, Math.min(vh, b.y + b.h + 48) - y0) };
    await p.evaluate((n) => window.__uxwShot?.(true, n), id).catch(() => {});
    try {
      await p.screenshot({ path: shot, clip, timeout: 5000 }).catch(() => {});
      if (!canCapturePage || await canCapturePage(p)) await p.screenshot({ path: full, timeout: 5000 }).catch(() => {});
    } finally { await p.evaluate(() => window.__uxwShot?.(false)).catch(() => {}); }
    return { b, ...(fs.existsSync(shot) ? { shot: rel(shot) } : {}), ...(fs.existsSync(full) ? { full: rel(full) } : {}) };
  };
  const noteOp = async (p, o) => {
    if (!notesDir || !o) return null;
    if (o.op === 'new') {
      const id = ++noteN, t = Date.now();
      const { b, ...files } = await shoot(p, id, o);
      pending.set(id, { page: p, t, url: o.url, ev: 'note', id, mode: o.mode === 'box' ? 'box' : 'pin', text: '', el: o.el, box: b,
        ...(o.mode === 'box' ? { inside: (o.inside || []).slice(0, 15) } : {}), ...files });
      return id;
    }
    const id = Number(o.id);
    if (o.op === 'draft' && !pending.has(id)) return false;
    if (pending.has(id) && pending.get(id).page !== p) throw new Error('This annotation belongs to another page');
    if (o.op === 'draft' && pending.has(id)) {
      const note = pending.get(id);
      if (!Number.isSafeInteger(o.t) || o.t < 0 || o.t > Date.now()) throw new Error('Invalid annotation draft time');
      const drafts = note.drafts ??= [];
      const draftAt = Math.max(note.t, o.t);
      if (!drafts.length || draftAt >= drafts.at(-1).t) {
        if (drafts.at(-1)?.t === draftAt) drafts.pop();
        drafts.push({ text: String(o.text ?? '').slice(0, 2000), t: draftAt });
      }
    } else if (o.op === 'reshoot' && pending.has(id)) {
      const { b, ...files } = await shoot(p, id, o);
      Object.assign(pending.get(id), { el: o.el, box: b, inside: (o.inside || []).slice(0, 15), moved: true, ...files });
    } else if (o.op === 'reshoot' && id > 0 && id <= noteN) {
      // A saved note moved afterwards: same files, retaken; the timeline row takes the new target.
      const { b, ...files } = await shoot(p, id, o);
      return write({ ev: 'note', id, edit: true, moved: true, mode: o.mode === 'box' ? 'box' : 'pin', el: o.el, box: b, ...(o.mode === 'box' ? { inside: (o.inside || []).slice(0, 15) } : {}), ...files, url: o.url }, p);
    } else if (o.op === 'save') {
      if (pending.has(id)) return saveNote(id, o.text);
      else if (o.edit && id > 0 && id <= noteN) return write({ ev: 'note', id, edit: true, text: String(o.text ?? '').slice(0, 2000), url: o.url }, p);
    } else if (o.op === 'drop' && pending.has(id)) {
      const n = pending.get(id);
      pending.delete(id);
      for (const f of [n.shot, n.full]) if (f) fs.rmSync(path.join(path.dirname(notesDir()), f), { force: true });
      if (id === noteN) noteN--;
    }
    return null;
  };
  let noteChain = Promise.resolve();
  await context.exposeBinding('__uxwNote', ({ page: p }, o) => {
    const draftGrant = o?.op === 'draft' && canCapturePage
      ? Promise.resolve(canCapturePage(p, { op: 'draft', receivedAt: Date.now() })).catch(() => false) : null;
    const run = noteChain.then(async () => {
      if (canCapturePage) {
        const permission = await (draftGrant ?? canCapturePage(p));
        if (!(typeof permission === 'function' ? permission() === true : permission)) throw new Error('This page is outside the recorded browser window');
      }
      return noteOp(p, o);
    });
    noteChain = run.catch(() => {});
    return run;
  });
  // A note left open when the page reloads or the walk ends is saved with what was typed (or as a voice note).
  const flushNotes = async (p) => {
    if (!pending.size) return;
    const open = p && !p.isClosed() ? await p.evaluate(() => window.__uxwOpenNote?.()).catch(() => null) : null;
    for (const id of [...pending.keys()]) if (open?.id !== id) await saveNote(id, '');
  };
  let ctxSel = contextSelectors;
  if (typeof ctxSel === 'string') { try { ctxSel = JSON.parse(ctxSel); } catch { ctxSel = undefined; } }
  await context.addInitScript(pageHooks, { contextSelectors: ctxSel && typeof ctxSel === 'object' ? ctxSel : {}, genericTestids: genericList(genericTestids) });

  const ignore = new RegExp(ignoreWrites, 'i');
  const answered = new WeakSet(); // a request can "fail" after its response arrived (body aborted)
  // The page's text as an accessibility tree (YAML), once the page settles after each navigation:
  // exact wording and numbers for an agent, without reading pixels.
  const snapshot = async (p, why) => {
    if (!snapshotDir || p.isClosed()) return;
    try {
      if (canCapturePage && !(await canCapturePage(p))) return;
      let yml = await p.locator('body').ariaSnapshot({ timeout: 3000 });
      if (yml.length > 60000) yml = yml.slice(0, 60000) + '\n# (cut at 60 KB)\n';
      if (canCapturePage && !(await canCapturePage(p))) return;
      const t = Date.now(), dir = snapshotDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = `${dir}/${t}.yml`;
      fs.writeFileSync(file, `# ${p.url()}\n${yml}\n`);
      write({ ev: 'snapshot', file, why }, p);
    } catch {}
  };
  const settle = new WeakMap();
  const watch = (p) => {
    watchNetwork(p, (event) => write(event, p), Date.now, networkContext);
    p.on('framenavigated', (f) => {
      if (f !== p.mainFrame()) return;
      write({ ev: 'nav', url: f.url() }, p);
      clearTimeout(settle.get(p));
      settle.set(p, setTimeout(() => { snapshot(p, 'nav'); flushNotes(p); }, 1500));
    });
    p.on('console', (m) => ['error', 'warning'].includes(m.type()) && write({ ev: 'console', level: m.type(), text: m.text().slice(0, 4000) }, p));
    p.on('pageerror', (e) => write({ ev: 'pageerror', text: (e.stack || String(e)).slice(0, 4000) }, p));
    p.on('response', async (r) => {
      const req = r.request(), m = req.method(), t = Date.now(), status = r.status();
      answered.add(req);
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(m);
      if (read ? status < 400 : ignore.test(r.url())) return;
      // Bodies only for failures: what was sent and what the server said back.
      let bodies = {};
      if (status >= 400 && !metadataOnly) {
        const res = await Promise.race([r.text(), new Promise((x) => setTimeout(() => x(null), 3000))]).catch(() => null);
        bodies = { reqBody: read ? undefined : redactBody(req.postData()), resBody: redactBody(res, RES_KEYS) };
      }
      if (read) { write({ t, ev: 'http', status, method: m, url: r.url().slice(0, 400), ...bodies }, p); return; }
      const action = req.headers()['next-action'];
      const ms = Math.round(req.timing().responseStart);
      write({ t, ev: 'write', status, method: m, url: r.url().slice(0, 400), ...(ms > 0 ? { ms } : {}), ...(action ? { serverAction: action.slice(0, 12) } : {}), ...bodies }, p);
    });
    p.on('requestfailed', (req) => {
      if (answered.has(req) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || ignore.test(req.url())) return;
      write({ ev: 'write', status: 0, method: req.method(), url: req.url().slice(0, 400), failure: req.failure()?.errorText, ...(!metadataOnly ? { reqBody: redactBody(req.postData()) } : {}) }, p);
    });
  };
  context.on('page', watch);
  const page = await context.newPage();
  write({ ev: 'start' });
  await page.goto(url).catch((e) => write({ ev: 'pageerror', text: String(e) }));

  const noteControl = async (method, { allowPage = () => true, timeoutMs = 1500 } = {}) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1500) throw new Error('Invalid browser note fence deadline');
    let timer, expired = false;
    const control = (async () => {
      let producers = 0;
      for (const page of context.pages()) {
        if (page.isClosed() || !(await allowPage(page))) continue;
        if (expired) throw new Error('Browser note fence deadline expired');
        const acknowledged = await page.evaluate(async (name) => {
          if (typeof window[name] !== 'function') throw new Error('Browser note producer is unavailable');
          return window[name]();
        }, method);
        if (expired || acknowledged !== true || !(await allowPage(page))) throw new Error('Browser note producer did not acknowledge its control request');
        producers++;
      }
      if (!producers) throw new Error('Owned browser note producer is unavailable');
      await noteChain;
      if (expired) throw new Error('Browser note fence deadline expired');
    })();
    try {
      await Promise.race([control, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Browser note producer acknowledgment timed out')); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  return {
    context,
    browser,
    prepareNotePause: (options) => noteControl('__uxwFreezeNotes', options),
    resumeNoteInput: (options) => noteControl('__uxwResumeNotes', options),
    async flushPendingNotes({ fromMs = 0, throughMs = Infinity, allowPage = () => true, writeNote = write } = {}) {
      await noteChain;
      const eligible = () => [...pending.entries()].filter(([, note]) => note.t >= fromMs && note.t <= throughMs);
      for (const page of new Set(eligible().map(([, note]) => note.page))) {
        if (page.isClosed() || !(await allowPage(page))) continue;
        const entries = eligible().filter(([, note]) => note.page === page);
        for (const [id, note] of entries) {
          if (pending.get(id) !== note || !(await allowPage(page))) continue;
          const accepted = { id, text: note.drafts?.findLast((draft) => draft.t <= throughMs)?.text ?? '' };
          if (await saveNote(id, accepted.text, writeNote)) await page.evaluate((notes) => window.__uxwFinishNotes?.(notes), [accepted]);
        }
      }
    },
    async checkpoint(file, crop) {
      const p = context.pages().at(-1);
      if (!p || p.isClosed()) throw new Error('no open page for checkpoint');
      const captureStartedAt = Date.now();
      await p.screenshot({ path: file, timeout: 10000 });
      const capturedAt = Date.now();
      if (crop) await p.screenshot({ path: crop.path, clip: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, timeout: 10000 });
      const text = await p.locator('body').innerText({ timeout: 3000 });
      const textObservedAt = Date.now();
      const context = await p.evaluate(() => ({ title: document.title, viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio }));
      return { captureStartedAt, capturedAt, textObservedAt, text, context: { ...context, url: safeUrl(p.url()) } };
    },
    snapshot: (why) => { const p = context.pages().at(-1); return p ? snapshot(p, why) : null; },
    // A short message at the bottom of the page (a recorder shortcut's reply).
    toast(msg) { const p = context.pages().at(-1); if (p && !p.isClosed()) p.evaluate((m) => window.__uxwToast?.(m), String(msg)).catch(() => {}); },
    // The Chrome main process is a direct child of this Node process (Playwright runs in-process).
    chromePid() {
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
      for (const l of out.split('\n')) {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (m && m[2] === String(process.pid) && /Chrome|Chromium/i.test(m[3])) return Number(m[1]);
      }
      return null;
    },
    async saveTraceChunk(file) {
      if (!trace) return;
      await context.tracing.stopChunk({ path: file }).catch((e) => console.error('trace save failed:', e.message));
    },
    async startTraceChunk() { if (trace) await context.tracing.startChunk().catch(() => {}); },
    async saveAuth() { await context.storageState({ path: authFile }).catch(() => {}); try { fs.chmodSync(authFile, 0o600); } catch {} },
    async close(lastTraceFile) {
      await flushNotes(context.pages().at(-1));
      write({ ev: 'end' });
      await this.saveAuth();
      if (trace) await context.tracing.stop(lastTraceFile ? { path: lastTraceFile } : undefined).catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
