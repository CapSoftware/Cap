/**
 * Pure deeplink parsing helpers for Cap's `cap://` URL scheme.
 *
 * No framework-specific imports — these can be used from both the main
 * process and the renderer.
 */

export type DeeplinkAction =
  | { type: "record/start" }
  | { type: "record/stop" }
  | { type: "record/pause" }
  | { type: "record/resume" }
  | { type: "record/toggle" }
  | { type: "record/restart" }
  | { type: "unknown"; url: string };

/**
 * Parse a `cap://` deeplink URL into a structured action object.
 *
 * @example
 * parseDeeplink("cap://record/start") // { type: "record/start" }
 */
export function parseDeeplink(url: string): DeeplinkAction {
  try {
    // Normalise: cap://record/start  →  pathname = "record/start"
    const parsed = new URL(url);
    // URL host + pathname for cap://record/start is host="record", pathname="/start"
    const action = `${parsed.hostname}${parsed.pathname}`.replace(/^\/|\/$/g, "");

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
        return { type: "unknown", url };
    }
  } catch {
    return { type: "unknown", url };
  }
}
