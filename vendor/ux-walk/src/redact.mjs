// Bodies of failed requests, for an agent to tell a real conflict from a stale call. Emails and
// secret-looking keys are redacted (a response's "code" is the error code, so it is kept there).
// Shared with the Worm feedback widget, so it runs in Node and in a browser.
export const EMAIL = /[^\s@"'<>,;:()=&]+@[^\s@"'<>,;:()]+\.[a-z]{2,}/gi;
export const RES_KEYS = /pass|token|secret|otp|key/i;
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
