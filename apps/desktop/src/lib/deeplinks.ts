import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { invoke } from "@tauri-apps/api/core";

export type DeeplinkAction =
  | "start-recording"
  | "stop-recording"
  | "pause-recording"
  | "resume-recording"
  | "restart-recording"
  | "switch-microphone"
  | "switch-camera";

export function initDeeplinks() {
  onOpenUrl((urls) => {
    for (const url of urls) {
      handleDeeplink(url);
    }
  });
}

export async function handleDeeplink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "cap:") return;

    const action = parsed.hostname as DeeplinkAction;
    const params = Object.fromEntries(parsed.searchParams.entries());

    switch (action) {
      case "start-recording":
        await invoke("start_recording", params);
        break;
      case "stop-recording":
        await invoke("stop_recording", {});
        break;
      case "pause-recording":
        await invoke("pause_recording", {});
        break;
      case "resume-recording":
        await invoke("resume_recording", {});
        break;
      case "restart-recording":
        await invoke("restart_recording", {});
        break;
      case "switch-microphone": {
        const deviceId = params["device-id"] ?? null;
        await invoke("set_microphone", { deviceId });
        break;
      }
      case "switch-camera": {
        const deviceId = params["device-id"] ?? null;
        await invoke("set_camera", { deviceId });
        break;
      }
      default:
        console.warn("Unknown deeplink action:", action);
    }
  } catch (e) {
    console.error("Failed to handle deeplink:", url, e);
  }
}
