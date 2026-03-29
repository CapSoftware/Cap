/**
 * SolidJS hook that listens for incoming `cap://` deep-links at the renderer
 * level and dispatches the appropriate `commands.*` calls.
 *
 * Uses `@tauri-apps/plugin-deep-link`'s `onOpenUrl` so it works within the
 * Tauri webview — no Electron IPC or React dependencies.
 */

import { onMount, onCleanup } from "solid-js";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { parseDeeplink } from "../utils/deeplinks";
import * as commands from "../utils/commands";

export function useDeeplinks(): void {
  onMount(async () => {
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
            console.warn("[useDeeplinks] Unknown deeplink:", action.raw);
            break;
        }
      }
    });

    onCleanup(() => {
      unlisten();
    });
  });
}
