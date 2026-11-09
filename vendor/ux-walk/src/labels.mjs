// How a click target is named, shared by the walk collector and the Worm feedback widget. The collector
// serializes this function's source into every page, so it must not reference anything outside its body.
export function elementLabels(opts = {}) {
  const clean = (s, n = 100) => (s || '').trim().replace(/\s+/g, ' ').slice(0, n);
  // Wrapper test ids that name no feature (config genericTestids): skipped for the next one that does.
  const GENERIC = new Set(Array.isArray(opts.genericTestids) ? opts.genericTestids : []);
  const generic = (n) => GENERIC.has(n.getAttribute('data-testid'));
  const tidUp = (n) => { let a = n?.closest?.('[data-testid]'); while (a && generic(a)) a = a.parentElement?.closest('[data-testid]'); return a || null; };
  const INTERACTIVE = 'button,a,[role=button],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch],[role=gridcell],[role=link],input,select,textarea,label,summary';
  // host: an overlay of our own that is never described.
  const desc = (el, host) => {
    if (!el || !el.closest || (host && el === host)) return null;
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
  return { INTERACTIVE, clean, desc, generic, isEmail, secret };
}
