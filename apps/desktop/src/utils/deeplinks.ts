/**
 * Cap Deeplinks Handler
 *
 * Supported deeplinks (cap://):
 *   cap://record/start                          – start a new recording
 *   cap://record/stop                           – stop the current recording
 *   cap://record/pause                          – pause the current recording
 *   cap://record/resume                         – resume a paused recording
 *   cap://record/restart                        – restart (discard) the current recording
 *   cap://record/toggle                         – toggle start/stop
 *   cap://record/toggle-pause                   – toggle pause/resume
 *   cap://settings/camera?deviceId=<id>         – switch camera input
 *   cap://settings/microphone?deviceId=<id>     – switch microphone input
 *   cap://settings/open                         – open settings window
 *   cap://window/open                           – open/focus the main window
 *
 * All actions respond with a JSON body when invoked from an HTTP-style
 * scheme callback, but they primarily operate by emitting IPC events to the
 * renderer process.
 */

import { BrowserWindow, ipcMain } from "electron";

export type DeeplinkAction =
  | "record/start"
  | "record/stop"
  | "record/pause"
  | "record/resume"
  | "record/restart"
  | "record/toggle"
  | "record/toggle-pause"
  | "settings/camera"
  | "settings/microphone"
  | "settings/open"
  | "window/open";

/**
 * Parse a cap:// URL into an action string and a params map.
 *
 * Examples:
 *   cap://record/start            → { action: "record/start", params: {} }
 *   cap://settings/camera?deviceId=abc → { action: "settings/camera", params: { deviceId: "abc" } }
 */
export function parseDeeplink(url: string): {
  action: string;
  params: Record<string, string>;
} | null {
  try {
    // Electron delivers the raw URL string; normalise it so URL() can parse it.
    const parsed = new URL(url);
    if (parsed.protocol !== "cap:") return null;

    // hostname + pathname gives us e.g.  "record" + "/start"
    const action = (parsed.hostname + parsed.pathname)
      .replace(/\/+$/, "") // strip trailing slashes
      .replace(/^\/+/, ""); // strip leading slashes

    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    return { action, params };
  } catch {
    return null;
  }
}

/**
 * Send a deeplink action to the focused (or first available) BrowserWindow.
 */
export function dispatchDeeplinkToRenderer(
  action: string,
  params: Record<string, string>
): boolean {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

  if (!win || win.isDestroyed()) return false;

  win.webContents.send("deeplink-action", { action, params });
  return true;
}

/**
 * Register all IPC handlers related to deeplinks so the renderer can
 * query current state or acknowledge actions.
 */
export function registerDeeplinkIpcHandlers(): void {
  ipcMain.handle("deeplink:get-status", () => {
    // The renderer maintains the authoritative recording state; this is a
    // passthrough so Raycast / CLI callers can poll via a future HTTP bridge.
    return { ok: true };
  });
}
