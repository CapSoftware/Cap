/**
 * Pure deeplink parsing utilities for Cap's `cap://` URL scheme.
 * No Electron or Tauri imports — this module is side-effect free so it can
 * be used from both the main process and the renderer.
 */

export type DeeplinkAction =
  | { type: "record/start" }
  | { type: "record/stop" }
  | { type: "record/pause" }
  | { type: "record/resume" }
  | { type: "record/toggle" }
  | { type: "record/restart" }
  | { type: "unknown"; raw: string };

/**
 * Parse a `cap://` URL into a typed action object.
 *
 * @example
 * parseDeeplink("cap://record/start") // { type: "record/start" }
 */
export function parseDeeplink(url: string): DeeplinkAction {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "cap:") return { type: "unknown", raw: url };

    // Combine host + pathname to produce an action key, e.g. "record/start"
    const host = parsed.hostname; // "record"
    const path = parsed.pathname.replace(/^\//, ""); // "start"
    const action = path ? `${host}/${path}` : host;

    switch (action) {
      case "record/start":
        return { type: "record/start" };
      case "record/stop":
        return { type: "record/stop" };
      case "record/pause":
        return { type: "record/pause" };
      case "record/resume":
        return { type: "record/resume" };
      case "record/toggle":
        return { type: "record/toggle" };
      case "record/restart":
        return { type: "record/restart" };
      default:
        return { type: "unknown", raw: url };
    }
  } catch {
    return { type: "unknown", raw: url };
  }
}
