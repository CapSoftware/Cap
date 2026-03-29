/**
 * Cap – Main-process deeplink handler
 *
 * Wire this up inside your existing `app.on("open-url", ...)` /
 * `app.on("second-instance", ...)` handlers, or call
 * `registerDeeplinkHandler()` once during app startup.
 *
 * The handler parses cap:// URLs and dispatches them to the renderer via IPC.
 * The renderer is responsible for the actual recording-state machine.
 */

import { app, BrowserWindow } from "electron";
import {
  dispatchDeeplinkToRenderer,
  parseDeeplink,
  registerDeeplinkIpcHandlers,
} from "../utils/deeplinks";

let _registered = false;

export function registerDeeplinkHandler(): void {
  if (_registered) return;
  _registered = true;

  // Ensure cap:// is registered as the default protocol client on this machine.
  if (!app.isDefaultProtocolClient("cap")) {
    app.setAsDefaultProtocolClient("cap");
  }

  // macOS / Linux: the OS fires open-url
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeeplinkUrl(url);
  });

  // Windows / Linux (second instance): argv contains the URL
  app.on("second-instance", (_event, argv) => {
    // On Windows the deeplink URL is the last argument
    const url = argv.find((arg) => arg.startsWith("cap://"));
    if (url) handleDeeplinkUrl(url);

    // Also bring the main window to the front
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Register supplementary IPC handlers
  registerDeeplinkIpcHandlers();
}

/**
 * Parse and dispatch a single deeplink URL.
 * Returns true if the action was successfully dispatched to a renderer window.
 */
export function handleDeeplinkUrl(url: string): boolean {
  const parsed = parseDeeplink(url);

  if (!parsed) {
    console.warn("[deeplink] Could not parse URL:", url);
    return false;
  }

  const { action, params } = parsed;
  console.log("[deeplink] Dispatching action:", action, params);

  // For window/open we just ensure a window exists and is visible.
  if (action === "window/open" || action === "settings/open") {
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (action === "settings/open") {
      dispatchDeeplinkToRenderer(action, params);
    }
    return true;
  }

  return dispatchDeeplinkToRenderer(action, params);
}
