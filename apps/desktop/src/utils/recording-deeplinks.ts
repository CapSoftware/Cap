import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { commands } from "./tauri";
import type { ScreenCaptureTarget, RecordingMode } from "./tauri";

type DeepLinkCommand =
  | { action: "record"; subaction: "start"; params: StartParams }
  | { action: "record"; subaction: "stop"; params: Record<string, string> }
  | { action: "record"; subaction: "pause"; params: Record<string, string> }
  | { action: "record"; subaction: "resume"; params: Record<string, string> }
  | { action: "record"; subaction: "toggle"; params: Record<string, string> }
  | { action: "devices"; subaction: "mic"; params: { name: string } }
  | { action: "devices"; subaction: "camera"; params: { id: string } };

interface StartParams {
  target?: string;
  displayId?: string;
  windowId?: string;
  bounds?: string;
  mode?: RecordingMode;
}

let stopListening: (() => void) | undefined;

/**
 * Initialize deep link listener for recording controls
 * Routes:
 * - cap-desktop://record/start?target=display&displayId=1
 * - cap-desktop://record/start?target=window&windowId=abc
 * - cap-desktop://record/start?target=area&displayId=1&bounds={"x":0,"y":0,"width":1920,"height":1080}
 * - cap-desktop://record/stop
 * - cap-desktop://record/pause
 * - cap-desktop://record/resume
 * - cap-desktop://record/toggle
 * - cap-desktop://devices/mic?name=Built-in Microphone
 * - cap-desktop://devices/camera?id=faceTimeHD
 */
export async function initRecordingControlDeepLinks() {
  if (stopListening) {
    console.log("[DeepLink] Recording controls already initialized");
    return;
  }

  console.log("[DeepLink] Initializing recording control deep links...");

  stopListening = await onOpenUrl(async (urls) => {
    for (const urlString of urls) {
      try {
        console.log(`[DeepLink] Received: ${urlString}`);
        const url = new URL(urlString);
        const command = parseDeepLinkUrl(url);
        
        if (command) {
          await executeDeepLinkCommand(command);
        } else {
          console.warn(`[DeepLink] Unknown command: ${url.pathname}`);
        }
      } catch (error) {
        console.error(`[DeepLink] Error processing ${urlString}:`, error);
      }
    }
  });

  console.log("[DeepLink] Recording control deep links initialized");
}

export async function disposeRecordingControlDeepLinks() {
  if (stopListening) {
    stopListening();
    stopListening = undefined;
    console.log("[DeepLink] Recording control deep links disposed");
  }
}

function parseDeepLinkUrl(url: URL): DeepLinkCommand | null {
  const pathParts = url.pathname.split("/").filter(Boolean);
  const params = Object.fromEntries(url.searchParams);

  if (pathParts[0] !== "record" && pathParts[0] !== "devices") {
    return null;
  }

  const [action, subaction] = pathParts;

  switch (action) {
    case "record":
      if (subaction === "start") {
        return {
          action: "record",
          subaction: "start",
          params: {
            target: params.target,
            displayId: params.displayId,
            windowId: params.windowId,
            bounds: params.bounds,
            mode: (params.mode as RecordingMode) || "studio",
          },
        };
      }
      if (["stop", "pause", "resume", "toggle"].includes(subaction)) {
        return {
          action: "record",
          subaction: subaction as "stop" | "pause" | "resume" | "toggle",
          params,
        };
      }
      break;

    case "devices":
      if (subaction === "mic" && params.name) {
        return {
          action: "devices",
          subaction: "mic",
          params: { name: params.name },
        };
      }
      if (subaction === "camera" && params.id) {
        return {
          action: "devices",
          subaction: "camera",
          params: { id: params.id },
        };
      }
      break;
  }

  return null;
}

async function executeDeepLinkCommand(command: DeepLinkCommand) {
  console.log(`[DeepLink] Executing: ${command.action}/${command.subaction}`);

  switch (command.action) {
    case "record":
      await executeRecordingCommand(command);
      break;
    case "devices":
      await executeDeviceCommand(command);
      break;
  }
}

async function executeRecordingCommand(command: Extract<DeepLinkCommand, { action: "record" }>) {
  switch (command.subaction) {
    case "start": {
      const { target, displayId, windowId, bounds, mode } = command.params;
      
      let captureTarget: ScreenCaptureTarget | null = null;

      if (target === "display" && displayId) {
        captureTarget = { variant: "display", id: displayId };
      } else if (target === "window" && windowId) {
        captureTarget = { variant: "window", id: windowId };
      } else if (target === "area" && displayId && bounds) {
        try {
          const boundsObj = JSON.parse(bounds);
          captureTarget = {
            variant: "area",
            screen: displayId,
            bounds: boundsObj,
          };
        } catch (e) {
          console.error("[DeepLink] Invalid bounds JSON:", e);
          return;
        }
      } else if (target === "cameraOnly") {
        captureTarget = { variant: "cameraOnly" };
      }

      if (captureTarget) {
        const result = await commands.startRecording({
          capture_target: captureTarget,
          capture_system_audio: true,
          mode: mode || "studio",
        });
        console.log("[DeepLink] Start recording result:", result);
      } else {
        console.warn("[DeepLink] No valid target specified for start recording");
      }
      break;
    }

    case "stop":
      await commands.stopRecording();
      console.log("[DeepLink] Recording stopped");
      break;

    case "pause":
      await commands.pauseRecording();
      console.log("[DeepLink] Recording paused");
      break;

    case "resume":
      await commands.resumeRecording();
      console.log("[DeepLink] Recording resumed");
      break;

    case "toggle":
      await commands.togglePauseRecording();
      console.log("[DeepLink] Recording pause/resume toggled");
      break;
  }
}

async function executeDeviceCommand(command: Extract<DeepLinkCommand, { action: "devices" }>) {
  switch (command.subaction) {
    case "mic":
      await commands.setMicInput(command.params.name);
      console.log(`[DeepLink] Microphone set to: ${command.params.name}`);
      break;

    case "camera":
      await commands.setCameraInput({ DeviceID: command.params.id }, false);
      console.log(`[DeepLink] Camera set to: ${command.params.id}`);
      break;
  }
}
