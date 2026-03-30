/**
 * Cap deep-link handler (frontend)
 *
 * Listens for `deeplink-action` events emitted from the Rust backend and
 * calls the corresponding Tauri commands / store mutations.
 *
 * Supported deep-link URLs:
 *   cap://record/start
 *   cap://record/stop
 *   cap://record/pause
 *   cap://record/resume
 *   cap://record/restart
 *   cap://screenshot
 *   cap://mic/set?name=<device_name>
 *   cap://mic/list
 *   cap://camera/set?name=<device_name>
 *   cap://camera/list
 *   cap://window/main
 */

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";

export type DeeplinkAction =
  | { action: "record/start" }
  | { action: "record/stop" }
  | { action: "record/pause" }
  | { action: "record/resume" }
  | { action: "record/restart" }
  | { action: "screenshot" }
  | { action: "mic/set"; name: string }
  | { action: "mic/list" }
  | { action: "camera/set"; name: string }
  | { action: "camera/list" }
  | { action: "window/main" };

/**
 * Initialise deep-link handling. Call this once at app startup.
 */
export async function initDeeplinks() {
  // Handle deep-link URLs that arrive while the app is already running.
  await onOpenUrl((urls) => {
    for (const url of urls) {
      invoke("handle_deep_link", { url }).catch((err) =>
        console.error("[deeplink] handle_deep_link error:", err)
      );
    }
  });

  // Listen for the translated action events that the Rust backend re-emits.
  await listen<DeeplinkAction>("deeplink-action", async ({ payload }) => {
    console.info("[deeplink] action received:", payload);

    try {
      switch (payload.action) {
        case "record/start":
          await invoke("start_recording");
          break;

        case "record/stop":
          await invoke("stop_recording");
          break;

        case "record/pause":
          await invoke("pause_recording");
          break;

        case "record/resume":
          await invoke("resume_recording");
          break;

        case "record/restart":
          await invoke("restart_recording");
          break;

        case "screenshot":
          await invoke("take_screenshot");
          break;

        case "mic/set":
          await invoke("set_mic_input", { name: payload.name });
          break;

        case "mic/list":
          // Return list of mics via a separate command; the response is
          // consumed by the Raycast extension via HTTP or a follow-up event.
          await invoke("list_mic_inputs");
          break;

        case "camera/set":
          await invoke("set_camera_input", { name: payload.name });
          break;

        case "camera/list":
          await invoke("list_camera_inputs");
          break;

        default:
          console.warn("[deeplink] Unknown action:", payload);
      }
    } catch (err) {
      console.error("[deeplink] Failed to execute action:", payload.action, err);
    }
  });
}
