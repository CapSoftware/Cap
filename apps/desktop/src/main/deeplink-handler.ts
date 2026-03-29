/**
 * Main-process deeplink handler for the Cap Tauri desktop app.
 *
 * Registers the `cap://` URL scheme handler via `@tauri-apps/plugin-deep-link`
 * and dispatches recognised actions through the existing `commands` API.
 */

import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { parseDeeplink } from "../utils/deeplinks";
import * as commands from "../utils/commands";

/**
 * Call once during app initialisation (e.g. in your Tauri setup block or
 * the top-level `App` component mount) to begin handling incoming deeplinks.
 */
export function initDeeplinkHandler(): () => void {
  const unlisten = onOpenUrl((urls: string[]) => {
    for (const url of urls) {
      handleDeeplinkUrl(url);
    }
  });

  // Return unlisten so callers can clean up when the app closes.
  return () => {
    unlisten.then((fn) => fn());
  };
}

/**
 * Dispatch a single `cap://` URL to the appropriate Cap command.
 */
export async function handleDeeplinkUrl(url: string): Promise<void> {
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
      console.warn("[Cap deeplink] Unrecognised deeplink URL:", action.url);
      break;
  }
}
