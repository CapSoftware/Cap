/**
 * Pure deeplink parsing utilities for Cap's `cap://` URL scheme.
 * No Electron or Tauri imports — this module is side-effect free so it can
 * be used from both the main process and the renderer.
 */

export type RecordingMode = "screen" | "window" | "camera";

export type DeeplinkAction =
  | { type: "record/start" }
  | { type: "record/stop" }
  | { type: "record/pause" }
  | { type: "record/resume" }
  | { type: "record/toggle" }
  | { type: "record/restart" }
  | { type: "record/switch-mode"; mode: RecordingMode }
  | { type: "unknown"; raw: string };

/**
 * Parse a `cap://` URL into a typed action object.
 *
 * @example
 * parseDeeplink("cap://record/start")              // { type: "record/start" }
 * parseDeeplink("cap://record/switch-mode?mode=window") // { type: "record/switch-mode", mode: "window" }
 */
export function parseDeeplink(url: string): DeeplinkAction {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "cap:") return { type: "unknown", raw: url };

    // Combine host + pathname to produce an action key, e.g. "record/start"
    const host = parsed.hostname; // "record"
    const path = parsed.pathname.replace(/^\//, ""); // "start" | "switch-mode" | …
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
      case "record/switch-mode": {
        const mode = parsed.searchParams.get("mode");
        if (mode === "screen" || mode === "window" || mode === "camera") {
          return { type: "record/switch-mode", mode };
        }
        return { type: "unknown", raw: url };
      }
      default:
        return { type: "unknown", raw: url };
    }
  } catch {
    return { type: "unknown", raw: url };
  }
}
