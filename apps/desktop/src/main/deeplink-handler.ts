/**
 * Main-process deeplink handler for the Cap desktop (Tauri).
 *
 * Registers the `cap://` URL scheme via `@tauri-apps/plugin-deep-link` and
 * forwards parsed actions to the appropriate `commands.*` handlers.
 *
 * Usage — call `initDeeplinkHandler()` once during app initialisation (e.g.
 * inside your Tauri `setup` hook or the equivalent app-ready callback).
 */

import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { parseDeeplink } from "../utils/deeplinks";
import * as commands from "../utils/commands";

/**
 * Registers the deep-link listener.  Returns a cleanup function that
 * unregisters the listener when called.
 */
export async function initDeeplinkHandler(): Promise<() => void> {
  const unlisten = await onOpenUrl(async (urls: string[]) => {
    for (const url of urls) {
      const action = parseDeeplink(url);

      switch (action.type) {
        case "record/start":
          await commands.startRecording();
          break;
        case "record/stop":
          await commands.stopRecording();
          break;
        case "record/pause":
          await commands.pauseRecording();
          break;
        case "record/resume":
          await commands.resumeRecording();
          break;
        case "record/toggle":
          await commands.toggleRecording();
          break;
        case "record/restart":
          await commands.restartRecording();
          break;
        case "unknown":
          console.warn("[deeplink] Unknown deeplink received:", action.raw);
          break;
      }
    }
  });

  return unlisten;
}
