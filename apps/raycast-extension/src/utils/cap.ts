import { exec } from "child_process";
import { promisify } from "util";
import { open } from "@raycast/api";

const execAsync = promisify(exec);

const CAP_SCHEME = "cap://action";

export interface CaptureMode {
  screen?: string;
  window?: string;
}

export interface StartRecordingOptions {
  captureMode: CaptureMode;
  camera?: string;
  micLabel?: string;
  captureSystemAudio?: boolean;
  mode?: "studio" | "instant";
}

export interface Display {
  id: number;
  name: string;
}

export interface Window {
  id: number;
  name: string;
  owner: string;
}

export interface Camera {
  deviceId: string;
  displayName: string;
  modelId?: string;
}

export interface Microphone {
  label: string;
}

type DeeplinkAction = string | object;

function buildDeeplinkUrl(action: DeeplinkAction): string {
  const encodedValue = encodeURIComponent(JSON.stringify(action));
  return `${CAP_SCHEME}?value=${encodedValue}`;
}

export async function openDeeplink(action: DeeplinkAction): Promise<void> {
  const url = buildDeeplinkUrl(action);
  await open(url);
}

export async function startRecording(options: StartRecordingOptions): Promise<void> {
  if (!options.captureMode.screen && !options.captureMode.window) {
    throw new Error("captureMode must include screen or window");
  }

  const captureMode = options.captureMode.screen
    ? { screen: options.captureMode.screen }
    : { window: options.captureMode.window };

  await openDeeplink({
    start_recording: {
      capture_mode: captureMode,
      camera: options.camera ? { device_id: options.camera } : null,
      mic_label: options.micLabel ?? null,
      capture_system_audio: options.captureSystemAudio ?? false,
      mode: options.mode ?? "instant",
    },
  });
}

export async function stopRecording(): Promise<void> {
  await openDeeplink("stop_recording");
}

export async function pauseRecording(): Promise<void> {
  await openDeeplink("pause_recording");
}

export async function resumeRecording(): Promise<void> {
  await openDeeplink("resume_recording");
}

export async function togglePauseRecording(): Promise<void> {
  await openDeeplink("toggle_pause_recording");
}

export async function switchCamera(deviceId: string | null): Promise<void> {
  await openDeeplink({
    switch_camera: {
      device_id: deviceId,
    },
  });
}

export async function switchMicrophone(deviceLabel: string | null): Promise<void> {
  await openDeeplink({
    switch_microphone: {
      device_label: deviceLabel,
    },
  });
}

export async function listDisplays(): Promise<Display[]> {
  try {
    const { stdout } = await execAsync(
      `system_profiler SPDisplaysDataType -json 2>/dev/null | grep -o '"_name" : "[^"]*"' | cut -d'"' -f4`
    );
    const names = stdout.trim().split("\n").filter(Boolean);
    return names.map((name, index) => ({
      id: index + 1,
      name: name || `Display ${index + 1}`,
    }));
  } catch {
    return [{ id: 1, name: "Main Display" }];
  }
}

export async function listWindows(): Promise<Window[]> {
  try {
    const script = `
      tell application "System Events"
        set windowList to {}
        repeat with proc in (every process whose visible is true)
          try
            repeat with win in (every window of proc)
              set windowName to name of win
              set appName to name of proc
              set end of windowList to appName & ": " & windowName
            end repeat
          end try
        end repeat
        set AppleScript's text item delimiters to linefeed
        return windowList as text
      end tell
    `;
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    const windows = stdout.trim().split("\n").filter(Boolean);
    return windows.map((win, index) => {
      const parts = win.split(": ");
      return {
        id: index + 1,
        owner: parts[0] || "Unknown",
        name: parts.slice(1).join(": ") || "Untitled",
      };
    });
  } catch {
    return [];
  }
}

export async function listCameras(): Promise<Camera[]> {
  try {
    const { stdout } = await execAsync(`system_profiler SPCameraDataType 2>/dev/null | grep -E "^\\s+[A-Za-z]" | sed 's/^[[:space:]]*//' | head -10`);
    const cameras = stdout.trim().split("\n").filter(Boolean);
    return cameras.map((name) => {
      const displayName = name.replace(/:$/, "").trim();
      return {
        deviceId: displayName,
        displayName,
      };
    });
  } catch {
    return [{ deviceId: "FaceTime HD Camera", displayName: "FaceTime HD Camera" }];
  }
}

export async function listMicrophones(): Promise<Microphone[]> {
  try {
    const { stdout } = await execAsync(`system_profiler SPAudioDataType 2>/dev/null | grep -A 50 'Input Sources:' | grep -E "Default Input Device: Yes" -B 10 | grep -E "^\\s+[A-Za-z].*:" | head -5 | sed 's/^[[:space:]]*//' | cut -d: -f1`);
    const mics = stdout.trim().split("\n").filter(Boolean);
    if (mics.length === 0) {
      const { stdout: altOutput } = await execAsync(`system_profiler SPAudioDataType 2>/dev/null | grep -E "^\\s{8}[A-Za-z].*:" | head -10 | sed 's/^[[:space:]]*//' | cut -d: -f1`);
      const altMics = altOutput.trim().split("\n").filter(Boolean);
      return altMics.map((label) => ({ label: label.trim() }));
    }
    return mics.map((label) => ({ label: label.trim() }));
  } catch {
    return [{ label: "Default Microphone" }];
  }
}

export async function isCapRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("pgrep -x 'Cap' || pgrep -f 'Cap.app'");
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function openCap(): Promise<void> {
  await open("cap://");
}
