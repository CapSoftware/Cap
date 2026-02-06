import { listen } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { commands } from "./tauri";
import type { RecordingMode, StartRecordingInputs } from "./tauri";

/**
 * Deep link command handlers for Cap
 * Supports: cap://record, cap://stop, cap://pause, cap://resume, 
 *           cap://toggle-pause, cap://switch-mic, cap://switch-camera
 */

export interface DeepLinkCommand {
  action: "record" | "stop" | "pause" | "resume" | "toggle-pause" | "switch-mic" | "switch-camera";
  params?: Record<string, string>;
}

/**
 * Parse deep link URL and extract command
 */
export function parseDeepLinkCommand(url: string): DeepLinkCommand | null {
  try {
    const urlObj = new URL(url);
    
    // Only handle cap:// protocol
    if (urlObj.protocol !== "cap:") {
      return null;
    }

    const action = urlObj.hostname as DeepLinkCommand["action"];
    const params: Record<string, string> = {};
    
    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    // Validate action
    const validActions: DeepLinkCommand["action"][] = [
      "record", "stop", "pause", "resume", "toggle-pause", "switch-mic", "switch-camera"
    ];
    
    if (!validActions.includes(action)) {
      console.warn(`Unknown deep link action: ${action}`);
      return null;
    }

    return { action, params };
  } catch (error) {
    console.error("Failed to parse deep link:", error);
    return null;
  }
}

/**
 * Execute deep link command
 */
export async function executeDeepLinkCommand(command: DeepLinkCommand): Promise<void> {
  const { action, params = {} } = command;

  console.log(`Executing deep link command: ${action}`, params);

  switch (action) {
    case "record":
      await handleRecordCommand(params);
      break;
    case "stop":
      await handleStopCommand();
      break;
    case "pause":
      await handlePauseCommand();
      break;
    case "resume":
      await handleResumeCommand();
      break;
    case "toggle-pause":
      await handleTogglePauseCommand();
      break;
    case "switch-mic":
      await handleSwitchMicCommand(params);
      break;
    case "switch-camera":
      await handleSwitchCameraCommand(params);
      break;
    default:
      console.warn(`Unhandled deep link action: ${action}`);
  }
}

/**
 * Handle record command
 * Params: mode ("instant" | "studio"), camera?, microphone?
 */
async function handleRecordCommand(params: Record<string, string>): Promise<void> {
  const mode = (params.mode as RecordingMode) || "instant";
  
  // Set recording mode
  await commands.setRecordingMode(mode);

  const inputs: StartRecordingInputs = {
    mode,
    capture_target: params.target || "screen",
  };

  // Add camera if specified
  if (params.camera) {
    inputs.camera_label = params.camera;
  }

  // Add microphone if specified
  if (params.microphone) {
    inputs.audio_inputs = [{ label: params.microphone, device_type: "mic" }];
  }

  const result = await commands.startRecording(inputs);
  
  if (result !== "Started") {
    console.error(`Failed to start recording: ${result}`);
  }
}

/**
 * Handle stop command
 */
async function handleStopCommand(): Promise<void> {
  await commands.stopRecording();
}

/**
 * Handle pause command
 */
async function handlePauseCommand(): Promise<void> {
  await commands.pauseRecording();
}

/**
 * Handle resume command
 */
async function handleResumeCommand(): Promise<void> {
  await commands.resumeRecording();
}

/**
 * Handle toggle pause command
 */
async function handleTogglePauseCommand(): Promise<void> {
  await commands.togglePauseRecording();
}

/**
 * Handle switch microphone command
 * Params: label (microphone name/device ID)
 */
async function handleSwitchMicCommand(params: Record<string, string>): Promise<void> {
  const label = params.label || params.device;
  
  if (!label) {
    console.error("No microphone label provided");
    return;
  }

  await commands.setMicInput(label);
}

/**
 * Handle switch camera command
 * Params: id (camera device ID)
 */
async function handleSwitchCameraCommand(params: Record<string, string>): Promise<void> {
  const id = params.id || params.device;
  
  if (!id) {
    console.error("No camera ID provided");
    return;
  }

  await commands.setCameraInput(id, true);
}

/**
 * Initialize deep link command listener
 * Returns unsubscribe function
 */
export async function initDeepLinkCommands(): Promise<() => void> {
  console.log("Initializing deep link commands...");

  const unsubscribe = await onOpenUrl(async (urls) => {
    for (const url of urls) {
      const command = parseDeepLinkCommand(url);
      
      if (command) {
        try {
          await executeDeepLinkCommand(command);
        } catch (error) {
          console.error(`Failed to execute command from ${url}:`, error);
        }
      }
    }
  });

  return unsubscribe;
}

/**
 * Generate deep link URL for a command
 */
export function generateDeepLink(
  action: DeepLinkCommand["action"],
  params?: Record<string, string>
): string {
  const url = new URL(`cap://${action}`);
  
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  return url.toString();
}

// Export convenience functions for generating deep links
export const deepLinks = {
  record: (params?: { mode?: RecordingMode; camera?: string; microphone?: string }) =>
    generateDeepLink("record", params as Record<string, string>),
  stop: () => generateDeepLink("stop"),
  pause: () => generateDeepLink("pause"),
  resume: () => generateDeepLink("resume"),
  togglePause: () => generateDeepLink("toggle-pause"),
  switchMic: (label: string) => generateDeepLink("switch-mic", { label }),
  switchCamera: (id: string) => generateDeepLink("switch-camera", { id }),
};
