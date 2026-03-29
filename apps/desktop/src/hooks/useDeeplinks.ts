/**
 * SolidJS hook that listens for incoming `cap://` deeplinks via the Tauri
 * deep-link plugin and dispatches the corresponding Cap commands.
 *
 * Usage:
 *   // In your root App component or a top-level layout:
 *   useDeeplinks();
 */

import { onMount, onCleanup } from "solid-js";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { parseDeeplink } from "../utils/deeplinks";
import * as commands from "../utils/commands";

export function useDeeplinks(): void {
  let unlistenFn: (() => void) | undefined;

  onMount(async () => {
    const unlisten = await onOpenUrl((urls: string[]) => {
      for (const url of urls) {
        dispatchDeeplink(url);
      }
    });

    unlistenFn = unlisten;
  });

  onCleanup(() => {
    unlistenFn?.();
  });
}

async function dispatchDeeplink(url: string): Promise<void> {
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
